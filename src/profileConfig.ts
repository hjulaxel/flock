// src/profileConfig.ts — a profile shares the machine's configuration; it
// isolates only the LOGIN.
//
// Why this file exists: a profile's config dir (accounts.ts, CLAUDE_CONFIG_DIR)
// isolates credentials — that is the feature — but the CLI keeps everything
// else in the same directory, so a fresh profile also silently isolated the
// user's settings.json (permission default mode, allow rules, hooks, model),
// their global CLAUDE.md and skills, and every folder-trust answer they ever
// gave. The first session on a new account then behaved like a fresh install:
// trust dialog, manual permission mode, no instructions. Nobody asked for a
// second personality — they asked for a second login.
//
// Two mechanisms, both idempotent, both strictly ADDITIVE:
//
//   1. SYMLINKS for the shareable items (SHARED_PROFILE_ITEMS). A link means
//      there is ONE settings.json on the machine and every profile reads and
//      writes the same one — `/config` changes made inside any session land
//      everywhere, which is what "my settings" means. An item that already
//      exists in the profile dir is NEVER touched: a profile that has
//      deliberately diverged stays diverged. (If the CLI ever atomically
//      replaces a linked file, that profile quietly forks its copy from then
//      on — a regrettable but safe outcome, and re-linking would destroy the
//      fork, so we never do it.)
//
//   2. SEEDING the identity file (`<dir>/.claude.json`; for the default
//      account this is `~/.claude.json` at the home root). This file cannot be
//      linked: it holds `oauthAccount` — the login the whole feature exists to
//      separate — next to the trust map. So the shareable keys are copied,
//      allowlist-only, never overwriting anything already present:
//      ROOT_SEED_KEYS once at the top level, PROJECT_SEED_KEYS per project
//      entry. Everything outside the allowlists — oauthAccount above all, but
//      also caches, counters, history — stays where it is. Trust for a folder
//      the user never opened on the default account is still asked for; that
//      prompt is real security, not lost settings.
//
// Imports: node builtins + ./log only. NEVER vscode — extension.ts calls this
// at activation and after profile creation; tests drive it on real tmp dirs.

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { log, logError } from './log';

/** Items shared by SYMLINK, config-dir relative. Order is cosmetic. A missing
 *  source is skipped silently — not everyone has an AGENTS.md. */
export const SHARED_PROFILE_ITEMS: readonly string[] = [
  'settings.json',
  'CLAUDE.md',
  'AGENTS.md',
  'agents',
  'commands',
  'skills',
  'plugins',
  'keybindings.json',
];

/** Top-level identity-file keys a fresh profile inherits. Onboarding and the
 *  bypass acknowledgement are one-time consents the user already gave;
 *  `mcpServers` is the global server list, without which every custom-account
 *  session loses its tools; `theme` is cosmetic continuity. */
export const ROOT_SEED_KEYS: readonly string[] = [
  'hasCompletedOnboarding',
  'bypassPermissionsModeAccepted',
  'mcpServers',
  'theme',
];

/** Per-project keys a fresh profile inherits. The trust flags are the ones the
 *  user feels; the tool/MCP lists are the same consent in another spelling. */
export const PROJECT_SEED_KEYS: readonly string[] = [
  'hasTrustDialogAccepted',
  'hasCompletedProjectOnboarding',
  'hasClaudeMdExternalIncludesApproved',
  'hasClaudeMdExternalIncludesWarningShown',
  'allowedTools',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'mcpServers',
];

/** The identity file's basename, same constant limits.ts reads identity from. */
const IDENTITY_FILE = '.claude.json';

export interface ProfileConfigSources {
  /** The default config DIR (normally `~/.claude`) — symlink sources. */
  defaultDir: string;
  /** The default IDENTITY FILE (normally `~/.claude.json`, home root — NOT
   *  inside the dir above; the CLI has always kept it beside, not within). */
  defaultIdentityFile: string;
  /**
   * A SECOND identity file to seed from, read after the default and under the
   * same never-overwrite rule.
   *
   * Set by the account switch, which passes the SOURCE account's own
   * `.claude.json`. The seeding exists so that a conversation resumed on
   * another account does not meet a trust dialog for the directory it was
   * already running in, and with only `~/.claude.json` as a source it did not
   * do that for the move that most needs it: A → B, where the folder was only
   * ever trusted under A. A is the account that was running in that directory a
   * second ago, so A is the honest place to carry the answer from.
   *
   * This does not weaken what the trust prompt is for. A prompt for a folder
   * NOBODY has opened is real security and stays; what is carried here is one
   * account's already-given answer about the one directory the conversation is
   * being resumed in, which is continuity rather than a bypass.
   *
   * Optional, and a file that is missing or unreadable is simply not a source.
   */
  alsoSeedFrom?: string;
}

