// src/daemon.ts — the CLI daemon's dispatch roster (M11: native /fork).
//
// THE PROBLEM THIS FILE EXISTS TO FIX: `/fork` typed inside a session leaves
// NO marker in the child's transcript. Verified on this machine (CLI 2.1.207–
// 2.1.220): every line of a /fork child's transcript is rewritten to the
// child's own id, and no `forkedFrom` record is written anywhere in the file —
// unlike the extension's own `--fork-session --resume P --session-id C`
// launches, whose transcripts do carry the marker. So a /fork child used to
// render as a FLAT ROOT wearing its parent's copied title: a duplicate-looking
// row with its lineage thrown away.
//
// The one place the parentage exists on disk is the daemon's own dispatch
// roster, `~/.claude/daemon/roster.json`:
//
//   workers[<short>].dispatch.launch = {
//     mode: "resume",
//     sessionId: "<abs path>/<PARENT-uuid>.jsonl",   // what was resumed
//     fork: true,                                    // ... as a fork
//   }
//   workers[<short>].sessionId = "<CHILD-uuid>"
//
// That record is written by the CLI itself when it dispatches the fork — it is
// a dispatch log, not an inference, so an edge read from it is EXACT in the
// same sense a minted edge is. It is also EPHEMERAL (the roster holds current
// workers and is rewritten by the daemon), which is why extension.ts PERSISTS
// each observed edge into the editorial store as `parentSource: 'daemon'`
// rather than re-deriving it every tick: once the daemon forgets the worker,
// the persisted record is all that keeps the fork nested under its parent.
//
// `mode: "resume"` WITHOUT `fork` is the other useful fact: the daemon resumed
// an old conversation under a new id — exactly the M10 generation-chain
// signal, from a source that (unlike the transcript-head heuristic) also
// covers successors that copy nothing.
//
// Imports allowed here: ./types, ./log, node:fs, node:path, node:os.
// NEVER import vscode.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { log, logError } from './log';
import { SESSION_ID_RE, isSessionId, shortId } from './types';

/** One dispatch record the daemon roster knows about. */
export interface DaemonDispatch {
  /** The worker's own session id — the CHILD of a fork dispatch. */
  sessionId: string;
  /** The session the dispatch resumed (parent for a fork, predecessor for a
   *  plain resume). Absent when the launch names nothing uuid-shaped. */
  resumedId?: string;
  /** launch.fork === true — the dispatch was a /fork (or equivalent). */
  fork: boolean;
  /** launch.mode, verbatim ('resume', 'new', …). */
  mode?: string;
}

export interface DaemonFacts {
  /** child id → parent id, for fork dispatches. */
  forkParents: ReadonlyMap<string, string>;
  /** new id → predecessor id, for plain-resume dispatches whose worker wears
   *  a DIFFERENT id than the transcript it resumed — the chain re-key. */
  resumeContinuations: ReadonlyMap<string, string>;
}

const EMPTY_FACTS: DaemonFacts = {
  forkParents: new Map(),
  resumeContinuations: new Map(),
};

export function defaultDaemonRosterPath(): string {
  return path.join(os.homedir(), '.claude', 'daemon', 'roster.json');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The uuid a launch.sessionId names. The observed value is an ABSOLUTE
 * TRANSCRIPT PATH (`…/<uuid>.jsonl`); a bare uuid is accepted too, because the
 * field's shape is the CLI's to change and the uuid is all we ever wanted.
 * Anything else — including a path whose basename is not uuid-shaped — yields
 * undefined rather than a guessed edge.
 */
export function resumedIdOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  if (SESSION_ID_RE.test(raw)) return raw;
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? '';
  const stem = base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : base;
  return isSessionId(stem) ? stem : undefined;
}

/**
 * Pull every dispatch out of a parsed roster blob. Pure and tolerant: every
 * field except the worker's own uuid-shaped sessionId is optional, unknown
 * shapes are skipped, and nothing here throws.
 */
export function parseDaemonRoster(raw: unknown): DaemonDispatch[] {
  const out: DaemonDispatch[] = [];
  if (!isPlainObject(raw)) return out;
  const workers = raw['workers'];
  if (!isPlainObject(workers)) return out;

  for (const worker of Object.values(workers)) {
    if (!isPlainObject(worker)) continue;
    const sessionId = worker['sessionId'];
    if (!isSessionId(sessionId)) continue;

    const dispatch = isPlainObject(worker['dispatch']) ? worker['dispatch'] : {};
    const launch = isPlainObject(dispatch['launch']) ? dispatch['launch'] : {};

    const entry: DaemonDispatch = {
      sessionId,
      fork: launch['fork'] === true,
    };
    const mode = launch['mode'];
    if (typeof mode === 'string' && mode.length > 0) entry.mode = mode;
    const resumed = resumedIdOf(launch['sessionId']);
    // A self-reference is a plain keep-the-id resume — no edge in it.
    if (resumed !== undefined && resumed !== sessionId) {
      entry.resumedId = resumed;
    }
    out.push(entry);
  }
  return out;
}

/** Fold dispatches into the two maps the extension consumes. */
export function factsOf(dispatches: readonly DaemonDispatch[]): DaemonFacts {
  const forkParents = new Map<string, string>();
  const resumeContinuations = new Map<string, string>();
  for (const d of dispatches) {
    if (d.resumedId === undefined) continue;
    if (d.fork) forkParents.set(d.sessionId, d.resumedId);
    else if (d.mode === 'resume') {
      resumeContinuations.set(d.sessionId, d.resumedId);
    }
  }
  return { forkParents, resumeContinuations };
}

/**
 * Reads ~/.claude/daemon/roster.json, cached by (mtimeMs, size) so the steady
 * state is one stat per tick. Never throws — a missing daemon, an unreadable
 * file or a torn write all yield the LAST GOOD facts (or the empty ones),
 * because a broken read must not un-parent rows that were correct a tick ago.
 */
export class DaemonRosterReader {
  private readonly rosterPath: string;
  private lastMtimeMs = -1;
  private lastSize = -1;
  private lastFacts: DaemonFacts = EMPTY_FACTS;
  private loggedMissing = false;

  constructor(rosterPath?: string) {
    this.rosterPath = rosterPath ?? defaultDaemonRosterPath();
  }

  read(): DaemonFacts {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.rosterPath);
    } catch {
      // No daemon on this machine (older CLI, or it never ran). Normal.
      if (!this.loggedMissing) {
        log('daemon: no roster at', this.rosterPath);
        this.loggedMissing = true;
      }
      return this.lastFacts;
    }
    if (st.mtimeMs === this.lastMtimeMs && st.size === this.lastSize) {
      return this.lastFacts;
    }
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.rosterPath, 'utf8'));
      const dispatches = parseDaemonRoster(raw);
      const facts = factsOf(dispatches);
      this.lastMtimeMs = st.mtimeMs;
      this.lastSize = st.size;
      this.lastFacts = facts;
      if (facts.forkParents.size > 0 || facts.resumeContinuations.size > 0) {
        log(
          `daemon: ${facts.forkParents.size} fork edge(s), ` +
            `${facts.resumeContinuations.size} resume continuation(s)`,
        );
      }
      return facts;
    } catch (err) {
      // A torn write mid-read: keep the last good answer, try again next tick.
      logError('daemon.read', err);
      return this.lastFacts;
    }
  }
}

export function describeForkEdge(childId: string, parentId: string): string {
  return `${shortId(childId)} forked-from ${shortId(parentId)} (daemon)`;
}
