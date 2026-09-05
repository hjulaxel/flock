// test/limits.test.ts — the CONTRACT under test: src/limits.ts.
//
// Node-only, no vscode, no real network, no real keychain, no real ~/.claude.
// Every seam (`fetch`, `exec`, `readFile`, `now`, `homeDir`) is injected via
// `LimitsDeps`, exactly as git.ts's `ProbeOptions.run` and tmux.ts's
// `resolveTmuxSpawn` are tested elsewhere in this suite — a fake is a typed
// object literal, never a spawned process or a real HTTP call.
//
// What actually matters, roughly in the order the module's own header states
// it:
//
//   1. CREDENTIAL RESOLUTION ORDER — file beats keychain; on macOS EVERY
//      claude profile may probe the keychain, each under its OWN service name
//      (`keychainServiceFor`: the default item bare, a custom configDir
//      suffixed with sha256(path)[:8] — so a lookup can never cross accounts),
//      because that item is not per-config-dir and a fallback would render
//      the DEFAULT account's usage under another account's name.
//   2. `expiresAt` is honoured — an already-expired token short-circuits
//      without touching the network.
//   3. BODY PARSING normalises 0-1 and 0-100 scales, ISO and epoch resets,
//      and treats an unrecognised body as a parse failure, never a zero.
//   4. FAILURE HANDLING — 401 -> 'expired'; everything else non-2xx and every
//      thrown fetch -> 'http'; a failure degrades to the last GOOD snapshot,
//      marked stale, rather than going blank.
//   5. RATE LIMITING — one fetch per profile per MIN_FETCH_INTERVAL_MS,
//      exponential backoff after an 'http'/'parse' failure, `force` bypasses
//      both.
//   6. profiles this file has nothing to say about (codex/gemini/generic, an
//      API-key account, a disposed service) answer `null` without touching a
//      single dependency.
//   7. `formatUsageSummary` strings, pinned exactly.
//   8. REDACTION — the token a fake credential provides must never surface
//      outside the one `Authorization` header it is built for: not in a
//      returned snapshot, not in a log line, not in a thrown error.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';

import { setLogSink } from '../src/log';
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  CREDENTIALS_FILE,
  DEFAULT_CONFIG_DIR_NAME,
  KEYCHAIN_SERVICE,
  KEYCHAIN_TIMEOUT_MS,
  LimitsService,
  MIN_FETCH_INTERVAL_MS,
  STALE_AFTER_MS,
  createLimitsService,
  credentialsPathFor,
  IDENTITY_FILE,
  formatUsageSummary,
  resetInLabel,
  keychainServiceFor,
  parseResetAt,
  parseUsageBody,
  supportsUsage,
  weekdayFor,
} from '../src/limits';
import type { HttpRequestInit, HttpResponseLike } from '../src/limits';
import type { AccountProfile, UsageSnapshot } from '../src/types';

// ------------------------------------------------------------------ helpers

const HOME = '/Users/test-home';
const BASE = Date.parse('2026-03-04T12:00:00.000Z');

