// src/pullRequests.ts — the one thing in Flock that reaches the network, and
// the shape of that is the whole content of this file.
//
// WHY THIS IS A `gh` SUBPROCESS AND NOT AN HTTP CALL. Flock's README promises it
// makes no network requests, and until this file existed that was literally true.
// A pull request is genuinely worth having on a branch row — it is the answer to
// "is this worktree still work in flight" — but the honest ways to get one are
// very different from each other:
//
//   * A bundled API client would mean Flock holding a GitHub token, storing it,
//     refreshing it, and choosing an API host. That is a credential this
//     extension has no business holding, and a runtime dependency the project
//     does not take.
//   * `gh pr list --json …` is a binary the USER installed, authenticated with
//     their own `gh auth login`, and pointed at their own host (github.com,
//     Enterprise, whatever their config says). Flock reads its stdout. Nothing
//     is stored, no token is seen, and turning it off is one setting.
//
// So: never a direct HTTP call from the extension, never a bundled dependency,
// and behind `lineage.git.pullRequests`, off by default. The promise in the docs
// now names this exactly, which matters more than the feature does.
//
// DEGRADING SILENTLY IS A REQUIREMENT, not a nicety. `gh` will be absent on most
// machines, unauthenticated on some, and pointed at a repository with no GitHub
// remote on plenty. All three exit non-zero, all three are the NORMAL case, and
// all three have to look identical from the outside: the branch row renders
// exactly as it does with the setting off, one line goes to the Flock output
// channel, and nothing else happens. No modal, and no toast that comes back every
// five minutes to say the same thing about a tool the user chose not to install.
//
// POLLING. There is no timer in here on purpose. `get()` is called from a render
// and schedules its own refresh when the entry is stale, which means the poll
// interval is "whenever the tree repaints, at most once per TTL" — and the
// visibility gate the wiring supplies means a hidden view repaints nothing and
// therefore asks nothing. A timer would be a second schedule to reason about, and
// one that kept talking to GitHub with the sidebar closed.

import { execFile } from 'node:child_process';

import { log } from './log';
import type {
  DisposableLike,
  GitCommandResult,
  PullRequest,
  PullRequestChecks,
  PullRequestState,
} from './types';

/**
 * The ONE argument vector this module hands `gh`, and a read by construction.
 *
 * `--state all` is a deliberate widening of the obvious `gh pr list`, which
 * defaults to open requests only. Merged is the state that MATTERS most on a
 * branch row: it is the signal that the worktree beside it is finished and can be
 * removed, which is the other half of this release. Open-only would have made
 * `merged` and `closed` vocabulary the chip could never draw.
 *
 * `--limit` because `--state all` on a busy repository is otherwise an
 * unbounded response for the sake of a handful of branches somebody has checked
 * out. 100 most-recent covers every branch a person has a worktree for; the
 * tie-break below is what keeps a branch with several requests deterministic.
 *
 * Returned fresh so a caller cannot mutate a shared constant into something else.
 */
export function pullRequestArgv(): string[] {
  return [
    'pr',
    'list',
    '--state',
    'all',
    '--limit',
    '100',
    '--json',
    'number,title,state,isDraft,headRefName,url,statusCheckRollup',
  ];
}

/** `gh pr create --web`: opens the compare page in the user's browser and
 *  returns. It creates NOTHING — the human finishes it — which is why this is the
 *  only outward-looking command in the extension that is not a read. */
export function createPullRequestArgv(): string[] {
  return ['pr', 'create', '--web'];
}

/** A network call, not a local read: the budget is generous by the standards of
 *  this codebase and still bounded, because it is on a path that a render
 *  schedules. */
const DEFAULT_TIMEOUT_MS = 10_000;
/** `gh pr create --web` waits on a browser handoff, and on an unpushed branch it
 *  fails rather than prompting (GH_PROMPT_DISABLED below). Either way it is a
 *  person watching, so it gets the worktree verbs' budget. */
const CREATE_TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * How long a pull-request list is trusted: five minutes.
 *
 * Generous on purpose, and the numbers are the argument. A branch's status is a
 * local `git status` and can be re-read every fifteen seconds for nothing; a pull
 * request is somebody else's server, and the thing being watched — a review, a CI
 * run — moves on a scale of minutes at best. Five minutes is under the threshold
 * where a merged request feels stale on a row and far above the rate at which
 * anything about it actually changes.
 */
