// test/routing.test.ts — the M22 CONTRACT under test: src/routing.ts.
//
// Pure module: a Map literal for usage and a fixed `now` stand in for the
// limits fetcher, so every rule here is deterministic and network-free.
//
// What actually matters, in the order routing.ts's own header states it:
//
//   1. the three-tier cascade (account -> provider -> auto), each tier's
//      failure producing a note rather than silently skipping to the next;
//   2. the auto-pick priority: open 5h window > idle/no-data > exhausted,
//      tiebroken by soonest weekly reset, tiebroken by the user's own order;
//   3. a window whose resetsAt has PASSED counts as closed, not as its cached
//      percentage — this is the whole reason `now` is a parameter;
//   4. pinnedProfile never falls back — a dangling pin is `null`, not someone
//      else's subscription;
//   5. every tier picks from the accounts a session can actually RUN on
//      (accounts.canHostSession). The launcher execs the Claude CLI and
//      nothing else, so a Codex or Gemini account is a row to sign in and read
//      meters on, never a routing answer — and a tier that names one degrades
//      with a note saying which provider, not with "gone".
//
// weekdayLabel is used to build reason-string expectations rather than
// hardcoding a day name, because which weekday an epoch ms falls on depends
// on the machine's local timezone — exactly why routing.ts exports it.

import { describe, expect, it } from 'vitest';

import {
  describeRouting,
  pinnedLaunchProfile,
  pinnedProfile,
  rankUsage,
  resolveRouting,
  weekdayLabel,
} from '../src/routing';
import type { AccountProfile, RoutingChoice, UsageSnapshot, UsageWindow } from '../src/types';

// ------------------------------------------------------------------ helpers

