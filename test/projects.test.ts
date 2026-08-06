// test/projects.test.ts — the project model: path rules, cwd -> project
// matching, and the grouping pass that produces the top level of the tree.
//
// src/projects.ts imports nothing but ./types, so none of this needs the
// vscode mock.

import { describe, expect, it } from 'vitest';

import {
  baseName,
  buildBranches,
  buildSubprojects,
  chatsForProject,
  computeGrouping,
  defaultBranchVisibility,
  flattenNestedProjects,
  parentDir,
  BRANCH_AUTOSHOW_LIMIT,
  isHiddenFolder,
  isWithin,
  matchProject,
  normalizeDir,
  pathKey,
  projectClaiming,
  projectDirs,
  providerOfProject,
  subprojectLabels,
  SUBPROJECT_MIN,
  validateProjectName,
} from '../src/projects';
import type { GroupingInput } from '../src/projects';
import type { EditorialRecord, ProjectRecord } from '../src/types';

// ------------------------------------------------------------------ helpers

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

function grouping(over: Partial<GroupingInput> = {}) {
  const cwds: Record<string, string> = over.cwdOf ? {} : {};
  return computeGrouping({
    visibleRootIds: [],
    cwdOf: () => undefined,
    projects: [],
    hiddenFolders: [],
    groupByFolder: true,
    onlyProjectSessions: false,
    ...over,
    ...(Object.keys(cwds).length > 0 ? {} : {}),
  });
}

/** cwdOf backed by a plain map, so tests read as `{A: '/tmp/alpha'}`. */
function cwdMap(map: Record<string, string | undefined>) {
  return (id: string): string | undefined => map[id];
}

// -------------------------------------------------------------- path rules

describe('normalizeDir', () => {
  it('folds separators, collapses repeats and drops the trailing slash', () => {
    expect(normalizeDir('/tmp/alpha/')).toBe('/tmp/alpha');
    expect(normalizeDir('/tmp//alpha///')).toBe('/tmp/alpha');
    expect(normalizeDir('C:\\code\\api\\')).toBe('C:/code/api');
    expect(normalizeDir('  /tmp/alpha  ')).toBe('/tmp/alpha');
  });

  it('keeps a bare root and rejects non-strings', () => {
    expect(normalizeDir('/')).toBe('/');
    expect(normalizeDir('')).toBe('');
    expect(normalizeDir(undefined)).toBe('');
    expect(normalizeDir(42)).toBe('');
  });

  // Regression: the repeat-collapse used to eat the leading `\\` of a UNC
  // share, so `\\nas\code` was persisted (and handed to Uri.file and to a
  // terminal cwd) as the unrelated local path `/nas/code`. Grouping hid it,
  // because the session cwd was mangled identically.
  it('preserves the UNC share prefix', () => {
    expect(normalizeDir('\\\\nas\\code')).toBe('//nas/code');
    expect(normalizeDir('\\\\nas\\code\\')).toBe('//nas/code');
    expect(normalizeDir('//nas/code//sub')).toBe('//nas/code/sub');
    expect(normalizeDir('\\\\nas')).toBe('//nas');
  });

  it('does not invent a UNC prefix from a plain root', () => {
    expect(normalizeDir('//')).toBe('/');
    expect(normalizeDir('///')).toBe('/');
    expect(normalizeDir('///tmp/alpha')).toBe('/tmp/alpha');
  });

  it('keeps UNC paths comparable and boundary-aware', () => {
    expect(isWithin('\\\\nas\\code', '\\\\nas\\code\\api')).toBe(true);
    expect(isWithin('//nas/code', '//nas/codex')).toBe(false);
    // The prefix is what distinguishes the share from the local path.
    expect(isWithin('//nas/code', '/nas/code')).toBe(false);
  });
});

describe('isWithin', () => {
  it('matches a directory and anything under it', () => {
    expect(isWithin('/tmp/alpha', '/tmp/alpha')).toBe(true);
    expect(isWithin('/tmp/alpha', '/tmp/alpha/sub/deep')).toBe(true);
    expect(isWithin('/tmp/alpha/', '/tmp/alpha/sub')).toBe(true);
  });

  it('respects path boundaries — /a/bc is not inside /a/b', () => {
    expect(isWithin('/tmp/alpha', '/tmp/alphabet')).toBe(false);
    expect(isWithin('/tmp/alpha/sub', '/tmp/alpha')).toBe(false);
  });

  it('compares case-insensitively (macOS and Windows are)', () => {
    expect(isWithin('/Users/x/Code', '/users/x/code/api')).toBe(true);
    expect(pathKey('/Users/X/Code')).toBe('/users/x/code');
  });

  it('never matches on an empty side', () => {
    expect(isWithin('', '/tmp')).toBe(false);
    expect(isWithin('/tmp', '')).toBe(false);
  });
});

describe('baseName', () => {
  it('takes the last segment of a normalized path', () => {
    expect(baseName('/tmp/alpha/')).toBe('alpha');
    expect(baseName('C:\\code\\api')).toBe('api');
    expect(baseName('/')).toBe('/');
  });
});

// ---------------------------------------------------------- project shape

describe('projectDirs', () => {
  it('puts rootDir first and dedupes the extras', () => {
    const p = project('p1', 'API', '/code/api', {
      dirs: ['/code/shared/', '/code/api', '/CODE/SHARED'],
    });
    expect(projectDirs(p)).toEqual(['/code/api', '/code/shared']);
  });

  it('drops blanks and survives a malformed record', () => {
    const p = project('p1', 'X', '/code/x', { dirs: ['', '   '] });
    expect(projectDirs(p)).toEqual(['/code/x']);
    expect(projectDirs({} as ProjectRecord)).toEqual([]);
  });
});