const DEFAULT_TTL_MS = 5 * 60_000;

/**
 * How long a FAILURE is trusted: fifteen minutes.
 *
 * A separate, longer TTL because failure is the common case and it is permanent
 * in almost every instance of it — `gh` is not installed, or this repository has
 * no GitHub remote, and neither will have changed in five minutes. Retrying on
 * the success schedule would mean spawning a process that cannot work, four times
 * an hour, forever, for every repository somebody has open. It still retries,
 * because `gh auth login` is a thing people do without restarting their editor.
 */
const FAILURE_TTL_MS = 15 * 60_000;

/** Cap on the cache. Keyed by repository (one entry per project, in practice), so
 *  this only matters if a caller starts asking about worktree directories
 *  directly — and an unbounded map on a render path is how a long-lived window
 *  leaks. */
const CACHE_SOFT_LIMIT = 128;

// ---------------------------------------------------------------- parsing

/** GitHub's own words for a finished check, on either of the two node types
 *  `statusCheckRollup` mixes: CheckRun carries `conclusion`, StatusContext
 *  carries `state`. Anything not in here is treated as "still going", which is
 *  the reading that cannot turn a running build into a green tick. */
const FAILED = new Set([
  'FAILURE',
  'ERROR',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'STALE',
]);
const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/**
 * `gh pr list --json …` → the requests it named, keyed by head branch.
 *
 * A Map rather than a list because that is how every reader uses it: a branch row
 * has a name and wants the request for it, and doing that as a linear scan per row
 * per paint would be the one part of this feature that got slower with the number
 * of branches.
 *
 * Parsed DEFENSIVELY at every level, and the reason is not paranoia about GitHub —
 * it is that `gh`'s stdout is whatever version of `gh` the user has. An entry
 * missing a number or a head branch is dropped rather than defaulted (a request
 * with no number cannot be drawn and a request with no branch cannot be joined),
 * an unrecognised state falls back to `open` rather than to nothing, and anything
 * that is not an array at the top level yields an empty map.
 *
 * Returns an EMPTY MAP for output that cannot be parsed, the same value a
 * repository with no requests gets. Those two are the same thing to every caller
 * — no chip on any row — and the failure they need to tell apart (did the command
 * run at all) is the exit status, which the cache keeps separately.
 */
export function parsePullRequests(stdout: unknown): Map<string, PullRequest> {
  const out = new Map<string, PullRequest>();
  if (typeof stdout !== 'string' || stdout.trim() === '') return out;
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    // `gh` printing a warning ahead of its json, an empty body, an HTML error
    // page from a proxy. All the same thing: no requests.
    return out;
  }
  if (!Array.isArray(raw)) return out;

  for (const item of raw) {
    const pr = toPullRequest(item);
    if (pr === undefined) continue;
    const existing = out.get(pr.branch);
    if (existing === undefined || preferPullRequest(pr, existing)) {
      out.set(pr.branch, pr);
    }
  }
  return out;
}

function toPullRequest(item: unknown): PullRequest | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const o = item as Record<string, unknown>;
  const number = typeof o.number === 'number' && Number.isFinite(o.number)
    ? Math.trunc(o.number)
    : 0;
  const branch = typeof o.headRefName === 'string' ? o.headRefName.trim() : '';
  // Both are load-bearing and neither has a sane default: a request with no
  // number cannot be drawn, and one with no head branch cannot be joined onto a
  // row. Dropped rather than guessed at.
  if (number <= 0 || branch === '') return undefined;
  return {
    number,
    title: typeof o.title === 'string' ? o.title : '',
    state: toState(o.state, o.isDraft),
    checks: toChecks(o.statusCheckRollup),
    branch,
    url: typeof o.url === 'string' ? o.url : '',
  };
}

/** `state` + `isDraft` → the one word a row draws. Draft wins over open because a
 *  draft request IS open and the distinction is the useful half; an unrecognised
 *  state reads as `open`, which is the state that says "this is live" and
 *  therefore the one that cannot mislead by being too cautious. */
function toState(state: unknown, isDraft: unknown): PullRequestState {
  const s = typeof state === 'string' ? state.toUpperCase() : '';
  if (s === 'MERGED') return 'merged';
  if (s === 'CLOSED') return 'closed';
  return isDraft === true ? 'draft' : 'open';
}

