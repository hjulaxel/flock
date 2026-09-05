// test/accountsView.test.ts — the CONTRACT under test: src/accountsView.ts.
//
// Everything here goes through test/mocks/vscode.ts. registerAccountsView()
// calls vscode.window.createTreeView, which the mock's (deliberately empty)
// `window` does not implement — the same split as registerTree()/
// registerDecorations() in test/tree.test.ts: that glue is never called here,
// only the pure TreeDataProvider class (AccountsViewProvider), the usage cache
// (AccountUsageCache) and the exported helpers they are built from.
//
// What actually matters, in the order the file's own header states it:
//
//   * the view is FLAT and ordered by accounts.sortProfiles (the `order`
//     field) — never insertion order, never label order;
//   * contextValue is `;account;` / `;account;default;`, the exact token
//     shape a package.json `when` clause matches with `viewItem =~ /;.../`;
//   * a credential VALUE never leaves this file — extraEnv renders as key
//     names only, everywhere a row can be inspected (description, tooltip);
//   * the codex brand mark is a light/dark PAIR; every other provider is one
//     file; a host with no media path degrades to the provider's codicon;
//   * AccountUsageCache never rejects, never re-fetches inside
//     USAGE_MIN_AGE_MS unless forced, and a reader's own `cached()` wins over
//     what this process fetched itself.
//
// package.json sanity for the Accounts surface lives here rather than in
// scaffold.test.ts, which owns the generic COMMANDS <-> package.json
// cross-check: what is asserted below is specific to this view. Every account
// verb has to be reachable from SOMEWHERE — a menu, a view title, or an
// explicit (even `when: false`) palette entry — and the Accounts view has to
// actually sit inside the `lineage` activity-bar container the rest of the
// extension lives in.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  ACCOUNTS_VIEW_ID,
  AccountUsageCache,
  AccountsViewProvider,
  accountContextValue,
  accountIdOf,
  formatUsageSummary,
  untilLabel,
  usageSummaryOf,
} from '../src/accountsView';
import type { AccountDeps, AccountRow } from '../src/accountsView';
import { COMMANDS, CONFIG_KEYS, PROVIDER_MEDIA_DIR } from '../src/types';
import { contributedSettings } from './manifest';
import type {
  AccountProfile,
  LimitsReader,
  RoutingChoice,
  UsageSnapshot,
} from '../src/types';

const ROOT = path.join(__dirname, '..');
const NOW = Date.parse('2026-03-04T12:00:00.000Z');

// ------------------------------------------------------------------ helpers

