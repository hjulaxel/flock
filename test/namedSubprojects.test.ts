// test/namedSubprojects.test.ts — two subprojects in the SAME folder.
//
// v7. Everything before it made a subproject a function of the directory set, and
// that model cannot express the thing this file is about: `~/magma-cs-mcp` is one
// directory, and "the server rewrite" and "the CS tooling" are two bodies of work
// in it. So a lane is a record with a NAME, and because two lanes' directories are
// byte-identical, which one a session belongs to cannot be derived — it is stamped
// at launch.
//
// Four properties matter and they are what this file tests:
//
//   1. A store with NO lanes draws exactly the tree it drew before. That is the
//      compatibility promise, and it is why the implicit rows exist.
//   2. Two lanes on one directory are two rows with distinct identities.
//   3. The STAMP outranks every derived rule, and a dangling one falls back to
//      derived rather than losing the session.
//   4. There is still no leftover row: naming a lane in a directory makes it that
//      directory's default, so nothing appears alongside it to hold the rest.

import { describe, expect, it } from 'vitest';

import {
  buildSubprojects,
  computeGrouping,
  implicitSubprojectId,
} from '../src/projects';
import { subprojectTokens } from '../src/viewmodel';
import type { ProjectRecord, SubprojectRecord } from '../src/types';

const A = '0f00000a-0000-4000-8000-00000000000a';
const B = '0f00000b-0000-4000-8000-00000000000b';
const C = '0f00000c-0000-4000-8000-00000000000c';

