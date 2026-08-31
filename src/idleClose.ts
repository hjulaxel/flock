// src/idleClose.ts — the lifecycle engine: when does a session leave level 1?
//
// THE MODEL (design/levels-and-modes.md). A session is on exactly one of
// three levels: 1 — running, shown; 2 — no process, an archived row a click
// resumes; 3 — no row (`deleted`), transcript intact. The transcript is the
// session; the process is a warm cache over it. What this module decides is
// the ONLY automatic 1→2 transition, and every rule below exists to make that
// transition safe to run unattended:
//
//   * never the ACTIVE tab — "idle" cannot describe the tab being looked at;
//   * never a BUSY or WAITING session — a turn in flight, or a permission
//     dialog someone must answer, outranks tidiness exactly as it does
//     everywhere else. Instead the session is marked CLOSE-AFTER-THIS-TURN —
//     a queue, not a state: the sweep closes it on the first tick that finds
//     it idle, and the mark clears if the user re-engages (the tab goes
//     active) or was pinned;
//   * a PINNED session (keep-awake) is exempt from everything here — the
//     timer, grace expiry, pool eviction. Long autonomous runs look idle
//     between turns; the pin is how the user says "I know, leave it".
//   * `closeAfterMinutes <= 0` disables the idle TIMER — 0 is the setting's
//     off switch. The close-after-turn queue and the grace machinery keep
//     working: both were armed by explicit events, not by the timer.
//   * a session whose last activity is UNKNOWN (non-finite) is never timed
//     out — a tab must not be closed on the strength of not knowing.
//
// THE DETACH GRACE is the one sanctioned running-but-detached state. Closing
// a tab (a workspace switch, solo mode) may leave a tmux-wrapped process
// alive for `detachGraceMinutes` so re-attach is instant — but it ALWAYS
// renders (a countdown row), it expires (idle → killed to level 2; busy →
// close-after-turn, the row still showing until the turn ends), and the pool
// is CAPPED. Overflow closes oldest-idle first: the cap is what makes "84
// invisible detached sessions, 32 GB" structurally impossible rather than
// merely unlikely.
//
// WHAT "IDLE" MEANS has TWO halves, and `lastEngagementMs` below is where
// they meet:
//
//   * what the CONVERSATION did — the last REAL transcript record's
//     timestamp, NEVER file mtime. Hooks and last-prompt bookkeeping touch
//     transcripts without new content (measured on this machine), and an
//     mtime-fed timer would keep a dead-idle session warm forever. See
//     usage.readTailStats().lastRecordAt for the supported source.
//   * what the USER did — EditorialRecord.touchedAt: clicking the row,
//     focusing the tab, revealing the terminal. Clicking a session is the
//     plainest statement there is that it is in use, and it leaves no trace
//     in the transcript at all. A clock that only read the first half closed
//     sessions the user had opened and returned to all week, on the grounds
//     that the model had not spoken since Monday.
//
// The newer of the two wins. Note what this does NOT change: the age the tree
// shows on a row is still "when this last got an answer", because that is the
// question a person reading the tree is asking. The two clocks are for two
// different readers, and only one of them closes anything.
//
// PURE, in the shape chatAutoCloseVictims (src/chatAutoClose.ts) established
// and this module generalizes: this decides, the wiring in extension.ts reads
// the world (bindings, roster, transcript tails, records) and acts. It also
// carries the RECONCILE decision — the activation-time comparison of live
// tmux sessions against state — because both answer the same question ("which
// processes have a right to be running?") from the same invariant: no running
// process without a visible row.
//
// This module NEVER imports vscode.

import { sessionIdOfTmuxName } from './tmux';
import type { SessionStatus } from './types';

/**
 * Cap on the detach-grace pool — how many sessions may run detached at once,
 * machine-wide. A constant rather than a setting, deliberately: the cap is
 * the safety property (bounded memory for hidden processes), and a knob would
 * be an invitation to re-create the unbounded state the branch exists to
 * remove. Sized like MAX_AUTO_RESUME (workspaces.ts), and for the same
 * reason: each entry is a live claude process with ~8 MCP children.
 */
export const GRACE_POOL_CAP = 8;

/**
 * How stale a session's `touchedAt` must be before another touch is written.
 *
 * Every tab switch is a touch, and a touch is a locked read-merge-write of
 * state.json whose whole record then wins the newest-wins merge against every
 * other window. Paying that on each flick between two tabs would be absurd for
 * a clock denominated in DAYS: a minute's resolution moves the close decision
 * by at most a minute out of four thousand three hundred and twenty. The
 * wiring compares against the stamp already on the record, so the coalescing
 * survives a window reload with no in-memory state to rebuild.
 */
