// IMPLEMENTED BY: A
// src/lineage.ts — the parent-resolution cascade (SPEC §5), the argv walk, and
// the forest builder. Public surface frozen by SPEC §4-A3.
//
// Imports allowed here: ./types, ./log, ./transcript, node:child_process,
// node:process, node:path. NEVER import vscode, roster.ts or state.ts.
// Never spawn anything except `ps`. Never use message-uuid overlap (§5.5).
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE: a wrong edge is worse than no
// edge. Every branch below is either exact by construction (we recorded it at
// mint time, or the user dragged it, or the parent is literally an argument of
// the running process) or a transcript marker the CLI writes for exactly this
// purpose. Anything weaker — notably uuid overlap between transcripts — is
// refused outright, because sibling forks of one parent copy identical message
// uuids and such a match cannot tell a parent from a sibling. An unresolvable
// session renders as a flat root, and that is a correct answer.

import { execFile } from 'node:child_process';
import * as process from 'node:process';

import { log, logError } from './log';
import { forkParentFromTranscript } from './transcript';
import {
  FORK_ARGV_MAXDEPTH,
  MAX_GHOST_DEPTH,
  NEGATIVE_RESOLUTION_TTL_MS,
  SESSION_ID_RE,
  isSessionId,
  shortId,
  type ArchivedSession,
  type ArgvScanResult,
  type EditorialRecord,
  type LineageEdge,
  type NodeAttention,
  type ParentResolution,
  type ParentSource,
  type RosterEntry,
  type SessionForest,
  type SessionKind,
  type SessionNode,
  type SessionStatus,
  type TranscriptHeaderMeta,
} from './types';

const PS_TIMEOUT_MS = 2000;

// ------------------------------------------------------------- argv signals

/**
 * Exact port of Python `_resume_target`: the value after `--resume` / `-r`
 * (space or `=` form); returns the FIRST value passing SESSION_ID_RE, else
 * null.
 *
 * The uuid-shape gate is the safety guard: it is what keeps a stray argv token
 * (a file path, a flag value, a shell word) from becoming a bogus parent edge.
 */
export function resumeTarget(cmd: string): string | null {
  if (typeof cmd !== 'string' || cmd.length === 0) return null;
  const toks = cmd.split(/\s+/).filter((t) => t.length > 0);
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    let val: string | undefined;
    if ((tok === '--resume' || tok === '-r') && i + 1 < toks.length) {
      val = toks[i + 1];
    } else if (tok.startsWith('--resume=')) {
      val = tok.slice('--resume='.length);
    } else if (tok.startsWith('-r=')) {
      val = tok.slice('-r='.length);
    }
    if (val && SESSION_ID_RE.test(val)) return val;
  }
  return null;
}

/**
 * Exact port of `_ps_ppid_command`: (ppid, command) for a pid via macOS `ps`
 * (there is no /proc here). Any error -> {ppid: null, command: ''}.
 * Short-circuits to the failure value on win32 without spawning.
 */
export function psPpidCommand(
  pid: number,
): Promise<{ ppid: number | null; command: string }> {
  const failure = { ppid: null, command: '' };
  if (process.platform === 'win32') return Promise.resolve({ ...failure });
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return Promise.resolve({ ...failure });
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: { ppid: number | null; command: string }): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    try {
      execFile(
        'ps',
        ['-ww', '-o', 'ppid=,command=', '-p', String(pid)],
        { timeout: PS_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          // A dead pid makes ps exit non-zero — expected, not an error worth
          // logging on every tick.
          if (err) return done({ ...failure });
          const trimmed = (typeof stdout === 'string' ? stdout : '').trim();
          if (trimmed.length === 0) return done({ ...failure });
          // Python: stdout.strip().split(None, 1) — split on the FIRST
          // whitespace run only, so the command keeps its own spacing.
          const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
          if (!m) return done({ ...failure });
          const head = m[1];
          if (!/^\d+$/.test(head)) return done({ ...failure });
          const ppid = Number.parseInt(head, 10);
          if (!Number.isFinite(ppid)) return done({ ...failure });
          done({ ppid, command: m[2] ?? '' });
        },
      );
    } catch {
      done({ ...failure });
    }
  });
}

