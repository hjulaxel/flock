// src/accounts.ts — what an AI account is: its id, its label, its place in the
// list, and the environment a session launched on it runs under.
//
// Pure: it imports ./types and nothing else — no vscode, no node:os, no fs —
// so every rule in here is unit-testable without a workbench and can be called
// from the command layer, the view and the launcher alike.
//
// The one idea this file encodes: an account IS a config directory. Both CLIs
// keep their OAuth token, their `settings.json` and their history under one
// root that an environment variable relocates — `CLAUDE_CONFIG_DIR` for Claude
// Code, `CODEX_HOME` for Codex. Point a launch at a different root and it is a
// different signed-in account, with no shared state whatsoever: you log in once
// per profile and never again, switching costs nothing, and two sessions on two
// accounts can run side by side in the same window. Everything else about
// accounts — routing, pinning, the usage meters — is bookkeeping on top of that
// one fact.
//
// The DEFAULT ACCOUNT is the profile with neither a configDir nor extraEnv. It
// resolves to an empty env and therefore inherits `~/.claude` exactly as every
// session did before accounts existed. That is why a user who wants none of
// this pays nothing for it: their one profile is a no-op wrapper around the
// behaviour they already had.
//
// Secrets: `extraEnv` is where an API-key account keeps its key. Nothing in
// this file logs, formats or otherwise reproduces those values — the validation
// below inspects key names and value types only, and every helper that has to
// reject something says which key was rejected and never what was in it.

import {
  DEFAULT_PROVIDER,
  MAX_ACCOUNT_ID_LEN,
  MAX_ACCOUNT_LABEL_LEN,
  isProviderId,
} from './types';
import type { AccountProfile, ProviderId } from './types';

// --------------------------------------------------------------- section

/**
 * Is the Accounts SECTION drawn — its list registered, the gear offering to
 * hide rather than show it?
 *
 * `section` is `lineage.accounts.section`, the switch. `legacyEnabled` is the
 * retired `lineage.accounts.enabled`, read RAW and consulted for one value
 * only: a literal `false` is the one thing somebody wrote on purpose, and the
 * fold must not switch their list back on. Everything else — `undefined` from
 * a settings file that never had the key, `true`, a unit double with no
 * opinion — defers to the section, which is what the fold means: one key with
 * the answer, the other honoured only where it still says something.
 */
export function accountsSectionDrawn(
  section: boolean,
  legacyEnabled: unknown,
): boolean {
  return section && legacyEnabled !== false;
}

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
 * The providers a Flock SESSION can actually be launched on.
 *
 * STILL PARTIAL, and the rule that decides membership has not moved: a
 * provider belongs here when Flock execs ITS CLI, so that the config root
 * `envForProfile` relocates is the one the running process actually reads.
 * What changed is the answer, not the test. The launcher used to exec exactly
 * one binary, and a launch on a Codex account would have run `claude` with
 * `CODEX_HOME` set, landed on the machine's default Claude login, and pinned
 * that conversation for life to an account it was never on — a session that
 * looks isolated in the UI and shares credentials in reality. Now
 * `TerminalRegistry.launch` picks its binary and its argv from
 * `LaunchOptions.provider` (see src/codex.ts for the Codex half), so a Codex
 * account launches `codex` under its own `CODEX_HOME` and the isolation the
 * row claims is the isolation the process gets.
 *
 * `generic` is IN the list because it makes no isolation claim at all — it is
 * the API-key profile, a Claude launch authenticated by an environment
 * variable, whose configDir `envForProfile` already ignores. `gemini` is OUT,
 * unchanged and for the original reason: this extension does not launch that
 * CLI, and no `CONFIG_DIR_ENV` entry exists to isolate it if it did. Its rows
 * still exist, still sign in from their own verb and still carry their meters;
 * they are simply not somewhere a session starts.
 */
export const SESSION_PROVIDERS: readonly ProviderId[] = [
  'claude',
  'codex',
  'generic',
];

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

