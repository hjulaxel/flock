// test/dispatchHost.test.ts — the CONTRACT under test: src/dispatchHost.ts.
//
// Fake timers throughout the unit block: the host's promises are about WHEN —
// a poke is one debounced decision, a wake at `resetsAt` force-refreshes
// before trusting anything, a failed launch retries instead of settling, and a
// launch with entries still waiting is followed up one refresh later, not one
// tick later. The doubles are closures over plain arrays; nothing here mocks a
// module.
//
// The store double DOES model one thing faithfully: the claim. It answers
// `claim` with dispatch.ts's own rule rather than a re-implementation of it,
// because a double that decided ownership its own way would prove nothing
// about the real store. The last block drops the double entirely and races two
// real hosts over one real StateStore, which is the case the claim exists for.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DISPATCH_MIN_WAKE_MS,
  DISPATCH_POKE_DEBOUNCE_MS,
  DISPATCH_POST_LAUNCH_MS,
  DISPATCH_RETRY_MS,
  DispatchHost,
} from '../src/dispatchHost';
import type {
  DispatchHostDeps,
  DispatchLaunchOutcome,
} from '../src/dispatchHost';
import { claimableDispatch, dispatchClaim } from '../src/dispatch';
import { StateStore } from '../src/state';
import { DISPATCH_CLAIM_TTL_MS } from '../src/types';
import type {
  AccountProfile,
  DispatchRecord,
  UsageSnapshot,
} from '../src/types';

// ------------------------------------------------------------------ helpers

