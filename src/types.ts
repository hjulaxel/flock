// src/types.ts — THE shared contract for the Lineage extension.
// Frozen: written by the scaffold agent from SPEC.md §3, verbatim.
// No implementer may edit this file. It imports nothing (not even vscode).

// ------------------------------------------------------------------ identity

export const PUBLISHER = 'creemux'; // provisional publisher placeholder
export const EXTENSION_NAME = 'lineage-sessions'; // permanent, neutral
export const EXTENSION_ID = `${PUBLISHER}.${EXTENSION_NAME}`;

export const VIEW_CONTAINER_ID = 'lineage';
export const VIEW_ID = 'lineageSessions';
/** Intra-tree DnD mime: application/vnd.code.tree.<lowercased view id>. */
export const TREE_DND_MIME = 'application/vnd.code.tree.lineagesessions';
export const SESSION_URI_SCHEME = 'lineage-session';
export const ENV_NODE_ID = 'LINEAGE_NODE_ID';
export const BRAND_COLOR_ID = 'lineage.brand';
export const WAITING_COLOR_ID = 'lineage.waiting';
export const CONTEXT_HOOKS_INSTALLED = 'lineage.hooksInstalled';

// ------------------------------------------------------------------ schema

/** Version of the persisted globalStorage state.json blob. */
export const STATE_SCHEMA_VERSION = 1;

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
// M1.5: `claude agents --json` is live-only, so a closed session used to leave
// the tree entirely. The archive index reads ~/.claude/projects so closed
// sessions stay visible, keep their lineage, and can be resumed.

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

// ------------------------------------------------------------------ verbs

export const WRAP_PROMPT =
  'Wrap up this session: summarize what was accomplished in 3-6 bullet ' +
  'points, list any unfinished work, then stop.';

export const COMMANDS = {
  refresh: 'lineage.refresh',
  focusSession: 'lineage.focusSession',
  newSession: 'lineage.newSession',
  forkSession: 'lineage.forkSession',
  askSession: 'lineage.askSession',
  renameSession: 'lineage.renameSession',
  closeSession: 'lineage.closeSession',
  closeWithSummary: 'lineage.closeWithSummary',
  wrapSession: 'lineage.wrapSession',
  copySessionId: 'lineage.copySessionId',
  hideSession: 'lineage.hideSession',
  unhideSession: 'lineage.unhideSession',
  openProject: 'lineage.openProject',
  installHooks: 'lineage.installHooks',
  removeHooks: 'lineage.removeHooks',
  resumeSession: 'lineage.resumeSession',
} as const;
export type CommandId = (typeof COMMANDS)[keyof typeof COMMANDS];

// ------------------------------------------------------------------ config

export const CONFIG_SECTION = 'lineage';
export const CONFIG_KEYS = {
  pollIntervalMs: 'pollIntervalMs',
  claudeBinary: 'claudeBinary',
  groupByFolder: 'groupByFolder',
  sortWaitingFirst: 'sortWaitingFirst',
  showGhosts: 'showGhosts',
  showArchived: 'showArchived',
  hooksEnabled: 'hooks.enabled',
} as const;

// ------------------------------------------------------------------ unions

export type SessionKind = 'interactive' | 'background' | 'unknown';
export type SessionStatus = 'busy' | 'waiting' | 'idle' | 'exited' | 'unknown';
export type NodeAttention = 'none' | 'waiting';
/** How a parent edge was established. Precedence order is §5's cascade. */
export type ParentSource =
  | 'minted'      // we launched it: --fork-session --resume P --session-id C
  | 'reparent'    // user drag-and-drop; may set parentId null (detach)
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
  /** A real closed session read from disk (M1.5). Distinct from `ghost`: a
   *  ghost is INFERRED from a child's edge and may have no transcript at all,
   *  whereas an archived node has one and is therefore resumable. */
  archived: boolean;
  archive?: ArchivedSession;  // present iff archived
  hidden: boolean;            // editorial recoverable-delete flag
  status: SessionStatus;      // ghosts and archived nodes are 'exited'
  attention: NodeAttention;
  label: string;              // precedence: editorial.title > roster.name >
                              // archive.label > header.customTitle > shortId
  cwd?: string;
  startedAt?: number;
  endedAt?: number;           // archived only: last transcript activity
  kind: SessionKind;
  children: string[];         // ALL children ids, sorted per §5.6
  visibleChildren: string[];  // hidden/pruned-ghost promotion applied, §5.6
}

