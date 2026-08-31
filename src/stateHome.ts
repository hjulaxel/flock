// src/stateHome.ts — WHERE the editorial store lives, and why that is not
// `globalStorageUri` any more.
//
// THE BUG THIS FILE EXISTS TO FIX. Everything state.json describes is
// MACHINE-WIDE: the `-L lineage` tmux server (one per machine), the roster
// `claude agents --json` returns (machine-wide by construction — see
// hosts.ts), the transcripts under `~/.claude/projects`, the checkouts a
// project record names. `context.globalStorageUri` is not. It is
// `<editor app>/User/globalStorage/<publisher>.<name>`, so VS Code, Cursor,
// Windsurf and every other fork of the same editor each get their OWN copy —
// and Flock ships on Open VSX, which is exactly where the forks shop.
//
// Measured, on this machine, the first time Flock was opened in Cursor beside
// a working VS Code:
//
//   * the Sessions view had no projects in it. Not "the wrong projects" — the
//     store was empty, so the sessions fell back to folder groups labelled
//     with their absolute paths, which is also precisely what a genuine first
//     run looks like;
//   * every project verb answered "Flock: no projects yet";
//   * and the activation tmux reconcile (idleClose.reconcileTmuxDecisions)
//     listed seven live sessions on the shared socket, found no record, no
//     grace and no window claiming any of them — because the records were in
//     the OTHER app's file — and killed all seven. Named, working sessions:
//     release, summary, bug, housekeeping, timer, commands, 2pl-fluency.
//     A reaper whose reach was machine-wide and whose evidence was not.
//
// So the store moves to `~/.lineage/state/state.json`, next to the account
// profiles that already live under `~/.lineage` (accounts.PROFILES_DIR_SEGMENTS)
// and for the same reason: it describes the machine, so it belongs to the
// machine. One flock, however many editors are looking at it.
//
// NOTHING ELSE MOVES, deliberately. `bare-rescue/` stays per-app: its ledger
// is verified by `ppid === 1` rather than by bookkeeping (see the rescue in
// extension.ts), so a per-app ledger under-reaps at worst, while a shared one
// would hand each app a list of the others' live pids. The anchor directory
// and `lineage.code-workspace` are this window's own plumbing, and tmux.conf
// is written identically by every install.
//
// This module NEVER imports vscode.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { log, logError } from './log';
import { mergeStates, migrateState } from './state';

/** The state file's name, in both the shared and the legacy directory. */
export const STATE_FILE_NAME = 'state.json';

/** Where the shared store lives, relative to the home directory. Under our
 *  OWN dot-directory, beside `profiles/` — see accounts.PROFILES_DIR_SEGMENTS
 *  for the argument against nesting inside `~/.claude`. */
export const STATE_DIR_SEGMENTS: readonly string[] = ['.lineage', 'state'];

/**
 * Written into the legacy directory once its file has been folded into the
 * shared one, so the adoption happens exactly once per app.
 *
 * A marker rather than a rename, and rather than re-merging every activation.
 * Re-merging would resurrect what the shared store has since archived or
 * deleted — a `closed` stamp is newer-wins, but the legacy copy would keep
 * re-presenting its own older opinion of every record it holds. Renaming
 * would leave a DOWNGRADE — an older build, a rolled-back .vsix — reading an
 * absent file, which is the empty store the whole incident above came from.
 * Leaving the legacy file exactly where it is costs a few hundred kilobytes
 * and makes going back harmless.
 */
export const ADOPTED_MARKER_NAME = 'adopted-into-shared.json';

/**
 * Serialises the adoption itself, in the shared directory.
 *
 * The one moment two applications can genuinely collide: both upgraded, both
 * launched in the same second, both find no shared file and both write theirs
 * — and the loser's rename is overwritten by the winner's while its marker
 * says the job is done. That is the only path in this file that can lose a
 * store, so it gets a lock rather than an argument.
 *
 * Same shape as the store's own write lock (state.ts): O_EXCL create, broken
 * after `ADOPT_LOCK_STALE_MS` so a crash between the create and the release
 * cannot wedge every future activation. Unlike that one it does NOT degrade to
 * a lock-free write — it defers (see AdoptStatus). The store's writes can
 * afford to race because each one re-reads and re-merges afterwards; this runs
 * once per application, ever, and has no second pass to correct itself with.
 */
const ADOPT_LOCK_NAME = 'state.json.adopt.lock';
const ADOPT_LOCK_STALE_MS = 10_000;
/** How long an activation waits for another application's adoption. */
const ADOPT_LOCK_WAIT_MS = 2_000;
const ADOPT_LOCK_POLL_MS = 25;

