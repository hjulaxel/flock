// test/profileConfig.test.ts — the shared-config wiring (src/profileConfig.ts).
//
// The contract under test: a profile shares the machine's configuration and
// isolates only the login. Concretely — shareable items become symlinks, never
// overwriting anything the profile already has; the identity file gains ONLY
// the allowlisted keys, never `oauthAccount`, never anything already present.
// All on real temp dirs: symlinks and lstat semantics are the mechanism, and a
// mocked fs would be testing the mock.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  PROJECT_SEED_KEYS,
  ROOT_SEED_KEYS,
  SHARED_PROFILE_ITEMS,
  ensureProfileConfig,
  isSeedOnlyIdentity,
  planReseed,
  reseedKeys,
  reseedProfileConfig,
  retractIdentitySeed,
} from '../src/profileConfig';
import type { ProfileConfigSources } from '../src/profileConfig';

let root: string;
let defaultDir: string;
let identityFile: string;
let profileDir: string;

const sources = (): ProfileConfigSources => ({
  defaultDir,
  defaultIdentityFile: identityFile,
});

const readIdentity = (): Record<string, unknown> =>
  JSON.parse(
    fs.readFileSync(path.join(profileDir, '.claude.json'), 'utf-8'),
  ) as Record<string, unknown>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-profcfg-'));
  defaultDir = path.join(root, '.claude');
  identityFile = path.join(root, '.claude.json');
  profileDir = path.join(root, '.lineage', 'profiles', 'personal');
  fs.mkdirSync(defaultDir, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('profileConfig: symlinks', () => {
  it('links every shareable item that exists at the source, and only those', async () => {
    fs.writeFileSync(path.join(defaultDir, 'settings.json'), '{"model":"opus"}\n');
    fs.writeFileSync(path.join(defaultDir, 'CLAUDE.md'), '# global\n');
    fs.mkdirSync(path.join(defaultDir, 'skills'));

    const result = await ensureProfileConfig(profileDir, sources());
    expect(result.linked.sort()).toEqual(['CLAUDE.md', 'settings.json', 'skills']);

    const link = path.join(profileDir, 'settings.json');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe(path.join(defaultDir, 'settings.json'));
    // Reading THROUGH the link reaches the one shared file.
    expect(fs.readFileSync(link, 'utf-8')).toContain('opus');
    // Items with no source were not invented.
    expect(fs.existsSync(path.join(profileDir, 'plugins'))).toBe(false);
  });

  it('never touches an item the profile already has — diverged stays diverged', async () => {
    fs.writeFileSync(path.join(defaultDir, 'settings.json'), '{"shared":true}\n');
    fs.writeFileSync(path.join(profileDir, 'settings.json'), '{"mine":true}\n');

    const result = await ensureProfileConfig(profileDir, sources());
    expect(result.linked).toEqual([]);
    expect(fs.lstatSync(path.join(profileDir, 'settings.json')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(profileDir, 'settings.json'), 'utf-8')).toContain('mine');
  });

  it('is idempotent: the second run links nothing and seeds nothing', async () => {
    fs.writeFileSync(path.join(defaultDir, 'settings.json'), '{}\n');
    fs.writeFileSync(identityFile, JSON.stringify({ hasCompletedOnboarding: true }));
    const first = await ensureProfileConfig(profileDir, sources());
    expect(first.linked).toEqual(['settings.json']);
    expect(first.seeded).toBe(true);
    const second = await ensureProfileConfig(profileDir, sources());
    expect(second.linked).toEqual([]);
    expect(second.seeded).toBe(false);
  });

  it('refuses to wire a dir to itself', async () => {
    const result = await ensureProfileConfig(defaultDir, sources());
    expect(result.linked).toEqual([]);
    expect(result.seeded).toBe(false);
  });
});

describe('profileConfig: identity seeding', () => {
  const sourceIdentity = (): Record<string, unknown> => ({
    oauthAccount: { emailAddress: 'axel@magmamath.com' },
    hasCompletedOnboarding: true,
    theme: 'dark',
    mcpServers: { magma: { command: 'magma-mcp' } },
    numStartups: 412, // NOT allowlisted — must never travel
    projects: {
      '/Users/x/repo': {
        hasTrustDialogAccepted: true,
        allowedTools: ['Bash'],
        lastCost: 1.23, // NOT allowlisted — must never travel
      },
    },
  });

  it('copies allowlisted keys and trust, never oauthAccount, never junk', async () => {
    fs.writeFileSync(identityFile, JSON.stringify(sourceIdentity()));
    const result = await ensureProfileConfig(profileDir, sources());
    expect(result.seeded).toBe(true);

    const seeded = readIdentity();
    expect(seeded['hasCompletedOnboarding']).toBe(true);
    expect(seeded['theme']).toBe('dark');
    expect(seeded['mcpServers']).toEqual({ magma: { command: 'magma-mcp' } });
    expect(seeded['oauthAccount']).toBeUndefined();
    expect(seeded['numStartups']).toBeUndefined();

    const project = (seeded['projects'] as Record<string, unknown>)['/Users/x/repo'] as
      | Record<string, unknown>
      | undefined;
    expect(project?.['hasTrustDialogAccepted']).toBe(true);
    expect(project?.['allowedTools']).toEqual(['Bash']);
    expect(project?.['lastCost']).toBeUndefined();
  });

  it("never overwrites the profile's own values — additive means additive", async () => {
    fs.writeFileSync(identityFile, JSON.stringify(sourceIdentity()));
    fs.writeFileSync(
      path.join(profileDir, '.claude.json'),
      JSON.stringify({
        oauthAccount: { emailAddress: 'axel.hagerud@gmail.com' },
        theme: 'light',
        projects: { '/Users/x/repo': { hasTrustDialogAccepted: false } },
      }),
    );

    await ensureProfileConfig(profileDir, sources());
    const seeded = readIdentity();
    // The profile's login and choices survive untouched…
    expect(seeded['oauthAccount']).toEqual({ emailAddress: 'axel.hagerud@gmail.com' });
    expect(seeded['theme']).toBe('light');
    const project = (seeded['projects'] as Record<string, unknown>)['/Users/x/repo'] as
      | Record<string, unknown>
      | undefined;
    expect(project?.['hasTrustDialogAccepted']).toBe(false);
    // …while missing keys still arrive.
    expect(seeded['hasCompletedOnboarding']).toBe(true);
    expect(project?.['allowedTools']).toEqual(['Bash']);
  });

  it('seeded values are CLONES — mutating the source later cannot reach the profile', async () => {
    fs.writeFileSync(identityFile, JSON.stringify(sourceIdentity()));
    await ensureProfileConfig(profileDir, sources());
    const before = readIdentity();
    fs.writeFileSync(identityFile, JSON.stringify({ mcpServers: { evil: {} } }));
    expect(readIdentity()).toEqual(before);
  });

  it('a missing source identity file only skips seeding — links still happen', async () => {
    fs.writeFileSync(path.join(defaultDir, 'CLAUDE.md'), '# g\n');
    const result = await ensureProfileConfig(profileDir, sources());
    expect(result.linked).toEqual(['CLAUDE.md']);
    expect(result.seeded).toBe(false);
    expect(fs.existsSync(path.join(profileDir, '.claude.json'))).toBe(false);
  });
});

describe('profileConfig: seeding from the account being LEFT', () => {
  // The account switch's half of this module. The seeding exists so that a
  // conversation resumed on another account does not meet a trust dialog for
  // the directory it was already running in — and with only ~/.claude.json as
  // a source it did not do that for the move that most needs it: A → B, where
  // the folder was only ever trusted under A.
  const accountA = (): string => {
    const dir = path.join(root, '.lineage', 'profiles', 'work');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, '.claude.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        oauthAccount: { emailAddress: 'work@example.com' },
        projects: {
          '/Users/x/only-a-knows-this': {
            hasTrustDialogAccepted: true,
            allowedTools: ['Bash'],
          },
        },
      }),
    );
    return file;
  };

  it("carries the source account's answer for a folder the machine default never saw", async () => {
    fs.writeFileSync(identityFile, JSON.stringify({ theme: 'dark' }));
    const result = await ensureProfileConfig(profileDir, {
      ...sources(),
      alsoSeedFrom: accountA(),
    });
    expect(result.seeded).toBe(true);

    const seeded = readIdentity();
    // From the machine default…
    expect(seeded['theme']).toBe('dark');
    // …and from the account the conversation is leaving.
    const project = (seeded['projects'] as Record<string, unknown>)[
      '/Users/x/only-a-knows-this'
    ] as Record<string, unknown> | undefined;
    expect(project?.['hasTrustDialogAccepted']).toBe(true);
    expect(project?.['allowedTools']).toEqual(['Bash']);
    // The second source is a source of ANSWERS, not of identity: an account's
    // own login must never be seeded into another account's file.
    expect(seeded['oauthAccount']).toBeUndefined();
  });

  it('is second, so the machine default still wins every key it answers', async () => {
    fs.writeFileSync(
      identityFile,
      JSON.stringify({
        theme: 'dark',
        projects: { '/Users/x/repo': { hasTrustDialogAccepted: false } },
      }),
    );
    const dir = path.join(root, '.lineage', 'profiles', 'work');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, '.claude.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        theme: 'light',
        projects: { '/Users/x/repo': { hasTrustDialogAccepted: true } },
      }),
    );

    await ensureProfileConfig(profileDir, { ...sources(), alsoSeedFrom: file });
    const seeded = readIdentity();
    expect(seeded['theme']).toBe('dark');
    const project = (seeded['projects'] as Record<string, unknown>)['/Users/x/repo'] as
      | Record<string, unknown>
      | undefined;
    expect(project?.['hasTrustDialogAccepted']).toBe(false);
  });

  it('treats a missing or unreadable second source as simply not a source', async () => {
    fs.writeFileSync(identityFile, JSON.stringify({ theme: 'dark' }));
    const result = await ensureProfileConfig(profileDir, {
      ...sources(),
      alsoSeedFrom: path.join(root, 'nowhere', '.claude.json'),
    });
    expect(result.seeded).toBe(true);
    expect(readIdentity()['theme']).toBe('dark');
  });

  it('does not seed a profile from its own identity file', async () => {
    // The switch passes `<fromDir>/.claude.json`, and a move whose two ends
    // resolve to the same directory would otherwise read the file it is about
    // to write.
    fs.writeFileSync(path.join(profileDir, '.claude.json'), JSON.stringify({ theme: 'light' }));
    const result = await ensureProfileConfig(profileDir, {
      ...sources(),
      alsoSeedFrom: path.join(profileDir, '.claude.json'),
    });
    expect(result.seeded).toBe(false);
    expect(readIdentity()).toEqual({ theme: 'light' });
  });
});