/**
 * The CLI an account's sessions actually run, which is NOT the same question as
 * its provider.
 *
 * `generic` is the API-key profile: a CLAUDE launch authenticated by an
 * environment variable rather than by a login, so it runs the same binary,
 * writes the same transcripts into the same directory layout, and is
 * interchangeable with an OAuth Claude account as far as a conversation on disk
 * is concerned. That interchangeability is the whole reason this function
 * exists — see `switchRefusal`.
 */
export type SessionCli = 'claude' | 'codex' | 'gemini';

export function cliOfProfile(
  profile: AccountProfile | null | undefined,
): SessionCli {
  const provider = isProviderId(profile?.provider)
    ? profile.provider
    : DEFAULT_PROVIDER;
  if (provider === 'codex') return 'codex';
  if (provider === 'gemini') return 'gemini';
  return 'claude';
}

/** Why a conversation may not be moved to a given account. `null` = it may. */
export type SwitchRefusal = 'same-account' | 'cannot-host' | 'different-cli';

/**
 * May this conversation move from `from` to `to`?
 *
 * `from` is null for a conversation with no pin — one launched before accounts
 * existed, or on the machine's default login. Those live in the default config
 * directory and run `claude`, so they may move onto any account that also runs
 * claude; there is nothing special about them beyond having no row to name.
 *
 * THE RULE THAT MATTERS is `different-cli`. Moving a conversation between two
 * accounts is a change of LOGIN: the transcript is portable because it carries
 * no account identity, and the resumed process reads the same file out of a
 * different directory. Moving it between two CLIs would be neither — a Codex
 * account does not keep its conversations in `<dir>/projects/<slug>/<id>.jsonl`
 * at all, so there is nothing to move and nothing to resume. The verb has to
 * refuse that rather than produce a pin naming an account whose directory does
 * not hold the conversation, which is exactly the state the whole feature is
 * built to avoid.
 */
export function switchRefusal(
  from: AccountProfile | null | undefined,
  to: AccountProfile | null | undefined,
): SwitchRefusal | null {
  // Existence first: `cliOfProfile` reads a missing profile as the default
  // provider, so a null target would otherwise sail through the CLI test.
  if (!to || to.deleted === true) return 'cannot-host';
  if (from && from.id === to.id) return 'same-account';
  // The CLI test outranks `canHostSession` deliberately, and the ordering is
  // the answer to a question that changes over time. Which providers Flock can
  // START a session on grows as it learns to launch more CLIs; which CLI a
  // given conversation was written by never changes. So a Codex account is
  // refused for the reason that will still be true after the launcher learns
  // Codex — the conversation is a Claude one — rather than for one that is
  // about this build's capabilities and will quietly stop applying.
  if (cliOfProfile(from) !== cliOfProfile(to)) return 'different-cli';
  if (!canHostSession(to)) return 'cannot-host';
  return null;
}

/**
 * Every account this conversation could actually be moved to.
 *
 * `switchRefusal` already IS the rule; this only applies it to a roster, and it
 * exists so that nobody has to apply it again by hand. Three places used to
 * each have their own idea of the same question — the menu's context key
 * counted host-capable accounts, the picker filtered on `switchRefusal`, and
 * the at-the-limit offer filtered on `switchRefusal` without asking what CLI
 * the CONVERSATION was written by — and the three answers disagreed on the
 * default roster of one Claude login plus one Codex login. `sortProfiles` above
 * states the house answer to exactly this shape of problem: one function,
 * because the consumers have to agree.
 */
export function switchTargets(
  from: AccountProfile | null | undefined,
  profiles: readonly AccountProfile[],
): AccountProfile[] {
  return (profiles ?? []).filter(
    (p): p is AccountProfile => !!p && switchRefusal(from, p) === null,
  );
}

