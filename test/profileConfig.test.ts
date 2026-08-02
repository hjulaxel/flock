// test/profileConfig.test.ts — the M22.2 shared-config wiring (src/profileConfig.ts).
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
