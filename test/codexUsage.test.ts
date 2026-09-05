// test/codexUsage.test.ts — the Codex meter, identity and activity readers in
// src/codex.ts, and the snapshot they become in src/limits.ts.
//
// Every fixture below is shaped like a record measured on codex-cli 0.153.0:
// the `token_count` event with `rate_limits` (window_minutes 300 / 10080,
// resets_at in epoch SECONDS, plan_type), the `task_started` /
// `task_complete` turn boundaries, and an `auth.json` whose `tokens.id_token`
// is a JWT with an `email` claim and the OpenAI auth claim. The JWT here is
// fabricated — three base64url segments, an unsigned payload — because the
// reader decodes and never verifies, and the test must not carry a real
// token.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ACTIVITY_TAIL_BYTES,
  RATE_LIMIT_MAX_FILES,
  codexHooksPath,
  decodeJwtClaims,
  parseCodexAuth,
  parseRolloutRateLimits,
  readCodexUsage,
  readRolloutActivity,
  readTail,
  rolloutActivityFromTail,
} from '../src/codex';
import {
  DEFAULT_CODEX_HOME_NAME,
  LimitsService,
  buildCodexSnapshot,
  formatUsageSummary,
  supportsUsage,
  windowLabel,
} from '../src/limits';
import type { AccountProfile } from '../src/types';

const ID_A = '01a072bd-848d-7fc0-9e53-82e2cfda013e';
const ID_B = '019ff316-1ef6-7d33-935f-c37a948a410d';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-codex-usage-'));
  temps.push(dir);
  return dir;
}

/** `{"timestamp":…,"type":"event_msg","payload":{"type":"token_count",…}}` */
function tokenCountLine(opts: {
  at: string;
  primary?: { used: number; minutes: number; resets: number } | null;
  secondary?: { used: number; minutes: number; resets: number } | null;
  plan?: string;
}): string {
  const win = (w: { used: number; minutes: number; resets: number } | null | undefined) =>
    w === undefined || w === null
      ? null
      : { used_percent: w.used, window_minutes: w.minutes, resets_at: w.resets };
  return JSON.stringify({
    timestamp: opts.at,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { total_tokens: 3197 }, model_context_window: 258400 },
      rate_limits: {
        limit_id: 'codex',
        limit_name: null,
        primary: win(opts.primary),
        secondary: win(opts.secondary),
        credits: { has_credits: false, unlimited: false, balance: '0' },
        plan_type: opts.plan ?? 'plus',
        rate_limit_reached_type: null,
      },
    },
  });
}

function eventLine(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: '2026-09-05T18:03:37.000Z',
    type: 'event_msg',
    payload: { type, turn_id: '019ff2c1-0b0f-7f81-96e5-caa1d8349c1c', ...extra },
  });
}

function rolloutName(id: string, local: string): string {
  return `rollout-${local}-${id}.jsonl`;
}

/** A rollout in `<home>/sessions/YYYY/MM/DD/`, with the given lines. */
function writeRollout(
  home: string,
  day: [string, string, string],
  id: string,
  lines: string[],
  mtimeMs?: number,
): string {
  const dir = path.join(home, 'sessions', ...day);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, rolloutName(id, `${day.join('-')}T10-00-00`));
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  if (mtimeMs !== undefined) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

// ------------------------------------------------------ parseRolloutRateLimits

