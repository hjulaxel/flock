// src/dispatchHost.ts — the dispatcher's clockwork.
//
// Node-only: it imports ./types, ./log, ./dispatch and uses setTimeout —
// never vscode, so the whole schedule is testable with fake timers. The
// DECISIONS are dispatch.ts's and stay there; this file owns exactly three
// things: WHEN to ask (pokes, wakes), WHAT to do with the answer (launch,
// settle, notify), and the one impurity the pure module refused to hold —
// re-reading usage before trusting a wake.
//
// WHY WAKES FORCE-REFRESH. The whole point of waking at `resetsAt` is that
// the cached snapshot still says the window is full — it is the cache that
// held the entry. A wake that consulted the same cache would hold it forever.
// So a timer wake refreshes with `force: true` first (limits.ts treats force
// as "a person clicked Refresh", and a timer the user armed by queueing is
// exactly that), then decides. Pokes — the cheap signals: a queue edit, a
// snapshot that already changed — decide against the cache, because they were
// CAUSED by fresh data.
//
// ONE LAUNCH PER ENTRY ACROSS ALL WINDOWS is not something a decision can
// promise, because every window makes the same decision from the same shared
// queue at the same instant — both wake on one account's reset time and both
// see one pending entry. So the launch is fenced by a CLAIM in the store:
// write this window's id onto the record, CONFIRM THE WRITE LANDED, re-read
// it, and launch only if the claim that came back is our own
// (dispatch.dispatchClaim's `mine`). A window that lost writes nothing,
// launches nothing and settles nothing — settling would tombstone an entry
// whose real launch is still in flight. The claim expires, so a window that
// died mid-launch cannot park an entry forever.
//
// Both halves are load-bearing: the re-read reads MEMORY, so a claim that
// never reached disk reads back as ours in every window at once (see
// state.claimDispatch on the unreadable-file case). A claim only fences the
// windows that can see it.
//
// ONE LAUNCH PER ACCOUNT PER DECISION is the pure rule; the follow-up is
// this file's. After a launch, the launched-on account's snapshot is stale in
// the optimistic direction (it still reads idle), so re-deciding immediately
// would stack the next entry onto the same window with the same stale
// number. The host instead re-decides POST_LAUNCH_MS later with a forced
// refresh: the new snapshot shows the window the launch actually opened, and
// the gate judges it honestly. "As fast as they deserve" means one refresh
// later, not one tick later.

import { log, logError } from './log';
import { decideDispatch, dispatchClaim } from './dispatch';
import type { DispatchLaunch } from './dispatch';
import type {
  AccountProfile,
  DispatchEntry,
  DispatchOutcome,
  DispatchRecord,
  RoutingChoice,
  UsageSnapshot,
} from './types';

// ---------------------------------------------------------------- constants

/** Floor under every armed timer: a wake in the past is a wake right now,
 *  but "right now" still yields the event loop and coalesces bursts. */
export const DISPATCH_MIN_WAKE_MS = 5_000;
/** Pokes arrive in bursts (every view repaint re-reads usage); one decision
 *  per burst is plenty. */
export const DISPATCH_POKE_DEBOUNCE_MS = 250;
/** The follow-up after a launch, when more entries wait — long enough for
 *  the opened window to show up in a forced refresh. */
export const DISPATCH_POST_LAUNCH_MS = 60_000;
/** A launch that failed to bind retries on this cadence. The failure modes
 *  (binary missing, tmux hiccup) are things a retry can outlive; the entry
 *  stays queued rather than being settled as anything it is not. */
export const DISPATCH_RETRY_MS = 5 * 60_000;

/**
 * What one launch attempt did — the three answers the retry loop has to tell
 * apart.
 *
 *   launched  a terminal is bound. Settle the entry.
 *   failed    no binding, for a reason a retry can outlive (binary missing,
 *             tmux hiccup). The entry stays queued and DISPATCH_RETRY_MS
 *             applies — see DispatchOutcome for why there is no 'failed'
 *             settlement.
 *   fenced    this window CANNOT host the entry's directory at all (folder
 *             mode's scope fence). Retrying here every five minutes forever
 *             is a lie the queue tells itself: nothing about this window will
 *             change. Reported as stranded instead.
 */
export type DispatchLaunchOutcome = 'launched' | 'failed' | 'fenced';

// --------------------------------------------------------------------- deps

