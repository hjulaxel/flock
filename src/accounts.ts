// IMPLEMENTED BY: M22 — accounts.
//
// Pure. Imports ./types and NOTHING else — no vscode, no node:os, no fs — so
// every rule in here is unit-testable without a workbench and can be called
// from the command layer, the view and the launcher alike.
//
// The one idea this file encodes: AN ACCOUNT IS A CONFIG DIRECTORY. Both CLIs
// keep their OAuth token, their `settings.json` and their history under one
// root that an environment variable relocates — `CLAUDE_CONFIG_DIR` for Claude
// Code, `CODEX_HOME` for Codex. Point a launch at a different root and it is a
// different signed-in account, with no shared state whatsoever: you log in once
// per profile and never again, switching costs nothing, and two sessions on two
// accounts can run side by side in the same window. Everything else in M22 —
// routing, pinning, the usage meters — is bookkeeping on top of that one fact.
//
// The DEFAULT ACCOUNT is the profile with neither a configDir nor extraEnv. It
// resolves to an empty env and therefore inherits `~/.claude` exactly as every
// session did before this milestone existed. That is why a user who wants none
// of this pays nothing for it: their one profile is a no-op wrapper around the
// behaviour they already had.
//
// SECRETS: `extraEnv` is where an API-key account keeps its key. Nothing in
// this file logs, formats or otherwise reproduces those VALUES — the validation
// below inspects key names and value types only, and every helper that has to
// reject something says which KEY was rejected and never what was in it.

import {
  DEFAULT_PROVIDER,
  MAX_ACCOUNT_ID_LEN,
  MAX_ACCOUNT_LABEL_LEN,
  isProviderId,
} from './types';
import type { AccountProfile, ProviderId } from './types';

// ------------------------------------------------------------------- env

/** Claude Code's config root override. */
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';
/** Codex's config root override. */
export const CODEX_HOME_ENV = 'CODEX_HOME';

/**
 * Which variable carries the config directory, per provider.
 *
 * PARTIAL on purpose. Gemini and `generic` have no documented equivalent, and
 * inventing one would produce a profile that LOOKS isolated in the UI and
 * silently shares credentials in reality — the single worst outcome this
 * feature can produce. Those providers get their configDir ignored (with
 * `extraEnv` still honoured, which is the escape hatch for anyone who knows
 * their tool's own variable), and the view is expected to say so.
 */
export const CONFIG_DIR_ENV: Readonly<Partial<Record<ProviderId, string>>> = {
  claude: CLAUDE_CONFIG_DIR_ENV,
  codex: CODEX_HOME_ENV,
};

/**
 * The providers a Canopy SESSION can actually be launched on.
 *
 * PARTIAL for the same reason CONFIG_DIR_ENV is, and it is the other half of
 * the same fact: the launcher execs exactly ONE binary — the Claude CLI — so
 * an environment that relocates some OTHER tool's config root does nothing to
 * it. A launch on a Codex account would run `claude` with `CODEX_HOME` set,
 * land on the machine's default Claude login, and pin that conversation for
 * life to an account it was never on: a session that looks isolated in the UI
 * and shares credentials in reality, which is the single worst outcome this
 * feature can produce.
 *
 * `generic` is IN the list because it makes no isolation claim at all — it is
 * the API-key profile, a Claude launch authenticated by an environment
 * variable, whose configDir `envForProfile` already ignores. `codex` and
 * `gemini` are OUT until this extension launches those CLIs, which it does
 * not. Their rows still exist, still sign in from their own verb and still
 * carry their meters; they are simply not somewhere a session starts.
 */
export const SESSION_PROVIDERS: readonly ProviderId[] = ['claude', 'generic'];

/**
 * Can a session run on this account at all? See SESSION_PROVIDERS.
 *
 * Consulted by the router (which must not pick one), the launch verbs (which
 * must not offer one) and the pin path (which must not re-inject one), so that
 * the answer is the same on every surface instead of three near-misses.
 */
export function canHostSession(
  profile: AccountProfile | null | undefined,
): boolean {
  if (!profile) return false;
  const provider = isProviderId(profile.provider)
    ? profile.provider
    : DEFAULT_PROVIDER;
  return SESSION_PROVIDERS.includes(provider);
}

/** POSIX environment variable name. Enforced because these end up as `-e
 *  KEY=VALUE` arguments to the tmux wrap, where a key containing `=` or a
 *  space would silently redraw the boundary between name and value. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Is this a name a process environment can actually carry? Exported so the
 *  store validates persisted `extraEnv` keys by the SAME rule the launcher
 *  applies — a key state.json accepted but a launch silently dropped would be
 *  an account that looks configured and does not work. */
