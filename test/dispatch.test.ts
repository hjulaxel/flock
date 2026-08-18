// test/dispatch.test.ts — the CONTRACT under test: src/dispatch.ts.
//
// Pure module, fixed `now`, Map literals — the same posture as routing.test.ts,
// and deliberately so: the dispatcher's promises are about TIME, and every one
// of them is only testable because the module never reads a clock. The
// contract worth pinning:
//
//   dispatchable     the gate is the OPPOSITE of the router's tiebreak — an
//                    open window above the ceiling holds, a rolled-over one
//                    dispatches, and no data never holds anything.
//   decideDispatch   FIFO; a tier never widens; one launch per account per
//                    decision; nextWakeAt is the earliest instant the answer
//                    can change, and the queue never goes deaf.

import { describe, expect, it } from 'vitest';

import {
  DISPATCH_RECHECK_MS,
  DISPATCH_UTILIZATION_CEILING,
  MAX_DISPATCH_PROMPT_CHARS,
  decideDispatch,
  dispatchable,
  isDispatchEntry,
} from '../src/dispatch';
import type { DispatchEntry } from '../src/dispatch';
import type { AccountProfile, UsageSnapshot, UsageWindow } from '../src/types';

// ------------------------------------------------------------------ helpers

const NOW = Date.parse('2026-03-04T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function profile(id: string, over: Partial<AccountProfile> = {}): AccountProfile {
  return {
    id,
    provider: 'claude',
    label: `Label ${id}`,
    order: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function win(utilization: number, resetsAt?: number): UsageWindow {
  return resetsAt === undefined ? { utilization } : { utilization, resetsAt };
}

function snap(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return { fetchedAt: NOW, ...over };
}

function entry(id: string, over: Partial<DispatchEntry> = {}): DispatchEntry {
  return { id, createdAt: NOW - HOUR, ...over };
}

function usageMap(
  entries: ReadonlyArray<[string, UsageSnapshot | null]>,
): ReadonlyMap<string, UsageSnapshot | null> {
  return new Map(entries);
}

const NO_USAGE: ReadonlyMap<string, UsageSnapshot | null> = new Map();

// ---------------------------------------------------------------- dispatchable

describe('dispatchable', () => {
  it('no snapshot dispatches — no data is not evidence of exhaustion', () => {
    expect(dispatchable(null, NOW)).toBe(true);
    expect(dispatchable(undefined, NOW)).toBe(true);
  });

  it('no five-hour window dispatches — the account is idle', () => {
    expect(dispatchable(snap(), NOW)).toBe(true);
  });

  it('a live window at the ceiling dispatches; one above it holds', () => {
    const at = NOW + HOUR;
    expect(
      dispatchable(snap({ fiveHour: win(DISPATCH_UTILIZATION_CEILING, at) }), NOW),
    ).toBe(true);
    expect(
      dispatchable(snap({ fiveHour: win(DISPATCH_UTILIZATION_CEILING + 1, at) }), NOW),
    ).toBe(false);
  });

  it('a rolled-over window dispatches whatever the cached percentage claims', () => {
    expect(dispatchable(snap({ fiveHour: win(98, NOW - 1) }), NOW)).toBe(true);
  });

  it('an unreadable utilization reads as no data', () => {
    expect(dispatchable(snap({ fiveHour: win(NaN, NOW + HOUR) }), NOW)).toBe(true);
  });

  it('a full window without a reset time still holds — full is full', () => {
    expect(dispatchable(snap({ fiveHour: win(95) }), NOW)).toBe(false);
  });
});

// -------------------------------------------------------------- decideDispatch

describe('decideDispatch', () => {
  it('an empty queue decides nothing and schedules nothing', () => {
    const d = decideDispatch({ entries: [], profiles: [profile('a')], usage: NO_USAGE, now: NOW });
    expect(d.launches).toEqual([]);
    expect(d.waiting).toEqual([]);
    expect(d.stranded).toEqual([]);
    expect(d.nextWakeAt).toBe(null);
  });

  it('FIFO: launches follow arrival order, not array order', () => {
    const a = entry('late', { createdAt: NOW - 1, routing: { kind: 'account', id: 'p1' } });
    const b = entry('early', { createdAt: NOW - HOUR, routing: { kind: 'account', id: 'p2' } });
    const d = decideDispatch({
      entries: [a, b],
      profiles: [profile('p1'), profile('p2')],
      usage: NO_USAGE,
      now: NOW,
    });
    expect(d.launches.map((l) => l.entry.id)).toEqual(['early', 'late']);
  });

  it('one launch per account per decision — the second entry waits without a date', () => {
    const d = decideDispatch({
      entries: [entry('one', { createdAt: NOW - 2 }), entry('two', { createdAt: NOW - 1 })],
      profiles: [profile('only')],
      usage: NO_USAGE,
      now: NOW,
    });
    expect(d.launches.map((l) => l.entry.id)).toEqual(['one']);
    expect(d.waiting).toHaveLength(1);
    expect(d.waiting[0]?.entry.id).toBe('two');
    expect(d.waiting[0]?.until).toBeUndefined();
    // Nothing datable, entries remain: the recheck keeps the queue breathing.
    expect(d.nextWakeAt).toBe(NOW + DISPATCH_RECHECK_MS);
  });

  it('a window above the ceiling holds its entry until resetsAt, and wakes then', () => {
    const resets = NOW + 2 * HOUR;
    const d = decideDispatch({
      entries: [entry('e', { routing: { kind: 'account', id: 'a' } })],
      profiles: [profile('a')],
      usage: usageMap([['a', snap({ fiveHour: win(97, resets) })]]),
      now: NOW,
    });
    expect(d.launches).toEqual([]);
    expect(d.waiting[0]?.until).toBe(resets);
    expect(d.nextWakeAt).toBe(resets);
  });

  it('an account tier never widens: it waits for ITS account while another sits idle', () => {
    const d = decideDispatch({
      entries: [entry('e', { routing: { kind: 'account', id: 'busy' } })],
      profiles: [profile('busy'), profile('idle')],
      usage: usageMap([['busy', snap({ fiveHour: win(99, NOW + HOUR) })]]),
      now: NOW,
    });
    expect(d.launches).toEqual([]);
    expect(d.waiting[0]?.entry.id).toBe('e');
  });

  it('a provider tier stays inside its provider, and picks within it', () => {
    const d = decideDispatch({
      entries: [entry('e', { routing: { kind: 'provider', provider: 'claude' } })],
      profiles: [
        profile('full', { order: 0 }),
        profile('fresh', { order: 1 }),
        profile('x', { provider: 'codex', order: 2 }),
      ],
      usage: usageMap([['full', snap({ fiveHour: win(99, NOW + HOUR) })]]),
      now: NOW,
    });
    expect(d.launches).toHaveLength(1);
    expect(d.launches[0]?.profile.id).toBe('fresh');
  });

  it('a provider with no launchable accounts strands the entry — reported, not dropped', () => {
    const d = decideDispatch({
      entries: [entry('e', { routing: { kind: 'provider', provider: 'codex' } })],
      profiles: [profile('c')],
      usage: NO_USAGE,
      now: NOW,
    });
    expect(d.stranded).toHaveLength(1);
    expect(d.stranded[0]?.reason).toContain('codex');
    // Stranded entries schedule nothing: an account coming back is a user
    // action, and the host re-decides on account changes anyway.
    expect(d.nextWakeAt).toBe(null);
  });

  it('a named account that was deleted strands its entry', () => {
    const d = decideDispatch({
      entries: [entry('e', { routing: { kind: 'account', id: 'gone' } })],
      profiles: [profile('gone', { deleted: true }), profile('other')],
      usage: NO_USAGE,
      now: NOW,
    });
    expect(d.stranded).toHaveLength(1);
    expect(d.launches).toEqual([]);
  });

  it('unknown usage dispatches — a Codex entry must not wait for a number that never comes', () => {
    const d = decideDispatch({
      entries: [entry('e', { routing: { kind: 'provider', provider: 'codex' } })],
      profiles: [profile('x', { provider: 'codex' })],
      usage: NO_USAGE,
      now: NOW,
    });
    expect(d.launches[0]?.profile.id).toBe('x');
  });

  it('a rolled-over window dispatches even at a cached 98%', () => {
    const d = decideDispatch({
      entries: [entry('e', { routing: { kind: 'account', id: 'a' } })],
      profiles: [profile('a')],
      usage: usageMap([['a', snap({ fiveHour: win(98, NOW - 1) })]]),
      now: NOW,
    });
    expect(d.launches).toHaveLength(1);
  });

  it('notBefore holds an idle account and wakes exactly then', () => {
    const at = NOW + 3 * HOUR;
    const d = decideDispatch({
      entries: [entry('e', { notBefore: at })],
      profiles: [profile('a')],
      usage: NO_USAGE,
      now: NOW,
    });
    expect(d.launches).toEqual([]);
    expect(d.waiting[0]?.until).toBe(at);
    expect(d.nextWakeAt).toBe(at);
  });

  it('auto ranks its gated survivors with routing semantics: the open window wins', () => {
    const d = decideDispatch({
      entries: [entry('e')],
      profiles: [profile('idle', { order: 0 }), profile('open', { order: 1 })],
      usage: usageMap([['open', snap({ fiveHour: win(50, NOW + HOUR) })]]),
      now: NOW,
    });
    expect(d.launches[0]?.profile.id).toBe('open');
    expect(d.launches[0]?.reason).toContain('open 5h window');
  });

  it('nextWakeAt is the earliest of the holds', () => {
    const soon = NOW + HOUR;
    const later = NOW + 5 * HOUR;
    const d = decideDispatch({
      entries: [
        entry('a', { createdAt: NOW - 2, routing: { kind: 'account', id: 'p1' } }),
        entry('b', { createdAt: NOW - 1, notBefore: later }),
      ],
      profiles: [profile('p1'), profile('p2')],
      usage: usageMap([['p1', snap({ fiveHour: win(99, soon) })]]),
      now: NOW,
    });
    expect(d.nextWakeAt).toBe(soon);
  });
});

// -------------------------------------------------------------- isDispatchEntry

describe('isDispatchEntry', () => {
  it('accepts a minimal entry and a full one', () => {
    expect(isDispatchEntry({ id: 'x', createdAt: NOW })).toBe(true);
    expect(
      isDispatchEntry({
        id: 'x',
        createdAt: NOW,
        cwd: '/repo',
        prompt: 'go',
        title: 't',
        routing: { kind: 'auto' },
        notBefore: NOW,
      }),
    ).toBe(true);
  });

  it('rejects the shapes state.json could plausibly hold after a hand edit', () => {
    expect(isDispatchEntry(null)).toBe(false);
    expect(isDispatchEntry([])).toBe(false);
    expect(isDispatchEntry({ createdAt: NOW })).toBe(false);
    expect(isDispatchEntry({ id: '', createdAt: NOW })).toBe(false);
    expect(isDispatchEntry({ id: 'x', createdAt: '2026' })).toBe(false);
    expect(isDispatchEntry({ id: 'x', createdAt: NaN })).toBe(false);
    expect(isDispatchEntry({ id: 'x', createdAt: NOW, routing: { kind: 'nope' } })).toBe(false);
    expect(
      isDispatchEntry({
        id: 'x',
        createdAt: NOW,
        prompt: 'y'.repeat(MAX_DISPATCH_PROMPT_CHARS + 1),
      }),
    ).toBe(false);
  });
});
