// test/stateHome.test.ts — where the editorial store lives.
//
// The property under test is the one the Cursor-beside-VS-Code incident
// violated: two editor applications on one machine must open ONE store. Real
// temp directories throughout, like state.test.ts and for the same reason —
// the whole job is the fs dance, and a mocked fs would test the mock.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ADOPTED_MARKER_NAME,
  STATE_FILE_NAME,
  adoptLegacyState,
  resolveStateDir,
  sharedStateDir,
} from '../src/stateHome';
import { StateStore } from '../src/state';
import { STATE_SCHEMA_VERSION, type LineageState } from '../src/types';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

const dirs: string[] = [];
const stores: StateStore[] = [];

function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-home-'));
  dirs.push(d);
  return d;
}

/** A home directory with nothing in it yet — the shared store's parent. */
function tempHome(): string {
  return tempDir();
}

function stateFile(dir: string): string {
  return path.join(dir, STATE_FILE_NAME);
}

function readState(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(stateFile(dir), 'utf8')) as Record<
    string,
    unknown
  >;
}

/** A minimal but valid-enough state blob: one project and one record. */
function blob(over: {
  projectId?: string;
  projectName?: string;
  sessionId?: string;
  updatedAt?: string;
}): Record<string, unknown> {
  const at = over.updatedAt ?? '2026-08-30T12:00:00.000Z';
  const state: Record<string, unknown> = { version: STATE_SCHEMA_VERSION };
  if (over.projectId !== undefined) {
    state.projects = {
      [over.projectId]: {
        id: over.projectId,
        name: over.projectName ?? over.projectId,
        rootDir: `/Users/axelh/Documents/${over.projectId}`,
        createdAt: at,
        updatedAt: at,
      },
    };
  }
  if (over.sessionId !== undefined) {
    state.records = {
      [over.sessionId]: {
        id: over.sessionId,
        createdAt: at,
        updatedAt: at,
        title: over.sessionId,
      },
    };
  }
  return state;
}

function seed(dir: string, content: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFile(dir), JSON.stringify(content));
}

afterEach(async () => {
  for (const s of stores.splice(0)) s.dispose();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  await Promise.resolve();
});

describe('sharedStateDir', () => {
  it('is ~/.lineage/state, beside the account profiles', () => {
    expect(sharedStateDir('/Users/axelh')).toBe('/Users/axelh/.lineage/state');
  });

  it('normalises a trailing slash and backslashes to the one spelling', () => {
    expect(sharedStateDir('/Users/axelh/')).toBe('/Users/axelh/.lineage/state');
    expect(sharedStateDir('C:\\Users\\axelh')).toBe(
      'C:/Users/axelh/.lineage/state',
    );
  });

  it('answers "" — never a path — for a home directory it cannot use', () => {
    expect(sharedStateDir('')).toBe('');
    expect(sharedStateDir('   ')).toBe('');
    expect(sharedStateDir(undefined as unknown as string)).toBe('');
  });
});