export function isEnvVarName(v: unknown): v is string {
  return typeof v === 'string' && ENV_NAME_RE.test(v);
}

/**
 * The environment one account launches under.
 *
 *   1. the provider's config-dir variable, when the profile names a directory
 *      AND the provider has one (see CONFIG_DIR_ENV);
 *   2. `extraEnv` merged OVER that.
 *
 * Order matters and is deliberate: an API-key profile that also sets a config
 * dir is saying "use this store, but authenticate with this key", and the
 * explicit variable has to win. A profile with neither resolves to `{}` — the
 * default account — and `{}` must behave in every consumer exactly as passing
 * no environment at all did before M22.
 *
 * Returns a fresh mutable object every call: callers merge it into
 * `process.env`-shaped records and into tmux argv, and handing out a shared
 * object would let one launch's mutation leak into the next.
 */
export function envForProfile(
  profile: AccountProfile | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!profile) return out;

  const dirVar = isProviderId(profile.provider)
    ? CONFIG_DIR_ENV[profile.provider]
    : undefined;
  const dir = typeof profile.configDir === 'string' ? profile.configDir.trim() : '';
  if (dirVar && dir !== '') out[dirVar] = dir;

  const extra = profile.extraEnv;
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    for (const [key, value] of Object.entries(extra)) {
      if (!isEnvVarName(key)) continue;
      if (typeof value !== 'string') continue;
      if (value.includes('\0')) continue; // never survives an execve anyway
      out[key] = value;
    }
  }
  return out;
}

/** True for a profile that resolves to an empty environment: the account that
 *  IS whatever the machine is already logged in as. Not a degenerate case —
 *  it is the profile a single-account machine has, and the one
 *  `seedDefaultProfiles` mints. */
export function isDefaultAccount(profile: AccountProfile | undefined): boolean {
  if (!profile) return false;
  const dir = typeof profile.configDir === 'string' ? profile.configDir.trim() : '';
  if (dir !== '') return false;
  const extra = profile.extraEnv;
  if (!extra || typeof extra !== 'object') return true;
  return Object.keys(extra).length === 0;
}

// ------------------------------------------------------------------ ids

/** What an id becomes when the label slugs down to nothing (a label written
 *  entirely in a script this slugger cannot transliterate). */
export const ACCOUNT_ID_FALLBACK = 'account';

/**
 * Label → id. Lowercase, ASCII, dash-separated, capped.
 *
 * Aggressive because the result is a DIRECTORY NAME under
 * `~/.lineage/profiles/`: everything outside `[a-z0-9]` collapses to a dash,
 * which disposes of separators, dots, spaces and every traversal spelling in
 * one rule rather than in a blocklist somebody has to keep complete.
 */
export function slugify(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const folded = raw
    .normalize('NFKD')
    // Strip the combining marks NFKD just split off, so "Café" slugs to "cafe"
    // rather than to "caf-".
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const dashed = folded.replace(/[^a-z0-9]+/g, '-');
  const trimmed = trimDashes(dashed);
  return trimDashes(trimmed.slice(0, MAX_ACCOUNT_ID_LEN));
}

function trimDashes(s: string): string {
  return s.replace(/^-+/, '').replace(/-+$/, '');
}

/** The shape every persisted id must have. Checked on LOAD as well as on mint:
 *  state.json is hand-editable and this id is interpolated into a path. */
export function isAccountId(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= MAX_ACCOUNT_ID_LEN &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(v)
  );
}

/**
 * A slug of `base` that no existing account is using. Collisions get `-2`,
 * `-3`, … with the root trimmed so the result still fits MAX_ACCOUNT_ID_LEN.
 *
 * Ids are permanent (see AccountProfile.id), so this runs exactly once per
 * account, at creation. Renaming the label later leaves the id alone on
 * purpose: the id names a directory full of credentials that sessions are
 * pinned to.
 */
