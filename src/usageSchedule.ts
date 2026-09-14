import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { logError } from './log';

export const USAGE_SCHEDULE_FILE_NAME = 'usage-schedule.json';
/** Aggregate rate across accounts and windows. This is a conservative client
 * budget, not a claim about the provider's undocumented limit. */
export const REQUEST_SPACING_MS = 60_000;
const BACKOFF_BASE_MS = 10 * 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;

interface Schedule {
  version: 1;
  nextRequestAt: number;
  pausedUntil: number;
  backoffMs: number;
  accounts: Record<string, number>;
}

export type ScheduledResult<T> =
  | { kind: 'sent'; value: T; retryAt?: number }
  | { kind: 'paused'; retryAt: number; rateLimited: boolean }
  | { kind: 'cached'; retryAt: number }
  | { kind: 'cancelled' };

export interface UsageRequestScheduler {
  run<T>(
    account: string,
    options: { force: boolean; minIntervalMs: number; cancelled: () => boolean },
    request: () => Promise<{ value: T; rateLimited?: boolean; retryAfterMs?: number }>,
  ): Promise<ScheduledResult<T>>;
}

interface ScheduleOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  spacingMs?: number;
}

function emptySchedule(): Schedule {
  return { version: 1, nextRequestAt: 0, pausedUntil: 0, backoffMs: 0, accounts: {} };
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseSchedule(text: string): Schedule {
  const raw = JSON.parse(text) as Schedule;
  if (
    raw?.version !== 1 || !timestamp(raw.nextRequestAt) ||
    !timestamp(raw.pausedUntil) || !timestamp(raw.backoffMs) ||
    !raw.accounts || typeof raw.accounts !== 'object' || Array.isArray(raw.accounts) ||
    Object.entries(raw.accounts).some(([key, at]) => !/^[a-f0-9]{64}$/.test(key) || !timestamp(at))
  ) throw new Error('Invalid usage schedule');
  return raw;
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

/** A dead process cannot still own a request. EPERM and unknown failures are
 * treated as live; elapsed time alone never authorizes stealing its lock. */
function isDead(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return code(error) === 'ESRCH'; }
}

/** Publish a nonempty directory atomically. A competing rename cannot replace
 * a nonempty owner directory. Recovery removes only the dead owner's uniquely
 * named file; a second recovery cannot delete a successor's ownership file. */
async function tryLock(file: string): Promise<(() => Promise<void>) | null> {
  const lock = `${file}.lock`;
  const owner = `owner-${process.pid}-${randomUUID()}`;
  const prepared = `${lock}.${owner}`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.mkdir(prepared);
  try {
    await fsp.writeFile(path.join(prepared, owner), '', { flag: 'wx', mode: 0o600 });
    try {
      await fsp.rename(prepared, lock);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(code(error) ?? '')) throw error;
      // Only remove files belonging to processes known to have exited.
      const owners = await fsp.readdir(lock).catch((e: unknown) => {
        if (code(e) === 'ENOENT') return [];
        throw e;
      });
      for (const name of owners) {
        const match = /^owner-(\d+)-[a-f0-9-]+$/.exec(name);
        if (match && isDead(Number(match[1]))) {
          await fsp.unlink(path.join(lock, name)).catch((e: unknown) => {
            if (code(e) !== 'ENOENT') throw e;
          });
        }
      }
      await fsp.rmdir(lock).catch((e: unknown) => {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(code(e) ?? '')) throw e;
      });
      return null;
    }
    return async () => {
      await fsp.unlink(path.join(lock, owner));
      await fsp.rmdir(lock).catch((e: unknown) => {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(code(e) ?? '')) throw e;
      });
    };
  } finally {
    await fsp.rm(prepared, { recursive: true, force: true });
  }
}

/** The file is shared by every editor window. The lock spans the request and
 * recording its response, so queued callers see a new cooldown before sending.
 * Sleeps happen outside the lock and recheck all deadlines on waking. No timer
 * is created for a server cooldown, however long it is. Without a file, the
 * same rules apply in memory (for tests and standalone readers). */
export function createUsageRequestScheduler(
  file?: string,
  deps: ScheduleOptions = {},
): UsageRequestScheduler {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }));
  const spacing = deps.spacingMs ?? REQUEST_SPACING_MS;
  let memory = emptySchedule();
  let busy = false;

  const read = async (): Promise<Schedule> => {
    if (!file) return memory;
    try { return parseSchedule(await fsp.readFile(file, 'utf8')); }
    catch (error) {
      if (code(error) === 'ENOENT') return emptySchedule();
      throw error; // An unreadable cooldown is not permission to send.
    }
  };
  const write = async (state: Schedule): Promise<void> => {
    memory = state;
    if (!file) return;
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
      await fsp.rename(tmp, file);
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  };

  return {
    async run(account, options, request) {
      let lockAttempts = 0;
      while (!options.cancelled()) {
        let release: (() => Promise<void>) | null = null;
        let wait = 0;
        try {
          if (file) release = await tryLock(file);
          else if (!busy) {
            busy = true;
            release = async () => { busy = false; };
          }
          if (!release) {
            // Bound contention without ever falling back to an unlocked fetch.
            if (++lockAttempts >= 240) {
              return { kind: 'paused', rateLimited: false, retryAt: now() + spacing };
            }
            wait = 50;
          } else {
            lockAttempts = 0;
            const state = await read();
            const at = now();
            // Even force must obey both a stated wait and a missing-header backoff.
            if (state.pausedUntil > at) {
              return { kind: 'paused', rateLimited: true, retryAt: state.pausedUntil };
            }
            const next = state.accounts[account] ?? 0;
            if (!options.force && next > at) return { kind: 'cached', retryAt: next };
            wait = Math.max(0, state.nextRequestAt - at);
            if (wait === 0) {
              if (options.cancelled()) return { kind: 'cancelled' };
              // Persist the reservation BEFORE sending, including across a crash.
              state.nextRequestAt = at + spacing;
              for (const [key, until] of Object.entries(state.accounts)) {
                if (until <= at) delete state.accounts[key];
              }
              state.accounts[account] = at + options.minIntervalMs;
              await write(state);
              if (options.cancelled()) return { kind: 'cancelled' };
              const result = await request();
              // Include time spent persisting the reservation and awaiting the
              // response. No caller is admitted until this update is durable.
              state.nextRequestAt = Math.max(state.nextRequestAt, now() + spacing);
              if (result.rateLimited) {
                state.backoffMs = state.backoffMs === 0
                  ? BACKOFF_BASE_MS : Math.min(state.backoffMs * 2, BACKOFF_MAX_MS);
                state.pausedUntil = now() + Math.max(state.backoffMs, result.retryAfterMs ?? 0);
              } else {
                state.pausedUntil = 0;
                state.backoffMs = 0;
              }
              await write(state);
              return {
                kind: 'sent', value: result.value,
                ...(result.rateLimited ? { retryAt: state.pausedUntil } : {}),
              };
            }
          }
        } catch (error) {
          logError('limits: usage scheduling paused', error);
          return { kind: 'paused', rateLimited: false, retryAt: now() + spacing };
        } finally {
          await release?.().catch(() => undefined);
        }
        await sleep(Math.min(wait, 60_000));
      }
      return { kind: 'cancelled' };
    },
  };
}