function project(over: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'p1',
    name: 'magma-cs-mcp',
    rootDir: '/code/magma-cs-mcp',
    dirs: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function lane(
  id: string,
  name: string,
  dir: string,
  over: Partial<SubprojectRecord> = {},
): SubprojectRecord {
  return {
    id,
    projectId: 'p1',
    name,
    dir,
    createdAt: `2026-01-0${id.length}T00:00:00.000Z`,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const ROOT = '/code/magma-cs-mcp';
const SERVER = lane('l1', 'Server rewrite', ROOT);
const TOOLS = lane('l2', 'CS tooling', ROOT);

// ------------------------------------------------- nothing changes without lanes

describe('a project with no lanes', () => {
  it('emits nothing at one directory, exactly as before v7', () => {
    expect(
      buildSubprojects({
        project: project(),
        rootIds: [A],
        cwdOf: () => ROOT,
      }),
    ).toEqual([]);
  });

  it('emits one implicit row per directory once there are two', () => {
    const out = buildSubprojects({
      project: project({ dirs: [`${ROOT}/api`] }),
      rootIds: [],
      cwdOf: () => undefined,
    });
    expect(out.map((s) => s.label)).toEqual(['magma-cs-mcp', 'api']);
    expect(out.map((s) => s.implicit)).toEqual([true, true]);
    expect(out.map((s) => s.name)).toEqual(['', '']);
    expect(out.map((s) => s.main)).toEqual([true, false]);
  });

  it('gives an implicit row a prefixed id that cannot collide with a uuid', () => {
    const out = buildSubprojects({
      project: project({ dirs: [`${ROOT}/api`] }),
      rootIds: [],
      cwdOf: () => undefined,
    });
    expect(out[0].id).toBe(implicitSubprojectId(ROOT));
    expect(out[0].id).toBe('dir:/code/magma-cs-mcp');
    expect(out.every((s) => s.id.startsWith('dir:'))).toBe(true);
  });
});

// ------------------------------------------------------ two lanes, one directory

describe('two lanes in one folder', () => {
  const build = (over: Partial<Parameters<typeof buildSubprojects>[0]> = {}) =>
    buildSubprojects({
      project: project(),
      rootIds: [],
      cwdOf: () => ROOT,
      lanes: [SERVER, TOOLS],
      ...over,
    });

  it('draws a row each, on the same directory, with distinct identities', () => {
    const out = build();
    expect(out.map((s) => s.label)).toEqual(['Server rewrite', 'CS tooling']);
    expect(out[0].dir).toBe(out[1].dir);
    expect(out[0].dirKey).toBe(out[1].dirKey);
    expect(out[0].id).not.toBe(out[1].id);
    expect(out.every((s) => !s.implicit)).toBe(true);
  });

  it('draws no implicit row for a directory a lane already names', () => {
    // Otherwise the folder would appear twice — once as a lane and once as
    // itself — and the second row would be the leftover bucket this model refuses.
    const out = build();
    expect(out).toHaveLength(2);
    expect(out.some((s) => s.implicit)).toBe(false);
  });

  it('draws ONE lane as a row, even though one node is below the threshold', () => {
    // SUBPROJECT_MIN is about directories restating a project's own address. A name
    // you typed on purpose always earns its row — it is where its `+` and its
    // branches live.
    const out = build({ lanes: [SERVER] });
    expect(out.map((s) => s.label)).toEqual(['Server rewrite']);
  });

  it('marks no lane as the project’s main directory', () => {
    // `main` is what Remove Subproject refuses. Removing a LANE removes a name and
    // is always allowed, whatever directory it happens to name.
    expect(build().every((s) => s.main === false)).toBe(true);
  });

  it('labels a lane whose name is blank by its directory, so the row is findable', () => {
    const out = build({ lanes: [lane('l3', '', ROOT)] });
    expect(out[0].label).toBe('magma-cs-mcp');
    expect(out[0].implicit).toBe(false);
  });

  it('ignores a lane belonging to another project, or a tombstoned one', () => {
    const out = build({
      lanes: [
        SERVER,
        lane('l9', 'Someone else', ROOT, { projectId: 'p2' }),
        lane('l8', 'Gone', ROOT, { deleted: true }),
      ],
    });
    expect(out.map((s) => s.label)).toEqual(['Server rewrite']);
  });
});

// ------------------------------------------------------------------- the stamp

describe('which lane a session lands in', () => {
  const build = (
    stamps: Record<string, string | undefined>,
    over: Partial<Parameters<typeof buildSubprojects>[0]> = {},
  ) =>
    buildSubprojects({
      project: project(),
      rootIds: [A, B, C],
      cwdOf: () => ROOT,
      lanes: [SERVER, TOOLS],
      stampOf: (id) => stamps[id],
      ...over,
    });

  it('files each session in the lane it was started in', () => {
    // THE WHOLE POINT: all three cwds are identical, so nothing derived can tell
    // these apart. Only the stamp can.
    const out = build({ [A]: 'l1', [B]: 'l2', [C]: 'l1' });
    expect(out[0].rootIds).toEqual([A, C]);
    expect(out[1].rootIds).toEqual([B]);
  });

  it('sends an unstamped session to the directory’s FIRST lane', () => {
    // The migration story: pre-existing sessions, and everything started by hand in
    // a terminal, land in lane number one rather than in a row of their own. That is
    // what keeps "no leftover row" true after a lane is named.
    const out = build({});
    expect(out[0].rootIds).toEqual([A, B, C]);
    expect(out[1].rootIds).toEqual([]);
  });

  it('treats a stamp naming a lane that is gone as no stamp at all', () => {
    // deleteSubproject deliberately leaves every stamp alone, so dangling stamps
    // are the ordinary state after removing a lane — not an error.
    const out = build({ [A]: 'deleted-lane', [B]: 'l2' });
    expect(out[0].rootIds).toEqual([A, C]);
    expect(out[1].rootIds).toEqual([B]);
  });

  it('ignores a stamp naming another project’s lane', () => {
    const out = build({ [A]: 'l9' }, { lanes: [SERVER, TOOLS] });
    expect(out[0].rootIds).toContain(A);
  });

  it('never honours a stamp naming an implicit row', () => {
    // An implicit id is derived from a path and exists only while the project has
    // that directory. Letting one be stamped would tie a session to a row that
    // vanishes when the directory list changes.
    const out = buildSubprojects({
      project: project({ dirs: [`${ROOT}/api`] }),
      rootIds: [A],
      cwdOf: () => `${ROOT}/api`,
      stampOf: () => implicitSubprojectId(ROOT),
    });
    // Placed by directory — under api, where it actually runs.
    expect(out[1].rootIds).toEqual([A]);
    expect(out[0].rootIds).toEqual([]);
  });

  it('survives a stampOf that throws', () => {
    const out = buildSubprojects({
      project: project(),
      rootIds: [A],
      cwdOf: () => ROOT,
      lanes: [SERVER, TOOLS],
      stampOf: () => {
        throw new Error('no records');
      },
    });
    expect(out[0].rootIds).toEqual([A]);
  });

  it('loses no session, whatever the stamps say', () => {
    const out = build({ [A]: 'l2', [B]: 'nonsense' });
    expect(out.flatMap((s) => s.rootIds).slice().sort()).toEqual(
      [A, B, C].slice().sort(),
    );
  });
});

// --------------------------------------- lanes and directories in one project

describe('a project with both lanes and plain directories', () => {
  const mixed = project({ dirs: [`${ROOT}/api`, '/code/notes'] });

  const out = buildSubprojects({
    project: mixed,
    rootIds: [A, B, C],
    cwdOf: (id) =>
      id === A ? ROOT : id === B ? `${ROOT}/api/handlers` : '/code/notes/x',
    lanes: [SERVER, TOOLS],
    stampOf: (id) => (id === A ? 'l2' : undefined),
  });

  it('puts the lanes first, then a row per unnamed directory', () => {
    expect(out.map((s) => s.label)).toEqual([
      'Server rewrite',
      'CS tooling',
      'api',
      'notes',
    ]);
    expect(out.map((s) => s.implicit)).toEqual([false, false, true, true]);
  });

  it('keeps `main` on the implicit row standing for the project’s address', () => {
    // Nothing here is the root directory's implicit row — two lanes cover it — so
    // no row claims `main`, and Remove Subproject refuses nothing.
    expect(out.every((s) => s.main === false)).toBe(true);
  });

  it('files a stamped session in its lane and everything else by directory', () => {
    expect(out[1].rootIds).toEqual([A]); // stamped into CS tooling
    expect(out[2].rootIds).toEqual([B]); // api, by directory
    expect(out[3].rootIds).toEqual([C]); // notes, by directory
    expect(out[0].rootIds).toEqual([]);
  });
});

// ----------------------------------------------------------- through grouping

describe('computeGrouping with lanes', () => {
  it('carries the lanes onto the project node, in creation order', () => {
    const result = computeGrouping({
      visibleRootIds: [A, B],
      cwdOf: () => ROOT,
      projects: [project()],
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
      subprojects: [SERVER, TOOLS],
      stampOf: (id) => (id === B ? 'l2' : 'l1'),
    });
    const rows = result.projects[0].subprojects ?? [];
    expect(rows.map((s) => s.label)).toEqual(['Server rewrite', 'CS tooling']);
    expect(rows[0].rootIds).toEqual([A]);
    expect(rows[1].rootIds).toEqual([B]);
  });

  it('draws the pre-v7 tree when no lane exists', () => {
    const result = computeGrouping({
      visibleRootIds: [A],
      cwdOf: () => ROOT,
      projects: [project()],
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
    });
    expect(result.projects[0].subprojects).toEqual([]);
    expect(result.projects[0].rootIds).toEqual([A]);
  });

  it('ignores a lane whose project is not in the grouping', () => {
    const result = computeGrouping({
      visibleRootIds: [],
      cwdOf: () => undefined,
      projects: [project()],
      hiddenFolders: [],
      groupByFolder: true,
      onlyProjectSessions: false,
      subprojects: [lane('l7', 'Orphan', ROOT, { projectId: 'gone' })],
    });
    expect(result.projects[0].subprojects).toEqual([]);
  });
});

// -------------------------------------------------------------- the row tokens

describe('subprojectTokens', () => {
  it('marks a named lane, so the rename and remove verbs can find it', () => {
    expect(subprojectTokens({ main: false, implicit: false })).toEqual([
      'subproject',
      'named',
    ]);
  });

  it('leaves an implicit row without the named token', () => {
    expect(subprojectTokens({ main: false, implicit: true })).toEqual(['subproject']);
  });

  it('keeps `primary` on the row standing for the project’s main directory', () => {
    expect(subprojectTokens({ main: true, implicit: true })).toEqual([
      'subproject',
      'primary',
    ]);
  });
});
