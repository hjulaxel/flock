// IMPLEMENTED BY: C
// TreeDataProvider + TreeView + drag-and-drop reparenting — SPEC.md §4-C2.
//
// Imports allowed here: vscode, ./types, ./log, ./decorations (same owner).
// Must NOT: fire onDidChangeTreeData with [] (fire undefined), mutate the
// forest, execute any command, or import terminals/state/lineage.

import * as vscode from 'vscode';
import {
  BRAND_COLOR_ID,
  COMMANDS,
  TREE_DND_MIME,
  VIEW_ID,
  contextValueOf,
  isSessionId,
  shortId,
} from './types';
import type {
  ContextToken,
  DisposableLike,
  GroupNode,
  SessionForest,
  SessionNode,
  SessionRef,
  TreeDeps,
  TreeNode,
} from './types';
import { log, logError } from './log';
import { sessionUri } from './decorations';

const UNKNOWN_GROUP_KEY = '(unknown)';
/** TreeView.reveal expands at most 3 levels — the API's hard cap. */
const REVEAL_EXPAND_LEVELS = 3;
/** Upper bound on the interned-element / shadow-expansion caches. */
const CACHE_SOFT_LIMIT = 2000;

const EMPTY_FOREST: SessionForest = {
  nodes: new Map(),
  roots: [],
  visibleRoots: [],
  edges: [],
  attentionCount: 0,
  generatedAt: 0,
};

// ------------------------------------------------------------ pure helpers

/** < 90s → 'now'; < 1h → '<m>m'; < 24h → '<h>h'; else '<d>d'.
 *  Negative / NaN / non-finite → '' (an unknown age renders as nothing). */
export function formatAge(deltaMs: number): string {
  if (typeof deltaMs !== 'number' || !Number.isFinite(deltaMs) || deltaMs < 0) {
    return '';
  }
  if (deltaMs < 90_000) return 'now';
  if (deltaMs < 3_600_000) return `${Math.floor(deltaMs / 60_000)}m`;
  if (deltaMs < 86_400_000) return `${Math.floor(deltaMs / 3_600_000)}h`;
  return `${Math.floor(deltaMs / 86_400_000)}d`;
}

/** waiting → '● <waitingFor>'; busy → '▶ busy'; idle → '○ idle';
 *  exited → '✕ gone'; unknown → ''.
 *  This is the reason the tree does not depend on FileDecorations: the user
 *  can switch `explorer.decorations.badges` off and attention is still here. */
export function statusDescriptor(node: SessionNode): string {
  switch (node.status) {
    case 'waiting': {
      const what = node.roster?.waitingFor;
      return `● ${what && what.trim() !== '' ? what : 'waiting'}`;
    }
    case 'busy':
      return '▶ busy';
    case 'idle':
      return '○ idle';
    case 'exited':
      // Archived and ghost are both 'exited' but mean different things to the
      // user: an archived session has a transcript and can be reopened, a
      // ghost is an inferred ancestor that may have nothing behind it.
      return node.archived ? '⏻ closed' : '✕ gone';
    default:
      return '';
  }
}

/** contextValueOf([...]) with the §4-C2 token order. The package.json `when`
 *  clauses match these with viewItem =~ /;token;/, which is why every value is
 *  delimited on both sides. */
export function sessionContextValue(
  node: SessionNode,
  boundHere: boolean,
): string {
  const tokens: ContextToken[] = ['session'];
  const live = !node.ghost && !node.archived && node.status !== 'exited';

  if (node.ghost) tokens.push('ghost');
  else if (node.archived) tokens.push('archived');
  else if (live) tokens.push('live');

  if (node.ghost || node.archived || node.status === 'exited') {
    tokens.push('exited');
  }

  if (live) {
    if (node.status === 'waiting') tokens.push('waiting');
    else if (node.status === 'busy') tokens.push('busy');
    else if (node.status === 'idle') tokens.push('idle');
  }

  if (node.source === 'minted') tokens.push('ours');
  if (boundHere) tokens.push('bound');
  tokens.push(node.parentId ? 'forked' : 'root');

  return contextValueOf(tokens);
}

