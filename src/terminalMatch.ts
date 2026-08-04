// src/terminalMatch.ts — which OPEN integrated terminal is running a roster
// session Flock never launched.
//
// Imports vscode, ./types, ./log and ./lineage (for its `ps` primitive, borrowed
// rather than copied so the two modules cannot disagree about what a parent pid
// is). The matching itself — every rule that decides yes, no, or "not sure
// enough" — is pure and exported separately, because that decision is the whole
// module and it has to be testable without a workbench.
//
// THE PROBLEM THIS FILE EXISTS TO FIX. `claude` typed into the bottom panel
// shows up in the tree like anything else: the roster is machine-wide. Clicking
// its row used to walk every tier Flock has (bound terminal here, another Flock
// window, a parked wrap, an unowned background job), find nothing, and offer to
// fork a copy — of a conversation sitting in a tab three inches below the
// sidebar. Revealing that tab is the honest answer, and it is the one thing this
// module does.
//
// WHY THE PROCESS TREE, AND NOTHING ELSE. Three signals were available and two
// of them are traps:
//
//   * Tab titles. Excluded, and this is a re-litigated decision (see the
//     workspaces note about `captureTabs`): claude rewrites its terminal title
//     continuously while it runs, so a name match breaks silently the moment a
//     session starts working, which is exactly when you go looking for it.
//   * cwd. Excluded as EVIDENCE, in both directions. A terminal's
//     `creationOptions.cwd` is where it was opened, not where the shell is now,
//     and a shell that has `cd`'d is the normal case rather than the exception.
//     So a cwd that matches proves nothing (two terminals in one repository are
//     ordinary), and a cwd that differs disproves nothing. Using it as a veto
//     would decline correct matches; using it as a tiebreak would break ties the
//     wrong way with confidence. It is not consulted.
//   * The process tree. Exact. `Terminal.processId` is the terminal's own
//     process — the SHELL, for a hand-run session — and the session's roster row
//     carries claude's pid. claude is a descendant of that shell, so walking
//     `ppid` up from the roster pid and looking for a terminal's pid in the chain
//     answers the question with no guessing at all.
//
// READ-ONLY, AND IT DECLINES WHEN IT IS NOT CERTAIN. The only thing the caller
// may do with a match is `Terminal.show()`. Nothing is signalled, nothing is
// typed, no transcript is touched. And the match declines — returns nothing —
// whenever the evidence is ambiguous, because the failure mode on the other side
// of this is two claude processes writing one transcript. Three ambiguities are
// refused explicitly:
//
//   1. Two Terminal objects reporting the SAME process id. The API permits it
//      (a split, a host quirk); we cannot tell which one to show, so neither.
//   2. A session whose chain reaches TWO terminal pids — a terminal running
//      inside another terminal. Nothing says which layer the user means.
//   3. One terminal pid reached by TWO live sessions. This is the real one, and
//      it is common: `/fork` in a panel terminal leaves two claude processes
//      under one shell, and both register. Revealing that tab for either row
//      would be showing a tab where only one of the two conversations is.
//
// Every refusal falls back to what the click did before this module existed.

import * as vscode from 'vscode';

import { log, logError } from './log';
import { psPpidCommand } from './lineage';
import { shortId } from './types';
import type { DisposableLike, RosterEntry } from './types';

/** How far up the process tree a session's claude may sit from its terminal.
 *  Generous, because the shapes in the wild vary: `claude` straight in zsh is
 *  one hop, a login shell wrapper or `npx` is two or three, and a `tmux` a user
 *  drove themselves puts its own server between them. Bounded because each hop
 *  is a `ps`, and this runs on a click. */
const MAX_HOPS = 8;

/** Ancestor chains are cached for this long. Short, because a pid's parent CAN
 *  change — when a parent dies its children reparent to init — and a stale chain
 *  would point at a terminal that is no longer above it. Long enough that the
 *  fan-out for one click is walked once. */
const CHAIN_TTL_MS = 5_000;

/** A session and the process chain above it, tip first: [claude, its parent, …]. */
export interface ChainedSession {
  sessionId: string;
  /** `[pid, ppid, ppid², …]`, as `ancestorChain` produces it. */
  chain: readonly number[];
}

/**
 * Pure. Which terminal process each session is running under, keeping only the
 * matches nothing about the evidence makes ambiguous.
 *
 * `terminalPids` is every open terminal's process id, duplicates INCLUDED —
 * they carry information (see refusal 1 in the header) and filtering them
 * upstream would hide it.
 *
 * `sessions` must be every LIVE session the caller knows about, not only the one
 * it is asking about: refusal 3 is a statement about two sessions sharing a
 * terminal, and a matcher shown one of them cannot make it.
 */