export const TOUCH_COALESCE_MS = 60_000;

/**
 * The idle clock: the newest of what the conversation did and what the user
 * did, with a floor under both.
 *
 * Pure, and its own function rather than three `Math.max` calls at the two
 * call sites, because the RULE is the interesting part and both sweeps have to
 * apply the same one. Every input is optional and any of them may be
 * non-finite — a session with no transcript yet, a record with no touch, a
 * `Date.parse` of a hand-edited stamp — and the answer distinguishes the two
 * ways of knowing nothing:
 *
 *   * no clock at all and no fallback → NaN, which every caller reads as
 *     "never close on the strength of not knowing";
 *   * no clock but a fallback (the bind time — the tab is open, so SOMETHING
 *     happened at that moment) → the fallback.
 *
 * That second case is why the fallback is a parameter and not the caller's
 * `??`. A bound tab whose transcript tail happens to hold no parseable record
 * used to fall back to its bind time ALONE, so a tab opened this morning and
 * clicked a minute ago read as hours idle. Folding the touch in here fixes
 * that without the call site having to know it was ever a problem.
 */
export function lastEngagementMs(input: {
  /** Newest real transcript record across the generation chain. */
  lastRecordMs?: number;
  /** Newest `touchedAt` across the generation chain, as epoch ms. */
  touchedMs?: number;
  /** Used only when neither clock is known — the bind time / record birth. */
  fallbackMs?: number;
}): number {
  let best = Number.NaN;
  for (const value of [input.lastRecordMs, input.touchedMs]) {
    if (value === undefined || !Number.isFinite(value)) continue;
    if (!Number.isFinite(best) || value > best) best = value;
  }
  if (Number.isFinite(best)) return best;
  const fallback = input.fallbackMs;
  return fallback !== undefined && Number.isFinite(fallback)
    ? fallback
    : Number.NaN;
}

/** One session, reduced to the facts the decision needs. Built from the
 *  terminal registry + records + roster by extension.ts; by hand in tests. */
export interface SessionCloseFacts {
  /** The id the wiring can act on — close its terminal, kill its wrap,
   *  upsert its record. The chain TIP for graced records, the binding id for
   *  bound tabs (the wiring maps between them). */
  sessionId: string;
  /** This session's tab is the one the user is looking at right now. Always
   *  false for a graced session — grace means the tab is gone. */
  isActiveTab: boolean;
  /** The roster's answer, via the same normalizeStatus the tree's dots use. */
  status: SessionStatus;
  /** Keep-awake pin (EditorialRecord.pinned). */
  pinned: boolean;
  /** Already queued to close once its turn ends (EditorialRecord.closeAfterTurn). */
  closeAfterTurn: boolean;
  /** Epoch ms the detach grace expires — present IFF the session is in the
   *  grace pool (detached, process running, countdown row showing). */
  graceUntilMs?: number;
  /** Epoch ms of the last engagement — the newer of the last real transcript
   *  record and the last user touch, falling back to the bind time when
   *  neither is known. Built with `lastEngagementMs`; never mtime (see
   *  header). Non-finite = unknown, and unknown is never closed. */
  lastActivityMs: number;
}

/** What one sweep tick should do. Ids are unique within and across lists. */
export interface IdleClosePlan {
  /** Bound tabs to close to level 2 (dispose + kill the wrap's tree). */
  close: string[];
  /** Graced (detached) sessions whose deadline passed while idle — kill the
   *  tmux session and its process tree, stamp the record closed. */
  graceKill: string[];
  /** Grace-pool overflow, oldest-idle first — same kill, different reason
   *  (worth its own list for the log line that explains it). */
  graceEvict: string[];
  /** Busy/waiting sessions the timer or an expired grace landed on — mark
   *  `closeAfterTurn: true` instead of closing. */
  markCloseAfterTurn: string[];
  /** Marks that no longer apply — the user re-engaged (active tab) or pinned
   *  the session. Write `closeAfterTurn: false`. */
  clearCloseAfterTurn: string[];
}

/**
 * One sweep tick's decisions, over every session the window can see (bound
 * tabs AND graced records). Empty lists are the ordinary answer.
 */
