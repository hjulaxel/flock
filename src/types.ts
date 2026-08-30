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
/** Compaction — both phases, ring and dot alike. ONE colour id for two marks
 *  on purpose: they are the same fact at two moments, and a theme that
 *  retunes the purple must not be able to retune only half of it. Purple is
 *  the one signal hue the sidebar had left (amber is running, red is
 *  attention, green is the brand), and the branch palette already spends it
 *  on "merged" — which is the same idea, a thing that has settled. */
export const COMPACTING_COLOR_ID = 'lineage.compacting';
/** The single glyph the status dot is drawn with. A FileDecoration badge is
 *  capped at two graphemes by the workbench, which is the whole reason status
 *  is a dot and not a word. */
export const STATUS_DOT = '●';
/** The HOLLOW ring, at the right edge — the native tree's half of the purple
 *  ring webtree.css draws with a border.
 *
 *  Retired once and brought back for a different job. It used to mark a CLOSED
 *  row, and that was wrong for the reason STATUS_DOT's note gives: a closed row
 *  is already dimmed and its logo greyed, so the ring was a second mark for
 *  something the row had already said, and a column of empty circles beside
 *  every finished session is exactly the noise the lit dots exist to stand out
 *  from. Compaction-in-flight is the opposite case — a transient state nothing
 *  else on the row reports, on a handful of rows at a time — which is precisely
 *  what a mark is for.
 *
 *  The character was a considered choice then and stands now: deliberately NOT
 *  '◌' U+25CC, which is absent from the workbench's UI-font fallbacks and
 *  renders as tofu in a FileDecoration badge. */
export const CLOSED_DOT = '○';
/** The numeric badge on the Flock view container (the activity-bar logo):
 *  how many RUNNING sessions the tree is answering for — level 1 and the
 *  grace countdown together, i.e. every live process with a row.
 *
 *  The slot used to count attention (lit dots) and was deactivated; the
 *  running count takes it because it is the number the levels design exists
 *  to make countable. "No running process without a visible row" is only an
 *  invariant you can trust if the count of processes is ON the container —
 *  the 84-detached-sessions incident was survivable precisely because nothing
 *  anywhere showed "84". Attention lost the slot but not its surfaces: the
 *  dots, the bell and `lineage.hasUnseen` all still carry it, and
 *  `attentionCountOf` stays live and tested.
 *
 *  Flip to `false` to clear the badge — both surfaces (native tree and inline
 *  webview) read this at the one line where they write `view.badge`, and both
 *  write `undefined` while it is off, so the badge clears rather than
 *  freezing at its last value. */
export const RUNNING_BADGE_ENABLED = true;
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
 *  "Archive Session" on one of four selected rows would archive one and read as
 *  though it had archived four. This key swaps the singular entry for a plural
 *  one that says how many it is about to take — the same complementary-`when`
 *  shape the bell and the active-only filter already use. */
export const CONTEXT_MULTI_SELECT = 'lineage.multiSelect';
/** TWO OR MORE accounts a CLAUDE conversation could be moved between.
 *
 *  Gates the "Move to Account…" entry in a session row's menu, and nothing
 *  else. The verb stays REGISTERED either way — that is the standing rule for
 *  every account command, so the palette never reports one missing — but a menu
 *  entry whose picker can only ever say "there is no other account" is a row of
 *  clutter in front of every single-account user, which is most of them.
 *
 *  Counted over `accounts.canSwitchAccounts`, which asks the same question the
 *  PICKER asks and is why this key was renamed rather than repaired in place.
 *  It used to count `accounts.canHostSession` — every account a session can
 *  START on — and that stopped being the same question the day `codex` joined
 *  SESSION_PROVIDERS: a machine with one Claude login and one Codex login had
 *  two host-capable accounts and no legal move between them, so the entry drew
 *  on every session row in front of a picker that was always empty. That is the
 *  roster this extension seeds by default. A key still called `manyAccounts`
 *  while meaning "two accounts one conversation could move between" would have
 *  been the next person's bug, so the name changed with the meaning. */
export const CONTEXT_CAN_SWITCH_ACCOUNT = 'lineage.canSwitchAccount';
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
/** The `lineage.mode` value ('folder' | 'root' | 'project'), mirrored for the
 *  manifest's when-clauses: a contributed menu item cannot read a setting
 *  through anything but `config.*`, and gating on the RESOLVED mode (defaults
 *  and garbage values folded in by modes.normalizeMode, and the legacy
 *  `workspaces.enabled` pair folded in by modes.resolveMode) has to match what
 *  the code actually does — `config.lineage.mode == 'project'` would disagree
 *  with the code the moment a settings file carries a typo, and now also the
 *  moment one carries the old pair. That the RESOLVED value is what lands here
 *  is what let a third value be added without a single when-clause learning
 *  about `workspaces.enabled`.
 *
 *  A when-clause spells the NEGATIVE — `lineage.mode != 'folder'` — wherever a
 *  verb is available at two of the three models, which is most of them: in-window
 *  switching exists at `flock` and `project` alike and is refused only by the
 *  window that is its folder. Written at activation and on every configuration
 *  change. */
export const CONTEXT_MODE = 'lineage.mode';

// ------------------------------------------------------------------ schema

/** Version of the persisted globalStorage state.json blob.
 *  v2 adds `projects` and `hiddenFolders`. v3 adds `chains` (generation
 *  chains). v4 adds `workspaces` (project workspaces). v5 adds `accounts` and
 *  `accountSettings`.
 *
 *  v6 is the FIRST step that rewrites rather than adds: a subproject is a
 *  DIRECTORY of its parent now, not a project record filed under one, so the
 *  ladder folds every nested project's directories into its top-level ancestor
 *  and tombstones the record. See projects.flattenNestedProjects for the rules
 *  and state.migrateV5ToV6 for the write. Sessions are not touched and do not
 *  need to be: membership has always been derived from the cwd, so a session
 *  that was under the child's row is under the child's DIRECTORY row afterwards.
 *
 *  v8 RETIRES `parked` — the invisible running-but-unshown state that let 84
 *  detached sessions (~670 processes) pile up unseen. Every record with
 *  `parked: true` is flipped to archived (a `closed` stamp, `tmux` cleared) —
 *  level 2: no process, a visible resumable row. The flip lives in
 *  state.sanitizeRecord rather than in a one-shot ladder step, on the
 *  hidden→deleted precedent, so a mixed install whose old window keeps
 *  re-writing `parked: true` converges again on every read. The processes those
 *  records left running are ended by the activation-time tmux reconcile
 *  (extension.ts), which needs no record-side name — the tmux session name
 *  encodes the session id.
 */
export const STATE_SCHEMA_VERSION = 8;

/** The first schema version written by a build in which branch rows are OFF by
 *  default. 0.1.1 and earlier drew a row per checkout unconditionally and wrote
 *  v5; 0.1.2 parked them behind `lineage.git.branches` and writes v6 or later.
 *
 *  So a state.json that claimed LESS than this when a window first read it was
 *  written by a build whose branch rows drew — which is the whole test for "did
 *  this person just lose rows they were using". See git.branchRowsAdvice, and
 *  StateStore.schemaVersionAtLoad for why the claim is captured rather than
 *  re-derived. */
export const BRANCH_ROWS_PARKED_AT_SCHEMA = 6;

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
  /** The branch block has been ASKED FOR on this project.
   *
   *  A POSITIVE record, and the sense is load-bearing. It was
   *  `branchesCollapsed` — "the user folded this" — back when the block drew by
   *  default, and the block does not draw by default any more: a project with
   *  six checkouts is six rows before its first session, on somebody who never
   *  asked for any of them. Absent or false is therefore the normal state and
   *  means no branch rows; only **Show Branches** writes `true`.
   *
   *  Renaming it rather than inverting it is what makes that safe. Every
   *  `branchesCollapsed: false` already written — by the old fold toggle, which
   *  drew on every project — would otherwise read as "this one was explicitly
   *  opened" and put the rows straight back on the projects that never chose
   *  them. Under the new name those records simply do not answer, which is the
   *  truth: nobody has asked yet.
   *
   *  Per project and persisted, because it is a statement about how much room
   *  this project's branches deserve, which does not change between windows the
   *  way a scroll position does. */
  branchesShown?: boolean;
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
 * `sevenDayOpus`. `error` distinguishes the ways "no numbers" happens, and the
 * split that matters is whether the USER has anything to do about it: they were
 * never logged in (`no-credentials`) or the sign-in is genuinely over
 * (`expired`) — versus the ones to ignore, a request or parse that fell over
 * (`http`/`parse`) and an access token that has merely aged out
 * (`token-stale`).
 *
 * `token-stale` is the common one and the reason it is not `expired`. An OAuth
 * access token lasts hours; the CLI renews it from the refresh token beside it
 * whenever it next runs, without asking anyone. So a config directory holding a
 * lapsed access token AND a refresh token is a perfectly good login that simply
 * has not been used lately — and reporting it as "login expired" sent people to
 * `/login` to fix an account that was never broken.
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
  error?: 'no-credentials' | 'expired' | 'token-stale' | 'http' | 'parse';
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

/**
 * `lineage.sessionSwitching` — which list is THE list of conversations.
 *
 * Two session switchers on one screen is one too many. The Claude Code
 * extension has an agent list of its own, reachable from the back arrow at the
 * top of its panel, and it is very easy to land in by accident; it also knows
 * nothing about forks, projects, worktrees or anything else the tree exists to
 * show, so arriving there is a downgrade you did not ask for.
 *
 * `flock` (the default) makes the tree the switcher: the row of whatever
 * conversation is in front stays SELECTED as you move between them, so the
 * sidebar always already says where you are, and alt+left over Claude puts the
 * keyboard on that row so the arrows can move you off it.
 *
 * `claude` turns both halves off and leaves the agent list alone. Nothing here
 * disables anything of Claude's — Flock could not if it wanted to — it only
 * stops Flock from having an opinion about where you are.
 *
 * WHAT THIS IS NOT: an interception. The back arrow is a route change inside
 * another extension's webview and it produces no signal on the outside — no
 * tab, no title change, no command, no context key. Flock cannot stop the
 * click, cannot see it, and does not pretend to. What it can do is make sure
 * the place you land is already correct.
 */
export type SessionSwitching = 'flock' | 'claude';

export function isSessionSwitching(v: unknown): v is SessionSwitching {
  return v === 'flock' || v === 'claude';
}

export const DEFAULT_SESSION_SWITCHING: SessionSwitching = 'flock';

/**
 * What clicking **Close with Summary** does — four answers, each honest about
 * what it costs. The behaviour, the wait and the refusals are in
 * src/closeSummary.ts, which re-exports all three of these; they live here
 * because this file imports nothing and is the root every module may read.
 *
 * `compact-and-tell-parent` is the standard: type `/compact` into the session,
 * wait for the Claude CLI to write its own compaction summary, record it on
 * the row, type a short form of it into the PARENT conversation, and then
 * close. `compact-only` is the same without the parent step, for a branch
 * whose parent is not open or not interested. `ask-me` is exactly the old
 * input box, kept by name so that anyone who preferred it can find it by
 * reading the list rather than by discovering it is gone. `off` closes with no
 * summary at all — what **Close Session** already does — for anyone who keeps
 * hitting a menu entry they did not want to be a two-minute verb.
 *
 * SAY WHAT THE COMPACTING MODES ARE, precisely, wherever they are described.
 * Flock cannot ask a model for a summary: it has no API client, and it speaks
 * to the CLI only by typing into its terminal. It drives `/compact` and reads
 * back what the CLI wrote. The words are genuinely the model's; the driving is
 * a keystroke. It is not a scrape of the last exchange, and it is not
 * something Flock generated.
 */
export type CloseSummaryMode =
  | 'compact-and-tell-parent'
  | 'compact-only'
  | 'ask-me'
  | 'off';

export function isCloseSummaryMode(v: unknown): v is CloseSummaryMode {
  return (
    v === 'compact-and-tell-parent' ||
    v === 'compact-only' ||
    v === 'ask-me' ||
    v === 'off'
  );
}

/**
 * The default, and it is a compacting one.
 *
 * The old behaviour is not the safe default here; it is the reported bug. What
 * makes this defensible is that every way it can fail declines loudly rather
 * than quietly doing something else: a Codex session is offered the plain
 * close by name, a session with no terminal in this window refuses before
 * anything is typed, and a compaction that never finishes closes nothing at
 * all.
 *
 * Note the deliberate asymmetry with `CommandDeps.closeSummaryMode`, whose
 * ABSENCE reads as `ask-me`. The default of the setting is this; the default
 * of a wiring that never read the setting is the old input box, because a
 * reader that cannot see the configuration has no business starting
 * two-minute compactions on the strength of a value it never read.
 */
export const DEFAULT_CLOSE_SUMMARY_MODE: CloseSummaryMode =
  'compact-and-tell-parent';

// ------------------------------------------------------------------ verbs

export const WRAP_PROMPT =
  'Wrap up this session: summarize what was accomplished in 3-6 bullet ' +
  'points, list any unfinished work, then stop.';

/**
 * The one turn that makes a conversation compact itself.
 *
 * A SLASH COMMAND and not English, and the whole of both features that use it
 * rests on that distinction: the Claude CLI interprets a prompt beginning with
 * `/` as a command, so this is an instruction rather than a message. The Codex
 * CLI takes a positional prompt too but as ordinary user text, which would
 * open a conversation by saying the literal characters "/compact" to a model
 * and compact nothing — so every caller checks the provider first and declines
 * by name rather than half-doing it.
 *
 * It lives here rather than in commands.ts because two very different callers
 * need the same string: `forkAndCompact` hands it to a CHILD as its opening
 * positional argument, and Close with Summary types it into a session that is
 * already running. A second literal would be one edit away from the two
 * disagreeing.
 */
export const COMPACT_PROMPT = '/compact';

