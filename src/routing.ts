// src/routing.ts — which account a new session lands on.
//
// Pure: it imports ./types and ./accounts (also pure) — never vscode, never
// node, never the network. That is the whole point of the split: the limits
// module does the fetching and hands this file plain numbers, so every rule
// below can be tested with a Map literal and a fixed `now`, and the answers do
// not change with the weather.
//
// Three tiers, resolved in one pass:
//
//   account   the user named one. Nothing is clever; the named account wins,
//             because "this repo bills to the client" is a statement about
//             money and second-guessing it is a billing error.
//   provider  the user named a provider. Auto-pick among THAT provider's
//             accounts — the answer for "either of my two Claude plans, but
//             definitely not Codex".
//   auto      auto-pick across everything.
//
// The auto-pick, in priority order, and every clause of it is a claim about
// how these subscriptions actually behave:
//
//   1. Prefer an already-open five-hour window. The five-hour limit starts
//      when you send the first message and expires whether or not you use it,
//      so an open window is a sunk cost: spending it is free, and starting a
//      SECOND window on another account converts one paid-for window into two
//      half-used ones. This is the rule that matters; the rest are tiebreaks.
//   2. Then soonest weekly reset. Use it or lose it — the account whose weekly
//      allowance is about to roll over is the one with the least to lose.
//   3. A full five-hour window ranks last, and an account we know nothing
//      about ranks between the two: no data is not evidence of exhaustion, and
//      picking an unknown over a known-full account is right, while picking it
//      over a known-open one is not.
//   4. Then the user's own order. Dragging your preferred account to the top
//      has to mean something, and this is where it means it.
//
// A window whose `resetsAt` has already passed is treated as CLOSED rather
// than as whatever percentage it last reported: usage snapshots are cached and
// a stale 98% from a window that rolled over an hour ago would park every new
// session on the wrong account until the next fetch landed. This is the one
// thing `now` is for.
//
// Every tier picks from the same candidate set: the live accounts a session can
// actually be launched on (`accounts.canHostSession`). The launcher execs one
// binary, the Claude CLI, so routing a launch to a Codex account would run
// `claude` under `CODEX_HOME`, land on the machine's DEFAULT Claude login, and
// pin the conversation for life to an account it was never on — while the row,
// the pin and the status line all said otherwise. A tier that names such an
// account degrades and says why, exactly like a tier naming a deleted one: the
// account is real, it is just not a place a session can start.

import { PROVIDERS } from './types';
import type {
  AccountProfile,
  ProviderId,
  RoutingChoice,
  UsageSnapshot,
  UsageWindow,
} from './types';
import { canHostSession, sortProfiles } from './accounts';

/** What the resolver hands back: the account to launch on, and a short line
 *  saying why — shown next to the picker, so the user can see the rule work
 *  rather than having to trust it. `null` means there is no account at all to
 *  pick, and the caller launches with no profile env — exactly what every
 *  launch did before accounts existed. */
export interface RoutingResolution {
  profile: AccountProfile | null;
  reason: string;
}

/**
 * How an account's five-hour window ranks.
 *
 *   open       a window is running and has room: the sunk cost we want spent.
 *   idle       no window running, or nothing known — including "we could not
 *              read this account's usage at all".
 *   exhausted  the window is reported full.
 */
export type UsageRank = 'open' | 'idle' | 'exhausted';

const RANK_ORDER: Record<UsageRank, number> = {
  open: 0,
  idle: 1,
  exhausted: 2,
};

/** Short weekday names, indexed by `Date.getDay()`. LOCAL weekday, not UTC:
 *  the string is read by a person who is looking at their own calendar. */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** The weekday a reset falls on, as the reason string spells it. Exported so a
 *  test can build its expectation from the same function instead of hardcoding
 *  a day that depends on the machine's timezone. */
export function weekdayLabel(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return '';
  const day = new Date(epochMs).getDay();
  return WEEKDAYS[day] ?? '';
}

function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** A window that is running RIGHT NOW, or undefined. A window whose reset time
 *  has passed is over, whatever percentage the cached snapshot still claims. */
function liveWindow(
  win: UsageWindow | undefined,
  now: number,
): UsageWindow | undefined {
  if (!win) return undefined;
  const resetsAt = finite(win.resetsAt);
  if (resetsAt !== undefined && resetsAt <= now) return undefined;
  return win;
}

/** Where one account's five-hour window sits. See UsageRank. */
export function rankUsage(
  snapshot: UsageSnapshot | null | undefined,
  now: number,
): UsageRank {
  if (!snapshot) return 'idle';
  const win = liveWindow(snapshot.fiveHour, now);
  if (!win) return 'idle';
  const util = finite(win.utilization);
  if (util === undefined) return 'idle';
  if (util >= 100) return 'exhausted';
  if (util > 0) return 'open';
  return 'idle'; // a window at 0% has not been opened — nothing sunk yet
}

