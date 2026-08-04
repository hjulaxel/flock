// src/types.ts — the shared type contract for the Flock extension.
// It imports nothing (not even vscode), so every layer can depend on it.
//
// SCHEMA VERSIONS. Every bump of STATE_SCHEMA_VERSION is additive: no existing
// symbol changes meaning, the migration only materialises the maps the newer
// version adds, and a build reading a state.json newer than itself preserves
// the keys it does not recognise verbatim (the unknown-key rule). That pair of
// properties is what lets an old and a new build share one state file on the
// same machine without either of them losing data.
//
// The project-first rework (state.json 1 -> 2, gaining two top-level maps)
// added:
//
//   * ProviderId / PROVIDERS  — the tree's leading glyph is the LLM provider's
//     logo, so the provider has to be a first-class value.
//   * ProjectRecord           — a project is a NAME plus one main directory
//     and any number of extra directories. Folders are no longer the unit of
//     organisation; they are just the addresses a project lives at.
//   * HiddenFolder            — the machine-wide roster surfaces every folder
//     anyone ever ran claude in; folders must be removable from view.
//   * TerminalLocationPref    — new sessions open as editor tabs, not in the
//     terminal panel.
//
// Accounts (4 -> 5, gaining an `accounts` map and an `accountSettings`
// singleton) added:
//
//   * AccountProfile   — one AI account you can launch sessions on. On this
//     machine an account IS a config directory: CLAUDE_CONFIG_DIR /
//     CODEX_HOME point the CLI at its own credential store, which is what
//     makes "one /login per profile, ever" true rather than aspirational.
//   * RoutingChoice    — which account a NEW session gets: a named one, any
//     one of a provider's, or whatever the auto-picker likes best.
//   * UsageSnapshot    — the five-hour and weekly windows, as numbers. Read by
//     the limits module (over the network, per account) and consumed
//     everywhere else as plain data, so the auto-picker stays pure.

// ------------------------------------------------------------------ identity

// These two MUST equal `publisher` and `name` in package.json: the extension id
// is what VS Code resolves `vscode://<id>/focus` against, so a mismatch breaks
// cross-window focus silently — the URI simply never reaches us. A test
// cross-checks both against the manifest rather than against a copy of these
// literals, which is the only version of that test that can fail.
export const PUBLISHER = 'hjulaxel';
export const EXTENSION_NAME = 'flock';
export const EXTENSION_ID = `${PUBLISHER}.${EXTENSION_NAME}`;

export const VIEW_CONTAINER_ID = 'lineage';
export const VIEW_ID = 'lineageSessions';
/** The project header, contributed into the BUILT-IN explorer container rather
 *  than ours — it names the project the folder tree beneath it is showing,
 *  which is a caption for the Explorer and belongs beside it. */
export const PROJECT_VIEW_ID = 'lineageProject';
/** Intra-tree DnD mime: application/vnd.code.tree.<lowercased view id>. */
export const TREE_DND_MIME = 'application/vnd.code.tree.lineagesessions';
export const SESSION_URI_SCHEME = 'lineage-session';
export const ENV_NODE_ID = 'LINEAGE_NODE_ID';
export const BRAND_COLOR_ID = 'lineage.brand';
/** The status dot's three lit colours. Idle is deliberately absent, and now
 *  means NO DOT AT ALL rather than an uncoloured one: a tree where every quiet
 *  row still carries a mark trains the eye to ignore marks, which is the one
 *  thing a status dot cannot afford.
 *
 *  `done` is red rather than green because it is the attention state — a
 *  finished session is the row that wants you — and green means "resolved,
 *  nothing to do" in every other surface on the screen. `closed` is the grey
 *  ring: a row that is over, which is a different thing from a row that is
 *  quiet. */
export const RUNNING_COLOR_ID = 'lineage.running';
export const DONE_COLOR_ID = 'lineage.done';
export const CLOSED_COLOR_ID = 'lineage.closed';
/** The single glyph the status dot is drawn with. A FileDecoration badge is
 *  capped at two graphemes by the workbench, which is the whole reason status
 *  is a dot and not a word. */
export const STATUS_DOT = '●';
/** RETIRED. The hollow ring a closed row used to carry at its right edge.
 *  Nothing paints it now: a closed row is already dimmed, its logo greyed and
 *  (in the native tree) its label greyed by the decoration's colour, so the ring
 *  was a second mark saying what the row said anyway — and a column of empty
 *  circles beside every finished session is exactly the "every row carries a
 *  mark" noise the lit dots exist to stand out from.
 *
 *  The constant stays for the same reason EditorialRecord.hidden does: the
 *  character was a considered choice (deliberately not '◌' U+25CC, which is
 *  absent from the workbench's UI-font fallbacks and renders as tofu in a
 *  FileDecoration badge), and a future surface that wants a printable "over"
 *  mark should start from that answer rather than rediscover it. */
export const CLOSED_DOT = '○';
/** The numeric badge on the Flock view container (the activity-bar logo):
 *  how many rendered rows carry a lit attention dot. DEACTIVATED for now —
 *  flip to `true` to bring it back, no other change needed. Both surfaces
 *  (native tree and inline webview) read this at the one line where they
 *  write `view.badge`, and both write `undefined` while it is off, so the
 *  badge clears rather than freezing at its last value. The counters behind
 *  it — `LineageTreeProvider.attentionCount` and `attentionCountOf` — stay
 *  live and tested; only the publish is switched off. */
export const ATTENTION_BADGE_ENABLED = false;
export const CONTEXT_HOOKS_INSTALLED = 'lineage.hooksInstalled';
/** True while any rendered session is done-and-not-looked-at. Drives the bell
 *  icon in the view title: `bell-dot` when set, plain `bell` when not — two
 *  menu entries with complementary `when` clauses, because an icon
 *  contribution cannot change at runtime. */
export const CONTEXT_HAS_UNSEEN = 'lineage.hasUnseen';
/** True when the user chose the built-in tree widget over the inline (webview)
 *  sidebar. The two views' `when` clauses are complements of this, so exactly
 *  one is ever on screen. */
export const CONTEXT_NATIVE_TREE = 'lineage.nativeTree';
/** Mirrors `lineage.onlyActiveSessions` into a context key, because the filter
 *  is a TOGGLE in the view title and a contributed button has no state: the on
 *  and off halves are two commands with complementary `when` clauses and
 *  different icons, the same shape the bell already uses (CONTEXT_HAS_UNSEEN). */
export const CONTEXT_ONLY_ACTIVE = 'lineage.onlyActive';
/** The tree holds at least one row a fork could target. Gates the fork button
 *  in the view title, whose whole job is to branch off the conversation you are
 *  looking at — on a machine with no sessions running there is nothing for it to
 *  be about, and a button that can only ever report "nothing to fork" is worse
 *  than no button.
 *
 *  DELIBERATELY COARSE. It answers "is there a row at all", not "does that row
 *  have a transcript on disk yet": the precise refusal costs a `hasTranscript`
 *  stat per node and would have to be recomputed on every rebuild, and
 *  `forkFlow` already declines an unstarted conversation with the one sentence
 *  that actually helps ("send one message first"). So this hides the button when
 *  the tree is empty, and the verb stays honest for everything past that. */
export const CONTEXT_HAS_FORKABLE = 'lineage.hasForkable';
/** TWO OR MORE session rows are selected in whichever view is on screen.
 *
 *  It exists to make a menu entry honest. The workbench opens a row's context
 *  menu on the row you right-clicked and hands the command that row alone, so
 *  "Delete Session" on one of four selected rows would delete one and read as
 *  though it had deleted four. This key swaps the singular entry for a plural
 *  one that says how many it is about to take — the same complementary-`when`
 *  shape the bell and the active-only filter already use. */
export const CONTEXT_MULTI_SELECT = 'lineage.multiSelect';
/** Gates the project header view inside the BUILT-IN Explorer container.
 *
 *  NOT simply "this window is a Flock workspace". It is "this window has
 *  something to say up there", which is: the feature is enabled AND the window
 *  is either already anchored (so the header names the project the folder tree
 *  is showing) or has an active project (so the header can offer the one-time
 *  opt-in, at the only moment it is meaningful). Gating on `anchored` alone
 *  would hide the setup row from every window that has not run setup — i.e.
 *  from exactly the windows it exists for; not gating at all would put a
 *  Flock view in the Explorer of every install that never opened a
 *  project. */
export const CONTEXT_EXPLORER_FOLLOW = 'lineage.explorerFollow';

// ------------------------------------------------------------------ schema

/** Version of the persisted globalStorage state.json blob.
 *  v2 adds `projects` and `hiddenFolders`. v3 adds `chains` (generation
 *  chains). v4 adds `workspaces` (project workspaces). v5 adds `accounts` and
 *  `accountSettings`. Every step is additive — the migration just adds the
 *  empty map, and an older build reading a newer file preserves it verbatim
 *  via the unknown-key rule. */
export const STATE_SCHEMA_VERSION = 5;

// ------------------------------------------------------------------ lineage

/** forkedFrom sits on line 1 of every native fork observed; 50 gives ample
 *  margin while keeping the scan an O(head) read. Mirrors Python
 *  core.FORK_HEAD_LINES. */
export const FORK_HEAD_LINES = 50;
/** How far up the process chain the argv walk looks for the launching
 *  `claude --fork-session --resume <parent>`. Mirrors FORK_ARGV_MAXDEPTH. */
export const FORK_ARGV_MAXDEPTH = 6;
/** Max bytes read by the non-deep (head) transcript scan. */
export const HEAD_SCAN_MAX_BYTES = 512 * 1024;
/** Negative parent resolutions are re-checked after this many ms (transcripts
 *  are written lazily); positive resolutions are cached forever. */
export const NEGATIVE_RESOLUTION_TTL_MS = 60_000;
/** Ghost-ancestor chains resolve at most this deep. */
export const MAX_GHOST_DEPTH = 10;

// ------------------------------------------------------------------ archive
// `claude agents --json` is live-only, so a closed session used to leave the
// tree entirely. The archive index reads ~/.claude/projects so closed sessions
// stay visible, keep their lineage, and can be resumed.

/** Lines of a transcript head read for archived display facts (cwd first
 *  appears at median line 3 / p90 line 11 / max 36 in real data). */
export const ARCHIVE_HEAD_LINES = 60;
/** Max bytes read from a transcript head when indexing the archive. */
export const ARCHIVE_HEAD_MAX_BYTES = 128 * 1024;
/** Minimum gap between archive re-scans on the rebuild path. */
export const ARCHIVE_RESCAN_MIN_MS = 30_000;

/** A session id is a UUID; this exact-shape guard keeps stray tokens from
 *  becoming bogus parent edges. Mirrors Python _SESSION_ID_RE. */
export const SESSION_ID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isSessionId(s: unknown): s is string {
  return typeof s === 'string' && SESSION_ID_RE.test(s);
}

export function shortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

// ---------------------------------------------------------------- providers
// The leading glyph on a session row is the LLM provider's logo. Today every
// row the roster reports is Claude Code; the other ids exist so a project can
// declare what it runs and the tree stays honest when it is not claude.
//
// These are the OFFICIAL brand marks (paths from Simple Icons, whose icon data
// is CC0), not lookalikes: a row that claims to be Claude should carry Claude's
// actual glyph. Nominative use — identifying which tool a session runs — is
// what the marks are for; see the README's trademark note.

export type ProviderId = 'claude' | 'codex' | 'gemini' | 'generic';

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** File under media/providers/. Rendered as TreeItem.iconPath. */
  iconFile: string;
  /** Optional dark-theme variant of `iconFile`. Set only where the brand mark
   *  is MONOCHROME and therefore cannot read on both backgrounds from one file
   *  — OpenAI's is black-on-light / white-on-dark by its own brand guide. A
   *  coloured mark (Claude's terracotta, Gemini's violet) needs no pair. */
  iconFileDark?: string;
  /** Codicon id used when the svg cannot be located (unit tests, a packaging
   *  slip). The tree must never render an icon-less row. */
  fallbackIcon: string;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    iconFile: 'claude.svg',
    fallbackIcon: 'sparkle',
  },
  codex: {
    id: 'codex',
    label: 'Codex / OpenAI',
    iconFile: 'codex.svg',
    iconFileDark: 'codex-dark.svg',
    fallbackIcon: 'circuit-board',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    iconFile: 'gemini.svg',
    fallbackIcon: 'star-full',
  },
  generic: {
    id: 'generic',
    label: 'Other',
    iconFile: 'generic.svg',
    fallbackIcon: 'terminal',
  },
};

