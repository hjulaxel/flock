// test/dispatchHost.test.ts — the CONTRACT under test: src/dispatchHost.ts.
//
// Fake timers throughout: the host's promises are about WHEN — a poke is one
// debounced decision, a wake at `resetsAt` force-refreshes before trusting
// anything, a failed launch retries instead of settling, and a launch with
// entries still waiting is followed up one refresh later, not one tick later.
// The doubles are closures over plain arrays; nothing here mocks a module.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DISPATCH_MIN_WAKE_MS,
  DISPATCH_POKE_DEBOUNCE_MS,
  DISPATCH_POST_LAUNCH_MS,
  DISPATCH_RETRY_MS,
  DispatchHost,
} from '../src/dispatchHost';
import type { DispatchHostDeps } from '../src/dispatchHost';
import type {
  AccountProfile,
  DispatchEntry,
  DispatchOutcome,
  UsageSnapshot,
} from '../src/types';

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

function entry(id: string, over: Partial<DispatchEntry> = {}): DispatchEntry {
  return { id, createdAt: NOW - HOUR, ...over };
}

/** A test harness: a queue, a usage map the test may swap, and recorders for
 *  every side effect the host can cause. */
function harness(opts?: {
  entries?: DispatchEntry[];
  profiles?: AccountProfile[];
  usage?: ReadonlyMap<string, UsageSnapshot | null>;
  launchOk?: boolean;
}) {
  const settled = new Map<string, DispatchOutcome>();
  const launches: string[] = [];
  const refreshes: boolean[] = [];
  const notices: string[] = [];
  const h = {
    entries: opts?.entries ?? [entry('e1')],
    profiles: opts?.profiles ?? [profile('a')],
    usage: opts?.usage ?? new Map<string, UsageSnapshot | null>(),
    launchOk: opts?.launchOk ?? true,
    settled,
    launches,
    refreshes,
    notices,
  };
  const deps: DispatchHostDeps = {
    pending: () => h.entries.filter((e) => !settled.has(e.id)),
    settle: async (id, done) => {
      settled.set(id, done);
    },
    profiles: () => h.profiles,
    usageMap: () => h.usage,
    refreshUsage: async (_profiles, force) => {
      refreshes.push(force);
    },
    defaultRouting: () => undefined,
    launch: async (l) => {
      launches.push(l.entry.id);
      return h.launchOk;
    },
    now: () => Date.now(),
    notify: (m) => {
      notices.push(m);
    },
  };
  return { h, host: new DispatchHost(deps) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

// -------------------------------------------------------------------- tests

describe('DispatchHost', () => {
  it('a poke is one debounced decision: launch, settle, one notice', async () => {
    const { h, host } = harness();
    host.poke();
    host.poke(); // the burst collapses
    await vi.advanceTimersByTimeAsync(DISPATCH_POKE_DEBOUNCE_MS + 1);
    expect(h.launches).toEqual(['e1']);
    expect(h.settled.get('e1')).toBe('launched');
    expect(h.notices).toHaveLength(1);
    // A poke decides against the cache — no forced refresh happened.
    expect(h.refreshes).toEqual([]);
    host.dispose();
  });

  it('a gated entry waits for resetsAt, and the wake force-refreshes before trusting anything', async () => {
    const resets = NOW + 2 * HOUR;
    const full = new Map<string, UsageSnapshot | null>([
      ['a', { fetchedAt: NOW, fiveHour: { utilization: 97, resetsAt: resets } }],
    ]);
    const { h, host } = harness({ usage: full });
    host.poke();
    await vi.advanceTimersByTimeAsync(DISPATCH_POKE_DEBOUNCE_MS + 1);
    expect(h.launches).toEqual([]); // held

    // The refresh the wake runs is what replaces the stale snapshot.
    h.usage = new Map([['a', { fetchedAt: resets, fiveHour: undefined } as UsageSnapshot]]);
    await vi.advanceTimersByTimeAsync(2 * HOUR + DISPATCH_MIN_WAKE_MS);
    expect(h.refreshes).toEqual([true]);
    expect(h.launches).toEqual(['e1']);
    expect(h.settled.get('e1')).toBe('launched');
    host.dispose();
  });

  it('a launch that does not bind stays queued and retries on the retry cadence', async () => {
    const { h, host } = harness({ launchOk: false });
    host.poke();
    await vi.advanceTimersByTimeAsync(DISPATCH_POKE_DEBOUNCE_MS + 1);
    expect(h.launches).toEqual(['e1']);
    expect(h.settled.has('e1')).toBe(false); // not settled as anything it is not
    expect(h.notices).toHaveLength(0);

    h.launchOk = true;
    await vi.advanceTimersByTimeAsync(DISPATCH_RETRY_MS + 1);
    expect(h.launches).toEqual(['e1', 'e1']);
    expect(h.settled.get('e1')).toBe('launched');
    host.dispose();
  });

  it('one launch per decision; the rest follow one forced refresh later', async () => {
    const { h, host } = harness({
      entries: [entry('one', { createdAt: NOW - 2 }), entry('two', { createdAt: NOW - 1 })],
    });
    host.poke();
    await vi.advanceTimersByTimeAsync(DISPATCH_POKE_DEBOUNCE_MS + 1);
    expect(h.launches).toEqual(['one']);

    await vi.advanceTimersByTimeAsync(DISPATCH_POST_LAUNCH_MS + 1);
    expect(h.refreshes).toEqual([true]); // the follow-up trusted nothing stale
    expect(h.launches).toEqual(['one', 'two']);
    host.dispose();
  });

  it('dispose stops the clock: nothing fires afterwards', async () => {
    const { h, host } = harness({
      entries: [entry('one', { createdAt: NOW - 2 }), entry('two', { createdAt: NOW - 1 })],
    });
    host.poke();
    await vi.advanceTimersByTimeAsync(DISPATCH_POKE_DEBOUNCE_MS + 1);
    expect(h.launches).toEqual(['one']);
    host.dispose();
    await vi.advanceTimersByTimeAsync(DISPATCH_POST_LAUNCH_MS + DISPATCH_RETRY_MS);
    expect(h.launches).toEqual(['one']);
  });

  it('an empty queue clears the timer instead of rechecking forever', async () => {
    const { h, host } = harness({ entries: [] });
    host.poke();
    await vi.advanceTimersByTimeAsync(DISPATCH_POKE_DEBOUNCE_MS + 1);
    expect(h.launches).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    host.dispose();
  });
});
