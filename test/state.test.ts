// test/state.test.ts — owner B. Covers SPEC §9's state-migration suite plus
// the four properties the design actually stands on: concurrent-write merge,
// corrupt-file recovery, schema migration, and reload/watcher debouncing.
//
// Everything here runs against real temp directories: the store's whole job
// is the fs dance (same-dir temp file, fsync, verify, rename), and a mocked fs
// would test the mock instead.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { StateStore, mergeStates, migrateState, nowIso } from '../src/state';
import {
  STATE_SCHEMA_VERSION,
  type EditorialRecord,
  type LineageState,
  type WindowRecord,
} from '../src/types';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
const S4 = '44444444-4444-4444-8444-444444444444';

const dirs: string[] = [];
const stores: StateStore[] = [];

function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-state-'));
  dirs.push(d);
  return d;
}

function makeStore(dir: string, opts?: ConstructorParameters<typeof StateStore>[1]): StateStore {
  const s = new StateStore(dir, opts);
  stores.push(s);
  return s;
}

function readFile(dir: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) as unknown;
}

function listing(dir: string): string[] {
  return fs.readdirSync(dir).sort();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function record(id: string, updatedAt: string, extra: Partial<EditorialRecord> = {}): EditorialRecord {
  return { id, createdAt: updatedAt, updatedAt, ...extra };
}

function windowRec(id: string, pid: number, publishedAt = nowIso()): WindowRecord {
  return {
    windowId: id,
    focusHandle: { uri: `vscode://creemux.lineage-sessions/focus?windowId=${id}` },
    pid,
    publishedAt,
  };
}

function state(partial: Partial<LineageState> = {}): LineageState {
  return {
    version: STATE_SCHEMA_VERSION,
    records: {},
    windows: {},
    ...partial,
  };
}

afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------- lifecycle

describe('StateStore: load and first write', () => {
  it('creates a globalStorage dir that does not exist yet', async () => {
    const base = tempDir();
    const dir = path.join(base, 'nested', 'globalStorage');
    const store = makeStore(dir);
    await store.load();
    expect(fs.existsSync(dir)).toBe(true);
    expect(store.all()).toEqual({});
    expect(store.filePath).toBe(path.join(dir, 'state.json'));
  });

  it('writes state.json on the first upsert and leaves no temp file behind', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.load();
    expect(fs.existsSync(store.filePath)).toBe(false);

    await store.upsert(S1, { title: 'first' });

    expect(fs.existsSync(store.filePath)).toBe(true);
    expect(listing(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(listing(dir)).toEqual(['state.json']);
    const blob = readFile(dir) as LineageState;
    expect(blob.version).toBe(STATE_SCHEMA_VERSION);
    expect(blob.records[S1]?.title).toBe('first');
  });

  it('round-trips through a second store on the same directory', async () => {
    const dir = tempDir();
    const a = makeStore(dir);
    await a.load();
    await a.upsert(S1, { title: 'kept', cwd: '/tmp/x' });

    const b = makeStore(dir);
    await b.load();
    expect(b.get(S1)?.title).toBe('kept');
    expect(b.get(S1)?.cwd).toBe('/tmp/x');
    expect(b.get(S1)?.createdAt).toBeTruthy();
    expect(b.get(S1)?.updatedAt).toBeTruthy();
  });

  it('survives a load() on an unreadable directory without throwing', async () => {
    const dir = tempDir();
    // A file where the directory should be: mkdir fails, reads fail.
    const blocked = path.join(dir, 'blocked');
    fs.writeFileSync(blocked, 'not a directory');
    const store = makeStore(blocked);
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.all()).toEqual({});
    // and a mutation degrades to memory-only instead of exploding
    await expect(store.upsert(S1, { title: 'x' })).resolves.toBeUndefined();
    expect(store.get(S1)?.title).toBe('x');
  });
});

// -------------------------------------------------------------------- upsert

describe('StateStore.upsert merge semantics (mirrors Python upsert_node)', () => {
  it('never clobbers an existing field with undefined, but writes explicit null', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.load();

    await store.upsert(S1, {
      title: 'keep me',
      closed: '2026-07-27T10:00:00.000Z',
      boundWindowId: 'w1',
    });
    await store.upsert(S1, { title: undefined, summary: 'added' });

    expect(store.get(S1)?.title).toBe('keep me');
    expect(store.get(S1)?.summary).toBe('added');

    await store.upsert(S1, { closed: null, boundWindowId: null });
    expect(store.get(S1)?.closed).toBeNull();
    expect(store.get(S1)?.boundWindowId).toBeNull();
    expect(store.get(S1)?.title).toBe('keep me');
  });

  it('stamps createdAt once and updatedAt on every write', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.load();

    await store.upsert(S1, { title: 'a' });
    const first = store.get(S1);
    await delay(5);
    await store.upsert(S1, { title: 'b' });
    const second = store.get(S1);

    expect(second?.createdAt).toBe(first?.createdAt);
    expect(second?.updatedAt).not.toBe(first?.updatedAt);
    expect(second?.updatedAt.localeCompare(first?.updatedAt ?? '')).toBeGreaterThan(0);
  });

  it('ignores id/createdAt/updatedAt supplied in the patch', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.load();
    await store.upsert(S1, {
      id: S2,
      createdAt: '1999-01-01T00:00:00.000Z',
      updatedAt: '1999-01-01T00:00:00.000Z',
      title: 't',
    });
    const rec = store.get(S1);
    expect(rec?.id).toBe(S1);
    expect(rec?.createdAt.startsWith('1999')).toBe(false);
    expect(rec?.updatedAt.startsWith('1999')).toBe(false);
  });

  it('refuses to persist an inferred parentSource', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.load();
    await store.upsert(S1, { parentId: S2, parentSource: 'forkedFrom' });
    expect(store.get(S1)?.parentSource).toBeUndefined();
    expect(store.get(S1)?.parentId).toBe(S2);

    await store.upsert(S1, { parentId: S2, parentSource: 'reparent' });
    expect(store.get(S1)?.parentSource).toBe('reparent');
  });

  it('ignores a non-session id instead of writing junk', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.load();
    await store.upsert('not-a-uuid', { title: 'nope' });
    expect(store.all()).toEqual({});
    expect(fs.existsSync(store.filePath)).toBe(false);
  });

  it('hands out copies so callers cannot mutate the store', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.load();
    await store.upsert(S1, { title: 'original' });

    const copy = store.get(S1);
    if (copy) copy.title = 'tampered';
    const all = store.all();
    delete all[S1];

    expect(store.get(S1)?.title).toBe('original');
    expect(Object.keys(store.all())).toEqual([S1]);
  });

  it('recordLaunch writes an exact minted edge, including a null parent', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.load();

    await store.recordLaunch(S2, S1, '/repo');
    expect(store.get(S2)).toMatchObject({
      parentId: S1,
      parentSource: 'minted',
      launchedByUs: true,
      cwd: '/repo',
    });

    await store.recordLaunch(S3, null);
    expect(store.get(S3)).toMatchObject({
      parentId: null,
      parentSource: 'minted',
      launchedByUs: true,
    });
  });
});