describe('adoptLegacyState', () => {
  it('seeds the shared store from a first app, byte for byte', () => {
    const legacy = tempDir();
    const shared = path.join(tempHome(), '.lineage', 'state');
    const content = blob({ projectId: 'flock', sessionId: S1 });
    seed(legacy, content);

    expect(adoptLegacyState({ sharedDir: shared, legacyDir: legacy })).toEqual({
      status: 'seeded',
    });
    expect(readState(shared)).toEqual(content);
  });

  it('leaves the legacy file exactly where it was — a downgrade must work', () => {
    const legacy = tempDir();
    const shared = path.join(tempHome(), '.lineage', 'state');
    const content = blob({ projectId: 'flock' });
    seed(legacy, content);
    adoptLegacyState({ sharedDir: shared, legacyDir: legacy });
    expect(readState(legacy)).toEqual(content);
  });

  it('adopts once: the marker stops a second activation re-merging', () => {
    const legacy = tempDir();
    const shared = path.join(tempHome(), '.lineage', 'state');
    seed(legacy, blob({ projectId: 'flock' }));
    adoptLegacyState({ sharedDir: shared, legacyDir: legacy });

    // The shared store moves on — the project is renamed here and nowhere
    // else. A second adoption would hand the old name back.
    seed(shared, blob({ projectId: 'flock', projectName: 'Flock' }));
    expect(adoptLegacyState({ sharedDir: shared, legacyDir: legacy })).toEqual({
      status: 'already',
    });
    const projects = readState(shared).projects as Record<
      string,
      { name: string }
    >;
    expect(projects.flock?.name).toBe('Flock');
    expect(fs.existsSync(path.join(legacy, ADOPTED_MARKER_NAME))).toBe(true);
  });

  it('merges a SECOND app in rather than overwriting the first', () => {
    const home = tempHome();
    const shared = path.join(home, '.lineage', 'state');
    const codeStorage = tempDir();
    const cursorStorage = tempDir();
    seed(codeStorage, blob({ projectId: 'flock', sessionId: S1 }));
    seed(cursorStorage, blob({ projectId: 'basalt', sessionId: S2 }));

    adoptLegacyState({ sharedDir: shared, legacyDir: codeStorage });
    expect(
      adoptLegacyState({ sharedDir: shared, legacyDir: cursorStorage }),
    ).toEqual({ status: 'merged' });

    const merged = readState(shared);
    expect(Object.keys(merged.projects as object).sort()).toEqual([
      'basalt',
      'flock',
    ]);
    expect(Object.keys(merged.records as object).sort()).toEqual([S1, S2]);
  });

  it('resolves a disagreement by the store\u2019s own newest-wins rule', () => {
    const shared = path.join(tempHome(), '.lineage', 'state');
    const legacy = tempDir();
    seed(shared, blob({ projectId: 'flock', projectName: 'stale' }));
    seed(
      legacy,
      blob({
        projectId: 'flock',
        projectName: 'fresh',
        updatedAt: '2026-08-31T12:00:00.000Z',
      }),
    );
    adoptLegacyState({ sharedDir: shared, legacyDir: legacy });
    const projects = readState(shared).projects as Record<
      string,
      { name: string }
    >;
    expect(projects.flock?.name).toBe('fresh');
  });

  it('marks a fresh install adopted with nothing to adopt', () => {
    const legacy = tempDir();
    const shared = path.join(tempHome(), '.lineage', 'state');
    expect(adoptLegacyState({ sharedDir: shared, legacyDir: legacy })).toEqual({
      status: 'none',
    });
    expect(fs.existsSync(stateFile(shared))).toBe(false);
    expect(fs.existsSync(path.join(legacy, ADOPTED_MARKER_NAME))).toBe(true);
  });

  it('fails LOUDLY and touches nothing when the legacy file is corrupt', () => {
    const legacy = tempDir();
    const shared = path.join(tempHome(), '.lineage', 'state');
    const good = blob({ projectId: 'flock' });
    seed(shared, good);
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(stateFile(legacy), '{ not json');

    expect(
      adoptLegacyState({ sharedDir: shared, legacyDir: legacy }).status,
    ).toBe('failed');
    expect(readState(shared)).toEqual(good);
    expect(fs.existsSync(path.join(legacy, ADOPTED_MARKER_NAME))).toBe(false);
  });
});

describe('resolveStateDir', () => {
  it('points the store at the shared directory', () => {
    const home = tempHome();
    const legacy = tempDir();
    seed(legacy, blob({ projectId: 'flock' }));
    expect(resolveStateDir({ legacyDir: legacy, homeDir: home })).toEqual({
      dir: path.join(home, '.lineage', 'state').replace(/\\/g, '/'),
      status: 'seeded',
    });
  });

  it('stays on the legacy directory when there is no home to share in', () => {
    const legacy = tempDir();
    expect(resolveStateDir({ legacyDir: legacy, homeDir: '' })).toEqual({
      dir: legacy,
      status: 'failed',
    });
  });

  it('stays on the legacy directory when the adoption cannot complete', () => {
    const legacy = tempDir();
    fs.writeFileSync(stateFile(legacy), '{ not json');
    const home = tempHome();
    seed(path.join(home, '.lineage', 'state'), blob({ projectId: 'flock' }));
    expect(resolveStateDir({ legacyDir: legacy, homeDir: home })).toEqual({
      dir: legacy,
      status: 'failed',
    });
  });
});