export const COMMANDS = {
  refresh: 'lineage.refresh',
  focusSession: 'lineage.focusSession',
  /**
   * Put the keyboard in the Flock sidebar, on the row of whatever conversation
   * is in front — the one gesture that makes the sidebar a session SWITCHER
   * rather than a list you click.
   *
   * It exists because of the Claude Code extension's own back arrow, which
   * leaves its conversation for an agent list Flock cannot see into and does
   * not need: two session lists on one screen, and only one of them knows
   * about forks, projects or worktrees. Flock cannot intercept that click — it
   * is a route change inside another extension's webview, with no tab, title,
   * command or context key on the outside of it — so this is the half that can
   * be made to work: the arrow key that means "back" while Claude has focus
   * lands you in the tree instead, on the row you were already in, with the up
   * and down arrows switching sessions from there.
   *
   * Bound to alt+left, scoped to the Claude panel or sidebar being active, and
   * only while `lineage.sessionSwitching` is `flock`. Always available from the
   * palette, whatever that setting says.
   */
  focusSessionsView: 'lineage.focusSessionsView',
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
  /** End the session to level 2 IMMEDIATELY, skipping every wait: a grace
   *  countdown is cut short (the detached process is killed, tree and all), a
   *  live tab is closed. The user verb for "1→2 now" where `closeSession`
   *  covers only a session with a terminal to close. */
  closeSessionNow: 'lineage.closeSessionNow',
  /** Toggle the keep-awake pin (EditorialRecord.pinned): a pinned session is
   *  exempt from the idle timer, grace expiry and pool eviction — for long
   *  autonomous runs that look idle between turns. One toggle verb rather than
   *  a pin/unpin pair because the pinned state has no menu token yet; the verb
   *  reports which way it flipped. */
  togglePinSession: 'lineage.togglePinSession',
  wrapSession: 'lineage.wrapSession',
  copySessionId: 'lineage.copySessionId',
  // TWO verbs on a row, no third: CLOSE ends the tab (the row stays,
  // inactive), ARCHIVE ends the session and removes the row (restorable). The
  // old hide verb is retired; old `hidden` records read as deleted (see
  // state.sanitizeRecord).
  //
  // THE ID STILL SAYS `delete` AND THE TITLE SAYS "Archive Session", ON
  // PURPOSE. A command id is a public contract: it is what a user's
  // `keybindings.json`, a task runner, or another extension names, and none of
  // them ever see it in the UI. Renaming it would break those bindings
  // silently, in exchange for a word nobody reads — so the words changed and
  // the ids did not. The same applies to `deleteSessions`, `restoreSession`
  // and `deleteStale` below.
  deleteSession: 'lineage.deleteSession',
  /** The same verb over a MULTI-SELECTION. A separate id rather than a
   *  widened `deleteSession` because the two have to say different things in a
   *  menu — "Archive Session" over four selected rows is a lie — and a
   *  contributed command has exactly one title. Their `when` clauses are
   *  complements of `lineage.multiSelect`. */
  deleteSessions: 'lineage.deleteSessions',
  restoreSession: 'lineage.restoreSession',
  /** The per-project archive browser — "Archived Sessions…" on a project row.
   *  Archiving takes a row out of the tree, which makes the archive the one
   *  place a session can be without being anywhere you can look; this is that
   *  place, scoped to the project you are already looking at, searchable by
   *  name, and restoring several at once. `restoreSession` remains the
   *  whole-machine door for the case where you do not know which project it
   *  was. */
  archivedSessions: 'lineage.archivedSessions',
  openProject: 'lineage.openProject',
  installHooks: 'lineage.installHooks',
  removeHooks: 'lineage.removeHooks',
  /** The in-session verbs: a skill plus a tiny CLI that let the user say
   *  "fork this session" TO CLAUDE, which then asks a Flock window to run the
   *  same forkFlow the sidebar button runs. Install/remove mirror the hooks
   *  pair — one consent modal, `rm -rf` also uninstalls. See agentVerbs.ts. */
  installAgentVerbs: 'lineage.installAgentVerbs',
  removeAgentVerbs: 'lineage.removeAgentVerbs',
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
  /**
   * ADD A SUBPROJECT: one more directory on this project.
   *
   * A subproject is not a record any more. It is a DIRECTORY the project lists,
   * and the row exists because the project has more than one — so the whole of
   * this verb is a folder dialog, and the second directory is what splits the
   * project's sessions into two rows. See projects.buildSubprojects.
   *
   * What it replaced was a second `newProject` with the parent pre-answered,
   * which made a subproject a full project in every respect: its own name, its
   * own provider, its own account, its own workspace, its own settings menu. All
   * of that had to be decided for something whose entire job was sorting rows,
   * and it was the reason a project's context menu had fourteen entries.
   *
   * It also merged `lineage.addProjectDirectory`, which did exactly this and was
   * a separate entry in the same menu. Nothing may re-use that string.
   */
  newSubproject: 'lineage.newSubproject',
  /** Take a directory back OFF a project. The other half of Add Subproject, and
   *  the reason it is safe: it removes a row, never a directory on disk. Drops
   *  to no subproject rows at all once one directory is left, which is the
   *  layout a single-directory project has always had. */
  removeSubproject: 'lineage.removeSubproject',
  /** Rename a NAMED subproject. Only on a lane — an implicit directory row has
   *  no name of its own to change (its label is the directory's). */
  renameSubproject: 'lineage.renameSubproject',
  /**
   * Re-file an EXISTING session into one of its project's lanes, or out of every
   * lane.
   *
   * The missing half of named lanes. A lane's stamp
   * (`EditorialRecord.subprojectId`) was written at LAUNCH and nowhere else, so
   * the only way into a lane was to start a session from the lane's own `+` —
   * which means every conversation that predates the lane, and every one started
   * from the project's `+` or from a terminal, could never be filed in it.
   * Measured on a real store: two live lanes, 556 session records, and not one
   * stamp between them.
   *
   * `StateStore.moveSessionSubproject` is deliberately a DIFFERENT writer from
   * the launch path's `setSessionSubproject`, so "the launch must not overwrite
   * an existing stamp" and "the user may change their mind" stay separate rules.
   * This is the verb behind the second one.
   */
  moveSessionToLane: 'lineage.moveSessionToLane',
  /** REMOVED — `lineage.moveProject`, "Move Project…". Re-filed a project under
   *  another one. Nesting projects inside projects is retired: a subproject is a
   *  directory now (see `newSubproject`), so there is no parent to pick. The id
   *  is recorded here, not resurrected: nothing may re-use the string. */
  newSessionInProject: 'lineage.newSessionInProject',
  /** Put an EXISTING session on the tree, by hand: pick from the sessions that
   *  already ran in the project's directories — live ones running elsewhere and
   *  finished transcripts alike — or paste a session id. The verb behind the
   *  clean-slate default: with `lineage.showForeignSessions` off, nothing
   *  reaches the tree until the user launches it here or names it here, and
   *  this is how it gets named. Writes an editorial record and nothing else;
   *  membership stays derived from the session's own cwd, so an id whose
   *  directory belongs to another project files THERE, and the verb says so
   *  rather than pretending otherwise. */
  addSessionToProject: 'lineage.addSessionToProject',
  /** The bulk door for pre-Flock history: every session on this machine that
   *  has no row — old transcripts under ~/.claude/projects, foreign live ones —
   *  offered once, grouped by folder, imported only when picked. Deliberately a
   *  VERB and not a scan-on-activate: an import nobody asked for is exactly the
   *  first-run mess this replaces. */
  importSessions: 'lineage.importSessions',
  /** A session in one specific DIRECTORY of a project — what a subproject row's
   *  `+` and its first menu entry run. Its own verb rather than
   *  `newSessionInProject` with an extra argument because that one ASKS which
   *  directory when a project has several, and the whole point of a subproject
   *  row is that the answer is already on screen. Not in the palette: the
   *  argument is a directory only the rendered row knows. */
  newSessionInSubproject: 'lineage.newSessionInSubproject',
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
  /** THE TWO VERBS THAT WRITE. Everything else in this table reads, renders or
   *  launches; these two create and delete a checkout of the user's repository,
   *  which is why they are the only pair here that always confirms first and
   *  always shows the exact command it is about to run.
   *
   *  Both are offered in the palette as well as on a row, unlike the branch
   *  verbs above: `newSessionInBranch` needs a worktree the tree already drew,
   *  where the whole point of `newWorktree` is that there is not one yet — a
   *  single-checkout repository has no branch rows at all (see
   *  BRANCH_CHIPS_MIN), so a row-only verb would be unreachable in exactly the
   *  case it is for. They open a picker when they arrive with no argument. */
  newWorktree: 'lineage.newWorktree',
  removeWorktree: 'lineage.removeWorktree',
  /** A worktree in its own VS Code window. The other way to work in a second
   *  checkout — an editor there rather than an agent — and the reason it is a
   *  verb of its own rather than something `revealBranch` could cover. */
  openWorktreeWindow: 'lineage.openWorktreeWindow',
  /** A SESSION's workspace, in its own window — the row-level counterpart of
   *  Open Project in New Window, and the answer to "go to that workspace" for a
   *  conversation rather than for a project.
   *
   *  The target is the session's WORKTREE first, then the lane it is filed in,
   *  then the directory its project claims. A session's window is the checkout
   *  it runs in, not the project's root: the whole reason to go there is to see
   *  its files and its Source Control, and a linked worktree is what answers
   *  both. Every tier CONTAINS the session's cwd, which is not a nicety — the
   *  new window's launch fence and its grouping fence are both containment
   *  tests, so a target that does not contain the cwd opens a window with
   *  neither a row for the session nor the ability to resume it.
   *
   *  Not titled "…in New Window" like its two neighbours, because it may not
   *  open one: a window already covering the directory is raised instead, here
   *  as everywhere else, since two windows on one directory is two roosts for
   *  one piece of work. */
  openSessionWorkspace: 'lineage.openSessionWorkspace',
  /** The pull request on this branch, in the browser. Only ever drawn on a row
   *  that HAS one (the `pullRequest` context token), and only reachable at all
   *  with `lineage.git.pullRequests` on. */
  openPullRequest: 'lineage.openPullRequest',
  /** The BRANCH's own page on the remote it tracks, in the browser — what a
   *  branch name in the tree links to. Needs no `gh` and no setting: the url is
   *  built from `git remote get-url` and the branch's upstream, both of which are
   *  reads of the local repository. Refused, with a word, for a branch that
   *  tracks nothing — there is no page for work nobody has pushed. */
  openBranchOnRemote: 'lineage.openBranchOnRemote',
  /** `gh pr create --web`: the compare page, in the browser, for the user to
   *  finish. Deliberately NOT a request Flock opens itself. Every outward action
   *  in this product ends with a human pressing the button — a verb that silently
   *  created a pull request would be the first exception, and it would be one on
   *  a mis-click. */
  createPullRequest: 'lineage.createPullRequest',
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
  /** REMOVED — `lineage.addProjectDirectory`, "Add Directory to Project…".
   *  Adding a directory IS adding a subproject now, and two menu entries doing
   *  one thing was half the reason the project menu needed trimming. Folded into
   *  `newSubproject`; nothing may re-use the string. */
  projectFromFolder: 'lineage.projectFromFolder',
  hideFolder: 'lineage.hideFolder',
  showHidden: 'lineage.showHidden',
  // Bulk housekeeping for a tree whose rows persist until archived. Replaces an
  // earlier `lineage.hideStale` (hide is retired). Titled "Archive Stale
  // Sessions…"; see `deleteSession` for why the id keeps the old word.
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
  /** Root the Explorer at ONE of the active project's directories, under
   *  `directory` scope. The click target on the Project view's directory rows:
   *  the tree normally follows the session you are working in, and this is how
   *  you send it somewhere else without starting a session there first. */
  showDirectoryInExplorer: 'lineage.showDirectoryInExplorer',
  /** Leave workspace mode: reopen the active project's main directory as a
   *  plain folder. Also one reload, and the door back out. */
  stopFollowingInExplorer: 'lineage.stopFollowingInExplorer',
  // The active-only filter, a view-title toggle. Two ids for one setting, for
  // the reason above: a contributed button carries one icon and one title, so
  // a switch needs one command per position.
  showOnlyActiveSessions: 'lineage.showOnlyActiveSessions',
  showAllSessions: 'lineage.showAllSessions',
  /** The Accounts SECTION's switch, split in two for the same reason as the pair
   *  above: one setting, two ids, complementary `when` clauses, because a
   *  contributed entry cannot say which way it is about to go.
   *
   *  Why the section has a switch at all. VS Code merges a view's title-bar
   *  buttons into the CONTAINER header — the row that reads FLOCK — only while
   *  that container has exactly one visible view. Accounts was the second one, so
   *  every Flock button sat a row below the name with its own `...` beside it.
   *  Folding Accounts away is what puts the bell up on the FLOCK row.
   *
   *  It hides a SECTION, never a feature: the ten account verbs stay registered,
   *  routing and pinning are untouched, and this pair lives in the gear menu so
   *  the way back is one click from where the section used to be. Reads and
   *  writes `lineage.accounts.section`. */
  showAccountsSection: 'lineage.showAccountsSection',
  hideAccountsSection: 'lineage.hideAccountsSection',
  /** The two DISPLAY MODES, said in the gear menu rather than only in settings.
   *  Two ids for one setting, the same shape the filter above uses: each command
   *  knows the mode it means, and the state the user reads back is which of the
   *  two the menu is offering. Reads and writes `lineage.git.branchDisplay`. */
  branchDisplayInline: 'lineage.branchDisplayInline',
  branchDisplayColor: 'lineage.branchDisplayColor',
  /** Every git-and-worktree switch at once, from the palette.
   *
   *  The branch work is spread over four settings — the branch rows, how much
   *  the line under a session says, the pull-request chips and the
   *  directory-model preview — and each one is off for its own good reason.
   *  That is right for a person who wants one of them and wrong for the two who
   *  want all of them: somebody trying the feature out, and somebody testing a
   *  change to it in an Extension Development Host. Both had to find four keys
   *  in the settings UI, knowing all four names.
   *
   *  One pair of ids rather than a picker, and no dialog: the palette entry IS
   *  the choice. `show` writes the four on (with `detailed` for the line, which
   *  is the level worth looking at when you have asked for everything); `hide`
   *  writes the shipped defaults back, so the pair is an exact inverse and not
   *  a one-way door.
   *
   *  One of the four is a thing Flock otherwise never does unasked — `gh pr
   *  list` reaches the network — so the ON half says so afterwards in a message
   *  rather than a status-bar flash. That is still enough to earn the message on
   *  its own, because the network is the one consequence here a person cannot
   *  discover by looking at their sidebar. Invoking the command is the person's
   *  act that the setting requires; being told what you just turned on is not
   *  the same as being asked. */
  showBranchesAndWorktrees: 'lineage.showBranchesAndWorktrees',
  hideBranchesAndWorktrees: 'lineage.hideBranchesAndWorktrees',
  /** THE ONBOARDING VERB: everything a new install should turn on, as a
   *  checklist that says why.
   *
   *  Seventeen of the forty settings ship off, and only some of them are off
   *  because the default is right — `hooks.enabled` and `verbs.enabled` are off
   *  because turning them on writes files under the user's home directory, and
   *  a consent gate with nothing that ever asks is a feature nobody has. This
   *  is the thing that asks. What it will and will not offer is decided by
   *  `recommendedPlan` in src/recommend.ts, which is pure and tested; the flow
   *  here runs the steps that were ticked.
   *
   *  A CHECKLIST rather than a `showBranchesAndWorktrees`-shaped write-it-all
   *  pair, because the two commands answer different questions. That pair is
   *  "give me the whole branch feature", asked by somebody who already knows
   *  what it is. This one is asked by somebody who does not know what is on
   *  offer, so every line has to carry its own reason and its own cost — and
   *  the answer has to be theirs, per line, before anything is written. */
  recommendedSetup: 'lineage.recommendedSetup',
  /** WHICH OF THE THREE WINDOW MODELS this window is in — the same picker the
   *  recommended setup's `windowModel` step opens, reachable on its own.
   *
   *  A VERB rather than "open the settings UI and find the dropdown", because
   *  the dropdown is where the choice went unfound: it is one of forty-odd
   *  rows, its values are `folder` / `flock` / `project` rather than the words
   *  a person would use, and nothing in the product ever pointed at it. The
   *  picker names the three the way Axel names them, says what each one costs,
   *  puts the cursor on the one you are in — and writes `workspaces.enabled`
   *  alongside the mode when auto-switch is chosen, which is the only way the
   *  legacy pair ever gets untangled on a real machine.
   *
   *  Not gated by a when-clause: a person in the wrong model is exactly the
   *  person who needs to find this, and hiding it in some models would be the
   *  same mistake the dropdown made. */
  chooseWindowModel: 'lineage.chooseWindowModel',
  /** The gear at the end of the view title, and everything that used to be
   *  behind the `...` beside it.
   *
   *  A COMMAND, deliberately, where the obvious answer is a `contributes.submenus`
   *  entry placed in the navigation group. Two things go wrong with the submenu:
   *  it is not reliably drawn as a toolbar button in a VIEW title (the reference
   *  documents no such rendering, and it did not appear in the sidebar), and even
   *  when a toolbar does draw everything, VS Code collapses a row too narrow for
   *  its buttons into an overflow `...` — which would put the gear back inside
   *  the ellipsis it exists to replace. A command with an icon is drawn wherever
   *  a command can be drawn, and this one opens the menu itself.
   *
   *  It is therefore also the one menu in Flock that can label itself with STATE:
   *  a quick pick is built when it opens, so "Hide Accounts Section" and "Show
   *  All Sessions" say which way they go rather than needing a `when` clause and
   *  a second command id each. */
  settingsMenu: 'lineage.settingsMenu',
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
  /** MOVE an existing conversation to another account: stop it, move its
   *  transcript into that account's config directory, re-pin the chain, and
   *  resume it there. On a SESSION row, not an account row — the thing being
   *  moved is the conversation, and the account is the destination. */
  switchSessionAccount: 'lineage.switchSessionAccount',
} as const;
export type CommandId = (typeof COMMANDS)[keyof typeof COMMANDS];