// ----------------------------------------------------------------- migration

describe('migrateState', () => {
  it('turns anything that is not an object into a fresh v1 state', () => {
    for (const junk of ['x', [], null, 42, undefined, true]) {
      expect(migrateState(junk)).toEqual(state());
    }
  });

  it('stamps the schema version whatever the file claimed', () => {
    expect(migrateState({ records: {}, windows: {} }).version).toBe(STATE_SCHEMA_VERSION);
    expect(migrateState({ version: 'seven', records: {} }).version).toBe(STATE_SCHEMA_VERSION);
    expect(migrateState({ version: 99, records: {} }).version).toBe(STATE_SCHEMA_VERSION);
  });

  it('drops records whose key is not a session id', () => {
    const migrated = migrateState({
      version: 1,
      records: { [S1]: record(S1, nowIso()), main: { id: 'main' }, '': {} },
      windows: {},
    });
    expect(Object.keys(migrated.records)).toEqual([S1]);
  });

  it('drops record values that are not objects', () => {
    const migrated = migrateState({
      version: 1,
      records: { [S1]: 'nope', [S2]: ['also nope'], [S3]: record(S3, nowIso()) },
    });
    expect(Object.keys(migrated.records)).toEqual([S3]);
  });

  it('scrubs inferred parentSource values and bogus parentIds', () => {
    const migrated = migrateState({
      version: 1,
      records: {
        [S1]: { ...record(S1, nowIso()), parentSource: 'forkedFrom', parentId: S2 },
        [S2]: { ...record(S2, nowIso()), parentSource: 'minted', parentId: S3 },
        [S3]: { ...record(S3, nowIso()), parentSource: 'reparent', parentId: 'garbage' },
      },
    });
    expect(migrated.records[S1]?.parentSource).toBeUndefined();
    expect(migrated.records[S1]?.parentId).toBe(S2);
    expect(migrated.records[S2]?.parentSource).toBe('minted');
    expect(migrated.records[S3]?.parentSource).toBe('reparent');
    expect(migrated.records[S3]?.parentId).toBeUndefined();
  });

  it('fills missing timestamps and forces id to the map key', () => {
    const migrated = migrateState({ version: 1, records: { [S1]: { title: 'x' } } });
    const rec = migrated.records[S1];
    expect(rec?.id).toBe(S1);
    expect(rec?.createdAt).toBeTruthy();
    expect(rec?.updatedAt).toBe(rec?.createdAt);
  });

  it('preserves unknown top-level keys and unknown record fields', () => {
    const migrated = migrateState({
      version: 1,
      futureFeature: { anything: [1, 2, 3] },
      records: { [S1]: { ...record(S1, nowIso()), futureField: 'keep' } },
    }) as LineageState & { futureFeature?: unknown };
    expect(migrated.futureFeature).toEqual({ anything: [1, 2, 3] });
    expect((migrated.records[S1] as unknown as Record<string, unknown>).futureField).toBe('keep');
  });

  it('keeps only well-formed window records', () => {
    const good = windowRec('w-good', 4242);
    const migrated = migrateState({
      version: 1,
      windows: {
        'w-good': good,
        'w-nohandle': { windowId: 'w-nohandle', pid: 1 },
        'w-nopid': { windowId: 'w-nopid', focusHandle: { uri: 'x' } },
        'w-badhandle': { windowId: 'w-badhandle', focusHandle: { uri: 7 }, pid: 1 },
        'w-scalar': 'nope',
      },
    });
    expect(Object.keys(migrated.windows)).toEqual(['w-good']);
    expect(migrated.windows['w-good']?.focusHandle.uri).toBe(good.focusHandle.uri);
  });

  it('keeps hookInstall only when it carries a boolean `installed`', () => {
    expect(migrateState({ hookInstall: { installed: true, pluginVersion: 1 } }).hookInstall)
      .toEqual({ installed: true, pluginVersion: 1 });
    expect(migrateState({ hookInstall: { installed: 'yes' } }).hookInstall).toBeUndefined();
    expect(migrateState({ hookInstall: 'installed' }).hookInstall).toBeUndefined();
  });

  it('folds a legacy (v0) creemux node map into records without importing guessed edges', () => {
    const migrated = migrateState({
      slug: 'creemux-addon',
      nodes: {
        [S1]: {
          id: S1,
          parent: S2, // inferred in the Python — must NOT become a minted edge
          title: 'old title',
          summary: 'old summary',
          hidden: true,
          cwd: '/repo',
          created: '2026-01-01T00:00:00.000Z',
        },
        broken: { id: 'broken' },
      },
    }) as LineageState & { nodes?: unknown; slug?: unknown };

    expect(Object.keys(migrated.records)).toEqual([S1]);
    expect(migrated.records[S1]).toMatchObject({
      id: S1,
      title: 'old title',
      summary: 'old summary',
      hidden: true,
      cwd: '/repo',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(migrated.records[S1]?.parentId).toBeUndefined();
    expect(migrated.records[S1]?.parentSource).toBeUndefined();
    // the legacy blob is preserved verbatim, nothing is destroyed by the fold
    expect(migrated.nodes).toBeTruthy();
    expect(migrated.slug).toBe('creemux-addon');
  });

  it('does not re-fold once records already exist', () => {
    const migrated = migrateState({
      nodes: { [S1]: { id: S1, title: 'legacy' } },
      records: { [S2]: record(S2, nowIso(), { title: 'current' }) },
    });
    expect(Object.keys(migrated.records)).toEqual([S2]);
  });

  it('preserves unknown top-level keys across a real write', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, records: {}, windows: {}, futureFeature: { a: 1 } }),
    );
    const store = makeStore(dir);
    await store.load();
    await store.upsert(S1, { title: 'x' });

    const blob = readFile(dir) as LineageState & { futureFeature?: unknown };
    expect(blob.futureFeature).toEqual({ a: 1 });
    expect(blob.records[S1]?.title).toBe('x');
  });
});