/** Pure. `~/.lineage/state`, or '' when `homeDir` is unusable — which callers
 *  must read as "no shared home", never as a path. Forward slashes, matching
 *  the spelling projects.ts and accounts.ts normalise to. */
export function sharedStateDir(homeDir: string): string {
  if (typeof homeDir !== 'string') return '';
  const home = homeDir.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (home === '') return '';
  return [home, ...STATE_DIR_SEGMENTS].join('/');
}

/** What `adoptLegacyState` did, for the log line and for the tests. */
export type AdoptStatus =
  /** No legacy file to adopt — a genuinely fresh install. */
  | 'none'
  /** A marker says this app's file was folded in on an earlier activation. */
  | 'already'
  /** The shared file did not exist; the legacy one became it verbatim. */
  | 'seeded'
  /** Both existed; `mergeStates` folded the legacy one into the shared one. */
  | 'merged'
  /** Another application held the adoption lock. Nothing written, nothing
   *  marked; the next activation does the job. */
  | 'deferred'
  /** IO or parse trouble. The caller must stay on the legacy directory. */
  | 'failed';

export interface AdoptResult {
  status: AdoptStatus;
  /** Present on 'failed' only. */
  error?: unknown;
}

/**
 * Fold this app's `<globalStorage>/state.json` into `~/.lineage/state/state.json`,
 * once, and leave a marker saying so.
 *
 * Synchronous on purpose: `activate()` awaits the store's `load()` two lines
 * later, and a store that read the wrong directory has already published a
 * window record and armed a reaper against the wrong file. There is no point
 * in the activation at which this can safely be concurrent.
 *
 * THE MERGE IS THE STORE'S OWN. `mergeStates(disk, mem)` is what every window
 * already runs on every write to reconcile two concurrent views of this exact
 * shape — per-key newest-wins for records, projects, windows and accounts, a
 * member union for chains, tombstones surviving as tombstones. Two apps'
 * stores are the same problem one tick further apart, so they get the same
 * answer rather than a second one written for this occasion. The shared side
 * is passed as `mem`, which is the side that wins a tie: if two apps disagree
 * with identical timestamps, the one already adopted stays.
 *
 * Never throws. On any failure the caller keeps using the legacy directory —
 * a Flock that is merely still per-app is the status quo, while a Flock
 * pointed at an empty shared file would be the incident in this file's
 * header.
 */
export function adoptLegacyState(opts: {
  sharedDir: string;
  legacyDir: string;
  /** Test seam; defaults to `new Date().toISOString()`. */
  now?: () => string;
  /** Test seam: how long to wait for another application's adoption.
   *  Defaults to ADOPT_LOCK_WAIT_MS. */
  lockWaitMs?: number;
}): AdoptResult {
  const { sharedDir, legacyDir } = opts;
  const stamp = opts.now ?? ((): string => new Date().toISOString());
  const legacyFile = path.join(legacyDir, STATE_FILE_NAME);
  const marker = path.join(legacyDir, ADOPTED_MARKER_NAME);
  const sharedFile = path.join(sharedDir, STATE_FILE_NAME);

  try {
    if (fs.existsSync(marker)) return { status: 'already' };

    let legacyText: string;
    try {
      legacyText = fs.readFileSync(legacyFile, 'utf8');
    } catch {
      // No legacy file at all: a fresh install of a build that was always
      // shared. Mark it anyway — there is nothing to adopt now and an empty
      // legacy file appearing later (a downgrade, then an upgrade) must not
      // be mistaken for state worth folding in.
      writeMarker(marker, stamp(), sharedFile, 'none');
      return { status: 'none' };
    }

    fs.mkdirSync(sharedDir, { recursive: true });

    // Everything from here to the marker is one critical section: the read of
    // the shared file and the write that answers it have to be the same
    // application's.
    const lock = takeAdoptLock(sharedDir, opts.lockWaitMs ?? ADOPT_LOCK_WAIT_MS);
    if (lock === null) {
      // Another application is adopting right now and has not finished. Do
      // NOT write over the top of it — leave the marker unwritten and the
      // next activation picks the job up. The shared store is still the one
      // to open: it already holds the other side's work, and this side's is
      // safe where it has always been.
      log('state: another application is adopting — deferring to it');
      return { status: 'deferred' };
    }
    try {
      return adoptUnderLock(sharedFile, legacyFile, legacyText, marker, stamp);
    } finally {
      releaseAdoptLock(lock);
    }
  } catch (err) {
    logError('stateHome.adoptLegacyState', err);
    return { status: 'failed', error: err };
  }
}

