// src/daemon.ts — the CLI daemon's dispatch roster, the one place a native
// /fork records its parentage.
//
// THE PROBLEM THIS FILE EXISTS TO FIX: `/fork` typed inside a session leaves
// NO marker in the child's transcript. Verified on this machine (CLI 2.1.207–
// 2.1.220): every line of a /fork child's transcript is rewritten to the
// child's own id, and no `forkedFrom` record is written anywhere in the file —
// unlike the extension's own `--fork-session --resume P --session-id C`
// launches, whose transcripts do carry the marker. So a /fork child used to
// render as a FLAT ROOT wearing its parent's copied title: a duplicate-looking
// row with its lineage thrown away.
//
// The one place the parentage exists on disk is the daemon's own dispatch
// roster, `~/.claude/daemon/roster.json`:
//
//   workers[<short>].dispatch.launch = {
//     mode: "resume",
//     sessionId: "<abs path>/<PARENT-uuid>.jsonl",   // what was resumed
//     fork: true,                                    // ... as a fork
//   }
//   workers[<short>].sessionId = "<CHILD-uuid>"
//
// That record is written by the CLI itself when it dispatches the fork — it is
// a dispatch log, not an inference, so an edge read from it is EXACT in the
// same sense a minted edge is. It is also EPHEMERAL (the roster holds current
// workers and is rewritten by the daemon), which is why extension.ts PERSISTS
// each observed edge into the editorial store as `parentSource: 'daemon'`
// rather than re-deriving it every tick: once the daemon forgets the worker,
// the persisted record is all that keeps the fork nested under its parent.
//
// `mode: "resume"` WITHOUT `fork` is the other useful fact: the daemon resumed
// an old conversation under a new id — exactly the generation-chain signal,
// from a source that (unlike the transcript-head heuristic) also covers
// successors that copy nothing.
//
// TWO REGRESSIONS THIS FILE ALSO FIXES, both verified on CLI 2.1.220:
//
//  1. THE ROSTER IS PER-ACCOUNT, NOT PER-MACHINE. Every account has its own
//     `CLAUDE_CONFIG_DIR`, and the daemon writes its roster INSIDE that dir.
//     A session running on a non-default account dispatches into
//     `<configDir>/daemon/roster.json`, and this reader — which hardcoded
//     `~/.claude/daemon/roster.json` — never saw it. Every /fork from a
//     non-default account rendered as a flat root. The reader now takes a
//     LIST of roster paths (the machine default plus one per account) and
//     merges their facts.
//
//  2. `/fork` NOW DISPATCHES A BACKGROUND JOB, whose `launch.sessionId` names
//     a COPY of the parent transcript with the uuid scrubbed out of the path:
//     `<configDir>/jobs/<short>/tmp/parent-transcript.jsonl`. `resumedIdOf`
//     correctly refuses to guess from that, so the launch record alone leaves
//     a background-job fork with no parent at all. Two other records name the
//     parent EXACTLY, and this file now reads both:
//       * `dispatch.env.CLAUDE_CODE_RESUME_SOURCE_ALIVE` —
//         `"<child>|<ISO boundary>|<PARENT>"`, right there in the dispatch.
//       * `<configDir>/jobs/<short>/state.json` — `forkParentSessionId`,
//         alongside `forkSessionId`, the job's name, cwd, and whether a
//         terminal has ever attached to it (`firstTerminalAt`).
//     Neither is an inference; both are the CLI's own dispatch bookkeeping.
//
// Dependencies are deliberately minimal — ./types, ./log and node builtins,
// never vscode — so this module stays unit-testable outside the editor.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { log, logError } from './log';
import {
  SESSION_ID_RE,
  isSessionId,
  shortId,
  type BackgroundJob,
} from './types';

/** One dispatch record the daemon roster knows about. */
export interface DaemonDispatch {
  /** The worker's own session id — the CHILD of a fork dispatch. */
  sessionId: string;
  /** The session the dispatch resumed (parent for a fork, predecessor for a
   *  plain resume). Absent when the launch names nothing uuid-shaped. */
  resumedId?: string;
  /** launch.fork === true — the dispatch was a /fork (or equivalent). */
  fork: boolean;
  /** launch.mode, verbatim ('resume', 'new', …). */
  mode?: string;
  /** `dispatch.short` — the job directory's name under `<configDir>/jobs/`.
   *  The handle a background job's `state.json` is found by. */
  short?: string;
}

export interface DaemonFacts {
  /** child id → parent id, for fork dispatches. */
  forkParents: ReadonlyMap<string, string>;
  /** new id → predecessor id, for plain-resume dispatches whose worker wears
   *  a DIFFERENT id than the transcript it resumed — the chain re-key. */
  resumeContinuations: ReadonlyMap<string, string>;
  /** session id → the background job holding it, for jobs no terminal owns. */
  jobs: ReadonlyMap<string, BackgroundJob>;
}