// The whole point, end to end: what the second editor sees.
describe('two editor applications, one flock', () => {
  it('shows the first app\u2019s projects and sessions to the second', async () => {
    const home = tempHome();
    const codeStorage = tempDir();
    const cursorStorage = tempDir();

    // VS Code, on the old build's per-app file: three projects' worth of work.
    seed(
      codeStorage,
      blob({ projectId: 'lineage-sessions', sessionId: S1 }) as LineageState &
        Record<string, unknown>,
    );

    const code = new StateStore(
      resolveStateDir({ legacyDir: codeStorage, homeDir: home }).dir,
    );
    stores.push(code);
    await code.load();
    await code.upsert(S2, { title: 'release', tmux: `lineage-${S2}` });

    // Cursor, opened for the first time, with its own empty globalStorage.
    const cursor = new StateStore(
      resolveStateDir({ legacyDir: cursorStorage, homeDir: home }).dir,
    );
    stores.push(cursor);
    await cursor.load();

    expect(Object.keys(cursor.all()).sort()).toEqual([S1, S2].sort());
    expect(cursor.all()[S2]?.title).toBe('release');
    expect(cursor.getProjects().map((p) => p.id)).toEqual([
      'lineage-sessions',
    ]);
  });
});

// The adoption lock. It runs once per application, ever, so there is no second
// pass to correct a clobber with — see stateHome's ADOPT_LOCK_NAME.
describe('the adoption lock', () => {
  it('defers rather than writing over an adoption already in flight', () => {
    const legacy = tempDir();
    const shared = path.join(tempHome(), '.lineage', 'state');
    seed(shared, blob({ projectId: 'flock' }));
    seed(legacy, blob({ projectId: 'basalt' }));
    fs.writeFileSync(path.join(shared, 'state.json.adopt.lock'), '');

    expect(
      adoptLegacyState({ sharedDir: shared, legacyDir: legacy, lockWaitMs: 0 })
        .status,
    ).toBe('deferred');
    // Untouched, and unmarked — so the next activation finishes the job.
    expect(Object.keys(readState(shared).projects as object)).toEqual(['flock']);
    expect(fs.existsSync(path.join(legacy, ADOPTED_MARKER_NAME))).toBe(false);
  });

  it('breaks a lock a crashed activation left behind', () => {
    const legacy = tempDir();
    const shared = path.join(tempHome(), '.lineage', 'state');
    seed(shared, blob({ projectId: 'flock' }));
    seed(legacy, blob({ projectId: 'basalt' }));
    const lock = path.join(shared, 'state.json.adopt.lock');
    fs.writeFileSync(lock, '');
    const ancient = Date.now() - 60_000;
    fs.utimesSync(lock, ancient / 1000, ancient / 1000);

    expect(
      adoptLegacyState({ sharedDir: shared, legacyDir: legacy }).status,
    ).toBe('merged');
    expect(Object.keys(readState(shared).projects as object).sort()).toEqual([
      'basalt',
      'flock',
    ]);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('releases the lock even when the adoption fails', () => {
    const legacy = tempDir();
    const shared = path.join(tempHome(), '.lineage', 'state');
    seed(shared, blob({ projectId: 'flock' }));
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(stateFile(legacy), '{ not json');

    expect(
      adoptLegacyState({ sharedDir: shared, legacyDir: legacy }).status,
    ).toBe('failed');
    expect(fs.existsSync(path.join(shared, 'state.json.adopt.lock'))).toBe(false);
  });
});
