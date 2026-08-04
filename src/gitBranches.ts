// src/gitBranches.ts — what a branch row says beyond its name.
//
// src/git.ts answers "which checkouts exist"; this answers "and how does each
// one stand". Two facts, and they are the two anybody running an agent per
// worktree actually looks for before clicking a row:
//
//     main        ↑1                <- one commit nobody else has yet
//     feat/x      ↑3 ↓2 *           <- diverged, and something is uncommitted
//     spike       *                 <- no upstream at all, work in progress
//
// A separate module rather than three more fields in git.ts, because the two
// probes are shaped differently and mixing them would cost the cheap one its
// cheapness. `git worktree list` is ONE spawn per project and reports every
// checkout; ahead/behind and dirt are facts about ONE directory, so a project
// with six worktrees needs six probes. Folding them together would mean either
// spawning six processes to answer the grouping question (which runs on every
// project, in every window, whether the chips are on screen or not) or caching
// them on the same schedule as something six times cheaper.
//
// The caching discipline is git.ts's, deliberately unchanged and deliberately
// duplicated rather than abstracted: read side SYNCHRONOUS from cache, refresh
// scheduled in the background, an event only when the answer actually changed.
// Extracting a generic cache to share between the two would put a layer of
// indirection between the render path and the one property that matters about it
// — that it cannot block — and would couple two probes that have no reason to
// change together. The comments in WorktreeCache are the long version of why
// each piece is what it is; this class is that class with a different probe.
//
// Same failure contract as everything else here: git may be absent, the
// directory may not be a repository, the porcelain format may gain fields.
// Nothing throws, an unparseable line is dropped rather than guessed at, and a
// probe that fails resolves to `undefined` — a branch row with no status renders
// exactly as it did before this module existed.

import { execFile } from 'node:child_process';

import type { BranchStatus, DisposableLike } from './types';

/**
 * The ONE argument vector this module hands git, and a read by construction.
 *
 * `--porcelain=v2 --branch` is the only shape that answers both questions in a
 * single spawn: the `# branch.ab` header carries ahead/behind, and the entry
 * lines that follow carry the dirt. Two commands (`rev-list --count
 * --left-right` plus a `status`) would be two processes per worktree per
 * refresh, for information git already puts in one.
 *
 * Untracked files are NOT suppressed (`-uno` would be cheaper on a huge tree).
 * They are the thing `git worktree remove` refuses over and the thing a removal
 * would actually delete, so a status that could not see them would make the
 * removal confirmation lie.
 *
 * Returned fresh so a caller cannot mutate a shared constant into something
 * else.
 */
export function statusArgv(): string[] {
  return ['status', '--porcelain=v2', '--branch'];
}

/** A probe is on the poll path. A hung `git` must cost one stale cache entry,
 *  never a roster tick. Same budget as the worktree list: `git status` on a
 *  large tree with no fsmonitor is the slowest read here, and 4s is well past
 *  where a caller would rather have no answer than keep waiting. */
const DEFAULT_TIMEOUT_MS = 4000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/**
 * How long a status is trusted. HALF the worktree list's 30s, and the asymmetry
 * is the point: a worktree is added or removed by hand, minutes or hours apart,
 * where dirt appears the moment you save a file. A row that still said "clean"
 * half a minute after an edit would be read as broken rather than as stale.
 *
 * Not shorter than this, because the cost is per WORKTREE: at 15s a project with
 * six checkouts already spawns six `git status` calls a minute while its rows
 * are on screen, which is the ceiling worth paying for a fact nobody is waiting
 * on. `invalidate()` exists for the paths that know better — the two worktree
 * verbs both use it.
 */
const DEFAULT_TTL_MS = 15_000;

/** Cap on the cache, keyed by worktree directory. Higher than git.ts's because
 *  the key is finer — every checkout of every project, not one entry per
 *  project — and an unbounded map on a poll path is how a long-lived window
 *  leaks. */
const CACHE_SOFT_LIMIT = 512;

// ---------------------------------------------------------------- parsing

const AHEAD_BEHIND_RE = /^\+(\d+)\s+-(\d+)$/;