/**
 * `statusCheckRollup` → one of four words.
 *
 * Worst-first, which is the only ordering a single glyph can honestly carry: one
 * failure among twenty passes is the thing you need to see, and a row that
 * averaged them would be a row that hid it. Then pending, because "not finished"
 * must never render as "passed" — a build that has not started yet would
 * otherwise show a green tick.
 *
 * `null`, an empty array and a rollup of things we cannot read all give `none`:
 * a repository with no CI is the common case and must cost the row nothing.
 */
function toChecks(rollup: unknown): PullRequestChecks {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none';
  let sawPass = false;
  let sawPending = false;
  for (const entry of rollup) {
    if (typeof entry !== 'object' || entry === null) continue;
    const o = entry as Record<string, unknown>;
    // CheckRun reports `status` + `conclusion`; StatusContext reports `state`.
    // Whichever is present, the verdict word is the same vocabulary.
    const verdict = [o.conclusion, o.state]
      .map((v) => (typeof v === 'string' ? v.toUpperCase() : ''))
      .find((v) => v !== '');
    if (verdict !== undefined && FAILED.has(verdict)) return 'fail';
    if (verdict !== undefined && PASSED.has(verdict)) {
      sawPass = true;
      continue;
    }
    // No verdict yet (a CheckRun whose `status` is QUEUED or IN_PROGRESS reports
    // `conclusion: null`), or one this version does not recognise. Both count as
    // pending, because "we cannot tell" must not read as "fine".
    sawPending = true;
  }
  if (sawPending) return 'pending';
  return sawPass ? 'pass' : 'none';
}

/**
 * Which of two requests on the SAME branch a row shows.
 *
 * `--state all` makes this reachable: a branch that was merged, deleted and
 * re-created has two requests, and so does one whose first attempt was closed.
 * Live beats finished — an open or draft request is the one you can still act on —
 * and within a tier the higher number wins, which is the more recent one. Fully
 * ordered and therefore stable across refreshes, which matters: a chip that
 * alternated between two requests every five minutes would be worse than no chip.
 */
function preferPullRequest(candidate: PullRequest, existing: PullRequest): boolean {
  const rank = (pr: PullRequest): number =>
    pr.state === 'open' || pr.state === 'draft' ? 2 : pr.state === 'merged' ? 1 : 0;
  const a = rank(candidate);
  const b = rank(existing);
  if (a !== b) return a > b;
  return candidate.number > existing.number;
}

// ----------------------------------------------------------------- probing

export interface PullRequestProbeOptions {
  /** Full path to the `gh` binary, or 'gh' to search PATH. */
  ghBinary?: string;
  timeoutMs?: number;
  /** Injected in tests. Real callers leave it alone and get execFile. */
  run?: (
    file: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
  ) => Promise<GitCommandResult>;
}

function execGh(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<GitCommandResult> {
  return new Promise<GitCommandResult>((resolve) => {
    try {
      execFile(
        file,
        args,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: MAX_BUFFER_BYTES,
          windowsHide: true,
          env: {
            ...process.env,
            // No interactive anything. `gh` will happily ask which remote to push
            // to, or offer to authenticate, and a prompt on a pipe nobody is
            // reading is a hung process holding a slot in the cache. Failing is
            // the correct outcome: the user sees git's or gh's own words and
            // decides, in a terminal, where prompts belong.
            GH_PROMPT_DISABLED: '1',
            GH_NO_UPDATE_NOTIFIER: '1',
            NO_COLOR: '1',
            CLICOLOR: '0',
            GIT_TERMINAL_PROMPT: '0',
          },
        },
        (err, stdout, stderr) => {
          resolve({
            ok: !err,
            output: err
              ? String(stderr ?? '').trim() || String(err)
              : String(stdout ?? ''),
          });
        },
      );
    } catch (err) {
      // `gh` not on PATH, mostly. The single most likely outcome of this whole
      // feature, and it has to be as quiet as every other failure here.
      resolve({ ok: false, output: String(err) });
    }
  });
}

export interface PullRequestRead {
  ok: boolean;
  byBranch: Map<string, PullRequest>;
  /** Why it failed, for the ONE log line. Never shown in the UI. */
  detail: string;
}