describe('providerOfProject', () => {
  it('defaults to claude and rejects an unknown id', () => {
    expect(providerOfProject(undefined)).toBe('claude');
    expect(providerOfProject(project('p', 'n', '/a'))).toBe('claude');
    expect(
      providerOfProject(project('p', 'n', '/a', { provider: 'gemini' })),
    ).toBe('gemini');
    expect(
      providerOfProject(
        project('p', 'n', '/a', { provider: 'llama' as never }),
      ),
    ).toBe('claude');
  });
});

describe('validateProjectName', () => {
  const existing = [project('p1', 'Magma OS', '/a')];

  it('accepts a fresh name', () => {
    expect(validateProjectName('Flock', existing)).toBe('');
  });

  it('rejects empty, over-long and duplicate names', () => {
    expect(validateProjectName('   ', existing)).toMatch(/empty/);
    expect(validateProjectName('x'.repeat(61), existing)).toMatch(/60 char/);
    expect(validateProjectName('magma os', existing)).toMatch(/already exists/);
  });

  it('lets a project keep its own name while renaming', () => {
    expect(validateProjectName('Magma OS', existing, 'p1')).toBe('');
  });
});

// ------------------------------------------------------ the duplicate claim

describe('projectClaiming: two projects on one directory', () => {
  const outer = project('outer', 'Code', '/code');
  const extra = project('extra', 'Docs', '/docs', { dirs: ['/notes'] });

  it('names the project that already lists the directory', () => {
    expect(projectClaiming([outer], '/code')?.id).toBe('outer');
  });

  it('looks at the extra directories too, not just rootDir', () => {
    expect(projectClaiming([extra], '/notes')?.id).toBe('extra');
  });

  // The whole point of the refusal: a subproject on the PARENT's own directory
  // would take the parent's entire session list with it, which is what a new,
  // empty subproject must never do.
  it('catches a subproject being created on its parent', () => {
    expect(projectClaiming([outer], '/code')?.name).toBe('Code');
  });

  // And the whole point of it being EXACT: nesting by containment is the feature.
  // A subproject one level down is allowed, and takes only what is under it.
  it('allows a subdirectory, which is how nesting is meant to work', () => {
    expect(projectClaiming([outer], '/code/api')).toBeUndefined();
    expect(projectClaiming([outer], '/code/api/src')).toBeUndefined();
  });

  it('allows a parent directory of an existing claim', () => {
    expect(projectClaiming([project('p', 'API', '/code/api')], '/code')).toBeUndefined();
  });

  it('ignores the project being edited', () => {
    expect(projectClaiming([outer], '/code', 'outer')).toBeUndefined();
  });

  it('ignores a tombstone', () => {
    const gone = project('gone', 'Old', '/code', { deleted: true });
    expect(projectClaiming([gone], '/code')).toBeUndefined();
  });

  it('normalizes before comparing, so a trailing slash is the same directory', () => {
    expect(projectClaiming([outer], '/code/')?.id).toBe('outer');
  });

  it('answers nothing for an empty directory or an empty list', () => {
    expect(projectClaiming([outer], '')).toBeUndefined();
    expect(projectClaiming([], '/code')).toBeUndefined();
  });
});

// -------------------------------------------------------------- matching

describe('matchProject', () => {
  const outer = project('outer', 'Code', '/code');
  const inner = project('inner', 'API', '/code/api');
  const extra = project('extra', 'Docs', '/docs', { dirs: ['/notes'] });

  it('claims a session whose cwd is the directory or below it', () => {
    expect(matchProject([outer], '/code')?.project.id).toBe('outer');
    expect(matchProject([outer], '/code/deep/deeper')?.project.id).toBe('outer');
  });

  it('gives a nested directory to the more specific project', () => {
    expect(matchProject([outer, inner], '/code/api/src')?.project.id).toBe(
      'inner',
    );
    expect(matchProject([inner, outer], '/code/api/src')?.project.id).toBe(
      'inner',
    );
    expect(matchProject([outer, inner], '/code/web')?.project.id).toBe('outer');
  });

  it('matches extra directories, not only the main one', () => {
    const m = matchProject([extra], '/notes/2026');
    expect(m?.project.id).toBe('extra');
    expect(m?.dir).toBe('/notes');
  });

  it('returns null for an unknown or missing cwd', () => {
    expect(matchProject([outer], '/elsewhere')).toBeNull();
    expect(matchProject([outer], undefined)).toBeNull();
    expect(matchProject([], '/code')).toBeNull();
  });

  it('breaks an exact tie deterministically, whatever the input order', () => {
    const a = project('id-b', 'Alpha', '/shared');
    const b = project('id-a', 'Beta', '/shared');
    expect(matchProject([a, b], '/shared/x')?.project.id).toBe('id-b');
    expect(matchProject([b, a], '/shared/x')?.project.id).toBe('id-b');
  });
});

describe('isHiddenFolder', () => {
  it('covers the directory and everything under it', () => {
    expect(isHiddenFolder(['/tmp/junk'], '/tmp/junk/run')).toBe(true);
    expect(isHiddenFolder(['/tmp/junk'], '/tmp/junkyard')).toBe(false);
    expect(isHiddenFolder([], '/tmp/junk')).toBe(false);
    expect(isHiddenFolder(['/tmp/junk'], undefined)).toBe(false);
  });
});

// -------------------------------------------------------------- grouping