/** Path basename without importing node:path (works for / and \ alike). */
function baseName(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  if (trimmed === '') return p;
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (i < 0) return trimmed;
  const tail = trimmed.slice(i + 1);
  return tail === '' ? trimmed : tail;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Escape the markdown that matters inside a trusted MarkdownString. Labels
 *  come from roster names and user renames — never trust them verbatim. */
function mdEscape(s: string): string {
  return s.replace(/[\\`*_[\]<>#|]/g, (m) => `\\${m}`);
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** GroupNodes for the visible roots, or null when grouping does not apply
 *  (fewer than two distinct folders — a single group is just noise).
 *  `prev` lets us hand back the identical object when nothing changed, so the
 *  workbench keeps its expansion state for the row. */
function computeGroups(
  forest: SessionForest,
  prev: GroupNode[] | null,
): GroupNode[] | null {
  const byKey = new Map<string, GroupNode>();
  for (const rootId of forest.visibleRoots) {
    const node = forest.nodes.get(rootId);
    if (!node) continue;
    const cwd =
      typeof node.cwd === 'string' && node.cwd.trim() !== '' ? node.cwd : '';
    const key = cwd === '' ? UNKNOWN_GROUP_KEY : cwd;
    let group = byKey.get(key);
    if (!group) {
      group = {
        type: 'group',
        key,
        cwd,
        label: cwd === '' ? UNKNOWN_GROUP_KEY : baseName(cwd),
        rootIds: [],
      };
      byKey.set(key, group);
    }
    group.rootIds.push(rootId);
  }
  if (byKey.size < 2) return null;

  const groups = Array.from(byKey.values()).sort(
    (a, b) => cmp(a.label, b.label) || cmp(a.key, b.key),
  );
  if (!prev) return groups;

  const prevByKey = new Map(prev.map((g) => [g.key, g] as const));
  return groups.map((g) => {
    const old = prevByKey.get(g.key);
    if (
      old &&
      old.label === g.label &&
      old.cwd === g.cwd &&
      sameIds(old.rootIds, g.rootIds)
    ) {
      return old;
    }
    return g;
  });
}

function nodeKey(el: TreeNode): string {
  return el.type === 'group' ? `group:${el.key}` : el.id;
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

  /** There is no API to READ expansion state and no collapse API, so shadow
   *  it from the TreeView's expand/collapse events. Only explicit user
   *  collapses are recorded; the default stays Expanded. */
  private readonly collapsedKeys = new Set<string>();

  private lastForest: SessionForest = EMPTY_FOREST;

  private groupCacheForest: SessionForest | null = null;
  private groupCacheGrouping = false;
  private groupCache: GroupNode[] | null = null;

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

  private groupsFor(forest: SessionForest): GroupNode[] | null {
    let grouping = false;
    try {
      grouping = this.deps.groupByFolder();
    } catch (err) {
      logError('tree.groupByFolder', err);
    }
    if (
      this.groupCacheForest === forest &&
      this.groupCacheGrouping === grouping
    ) {
      return this.groupCache;
    }
    this.groupCacheForest = forest;
    this.groupCacheGrouping = grouping;
    this.groupCache = grouping ? computeGroups(forest, this.groupCache) : null;
    return this.groupCache;
  }

  /** child id → id of the node it hangs under IN THE VISIBLE TREE (which is
   *  not necessarily node.parentId: hidden and pruned-ghost ancestors are
   *  spliced out and their children promoted). null = visible root. */
  private visibleParents(forest: SessionForest): Map<string, string | null> {
    if (this.parentIndexForest === forest) return this.parentIndex;
    const map = new Map<string, string | null>();
    for (const rootId of forest.visibleRoots) map.set(rootId, null);
    for (const node of forest.nodes.values()) {
      for (const childId of node.visibleChildren) map.set(childId, node.id);
    }
    this.parentIndexForest = forest;
    this.parentIndex = map;
    return map;
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
        const groups = this.groupsFor(forest);
        if (groups) return groups.slice();
        // Empty root list (NOT a placeholder node) is what makes the
        // contributes.viewsWelcome empty state render.
        return forest.visibleRoots.map((id) => this.sessionRef(id));
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

  getTreeItem(el: TreeNode): vscode.TreeItem {
    try {
      return el.type === 'group'
        ? this.groupItem(el)
        : this.sessionItem(el, this.forest());
    } catch (err) {
      logError('tree.getTreeItem', err);
      const fallback = new vscode.TreeItem(
        el.type === 'group' ? el.label : shortId(el.id),
        vscode.TreeItemCollapsibleState.None,
      );
      fallback.id = nodeKey(el);
      return fallback;
    }
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
    item.iconPath = new vscode.ThemeIcon('folder');
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

    // For a closed session "how long since I last touched it" is the useful
    // number, so archived rows age off endedAt rather than startedAt.
    const ageBasis = node.archived
      ? (node.endedAt ?? node.startedAt)
      : node.startedAt;
    const age = formatAge(Date.now() - (ageBasis ?? Number.NaN));
    const status = statusDescriptor(node);
    item.description = [age, status].filter((p) => p !== '').join(' · ');

    item.resourceUri = sessionUri(node.id);

    let boundHere = false;
    try {
      boundHere = this.deps.isBoundHere(node.id);
    } catch (err) {
      logError('tree.isBoundHere', err);
    }
    item.contextValue = sessionContextValue(node, boundHere);

    // A raw hex inside ThemeColor is silently ignored by the renderer — the
    // id MUST be the contributes.colors entry.
    item.iconPath = new vscode.ThemeIcon(
      node.ghost
        ? 'circle-slash'
        : node.archived
          ? 'history'
          : node.parentId
            ? 'git-branch'
            : 'terminal',
      new vscode.ThemeColor(BRAND_COLOR_ID),
    );

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
      if (el.type === 'group') return undefined;
      const forest = this.forest();
      const parentId = this.visibleParents(forest).get(el.id);
      if (parentId) return this.sessionRef(parentId);
      const groups = this.groupsFor(forest);
      if (!groups) return undefined;
      return groups.find((g) => g.rootIds.indexOf(el.id) >= 0);
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
      if (el.type === 'group') {
        this.appendGroupTooltip(md, el);
      } else {
        this.appendSessionTooltip(md, el);
      }
      item.tooltip = md;
    } catch (err) {
      logError('tree.resolveTreeItem', err);
    }
    return item;
  }

  private appendGroupTooltip(md: vscode.MarkdownString, el: GroupNode): void {
    md.appendMarkdown(`**${mdEscape(el.label)}**\n\n`);
    if (el.cwd !== '') md.appendMarkdown(`\`${el.cwd}\`\n\n`);
    md.appendMarkdown(
      `${el.rootIds.length} root session${el.rootIds.length === 1 ? '' : 's'}`,
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
    md.appendMarkdown(`\`${node.id}\`\n\n`);

    const lines: string[] = [];
    lines.push(`kind: ${node.kind}${node.ghost ? ' (ghost)' : ''}`);
    if (node.cwd) lines.push(`cwd: \`${node.cwd}\``);
    if (typeof node.startedAt === 'number' && Number.isFinite(node.startedAt)) {
      let iso = '';
      try {
        iso = new Date(node.startedAt).toISOString();
      } catch {
        iso = '';
      }
      if (iso !== '') lines.push(`started: ${iso}`);
    }
    const waitingFor = node.roster?.waitingFor;
    lines.push(
      `status: ${node.status}${
        node.attention === 'waiting' && waitingFor
          ? ` — ${mdEscape(waitingFor)}`
          : ''
      }`,
    );

    const chain = this.parentChain(forest, node);
    if (chain.length > 0) {
      lines.push(
        `parent: ${chain.map((l) => mdEscape(l)).join(' ← ')} (${node.source})`,
      );
    } else {
      lines.push('parent: none (root)');
    }

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
      }
      if (ids.length === 0) return; // groups are not draggable
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
      const ids = parseDraggedIds(raw);
      if (ids.length === 0) return;

      // Dropping on a group (or on empty space) detaches to a root.
      const newParentId =
        target && target.type === 'session' ? target.id : null;

      const forest = this.forest();
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
      if (key.startsWith('group:')) continue;
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
    canSelectMany: false,
  });

  const disposables: vscode.Disposable[] = [view];
  disposables.push(
    view.onDidExpandElement((e) => provider.noteExpanded(e.element)),
    view.onDidCollapseElement((e) => provider.noteCollapsed(e.element)),
  );

  const updateBadge = (): void => {
    try {
      const count = deps.getForest().attentionCount;
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
