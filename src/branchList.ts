// src/branchList.ts — which branches EXIST, as opposed to which have a checkout.
//
// The third git probe, and the one that answers the question the other two
// cannot. src/git.ts asks `worktree list` and gets the branches with a
// DIRECTORY; src/gitBranches.ts asks `status` and gets how one of those
// directories stands. Neither can see a branch nobody has checked out — and a
// repository's branches are mostly those:
//
//     main                 <- checked out at ~/code/app        (git.ts sees it)
//     feat/x               <- checked out at ~/code/app-feat-x (git.ts sees it)
//     fix/login            <- a ref and nothing else           (only this module)
//     spike/auth           <- a ref and nothing else
//     … 179 more
//
// A separate module rather than a fourth field on WorktreeCache, for the reason
// gitBranches.ts is separate from git.ts and stated at length there: the probes
// have different shapes and different lifetimes, and folding them together
// couples two things that have no reason to change together. This one is ONE
// spawn per repository, like `worktree list`, and shares its 30s TTL so a
// directory's two reads land together and cost one repaint rather than two.
//
// Same failure contract as its two neighbours, and it matters more here because
// this list is long: git may be absent, the directory may not be a repository,
// and the format may gain fields. Nothing throws, a line that cannot be parsed
// is dropped rather than guessed at, and a probe that fails resolves to an empty
// list — which renders as a directory row with no branch fold under it, exactly
// the way a non-git directory has always rendered.

import { execFile } from 'node:child_process';

import { log } from './log';
import type { DisposableLike, LocalBranch } from './types';

/**
 * How many refs the enumeration reads.
 *
 * A cap is not a curation decision — the fold shows everything this returns, and
 * the whole point of the feature is that a branch is not hidden merely for being
 * old. It is a memory bound on a poll path: `for-each-ref` over a repository with
 * fifty thousand refs would hand back megabytes per probe per project, and no
 * sidebar is a way to read fifty thousand rows anyway.
 *
 * FIVE HUNDRED, matching the New Worktree picker's own cap in src/worktrees.ts,
 * and the match is load-bearing rather than tidy: a branch that appears in the
 * fold and then is missing from the picker you reach FROM that fold would read as
 * a bug. test/branchList.test.ts cross-checks the two argv builders so the two
 * cannot drift apart silently.
 *
 * `--sort=-committerdate` is applied by git BEFORE `--count`, so what a cap drops
 * is always the oldest refs — the ones least likely to be work in flight.
 */
export const MAX_LOCAL_BRANCHES = 500;

/** A probe is on the poll path. A hung `git` must cost one stale cache entry,
 *  never a roster tick. Same budget as `worktree list`, which is the probe this
 *  one is paired with. */
const DEFAULT_TIMEOUT_MS = 4000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/** How long the list is trusted. THIRTY SECONDS, deliberately identical to
 *  WorktreeCache's: the two are read for the same directory in the same paint, so
 *  a shorter TTL here would refresh half the branch block on its own and repaint
 *  the tree twice for one logical change. Branches are made by hand, minutes
 *  apart, so this is well inside "feels live". */
const DEFAULT_TTL_MS = 30_000;

/** Cap on the cache, keyed by the directory asked about. Same shape and same
 *  reason as WorktreeCache's: an unbounded map on a poll path is how a
 *  long-lived window leaks. */
const CACHE_SOFT_LIMIT = 256;

/** The field separator. A TAB because `git check-ref-format` forbids ASCII
 *  control characters in a ref name outright, which makes it the one delimiter a
 *  branch name provably cannot contain — where `-` and `/` are ordinary in one
 *  and space is merely unusual. */
const SEP = '\t';

/**
 * The ONE argument vector this module hands git, and a read by construction.
 *
 * `for-each-ref` rather than `branch --list`: `branch` is porcelain whose output
 * is decorated for humans (the `* ` on the current branch, colour, column
 * alignment) and explicitly not a format contract, where `for-each-ref` takes the
 * format as an argument and gives back exactly the three fields asked for.
 *
 * `refs/heads/` scopes it to LOCAL branches. Remote-tracking refs are deliberately
 * out: `origin/feat/x` is not something a session can run in and not something
 * `git worktree add` takes without more ceremony, so listing them would double the
 * rows to show things no verb on the row can act on.
 *
 * Returned fresh so a caller cannot mutate a shared constant into something else.
 */
