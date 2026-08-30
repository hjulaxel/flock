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
// ONE LAUNCH PER ACCOUNT PER DECISION is the pure rule; the follow-up is
// this file's. After a launch, the launched-on account's snapshot is stale in
// the optimistic direction (it still reads idle), so re-deciding immediately
// would stack the next entry onto the same window with the same stale
// number. The host instead re-decides POST_LAUNCH_MS later with a forced
// refresh: the new snapshot shows the window the launch actually opened, and
// the gate judges it honestly. "As fast as they deserve" means one refresh
// later, not one tick later.

import { log, logError } from './log';
import { decideDispatch } from './dispatch';
import type { DispatchLaunch } from './dispatch';
import type {
  AccountProfile,
  DispatchEntry,
  DispatchOutcome,
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

// --------------------------------------------------------------------- deps

/** Everything the clockwork touches, as functions — the wiring in
 *  extension.ts is the only file that knows where these live, and every test
 *  double is a handful of literals. */
export interface DispatchHostDeps {
  /** Entries not yet settled. The host filters nothing: pending means "mine
   *  to act on". */
  pending(): DispatchEntry[];
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
  /** Perform one launch — mint the record, open the terminal, pin the
   *  account. Resolves false when no terminal was bound, and the entry then
   *  STAYS QUEUED for the retry cadence. */
  launch(launchIt: DispatchLaunch): Promise<boolean>;
  now(): number;
  /** One user-visible line per launch. Optional: a wiring without it (and
   *  every unit double) is just quieter. */
  notify?(message: string): void;
}

// --------------------------------------------------------------------- host

export class DispatchHost {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private deciding = false;
  private pokedWhileDeciding = false;
  private disposed = false;

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
      const entries = this.deps.pending();
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
      // Sequential on purpose: each launch opens a terminal, and a burst of
      // simultaneous terminal creations is exactly the stampede FIFO promises
      // the user not to cause.
      for (const l of decision.launches) {
        let ok = false;
        try {
          ok = await this.deps.launch(l);
        } catch (err) {
          logError('dispatchHost.launch', err);
        }
        if (ok) {
          launched += 1;
          await this.deps.settle(l.entry.id, 'launched');
          this.deps.notify?.(
            `Flock: queued session "${l.entry.title ?? l.entry.id.slice(0, 8)}" ` +
              `launched on ${l.profile.label} — ${l.reason}`,
          );
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
      if (failed > 0) {
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
