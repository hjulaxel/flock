// src/roster.ts — `claude agents --json` fetch / parse / normalise, claude
// binary discovery, and the polling loop.
//
// Dependencies are deliberately minimal — ./types, ./log and node builtins,
// never vscode — so this module stays unit-testable outside the editor.
//
// Design note: `claude agents --json` is an UNDOCUMENTED contract. Its help
// text says "for scripting", which implies intent, but the field set can churn
// between CLI releases — and the measured output already disagrees with itself
// row to row: `pid`, `id`, `status`, `waitingFor` and `state` are each absent
// on some real rows. So every field except `sessionId` is optional and
// defensively coerced, unrecognised shapes are dropped rather than trusted,
// and nothing here throws. The tree must degrade, never break.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as process from 'node:process';

import { log, logError } from './log';
import {
  DEFAULT_BUSY_STALE_MINUTES,
  isSessionId,
  type DisposableLike,
  type NodeAttention,
  type RosterEntry,
  type RosterResult,
  type SessionKind,
  type SessionStatus,
} from './types';

/** The ONLY argument vector we ever hand the claude binary. Returned fresh so
 *  a caller can never mutate a shared constant into something else. */
function rosterArgv(): string[] {
  return ['agents', '--json'];
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** `ps` budget for the warm-spare probe. Deliberately short: this runs on the
 *  poll path, and a hung `ps` must cost a filter pass, never a roster tick. */
const SPARE_PS_TIMEOUT_MS = 2000;

/** Backoff ceiling for a poller whose fetches keep failing. */
const MAX_BACKOFF_MS = 30_000;
/** Consecutive failures tolerated before the interval starts doubling. */
const BACKOFF_AFTER_FAILURES = 3;
/** pokeNow() coalescing window. */
const POKE_DEBOUNCE_MS = 500;

// ---------------------------------------------------------------- parsing

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A non-empty string, or undefined. Empty strings carry no information and
 *  would only produce blank labels / a bogus '' cwd group downstream. */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function normalizeKind(v: unknown): SessionKind | undefined {
  if (v === undefined) return undefined; // absent stays absent
  if (v === 'interactive' || v === 'background') return v;
  return 'unknown'; // present but unrecognised — a kind we don't know yet
}

interface ParseOutcome {
  ok: boolean;
  entries: RosterEntry[];
  error?: string;
}

function parseRosterDetailed(raw: string): ParseOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    // Empty stdout lands here too (JSON.parse('') throws) — that is a failed
    // call, not an empty roster, so the caller keeps its last good snapshot.
    logError('roster: `claude agents --json` stdout is not JSON', err);
    return { ok: false, entries: [], error: 'roster stdout is not JSON' };
  }
  if (!Array.isArray(parsed)) {
    // Valid JSON of an unexpected shape: the CLI answered, so this is not a
    // transport failure — `ok: false` is reserved for a throw.
    log('roster: expected a JSON array, got', typeof parsed);
    return { ok: true, entries: [] };
  }

  const entries: RosterEntry[] = [];
  const seen = new Set<string>();
  for (const element of parsed as unknown[]) {
    if (!isPlainObject(element)) {
      log('roster: dropping a non-object row');
      continue;
    }
    const sessionId = element['sessionId'];
    if (!isSessionId(sessionId)) {
      // Without a uuid sessionId a row cannot be keyed, bound to a terminal,
      // or joined to a transcript. It is noise.
      log('roster: dropping a row with no valid sessionId');
      continue;
    }
    if (seen.has(sessionId)) continue; // dedupe, first occurrence wins
    seen.add(sessionId);

    const entry: RosterEntry = { sessionId };

    const pid = element['pid'];
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
      entry.pid = pid;
    }
    const startedAt = element['startedAt'];
    if (typeof startedAt === 'number' && Number.isFinite(startedAt)) {
      entry.startedAt = startedAt;
    }
    const rosterId = str(element['id']);
    if (rosterId !== undefined) entry.rosterId = rosterId;
    const cwd = str(element['cwd']);
    if (cwd !== undefined) entry.cwd = cwd;
    const name = str(element['name']);
    if (name !== undefined) entry.name = name;
    const status = str(element['status']);
    if (status !== undefined) entry.status = status;
    const state = str(element['state']);
    if (state !== undefined) entry.state = state;
    const waitingFor = str(element['waitingFor']);
    if (waitingFor !== undefined) entry.waitingFor = waitingFor;
    const kind = normalizeKind(element['kind']);
    if (kind !== undefined) entry.kind = kind;

    entries.push(entry);
  }
  return { ok: true, entries };
}

