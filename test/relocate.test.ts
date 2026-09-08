// test/relocate.test.ts — following a project folder that moved.
//
// The wiring walks the filesystem and writes the store; every rule about WHICH
// directory the folder went to, and WHAT has to change once that is known, is
// here, against hand-built candidates and records.

import { describe, expect, it } from 'vitest';

import { planRelocation, relocationWrites, searchRoots } from '../src/relocate';
import type { EditorialRecord, ProjectRecord } from '../src/types';

const GONE = '/Users/a/Documents/research/ai-builder/plc-meeting';

function search(...dirs: string[]): Array<{ dir: string; source: 'search' }> {
  return dirs.map((dir) => ({ dir, source: 'search' as const }));
}

describe('planRelocation', () => {
  it('follows a folder that moved up a level — the case that started this', () => {
    // research/ai-builder/plc-meeting became research/plc-meeting, and every
    // New Session on the project did nothing at all until someone noticed.
    expect(
      planRelocation({
        missing: GONE,
        candidates: search('/Users/a/Documents/research/plc-meeting'),
      }),
    ).toEqual({
      kind: 'found',
      dir: '/Users/a/Documents/research/plc-meeting',
      source: 'search',
    });
  });

  it('takes the candidate nearest the old path', () => {
    // Both are called the same thing; one is still in the same parent.
    expect(
      planRelocation({
        missing: GONE,
        candidates: search(
          '/Users/a/Documents/plc-meeting',
          '/Users/a/Documents/research/ai-builder/archive/plc-meeting',
        ),
      }),
    ).toMatchObject({
      dir: '/Users/a/Documents/research/ai-builder/archive/plc-meeting',
    });
  });

  it('a directory a session is RUNNING in beats a search hit at the same distance', () => {
    // Something opened it after the move: evidence, not resemblance.
    expect(
      planRelocation({
        missing: GONE,
        candidates: [
          { dir: '/Users/a/Documents/research/x/plc-meeting', source: 'search' },
          { dir: '/Users/a/Documents/research/y/plc-meeting', source: 'session' },
        ],
      }),
    ).toEqual({
      kind: 'found',
      dir: '/Users/a/Documents/research/y/plc-meeting',
      source: 'session',
    });
  });

  it('two equally good answers are AMBIGUOUS, never a coin toss', () => {
    // Repointing rewrites what every session in the project belongs to. Half
    // a reason is not enough to do that unasked.
    const plan = planRelocation({
      missing: GONE,
      candidates: search(
        '/Users/a/Documents/research/x/plc-meeting',
        '/Users/a/Documents/research/y/plc-meeting',
      ),
    });
    expect(plan.kind).toBe('ambiguous');
    expect(plan.kind === 'ambiguous' && plan.dirs).toHaveLength(2);
  });

  it('a different NAME is a different folder — a rename is not followed', () => {
    expect(
      planRelocation({
        missing: GONE,
        candidates: search('/Users/a/Documents/research/plc-meetings-2026'),
      }),
    ).toEqual({ kind: 'none' });
  });

  it('nothing to go on is "none", not a guess', () => {
    expect(planRelocation({ missing: GONE, candidates: [] })).toEqual({
      kind: 'none',
    });
  });

  it('a candidate UNDER the missing path is not where it went', () => {
    expect(
      planRelocation({
        missing: GONE,
        candidates: search(`${GONE}/backup/plc-meeting`),
      }),
    ).toEqual({ kind: 'none' });
  });

  it('the same directory twice is one candidate, not an ambiguity', () => {
    // The wiring gathers from several sources and they overlap constantly.
    expect(
      planRelocation({
        missing: GONE,
        candidates: [
          { dir: '/Users/a/Documents/research/plc-meeting', source: 'search' },
          { dir: '/Users/a/Documents/research/plc-meeting/', source: 'session' },
        ],
      }),
    ).toMatchObject({ kind: 'found', dir: '/Users/a/Documents/research/plc-meeting' });
  });
});

// ---------------------------------------------------------------------------

function project(over: Partial<ProjectRecord> & { id: string }): ProjectRecord {
  return {
    name: over.id,
    rootDir: '',
    dirs: [],
    createdAt: '2026-09-08T00:00:00.000Z',
    updatedAt: '2026-09-08T00:00:00.000Z',
    ...over,
  };
}

function record(id: string, cwd: string): EditorialRecord {
  return { id, cwd } as EditorialRecord;
}

