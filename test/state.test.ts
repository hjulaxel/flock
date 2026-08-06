// test/state.test.ts — the editorial store. The four properties the design
// stands on: concurrent-write merge, corrupt-file recovery, schema migration,
// and reload/watcher debouncing.
//
// Everything here runs against real temp directories: the store's whole job
// is the fs dance (same-dir temp file, fsync, verify, rename), and a mocked fs
// would test the mock instead.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  StateStore,
  mergeChainRecords,
  mergeStates,
  migrateState,
  nowIso,
} from '../src/state';
import {
  EXTENSION_ID,
  STATE_SCHEMA_VERSION,
  type ChainRecord,
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

/** Plant a state.json before any store has touched the directory. */
function seedStateFile(dir: string, blob: unknown): void {
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify(blob, null, 2),
    'utf8',
  );
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
    focusHandle: { uri: `vscode://${EXTENSION_ID}/focus?windowId=${id}` },
    pid,
    publishedAt,
  };
}

function state(partial: Partial<LineageState> = {}): LineageState {
  return {
    version: STATE_SCHEMA_VERSION,
    records: {},
    windows: {},
    projects: {},
    // v7. Materialised on every load like the maps below, so a state this helper
    // builds has to carry it or every deep-equality against a migrated blob fails
    // on an empty object.
    subprojects: {},
    hiddenFolders: {},
    chains: {},
    workspaces: {},
    // `migrateState` materialises both on every load, so a state
    // this helper builds has to carry them or every deep-equality against a
    // migrated blob fails on two empty objects.
    accounts: {},
    accountSettings: {},
    ...partial,
  };
}

afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// -------------------------------------------------- schemaVersionAtLoad