/**
 * Pure parse of `claude agents --json` stdout. Never throws; every deviation
 * is logged and the offending row dropped. Four rules, all enforced below:
 * guard JSON.parse, gate every row on a uuid `sessionId`, coerce every other
 * field defensively, and dedupe with the first occurrence winning.
 */
export function parseRoster(raw: string): RosterEntry[] {
  return parseRosterDetailed(raw).entries;
}

/**
 * Decision table (first match wins):
 * waiting/blocked -> waiting+waiting; busy/working/running -> busy+none;
 * idle -> idle+none; otherwise unknown+none.
 *
 * `status` and `state` are two independent, partially populated fields in the
 * real data (a row can carry `state: "blocked"` and no `status` at all), so
 * both are consulted and neither is required.
 */
export function normalizeStatus(e: RosterEntry): {
  status: SessionStatus;
  attention: NodeAttention;
} {
  if (!e) return { status: 'unknown', attention: 'none' };
  const status =
    typeof e.status === 'string' ? e.status.trim().toLowerCase() : '';
  const state = typeof e.state === 'string' ? e.state.trim().toLowerCase() : '';

  if (status === 'waiting' || state === 'blocked') {
    return { status: 'waiting', attention: 'waiting' };
  }
  if (
    status === 'busy' ||
    status === 'working' ||
    state === 'running' ||
    state === 'working'
  ) {
    return { status: 'busy', attention: 'none' };
  }
  if (status === 'idle') return { status: 'idle', attention: 'none' };
  return { status: 'unknown', attention: 'none' };
}

// -------------------------------------------------------- frozen "busy"

/**
 * True when a row is REPORTED as running: the exact predicate normalizeStatus's
 * busy branch matches (busy/working status, or running/working state), and NOT
 * a waiting/blocked row, which wins ahead of it in both decision tables and is
 * never reclassified. Exported so RosterFilter can pay the transcript stat for
 * these rows only.
 */
export function reportsBusy(entry: RosterEntry | null | undefined): boolean {
  if (!entry) return false;
  const status =
    typeof entry.status === 'string' ? entry.status.trim().toLowerCase() : '';
  const state =
    typeof entry.state === 'string' ? entry.state.trim().toLowerCase() : '';
  if (status === 'waiting' || state === 'blocked') return false;
  return (
    status === 'busy' ||
    status === 'working' ||
    state === 'running' ||
    state === 'working'
  );
}

/**
 * Correct a FROZEN "busy" in the roster.
 *
 * `claude agents --json` is a live registry but not a clean one (see the
 * phantom-row note below): a row's status can freeze "at whatever the session
 * was doing when it let go". The commonest LIVE instance is an interactive
 * session that finished its turn — the process is still up, so it is no
 * phantom, but its `status` is stuck at `busy` and the tree paints a running
 * (amber) dot on a session that is plainly done.
 *
 * The independent, hook-free tell is the transcript: a genuinely working
 * session appends to its `.jsonl` within seconds (assistant tokens, tool
 * results), so a `busy` row whose transcript has been untouched for MINUTES is
 * stale. When it is, the reported status is rewritten to `idle` — the honest
 * "alive but doing nothing", the very value a normally-finished interactive
 * session already reports. Never to `waiting`: that raises an attention badge,
 * and we have no evidence the session wants you, only that it is not running.
 *
 * Rewriting the raw `status`/`state` FIELDS (not a derived value) means both
 * decision tables — normalizeStatus here and the deliberately-duplicated
 * deriveStatus in lineage.ts — reach `idle` unchanged, so the two cannot drift.
 *
 * Conservative by construction: only rows that reportsBusy() are eligible, and
 * only when the transcript mtime is KNOWN and older than `staleMs`. A missing
 * mtime (no transcript located) leaves the row exactly as the CLI reported it
 * — the safe direction is to keep the CLI's claim, never to invent one. Returns
 * a CLONE when it changes anything; the input row is never mutated, because the
 * poller compares it against the previous tick for change detection.
 */
