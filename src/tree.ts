// src/tree.ts — TreeDataProvider + TreeView + drag-and-drop reparenting.
//
// A view layer and nothing more: it must not fire onDidChangeTreeData with []
// (fire undefined), mutate the forest, execute any command, or import
// terminals/state/lineage.

import * as vscode from 'vscode';
import {
  ATTENTION_BADGE_ENABLED,
  BRAND_COLOR_ID,
  COMMANDS,
  DEFAULT_PROVIDER,
  PROVIDERS,
  PROVIDER_MEDIA_DIR,
  TREE_DND_MIME,
  VIEW_ID,
  contextValueOf,
  isSessionId,
  shortId,
} from './types';
import type {
  BranchInfo,
  BranchStatus,
  BranchTreeNode,
  DisposableLike,
  GroupNode,
  ProjectGroupNode,
  ProjectRecord,
  ProviderId,
  PullRequest,
  SessionForest,
  SessionNode,
  SessionRef,
  TreeDeps,
  TreeNode,
} from './types';
import { log, logError } from './log';
import { projectUri, sessionUri } from './decorations';
import { computeGrouping, unbranchedRoots } from './projects';
import type { GroupingResult } from './projects';

/** TreeView.reveal expands at most 3 levels — the API's hard cap. */
const REVEAL_EXPAND_LEVELS = 3;
/** Upper bound on the interned-element / shadow-expansion caches. */
const CACHE_SOFT_LIMIT = 2000;

const EMPTY_GROUPING: GroupingResult = {
  projects: [],
  folders: [],
  loose: [],
  hiddenCount: 0,
};

const EMPTY_FOREST: SessionForest = {
  nodes: new Map(),
  roots: [],
  visibleRoots: [],
  edges: [],
  attentionCount: 0,
  generatedAt: 0,
};

// ------------------------------------------------------------ pure helpers

// formatAge / statusDescriptor / sessionContextValue / projectContextValue moved
// to ./viewmodel: the native tree and the inline webview must render a row
// identically, and two copies of "how a row reads" would diverge on the first
// change. Re-exported so importers and tests keep their existing entry point.
import {
  BRANCH_CHIPS_MIN,
  branchStatusLines,
  branchTokens,
  formatAge,
  formatBranchSync,
  formatPullRequestChip,
  formatTokens,
  projectContextValue,
  pullRequestLines,
  sessionContextValue,
  statusDescriptor,
  statusTone,
} from './viewmodel';

export {
  formatAge,
  formatTokens,
  projectContextValue,
  sessionContextValue,
  statusDescriptor,
} from './viewmodel';

/** Escape the markdown that matters inside a trusted MarkdownString. Labels
 *  come from roster names and user renames — never trust them verbatim.
 *
 *  This matters more than it looks: `isTrusted` enables `command:` links, so
 *  ANY unescaped interpolation is a one-click command injection. Directory
 *  names are as untrusted as labels — a cwd comes straight from
 *  `claude agents --json` or a transcript, and backticks and brackets are
 *  legal in POSIX path names. */
