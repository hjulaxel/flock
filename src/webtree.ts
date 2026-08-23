// src/webtree.ts — the inline-rename sidebar, extension half.
//
// A WebviewViewProvider that renders the same forest the native TreeView does,
// for exactly one reason the TreeView API cannot give us: an editable row.
// VS Code's Explorer renames by flagging a row editable and having ITS OWN row
// renderer put an InputBox in the row (`explorerService.setEditable` ->
// `renderInputBox`). Both halves are workbench-internal; the extension-facing
// tree renderer has no such path and no API proposal adds one. Owning the row
// markup is therefore the only way to own the rename, which is what this is.
//
// What is NOT given up, because the webview host supports it:
//   * native context menus — `data-vscode-context` on each row is overlaid as
//     context keys and forwarded to the command, so `contributes.menus`
//     ["webview/context"] drives the same verbs with the same handlers;
//   * theming — every colour in webtree.css is a VS Code theme variable.
// What IS re-implemented here: rows, expand/collapse, selection, arrow-key
// navigation, drag-to-file-under-a-project, the attention badges, and reveal.
//
// This module depends only on vscode, ./types, ./log, ./viewmodel and
// ./projects: the row model is built by viewmodel.ts, and this file renders it
// and routes what the page sends back.

import * as vscode from 'vscode';

import {
  BRAND_COLOR_ID,
  COMMANDS,
  COMPACTING_COLOR_ID,
  DEFAULT_BRANCH_DISPLAY,
  DONE_COLOR_ID,
  PROVIDERS,
  PROVIDER_IDS,
  PROVIDER_MEDIA_DIR,
  RUNNING_BADGE_ENABLED,
  RUNNING_COLOR_ID,
  isSessionId,
} from './types';
import type {
  BranchInfo,
  DisposableLike,
  SessionForest,
  TreeDeps,
} from './types';
import { log, logError } from './log';
import { buildDemoProject } from './demoProject';
import {
  BRANCH_COLOR_COUNT,
  ELSEWHERE_GROUP_KEY,
  computeGrouping,
  projectBranchList,
} from './projects';
import type { GroupingResult } from './projects';
import {
  attentionCountOf,
  branchRowKey,
  buildViewModel,
  folderRowKey,
  projectRowKey,
  runningCountOf,
  sessionRowKey,
  subprojectRowKey,
  subtreeHasRunning,
} from './viewmodel';
import type { ViewRow } from './viewmodel';

/** The webview view's id. Also the `webviewId` context key value, which is what
 *  scopes our menu contributions to this view. */
export const INLINE_VIEW_ID = 'lineageSessionsInline';

/** Cap on the collapsed-key set, mirroring the native tree's shadow state. */
const CACHE_SOFT_LIMIT = 2000;

/** The target key the client reports for a drop on empty space below the
 *  last row — the gesture that takes a project back to the top level. Not a row
 *  key and deliberately unparseable as one. */
export const BACKGROUND_DROP_KEY = 'background';

/** How long `focusView()` waits for a view it just revealed to be on screen
 *  with its page listening, and how often it looks. A first reveal has to
 *  create the webview, load the document and run the script before any
 *  `beginRename` message has anyone to answer it; every later reveal is
 *  already ready and returns on the first check. The budget is an upper bound
 *  on how long a naming verb can sit before falling back to the quick input —
 *  short enough not to read as a hang, long enough for a cold webview. */
const REVEAL_WAIT_MS = 1500;
const REVEAL_POLL_MS = 25;

/** Resolve after `ms`. Module-local rather than a shared util because this is
 *  the only place in the file that waits on the clock. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Where the row-action glyphs live. Under `media/`, which is already the
 *  webview's only localResourceRoot, so a new subdirectory serves as-is. */
const ACTION_MEDIA_DIR = 'media/icons';

/** glyph name -> its svg, covering both row ACTIONS (the hover buttons) and row
 *  MARKS (the small non-interactive glyphs beside a label). The client is handed
 *  uris rather than markup because a glyph is drawn as a CSS MASK over
 *  `--vscode-icon-foreground`: an <img> would keep the file's own colour and be
 *  wrong in one theme or the other. Also the allowlist of what a row is allowed
 *  to draw at all — a name that is not in here renders as nothing. */
const ROW_GLYPH_FILES: Record<string, string> = {
  chat: 'chat.svg',
  add: 'add.svg',
  'bell-slash': 'bell-slash.svg',
  // Leads the second line under a session (`branchDisplay: inline`) AND labels
  // the branch block's fold on a project row, which used to carry a chevron: a
  // chevron says "this opens", which the row's own twisty already says, where
  // this says what opens. An svg
  // rather than the obvious `⎇` (U+2387): the webview does not ship the codicon
  // font, so a glyph here is whatever the platform's UI font happens to have,
  // and on macOS that character falls back to an illegible squiggle. A mask is
  // the same shape everywhere and takes the theme's icon colour, which is what
  // the marks beside a name already do.
  'git-branch': 'git-branch.svg',
  // The same mark in the four states GitHub gives a request, chosen by
  // branchStateIcon and named here by its CODICON ID — which is what lets the
  // native tree hand the identical string to a ThemeIcon while this side looks
  // it up in the allowlist. Drawn in the state's colour (see .branch-glyph in
  // webtree.css), because green-for-open and purple-for-merged is a convention
  // somebody arriving from a browser tab already reads.
  'git-pull-request': 'git-pull-request.svg',
  'git-pull-request-draft': 'git-pull-request-draft.svg',
  'git-pull-request-closed': 'git-pull-request-closed.svg',
  'git-merge': 'git-merge.svg',
};

/** Row-action id -> the verb it runs. The SECOND allowlist (ROW_GLYPH_FILES
 *  above is the first, over glyphs): the client sends an action NAME and this
 *  table decides which command that is, so a compromised or buggy page cannot
 *  name a command the extension never offered on a row. Every entry here takes
 *  a `{type:'project', projectId}` argument — see the 'action' case. */
const PROJECT_ROW_ACTIONS: Record<string, keyof typeof COMMANDS | undefined> = {
  chat: 'chatInProject',
  newSession: 'newSessionInProject',
  // Two ids for one toggle, not one id that flips: a contributed icon
  // cannot change at runtime, so the row emits whichever half currently
  // applies and each half has its own glyph — the same shape the bell and the
  // active-only filter already use.
  foldBranches: 'foldBranches',
  unfoldBranches: 'unfoldBranches',
};

/** The links on a branch — its name, and its `#42` — and the verbs they run. A
 *  THIRD allowlist, separate from PROJECT_ROW_ACTIONS above because these resolve
 *  through a checkout rather than a project (see linkTargetFor) and hand the
 *  command a `{type:'branch', …}` argument. Same rule as the other two: the page
 *  names an action, this table decides which command that is. */
const BRANCH_LINK_ACTIONS: Record<string, keyof typeof COMMANDS | undefined> = {
  openPullRequest: 'openPullRequest',
  openBranchOnRemote: 'openBranchOnRemote',
};

/**
 * The default branch palette: theme colours, softened.
 *
 * Built from the workbench's own `charts.*` rather than six hex values of our
 * own, because those are defined by every theme, chosen BY the theme author to
 * be distinguishable from each other and legible on the editor's surfaces, and
 * already what this extension's status dots draw from. Hard-coding would mean
 * picking values that look deliberate on Dark Modern and muddy on Solarized
 * Light.
 *
 * But raw `charts.*` are SIGNAL colours — sized for a chart series on a plain
 * background, and six of them down a sidebar shout louder than the status dot,
 * which is the one mark this tree is actually read for. Each is therefore mixed
 * back toward the editor's own foreground (see mutedColor), which desaturates
 * it toward the colour the surrounding text is already painted in: the hue
 * survives, the shout does not.
 *
 * NO RED. It is the one hue the tree has already spent — `lineage.done`, the
 * finished-and-unlooked-at dot — and a branch chip in the same red would make
 * the attention mark a decoration. Cyan takes the sixth slot instead.
 *
 * Each entry is `[theme colour id, fallback id]`. The fallback is not
 * decorative: a theme may leave `charts.*` undefined, and `var()` with nothing
 * behind it resolves to inherit — i.e. every branch silently the same grey.
 * Falling through to the terminal's ANSI colours (defined by essentially every
 * theme, for the same "these must be tellable apart" reason) means the chips
 * degrade to legible before they degrade to identical.
 */