/**
 * Parent session id from the launching claude process's own command line.
 *
 * Port of Python `parent_from_fork_argv`, EXCEPT that the walk starts from the
 * session's OWN roster pid instead of `getppid()`. The Python ran inside a hook
 * whose parent WAS the claude process; the extension is not a hook child, so
 * `getppid()` is meaningless here — but an interactive CLI fork's claude
 * process itself carries the flags the user typed, so the roster pid is the
 * right entry point, and a small ancestor margin covers an intervening shell.
 *
 * Safe by construction: the resume target is the exact parent the user named —
 * never a sibling. The `--fork-session` gate excludes plain `--resume` resumes
 * (a resume is not a fork), and the uuid-shape check excludes stray tokens.
 * Native in-app forks launch claude bare (no `--resume` argv), so this yields
 * null for them — they resolve via `forkedFrom` instead. Never rejects.
 *
 * `forkGateSeen` reports whether ANY inspected command line carried
 * `--fork-session`; that is the independent evidence which authorizes the deep
 * transcript scan (SPEC §5.2).
 */
export async function parentFromForkArgv(
  sessionId: string,
  pid: number,
  maxdepth: number = FORK_ARGV_MAXDEPTH,
): Promise<ArgvScanResult> {
  let forkGateSeen = false;
  // No /proc on macOS and no `ps` contract on Windows: the walk simply does
  // not exist there, and those sessions degrade to flat roots (SPEC §11.5).
  if (process.platform === 'win32') return { parentId: null, forkGateSeen };
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return { parentId: null, forkGateSeen };
  }
  const depth =
    typeof maxdepth === 'number' && Number.isInteger(maxdepth) && maxdepth > 0
      ? maxdepth
      : FORK_ARGV_MAXDEPTH;

  try {
    let current = pid;
    for (let i = 0; i < depth; i++) {
      if (!current || current <= 1) break;
      const { ppid, command } = await psPpidCommand(current);
      if (command.includes('--fork-session')) {
        forkGateSeen = true;
        const parent = resumeTarget(command);
        if (parent && parent !== sessionId) {
          return { parentId: parent, forkGateSeen: true };
        }
      }
      if (ppid === null) break;
      current = ppid;
    }
  } catch (err) {
    logError('lineage: argv walk failed', err);
  }
  return { parentId: null, forkGateSeen };
}

// ---------------------------------------------------------------- resolver

/** Injectable IO for tests; the real defaults are wired in the constructor. */
export interface ResolverIO {
  scanTranscript(
    sessionId: string,
    opts: { deep: boolean; hint?: string },
  ): string | null;                       // → transcript.forkParentFromTranscript
  argvScan(sessionId: string, pid: number): Promise<ArgvScanResult>;
  now(): number;                          // → Date.now
}

interface CacheEntry {
  resolution: ParentResolution;
  /** null = cached for the resolver's lifetime. */
  expiresAt: number | null;
}

/** A recorded edge is only honoured when its source is one WE wrote. Inferred
 *  sources are never persisted (§5.5) — if one shows up in the state file it
 *  is drift, and it must not outrank a fresh inference. */
function recordedResolution(
  record: EditorialRecord | undefined,
  sessionId: string,
): ParentResolution | null {
  if (!record) return null;
  const source = record.parentSource;
  if (source !== 'minted' && source !== 'reparent') return null;
  const raw = record.parentId ?? null;
  // A recorded parentId of null is itself exact knowledge ("we launched this
  // as a root", or "the user dragged it out to the root level").
  const parentId = isSessionId(raw) && raw !== sessionId ? raw : null;
  return { parentId, source };
}