function mdEscape(s: string): string {
  return s.replace(/[\\`*_[\]<>#|]/g, (m) => `\\${m}`);
}

/** A path rendered inside a code span. Same escaping, same reason. */
function mdCode(s: string): string {
  return `\`${mdEscape(s)}\``;
}

/** `window.showInformationMessage` is absent under the unit-test double (and
 *  could be on a slimmed-down host), and a missing toast must never abort a
 *  drop. Same optional-member discipline the terminals module uses. */
function notify(message: string): void {
  try {
    const w: Partial<typeof vscode.window> = vscode.window;
    if (typeof w.showInformationMessage === 'function') {
      void w.showInformationMessage(message);
    } else {
      log('tree:', message);
    }
  } catch (err) {
    logError('tree.notify', err);
  }
}

function nodeKey(el: TreeNode): string {
  if (el.type === 'group') return `group:${el.key}`;
  if (el.type === 'project') return `project:${el.projectId}`;
  // Project id FIRST and split nowhere, for the reason branchRowKey gives: a
  // branch name may contain anything a ref can, a colon included.
  if (el.type === 'branch') return `branch:${el.projectId}:${el.branch}`;
  return el.id;
}

/** Cache key for the grouping pass: everything outside the forest that can
 *  change the shape of the top level. Cheap to build (a handful of projects)
 *  and it is what keeps getChildren() from recomputing on every hover. */
function groupingSignature(
  projects: readonly ProjectRecord[],
  hiddenFolders: readonly string[],
  groupByFolder: boolean,
  onlyProjectSessions: boolean,
): string {
  const p = projects
    .map(
      (x) =>
        // `parentId` is in here for the same reason every other field is:
        // this string is what decides whether the cached grouping can be
        // reused, and a project that was re-filed changes nothing else about
        // itself — so without it, moving a project would leave the tree drawing
        // the old nesting until something unrelated happened to change.
        `${x.id}\u0000${x.name}\u0000${x.rootDir}\u0000${(x.dirs ?? []).join(
          '\u0001',
        )}\u0000${x.provider ?? ''}\u0000${x.hidden === true ? '1' : '0'}\u0000${
          typeof x.parentId === 'string' ? x.parentId : ''
        }`,
    )
    .join('\u0002');
  return `${groupByFolder ? '1' : '0'}${onlyProjectSessions ? '1' : '0'}|${p}|${hiddenFolders.join('\u0002')}`;
}

// ---------------------------------------------------------------- provider

export class LineageTreeProvider
  implements
    vscode.TreeDataProvider<TreeNode>,
    vscode.TreeDragAndDropController<TreeNode>
{
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();

  readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined> =
    this.emitter.event;

  readonly dropMimeTypes: string[] = [TREE_DND_MIME];
  readonly dragMimeTypes: string[] = [TREE_DND_MIME, 'text/plain'];

  private readonly deps: TreeDeps;

  /** Interned elements: the workbench keys its internal node map on element
   *  identity, so handing back the same object for the same id keeps reveal()
   *  and selection cheap and stable. */
  private readonly refs = new Map<string, SessionRef>();

  /** The same interning for branch container rows, keyed
   *  `<projectId>\u0000<branch>`. See branchRef(). */
  private readonly branchRefs = new Map<string, BranchTreeNode>();

  /** There is no API to READ expansion state and no collapse API, so shadow
   *  it from the TreeView's expand/collapse events. Only explicit user
   *  collapses are recorded; the default stays Expanded. */
  private readonly collapsedKeys = new Set<string>();

  private lastForest: SessionForest = EMPTY_FOREST;

  private groupCacheForest: SessionForest | null = null;
  private groupCacheSignature: string | null = null;
  private groupCache: GroupingResult = EMPTY_GROUPING;

  private parentIndexForest: SessionForest | null = null;
  private parentIndex = new Map<string, string | null>();

  constructor(deps: TreeDeps) {
    this.deps = deps;
  }

  // ------------------------------------------------------------- internals

  /** Never let a throwing dependency blank the tree: keep the last good
   *  forest and log. */
  private forest(): SessionForest {
    try {
      const f = this.deps.getForest();
      if (f && f.nodes) {
        this.lastForest = f;
        return f;
      }
    } catch (err) {
      logError('tree.getForest', err);
    }
    return this.lastForest;
  }

  /** Interned SessionRef for an id. Public so registerTree().revealSession()
   *  can reveal the very object the tree already knows. */
  sessionRef(id: string): SessionRef {
    let ref = this.refs.get(id);
    if (!ref) {
      if (this.refs.size > CACHE_SOFT_LIMIT) this.refs.clear();
      ref = { type: 'session', id };
      this.refs.set(id, ref);
    }
    return ref;
  }

  /** A dependency that throws must never blank the tree — every one of these
   *  degrades to the value that renders the most, not the least. */
  private safe<T>(what: string, read: () => T, dflt: T): T {
    try {
      const v = read();
      return v === undefined || v === null ? dflt : v;
    } catch (err) {
      logError(`tree.${what}`, err);
      return dflt;
    }
  }

  private groupingFor(forest: SessionForest): GroupingResult {
    const groupByFolder = this.safe('groupByFolder', () => this.deps.groupByFolder(), true);
    const onlyProjectSessions = this.safe(
      'onlyProjectSessions',
      () => this.deps.onlyProjectSessions(),
      false,
    );
    const projects = this.safe<ProjectRecord[]>('projects', () => this.deps.projects(), []);
    const hiddenFolders = this.safe<string[]>(
      'hiddenFolders',
      () => this.deps.hiddenFolders(),
      [],
    );

    const signature = groupingSignature(
      projects,
      hiddenFolders,
      groupByFolder,
      onlyProjectSessions,
    );
    if (
      this.groupCacheForest === forest &&
      this.groupCacheSignature === signature
    ) {
      return this.groupCache;
    }

    this.groupCache = computeGrouping(
      {
        visibleRootIds: forest.visibleRoots,
        cwdOf: (id) => forest.nodes.get(id)?.cwd,
        projects,
        hiddenFolders,
        groupByFolder,
        onlyProjectSessions,
        // The native tree draws no chips — a TreeItem has one label, one
        // icon and no room for a strip of buttons — but it must still CLAIM
        // worktree sessions for their project, or the two view styles would
        // disagree about which rows a project contains. Grouping is shared;
        // only the rendering of it differs.
        worktreesOf: (dir) => {
          try {
            return this.deps.worktreesOf?.(dir) ?? [];
          } catch {
            return [];
          }
        },
      },
      this.groupCache,
    );
    this.groupCacheForest = forest;
    this.groupCacheSignature = signature;
    return this.groupCache;
  }

  /**
   * child id → id of the node it hangs under IN THE VISIBLE TREE (which is not
   * necessarily node.parentId: hidden and pruned-ghost ancestors are spliced
   * out and their children promoted). null = visible root.
   *
   * Walked DOWN from the visible roots, never over `forest.nodes` at large.
   * buildForest assigns `visibleChildren` to EVERY node, invisible ones
   * included, so a flat pass would let a hidden or pruned-ghost parent claim
   * the child it was spliced out of — overwriting the correct entry and
   * handing `reveal()` a parent chain through a row that `getChildren()` never
   * returns. Which of the two won even depended on roster insertion order.
   * Descending from the roots makes invisible nodes unreachable by
   * construction, so getParent() and getChildren() cannot disagree.
   */
  private visibleParents(forest: SessionForest): Map<string, string | null> {
    if (this.parentIndexForest === forest) return this.parentIndex;
    const map = new Map<string, string | null>();
    const stack: string[] = [];
    for (const rootId of forest.visibleRoots) {
      if (map.has(rootId)) continue;
      map.set(rootId, null);
      stack.push(rootId);
    }
    for (;;) {
      const id = stack.pop();
      if (id === undefined) break;
      const node = forest.nodes.get(id);
      if (!node) continue;
      for (const childId of node.visibleChildren) {
        if (map.has(childId)) continue; // first (and only) visible parent wins
        map.set(childId, id);
        stack.push(childId);
      }
    }
    this.parentIndexForest = forest;
    this.parentIndex = map;
    return map;
  }

  /**
   * Sessions waiting on the user that are ACTUALLY ON SCREEN.
   *
   * `forest.attentionCount` cannot answer this: buildForest is never given the
   * projects or the hidden-folder list, so it counts every waiting session,
   * including the ones a hidden folder, a hidden project or
   * `lineage.onlyProjectSessions` removes from the tree. Badging those leaves
   * a permanent count with no row anywhere to open or dismiss — and hiding a
   * noisy folder is exactly when a user reaches for that setting.
   */
  /**
   * The branches this view currently accounts for, under one project — the same
   * answer webtree.ts's `branchesOf` gives, from this view's own grouping.
   *
   * It exists because the worktree verbs are in the COMMAND PALETTE. The chip
   * verbs before them were not, so "only the inline view can reach this" was a
   * true statement and the native tree needed no way to answer; a verb reachable
   * from the palette can be run with either view style on screen — or with the
   * native one, whose branch rows carry the same context menu — so the answer has
   * to come from whichever view drew the rows.
   *
   * Not filtered by `groupSessionsByBranch`. That setting decides whether this
   * view draws branch rows, not which worktrees a project HAS, and a verb that
   * refused to work because of a layout preference would be refusing for a reason
   * the user cannot see.
   */
  branchesOf(projectId: string): readonly BranchInfo[] {
    try {
      const grouping = this.groupingFor(this.forest());
      return (
        grouping.projects.find((p) => p.projectId === projectId)?.branches ?? []
      );
    } catch (err) {
      logError('tree.branchesOf', err);
      return [];
    }
  }

  attentionCount(): number {
    try {
      const forest = this.forest();
      const grouping = this.groupingFor(forest);
      const roots = [
        ...grouping.projects.flatMap((p) => p.rootIds),
        ...grouping.folders.flatMap((g) => g.rootIds),
        ...grouping.loose,
      ];
      const seen = new Set<string>();
      const stack = [...roots];
      let count = 0;
      for (;;) {
        const id = stack.pop();
        if (id === undefined) break;
        if (seen.has(id)) continue;
        seen.add(id);
        const node = forest.nodes.get(id);
        if (!node) continue;
        // The badge counts exactly the GREEN dots on screen: unseen-done
        // where tracking is on, waiting where it is off. statusTone already
        // withholds the dot from muted rows — hiding a session is exactly how
        // the user says "stop telling me about this one".
        if (statusTone(node) === 'done') count++;
        stack.push(...node.visibleChildren);
      }
      return count;
    } catch (err) {
      logError('tree.attentionCount', err);
      return 0;
    }
  }

  private isCollapsed(el: TreeNode): boolean {
    return this.collapsedKeys.has(nodeKey(el));
  }

  /** Wired by registerTree() from TreeView.onDidExpandElement. */
  noteExpanded(el: TreeNode): void {
    this.collapsedKeys.delete(nodeKey(el));
  }

  /** Wired by registerTree() from TreeView.onDidCollapseElement. */
  noteCollapsed(el: TreeNode): void {
    if (this.collapsedKeys.size > CACHE_SOFT_LIMIT) this.collapsedKeys.clear();
    this.collapsedKeys.add(nodeKey(el));
  }

  // ------------------------------------------------------------ tree data

  getChildren(el?: TreeNode): TreeNode[] {
    try {
      const forest = this.forest();

      if (!el) {
        // Projects first, then folder rows for whatever no project claims,
        // then bare sessions. An empty root list (NOT a placeholder node) is
        // what makes the contributes.viewsWelcome empty state render.
        //
        // Only the TOP-LEVEL projects. `grouping.projects` is a preorder
        // list of the whole forest, and a subproject is returned by its
        // parent's getChildren instead — returning them all here would draw
        // every project at the root AND again under its parent.
        const grouping = this.groupingFor(forest);
        return [
          ...grouping.projects.filter((p) => (p.depth ?? 0) === 0),
          ...grouping.folders,
          ...grouping.loose.map((id) => this.sessionRef(id)),
        ];
      }

      if (el.type === 'project') {
        return this.projectChildren(forest, el);
      }

      if (el.type === 'branch') {
        return el.rootIds.map((id) => this.sessionRef(id));
      }

      if (el.type === 'group') {
        return el.rootIds.map((id) => this.sessionRef(id));
      }

      const node = forest.nodes.get(el.id);
      if (!node) return []; // forest changed mid-walk
      return node.visibleChildren.map((id) => this.sessionRef(id));
    } catch (err) {
      logError('tree.getChildren', err);
      return [];
    }
  }

  /**
   * What hangs under a project row: its subprojects, then its branches (only
   * under `lineage.groupSessionsByBranch`), then its sessions.
   *
   * SUBPROJECTS FIRST, unlike the Explorer's folders-before-files by accident:
   * a project's sessions are a list that grows all day and its subprojects are
   * a structure that does not, so putting the stable thing at the top is what
   * keeps the structure findable once there are fifteen sessions under it.
   */
  private projectChildren(
    forest: SessionForest,
    el: ProjectGroupNode,
  ): TreeNode[] {
    const grouping = this.groupingFor(forest);
    const byId = new Map(grouping.projects.map((p) => [p.projectId, p] as const));
    const out: TreeNode[] = [];
    for (const childId of el.childProjectIds ?? []) {
      const child = byId.get(childId);
      if (child) out.push(child);
    }

    const branches = el.branches ?? [];
    const grouped =
      branches.length >= BRANCH_CHIPS_MIN &&
      // Folded (the project's own `branchesCollapsed`) means the block is not
      // on screen, and under grouping the sessions hang off that block — so a
      // fold has to put them back under the project rather than take them with
      // it. Same rule as the inline sidebar's; the two views must not disagree
      // about which rows a project contains.
      el.branchesCollapsed !== true &&
      this.safe('groupSessionsByBranch', () => this.deps.groupSessionsByBranch?.(), false) === true;
    if (!grouped) {
      out.push(...el.rootIds.map((id) => this.sessionRef(id)));
      return out;
    }

    // Only the branches the user has on screen; the folded-away ones keep their
    // sessions directly under the project (unbranchedRoots), which is what stops
    // a curation decision about ROWS from hiding SESSIONS.
    const repoDir = (branches.find((b) => b.primary) ?? branches[0])?.dir ?? '';
    for (const branch of branches) {
      if (branch.shown === false) continue;
      out.push(this.branchRef(el.projectId, branch, repoDir));
    }
    out.push(
      ...unbranchedRoots(el.rootIds, branches).map((id) => this.sessionRef(id)),
    );
    return out;
  }

  /** Interned branch node, for the same reason sessionRef interns: the
   *  workbench keys expansion state on element identity, so a fresh object per
   *  refresh would collapse every open branch on every roster tick. */
  private branchRef(
    projectId: string,
    branch: BranchInfo,
    /** The repository's main worktree, the same for every branch under this
     *  project. Passed in rather than derived here because the caller already has
     *  the whole branch list and this function only ever sees one entry of it. */
    repoDir: string,
  ): BranchTreeNode {
    const key = `${projectId}\u0000${branch.name}`;
    const existing = this.branchRefs.get(key);
    const next: BranchTreeNode = {
      type: 'branch',
      projectId,
      branch: branch.name,
      dir: branch.dir,
      repoDir,
      colorIndex: branch.colorIndex,
      primary: branch.primary,
      rootIds: branch.rootIds.slice(),
    };
    if (
      existing &&
      existing.dir === next.dir &&
      // In the identity comparison because it is ON the node: a repository that
      // moved is a different row, and an interned node that kept the old anchor
      // would keep asking `gh` about a directory that is gone.
      existing.repoDir === next.repoDir &&
      existing.primary === next.primary &&
      existing.colorIndex === next.colorIndex &&
      existing.rootIds.length === next.rootIds.length &&
      existing.rootIds.every((id, i) => id === next.rootIds[i])
    ) {
      return existing;
    }
    if (this.branchRefs.size > CACHE_SOFT_LIMIT) this.branchRefs.clear();
    this.branchRefs.set(key, next);
    return next;
  }

  getTreeItem(el: TreeNode): vscode.TreeItem {
    try {
      if (el.type === 'group') return this.groupItem(el);
      if (el.type === 'project') return this.projectItem(el);
      if (el.type === 'branch') return this.branchItem(el);
      return this.sessionItem(el, this.forest());
    } catch (err) {
      logError('tree.getTreeItem', err);
      const fallback = new vscode.TreeItem(
        el.type === 'session'
          ? shortId(el.id)
          : el.type === 'branch'
            ? el.branch
            : el.label,
        vscode.TreeItemCollapsibleState.None,
      );
      fallback.id = nodeKey(el);
      return fallback;
    }
  }

  /**
   * A project row. It is always expandable even with no sessions: collapsing
   * an empty project would hide the only affordance it has, and an expandable
   * row with nothing under it reads correctly as "nothing running here yet".
   */
  private projectItem(el: ProjectGroupNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      el.label,
      this.isCollapsed(el)
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.Expanded,
    );
    item.id = `project:${el.projectId}`;

    // No session count — the rows underneath ARE the count. Only the extra
    // directories get a word, because nothing else on screen shows them.
    // Mirrors pushProject() in viewmodel.ts; the two must read identically.
    const extra = el.dirs.length - 1;
    item.description =
      extra > 0 ? `+${extra} dir${extra === 1 ? '' : 's'}` : undefined;

    // Deliberately unbranded: a project is a container, not a session, so it
    // gets no LLM logo and no ThemeColor. `undefined` would be worse than a
    // plain ThemeIcon — the workbench then derives an icon from `resourceUri`
    // (a fake `lineage-project:` scheme with no extension) through whatever
    // file-icon theme is active, which is unpredictable rather than absent.
    // `providerIcon()` stays reserved for sessionItem(), below.
    // A SUBPROJECT gets the plain folder glyph and a top-level project
    // keeps the root marker. The native tree indents by 8px per level and
    // draws no band, so the icon is the only thing left to say which rows are
    // the roots of the view — with one glyph for both, a four-project tree
    // reads as four peers whatever the indentation does.
    item.iconPath = new vscode.ThemeIcon(
      (el.depth ?? 0) > 0 ? 'folder-library' : 'root-folder',
    );
    item.contextValue = projectContextValue(el);
    // A project row IS decorated — but only under its own scheme,
    // which lights the attention dot when a session beneath it is unseen-done
    // and renders nothing otherwise.
    item.resourceUri = projectUri(el.projectId);
    return item;
  }

  /**
   * A branch CONTAINER row (`lineage.groupSessionsByBranch` only).
   *
   * Deliberately plain next to the inline sidebar's version: a TreeItem has one
   * label, one icon and one description, and no way to draw a coloured swatch —
   * so the colour, which is the whole of the inline row's language, has nothing
   * to live in here. What survives is what the row is FOR: the branch's name,
   * how many sessions are on it, and the fact that it opens.
   *
   * The status is read LIVE here rather than carried on the node, on purpose.
   * `branchRef` interns its nodes so the workbench's expansion state survives a
   * roster tick, which means anything stored on one has to be part of its
   * identity — and a node whose identity changed every time a file was saved
   * would collapse the row the user had just opened.
   */
  private branchItem(el: BranchTreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      el.branch,
      el.rootIds.length === 0
        ? vscode.TreeItemCollapsibleState.None
        : this.isCollapsed(el)
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded,
    );
    item.id = nodeKey(el);
    const status = this.safe<BranchStatus | undefined>(
      'branchStatusOf',
      () => this.deps.branchStatusOf?.(el.dir),
      undefined,
    );
    const pr = this.safe<PullRequest | undefined>(
      'pullRequestFor',
      () => this.deps.pullRequestFor?.(el.repoDir, el.branch),
      undefined,
    );
    // Same order as the inline row draws them in — where the checkout stands, the
    // request, then how many sessions are on it — so somebody switching renderers
    // reads the same line in the same place. Joined by a space rather than a
    // separator: a TreeItem description is already dim, small and right-aligned,
    // and ' · ' in it reads as a third field.
    const description = [
      formatBranchSync(status),
      pr ? formatPullRequestChip(pr) : '',
      String(el.rootIds.length || ''),
    ]
      .filter((part) => part !== '')
      .join(' ');
    item.description = description === '' ? undefined : description;
    item.iconPath = new vscode.ThemeIcon('git-branch');
    // The native tree had no hover on a branch row at all, because the label and
    // the description said everything there was. The status changes that: `↑2 ↓1
    // *` needs somewhere to say what it is ahead OF, and `#42` needs somewhere to
    // say what it is called.
    item.tooltip = [
      el.branch,
      ...branchStatusLines(status),
      ...pullRequestLines(pr),
      el.dir,
    ].join('\n');
    item.contextValue = contextValueOf(branchTokens(el.primary, pr !== undefined));
    // Clicking an EMPTY branch starts a session in it — there is nothing to
    // open, and that is what the row is for. A branch with sessions under it
    // opens instead (the workbench toggles it), and the `+` for a new one is on
    // its context menu.
    if (el.rootIds.length === 0) {
      item.command = {
        command: COMMANDS.newSessionInBranch,
        title: 'New Session Here',
        arguments: [el],
      };
    }
    return item;
  }

  private providerOf(sessionId: string): ProviderId {
    const id = this.safe<ProviderId>(
      'providerFor',
      () => this.deps.providerFor(sessionId),
      DEFAULT_PROVIDER,
    );
    return PROVIDERS[id] ? id : DEFAULT_PROVIDER;
  }

  /** Absolute path of a provider svg inside the install, or '' if unavailable. */
  private providerIconPath(file: string | undefined): string {
    if (file === undefined || file === '') return '';
    return (
      this.safe<string | undefined>(
        'mediaPath',
        () => this.deps.mediaPath(`${PROVIDER_MEDIA_DIR}/${file}`),
        undefined,
      ) ?? ''
    );
  }

  /**
   * The provider's official brand mark from the extension install, or its
   * codicon fallback.
   *
   * A file `iconPath` is NOT recoloured by the workbench, so a COLOURED mark
   * ships as one file carrying its own brand colour, drawn to read on both light
   * and dark. A MONOCHROME mark cannot do that from one file, so it ships as a
   * `{light, dark}` pair — which is the same treatment its own brand guide
   * prescribes, not a workaround.
   *
   * The codicon path exists because `mediaPath` returns undefined under the unit
   * test mock and would do the same if a packaging slip dropped media/ — an
   * icon-less row is not an acceptable outcome either way.
   */
  private providerIcon(
    provider: ProviderId,
  ): vscode.ThemeIcon | vscode.Uri | { light: vscode.Uri; dark: vscode.Uri } {
    const info = PROVIDERS[provider] ?? PROVIDERS[DEFAULT_PROVIDER];
    const lightPath = this.providerIconPath(info.iconFile);
    const darkPath = this.providerIconPath(info.iconFileDark);
    if (lightPath !== '') {
      try {
        const light = vscode.Uri.file(lightPath);
        // Only pair them when BOTH resolved: one half of a light/dark pair is
        // worse than the single file, because the missing side renders nothing.
        return darkPath !== ''
          ? { light, dark: vscode.Uri.file(darkPath) }
          : light;
      } catch (err) {
        logError('tree.providerIcon', err);
      }
    }
    return new vscode.ThemeIcon(
      info.fallbackIcon,
      new vscode.ThemeColor(BRAND_COLOR_ID),
    );
  }

  private groupItem(el: GroupNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      el.label,
      this.isCollapsed(el)
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.Expanded,
    );
    item.id = `group:${el.key}`;
    item.description = el.cwd;
    // Same root-marker glyph as projectItem(), above — both are root-level
    // containers and should read as the same kind of thing, not as "one is a
    // real project and the other is a plain folder".
    item.iconPath = new vscode.ThemeIcon('root-folder');
    item.contextValue = contextValueOf(['group']);
    // No resourceUri: groups are not sessions and must not be decorated.
    // No tooltip: resolveTreeItem() builds it lazily on hover.
    return item;
  }

  private sessionItem(el: SessionRef, forest: SessionForest): vscode.TreeItem {
    const node = forest.nodes.get(el.id);
    if (!node) {
      // The forest moved under us. Render something inert rather than throw.
      const stub = new vscode.TreeItem(
        shortId(el.id),
        vscode.TreeItemCollapsibleState.None,
      );
      stub.id = el.id;
      stub.contextValue = contextValueOf(['session']);
      stub.resourceUri = sessionUri(el.id);
      return stub;
    }

    const hasChildren = node.visibleChildren.length > 0;
    const item = new vscode.TreeItem(
      node.label,
      hasChildren
        ? this.isCollapsed(el)
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );

    // The id is the whole point: it is what preserves expand/collapse and
    // selection across refreshes, and it must NOT move when the label does.
    item.id = node.id;

    // "How long since I last SPOKE to this" is the useful number for every row,
    // live or closed — see the same fallback chain, and why it is in that
    // order, in viewmodel.ts's pushSession. Both surfaces must read a row
    // identically, so neither is allowed its own opinion about this.
    const ageBasis = node.lastPromptAt ?? node.lastActiveAt ?? node.startedAt;
    const age = formatAge(Date.now() - (ageBasis ?? Number.NaN));
    const status = statusDescriptor(node);
    const tokens = this.safe('showTokens', () => this.deps.showTokens?.(), false)
      ? formatTokens(node.tokens)
      : '';
    // The age leads: live state is the dot at the right edge now, so what is
    // left here is when the row was last touched plus the words a dot cannot
    // carry. 'hidden' is one of them — FileDecoration colours are gated behind
    // the user's explorer.decorations.colors setting, so with them off a muted
    // row would otherwise be identical to a live one but sorted oddly.
    //
    // The age CANNOT be right-aligned in a native tree: the workbench renders
    // TreeItem.description flush against the label and pins only the
    // decoration badge to the right edge. The inline sidebar draws its own row
    // and does put the age next to the dot.
    //
    // What the native tree has instead of the inline sidebar's dimming is the
    // hollow-ring badge and the grey label the decoration's colour brings with
    // it — which is why 'closed' is a colour here and a word nowhere.
    item.description = [tokens, age, status, node.hidden ? 'hidden' : '']
      .filter((p) => p !== '')
      .join(' · ');

    item.resourceUri = sessionUri(node.id);

    let boundHere = false;
    try {
      boundHere = this.deps.isBoundHere(node.id);
    } catch (err) {
      logError('tree.isBoundHere', err);
    }
    item.contextValue = sessionContextValue(node, boundHere);

    // The leading glyph names WHO is running, not what state it is in: a
    // session row shows its LLM provider's logo. State is not lost — it is in
    // the decoration badge and its colour, in the description's age and the few
    // words a mark cannot carry, and in the nesting, which is what shows a fork
    // is a fork.
    //
    // A closed row therefore keeps its logo at full strength here. The inline
    // sidebar greys the mark with a CSS filter; a file-backed iconPath is never
    // recoloured by the workbench, so there is nothing to reach for, and a
    // second greyed-out codicon in place of the logo would cost the row the one
    // fact the glyph exists to carry.
    //
    // A ghost is the exception: it is an inferred ancestor, not an observed
    // session, so claiming a provider for it would be a made-up fact.
    //
    // A hidden row is the other exception, for the same mechanical reason the
    // closed row cannot be greyed — except that here it is worth spending the
    // glyph, because eye-closed says WHY the row is grey and a dimmed logo
    // would not.
    if (node.hidden) {
      item.iconPath = new vscode.ThemeIcon(
        'eye-closed',
        new vscode.ThemeColor('disabledForeground'),
      );
    } else {
      item.iconPath = node.ghost
        ? new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor(BRAND_COLOR_ID))
        : this.providerIcon(this.providerOf(node.id));
    }

    // Clicking an archived row reopens it (`--resume`), which is safe exactly
    // because nothing else holds its transcript open. Clicking a live row
    // focuses its terminal. Ghosts have nothing to open.
    if (node.archived) {
      item.command = {
        command: COMMANDS.resumeSession,
        title: 'Resume Here',
        arguments: [el],
      };
    } else if (!node.ghost) {
      item.command = {
        command: COMMANDS.focusSession,
        title: 'Focus',
        arguments: [el],
      };
    }

    // Tooltip deliberately unset — see resolveTreeItem().
    return item;
  }

  /** REQUIRED for TreeView.reveal(): the workbench walks parents upward to
   *  materialise the path to an element it has not rendered yet. */
  getParent(el: TreeNode): TreeNode | undefined {
    try {
      const forest = this.forest();
      // A subproject's parent is the project it is filed under, and
      // reveal() walks upward through this — without it, revealing a session in
      // a nested project could not materialise the path to it.
      if (el.type === 'project') {
        const parentId = el.parentProjectId;
        if (typeof parentId !== 'string' || parentId === '') return undefined;
        return this.groupingFor(forest).projects.find(
          (p) => p.projectId === parentId,
        );
      }
      if (el.type === 'branch') {
        return this.groupingFor(forest).projects.find(
          (p) => p.projectId === el.projectId,
        );
      }
      if (el.type !== 'session') return undefined;
      const parentId = this.visibleParents(forest).get(el.id);
      if (parentId) return this.sessionRef(parentId);
      const grouping = this.groupingFor(forest);
      const project = grouping.projects.find(
        (p) => p.rootIds.indexOf(el.id) >= 0,
      );
      if (project) {
        // Under branch grouping the session hangs off a BRANCH row rather than
        // off the project directly, and reveal() has to name the row that
        // actually contains it or the walk stops one level short.
        const branches = project.branches ?? [];
        const grouped =
          branches.length >= BRANCH_CHIPS_MIN &&
          project.branchesCollapsed !== true &&
          this.safe(
            'groupSessionsByBranch',
            () => this.deps.groupSessionsByBranch?.(),
            false,
          ) === true;
        const branch = grouped
          ? branches.find(
              (b) => b.shown !== false && b.rootIds.indexOf(el.id) >= 0,
            )
          : undefined;
        return branch
          ? this.branchRef(
              project.projectId,
              branch,
              (branches.find((b) => b.primary) ?? branches[0])?.dir ?? '',
            )
          : project;
      }
      return grouping.folders.find((g) => g.rootIds.indexOf(el.id) >= 0);
    } catch (err) {
      logError('tree.getParent', err);
      return undefined;
    }
  }

  /** Lazy MarkdownString tooltip: called once per item on hover.
   *  MUST NOT fire onDidChangeTreeData (that would loop the hover). */
  resolveTreeItem(item: vscode.TreeItem, el: TreeNode): vscode.TreeItem {
    try {
      const md = new vscode.MarkdownString();
      md.isTrusted = true;
      if (el.type === 'group') this.appendGroupTooltip(md, el);
      else if (el.type === 'project') this.appendProjectTooltip(md, el);
      else if (el.type === 'branch') this.appendBranchTooltip(md, el);
      else this.appendSessionTooltip(md, el);
      item.tooltip = md;
    } catch (err) {
      logError('tree.resolveTreeItem', err);
    }
    return item;
  }

  private appendGroupTooltip(md: vscode.MarkdownString, el: GroupNode): void {
    md.appendMarkdown(`**${mdEscape(el.label)}**\n\n`);
    if (el.cwd !== '') md.appendMarkdown(`${mdCode(el.cwd)}\n\n`);
    md.appendMarkdown(
      `${el.rootIds.length} root session${el.rootIds.length === 1 ? '' : 's'}`,
    );
  }

  private appendProjectTooltip(
    md: vscode.MarkdownString,
    el: ProjectGroupNode,
  ): void {
    const info = PROVIDERS[el.provider] ?? PROVIDERS[DEFAULT_PROVIDER];
    md.appendMarkdown(`**${mdEscape(el.label)}**\n\n`);
    md.appendMarkdown(`${mdEscape(info.label)} project\n\n`);
    for (const [i, dir] of el.dirs.entries()) {
      md.appendMarkdown(`- ${i === 0 ? '**main** ' : ''}${mdCode(dir)}\n`);
    }
    const count = el.rootIds.length;
    md.appendMarkdown(
      `\n${count} root session${count === 1 ? '' : 's'} here\n`,
    );
  }

  private appendBranchTooltip(
    md: vscode.MarkdownString,
    el: BranchTreeNode,
  ): void {
    md.appendMarkdown(`**${mdEscape(el.branch)}**${el.primary ? ' — main worktree' : ''}\n\n`);
    md.appendMarkdown(`${mdCode(el.dir)}\n\n`);
    // The same lines branchItem put on the plain-string tooltip, because this
    // MarkdownString REPLACES it the moment the hover resolves — a fact only
    // stated in the plain one would appear for a frame and then vanish.
    const status = this.safe<BranchStatus | undefined>(
      'branchStatusOf',
      () => this.deps.branchStatusOf?.(el.dir),
      undefined,
    );
    const pr = this.safe<PullRequest | undefined>(
      'pullRequestFor',
      () => this.deps.pullRequestFor?.(el.repoDir, el.branch),
      undefined,
    );
    for (const line of [...branchStatusLines(status), ...pullRequestLines(pr)]) {
      md.appendMarkdown(`${mdEscape(line)}\n\n`);
    }
    // The url as a LINK, which is the one thing this hover can offer that the
    // inline sidebar's plain-text tooltip cannot. `isTrusted` is on for this
    // MarkdownString, so it is escaped like every other interpolation here.
    if (pr && pr.url !== '') {
      md.appendMarkdown(`[pull request #${pr.number}](${mdEscape(pr.url)})\n\n`);
    }
    const count = el.rootIds.length;
    md.appendMarkdown(
      count === 0
        ? 'no sessions yet — click to start one here'
        : `${count} session${count === 1 ? '' : 's'} here`,
    );
  }

  private appendSessionTooltip(
    md: vscode.MarkdownString,
    el: SessionRef,
  ): void {
    const forest = this.forest();
    const node = forest.nodes.get(el.id);
    if (!node) {
      md.appendMarkdown(`\`${el.id}\`\n\nSession is no longer in the roster.`);
      return;
    }

    md.appendMarkdown(`**${mdEscape(node.label)}**\n\n`);
    // node.id passed isSessionId, so it is uuid-shaped and safe verbatim.
    md.appendMarkdown(`\`${node.id}\`\n\n`);

    const lines: string[] = [];
    lines.push(`kind: ${node.kind}${node.ghost ? ' (ghost)' : ''}`);
    if (node.cwd) lines.push(`cwd: ${mdCode(node.cwd)}`);
    if (typeof node.startedAt === 'number' && Number.isFinite(node.startedAt)) {
      let iso = '';
      try {
        iso = new Date(node.startedAt).toISOString();
      } catch {
        iso = '';
      }
      if (iso !== '') lines.push(`started: ${iso}`);
    }
    // Both stamps, in the order the age falls back through them, so a row
    // whose age looks wrong shows WHICH source it came from.
    for (const [what, at] of [
      ['last prompt', node.lastPromptAt],
      ['last active', node.lastActiveAt],
    ] as const) {
      if (typeof at !== 'number' || !Number.isFinite(at)) continue;
      let iso = '';
      try {
        iso = new Date(at).toISOString();
      } catch {
        iso = '';
      }
      if (iso !== '') lines.push(`${what}: ${iso}`);
    }
    // Always in the hover, whatever `lineage.showTokens` says — the setting is
    // about the ROW's width, and a hover costs none.
    if (typeof node.tokens === 'number' && Number.isFinite(node.tokens)) {
      lines.push(`context: ${node.tokens.toLocaleString('en-US')} tokens`);
    }
    const waitingFor = node.roster?.waitingFor;
    lines.push(
      `status: ${node.status}${
        node.attention === 'waiting' && waitingFor
          ? ` — ${mdEscape(waitingFor)}`
          : ''
      }`,
    );
    if (node.hidden) {
      lines.push('hidden: sorted last, not counted in the badge');
    }

    const chain = this.parentChain(forest, node);
    if (chain.length > 0) {
      lines.push(
        `parent: ${chain.map((l) => mdEscape(l)).join(' ← ')} (${node.source})`,
      );
    } else {
      lines.push('parent: none (root)');
    }

    // The close-with-summary text. Without this the only place it exists is
    // state.json — and the input box that collects it promises it is "recorded
    // on the node", so the node is where it has to be readable.
    if (node.summary) lines.push(`summary: ${mdEscape(node.summary)}`);

    for (const line of lines) md.appendMarkdown(`- ${line}\n`);
  }

  /** Labels of up to 5 ancestors, nearest first. Visited-set guarded: the
   *  forest cuts cycles, but a tooltip must never hang the ext host. */
  private parentChain(forest: SessionForest, node: SessionNode): string[] {
    const labels: string[] = [];
    const seen = new Set<string>([node.id]);
    let cursor = node.parentId;
    while (cursor && labels.length < 5 && !seen.has(cursor)) {
      seen.add(cursor);
      const parent = forest.nodes.get(cursor);
      if (!parent) {
        labels.push(shortId(cursor));
        break;
      }
      labels.push(parent.label);
      cursor = parent.parentId;
    }
    return labels;
  }

  // ------------------------------------------------------------------ dnd

  handleDrag(source: readonly TreeNode[], dt: vscode.DataTransfer): void {
    try {
      const ids: string[] = [];
      for (const el of source) {
        if (el.type === 'session') ids.push(el.id);
        // A project row drags too, to be filed under another one. It rides
        // the SAME payload under a `project:` prefix rather than a second mime
        // type: the array has always been read through a uuid-shaped filter
        // (parseDraggedIds), so a prefixed entry is invisible to every existing
        // reader — including an older window's, if two versions ever share a
        // drag.
        else if (el.type === 'project') ids.push(`project:${el.projectId}`);
      }
      if (ids.length === 0) return; // folder groups and branches are not draggable
      dt.set(TREE_DND_MIME, new vscode.DataTransferItem(JSON.stringify(ids)));
      dt.set('text/plain', new vscode.DataTransferItem(ids[0]));
    } catch (err) {
      logError('tree.handleDrag', err);
    }
  }

  async handleDrop(
    target: TreeNode | undefined,
    dt: vscode.DataTransfer,
  ): Promise<void> {
    try {
      const transferred = dt.get(TREE_DND_MIME);
      if (!transferred) return;

      const raw = await transferred.asString();

      // A PROJECT drag first, and never mixed with the session path: onto
      // a project row it becomes that project's subproject, onto a folder row
      // or empty space it goes back to the top level, onto a session row
      // nothing happens (a project cannot be filed under a conversation).
      const draggedProjects = parseDraggedProjectIds(raw);
      if (draggedProjects.length > 0) {
        const onto =
          target === undefined || target.type === 'group'
            ? null
            : target.type === 'project'
              ? target.projectId
              : undefined;
        if (onto === undefined) return;
        for (const id of draggedProjects) {
          if (id === onto) continue;
          await this.deps.reparentProject?.(id, onto);
        }
        return;
      }

      const ids = parseDraggedIds(raw);
      if (ids.length === 0) return;

      const forest = this.forest();

      // Dropping on a PROJECT is a different verb entirely: it does not touch
      // lineage, it teaches the project about the directory the session runs
      // in. That is the whole gesture for "this work belongs to that project".
      if (target && target.type === 'project') {
        // Only a visible ROOT can move: a project row renders roots only, so
        // dragging a nested fork onto it would silently do nothing on screen
        // while still appending its cwd to the project's directory list.
        const roots = new Set(forest.visibleRoots);
        const movable = ids.filter((id) => roots.has(id));
        if (movable.length === 0) {
          notify(
            'Flock: only a top-level session can be moved to a project — ' +
              'a fork follows the session it branched from.',
          );
          return;
        }
        for (const id of movable) {
          await this.deps.assignToProject(id, target.projectId);
        }
        return;
      }

      // Dropping on a folder group (or on empty space) detaches to a root.
      const newParentId =
        target && target.type === 'session' ? target.id : null;

      for (const id of ids) {
        if (id === newParentId) {
          log('tree.handleDrop: refused self-parent', id);
          continue;
        }
        if (newParentId !== null && isDescendantOf(forest, newParentId, id)) {
          log('tree.handleDrop: refused cycle', id, '->', newParentId);
          continue;
        }
        await this.deps.reparent(id, newParentId);
      }
    } catch (err) {
      logError('tree.handleDrop', err);
    }
  }

  // -------------------------------------------------------------- refresh

  /** fire(undefined) — NEVER fire([]): an empty array is an explicit no-op in
   *  the ext host. Full refreshes are safe at ~1 Hz: the host debounces at
   *  200 ms with a leading edge and re-fetches only visible subtrees. */
  refresh(): void {
    try {
      const forest = this.forest();
      this.pruneShadowState(forest);
      this.emitter.fire(undefined);
    } catch (err) {
      logError('tree.refresh', err);
    }
  }

  private pruneShadowState(forest: SessionForest): void {
    if (this.collapsedKeys.size === 0) return;
    for (const key of Array.from(this.collapsedKeys)) {
      if (
        key.startsWith('group:') ||
        key.startsWith('project:') ||
        key.startsWith('branch:')
      ) {
        continue;
      }
      if (!forest.nodes.has(key)) this.collapsedKeys.delete(key);
    }
  }

  dispose(): void {
    this.emitter.dispose();
    this.refs.clear();
    this.collapsedKeys.clear();
  }
}