/** @see adoptLegacyState — the body of its critical section. */
function adoptUnderLock(
  sharedFile: string,
  legacyFile: string,
  legacyText: string,
  marker: string,
  stamp: () => string,
): AdoptResult {
  try {
    let sharedText: string | undefined;
    try {
      sharedText = fs.readFileSync(sharedFile, 'utf8');
    } catch {
      sharedText = undefined;
    }

    if (sharedText === undefined) {
      // Nobody has adopted yet: this app's file simply becomes the shared
      // one. Byte-for-byte, through a temp file in the SAME directory so a
      // second app starting at the same moment never reads half of it — the
      // discipline state.ts writes under, for the same reason.
      writeAtomic(sharedFile, legacyText);
      writeMarker(marker, stamp(), sharedFile, 'seeded');
      log(`state: adopted ${legacyFile} as the shared store at ${sharedFile}`);
      return { status: 'seeded' };
    }

    const merged = mergeStates(
      migrateState(JSON.parse(legacyText)),
      migrateState(JSON.parse(sharedText)),
    );
    writeAtomic(sharedFile, JSON.stringify(merged, null, 1));
    writeMarker(marker, stamp(), sharedFile, 'merged');
    log(`state: merged ${legacyFile} into the shared store at ${sharedFile}`);
    return { status: 'merged' };
  } catch (err) {
    logError('stateHome.adoptUnderLock', err);
    return { status: 'failed', error: err };
  }
}

/**
 * The lock's path once held, or null when it could not be taken.
 *
 * Waits, synchronously and briefly, for a lock somebody else holds: adoption
 * is one read and one write of a file measured in hundreds of kilobytes, so
 * the holder is done in milliseconds and the alternative to waiting is the
 * clobber this lock exists to prevent. `ADOPT_LOCK_WAIT_MS` bounds it well
 * under the activation budget, and a lock still held after that is treated as
 * un-takeable rather than waited on further.
 */
function takeAdoptLock(sharedDir: string, waitMs: number): string | null {
  const lockPath = path.join(sharedDir, ADOPT_LOCK_NAME);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockPath, 'wx'));
      return lockPath;
    } catch {
      let age: number;
      try {
        age = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch {
        continue; // it vanished between the open and the stat — try again
      }
      if (age >= ADOPT_LOCK_STALE_MS) {
        fs.rmSync(lockPath, { force: true }); // a crash left it behind
        continue;
      }
      if (Date.now() >= deadline) return null;
      if (!sleepSync(ADOPT_LOCK_POLL_MS)) return null;
    }
  }
}

/** A synchronous pause, or false when this host cannot make one. `activate()`
 *  is async but this decision is not: the store opens on the next line, and
 *  yielding here would let it. A host without SharedArrayBuffer gives up
 *  waiting rather than spinning hot on the activation path. */
function sleepSync(ms: number): boolean {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    return true;
  } catch {
    return false;
  }
}

function releaseAdoptLock(lockPath: string | null): void {
  if (lockPath === null) return;
  try {
    fs.rmSync(lockPath, { force: true });
  } catch (err) {
    logError('stateHome.releaseAdoptLock', err);
  }
}

/**
 * The directory the store should open, and what getting there took.
 *
 * The whole decision in one call, so `activate()` has no branch of its own to
 * get wrong: a usable home means adopt-then-share, and anything else — no
 * home directory, a migration that could not complete — means the legacy
 * directory, unchanged and still holding every byte it held before.
 */
export function resolveStateDir(opts: {
  legacyDir: string;
  homeDir: string;
}): { dir: string; status: AdoptStatus } {
  const sharedDir = sharedStateDir(opts.homeDir);
  if (sharedDir === '') return { dir: opts.legacyDir, status: 'failed' };
  const result = adoptLegacyState({ sharedDir, legacyDir: opts.legacyDir });
  return result.status === 'failed'
    ? { dir: opts.legacyDir, status: 'failed' }
    : { dir: sharedDir, status: result.status };
}

/** Write-then-rename, in the target's own directory (a cross-filesystem
 *  rename gives EXDEV). The pid suffix keeps two apps adopting at the same
 *  moment off each other's temp file. */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${String(process.pid)}.adopt.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Best-effort: a marker we could not write costs one redundant merge on the
 *  next activation, which `mergeStates` makes harmless. */
function writeMarker(
  file: string,
  at: string,
  sharedFile: string,
  status: AdoptStatus,
): void {
  try {
    fs.writeFileSync(file, JSON.stringify({ at, sharedFile, status }, null, 1));
  } catch (err) {
    logError('stateHome.writeMarker', err);
  }
}
