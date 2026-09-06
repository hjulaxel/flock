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
// And one mechanism that is deliberately NOT additive, run only by hand:
//
//   3. RESEEDING (`reseedProfileConfig`, behind the account row's "Refresh
//      Account Config from Default Login…"). Seeding copies `mcpServers` — and
//      MCP server definitions carry `env` blocks, which is where MCP API keys
//      live — once, into every profile, and then never looks again. A key
//      rotated or a server deleted in `~/.claude.json` therefore lives on in N
//      profile directories until somebody notices. The reseed writes the SAME
//      allowlisted keys over again, overwriting this time, from the default
//      identity file only. The allowlists are the whole contract: never
//      `oauthAccount`, never `.credentials.json`, never a symlinked item, never
//      a key outside ROOT_SEED_KEYS / PROJECT_SEED_KEYS. `planReseed` is the
//      read-only half, so the dialog can name what is about to be written.
//
//   4. RETRACTING (`retractIdentitySeed`). All of the above is the CLAUDE
//      CLI's layout. Through 0.4.0 account creation ran it for every new
//      directory, Codex homes included, so a CODEX_HOME received a seeded
//      `.claude.json` — mcpServers and their env keys — that no program ever
//      read. Activation now removes such a file, but only when it is purely
//      seeding's product (`isSeedOnlyIdentity`); a file the CLI or the user has
//      touched is evidence the directory is a Claude config dir after all.
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
 *  session loses its tools — and it is also the one key here that carries
 *  SECRETS, since a server definition's `env` is where its API key goes. The
 *  add-account dialog says so, and `reseedProfileConfig` is how a copy is
 *  brought up to date; `theme` is cosmetic continuity. */
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

/** A JSON deep clone, or undefined for a value that cannot make the trip — an
 *  unserialisable value has no business being copied into another file. */
function cloneValue(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return undefined;
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
    const copy = cloneValue(value);
    if (copy === undefined) continue;
    into[key] = copy;
    changed = true;
  }
  return changed;
}

/**
 * Copy `keys` from `from` into `into`, OVERWRITING whatever `into` had for
 * them. Returns the keys written, in allowlist order.
 *
 * `seedKeys`'s deliberate opposite on exactly one point, and its twin on every
 * other: only the listed keys move, values are clones, and a key the source
 * has no value for is left as it is — "refresh from the default" means the
 * default's answers replace the profile's, not that the profile is emptied of
 * answers the default never gave. A whole `mcpServers` object is one key, so
 * a server deleted from the default is gone from the profile after this, and
 * a rotated `env` value arrives with the definition it belongs to.
 */