export const PROVIDER_IDS: readonly ProviderId[] = [
  'claude',
  'codex',
  'gemini',
  'generic',
];

export const DEFAULT_PROVIDER: ProviderId = 'claude';

export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PROVIDERS, v);
}

/** Directory holding the provider svgs, relative to the extension root. */
export const PROVIDER_MEDIA_DIR = 'media/providers';

// ----------------------------------------------------------------- projects
// A project is the unit of organisation: a user-chosen NAME, one main
// directory, and any number of extra directories, so one project can span
// several checkouts. Sessions attach to a project by cwd — longest matching
// directory wins — never the other way round, so a project can be created,
// renamed or re-pointed without touching a single session record.

export interface ProjectRecord {
  id: string;              // uuid, minted at creation
  name: string;            // user-chosen; the tree row's label
  rootDir: string;         // the main directory
  dirs: string[];          // EXTRA directories; never contains rootDir
  /**
   * SUBPROJECTS. The project this one is filed under, or absent for a
   * top-level project. Arbitrary depth and breadth: a subproject is an ordinary
   * ProjectRecord in every other respect — its own name, its own directories,
   * its own provider and routing — and the only thing this field changes is
   * where its row is drawn.
   *
   * A POINTER UP, never a list of children down, for the same reason
   * EditorialRecord.chat is a flag on the chat rather than an array on the
   * project: `projects` is merged newest-WINS per record, so a children array
   * written by two windows a second apart would lose one of the entries for
   * good. A parent pointer has a single writer — the child — and the tree is
   * rebuilt from those pointers on every render.
   *
   * Nothing here is trusted at render time. An id naming a project that does
   * not exist (deleted, or not yet merged in from another window) renders as
   * TOP-LEVEL rather than vanishing, a cycle is broken at the first repeated
   * id, and a chain longer than MAX_PROJECT_DEPTH is cut — see
   * projects.buildProjectTree. A tree that cannot be drawn must degrade to a
   * flat list, never to an empty view or a hung render.
   *
   * `null` clears it (the store's upsert writes explicit nulls and drops the
   * field), which is what "move to top level" persists.
   */
  parentId?: string | null;
  provider?: ProviderId;   // default DEFAULT_PROVIDER
  /** CLOSED. The project is put away: no row, and its sessions have no rows
   *  either (computeGrouping counts them as hidden rather than demoting them
   *  to folder rows — see the comment there). Nothing is deleted, no process
   *  is signalled, and `reopenProject` brings the whole thing back exactly as
   *  it was.
   *
   *  Earlier versions shipped this field as a recoverable delete with no verb
   *  of its own, reachable only through "Show Hidden Folders and Projects…".
   *  It now has the pair it always needed — Close Project on the row, Open
   *  Project… at the top of the view — and keeps the FIELD NAME so that every
   *  project an older build put away is already closed, with no migration and
   *  no window disagreeing with the one beside it. */
  hidden?: boolean;
  /** RETIRED. The old one-chat-per-project pointer: the chat button read it to
   *  decide whether to focus, resume or mint. The button now always mints (see
   *  COMMANDS.chatInProject) and the history picker derives a project's chats
   *  from the editorial records — the same cwd-matching every other kind of
   *  membership uses — so nothing reads or writes this any more. Still typed
   *  because state files written by older versions carry it, and a field that
   *  vanishes from the type is a field the loader would drop. */
  chatSessionId?: string;
  /** Which ACCOUNT this project's new sessions launch on, overriding the
   *  global default. Optional and additive: absent means "follow the global
   *  default", which is what every project did before accounts existed.
   *
   *  On the PROJECT rather than on the folder because routing is an editorial
   *  choice about a body of work ("the client repo bills to the client's
   *  account"), and the folder set of a project changes while that choice does
   *  not. Never consulted for an existing conversation — see
   *  EditorialRecord.profileId; this only decides what a NEW session gets. */
  routing?: RoutingChoice;
  /**
   * Branch curation. Both lists hold BRANCH NAMES, not worktree paths: a
   * worktree can be removed and re-added at a different path for the same
   * branch, and the user's decision was about the branch.
   *
   * Three-state on purpose, because two would lose information. A branch is
   * shown if it is in `shownBranches`, hidden if it is in `hiddenBranches`, and
   * otherwise falls to the DEFAULT policy (defaultBranchVisibility) — which
   * depends on facts that change under the user, like whether a session is
   * running on it. Collapsing to one list would make "I hid this" and "the
   * policy has not picked it yet" the same state, so a branch the user hid
   * would come back the moment somebody started a session on it.
   *
   * Absent means "never curated", which is the correct starting point: the
   * policy decides, and the lists only ever record a decision the user made.
   */
  shownBranches?: string[];
  hiddenBranches?: string[];
  /** The branch block is folded shut. Per project and persisted, because it is
   *  a statement about how much room this project's branches deserve, which
   *  does not change between sessions the way a scroll position does. */
  branchesCollapsed?: boolean;
  /** TOMBSTONE. A deleted project keeps its key so the record-level
   *  newest-wins merge can express the delete: dropping the key outright makes
   *  a delete indistinguishable from "the other window has not heard of it
   *  yet", and any window still holding the project in memory re-adds it on
   *  its next write. Tombstones are hidden from every reader and are swept at
   *  load time once older than PROJECT_TOMBSTONE_TTL_MS. */
  deleted?: boolean;
  createdAt: string;       // ISO
  updatedAt: string;       // ISO; record-level merge key (newest wins)
}

/** How long a deleted-project tombstone is kept. Comfortably longer than
 *  WINDOW_TTL_MS, so no window can still be holding the live record in memory
 *  by the time the tombstone is swept. */
export const PROJECT_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A directory the user removed from the tree. Keyed by normalized path.
 *  Sessions that belong to a project are NEVER hidden by this — an explicit
 *  project membership outranks a blanket folder hide. */
export interface HiddenFolder {
  path: string;
  hiddenAt: string; // ISO; merge key
}

export const MAX_PROJECT_NAME_LEN = 60;

/**
 * How deep the subproject tree may go before the renderer stops descending.
 *
 * A cap rather than "as deep as you like", because the depth is read out of
 * user-editable state that several windows write: the cycle guard already stops
 * a loop, but a hand-edited chain of two hundred parents would be two hundred
 * indents of a sidebar that is 300px wide. Eight is far past any real structure
 * (repo → area → service is three) and small enough that the deepest row still
 * has room for a name.
 *
 * A project past the cap is not hidden — it is re-rooted at the cap's level, so
 * every project always has a row somewhere.
 */
export const MAX_PROJECT_DEPTH = 8;

// ----------------------------------------------------------------- accounts
// An ACCOUNT is an AI subscription you can launch sessions on. Somebody with a
// work Max plan, a personal Pro plan and an API key has three, and the only
// thing standing between them otherwise is logging out and back in.
//
// The unit is a CONFIG DIRECTORY, because that is the one thing the CLIs give
// us that isolates credentials completely: `CLAUDE_CONFIG_DIR` and `CODEX_HOME`
// each point at a private store holding that account's OAuth token, so a
// terminal launched with one set is signed in as that account and nothing else
// on the machine notices. Verified on macOS: one `/login` per profile, ever —
// no keychain juggling, no re-auth when you switch back.
//
// A profile with NEITHER a configDir NOR extraEnv is the DEFAULT ACCOUNT: it
// resolves to an empty env and therefore inherits whatever `~/.claude` (or
// `~/.codex`) is already logged in as. That profile is what a machine with one
// account has, and it is why adding accounts costs a user who does not want
// them exactly nothing.
//
// NOTHING IN HERE EVER HOLDS A CREDENTIAL. `configDir` is a path; `extraEnv` is
// for the profiles whose whole identity is an env var (an `ANTHROPIC_API_KEY`
// account), and it is the ONE field in this file whose values must never be
// logged, echoed into an error message or shown in a tooltip. Treat it the way
// you would treat the key itself, because on those profiles it IS the key.

export interface AccountProfile {
  /** Stable slug, minted once from the label and never rewritten — it is both
   *  the map key in state.json and the DIRECTORY NAME under
   *  `~/.lineage/profiles/`, so renaming the account must not move the
   *  credential store out from under every session pinned to it. Validated
   *  against a strict slug shape on load for the same reason: an id is a path
   *  segment, and a hand-edited `../../` in one would escape the profiles
   *  directory. See accounts.slugify / accounts.isAccountId. */
  id: string;
  /** Which CLI this account signs into. Decides WHICH env var carries the
   *  config dir (claude -> CLAUDE_CONFIG_DIR, codex -> CODEX_HOME) and which
   *  logo the row draws. */
  provider: ProviderId;
  /** User-facing name: "Work (Max)", "Personal", "API key". */
  label: string;
  /** Absolute path to this account's private config directory. UNDEFINED means
   *  "inherit the default login" — see the note above; it is a real, supported
   *  state, not a missing value. */
  configDir?: string;
  /** Extra environment for launches on this account, merged OVER the config-dir
   *  var so an env-key profile can override it deliberately. SECRET-BEARING —
   *  never log, never render, never put in an error string. */
  extraEnv?: Readonly<Record<string, string>>;
  /** View arrangement, ascending. Also the auto-picker's FINAL tiebreak, which
   *  is what makes "drag the account you prefer to the top" mean something
   *  rather than being decoration. */
  order: number;
  createdAt: string;  // ISO
  /** ISO; record-level merge key (newest wins), exactly as on every other map
   *  in state.json. Not optional: the merge needs a clock per record, or two
   *  windows editing different accounts lose one of them. */
  updatedAt: string;
  /** TOMBSTONE, for the reason ProjectRecord.deleted carries one: a dropped key
   *  is indistinguishable from "the other window has not heard of this account
   *  yet", so any live window would re-add a deleted account on its next
   *  write. Hidden from every reader; swept once older than
   *  ACCOUNT_TOMBSTONE_TTL_MS. */
  deleted?: boolean;
}

/** As PROJECT_TOMBSTONE_TTL_MS, and for the same reason: comfortably longer
 *  than WINDOW_TTL_MS, so no window can still hold the live record in memory by
 *  the time the tombstone is swept. */
export const ACCOUNT_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const MAX_ACCOUNT_LABEL_LEN = 60;
/** Ids are directory names. 40 characters is plenty for a slug and short
 *  enough that `~/.lineage/profiles/<id>` stays well inside every path limit. */
export const MAX_ACCOUNT_ID_LEN = 40;

/**
 * Which account a NEW session launches on. Three tiers, deliberately:
 *
 *   account  — always this one. The answer for "the client's repo bills to the
 *              client's account", where being clever would be a billing error.
 *   provider — any account of this provider, auto-picked among them. What you
 *              want when you have two Claude subscriptions and no opinion
 *              about which of THEM, but a firm one about not landing on Codex.
 *   auto     — auto-picked across every account.
 *
 * A discriminated union rather than a nullable id plus a flag, because the
 * three states have genuinely different data and a `{ id: null, provider: null,
 * auto: false }` shape can spell things that mean nothing.
 */
export type RoutingChoice =
  | { kind: 'account'; id: string }
  | { kind: 'provider'; provider: ProviderId }
  | { kind: 'auto' };

/** JSON boundary guard: state.json and the settings blob are both hand-editable
 *  and both survive older builds, so a routing value arrives as `unknown`. */
export function isRoutingChoice(v: unknown): v is RoutingChoice {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const kind = (v as { kind?: unknown }).kind;
  if (kind === 'auto') return true;
  if (kind === 'account') {
    const id = (v as { id?: unknown }).id;
    return typeof id === 'string' && id.length > 0;
  }
  if (kind === 'provider') {
    return isProviderId((v as { provider?: unknown }).provider);
  }
  return false;
}

/** One rate-limit window as the provider reports it. */
export interface UsageWindow {
  /** Percent of the window consumed, 0-100. */
  utilization: number;
  /** Epoch ms at which this window rolls over, when the provider says. */
  resetsAt?: number;
}

