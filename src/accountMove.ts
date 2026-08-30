// src/accountMove.ts — moving a conversation's BYTES from one account's config
// directory to another.
//
// THE FACT THIS FILE EXISTS TO EXPLOIT: a transcript carries no account
// identity. Every top-level key in one — `sessionId`, `cwd`, `gitBranch`,
// `version`, `userType`, the messages — describes the conversation, never the
// login that paid for it. So a `.jsonl` is portable between config directories,
// and "which subscription is this conversation on" turns out to be a question
// about WHERE THE FILE IS rather than about anything inside it.
//
// That is the whole trick behind switching accounts mid-conversation. The pin
// (EditorialRecord.profileId) says which account a session belongs to; this
// module makes the disk agree. Do one without the other and the result is a pin
// naming a directory that does not hold the conversation — a resume that finds
// nothing, which is worse than not offering the verb at all.
//
// Imports node builtins and ./log only. Never vscode: the tests drive this on
// real temp directories, and every rule in here is about filesystems.
//
// THE INVARIANT, and it is the reason this is a MOVE and never a copy: exactly
// one `<sessionId>.jsonl` may exist on this machine at any moment. So the
// transcript is renamed (atomic, never two copies), and on the one filesystem
// where rename cannot work — a config dir the user pointed at another volume —
// the copy is unwound rather than left behind.
//
// The invariant is a rule this module ENFORCES, not a fact it may assume, and
// the difference cost real conversations. Three ids on the author's machine
// exist in two accounts at once; the mechanisms are ordinary (a tmux pane that
// kept a stale `CLAUDE_CONFIG_DIR` and wrote the next turn into the account the
// conversation had just left, a half-finished move from an older build, a
// hand-copied config dir), and the guard below was checking only the exact path
// it was about to write rather than the whole destination account, so a copy
// under another project slug was no obstacle at all. `transcript.transcriptFile`
// now breaks a duplicate on newest-mtime instead of on root order, which decides
// which copy is READ; `setAsideTranscript` below is how a machine already in
// that state gets back to one copy, and it renames rather than deletes because
// when an id exists twice nothing in this file can tell whose conversation is
// whose.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { log, logError } from './log';

/**
 * Per-session state that is NOT the conversation, keyed by session id inside the
 * config dir. Each is a directory named after the session:
 *
 *   tasks         the session's own task list — the one the agent is working
 *                 through, and the one a user watches.
 *   file-history  the undo history for files this session edited.
 *   session-env   per-session environment a SessionStart hook wrote.
 *
 * They travel with the conversation because a switch that keeps the history and
 * blanks the task list is a switch the user can see. None of them is
 * load-bearing, though, which is why a sidecar that fails to move is logged and
 * survived rather than aborting a move whose transcript already landed — see
 * `moveConversation`.
 */
export const SESSION_SIDECAR_DIRS: readonly string[] = [
  'tasks',
  'file-history',
  'session-env',
];

export interface MoveConversationOptions {
  /** The conversation's TIP id — the generation that will be resumed. Older
   *  generations stay where they are; the archive indexer reads every account
   *  root, so they keep drawing, and moving history nobody will resume is bytes
   *  risked for nothing. */
  sessionId: string;
  /** Config dir the conversation is in now (`accounts.configDirForProfile`). */
  fromDir: string;
  /** Config dir it is moving to. */
  toDir: string;
}

export interface MoveConversationResult {
  ok: boolean;
  /** Where the transcript now is. Set only when it actually moved. */
  transcriptPath?: string;
  /** Sidecar directory names that moved (subset of SESSION_SIDECAR_DIRS). */
  sidecars: string[];
  /** Sidecars that did not move, and were survived. */
  skipped: string[];
  /** Why the move did not happen, in one sentence a user can act on. Present
   *  only when `ok` is false, and never naming anything but a path. */
  error?: string;
}