export function reseedKeys(
  into: Record<string, unknown>,
  from: Record<string, unknown>,
  keys: readonly string[],
): string[] {
  const written: string[] = [];
  for (const key of keys) {
    const value = from[key];
    if (value === undefined) continue;
    const copy = cloneValue(value);
    if (copy === undefined) continue;
    into[key] = copy;
    written.push(key);
  }
  return written;
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

// ------------------------------------------------------------- 3. reseeding

/** What a refresh would write into one profile — the dialog's material. Read
 *  from disk, nothing written. */
export interface ReseedPlan {
  /** The file that will be rewritten: `<profileDir>/.claude.json`. */
  identityPath: string;
  /** The allowlisted root keys the default identity file has a value for.
   *  Every one of them is written over; a key the default lacks is not here
   *  and is not touched. */
  rootKeys: string[];
  /** The `mcpServers` entries the profile will hold afterwards — the default's
   *  list, definitions and `env` included. Empty when the default has no
   *  `mcpServers` key, in which case the profile's entries stay. */
  mcpServers: string[];
  /** The profile's own `mcpServers` entries the default no longer has. They are
   *  gone after the refresh — the deleted-key case this exists for. */
  droppedMcpServers: string[];
  /** Project entries whose allowlisted keys (trust flags, tool lists, the
   *  per-project `mcpServers`) will be written over. */
  projectCount: number;
}

export interface ReseedResult {
  ok: boolean;
  /** What was written, when `ok`. */
  plan?: ReseedPlan;
  /** Why nothing was, when not. Human-readable, safe to show. */
  error?: string;
}

interface ReseedInputs {
  identityPath: string;
  identity: Record<string, unknown>;
  source: Record<string, unknown>;
}

/** The two files a reseed reads, or the sentence that says why it cannot. The
 *  refusals mirror `ensureProfileConfig`'s: an empty or default directory, or a
 *  profile whose identity file IS the source. */
async function readReseedInputs(
  profileDir: string,
  sources: ProfileConfigSources,
): Promise<ReseedInputs | string> {
  const dir = typeof profileDir === 'string' ? profileDir.trim() : '';
  const srcDir = typeof sources?.defaultDir === 'string' ? sources.defaultDir.trim() : '';
  const srcFile =
    typeof sources?.defaultIdentityFile === 'string' ? sources.defaultIdentityFile.trim() : '';
  if (dir === '' || srcDir === '' || srcFile === '') {
    return 'this account has no config directory of its own to refresh.';
  }
  if (path.resolve(dir) === path.resolve(srcDir)) {
    return 'this is the default login — it is what the other accounts are refreshed from.';
  }
  const identityPath = path.join(dir, IDENTITY_FILE);
  if (path.resolve(srcFile) === path.resolve(identityPath)) {
    return 'this account reads the default identity file itself; there is nothing to copy.';
  }
  const source = await readJsonOrNull(srcFile);
  if (source === null) {
    return `the default login has no readable identity file at ${srcFile}.`;
  }
  const identity = (await readJsonOrNull(identityPath)) ?? {};
  return { identityPath, identity, source };
}

function planFrom(inputs: ReseedInputs): ReseedPlan {
  const { identityPath, identity, source } = inputs;
  const rootKeys = ROOT_SEED_KEYS.filter((key) => source[key] !== undefined);

  const sourceServers = source['mcpServers'];
  const ownServers = identity['mcpServers'];
  const mcpServers = isPlainObject(sourceServers) ? Object.keys(sourceServers) : [];
  const droppedMcpServers =
    isPlainObject(sourceServers) && isPlainObject(ownServers)
      ? Object.keys(ownServers).filter((name) => !(name in sourceServers))
      : [];

  let projectCount = 0;
  const sourceProjects = source['projects'];
  if (isPlainObject(sourceProjects)) {
    for (const entry of Object.values(sourceProjects)) {
      if (!isPlainObject(entry)) continue;
      if (PROJECT_SEED_KEYS.some((key) => entry[key] !== undefined)) projectCount += 1;
    }
  }

  return { identityPath, rootKeys, mcpServers, droppedMcpServers, projectCount };
}

/**
 * What `reseedProfileConfig` would write, without writing it — or null when it
 * would refuse (no directory of its own, the default login itself, no source
 * to read). The dialog in front of the refresh is built from this, so what the
 * user is told is computed from the same two files the write will read.
 */
export async function planReseed(
  profileDir: string,
  sources: ProfileConfigSources,
): Promise<ReseedPlan | null> {
  try {
    const inputs = await readReseedInputs(profileDir, sources);
    return typeof inputs === 'string' ? null : planFrom(inputs);
  } catch (err) {
    logError('profileConfig: reseed plan failed', err);
    return null;
  }
}

/**
 * Write the allowlisted keys from the default identity file into
 * `<profileDir>/.claude.json` again, OVERWRITING the profile's copies.
 *
 * Only ever from `sources.defaultIdentityFile` — the switch's second source
 * (`alsoSeedFrom`) is a source of one directory's trust answer, not of a
 * refresh. Only ever the two allowlists, through `reseedKeys`: the login, the
 * caches, the counters, `.credentials.json` and the symlinked items are not
 * read and not written. A profile with no identity file yet gets one, which
 * is what seeding would have given it. Never throws.
 */
export async function reseedProfileConfig(
  profileDir: string,
  sources: ProfileConfigSources,
): Promise<ReseedResult> {
  try {
    const inputs = await readReseedInputs(profileDir, sources);
    if (typeof inputs === 'string') return { ok: false, error: inputs };
    const { identityPath, identity, source } = inputs;
    const plan = planFrom(inputs);

    reseedKeys(identity, source, ROOT_SEED_KEYS);

    const sourceProjects = source['projects'];
    if (isPlainObject(sourceProjects)) {
      const existing = identity['projects'];
      const projects: Record<string, unknown> = isPlainObject(existing) ? existing : {};
      let touched = false;
      for (const [projectPath, entry] of Object.entries(sourceProjects)) {
        if (!isPlainObject(entry)) continue;
        const current = projects[projectPath];
        const target: Record<string, unknown> = isPlainObject(current) ? current : {};
        if (reseedKeys(target, entry, PROJECT_SEED_KEYS).length > 0) {
          projects[projectPath] = target;
          touched = true;
        }
      }
      // As in seeding: attached only when something landed in it.
      if (touched && !isPlainObject(existing)) identity['projects'] = projects;
    }

    await fsp.writeFile(identityPath, JSON.stringify(identity, null, 2) + '\n', 'utf-8');
    log(
      'profileConfig: reseeded',
      identityPath,
      'root:',
      plan.rootKeys.join(',') || '(none)',
      'projects:',
      plan.projectCount,
    );
    return { ok: true, plan };
  } catch (err) {
    logError('profileConfig: reseed failed', err);
    return { ok: false, error: 'the identity file could not be rewritten — see the Flock log.' };
  }
}

// ------------------------------------------------------------ retraction

/**
 * Pure. Is this identity file NOTHING BUT what seeding wrote? True when every
 * top-level key is one of ROOT_SEED_KEYS or `projects`, and every project entry
 * holds only PROJECT_SEED_KEYS. `oauthAccount`, `numStartups`, a cache, a key
 * added by hand — any of those means the CLI or the user has been here, and
 * the file is theirs to keep.
 */
export function isSeedOnlyIdentity(root: unknown): boolean {
  if (!isPlainObject(root)) return false;
  for (const [key, value] of Object.entries(root)) {
    if (key === 'projects') {
      if (!isPlainObject(value)) return false;
      for (const entry of Object.values(value)) {
        if (!isPlainObject(entry)) return false;
        if (!Object.keys(entry).every((k) => PROJECT_SEED_KEYS.includes(k))) {
          return false;
        }
      }
      continue;
    }
    if (!ROOT_SEED_KEYS.includes(key)) return false;
  }
  return true;
}

/**
 * Remove a `.claude.json` that seeding put where no Claude CLI will read it.
 *
 * Through 0.4.0 `createProfileDir` wired EVERY new account's directory the
 * Claude way, so a Codex account's CODEX_HOME received an identity file
 * carrying the default login's `mcpServers` — env keys included — that Codex
 * never opens: a copy of secrets with no reader. The file is removed only when
 * `isSeedOnlyIdentity` says it is purely seeding's product; a symlink, a file
 * that does not parse, or one carrying anything else is left exactly where it
 * is. Returns whether a file was removed. Never throws.
 */
export async function retractIdentitySeed(profileDir: string): Promise<boolean> {
  const dir = typeof profileDir === 'string' ? profileDir.trim() : '';
  if (dir === '') return false;
  const identityPath = path.join(dir, IDENTITY_FILE);
  try {
    const stats = await lstatOrNull(identityPath);
    if (stats === null || !stats.isFile()) return false;
    const root = await readJsonOrNull(identityPath);
    if (root === null || !isSeedOnlyIdentity(root)) return false;
    await fsp.unlink(identityPath);
    log('profileConfig: removed a seed-only identity file', identityPath);
    return true;
  } catch (err) {
    logError('profileConfig: retract failed', err);
    return false;
  }
}