export function idleCloseDecisions(input: {
  now: number;
  /** `lineage.session.closeAfterMinutes`; <= 0 disables the idle timer. */
  closeAfterMinutes: number;
  /** The pool cap; tests may shrink it. Defaults to GRACE_POOL_CAP. */
  gracePoolCap?: number;
  sessions: readonly SessionCloseFacts[];
}): IdleClosePlan {
  const { now, closeAfterMinutes, sessions } = input;
  const cap = input.gracePoolCap ?? GRACE_POOL_CAP;
  const plan: IdleClosePlan = {
    close: [],
    graceKill: [],
    graceEvict: [],
    markCloseAfterTurn: [],
    clearCloseAfterTurn: [],
  };
  if (!Number.isFinite(now)) return plan;

  const windowMs = closeAfterMinutes * 60_000;
  const timerOn = Number.isFinite(closeAfterMinutes) && closeAfterMinutes > 0;
  const busy = (s: SessionCloseFacts): boolean =>
    s.status === 'busy' || s.status === 'waiting';
  const idleLongEnough = (s: SessionCloseFacts): boolean =>
    timerOn &&
    Number.isFinite(s.lastActivityMs) &&
    now - s.lastActivityMs >= windowMs;

  const graced = sessions.filter((s) => s.graceUntilMs !== undefined);
  const killed = new Set<string>();

  for (const s of sessions) {
    // The pin outranks the queue too: a mark set before the pin must not fire
    // after it, or "keep awake" would keep exactly one turn.
    if (s.pinned) {
      if (s.closeAfterTurn) plan.clearCloseAfterTurn.push(s.sessionId);
      continue;
    }
    // Re-engagement outranks the queue: the mark was set against a tab nobody
    // was in, and the user is in it now.
    if (s.isActiveTab) {
      if (s.closeAfterTurn) plan.clearCloseAfterTurn.push(s.sessionId);
      continue;
    }
    if (busy(s)) {
      // Never closed, whatever the clocks say — but a deadline that landed on
      // a working session becomes a queue entry, so the FIRST idle tick ends
      // it rather than restarting a 30-minute wait.
      const deadlineHit =
        (s.graceUntilMs !== undefined && now >= s.graceUntilMs) ||
        (s.graceUntilMs === undefined && idleLongEnough(s));
      if (deadlineHit && !s.closeAfterTurn) {
        plan.markCloseAfterTurn.push(s.sessionId);
      }
      continue;
    }
    // Idle from here on.
    if (s.closeAfterTurn) {
      // The queue fires on the first idle tick, timer setting notwithstanding
      // — the mark was an explicit decision already taken.
      if (s.graceUntilMs !== undefined) {
        plan.graceKill.push(s.sessionId);
        killed.add(s.sessionId);
      } else {
        plan.close.push(s.sessionId);
      }
      continue;
    }
    if (s.graceUntilMs !== undefined) {
      if (now >= s.graceUntilMs) {
        plan.graceKill.push(s.sessionId);
        killed.add(s.sessionId);
      }
      // An unexpired grace waits — that is the whole point of the grace.
      continue;
    }
    if (idleLongEnough(s)) plan.close.push(s.sessionId);
  }

  // THE CAP. Whatever survives this tick's expiries must still fit the pool:
  // overflow closes oldest-idle first. Pinned members are never evicted but
  // still occupy their slot — the cap bounds memory, and a pinned process
  // costs memory like any other. Busy members cannot be killed (the rule
  // above is absolute), so an over-cap pool of working sessions is marked
  // close-after-turn instead and drains as turns end.
  const remaining = graced.filter((s) => !killed.has(s.sessionId));
  let excess = remaining.length - cap;
  if (excess > 0) {
    const oldestFirst = (a: SessionCloseFacts, b: SessionCloseFacts): number => {
      // Unknown activity sorts NEWEST: a session whose age we do not know is
      // never the one evicted first.
      const av = Number.isFinite(a.lastActivityMs) ? a.lastActivityMs : Infinity;
      const bv = Number.isFinite(b.lastActivityMs) ? b.lastActivityMs : Infinity;
      return av - bv;
    };
    const idleCandidates = remaining
      .filter((s) => !s.pinned && !busy(s))
      .sort(oldestFirst);
    for (const s of idleCandidates) {
      if (excess <= 0) break;
      plan.graceEvict.push(s.sessionId);
      excess--;
    }
    if (excess > 0) {
      const busyCandidates = remaining
        .filter((s) => !s.pinned && busy(s) && !s.closeAfterTurn)
        .sort(oldestFirst);
      for (const s of busyCandidates) {
        if (excess <= 0) break;
        if (!plan.markCloseAfterTurn.includes(s.sessionId)) {
          plan.markCloseAfterTurn.push(s.sessionId);
        }
        excess--;
      }
    }
  }
  return plan;
}