describe('computeGrouping', () => {
  const cwds = cwdMap({
    A: '/code/api/src',
    B: '/code/web',
    C: '/elsewhere',
    D: undefined,
  });

  it('renders every project, sessions or not, sorted by name', () => {
    const result = grouping({
      visibleRootIds: ['A'],
      cwdOf: cwds,
      projects: [
        project('p2', 'Zeta', '/zeta'),
        project('p1', 'Api', '/code/api'),
      ],
    });
    expect(result.projects.map((p) => p.label)).toEqual(['Api', 'Zeta']);
    expect(result.projects[0].rootIds).toEqual(['A']);
    expect(result.projects[1].rootIds).toEqual([]);
  });

  it('exposes the directory list with the main one first', () => {
    const result = grouping({
      projects: [project('p1', 'Api', '/code/api', { dirs: ['/shared'] })],
    });
    expect(result.projects[0].dirs).toEqual(['/code/api', '/shared']);
    expect(result.projects[0].rootDir).toBe('/code/api');
    expect(result.projects[0].provider).toBe('claude');
  });

  it('drops a hidden project and everything it claims', () => {
    const result = grouping({
      visibleRootIds: ['A', 'C'],
      cwdOf: cwds,
      projects: [project('p1', 'Api', '/code/api', { hidden: true })],
    });
    expect(result.projects).toHaveLength(0);
    // A is NOT promoted back into a folder row: hiding the project hides it.
    expect(result.folders).toHaveLength(0);
    expect(result.loose).toEqual(['C']);
    expect(result.hiddenCount).toBe(1);
  });

  it('lets a hidden inner project win over a visible outer one', () => {
    const result = grouping({
      visibleRootIds: ['A', 'B'],
      cwdOf: cwds,
      projects: [
        project('outer', 'Code', '/code'),
        project('inner', 'Api', '/code/api', { hidden: true }),
      ],
    });
    // A is in /code/api/src — the hidden project owns it, so it stays hidden
    // even though the visible /code project also covers that path.
    expect(result.projects.map((p) => p.label)).toEqual(['Code']);
    expect(result.projects[0].rootIds).toEqual(['B']);
    expect(result.hiddenCount).toBe(1);
  });

  it('groups whatever no project claims into folder rows', () => {
    const result = grouping({
      visibleRootIds: ['A', 'B', 'C'],
      cwdOf: cwds,
      projects: [project('p1', 'Api', '/code/api')],
    });
    expect(result.projects[0].rootIds).toEqual(['A']);
    expect(result.folders.map((f) => f.label)).toEqual(['elsewhere', 'web']);
    expect(result.loose).toEqual([]);
  });

  it('keeps a lone folder as a bare row when there is no project above it', () => {
    const result = grouping({
      visibleRootIds: ['B'],
      cwdOf: cwds,
      projects: [],
    });
    expect(result.folders).toEqual([]);
    expect(result.loose).toEqual(['B']);
  });

  it('promotes that same lone folder to a row once a project exists', () => {
    const result = grouping({
      visibleRootIds: ['A', 'B'],
      cwdOf: cwds,
      projects: [project('p1', 'Api', '/code/api')],
    });
    expect(result.folders.map((f) => f.label)).toEqual(['web']);
    expect(result.loose).toEqual([]);
  });

  it('files a session with no cwd under (no directory)', () => {
    const result = grouping({
      visibleRootIds: ['B', 'D'],
      cwdOf: cwds,
      projects: [],
    });
    expect(result.folders.map((f) => f.label)).toEqual([
      '(no directory)',
      'web',
    ]);
    // The label is cosmetic; the key is identity, and collapse state keys off
    // it — so it stays '(unknown)' across the rename.
    expect(result.folders[0]).toMatchObject({ key: '(unknown)', cwd: '' });
  });

  it('leaves everything ungrouped when groupByFolder is off', () => {
    const result = grouping({
      visibleRootIds: ['B', 'C'],
      cwdOf: cwds,
      groupByFolder: false,
    });
    expect(result.folders).toEqual([]);
    expect(result.loose).toEqual(['B', 'C']);
  });

  it('removes a hidden folder and counts what it removed', () => {
    const result = grouping({
      visibleRootIds: ['B', 'C'],
      cwdOf: cwds,
      hiddenFolders: ['/elsewhere'],
    });
    expect(result.loose).toEqual(['B']);
    expect(result.hiddenCount).toBe(1);
  });

  it('lets an explicit project override a hidden parent folder', () => {
    // /code is hidden wholesale, but the user said /code/api IS a project —
    // the specific statement has to beat the blanket one.
    const result = grouping({
      visibleRootIds: ['A', 'B'],
      cwdOf: cwds,
      projects: [project('p1', 'Api', '/code/api')],
      hiddenFolders: ['/code'],
    });
    expect(result.projects[0].rootIds).toEqual(['A']);
    expect(result.folders).toEqual([]);
    expect(result.loose).toEqual([]);
    expect(result.hiddenCount).toBe(1); // only B
  });

  it('onlyProjectSessions drops the unclaimed rest', () => {
    const result = grouping({
      visibleRootIds: ['A', 'B', 'C'],
      cwdOf: cwds,
      projects: [project('p1', 'Api', '/code/api')],
      onlyProjectSessions: true,
    });
    expect(result.projects[0].rootIds).toEqual(['A']);
    expect(result.folders).toEqual([]);
    expect(result.loose).toEqual([]);
    expect(result.hiddenCount).toBe(2);
  });

  it('ignores onlyProjectSessions while no project exists', () => {
    // Otherwise the very first thing a new user sees is an empty tree.
    const result = grouping({
      visibleRootIds: ['A', 'B', 'C'],
      cwdOf: cwds,
      projects: [],
      onlyProjectSessions: true,
    });
    expect(result.folders).toHaveLength(3);
    expect(result.hiddenCount).toBe(0);
  });

  it('hands back the SAME row objects when nothing changed', () => {
    const input: GroupingInput = {
      visibleRootIds: ['A', 'B', 'C'],
      cwdOf: cwds,
      projects: [project('p1', 'Api', '/code/api')],
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
    };
    const first = computeGrouping(input);
    const second = computeGrouping(input, first);
    expect(second.projects[0]).toBe(first.projects[0]);
    expect(second.folders[0]).toBe(first.folders[0]);
  });

  it('replaces only the row whose content actually moved', () => {
    const input: GroupingInput = {
      visibleRootIds: ['A', 'B', 'C'],
      cwdOf: cwds,
      projects: [project('p1', 'Api', '/code/api')],
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
    };
    const first = computeGrouping(input);
    const second = computeGrouping(
      { ...input, projects: [project('p1', 'Renamed', '/code/api')] },
      first,
    );
    expect(second.projects[0]).not.toBe(first.projects[0]);
    expect(second.folders[0]).toBe(first.folders[0]);
  });

  it('never throws on a malformed project list', () => {
    const result = computeGrouping({
      visibleRootIds: ['A'],
      cwdOf: cwds,
      projects: [null as unknown as ProjectRecord],
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
    });
    expect(result.projects).toEqual([]);
    expect(result.loose).toEqual(['A']);
  });
});