/**
 * What the limits endpoint says about ONE account, plus how much to trust it.
 *
 * Every window is optional because every one of them is genuinely absent
 * sometimes: an account that has not been used today has no open five-hour
 * window, and a plan without an Opus-specific weekly cap has no
 * `sevenDayOpus`. `error` distinguishes the three ways "no numbers" happens —
 * we were never logged in (`no-credentials`), the token has expired
 * (`expired`), or the request/parse fell over — because the first two are
 * things the user can fix and the last two are things they should ignore.
 *
 * `stale` marks a snapshot served from cache past its freshness window: still
 * the best answer available, and much better than showing nothing while a
 * network call is in flight.
 */
export interface UsageSnapshot {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  sevenDayOpus?: UsageWindow;
  /** Epoch ms when these numbers were read. */
  fetchedAt: number;
  stale?: boolean;
  error?: 'no-credentials' | 'expired' | 'http' | 'parse';
  /** Who the profile's config dir says is signed in
   *  (`oauthAccount.emailAddress` from its `.claude.json`). Identity, not
   *  credential — shown in the view on purpose, so a row whose usage cannot be
   *  read still names its account instead of claiming "not logged in". */
  signedInAs?: string;
}

/**
 * The singleton settings record that sits beside the `accounts` map.
 *
 * One VALUE, not a set: it is merged newest-wins on `updatedAt` as a whole,
 * which is right because the only field in it is a single global choice and two
 * windows disagreeing about it should resolve to the later opinion, not to a
 * blend. The index signature is the same forward-compatibility promise every
 * record in this file makes — an older build round-trips a newer build's keys
 * instead of deleting them.
 */
export interface AccountSettings {
  /** Global default routing for new sessions. Absent = `{ kind: 'auto' }`,
   *  which is also what a machine with one account wants. */
  defaultRouting?: RoutingChoice;
  /** ISO; the whole-record merge key. */
  updatedAt?: string;
  [k: string]: unknown;
}

// ---------------------------------------------------------------- terminals
// Where a launched session's terminal goes. `editor` (the default) makes a
// Claude session a normal editor tab instead of a row in the terminal panel.

export type TerminalLocationPref = 'editor' | 'panel' | 'newWindow';

export function isTerminalLocationPref(v: unknown): v is TerminalLocationPref {
  return v === 'editor' || v === 'panel' || v === 'newWindow';
}

// ------------------------------------------------------------------ verbs

export const WRAP_PROMPT =
  'Wrap up this session: summarize what was accomplished in 3-6 bullet ' +
  'points, list any unfinished work, then stop.';

export const COMMANDS = {
  refresh: 'lineage.refresh',
  focusSession: 'lineage.focusSession',
  newSession: 'lineage.newSession',
  /** `newSession` with the folder question forced back on. `newSession` itself
   *  defaults to the project this window is open on and asks nothing, which is
   *  right for the `+` in the view title and wrong exactly once: when the
   *  folder you want is one no session has ever run in. This is that door, and
   *  it is palette-only — no icon, no menu. */
  newSessionIn: 'lineage.newSessionIn',
  forkSession: 'lineage.forkSession',
  /** A fork that opens on `/compact`: same exact `--fork-session --resume` edge
   *  as forkSession, with the compaction handed to the CHILD as its first turn.
   *  Branching and compacting are the two things you do to a conversation that
   *  has got long, and doing them separately means either compacting the
   *  history you wanted to keep, or forking a context that is already too big
   *  to work in. The parent is never touched. */
  forkAndCompact: 'lineage.forkAndCompact',
  /** Fork from the VIEW TITLE, where there is no row to read a target off.
   *
   *  A separate id rather than a second `forkSession` entry, for two reasons
   *  that both matter. A `view/title` command is invoked with no argument at
   *  all, so `forkSession` up there would reach `targetSession`'s QuickPick
   *  every single time — a picker is the one thing a toolbar button must not
   *  be. And a contributed command carries exactly one icon: `forkSession`
   *  wears `$(git-branch)` on every session row's inline strip, and the top bar
   *  wants `$(repo-forked)`, which is the glyph for "branch off THIS one".
   *
   *  It resolves its own target — see `activeForkTarget` — and asks only when
   *  the answer would otherwise be a guess. */
  forkActiveSession: 'lineage.forkActiveSession',
  /** REMOVED — `lineage.askSession`, "Ask in a Fork…". A fork whose
   *  first turn came out of an input box. Every fork already opens a terminal
   *  with a cursor in it, so the verb's whole contribution was moving the
   *  typing into a modal — at the price of a THIRD fork entry in the session
   *  menu, two of which did the identical thing to the lineage. The question
   *  it was reached for ("just ask something about this") is what the project
   *  CHAT is, and a chat needs no parent and leaves no row. The id is recorded
   *  here, not resurrected: nothing may re-use the string. */
  renameSession: 'lineage.renameSession',
  /** Start an inline edit on the row in the webview sidebar. Falls back to
   *  `renameSession`'s quick input when the inline view is not available. */
  renameSessionInline: 'lineage.renameSessionInline',
  closeSession: 'lineage.closeSession',
  closeWithSummary: 'lineage.closeWithSummary',
  wrapSession: 'lineage.wrapSession',
  copySessionId: 'lineage.copySessionId',
  // TWO verbs on a row, no third: CLOSE ends the tab (the row stays,
  // inactive), DELETE removes the row (restorable). The old hide verb is
  // retired; old `hidden` records read as deleted (see state.sanitizeRecord).
  deleteSession: 'lineage.deleteSession',
  /** The same verb over a MULTI-SELECTION. A separate id rather than a
   *  widened `deleteSession` because the two have to say different things in a
   *  menu — "Delete Session" over four selected rows is a lie — and a
   *  contributed command has exactly one title. Their `when` clauses are
   *  complements of `lineage.multiSelect`. */
  deleteSessions: 'lineage.deleteSessions',
  restoreSession: 'lineage.restoreSession',
  openProject: 'lineage.openProject',
  installHooks: 'lineage.installHooks',
  removeHooks: 'lineage.removeHooks',
  resumeSession: 'lineage.resumeSession',
  // Projects and visibility
  newProject: 'lineage.newProject',
  configureProject: 'lineage.configureProject',
  /** Start an inline edit on the project's row in the webview sidebar.
   *  Falls back to `renameProject`'s quick input when the inline view is not
   *  available — the same pairing `renameSessionInline`/`renameSession` uses.
   *  Deliberately NOT the same verb as the session pair: `isSessionId` is a
   *  bare uuid-shape test with no session/project discriminator, and a project
   *  id is a bare uuid too, so one overloaded verb would happily build
   *  `session:<projectUuid>` — a row key that matches nothing, silently. */
  renameProjectInline: 'lineage.renameProjectInline',
  renameProject: 'lineage.renameProject',
  deleteProject: 'lineage.deleteProject',
  /** CLOSE a project: it leaves the tree, taking its sessions' rows with it,
   *  and nothing else happens — no process is signalled, no record is deleted,
   *  no directory is touched. The put-away that is not a delete, and the reason
   *  `deleteProject` can stay as blunt as it is. Writes
   *  `ProjectRecord.hidden`, the flag that already existed for exactly this and
   *  never had a verb of its own. */
  closeProject: 'lineage.closeProject',
  /** The door back in: a picker over every CLOSED project — the project
   *  history — at the top level of the view, where a closed project has no row
   *  to right-click. Deliberately NOT `openProject`, which is an older and
   *  entirely different verb (open a project's DIRECTORY in a new VS Code
   *  window) and which a closed project cannot be reached from either. */
  reopenProject: 'lineage.reopenProject',
  /** A project filed UNDER this one. The same create flow as `newProject`,
   *  with the parent pre-answered — which is the whole difference between
   *  "make a project and then go and find where it belongs" and the gesture
   *  people actually make, which is "this repo has an api and a web and I want
   *  them under it". */
  newSubproject: 'lineage.newSubproject',
  /** Re-file a project: pick a new parent, or Top Level. The keyboard (and
   *  palette) half of dragging a project row onto another one — and the only
   *  half a closed project or a collapsed parent can be reached through. */
  moveProject: 'lineage.moveProject',
  newSessionInProject: 'lineage.newSessionInProject',
  /** A session in one specific git WORKTREE of a project. What the branch
   *  chips run. Not offered in the palette: its argument is a directory that
   *  only the rendered chip row knows, and a palette entry would have to open a
   *  picker for something the tree already shows as one click. */
  newSessionInBranch: 'lineage.newSessionInBranch',
  /** Branch curation. `hideBranch` folds one branch away into "Others";
   *  `showBranches` is the picker behind that row, and the only way back. The
   *  fold pair collapses the whole block — two ids for one toggle because a
   *  contributed icon cannot change at runtime. */
  hideBranch: 'lineage.hideBranch',
  showBranches: 'lineage.showBranches',
  foldBranches: 'lineage.foldBranches',
  unfoldBranches: 'lineage.unfoldBranches',
  revealBranch: 'lineage.revealBranch',
  copyBranchName: 'lineage.copyBranchName',
  copyBranchPath: 'lineage.copyBranchPath',
  /** A scratch conversation ABOUT a project: opened at the project's rootDir
   *  with every extra directory added, and deliberately absent from the tree
   *  (see EditorialRecord.chat).
   *
   *  ALWAYS A NEW ONE. Earlier versions shipped this as one chat per project
   *  that the button re-focused or `--resume`d, which made the second question
   *  you wanted to ask an interruption of the first: the only way to have two
   *  open was to not have asked the first. A chat is the cheapest thing in the
   *  extension — no row, no parent, no name to invent — so the button mints
   *  one every time and the ones before it are reached through
   *  `chatHistory`. */
  chatInProject: 'lineage.chatInProject',
  /** The picker over a project's chats — every one it has ever had, newest
   *  first, whether still open or long finished. The chat's answer to the tree:
   *  a session has a row to click and a chat does not, so without this list a
   *  chat you closed is a conversation you can only find by id. */
  chatHistory: 'lineage.chatHistory',
  addProjectDirectory: 'lineage.addProjectDirectory',
  projectFromFolder: 'lineage.projectFromFolder',
  hideFolder: 'lineage.hideFolder',
  showHidden: 'lineage.showHidden',
  // Bulk housekeeping for a tree whose rows persist until deleted. Replaces an
  // earlier `lineage.hideStale` (hide is retired).
  deleteStale: 'lineage.deleteStale',
  // Notifications
  showNotifications: 'lineage.showNotifications',
  /** The SAME verb as showNotifications, contributed twice because a command
   *  has exactly one icon: this id carries `bell-dot` and is shown while
   *  `lineage.hasUnseen` is set; the plain one carries `bell` for the rest of
   *  the time. Their `when` clauses are complements. */
  showNotificationsUnread: 'lineage.showNotificationsUnread',
  markAllNotificationsRead: 'lineage.markAllNotificationsRead',
  /** The per-session mute, split in two. It used to be one command titled
   *  "Mute / Unmute Notifications", which is a menu entry that cannot tell you
   *  which way it is about to go — the row already knows, so the row's own
   *  context value (`;silenced;` / `;notified;`) picks the half that applies and
   *  each half SETS rather than toggles. Two ids for one setting, exactly like
   *  showNotifications/showNotificationsUnread. */
  muteSessionNotifications: 'lineage.muteSessionNotifications',
  unmuteSessionNotifications: 'lineage.unmuteSessionNotifications',
  // Project workspaces
  switchWorkspace: 'lineage.switchWorkspace',
  /** One-time opt-in: converts this window into a Flock workspace (a
   *  generated `.code-workspace` with an anchor at folder[0]) so the Explorer
   *  can be repointed in place from then on. Costs ONE window reload, here and
   *  never again — which is exactly why it is a verb the user runs rather than
   *  something the extension does to their window on activation. */
  followInExplorer: 'lineage.followInExplorer',
  /** Leave workspace mode: reopen the active project's main directory as a
   *  plain folder. Also one reload, and the door back out. */
  stopFollowingInExplorer: 'lineage.stopFollowingInExplorer',
  // The active-only filter, a view-title toggle. Two ids for one setting, for
  // the reason above: a contributed button carries one icon and one title, so
  // a switch needs one command per position.
  showOnlyActiveSessions: 'lineage.showOnlyActiveSessions',
  showAllSessions: 'lineage.showAllSessions',
  // ACCOUNTS. Ten verbs, and they live here rather than in a table of their own
  // next to the view for the reason every other id does: a test cross-checks
  // THIS object against the manifest in both directions, so a second table is a
  // set of commands nothing checks — invisible when it is missing from
  // `contributes`, "command not found" when it is missing here.
  /** Create a profile: pick a provider, name it, mint `~/.lineage/profiles/<id>`
   *  as its config dir, then offer the sign-in. */
  addAccount: 'lineage.addAccount',
  /** Open a terminal on this profile's environment so the CLI's own `/login`
   *  runs against it. The one flow that is deliberately NOT automated: the
   *  browser hand-off is Claude Code's, and wrapping it would mean holding a
   *  token this extension has no business holding. */
  loginAccount: 'lineage.loginAccount',
  removeAccount: 'lineage.removeAccount',
  /** Make this profile the machine-wide default route. */
  setDefaultAccount: 'lineage.setDefaultAccount',
  // The view's arrangement, which is also the auto-picker's final tiebreak —
  // two meanings for one number, and moving a row is how you express both.
  moveAccountUp: 'lineage.moveAccountUp',
  moveAccountDown: 'lineage.moveAccountDown',
  /** Force a usage read past the reader's own minimum interval. A person
   *  clicking Refresh is not a repaint loop. */
  refreshAccountUsage: 'lineage.refreshAccountUsage',
  /** New session on THIS account, whatever the routing says. */
  newSessionFromAccount: 'lineage.newSessionFromAccount',
  /** New session after picking the account from a list — the routed choice is
   *  offered first, with the reason it won. */
  newSessionFromPicker: 'lineage.newSessionFromPicker',
  /** Set (or clear) a project's routing override. */
  setProjectAccount: 'lineage.setProjectAccount',
} as const;
export type CommandId = (typeof COMMANDS)[keyof typeof COMMANDS];

