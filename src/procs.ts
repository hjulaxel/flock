// src/procs.ts — the process-tree reaper.
//
// THE PROBLEM THIS FILE EXISTS TO FIX: a claude session is not one process.
// Each one spawns ~8 MCP-server children (`uv run … ai-builder`, npm
// mcp-servers), and everything that ends a session — `kill-session` on the
// private tmux server, disposing a bare terminal's pty — kills only the pane
// root. The children are ORPHANED to PID 1 and keep running: on this machine
// that was ~670 processes and 32.6 GB of demand traced back to 84 sessions
// nobody could see. Ending a session must therefore end its process TREE, and
// nothing in the platform does that for us.
//
// The shape of a correct reap, and why the order matters:
//
//   1. WALK FIRST. Descendants are found via ppid (`ps -axo pid=,ppid=`)
//      BEFORE the root is killed — the instant the root dies its children
//      re-parent to PID 1 and the ppid walk can never find them again.
//   2. KILL the root (the caller's job: killTmuxSession, terminal dispose).
//   3. VERIFY, then ESCALATE. Most children exit with their parent (SIGHUP
//      from the dying pty); a short wait costs nothing and spares well-behaved
//      processes the signal. Survivors get SIGTERM, then — after another wait
//      — SIGKILL. Only pids ever collected in step 1 are signalled.
//
// NEVER BY NAME PATTERN. Every live session runs the identical server
// binaries, so `pkill -f mcp-server` is a loaded gun pointed at the sessions
// the user is still working in. A pid that was a descendant of THIS root at
// walk time is the only honest target — and pid reuse in the second between
// walk and kill is the accepted residual risk (macOS allocates upward; the
// window is two waits wide).
//
// This module NEVER imports vscode, and every effect — exec, kill, sleep — is
// injectable, so the whole ladder is unit-testable without spawning anything.

import { execFile } from 'node:child_process';

import { logError } from './log';

/** Injectable `execFile` — resolves stdout, rejects on error. */
export type ExecFn = (
  cmd: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<string>;

const defaultExec: ExecFn = (cmd, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(cmd, [...args], { timeout: timeoutMs }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

/** The wait between "root killed" and the survivor check, and again between
 *  SIGTERM and SIGKILL. Long enough for a SIGHUP'd child to run its exit
 *  handler; short enough that a close verb still feels immediate (the reap
 *  runs fire-and-forget behind the dispose). */
export const REAP_WAIT_MS = 1_500;

/**
 * Pure. `ps -axo pid=,ppid=` output as a pid → ppid map. Unparseable lines
 * are skipped, never fatal — `ps` output is whitespace-ragged by design.
 */
export function parsePsPpids(stdout: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (Number.isInteger(pid) && pid > 0 && Number.isInteger(ppid) && ppid >= 0) {
      out.set(pid, ppid);
    }
  }
  return out;
}

/**
 * Pure. Every pid transitively under `root` in the pid→ppid map, root
 * excluded. Breadth-first so the answer lists parents before their children —
 * signalling in that order gives a supervisor the chance to take its workers
 * down itself. A cycle in the input (corrupt ps output) cannot loop: each pid
 * is visited once.
 */
export function descendantsOf(
  root: number,
  pidToPpid: ReadonlyMap<number, number>,
): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of pidToPpid) {
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  const out: number[] = [];
  const seen = new Set<number>([root]);
  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    for (const pid of children.get(queue[i] as number) ?? []) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      out.push(pid);
      queue.push(pid);
    }
  }
  return out;
}

/**
 * The live descendants of `rootPid`, walked via `ps` — called BEFORE the kill,
 * because a dead root's children have already re-parented to PID 1 (see the
 * file header). Never throws; a machine whose `ps` fails yields `[]`, and the
 * reap degrades to exactly what shipped before this module existed.
 */
export async function listDescendants(
  rootPid: number,
  exec: ExecFn = defaultExec,
): Promise<number[]> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
  try {
    const stdout = await exec('ps', ['-axo', 'pid=,ppid='], 5_000);
    return descendantsOf(rootPid, parsePsPpids(stdout));
  } catch (err) {
    logError('procs.listDescendants', err);
    return [];
  }
}