const DEFAULT_BRANCH_PALETTE: readonly (readonly [string, string])[] = [
  ['charts-blue', 'terminal-ansiBlue'],
  ['charts-purple', 'terminal-ansiMagenta'],
  ['charts-green', 'terminal-ansiGreen'],
  ['charts-orange', 'terminal-ansiYellow'],
  ['terminal-ansiCyan', 'charts-lines'],
  ['charts-yellow', 'terminal-ansiYellow'],
];

/** How far a palette colour is pulled toward the editor foreground. 72% of the
 *  hue is enough to stay unmistakably "the blue one" while dropping the
 *  saturation that makes a column of them compete with the status dots. Mixed
 *  in oklab rather than srgb because srgb interpolation darkens and dirties
 *  mid-mix — the muddy result is exactly the "soft" this is trying to be. */
const BRANCH_MUTE = 72;

/**
 * One palette entry as a CSS value: the theme colour, softened toward the
 * editor's foreground, with the whole chain of fallbacks intact.
 *
 * `color-mix` is safe here — the webview is Chromium and the function has
 * shipped since 111, well below anything VS Code 1.94 runs on — but the
 * fallback is still spelled out inside it, so a host that did not support it
 * degrades to an unmixed but correct colour rather than to nothing.
 */
function mutedColor(id: string, fallback: string): string {
  const base = `var(--vscode-${id}, var(--vscode-${fallback}, var(--vscode-foreground)))`;
  return `color-mix(in oklab, ${base} ${BRANCH_MUTE}%, var(--vscode-foreground))`;
}

/**
 * A user-supplied palette entry, or '' if it is not one.
 *
 * THIS IS A SECURITY BOUNDARY, not a validation nicety. The return value is
 * interpolated into the inline `<style nonce>` block in html(), so an
 * unsanitised setting is CSS injection into our own page — and the CSP that
 * stops script injection does nothing about a value that closes the
 * declaration and opens a new rule.
 *
 * Two shapes only, both incapable of carrying a `}` or a `;`:
 *   - a hex colour: #rgb, #rgba, #rrggbb, #rrggbbaa
 *   - a theme colour id: dot-separated identifiers, e.g. `charts.blue` or
 *     `terminal.ansiCyan`, resolved through the same var() chain as the default
 *
 * Anything else — a function call, a url(), a bare keyword, an empty string —
 * is refused, and the caller falls back to the built-in entry for that slot.
 * Refusing rather than escaping is deliberate: there is no legitimate palette
 * entry that needs a character outside these two grammars.
 */
export function sanitizeBranchColor(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const value = raw.trim();
  if (value === '') return '';
  if (/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) {
    return value;
  }
  if (/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/.test(value)) {
    // Theme ids are published as --vscode-<id with dots as dashes>, the same
    // transform the contributed colours above go through.
    return `var(--vscode-${value.replace(/\./g, '-')}, var(--vscode-foreground))`;
  }
  return '';
}

/**
 * The palette: exactly `BRANCH_COLOR_COUNT` CSS values, in chip order.
 *
 * The length is a contract, not a convenience — projects.ts assigns
 * `colorIndex` modulo that constant, so a short list leaves the tail wrapping
 * onto variables that do not exist and reading as inherited grey. User
 * overrides are therefore positional and FILL from the default rather than
 * truncating it: setting one colour re-tints one branch, not the other five.
 *
 * A user entry is used RAW, not muted. Somebody who typed `#7aa2f7` picked that
 * colour and did not ask for it to be mixed with something else; the softening
 * is what the DEFAULT is, not a filter over everything.
 */
export function branchPalette(overrides: readonly string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < BRANCH_COLOR_COUNT; i++) {
    const custom = sanitizeBranchColor(overrides[i]);
    const [id, fallback] = DEFAULT_BRANCH_PALETTE[i % DEFAULT_BRANCH_PALETTE.length];
    out.push(custom !== '' ? custom : mutedColor(id, fallback));
  }
  return out;
}

/**
 * The DEFAULT palette as an inline `:root` block, for the first paint.
 *
 * Deliberately takes no overrides. The user's palette is posted with the model
 * and applied by the client (see the `palette` field on the 'model' message),
 * because this block is written by html() — which runs only when the view is
 * RESOLVED. A palette baked in here would mean `lineage.branchColors` did
 * nothing until the window was reloaded, which is indistinguishable from a
 * setting that does not work.
 *
 * It still has to exist: the page paints before the first message arrives, and
 * a chip with no variable behind it is grey.
 */
function branchPaletteCss(): string {
  return branchPalette()
    .map((value, i) => `    --lineage-branch-${i}: ${value};\n`)
    .join('');
}

const EMPTY_GROUPING: GroupingResult = {
  projects: [],
  folders: [],
  loose: [],
  hiddenCount: 0,
  outOfScopeCount: 0,
  elsewhere: null,
};

const EMPTY_FOREST: SessionForest = {
  nodes: new Map(),
  roots: [],
  visibleRoots: [],
  edges: [],
  attentionCount: 0,
  generatedAt: 0,
};

/** Extra verbs the client needs that are not per-row commands. */
export interface WebtreeDeps extends TreeDeps {
  /** Persist a rename (title + terminal tab name). Same path the palette uses. */
  renameSession(sessionId: string, title: string): Promise<void>;
  /** Persist a project rename. A project row is editable in the client exactly
   *  like a session row, so the round trip needs somewhere to land — without
   *  this the committed name arrived here, matched no session key and was
   *  dropped, and the row snapped back to its old label with no error. */
  renameProject(projectId: string, name: string): Promise<void>;
  /** An inline edit ended WITHOUT committing a name — Escape, or a commit of a
   *  name the client's own validation refuses. Nothing was renamed, so there is
   *  nothing to persist; this exists purely so the hand-back-the-keyboard
   *  bookkeeping set up for the edit can be released. Without it a cancelled
   *  rename leaves that target armed, and the NEXT rename of the same session —
   *  possibly started from the sidebar, where focus should stay in the sidebar —
   *  throws the keyboard into a terminal the user did not ask for. */
  renameCancelled(): void;
  /** Click on a row: focus a live session, resume a closed one. */
  activateSession(sessionId: string): Promise<void>;
  /** Run a command id from COMMANDS (the welcome button, the row actions).
   *  `arg` is the same shape the native menus pass, so the handlers'
   *  existing argument extractors work unchanged. */
  runCommand(command: keyof typeof COMMANDS, arg?: unknown): Promise<void>;
}

interface ClientMessage {
  type?: unknown;
  key?: unknown;
  /** Every selected row key, on a 'selection' message. Row KEYS, not session
   *  ids: the page names rows, and this side turns them back into ids through
   *  the same `session:<uuid>` gate every other message goes through. */
  keys?: unknown;
  name?: unknown;
  sessionId?: unknown;
  /** The row a drag STARTED on, which for a project drag is the only thing
   *  identifying it — `sessionId` is a session's id and a project's is not one. */
  sourceKey?: unknown;
  targetKey?: unknown;
  command?: unknown;
  action?: unknown;
  /** Which chip on a branch row was clicked. An index, never a path — see the
   *  'branch' case in onMessage. */
  index?: unknown;
}

function nonce(): string {
  // Not a security boundary on its own (the CSP is), just unguessable enough
  // that an injected inline script cannot name it.
  let out = '';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return out;
}

/**
 * The page's CSP. `style-src` MUST carry the same nonce as `script-src`: the
 * inline `<style nonce>` block in `html()` is the only place the contributed
 * `--lineage-*` colours are ever defined, and a `style-src` that only lists
 * `cspSource` (the webview origin, which authorises the external stylesheet
 * `<link>`) has no nonce match for an INLINE style block. Chromium drops that
 * whole block with no console warning — so a `style-src` missing the nonce
 * silently takes every contributed colour and every
 * `workbench.colorCustomizations` override with it, in the default (inline)
 * view, with nothing in the console to say so.
 *
 * Exported for test: the mock's Uri has no joinPath, so html() itself is
 * unreachable from a unit test (see test/mocks/vscode.ts) — this is the pure
 * remainder that regression-tests the nonce without needing a real webview.
 */
