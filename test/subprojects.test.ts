// test/subprojects.test.ts — M26, the two view features.
//
//   1. SUBPROJECTS: a project may be filed under another project, to any depth
//      and any breadth.
//   2. BRANCH GROUPING: `lineage.groupSessionsByBranch` hangs a project's
//      sessions off the branch row for the worktree they run in.
//
// Both are pure decisions — the project tree, the grouping pass, the view model
// — so this is where they are tested, without a workbench anywhere near them.
// The two features share a file because they share the thing they change: how
// deep a row sits and what it hangs off.

import { describe, expect, it } from 'vitest';

import {
  branchRowKey,
  buildViewModel,
  projectContextValue,
  projectRowKey,
  sessionRowKey,
} from '../src/viewmodel';
import type { ViewModelInput } from '../src/viewmodel';
import {
  buildProjectTree,
  canReparentProject,
  computeGrouping,
  matchProject,
  projectSubtree,
  unbranchedRoots,
} from '../src/projects';
import type { GroupingResult } from '../src/projects';
import { MAX_PROJECT_DEPTH } from '../src/types';
import type {
  BranchInfo,
  ProjectRecord,
  ProviderId,
  SessionForest,
  SessionNode,
  Worktree,
} from '../src/types';

const A = '0f00000a-0000-4000-8000-00000000000a';
const B = '0f00000b-0000-4000-8000-00000000000b';
const C = '0f00000c-0000-4000-8000-00000000000c';

const NOW = 1_785_160_000_000;
const VIEW = 'lineageSessionsInline';