/** The effects `reapSurvivors` performs, injectable for tests. `kill` throws
 *  ESRCH for a pid that is already gone — that is the GOOD outcome and is
 *  swallowed; `isAlive` is the `kill(pid, 0)` probe. */
export interface ReapDeps {
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
}

/** The `kill(pid, 0)` liveness probe. Exported because the shutdown-time
 *  bare reap (terminals.ts) needs the same answer for a different question —
 *  "did the pty root actually die, or is this a window RELOAD keeping it for
 *  revival?" — and two probes with different edge-case answers would make
 *  that decision untestable. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = exists but not ours — alive, and not ours to signal either; the
    // ladder will try, fail with EPERM, and log. ESRCH = gone.
    return (e as NodeJS.ErrnoException | undefined)?.code === 'EPERM';
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Verify the walked descendants exited; escalate on the ones that did not.
 * Called AFTER the root was killed. Waits once (most children follow their
 * parent down unprompted), SIGTERMs the survivors, waits again, SIGKILLs the
 * stubborn — each signal to an explicit pid from the pre-kill walk, never to
 * a name or a group. Returns what it did, for the log line that answers
 * "where did those uv processes go?".
 */
export async function reapSurvivors(
  pids: readonly number[],
  deps: ReapDeps = {},
): Promise<{ exited: number; termed: number; killed: number }> {
  const kill = deps.kill ?? ((pid, sig) => process.kill(pid, sig));
  const isAlive = deps.isAlive ?? isPidAlive;
  const sleep = deps.sleep ?? defaultSleep;
  const waitMs = deps.waitMs ?? REAP_WAIT_MS;

  const out = { exited: 0, termed: 0, killed: 0 };
  if (pids.length === 0) return out;

  const signal = (pid: number, sig: NodeJS.Signals): void => {
    try {
      kill(pid, sig);
    } catch (e) {
      // ESRCH: exited between the probe and the signal — the outcome we
      // wanted. Anything else (EPERM) is logged; a process we cannot signal
      // is not ours to kill and never was.
      if ((e as NodeJS.ErrnoException | undefined)?.code !== 'ESRCH') {
        logError(`procs.reap: kill(${String(pid)}, ${sig})`, e);
      }
    }
  };

  await sleep(waitMs);
  let survivors = pids.filter((pid) => isAlive(pid));
  out.exited = pids.length - survivors.length;
  if (survivors.length === 0) return out;

  for (const pid of survivors) signal(pid, 'SIGTERM');
  out.termed = survivors.length;

  await sleep(waitMs);
  survivors = survivors.filter((pid) => isAlive(pid));
  for (const pid of survivors) signal(pid, 'SIGKILL');
  out.killed = survivors.length;
  return out;
}

// -------------------------------------------------- window-close orphan rescue
//
// THE GAP THESE THREE PIECES CLOSE: a BARE terminal's pty root is killed by
// VS Code itself when the window closes — not by us, so neither reap ladder
// above ever ran, and the ~8 MCP children re-parent to PID 1 with nothing
// hunting them (the activation reconcile is tmux-only). The shutdown-time
// best-effort reap (terminals.ts) catches what it can, but the extension host
// is dying under it and may not live out even one wait — so each window ALSO
// persists its bare pid snapshot (plus each pid's ps start time) to
// globalStorage once a minute, and the NEXT activation reads every window's
// leftover snapshot and reaps what provably orphaned.
//
// "Provably" is three checks, all of them load-bearing:
//   * the pid still EXISTS — a process that exited needs nothing;
//   * its START TIME matches the snapshot — hours may pass between the crash
//     and the next activation, and a recycled pid with a matching number is
//     somebody else's process. lstart is immutable for a process's lifetime,
//     so equality here IS identity — this is what makes signalling a
//     persisted (rather than freshly-walked) pid honest at all;
//   * its PPID is 1 — orphaned. This is what keeps the rescue from killing
//     the LIVING: a window reload revives its terminals (same processes,
//     same start times!) and a still-open window's sessions are in its own
//     snapshot file — in both cases every process still hangs off a live
//     claude root, not PID 1, and is left alone.
//
// A grandchild whose parent is in the same snapshot re-parents to PID 1 only
// AFTER that parent is reaped, so one pass may leave it "still parented" —
// the next activation's pass gets it. Self-healing beats a loop here.