describe('profileConfig: reseedKeys — the overwriting twin of seeding', () => {
  it('overwrites the listed keys, returns them, and leaves the rest alone', () => {
    const into: Record<string, unknown> = {
      theme: 'light',
      mcpServers: { stale: { env: { KEY: 'old' } } },
      oauthAccount: { emailAddress: 'mine@example.com' },
      numStartups: 7,
    };
    const from: Record<string, unknown> = {
      theme: 'dark',
      mcpServers: { fresh: { env: { KEY: 'new' } } },
      oauthAccount: { emailAddress: 'theirs@example.com' },
      numStartups: 999,
    };
    const written = reseedKeys(into, from, ROOT_SEED_KEYS);
    expect(written).toEqual(['mcpServers', 'theme']);
    expect(into['theme']).toBe('dark');
    // The whole object is one key: the stale server is GONE, not merged over.
    expect(into['mcpServers']).toEqual({ fresh: { env: { KEY: 'new' } } });
    expect(into['oauthAccount']).toEqual({ emailAddress: 'mine@example.com' });
    expect(into['numStartups']).toBe(7);
  });

  it('leaves a key the source has no value for — a refresh is not an erasure', () => {
    const into: Record<string, unknown> = { theme: 'light', hasCompletedOnboarding: true };
    const written = reseedKeys(into, { mcpServers: {} }, ROOT_SEED_KEYS);
    expect(written).toEqual(['mcpServers']);
    expect(into['theme']).toBe('light');
    expect(into['hasCompletedOnboarding']).toBe(true);
  });

  it('writes clones, never the source object itself', () => {
    const servers = { a: { env: { KEY: 'x' } } };
    const into: Record<string, unknown> = {};
    reseedKeys(into, { mcpServers: servers }, ROOT_SEED_KEYS);
    servers.a.env.KEY = 'mutated';
    expect((into['mcpServers'] as typeof servers).a.env.KEY).toBe('x');
  });
});