// ------------------------------------------------------------- dnd helpers

function parseDraggedIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => isSessionId(v));
  } catch {
    // A foreign payload under our own mime type: ignore, never throw.
    return [];
  }
}

/** The `project:<id>` entries of a drag payload. Its own reader rather than a
 *  widened parseDraggedIds, so a session verb can never be handed a project id
 *  by a payload that happened to contain one. */
function parseDraggedProjectIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const value of parsed) {
      if (typeof value !== 'string' || !value.startsWith('project:')) continue;
      const id = value.slice('project:'.length);
      if (id !== '') out.push(id);
    }
    return out;
  } catch {
    return [];
  }
}

/** True when `candidateId` sits anywhere below `ancestorId` in the forest —
 *  i.e. reparenting `ancestorId` under it would close a cycle. */
function isDescendantOf(
  forest: SessionForest,
  candidateId: string,
  ancestorId: string,
): boolean {
  const seen = new Set<string>();
  let cursor: string | null = candidateId;
  while (cursor && !seen.has(cursor)) {
    if (cursor === ancestorId) return true;
    seen.add(cursor);
    const node: SessionNode | undefined = forest.nodes.get(cursor);
    cursor = node ? node.parentId : null;
  }
  return false;
}

// ----------------------------------------------------------- registration