// ----------------------------------------------------------- worktrees

// The scenario this whole feature exists for: one repository, three checkouts,
// one agent in each. Grouped by cwd alone these are three unrelated folder rows.
const APP_WORKTREES = [
  { dir: '/code/app', branch: 'main', head: 'aaa', detached: false },
  { dir: '/code/app-feat-x', branch: 'feat/x', head: 'bbb', detached: false },
  { dir: '/code/app-spike', branch: '', head: 'ccc', detached: true },
];

/** `worktreesOf` for a repo whose checkouts are all reachable from /code/app.
 *  Mirrors git: the same list comes back from ANY checkout of the repo. */
function appWorktrees(dir: string) {
  const inRepo = APP_WORKTREES.some((w) => isWithin(w.dir, dir));
  return inRepo ? APP_WORKTREES : [];
}

describe('computeGrouping: worktrees', () => {
  const projects = [project('p1', 'App', '/code/app')];
  const cwds = cwdMap({
    A: '/code/app/src',
    B: '/code/app-feat-x',
    C: '/code/app-spike/deep/dir',
    D: '/somewhere/else',
  });

  it('claims a session in a sibling worktree for the project', () => {
    // The point of the feature. `/code/app-feat-x` is not under `/code/app` and
    // nobody added it to the project — it is only reachable because git says it
    // is a checkout of the same repository.
    const out = computeGrouping({
      visibleRootIds: ['A', 'B', 'C', 'D'],
      cwdOf: cwds,
      projects,
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
      worktreesOf: appWorktrees,
      branchRows: true,
    });
    expect(out.projects[0].rootIds).toEqual(['A', 'B', 'C']);
    // D is genuinely elsewhere and still falls through to a folder row.
    expect(out.folders.map((f) => f.cwd)).toEqual(['/somewhere/else']);
  });

  it('leaves those sessions as loose folder rows without worktree data', () => {
    // What a non-git project and a probe-that-has-not-landed-yet both get.
    const out = computeGrouping({
      visibleRootIds: ['A', 'B', 'C'],
      cwdOf: cwds,
      projects,
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
    });
    expect(out.projects[0].rootIds).toEqual(['A']);
    expect(out.folders).toHaveLength(2);
    expect(out.projects[0].branches).toEqual([]);
  });

  it('builds one chip per worktree, main first then alphabetical', () => {
    const out = computeGrouping({
      visibleRootIds: ['A', 'B', 'C'],
      cwdOf: cwds,
      projects,
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
      worktreesOf: appWorktrees,
      branchRows: true,
    });
    const branches = out.projects[0].branches ?? [];
    // '(detached)' sorts before 'feat/x'; `main` holds position 0 regardless
    // because git listed it first.
    expect(branches.map((b) => b.name)).toEqual(['main', '(detached)', 'feat/x']);
    expect(branches.map((b) => b.colorIndex)).toEqual([0, 1, 2]);
    expect(branches.map((b) => b.primary)).toEqual([true, false, false]);
  });

  it('files each session under the worktree containing its cwd', () => {
    const out = computeGrouping({
      visibleRootIds: ['A', 'B', 'C'],
      cwdOf: cwds,
      projects,
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
      worktreesOf: appWorktrees,
      branchRows: true,
    });
    const byName = new Map(
      (out.projects[0].branches ?? []).map((b) => [b.name, b.rootIds]),
    );
    expect(byName.get('main')).toEqual(['A']);
    expect(byName.get('feat/x')).toEqual(['B']);
    // A cwd deep inside a worktree still resolves to it.
    expect(byName.get('(detached)')).toEqual(['C']);
  });

  it('gives a worktree with no sessions a chip anyway', () => {
    // You make a worktree and THEN start a session in it, so the chip has to
    // exist before the session does — otherwise the click that creates it has
    // nowhere to live.
    const out = computeGrouping({
      visibleRootIds: [],
      cwdOf: () => undefined,
      projects,
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
      worktreesOf: appWorktrees,
      branchRows: true,
    });
    const branches = out.projects[0].branches ?? [];
    expect(branches).toHaveLength(3);
    expect(branches.every((b) => b.rootIds.length === 0)).toBe(true);
  });

  it('prefers the deepest worktree when one is nested inside another', () => {
    const nested = [
      { dir: '/code/app', branch: 'main', head: 'a', detached: false },
      { dir: '/code/app/.worktrees/x', branch: 'feat/x', head: 'b', detached: false },
    ];
    const out = computeGrouping({
      visibleRootIds: ['N'],
      cwdOf: cwdMap({ N: '/code/app/.worktrees/x/src' }),
      projects,
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
      worktreesOf: () => nested,
      branchRows: true,
    });
    const byName = new Map(
      (out.projects[0].branches ?? []).map((b) => [b.name, b.rootIds]),
    );
    // Longest match wins, exactly as project membership does. The containing
    // checkout must not swallow a session that belongs to the nested one.
    expect(byName.get('feat/x')).toEqual(['N']);
    expect(byName.get('main')).toEqual([]);
  });

  it('dedupes a repo reached through two of a project multi-directory list', () => {
    const spanning = [project('p1', 'App', '/code/app', { dirs: ['/code/app-feat-x'] })];
    const out = computeGrouping({
      visibleRootIds: [],
      cwdOf: () => undefined,
      projects: spanning,
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
      worktreesOf: appWorktrees,
      branchRows: true,
    });
    // Both directories are checkouts of the same repo and each reports all
    // three worktrees. `main` twice on the chip row would be worse than no row.
    expect(out.projects[0].branches).toHaveLength(3);
  });

  it('survives a worktreesOf that throws', () => {
    const out = computeGrouping({
      visibleRootIds: ['A'],
      cwdOf: cwds,
      projects,
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
      worktreesOf: () => {
        throw new Error('git exploded');
      },
      // With the block ON, so the empty result below is the probe failing
      // rather than the gate being shut.
      branchRows: true,
    });
    // Degrades to a tree with no branch rows rather than taking the sidebar down.
    expect(out.projects[0].branches).toEqual([]);
    expect(out.projects[0].rootIds).toEqual(['A']);
  });

  it('reuses the project object when the branches are unchanged', () => {
    const input: GroupingInput = {
      visibleRootIds: ['A', 'B'],
      cwdOf: cwds,
      projects,
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
      worktreesOf: appWorktrees,
      branchRows: true,
    };
    const first = computeGrouping(input);
    const second = computeGrouping(input, first);
    // Identity reuse is what stops every poll tick from collapsing the tree.
    expect(second.projects[0]).toBe(first.projects[0]);
  });

  it('produces a fresh project object when a worktree appears', () => {
    const base: GroupingInput = {
      visibleRootIds: ['A'],
      cwdOf: cwds,
      projects,
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
      worktreesOf: () => APP_WORKTREES.slice(0, 1),
      branchRows: true,
    };
    const first = computeGrouping(base);
    const second = computeGrouping({ ...base, worktreesOf: appWorktrees }, first);
    expect(second.projects[0]).not.toBe(first.projects[0]);
    expect(second.projects[0].branches).toHaveLength(3);
  });
});