// --------------------------------------------------------------------- merge

describe('mergeStates', () => {
  const older = '2026-07-27T10:00:00.000Z';
  const newer = '2026-07-27T11:00:00.000Z';

  it('takes the newer record whichever side it is on', () => {
    const disk = state({
      records: {
        [S1]: record(S1, newer, { title: 'disk-new' }),
        [S2]: record(S2, older, { title: 'disk-old' }),
      },
    });
    const mem = state({
      records: {
        [S1]: record(S1, older, { title: 'mem-old' }),
        [S2]: record(S2, newer, { title: 'mem-new' }),
      },
    });
    const merged = mergeStates(disk, mem);
    expect(merged.records[S1]?.title).toBe('disk-new');
    expect(merged.records[S2]?.title).toBe('mem-new');
  });

  it('unions records that exist on only one side', () => {
    const merged = mergeStates(
      state({ records: { [S1]: record(S1, older) } }),
      state({ records: { [S2]: record(S2, older) } }),
    );
    expect(Object.keys(merged.records).sort()).toEqual([S1, S2].sort());
  });

  it('breaks updatedAt ties in favour of memory', () => {
    const merged = mergeStates(
      state({ records: { [S1]: record(S1, older, { title: 'disk' }) } }),
      state({ records: { [S1]: record(S1, older, { title: 'mem' }) } }),
    );
    expect(merged.records[S1]?.title).toBe('mem');
  });

  it('unions windows by id with the newer publishedAt winning', () => {
    const merged = mergeStates(
      state({
        windows: {
          a: windowRec('a', 1, newer),
          b: windowRec('b', 2, older),
        },
      }),
      state({
        windows: {
          a: windowRec('a', 111, older),
          c: windowRec('c', 3, newer),
        },
      }),
    );
    expect(Object.keys(merged.windows).sort()).toEqual(['a', 'b', 'c']);
    expect(merged.windows.a?.pid).toBe(1); // disk's newer record kept
  });

  it('prefers memory hookInstall, falls back to disk, and unions unknown keys', () => {
    const disk = { ...state({ hookInstall: { installed: false } }), extra: 'disk' };
    const mem = { ...state({ hookInstall: { installed: true } }), other: 'mem' };
    const merged = mergeStates(disk, mem) as LineageState & {
      extra?: string;
      other?: string;
    };
    expect(merged.hookInstall).toEqual({ installed: true });
    expect(merged.extra).toBe('disk');
    expect(merged.other).toBe('mem');

    const fallback = mergeStates(state({ hookInstall: { installed: true } }), state());
    expect(fallback.hookInstall).toEqual({ installed: true });
  });
});