/**
 * `git status --porcelain=v2 --branch` → the two facts a row wants.
 *
 * The format is header lines first, each `# <key> <value>`, then one line per
 * changed path whose FIRST FIELD names what kind of change it is:
 *
 *     # branch.oid 1a2b3c4d…
 *     # branch.head feat/x
 *     # branch.upstream origin/feat/x
 *     # branch.ab +2 -1
 *     1 .M N… 100644 100644 100644 <sha> <sha> src/a.ts
 *     ? notes.md
 *
 * `branch.upstream` and `branch.ab` are ABSENT on a branch that tracks nothing,
 * which is why "no upstream" is `upstream === ''` and not a pair of zeroes: a
 * spike branch is not "in sync", it has nothing to be in sync with, and the two
 * want different words in the hover.
 *
 * Parsed leniently and forwards-compatibly, exactly as parseWorktreeList is: an
 * unknown header is skipped rather than treated as an error (git has added to
 * this format before and will again), and an entry line whose leading token we
 * do not recognise contributes nothing rather than being counted as a change.
 * Guessing "probably dirty" from a line we cannot read would put a mark on a
 * clean checkout, and the mark is the thing a removal confirmation leans on.
 *
 * Returns `undefined` for output that cannot be a status. Empty output is the
 * important case and is NOT "clean": `--branch` always emits its headers, so a
 * repository that answered at all answered with at least one `#` line. Empty
 * means the command did not run, and a caller must be able to tell that from a
 * checkout with nothing in it.
 */
export function parseBranchStatus(stdout: unknown): BranchStatus | undefined {
  if (typeof stdout !== 'string' || stdout.trim() === '') return undefined;

  let ahead = 0;
  let behind = 0;
  let upstream = '';
  let dirty = false;
  let untracked = false;
  let sawHeader = false;

  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line === '') continue;

    if (line.startsWith('# ')) {
      sawHeader = true;
      const rest = line.slice(2);
      const space = rest.indexOf(' ');
      const key = space < 0 ? rest : rest.slice(0, space);
      const value = space < 0 ? '' : rest.slice(space + 1).trim();
      if (key === 'branch.upstream') {
        upstream = value;
      } else if (key === 'branch.ab') {
        const m = AHEAD_BEHIND_RE.exec(value);
        if (m) {
          ahead = Number(m[1]);
          behind = Number(m[2]);
        }
      }
      // branch.oid, branch.head, stash, and whatever git adds next. Ignored on
      // purpose — see the doc comment.
      continue;
    }

    // The entry lines. '1' is an ordinary change, '2' a rename or copy, 'u' an
    // unresolved merge — all three are changes to TRACKED content. '?' is a
    // path git has never been told about, and '!' an ignored one (only listed
    // under --ignored, which we never pass), which is not a change at all.
    const kind = line.charCodeAt(0);
    if (kind === 0x31 /* 1 */ || kind === 0x32 /* 2 */ || kind === 0x75 /* u */) {
      dirty = true;
    } else if (kind === 0x3f /* ? */) {
      untracked = true;
    }
  }

  // Output with no header at all is not a `--branch` status, whatever else it
  // is. Treated as unreadable rather than parsed for its entry lines, because a
  // caller reading `dirty` off it would be reading it off something else.
  if (!sawHeader) return undefined;
  return { ahead, behind, upstream, dirty, untracked };
}

// ----------------------------------------------------------------- probing

export interface StatusProbeOptions {
  /** Full path to the git binary, or 'git' to search PATH. */
  gitBinary?: string;
  timeoutMs?: number;
  /** Injected in tests. Real callers leave it alone and get execFile. */
  run?: (
    file: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
  ) => Promise<string>;
}

function execGit(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve) => {
    try {
      execFile(
        file,
        args,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: MAX_BUFFER_BYTES,
          windowsHide: true,
          // GIT_OPTIONAL_LOCKS=0 is load-bearing here in a way it is not for
          // `worktree list`: `git status` normally REWRITES the index to save
          // the stat cache it just refreshed. That is a write to the user's
          // repository, on a timer, from a probe nobody asked for — and this
          // extension's documented promise is that it writes nothing there. The
          // flag turns it into a pure read, at the cost of not leaving the
          // speed-up behind for the next caller.
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        },
        (err, stdout) => {
          // Every failure is the same failure to a caller: no status for this
          // directory. Not a repo, git not installed, a timeout and a
          // permissions error all mean "render the row the old way".
          resolve(err ? '' : String(stdout ?? ''));
        },
      );
    } catch {
      resolve('');
    }
  });
}

/** The status of the checkout at `dir`, or undefined for anything that is not
 *  one (and for any failure at all — see execGit). */
