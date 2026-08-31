// test/idleClose.test.ts — the lifecycle engine's decision table.
//
// idleCloseDecisions is the ONLY automatic 1→2 transition (the idle timer,
// the detach-grace expiry, the capped grace pool) and reconcileTmuxDecisions
// is the activation-time comparison of live tmux sessions against state. Both
// are pure; the wiring in extension.ts supplies the world and acts. Everything
// decided is here, against hand-built facts — the same split chatAutoClose
// established.

import { describe, expect, it } from 'vitest';

import {
  GRACE_POOL_CAP,
  TOUCH_COALESCE_MS,
  idleCloseDecisions,
  lastEngagementMs,
  reconcileTmuxDecisions,
  type IdleClosePlan,
  type ReconcileRecordFacts,
  type SessionCloseFacts,
} from '../src/idleClose';
import { tmuxSessionName } from '../src/tmux';

const NOW = 1_755_600_000_000; // any fixed moment; only differences matter
const MIN = 60_000;

/** A bound, idle session, stale by exactly the default window unless
 *  overridden. */
function tab(sessionId: string, over: Partial<SessionCloseFacts> = {}): SessionCloseFacts {
  return {
    sessionId,
    isActiveTab: false,
    status: 'idle',
    pinned: false,
    closeAfterTurn: false,
    lastActivityMs: NOW - 30 * MIN,
    ...over,
  };
}

/** A graced (detached) session whose deadline has already passed. */
function graced(sessionId: string, over: Partial<SessionCloseFacts> = {}): SessionCloseFacts {
  return tab(sessionId, { graceUntilMs: NOW - 1, ...over });
}

function decide(
  sessions: SessionCloseFacts[],
  over: { closeAfterMinutes?: number; gracePoolCap?: number; now?: number } = {},
): IdleClosePlan {
  return idleCloseDecisions({
    now: over.now ?? NOW,
    closeAfterMinutes: over.closeAfterMinutes ?? 30,
    ...(over.gracePoolCap !== undefined ? { gracePoolCap: over.gracePoolCap } : {}),
    sessions,
  });
}

const empty: IdleClosePlan = {
  close: [],
  graceKill: [],
  graceEvict: [],
  markCloseAfterTurn: [],
  clearCloseAfterTurn: [],
};

describe('idleCloseDecisions: the timer', () => {
  it('closes a session idle for the whole window, keeps a fresher one', () => {
    const plan = decide([tab('stale'), tab('fresh', { lastActivityMs: NOW - 29 * MIN })]);
    expect(plan).toEqual({ ...empty, close: ['stale'] });
  });

  it('0 disables the timer — the setting has an off switch', () => {
    expect(decide([tab('ancient', { lastActivityMs: 0 })], { closeAfterMinutes: 0 }))
      .toEqual(empty);
  });

  it('never the active tab, however stale its transcript reads', () => {
    expect(decide([tab('front', { isActiveTab: true, lastActivityMs: 0 })]))
      .toEqual(empty);
  });

  it('never a busy or waiting session — those are queued instead', () => {
    const plan = decide([
      tab('working', { status: 'busy', lastActivityMs: 0 }),
      tab('blocked', { status: 'waiting', lastActivityMs: 0 }),
    ]);
    expect(plan.close).toEqual([]);
    expect(plan.markCloseAfterTurn.sort()).toEqual(['blocked', 'working']);
  });

  it('a busy session inside the window is not even queued', () => {
    expect(decide([tab('busy-fresh', { status: 'busy', lastActivityMs: NOW - MIN })]))
      .toEqual(empty);
  });

  it('unknown activity never closes — not knowing is not idleness', () => {
    expect(decide([tab('mystery', { lastActivityMs: Number.NaN })])).toEqual(empty);
  });

  it('a pinned session is exempt from the timer entirely', () => {
    expect(decide([tab('autonomous', { pinned: true, lastActivityMs: 0 })]))
      .toEqual(empty);
  });
});