// --------------------------------------------------------------- concurrency

describe('StateStore: concurrent writers', () => {
  it('preserves another window\'s record across a sequential read-merge-write', async () => {
    const dir = tempDir();
    const a = makeStore(dir);
    const b = makeStore(dir);
    await a.load();
    await a.upsert(S1, { title: 'from A' });

    await b.load();
    await b.upsert(S2, { title: 'from B' });

    const blob = readFile(dir) as LineageState;
    expect(blob.records[S1]?.title).toBe('from A');
    expect(blob.records[S2]?.title).toBe('from B');
  });

  it('merges two windows writing at the same time', async () => {
    const dir = tempDir();
    const a = makeStore(dir);
    const b = makeStore(dir);
    await Promise.all([a.load(), b.load()]);

    await Promise.all([
      a.upsert(S1, { title: 'from A' }),
      b.upsert(S2, { title: 'from B' }),
    ]);

    const blob = readFile(dir) as LineageState;
    expect(blob.records[S1]?.title).toBe('from A');
    expect(blob.records[S2]?.title).toBe('from B');
  });

  it('loses nothing when two windows interleave many writes', async () => {
    const dir = tempDir();
    const a = makeStore(dir);
    const b = makeStore(dir);
    await Promise.all([a.load(), b.load()]);

    const ids = Array.from(
      { length: 6 },
      (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    await Promise.all(
      ids.map((id, i) =>
        (i % 2 === 0 ? a : b).upsert(id, { title: `n${String(i)}` }),
      ),
    );

    const blob = readFile(dir) as LineageState;
    for (const [i, id] of ids.entries()) {
      expect(blob.records[id]?.title).toBe(`n${String(i)}`);
    }
    expect(listing(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('coalesces a burst of mutations in one window into few writes', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.load();

    await Promise.all([
      store.upsert(S1, { title: 'one' }),
      store.upsert(S2, { title: 'two' }),
      store.upsert(S3, { title: 'three' }),
      store.upsert(S4, { title: 'four' }),
    ]);

    const blob = readFile(dir) as LineageState;
    expect(blob.records[S1]?.title).toBe('one');
    expect(blob.records[S2]?.title).toBe('two');
    expect(blob.records[S3]?.title).toBe('three');
    expect(blob.records[S4]?.title).toBe('four');
    // 4 mutations, but the ones queued behind the first flush ride along
    expect(store.stats.writes).toBeGreaterThanOrEqual(1);
    expect(store.stats.writes).toBeLessThanOrEqual(2);
  });

  it('breaks a stale lock left behind by a window that died mid-write', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.load();

    const lock = path.join(dir, 'state.json.lock');
    fs.writeFileSync(lock, '999999 crashed\n');
    const ancient = (Date.now() - 60_000) / 1000;
    fs.utimesSync(lock, ancient, ancient);

    await store.upsert(S1, { title: 'after the crash' });

    expect((readFile(dir) as LineageState).records[S1]?.title).toBe('after the crash');
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('leaves no lock or temp file behind after a normal write', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.load();
    await store.upsert(S1, { title: 'x' });
    await store.publishWindow(windowRec('w', process.pid));
    expect(listing(dir)).toEqual(['state.json']);
  });

  it('keeps two rapid mutations of the SAME record (last field wins, none lost)', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.load();

    await Promise.all([
      store.upsert(S1, { title: 'renamed' }),
      store.upsert(S1, { summary: 'wrapped' }),
      store.upsert(S1, { hidden: true }),
    ]);

    const blob = readFile(dir) as LineageState;
    expect(blob.records[S1]).toMatchObject({
      title: 'renamed',
      summary: 'wrapped',
      hidden: true,
    });
  });
});

// ------------------------------------------------------------------- corrupt

describe('StateStore: corrupt-file recovery', () => {
  it('backs up unparseable JSON and starts fresh', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'state.json'), '{ this is not json');
    const store = makeStore(dir);
    await store.load();

    expect(store.all()).toEqual({});
    expect(store.stats.corruptBackups).toBe(1);
    const backups = listing(dir).filter((n) => n.startsWith('state.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, backups[0] ?? ''), 'utf8')).toBe(
      '{ this is not json',
    );

    await store.upsert(S1, { title: 'after recovery' });
    const blob = readFile(dir) as LineageState;
    expect(blob.records[S1]?.title).toBe('after recovery');
  });

  it('treats valid JSON that is not an object as corrupt', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'state.json'), '"just a string"');
    const store = makeStore(dir);
    await store.load();
    expect(store.stats.corruptBackups).toBe(1);
    expect(store.all()).toEqual({});
  });

  it('does not back up the same corrupt blob twice', async () => {
    const dir = tempDir();
    const garbage = 'not json at all';
    fs.writeFileSync(path.join(dir, 'state.json'), garbage);
    const store = makeStore(dir, { reloadDebounceMs: 1 });
    await store.load();
    expect(store.stats.corruptBackups).toBe(1);

    fs.writeFileSync(path.join(dir, 'state.json'), garbage);
    await store.reloadFromDisk();
    expect(store.stats.corruptBackups).toBe(1);
    expect(listing(dir).filter((n) => n.startsWith('state.json.corrupt-'))).toHaveLength(1);
  });

  it('does not resurrect a corrupt file into the tree', async () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      '{"version":1,"records":{"' + S1 + '":{"title":"good"}},',
    );
    const store = makeStore(dir);
    await store.load();
    expect(store.get(S1)).toBeUndefined();
  });
});