/** Everything the clockwork touches, as functions — the wiring in
 *  extension.ts is the only file that knows where these live, and every test
 *  double is a handful of literals. */
export interface DispatchHostDeps {
  /** Entries not yet settled, claims included. The host filters nothing:
   *  pending means "a window's to act on" — WHICH window is the claim's
   *  business, and this is also the read half of the claim protocol, so it
   *  must reflect the store after `claim` resolved. */
  pending(): DispatchRecord[];
  /** This window's id — the identity a claim is written under, and the one it
   *  is compared against. Empty means this build has no window identity, and
   *  dispatchClaim then never says `mine`: the queue holds rather than races. */
  windowId: string;
  /** Write this window's claim onto one entry (state.claimDispatch).
   *
   *  Resolves true only when the claim REACHED THE STORE. It refuses silently
   *  when another window's live claim stands — the host finds that out by
   *  re-reading `pending`, not from this promise — but false also covers the
   *  case the re-read cannot see at all: a claim that was applied to this
   *  window's memory and never written, because state.json was unreadable.
   *  Then every window's re-read says `mine` at once, so the write receipt is
   *  the only thing that tells them apart. See state.claimDispatch. */
  claim(id: string): Promise<boolean>;
  /** Drop this window's claim (state.releaseDispatchClaim) — called when the
   *  launch started nothing, so another window may try immediately rather
   *  than waiting out the claim TTL. Never touches another window's claim. */
  release(id: string): Promise<void>;
  /** Mark one entry launched or cancelled (state.settleDispatch). */
  settle(id: string, done: DispatchOutcome): Promise<void>;
  profiles(): AccountProfile[];
  usageMap(): ReadonlyMap<string, UsageSnapshot | null>;
  /** limits.ts via the accounts wiring. Never throws (that module's own
   *  contract). */
  refreshUsage(
    profiles: readonly AccountProfile[],
    force: boolean,
  ): Promise<void>;
  defaultRouting(): RoutingChoice | undefined;
  /** Could this window host the entry AT ALL — is its directory in this
   *  window's scope (folder mode's fence)?
   *
   *  Asked BEFORE the decision, and that placement is the point. Asked only
   *  inside the launch, a fenced entry still spent the account's one launch
   *  per round and still took the store-wide claim — so the entry BEHIND it
   *  never ran, in any round, and the only thing said about it was a notice
   *  naming the fenced entry. A queued prompt that never runs with nobody
   *  told is the failure the stranded notice exists to prevent.
   *
   *  Optional: a wiring (or a double) without it fences nothing here, and the
   *  `'fenced'` launch outcome is still the backstop — which is also what
   *  covers a scope that changed mid-pass. Two answers to one question, on
   *  purpose: this one is so the queue keeps moving, that one is so nothing
   *  launches out of scope. */
  canHost?(entry: DispatchEntry): boolean;
  /** Perform one launch — mint the record, open the terminal, pin the
   *  account. 'failed' leaves the entry QUEUED for the retry cadence;
   *  'fenced' says no retry in this window can ever succeed. */
  launch(launchIt: DispatchLaunch): Promise<DispatchLaunchOutcome>;
  now(): number;
  /** One user-visible line per launch. Optional: a wiring without it (and
   *  every unit double) is just quieter. */
  notify?(message: string): void;
}

// ------------------------------------------------------------------ helpers

/** What to call an entry in a line the user reads.
 *
 *  Title, then PROMPT, then the short id — the same ladder dispatchQueueFlow's
 *  own picker label uses, and for the same reason: nothing in the queue verb
 *  ever sets `title`, so a name that stopped at the title would in practice
 *  always be eight hex characters and would identify the entry to nobody. */
function entryName(entry: DispatchEntry): string {
  const raw = entry.title ?? entry.prompt ?? entry.id.slice(0, 8);
  // A prompt may be 4000 characters (MAX_DISPATCH_PROMPT_CHARS); a toast may
  // not. The picker can afford the whole thing in a list row, a one-line
  // notification cannot, so a long one is cut here rather than at the caller.
  const one = raw.replace(/\s+/g, ' ').trim();
  return one.length <= NAME_CHARS ? one : `${one.slice(0, NAME_CHARS - 1)}…`;
}

/** How much of a name a one-line notification can carry. */
const NAME_CHARS = 60;

