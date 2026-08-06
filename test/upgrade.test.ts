// test/upgrade.test.ts — what happens to a state.json somebody already has.
//
// WHY THIS FILE EXISTS SEPARATELY FROM state.test.ts. That file tests the
// migration ladder a step at a time, with a blob shaped for the step under
// test. This one asks the release question instead: take a file as a REAL user
// of the previous version has it — projects, a nested subproject, renames,
// minted edges, a saved workspace layout, a tombstone — run it through the
// build we are about to publish, and account for every single thing in it.
//
// The second half is the case that is easy to forget. An upgrade is not atomic
// across windows: VS Code swaps the extension on disk while windows are open,
// so a window nobody has reloaded keeps running the OLD code against a
// state.json a freshly opened window has already migrated. Both write to the
// same file. The old build stamps `version` back down to what it knows, which
// means every migration step must be safe to run a second time — the ladder is
// keyed on the version the FILE claims, never on a flag of ours.

import { describe, expect, it } from 'vitest';

import { migrateState } from '../src/state';
import { PROJECT_TOMBSTONE_TTL_MS, STATE_SCHEMA_VERSION } from '../src/types';

const S_CHILD = '11111111-1111-4111-8111-111111111111';
const S_PARENT = '22222222-2222-4222-8222-222222222222';

/** Recent enough that the tombstone sweep leaves it alone. A tombstone past
 *  PROJECT_TOMBSTONE_TTL_MS is swept ON PURPOSE — no window can still be
 *  holding the live record by then — so pinning a literal date here would
 *  assert the opposite of the intended behaviour the moment it aged out. */
const recent = new Date(Date.now() - PROJECT_TOMBSTONE_TTL_MS / 2).toISOString();
const old = new Date(Date.now() - PROJECT_TOMBSTONE_TTL_MS * 2).toISOString();

/**
 * A v5 file as 0.1.1 wrote it. Every field here is one somebody would notice
 * the loss of.
 */
