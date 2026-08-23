// test/lineage.test.ts — how a session's parent is worked out: the resolution
// cascade, the argv primitives it reads, and the forest builder that turns the
// resolved edges into the tree the sidebar draws.

import { describe, expect, it } from 'vitest';
import * as process from 'node:process';

import {
  LineageResolver,
  buildForest,
  parentFromForkArgv,
  psPpidCommand,
  resolveAll,
  resumeTarget,
  type ResolverIO,
} from '../src/lineage';
import { normalizeStatus } from '../src/roster';
import {
  MAX_GHOST_DEPTH,
  NEGATIVE_RESOLUTION_TTL_MS,
  type ArchivedSession,
  type ArgvScanResult,
  type EditorialRecord,
  type ParentResolution,
  type RosterEntry,
  type TranscriptHeaderMeta,
} from '../src/types';

const ARGV_PARENT = 'ff2c0a73-26c4-46f1-bb6e-fe331fcb0ecf';
const CHILD = '0f000001-0000-4000-8000-000000000001';
const PARENT = '0f0000a1-0000-4000-8000-0000000000a1';
const OTHER = '0f0000b2-0000-4000-8000-0000000000b2';

// ---------------------------------------------------------------- resumeTarget

describe('resumeTarget', () => {
  it('accepts all four flag forms', () => {
    expect(resumeTarget(`claude --fork-session --resume ${ARGV_PARENT}`)).toBe(
      ARGV_PARENT,
    );
    expect(resumeTarget(`claude --fork-session --resume=${ARGV_PARENT}`)).toBe(
      ARGV_PARENT,
    );
    expect(resumeTarget(`claude -r ${ARGV_PARENT} --fork-session`)).toBe(
      ARGV_PARENT,
    );
    expect(resumeTarget(`claude -r=${ARGV_PARENT}`)).toBe(ARGV_PARENT);
  });

  it('rejects a value that is not a session id', () => {
    expect(resumeTarget('claude --resume main')).toBeNull();
    expect(resumeTarget('claude --resume ../../etc/passwd')).toBeNull();
    expect(resumeTarget(`claude --resume ${ARGV_PARENT}x`)).toBeNull();
  });

  it('rejects a flag with no value and a command line with no flag', () => {
    expect(resumeTarget('claude --resume')).toBeNull();
    expect(resumeTarget(`claude ${ARGV_PARENT}`)).toBeNull();
    expect(resumeTarget('')).toBeNull();
  });

  it('takes the first valid value when several appear', () => {
    expect(
      resumeTarget(`claude --resume nope --resume ${ARGV_PARENT} --resume ${PARENT}`),
    ).toBe(ARGV_PARENT);
  });

  it('tolerates irregular whitespace', () => {
    expect(resumeTarget(`claude   --resume\t${ARGV_PARENT}\n`)).toBe(ARGV_PARENT);
  });
});

// ------------------------------------------------------------- ps primitives