// ------------------------------------------------------------------ config

export const CONFIG_SECTION = 'lineage';
export const CONFIG_KEYS = {
  pollIntervalMs: 'pollIntervalMs',
  claudeBinary: 'claudeBinary',
  /** Detach tier: 'auto' (wrap launches in the private tmux server when tmux
   *  is on PATH) or 'off'. */
  tmux: 'tmux',
  groupByFolder: 'groupByFolder',
  showGhosts: 'showGhosts',
  showArchived: 'showArchived',
  /** Hide every session that is over — closed, exited, or an inferred
   *  ancestor — leaving only what is still running. A FILTER, not a delete:
   *  their children are promoted the way a deleted row's are, so a live fork of
   *  a session you closed keeps its place in the tree. */
  onlyActiveSessions: 'onlyActiveSessions',
  hooksEnabled: 'hooks.enabled',
  terminalLocation: 'terminalLocation',
  /** Who OPENS a new conversation: Flock's own tmux-backed terminal, or another
   *  extension's command (see src/hosts.ts's delegate table). Only ever consulted
   *  for a NEW conversation — a fork has nothing to hand over. */
  launchMode: 'launch.mode',
  onlyProjectSessions: 'onlyProjectSessions',
  // Staleness
  showPhantomRows: 'showPhantomRows',
  viewStyle: 'viewStyle',
  /** Show a session's token count left of its age. Off by default: it is a
   *  second number on every row, and the row already carries an age and a dot. */
  showTokens: 'showTokens',
  /** Override the branch-chip palette. Empty = the built-in muted one. */
  branchColors: 'branchColors',
  /** Nest a project's sessions UNDER the branch they are running on, instead
   *  of listing the branches and then the sessions as two flat blocks. OFF by
   *  default: it re-homes every row in a project the moment it goes on, and the
   *  flat list is right for the common case of one checkout with a handful of
   *  forks in it. See viewmodel.buildViewModel. */
  groupSessionsByBranch: 'groupSessionsByBranch',
  staleAfterHours: 'staleAfterHours',
  busyStaleMinutes: 'busyStaleMinutes',
  // Notifications
  notificationsEnabled: 'notifications.enabled',
  notificationsPopup: 'notifications.popup',
  // Workspaces
  workspacesEnabled: 'workspaces.enabled',
  workspacesResumeSessions: 'workspaces.resumeSessions',
  workspacesAutoSwitch: 'workspaces.autoSwitch',
  // The Explorer follows the project
  explorerFollowProject: 'explorer.followProject',
  /** Show the Accounts view. The VERBS stay registered when this is off —
   *  turning it off means "I do not want a second list in my sidebar", not
   *  "unregister ten commands so the palette reports them missing". The
   *  manifest's view contribution matches on `config.lineage.accounts.enabled`,
   *  which is this key spelled the way a when-clause spells it. */
  accountsEnabled: 'accounts.enabled',
} as const;

/** Age past which `lineage.deleteStale` pre-selects a session. Not a filter —
 *  nothing is ever removed without the user ticking it. */
export const DEFAULT_STALE_AFTER_HOURS = 48;

/** Minutes a roster row may keep the CLI's `busy` status with a SILENT
 *  transcript before the tree stops painting it as running. `claude agents
 *  --json` can freeze a status "at whatever the session was doing when it let
 *  go" (see roster.ts), and the commonest live instance is an interactive
 *  session that finished its turn: process still up, status stuck at `busy`.
 *  A genuinely working session appends to its transcript within seconds, so
 *  minutes of silence under `busy` is the tell. See roster.destaleBusyStatus. */
export const DEFAULT_BUSY_STALE_MINUTES = 5;

// ------------------------------------------------------------------ unions

export type SessionKind = 'interactive' | 'background' | 'unknown';
export type SessionStatus = 'busy' | 'waiting' | 'idle' | 'exited' | 'unknown';
export type NodeAttention = 'none' | 'waiting';
/** How a parent edge was established, listed in the order the resolver tries
 *  them: the first source that answers wins (see the cascade in lineage.ts). */
export type ParentSource =
  | 'minted'      // we launched it: --fork-session --resume P --session-id C
  | 'reparent'    // user drag-and-drop; may set parentId null (detach)
  /** The CLI daemon's own dispatch record for a native `/fork`:
   *  `launch.fork === true` naming the parent transcript. Exact by
   *  construction — the daemon logged which session it forked — and PERSISTED
   *  (unlike the inferred sources), because the daemon roster is ephemeral and
   *  a /fork child's transcript carries no marker at all. */
  | 'daemon'
  | 'forkedFrom'  // transcript head-scan forkedFrom.sessionId
  | 'argv'        // launching process argv: --fork-session + --resume <uuid>
  | 'cli-fork'    // deep snake/camel transcript scan (double-gated)
  | 'none';       // unresolvable → flat root

// ------------------------------------------------------------------ roster

/** One row of `claude agents --json`. Fields are genuinely inconsistent in
 *  real data — ONLY sessionId is required (rows without a valid uuid
 *  sessionId are dropped at parse time). Everything else is optional. */
export interface RosterEntry {
  sessionId: string;
  pid?: number;          // absent on some background rows
  rosterId?: string;     // the roster's own short "id" field
  cwd?: string;
  kind?: SessionKind;
  startedAt?: number;    // epoch millis
  name?: string;
  status?: string;       // raw, e.g. "waiting" | "idle" — often absent
  state?: string;        // raw, e.g. "blocked" — often absent
  waitingFor?: string;   // e.g. "dialog open"
}

export interface RosterResult {
  ok: boolean;
  entries: RosterEntry[]; // [] when !ok
  error?: string;
  tookMs: number;
}

/** One transcript on disk with no live roster row: a closed session. Safe to
 *  `--resume` precisely because nothing else holds the transcript open. */
export interface ArchivedSession {
  sessionId: string;
  transcriptPath: string;
  endedAt: number;      // transcript mtimeMs — last activity
  bytes: number;
  startedAt?: number;   // first record timestamp, else birthtimeMs
  cwd?: string;         // from the head scan, never from the lossy dir name
  label?: string;       // custom-title header record
  /** The transcript's OWN head names a different session id and carries
   *  no forkedFrom marker: this file is a plain-`--resume` CONTINUATION of
   *  that session, not a fork of it. Verified against real data: every fork
   *  transcript rewrites its copied head to its own id and writes forkedFrom,
   *  so head-mismatch-without-marker is unambiguous. This is the signal that
   *  lets one logical conversation, re-minted across several session ids, be
   *  collapsed to a single row (see generations.ts). */
  continuesId?: string;
}

// ------------------------------------------------------------------ lineage results

export interface ParentResolution {
  parentId: string | null;
  source: ParentSource;
}

export interface ArgvScanResult {
  parentId: string | null;
  /** true when any inspected command line contained `--fork-session` —
   *  this is the gate that authorizes the deep transcript scan. */
  forkGateSeen: boolean;
}

export interface TranscriptHeaderMeta {
  customTitle?: string;
  agentColor?: string;
  agentName?: string;
  mode?: string;
}

export interface LineageEdge {
  childId: string;
  parentId: string;
  source: ParentSource;
}

// ------------------------------------------------------------------ model

export interface SessionNode {
  id: string;                 // the claude sessionId; also the TreeItem.id
  parentId: string | null;
  source: ParentSource;
  roster?: RosterEntry;       // absent on ghosts and archived nodes
  ghost: boolean;             // synthesized ancestor with no live roster row
  /** A real closed session read from disk. Distinct from `ghost`: a
   *  ghost is INFERRED from a child's edge and may have no transcript at all,
   *  whereas an archived node has one and is therefore resumable. */
  archived: boolean;
  archive?: ArchivedSession;  // present iff archived
  /** Muted: rendered, but sorted last among its siblings and greyed. */
  hidden: boolean;
  /** Removed from view: no row, children promoted. Nothing is deleted on disk. */
  deleted: boolean;
  status: SessionStatus;      // ghosts and archived nodes are 'exited'
  attention: NodeAttention;
  label: string;              // precedence: editorial.title > roster.name >
                              // archive.label > header.customTitle > shortId
  /** The close-with-summary text, when one was recorded. Carried on the node
   *  so the tooltip can show it — otherwise the text the user typed would be
   *  reachable only by hand-reading state.json. */
  summary?: string;
  /** The session finished a turn (`doneAt`) and the user has not looked at it
   *  since — the attention dot. Computed per build from the editorial record;
   *  `undefined` means "not tracked" (notifications off for this session, or a
   *  node kind that has no unseen state), which the renderers treat as the
   *  older, unseen-blind behaviour. */
  unseen?: boolean;
  /** This session's notifications are EXPLICITLY off (`record.notify ===
   *  false`) — the row draws a struck-through bell to say so. Only the explicit
   *  per-session mute sets it, never the global `lineage.notifications.enabled`
   *  being off: a bell on every row at once says nothing about any of them, and
   *  the thing worth marking is the one session you singled out. */
  notifyMuted?: boolean;
  cwd?: string;
  startedAt?: number;
  endedAt?: number;           // archived only: last transcript activity
  /** Populated by `buildForest` from the archive indexer's transcript-mtime
   *  sweep — the last time this session's transcript was written to, live or
   *  archived. Undefined means the session is too new for the last sweep to
   *  have covered it yet; renderers fall back to `startedAt` in that case. */
  lastActiveAt?: number;
  /** When the USER last sent this session a request, read out of the
   *  transcript tail (see usage.ts). This — not `lastActiveAt` — is what the
   *  age column means: the transcript's mtime moves for every token Claude
   *  writes and for a resume that only reopened the tab, so a session left
   *  running unattended kept reporting "now" and a conversation you had not
   *  spoken to in a day read as fresh. Undefined when no prompt is visible in
   *  the bounded tail; renderers then fall back to `lastActiveAt`. */
  lastPromptAt?: number;
  /** Tokens the last assistant turn ran with — prompt + cache + output, i.e.
   *  the size of the conversation, not a running bill. Shown only when
   *  `lineage.showTokens` is on. Undefined when the transcript has no usage
   *  record in its tail (a session that has not answered yet, a foreign row
   *  whose transcript is never deep-read). */
  tokens?: number;
  kind: SessionKind;
  children: string[];         // ALL children ids, in sibling order
  visibleChildren: string[];  // hidden/pruned-ghost promotion applied
}

