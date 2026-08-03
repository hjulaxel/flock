// IMPLEMENTED BY: A
// src/transcript.ts — locating and reading session transcripts under
// ~/.claude/projects. Public surface frozen by SPEC §4-A2. Direct port of the
// Python `transcript_file` / `has_transcript` / `fork_parent_from_transcript`
// of the prototype this extension replaced.
//
// Imports allowed here: ./types, ./log, node:fs, node:path, node:os.
// NEVER import vscode. Never cache, never watch files.
//
// Reads are BOUNDED: a transcript is an append-only JSONL that can reach tens
// of megabytes, and this runs on every poll tick. The head scan reads at most
// HEAD_SCAN_MAX_BYTES from the front; only the deep scan (rare, double-gated
// by the resolver) reads the whole file. Every line is parsed inside its own
// try/catch because the last line of a live transcript is routinely a partial
// write, and fixtures like malformed.jsonl prove garbage lines occur.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { logError } from './log';
import {
  FORK_HEAD_LINES,
  HEAD_SCAN_MAX_BYTES,
  type TranscriptHeaderMeta,
} from './types';

export interface TranscriptLocateOptions {
  hint?: string;        // e.g. a hook payload's transcript_path
  projectsDir?: string; // default path.join(os.homedir(), '.claude', 'projects')
  /** M22.3. Account-profile projects roots (`<configDir>/projects`), probed
   *  after the primary — a session launched on a custom account writes its
   *  transcript there, and "has no transcript" gates resume and fork. */
  extraProjectsDirs?: readonly string[];
}

export interface ScanOptions extends TranscriptLocateOptions {
  deep?: boolean;       // default false
}

function defaultProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false; // ENOENT / EACCES / broken symlink — fail silent
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Port of Python `transcript_file`: an existing `hint` wins; otherwise probe
 * <projectsDir>/<project>/<sessionId>.jsonl in readdir order, first hit wins.
 * Any IO error -> null.
 */