const EMPTY_FACTS: DaemonFacts = {
  forkParents: new Map(),
  resumeContinuations: new Map(),
  jobs: new Map(),
};

/** The roster inside one account's config dir. Every account has its own
 *  `CLAUDE_CONFIG_DIR`, and the daemon writes its roster under it. */
export function daemonRosterPathFor(configDir: string): string {
  return path.join(configDir, 'daemon', 'roster.json');
}

export function defaultDaemonRosterPath(): string {
  return daemonRosterPathFor(path.join(os.homedir(), '.claude'));
}

/** `<configDir>/daemon/roster.json` → `<configDir>/jobs`. Derived from the
 *  roster path rather than passed separately so a caller that knows only where
 *  the roster is (every caller, and every test) also gets the job states. */
export function jobsDirForRosterPath(rosterPath: string): string {
  return path.join(path.dirname(path.dirname(rosterPath)), 'jobs');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The uuid a launch.sessionId names. The observed value is an ABSOLUTE
 * TRANSCRIPT PATH (`…/<uuid>.jsonl`); a bare uuid is accepted too, because the
 * field's shape is the CLI's to change and the uuid is all we ever wanted.
 * Anything else — including a path whose basename is not uuid-shaped — yields
 * undefined rather than a guessed edge.
 */
export function resumedIdOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  if (SESSION_ID_RE.test(raw)) return raw;
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? '';
  const stem = base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : base;
  return isSessionId(stem) ? stem : undefined;
}

/**
 * The parent named by `CLAUDE_CODE_RESUME_SOURCE_ALIVE`, the env var the CLI
 * stamps on a fork dispatch so the child knows its source is still running.
 * Observed shape: `"<child>|<ISO boundary>|<PARENT>"`.
 *
 * Read by CONTENT, not by position: every `|`-separated field that is
 * uuid-shaped and is not the worker's own id is a candidate, and a parent is
 * returned only when EXACTLY ONE remains. A future field order, an extra
 * field, or a second uuid therefore degrades to `undefined` — no edge —
 * rather than to a confidently wrong edge.
 */
export function parentFromResumeSourceAlive(
  raw: unknown,
  ownId: string,
): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const others = new Set<string>();
  for (const part of raw.split('|')) {
    const token = part.trim();
    if (!isSessionId(token) || token === ownId) continue;
    others.add(token);
  }
  if (others.size !== 1) return undefined;
  const [only] = others;
  return only;
}

/**
 * Pull every dispatch out of a parsed roster blob. Pure and tolerant: every
 * field except the worker's own uuid-shaped sessionId is optional, unknown
 * shapes are skipped, and nothing here throws.
 */
export function parseDaemonRoster(raw: unknown): DaemonDispatch[] {
  const out: DaemonDispatch[] = [];
  if (!isPlainObject(raw)) return out;
  const workers = raw['workers'];
  if (!isPlainObject(workers)) return out;

  for (const worker of Object.values(workers)) {
    if (!isPlainObject(worker)) continue;
    const sessionId = worker['sessionId'];
    if (!isSessionId(sessionId)) continue;

    const dispatch = isPlainObject(worker['dispatch']) ? worker['dispatch'] : {};
    const launch = isPlainObject(dispatch['launch']) ? dispatch['launch'] : {};

    const entry: DaemonDispatch = {
      sessionId,
      fork: launch['fork'] === true,
    };
    const mode = launch['mode'];
    if (typeof mode === 'string' && mode.length > 0) entry.mode = mode;
    const short = dispatch['short'];
    if (typeof short === 'string' && short.length > 0) entry.short = short;

    // Preferred: the launch names the parent transcript by uuid. Fallback: a
    // background job's launch names a SCRUBBED copy of it, and the parent
    // survives only in the dispatch env. Both are dispatch records; neither is
    // an inference, so the fallback is exact in the same sense the first is.
    const resumed =
      resumedIdOf(launch['sessionId']) ??
      (isPlainObject(dispatch['env'])
        ? parentFromResumeSourceAlive(
            dispatch['env']['CLAUDE_CODE_RESUME_SOURCE_ALIVE'],
            sessionId,
          )
        : undefined);
    // A self-reference is a plain keep-the-id resume — no edge in it.
    if (resumed !== undefined && resumed !== sessionId) {
      entry.resumedId = resumed;
    }
    out.push(entry);
  }
  return out;
}

/**
 * Job states the CLI is still RUNNING in, as opposed to the ones it has
 * finished in (`done`, `failed`, `stopped` — all observed on this machine).
 * `blocked` is live and belongs here: it is what a `/fork` parked on "send a
 * prompt to start" reports, which is the single most adoptable job there is.
 */