export function buildCsp(nonce: string, cspSource: string): string {
  return [
    "default-src 'none'",
    `img-src ${cspSource}`,
    `style-src 'nonce-${nonce}' ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${cspSource}`,
  ].join('; ');
}

export class LineageWebtreeProvider implements vscode.WebviewViewProvider {
  private readonly deps: WebtreeDeps;
  private readonly extensionUri: vscode.Uri;

  private view: vscode.WebviewView | undefined;
  /** Disposables scoped to the CURRENT `this.view`, kept separate from
   *  `registerWebtree()`'s own `disposables` (which live for the whole
   *  extension session, not per-resolve). A hidden view can be torn down and
   *  re-resolved with a brand-new WebviewView object without ever calling our
   *  dispose() — retainContextWhenHidden keeps the DOM alive, but the view
   *  wrapper itself is not guaranteed stable — so resolveWebviewView() needs
   *  its own set to splice-and-dispose on every call, or each re-resolve
   *  piles one more onDidReceiveMessage/onDidChangeVisibility subscription on
   *  top of the last, forever. */
  private viewSubs: vscode.Disposable[] = [];
  /** Whether the page currently in `this.view` has announced itself (`ready`).
   *  A resolved, visible view is not the same as a listening one: the document
   *  and its script load asynchronously after `resolveWebviewView` returns, and
   *  a `beginRename` posted in that window is a message nobody is subscribed
   *  to yet. Only the client can say when it is listening, so this tracks its
   *  one announcement and is cleared for every fresh page. */
  private clientReady = false;
  /** SEEDED with the "Running elsewhere" appendix key: that one row inverts
   *  the expansion default (a ledger of other windows' running processes must
   *  not open on top of this window's work), and seeding the collapse is how
   *  an all-default-expanded model expresses it. The prune exempts the key —
   *  the group comes and goes with the filters, and pruning its seed while it
   *  was absent would flip its default to expanded for the rest of the
   *  window. */
  private readonly collapsed = new Set<string>([
    folderRowKey(ELSEWHERE_GROUP_KEY),
  ]);

  private lastForest: SessionForest = EMPTY_FOREST;
  private groupCacheForest: SessionForest | null = null;
  private groupCache: GroupingResult = EMPTY_GROUPING;

  constructor(deps: WebtreeDeps, extensionUri: vscode.Uri) {
    this.deps = deps;
    this.extensionUri = extensionUri;
  }

  // ------------------------------------------------------------- internals

  private forest(): SessionForest {
    try {
      const f = this.deps.getForest();
      if (f && f.nodes) {
        this.lastForest = f;
        return f;
      }
    } catch (err) {
      logError('webtree.getForest', err);
    }
    return this.lastForest;
  }

  private safe<T>(what: string, read: () => T, dflt: T): T {
    try {
      const v = read();
      return v === undefined || v === null ? dflt : v;
    } catch (err) {
      logError(`webtree.${what}`, err);
      return dflt;
    }
  }

  private grouping(forest: SessionForest): GroupingResult {
    // Keyed on forest identity only. Unlike the native tree this does not need a
    // signature over projects: the whole model is re-posted on every change
    // event anyway, so a stale group cache can only survive one tick.
    if (this.groupCacheForest === forest) return this.groupCache;
    this.groupCache = computeGrouping(
      {
        visibleRootIds: forest.visibleRoots,
        cwdOf: (id) => forest.nodes.get(id)?.cwd,
        projects: this.safe('projects', () => this.deps.projects(), []),
        hiddenFolders: this.safe('hiddenFolders', () => this.deps.hiddenFolders(), []),
        groupByFolder: this.safe('groupByFolder', () => this.deps.groupByFolder(), true),
        onlyProjectSessions: this.safe(
          'onlyProjectSessions',
          () => this.deps.onlyProjectSessions(),
          false,
        ),
        // Folder mode's fence — every real folder this window opened, or []
        // when project mode (or an empty window) scopes nothing. Read per
        // grouping like every other setting here; the mode flip triggers a
        // rebuild, so the forest-identity cache key above still invalidates
        // in time.
        scopeDirs:
          this.safe<readonly string[] | undefined>(
            'scopeDirs',
            () => this.deps.scopeDirs?.(),
            undefined,
          ) ?? [],
        // The invariant's escape hatch — see GroupingInput.hasRunning: a
        // filtered RUNNING root files into the "Running elsewhere" appendix
        // instead of losing its row.
        hasRunning: (rootId) => subtreeHasRunning(forest, rootId),
        worktreesOf: (dir) =>
          this.safe('worktreesOf', () => this.deps.worktreesOf?.(dir) ?? [], []),
        // `lineage.git.branches`. Read per grouping like every other setting
        // here, so the block appears and disappears on the next tick rather
        // than on a window reload.
        branchRows: this.safe('branchRows', () => this.deps.branchRows?.(), false),
        localBranchesOf: (dir) =>
          this.safe(
            'localBranchesOf',
            () => this.deps.localBranchesOf?.(dir) ?? [],
            [],
          ),
        directoryModel: this.safe(
          'directoryModel',
          () => this.deps.directoryModel?.(),
          false,
        ),
        // The NAMED subprojects, and the stamp saying which one a session was
        // started in. Grouping inputs rather than rendering ones: which row a
        // session belongs to has to be the same answer in both view styles.
        subprojects: this.safe('subprojects', () => this.deps.subprojects?.(), []),
        stampOf: (id) =>
          this.safe('stampOf', () => this.deps.stampOf?.(id), undefined),
      },
      this.groupCache,
    );
    // The demo project is APPENDED to the finished result, downstream of every
    // rule that decides what belongs where — so it cannot claim a real session,
    // cannot move a real row, and cannot be reached by anything that reads the
    // store. Last in the list because it is the least important row on screen.
    // See src/demoProject.ts.
    if (this.safe('demoProject', () => this.deps.demoProject?.(), false)) {
      this.groupCache = {
        ...this.groupCache,
        projects: [...this.groupCache.projects, buildDemoProject(Date.now())],
      };
    }
    this.groupCacheForest = forest;
    return this.groupCache;
  }

  /** The rendered SUBPROJECT row a client message names, or undefined. Same
   *  contract as branchRowFor below and for the same reason: the page names a
   *  row, this side reads the directory out of the model it just posted, so the
   *  only directories a click can reach are ones the user was looking at. */
  private subprojectRowFor(key: unknown): ViewRow | undefined {
    if (typeof key !== 'string' || !key.startsWith('subproject:')) {
      return undefined;
    }
    try {
      return this.rows().find((r) => r.kind === 'subproject' && r.key === key);
    } catch (err) {
      logError('webtree.subprojectRowFor', err);
      return undefined;
    }
  }

  /** The rendered branch row a client message names, or undefined. Looked up in
   *  the model this view just posted, which is what makes a click unable to
   *  reach a worktree the user was not looking at. */
  private branchRowFor(key: unknown): ViewRow | undefined {
    // Parsed only as a GUARD — that the key names a branch row of a real project
    // — and then matched on the key itself, the way subprojectRowFor does. A
    // project spanning two repositories has two branches called `main`, and the
    // pair differ only by the directory their key carries: a lookup by
    // (projectId, branch) would hand both clicks to whichever row came first, and
    // start a session in the wrong checkout.
    if (branchRowParts(key) === undefined) return undefined;
    try {
      return this.rows().find((r) => r.kind === 'branch' && r.key === key);
    } catch (err) {
      logError('webtree.branchRowFor', err);
      return undefined;
    }
  }

  /**
   * The checkout a LINK on a row points at: `{projectId, dir, branch}`, or
   * undefined.
   *
   * Two kinds of row can carry one and they hold the fact in different places —
   * a branch row IS a branch (`chip`), a session row merely says which one it is
   * running in (`branchLine`) — so this is the one place that knows both. What it
   * returns is exactly the shape branchArgOf() reads, so the commands on the far
   * side cannot tell a link from a native context-menu invocation.
   *
   * THE PAGE NAMES A ROW, NEVER A PATH, which is the rule every message in here
   * follows: the directory comes out of the model this view just posted, so the
   * only checkouts a click can reach are the ones the user was looking at.
   */
  private linkTargetFor(
    key: unknown,
  ): { projectId: string; dir: string; branch: string } | undefined {
    if (typeof key !== 'string' || key === '') return undefined;
    try {
      const row = this.rows().find((r) => r.key === key);
      if (!row?.projectId) return undefined;
      if (row.kind === 'branch') {
        return row.chip
          ? { projectId: row.projectId, dir: row.chip.dir, branch: row.chip.full }
          : undefined;
      }
      if (row.kind === 'session' && row.branchLine) {
        return {
          projectId: row.projectId,
          dir: row.branchLine.dir ?? '',
          branch: row.branchLine.name,
        };
      }
      return undefined;
    } catch (err) {
      logError('webtree.linkTargetFor', err);
      return undefined;
    }
  }