/**
 * Is there anywhere on this roster a conversation could be moved BETWEEN?
 *
 * Counts accounts that run the CLAUDE cli (see `cliOfProfile` — `generic`, the
 * API-key profile, runs it too) and that a session can start on. NOT accounts
 * that can host a session, which is the test this replaced and the reason the
 * menu entry went wrong: `SESSION_PROVIDERS` gained `codex` the day the
 * launcher learned to exec that binary, and from that day on a machine with
 * one Claude login and one Codex login counted two destinations while the
 * picker — built from `switchRefusal`, which refuses a cross-CLI pair — was
 * always empty. That is the shape this machine seeds by default whenever
 * `~/.codex/auth.json` exists, so it was most installs, and the symptom was a
 * verb offered on every session row that never had anywhere to go.
 *
 * TWO, and the case deliberately excluded is one Claude account plus an
 * unpinned conversation: `switchRefusal(null, thatAccount)` is legal, so the
 * palette can still run the verb and pin a conversation that has never been
 * pinned. It moves no bytes (both ends resolve to the same config directory),
 * and a row menu does not owe a slot to a move whose only effect is on a label.
 */
export function canSwitchAccounts(
  profiles: readonly AccountProfile[],
): boolean {
  let n = 0;
  for (const p of profiles ?? []) {
    if (!p || p.deleted === true) continue;
    if (cliOfProfile(p) !== 'claude') continue;
    if (!canHostSession(p)) continue;
    n++;
    if (n >= 2) return true;
  }
  return false;
}

/**
 * Is there anywhere on this roster a conversation could be HANDED OFF to?
 *
 * The exact mirror of `canSwitchAccounts`, and it has to be a separate
 * question rather than a reuse: a handoff crosses the CLI wall and a switch
 * refuses to. Gating the handoff entry on `canSwitchAccounts` would hide it on
 * precisely the roster it exists for — one Claude login plus one Codex login,
 * which is what this extension seeds by default whenever `~/.codex/auth.json`
 * exists, and which offers no legal same-CLI move at all.
 *
 * So: two host-capable accounts running DIFFERENT clis. Counted the way
 * `handoffRefusal` decides (`cliOfProfile` + `canHostSession`, its first two
 * tests) so the menu gate and the picker cannot drift — the drift between
 * those two is the bug 0.1.7 fixed on the switch entry, and repeating it here
 * would have been the same bug wearing the other verb's name.
 *
 * `hasTranscript`, the refusal's third test, is deliberately NOT counted: it
 * is a fact about one conversation, not about the roster, and a key read by
 * every row's `when` cannot ask it. A row whose session has never sent a
 * message still draws the entry and is refused with "send one message first",
 * which is the fork rule's wording and the answer that teaches.
 */
export function canHandOff(profiles: readonly AccountProfile[]): boolean {
  const clis = new Set<string>();
  for (const p of profiles ?? []) {
    if (!p || p.deleted === true) continue;
    if (!canHostSession(p)) continue;
    clis.add(cliOfProfile(p));
    if (clis.size >= 2) return true;
  }
  return false;
}

/** What `offerSwitch` decided: the accounts to offer, or the one sentence's
 *  worth of reason there are none. */
export type SwitchOffer =
  | { kind: 'ok'; targets: AccountProfile[] }
  /** The conversation was not written by a CLI Flock knows how to move. */
  | { kind: 'wrong-cli' }
  /** Claude's, but the roster holds nowhere else to put it. */
  | { kind: 'no-target' };

/**
 * The WHOLE decision behind "move this conversation to another account",
 * for the picker, the notification and anything else that has to ask.
 *
 * `cli` is the CONVERSATION's, never the pin's, and that is the fix rather
 * than a detail. A pin is a claim a user can change with another verb; the CLI
 * that wrote a transcript is a fact about the bytes, and it is the bytes this
 * feature moves. Reading the pin instead meant an unpinned Codex conversation
 * — one started in a terminal, which never gets a record at all — passed the
 * CLI gate (a missing pin reads as the default provider, i.e. claude) and was
 * then told by the transcript test that it "has not taken a turn yet", the one
 * sentence that gate exists to prevent.
 *
 * `wrong-cli` OUTRANKS the target list on purpose: when both are true the
 * useful sentence is about the user's conversation, not about their roster.
 * That ordering is also what stops the at-the-limit offer proposing a
 * Codex→Codex move — a legal pair by `switchRefusal`, since two Codex logins
 * really are the same CLI, and one the mover has simply never been written to
 * perform.
 */