export function destaleBusyStatus(
  entry: RosterEntry,
  transcriptMtimeMs: number | null,
  now: number,
  staleMs: number,
): RosterEntry {
  if (!reportsBusy(entry)) return entry;
  if (
    transcriptMtimeMs === null ||
    !Number.isFinite(transcriptMtimeMs) ||
    !Number.isFinite(now) ||
    !Number.isFinite(staleMs) ||
    staleMs <= 0
  ) {
    return entry;
  }
  if (now - transcriptMtimeMs < staleMs) return entry;

  const next: RosterEntry = { ...entry, status: 'idle' };
  // Clear only a busy-INDUCING state, so it cannot re-trigger the busy branch;
  // any other state string carries its own meaning and is left intact.
  const state =
    typeof entry.state === 'string' ? entry.state.trim().toLowerCase() : '';
  if (state === 'running' || state === 'working') delete next.state;
  return next;
}

// ----------------------------------------------------------- phantom rows

/**
 * `claude agents --json` is a LIVE registry, but it is not a CLEAN one. Two
 * kinds of row in it are not sessions at all, and neither can ever be focused,
 * forked, resumed or closed from the tree:
 *
 *  1. **Rows the CLI never reaped.** A row whose `pid` is absent, or names a
 *     process that no longer exists. Measured on the author's machine: one
 *     such row 14 days old, still rendering as a live idle session — and it
 *     was the row the user kept clicking, which offered a fork and produced
 *     four live children hanging off a parent that had not existed for a
 *     fortnight.
 *  2. **Daemon warm-spares.** `claude bg-spare --bg-spare <socket>` is a
 *     pre-forked process waiting to be CLAIMED by a session that does not
 *     exist yet. The CLI registers it anyway, with a session id, a `name`
 *     inherited from whoever used the pool last, and a status frozen at
 *     whatever that session was doing when it let go. Measured: a spare 16
 *     days old still reporting `status: "waiting", waitingFor: "dialog open"`
 *     — a permanent attention badge on the view, pointing at a non-session.
 *
 * Dropping (1) loses nothing: a dead session that has a transcript is exactly
 * what the archive renders, and it belongs there — dimmed, sorted below the
 * live rows, resumable — rather than masquerading as running.
 */

/**
 * Liveness probe. `kill(pid, 0)` sends no signal; it only asks the kernel
 * whether the pid exists and whether we would be allowed to signal it. EPERM
 * therefore means "exists, but owned by another user", which is still alive.
 * No spawn, no allocation — cheap enough for the 3 s poll path.
 */
export function isProcessAlive(pid: number): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: unknown } | null)?.code === 'EPERM';
  }
}

/**
 * True for a daemon warm-spare's command line.
 *
 * Matched on the `--bg-spare` FLAG rather than the bare `bg-spare` subcommand
 * token, because a flag cannot collide with a directory name or a word in a
 * prompt the way a bare token can. If a future CLI stops passing the flag this
 * predicate simply goes quiet and the spare row comes back — the same
 * behaviour as before the filter existed. The failure direction is always
 * "renders one row too many", never "silently drops a real session".
 */
export function isSpareCommand(command: string): boolean {
  return (
    typeof command === 'string' && /(^|\s)--bg-spare(=|\s|$)/.test(command)
  );
}

/**
 * `pid -> command line` for a batch of pids, in ONE `ps`. Never rejects; a pid
 * `ps` could not describe is simply absent from the map.
 */
export function psCommands(
  pids: readonly number[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  // No `ps` contract on Windows — the filter's spare branch does not exist
  // there, exactly like the argv walk in lineage.ts.
  if (process.platform === 'win32' || pids.length === 0) {
    return Promise.resolve(out);
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve(out);
    };
    try {
      execFile(
        'ps',
        ['-ww', '-o', 'pid=,command=', '-p', pids.join(',')],
        { timeout: SPARE_PS_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        (_err, stdout) => {
          // `ps` exits non-zero when NONE of the pids exist, but still prints
          // the ones that do — so the output is parsed regardless of `err`.
          const text = typeof stdout === 'string' ? stdout : '';
          for (const line of text.split('\n')) {
            const m = /^\s*(\d+)\s+(\S[\s\S]*)$/.exec(line);
            if (!m) continue;
            const pid = Number.parseInt(m[1], 10);
            if (Number.isFinite(pid)) out.set(pid, m[2]);
          }
          done();
        },
      );
    } catch {
      done();
    }
  });
}