describe('idleCloseDecisions: the close-after-turn queue', () => {
  it('fires on the first idle tick, whatever the timer says', () => {
    // The mark was an explicit decision already taken; even a freshly active
    // transcript (the turn that just ended) does not restart a 30-minute wait.
    const plan = decide(
      [tab('done', { closeAfterTurn: true, lastActivityMs: NOW - MIN })],
      { closeAfterMinutes: 0 },
    );
    expect(plan.close).toEqual(['done']);
  });

  it('waits while the turn is still in flight', () => {
    const plan = decide([tab('mid-turn', { closeAfterTurn: true, status: 'busy' })]);
    expect(plan.close).toEqual([]);
    // Already marked — no second mark.
    expect(plan.markCloseAfterTurn).toEqual([]);
  });

  it('clears when the user re-engages — the active tab outranks the queue', () => {
    const plan = decide([tab('reopened', { closeAfterTurn: true, isActiveTab: true })]);
    expect(plan).toEqual({ ...empty, clearCloseAfterTurn: ['reopened'] });
  });

  it('clears under a pin — keep-awake that closed after one turn is no pin', () => {
    const plan = decide([tab('pinned', { closeAfterTurn: true, pinned: true })]);
    expect(plan).toEqual({ ...empty, clearCloseAfterTurn: ['pinned'] });
  });

  it('a queued GRACED session dies through the grace kill, not the tab close', () => {
    const plan = decide([graced('detached', { closeAfterTurn: true })]);
    expect(plan.graceKill).toEqual(['detached']);
    expect(plan.close).toEqual([]);
  });
});

describe('idleCloseDecisions: the detach grace', () => {
  it('an unexpired grace waits — that is the whole point of the grace', () => {
    expect(decide([tab('hidden', { graceUntilMs: NOW + 5 * MIN, lastActivityMs: 0 })]))
      .toEqual(empty);
  });

  it('expiry kills an idle one, queues a busy one', () => {
    const plan = decide([
      graced('idle-out'),
      graced('busy-out', { status: 'busy' }),
    ]);
    expect(plan.graceKill).toEqual(['idle-out']);
    expect(plan.markCloseAfterTurn).toEqual(['busy-out']);
  });

  it('a pinned graced session outlives its deadline', () => {
    expect(decide([graced('kept', { pinned: true, lastActivityMs: 0 })])).toEqual(empty);
  });

  it('the grace kill does not need the timer to be on', () => {
    const plan = decide([graced('expired')], { closeAfterMinutes: 0 });
    expect(plan.graceKill).toEqual(['expired']);
  });
});

describe('idleCloseDecisions: the grace pool cap', () => {
  const inGrace = (id: string, idleMin: number, over: Partial<SessionCloseFacts> = {}) =>
    tab(id, {
      graceUntilMs: NOW + 5 * MIN,
      lastActivityMs: NOW - idleMin * MIN,
      ...over,
    });

  it('ships with the cap the incident demanded', () => {
    expect(GRACE_POOL_CAP).toBe(8);
  });

  it('overflow evicts oldest-idle first, exactly down to the cap', () => {
    const pool = [
      inGrace('a', 10),
      inGrace('b', 50), // oldest — evicted first
      inGrace('c', 30), // second oldest — evicted second
      inGrace('d', 20),
      inGrace('e', 5),
    ];
    const plan = decide(pool, { gracePoolCap: 3 });
    expect(plan.graceEvict).toEqual(['b', 'c']);
  });

  it('unknown idleness sorts newest — never the first out the door', () => {
    const plan = decide(
      [inGrace('known-old', 50), inGrace('mystery', 0, { lastActivityMs: Number.NaN })],
      { gracePoolCap: 1 },
    );
    expect(plan.graceEvict).toEqual(['known-old']);
  });

  it('a busy member cannot be evicted — the oldest IDLE one goes in its place', () => {
    const plan = decide(
      [inGrace('busy-old', 50, { status: 'busy' }), inGrace('fresh', 1)],
      { gracePoolCap: 1 },
    );
    expect(plan.graceEvict).toEqual(['fresh']);
    expect(plan.markCloseAfterTurn).toEqual([]);
  });

  it('an all-busy overflow is queued, oldest first — the pool drains as turns end', () => {
    const plan = decide(
      [
        inGrace('busy-a', 50, { status: 'busy' }),
        inGrace('busy-b', 10, { status: 'busy' }),
      ],
      { gracePoolCap: 1 },
    );
    expect(plan.graceEvict).toEqual([]);
    expect(plan.markCloseAfterTurn).toEqual(['busy-a']);
  });

  it('a pinned member holds its slot but is never evicted', () => {
    // The cap bounds memory, and a pinned process costs memory like any other
    // — so the pin squeezes the UNPINNED members out instead.
    const plan = decide(
      [inGrace('pinned', 50, { pinned: true }), inGrace('victim', 10)],
      { gracePoolCap: 1 },
    );
    expect(plan.graceEvict).toEqual(['victim']);
  });

  it("this tick's expiries count against the cap before anyone is evicted", () => {
    const plan = decide(
      [graced('expired', { lastActivityMs: NOW - 50 * MIN }), inGrace('kept', 10)],
      { gracePoolCap: 1 },
    );
    expect(plan.graceKill).toEqual(['expired']);
    expect(plan.graceEvict).toEqual([]);
  });
});