/** The projects root inside a config dir — where `<slug>/<id>.jsonl` lives. */
export function projectsRootOf(configDir: string): string {
  return path.join(configDir, 'projects');
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The transcript for `sessionId` under ONE config dir, or null.
 *
 * Deliberately not `transcript.transcriptFile`: that one searches every root and
 * answers "where is this conversation", which is the question the rest of the
 * extension asks. This one answers "is it in THIS account", which is the only
 * question a move can be built on — the source has to be known before the
 * destination can be checked for a collision.
 */
export function transcriptInConfigDir(
  configDir: string,
  sessionId: string,
): string | null {
  if (typeof configDir !== 'string' || configDir.trim() === '') return null;
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  // The id is interpolated into a path. It is normally a validated uuid, but
  // this module is reachable from a command argument, so it is checked here too.
  if (
    sessionId.includes('/') ||
    sessionId.includes('\\') ||
    sessionId.includes('\0') ||
    sessionId === '.' ||
    sessionId === '..'
  ) {
    return null;
  }
  const root = projectsRootOf(configDir.trim());
  let subdirs: string[];
  try {
    subdirs = fs.readdirSync(root);
  } catch {
    return null; // an account that has never run a session has no projects root
  }
  const fileName = `${sessionId}.jsonl`;
  for (const sub of subdirs) {
    const candidate = path.join(root, sub, fileName);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/** A transcript found on disk, with the two facts a person needs in order to
 *  decide which of two copies of one conversation to keep. */
export interface TranscriptCopyFacts {
  /** Absolute path of the `.jsonl`. */
  path: string;
  bytes: number;
  mtimeMs: number;
}

/**
 * `transcriptInConfigDir` plus the stat, for the one caller that has to DESCRIBE
 * what it found rather than just avoid it.
 *
 * Kept separate rather than folded into `transcriptInConfigDir` because that
 * function is on the hot path of every move and every probe and answers a
 * yes/no question; this one exists for the refusal text and the heal offer,
 * where a size and a date are the difference between "Flock will not do this"
 * and a user being able to tell a nine-line stub from their afternoon's work.
 */
export function transcriptCopyInConfigDir(
  configDir: string,
  sessionId: string,
): TranscriptCopyFacts | null {
  const found = transcriptInConfigDir(configDir, sessionId);
  if (found === null) return null;
  try {
    const st = fs.statSync(found);
    return { path: found, bytes: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null; // it went away between the readdir and the stat
  }
}

/** The suffix a set-aside transcript carries. It deliberately does NOT end in
 *  `.jsonl`: every reader in this extension — `transcriptFile`,
 *  `transcriptInConfigDir`, the transcript index's scan — selects on that
 *  extension, so a renamed file leaves the id's namespace entirely without
 *  anything having to learn a new exclusion rule. */
export const SET_ASIDE_SUFFIX = '.superseded';

/**
 * Take one of two copies of a conversation OUT OF THE WAY, by renaming it.
 *
 * THE ALTERNATIVE WAS DELETION, and it is rejected. When an id exists twice,
 * one of those files is somebody's conversation and this code cannot tell which
 * — that is the entire reason the move refuses instead of overwriting. A verb
 * that resolves the standoff by deleting a transcript would be betting a user's
 * history on a heuristic (newest mtime) that is right most of the time. A
 * rename costs nothing, is one `mv` away from being undone by hand, and gets
 * the machine back to the one-copy state the whole module is built on, which is
 * all the move actually needs.
 *
 * The stamp is the file's own mtime rather than `Date.now()`, so re-running this
 * on a file that was already set aside is idempotent in spirit — the name
 * describes the bytes, not the moment somebody clicked. A collision (the same
 * file set aside twice in the same millisecond) falls back to a counter rather
 * than clobbering, for the same reason nothing else here clobbers.
 *
 * Never throws.
 */
export async function setAsideTranscript(
  transcriptPath: string,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const from = typeof transcriptPath === 'string' ? transcriptPath.trim() : '';
  if (from === '' || !isFile(from)) {
    return { ok: false, error: 'There is no such transcript to set aside.' };
  }
  let stamp: string;
  try {
    stamp = new Date(fs.statSync(from).mtimeMs)
      .toISOString()
      .replace(/[:.]/g, '-');
  } catch {
    stamp = 'unknown';
  }
  let to = `${from}${SET_ASIDE_SUFFIX}-${stamp}`;
  for (let n = 2; fs.existsSync(to) && n < 100; n++) {
    to = `${from}${SET_ASIDE_SUFFIX}-${stamp}-${n}`;
  }
  try {
    await fsp.rename(from, to);
  } catch (err) {
    logError('accountMove: could not set a duplicate transcript aside', err);
    return { ok: false, error: `${from} could not be renamed.` };
  }
  log('accountMove: set aside', from, '->', to);
  return { ok: true, path: to };
}

/** What `sourceDirFor` found: the config dir that actually holds the
 *  transcript, and whether that was the one the caller expected. */
export interface SourceDirResult {
  /** The config dir — NOT the projects root and not the file: the mover works
   *  in config dirs, because the sidecars live beside `projects/`. */
  dir: string;
  /** False when the pin was wrong and this was found somewhere else. The
   *  caller logs it; nothing branches on it. */
  matchedPreferred: boolean;
}

/**
 * WHICH ACCOUNT DIRECTORY holds this conversation, preferring the one the pin
 * claims.
 *
 * This is deliberately not a third spelling of "where is this conversation".
 * `transcript.transcriptFile` answers that one and answers it with a PATH,
 * which is the shape every reader wants and the one shape a move cannot use:
 * the mover has to name a config dir, because that is what the destination is
 * expressed in and what the sidecars hang off. So this walks the same roots and
 * returns the enclosing account instead.
 *
 * THE ORDER IS THE WHOLE DESIGN. `preferred` is probed first, so a conversation
 * whose pin is right behaves exactly as it did before this function existed —
 * one readdir, same directory, no new behaviour to regress. The fallback is for
 * the case that was previously a dead end: a pin is a CLAIM, written by
 * whichever window last moved the session, and the file is the FACT. They come
 * apart for real reasons — a tmux pane that kept a stale `CLAUDE_CONFIG_DIR`
 * and wrote the next turn into the account the conversation had just left, a
 * half-finished move from an older build, a state file merged from a window
 * that never saw the last switch. Refusing those with "no transcript in the
 * account it is pinned to" tells the user something true about the pin and
 * nothing about their conversation, which is sitting on disk one directory
 * over.
 *
 * The caller is expected to call this BEFORE it stops anything: the refusal
 * this replaces used to arrive after the process had been killed and restarted,
 * which spent a turn in flight to reach a sentence.
 *
 * Pure filesystem work, node builtins only, never throws.
 */
export function sourceDirFor(
  sessionId: string,
  opts: {
    /** The config dir the pin names (`accounts.configDirForProfile`). */
    preferred: string;
    /** Every config dir this machine could be holding it in, the default
     *  login's included. Order matters only for a conversation that somehow
     *  exists in two of them, which `moveConversation`'s own invariant says
     *  cannot happen. */
    roots: readonly string[];
  },
): SourceDirResult | null {
  const preferred =
    typeof opts?.preferred === 'string' ? opts.preferred.trim() : '';
  if (preferred !== '' && transcriptInConfigDir(preferred, sessionId) !== null) {
    return { dir: preferred, matchedPreferred: true };
  }
  for (const raw of opts?.roots ?? []) {
    const root = typeof raw === 'string' ? raw.trim() : '';
    if (root === '') continue;
    if (preferred !== '' && path.resolve(root) === path.resolve(preferred)) {
      continue; // already probed, and probing it twice is a readdir for nothing
    }
    if (transcriptInConfigDir(root, sessionId) !== null) {
      return { dir: root, matchedPreferred: false };
    }
  }
  return null;
}

/** Copy a directory tree. Hand-rolled rather than `fsp.cp`, whose recursive
 *  mode still prints an experimental warning on the Node the extension host
 *  ships; a sidecar move is not worth a warning in the user's log. Symlinks are
 *  recreated as symlinks — the shared-config wiring makes them, and following
 *  one would copy the machine's settings into a per-session directory. */
async function copyTree(from: string, to: string): Promise<void> {
  const stat = await fsp.lstat(from);
  if (stat.isSymbolicLink()) {
    await fsp.symlink(await fsp.readlink(from), to);
    return;
  }
  if (!stat.isDirectory()) {
    await fsp.copyFile(from, to);
    return;
  }
  await fsp.mkdir(to, { recursive: true });
  for (const entry of await fsp.readdir(from)) {
    await copyTree(path.join(from, entry), path.join(to, entry));
  }
}

function isCrossDevice(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'EXDEV'
  );
}

/**
 * Move one path, preferring `rename`.
 *
 * `rename` is the whole point: it is atomic, so there is no instant at which
 * both copies exist and no way to end up with both if the process dies. Only
 * when the two ends are on different filesystems — a config dir the user
 * pointed at another volume — does this fall back to copy-then-remove, and
 * there it unwinds the copy if the removal fails, because a half-move that left
 * the transcript in two places is the one outcome the index cannot survive.
 */
async function movePath(from: string, to: string): Promise<void> {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try {
    await fsp.rename(from, to);
    return;
  } catch (err) {
    if (!isCrossDevice(err)) throw err;
  }
  await copyTree(from, to);
  try {
    await fsp.rm(from, { recursive: true, force: true });
  } catch (err) {
    // The copy landed and the original will not go. Undo the copy: one file in
    // its original place beats the same file in two places.
    try {
      await fsp.rm(to, { recursive: true, force: true });
    } catch (undoErr) {
      logError('accountMove: could not unwind a cross-device copy', undoErr);
    }
    throw err;
  }
}

/**
 * Move a conversation from one account's config directory to another.
 *
 * ORDER IS THE ERROR HANDLING. The transcript goes first and is the only thing
 * whose failure aborts: until it lands nothing has been touched, so a refusal
 * here leaves the conversation exactly where it was and the caller can keep the
 * pin unchanged. Once it HAS landed the move has happened — the conversation is
 * on the other account — and a sidecar that then fails to follow is logged,
 * reported in `skipped`, and survived. Rolling the transcript back at that point
 * would mean risking the file the whole operation exists to preserve in order to
 * rescue a task list.
 *
 * Never throws.
 */
export async function moveConversation(
  opts: MoveConversationOptions,
): Promise<MoveConversationResult> {
  const out: MoveConversationResult = { ok: false, sidecars: [], skipped: [] };
  const sessionId = typeof opts?.sessionId === 'string' ? opts.sessionId : '';
  const fromDir = typeof opts?.fromDir === 'string' ? opts.fromDir.trim() : '';
  const toDir = typeof opts?.toDir === 'string' ? opts.toDir.trim() : '';

  if (sessionId === '' || fromDir === '' || toDir === '') {
    out.error = 'The move was given no session or no account directory.';
    return out;
  }
  if (path.resolve(fromDir) === path.resolve(toDir)) {
    // Both accounts share a config directory — the default account and a
    // provider with no config-dir variable both resolve to `~/.claude`. Nothing
    // to move, and saying so beats renaming a file onto itself.
    out.ok = true;
    return out;
  }

  const source = transcriptInConfigDir(fromDir, sessionId);
  if (source === null) {
    out.error =
      'This conversation has no transcript in the account it is pinned to, ' +
      'so there is nothing to move.';
    return out;
  }

  // The slug is the cwd's encoding and the cwd does not change, so the
  // destination is the same subdirectory under the other account's root.
  const slug = path.basename(path.dirname(source));
  const target = path.join(projectsRootOf(toDir), slug, `${sessionId}.jsonl`);

  // THE COLLISION GUARD IS PER-ACCOUNT, not per-slug, and that is a fix rather
  // than a refinement. It used to ask `isFile(target)` — is there a file at the
  // exact path this move is about to write — which is a strictly narrower
  // question than the one the header at the top of this file claims to enforce:
  // exactly one `<sessionId>.jsonl` on the machine. A copy of the id sitting
  // under a DIFFERENT slug in the destination account sailed straight through,
  // the rename landed beside it, and the account ended up holding two files
  // named after one conversation — which is precisely the state every reader
  // then has to guess its way out of. Different slugs are not exotic: the slug
  // encodes the cwd, and a conversation resumed from a git worktree of its own
  // repo has a different cwd and therefore a different slug.
  //
  // Only reachable from an earlier move that died between the copy and the
  // removal, from a config directory that leaked into a tmux pane and took the
  // next turn with it, or from a hand-edit. Either way the right answer is to
  // stop: overwriting would destroy one of the two conversations claiming this
  // id. `accountMove.setAsideTranscript` is the way out, offered by the caller.
  const collision = transcriptInConfigDir(toDir, sessionId);
  if (collision !== null) {
    out.error =
      `A transcript for this conversation already exists at ${collision} — ` +
      'refusing to overwrite it.';
    return out;
  }

  try {
    await movePath(source, target);
  } catch (err) {
    logError('accountMove: transcript move failed', err);
    out.error = `The transcript could not be moved to ${path.dirname(target)}.`;
    return out;
  }
  out.ok = true;
  out.transcriptPath = target;
  log('accountMove:', sessionId, 'transcript ->', target);

  for (const name of SESSION_SIDECAR_DIRS) {
    const sidecarFrom = path.join(fromDir, name, sessionId);
    if (!isDir(sidecarFrom)) continue; // nothing of this kind for this session
    const sidecarTo = path.join(toDir, name, sessionId);
    if (fs.existsSync(sidecarTo)) {
      out.skipped.push(name);
      continue; // same refusal as the transcript's, for the same reason
    }
    try {
      await movePath(sidecarFrom, sidecarTo);
      out.sidecars.push(name);
    } catch (err) {
      logError(`accountMove: sidecar ${name} did not follow`, err);
      out.skipped.push(name);
    }
  }
  return out;
}