describe('profileConfig: reseeding a profile from the default login', () => {
  // The case the verb exists for: a profile seeded months ago holds an MCP
  // server whose key has since been rotated on the default login, and a
  // second server that the default no longer has at all. Seeding
  // (`ensureProfileConfig`) is additive and will never fix either.
  const staleProfile = (): Record<string, unknown> => ({
    oauthAccount: { emailAddress: 'work@example.com' },
    theme: 'light',
    mcpServers: {
      magma: { command: 'magma-mcp', env: { MAGMA_KEY: 'rotated-away' } },
      retired: { command: 'old-mcp', env: { OLD_KEY: 'should-not-survive' } },
    },
    numStartups: 41,
    projects: {
      '/Users/x/repo': {
        hasTrustDialogAccepted: false,
        allowedTools: [],
        lastCost: 9.99,
      },
    },
  });
  const freshDefault = (): Record<string, unknown> => ({
    oauthAccount: { emailAddress: 'axel@magmamath.com' },
    hasCompletedOnboarding: true,
    theme: 'dark',
    mcpServers: {
      magma: { command: 'magma-mcp', env: { MAGMA_KEY: 'current' } },
    },
    numStartups: 412,
    projects: {
      '/Users/x/repo': {
        hasTrustDialogAccepted: true,
        allowedTools: ['Bash'],
        lastCost: 1.23,
      },
    },
  });

  it('seeding alone leaves the rotated and the deleted key in place — the gap this closes', async () => {
    fs.writeFileSync(identityFile, JSON.stringify(freshDefault()));
    fs.writeFileSync(path.join(profileDir, '.claude.json'), JSON.stringify(staleProfile()));
    await ensureProfileConfig(profileDir, sources());
    const servers = readIdentity()['mcpServers'] as Record<string, { env: Record<string, string> }>;
    expect(servers['magma']?.env['MAGMA_KEY']).toBe('rotated-away');
    expect(servers['retired']).toBeDefined();
  });

  it('overwrites the allowlisted keys, drops the deleted server, and touches nothing else', async () => {
    fs.writeFileSync(identityFile, JSON.stringify(freshDefault()));
    fs.writeFileSync(path.join(profileDir, '.claude.json'), JSON.stringify(staleProfile()));
    const credentials = path.join(profileDir, '.credentials.json');
    fs.writeFileSync(credentials, '{"claudeAiOauth":{"accessToken":"secret"}}\n');

    const result = await reseedProfileConfig(profileDir, sources());
    expect(result.ok).toBe(true);
    expect(result.plan?.rootKeys).toEqual(['hasCompletedOnboarding', 'mcpServers', 'theme']);
    expect(result.plan?.mcpServers).toEqual(['magma']);
    expect(result.plan?.droppedMcpServers).toEqual(['retired']);
    expect(result.plan?.projectCount).toBe(1);

    const after = readIdentity();
    // The rotated key arrives, the deleted server goes.
    expect(after['mcpServers']).toEqual({
      magma: { command: 'magma-mcp', env: { MAGMA_KEY: 'current' } },
    });
    expect(after['theme']).toBe('dark');
    expect(after['hasCompletedOnboarding']).toBe(true);
    // The login and the junk are the profile's own, before and after.
    expect(after['oauthAccount']).toEqual({ emailAddress: 'work@example.com' });
    expect(after['numStartups']).toBe(41);
    // Per project: the allowlisted keys refresh, the rest stays.
    const project = (after['projects'] as Record<string, unknown>)['/Users/x/repo'] as Record<
      string,
      unknown
    >;
    expect(project['hasTrustDialogAccepted']).toBe(true);
    expect(project['allowedTools']).toEqual(['Bash']);
    expect(project['lastCost']).toBe(9.99);
    // The credentials file is not a party to any of this.
    expect(fs.readFileSync(credentials, 'utf-8')).toBe(
      '{"claudeAiOauth":{"accessToken":"secret"}}\n',
    );
  });

  it('leaves a key the default has no value for', async () => {
    fs.writeFileSync(identityFile, JSON.stringify({ mcpServers: {} }));
    fs.writeFileSync(
      path.join(profileDir, '.claude.json'),
      JSON.stringify({ theme: 'light', mcpServers: { retired: {} } }),
    );
    const result = await reseedProfileConfig(profileDir, sources());
    expect(result.ok).toBe(true);
    const after = readIdentity();
    expect(after['theme']).toBe('light');
    expect(after['mcpServers']).toEqual({});
  });

  it('refuses the default directory itself, and a missing source', async () => {
    fs.writeFileSync(identityFile, JSON.stringify(freshDefault()));
    const self = await reseedProfileConfig(defaultDir, sources());
    expect(self.ok).toBe(false);
    expect(self.error).toContain('default login');

    fs.rmSync(identityFile);
    fs.writeFileSync(path.join(profileDir, '.claude.json'), JSON.stringify(staleProfile()));
    const orphan = await reseedProfileConfig(profileDir, sources());
    expect(orphan.ok).toBe(false);
    expect(readIdentity()).toEqual(staleProfile());
  });

  it('refuses an empty directory — an account with no directory of its own is the source, not a target', async () => {
    fs.writeFileSync(identityFile, JSON.stringify(freshDefault()));
    const result = await reseedProfileConfig('', sources());
    expect(result.ok).toBe(false);
    expect(await planReseed('', sources())).toBeNull();
  });

  it('planReseed names what the write will do, and writes nothing', async () => {
    fs.writeFileSync(identityFile, JSON.stringify(freshDefault()));
    fs.writeFileSync(path.join(profileDir, '.claude.json'), JSON.stringify(staleProfile()));
    const plan = await planReseed(profileDir, sources());
    expect(plan).toEqual({
      identityPath: path.join(profileDir, '.claude.json'),
      rootKeys: ['hasCompletedOnboarding', 'mcpServers', 'theme'],
      mcpServers: ['magma'],
      droppedMcpServers: ['retired'],
      projectCount: 1,
    });
    expect(readIdentity()).toEqual(staleProfile());
    expect(await planReseed(profileDir, { ...sources(), defaultIdentityFile: '/nowhere' })).toBeNull();
  });
});

