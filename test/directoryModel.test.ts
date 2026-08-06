// test/directoryModel.test.ts — branches belong to a DIRECTORY.
//
// `lineage.preview.directoryModel`, end to end through the two pure layers it
// changes: the grouping pass decides which node carries a branch list, and the
// view model decides how it draws. Four things are worth testing and they are the
// four the feature is made of:
//
//   1. WHERE the branches hang. On the project row when the project has one
//      directory (that row IS its directory), on each subproject row when it has
//      several — and never on both, because a branch drawn twice is a branch you
//      can start two sessions on by accident.
//   2. WHICH ones are outside the fold. The directory's own checkout, and anything
//      with a session on it. A checkout with nothing running is IN the fold, which
//      is the deliberate difference from the older policy.
//   3. That the fold is SHUT by default and complete when open — the whole reason
//      listing 180 branches is affordable.
//   4. That the preview OFF is the tree that shipped. Every assertion about the
//      old layout lives in test/subprojects.test.ts and test/viewmodel.test.ts;
//      what is here is that turning the switch off restores it.

import { describe, expect, it } from 'vitest';

import {
  buildDirectoryBranches,
  computeGrouping,
  directoryBranchVisibility,
  projectBranchList,
} from '../src/projects';
import type { GroupingResult } from '../src/projects';
import {
  branchRowKey,
  buildViewModel,
  formatBranchAge,
  othersRowKey,
  subprojectRowKey,
} from '../src/viewmodel';
import type { ViewModelInput, ViewRow } from '../src/viewmodel';
import type {
  LocalBranch,
  ProjectRecord,
  ProviderId,
  SessionForest,
  SessionNode,
  Worktree,
} from '../src/types';

const A = '0f00000a-0000-4000-8000-00000000000a';
const B = '0f00000b-0000-4000-8000-00000000000b';

const NOW = 1_785_160_000_000;
const NOW_SECONDS = Math.floor(NOW / 1000);
const VIEW = 'lineageSessionsInline';