export interface SessionForest {
  nodes: Map<string, SessionNode>;
  roots: string[];            // all roots, sorted
  visibleRoots: string[];     // hidden/ghost promotion applied
  edges: LineageEdge[];       // every non-null parent edge
  /** Rendered nodes with attention. A hidden (muted) node is on screen but is
   *  deliberately NOT counted: muting a session is how you tell it to stop
   *  nagging you, and a badge with no dismissable row is the worst outcome. */
  attentionCount: number;
  generatedAt: number;        // epoch ms
}

// ------------------------------------------------------------------ tree

export interface GroupNode {
  type: 'group';
  key: string;   // the cwd string, or '(unknown)' — identity, not display
  cwd: string;   // '' when unknown
  label: string; // basename(cwd) or '(no directory)'
  rootIds: string[];
}
/**
 * One checkout of a git repository — `git worktree list --porcelain`, one
 * stanza. See src/git.ts for why this is the unit that matters: somebody
 * running several agents at once gives each its own worktree, so a repository
 * is N directories on N branches and grouping by directory alone loses the fact
 * that they are one project.
 */
export interface Worktree {
  /** Absolute path to this checkout. The MAIN worktree's dir is the repo's
   *  ordinary root; a linked worktree's is wherever `git worktree add` put it. */
  dir: string;
  /** Short branch name (`refs/heads/` stripped), or '' when detached. */
  branch: string;
  /** The commit this checkout is on. Carried for the hover, not for grouping. */
  head: string;
  /** No branch at all. Kept distinct from `branch === ''` meaning "not read
   *  yet" — the two want different words on screen. */
  detached: boolean;
}

/**
 * A branch as the tree renders it: one chip under a project row.
 *
 * `colorIndex` is assigned by the grouping (see assignBranchColors) rather than
 * derived from the name, so it is stable across a repaint and distinct within a
 * project — which is the whole point of the colour. It indexes a fixed palette
 * the two renderers share; a project with more branches than the palette has
 * entries wraps, because a duplicated hue is better than a hue nobody can name.
 */
export interface BranchInfo {
  /** Short branch name, or '(detached)' for a checkout with no branch. */
  name: string;
  /** The worktree directory this branch is checked out in — where a session
   *  started from this chip will run. */
  dir: string;
  /** Index into the shared branch palette. */
  colorIndex: number;
  /** Visible root sessions of this project whose cwd is in this worktree. */
  rootIds: string[];
  /** True for the repository's main worktree (git lists it first). */
  primary: boolean;
  /** On screen, versus folded away into "Others". Computed per render from
   *  the project's curation lists and the default policy — never stored on the
   *  branch, which is a fact about git, not about the user. */
  shown: boolean;
}

/** A project row: the top level of the tree once any project exists. */
export interface ProjectGroupNode {
  type: 'project';
  projectId: string;
  label: string;           // the project's user-chosen name
  rootDir: string;
  /** rootDir first, then the extra directories, deduped. */
  dirs: string[];
  provider: ProviderId;
  rootIds: string[];       // visible root sessions living in this project
  /** The branches checked out across this project's worktrees, in chip order
   *  (main first, then alphabetical). Empty for a project that is not a git
   *  repository, or whose probe has not landed yet — both of which render as
   *  no chip row at all, the way the tree looked before branch chips existed.
   *
   *  OPTIONAL so that a node built by a caller that predates worktree awareness
   *  is still a valid node; every reader here treats absent and empty
   *  identically. */
  branches?: BranchInfo[];
  /** The user has folded this project's branch block shut. */
  branchesCollapsed?: boolean;
  /**
   * SUBPROJECTS. Where this row sits in the project tree.
   *
   * All three are OPTIONAL so that a node built by a caller that predates
   * nesting is still a valid node: every reader treats absent as "top level, no
   * children", which is exactly the tree before nesting existed.
   *
   * `depth` is the RESOLVED depth (cycles broken, unknown parents re-rooted, cap
   * applied), not a count of `parentId` hops through the raw records: the
   * renderers indent by it and must never be handed a number a broken record
   * could make up.
   */
  parentProjectId?: string | null;
  depth?: number;
  /** Child project ids, in display order (name-sorted). */
  childProjectIds?: string[];
}
export interface SessionRef {
  type: 'session';
  id: string;
}
/**
 * One branch, as a CONTAINER row in the native tree.
 *
 * Exists only under `lineage.groupSessionsByBranch`. The inline sidebar draws
 * its branch rows from the view model (which has a row kind for them and a
 * layout to go with it); the native tree has neither, so it needs a real tree
 * element to hand the workbench — one whose children are the sessions in that
 * worktree.
 *
 * Carries `rootIds` rather than looking them up, because the answer is a
 * PROJECT's (see the note on ViewRow.branch): the same directory can be a
 * worktree of one project and an ordinary subdirectory of another.
 */
export interface BranchTreeNode {
  type: 'branch';
  projectId: string;
  /** Short branch name, or the detached marker — the row's label. */
  branch: string;
  /** The worktree directory a session started here would run in. */
  dir: string;
  colorIndex: number;
  primary: boolean;
  rootIds: string[];
}
export type TreeNode =
  | GroupNode
  | ProjectGroupNode
  | BranchTreeNode
  | SessionRef;

/** contextValue = ';' + tokens.join(';') + ';' so `when` clauses can match
 *  with viewItem =~ /;token;/ and never false-positive on substrings. */
export type ContextToken =
  | 'session' | 'group' | 'project' | 'ghost' | 'live' | 'exited' | 'archived'
  | 'waiting' | 'busy' | 'idle' | 'ours' | 'bound' | 'root' | 'forked'
  | 'empty'
  /** Visibility pair, always exactly one of the two on a session row.
   *  Complementary tokens rather than a negated `when` clause: the manifest only
   *  ever negates plain context keys (`!lineage.hooksInstalled`), and
   *  `!(viewItem =~ /…/)` would lean on parenthesised negation in the
   *  when-clause parser for no benefit. */
  | 'hidden'
  | 'shown'
  /** Notification pair, always exactly one of the two on a session row, for
   *  the same reason as the pair above: the mute verb is two complementary menu
   *  entries and each needs a positive clause to match on. Deliberately not
   *  'muted' — that word already means "put away and greyed" everywhere else in
   *  this codebase, and a token that reads as one thing in a `when` clause and
   *  another in the renderer is a trap. */
  | 'silenced'
  | 'notified'
  /** OWNERSHIP pair, always exactly one of the two on a LIVE session row, for
   *  the same reason as the two pairs above. `hosted` means Flock can honestly
   *  end this session — its tab is here, another Flock window has it, or a
   *  workspace switch parked it — and is what the Close verbs match on.
   *  `foreign` means the process belongs to something else (a terminal, the
   *  Claude Code extension, another app), where a close could only write a
   *  timestamp onto a conversation that carries on running. See src/hosts.ts. */
  | 'hosted'
  | 'foreign'
  /** One branch row under a project. Its own token rather than reusing
   *  'project': the two rows carry the same projectId and would otherwise match
   *  each other's `when` clauses, putting the project's whole context menu —
   *  rename, add directory, hide — on a row none of those verbs apply to. */
  | 'branch'
  /** The repository's MAIN worktree. A second token on a branch row, never
   *  alone, and used for exactly one thing: Hide Branch is withheld from it. A
   *  block whose primary branch can be hidden is a block you can empty by
   *  accident and then have to go find the picker to repair. */
  | 'primary'
  /** The "Others (N)" tail row. Distinct from 'branch' because none of the
   *  branch verbs apply — there is no single worktree behind it. */
  | 'branchOthers'
  /** A project row that is filed under another project. A SECOND token on the
   *  row, never alone, so `viewItem =~ /;project;/` keeps matching every
   *  project row while a verb that only makes sense on a nested one (Move to
   *  Top Level) can single it out positively — the manifest never negates a
   *  viewItem regex; see the visibility-pair note above. */
  | 'subproject'
  /** A project row with children under it. Its own token because the two
   *  facts are independent: a middle project is both, a leaf under a root is
   *  only `subproject`, and a root with children is only this. */
  | 'parentProject'
  /** A row in the Accounts view, and — as a SECOND token on the same row — the
   *  one of them the default routing names. Two tokens rather than two values
   *  of one, so that `viewItem =~ /;account;/` keeps matching every row while a
   *  verb that belongs only on the default one can single it out positively
   *  (the manifest never negates a viewItem regex; see the visibility-pair note
   *  above). No contributed verb needs it yet — the row's own ★ is what the
   *  user reads — but the row is where the fact lives, and inventing the token
   *  later would mean changing a contextValue every `when` clause matches. */
  | 'account'
  | 'default';
export function contextValueOf(tokens: ContextToken[]): string {
  return ';' + tokens.join(';') + ';';
}

// ------------------------------------------------------------------ persisted state

export interface EditorialRecord {
  id: string;                    // sessionId
  parentId?: string | null;      // exact recorded edge (minted / reparent)
  parentSource?: ParentSource;   // only 'minted' | 'reparent' are persisted
  title?: string;                // user rename; wins over roster name
  summary?: string;              // close-with-summary text
  closed?: string | null;        // ISO timestamp
  /** RETIRED. The old hide verb is gone: tree membership is editorial and
   *  DELETE is the one put-away verb. sanitizeRecord reads a persisted
   *  `hidden: true` (written by older versions) as `deleted: true` and drops
   *  the field, so no record ever carries it past a load. The field stays typed
   *  because SessionNode.hidden and its rendering (greyed, sorted last) are
   *  still exercised directly by tests and tolerated on foreign state files
   *  written by older windows. */
  hidden?: boolean;
  /** REMOVED FROM VIEW. No row at all; children are promoted to the nearest
   *  visible ancestor. Nothing on disk is touched — the transcript survives and
   *  `restoreSession` brings the row back — so this is a view-level delete, not
   *  a data delete. It is now the ONLY way a session with an editorial record
   *  leaves the tree: closing its tab merely flips the row to inactive
   *  (archived). */
  deleted?: boolean;
  launchedByUs?: boolean;
  boundWindowId?: string | null; // window whose terminal hosts this session
  wrapRequestedAt?: string;      // ISO; set by the wrap verb
  cwd?: string;
  /** Per-session override of the provider glyph. Normally unset — the
   *  provider comes from the owning project, else DEFAULT_PROVIDER. */
  provider?: ProviderId;
  /** THE PIN: the AccountProfile.id this conversation was launched on,
   *  written once at launch and never rewritten.
   *
   *  A session belongs to the account that started it for life. Every resume,
   *  re-attach and workspace restore re-injects THAT profile's env, because a
   *  conversation's transcript lives inside one account's config directory and
   *  a resume under a different account would either fail to find it or,
   *  worse, bill the wrong subscription for the same thread. Changing the
   *  routing config never re-routes an existing conversation — routing decides
   *  what a NEW session gets, and nothing else.
   *
   *  Inherited, not re-decided: a fork carries its parent's pin, and a new
   *  generation of a chain carries the chain's (see
   *  StateStore.getSessionProfile). Absent means "launched before accounts
   *  existed, or launched on the default login" — both of which resolve to an
   *  empty env, which is exactly what those sessions already ran with. */
  profileId?: string;
  // ---- notifications ------------------------------------------------------
  /** ISO. When the session last FINISHED a turn (busy → waiting/idle observed
   *  on the roster, or a Stop hook event). The "there is something new here"
   *  half of the unseen pair. */
  doneAt?: string;
  /** ISO. When the user last LOOKED at the session (its terminal became the
   *  active one here, a bell row was opened, mark-all-read). `seenAt >= doneAt`
   *  is what puts the attention dot out. */
  seenAt?: string;
  /** Per-session notifications override. `false` mutes this session: no
   *  attention dot, no bell entry, no toast. Unset = follow
   *  `lineage.notifications.enabled`. Inherited across a generation chain —
   *  muting names the conversation, not one physical id. */
  notify?: boolean;
  /** ISO. The user took this session off the bell's list with the row's ×.
   *  Scoped to that FINISH, not to the session: a row is suppressed only while
   *  `doneAt <= notifyDismissedAt`, so the next turn this session completes
   *  brings it straight back. "I have dealt with this one" — permanently
   *  silencing a session is what `notify: false` is for, and conflating the two
   *  would make a one-click × the most destructive control in the popup. */
  notifyDismissedAt?: string;
  // ---- workspaces ---------------------------------------------------------
  /** Put away by a WORKSPACE SWITCH: its terminal was closed — the claude
   *  process ended; the conversation lives on in its transcript — to clear
   *  the window for another project, and switching back RESUMES it
   *  (`--resume`, chain-tip routed). The terminal panel is never involved:
   *  an older build stowed parked sessions into it instead, and a still-live
   *  one from those days is moved home as a one-shot migration. The row
   *  renders normally — parking is bookkeeping, not a user verb, so it must
   *  not grey anything. Membership needs no special case: any non-deleted
   *  record survives the `showArchived` gate. */
  parked?: boolean;
  /** DETACH-tier parking (see src/tmux.ts). The private tmux session
   *  (`tmux -L lineage …`) this conversation was detached into when a switch
   *  parked it: the terminal — only the tmux CLIENT — was disposed and the
   *  claude process kept running, invisible. Written at park time next to
   *  `parked`; kill-tier parks write `null` instead so a stale name can never
   *  survive a park that really killed. Cleared (null) when a restore
   *  re-attaches. While set, ANY resume of this conversation must go through
   *  `new-session -A` under this name — a plain `--resume` would start a
   *  second claude beside the one still running. */
  tmux?: string | null;
  // ---- project chat -------------------------------------------------------
  /** This session is a project CHAT — a scratch conversation about the project
   *  — and therefore has no row in the tree at all. Persisted rather than kept
   *  in a per-window Set because the roster is machine-wide: every other VS
   *  Code window scans the same `~/.claude/projects` transcripts, so an
   *  in-memory flag would suppress the row here and leave it showing
   *  everywhere else. Inherited across a generation chain — being a chat names
   *  the conversation, not one physical id, so a `--resume` that mints a fresh
   *  generation must stay a chat.
   *
   *  There are MANY of these per project, and they are listed by the
   *  chat-history picker, which is the only place a chat is enumerated. That
   *  list is derived exactly the way every other membership question is
   *  answered — the project owning `cwd` (projects.chatsForProject) — and NOT
   *  from a list held on the project: a per-window array on one record would
   *  lose entries to the newest-wins merge the moment two windows opened a
   *  chat in the same project, whereas a flag on the chat's OWN record has a
   *  single writer, once, at birth. */
  chat?: boolean;
  createdAt: string;             // ISO
  updatedAt: string;             // ISO; record-level merge key (newest wins)
}