describe('parseRolloutRateLimits', () => {
  it('reads both windows, converts resets_at from seconds, keeps the plan and the stamp', () => {
    const text = tokenCountLine({
      at: '2026-09-05T18:03:37.201Z',
      primary: { used: 0, minutes: 300, resets: 1788649421 },
      secondary: { used: 1, minutes: 10080, resets: 1788766690 },
      plan: 'plus',
    });
    const got = parseRolloutRateLimits(text);
    expect(got).not.toBeNull();
    expect(got?.primary).toEqual({ usedPercent: 0, windowMinutes: 300, resetsAt: 1788649421_000 });
    expect(got?.secondary).toEqual({
      usedPercent: 1,
      windowMinutes: 10080,
      resetsAt: 1788766690_000,
    });
    expect(got?.planType).toBe('plus');
    expect(got?.observedAt).toBe(Date.parse('2026-09-05T18:03:37.201Z'));
  });

  it('takes the NEWEST reading when several are in the window — the last line wins', () => {
    const text = [
      tokenCountLine({ at: '2026-09-05T10:00:00Z', primary: { used: 10, minutes: 300, resets: 1 } }),
      eventLine('agent_message'),
      tokenCountLine({ at: '2026-09-05T11:00:00Z', primary: { used: 42, minutes: 300, resets: 1 } }),
    ].join('\n');
    expect(parseRolloutRateLimits(text)?.primary?.usedPercent).toBe(42);
    expect(parseRolloutRateLimits(text)?.observedAt).toBe(Date.parse('2026-09-05T11:00:00Z'));
  });

  it('a null secondary is simply absent; a reading with neither window is skipped', () => {
    const one = parseRolloutRateLimits(
      tokenCountLine({ at: '2026-09-05T10:00:00Z', primary: { used: 1, minutes: 10080, resets: 5 } }),
    );
    expect(one?.primary?.windowMinutes).toBe(10080);
    expect(one?.secondary).toBeUndefined();

    const none = parseRolloutRateLimits(
      tokenCountLine({ at: '2026-09-05T10:00:00Z', primary: null, secondary: null }),
    );
    expect(none).toBeNull();
  });

  it('skips a half-line the tail window cut, and non-JSON, without throwing', () => {
    const good = tokenCountLine({ at: '2026-09-05T10:00:00Z', primary: { used: 7, minutes: 300, resets: 9 } });
    const text = `${good.slice(40)}\n${good}\nnot json "rate_limits"\n`;
    expect(parseRolloutRateLimits(text)?.primary?.usedPercent).toBe(7);
    expect(parseRolloutRateLimits('')).toBeNull();
    expect(parseRolloutRateLimits('{"type":"event_msg"}')).toBeNull();
  });

  it('clamps a used_percent outside 0-100 rather than passing it through', () => {
    const text = tokenCountLine({ at: '2026-09-05T10:00:00Z', primary: { used: 140, minutes: 300, resets: 9 } });
    expect(parseRolloutRateLimits(text)?.primary?.usedPercent).toBe(100);
  });
});

// ----------------------------------------------------------- readCodexUsage

describe('readCodexUsage', () => {
  it('returns the reading from the most recently WRITTEN rollout, not the newest day', () => {
    const home = tempHome();
    const now = Date.now();
    // Started later, written earlier — an abandoned session.
    writeRollout(
      home,
      ['2026', '09', '05'],
      ID_A,
      [tokenCountLine({ at: '2026-09-05T08:00:00Z', primary: { used: 5, minutes: 300, resets: 1 } })],
      now - 3 * 3_600_000,
    );
    // Started earlier, took a turn a minute ago — the current reading.
    const current = writeRollout(
      home,
      ['2026', '09', '04'],
      ID_B,
      [tokenCountLine({ at: '2026-09-05T11:00:00Z', primary: { used: 61, minutes: 300, resets: 1 } })],
      now - 60_000,
    );
    const got = readCodexUsage({ sessionsDirs: [path.join(home, 'sessions')] });
    expect(got?.rolloutPath).toBe(current);
    expect(got?.primary?.usedPercent).toBe(61);
  });

  it('skips rollouts with no reading in their tail and stops at the file budget', () => {
    const home = tempHome();
    const now = Date.now();
    for (let i = 0; i < RATE_LIMIT_MAX_FILES; i++) {
      writeRollout(
        home,
        ['2026', '09', '05'],
        `0199999${String(i).padStart(1, '0')}-0000-7000-8000-00000000000${String(i)}`,
        [eventLine('agent_message')],
        now - i * 1000,
      );
    }
    // A reading exists, but only in the (budget+1)-th newest file.
    writeRollout(
      home,
      ['2026', '09', '05'],
      ID_A,
      [tokenCountLine({ at: '2026-09-05T11:00:00Z', primary: { used: 9, minutes: 300, resets: 1 } })],
      now - 3_600_000,
    );
    expect(readCodexUsage({ sessionsDirs: [path.join(home, 'sessions')] })).toBeNull();
    expect(
      readCodexUsage({
        sessionsDirs: [path.join(home, 'sessions')],
        maxFiles: RATE_LIMIT_MAX_FILES + 1,
      })?.primary?.usedPercent,
    ).toBe(9);
  });

  it('an empty or missing store is null, never a throw', () => {
    const home = tempHome();
    expect(readCodexUsage({ sessionsDirs: [path.join(home, 'sessions')] })).toBeNull();
    expect(readCodexUsage({ sessionsDirs: [] })).toBeNull();
  });
});