export interface ProfileConfigResult {
  /** Basenames linked on this run (already-present items are not in here). */
  linked: string[];
  /** Whether the identity file gained anything on this run. */
  seeded: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** lstat that treats "not there" as null and anything else as its stats.
 *  lstat, not stat: a DANGLING symlink counts as present — the user (or an
 *  earlier run) put it there, and replacing it is an overwrite. */
async function lstatOrNull(p: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fsp.lstat(p);
  } catch {
    return null;
  }
}

async function readJsonOrNull(p: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await fsp.readFile(p, 'utf-8');
    const root: unknown = JSON.parse(text);
    return isPlainObject(root) ? root : null;
  } catch {
    return null;
  }
}

/** Copy `keys` from `from` into `into` WITHOUT overwriting. Returns whether
 *  anything landed. Values are deep-cloned through JSON so the two files can
 *  never share a mutable object. */
function seedKeys(
  into: Record<string, unknown>,
  from: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  let changed = false;
  for (const key of keys) {
    if (key in into) continue;
    const value = from[key];
    if (value === undefined) continue;
    try {
      into[key] = JSON.parse(JSON.stringify(value)) as unknown;
      changed = true;
    } catch {
      /* an unserialisable value has no business being copied */
    }
  }
  return changed;
}

/**
 * Make `profileDir` share the machine's configuration. Idempotent, additive,
 * never throws — a profile that cannot be wired up simply stays a little
 * blanker than its siblings, which is how every profile looked before this
 * module existed, not a failure.
 */
export async function ensureProfileConfig(
  profileDir: string,
  sources: ProfileConfigSources,
): Promise<ProfileConfigResult> {
  const result: ProfileConfigResult = { linked: [], seeded: false };
  const dir = typeof profileDir === 'string' ? profileDir.trim() : '';
  const srcDir = typeof sources?.defaultDir === 'string' ? sources.defaultDir.trim() : '';
  if (dir === '' || srcDir === '' || path.resolve(dir) === path.resolve(srcDir)) {
    return result; // linking a dir to itself is how infinite loops are born
  }

  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (err) {
    logError('profileConfig: mkdir failed', err);
    return result;
  }

  // ---- 1. symlinks -------------------------------------------------------
  for (const item of SHARED_PROFILE_ITEMS) {
    try {
      const target = path.join(dir, item);
      if ((await lstatOrNull(target)) !== null) continue; // theirs, diverged or not
      const source = path.join(srcDir, item);
      if ((await lstatOrNull(source)) === null) continue; // nothing to share
      await fsp.symlink(source, target);
      result.linked.push(item);
    } catch (err) {
      // One item failing (permissions, exotic fs) must not cost the rest.
      logError('profileConfig: symlink failed', err);
    }
  }

  // ---- 2. identity-file seeding -----------------------------------------
  //
  // TWO SOURCES, read in order, and the order is the precedence: `seedKeys`
  // never overwrites a key that is already present, so the machine's own
  // identity file wins every key it has an answer for and the second source
  // fills in only what it left blank. See `ProfileConfigSources.alsoSeedFrom`
  // for what the second one is and why an A → B account move needs it.
  try {
    const identityPath = path.join(dir, IDENTITY_FILE);
    const identity = (await readJsonOrNull(identityPath)) ?? {};
    let changed = false;
    let sawProjects = false;

    for (const file of [sources.defaultIdentityFile, sources.alsoSeedFrom]) {
      if (typeof file !== 'string' || file.trim() === '') continue;
      // Reading the file we are about to write would seed a profile from
      // itself: harmless, and a readdir plus a parse for nothing.
      if (path.resolve(file) === path.resolve(identityPath)) continue;
      const sourceIdentity = await readJsonOrNull(file);
      if (sourceIdentity === null) continue;

      if (seedKeys(identity, sourceIdentity, ROOT_SEED_KEYS)) changed = true;

      const sourceProjects = sourceIdentity['projects'];
      if (isPlainObject(sourceProjects)) {
        const existing = identity['projects'];
        const projects: Record<string, unknown> = isPlainObject(existing) ? existing : {};
        let touched = false;
        for (const [projectPath, entry] of Object.entries(sourceProjects)) {
          if (!isPlainObject(entry)) continue;
          const current = projects[projectPath];
          const target: Record<string, unknown> = isPlainObject(current) ? current : {};
          if (seedKeys(target, entry, PROJECT_SEED_KEYS)) {
            projects[projectPath] = target;
            touched = true;
          }
        }
        if (touched) {
          changed = true;
          // Attached to the identity ONCE, and only when something landed in
          // it — writing an empty `projects` map into a profile that had none
          // would be a change with nothing in it.
          if (!isPlainObject(existing) && !sawProjects) {
            identity['projects'] = projects;
            sawProjects = true;
          }
        }
      }
    }

    if (changed) {
      await fsp.writeFile(identityPath, JSON.stringify(identity, null, 2) + '\n', 'utf-8');
      result.seeded = true;
    }
  } catch (err) {
    logError('profileConfig: identity seeding failed', err);
  }

  if (result.linked.length > 0 || result.seeded) {
    log('profileConfig: wired', dir, 'linked:', result.linked.join(',') || '(none)');
  }
  return result;
}