// ------------------------------------------------------------ the branch gate

describe('computeGrouping: branchRows, the branch block’s switch', () => {
  const projects = [project('p1', 'App', '/code/app')];
  const worktrees = [
    { dir: '/code/app', branch: 'main', head: 'a', detached: false },
    { dir: '/code/app-feat-x', branch: 'feat/x', head: 'b', detached: false },
  ];
  const cwds = cwdMap({ A: '/code/app/src', B: '/code/app-feat-x' });

  const group = (over: Partial<GroupingInput>) =>
    computeGrouping({
      visibleRootIds: ['A', 'B'],
      cwdOf: cwds,
      projects,
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
      worktreesOf: () => worktrees,
      ...over,
    });

  it('is OFF when absent — the shipped default', () => {
    expect(group({}).projects[0].branches).toEqual([]);
  });

  it('is off when explicitly false', () => {
    expect(group({ branchRows: false }).projects[0].branches).toEqual([]);
  });

  it('draws the block when on', () => {
    expect(group({ branchRows: true }).projects[0].branches).toHaveLength(2);
  });

  it('DOES NOT move a session out of its project when off', () => {
    // The whole point of gating the rows rather than the probe. `/code/app-feat-x`
    // is a linked worktree nobody added to the project, so without
    // worktree-derived membership session B would fall out to a folder row —
    // which would make turning a view option off a way to lose a session.
    const off = group({ branchRows: false });
    expect(off.projects[0].rootIds).toEqual(['A', 'B']);
    expect(off.folders).toEqual([]);
    const on = group({ branchRows: true });
    expect(on.projects[0].rootIds).toEqual(off.projects[0].rootIds);
  });

  it('repaints the project row when the switch flips', () => {
    // In the reuse comparison, or flipping the setting would leave the previous
    // object — and its branch rows — on screen until something else changed.
    const base: GroupingInput = {
      visibleRootIds: ['A'],
      cwdOf: cwds,
      projects,
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
      worktreesOf: () => worktrees,
      branchRows: true,
    };
    const first = computeGrouping(base);
    const second = computeGrouping({ ...base, branchRows: false }, first);
    expect(second.projects[0]).not.toBe(first.projects[0]);
    expect(second.projects[0].branches).toEqual([]);
  });
});

// --------------------------------------------------------------- subprojects

describe('parentDir', () => {
  it('answers the directory above', () => {
    expect(parentDir('/code/app/api')).toBe('/code/app');
    expect(parentDir('/code')).toBe('/');
  });

  it('has nothing above a root or a nothing', () => {
    expect(parentDir('/')).toBe('');
    expect(parentDir('')).toBe('');
  });
});