/** Why a fenced entry cannot run HERE, naming the directory that would let a
 *  window take it. `entry.cwd` is set on everything the queue verb enqueues;
 *  the fallback is for a seed file that arrived without one. */
function fencedReason(entry: DispatchEntry): string {
  return (
    `${entry.cwd ?? 'its folder'} is not open here. Open that folder in a ` +
    'window of its own and the queue there will start it'
  );
}

// --------------------------------------------------------------------- host

export class DispatchHost {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private deciding = false;
  private pokedWhileDeciding = false;
  private disposed = false;
  /** Entries this window has already told the user about — see strand(). */
  private readonly stranded = new Set<string>();

  constructor(private readonly deps: DispatchHostDeps) {}

  /** Something that can change the answer happened — a queue edit, a usage
   *  snapshot landing. Debounced, then decided against the cache (see the
   *  header for why pokes never force). */
  poke(): void {
    if (this.disposed) return;
    if (this.debounce !== null) return; // a burst is one decision
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.decide(false);
    }, DISPATCH_POKE_DEBOUNCE_MS);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.timer = null;
    this.debounce = null;
  }

  private armTimer(atEpochMs: number): void {
    if (this.disposed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    const delay = Math.max(atEpochMs - this.deps.now(), DISPATCH_MIN_WAKE_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.decide(true);
    }, delay);
  }

  /**
   * WRITE, THEN READ, AND BOTH HAVE TO AGREE. `claim` asks the store to stamp
   * this window's id onto the entry; the store refuses when another window's
   * live claim already stands, and says so by not writing rather than by
   * throwing. So one half of the answer is in the re-read: whatever the merge
   * settled on is what came back, and only `mine` may launch.
   *
   * The re-read is also how a LOSING window discovers it lost — its own
   * memory now holds the winner's record — which is why this cannot be
   * simplified into "claim resolved, therefore it is mine".
   *
   * The other half is the WRITE RECEIPT, and it is not redundant: the re-read
   * reads memory, so a claim that never reached disk (state.json unreadable)
   * still comes back `mine` — in every window at once, because the file is
   * unreadable for all of them. A claim nobody else can see fences nobody, so
   * an unpersisted claim launches nothing and the entry simply stays queued.
   *
   * An entry that has vanished from `pending` between the decision and here
   * was settled under us (the winner finished, or the user cancelled it):
   * false, and nothing else to do.
   */
  private async claim(id: string): Promise<boolean> {
    const wrote = await this.deps.claim(id);
    if (!wrote) {
      // Either the store refused the claim (another window's stands) or it
      // could not write it. Neither authorises a launch, and both leave the
      // entry queued, so one line covers them.
      log('dispatch: no stored claim on', id, '— holding it');
      return false;
    }
    const rec = this.deps.pending().find((e) => e.id === id);
    if (rec === undefined) {
      log('dispatch: entry settled while claiming it', id);
      return false;
    }
    const verdict = dispatchClaim(rec, this.deps.windowId, this.deps.now());
    if (verdict === 'mine') return true;
    log('dispatch: not launching', id, '— the claim is', verdict);
    return false;
  }

  /** Hand the claim back after a launch that did not start anything. Never
   *  throws: a claim we cannot release expires on its own, which is the whole
   *  reason it has a TTL. */
  private async release(id: string): Promise<void> {
    try {
      await this.deps.release(id);
    } catch (err) {
      logError('dispatchHost.release', err);
    }
  }

  /**
   * Say that an entry is going nowhere, and say what would move it.
   *
   * Logged every time, notified ONCE per entry per window. The stranding the
   * pure decision reports (an account that no longer exists) is logged only,
   * because the queue picker's own row carries that story; this one it cannot
   * — whether an entry is fenced out depends on which window is asking, and
   * "queued forever, invisibly" is exactly the failure the notice prevents.
   * Once, because the host re-decides on every usage tick and a toast per tick
   * would make the queue the loudest thing in the editor.
   */
  private strand(entry: DispatchEntry, reason: string): void {
    log('dispatch: stranded', entry.id, '—', reason);
    if (this.stranded.has(entry.id)) return;
    this.stranded.add(entry.id);
    this.deps.notify?.(
      `Flock: queued session "${entryName(entry)}" cannot start in this ` +
        `window — ${reason}.`,
    );
  }

  /** One pass: (maybe) refresh, decide, act, re-arm. Reentrancy is a queue of
   *  one — a poke that lands mid-decision runs one more pass at the end
   *  rather than a parallel one, because two passes reading the same pending
   *  list would launch the same entry twice. */
  private async decide(forceRefresh: boolean): Promise<void> {
    if (this.disposed) return;
    if (this.deciding) {
      this.pokedWhileDeciding = true;
      return;
    }
    this.deciding = true;
    try {
      const profiles = this.deps.profiles();
      if (forceRefresh) {
        // All live profiles rather than just the blocking ones: the decision
        // below may route an auto entry anywhere, and a half-refreshed map
        // would rank fresh accounts against stale ones.
        await this.deps.refreshUsage(profiles, true);
      }
      // THE FENCE FIRST, so an entry this window can never run does not
      // stand in front of the one behind it. A fenced entry is stranded and
      // never reaches the decision, so it spends no account, takes no claim,
      // and causes no store writes on every usage poke for as long as this
      // window is open. See `canHost`.
      const entries: DispatchRecord[] = [];
      for (const record of this.deps.pending()) {
        if (this.deps.canHost !== undefined && !this.deps.canHost(record)) {
          this.strand(record, fencedReason(record));
          continue;
        }
        entries.push(record);
      }
      if (entries.length === 0) {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        return;
      }
      const decision = decideDispatch({
        entries,
        profiles,
        usage: this.deps.usageMap(),
        now: this.deps.now(),
        ...(this.deps.defaultRouting() !== undefined
          ? { globalDefault: this.deps.defaultRouting() }
          : {}),
      });
      for (const held of decision.stranded) {
        // Logged, not notified: a toast per decision would nag, and the queue
        // picker shows the same reason on the row where it can be acted on.
        log('dispatch: stranded', held.entry.id, '—', held.reason);
      }
      let launched = 0;
      let failed = 0;
      let contested = 0;
      // Sequential on purpose: each launch opens a terminal, and a burst of
      // simultaneous terminal creations is exactly the stampede FIFO promises
      // the user not to cause.
      for (const l of decision.launches) {
        if (!(await this.claim(l.entry.id))) {
          contested += 1;
          continue;
        }
        let outcome: DispatchLaunchOutcome = 'failed';
        try {
          outcome = await this.deps.launch(l);
        } catch (err) {
          logError('dispatchHost.launch', err);
        }
        if (outcome === 'launched') {
          launched += 1;
          await this.deps.settle(l.entry.id, 'launched');
          this.deps.notify?.(
            `Flock: queued session "${entryName(l.entry)}" ` +
              `launched on ${l.profile.label} — ${l.reason}`,
          );
          continue;
        }
        // Nothing was started, so the claim must go back: a claim covers a
        // launch IN FLIGHT and nothing else. Holding it would be worse than
        // not claiming at all for the fenced case — this window re-claims on
        // every pass, so the one window that CAN run the entry would find it
        // taken forever, which is starvation dressed as safety.
        await this.release(l.entry.id);
        if (outcome === 'fenced') {
          // Not a failure: no retry clause below fires for it, because no
          // number of retries in THIS window can change the answer.
          this.strand(l.entry, fencedReason(l.entry));
        } else {
          failed += 1;
          log('dispatch: launch did not bind, entry stays queued', l.entry.id);
        }
      }
      // Re-arm. Every clause names the event it waits for; the smallest wins.
      const now = this.deps.now();
      let wakeAt = decision.nextWakeAt ?? Number.POSITIVE_INFINITY;
      if (launched > 0 && decision.waiting.length > 0) {
        wakeAt = Math.min(wakeAt, now + DISPATCH_POST_LAUNCH_MS);
      }
      if (failed > 0 || contested > 0) {
        // A lost claim gets the retry cadence too. Usually the winner settles
        // the entry and the retry finds nothing to do — but when the winner
        // turns out to be a window that cannot run it (the fence), this timer
        // is what makes THIS window look again instead of going deaf until
        // the next usage tick.
        wakeAt = Math.min(wakeAt, now + DISPATCH_RETRY_MS);
      }
      if (Number.isFinite(wakeAt)) this.armTimer(wakeAt);
      else if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    } catch (err) {
      logError('dispatchHost.decide', err);
    } finally {
      this.deciding = false;
      if (this.pokedWhileDeciding) {
        this.pokedWhileDeciding = false;
        this.poke();
      }
    }
  }
}