  /** The branches currently on screen for a project — what the chip-click verb
   *  re-resolves against. Reads the SAME grouping the rows were built from, so
   *  there is no window in which the tree shows one set of worktrees and the
   *  command accepts another. */
  branchesOf(projectId: string): readonly BranchInfo[] {
    try {
      const grouping = this.grouping(this.forest());
      // Through projectBranchList, so a palette verb finds the checkouts of a
      // SPLIT project too — under the directory model those live on its directory
      // rows, and reading the project node alone would tell New Worktree… that a
      // repository with six checkouts has none.
      return projectBranchList(
        grouping.projects.find((p) => p.projectId === projectId),
      );
    } catch (err) {
      logError('webtree.branchesOf', err);
      return [];
    }
  }

  private rows(): ViewRow[] {
    const forest = this.forest();
    return buildViewModel({
      forest,
      grouping: this.grouping(forest),
      collapsed: this.collapsed,
      providerFor: (id) => this.deps.providerFor(id),
      isBoundHere: (id) => this.deps.isBoundHere(id),
      // Optional all the way down: an unwired dep leaves every row 'hosted',
      // which is the sidebar as it looked before ownership existed.
      ...(this.deps.hostOf === undefined
        ? {}
        : { hostOf: (id: string) => this.deps.hostOf?.(id) ?? 'none' }),
      ...(this.deps.accountLabelOf === undefined
        ? {}
        : {
            accountLabelOf: (id: string) => this.deps.accountLabelOf?.(id),
          }),
      viewId: INLINE_VIEW_ID,
      now: Date.now(),
      // Read per post, like every other setting here, so flipping it takes
      // effect on the next tick rather than on a window reload.
      showTokens: this.safe('showTokens', () => this.deps.showTokens?.(), false),
      groupByBranch: this.safe(
        'groupSessionsByBranch',
        () => this.deps.groupSessionsByBranch?.(),
        false,
      ),
      // The renderer's half of the branch gate: the grouping above builds the
      // list, this decides whether a row per branch is drawn from it.
      branchBlock: this.safe('branchRows', () => this.deps.branchRows?.(), false),
      // Which mode the rows read in — see BranchDisplay. Anything that is not
      // 'inline' is colour, so a mistyped setting renders what shipped.
      branchDisplay: this.safe(
        'branchDisplay',
        () => this.deps.branchDisplay?.(),
        DEFAULT_BRANCH_DISPLAY,
      ),
      newSessionInWorktree: this.safe(
        'newSessionInWorktree',
        () => this.deps.newSessionInWorktree?.(),
        false,
      ),
      sessionBranchDetail: this.safe(
        'sessionBranchDetail',
        () => this.deps.sessionBranchDetail?.(),
        'standard',
      ),
      // Synchronous by contract, like `worktreesOf` above: the cache behind it
      // answers from memory and refreshes in the background, so this cannot be
      // the thing that makes a post wait.
      branchStatusOf: (dir) =>
        this.safe('branchStatusOf', () => this.deps.branchStatusOf?.(dir), undefined),
      // The one lookup here that can reach the network — and cannot on THIS call:
      // the cache behind it answers from memory, schedules its own refresh, and
      // will not schedule one unless a visible view asked. See
      // src/pullRequests.ts.
      pullRequestFor: (repoDir, branch) =>
        this.safe(
          'pullRequestFor',
          () => this.deps.pullRequestFor?.(repoDir, branch),
          undefined,
        ),
      // Read per post like the rest, so turning the preview on or off takes
      // effect on the next tick rather than on a window reload — which is the
      // whole point of shipping it as a switch.
      directoryModel: this.safe(
        'directoryModel',
        () => this.deps.directoryModel?.(),
        false,
      ),
    });
  }

  attentionCount(): number {
    try {
      const forest = this.forest();
      return attentionCountOf(forest, this.grouping(forest));
    } catch (err) {
      logError('webtree.attentionCount', err);
      return 0;
    }
  }

  /** RUNNING sessions machine-wide — what the container badge shows. See
   *  viewmodel.runningCountOf for the predicate and for why this counts
   *  processes rather than attention (or rendered rows). */
  runningCount(): number {
    try {
      return runningCountOf(this.forest());
    } catch (err) {
      logError('webtree.runningCount', err);
      return 0;
    }
  }

  /** provider id -> {light, dark} webview uris for its brand mark. */
  private iconMap(webview: vscode.Webview): Record<string, { light: string; dark: string }> {
    const out: Record<string, { light: string; dark: string }> = {};
    for (const id of PROVIDER_IDS) {
      const info = PROVIDERS[id];
      const light = this.mediaUri(webview, PROVIDER_MEDIA_DIR, info.iconFile);
      // A monochrome mark (OpenAI's) ships as a pair; a coloured one reuses the
      // single file for both, so the client never has to special-case.
      const dark = info.iconFileDark
        ? this.mediaUri(webview, PROVIDER_MEDIA_DIR, info.iconFileDark)
        : light;
      if (light !== '' && dark !== '') out[id] = { light, dark };
    }
    return out;
  }

  /** glyph name -> the webview uri of its svg. One entry per ALLOWLISTED glyph,
   *  so a row asking for one the extension does not ship simply draws nothing
   *  rather than a broken image. */
  private glyphMap(webview: vscode.Webview): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, file] of Object.entries(ROW_GLYPH_FILES)) {
      const uri = this.mediaUri(webview, ACTION_MEDIA_DIR, file);
      if (uri !== '') out[id] = uri;
    }
    return out;
  }

  private mediaUri(webview: vscode.Webview, dir: string, file: string): string {
    try {
      const uri = vscode.Uri.joinPath(
        this.extensionUri,
        ...dir.split('/'),
        file,
      );
      return webview.asWebviewUri(uri).toString();
    } catch (err) {
      logError('webtree.mediaUri', err);
      return '';
    }
  }

  // ------------------------------------------------------------- lifecycle

  resolveWebviewView(view: vscode.WebviewView): void {
    // Whatever the PREVIOUS view (if any) subscribed is dead the moment a new
    // one resolves — splice-and-dispose it before wiring the new one, so a
    // hidden-then-reshown view never leaves a stale set of listeners running
    // alongside the fresh ones.
    for (const d of this.viewSubs.splice(0)) {
      try {
        d.dispose();
      } catch (err) {
        logError('webtree.resolveWebviewView.dispose', err);
      }
    }

    this.view = view;
    // A brand-new document: whatever the previous page had announced says
    // nothing about this one.
    this.clientReady = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);

    this.viewSubs.push(
      view.webview.onDidReceiveMessage((raw: unknown) => {
        void this.onMessage(raw as ClientMessage);
      }),
    );

    // A hidden view's webview is torn down and re-resolved; re-post on reveal.
    this.viewSubs.push(
      view.onDidChangeVisibility(() => {
        if (view.visible) this.post();
      }),
    );

    // The workbench disposes a view when its container goes away (a panel
    // drag-out, the view being uninstalled from the sidebar, ...) without
    // calling anything of ours first. Without this, `this.view` would keep
    // pointing at a disposed webview until the NEXT resolve, and every
    // post()/beginRename()/reveal() call in between would throw against a
    // torn-down object instead of degrading through the `!view` guards.
    this.viewSubs.push(
      view.onDidDispose(() => {
        if (this.view !== view) return;
        this.view = undefined;
        this.clientReady = false;
      }),
    );

    this.post();
    this.updateBadge();
  }

  private html(webview: vscode.Webview): string {
    const n = nonce();
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'webtree.js'),
    );
    const style = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'webtree.css'),
    );
    // Strict CSP: no inline script or inline style without our nonce, images
    // and the stylesheet limited to the webview origin, and no network at
    // all. The rows carry user-controlled strings (session labels, cwds), so
    // nothing here may execute them — which is also why the client builds DOM
    // with textContent and never innerHTML.
    const csp = buildCsp(n, webview.cspSource);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style.toString()}" rel="stylesheet">