describe('subprojectLabels', () => {
  it('uses the basename when that is unambiguous', () => {
    expect(subprojectLabels(['/code/app', '/code/infra'])).toEqual([
      'app',
      'infra',
    ]);
  });

  it('prepends the parent when two basenames collide', () => {
    // The monorepo case, and the reason this function exists: two rows both
    // reading `src` is a tree you cannot use.
    expect(subprojectLabels(['/code/api/src', '/code/web/src'])).toEqual([
      'api/src',
      'web/src',
    ]);
  });

  it('collides case-insensitively, matching pathKey', () => {
    expect(subprojectLabels(['/code/api/Src', '/code/web/src'])).toEqual([
      'api/Src',
      'web/src',
    ]);
  });

  it('leaves an unambiguous sibling alone while disambiguating the pair', () => {
    expect(
      subprojectLabels(['/code/app', '/code/api/src', '/code/web/src']),
    ).toEqual(['app', 'api/src', 'web/src']);
  });

  it('falls back to the whole path when the parent does not help either', () => {
    // `a/src` twice: the two-component form still collides, so the only honest
    // label left is the address itself.
    expect(subprojectLabels(['/one/a/src', '/two/a/src'])).toEqual([
      '/one/a/src',
      '/two/a/src',
    ]);
  });
});

describe('buildSubprojects', () => {
  const cwds = cwdMap({
    A: '/code/app/lib',
    B: '/code/app/api/handlers',
    C: '/code/app-feat-x/src',
    D: undefined,
  });

  it('emits nothing for a project with one directory', () => {
    // Every project anybody has ever made. A single row restating the project's
    // own address would cost a row per project forever to say nothing.
    const p = project('p1', 'App', '/code/app');
    expect(
      buildSubprojects({ project: p, rootIds: ['A'], cwdOf: cwds }),
    ).toEqual([]);
    expect(SUBPROJECT_MIN).toBe(2);
  });

  it('emits one row per directory once there are two, main first', () => {
    const p = project('p1', 'App', '/code/app', { dirs: ['/code/app/api'] });
    const out = buildSubprojects({ project: p, rootIds: [], cwdOf: cwds });
    expect(out.map((s) => s.dir)).toEqual(['/code/app', '/code/app/api']);
    expect(out.map((s) => s.label)).toEqual(['app', 'api']);
    expect(out.map((s) => s.main)).toEqual([true, false]);
    expect(out.map((s) => s.dirKey)).toEqual(['/code/app', '/code/app/api']);
  });

  it('files each session under the LONGEST matching directory', () => {
    // The rule that makes the v6 migration invisible: a subproject that used to
    // be its own record at /code/app/api becomes a directory at /code/app/api,
    // and its sessions land in the same place on screen.
    const p = project('p1', 'App', '/code/app', { dirs: ['/code/app/api'] });
    const out = buildSubprojects({ project: p, rootIds: ['A', 'B'], cwdOf: cwds });
    expect(out[0].rootIds).toEqual(['A']);
    expect(out[1].rootIds).toEqual(['B']);
  });

  it('sends a session no directory claims to the MAIN one', () => {
    // C runs in a linked git worktree the project does not list; matchProject
    // gave it to this project anyway. Dropping it would make adding a second
    // directory a way to lose a row.
    const p = project('p1', 'App', '/code/app', { dirs: ['/code/app/api'] });
    const out = buildSubprojects({ project: p, rootIds: ['C', 'D'], cwdOf: cwds });
    expect(out[0].rootIds).toEqual(['C', 'D']);
    expect(out[1].rootIds).toEqual([]);
  });

  it('keeps every session, whatever the directories say', () => {
    const p = project('p1', 'App', '/code/app', {
      dirs: ['/code/app/api', '/code/other'],
    });
    const out = buildSubprojects({
      project: p,
      rootIds: ['A', 'B', 'C', 'D'],
      cwdOf: cwds,
    });
    const filed = out.flatMap((s) => s.rootIds).sort();
    expect(filed).toEqual(['A', 'B', 'C', 'D']);
  });

  it('survives a cwdOf that throws by filing under main', () => {
    const p = project('p1', 'App', '/code/app', { dirs: ['/code/app/api'] });
    const out = buildSubprojects({
      project: p,
      rootIds: ['A'],
      cwdOf: () => {
        throw new Error('forest changed');
      },
    });
    expect(out[0].rootIds).toEqual(['A']);
  });
});

describe('computeGrouping: subprojects', () => {
  const cwds = cwdMap({ A: '/code/app/lib', B: '/code/app/api/x' });

  it('attaches nothing to a single-directory project', () => {
    const out = computeGrouping({
      visibleRootIds: ['A'],
      cwdOf: cwds,
      projects: [project('p1', 'App', '/code/app')],
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
    });
    expect(out.projects[0].subprojects).toEqual([]);
    expect(out.projects[0].rootIds).toEqual(['A']);
  });

  it('splits a two-directory project, keeping rootIds whole', () => {
    const out = computeGrouping({
      visibleRootIds: ['A', 'B'],
      cwdOf: cwds,
      projects: [
        project('p1', 'App', '/code/app', { dirs: ['/code/app/api'] }),
      ],
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
    });
    // `rootIds` still names every session in the project — the split is a
    // rendering decision, and the roll-up that lights the project's dot reads
    // this list.
    expect(out.projects[0].rootIds).toEqual(['A', 'B']);
    expect(out.projects[0].subprojects?.map((s) => s.rootIds)).toEqual([
      ['A'],
      ['B'],
    ]);
  });

  it('repaints the row when a session moves between directories', () => {
    const base: GroupingInput = {
      visibleRootIds: ['A', 'B'],
      cwdOf: cwds,
      projects: [
        project('p1', 'App', '/code/app', { dirs: ['/code/app/api'] }),
      ],
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
    };
    const first = computeGrouping(base);
    const same = computeGrouping(base, first);
    expect(same.projects[0]).toBe(first.projects[0]);
    // B's cwd moves out of api and into the main directory: same project, same
    // rootIds, different rows — so the object has to be fresh.
    const moved = computeGrouping(
      { ...base, cwdOf: cwdMap({ A: '/code/app/lib', B: '/code/app/lib2' }) },
      first,
    );
    expect(moved.projects[0]).not.toBe(first.projects[0]);
    expect(moved.projects[0].subprojects?.map((s) => s.rootIds)).toEqual([
      ['A', 'B'],
      [],
    ]);
  });
});