// ------------------------------------------------------------- reconcile

/** One editorial record, reduced to the facts the reconcile needs. */
export interface ReconcileRecordFacts {
  sessionId: string;
  /** The recorded wrap name (EditorialRecord.tmux), when set. */
  tmux?: string | null;
  /** Epoch ms of the grace deadline, when the record is in the pool. ANY
   *  value — expired included — counts as a claim here: expiry belongs to the
   *  sweep, which knows busy from idle; the reconcile does not. */
  graceUntilMs?: number;
  /** Keep-awake pin, over the record's whole generation CHAIN (the wiring
   *  expands it, exactly as it does for boundHere): the pin is the user
   *  saying "this long autonomous run outlives my windows", and the window-
   *  close path honours it by deliberately NOT stamping a grace deadline
   *  (extension.ts, the shutdown branch of onDidExit). Without this fact the
   *  reconcile would see exactly what that skip leaves behind — live wrap, no
   *  grace, no live window — and become the killer the stamp refused to be,
   *  two minutes after the next activation. A pinned record's live session
   *  therefore counts as CLAIMED. The pin never fakes a process, though: a
   *  pinned record naming a DEAD session is still cleaned up below. */
  pinned?: boolean;
  /** record.boundWindowId names a window whose record is alive. */
  boundToLiveWindow: boolean;
  /** record.updatedAt as epoch ms — the freshness guard below. */
  updatedAtMs: number;
}

/**
 * Session names a tmux CLIENT is currently attached to — `list-clients`
 * (tmux.queryClientSessions), which is machine-wide because the server is.
 *
 * THE INCIDENT THIS ANSWERS. Every other claim below is read out of the
 * editorial store, and the store used to live in `globalStorageUri` — per
 * editor APPLICATION. The `-L lineage` socket never did: one per machine.
 * Open Flock in a second editor (Cursor beside VS Code) and its first
 * activation listed seven live sessions its brand-new store had never heard
 * of, judged every one of them an orphan, and killed the lot — a reaper whose
 * reach was machine-wide and whose evidence was not. The store now lives in
 * one shared place (src/stateHome.ts), which removes the cause; this is the
 * fact that makes the rule safe on its own terms, and it protects the mixed
 * build, the failed migration and the second machine-wide reader nobody has
 * written yet.
 *
 * It is also simply TRUE, independent of any of that: a session with a client
 * attached is on someone's screen right now. None of the orphans this
 * reconcile exists to reap has one — a crash takes its clients with it, a
 * window closed mid-grace detached on the way out, and a parked leftover is
 * parked precisely because nothing is attached. So the rule costs the reaper
 * nothing it was ever meant to catch.
 */
export type AttachedNames = ReadonlySet<string>;

/** What one activation's reconcile should do. */
export interface ReconcilePlan {
  /** Live tmux sessions nothing claims — kill them (tree and all). */
  killNames: string[];
  /** Records to flip to level 2: stamp `closed`, clear `tmux` + `graceUntil`.
   *  Every killed session's record, plus every graced record whose process
   *  turned out to be dead already. */
  closeIds: string[];
  /** Records naming a tmux session that no longer exists — clear the name
   *  (`tmux: null`), or the next resume would try to attach to a ghost. */
  clearTmuxIds: string[];
}

/** How recently a record must have been written for the reconcile to stay its
 *  hand. Another window's launch lands in state via an async upsert; a
 *  session whose record moved in the last two minutes is someone's live work
 *  whose claim simply has not been flushed yet, not an orphan. */
export const RECONCILE_FRESH_MS = 2 * 60_000;