// -------------------------------------------------------------- window layer

describe('StateStore: per-window records', () => {
  const alive = (pids: number[]) => (pid: number): boolean => pids.includes(pid);

  it('publishes its own record and prunes windows whose pid is gone', async () => {
    const dir = tempDir();
    const seed = makeStore(dir);
    await seed.load();
    await seed.publishWindow(windowRec('dead-window', 999_001), alive([999_001]));

    const store = makeStore(dir, { isAlive: alive([999_002]) });
    await store.load();
    await store.publishWindow(windowRec('live-window', 999_002));

    const blob = readFile(dir) as LineageState;
    expect(Object.keys(blob.windows)).toEqual(['live-window']);
    expect(store.getWindows().map((w) => w.windowId)).toEqual(['live-window']);
  });

  it('prunes window records older than seven days even when the pid looks alive', async () => {
    const dir = tempDir();
    const store = makeStore(dir, { isAlive: () => true });
    await store.load();
    const stale = windowRec('stale', 1, new Date(Date.now() - 8 * 86_400_000).toISOString());
    await store.publishWindow(stale);
    await store.publishWindow(windowRec('fresh', 2));

    const blob = readFile(dir) as LineageState;
    expect(Object.keys(blob.windows)).toEqual(['fresh']);
  });

  it('clears session bindings that pointed at a pruned window', async () => {
    const dir = tempDir();
    const store = makeStore(dir, { isAlive: alive([2]) });
    await store.load();
    await store.publishWindow(windowRec('gone', 1), () => true);
    await store.upsert(S1, { boundWindowId: 'gone' });
    await store.upsert(S2, { boundWindowId: 'other' });

    await store.publishWindow(windowRec('here', 2));

    expect(store.get(S1)?.boundWindowId).toBeNull();
    expect(store.get(S2)?.boundWindowId).toBe('other');
  });

  it('removeWindow drops the record and its bindings', async () => {
    const dir = tempDir();
    const store = makeStore(dir, { isAlive: () => true });
    await store.load();
    await store.publishWindow(windowRec('w1', 10));
    await store.upsert(S1, { boundWindowId: 'w1' });

    await store.removeWindow('w1');

    expect(store.getWindows()).toEqual([]);
    expect(store.get(S1)?.boundWindowId).toBeNull();
  });

  it('refuses a malformed window record instead of writing it', async () => {
    const dir = tempDir();
    const store = makeStore(dir, { isAlive: () => true });
    await store.load();
    await store.publishWindow({ windowId: '', focusHandle: { uri: '' }, pid: 0, publishedAt: '' });
    expect(store.getWindows()).toEqual([]);
  });

  it('namespaces windows so one window never clobbers another', async () => {
    const dir = tempDir();
    const a = makeStore(dir, { isAlive: () => true });
    const b = makeStore(dir, { isAlive: () => true });
    await Promise.all([a.load(), b.load()]);
    await Promise.all([
      a.publishWindow(windowRec('win-a', 101)),
      b.publishWindow(windowRec('win-b', 102)),
    ]);
    const blob = readFile(dir) as LineageState;
    expect(Object.keys(blob.windows).sort()).toEqual(['win-a', 'win-b']);
  });
});