function project(
  id: string,
  name: string,
  rootDir: string,
  over: Partial<ProjectRecord> = {},
): ProjectRecord {
  return {
    id,
    name,
    rootDir,
    dirs: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function node(id: string, over: Partial<SessionNode> = {}): SessionNode {
  return {
    id,
    parentId: null,
    source: 'none',
    ghost: false,
    archived: false,
    hidden: false,
    deleted: false,
    status: 'idle',
    attention: 'none',
    label: id.slice(0, 8),
    kind: 'interactive',
    children: [],
    visibleChildren: [],
    ...over,
  };
}

function forestOf(nodes: SessionNode[]): SessionForest {
  const map = new Map(nodes.map((n) => [n.id, n] as const));
  const roots = nodes.filter((n) => n.parentId === null).map((n) => n.id);
  return {
    nodes: map,
    roots,
    visibleRoots: roots,
    edges: [],
    attentionCount: 0,
    generatedAt: NOW,
  };
}

const EMPTY_GROUPING: GroupingResult = {
  projects: [],
  folders: [],
  loose: [],
  hiddenCount: 0,
};

function input(
  forest: SessionForest,
  grouping: Partial<GroupingResult> = {},
  over: Partial<ViewModelInput> = {},
): ViewModelInput {
  return {
    forest,
    grouping: { ...EMPTY_GROUPING, ...grouping },
    collapsed: new Set<string>(),
    providerFor: () => 'claude' as ProviderId,
    isBoundHere: () => false,
    viewId: VIEW,
    now: NOW,
    ...over,
  };
}

const keys = (rows: { key: string }[]): string[] => rows.map((r) => r.key);

// ---------------------------------------------------------------- the tree

describe('buildProjectTree', () => {
  it('files a child under its parent and keeps siblings in name order', () => {
    const tree = buildProjectTree([
      project('web', 'web', '/code/app/web', { parentId: 'app' }),
      project('app', 'app', '/code/app'),
      project('api', 'api', '/code/app/api', { parentId: 'app' }),
    ]);
    expect(tree.roots).toEqual(['app']);
    expect(tree.byId.get('app')?.childIds).toEqual(['api', 'web']);
    expect(tree.byId.get('api')?.depth).toBe(1);
    expect(tree.order).toEqual(['app', 'api', 'web']);
  });

  it('walks depth-first: a subtree sits between its parent and the next sibling', () => {
    const tree = buildProjectTree([
      project('a', 'a', '/a'),
      project('a1', 'a1', '/a/1', { parentId: 'a' }),
      project('a1x', 'a1x', '/a/1/x', { parentId: 'a1' }),
      project('b', 'b', '/b'),
    ]);
    expect(tree.order).toEqual(['a', 'a1', 'a1x', 'b']);
    expect(tree.byId.get('a1x')?.depth).toBe(2);
  });

  // The four ways a stored pointer can be wrong. Every one of them has to
  // render as SOMETHING — a project nobody can see is a project nobody can fix.
  it('re-roots a child whose parent does not exist', () => {
    const tree = buildProjectTree([
      project('api', 'api', '/code/api', { parentId: 'deleted-long-ago' }),
    ]);
    expect(tree.roots).toEqual(['api']);
    expect(tree.byId.get('api')?.parentId).toBeNull();
  });

  it('refuses a project filed under itself', () => {
    const tree = buildProjectTree([
      project('api', 'api', '/code/api', { parentId: 'api' }),
    ]);
    expect(tree.byId.get('api')?.parentId).toBeNull();
    expect(tree.order).toEqual(['api']);
  });

  it('breaks a cycle and still shows every project exactly once', () => {
    const tree = buildProjectTree([
      project('a', 'a', '/a', { parentId: 'b' }),
      project('b', 'b', '/b', { parentId: 'a' }),
    ]);
    expect(tree.order.slice().sort()).toEqual(['a', 'b']);
    // Exactly one of them was cut loose — which is what makes it a tree.
    const parents = ['a', 'b'].map((id) => tree.byId.get(id)?.parentId);
    expect(parents.filter((p) => p === null)).toHaveLength(1);
  });

  it('breaks a three-way cycle the same way', () => {
    const tree = buildProjectTree([
      project('a', 'a', '/a', { parentId: 'b' }),
      project('b', 'b', '/b', { parentId: 'c' }),
      project('c', 'c', '/c', { parentId: 'a' }),
    ]);
    expect(tree.order).toHaveLength(3);
    expect(tree.roots).toHaveLength(1);
  });

  it('cuts a chain at the depth cap instead of indenting forever', () => {
    const records: ProjectRecord[] = [];
    for (let i = 0; i < MAX_PROJECT_DEPTH + 3; i++) {
      records.push(
        project(`p${i}`, `p${i}`, `/p${i}`, i === 0 ? {} : { parentId: `p${i - 1}` }),
      );
    }
    const tree = buildProjectTree(records);
    expect(tree.order).toHaveLength(records.length);
    for (const node of tree.byId.values()) {
      expect(node.depth).toBeLessThan(MAX_PROJECT_DEPTH);
    }
  });

  it('is deterministic: the same records always produce the same tree', () => {
    const records = [
      project('b', 'b', '/b', { parentId: 'a' }),
      project('a', 'a', '/a', { parentId: 'b' }),
    ];
    const first = buildProjectTree(records);
    const second = buildProjectTree(records.slice().reverse());
    expect(first.order).toEqual(second.order);
    expect(first.roots).toEqual(second.roots);
  });

  it('projectSubtree names the project and everything under it', () => {
    const tree = buildProjectTree([
      project('a', 'a', '/a'),
      project('a1', 'a1', '/a/1', { parentId: 'a' }),
      project('a2', 'a2', '/a/2', { parentId: 'a1' }),
      project('b', 'b', '/b'),
    ]);
    expect(projectSubtree(tree, 'a')).toEqual(['a', 'a1', 'a2']);
    expect(projectSubtree(tree, 'b')).toEqual(['b']);
    expect(projectSubtree(tree, 'nope')).toEqual([]);
  });
});

describe('canReparentProject', () => {
  const records = [
    project('a', 'a', '/a'),
    project('a1', 'a1', '/a/1', { parentId: 'a' }),
    project('b', 'b', '/b'),
  ];

  it('allows a move to the top level, always', () => {
    expect(canReparentProject(records, 'a1', null).ok).toBe(true);
  });

  it('allows filing one root under another', () => {
    expect(canReparentProject(records, 'b', 'a').ok).toBe(true);
  });

  it('refuses a project under itself', () => {
    const verdict = canReparentProject(records, 'a', 'a');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('itself');
  });

  it('refuses a project under its own descendant', () => {
    const verdict = canReparentProject(records, 'a', 'a1');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('subproject');
  });

  it('refuses a move that would push the subtree past the cap', () => {
    const chain: ProjectRecord[] = [];
    for (let i = 0; i < MAX_PROJECT_DEPTH - 1; i++) {
      chain.push(
        project(`c${i}`, `c${i}`, `/c${i}`, i === 0 ? {} : { parentId: `c${i - 1}` }),
      );
    }
    const deep = `c${MAX_PROJECT_DEPTH - 2}`;
    const all = [...chain, project('x', 'x', '/x'), project('x1', 'x1', '/x/1', { parentId: 'x' })];
    const verdict = canReparentProject(all, 'x', deep);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('deep');
  });
});

// ------------------------------------------------------------- membership

describe('matchProject with nesting', () => {
  const parent = project('app', 'app', '/code/app');
  const child = project('api', 'api', '/code/app/api', { parentId: 'app' });

  it('still gives a session to the longest matching directory', () => {
    expect(matchProject([parent, child], '/code/app/api/src')?.project.id).toBe(
      'api',
    );
    expect(matchProject([parent, child], '/code/app/docs')?.project.id).toBe(
      'app',
    );
  });

  it('gives a directory listed by BOTH to the deeper project', () => {
    const shared = project('api', 'api', '/code/app', { parentId: 'app' });
    expect(matchProject([parent, shared], '/code/app/x')?.project.id).toBe('api');
  });

  it('gives a WORKTREE both can see to the project that owns the repo', () => {
    // Both projects sit inside the same repository, so both are handed the
    // same worktree list — the parent owns it.
    const worktree = '/code/app-feat';
    const extraDirs = (): readonly string[] => [worktree];
    const match = matchProject([child, parent], `${worktree}/src`, extraDirs);
    expect(match?.project.id).toBe('app');
    expect(match?.own).toBe(false);
  });

  it('prefers a LISTED directory over a worktree at the same depth', () => {
    const listed = project('feat', 'feat', '/code/app-feat');
    const match = matchProject(
      [parent, listed],
      '/code/app-feat/src',
      (p) => (p.id === 'app' ? ['/code/app-feat'] : []),
    );
    expect(match?.project.id).toBe('feat');
    expect(match?.own).toBe(true);
  });
});

// ---------------------------------------------------------------- grouping

describe('computeGrouping with subprojects', () => {
  const parent = project('app', 'app', '/code/app');
  const child = project('api', 'api', '/code/app/api', { parentId: 'app' });

  function group(over: Partial<Parameters<typeof computeGrouping>[0]> = {}) {
    return computeGrouping({
      visibleRootIds: [A, B],
      cwdOf: (id) => (id === A ? '/code/app' : '/code/app/api'),
      projects: [parent, child],
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
      ...over,
    });
  }

  it('emits both projects, depth-first, with their place on them', () => {
    const result = group();
    expect(result.projects.map((p) => p.projectId)).toEqual(['app', 'api']);
    expect(result.projects[0].depth).toBe(0);
    expect(result.projects[0].parentProjectId).toBeNull();
    expect(result.projects[0].childProjectIds).toEqual(['api']);
    expect(result.projects[1].depth).toBe(1);
    expect(result.projects[1].parentProjectId).toBe('app');
  });

  it('files each session under the project that owns its directory', () => {
    const result = group();
    expect(result.projects[0].rootIds).toEqual([A]);
    expect(result.projects[1].rootIds).toEqual([B]);
  });

  it('closing a parent closes its subtree and takes both sets of sessions', () => {
    const result = group({
      projects: [{ ...parent, hidden: true }, child],
    });
    expect(result.projects).toEqual([]);
    expect(result.loose).toEqual([]);
    expect(result.hiddenCount).toBe(2);
  });

  it('closing a CHILD leaves the parent and its own sessions alone', () => {
    const result = group({ projects: [parent, { ...child, hidden: true }] });
    expect(result.projects.map((p) => p.projectId)).toEqual(['app']);
    expect(result.projects[0].childProjectIds).toEqual([]);
    expect(result.projects[0].rootIds).toEqual([A]);
    expect(result.hiddenCount).toBe(1);
  });

  it('reuses the previous node object only while its place is unchanged', () => {
    const first = group();
    const reused = computeGrouping(
      {
        visibleRootIds: [A, B],
        cwdOf: (id) => (id === A ? '/code/app' : '/code/app/api'),
        projects: [parent, child],
        hiddenFolders: [],
        groupByFolder: true,
        onlyProjectSessions: false,
      },
      first,
    );
    expect(reused.projects[0]).toBe(first.projects[0]);

    // Move the child out: the parent's childProjectIds changed, so its row is
    // a NEW object and the workbench repaints it.
    const moved = computeGrouping(
      {
        visibleRootIds: [A, B],
        cwdOf: (id) => (id === A ? '/code/app' : '/code/app/api'),
        projects: [parent, { ...child, parentId: undefined }],
        hiddenFolders: [],
        groupByFolder: true,
        onlyProjectSessions: false,
      },
      first,
    );
    expect(moved.projects[0]).not.toBe(first.projects[0]);
    expect(moved.projects[1].depth).toBe(0);
  });
});

// --------------------------------------------------------------- rendering

describe('buildViewModel: subproject rows', () => {
  const rows = (): ReturnType<typeof buildViewModel> =>
    buildViewModel(
      input(forestOf([node(A), node(B)]), {
        projects: [
          {
            type: 'project',
            projectId: 'app',
            label: 'app',
            rootDir: '/code/app',
            dirs: ['/code/app'],
            provider: 'claude',
            rootIds: [A],
            depth: 0,
            parentProjectId: null,
            childProjectIds: ['api'],
          },
          {
            type: 'project',
            projectId: 'api',
            label: 'api',
            rootDir: '/code/app/api',
            dirs: ['/code/app/api'],
            provider: 'claude',
            rootIds: [B],
            depth: 1,
            parentProjectId: 'app',
            childProjectIds: [],
          },
        ],
      }),
    );

  it('draws a subproject between its parent and the parent’s next block', () => {
    expect(keys(rows())).toEqual([
      projectRowKey('app'),
      sessionRowKey(A),
      projectRowKey('api'),
      sessionRowKey(B),
    ]);
  });

  it('indents the subproject and everything filed under it', () => {
    const out = rows();
    expect(out.map((r) => r.indent ?? 0)).toEqual([0, 0, 1, 1]);
    // depth is the OUTLINE level, which is what ArrowLeft and aria-level read.
    expect(out.map((r) => r.depth)).toEqual([0, 1, 1, 2]);
  });

  it('a collapsed parent hides its subprojects too', () => {
    const out = buildViewModel(
      input(
        forestOf([node(A), node(B)]),
        {
          projects: [
            {
              type: 'project',
              projectId: 'app',
              label: 'app',
              rootDir: '/code/app',
              dirs: ['/code/app'],
              provider: 'claude',
              rootIds: [A],
              depth: 0,
              parentProjectId: null,
              childProjectIds: ['api'],
            },
            {
              type: 'project',
              projectId: 'api',
              label: 'api',
              rootDir: '/code/app/api',
              dirs: ['/code/app/api'],
              provider: 'claude',
              rootIds: [B],
              depth: 1,
              parentProjectId: 'app',
              childProjectIds: [],
            },
          ],
        },
        { collapsed: new Set([projectRowKey('app')]) },
      ),
    );
    expect(keys(out)).toEqual([projectRowKey('app')]);
  });

  it('rolls an unseen session in a subproject up to the parent row', () => {
    const out = buildViewModel(
      input(forestOf([node(A), node(B, { unseen: true })]), {
        projects: [
          {
            type: 'project',
            projectId: 'app',
            label: 'app',
            rootDir: '/code/app',
            dirs: ['/code/app'],
            provider: 'claude',
            rootIds: [A],
            depth: 0,
            parentProjectId: null,
            childProjectIds: ['api'],
          },
          {
            type: 'project',
            projectId: 'api',
            label: 'api',
            rootDir: '/code/app/api',
            dirs: ['/code/app/api'],
            provider: 'claude',
            rootIds: [B],
            depth: 1,
            parentProjectId: 'app',
            childProjectIds: [],
          },
        ],
      }),
    );
    expect(out[0].badgeKind).toBe('done');
  });

  it('marks the row so a menu can single out a nested project', () => {
    const value = projectContextValue({
      type: 'project',
      projectId: 'api',
      label: 'api',
      rootDir: '/code/app/api',
      dirs: ['/code/app/api'],
      provider: 'claude',
      rootIds: [],
      parentProjectId: 'app',
      childProjectIds: [],
    });
    expect(value).toContain(';subproject;');
    expect(value).not.toContain(';parentProject;');

    const parentValue = projectContextValue({
      type: 'project',
      projectId: 'app',
      label: 'app',
      rootDir: '/code/app',
      dirs: ['/code/app'],
      provider: 'claude',
      rootIds: [],
      childProjectIds: ['api'],
    });
    expect(parentValue).toContain(';parentProject;');
    expect(parentValue).not.toContain(';subproject;');
  });

  it('cannot be made to recurse by a grouping that names a cycle', () => {
    // computeGrouping cannot produce one — buildProjectTree breaks cycles — but
    // this function is also handed hand-built groupings, and a renderer that
    // can be made to loop forever is one that can hang the extension host.
    const out = buildViewModel(
      input(forestOf([]), {
        projects: [
          {
            type: 'project',
            projectId: 'a',
            label: 'a',
            rootDir: '/a',
            dirs: ['/a'],
            provider: 'claude',
            rootIds: [],
            depth: 0,
            parentProjectId: null,
            childProjectIds: ['b'],
          },
          {
            type: 'project',
            projectId: 'b',
            label: 'b',
            rootDir: '/b',
            dirs: ['/b'],
            provider: 'claude',
            rootIds: [],
            depth: 1,
            parentProjectId: 'a',
            childProjectIds: ['a'],
          },
        ],
      }),
    );
    expect(keys(out)).toEqual([projectRowKey('a'), projectRowKey('b')]);
  });

  it('lets a project row be dragged', () => {
    expect(rows()[0].canDrag).toBe(true);
  });
});

// -------------------------------------------------------- branch grouping

function branch(
  name: string,
  dir: string,
  rootIds: string[],
  over: Partial<BranchInfo> = {},
): BranchInfo {
  return {
    name,
    dir,
    colorIndex: 0,
    rootIds,
    primary: name === 'main',
    shown: true,
    ...over,
  };
}

function branchProject(branches: BranchInfo[], rootIds: string[]) {
  return {
    type: 'project' as const,
    projectId: 'app',
    label: 'app',
    rootDir: '/code/app',
    dirs: ['/code/app'],
    provider: 'claude' as ProviderId,
    rootIds,
    branches,
    depth: 0,
    parentProjectId: null,
    childProjectIds: [],
  };
}

describe('unbranchedRoots', () => {
  it('keeps what no SHOWN branch claimed', () => {
    const branches = [
      branch('main', '/code/app', [A]),
      branch('feat', '/code/app-feat', [B], { shown: false }),
    ];
    expect(unbranchedRoots([A, B, C], branches)).toEqual([B, C]);
  });
});

describe('buildViewModel: branch grouping', () => {
  const branches = [
    branch('main', '/code/app', [A]),
    branch('feat/x', '/code/app-feat', [B]),
  ];

  it('is off by default: branches and sessions stay two flat blocks', () => {
    const out = buildViewModel(
      input(forestOf([node(A), node(B)]), {
        projects: [branchProject(branches, [A, B])],
      }),
    );
    expect(keys(out)).toEqual([
      projectRowKey('app'),
      branchRowKey('app', 'main'),
      branchRowKey('app', 'feat/x'),
      sessionRowKey(A),
      sessionRowKey(B),
    ]);
    expect(out[1].expandable).toBe(false);
    expect(out[1].description).toBe('');
  });

  it('hangs each session off its own branch row when it is on', () => {
    const out = buildViewModel(
      input(
        forestOf([node(A), node(B)]),
        { projects: [branchProject(branches, [A, B])] },
        { groupByBranch: true },
      ),
    );
    expect(keys(out)).toEqual([
      projectRowKey('app'),
      branchRowKey('app', 'main'),
      sessionRowKey(A),
      branchRowKey('app', 'feat/x'),
      sessionRowKey(B),
    ]);
    // The session sits one level in from its branch row.
    expect(out.map((r) => r.indent ?? 0)).toEqual([0, 0, 1, 0, 1]);
    expect(out[1].expandable).toBe(true);
    expect(out[1].description).toBe('1');
  });

  it('collapses a branch without losing the row or the count', () => {
    const out = buildViewModel(
      input(
        forestOf([node(A), node(B)]),
        { projects: [branchProject(branches, [A, B])] },
        {
          groupByBranch: true,
          collapsed: new Set([branchRowKey('app', 'main')]),
        },
      ),
    );
    expect(keys(out)).toEqual([
      projectRowKey('app'),
      branchRowKey('app', 'main'),
      branchRowKey('app', 'feat/x'),
      sessionRowKey(B),
    ]);
    expect(out[1].expanded).toBe(false);
    expect(out[1].description).toBe('1');
  });

  it('keeps a session no shown branch claimed directly under the project', () => {
    const curated = [
      branch('main', '/code/app', [A]),
      branch('feat/x', '/code/app-feat', [B], { shown: false }),
    ];
    const out = buildViewModel(
      input(
        forestOf([node(A), node(B)]),
        { projects: [branchProject(curated, [A, B])] },
        { groupByBranch: true },
      ),
    );
    expect(keys(out)).toEqual([
      projectRowKey('app'),
      branchRowKey('app', 'main'),
      sessionRowKey(A),
      // feat/x is folded away into "Others" — its session still has a row.
      'others:app',
      sessionRowKey(B),
    ]);
    expect(out[4].indent ?? 0).toBe(0);
  });

  it('folding the block brings every session back under the project', () => {
    // The fold hides the branch ROWS. Under grouping it must not take their
    // children with it — that would be a fold that deleted four running
    // sessions from the tree.
    const out = buildViewModel(
      input(
        forestOf([node(A), node(B)]),
        {
          projects: [
            { ...branchProject(branches, [A, B]), branchesCollapsed: true },
          ],
        },
        { groupByBranch: true },
      ),
    );
    expect(keys(out)).toEqual([
      projectRowKey('app'),
      sessionRowKey(A),
      sessionRowKey(B),
    ]);
  });

  it('leaves an EMPTY branch as a click-to-start row', () => {
    const empty = [
      branch('main', '/code/app', [A]),
      branch('feat/x', '/code/app-feat', []),
    ];
    const out = buildViewModel(
      input(
        forestOf([node(A)]),
        { projects: [branchProject(empty, [A])] },
        { groupByBranch: true },
      ),
    );
    const feat = out.find((r) => r.key === branchRowKey('app', 'feat/x'));
    expect(feat?.expandable).toBe(false);
    expect(feat?.actions).toBeUndefined();
  });

  it('gives a grouped branch row the + that its click used to be', () => {
    const out = buildViewModel(
      input(
        forestOf([node(A), node(B)]),
        { projects: [branchProject(branches, [A, B])] },
        { groupByBranch: true },
      ),
    );
    expect(out[1].actions?.map((a) => a.id)).toEqual(['newSessionInBranch']);
  });

  it('does nothing at all below the chip threshold', () => {
    const one = [branch('main', '/code/app', [A])];
    const out = buildViewModel(
      input(
        forestOf([node(A)]),
        { projects: [branchProject(one, [A])] },
        { groupByBranch: true },
      ),
    );
    expect(keys(out)).toEqual([projectRowKey('app'), sessionRowKey(A)]);
  });

  it('nests under a SUBPROJECT: both indents add up', () => {
    const out = buildViewModel(
      input(
        forestOf([node(A), node(B)]),
        {
          projects: [
            {
              ...branchProject([], []),
              projectId: 'root',
              label: 'root',
              childProjectIds: ['app'],
            },
            {
              ...branchProject(branches, [A, B]),
              depth: 1,
              parentProjectId: 'root',
            },
          ],
        },
        { groupByBranch: true },
      ),
    );
    expect(keys(out)).toEqual([
      projectRowKey('root'),
      projectRowKey('app'),
      branchRowKey('app', 'main'),
      sessionRowKey(A),
      branchRowKey('app', 'feat/x'),
      sessionRowKey(B),
    ]);
    expect(out.map((r) => r.indent ?? 0)).toEqual([0, 1, 1, 2, 1, 2]);
  });
});

// A worktree list shared by a project and a subproject inside it — the exact
// shape M26 introduces, and the one place the two features meet in the
// grouping pass rather than in the renderer.
describe('subprojects inside a repository with worktrees', () => {
  const parent = project('app', 'app', '/code/app');
  const child = project('api', 'api', '/code/app/api', { parentId: 'app' });
  const worktrees: Worktree[] = [
    { dir: '/code/app', branch: 'main', head: 'a', detached: false },
    { dir: '/code/app-feat', branch: 'feat', head: 'b', detached: false },
  ];

  it('keeps the other worktree with the parent, not with the subproject', () => {
    const result = computeGrouping({
      visibleRootIds: [A, B, C],
      cwdOf: (id) =>
        id === A ? '/code/app' : id === B ? '/code/app/api' : '/code/app-feat',
      projects: [parent, child],
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
      worktreesOf: () => worktrees,
    });
    const byId = new Map(result.projects.map((p) => [p.projectId, p] as const));
    expect(byId.get('app')?.rootIds).toEqual([A, C]);
    expect(byId.get('api')?.rootIds).toEqual([B]);
  });
});