const NOW = Date.parse('2026-03-04T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

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

function win(utilization: number, resetsAt?: number): UsageWindow {
  return resetsAt === undefined ? { utilization } : { utilization, resetsAt };
}

function snap(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return { fetchedAt: NOW, ...over };
}

function usageMap(
  entries: ReadonlyArray<[string, UsageSnapshot | null]>,
): ReadonlyMap<string, UsageSnapshot | null> {
  return new Map(entries);
}

const NO_USAGE: ReadonlyMap<string, UsageSnapshot | null> = new Map();

// ----------------------------------------------------------------- weekdayLabel

describe('weekdayLabel', () => {
  it("returns '' for a non-finite epoch", () => {
    expect(weekdayLabel(NaN)).toBe('');
    expect(weekdayLabel(Number.POSITIVE_INFINITY)).toBe('');
  });

  it('agrees with Date.getDay() indexed against the weekday names — the same rule the module applies', () => {
    const NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (let i = 0; i < 7; i++) {
      const t = NOW + i * DAY;
      expect(weekdayLabel(t)).toBe(NAMES[new Date(t).getDay()]);
    }
  });

  it('a non-empty three-letter label for a normal epoch', () => {
    expect(weekdayLabel(NOW)).toMatch(/^[A-Z][a-z]{2}$/);
  });
});

// -------------------------------------------------------------------- rankUsage

describe('rankUsage', () => {
  it('null/undefined snapshot ranks idle — "no data is not evidence of exhaustion"', () => {
    expect(rankUsage(null, NOW)).toBe('idle');
    expect(rankUsage(undefined, NOW)).toBe('idle');
  });

  it('no fiveHour window at all ranks idle', () => {
    expect(rankUsage(snap(), NOW)).toBe('idle');
  });

  it('an open window (0 < util < 100) ranks open', () => {
    expect(rankUsage(snap({ fiveHour: win(45) }), NOW)).toBe('open');
  });

  it('a window at exactly 0% ranks idle — "not opened, nothing sunk yet"', () => {
    expect(rankUsage(snap({ fiveHour: win(0) }), NOW)).toBe('idle');
  });

  it('a window at 100% ranks exhausted', () => {
    expect(rankUsage(snap({ fiveHour: win(100) }), NOW)).toBe('exhausted');
  });

  it('a window reported over 100% still ranks exhausted, not open', () => {
    expect(rankUsage(snap({ fiveHour: win(140) }), NOW)).toBe('exhausted');
  });

  it('a window with no resetsAt at all is still live (open)', () => {
    expect(rankUsage(snap({ fiveHour: win(50) }), NOW)).toBe('open');
  });

  it('a window whose resetsAt is still ahead is open', () => {
    expect(rankUsage(snap({ fiveHour: win(50, NOW + 1000) }), NOW)).toBe('open');
  });

  it('a window whose resetsAt has PASSED is CLOSED — treated as idle, not as its cached percentage', () => {
    // 80% cached, but the window rolled over a second ago: must not read as
    // "nearly exhausted" or "open", or a stale snapshot would misroute.
    expect(rankUsage(snap({ fiveHour: win(80, NOW - 1000) }), NOW)).toBe('idle');
  });

  it('a window whose resetsAt is exactly now is treated as closed (<=, not <)', () => {
    expect(rankUsage(snap({ fiveHour: win(80, NOW) }), NOW)).toBe('idle');
  });
});

// -------------------------------------------------------------- resolveRouting

describe('resolveRouting: empty roster', () => {
  it('null profile, reason "no accounts configured", whatever the choice', () => {
    const choices: Array<RoutingChoice | undefined> = [
      undefined,
      { kind: 'auto' },
      { kind: 'account', id: 'x' },
      { kind: 'provider', provider: 'claude' },
    ];
    for (const choice of choices) {
      const result = resolveRouting(choice, undefined, [], NO_USAGE, NOW);
      expect(result).toEqual({ profile: null, reason: 'no accounts configured' });
    }
  });
});

describe('resolveRouting: account tier', () => {
  const profiles = [profile('a', { order: 0 }), profile('b', { order: 1 })];

  it('a named, present account wins outright: "set for this project"', () => {
    const result = resolveRouting({ kind: 'account', id: 'b' }, undefined, profiles, NO_USAGE, NOW);
    expect(result.profile?.id).toBe('b');
    expect(result.reason).toBe('set for this project');
  });

  it('a missing project-level choice falls back to the global default: "the account set here is gone"', () => {
    const result = resolveRouting(
      { kind: 'account', id: 'ghost' },
      { kind: 'account', id: 'a' },
      profiles,
      NO_USAGE,
      NOW,
    );
    expect(result.profile?.id).toBe('a');
    expect(result.reason).toBe('the account set here is gone · the default account');
  });

  it('the global default alone (no project choice) reads as "the default account"', () => {
    const result = resolveRouting(undefined, { kind: 'account', id: 'b' }, profiles, NO_USAGE, NOW);
    expect(result.profile?.id).toBe('b');
    expect(result.reason).toBe('the default account');
  });

  it('a missing global default (no project choice) falls to auto: "the default account is gone"', () => {
    const result = resolveRouting(undefined, { kind: 'account', id: 'ghost' }, profiles, NO_USAGE, NOW);
    expect(result.profile?.id).toBe('a'); // lowest order, no usage data
    expect(result.reason.startsWith('the default account is gone')).toBe(true);
  });

  it('BOTH the project choice and the global default are dangling: falls all the way to auto / lowest order', () => {
    const result = resolveRouting(
      { kind: 'account', id: 'ghost1' },
      { kind: 'account', id: 'ghost2' },
      profiles,
      NO_USAGE,
      NOW,
    );
    expect(result.profile?.id).toBe('a');
    expect(result.reason).toBe(
      'the account set here is gone · the default account is gone · no usage data',
    );
  });

  it('an identical project choice and global default do not double up the failure note', () => {
    const result = resolveRouting(
      { kind: 'account', id: 'ghost' },
      { kind: 'account', id: 'ghost' },
      profiles,
      NO_USAGE,
      NOW,
    );
    const goneCount = (result.reason.match(/is gone/g) ?? []).length;
    expect(goneCount).toBe(1);
  });
});

describe('resolveRouting: provider tier', () => {
  const profiles = [
    profile('c1', { provider: 'claude', order: 0 }),
    profile('c2', { provider: 'claude', order: 1 }),
    // An API-key account: `generic`, and launchable — it is a Claude launch
    // authenticated by an environment variable.
    profile('k1', { provider: 'generic', order: 2, extraEnv: { SOME_KEY: 'x' } }),
    profile('x1', { provider: 'codex', order: 3 }),
  ];

  it('filters to only that provider\'s accounts', () => {
    const result = resolveRouting({ kind: 'provider', provider: 'generic' }, undefined, profiles, NO_USAGE, NOW);
    expect(result.profile?.provider).toBe('generic');
    expect(result.profile?.id).toBe('k1');
  });

  it('a provider whose CLI Canopy does not launch degrades — never a Codex account', () => {
    const result = resolveRouting({ kind: 'provider', provider: 'codex' }, undefined, profiles, NO_USAGE, NOW);
    expect(result.profile?.id).toBe('c1'); // fell through to auto
    expect(result.reason).toContain('Codex / OpenAI accounts cannot run sessions');
  });

  it('auto-picks among that provider\'s accounts by the same usage rules', () => {
    const usage = usageMap([['c2', snap({ fiveHour: win(50, NOW + 1000) })]]);
    const result = resolveRouting({ kind: 'provider', provider: 'claude' }, undefined, profiles, usage, NOW);
    expect(result.profile?.id).toBe('c2'); // open window beats c1's no-data, despite higher order
  });

  it('no account of that provider: notes it by the provider LABEL and falls through', () => {
    const claudeOnly = [profile('c1', { provider: 'claude' })];
    const result = resolveRouting({ kind: 'provider', provider: 'codex' }, undefined, claudeOnly, NO_USAGE, NOW);
    expect(result.profile?.id).toBe('c1');
    expect(result.reason).toContain('no Codex / OpenAI account');
  });
});

describe('resolveRouting: auto tier scoring', () => {
  it('an open 5h window outranks everything, regardless of order', () => {
    const profiles = [
      profile('exhausted', { order: 0 }),
      profile('idle-no-data', { order: 1 }),
      profile('open', { order: 2 }),
    ];
    const usage = usageMap([
      ['exhausted', snap({ fiveHour: win(100) })],
      ['open', snap({ fiveHour: win(30, NOW + DAY) })],
    ]);
    const result = resolveRouting(undefined, undefined, profiles, usage, NOW);
    expect(result.profile?.id).toBe('open');
    expect(result.reason).toContain('open 5h window');
  });

  it('no-data ranks strictly between open and exhausted', () => {
    // No open candidate here: idle (no data) must beat exhausted.
    const profiles = [profile('exhausted', { order: 0 }), profile('no-data', { order: 1 })];
    const usage = usageMap([['exhausted', snap({ fiveHour: win(100) })]]);
    const result = resolveRouting(undefined, undefined, profiles, usage, NOW);
    expect(result.profile?.id).toBe('no-data');
  });

  it('among two open windows, the SOONER weekly reset wins even against a lower order', () => {
    const soonReset = NOW + 2 * DAY;
    const laterReset = NOW + 9 * DAY;
    const profiles = [
      profile('a-lower-order', { order: 0 }),
      profile('b-sooner-reset', { order: 1 }),
    ];
    const usage = usageMap([
      ['a-lower-order', snap({ fiveHour: win(40, NOW + DAY), sevenDay: win(0, laterReset) })],
      ['b-sooner-reset', snap({ fiveHour: win(60, NOW + DAY), sevenDay: win(0, soonReset) })],
    ]);
    const result = resolveRouting(undefined, undefined, profiles, usage, NOW);
    expect(result.profile?.id).toBe('b-sooner-reset');
    expect(result.reason).toContain(`weekly resets ${weekdayLabel(soonReset)}`);
  });

  it('the sooner of sevenDay / sevenDayOpus is the one that counts', () => {
    const sooner = NOW + DAY;
    const later = NOW + 10 * DAY;
    const s = snap({ fiveHour: win(10, NOW + DAY), sevenDay: win(0, later), sevenDayOpus: win(0, sooner) });
    const profiles = [profile('solo')];
    const usage = usageMap([['solo', s]]);
    const result = resolveRouting(undefined, undefined, profiles, usage, NOW);
    expect(result.reason).toContain(`weekly resets ${weekdayLabel(sooner)}`);
  });

  it('a weekly reset already in the PAST is ignored, not treated as imminent', () => {
    const past = NOW - DAY;
    const s = snap({ fiveHour: win(10, NOW + DAY), sevenDay: win(0, past) });
    const result = resolveRouting(undefined, undefined, [profile('solo')], usageMap([['solo', s]]), NOW);
    expect(result.reason).not.toContain('weekly resets');
  });

  it('an EXHAUSTED account ranks last, and is picked only when nothing else exists', () => {
    const result = resolveRouting(
      undefined,
      undefined,
      [profile('only')],
      usageMap([['only', snap({ fiveHour: win(100) })]]),
      NOW,
    );
    expect(result.profile?.id).toBe('only');
    expect(result.reason).toContain('5h window is full');
  });

  it('a stale-but-open snapshot (resetsAt passed) does not outrank a truly open one', () => {
    const profiles = [
      profile('stale-looks-open', { order: 0 }),
      profile('truly-open', { order: 1 }),
    ];
    const usage = usageMap([
      ['stale-looks-open', snap({ fiveHour: win(90, NOW - 1000) })], // closed by clock
      ['truly-open', snap({ fiveHour: win(20, NOW + DAY) })],
    ]);
    const result = resolveRouting(undefined, undefined, profiles, usage, NOW);
    expect(result.profile?.id).toBe('truly-open');
  });

  it('final tiebreak is the user\'s own order when rank AND weekly reset both tie', () => {
    const profiles = [
      profile('later-in-list', { order: 5 }),
      profile('earlier-in-list', { order: 1 }),
    ];
    // Both no-data (idle), both weekly infinite: order alone decides.
    const result = resolveRouting(undefined, undefined, profiles, NO_USAGE, NOW);
    expect(result.profile?.id).toBe('earlier-in-list');
  });

  it('a tombstoned account never reaches the auto-picker', () => {
    const profiles = [
      profile('gone', { order: 0, deleted: true }),
      profile('live', { order: 1 }),
    ];
    const result = resolveRouting(undefined, undefined, profiles, NO_USAGE, NOW);
    expect(result.profile?.id).toBe('live');
  });
});

// ------------------------------------------ only accounts that can run a session
//
// The launcher execs ONE binary, the Claude CLI. Routing a launch to a Codex
// account would run `claude` under `CODEX_HOME`, land on the machine's default
// Claude login, and pin the conversation for life to an account it was never
// on — isolated in the UI, shared in reality. Every tier picks from the
// launchable accounts only, and a tier that named one of the others says so.

describe('resolveRouting: never picks an account no session can run on', () => {
  it('the auto tier skips a Codex account even when it scores best', () => {
    const profiles = [
      profile('claude-full', { provider: 'claude', order: 0 }),
      profile('codex-idle', { provider: 'codex', order: 1 }),
    ];
    // Codex has no usage surface, so its snapshot is null → 'idle', which
    // outranks the exhausted Claude account. It must still lose.
    const usage = usageMap([['claude-full', snap({ fiveHour: win(100) })]]);
    const result = resolveRouting(undefined, undefined, profiles, usage, NOW);
    expect(result.profile?.id).toBe('claude-full');
    expect(result.reason).toContain('5h window is full');
  });

  it('a gemini account is skipped too — its configDir is ignored, so it is the default login wearing a name', () => {
    const profiles = [
      profile('gem', { provider: 'gemini', order: 0, configDir: '/g' }),
      profile('cl', { provider: 'claude', order: 1 }),
    ];
    expect(resolveRouting(undefined, undefined, profiles, NO_USAGE, NOW).profile?.id).toBe('cl');
  });

  it('an API-key (generic) account IS eligible — it is a Claude launch with a variable', () => {
    const profiles = [
      profile('key', { provider: 'generic', order: 0, extraEnv: { SOME_KEY: 'v' } }),
    ];
    expect(resolveRouting(undefined, undefined, profiles, NO_USAGE, NOW).profile?.id).toBe('key');
  });

  it('an account tier naming a Codex account degrades and names the PROVIDER, not "gone"', () => {
    const profiles = [
      profile('cx', { provider: 'codex', order: 0 }),
      profile('cl', { provider: 'claude', order: 1 }),
    ];
    const result = resolveRouting({ kind: 'account', id: 'cx' }, undefined, profiles, NO_USAGE, NOW);
    expect(result.profile?.id).toBe('cl');
    expect(result.reason).toContain('Codex / OpenAI accounts cannot run sessions');
    expect(result.reason).not.toContain('gone');
  });

  it('a roster of nothing BUT unlaunchable accounts resolves to null, not to the first row', () => {
    const profiles = [
      profile('cx', { provider: 'codex', order: 0 }),
      profile('gem', { provider: 'gemini', order: 1 }),
    ];
    const result = resolveRouting(undefined, undefined, profiles, NO_USAGE, NOW);
    // null = launch with no environment at all, i.e. the machine's own login —
    // the only place such a launch can actually work.
    expect(result.profile).toBeNull();
    expect(result.reason).toBe('no account can run a session');
  });
});

describe('resolveRouting: reason strings', () => {
  it('are always non-empty, whichever tier resolves', () => {
    const profiles = [profile('a')];
    const cases: Array<[RoutingChoice | undefined, RoutingChoice | undefined]> = [
      [undefined, undefined],
      [{ kind: 'account', id: 'a' }, undefined],
      [{ kind: 'account', id: 'ghost' }, undefined],
      [{ kind: 'provider', provider: 'claude' }, undefined],
      [{ kind: 'provider', provider: 'codex' }, undefined],
    ];
    for (const [choice, def] of cases) {
      const result = resolveRouting(choice, def, profiles, NO_USAGE, NOW);
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it('never mentions extraEnv, a configDir path, or anything credential-shaped', () => {
    const profiles = [
      profile('secret-holder', {
        configDir: '/Users/axel/.lineage/profiles/secret-holder',
        extraEnv: { ANTHROPIC_API_KEY: 'sk-ultra-secret-value' },
      }),
    ];
    const result = resolveRouting(undefined, undefined, profiles, NO_USAGE, NOW);
    expect(result.reason).not.toContain('sk-ultra-secret-value');
    expect(result.reason).not.toContain('/Users/axel/.lineage');
    expect(result.reason).not.toContain('ANTHROPIC_API_KEY');
  });
});

// -------------------------------------------------------------- pinnedProfile

describe('pinnedProfile', () => {
  const profiles = [profile('a'), profile('deleted-one', { deleted: true })];

  it('hit: returns the live profile with that id', () => {
    expect(pinnedProfile('a', profiles)?.id).toBe('a');
  });

  it('miss: unknown id resolves to null, not a fallback account', () => {
    expect(pinnedProfile('ghost', profiles)).toBeNull();
  });

  it('a pin naming a DELETED account resolves to null, never re-routed', () => {
    expect(pinnedProfile('deleted-one', profiles)).toBeNull();
  });

  it('undefined / empty-string profileId resolves to null', () => {
    expect(pinnedProfile(undefined, profiles)).toBeNull();
    expect(pinnedProfile('', profiles)).toBeNull();
  });
});

describe('pinnedLaunchProfile', () => {
  const profiles = [
    profile('cl', { provider: 'claude' }),
    profile('cx', { provider: 'codex' }),
    profile('dead', { deleted: true }),
  ];

  it('passes a launchable pin straight through', () => {
    expect(pinnedLaunchProfile('cl', profiles)?.id).toBe('cl');
  });

  it('a pin left behind on an account no session can run on resolves to null', () => {
    // The conversation's transcript is in the DEFAULT config dir — `claude`
    // ignored CODEX_HOME all along — so an empty env is where it actually is.
    expect(pinnedLaunchProfile('cx', profiles)).toBeNull();
    // …while the pin itself still reads as that account, which is what the
    // view and describeRouting render.
    expect(pinnedProfile('cx', profiles)?.id).toBe('cx');
  });

  it('still refuses a dangling and a deleted pin, like pinnedProfile', () => {
    expect(pinnedLaunchProfile('ghost', profiles)).toBeNull();
    expect(pinnedLaunchProfile('dead', profiles)).toBeNull();
  });
});

// ------------------------------------------------------------- describeRouting

describe('describeRouting', () => {
  const profiles = [profile('a', { label: 'Work (Max)' })];

  it('undefined choice reads as "Auto"', () => {
    expect(describeRouting(undefined, profiles)).toBe('Auto');
  });

  it('{kind: "auto"} reads as "Auto"', () => {
    expect(describeRouting({ kind: 'auto' }, profiles)).toBe('Auto');
  });

  it('a provider tier reads as "Any <Provider label> account"', () => {
    expect(describeRouting({ kind: 'provider', provider: 'claude' }, profiles)).toBe(
      'Any Claude account',
    );
    expect(describeRouting({ kind: 'provider', provider: 'codex' }, profiles)).toBe(
      'Any Codex / OpenAI account',
    );
  });

  it('a present account reads as its label', () => {
    expect(describeRouting({ kind: 'account', id: 'a' }, profiles)).toBe('Work (Max)');
  });

  it('a missing account reads as "Missing account (<id>)"', () => {
    expect(describeRouting({ kind: 'account', id: 'ghost' }, profiles)).toBe(
      'Missing account (ghost)',
    );
  });
});
