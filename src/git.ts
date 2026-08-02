// IMPLEMENTED BY: M20 — worktree awareness.
//
// Imports allowed here: ./types, ./log, node:child_process. NEVER import
// vscode, and never import ./projects — the PURE modules (projects.ts,
// viewmodel.ts) are downstream of this one and are handed its output as plain
// data. That direction is what keeps grouping unit-testable without a git
// binary anywhere near the test runner.
//
// Why this module exists at all: a session's cwd is not its address. Somebody
// running 3–8 agents in parallel gives each one its own git WORKTREE — a second
// checkout of the same repository, at a different path, on a different branch:
//
//     ~/code/app              main      <- the main worktree
//     ~/code/app-feat-x       feat/x    <- `git worktree add ../app-feat-x`
//     ~/code/app-feat-y       feat/y
//
// Three directories, one repository. Grouped by cwd alone those are three
// unrelated folder rows and the tree has thrown away the only fact that
// mattered — that they are the same project on different branches. `git
// worktree list --porcelain`, run ONCE per project directory, is the whole fix:
// it names every checkout of the repo and the branch each one is on, which is
// both the grouping key and the row label.
//
// Design note, same shape as roster.ts's: `git` may be absent, the directory
// may not be a repository, and the porcelain format may gain fields. Nothing in
// here throws, an unparseable line is dropped rather than guessed at, and a
// probe that fails resolves to an empty list — a project with no branch
// information renders exactly as it did before this module existed.

import { execFile } from 'node:child_process';

import { log } from './log';
import type { DisposableLike, Worktree } from './types';

/** The ONLY argument vector we ever hand the git binary. Read-only by
 *  construction: `worktree list` reports, and there is no code path in this
 *  extension that mutates a repository. Returned fresh so a caller cannot
 *  mutate a shared constant into something else. */
function worktreeArgv(): string[] {
  return ['worktree', 'list', '--porcelain'];
}

/** A probe is on the poll path. A hung `git` must cost one stale cache entry,
 *  never a roster tick. */
const DEFAULT_TIMEOUT_MS = 4000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/** How long a probe result is trusted. Worktrees are added and removed by hand,
 *  minutes or hours apart — polling git every 3s alongside the roster would be
 *  a process spawn per project per tick to watch something that almost never
 *  changes. 30s is under the threshold where a newly-added worktree feels
 *  missing, and `invalidate()` exists for the paths that know better. */
const DEFAULT_TTL_MS = 30_000;

/** Cap on the cache. Keyed by project directory, so in practice this is the
 *  number of projects — the limit only matters if a caller starts probing
 *  session cwds directly, and an unbounded map on a poll path is how a
 *  long-lived window leaks. */
const CACHE_SOFT_LIMIT = 256;

// ---------------------------------------------------------------- parsing

/**
 * `git worktree list --porcelain` → the worktrees it names.
 *
 * The format is one stanza per worktree, blank-line separated, each opening
 * with a `worktree <path>` line:
 *
 *     worktree /Users/x/code/app
 *     HEAD fb7bf2d6cf045c5b14ecffb272c32978e9216c73
 *     branch refs/heads/main
 *
 *     worktree /Users/x/code/app-feat-x
 *     HEAD 9c1e0a2...
 *     detached
 *
 * Parsed leniently and forwards-compatibly: any line whose keyword we do not
 * recognise is skipped rather than treated as an error, because git has added
 * attributes to this format before (`locked`, `prunable`) and will again. A
 * stanza with no `worktree` line contributes nothing.
 *
 * `branch` is the SHORT name — `refs/heads/` stripped — because that is what a
 * row has room to show. A detached HEAD keeps `branch: ''` and is flagged, so a
 * caller can tell "no branch" from "not read yet"; the two want different words
 * on screen.
 *
 * Pure and exported for its own sake: this is the whole of the format contract,
 * and it is the part worth testing against captured real output.
 */
export function parseWorktreeList(stdout: unknown): Worktree[] {
  if (typeof stdout !== 'string' || stdout.trim() === '') return [];
  const out: Worktree[] = [];
  let current: Worktree | null = null;

  const flush = (): void => {
    if (current !== null && current.dir !== '') out.push(current);
    current = null;
  };

  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line === '') {
      flush();
      continue;
    }
    const space = line.indexOf(' ');
    const keyword = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1).trim();

    switch (keyword) {
      case 'worktree':
        // A second `worktree` line with no blank line between stanzas is not a
        // shape git emits, but closing the open one is the only reading that
        // cannot lose a checkout.
        flush();
        if (value !== '') {
          current = { dir: value, branch: '', head: '', detached: false };
        }
        break;
      case 'HEAD':
        if (current) current.head = value;
        break;
      case 'branch':
        if (current) current.branch = shortBranch(value);
        break;
      case 'detached':
        if (current) current.detached = true;
        break;
      default:
        // `bare`, `locked`, `prunable`, and whatever git adds next. Ignored on
        // purpose — see the doc comment.
        break;
    }
  }
  flush();
  return out;
}

/** `refs/heads/feat/x` → `feat/x`. Anything that is not a heads ref is handed
 *  back as-is: a detached worktree has no branch line at all, so the only way
 *  to reach this with something else is a git that changed the format, and the
 *  raw value is a better row label than a blank. */
export function shortBranch(ref: unknown): string {
  if (typeof ref !== 'string') return '';
  const trimmed = ref.trim();
  return trimmed.startsWith('refs/heads/')
    ? trimmed.slice('refs/heads/'.length)
    : trimmed;
}