const LIVE_JOB_STATES = new Set(['working', 'blocked']);

/**
 * One background job's `state.json`, read off disk. Never throws: a missing
 * file, a torn write and an unknown shape all yield undefined, because a job
 * we cannot read is exactly a job we must not claim to know anything about.
 */
export function readJobState(
  jobsDir: string,
  short: string,
  configDir: string,
): BackgroundJob | undefined {
  if (typeof short !== 'string' || short.length === 0) return undefined;
  // `short` comes from the roster and becomes a path segment; anything with a
  // separator or a dot-dot in it is refused rather than resolved.
  if (!/^[A-Za-z0-9_-]+$/.test(short)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(
      fs.readFileSync(path.join(jobsDir, short, 'state.json'), 'utf8'),
    );
  } catch {
    return undefined; // no such job, or a write we caught mid-flight
  }
  if (!isPlainObject(raw)) return undefined;

  const sessionId = raw['forkSessionId'] ?? raw['sessionId'];
  if (!isSessionId(sessionId)) return undefined;

  const job: BackgroundJob = {
    sessionId,
    configDir,
    short,
    // `firstTerminalAt` is null until something attaches a pty. A job that has
    // never had one is unowned, which is the whole precondition for adopting
    // it; anything non-null means somebody else is already driving.
    attached: raw['firstTerminalAt'] != null,
    live: LIVE_JOB_STATES.has(String(raw['state'] ?? '')),
  };
  const parentId = raw['forkParentSessionId'];
  if (isSessionId(parentId) && parentId !== sessionId) job.parentId = parentId;
  const name = raw['name'];
  if (typeof name === 'string' && name.trim() !== '') job.name = name.trim();
  const cwd = raw['cwd'];
  if (typeof cwd === 'string' && cwd !== '') job.cwd = cwd;
  return job;
}

/**
 * Fold dispatches (and any background-job states read alongside them) into the
 * maps the extension consumes.
 *
 * A job's `forkParentSessionId` is used only when the dispatch itself named no
 * parent: the roster is the CLI's live bookkeeping and the job state is its
 * on-disk copy, so where they disagree the live one wins.
 */
export function factsOf(
  dispatches: readonly DaemonDispatch[],
  jobs: readonly BackgroundJob[] = [],
): DaemonFacts {
  const forkParents = new Map<string, string>();
  const resumeContinuations = new Map<string, string>();
  for (const d of dispatches) {
    if (d.resumedId === undefined) continue;
    if (d.fork) forkParents.set(d.sessionId, d.resumedId);
    else if (d.mode === 'resume') {
      resumeContinuations.set(d.sessionId, d.resumedId);
    }
  }

  const jobMap = new Map<string, BackgroundJob>();
  for (const job of jobs) {
    jobMap.set(job.sessionId, job);
    if (job.parentId === undefined) continue;
    if (forkParents.has(job.sessionId)) continue; // the roster already said
    forkParents.set(job.sessionId, job.parentId);
  }

  // …and the other direction. A `/fork` whose launch path DID name the parent
  // uuid gets its edge from the roster, and its `state.json` then carries no
  // `forkParentSessionId` at all (observed: the roster and the job state are
  // written by different code paths and only one of them records the fork).
  // Backfilling here is what lets the adopt path treat every job the same:
  // it asks the job for its parent and never has to consult two sources.
  for (const [childId, job] of jobMap) {
    if (job.parentId !== undefined) continue;
    const parentId = forkParents.get(childId);
    if (parentId === undefined) continue;
    jobMap.set(childId, { ...job, parentId });
  }

  return { forkParents, resumeContinuations, jobs: jobMap };
}

/** Where the rosters are. A function rather than a fixed list because the set
 *  of accounts — and so the set of config dirs — changes while we run. */
export type RosterPathSource =
  | string
  | readonly string[]
  | (() => readonly string[]);

function resolvePaths(source: RosterPathSource): string[] {
  const raw = typeof source === 'function' ? source() : source;
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  for (const p of list) {
    if (typeof p === 'string' && p.length > 0) seen.add(p);
  }
  return [...seen];
}

/** Per-roster read state, so one account's torn write cannot invalidate
 *  another's cached facts. */
interface RootState {
  mtimeMs: number;
  size: number;
  dispatches: DaemonDispatch[];
  jobs: BackgroundJob[];
  loggedMissing: boolean;
}

/**
 * Reads every daemon roster that matters — `~/.claude/daemon/roster.json` plus
 * one per account config dir — cached by (mtimeMs, size) per file so the
 * steady state is one stat each per tick. Never throws: a missing daemon,
 * an unreadable file or a torn write all keep that root's LAST GOOD facts,
 * because a broken read must not un-parent rows that were correct a tick ago.
 *
 * For each roster that DID change, the background jobs it references are
 * re-read from `<configDir>/jobs/<short>/state.json` — bounded by the number
 * of live workers, not by the number of jobs ever run.
 */