function profile(id: string, over: Partial<AccountProfile> = {}): AccountProfile {
  return {
    id,
    provider: 'claude',
    label: `Label ${id}`,
    order: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

/** The OAuth blob shape a real `.credentials.json` (or keychain payload) has. */
function credBlob(token: string, expiresAt?: string | number): string {
  const inner: Record<string, unknown> = { accessToken: token };
  if (expiresAt !== undefined) inner['expiresAt'] = expiresAt;
  return JSON.stringify({ claudeAiOauth: inner });
}

/** The shape a real, working login has: an access token that lapses in hours
 *  and the refresh token the CLI renews it from. `credBlob` deliberately omits
 *  the second one — the two together are what tell "signed in, token aged out"
 *  from "signed out". */
function credBlobWithRefresh(token: string, expiresAt?: string | number): string {
  const inner: Record<string, unknown> = {
    accessToken: token,
    refreshToken: 'REFRESH',
  };
  if (expiresAt !== undefined) inner['expiresAt'] = expiresAt;
  return JSON.stringify({ claudeAiOauth: inner });
}

/** A 200 whose body carries one `five_hour` window, for tests that only care
 *  that a fetch happened and what it settled to. */
function bodyWithFiveHour(utilization: number): string {
  return JSON.stringify({ five_hour: { utilization } });
}

function okResponse(text: string): HttpResponseLike {
  return { status: 200, text: async () => text };
}

// -------------------------------------------------------- credentialsPathFor

describe('credentialsPathFor', () => {
  it('a configured configDir wins, regardless of homeDir', () => {
    expect(credentialsPathFor(profile('p', { configDir: '/acct/work' }), HOME)).toBe(
      path.join('/acct/work', CREDENTIALS_FILE),
    );
  });

  it('falls back to <home>/.claude when configDir is unset', () => {
    expect(credentialsPathFor(profile('p'), HOME)).toBe(
      path.join(HOME, DEFAULT_CONFIG_DIR_NAME, CREDENTIALS_FILE),
    );
  });

  it("a blank configDir is treated as unset, not as ''", () => {
    expect(credentialsPathFor(profile('p', { configDir: '   ' }), HOME)).toBe(
      path.join(HOME, DEFAULT_CONFIG_DIR_NAME, CREDENTIALS_FILE),
    );
  });

  it("returns '' when there is neither a configDir nor a usable homeDir", () => {
    expect(credentialsPathFor(profile('p'), '')).toBe('');
  });
});

// -------------------------------------------------------------- parseResetAt

describe('parseResetAt', () => {
  it('epoch milliseconds pass through unchanged', () => {
    expect(parseResetAt(1_780_000_000_000)).toBe(1_780_000_000_000);
  });

  it('epoch seconds (below the 1e12 boundary) are scaled to ms', () => {
    expect(parseResetAt(1_780_000_000)).toBe(1_780_000_000_000);
  });

  it('an ISO string normalises through Date.parse', () => {
    expect(parseResetAt('2026-03-10T00:00:00.000Z')).toBe(
      Date.parse('2026-03-10T00:00:00.000Z'),
    );
  });

  it.each([['not-a-date'], [''], [null], [undefined], [0], [-5], [NaN]])(
    'is undefined for %p',
    (v) => {
      expect(parseResetAt(v)).toBeUndefined();
    },
  );
});

// ------------------------------------------------------------- parseUsageBody

describe('parseUsageBody', () => {
  it('a 0-100 body normalises as-is, with an ISO reset', () => {
    const out = parseUsageBody(
      JSON.stringify({
        five_hour: { utilization: 62 },
        seven_day: { utilization: 41, resets_at: '2026-03-10T00:00:00.000Z' },
      }),
      BASE,
    );
    expect(out?.fiveHour).toEqual({ utilization: 62 });
    expect(out?.sevenDay).toEqual({
      utilization: 41,
      resetsAt: Date.parse('2026-03-10T00:00:00.000Z'),
    });
    expect(out?.fetchedAt).toBe(BASE);
  });

  it('a 0-1 body is scaled to a percentage, with an epoch-seconds reset', () => {
    const out = parseUsageBody(
      JSON.stringify({
        fiveHour: { utilization: 0.62 },
        sevenDay: { utilization: 0.41, reset: 1_780_000_000 },
      }),
      BASE,
    );
    expect(out?.fiveHour?.utilization).toBe(62);
    expect(out?.sevenDay?.utilization).toBe(41);
    expect(out?.sevenDay?.resetsAt).toBe(1_780_000_000_000);
  });

  it('a lone `1` reads as a FULL window (100%), not 1%', () => {
    const out = parseUsageBody(JSON.stringify({ fiveHour: 1 }), BASE);
    expect(out?.fiveHour?.utilization).toBe(100);
  });

  it('an array-of-limits payload matches windows by name, wherever it is nested', () => {
    const out = parseUsageBody(
      JSON.stringify({
        usage: {
          limits: [
            { name: 'five_hour', utilization: 30 },
            { type: 'weekly', percent: 20 },
          ],
        },
      }),
      BASE,
    );
    expect(out?.fiveHour?.utilization).toBe(30);
    expect(out?.sevenDay?.utilization).toBe(20);
  });

  it('a recognised window key with no readable number is a VALID empty snapshot, not a drop to null', () => {
    const out = parseUsageBody(JSON.stringify({ fiveHour: {} }), BASE);
    expect(out).not.toBeNull();
    expect(out?.fiveHour).toBeUndefined();
    expect(out?.fetchedAt).toBe(BASE);
  });

  it('a body with no recognisable window key at all is null, not an empty snapshot', () => {
    expect(parseUsageBody(JSON.stringify({ hello: 'world', nested: { a: 1, b: 2 } }), BASE)).toBeNull();
  });

  it('malformed JSON and an empty string are both null', () => {
    expect(parseUsageBody('{not json', BASE)).toBeNull();
    expect(parseUsageBody('', BASE)).toBeNull();
    expect(parseUsageBody('   ', BASE)).toBeNull();
  });
});

// ------------------------------------------------------------------ weekdayFor

describe('weekdayFor', () => {
  it("is '' for a non-finite or non-positive epoch", () => {
    expect(weekdayFor(NaN)).toBe('');
    expect(weekdayFor(0)).toBe('');
    expect(weekdayFor(-100)).toBe('');
  });

  it('agrees with Date.getDay() across a full week', () => {
    const NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (let i = 0; i < 7; i++) {
      const t = BASE + i * 24 * 60 * 60 * 1000;
      expect(weekdayFor(t)).toBe(NAMES[new Date(t).getDay()]);
    }
  });
});

// -------------------------------------------------------------- supportsUsage

describe('supportsUsage', () => {
  it('true for a claude or codex profile without an API-key-shaped extraEnv', () => {
    expect(supportsUsage(profile('a'))).toBe(true);
    // Codex is read off its rollouts now (see codexUsage.test.ts).
    expect(supportsUsage(profile('b', { provider: 'codex' }))).toBe(true);
    expect(supportsUsage(profile('b2', { provider: 'codex', extraEnv: { OPENAI_API_KEY: 'x' } }))).toBe(false);
    expect(supportsUsage(profile('c', { provider: 'gemini' }))).toBe(false);
    expect(supportsUsage(profile('d', { provider: 'generic' }))).toBe(false);
    expect(supportsUsage(profile('e', { extraEnv: { ANTHROPIC_API_KEY: 'x' } }))).toBe(false);
    expect(supportsUsage(profile('f', { extraEnv: { ANTHROPIC_AUTH_TOKEN: 'x' } }))).toBe(false);
    // key match is case-insensitive on the NAME, never on the value
    expect(supportsUsage(profile('g', { extraEnv: { anthropic_api_key: 'x' } }))).toBe(false);
    expect(supportsUsage(profile('h', { extraEnv: { SOME_OTHER_VAR: 'x' } }))).toBe(true);
  });
});

// -------------------------------------------------------------- formatUsageSummary

describe('formatUsageSummary', () => {
  const RESET_AT = Date.parse('2026-03-10T00:00:00.000Z');
  const DAY = weekdayFor(RESET_AT);

  function snap(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
    return { fetchedAt: BASE, ...over };
  }

  // NO snapshot is not a failure: it is what readUsage returns for every
  // account this module knowingly does not serve (Codex, API-key), which on a
  // mixed machine is most of the rows. Those rows say nothing rather than
  // carrying a permanent "usage n/a" that trains the eye to skip the line.
  it('null/undefined -> "" (nothing to say, not a failure)', () => {
    expect(formatUsageSummary(null)).toBe('');
    expect(formatUsageSummary(undefined)).toBe('');
  });

  it('a fresh empty snapshot (no windows, no error, not stale) -> "usage n/a"', () => {
    expect(formatUsageSummary(snap())).toBe('usage n/a');
  });

  it('no windows but stale -> "usage stale"', () => {
    expect(formatUsageSummary(snap({ stale: true }))).toBe('usage stale');
  });

  it("error 'no-credentials' -> \"not logged in\"", () => {
    expect(formatUsageSummary(snap({ error: 'no-credentials' }))).toBe('not logged in');
  });

  it("error 'expired' -> \"login expired\"", () => {
    expect(formatUsageSummary(snap({ error: 'expired' }))).toBe('login expired');
  });

  it("error 'http' and 'parse' both -> \"usage unavailable\"", () => {
    expect(formatUsageSummary(snap({ error: 'http' }))).toBe('usage unavailable');
    expect(formatUsageSummary(snap({ error: 'parse' }))).toBe('usage unavailable');
  });

  it('five-hour and weekly windows join with the weekday of the weekly reset', () => {
    expect(
      formatUsageSummary(
        snap({
          fiveHour: { utilization: 62 },
          sevenDay: { utilization: 41, resetsAt: RESET_AT },
        }),
      ),
    ).toBe(`5h 62% · wk 41% → ${DAY}`);
  });

  it('a stale successful snapshot appends " · stale" after the reset day', () => {
    expect(
      formatUsageSummary(
        snap({
          fiveHour: { utilization: 62 },
          sevenDay: { utilization: 41, resetsAt: RESET_AT },
          stale: true,
        }),
      ),
    ).toBe(`5h 62% · wk 41% → ${DAY} · stale`);
  });

  it('an opus window joins as a third segment, and falls back to the opus reset when sevenDay has none', () => {
    expect(
      formatUsageSummary(
        snap({
          fiveHour: { utilization: 10 },
          sevenDayOpus: { utilization: 5, resetsAt: RESET_AT },
        }),
      ),
    ).toBe(`5h 10% · opus 5% → ${DAY}`);
  });

  it('no resetsAt anywhere omits the arrow entirely', () => {
    expect(formatUsageSummary(snap({ fiveHour: { utilization: 10 } }))).toBe('5h 10%');
  });

  it('a five-hour resetsAt puts the time LEFT on the 5h segment, same arrow as the weekly day', () => {
    const now = Date.parse('2026-03-09T12:00:00.000Z');
    expect(
      formatUsageSummary(
        snap({
          fiveHour: { utilization: 62, resetsAt: now + (2 * 60 + 10) * 60_000 },
          sevenDay: { utilization: 41, resetsAt: RESET_AT },
        }),
        now,
      ),
    ).toBe(`5h 62% → 2h 10m · wk 41% → ${DAY}`);
  });

  it('a five-hour reset already behind the clock says nothing — a stale duration is worse than none', () => {
    const now = Date.parse('2026-03-09T12:00:00.000Z');
    expect(
      formatUsageSummary(
        snap({ fiveHour: { utilization: 62, resetsAt: now - 60_000 } }),
        now,
      ),
    ).toBe('5h 62%');
  });

  it('resetInLabel: minutes under the hour, exact hours, hours-and-minutes, floor at 1m', () => {
    const now = 1_000_000_000_000;
    expect(resetInLabel(now + 45 * 60_000, now)).toBe('45m');
    expect(resetInLabel(now + 3 * 3_600_000, now)).toBe('3h');
    expect(resetInLabel(now + (60 + 20) * 60_000, now)).toBe('1h 20m');
    expect(resetInLabel(now + 10_000, now)).toBe('1m');
    expect(resetInLabel(now, now)).toBe('');
    expect(resetInLabel(undefined, now)).toBe('');
    expect(resetInLabel(Number.NaN, now)).toBe('');
  });

  it('percentLabel never rounds up to 100 unless the value already is 100', () => {
    expect(formatUsageSummary(snap({ fiveHour: { utilization: 99.6 } }))).toBe('5h 99%');
    expect(formatUsageSummary(snap({ fiveHour: { utilization: 100 } }))).toBe('5h 100%');
    expect(formatUsageSummary(snap({ fiveHour: { utilization: 0 } }))).toBe('5h 0%');
  });
});

// ============================================================== LimitsService

describe('LimitsService — credential resolution order', () => {
  it('a credentials FILE on the default account wins outright — the keychain is never probed', async () => {
    let clock = BASE;
    const filePath = credentialsPathFor(profile('p'), HOME);
    const readFile = vi.fn(async (file: string): Promise<string | null> =>
      file === filePath ? credBlob('TOKEN-FILE') : null,
    );
    const exec = vi.fn(async (): Promise<string | null> => credBlob('TOKEN-KEYCHAIN'));
    let authHeader = '';
    const fetchFn = vi.fn(async (_url: string, init: HttpRequestInit): Promise<HttpResponseLike> => {
      authHeader = init.headers['Authorization'];
      return okResponse(bodyWithFiveHour(7));
    });
    const service = new LimitsService({
      readFile,
      exec,
      fetch: fetchFn,
      now: () => clock,
      homeDir: HOME,
      platform: 'darwin',
    });

    const out = await service.readUsage(profile('p'));
    expect(out?.fiveHour?.utilization).toBe(7);
    expect(authHeader).toBe('Bearer TOKEN-FILE');
    expect(exec).not.toHaveBeenCalled();
  });

  it('a custom configDir with no credentials file probes the keychain under its OWN hashed service', async () => {
    let clock = BASE;
    const readFile = vi.fn(async (): Promise<string | null> => null); // nothing at that path
    const exec = vi.fn(async (): Promise<string | null> => credBlob('TOKEN-KEYCHAIN'));
    let authHeader = '';
    const fetchFn = vi.fn(async (_url: string, init: HttpRequestInit): Promise<HttpResponseLike> => {
      authHeader = init.headers['Authorization'];
      return okResponse(bodyWithFiveHour(9));
    });
    const service = new LimitsService({
      readFile,
      exec,
      fetch: fetchFn,
      now: () => clock,
      homeDir: HOME,
      platform: 'darwin',
    });

    // The empirical vector this scheme was verified against (2026-08-02,
    // Claude Code 2.1.220): this exact path produced this exact keychain item.
    const p = profile('p', { configDir: '/Users/axelh/.lineage/profiles/personal' });
    const out = await service.readUsage(p);
    expect(out?.fiveHour?.utilization).toBe(9);
    expect(authHeader).toBe('Bearer TOKEN-KEYCHAIN');
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials-dd2b293a', '-w'],
      KEYCHAIN_TIMEOUT_MS,
    );
  });

  it('a custom configDir whose keychain item is ALSO missing is "no-credentials"', async () => {
    let clock = BASE;
    const readFile = vi.fn(async (): Promise<string | null> => null);
    const exec = vi.fn(async (): Promise<string | null> => null); // keychain miss
    const fetchFn = vi.fn(async (): Promise<HttpResponseLike> => okResponse(bodyWithFiveHour(1)));
    const service = new LimitsService({
      readFile,
      exec,
      fetch: fetchFn,
      now: () => clock,
      homeDir: HOME,
      platform: 'darwin',
    });

    const out = await service.readUsage(profile('p', { configDir: '/acct/work' }));
    expect(out?.error).toBe('no-credentials');
    expect(exec).toHaveBeenCalledTimes(1);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('off macOS, a custom configDir with no file is "no-credentials" — no keychain tier', async () => {
    let clock = BASE;
    const readFile = vi.fn(async (): Promise<string | null> => null);
    const exec = vi.fn(async (): Promise<string | null> => credBlob('TOKEN-KEYCHAIN'));
    const fetchFn = vi.fn(async (): Promise<HttpResponseLike> => okResponse(bodyWithFiveHour(1)));
    const service = new LimitsService({
      readFile,
      exec,
      fetch: fetchFn,
      now: () => clock,
      homeDir: HOME,
      platform: 'linux',
    });

    const out = await service.readUsage(profile('p', { configDir: '/acct/work' }));
    expect(out?.error).toBe('no-credentials');
    expect(exec).not.toHaveBeenCalled();
  });

  it('the default account with no file falls back to the macOS keychain, with the documented exact argv', async () => {
    let clock = BASE;
    const readFile = vi.fn(async (): Promise<string | null> => null);
    const exec = vi.fn(async (): Promise<string | null> => credBlob('TOKEN-KEYCHAIN'));
    let authHeader = '';
    const fetchFn = vi.fn(async (_url: string, init: HttpRequestInit): Promise<HttpResponseLike> => {
      authHeader = init.headers['Authorization'];
      return okResponse(bodyWithFiveHour(3));
    });
    const service = new LimitsService({
      readFile,
      exec,
      fetch: fetchFn,
      now: () => clock,
      homeDir: HOME,
      platform: 'darwin',
    });

    const out = await service.readUsage(profile('p'));
    expect(out?.fiveHour?.utilization).toBe(3);
    expect(authHeader).toBe('Bearer TOKEN-KEYCHAIN');
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      KEYCHAIN_TIMEOUT_MS,
    );
  });

  it('off macOS, the default account with no file is "no-credentials" — the keychain tier does not exist there', async () => {
    let clock = BASE;
    const readFile = vi.fn(async (): Promise<string | null> => null);
    const exec = vi.fn(async (): Promise<string | null> => credBlob('TOKEN-KEYCHAIN'));
    const fetchFn = vi.fn(async (): Promise<HttpResponseLike> => okResponse(bodyWithFiveHour(1)));
    const service = new LimitsService({
      readFile,
      exec,
      fetch: fetchFn,
      now: () => clock,
      homeDir: HOME,
      platform: 'linux',
    });

    const out = await service.readUsage(profile('p'));
    expect(out?.error).toBe('no-credentials');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('keychainServiceFor — the per-config-dir service name', () => {
  it('no dir / blank dir -> the bare default service', () => {
    expect(keychainServiceFor(undefined)).toBe(KEYCHAIN_SERVICE);
    expect(keychainServiceFor('')).toBe(KEYCHAIN_SERVICE);
    expect(keychainServiceFor('   ')).toBe(KEYCHAIN_SERVICE);
  });

  it('pins BOTH empirical vectors from the machine the scheme was discovered on', () => {
    // security dump-keychain, 2026-08-02: these dirs' logins were stored under
    // exactly these items. If the hash, the slice, or the join drifts, this
    // fails before a user ever sees "not logged in" again.
    expect(keychainServiceFor('/Users/axelh/.lineage/profiles/personal')).toBe(
      'Claude Code-credentials-dd2b293a',
    );
    expect(keychainServiceFor('/Users/axelh/.lineage/profiles/magma')).toBe(
      'Claude Code-credentials-2f6ab2d0',
    );
  });

  it('hashes the EXACT string — a trailing slash is a different service', () => {
    expect(keychainServiceFor('/a/b/')).not.toBe(keychainServiceFor('/a/b'));
  });
});

describe('LimitsService — signedInAs identity', () => {
  it('a signed-in profile whose credential cannot be read reports WHO it is, not "not logged in"', async () => {
    let clock = BASE;
    const dir = '/acct/personal';
    const identity = path.join(dir, IDENTITY_FILE);
    const readFile = vi.fn(async (file: string): Promise<string | null> =>
      file === identity
        ? JSON.stringify({ oauthAccount: { emailAddress: 'axel.hagerud@gmail.com' } })
        : null,
    );
    const exec = vi.fn(async (): Promise<string | null> => null); // keychain miss
    const fetchFn = vi.fn(async (): Promise<HttpResponseLike> => okResponse(bodyWithFiveHour(1)));
    const service = new LimitsService({
      readFile,
      exec,
      fetch: fetchFn,
      now: () => clock,
      homeDir: HOME,
      platform: 'darwin',
    });

    const out = await service.readUsage(profile('p', { configDir: dir }));
    expect(out?.error).toBe('no-credentials');
    expect(out?.signedInAs).toBe('axel.hagerud@gmail.com');
    expect(formatUsageSummary(out)).toBe('axel.hagerud@gmail.com · usage unavailable');
  });

  it("the DEFAULT account's identity file is ~/.claude.json at the HOME ROOT, not inside ~/.claude", async () => {
    let clock = BASE;
    const identity = path.join(HOME, IDENTITY_FILE);
    const filePath = credentialsPathFor(profile('p'), HOME);
    const readFile = vi.fn(async (file: string): Promise<string | null> => {
      if (file === filePath) return credBlob('TOKEN-FILE');
      if (file === identity)
        return JSON.stringify({ oauthAccount: { emailAddress: 'axel@magmamath.com' } });
      return null;
    });
    const exec = vi.fn(async (): Promise<string | null> => null);
    const fetchFn = vi.fn(async (): Promise<HttpResponseLike> => okResponse(bodyWithFiveHour(4)));
    const service = new LimitsService({
      readFile,
      exec,
      fetch: fetchFn,
      now: () => clock,
      homeDir: HOME,
      platform: 'darwin',
    });

    const out = await service.readUsage(profile('p'));
    expect(out?.fiveHour?.utilization).toBe(4); // success ALSO carries identity
    expect(out?.signedInAs).toBe('axel@magmamath.com');
  });

  it('a missing or malformed identity file is simply no name — never an error state', async () => {
    let clock = BASE;
    const readFile = vi.fn(async (file: string): Promise<string | null> =>
      file.endsWith(IDENTITY_FILE) ? '{not json' : null,
    );
    const exec = vi.fn(async (): Promise<string | null> => null);
    const fetchFn = vi.fn(async (): Promise<HttpResponseLike> => okResponse(bodyWithFiveHour(1)));
    const service = new LimitsService({
      readFile,
      exec,
      fetch: fetchFn,
      now: () => clock,
      homeDir: HOME,
      platform: 'darwin',
    });

    const out = await service.readUsage(profile('p', { configDir: '/acct/x' }));
    expect(out?.error).toBe('no-credentials');
    expect(out?.signedInAs).toBeUndefined();
    expect(formatUsageSummary(out)).toBe('not logged in');
  });
});

describe('LimitsService — expiresAt is honoured', () => {
  it('an already-expired token short-circuits to "expired" WITHOUT any network call', async () => {
    let clock = BASE;
    const filePath = credentialsPathFor(profile('p'), HOME);
    const readFile = vi.fn(async (file: string): Promise<string | null> =>
      file === filePath ? credBlob('TOKEN-EXPIRED', new Date(BASE - 1000).toISOString()) : null,
    );
    const exec = vi.fn(async (): Promise<string | null> => null);
    const fetchFn = vi.fn(async (): Promise<HttpResponseLike> => okResponse(bodyWithFiveHour(1)));
    const service = new LimitsService({
      readFile,
      exec,
      fetch: fetchFn,
      now: () => clock,
      homeDir: HOME,
      platform: 'darwin',
    });

    const out = await service.readUsage(profile('p'));
    expect(out?.error).toBe('expired');
    expect(out?.stale).toBeUndefined(); // nothing was stale — the login is just dead
    expect(fetchFn).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled(); // a file result, expired or not, never falls through
  });

  it('a token that expires in the future is used normally', async () => {
    let clock = BASE;
    const filePath = credentialsPathFor(profile('p'), HOME);
    const readFile = vi.fn(async (file: string): Promise<string | null> =>
      file === filePath ? credBlob('TOKEN-LIVE', BASE + 60 * 60 * 1000) : null,
    );
    const fetchFn = vi.fn(async (): Promise<HttpResponseLike> => okResponse(bodyWithFiveHour(9)));
    const service = new LimitsService({
      readFile,
      fetch: fetchFn,
      now: () => clock,
      homeDir: HOME,
      platform: 'darwin',
    });

    const out = await service.readUsage(profile('p'));
    expect(out?.fiveHour?.utilization).toBe(9);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('LimitsService — a lapsed token on a live login is NOT an expired sign-in', () => {
  // REGRESSION, and the loudest one in this file. An OAuth access token lasts
  // hours and the CLI renews it from the refresh token beside it the next time
  // it runs — so an expiry in the past is the ordinary state of an account
  // nobody has used since lunch. Reporting it as "login expired" sent people to
  // `/login` to repair an account that was never broken.

  it('reads a lapsed token WITH a refresh token as token-stale, not expired', async () => {
    const clock = BASE;
    const filePath = credentialsPathFor(profile('p'), HOME);
    const readFile = vi.fn(async (file: string): Promise<string | null> =>
      file === filePath
        ? credBlobWithRefresh('TOKEN-OLD', new Date(BASE - 1000).toISOString())
        : null,
    );
    const fetchFn = vi.fn(async (): Promise<HttpResponseLike> => okResponse(bodyWithFiveHour(1)));
    const service = new LimitsService({
      readFile,
      fetch: fetchFn,
      now: () => clock,
      homeDir: HOME,
      platform: 'darwin',
    });

    const out = await service.readUsage(profile('p'));
    expect(out?.error).toBe('token-stale');
    // Still no round trip — a dead token buys a 401 whatever the reason.
    expect(fetchFn).not.toHaveBeenCalled();
    // And the row says the meter is missing, never that the sign-in is.
    expect(formatUsageSummary(out)).toBe('usage n/a');
  });

  it('a 401 is token-stale too when a refresh token is on file', async () => {
    const clock = BASE;
    const filePath = credentialsPathFor(profile('p'), HOME);
    const readFile = vi.fn(async (file: string): Promise<string | null> =>
      file === filePath ? credBlobWithRefresh('TOKEN') : null,
    );
    const fetchFn = vi.fn(async (): Promise<HttpResponseLike> => ({
      status: 401,
      text: async () => '',
    }));
    const service = new LimitsService({
      readFile,
      fetch: fetchFn,
      now: () => clock,
      homeDir: HOME,
      platform: 'darwin',
    });

    const out = await service.readUsage(profile('p'));
    expect(out?.error).toBe('token-stale');
  });

  it('recovers on the next look, with no backoff to sit out', async () => {
    // The whole point of settling this without a backoff: the CLI refreshes
    // whenever it next runs, and the meter must come back on the next glance
    // rather than fifteen minutes later.
    let clock = BASE;
    let text = credBlobWithRefresh('TOKEN-OLD', new Date(BASE - 1000).toISOString());
    const filePath = credentialsPathFor(profile('p'), HOME);
    const readFile = vi.fn(async (file: string): Promise<string | null> =>
      file === filePath ? text : null,
    );
    const fetchFn = vi.fn(async (): Promise<HttpResponseLike> => okResponse(bodyWithFiveHour(7)));
    const service = new LimitsService({
      readFile,
      fetch: fetchFn,
      now: () => clock,
      homeDir: HOME,
      platform: 'darwin',
    });
    const p = profile('p');

    expect((await service.readUsage(p))?.error).toBe('token-stale');

    // The CLI ran and wrote a fresh token.
    text = credBlobWithRefresh('TOKEN-NEW', BASE + 60 * 60 * 1000);
    clock += MIN_FETCH_INTERVAL_MS + 1;

    const out = await service.readUsage(p);
    expect(out?.error).toBeUndefined();
    expect(out?.fiveHour?.utilization).toBe(7);
  });

  it('still says "login expired" when there is no refresh token to renew from', async () => {
    // The genuine case, and the only one the user can do anything about.
    const clock = BASE;
    const filePath = credentialsPathFor(profile('p'), HOME);
    const readFile = vi.fn(async (file: string): Promise<string | null> =>
      file === filePath ? credBlob('TOKEN-DEAD', new Date(BASE - 1000).toISOString()) : null,
    );
    const service = new LimitsService({
      readFile,
      fetch: vi.fn(async (): Promise<HttpResponseLike> => okResponse('{}')),
      now: () => clock,
      homeDir: HOME,
      platform: 'darwin',
    });

    const out = await service.readUsage(profile('p'));
    expect(out?.error).toBe('expired');
    expect(formatUsageSummary(out)).toBe('login expired');
  });
});

describe('LimitsService — 401 -> expired', () => {
  it('a 401 response is "expired" with no stale flag, and (unlike an http failure) schedules no backoff', async () => {
    let clock = BASE;
    const filePath = credentialsPathFor(profile('p'), HOME);
    const readFile = vi.fn(async (file: string): Promise<string | null> =>
      file === filePath ? credBlob('TOKEN') : null,
    );
    const fetchFn = vi.fn(async (): Promise<HttpResponseLike> => ({ status: 401, text: async () => '' }));
    const service = new LimitsService({
      readFile,
      fetch: fetchFn,
      now: () => clock,
      homeDir: HOME,
      platform: 'darwin',
    });
    const p = profile('p');

    const out = await service.readUsage(p);
    expect(out?.error).toBe('expired');
    expect(out?.stale).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Past the min-interval but nowhere near BACKOFF_BASE_MS: if 401 had
    // scheduled a backoff (as an 'http' failure does) this would still be
    // gated. It is not, which is the point of this second call.
    clock += MIN_FETCH_INTERVAL_MS + 1;
    await service.readUsage(p);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe('LimitsService — 429 -> http, with backoff and stale last-good numbers', () => {
  it('degrades to the last good snapshot, backs off exponentially, gates retries until the backoff clears, and force bypasses it', async () => {
    let clock = BASE;
    const filePath = credentialsPathFor(profile('p'), HOME);
    const readFile = vi.fn(async (file: string): Promise<string | null> =>
      file === filePath ? credBlob('TOKEN') : null,
    );
    const responses: HttpResponseLike[] = [
      okResponse(bodyWithFiveHour(30)), // 1: establishes the last GOOD snapshot
      { status: 429, text: async () => '' }, // 2: first failure -> backoff base
      { status: 429, text: async () => '' }, // 4: second failure -> backoff doubles
      okResponse(bodyWithFiveHour(5)), // 5: forced call, ignores the backoff gate
    ];
    let i = 0;
    const fetchFn = vi.fn(async (): Promise<HttpResponseLike> => {
      const r = responses[i];
      i += 1;
      return r;
    });
    const service = new LimitsService({
      readFile,
      fetch: fetchFn,
      now: () => clock,
      homeDir: HOME,
      platform: 'darwin',
    });
    const p = profile('p');

    // 1. establish "good".
    const good = await service.readUsage(p);
    expect(good?.fiveHour?.utilization).toBe(30);
    expect(good?.stale).toBeUndefined();

    // 2. past the interval, the 429 lands: 'http', stale, last-good numbers kept.
    clock += MIN_FETCH_INTERVAL_MS + 1;
    const failed = await service.readUsage(p);
    expect(failed?.error).toBe('http');
    expect(failed?.stale).toBe(true);
    expect(failed?.fiveHour?.utilization).toBe(30);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    // 3. past the interval again, but still inside BACKOFF_BASE_MS: gated,
    //    no third fetch, same cached (stale) answer served back.
    clock += MIN_FETCH_INTERVAL_MS + 1;
    const gated = await service.readUsage(p);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(gated).toEqual(failed);

    // 4. past BACKOFF_BASE_MS: the gate lifts, a third fetch happens, and the
    //    backoff DOUBLES (bounded by BACKOFF_MAX_MS).
    clock += BACKOFF_BASE_MS + 1;
    const failedAgain = await service.readUsage(p);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(failedAgain?.error).toBe('http');
    expect(failedAgain?.fiveHour?.utilization).toBe(30); // still the original good

    // 5. immediately after (well inside both the interval AND the doubled
    //    backoff), an ordinary call is still gated...
    expect(await service.readUsage(p)).toEqual(failedAgain);
    expect(fetchFn).toHaveBeenCalledTimes(3);

    // ...but `force: true` bypasses the interval AND the backoff outright.
    const forced = await service.readUsage(p, { force: true });
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(forced?.fiveHour?.utilization).toBe(5);
    expect(forced?.error).toBeUndefined();
    expect(forced?.stale).toBeUndefined();
  });

  it("BACKOFF_BASE_MS is bounded by BACKOFF_MAX_MS and doesn't grow past it", () => {
    // Pure arithmetic pin, independent of the service: the doubling in
    // settleFailure is `Math.min(backoffMs * 2, BACKOFF_MAX_MS)`, and
    // BACKOFF_MAX_MS itself must be a real ceiling above the base.
    expect(BACKOFF_MAX_MS).toBeGreaterThan(BACKOFF_BASE_MS);
    let backoff = BACKOFF_BASE_MS;
    for (let i = 0; i < 10; i++) backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    expect(backoff).toBe(BACKOFF_MAX_MS);
  });
});

describe('LimitsService — an unrecognised body is "parse", degrading to the last good numbers', () => {
  it('keeps the last good snapshot, marked stale, with error "parse"', async () => {
    let clock = BASE;
    const filePath = credentialsPathFor(profile('p'), HOME);
    const readFile = vi.fn(async (file: string): Promise<string | null> =>
      file === filePath ? credBlob('TOKEN') : null,
    );
    const bodies = [bodyWithFiveHour(62), JSON.stringify({ hello: 'world', nested: { a: 1 } })];
    let i = 0;
    const fetchFn = vi.fn(async (): Promise<HttpResponseLike> => okResponse(bodies[i++]));
    const service = new LimitsService({
      readFile,
      fetch: fetchFn,
      now: () => clock,
      homeDir: HOME,
      platform: 'darwin',
    });
    const p = profile('p');

    const good = await service.readUsage(p);
    expect(good?.fiveHour?.utilization).toBe(62);

    clock += MIN_FETCH_INTERVAL_MS + 1;
    const out = await service.readUsage(p);
    expect(out?.error).toBe('parse');
    expect(out?.stale).toBe(true);
    expect(out?.fiveHour?.utilization).toBe(62);
  });

  it('with no prior good snapshot, a parse failure is just `{ fetchedAt, error }` — not stale (nothing to be stale relative to)', async () => {
    let clock = BASE;
    const filePath = credentialsPathFor(profile('p'), HOME);
    const readFile = vi.fn(async (file: string): Promise<string | null> =>
      file === filePath ? credBlob('TOKEN') : null,
    );
    const fetchFn = vi.fn(async (): Promise<HttpResponseLike> => okResponse('{"nothing":"recognisable"}'));
    const service = new LimitsService({
      readFile,
      fetch: fetchFn,
      now: () => clock,
      homeDir: HOME,
      platform: 'darwin',
    });

    const out = await service.readUsage(profile('p'));
    expect(out?.error).toBe('parse');
    expect(out?.stale).toBeUndefined();
    expect(out?.fetchedAt).toBe(BASE);
  });
});

describe('LimitsService — min-interval guard', () => {
  it('refuses a second fetch inside MIN_FETCH_INTERVAL_MS and serves the exact cached snapshot; force bypasses it', async () => {
    let clock = BASE;
    const filePath = credentialsPathFor(profile('p'), HOME);
    const readFile = vi.fn(async (file: string): Promise<string | null> =>
      file === filePath ? credBlob('TOKEN') : null,
    );
    const bodies = [bodyWithFiveHour(30), bodyWithFiveHour(31)];
    let i = 0;
    const fetchFn = vi.fn(async (): Promise<HttpResponseLike> => okResponse(bodies[i++]));
    const service = new LimitsService({
      readFile,
      fetch: fetchFn,
      now: () => clock,
      homeDir: HOME,
      platform: 'darwin',
    });
    const p = profile('p');

    const first = await service.readUsage(p);
    expect(first?.fiveHour?.utilization).toBe(30);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Same instant: gated, and literally the same cached object (not a
    // re-fetch that happens to agree).
    expect(await service.readUsage(p)).toBe(first);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Still inside the window, seconds later.
    clock += 30_000;
    expect(await service.readUsage(p)).toBe(first);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // force ignores the interval outright.
    const forced = await service.readUsage(p, { force: true });
    expect(forced?.fiveHour?.utilization).toBe(31);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('concurrent callers for the same profile share one in-flight request', async () => {
    let clock = BASE;
    const filePath = credentialsPathFor(profile('p'), HOME);
    const readFile = vi.fn(async (file: string): Promise<string | null> =>
      file === filePath ? credBlob('TOKEN') : null,
    );
    let releaseGate!: (r: HttpResponseLike) => void;
    const gate = new Promise<HttpResponseLike>((res) => {
      releaseGate = res;
    });
    const fetchFn = vi.fn(async (): Promise<HttpResponseLike> => gate);
    const service = new LimitsService({
      readFile,
      fetch: fetchFn,
      now: () => clock,
      homeDir: HOME,
      platform: 'darwin',
    });
    const p = profile('p');

    const a = service.readUsage(p);
    const b = service.readUsage(p);
    // Credential resolution (the readFile fake) is itself async, so give both
    // callers' in-flight machinery a few microtask turns to reach the fetch
    // before asserting how many requests it produced.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(fetchFn).toHaveBeenCalledTimes(1); // one request, two askers

    releaseGate(okResponse(bodyWithFiveHour(8)));
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual(rb);
    expect(ra?.fiveHour?.utilization).toBe(8);
  });
});

describe('LimitsService — profiles this file has nothing to say about', () => {
  function spyHarness(): { service: LimitsService; readFile: ReturnType<typeof vi.fn>; exec: ReturnType<typeof vi.fn>; fetchFn: ReturnType<typeof vi.fn> } {
    const readFile = vi.fn(async (): Promise<string | null> => credBlob('TOKEN'));
    const exec = vi.fn(async (): Promise<string | null> => credBlob('TOKEN'));
    const fetchFn = vi.fn(async (): Promise<HttpResponseLike> => okResponse(bodyWithFiveHour(1)));
    const service = new LimitsService({
      readFile,
      exec,
      fetch: fetchFn,
      now: () => BASE,
      homeDir: HOME,
      platform: 'darwin',
    });
    return { service, readFile, exec, fetchFn };
  }

  it('gemini and generic profiles answer null without touching a single dependency', async () => {
    const { service, readFile, exec, fetchFn } = spyHarness();
    for (const provider of ['gemini', 'generic'] as const) {
      expect(await service.readUsage(profile(`p-${provider}`, { provider }))).toBeNull();
    }
    expect(readFile).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('an ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN profile answers null — a per-token account has no windows', async () => {
    const { service, fetchFn } = spyHarness();
    const p1 = profile('key1', { extraEnv: { ANTHROPIC_API_KEY: 'sk-should-never-be-read' } });
    const p2 = profile('key2', { extraEnv: { anthropic_auth_token: 'sk-lowercase-key-name' } });
    expect(await service.readUsage(p1)).toBeNull();
    expect(await service.readUsage(p2)).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('an empty profile id answers null', async () => {
    const { service } = spyHarness();
    expect(await service.readUsage(profile(''))).toBeNull();
  });

  it('a disposed service answers null for everything, without touching a dependency', async () => {
    const { service, readFile, exec, fetchFn } = spyHarness();
    service.dispose();
    expect(await service.readUsage(profile('p'))).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('LimitsService — reader conveniences', () => {
  function harness() {
    let clock = BASE;
    const filePath = credentialsPathFor(profile('p'), HOME);
    const readFile = vi.fn(async (file: string): Promise<string | null> =>
      file === filePath ? credBlob('TOKEN') : null,
    );
    const fetchFn = vi.fn(async (): Promise<HttpResponseLike> => okResponse(bodyWithFiveHour(10)));
    const service = new LimitsService({
      readFile,
      fetch: fetchFn,
      now: () => clock,
      homeDir: HOME,
      platform: 'darwin',
    });
    return { service, setClock: (t: number): void => { clock = t; }, fetchFn };
  }

  it('cached() is null before any read', () => {
    const { service } = harness();
    expect(service.cached(profile('p'))).toBeNull();
  });

  it('cached() mirrors the read, then flips stale after STALE_AFTER_MS while keeping the numbers', async () => {
    const { service, setClock } = harness();
    const p = profile('p');
    await service.readUsage(p);
    expect(service.cached(p)?.stale).toBeUndefined();

    setClock(BASE + STALE_AFTER_MS + 1);
    const aged = service.cached(p);
    expect(aged?.stale).toBe(true);
    expect(aged?.fiveHour?.utilization).toBe(10);
  });

  it('snapshotMap() is cache-only: null for an unsupported profile, no network for either', async () => {
    const { service, fetchFn } = harness();
    const claudeP = profile('a');
    const codexP = profile('b', { provider: 'codex' });
    await service.readUsage(claudeP);
    const callsBefore = fetchFn.mock.calls.length;

    const map = service.snapshotMap([claudeP, codexP]);
    expect(map.get('a')?.fiveHour?.utilization).toBe(10);
    expect(map.get('b')).toBeNull();
    expect(fetchFn.mock.calls.length).toBe(callsBefore);
  });

  it('forget() drops the cache and fires onDidChange exactly once; forgetting an unknown id is a silent no-op', async () => {
    const { service } = harness();
    const p = profile('p');
    await service.readUsage(p);
    expect(service.cached(p)).not.toBeNull();

    const changed = vi.fn();
    service.onDidChange(changed);
    service.forget('p');
    expect(service.cached(p)).toBeNull();
    expect(changed).toHaveBeenCalledTimes(1);

    service.forget('never-seen');
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('createLimitsService() produces a working instance with the same real-default shape', () => {
    const service = createLimitsService();
    expect(service.cached(profile('never-read'))).toBeNull();
    service.dispose();
  });
});

// ==================================================================== redaction

describe('redaction — the token a fake credential provides never leaks', () => {
  const TOKEN = 'sk-ant-oat01-REDACT-ME-do-not-log-1234567890abcdef';
  let logLines: string[];

  beforeEach(() => {
    logLines = [];
    setLogSink((line) => logLines.push(line));
  });

  afterEach(() => {
    setLogSink(null);
  });

  /** Every one of these must come back clean, and the log captured so far
   *  must too. */
  function assertNoLeak(...values: unknown[]): void {
    for (const v of values) {
      const text = typeof v === 'string' ? v : JSON.stringify(v);
      expect(text?.includes(TOKEN) ?? false).toBe(false);
    }
    expect(logLines.join('\n').includes(TOKEN)).toBe(false);
  }

  it('a successful read sends the token ONLY in the Authorization header — never in the returned snapshot, cache, summary or log, even when the server echoes it back', async () => {
    let clock = BASE;
    const filePath = credentialsPathFor(profile('p'), HOME);
    const readFile = vi.fn(async (file: string): Promise<string | null> =>
      file === filePath ? credBlob(TOKEN) : null,
    );
    let capturedAuth = '';
    const fetchFn = vi.fn(async (_url: string, init: HttpRequestInit): Promise<HttpResponseLike> => {
      capturedAuth = init.headers['Authorization'];
      // A server that echoes the bearer token back in the body must not
      // become a leak either: parseUsageBody only ever pulls NUMBERS out of
      // known keys, never an arbitrary string value, into the snapshot.
      return okResponse(JSON.stringify({ five_hour: { utilization: 12 }, echo: { accessToken: TOKEN } }));
    });
    const service = new LimitsService({
      readFile,
      fetch: fetchFn,
      now: () => clock,
      homeDir: HOME,
      platform: 'darwin',
    });

    let thrown: unknown = null;
    let snapshot: UsageSnapshot | null = null;
    try {
      snapshot = await service.readUsage(profile('p'));
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeNull(); // readUsage must never throw
    expect(capturedAuth).toBe(`Bearer ${TOKEN}`); // proves the harness really wired the token through
    expect(snapshot?.fiveHour?.utilization).toBe(12); // the echoed field never entered the snapshot
    assertNoLeak(snapshot, service.cached(profile('p')), formatUsageSummary(snapshot));
  });

  it('a keychain-sourced token is equally invisible outside its header', async () => {
    const readFile = vi.fn(async (): Promise<string | null> => null); // forces the keychain tier
    const exec = vi.fn(async (): Promise<string | null> => credBlob(TOKEN));
    let capturedAuth = '';
    const fetchFn = vi.fn(async (_url: string, init: HttpRequestInit): Promise<HttpResponseLike> => {
      capturedAuth = init.headers['Authorization'];
      return okResponse(bodyWithFiveHour(5));
    });
    const service = new LimitsService({
      readFile,
      exec,
      fetch: fetchFn,
      now: () => BASE,
      homeDir: HOME,
      platform: 'darwin',
    });

    const snapshot = await service.readUsage(profile('p'));
    expect(capturedAuth).toBe(`Bearer ${TOKEN}`);
    assertNoLeak(snapshot);
  });

  it('a 401, a 500, and an unrecognised body all degrade without ever quoting the token — the only things logged are the profile id and the failure kind', async () => {
    let clock = BASE;
    const filePath = credentialsPathFor(profile('p'), HOME);
    const readFile = vi.fn(async (file: string): Promise<string | null> =>
      file === filePath ? credBlob(TOKEN) : null,
    );
    const responses: HttpResponseLike[] = [
      okResponse(bodyWithFiveHour(20)), // good, to have something to degrade to
      { status: 500, text: async () => '' },
      okResponse('{"nothing":"recognisable"}'),
      { status: 401, text: async () => '' },
    ];
    let i = 0;
    const fetchFn = vi.fn(async (): Promise<HttpResponseLike> => responses[i++]);
    const service = new LimitsService({
      readFile,
      fetch: fetchFn,
      now: () => clock,
      homeDir: HOME,
      platform: 'darwin',
    });
    const p = profile('p');

    await service.readUsage(p);
    clock += MIN_FETCH_INTERVAL_MS + 1;
    const afterHttp = await service.readUsage(p);
    // A 'parse' failure backs off too (doubling from the 'http' step above),
    // so clear the gate with a jump past BACKOFF_MAX_MS — a bound that holds
    // no matter how far the backoff has doubled by this point.
    clock += BACKOFF_MAX_MS + 1;
    const afterParse = await service.readUsage(p);
    clock += BACKOFF_MAX_MS + 1;
    const afterExpired = await service.readUsage(p);

    expect(afterHttp?.error).toBe('http');
    expect(afterParse?.error).toBe('parse');
    expect(afterExpired?.error).toBe('expired');
    assertNoLeak(afterHttp, afterParse, afterExpired);
  });

  it('a missing/expired credential path never touches the token at all — there is nothing to leak', async () => {
    const readFile = vi.fn(async (): Promise<string | null> =>
      credBlob(TOKEN, new Date(BASE - 1000).toISOString()),
    );
    const service = new LimitsService({
      readFile,
      now: () => BASE,
      homeDir: HOME,
      platform: 'darwin',
    });
    const snapshot = await service.readUsage(profile('p'));
    expect(snapshot?.error).toBe('expired');
    assertNoLeak(snapshot);
  });
});