describe('psPpidCommand', () => {
  it('fails silently for an impossible pid', async () => {
    expect(await psPpidCommand(0)).toEqual({ ppid: null, command: '' });
    expect(await psPpidCommand(-1)).toEqual({ ppid: null, command: '' });
    expect(await psPpidCommand(2_147_400_000)).toEqual({
      ppid: null,
      command: '',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'reads a real ppid and command line for this process',
    async () => {
      const { ppid, command } = await psPpidCommand(process.pid);
      expect(typeof ppid).toBe('number');
      expect(ppid).toBeGreaterThan(0);
      expect(command.length).toBeGreaterThan(0);
    },
  );
});

describe('parentFromForkArgv', () => {
  it('never rejects and never walks for an unusable pid', async () => {
    await expect(parentFromForkArgv(CHILD, 0)).resolves.toEqual({
      parentId: null,
      forkGateSeen: false,
    });
    await expect(parentFromForkArgv(CHILD, -5)).resolves.toEqual({
      parentId: null,
      forkGateSeen: false,
    });
    await expect(parentFromForkArgv(CHILD, 1.5)).resolves.toEqual({
      parentId: null,
      forkGateSeen: false,
    });
  });

  it('reports no gate for a live process that is not a fork', async () => {
    const r = await parentFromForkArgv(CHILD, process.pid, 2);
    expect(r.parentId).toBeNull();
    expect(r.forkGateSeen).toBe(false);
  });
});

// ------------------------------------------------------------------ resolver

interface Spy {
  io: Partial<ResolverIO>;
  headScans: number;
  deepScans: number;
  argvCalls: number;
  now: { value: number };
}

function spyIO(opts: {
  head?: string | null;
  deep?: string | null;
  argv?: ArgvScanResult;
}): Spy {
  const state = {
    headScans: 0,
    deepScans: 0,
    argvCalls: 0,
    now: { value: 1_000_000 },
  };
  const io: Partial<ResolverIO> = {
    scanTranscript: (_id, o) => {
      if (o.deep) {
        state.deepScans++;
        return opts.deep ?? null;
      }
      state.headScans++;
      return opts.head ?? null;
    },
    argvScan: async () => {
      state.argvCalls++;
      return opts.argv ?? { parentId: null, forkGateSeen: false };
    },
    now: () => state.now.value,
  };
  return {
    io,
    get headScans() {
      return state.headScans;
    },
    get deepScans() {
      return state.deepScans;
    },
    get argvCalls() {
      return state.argvCalls;
    },
    now: state.now,
  } as Spy;
}

function record(patch: Partial<EditorialRecord>): EditorialRecord {
  return {
    id: CHILD,
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
    ...patch,
  };
}

describe('LineageResolver cascade', () => {
  it('branch 1: a minted record wins outright and no transcript is read', async () => {
    const spy = spyIO({ head: OTHER });
    const r = new LineageResolver(spy.io);
    await expect(
      r.resolve(
        { sessionId: CHILD, pid: 123 },
        record({ parentId: PARENT, parentSource: 'minted' }),
      ),
    ).resolves.toEqual({ parentId: PARENT, source: 'minted' });
    expect(spy.headScans).toBe(0);
    expect(spy.argvCalls).toBe(0);
  });

  it('branch 1: a reparent to null keeps the session a root', async () => {
    const spy = spyIO({ head: PARENT });
    const r = new LineageResolver(spy.io);
    await expect(
      r.resolve(
        { sessionId: CHILD },
        record({ parentId: null, parentSource: 'reparent' }),
      ),
    ).resolves.toEqual({ parentId: null, source: 'reparent' });
    expect(spy.headScans).toBe(0);
  });

  it('ignores a persisted inferred source (drift) and re-derives', async () => {
    const spy = spyIO({ head: PARENT });
    const r = new LineageResolver(spy.io);
    await expect(
      r.resolve(
        { sessionId: CHILD },
        record({ parentId: OTHER, parentSource: 'forkedFrom' }),
      ),
    ).resolves.toEqual({ parentId: PARENT, source: 'forkedFrom' });
  });

  it('branch 2: a head-scan hit wins and the argv walk never runs', async () => {
    const spy = spyIO({ head: PARENT, argv: { parentId: OTHER, forkGateSeen: true } });
    const r = new LineageResolver(spy.io);
    await expect(r.resolve({ sessionId: CHILD, pid: 42 })).resolves.toEqual({
      parentId: PARENT,
      source: 'forkedFrom',
    });
    expect(spy.argvCalls).toBe(0);
    expect(spy.deepScans).toBe(0);
  });

  it('branch 3: an argv hit resolves without a deep scan', async () => {
    const spy = spyIO({
      head: null,
      deep: OTHER,
      argv: { parentId: PARENT, forkGateSeen: true },
    });
    const r = new LineageResolver(spy.io);
    await expect(r.resolve({ sessionId: CHILD, pid: 42 })).resolves.toEqual({
      parentId: PARENT,
      source: 'argv',
    });
    expect(spy.deepScans).toBe(0);
  });

  it('branch 4: the deep scan runs only behind the fork gate', async () => {
    const spy = spyIO({
      head: null,
      deep: PARENT,
      argv: { parentId: null, forkGateSeen: true },
    });
    const r = new LineageResolver(spy.io);
    await expect(r.resolve({ sessionId: CHILD, pid: 42 })).resolves.toEqual({
      parentId: PARENT,
      source: 'cli-fork',
    });
    expect(spy.deepScans).toBe(1);
  });

  it('branch 4 gate closed: no --fork-session evidence means no deep scan', async () => {
    const spy = spyIO({
      head: null,
      deep: PARENT, // would resolve, but must never be consulted
      argv: { parentId: null, forkGateSeen: false },
    });
    const r = new LineageResolver(spy.io);
    await expect(r.resolve({ sessionId: CHILD, pid: 42 })).resolves.toEqual({
      parentId: null,
      source: 'none',
    });
    expect(spy.deepScans).toBe(0);
  });

  it('no pid: the argv walk is impossible, so the deep scan stays locked', async () => {
    const spy = spyIO({ head: null, deep: PARENT });
    const r = new LineageResolver(spy.io);
    await expect(r.resolve({ sessionId: CHILD })).resolves.toEqual({
      parentId: null,
      source: 'none',
    });
    expect(spy.argvCalls).toBe(0);
    expect(spy.deepScans).toBe(0);
  });

  it('drops a self-parent from every branch', async () => {
    const spy = spyIO({
      head: CHILD,
      deep: CHILD,
      argv: { parentId: CHILD, forkGateSeen: true },
    });
    const r = new LineageResolver(spy.io);
    await expect(r.resolve({ sessionId: CHILD, pid: 42 })).resolves.toEqual({
      parentId: null,
      source: 'none',
    });
    const r2 = new LineageResolver(spy.io);
    await expect(
      r2.resolve(
        { sessionId: CHILD },
        record({ parentId: CHILD, parentSource: 'minted' }),
      ),
    ).resolves.toEqual({ parentId: null, source: 'minted' });
  });

  it('refuses a non-uuid token as a parent', async () => {
    const spy = spyIO({ head: 'main' });
    const r = new LineageResolver(spy.io);
    await expect(r.resolve({ sessionId: CHILD })).resolves.toEqual({
      parentId: null,
      source: 'none',
    });
  });

  it('survives an IO layer that throws', async () => {
    const r = new LineageResolver({
      scanTranscript: () => {
        throw new Error('disk on fire');
      },
      argvScan: async () => {
        throw new Error('ps on fire');
      },
    });
    await expect(r.resolve({ sessionId: CHILD, pid: 42 })).resolves.toEqual({
      parentId: null,
      source: 'none',
    });
  });
});

describe('LineageResolver caching', () => {
  it('caches a positive resolution for the resolver lifetime', async () => {
    const spy = spyIO({ head: PARENT });
    const r = new LineageResolver(spy.io);
    await r.resolve({ sessionId: CHILD });
    spy.now.value += NEGATIVE_RESOLUTION_TTL_MS * 100;
    await r.resolve({ sessionId: CHILD });
    expect(spy.headScans).toBe(1);
  });

  it('re-derives a negative resolution after the TTL', async () => {
    const spy = spyIO({ head: null });
    const r = new LineageResolver(spy.io);
    await r.resolve({ sessionId: CHILD });
    await r.resolve({ sessionId: CHILD });
    expect(spy.headScans).toBe(1);

    spy.now.value += NEGATIVE_RESOLUTION_TTL_MS + 1;
    await r.resolve({ sessionId: CHILD });
    expect(spy.headScans).toBe(2);
  });

  it('invalidate() forces a re-derive', async () => {
    const spy = spyIO({ head: PARENT });
    const r = new LineageResolver(spy.io);
    await r.resolve({ sessionId: CHILD });
    r.invalidate(CHILD);
    await r.resolve({ sessionId: CHILD });
    expect(spy.headScans).toBe(2);
  });

  it('a freshly recorded edge overrides an already cached inference', async () => {
    const spy = spyIO({ head: OTHER });
    const r = new LineageResolver(spy.io);
    await expect(r.resolve({ sessionId: CHILD })).resolves.toEqual({
      parentId: OTHER,
      source: 'forkedFrom',
    });
    await expect(
      r.resolve({ sessionId: CHILD }, record({ parentId: PARENT, parentSource: 'reparent' })),
    ).resolves.toEqual({ parentId: PARENT, source: 'reparent' });
  });
});

// ----------------------------------------------------------------- resolveAll

describe('resolveAll', () => {
  const entry = (sessionId: string, pid?: number): RosterEntry =>
    pid === undefined ? { sessionId } : { sessionId, pid };

  it('resolves live entries and then their dead ancestors', async () => {
    const chain: Record<string, string> = { [CHILD]: PARENT, [PARENT]: OTHER };
    const resolver = new LineageResolver({
      scanTranscript: (id) => chain[id] ?? null,
    });
    const map = await resolveAll([entry(CHILD)], resolver, {});
    expect(map.get(CHILD)).toEqual({ parentId: PARENT, source: 'forkedFrom' });
    // PARENT has no roster row, but its own parent still resolves.
    expect(map.get(PARENT)).toEqual({ parentId: OTHER, source: 'forkedFrom' });
    expect(map.get(OTHER)).toEqual({ parentId: null, source: 'none' });
  });

  it('stops a ghost chain at MAX_GHOST_DEPTH and never loops on a cycle', async () => {
    const id = (n: number): string =>
      `0f0000${String(n).padStart(2, '0')}-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
    const resolver = new LineageResolver({
      // An unbounded chain: every ghost has yet another dead parent.
      scanTranscript: (sid) => {
        const n = Number.parseInt(sid.slice(6, 8), 10);
        return Number.isFinite(n) ? id(n + 1) : null;
      },
    });
    const map = await resolveAll([entry(id(1))], resolver, {});
    expect(map.size).toBeLessThanOrEqual(MAX_GHOST_DEPTH + 2);

    const cyclic = new LineageResolver({
      scanTranscript: (sid) => (sid === PARENT ? OTHER : PARENT),
    });
    const cycleMap = await resolveAll([entry(CHILD)], cyclic, {});
    expect(cycleMap.get(CHILD)?.parentId).toBe(PARENT);
    expect(cycleMap.size).toBeGreaterThan(1);
  });

  it('passes each entry its own editorial record', async () => {
    const resolver = new LineageResolver({ scanTranscript: () => null });
    const records: Record<string, EditorialRecord> = {
      [CHILD]: record({ parentId: PARENT, parentSource: 'minted' }),
    };
    const map = await resolveAll([entry(CHILD)], resolver, records);
    expect(map.get(CHILD)).toEqual({ parentId: PARENT, source: 'minted' });
  });

  it('tolerates junk entries and a duplicate row', async () => {
    const resolver = new LineageResolver({ scanTranscript: () => null });
    const map = await resolveAll(
      [entry(CHILD), entry(CHILD), { sessionId: '' } as RosterEntry],
      resolver,
      {},
    );
    expect(map.size).toBe(1);
  });
});

// --------------------------------------------------------------- buildForest

function live(
  sessionId: string,
  patch: Partial<RosterEntry> = {},
): RosterEntry {
  return { sessionId, cwd: '/work', startedAt: 1000, ...patch };
}

function forestOf(
  entries: RosterEntry[],
  edges: Record<string, ParentResolution>,
  extra: {
    records?: Record<string, EditorialRecord>;
    headers?: Map<string, TranscriptHeaderMeta>;
    showGhosts?: boolean;
    onlyActive?: boolean;
    activityMtimes?: ReadonlyMap<string, number>;
    tailStats?: ReadonlyMap<
      string,
      { lastPromptAt?: number; tokens?: number; lastExchange?: string }
    >;
    archived?: ArchivedSession[];
  } = {},
) {
  const opts: {
    showGhosts?: boolean;
    onlyActive?: boolean;
    now?: number;
  } = { now: 5_000_000 };
  if (extra.showGhosts !== undefined) opts.showGhosts = extra.showGhosts;
  if (extra.onlyActive !== undefined) opts.onlyActive = extra.onlyActive;
  const input = {
    entries,
    resolutions: new Map(Object.entries(edges)),
    records: extra.records ?? {},
    opts,
    ...(extra.headers === undefined ? {} : { headers: extra.headers }),
    ...(extra.activityMtimes === undefined
      ? {}
      : { activityMtimes: extra.activityMtimes }),
    ...(extra.tailStats === undefined ? {} : { tailStats: extra.tailStats }),
    ...(extra.archived === undefined ? {} : { archived: extra.archived }),
  };
  return buildForest(input);
}

describe('buildForest', () => {
  it('nests a live child under a live parent and records the edge', () => {
    const f = forestOf(
      [live(PARENT), live(CHILD, { startedAt: 2000 })],
      { [CHILD]: { parentId: PARENT, source: 'forkedFrom' } },
    );
    expect(f.roots).toEqual([PARENT]);
    expect(f.visibleRoots).toEqual([PARENT]);
    expect(f.nodes.get(PARENT)?.children).toEqual([CHILD]);
    expect(f.nodes.get(PARENT)?.visibleChildren).toEqual([CHILD]);
    expect(f.nodes.get(CHILD)?.parentId).toBe(PARENT);
    expect(f.edges).toEqual([
      { childId: CHILD, parentId: PARENT, source: 'forkedFrom' },
    ]);
    expect(f.generatedAt).toBe(5_000_000);
  });

  it('synthesizes a ghost for a parent with no roster row', () => {
    const f = forestOf([live(CHILD)], {
      [CHILD]: { parentId: PARENT, source: 'forkedFrom' },
    });
    const ghost = f.nodes.get(PARENT);
    expect(ghost).toBeDefined();
    expect(ghost?.ghost).toBe(true);
    expect(ghost?.status).toBe('exited');
    expect(ghost?.attention).toBe('none');
    expect(ghost?.kind).toBe('unknown');
    expect(ghost?.roster).toBeUndefined();
    expect(ghost?.label).toBe('0f0000a1 (gone)');
    expect(f.visibleRoots).toEqual([PARENT]);
    expect(ghost?.visibleChildren).toEqual([CHILD]);
  });

  // Regression: a ghost had no cwd unless an editorial record supplied one,
  // and a record's cwd exists only for sessions Flock launched itself. The
  // ghost IS the visible root of its subtree and grouping keys entirely off
  // the root's cwd, so a fork of a just-closed parent fell out of its project
  // row into "(no directory)" — or vanished under lineage.onlyProjectSessions.
  it('gives a ghost the cwd of the child that referenced it', () => {
    const f = forestOf([live(CHILD, { cwd: '/work/api' })], {
      [CHILD]: { parentId: PARENT, source: 'forkedFrom' },
    });
    expect(f.nodes.get(PARENT)?.cwd).toBe('/work/api');
  });

  it('prefers an editorial cwd over the inherited one', () => {
    const f = forestOf(
      [live(CHILD, { cwd: '/work/api' })],
      { [CHILD]: { parentId: PARENT, source: 'forkedFrom' } },
      {
        records: {
          [PARENT]: {
            id: PARENT,
            cwd: '/work/recorded',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      },
    );
    expect(f.nodes.get(PARENT)?.cwd).toBe('/work/recorded');
  });

  it('carries an inherited cwd up a chain of ghosts', () => {
    const f = forestOf(
      [live(CHILD, { cwd: '/work/api' })],
      {
        [CHILD]: { parentId: PARENT, source: 'forkedFrom' },
        [PARENT]: { parentId: OTHER, source: 'forkedFrom' },
      },
    );
    expect(f.nodes.get(PARENT)?.ghost).toBe(true);
    expect(f.nodes.get(OTHER)?.ghost).toBe(true);
    expect(f.nodes.get(OTHER)?.cwd).toBe('/work/api');
  });

  // Two children of the same dead parent can disagree about cwd (forked after
  // a cd, or resumed in another checkout). Whichever one the CLI happens to
  // list first must not decide which project the ghost subtree files under.
  it('picks the earliest child when children disagree about the inherited cwd', () => {
    const edges = {
      [CHILD]: { parentId: PARENT, source: 'forkedFrom' as const },
      [OTHER]: { parentId: PARENT, source: 'forkedFrom' as const },
    };
    const early = live(CHILD, { cwd: '/work/api', startedAt: 1000 });
    const late = live(OTHER, { cwd: '/work/web', startedAt: 2000 });
    expect(forestOf([early, late], edges).nodes.get(PARENT)?.cwd).toBe(
      '/work/api',
    );
    // Same roster, other order — same answer.
    expect(forestOf([late, early], edges).nodes.get(PARENT)?.cwd).toBe(
      '/work/api',
    );
  });

  it('falls back to the smaller cwd when the children started at the same time', () => {
    const edges = {
      [CHILD]: { parentId: PARENT, source: 'forkedFrom' as const },
      [OTHER]: { parentId: PARENT, source: 'forkedFrom' as const },
    };
    const a = live(CHILD, { cwd: '/work/web', startedAt: 1000 });
    const b = live(OTHER, { cwd: '/work/api', startedAt: 1000 });
    expect(forestOf([a, b], edges).nodes.get(PARENT)?.cwd).toBe('/work/api');
    expect(forestOf([b, a], edges).nodes.get(PARENT)?.cwd).toBe('/work/api');
  });

  it('leaves a ghost without a cwd when no descendant has one', () => {
    const f = forestOf([live(CHILD, { cwd: undefined })], {
      [CHILD]: { parentId: PARENT, source: 'forkedFrom' },
    });
    expect(f.nodes.get(PARENT)?.cwd).toBeUndefined();
  });

  it('prefers an editorial title over the "(gone)" ghost label', () => {
    const f = forestOf(
      [live(CHILD)],
      { [CHILD]: { parentId: PARENT, source: 'forkedFrom' } },
      {
        records: {
          [PARENT]: { ...record({ id: PARENT }), title: 'the old session' },
        },
      },
    );
    expect(f.nodes.get(PARENT)?.label).toBe('the old session');
  });

  it('promotes children to roots when ghosts are switched off', () => {
    const f = forestOf(
      [live(CHILD)],
      { [CHILD]: { parentId: PARENT, source: 'forkedFrom' } },
      { showGhosts: false },
    );
    expect(f.roots).toEqual([PARENT]); // structure is unchanged
    expect(f.visibleRoots).toEqual([CHILD]); // only the rendering changes
    expect(f.nodes.get(CHILD)?.parentId).toBe(PARENT);
  });

  it('prunes a ghost whose only descendant is DELETED', () => {
    const f = forestOf(
      [live(CHILD)],
      { [CHILD]: { parentId: PARENT, source: 'forkedFrom' } },
      { records: { [CHILD]: { ...record({ id: CHILD }), deleted: true } } },
    );
    expect(f.visibleRoots).toEqual([]);
    expect(f.nodes.size).toBe(2);
  });

  // A muted descendant is still on screen, so the ghost that carries its
  // lineage has to stay too — otherwise hiding a fork would silently detach it.
  it('keeps a ghost whose only descendant is merely hidden', () => {
    const f = forestOf(
      [live(CHILD)],
      { [CHILD]: { parentId: PARENT, source: 'forkedFrom' } },
      {
        showGhosts: true,
        records: { [CHILD]: { ...record({ id: CHILD }), hidden: true } },
      },
    );
    expect(f.visibleRoots).toEqual([PARENT]);
    expect(f.nodes.get(PARENT)?.visibleChildren).toEqual([CHILD]);
  });

  // `lineage.onlyActiveSessions`, the view-title filter.
  describe('onlyActive', () => {
    const archivedOf = (id: string): ArchivedSession => ({
      sessionId: id,
      transcriptPath: `/t/${id}.jsonl`,
      endedAt: 4_000_000,
      bytes: 10,
      cwd: '/work',
    });

    it('drops what is over and keeps what is running', () => {
      const f = forestOf(
        [live(CHILD)],
        {},
        { archived: [archivedOf(OTHER)], onlyActive: true },
      );
      expect(f.visibleRoots).toEqual([CHILD]);
      // A FILTER, not a delete: the node is still built, so every verb that
      // takes an id still finds it and flipping the switch back is free.
      expect(f.nodes.has(OTHER)).toBe(true);
    });

    it('promotes a live fork of a closed parent instead of losing it', () => {
      // The whole reason this rides on the visibility pass rather than being a
      // filter over the finished rows: a session whose parent you closed is
      // still running, and it has to keep a place in the tree.
      const f = forestOf(
        [live(CHILD)],
        { [CHILD]: { parentId: PARENT, source: 'forkedFrom' } },
        { archived: [archivedOf(PARENT)], onlyActive: true },
      );
      expect(f.visibleRoots).toEqual([CHILD]);
      expect(f.nodes.get(CHILD)?.parentId).toBe(PARENT); // lineage is untouched
      expect(f.nodes.get(PARENT)?.visibleChildren).toEqual([CHILD]);
    });

    it('takes the ghosts with it — an inferred ancestor is not running either', () => {
      const f = forestOf(
        [live(CHILD)],
        { [CHILD]: { parentId: PARENT, source: 'forkedFrom' } },
        { showGhosts: true, onlyActive: true },
      );
      expect(f.visibleRoots).toEqual([CHILD]);
    });

    it('changes nothing while it is off', () => {
      const f = forestOf([live(CHILD)], {}, { archived: [archivedOf(OTHER)] });
      expect(f.visibleRoots.sort()).toEqual([CHILD, OTHER].sort());
    });
  });

  it('cuts a cycle so the forest still has a root', () => {
    const f = forestOf([live(PARENT), live(CHILD)], {
      [PARENT]: { parentId: CHILD, source: 'forkedFrom' },
      [CHILD]: { parentId: PARENT, source: 'forkedFrom' },
    });
    expect(f.roots.length).toBe(1);
    expect(f.edges.length).toBe(1);
    // Every node must be reachable from a root.
    const reachable = new Set<string>();
    const walk = (id: string): void => {
      if (reachable.has(id)) return;
      reachable.add(id);
      for (const c of f.nodes.get(id)?.children ?? []) walk(c);
    };
    for (const r of f.roots) walk(r);
    expect(reachable.size).toBe(f.nodes.size);
  });

  it('drops a self-edge but keeps recorded provenance', () => {
    const f = forestOf([live(CHILD)], {
      [CHILD]: { parentId: CHILD, source: 'minted' },
    });
    expect(f.nodes.get(CHILD)?.parentId).toBeNull();
    expect(f.nodes.get(CHILD)?.source).toBe('minted');
    expect(f.edges).toEqual([]);
  });

  it('promotes a DELETED node’s children under the nearest visible ancestor', () => {
    const GONE = OTHER;
    const GRAND = '0f0000c3-0000-4000-8000-0000000000c3';
    const f = forestOf(
      [live(PARENT), live(GONE), live(GRAND)],
      {
        [GONE]: { parentId: PARENT, source: 'forkedFrom' },
        [GRAND]: { parentId: GONE, source: 'forkedFrom' },
      },
      { records: { [GONE]: { ...record({ id: GONE }), deleted: true } } },
    );
    expect(f.nodes.get(PARENT)?.children).toEqual([GONE]);
    expect(f.nodes.get(PARENT)?.visibleChildren).toEqual([GRAND]);
    expect(f.nodes.get(GONE)?.deleted).toBe(true);
  });

  // Hide and delete are different verbs. Hiding MUTES — the row survives.
  it('keeps a hidden node’s row and its subtree nested under it', () => {
    const HID = OTHER;
    const GRAND = '0f0000c3-0000-4000-8000-0000000000c3';
    const f = forestOf(
      [live(PARENT), live(HID), live(GRAND)],
      {
        [HID]: { parentId: PARENT, source: 'forkedFrom' },
        [GRAND]: { parentId: HID, source: 'forkedFrom' },
      },
      { records: { [HID]: { ...record({ id: HID }), hidden: true } } },
    );
    expect(f.nodes.get(HID)?.hidden).toBe(true);
    expect(f.nodes.get(HID)?.deleted).toBe(false);
    // Not spliced out, and its child is NOT promoted past it.
    expect(f.nodes.get(PARENT)?.visibleChildren).toEqual([HID]);
    expect(f.nodes.get(HID)?.visibleChildren).toEqual([GRAND]);
  });

  it('sorts a hidden sibling after every visible one', () => {
    const EARLY = OTHER; // hidden, but started FIRST
    const f = forestOf(
      [
        live(PARENT),
        live(EARLY, { startedAt: 1_000 }),
        live(CHILD, { startedAt: 2_000 }),
      ],
      {
        [EARLY]: { parentId: PARENT, source: 'forkedFrom' },
        [CHILD]: { parentId: PARENT, source: 'forkedFrom' },
      },
      { records: { [EARLY]: { ...record({ id: EARLY }), hidden: true } } },
    );
    // Age alone would put EARLY first; muting overrides it.
    expect(f.nodes.get(PARENT)?.children).toEqual([CHILD, EARLY]);
    expect(f.nodes.get(PARENT)?.visibleChildren).toEqual([CHILD, EARLY]);
  });

  it('sorts a hidden ROOT last, whether or not it is waiting on the user', () => {
    const HID = OTHER;
    const f = forestOf(
      [
        live(HID, { status: 'waiting', waitingFor: 'dialog open', startedAt: 1_000 }),
        live(CHILD, { startedAt: 2_000 }),
      ],
      {},
      {
        records: { [HID]: { ...record({ id: HID }), hidden: true } },
      },
    );
    // Muting outranks everything, including "starts earlier" and "is waiting".
    expect(f.visibleRoots).toEqual([CHILD, HID]);
    // …and a muted session never badges the view.
    expect(f.attentionCount).toBe(0);
  });

  it('counts only visible waiting sessions in attentionCount', () => {
    const f = forestOf(
      [
        live(PARENT, { status: 'waiting', waitingFor: 'dialog open' }),
        live(CHILD, { state: 'blocked' }),
      ],
      {},
      { records: { [CHILD]: { ...record({ id: CHILD }), hidden: true } } },
    );
    expect(f.nodes.get(PARENT)?.attention).toBe('waiting');
    expect(f.nodes.get(CHILD)?.attention).toBe('waiting');
    expect(f.attentionCount).toBe(1);
  });

  it('applies the label precedence record.title > roster.name > header > shortId', () => {
    const headers = new Map<string, TranscriptHeaderMeta>([
      [CHILD, { customTitle: 'from header' }],
      [PARENT, { customTitle: 'header title' }],
      [OTHER, { customTitle: 'unused' }],
    ]);
    const f = forestOf(
      [
        live(CHILD, { name: 'roster name' }),
        live(PARENT),
        live(OTHER, { name: 'roster wins' }),
        live('0f0000d4-0000-4000-8000-0000000000d4'),
      ],
      {},
      {
        headers,
        records: {
          [CHILD]: { ...record({ id: CHILD }), title: 'editorial title' },
        },
      },
    );
    expect(f.nodes.get(CHILD)?.label).toBe('editorial title');
    expect(f.nodes.get(OTHER)?.label).toBe('roster wins');
    expect(f.nodes.get(PARENT)?.label).toBe('header title');
    expect(f.nodes.get('0f0000d4-0000-4000-8000-0000000000d4')?.label).toBe(
      '0f0000d4',
    );
  });

  it('never reorders visibleRoots when a session starts waiting on you (P7)', () => {
    // The order-stability invariant the fix exists to guarantee: building the
    // SAME forest twice, differing only in one root's attention state, must
    // produce byte-identical root order. Attention is a rendering concern —
    // the dot, the badge — never a position concern.
    const older = live(PARENT, { startedAt: 100 });
    const newerIdle = live(CHILD, { startedAt: 900 });
    const idleForest = forestOf([older, newerIdle], {});

    const newerWaiting = live(CHILD, { startedAt: 900, status: 'waiting' });
    const waitingForest = forestOf([older, newerWaiting], {});

    expect(waitingForest.visibleRoots).toEqual(idleForest.visibleRoots);
    expect(waitingForest.visibleRoots).toEqual([PARENT, CHILD]);
  });

  it('sorts children by start time with undefined last', () => {
    const a = live(OTHER, { startedAt: 300 });
    const b = live(CHILD, { startedAt: 100 });
    const c = live('0f0000d4-0000-4000-8000-0000000000d4', {
      startedAt: undefined,
    });
    const f = forestOf([live(PARENT), a, b, c], {
      [OTHER]: { parentId: PARENT, source: 'argv' },
      [CHILD]: { parentId: PARENT, source: 'argv' },
      '0f0000d4-0000-4000-8000-0000000000d4': {
        parentId: PARENT,
        source: 'argv',
      },
    });
    expect(f.nodes.get(PARENT)?.children).toEqual([
      CHILD,
      OTHER,
      '0f0000d4-0000-4000-8000-0000000000d4',
    ]);
  });

  it('keeps a live status even when the record says the session was closed', () => {
    const f = forestOf(
      [live(CHILD, { status: 'busy' })],
      {},
      {
        records: {
          [CHILD]: {
            ...record({ id: CHILD }),
            closed: '2026-07-27T00:00:00.000Z',
          },
        },
      },
    );
    expect(f.nodes.get(CHILD)?.status).toBe('busy');
    expect(f.nodes.get(CHILD)?.ghost).toBe(false);
  });

  it('bounds a chain of dead ancestors and roots whatever is left', () => {
    const id = (n: number): string =>
      `0f0001${String(n).padStart(2, '0')}-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;
    const resolutions: Record<string, ParentResolution> = {};
    for (let n = 0; n < MAX_GHOST_DEPTH + 5; n++) {
      resolutions[id(n)] = { parentId: id(n + 1), source: 'forkedFrom' };
    }
    const f = forestOf([live(id(0))], resolutions);
    expect(f.nodes.size).toBe(MAX_GHOST_DEPTH + 1);
    expect(f.roots).toHaveLength(1);
    const root = f.nodes.get(f.roots[0]);
    expect(root?.parentId).toBeNull();
  });

  it('handles an empty roster and junk entries', () => {
    const empty = forestOf([], {});
    expect(empty.nodes.size).toBe(0);
    expect(empty.roots).toEqual([]);
    expect(empty.visibleRoots).toEqual([]);
    expect(empty.attentionCount).toBe(0);

    const junk = forestOf(
      [{ sessionId: '' } as RosterEntry, live(CHILD), live(CHILD)],
      {},
    );
    expect(junk.nodes.size).toBe(1);
  });

  it('derives status exactly like roster.normalizeStatus', () => {
    const cases: Array<Partial<RosterEntry>> = [
      { status: 'waiting', waitingFor: 'dialog open', state: 'blocked' },
      { state: 'blocked' },
      { status: 'idle' },
      { status: 'busy' },
      { status: 'working' },
      { state: 'running' },
      { state: 'working' },
      { status: 'something-new' },
      {},
    ];
    for (const patch of cases) {
      const entry = live(CHILD, patch);
      const node = forestOf([entry], {}).nodes.get(CHILD);
      const expected = normalizeStatus(entry);
      expect({ status: node?.status, attention: node?.attention }).toEqual(
        expected,
      );
    }
  });

  // P5: age is time since last activity, not time since the process was
  // started. lastActiveAt comes from the archive indexer's transcript-mtime
  // sweep, handed in as activityMtimes and keyed by session id.
  it('gives a live entry lastActiveAt from a matching activityMtimes entry', () => {
    const f = forestOf([live(CHILD, { startedAt: 1000 })], {}, {
      activityMtimes: new Map([[CHILD, 4_999_000]]),
    });
    const node = f.nodes.get(CHILD);
    expect(node?.startedAt).toBe(1000);
    expect(node?.lastActiveAt).toBe(4_999_000);
    expect(node?.lastActiveAt).not.toBe(node?.startedAt);
  });

  it('leaves lastActiveAt undefined for a live entry the sweep has not covered yet', () => {
    const f = forestOf([live(CHILD, { startedAt: 1000 })], {}, {
      activityMtimes: new Map([[PARENT, 4_999_000]]), // some OTHER id
    });
    expect(f.nodes.get(CHILD)?.lastActiveAt).toBeUndefined();
  });

  it('leaves lastActiveAt undefined for a live entry when no map is passed at all', () => {
    const f = forestOf([live(CHILD, { startedAt: 1000 })], {});
    expect(f.nodes.get(CHILD)?.lastActiveAt).toBeUndefined();
  });

  // The transcript-tail facts, carried alongside the mtime sweep. The two
  // are separate inputs because they answer different questions — "was
  // anything written" vs "did the USER say anything" — and a node may have
  // either without the other.
  it('carries the tail facts onto a live node, per field', () => {
    const f = forestOf([live(CHILD, { startedAt: 1000 })], {}, {
      activityMtimes: new Map([[CHILD, 4_999_000]]),
      tailStats: new Map([[CHILD, { lastPromptAt: 4_000_000, tokens: 287_207 }]]),
    });
    const node = f.nodes.get(CHILD);
    expect(node?.lastPromptAt).toBe(4_000_000);
    expect(node?.tokens).toBe(287_207);
    // The mtime is still recorded — it is the fallback the age drops to.
    expect(node?.lastActiveAt).toBe(4_999_000);
  });

  it('carries them onto an ARCHIVED node too', () => {
    // A closed session's last prompt is as interesting as a live one's, and is
    // the number its row has always claimed to show.
    const f = forestOf([], {}, {
      archived: [
        {
          sessionId: CHILD,
          transcriptPath: '/tmp/x.jsonl',
          endedAt: 4_999_000,
          bytes: 10,
          startedAt: 1000,
        },
      ],
      tailStats: new Map([[CHILD, { lastPromptAt: 4_000_000, tokens: 512 }]]),
    });
    const node = f.nodes.get(CHILD);
    expect(node?.archived).toBe(true);
    expect(node?.lastPromptAt).toBe(4_000_000);
    expect(node?.tokens).toBe(512);
  });

  it('ignores a junk or absent entry rather than writing a junk field', () => {
    const f = forestOf([live(CHILD), live(PARENT)], {}, {
      tailStats: new Map([
        [CHILD, { lastPromptAt: Number.NaN, tokens: 0, lastExchange: '  ' }],
      ]),
    });
    expect(f.nodes.get(CHILD)?.lastPromptAt).toBeUndefined();
    expect(f.nodes.get(CHILD)?.tokens).toBeUndefined();
    expect(f.nodes.get(CHILD)?.lastExchange).toBeUndefined();
    expect(f.nodes.get(PARENT)?.lastPromptAt).toBeUndefined();
  });

  it('carries the last exchange onto live and archived nodes alike', () => {
    // The fact is the same either way; it is the RENDERERS that decide an
    // archived row is the one place it earns width.
    const f = forestOf([live(CHILD)], {}, {
      archived: [
        {
          sessionId: PARENT,
          transcriptPath: '/tmp/p.jsonl',
          endedAt: 4_999_000,
          bytes: 10,
        },
      ],
      tailStats: new Map([
        [CHILD, { lastExchange: 'live conclusion' }],
        [PARENT, { lastExchange: 'archived conclusion' }],
      ]),
    });
    expect(f.nodes.get(CHILD)?.lastExchange).toBe('live conclusion');
    expect(f.nodes.get(PARENT)?.lastExchange).toBe('archived conclusion');
  });

  // The detach grace, as a renderable fact — the one sanctioned
  // detached-running state must reach the renderers or it is the old
  // invisible `parked` under a new name.
  it('stamps graceDeadlineAt on a live node from record.graceUntil', () => {
    const f = forestOf([live(CHILD)], {}, {
      records: {
        [CHILD]: record({ graceUntil: '2026-08-23T10:00:00.000Z' }),
      },
    });
    expect(f.nodes.get(CHILD)?.graceDeadlineAt).toBe(
      Date.parse('2026-08-23T10:00:00.000Z'),
    );
  });

  it('leaves it off for a cleared, absent or unparseable deadline', () => {
    // null is the cleared state (same convention as record.tmux); garbage is
    // read by the sweep as "expired" and the process ends within a minute, so
    // the honest render is a plain live row, not a fabricated countdown.
    const f = forestOf(
      [live(CHILD), live(PARENT), live(OTHER)],
      {},
      {
        records: {
          [CHILD]: record({ graceUntil: null }),
          [PARENT]: record({ id: PARENT }),
          [OTHER]: record({ id: OTHER, graceUntil: 'not a timestamp' }),
        },
      },
    );
    expect(f.nodes.get(CHILD)?.graceDeadlineAt).toBeUndefined();
    expect(f.nodes.get(PARENT)?.graceDeadlineAt).toBeUndefined();
    expect(f.nodes.get(OTHER)?.graceDeadlineAt).toBeUndefined();
  });

  it('never stamps an ARCHIVED node — its leftover deadline is a kept promise', () => {
    const f = forestOf([], {}, {
      archived: [
        {
          sessionId: CHILD,
          transcriptPath: '/tmp/x.jsonl',
          endedAt: 4_999_000,
          bytes: 10,
        },
      ],
      records: {
        [CHILD]: record({ graceUntil: '2026-08-23T10:00:00.000Z' }),
      },
    });
    expect(f.nodes.get(CHILD)?.archived).toBe(true);
    expect(f.nodes.get(CHILD)?.graceDeadlineAt).toBeUndefined();
  });
});

// --------------------------------------------------- resolveAll: chain remap

describe('resolveAll: chain-tip parent remap', () => {
  it('re-points an inferred edge at the tip and never ghosts the superseded id', async () => {
    const spy = spyIO({ head: PARENT });
    const resolver = new LineageResolver(spy.io);
    // PARENT has been superseded by OTHER (its conversation's tip).
    const map = await resolveAll(
      [{ sessionId: CHILD }],
      resolver,
      {},
      undefined,
      (pid) => (pid === PARENT ? OTHER : pid),
    );
    expect(map.get(CHILD)).toEqual({ parentId: OTHER, source: 'forkedFrom' });
    // The ghost walk chased the TIP, not the row the collapse just removed.
    expect(map.has(OTHER)).toBe(true);
    expect(map.has(PARENT)).toBe(false);
  });

  it('a mapper that throws or returns junk leaves the edge unchanged', async () => {
    const spy = spyIO({ head: PARENT });
    const resolver = new LineageResolver(spy.io);
    const throwing = await resolveAll(
      [{ sessionId: CHILD }],
      resolver,
      {},
      undefined,
      () => {
        throw new Error('boom');
      },
    );
    expect(throwing.get(CHILD)?.parentId).toBe(PARENT);

    const junkResolver = new LineageResolver(spyIO({ head: PARENT }).io);
    const junk = await resolveAll(
      [{ sessionId: CHILD }],
      junkResolver,
      {},
      undefined,
      () => 'not-a-uuid',
    );
    expect(junk.get(CHILD)?.parentId).toBe(PARENT);
  });
});