export class DaemonRosterReader {
  private readonly source: RosterPathSource;
  private readonly roots = new Map<string, RootState>();
  private lastFacts: DaemonFacts = EMPTY_FACTS;
  private lastSignature = '';
  private lastPathsKey = '';

  constructor(rosterPath?: RosterPathSource) {
    this.source = rosterPath ?? defaultDaemonRosterPath();
  }

  read(): DaemonFacts {
    let paths: string[];
    try {
      paths = resolvePaths(this.source);
    } catch (err) {
      logError('daemon.paths', err);
      return this.lastFacts;
    }
    if (paths.length === 0) return this.lastFacts;

    // Identity stability matters: read() runs on every roster tick and on
    // every focus, and callers are entitled to `===` when nothing moved.
    // Rebuild the facts only when some roster actually changed, or when the
    // set of rosters itself did.
    const pathsKey = paths.join('\n');
    let changed = pathsKey !== this.lastPathsKey;
    this.lastPathsKey = pathsKey;
    for (const rosterPath of paths) {
      if (this.readRoot(rosterPath)) changed = true;
    }
    // Drop state for rosters that left the list (an account was deleted), so
    // a stale account's edges stop being republished every tick.
    for (const known of [...this.roots.keys()]) {
      if (!paths.includes(known)) {
        this.roots.delete(known);
        changed = true;
      }
    }
    if (!changed) return this.lastFacts;

    const dispatches: DaemonDispatch[] = [];
    const jobs: BackgroundJob[] = [];
    for (const rosterPath of paths) {
      const state = this.roots.get(rosterPath);
      if (!state) continue;
      dispatches.push(...state.dispatches);
      jobs.push(...state.jobs);
    }
    const facts = factsOf(dispatches, jobs);

    // Log only when the answer actually changed — read() runs every tick.
    const signature = `${facts.forkParents.size}/${facts.resumeContinuations.size}/${facts.jobs.size}`;
    if (signature !== this.lastSignature) {
      this.lastSignature = signature;
      if (
        facts.forkParents.size > 0 ||
        facts.resumeContinuations.size > 0 ||
        facts.jobs.size > 0
      ) {
        log(
          `daemon: ${facts.forkParents.size} fork edge(s), ` +
            `${facts.resumeContinuations.size} resume continuation(s), ` +
            `${facts.jobs.size} background job(s) across ${paths.length} roster(s)`,
        );
      }
    }
    this.lastFacts = facts;
    return facts;
  }

  /**
   * Refresh one roster's cached state in place. Failures leave it untouched.
   * Returns whether the cached state actually moved — the caller uses that to
   * decide whether the merged facts need rebuilding at all.
   */
  private readRoot(rosterPath: string): boolean {
    let state = this.roots.get(rosterPath);
    if (!state) {
      state = {
        mtimeMs: -1,
        size: -1,
        dispatches: [],
        jobs: [],
        loggedMissing: false,
      };
      this.roots.set(rosterPath, state);
    }

    let st: fs.Stats;
    try {
      st = fs.statSync(rosterPath);
    } catch {
      // No daemon under this config dir (older CLI, or it never ran). Normal.
      if (!state.loggedMissing) {
        log('daemon: no roster at', rosterPath);
        state.loggedMissing = true;
      }
      // A roster that DISAPPEARS drops its facts: the daemon is gone, and
      // republishing its last workers forever would keep dead edges alive.
      if (state.dispatches.length > 0 || state.jobs.length > 0) {
        state.mtimeMs = -1;
        state.size = -1;
        state.dispatches = [];
        state.jobs = [];
        return true;
      }
      return false;
    }
    if (st.mtimeMs === state.mtimeMs && st.size === state.size) return false;

    try {
      const raw: unknown = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
      const dispatches = parseDaemonRoster(raw);
      const jobsDir = jobsDirForRosterPath(rosterPath);
      const configDir = path.dirname(path.dirname(rosterPath));
      const jobs: BackgroundJob[] = [];
      for (const d of dispatches) {
        if (d.short === undefined) continue;
        const job = readJobState(jobsDir, d.short, configDir);
        if (job) jobs.push(job);
      }
      state.mtimeMs = st.mtimeMs;
      state.size = st.size;
      state.dispatches = dispatches;
      state.jobs = jobs;
      state.loggedMissing = false;
      return true;
    } catch (err) {
      // A torn write mid-read: keep the last good answer, try again next tick.
      logError('daemon.read', err);
      return false;
    }
  }
}

export function describeForkEdge(childId: string, parentId: string): string {
  return `${shortId(childId)} forked-from ${shortId(parentId)} (daemon)`;
}
