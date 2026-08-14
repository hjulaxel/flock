// src/archive.ts — the history index.
//
// `claude agents --json` is a LIVE registry: it lists running sessions only.
// Every session you close leaves the roster and, before this module existed,
// vanished from the tree entirely — on this machine that was 157 of 217
// sessions, including 11 carrying real `forkedFrom` edges the tree could not
// show. This module indexes ~/.claude/projects/*/<sessionId>.jsonl so a closed
// session becomes an ARCHIVED row: still in the tree, still in its lineage,
// and safe to `--resume` (nothing else holds the transcript open).
//
// It imports ./types, ./log and node builtins only, and never vscode: the
// index is plain filesystem work, and staying free of the editor API is what
// keeps it runnable under unit tests outside the extension host.
//
// Reads are BOUNDED and cached by (mtimeMs, size): a full cold scan of 217
// transcripts measured 0.20 s (0.9 ms each), and a warm re-scan only re-reads
// files whose stat changed. Never throws — a failed scan yields the previous
// index, and the tree degrades to live-only rather than breaking.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { log } from './log';
import {
  ARCHIVE_HEAD_LINES,
  ARCHIVE_HEAD_MAX_BYTES,
  type ArchivedSession,
  type DisposableLike,
  type EditorialRecord,
  type RosterEntry,
  type UnlistedSession,
  isSessionId,
  shortId,
} from './types';
import type { GenerationFacts } from './generations';

export interface ArchiveScanOptions {
  projectsDir?: string;
  /** Ids known to be live; they are indexed but flagged so callers can skip. */
  liveIds?: ReadonlySet<string>;
  /** Additional projects roots to index — one per account profile with
   *  its own config dir (`<configDir>/projects`), where that account's
   *  transcripts actually land. Scanned AFTER the primary root, so on the
   *  (theoretically impossible) duplicate id the default dir wins — the same
   *  first-occurrence rule the in-root dedupe already applies. A root that
   *  cannot be read is skipped silently: a profile that has never run a
   *  session has no projects dir, and that is a normal day, not an error. */
  extraProjectsDirs?: readonly string[];
}

export interface ArchiveResult {
  ok: boolean;
  sessions: ArchivedSession[];
  tookMs: number;
  scanned: number;   // transcripts stat'ed
  reread: number;    // transcripts whose head had to be re-read
  error?: string;
}

export function defaultProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** Bounded head read. Identical discipline to transcript.readHead: invalid
 *  UTF-8 at the cap becomes U+FFFD, that line then fails JSON.parse, skipped. */
function readHead(file: string, maxBytes: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const want = Math.min(
      Number.isFinite(size) ? Math.max(size, 0) : maxBytes,
      maxBytes,
    );
    if (want <= 0) return '';
    const buf = Buffer.alloc(want);
    const read = fs.readSync(fd, buf, 0, want, 0);
    return buf.toString('utf-8', 0, read);
  } finally {
    fs.closeSync(fd);
  }
}

interface HeadFacts {
  cwd?: string;
  label?: string;
  firstTimestamp?: number;
  /** The FIRST line's `sessionId` value. In a fork or a plain file this is the
   *  file's own id; in a plain-`--resume` continuation it is the PREDECESSOR's
   *  id, because the CLI copies the predecessor's lines verbatim. */
  firstSessionId?: string;
  /** A forkedFrom marker was seen in the head window. Forks rewrite their
   *  copied head to their own id AND write this marker, so its absence is what
   *  certifies a head-id mismatch as a continuation rather than a fork. */
  forkMarker?: boolean;
}

/**
 * Pull display facts out of a transcript head.
 *
 * Measured on this machine: `cwd` first appears at median line 3, p90 line 11,
 * max line 36 — comfortably inside ARCHIVE_HEAD_LINES. The `custom-title`
 * header record is the label source (the roster's `name` has no archived
 * equivalent). Deliberately NOT derived from the project DIRECTORY name: that
 * encoding is lossy — a naive '-'→'/' decode resolved only 14 of 39 real dirs
 * here, because path segments containing dashes are ambiguous.
 *
 * Pure, bounded, never throws.
 */