export interface FocusHandle {
  /** Opaque toString() of an asExternalUri result. Never parsed for meaning,
   *  never cached across window sessions; re-published on every activate. */
  uri: string;
}

export interface WindowRecord {
  windowId: string;      // random uuid minted per activation
  focusHandle: FocusHandle;
  folder?: string;       // first workspace folder fsPath, if any
  pid: number;           // extension-host pid, used to prune dead windows
  publishedAt: string;   // ISO
}

export interface HookInstallState {
  installed: boolean;
  pluginDir?: string;
  installedAt?: string;  // ISO
  pluginVersion?: number;
}

/**
 * One GENERATION CHAIN: a single logical conversation whose id was re-minted
 * one or more times (plain `--resume`, `/clear`, compaction). The
 * key of the `chains` map is `rootId` — the first generation's id, which is
 * the stable identity of the conversation. `members` is every session id the
 * conversation has worn, oldest first, ROOT INCLUDED. The chain says nothing
 * about which member is current: the tip is picked live at build time
 * (roster presence, then transcript mtime), because "which id is newest" is
 * an observation, not an editorial fact.
 *
 * Written from two sources, both exact: a hook event whose inherited
 * LINEAGE_NODE_ID differs from its session_id (the terminal we launched is
 * now running a new generation — the re-key), and the transcript
 * continuation signal (ArchivedSession.continuesId). Never inferred from
 * anything weaker.
 */
export interface ChainRecord {
  rootId: string;
  members: string[];     // oldest → newest, includes rootId
  createdAt: string;     // ISO
  updatedAt: string;     // ISO; record-level merge key (members are unioned)
}

/**
 * One remembered editor tab inside a project's workspace snapshot.
 *
 *   file    — a text/notebook/custom editor; `uri` is its Uri.toString().
 *   session — one of OUR session terminals; identified by session id, so the
 *             restore path can `--resume` it even though the original process
 *             (and its tab) are long gone.
 *
 * Webview tabs (Simple Browser and friends) are knowingly NOT captured: the
 * tab API exposes their viewType but not their content URL, so a faithful
 * restore is impossible and a blank browser tab would be worse than none.
 */
export interface WorkspaceTabRecord {
  kind: 'file' | 'session';
  uri?: string;        // kind 'file'
  sessionId?: string;  // kind 'session'
  viewColumn: number;  // 1-based editor group
  active?: boolean;    // the focused tab at capture time
  pinned?: boolean;
}

/** A project's saved window layout: what was open while working on it.
 *  Keyed by project id in `LineageState.workspaces`; merged newest-wins on
 *  `updatedAt` like every other record — the layout is one value, not a set. */
export interface WorkspaceSnapshot {
  projectId: string;
  tabs: WorkspaceTabRecord[];
  savedAt: string;   // ISO
  updatedAt: string; // ISO; record-level merge key
}

/** The persisted globalStorage blob: <globalStorageUri>/state.json. */
export interface LineageState {
  version: number; // STATE_SCHEMA_VERSION
  records: Record<string, EditorialRecord>;
  windows: Record<string, WindowRecord>;
  /** v2. Keyed by project id. */
  projects: Record<string, ProjectRecord>;
  /** v2. Keyed by normalized directory path. */
  hiddenFolders: Record<string, HiddenFolder>;
  /** v3. Keyed by chain root id. */
  chains: Record<string, ChainRecord>;
  /** v4. Keyed by project id. */
  workspaces: Record<string, WorkspaceSnapshot>;
  /** v5. Keyed by account id.
   *
   *  OPTIONAL where `projects` and `workspaces` are required, and deliberately
   *  so: every literal that builds a LineageState by hand (the store's own
   *  emptyState, the merge tests) predates accounts and would stop compiling if
   *  these were required. `migrateState` materialises both v5 maps on every
   *  load, so nothing at runtime ever sees them missing — the optionality buys
   *  source compatibility, not a second code path. Readers still spell it
   *  `state.accounts ?? {}`, which is what state.ts does for every map. */
  accounts?: Record<string, AccountProfile>;
  /** v5. The singleton settings record — one value, merged newest-wins as a
   *  whole. See AccountSettings. */
  accountSettings?: AccountSettings;
  hookInstall?: HookInstallState;
}

// ------------------------------------------------------------------ hooks

export interface HookEvent {
  event: string | null;          // hook_event_name
  sessionId: string | null;      // session_id
  transcriptPath: string | null; // transcript_path
  /** The LINEAGE_NODE_ID the hook process inherited from its terminal —
   *  i.e. which of OUR launches this event fired inside — or null for a
   *  session we did not launch (or a v2 hook that logged no env). When this
   *  differs from sessionId, the terminal we stamped is now running a NEW
   *  generation of the same conversation: the exact re-key signal. */
  nodeId: string | null;
  /** SessionStart's `source` field: 'startup' | 'resume' | 'clear' |
   *  'compact' | 'fork'. The one that matters is 'fork' — a node-id mismatch
   *  on a FORK is a new branch, not a re-key, and chaining it would collapse
   *  the parent into its own fork. */
  source: string | null;
  raw: unknown;
}

// ------------------------------------------------------------------ terminals

export interface LaunchOptions {
  sessionId: string;   // pre-minted uuid (crypto.randomUUID())
  parentId?: string;   // when set: --fork-session --resume <parentId>
  /** Reopen an existing closed session: `--resume <resumeId>`. No
   *  `--session-id` is passed and `sessionId` MUST equal `resumeId`. NOTE:
   *  despite `--fork-session` existing as a separate flag, a plain `--resume`
   *  does NOT reliably keep the id — the CLI can mint a fresh generation that
   *  copies the old transcript (verified on real data). The
   *  LINEAGE_NODE_ID stamp still names `resumeId`, which is exactly what lets
   *  the hook re-key (state.appendChainMember) and the transcript
   *  continuation signal fold the new id back onto this conversation.
   *  Mutually exclusive with `parentId`. */
  resumeId?: string;
  cwd?: string;
  prompt?: string;     // appended as the final positional argument
  title?: string;      // terminal name; default `claude · ${shortId}`
  /** Editor group to open the terminal tab in (1-based), used by the workspace
   *  restore path so a session tab reopens where it was. Ignored when the
   *  terminal location preference is `panel`. */
  viewColumn?: number;
  /** Reveal the terminal without stealing keyboard focus. The workspace
   *  restore path sets this: a switch is a side effect of where the user is
   *  already typing, and a resumed background session must not take the
   *  keyboard mid-word. */
  preserveFocus?: boolean;
  /** Extra directories the CLI may read outside `cwd` (`--add-dir`). The
   *  project chat passes the project's extra dirs so one conversation covers a
   *  multi-directory project. */
  addDirs?: string[];
  /** Text appended to the CLI's system prompt (`--append-system-prompt`). Used
   *  to tell a project chat what project it is about and that the window is a
   *  scratch one. */
  appendSystemPrompt?: string;
  /** The CLI-side conversation name (`--name`), which is what shows up in
   *  `claude --resume`'s picker. Distinct from `title`, which only names the
   *  VS Code terminal tab. */
  sessionName?: string;
  /** This launch is a project chat. Only affects presentation — the tab
   *  gets the chat icon and colour so it reads as different from the session
   *  tabs beside it. The membership consequences ride on the persisted
   *  EditorialRecord.chat, not on this. */
  chat?: boolean;
  /** Environment for this launch, resolved from the chosen account
   *  (accounts.envForProfile). `{}` — the default account — is the common case
   *  and must behave exactly as no env at all did.
   *
   *  It has to reach the child process by BOTH routes, because a launch can
   *  take either: merged into the terminal's `creationOptions.env` for a bare
   *  launch, and passed as `-e KEY=VALUE` to the tmux wrap for a detachable
   *  one. A wrapped launch that only set the terminal's env would hand the
   *  variables to the tmux CLIENT and leave the claude process inside the
   *  server running on whatever the tmux SERVER was started with — i.e. on
   *  whichever account happened to open the first wrapped session after a
   *  reboot. That is the failure this field exists to prevent.
   *
   *  SECRET-BEARING on API-key profiles: never log the values, never put them
   *  in a terminal title, an error message or a tooltip. */
  env?: Readonly<Record<string, string>>;
  /** The AccountProfile.id this launch resolved to, recorded on the
   *  session's editorial record so the conversation stays pinned to it (see
   *  EditorialRecord.profileId). Carried alongside `env` rather than derived
   *  from it: an account whose env is `{}` is still a specific account, and
   *  the pin has to survive that. */
  profileId?: string;
  /** Detach tier (src/tmux.ts). Wrap this launch in the private tmux server
   *  under THIS session name instead of the one derived from `sessionId`.
   *  The restore/resume paths pass the name recorded at park time, so the
   *  wrap's `new-session -A` RE-ATTACHES the still-running detached process
   *  — its `--resume` argv only runs if it died while parked. Ignored when
   *  tmux is off or absent. */
  tmuxName?: string;
}

export interface TerminalBinding {
  nodeId: string;      // == sessionId in this design
  sessionId: string;
  terminalName: string;
  pid?: number;
  createdAt: number;   // epoch ms
  /** Detach tier: the tmux session backing this terminal, when the launch was
   *  wrapped. Recovered from creationOptions on re-association, so a window
   *  reload does not downgrade the session's next park from detach to kill.
   *  NOTE: with a wrap, `pid` above is the tmux CLIENT's pid, not claude's —
   *  which is why roster-pid re-association simply never matches a wrapped
   *  terminal (the env-stamp path is what rebinds those). */
  tmuxName?: string;
}

