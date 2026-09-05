// src/lineage.ts — the parent-resolution cascade, the argv walk, and the
// forest builder.
//
// This module imports ./types, ./log, ./transcript, ./archive and node
// builtins only — never vscode, roster.ts or state.ts. That keeps it runnable
// (and unit testable) outside the extension host, and keeps the ancestry model
// independent of the roster-polling layer that feeds it. It spawns nothing but
// `ps`, and never infers an edge from message-uuid overlap between transcripts
// (see below).
//
// ./archive is the newest of those and the only one that is not obviously a
// dependency: it owns the reading of a transcript HEAD, and the name a closed
// session's row carries is derived from that head. The alternative was a
// second copy of the precedence here, which would have let a row and the
// archive picker disagree about what one nameless session is called. archive.ts
// imports ./types, ./log, ./generations and ./usage, none of which reach back
// here, so the direction is a tree and not a cycle.
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

import { transcriptFallbackName } from './archive';
import { log, logError } from './log';
import { sharedWindowsProcessTable } from './processTable';
import type { ProcessSnapshot } from './processTable';
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
  type CompactionPhase,
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

/** The machine facts the parent walk reads. Injectable so the Windows route
 *  is testable from anywhere; production passes nothing. */
export interface PpidDeps {
  platform?: string;
  /** The Windows table to read. Absent = the shared, cached one. */
  windows?: () => Promise<ProcessSnapshot>;
}

/**
 * Exact port of `_ps_ppid_command`: (ppid, command) for a pid via `ps`
 * (there is no /proc on macOS). Any error -> {ppid: null, command: ''}.
 *
 * On win32 the same two facts come out of the shared CIM sweep
 * (src/processTable.ts) — one PowerShell per tick, however many hops the
 * walk takes, because the table is cached across them.
 */