// ------------------------------------------------------------------ config

export const CONFIG_SECTION = 'lineage';
export const CONFIG_KEYS = {
  pollIntervalMs: 'pollIntervalMs',
  claudeBinary: 'claudeBinary',
  /** The Codex CLI, for sessions launched on a Codex/OpenAI account. Its own
   *  key rather than a per-provider map because the two binaries are found by
   *  genuinely different rules: `claude` is a PATH scan, while `codex` usually
   *  lives under whichever node version is active (see codex.findCodexBinary),
   *  which an extension host frequently does not inherit. */
  codexBinary: 'codexBinary',
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
  /** The in-session verbs' reader gate, the same shape as `hooks.enabled`:
   *  installing the skill only makes CLAUDE write request files, and this is
   *  the half that makes windows read them. Defaults false; set true by the
   *  install command, whose modal is the consent. */
  verbsEnabled: 'verbs.enabled',
  /**
   * `lineage.fork.notifyParent` — after a fork, type one sentence into the
   * PARENT conversation saying that a branch was made, what it is called and
   * what it is for.
   *
   * NEW CONSTRUCTION, not an existing mechanism turned on. Flock has no
   * session-to-session messaging: the in-session verbs channel runs one way,
   * session → extension, and the only text that has ever gone the other way is
   * a fork's opening prompt, delivered once at birth. This note rides the
   * single remaining extension → live-session channel, `sendTextToSession`,
   * which types into a terminal bound in THIS window — see src/forkNote.ts for
   * what that costs and what it cannot reach.
   *
   * OFF by default, and the default is the honest one. The note is keystrokes
   * into a running conversation: it costs the parent a turn, and if there is
   * half a sentence already typed in that input box it is appended to it.
   * Nothing is queued when the parent cannot be reached — a closed parent, one
   * in another window, one running outside Flock — because the tree already
   * carries the fact for the person, and a mailbox would be a second lifecycle
   * to get wrong.
   */
  forkNotifyParent: 'fork.notifyParent',
  /**
   * `lineage.close.summaryMode` — what **Close with Summary** actually does.
   *
   * It used to open an input box and ask the person to type the summary, which
   * is the one party with least of the conversation in their head. The default
   * now types `/compact` into the session, waits for the Claude CLI to write
   * its own compaction summary, records it on the row, and (in the standard
   * mode) types a short form of it into the parent before closing.
   *
   * Say what this is precisely, everywhere it is described: Flock cannot ask a
   * model for a summary — it has no API client and speaks to the CLI only by
   * typing into its terminal. It drives `/compact` and reads back what the CLI
   * wrote. The text is genuinely model-written; the driving is a keystroke.
   * The values, the wait and the refusals live in src/closeSummary.ts.
   */
  closeSummaryMode: 'close.summaryMode',
  terminalLocation: 'terminalLocation',
  /** Quality-of-life: keep at most ONE session tab open in this window.
   *  Opening or focusing a session parks every other session tab — detached
   *  into the private tmux server when the launch was wrapped (the process
   *  keeps running, hidden), otherwise closed to be resumed from the tree —
   *  and the kept tab is pinned. OFF by default: parking tabs the user laid
   *  out side by side is a strong opinion, and the default stays the tab
   *  strip as VS Code users know it. */
  soloSession: 'soloSession',
  /** How long a project chat's tab may sit unused before it closes itself, in
   *  minutes; 0 disables. A chat is a scratch conversation whose NORMAL ending
   *  is abandonment, and it has no tree row for solo mode or a switch to tidy
   *  behind — so without this, finished chats pile up as tabs. The close is a
   *  plain terminal close, never a park (`parked` means "a switch will bring
   *  this back", which is exactly wrong for a chat), and the conversation
   *  survives in Chat History. Busy or waiting chats and the active tab are
   *  never touched. The decision is chatAutoCloseVictims
   *  (src/chatAutoClose.ts); extension.ts sweeps on a timer. */
  chatAutoCloseMinutes: 'chat.autoCloseMinutes',
  /** How long ANY session tab may sit idle before it closes itself to level 2
   *  (an archived row, one click from resuming), in minutes; 0 disables. The
   *  generalization of `chat.autoCloseMinutes` to every session: the process
   *  is a warm cache over the transcript, and a cache nobody has read for
   *  half an hour is paid for in memory (~390 MB + ~8 MCP children each). The
   *  active tab, busy/waiting sessions (marked close-after-turn instead) and
   *  pinned sessions are never touched. Decision: idleCloseDecisions
   *  (src/idleClose.ts); extension.ts sweeps on the same 60 s timer as the
   *  chat sweep. Idleness is the last REAL transcript record's timestamp,
   *  never file mtime — hooks touch transcripts without new content. */
  sessionCloseAfterMinutes: 'session.closeAfterMinutes',
  /** How long a tab-close (workspace switch, solo mode) may leave a
   *  tmux-wrapped session running DETACHED so re-attach is instant, in
   *  minutes; 0 closes immediately. The one sanctioned detached-running
   *  state, and it always renders — the tree shows a countdown row. At the
   *  deadline: idle → closed to level 2; busy → close-after-turn. The pool is
   *  capped (idleClose.GRACE_POOL_CAP = 8); overflow closes oldest-idle
   *  first. */
  sessionDetachGraceMinutes: 'session.detachGraceMinutes',
  /** How long a session may keep running after the window that owned it went
   *  away, in SECONDS. Not a park and not a reprieve — a measurement. VS Code
   *  reports a window RELOAD and a window CLOSE with the same terminal exit
   *  reason and offers no way to distinguish them, so the only way to know
   *  which just happened is to wait: a reload comes back and reattaches
   *  (clearing the deadline), a close never does. At the deadline the session
   *  settles to level 2, because with the strict scope fence no other window
   *  would ever show it — a closed folder's sessions end.
   *
   *  Seconds, not minutes, and deliberately far below
   *  `session.detachGraceMinutes`: this window is measuring a reattach that
   *  takes about a second, not offering the user time to come back. Raise it
   *  only if reloads on this machine are slow enough to lose sessions. 0 kills
   *  on window close outright, which also makes every RELOAD lose its
   *  sessions. */
  sessionReloadGraceSeconds: 'session.reloadGraceSeconds',
  /** Who OPENS a conversation: Flock's own tmux-backed terminal, or another
   *  extension's commands (see src/hosts.ts's delegate table). Consulted for a
   *  NEW conversation and for a plain RESUME of an unpinned one — a fork has
   *  nothing to hand over (`--fork-session` is a CLI flag no delegated command
   *  carries). */
  launchMode: 'launch.mode',
  /** WHERE you switch conversations: Flock's tree, or the Claude Code
   *  extension's own agent list. See SessionSwitching. */
  sessionSwitching: 'sessionSwitching',
  onlyProjectSessions: 'onlyProjectSessions',
  /** Show live sessions Flock does not own — `claude` running in some other
   *  terminal, another editor, a script. OFF by default: the roster is
   *  machine-wide, and a tree that fills itself with every session anyone ever
   *  starts is a tree nobody curated. Off also gates the bell: a session with
   *  no row must not be able to light it (see extension.noteSessionDone). What
   *  stays visible either way is everything the user ever told Flock about —
   *  launched here, bound to one of its terminals, added or imported by hand. */
  showForeignSessions: 'showForeignSessions',
  // Staleness
  showPhantomRows: 'showPhantomRows',
  viewStyle: 'viewStyle',
  /** Show a session's token count left of its age. Off by default: it is a
   *  second number on every row, and the row already carries an age and a dot. */
  showTokens: 'showTokens',
  /**
   * THE BRANCH BLOCK'S MASTER SWITCH, and it is OFF.
   *
   * Everything worktree-shaped hangs off this one boolean: the branch rows under
   * a project, the per-branch colours on session names, the "Others" fold, the
   * worktree verbs, the pull-request chip. Off, the sidebar is projects and
   * sessions and nothing else — which is the tree Flock is published on.
   *
   * A SETTING rather than a deletion because the feature works: it reads real
   * worktrees, it starts sessions in them, and its rules are covered by tests
   * that still run. What it does not have is a place in a sidebar that has to
   * stay readable at 250px, so it is parked at the one gate every surface
   * already asks — `GroupingInput.branchRows` — and comes back by flipping this.
   *
   * Note what it does NOT gate: which project a session in a linked worktree
   * belongs to. That is `matchProject`'s worktree-derived membership, and it is
   * the reason a session started in `app-feat-x` files under `app` instead of
   * falling out to a folder row. Turning the branch ROWS off must not move
   * anybody's sessions.
   */
  gitBranches: 'git.branches',
  /**
   * `lineage.git.branchDisplay` — WHICH of the two ways a session says the
   * worktree it is in: `color` (the name tinted, the block as its key) or
   * `inline` (the branch in words, on a line of its own). See BranchDisplay,
   * which is where the trade between them is written down.
   *
   * Not a switch with an off position, deliberately. "Off" is `git.branches`
   * off: no rows, no line, no colours, nothing about branches anywhere. This
   * only ever answers HOW, and both answers are complete — the same verbs, the
   * same git reads, the same pull requests.
   */
  gitBranchDisplay: 'git.branchDisplay',
  /** How much the INLINE line says. `standard` is the vocabulary git prompts and
   *  the SCM view already use — `↑4 ↓3 *` and nothing else. `detailed` adds the
   *  pull request and the two words the arrows cannot say, `local` and `merged`.
   *  Moot in colour mode, which has no line. See sessionBranchLine. */
  gitSessionBranchDetail: 'git.sessionBranchDetail',
  /**
   * `lineage.git.newSessionInWorktree` — what the `+` on a project or a
   * subproject row MEANS.
   *
   * Off: start the session in the directory as it is. On: cut a new worktree
   * first and start it there, one agent per checkout, which is the whole reason
   * somebody runs the branch feature at all.
   *
   * It decides the BUTTON's default and nothing else. Both verbs are on the
   * row's right-click in both positions — **New Session** and **New Session in
   * New Worktree…** — because a default is a statement about the common case,
   * never about what is reachable. The worktree half still confirms and still
   * quotes the exact `git worktree add`.
   */
  gitNewSessionInWorktree: 'git.newSessionInWorktree',
  /** Override the branch palette used by `branchDisplay: color`. Empty = the
   *  built-in muted one. Read only in that mode: inline mode tints nothing. */
  branchColors: 'branchColors',
  /** Nest a project's sessions UNDER the branch they are running on, instead
   *  of listing the branches and then the sessions as two flat blocks. OFF by
   *  default: it re-homes every row in a project the moment it goes on, and the
   *  flat list is right for the common case of one checkout with a handful of
   *  forks in it. See viewmodel.buildViewModel. */
  groupSessionsByBranch: 'groupSessionsByBranch',
  /** Where New Worktree… puts a new checkout. A PATTERN over `${repo}` and
   *  `${branch}`, resolved against the repository's main worktree, because the
   *  answer is a convention rather than a path: somebody who keeps every
   *  checkout in `~/worktrees` wants that for every repository, not a dialog per
   *  worktree. See worktreePathFor. */
  gitWorktreePath: 'git.worktreePath',
  /** THE ONE SETTING THAT REACHES THE NETWORK, and the reason it is off by
   *  default rather than merely documented. Everything else in Flock reads local
   *  files and local processes; turning this on has the extension run `gh pr
   *  list`, which talks to GitHub as the user. See src/pullRequests.ts. */
  gitPullRequests: 'git.pullRequests',
  /**
   * PREVIEW: branches belong to a DIRECTORY, and the fold lists the whole
   * repository.
   *
   * Two changes at once, because they are one idea. A project's directories are
   * its subprojects, so a directory that happens to be a git repository is the row
   * a branch belongs under — not the project, which may span three repositories
   * and cannot say which `main` is which. And once a branch row is anchored on a
   * repository rather than on a union, listing every `refs/heads/` entry becomes
   * affordable: the fold is shut by default, so a repository with a hundred and
   * eighty branches costs ONE row until asked for.
   *
   * A preview rather than a default because it changes where every branch row in
   * the tree sits, and because the fold's promotion policy — the directory's own
   * checkout and anything with a session on it, everything else folded — is the
   * kind of judgement worth using for a week before it becomes the only option.
   * Off, the tree is byte-identical to the one that shipped.
   *
   * Draws in the INLINE sidebar (`lineage.viewStyle: inline`, the default). The
   * native tree keeps the rows it has today — a split project's directories and
   * their sessions, with no branch block — which is what it already drew, so
   * nothing there regresses and nothing is half-rendered.
   */
  previewDirectoryModel: 'preview.directoryModel',
  staleAfterHours: 'staleAfterHours',
  busyStaleMinutes: 'busyStaleMinutes',
  // Notifications
  notificationsEnabled: 'notifications.enabled',
  notificationsPopup: 'notifications.popup',
  /** `lineage.mode` — what a WINDOW is, in three values.
   *
   *  `folder` (the default, labelled *One folder per project*): the window is
   *  the folder you opened, the tree scopes itself to sessions under it, and
   *  in-window project switching does not exist — the switch verb refuses, no
   *  workspace status-bar item is drawn; other projects' rows route to their
   *  own windows. `flock` (*Flock only*): the window is Flock's — nothing is
   *  fenced, the tree holds everything, nothing rearranges itself, but the
   *  switch verb is still there for somebody who runs it on purpose.
   *  `project` (*Auto-switch*): one window spans many projects, switches
   *  between them transactionally, and switches FOR you when your attention
   *  moves.
   *
   *  Parsing, the migration and the gates all live in src/modes.ts; the
   *  RESOLVED value is mirrored into the CONTEXT_MODE key for the manifest's
   *  when-clauses. */
  mode: 'mode',
  // Workspaces (the two models that have a switcher)
  /** `lineage.workspaces.enabled` — SUPERSEDED by `lineage.mode`, still
   *  honoured, and read in exactly one place: `modes.resolveMode`. While this
   *  is `false` and the mode is `project`, the window resolves to `flock` —
   *  which is what that pair already meant before the third value existed, so
   *  the fold moves nobody. Nothing else in the source may read this key: a
   *  second reader is a second answer to "which model is this window in", and
   *  the whole point of the third value is that there is only one. Retired by
   *  the user's own hand — the window-model picker writes it back to `true`
   *  when somebody chooses auto-switch — never by an activation that edits a
   *  settings file nobody asked it to touch. */
  workspacesEnabled: 'workspaces.enabled',
  workspacesResumeSessions: 'workspaces.resumeSessions',
  workspacesAutoSwitch: 'workspaces.autoSwitch',
  // The Explorer follows the project
  explorerFollowProject: 'explorer.followProject',
  /** How much of the project the Explorer shows: `directory` (the one you are
   *  working in, the default) or `project` (every connected directory as its own
   *  root). Read fresh on every sync — see ExplorerHost.scope — so flipping it
   *  takes effect on the next switch rather than on the next reload. */
  explorerScope: 'explorer.scope',
  /** Show the Accounts view. The VERBS stay registered when this is off —
   *  turning it off means "I do not want a second list in my sidebar", not
   *  "unregister ten commands so the palette reports them missing". The
   *  manifest's view contribution matches on `config.lineage.accounts.enabled`,
   *  which is this key spelled the way a when-clause spells it. */
  accountsEnabled: 'accounts.enabled',
  /** Draw Accounts as a SECTION of the Flock container. OFF by default, and
   *  that default is the reason the bell sits on the FLOCK row: a container
   *  showing two views gives each of them a header of its own, so every button
   *  landed a row lower behind an overflow `...`. AND-ed with `accountsEnabled`
   *  in the view's when-clause — `accountsEnabled` stays the feature's off
   *  switch, this only decides whether the list is drawn in the sidebar. */
  accountsSection: 'accounts.section',
  /** Offer to move a conversation when the account it is on runs out of its
   *  five-hour window. OFF by default, and that default is the point: the
   *  switch is a real interruption — the CLI restarts and the prompt cache does
   *  not follow — so a notification proposing one is only welcome to somebody
   *  who has decided in advance that they would rather be asked. Everyone else
   *  gets the verb in the row's menu and no opinions. */
  offerSwitchAtLimit: 'accounts.offerSwitchAtLimit',
} as const;