// What state.json claimed BEFORE the ladder ran. It is the only evidence of
// which build an install last ran, it survives exactly one read — the first
// write stamps the file forward — and an upgrade notice keys off it, so the
// capture has to happen at the right moment and then stop happening.
describe('StateStore.schemaVersionAtLoad', () => {
  it('is null before anything has been read', () => {
    const store = makeStore(tempDir());
    expect(store.schemaVersionAtLoad).toBeNull();
  });

  it('is null for a fresh install, where there is no file at all', async () => {
    const store = makeStore(tempDir());
    await store.load();
    expect(store.schemaVersionAtLoad).toBeNull();
  });

  it('reports the version the file claimed, not the one we migrated it to', async () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({ version: 5, records: {}, projects: {} }),
    );
    const store = makeStore(dir);
    await store.load();

    expect(store.schemaVersionAtLoad).toBe(5);
  });

  it('survives the write that stamps the file forward', async () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({ version: 5, records: {}, projects: {} }),
    );
    const store = makeStore(dir);
    await store.load();
    await store.upsert(S1, { title: 'anything' });
    await store.reloadFromDisk();

    // The file now says 7. The question this answers is "what did this install
    // last run", which is still 5 and has to stay 5 for the rest of the window.
    expect((readFile(dir) as LineageState).version).toBe(STATE_SCHEMA_VERSION);
    expect(store.schemaVersionAtLoad).toBe(5);
  });

  it('reads a file with no version at all as 0, not as a fresh install', async () => {
    // A 0.1.0 file predates versioning. It is emphatically not a new install,
    // and telling the two apart is the whole point of the field.
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ nodes: {} }));
    const store = makeStore(dir);
    await store.load();
    expect(store.schemaVersionAtLoad).toBe(0);
  });

  it('reports a corrupt file as null rather than guessing a version for it', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'state.json'), '{not json');
    const store = makeStore(dir);
    await store.load();
    expect(store.schemaVersionAtLoad).toBeNull();
  });
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

  it('folds a legacy (v0) node map into records without importing guessed edges', () => {
    const migrated = migrateState({
      slug: 'legacy-addon',
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
      // hidden in the legacy blob: the hide verb is retired, so the
      // put-away state folds to deleted — off the tree, restorable.
      deleted: true,
      cwd: '/repo',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(migrated.records[S1]?.hidden).toBeUndefined();
    expect(migrated.records[S1]?.parentId).toBeUndefined();
    expect(migrated.records[S1]?.parentSource).toBeUndefined();
    // the legacy blob is preserved verbatim, nothing is destroyed by the fold
    expect(migrated.nodes).toBeTruthy();
    expect(migrated.slug).toBe('legacy-addon');
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

  // `hidden` (muted) and `deleted` (removed from view) are independent
  // flags, so both have to survive a round-trip and be clearable back to false.
  it('persists hidden and deleted independently', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.load();

    await store.upsert(S1, { hidden: true });
    await store.upsert(S2, { deleted: true });

    let blob = readFile(dir) as LineageState;
    expect(blob.records[S1]).toMatchObject({ hidden: true });
    expect(blob.records[S1]?.deleted).toBeUndefined();
    expect(blob.records[S2]).toMatchObject({ deleted: true });

    // Undo has to write an explicit false, not just omit the key.
    await store.upsert(S2, { deleted: false });
    blob = readFile(dir) as LineageState;
    expect(blob.records[S2]?.deleted).toBe(false);
  });

  it('drops a non-boolean deleted rather than trusting it', async () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({
        version: 2,
        records: {
          [S1]: {
            id: S1,
            deleted: 'yes', // a hand-edit; must not read as truthy
            hidden: 1,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          },
        },
        windows: {},
        projects: {},
        hiddenFolders: {},
      }),
    );
    const store = makeStore(dir);
    await store.load();
    expect(store.get(S1)?.deleted).toBeUndefined();
    expect(store.get(S1)?.hidden).toBeUndefined();
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

// ----------------------------------------------------------------- projects

describe('StateStore: projects', () => {
  it('writes a project and reads it back sorted by name', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.load();

    await store.upsertProject('p2', { name: 'Zeta', rootDir: '/zeta' });
    await store.upsertProject('p1', { name: 'alpha', rootDir: '/alpha/' });

    expect(store.getProjects().map((p) => p.name)).toEqual(['alpha', 'Zeta']);
    expect(store.getProject('p1')?.rootDir).toBe('/alpha'); // normalized
    expect(store.getProject('nope')).toBeUndefined();

    const onDisk = readFile(dir) as { projects: Record<string, unknown> };
    expect(Object.keys(onDisk.projects).sort()).toEqual(['p1', 'p2']);
  });

  it('never lets dirs shadow rootDir, whatever the caller passes', async () => {
    const store = makeStore(tempDir());
    await store.load();
    await store.upsertProject('p1', {
      name: 'API',
      rootDir: '/code/api',
      dirs: ['/code/api', '/CODE/API/', '/shared', '/shared'],
    });
    expect(store.getProject('p1')?.dirs).toEqual(['/shared']);
  });

  it('merges a patch instead of replacing the record', async () => {
    const store = makeStore(tempDir());
    await store.load();
    await store.upsertProject('p1', {
      name: 'API',
      rootDir: '/code/api',
      dirs: ['/shared'],
    });
    const created = store.getProject('p1')?.createdAt;

    await store.upsertProject('p1', { name: 'Platform' });
    const after = store.getProject('p1');
    expect(after?.name).toBe('Platform');
    expect(after?.rootDir).toBe('/code/api'); // untouched
    expect(after?.dirs).toEqual(['/shared']); // untouched
    expect(after?.createdAt).toBe(created);
    expect(after?.updatedAt).not.toBe(created);
  });

  it('refuses a project with no usable rootDir', async () => {
    const store = makeStore(tempDir());
    await store.load();
    await store.upsertProject('p1', { name: 'Nowhere' });
    await store.upsertProject('p2', { name: 'Blank', rootDir: '   ' });
    await store.upsertProject('', { name: 'NoId', rootDir: '/x' });
    expect(store.getProjects()).toEqual([]);
  });

  it('falls back to the directory basename when the name is blank', async () => {
    const store = makeStore(tempDir());
    await store.load();
    await store.upsertProject('p1', { name: '  ', rootDir: '/code/api' });
    expect(store.getProject('p1')?.name).toBe('api');
  });

  it('deletes a project without touching anything else', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.load();
    await store.upsertProject('p1', { name: 'A', rootDir: '/a' });
    await store.upsert(S1, { title: 'session' });

    await store.deleteProject('p1');
    expect(store.getProjects()).toEqual([]);
    expect(store.get(S1)?.title).toBe('session');

    // and it stays deleted across a reload from the file we just wrote
    const reader = makeStore(dir);
    await reader.load();
    expect(reader.getProjects()).toEqual([]);
  });

  it('keeps a project a second window wrote', async () => {
    const dir = tempDir();
    const a = makeStore(dir);
    const b = makeStore(dir);
    await a.load();
    await b.load();

    await a.upsertProject('pa', { name: 'From A', rootDir: '/a' });
    await b.upsertProject('pb', { name: 'From B', rootDir: '/b' });

    const reader = makeStore(dir);
    await reader.load();
    expect(reader.getProjects().map((p) => p.id).sort()).toEqual(['pa', 'pb']);
  });

  // Regression: delete used to drop the key outright. `newerWins` keeps any
  // key present on only one side, so it could not tell a delete from "the
  // other window has not heard of this yet" — and a second window still
  // holding the project in memory silently undid a confirmed modal delete on
  // its very next write, permanently.
  it('a delete survives another window writing from stale memory', async () => {
    const dir = tempDir();
    const a = makeStore(dir);
    const b = makeStore(dir);
    await a.load();
    await b.load();

    await a.upsertProject('p1', { name: 'Api', rootDir: '/code/api' });
    await b.reloadFromDisk(); // B now holds the project in memory too
    expect(b.getProject('p1')).toBeDefined();

    await a.deleteProject('p1');
    // B writes something unrelated BEFORE its watcher told it about the delete.
    await b.upsert(S1, { boundWindowId: null });

    const reader = makeStore(dir);
    await reader.load();
    expect(reader.getProjects()).toEqual([]);
    expect(reader.getProject('p1')).toBeUndefined();

    // A does not get it back either, once it re-reads what B wrote.
    await a.reloadFromDisk();
    expect(a.getProjects()).toEqual([]);
  });

  it('keeps the tombstone out of every reader', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.load();
    await store.upsertProject('p1', { name: 'Api', rootDir: '/code/api' });
    await store.deleteProject('p1');

    expect(store.getProjects()).toEqual([]);
    expect(store.getProject('p1')).toBeUndefined();
    // It IS on disk though — that is what makes the delete survive a merge.
    const blob = readFile(dir) as LineageState;
    expect(blob.projects['p1']?.deleted).toBe(true);
  });

  it('sweeps a tombstone older than any window could be', async () => {
    const dir = tempDir();
    seedStateFile(dir, {
      version: 2,
      records: {},
      windows: {},
      hiddenFolders: {},
      projects: {
        old: {
          id: 'old',
          name: '',
          rootDir: '',
          dirs: [],
          deleted: true,
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
        },
        fresh: {
          id: 'fresh',
          name: '',
          rootDir: '',
          dirs: [],
          deleted: true,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
      },
    });
    const store = makeStore(dir);
    await store.load();
    await store.upsert(S1, { title: 'force a write' });

    const blob = readFile(dir) as LineageState;
    expect(blob.projects['old']).toBeUndefined(); // swept
    expect(blob.projects['fresh']?.deleted).toBe(true); // still load-bearing
  });
});

// -------------------------------------------------------------- subprojects

describe('StateStore: subprojects', () => {
  it('stores a parent pointer and clears it with null', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.load();
    await store.upsertProject('app', { name: 'app', rootDir: '/code/app' });
    await store.upsertProject('api', {
      name: 'api',
      rootDir: '/code/app/api',
      parentId: 'app',
    });
    expect(store.getProject('api')?.parentId).toBe('app');

    expect(await store.setProjectParent('api', null)).toBe(true);
    expect(store.getProject('api')?.parentId).toBeUndefined();

    // ...and it survives the round trip through disk.
    expect(await store.setProjectParent('api', 'app')).toBe(true);
    const reader = makeStore(dir);
    await reader.load();
    expect(reader.getProject('api')?.parentId).toBe('app');
  });

  it('refuses a cycle rather than writing one', async () => {
    const store = makeStore(tempDir());
    await store.load();
    await store.upsertProject('app', { name: 'app', rootDir: '/code/app' });
    await store.upsertProject('api', {
      name: 'api',
      rootDir: '/code/app/api',
      parentId: 'app',
    });

    expect(await store.setProjectParent('app', 'api')).toBe(false);
    expect(store.getProject('app')?.parentId).toBeUndefined();
    expect(store.getProject('api')?.parentId).toBe('app');
  });

  it('refuses a project filed under itself, at both doors', async () => {
    const store = makeStore(tempDir());
    await store.load();
    await store.upsertProject('app', { name: 'app', rootDir: '/code/app' });

    expect(await store.setProjectParent('app', 'app')).toBe(false);
    // The sanitizer is the second door: a hand-edited file, or a patch that
    // went through the generic upsert.
    await store.upsertProject('app', { parentId: 'app' });
    expect(store.getProject('app')?.parentId).toBeUndefined();
  });

  it('refuses to re-file a project that does not exist', async () => {
    const store = makeStore(tempDir());
    await store.load();
    expect(await store.setProjectParent('nope', null)).toBe(false);
    expect(store.getProjects()).toEqual([]);
  });

  it('drops a blank pointer at load rather than keeping an empty string', async () => {
    const dir = tempDir();
    seedStateFile(dir, {
      version: 5,
      records: {},
      windows: {},
      projects: {
        api: {
          id: 'api',
          name: 'api',
          rootDir: '/code/api',
          dirs: [],
          parentId: '   ',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
      hiddenFolders: {},
      chains: {},
      workspaces: {},
    });
    const store = makeStore(dir);
    await store.load();
    expect(store.getProject('api')?.parentId).toBeUndefined();
  });

  it('keeps a pointer at a project that is not there — the tree re-roots it', async () => {
    // Deliberate: `projects` is merged newest-wins per record, so a child can
    // legitimately arrive before its parent. Dropping the pointer here would
    // silently un-nest it the moment two windows synced out of order.
    const store = makeStore(tempDir());
    await store.load();
    await store.upsertProject('api', {
      name: 'api',
      rootDir: '/code/api',
      parentId: 'not-here-yet',
    });
    expect(store.getProject('api')?.parentId).toBe('not-here-yet');
  });
});

describe('StateStore: hidden folders', () => {
  it('hides and un-hides a folder by its normalized path', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.load();

    await store.hideFolder('/tmp/junk/');
    expect(store.getHiddenFolders().map((f) => f.path)).toEqual(['/tmp/junk']);

    // un-hiding matches case-insensitively, the same way hiding matches
    await store.unhideFolder('/TMP/JUNK');
    expect(store.getHiddenFolders()).toEqual([]);

    const reader = makeStore(dir);
    await reader.load();
    expect(reader.getHiddenFolders()).toEqual([]);
  });

  it('ignores a blank path on both verbs', async () => {
    const store = makeStore(tempDir());
    await store.load();
    await store.hideFolder('   ');
    await store.unhideFolder('');
    expect(store.getHiddenFolders()).toEqual([]);
  });
});

describe('migrateState: v1 -> v2', () => {
  it('adds the two new maps to a v1 file without disturbing it', () => {
    const migrated = migrateState({
      version: 1,
      records: { [S1]: { id: S1, title: 'kept', createdAt: nowIso(), updatedAt: nowIso() } },
      windows: {},
    });
    expect(migrated.version).toBe(STATE_SCHEMA_VERSION);
    expect(migrated.records[S1].title).toBe('kept');
    expect(migrated.projects).toEqual({});
    expect(migrated.hiddenFolders).toEqual({});
  });

  it('drops a project with no rootDir and keeps the rest', () => {
    const migrated = migrateState({
      version: 2,
      records: {},
      windows: {},
      projects: {
        good: { id: 'good', name: 'Good', rootDir: '/g', dirs: ['/g2'] },
        bad: { id: 'bad', name: 'Bad' },
      },
      hiddenFolders: { '/tmp/junk/': { path: '/tmp/junk/', hiddenAt: nowIso() } },
    });
    expect(Object.keys(migrated.projects)).toEqual(['good']);
    expect(migrated.projects.good.dirs).toEqual(['/g2']);
    expect(Object.keys(migrated.hiddenFolders)).toEqual(['/tmp/junk']);
  });

  it('preserves unknown fields on a project record', () => {
    const migrated = migrateState({
      version: 2,
      projects: {
        p: { id: 'p', name: 'P', rootDir: '/p', futureField: 'keep me' },
      },
    });
    expect(
      (migrated.projects.p as unknown as Record<string, unknown>).futureField,
    ).toBe('keep me');
  });
});

// ------------------------------------------------------------ v5 -> v6
//
// The first step in the ladder that REWRITES rather than adds: a subproject is a
// directory of its parent now, not a project record with a parentId. The rules
// are projects.flattenNestedProjects' and tested there; what is checked here is
// the write — tombstones rather than dropped keys, the ancestor's own directory
// list, and the fact that a file already at v6 is left alone.

describe('migrateState: v5 -> v6, nested projects become directories', () => {
  const proj = (
    id: string,
    name: string,
    rootDir: string,
    over: Record<string, unknown> = {},
  ) => ({
    id,
    name,
    rootDir,
    dirs: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  it('folds the child in, tombstones it, and stamps v6', () => {
    const migrated = migrateState({
      version: 5,
      projects: {
        app: proj('app', 'app', '/code/app'),
        api: proj('api', 'api', '/code/app/api', { parentId: 'app' }),
      },
    });
    expect(migrated.version).toBe(STATE_SCHEMA_VERSION);
    expect(migrated.projects.app.rootDir).toBe('/code/app');
    expect(migrated.projects.app.dirs).toEqual(['/code/app/api']);
    // A TOMBSTONE, never a dropped key: `state.json` is merged newest-wins per
    // record across windows, and a missing key is indistinguishable from "the
    // other window has not heard of this project yet" — so it would come back on
    // that window's next write.
    expect(migrated.projects.api.deleted).toBe(true);
    expect(migrated.projects.api.rootDir).toBe('');
  });

  it('keeps the child’s createdAt on its tombstone', () => {
    const migrated = migrateState({
      version: 5,
      projects: {
        app: proj('app', 'app', '/code/app'),
        api: proj('api', 'api', '/code/app/api', {
          parentId: 'app',
          createdAt: '2025-05-05T00:00:00.000Z',
        }),
      },
    });
    expect(migrated.projects.api.createdAt).toBe('2025-05-05T00:00:00.000Z');
    // And a fresh `updatedAt`, or the tombstone would lose the merge to the live
    // copy an older window is still holding.
    expect(migrated.projects.api.updatedAt).not.toBe('2025-05-05T00:00:00.000Z');
  });

  it('leaves a flat v5 file completely alone', () => {
    const migrated = migrateState({
      version: 5,
      projects: {
        app: proj('app', 'app', '/code/app', { dirs: ['/code/app/extra'] }),
      },
    });
    expect(migrated.projects.app.dirs).toEqual(['/code/app/extra']);
    expect(migrated.projects.app.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('does not run again on a file already at v6', () => {
    // A nested record that survives to a v6 file — hand-edited, or merged in from
    // an older window after this one stamped the version — renders nested until
    // the version drops below 6 again. The ladder is keyed on the version the FILE
    // claims, which is what makes the step self-healing under a mixed install
    // rather than a one-shot that can be missed.
    const migrated = migrateState({
      version: 6,
      projects: {
        app: proj('app', 'app', '/code/app'),
        api: proj('api', 'api', '/code/app/api', { parentId: 'app' }),
      },
    });
    expect(migrated.projects.app.dirs).toEqual([]);
    expect(migrated.projects.api.deleted).toBeUndefined();
    expect(migrated.projects.api.parentId).toBe('app');
  });

  it('re-migrates when an older window has written v5 back', () => {
    const migrated = migrateState({
      version: 5,
      projects: {
        app: proj('app', 'app', '/code/app'),
        api: proj('api', 'api', '/code/app/api', { parentId: 'app' }),
      },
    });
    const again = migrateState({ ...migrated, version: 5 });
    expect(again.projects.app.dirs).toEqual(['/code/app/api']);
    expect(again.projects.api.deleted).toBe(true);
  });

  it('collapses a whole chain and leaves one live project', () => {
    const migrated = migrateState({
      version: 5,
      projects: {
        a: proj('a', 'a', '/a'),
        b: proj('b', 'b', '/a/b', { parentId: 'a' }),
        c: proj('c', 'c', '/a/b/c', { parentId: 'b' }),
      },
    });
    expect(migrated.projects.a.dirs).toEqual(['/a/b', '/a/b/c']);
    expect(migrated.projects.b.deleted).toBe(true);
    expect(migrated.projects.c.deleted).toBe(true);
  });

  it('does not touch records, so no session moves', () => {
    // Membership has always been derived from the cwd, which is exactly why this
    // migration can throw a project record away without losing a session.
    const migrated = migrateState({
      version: 5,
      records: {
        [S1]: { id: S1, cwd: '/code/app/api', createdAt: nowIso(), updatedAt: nowIso() },
      },
      projects: {
        app: proj('app', 'app', '/code/app'),
        api: proj('api', 'api', '/code/app/api', { parentId: 'app' }),
      },
    });
    expect(migrated.records[S1].cwd).toBe('/code/app/api');
  });
});

// --------------------------------------------------------- generation chains

describe('state: generation chains', () => {
  const chain = (
    rootId: string,
    members: string[],
    stamps: Partial<Pick<ChainRecord, 'createdAt' | 'updatedAt'>> = {},
  ): ChainRecord => ({
    rootId,
    members,
    createdAt: stamps.createdAt ?? '2026-07-01T00:00:00.000Z',
    updatedAt: stamps.updatedAt ?? '2026-07-01T00:00:00.000Z',
  });

  it('appendChainMember creates, extends mid-chain, and dedupes', async () => {
    const store = makeStore(tempDir());
    await store.load();

    await store.appendChainMember(S1, S2);
    expect(store.getChains()).toHaveLength(1);
    expect(store.getChains()[0]?.rootId).toBe(S1);
    expect(store.getChains()[0]?.members).toEqual([S1, S2]);

    // Anchor on the MIDDLE of the chain — the hook's node id after a second
    // re-key is the previous generation, not the root.
    await store.appendChainMember(S2, S3);
    expect(store.getChains()[0]?.members).toEqual([S1, S2, S3]);

    // Repeats and self-links are no-ops.
    await store.appendChainMember(S1, S2);
    await store.appendChainMember(S3, S3);
    expect(store.getChains()).toHaveLength(1);
    expect(store.getChains()[0]?.members).toEqual([S1, S2, S3]);
  });

  it('appendChainMember merges two chains observed independently', async () => {
    const store = makeStore(tempDir());
    await store.load();
    await store.appendChainMember(S1, S2);
    await store.appendChainMember(S3, S4);
    expect(store.getChains()).toHaveLength(2);

    await store.appendChainMember(S2, S3); // links them
    const chains = store.getChains();
    expect(chains).toHaveLength(1);
    expect(chains[0]?.rootId).toBe(S1);
    expect([...chains[0]!.members].sort()).toEqual([S1, S2, S3, S4].sort());
  });

  it('chains survive a round trip and sanitize junk on load', async () => {
    const dir = tempDir();
    const a = makeStore(dir);
    await a.load();
    await a.appendChainMember(S1, S2);

    const b = makeStore(dir);
    await b.load();
    expect(b.getChains()[0]?.members).toEqual([S1, S2]);

    // Junk shapes are dropped by migrateState, valid ones kept.
    const migrated = migrateState({
      version: 3,
      records: {},
      windows: {},
      projects: {},
      hiddenFolders: {},
      chains: {
        [S1]: { members: [S2, 'not-a-uuid', S2] },
        'not-a-uuid': { members: [S1, S2] },
        [S3]: { members: [] }, // sanitizes to [S3] alone → dropped
        [S4]: 'garbage',
      },
    });
    expect(Object.keys(migrated.chains)).toEqual([S1]);
    expect(migrated.chains[S1]?.members).toEqual([S1, S2]);
  });

  it('mergeStates unions chain members instead of newest-wins clobbering', () => {
    const disk = state({
      chains: {
        [S1]: chain(S1, [S1, S2], { updatedAt: '2026-07-02T00:00:00.000Z' }),
      },
    });
    const mem = state({
      chains: {
        [S1]: chain(S1, [S1, S3], { updatedAt: '2026-07-03T00:00:00.000Z' }),
        [S4]: chain(S4, [S4, S2]),
      },
    });
    const merged = mergeStates(disk, mem);
    // Newer side's order first, older side's straggler appended — S2 (seen
    // only by the disk side) must survive the merge.
    expect(merged.chains[S1]?.members).toEqual([S1, S3, S2]);
    expect(merged.chains[S1]?.updatedAt).toBe('2026-07-03T00:00:00.000Z');
    expect(merged.chains[S4]?.members).toEqual([S4, S2]);
  });

  it('mergeChainRecords keeps the earliest createdAt', () => {
    const merged = mergeChainRecords(
      chain(S1, [S1, S2], {
        createdAt: '2026-07-05T00:00:00.000Z',
        updatedAt: '2026-07-09T00:00:00.000Z',
      }),
      chain(S1, [S1, S3], {
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-02T00:00:00.000Z',
      }),
    );
    expect(merged.createdAt).toBe('2026-07-01T00:00:00.000Z');
    expect(merged.updatedAt).toBe('2026-07-09T00:00:00.000Z');
    expect(merged.members).toEqual([S1, S2, S3]);
  });
});

// ------------------------------- fork edges, notifications, workspaces

describe('state: daemon fork edges persist', () => {
  it('parentSource "daemon" survives upsert and a reload round trip', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.load();
    await store.upsert(S1, { parentId: S2, parentSource: 'daemon' });
    expect(store.get(S1)?.parentSource).toBe('daemon');
    expect(store.get(S1)?.parentId).toBe(S2);

    const reread = makeStore(dir);
    await reread.load();
    expect(reread.get(S1)?.parentSource).toBe('daemon');
  });

  it('inferred sources are still refused', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.load();
    await store.upsert(S1, {
      parentId: S2,
      parentSource: 'forkedFrom' as EditorialRecord['parentSource'],
    });
    expect(store.get(S1)?.parentSource).toBeUndefined();
  });
});

describe('state: hide verb retired', () => {
  it('a persisted hidden:true reads as deleted, and the flag is dropped', () => {
    const migrated = migrateState({
      version: STATE_SCHEMA_VERSION,
      records: {
        // Written by an older window: put away, but explicitly not deleted.
        [S1]: {
          id: S1,
          hidden: true,
          deleted: false,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
        // hidden:false is pure noise once the verb is gone.
        [S2]: { id: S2, hidden: false, createdAt: nowIso(), updatedAt: nowIso() },
      },
    });
    expect(migrated.records[S1]?.deleted).toBe(true);
    expect(migrated.records[S1]?.hidden).toBeUndefined();
    expect(migrated.records[S2]?.deleted).toBeUndefined();
    expect(migrated.records[S2]?.hidden).toBeUndefined();
  });
});

describe('state: notification fields sanitize', () => {
  it('doneAt/seenAt/notify round-trip; junk types are dropped', () => {
    const migrated = migrateState({
      version: STATE_SCHEMA_VERSION,
      records: {
        [S1]: {
          id: S1,
          doneAt: '2026-07-29T10:00:00.000Z',
          seenAt: '2026-07-29T11:00:00.000Z',
          notify: false,
          parked: true,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
        [S2]: {
          id: S2,
          doneAt: 42,
          seenAt: {},
          notify: 'yes',
          parked: 1,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
      },
    });
    expect(migrated.records[S1]?.doneAt).toBe('2026-07-29T10:00:00.000Z');
    expect(migrated.records[S1]?.seenAt).toBe('2026-07-29T11:00:00.000Z');
    expect(migrated.records[S1]?.notify).toBe(false);
    expect(migrated.records[S1]?.parked).toBe(true);
    expect(migrated.records[S2]?.doneAt).toBeUndefined();
    expect(migrated.records[S2]?.seenAt).toBeUndefined();
    expect(migrated.records[S2]?.notify).toBeUndefined();
    expect(migrated.records[S2]?.parked).toBeUndefined();
  });

  it('chat round-trips as a boolean; a junk type is dropped', () => {
    // The whole chat feature rides on this flag surviving a load: it is the
    // only thing that keeps a chat from rendering as a tree row.
    const migrated = migrateState({
      version: STATE_SCHEMA_VERSION,
      records: {
        [S1]: {
          id: S1,
          chat: true,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
        [S2]: {
          id: S2,
          chat: 'yes',
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
      },
    });
    expect(migrated.records[S1]?.chat).toBe(true);
    expect(migrated.records[S2]?.chat).toBeUndefined();
  });
});

describe('state: workspaces', () => {
  it('saves, reads back, and survives a reload', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.load();
    await store.saveWorkspace('p1', [
      { kind: 'file', uri: 'file:///code/a.ts', viewColumn: 2, active: true },
      { kind: 'session', sessionId: S1, viewColumn: 1 },
    ]);
    const ws = store.getWorkspace('p1');
    expect(ws?.tabs).toHaveLength(2);
    expect(ws?.tabs[0]).toMatchObject({ kind: 'file', uri: 'file:///code/a.ts' });
    expect(ws?.tabs[1]).toMatchObject({ kind: 'session', sessionId: S1 });

    const reread = makeStore(dir);
    await reread.load();
    expect(reread.getWorkspace('p1')?.tabs).toHaveLength(2);
    expect(reread.getWorkspace('p2')).toBeUndefined();
  });

  it('a re-save REPLACES the layout (a layout is a value, not a set)', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.load();
    await store.saveWorkspace('p1', [
      { kind: 'file', uri: 'file:///old.ts', viewColumn: 1 },
    ]);
    await store.saveWorkspace('p1', [
      { kind: 'file', uri: 'file:///new.ts', viewColumn: 1 },
    ]);
    expect(store.getWorkspace('p1')?.tabs.map((t) => t.uri)).toEqual([
      'file:///new.ts',
    ]);
  });

  it('deleteWorkspace removes the layout', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.load();
    await store.saveWorkspace('p1', []);
    expect(store.getWorkspace('p1')).toBeDefined();
    await store.deleteWorkspace('p1');
    expect(store.getWorkspace('p1')).toBeUndefined();
  });

  it('sanitize drops unusable tab records but keeps the snapshot', () => {
    const migrated = migrateState({
      version: STATE_SCHEMA_VERSION,
      workspaces: {
        p1: {
          tabs: [
            { kind: 'file', uri: 'file:///ok.ts', viewColumn: 3 },
            { kind: 'file' }, // no uri
            { kind: 'session', sessionId: 'nope' },
            { kind: 'browser', uri: 'x' }, // unknown kind
            { kind: 'session', sessionId: S1, viewColumn: -2 }, // column clamps
          ],
          savedAt: nowIso(),
          updatedAt: nowIso(),
        },
      },
    });
    const tabs = migrated.workspaces['p1']?.tabs ?? [];
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.uri).toBe('file:///ok.ts');
    expect(tabs[1]).toMatchObject({ kind: 'session', sessionId: S1, viewColumn: 1 });
  });

  it('merges newest-wins across windows', () => {
    const older = {
      projectId: 'p1',
      tabs: [{ kind: 'file' as const, uri: 'file:///old.ts', viewColumn: 1 }],
      savedAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    };
    const newer = {
      ...older,
      tabs: [{ kind: 'file' as const, uri: 'file:///new.ts', viewColumn: 1 }],
      updatedAt: '2026-07-02T00:00:00.000Z',
    };
    const merged = mergeStates(
      state({ workspaces: { p1: older } }),
      state({ workspaces: { p1: newer } }),
    );
    expect(merged.workspaces['p1']?.tabs[0]?.uri).toBe('file:///new.ts');
  });
});

describe('state: accounts', () => {
  it('writes an account and reads it back — canonical order (arrival order via nextOrder here)', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.load();

    await store.upsertAccount('work', { label: 'Work (Max)', provider: 'claude' });
    await store.upsertAccount('personal', { label: 'Personal', provider: 'claude' });

    expect(store.getAccounts().map((a) => a.id)).toEqual(['work', 'personal']);
    expect(store.getAccount('work')?.label).toBe('Work (Max)');
    expect(store.getAccount('nope')).toBeUndefined();

    const onDisk = readFile(dir) as { accounts: Record<string, unknown> };
    expect(Object.keys(onDisk.accounts).sort()).toEqual(['personal', 'work']);
  });

  it('merges a patch instead of replacing the record; store owns id/createdAt/updatedAt', async () => {
    const store = makeStore(tempDir());
    await store.load();
    await store.upsertAccount('work', {
      label: 'Work',
      provider: 'claude',
      configDir: '/a/b',
    });
    const created = store.getAccount('work')?.createdAt;

    await store.upsertAccount('work', { label: 'Work (Max)' });
    const after = store.getAccount('work');
    expect(after?.label).toBe('Work (Max)');
    expect(after?.configDir).toBe('/a/b'); // untouched
    expect(after?.createdAt).toBe(created);
    expect(after?.updatedAt).not.toBe(created);
  });

  it('extraEnv keys are validated by NAME only and round-trip through a reload untouched', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.load();
    await store.upsertAccount('api', {
      label: 'API key',
      provider: 'claude',
      extraEnv: { ANTHROPIC_API_KEY: 'sk-secret', 'bad key': 'dropped' } as unknown as Record<
        string,
        string
      >,
    });
    expect(store.getAccount('api')?.extraEnv).toEqual({ ANTHROPIC_API_KEY: 'sk-secret' });

    const reader = makeStore(dir);
    await reader.load();
    expect(reader.getAccount('api')?.extraEnv).toEqual({ ANTHROPIC_API_KEY: 'sk-secret' });
  });

  it('refuses to write an account with an unusable id', async () => {
    const store = makeStore(tempDir());
    await store.load();
    await store.upsertAccount('Not Valid!', { label: 'x' });
    expect(store.getAccounts()).toEqual([]);
  });

  it('deleteAccount tombstones: hidden from every reader, but the tombstone itself survives a reload', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.load();
    await store.upsertAccount('work', { label: 'Work', provider: 'claude' });
    await store.deleteAccount('work');

    expect(store.getAccounts()).toEqual([]);
    expect(store.getAccount('work')).toBeUndefined();

    const blob = readFile(dir) as LineageState;
    // Non-null: LineageState.accounts is typed optional only so that older
    // object literals still compile — the store itself always writes it.
    expect(blob.accounts!['work']?.deleted).toBe(true);

    const reader = makeStore(dir);
    await reader.load();
    expect(reader.getAccounts()).toEqual([]);
  });

  it('accountIds sees the tombstones the readers hide — a new account must not claim a removed one\'s id', async () => {
    const store = makeStore(tempDir());
    await store.load();
    await store.upsertAccount('work', { label: 'Work' });
    await store.upsertAccount('personal', { label: 'Personal' });
    await store.deleteAccount('work');

    expect(store.getAccounts().map((a) => a.id)).toEqual(['personal']);
    // Pins outlive tombstones, so the id is still spoken for.
    expect(store.accountIds().sort()).toEqual(['personal', 'work']);
  });

  it('re-creating a deleted account starts blank rather than inheriting the tombstone', async () => {
    const store = makeStore(tempDir());
    await store.load();
    await store.upsertAccount('work', { label: 'Work', configDir: '/old/path' });
    await store.deleteAccount('work');
    await store.upsertAccount('work', { label: 'Work Again' });

    const revived = store.getAccount('work');
    expect(revived?.deleted).toBeUndefined();
    expect(revived?.label).toBe('Work Again');
    expect(revived?.configDir).toBeUndefined(); // did not inherit the tombstone's leftovers
  });

  it('setAccountOrder updates only the order, no-ops when unchanged, and cannot mint an account', async () => {
    const store = makeStore(tempDir());
    await store.load();
    await store.upsertAccount('a', { label: 'A' });

    await store.setAccountOrder('a', 3);
    expect(store.getAccount('a')?.order).toBe(3);

    const stamp = store.getAccount('a')?.updatedAt;
    await store.setAccountOrder('a', 3); // same value: no write, no new stamp
    expect(store.getAccount('a')?.updatedAt).toBe(stamp);

    await store.setAccountOrder('ghost', 0); // cannot resurrect a deleted/unknown id
    expect(store.getAccount('ghost')).toBeUndefined();
  });

  it('setDefaultRouting sets and null clears it back to "unset" (reads as auto)', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.load();
    expect(store.getDefaultRouting()).toBeUndefined();

    await store.setDefaultRouting({ kind: 'account', id: 'work' });
    expect(store.getDefaultRouting()).toEqual({ kind: 'account', id: 'work' });

    const reader = makeStore(dir);
    await reader.load();
    expect(reader.getDefaultRouting()).toEqual({ kind: 'account', id: 'work' });

    await store.setDefaultRouting(null);
    expect(store.getDefaultRouting()).toBeUndefined();
  });

  it('setProjectRouting refuses to create a project, sets an override on an existing one, and null removes it', async () => {
    const store = makeStore(tempDir());
    await store.load();

    await store.setProjectRouting('ghost-project', { kind: 'auto' });
    expect(store.getProject('ghost-project')).toBeUndefined();

    await store.upsertProject('p1', { name: 'API', rootDir: '/code/api' });
    await store.setProjectRouting('p1', { kind: 'provider', provider: 'claude' });
    expect(store.getProject('p1')?.routing).toEqual({ kind: 'provider', provider: 'claude' });

    await store.setProjectRouting('p1', null); // no spelling for "unset" via upsertProject
    expect(store.getProject('p1')?.routing).toBeUndefined();
  });

  it('setSessionProfile pins once and keeps the original pin on a second, different attempt', async () => {
    const store = makeStore(tempDir());
    await store.load();
    await store.upsert(S1, { title: 'session' });

    await store.setSessionProfile(S1, 'work');
    expect(store.getSessionProfile(S1)).toBe('work');

    await store.setSessionProfile(S1, 'personal'); // refused; the pin is for life
    expect(store.getSessionProfile(S1)).toBe('work');
  });

  it("getSessionProfile falls back to the EARLIEST pin in the session's generation chain", async () => {
    const store = makeStore(tempDir());
    await store.load();
    await store.appendChainMember(S1, S2); // gen 1 -> gen 2
    await store.setSessionProfile(S1, 'work'); // only generation 1 is pinned directly

    // A plain --resume mints S2 with a fresh, otherwise-empty record.
    expect(store.getSessionProfile(S2)).toBe('work');
  });

  it('a session with no pin anywhere, in or out of a chain, returns undefined', async () => {
    const store = makeStore(tempDir());
    await store.load();
    await store.upsert(S1, { title: 'session' });
    expect(store.getSessionProfile(S1)).toBeUndefined();
  });

  it('migrateState materialises accounts/accountSettings on a v4 file', () => {
    const migrated = migrateState({
      version: 4,
      records: {},
      windows: {},
      projects: {},
      hiddenFolders: {},
      chains: {},
      workspaces: {},
    });
    expect(migrated.version).toBe(STATE_SCHEMA_VERSION);
    expect(migrated.accounts).toEqual({});
    expect(migrated.accountSettings).toEqual({});
  });

  it('migrateState sweeps an account tombstone older than any window could be', () => {
    const migrated = migrateState({
      version: STATE_SCHEMA_VERSION,
      accounts: {
        old: {
          id: 'old',
          provider: 'claude',
          label: '',
          order: 0,
          deleted: true,
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
        },
        fresh: {
          id: 'fresh',
          provider: 'claude',
          label: '',
          order: 0,
          deleted: true,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
      },
    });
    expect(migrated.accounts!['old']).toBeUndefined();
    expect(migrated.accounts!['fresh']?.deleted).toBe(true);
  });

  it('mergeStates: accounts merge record-level newest-wins; accountSettings merges whole-record newest-wins', () => {
    const olderAccount = {
      id: 'a',
      provider: 'claude' as const,
      label: 'Old',
      order: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const newerAccount = {
      ...olderAccount,
      label: 'New',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };

    const disk = state({
      accounts: { a: olderAccount },
      accountSettings: {
        defaultRouting: { kind: 'auto' },
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const mem = state({
      accounts: { a: newerAccount },
      accountSettings: {
        defaultRouting: { kind: 'account', id: 'a' },
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    });
    const merged = mergeStates(disk, mem);
    expect(merged.accounts!['a']?.label).toBe('New');
    expect(merged.accountSettings!.defaultRouting).toEqual({ kind: 'account', id: 'a' });
  });
});

// ------------------------------------------------------- named subprojects (v7)
//
// A lane is a record of its own, keyed by id, and that is the whole design
// decision worth testing here: `projects` merges newest-WINS per record, so a list
// on ProjectRecord would have lost one of two windows' writes. One record per lane
// means one writer per lane.

describe('state: named subprojects', () => {
  it('writes a lane and reads it back, in creation order', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.load();

    await store.upsertProject('p1', { rootDir: '/code/app', name: 'app' });
    await store.upsertSubproject('l1', {
      projectId: 'p1',
      name: 'Server rewrite',
      dir: '/code/app',
    });
    await store.upsertSubproject('l2', {
      projectId: 'p1',
      name: 'CS tooling',
      dir: '/code/app',
    });

    expect(store.getSubprojects().map((l) => l.name)).toEqual([
      'Server rewrite',
      'CS tooling',
    ]);
    // TWO LANES, ONE DIRECTORY — the arrangement the directory-only model could
    // not express.
    expect(new Set(store.getSubprojects().map((l) => l.dir)).size).toBe(1);
    expect(store.getSubproject('l1')?.name).toBe('Server rewrite');
    expect(store.getSubproject('nope')).toBeUndefined();

    const onDisk = readFile(dir) as { subprojects: Record<string, unknown> };
    expect(Object.keys(onDisk.subprojects).sort()).toEqual(['l1', 'l2']);
  });

  it('refuses a lane with no project or no directory', async () => {
    const store = makeStore(tempDir());
    await store.load();
    await store.upsertSubproject('l1', { name: 'No project', dir: '/code/app' });
    await store.upsertSubproject('l2', { projectId: 'p1', name: 'No dir' });
    expect(store.getSubprojects()).toEqual([]);
  });

  it('merges a patch rather than replacing the record', async () => {
    const store = makeStore(tempDir());
    await store.load();
    await store.upsertProject('p1', { rootDir: '/code/app', name: 'app' });
    await store.upsertSubproject('l1', {
      projectId: 'p1',
      name: 'Server rewrite',
      dir: '/code/app',
    });
    const created = store.getSubproject('l1')?.createdAt;
    await store.upsertSubproject('l1', { name: 'CS tooling' });
    const after = store.getSubproject('l1');
    expect(after?.name).toBe('CS tooling');
    // The directory and the parent survive a rename, and the store owns the stamps.
    expect(after?.dir).toBe('/code/app');
    expect(after?.projectId).toBe('p1');
    expect(after?.createdAt).toBe(created);
  });

  it('tombstones a lane rather than dropping its key', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    await store.load();
    await store.upsertProject('p1', { rootDir: '/code/app', name: 'app' });
    await store.upsertSubproject('l1', {
      projectId: 'p1',
      name: 'Gone',
      dir: '/code/app',
    });
    await store.deleteSubproject('l1');
    expect(store.getSubprojects()).toEqual([]);
    // The key survives: a dropped key is indistinguishable from "the other window
    // has not heard of it yet", and that window would re-add it.
    const onDisk = readFile(dir) as {
      subprojects: Record<string, { deleted?: boolean }>;
    };
    expect(onDisk.subprojects.l1.deleted).toBe(true);
  });

  it('takes a project’s lanes down with it', async () => {
    const store = makeStore(tempDir());
    await store.load();
    await store.upsertProject('p1', { rootDir: '/code/app', name: 'app' });
    await store.upsertProject('p2', { rootDir: '/code/web', name: 'web' });
    await store.upsertSubproject('l1', {
      projectId: 'p1',
      name: 'A',
      dir: '/code/app',
    });
    await store.upsertSubproject('l2', {
      projectId: 'p2',
      name: 'B',
      dir: '/code/web',
    });
    await store.deleteProject('p1');
    // A lane is meaningless without the project it names — unlike a nested
    // project, which the tree could re-root at the top level.
    expect(store.getSubprojects().map((l) => l.id)).toEqual(['l2']);
  });

  it('stamps a session once and never rewrites it', async () => {
    const store = makeStore(tempDir());
    await store.load();
    await store.upsertProject('p1', { rootDir: '/code/app', name: 'app' });
    await store.upsertSubproject('l1', {
      projectId: 'p1',
      name: 'A',
      dir: '/code/app',
    });
    await store.upsertSubproject('l2', {
      projectId: 'p1',
      name: 'B',
      dir: '/code/app',
    });

    await store.setSessionSubproject(S1, 'l1');
    expect(store.getSessionSubproject(S1)).toBe('l1');
    // A second, different stamp is a bug at the call site, not a correction — the
    // same contract the account pin has.
    await store.setSessionSubproject(S1, 'l2');
    expect(store.getSessionSubproject(S1)).toBe('l1');
  });

  it('lets the MOVE verb re-file a session, and clear it', async () => {
    const store = makeStore(tempDir());
    await store.load();
    await store.upsertProject('p1', { rootDir: '/code/app', name: 'app' });
    await store.upsertSubproject('l1', {
      projectId: 'p1',
      name: 'A',
      dir: '/code/app',
    });
    await store.upsertSubproject('l2', {
      projectId: 'p1',
      name: 'B',
      dir: '/code/app',
    });
    await store.setSessionSubproject(S1, 'l1');

    await store.moveSessionSubproject(S1, 'l2');
    expect(store.getSessionSubproject(S1)).toBe('l2');
    await store.moveSessionSubproject(S1, null);
    expect(store.getSessionSubproject(S1)).toBeUndefined();
  });

  it('reads a stamp naming a deleted lane as no stamp at all', async () => {
    const store = makeStore(tempDir());
    await store.load();
    await store.upsertProject('p1', { rootDir: '/code/app', name: 'app' });
    await store.upsertSubproject('l1', {
      projectId: 'p1',
      name: 'A',
      dir: '/code/app',
    });
    await store.setSessionSubproject(S1, 'l1');
    await store.deleteSubproject('l1');
    // The stamp is deliberately left on the record — see deleteSubproject — so the
    // session falls back to being placed by directory.
    expect(store.getSessionSubproject(S1)).toBeUndefined();
  });

  it('keeps both windows’ lanes when two are added at once', async () => {
    // THE REASON A LANE IS A RECORD. Two windows each adding one, merged: an array
    // on ProjectRecord would have kept whichever wrote last.
    const dir = tempDir();
    const a = makeStore(dir);
    const b = makeStore(dir);
    await a.load();
    await b.load();
    await a.upsertProject('p1', { rootDir: '/code/app', name: 'app' });
    await b.load();

    await a.upsertSubproject('l1', {
      projectId: 'p1',
      name: 'From A',
      dir: '/code/app',
    });
    await b.upsertSubproject('l2', {
      projectId: 'p1',
      name: 'From B',
      dir: '/code/app',
    });
    await a.load();

    expect(a.getSubprojects().map((l) => l.name).sort()).toEqual([
      'From A',
      'From B',
    ]);
  });
});