export interface RosterFilterIO {
  isAlive?: (pid: number) => boolean;
  psCommands?: (pids: readonly number[]) => Promise<Map<number, string>>;
  /** Transcript mtime (epoch ms) for a session, or null when none is located.
   *  Injected rather than imported: roster.ts deliberately does not depend on
   *  ./transcript, so the composition root wires the real locator in. Absent →
   *  a filter that never destales, i.e. the behaviour before the fix. */
  transcriptMtime?: (sessionId: string) => number | null;
  /** Clock, injectable for tests. Default Date.now. */
  now?: () => number;
  /** Silence window (ms) before a reported-busy row is treated as stale, read
   *  FRESH every pass so a config change takes effect on the next tick. */
  busyStaleMs?: () => number;
}

/**
 * Drops phantom rows from a parsed roster. Stateful only for caching, and
 * never throws: any failure returns the input unchanged, so the worst outcome
 * is the pre-filter tree.
 */
export class RosterFilter {
  private readonly isAlive: (pid: number) => boolean;
  private readonly ps: (
    pids: readonly number[],
  ) => Promise<Map<number, string>>;
  /** pid -> is-a-warm-spare. A process cannot rewrite its own argv, so one
   *  verdict holds for the life of the pid; entries are evicted the moment
   *  their pid leaves the roster, so a recycled pid never inherits one. */
  private readonly spare = new Map<number, boolean>();
  /** Ids already reported as dropped — a 3 s poll must not spam the channel. */
  private readonly announced = new Set<string>();
  /** Ids currently rewritten from a frozen `busy` to `idle`. Logged once on
   *  entry, cleared when the row recovers or leaves the roster, so a genuine
   *  busy→stale→busy→stale cycle each announces once. */
  private readonly destaled = new Set<string>();
  private readonly transcriptMtime: (sessionId: string) => number | null;
  private readonly now: () => number;
  private readonly busyStaleMs: () => number;

  constructor(io?: RosterFilterIO) {
    this.isAlive = io?.isAlive ?? isProcessAlive;
    this.ps = io?.psCommands ?? psCommands;
    this.transcriptMtime = io?.transcriptMtime ?? (() => null);
    this.now = io?.now ?? Date.now;
    this.busyStaleMs =
      io?.busyStaleMs ?? (() => DEFAULT_BUSY_STALE_MINUTES * 60_000);
  }

  async apply(entries: RosterEntry[]): Promise<RosterEntry[]> {
    const rows = Array.isArray(entries) ? entries : [];
    const pids = rows
      .map((e) => e.pid)
      .filter((p): p is number => typeof p === 'number');
    try {
      // Cache maintenance runs on EVERY tick, including the ones that return
      // early below. Both of those are exactly the ticks where pids leave the
      // roster, and skipping eviction there breaks this class's own invariant
      // ("a recycled pid never inherits a verdict"): a spare verdict left
      // behind would silently filter out a real session that later lands on
      // the same pid.
      if (rows.length === 0) return entries;

      // If NOT ONE row carries a pid, this CLI build does not report pids at
      // all. Liveness is then unknowable, and filtering on it would empty the
      // tree — so the whole filter stands down rather than guess.
      if (pids.length === 0) return entries;

      await this.classify(pids);

      const kept: RosterEntry[] = [];
      for (const entry of rows) {
        const why = this.reject(entry);
        if (why === null) {
          kept.push(entry);
          continue;
        }
        if (!this.announced.has(entry.sessionId)) {
          this.announced.add(entry.sessionId);
          log('roster: dropping', entry.sessionId.slice(0, 8), '—', why);
        }
      }
      // The surviving rows are real sessions; correct any whose `busy` has gone
      // stale (a finished session the CLI never flipped back to idle).
      return this.destale(kept);
    } catch (err) {
      // Degrade toward rendering MORE, never toward a blank tree.
      logError('roster: phantom filter failed', err);
      return entries;
    } finally {
      this.forget(rows, pids);
    }
  }