export interface SessionForest {
  nodes: Map<string, SessionNode>;
  roots: string[];            // all roots, sorted
  visibleRoots: string[];     // hidden/ghost promotion applied
  edges: LineageEdge[];       // every non-null parent edge
  attentionCount: number;     // visible, non-hidden nodes with attention
  generatedAt: number;        // epoch ms
}

// ------------------------------------------------------------------ tree

export interface GroupNode {
  type: 'group';
  key: string;   // the cwd string, or '(unknown)'
  cwd: string;   // '' when unknown
  label: string; // basename(cwd) or '(unknown)'
  rootIds: string[];
}
export interface SessionRef {
  type: 'session';
  id: string;
}
export type TreeNode = GroupNode | SessionRef;

/** contextValue = ';' + tokens.join(';') + ';' so `when` clauses can match
 *  with viewItem =~ /;token;/ and never false-positive on substrings. */
export type ContextToken =
  | 'session' | 'group' | 'ghost' | 'live' | 'exited' | 'archived'
  | 'waiting' | 'busy' | 'idle' | 'ours' | 'bound' | 'root' | 'forked';
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
  hidden?: boolean;              // recoverable delete
  launchedByUs?: boolean;
  boundWindowId?: string | null; // window whose terminal hosts this session
  wrapRequestedAt?: string;      // ISO; set by the wrap verb
  cwd?: string;
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

/** The persisted globalStorage blob: <globalStorageUri>/state.json. */
export interface LineageState {
  version: number; // STATE_SCHEMA_VERSION
  records: Record<string, EditorialRecord>;
  windows: Record<string, WindowRecord>;
  hookInstall?: HookInstallState;
}

// ------------------------------------------------------------------ hooks

export interface HookEvent {
  event: string | null;          // hook_event_name
  sessionId: string | null;      // session_id
  transcriptPath: string | null; // transcript_path
  raw: unknown;
}

// ------------------------------------------------------------------ terminals

export interface LaunchOptions {
  sessionId: string;   // pre-minted uuid (crypto.randomUUID())
  parentId?: string;   // when set: --fork-session --resume <parentId>
  /** Reopen an existing closed session: `--resume <resumeId>`. `--resume`
   *  REUSES the original session id (that is exactly why --fork-session
   *  exists as a separate flag), so `sessionId` MUST equal `resumeId` and no
   *  `--session-id` is passed. Mutually exclusive with `parentId`. */
  resumeId?: string;
  cwd?: string;
  prompt?: string;     // appended as the final positional argument
  title?: string;      // terminal name; default `claude · ${shortId}`
}

export interface TerminalBinding {
  nodeId: string;      // == sessionId in this design
  sessionId: string;
  terminalName: string;
  pid?: number;
  createdAt: number;   // epoch ms
}

// ------------------------------------------------------------------ misc plumbing

export interface DisposableLike {
  dispose(): void;
}

// ---------------------------------------------------- dependency interfaces
// Cross-owner calls go through these; extension.ts implements/wires them.

export interface TreeDeps {
  getForest(): SessionForest;
  onDidChangeData(listener: () => void): DisposableLike;
  /** true when a terminal for this session is bound in THIS window. */
  isBoundHere(sessionId: string): boolean;
  /** Persist a drag-reparent (parentSource 'reparent'); null = detach. */
  reparent(childId: string, newParentId: string | null): Promise<void>;
  groupByFolder(): boolean;
}

export interface DecorationDeps {
  getForest(): SessionForest;
  onDidChangeData(listener: () => void): DisposableLike;
}

export interface TerminalDeps {
  /** Resolved claude binary (config override or PATH scan), or null. */
  claudeBinary(): string | null;
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

export interface CommandDeps {
  // model
  getForest(): SessionForest;
  refresh(): void;
  hasTranscript(sessionId: string): boolean;
  // state (B)
  getRecord(id: string): EditorialRecord | undefined;
  allRecords(): Record<string, EditorialRecord>;
  upsertRecord(id: string, patch: Partial<EditorialRecord>): Promise<void>;
  recordLaunch(
    childId: string, parentId: string | null, cwd?: string,
  ): Promise<void>;
  // terminals (D)
  launchSession(opts: LaunchOptions): Promise<TerminalBinding | null>;
  focusSession(sessionId: string): boolean;         // bound-terminal show
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
}