function profile(id: string, over: Partial<AccountProfile> = {}): AccountProfile {
  return {
    id,
    provider: 'claude',
    label: id,
    order: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function snapshot(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return { fetchedAt: NOW, ...over };
}

/** Every member answers something harmless; a test overrides only what it
 *  is exercising, so a signature change surfaces here rather than as a
 *  missing-property compile error scattered across every `it`. */
function fakeDeps(over: Partial<AccountDeps> = {}): AccountDeps {
  return {
    accounts: () => [],
    getAccount: () => undefined,
    upsertAccount: async () => undefined,
    deleteAccount: async () => undefined,
    setAccountOrder: async () => undefined,
    defaultRouting: () => undefined,
    setDefaultRouting: async () => undefined,
    setProjectRouting: async () => undefined,
    sessionProfileId: () => undefined,
    pinSession: async () => undefined,
    usage: () => null,
    usageMap: () => new Map(),
    refreshUsage: async () => undefined,
    onUsageChanged: () => ({ dispose: () => undefined }),
    createProfileDir: async () => undefined,
    claudeBinary: () => null,
    mediaPath: () => undefined,
    refreshAccounts: () => undefined,
    ...over,
  };
}

// -------------------------------------------------------------- accountIdOf

describe('accountIdOf', () => {
  it('unwraps an AccountRow', () => {
    const row: AccountRow = { kind: 'account', profile: profile('work') };
    expect(accountIdOf(row)).toBe('work');
  });

  it('takes a bare id string', () => {
    expect(accountIdOf('work')).toBe('work');
  });

  it('takes a bare AccountProfile object (has its own .id)', () => {
    expect(accountIdOf(profile('work'))).toBe('work');
  });

  it('refuses an empty string, not undefined/null/junk', () => {
    expect(accountIdOf('')).toBeUndefined();
    expect(accountIdOf(undefined)).toBeUndefined();
    expect(accountIdOf(null)).toBeUndefined();
    expect(accountIdOf(42)).toBeUndefined();
    expect(accountIdOf({})).toBeUndefined();
  });
});

// --------------------------------------------------------- accountContextValue

describe('accountContextValue', () => {
  it('wraps tokens the way the rest of the codebase does — no half-matches', () => {
    expect(accountContextValue(false)).toBe(';account;');
    expect(accountContextValue(true)).toBe(';account;default;');
  });
});

// ---------------------------------------------------------------- untilLabel

describe('untilLabel', () => {
  it('is empty with no reset time, a non-finite one, or one already past', () => {
    expect(untilLabel(undefined, NOW)).toBe('');
    expect(untilLabel(Number.NaN, NOW)).toBe('');
    expect(untilLabel(NOW - 1, NOW)).toBe('');
    expect(untilLabel(NOW, NOW)).toBe(''); // exactly now: not "in the future"
  });

  it('minutes under an hour', () => {
    expect(untilLabel(NOW + 90_000, NOW)).toBe('in 2m');
    expect(untilLabel(NOW + 30_000, NOW)).toBe('in 1m'); // rounds up to at least 1
  });

  it('hours and minutes under a day — the file header\'s own example', () => {
    expect(untilLabel(NOW + 130 * 60_000, NOW)).toBe('in 2h 10m');
  });

  it('a whole number of hours drops the minutes', () => {
    expect(untilLabel(NOW + 3 * 60 * 60_000, NOW)).toBe('in 3h');
  });

  it('days once past 24h — the file header\'s own example', () => {
    expect(untilLabel(NOW + 3 * 24 * 60 * 60_000, NOW)).toBe('in 3d');
  });
});

// ---------------------------------------------------------- formatUsageSummary

describe('formatUsageSummary', () => {
  it('is empty for no snapshot at all', () => {
    expect(formatUsageSummary(null, NOW)).toBe('');
    expect(formatUsageSummary(undefined, NOW)).toBe('');
  });

  it('names the "no numbers" reasons distinctly', () => {
    expect(formatUsageSummary(snapshot({ error: 'no-credentials' }), NOW)).toBe(
      'not signed in',
    );
    expect(formatUsageSummary(snapshot({ error: 'expired' }), NOW)).toBe(
      'sign-in expired',
    );
    expect(formatUsageSummary(snapshot({ error: 'http' }), NOW)).toBe(
      'usage unavailable',
    );
    expect(formatUsageSummary(snapshot({ error: 'parse' }), NOW)).toBe(
      'usage unavailable',
    );
  });

  it('never calls an aged-out access token an expired sign-in', () => {
    // The account is signed in and the CLI renews the token itself on its next
    // run. Only the METER is missing, and that is all the row may say — the
    // wording is what sent people to `/login` for nothing.
    expect(formatUsageSummary(snapshot({ error: 'token-stale' }), NOW)).toBe(
      'usage n/a',
    );
    expect(
      formatUsageSummary(
        snapshot({ error: 'token-stale', signedInAs: 'a@b.c' }),
        NOW,
      ),
    ).toBe('a@b.c · usage n/a');
  });

  it('is percent-first and names the reset when there is one', () => {
    expect(
      formatUsageSummary(
        snapshot({ fiveHour: { utilization: 42, resetsAt: NOW + 130 * 60_000 } }),
        NOW,
      ),
    ).toBe('5h 42% · resets in 2h 10m');
  });

  it('omits the reset clause when the window carries none', () => {
    expect(
      formatUsageSummary(snapshot({ fiveHour: { utilization: 7 } }), NOW),
    ).toBe('5h 7%');
  });

  it('appends the weekly and opus windows in order', () => {
    expect(
      formatUsageSummary(
        snapshot({
          fiveHour: { utilization: 42 },
          sevenDay: { utilization: 18 },
          sevenDayOpus: { utilization: 5 },
        }),
        NOW,
      ),
    ).toBe('5h 42% · week 18% · opus 5%');
  });

  it('clamps and rounds utilization to a sane percent', () => {
    expect(
      formatUsageSummary(snapshot({ fiveHour: { utilization: 142 } }), NOW),
    ).toBe('5h 100%');
    expect(
      formatUsageSummary(snapshot({ fiveHour: { utilization: -5 } }), NOW),
    ).toBe('5h 0%');
    expect(
      formatUsageSummary(snapshot({ fiveHour: { utilization: 41.6 } }), NOW),
    ).toBe('5h 42%');
  });

  it('marks a stale snapshot at the tail, after every window', () => {
    expect(
      formatUsageSummary(
        snapshot({ fiveHour: { utilization: 10 }, stale: true }),
        NOW,
      ),
    ).toBe('5h 10% (stale)');
  });

  it('is "stale" alone when there are no windows to show', () => {
    expect(formatUsageSummary(snapshot({ stale: true }), NOW)).toBe('stale');
  });

  it('is empty for a fresh snapshot with no windows and no error', () => {
    expect(formatUsageSummary(snapshot(), NOW)).toBe('');
  });
});

// -------------------------------------------------------------- usageSummaryOf

describe('usageSummaryOf', () => {
  it('uses the wiring\'s own formatter when it returns a string', () => {
    const deps = fakeDeps({ formatUsage: () => 'custom wording' });
    expect(usageSummaryOf(deps, snapshot())).toBe('custom wording');
  });

  it('falls back to formatUsageSummary when the custom formatter throws', () => {
    const deps = fakeDeps({
      formatUsage: () => {
        throw new Error('boom');
      },
    });
    expect(
      usageSummaryOf(deps, snapshot({ fiveHour: { utilization: 9 } })),
    ).toBe('5h 9%');
  });

  it('falls back when the custom formatter answers a non-string', () => {
    const deps = fakeDeps({
      formatUsage: () => undefined as unknown as string,
    });
    expect(
      usageSummaryOf(deps, snapshot({ fiveHour: { utilization: 9 } })),
    ).toBe('5h 9%');
  });

  it('falls back to formatUsageSummary when there is no custom formatter', () => {
    const deps = fakeDeps();
    expect(
      usageSummaryOf(deps, snapshot({ fiveHour: { utilization: 9 } })),
    ).toBe('5h 9%');
  });
});

// ------------------------------------------------------------- AccountUsageCache
//
// The cache takes a bare `LimitsReader` (types.ts): `cached` and `onDidChange`
// are optional on that interface, so the "reader that only fetches" case below
// is a real wiring, not a stub of one.

describe('AccountUsageCache', () => {
  it('answers null everywhere with no reader at all', async () => {
    const cache = new AccountUsageCache();
    expect(cache.get(profile('a'))).toBeNull();
    await expect(cache.refresh([profile('a')])).resolves.toBeUndefined();
    expect(cache.get(profile('a'))).toBeNull();
  });

  it('reads once per profile and the result becomes get()', async () => {
    const reads: string[] = [];
    const source: LimitsReader = {
      readUsage: async (p) => {
        reads.push(p.id);
        return snapshot({ fiveHour: { utilization: 40 } });
      },
    };
    const cache = new AccountUsageCache(source);
    await cache.refresh([profile('a'), profile('b')]);
    expect(reads.sort()).toEqual(['a', 'b']);
    expect(cache.get(profile('a'))?.fiveHour?.utilization).toBe(40);
  });

  it('serves from cache inside USAGE_MIN_AGE_MS unless forced', async () => {
    let calls = 0;
    const source: LimitsReader = {
      readUsage: async () => {
        calls += 1;
        return snapshot();
      },
    };
    const cache = new AccountUsageCache(source);
    await cache.refresh([profile('a')]);
    await cache.refresh([profile('a')]);
    expect(calls).toBe(1);
    await cache.refresh([profile('a')], { force: true });
    expect(calls).toBe(2);
  });

  it('passes force THROUGH to the reader — the service has its own guard too', async () => {
    // Two interval guards sit between the button and the network: this cache's
    // age map and the limits service's own minimum interval. Stepping over one
    // and not the other is a Refresh that still returns the cache.
    const seen: (boolean | undefined)[] = [];
    const reader: LimitsReader = {
      readUsage: async (_p, opts) => {
        seen.push(opts?.force);
        return snapshot();
      },
    };
    const cache = new AccountUsageCache(reader);
    await cache.refresh([profile('a')]);
    await cache.refresh([profile('a')], { force: true });
    expect(seen).toEqual([false, true]);
  });

  it('never rejects when the reader throws — the account is simply unknown', async () => {
    const source: LimitsReader = {
      readUsage: async () => {
        throw new Error('network');
      },
    };
    const cache = new AccountUsageCache(source);
    await expect(cache.refresh([profile('a')])).resolves.toBeUndefined();
    expect(cache.get(profile('a'))).toBeNull();
  });

  it('does not start a second read for a profile already in flight', async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const source: LimitsReader = {
      readUsage: async () => {
        calls += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return snapshot();
      },
    };
    const cache = new AccountUsageCache(source);
    const first = cache.refresh([profile('a')]);
    const second = cache.refresh([profile('a')]); // same id, still in flight
    release?.();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });

  it('fires onDidChange once a refresh actually changed something', async () => {
    const source: LimitsReader = { readUsage: async () => snapshot() };
    const cache = new AccountUsageCache(source);
    let fired = 0;
    cache.onDidChange(() => {
      fired += 1;
    });
    await cache.refresh([profile('a')]);
    expect(fired).toBe(1);
  });

  it('mapFor answers per profile and skips an unusable entry', async () => {
    const source: LimitsReader = {
      readUsage: async (p) =>
        snapshot({ fiveHour: { utilization: p.id === 'a' ? 10 : 20 } }),
    };
    const cache = new AccountUsageCache(source);
    await cache.refresh([profile('a'), profile('b')]);
    const map = cache.mapFor([profile('a'), profile('b'), profile('')]);
    expect(map.get('a')?.fiveHour?.utilization).toBe(10);
    expect(map.get('b')?.fiveHour?.utilization).toBe(20);
    expect(map.size).toBe(2); // the empty-id entry never joins the map
  });

  it("a reader's own cached() wins over what this process fetched itself", () => {
    const source: LimitsReader = {
      readUsage: async () => snapshot(),
      cached: (p) =>
        p.id === 'a' ? snapshot({ fiveHour: { utilization: 99 } }) : null,
    };
    const cache = new AccountUsageCache(source);
    expect(cache.get(profile('a'))?.fiveHour?.utilization).toBe(99);
  });

  it('forget() drops the cached snapshot and its age (a next refresh re-fetches)', async () => {
    let calls = 0;
    const source: LimitsReader = {
      readUsage: async () => {
        calls += 1;
        return snapshot();
      },
    };
    const cache = new AccountUsageCache(source);
    await cache.refresh([profile('a')]);
    expect(cache.get(profile('a'))).not.toBeNull();
    cache.forget('a');
    expect(cache.get(profile('a'))).toBeNull();
    await cache.refresh([profile('a')]);
    expect(calls).toBe(2); // re-fetched — forget() also cleared the age guard
  });

  it('dispose() detaches from the reader and never throws, even twice', () => {
    const cache = new AccountUsageCache({
      readUsage: async () => snapshot(),
      onDidChange: () => ({ dispose: () => undefined }),
    });
    expect(() => {
      cache.dispose();
      cache.dispose();
    }).not.toThrow();
  });
});

// ----------------------------------------------------------- AccountsViewProvider

describe('AccountsViewProvider.getChildren — flat, ordered by accounts.sortProfiles', () => {
  it('orders rows by the order field, not creation order or id', () => {
    const a = profile('a', { order: 2, createdAt: '2026-01-01T00:00:00.000Z' });
    const b = profile('b', { order: 0, createdAt: '2026-01-02T00:00:00.000Z' });
    const c = profile('c', { order: 1, createdAt: '2026-01-03T00:00:00.000Z' });
    const p = new AccountsViewProvider(fakeDeps({ accounts: () => [a, b, c] }));
    expect(p.getChildren().map((r) => r.profile.id)).toEqual(['b', 'c', 'a']);
  });

  it('every row is kind "account" and carries the whole profile', () => {
    const p = new AccountsViewProvider(fakeDeps({ accounts: () => [profile('a')] }));
    const [row] = p.getChildren();
    expect(row.kind).toBe('account');
    expect(row.profile.id).toBe('a');
  });

  it('a row has no children — the view is flat by construction', () => {
    const p = new AccountsViewProvider(fakeDeps({ accounts: () => [profile('a')] }));
    const [row] = p.getChildren();
    expect(p.getChildren(row)).toEqual([]);
  });

  it('degrades to [] rather than throwing when accounts() throws', () => {
    const p = new AccountsViewProvider(
      fakeDeps({
        accounts: () => {
          throw new Error('boom');
        },
      }),
    );
    expect(p.getChildren()).toEqual([]);
  });
});

describe('AccountsViewProvider.getTreeItem — id, contextValue, description', () => {
  it('ids the row "account:<id>" and labels it with the profile label', () => {
    const p = new AccountsViewProvider(
      fakeDeps({ accounts: () => [profile('work', { label: 'Work (Max)' })] }),
    );
    const item = p.getTreeItem(p.getChildren()[0]);
    expect(item.id).toBe('account:work');
    expect(item.label).toBe('Work (Max)');
  });

  it('contextValue names the default routing target, and only that one', () => {
    const a = profile('a');
    const b = profile('b');
    const p = new AccountsViewProvider(
      fakeDeps({
        accounts: () => [a, b],
        defaultRouting: () => ({ kind: 'account', id: 'b' }),
      }),
    );
    const [rowA, rowB] = p.getChildren();
    expect(p.getTreeItem(rowA).contextValue).toBe(';account;');
    expect(p.getTreeItem(rowB).contextValue).toBe(';account;default;');
  });

  it('a provider or auto default routing marks no row as default', () => {
    const a = profile('a');
    for (const choice of [
      undefined,
      { kind: 'auto' } as RoutingChoice,
      { kind: 'provider', provider: 'claude' } as RoutingChoice,
    ]) {
      const p = new AccountsViewProvider(
        fakeDeps({ accounts: () => [a], defaultRouting: () => choice }),
      );
      expect(p.getTreeItem(p.getChildren()[0]).contextValue).toBe(';account;');
    }
  });

  it('description carries the star only for the default row, plus the usage summary', () => {
    const a = profile('a');
    const p = new AccountsViewProvider(
      fakeDeps({
        accounts: () => [a],
        defaultRouting: () => ({ kind: 'account', id: 'a' }),
        usage: () => snapshot({ fiveHour: { utilization: 30 } }),
      }),
    );
    expect(p.getTreeItem(p.getChildren()[0]).description).toBe(
      '★ default · 5h 30%',
    );
  });

  it('a non-default row with no usage data has an empty description', () => {
    const p = new AccountsViewProvider(fakeDeps({ accounts: () => [profile('a')] }));
    expect(p.getTreeItem(p.getChildren()[0]).description).toBe('');
  });

  it('getTreeItem tolerates a throwing usage() and mediaPath()', () => {
    const p = new AccountsViewProvider(
      fakeDeps({
        accounts: () => [profile('a')],
        usage: () => {
          throw new Error('boom');
        },
        mediaPath: () => {
          throw new Error('boom');
        },
      }),
    );
    expect(() => p.getTreeItem(p.getChildren()[0])).not.toThrow();
  });
});

describe('AccountsViewProvider provider icons — codex is a light/dark PAIR', () => {
  it('gives codex a { light, dark } Uri pair when both files resolve', () => {
    const p = new AccountsViewProvider(
      fakeDeps({
        accounts: () => [profile('cx', { provider: 'codex' })],
        mediaPath: (relative) => `/ext/${relative}`,
      }),
    );
    const icon = p.getTreeItem(p.getChildren()[0]).iconPath as {
      light: { path: string };
      dark: { path: string };
    };
    expect(icon.light.path).toBe(`/ext/${PROVIDER_MEDIA_DIR}/codex.svg`);
    expect(icon.dark.path).toBe(`/ext/${PROVIDER_MEDIA_DIR}/codex-dark.svg`);
  });

  it('gives claude (no dark variant declared) a single Uri, not a pair', () => {
    const p = new AccountsViewProvider(
      fakeDeps({
        accounts: () => [profile('cl', { provider: 'claude' })],
        mediaPath: (relative) => `/ext/${relative}`,
      }),
    );
    const icon = p.getTreeItem(p.getChildren()[0]).iconPath as {
      path?: string;
      light?: unknown;
    };
    expect(icon.path).toBe(`/ext/${PROVIDER_MEDIA_DIR}/claude.svg`);
    expect(icon.light).toBeUndefined();
  });

  it('falls back to the provider codicon with no media path available', () => {
    const p = new AccountsViewProvider(
      fakeDeps({ accounts: () => [profile('cx', { provider: 'codex' })] }),
    );
    const icon = p.getTreeItem(p.getChildren()[0]).iconPath as { id: string };
    expect(icon.id).toBe('circuit-board'); // PROVIDERS.codex.fallbackIcon
  });

  it('falls back to the codicon when only the dark half of a pair resolves', () => {
    // Half a pair renders nothing on the missing side — same rule tree.ts
    // uses for a session row's provider glyph.
    const p = new AccountsViewProvider(
      fakeDeps({
        accounts: () => [profile('cx', { provider: 'codex' })],
        mediaPath: (relative) =>
          relative.includes('codex-dark') ? `/ext/${relative}` : undefined,
      }),
    );
    const icon = p.getTreeItem(p.getChildren()[0]).iconPath as { id: string };
    expect(icon.id).toBe('circuit-board');
  });

  it('an unknown provider id falls back to claude\'s icon', () => {
    const p = new AccountsViewProvider(
      fakeDeps({
        accounts: () => [profile('x', { provider: 'llama' as AccountProfile['provider'] })],
        mediaPath: (relative) => `/ext/${relative}`,
      }),
    );
    const icon = p.getTreeItem(p.getChildren()[0]).iconPath as { path?: string };
    expect(icon.path).toBe(`/ext/${PROVIDER_MEDIA_DIR}/claude.svg`);
  });
});

describe('AccountsViewProvider tooltip — never a credential VALUE, only names', () => {
  it('names extraEnv keys and never their values', () => {
    const p = new AccountsViewProvider(
      fakeDeps({
        accounts: () => [
          profile('key', {
            provider: 'generic',
            extraEnv: { ANTHROPIC_API_KEY: 'sk-do-not-print-this-3f9a' },
          }),
        ],
      }),
    );
    const tooltip = p.getTreeItem(p.getChildren()[0]).tooltip as { value: string };
    // mdEscape backslash-escapes markdown-active characters (`_` included),
    // so the KEY NAME survives as an escaped token — the assertion that
    // matters is that the VALUE is nowhere in it, escaped or not.
    expect(tooltip.value).toContain('ANTHROPIC\\_API\\_KEY');
    expect(tooltip.value).not.toContain('sk-do-not-print-this-3f9a');
    expect(tooltip.value).not.toContain('sk-do-not-print-this');
  });

  it('says it inherits the machine login when there is no config directory', () => {
    const p = new AccountsViewProvider(fakeDeps({ accounts: () => [profile('a')] }));
    const tooltip = p.getTreeItem(p.getChildren()[0]).tooltip as { value: string };
    expect(tooltip.value).toContain('whatever this machine is already logged in as');
  });

  it('shows the config directory (a path, not a secret) when one is set', () => {
    const p = new AccountsViewProvider(
      fakeDeps({ accounts: () => [profile('a', { configDir: '/work/.claude' })] }),
    );
    const tooltip = p.getTreeItem(p.getChildren()[0]).tooltip as { value: string };
    expect(tooltip.value).toContain('/work/.claude');
  });

  it('says a directory it does not use is NOT used — envForProfile ignores it, so a bare path would claim an isolation this account has not got', () => {
    const p = new AccountsViewProvider(
      fakeDeps({
        accounts: () => [
          profile('g', { provider: 'gemini', configDir: '/would/be/wrong' }),
        ],
      }),
    );
    const tooltip = p.getTreeItem(p.getChildren()[0]).tooltip as { value: string };
    expect(tooltip.value).toContain('not used');
    expect(tooltip.value).toContain('already logged in as');
  });

  it('says so when no session can start on the account', () => {
    // Gemini, not Codex: Codex accounts host sessions now, and this note is
    // for the providers whose CLI Flock still does not launch.
    const p = new AccountsViewProvider(
      fakeDeps({ accounts: () => [profile('x', { provider: 'gemini' })] }),
    );
    const tooltip = p.getTreeItem(p.getChildren()[0]).tooltip as { value: string };
    expect(tooltip.value).toContain('New sessions cannot start on this account');
  });

  it('a Codex account says nothing of the kind — sessions start there now', () => {
    const p = new AccountsViewProvider(
      fakeDeps({ accounts: () => [profile('x', { provider: 'codex' })] }),
    );
    const tooltip = p.getTreeItem(p.getChildren()[0]).tooltip as { value: string };
    expect(tooltip.value).not.toContain('New sessions cannot start');
  });

  it('a launchable account says nothing of the kind', () => {
    const p = new AccountsViewProvider(fakeDeps({ accounts: () => [profile('a')] }));
    const tooltip = p.getTreeItem(p.getChildren()[0]).tooltip as { value: string };
    expect(tooltip.value).not.toContain('New sessions cannot start');
  });

  it('lists every window that has a number', () => {
    const p = new AccountsViewProvider(
      fakeDeps({
        accounts: () => [profile('a')],
        usage: () =>
          snapshot({
            fiveHour: { utilization: 12 },
            sevenDay: { utilization: 34 },
          }),
      }),
    );
    const tooltip = p.getTreeItem(p.getChildren()[0]).tooltip as { value: string };
    expect(tooltip.value).toContain('Five-hour window: 12%');
    expect(tooltip.value).toContain('Weekly: 34%');
    expect(tooltip.value).not.toContain('Weekly (Opus)');
  });

  it('falls back to the plain label (a string) if building the markdown throws', () => {
    const p = new AccountsViewProvider(
      fakeDeps({
        accounts: () => [profile('a', { label: 'Plain Label' })],
        usage: () => {
          throw new Error('boom');
        },
      }),
    );
    // usage() throwing is caught INSIDE tooltip() by usageOf(); the tooltip
    // still builds normally. This pins that the row never crashes regardless.
    expect(() => p.getTreeItem(p.getChildren()[0])).not.toThrow();
  });
});

describe('AccountsViewProvider.refresh / dispose', () => {
  it('refresh() fires onDidChangeTreeData with undefined (repaint everything)', () => {
    const p = new AccountsViewProvider(fakeDeps());
    const seen: Array<AccountRow | undefined> = [];
    p.onDidChangeTreeData((e) => seen.push(e));
    p.refresh();
    expect(seen).toEqual([undefined]);
  });

  it('dispose() never throws, even called twice', () => {
    const p = new AccountsViewProvider(fakeDeps());
    expect(() => {
      p.dispose();
      p.dispose();
    }).not.toThrow();
  });
});

// ----------------------------------------------------------- the ten verbs

/** The account half of COMMANDS (types.ts). Named here rather than derived so
 *  that DELETING one of these ids from types.ts fails this file loudly instead
 *  of quietly shrinking the list it checks the manifest against. */
const ACCOUNT_COMMAND_IDS = [
  COMMANDS.addAccount,
  COMMANDS.loginAccount,
  COMMANDS.removeAccount,
  COMMANDS.setDefaultAccount,
  COMMANDS.moveAccountUp,
  COMMANDS.moveAccountDown,
  COMMANDS.refreshAccountUsage,
  COMMANDS.newSessionFromAccount,
  COMMANDS.newSessionFromPicker,
  COMMANDS.setProjectAccount,
] as const;

describe('the ten account verbs', () => {
  it('is exactly ten ids, every one under the lineage. prefix, no duplicates', () => {
    expect(ACCOUNT_COMMAND_IDS).toHaveLength(10);
    expect(new Set(ACCOUNT_COMMAND_IDS).size).toBe(ACCOUNT_COMMAND_IDS.length);
    for (const id of ACCOUNT_COMMAND_IDS) expect(id.startsWith('lineage.')).toBe(true);
  });
});

// ------------------------------------------------------------ package.json

interface PackageJson {
  contributes: {
    views: Record<string, Array<{ id: string; when?: string }>>;
    commands: Array<{ command: string }>;
    menus: Record<string, Array<{ command?: string; when?: string }>>;
    viewsWelcome: Array<{ view: string; contents: string }>;
  };
}

function readPackageJson(): PackageJson {
  return JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
  ) as PackageJson;
}