// ---------------------------------------------------------------- hook state

describe('StateStore: hook install state', () => {
  it('defaults to not-installed and round-trips through disk', async () => {
    const dir = tempDir();
    const a = makeStore(dir);
    await a.load();
    expect(a.getHookState()).toEqual({ installed: false });

    await a.setHookState({ installed: true, pluginDir: '/h/.claude/skills/lineage-events', pluginVersion: 1 });
    const b = makeStore(dir);
    await b.load();
    expect(b.getHookState()).toMatchObject({ installed: true, pluginVersion: 1 });
  });
});

// ------------------------------------------------------- reload + debouncing

describe('StateStore.reloadFromDisk', () => {
  it('fires onDidChange once for a real external change and never for an identical re-read', async () => {
    const dir = tempDir();
    const a = makeStore(dir, { reloadDebounceMs: 1 });
    const b = makeStore(dir);
    await a.load();
    await b.load();
    await b.upsert(S1, { title: 'written by the other window' });

    let events = 0;
    a.onDidChange(() => {
      events += 1;
    });

    await a.reloadFromDisk();
    expect(events).toBe(1);
    expect(a.get(S1)?.title).toBe('written by the other window');

    await a.reloadFromDisk();
    await a.reloadFromDisk();
    expect(events).toBe(1);
  });

  it('does not fire for the window\'s own write round-tripping through the watcher', async () => {
    const dir = tempDir();
    const store = makeStore(dir, { reloadDebounceMs: 1 });
    await store.load();
    await store.upsert(S1, { title: 'local' });

    let events = 0;
    store.onDidChange(() => {
      events += 1;
    });
    await store.reloadFromDisk();
    expect(events).toBe(0);
  });

  it('fires onDidChange for a local mutation that changes content', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.load();
    let events = 0;
    store.onDidChange(() => {
      events += 1;
    });
    await store.upsert(S1, { title: 'x' });
    expect(events).toBe(1);
  });

  it('coalesces a burst of watcher callbacks into a single read', async () => {
    const dir = tempDir();
    const b = makeStore(dir);
    await b.load();
    await b.upsert(S1, { title: 'x' });

    const store = makeStore(dir, { reloadDebounceMs: 5 });
    await store.load();
    const before = store.stats.reads;

    await Promise.all([
      store.reloadFromDisk(),
      store.reloadFromDisk(),
      store.reloadFromDisk(),
      store.reloadFromDisk(),
      store.reloadFromDisk(),
    ]);

    expect(store.stats.reads).toBe(before + 1);
  });

  it('schedules exactly one timer per burst (injected clock)', async () => {
    const dir = tempDir();
    const seed = makeStore(dir);
    await seed.load();
    await seed.upsert(S1, { title: 'seeded' });

    const scheduled: Array<() => void> = [];
    let cleared = 0;
    const store = makeStore(dir, {
      setTimeout: (fn) => {
        scheduled.push(fn);
        return scheduled.length;
      },
      clearTimeout: () => {
        cleared += 1;
      },
    });
    await store.load();
    const before = store.stats.reads;

    const p1 = store.reloadFromDisk();
    const p2 = store.reloadFromDisk();
    const p3 = store.reloadFromDisk();
    expect(scheduled).toHaveLength(1);

    scheduled[0]?.();
    await Promise.all([p1, p2, p3]);
    expect(store.stats.reads).toBe(before + 1);

    // a later burst gets its own timer
    const p4 = store.reloadFromDisk();
    expect(scheduled).toHaveLength(2);
    scheduled[1]?.();
    await p4;
    expect(store.stats.reads).toBe(before + 2);

    store.dispose();
    expect(cleared).toBe(0); // nothing pending at dispose time
  });

  it('resolves any pending reload when disposed mid-debounce', async () => {
    const dir = tempDir();
    const scheduled: Array<() => void> = [];
    const store = makeStore(dir, {
      setTimeout: (fn) => {
        scheduled.push(fn);
        return scheduled.length;
      },
      clearTimeout: () => undefined,
    });
    await store.load();
    const pending = store.reloadFromDisk();
    store.dispose();
    await expect(pending).resolves.toBeUndefined();
    // and a disposed store stops queueing work
    await expect(store.reloadFromDisk()).resolves.toBeUndefined();
    await expect(store.upsert(S1, { title: 'x' })).resolves.toBeUndefined();
    expect(store.get(S1)).toBeUndefined();
  });

  it('keeps in-memory state when the file becomes unreadable', async () => {
    const dir = tempDir();
    const store = makeStore(dir, { reloadDebounceMs: 1 });
    await store.load();
    await store.upsert(S1, { title: 'still here' });

    // replace state.json with a directory: reads now fail with EISDIR
    fs.unlinkSync(store.filePath);
    fs.mkdirSync(store.filePath);

    await store.reloadFromDisk();
    expect(store.get(S1)?.title).toBe('still here');
  });
});
