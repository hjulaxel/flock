// test/projects.test.ts — the project model: path rules, cwd -> project
// matching, and the grouping pass that produces the top level of the tree.
//
// src/projects.ts imports nothing but ./types, so none of this needs the
// vscode mock.

import { describe, expect, it } from 'vitest';

import {
  archivedForProject,
  baseName,
  buildBranches,
  buildSubprojects,
  chatsForProject,
  closedProjectIds,
  computeGrouping,
  defaultBranchVisibility,
  flattenNestedProjects,
  parentDir,
  BRANCH_AUTOSHOW_LIMIT,
  HIDDEN_RUNNING_GROUP_KEY,
  isHiddenFolder,
  isWithin,
  matchProject,
  matchProjects,
  normalizeDir,
  pathKey,
  pathKeyFor,
  PATHS_FOLD_CASE,
  preferredClaimant,
  projectClaiming,
  projectDirs,
  projectReach,
  providerOfProject,
  subprojectLabels,
  SUBPROJECT_MIN,
  validateProjectName,
} from '../src/projects';
import type { GroupingInput } from '../src/projects';
import type { EditorialRecord, ProjectRecord, Worktree } from '../src/types';

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

  it('folds case exactly where the platform does', () => {
    // Both answers, on whatever OS this runs on: the decision is a platform
    // fact and the function that takes it is what makes the fact testable.
    expect(pathKeyFor('/Users/X/Code', true)).toBe('/users/x/code');
    expect(pathKeyFor('/Users/X/Code', false)).toBe('/Users/X/Code');
    expect(pathKeyFor('C:\\Users\\X\\Code\\', true)).toBe('c:/users/x/code');
    // And the platform's own answer is one of the two, chosen by the constant.
    expect(PATHS_FOLD_CASE).toBe(process.platform === 'darwin' || process.platform === 'win32');
    expect(pathKey('/Users/X/Code')).toBe(pathKeyFor('/Users/X/Code', PATHS_FOLD_CASE));
  });

  it.runIf(PATHS_FOLD_CASE)('compares case-insensitively on macOS and Windows', () => {
    expect(isWithin('/Users/x/Code', '/users/x/code/api')).toBe(true);
    expect(pathKey('/Users/X/Code')).toBe('/users/x/code');
  });

  it.runIf(!PATHS_FOLD_CASE)('keeps two directories that differ only in case apart on Linux', () => {
    expect(isWithin('/home/x/Code', '/home/x/code/api')).toBe(false);
    expect(pathKey('/home/x/Code')).toBe('/home/x/Code');
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
      dirs: ['/code/shared/', '/code/api', PATHS_FOLD_CASE ? '/CODE/SHARED' : '/code//shared'],
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

describe('projectReach: worktree membership, asked the same way everywhere', () => {
  const app = project('app', 'App', '/code/app');
  const probe = (dir: string): Worktree[] =>
    dir === '/code/app'
      ? [
          { dir: '/code/app', branch: 'main', head: 'a', detached: false },
          { dir: '/code/app-feat-x', branch: 'feat/x', head: 'b', detached: false },
        ]
      : [];

  it('hands a project every checkout of the repositories its directories sit in', () => {
    const reach = projectReach(probe);
    expect(reach(app)).toEqual(['/code/app', '/code/app-feat-x']);
  });

  it('makes a session in a LINKED checkout belong to the project', () => {
    // The whole point: nobody registers `~/code/app-feat-x`, worktrees come and
    // go several times a day, and every surface has to agree that a session
    // running there is this project's.
    const reach = projectReach(probe);
    expect(matchProject([app], '/code/app-feat-x/src', reach)?.project.id).toBe(
      'app',
    );
    // Derived, not own — which is what keeps it losing to an explicit claim.
    expect(matchProject([app], '/code/app-feat-x', reach)?.own).toBe(false);
    // ...and without the resolver there is no match at all, which is exactly
    // what every non-grouping caller used to get.
    expect(matchProject([app], '/code/app-feat-x/src')).toBeNull();
  });

  it('memoizes per project for the life of the resolver', () => {
    let calls = 0;
    const counted = (dir: string): Worktree[] => {
      calls += 1;
      return probe(dir);
    };
    const reach = projectReach(counted);
    reach(app);
    reach(app);
    expect(calls).toBe(1);
    // A FRESH resolver probes again — the memo must not outlive the tick that
    // built it, or a removed worktree keeps answering.
    projectReach(counted)(app);
    expect(calls).toBe(2);
  });

  it('answers empty for no probe, and survives one that throws', () => {
    expect(projectReach(undefined)(app)).toEqual([]);
    expect(
      projectReach(() => {
        throw new Error('git missing');
      })(app),
    ).toEqual([]);
  });
});

// Claims are NON-EXCLUSIVE (design/levels-and-modes.md): a directory listed by
// two projects belongs to both for grouping. Depth stays singular — nesting is
// still nesting — and derived (worktree) claims stay singular too.
describe('matchProjects: non-exclusive claims', () => {
  const alpha = project('id-b', 'Alpha', '/shared');
  const beta = project('id-a', 'Beta', '/shared');
  const outer = project('outer', 'Code', '/code');
  const inner = project('inner', 'API', '/code/api');

  it('maps a twice-claimed directory to BOTH projects, best first', () => {
    const got = matchProjects([beta, alpha], '/shared/x');
    expect(got.map((m) => m.project.id)).toEqual(['id-b', 'id-a']);
    // Input order must not matter — the answer is stable across ticks.
    expect(
      matchProjects([alpha, beta], '/shared/x').map((m) => m.project.id),
    ).toEqual(['id-b', 'id-a']);
  });

  it('keeps [0] exactly the single-winner answer', () => {
    for (const cwd of ['/shared/x', '/code/api/src', '/code/web', '/nowhere']) {
      const plural = matchProjects([alpha, beta, outer, inner], cwd);
      const single = matchProject([alpha, beta, outer, inner], cwd);
      expect(plural[0] ?? null).toEqual(single);
    }
  });

  it('still lets the deeper claim win outright — nesting is not sharing', () => {
    const got = matchProjects([outer, inner], '/code/api/src');
    expect(got.map((m) => m.project.id)).toEqual(['inner']);
  });

  it('counts a project once however many of its directories match', () => {
    const both = project('both', 'Both', '/shared', { dirs: ['/shared'] });
    const got = matchProjects([both, alpha], '/shared/x');
    // Once each; ordered by the name tie-break (Alpha before Both).
    expect(got.map((m) => m.project.id)).toEqual(['id-b', 'both']);
  });

  it('never puts a derived claim beside an own one at equal depth', () => {
    // `lister` states /code/app-feat-x; `owner` merely reaches it as a worktree
    // of the repo at /code/app. A statement outranks an inference — the
    // inference is not co-owner, it LOST.
    const owner = project('owner', 'App', '/code/app');
    const lister = project('lister', 'Feature', '/code/app-feat-x');
    const worktrees = (p: ProjectRecord): readonly string[] =>
      p.id === 'owner' ? ['/code/app-feat-x'] : [];
    const got = matchProjects([owner, lister], '/code/app-feat-x/src', worktrees);
    expect(got.map((m) => m.project.id)).toEqual(['lister']);
  });

  it('keeps an all-derived tie SINGULAR — a worktree has one owner', () => {
    const repo = project('repo', 'App', '/code/app');
    const sub = project('sub', 'Api', '/code/app/api');
    const worktrees = (): readonly string[] => ['/code/app-feat-x'];
    const got = matchProjects([sub, repo], '/code/app-feat-x/src', worktrees);
    // ONE winner, and exactly the single-winner matcher's — the old tie-break
    // survives whole for inferences.
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual(
      matchProject([sub, repo], '/code/app-feat-x/src', worktrees),
    );
  });

  it('answers [] for an unknown or missing cwd', () => {
    expect(matchProjects([outer], '/elsewhere')).toEqual([]);
    expect(matchProjects([outer], undefined)).toEqual([]);
    expect(matchProjects([], '/code')).toEqual([]);
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

// Non-exclusive claims in the grouping pass, and folder mode's scope fence.
describe('computeGrouping: shared claims and folder scope', () => {
  const cwds = cwdMap({
    A: '/shared/x',
    B: '/code/web',
    C: '/elsewhere/deep',
    D: undefined,
  });

  it('renders a twice-claimed session under BOTH projects', () => {
    const result = grouping({
      visibleRootIds: ['A'],
      cwdOf: cwds,
      projects: [
        project('p1', 'Alpha', '/shared'),
        project('p2', 'Beta', '/shared'),
      ],
    });
    expect(result.projects.map((p) => p.label)).toEqual(['Alpha', 'Beta']);
    expect(result.projects[0].rootIds).toEqual(['A']);
    expect(result.projects[1].rootIds).toEqual(['A']);
    expect(result.hiddenCount).toBe(0);
  });

  it('keeps the session while ANY claimant is open', () => {
    const result = grouping({
      visibleRootIds: ['A'],
      cwdOf: cwds,
      projects: [
        project('p1', 'Alpha', '/shared', { hidden: true }),
        project('p2', 'Beta', '/shared'),
      ],
    });
    // Closing one of two projects sharing a directory must not take the
    // other's rows with it.
    expect(result.projects.map((p) => p.label)).toEqual(['Beta']);
    expect(result.projects[0].rootIds).toEqual(['A']);
    expect(result.hiddenCount).toBe(0);
  });

  it('counts the session hidden ONCE when every claimant is closed', () => {
    const result = grouping({
      visibleRootIds: ['A'],
      cwdOf: cwds,
      projects: [
        project('p1', 'Alpha', '/shared', { hidden: true }),
        project('p2', 'Beta', '/shared', { hidden: true }),
      ],
    });
    expect(result.projects).toHaveLength(0);
    expect(result.hiddenCount).toBe(1);
    expect(result.loose).toEqual([]);
  });

  it('scopeDir drops sessions whose cwd is another folder, counted apart', () => {
    const result = grouping({
      visibleRootIds: ['A', 'B', 'C'],
      cwdOf: cwds,
      scopeDirs: ['/code'],
      projects: [project('p1', 'Web', '/code/web')],
    });
    // B is under /code and claimed; A and C live elsewhere — other windows'
    // work, so neither a bucket nor `hiddenCount` (nothing was HIDDEN).
    expect(result.projects[0].rootIds).toEqual(['B']);
    expect(result.folders).toEqual([]);
    expect(result.loose).toEqual([]);
    expect(result.outOfScopeCount).toBe(2);
    expect(result.hiddenCount).toBe(0);
  });

  it('keeps a session with NO cwd despite the scope — unplaceable is not foreign', () => {
    const result = grouping({
      visibleRootIds: ['D'],
      cwdOf: cwds,
      scopeDirs: ['/code'],
      projects: [],
    });
    expect(result.loose).toEqual(['D']);
    expect(result.outOfScopeCount).toBe(0);
  });

  it('scopes nothing when scopeDir is empty or absent', () => {
    const absent = grouping({ visibleRootIds: ['C'], cwdOf: cwds });
    const empty = grouping({ visibleRootIds: ['C'], cwdOf: cwds, scopeDirs: [] });
    expect(absent.loose).toEqual(['C']);
    expect(empty.loose).toEqual(['C']);
    expect(absent.outOfScopeCount).toBe(0);
    expect(empty.outOfScopeCount).toBe(0);
  });

  it('applies the fence before hidden-folder counting', () => {
    const result = grouping({
      visibleRootIds: ['C'],
      cwdOf: cwds,
      scopeDirs: ['/code'],
      hiddenFolders: ['/elsewhere'],
      projects: [],
    });
    // C is both out of scope AND under a hidden folder: the fence answers
    // first, so the user's hidden count stays a count of their own choices.
    expect(result.outOfScopeCount).toBe(1);
    expect(result.hiddenCount).toBe(0);
  });

  it('the fence is a UNION — a session under ANY opened folder is in scope', () => {
    // The multi-root shape the fence must survive: a converted explorer-follow
    // window (or a plain multi-root workspace) opened both folders, so work
    // under the second is exactly as much this window's as work under the
    // first. Fencing on folder[0] alone dropped it.
    const result = grouping({
      visibleRootIds: ['B', 'C'],
      cwdOf: cwds,
      scopeDirs: ['/code', '/elsewhere'],
      projects: [],
    });
    expect(result.folders.flatMap((g) => g.rootIds).sort()).toEqual([
      'B',
      'C',
    ]);
    expect(result.outOfScopeCount).toBe(0);
  });
});

describe('computeGrouping: the scope fence over PROJECT rows', () => {
  // Sessions were only half the leak. A project row renders even with no
  // sessions in it (that empty row is where "New Session in Project" lives),
  // so a folder-scoped window used to list every OTHER project on the machine
  // — each with a `+` the launch fence now refuses. An empty window showed the
  // whole roster and nothing runnable.
  it('drops projects with no directory in scope', () => {
    const result = grouping({
      visibleRootIds: [],
      cwdOf: cwdMap({}),
      scopeDirs: ['/code/app'],
      projects: [
        project('mine', 'Mine', '/code/app'),
        project('theirs', 'Theirs', '/code/other'),
        project('far', 'Far', '/somewhere/else'),
      ],
    });
    expect(result.projects.map((p) => p.label)).toEqual(['Mine']);
  });

  it('keeps a project whose directory sits INSIDE the scope', () => {
    // One of the two directions the fence has to accept: a window opened on
    // `/code` covers the project rooted at `/code/app/pkg`. The other
    // direction — a window opened on part of a project — is the real-shape
    // suite below, and it did not work when this test was written.
    const result = grouping({
      visibleRootIds: [],
      cwdOf: cwdMap({}),
      scopeDirs: ['/code/app'],
      projects: [project('inner', 'Inner', '/code/app/pkg')],
    });
    expect(result.projects.map((p) => p.label)).toEqual(['Inner']);
  });

  it('keeps an out-of-scope PARENT that is the only path to an in-scope child', () => {
    // Fencing the parent out would strand the child: a subproject row is only
    // reachable through its parent.
    const result = grouping({
      visibleRootIds: [],
      cwdOf: cwdMap({}),
      scopeDirs: ['/code/app'],
      projects: [
        project('parent', 'Parent', '/elsewhere/root'),
        { ...project('child', 'Child', '/code/app'), parentId: 'parent' },
      ],
    });
    expect(result.projects.map((p) => p.label).sort()).toEqual([
      'Child',
      'Parent',
    ]);
  });

  it('fences out a project with NO directories at all', () => {
    // The one place "unplaceable stays" does NOT apply, and the reason is the
    // asymmetry between a session and a project. An unknown session cwd means
    // a real conversation we failed to place, and stranding it loses work. A
    // project with no directory has nothing to strand: it can claim no session
    // in any window and its `+` has nowhere to launch.
    //
    // Found by running computeGrouping against a real state.json, which had
    // three nameless dirless projects that rendered as blank rows in every
    // window — a fixture would not have had them.
    const result = grouping({
      visibleRootIds: [],
      cwdOf: cwdMap({}),
      scopeDirs: ['/code/app'],
      projects: [
        project('real', 'Real', '/code/app'),
        { ...project('junk', '', '/x'), rootDir: '', dirs: [] },
      ],
    });
    expect(result.projects.map((p) => p.label)).toEqual(['Real']);
  });

  it('does not fence at all without a scope', () => {
    // Project mode and empty windows: the whole roster, dirless rows included,
    // exactly as before. The fence is folder mode's rule and nothing else's.
    const unscoped = grouping({
      visibleRootIds: [],
      cwdOf: cwdMap({}),
      projects: [
        project('a', 'A', '/code/app'),
        project('b', 'B', '/code/other'),
        { ...project('junk', '', '/x'), rootDir: '', dirs: [] },
      ],
    });
    expect(unscoped.projects).toHaveLength(3);
  });
});

// THE WINDOW OPENED ON PART OF A PROJECT — the shape folder mode is actually
// used in, and the one the project-row fence got wrong.
//
// The fixture is deliberately not synthetic. The directories are this
// repository's own: the project `lineage-sessions` as it appears in the shipped
// state.json (rootDir and nothing else), the dirless leftover record that same
// file really contains, a second real project to prove the fence still bites,
// and `git worktree list`'s actual answer here — six linked checkouts nested
// under `.claude/worktrees/` plus one sibling checkout beside the repository.
// Both worktree layouts matter, because the nested ones are inside the project
// root already and only the sibling proves the fence reads worktree reach.
describe('computeGrouping: a window opened on part of a project', () => {
  const REPO = '/Users/axelh/Documents/lineage-sessions';
  const NESTED_WT = `${REPO}/.claude/worktrees/donations`;
  const SIBLING_WT = '/Users/axelh/Documents/lineage-sessions-shared';
  const OTHER = '/Users/axelh/Documents/Magma/matteappen/magmachat';

  const worktrees: Worktree[] = [
    { dir: REPO, branch: 'axel/levels-and-modes', head: '4c2617e', detached: false },
    { dir: SIBLING_WT, branch: 'shared-directories', head: '1525ab1', detached: false },
    { dir: `${REPO}/.claude/worktrees/accounts-dispatch-handoff`, branch: 'accounts/dispatch-handoff', head: '79f6a41', detached: false },
    { dir: NESTED_WT, branch: 'donations', head: '8e50dbc', detached: false },
    { dir: `${REPO}/.claude/worktrees/qol-dots-shells`, branch: 'axel/qol-dots-shells', head: 'b396c60', detached: false },
    { dir: `${REPO}/.claude/worktrees/switch-account`, branch: 'switch-account', head: '22c870e', detached: false },
    { dir: `${REPO}/.claude/worktrees/team-tier`, branch: 'team-tier-groundwork', head: 'cb75663', detached: false },
    { dir: `${REPO}/.claude/worktrees/worktree-sessions`, branch: 'axel/worktree-sessions', head: '7ae2f36', detached: false },
  ];
  // What `git worktree list` does: asked from any checkout of the repository it
  // reports every checkout. Asked about an unrelated directory it reports
  // nothing, which is how the other project stays worktree-less here.
  const worktreesOf = (dir: string): readonly Worktree[] =>
    worktrees.some((w) => isWithin(w.dir, dir)) ? worktrees : [];

  const projects: ProjectRecord[] = [
    project('20917859-046e-44c3-a807-5deb3e12df99', 'lineage-sessions', REPO),
    project('051a604e-cba2-4699-8e87-d4ae04c96d18', 'discussions', OTHER, {
      dirs: [OTHER],
    }),
    { ...project('09d2ba51-0bde-40d2-85e8-b98be0b5eb3a', '', ''), dirs: [] },
  ];

  /** One running session at `cwd`, in a window whose only folder is `scope`. */
  const openedOn = (scope: string, cwd: string) =>
    grouping({
      visibleRootIds: ['s1'],
      cwdOf: () => cwd,
      projects,
      scopeDirs: [scope],
      worktreesOf,
      hasRunning: () => true,
    });

  /** Every bucket a row can come out of, including the appendix. */
  const rowsOf = (r: ReturnType<typeof openedOn>): string[] => [
    ...r.projects.flatMap((p) => p.rootIds),
    ...r.folders.flatMap((f) => f.rootIds),
    ...r.loose,
    ...(r.hiddenRunning?.rootIds ?? []),
  ];

  it('files the session under the project when the window is on the project root', () => {
    // The control: this always worked, and must go on working.
    const r = openedOn(REPO, `${REPO}/src`);
    expect(r.projects.map((p) => p.label)).toEqual(['lineage-sessions']);
    expect(r.projects[0].rootIds).toEqual(['s1']);
    expect(r.outOfScopeCount).toBe(0);
    expect(r.hiddenCount).toBe(0);
  });

  it('keeps the project row and its session when the window is on a SUBDIRECTORY', () => {
    // `src` is inside the project, so the project's directory CONTAINS the
    // scope. The one-way fence read only the other direction and dropped the
    // project row; with no bucket for it, the session loop then dropped the
    // session too — every bucket empty, every counter zero, and the running
    // badge still saying one.
    const r = openedOn(`${REPO}/src`, `${REPO}/src`);
    expect(r.projects.map((p) => p.label)).toEqual(['lineage-sessions']);
    expect(rowsOf(r)).toEqual(['s1']);
    expect(r.hiddenCount).toBe(0);
    expect(r.outOfScopeCount).toBe(0);
  });

  it('keeps the project row and its session on a worktree nested under the project', () => {
    const r = openedOn(NESTED_WT, NESTED_WT);
    expect(r.projects.map((p) => p.label)).toEqual(['lineage-sessions']);
    expect(rowsOf(r)).toEqual(['s1']);
    expect(r.hiddenCount).toBe(0);
    expect(r.outOfScopeCount).toBe(0);
  });

  it('keeps the project row and its session on a worktree OUTSIDE the project root', () => {
    // The sibling checkout: no containment either way between it and the
    // project's directory, so only the project's worktree reach can place it —
    // the same reach `matchProjects` uses to file the session, which is why the
    // two have to read one list.
    const r = openedOn(SIBLING_WT, `${SIBLING_WT}/src`);
    expect(r.projects.map((p) => p.label)).toEqual(['lineage-sessions']);
    expect(r.projects[0].rootIds).toEqual(['s1']);
    expect(rowsOf(r)).toEqual(['s1']);
    expect(r.hiddenCount).toBe(0);
    expect(r.outOfScopeCount).toBe(0);
  });

  it('draws the session loose for a directory no project owns, and no project rows', () => {
    // The fence still bites: none of the three projects touches this window,
    // so there is no roster and no `+` that the launch fence would refuse. The
    // session is this window's work all the same and gets its row — loose
    // rather than under a folder row, because one folder with nothing above it
    // is the "fewer than two folders is just noise" case.
    const scratch = '/Users/axelh/Documents/scratch';
    const r = openedOn(scratch, `${scratch}/notes`);
    expect(r.projects).toEqual([]);
    expect(r.loose).toEqual(['s1']);
    expect(r.hiddenCount).toBe(0);
    expect(r.outOfScopeCount).toBe(0);
  });

  it('never counts a running session it does not draw, whichever folder is open', () => {
    // The invariant behind all of the above, asserted over every folder a
    // window here could plausibly be opened on. A session whose cwd is inside
    // this window's own folder has a row in some bucket, and nothing that is
    // neither drawn nor counted exists — that state is what made the sidebar
    // look empty while the badge said one.
    const scopes = [
      REPO,
      `${REPO}/src`,
      `${REPO}/test`,
      SIBLING_WT,
      NESTED_WT,
      `${REPO}/.claude/worktrees/team-tier`,
      '/Users/axelh/Documents/scratch',
    ];
    for (const scope of scopes) {
      const r = openedOn(scope, `${scope}/deep/inside`);
      expect(rowsOf(r), `no row for a session in ${scope}`).toEqual(['s1']);
      expect(r.outOfScopeCount, `wrongly foreign in ${scope}`).toBe(0);
      expect(r.hiddenCount, `wrongly hidden in ${scope}`).toBe(0);
    }
  });
});

describe('computeGrouping: the "Still running" appendix', () => {
  const cwds = cwdMap({
    A: '/shared/x',
    C: '/elsewhere/deep',
  });

  it('drops an out-of-scope root whether it runs or not — the fence is a boundary', () => {
    // THE ONE DROP WITH NO RESCUE. Every filter below is a view preference and
    // may not hide a live process; the scope fence is a boundary, and folder
    // mode has no verb that can reach across it (the launch fence in
    // extension.ts refuses, the pickers never offer). A row here would be a
    // row you cannot act on, so there is no row.
    for (const running of [true, false]) {
      const result = grouping({
        visibleRootIds: ['C'],
        cwdOf: cwds,
        scopeDirs: ['/code'],
        projects: [],
        hasRunning: () => running,
      });
      expect(result.hiddenRunning).toBeNull();
      expect(result.outOfScopeCount).toBe(1);
    }
  });

  it('keeps the appendix for IN-SCOPE work only', () => {
    // A is under the scope AND hidden by its closed claimants: rescued. C is
    // out of scope: gone. Both running, and the difference is the fence.
    const result = grouping({
      visibleRootIds: ['A', 'C'],
      cwdOf: cwds,
      scopeDirs: ['/shared'],
      projects: [project('p1', 'Alpha', '/shared', { hidden: true })],
      hasRunning: () => true,
    });
    expect(result.hiddenRunning?.rootIds).toEqual(['A']);
    expect(result.hiddenRunning?.key).toBe(HIDDEN_RUNNING_GROUP_KEY);
    expect(result.outOfScopeCount).toBe(1);
  });

  it('rescues a RUNNING session whose every claimant is closed', () => {
    const result = grouping({
      visibleRootIds: ['A'],
      cwdOf: cwds,
      projects: [
        project('p1', 'Alpha', '/shared', { hidden: true }),
        project('p2', 'Beta', '/shared', { hidden: true }),
      ],
      hasRunning: () => true,
    });
    // Closing the projects hides their WORK; it must not hide a process that
    // is still spending this machine's memory.
    expect(result.hiddenRunning?.rootIds).toEqual(['A']);
    expect(result.hiddenCount).toBe(0);
  });

  it('rescues a RUNNING root from a hidden folder — and only while it runs', () => {
    // A hidden folder is a view preference; the levels invariant outranks it
    // for exactly as long as a process lives. Dead: hidden as always.
    const base = {
      visibleRootIds: ['C'],
      cwdOf: cwds,
      projects: [],
      hiddenFolders: ['/elsewhere'],
    };
    const running = grouping({ ...base, hasRunning: () => true });
    expect(running.hiddenRunning?.rootIds).toEqual(['C']);
    expect(running.hiddenCount).toBe(0);

    const dead = grouping({ ...base, hasRunning: () => false });
    expect(dead.hiddenRunning).toBeNull();
    expect(dead.hiddenCount).toBe(1);
  });

  it('rescues a RUNNING root that onlyProjectSessions would drop', () => {
    // C claims no project, so the filter drops it — unless it is running, in
    // which case the appendix keeps the one row the badge needs to point at.
    const base = {
      visibleRootIds: ['C'],
      cwdOf: cwds,
      projects: [project('p1', 'Alpha', '/shared')],
      onlyProjectSessions: true,
    };
    const running = grouping({ ...base, hasRunning: () => true });
    expect(running.hiddenRunning?.rootIds).toEqual(['C']);
    expect(running.hiddenCount).toBe(0);

    const dead = grouping({ ...base, hasRunning: () => false });
    expect(dead.hiddenRunning).toBeNull();
    expect(dead.hiddenCount).toBe(1);
  });

  it('is null when nothing was rescued, and absent hasRunning rescues nothing', () => {
    const scoped = grouping({
      visibleRootIds: ['C'],
      cwdOf: cwds,
      scopeDirs: ['/code'],
      projects: [],
    });
    expect(scoped.hiddenRunning).toBeNull();
    expect(scoped.outOfScopeCount).toBe(1);
  });

  // The other way a live session can be missing from `visibleRootIds`: not
  // filtered out of a bucket, never offered one. An archived record whose
  // process the roster still reports has no node in the visible forest at all
  // (lineage.isVisible drops `deleted` unconditionally), so none of the rules
  // above ever sees it — which is how the badge came to read 6 with four rows
  // on screen, one of the missing two live for four days.
  it('appends a live session that never had a row at all', () => {
    const result = grouping({
      visibleRootIds: ['A'],
      cwdOf: cwds,
      projects: [],
      rowlessRunningIds: ['C'],
    });
    expect(result.loose).toEqual(['A']);
    expect(result.hiddenRunning?.rootIds).toEqual(['C']);
    expect(result.hiddenRunning?.key).toBe(HIDDEN_RUNNING_GROUP_KEY);
  });

  it('never draws the same session twice when it was rescued already', () => {
    // The caller reads the forest a moment before this runs, so it can hand
    // back an id the walk has just placed in the appendix itself.
    const result = grouping({
      visibleRootIds: ['A'],
      cwdOf: cwds,
      scopeDirs: ['/shared'],
      projects: [project('p1', 'Alpha', '/shared', { hidden: true })],
      hasRunning: () => true,
      rowlessRunningIds: ['A'],
    });
    expect(result.hiddenRunning?.rootIds).toEqual(['A']);
  });

  it('applies the scope fence to the rowless ids too', () => {
    // Re-applied here rather than trusted to the caller: the fence is the one
    // boundary in this file, and a new input must not be the way around it.
    const result = grouping({
      visibleRootIds: [],
      cwdOf: cwds,
      scopeDirs: ['/shared'],
      projects: [],
      rowlessRunningIds: ['C'],
    });
    expect(result.hiddenRunning).toBeNull();
  });

  it('a throwing hasRunning degrades to the plain drop, never takes the tree down', () => {
    const result = grouping({
      visibleRootIds: ['C'],
      cwdOf: cwds,
      scopeDirs: ['/code'],
      projects: [],
      hasRunning: () => {
        throw new Error('boom');
      },
    });
    expect(result.hiddenRunning).toBeNull();
    expect(result.outOfScopeCount).toBe(1);
  });
});

describe('preferredClaimant: where a single-project action files', () => {
  const alpha = project('p1', 'Alpha', '/shared');
  const beta = project('p2', 'Beta', '/shared');

  it('prefers the ACTIVE project among the claimants', () => {
    const matches = matchProjects([alpha, beta], '/shared/x');
    // Static tie-break says Alpha; the user is switched into Beta, and Beta
    // claims the directory, so Beta files it.
    expect(preferredClaimant(matches, 'p2')?.project.id).toBe('p2');
  });

  it('never lets an active NON-claimant steal the filing', () => {
    const matches = matchProjects([alpha, beta], '/shared/x');
    expect(preferredClaimant(matches, 'p9')?.project.id).toBe('p1');
  });

  it('is the static winner with no active project (folder mode, nothing switched)', () => {
    const matches = matchProjects([alpha, beta], '/shared/x');
    expect(preferredClaimant(matches, null)?.project.id).toBe('p1');
    expect(preferredClaimant(matches, '')?.project.id).toBe('p1');
  });

  it('answers null for no claimants at all', () => {
    expect(preferredClaimant([], 'p1')).toBeNull();
  });
});

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

  it('builds the branch list off the ONE gate, whichever way it is displayed', () => {
    // One switch, both display modes. The list feeds the colours and the line
    // alike, so the question here is only "did the user turn the branch feature
    // on" — `lineage.git.branchDisplay` decides what is done with the answer,
    // never whether it is computed. Whether the ROWS are drawn stays the
    // renderer's half of the gate; see ViewModelInput.branchBlock.
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
    expect((out.projects[0].branches ?? []).map((b) => b.name)).toEqual([
      'main',
      '(detached)',
      'feat/x',
    ]);
  });

  it('builds no branch list when the feature is off', () => {
    const out = computeGrouping({
      visibleRootIds: ['A', 'B', 'C'],
      cwdOf: cwds,
      projects,
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
      worktreesOf: appWorktrees,
    });
    expect(out.projects[0].branches).toEqual([]);
    // Membership is NOT gated: a session in a linked checkout still files under
    // the project that owns the repository. Hiding rows must not move sessions.
    expect(out.projects[0].rootIds).toEqual(['A', 'B', 'C']);
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

  it.runIf(PATHS_FOLD_CASE)('collides case-insensitively, matching pathKey', () => {
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

  it('files a chat in a twice-claimed directory under BOTH projects', () => {
    // Two projects are allowed to list the same directory (projectClaiming
    // announces the sharing rather than refusing it), and the grouping pass
    // files the session's ROW under both on the stated grounds that picking a
    // winner leaves the loser displaying nothing while still claiming
    // everything. The history is a view of the same fact and used to take the
    // tie-break's head, so Bravo's history denied ever having a chat whose row
    // it had just drawn.
    const ALPHA = project('a', 'Alpha', '/w/shared');
    const BRAVO = project('b', 'Bravo', '/w/shared');
    const records = { s1: chat('s1', '/w/shared/x') };
    expect(chatsForProject(records, [ALPHA, BRAVO], 'a').map((r) => r.id)).toEqual(
      ['s1'],
    );
    expect(chatsForProject(records, [ALPHA, BRAVO], 'b').map((r) => r.id)).toEqual(
      ['s1'],
    );
  });
});

describe('closedProjectIds', () => {
  // Extracted out of computeGrouping so that a verb which has just restored a
  // session can ask the same question the tree asks. The rule that matters is
  // inheritance: closing a parent closes its subtree, so a subproject that
  // carries no flag of its own is still closed and its rows are still gone.
  it('includes a subproject of a closed parent, and stops at a broken edge', () => {
    const parent = project('p0', 'code', '/code', { hidden: true });
    const child = project('p1', 'api', '/code/api', { parentId: 'p0' });
    const grandchild = project('p2', 'db', '/code/api/db', { parentId: 'p1' });
    const elsewhere = project('p3', 'web', '/web');
    // A parent id naming nothing makes the child a ROOT rather than hiding it
    // (buildProjectTree), so it is open.
    const orphan = project('p4', 'lost', '/lost', { parentId: 'nope' });
    const closed = closedProjectIds([
      parent,
      child,
      grandchild,
      elsewhere,
      orphan,
    ]);
    expect([...closed].sort()).toEqual(['p0', 'p1', 'p2']);
  });

  it('is empty when nothing is closed', () => {
    expect(closedProjectIds([project('p1', 'api', '/code/api')]).size).toBe(0);
    expect(closedProjectIds([]).size).toBe(0);
  });
});

describe('archivedForProject', () => {
  const gone = (
    id: string,
    cwd: string | undefined,
    over: Partial<EditorialRecord> = {},
  ): EditorialRecord => ({
    id,
    deleted: true,
    cwd,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  const API = project('p1', 'API', '/code/api');
  const WEB = project('p2', 'Web', '/code/web');

  it("lists only this project's archived sessions", () => {
    const records = {
      a: gone('a', '/code/api'),
      // Another project's archive, a session that is merely CLOSED, and a
      // chat — a chat has no row, so there is nothing here to restore.
      b: gone('b', '/code/web'),
      c: gone('c', '/code/api', { deleted: false }),
      d: gone('d', '/code/api', { chat: true }),
    };
    expect(
      archivedForProject(records, [API, WEB], 'p1').map((r) => r.id),
    ).toEqual(['a']);
  });

  it("falls back to the transcript's cwd when the record has none", () => {
    // The measured blind spot: 32 of 159 archived records on a real store
    // carry no cwd of their own, and 28 of those have one in the transcript
    // head. Without the seam a fifth of the archive is simply missing, and an
    // incomplete list looks exactly like an empty one.
    const records = { a: gone('a', undefined) };
    expect(archivedForProject(records, [API], 'p1')).toEqual([]);
    expect(
      archivedForProject(records, [API], 'p1', {
        cwdOf: (id) => (id === 'a' ? '/code/api/src' : undefined),
      }).map((r) => r.id),
    ).toEqual(['a']);
  });

  it('leaves a record with no cwd anywhere in no project at all', () => {
    // Honest rather than tidy: filing it somewhere would put a session in a
    // list it does not belong to. The whole-machine restore picker is its door.
    const records = { a: gone('a', undefined) };
    expect(
      archivedForProject(records, [API, WEB], 'p1', { cwdOf: () => undefined }),
    ).toEqual([]);
    expect(
      archivedForProject(records, [API, WEB], 'p2', { cwdOf: () => undefined }),
    ).toEqual([]);
  });

  it('files a worktree session under the project that owns the repository', () => {
    // The sidebar groups with reach; a surface that disagrees about
    // membership is indistinguishable from a bug, because it is one.
    const records = { a: gone('a', '/code/wt/feature') };
    expect(archivedForProject(records, [API], 'p1')).toEqual([]);
    expect(
      archivedForProject(records, [API], 'p1', {
        extraDirs: (p) => (p.id === 'p1' ? ['/code/wt/feature'] : []),
      }).map((r) => r.id),
    ).toEqual(['a']);
  });

  it('orders most-recently-archived first, and breaks ties on id', () => {
    // Archiving writes the record, so `updatedAt` is when it was put away —
    // and a user opening this list is most often looking for the one they just
    // archived by mistake.
    const records = {
      old: gone('old', '/code/api', { updatedAt: '2026-01-01T00:00:00.000Z' }),
      new: gone('new', '/code/api', { updatedAt: '2026-03-01T00:00:00.000Z' }),
      tie: gone('tie', '/code/api', { updatedAt: '2026-03-01T00:00:00.000Z' }),
    };
    expect(archivedForProject(records, [API], 'p1').map((r) => r.id)).toEqual([
      'new',
      'tie',
      'old',
    ]);
  });

  it('answers for a CLOSED project too — closing hides rows, not history', () => {
    const closed = project('p1', 'API', '/code/api', { hidden: true });
    expect(
      archivedForProject({ a: gone('a', '/code/api') }, [closed], 'p1'),
    ).toHaveLength(1);
  });

  it('survives an empty store', () => {
    expect(archivedForProject(undefined, [API], 'p1')).toEqual([]);
    expect(archivedForProject({}, [], 'p1')).toEqual([]);
  });

  it('lists an archived session under EVERY project that claims its directory', () => {
    // The row was under both; the archive filed it under one, chosen by a
    // name-and-id tie-break — so renaming Alpha to Zulu silently moved a whole
    // project's archive to its neighbour, and the loser's browser said
    // "Nothing archived" about a session it had drawn a moment earlier.
    const ALPHA = project('a', 'Alpha', '/w/shared');
    const BRAVO = project('b', 'Bravo', '/w/shared');
    const records = { s1: gone('s1', '/w/shared/x') };
    expect(
      archivedForProject(records, [ALPHA, BRAVO], 'a').map((r) => r.id),
    ).toEqual(['s1']);
    expect(
      archivedForProject(records, [ALPHA, BRAVO], 'b').map((r) => r.id),
    ).toEqual(['s1']);
    // Renaming must not move anything now that neither project is the loser.
    const ZULU = project('a', 'Zulu', '/w/shared');
    expect(
      archivedForProject(records, [ZULU, BRAVO], 'a').map((r) => r.id),
    ).toEqual(['s1']);
  });

  it('still lets a DEEPER project take the archive off a shallower one', () => {
    // The plural is only ever about claims at the SAME depth. Nesting is how a
    // monorepo is divided, and a project rooted at the inner directory still
    // owns those sessions outright.
    const OUTER = project('p1', 'Outer', '/code');
    const INNER = project('p2', 'Inner', '/code/api');
    const records = { s1: gone('s1', '/code/api/src') };
    expect(archivedForProject(records, [OUTER, INNER], 'p2')).toHaveLength(1);
    expect(archivedForProject(records, [OUTER, INNER], 'p1')).toHaveLength(0);
  });
});

// ------------------------------------- the block is asked for, never assumed

describe('computeGrouping: the branch block is opt-in', () => {
  const projects = [
    {
      id: 'p1',
      name: 'app',
      rootDir: '/code/app',
      dirs: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ];

  it('carries the record through as-is, absent included', () => {
    // REGRESSION. This used to be normalised — `p.branchesCollapsed === true` —
    // which turned "never asked" into the same value as "explicitly opened", and
    // the renderer needs those apart: one draws six rows nobody asked for and
    // the other is somebody's decision. Absent has to stay absent.
    const out = computeGrouping({
      visibleRootIds: [],
      cwdOf: () => undefined,
      projects,
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
      branchRows: true,
    });
    expect(out.projects[0].branchesShown).toBeUndefined();
  });

  it('keeps an explicit answer, either way', () => {
    for (const shown of [true, false]) {
      const out = computeGrouping({
        visibleRootIds: [],
        cwdOf: () => undefined,
        projects: [{ ...projects[0], branchesShown: shown }],
        hiddenFolders: [],
        groupByFolder: true,
        onlyProjectSessions: false,
        branchRows: true,
      });
      expect(out.projects[0].branchesShown).toBe(shown);
    }
  });
});