  /**
   * Rewrite a frozen `busy` to `idle` for any kept row whose transcript has
   * been silent past the window (see destaleBusyStatus). One clock read and one
   * transcript stat per REPORTED-busy row — never for the quiet majority. A row
   * with no transcript signal, or one written recently, is returned untouched.
   */
  private destale(kept: RosterEntry[]): RosterEntry[] {
    const staleMs = this.busyStaleMs();
    if (!Number.isFinite(staleMs) || staleMs <= 0) return kept; // disabled
    const now = this.now();
    let changed = false;
    const out = kept.map((entry) => {
      if (!reportsBusy(entry)) return entry;
      const fixed = destaleBusyStatus(
        entry,
        this.transcriptMtime(entry.sessionId),
        now,
        staleMs,
      );
      if (fixed === entry) {
        this.destaled.delete(entry.sessionId); // still genuinely busy
        return entry;
      }
      changed = true;
      if (!this.destaled.has(entry.sessionId)) {
        this.destaled.add(entry.sessionId);
        log(
          'roster: destaling',
          entry.sessionId.slice(0, 8),
          '— busy but transcript silent',
        );
      }
      return fixed;
    });
    return changed ? out : kept;
  }

  private reject(entry: RosterEntry): string | null {
    if (entry.pid === undefined) {
      return 'no pid — the CLI never reaped this row';
    }
    if (!this.isAlive(entry.pid)) return `pid ${entry.pid} is not running`;
    if (this.spare.get(entry.pid) === true) {
      return `pid ${entry.pid} is a claude bg-spare, not a session`;
    }
    return null;
  }

  private async classify(pids: readonly number[]): Promise<void> {
    const unknown = [...new Set(pids)].filter(
      (pid) => !this.spare.has(pid) && this.isAlive(pid),
    );
    if (unknown.length === 0) return;
    const commands = await this.ps(unknown);
    for (const pid of unknown) {
      const command = commands.get(pid);
      // A pid `ps` could not describe stays UNCLASSIFIED rather than being
      // recorded as "not a spare": a transient ps failure must not permanently
      // whitelist a spare. The row renders in the meantime, which is the safe
      // direction to be wrong in.
      if (command === undefined) continue;
      this.spare.set(pid, isSpareCommand(command));
    }
  }

  private forget(
    entries: readonly RosterEntry[],
    pids: readonly number[],
  ): void {
    const live = new Set(pids);
    for (const pid of [...this.spare.keys()]) {
      if (!live.has(pid)) this.spare.delete(pid);
    }
    const ids = new Set(entries.map((e) => e.sessionId));
    for (const id of [...this.announced]) {
      if (!ids.has(id)) this.announced.delete(id);
    }
    for (const id of [...this.destaled]) {
      if (!ids.has(id)) this.destaled.delete(id);
    }
  }
}

// ---------------------------------------------------------------- fetching

export interface FetchRosterOptions {
  claudeBin?: string; // default 'claude'
  timeoutMs?: number; // default 10_000
  /** Run the fetch AS this config dir (`CLAUDE_CONFIG_DIR` in the child
   *  env). The agents registry is per config dir — the same isolation that
   *  keeps account logins apart keeps their live rosters apart — so a tree
   *  that only ever asks the default dir simply cannot see a session running
   *  on a custom account. Absent = inherit, i.e. the default dir. */
  configDir?: string;
}

/** The child environment for a roster fetch. Exported for the test lane: the
 *  env is the entire mechanism, so its exact shape is the contract. With no dir
 *  the parent env is passed through UNTOUCHED — same object, not a copy — so
 *  the default fetch stays byte-identical to what it was before per-account
 *  config dirs existed. */
export function rosterEnvFor(configDir?: string): NodeJS.ProcessEnv {
  const dir = typeof configDir === 'string' ? configDir.trim() : '';
  if (dir === '') return process.env;
  return { ...process.env, CLAUDE_CONFIG_DIR: dir };
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : String(err);
}

/** True for a Windows batch shim. Since the CVE-2024-27980 fix (Node 18.20.2 /
 *  20.12.2, i.e. every host behind engines.vscode ^1.94) `execFile` refuses to
 *  spawn a .bat/.cmd directly and fails with EINVAL — and the npm install of
 *  the CLI puts exactly such a shim on PATH. */
function isWindowsShim(bin: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
}