// ---------------------------------------------------------------- reconcile

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';

function fact(sessionId: string, over: Partial<ReconcileRecordFacts> = {}): ReconcileRecordFacts {
  return {
    sessionId,
    boundToLiveWindow: false,
    updatedAtMs: NOW - 60 * MIN, // stale enough that freshness never claims
    ...over,
  };
}

function reconcile(input: {
  liveNames?: string[];
  records?: ReconcileRecordFacts[];
  boundHere?: string[];
  attachedNames?: string[];
}) {
  return reconcileTmuxDecisions({
    now: NOW,
    liveNames: input.liveNames ?? [],
    records: input.records ?? [],
    boundHere: new Set(input.boundHere ?? []),
    attachedNames: new Set(input.attachedNames ?? []),
  });
}

describe('reconcileTmuxDecisions', () => {
  it('kills a live session nothing claims, and closes its record', () => {
    const name = tmuxSessionName(S1);
    const plan = reconcile({
      liveNames: [name],
      records: [fact(S1, { tmux: name })],
    });
    expect(plan.killNames).toEqual([name]);
    expect(plan.closeIds).toEqual([S1]);
  });

  it('kills a live session with NO record at all — the orphan of orphans', () => {
    const name = tmuxSessionName(S1);
    const plan = reconcile({ liveNames: [name], records: [fact(S3)] });
    expect(plan.killNames).toEqual([name]);
    expect(plan.closeIds).toEqual([]);
  });

  // A store that knows of nothing reaches "nothing claims this" about every
  // session on the socket, and it is wrong about all of them.
  it('judges nothing at all on a store with no records in it', () => {
    const plan = reconcile({
      liveNames: [S1, S2].map(tmuxSessionName),
      records: [],
    });
    expect(plan).toEqual({ killNames: [], closeIds: [], clearTmuxIds: [] });
  });

  // The Cursor-beside-VS-Code incident: a second editor's first activation
  // has an EMPTY store, so every one of the store-side claims is absent —
  // and every session on the shared socket reads as the orphan above. The
  // attached client is the one fact that crosses the store boundary.
  it('spares a live session a client is attached to, record or no record', () => {
    const orphan = tmuxSessionName(S1);
    const stale = tmuxSessionName(S2);
    const plan = reconcile({
      liveNames: [orphan, stale],
      attachedNames: [orphan, stale],
      records: [fact(S2, { tmux: stale })],
    });
    expect(plan.killNames).toEqual([]);
    expect(plan.closeIds).toEqual([]);
    expect(plan.clearTmuxIds).toEqual([]);
  });

  it('still kills the unattached orphan sitting next to an attached one', () => {
    const attached = tmuxSessionName(S1);
    const parked = tmuxSessionName(S2);
    const plan = reconcile({
      liveNames: [attached, parked],
      attachedNames: [attached],
      records: [fact(S2, { tmux: parked })],
    });
    expect(plan.killNames).toEqual([parked]);
    expect(plan.closeIds).toEqual([S2]);
  });

  it('spares every kind of claim: bound here, graced, live window, fresh', () => {
    const names = [S1, S2, S3].map(tmuxSessionName);
    const fresh = tmuxSessionName('44444444-4444-4444-8444-444444444444');
    const plan = reconcile({
      liveNames: [...names, fresh],
      boundHere: [S1],
      records: [
        fact(S2, { tmux: names[1] as string, graceUntilMs: NOW - 1 }), // even expired
        fact(S3, { tmux: names[2] as string, boundToLiveWindow: true }),
        fact('44444444-4444-4444-8444-444444444444', {
          tmux: fresh,
          updatedAtMs: NOW - 30_000, // written moments ago — claim in flight
        }),
      ],
    });
    expect(plan.killNames).toEqual([]);
    expect(plan.closeIds).toEqual([]);
  });

  it('the grace claim is honoured even when the record is found by NAME (the chain tip)', () => {
    // The tmux name encodes the LAUNCH-time id; the grace lives on the tip.
    const name = tmuxSessionName(S1);
    const plan = reconcile({
      liveNames: [name],
      records: [fact(S2, { tmux: name, graceUntilMs: NOW + MIN })],
    });
    expect(plan.killNames).toEqual([]);
  });

  it('a PINNED record claims its live session — the window-close survivor is spared', () => {
    // A pin means "this run outlives my windows", so the window-close path
    // deliberately stamps NO grace deadline on a pinned chain. What that
    // leaves behind — live wrap, no grace, stale record, no live window — is
    // exactly what the unclaimed-kill would match; the pin has to be a claim
    // here or the reconcile becomes the killer the stamp refused to be.
    const name = tmuxSessionName(S1);
    const plan = reconcile({
      liveNames: [name],
      records: [fact(S1, { tmux: name, pinned: true })],
    });
    expect(plan.killNames).toEqual([]);
    expect(plan.closeIds).toEqual([]);
  });

  it('the pin claims through the NAME lookup too (grace holder on the chain tip)', () => {
    const name = tmuxSessionName(S1);
    const plan = reconcile({
      liveNames: [name],
      records: [fact(S2, { tmux: name, pinned: true })],
    });
    expect(plan.killNames).toEqual([]);
  });

  it('an UNPINNED twin of the same facts is still killed — the pin is the whole difference', () => {
    const name = tmuxSessionName(S1);
    const plan = reconcile({
      liveNames: [name],
      records: [fact(S1, { tmux: name, pinned: false })],
    });
    expect(plan.killNames).toEqual([name]);
    expect(plan.closeIds).toEqual([S1]);
  });

  it('a pin never fakes a process: a pinned record naming a DEAD session is still cleaned', () => {
    const plan = reconcile({
      records: [
        fact(S1, { tmux: tmuxSessionName(S1), pinned: true }),
        fact(S2, {
          tmux: tmuxSessionName(S2),
          pinned: true,
          graceUntilMs: NOW + MIN,
        }),
      ],
    });
    // The bare stale name is cleared; the graced one was covering a corpse
    // and closes — keeping either would leave a row promising a process that
    // does not exist, which the pin has no authority over.
    expect(plan.clearTmuxIds).toEqual([S1]);
    expect(plan.closeIds).toEqual([S2]);
  });

  it('leaves names it did not mint alone — not ours to judge', () => {
    const plan = reconcile({ liveNames: ['someones-experiment'] });
    expect(plan).toEqual({ killNames: [], closeIds: [], clearTmuxIds: [] });
  });

  it('clears a record naming a DEAD session', () => {
    const plan = reconcile({
      records: [fact(S1, { tmux: tmuxSessionName(S1) })],
    });
    expect(plan.clearTmuxIds).toEqual([S1]);
    expect(plan.closeIds).toEqual([]);
  });

  it('closes a graced record whose process is already gone — the countdown was covering a corpse', () => {
    const plan = reconcile({
      records: [fact(S1, { tmux: tmuxSessionName(S1), graceUntilMs: NOW + MIN })],
    });
    expect(plan.closeIds).toEqual([S1]);
    expect(plan.clearTmuxIds).toEqual([]);
  });

  it('closes a grace with no wrap under it — a claim over nothing', () => {
    const plan = reconcile({
      records: [fact(S1, { graceUntilMs: NOW + MIN })],
    });
    expect(plan.closeIds).toEqual([S1]);
  });

  it('never closes one record twice, whatever combination of lies it tells', () => {
    const name = tmuxSessionName(S1);
    const plan = reconcile({
      liveNames: [name],
      records: [fact(S1, { tmux: name, graceUntilMs: undefined })],
    });
    expect(plan.closeIds).toEqual([S1]);
    expect(plan.clearTmuxIds).toEqual([]);
  });
});