// ----------------------------------------------------------------- probing

export interface ProbeOptions {
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
          // A repository whose hooks or config would prompt must not be able to
          // block a probe on the poll path.
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        },
        (err, stdout) => {
          // Every failure is the same failure to a caller: no worktree
          // information for this directory. Not a repo, git not installed, a
          // timeout and a permissions error all mean "render it the old way".
          resolve(err ? '' : String(stdout ?? ''));
        },
      );
    } catch {
      resolve('');
    }
  });
}

/**
 * The worktrees of the repository containing `dir`, or [] for anything that is
 * not a repository (and for any failure at all — see execGit).
 *
 * Note what is NOT asked for: the repository's identity. `git worktree list`
 * reports the same set from any checkout of the repo, so the FIRST entry — git
 * always lists the main worktree first — is a stable key for "which repository
 * is this", with no second spawn to get it.
 */
export async function listWorktrees(
  dir: string,
  opts?: ProbeOptions,
): Promise<Worktree[]> {
  if (typeof dir !== 'string' || dir.trim() === '') return [];
  const run = opts?.run ?? execGit;
  try {
    const stdout = await run(
      opts?.gitBinary ?? 'git',
      worktreeArgv(),
      dir,
      opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    return parseWorktreeList(stdout);
  } catch {
    return [];
  }
}

interface CacheEntry {
  worktrees: Worktree[];
  at: number;
  /** Set while a probe is in flight, so N callers in one tick share one spawn
   *  instead of racing N `git` processes at the same directory. */
  inFlight?: Promise<void>;
}

/**
 * The read-side of worktree discovery: a SYNCHRONOUS lookup over a cache that
 * refreshes itself in the background.
 *
 * Synchronous is not a convenience here, it is the contract. `computeGrouping`
 * and `buildViewModel` are pure synchronous functions called on every render,
 * and making either of them await a subprocess would put a process spawn inside
 * a paint. So `get()` answers instantly from the cache and, if that answer is
 * stale or missing, kicks off a refresh whose completion fires `onDidChange` —
 * the same shape the roster poller already uses to drive a repaint.
 *
 * The first render of a new project therefore shows no branches, and the one
 * ~40ms later shows them. That is the right trade: a tree that paints
 * immediately with one fact missing beats a tree that blocks on git.
 */
export class WorktreeCache implements DisposableLike {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly ttlMs: number;
  private readonly opts: ProbeOptions;
  private readonly now: () => number;
  private disposed = false;

  constructor(opts?: ProbeOptions & { ttlMs?: number; now?: () => number }) {
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
   * The worktrees for `dir`, from cache. Never blocks; schedules a refresh when
   * the entry is missing or past its TTL.
   *
   * Returns the empty array both for "not probed yet" and for "probed, not a
   * repository". Callers cannot tell those apart and must not need to — a
   * project with no worktree information renders without a chip row either way,
   * and the first one turns into the second within a tick.
   */
  get(dir: string): readonly Worktree[] {
    if (this.disposed || typeof dir !== 'string' || dir.trim() === '') return [];
    const entry = this.cache.get(dir);
    if (entry === undefined || this.now() - entry.at > this.ttlMs) {
      void this.refresh(dir);
    }
    return entry?.worktrees ?? [];
  }

  /** Drop `dir`'s entry (or the whole cache) so the next `get` re-probes. For
   *  the paths that KNOW something changed — a project re-pointed at another
   *  directory — rather than waiting out the TTL. */
  invalidate(dir?: string): void {
    if (dir === undefined) this.cache.clear();
    else this.cache.delete(dir);
  }

  /** Probe now and wait for it. Only for tests and for the one caller that has
   *  to have an answer before it can act (the branch picker); the render path
   *  uses `get`. */
  async warm(dir: string): Promise<readonly Worktree[]> {
    await this.refresh(dir);
    return this.cache.get(dir)?.worktrees ?? [];
  }

  private refresh(dir: string): Promise<void> {
    const existing = this.cache.get(dir)?.inFlight;
    if (existing) return existing;

    const task = listWorktrees(dir, this.opts).then((worktrees) => {
      if (this.disposed) return;
      const prev = this.cache.get(dir)?.worktrees;
      this.evictIfNeeded();
      this.cache.set(dir, { worktrees, at: this.now() });
      if (!sameWorktrees(prev, worktrees)) {
        if (worktrees.length > 1) {
          log('git: %d worktrees at %s', worktrees.length, dir);
        }
        this.emit();
      }
    });

    // Stamped onto whatever is already there so a stale-but-present entry keeps
    // answering `get` while its own refresh runs.
    const entry = this.cache.get(dir);
    if (entry) entry.inFlight = task;
    else this.cache.set(dir, { worktrees: [], at: 0, inFlight: task });

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
        // A listener that throws must not take the cache down with it, and
        // must not stop the listeners after it from firing.
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.cache.clear();
  }
}

/** Order-sensitive equality, which is what we want: git lists the main worktree
 *  first and the rest in a stable order, so a reordering IS a change worth
 *  repainting for. */
function sameWorktrees(
  a: readonly Worktree[] | undefined,
  b: readonly Worktree[],
): boolean {
  if (a === undefined) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].dir !== b[i].dir ||
      a[i].branch !== b[i].branch ||
      a[i].detached !== b[i].detached
    ) {
      return false;
    }
  }
  return true;
}