const v5State = (): Record<string, unknown> => ({
  version: 5,
  projects: {
    p_app: {
      id: 'p_app',
      name: 'App',
      rootDir: '/Users/u/code/app',
      dirs: ['/Users/u/code/app/web'],
      provider: 'claude',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    // The thing v6 folds: a whole project record filed under another one.
    p_api: {
      id: 'p_api',
      name: 'The API rewrite',
      rootDir: '/Users/u/code/app/api',
      dirs: [],
      parentId: 'p_app',
      provider: 'codex',
      hidden: true,
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
    p_gone: {
      id: 'p_gone',
      name: '',
      rootDir: '',
      dirs: [],
      deleted: true,
      createdAt: recent,
      updatedAt: recent,
    },
  },
  records: {
    [S_CHILD]: {
      id: S_CHILD,
      title: 'a session I renamed',
      closed: '2026-08-01T00:00:00.000Z',
      parentId: S_PARENT,
      parentSource: 'minted',
      createdAt: '2026-01-03T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    },
    [S_PARENT]: {
      id: S_PARENT,
      title: 'the parent',
      createdAt: '2026-01-03T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    },
  },
  workspaces: {
    p_app: {
      projectId: 'p_app',
      tabs: [
        { kind: 'file', uri: 'file:///Users/u/code/app/a.ts', viewColumn: 1, active: true },
        { kind: 'session', sessionId: S_PARENT, viewColumn: 2 },
      ],
      savedAt: '2026-01-04T00:00:00.000Z',
      updatedAt: '2026-01-04T00:00:00.000Z',
    },
  },
  hiddenFolders: { '/Users/u/scratch': { path: '/Users/u/scratch' } },
});

describe('upgrade: a 0.1.1 state.json, read by this build', () => {
  it('stamps the current schema version', () => {
    expect(migrateState(v5State()).version).toBe(STATE_SCHEMA_VERSION);
  });

  it('keeps every session record, its rename, its close stamp and its minted edge', () => {
    const out = migrateState(v5State());
    expect(Object.keys(out.records).sort()).toEqual([S_CHILD, S_PARENT].sort());
    expect(out.records[S_CHILD].title).toBe('a session I renamed');
    expect(out.records[S_CHILD].closed).toBe('2026-08-01T00:00:00.000Z');
    // The edge a fork minted is a fact, not a guess, and survives the model
    // change that retired hand-made re-parenting.
    expect(out.records[S_CHILD].parentId).toBe(S_PARENT);
    expect(out.records[S_CHILD].parentSource).toBe('minted');
  });

  it('folds the nested subproject into its parent as a directory', () => {
    const out = migrateState(v5State());
    expect(out.projects.p_app.dirs).toContain('/Users/u/code/app/api');
    // and does not lose the directory the parent already had
    expect(out.projects.p_app.dirs).toContain('/Users/u/code/app/web');
    expect(out.projects.p_app.provider).toBe('claude');
  });

  it('leaves the folded child as a tombstone, so no window resurrects it', () => {
    const out = migrateState(v5State());
    expect(out.projects.p_api?.deleted).toBe(true);
  });

  it('keeps a live tombstone and sweeps only one past its TTL', () => {
    const out = migrateState(v5State());
    expect(out.projects.p_gone?.deleted).toBe(true);

    const aged = v5State();
    (aged.projects as Record<string, Record<string, unknown>>).p_gone.updatedAt = old;
    expect(migrateState(aged).projects.p_gone).toBeUndefined();
  });

  it('keeps the saved workspace layout and its hidden folders', () => {
    const out = migrateState(v5State());
    expect(out.workspaces?.p_app?.tabs).toHaveLength(2);
    expect(out.hiddenFolders['/Users/u/scratch']).toBeTruthy();
  });

  it('preserves a key it has never heard of, rather than dropping it', () => {
    const withFuture = { ...v5State(), somethingANewerBuildAdded: { keep: 'me' } };
    const out = migrateState(withFuture) as unknown as Record<string, unknown>;
    expect(out.somethingANewerBuildAdded).toEqual({ keep: 'me' });
  });
});

describe('upgrade: a 0.1.0 state.json, which predates versioning entirely', () => {
  it('folds the legacy node map into records without importing guessed edges', () => {
    const v0 = {
      nodes: {
        [S_CHILD]: {
          id: S_CHILD,
          title: 'an old session',
          parentId: S_PARENT,
          parentSource: 'inferred',
        },
      },
    };
    const out = migrateState(v0);
    expect(out.version).toBe(STATE_SCHEMA_VERSION);
    expect(out.records[S_CHILD].title).toBe('an old session');
    // An INFERRED edge is the tree's guess, re-derived from transcripts on
    // every render. Persisting it would promote a guess to a recorded fact.
    expect(out.records[S_CHILD].parentId).toBeUndefined();
  });
});

describe('upgrade: the mixed install, where an unreloaded window still writes v5', () => {
  it('re-runs the ladder without folding a second time', () => {
    const once = migrateState(v5State());
    // What an old window leaves behind: its own version stamp on a file whose
    // content this build has already migrated.
    const asOldWindowWroteIt = { ...once, version: 5 };
    const twice = migrateState(asOldWindowWroteIt);

    expect(twice.version).toBe(STATE_SCHEMA_VERSION);
    expect(
      twice.projects.p_app.dirs.filter((d) => d === '/Users/u/code/app/api'),
    ).toHaveLength(1);
    expect(twice.projects.p_api?.deleted).toBe(true);
    expect(Object.keys(twice.records).sort()).toEqual([S_CHILD, S_PARENT].sort());
  });

  it('is idempotent once it has settled', () => {
    const settled = migrateState(v5State());
    expect(migrateState(settled)).toEqual(settled);
  });

  it('does not re-fold a subproject an old window has just re-created', () => {
    // The old build still has the nested-project verb, so it can add one back.
    // The next load of this build folds it, exactly as the first upgrade did —
    // which is what "keyed on the version the file claims" buys.
    const settled = migrateState(v5State()) as unknown as Record<string, unknown>;
    const projects = settled.projects as Record<string, unknown>;
    projects.p_new = {
      id: 'p_new',
      name: 'another lane the old window made',
      rootDir: '/Users/u/code/app/docs',
      dirs: [],
      parentId: 'p_app',
      createdAt: recent,
      updatedAt: recent,
    };
    const out = migrateState({ ...settled, version: 5 });
    expect(out.projects.p_app.dirs).toContain('/Users/u/code/app/docs');
    expect(out.projects.p_new?.deleted).toBe(true);
    // and the first fold is still not duplicated
    expect(
      out.projects.p_app.dirs.filter((d) => d === '/Users/u/code/app/api'),
    ).toHaveLength(1);
  });
});
