import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { LimitsService, formatUsageSummary, retryAfterMs } from '../src/limits';
import type { HttpResponseLike, UsageCacheStore } from '../src/limits';
import { createUsageRequestScheduler, REQUEST_SPACING_MS } from '../src/usageSchedule';
import type { AccountProfile } from '../src/types';

const BASE = Date.parse('2026-09-13T12:00:00Z');
const key = 'a'.repeat(64);
const options = { force: false, minIntervalMs: 300_000, cancelled: () => false };
const dirs: string[] = [];
async function temp() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'flock-schedule-test-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

function clock() {
  return {
    time: BASE,
    now() { return this.time; },
    async sleep(ms: number) {
      // Yield to real filesystem completion while contending. Longer waits
      // advance simulated time, so no test waits a minute or probes the server.
      if (ms <= 50) await new Promise((resolve) => setTimeout(resolve, 1));
      else this.time += ms;
    },
  };
}
function profile(id = 'a'): AccountProfile {
  return { id, provider: 'claude', configDir: `/fake/${id}`, label: id, order: 0,
    createdAt: '2026-09-13', updatedAt: '2026-09-13' };
}
function ok(): HttpResponseLike {
  return { status: 200, text: async () => JSON.stringify({ five_hour: { utilization: 25 } }) };
}
function throttle(header: string | null = '2544'): HttpResponseLike {
  return { status: 429, text: async () => '', headers: { get: () => header } };
}
function service(
  time: ReturnType<typeof clock>,
  fetch: () => Promise<HttpResponseLike>,
  file?: string,
  cache?: UsageCacheStore,
) {
  return new LimitsService({
    platform: 'linux', homeDir: '/fake', now: () => time.time, cache, fetch,
    readFile: async (file) => file.endsWith('.credentials.json')
      ? JSON.stringify({ claudeAiOauth: { accessToken: 'FAKE_TOKEN' } })
      : JSON.stringify({ oauthAccount: { emailAddress: 'review@example.test' } }),
    scheduler: createUsageRequestScheduler(file, {
      now: () => time.time, sleep: (ms) => time.sleep(ms),
    }),
  });
}