/** `gh pr list` in `dir`, parsed. Never throws: every failure — no binary, no
 *  auth, no GitHub remote, a timeout — comes back as `ok: false` with an empty
 *  map, and the caller renders the row exactly as it would with the feature
 *  off. */
export async function readPullRequests(
  dir: string,
  opts?: PullRequestProbeOptions,
): Promise<PullRequestRead> {
  const empty = new Map<string, PullRequest>();
  if (typeof dir !== 'string' || dir.trim() === '') {
    return { ok: false, byBranch: empty, detail: 'no directory' };
  }
  const run = opts?.run ?? execGh;
  try {
    const result = await run(
      opts?.ghBinary ?? 'gh',
      pullRequestArgv(),
      dir,
      opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ).catch((err: unknown) => ({ ok: false, output: String(err) }));
    if (!result.ok) {
      return { ok: false, byBranch: empty, detail: result.output };
    }
    return { ok: true, byBranch: parsePullRequests(result.output), detail: '' };
  } catch (err) {
    return { ok: false, byBranch: empty, detail: String(err) };
  }
}

/** `gh pr create --web` in `dir`. The browser hand-off, and the only outward
 *  action in Flock — finished by a person, on a page, not by this function. */
export function openPullRequestCreatePage(
  dir: string,
  opts?: PullRequestProbeOptions,
): Promise<GitCommandResult> {
  if (typeof dir !== 'string' || dir.trim() === '') {
    return Promise.resolve({ ok: false, output: 'no directory' });
  }
  const run = opts?.run ?? execGh;
  try {
    return run(
      opts?.ghBinary ?? 'gh',
      createPullRequestArgv(),
      dir,
      opts?.timeoutMs ?? CREATE_TIMEOUT_MS,
    ).catch((err: unknown) => ({ ok: false, output: String(err) }));
  } catch (err) {
    return Promise.resolve({ ok: false, output: String(err) });
  }
}

interface CacheEntry {
  byBranch: Map<string, PullRequest>;
  ok: boolean;
  at: number;
  inFlight?: Promise<void>;
}

export interface PullRequestCacheOptions extends PullRequestProbeOptions {
  ttlMs?: number;
  failureTtlMs?: number;
  now?: () => number;
  /**
   * Whether to ask `gh` anything at all. TWO conditions, and the wiring ANDs
   * them: `lineage.git.pullRequests` is on, and a view that would draw the answer
   * is on screen. The second is what "poll only while the view is visible"
   * amounts to when there is no timer — a render is the only thing that schedules
   * a refresh, and this is the gate that says the render is one somebody can see.
   *
   * Absent means never: a cache constructed with no gate reaches the network
   * never, which is the right default for the one feature here that can.
   */
  enabled?: () => boolean;
}

/**
 * The read side: a SYNCHRONOUS lookup over a cache that refreshes itself in the
 * background, exactly as WorktreeCache and BranchStatusCache do — see those for
 * why each piece is what it is.
 *
 * What is different here, and only here:
 *
 *   * `enabled()` gates the REFRESH, not the read. A cached answer keeps being
 *     served while the sidebar is hidden (nothing is drawing it anyway) and the
 *     network is not touched until something visible asks.
 *   * a failure is cached, with a longer TTL of its own, because failure is the
 *     normal case and is usually permanent.
 *   * a failure is logged ONCE per repository per window. Not per refresh: `gh`
 *     missing is a fact about the machine, and repeating it every fifteen minutes
 *     in the output channel would bury everything else in it.
 */
export class PullRequestCache implements DisposableLike {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly reported = new Set<string>();
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly opts: PullRequestProbeOptions;
  private readonly now: () => number;
  private readonly enabled: () => boolean;
  private disposed = false;

  constructor(opts?: PullRequestCacheOptions) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.failureTtlMs = opts?.failureTtlMs ?? FAILURE_TTL_MS;
    this.now = opts?.now ?? Date.now;
    this.enabled = opts?.enabled ?? ((): boolean => false);
    this.opts = {
      ...(opts?.ghBinary === undefined ? {} : { ghBinary: opts.ghBinary }),
      ...(opts?.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      ...(opts?.run === undefined ? {} : { run: opts.run }),
    };
  }