/**
 * The activation-time reconcile: `tmux -L lineage list-sessions` against
 * state. Two directions, one invariant (no running process without a visible
 * row):
 *
 *   * a LIVE session no window claims and no grace covers is an orphan — a
 *     crash, a window closed mid-grace, an old build's parked leftovers (the
 *     v7→v8 migration flips the records but cannot touch processes; this is
 *     what ends them). Kill to level 2. Measured motivation: state.json on
 *     this machine claimed 157 tmux-named records while 78 processes existed.
 *   * a record naming a DEAD session is a stale pointer — a resume routed
 *     through it would `new-session -A` a blank pane. Clear it; a graced one
 *     is closed outright (its countdown row was covering a corpse).
 *
 * Names that do not parse as ours (`sessionIdOfTmuxName`) are skipped: they
 * are on our socket but we did not mint them, and killing what we cannot
 * identify is how reapers earn distrust. `attachedNames` is the same
 * principle applied to a session we DID mint but cannot account for: somebody
 * is looking at it (see AttachedNames).
 */
export function reconcileTmuxDecisions(input: {
  now: number;
  liveNames: readonly string[];
  records: readonly ReconcileRecordFacts[];
  /** Session ids bound in THIS window, chain-expanded by the wiring. */
  boundHere: ReadonlySet<string>;
  /** @see AttachedNames. Absent (an old wiring, a tmux that would not answer)
   *  reads as "no client anywhere", which is the pre-existing behaviour. */
  attachedNames?: AttachedNames;
  freshMs?: number;
}): ReconcilePlan {
  const { now, liveNames, records, boundHere } = input;
  const attached: AttachedNames = input.attachedNames ?? new Set<string>();
  const freshMs = input.freshMs ?? RECONCILE_FRESH_MS;
  const plan: ReconcilePlan = { killNames: [], closeIds: [], clearTmuxIds: [] };
  // AN EMPTY STORE HAS NO STANDING. Every judgement below is "the store knows
  // of no claim on this", and a store that knows of nothing at all reaches
  // that verdict about every session on the socket by vacuous truth. That is
  // not a machine full of orphans, it is an installation that has not learned
  // anything yet: a first run, a store that could not be read, a migration
  // that deferred. Reaping on it is how a second editor came to kill seven
  // working sessions (see AttachedNames), and the next activation — by which
  // point there IS a record of something — loses nothing by waiting.
  if (records.length === 0) return plan;
  const live = new Set(liveNames);
  const closing = new Set<string>();

  const byId = new Map(records.map((r) => [r.sessionId, r]));
  const byName = new Map<string, ReconcileRecordFacts>();
  for (const r of records) {
    if (typeof r.tmux === 'string' && r.tmux !== '') byName.set(r.tmux, r);
  }

  for (const name of liveNames) {
    const id = sessionIdOfTmuxName(name);
    if (id === undefined) continue; // not ours to judge
    // The name encodes the LAUNCH-time id, but the record that claims the wrap
    // (grace, window binding) may live on the chain TIP — parkSweep writes the
    // tip. Both are consulted.
    const holder = byName.get(name) ?? byId.get(id);
    const claimed =
      // A terminal — any window's, any editor's, a hand-typed `tmux attach` —
      // is showing this session right now. Nothing in the store can outrank
      // that, and nothing in the store can see it either. @see AttachedNames.
      attached.has(name) ||
      boundHere.has(id) ||
      (holder !== undefined &&
        (boundHere.has(holder.sessionId) ||
          holder.graceUntilMs !== undefined ||
          holder.boundToLiveWindow ||
          // The pin IS the claim: "outlives my windows" is only true if the
          // reconcile keeps the promise the window-close grace-stamp made by
          // staying its hand (see ReconcileRecordFacts.pinned).
          holder.pinned === true ||
          now - holder.updatedAtMs < freshMs));
    if (claimed) continue;
    plan.killNames.push(name);
    if (holder !== undefined && !closing.has(holder.sessionId)) {
      plan.closeIds.push(holder.sessionId);
      closing.add(holder.sessionId);
    }
  }

  for (const r of records) {
    if (closing.has(r.sessionId)) continue; // the kill above already settles it
    const name = typeof r.tmux === 'string' && r.tmux !== '' ? r.tmux : undefined;
    if (name !== undefined && !live.has(name)) {
      if (r.graceUntilMs !== undefined) {
        // The countdown row was covering a process that is already gone — the
        // honest state is archived, now, not in nine more minutes.
        plan.closeIds.push(r.sessionId);
        closing.add(r.sessionId);
      } else {
        plan.clearTmuxIds.push(r.sessionId);
      }
      continue;
    }
    if (name === undefined && r.graceUntilMs !== undefined) {
      // A grace with no wrap under it is a claim over nothing — close it.
      plan.closeIds.push(r.sessionId);
      closing.add(r.sessionId);
    }
  }
  return plan;
}