export function branchListArgv(): string[] {
  return [
    'for-each-ref',
    `--format=%(refname:short)${SEP}%(committerdate:unix)${SEP}%(objectname)`,
    '--sort=-committerdate',
    `--count=${MAX_LOCAL_BRANCHES}`,
    'refs/heads/',
  ];
}

/**
 * `git for-each-ref` output → the branches it names, newest commit first.
 *
 * One line per ref, three tab-separated fields:
 *
 *     feat/x<TAB>1754300000<TAB>9c1e0a2…
 *     main<TAB>1754100000<TAB>fb7bf2d…
 *
 * Parsed leniently, the same way parseWorktreeList and parseBranchStatus are: a
 * line with no name contributes nothing, and a line whose DATE or OID cannot be
 * read still contributes its branch — the name is the part a row cannot do
 * without, where the other two only decorate it. An unreadable date becomes 0,
 * which the sort sends to the back rather than to 1970.
 *
 * Order is git's, preserved. `--sort=-committerdate` already put the most
 * recently-committed ref first, which is the order the fold wants, and re-sorting
 * here would be a second opinion about a decision git already made correctly.
 *
 * Duplicates are dropped on first-wins. `for-each-ref` does not emit a ref twice,
 * so reaching this means output from something that is not the command we ran, and
 * one row per name is the only shape a tree can draw.
 */
export function parseBranchList(stdout: unknown): LocalBranch[] {
  if (typeof stdout !== 'string' || stdout.trim() === '') return [];
  const out: LocalBranch[] = [];
  const seen = new Set<string>();

  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line === '') continue;
    const fields = line.split(SEP);
    const name = (fields[0] ?? '').trim();
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      committedAt: parseUnixSeconds(fields[1]),
      head: (fields[2] ?? '').trim(),
    });
  }
  return out;
}

/** A `%(committerdate:unix)` field → seconds, or 0 for anything that is not a
 *  plain non-negative integer. Not `Number()`: that accepts `''` as 0, `'1e9'`
 *  and whitespace, and a date read out of a malformed line would then sort as a
 *  real one. */
function parseUnixSeconds(field: unknown): number {
  if (typeof field !== 'string') return 0;
  const trimmed = field.trim();
  if (!/^\d+$/.test(trimmed)) return 0;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : 0;
}

// ----------------------------------------------------------------- probing

export interface BranchListProbeOptions {
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
          // Both flags for the same reasons the other two probes set them: a
          // repository whose config would prompt must fail rather than hang on a
          // dialog nobody can see, and this extension does not write to the
          // user's repository — not even the index refresh a read might leave
          // behind.
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        },
        (err, stdout) => {
          // Every failure is the same failure to a caller: no branch list for
          // this directory. Not a repo, git not installed, a timeout and a
          // permissions error all mean "draw no fold".
          resolve(err ? '' : String(stdout ?? ''));
        },
      );
    } catch {
      resolve('');
    }
  });
}

/** The local branches of the repository containing `dir`, newest first, or [] for
 *  anything that is not a repository (and for any failure at all — see
 *  execGit). */