export function matchSessionsToTerminals(
  sessions: readonly ChainedSession[],
  terminalPids: readonly number[],
): Map<string, number> {
  const seen = new Map<number, number>();
  for (const pid of terminalPids ?? []) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    seen.set(pid, (seen.get(pid) ?? 0) + 1);
  }
  // Refusal 1: a process two Terminal objects both claim identifies no tab.
  const unique = new Set<number>();
  for (const [pid, count] of seen) if (count === 1) unique.add(pid);
  if (unique.size === 0) return new Map();

  const byTerminal = new Map<number, string[]>();
  const candidates = new Map<string, number>();
  for (const session of sessions ?? []) {
    if (!session || typeof session.sessionId !== 'string') continue;
    const hits: number[] = [];
    for (const pid of session.chain ?? []) {
      if (unique.has(pid) && !hits.includes(pid)) hits.push(pid);
    }
    // Refusal 2: a terminal inside a terminal. Both are true ancestors and
    // nothing in the chain says which one the user means by "the terminal".
    if (hits.length !== 1) continue;
    const pid = hits[0] as number;
    candidates.set(session.sessionId, pid);
    const claimants = byTerminal.get(pid);
    if (claimants === undefined) byTerminal.set(pid, [session.sessionId]);
    else claimants.push(session.sessionId);
  }

  // Refusal 3: one tab, two conversations. Showing it for either would be
  // showing a tab that is only half about the row that was clicked.
  const out = new Map<string, number>();
  for (const [sessionId, pid] of candidates) {
    if ((byTerminal.get(pid)?.length ?? 0) !== 1) continue;
    out.set(sessionId, pid);
  }
  return out;
}

/**
 * The process chain above `pid`, tip first, cycle-safe and bounded.
 *
 * A walk that cannot proceed returns what it has: the pid alone is a perfectly
 * good chain, and it still matches the one case where the session's process IS
 * the terminal's (which is how Flock launches its own — claude as `shellPath`).
 *
 * `ppidOf` is injected so tests can hand over a process table instead of a
 * machine; production passes lineage's `psPpidCommand`, which short-circuits on
 * win32 and never rejects. Never throws.
 */
export async function ancestorChain(
  pid: number,
  ppidOf: (pid: number) => Promise<number | null>,
  maxHops: number = MAX_HOPS,
): Promise<number[]> {
  if (!Number.isInteger(pid) || pid <= 0) return [];
  const chain: number[] = [pid];
  const seen = new Set<number>([pid]);
  let current = pid;
  const hops =
    Number.isInteger(maxHops) && maxHops > 0 ? maxHops : MAX_HOPS;
  for (let i = 0; i < hops; i++) {
    let parent: number | null;
    try {
      parent = await ppidOf(current);
    } catch (err) {
      logError('terminalMatch.ppidOf', err);
      return chain;
    }
    // pid 1 is init: above it there is nothing a terminal could be.
    if (parent === null || !Number.isInteger(parent) || parent <= 1) return chain;
    if (seen.has(parent)) return chain; // a cycle ps should never report
    seen.add(parent);
    chain.push(parent);
    current = parent;
  }
  return chain;
}

/** What the matcher needs from the world. Every member is injectable so the
 *  class can be driven by a test with no workbench and no process table. */
export interface TerminalMatchDeps {
  /** `vscode.window.terminals`, or undefined on a host that has none. */
  terminals?(): readonly vscode.Terminal[] | undefined;
  /** A terminal's own process id — `Terminal.processId`, already awaited and
   *  bounded by the caller. Undefined for a pty that never launched. */
  pidOf(terminal: vscode.Terminal): Promise<number | undefined>;
  /** The live roster, for the two-sessions-one-terminal refusal. */
  roster(): readonly RosterEntry[];
  /** Parent pid lookup; defaults to lineage's `ps` walk. */
  ppidOf?(pid: number): Promise<number | null>;
  now?(): number;
}

/** Upper bound on any wait for `Terminal.processId`. The API resolves it only
 *  once the main thread reports a pid and NEVER settles for a pty that failed to
 *  launch (see the long note on TerminalRegistry.pidOf), so an unbounded await
 *  here would wedge a click forever. */
const PID_TIMEOUT_MS = 2000;

function withTimeout<T>(
  value: Thenable<T>,
  ms: number,
): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    let done = false;
    const finish = (v: T | undefined): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => finish(undefined), ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    void Promise.resolve(value).then(finish, () => finish(undefined));
  });
}

/** `Terminal.processId`, bounded and never throwing — the default `pidOf`. */
export function terminalPid(
  terminal: vscode.Terminal,
): Promise<number | undefined> {
  return (async () => {
    try {
      const pid = await withTimeout(terminal.processId, PID_TIMEOUT_MS);
      return typeof pid === 'number' && pid > 0 ? pid : undefined;
    } catch (err) {
      logError('terminalMatch.processId', err);
      return undefined;
    }
  })();
}

/**
 * Finds — and only ever REVEALS — the open terminal running a session Flock did
 * not launch.
 *
 * Stateful only for the ancestor-chain cache, and every failure is a decline:
 * no host terminal API, no pid, a `ps` that will not run, an ambiguous match,
 * or a session with no roster pid all resolve to "nothing revealed", and the
 * caller carries on down the tiers it had before.
 */