export function uniqueAccountId(base: unknown, taken: Iterable<string>): string {
  const used = new Set<string>();
  for (const t of taken) {
    if (typeof t === 'string') used.add(t.toLowerCase());
  }
  const root = slugify(base) || ACCOUNT_ID_FALLBACK;
  if (!used.has(root)) return root;
  let candidate = root;
  for (let n = 2; n <= 9999; n++) {
    const suffix = `-${String(n)}`;
    const head =
      trimDashes(root.slice(0, MAX_ACCOUNT_ID_LEN - suffix.length)) ||
      ACCOUNT_ID_FALLBACK;
    candidate = `${head}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return candidate; // 9998 accounts named the same thing: their problem now
}

/** '' when the label is usable, else the reason it is not. Mirrors
 *  projects.validateProjectName — same shape, same call sites, same wording
 *  discipline, so the two dialogs read as one product. */
export function validateAccountLabel(
  raw: string,
  existing: readonly AccountProfile[],
  selfId?: string,
): string {
  const label = typeof raw === 'string' ? raw.trim() : '';
  if (label.length === 0) return 'Name cannot be empty.';
  if (label.length > MAX_ACCOUNT_LABEL_LEN) {
    return `Name must be ${String(MAX_ACCOUNT_LABEL_LEN)} characters or fewer (currently ${String(label.length)}).`;
  }
  const clash = (existing ?? []).some(
    (p) =>
      p &&
      p.id !== selfId &&
      typeof p.label === 'string' &&
      p.label.trim().toLowerCase() === label.toLowerCase(),
  );
  return clash ? 'An account with that name already exists.' : '';
}

// --------------------------------------------------------------- locations

/** Where profile config directories live, relative to the home directory.
 *  Under our OWN dot-directory rather than inside `~/.claude`: a second Claude
 *  config root nested in the first one invites both tools to walk it. */
export const PROFILES_DIR_SEGMENTS: readonly string[] = ['.lineage', 'profiles'];

/**
 * The DEFAULT config directory for a new profile: `~/.lineage/profiles/<id>`.
 *
 * `homeDir` is a PARAMETER rather than a `node:os` import, so this module stays
 * dependency-free and the tests can name a temp directory without touching the
 * real one. The caller (a vscode-facing module, which may import node builtins)
 * passes `os.homedir()`.
 *
 * Only a DEFAULT: the user may point a profile anywhere, and a profile with no
 * configDir at all is the default account. Returns '' when either argument is
 * unusable, which callers must read as "no suggestion", never as a path.
 *
 * Forward slashes throughout, including on Windows, matching projects.ts's
 * normalized spelling — both CLIs accept them and every comparison in this
 * codebase is done on the slash form.
 */
export function profileConfigDirFor(id: string, homeDir: string): string {
  if (!isAccountId(id)) return '';
  if (typeof homeDir !== 'string') return '';
  const home = homeDir.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (home === '') return '';
  return [home, ...PROFILES_DIR_SEGMENTS, id].join('/');
}

// ---------------------------------------------------------------- ordering

/** Non-finite orders sort last rather than poisoning the comparison — a
 *  hand-edited `"order": "first"` must not reshuffle the whole list. */
function orderOf(p: AccountProfile): number {
  const n = p?.order;
  return typeof n === 'number' && Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The canonical arrangement: `order`, then creation time, then id.
 *
 * ONE function because three consumers have to agree on it — the view draws
 * this order, the reorder verbs measure moves against it, and the auto-picker
 * uses "first in this list" as its final tiebreak. Two implementations of it
 * would disagree the first time two profiles shared an order value.
 */
export function sortProfiles(
  profiles: readonly AccountProfile[],
): AccountProfile[] {
  return (profiles ?? [])
    .filter((p): p is AccountProfile => !!p)
    .slice()
    .sort(
      (a, b) =>
        orderOf(a) - orderOf(b) ||
        cmp(a.createdAt ?? '', b.createdAt ?? '') ||
        cmp(a.id ?? '', b.id ?? ''),
    );
}

/** The order value a NEW profile should get: one past the last. */
export function nextOrder(profiles: readonly AccountProfile[]): number {
  let max = -1;
  for (const p of profiles ?? []) {
    const n = p?.order;
    if (typeof n === 'number' && Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/** One account's new position. The caller applies these with
 *  `StateStore.setAccountOrder`, one write per entry. */
export interface AccountOrder {
  id: string;
  order: number;
}

/**
 * Move an account one place up (`delta -1`) or down (`+1`) in the canonical
 * order, and report EVERY account whose order value changed.
 *
 * The whole list is renumbered 0..n-1 rather than the two neighbours being
 * swapped, because the values arriving here are whatever previous versions,
 * concurrent windows and hand edits left behind — duplicates and gaps included
 * — and a swap between two profiles that both hold `order: 0` moves nothing.
 * Renumbering makes the result independent of the input's arithmetic and
 * self-heals the list as a side effect.
 *
 * Returns [] when the move is impossible (unknown id, already at the end),
 * which the caller reads as "nothing to write" — not as an error.
 */
function moveBy(
  profiles: readonly AccountProfile[],
  id: string,
  delta: -1 | 1,
): AccountOrder[] {
  const ordered = sortProfiles(profiles);
  const from = ordered.findIndex((p) => p.id === id);
  if (from < 0) return [];
  const to = from + delta;
  if (to < 0 || to >= ordered.length) return [];

  const moved = ordered.slice();
  const [taken] = moved.splice(from, 1);
  moved.splice(to, 0, taken);

  const out: AccountOrder[] = [];
  moved.forEach((p, index) => {
    if (orderOf(p) !== index) out.push({ id: p.id, order: index });
  });
  return out;
}

export function moveUp(
  profiles: readonly AccountProfile[],
  id: string,
): AccountOrder[] {
  return moveBy(profiles, id, -1);
}

export function moveDown(
  profiles: readonly AccountProfile[],
  id: string,
): AccountOrder[] {
  return moveBy(profiles, id, 1);
}

// ----------------------------------------------------------------- seeding

/** The ids of the two profiles first run may mint. Fixed strings so a second
 *  run recognises its own work even if the user renamed the labels. */
export const DEFAULT_CLAUDE_PROFILE_ID = 'claude-default';
export const DEFAULT_CODEX_PROFILE_ID = 'codex-default';

export interface SeedOptions {
  /** Does `~/.codex/auth.json` exist? Checked by the CALLER — this module never
   *  touches the filesystem — because the answer decides whether a Codex row
   *  appears in a list that must not offer accounts the user cannot use. */
  hasCodexAuth: boolean;
  /** Epoch ms for the createdAt/updatedAt stamps. Injectable so a test can
   *  assert on them; defaults to now. */
  now?: number;
  /** M22.1. Ids that exist as TOMBSTONES in the store. A seed whose id is in
   *  here is one the user deliberately deleted, and it must stay deleted: a
   *  removed "Codex — default" that reappears on every reload is a row that
   *  cannot be gotten rid of. Once the tombstone expires (30 days) the id
   *  stops appearing here and the seed returns — acceptable, because by then
   *  the deletion is an old decision, not an open argument with the UI. */
  tombstonedIds?: readonly string[];
}

/**
 * The profiles to ADD on first run — never a replacement list, so a caller can
 * upsert the result unconditionally on every activation and get nothing back
 * once the roster is populated.
 *
 * A Claude default is always seeded: the extension launches Claude sessions
 * whether or not anybody ever opens the accounts view, and having them belong
 * to a visible account from day one is what makes the pin (and every usage
 * meter hung off it) meaningful. A Codex default is seeded only when
 * `~/.codex/auth.json` says there is a Codex login to point at — an account row
 * for a CLI that is not signed in is a row whose only possible action fails.
 *
 * Neither seeded profile gets a configDir: they are the DEFAULT ACCOUNT for
 * their provider, inheriting the login that is already on the machine. Giving
 * them a private directory would sign the user out of their own CLI, which is
 * the one thing a feature about accounts must never do.
 */
export function seedDefaultProfiles(
  existing: readonly AccountProfile[],
  opts: SeedOptions,
): AccountProfile[] {
  const live = (existing ?? []).filter(
    (p): p is AccountProfile => !!p && p.deleted !== true,
  );
  const stamp = new Date(
    typeof opts?.now === 'number' && Number.isFinite(opts.now)
      ? opts.now
      : Date.now(),
  ).toISOString();

  const taken = new Set(live.map((p) => p.id));
  // A tombstoned seed id is a deletion the user meant (M22.1) — folding these
  // into `taken` is what stops the next activation from arguing about it.
  for (const id of opts?.tombstonedIds ?? []) {
    if (typeof id === 'string' && id !== '') taken.add(id);
  }
  // "Already has one" is about the PROVIDER, not about the id: a user who
  // deleted our seed and made their own Claude account must not have ours
  // handed back on the next activation.
  const hasProvider = (provider: ProviderId): boolean =>
    live.some((p) => (isProviderId(p.provider) ? p.provider : DEFAULT_PROVIDER) === provider);

  const out: AccountProfile[] = [];
  let order = nextOrder(live);

  const seed = (id: string, provider: ProviderId, label: string): void => {
    if (taken.has(id) || hasProvider(provider)) return;
    taken.add(id);
    out.push({
      id,
      provider,
      label,
      order: order++,
      createdAt: stamp,
      updatedAt: stamp,
    });
  };

  seed(DEFAULT_CLAUDE_PROFILE_ID, 'claude', 'Claude — default');
  if (opts?.hasCodexAuth) {
    seed(DEFAULT_CODEX_PROFILE_ID, 'codex', 'Codex — default');
  }
  return out;
}