// ---------------------------------------------------------------- identity

function fakeJwt(claims: Record<string, unknown>): string {
  const b64url = (s: string): string =>
    Buffer.from(s, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64url('{"alg":"none","typ":"JWT"}')}.${b64url(JSON.stringify(claims))}.sig`;
}

describe('decodeJwtClaims / parseCodexAuth', () => {
  it('decodes a base64url payload and reads email and plan; never returns the token', () => {
    const token = fakeJwt({
      email: 'someone@example.com',
      'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'acct' },
      exp: 1,
    });
    expect(decodeJwtClaims(token)?.['email']).toBe('someone@example.com');
    const auth = JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: { id_token: token, access_token: 'ACCESS-SECRET', refresh_token: 'REFRESH-SECRET', account_id: 'acct' },
      last_refresh: '2026-08-28T07:10:47.256774Z',
    });
    const identity = parseCodexAuth(auth);
    expect(identity).toEqual({ authMode: 'chatgpt', email: 'someone@example.com', planType: 'plus' });
    expect(JSON.stringify(identity)).not.toContain('SECRET');
    expect(JSON.stringify(identity)).not.toContain(token);
  });

  it('an API-key auth file is an identity with a mode and no name', () => {
    expect(parseCodexAuth(JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x' }))).toEqual({
      authMode: 'apikey',
    });
  });

  it('junk is null: not JSON, not an object, not a JWT', () => {
    expect(parseCodexAuth(null)).toBeNull();
    expect(parseCodexAuth('')).toBeNull();
    expect(parseCodexAuth('nope')).toBeNull();
    expect(parseCodexAuth('[1]')).toBeNull();
    expect(decodeJwtClaims('one-segment')).toBeNull();
    expect(decodeJwtClaims('a.!!!.c')).toBeNull();
    expect(decodeJwtClaims(42)).toBeNull();
  });
});

// ---------------------------------------------------------------- activity

describe('rolloutActivityFromTail', () => {
  it('the newest turn boundary decides: task_started is busy, task_complete is idle', () => {
    expect(rolloutActivityFromTail([eventLine('task_started')].join('\n'))).toBe('busy');
    expect(
      rolloutActivityFromTail([eventLine('task_started'), eventLine('agent_message'), eventLine('task_complete')].join('\n')),
    ).toBe('idle');
    expect(
      rolloutActivityFromTail([eventLine('task_complete'), eventLine('user_message', { message: 'hi' })].join('\n')),
    ).toBe('busy');
    expect(rolloutActivityFromTail([eventLine('task_started'), eventLine('turn_aborted')].join('\n'))).toBe('idle');
  });

  it('a tail with no boundary — or nothing but response items — says nothing', () => {
    expect(rolloutActivityFromTail('')).toBeNull();
    expect(rolloutActivityFromTail(JSON.stringify({ type: 'response_item', payload: { type: 'message' } }))).toBeNull();
    expect(rolloutActivityFromTail('{"type":"event_msg"} broken')).toBeNull();
  });

  it('readRolloutActivity reads the tail of a real file and is null for a missing one', () => {
    const home = tempHome();
    const file = writeRollout(home, ['2026', '09', '05'], ID_A, [
      eventLine('task_started'),
      eventLine('task_complete'),
    ]);
    expect(readRolloutActivity(file)).toBe('idle');
    expect(readRolloutActivity(path.join(home, 'missing.jsonl'))).toBeNull();
    // The budget is what bounds a read; a file larger than it is read from the end.
    const big = writeRollout(home, ['2026', '09', '05'], ID_B, [
      eventLine('task_complete'),
      'x'.repeat(ACTIVITY_TAIL_BYTES),
      eventLine('task_started'),
    ]);
    expect(readRolloutActivity(big)).toBe('busy');
    expect(readTail(big, 10).length).toBe(10);
  });
});

// ------------------------------------------------------------- paths

describe('codexHooksPath', () => {
  it('is <home>/hooks.json, and ~/.codex/hooks.json for the default home', () => {
    expect(codexHooksPath('/tmp/h')).toBe(path.join('/tmp/h', 'hooks.json'));
    expect(codexHooksPath('')).toBe(path.join(os.homedir(), '.codex', 'hooks.json'));
  });
});

// ------------------------------------------------------- buildCodexSnapshot

function profile(id: string, over: Partial<AccountProfile> = {}): AccountProfile {
  return {
    id,
    provider: 'codex',
    label: `Label ${id}`,
    order: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('buildCodexSnapshot', () => {
  const NOW = Date.parse('2026-09-05T12:00:00Z');

  it('maps the 300-minute window to fiveHour and the 10080-minute one to sevenDay, whichever is primary', () => {
    const weeklyFirst = buildCodexSnapshot(
      {
        primary: { usedPercent: 1, windowMinutes: 10080, resetsAt: NOW + 86_400_000 },
        secondary: { usedPercent: 40, windowMinutes: 300, resetsAt: NOW + 3_600_000 },
        planType: 'plus',
        observedAt: NOW - 60_000,
      },
      { email: 'a@b.c', planType: 'plus', authMode: 'chatgpt' },
      NOW,
    );
    expect(weeklyFirst.fiveHour).toEqual({ utilization: 40, minutes: 300, resetsAt: NOW + 3_600_000 });
    expect(weeklyFirst.sevenDay).toEqual({ utilization: 1, minutes: 10080, resetsAt: NOW + 86_400_000 });
    expect(weeklyFirst.signedInAs).toBe('a@b.c');
    expect(weeklyFirst.plan).toBe('plus');
    expect(weeklyFirst.observedAt).toBe(NOW - 60_000);
    expect(weeklyFirst.fetchedAt).toBe(NOW);
    expect(weeklyFirst.error).toBeUndefined();
  });

  it('a window whose reset is already behind now is reported OPEN, not at its stale percentage', () => {
    const snap = buildCodexSnapshot(
      {
        primary: { usedPercent: 95, windowMinutes: 300, resetsAt: NOW - 1 },
        secondary: { usedPercent: 30, windowMinutes: 10080, resetsAt: NOW + 1 },
        observedAt: NOW - 6 * 3_600_000,
      },
      null,
      NOW,
    );
    expect(snap.fiveHour).toEqual({ utilization: 0, minutes: 300 });
    expect(snap.sevenDay?.utilization).toBe(30);
  });

  it('no reading yet is a snapshot with a name and no windows — not an error', () => {
    const snap = buildCodexSnapshot(null, { email: 'a@b.c', authMode: 'chatgpt' }, NOW);
    expect(snap).toEqual({ fetchedAt: NOW, signedInAs: 'a@b.c' });
  });

  it('two windows on the same side of a day take both slots rather than one overwriting the other', () => {
    const snap = buildCodexSnapshot(
      {
        primary: { usedPercent: 10, windowMinutes: 60 },
        secondary: { usedPercent: 20, windowMinutes: 360 },
        observedAt: NOW,
      },
      null,
      NOW,
    );
    expect(snap.fiveHour).toEqual({ utilization: 10, minutes: 60 });
    expect(snap.sevenDay).toEqual({ utilization: 20, minutes: 360 });
  });
});

describe('windowLabel', () => {
  it('names the slot for the canonical durations and for Claude windows with none', () => {
    expect(windowLabel({ utilization: 1 }, '5h')).toBe('5h');
    expect(windowLabel({ utilization: 1, minutes: 300 }, '5h')).toBe('5h');
    expect(windowLabel({ utilization: 1, minutes: 10080 }, 'wk')).toBe('wk');
    expect(windowLabel({ utilization: 1, minutes: 10080 }, 'week', 'week')).toBe('week');
  });

  it('names an odd-length window by its duration', () => {
    expect(windowLabel({ utilization: 1, minutes: 360 }, '5h')).toBe('6h');
    expect(windowLabel({ utilization: 1, minutes: 3 * 1440 }, 'wk')).toBe('3d');
    expect(windowLabel({ utilization: 1, minutes: 30 }, '5h')).toBe('30m');
  });
});

describe('supportsUsage for codex', () => {
  it('a Codex login is read; a Codex API key is not', () => {
    expect(supportsUsage(profile('x'))).toBe(true);
    expect(supportsUsage(profile('k', { extraEnv: { OPENAI_API_KEY: 'sk' } }))).toBe(false);
  });
});

// ------------------------------------------------------ LimitsService, codex

describe('LimitsService — a codex profile', () => {
  const HOME = '/Users/test-home';
  const NOW = Date.parse('2026-09-05T12:00:00Z');
  const AUTH = JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: fakeJwt({ email: 'a@b.c', 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } }),
      access_token: 'ACCESS-SECRET',
      refresh_token: 'REFRESH-SECRET',
    },
  });

  function harness(opts: { auth?: string | null; reading?: Parameters<typeof buildCodexSnapshot>[0] }) {
    const reads: string[] = [];
    const fetchFn = async (): Promise<never> => {
      throw new Error('fetch must never be called for a codex profile');
    };
    const usageDirs: string[] = [];
    const service = new LimitsService({
      readFile: async (file) => {
        reads.push(file);
        return opts.auth === undefined ? AUTH : opts.auth;
      },
      codexUsage: async (dir) => {
        usageDirs.push(dir);
        const r = opts.reading;
        return r === undefined || r === null ? null : { ...r, rolloutPath: '/x/rollout.jsonl' };
      },
      fetch: fetchFn,
      now: () => NOW,
      homeDir: HOME,
      platform: 'darwin',
    });
    return { service, reads, usageDirs };
  }

  it('reads auth.json and the sessions store under ~/.codex for the default account, never the network', async () => {
    const { service, reads, usageDirs } = harness({
      reading: {
        primary: { usedPercent: 12, windowMinutes: 300, resetsAt: NOW + 1000 },
        secondary: { usedPercent: 3, windowMinutes: 10080, resetsAt: NOW + 2000 },
        planType: 'plus',
        observedAt: NOW - 5000,
      },
    });
    const snap = await service.readUsage(profile('cx'));
    expect(reads).toEqual([path.join(HOME, DEFAULT_CODEX_HOME_NAME, 'auth.json')]);
    expect(usageDirs).toEqual([path.join(HOME, DEFAULT_CODEX_HOME_NAME, 'sessions')]);
    expect(snap?.fiveHour?.utilization).toBe(12);
    expect(snap?.sevenDay?.utilization).toBe(3);
    expect(snap?.signedInAs).toBe('a@b.c');
    // The reading's plan outranks the token's: it is the newer claim.
    expect(snap?.plan).toBe('plus');
    expect(snap?.observedAt).toBe(NOW - 5000);
    expect(snap?.error).toBeUndefined();
    expect(formatUsageSummary(snap, NOW)).toBe('5h 12% → 1m · wk 3% → ' + new Date(NOW + 2000).toLocaleDateString('en-US', { weekday: 'short' }));
  });

  it("a profile with its own CODEX_HOME is read there — the account's login, not the machine's", async () => {
    const { service, reads, usageDirs } = harness({ reading: null });
    await service.readUsage(profile('cx', { configDir: '/acct/codex-work' }));
    expect(reads).toEqual([path.join('/acct/codex-work', 'auth.json')]);
    expect(usageDirs).toEqual([path.join('/acct/codex-work', 'sessions')]);
  });

  it('no auth.json is not-signed-in, exactly as a Claude profile with no credentials', async () => {
    const { service, usageDirs } = harness({ auth: null });
    const snap = await service.readUsage(profile('cx'));
    expect(snap?.error).toBe('no-credentials');
    expect(snap?.signedInAs).toBeUndefined();
    expect(usageDirs).toEqual([]); // nothing to read a meter for
    expect(formatUsageSummary(snap, NOW)).toBe('not logged in');
  });

  it('signed in but never used: a name, a plan, no windows, no error', async () => {
    const { service } = harness({ reading: null });
    const snap = await service.readUsage(profile('cx'));
    expect(snap?.error).toBeUndefined();
    expect(snap?.fiveHour).toBeUndefined();
    expect(snap?.signedInAs).toBe('a@b.c');
    expect(snap?.plan).toBe('pro');
    expect(formatUsageSummary(snap, NOW)).toBe('a@b.c · usage n/a');
  });

  it('a Codex API-key profile answers null without reading anything', async () => {
    const { service, reads } = harness({});
    expect(await service.readUsage(profile('k', { extraEnv: { OPENAI_API_KEY: 'sk' } }))).toBeNull();
    expect(reads).toEqual([]);
  });
});
