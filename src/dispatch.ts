// src/dispatch.ts — launch it when an account is actually worth launching on.
//
// Pure: it imports ./types, ./accounts and ./routing (all pure) — never
// vscode, never node, never a clock of its own. The host hands it the queue,
// the profiles, the usage snapshots and `now`, and gets back three lists and
// one timestamp. Everything here is testable with object literals and a fixed
// `now`, which is the whole reason it is not welded into the command layer.
//
// WHAT A QUEUE ENTRY IS: an intent to start a session, parked. Someone wanted
// a session — in this directory, maybe with this opening prompt, on this
// account or provider or wherever routing likes — at a moment when starting it
// was not worth it. The dispatcher's job is to notice the moment that changes
// and act once, in arrival order.
//
// THE GATE IS THE OPPOSITE OF THE ROUTER'S TIEBREAK, ON PURPOSE. The
// interactive router prefers an already-open five-hour window even at 97%,
// because the user is present and an open window is a sunk cost. The
// dispatcher exists precisely when nobody is waiting — so a window above
// DISPATCH_UTILIZATION_CEILING is a reason to sleep until its `resetsAt`, not
// to squeeze the last percent. Same numbers, different intent, different rule.
//
// A TIER NEVER WIDENS. An entry queued for a named account waits for THAT
// account: rerouting it is a billing error, exactly as routing.ts puts it. A
// provider entry waits inside its provider. Only `auto` shops around — and it
// ranks the candidates that pass the gate with `resolveRouting` itself, so
// "which account is best" keeps one definition in one file.
//
// SIGN-IN PROBLEMS DO NOT GATE. The window gate exists because a window heals
// by itself at a knowable time. `no-credentials` and `expired` do not heal by
// waiting, so holding an entry on them would strand it forever behind a
// problem only the user can fix; launching and letting the CLI show its login
// prompt is the honest outcome, and it is what the interactive router does
// with the same snapshot.

import { DEFAULT_PROVIDER, isProviderId, isRoutingChoice } from './types';
import type {
  AccountProfile,
  ProviderId,
  RoutingChoice,
  UsageSnapshot,
} from './types';
import { canHostSession } from './accounts';
import { resolveRouting } from './routing';

// ------------------------------------------------------------------- entry

/** Caps for the JSON boundary. The prompt ceiling is MAX_AGENT_PROMPT_CHARS's
 *  figure for MAX_AGENT_PROMPT_CHARS's reason: an opening turn is an argv. */
export const MAX_DISPATCH_PROMPT_CHARS = 4000;
export const MAX_DISPATCH_TITLE_CHARS = 120;

/** An intent to start a session, parked until an account is worth it. */
export interface DispatchEntry {
  /** Caller-minted uuid. The queue's key, and later the launch's session id —
   *  minted once so a crash between decide and launch cannot double-start. */
  id: string;
  /** Epoch ms when the entry was queued. FIFO is arrival order, and arrival
   *  order is a promise to the person who queued first. */
  createdAt: number;
  /** Where the session opens. Absent inherits the launcher's default, the
   *  same as every other launch. */
  cwd?: string;
  /** Opening turn, optional — "start looking at the failing tests" is the
   *  reason to queue a session rather than an alarm clock. */
  prompt?: string;
  /** Row title, optional; the launcher's default naming applies otherwise. */
  title?: string;
  /** Where this may run: the same RoutingChoice a project pin uses, because
   *  "which account" must not grow a second grammar. Absent = auto. */
  routing?: RoutingChoice;
  /** Epoch ms before which the entry holds regardless of usage — "after
   *  lunch" composed with "when a window is open", not instead of it. */
  notBefore?: number;
}

/** JSON boundary guard: the queue persists in state.json, which is
 *  hand-editable and survives older builds, so entries arrive as `unknown`.
 *  Same posture as isRoutingChoice, which it delegates the routing field to. */
export function isDispatchEntry(v: unknown): v is DispatchEntry {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  if (typeof e.id !== 'string' || e.id.length === 0) return false;
  if (typeof e.createdAt !== 'number' || !Number.isFinite(e.createdAt)) {
    return false;
  }
  if (e.cwd !== undefined && typeof e.cwd !== 'string') return false;
  if (
    e.prompt !== undefined &&
    (typeof e.prompt !== 'string' ||
      e.prompt.length > MAX_DISPATCH_PROMPT_CHARS)
  ) {
    return false;
  }
  if (
    e.title !== undefined &&
    (typeof e.title !== 'string' || e.title.length > MAX_DISPATCH_TITLE_CHARS)
  ) {
    return false;
  }
  if (e.routing !== undefined && !isRoutingChoice(e.routing)) return false;
  if (
    e.notBefore !== undefined &&
    (typeof e.notBefore !== 'number' || !Number.isFinite(e.notBefore))
  ) {
    return false;
  }
  return true;
}

