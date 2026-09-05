// test/accounts.test.ts — the CONTRACT under test: src/accounts.ts.
//
// Pure module, no vscode, no fs, no node builtins on the import side (only in
// this file's helpers). The contract worth pinning:
//
//   envForProfile   the ONLY place credential isolation actually happens —
//                   wrong provider mapping or wrong merge order here means a
//                   session launches signed into the wrong account, silently.
//   seedDefaultProfiles  idempotent across every activation; never invents a
//                   Codex row on a machine with no Codex login.
//   slugify / isAccountId / uniqueAccountId   the id is a DIRECTORY NAME, so
//                   these double as the traversal guard.
//   sortProfiles / moveUp / moveDown   the ONE ordering definition the view,
//                   the reorder verbs and routing's auto-picker all share.
//
// Nothing here touches the filesystem or the network — `profileConfigDirFor`
// takes `homeDir` as a plain string precisely so this file never needs
// `os.homedir()`.

import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_ID_FALLBACK,
  CLAUDE_CONFIG_DIR_ENV,
  CODEX_HOME_ENV,
  accountEnvKeys,
  canHostSession,
  canHandOff,
  canSwitchAccounts,
  offerSwitch,
  cliOfProfile,
  configDirForProfile,
  DEFAULT_CLAUDE_PROFILE_ID,
  DEFAULT_CODEX_PROFILE_ID,
  PROFILES_DIR_SEGMENTS,
  envForProfile,
  isAccountId,
  isDefaultAccount,
  isEnvVarName,
  moveDown,
  moveUp,
  nextOrder,
  profileConfigDirFor,
  restoreEnvFor,
  seedDefaultProfiles,
  slugify,
  switchMovesNothing,
  sortProfiles,
  switchRefusal,
  uniqueAccountId,
  validateAccountLabel,
} from '../src/accounts';
import { handoffRefusal } from '../src/handoff';

import type { AccountProfile } from '../src/types';

// ------------------------------------------------------------------ helpers

