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
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { setLogSink } from '../src/log';
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  CREDENTIALS_FILE,
  DEFAULT_CONFIG_DIR_NAME,
  KEYCHAIN_SERVICE,
  KEYCHAIN_TIMEOUT_MS,
  LimitsService as ProductionLimitsService,
  MIN_FETCH_INTERVAL_MS,
  REQUEST_SPACING_MS,
  STALE_AFTER_MS,
  USAGE_CACHE_TTL_MS,
  createLimitsService,
  createUsageCache,
  credentialsPathFor,
  IDENTITY_FILE,
  formatUsageSummary,
  resetInLabel,
  keychainServiceFor,
  parseResetAt,
  parseUsageBody,
  parseUsageCache,
  retryAfterMs,
  supportsUsage,
  weekdayFor,
  clockFor,
} from '../src/limits';
import type {
  CachedUsage,
  LimitsDeps,
  HttpRequestInit,
  HttpResponseLike,
  UsageCacheStore,
} from '../src/limits';
import type { AccountProfile, UsageSnapshot } from '../src/types';

import { createUsageRequestScheduler } from '../src/usageSchedule';

// Parsing and credential tests use zero spacing; the scheduling suite below
// and usageSchedule.test.ts exercise the production budget with controlled time.
class LimitsService extends ProductionLimitsService {
  constructor(deps: LimitsDeps = {}) {
    super({ ...deps, scheduler: deps.scheduler ?? createUsageRequestScheduler(undefined, {
      now: deps.now, sleep: deps.sleep, spacingMs: 0,
    }) });
  }
}

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

  it('a fresh empty snapshot (no windows, no error, not stale) -> "no usage yet"', () => {
    // Not "n/a": nothing failed. This is the state every Codex row is in on a
    // machine where no Codex session has run yet, and "n/a" under a brand-new
    // account reads as a fault the user is meant to go and fix.
    expect(formatUsageSummary(snap())).toBe('no usage yet');
  });

  it('no windows but stale -> "usage stale"', () => {
    expect(formatUsageSummary(snap({ stale: true }))).toBe('usage stale');
  });

  it("error 'no-credentials' -> \"not logged in\"", () => {
    expect(formatUsageSummary(snap({ error: 'no-credentials' }))).toBe('not logged in');
  });

  it("error 'expired' -> \"sign-in expired\", the words the row's action is spelled with", () => {
    expect(formatUsageSummary(snap({ error: 'expired' }))).toBe('sign-in expired');
    expect(formatUsageSummary(snap({ error: 'expired', signedInAs: 'a@b.c' }))).toBe(
      'a@b.c · sign-in expired',
    );
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

  // The weekly-only Codex plans (business, prolite) have no five-hour window,
  // so "→ Sun" was the only reset the row gave and it never said when on Sunday.
  it('a weekly-only account names the moment its week resets', () => {
    const now = Date.parse('2026-09-14T10:32:18.000Z');
    const at = Date.parse('2026-09-20T00:09:21.000Z');
    expect(
      formatUsageSummary(snap({ sevenDay: { utilization: 95, resetsAt: at, minutes: 10080 } }), now),
    ).toBe(`wk 95% → ${weekdayFor(at)} ${clockFor(at)}`);
  });

  it('a weekly reset under a day away, when it decides, is the time left', () => {
    const now = Date.parse('2026-09-19T20:00:00.000Z');
    const at = now + (5 * 60 + 20) * 60_000;
    expect(formatUsageSummary(snap({ sevenDay: { utilization: 95, resetsAt: at } }), now)).toBe(
      'wk 95% → 5h 20m',
    );
  });

  it('a FULL week decides even beside a five-hour window; an open one keeps the weekday', () => {
    const now = Date.parse('2026-09-14T10:00:00.000Z');
    const five = now + 60 * 60_000;
    const at = Date.parse('2026-09-19T14:41:15.000Z');
    expect(
      formatUsageSummary(
        snap({
          fiveHour: { utilization: 10, resetsAt: five },
          sevenDay: { utilization: 100, resetsAt: at },
        }),
        now,
      ),
    ).toBe(`5h 10% → 1h · wk 100% → ${weekdayFor(at)} ${clockFor(at)}`);
    expect(
      formatUsageSummary(
        snap({
          fiveHour: { utilization: 10, resetsAt: five },
          sevenDay: { utilization: 16, resetsAt: at },
        }),
        now,
      ),
    ).toBe(`5h 10% → 1h · wk 16% → ${weekdayFor(at)}`);
  });

  it('clockFor: a local clock time, or nothing for an unusable stamp', () => {
    expect(clockFor(Date.parse('2026-09-20T00:09:21.000Z'))).toMatch(/\d{1,2}[:.]\d{2}/);
    expect(clockFor(Number.NaN)).toBe('');
    expect(clockFor(0)).toBe('');
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

  // ---- the login is not the first token in the document
  //
  // Claude Code keeps every MCP server's OAuth grant in the SAME keychain item
  // as the sign-in, under `mcpOAuth`, and that section comes FIRST. The shape
  // below is the real payload of a profile that had authorised the Figma MCP
  // server (token prefixes changed, structure kept). A walk that took the
  // first `accessToken` in document order sent the Figma token to Anthropic,
  // which answered 429 with an hour-long Retry-After — for that profile only,
  // because the other profile's MCP grants were empty strings.

  /** The real keychain shape: MCP grants first, some live, then the login. */
  function keychainWithMcpGrants(login: Record<string, unknown> | undefined): string {
    const doc: Record<string, unknown> = {
      mcpOAuth: {
        'railway|b12ecd269c942ba3': {
          serverName: 'railway',
          serverUrl: 'https://mcp.railway.com',
          accessToken: '',
          discoveryState: { oauthMetadataFound: true },
        },
        'plugin:figma:figma|d39d3b6252bc1ac5': {
          serverName: 'plugin:figma:figma',
          serverUrl: 'https://mcp.figma.com/mcp',
          accessToken: 'figu_FOREIGN-TOKEN',
          discoveryState: { oauthMetadataFound: true },
          clientId: 'client',
          clientSecret: 'secret',
          redirectUri: 'http://localhost:57740/callback',
          refreshToken: 'figur_FOREIGN-REFRESH',
          expiresAt: BASE + 90 * 24 * 3_600_000,
        },
      },
    };
    if (login !== undefined) doc['claudeAiOauth'] = login;
    return JSON.stringify(doc);
  }

  function serviceOnKeychain(blob: string | null, clock: () => number) {
    let authHeader = '';
    const readFile = vi.fn(async (): Promise<string | null> => null);
    const exec = vi.fn(async (): Promise<string | null> => blob);
    const fetchFn = vi.fn(async (_url: string, init: HttpRequestInit): Promise<HttpResponseLike> => {
      authHeader = init.headers['Authorization'];
      return okResponse(bodyWithFiveHour(54));
    });
    const service = new LimitsService({
      readFile,
      exec,
      fetch: fetchFn,
      now: clock,
      homeDir: HOME,
      platform: 'darwin',
    });
    return { service, fetchFn, auth: () => authHeader };
  }

  it("an MCP server's live token ahead of the login is never the Bearer — the login section is the only one read", async () => {
    const clock = BASE;
    const { service, fetchFn, auth } = serviceOnKeychain(
      keychainWithMcpGrants({
        accessToken: 'sk-ant-oat01-THE-LOGIN',
        refreshToken: 'sk-ant-ort01-REFRESH',
        expiresAt: BASE + 3_600_000,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'team',
      }),
      () => clock,
    );

    const out = await service.readUsage(profile('p', { configDir: '/Users/axelh/.lineage/profiles/magma' }));
    expect(out?.fiveHour?.utilization).toBe(54);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(auth()).toBe('Bearer sk-ant-oat01-THE-LOGIN');
  });

  it('a document with MCP grants and NO login section is "no-credentials" — a foreign token is not a fallback', async () => {
    const clock = BASE;
    const { service, fetchFn } = serviceOnKeychain(keychainWithMcpGrants(undefined), () => clock);

    const out = await service.readUsage(profile('p', { configDir: '/Users/axelh/.lineage/profiles/magma' }));
    expect(out?.error).toBe('no-credentials');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a lapsed login beside a fresh MCP token is token-stale — the MCP token's expiry and refresh token are not the login's", async () => {
    const clock = BASE;
    const { service, fetchFn } = serviceOnKeychain(
      keychainWithMcpGrants({
        accessToken: 'sk-ant-oat01-LAPSED',
        refreshToken: 'sk-ant-ort01-REFRESH',
        expiresAt: BASE - 1,
      }),
      () => clock,
    );

    const out = await service.readUsage(profile('p', { configDir: '/Users/axelh/.lineage/profiles/magma' }));
    expect(out?.error).toBe('token-stale');
    expect(fetchFn).not.toHaveBeenCalled();
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

  it('still says the sign-in expired when there is no refresh token to renew from', async () => {
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
    expect(formatUsageSummary(out)).toBe('sign-in expired');
  });
});

// ------------------------------------------------- the credential kinds, on Windows
//
// WHY THIS BLOCK EXISTS. On native Windows the Accounts section showed
// "Claude — default  axel.hagerud@gmail.com · login expired" on a machine
// whose login was fine. Windows has no keychain, so `.credentials.json` under
// `%USERPROFILE%\.claude` is the ONLY tier there — `platform: 'win32'` below is
// what pins that, exec never being called — and every wrong verdict this file
// can reach is reached from that one file. So each shape the file can plausibly
// have gets a test, and the invariant they share is: nothing but a lapsed token
// with NO refresh token anywhere may render as an expired sign-in.

describe('LimitsService — what a credentials file on Windows is allowed to prove', () => {
  /** One read of the default profile's credentials file, with the file's
   *  contents as the only variable. `win32` on purpose: the keychain tier is
   *  darwin-only, so this exercises the branch a Windows user is actually on
   *  from a Mac (and asserts the keychain is never consulted there). */
  async function readWith(
    text: string | null,
    over: { platform?: string; now?: number } = {},
  ): Promise<{
    out: UsageSnapshot | null;
    fetchFn: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
  }> {
    const filePath = credentialsPathFor(profile('p'), HOME);
    const readFile = vi.fn(async (file: string): Promise<string | null> =>
      file === filePath ? text : null,
    );
    const exec = vi.fn(async (): Promise<string | null> => null);
    const fetchFn = vi.fn(async (): Promise<HttpResponseLike> => okResponse(bodyWithFiveHour(5)));
    const service = new LimitsService({
      readFile,
      exec,
      fetch: fetchFn,
      now: () => over.now ?? BASE,
      homeDir: HOME,
      platform: over.platform ?? 'win32',
    });
    const out = await service.readUsage(profile('p'));
    return { out, fetchFn, exec };
  }

  it('the shape the CLI writes — expiresAt in epoch MILLISECONDS, lapsed, refresh token beside it — is token-stale', async () => {
    const { out, fetchFn, exec } = await readWith(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'TOKEN',
          refreshToken: 'REFRESH',
          expiresAt: BASE - 60 * 60 * 1000, // ms, an hour ago
          scopes: ['user:inference'],
          subscriptionType: 'max',
        },
      }),
    );
    expect(out?.error).toBe('token-stale');
    expect(formatUsageSummary(out)).toBe('usage n/a');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled(); // no keychain off darwin
  });

  it('the same expiry written in epoch SECONDS reads the same — the unit is not what decides', async () => {
    const lapsed = await readWith(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'TOKEN',
          refreshToken: 'REFRESH',
          expiresAt: Math.floor((BASE - 60 * 60 * 1000) / 1000),
        },
      }),
    );
    expect(lapsed.out?.error).toBe('token-stale');

    // And the mirror: a future expiry in seconds must NOT read as a 1970
    // timestamp and kill a live token.
    const live = await readWith(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'TOKEN',
          refreshToken: 'REFRESH',
          expiresAt: Math.floor((BASE + 60 * 60 * 1000) / 1000),
        },
      }),
    );
    expect(live.out?.error).toBeUndefined();
    expect(live.out?.fiveHour?.utilization).toBe(5);
  });

  it('snake_case throughout — claude_ai_oauth / access_token / refresh_token / expires_at — is read, not misread as expired', async () => {
    const { out } = await readWith(
      JSON.stringify({
        claude_ai_oauth: {
          access_token: 'TOKEN',
          refresh_token: 'REFRESH',
          expires_at: BASE - 1000,
        },
      }),
    );
    expect(out?.error).toBe('token-stale');
  });

  it('a refresh token that is NOT a sibling of the access token still counts — "expired" needs the whole file to have none', async () => {
    // The verdict "your sign-in expired" rests on the absence of a refresh
    // token, and absence under one hardcoded key is not absence from the file.
    const { out } = await readWith(
      JSON.stringify({
        claudeAiOauth: { accessToken: 'TOKEN', expiresAt: BASE - 1000 },
        refreshToken: 'REFRESH',
      }),
    );
    expect(out?.error).toBe('token-stale');
    expect(formatUsageSummary(out)).not.toContain('expired');
  });

  it('a token nested one level deeper than the CLI writes it is still found', async () => {
    const { out, fetchFn } = await readWith(
      JSON.stringify({
        credentials: {
          claudeAiOauth: {
            accessToken: 'TOKEN',
            refreshToken: 'REFRESH',
            expiresAt: BASE + 60 * 60 * 1000,
          },
        },
      }),
    );
    expect(out?.error).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('a refresh token with no access token beside it is a LIVE login, not a missing one', async () => {
    // The CLI mints the next access token from this file itself. "not signed
    // in" would send the user to sign in over an account that is signed in.
    const { out } = await readWith(JSON.stringify({ claudeAiOauth: { refreshToken: 'REFRESH' } }));
    expect(out?.error).toBe('token-stale');
    expect(formatUsageSummary(out)).toBe('usage n/a');
  });

  it('a UTF-8 BOM in front of the JSON does not sign the account out', async () => {
    // A Windows editor (Notepad, PowerShell's Set-Content/Out-File) writes one,
    // and JSON.parse throws on it. Before the strip, one invisible character
    // rendered a working login as "not logged in".
    const { out, fetchFn } = await readWith(
      '﻿' +
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'TOKEN',
            refreshToken: 'REFRESH',
            expiresAt: BASE + 60 * 60 * 1000,
          },
        }),
    );
    expect(out?.error).toBeUndefined();
    expect(out?.fiveHour?.utilization).toBe(5);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a file that is not there', null],
    ['a truncated write', '{"claudeAiOauth": {"accessToken"'],
    ['a locked/unreadable file read as an empty string', ''],
    ['a JSON document that is not an object', '"hello"'],
    ['an object with nothing we recognise', '{"note":"moved to the keychain"}'],
  ])('%s is "no credentials", never an expired sign-in', async (_label, text) => {
    const { out } = await readWith(text);
    expect(out?.error).toBe('no-credentials');
    expect(formatUsageSummary(out)).not.toContain('expired');
  });

  it('the genuinely expired file — lapsed, no refresh token anywhere — is the ONLY one that says so', async () => {
    const { out, fetchFn } = await readWith(
      JSON.stringify({ claudeAiOauth: { accessToken: 'TOKEN', expiresAt: BASE - 1000 } }),
    );
    expect(out?.error).toBe('expired');
    expect(formatUsageSummary(out)).toBe('sign-in expired');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('a BOM in the identity file does not cost the row its name', async () => {
    const identity = path.join(HOME, IDENTITY_FILE);
    const readFile = vi.fn(async (file: string): Promise<string | null> =>
      file === identity
        ? '﻿' + JSON.stringify({ oauthAccount: { emailAddress: 'axel.hagerud@gmail.com' } })
        : null,
    );
    const service = new LimitsService({
      readFile,
      exec: vi.fn(async (): Promise<string | null> => null),
      fetch: vi.fn(async (): Promise<HttpResponseLike> => okResponse(bodyWithFiveHour(5))),
      now: () => BASE,
      homeDir: HOME,
      platform: 'win32',
    });
    const out = await service.readUsage(profile('p'));
    expect(out?.signedInAs).toBe('axel.hagerud@gmail.com');
    expect(formatUsageSummary(out)).toBe('axel.hagerud@gmail.com · usage unavailable');
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

// A NON-2xx IS THE ONE FAILURE THAT USED TO LEAVE NO TRACE.
//
// A thrown fetch is logged, and a body that will not parse is logged by the
// caller — but a well-formed 403 or 429 returned silently, and the row it
// produces says only "usage unavailable" with no identity in front of it. So
// the single state a person cannot diagnose from the row was also the single
// state the log said nothing about. The STATUS is the whole diagnosis.

describe('LimitsService — a refused request names its status in the log', () => {
  afterEach(() => setLogSink(null));

  it('logs the status, and never the body', async () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    const filePath = credentialsPathFor(profile('p'), HOME);
    const service = new LimitsService({
      readFile: async (file: string) => (file === filePath ? credBlob('TOKEN') : null),
      // An error body carrying something that must not reach a log. This
      // endpoint is the one place a token could be echoed back, so the body is
      // not read at all on the failure path.
      fetch: async () => ({ status: 403, text: async () => '{"echo":"TOKEN"}' }),
      now: () => BASE,
      homeDir: HOME,
      platform: 'darwin',
    });

    const snap = await service.readUsage(profile('p'));
    expect(snap?.error).toBe('http');
    const joined = lines.join('\n');
    expect(joined).toContain('limits: usage request refused');
    expect(joined).toContain('HTTP 403');
    expect(joined).not.toContain('TOKEN');
  });

  it('says nothing on a 200, and nothing on a 401 — which has its own answer', async () => {
    // 401 is not a refusal to diagnose: it resolves to a sign-in state the row
    // already names in words, so a log line for it would be noise on the one
    // path that is already self-explanatory.
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    const filePath = credentialsPathFor(profile('p'), HOME);
    const service = new LimitsService({
      readFile: async (file: string) => (file === filePath ? credBlob('TOKEN') : null),
      fetch: async () => ({ status: 401, text: async () => '' }),
      now: () => BASE,
      homeDir: HOME,
      platform: 'darwin',
    });

    await service.readUsage(profile('p'));
    expect(lines.join('\n')).not.toContain('usage request refused');
  });
});

// A MANUAL REFRESH TRIES MORE THAN ONCE.
//
// The limit on this endpoint is a BURST limit: several calls in quick
// succession trip it, and it recovers in between. Measured 2026-09-13 — a row
// that had shown nothing for hours answered `200` on the FIRST hand-made call.
// Flock was never being refused; it had asked once, lost the coin flip, and
// backed off for twenty minutes.

describe('LimitsService — manual refresh respects a throttle', () => {
  it.each(['2544', '10800', undefined])('makes one attempt and respects the pause (%s)', async (header) => {
    let clock = BASE;
    const fetch = vi.fn(async (): Promise<HttpResponseLike> => ({
      status: 429, text: async () => '', headers: { get: () => header ?? null },
    }));
    const service = new LimitsService({
      readFile: async () => credBlob('TOKEN'), fetch, now: () => clock, platform: 'linux',
    });
    const first = await service.readUsage(profile('p'), { force: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(first?.retryAt).toBe(BASE + (header ? Number(header) * 1000 : BACKOFF_BASE_MS));
    for (const offset of [10_000, 20_000, 30_000]) {
      clock = BASE + offset;
      await service.readUsage(profile('p'), { force: true });
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    clock = first!.retryAt!;
    await service.readUsage(profile('p'), { force: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

// REMEMBERING THE LAST GOOD READING.
//
// `settleFailure` has always degraded to the last good numbers rather than
// blanking the row — but "last good" lived only in this process's memory, so it
// was empty in every freshly opened window. A window that opened into a
// throttle therefore had nothing to degrade TO, and two accounts whose numbers
// were perfectly readable showed an empty row all evening.

describe('LimitsService — the last good reading survives a restart', () => {
  function cacheDouble(seed?: Map<string, CachedUsage>): {
    store: UsageCacheStore;
    saved: Array<{ id: string; entry: CachedUsage }>;
  } {
    const saved: Array<{ id: string; entry: CachedUsage }> = [];
    return {
      store: {
        load: async () => seed ?? null,
        save: (id, entry) => {
          saved.push({ id, entry });
        },
      },
      saved,
    };
  }

  const p = profile('p', { configDir: '/cfg' });

  function serviceWith(
    cache: UsageCacheStore,
    responses: HttpResponseLike[],
    now = BASE,
  ) {
    const filePath = credentialsPathFor(p, HOME);
    let i = 0;
    return new LimitsService({
      readFile: async (file: string) => (file === filePath ? credBlob('TOKEN') : null),
      fetch: async () => responses[Math.min(i++, responses.length - 1)],
      cache,
      now: () => now,
      homeDir: HOME,
      platform: 'darwin',
    });
  }

  it('writes a success and never writes a failure', async () => {
    const { store, saved } = cacheDouble();
    const service = serviceWith(store, [okResponse(bodyWithFiveHour(30))]);
    await service.readUsage(p);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.id).toBe('p');
    expect(saved[0]?.entry.configDir).toBe('/cfg');
    expect(saved[0]?.entry.snapshot.fiveHour?.utilization).toBe(30);

    // A throttle right after must not overwrite it — a cache of failures is a
    // way to make a row show numbers nobody measured.
    const throttling = serviceWith(cacheDouble().store, []);
    void throttling;
    const { store: s2, saved: saved2 } = cacheDouble();
    const failing = serviceWith(s2, [{ status: 429, text: async () => '' }]);
    await failing.readUsage(p);
    expect(saved2).toEqual([]);
  });

  it('shows the remembered numbers instead of an empty row when the first call is refused', async () => {
    // THE BUG, end to end: a brand-new window (empty memory) whose very first
    // request is throttled.
    const seed = new Map<string, CachedUsage>([
      ['p', { configDir: '/cfg', snapshot: { fetchedAt: BASE - 60_000, fiveHour: { utilization: 14 }, sevenDay: { utilization: 53 } } }],
    ]);
    const { store } = cacheDouble(seed);
    const service = serviceWith(store, [{ status: 429, text: async () => '' }]);

    const snap = await service.readUsage(p);
    expect(snap?.error).toBe('rate-limited');
    // The numbers are THERE, and flagged for what they are.
    expect(snap?.fiveHour?.utilization).toBe(14);
    expect(snap?.sevenDay?.utilization).toBe(53);
    // NOT flagged stale: the reading is a minute old, which is the current
    // answer. `stale` is about the numbers' age, never about whether the
    // attempt behind them failed — that fact rides on `error`.
    expect(snap?.stale).toBeUndefined();
    // Preserve the reading and explain why Flock is waiting to refresh it.
    expect(formatUsageSummary(snap, BASE)).toBe('Flock usage polling paused → 10m · 5h 14% · wk 53%');
  });

  it('serves the remembered numbers before anything has been fetched', async () => {
    const seed = new Map<string, CachedUsage>([
      ['p', { configDir: '/cfg', snapshot: { fetchedAt: BASE - 60_000, fiveHour: { utilization: 14 } } }],
    ]);
    const { store } = cacheDouble(seed);
    const service = serviceWith(store, [okResponse(bodyWithFiveHour(30))]);
    await service.readUsage(p);
    // cached() is the render path that cannot await; after the seed it has an
    // answer on the very first repaint of a new window.
    expect(service.cached(p)).not.toBeNull();
  });

  it('refuses numbers remembered against a DIFFERENT config directory', async () => {
    // A profile whose directory moved is a different login, and its old numbers
    // are somebody else's. Same rule the in-memory entry applies.
    const seed = new Map<string, CachedUsage>([
      ['p', { configDir: '/somewhere-else', snapshot: { fetchedAt: BASE - 60_000, fiveHour: { utilization: 99 } } }],
    ]);
    const { store } = cacheDouble(seed);
    const service = serviceWith(store, [{ status: 429, text: async () => '' }]);
    const snap = await service.readUsage(p);
    expect(snap?.fiveHour).toBeUndefined();
  });

  it('survives a cache that throws on load or save', async () => {
    const angry: UsageCacheStore = {
      load: async () => {
        throw new Error('nope');
      },
      save: () => {
        throw new Error('nope');
      },
    };
    const service = serviceWith(angry, [okResponse(bodyWithFiveHour(30))]);
    const snap = await service.readUsage(p);
    // A cache that will not work is a cache that misses, never a meter that
    // fails.
    expect(snap?.fiveHour?.utilization).toBe(30);
  });
});

describe('LimitsService — a reading that arrives while the window is running', () => {
  // `load` runs once, at startup. That is right for the common path and wrong
  // for the two cases that matter most: another window getting a reading this
  // one cannot, and somebody putting one there by hand. Both used to need a
  // restart before the row could see them.
  const p = profile('p', { configDir: '/cfg' });

  function movingCache(): { store: UsageCacheStore; contents: Map<string, CachedUsage> } {
    const contents = new Map<string, CachedUsage>();
    let loads = 0;
    return {
      contents,
      store: {
        // Memoised, exactly as the real one is: the FIRST load is empty and
        // stays empty for any caller that only ever calls `load`.
        load: async () => (loads++ === 0 ? new Map() : new Map()),
        reload: async () => new Map(contents),
        save: () => undefined,
      },
    };
  }

  it('picks up a reading written after startup, without a restart', async () => {
    const { store, contents } = movingCache();
    const filePath = credentialsPathFor(p, HOME);
    const service = new LimitsService({
      readFile: async (file: string) => (file === filePath ? credBlob('TOKEN') : null),
      fetch: async () => ({ status: 429, text: async () => '' }),
      cache: store,
      sleep: async () => undefined,
      now: () => BASE,
      homeDir: HOME,
      platform: 'darwin',
    });

    // Nothing on disk yet: the row has nothing, and says why.
    const first = await service.readUsage(p);
    expect(first?.error).toBe('rate-limited');
    expect(first?.fiveHour).toBeUndefined();

    // Another window (or a hand-written seed) lands a reading.
    contents.set('p', {
      configDir: '/cfg',
      snapshot: { fetchedAt: BASE, fiveHour: { utilization: 17 }, sevenDay: { utilization: 54 } },
    });

    const second = await service.readUsage(p, { force: true });
    // The numbers are there — no restart — and still honestly flagged.
    expect(second?.fiveHour?.utilization).toBe(17);
    expect(second?.sevenDay?.utilization).toBe(54);
    expect(second?.stale).toBeUndefined();
    expect(second?.error).toBe('rate-limited');
    expect(formatUsageSummary(second, BASE)).toBe('Flock usage polling paused → 10m · 5h 17% · wk 54%');
  });

  it('does not re-read when the refresh succeeded', async () => {
    let reloads = 0;
    const store: UsageCacheStore = {
      load: async () => new Map(),
      reload: async () => {
        reloads += 1;
        return new Map();
      },
      save: () => undefined,
    };
    const filePath = credentialsPathFor(p, HOME);
    const service = new LimitsService({
      readFile: async (file: string) => (file === filePath ? credBlob('TOKEN') : null),
      fetch: async () => okResponse(bodyWithFiveHour(30)),
      cache: store,
      now: () => BASE,
      homeDir: HOME,
      platform: 'darwin',
    });
    await service.readUsage(p);
    // The happy path must not pay for the unhappy one.
    expect(reloads).toBe(0);
  });
});

describe('createUsageCache — a write must not delete what it did not read', () => {
  // THE REGRESSION. The first version rebuilt the whole document from the
  // accounts this window knew about, so an account it had never successfully
  // read — the throttled one the cache exists for — was dropped on the next
  // write. Measured: a seeded entry survived seven minutes before the next
  // repaint erased it. Two windows do the same to each other.
  let dir = '';
  let file = '';

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'flock-usage-'));
    file = path.join(dir, 'usage-cache.json');
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  /** The debounce is 1s; give the write room to land. */
  const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 1_400));

  function doc(accounts: Record<string, { configDir: string; util: number; at: number }>) {
    const out: Record<string, unknown> = {};
    for (const [id, a] of Object.entries(accounts)) {
      out[id] = {
        configDir: a.configDir,
        snapshot: { fetchedAt: a.at, fiveHour: { utilization: a.util } },
      };
    }
    return JSON.stringify({ version: 1, accounts: out });
  }

  it('keeps an account another writer put there', async () => {
    const now = Date.now();
    await fsp.writeFile(file, doc({ magma: { configDir: '/m', util: 16, at: now } }));

    // A window that never loaded, and knows only about `personal`.
    const cache = createUsageCache(file);
    cache.save('personal', {
      configDir: '/p',
      snapshot: { fetchedAt: now, fiveHour: { utilization: 40 } },
    });
    await settled();

    const after = parseUsageCache(await fsp.readFile(file, 'utf-8'), now);
    expect([...(after?.keys() ?? [])].sort()).toEqual(['magma', 'personal']);
    expect(after?.get('magma')?.snapshot.fiveHour?.utilization).toBe(16);
  });

  it('does not push a staler reading over a fresher one', async () => {
    const now = Date.now();
    await fsp.writeFile(file, doc({ magma: { configDir: '/m', util: 99, at: now } }));

    const cache = createUsageCache(file);
    // An idle window flushing something it read an hour ago.
    cache.save('magma', {
      configDir: '/m',
      snapshot: { fetchedAt: now - 60 * 60_000, fiveHour: { utilization: 5 } },
    });
    await settled();

    const after = parseUsageCache(await fsp.readFile(file, 'utf-8'), now);
    expect(after?.get('magma')?.snapshot.fiveHour?.utilization).toBe(99);
  });

  it('still writes when there is no file yet', async () => {
    const now = Date.now();
    const cache = createUsageCache(file);
    cache.save('magma', {
      configDir: '/m',
      snapshot: { fetchedAt: now, fiveHour: { utilization: 16 } },
    });
    await settled();
    const after = parseUsageCache(await fsp.readFile(file, 'utf-8'), now);
    expect(after?.get('magma')?.snapshot.fiveHour?.utilization).toBe(16);
  });
});

describe('parseUsageCache', () => {
  it('drops a document it does not recognise', () => {
    expect(parseUsageCache(null, BASE)).toBeNull();
    expect(parseUsageCache('not json', BASE)).toBeNull();
    expect(parseUsageCache('{"version":99,"accounts":{}}', BASE)).toBeNull();
    expect(parseUsageCache('{"version":1}', BASE)).toBeNull();
  });

  it('drops a reading older than the window it describes', () => {
    const fresh = JSON.stringify({
      version: 1,
      accounts: { p: { configDir: '/cfg', snapshot: { fetchedAt: BASE - 1000, fiveHour: { utilization: 10 } } } },
    });
    expect(parseUsageCache(fresh, BASE)?.size).toBe(1);
    const ancient = JSON.stringify({
      version: 1,
      accounts: {
        p: {
          configDir: '/cfg',
          snapshot: { fetchedAt: BASE - USAGE_CACHE_TTL_MS - 1, fiveHour: { utilization: 10 } },
        },
      },
    });
    // Past five hours the five-hour figure is not stale, it is WRONG — the
    // window it counted has rolled over.
    expect(ancient && parseUsageCache(ancient, BASE)?.size).toBe(0);
  });

  it('refuses numbers no provider could have said, and hand-written failures', () => {
    const bad = JSON.stringify({
      version: 1,
      accounts: {
        a: { configDir: '/c', snapshot: { fetchedAt: BASE, fiveHour: { utilization: 4000 } } },
        b: { configDir: '/c', snapshot: { fetchedAt: BASE, fiveHour: { utilization: -5 } } },
        c: { configDir: '/c', snapshot: { fetchedAt: BASE, error: 'http', fiveHour: { utilization: 10 } } },
        d: { configDir: '/c', snapshot: { fetchedAt: BASE } },
      },
    });
    // Every one of these is dropped: two impossible percentages, a failure
    // somebody wrote by hand, and a snapshot with no windows to seed.
    expect(parseUsageCache(bad, BASE)?.size).toBe(0);
  });

  it('marks everything it returns stale', () => {
    const text = JSON.stringify({
      version: 1,
      accounts: { p: { configDir: '/cfg', snapshot: { fetchedAt: BASE, fiveHour: { utilization: 10 } } } },
    });
    expect(parseUsageCache(text, BASE)?.get('p')?.snapshot.stale).toBe(true);
  });
});

// THE CREDENTIAL HALF OF THE DIAGNOSIS.
//
// Every credential verdict — "not signed in", "sign-in expired", "usage n/a" —
// reached the row as three words and wrote nothing anywhere, so a live account
// reading `usage n/a` could not be told apart from a keychain the editor cannot
// read. The tier and the shape of the document now go to the log; the token and
// the blob never do.

describe('LimitsService — a credential it cannot use says which tier and why', () => {
  const p = profile('p', { configDir: '/cfg' });

  async function verdictFor(over: {
    file?: string | null;
    keychain?: string | null;
  }): Promise<string> {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    try {
      const service = new LimitsService({
        readFile: async () => over.file ?? null,
        exec: async () => over.keychain ?? null,
        fetch: async () => okResponse(bodyWithFiveHour(10)),
        now: () => BASE,
        homeDir: HOME,
        platform: 'darwin',
      });
      await service.readUsage(p);
      return lines.join('\n');
    } finally {
      setLogSink(null);
    }
  }

  it('names the keychain SERVICE, so a wrong hash is visible', async () => {
    const log = await verdictFor({ file: null, keychain: null });
    expect(log).toContain('limits: no usable credential');
    expect(log).toContain('account p');
    // The service name is a hash of the config dir and is a public identifier —
    // and it is the one thing that proves the right item was asked for.
    expect(log).toContain(keychainServiceFor('/cfg'));
    expect(log).toContain('no-document');
  });

  it('tells "nothing there" apart from "there and not JSON"', async () => {
    expect(await verdictFor({ keychain: '' })).toContain('no-document');
    expect(await verdictFor({ keychain: 'not json at all' })).toContain('unparseable');
  });

  it('tells a lapsed token apart from a document with no token in it', async () => {
    // The two ways to reach `usage n/a`. They mean different things — one is a
    // token the CLI will renew, the other a document that never had one — and
    // the row says the same three words for both.
    const lapsed = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'AT',
        refreshToken: 'RT',
        expiresAt: BASE - 60_000,
      },
    });
    const logLapsed = await verdictFor({ keychain: lapsed });
    expect(logLapsed).toContain('stale from keychain');
    expect(logLapsed).toContain('lapsed');
    expect(logLapsed).not.toContain('AT');
    expect(logLapsed).not.toContain('RT');

    const tokenless = JSON.stringify({ claudeAiOauth: { refreshToken: 'RT' } });
    const logTokenless = await verdictFor({ keychain: tokenless });
    expect(logTokenless).toContain('no-access-token');
    expect(logTokenless).not.toContain('RT');
  });

  it('says nothing at all when the credential is usable', async () => {
    const good = JSON.stringify({
      claudeAiOauth: { accessToken: 'AT', refreshToken: 'RT', expiresAt: BASE + 3_600_000 },
    });
    const log = await verdictFor({ keychain: good });
    expect(log).not.toContain('no usable credential');
  });
});

// A refusal must result in silence for the entire requested interval.
describe('LimitsService — a 429 that states a wait is obeyed, not guessed at', () => {
  /** A 429 carrying `retry-after`, in the seconds spelling the endpoint uses. */
  function throttled(seconds: string | null): HttpResponseLike {
    return {
      status: 429,
      text: async () => '',
      headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? seconds : null) },
    };
  }

  function serviceOn(responses: HttpResponseLike[], clockRef: { now: number }) {
    const filePath = credentialsPathFor(profile('p'), HOME);
    let i = 0;
    const fetchFn = vi.fn(async (): Promise<HttpResponseLike> => {
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return r;
    });
    const service = new LimitsService({
      readFile: async (file: string) => (file === filePath ? credBlob('TOKEN') : null),
      fetch: fetchFn,
      now: () => clockRef.now,
      homeDir: HOME,
      platform: 'darwin',
    });
    return { service, fetchFn };
  }

  it('stays quiet for the WHOLE stated wait, not just the guessed step', async () => {
    // 1200s is what this endpoint actually asked for on 2026-09-12, and it is
    // longer than BACKOFF_BASE_MS — which is the whole point. Every step of the
    // guessed ladder below the stated wait is a request sent inside the quiet
    // period the server just asked for.
    const clock = { now: BASE };
    const { service, fetchFn } = serviceOn([throttled('1200')], clock);
    const p = profile('p');

    const first = await service.readUsage(p);
    expect(first?.error).toBe('rate-limited');
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Past the guessed base step, and the old code would have asked again here
    // — ten minutes into a twenty-minute window.
    clock.now = BASE + BACKOFF_BASE_MS + 1;
    await service.readUsage(p);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Still inside the stated 1200s.
    clock.now = BASE + 1_199_000;
    await service.readUsage(p);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Past it: one more attempt, and not before.
    clock.now = BASE + 1_201_000;
    await service.readUsage(p);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('tells the row WHEN, so it can say a clock instead of a fault', async () => {
    const clock = { now: BASE };
    const { service } = serviceOn([throttled('1200')], clock);
    const snap = await service.readUsage(profile('p'));
    expect(snap?.retryAt).toBe(BASE + 1_200_000);
    // "Flock usage polling paused", never "usage unavailable": nothing about this account is
    // broken and there is nothing for the user to go and fix.
    expect(formatUsageSummary(snap, BASE)).toBe('Flock usage polling paused → 20m');
  });

  it('keeps the longer of the stated wait and the ladder', async () => {
    // A throttle that keeps recurring walks the ladder up underneath. Once the
    // ladder is longer than what the server states, the ladder wins — the
    // stated wait is a floor on politeness, not a ceiling on it.
    const clock = { now: BASE };
    const { service, fetchFn } = serviceOn([throttled('1')], clock);
    const p = profile('p');
    await service.readUsage(p);
    // One second stated, two minutes guessed: we wait the two minutes.
    clock.now += 1_500;
    await service.readUsage(p);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    clock.now = BASE + BACKOFF_BASE_MS + 1;
    await service.readUsage(p);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('preserves a full day of server-requested quiet', async () => {
    const clock = { now: BASE };
    const { service } = serviceOn([throttled('86400')], clock);
    const snap = await service.readUsage(profile('p'));
    expect(snap?.retryAt).toBe(BASE + 86_400_000);
  });

  it('reads the HTTP-date spelling too, and ignores nonsense', () => {
    const headers = (v: string | null) => ({
      get: (name: string) => (name.toLowerCase() === 'retry-after' ? v : null),
    });
    expect(retryAfterMs(headers('300'), BASE)).toBe(300_000);
    expect(retryAfterMs(headers(new Date(BASE + 120_000).toUTCString()), BASE)).toBe(120_000);
    // A date already behind us is no answer, not a negative wait.
    expect(retryAfterMs(headers(new Date(BASE - 60_000).toUTCString()), BASE)).toBeUndefined();
    expect(retryAfterMs(headers('0'), BASE)).toBeUndefined();
    expect(retryAfterMs(headers('soon'), BASE)).toBeUndefined();
    expect(retryAfterMs(headers(null), BASE)).toBeUndefined();
    expect(retryAfterMs(undefined, BASE)).toBeUndefined();
    // A response object whose headers throw must not take a repaint down.
    expect(
      retryAfterMs(
        {
          get: () => {
            throw new Error('nope');
          },
        },
        BASE,
      ),
    ).toBeUndefined();
  });

  it('logs the throttle and the wait, and never the token', async () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    try {
      const clock = { now: BASE };
      const { service } = serviceOn([throttled('300')], clock);
      await service.readUsage(profile('p'));
      const joined = lines.join('\n');
      expect(joined).toContain('limits: usage request throttled');
      // WHICH ACCOUNT. Two accounts throttled in the same second produced two
      // identical lines, and "which one is still locked out" could not be read
      // off them — the exact question a person asks when one row recovers and
      // the other does not.
      expect(joined).toContain('account p');
      // THE HEADER AS SENT. Logging only the honoured value made every long
      // wait read as `1200s` — RETRY_AFTER_MAX_MS, our own clamp, reported back
      // as though the server had said it.
      expect(joined).toContain('retry-after: 300');
      expect(joined).not.toContain('TOKEN');
    } finally {
      setLogSink(null);
    }
  });
});

describe('LimitsService — a 429 with no stated wait falls back to the guessed ladder', () => {
  it('degrades to the last good snapshot, backs off exponentially, gates all retries until the backoff clears', async () => {
    let clock = BASE;
    const filePath = credentialsPathFor(profile('p'), HOME);
    const readFile = vi.fn(async (file: string): Promise<string | null> =>
      file === filePath ? credBlob('TOKEN') : null,
    );
    const responses: HttpResponseLike[] = [
      okResponse(bodyWithFiveHour(30)), // 1: establishes the last GOOD snapshot
      { status: 429, text: async () => '' }, // 2: first failure -> backoff base
      { status: 429, text: async () => '' }, // 4: second failure -> backoff doubles
      okResponse(bodyWithFiveHour(5)), // 5: success after the cooldown
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

    // 2. past the interval, the 429 lands: 'rate-limited', stale, last-good
    //    numbers kept. A throttle that states no Retry-After is the only case
    //    left where the guessed ladder decides the wait.
    clock += MIN_FETCH_INTERVAL_MS + 1;
    const failed = await service.readUsage(p);
    expect(failed?.error).toBe('rate-limited');
    // The row reports Flock's actual fallback deadline when there is no header.
    expect(failed?.retryAt).toBe(clock + BACKOFF_BASE_MS);
    // Five minutes old, inside STALE_AFTER_MS: still the current answer.
    expect(failed?.stale).toBeUndefined();
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
    expect(failedAgain?.error).toBe('rate-limited');
    expect(failedAgain?.fiveHour?.utilization).toBe(30); // still the original good

    // 5. immediately after (well inside both the interval AND the doubled
    //    backoff), an ordinary call is still gated...
    expect(await service.readUsage(p)).toEqual(failedAgain);
    expect(fetchFn).toHaveBeenCalledTimes(3);

    await service.readUsage(p, { force: true });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    clock = failedAgain!.retryAt!;
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
    // Five minutes old and still the current answer, so NOT flagged — the
    // failure is carried by `error`, which is a fact about the last attempt
    // rather than about the numbers.
    expect(out?.stale).toBeUndefined();
    expect(out?.fiveHour?.utilization).toBe(62);

    // Past STALE_AFTER_MS it IS flagged, which is the whole point of the flag.
    clock += STALE_AFTER_MS + 1;
    const old = await service.readUsage(p);
    expect(old?.stale).toBe(true);
    expect(old?.fiveHour?.utilization).toBe(62);
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

describe('createUsageCache — the file stores a measurement, not a verdict', () => {
  // `stale` is derived from `fetchedAt` at the seam that draws a row. It got
  // into the file through the merge path — parseUsageCache marks what it reads
  // stale by default, and an account this window never refreshed is written
  // straight back out — which left the cache storing one window's opinion about
  // age beside the reading it was an opinion about.
  it('never writes a stale flag back out, however it got into memory', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'flock-usage-'));
    const file = path.join(dir, 'usage-cache.json');
    const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 1_400));

    // An entry only this file knows about, exactly as a previous window left it.
    await fsp.writeFile(
      file,
      JSON.stringify({
        version: 1,
        accounts: {
          quiet: {
            configDir: '/cfg',
            snapshot: { fetchedAt: Date.now(), fiveHour: { utilization: 17 } },
          },
        },
      }),
      'utf-8',
    );

    const cache = createUsageCache(file);
    // Reading marks it stale in memory — that is the parser's safe default.
    const loaded = await cache.load();
    expect(loaded?.get('quiet')?.snapshot.stale).toBe(true);

    // A write for a DIFFERENT account merges 'quiet' back in and rewrites it.
    cache.save('busy', {
      configDir: '/cfg',
      snapshot: { fetchedAt: Date.now(), fiveHour: { utilization: 40 } },
    });
    await settled();

    const onDisk = JSON.parse(await fsp.readFile(file, 'utf-8')) as {
      accounts: Record<string, { snapshot: Record<string, unknown> }>;
    };
    // Both accounts survive the merge — and neither carries the verdict.
    expect(Object.keys(onDisk.accounts).sort()).toEqual(['busy', 'quiet']);
    expect('stale' in onDisk.accounts['quiet'].snapshot).toBe(false);
    expect('stale' in onDisk.accounts['busy'].snapshot).toBe(false);
    // The measurement it is derived FROM is still there.
    expect(onDisk.accounts['quiet'].snapshot['fetchedAt']).toBeTypeOf('number');

    await fsp.rm(dir, { recursive: true, force: true });
  });
});

// TWO ACCOUNTS, ONE TICK.
//
// THE BUG: the accounts view reads every due account in a single `Promise.all`,
// and because they are all read together their timers expire together — so N
// accounts fired in the same millisecond, every interval. Raising
// MIN_FETCH_INTERVAL_MS from one minute to five addressed how OFTEN that
// happened and not that it happened at all; a tighter interval on a
// synchronised burst is still a burst. The log that caught it showed two
// different logins refused in the same second, 23:06:55, on 2026-09-13.
describe('LimitsService — requests are spaced, however many arrive at once', () => {
  function spacedService() {
    const a = profile('a', { configDir: '/cfg-a' });
    const b = profile('b', { configDir: '/cfg-b' });
    const starts: number[] = [];
    let clock = BASE;
    const service = new ProductionLimitsService({
      readFile: async () => credBlob('TOKEN'),
      fetch: vi.fn(async (): Promise<HttpResponseLike> => {
        starts.push(clock);
        return okResponse(bodyWithFiveHour(20));
      }),
      sleep: async (ms: number) => {
        clock += ms;
      },
      now: () => clock,
      homeDir: HOME,
      platform: 'darwin',
    });
    return { service, a, b, starts };
  }

  it('does not let two accounts leave in the same instant', async () => {
    const { service, a, b, starts } = spacedService();
    // Exactly what the view does: both in one tick, nothing awaited between.
    await Promise.all([service.readUsage(a), service.readUsage(b)]);
    expect(starts).toHaveLength(2);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(REQUEST_SPACING_MS);
  });

  it('costs the first request nothing — the gap is between, not before', async () => {
    const { service, a, starts } = spacedService();
    await service.readUsage(a);
    expect(starts).toEqual([BASE]);
  });

  it('does not wedge every account behind one failed request', async () => {
    const a = profile('a', { configDir: '/cfg-a' });
    const b = profile('b', { configDir: '/cfg-b' });
    let clock = BASE;
    let n = 0;
    const service = new ProductionLimitsService({
      readFile: async () => credBlob('TOKEN'),
      fetch: vi.fn(async (): Promise<HttpResponseLike> => {
        n += 1;
        if (n === 1) throw new Error('socket hang up');
        return okResponse(bodyWithFiveHour(31));
      }),
      sleep: async (ms: number) => {
        clock += ms;
      },
      now: () => clock,
      homeDir: HOME,
      platform: 'darwin',
    });
    const [first, second] = await Promise.all([
      service.readUsage(a),
      service.readUsage(b),
    ]);
    expect(first?.error).toBe('http');
    // The one behind it still went, and still got its numbers.
    expect(second?.fiveHour?.utilization).toBe(31);
  });
});