// ------------------------------------------------------------------ misc plumbing

export interface DisposableLike {
  dispose(): void;
}

// ---------------------------------------------------- dependency interfaces
// Cross-layer calls go through these; extension.ts implements/wires them.

export interface TreeDeps {
  getForest(): SessionForest;
  onDidChangeData(listener: () => void): DisposableLike;
  /** true when a terminal for this session is bound in THIS window. */
  isBoundHere(sessionId: string): boolean;
  /** WHO is running this session — see src/hosts.ts. Feeds the ownership token
   *  pair the Close verbs match on, the row's `elsewhere` marker and one hover
   *  line. Optional so an older wiring (and every unit double) keeps working:
   *  absent reads as 'hosted', which is exactly the tree before ownership. The
   *  return type is left loose here because types.ts may not import a module
   *  that imports it back. */
  hostOf?(sessionId: string): 'here' | 'flock' | 'foreign' | 'none';
  /** Persist a drag-reparent (parentSource 'reparent'); null = detach. */
  reparent(childId: string, newParentId: string | null): Promise<void>;
  groupByFolder(): boolean;
  // ---- projects, visibility and selection -----------------------------
  /** EVERY project, hidden ones included, name-sorted. `computeGrouping` does
   *  its own visible/hidden split and has to see the hidden ones: a hidden
   *  project still OWNS its directories, and filtering them out here would
   *  demote its sessions to folder rows instead of hiding them. */
  projects(): ProjectRecord[];
  /** Normalized paths the user removed from view. */
  hiddenFolders(): string[];
  /** Only show sessions that belong to a project (config). */
  onlyProjectSessions(): boolean;
  /** The view's session selection changed: these ids, in display order.
   *
   *  Reported UP rather than read down, because only the view knows it — the
   *  webview holds its own selection in the page, the native tree holds its own
   *  in the workbench — and both have to arrive in one place, since a command
   *  invoked from a row's context menu is handed that row and nothing else.
   *  extension.ts owns the answer and the `lineage.multiSelect` context key that
   *  follows from it, the same way it owns every other context key.
   *
   *  Optional so an older wiring (and the unit doubles) keeps working; absent
   *  means the view simply never reports one, and every verb stays single-row. */
  noteSelection?(sessionIds: string[]): void;
  /** `lineage.onlyActiveSessions`. The views do not FILTER on this — that
   *  happens once, in buildForest — they only need to know whether an empty
   *  tree means "nothing here" or "nothing here that is still running", which
   *  are different sentences. Optional so an older wiring (and the unit
   *  doubles) keeps working; absent means off. */
  onlyActiveSessions?(): boolean;
  /** Provider glyph for one session: record override > project > default. */
  providerFor(sessionId: string): ProviderId;
  /** Absolute fs path of a file inside the extension install, or undefined
   *  when the host does not expose one (the unit-test mock). Kept as a plain
   *  string so this file never has to know about vscode.Uri. */
  mediaPath(relative: string): string | undefined;
  /** Move a session's cwd into a project by DnD onto a project row. */
  assignToProject(sessionId: string, projectId: string): Promise<void>;
  /** `lineage.showTokens`: put a session's context size left of its age.
   *  Optional so an older wiring (and the unit doubles) keeps working — absent
   *  means off, which is also the setting's default. */
  showTokens?(): boolean;
  // ---- git worktrees and branch chips ---------------------------------
  /** The git worktrees visible from `dir`, from a cache that answers instantly
   *  and refreshes in the background (src/git.ts). Called on the render path,
   *  so it MUST NOT block; [] means "not a repository" and "not probed yet"
   *  alike, and both render as no chip row. Optional for the same reason as the
   *  two above — a wiring without it produces the tree as it looked before
   *  branch chips existed. */
  worktreesOf?(dir: string): readonly Worktree[];
  /** `lineage.branchColors` — a user palette for the branch chips. Entries are
   *  positional (index 0 is the first branch's colour); a short list fills from
   *  the built-in one, and every entry is re-validated before it reaches the
   *  page (see sanitizeBranchColor — the value lands in an inline style block).
   *  Absent or empty means the built-in muted palette. */
  branchColors?(): readonly string[];
  // ---- branch grouping and project nesting ----------------------------
  /** `lineage.groupSessionsByBranch`: nest a project's sessions under the
   *  branch row for the worktree they run in, instead of listing branches and
   *  sessions as two flat blocks. Optional for the same reason as the three
   *  above — absent means off, which is also the setting's default. */
  groupSessionsByBranch?(): boolean;
  /** Persist a project's new parent (null = move to top level). The drop
   *  half of dragging one project row onto another; `reparent` above is the
   *  SESSION verb and the two must never be confused, because a project id and
   *  a session id are both bare uuids. Optional so an older wiring (and the
   *  unit doubles) simply refuses the gesture rather than throwing. */
  reparentProject?(projectId: string, newParentId: string | null): Promise<void>;
}

export interface DecorationDeps {
  getForest(): SessionForest;
  onDidChangeData(listener: () => void): DisposableLike;
  /** Project ids that currently contain an unseen-done session, for the
   *  attention dot on the project row. Optional so older wirings (and the unit
   *  doubles) keep working; absent means "no project dots". */
  projectsWithUnseen?(): ReadonlySet<string>;
}

export interface TerminalDeps {
  /** Resolved claude binary (config override or PATH scan), or null. */
  claudeBinary(): string | null;
  /** Where a launched terminal goes. Absent = 'editor'. */
  terminalLocation?(): TerminalLocationPref;
  /** Detach tier (src/tmux.ts): how to wrap a launch in the private tmux
   *  server, or null to launch claude bare. Re-read per launch so installing
   *  tmux or flipping `lineage.tmux` needs no reload. Absent = never wrap. */
  tmux?(): TmuxSpawn | null;
  /** Detach tier: CLAUDE's real pid inside the named wrapped session (the
   *  pane's root process). A wrapped terminal's own pid is the tmux CLIENT's
   *  and matches nothing on the roster, so the registry swaps in this one —
   *  it is what keeps the re-key detector and app-restart re-association
   *  working for wrapped sessions. Absent (the unit doubles) = wrapped
   *  bindings simply carry no pid, degrading those two mechanisms only. */
  tmuxPanePid?(name: string): Promise<number | undefined>;
  /** Detach tier: which wrapped session each live tmux CLIENT pid shows
   *  (`list-clients`). The app-RESTART re-association path for wrapped
   *  terminals — a revived one carries no env stamp and its pid is the
   *  client's, so neither existing rebind mechanism can identify it; the
   *  tmux server can, exactly. Absent = wrapped terminals stay unbound after
   *  a full restart (the pre-fix behaviour). */
  tmuxClientSessions?(): Promise<ReadonlyMap<number, string>>;
  /** Detach tier: END the named wrapped session — the claude process dies,
   *  not just the client. Called when the USER closes a session's tab (the
   *  sidebar contract: closing a tab closes the session; the row goes
   *  inactive), never by workspace parking, which detaches. Absent = a
   *  user-closed wrapped session keeps running hidden. */
  tmuxKillSession?(name: string): Promise<boolean>;
}

/** Detach tier (src/tmux.ts). How to wrap a session launch in the private
 *  tmux server: the resolved binary, plus the conf that makes tmux invisible
 *  (no status bar, no prefix key). `confPath` is optional because writing the
 *  conf can fail, and a launch without it must still work — it merely looks
 *  like tmux. */
export interface TmuxSpawn {
  binary: string;
  confPath?: string;
}

export interface WindowDeps {
  publishWindow(rec: WindowRecord): Promise<void>;
  /** Called when our UriHandler receives /focus; sessionId from the query. */
  onFocusRequest(sessionId: string | null): void;
}

export interface HookDeps {
  getStored(): HookInstallState;
  setStored(s: HookInstallState): Promise<void>;
}

/**
 * How anything that wants rate-limit numbers asks for them.
 *
 * A dependency interface rather than a direct import for the usual reason —
 * the accounts VIEW is vscode-facing and the limits module is not, and neither
 * may import the other — but also because this is the one seam in the feature
 * that touches the network and reads a credential store. Everything downstream
 * of it (the auto-picker in routing.ts, the meters in the view) takes plain
 * numbers, which is what keeps the scoring rules unit-testable without a
 * network, a keychain, or a live account.
 *
 * `null` means "no answer for this profile" and is a perfectly normal result:
 * an account that has never been logged in has no credentials to read, and the
 * picker treats it as unknown rather than as broken.
 */
export interface LimitsReader {
  /** Fetch (or serve from cache) this account's windows. Must never throw —
   *  a failure is a snapshot with `error` set, or `null`.
   *
   *  `force` steps over the reader's own minimum interval and backoff. It is
   *  part of the interface rather than a detail of one implementation because
   *  the manual refresh verb is meaningless without it: the reader MUST rate-
   *  limit itself (a repaint asks for every row at once) and a Refresh button
   *  that silently returns the cache is a button that lies. A reader with no
   *  such notion may ignore the flag. */
  readUsage(
    profile: AccountProfile,
    options?: { force?: boolean },
  ): Promise<UsageSnapshot | null>;
  /** The last snapshot for this profile WITHOUT going anywhere, for render
   *  paths that cannot await. Optional; absent means the caller keeps its own
   *  map of whatever `readUsage` last resolved to. */
  cached?(profile: AccountProfile): UsageSnapshot | null;
  /** Fires when any cached snapshot changed, so a view can repaint instead of
   *  polling. Optional for the same reason as `cached`. */
  onDidChange?(listener: () => void): DisposableLike;
}

/**
 * What a conversation's transcript says about itself, for the one list that
 * cannot ask the forest: the chat-history picker.
 *
 * A chat has no row, which is the whole point of it — so `getForest()` knows
 * nothing about one, and the editorial record's own timestamps only move when
 * WE write it (at birth, at park, at seen). Ordering a history list on those
 * would put a chat you have been talking to all afternoon below one you opened
 * and abandoned in the morning.
 *
 * Both fields are best-effort and both may be absent: the transcript may not
 * exist yet (a chat that has not been spoken to), the head may hold nothing but
 * the CLI's own preamble, and neither read is allowed to fail loudly.
 */
export interface TranscriptFacts {
  /** Epoch ms of the transcript's last write. */
  lastActiveAt?: number;
  /** The first thing the PERSON typed, as the picker's label. */
  firstPrompt?: string;
}

/**
 * What repairResumeLeaf did, or why it did nothing. See resumeLeaf.ts — the
 * short version is that claude picks the message a resume walks back from out
 * of the transcript's `last-prompt` records, those records are written mid-turn
 * and never corrected, and so a fork can inherit its parent's final turn only
 * as far as its first tool call.
 *
 * Every field is diagnostic: the launch path logs the report and proceeds
 * either way, because a skip leaves the transcript exactly as claude wrote it.
 */
export interface ResumeLeafReport {
  /** A corrective `last-prompt` record was appended. */
  repaired: boolean;
  /** The uuid the CLI would have resumed from, when the transcript named one. */
  staleLeaf?: string;
  /** The uuid now named as the leaf. */
  tip?: string;
  /** How many more records the walk reaches from `tip` than from `staleLeaf`. */
  gained?: number;
  /** Why nothing was written. Absent when `repaired`. */
  skipped?:
    | 'no-transcript'
    | 'unreadable'
    | 'too-large'
    | 'writing'
    | 'cleared'
    | 'no-leaf-record'
    | 'already-tip'
    | 'no-tip'
    | 'no-gain'
    | 'write-failed';
}

/**
 * A `/fork` that dispatched a BACKGROUND job rather than taking over a
 * terminal: the process is live and holding the child session id, but no pty
 * belongs to any editor — which is why focusing one used to dead-end at
 * "Flock cannot adopt a tab from" on a branch the user had just asked for.
 * Read by daemon.ts out of `<configDir>/jobs/<short>/state.json`, the CLI's
 * own bookkeeping.
 */