describe('flattenNestedProjects: the v6 migration rules', () => {
  it('leaves a flat set of projects alone', () => {
    const out = flattenNestedProjects([
      project('a', 'A', '/code/a'),
      project('b', 'B', '/code/b'),
    ]);
    expect(out).toEqual({ merged: [], removed: [] });
  });

  it('folds a child’s directory into its parent and tombstones the child', () => {
    const out = flattenNestedProjects([
      project('p', 'App', '/code/app'),
      project('c', 'Api', '/code/app/api', { parentId: 'p' }),
    ]);
    expect(out.merged).toEqual([
      { id: 'p', rootDir: '/code/app', dirs: ['/code/app/api'] },
    ]);
    expect(out.removed).toEqual(['c']);
  });

  it('never moves the parent’s main directory', () => {
    // Every project-level verb starts at rootDir, so a migration that re-pointed
    // it would change where `+` starts a session.
    const out = flattenNestedProjects([
      project('p', 'App', '/code/app', { dirs: ['/code/app/extra'] }),
      project('c', 'Api', '/code/aaa', { parentId: 'p' }),
    ]);
    expect(out.merged[0].rootDir).toBe('/code/app');
    expect(out.merged[0].dirs).toEqual(['/code/app/extra', '/code/aaa']);
  });

  it('collapses a whole chain into the top-level ancestor', () => {
    const out = flattenNestedProjects([
      project('a', 'A', '/code/a'),
      project('b', 'B', '/code/a/b', { parentId: 'a' }),
      project('c', 'C', '/code/a/b/c', { parentId: 'b' }),
    ]);
    expect(out.merged).toEqual([
      { id: 'a', rootDir: '/code/a', dirs: ['/code/a/b', '/code/a/b/c'] },
    ]);
    expect(out.removed.sort()).toEqual(['b', 'c']);
  });

  it('dedupes a directory a parent and child both listed', () => {
    // The old model tolerated this (the deeper record won the tie); the new one
    // has no room for it.
    const out = flattenNestedProjects([
      project('p', 'App', '/code/app'),
      project('c', 'Also', '/code/app', { parentId: 'p' }),
    ]);
    expect(out.merged).toEqual([
      { id: 'p', rootDir: '/code/app', dirs: [] },
    ]);
    expect(out.removed).toEqual(['c']);
  });

  it('folds a CLOSED child in too — its directories become the parent’s', () => {
    // The child's closed-ness does not survive, which is the cost of the model
    // change. state.migrateV5ToV6 logs it per project for exactly that reason.
    const out = flattenNestedProjects([
      project('p', 'App', '/code/app'),
      project('c', 'Api', '/code/app/api', { parentId: 'p', hidden: true }),
    ]);
    expect(out.merged[0].dirs).toEqual(['/code/app/api']);
    expect(out.removed).toEqual(['c']);
  });

  it('ignores tombstones', () => {
    const out = flattenNestedProjects([
      project('p', 'App', '/code/app'),
      { ...project('c', '', ''), deleted: true, parentId: 'p' },
    ]);
    expect(out).toEqual({ merged: [], removed: [] });
  });

  it('is idempotent: a second pass over its own output changes nothing', () => {
    const before = [
      project('p', 'App', '/code/app'),
      project('c', 'Api', '/code/app/api', { parentId: 'p' }),
    ];
    const first = flattenNestedProjects(before);
    const after = [
      project('p', 'App', first.merged[0].rootDir, {
        dirs: first.merged[0].dirs,
      }),
    ];
    expect(flattenNestedProjects(after)).toEqual({ merged: [], removed: [] });
  });

  it('re-roots a child whose parent is gone rather than merging it anywhere', () => {
    // buildProjectTree already treats an unknown parentId as top-level, and a
    // migration must not invent a merge target for it.
    const out = flattenNestedProjects([
      project('c', 'Api', '/code/app/api', { parentId: 'nope' }),
    ]);
    expect(out).toEqual({ merged: [], removed: [] });
  });
});

