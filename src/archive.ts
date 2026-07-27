// src/archive.ts — the history index (M1.5).
//
// `claude agents --json` is a LIVE registry: it lists running sessions only.
// Every session you close leaves the roster and, before this module existed,
// vanished from the tree entirely — on this machine that was 157 of 217
// sessions, including 11 carrying real `forkedFrom` edges the tree could not
// show. This module indexes ~/.claude/projects/*/<sessionId>.jsonl so a closed
// session becomes an ARCHIVED row: still in the tree, still in its lineage,
// and safe to `--resume` (nothing else holds the transcript open).
//
// Imports allowed here: ./types, ./log, node:fs, node:path, node:os.
// NEVER import vscode.
//
// Reads are BOUNDED and cached by (mtimeMs, size): a full cold scan of 217
// transcripts measured 0.20 s (0.9 ms each), and a warm re-scan only re-reads
// files whose stat changed. Never throws — a failed scan yields the previous
// index, and the tree degrades to live-only rather than breaking.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { log, logError } from './log';
import {
  ARCHIVE_HEAD_LINES,
  ARCHIVE_HEAD_MAX_BYTES,
  type ArchivedSession,
  type DisposableLike,
  type RosterEntry,
  isSessionId,
  shortId,
} from './types';

export interface ArchiveScanOptions {
  projectsDir?: string;
  /** Ids known to be live; they are indexed but flagged so callers can skip. */
  liveIds?: ReadonlySet<string>;
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
export function readHeadFacts(file: string): HeadFacts {
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
    if (
      out.label !== undefined &&
      out.cwd !== undefined &&
      out.firstTimestamp !== undefined
    ) {
      break; // everything we came for
    }
  }
  return out;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  session: ArchivedSession;
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

  constructor(projectsDir?: string) {
    this.projectsDir = projectsDir ?? defaultProjectsDir();
  }

  /** The most recent successful index. Empty until scan() has run once. */
  current(): ArchivedSession[] {
    return this.last;
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

    const nextCache = new Map<string, CacheEntry>();
    const sessions: ArchivedSession[] = [];
    let scanned = 0;
    let reread = 0;

    for (const sub of subdirs) {
      const subPath = path.join(dir, sub);
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

        const hit = this.cache.get(sessionId);
        if (
          hit &&
          hit.mtimeMs === st.mtimeMs &&
          hit.size === st.size &&
          hit.session.transcriptPath === full
        ) {
          nextCache.set(sessionId, hit);
          sessions.push(hit.session);
          continue;
        }

        // A live session's transcript is being appended to right now; its
        // label and cwd come from the roster, so skip the read entirely.
        const facts = liveIds.has(sessionId) ? {} : readHeadFacts(full);
        if (!liveIds.has(sessionId)) reread++;

        const session: ArchivedSession = {
          sessionId,
          transcriptPath: full,
          endedAt: st.mtimeMs,
          bytes: st.size,
        };
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

  /** Drop the cache so the next scan re-reads every head. */
  invalidate(): void {
    this.cache = new Map();
  }

  dispose(): void {
    this.cache = new Map();
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

export function logArchiveError(where: string, err: unknown): void {
  logError(`archive.${where}`, err);
}