export function psPpidCommand(
  pid: number,
  deps: PpidDeps = {},
): Promise<{ ppid: number | null; command: string }> {
  const failure = { ppid: null, command: '' };
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return Promise.resolve({ ...failure });
  }
  if ((deps.platform ?? process.platform) === 'win32') {
    const table = deps.windows ?? (() => sharedWindowsProcessTable().snapshot());
    return table().then(
      (snapshot) => {
        const fact = snapshot.get(pid);
        return fact === undefined ? { ...failure } : { ppid: fact.ppid, command: fact.command };
      },
      () => ({ ...failure }),
    );
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
 * transcript scan.
 */
export async function parentFromForkArgv(
  sessionId: string,
  pid: number,
  maxdepth: number = FORK_ARGV_MAXDEPTH,
): Promise<ArgvScanResult> {
  let forkGateSeen = false;
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

/** Extra knowledge the caller has about one session. Both fields exist for
 *  ARCHIVED sessions, whose transcript path is already known and whose file
 *  will never change again. */
export interface ResolveOptions {
  /** Known transcript path — skips the readdir probe over every project dir. */
  transcriptPath?: string;
  /** The transcript is finished: cache a negative answer forever. */
  immutable?: boolean;
}

/** A recorded edge is only honoured when its source is EXACT knowledge.
 *  Inferred sources are never persisted — if one shows up in the state file it
 *  is drift, and it must not outrank a fresh inference. 'daemon' qualifies: it
 *  is the CLI daemon's own dispatch record for a native /fork, persisted
 *  because the roster it comes from is ephemeral. */
function recordedResolution(
  record: EditorialRecord | undefined,
  sessionId: string,
): ParentResolution | null {
  if (!record) return null;
  const source = record.parentSource;
  if (source !== 'minted' && source !== 'reparent' && source !== 'daemon') {
    return null;
  }
  const raw = record.parentId ?? null;
  // A recorded parentId of null is itself exact knowledge ("we launched this
  // as a root", or "the user dragged it out to the root level").
  const parentId = isSessionId(raw) && raw !== sessionId ? raw : null;
  return { parentId, source };
}

/**
 * The cascade: recorded edge → forkedFrom head-scan → argv walk →
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
    opts?: ResolveOptions,
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

    const resolution = await this.derive(entry, id, opts);
    // Negatives normally expire: Claude writes transcripts lazily, so a
    // just-launched session can become resolvable a moment later. An ARCHIVED
    // transcript is finished and immutable, so re-deriving it can only ever
    // reach the same answer — and doing so costs a 512 KB synchronous head
    // read per session, every TTL window, on the extension-host thread. Those
    // negatives are cached for the resolver's lifetime.
    this.cache.set(id, {
      resolution,
      expiresAt:
        resolution.parentId === null && opts?.immutable !== true
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
    opts?: ResolveOptions,
  ): Promise<ParentResolution> {
    // Branch 2 — forkedFrom head-scan. Exact: the native in-app fork marker,
    // written on line 1, bounded to FORK_HEAD_LINES, aborted by a compaction
    // boundary seen first.
    const hint = opts?.transcriptPath;
    const head = this.scan(id, false, hint);
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
        const deep = this.scan(id, true, hint);
        if (deep) return { parentId: deep, source: 'cli-fork' };
      }
    }

    // Branch 5 — give up. A flat root is the correct rendering of a session
    // whose parent we cannot prove.
    return { parentId: null, source: 'none' };
  }

  private scan(id: string, deep: boolean, hint?: string): string | null {
    try {
      return this.sanitize(
        this.io.scanTranscript(id, hint === undefined ? { deep } : { deep, hint }),
        id,
      );
    } catch (err) {
      logError('lineage: transcript scan failed', err);
      return null;
    }
  }

  /** No edge whose extracted id fails SESSION_ID_RE or equals the child.
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
  /** Per-session extras, keyed by session id. The caller passes this for
   *  archived sessions: it already knows their transcript path, and their
   *  files never change again. */
  extras?: ReadonlyMap<string, ResolveOptions>,
  /** Applied to every resolved parent id BEFORE it is used: the caller
   *  passes the chain-tip mapper so an edge landing on a superseded
   *  generation re-points to the conversation's current id. Doing it here —
   *  not after — matters, because the ghost walk below would otherwise
   *  synthesize a "(gone)" row for exactly the id whose row the chain
   *  collapse just removed. */
  mapParent?: (parentId: string) => string,
): Promise<Map<string, ParentResolution>> {
  const out = new Map<string, ParentResolution>();
  const safeRecords = records ?? {};
  const live = new Set<string>();
  for (const e of entries ?? []) {
    if (e && typeof e.sessionId === 'string' && e.sessionId.length > 0) {
      live.add(e.sessionId);
    }
  }

  const applyMap = (r: ParentResolution): ParentResolution => {
    if (!mapParent || r.parentId === null) return r;
    let mapped: string;
    try {
      mapped = mapParent(r.parentId);
    } catch (err) {
      logError('lineage: mapParent threw', err);
      return r;
    }
    if (!isSessionId(mapped) || mapped === r.parentId) return r;
    return { parentId: mapped, source: r.source };
  };

  for (const e of entries ?? []) {
    if (!e || typeof e.sessionId !== 'string' || e.sessionId.length === 0) {
      continue;
    }
    if (out.has(e.sessionId)) continue; // duplicate roster row
    try {
      out.set(
        e.sessionId,
        applyMap(
          await resolver.resolve(
            e,
            safeRecords[e.sessionId],
            extras?.get(e.sessionId),
          ),
        ),
      );
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
      r = applyMap(
        await resolver.resolve(
          { sessionId: item.id },
          safeRecords[item.id],
          extras?.get(item.id),
        ),
      );
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
  /** Closed sessions from the archive index. Callers pass only those NOT
   *  present in `entries` (see archive.archivedOnly): a live session's archived
   *  twin would be a duplicate row. */
  archived?: ArchivedSession[];
  /** sessionId → transcript mtime, from ArchiveIndexer.transcriptMtimes(). Feeds
   *  SessionNode.lastActiveAt for live entries; keyed by chain-tip-collapsed id,
   *  same as `entries`/`archived`, so this must be built AFTER collapseChains
   *  has run over the archive facts. Archived nodes get their `lastActiveAt`
   *  from `archive.endedAt` directly (see below) and never consult this map. */
  activityMtimes?: ReadonlyMap<string, number>;
  /** sessionId → what the transcript TAIL says about the session: when the
   *  user last prompted it, how many tokens the last turn ran with, and the
   *  last conversation text (what an archived row shows when no summary was
   *  recorded). Same chain-tip-collapsed keying as `activityMtimes`. Every
   *  field is optional per entry and per session — a transcript whose tail
   *  carries none of them (too new, or nothing but tool traffic in the
   *  window) simply leaves the node's fields unset and every renderer falls
   *  back to what it showed before. */
  tailStats?: ReadonlyMap<
    string,
    {
      lastPromptAt?: number;
      tokens?: number;
      lastExchange?: string;
      /** The two clocks behind the fan-out mark, which are only ever read
       *  against EACH OTHER — see subagentsWorking. Spelled out here rather
       *  than left to structural typing: `TranscriptStats` carries them and
       *  would satisfy the shorter shape silently, so a reader of this
       *  declaration would conclude the fields are not available when they
       *  are, and the mark would look like it had no source. */
      lastRecordAt?: number;
      sidechainAt?: number;
    }
  >;
  /** sessionId → the compaction phase to draw, from the in-memory
   *  CompactionTracker (src/compaction.ts). A LOOKUP rather than a map of raw
   *  facts, because the tracker's answer depends on the chain (a compaction
   *  re-mints the id, so the start and the finish arrive under different ones)
   *  and on the live status — neither of which this module knows about. Absent,
   *  or answering undefined, is the ordinary case: a session in no compaction
   *  phase draws exactly the dots it drew before this existed.
   *
   *  LIVE ROWS ONLY. An archived node's phase would describe a process that has
   *  already exited, and 'closed' outranks every compaction mark anyway.
   *
   *  `status` is handed over rather than looked up because the tracker needs
   *  it — the resting purple dot means "compacted, and nothing behind it", so a
   *  session the roster reports as busy again withholds it — and this is the
   *  one place the DERIVED status exists. Asking the caller to re-derive it
   *  from the raw entry would be a second copy of deriveStatus's decision
   *  table, which is exactly the drift the two existing copies are pinned
   *  against by a test. */
  compactionOf?: (
    sessionId: string,
    status: SessionStatus,
  ) => CompactionPhase | undefined;
  opts?: {
    /** Whether exited ancestors get rows. Not a setting any more — the wiring
     *  always passes true, since ghosts are what keep the ancestry honest —
     *  but kept as a parameter so the ghost rules can be tested in isolation. */
    showGhosts?: boolean; // default true
    now?: number;         // default Date.now()
    /** `lineage.notifications.enabled` — the global default a per-record
     *  `notify` can override. When tracking is OFF for a session, its `unseen`
     *  stays undefined and every renderer falls back to the older behaviour,
     *  where waiting alone lit the dot green. Default true. */
    notificationsDefault?: boolean;
    /** `lineage.onlyActiveSessions` — drop every node that is OVER
     *  (archived, exited, or an inferred ghost ancestor) from the visible tree,
     *  promoting its children exactly as a deleted node's are. A view filter and
     *  nothing else: the nodes are still built, still in `nodes`, and still
     *  reachable by every verb that takes an id — flipping the switch back puts
     *  them straight back. Default false. */
    onlyActive?: boolean;
  };
}

/**
 * Status/attention derivation for the forest.
 *
 * This duplicates roster.normalizeStatus's decision table on purpose: this
 * module deliberately does not import roster.ts, so that the ancestry model
 * stays independent of the polling layer, and types.ts carries types only, so
 * the table cannot live there either. A test pins the two implementations
 * against each other so they cannot drift.
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

/**
 * Is this conversation over — nothing running, nothing to attach to?
 *
 * The one definition, living here because this module owns `SessionNode` and
 * computes all three of the flags it reads. It had grown four hand-written
 * copies in viewmodel.ts alone plus one local `isOver` inside buildForest, and
 * the moment the two renderers started making a LAYOUT decision off it (a
 * closed row is one row: no branch sub-line, no branch name in the native
 * description) a sixth and seventh copy in tree.ts would have been the drift
 * this codebase writes its comments to prevent. `visibleChildren`'s
 * `onlyActive` promotion, the row's compaction, and E's sibling comparator are
 * three readings of one fact and must never disagree about a single node.
 *
 * Ghosts count as over, and that is deliberate: a ghost is an ancestor
 * INFERRED from a child's edge, with no process, no transcript of its own and
 * a cwd borrowed from whichever child spoke first. Every question this
 * predicate answers — should the promotion pass skip it, may it claim a
 * checkout, does it sort after the live siblings — wants "yes, treat it as
 * finished".
 *
 * It is deliberately NOT `ViewRow.closed`, which is `!ghost && (archived ||
 * exited)`. That one governs DIMMING, and dimming a ghost would claim it was a
 * session of yours that ran and stopped — a history it does not have. Two
 * predicates that differ by exactly one arm look like a bug to anyone reading
 * quickly, so both carry the argument for the arm they differ on; do not merge
 * them.
 */
export function sessionIsOver(node: SessionNode): boolean {
  return node.ghost || node.archived || node.status === 'exited';
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Copy the transcript-tail facts onto a node, one field at a time and
 *  only when the value is a usable number. Shared by the live and the archived
 *  pass because both read the same map: an archived session's last prompt is
 *  as interesting as a live one's, and is the number its row has always been
 *  claiming to show. */
function applyTailStats(
  node: SessionNode,
  stats:
    | {
        lastPromptAt?: number;
        tokens?: number;
        lastExchange?: string;
        lastRecordAt?: number;
        sidechainAt?: number;
      }
    | undefined,
): void {
  if (stats === undefined) return;
  const at = stats.lastPromptAt;
  if (typeof at === 'number' && Number.isFinite(at) && at > 0) {
    node.lastPromptAt = at;
  }
  const tokens = stats.tokens;
  if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) {
    node.tokens = tokens;
  }
  // Copied onto every node the tail sweep covered, not only archived ones:
  // the fact is the same either way, and it is the RENDERERS that decide an
  // archived row is the one place it earns width (see viewmodel.pushSession).
  const exchange = stats.lastExchange;
  if (typeof exchange === 'string' && exchange.trim() !== '') {
    node.lastExchange = exchange;
  }
  if (subagentsWorking(node.status, stats)) node.subagents = true;
}

/**
 * How far behind the transcript's LAST record a sub-agent line may sit and
 * still count as "happening now".
 *
 * Generous, because it is measuring a gap inside one turn rather than a
 * timeout: an orchestrating session interleaves its own lines with its agents'
 * — it reads a result, thinks, dispatches the next one — and a window shorter
 * than that thinking would blink the mark off and on again through a fan-out
 * that never stopped. A blinking mark is worse than none.
 */
export const SUBAGENT_FRESH_MS = 90_000;

/**
 * IS WORK FANNING OUT UNDER THIS SESSION RIGHT NOW?
 *
 * Two conditions, and both are load-bearing.
 *
 * BUSY, because this is a statement about what a session is doing, and a
 * session that is not doing anything is not doing it with agents. It is also
 * what makes the mark self-clearing: nothing has to notice a workflow
 * FINISHING, because the turn ending takes the mark down with it.
 *
 * AND THE SIDECHAIN IS RECENT — measured against the transcript's own last
 * record, never against the wall clock. Sidechain lines do not expire out of a
 * transcript: every session that has ever dispatched an agent carries them in
 * its history, so an unqualified "has sidechains" would mark a session forever
 * on the strength of something it did last week. Comparing two timestamps read
 * out of the same file also means a machine whose clock disagrees with the
 * transcript's cannot produce a wrong answer here, which a `Date.now()`
 * comparison could.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM. Not how many agents, not which kind,
 * not a workflow as opposed to a single Task: a transcript tail interleaves
 * every sidechain into one stream with nothing that reliably separates one
 * agent's lines from another's, so a count would be a guess presented as a
 * number. The row says that the work has fanned out, which is the thing the
 * amber dot could not say and the thing worth knowing.
 */
export function subagentsWorking(
  status: SessionStatus,
  stats: { lastRecordAt?: number; sidechainAt?: number } | undefined,
): boolean {
  if (status !== 'busy' || stats === undefined) return false;
  const { sidechainAt, lastRecordAt } = stats;
  if (typeof sidechainAt !== 'number' || !Number.isFinite(sidechainAt)) {
    return false;
  }
  if (typeof lastRecordAt !== 'number' || !Number.isFinite(lastRecordAt)) {
    return false;
  }
  return lastRecordAt - sidechainAt <= SUBAGENT_FRESH_MS;
}

/**
 * Sibling order: startedAt ascending with undefined last, then id — a total
 * order, so the tree never reshuffles between ticks for equal keys, and never
 * reshuffles at all as a *side effect* of a session's status or attention
 * changing: a session waiting on you does not jump the queue, because that is
 * what the dot and the badge are for.
 *
 * Two demotions stack on top of that shared key, each checked before it:
 *
 *  - hidden sorts after every non-hidden sibling. That IS the "move it to the
 *    bottom" half of the hide verb — the grey is only how it looks, the order
 *    is what gets it out of the way. Applied at both levels (children lists
 *    and the root list), because a root demoted only within its folder row
 *    would still sit above live work.
 *  - OVER sorts after every live sibling, exactly once — and no longer
 *    reshuffles AMONG the over rows by recency. With `lineage.showArchived`
 *    on, this machine alone carries 157+ foreign closed sessions; keying
 *    purely on startedAt keeps their relative order stable instead of
 *    relitigating it every tick a process happens to exit.
 *
 *    "Over" is `sessionIsOver`, not `archived`. It used to be `archived`, and
 *    that read one arm short in a way you only see when a tree changes shape:
 *    a ghost — the inferred "(gone)" ancestor Flock mints when a child names a
 *    parent nothing can produce a row for — is never archived, and the ghost
 *    pass has no roster row to read a `startedAt` from (see step 3), so it
 *    fell through to the undefined-last branch and landed as the LAST LIVE
 *    sibling: above every real closed session. Exactly backwards, since a
 *    ghost is by construction the ancestor of something that has already
 *    finished. The same one-word fix also demotes a roster row the agent list
 *    still carries but reports as `exited`, which both renderers already draw
 *    as closed; the order now agrees with the drawing.
 *
 *    The REJECTED alternative was to synthesise a `startedAt` for the ghost
 *    from its earliest child, the way `noteInherited` synthesises a cwd. It is
 *    the same shape of guess but not the same quality of one: a cwd is a fact
 *    the child genuinely inherited from the parent, whereas a child's start
 *    time is emphatically not its parent's — the parent is older than every
 *    child by definition. And it would answer the wrong question. This key
 *    asks "is it still going", and for that a ghost has an answer already.
 */
function compareByStartThenId(a: SessionNode, b: SessionNode): number {
  if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
  const aOver = sessionIsOver(a);
  const bOver = sessionIsOver(b);
  if (aOver !== bOver) return aOver ? 1 : -1;
  const as = a.startedAt;
  const bs = b.startedAt;
  if (as !== bs) {
    if (as === undefined) return 1;
    if (bs === undefined) return -1;
    return as - bs;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The unseen verdict for one LIVE session: it finished a turn (`doneAt`,
 * stamped by the transition detector / Stop hook — or it is WAITING, which is
 * a standing request for the user whether or not a transition was observed)
 * and the user has not looked at it since. Tracking off → undefined, which
 * renderers read as "fall back to the older, unseen-blind behaviour".
 */
export function deriveUnseen(
  status: SessionStatus,
  record: EditorialRecord | undefined,
  notificationsDefault: boolean,
): boolean | undefined {
  const enabled = record?.notify ?? notificationsDefault;
  if (!enabled) return undefined;
  if (status !== 'waiting' && status !== 'idle') return undefined;
  const doneAt = record?.doneAt;
  const seenAt = record?.seenAt;
  if (status === 'waiting') {
    // Waiting IS the ask; an un-stamped waiting session is unseen until looked
    // at, which is also exactly what the green dot said before unseen tracking
    // existed.
    if (doneAt === undefined) return seenAt === undefined;
    return seenAt === undefined || seenAt < doneAt;
  }
  // idle: only a session with an OBSERVED finish can be unseen — otherwise
  // every long-idle session on the machine would light up green at install.
  if (doneAt === undefined) return false;
  return seenAt === undefined || seenAt < doneAt;
}

/** Assemble the forest: one node per roster entry, then the archived rows, the
 *  ghost ancestors, sibling order, visibility promotion and the edge list. */
export function buildForest(input: BuildForestInput): SessionForest {
  const showGhosts = input?.opts?.showGhosts ?? true;
  const notificationsDefault = input?.opts?.notificationsDefault ?? true;
  const onlyActive = input?.opts?.onlyActive === true;
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
      deleted: record?.deleted === true,
      status,
      attention,
      label,
      kind: e.kind ?? 'unknown',
      children: [],
      visibleChildren: [],
    };
    const cwd = nonEmpty(e.cwd) ?? nonEmpty(record?.cwd);
    if (cwd !== undefined) node.cwd = cwd;
    const summary = nonEmpty(record?.summary);
    if (summary !== undefined) node.summary = summary;
    if (e.startedAt !== undefined) node.startedAt = e.startedAt;
    // Age display keys off last activity, not session start — a session
    // opened this morning and typed in a minute ago should read as "a minute
    // ago", not "8 hours ago". Undefined (not yet covered by a sweep) leaves
    // lastActiveAt unset; renderers fall back to startedAt themselves.
    const la = input?.activityMtimes?.get(id);
    if (la !== undefined) node.lastActiveAt = la;
    applyTailStats(node, input?.tailStats?.get(id));
    // The detach grace, as a renderable fact. `graceUntil` is the lifecycle
    // sweep's deadline (workspaces.ts writes it when a switch detaches a
    // wrapped session); the row it governs is a LIVE row — the roster still
    // lists the process — and the spec's price for that detached-running
    // state is that the row must say so, with a countdown. Stamped only here,
    // in the live pass: an archived record's leftover deadline describes a
    // process that no longer exists, and a countdown on a dead row would be a
    // promise the sweep already kept. An unparseable stamp is left off the
    // node — the sweep reads the same garbage as "expired" and ends the
    // process within a minute, so the honest render is a plain live row, not
    // a fabricated deadline.
    if (typeof record?.graceUntil === 'string') {
      const deadline = Date.parse(record.graceUntil);
      if (Number.isFinite(deadline)) node.graceDeadlineAt = deadline;
    }
    // A muted (hidden) row never carries the green dot — hide is how the
    // user says "stop telling me about this one". Nor does a DELETED one, and
    // for a harder reason than taste: a deleted session has no row, so a dot
    // pointing at it can never be cleared by looking at it, and
    // `notificationItems` drops it from the bell list — which is how the bell
    // went red over an empty dropdown.
    if (!node.hidden && !node.deleted) {
      const unseen = deriveUnseen(status, record, notificationsDefault);
      if (unseen !== undefined) node.unseen = unseen;
    }
    // Same two exclusions as the unseen dot above and for the same reason: a
    // muted row must carry no lit mark at all, and a deleted one has no row for
    // a mark to sit on. The tracker owns every other rule about when a phase is
    // live — see src/compaction.ts.
    if (!node.hidden && !node.deleted) {
      const phase = input?.compactionOf?.(id, status);
      if (phase !== undefined) node.compaction = phase;
    }
    if (record?.notify === false) node.notifyMuted = true;
    nodes.set(id, node);
  }

  // (2) Archived: closed sessions read off disk. A live row always wins
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

    // WHAT A CLOSED ROW IS CALLED.
    //
    // Until this round the chain ended at `shortId`, and on a real machine it
    // ended there far too often: of the 278 transcripts under
    // ~/.claude/projects here, 198 — 71.2% — rendered as a bare eight-hex row.
    // Turning on "Show Closed Sessions Too" therefore filled the tree with
    // rows whose only readable content was the last-exchange snippet beside
    // the id, which is exactly the "I see the last prompt, not the name"
    // complaint this round exists to answer.
    //
    // `transcriptFallbackName` (archive.ts, which owns the reading of the
    // transcript head) adds two steps below the two title records: the CLI's
    // own generated `ai-title`, shown as an ordinary name because it IS a
    // title of this conversation and the alternative is a hex id; then the
    // opening prompt in typographic quotes, which is a QUOTATION and says so.
    // That takes the hex-id rate to 6.8%. `labelIsFallback` is the
    // machine-readable half of the quoting — the quotes are for the reader,
    // the flag is for code (terminal-tab naming) that must not treat a
    // quotation as a name someone chose.
    //
    // `headers.customTitle` keeps its place between them and is left where it
    // is deliberately: it and `a.label` are two readers of the SAME
    // `custom-title` record, and in the shipped wiring this step is dead —
    // extension.ts fills `headers` only for LIVE roster rows with no name, and
    // an archived node is by construction not one of those. Reordering it
    // would be churn against a step that never fires; keeping it costs
    // nothing and keeps callers that do pass headers (tests, and anything that
    // later wants to) working.
    const fallback = transcriptFallbackName(a);
    const label =
      nonEmpty(record?.title) ??
      nonEmpty(a.label) ??
      nonEmpty(headers?.get(id)?.customTitle) ??
      fallback?.text ??
      shortId(id);

    const node: SessionNode = {
      id,
      parentId,
      source,
      ghost: false,
      archived: true,
      archive: a,
      hidden: record?.hidden === true,
      deleted: record?.deleted === true,
      status: 'exited',
      attention: 'none',
      label,
      kind: 'unknown',
      children: [],
      visibleChildren: [],
    };
    // Only when the quotation actually WON the chain: a session with both a
    // recorded title and a first prompt has a real name, and flagging it would
    // cost that name its terminal tab.
    if (fallback?.fallback === true && label === fallback.text) {
      node.labelIsFallback = true;
    }
    const cwd = nonEmpty(a.cwd) ?? nonEmpty(record?.cwd);
    if (cwd !== undefined) node.cwd = cwd;
    const summary = nonEmpty(record?.summary);
    if (summary !== undefined) node.summary = summary;
    if (a.startedAt !== undefined) node.startedAt = a.startedAt;
    node.endedAt = a.endedAt;
    // An archived node's transcript is not being appended to anymore, so its
    // last activity IS the mtime we already stat'ed — no need to consult
    // activityMtimes (that map is a live-session convenience; ArchivedSession
    // always carries endedAt).
    node.lastActiveAt = a.endedAt;
    applyTailStats(node, input?.tailStats?.get(id));
    // A closed session can be resumed, and resuming it is exactly when a mute
    // matters again — the flag says what the record says, live or not.
    if (record?.notify === false) node.notifyMuted = true;
    nodes.set(id, node);
  }

  // (3) Ghosts: every referenced parent with no roster row becomes a
  // synthesized, exited node, so a live fork of a dead session still shows its
  // lineage. Bounded by MAX_GHOST_DEPTH.
  //
  // A ghost has no roster row and usually no editorial record, so its only
  // possible cwd is the one its children are running in — and it NEEDS one: a
  // ghost is the visible root of its subtree, and grouping keys entirely off
  // the root's cwd. Without this a fork of a just-closed parent falls out of
  // its project row into "(no directory)", or disappears altogether under
  // `lineage.unclaimedSessions: hidden`. Forks inherit the parent's directory, so
  // the child's cwd is the right answer rather than a guess.
  //
  // Two children can disagree — one was forked after a cd, or resumed in
  // another checkout — and then which project the ghost subtree files under
  // must not depend on roster response order. Earliest child wins, falling
  // back to the smaller cwd, so the answer is the same on every tick.
  const inheritedCwd = new Map<string, { cwd: string; startedAt?: number }>();
  const noteInherited = (
    parentId: string,
    cwd: string | undefined,
    startedAt?: number,
  ): void => {
    if (cwd === undefined) return;
    const cur = inheritedCwd.get(parentId);
    if (cur === undefined) {
      inheritedCwd.set(parentId, { cwd, startedAt });
      return;
    }
    if (cur.cwd === cwd) return;
    const earlier =
      startedAt !== undefined &&
      (cur.startedAt === undefined || startedAt < cur.startedAt);
    if (earlier || (startedAt === cur.startedAt && cwd < cur.cwd)) {
      inheritedCwd.set(parentId, { cwd, startedAt });
    }
  };

  let frontier: string[] = [];
  for (const n of nodes.values()) {
    if (n.parentId && !nodes.has(n.parentId)) {
      frontier.push(n.parentId);
      noteInherited(n.parentId, n.cwd, n.startedAt);
    }
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
        deleted: record?.deleted === true,
        status: 'exited',
        attention: 'none',
        label,
        kind,
        children: [],
        visibleChildren: [],
      };
      const cwd = nonEmpty(record?.cwd) ?? inheritedCwd.get(gid)?.cwd;
      if (cwd !== undefined) ghost.cwd = cwd;
      const summary = nonEmpty(record?.summary);
      if (summary !== undefined) ghost.summary = summary;
      nodes.set(gid, ghost);
      if (parentId && !nodes.has(parentId)) {
        next.push(parentId);
        // Carry the address up the chain: a ghost of a ghost is still the
        // visible root of everything below it.
        noteInherited(parentId, cwd);
      }
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
  // Roots share the exact comparator children lists use — no attention-based
  // float on top of it. A session that starts waiting on you, or finishes a
  // turn unseen, must not visibly jump the queue: that would be its own row
  // relocating itself as a side effect of your NOT having looked at it yet,
  // the opposite of a stable sidebar. See compareByStartThenId's doc comment
  // for the muting/archived rules this inherits unchanged.
  roots.sort(compareByStartThenId);

  // (6) Visibility promotion. A DELETED node loses its row, but its children
  // keep their lineage and surface under the nearest visible ancestor; nothing
  // on disk is touched, so restoring it puts the subtree back as it was. A
  // HIDDEN node is not part of this pass at all — it is merely muted, so it
  // keeps its row (sorted last, see compareByStartThenId) and its subtree stays
  // nested under it. A ghost with no visible descendant is noise.
  //
  // `onlyActive` adds one more way to lose a row, and reuses this pass rather
  // than filtering afterwards, because promotion is the whole point: with
  // `onlyActive` on, a live fork of a session you closed has to keep its place
  // in the tree instead of vanishing with its parent. That is precisely what
  // the delete path already does, and doing it here is also what keeps
  // `visibleChildren`, `visibleRoots` and `attentionCount` consistent with each
  // other — three fields every renderer reads as one answer.
  const isOver = sessionIsOver;
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
    if (n.deleted) visible = false;
    else if (onlyActive && isOver(n)) visible = false;
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

  // `children` is the STRUCTURE — where a node hangs, and it is sorted by the
  // comparator above. `visibleChildren` is the PICTURE — what a person
  // actually scans down. Promotion is the one thing that makes the two differ,
  // and until now it made them differ in a way nobody chose: `visibleListOf`
  // SPLICES a promoted child into the slot its invisible parent occupied, so
  // the position of a live fork on screen was decided by the sort key of a row
  // that is not on screen. Close or archive a session in the middle of a tree
  // and its fork visibly moves, though nothing about the fork changed — and
  // with Show Only Active Sessions on there is not even a row left to explain
  // the move. Re-keying the visible list with the same comparator merges the
  // promoted child back in among the siblings it now stands with.
  //
  // The REJECTED alternative was to stop demoting over rows, which would leave
  // the slot stable and need no second sort. It loses to compareByStartThenId's
  // own argument: the demotion is what keeps 157+ foreign closed sessions out
  // from between your live ones, and that is worth more than a stable slot for
  // a row that is disappearing anyway.
  //
  // This is a pure re-key and adds no state: `roots`, `children` and `edges`
  // are untouched, so everything that reasons about lineage rather than layout
  // still sees precisely the tree it saw before.
  //
  // The copy is load-bearing. `visibleChildrenOf` hands back the `promotedMemo`
  // entry itself, and a parent's `visibleListOf` spreads that same array into
  // its own list, so sorting in place would reorder a memo other callers share.
  const sortVisible = (ids: string[]): string[] =>
    [...ids].sort((a, b) => {
      const na = nodes.get(a);
      const nb = nodes.get(b);
      if (!na || !nb) return a < b ? -1 : a > b ? 1 : 0;
      return compareByStartThenId(na, nb);
    });

  for (const n of nodes.values()) {
    n.visibleChildren = sortVisible(visibleChildrenOf(n));
  }
  const visibleRoots = sortVisible(visibleListOf(roots.map((r) => r.id)));

  // (7) edges + attention count.
  const edges: LineageEdge[] = [];
  let attentionCount = 0;
  for (const n of nodes.values()) {
    if (n.parentId) {
      edges.push({ childId: n.id, parentId: n.parentId, source: n.source });
    }
    // `!n.hidden`: a muted row is on screen but must not badge the view — see
    // SessionForest.attentionCount.
    if (n.attention === 'waiting' && !n.hidden && isVisible(n)) attentionCount++;
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