function profile(
  id: string,
  over: Partial<AccountProfile> = {},
): AccountProfile {
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

// -------------------------------------------------------------- envForProfile

describe('envForProfile', () => {
  it('the default account (neither configDir nor extraEnv) resolves to {}', () => {
    expect(envForProfile(profile('claude-default'))).toEqual({});
  });

  it('null/undefined profile resolves to {} — an unpinned session gets no overrides', () => {
    expect(envForProfile(null)).toEqual({});
    expect(envForProfile(undefined)).toEqual({});
  });

  it('claude + configDir sets CLAUDE_CONFIG_DIR only', () => {
    const p = profile('work', { configDir: '/Users/axel/.lineage/profiles/work' });
    expect(envForProfile(p)).toEqual({
      [CLAUDE_CONFIG_DIR_ENV]: '/Users/axel/.lineage/profiles/work',
    });
  });

  it('codex + configDir sets CODEX_HOME only', () => {
    const p = profile('codex-work', {
      provider: 'codex',
      configDir: '/Users/axel/.lineage/profiles/codex-work',
    });
    expect(envForProfile(p)).toEqual({
      [CODEX_HOME_ENV]: '/Users/axel/.lineage/profiles/codex-work',
    });
  });

  it('claude with NO configDir sets nothing, even with extraEnv present', () => {
    const p = profile('key-only', { extraEnv: { ANTHROPIC_API_KEY: 'sk-test' } });
    expect(envForProfile(p)).toEqual({ ANTHROPIC_API_KEY: 'sk-test' });
  });

  it('extraEnv merges OVER the config-dir var and WINS on collision', () => {
    // An API-key profile that also names a configDir: "use this store, but
    // authenticate with this key" — the explicit override has to win.
    const p = profile('override', {
      configDir: '/a/b',
      extraEnv: { [CLAUDE_CONFIG_DIR_ENV]: '/somewhere/else', OTHER: 'x' },
    });
    expect(envForProfile(p)).toEqual({
      [CLAUDE_CONFIG_DIR_ENV]: '/somewhere/else',
      OTHER: 'x',
    });
  });

  it('gemini/generic providers IGNORE configDir — no documented var to guess', () => {
    const gemini = profile('g', { provider: 'gemini', configDir: '/would/be/wrong' });
    expect(envForProfile(gemini)).toEqual({});
    const generic = profile('o', { provider: 'generic', configDir: '/would/be/wrong' });
    expect(envForProfile(generic)).toEqual({});
  });

  it('gemini/generic still honour extraEnv — the escape hatch', () => {
    const p = profile('g', { provider: 'gemini', extraEnv: { GEMINI_API_KEY: 'x' } });
    expect(envForProfile(p)).toEqual({ GEMINI_API_KEY: 'x' });
  });

  it('canHostSession: claude, codex and generic yes, gemini no', () => {
    // The rule is "Flock execs THIS provider's CLI", so that the config root
    // envForProfile relocates is the one the running process actually reads.
    // Codex passes it now that the launcher picks its binary per provider
    // (src/codex.ts); Gemini still fails it, because nothing launches that CLI
    // and no CONFIG_DIR_ENV entry exists to isolate it if anything did.
    expect(canHostSession(profile('c', { provider: 'claude' }))).toBe(true);
    expect(canHostSession(profile('k', { provider: 'generic' }))).toBe(true);
    expect(canHostSession(profile('x', { provider: 'codex' }))).toBe(true);
    expect(canHostSession(profile('g', { provider: 'gemini' }))).toBe(false);
  });

  it('canHostSession: no profile is not a launchable one; an unknown provider reads as the default (claude)', () => {
    expect(canHostSession(null)).toBe(false);
    expect(canHostSession(undefined)).toBe(false);
    const odd = profile('o', {
      provider: 'llama' as AccountProfile['provider'],
    });
    expect(canHostSession(odd)).toBe(true);
  });

  it('blank/whitespace configDir is treated as absent', () => {
    const p = profile('blank', { configDir: '   ' });
    expect(envForProfile(p)).toEqual({});
  });

  it('drops extraEnv keys that are not valid POSIX env names', () => {
    const p = profile('bad-keys', {
      extraEnv: {
        'has space': 'x',
        'has=equals': 'y',
        'GOOD_KEY': 'z',
      } as unknown as Record<string, string>,
    });
    expect(envForProfile(p)).toEqual({ GOOD_KEY: 'z' });
  });

  it('drops an extraEnv value containing a NUL byte', () => {
    const p = profile('nul', { extraEnv: { KEY: 'a\0b' } });
    expect(envForProfile(p)).toEqual({});
  });

  it('drops a non-string extraEnv value (JSON-boundary defense)', () => {
    const p = profile('weird', {
      extraEnv: { KEY: 123 } as unknown as Record<string, string>,
    });
    expect(envForProfile(p)).toEqual({});
  });

  it('ignores extraEnv that is not a plain object (array, JSON boundary)', () => {
    const p = profile('arr', {
      extraEnv: ['not', 'an', 'object'] as unknown as Record<string, string>,
    });
    expect(envForProfile(p)).toEqual({});
  });

  it('returns a FRESH object every call — no shared mutable state', () => {
    const p = profile('work', { configDir: '/a/b' });
    const first = envForProfile(p);
    first.INJECTED = 'x';
    const second = envForProfile(p);
    expect(second).toEqual({ [CLAUDE_CONFIG_DIR_ENV]: '/a/b' });
  });

  it('an unrecognized provider id (JSON-boundary) ignores configDir', () => {
    const p = profile('unknown-provider', {
      provider: 'not-a-real-provider' as unknown as AccountProfile['provider'],
      configDir: '/a/b',
    });
    expect(envForProfile(p)).toEqual({});
  });
});

describe('isDefaultAccount', () => {
  it('true for a profile with neither configDir nor extraEnv', () => {
    expect(isDefaultAccount(profile('p'))).toBe(true);
  });

  it('true for a profile with an EMPTY extraEnv object', () => {
    expect(isDefaultAccount(profile('p', { extraEnv: {} }))).toBe(true);
  });

  it('false once configDir is set', () => {
    expect(isDefaultAccount(profile('p', { configDir: '/a' }))).toBe(false);
  });

  it('false once extraEnv carries at least one entry', () => {
    expect(isDefaultAccount(profile('p', { extraEnv: { K: 'v' } }))).toBe(false);
  });

  it('false for undefined', () => {
    expect(isDefaultAccount(undefined)).toBe(false);
  });

  it('blank configDir still counts as default (matches envForProfile)', () => {
    expect(isDefaultAccount(profile('p', { configDir: '   ' }))).toBe(true);
  });
});

// ------------------------------------------------------------------ ids

describe('slugify', () => {
  it('lowercases and dash-separates', () => {
    expect(slugify('Work (Max)')).toBe('work-max');
  });

  it('folds diacritics instead of dropping them into a trailing dash', () => {
    expect(slugify('Café')).toBe('cafe');
  });

  it('collapses every non [a-z0-9] run to a single dash', () => {
    expect(slugify('a___b---c   d')).toBe('a-b-c-d');
  });

  it('trims leading/trailing dashes', () => {
    expect(slugify('--hello--')).toBe('hello');
  });

  it('caps length at MAX_ACCOUNT_ID_LEN and re-trims the cut', () => {
    const raw = 'a'.repeat(60);
    const slug = slugify(raw);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('a label that slugs to nothing yields the empty string, not a crash', () => {
    expect(slugify('日本語')).toBe('');
    expect(slugify('!!!')).toBe('');
  });

  it('non-string input yields the empty string', () => {
    expect(slugify(undefined)).toBe('');
    expect(slugify(42 as unknown as string)).toBe('');
  });
});

describe('isAccountId', () => {
  it('accepts a plain lowercase slug', () => {
    expect(isAccountId('work-max')).toBe(true);
  });

  it('accepts a single character', () => {
    expect(isAccountId('a')).toBe(true);
  });

  it('rejects empty', () => {
    expect(isAccountId('')).toBe(false);
  });

  it('rejects uppercase', () => {
    expect(isAccountId('Work')).toBe(false);
  });

  it('rejects a leading or trailing dash', () => {
    expect(isAccountId('-work')).toBe(false);
    expect(isAccountId('work-')).toBe(false);
  });

  it('rejects traversal spellings — the whole reason the rule is strict', () => {
    expect(isAccountId('../../etc')).toBe(false);
    expect(isAccountId('..')).toBe(false);
    expect(isAccountId('a/b')).toBe(false);
    expect(isAccountId('a.b')).toBe(false);
  });

  it('rejects longer than MAX_ACCOUNT_ID_LEN', () => {
    expect(isAccountId('a'.repeat(41))).toBe(false);
    expect(isAccountId('a'.repeat(40))).toBe(true);
  });

  it('rejects non-string input', () => {
    expect(isAccountId(undefined)).toBe(false);
    expect(isAccountId(42)).toBe(false);
    expect(isAccountId(null)).toBe(false);
  });
});

describe('uniqueAccountId', () => {
  it('returns the plain slug when nothing collides', () => {
    expect(uniqueAccountId('Personal', [])).toBe('personal');
  });

  it('appends -2, -3, ... on collision', () => {
    expect(uniqueAccountId('Work', ['work'])).toBe('work-2');
    expect(uniqueAccountId('Work', ['work', 'work-2'])).toBe('work-3');
  });

  it('matches existing ids case-insensitively', () => {
    expect(uniqueAccountId('Work', ['WORK'])).toBe('work-2');
  });

  it('falls back to ACCOUNT_ID_FALLBACK when the base slugs to nothing', () => {
    expect(uniqueAccountId('!!!', [])).toBe(ACCOUNT_ID_FALLBACK);
    expect(uniqueAccountId('!!!', [ACCOUNT_ID_FALLBACK])).toBe(`${ACCOUNT_ID_FALLBACK}-2`);
  });

  it('keeps the result within MAX_ACCOUNT_ID_LEN when suffixing a maxed-out slug', () => {
    const base = 'a'.repeat(40);
    const taken = [base];
    const id = uniqueAccountId(base, taken);
    expect(id.length).toBeLessThanOrEqual(40);
    expect(id).not.toBe(base);
    expect(isAccountId(id)).toBe(true);
  });

  it('ignores non-string entries in the taken iterable', () => {
    expect(
      uniqueAccountId('Work', ['work', null as unknown as string, undefined as unknown as string]),
    ).toBe('work-2');
  });
});

describe('validateAccountLabel', () => {
  const existing: AccountProfile[] = [profile('p1', { label: 'Work (Max)' })];

  it('accepts a fresh, well-formed label', () => {
    expect(validateAccountLabel('Personal', existing)).toBe('');
  });

  it('rejects empty / whitespace-only', () => {
    expect(validateAccountLabel('   ', existing)).toMatch(/empty/i);
  });

  it('rejects over MAX_ACCOUNT_LABEL_LEN', () => {
    expect(validateAccountLabel('x'.repeat(61), existing)).toMatch(/60/);
  });

  it('accepts exactly MAX_ACCOUNT_LABEL_LEN', () => {
    expect(validateAccountLabel('x'.repeat(60), existing)).toBe('');
  });

  it('rejects a case-insensitive duplicate label', () => {
    expect(validateAccountLabel('work (max)', existing)).toMatch(/already exists/i);
  });

  it('a profile editing ITSELF is exempt via selfId', () => {
    expect(validateAccountLabel('Work (Max)', existing, 'p1')).toBe('');
  });

  it('another profile still collides even with a selfId given', () => {
    const two = [...existing, profile('p2', { label: 'Personal' })];
    expect(validateAccountLabel('Personal', two, 'p1')).toMatch(/already exists/i);
  });

  it('trims before comparing and measuring length', () => {
    expect(validateAccountLabel('  Personal  ', existing)).toBe('');
  });
});

// --------------------------------------------------------------- locations

describe('profileConfigDirFor', () => {
  it('joins home + PROFILES_DIR_SEGMENTS + id with forward slashes', () => {
    expect(profileConfigDirFor('work', '/Users/axel')).toBe(
      ['/Users/axel', ...PROFILES_DIR_SEGMENTS, 'work'].join('/'),
    );
  });

  it('normalizes backslashes and a trailing slash on homeDir', () => {
    expect(profileConfigDirFor('work', 'C:\\Users\\axel\\')).toBe(
      'C:/Users/axel/.lineage/profiles/work',
    );
  });

  it("'' for an unusable (non-slug) id", () => {
    expect(profileConfigDirFor('../../etc', '/Users/axel')).toBe('');
    expect(profileConfigDirFor('', '/Users/axel')).toBe('');
  });

  it("'' for a blank or non-string homeDir", () => {
    expect(profileConfigDirFor('work', '   ')).toBe('');
    expect(profileConfigDirFor('work', undefined as unknown as string)).toBe('');
  });
});

// ---------------------------------------------------------------- ordering

describe('sortProfiles', () => {
  it('sorts by order ascending', () => {
    const list = [profile('b', { order: 2 }), profile('a', { order: 1 })];
    expect(sortProfiles(list).map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('ties on order break by createdAt', () => {
    const list = [
      profile('newer', { order: 0, createdAt: '2026-02-01T00:00:00.000Z' }),
      profile('older', { order: 0, createdAt: '2026-01-01T00:00:00.000Z' }),
    ];
    expect(sortProfiles(list).map((p) => p.id)).toEqual(['older', 'newer']);
  });

  it('ties on order AND createdAt break by id', () => {
    const list = [
      profile('zeta', { order: 0, createdAt: '2026-01-01T00:00:00.000Z' }),
      profile('alpha', { order: 0, createdAt: '2026-01-01T00:00:00.000Z' }),
    ];
    expect(sortProfiles(list).map((p) => p.id)).toEqual(['alpha', 'zeta']);
  });

  it('a non-finite order sorts last rather than poisoning the comparison', () => {
    const list = [
      profile('weird', { order: 'first' as unknown as number }),
      profile('normal', { order: 0 }),
    ];
    expect(sortProfiles(list).map((p) => p.id)).toEqual(['normal', 'weird']);
  });

  it('filters out null/undefined entries defensively', () => {
    const list = [profile('a'), null, undefined] as unknown as AccountProfile[];
    expect(sortProfiles(list).map((p) => p.id)).toEqual(['a']);
  });

  it('does not mutate its input', () => {
    const list = [profile('b', { order: 1 }), profile('a', { order: 0 })];
    const copy = [...list];
    sortProfiles(list);
    expect(list).toEqual(copy);
  });
});

describe('nextOrder', () => {
  it('one past the highest existing order', () => {
    expect(nextOrder([profile('a', { order: 0 }), profile('b', { order: 3 })])).toBe(4);
  });

  it('0 for an empty roster', () => {
    expect(nextOrder([])).toBe(0);
  });

  it('ignores non-finite order values when finding the max', () => {
    expect(nextOrder([profile('a', { order: 'x' as unknown as number })])).toBe(0);
  });
});

describe('moveUp / moveDown', () => {
  // Deliberately out-of-order `order` values with a gap and no duplicates —
  // moveBy sorts through sortProfiles first, so the renumbered result is
  // 0..n-1 regardless of what the input's raw numbers were.
  function roster(): AccountProfile[] {
    return [
      profile('a', { order: 0 }),
      profile('b', { order: 1 }),
      profile('c', { order: 5 }),
    ];
  }

  it('moveUp swaps the target above its neighbour and renumbers only the pair', () => {
    const moves = moveUp(roster(), 'c');
    expect(moves).toEqual(
      expect.arrayContaining([
        { id: 'c', order: 1 },
        { id: 'b', order: 2 },
      ]),
    );
    // 'a' did not move and is not reported.
    expect(moves.find((m) => m.id === 'a')).toBeUndefined();
  });

  it('moveDown swaps the target below its neighbour', () => {
    const moves = moveDown(roster(), 'a');
    expect(moves).toEqual(
      expect.arrayContaining([
        { id: 'a', order: 1 },
        { id: 'b', order: 0 },
      ]),
    );
  });

  it('moveUp at the top of the list is impossible: []', () => {
    expect(moveUp(roster(), 'a')).toEqual([]);
  });

  it('moveDown at the bottom of the list is impossible: []', () => {
    expect(moveDown(roster(), 'c')).toEqual([]);
  });

  it('an unknown id is impossible: []', () => {
    expect(moveUp(roster(), 'ghost')).toEqual([]);
    expect(moveDown(roster(), 'ghost')).toEqual([]);
  });

  it('a single-account roster can move neither up nor down', () => {
    const one = [profile('solo', { order: 0 })];
    expect(moveUp(one, 'solo')).toEqual([]);
    expect(moveDown(one, 'solo')).toEqual([]);
  });

  it('self-heals duplicate order values on the first move', () => {
    const dupes = [
      profile('a', { order: 0 }),
      profile('b', { order: 0 }),
      profile('c', { order: 0 }),
    ];
    // Canonical order for three ties is a, b, c (createdAt/id tiebreak — all
    // equal here, so id order). Moving 'c' up one swaps it with 'b'; 'a'
    // stays first at order 0 and is correctly NOT reported (its order value
    // did not change), which is exactly what "only entries that changed"
    // promises.
    const moves = moveUp(dupes, 'c');
    expect(moves).toEqual(
      expect.arrayContaining([
        { id: 'c', order: 1 },
        { id: 'b', order: 2 },
      ]),
    );
    expect(moves.find((m) => m.id === 'a')).toBeUndefined();
    expect(moves).toHaveLength(2);
  });
});

// ----------------------------------------------------------------- seeding

describe('seedDefaultProfiles', () => {
  it('on a totally empty roster, seeds Claude only when hasCodexAuth is false', () => {
    const seeded = seedDefaultProfiles([], { hasCodexAuth: false });
    expect(seeded.map((p) => p.id)).toEqual([DEFAULT_CLAUDE_PROFILE_ID]);
    expect(seeded[0].provider).toBe('claude');
    expect(seeded[0].configDir).toBeUndefined();
  });

  it('seeds both Claude and Codex when hasCodexAuth is true', () => {
    const seeded = seedDefaultProfiles([], { hasCodexAuth: true });
    expect(seeded.map((p) => p.id).sort()).toEqual(
      [DEFAULT_CLAUDE_PROFILE_ID, DEFAULT_CODEX_PROFILE_ID].sort(),
    );
    const codex = seeded.find((p) => p.id === DEFAULT_CODEX_PROFILE_ID);
    expect(codex?.provider).toBe('codex');
    expect(codex?.configDir).toBeUndefined();
  });

  it('the CLI alone seeds the Codex row — not yet signed in is what Sign In is for', () => {
    const seeded = seedDefaultProfiles([], { hasCodexAuth: false, hasCodexBinary: true });
    expect(seeded.map((p) => p.id).sort()).toEqual(
      [DEFAULT_CLAUDE_PROFILE_ID, DEFAULT_CODEX_PROFILE_ID].sort(),
    );
    // Neither the login nor the CLI: no Codex row, exactly as before.
    expect(
      seedDefaultProfiles([], { hasCodexAuth: false, hasCodexBinary: false }).map((p) => p.id),
    ).toEqual([DEFAULT_CLAUDE_PROFILE_ID]);
  });

  it('is idempotent: seeding twice against its own output adds nothing', () => {
    const first = seedDefaultProfiles([], { hasCodexAuth: true });
    const second = seedDefaultProfiles(first, { hasCodexAuth: true });
    expect(second).toEqual([]);
  });

  it('a tombstoned seed id stays deleted — the user meant it', () => {
    const seeded = seedDefaultProfiles([], {
      hasCodexAuth: true,
      tombstonedIds: [DEFAULT_CODEX_PROFILE_ID],
    });
    expect(seeded.map((p) => p.id)).toEqual([DEFAULT_CLAUDE_PROFILE_ID]);
  });

  it('an expired tombstone (id no longer listed) lets the seed return', () => {
    const seeded = seedDefaultProfiles([], { hasCodexAuth: true, tombstonedIds: [] });
    expect(seeded.map((p) => p.id).sort()).toEqual(
      [DEFAULT_CLAUDE_PROFILE_ID, DEFAULT_CODEX_PROFILE_ID].sort(),
    );
  });

  it('tombstonedIds tolerates junk entries without suppressing anything else', () => {
    const seeded = seedDefaultProfiles([], {
      hasCodexAuth: false,
      tombstonedIds: ['', 'never-a-seed-id'],
    });
    expect(seeded.map((p) => p.id)).toEqual([DEFAULT_CLAUDE_PROFILE_ID]);
  });

  it('never duplicates an existing id even if the label was changed', () => {
    const renamed = [profile(DEFAULT_CLAUDE_PROFILE_ID, { label: 'My Claude' })];
    expect(seedDefaultProfiles(renamed, { hasCodexAuth: false })).toEqual([]);
  });

  it('skips a provider that already has ANY live profile, seeded or not', () => {
    const custom = [profile('my-own-claude', { provider: 'claude', label: 'Mine' })];
    expect(seedDefaultProfiles(custom, { hasCodexAuth: false })).toEqual([]);
  });

  it('re-seeds Claude if the user deleted the seed (tombstoned, not live)', () => {
    const tombstoned = [
      profile(DEFAULT_CLAUDE_PROFILE_ID, { deleted: true }),
    ];
    const seeded = seedDefaultProfiles(tombstoned, { hasCodexAuth: false });
    expect(seeded.map((p) => p.id)).toEqual([DEFAULT_CLAUDE_PROFILE_ID]);
  });

  it('does not resurrect a Codex account under the SAME provider after deletion, once a custom one exists', () => {
    const custom = [
      profile(DEFAULT_CLAUDE_PROFILE_ID),
      profile('my-codex', { provider: 'codex', label: 'Mine' }),
    ];
    expect(seedDefaultProfiles(custom, { hasCodexAuth: true })).toEqual([]);
  });

  it('new seeds land after the existing roster via nextOrder', () => {
    // A gemini profile so neither default is skipped by the "already has a
    // provider" check — isolates the ordering behaviour being tested.
    const existing = [profile('existing', { provider: 'gemini', order: 4 })];
    const seeded = seedDefaultProfiles(existing, { hasCodexAuth: true });
    expect(seeded.map((p) => p.id).sort()).toEqual(
      [DEFAULT_CLAUDE_PROFILE_ID, DEFAULT_CODEX_PROFILE_ID].sort(),
    );
    expect(seeded[0].order).toBe(5);
    expect(seeded[1].order).toBe(6);
  });

  it('stamps createdAt/updatedAt from the injectable now', () => {
    const now = Date.parse('2026-03-01T00:00:00.000Z');
    const seeded = seedDefaultProfiles([], { hasCodexAuth: false, now });
    expect(seeded[0].createdAt).toBe('2026-03-01T00:00:00.000Z');
    expect(seeded[0].updatedAt).toBe('2026-03-01T00:00:00.000Z');
  });
});

// -------------------------------------------------------------- isEnvVarName

describe('isEnvVarName', () => {
  it('accepts a standard uppercase-with-underscore name', () => {
    expect(isEnvVarName('ANTHROPIC_API_KEY')).toBe(true);
  });

  it('accepts a leading underscore and digits after the first char', () => {
    expect(isEnvVarName('_FOO2')).toBe(true);
  });

  it('rejects a name starting with a digit', () => {
    expect(isEnvVarName('2FOO')).toBe(false);
  });

  it('rejects a name containing "=" or a space', () => {
    expect(isEnvVarName('FOO=BAR')).toBe(false);
    expect(isEnvVarName('FOO BAR')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isEnvVarName(42)).toBe(false);
    expect(isEnvVarName(undefined)).toBe(false);
  });
});

// ------------------------------------------------------- where an account lives

describe('accounts: configDirForProfile', () => {
  const at = (p: Partial<AccountProfile>): string =>
    configDirForProfile({ id: 'x', provider: 'claude', label: 'X', ...p } as AccountProfile, '/home/.claude');

  it('is the profile directory when the provider has a config-dir variable', () => {
    expect(at({ configDir: '/home/.lineage/profiles/work' })).toBe(
      '/home/.lineage/profiles/work',
    );
  });

  it('is the default directory for a profile with no configDir', () => {
    // The DEFAULT ACCOUNT: it inherits whatever the machine is logged in as,
    // so its conversations are in the machine's own directory.
    expect(at({})).toBe('/home/.claude');
  });

  it('is the default directory for a provider with no config-dir variable', () => {
    // Must agree with envForProfile, which ignores configDir for these — the
    // place we write a transcript has to be the place the launch looks.
    const generic: AccountProfile = {
      id: 'k', provider: 'generic', label: 'K', configDir: '/somewhere/else',
    } as AccountProfile;
    expect(configDirForProfile(generic, '/home/.claude')).toBe('/home/.claude');
    expect(envForProfile(generic)).toEqual({});
  });

  it('is the default directory for no profile at all', () => {
    expect(configDirForProfile(null, '/home/.claude')).toBe('/home/.claude');
  });

  it('trims, so a hand-edited path with whitespace still resolves', () => {
    expect(at({ configDir: '  /home/x  ' })).toBe('/home/x');
    expect(at({ configDir: '   ' })).toBe('/home/.claude');
  });
});

// --------------------------------------------- may this conversation move here

describe('accounts: cliOfProfile', () => {
  const of = (provider: string): string =>
    cliOfProfile({ id: 'x', provider, label: 'X' } as AccountProfile);

  it('maps the API-key profile to claude, because that is what it launches', () => {
    expect(of('generic')).toBe('claude');
  });

  it('keeps codex and gemini as themselves', () => {
    expect(of('codex')).toBe('codex');
    expect(of('gemini')).toBe('gemini');
  });

  it('reads an absent or unknown provider as the default one', () => {
    expect(cliOfProfile(null)).toBe('claude');
    expect(of('something-else')).toBe('claude');
  });
});

describe('accounts: switchRefusal', () => {
  const acct = (p: Partial<AccountProfile>): AccountProfile =>
    ({ id: 'a', provider: 'claude', label: 'A', ...p }) as AccountProfile;

  const work = acct({ id: 'work' });
  const personal = acct({ id: 'personal' });

  it('allows a move between two accounts on the same CLI', () => {
    expect(switchRefusal(work, personal)).toBeNull();
  });

  it('allows a move from NO pin — the machine default runs claude too', () => {
    expect(switchRefusal(null, personal)).toBeNull();
  });

  it('allows an OAuth account to move to an API-key one', () => {
    // Different provider, same binary and same transcript layout: the only
    // thing that changes is how the launch authenticates.
    expect(switchRefusal(work, acct({ id: 'key', provider: 'generic' }))).toBeNull();
  });

  it('refuses the account it is already on', () => {
    expect(switchRefusal(work, work)).toBe('same-account');
  });

  it('refuses a move that would change the CLI', () => {
    // A Codex account does not keep its conversations where a Claude one does,
    // so there would be nothing to move and nothing to resume.
    expect(switchRefusal(work, acct({ id: 'cdx', provider: 'codex' }))).toBe(
      'different-cli',
    );
  });

  it('refuses moving a Codex conversation ANYWHERE, now that codex can host', () => {
    // The interaction the onboarding/codex merge created. `codex` is in
    // SESSION_PROVIDERS now, so canHostSession no longer refuses it and the CLI
    // test is the only thing standing between a Codex conversation and a move
    // whose byte-mover only knows Claude's `<dir>/projects/<slug>/<id>.jsonl`.
    const codexFrom = acct({ id: 'cdx1', provider: 'codex' });
    // This rule alone would call two Codex logins a legal pair — same CLI, both
    // hostable — and it is right to: the pair is legal, the MOVER is what has
    // not been written. switchAccountFlow therefore refuses a non-Claude
    // conversation before it ever consults this, and says so in those words.
    expect(switchRefusal(codexFrom, acct({ id: 'cdx2', provider: 'codex' })))
      .toBeNull();
    // What this rule is load-bearing for is the crossing, in both directions.
    expect(switchRefusal(codexFrom, work)).toBe('different-cli');
    expect(switchRefusal(work, codexFrom)).toBe('different-cli');
  });

  it('refuses a Gemini account for the CLI reason, not the capability one', () => {
    // Same ordering rule as the Codex case above: "that is not this
    // conversation's CLI" survives the launcher learning new ones.
    expect(switchRefusal(work, acct({ id: 'gem', provider: 'gemini' }))).toBe(
      'different-cli',
    );
  });

  it('refuses a deleted account and a missing one', () => {
    expect(switchRefusal(work, acct({ id: 'gone', deleted: true }))).toBe(
      'cannot-host',
    );
    expect(switchRefusal(work, undefined)).toBe('cannot-host');
  });
});

// ------------------------------------------- the ONE rule, three consumers
//
// `switchRefusal` above is the rule; these three apply it, and they exist
// because three places used to apply their own version of it and disagree. The
// disagreement was not theoretical: on the roster this extension seeds by
// default the row menu drew "Move to Account…" on every session while the
// picker behind it was always empty.

describe('accounts: canSwitchAccounts', () => {
  const acct = (p: Partial<AccountProfile>): AccountProfile =>
    ({ id: 'a', provider: 'claude', label: 'A', ...p }) as AccountProfile;

  // Exactly the roster `seedDefaultProfiles` mints on a machine that has a
  // Codex login — which is most of them, and this machine.
  const claudeDefault = acct({ id: 'claude-default' });
  const codexDefault = acct({ id: 'codex-default', provider: 'codex' });

  it('does not count a Claude account and a Codex account as two destinations', () => {
    // THE BUG, pinned as the divergence rather than as a value. The context key
    // used to be `filter(canHostSession).length >= 2`, and `canHostSession`
    // accepts codex — so the old test says yes and the picker, built from
    // switchRefusal, has nothing to show.
    const roster = [claudeDefault, codexDefault];
    expect(roster.filter(canHostSession).length >= 2).toBe(true);
    expect(canSwitchAccounts(roster)).toBe(false);
  });

  it('counts two accounts that run the same CLI', () => {
    expect(canSwitchAccounts([claudeDefault, acct({ id: 'work' })])).toBe(true);
    // The API-key profile runs the Claude binary, so it is a real destination.
    expect(
      canSwitchAccounts([claudeDefault, acct({ id: 'key', provider: 'generic' })]),
    ).toBe(true);
  });

  it('needs TWO — one account is somewhere to be, not somewhere to go', () => {
    expect(canSwitchAccounts([claudeDefault])).toBe(false);
    expect(canSwitchAccounts([])).toBe(false);
  });

  it('never counts a deleted account', () => {
    expect(
      canSwitchAccounts([claudeDefault, acct({ id: 'gone', deleted: true })]),
    ).toBe(false);
  });
});

describe('accounts: canHandOff', () => {
  const acct = (p: Partial<AccountProfile>): AccountProfile =>
    ({ id: 'a', provider: 'claude', label: 'A', ...p }) as AccountProfile;

  const claudeDefault = acct({ id: 'claude-default' });
  const codexDefault = acct({ id: 'codex-default', provider: 'codex' });

  it('is the MIRROR of canSwitchAccounts, not a copy of it', () => {
    // The one case that matters, and the reason this is a second key rather
    // than a reuse of the first: the default roster on a machine with a Codex
    // login offers no same-CLI move and is exactly where a handoff belongs.
    // Gating the handoff entry on canSwitchAccounts would have hidden the verb
    // on the only roster that needs it.
    const roster = [claudeDefault, codexDefault];
    expect(canSwitchAccounts(roster)).toBe(false);
    expect(canHandOff(roster)).toBe(true);
  });

  it('does not count two accounts that run the same CLI', () => {
    expect(canHandOff([claudeDefault, acct({ id: 'work' })])).toBe(false);
    // `generic` is the API-key profile: it runs the Claude binary, so pairing
    // it with a Claude login is a switch, never a handoff.
    expect(
      canHandOff([claudeDefault, acct({ id: 'key', provider: 'generic' })]),
    ).toBe(false);
  });

  it('needs TWO — one CLI is what you are on, not what you move to', () => {
    expect(canHandOff([claudeDefault])).toBe(false);
    expect(canHandOff([codexDefault])).toBe(false);
    expect(canHandOff([])).toBe(false);
  });

  it('never counts a deleted account', () => {
    expect(
      canHandOff([claudeDefault, acct({ id: 'codex-default', provider: 'codex', deleted: true })]),
    ).toBe(false);
  });

  it('agrees with handoffRefusal on the roster it reports', () => {
    // The gate and the picker are built from the same two tests, which is the
    // property that broke on the switch entry in 0.1.6 and is asserted here so
    // it cannot break again on this one.
    const roster = [claudeDefault, codexDefault];
    expect(canHandOff(roster)).toBe(true);
    expect(handoffRefusal(claudeDefault, codexDefault, true)).toBeNull();
  });
});

describe('accounts: offerSwitch', () => {
  const acct = (p: Partial<AccountProfile>): AccountProfile =>
    ({ id: 'a', provider: 'claude', label: 'A', ...p }) as AccountProfile;

  const claudeDefault = acct({ id: 'claude-default' });
  const codexDefault = acct({ id: 'codex-default', provider: 'codex' });
  const codex1 = acct({ id: 'cdx1', provider: 'codex' });
  const codex2 = acct({ id: 'cdx2', provider: 'codex' });

  it("refuses on the CONVERSATION's CLI even where switchRefusal allows the pair", () => {
    // Two Codex logins ARE a legal pair by switchRefusal — same CLI, both
    // hostable — and that is what let the at-the-limit notification propose a
    // move its own verb then refused. The refusal belongs here, once, so the
    // notification and the picker cannot get different answers.
    expect(switchRefusal(codex1, codex2)).toBeNull();
    expect(offerSwitch({ cli: 'codex', from: codex1, profiles: [codex1, codex2] }))
      .toEqual({ kind: 'wrong-cli' });
  });

  it('outranks the target list, so the sentence is about the conversation', () => {
    // Both things are wrong at once: not a Claude conversation, and no target
    // either. The useful sentence is the one about what the user is looking at.
    expect(offerSwitch({ cli: 'codex', from: null, profiles: [] })).toEqual({
      kind: 'wrong-cli',
    });
  });

  it('offers the machine default as a source, which has no pin', () => {
    const offer = offerSwitch({
      cli: 'claude',
      from: null,
      profiles: [claudeDefault],
    });
    expect(offer).toEqual({ kind: 'ok', targets: [claudeDefault] });
  });

  it('says no-target for the seeded roster read from its Claude account', () => {
    expect(
      offerSwitch({
        cli: 'claude',
        from: claudeDefault,
        profiles: [claudeDefault, codexDefault],
      }),
    ).toEqual({ kind: 'no-target' });
  });
});

describe('accounts: accountEnvKeys', () => {
  const acct = (p: Partial<AccountProfile>): AccountProfile =>
    ({ id: 'a', provider: 'claude', label: 'A', ...p }) as AccountProfile;

  it('always names every config-dir variable, whatever the roster holds', () => {
    // Not derived from the accounts present: a value can have leaked into the
    // tmux server's global environment from a client that is long gone, and the
    // roster it came from is not something this function can see.
    expect(accountEnvKeys([])).toEqual(
      [CLAUDE_CONFIG_DIR_ENV, CODEX_HOME_ENV].sort(),
    );
  });

  it("includes an API-key account's own variable", () => {
    const keys = accountEnvKeys([
      acct({ id: 'key', provider: 'generic', extraEnv: { ANTHROPIC_API_KEY: 'x' } }),
    ]);
    expect(keys).toContain('ANTHROPIC_API_KEY');
  });

  it('drops a key that could not be an environment variable name', () => {
    const keys = accountEnvKeys([
      acct({ id: 'bad', extraEnv: { 'NOT A NAME': 'x', 'A=B': 'y' } }),
    ]);
    expect(keys).not.toContain('NOT A NAME');
    expect(keys).not.toContain('A=B');
  });

  it('is sorted and deduplicated, and never names the re-key stamp', () => {
    const keys = accountEnvKeys([
      acct({ id: 'one', extraEnv: { ZED: 'a' } }),
      acct({ id: 'two', extraEnv: { ZED: 'b' } }),
    ]);
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
    // LINEAGE_NODE_ID is set by the launcher on every session, not by an
    // account — if it ever landed in here the switch would strip the hook
    // re-key stamp out of the pane it is restarting.
    expect(keys).not.toContain('LINEAGE_NODE_ID');
  });
});

// ------------------------------------------------------------- restoreEnvFor

describe('accounts: restoreEnvFor', () => {
  const DEFAULT_DIR = '/home/me/.claude';

  it('restores into the dir the transcript was FOUND in, not the one the pin claims', () => {
    // `sourceDirFor` looks past the pin on purpose — the pin is a claim, the
    // file is a fact — and the restore path was rebuilding its environment from
    // the claim, so the CLI came back up under an account that does not hold the
    // conversation and `claude --resume` found nothing.
    expect(
      restoreEnvFor(profile('p', { configDir: '/pinned' }), '/found', DEFAULT_DIR),
    ).toEqual({ [CLAUDE_CONFIG_DIR_ENV]: '/found' });
  });

  it('is exactly envForProfile when the pin was right, so the common path is unchanged', () => {
    const p = profile('p', { configDir: '/pinned', extraEnv: { A: 'b' } });
    expect(restoreEnvFor(p, '/pinned', DEFAULT_DIR)).toEqual(
      envForProfile(p),
    );
    // A trailing separator is the one difference a hand-typed configDir makes.
    expect(restoreEnvFor(p, '/pinned/', DEFAULT_DIR)).toEqual(envForProfile(p));
  });

  it('the DEFAULT login found in the default dir still names no config dir', () => {
    // `{}` has to behave exactly as passing no environment did before accounts
    // existed; naming ~/.claude explicitly would be a new variable in the pane.
    expect(restoreEnvFor(null, DEFAULT_DIR, DEFAULT_DIR)).toEqual({});
  });

  it('the DEFAULT login found somewhere ELSE names that directory', () => {
    expect(restoreEnvFor(null, '/profiles/personal', DEFAULT_DIR)).toEqual({
      [CLAUDE_CONFIG_DIR_ENV]: '/profiles/personal',
    });
  });

  it('keeps extraEnv and lets the found directory win over the profile\'s own', () => {
    const p = profile('p', {
      configDir: '/pinned',
      extraEnv: { ANTHROPIC_API_KEY: 'x' },
    });
    expect(restoreEnvFor(p, '/found', DEFAULT_DIR)).toEqual({
      ANTHROPIC_API_KEY: 'x',
      [CLAUDE_CONFIG_DIR_ENV]: '/found',
    });
  });

  it('a missing found dir falls back to the profile rather than blanking it', () => {
    const p = profile('p', { configDir: '/pinned' });
    expect(restoreEnvFor(p, '', DEFAULT_DIR)).toEqual(envForProfile(p));
  });
});

// --------------------------------------------------------- switchMovesNothing

describe('accounts: switchMovesNothing', () => {
  const DEFAULT_DIR = '/home/me/.claude';

  it('the seeded roster really can offer a move that moves nothing', () => {
    // The equality this whole short-circuit rests on, pinned so it cannot drift:
    // the default login and the seeded claude profile resolve to one directory,
    // and `switchTargets` will offer the second to a session on the first.
    const seeded = profile('claude-default');
    expect(configDirForProfile(null, DEFAULT_DIR)).toBe(
      configDirForProfile(seeded, DEFAULT_DIR),
    );
    expect(
      switchMovesNothing({
        fromDir: DEFAULT_DIR,
        toDir: DEFAULT_DIR,
        from: null,
        to: seeded,
      }),
    ).toBe(true);
  });

  it('two different directories always move something', () => {
    expect(
      switchMovesNothing({
        fromDir: '/a',
        toDir: '/b',
        from: profile('a', { configDir: '/a' }),
        to: profile('b', { configDir: '/b' }),
      }),
    ).toBe(false);
  });

  it('the DIRECTORIES are not enough: an extraEnv difference still needs the restart', () => {
    // An API-key account shares a config directory and authenticates
    // differently, and the environment is read once at exec — so the process has
    // to be restarted even though not one byte moves.
    expect(
      switchMovesNothing({
        fromDir: DEFAULT_DIR,
        toDir: DEFAULT_DIR,
        from: profile('plain'),
        to: profile('bykey', { extraEnv: { ANTHROPIC_API_KEY: 'x' } }),
      }),
    ).toBe(false);
    // …and in the other direction, where the variable has to be REMOVED.
    expect(
      switchMovesNothing({
        fromDir: DEFAULT_DIR,
        toDir: DEFAULT_DIR,
        from: profile('bykey', { extraEnv: { ANTHROPIC_API_KEY: 'x' } }),
        to: profile('plain'),
      }),
    ).toBe(false);
  });

  it('the same extraEnv either side is still a re-pin', () => {
    expect(
      switchMovesNothing({
        fromDir: '/shared',
        toDir: '/shared',
        from: profile('a', { configDir: '/shared', extraEnv: { A: 'b' } }),
        to: profile('b', { configDir: '/shared', extraEnv: { A: 'b' } }),
      }),
    ).toBe(true);
  });

  it('an empty directory is never a match — an unknown source moves something', () => {
    expect(
      switchMovesNothing({ fromDir: '', toDir: '', from: null, to: null }),
    ).toBe(false);
  });
});