<style nonce="${n}">
  :root {
    /* Our contributed colours, handed to the client under stable names. The
       workbench publishes every contributed id as --vscode-<id with dots as
       dashes>, so a user's theme override reaches this view too. The status dot
       has exactly THREE lit colours here — running, done, and the one purple
       both compaction phases share — while idle draws no dot at all, and
       neither does a closed row: that one is dimmed instead, which needs no
       colour of its own (the contributed lineage.closed still colours the
       native tree's row, where there is no way to dim one). See webtree.css. */
    --lineage-brand: var(--vscode-${BRAND_COLOR_ID.replace(/\./g, '-')});
    --lineage-running: var(--vscode-${RUNNING_COLOR_ID.replace(/\./g, '-')});
    --lineage-done: var(--vscode-${DONE_COLOR_ID.replace(/\./g, '-')});
    --lineage-compacting: var(--vscode-${COMPACTING_COLOR_ID.replace(/\./g, '-')});
${branchPaletteCss()}  }
</style>
<title>Flock</title>
</head>
<body>
<!-- The BACKGROUND context, carried by the tree container itself, so a
     right-click on empty space below the last row has a menu of its own — which
     is the only place a verb about NO row can live, and where the project
     history has to be reachable from: a closed project has no row to
     right-click, by construction. Rows set their own data-vscode-context and
     the workbench takes the innermost one, so nothing here reaches a row;
     preventDefaultContextMenuItems keeps the webview's stock Copy/Reload out
     of a sidebar the same way every row already does. -->
<div id="tree" role="tree" aria-label="Claude sessions" tabindex="0"
     data-vscode-context='{"webviewSection":"background","webviewId":"${INLINE_VIEW_ID}","preventDefaultContextMenuItems":true}'></div>
