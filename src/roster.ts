// IMPLEMENTED BY: A
// src/roster.ts — `claude agents --json` fetch / parse / normalise, claude
// binary discovery, and the polling loop. Public surface frozen by SPEC §4-A1.
//
// Imports allowed here: ./types, ./log, node:child_process, node:fs,
// node:path, node:process. NEVER import vscode.
//
// Design note (plan risk #3): `claude agents --json` is an UNDOCUMENTED
// contract. Its help text says "for scripting", which implies intent, but the
// field set can churn between CLI releases — and the measured output already
// disagrees with itself row to row: `pid`, `id`, `status`, `waitingFor` and
// `state` are each absent on some real rows. So every field except `sessionId`
// is optional and defensively coerced, unrecognised shapes are dropped rather
// than trusted, and nothing here throws. The tree must degrade, never break.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';

import { log, logError } from './log';
import {
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
  if (v === undefined) return undefined; // absent stays absent (§4-A1 rule 3)
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
    // transport failure (§4-A1 rule 1 — ok:false is reserved for a throw).
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
 * is logged and the offending row dropped. See SPEC §4-A1 for the four
 * normative rules (JSON.parse guard, uuid sessionId gate, field coercion,
 * dedupe-first-wins).
 */
export function parseRoster(raw: string): RosterEntry[] {
  return parseRosterDetailed(raw).entries;
}

/**
 * Decision table (first match wins) from SPEC §4-A1:
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

// ---------------------------------------------------------------- fetching

export interface FetchRosterOptions {
  claudeBin?: string; // default 'claude'
  timeoutMs?: number; // default 10_000
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : String(err);
}

/**
 * execFile(claudeBin, ['agents', '--json'], ...). NEVER rejects: any
 * spawn/timeout/parse failure resolves {ok:false, entries:[], error, tookMs}.
 * The argument vector is exactly ['agents', '--json'] — nothing else, ever.
 *
 * execFile, never a shell: a binary path with spaces or a hostile PATH entry
 * can then never become a command line. The environment is inherited because
 * the CLI needs it (config dir, credentials, proxy).
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

    try {
      execFile(
        bin,
        rosterArgv(),
        {
          timeout,
          maxBuffer: MAX_BUFFER_BYTES,
          env: process.env,
          windowsHide: true,
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
 * A non-empty `configured` value is returned verbatim (no existence check —
 * the user knows where their CLI is, and an over-eager check would reject a
 * shim we cannot stat). Otherwise scan PATH for an existing file named claude
 * (claude.cmd/claude.exe additionally on win32); first absolute hit wins,
 * else null.
 */
export function findClaudeBinary(configured?: string): string | null {
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return configured;
  }
  const names =
    process.platform === 'win32'
      ? ['claude.cmd', 'claude.exe', 'claude']
      : ['claude'];
  const rawPath = process.env['PATH'] ?? process.env['Path'] ?? '';
  if (rawPath.length === 0) return null;

  for (const dir of rawPath.split(path.delimiter)) {
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
 * The poller itself deliberately holds no roster state (SPEC §4-A1: caching
 * is the caller's job); these helpers give the caller change detection
 * without smuggling a cache into the poller.
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
    ].join(' '),
  );
  rows.sort();
  return rows.join('');
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

  /** Suspend polling (the integrator calls this when the view is hidden).
   *  A later pokeNow() still works; only the timer chain stops. */
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