describe('relocationWrites', () => {
  const FROM = '/Users/a/research/ai-builder/plc-meeting';
  const TO = '/Users/a/research/plc-meeting';

  it('moves the project, its subproject and every session that ran there', () => {
    // A project that followed its folder while its own history stayed behind
    // would be the feature half-done: membership is derived from each
    // session's cwd, so the rows would leave the project on the way past.
    const writes = relocationWrites({
      from: FROM,
      to: TO,
      projects: [
        project({ id: 'plc', rootDir: FROM, dirs: [`${FROM}/notes`] }),
        project({ id: 'lane', rootDir: `${FROM}/api`, parentId: 'plc' }),
        project({ id: 'other', rootDir: '/Users/a/research/ai-builder' }),
      ],
      records: {
        s1: record('s1', FROM),
        s2: record('s2', `${FROM}/api`),
        s3: record('s3', '/Users/a/research/ai-builder'),
      },
    });

    expect(writes.projects).toEqual([
      { id: 'plc', patch: { rootDir: TO, dirs: [`${TO}/notes`] } },
      { id: 'lane', patch: { rootDir: `${TO}/api` } },
    ]);
    expect(writes.records).toEqual([
      { id: 's1', cwd: TO },
      { id: 's2', cwd: `${TO}/api` },
    ]);
  });

  it('leaves everything outside the moved folder alone', () => {
    const writes = relocationWrites({
      from: FROM,
      to: TO,
      projects: [project({ id: 'other', rootDir: '/Users/a/research/basalt' })],
      records: { s: record('s', '/Users/a/research/basalt') },
    });
    expect(writes).toEqual({ projects: [], records: [], moved: [] });
  });

  it('a sibling whose name merely STARTS with the old path does not move', () => {
    // `…/plc-meeting-old` is not inside `…/plc-meeting`, and a prefix compare
    // that forgot the separator would drag it along.
    const writes = relocationWrites({
      from: FROM,
      to: TO,
      projects: [project({ id: 'old', rootDir: `${FROM}-old` })],
      records: { s: record('s', `${FROM}-old/src`) },
    });
    expect(writes.projects).toEqual([]);
    expect(writes.records).toEqual([]);
  });

  it('applying it twice writes nothing the second time', () => {
    const after = relocationWrites({
      from: FROM,
      to: TO,
      projects: [project({ id: 'plc', rootDir: TO, dirs: [`${TO}/notes`] })],
      records: { s1: record('s1', TO) },
    });
    expect(after.projects).toEqual([]);
    expect(after.records).toEqual([]);
  });

  it('a move to where it already is is not a move', () => {
    expect(
      relocationWrites({
        from: FROM,
        to: FROM,
        projects: [project({ id: 'plc', rootDir: FROM })],
        records: { s1: record('s1', FROM) },
      }),
    ).toEqual({ projects: [], records: [], moved: [] });
  });

  it('reports every directory that changed, for the sentence the user reads', () => {
    const writes = relocationWrites({
      from: FROM,
      to: TO,
      projects: [project({ id: 'plc', rootDir: FROM, dirs: [`${FROM}/notes`] })],
      records: {},
    });
    expect(writes.moved).toEqual([
      { from: FROM, to: TO },
      { from: `${FROM}/notes`, to: `${TO}/notes` },
    ]);
  });
});

describe('searchRoots', () => {
  it('climbs — the folder that moved UP is the case a downward search cannot see', () => {
    // research/ai-builder/plc-meeting became research/plc-meeting. The first
    // version of the search started at the nearest SURVIVING ancestor, which
    // is ai-builder — still there, and no longer containing the folder — and
    // looked only downward. It found nothing, however deep it went.
    expect(searchRoots('/Users/a/Documents/research/ai-builder/plc-meeting', 3)).toEqual([
      '/Users/a/Documents/research/ai-builder',
      '/Users/a/Documents/research',
      '/Users/a/Documents',
      '/Users/a',
    ]);
  });

  it('is nearest-first, so a shared visit budget is spent close to home', () => {
    const roots = searchRoots('/a/b/c/d', 3);
    expect(roots[0]).toBe('/a/b/c');
    expect(roots.at(-1)).toBe('/');
  });

  it('stops at the filesystem root rather than climbing past it', () => {
    expect(searchRoots('/top', 5)).toEqual(['/']);
  });

  it('has nothing to search for a path that is not one', () => {
    expect(searchRoots('', 3)).toEqual([]);
    expect(searchRoots('/', 3)).toEqual([]);
  });
});