<script nonce="${n}" src="${script.toString()}"></script>
</body>
</html>`;
  }

  // ---------------------------------------------------------------- posting

  /** Push the current model. Cheap enough to send whole: the row list is a few
   *  hundred small objects at worst, and a diffing protocol would be a second
   *  model to keep in sync — the bug this design exists to avoid. */
  post(): void {
    const view = this.view;
    if (!view) return;
    try {
      void view.webview.postMessage({
        type: 'model',
        rows: this.rows(),
        icons: this.iconMap(view.webview),
        glyphs: this.glyphMap(view.webview),
        // Posted rather than baked into the page, so `lineage.branchColors`
        // takes effect on the next tick instead of the next window reload —
        // see branchPaletteCss. Always sent, not only when overridden: the
        // client would otherwise have to remember whether the last palette it
        // applied was a custom one, and clearing the setting would leave the
        // old colours on screen.
        palette: branchPalette(
          this.safe('branchColors', () => this.deps.branchColors?.() ?? [], []),
        ),
        // Only ever read when there are no rows at all, and only to pick which
        // sentence the empty view says: "you have no sessions" is a lie the
        // moment the filter is the reason the tree is empty, and it is the one
        // state in which the tree cannot show you the switch that caused it.
        filtered: this.safe(
          'onlyActiveSessions',
          () => this.deps.onlyActiveSessions?.(),
          false,
        ),
      });
    } catch (err) {
      logError('webtree.post', err);
    }
  }

  refresh(): void {
    this.pruneCollapsed();
    this.post();
    this.updateBadge();
  }

  private updateBadge(): void {
    const view = this.view;
    if (!view) return;
    try {
      // The RUNNING count — the levels invariant as a number (see
      // RUNNING_BADGE_ENABLED in types.ts for why attention lost this slot).
      // While off, 0 clears the badge via the `undefined` arm below.
      const count = RUNNING_BADGE_ENABLED ? this.runningCount() : 0;
      view.badge =
        count > 0
          ? {
              value: count,
              tooltip: `${count} session${count === 1 ? '' : 's'} running`,
            }
          : undefined;
    } catch (err) {
      logError('webtree.updateBadge', err);
    }
  }

  private pruneCollapsed(): void {
    if (this.collapsed.size === 0) return;
    const forest = this.forest();
    const grouping = this.grouping(forest);
    // WHILE THE ACTIVE-ONLY FILTER IS ON, the grouping below is computed over
    // the FILTERED roots — a folder whose sessions are all closed, a branch
    // row with nothing live under it, has no row right now, and pruning its
    // key here is what made "Show all sessions" re-expand every fold the
    // filter had been hiding: the rows came back, their collapsed keys did
    // not. Merely hidden is not gone, so grouping-derived keys are left alone
    // until the filter is off and the grouping covers the full universe
    // again. Session keys stay prunable throughout — `forest.nodes` keeps
    // filtered-out nodes (visibility is a separate pass), so a session key
    // missing from it really is dead.
    const filtered = this.safe(
      'onlyActiveSessions',
      () => this.deps.onlyActiveSessions?.(),
      false,
    );
    // Every row kind that can be collapsed, not just sessions: pruning only
    // `session:` keys would let a `project:`/`folder:` key for a project or
    // folder that no longer exists (deleted, renamed away from a folder
    // grouping, ...) stick around forever — until the CACHE_SOFT_LIMIT in the
    // `toggle` handler trips and wipes the WHOLE set at once, which reads as
    // every row on screen abruptly re-expanding together. Building the live
    // key set from all three row kinds keeps the cache bounded by what can
    // actually be collapsed right now.
    const live = new Set<string>();
    for (const id of forest.nodes.keys()) live.add(sessionRowKey(id));
    for (const p of grouping.projects) {
      live.add(projectRowKey(p.projectId));
      // Branch rows collapse too once `groupSessionsByBranch` is on, and
      // a branch that is deleted (or a project that stops being a repository)
      // would otherwise leave its key here until the whole set was wiped.
      for (const b of p.branches ?? []) {
        live.add(branchRowKey(p.projectId, b.name));
      }
      // And the same again per SUBPROJECT ROW under the directory model, where
      // the branches belong to a row and their keys carry its id. Without these
      // every branch row a user collapses would be pruned on the next tick.
      for (const sub of p.subprojects ?? []) {
        live.add(subprojectRowKey(p.projectId, sub.id));
        for (const b of sub.branches ?? []) {
          live.add(branchRowKey(p.projectId, b.name, sub.id));
        }
      }
    }
    for (const g of grouping.folders) live.add(folderRowKey(g.key));
    // Always "live": the appendix comes and goes with the filters, and its
    // collapsed seed (see the field) must survive the spells it is absent.
    live.add(folderRowKey(ELSEWHERE_GROUP_KEY));
    for (const key of Array.from(this.collapsed)) {
      if (filtered && !key.startsWith('session:')) continue;
      if (!live.has(key)) this.collapsed.delete(key);
    }
  }

  /** Select a row, and reveal its ancestors first so the row actually exists. */
  async reveal(sessionId: string): Promise<void> {
    if (!isSessionId(sessionId)) return;
    const forest = this.forest();
    // Expand every ancestor, else the row is not in the flattened model.
    const chain: string[] = [];
    const seen = new Set<string>([sessionId]);
    let cursor = forest.nodes.get(sessionId)?.parentId ?? null;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      chain.push(cursor);
      cursor = forest.nodes.get(cursor)?.parentId ?? null;
    }
    let changed = false;
    for (const id of chain) {
      if (this.collapsed.delete(sessionRowKey(id))) changed = true;
    }
    // The group holding it, too — and that can be a project nested inside
    // another project, so every ancestor of it has to open as well. A
    // reveal that expands the row's own project and leaves its grandparent
    // folded selects a key the client never rendered, which is a no-op it does
    // not retry.
    const grouping = this.grouping(forest);
    const byId = new Map(
      grouping.projects.map((p) => [p.projectId, p] as const),
    );
    const top = chain.length > 0 ? chain[chain.length - 1] : sessionId;
    for (const p of grouping.projects) {
      if (!p.rootIds.includes(top)) continue;
      // The project, its ancestors, and — under branch grouping — the branch
      // row the session actually hangs off.
      for (const branch of p.branches ?? []) {
        if (!branch.rootIds.includes(top)) continue;
        if (this.collapsed.delete(branchRowKey(p.projectId, branch.name))) {
          changed = true;
        }
      }
      let cursor: string | undefined = p.projectId;
      const seen = new Set<string>();
      while (cursor !== undefined && !seen.has(cursor)) {
        seen.add(cursor);
        if (this.collapsed.delete(projectRowKey(cursor))) changed = true;
        const parent: string | null | undefined = byId.get(cursor)?.parentProjectId;
        cursor = typeof parent === 'string' && parent !== '' ? parent : undefined;
      }
    }
    for (const g of grouping.folders) {
      if (g.rootIds.includes(top) && this.collapsed.delete(folderRowKey(g.key))) {
        changed = true;
      }
    }
    // The appendix group too: a bell click on a "Running elsewhere" session
    // must open the group its row is filed under, seeded collapse or not.
    if (
      grouping.elsewhere !== null &&
      grouping.elsewhere.rootIds.includes(top) &&
      this.collapsed.delete(folderRowKey(grouping.elsewhere.key))
    ) {
      changed = true;
    }
    if (changed) this.groupCacheForest = null;
    await this.selectRow(sessionRowKey(sessionId));
  }

  /** Select a PROJECT row, opening whatever it is filed under first so the row
   *  exists in the flattened model at all. */
  async revealProject(projectId: string): Promise<void> {
    if (projectId === '') return;
    // A project row is not always at depth 0: a subproject only exists in the
    // flattened model while every project above it is expanded, so the walk up
    // has to happen here too.
    try {
      const grouping = this.grouping(this.forest());
      const byId = new Map(
        grouping.projects.map((p) => [p.projectId, p] as const),
      );
      let cursor: string | undefined = byId.get(projectId)?.parentProjectId ?? undefined;
      const seen = new Set<string>([projectId]);
      let changed = false;
      while (typeof cursor === 'string' && cursor !== '' && !seen.has(cursor)) {
        seen.add(cursor);
        if (this.collapsed.delete(projectRowKey(cursor))) changed = true;
        const parent: string | null | undefined = byId.get(cursor)?.parentProjectId;
        cursor = typeof parent === 'string' ? parent : undefined;
      }
      if (changed) this.groupCacheForest = null;
    } catch (err) {
      logError('webtree.revealProject', err);
    }
    await this.selectRow(projectRowKey(projectId));
  }

  /** Re-post the model, then ask the client to select `key`. The re-post has to
   *  come first: the row may only exist because of an expansion this call just
   *  made, and a `select` naming a key the client has not rendered yet is a
   *  no-op it never retries. */
  private async selectRow(key: string, focus = false): Promise<void> {
    this.post();
    try {
      await this.view?.webview.postMessage({ type: 'select', key, focus });
    } catch (err) {
      logError('webtree.selectRow', err);
    }
  }

  /**
   * `reveal`, but the keyboard comes too — the sidebar as a session SWITCHER
   * rather than a list you click (COMMANDS.focusSessionsView).
   *
   * TWO focus moves, and both are needed. `focusView()` reveals the view and
   * hands it the workbench's focus, which gets as far as the webview frame and
   * no further — a webview is an iframe, and focusing it does not focus
   * anything inside it. The `focus` flag on the select message is the second
   * half: the client focuses the tree element itself, which is what the
   * arrow-key handler is actually bound to. Without the first, a Flock sidebar
   * that is collapsed or behind another container never appears at all;
   * without the second it appears with the row highlighted and the arrows
   * still going wherever they were going before — the failure that reads as
   * "nothing happened".
   *
   * `focusView()` also WAITS for a cold webview to finish loading its script,
   * which is why the select is safe to send immediately after it: a message
   * arriving before the page is listening is dropped and never retried.
   *
   * Returns false when the view could not be brought up — the caller
   * (extension.ts) then tries the native tree, which is the same
   * exactly-one-of-the-two shape every other surface here uses.
   */
  async focusSession(sessionId: string): Promise<boolean> {
    if (!isSessionId(sessionId)) return false;
    if (!(await this.focusView())) return false;
    await this.reveal(sessionId);
    await this.selectRow(sessionRowKey(sessionId), true);
    return true;
  }

  /**
   * Ask the client to put an editable input on the row — the F2 / right-click
   * path. Returns whether the edit was actually handed over: a view that has
   * not resolved, or is not visible, has no DOM to edit, and the caller has to
   * know so it can fall back to the quick-input rename instead of silently
   * doing nothing.
   */
  async beginRename(sessionId?: string): Promise<boolean> {
    const view = this.view;
    if (!view || !view.visible) return false;
    // A message that REACHES the client is not the same as a rename that
    // will actually happen: the row might already be gone from the current
    // model (deleted out from under the caller), or it might be a ghost,
    // which `canRename` already refuses. Without this check the postMessage
    // delivery boolean is the only signal `commands.ts`'s quick-input
    // fallback looks at, so a row the client silently ignored (its own
    // `beginRename(key)` in webtree.js bails on `!row || !row.canRename`)
    // read as "handled" and the fallback never ran — the rename verb did
    // nothing at all, with no error and no fallback.
    if (sessionId !== undefined) {
      const key = sessionRowKey(sessionId);
      const row = this.rows().find((r) => r.key === key);
      if (!row || !row.canRename) return false;
    }
    return this.postBeginRename(
      sessionId !== undefined && isSessionId(sessionId)
        ? sessionRowKey(sessionId)
        : undefined,
    );
  }

  /** Ask the client to edit a PROJECT row. The client's own `beginRename(key)`
   *  gates on `row.canRename`, not on the row's kind, so nothing in webtree.js
   *  needs to know a project from a session — the key is the whole contract. */
  async beginRenameProject(projectId: string): Promise<boolean> {
    const view = this.view;
    if (!view || !view.visible || projectId === '') return false;
    const key = projectRowKey(projectId);
    const row = this.rows().find((r) => r.key === key);
    if (!row || !row.canRename) return false;
    return this.postBeginRename(key);
  }

  /** The postMessage tail both rename entry points share. The row/`canRename`
   *  check deliberately does NOT live here: it is caller-specific, because the
   *  key it must look up differs per id space, and hoisting it would have the
   *  project path search the session-row table and always refuse. */
  private async postBeginRename(key?: string): Promise<boolean> {
    try {
      return (
        (await this.view?.webview.postMessage({
          type: 'beginRename',
          ...(key === undefined ? {} : { key }),
        })) === true
      );
    } catch (err) {
      logError('webtree.beginRename', err);
      return false;
    }
  }

  get visible(): boolean {
    return this.view?.visible === true;
  }

  /**
   * Bring the inline view on screen AND give it the keyboard, then wait until
   * its page is actually listening. Answers whether the view is now in a state
   * that can take an inline edit.
   *
   * Naming happens on the row, so every create verb and both rename verbs ask
   * this view for an editable row before they will consider the quick-input
   * fallback — and that ask only succeeds on a view that is on screen
   * (`beginRename` refuses a hidden one). Without a reveal the fallback is not
   * a last resort at all but the normal path: running "Flock: New Session"
   * from the command palette with the sidebar collapsed, or with another
   * activity-bar container showing, is the single most common way a session is
   * created and it never has the view up.
   *
   * FOCUS rather than a bare reveal, because the two are not interchangeable
   * here: the client puts an `<input>` on the row and calls `focus()` on it,
   * and an element focus inside a webview iframe whose window does not have
   * focus does not take the keyboard in Electron. The user would see an edit
   * box while their keystrokes went to the terminal that was launched a moment
   * earlier — and since the client commits on `blur`, no blur would ever fire
   * to end it. Taking focus away from that just-launched terminal is the
   * deliberate trade: the naming interaction was asked to live on the row.
   *
   * `<viewId>.focus` is the public mechanism — the workbench contributes one
   * such command for every contributed view, webview views included. A host
   * that does not offer it (or throws) leaves the answer to the view's own
   * state, so the caller still falls back rather than hanging.
   */
  async focusView(): Promise<boolean> {
    const host: Partial<typeof vscode.commands> = vscode.commands;
    if (typeof host.executeCommand !== 'function') return this.isReady();
    try {
      await host.executeCommand(`${INLINE_VIEW_ID}.focus`);
    } catch (err) {
      logError('webtree.focusView', err);
      return this.isReady();
    }
    // Already up and listening on the first check in every case but a cold
    // reveal, which is the one that needs the wait.
    const deadline = Date.now() + REVEAL_WAIT_MS;
    for (;;) {
      if (this.isReady()) return true;
      if (Date.now() >= deadline) return false;
      await delay(REVEAL_POLL_MS);
    }
  }

  /** Resolved, on screen, and its page has said it is listening — the three
   *  conditions an inline edit needs, none of which implies another. */
  private isReady(): boolean {
    return this.view?.visible === true && this.clientReady;
  }

  // ------------------------------------------------------------- client → us

  private async onMessage(msg: ClientMessage): Promise<void> {
    try {
      switch (msg?.type) {
        case 'ready':
          // The page is subscribed from here on, which is what `focusView()`
          // waits for before a naming verb trusts the inline editor.
          this.clientReady = true;
          this.post();
          this.updateBadge();
          return;

        case 'toggle': {
          const key = typeof msg.key === 'string' ? msg.key : '';
          if (key === '') return;
          // ONE SET, one meaning: "the user closed this". Every row in the tree
          // starts open now — the branch fold, the one kind whose default was
          // shut, is gone, and what replaced it (the whole block, shut in inline
          // mode) is remembered on the project record instead of here.
          const set = this.collapsed;
          if (set.has(key)) set.delete(key);
          else {
            if (set.size > CACHE_SOFT_LIMIT) {
              set.clear();
              // Re-seed the one row whose DEFAULT is collapsed (see the field)
              // — the wipe resets to defaults, and its default is shut.
              set.add(folderRowKey(ELSEWHERE_GROUP_KEY));
            }
            set.add(key);
          }
          this.post();
          return;
        }

        case 'activate': {
          const id = sessionIdFromKey(msg.key);
          if (id) await this.deps.activateSession(id);
          return;
        }

        case 'selection': {
          this.deps.noteSelection?.(sessionIdsFromKeys(msg.keys));
          return;
        }

        case 'deleteSelection': {
          // The Delete key. It carries NO payload: the page has just reported
          // its selection through the message above, and the verb resolves the
          // ids the same way the context menu's does — from the one place that
          // holds them. Same rule as the branch chips: the client names a
          // gesture, the extension decides what it acts on.
          await this.deps.runCommand('deleteSessions');
          return;
        }

        case 'rename': {
          // The client edits whatever row says `canRename`, and that includes
          // project rows — so a committed name has to be routed by the KIND of
          // key it came back on. Matching only `session:` here is what made an
          // inline project rename look like it worked and then snap back: the
          // key matched nothing, the message was dropped, and the next model
          // post re-rendered the old label with no error anywhere.
          const name = typeof msg.name === 'string' ? msg.name.trim() : '';
          if (name === '') return;
          const sessionId = sessionIdFromKey(msg.key);
          if (sessionId) {
            await this.deps.renameSession(sessionId, name);
            return;
          }
          const projectId = projectIdFromKey(msg.key);
          if (projectId) {
            await this.deps.renameProject(projectId, name);
            return;
          }
          return;
        }

        case 'renameCancelled': {
          this.deps.renameCancelled();
          return;
        }

        case 'drop': {
          await this.onDrop(msg);
          return;
        }

        case 'command': {
          // Only the welcome buttons, and only these ids — never an arbitrary
          // string from the webview.
          if (msg.command === 'newSession') {
            await this.deps.runCommand('newSession');
          } else if (msg.command === 'newProject') {
            await this.deps.runCommand('newProject');
          } else if (msg.command === 'importSessions') {
            await this.deps.runCommand('importSessions');
          } else if (msg.command === 'recommendedSetup') {
            await this.deps.runCommand('recommendedSetup');
          }
          return;
        }

        case 'action': {
          // A row action names an ALLOWLISTED action, never a command id: the
          // client sends 'chat' and this side decides which verb that is, so a
          // compromised or buggy page cannot invoke a command the extension
          // never offered on a row.
          //
          // A BRANCH row carries one too, once grouping is on and a click
          // on the row toggles it instead of starting a session. It resolves
          // through the rendered model exactly as the branch click does — the
          // page names a row, never a directory.
          if (String(msg.action) === 'newSessionInBranch') {
            const row = this.branchRowFor(msg.key);
            if (!row?.chip || row.chip.dir === '') return;
            await this.deps.runCommand('newSessionInBranch', {
              type: 'branch',
              projectId: row.projectId,
              dir: row.chip.dir,
              branch: row.chip.full,
            });
            return;
          }
          // THE TWO LINKS ON A BRANCH — its name and its `#42` — resolved the
          // same way everything else in here is: the page names a row, this side
          // reads the checkout off the model it posted. Neither command is handed
          // a url; `openPullRequest` looks its own one up in the cache the row
          // rendered from (see openPullRequestFlow for why that is a hard rule)
          // and `openBranchOnRemote` builds one from the repository's own remote.
          const linkCommand = BRANCH_LINK_ACTIONS[String(msg.action)];
          if (linkCommand !== undefined) {
            const target = this.linkTargetFor(msg.key);
            if (!target) return;
            await this.deps.runCommand(linkCommand, { type: 'branch', ...target });
            return;
          }
          // A SUBPROJECT row's `+`, resolved the same way: the page names the
          // row, this side reads the directory off the model it posted. The
          // project row's `+` is withdrawn while these exist precisely so that
          // no button in the tree has to guess which directory was meant.
          if (String(msg.action) === 'newSessionInSubproject') {
            const row = this.subprojectRowFor(msg.key);
            if (!row?.cwd || row.cwd === '' || !row.projectId) return;
            await this.deps.runCommand('newSessionInSubproject', {
              type: 'subproject',
              projectId: row.projectId,
              dir: row.cwd,
            });
            return;
          }
          const command = PROJECT_ROW_ACTIONS[String(msg.action)];
          if (command === undefined) return;
          const projectId = projectIdFromKey(msg.key);
          if (!projectId) return;
          // Exactly the shape projectIdFromArg() reads, so the handler cannot
          // tell a row action from a native context-menu invocation.
          await this.deps.runCommand(command, {
            type: 'project',
            projectId,
          });
          return;
        }

        case 'branch': {
          // A branch row click. The directory is NOT taken from the message —
          // the page would be naming an arbitrary path for the extension to
          // spawn a shell in. The client sends the ROW KEY and this side reads
          // the directory out of the model it just rendered, so the only
          // directories reachable from this view are the ones git reported for
          // a project the user created.
          // A ref with no checkout is allowed through now: newSessionInBranch
          // cuts the worktree for it, behind its own confirmation. What is still
          // refused is a key naming no row at all.
          const row = this.branchRowFor(msg.key);
          if (!row?.chip) return;
          await this.deps.runCommand('newSessionInBranch', {
            type: 'branch',
            projectId: row.projectId,
            dir: row.chip.dir,
            branch: row.chip.full,
          });
          return;
        }

        default:
          return;
      }
    } catch (err) {
      logError('webtree.onMessage', err);
    }
  }

  /**
   * Drop semantics. A drag moves a session between PROJECTS and does nothing
   * else:
   *   onto a PROJECT (or one of its subproject rows) -> teach that project this
   *                                                     session's directory
   *   anything else                                  -> refused
   *
   * LINEAGE IS NOT DRAGGABLE, and that is the whole rule. A drop onto a session
   * row used to re-parent, and a drop onto a folder row used to detach to a
   * root — so a fork could be dragged out of the tree it branched from, and an
   * unrelated conversation could be dragged into one. Both produce a tree that
   * states something false: the spine says "this branched from that", the
   * transcripts say otherwise, and nothing on screen distinguishes the edge the
   * user drew from the ones claude actually recorded. A shape that took one
   * careless drag to corrupt and a state-file edit to repair.
   *
   * So ancestry is left to the thing that owns it — `recordLaunch` at fork time,
   * and inference from the transcripts — and the gesture keeps the one meaning
   * a user can be wrong about harmlessly: which project a top-level session is
   * filed under, which is an ADDRESS, derived from a directory, editable from
   * the project's own verbs, and true or false independently of any transcript.
   *
   * Only a visible ROOT moves. A row drawn inside a tree is frozen: that is what
   * `canDrag` withholds from every non-root row (see viewmodel.ts), and this is
   * the same rule enforced on the message, because the page is not trusted to be
   * the only thing that ever posts one.
   */
  private async onDrop(msg: ClientMessage): Promise<void> {
    const targetKey = typeof msg.targetKey === 'string' ? msg.targetKey : '';
    if (targetKey === '') return;

    // A PROJECT source is DECLINED. Dragging a project row onto another project
    // filed it there as a subproject; that is retired (a subproject is a
    // directory now), and the row no longer offers the drag — `canDrag` is false
    // on it. Checked first and never mixed with the session path anyway, because
    // a project id and a session id are both bare uuids and the only thing
    // telling the two gestures apart is which key the page reported as the
    // source.
    if (projectIdFromKey(msg.sourceKey) !== undefined) return;

    const dragged = typeof msg.sessionId === 'string' ? msg.sessionId : '';
    if (!isSessionId(dragged)) return;

    // A SUBPROJECT row counts as its project: the gesture means "this work
    // belongs over there", and the row aimed at is one of that project's
    // directories. Resolved through the RENDERED model rather than by slicing the
    // key, because a dirKey can contain a colon on Windows — and because the page
    // must never be able to name a project id the view did not draw.
    const ontoSub = this.subprojectRowFor(targetKey);
    const ontoProject = targetKey.startsWith('project:')
      ? targetKey.slice('project:'.length)
      : ontoSub?.projectId;
    if (ontoProject === undefined || ontoProject === '') {
      // A session row is the one wrong target worth explaining: it looks like it
      // should do something, it used to, and silence would read as a bug. A
      // folder row is left silent — nothing about it suggests it accepts a
      // session, and a message for every stray drop would be noise.
      if (sessionIdFromKey(targetKey) !== undefined) {
        log('webtree.drop: refused lineage drag', dragged, '->', targetKey);
        this.notify(
          'Flock: sessions cannot be dragged into or out of a tree — a fork ' +
            'sits under the session it branched from. Drag a top-level ' +
            'session onto a project to file it there.',
        );
      }
      return;
    }

    // Only a visible ROOT can move: a project row renders roots only, so
    // dragging a nested fork onto it would silently do nothing on screen while
    // still appending its cwd to the project's directory list.
    if (!this.forest().visibleRoots.includes(dragged)) {
      this.notify(
        'Flock: only a top-level session can be moved to a project — a ' +
          'fork follows the session it branched from.',
      );
      return;
    }
    await this.deps.assignToProject(dragged, ontoProject);
  }

  private notify(message: string): void {
    try {
      const w: Partial<typeof vscode.window> = vscode.window;
      if (typeof w.showInformationMessage === 'function') {
        void w.showInformationMessage(message);
      } else {
        log('webtree:', message);
      }
    } catch (err) {
      logError('webtree.notify', err);
    }
  }

  dispose(): void {
    for (const d of this.viewSubs.splice(0)) {
      try {
        d.dispose();
      } catch (err) {
        logError('webtree.dispose.viewSubs', err);
      }
    }
    this.collapsed.clear();
    this.view = undefined;
    this.clientReady = false;
  }
}