// -------------------------------------------------------------------- gate

/** Windows above this hold their entries until reset. 90 rather than 100
 *  because a dispatched session is a WHOLE conversation, not one message:
 *  starting it into the last sliver guarantees it stalls mid-turn, which is
 *  the exact experience the queue exists to prevent. */
export const DISPATCH_UTILIZATION_CEILING = 90;

/** When entries remain queued and no reset time is known, re-decide this far
 *  out anyway. A queue that can never wake is worse than a redundant check —
 *  and a decision without a forced fetch costs nothing but the timer. */
export const DISPATCH_RECHECK_MS = 30 * 60 * 1000;

/** routing.ts keeps the same three lines private; the duplication is smaller
 *  than the export it would take to share them. */
function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * May the dispatcher launch on this account RIGHT NOW?
 *
 * Every `true` clause is a claim: no snapshot — no data is not evidence of
 * exhaustion, and Codex usage always reads unknown, so a Codex entry must not
 * wait forever for a number that will never come. No five-hour window — the
 * account is idle. `resetsAt` in the past — the window is over, whatever
 * percentage the cached snapshot still claims (routing.ts's liveWindow rule).
 * Unreadable utilization — treat like no data. Only a live window above the
 * ceiling holds.
 */
export function dispatchable(
  snapshot: UsageSnapshot | null | undefined,
  now: number,
): boolean {
  if (!snapshot) return true;
  const win = snapshot.fiveHour;
  if (!win) return true;
  const resetsAt = finite(win.resetsAt);
  if (resetsAt !== undefined && resetsAt <= now) return true;
  const util = finite(win.utilization);
  if (util === undefined) return true;
  return util <= DISPATCH_UTILIZATION_CEILING;
}

// ---------------------------------------------------------------- decision

export interface DispatchLaunch {
  entry: DispatchEntry;
  profile: AccountProfile;
  /** resolveRouting's own wording, so the queue and the picker never describe
   *  the same account two ways. */
  reason: string;
}

export interface DispatchHold {
  entry: DispatchEntry;
  reason: string;
  /** Epoch ms when this hold can change by itself, when that is knowable. */
  until?: number;
}

export interface DispatchDecision {
  /** In queue order. One per account per decision — see below. */
  launches: DispatchLaunch[];
  /** Still queued, each with the reason it holds. */
  waiting: DispatchHold[];
  /** Queued for something that no longer exists. Reported, never silently
   *  dropped: the entry names an account the user deleted, and only the user
   *  knows whether the answer is "requeue elsewhere" or "never mind". */
  stranded: DispatchHold[];
  /** Epoch ms to re-decide at, or null when the queue is empty of waiting
   *  entries. Never in the past; the host may still floor it further. */
  nextWakeAt: number | null;
}

export interface DispatchInput {
  entries: readonly DispatchEntry[];
  profiles: readonly AccountProfile[];
  /** Keyed by profile id, exactly as resolveRouting takes it. */
  usage: ReadonlyMap<string, UsageSnapshot | null>;
  now: number;
  /** The settings-level default routing, passed through to resolveRouting so
   *  an `auto` entry means what `auto` means everywhere else. */
  globalDefault?: RoutingChoice;
}

function providerOf(profile: AccountProfile): ProviderId {
  return isProviderId(profile.provider) ? profile.provider : DEFAULT_PROVIDER;
}

/** The accounts an entry's routing choice is ALLOWED to consider — live,
 *  launchable, and inside the tier. This is the "a tier never widens" rule
 *  made into a list; everything after it is gating and ranking. */
function candidatesFor(
  choice: RoutingChoice,
  profiles: readonly AccountProfile[],
): AccountProfile[] {
  const live = profiles.filter((p) => p && p.deleted !== true);
  if (choice.kind === 'account') {
    return live.filter((p) => p.id === choice.id && canHostSession(p));
  }
  if (choice.kind === 'provider') {
    return live.filter(
      (p) => providerOf(p) === choice.provider && canHostSession(p),
    );
  }
  return live.filter((p) => canHostSession(p));
}

/** What a hold on a full window says. Reset time is appended by the caller,
 *  which knows whether one exists. */
function fullNote(choice: RoutingChoice): string {
  if (choice.kind === 'account') return 'its account is above the ceiling';
  if (choice.kind === 'provider') {
    return `every ${choice.provider} account is above the ceiling`;
  }
  return 'every account is above the ceiling';
}

function strandedNote(choice: RoutingChoice): string {
  if (choice.kind === 'account') {
    return 'its account no longer exists or cannot host a session';
  }
  if (choice.kind === 'provider') {
    return `no ${choice.provider} account can host a session`;
  }
  return 'no account can host a session';
}

/**
 * The dispatcher's whole judgement, in arrival order.
 *
 * ONE LAUNCH PER ACCOUNT PER DECISION: launching five queued entries onto one
 * freshly-reset window at the same instant defeats the queue — the first
 * session opens the window and the other four inherit whatever is left of it.
 * The host re-decides after acting (and after any usage refresh), so the rest
 * follow exactly as fast as they deserve. An entry held only by this rule
 * carries no `until`: the next decision is already scheduled by the act of
 * launching.
 *
 * `nextWakeAt` is the earliest instant the answer can change by itself — the
 * soonest future `notBefore` or blocking `resetsAt` — and falls back to
 * DISPATCH_RECHECK_MS whenever entries wait on nothing datable, so the queue
 * never goes deaf. Stranded entries schedule nothing: an account coming back
 * is a user action, and the host re-decides on every account change anyway.
 */
export function decideDispatch(input: DispatchInput): DispatchDecision {
  const { profiles, usage, now } = input;
  const ordered = [...input.entries].sort(
    (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1),
  );
  const launches: DispatchLaunch[] = [];
  const waiting: DispatchHold[] = [];
  const stranded: DispatchHold[] = [];
  const usedAccounts = new Set<string>();
  const wakes: number[] = [];

  for (const entry of ordered) {
    const notBefore = finite(entry.notBefore);
    if (notBefore !== undefined && notBefore > now) {
      waiting.push({ entry, reason: 'held until its own time', until: notBefore });
      wakes.push(notBefore);
      continue;
    }
    const choice: RoutingChoice = entry.routing ?? { kind: 'auto' };
    const candidates = candidatesFor(choice, profiles);
    if (candidates.length === 0) {
      stranded.push({ entry, reason: strandedNote(choice) });
      continue;
    }
    const usable = candidates.filter(
      (p) => !usedAccounts.has(p.id) && dispatchable(usage.get(p.id), now),
    );
    if (usable.length === 0) {
      // Distinguish "the window holds it" (datable) from "this decision
      // already spent the account" (the next decision is imminent by
      // construction) — the until field is the difference.
      const gated = candidates.filter((p) => !usedAccounts.has(p.id));
      if (gated.length === 0) {
        waiting.push({ entry, reason: 'its account launches earlier in this round' });
        continue;
      }
      let soonest: number | undefined;
      for (const p of gated) {
        const at = finite(usage.get(p.id)?.fiveHour?.resetsAt);
        if (at !== undefined && at > now && (soonest === undefined || at < soonest)) {
          soonest = at;
        }
      }
      if (soonest !== undefined) wakes.push(soonest);
      waiting.push({ entry, reason: fullNote(choice), until: soonest });
      continue;
    }
    // Ranking among the gated survivors is resolveRouting's job, verbatim:
    // the tier in `choice` re-applies harmlessly to a pre-narrowed list, and
    // the reason string comes back in the picker's own words.
    const resolved = resolveRouting(
      choice,
      input.globalDefault,
      usable,
      usage,
      now,
    );
    if (resolved.profile === null) {
      // Cannot happen with a non-empty usable list, but a guess is not a
      // launch: treat it as a hold and let the recheck look again.
      waiting.push({ entry, reason: resolved.reason });
      continue;
    }
    usedAccounts.add(resolved.profile.id);
    launches.push({ entry, profile: resolved.profile, reason: resolved.reason });
  }

  let nextWakeAt: number | null = null;
  if (waiting.length > 0) {
    const soonest = wakes.length > 0 ? Math.min(...wakes) : now + DISPATCH_RECHECK_MS;
    nextWakeAt = Math.max(soonest, now);
  }
  return { launches, waiting, stranded, nextWakeAt };
}