export function offerSwitch(opts: {
  /** The CLI that wrote the conversation. */
  cli: SessionCli;
  /** The account it is pinned to now, or null for the default login. */
  from: AccountProfile | null | undefined;
  profiles: readonly AccountProfile[];
}): SwitchOffer {
  if (opts?.cli !== 'claude') return { kind: 'wrong-cli' };
  const targets = switchTargets(opts.from, opts.profiles);
  return targets.length === 0 ? { kind: 'no-target' } : { kind: 'ok', targets };
}

/**
 * Every environment variable a launch ON THIS ROSTER could set.
 *
 * Built from the roster rather than from a list somebody types out, because
 * its one consumer is the account switch's tmux tier, which has to REMOVE the
 * variables the account it is leaving set. `-e` on a respawn can only ever
 * set, so a move onto an account with a smaller environment — most obviously
 * back onto the default account, whose environment is empty — leaves the old
 * account's config dir behind in the pane's session environment and the
 * resumed CLI reads the account the conversation just left. A hardcoded pair
 * would go stale the first time somebody adds an API-key account.
 *
 * Every value of `CONFIG_DIR_ENV` is included whatever the roster holds: a
 * variable can have leaked into the tmux server's global environment from a
 * client that is long gone, and the roster it came from is not something this
 * function can see.
 */
export function accountEnvKeys(
  profiles: readonly AccountProfile[],
): string[] {
  const keys = new Set<string>(Object.values(CONFIG_DIR_ENV));
  for (const p of profiles ?? []) {
    const extra = p?.extraEnv;
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) continue;
    for (const key of Object.keys(extra)) {
      if (isEnvVarName(key)) keys.add(key);
    }
  }
  return [...keys].sort();
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
 * no environment at all did before accounts existed.
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

/**
 * WHERE one account's CLI keeps its state: the directory `envForProfile` points
 * the launch at, or `defaultDir` when it points at nothing.
 *
 * The rule is `envForProfile`'s own first clause, extracted rather than
 * restated, and it lives beside it for a reason that only matters once
 * conversations can MOVE between accounts: the place we write a transcript to
 * has to be the same place the next launch will look for it, and two spellings
 * of "where does this account live" is how those two come apart. A provider
 * with no config-dir variable (see CONFIG_DIR_ENV) shares the machine's
 * directory whatever its `configDir` field says — because that is exactly what
 * its launch does.
 *
 * `defaultDir` is a PARAMETER for the same reason `profileConfigDirFor` takes a
 * home: this module imports nothing. Callers pass `~/.claude`.
 */
export function configDirForProfile(
  profile: AccountProfile | null | undefined,
  defaultDir: string,
): string {
  const fallback = typeof defaultDir === 'string' ? defaultDir.trim() : '';
  if (!profile) return fallback;
  const dirVar = isProviderId(profile.provider)
    ? CONFIG_DIR_ENV[profile.provider]
    : undefined;
  if (dirVar === undefined) return fallback;
  const dir =
    typeof profile.configDir === 'string' ? profile.configDir.trim() : '';
  return dir === '' ? fallback : dir;
}

/**
 * Two config-directory paths naming the same directory.
 *
 * `path.resolve` would be the obvious tool and this module may not import it:
 * accounts.ts imports ./types and nothing else, which is what makes every rule
 * in here callable from the command layer, the view, the launcher and a unit
 * test alike. It costs nothing here, because both sides of every comparison
 * come from `configDirForProfile` or from `accountMove.sourceDirFor`, and both
 * of those deal exclusively in the absolute paths the store and the filesystem
 * handed them. Trailing separators are the one difference a user's hand-typed
 * `configDir` actually produces, so they are trimmed; case is NOT folded, since
 * two spellings that differ only in case are the same directory on macOS and
 * different directories on Linux, and guessing wrong in the permissive
 * direction here would suppress a restart that is needed.
 */
function sameConfigDir(a: string, b: string): boolean {
  const norm = (v: unknown): string =>
    typeof v === 'string' ? v.trim().replace(/[/\\]+$/, '') : '';
  const left = norm(a);
  return left !== '' && left === norm(b);
}

