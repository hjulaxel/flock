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
// THE INVARIANT, and it is the reason this is a MOVE and never a copy:
// `transcript.transcriptFile` searches the default projects root first and each
// account root after it, first hit wins. Two copies of one transcript would
// therefore resolve to whichever root happens to be scanned first — which, once
// a conversation has moved OFF the default account, is the stale one. Exactly
// one `<sessionId>.jsonl` may exist on this machine at any moment, so the
// transcript is renamed (atomic, never two copies), and on the one filesystem
// where rename cannot work — a config dir the user pointed at another volume —
// the copy is unwound rather than left behind.

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
  if (isFile(target)) {
    // Only reachable from an earlier move that died between the copy and the
    // removal, or from a hand-edit. Either way the right answer is to stop:
    // overwriting would destroy one of the two conversations claiming this id.
    out.error =
      `A transcript for this conversation already exists at ${target} — ` +
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
