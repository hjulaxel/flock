// src/tree.ts — TreeDataProvider + TreeView + drag-and-drop (a session onto a
// project, which is the only thing a drag says; see handleDrop).
//
// A view layer and nothing more: it must not fire onDidChangeTreeData with []
// (fire undefined), mutate the forest, execute any command, or import
// terminals/state/lineage.

import * as vscode from 'vscode';
import {
  BRAND_COLOR_ID,
  COMMANDS,
  DEFAULT_PROVIDER,
  PROVIDERS,
  PROVIDER_MEDIA_DIR,
  RUNNING_BADGE_ENABLED,
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
  SubprojectRecord,
  PullRequest,
  SessionForest,
  SessionNode,
  SessionRef,
  SubprojectNode,
  TreeDeps,
  TreeNode,
} from './types';
import { log, logError } from './log';
import { sessionIsOver } from './lineage';
import { projectUri, sessionUri } from './decorations';
import {
  HIDDEN_RUNNING_GROUP_KEY,
  branchIndexForCwd,
  computeGrouping,
  projectBranchList,
  unbranchedRoots,
} from './projects';
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
  outOfScopeCount: 0,
  hiddenRunning: null,
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
  branchIsDirty,
  branchStateIcon,
  branchStatusLines,
  branchTokens,
  exchangeSnippet,
  formatAge,
  formatBranchSync,
  formatPullRequestChip,
  formatTokens,
  graceTooltipLine,
  projectContextValue,
  pullRequestLines,
  runningCountOf,
  runningWithoutRow,
  sessionContextValue,
  sessionSnippet,
  statusDescriptor,
  statusTone,
  subprojectRowKey,
  subtreeHasRunning,
} from './viewmodel';

export {
  formatAge,
  formatTokens,
  projectContextValue,
  sessionContextValue,
  statusDescriptor,
} from './viewmodel';

import { hostMarker, hostTooltipLine } from './hosts';
import type { SessionHost } from './hosts';
import type { SessionCli } from './accounts';

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
  if (el.type === 'subproject') {
    return subprojectRowKey(el.projectId, el.id);
  }
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
  branchRows: boolean,
  /** The NAMED subprojects. In the signature for the same reason `parentId` is:
   *  adding, renaming or re-pointing a lane changes nothing else about the
   *  project, so without it the cached grouping would keep drawing the old rows
   *  until some unrelated roster tick happened to change the forest. */
  lanes: readonly SubprojectRecord[] = [],
  /** Folder mode's scope (GroupingInput.scopeDirs), pre-joined by the caller.
   *  In the signature because flipping `lineage.mode` changes it without
   *  changing the forest, and the cached grouping would otherwise keep the
   *  other mode's rows until an unrelated roster tick. */
  scopeDirs = '',
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
  const l = lanes
    .map(
      (x) =>
        `${x.id}\u0000${x.projectId}\u0000${x.name}\u0000${x.dir}`,
    )
    .join('\u0002');
  return `${groupByFolder ? '1' : '0'}${onlyProjectSessions ? '1' : '0'}${branchRows ? '1' : '0'}|${p}|${hiddenFolders.join('\u0002')}|${l}|${scopeDirs}`;
}

/**
 * The two answers to "which branch is this session on" that a native row needs,
 * built together in one walk — see sessionBranchNamesFor for why they are two.
 */
interface SessionBranchNames {
  /** The rows that say it in their DESCRIPTION: the inline surface's rules. */
  spoken: Map<string, string>;
  /** Every row a branch scope claims, for the HOVER, which has room for it. */
  all: Map<string, string>;
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

  /** And for subproject rows, keyed `<projectId>` + the row's own id — NOT its
   *  directory, because two named lanes may share one. See subprojectRef(). */
  private readonly subprojectRefs = new Map<string, SubprojectNode>();

  /** There is no API to READ expansion state and no collapse API, so shadow
   *  it from the TreeView's expand/collapse events. Only explicit user
   *  collapses are recorded; the default stays Expanded. */
  private readonly collapsedKeys = new Set<string>();

  private lastForest: SessionForest = EMPTY_FOREST;

  private groupCacheForest: SessionForest | null = null;
  private groupCacheSignature: string | null = null;
  /** Cleared whenever the grouping is rebuilt — see sessionBranchNamesFor. */
  private sessionBranchNames: SessionBranchNames | null = null;
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