export function readHeadFacts(file: string, ownId?: string): HeadFacts {
  const out: HeadFacts = {};
  let text: string;
  try {
    text = readHead(file, ARCHIVE_HEAD_MAX_BYTES);
  } catch {
    return out;
  }
  if (text === '') return out;

  const lines = text.split('\n');
  const limit = Math.min(lines.length, ARCHIVE_HEAD_LINES);
  for (let i = 0; i < limit; i++) {
    const line = lines[i];
    if (!line || line.trim() === '') continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // partial write or garbage — skip, exactly like the fork scan
    }
    if (!isPlainObject(rec)) continue;

    if (out.label === undefined && rec['type'] === 'custom-title') {
      const t = nonEmpty(rec['customTitle']);
      if (t !== undefined) out.label = t;
    }
    if (out.cwd === undefined) {
      const c = nonEmpty(rec['cwd']);
      if (c !== undefined) out.cwd = c;
    }
    if (out.firstTimestamp === undefined) {
      const ts = rec['timestamp'];
      if (typeof ts === 'string' && ts !== '') {
        const parsed = Date.parse(ts);
        if (Number.isFinite(parsed)) out.firstTimestamp = parsed;
      }
    }
    if (out.firstSessionId === undefined) {
      const sid = rec['sessionId'];
      if (isSessionId(sid)) out.firstSessionId = sid;
    }
    if (out.forkMarker !== true && isPlainObject(rec['forkedFrom'])) {
      out.forkMarker = true;
    }
    // The early break needs one extra condition: when the first line
    // names a DIFFERENT session id, the fork-vs-continuation verdict hangs on
    // whether a forkedFrom marker appears anywhere in the window, so the scan
    // must run to the limit unless the marker has already been seen.
    const mismatchOpen =
      ownId !== undefined &&
      out.firstSessionId !== undefined &&
      out.firstSessionId !== ownId &&
      out.forkMarker !== true;
    if (
      out.label !== undefined &&
      out.cwd !== undefined &&
      out.firstTimestamp !== undefined &&
      out.firstSessionId !== undefined &&
      !mismatchOpen
    ) {
      break; // everything we came for
    }
  }
  return out;
}

/** The continuation verdict for one head. Exported for tests. */
export function continuationOf(
  ownId: string,
  facts: HeadFacts,
): string | undefined {
  if (facts.forkMarker === true) return undefined;
  const first = facts.firstSessionId;
  if (!isSessionId(first) || first === ownId) return undefined;
  return first;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  session: ArchivedSession;
  /** The head read was SKIPPED for this entry because the session was live at
   *  the time. Part of the cache key in effect: without it, the last scan
   *  before a session closes caches a fact-less row against the transcript's
   *  final (mtime, size), and since a closed transcript never changes again
   *  every later scan hits it — the archived row loses its cwd and title for
   *  the lifetime of the window. */
  liveAtScan: boolean;
}

/**
 * Indexes every transcript under ~/.claude/projects.
 *
 * The cache key is (mtimeMs, size), so a warm re-scan costs one readdir per
 * project dir plus one stat per transcript and re-reads only what changed. A
 * live session's transcript grows constantly, which would re-read it on every
 * pass — so live ids are stat'ed but never head-read (their label and cwd come
 * from the roster, which is authoritative for them anyway).
 */
export class ArchiveIndexer implements DisposableLike {
  private readonly projectsDir: string;
  private cache = new Map<string, CacheEntry>();
  private last: ArchivedSession[] = [];
  private lastOk = false;
  /** sessionId → continuation verdict (predecessor id, or null for
   *  "verified: not a continuation"). A transcript's HEAD is immutable — the
   *  file is append-only — so this is computed at most once per id per window,
   *  which is what makes reading it affordable for LIVE transcripts too (whose
   *  display facts are deliberately never read; see scan()). */
  private chainVerdicts = new Map<string, string | null>();

  constructor(projectsDir?: string) {
    this.projectsDir = projectsDir ?? defaultProjectsDir();
  }

  /** The most recent successful index. Empty until scan() has run once. */
  current(): ArchivedSession[] {
    return this.last;
  }

  /**
   * sessionId → transcript mtime, for EVERY indexed session — live ones
   * included, same universe as chainFacts(). scan() already statSync's every
   * live transcript on each pass (a live session's facts are skipped, but its
   * `endedAt` — the file mtime — is always current), so this is a lookup over
   * data already collected rather than a new filesystem pass.
   */
  transcriptMtimes(): Map<string, number> {
    const out = new Map<string, number>();
    for (const s of this.last) out.set(s.sessionId, s.endedAt);
    return out;
  }