describe('profileConfig: the allowlists themselves', () => {
  it('the one key the whole design forbids is on NO list', () => {
    expect(ROOT_SEED_KEYS).not.toContain('oauthAccount');
    expect(PROJECT_SEED_KEYS).not.toContain('oauthAccount');
    expect(SHARED_PROFILE_ITEMS).not.toContain('.claude.json');
    expect(SHARED_PROFILE_ITEMS).not.toContain('.credentials.json');
    expect(SHARED_PROFILE_ITEMS).not.toContain('projects');
  });

  it('the trust flag the user actually feels is present', () => {
    expect(PROJECT_SEED_KEYS).toContain('hasTrustDialogAccepted');
    expect(ROOT_SEED_KEYS).toContain('hasCompletedOnboarding');
  });
});

describe('retracting a seed that landed where no Claude CLI reads it', () => {
  // Through 0.4.0 every new account directory was wired the Claude way, so a
  // Codex account's CODEX_HOME received a `.claude.json` seeded with the
  // default login's mcpServers — env keys included — that Codex never opens.
  const seeded = (): Record<string, unknown> => ({
    hasCompletedOnboarding: true,
    theme: 'dark',
    mcpServers: { db: { command: 'db-mcp', env: { DB_TOKEN: 'secret' } } },
    projects: {
      '/code/api': { hasTrustDialogAccepted: true, allowedTools: ['Bash'] },
    },
  });

  it('isSeedOnlyIdentity: true for exactly what seeding writes, root and per project', () => {
    expect(isSeedOnlyIdentity(seeded())).toBe(true);
    expect(isSeedOnlyIdentity({})).toBe(true);
    expect(isSeedOnlyIdentity({ mcpServers: {} })).toBe(true);
  });

  it('isSeedOnlyIdentity: false the moment the CLI or the user has been there', () => {
    // The login itself — the one key the whole feature exists to keep apart.
    expect(isSeedOnlyIdentity({ ...seeded(), oauthAccount: { id: 'x' } })).toBe(false);
    // A counter the CLI bumps on every start.
    expect(isSeedOnlyIdentity({ ...seeded(), numStartups: 3 })).toBe(false);
    // A project key seeding never writes.
    expect(
      isSeedOnlyIdentity({
        projects: { '/code/api': { hasTrustDialogAccepted: true, lastCost: 0.2 } },
      }),
    ).toBe(false);
    // Not an object at all.
    expect(isSeedOnlyIdentity(null)).toBe(false);
    expect(isSeedOnlyIdentity([])).toBe(false);
    expect(isSeedOnlyIdentity({ projects: [] })).toBe(false);
  });

  it('removes a seed-only identity file and reports it', async () => {
    const codexHome = path.join(root, '.lineage', 'profiles', 'openai');
    fs.mkdirSync(codexHome, { recursive: true });
    const file = path.join(codexHome, '.claude.json');
    fs.writeFileSync(file, JSON.stringify(seeded(), null, 2));

    expect(await retractIdentitySeed(codexHome)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    // Nothing else in the directory was touched.
    expect(fs.existsSync(codexHome)).toBe(true);
  });

  it('leaves a file that carries anything beyond the seed — it is somebody’s', async () => {
    const codexHome = path.join(root, '.lineage', 'profiles', 'openai');
    fs.mkdirSync(codexHome, { recursive: true });
    const file = path.join(codexHome, '.claude.json');
    const text = JSON.stringify({ ...seeded(), oauthAccount: { id: 'x' } }, null, 2);
    fs.writeFileSync(file, text);

    expect(await retractIdentitySeed(codexHome)).toBe(false);
    expect(fs.readFileSync(file, 'utf-8')).toBe(text);
  });

  it('leaves a file that does not parse, a symlink, and a directory with no file', async () => {
    const codexHome = path.join(root, '.lineage', 'profiles', 'openai');
    fs.mkdirSync(codexHome, { recursive: true });
    const file = path.join(codexHome, '.claude.json');

    expect(await retractIdentitySeed(codexHome)).toBe(false); // no file

    fs.writeFileSync(file, '{not json');
    expect(await retractIdentitySeed(codexHome)).toBe(false);
    expect(fs.existsSync(file)).toBe(true);

    fs.rmSync(file);
    fs.writeFileSync(identityFile, JSON.stringify(seeded()));
    fs.symlinkSync(identityFile, file);
    expect(await retractIdentitySeed(codexHome)).toBe(false); // a link is a choice
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);

    expect(await retractIdentitySeed('')).toBe(false);
  });

  it('is a caller decision: the seed a CLAUDE profile gets is the same bytes', async () => {
    // The function does not infer the provider — handed a Claude profile by
    // mistake it would remove its seed. extension.ts keys the call on
    // provider === 'codex' and on the directory not being any Claude one.
    fs.writeFileSync(identityFile, JSON.stringify(seeded()));
    await ensureProfileConfig(profileDir, sources());
    expect(isSeedOnlyIdentity(readIdentity())).toBe(true);
  });
});