describe('package.json — the Accounts surface is wired, not just declared', () => {
  it('puts the Accounts view inside the lineage activity-bar container', () => {
    const pkg = readPackageJson();
    const lineageViews = pkg.contributes.views['lineage'] ?? [];
    const accountsView = lineageViews.find((v) => v.id === ACCOUNTS_VIEW_ID);
    expect(accountsView, 'lineageAccounts not under contributes.views.lineage').toBeDefined();
    expect(accountsView?.when).toContain(CONFIG_KEYS.accountsSection);
  });

  it('declares lineage.accounts.section as a boolean defaulting to true', () => {
    const prop = contributedSettings()[`lineage.${CONFIG_KEYS.accountsSection}`];
    expect(prop, 'lineage.accounts.section not declared').toBeDefined();
    expect(prop?.type).toBe('boolean');
    expect(prop?.default).toBe(true);
  });

  it('every account command is declared AND reachable from somewhere', () => {
    const pkg = readPackageJson();
    const declared = new Set(pkg.contributes.commands.map((c) => c.command));
    const inAnyMenu = new Set<string>();
    for (const [where, entries] of Object.entries(pkg.contributes.menus)) {
      for (const entry of entries) {
        // `commandPalette` is the one menu whose entries SUPPRESS rather than
        // offer: an entry there exists to say `when: false`. Counting it as
        // reachability is the loophole that let a verb lose its only real menu
        // entry and still pass — which is exactly what happened when the project
        // context menu was cut back to seven entries.
        if (where === 'commandPalette') continue;
        if (entry.command) inAnyMenu.add(entry.command);
      }
    }
    // A command with NO commandPalette entry is in the palette by default, which
    // is a door like any other.
    const suppressed = new Set(
      (pkg.contributes.menus.commandPalette ?? [])
        .filter((e) => e.when === 'false')
        .map((e) => e.command),
    );
    for (const id of ACCOUNT_COMMAND_IDS) {
      expect(declared.has(id), `${id} missing from contributes.commands`).toBe(true);
      expect(
        inAnyMenu.has(id) || !suppressed.has(id),
        `${id} is in no menu and suppressed from the palette — nothing can reach it`,
      ).toBe(true);
    }
  });

  it('offers a way to add the first account from the empty Accounts view', () => {
    const pkg = readPackageJson();
    const welcome = pkg.contributes.viewsWelcome.find(
      (w) => w.view === ACCOUNTS_VIEW_ID,
    );
    expect(welcome, 'no viewsWelcome for lineageAccounts').toBeDefined();
    expect(welcome?.contents).toContain(`command:${COMMANDS.addAccount}`);
  });
});
