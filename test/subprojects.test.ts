// test/subprojects.test.ts — three view features that share a mechanism.
//
//   1. SUBPROJECTS: a project's DIRECTORIES, one row each, with the sessions
//      running in each of them. What the word means as of v0.1.2.
//   2. RECORD NESTING: a project filed under another project. RETIRED — v6 of
//      the state schema folds every one of them into its ancestor's directory
//      list (see projects.flattenNestedProjects). The tree builder is still
//      tested here, and still drawn, because `state.json` is merged across
//      windows and hand-editable: a `parentId` an older build wrote has to
//      render as something until the next activation migrates it.
//   3. BRANCH GROUPING: `lineage.groupSessionsByBranch` hangs a project's
//      sessions off the branch row for the worktree they run in. Parked behind
//      `lineage.git.branches`, which is off by default.
//
// All three are pure decisions — the project tree, the grouping pass, the view
// model — so this is where they are tested, without a workbench anywhere near
// them. They share a file because they share the thing they change: how deep a
// row sits and what it hangs off.

import { describe, expect, it } from 'vitest';

import {
  branchRowKey,
  buildViewModel,
  projectContextValue,
  projectRowKey,
  sessionRowKey,
  subprojectRowKey,
} from '../src/viewmodel';
import type { ViewModelInput } from '../src/viewmodel';
import {
  buildProjectTree,
  buildSubprojects,
  canReparentProject,
  canonicalCheckoutPath,
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
  outOfScopeCount: 0,
  hiddenRunning: null,
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

  it('never puts the subproject token on a PROJECT row', () => {
    // It belongs to a DIRECTORY row now (see the directory-subproject block
    // below). The two rows carry the same projectId, so a project row that also
    // matched `;subproject;` would put both menus on both rows — Delete Project
    // on a directory, Remove Subproject on a project.
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
    expect(value).toBe(';project;empty;');

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
    expect(parentValue).toBe(';project;empty;');
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

  it('does NOT let a project row be dragged', () => {
    // It used to, onto another project row, to be filed there as a subproject.
    // There is nothing left for the gesture to mean — a subproject is a
    // directory, and a project is not a directory you can hand to a project —
    // and a draggable row with no legal target is a control that does nothing.
    expect(rows()[0].canDrag).toBe(false);
  });
});

// -------------------------------------------- directory subprojects, rendered

describe('buildViewModel: directory subproject rows', () => {
  /** One project, two directories, one session in each. */
  const split = (over: Record<string, unknown> = {}) => ({
    type: 'project' as const,
    projectId: 'app',
    label: 'app',
    rootDir: '/code/app',
    dirs: ['/code/app', '/code/app/api'],
    provider: 'claude' as ProviderId,
    rootIds: [A, B],
    subprojects: [
      {
        type: 'subproject' as const,
        projectId: 'app',
        // Implicit rows: a directory nobody has named a lane in, which is every
        // project that has not used v7's named subprojects.
        id: 'dir:/code/app',
        name: '',
        implicit: true,
        dir: '/code/app',
        dirKey: '/code/app',
        label: 'app',
        main: true,
        rootIds: [A],
      },
      {
        type: 'subproject' as const,
        projectId: 'app',
        id: 'dir:/code/app/api',
        name: '',
        implicit: true,
        dir: '/code/app/api',
        dirKey: '/code/app/api',
        label: 'api',
        main: false,
        rootIds: [B],
      },
    ],
    depth: 0,
    parentProjectId: null,
    childProjectIds: [],
    ...over,
  });

  const rows = (over?: Partial<ViewModelInput>) =>
    buildViewModel(
      input(forestOf([node(A), node(B)]), { projects: [split()] }, over),
    );

  it('puts each directory between the project and its own sessions', () => {
    expect(keys(rows())).toEqual([
      projectRowKey('app'),
      subprojectRowKey('app', 'dir:/code/app'),
      sessionRowKey(A),
      subprojectRowKey('app', 'dir:/code/app/api'),
      sessionRowKey(B),
    ]);
  });

  it('draws no session directly under the project', () => {
    // The split is exclusive: every session the project claimed is inside one of
    // these rows, so listing them under the project as well would draw each twice.
    const out = rows();
    const sessions = out.filter((r) => r.kind === 'session');
    expect(sessions).toHaveLength(2);
    expect(sessions.map((r) => r.indent)).toEqual([1, 1]);
  });

  it('indents the directory one level in from the project', () => {
    const out = rows();
    expect(out[0].indent ?? 0).toBe(0);
    expect(out[1].indent).toBe(1);
    expect(out[1].depth).toBe(1);
    expect(out[2].depth).toBe(2);
  });

  it('keeps the project row’s + beside its chat button, split or not', () => {
    // The `+` used to be withdrawn here, on the argument that a project with
    // directory rows under it cannot say which directory a session would start
    // in. It says so now — in the button's own title, written from
    // `lineage.git.newSessionInWorktree` — so the button is back on every
    // project and every subproject, which is where people went looking for it.
    const ids = (rows()[0].actions ?? []).map((a) => a.id);
    expect(ids).toEqual(['chat', 'newSession']);
    expect(rows()[1].actions?.map((a) => a.id)).toEqual([
      'newSessionInSubproject',
    ]);
  });

  it('keeps the + on a single-directory project', () => {
    const out = buildViewModel(
      input(forestOf([node(A)]), {
        projects: [
          {
            type: 'project',
            projectId: 'app',
            label: 'app',
            rootDir: '/code/app',
            dirs: ['/code/app'],
            provider: 'claude',
            rootIds: [A],
            subprojects: [],
            depth: 0,
            parentProjectId: null,
            childProjectIds: [],
          },
        ],
      }),
    );
    expect((out[0].actions ?? []).map((a) => a.id)).toEqual(['chat', 'newSession']);
    expect(keys(out)).toEqual([projectRowKey('app'), sessionRowKey(A)]);
  });

  it('collapses one directory without touching the other', () => {
    const out = rows({
      collapsed: new Set([subprojectRowKey('app', 'dir:/code/app')]),
    });
    expect(keys(out)).toEqual([
      projectRowKey('app'),
      subprojectRowKey('app', 'dir:/code/app'),
      subprojectRowKey('app', 'dir:/code/app/api'),
      sessionRowKey(B),
    ]);
    // Shut, the count is the only thing the row says about what is inside it.
    expect(out[1].description).toBe('1');
    expect(out[1].expanded).toBe(false);
    // Open, the sessions are on screen and the number would restate them.
    expect(out[2].description).toBe('');
  });

  it('a collapsed project hides its directories too', () => {
    const out = rows({ collapsed: new Set([projectRowKey('app')]) });
    expect(keys(out)).toEqual([projectRowKey('app')]);
  });

  it('stays expandable with nothing in it', () => {
    // The directory exists whether or not anything is running in it, and a row
    // that lost its toggle when its last session ended would move everything
    // below it for a reason the user did not cause.
    const empty = split({
      rootIds: [],
      subprojects: [
        {
          type: 'subproject' as const,
          projectId: 'app',
          dir: '/code/app',
          dirKey: '/code/app',
          label: 'app',
          main: true,
          rootIds: [],
        },
        {
          type: 'subproject' as const,
          projectId: 'app',
          dir: '/code/app/api',
          dirKey: '/code/app/api',
          label: 'api',
          main: false,
          rootIds: [],
        },
      ],
    });
    const out = buildViewModel(input(forestOf([]), { projects: [empty] }));
    expect(out[1].expandable).toBe(true);
    expect(out[1].description).toBe('');
  });

  it('carries the subproject token, and `primary` on the main directory', () => {
    const out = rows();
    expect(out[1].context.viewItem).toBe(';subproject;primary;');
    expect(out[3].context.viewItem).toBe(';subproject;');
    // `type: 'subproject'`, never 'project': projectIdFromArg would accept the
    // latter and every project verb would take a directory row as its target.
    expect(out[1].context.type).toBe('subproject');
    expect(out[1].context.dir).toBe('/code/app');
  });

  it('neither renames nor drags', () => {
    const out = rows();
    expect(out[1].canRename).toBe(false);
    expect(out[1].canDrag).toBe(false);
  });

  it('carries no status dot — the project row rolls that up', () => {
    const out = buildViewModel(
      input(
        forestOf([
          node(A, { archived: true, unseen: true }),
          node(B),
        ]),
        { projects: [split()] },
      ),
    );
    expect(out[0].badgeKind).toBe('done');
    expect(out[1].badge).toBeUndefined();
    expect(out[1].badgeKind).toBeUndefined();
  });

  it('the directory split beats branch grouping', () => {
    // Two answers to "what are these sessions filed under", and a row cannot be
    // under both. The directory wins: it is structure the user typed in, where
    // grouping by branch is a view preference.
    const withBranches = split({
      branches: [
        {
          name: 'main',
          dir: '/code/app',
          colorIndex: 0,
          rootIds: [A, B],
          primary: true,
          shown: true,
        },
        {
          name: 'feat/x',
          dir: '/code/app-feat',
          colorIndex: 1,
          rootIds: [],
          primary: false,
          shown: true,
        },
      ],
    });
    const out = buildViewModel(
      input(
        forestOf([node(A), node(B)]),
        { projects: [{ ...withBranches, branchesShown: true }] },
        { groupByBranch: true },
      ),
    );
    // The branch rows are still drawn (they are the flat annotation block), but
    // the sessions hang off the DIRECTORIES, and every one of them is drawn once.
    expect(out.filter((r) => r.kind === 'session')).toHaveLength(2);
    expect(out.filter((r) => r.kind === 'subproject')).toHaveLength(2);
    const order = out.map((r) => r.kind);
    expect(order.slice(0, 3)).toEqual(['project', 'branch', 'branch']);
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

function branchProject(
  branches: BranchInfo[],
  rootIds: string[],
  over: Partial<{ branchesShown: boolean }> = {},
) {
  return {
    type: 'project' as const,
    ...over,
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
    // `branchesShown: true` because the BLOCK is now shut until asked for,
    // on every project and in both display modes. What this test is about is the
    // shape of an unfolded block without grouping: two flat lists, not a nest.
    const out = buildViewModel(
      input(forestOf([node(A), node(B)]), {
        projects: [
          branchProject(branches, [A, B], { branchesShown: true }),
        ],
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
      // feat/x is not shown, and no longer leaves an "Others" row behind it —
      // the count is on the project's hover and the picker is on its menu. Its
      // session still has a row, directly under the project.
      sessionRowKey(B),
    ]);
    expect(out[3].indent ?? 0).toBe(0);
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
            { ...branchProject(branches, [A, B]), branchesShown: false },
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

  it('leaves an EMPTY branch as a click-to-start row, with a + of its own', () => {
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
    // Every branch row carries the `+` now — the row is the one place a branch
    // can be acted on, and an empty worktree is exactly what you reach for one
    // to use.
    expect(feat?.actions?.map((a) => a.id)).toEqual(['newSessionInBranch']);
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

// ------------------------------------------------- no project-wide root row
//
// THE INVARIANT: once a project has directories, every session it claims belongs
// to exactly one of them. The main directory is directory number one, not a
// bucket for the sessions that fit nowhere else.
//
// The way a session used to fit nowhere was the common way — a linked git
// worktree, which `matchProject` gives to the project through a path no directory
// lists — so these tests are mostly about worktrees. They go through
// `computeGrouping` rather than calling `buildSubprojects` directly, because the
// point is that the grouping pass wires the same worktree knowledge into both
// decisions and therefore cannot make them disagree.

describe('subproject membership: no catch-all row', () => {
  const split = project('app', 'app', '/code/app', { dirs: ['/code/app/api'] });
  /** A monorepo at /code/app with one linked worktree beside it. Main FIRST,
   *  which is the order git reports and the order the translation relies on. */
  const worktrees: Worktree[] = [
    { dir: '/code/app', branch: 'main', head: 'a', detached: false },
    { dir: '/code/app-feat', branch: 'feat', head: 'b', detached: false },
  ];

  const subprojectsOf = (
    cwds: Record<string, string>,
    over: { worktreesOf?: () => readonly Worktree[]; projects?: ProjectRecord[] } = {},
  ): { label: string; dir: string; rootIds: string[] }[] => {
    const result = computeGrouping({
      visibleRootIds: Object.keys(cwds),
      cwdOf: (id) => cwds[id],
      projects: over.projects ?? [split],
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
      ...(over.worktreesOf ? { worktreesOf: over.worktreesOf } : {}),
    });
    return (result.projects[0]?.subprojects ?? []).map((s) => ({
      label: s.label,
      dir: s.dir,
      rootIds: s.rootIds,
    }));
  };

  it('files a session in a linked worktree under the directory owning the repo', () => {
    // BEFORE: /code/app-feat is inside neither /code/app nor /code/app/api, so
    // it fell through to the main row as a guess. Now the main row genuinely
    // contains it — it is the directory the repository is at.
    const rows = subprojectsOf(
      { [A]: '/code/app', [B]: '/code/app-feat' },
      { worktreesOf: () => worktrees },
    );
    expect(rows.map((r) => r.label)).toEqual(['app', 'api']);
    expect(rows[0].rootIds).toEqual([A, B]);
    expect(rows[1].rootIds).toEqual([]);
  });

  it('files a worktree session by what it is WORKING ON, not by who owns the repo', () => {
    // THE CASE THE OLD RULE GOT WRONG, and the reason the translation exists: an
    // agent in the api directory of a linked checkout is working on api. Sending
    // it to the main row because that row happens to own the repository is
    // exactly the project-wide bucket this design refuses.
    const rows = subprojectsOf(
      { [A]: '/code/app-feat/api', [B]: '/code/app-feat/api/handlers' },
      { worktreesOf: () => worktrees },
    );
    expect(rows[0].rootIds).toEqual([]);
    expect(rows[1].label).toBe('api');
    expect(rows[1].rootIds).toEqual([A, B]);
  });

  it('prefers a directory that CONTAINS the session over one that owns its repo', () => {
    // /code/app/api contains it outright; no translation is needed or wanted.
    // Same tie-break matchProject makes one level up: a statement beats an
    // inference.
    const rows = subprojectsOf(
      { [A]: '/code/app/api/handlers' },
      { worktreesOf: () => worktrees },
    );
    expect(rows[1].rootIds).toEqual([A]);
  });

  it('does not translate a path already in the main checkout', () => {
    // /code/app/lib is inside the main worktree, so the canonical spelling is the
    // one it already has and the main row takes it directly.
    const rows = subprojectsOf(
      { [A]: '/code/app/lib' },
      { worktreesOf: () => worktrees },
    );
    expect(rows[0].rootIds).toEqual([A]);
    expect(rows[1].rootIds).toEqual([]);
  });

  it('keeps the deeper checkout when one worktree sits inside another', () => {
    // `git worktree add` will happily nest one checkout in another, and the
    // deeper prefix is the one the path is actually in.
    const nested: Worktree[] = [
      { dir: '/code/app', branch: 'main', head: 'a', detached: false },
      { dir: '/code/app-feat', branch: 'feat', head: 'b', detached: false },
      { dir: '/code/app-feat/nested', branch: 'deep', head: 'c', detached: false },
    ];
    const rows = subprojectsOf(
      { [A]: '/code/app-feat/nested/api' },
      { worktreesOf: () => nested },
    );
    // Translated against /code/app-feat/nested, not /code/app-feat, so the tail
    // is `/api` rather than `/nested/api`.
    expect(rows[1].label).toBe('api');
    expect(rows[1].rootIds).toEqual([A]);
  });

  it('sends a session to the directory whose OWN repo holds it, not the other one', () => {
    // Two directories, two unrelated repositories. Only web's repo has the
    // checkout, so the session is web's — the main row must not take it just for
    // being first.
    const twoRepos = project('app', 'app', '/code/notes', {
      dirs: ['/code/web'],
    });
    const rows = subprojectsOf(
      { [A]: '/code/web-feat/src' },
      {
        projects: [twoRepos],
        worktreesOf: (dir?: string) =>
          dir === '/code/web'
            ? [
                { dir: '/code/web', branch: 'main', head: 'a', detached: false },
                { dir: '/code/web-feat', branch: 'feat', head: 'b', detached: false },
              ]
            : [],
      },
    );
    expect(rows[0].label).toBe('notes');
    expect(rows[0].rootIds).toEqual([]);
    expect(rows[1].label).toBe('web');
    expect(rows[1].rootIds).toEqual([A]);
  });

  it('files by the repo owner when the translated path lands outside the project', () => {
    // The repository's root is /code/app but the project only lists a directory
    // BESIDE it, so a worktree session translates to a path the project does not
    // cover. The directory that owns the repository is the honest answer — the
    // session is in that repo, and the tree already said it was this project's.
    const outside = project('app', 'app', '/code/notes', {
      dirs: ['/code/app/api'],
    });
    const rows = subprojectsOf(
      { [A]: '/code/app-feat/web' },
      {
        projects: [outside],
        worktreesOf: (dir?: string) => (dir === '/code/app/api' ? worktrees : []),
      },
    );
    expect(rows[1].label).toBe('api');
    expect(rows[1].rootIds).toEqual([A]);
  });

  it('never even offers the grouping pass a session no directory contains', () => {
    // Why the catch-all has nothing left to catch: project membership and
    // directory membership ask the same question of the same directories, so a
    // session outside all of them was never this project's in the first place —
    // it is a folder row, exactly as it was before the project existed.
    const result = computeGrouping({
      visibleRootIds: [A],
      cwdOf: () => '/somewhere/else',
      projects: [split],
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
    });
    expect(result.projects[0].rootIds).toEqual([]);
    expect((result.projects[0].subprojects ?? []).flatMap((s) => s.rootIds)).toEqual([]);
    expect(result.folders.flatMap((f) => f.rootIds)).toEqual([A]);
  });

  it('files an impossible session in the main row rather than dropping it', () => {
    // Reached only by handing buildSubprojects a session the project's own
    // directories do not account for — which the grouping pass cannot do (see
    // above), and which a worktree probe landing mid-tick could. A stale cache
    // must never be a way to lose a running agent, so the row survives.
    const nodes = buildSubprojects({
      project: split,
      rootIds: [A],
      cwdOf: () => '/somewhere/else',
    });
    expect(nodes[0].main).toBe(true);
    expect(nodes[0].rootIds).toEqual([A]);
    expect(nodes[1].rootIds).toEqual([]);
  });

  it('files a session whose cwd cannot be read in the main row', () => {
    const nodes = buildSubprojects({
      project: split,
      rootIds: [A],
      cwdOf: () => {
        throw new Error('no cwd');
      },
    });
    expect(nodes[0].rootIds).toEqual([A]);
  });

  it('loses no session across the split, whatever the worktree answer is', () => {
    // The property that matters more than any individual placement: the union of
    // the directory rows is exactly the project's session list.
    const cwds = {
      [A]: '/code/app',
      [B]: '/code/app-feat/api',
      [C]: '/code/app/api/deep',
    };
    const result = computeGrouping({
      visibleRootIds: [A, B, C],
      cwdOf: (id) => cwds[id as keyof typeof cwds],
      projects: [split],
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
      worktreesOf: () => worktrees,
    });
    const p = result.projects[0];
    const filed = (p.subprojects ?? []).flatMap((s) => s.rootIds);
    expect(filed.slice().sort()).toEqual(p.rootIds.slice().sort());
    expect(filed).toHaveLength(3);
  });

  it('survives a worktree probe that throws', () => {
    const rows = subprojectsOf(
      { [A]: '/code/app/api' },
      {
        worktreesOf: () => {
          throw new Error('git exploded');
        },
      },
    );
    // The listed directories still do their job; only the translation is lost.
    expect(rows[1].rootIds).toEqual([A]);
  });
});

describe('canonicalCheckoutPath', () => {
  const worktrees: Worktree[] = [
    { dir: '/code/app', branch: 'main', head: 'a', detached: false },
    { dir: '/code/app-feat', branch: 'feat', head: 'b', detached: false },
  ];

  it('rewrites a linked-worktree path as the main checkout spells it', () => {
    expect(canonicalCheckoutPath(worktrees, '/code/app-feat/api/handlers')).toBe(
      '/code/app/api/handlers',
    );
  });

  it('maps the root of a linked worktree to the root of the main one', () => {
    expect(canonicalCheckoutPath(worktrees, '/code/app-feat')).toBe('/code/app');
  });

  it.each([
    ['a path already in the main checkout', '/code/app/api'],
    ['the main checkout itself', '/code/app'],
    ['a path in no checkout at all', '/elsewhere/x'],
    ['an empty path', ''],
    ['an undefined path', undefined],
  ])('says nothing about %s', (_what, cwd) => {
    // '' is "there is no second spelling", which the caller reads as "nothing
    // extra to consider" rather than as a path.
    expect(canonicalCheckoutPath(worktrees, cwd)).toBe('');
  });

  it('says nothing when there are no checkouts, or the main one has no path', () => {
    expect(canonicalCheckoutPath([], '/code/app-feat/api')).toBe('');
    expect(
      canonicalCheckoutPath(
        [{ dir: '', branch: '', head: '', detached: false }],
        '/code/app-feat/api',
      ),
    ).toBe('');
  });

  it('matches a checkout case-insensitively, the way every other path rule does', () => {
    // macOS and Windows both have case-insensitive filesystems by default, so
    // /Code/App-Feat and /code/app-feat are one directory — see pathKey.
    expect(canonicalCheckoutPath(worktrees, '/Code/App-Feat/api')).toBe(
      '/code/app/api',
    );
  });

  it('is boundary-aware: a sibling with a longer name is not inside', () => {
    // /code/app-feature is not in /code/app-feat, and a prefix comparison that
    // missed that would rewrite a path in an unrelated directory.
    expect(canonicalCheckoutPath(worktrees, '/code/app-feature/api')).toBe('');
  });
});

// A worktree list shared by a project and a subproject inside it — the one
// place the two features above meet, and they meet in the grouping pass rather
// than in the renderer.
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