  /** Fires after a probe lands with a DIFFERENT answer than the cache held. */
  onDidChange(fn: () => void): DisposableLike {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  /**
   * The request on `branch` in the repository at `repoDir`, from cache. Never
   * blocks, and never reaches the network on this call.
   *
   * Returns undefined for every kind of nothing, and the caller must not need to
   * tell them apart: the setting is off, `gh` is not installed, this repository
   * is not on GitHub, the probe has not landed, or the branch simply has no pull
   * request. All five render the row as it looks with the feature off, which is
   * the whole degradation story in one return type.
   */
  get(repoDir: string, branch: string): PullRequest | undefined {
    if (this.disposed) return undefined;
    if (typeof repoDir !== 'string' || repoDir.trim() === '') return undefined;
    if (typeof branch !== 'string' || branch === '') return undefined;
    if (!this.isEnabled()) return undefined;

    const entry = this.cache.get(repoDir);
    const ttl = entry?.ok === false ? this.failureTtlMs : this.ttlMs;
    if (entry === undefined || this.now() - entry.at > ttl) {
      void this.refresh(repoDir);
    }
    return entry?.byBranch.get(branch);
  }

  /** Drop `repoDir`'s entry (or the whole cache) so the next `get` re-probes.
   *  Called when the setting is turned on, so the first row after the flip does
   *  not have to wait out a cached failure from before it. */
  invalidate(repoDir?: string): void {
    if (repoDir === undefined) {
      this.cache.clear();
      this.reported.clear();
    } else {
      this.cache.delete(repoDir);
      this.reported.delete(repoDir);
    }
  }

  /** Probe now and wait for it. Tests, and the one verb that has to have an
   *  answer before it can act. */
  async warm(repoDir: string): Promise<void> {
    await this.refresh(repoDir);
  }

  private isEnabled(): boolean {
    try {
      return this.enabled() === true;
    } catch {
      // A gate that throws is a gate that said no. The network is the one thing
      // here that must never happen by accident.
      return false;
    }
  }

  private refresh(repoDir: string): Promise<void> {
    if (this.disposed || !this.isEnabled()) return Promise.resolve();
    const existing = this.cache.get(repoDir)?.inFlight;
    if (existing) return existing;

    const task = readPullRequests(repoDir, this.opts).then((read) => {
      if (this.disposed) return;
      const prev = this.cache.get(repoDir);
      this.evictIfNeeded();
      this.cache.set(repoDir, {
        byBranch: read.byBranch,
        ok: read.ok,
        at: this.now(),
      });
      if (!read.ok && !this.reported.has(repoDir)) {
        this.reported.add(repoDir);
        // ONE line, ever, per repository per window. No modal and no toast: `gh`
        // being absent is not an error the user made.
        log(
          'pr: no pull requests for',
          repoDir,
          '—',
          read.detail === '' ? 'gh unavailable' : firstLine(read.detail),
        );
      }
      if (read.ok && this.reported.has(repoDir)) {
        // It works now (`gh auth login` happened, a remote was added). Cleared so
        // a later failure is reported again rather than swallowed forever.
        this.reported.delete(repoDir);
      }
      if (!samePullRequests(prev?.byBranch, read.byBranch)) this.emit();
    });

    const entry = this.cache.get(repoDir);
    if (entry) entry.inFlight = task;
    else {
      this.cache.set(repoDir, {
        byBranch: new Map(),
        ok: true,
        at: 0,
        inFlight: task,
      });
    }

    return task.finally(() => {
      const e = this.cache.get(repoDir);
      if (e && e.inFlight === task) delete e.inFlight;
    });
  }

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
        // A listener that throws must not take the cache down with it.
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.cache.clear();
    this.reported.clear();
  }
}

function firstLine(s: string): string {
  const line = s.split(/\r?\n/, 1)[0]?.trim() ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** What decides whether a landed probe is worth a repaint. Compares only the
 *  fields a row draws or hovers, so a title edit still counts (it is in the
 *  hover) and nothing else in the json does. */
function samePullRequests(
  a: Map<string, PullRequest> | undefined,
  b: Map<string, PullRequest>,
): boolean {
  if (a === undefined) return false;
  if (a.size !== b.size) return false;
  for (const [branch, pr] of b) {
    const prev = a.get(branch);
    if (
      prev === undefined ||
      prev.number !== pr.number ||
      prev.state !== pr.state ||
      prev.checks !== pr.checks ||
      prev.title !== pr.title ||
      prev.url !== pr.url
    ) {
      return false;
    }
  }
  return true;
}