/**
 * The soonest WEEKLY reset still ahead of us, across both weekly windows.
 *
 * Both, because a plan can carry a general weekly cap and a separate Opus one,
 * and the earlier of the two is the deadline that actually applies to whatever
 * you are about to run. A reset already in the past is ignored rather than
 * treated as imminent — it is stale data, not an emergency.
 */
function weeklyResetOf(
  snapshot: UsageSnapshot | null | undefined,
  now: number,
): number {
  let soonest = Number.POSITIVE_INFINITY;
  for (const win of [snapshot?.sevenDay, snapshot?.sevenDayOpus]) {
    const at = finite(win?.resetsAt);
    if (at === undefined || at <= now) continue;
    if (at < soonest) soonest = at;
  }
  return soonest;
}

/** Why the picked account looks the way it does, in the fewest words that are
 *  still true. Never mentions extraEnv, a config path, or anything else that
 *  could carry a credential. */
function usageReason(
  snapshot: UsageSnapshot | null | undefined,
  rank: UsageRank,
  now: number,
): string {
  const parts: string[] = [];
  if (rank === 'open') parts.push('open 5h window');
  else if (rank === 'exhausted') parts.push('5h window is full');
  else if (!snapshot) parts.push('no usage data');
  else if (snapshot.error === 'no-credentials') parts.push('not signed in');
  else if (snapshot.error === 'expired') parts.push('sign-in expired');
  else if (snapshot.error) parts.push('usage unavailable');
  else parts.push('fresh 5h window');

  const weekly = weeklyResetOf(snapshot, now);
  if (Number.isFinite(weekly)) {
    const day = weekdayLabel(weekly);
    if (day !== '') parts.push(`weekly resets ${day}`);
  }
  if (snapshot?.stale === true) parts.push('cached');
  return parts.join(' · ');
}

interface Scored {
  profile: AccountProfile;
  rank: UsageRank;
  weekly: number;
  /** Position in the canonical arrangement — the final tiebreak, and the
   *  reason this module and the accounts view sort through one function. */
  index: number;
  snapshot: UsageSnapshot | null;
}

/** Live accounts in the order the user arranged them. Tombstones never reach
 *  a picker: a deleted account is gone, and the merge artefact that proves it
 *  is not a thing you can launch on. */
function liveProfiles(profiles: readonly AccountProfile[]): AccountProfile[] {
  return sortProfiles(
    (profiles ?? []).filter(
      (p): p is AccountProfile => !!p && p.deleted !== true && !!p.id,
    ),
  );
}

/** The auto-pick, over whatever candidate set the tier handed it. */
function pickBest(
  candidates: readonly AccountProfile[],
  ordered: readonly AccountProfile[],
  usage: ReadonlyMap<string, UsageSnapshot | null>,
  now: number,
): Scored | null {
  let best: Scored | null = null;
  for (const profile of candidates) {
    const snapshot = usage?.get(profile.id) ?? null;
    const scored: Scored = {
      profile,
      rank: rankUsage(snapshot, now),
      weekly: weeklyResetOf(snapshot, now),
      index: ordered.indexOf(profile),
      snapshot,
    };
    if (best === null || better(scored, best)) best = scored;
  }
  return best;
}

/** The whole priority list, in one place, in the order the header states. */
function better(a: Scored, b: Scored): boolean {
  const ra = RANK_ORDER[a.rank];
  const rb = RANK_ORDER[b.rank];
  if (ra !== rb) return ra < rb;
  if (a.weekly !== b.weekly) return a.weekly < b.weekly;
  return a.index < b.index;
}

function sameChoice(
  a: RoutingChoice | undefined,
  b: RoutingChoice | undefined,
): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'account' && b.kind === 'account') return a.id === b.id;
  if (a.kind === 'provider' && b.kind === 'provider') {
    return a.provider === b.provider;
  }
  return true; // both 'auto'
}

function providerLabel(provider: ProviderId): string {
  return PROVIDERS[provider]?.label ?? provider;
}

/** The note a tier leaves behind when the account (or provider) it named is
 *  real but cannot host a session. Names the PROVIDER rather than the account,
 *  because the limitation is the provider's and saying "Work is gone" about an
 *  account sitting right there in the list would be a lie. */
function cannotHostNote(provider: ProviderId): string {
  return `${providerLabel(provider)} accounts cannot run sessions`;
}

const AUTO: RoutingChoice = { kind: 'auto' };

/**
 * Which account a NEW session launches on.
 *
 * `choice` is the project's override, `globalDefault` the machine-wide setting;
 * either may be undefined. The cascade is: the project's choice, then the
 * global default, then a plain auto-pick over every account — and it is a
 * CASCADE rather than a single lookup because each tier can fail for reasons
 * that are nobody's fault. An account named by a project can be deleted from
 * another window; a provider tier can name a provider whose last account was
 * removed. Those must degrade to the next-best answer and SAY so, because the
 * alternative is a launch that quietly does not happen.
 *
 * Never consulted for an existing conversation: a session is pinned at launch
 * (EditorialRecord.profileId) and resumes on that account for life. See
 * `pinnedProfile`.
 */