export interface TreeController extends DisposableLike {
  refresh(): void;
  revealSession(sessionId: string): Promise<void>;
  /** The worktrees this view accounts for under one project — what a worktree
   *  verb re-resolves its target against when the native tree is the one on
   *  screen. See LineageTreeProvider.branchesOf. */
  branchesOf(projectId: string): readonly BranchInfo[];
  /** Is this view on screen? Asked by the pull-request cache, which must not talk
   *  to GitHub for a tree nobody is looking at — the webview half already answers
   *  the same question (WebtreeController.visible) and the two are ORed, because
   *  either view being visible is a reason to have the answer. */
  readonly visible: boolean;
}

/** createTreeView(VIEW_ID, {...}) + attention-badge wiring + expansion
 *  shadowing. The activity-bar container and the view itself are declared in
 *  package.json (contributes.viewsContainers / contributes.views). */
export function registerTree(deps: TreeDeps): TreeController {
  const provider = new LineageTreeProvider(deps);

  const view = vscode.window.createTreeView<TreeNode>(VIEW_ID, {
    treeDataProvider: provider,
    dragAndDropController: provider,
    showCollapseAll: true,
    // Shift- and ctrl-click select several rows, and the workbench then
    // hands every row menu command its whole selection as a second argument —
    // which is the entire native half of multi-delete. The webview has to build
    // the same thing by hand (see media/webtree.js).
    canSelectMany: true,
  });

  const disposables: vscode.Disposable[] = [view];
  disposables.push(
    view.onDidExpandElement((e) => provider.noteExpanded(e.element)),
    view.onDidCollapseElement((e) => provider.noteCollapsed(e.element)),
    // Report the selection up, exactly as the webview does, so both views feed
    // one answer and the plural menu entry is gated on one context key. The
    // second argument the workbench passes covers the menu case on its own, but
    // not a keybinding or the palette — those arrive with no argument at all.
    view.onDidChangeSelection((e) => {
      try {
        const ids: string[] = [];
        for (const element of e.selection ?? []) {
          if (element && (element as SessionRef).type === 'session') {
            ids.push((element as SessionRef).id);
          }
        }
        deps.noteSelection?.(ids);
      } catch (err) {
        logError('tree.onDidChangeSelection', err);
      }
    }),
  );

  const updateBadge = (): void => {
    try {
      // Counted over the RENDERED tree, not the raw forest — see
      // LineageTreeProvider.attentionCount(). Not counted at all while the
      // badge is off: 0 falls through to `undefined` below, which clears it.
      const count = ATTENTION_BADGE_ENABLED ? provider.attentionCount() : 0;
      view.badge =
        typeof count === 'number' && count > 0
          ? {
              value: count,
              tooltip: `${count} session${count === 1 ? '' : 's'} waiting on you`,
            }
          : undefined;
    } catch (err) {
      logError('tree.updateBadge', err);
    }
  };

  let dataSub: DisposableLike | undefined;
  try {
    dataSub = deps.onDidChangeData(() => {
      provider.refresh();
      updateBadge();
    });
  } catch (err) {
    logError('tree.onDidChangeData', err);
  }

  updateBadge();

  return {
    refresh(): void {
      provider.refresh();
      updateBadge();
    },

    branchesOf(projectId: string): readonly BranchInfo[] {
      return provider.branchesOf(projectId);
    },

    get visible(): boolean {
      return view.visible === true;
    },

    async revealSession(sessionId: string): Promise<void> {
      try {
        // reveal() needs getParent() and rejects when the node is gone —
        // swallow, never surface a modal for a stale reveal.
        await view.reveal(provider.sessionRef(sessionId), {
          select: true,
          focus: false,
          expand: REVEAL_EXPAND_LEVELS,
        });
      } catch (err) {
        logError('tree.revealSession', err);
      }
    },

    dispose(): void {
      try {
        dataSub?.dispose();
      } catch (err) {
        logError('tree.dispose.sub', err);
      }
      for (const d of disposables) {
        try {
          d.dispose();
        } catch (err) {
          logError('tree.dispose', err);
        }
      }
      provider.dispose();
    },
  };
}