function project(over: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'p1',
    name: 'app',
    rootDir: '/code/app',
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

function viewInput(
  forest: SessionForest,
  grouping: GroupingResult,
  over: Partial<ViewModelInput> = {},
): ViewModelInput {
  return {
    forest,
    grouping,
    collapsed: new Set<string>(),
    providerFor: () => 'claude' as ProviderId,
    isBoundHere: () => false,
    viewId: VIEW,
    now: NOW,
    ...over,
  };
}

/** A day-old commit, in the units LocalBranch carries. */
const days = (n: number): number => NOW_SECONDS - n * 24 * 60 * 60;

const local = (name: string, ago: number): LocalBranch => ({
  name,
  committedAt: days(ago),
  head: `sha-${name}`,
});

/** The repository at /code/app: main checked out at its root, one linked
 *  worktree, and six more branches that exist only as refs. */
const WORKTREES: Worktree[] = [
  { dir: '/code/app', branch: 'main', head: 'a', detached: false },
  { dir: '/code/app-feat', branch: 'feat/x', head: 'b', detached: false },
];
const LOCALS: LocalBranch[] = [
  local('main', 0),
  local('feat/x', 1),
  local('fix/login', 2),
  local('spike/auth', 6),
  local('release/1.4', 21),
  local('chore/deps', 48),
];

// --------------------------------------------------------------- the policy

describe('directoryBranchVisibility', () => {
  it('promotes the directory’s own checkout', () => {
    expect(
      directoryBranchVisibility({ dir: '/code/app', rootIds: [], ownCheckout: true }),
    ).toBe(true);
  });

  it('promotes a branch with a session on it', () => {
    expect(
      directoryBranchVisibility({
        dir: '/code/app-feat',
        rootIds: [A],
        ownCheckout: false,
      }),
    ).toBe(true);
  });

  it('folds a checkout with nothing running in it', () => {
    // THE DELIBERATE CHANGE from defaultBranchVisibility, which promoted every
    // worktree: a checkout you are not using this week is a directory on disk, not
    // work in flight.
    expect(
      directoryBranchVisibility({
        dir: '/code/app-spike',
        rootIds: [],
        ownCheckout: false,
      }),
    ).toBe(false);
  });

  it('folds a branch with no checkout at all', () => {
    expect(
      directoryBranchVisibility({ dir: '', rootIds: [], ownCheckout: false }),
    ).toBe(false);
  });
});

// -------------------------------------------------------------- the builder

describe('buildDirectoryBranches', () => {
  const build = (over: Partial<Parameters<typeof buildDirectoryBranches>[0]> = {}) =>
    buildDirectoryBranches({
      dir: '/code/app',
      worktrees: WORKTREES,
      localBranches: LOCALS,
      rootIds: [],
      cwdOf: () => undefined,
      ...over,
    });

  it('returns every branch in the repository, not only the checkouts', () => {
    const out = build();
    expect(out).toHaveLength(6);
    expect(out.map((b) => b.name).sort()).toEqual(
      ['chore/deps', 'feat/x', 'fix/login', 'main', 'release/1.4', 'spike/auth'],
    );
  });

  it('leads with the directory’s own checkout, and gives it colour 0', () => {
    const out = build();
    expect(out[0].name).toBe('main');
    expect(out[0].dir).toBe('/code/app');
    expect(out[0].colorIndex).toBe(0);
    expect(out[0].shown).toBe(true);
  });

  it('gives a branch with no checkout an empty dir, which is how a row knows', () => {
    const fix = build().find((b) => b.name === 'fix/login');
    expect(fix?.dir).toBe('');
    expect(fix?.shown).toBe(false);
  });

  it('folds a checkout with no sessions, and promotes one with', () => {
    const idle = build().find((b) => b.name === 'feat/x');
    expect(idle?.shown).toBe(false);

    const busy = build({
      rootIds: [A],
      cwdOf: () => '/code/app-feat/src',
    }).find((b) => b.name === 'feat/x');
    expect(busy?.shown).toBe(true);
    expect(busy?.rootIds).toEqual([A]);
  });

  it('orders the fold newest commit first', () => {
    const folded = build().filter((b) => !b.shown);
    expect(folded.map((b) => b.name)).toEqual([
      'feat/x',      // 1 day
      'fix/login',   // 2
      'spike/auth',  // 6
      'release/1.4', // 21
      'chore/deps',  // 48
    ]);
  });

  it('sorts a branch with no readable date to the back of the fold', () => {
    const folded = build({
      localBranches: [
        local('main', 0),
        { name: 'undated', committedAt: 0, head: '' },
        local('recent', 1),
      ],
    }).filter((b) => !b.shown);
    expect(folded[folded.length - 1].name).toBe('undated');
  });

  it('carries each branch’s commit date, checkouts included', () => {
    const out = build();
    expect(out.find((b) => b.name === 'main')?.lastCommitAt).toBe(days(0));
    expect(out.find((b) => b.name === 'fix/login')?.lastCommitAt).toBe(days(2));
  });

  it('honours the project’s curation in both directions', () => {
    const pinned = build({
      project: project({ shownBranches: ['chore/deps'] }),
    }).find((b) => b.name === 'chore/deps');
    expect(pinned?.shown).toBe(true);

    const hidden = build({
      project: project({ hiddenBranches: ['main'] }),
    }).find((b) => b.name === 'main');
    // Explicit beats implicit, even for the row's own branch.
    expect(hidden?.shown).toBe(false);
  });

  it('leads with the containing checkout for a directory inside a repository', () => {
    // /code/app/api is in the monorepo at /code/app but is not itself a checkout,
    // so the repository's main worktree is the branch the row leads with — it is
    // the checkout the directory physically sits in.
    const out = buildDirectoryBranches({
      dir: '/code/app/api',
      worktrees: WORKTREES,
      localBranches: LOCALS,
      rootIds: [],
      cwdOf: () => undefined,
    });
    expect(out[0].name).toBe('main');
    expect(out[0].shown).toBe(true);
  });

  it('is empty for a directory that is not in a repository', () => {
    expect(
      buildDirectoryBranches({
        dir: '/code/notes',
        worktrees: [],
        localBranches: [],
        rootIds: [],
        cwdOf: () => undefined,
      }),
    ).toEqual([]);
  });

  it('gives a checkouts-only list before the enumeration lands', () => {
    // The first paint of a window: worktrees are cached, refs are not yet.
    const out = buildDirectoryBranches({
      dir: '/code/app',
      worktrees: WORKTREES,
      rootIds: [],
      cwdOf: () => undefined,
    });
    expect(out.map((b) => b.name)).toEqual(['main', 'feat/x']);
    expect(out.every((b) => b.lastCommitAt === undefined)).toBe(true);
  });

  it('files a session on the deepest checkout containing it', () => {
    const nested: Worktree[] = [
      { dir: '/code/app', branch: 'main', head: 'a', detached: false },
      { dir: '/code/app/inner', branch: 'inner', head: 'b', detached: false },
    ];
    const out = buildDirectoryBranches({
      dir: '/code/app',
      worktrees: nested,
      rootIds: [A],
      cwdOf: () => '/code/app/inner/src',
    });
    expect(out.find((b) => b.name === 'inner')?.rootIds).toEqual([A]);
    expect(out.find((b) => b.name === 'main')?.rootIds).toEqual([]);
  });

  it('survives a cwd lookup that throws', () => {
    const out = buildDirectoryBranches({
      dir: '/code/app',
      worktrees: WORKTREES,
      rootIds: [A],
      cwdOf: () => {
        throw new Error('no cwd');
      },
    });
    expect(out.flatMap((b) => b.rootIds)).toEqual([]);
  });

  it('draws a detached checkout under its marker rather than as no branch', () => {
    const out = buildDirectoryBranches({
      dir: '/code/app',
      worktrees: [
        { dir: '/code/app', branch: 'main', head: 'a', detached: false },
        { dir: '/code/app-x', branch: '', head: 'b', detached: true },
      ],
      rootIds: [],
      cwdOf: () => undefined,
    });
    expect(out.map((b) => b.name)).toContain('(detached)');
  });

  it('never gives out a colour the palette does not define', () => {
    const many = Array.from({ length: 40 }, (_, i) => local(`b${i}`, i));
    const out = buildDirectoryBranches({
      dir: '/code/app',
      worktrees: WORKTREES,
      localBranches: many,
      rootIds: [],
      cwdOf: () => undefined,
    });
    expect(out.every((b) => b.colorIndex >= 0 && b.colorIndex < 6)).toBe(true);
  });
});

// -------------------------------------------------------------- the grouping

describe('computeGrouping under the directory model', () => {
  const group = (over: {
    projects: ProjectRecord[];
    directoryModel?: boolean;
    branchRows?: boolean;
    cwdOf?: (id: string) => string | undefined;
    visibleRootIds?: string[];
  }): GroupingResult =>
    computeGrouping({
      visibleRootIds: over.visibleRootIds ?? [],
      cwdOf: over.cwdOf ?? (() => undefined),
      projects: over.projects,
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
      worktreesOf: (dir) =>
        dir === '/code/app' || dir === '/code/app/api' ? WORKTREES : [],
      localBranchesOf: (dir) =>
        dir === '/code/app' || dir === '/code/app/api' ? LOCALS : [],
      branchRows: over.branchRows ?? true,
      ...(over.directoryModel === undefined
        ? {}
        : { directoryModel: over.directoryModel }),
    });

  it('puts a one-directory project’s branches on the project row', () => {
    const result = group({ projects: [project()], directoryModel: true });
    const p = result.projects[0];
    expect(p.branches).toHaveLength(6);
    expect(p.subprojects).toEqual([]);
  });

  it('moves a split project’s branches onto its directories', () => {
    const split = project({ dirs: ['/code/app/api', '/code/notes'] });
    const result = group({ projects: [split], directoryModel: true });
    const p = result.projects[0];
    // NEVER BOTH: a branch drawn twice is a branch you can start two sessions on
    // by accident.
    expect(p.branches).toEqual([]);
    const [app, api, notes] = p.subprojects ?? [];
    expect(app.branches).toHaveLength(6);
    expect(api.branches).toHaveLength(6);
    // Not a repository, so no branches — the row that proves the block belongs to
    // the directory rather than to the project.
    expect(notes.branches).toEqual([]);
  });

  it('leaves the old layout exactly as it was with the preview off', () => {
    const split = project({ dirs: ['/code/app/api', '/code/notes'] });
    const result = group({ projects: [split], directoryModel: false });
    const p = result.projects[0];
    // The project-level union of CHECKOUTS, as it always was — two, not six.
    expect(p.branches).toHaveLength(2);
    expect((p.subprojects ?? []).every((s) => (s.branches ?? []).length === 0)).toBe(
      true,
    );
  });

  it('draws no branches anywhere while lineage.git.branches is off', () => {
    const split = project({ dirs: ['/code/app/api'] });
    const result = group({
      projects: [split],
      directoryModel: true,
      branchRows: false,
    });
    const p = result.projects[0];
    expect(p.branches).toEqual([]);
    expect((p.subprojects ?? []).every((s) => (s.branches ?? []).length === 0)).toBe(
      true,
    );
  });

  it('promotes a branch in the directory whose sessions are on it', () => {
    const split = project({ dirs: ['/code/app/api'] });
    const result = group({
      projects: [split],
      directoryModel: true,
      visibleRootIds: [A],
      cwdOf: () => '/code/app-feat/src',
    });
    const app = (result.projects[0].subprojects ?? [])[0];
    const feat = (app.branches ?? []).find((b) => b.name === 'feat/x');
    expect(feat?.shown).toBe(true);
    expect(feat?.rootIds).toEqual([A]);
  });
});

// ------------------------------------------------------------- the rows

describe('the rows the directory model draws', () => {
  const split = project({ dirs: ['/code/app/api'] });

  const rowsFor = (
    over: {
      collapsed?: Set<string>;
      opened?: Set<string>;
      directoryModel?: boolean;
      cwdOf?: (id: string) => string | undefined;
      visibleRootIds?: string[];
      projects?: ProjectRecord[];
      nodes?: SessionNode[];
    } = {},
  ): ViewRow[] => {
    const forest = forestOf(over.nodes ?? []);
    const grouping = computeGrouping({
      visibleRootIds: over.visibleRootIds ?? [],
      cwdOf: over.cwdOf ?? (() => undefined),
      projects: over.projects ?? [split],
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
      worktreesOf: (dir) =>
        dir === '/code/app' || dir === '/code/app/api' ? WORKTREES : [],
      localBranchesOf: (dir) =>
        dir === '/code/app' || dir === '/code/app/api' ? LOCALS : [],
      branchRows: true,
      directoryModel: over.directoryModel ?? true,
    });
    return buildViewModel(
      viewInput(forest, grouping, {
        directoryModel: over.directoryModel ?? true,
        ...(over.collapsed ? { collapsed: over.collapsed } : {}),
        ...(over.opened ? { opened: over.opened } : {}),
      }),
    );
  };

  it('hangs the promoted rows and the fold under each directory', () => {
    const rows = rowsFor();
    const kinds = rows.map((r) => `${r.kind}:${r.label}`);
    expect(kinds).toEqual([
      'project:app',
      'subproject:app',
      'branch:main',
      'branchOthers:Branches',
      'subproject:api',
      'branch:main',
      'branchOthers:Branches',
    ]);
  });

  it('shuts the fold by default, and says how many are behind it', () => {
    const fold = rowsFor().find((r) => r.kind === 'branchOthers');
    expect(fold?.expandable).toBe(true);
    expect(fold?.expanded).toBe(false);
    // Five: six branches, one promoted.
    expect(fold?.description).toBe('5');
  });

  it('opens onto every branch in the repository, newest first', () => {
    const rows = rowsFor({
      opened: new Set([othersRowKey('p1', 'dir:/code/app')]),
    });
    // Only the FIRST directory's fold is open, so the slice has to stop at the
    // next directory row — otherwise it picks up api's own `main` too.
    const from = rows.findIndex((r) => r.kind === 'branchOthers') + 1;
    const rest = rows.slice(from);
    const to = rest.findIndex((r) => r.kind === 'subproject');
    const under = (to < 0 ? rest : rest.slice(0, to))
      .filter((r) => r.kind === 'branch')
      .map((r) => r.label);
    expect(under).toEqual([
      'feat/x',
      'fix/login',
      'spike/auth',
      'release/1.4',
      'chore/deps',
    ]);
  });

  it('gives each directory its own fold key, so one does not open the other', () => {
    const rows = rowsFor({
      opened: new Set([othersRowKey('p1', 'dir:/code/app')]),
    });
    const folds = rows.filter((r) => r.kind === 'branchOthers');
    expect(folds).toHaveLength(2);
    expect(folds[0].expanded).toBe(true);
    expect(folds[1].expanded).toBe(false);
    expect(folds[0].key).not.toBe(folds[1].key);
  });

  it('scopes a branch row’s key to its directory', () => {
    // Both directories are the same repository here, so both have a `main`. One
    // key between them would make one row's click land on the other.
    const mains = rowsFor().filter((r) => r.kind === 'branch' && r.label === 'main');
    expect(mains).toHaveLength(2);
    expect(mains[0].key).toBe(branchRowKey('p1', 'main', 'dir:/code/app'));
    expect(mains[1].key).toBe(branchRowKey('p1', 'main', 'dir:/code/app/api'));
  });

  it('offers no `+` and no checkout token on a branch with no worktree', () => {
    const rows = rowsFor({
      opened: new Set([othersRowKey('p1', 'dir:/code/app')]),
    });
    const ref = rows.find((r) => r.kind === 'branch' && r.label === 'fix/login');
    expect(ref?.actions ?? []).toEqual([]);
    expect(ref?.context.viewItem).toBe(';branch;');
    expect(ref?.cwd).toBe('');
    expect(ref?.muted).toBe(true);
    // The age, in the column a checkout uses for its session count.
    expect(ref?.description).toBe('2d');
    expect(ref?.tooltip).toContain('New Worktree');
  });

  it('keeps the checkout token on a branch that has one', () => {
    const main = rowsFor().find((r) => r.kind === 'branch' && r.label === 'main');
    expect(main?.context.viewItem).toContain(';checkout;');
    expect(main?.cwd).toBe('/code/app');
  });

  it('draws the sessions directly under the directory with one promoted branch', () => {
    // Nesting costs every session a level and has to buy something: with one
    // promoted branch there is nothing to tell apart.
    const rows = rowsFor({
      visibleRootIds: [A],
      cwdOf: () => '/code/app/lib',
      nodes: [node(A, { cwd: '/code/app/lib' })],
    });
    const at = rows.findIndex((r) => r.kind === 'session');
    expect(at).toBeGreaterThan(-1);
    // Under the `app` directory row, not under a branch row.
    const before = rows.slice(0, at).map((r) => r.kind);
    expect(before[before.length - 1]).toBe('branchOthers');
    expect(rows[at].depth).toBe(2);
  });

  it('nests the sessions under their branch once two are promoted', () => {
    const rows = rowsFor({
      visibleRootIds: [A, B],
      cwdOf: (id) => (id === A ? '/code/app/lib' : '/code/app-feat/src'),
      nodes: [
        node(A, { cwd: '/code/app/lib' }),
        node(B, { cwd: '/code/app-feat/src' }),
      ],
    });
    const feat = rows.findIndex((r) => r.kind === 'branch' && r.label === 'feat/x');
    expect(rows[feat].expandable).toBe(true);
    expect(rows[feat + 1].kind).toBe('session');
    expect(rows[feat + 1].sessionId).toBe(B);
  });

  it('loses no session, whatever the branch rows do', () => {
    // The property that matters more than any individual placement.
    const rows = rowsFor({
      visibleRootIds: [A, B],
      cwdOf: (id) => (id === A ? '/code/app/lib' : '/code/app-feat/src'),
      nodes: [
        node(A, { cwd: '/code/app/lib' }),
        node(B, { cwd: '/code/app-feat/src' }),
      ],
    });
    const drawn = rows.filter((r) => r.kind === 'session').map((r) => r.sessionId);
    expect(drawn.slice().sort()).toEqual([A, B].slice().sort());
  });

  it('draws nothing under a directory that is not a repository', () => {
    const three = project({ dirs: ['/code/app/api', '/code/notes'] });
    const rows = rowsFor({ projects: [three] });
    const notes = rows.findIndex((r) => r.kind === 'subproject' && r.label === 'notes');
    expect(notes).toBeGreaterThan(-1);
    // Last row: no branches, no fold, no sessions.
    expect(rows.slice(notes + 1)).toEqual([]);
  });

  it('keeps the directory row’s own collapse working', () => {
    const rows = rowsFor({
      collapsed: new Set([subprojectRowKey('p1', 'dir:/code/app')]),
    });
    const kinds = rows.map((r) => `${r.kind}:${r.label}`);
    // The `app` directory is shut, so its branches and fold are gone; `api` is
    // untouched.
    expect(kinds).toEqual([
      'project:app',
      'subproject:app',
      'subproject:api',
      'branch:main',
      'branchOthers:Branches',
    ]);
  });

  it('is the old tree with the preview off', () => {
    const rows = rowsFor({ directoryModel: false });
    const kinds = rows.map((r) => `${r.kind}:${r.label}`);
    // Project-level checkouts above the directory rows, and no fold — which is
    // what shipped.
    expect(kinds).toEqual([
      'project:app',
      'branch:main',
      'branch:feat/x',
      'subproject:app',
      'subproject:api',
    ]);
  });
});

// ------------------------------------------- the seam with the palette verbs

describe('projectBranchList', () => {
  const branch = (name: string, dir: string) => ({
    name,
    dir,
    colorIndex: 0,
    rootIds: [],
    primary: dir !== '',
    shown: true,
  });

  it('answers with the project’s own list when it has one', () => {
    const own = [branch('main', '/code/app')];
    expect(projectBranchList({ branches: own })).toBe(own);
  });

  it('unions its directories’ lists when the project has none', () => {
    // WHY THIS EXISTS: New Worktree… and Remove Worktree reach a project from the
    // command palette with no row to start from, and resolve against this. Under
    // the directory model a split project's own list is empty, so reading only the
    // project node would tell those verbs a repository with two checkouts has none.
    const out = projectBranchList({
      branches: [],
      subprojects: [
        { branches: [branch('main', '/code/app'), branch('feat/x', '/code/app-feat')] },
        { branches: [branch('main', '/code/web')] },
      ],
    });
    expect(out.map((b) => `${b.name}@${b.dir}`)).toEqual([
      'main@/code/app',
      'feat/x@/code/app-feat',
      // A second repository's `main` is a DIFFERENT place a session can run, so it
      // is a second entry rather than a duplicate.
      'main@/code/web',
    ]);
  });

  it('dedupes the same checkout reached through two directories', () => {
    // Two directories of one repository report the same worktree list.
    const out = projectBranchList({
      subprojects: [
        { branches: [branch('main', '/code/app')] },
        { branches: [branch('main', '/code/app')] },
      ],
    });
    expect(out).toHaveLength(1);
  });

  it('dedupes case-insensitively, the way every path rule here does', () => {
    const out = projectBranchList({
      subprojects: [
        { branches: [branch('main', '/code/app')] },
        { branches: [branch('main', '/Code/App')] },
      ],
    });
    expect(out).toHaveLength(1);
  });

  it('keeps two refs of the same name apart from a checkout of it', () => {
    // A branch with no checkout has dir '', which is not the same row as one with
    // a directory — and the verbs that need a directory read exactly that field.
    const out = projectBranchList({
      subprojects: [
        { branches: [branch('feat/x', ''), branch('feat/x', '/code/app-feat')] },
      ],
    });
    expect(out).toHaveLength(2);
  });

  it.each([
    ['an undefined node', undefined],
    ['an empty node', {}],
    ['a node with empty lists', { branches: [], subprojects: [] }],
    ['directories with no branches', { subprojects: [{}, { branches: [] }] }],
  ])('answers with nothing for %s', (_what, node) => {
    expect(projectBranchList(node)).toEqual([]);
  });

  it('finds a split project’s checkouts through the real grouping', () => {
    // End to end, because this is the seam a unit test of either half would miss.
    const split = project({ dirs: ['/code/app/api'] });
    const result = computeGrouping({
      visibleRootIds: [],
      cwdOf: () => undefined,
      projects: [split],
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
      worktreesOf: () => WORKTREES,
      localBranchesOf: () => LOCALS,
      branchRows: true,
      directoryModel: true,
    });
    const node = result.projects[0];
    expect(node.branches).toEqual([]);
    const offered = projectBranchList(node);
    // Both checkouts, and the main one first — the anchor both worktree verbs use
    // as their `git -C` directory.
    expect(offered.filter((b) => b.dir !== '').map((b) => b.dir)).toEqual([
      '/code/app',
      '/code/app-feat',
    ]);
    expect((offered.find((b) => b.primary) ?? offered[0]).dir).toBe('/code/app');
  });
});

// ------------------------------------------------------------------ the age

describe('formatBranchAge', () => {
  const at = (seconds: number): string => formatBranchAge(seconds, NOW);

  it.each([
    ['minutes', NOW_SECONDS - 5 * 60, '5m'],
    ['an hour', NOW_SECONDS - 90 * 60, '1h'],
    ['hours', NOW_SECONDS - 5 * 60 * 60, '5h'],
    ['days', NOW_SECONDS - 3 * 24 * 60 * 60, '3d'],
    ['weeks', NOW_SECONDS - 30 * 24 * 60 * 60, '4w'],
    ['months', NOW_SECONDS - 200 * 24 * 60 * 60, '6mo'],
    ['years', NOW_SECONDS - 800 * 24 * 60 * 60, '2y'],
  ])('reads %s as %s', (_what, seconds, want) => {
    expect(at(seconds as number)).toBe(want);
  });

  it('never says 0m — a commit that just landed is a minute old', () => {
    expect(at(NOW_SECONDS)).toBe('1m');
  });

  it.each([
    ['an unread date', 0],
    ['a negative date', -5],
    ['a future date', NOW_SECONDS + 600],
  ])('says nothing about %s', (_what, seconds) => {
    // No wording of "in -3 days" improves a clock skew between two machines
    // sharing a repository.
    expect(at(seconds as number)).toBe('');
  });

  it.each([
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('says nothing for %s', (_what, value) => {
    expect(formatBranchAge(value as number | undefined, NOW)).toBe('');
  });
});