/**
 * execFile(claudeBin, ['agents', '--json'], ...). NEVER rejects: any
 * spawn/timeout/parse failure resolves {ok:false, entries:[], error, tookMs}.
 * The argument vector is exactly ['agents', '--json'] — nothing else, ever.
 *
 * execFile, never a shell: a binary path with spaces or a hostile PATH entry
 * can then never become a command line. The environment is inherited because
 * the CLI needs it (config dir, credentials, proxy).
 *
 * ONE exception, on win32 only: a `.cmd`/`.bat` shim cannot be spawned
 * directly at all, so it goes through the command processor as
 * `cmd /d /s /c "<bin>" agents --json`. The argv is still exactly
 * ['agents','--json'] and `bin` is quoted, so nothing user-supplied can become
 * a second command; `windowsVerbatimArguments` keeps Node from re-quoting the
 * line we built.
 */
export function fetchRoster(opts?: FetchRosterOptions): Promise<RosterResult> {
  const bin =
    typeof opts?.claudeBin === 'string' && opts.claudeBin.length > 0
      ? opts.claudeBin
      : 'claude';
  const timeout =
    typeof opts?.timeoutMs === 'number' &&
    Number.isFinite(opts.timeoutMs) &&
    opts.timeoutMs > 0
      ? opts.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const started = Date.now();

  return new Promise<RosterResult>((resolve) => {
    let settled = false;
    const done = (r: RosterResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const fail = (error: string): void =>
      done({ ok: false, entries: [], error, tookMs: Date.now() - started });

    const shim = isWindowsShim(bin);
    const command = shim ? (process.env['ComSpec'] ?? 'cmd.exe') : bin;
    const argv = shim
      ? ['/d', '/s', '/c', `"${bin}" ${rosterArgv().join(' ')}`]
      : rosterArgv();

    try {
      execFile(
        command,
        argv,
        {
          timeout,
          maxBuffer: MAX_BUFFER_BYTES,
          env: rosterEnvFor(opts?.configDir),
          windowsHide: true,
          ...(shim ? { windowsVerbatimArguments: true } : {}),
        },
        (err, stdout) => {
          if (err) {
            const killed = (err as { killed?: boolean }).killed === true;
            fail(
              killed
                ? `claude agents --json timed out after ${timeout}ms`
                : errMessage(err),
            );
            return;
          }
          const parsed = parseRosterDetailed(
            typeof stdout === 'string' ? stdout : String(stdout ?? ''),
          );
          done({
            ok: parsed.ok,
            entries: parsed.entries,
            ...(parsed.error === undefined ? {} : { error: parsed.error }),
            tookMs: Date.now() - started,
          });
        },
      );
    } catch (err) {
      // execFile can throw synchronously (e.g. a non-string binary path).
      logError('roster: spawn failed', err);
      fail(errMessage(err));
    }
  });
}

/**
 * One roster across every account (fetchRoster × config dirs, merged).
 *
 * The default dir is ALWAYS fetched and always fetched FIRST in the merge
 * order: a session id can only appear once (they are uuids, but a defensive
 * dedupe costs nothing), and on a collision the default dir's row wins —
 * the same first-occurrence rule the archive scan applies to transcripts.
 *
 * Failure is per-dir: `ok` is true if ANY fetch succeeded, because a profile
 * dir erroring (deleted, never logged in, CLI hiccup) must degrade that
 * ACCOUNT's rows, not blank the whole tree. Errors from failed dirs are
 * joined into `error` so the log still names them. `tookMs` is wall clock —
 * the fetches run concurrently.
 *
 * `fetchImpl` is injectable for the test lane; production never passes it.
 */
export async function fetchRosterMulti(
  opts: FetchRosterOptions & { configDirs?: readonly string[] },
  fetchImpl: (o: FetchRosterOptions) => Promise<RosterResult> = fetchRoster,
): Promise<RosterResult> {
  const started = Date.now();
  const extra: string[] = [];
  const seenDirs = new Set<string>(['']); // '' = the default dir, always first
  for (const raw of opts?.configDirs ?? []) {
    const dir = typeof raw === 'string' ? raw.trim() : '';
    if (dir === '' || seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    extra.push(dir);
  }

  const base: FetchRosterOptions = {
    ...(opts?.claudeBin === undefined ? {} : { claudeBin: opts.claudeBin }),
    ...(opts?.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  };
  const results = await Promise.all([
    fetchImpl(base),
    ...extra.map((dir) => fetchImpl({ ...base, configDir: dir })),
  ]);

  const entries: RosterEntry[] = [];
  const seenIds = new Set<string>();
  const errors: string[] = [];
  let anyOk = false;
  for (const r of results) {
    if (r.ok) {
      anyOk = true;
      for (const entry of r.entries) {
        if (seenIds.has(entry.sessionId)) continue;
        seenIds.add(entry.sessionId);
        entries.push(entry);
      }
    } else if (typeof r.error === 'string' && r.error !== '') {
      errors.push(r.error);
    }
  }
  return {
    ok: anyOk,
    entries,
    ...(errors.length === 0 ? {} : { error: errors.join(' | ') }),
    tookMs: Date.now() - started,
  };
}

/** The machine facts CLI discovery reads. Injectable so the Windows and Linux
 *  answers are testable from a macOS laptop; production passes nothing and
 *  gets the real process. */
export interface DiscoveryWorld {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/**
 * Where the official installers put `claude` when it is NOT on the PATH the
 * extension host inherited — which is often: VS Code launched from the Dock
 * or a Snap never ran the shell profile that adds `~/.local/bin`, and a
 * Windows PATH edit made by an installer reaches only shells opened after it.
 * Ordered by how likely the hit is the CLI the person actually runs; every
 * entry is a directory a real installer writes to, nothing guessed:
 *
 *   ~/.local/bin                          the native installer, all platforms
 *                                         (claude.exe on Windows)
 *   %APPDATA%\npm                         npm's global bin on Windows — the
 *                                         claude.cmd shim
 *   %LOCALAPPDATA%\Microsoft\WinGet\Links WinGet's portable-package links
 *   ~/.claude/local                       the older `claude migrate-installer`
 *                                         location, still on many machines
 *   /opt/homebrew/bin, /usr/local/bin     Homebrew (arm64, x64), and npm's
 *                                         default global prefix
 *
 * Pure: a Windows without APPDATA set simply contributes fewer candidates.
 */
export function claudeFallbackBinDirs(world: DiscoveryWorld = {}): string[] {
  const platform = world.platform ?? process.platform;
  const env = world.env ?? process.env;
  const home = world.home ?? os.homedir();
  const out = [path.join(home, '.local', 'bin')];
  if (platform === 'win32') {
    const appData = env['APPDATA'];
    if (typeof appData === 'string' && appData !== '') out.push(path.join(appData, 'npm'));
    const local = env['LOCALAPPDATA'];
    if (typeof local === 'string' && local !== '') {
      out.push(path.join(local, 'Microsoft', 'WinGet', 'Links'));
    }
    return out;
  }
  out.push(path.join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin');
  return out;
}

/**
 * A non-empty `configured` value is returned verbatim (no existence check —
 * the user knows where their CLI is, and an over-eager check would reject a
 * shim we cannot stat). Otherwise scan PATH for an existing file named claude
 * (claude.exe/claude.cmd on win32), then the install roots the official
 * installers use (`claudeFallbackBinDirs`); first hit wins, else null.
 *
 * On win32 the NATIVE executable is preferred over the batch shim, and the
 * extension-less `claude` — the POSIX shell script npm drops next to the shim
 * — is not a candidate at all: Windows cannot execute it, so returning it
 * would only produce a spawn failure that reads as "the CLI is broken".
 */
export function findClaudeBinary(
  configured?: string,
  world: DiscoveryWorld = {},
): string | null {
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return configured;
  }
  const platform = world.platform ?? process.platform;
  const env = world.env ?? process.env;
  const names = platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const rawPath = env['PATH'] ?? env['Path'] ?? '';
  const dirs = rawPath.length > 0 ? rawPath.split(path.delimiter) : [];
  dirs.push(...claudeFallbackBinDirs(world));

  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.resolve(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // ENOENT / EACCES / broken symlink — try the next candidate.
      }
    }
  }
  return null;
}

// ------------------------------------------------------- change detection

/**
 * Stable, order-independent signature of a normalised roster. Two rosters
 * with the same signature are indistinguishable to the tree, so the caller
 * can skip a rebuild.
 *
 * The poller itself deliberately holds no roster state — caching is the
 * caller's job — so these helpers give the caller change detection without
 * smuggling a cache into the poller.
 */
export function rosterSignature(entries: RosterEntry[]): string {
  const rows = entries.map((e) =>
    [
      e.sessionId,
      e.pid ?? '',
      e.rosterId ?? '',
      e.cwd ?? '',
      e.kind ?? '',
      e.startedAt ?? '',
      e.name ?? '',
      e.status ?? '',
      e.state ?? '',
      e.waitingFor ?? '',
    ].join('\u0000'),
  );
  rows.sort();
  return rows.join('\u0001');
}

/** True when two rosters would render identically. */
export function sameRoster(a: RosterEntry[], b: RosterEntry[]): boolean {
  if (a.length !== b.length) return false;
  return rosterSignature(a) === rosterSignature(b);
}

// ---------------------------------------------------------------- polling

/**
 * setTimeout chain (never setInterval — a slow fetch must not overlap).
 * Backoff after 3 consecutive failures, doubling to a 30s ceiling, reset on
 * the first success. pokeNow() coalesces calls within 500 ms.
 *
 * The poller keeps no roster state: it hands every result to `onResult` and
 * lets the caller decide what changed (see `sameRoster`).
 */
export class RosterPoller implements DisposableLike {
  private readonly fetchFn: () => Promise<RosterResult>;
  private readonly onResult: (r: RosterResult) => void;
  private intervalMs: number;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private disposed = false;
  private inFlight = false;
  /** A poke that arrived while a fetch was in flight; run one more tick. */
  private pendingImmediate = false;
  private consecutiveFailures = 0;
  private lastPokeAt = 0;

  constructor(
    fetch: () => Promise<RosterResult>,
    onResult: (r: RosterResult) => void,
    intervalMs: number,
  ) {
    this.fetchFn = fetch;
    this.onResult = onResult;
    this.intervalMs = RosterPoller.sanitizeInterval(intervalMs, 3000);
  }

  private static sanitizeInterval(ms: number, fallback: number): number {
    return typeof ms === 'number' && Number.isFinite(ms) && ms > 0
      ? ms
      : fallback;
  }

  /** Start the loop and fetch immediately — the first paint of the tree must
   *  not wait a whole interval. Idempotent. */
  start(): void {
    if (this.disposed || this.running) return;
    this.running = true;
    void this.tick();
  }

  /** Suspend polling — called when the view is hidden. A later pokeNow() still
   *  works; only the timer chain stops. */
  stop(): void {
    this.running = false;
    this.clearTimer();
  }

  setIntervalMs(ms: number): void {
    const next = RosterPoller.sanitizeInterval(ms, this.intervalMs);
    if (next === this.intervalMs) return;
    this.intervalMs = next;
    // Re-arm against the new interval; an in-flight fetch re-schedules itself.
    if (this.running && !this.inFlight) {
      this.clearTimer();
      this.schedule();
    }
  }

  /** Immediate out-of-band poll, debounced 500 ms (hook events call this). */
  pokeNow(): void {
    if (this.disposed) return;
    const now = Date.now();
    if (now - this.lastPokeAt < POKE_DEBOUNCE_MS) return; // coalesced
    this.lastPokeAt = now;
    void this.tick();
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private effectiveInterval(): number {
    if (this.consecutiveFailures < BACKOFF_AFTER_FAILURES) {
      return this.intervalMs;
    }
    const doublings = this.consecutiveFailures - BACKOFF_AFTER_FAILURES + 1;
    return Math.min(this.intervalMs * Math.pow(2, doublings), MAX_BACKOFF_MS);
  }

  private schedule(): void {
    if (this.disposed || !this.running) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, this.effectiveInterval());
    // Never hold a host process open just for the poll timer.
    const t = this.timer as unknown as { unref?: () => void };
    if (typeof t?.unref === 'function') t.unref();
  }

  private async tick(): Promise<void> {
    if (this.disposed) return;
    if (this.inFlight) {
      // Never overlap fetches; remember that someone asked for a fresh one.
      this.pendingImmediate = true;
      return;
    }
    this.clearTimer();
    this.inFlight = true;

    let result: RosterResult;
    try {
      result = await this.fetchFn();
    } catch (err) {
      // fetchRoster never rejects, but an injected fetch might.
      logError('roster: poll failed', err);
      result = { ok: false, entries: [], error: errMessage(err), tookMs: 0 };
    } finally {
      this.inFlight = false;
    }

    if (result.ok) this.consecutiveFailures = 0;
    else this.consecutiveFailures += 1;

    try {
      this.onResult(result);
    } catch (err) {
      logError('roster: onResult listener threw', err);
    }

    if (this.disposed) return;
    if (this.pendingImmediate) {
      this.pendingImmediate = false;
      void this.tick();
      return;
    }
    this.schedule();
  }
}