  hasIndexed(): boolean {
    return this.lastOk;
  }

  scan(opts?: ArchiveScanOptions): ArchiveResult {
    const started = Date.now();
    const liveIds = opts?.liveIds ?? new Set<string>();
    const dir = opts?.projectsDir ?? this.projectsDir;

    let subdirs: string[];
    try {
      subdirs = fs.readdirSync(dir);
    } catch (err) {
      // No ~/.claude/projects yet, or unreadable. Not an error worth shouting
      // about — the tree simply stays live-only.
      const tookMs = Date.now() - started;
      this.lastOk = false;
      return {
        ok: false,
        sessions: this.last,
        tookMs,
        scanned: 0,
        reread: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // (root, subdir) pairs across every readable root. The primary root's
    // failure semantics above are untouched — it aborts the scan the way it
    // always has — while an extra root only ever ADDS pairs.
    const pairs: Array<{ root: string; sub: string }> = subdirs.map((sub) => ({
      root: dir,
      sub,
    }));
    const seenRoots = new Set<string>([path.resolve(dir)]);
    for (const raw of opts?.extraProjectsDirs ?? []) {
      const extraRoot = typeof raw === 'string' ? raw.trim() : '';
      if (extraRoot === '' || seenRoots.has(path.resolve(extraRoot))) continue;
      seenRoots.add(path.resolve(extraRoot));
      try {
        for (const sub of fs.readdirSync(extraRoot)) {
          pairs.push({ root: extraRoot, sub });
        }
      } catch {
        continue; // a profile that never ran a session has no projects dir
      }
    }

    const nextCache = new Map<string, CacheEntry>();
    const sessions: ArchivedSession[] = [];
    let scanned = 0;
    let reread = 0;

    for (const { root, sub } of pairs) {
      const subPath = path.join(root, sub);
      let files: string[];
      try {
        files = fs.readdirSync(subPath);
      } catch {
        continue; // a file where a dir was expected, or EACCES
      }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const sessionId = file.slice(0, -'.jsonl'.length);
        if (!isSessionId(sessionId)) continue;
        // First occurrence wins; a session id is globally unique, but a stray
        // copy in two project dirs must not produce two rows.
        if (nextCache.has(sessionId)) continue;

        const full = path.join(subPath, file);
        let st: fs.Stats;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        scanned++;

        const live = liveIds.has(sessionId);
        const hit = this.cache.get(sessionId);
        if (
          hit &&
          hit.mtimeMs === st.mtimeMs &&
          hit.size === st.size &&
          hit.session.transcriptPath === full &&
          // A fact-less entry cached while the session was live is stale the
          // moment it stops being live, however unchanged the file is.
          !(hit.liveAtScan && !live)
        ) {
          nextCache.set(sessionId, hit);
          sessions.push(hit.session);
          continue;
        }

        // A live session's transcript is being appended to right now; its
        // label and cwd come from the roster, so skip the read entirely.
        const facts = live ? {} : readHeadFacts(full, sessionId);
        if (!live) reread++;

        // The continuation verdict. For a non-live file it falls out of the
        // read above; for a live file — whose facts read is skipped every
        // scan — it is worth ONE dedicated bounded head read, once per id,
        // because the head never changes after being written.
        let continuesId = this.chainVerdicts.get(sessionId);
        if (continuesId === undefined) {
          const verdictFacts = live ? readHeadFacts(full, sessionId) : facts;
          continuesId = continuationOf(sessionId, verdictFacts) ?? null;
          this.chainVerdicts.set(sessionId, continuesId);
        }

        const session: ArchivedSession = {
          sessionId,
          transcriptPath: full,
          endedAt: st.mtimeMs,
          bytes: st.size,
        };
        if (continuesId !== null) session.continuesId = continuesId;
        const startedAt =
          facts.firstTimestamp ??
          (Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0
            ? st.birthtimeMs
            : undefined);
        if (startedAt !== undefined) session.startedAt = startedAt;
        if (facts.cwd !== undefined) session.cwd = facts.cwd;
        if (facts.label !== undefined) session.label = facts.label;

        const entry: CacheEntry = {
          mtimeMs: st.mtimeMs,
          size: st.size,
          session,
          liveAtScan: live,
        };
        nextCache.set(sessionId, entry);
        sessions.push(session);
      }
    }

    this.cache = nextCache;
    this.last = sessions;
    this.lastOk = true;
    const tookMs = Date.now() - started;
    log(
      `archive: indexed ${sessions.length} transcripts in ${tookMs}ms ` +
        `(${reread} re-read)`,
    );
    return { ok: true, sessions, tookMs, scanned, reread };
  }

  /**
   * Chain-building facts for EVERY indexed transcript — live ones included,
   * unlike current(), whose live rows are display-fact-less. This is the
   * archive's contribution to buildChainIndex; mtime/bytes are the
   * tip-selection keys, and startedAt is where a chain's root age comes from.
   * All three come from the SAME sweep (scan(), above) that computes startedAt
   * unconditionally for every transcript, so coverage does not depend on
   * `lineage.showArchived` — buildChainIndex only ever sees the facts it is
   * handed, and a future caller that filters this list before passing it in
   * would silently degrade rootStartedAt to "unknown" for the excluded ids.
   */
  chainFacts(): GenerationFacts[] {
    const out: GenerationFacts[] = [];
    for (const s of this.last) {
      const fact: GenerationFacts = {
        sessionId: s.sessionId,
        mtimeMs: s.endedAt,
        bytes: s.bytes,
      };
      if (s.continuesId !== undefined) fact.continuesId = s.continuesId;
      if (s.startedAt !== undefined) fact.startedAt = s.startedAt;
      out.push(fact);
    }
    return out;
  }

  /** Drop the cache so the next scan re-reads every head. */
  invalidate(): void {
    this.cache = new Map();
    this.chainVerdicts = new Map();
  }

  dispose(): void {
    this.cache = new Map();
    this.chainVerdicts = new Map();
    this.last = [];
  }
}

/**
 * Archived sessions that are NOT currently live. This is what the forest wants:
 * a session present in the roster is a live node, and its archived twin would
 * be a duplicate row.
 */
export function archivedOnly(
  sessions: readonly ArchivedSession[],
  liveIds: ReadonlySet<string>,
): ArchivedSession[] {
  const out: ArchivedSession[] = [];
  for (const s of sessions) {
    if (!liveIds.has(s.sessionId)) out.push(s);
  }
  return out;
}

/**
 * Tree membership is editorial: every session with a non-deleted editorial
 * record keeps its row when its terminal closes — the row goes INACTIVE
 * (archived, resumable), it does not leave the tree. Only an explicit Delete
 * forgets it. A record is exactly the evidence that the session was ever the
 * user's: launched here, titled, stamped by a finished turn, parked by a
 * workspace switch — foreign history on disk has no record and stays behind
 * the `showArchived` gate.
 *
 * Ids are routed through `tipOf` so a record written against a superseded
 * generation id keeps the CONVERSATION's row — its chain tip — rather
 * than a row the collapse is about to drop.
 *
 * A CHAT record is the one kind of record that is explicitly NOT tree
 * membership. It is a scratch conversation about a project, filtered out of
 * the live forest by design; without this skip it would come straight back as
 * an inactive "closed" row the moment its tab shut, which is precisely the
 * row the feature exists to avoid.
 */
export function memberKeepIds(
  records: Record<string, EditorialRecord>,
  tipOf: (id: string) => string,
): Set<string> {
  const keep = new Set<string>();
  for (const record of Object.values(records)) {
    if (record.deleted === true || record.chat === true) continue;
    keep.add(record.id);
    keep.add(tipOf(record.id));
  }
  return keep;
}

/**
 * Which non-live archived sessions the forest should actually receive.
 *
 * `showArchived` is the user's "show me ALL history" switch — every transcript
 * on disk, record or not. With it off (the default), membership is editorial:
 * `keepIds` (see memberKeepIds) names the sessions whose rows persist.
 *
 * Pure and separate from the indexer so the rule is testable without a scan.
 */
export function keptArchived(
  sessions: readonly ArchivedSession[],
  liveIds: ReadonlySet<string>,
  opts: { showArchived: boolean; keepIds?: ReadonlySet<string> },
): ArchivedSession[] {
  const notLive = archivedOnly(sessions, liveIds);
  if (opts?.showArchived) return notLive;
  const keep = opts?.keepIds;
  if (!keep || keep.size === 0) return [];
  return notLive.filter((s) => keep.has(s.sessionId));
}

/**
 * Minimal RosterEntry shapes for resolveAll, which is keyed on RosterEntry but
 * only requires `sessionId`. Passing archived sessions through it resolves
 * their `forkedFrom` edges (the argv branch self-skips: no pid) AND stops their
 * live children from synthesizing a "(gone)" ghost for a parent we can now
 * render as a real, resumable row.
 */
export function archivedAsEntries(
  sessions: readonly ArchivedSession[],
): RosterEntry[] {
  const out: RosterEntry[] = [];
  for (const s of sessions) {
    const e: RosterEntry = { sessionId: s.sessionId };
    if (s.cwd !== undefined) e.cwd = s.cwd;
    if (s.startedAt !== undefined) e.startedAt = s.startedAt;
    out.push(e);
  }
  return out;
}

/** Best-effort human label for an archived session. */
export function archivedLabel(s: ArchivedSession): string {
  return s.label ?? shortId(s.sessionId);
}

/**
 * Every session this machine knows about that the tree is NOT showing — the
 * pool the Add Session and Import pickers offer. The other half of
 * `keptArchived`: that function decides what reaches the tree on its own, this
 * one lists what did not, so the user can bring it in by hand.
 *
 * Chain-collapsed to one entry per CONVERSATION, exactly as the tree is: a
 * live row lists under its tip, and a transcript that is merely a superseded
 * generation of some other file is skipped outright — importing it would mint
 * a row the next rebuild collapses away.
 *
 * Three exclusions, each a fact the caller already holds:
 *
 *   shown    `shownIds.has(tip)` — it has a row; there is nothing to add.
 *   deleted  the user took its row OFF on purpose; Restore Deleted Session…
 *            is the door back, and a second door that silently un-deletes
 *            would make Delete mean nothing.
 *   chat     a chat has no row by design, and offering to give it one would
 *            un-design that.
 *
 * Order: live rows first (they are the ones the user can see running
 * somewhere), then newest activity first — which is the order a person scans
 * "what was I doing" in.
 */
export function unlistedPool(input: {
  entries: readonly RosterEntry[];
  archived: readonly ArchivedSession[];
  records: Record<string, EditorialRecord>;
  tipOf(id: string): string;
  /** Every id the forest currently renders — live, archived and ghost alike. */
  shownIds: ReadonlySet<string>;
}): UnlistedSession[] {
  const { entries, archived, records, tipOf, shownIds } = input;
  // Deleted/chat is asked of both the physical id and its tip: a record can
  // sit on either end of a chain, and missing it on one would resurrect a
  // deleted conversation under its other name.
  const excluded = (id: string, tip: string): boolean => {
    for (const key of id === tip ? [id] : [id, tip]) {
      const record = records[key];
      if (record?.deleted === true || record?.chat === true) return true;
    }
    return false;
  };
  const seen = new Set<string>();
  const live: UnlistedSession[] = [];
  for (const e of entries) {
    const tip = tipOf(e.sessionId);
    if (seen.has(tip)) continue;
    seen.add(tip); // shown or excluded, the conversation is accounted for
    if (shownIds.has(tip) || shownIds.has(e.sessionId)) continue;
    if (excluded(e.sessionId, tip)) continue;
    const item: UnlistedSession = { sessionId: tip, live: true };
    if (e.cwd !== undefined) item.cwd = e.cwd;
    if (e.name !== undefined) item.label = e.name;
    live.push(item);
  }
  const gone: UnlistedSession[] = [];
  for (const a of archived) {
    const tip = tipOf(a.sessionId);
    // A superseded generation is not a conversation — its tip's own file (or
    // live row) represents the whole chain, and will be met on its own turn.
    if (tip !== a.sessionId) continue;
    if (seen.has(tip)) continue;
    seen.add(tip);
    if (shownIds.has(tip)) continue;
    if (excluded(a.sessionId, tip)) continue;
    const item: UnlistedSession = {
      sessionId: tip,
      live: false,
      endedAt: a.endedAt,
    };
    if (a.cwd !== undefined) item.cwd = a.cwd;
    if (a.label !== undefined) item.label = a.label;
    gone.push(item);
  }
  gone.sort((x, y) => (y.endedAt ?? 0) - (x.endedAt ?? 0));
  return [...live, ...gone];
}