/**
 * The §5.1 cascade: recorded edge → forkedFrom head-scan → argv walk →
 * double-gated deep snake-scan → give up.
 *
 * Positive resolutions are cached for the resolver's lifetime (a parent edge
 * never changes once known); negatives expire after
 * NEGATIVE_RESOLUTION_TTL_MS because Claude writes transcripts lazily, so a
 * session that looked parentless a second after launch can become resolvable.
 */
export class LineageResolver {
  private readonly io: ResolverIO;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(io?: Partial<ResolverIO>) {
    this.io = {
      scanTranscript:
        io?.scanTranscript ??
        ((sessionId, opts) =>
          forkParentFromTranscript(sessionId, {
            deep: opts.deep,
            ...(opts.hint === undefined ? {} : { hint: opts.hint }),
          })),
      argvScan: io?.argvScan ?? ((sessionId, pid) => parentFromForkArgv(sessionId, pid)),
      now: io?.now ?? (() => Date.now()),
    };
  }

  async resolve(
    entry: { sessionId: string; pid?: number },
    record?: EditorialRecord,
  ): Promise<ParentResolution> {
    const id = entry?.sessionId;
    if (typeof id !== 'string' || id.length === 0) {
      return { parentId: null, source: 'none' };
    }

    // Branch 1 — recorded edge. Deliberately checked BEFORE the cache: a
    // record written this tick (a fork we just launched, a drag the user just
    // made) must win immediately, and no transcript signal may ever override
    // it.
    const recorded = recordedResolution(record, id);
    if (recorded) {
      this.cache.set(id, { resolution: recorded, expiresAt: null });
      return recorded;
    }

    const cached = this.cache.get(id);
    if (cached && (cached.expiresAt === null || cached.expiresAt > this.io.now())) {
      return cached.resolution;
    }

    const resolution = await this.derive(entry, id);
    this.cache.set(id, {
      resolution,
      expiresAt:
        resolution.parentId === null
          ? this.io.now() + NEGATIVE_RESOLUTION_TTL_MS
          : null,
    });
    return resolution;
  }

  /** Drop any cached resolution for this id (reparent / hook event). */
  invalidate(sessionId: string): void {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    this.cache.delete(sessionId);
  }

  private async derive(
    entry: { sessionId: string; pid?: number },
    id: string,
  ): Promise<ParentResolution> {
    // Branch 2 — forkedFrom head-scan. Exact: the native in-app fork marker,
    // written on line 1, bounded to FORK_HEAD_LINES, aborted by a compaction
    // boundary seen first.
    const head = this.scan(id, false);
    if (head) return { parentId: head, source: 'forkedFrom' };

    const pid = entry.pid;
    const pidUsable =
      typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
    if (pidUsable && process.platform !== 'win32') {
      // Branch 3 — argv walk. Exact: the resume target is literally the parent
      // the user typed at the still-running process.
      let scan: ArgvScanResult;
      try {
        scan = await this.io.argvScan(id, pid);
      } catch (err) {
        logError('lineage: argvScan failed', err);
        scan = { parentId: null, forkGateSeen: false };
      }
      const argvParent = this.sanitize(scan?.parentId ?? null, id);
      if (argvParent) return { parentId: argvParent, source: 'argv' };

      // Branch 4 — deep snake-scan, DOUBLE-GATED. The scan's own
      // compaction-boundary abort catches the observed shape, but a true
      // compaction successor produces the IDENTICAL snake/camel signature as a
      // CLI fork, so we additionally require independent evidence of a fork:
      // `--fork-session` seen in the process chain. Without that gate a
      // truncated or historic transcript missing its boundary record would mint
      // a wrong edge.
      if (scan?.forkGateSeen === true) {
        const deep = this.scan(id, true);
        if (deep) return { parentId: deep, source: 'cli-fork' };
      }
    }

    // Branch 5 — give up. A flat root is the correct rendering of a session
    // whose parent we cannot prove.
    return { parentId: null, source: 'none' };
  }