export interface BackgroundJob {
  /** The job's session id — the fork CHILD. */
  sessionId: string;
  /** `forkParentSessionId`. Absent on a background job that is not a fork. */
  parentId?: string;
  /** The CLI's own name for the job, seeded from the parent's title. */
  name?: string;
  cwd?: string;
  /** `<configDir>` the job lives under — the account it runs on. */
  configDir: string;
  /** The job directory's name; also the roster's `dispatch.short`. */
  short: string;
  /** `firstTerminalAt !== null` — a terminal has attached at least once, so
   *  the job is somebody's and adopting it would be a second writer. Verified
   *  across all 29 job states on the build machine: every job that reached
   *  `done`/`failed`/`stopped` carries one, and the jobs that never got a
   *  terminal — including a live `/fork` still parked on "send a prompt to
   *  start" — carry `null`. */
  attached: boolean;
  /** The job's `state` is one the CLI runs in (`working`, `blocked`) rather
   *  than one it has finished in (`done`, `failed`, `stopped`).
   *
   *  An ALLOW-list, deliberately: a stale roster row outlives the process that
   *  wrote it, so without this a finished job would keep looking adoptable and
   *  relaunching it would resurrect a conversation the user had ended. An
   *  unrecognised state reads as not-live, which costs the adopt path and
   *  falls back to never adopting — the safe direction to be wrong in. */
  live: boolean;
}

export interface CommandDeps {
  // model
  getForest(): SessionForest;
  refresh(): void;
  hasTranscript(sessionId: string): boolean;
  /** The background job holding this id, when one does. A native `/fork`
   *  dispatches such a job: live process, no pty any editor owns. Optional —
   *  a wiring without it (and every unit double) simply never offers to adopt
   *  one. */
  backgroundJob?(sessionId: string): BackgroundJob | undefined;
  /** Detach tier: is `name` a session the private tmux server still holds?
   *
   *  A record only names a wrap that a workspace switch PARKED, but the launch
   *  wraps everything it starts — so a session that was launched, bound to a
   *  tab and never parked has a live wrap nothing recorded, and it becomes
   *  unreachable the moment its window goes away. The name is derivable, so
   *  this probe is all that is needed to find one. Ground truth, which is also
   *  what keeps it safe beside a kill-tier park: a killed wrap does not answer.
   *
   *  Optional — a wiring without it (and every unit double) falls back to
   *  recorded names only, which is the pre-probe behaviour. */
  tmuxSessionLive?(name: string): Promise<boolean>;
  /** Bounded, cached facts read off one transcript — see TranscriptFacts.
   *  Optional: a wiring without it (and every unit double) gets a chat history
   *  ordered and labelled from the editorial records alone, which is coarser
   *  but never wrong. */
  transcriptFacts?(sessionId: string): TranscriptFacts;
  /** Point the transcript's recorded resume leaf at its actual tip, so a
   *  `--resume` / `--fork-session` sees the whole conversation — see
   *  resumeLeaf.ts for the claude-side selection this compensates for.
   *
   *  Optional, and every unit double omits it: absent means the launch behaves
   *  exactly as it did before the module existed, which is a fork that can
   *  silently inherit the parent's last turn only up to its first tool call. */
  repairResumeLeaf?(sessionId: string): ResumeLeafReport;
  /** Is this id on the roster right now?
   *
   *  `getForest()` answers this for anything with a row, which is why nothing
   *  needed it before — and precisely why the chat history does: a chat is
   *  filtered out of the forest by construction, so the one list that shows
   *  chats is the one list that cannot ask. Optional; absent means the picker
   *  marks nothing as open, which costs a dot and no correctness (the reopen
   *  path checks for a bound terminal either way). */
  isLive?(sessionId: string): boolean;
  /** WHO is running this session — see src/hosts.ts. Consulted by the verbs
   *  that would otherwise LIE about a session Flock does not own: Close writes
   *  a `closed` timestamp onto a conversation it cannot stop, and Wrap needs a
   *  terminal to type into.
   *
   *  Optional, and every unit double omits it: absent means those verbs behave
   *  exactly as they did before ownership existed, which is "act, then warn".
   *  The return type is loose for the same reason as TreeDeps.hostOf — types.ts
   *  may not import a module that imports it back. */
  hostOf?(sessionId: string): 'here' | 'flock' | 'foreign' | 'none';
  /** Reveal an integrated terminal that is PLAUSIBLY already running this
   *  session, without touching it — see src/terminalMatch.ts for how a terminal
   *  Flock never created is identified, and why the match declines whenever it
   *  is not certain. True when a terminal was revealed.
   *
   *  Optional: absent means the focus verb falls straight through to the
   *  fork-a-copy dialog, which is what it did before. */
  revealHostTerminal?(sessionId: string): Promise<boolean>;
  /** The CURRENT generation of the conversation this id belongs to —
   *  identity when the id is not part of a chain. Every verb that resumes or
   *  forks routes its target through this, so a click on a row that has been
   *  superseded mid-tick still acts on the newest state, never an older
   *  generation. */
  tipOf(sessionId: string): string;
  /** Start an inline rename on the row, returning false when there is no
   *  inline view to do it in (the native tree is selected, or the panel is
   *  closed) — the caller then falls back to the quick-input rename. */
  beginInlineRename(sessionId?: string): Promise<boolean>;
  /** The same handover for a PROJECT row. A separate method rather than a
   *  widened `beginInlineRename`, permanently: session ids and project ids are
   *  both bare uuids and share no discriminator, so a single method would have
   *  to guess which id space it was handed and would guess wrong half the time.
   *  Returns false when there is no inline view, exactly as the session one. */
  beginInlineRenameProject(projectId: string): Promise<boolean>;
  /** Select the session's row in the tree, waiting for it to appear first — a
   *  just-launched session is not in the forest until `claude agents --json`
   *  reports it, which is a roster tick away. Resolves either way; never
   *  throws, and never steals keyboard focus from the terminal. */
  revealSession(sessionId: string): Promise<void>;
  /** Select the project's row. No ancestor walk is needed — a project row is
   *  always at depth 0 — so this is the select half of `revealSession` alone. */
  revealProject(projectId: string): Promise<void>;
  // state (B)
  getRecord(id: string): EditorialRecord | undefined;
  allRecords(): Record<string, EditorialRecord>;
  upsertRecord(id: string, patch: Partial<EditorialRecord>): Promise<void>;
  recordLaunch(
    childId: string, parentId: string | null, cwd?: string,
  ): Promise<void>;
  // terminals (D)
  launchSession(opts: LaunchOptions): Promise<TerminalBinding | null>;
  /** `lineage.launch.mode`: hand a NEW conversation to another extension instead
   *  of opening a terminal here, and adopt whatever session id turns up on the
   *  roster afterwards. Resolves to the delegate's label when it ran, or null
   *  when the mode is `flock`, the named extension is not installed, or its
   *  command failed — in each case the caller launches its own terminal exactly
   *  as it always did.
   *
   *  Only ever consulted for a NEW conversation. Nothing a delegate contributes
   *  takes a session id, so a fork has nothing to hand over and keeps Flock's
   *  own launch in every mode. See src/hosts.ts for the delegate table.
   *
   *  Optional: absent means the setting does not exist for this wiring, which is
   *  every unit double. */
  delegateLaunch?(opts: {
    cwd?: string;
    title?: string;
  }): Promise<{ label: string } | null>;
  focusSession(sessionId: string): boolean;         // bound-terminal show
  /** The session whose terminal is the ACTIVE one in this window, or null when
   *  the active terminal is not one of ours (or there is none).
   *
   *  This is the closest thing the extension has to "the conversation you are
   *  looking at", and it is what the view title's fork and `+` buttons resolve
   *  their target through: a toolbar button gets no row and no argument, so
   *  without it the only honest answer either of them could give is a picker.
   *
   *  Optional, and every unit double may omit it: absent means those two verbs
   *  simply skip that tier and fall through to the next one. */
  activeSessionId?(): string | null;
  renameTerminal(sessionId: string, name: string): Promise<boolean>;
  sendTextToSession(sessionId: string, text: string): boolean;
  closeTerminal(sessionId: string): boolean;
  // windows (F)
  focusWindowFor(sessionId: string): Promise<boolean>;
  // surfaces (F)
  openProject(fsPath: string, newWindow: boolean): Promise<void>;
  // hooks (G)
  installHooks(): Promise<HookInstallState>;
  removeHooks(): Promise<HookInstallState>;
  getHookState(): HookInstallState;
  /** Write `lineage.hooks.enabled`. Installing the plugin is only half the
   *  switch — this is the half that starts the events reader. */
  setHooksEnabled(enabled: boolean): Promise<void>;
  // projects + visibility
  allProjects(): ProjectRecord[];
  getProject(id: string): ProjectRecord | undefined;
  /** The branches the tree is CURRENTLY showing for a project — the same
   *  BranchInfo objects the chip row was built from, not a fresh git probe.
   *  That identity is the point: a chip click must be able to spawn only in a
   *  directory the user was actually looking at, so the verb resolves the
   *  clicked chip against this and refuses anything it does not find. Empty for
   *  a project that is not a repository, or whose probe has not landed. */
  getBranches(projectId: string): readonly BranchInfo[];
  /** Persist a branch-curation decision. `shown` true promotes a branch
   *  into the block, false folds it into "Others"; the store keeps BOTH lists,
   *  so this writes one and clears the other — see ProjectRecord for why two
   *  lists rather than one. */
  setBranchShown(
    projectId: string,
    branch: string,
    shown: boolean,
  ): Promise<void>;
  /** Fold or unfold a project's whole branch block. */
  setBranchesCollapsed(projectId: string, collapsed: boolean): Promise<void>;
  upsertProject(id: string, patch: Partial<ProjectRecord>): Promise<void>;
  /** Re-file a project under another one, or at the top level (null).
   *  Refuses a cycle (a project cannot be filed under its own descendant) and
   *  reports whether the move happened, so the verb can say why it did not. */
  setProjectParent(
    projectId: string,
    newParentId: string | null,
  ): Promise<boolean>;
  deleteProject(id: string): Promise<void>;
  hiddenFolders(): HiddenFolder[];
  hideFolder(dir: string): Promise<void>;
  unhideFolder(dir: string): Promise<void>;
  /** `lineage.staleAfterHours` — only ever pre-ticks a checkbox. */
  staleAfterHours(): number;
  // ---- notifications ------------------------------------------------------
  /** Stamp `seenAt` now — the user looked at this session. Idempotent. */
  markSeen(sessionId: string): Promise<void>;
  /** `lineage.notifications.enabled` (the global default). */
  notificationsEnabled(): boolean;
  // ---- active-only filter -------------------------------------------------
  /** Write `lineage.onlyActiveSessions`. A setter and no getter on purpose: the
   *  two commands that call it each know the value they mean, and the state the
   *  user reads is the view-title icon, which the context key drives. */
  setOnlyActiveSessions(on: boolean): Promise<void>;
  // ---- multi-select -------------------------------------------------------
  /** The session ids selected in whichever view is on screen, top to bottom, or
   *  [] when nothing is or no view has reported one.
   *
   *  Needed because a row's context menu is the WORKBENCH'S: it hands a command
   *  the row it was opened on and nothing else, so a verb that means "these
   *  four" has to ask the view which four. The native tree's own menus pass
   *  their selection as a second argument and do not need this; the webview has
   *  no such channel. */
  selectedSessions(): string[];
  // ---- workspaces ---------------------------------------------------------
  /** Switch this window to a project's workspace (null = leave workspace
   *  mode: save the current layout and stop scoping). Implemented by the
   *  WorkspaceManager that extension.ts wires in. */
  switchWorkspace(projectId: string | null): Promise<void>;
  /** The project id this window's workspace is scoped to, or null. */
  activeWorkspace(): string | null;
  // ---- the Explorer follows the project -----------------------------------
  // All three are OPTIONAL: a host wiring without them (and every unit double)
  // simply has no Explorer to move, and the two verbs below report that rather
  // than failing.
  /** Is this window a Flock workspace — folder[0] our anchor, so the
   *  Explorer's folder list can be repointed in place? */
  explorerAnchored?(): boolean;
  /** Convert this window into a Flock workspace and reload it once. */
  followInExplorer?(): Promise<void>;
  /** Leave workspace mode: reopen the active project's main directory as a
   *  plain folder. Also one reload. */
  stopFollowingInExplorer?(): Promise<void>;
}