export class TerminalMatcher implements DisposableLike {
  private readonly deps: TerminalMatchDeps;
  private readonly ppidOf: (pid: number) => Promise<number | null>;
  private readonly now: () => number;
  /** pid -> its chain and when we walked it. Keyed by pid rather than by
   *  session, because two sessions under one shell share most of a chain and
   *  the disambiguation pass asks for all of them at once. */
  private readonly chains = new Map<
    number,
    { chain: number[]; at: number }
  >();
  private disposed = false;

  constructor(deps: TerminalMatchDeps) {
    this.deps = deps;
    this.ppidOf =
      deps.ppidOf ?? (async (pid) => (await psPpidCommand(pid)).ppid);
    this.now = deps.now ?? Date.now;
  }

  dispose(): void {
    this.disposed = true;
    this.chains.clear();
  }

  /**
   * The terminal running `sessionId`, or undefined when there is not exactly
   * one and it is not certain which.
   *
   * `alsoConsider` lets the caller add ids the roster does not carry under the
   * clicked one — the generation chain — so a re-keyed session is looked up
   * under every id it has worn.
   */
  async find(
    sessionId: string,
    alsoConsider: readonly string[] = [],
  ): Promise<vscode.Terminal | undefined> {
    if (this.disposed) return undefined;

    const terminals = this.openTerminals();
    if (terminals.length === 0) return undefined;

    const wanted = new Set<string>([sessionId, ...alsoConsider]);
    const roster = this.liveRoster();
    // Nothing to match against: the session is not on the roster (so it has no
    // process), or the CLI build reports no pids at all.
    if (!roster.some((e) => wanted.has(e.sessionId))) return undefined;

    // Terminal pids first — cheap, and if none resolve there is no point paying
    // for a single `ps`.
    const pidByTerminal = new Map<vscode.Terminal, number>();
    for (const terminal of terminals) {
      const pid = await this.deps.pidOf(terminal);
      if (pid !== undefined) pidByTerminal.set(terminal, pid);
    }
    if (pidByTerminal.size === 0) return undefined;
    const terminalPids = [...pidByTerminal.values()];

    const sessions: ChainedSession[] = [];
    for (const entry of roster) {
      const pid = entry.pid;
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
        continue;
      }
      sessions.push({
        sessionId: entry.sessionId,
        chain: await this.chainOf(pid),
      });
      if (this.disposed) return undefined;
    }

    const matched = matchSessionsToTerminals(sessions, terminalPids);
    // Any id the conversation has worn will do — the terminal is one tab either
    // way, and the roster names whichever generation is running in it.
    let hit: number | undefined;
    for (const id of wanted) {
      const pid = matched.get(id);
      if (pid === undefined) continue;
      if (hit !== undefined && hit !== pid) return undefined; // two tabs, one row
      hit = pid;
    }
    if (hit === undefined) return undefined;

    for (const [terminal, pid] of pidByTerminal) {
      if (pid === hit) return terminal;
    }
    return undefined;
  }

  /**
   * Reveal that terminal, taking focus — this is the answer to a click on the
   * row, and a reveal that does not go there is a click that appears to have
   * done nothing.
   *
   * `show()` is the ONLY thing done to a terminal Flock does not own. It sends
   * no keystroke, disposes nothing and changes no process state.
   */
  async reveal(
    sessionId: string,
    alsoConsider: readonly string[] = [],
  ): Promise<boolean> {
    const terminal = await this.find(sessionId, alsoConsider);
    if (terminal === undefined) return false;
    try {
      terminal.show(false);
    } catch (err) {
      logError('terminalMatch.show', err);
      return false;
    }
    log(
      'terminalMatch: revealed the terminal running',
      shortId(sessionId),
      '(not ours — read-only)',
    );
    return true;
  }

  private openTerminals(): readonly vscode.Terminal[] {
    let list: readonly vscode.Terminal[] | undefined;
    try {
      list = this.deps.terminals?.() ?? vscode.window?.terminals;
    } catch (err) {
      logError('terminalMatch.terminals', err);
      return [];
    }
    if (!list || typeof list.length !== 'number') return [];
    // A dead terminal's pid names a process that has gone; matching against one
    // could only produce a reveal of a tab with nothing in it.
    return list.filter((t) => {
      try {
        return t.exitStatus === undefined;
      } catch {
        return false;
      }
    });
  }

  private liveRoster(): readonly RosterEntry[] {
    try {
      const rows = this.deps.roster();
      return Array.isArray(rows) ? rows : [];
    } catch (err) {
      logError('terminalMatch.roster', err);
      return [];
    }
  }

  private async chainOf(pid: number): Promise<number[]> {
    const cached = this.chains.get(pid);
    const now = this.now();
    if (cached !== undefined && now - cached.at < CHAIN_TTL_MS) {
      return cached.chain;
    }
    const chain = await ancestorChain(pid, this.ppidOf);
    // Evict on write rather than on a timer: the map only grows with the live
    // roster, and a pid that leaves it is never asked for again.
    if (this.chains.size > 256) this.chains.clear();
    this.chains.set(pid, { chain, at: now });
    return chain;
  }
}