export async function readLocalBranchList(
  dir: string,
  opts?: BranchListProbeOptions,
): Promise<LocalBranch[]> {
  if (typeof dir !== 'string' || dir.trim() === '') return [];
  const run = opts?.run ?? execGit;
  try {
    const stdout = await run(
      opts?.gitBinary ?? 'git',
      branchListArgv(),
      dir,
      opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    return parseBranchList(stdout);
  } catch {
    return [];
  }
}

interface CacheEntry {
  branches: LocalBranch[];
  at: number;
  /** Set while a probe is in flight, so N callers in one tick share one spawn
   *  instead of racing N `git` processes at the same directory. */
  inFlight?: Promise<void>;
}

/**
 * The read side of branch enumeration: a SYNCHRONOUS lookup over a cache that
 * refreshes itself in the background.
 *
 * The third copy of this class, and deliberately a copy rather than a shared
 * generic — see the note at the top of src/gitBranches.ts, which made the same
 * choice for the same reason. What matters about the read path is the one
 * property an abstraction would put a layer in front of: `computeGrouping` and
 * `buildViewModel` are pure synchronous functions called on every paint, and
 * neither may ever wait on a subprocess. So `get()` answers instantly from the
 * cache and, when that answer is stale or missing, kicks off a refresh whose
 * completion fires `onDidChange` — the same shape that drives a repaint
 * everywhere else here.
 *
 * The first paint after a window opens therefore shows the checkouts with no fold
 * under them, and the one a moment later shows the fold. That is the right trade
 * in the same direction every other probe here takes it.
 */
export class BranchListCache implements DisposableLike {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly ttlMs: number;
  private readonly opts: BranchListProbeOptions;
  private readonly now: () => number;
  private disposed = false;

  constructor(
    opts?: BranchListProbeOptions & { ttlMs?: number; now?: () => number },
  ) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts?.now ?? Date.now;
    this.opts = {
      ...(opts?.gitBinary === undefined ? {} : { gitBinary: opts.gitBinary }),
      ...(opts?.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      ...(opts?.run === undefined ? {} : { run: opts.run }),
    };
  }

  /** Fires after a probe lands with a DIFFERENT answer than the cache held.
   *  Silence on an unchanged result is what stops a 30s TTL from repainting the
   *  tree twice a minute forever. */
  onDidChange(fn: () => void): DisposableLike {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  /**
   * The branches for `dir`, from cache. Never blocks; schedules a refresh when
   * the entry is missing or past its TTL.
   *
   * Returns the empty array both for "not probed yet" and for "probed, not a
   * repository". Callers cannot tell those apart and must not need to — a
   * directory row draws no fold either way, and the first turns into the second
   * within a tick.
   */
  get(dir: string): readonly LocalBranch[] {
    if (this.disposed || typeof dir !== 'string' || dir.trim() === '') return [];
    const entry = this.cache.get(dir);
    if (entry === undefined || this.now() - entry.at > this.ttlMs) {
      void this.refresh(dir);
    }
    return entry?.branches ?? [];
  }

  /** Drop `dir`'s entry (or the whole cache) so the next `get` re-probes. For the
   *  paths that KNOW something changed — the two worktree verbs, which create and
   *  delete refs — rather than waiting out the TTL. */
  invalidate(dir?: string): void {
    if (dir === undefined) this.cache.clear();
    else this.cache.delete(dir);
  }

  /** Probe now and wait for it. Only for tests and for a caller that has to have
   *  an answer before it can act; the render path uses `get`. */
  async warm(dir: string): Promise<readonly LocalBranch[]> {
    await this.refresh(dir);
    return this.cache.get(dir)?.branches ?? [];
  }

  private refresh(dir: string): Promise<void> {
    const existing = this.cache.get(dir)?.inFlight;
    if (existing) return existing;

    const task = readLocalBranchList(dir, this.opts).then((branches) => {
      if (this.disposed) return;
      const prev = this.cache.get(dir)?.branches;
      this.evictIfNeeded();
      this.cache.set(dir, { branches, at: this.now() });
      if (!sameBranchList(prev, branches)) {
        if (branches.length > 0) {
          log('git: %d local branches at %s', branches.length, dir);
        }
        this.emit();
      }
    });

    // Stamped onto whatever is already there so a stale-but-present entry keeps
    // answering `get` while its own refresh runs.
    const entry = this.cache.get(dir);
    if (entry) entry.inFlight = task;
    else this.cache.set(dir, { branches: [], at: 0, inFlight: task });

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

/**
 * Order-sensitive equality, which is what we want: the list is sorted by commit
 * date, so a REORDERING means somebody committed and the fold's order on screen
 * is now wrong.
 *
 * `head` is compared for the same reason — a branch whose tip moved is a branch
 * whose hover changed — but `committedAt` is NOT, on its own: a commit changes
 * both, and comparing the date as well would repaint on a rebase that produced an
 * identical tree at a new timestamp. Both are cheap; the point of the comparison
 * is to stay silent when nothing a row draws has changed.
 */
function sameBranchList(
  a: readonly LocalBranch[] | undefined,
  b: readonly LocalBranch[],
): boolean {
  if (a === undefined) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].name || a[i].head !== b[i].head) return false;
  }
  return true;
}