export function resolveRouting(
  choice: RoutingChoice | undefined,
  globalDefault: RoutingChoice | undefined,
  profiles: readonly AccountProfile[],
  usage: ReadonlyMap<string, UsageSnapshot | null>,
  now: number,
): RoutingResolution {
  const live = liveProfiles(profiles);
  if (live.length === 0) {
    return { profile: null, reason: 'no accounts configured' };
  }
  // The candidate set for EVERY tier, including auto: an account this
  // extension cannot start a session on is not a routing answer. Null here
  // (rather than the first row) sends the launch to the machine's default
  // login with no pin at all — the one place it is guaranteed to work.
  const ordered = live.filter(canHostSession);
  if (ordered.length === 0) {
    return { profile: null, reason: 'no account can run a session' };
  }

  const attempts: RoutingChoice[] = [];
  if (choice) attempts.push(choice);
  if (globalDefault && !sameChoice(globalDefault, choice)) {
    attempts.push(globalDefault);
  }
  if (!attempts.some((a) => sameChoice(a, AUTO))) attempts.push(AUTO);

  const notes: string[] = [];
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    const explicit = i === 0 && choice !== undefined;

    if (attempt.kind === 'account') {
      const found = ordered.find((p) => p.id === attempt.id);
      if (found) {
        const label = explicit ? 'set for this project' : 'the default account';
        return { profile: found, reason: join(notes, label) };
      }
      // Present but unlaunchable is a different failure from absent, and the
      // user can only act on the one they are told about.
      const blocked = live.find((p) => p.id === attempt.id);
      notes.push(
        blocked
          ? cannotHostNote(blocked.provider)
          : explicit
            ? 'the account set here is gone'
            : 'the default account is gone',
      );
      continue;
    }

    let candidates: readonly AccountProfile[] = ordered;
    if (attempt.kind === 'provider') {
      candidates = ordered.filter((p) => p.provider === attempt.provider);
      if (candidates.length === 0) {
        const exists = live.some((p) => p.provider === attempt.provider);
        notes.push(
          exists
            ? cannotHostNote(attempt.provider)
            : `no ${providerLabel(attempt.provider)} account`,
        );
        continue;
      }
    }
    const best = pickBest(candidates, ordered, usage, now);
    if (!best) continue; // unreachable with a non-empty candidate list
    return {
      profile: best.profile,
      reason: join(notes, usageReason(best.snapshot, best.rank, now)),
    };
  }

  // Every tier failed while accounts exist: only possible if the roster is
  // somehow unusable. Fall back to the first account in the user's own order,
  // which is the least surprising thing a list can hand back.
  return { profile: ordered[0], reason: join(notes, 'first in your list') };
}

function join(notes: readonly string[], tail: string): string {
  return [...notes, tail].filter((s) => s !== '').join(' · ');
}

/**
 * The account a session is PINNED to, or null.
 *
 * Deliberately does not fall back to anything: a pin that names an account
 * which no longer exists must resolve to "no account", so the resume launches
 * with an empty env and lands on the default login — the same place the
 * session's transcript would have been written if it had never had a profile.
 * Silently re-routing it to some other account would run a conversation under
 * a subscription it was never on, which is exactly what pinning exists to
 * prevent.
 */
export function pinnedProfile(
  profileId: string | undefined,
  profiles: readonly AccountProfile[],
): AccountProfile | null {
  if (typeof profileId !== 'string' || profileId === '') return null;
  for (const p of profiles ?? []) {
    if (p && p.id === profileId && p.deleted !== true) return p;
  }
  return null;
}

/**
 * The pinned account a LAUNCH may use: `pinnedProfile`, minus the accounts no
 * session can run on.
 *
 * A separate function rather than a rule inside `pinnedProfile` because the two
 * questions differ: "which account does this conversation claim" (the pin, what
 * the view and `describeRouting` render — an unlaunchable answer is still the
 * true one) versus "which environment may this launch carry" (this). A pin left
 * behind by a build that could route to a Codex account resolves to null here,
 * which lands the resume on the default login — where that conversation's
 * transcript actually is, since `claude` ignored `CODEX_HOME` all along.
 */
export function pinnedLaunchProfile(
  profileId: string | undefined,
  profiles: readonly AccountProfile[],
): AccountProfile | null {
  const found = pinnedProfile(profileId, profiles);
  return found !== null && canHostSession(found) ? found : null;
}

/**
 * A routing choice as a person reads it — one wording, shared by the picker,
 * the project dialog and the status line, so the same setting never goes by
 * two names on two surfaces.
 */
export function describeRouting(
  choice: RoutingChoice | undefined,
  profiles: readonly AccountProfile[],
): string {
  if (!choice || choice.kind === 'auto') return 'Auto';
  if (choice.kind === 'provider') {
    return `Any ${providerLabel(choice.provider)} account`;
  }
  const found = pinnedProfile(choice.id, profiles);
  return found ? found.label : `Missing account (${choice.id})`;
}