  private scan(id: string, deep: boolean): string | null {
    try {
      return this.sanitize(this.io.scanTranscript(id, { deep }), id);
    } catch (err) {
      logError('lineage: transcript scan failed', err);
      return null;
    }
  }

  /** §5.5: no edge whose extracted id fails SESSION_ID_RE or equals the child.
   *  Enforced here rather than in transcript.ts so the transcript reader stays
   *  a faithful reporter of what the file says. */
  private sanitize(candidate: string | null, id: string): string | null {
    if (!isSessionId(candidate)) return null;
    if (candidate === id) return null;
    return candidate;
  }
}

/**
 * Resolve every roster entry, then walk ghost ancestors up to MAX_GHOST_DEPTH.
 *
 * Ghosts (parents with no live roster row) get resolved too so a chain of dead
 * ancestors still renders. They carry no pid, so only the recorded-edge and
 * transcript branches can fire for them — which is exactly right: there is no
 * process left to inspect.
 */
export async function resolveAll(
  entries: RosterEntry[],
  resolver: LineageResolver,
  records: Record<string, EditorialRecord>,
): Promise<Map<string, ParentResolution>> {
  const out = new Map<string, ParentResolution>();
  const safeRecords = records ?? {};
  const live = new Set<string>();
  for (const e of entries ?? []) {
    if (e && typeof e.sessionId === 'string' && e.sessionId.length > 0) {
      live.add(e.sessionId);
    }
  }

  for (const e of entries ?? []) {
    if (!e || typeof e.sessionId !== 'string' || e.sessionId.length === 0) {
      continue;
    }
    if (out.has(e.sessionId)) continue; // duplicate roster row
    try {
      out.set(e.sessionId, await resolver.resolve(e, safeRecords[e.sessionId]));
    } catch (err) {
      logError(`lineage: resolve failed for ${shortId(e.sessionId)}`, err);
      out.set(e.sessionId, { parentId: null, source: 'none' });
    }
  }

  // Ghost ancestors, breadth-first with a visited-set cycle guard.
  const queue: Array<{ id: string; depth: number }> = [];
  const visited = new Set<string>(out.keys());
  for (const r of out.values()) {
    if (r.parentId && !live.has(r.parentId) && !visited.has(r.parentId)) {
      queue.push({ id: r.parentId, depth: 1 });
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    if (visited.has(item.id)) continue;
    visited.add(item.id);
    if (item.depth > MAX_GHOST_DEPTH) {
      log('lineage: ghost chain truncated at depth', item.depth);
      continue;
    }
    let r: ParentResolution;
    try {
      r = await resolver.resolve({ sessionId: item.id }, safeRecords[item.id]);
    } catch (err) {
      logError(`lineage: ghost resolve failed for ${shortId(item.id)}`, err);
      r = { parentId: null, source: 'none' };
    }
    out.set(item.id, r);
    if (r.parentId && !live.has(r.parentId) && !visited.has(r.parentId)) {
      queue.push({ id: r.parentId, depth: item.depth + 1 });
    }
  }

  return out;
}

// ----------------------------------------------------------- forest builder

export interface BuildForestInput {
  entries: RosterEntry[];
  resolutions: Map<string, ParentResolution>;
  records: Record<string, EditorialRecord>;
  headers?: Map<string, TranscriptHeaderMeta>;
  /** M1.5 closed sessions from the archive index. Callers pass only those NOT
   *  present in `entries` (see archive.archivedOnly): a live session's archived
   *  twin would be a duplicate row. */
  archived?: ArchivedSession[];
  opts?: {
    showGhosts?: boolean;       // default true
    sortWaitingFirst?: boolean; // default true
    now?: number;               // default Date.now()
  };
}

/**
 * Status/attention derivation for the forest.
 *
 * This duplicates roster.normalizeStatus's decision table on purpose: SPEC
 * §4-A3 forbids lineage.ts from importing roster.ts, and types.ts is frozen so
 * the table cannot live there. test/lineage.test.ts pins the two
 * implementations against each other so they cannot drift.
 */
function deriveStatus(e: RosterEntry): {
  status: SessionStatus;
  attention: NodeAttention;
} {
  const status =
    typeof e.status === 'string' ? e.status.trim().toLowerCase() : '';
  const state = typeof e.state === 'string' ? e.state.trim().toLowerCase() : '';
  if (status === 'waiting' || state === 'blocked') {
    return { status: 'waiting', attention: 'waiting' };
  }
  if (
    status === 'busy' ||
    status === 'working' ||
    state === 'running' ||
    state === 'working'
  ) {
    return { status: 'busy', attention: 'none' };
  }
  if (status === 'idle') return { status: 'idle', attention: 'none' };
  return { status: 'unknown', attention: 'none' };
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** startedAt ascending with undefined last, then id — a total order, so the
 *  tree never reshuffles between ticks for equal keys.
 *
 *  Archived (closed) nodes sort AFTER every live one, and among themselves by
 *  MOST RECENTLY ACTIVE first: for a closed session "when did I last touch it"
 *  is the useful key, and with 157 of them on this machine, oldest-first would
 *  bury everything you actually care about. */
function compareByStartThenId(a: SessionNode, b: SessionNode): number {
  if (a.archived !== b.archived) return a.archived ? 1 : -1;
  if (a.archived && b.archived) {
    const ae = a.endedAt;
    const be = b.endedAt;
    if (ae !== be) {
      if (ae === undefined) return 1;
      if (be === undefined) return -1;
      return be - ae; // descending
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }
  const as = a.startedAt;
  const bs = b.startedAt;
  if (as !== bs) {
    if (as === undefined) return 1;
    if (bs === undefined) return -1;
    return as - bs;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Normative assembly rules: SPEC §5.6. */
export function buildForest(input: BuildForestInput): SessionForest {
  const showGhosts = input?.opts?.showGhosts ?? true;
  const sortWaitingFirst = input?.opts?.sortWaitingFirst ?? true;
  const now = input?.opts?.now ?? Date.now();
  const records = input?.records ?? {};
  const headers = input?.headers;
  const resolutions = input?.resolutions ?? new Map<string, ParentResolution>();

  const nodes = new Map<string, SessionNode>();

  const resolutionFor = (id: string): ParentResolution =>
    resolutions.get(id) ?? { parentId: null, source: 'none' };

  // A self-edge is never real. Recorded provenance ('minted'/'reparent') still
  // describes the node itself, so it survives the cut; an inferred self-edge
  // is simply noise and degrades to 'none'.
  const cutSelfEdge = (
    res: ParentResolution,
    id: string,
  ): { parentId: string | null; source: ParentSource } => {
    if (res.parentId !== id) {
      return { parentId: res.parentId, source: res.source };
    }
    const source: ParentSource =
      res.source === 'minted' || res.source === 'reparent' ? res.source : 'none';
    return { parentId: null, source };
  };

  // (1) One node per deduped roster entry.
  for (const e of input?.entries ?? []) {
    if (!e || typeof e.sessionId !== 'string' || e.sessionId.length === 0) {
      continue;
    }
    if (nodes.has(e.sessionId)) continue; // first occurrence wins
    const id = e.sessionId;
    const record = records[id];
    const { status, attention } = deriveStatus(e);
    const { parentId, source } = cutSelfEdge(resolutionFor(id), id);

    const label =
      nonEmpty(record?.title) ??
      nonEmpty(e.name) ??
      nonEmpty(headers?.get(id)?.customTitle) ??
      shortId(id);

    // The roster is the liveness truth: an editorial `closed` timestamp never
    // demotes a session that `claude agents --json` still reports as running.
    const node: SessionNode = {
      id,
      parentId,
      source,
      roster: e,
      ghost: false,
      archived: false,
      hidden: record?.hidden === true,
      status,
      attention,
      label,
      kind: e.kind ?? 'unknown',
      children: [],
      visibleChildren: [],
    };
    const cwd = nonEmpty(e.cwd) ?? nonEmpty(record?.cwd);
    if (cwd !== undefined) node.cwd = cwd;
    if (e.startedAt !== undefined) node.startedAt = e.startedAt;
    nodes.set(id, node);
  }

  // (2) Archived: closed sessions read off disk (M1.5). A live row always wins
  // — the roster is the liveness truth — so anything already in `nodes` is
  // skipped. These are real nodes, not ghosts: they have a transcript, so they
  // survive the ghost-pruning pass and can be resumed.
  for (const a of input?.archived ?? []) {
    if (!a || typeof a.sessionId !== 'string' || a.sessionId.length === 0) {
      continue;
    }
    const id = a.sessionId;
    if (nodes.has(id)) continue;
    const record = records[id];
    const { parentId, source } = cutSelfEdge(resolutionFor(id), id);

    const label =
      nonEmpty(record?.title) ??
      nonEmpty(a.label) ??
      nonEmpty(headers?.get(id)?.customTitle) ??
      shortId(id);

    const node: SessionNode = {
      id,
      parentId,
      source,
      ghost: false,
      archived: true,
      archive: a,
      hidden: record?.hidden === true,
      status: 'exited',
      attention: 'none',
      label,
      kind: 'unknown',
      children: [],
      visibleChildren: [],
    };
    const cwd = nonEmpty(a.cwd) ?? nonEmpty(record?.cwd);
    if (cwd !== undefined) node.cwd = cwd;
    if (a.startedAt !== undefined) node.startedAt = a.startedAt;
    node.endedAt = a.endedAt;
    nodes.set(id, node);
  }

  // (3) Ghosts: every referenced parent with no roster row becomes a
  // synthesized, exited node, so a live fork of a dead session still shows its
  // lineage. Bounded by MAX_GHOST_DEPTH.
  let frontier: string[] = [];
  for (const n of nodes.values()) {
    if (n.parentId && !nodes.has(n.parentId)) frontier.push(n.parentId);
  }
  for (let depth = 0; depth < MAX_GHOST_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const gid of frontier) {
      if (nodes.has(gid)) continue;
      const record = records[gid];
      const { parentId, source } = cutSelfEdge(resolutionFor(gid), gid);
      const kind: SessionKind = 'unknown';
      const label =
        nonEmpty(record?.title) ??
        nonEmpty(headers?.get(gid)?.customTitle) ??
        `${shortId(gid)} (gone)`;
      const ghost: SessionNode = {
        id: gid,
        parentId,
        source,
        ghost: true,
        archived: false,
        hidden: record?.hidden === true,
        status: 'exited',
        attention: 'none',
        label,
        kind,
        children: [],
        visibleChildren: [],
      };
      const cwd = nonEmpty(record?.cwd);
      if (cwd !== undefined) ghost.cwd = cwd;
      nodes.set(gid, ghost);
      if (parentId && !nodes.has(parentId)) next.push(parentId);
    }
    frontier = next;
  }
  // Anything still dangling past the ghost bound becomes a root rather than a
  // reference into nothing.
  for (const n of nodes.values()) {
    if (n.parentId && !nodes.has(n.parentId)) {
      log('lineage: dropping unresolvable parent for', shortId(n.id));
      n.parentId = null;
      n.source = 'none';
    }
  }

  // (4) Cycle guard: walk each parent chain and cut the edge that closes a
  // loop. State drift (a hand-edited state.json, a reparent race) is the only
  // way to get one, but a cycle would hang the tree walk, so it is cut here.
  for (const start of nodes.values()) {
    const seen = new Set<string>([start.id]);
    let cur: SessionNode = start;
    while (cur.parentId) {
      const parent = nodes.get(cur.parentId);
      if (!parent) break; // already handled above
      if (seen.has(parent.id)) {
        log('lineage: cutting parent cycle at', shortId(cur.id));
        cur.parentId = null;
        cur.source = 'none';
        break;
      }
      seen.add(parent.id);
      cur = parent;
    }
  }

  // (5) children + roots.
  const roots: SessionNode[] = [];
  for (const n of nodes.values()) {
    if (n.parentId === null) {
      roots.push(n);
      continue;
    }
    const parent = nodes.get(n.parentId);
    if (parent) parent.children.push(n.id);
    else roots.push(n);
  }
  for (const n of nodes.values()) {
    n.children.sort((a, b) => {
      const na = nodes.get(a);
      const nb = nodes.get(b);
      if (!na || !nb) return a < b ? -1 : a > b ? 1 : 0;
      return compareByStartThenId(na, nb);
    });
  }
  roots.sort((a, b) => {
    if (sortWaitingFirst) {
      const aw = a.attention === 'waiting' ? 0 : 1;
      const bw = b.attention === 'waiting' ? 0 : 1;
      if (aw !== bw) return aw - bw;
    }
    return compareByStartThenId(a, b);
  });

  // (6) Visibility promotion. A hidden node is a recoverable delete: it loses
  // its row, but its children keep their lineage and surface under the nearest
  // visible ancestor. A ghost with no visible descendant is noise.
  const visibleMemo = new Map<string, boolean>();
  const descendantMemo = new Map<string, boolean>();

  const hasVisibleDescendant = (n: SessionNode): boolean => {
    const memo = descendantMemo.get(n.id);
    if (memo !== undefined) return memo;
    descendantMemo.set(n.id, false); // re-entrancy guard (defensive)
    let found = false;
    for (const cid of n.children) {
      const child = nodes.get(cid);
      if (!child) continue;
      if (isVisible(child) || hasVisibleDescendant(child)) {
        found = true;
        break;
      }
    }
    descendantMemo.set(n.id, found);
    return found;
  };

  function isVisible(n: SessionNode): boolean {
    const memo = visibleMemo.get(n.id);
    if (memo !== undefined) return memo;
    let visible: boolean;
    if (n.hidden) visible = false;
    else if (n.ghost && (!showGhosts || !hasVisibleDescendant(n))) {
      visible = false;
    } else visible = true;
    visibleMemo.set(n.id, visible);
    return visible;
  }

  const promotedMemo = new Map<string, string[]>();
  const visibleListOf = (ids: string[]): string[] => {
    const out: string[] = [];
    for (const id of ids) {
      const child = nodes.get(id);
      if (!child) continue;
      if (isVisible(child)) out.push(id);
      else out.push(...visibleChildrenOf(child));
    }
    return out;
  };
  function visibleChildrenOf(n: SessionNode): string[] {
    const memo = promotedMemo.get(n.id);
    if (memo !== undefined) return memo;
    promotedMemo.set(n.id, []); // re-entrancy guard (defensive)
    const list = visibleListOf(n.children);
    promotedMemo.set(n.id, list);
    return list;
  }

  for (const n of nodes.values()) {
    n.visibleChildren = visibleChildrenOf(n);
  }
  const visibleRoots = visibleListOf(roots.map((r) => r.id));

  // (7) edges + attention count.
  const edges: LineageEdge[] = [];
  let attentionCount = 0;
  for (const n of nodes.values()) {
    if (n.parentId) {
      edges.push({ childId: n.id, parentId: n.parentId, source: n.source });
    }
    if (n.attention === 'waiting' && isVisible(n)) attentionCount++;
  }

  return {
    nodes,
    roots: roots.map((r) => r.id),
    visibleRoots,
    edges,
    attentionCount,
    generatedAt: now,
  };
}