  /** Who is running a session (src/hosts.ts), or undefined when the wiring has
   *  no opinion — an older host, or a throwing dep. Undefined is deliberately
   *  NOT 'foreign': every reader treats it as 'hosted', so a tree that cannot
   *  tell renders exactly the row and exactly the menu it always did. */
  private hostOf(sessionId: string): SessionHost | undefined {
    return this.safe<SessionHost | undefined>(
      'hostOf',
      () => this.deps.hostOf?.(sessionId),
      undefined,
    );
  }

  /** Same `safe` discipline as `hostOf` above: a lookup that is not wired, or
   *  that throws, leaves the hover exactly as it was before accounts. */
  private accountLabelOf(sessionId: string): string | undefined {
    const label = this.safe<string | undefined>(
      'accountLabelOf',
      () => this.deps.accountLabelOf?.(sessionId),
      undefined,
    );
    return typeof label === 'string' && label.trim() !== ''
      ? label.trim()
      : undefined;
  }

  /** Same `safe` discipline again, and the same default the inline view's
   *  `safeSessionCli` applies: a lookup that is not wired, or that throws,
   *  answers 'claude'. The two surfaces have to emit the same token string or
   *  the two context menus drift apart — which is the whole lesson of the
   *  commit that discovered "Move to Account…" had been contributed to the
   *  native tree only while the DEFAULT view is the inline one.
   *
   *  Deliberately NOT `providerOf` below, which falls back to the owning
   *  project's provider: right for a glyph, wrong for a verb. */
  private sessionCliOf(sessionId: string): SessionCli {
    const cli = this.safe<SessionCli | undefined>(
      'sessionCli',
      () => this.deps.sessionCli?.(sessionId),
      undefined,
    );
    return cli === 'codex' ? 'codex' : 'claude';
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
    const branchRows =
      this.safe('branchRows', () => this.deps.branchRows?.(), false) === true;
    const lanes = this.safe('subprojects', () => this.deps.subprojects?.(), []);
    const scopeDirs =
      this.safe<readonly string[] | undefined>(
        'scopeDirs',
        () => this.deps.scopeDirs?.(),
        undefined,
      ) ?? [];

    const signature = groupingSignature(
      projects,
      hiddenFolders,
      groupByFolder,
      onlyProjectSessions,
      // In the signature for the reason the comment on `branchRows` below
      // gives: flipping it has to invalidate the cached grouping, or the tree
      // would keep the old branch list until an unrelated roster tick happened
      // to change the forest.
      branchRows,
      lanes,
      scopeDirs.join('\u0002'),
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
        // Folder mode's fence — every real folder this window opened, or []
        // when project mode (or an empty window) scopes nothing. A grouping
        // input rather than a forest one so the counts and both view styles
        // read the same fence.
        scopeDirs,
        // The invariant's escape hatch: lets the grouping route a filtered
        // RUNNING root into the "Running elsewhere" appendix instead of
        // dropping its row. Liveness is a forest fact, so the lookup lives
        // here and the pure grouping just asks.
        hasRunning: (rootId) => subtreeHasRunning(forest, rootId),
        // The other half of the same invariant: a live session with no row AT
        // ALL — an archived record the roster still reports — joins the
        // appendix rather than being counted by the badge and drawn nowhere.
        // Scoped with the same fence the badge uses, so the number and the
        // rows agree. See viewmodel.runningWithoutRow.
        rowlessRunningIds: runningWithoutRow(forest, scopeDirs),
        // The NAMED subprojects, and the stamp that says which one a session was
        // started in. Both are grouping inputs rather than rendering ones: which
        // row a session belongs to must be the same answer in both view styles.
        subprojects: lanes,
        stampOf: (id) => this.safe('stampOf', () => this.deps.stampOf?.(id), undefined),
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
        // `lineage.git.branches`. Part of the grouping SIGNATURE below as well,
        // or flipping the setting would leave the cached grouping — and its
        // branch rows — in place until the next roster tick happened to change
        // the forest.
        branchRows,
      },
      this.groupCache,
    );
    this.groupCacheForest = forest;
    this.groupCacheSignature = signature;
    this.sessionBranchNames = null;
    return this.groupCache;
  }

  /**
   * Which branch each session row is on: `spoken`, the ones that SAY it in
   * their description, and `all`, every row a branch scope accounts for.
   *
   * THE NATIVE TREE'S HALF OF `branchDisplay: inline`. A TreeItem has one
   * label and one description and no second line to put a branch on — the same
   * concession `branchItem` already makes about the branch colours — so what
   * survives here is the name, in the description, left of the age.
   *
   * The rules are the inline surface's rules, deliberately: a row is answered the
   * same way by both renderers or neither is trustworthy. Scoped per PROJECT
   * (the same directory can be a worktree of one project and a plain
   * subdirectory of another), withheld below BRANCH_CHIPS_MIN, and withheld on a
   * fork that stayed in its parent's checkout.
   *
   * WHY TWO MAPS AND NOT ONE. A row's DESCRIPTION and its HOVER answer different
   * questions, and the inline surface has always answered them separately: it
   * suppresses the branch sub-line on a closed row, on a fork that stayed put and
   * under branch grouping, but it sets the `branch: …` hover line for every row a
   * scope claims (viewmodel.pushSession, at `branchAt >= 0`). Until this pass the
   * native tree had one gated map and no branch line in its hover at all, so
   * closing a session took the branch name off the row and there was nowhere left
   * to read it — the description was the native tree's only copy of the fact. The
   * rejected alternative was to look the branch up again in appendSessionTooltip
   * with `branchIndexForCwd`: that function needs the BranchInfo[] of the row's
   * own project-or-directory scope, which only this walk knows, so a second
   * lookup would have had to re-derive the scoping and would drift from it.
   *
   * Built once per grouping and thrown away with it, because both maps are
   * derived from exactly two things — the grouping's branch lists and the
   * forest's cwds — and both of those change together.
   */
  private sessionBranchNamesFor(forest: SessionForest): SessionBranchNames {
    if (this.sessionBranchNames) return this.sessionBranchNames;
    const spoken = new Map<string, string>();
    const all = new Map<string, string>();
    const walk = (
      id: string,
      branches: readonly BranchInfo[],
      parentAt: number,
    ): void => {
      const node = forest.nodes.get(id);
      if (!node) return;
      const at = branchIndexForCwd(branches, node.cwd);
      // A closed row says nothing — one row, no branch. The suppression is here
      // rather than at the call site because this map IS the native tree's half
      // of `branchDisplay: inline`, and its rules are the inline surface's
      // rules deliberately.
      const over = sessionIsOver(node);
      if (at >= 0) {
        // The hover's copy: ungated by the compaction, by the transparency rule
        // and by BRANCH_CHIPS_MIN, exactly like the inline hover's line. A hover
        // costs no row width, which is what every one of those gates is about.
        all.set(id, branches[at].name);
        if (at !== parentAt && !over && branches.length >= BRANCH_CHIPS_MIN) {
          spoken.set(id, branches[at].name);
        }
      }
      // `parentAt` means "the last checkout NAMED on the way here", not "the
      // checkout of the row above". A silent row must therefore pass its
      // parent's index down rather than its own, or it swallows the branch fact
      // for its whole subtree and the first live descendant in the same
      // checkout never names its worktree. Identical to the inline renderer's
      // `spokenBranchAt`; the two walks disagreeing here would be a silent
      // difference between the surfaces, which is why both are pinned by tests.
      const said = over ? parentAt : at;
      for (const kid of node.visibleChildren) walk(kid, branches, said);
    };
    const scope = (
      branches: readonly BranchInfo[],
      rootIds: readonly string[],
    ): void => {
      for (const id of rootIds) walk(id, branches, -1);
    };
    // `lineage.groupSessionsByBranch`, read once for the whole walk. Under it a
    // project's sessions hang off BRANCH ROWS (projectChildren), and the row
    // immediately above a session then already names its checkout in bigger
    // type — so repeating it in the description is the same redundancy the
    // transparency rule removes from a fork that stayed in its parent's
    // checkout, and it is removed the same way: by seeding the walk with the
    // branch row's own index instead of -1.
    //
    // The rejected alternative was the blunt one the inline surface still uses —
    // suppress the branch on EVERY row while grouping is on. That deletes the
    // one place under grouping where the name is load-bearing: a fork living in
    // a different worktree nests under its PARENT, so it hangs off the parent's
    // branch row, and the row above it names the wrong checkout. Seeding says
    // "your branch row already said this" without also saying "no row under
    // grouping may name a branch".
    const grouped =
      this.safe(
        'groupSessionsByBranch',
        () => this.deps.groupSessionsByBranch?.(),
        false,
      ) === true;
    for (const project of this.groupCache.projects) {
      const branches = project.branches ?? [];
      // The same three-part test projectChildren and getParent apply before they
      // will draw a branch row at all: below the threshold, or with the block
      // folded away, the sessions sit directly under the project and nothing
      // above them has said anything.
      const rows =
        grouped &&
        branches.length >= BRANCH_CHIPS_MIN &&
        project.branchesShown !== false;
      if (rows) {
        for (let at = 0; at < branches.length; at++) {
          // A folded-away branch draws no row, so its sessions fall through to
          // `unbranchedRoots` below and speak like any ungrouped row.
          if (branches[at].shown === false) continue;
          for (const id of branches[at].rootIds) walk(id, branches, at);
        }
        scope(branches, unbranchedRoots(project.rootIds, branches));
      } else {
        scope(branches, project.rootIds);
      }
      // A split project's branches live on its directory rows (the preview
      // directory model), and each directory is its own repository — so each one
      // is its own scope, exactly as it is in the inline renderer. Never seeded:
      // this renderer draws no branch rows under a directory row (getChildren
      // lists a subproject's `rootIds` directly), so nothing above those
      // sessions has named their checkout.
      for (const sub of project.subprojects ?? []) {
        scope(sub.branches ?? [], sub.rootIds);
      }
    }
    this.sessionBranchNames = { spoken, all };
    return this.sessionBranchNames;
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
      // Through projectBranchList for the same reason webtree.ts is: under the
      // directory model a split project's checkouts hang off its DIRECTORY rows,
      // and a palette verb reading the project node alone would find none.
      return projectBranchList(
        grouping.projects.find((p) => p.projectId === projectId),
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
        // The "Running elsewhere" appendix renders rows too — a waiting
        // session there shows its dot, so the count must see it.
        ...(grouping.hiddenRunning?.rootIds ?? []),
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

  /** RUNNING sessions this window can SHOW — level 1 plus the grace countdown
   *  — for the container badge. Straight through viewmodel.runningCountOf so
   *  this surface and the inline one can never disagree on the number.
   *
   *  Scoped, not machine-wide: folder mode's fence drops other folders' rows
   *  outright, and a badge counting rows that do not exist is the same defect
   *  as a row for a process that does not — you cannot click through it to
   *  anything. In project mode and empty windows scopeDirs is undefined and
   *  the count is machine-wide exactly as before. */
  runningCount(): number {
    try {
      return runningCountOf(this.forest(), this.deps.scopeDirs?.());
    } catch (err) {
      logError('tree.runningCount', err);
      return 0;
    }
  }

  private isCollapsed(el: TreeNode): boolean {
    return this.collapsedKeys.has(nodeKey(el));
  }

  /** The one row whose expansion DEFAULT is inverted (see groupItem): the
   *  "Running elsewhere" appendix starts collapsed, so its state needs its own
   *  bit — the collapsedKeys shadow only remembers collapses. */
  private hiddenRunningExpanded = false;

  /** Wired by registerTree() from TreeView.onDidExpandElement. */
  noteExpanded(el: TreeNode): void {
    if (el.type === 'group' && el.key === HIDDEN_RUNNING_GROUP_KEY) {
      this.hiddenRunningExpanded = true;
    }
    this.collapsedKeys.delete(nodeKey(el));
  }

  /** Wired by registerTree() from TreeView.onDidCollapseElement. */
  noteCollapsed(el: TreeNode): void {
    if (el.type === 'group' && el.key === HIDDEN_RUNNING_GROUP_KEY) {
      this.hiddenRunningExpanded = false;
    }
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
          // The "Running elsewhere" appendix, LAST: running sessions the
          // fences filtered out keep one row here (see GroupingResult), so
          // the machine-wide badge always has rows to point at.
          ...(grouping.hiddenRunning !== null ? [grouping.hiddenRunning] : []),
        ];
      }

      if (el.type === 'project') {
        return this.projectChildren(forest, el);
      }

      if (el.type === 'branch' || el.type === 'subproject') {
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
   * What hangs under a project row: its subproject DIRECTORIES, or — for a
   * single-directory project — its branches (only under
   * `lineage.groupSessionsByBranch`) and its sessions.
   *
   * STRUCTURE FIRST, then the list: a project's sessions are a list that grows
   * all day and its directories are a structure that does not, so putting the
   * stable thing at the top is what keeps it findable once there are fifteen
   * sessions under it.
   *
   * The directory split is exclusive, exactly as it is in the inline sidebar (see
   * viewmodel.pushProject): every session the project claimed is inside one of
   * these rows, so listing them here as well would draw each one twice. The two
   * views must never disagree about which rows a project contains.
   */
  private projectChildren(
    forest: SessionForest,
    el: ProjectGroupNode,
  ): TreeNode[] {
    const grouping = this.groupingFor(forest);
    const byId = new Map(grouping.projects.map((p) => [p.projectId, p] as const));
    const out: TreeNode[] = [];
    // Legacy record nesting, still drawn while a `parentId` written by an older
    // build survives to the next activation — see ProjectGroupNode.depth.
    for (const childId of el.childProjectIds ?? []) {
      const child = byId.get(childId);
      if (child) out.push(child);
    }

    const subprojects = el.subprojects ?? [];
    if (subprojects.length > 0) {
      for (const node of subprojects) out.push(this.subprojectRef(node));
      return out;
    }

    const branches = el.branches ?? [];
    const grouped =
      branches.length >= BRANCH_CHIPS_MIN &&
      // `!== false`, not `=== true`, and ONLY here. The block is shut until
      // asked for everywhere else, but turning `groupSessionsByBranch` on IS the
      // ask: the sessions hang off the branch rows under it, so defaulting them
      // away would silently undo the setting. Hiding them explicitly still puts
      // every session back under the project. Same rule as the inline sidebar's
      // — the two views must not disagree about which rows a project contains.
      el.branchesShown !== false &&
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

  /** Interned subproject node, for the same reason branchRef interns: the
   *  workbench keys expansion state on element identity, so handing it a fresh
   *  object per refresh would shut every open directory on every roster tick.
   *
   *  The grouping already reuses its own node objects when nothing changed (see
   *  projects.reuseUnchanged), but only per PROJECT — a project gaining a session
   *  in one directory produces fresh nodes for all of them. This narrows that to
   *  the row that actually changed. */
  private subprojectRef(node: SubprojectNode): SubprojectNode {
    const key = `${node.projectId}\u0000${node.id}`;
    const existing = this.subprojectRefs.get(key);
    if (
      existing &&
      existing.dir === node.dir &&
      existing.label === node.label &&
      existing.main === node.main &&
      existing.rootIds.length === node.rootIds.length &&
      existing.rootIds.every((id, i) => id === node.rootIds[i])
    ) {
      return existing;
    }
    const next: SubprojectNode = { ...node, rootIds: node.rootIds.slice() };
    if (this.subprojectRefs.size > CACHE_SOFT_LIMIT) this.subprojectRefs.clear();
    this.subprojectRefs.set(key, next);
    return next;
  }

  /**
   * One DIRECTORY of a project, as a native row.
   *
   * Always expandable, like the project row above it and for the same reason: the
   * directory exists whether or not anything is running in it, and a row that lost
   * its toggle when its last session ended would move everything below it for a
   * reason the user did not cause. Clicking it therefore opens and shuts it — the
   * `+` is in the context menu, where a native row has to keep its verbs.
   */
  private subprojectItem(el: SubprojectNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      el.label,
      this.isCollapsed(el)
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.Expanded,
    );
    item.id = nodeKey(el);
    // The count only. A path here would repeat the label and then be truncated —
    // the hover is where the address belongs. Mirrors the inline row, except that
    // this one cannot tell whether it is open (the workbench owns that), so it
    // shows the number either way.
    item.description = el.rootIds.length > 0 ? String(el.rootIds.length) : undefined;
    // The plain folder glyph, against the project's `root-folder`: the native tree
    // indents 8px per level and draws no band, so the icon is most of what says
    // which rows are the roots of the view.
    item.iconPath = new vscode.ThemeIcon('folder');
    item.contextValue = contextValueOf(
      el.main ? ['subproject', 'primary'] : ['subproject'],
    );
    item.tooltip = [
      el.dir,
      el.rootIds.length === 1 ? '1 session' : `${el.rootIds.length} sessions`,
      el.main ? 'the project’s main directory' : '',
    ]
      .filter((line) => line !== '')
      .join('\n');
    return item;
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
      if (el.type === 'subproject') return this.subprojectItem(el);
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
   * The colour a branch's mark takes, in GitHub's vocabulary — the native tree's
   * half of what .branch-glyph does in the webview.
   *
   * `charts.*` and never a literal, for the reason webtree.css gives at length:
   * those are the palette VS Code publishes for small categorical marks, every
   * theme defines them, and a hex here would be a colour that survives one theme.
   * Closed takes the description grey rather than a red, because closed-unmerged
   * is over and did not land, which is a fact and not a problem.
   *
   * `undefined` for a branch with no request, which leaves the icon the theme's
   * own — exactly what this row drew before any of this existed.
   */
  private static branchStateColor(
    pr: PullRequest | undefined,
  ): vscode.ThemeColor | undefined {
    if (!pr) return undefined;
    switch (pr.state) {
      case 'open':
        return new vscode.ThemeColor('charts.green');
      case 'merged':
        return new vscode.ThemeColor('charts.purple');
      default:
        return new vscode.ThemeColor('descriptionForeground');
    }
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
    // Same order as the inline row draws them in — the star against the name,
    // then where the checkout stands, then the request, then how many sessions
    // are on it — so somebody switching renderers reads the same line in the same
    // place. Joined by a space rather than a separator: a TreeItem description is
    // already dim, small and right-aligned, and ' · ' in it reads as a third
    // field.
    //
    // The `*` leads the description because a description is drawn immediately
    // after the label, which puts it exactly where the webview puts it: against
    // the branch name. This is the whole of how the native tree follows that
    // move — a TreeItem label is its identity and the star does not belong in it.
    const description = [
      branchIsDirty(status) ? '*' : '',
      formatBranchSync(status),
      pr ? formatPullRequestChip(pr) : '',
      String(el.rootIds.length || ''),
    ]
      .filter((part) => part !== '')
      .join(' ');
    item.description = description === '' ? undefined : description;
    // The request's own mark, in the request's own colour — the same pairing the
    // webview draws, made from the same function so the two cannot drift. A
    // branch with no request keeps the git-branch icon this row has always had.
    item.iconPath = new vscode.ThemeIcon(
      branchStateIcon(pr),
      LineageTreeProvider.branchStateColor(pr),
    );
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
    // The "Running elsewhere" appendix inverts the expansion DEFAULT: an
    // ordinary folder group is the user's work and opens expanded, where this
    // group is a ledger of other windows' running processes — present so the
    // invariant holds, collapsed so it never competes with the work. The
    // shadow-expansion cache only records collapses (the expanded default
    // needs no memory), so the inverted default keeps its own expanded set.
    if (el.key === HIDDEN_RUNNING_GROUP_KEY) {
      const item = new vscode.TreeItem(
        el.label,
        this.hiddenRunningExpanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.id = `group:${el.key}`;
      item.description = `${el.rootIds.length}`;
      item.iconPath = new vscode.ThemeIcon('server-process');
      // Its own token, NOT 'group': the folder verbs (hide, open in window)
      // act on a directory this row does not have.
      item.contextValue = contextValueOf(['elsewhere']);
      item.tooltip =
        'Running sessions this window’s filters would otherwise hide — ' +
        'other folders’ work, or closed projects’. Each still costs this ' +
        'machine memory; close or route them from here.';
      return item;
    }
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
    const host = this.hostOf(node.id);
    // 'elsewhere' — see the same marker in viewmodel.pushSession. Both surfaces
    // read a row through one function, so neither is allowed its own opinion
    // about where the word goes or when it appears.
    // The branch, where this renderer can put it: FIRST in the description, so
    // it sits left of the age exactly as the inline surface's second line sits
    // left of everything on it. No state tokens beside it — `↑4 *` next to a
    // name in a field that is already dim, small and elided at the first squeeze
    // would cost the age its place to say something the hover already says in
    // words. See sessionBranchNamesFor for which rows get one.
    //
    // A CLOSED ROW HAS NO BRANCH NAME, whatever `branchDisplay` says. This is
    // the native half of the inline surface's one-row compaction: there the
    // branch is a second LINE and dropping it is what keeps the row one row
    // tall; here it is the widest token in a single-line description, sitting
    // immediately left of the name's own space, and leaving it would make a
    // closed row read as a branch report rather than as a session. Both
    // surfaces have to compact the same rows, so both ask
    // lineage.sessionIsOver — see sessionBranchNamesFor, which applies the same
    // rule (and the same transparency rule) inside the walk.
    const over = sessionIsOver(node);
    const branchName =
      !over &&
      this.safe('branchDisplay', () => this.deps.branchDisplay?.(), 'color') ===
        'inline'
        ? this.sessionBranchNamesFor(forest).spoken.get(node.id)
        : undefined;
    item.description = [
      branchName ?? '',
      tokens,
      age,
      status,
      // The grace countdown and the archived conclusion USED TO BE HERE, in
      // this order, matching the inline surface part for part. Both moved to
      // the hover in the 2026-08-28 review — see viewmodel.pushSession for the
      // argument, and viewmodel.graceTooltipLine for the countdown's. What has
      // not changed is that neither renderer is allowed its own opinion about
      // how a row reads: if one of them puts a fact back, so does the other.
      hostMarker(host ?? 'none') ?? '',
      node.hidden ? 'hidden' : '',
    ]
      .filter((p) => p !== '')
      .join(' · ');

    item.resourceUri = sessionUri(node.id);

    let boundHere = false;
    try {
      boundHere = this.deps.isBoundHere(node.id);
    } catch (err) {
      logError('tree.isBoundHere', err);
    }
    item.contextValue = sessionContextValue(
      node,
      boundHere,
      host,
      this.sessionCliOf(node.id),
    );

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
          project.branchesShown !== false &&
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
      const folder = grouping.folders.find(
        (g) => g.rootIds.indexOf(el.id) >= 0,
      );
      if (folder) return folder;
      // A filtered-out running session's one row hangs under the appendix.
      return grouping.hiddenRunning !== null &&
        grouping.hiddenRunning.rootIds.indexOf(el.id) >= 0
        ? grouping.hiddenRunning
        : undefined;
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
      // The elsewhere appendix set its (static) tooltip on the item itself —
      // rebuilding the folder hover here would replace it with a path-and-count
      // for a row that has no path.
      if (el.type === 'group' && el.key === HIDDEN_RUNNING_GROUP_KEY) return item;
      if (el.type === 'group') this.appendGroupTooltip(md, el);
      else if (el.type === 'project') this.appendProjectTooltip(md, el);
      else if (el.type === 'branch') this.appendBranchTooltip(md, el);
      // A subproject's hover is set on the item itself (a path and a count — see
      // subprojectItem) and has nothing to resolve lazily: no verbs to link, no
      // probe to read. Left as the plain string rather than rebuilt as markdown
      // here, because overwriting it with an empty MarkdownString is how a row
      // silently loses its address.
      else if (el.type === 'subproject') return item;
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
    // WHICH CHECKOUT, in words, next to the path it is a checkout of. The same
    // line the inline hover carries (viewmodel.pushSession sets
    // `branch: <name>` for every row a branch scope claims), and for the same
    // reason: the description can only afford the name on some rows — never on a
    // closed one, since the 2026-08-28 compaction — and before this line existed
    // the native tree's answer to "which branch was that session on" was gone the
    // moment the session closed. The `cwd:` line above is not that answer: a
    // worktree directory is often named after the task rather than the branch,
    // and a plain checkout that has changed branches is the same path either way.
    //
    // Read from the ungated map (see sessionBranchNamesFor), so it appears on
    // live and closed rows alike and below the chip threshold, exactly as the
    // inline hover's does. It is absent, correctly, when `lineage.git.branches`
    // is off — with no branch block there is no branch scope, and this renderer
    // must not invent facts the rest of the view is not showing.
    const branch = this.sessionBranchNamesFor(forest).all.get(node.id);
    if (branch !== undefined) lines.push(`branch: ${mdEscape(branch)}`);
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
    // The detached-running fact, countdown included — viewmodel.ts owns the
    // wording, so the two surfaces cannot drift. It used to be a hand-written
    // copy here with a comment promising it would not; the promise is now
    // structural, which matters more than it did, because since the 2026-08-28
    // review this hover is the ONLY place either surface says how long is left.
    // `Date.now()` because this tooltip resolves lazily, on hover: unlike the
    // inline surface, which computes its hover at build time from `input.now`,
    // this one is asked the question at the moment the pointer stops.
    if (typeof node.graceDeadlineAt === 'number') {
      lines.push(graceTooltipLine(node.graceDeadlineAt, Date.now()));
    }
    if (node.hidden) {
      lines.push('hidden: sorted last, not counted in the badge');
    }
    // The sentence behind the row's 'elsewhere'. Same line, same wording as the
    // inline sidebar's hover — hosts.ts owns it, so the two cannot drift.
    const ownership = hostTooltipLine(this.hostOf(node.id) ?? 'none');
    if (ownership !== undefined) lines.push(mdEscape(ownership));
    // Which subscription this conversation is spending. Beside the ownership
    // line on purpose — "who is running it" and "whose plan pays for it" are
    // the same question asked twice, and on a machine with one account the
    // second has no answer worth a line, so it is absent rather than "default".
    const account = this.accountLabelOf(node.id);
    if (account !== undefined) lines.push(`account: ${mdEscape(account)}`);

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
    if (node.summary) lines.push(`summary: ${mdEscape(sessionSnippet(node))}`);
    // BOTH, never one or the other — same rule as the inline hover, and the two
    // must not drift. These are hover-only since the 2026-08-28 review (a closed
    // row is a name and an age), which is exactly why coalescing them was wrong:
    // with the row no longer carrying either, `summary ?? lastExchange` left a
    // summarised session with no surface anywhere showing what it actually last
    // said. Two facts, two lines, summary first.
    const exchange = exchangeSnippet(node);
    if (exchange !== '') lines.push(`last exchange: ${mdEscape(exchange)}`);

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
      // SESSIONS ONLY. A project row used to ride the same payload under a
      // `project:` prefix, to be dropped onto another project and filed there —
      // retired with record nesting, so the prefix is no longer produced here.
      // The READER for it stays (parseDraggedProjectIds, below), because an older
      // window can still be the source of a drag this one receives, and the
      // honest response to that payload is to decline it rather than to read it
      // as a session id.
      // ROOTS ONLY, for the reason handleDrop gives: what a drag can change is
      // which project a session is filed under, and a row inside a tree has no
      // filing of its own — it is wherever the session it branched from is. A
      // fork picked up here could only ever be refused on the way down, so it
      // is never picked up. (Multi-select drags the roots and leaves the forks
      // behind rather than declining the lot: the roots in the selection are
      // exactly the part of it that has an answer.)
      const roots = new Set(this.forest().visibleRoots);
      for (const el of source) {
        if (el.type === 'session' && roots.has(el.id)) ids.push(el.id);
      }
      if (ids.length === 0) return; // headers, folders, branches and forks

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

      // A PROJECT payload is DECLINED, before the session path and never mixed
      // with it. Filing a project under another project is retired (a subproject
      // is a directory now), and this build no longer produces the payload — but
      // an older window sharing a drag still can, and a `project:<uuid>` string
      // must never fall through to `parseDraggedIds` and be mistaken for a
      // session.
      if (parseDraggedProjectIds(raw).length > 0) return;

      const ids = parseDraggedIds(raw);
      if (ids.length === 0) return;

      const forest = this.forest();

      // Dropping on a PROJECT is a different verb entirely: it does not touch
      // lineage, it teaches the project about the directory the session runs
      // in. That is the whole gesture for "this work belongs to that project".
      // A SUBPROJECT row counts as its project here. The gesture means "this work
      // belongs over there", and the row the user aimed at is a directory of that
      // project — so the alternative is to fall through to the detach path below
      // and silently pull the session out of its lineage instead, which is the
      // one outcome a drop onto a project's own row must never produce.
      if (target && (target.type === 'project' || target.type === 'subproject')) {
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

      // EVERY OTHER TARGET IS REFUSED. Dropping on a session used to re-parent
      // and dropping on a folder row (or empty space) used to detach to a root
      // — so one careless drag could pull a fork out of the tree it branched
      // from, or file an unrelated conversation inside one, and the spine would
      // then state an ancestry no transcript backs with nothing on screen to
      // tell it from the real ones. Lineage is left to what records it: the
      // edge minted at fork time, and inference from the transcripts.
      //
      // A session target says so out loud, because that gesture did something
      // yesterday. A folder row or empty space stays silent — neither ever
      // looked like it accepted a session, and a message per stray drop is
      // noise.
      if (target && target.type === 'session') {
        log('tree.handleDrop: refused lineage drag', ids[0], '->', target.id);
        notify(
          'Flock: sessions cannot be dragged into or out of a tree — a fork ' +
            'sits under the session it branched from. Drag a top-level ' +
            'session onto a project to file it there.',
        );
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
        key.startsWith('subproject:') ||
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

// `isDescendantOf` was here: the cycle guard a drag-reparent needed, so that
// dropping a session onto its own descendant could be refused. Retired with the
// gesture — no drop writes a parent edge any more, so there is no cycle to
// close. The forest's own guards against a cyclic edge (lineage.ts) stay: they
// answer for state files written before this and for inference, neither of
// which this file is the source of.

// ----------------------------------------------------------- registration

export interface TreeController extends DisposableLike {
  refresh(): void;
  revealSession(sessionId: string): Promise<void>;
  /** revealSession, plus the keyboard — see the implementation. */
  focusSession(sessionId: string): Promise<boolean>;
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
      // The RUNNING count — level 1 plus the grace countdown — because the
      // badge is the levels invariant as a number (see RUNNING_BADGE_ENABLED
      // in types.ts for why attention lost this slot). Counted over the
      // RENDERED tree, not the raw forest — see
      // LineageTreeProvider.runningCount(). Not counted at all while the
      // badge is off: 0 falls through to `undefined` below, which clears it.
      const count = RUNNING_BADGE_ENABLED ? provider.runningCount() : 0;
      view.badge =
        typeof count === 'number' && count > 0
          ? {
              value: count,
              tooltip: `${count} session${count === 1 ? '' : 's'} running`,
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

    /** revealSession with `focus: true` — the session-switcher gesture
     *  (COMMANDS.focusSessionsView). The native tree needs no second focus
     *  move the way the webview does: a TreeView is a real workbench list, so
     *  focusing it focuses the row, and the arrows are the workbench's own.
     *  Reports whether the reveal landed, so the caller can say nothing
     *  happened rather than claim it did. */
    async focusSession(sessionId: string): Promise<boolean> {
      try {
        await view.reveal(provider.sessionRef(sessionId), {
          select: true,
          focus: true,
          expand: REVEAL_EXPAND_LEVELS,
        });
        return true;
      } catch (err) {
        logError('tree.focusSession', err);
        return false;
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