/**
 * WHAT "BRANCHES AND WORKTREES" IS, as a list of settings.
 *
 * The feature is four keys, each off for its own reason, and
 * `lineage.showBranchesAndWorktrees` writes all four. The table lives here rather
 * than inside that command's implementation for one reason: `off` is supposed to
 * be the manifest's own default, and a copy of a default that nothing checks is a
 * copy that drifts. Here, a test can hold it against `contributes.configuration`
 * — see scaffold.test.ts.
 *
 * `on` is not the mirror image of `off` for the detail level: `standard` is right
 * for somebody who turned one switch on, `detailed` for somebody who asked for
 * all of it and wants the words the arrows cannot say.
 *
 * `lineage.git.branchDisplay` is deliberately NOT in here. It is a preference
 * about how rows read, not a thing to switch on, and its default is already the
 * mode somebody turning the feature on wants to meet. Writing it would also make
 * the Hide half destructive in a way none of the others are: it would throw away
 * a choice the person made, where every line above only puts a default back.
 */
export const BRANCH_FEATURE_SWITCHES: readonly {
  readonly key: string;
  readonly on: boolean | string;
  readonly off: boolean | string;
}[] = [
  { key: CONFIG_KEYS.gitBranches, on: true, off: false },
  { key: CONFIG_KEYS.gitSessionBranchDetail, on: 'detailed', off: 'standard' },
  { key: CONFIG_KEYS.gitPullRequests, on: true, off: false },
  { key: CONFIG_KEYS.previewDirectoryModel, on: true, off: false },
] as const;

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
/** The two lit compaction phases — see src/compaction.ts, which owns every
 *  rule about when a session is in one. Declared HERE rather than there for
 *  the reason at the top of this file: types.ts imports nothing, so every
 *  layer can depend on it, and SessionNode needs this name. */
export type CompactionPhase = 'compacting' | 'compacted';
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
  /** The title the CLI generated for this conversation — its own `ai-title`
   *  record, read from the same bounded head as `label`. A DIFFERENT class of
   *  name from `label`: a person chose that one, a model wrote this one. It is
   *  still shown unmarked, because it is a genuine title OF this conversation
   *  and the thing it replaces is an eight-character hex id. Present in 154 of
   *  the 278 transcripts on the machine this was measured on, always inside the
   *  existing head window, and never contradicting itself when the CLI
   *  re-emits it later in the same file. */
  aiTitle?: string;
  /** The opening words of the conversation — the first thing a PERSON typed,
   *  whitespace-collapsed. The last resort before a hex id, and never a title:
   *  callers quote it (see `transcriptFallbackName`) so a row says "these are
   *  the words it started with", not "this is what it is called". CLI plumbing
   *  is filtered out at the source — tool results, injected preambles,
   *  sub-agent turns, compaction continuations and `<bash-input>` echoes are
   *  not things anybody typed. */
  firstPrompt?: string;
  /** The transcript's OWN head names a different session id and carries
   *  no forkedFrom marker: this file is a plain-`--resume` CONTINUATION of
   *  that session, not a fork of it. Verified against real data: every fork
   *  transcript rewrites its copied head to its own id and writes forkedFrom,
   *  so head-mismatch-without-marker is unambiguous. This is the signal that
   *  lets one logical conversation, re-minted across several session ids, be
   *  collapsed to a single row (see generations.ts). */
  continuesId?: string;
}

/**
 * A session this machine knows about that the tree is NOT currently showing —
 * what the Add Session and Import pickers list. Chain-collapsed: one entry per
 * conversation, keyed by its tip, never one per superseded generation.
 *
 * Two sources, one shape: a live roster row Flock does not own (`live: true`,
 * facts from `claude agents --json`), or a finished transcript with no
 * editorial record (`live: false`, facts from the archive index). Both are
 * facts ABOUT the pool, not a claim of ownership — adding one is what writes
 * the record.
 */
export interface UnlistedSession {
  sessionId: string;
  /** Running right now, somewhere Flock does not own. */
  live: boolean;
  cwd?: string;
  /** Roster `name` / transcript `custom-title` — best available, may be absent. */
  label?: string;
  /** Transcript mtimeMs — last activity. Absent for a live row (its answer is
   *  "now", and pretending to know it more precisely would just be a lie the
   *  picker sorts by). */
  endedAt?: number;
}

/**
 * What `recommendedPlan` (src/recommend.ts) needs to know about this machine.
 *
 * Facts, never preferences: which settings are where, what is installed, what
 * the tree holds, and one git probe. The preferences — what a fresh install
 * SHOULD have, and what it should merely be offered — are what that module
 * decides from these.
 *
 * It lives here rather than beside the function for the reason `UnlistedSession`
 * does: `CommandDeps` names it, and types.ts imports nothing so that every
 * layer can depend on it.
 */