/** `session:<uuid>` -> uuid, and nothing else. Guards against a webview message
 *  naming a row kind whose id is not a session. */
export function sessionIdFromKey(key: unknown): string | undefined {
  if (typeof key !== 'string' || !key.startsWith('session:')) return undefined;
  const id = key.slice('session:'.length);
  return isSessionId(id) ? id : undefined;
}

/**
 * A reported selection — row keys — as the session ids a verb can act on.
 *
 * Everything that is not a `session:<uuid>` key is dropped rather than
 * rejected: a selection is allowed to contain a project or a folder row (the
 * user shift-clicked across one), and the answer for a session verb is simply
 * that those are not sessions. Duplicates go too — the client holds its
 * selection in a Set and cannot produce them, but "cannot" is not a reason for
 * the delete path to be willing to name the same row twice.
 *
 * Exported because it is the whole of the parsing and the only part worth a
 * test: the message handler around it needs a webview to reach.
 */
export function sessionIdsFromKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of raw) {
    const id = sessionIdFromKey(key);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** `project:<id>` -> id, and nothing else. A project id is a uuid but is NOT
 *  routed through isSessionId: the two id spaces are independent and coupling
 *  them here would be a rule nobody stated. Emptiness is the only refusal. */
export function projectIdFromKey(key: unknown): string | undefined {
  if (typeof key !== 'string' || !key.startsWith('project:')) return undefined;
  const id = key.slice('project:'.length);
  return id === '' ? undefined : id;
}

/**
 * `branch:<projectId>:<branch name>` -> the two parts, or undefined.
 *
 * Split on the FIRST TWO colons only, and never on the last: a branch name may
 * legally contain a colon, and splitting greedily would silently mangle
 * `feat:thing` into a project id nobody has. The project id is a uuid and
 * cannot contain one, so the first two are always the delimiters.
 *
 * Its own reader rather than a generalised one, for the same reason
 * projectIdFromKey is: a branch row and the project header carry the SAME
 * project id under different key prefixes, and a parser that accepted either
 * would let one row's message invoke another row's verb.
 */
export function branchRowParts(
  key: unknown,
): { projectId: string; branch: string } | undefined {
  if (typeof key !== 'string' || !key.startsWith('branch:')) return undefined;
  const rest = key.slice('branch:'.length);
  const at = rest.indexOf(':');
  if (at <= 0) return undefined;
  const branch = rest.slice(at + 1);
  return branch === ''
    ? undefined
    : { projectId: rest.slice(0, at), branch };
}

export interface WebtreeController extends DisposableLike {
  refresh(): void;
  revealSession(sessionId: string): Promise<void>;
  /** revealSession, plus the keyboard: reveal the view, select the row and
   *  focus the tree so the arrows switch sessions from there. False when the
   *  view could not be brought up. */
  focusSession(sessionId: string): Promise<boolean>;
  revealProject(projectId: string): Promise<void>;
  /** Show the view, give it the keyboard, and wait for its page to listen.
   *  Anything that is about to ask for an inline edit calls this first — see
   *  LineageWebtreeProvider.focusView. */
  focusView(): Promise<boolean>;
  beginRename(sessionId?: string): Promise<boolean>;
  beginRenameProject(projectId: string): Promise<boolean>;
  /** The branches this view is currently SHOWING for a project. The
   *  chip-click verb resolves against this rather than re-probing git, so it can
   *  only ever start a session in a worktree the user was looking at. */
  branchesOf(projectId: string): readonly BranchInfo[];
  /** Is this view on screen? Asked by the pull-request cache, which must not talk
   *  to GitHub for a tree nobody is looking at. The provider already tracks it —
   *  this exposes it, because `post()` runs whether the view is visible or not and
   *  the network gate cannot be inferred from that. */
  readonly visible: boolean;
}

export function registerWebtree(
  deps: WebtreeDeps,
  extensionUri: vscode.Uri,
): WebtreeController {
  const provider = new LineageWebtreeProvider(deps, extensionUri);

  const disposables: vscode.Disposable[] = [];
  try {
    disposables.push(
      vscode.window.registerWebviewViewProvider(INLINE_VIEW_ID, provider, {
        // The forest is cheap to re-post but the collapsed set is not persisted,
        // so keeping the DOM alive across a hide/show is what stops the tree
        // from silently re-expanding every time the panel is collapsed.
        webviewOptions: { retainContextWhenHidden: true },
      }),
    );
  } catch (err) {
    logError('webtree.register', err);
  }

  let dataSub: DisposableLike | undefined;
  try {
    dataSub = deps.onDidChangeData(() => provider.refresh());
  } catch (err) {
    logError('webtree.onDidChangeData', err);
  }

  return {
    refresh: () => provider.refresh(),
    revealSession: (sessionId) => provider.reveal(sessionId),
    focusSession: (sessionId) => provider.focusSession(sessionId),
    revealProject: (projectId) => provider.revealProject(projectId),
    focusView: () => provider.focusView(),
    beginRename: (sessionId) => provider.beginRename(sessionId),
    beginRenameProject: (projectId) => provider.beginRenameProject(projectId),
    branchesOf: (projectId) => provider.branchesOf(projectId),
    get visible(): boolean {
      return provider.visible;
    },
    dispose(): void {
      try {
        dataSub?.dispose();
      } catch (err) {
        logError('webtree.dispose.sub', err);
      }
      for (const d of disposables) {
        try {
          d.dispose();
        } catch (err) {
          logError('webtree.dispose', err);
        }
      }
      provider.dispose();
    },
  };
}