/**
 * The environment a conversation must be PUT BACK on when a move refuses.
 *
 * The distinction this exists for: the pin is a claim and the file is a fact.
 * `accountMove.sourceDirFor` deliberately looks past the pin — a conversation
 * whose pin has come apart from its bytes is found in whichever account
 * actually holds it — and the restore path was then rebuilding its environment
 * from the PROFILE, i.e. from the claim. So on the one path that can reach it (a
 * wrong pin and a refused move at the same time) the CLI was relaunched with
 * `CLAUDE_CONFIG_DIR` pointing at an account that does not contain the
 * conversation, and `claude --resume <id>` found nothing. "Put it back exactly
 * where it was" has to mean the directory the transcript was found in.
 *
 * CLAUDE'S VARIABLE SPECIFICALLY, and not `CONFIG_DIR_ENV[profile.provider]`:
 * the only mechanism that calls this moves Claude conversations, because
 * Claude's history layout is the only one Flock knows how to relocate
 * (`offerSwitch` refuses everything else up front), and `from` may be null —
 * the default login has no profile and therefore no provider to look one up by.
 *
 * When the pin was right this returns exactly `envForProfile(profile)`, so the
 * common path is unchanged and there is no new behaviour to regress.
 */
export function restoreEnvFor(
  profile: AccountProfile | null | undefined,
  /** The config dir the transcript was actually found in (`sourceDirFor`). */
  foundDir: string,
  /** `~/.claude`, the directory the default login uses. */
  defaultDir: string,
): Record<string, string> {
  const base = envForProfile(profile);
  const found = typeof foundDir === 'string' ? foundDir.trim() : '';
  if (found === '') return base;
  if (sameConfigDir(configDirForProfile(profile, defaultDir), found)) {
    return base;
  }
  return { ...base, [CLAUDE_CONFIG_DIR_ENV]: found };
}

/**
 * Would this account move actually MOVE anything?
 *
 * There is a real move whose answer is no. Two profiles can resolve to one
 * config directory — the default login and any provider with no config-dir
 * variable both land on `~/.claude`, and the roster this extension seeds by
 * default contains exactly such a pair — so the palette can offer, and a user
 * can confirm, a "switch" that is nothing but a re-pin. `moveConversation`
 * already knows: it early-returns `ok` having renamed nothing. The problem is
 * that the mechanism stops the process BEFORE it asks, so a change of label was
 * costing a killed turn and a respawned CLI, which is the one cost the
 * confirmation dialog leads with.
 *
 * THE DIRECTORIES ARE NOT ENOUGH, and this is the correction that matters. Two
 * profiles sharing a config dir can still differ in `extraEnv` — an API-key
 * account is exactly that shape — and there the restart is the whole point,
 * because the environment is read once at exec. And a pane that leaked a
 * `CLAUDE_CONFIG_DIR` from an older switch needs the respawn's removal list to
 * clear it, which only a restart applies. So both halves have to match: same
 * directory AND the same environment either side.
 *
 * `fromDir` is where the BYTES are (`sourceDirFor`), not where the pin says they
 * are. A pin that names the destination while the transcript sits in a third
 * account is a move that genuinely has to happen.
 */
export function switchMovesNothing(opts: {
  /** The config dir the transcript was found in. */
  fromDir: string;
  /** The config dir it would move to. */
  toDir: string;
  from: AccountProfile | null | undefined;
  to: AccountProfile | null | undefined;
}): boolean {
  if (!sameConfigDir(opts?.fromDir ?? '', opts?.toDir ?? '')) return false;
  const before = envForProfile(opts?.from);
  const after = envForProfile(opts?.to);
  const keys = Object.keys(before);
  if (keys.length !== Object.keys(after).length) return false;
  return keys.every((key) => before[key] === after[key]);
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
  /** Ids that exist as TOMBSTONES in the store. A seed whose id is in here is
   *  one the user deliberately deleted, and it must stay deleted: a removed
   *  "Codex — default" that reappears on every reload is a row that cannot be
   *  gotten rid of. Once the tombstone expires (30 days) the id stops appearing
   *  here and the seed returns — acceptable, because by then the deletion is an
   *  old decision, not an open argument with the UI. */
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
  // A tombstoned seed id is a deletion the user meant — folding these into
  // `taken` is what stops the next activation from arguing about it.
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