export interface RecommendedWorld {
  /** `process.platform`. */
  readonly platform: string;
  /** `findTmuxBinary()`, injected so tests need no PATH. */
  readonly tmuxBinary: string | null;
  /** `lineage.tmux`. */
  readonly tmuxMode: string | undefined;
  readonly hooksInstalled: boolean;
  readonly verbsInstalled: boolean;
  /** Whether this wiring has the verbs manager at all. Every real activation
   *  does; a unit double need not, and a step that cannot be run must never be
   *  offered. */
  readonly verbsAvailable: boolean;
  /** Any project at all, CLOSED ones included: somebody who closed their last
   *  project has met the concept, and telling them to make their first one
   *  would be wrong. */
  readonly hasProjects: boolean;
  /** Sessions this machine knows about that have no row —
   *  `unlistedSessions().length`. */
  readonly unlistedCount: number;
  /** `lineage.git.branches`. */
  readonly branchRowsEnabled: boolean;
  /** The most checkouts any one of the user's repositories has. The same probe
   *  `branchRowsAdvice` needs, and load-bearing for the same reason: a
   *  single-checkout repository draws no branch rows, so offering them to its
   *  owner is offering nothing. */
  readonly maxWorktrees: number;
  /** `lineage.terminalLocation`, normalized to its three legal values — the
   *  same `isTerminalLocationPref` read every launch makes. Where a
   *  Flock-launched session's terminal goes; one leg of the answer to "where do
   *  sessions open today" that `surfaceChoices` marks as current. */
  readonly terminalLocation: TerminalLocationPref;
  /** `lineage.soloSession` — the other leg: editor tabs one at a time (pinned,
   *  the rest parked) or side by side. */
  readonly soloSession: boolean;
  /** `lineage.launch.mode` AS CONFIGURED, not as resolved. Resolution needs the
   *  extension-presence fact below, and `surfaceChoices` does it with the same
   *  `resolveLaunchMode` every launch uses — so a mode naming a missing
   *  extension is still distinguishable from `flock` chosen on purpose. */
  readonly launchMode: string | undefined;
  /** Whether the official Claude Code extension is installed — the one fact in
   *  this shape only a host can answer (`vscode.extensions.getExtension`). */
  readonly claudeExtensionInstalled: boolean;
  /** `lineage.mode` AS CONFIGURED, not as resolved — `launchMode`'s contract
   *  exactly, and for the same reason: resolution needs the second fact below,
   *  and `windowModelChoices` performs it with the same `resolveMode` every
   *  gate in the extension runs, so the picker can never call "current" a model
   *  the window is not actually in. */
  readonly mode: string | undefined;
  /** `lineage.workspaces.enabled`, raw. The other half of the pair
   *  `resolveMode` folds; the picker needs it to know whether a `project`
   *  window is really auto-switching or is the Flock-only model wearing the old
   *  spelling. */
  readonly workspacesEnabled: boolean;
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
                              // archive.label > header.customTitle >
                              // archive.aiTitle > “archive.firstPrompt” >
                              // shortId. The last two are archived-only; see
                              // archive.transcriptFallbackName for why the
                              // generated title is shown bare and the prompt
                              // is shown in quotes.
  /** This node's `label` is a QUOTATION of the conversation's opening words,
   *  not a name anybody chose. The quote marks say that to a reader; this flag
   *  says it to code. Only one consumer needs it so far — terminal-tab naming,
   *  which must fall back to the CLI's own `claude · 1a2b3c4d` rather than put
   *  `“cd ..”` on a tab — but every future caller that WRITES a label
   *  somewhere, as opposed to showing it, wants to ask this first. Absent
   *  (never `false`) on every node whose name is real, so the common case
   *  costs nothing. */
  labelIsFallback?: true;
  /** The close-with-summary text, when one was recorded. Carried on the node
   *  so the tooltip can show it — otherwise the text the user typed would be
   *  reachable only by hand-reading state.json. */
  summary?: string;
  /** The last real conversation text visible in the transcript's bounded tail
   *  — the final assistant reply when the window holds one, else the last user
   *  prompt (see usage.readTailStats). Level 2 exists to answer "what did that
   *  branch conclude?" without resuming, and this is the answer where no
   *  `summary` was recorded — but it is a HOVER fact, not a row fact, and has
   *  been since the 2026-08-28 review: beside a name and an age it was the
   *  widest thing on a closed row and read as the row's identity. Carried on
   *  every node the tail sweep covered, because the fact is the same for a
   *  live session; only the hover ever shows it. */
  lastExchange?: string;
  /** Epoch ms of `record.graceUntil` — this session is running DETACHED under
   *  the detach grace (tab closed, process alive so re-attach is instant), and
   *  this is when the sweep will end it. The one sanctioned detached-running
   *  state, and the spec's condition for sanctioning it is that the process
   *  must have a ROW — which it does. The countdown itself lives in the row's
   *  HOVER rather than in its description (the 2026-08-28 review: the row's
   *  existence, not its wording, is what makes the state reachable), so this
   *  field feeds `viewmodel.graceTooltipLine` and the `;grace;` context token
   *  that puts Close Now / Keep Awake on the menu. Present only on LIVE nodes
   *  — an archived record's stale deadline describes a process that no longer
   *  exists — and kept even past expiry, because a busy session outlives its
   *  deadline on purpose (close-after-turn) and a row must never go quiet
   *  while its process runs. */
  graceDeadlineAt?: number;
  /** The session finished a turn (`doneAt`) and the user has not looked at it
   *  since — the attention dot. Computed per build from the editorial record;
   *  `undefined` means "not tracked" (notifications off for this session, or a
   *  node kind that has no unseen state), which the renderers treat as the
   *  older, unseen-blind behaviour. */
  unseen?: boolean;
  /** This conversation is being compacted right now (`'compacting'` — the
   *  purple ring), or was just compacted and nothing has been asked of it
   *  since (`'compacted'` — the full purple dot). Absent on every session that
   *  is in neither phase, which is nearly all of them nearly all of the time.
   *
   *  Computed per build from the in-memory CompactionTracker (src/compaction.ts)
   *  rather than read off the editorial record: a compaction phase is a fact
   *  about a running process, minutes long, and writing it to disk would
   *  outlive the process it describes. */
  compaction?: CompactionPhase;
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
 * One LOCAL BRANCH of a repository — a `refs/heads/` entry, checked out or not.
 *
 * The other half of {@link Worktree}, and a separate type because it answers a
 * different question. `git worktree list` says which branches have a DIRECTORY;
 * this says which branches EXIST. A repository with two checkouts and a hundred
 * and eighty branches produces two Worktrees and a hundred and eighty of these,
 * and the difference between the two lists is exactly what the branch fold holds.
 *
 * `committedAt` rather than a formatted age: the extension formats in one place
 * (see formatBranchAge) and a row that carried git's own relative date would be
 * a second opinion about what "2 days ago" means. 0 means the field could not be
 * read, which sorts last rather than sorting as 1970.
 */
export interface LocalBranch {
  /** Short name — `refs/heads/` stripped, so `feat/x` rather than the full ref. */
  name: string;
  /** Unix seconds of the branch tip's commit date, or 0 when unreadable. The
   *  recency sort, and the one fact that makes a long list navigable. */
  committedAt: number;
  /** The commit the branch points at. Carried for the hover. */
  head: string;
}

/**
 * What one checkout can say about itself beyond its name: how far it has
 * diverged from its upstream, and whether there is work in it that no commit
 * holds yet.
 *
 * Read per WORKTREE, not per repository — that is the whole reason it is a type
 * of its own rather than three fields on Worktree. `git worktree list` reports
 * the same answer from any checkout of the repo; ahead/behind and dirt are
 * facts about one directory, so they need one probe each (see src/gitBranches.ts
 * for the caching that keeps that off the render path).
 *
 * Every field has a meaning for "we could not tell", and none of them is a
 * guess: `upstream === ''` is "this branch tracks nothing", which is NOT the
 * same as `ahead === 0 && behind === 0` ("in sync"), and the absence of the
 * whole object is "not read yet, or not readable at all". A row with no status
 * renders exactly as it did before this existed.
 */
export interface BranchStatus {
  /** Commits this checkout has that its upstream does not. 0 when there is no
   *  upstream to compare against — read `upstream` to tell the two apart. */
  ahead: number;
  /** Commits the upstream has that this checkout does not. */
  behind: number;
  /** The upstream ref, short (`origin/feat/x`), or '' when the branch tracks
   *  nothing. Carried for the hover: "2 ahead" is only useful next to what it
   *  is ahead OF. */
  upstream: string;
  /** TRACKED changes: staged, unstaged, or a merge conflict. */
  dirty: boolean;
  /** Files git has never been told about. Kept apart from `dirty` because the
   *  two answer different questions — a row shows them as the same mark, and
   *  Remove Worktree has to name which one it is about to delete. */
  untracked: boolean;
}

/**
 * The outcome of a git command Flock ran on the user's behalf.
 *
 * Only the two WORKTREE verbs produce one: everything else this extension asks
 * git is a read whose failure means "render the row plainly" and needs no
 * report. A verb the user confirmed is different — it either happened or it did
 * not, and if it did not, the reason is git's and belongs on screen verbatim
 * rather than paraphrased into "something went wrong".
 */
export interface GitCommandResult {
  ok: boolean;
  /** git's own output, both streams, trimmed and length-capped. Shown to the
   *  user on failure and logged either way. */
  output: string;
}

/** How a pull request stands. `draft` is a state of its own rather than a flag
 *  on `open`, because a row has one word of room and draft is the one of the two
 *  you do something different about. */
export type PullRequestState = 'draft' | 'open' | 'merged' | 'closed';

/** The check rollup, reduced to the four outcomes a row can usefully draw.
 *  `none` covers both "no checks configured" and "gh reported none", which a row
 *  cannot tell apart and must not pretend to. */
export type PullRequestChecks = 'none' | 'pending' | 'pass' | 'fail';

/**
 * How much the line under a session says — `lineage.git.sessionBranchDetail`.
 *
 * `standard` is the DEFAULT and is deliberately not a reduced version of
 * `detailed`: it is the vocabulary git prompts, starship and the SCM view
 * already use, `↑4 ↓3 *`, so the line reads without anybody learning it. It
 * reaches nothing but the local status cache.
 *
 * `detailed` adds the pull-request chip and the two states the arrows render as
 * blank — `local` for a branch that tracks nothing, and the word `merged`, which
 * is the signal that a worktree can be removed. The chip half of it is empty
 * unless `lineage.git.pullRequests` is also on, since that is what fills the
 * cache it reads.
 */
export type SessionBranchDetail = 'standard' | 'detailed';

/**
 * HOW A SESSION SAYS WHICH WORKTREE IT IS IN — `lineage.git.branchDisplay`.
 *
 * Two modes, and the point is that they are alternatives rather than a switch
 * with an on position. Both answer the same question and they spend different
 * things to do it:
 *
 *   `color`   The session's NAME takes the branch's colour, and the project's
 *             branch block is the KEY — one coloured row per checkout. It costs
 *             no width at all and it answers "are these two on the same thing"
 *             instantly, down a column, without reading a word. What it cannot
 *             say is WHICH thing, and everything a colour cannot carry — ahead,
 *             behind, dirty, the request — is in the hover instead of on the
 *             row. This is what shipped, and it is one setting away.
 *
 *   `inline`  The branch is said in words on a second line under the session,
 *             the way a git prompt says it, and the name goes back to the
 *             theme's own colour. It answers "which thing" and carries the
 *             state tokens where they can be read at a glance. It costs a row's
 *             height — twelve sessions become twenty-four rows' worth — and it
 *             needs no legend, which is why the block is shut by default here
 *             and open in `color`. THE DEFAULT, once the feature is on at all.
 *
 * Everything else is the same in both: the branch rows exist, the worktree
 * verbs work, the pull-request lookup runs, `+` starts a session on a branch.
 * This decides how a row READS, never what the feature can do.
 */
export type BranchDisplay = 'color' | 'inline';

/** What an unset `lineage.git.branchDisplay` means.
 *
 *  `inline`, and the argument is that this setting is only ever read by somebody
 *  who has just turned `lineage.git.branches` ON — the feature is off by default,
 *  so there is no existing tree to keep identical here. Given a person meeting
 *  the branch feature for the first time, the mode that says WHICH branch in
 *  words beats the one that says "same as that one" in a colour and needs a
 *  legend to say more. `color` is one setting away for anybody who wants the
 *  density back. */
export const DEFAULT_BRANCH_DISPLAY: BranchDisplay = 'inline';

/** Narrowing for the configuration read — an unknown string is the default,
 *  never a third mode. */
export function isBranchDisplay(value: unknown): value is BranchDisplay {
  return value === 'color' || value === 'inline';
}

/**
 * One pull request, as the `gh` CLI reported it.
 *
 * THE ONLY THING IN FLOCK THAT COMES FROM THE NETWORK, and it does not come from
 * Flock: `gh pr list` is a binary the user installed, authenticated and pointed
 * at their own host, and the extension reads its stdout. That indirection is the
 * design, not a shortcut — see src/pullRequests.ts. Behind
 * `lineage.git.pullRequests`, off by default.
 */
export interface PullRequest {
  number: number;
  title: string;
  state: PullRequestState;
  checks: PullRequestChecks;
  /** The branch the request is FROM (`headRefName`) — the join key onto a branch
   *  row, and the reason nothing else needs matching. */
  branch: string;
  /** The html url `gh` gave us. Opened in a browser, never fetched. */
  url: string;
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
  /**
   * The worktree directory this branch is checked out in — where a session
   * started from this chip will run.
   *
   * '' MEANS THERE IS NO CHECKOUT: a branch that exists as a ref and nowhere on
   * disk (see LocalBranch), which is most of a real repository's branches. The
   * empty path is the flag rather than a `checkedOut` boolean beside it, because
   * every verb on a branch row already keys off this field — you cannot start a
   * session in a directory that does not exist, and `isCheckedOut` /
   * `isExistingWorktree` in src/worktrees.ts both compare it — so a second field
   * would be a fact two places could disagree about. A row with no dir offers
   * **New Worktree…** instead of a `+`.
   */
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
  /**
   * Unix seconds of the branch tip's commit, from LocalBranch.committedAt, or
   * absent when it was never read.
   *
   * Only the fold has any use for it, and it is the reason the fold is navigable:
   * a hundred and eighty branches in alphabetical order is a wall, and the same
   * list newest-first is a history. Absent rather than 0 so a row built by a
   * caller that predates branch enumeration reserves no width for an age it
   * cannot state — the same rule `sync` follows.
   */
  lastCommitAt?: number;
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
  branchesShown?: boolean;
  /**
   * SUBPROJECTS: this project's directories, one row each, WITH the sessions
   * running in each of them.
   *
   * Empty for a project with one directory, which is the ordinary case and the
   * layout the tree has always had — see projects.buildSubprojects for why the
   * threshold is two. Non-empty means `rootIds` has been split across these
   * entries and the project row draws no sessions of its own.
   *
   * OPTIONAL so a node built by a caller that predates this is still a valid
   * node: absent reads as "no subprojects", i.e. sessions directly under the
   * project.
   */
  subprojects?: SubprojectNode[];
  /**
   * Where this row sits in the project tree — RETIRED but still read.
   *
   * Nesting a project record under another one is gone: v6 folds every such
   * child into its ancestor's directory list (see STATE_SCHEMA_VERSION). These
   * three fields stay because the tree builder stays, and the tree builder stays
   * because `state.json` is merged across windows and hand-editable: a record
   * carrying a `parentId` an older build wrote has to render as SOMETHING, and
   * "indented under its parent until the next activation migrates it" is a
   * better answer than a row nobody draws.
   *
   * Nothing creates them any more, so on a migrated store every project is
   * `depth: 0` with no children — which is exactly the flat list the renderers
   * treat as the default.
   */
  parentProjectId?: string | null;
  depth?: number;
  /** Child project ids, in display order (name-sorted). */
  childProjectIds?: string[];
}
/**
 * One DIRECTORY of a project, as a row.
 *
 * The whole of what a subproject is, after v0.1.1: a project is scoped to one
 * directory, adding a second splits it into two of these, and each one takes the
 * sessions running under its own directory. There is no record behind it, no
 * name to invent, no provider, no account, no workspace and no settings menu —
 * which is the point. It sorts rows and nothing else.
 *
 * `dirKey` rather than `dir` as the identity: the row key, the collapse state and
 * every verb round-trip through it, and two spellings of one directory
 * (`/Code/api` and `/code/api` on a case-insensitive filesystem) must not become
 * two rows. `dir` is what gets shown and what a session is started in.
 */
export interface SubprojectNode {
  type: 'subproject';
  projectId: string;
  /**
   * IDENTITY. The SubprojectRecord.id for a named lane, or `dir:<dirKey>` for an
   * implicit one.
   *
   * The row key, the collapse key and every verb's target round-trip through this
   * rather than through `dirKey`, because two lanes may name the SAME directory
   * and a shared key would make one row's click land on the other. The implicit
   * form is prefixed so that it can never collide with a uuid, and so a reader can
   * tell the two kinds apart without consulting the store.
   */
  id: string;
  /** A user-chosen name, or '' for an implicit row — which takes the directory's
   *  basename as its label instead. What `implicit` is really asking. */
  name: string;
  /** No record behind it: this row IS a directory of the project. Drawn for every
   *  directory nobody has named a lane in, and — for as long as it is holding a
   *  session — for one somebody has, which is where the sessions that predate the
   *  lane live and why a new lane is empty. Every project before v7 draws only
   *  these, which is why the tree is unchanged. See buildSubprojects. */
  implicit: boolean;
  /** The directory, in its canonical display spelling. */
  dir: string;
  /** pathKey(dir). NO LONGER IDENTITY — see `id`. Still carried because the
   *  branch block is the branches of the repository at this path, and because
   *  membership for an unstamped session is decided by it. */
  dirKey: string;
  /** What the row draws: the lane's `name`, or for an implicit row the
   *  directory's basename — disambiguated when two of the project's directories
   *  share one (`api/src` and `web/src` both being "src" is ordinary in a
   *  monorepo). */
  label: string;
  /** True for the row standing for the project's MAIN directory — its `rootDir`,
   *  the one a project-level verb defaults to. Only ever set on an IMPLICIT row:
   *  a named lane is removable whatever directory it names, because removing it
   *  removes a name rather than the project's address. */
  main: boolean;
  /** Visible root sessions whose cwd sits under this directory and no deeper
   *  directory of the same project — including the ones running in a checkout of
   *  the repository at it, which is what leaves no session for a project-wide
   *  row to hold. See projects.buildSubprojects. */
  rootIds: string[];
  /**
   * The branches of the repository AT this directory, promoted ones first, in
   * display order — the whole list, not only the checkouts.
   *
   * THE DIRECTORY IS WHERE BRANCHES BELONG. A project spanning three directories
   * can span three repositories, so "the project's branches" was a union that
   * could not say which repository a row came from, and a `main` from two of them
   * was two rows with one name. A directory is exactly one repository (or none),
   * which makes this list unambiguous and the row it hangs under the answer to
   * "of what?".
   *
   * Empty for a directory that is not in a repository, for one whose probe has
   * not landed, and for every project while `lineage.preview.directoryModel` is
   * off — all three render as a directory row with no branches under it, which is
   * the layout that shipped before this existed.
   *
   * OPTIONAL so a node built by a caller that predates it is still a valid node.
   */
  branches?: BranchInfo[];
}
/**
 * A NAMED SUBPROJECT — a lane of work inside one directory.
 *
 * v7, and the one thing the directory-only model could not express: two pieces of
 * work in the SAME folder. A monorepo at `~/magma-cs-mcp` is one directory, and
 * "the server rewrite" and "the CS tooling" are two bodies of work in it — so
 * subprojects cannot be a function of the directory set, because there is only one
 * directory and there are two of them.
 *
 * A RECORD OF ITS OWN, keyed by id, rather than an array on ProjectRecord. That is
 * not a preference: `projects` merges newest-WINS per record, so a list written by
 * two windows a second apart loses one of the entries for good — the argument
 * ProjectRecord.parentId already makes at length about why children are never
 * stored as an array. One record per lane means one writer per lane and a merge
 * that cannot drop anybody's.
 *
 * DELIBERATELY SMALL, and worth saying because the v6 migration removed something
 * that looked like this. What it removed was a subproject that was a whole
 * PROJECT — its own provider, its own AI account, its own saved workspace, its own
 * routing, nested to any depth. This is a name, a directory and a parent. It cannot
 * nest, it has no provider, it has no account, and there is nothing to configure on
 * it. The name exists because nothing else can tell two lanes in one folder apart;
 * everything else stayed gone.
 */
export interface SubprojectRecord {
  /** uuid, minted at creation. The row key, the collapse key and the stamp on
   *  every session started here — see EditorialRecord.subprojectId. */
  id: string;
  /** The project this lane belongs to. A pointer UP, for the same reason
   *  ProjectRecord.parentId is one. A lane whose project no longer exists is
   *  swept, not re-rooted: a lane means nothing without the project it names. */
  projectId: string;
  /** User-chosen, and the whole reason this record exists. */
  name: string;
  /**
   * The one directory this lane runs in.
   *
   * Not optional and not a list. A lane is where work happens, so it has an
   * address — the `+` on its row has to start a session somewhere, and its branch
   * block is the branches of the repository at exactly this path. Several lanes
   * may name the SAME directory, which is the entire point.
   *
   * It does not have to be one of the project's own `dirs`, and is not checked
   * against them here: the project's directory list decides which sessions the
   * project CLAIMS, and re-pointing a project would otherwise silently invalidate
   * its lanes. A lane on a directory the project no longer covers still draws, and
   * still starts sessions where it says.
   */
  dir: string;
  /**
   * The lane's PINNED BRANCH — the one piece of git context a lane may carry.
   *
   * When set, the lane's work is the BRANCH, and `dir` is only where the branch
   * happened to live when the lane was made: the deep switch reveals (and the
   * lane's `+` starts sessions in) whatever checkout has this branch out TODAY,
   * which for a worktree-per-agent workflow moves as worktrees come and go. See
   * src/deepSwitch.ts for the resolution rule; the fallback when no checkout
   * has the branch is always `dir` itself — nothing on a switch path ever
   * CREATES a worktree (that stays a user-confirmed verb, src/worktrees.ts).
   *
   * Optional, and absent means "the directory answers on its own" — every lane
   * from before this field behaves exactly as it always did. Short name
   * (`feat/x`), never a full ref.
   */
  branch?: string;
  /** TOMBSTONE, exactly as ProjectRecord.deleted is and for the same reason: a
   *  dropped key is indistinguishable from "the other window has not heard of it
   *  yet", and any window still holding the lane re-adds it on its next write. */
  deleted?: boolean;
  createdAt: string;
  /** ISO; record-level merge key (newest wins). */
  updatedAt: string;
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
  /** The repository's MAIN worktree — the same value for every branch row under
   *  one project, and the anchor the pull-request lookup is keyed on.
   *
   *  Carried rather than looked up because this node is INTERNED (see branchRef):
   *  the workbench keys expansion state on element identity, so the fields have
   *  to be things that change when the row genuinely becomes a different row. A
   *  repository's main worktree qualifies; its pull request, which changes when a
   *  colleague pushes, very much does not — that is read live in branchItem. */
  repoDir: string;
  colorIndex: number;
  primary: boolean;
  rootIds: string[];
}
export type TreeNode =
  | GroupNode
  | ProjectGroupNode
  | SubprojectNode
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
   *  end this session — its tab is here, another Flock window has it, or it
   *  runs detached under the grace — and is what the Close verbs match on.
   *  `foreign` means the process belongs to something else (a terminal, the
   *  Claude Code extension, another app), where a close could only write a
   *  timestamp onto a conversation that carries on running. See src/hosts.ts. */
  | 'hosted'
  | 'foreign'
  /** A THIRD ownership token, on a live row whose terminal is bound in THIS
   *  window — the strict half of `hosted`, never emitted without it.
   *
   *  `hosted` deliberately spans three situations (a tab here, another Flock
   *  window, a detached wrap under the grace) because the verbs that merely
   *  END a session can honestly serve all three. The verbs that have to TYPE
   *  into a terminal cannot: Close with Summary sends `/compact` and reads the
   *  summary back, and Wrap Up sends a sentence, and neither has anything to
   *  type into when the terminal belongs to another window or does not exist
   *  yet. Those match on this token instead, so the menu stops offering what
   *  the verb would only refuse.
   *
   *  Emitted for an ABSENT host as well as for 'here', which keeps the
   *  back-compat contract the pair above states: a wiring with no opinion about
   *  ownership — every unit double — gets byte-identical menus to the ones it
   *  had before ownership existed. */
  | 'here'
  /** WHICH CLI wrote this conversation, as a complementary pair on every
   *  non-ghost session row. A ghost is an ancestor inferred from a child's
   *  edge: it has no transcript, so claiming a CLI for it would be the same
   *  made-up fact the icon code already refuses to draw for one.
   *
   *  It exists because "Move to Account…" can only move a Claude conversation
   *  — Codex keeps its history somewhere else entirely, in a layout this
   *  extension does not relocate — and the manifest needs a POSITIVE clause to
   *  say so, since it never negates a viewItem regex (see the visibility pair
   *  above).
   *
   *  Resolved from the session's own record, or from which history store its
   *  transcript sits in, and NEVER from the owning project's provider: that
   *  fallback is right for a glyph and catastrophic here, because a project
   *  switched to Codex would otherwise relabel every Claude conversation
   *  filed under it and withdraw a verb that works. An unwired lookup reads as
   *  'claude', so the failure this pair prevents is a Codex row being OFFERED
   *  the verb, never a Claude row being denied it. */
  | 'claude'
  | 'codex'
  /** This session runs DETACHED under the grace countdown
   *  (SessionNode.graceDeadlineAt): its tab is gone, its process is alive so
   *  re-attach is instant, and the sweep will end it at the deadline. A THIRD
   *  token beside 'live' + the ownership pair, never a replacement for them —
   *  a grace row keeps every live verb (it IS live) and gains the two that only
   *  make sense while the countdown runs: Close Now (why wait out the timer)
   *  and Keep Awake (make the timer never fire). */
  | 'grace'
  /** The "Running elsewhere" GROUP row — the collapsed appendix folder mode
   *  renders for running sessions its filters would otherwise drop (cwd
   *  outside the window's folders, or every claiming project closed). Its own
   *  token rather than 'group' so the folder verbs (hide, open) never appear
   *  on a row that is not a folder: it has no cwd and exists purely so that
   *  "every running process has a row in every window" survives the fences. */
  | 'elsewhere'
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
  /** This branch row has a pull request behind it. A THIRD token on a branch
   *  row, never alone, and it exists for exactly one `when` clause: "Open Pull
   *  Request in Browser" is a verb with nothing to open on a branch that has no
   *  request, and a menu entry that reports "no pull request" when clicked is a
   *  menu entry that should not have been drawn. Absent for everybody with
   *  `lineage.git.pullRequests` off, which is everybody by default. */
  | 'pullRequest'
  /**
   * This branch row HAS A CHECKOUT — a directory on disk that a session could
   * run in.
   *
   * A fourth token on a branch row, never alone, and the one that makes the
   * branch fold safe to open. Under `lineage.preview.directoryModel` the fold
   * lists every local branch of the repository, and most of them have no worktree
   * at all: there is nowhere to start a session, nothing to reveal in Finder, no
   * path to copy and nothing for `git worktree remove` to take away. Every verb
   * that needs a directory matches on this token, so those entries are simply
   * absent on a branch that is only a ref — rather than drawn and then failing
   * with git's error about a path the user never typed.
   *
   * Present on every branch row when the preview is off, because a branch row
   * could only come from a worktree then.
   */
  | 'checkout'
  /** A NAMED subproject — a lane the user made and can rename, as opposed to an
   *  implicit row standing for one of the project's directories. A second token on
   *  a subproject row, never alone, and positive rather than negative for the
   *  reason branchTokens gives: Rename Subproject and Remove Subproject apply to a
   *  lane, and a directory row is governed by the project's directory verbs
   *  instead. */
  | 'named'
  /**
   * ONE DIRECTORY of a multi-directory project, on its own row.
   *
   * Distinct from 'project' for exactly the reason 'branch' is: the two rows
   * carry the same projectId, so a shared token would put the project's whole
   * menu — rename, close, delete, settings — on a row where none of it applies.
   * A subproject has two verbs and both are about the directory.
   *
   * REPURPOSED. Until v0.1.1 this was a second token on a project row that was
   * filed under another project. Nesting records is retired (see
   * COMMANDS.newSubproject), so the token now names the thing the word means to
   * a user: a directory inside a project.
   */
  | 'subproject'
  /** RETIRED with record nesting: 'parentProject', a project row with children
   *  under it. No row emits it and no `when` clause reads it. Left out of the
   *  union deliberately rather than kept as a dead member — an unused token is
   *  a `when` clause somebody will write against nothing. */
  /** A row in the Accounts view, and — as a SECOND token on the same row — the
   *  one of them the default routing names. Two tokens rather than two values
   *  of one, so that `viewItem =~ /;account;/` keeps matching every row while a
   *  verb that belongs only on the default one can single it out positively
   *  (the manifest never negates a viewItem regex; see the visibility-pair note
   *  above). No contributed verb needs it yet — the row's own ★ is what the
   *  user reads — but the row is where the fact lives, and inventing the token
   *  later would mean changing a contextValue every `when` clause matches. */
  | 'account'
  | 'default'
  /** A row in the Shells view — one terminal this window has bound. Its own
   *  token rather than 'session' even though the row carries a session id: a
   *  shell row's verbs are about a PROCESS (reveal its terminal, confirm its
   *  wrap) and the tree's session menu — fork, rename, hide, move to account —
   *  is a menu about a conversation, which would be nonsense on a list of
   *  ptys. */
  | 'shell'
  /** This shell is WRAPPED in the private tmux server. A second token on a
   *  shell row, never alone, and it marks the one fact on that row with a
   *  consequence: a wrapped shell survives a workspace switch (the pane is
   *  detached and reattached) where an unwrapped one is closed and resumed.
   *  Positive, like every other pair here, because the manifest never negates
   *  a viewItem regex. */
  | 'tmux';
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
   *  (archived).
   *
   *  THE USER CALLS THIS "ARCHIVED". The field keeps its old name because the
   *  state file is on real users' disks and `sanitizeRecord` already carries
   *  migration rules for two retired fields; a third rename would have a live
   *  blast radius and buy nothing that changing the words did not already buy.
   *  Note the vocabulary collision this leaves behind: `src/archive.ts` and
   *  `SessionNode.archived` mean level 2 (closed, read off disk), which is a
   *  DIFFERENT thing from the Archive verb that writes this flag. */
  deleted?: boolean;
  launchedByUs?: boolean;
  boundWindowId?: string | null; // window whose terminal hosts this session
  /** ISO; set by the wrap verb. WRITE-ONLY as things stand — nothing reads it,
   *  and no settlement machinery exists behind it, so do not assume a pending
   *  wrap is tracked anywhere just because this is stamped. */
  wrapRequestedAt?: string;
  /** ISO; set by Close with Summary the moment it types `/compact`, and unlike
   *  `wrapRequestedAt` it IS read.
   *
   *  It exists because a transcript may already contain compaction summaries
   *  from before this close — 29 of 43 real compactions measured on one machine
   *  stayed in the same transcript file as an earlier one — and without a floor
   *  to compare against, the reader would pick up last Tuesday's summary and
   *  present it as this branch's conclusion. `parseCompactSummary` takes it as
   *  `sinceMs`. It survives the close so that a person (or a later verb) can
   *  tell a recorded summary that Flock asked for from one typed by hand. */
  summaryRequestedAt?: string;
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
  /**
   * THE LANE STAMP: the SubprojectRecord.id this conversation was started in,
   * written once at launch and never rewritten.
   *
   * Every other kind of membership in Flock is DERIVED from the session's working
   * directory, and that is still true of which project a session belongs to. It
   * cannot be true of which named subproject: two lanes may name the same
   * directory, so the cwd of a session in one is byte-identical to the cwd of a
   * session in the other. Something has to record the answer, and the only honest
   * moment to record it is when the user chose — the `+` they clicked.
   *
   * Modelled on `profileId` above, deliberately, down to the inheritance:
   *
   *   - written by the launch path, from the row the launch came from;
   *   - a FORK carries its parent's stamp (a fork of the server rewrite is the
   *     server rewrite);
   *   - a new GENERATION of a chain carries the chain's, because a `/clear` is the
   *     same conversation under a new id;
   *   - never re-decided by anything else. Re-pointing a lane's directory, or
   *     adding a lane, does not move an existing session.
   *
   * Absent means "not started from a lane" — every session that predates this
   * field, and every one started by hand in a terminal. Those are placed the way
   * they always were: by directory, into that directory's default lane. A stamp
   * naming a lane that no longer exists is treated as absent for the same reason
   * a dangling `profileId` is: the row has to draw somewhere, and derived is the
   * answer that cannot be wrong.
   */
  subprojectId?: string;
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
  // ---- lifecycle ----------------------------------------------------------
  /** RETIRED at schema v8. The old workspace switch wrote `parked: true` —
   *  running (or resumable) but with no tab and no distinct row — and that
   *  invisible, unbounded state is how 84 detached sessions (~670 processes,
   *  32 GB) accumulated unseen. The state is now unrepresentable: a session is
   *  level 1 (running, shown), level 2 (`closed` set — no process, archived
   *  row, click to resume) or level 3 (`deleted`). sanitizeRecord reads a
   *  persisted `parked: true` (written by older builds) as archived — `closed`
   *  stamped, `tmux` cleared — and drops the field, so no record carries it
   *  past a load. Kept typed because foreign state files written by older
   *  windows still carry it and the sanitizer needs the name. */
  parked?: boolean;
  /** THE DETACH GRACE — the one sanctioned running-but-detached state, and it
   *  always renders (a countdown row in the tree). ISO deadline: closing this
   *  session's tab (a workspace switch, solo mode) left its tmux-wrapped
   *  process running so re-attach is instant, and at this moment the sweep
   *  ends it to level 2 (or, mid-turn, marks it `closeAfterTurn`). Written by
   *  the detach sweep next to `tmux`; cleared (`null`) together with it when a
   *  re-attach settles the claim. The pool of graced sessions is capped
   *  (idleClose.GRACE_POOL_CAP); overflow closes oldest-idle first. */
  graceUntil?: string | null;
  /** THE KEEP-AWAKE PIN: this session is exempt from every automatic close —
   *  the idle timer, grace expiry, grace-pool eviction. For long autonomous
   *  runs that look idle between turns. A pinned session is still level 1
   *  with a visible row; the pin holds a process open, never hides one. */
  pinned?: boolean;
  /** CLOSE-AFTER-THIS-TURN — the spec's queue, not a state. Set instead of
   *  closing when the idle timer (or an expired grace) lands on a BUSY or
   *  WAITING session: a turn in flight and a blocked permission dialog outrank
   *  tidiness everywhere in this extension. The sweep closes the session and
   *  clears the mark on the first tick that finds it idle; the user looking at
   *  the tab (active) also clears it — re-engagement outranks the queue. */
  closeAfterTurn?: boolean;
  /** STOWED BY A SWITCH — the workspace switch (and nothing else) put this
   *  session away, so the switch back may bring it home. Written by
   *  parkSweep's detach and kill tiers next to the grace deadline / `closed`
   *  stamp, and it is what lets the restore tell close-by-switch from
   *  close-by-user: an archived record WITHOUT this marker was closed by a
   *  user verb (Close, Close Now, Delete, a tab ×) or by the idle timer, and
   *  a saved layout naming it must NOT resurrect it — "user closed stays
   *  closed" held on the record itself, because the layout alone cannot say
   *  what happened after it was saved. Survives the sweep's grace-expiry kill
   *  on purpose (the timer finishing what the switch started is still the
   *  switch's doing); cleared by the restore that consumes it and by every
   *  user verb that touches the session's lifecycle. */
  stowedBySwitch?: boolean;
  /** The private tmux session (`tmux -L lineage …`, see src/tmux.ts) this
   *  conversation's process runs detached in while under `graceUntil`: the
   *  terminal — only the tmux CLIENT — was disposed and the claude process
   *  kept running. Written by the detach sweep next to `graceUntil`; cleared
   *  (null) when a re-attach or a kill settles it. While set, ANY resume of
   *  this conversation must go through `new-session -A` under this name — a
   *  plain `--resume` would start a second claude beside the one still
   *  running. */
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
  /** First REAL workspace folder fsPath, if any. "Real" excludes the Flock
   *  anchor a converted explorer-follow window carries at folder[0] — an
   *  empty directory nothing runs in, so publishing it made the window
   *  unroutable (nothing is "under" it) while hiding the folders that ARE
   *  its identity. Kept as the single-folder field older readers know. */
  folder?: string;
  /** EVERY real workspace folder, in workspace order (anchor excluded, same
   *  rule as `folder`). What modes.windowForDir routes on, so a multi-root
   *  window is the target for work under any of its roots, not only the
   *  first. Absent on records published by older builds — readers fall back
   *  to `folder`. */
  folders?: readonly string[];
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
  /** v7. Keyed by subproject id — the NAMED lanes. See SubprojectRecord.
   *
   *  Optional for the reason `accounts` is: every literal that builds a
   *  LineageState by hand predates it and would stop compiling otherwise.
   *  `migrateState` materialises the map on every load, so nothing at runtime sees
   *  it missing. */
  subprojects?: Record<string, SubprojectRecord>;
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
  /** The in-session verbs install record (agentVerbs.ts). The same SHAPE as
   *  `hookInstall` on purpose: both persist "which version of two generated
   *  files did the user consent to", and giving that idea two types would
   *  invite them to drift. */
  verbsInstall?: HookInstallState;
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
  /**
   * WHICH CLI this launch execs. Absent means `claude`, so every existing call
   * site and every unit double keeps its old meaning exactly.
   *
   * It is carried on the launch rather than derived from the account, even
   * though the account is where it comes from, because the two answers must be
   * allowed to differ in one direction: an API-key (`generic`) profile is a
   * CLAUDE launch authenticated by an environment variable, and deriving the
   * binary from its provider would exec a CLI called `generic`.
   */
  provider?: ProviderId;
  /**
   * Pre-minted uuid (crypto.randomUUID()).
   *
   * EXACT for Claude, which takes `--session-id` and adopts this value.
   * PROVISIONAL for Codex, which has no such flag and mints its own id
   * internally: the binding starts under this id and is re-keyed onto the real
   * one once the rollout file naming it appears (see codex.matchRollout and
   * TerminalRegistry.rebind). Everything downstream — the stamp, the record,
   * the pin — is written against whichever id is current, which is what makes
   * the re-key a rename rather than a migration.
   */
  sessionId: string;
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
  /**
   * The SubprojectRecord.id this launch is starting in, recorded on the session's
   * editorial record so it stays in that lane (see
   * EditorialRecord.subprojectId).
   *
   * Set only by a launch that came FROM a lane's row — its `+`, or a fork of a
   * session already in one. Everything else leaves it absent, and those sessions
   * are placed by directory exactly as they always have been.
   *
   * Carried alongside `cwd` rather than derived from it, because it cannot be
   * derived from it: two lanes may name the same directory, which is the whole
   * reason the stamp exists.
   */
  subprojectId?: string;
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
  /** The LABEL of the account a session runs on, or undefined for the machine's
   *  default login. One hover line on both surfaces — see
   *  ViewModelInput.accountLabelOf for why it is a hover and not a column.
   *  Optional, like every lookup here: absent means the hover reads exactly as
   *  it did before accounts could be switched. */
  accountLabelOf?(sessionId: string): string | undefined;
  /** Which CLI wrote this conversation — the fact behind the row's
   *  `;claude;` / `;codex;` token pair, and therefore behind whether "Move to
   *  Account…" is in its menu. See ViewModelInput.sessionCli for the rule that
   *  must resolve it (the record, then the store the transcript sits in) and
   *  for why the PROJECT's provider must never be that rule. The return type is
   *  left loose here for the same reason `hostOf`'s is: types.ts may not import
   *  a module that imports it back. Optional; absent reads as 'claude'. */
  sessionCli?(sessionId: string): 'claude' | 'codex' | 'gemini' | undefined;
  /** RETIRED: `reparent`. Dropping a session onto another re-parented it, and
   *  dropping one onto a folder row detached it to a root — so a fork could be
   *  dragged out of the tree it branched from and an unrelated conversation
   *  dragged into one. A tree that states ancestry must not have an edge in it
   *  that no transcript backs, and nothing on screen told the two apart. Drag
   *  now means one thing (file this top-level session under that project) and
   *  neither view resolves the other drops. `ParentSource` keeps its 'reparent'
   *  member: state files written before this still carry those edges, and they
   *  go on resolving exactly as they did. */
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
  /** FOLDER MODE's scope: every REAL folder this window opened (the Flock
   *  anchor excluded), or undefined/empty when nothing is scoped (project
   *  mode, or an empty window). Feeds GroupingInput.scopeDirs — sessions
   *  whose cwd is known and outside ALL of them are another window's rows,
   *  not this one's. A list because converted explorer-follow windows and
   *  ordinary multi-root workspaces open several folders, each of which is
   *  "the folder you opened". Optional so an older wiring (and every unit
   *  double) keeps the machine-wide tree it always had. */
  scopeDirs?(): readonly string[] | undefined;
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
  /** Ahead/behind and dirt for ONE checkout, from a second cache with exactly
   *  the discipline of the one above (src/gitBranches.ts): synchronous from
   *  cache, refreshed in the background, never blocking a paint. `undefined`
   *  covers "not probed yet" and "not readable" alike, and both render the row
   *  as it looked before this existed.
   *
   *  Deliberately NOT part of the GROUPING input the way `worktreesOf` is: the
   *  worktree list decides which project a session belongs to, where this only
   *  decides what a row says. Keeping it out of computeGrouping is what stops a
   *  `git status` from ever being able to move a row. */
  branchStatusOf?(dir: string): BranchStatus | undefined;
  /** The pull request whose head is `branch`, from the `gh` cache
   *  (src/pullRequests.ts). Synchronous from cache like the two above, and
   *  `undefined` whenever `lineage.git.pullRequests` is off — which is the
   *  default, and which is why every renderer treats absent as the normal case
   *  rather than as a failure.
   *
   *  `repoDir` anchors the lookup at ONE directory per repository (the main
   *  worktree), so a project with six checkouts asks `gh` once rather than six
   *  times for an answer that is the same either way. */
  pullRequestFor?(repoDir: string, branch: string): PullRequest | undefined;
  /** `lineage.branchColors` — a user palette for the branch chips. Entries are
   *  positional (index 0 is the first branch's colour); a short list fills from
   *  the built-in one, and every entry is re-validated before it reaches the
   *  page (see sanitizeBranchColor — the value lands in an inline style block).
   *  Absent or empty means the built-in muted palette. */
  branchColors?(): readonly string[];
  // ---- branch grouping ------------------------------------------------
  /** `lineage.git.branches` — the branch block's master switch, and the ONE
   *  gate every branch-shaped row passes through. Absent reads as OFF, which is
   *  the setting's default and the tree Flock ships: no branch rows, no per-branch
   *  colours, no fold, no "Others". See CONFIG_KEYS.gitBranches. */
  branchRows?(): boolean;
  /** `lineage.git.branchDisplay` — WHICH of the two ways a session says the
   *  worktree it is in, `color` or `inline`. Absent — and any value that is
   *  neither — reads as `color`, which is what shipped. Moot while `branchRows`
   *  is off: with no branch feature there is nothing to display either way. */
  branchDisplay?(): BranchDisplay;
  /** `lineage.git.sessionBranchDetail`. Absent — and any value that is not
   *  `'detailed'` — reads as `'standard'`, so a mistyped setting shows the
   *  quieter line rather than nothing. Moot in colour mode. */
  sessionBranchDetail?(): SessionBranchDetail;
  /** `lineage.git.newSessionInWorktree` — whether the `+` on a project or
   *  subproject row cuts a worktree first. Absent reads as OFF, the setting's
   *  default. Read by the renderers only to TITLE the button; commands.ts reads
   *  the same setting to decide what it does. */
  newSessionInWorktree?(): boolean;
  /** `lineage.groupSessionsByBranch`: nest a project's sessions under the
   *  branch row for the worktree they run in, instead of listing branches and
   *  sessions as two flat blocks. Moot while `branchRows` is off — there are no
   *  branch rows to nest under. Optional for the same reason as the three
   *  above — absent means off, which is also the setting's default. */
  groupSessionsByBranch?(): boolean;
  // ---- the directory model (preview) ----------------------------------
  /** Every LOCAL branch of the repository at `dir` — the ones with no checkout
   *  included, which is most of them. From the cache in src/branchList.ts and
   *  synchronous from it, exactly like `worktreesOf`: a render must never wait on
   *  a subprocess. Absent, or an empty answer, means a directory row draws no
   *  branch fold, which is how every non-git directory already draws. */
  localBranchesOf?(dir: string): readonly LocalBranch[];
  /** Every NAMED subproject, from the store. v7 — see SubprojectRecord. Absent or
   *  empty means no project has lanes, which is every store before v7 and every
   *  project that has not used them: the rows are then the directory rows this
   *  tree has always drawn. */
  subprojects?(): readonly SubprojectRecord[];
  /** The lane a session was started in — EditorialRecord.subprojectId. A GROUPING
   *  input rather than a rendering one: which row a session belongs to has to be
   *  the same answer in both view styles. Absent means every session is placed by
   *  directory, exactly as before lanes existed. */
  stampOf?(sessionId: string): string | undefined;
  /** `lineage.preview.directoryModel` — hang the branch block off DIRECTORY rows
   *  rather than off the project, and list the whole repository rather than its
   *  checkouts. Absent reads as OFF, which is the setting's default and the tree
   *  Flock ships. Moot while `branchRows` is off: there are no branch rows to
   *  move. */
  directoryModel?(): boolean;
  /** RETIRED: `demoProject`. `lineage.preview.demoProject` appended a fabricated
   *  project to the grouping so the directory-and-branch layout could be judged
   *  without owning a repository shaped for it. It was removed because it was
   *  never actually off: `lineage.showBranchesAndWorktrees` wrote it ON as part
   *  of the branch bundle, so people who had never heard of the setting found
   *  *Flock (demo)* sitting in a sidebar full of their own work. The containment
   *  worked exactly as designed — prefixed ids, no directory that exists, never
   *  written to the store — and that turned out to be beside the point: a
   *  made-up project in a real tree is a bug however well it is fenced. What is
   *  left for looking at the layout is `preview.directoryModel` over your own
   *  repositories. */
  /** RETIRED: `reparentProject`. Dragging one project row onto another filed it
   *  as a subproject. Nesting records is gone (see COMMANDS.newSubproject), so a
   *  project row no longer drags at all and the drop handlers refuse the
   *  gesture outright rather than resolving it to nothing. */
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
  /** Resolved codex binary, or null. OPTIONAL so every existing unit double
   *  keeps compiling: a wiring without it can launch Claude sessions exactly
   *  as before and refuses Codex ones with the same "CLI not found" sentence a
   *  missing binary earns. */
  codexBinary?(): string | null;
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
  /** BARE tier's half of the tree reap (src/procs.ts): the live descendants
   *  of a pid, walked via ps. A bare terminal's dispose kills only the pane
   *  root — its ~8 MCP children re-parent to PID 1 and keep running — so the
   *  registry walks the tree BEFORE disposing and reaps the survivors after.
   *  Injectable for tests; absent = the real walker in src/procs.ts. */
  listDescendants?(rootPid: number): Promise<number[]>;
  /** The escalation ladder behind the walk above: verify the walked pids
   *  exited, SIGTERM the survivors, SIGKILL the stubborn — each signal to an
   *  explicit pid, never a name pattern. Injectable for tests; absent = the
   *  real ladder in src/procs.ts. */
  reapSurvivors?(
    pids: readonly number[],
  ): Promise<{ exited: number; termed: number; killed: number }>;
  /** The `kill(pid, 0)` liveness probe (src/procs.ts isPidAlive). The
   *  shutdown-time bare reap uses it to tell a window CLOSE (the pty root is
   *  dead — its orphans may be reaped) from a window RELOAD (the pty
   *  survives for revival — touching its tree would kill a live session).
   *  Injectable for tests; absent = the real probe. */
  isPidAlive?(pid: number): boolean;
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
  /** The window's REAL workspace folders, in order — the Flock anchor (an
   *  empty directory the explorer-follow feature parks at folder[0] of a
   *  converted window) already filtered out by the wiring, which is the one
   *  place that knows the anchor's path. What `WindowRecord.folder`/`folders`
   *  publish; absent (older wirings, unit doubles) falls back to the raw
   *  workspace folder list, which is correct for every unconverted window. */
  realFolders?(): readonly string[];
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
  /** The working directory the transcript's OWN head names.
   *
   *  The only cwd an archived session has when its record predates the field
   *  or was written by an import: measured on a real store, 32 of 159 archived
   *  records carry no `record.cwd`, and 28 of those 32 have one here. A picker
   *  that files sessions under projects by cwd alone would therefore be blind
   *  to a fifth of every project's archive. */
  cwd?: string;
  /** The transcript's `custom-title` record — the name a `/title` gave the
   *  conversation, which the editorial record never learns because the user
   *  typed it at the CLI rather than at the tree. */
  label?: string;
  /** The title the CLI generated for this conversation (its own `ai-title`
   *  record). A different class of name from `label`: a person chose that one,
   *  a model wrote this one — but both are titles OF the conversation, and the
   *  thing they replace is an eight-character hex id. */
  aiTitle?: string;
}
// None of the four are read for a LIVE session: the transcript index skips a
// file it saw being written (archive.ts), so a caller asking about something
// currently running gets `lastActiveAt` and nothing else. Harmless for the two
// callers there are — a chat's history and the archive browser both ask about
// conversations that are over — and worth knowing before a third one assumes
// otherwise.

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
  /**
   * `revealSession` for the conversation currently IN FRONT, plus the
   * keyboard: reveal the Flock sidebar, select that row, and focus the tree so
   * the up and down arrows switch sessions from there.
   *
   * Takes no id on purpose — "the session I am in" is a question only
   * extension.ts can answer (the active terminal, else the last conversation
   * Flock put on screen, resolved over the generation chain), and a caller
   * that had an id to pass would want `revealSession` instead.
   *
   * False means nothing happened: no conversation in front, or neither view
   * could be brought up. The verb says so rather than reporting a jump it did
   * not make.
   */
  focusSessionsView(): Promise<boolean>;
  /** Select the project's row. No ancestor walk is needed — a project row is
   *  always at depth 0 — so this is the select half of `revealSession` alone. */
  revealProject(projectId: string): Promise<void>;
  // state (B)
  getRecord(id: string): EditorialRecord | undefined;
  /**
   * Which CLI owns this conversation, when anything knows — `'codex'` or
   * undefined for the Claude default.
   *
   * Distinct from `viewmodel`'s `providerFor`, which answers the GLYPH
   * question and falls back to the owning project's provider. This one may
   * only return an answer it can prove, because it chooses which binary a
   * resume execs: the session's own record, else which history store its
   * transcript was found in. A guess here resumes a conversation under a CLI
   * that has never heard of it.
   *
   * Optional: a wiring without it falls back to the record alone, which is
   * correct for every session Flock launched itself.
   */
  sessionProvider?(id: string): ProviderId | undefined;
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
   *  own launch in every mode. The caller also decides FIRST whether the
   *  launch is the delegate's to make at all: a conversation whose routing
   *  resolves to another CLI, or to an account with its own environment,
   *  never reaches this (see hosts.delegateRefusal). See src/hosts.ts for the
   *  delegate table.
   *
   *  Optional: absent means the setting does not exist for this wiring, which is
   *  every unit double. */
  delegateLaunch?(opts: {
    cwd?: string;
    title?: string;
  }): Promise<{ label: string } | null>;
  /** `lineage.launch.mode`, the RESUME half: hand an existing conversation to
   *  the delegate's open-session command (hosts.LaunchDelegate.openCommand),
   *  which resumes it in that extension's own UI — or reveals the panel it is
   *  already open in. Resolves to the delegate's label when it ran; null when
   *  the mode is `flock`, the extension is missing, the delegate has no such
   *  command, or the command threw — in every case the caller opens its own
   *  terminal exactly as it always did.
   *
   *  The caller stays responsible for everything that guards a resume (the
   *  live-writer check, tip routing, leaf repair) and for NOT delegating a
   *  conversation whose account pin names a different config directory — the
   *  delegate runs on the machine's default login and would not find the
   *  transcript. Optional, like delegateLaunch, and for the same reason. */
  delegateOpenSession?(sessionId: string): Promise<{ label: string } | null>;
  /** The delegate `lineage.launch.mode` currently resolves to, when it is
   *  installed and can OPEN a specific session — null otherwise. What the
   *  focus verb consults to decide whether a foreign live row's dead-end
   *  dialog may offer "Open in <label>" at all: the offer must not render in
   *  flock mode, and a dialog cannot probe by running the command. */
  delegateOpenInfo?(): { label: string } | null;
  /** The delegate a NEW conversation would be handed to — label only, nothing
   *  run — or null in flock mode, when the extension is missing, or on a
   *  wiring without the setting. The NEW-launch twin of delegateOpenInfo,
   *  without the open-command requirement (every delegate has a newCommand).
   *  What the routing gate consults for its status-bar note: "opened here"
   *  is only worth saying when a delegation was actually forgone, and the
   *  gate must not probe by running the delegate's command. It never DECIDES
   *  the handover — delegateLaunch does, by trying. */
  delegateNewInfo?(): { label: string } | null;
  /** `lineage.soloSession`: after a session's tab opened (or was focused),
   *  park every OTHER session tab in this window and pin the kept one.
   *  A no-op when the setting is off. The mechanism is the workspace
   *  switcher's park (same tiers, same records), which is why this lives in
   *  the wiring rather than here — see workspaces.parkOthers.
   *
   *  Optional: absent means the setting does not exist for this wiring,
   *  which is every unit double. */
  soloEnforce?(keepSessionId: string): Promise<void>;
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
  /** End a DETACHED session's process — one under a grace countdown, whose
   *  terminal is already gone so `closeTerminal` has nothing to dispose. Kills
   *  the recorded tmux session and its process TREE (~8 MCP children — see
   *  src/procs.ts), stamps the record archived and runs the at-rest repair.
   *  The Close Now verb's second tier. Optional: a wiring without it (and
   *  every unit double) archives the record and leaves the process to the
   *  sweep's grace expiry, which is late but never wrong. */
  killDetached?(sessionId: string): Promise<boolean>;
  /** Does some record on this session's generation chain name a LIVE window
   *  other than this one (`boundWindowId` against the pruned window list)?
   *  The cross-window RESTORE RACE guard, mirroring the lifecycle sweep's:
   *  another window's restore binds the terminal and stamps `boundWindowId`
   *  first, but clears `graceUntil`/`tmux` only after its launch resolves —
   *  a seconds-wide window in which the record still reads as a detached
   *  claim while the process already has a tab THERE. Killing on that claim
   *  would end the session out from under the window that just attached it,
   *  so Delete and the Close verbs skip the kill when this answers true.
   *  Optional: absent (older wirings, unit doubles) reads as false, the
   *  pre-guard behaviour. */
  boundToLiveForeignWindow?(sessionId: string): boolean;
  /** WHICH id on this session's generation chain carries the detached claim —
   *  a `graceUntil` countdown or a `tmux` wrap name — or undefined when no
   *  generation of the conversation claims a detached process.
   *
   *  THE BUG THIS EXISTS TO CLOSE. The claim is written onto whichever id was
   *  parked, and `generations.INHERITED_RECORD_KEYS` deliberately does NOT
   *  carry `tmux`/`graceUntil` forward, so a conversation that re-mints its id
   *  afterwards (a plain resume, a compaction) leaves the claim on an OLDER
   *  member while its ROW is the tip. Every verb that asked
   *  `claimsDetachedProcess(getRecord(id))` therefore read "no detached
   *  process" for a wrap that was very much running — while `killDetached`,
   *  which searches the chain, would have found and ended it. Archive then
   *  wrote `deleted: true` over a live wrap: row gone, process running, which
   *  is the state the levels design exists to make unrepresentable. It was
   *  observed on a real machine, on a `claude` process 31 hours old.
   *
   *  Returning the HOLDER rather than a boolean is deliberate: the wiring has
   *  to find the holder anyway to end it, and a shape that hands back only
   *  "yes" invites a second, differently-scoped search at the call site — the
   *  precise divergence this member removes.
   *
   *  Optional, and an absent dep is NOT "no claim": callers fall back to
   *  reading the tip record, which is exactly the pre-chain behaviour every
   *  unit double already relies on. */
  detachedClaimHolder?(sessionId: string): string | undefined;
  // windows (F)
  focusWindowFor(sessionId: string): Promise<boolean>;
  /** Raise the window whose opened folder contains `dir` (deepest wins — see
   *  modes.windowForDir), revealing `sessionId` there once it is up. False when
   *  no live window covers the directory, which is the caller's cue to offer a
   *  NEW window instead. Folder mode's routing arm; optional so an older
   *  wiring (and every unit double) simply has no cross-folder routing. */
  focusWindowForDir?(dir: string, sessionId?: string): Promise<boolean>;
  /** `lineage.mode`, resolved (src/modes.ts) — including the legacy
   *  `workspaces.enabled` fold, so a caller never sees the raw setting. The
   *  union is spelled out rather than imported because types.ts imports
   *  nothing: it is the leaf every layer depends on, and modes.ts imports IT.
   *
   *  Optional: absent — every unit double, an older wiring — reads as no mode
   *  machinery at all, i.e. nothing gated and nothing routed, which is exactly
   *  the pre-mode behaviour. */
  lineageMode?(): 'folder' | 'root' | 'project';
  /** FOLDER MODE's fence, when there is one: every real folder this window
   *  opened (anchor excluded), or undefined when nothing is fenced (project
   *  mode, an empty window, a unit double). The same value TreeDeps.scopeDirs
   *  feeds the grouping, so the verbs and the rows can never disagree about
   *  which sessions are this window's to act on. */
  scopeDirs?(): readonly string[] | undefined;
  /** Every real folder THIS window opened (the Flock anchor excluded), in every
   *  model — not a fence, a fact.
   *
   *  Deliberately a second member beside `scopeDirs` rather than a widening of
   *  it. `scopeDirs` is the folder-mode FENCE and is `undefined` in the other
   *  two models on purpose (see extension.ts's `scopeFolders`), so a verb that
   *  asked it "does this window already have that directory open?" would get
   *  silence in exactly the two models where the question is most alive. The
   *  fence is a policy; this is geography, and the window-opening verbs need
   *  the geography.
   *
   *  Optional: absent (older wirings, unit doubles) reads as "no claim", so a
   *  verb that would open a window opens one — the pre-check behaviour. */
  windowFolders?(): readonly string[];
  // surfaces (F)
  openProject(fsPath: string, newWindow: boolean): Promise<void>;
  // hooks (G)
  installHooks(): Promise<HookInstallState>;
  removeHooks(): Promise<HookInstallState>;
  getHookState(): HookInstallState;
  /** Write `lineage.hooks.enabled`. Installing the plugin is only half the
   *  switch — this is the half that starts the events reader. */
  setHooksEnabled(enabled: boolean): Promise<void>;
  // in-session verbs (G) — all four OPTIONAL, unlike the hooks quartet, so no
  // existing unit double has to learn them: a wiring without them has the two
  // commands registered and refusing, never half-performing.
  installAgentVerbs?(): Promise<HookInstallState>;
  removeAgentVerbs?(): Promise<HookInstallState>;
  getAgentVerbsState?(): HookInstallState;
  /** Write `lineage.verbs.enabled` — the request-reader gate, the same
   *  install-is-the-opt-in contract as `setHooksEnabled`. */
  setAgentVerbsEnabled?(enabled: boolean): Promise<void>;
  // projects + visibility
  allProjects(): ProjectRecord[];
  getProject(id: string): ProjectRecord | undefined;
  /** The same worktree-reach resolver the sidebar groups with (see
   *  projects.projectReach): given a project, every directory it reaches
   *  through the repositories it sits on, not just the ones it lists.
   *
   *  Built PER CALL, because worktrees come and go several times a day and a
   *  resolver kept past the tick that made it would remember a checkout that
   *  has since been removed.
   *
   *  Optional, and absent means "listed directories only": every unit double
   *  and any older wiring then under-reports a session that ran in a worktree,
   *  which is a session missing from a list rather than a session filed under
   *  the wrong project. The reason it exists at all is that a surface which
   *  disagrees with the sidebar about membership is indistinguishable from a
   *  bug, because it is one. */
  projectReach?(): (project: ProjectRecord) => readonly string[];
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
  setBranchesShown(projectId: string, shown: boolean): Promise<void>;
  // ---- the worktree verbs ---------------------------------------------
  // Every one of these is OPTIONAL and every one of them is absent from the unit
  // doubles, which is the shape the refusal takes: a wiring without them has the
  // verbs registered and refusing, never half-performing. They are also the only
  // members of this interface behind which a repository gets WRITTEN to, which is
  // why the write pair is spelled out rather than folded into one `git()`.
  /** Where the checkout stands, from the same cache the rows render from
   *  (src/gitBranches.ts). Remove Worktree reads it to decide how many
   *  confirmations to ask for; undefined means it asks for one and lets git
   *  refuse on its own, which is the safe direction. */
  branchStatusOf?(dir: string): BranchStatus | undefined;
  /** `lineage.git.worktreePath` — the pattern a new worktree's path is built
   *  from. Absent falls back to the shipped default. */
  worktreePathPattern?(): string;
  /** The repository's checkouts at `dir` — a WARMED read of the same cache the
   *  views group with (src/git.ts), awaited so the answer is real rather than
   *  whatever the cache held. For the one verb that places a session by a
   *  lane's pinned branch (see SubprojectRecord.branch): a stale list would
   *  start the session in a worktree that was removed a minute ago. NOT gated
   *  on `lineage.git.branches` — that setting hides the branch ROWS; the data
   *  path stays live so placement works with the rows off. Absent (older
   *  wiring, unit doubles) reads as "no checkouts": the lane's own directory
   *  answers, which is the pre-pin behaviour. */
  worktreesFor?(dir: string): Promise<readonly Worktree[]>;
  /** The repository's local branches, most recently committed first. Read once,
   *  when the user opens the New Worktree picker; [] leaves the picker as a
   *  free-text field, which is the half of it that needs no git. */
  localBranches?(dir: string): Promise<readonly string[]>;
  /** `git worktree add`. Runs ONLY after a confirmation that showed the exact
   *  command. `create` says which half of the picker was used — a new branch
   *  (`-b`) or an existing one — and is not a preference. */
  addWorktree?(opts: {
    /** The repository's main worktree: the command's cwd, and therefore the
     *  only repository it can possibly affect. */
    repoDir: string;
    path: string;
    branch: string;
    create: boolean;
  }): Promise<GitCommandResult>;
  /** `git worktree remove`. `force` may come from exactly one place — the user's
   *  SECOND confirmation over a dirty checkout (see planWorktreeRemoval) — and
   *  never from a default or a setting. */
  removeWorktree?(opts: {
    repoDir: string;
    path: string;
    force: boolean;
  }): Promise<GitCommandResult>;
  /** Drop every cached git answer for the repository at `dir` and repaint. For
   *  the two verbs that KNOW the answer changed, so the new row appears at once
   *  instead of at the end of a TTL. */
  worktreesChanged?(dir: string): void;
  // ---- named subprojects (v7) ------------------------------------------
  /** Every lane, live, from the store. For the name-collision check and for the
   *  "is this the last one" line in the removal dialog. */
  allSubprojects?(): readonly SubprojectRecord[];
  /** One lane by id, re-resolved from the store rather than trusted from a row —
   *  the same discipline every other row-scoped verb here follows. */
  getSubproject?(id: string): SubprojectRecord | undefined;
  /** Create or patch a lane. `name` is the only field a verb ever changes after
   *  creation. */
  upsertSubproject?(
    id: string,
    patch: Partial<SubprojectRecord>,
  ): Promise<void>;
  /** Tombstone a lane. Leaves every session's stamp alone — see
   *  StateStore.deleteSubproject. */
  deleteSubproject?(id: string): Promise<void>;
  /** The lane a session is filed under, resolved over its generation CHAIN —
   *  `StateStore.getSessionSubproject`. Optional: absent means the picker cannot
   *  mark a current lane and offers no "no subproject" exit, which is the
   *  degradation a wiring without lanes wants anyway. */
  getSessionLane?(sessionId: string): string | undefined;
  /** Re-file one session into a lane, or out of every lane (`null`). */
  moveSessionSubproject?(
    sessionId: string,
    subprojectId: string | null,
  ): Promise<void>;
  /** The pull request on `branch`, from the same cache the rows render from.
   *  undefined whenever `lineage.git.pullRequests` is off — so the verb refuses,
   *  which is correct: with the setting off there is no request to know about. */
  pullRequestFor?(repoDir: string, branch: string): PullRequest | undefined;
  /** `gh pr create --web` in `dir`. Opens the compare page in the user's
   *  browser and returns; it does not create anything, which is the whole
   *  point. */
  createPullRequest?(dir: string): Promise<GitCommandResult>;
  /** `git remote get-url <remote>` in `dir` — where this repository lives, as
   *  its own config states it. A local read and not a network one, which is why
   *  it sits outside the `lineage.git.pullRequests` gate the member above is
   *  behind. '' for every kind of nothing. */
  remoteUrlOf?(dir: string, remote: string): Promise<string>;
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
  /** The pool the Add Session and Import pickers draw from: every session this
   *  machine knows about that has no row right now — live foreign ones and
   *  recordless transcripts alike, chain-collapsed to one entry per
   *  conversation. A SNAPSHOT of the extension's existing caches (last roster
   *  tick + archive index), never a fresh scan: a picker must open instantly,
   *  and the caches are at most one poll interval stale. Optional — a wiring
   *  without it (and every unit double that does not care) has the two verbs
   *  registered and reporting an empty pool rather than throwing. */
  unlistedSessions?(): readonly UnlistedSession[];
  // ---- notifications ------------------------------------------------------
  /** Stamp `seenAt` now — the user looked at this session. Idempotent. */
  markSeen(sessionId: string): Promise<void>;
  /** `lineage.notifications.enabled` (the global default). */
  notificationsEnabled(): boolean;
  // ---- telling a parent what its branches did ------------------------------
  /**
   * `lineage.fork.notifyParent`. Optional, and an absent dep reads as FALSE —
   * every unit double, and any wiring that has not been taught this setting,
   * forks exactly as it did before and types nothing into anybody.
   */
  notifyParentOnFork?(): boolean;
  /**
   * `lineage.close.summaryMode`. Optional, and an absent dep reads as
   * `'ask-me'` — deliberately NOT `DEFAULT_CLOSE_SUMMARY_MODE`.
   *
   * The default of the SETTING is the compacting one; the default of a MISSING
   * READER is the old input box. A wiring that cannot see the configuration
   * has no business starting two-minute compactions on people's branches on
   * the strength of a default it never read.
   */
  closeSummaryMode?(): CloseSummaryMode;
  /**
   * Wait for the Claude CLI to write a compaction summary into this
   * conversation's transcript, and hand back its text.
   *
   * `sinceMs` is a floor on the summary's own timestamp — a transcript may
   * hold summaries from earlier compactions, and one of those presented as
   * this branch's conclusion is worse than no summary at all. Resolves
   * `undefined` at `timeoutMs` with nothing found, which is a normal outcome
   * and not an error: the verb that asked then closes nothing and says so.
   *
   * The wiring, not this module, owns the search: a compaction re-mints the
   * session id in about a third of cases, so the summary may land in a NEW
   * transcript under a NEW id, and only the chain index knows the two are one
   * conversation. Optional: without it Close with Summary falls back to the
   * input box rather than pretending it can read an answer it cannot.
   */
  awaitCompactSummary?(
    sessionId: string,
    sinceMs: number,
    timeoutMs: number,
  ): Promise<string | undefined>;
  // ---- active-only filter -------------------------------------------------
  /** Write `lineage.onlyActiveSessions`. A setter and no getter on purpose: the
   *  two commands that call it each know the value they mean, and the state the
   *  user reads is the view-title icon, which the context key drives. */
  setOnlyActiveSessions(on: boolean): Promise<void>;
  // ---- the Accounts section -----------------------------------------------
  /** Write `lineage.accounts.section` — whether Accounts is drawn as a second
   *  section of the Flock container. A setter and no getter, exactly like the
   *  filter above: the two commands that call it each know the value they mean,
   *  and the state the user reads is which of the two the gear menu is
   *  offering, which the view's own `when` clause decides. */
  setAccountsSection(on: boolean): Promise<void>;
  // ---- the branch line ----------------------------------------------------
  /** Write `lineage.git.branchDisplay` — which of the two ways a session says
   *  the worktree it is in. A setter and no getter, like the two above: each of
   *  the two commands knows the mode it means, and the state the user reads back
   *  is which half the gear menu offers (see menuState.branchDisplay).
   *
   *  A pair of commands as well as a setting because the choice is invisible
   *  until you know the word for it: somebody who wants the branch on the row
   *  will not think to search settings for "branch display", and the gear is
   *  where the other layout switches already live. */
  setBranchDisplay(mode: BranchDisplay): Promise<void>;
  // ---- what the `+` means -------------------------------------------------
  /** `lineage.git.newSessionInWorktree` — read, not written: this one has no
   *  command pair, because it is a preference about a button rather than a
   *  thing you flip while looking at the tree. Optional, and absent reads as
   *  off: a wiring that does not know about it starts sessions in the directory,
   *  which is what the `+` has always done. */
  newSessionInWorktree?(): boolean;
  // ---- every git switch at once -------------------------------------------
  /** Write all four of the branch-and-worktree settings — `git.branches`,
   *  `git.sessionBranchDetail`, `git.pullRequests` and
   *  `preview.directoryModel` — on, or back to the values the extension ships
   *  with.
   *
   *  One member rather than four setters because the four are written together
   *  or not at all: a partial result is a tree in a state nobody asked for and
   *  cannot name. Optional, like `menuState`: an older wiring (and every unit
   *  double that does not care) simply does not offer the pair.
   *
   *  Setter and no getter, for the reason the three switches above have none —
   *  each command knows the value it means. There is no menu labelling itself
   *  off this one, so there is nothing to read back. */
  setBranchAndWorktreeFeatures?(on: boolean): Promise<void>;
  // ---- the recommended setup ----------------------------------------------
  /** Everything `recommendedPlan` (src/recommend.ts) needs to decide what a
   *  fresh install should be offered: config values, install state, whether any
   *  project exists, the size of the unlisted pool, and the worktree probe.
   *
   *  ASYNC and read once, when the command runs, because one field costs a
   *  `git worktree list` per project directory — the same probe the branch-rows
   *  notice makes, and for the same reason it is awaited rather than read off a
   *  cold cache: a checklist that offers branch rows to somebody with one
   *  checkout is a checklist that guessed.
   *
   *  Optional: a wiring without it (and every unit double that does not care)
   *  has the command registered and reporting that it is unavailable in this
   *  window, which is true and actionable, rather than throwing. */
  recommendedWorld?(): Promise<RecommendedWorld>;
  /** Write the settings a recommended step names, returning the keys it could
   *  NOT write (a read-only profile, a sync conflict) so the flow can say which
   *  ones are still where they were.
   *
   *  The one table-driven setter in this interface, and it is table-driven
   *  because the table is the feature: which settings "recommended" means lives
   *  in src/recommend.ts, held against the manifest by a test, and a setter per
   *  key would be a second copy of that list in a place no test can reach.
   *  The wiring refuses any key that is not a contributed setting.
   *
   *  Keys are section-relative — `git.branches`, the spelling `CONFIG_KEYS`
   *  uses — and every write goes to the GLOBAL target: a recommendation is
   *  about this person's editor, not about the folder they happen to have
   *  open. */
  writeSettings?(
    entries: readonly { key: string; value: boolean | string }[],
  ): Promise<readonly string[]>;
  // ---- the gear menu ------------------------------------------------------
  /** The state the gear menu labels itself with, read when it opens.
   *
   *  One member for four answers because they are read together, once, at the
   *  moment the quick pick is built — and because the alternative is four
   *  getters whose only caller is that one function. The `when` clauses this
   *  replaces read the same facts off context keys and configuration.
   *
   *  Optional: absent (an older wiring, every unit double) means the menu offers
   *  BOTH halves of each pair rather than guessing which way it goes, which is
   *  wrong-looking but never wrong. */
  menuState?(): {
    hooksInstalled: boolean;
    onlyActive: boolean;
    accountsSection: boolean;
    /** `lineage.git.branchDisplay`. Optional so a wiring that predates the two
     *  modes offers both halves rather than claiming one of them. */
    branchDisplay?: BranchDisplay;
    /** In-session verbs installed? Optional for the same reason as
     *  `branchDisplay`: absent offers both halves of the pair. */
    verbsInstalled?: boolean;
  };
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
  /** Root the Explorer at `dir` and hold it there until the user's attention
   *  moves to a session in a different directory. No reload — it is the same
   *  in-place splice a project switch does. */
  showDirectoryInExplorer?(dir: string): Promise<void>;
}