describe('branch visibility', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      dir: `/code/w${i}`,
      branch: i === 0 ? 'main' : `feat/${i}`,
      head: 'x',
      detached: false,
    }));

  it('shows every branch while the list is short enough to read', () => {
    // Below the threshold there is nothing to curate: hiding two of three
    // branches to save two rows is a puzzle, not a tidy-up.
    const branches = buildBranches(many(BRANCH_AUTOSHOW_LIMIT), [], () => undefined);
    expect(branches.every((b) => b.shown)).toBe(true);
  });

  it('folds most of a long list away, keeping main', () => {
    const branches = buildBranches(many(12), [], () => undefined);
    expect(branches.filter((b) => b.shown).map((b) => b.name)).toEqual(['main']);
  });

  it('always surfaces a branch something is running on', () => {
    // A live agent whose row you cannot see is the worst outcome this feature
    // could produce, so an active branch shows even in a repo with fifty.
    const branches = buildBranches(many(12), ['S'], () => '/code/w7');
    expect(branches.filter((b) => b.shown).map((b) => b.name).sort()).toEqual([
      'feat/7',
      'main',
    ]);
  });

  it('lets an explicit show beat the policy', () => {
    const p = project('p1', 'App', '/code/w0', { shownBranches: ['feat/9'] });
    const branches = buildBranches(many(12), [], () => undefined, p);
    expect(branches.find((b) => b.name === 'feat/9')?.shown).toBe(true);
  });

  it('lets an explicit hide beat the policy, even for a busy branch', () => {
    // The reason ProjectRecord keeps TWO lists: with one, "I hid this" and "the
    // policy has not picked it yet" would be the same state, and a branch you
    // hid would come back the moment somebody started a session on it.
    const p = project('p1', 'App', '/code/w0', { hiddenBranches: ['feat/7'] });
    const branches = buildBranches(many(12), ['S'], () => '/code/w7', p);
    expect(branches.find((b) => b.name === 'feat/7')?.shown).toBe(false);
  });

  it('lets an explicit hide beat the short-list default too', () => {
    const p = project('p1', 'App', '/code/w0', { hiddenBranches: ['feat/1'] });
    const branches = buildBranches(many(3), [], () => undefined, p);
    expect(branches.find((b) => b.name === 'feat/1')?.shown).toBe(false);
    expect(branches.find((b) => b.name === 'main')?.shown).toBe(true);
  });

  it('keeps main visible under the default policy whatever else happens', () => {
    expect(
      defaultBranchVisibility({ primary: true, rootIds: [] }, 50),
    ).toBe(true);
    expect(
      defaultBranchVisibility({ primary: false, rootIds: [] }, 50),
    ).toBe(false);
  });

  it('re-derives visibility every render rather than remembering it', () => {
    // Not a memory: a branch that goes quiet drops back out of the default set,
    // which is exactly why shownBranches exists for the ones you want kept.
    const busy = buildBranches(many(12), ['S'], () => '/code/w3');
    expect(busy.find((b) => b.name === 'feat/3')?.shown).toBe(true);
    const quiet = buildBranches(many(12), [], () => undefined);
    expect(quiet.find((b) => b.name === 'feat/3')?.shown).toBe(false);
  });
});

// ------------------------------------------------------------ chat history

describe('chatsForProject', () => {
  const chat = (
    id: string,
    cwd: string | undefined,
    over: Partial<EditorialRecord> = {},
  ): EditorialRecord => ({
    id,
    chat: true,
    cwd,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  const API = project('p1', 'API', '/code/api');
  const WEB = project('p2', 'Web', '/code/web');

  it('claims the chats whose cwd the project owns, and no others', () => {
    const records = {
      a: chat('a', '/code/api'),
      b: chat('b', '/code/api/src'),
      c: chat('c', '/code/web'),
      d: chat('d', '/somewhere/else'),
    };
    expect(
      chatsForProject(records, [API, WEB], 'p1').map((r) => r.id).sort(),
    ).toEqual(['a', 'b']);
  });

  it('is not fooled by a session that merely runs in the same directory', () => {
    const records = {
      a: chat('a', '/code/api'),
      s: chat('s', '/code/api', { chat: false }),
    };
    expect(chatsForProject(records, [API], 'p1').map((r) => r.id)).toEqual(['a']);
  });

  it('skips a deleted record and a record with no cwd at all', () => {
    const records = {
      a: chat('a', '/code/api'),
      gone: chat('gone', '/code/api', { deleted: true }),
      nowhere: chat('nowhere', undefined),
    };
    expect(chatsForProject(records, [API], 'p1').map((r) => r.id)).toEqual(['a']);
  });

  it('files a chat under the LONGEST matching project, like every session', () => {
    // The nested project owns its own subtree even though the outer one
    // contains it — the same rule matchProject applies to sessions.
    const outer = project('p1', 'Code', '/code');
    const inner = project('p2', 'API', '/code/api');
    const records = { a: chat('a', '/code/api/src') };
    expect(chatsForProject(records, [outer, inner], 'p2')).toHaveLength(1);
    expect(chatsForProject(records, [outer, inner], 'p1')).toHaveLength(0);
  });

  it('answers for a CLOSED project too — closing hides rows, not history', () => {
    const closed = project('p1', 'API', '/code/api', { hidden: true });
    const records = { a: chat('a', '/code/api') };
    expect(chatsForProject(records, [closed], 'p1')).toHaveLength(1);
  });

  it('orders newest first, and breaks ties on id so a repaint cannot shuffle', () => {
    const records = {
      old: chat('old', '/code/api', { createdAt: '2026-01-01T00:00:00.000Z' }),
      new: chat('new', '/code/api', { createdAt: '2026-03-01T00:00:00.000Z' }),
      tie: chat('tie', '/code/api', { createdAt: '2026-03-01T00:00:00.000Z' }),
    };
    expect(chatsForProject(records, [API], 'p1').map((r) => r.id)).toEqual([
      'new',
      'tie',
      'old',
    ]);
  });

  it('survives an empty store', () => {
    expect(chatsForProject(undefined, [API], 'p1')).toEqual([]);
    expect(chatsForProject({}, [], 'p1')).toEqual([]);
  });
});