describe('the production usage request path', () => {
  it('spaces all accounts and makes queued callers observe the first throttle', async () => {
    const time = clock();
    const starts: number[] = [];
    const reader = service(time, async () => { starts.push(time.time); return throttle(); });
    const answers = await Promise.all(['a', 'b', 'c'].map((id) => reader.readUsage(profile(id), { force: true })));
    expect(starts).toEqual([BASE]);
    expect(answers.map((s) => s?.retryAt)).toEqual(Array(3).fill(BASE + 2_544_000));
    for (let i = 1; i <= 6; i++) {
      time.time = BASE + i * 20_000;
      await reader.readUsage(profile(), { force: true });
    }
    expect(starts).toHaveLength(1);
  });

  it('two windows share successful reads, request spacing, and startup freshness', async () => {
    const file = path.join(await temp(), 'schedule.json');
    const time = clock();
    const starts: number[] = [];
    const entries = new Map();
    const cache: UsageCacheStore = {
      load: async () => entries, reload: async () => entries,
      save: (id, entry) => { entries.set(id, entry); },
    };
    const fetch = vi.fn(async () => { starts.push(time.time); return ok(); });
    const one = service(time, fetch, file, cache);
    const two = service(time, fetch, file, cache);
    const result = await Promise.all([one.readUsage(profile('a')), two.readUsage(profile('b'))]);
    expect(result.map((s) => s?.fiveHour?.utilization)).toEqual([25, 25]);
    expect(starts).toHaveLength(2);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(REQUEST_SPACING_MS);
    const restarted = service(time, fetch, file, cache);
    expect((await restarted.readUsage(profile('a')))?.fiveHour?.utilization).toBe(25);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['2544', '10800', '7776000', new Date(BASE + 10_800_000).toUTCString()])(
    'preserves the deadline across restart and manual refresh: %s', async (header) => {
      const file = path.join(await temp(), 'schedule.json');
      const time = clock();
      const fetch = vi.fn(async () => throttle(header));
      const one = service(time, fetch, file);
      const first = await one.readUsage(profile(), { force: true });
      const deadline = BASE + retryAfterMs({ get: () => header }, BASE)!;
      expect(first?.retryAt).toBe(deadline);
      expect(fetch).toHaveBeenCalledTimes(1);
      one.dispose();
      time.time++;
      const success = vi.fn(async () => ok());
      const restarted = service(time, success, file);
      expect((await restarted.readUsage(profile('b'), { force: true }))?.retryAt).toBe(deadline);
      time.time = deadline - 1;
      await restarted.readUsage(profile('b'), { force: true });
      expect(success).not.toHaveBeenCalled();
      time.time = deadline;
      expect((await restarted.readUsage(profile('b'), { force: true }))?.fiveHour?.utilization).toBe(25);
      expect(success).toHaveBeenCalledTimes(1);
    },
  );

  it('persists missing-header backoff and increases it only on actual refusals', async () => {
    const file = path.join(await temp(), 'schedule.json');
    const time = clock();
    const fetch = vi.fn(async () => throttle(null));
    for (const minutes of [10, 20, 30, 30]) {
      const reader = service(time, fetch, file);
      const before = fetch.mock.calls.length;
      const at = time.time;
      const snap = await reader.readUsage(profile(), { force: true });
      expect(snap?.retryAt).toBe(at + minutes * 60_000);
      for (let i = 0; i < 3; i++) await reader.readUsage(profile(), { force: true });
      expect(fetch).toHaveBeenCalledTimes(before + 1);
      time.time = snap!.retryAt!;
      reader.dispose();
    }
  });

  it('keeps the deadline and identity when a remembered reading becomes stale', async () => {
    const time = clock();
    let calls = 0;
    const reader = service(time, async () => ++calls === 1 ? ok() : throttle());
    await reader.readUsage(profile());
    time.time += 300_000;
    const paused = await reader.readUsage(profile());
    time.time = BASE + 16 * 60_000;
    const stale = reader.cached(profile());
    expect(stale?.stale).toBe(true);
    expect(stale?.retryAt).toBe(paused?.retryAt);
    expect(stale?.signedInAs).toBe('review@example.test');
    expect(stale?.fiveHour?.utilization).toBe(25);
    const summary = formatUsageSummary(stale, time.time);
    expect(summary).toMatch(/^Flock usage polling paused → /);
    expect(summary).toContain('5h 25%');
    expect(summary).toContain('stale');
  });

  it('dedupes callers while the first is still loading its disk seed', async () => {
    const time = clock();
    let release!: (value: null) => void;
    const load = new Promise<null>((resolve) => { release = resolve; });
    const cache: UsageCacheStore = { load: async () => load, save: () => undefined };
    const fetch = vi.fn(async () => ok());
    const reader = service(time, fetch, undefined, cache);
    const first = reader.readUsage(profile());
    const second = reader.readUsage(profile(), { force: true });
    expect(fetch).not.toHaveBeenCalled();
    release(null);
    const answers = await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(answers[0]).toBe(answers[1]);
  });

  it('rechecks a cooldown recorded by another window while waiting for a slot', async () => {
    const file = path.join(await temp(), 'schedule.json');
    const time = clock();
    await service(time, async () => ok(), file).readUsage(profile('a'));
    let wake!: () => void;
    const request = vi.fn(async () => ({ value: 'should not send' }));
    const waiting = createUsageRequestScheduler(file, {
      now: () => time.time,
      sleep: () => new Promise<void>((resolve) => { wake = resolve; }),
    });
    const queued = waiting.run('b'.repeat(64), options, request);
    await vi.waitFor(() => expect(wake).toBeTypeOf('function'));
    time.time += REQUEST_SPACING_MS;
    const refused = await service(time, async () => throttle(), file).readUsage(profile('c'));
    wake();
    expect(await queued).toEqual({ kind: 'paused', rateLimited: true, retryAt: refused?.retryAt });
    expect(request).not.toHaveBeenCalled();
  });

  it('cancels a queued request when its window is disposed', async () => {
    const time = clock();
    let wake!: () => void;
    const fetch = vi.fn(async () => ok());
    const scheduler = createUsageRequestScheduler(undefined, {
      now: () => time.time,
      sleep: async () => new Promise<void>((resolve) => { wake = resolve; }),
    });
    const reader = new LimitsService({
      scheduler, now: () => time.time, platform: 'linux', fetch,
      readFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'FAKE' } }),
    });
    await reader.readUsage(profile());
    const queued = reader.readUsage(profile('b'));
    await vi.waitFor(() => expect(wake).toBeTypeOf('function'));
    reader.dispose();
    wake();
    expect(await queued).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('durable coordination', () => {
  it('recovers a dead owner without losing its recorded cooldown', async () => {
    const file = path.join(await temp(), 'schedule.json');
    const time = clock();
    const reader = service(time, async () => throttle(), file);
    await reader.readUsage(profile());
    const lock = `${file}.lock`;
    await fsp.mkdir(lock);
    await fsp.writeFile(path.join(lock, 'owner-99999999-dead'), '');
    const fetch = vi.fn(async () => ok());
    const restarted = service(time, fetch, file);
    expect((await restarted.readUsage(profile('b'), { force: true }))?.retryAt).toBe(BASE + 2_544_000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not steal a live owner merely because its lock is old', async () => {
    const file = path.join(await temp(), 'schedule.json');
    const lock = `${file}.lock`;
    await fsp.mkdir(lock);
    const owner = path.join(lock, `owner-${process.pid}-abcd`);
    await fsp.writeFile(owner, '');
    await fsp.utimes(lock, new Date(0), new Date(0));
    let cancelled = false;
    const scheduler = createUsageRequestScheduler(file, {
      sleep: async () => { cancelled = true; },
    });
    const request = vi.fn(async () => ({ value: 'sent' }));
    expect(await scheduler.run(key, { ...options, cancelled: () => cancelled }, request))
      .toEqual({ kind: 'cancelled' });
    expect(request).not.toHaveBeenCalled();
    await expect(fsp.stat(owner)).resolves.toBeDefined();
  });

  it('does not send when the schedule cannot be read or written', async () => {
    const dir = await temp();
    const corrupt = path.join(dir, 'corrupt.json');
    await fsp.writeFile(corrupt, '{broken');
    const parentFile = path.join(dir, 'not-a-directory');
    await fsp.writeFile(parentFile, '');
    for (const file of [corrupt, path.join(parentFile, 'schedule.json')]) {
      const request = vi.fn(async () => ({ value: 'sent' }));
      const scheduler = createUsageRequestScheduler(file);
      expect((await scheduler.run(key, options, request)).kind).toBe('paused');
      expect(request).not.toHaveBeenCalled();
    }
  });

  it('coordinates actual separate processes and preserves a cooldown for a later process', async () => {
    const dir = await temp();
    const bundle = path.join(dir, 'scheduler.cjs');
    const file = path.join(dir, 'schedule.json');
    await build({ entryPoints: [path.resolve('src/usageSchedule.ts')], outfile: bundle,
      bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    const worker = path.join(dir, 'worker.cjs');
    await fsp.writeFile(worker, `
      const { createUsageRequestScheduler } = require(process.argv[2]);
      const scheduler = createUsageRequestScheduler(process.argv[3], {
        spacingMs: 100, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      });
      scheduler.run(process.argv[4].repeat(64), {
        force: true, minIntervalMs: 300000, cancelled: () => false,
      }, async () => ({ value: Date.now(), rateLimited: process.argv[5] === 'throttle',
        retryAfterMs: 2544000,
      })).then(result => process.stdout.write(JSON.stringify(result)));
    `);
    const run = async (account: string, response = 'ok') => JSON.parse((await promisify(execFile)(
      process.execPath, [worker, bundle, file, account, response], { timeout: 10_000 },
    )).stdout);
    const answers = await Promise.all([run('a'), run('b')]);
    expect(answers.every((answer) => answer.kind === 'sent')).toBe(true);
    expect(Math.abs(answers[1].value - answers[0].value)).toBeGreaterThanOrEqual(100);
    const refused = await run('c', 'throttle');
    expect(refused.kind).toBe('sent');
    const restarted = await run('d');
    expect(restarted).toEqual({ kind: 'paused', rateLimited: true, retryAt: refused.retryAt });
  });
});