export async function readBranchStatus(
  dir: string,
  opts?: StatusProbeOptions,
): Promise<BranchStatus | undefined> {
  if (typeof dir !== 'string' || dir.trim() === '') return undefined;
  const run = opts?.run ?? execGit;
  try {
    const stdout = await run(
      opts?.gitBinary ?? 'git',
      statusArgv(),
      dir,
      opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    return parseBranchStatus(stdout);
  } catch {
    return undefined;
  }
}

interface CacheEntry {
  status: BranchStatus | undefined;
  at: number;
  /** Set while a probe is in flight, so N callers in one tick share one spawn
   *  instead of racing N `git` processes at the same directory. */
  inFlight?: Promise<void>;
}

/**
 * The read side of branch status: a SYNCHRONOUS lookup over a cache that
 * refreshes itself in the background.
 *
 * Synchronous is the contract, not a convenience — see WorktreeCache, which this
 * mirrors deliberately. `buildViewModel` is a pure synchronous function called
 * on every paint, and making it await a subprocess would put six process spawns
 * inside one. So `get()` answers instantly from the cache and, if that answer is
 * stale or missing, kicks off a refresh whose completion fires `onDidChange` —
 * the same shape that drives a repaint everywhere else here.
 *
 * The first paint after a window opens therefore shows branch names with no
 * numbers, and the one a moment later shows the numbers. That is the right
 * trade: a tree that paints immediately with one fact missing beats a tree that
 * blocks on git.
 */
export class BranchStatusCache implements DisposableLike {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly ttlMs: number;
  private readonly opts: StatusProbeOptions;
  private readonly now: () => number;
  private disposed = false;

  constructor(opts?: StatusProbeOptions & { ttlMs?: number; now?: () => number }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts?.now ?? Date.now;
    this.opts = {
      ...(opts?.gitBinary === undefined ? {} : { gitBinary: opts.gitBinary }),
      ...(opts?.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      ...(opts?.run === undefined ? {} : { run: opts.run }),
    };
  }

  /** Fires after a probe lands with a DIFFERENT answer than the cache held.
   *  Silence on an unchanged result is what stops a 15s TTL from repainting the
   *  tree four times a minute forever. */
  onDidChange(fn: () => void): DisposableLike {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  /**
   * The status of `dir`, from cache. Never blocks; schedules a refresh when the
   * entry is missing or past its TTL.
   *
   * Returns undefined both for "not probed yet" and for "probed, not readable".
   * Callers cannot tell those apart and must not need to — a row with no status
   * draws no numbers either way, and the first turns into the second within a
   * tick.
   */
  get(dir: string): BranchStatus | undefined {
    if (this.disposed || typeof dir !== 'string' || dir.trim() === '') {
      return undefined;
    }
    const entry = this.cache.get(dir);
    if (entry === undefined || this.now() - entry.at > this.ttlMs) {
      void this.refresh(dir);
    }
    return entry?.status;
  }

  /** Drop `dir`'s entry (or the whole cache) so the next `get` re-probes. For
   *  the paths that KNOW something changed — a worktree Flock itself just added
   *  or removed — rather than waiting out the TTL. */
  invalidate(dir?: string): void {
    if (dir === undefined) this.cache.clear();
    else this.cache.delete(dir);
  }

  /** Probe now and wait for it. Only for tests and for a caller that has to have
   *  an answer before it can act (Remove Worktree, which decides how many
   *  confirmations to ask for from the dirt); the render path uses `get`. */
  async warm(dir: string): Promise<BranchStatus | undefined> {
    await this.refresh(dir);
    return this.cache.get(dir)?.status;
  }

  private refresh(dir: string): Promise<void> {
    const existing = this.cache.get(dir)?.inFlight;
    if (existing) return existing;

    const task = readBranchStatus(dir, this.opts).then((status) => {
      if (this.disposed) return;
      const prev = this.cache.get(dir)?.status;
      this.evictIfNeeded();
      this.cache.set(dir, { status, at: this.now() });
      if (!sameStatus(prev, status)) this.emit();
    });

    // Stamped onto whatever is already there so a stale-but-present entry keeps
    // answering `get` while its own refresh runs.
    const entry = this.cache.get(dir);
    if (entry) entry.inFlight = task;
    else this.cache.set(dir, { status: undefined, at: 0, inFlight: task });

    return task.finally(() => {
      const e = this.cache.get(dir);
      if (e && e.inFlight === task) delete e.inFlight;
    });
  }

  /** Oldest-first eviction. The map is small and this runs only on insert past
   *  the cap, so a full scan is cheaper than maintaining an LRU list. */
  private evictIfNeeded(): void {
    if (this.cache.size < CACHE_SOFT_LIMIT) return;
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.cache) {
      if (entry.inFlight) continue;
      if (entry.at < oldestAt) {
        oldestAt = entry.at;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.cache.delete(oldestKey);
  }

  private emit(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch {
        // A listener that throws must not take the cache down with it, and must
        // not stop the listeners after it from firing.
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.cache.clear();
  }
}

/** Field equality, undefined-tolerant. What decides whether a landed probe is
 *  worth a repaint — every field is drawn or hovered somewhere, so any of them
 *  changing is a change. */
function sameStatus(
  a: BranchStatus | undefined,
  b: BranchStatus | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.ahead === b.ahead &&
    a.behind === b.behind &&
    a.upstream === b.upstream &&
    a.dirty === b.dirty &&
    a.untracked === b.untracked
  );
}