const NOW = Date.parse('2026-03-04T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const WINDOW = 'window-a';

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

function entry(id: string, over: Partial<DispatchRecord> = {}): DispatchRecord {
  return {
    id,
    createdAt: NOW - HOUR,
    updatedAt: new Date(NOW - HOUR).toISOString(),
    ...over,
  };
}

/** A test harness: a queue that behaves like the store's claim protocol, a
 *  usage map the test may swap, and recorders for every side effect. */
function harness(opts?: {
  entries?: DispatchRecord[];
  profiles?: AccountProfile[];
  usage?: ReadonlyMap<string, UsageSnapshot | null>;
  outcome?: DispatchLaunchOutcome;
  windowId?: string;
  /** False models a claim that reached this window's MEMORY and never the
   *  file — the read outage state.claimDispatch reports as `false`. */
  claimWrites?: boolean;
  /** The scope fence, as the wiring asks it. Absent means "this window can
   *  host anything", which is what every other test here assumes. */
  canHost?: (entry: DispatchRecord) => boolean;
}) {
  const records = new Map<string, DispatchRecord>(
    (opts?.entries ?? [entry('e1')]).map((e) => [e.id, { ...e }]),
  );
  const launches: string[] = [];
  const refreshes: boolean[] = [];
  const notices: string[] = [];
  const h = {
    records,
    profiles: opts?.profiles ?? [profile('a')],
    usage: opts?.usage ?? new Map<string, UsageSnapshot | null>(),
    outcome: opts?.outcome ?? ('launched' as DispatchLaunchOutcome),
    windowId: opts?.windowId ?? WINDOW,
    claimWrites: opts?.claimWrites ?? true,
    launches,
    refreshes,
    notices,
    claimOf: (id: string) => records.get(id)?.claimedBy,
    doneOf: (id: string) => records.get(id)?.done,
  };
  const deps: DispatchHostDeps = {
    pending: () =>
      [...records.values()]
        .filter((r) => r.done === undefined)
        .map((r) => ({ ...r })),
    windowId: h.windowId,
    // The store's mutex, modelled with the store's own rule — INCLUDING its
    // return contract: true only when a claim of ours actually reached the
    // store. `claimWrites: false` models the read-outage case, where the
    // claim lands in this window's memory and nowhere else (state.ts).
    claim: async (id) => {
      const rec = records.get(id);
      if (!rec) return false;
      if (!claimableDispatch(dispatchClaim(rec, h.windowId, Date.now()))) {
        return false;
      }
      rec.claimedBy = h.windowId;
      rec.claimedAt = new Date().toISOString();
      return h.claimWrites;
    },
    release: async (id) => {
      const rec = records.get(id);
      if (!rec) return;
      if (dispatchClaim(rec, h.windowId, Date.now()) !== 'mine') return;
      delete rec.claimedBy;
      delete rec.claimedAt;
    },
    settle: async (id, done) => {
      const rec = records.get(id);
      if (rec && rec.done === undefined) rec.done = done;
    },
    ...(opts?.canHost ? { canHost: opts.canHost } : {}),
    profiles: () => h.profiles,
    usageMap: () => h.usage,
    refreshUsage: async (_profiles, force) => {
      refreshes.push(force);
    },
    defaultRouting: () => undefined,
    launch: async (l) => {
      launches.push(l.entry.id);
      return h.outcome;
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
  it('a poke is one debounced decision: claim, launch, settle, one notice', async () => {
    const { h, host } = harness();
    host.poke();
    host.poke(); // the burst collapses
    await vi.advanceTimersByTimeAsync(DISPATCH_POKE_DEBOUNCE_MS + 1);
    expect(h.launches).toEqual(['e1']);
    expect(h.claimOf('e1')).toBe(WINDOW); // claimed BEFORE the launch
    expect(h.doneOf('e1')).toBe('launched');
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
    expect(h.claimOf('e1')).toBeUndefined(); // a held entry is never claimed

    // The refresh the wake runs is what replaces the stale snapshot.
    h.usage = new Map([['a', { fetchedAt: resets, fiveHour: undefined } as UsageSnapshot]]);
    await vi.advanceTimersByTimeAsync(2 * HOUR + DISPATCH_MIN_WAKE_MS);
    expect(h.refreshes).toEqual([true]);
    expect(h.launches).toEqual(['e1']);
    expect(h.doneOf('e1')).toBe('launched');
    host.dispose();
  });

  it('a launch that does not bind stays queued, hands the claim back, and retries', async () => {
    const { h, host } = harness({ outcome: 'failed' });
    host.poke();
    await vi.advanceTimersByTimeAsync(DISPATCH_POKE_DEBOUNCE_MS + 1);
    expect(h.launches).toEqual(['e1']);
    expect(h.doneOf('e1')).toBeUndefined(); // not settled as anything it is not
    // A claim covers a launch IN FLIGHT: nothing started, so nothing is held
    // and any window may try next.
    expect(h.claimOf('e1')).toBeUndefined();
    expect(h.notices).toHaveLength(0);

    h.outcome = 'launched';
    await vi.advanceTimersByTimeAsync(DISPATCH_RETRY_MS + 1);
    expect(h.launches).toEqual(['e1', 'e1']);
    expect(h.doneOf('e1')).toBe('launched');
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

// ------------------------------------------------------------------- claims

describe('DispatchHost: the launch claim', () => {
  it('another window holds a live claim: this host neither launches nor settles', async () => {
    const { h, host } = harness({
      entries: [
        entry('e1', {
          claimedBy: 'window-b',
          claimedAt: new Date(NOW - 1_000).toISOString(),
        }),
      ],
    });
    host.poke();
    await vi.advanceTimersByTimeAsync(DISPATCH_POKE_DEBOUNCE_MS + 1);
    expect(h.launches).toEqual([]);
    // Settling would tombstone an entry whose real launch is still in flight.
    expect(h.doneOf('e1')).toBeUndefined();
    expect(h.claimOf('e1')).toBe('window-b'); // and the claim is untouched
    expect(h.notices).toEqual([]);
    host.dispose();
  });

  it('a lost claim still re-arms: the queue does not go deaf on a contested entry', async () => {
    const { h, host } = harness({
      entries: [
        entry('e1', {
          claimedBy: 'window-b',
          claimedAt: new Date(NOW - 1_000).toISOString(),
        }),
      ],
    });
    host.poke();
    await vi.advanceTimersByTimeAsync(DISPATCH_POKE_DEBOUNCE_MS + 1);
    expect(h.launches).toEqual([]);

    // The winner turned out to be a window that could not run it and released
    // the claim; the retry pass is what notices.
    delete h.records.get('e1')!.claimedBy;
    delete h.records.get('e1')!.claimedAt;
    await vi.advanceTimersByTimeAsync(DISPATCH_RETRY_MS + 1);
    expect(h.launches).toEqual(['e1']);
    expect(h.doneOf('e1')).toBe('launched');
    host.dispose();
  });

  // A CLAIM THAT DID NOT PERSIST FENCES NOBODY. The re-read reads MEMORY, so
  // an unwritten claim comes back as ours — in every window at once, since the
  // file is unreadable for all of them. So the host needs the store's write
  // receipt as well, and fail-closed there is free: the entry stays queued.
  it('launches nothing when the claim never reached the store', async () => {
    const { h, host } = harness({ claimWrites: false });
    host.poke();
    await vi.advanceTimersByTimeAsync(DISPATCH_POKE_DEBOUNCE_MS + 1);
    // The claim IS in this window's memory — which is exactly why the re-read
    // is not enough on its own.
    expect(h.claimOf('e1')).toBe(WINDOW);
    expect(h.launches).toEqual([]);
    expect(h.doneOf('e1')).toBeUndefined();
    expect(h.notices).toEqual([]);

    // It is a hold, not a give-up: the retry cadence brings it back, and the
    // pass that can write launches it.
    h.claimWrites = true;
    await vi.advanceTimersByTimeAsync(DISPATCH_RETRY_MS + 1);
    expect(h.launches).toEqual(['e1']);
    expect(h.doneOf('e1')).toBe('launched');
    host.dispose();
  });

  it('a stale claim is reclaimable — a window that died mid-launch parks nothing', async () => {
    const { h, host } = harness({
      entries: [
        entry('e1', {
          claimedBy: 'window-b',
          claimedAt: new Date(NOW - DISPATCH_CLAIM_TTL_MS - 1).toISOString(),
        }),
      ],
    });
    host.poke();
    await vi.advanceTimersByTimeAsync(DISPATCH_POKE_DEBOUNCE_MS + 1);
    expect(h.claimOf('e1')).toBe(WINDOW);
    expect(h.launches).toEqual(['e1']);
    expect(h.doneOf('e1')).toBe('launched');
    host.dispose();
  });

  it('a window with no identity never launches: it holds instead of racing', async () => {
    const { h, host } = harness({ windowId: '' });
    host.poke();
    await vi.advanceTimersByTimeAsync(DISPATCH_POKE_DEBOUNCE_MS + 1);
    expect(h.launches).toEqual([]);
    expect(h.doneOf('e1')).toBeUndefined();
    host.dispose();
  });
});

// ------------------------------------------------------------------- fenced

describe('DispatchHost: an entry this window cannot run', () => {
  it('is reported stranded, not retried silently, and the claim goes back', async () => {
    const { h, host } = harness({
      outcome: 'fenced',
      entries: [entry('e1', { title: 'Ship it', cwd: '/code/api' })],
    });
    host.poke();
    await vi.advanceTimersByTimeAsync(DISPATCH_POKE_DEBOUNCE_MS + 1);
    expect(h.launches).toEqual(['e1']);
    expect(h.doneOf('e1')).toBeUndefined(); // still queued for another window
    expect(h.claimOf('e1')).toBeUndefined(); // released, so that window may take it
    // The user is TOLD, and told what would move it — the queue picker's row
    // cannot say this, because it depends on which window is asking.
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain('Ship it');
    expect(h.notices[0]).toMatch(/folder/);
    // NAMING the directory. "Open that folder" without saying which folder is
    // a notice the user cannot act on, and `entry.cwd` is always there for
    // anything the queue verb enqueued.
    expect(h.notices[0]).toContain('/code/api');

    // And no five-minute retry loop: nothing about this window will change.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(DISPATCH_RETRY_MS * 3);
    expect(h.launches).toEqual(['e1']);
    host.dispose();
  });

  // THE ENTRY BEHIND A FENCED ONE. Asked only inside the launch, the fence
  // came AFTER the decision and after the claim: a fenced entry took the
  // account's one launch per round, so the hostable entry behind it never ran
  // in any round — and the only notice named the fenced entry. Half-closed is
  // "a queued prompt that never runs with the user never told".
  it('launches the hostable entry on the first pass, over one account', async () => {
    const { h, host } = harness({
      entries: [
        entry('e1', { cwd: '/elsewhere', title: 'fenced' }), // older, fenced
        entry('e2', { createdAt: NOW - 60_000, title: 'mine' }),
      ],
      canHost: (e) => e.cwd !== '/elsewhere',
    });
    host.poke();
    await vi.advanceTimersByTimeAsync(DISPATCH_POKE_DEBOUNCE_MS + 1);

    expect(h.launches).toEqual(['e2']);
    expect(h.doneOf('e2')).toBe('launched');
    // The fenced one is still queued for a window that CAN take it, and the
    // user was told which folder would let it start.
    expect(h.doneOf('e1')).toBeUndefined();
    expect(h.notices.some((n) => n.includes('/elsewhere'))).toBe(true);
    host.dispose();
  });

  it('takes no claim and writes nothing for an entry it cannot host', async () => {
    // The second cost of asking late: claim + release on every usage poke,
    // forever, each one a whole-file state.json write that may also win the
    // race against the window that can actually run the entry.
    const { h, host } = harness({
      entries: [entry('e1', { cwd: '/elsewhere' })],
      canHost: () => false,
    });
    host.poke();
    await vi.advanceTimersByTimeAsync(DISPATCH_POKE_DEBOUNCE_MS + 1);
    expect(h.launches).toEqual([]);
    expect(h.claimOf('e1')).toBeUndefined();
    expect(h.doneOf('e1')).toBeUndefined();
    expect(h.notices).toHaveLength(1);
    host.dispose();
  });

  it('tells the user once, however many times the decision runs', async () => {
    const { h, host } = harness({ outcome: 'fenced' });
    host.poke();
    await vi.advanceTimersByTimeAsync(DISPATCH_POKE_DEBOUNCE_MS + 1);
    host.poke();
    await vi.advanceTimersByTimeAsync(DISPATCH_POKE_DEBOUNCE_MS + 1);
    host.poke();
    await vi.advanceTimersByTimeAsync(DISPATCH_POKE_DEBOUNCE_MS + 1);
    expect(h.launches).toEqual(['e1', 'e1', 'e1']); // it keeps being asked
    expect(h.notices).toHaveLength(1); // and keeps its mouth shut about it
    host.dispose();
  });
});

// ------------------------------------------------------- two windows, one store
//
// No doubles and no fake timers: the hole this closes is two extension hosts
// over ONE state.json, both awake on the same account reset, and the only
// honest test of it is two real hosts over one real store.

describe('DispatchHost: two windows over one store', () => {
  const dirs: string[] = [];
  const stores: StateStore[] = [];

  function tempDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-dispatch-'));
    dirs.push(d);
    return d;
  }

  afterEach(() => {
    for (const s of stores.splice(0)) s.dispose();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  /** One window: its own StateStore over the shared directory, its own host. */
  async function window(dir: string, windowId: string) {
    const store = new StateStore(dir);
    stores.push(store);
    await store.load();
    const launches: string[] = [];
    const settles: string[] = [];
    const host = new DispatchHost({
      pending: () => store.dispatchEntries().filter((d) => d.done === undefined),
      windowId,
      claim: (id) => store.claimDispatch(id, windowId),
      release: (id) => store.releaseDispatchClaim(id, windowId),
      settle: async (id, done) => {
        settles.push(id);
        await store.settleDispatch(id, done);
      },
      profiles: () => [profile('a')],
      usageMap: () => new Map(),
      refreshUsage: async () => undefined,
      defaultRouting: () => undefined,
      launch: async (l) => {
        launches.push(l.entry.id);
        return 'launched';
      },
      now: () => Date.now(),
    });
    return { store, host, launches, settles };
  }

  it('exactly one window launches the entry; the loser launches and settles nothing', async () => {
    vi.useRealTimers();
    const dir = tempDir();
    const a = await window(dir, 'window-a');
    await a.store.queueDispatch({ id: 'e1', createdAt: Date.now() - HOUR });
    const b = await window(dir, 'window-b');
    expect(b.store.dispatchEntries()).toHaveLength(1);

    // Both wake on the same reset time, milliseconds apart — here, the same
    // tick. Before the claim, both launched it.
    a.host.poke();
    b.host.poke();
    await new Promise((r) => setTimeout(r, DISPATCH_POKE_DEBOUNCE_MS + 400));

    const all = [...a.launches, ...b.launches];
    expect(all).toEqual(['e1']);
    expect([...a.settles, ...b.settles]).toEqual(['e1']);
    // The loser is the one that did nothing — and both agree who won.
    const loser = a.launches.length === 0 ? a : b;
    expect(loser.launches).toEqual([]);
    expect(loser.settles).toEqual([]);

    a.host.dispose();
    b.host.dispose();
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(dir, 'state.json'), 'utf8'),
    ) as { dispatch?: Record<string, DispatchRecord> };
    expect(onDisk.dispatch?.e1?.done).toBe('launched');
    expect(onDisk.dispatch?.e1?.claimedBy).toBeTruthy();
  });
});