export function transcriptFile(
  sessionId: string,
  opts?: TranscriptLocateOptions,
): string | null {
  const hint = opts?.hint;
  if (typeof hint === 'string' && hint.length > 0 && isFile(hint)) {
    return hint;
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  // Defensive: sessionId is normally a validated uuid, but this function is
  // also reachable with hook-supplied ids. Never let one escape projectsDir.
  if (
    sessionId.includes('/') ||
    sessionId.includes('\\') ||
    sessionId.includes('\0') ||
    sessionId === '.' ||
    sessionId === '..'
  ) {
    return null;
  }

  const fileName = `${sessionId}.jsonl`;
  const roots = [
    opts?.projectsDir ?? defaultProjectsDir(),
    ...(opts?.extraProjectsDirs ?? []),
  ];
  const seen = new Set<string>();
  for (const raw of roots) {
    const root = typeof raw === 'string' ? raw.trim() : '';
    if (root === '' || seen.has(root)) continue;
    seen.add(root);
    let subdirs: string[];
    try {
      subdirs = fs.readdirSync(root);
    } catch {
      continue; // this root has no projects dir yet, or is unreadable
    }
    for (const sub of subdirs) {
      const candidate = path.join(root, sub, fileName);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** transcriptFile(...) !== null. A session can only be resumed/forked once
 *  Claude has lazily written its transcript. */
export function hasTranscript(
  sessionId: string,
  opts?: TranscriptLocateOptions,
): boolean {
  return transcriptFile(sessionId, opts) !== null;
}

/**
 * Epoch-ms mtime of the session's transcript, or null when none is located or
 * cannot be stat'd. One `stat`, no read — a freshness PROBE, not a scan: it
 * tells a session that is live-and-writing from one whose roster status has
 * frozen (see roster.destaleBusyStatus). Consistent with this module's "never
 * cache, never watch" contract — a single synchronous stat, exactly like
 * isFile above. Never throws.
 */
export function transcriptMtimeMs(
  sessionId: string,
  opts?: TranscriptLocateOptions,
): number | null {
  const tp = transcriptFile(sessionId, opts);
  if (tp === null) return null;
  try {
    const { mtimeMs } = fs.statSync(tp);
    return Number.isFinite(mtimeMs) ? mtimeMs : null;
  } catch {
    return null; // raced deletion / EACCES — no signal, not an error
  }
}

/**
 * Read at most `maxBytes` from the front of a file. Buffer.toString never
 * throws on invalid UTF-8 (a multi-byte character cut by the cap just becomes
 * U+FFFD, and that line then fails JSON.parse and is skipped).
 */
function readHead(file: string, maxBytes: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const want = Math.min(Number.isFinite(size) ? Math.max(size, 0) : maxBytes, maxBytes);
    if (want <= 0) return ''; // empty file — nothing to scan
    const buf = Buffer.alloc(want);
    const read = fs.readSync(fd, buf, 0, want, 0);
    return buf.toString('utf-8', 0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Infer a fork's parent session id from its transcript, or null.
 *
 * Synchronous port of Python `fork_parent_from_transcript`. A single pass over
 * the resolved transcript, in this priority order PER LINE — the ordering is
 * load-bearing (SPEC §5.4):
 *
 *  1. a compaction marker (`subtype: "compact_boundary"` or `isCompactSummary`)
 *     seen BEFORE any fork signal aborts the scan and yields null. A compaction
 *     successor copies its predecessor's history — foreign session ids and all
 *     — but is a continuation, not a fork. This ordering is exactly what
 *     distinguishes a fork that later compacted in place (forkedFrom on line 1,
 *     boundary far below → the fork wins because it is seen first) from a
 *     genuine compaction successor (boundary near the top, no forkedFrom above
 *     it → abort).
 *  2. `forkedFrom.sessionId` — the native in-app fork marker. Its FIRST
 *     occurrence is the immediate parent (deeper lines of a fork-of-fork carry
 *     ancestor values), so return on sight.
 *  3. deep only: the LAST line whose snake `session_id` disagrees with the
 *     camel `sessionId` names the parent of an interactive CLI `--fork-session`
 *     fork, which writes no forkedFrom. Double-gated by the caller (see
 *     LineageResolver) because true compaction successors produce the identical
 *     snake/camel signature.
 *
 * Returns null — a graceful root, never a wrong edge — for a HEADLESS /
 * print-mode fork (`claude -p --resume P --fork-session`). On claude 2.1.218+
 * such a fork copies the parent's history into the child transcript but
 * rewrites EVERY line's `sessionId` to the child's own id and writes NO
 * `forkedFrom` and NO snake `session_id`, so no transcript-local signal
 * survives. The one artefact that does survive — copied message `uuid`s — is
 * deliberately NOT used: sibling forks of the same parent copy identical uuids
 * (verified: child∩parent == child∩sibling == 12 uuids), so uuid-overlap
 * cannot tell a parent from a sibling and would mint a wrong edge.
 *
 * Pure and never raises: malformed lines are skipped, any IO error -> null.
 */
export function forkParentFromTranscript(
  sessionId: string,
  opts?: ScanOptions,
): string | null {
  const deep = opts?.deep === true;
  const tp = transcriptFile(sessionId, opts);
  if (tp === null) return null;

  let text: string;
  try {
    text = deep
      ? fs.readFileSync(tp, 'utf-8')
      : readHead(tp, HEAD_SCAN_MAX_BYTES);
  } catch (err) {
    logError(`transcript: unreadable (${tp})`, err);
    return null;
  }

  let candidate: string | null = null; // deep: last snake/camel mismatch
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!deep && i >= FORK_HEAD_LINES) break;
    const line = lines[i];
    if (!line) continue;

    let rec: unknown;
    try {
      rec = JSON.parse(line) as unknown;
    } catch {
      continue; // partial / malformed line — skip it
    }
    if (!isPlainObject(rec)) continue;

    // (1) compaction marker → abort, both modes.
    if (rec['subtype'] === 'compact_boundary' || Boolean(rec['isCompactSummary'])) {
      return null;
    }

    // (2) native fork marker → first one wins.
    const forkedFrom = rec['forkedFrom'];
    if (isPlainObject(forkedFrom)) {
      const parent = forkedFrom['sessionId'];
      if (typeof parent === 'string' && parent.length > 0 && parent !== sessionId) {
        return parent;
      }
    }

    // (3) deep only: keep overwriting; the LAST mismatch is the parent.
    if (deep) {
      const snake = rec['session_id'];
      const camel = rec['sessionId'];
      if (
        typeof snake === 'string' &&
        snake.length > 0 &&
        typeof camel === 'string' &&
        camel.length > 0 &&
        snake !== camel
      ) {
        candidate = snake;
      }
    }
  }
  return candidate;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Best-effort scan of the first FORK_HEAD_LINES parsed lines for display
 * metadata records (`custom-title`, `agent-color`, `agent-name`, `mode`).
 * Later records overwrite earlier ones. Always returns an object (possibly
 * empty). Never throws.
 *
 * Deliberately non-load-bearing (SPEC open question #2): these record shapes
 * were not re-verified for this build, so each is read tolerantly across a
 * couple of plausible key names and only ever feeds a LABEL FALLBACK — no
 * lineage decision depends on anything in here.
 */
export function readTranscriptHeader(
  sessionId: string,
  opts?: TranscriptLocateOptions,
): TranscriptHeaderMeta {
  const meta: TranscriptHeaderMeta = {};
  const tp = transcriptFile(sessionId, opts);
  if (tp === null) return meta;

  let text: string;
  try {
    text = readHead(tp, HEAD_SCAN_MAX_BYTES);
  } catch (err) {
    logError(`transcript: header read failed (${tp})`, err);
    return meta;
  }

  let parsedLines = 0;
  for (const line of text.split('\n')) {
    if (parsedLines >= FORK_HEAD_LINES) break;
    if (!line) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isPlainObject(rec)) continue;
    parsedLines++;

    switch (rec['type']) {
      case 'custom-title': {
        const v = firstNonEmptyString(rec['customTitle'], rec['title'], rec['value']);
        if (v !== undefined) meta.customTitle = v;
        break;
      }
      case 'agent-color': {
        const v = firstNonEmptyString(rec['agentColor'], rec['color'], rec['value']);
        if (v !== undefined) meta.agentColor = v;
        break;
      }
      case 'agent-name': {
        const v = firstNonEmptyString(rec['agentName'], rec['name'], rec['value']);
        if (v !== undefined) meta.agentName = v;
        break;
      }
      case 'mode': {
        const v = firstNonEmptyString(rec['mode'], rec['value']);
        if (v !== undefined) meta.mode = v;
        break;
      }
      default:
        break;
    }
  }
  return meta;
}