describe('lastEngagementMs — the two halves of the idle clock', () => {
  it('takes the newer half, whichever it is', () => {
    expect(
      lastEngagementMs({ lastRecordMs: NOW - 90 * MIN, touchedMs: NOW - MIN }),
    ).toBe(NOW - MIN);
    expect(
      lastEngagementMs({ lastRecordMs: NOW - MIN, touchedMs: NOW - 90 * MIN }),
    ).toBe(NOW - MIN);
  });

  it('a click alone is engagement — the whole point of the second half', () => {
    // The complaint this fixes: a session nobody has spoken to since Monday
    // but that the user opens every morning is IN USE, and the transcript is
    // the one place that fact never appears.
    expect(lastEngagementMs({ touchedMs: NOW - MIN })).toBe(NOW - MIN);
    expect(lastEngagementMs({ lastRecordMs: NOW - MIN })).toBe(NOW - MIN);
  });

  it('falls back only when NEITHER clock is known', () => {
    expect(lastEngagementMs({ fallbackMs: NOW - 5 * MIN })).toBe(NOW - 5 * MIN);
    // A known clock beats the fallback even when the fallback is newer: the
    // bind time is a floor, not a competitor.
    expect(
      lastEngagementMs({ lastRecordMs: NOW - 90 * MIN, fallbackMs: NOW }),
    ).toBe(NOW - 90 * MIN);
  });

  it('never invents a moment — no clocks and no fallback is NaN', () => {
    expect(lastEngagementMs({})).toBeNaN();
    expect(Number.isNaN(lastEngagementMs({ lastRecordMs: Number.NaN }))).toBe(
      true,
    );
  });

  it('non-finite inputs are ignored, not ranked', () => {
    // Date.parse of a hand-edited stamp, a transcript with no parseable tail:
    // both arrive as NaN and must not win a Math.max, and must not suppress
    // the half that IS known.
    expect(
      lastEngagementMs({ lastRecordMs: Number.NaN, touchedMs: NOW - MIN }),
    ).toBe(NOW - MIN);
    expect(
      lastEngagementMs({
        lastRecordMs: Number.POSITIVE_INFINITY,
        touchedMs: NOW - MIN,
      }),
    ).toBe(NOW - MIN);
    // Both halves unknown but a fallback present — the bound-tab case that
    // used to close a session clicked a minute ago.
    expect(
      lastEngagementMs({
        lastRecordMs: Number.NaN,
        touchedMs: Number.NaN,
        fallbackMs: NOW - 5 * MIN,
      }),
    ).toBe(NOW - 5 * MIN);
  });

  it('a touch inside the coalescing window still moves the clock', () => {
    // The throttle is a WRITE policy, not a decision policy: the sweep reads
    // whatever stamp is on the record, and a stamp up to a minute stale is
    // exactly the resolution loss the constant buys.
    const touched = NOW - TOUCH_COALESCE_MS;
    const plan = idleCloseDecisions({
      now: NOW,
      closeAfterMinutes: 30,
      sessions: [
        tab('t', {
          lastActivityMs: lastEngagementMs({
            lastRecordMs: NOW - 90 * MIN,
            touchedMs: touched,
          }),
        }),
      ],
    });
    expect(plan.close).toEqual([]);
  });
});

describe('the engagement clock, through the decision', () => {
  it('a session clicked just now is not closed, however old its last turn', () => {
    const plan = idleCloseDecisions({
      now: NOW,
      closeAfterMinutes: 3 * 24 * 60, // the shipped default: three days
      sessions: [
        tab('stale-transcript-fresh-click', {
          lastActivityMs: lastEngagementMs({
            lastRecordMs: NOW - 9 * 24 * 60 * MIN,
            touchedMs: NOW - 2 * MIN,
          }),
        }),
      ],
    });
    expect(plan.close).toEqual([]);
  });

  it('and one nobody has touched or spoken to for four days is', () => {
    const cold = NOW - 4 * 24 * 60 * MIN;
    const plan = idleCloseDecisions({
      now: NOW,
      closeAfterMinutes: 3 * 24 * 60,
      sessions: [
        tab('cold', {
          lastActivityMs: lastEngagementMs({
            lastRecordMs: cold,
            touchedMs: cold,
          }),
        }),
      ],
    });
    expect(plan.close).toEqual(['cold']);
  });
});
