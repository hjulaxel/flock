// test/generations.test.ts — generation chains (M10).
//
// The scenarios mirror the on-disk shapes that motivated the module: one
// conversation re-minted across several ids by plain `--resume` (the verified
// 87f→1e2→aa77 chain), hook re-keys, and the divergent-tail case where an old
// generation gained trailing lines after being continued.

import { describe, expect, it } from 'vitest';

import { buildForest } from '../src/lineage';
import {
  buildChainIndex,
  collapseChains,
  emptyChainIndex,
  type GenerationFacts,
} from '../src/generations';
import type { ChainRecord, EditorialRecord, RosterEntry } from '../src/types';

const id = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = id(1); // oldest generation
const B = id(2);
const C = id(3); // newest generation
const X = id(9); // unrelated
const P = id(7); // a recorded parent outside the chain
const S = id(8); // a stable sibling root that never re-mints

function fact(
  sessionId: string,
  opts: {
    continuesId?: string;
    mtimeMs?: number;
    bytes?: number;
    startedAt?: number;
  } = {},
): GenerationFacts {
  return { sessionId, ...opts };
}

function chainRecord(rootId: string, members: string[]): ChainRecord {
  return {
    rootId,
    members,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

function record(
  rid: string,
  updatedAt: string,
  extra: Partial<EditorialRecord> = {},
): EditorialRecord {
  return { id: rid, createdAt: updatedAt, updatedAt, ...extra };
}

describe('generations: buildChainIndex', () => {
  it('chains continuations even when a bounded head names only the root', () => {
    // B's head names A; C's head ALSO names A (the copied prefix is longer
    // than the head window, exactly like the real aa77 case).
    const index = buildChainIndex({
      facts: [
        fact(A, { mtimeMs: 100, bytes: 600 }),
        fact(B, { continuesId: A, mtimeMs: 200, bytes: 1900 }),
        fact(C, { continuesId: A, mtimeMs: 300, bytes: 1901 }),
        fact(X, { mtimeMs: 50 }),
      ],
      liveIds: new Set(),
    });
    expect(index.tipOf(A)).toBe(C);
    expect(index.tipOf(B)).toBe(C);
    expect(index.tipOf(C)).toBe(C);
    expect(index.rootOf(C)).toBe(A);
    expect(index.membersOf(B)).toEqual([A, B, C]);
    expect(index.isSuperseded(A)).toBe(true);
    expect(index.isSuperseded(B)).toBe(true);
    expect(index.isSuperseded(C)).toBe(false);
    // Unrelated ids map to themselves and are never superseded.
    expect(index.tipOf(X)).toBe(X);
    expect(index.isSuperseded(X)).toBe(false);
  });

  it('prefers a LIVE member over a dead one with a newer mtime', () => {
    // The real divergent-tail case: the old generation gained trailing lines
    // (newer mtime) after the live continuation was created. Liveness is the
    // truth about "which generation is the conversation now".
    const index = buildChainIndex({
      facts: [
        fact(A, { mtimeMs: 100 }),
        fact(B, { continuesId: A, mtimeMs: 900 }),
        fact(C, { continuesId: A, mtimeMs: 500 }),
      ],
      liveIds: new Set([C]),
    });
    expect(index.tipOf(A)).toBe(C);
    expect(index.isSuperseded(B)).toBe(true);
  });

  it('never suppresses a live member, even a non-tip one', () => {
    const index = buildChainIndex({
      facts: [
        fact(A, { mtimeMs: 100 }),
        fact(B, { continuesId: A, mtimeMs: 200 }),
        fact(C, { continuesId: A, mtimeMs: 300 }),
      ],
      liveIds: new Set([B, C]),
    });
    expect(index.tipOf(A)).toBe(C); // newest live wins
    expect(index.isSuperseded(B)).toBe(false); // live → keeps its row
    expect(index.isSuperseded(A)).toBe(true);
  });

  it('unions recorded chains (hook re-keys) with transcript facts', () => {
    const index = buildChainIndex({
      facts: [fact(C, { continuesId: B, mtimeMs: 300 })],
      recorded: [chainRecord(A, [A, B])],
      liveIds: new Set(),
    });
    expect(index.membersOf(A)).toEqual([A, B, C]);
    expect(index.tipOf(A)).toBe(C);
  });

  it('chains onto a predecessor whose transcript is gone from disk', () => {
    // The continuation names an id with no facts at all: the pair still
    // chains, and the missing predecessor maps to the surviving tip.
    const index = buildChainIndex({
      facts: [fact(B, { continuesId: A, mtimeMs: 200 })],
      liveIds: new Set(),
    });
    expect(index.tipOf(A)).toBe(B);
    expect(index.isSuperseded(A)).toBe(true);
  });

  it('emptyChainIndex maps every id to itself', () => {
    const index = emptyChainIndex();
    expect(index.tipOf(A)).toBe(A);
    expect(index.isSuperseded(A)).toBe(false);
    expect(index.membersOf(A)).toEqual([A]);
  });

  it("rootStartedAt is the MINIMUM startedAt across a chain's facts (P7)", () => {
    const index = buildChainIndex({
      facts: [
        fact(A, { mtimeMs: 100, startedAt: 500 }),
        fact(B, { continuesId: A, mtimeMs: 200, startedAt: 700 }),
        // C's own facts carry no startedAt at all (e.g. the head-scan window
        // never found a first-record timestamp) — the minimum still comes
        // through from its older siblings.
        fact(C, { continuesId: A, mtimeMs: 300 }),
      ],
      liveIds: new Set([C]),
    });
    const chain = index.chains().find((c) => c.tipId === C);
    expect(chain?.rootStartedAt).toBe(500);
  });

  it('rootStartedAt is undefined when no member has a startedAt', () => {
    const index = buildChainIndex({
      facts: [
        fact(A, { mtimeMs: 100 }),
        fact(B, { continuesId: A, mtimeMs: 200 }),
      ],
      liveIds: new Set(),
    });
    const chain = index.chains().find((c) => c.tipId === B);
    expect(chain?.rootStartedAt).toBeUndefined();
  });
});

describe('generations: collapseChains', () => {
  const entriesOf = (...ids: string[]): RosterEntry[] =>
    ids.map((sessionId) => ({ sessionId }));

  function chainABC(liveIds: ReadonlySet<string> = new Set([C])) {
    return buildChainIndex({
      facts: [
        fact(A, { mtimeMs: 100 }),
        fact(B, { continuesId: A, mtimeMs: 200 }),
        fact(C, { continuesId: A, mtimeMs: 300 }),
      ],
      liveIds,
    });
  }

  it('drops superseded rows from entries and archived alike', () => {
    const result = collapseChains({
      entries: entriesOf(C, X),
      archived: [
        { sessionId: A, transcriptPath: '/t/a', endedAt: 100, bytes: 1 },
        { sessionId: B, transcriptPath: '/t/b', endedAt: 200, bytes: 2 },
      ],
      records: {},
      chains: chainABC(),
    });
    expect(result.entries.map((e) => e.sessionId)).toEqual([C, X]);
    expect(result.archived).toEqual([]);
  });

  it('carries a title given to generation 1 onto the tip row', () => {
    const result = collapseChains({
      entries: entriesOf(C),
      archived: [],
      records: {
        [A]: record(A, '2026-07-01T00:00:00.000Z', { title: 'init-calc' }),
      },
      chains: chainABC(),
    });
    expect(result.records[C]?.title).toBe('init-calc');
    expect(result.records[C]?.id).toBe(C);
    // The original record is untouched — collapse is a read-time overlay.
    expect(result.records[A]?.title).toBe('init-calc');
  });

  it('does NOT inherit view-state verbs from older generations', () => {
    // A user hid the stale duplicate row of generation A; the live
    // conversation must not wake up muted the day A collapses into it.
    const result = collapseChains({
      entries: entriesOf(C),
      archived: [],
      records: {
        [A]: record(A, '2026-07-01T00:00:00.000Z', {
          title: 't',
          hidden: true,
          deleted: true,
          closed: '2026-07-01T00:00:00.000Z',
        }),
      },
      chains: chainABC(),
    });
    expect(result.records[C]?.title).toBe('t');
    expect(result.records[C]?.hidden).toBeUndefined();
    expect(result.records[C]?.deleted).toBeUndefined();
    expect(result.records[C]?.closed).toBeUndefined();
  });

  it('inherits `chat` from an older generation onto the tip', () => {
    // The motivating trap of the whole design: a chat that was `--resume`d has
    // its record on the ORIGINAL id, while rebuild() filters the tree on the
    // COLLAPSED records. Without inheritance the re-keyed chat surfaces as an
    // ordinary row the moment the chain lands.
    const result = collapseChains({
      entries: entriesOf(C),
      archived: [],
      records: {
        [A]: record(A, '2026-07-01T00:00:00.000Z', { chat: true }),
      },
      chains: chainABC(),
    });
    expect(result.records[C]?.chat).toBe(true);
  });

  it('the tip\'s own record outranks inherited fields', () => {
    const result = collapseChains({
      entries: entriesOf(C),
      archived: [],
      records: {
        [A]: record(A, '2026-07-02T00:00:00.000Z', { title: 'old name' }),
        [C]: record(C, '2026-07-01T00:00:00.000Z', { title: 'new name' }),
      },
      chains: chainABC(),
    });
    // Even though A's record is NEWER, the tip's own explicit title wins.
    expect(result.records[C]?.title).toBe('new name');
  });

  it('carries a recorded parent edge from the root, but never an in-chain one', () => {
    const withOutsideParent = collapseChains({
      entries: entriesOf(C),
      archived: [],
      records: {
        [A]: record(A, '2026-07-01T00:00:00.000Z', {
          parentId: P,
          parentSource: 'minted',
        }),
      },
      chains: chainABC(),
    });
    expect(withOutsideParent.records[C]?.parentId).toBe(P);
    expect(withOutsideParent.records[C]?.parentSource).toBe('minted');

    const withInChainParent = collapseChains({
      entries: entriesOf(C),
      archived: [],
      records: {
        [B]: record(B, '2026-07-01T00:00:00.000Z', {
          parentId: A, // the continuation itself, wrongly recorded as a parent
          parentSource: 'minted',
        }),
      },
      chains: chainABC(),
    });
    expect(withInChainParent.records[C]?.parentId).toBeUndefined();
    expect(withInChainParent.records[C]?.parentSource).toBeUndefined();
  });

  it("overwrites the tip's startedAt with the chain's rootStartedAt (P7)", () => {
    // C's transcript is a `--resume` re-mint of A: its own facts carry a
    // fresh, much-later startedAt (9999, the re-mint's own birthtimeMs), but
    // the conversation itself began at A's 500.
    const chains = buildChainIndex({
      facts: [
        fact(A, { mtimeMs: 100, startedAt: 500 }),
        fact(B, { continuesId: A, mtimeMs: 200, startedAt: 700 }),
        fact(C, { continuesId: A, mtimeMs: 300, startedAt: 9_999 }),
      ],
      liveIds: new Set([C]),
    });
    const result = collapseChains({
      entries: entriesOf(C),
      archived: [],
      records: {},
      chains,
    });
    expect(result.entries.find((e) => e.sessionId === C)?.startedAt).toBe(500);
  });

  it('is a no-op when nothing is superseded', () => {
    const input = {
      entries: entriesOf(X),
      archived: [],
      records: {},
      chains: emptyChainIndex(),
    };
    const result = collapseChains(input);
    expect(result.entries).toBe(input.entries);
    expect(result.records).toBe(input.records);
  });
});

describe('generations: order stability across a re-mint (P7 integration)', () => {
  // collapseChains feeds buildForest directly in extension.ts's rebuild(), so
  // the real regression this guards against is a row visibly jumping past a
  // sibling the moment `--resume` gives its conversation a new physical id —
  // not just that some internal `startedAt` number changed.
  it("does not move a chain tip's row position when the current generation changes", () => {
    // Before the re-mint: A is the one and only generation so far, no chain
    // exists yet, and S is a sibling root that started in between.
    const beforeChains = buildChainIndex({
      facts: [fact(A, { mtimeMs: 100, startedAt: 100 })],
      liveIds: new Set([A]),
    });
    const beforeCollapsed = collapseChains({
      entries: [
        { sessionId: A, startedAt: 100 },
        { sessionId: S, startedAt: 500 },
      ],
      archived: [],
      records: {},
      chains: beforeChains,
    });
    const beforeForest = buildForest({
      entries: beforeCollapsed.entries,
      resolutions: new Map(),
      records: beforeCollapsed.records,
    });
    expect(beforeForest.roots).toEqual([A, S]);

    // After the re-mint: `--resume` writes a FRESH transcript under a FRESH
    // id (B), whose OWN startedAt (9000) is the moment of the re-mint, not
    // the conversation. Without rootStartedAt this would sort B after S;
    // with it, B inherits A's 100 and the row must not move.
    const afterChains = buildChainIndex({
      facts: [
        fact(A, { mtimeMs: 100, startedAt: 100 }),
        fact(B, { continuesId: A, mtimeMs: 900, startedAt: 9_000 }),
      ],
      liveIds: new Set([B]),
    });
    const afterCollapsed = collapseChains({
      entries: [
        { sessionId: B, startedAt: 9_000 },
        { sessionId: S, startedAt: 500 },
      ],
      archived: [],
      records: {},
      chains: afterChains,
    });
    const afterForest = buildForest({
      entries: afterCollapsed.entries,
      resolutions: new Map(),
      records: afterCollapsed.records,
    });
    expect(afterForest.roots).toEqual([B, S]);
  });
});