/** One persisted snapshot entry: a pid and the `ps lstart` it wore when the
 *  snapshot was taken. Start-time equality is the identity check that makes
 *  it safe to signal this pid a long time later. */
export interface PersistedPidFact {
  pid: number;
  start: string;
}

/**
 * Pure. `ps -axo pid=,ppid=,lstart=` output as pid → {ppid, start}. The
 * lstart column is a fixed English date ("Sat Aug 23 07:00:00 2026") whose
 * day-of-month padding varies, so runs of whitespace are collapsed — both the
 * snapshot and the verification parse through here, which is what lets the
 * two strings be compared with `===`. Unparseable lines are skipped, never
 * fatal, exactly as in parsePsPpids.
 */
export function parsePsPidFacts(
  stdout: string,
): Map<number, { ppid: number; start: string }> {
  const out = new Map<number, { ppid: number; start: string }>();
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0) {
      continue;
    }
    out.set(pid, { ppid, start: (m[3] as string).trim().replace(/\s+/g, ' ') });
  }
  return out;
}

/**
 * The {ppid, start} facts for the given pids, walked via one `ps -axo` sweep.
 * The full table rather than `ps -p <list>` on purpose: `-p` exits non-zero
 * the moment ANY listed pid is gone — which is the NORMAL case here (most of
 * a dead window's processes exited with it) — and an exec seam that rejects
 * on exit status would throw away the rows for the survivors we actually
 * need. Never throws; a machine whose `ps` fails yields an empty map, and no
 * facts means no verification means no signal.
 */
export async function listPidFacts(
  pids: readonly number[],
  exec: ExecFn = defaultExec,
): Promise<Map<number, { ppid: number; start: string }>> {
  const wanted = new Set(pids.filter((p) => Number.isInteger(p) && p > 0));
  if (wanted.size === 0) return new Map();
  try {
    const stdout = await exec('ps', ['-axo', 'pid=,ppid=,lstart='], 5_000);
    const all = parsePsPidFacts(stdout);
    const out = new Map<number, { ppid: number; start: string }>();
    for (const pid of wanted) {
      const fact = all.get(pid);
      if (fact !== undefined) out.set(pid, fact);
    }
    return out;
  } catch (err) {
    logError('procs.listPidFacts', err);
    return new Map();
  }
}

/**
 * Pure. Which persisted pids may be signalled, and whether the snapshot's
 * owner still looks alive. `reap` is the pids that pass all three checks in
 * the header (exist + start-time identity + orphaned to PID 1).
 * `ownerLikelyAlive` is true when some pid is verifiably OURS but still
 * parented — a live window's session, or a reload's revived terminal — which
 * tells the caller to leave the snapshot file in place: its owner (or its
 * heir) is still refreshing it, and deleting it would disarm the rescue for
 * the very processes it exists to catch.
 */
export function orphanRescueDecision(
  saved: readonly PersistedPidFact[],
  live: ReadonlyMap<number, { ppid: number; start: string }>,
): { reap: number[]; ownerLikelyAlive: boolean } {
  const reap: number[] = [];
  let ownerLikelyAlive = false;
  const seen = new Set<number>();
  for (const entry of saved) {
    if (!Number.isInteger(entry.pid) || entry.pid <= 0) continue;
    if (typeof entry.start !== 'string' || entry.start === '') continue;
    if (seen.has(entry.pid)) continue;
    seen.add(entry.pid);
    const fact = live.get(entry.pid);
    if (fact === undefined) continue; // exited — the outcome we wanted
    if (fact.start !== entry.start) continue; // recycled pid — not ours
    if (fact.ppid === 1) reap.push(entry.pid);
    else ownerLikelyAlive = true;
  }
  return { reap, ownerLikelyAlive };
}
