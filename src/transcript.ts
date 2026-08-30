// src/transcript.ts — locating and reading session transcripts under
// ~/.claude/projects. Direct port of the Python `transcript_file` /
// `has_transcript` / `fork_parent_from_transcript` of the prototype this
// extension replaced.
//
// Dependencies are deliberately minimal — ./types, ./log and node builtins,
// never vscode — so this module stays unit-testable outside the editor. It
// never caches and never watches files.
//
// Reads are BOUNDED: a transcript is an append-only JSONL that can reach tens
// of megabytes, and this runs on every poll tick. The head scan reads at most
// HEAD_SCAN_MAX_BYTES from the front; only the deep scan (rare, double-gated
// by the resolver) reads the whole file, and only up to DEEP_SCAN_MAX_BYTES —
// past that it skips rather than read. Every line is parsed inside its own
// try/catch because the last line of a live transcript is routinely a partial
// write, and fixtures like malformed.jsonl prove garbage lines occur.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { log, logError } from './log';
import {
  FORK_HEAD_LINES,
  HEAD_SCAN_MAX_BYTES,
  type TranscriptHeaderMeta,
} from './types';

/** The deep scan reads the whole file, and a deep scan that yields null repeats
 *  on the resolver's negative TTL for as long as the forking process lives, so
 *  the file it re-reads keeps growing. Above this cap we skip the scan rather
 *  than truncate the read: rule (3) needs the LAST snake/camel mismatch, so a
 *  truncated read could name an ancestor instead of the parent. */
const DEEP_SCAN_MAX_BYTES = 16 * 1024 * 1024;

export interface TranscriptLocateOptions {
  hint?: string;        // e.g. a hook payload's transcript_path
  projectsDir?: string; // default path.join(os.homedir(), '.claude', 'projects')
  /** Account-profile projects roots (`<configDir>/projects`), probed after the
   *  primary — a session launched on a custom account writes its transcript
   *  there, and "has no transcript" gates resume and fork. Every one of them is
   *  probed, and order no longer decides an id that resolves twice: see
   *  `transcriptCopyWins`. */
  extraProjectsDirs?: readonly string[];
}

export interface ScanOptions extends TranscriptLocateOptions {
  deep?: boolean;       // default false
}

function defaultProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * `stat`, or null.
 *
 * `throwIfNoEntry: false` rather than a try/catch around the miss, and the
 * difference is not stylistic: the probe below stats every project subdirectory
 * under every root until it finds the id, so on a machine with 38 projects 37
 * of those stats are misses. A thrown-and-caught ENOENT captures a stack on
 * each one, and this function runs on every poll tick — measured, resolving an
 * id that is nowhere went from 0.319 ms to 0.110 ms on nothing but this. The
 * try/catch stays anyway for the errors `throwIfNoEntry` does NOT suppress
 * (EACCES on a directory the user cannot read, ELOOP on a symlink cycle), which
 * must still be silent here.
 */
function statOf(p: string): fs.Stats | null {
  try {
    return fs.statSync(p, { throwIfNoEntry: false }) ?? null;
  } catch {
    return null; // EACCES / ELOOP / broken symlink — fail silent
  }
}

function isFile(p: string): boolean {
  return statOf(p)?.isFile() === true;
}

/** One located copy of a session's transcript. `size` and `mtimeMs` are the two
 *  facts `transcriptCopyWins` decides on; nothing here reads the file. */
export interface TranscriptCopyStat {
  mtimeMs: number;
  size: number;
}

/**
 * WHEN ONE SESSION ID RESOLVES TWICE, which copy is the conversation?
 *
 * `accountMove`'s invariant says this cannot happen — exactly one
 * `<id>.jsonl` per machine — and on the author's own machine it happens three
 * times.
 * The mechanisms are real and none of them is exotic: a tmux pane that kept a
 * stale `CLAUDE_CONFIG_DIR` and wrote the next turn into the account the
 * conversation had just left, a half-finished move from an older build, a
 * hand-copied config directory. So the resolver needs a rule for it, and until
 * this function existed the rule was an accident: first root in roster order
 * won, which meant a nine-line metadata stub written by a stray hook beat a
 * 12 MB conversation because its account happened to sort first. Two of the
 * user's real conversations were being drawn from the stub — no cwd, no first
 * prompt, no turns.
 *
 * NEWEST MTIME IS THE PRIMARY KEY, and size is only the tie-break. Size is the
 * tempting rule and it is the wrong one: it is a proxy for "has more
 * conversation in it", and it gets the one case that matters backwards — a
 * transcript the CLI rewrote shorter (a compaction boundary, a truncated tail
 * repaired on resume) is the CURRENT file and would lose to a stale fat one.
 * Whichever copy was written to last is the one a resume would have continued.
 *
 * Returns true when `candidate` should displace `incumbent`. Deliberately
 * false on a total tie, so scan order still decides and the answer stays
 * stable across two calls on an unchanged disk.
 */
export function transcriptCopyWins(
  candidate: TranscriptCopyStat,
  incumbent: TranscriptCopyStat,
): boolean {
  if (candidate.mtimeMs !== incumbent.mtimeMs) {
    return candidate.mtimeMs > incumbent.mtimeMs;
  }
  return candidate.size > incumbent.size;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Port of Python `transcript_file`: an existing `hint` wins; otherwise probe
 * <projectsDir>/<project>/<sessionId>.jsonl. Any IO error -> null.
 *
 * FIRST HIT WINS WITHIN A ROOT, and the best copy wins ACROSS roots. Inside one
 * account a duplicate id is impossible — a config dir is one CLI's history
 * store and it names its files after the session — so the subdirectory loop
 * still stops at its first hit, which is where the cost is. Across roots it
 * cannot stop: two accounts CAN hold the same id (see `transcriptCopyWins` for
 * how, and for why the old first-root-wins rule was reading a metadata stub
 * instead of a 12 MB conversation), so every root is probed and the copies are
 * compared.
 *
 * WHAT THAT COSTS, since this runs on every poll tick, measured on the machine
 * this was written on (38 projects in the primary root, three roots configured,
 * 200 calls averaged): a hit that used to be found in the first root went from
 * 0.025 ms to 0.073 ms, because it now walks the other two as well; a total miss
 * went the other way, from 0.319 ms to 0.110 ms, because `statOf` stopped
 * throwing an ENOENT on each of the ~37 candidates it rejects per root. A miss
 * is what every session that has not taken a turn yet costs, so the two changes
 * roughly pay for each other across a sweep — and 0.073 ms is not a number worth
 * trading correctness for.
 *
 * The rejected alternative was caching the resolution, which this module has
 * promised never to do since it was written: a transcript appears, moves between
 * accounts and is renamed under us, and a stale entry here is a resume that
 * finds nothing.
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
  let best: string | null = null;
  let bestStat: TranscriptCopyStat | null = null;
  const discarded: string[] = [];
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
      const st = statOf(candidate);
      if (st === null || !st.isFile()) continue;
      if (bestStat === null || transcriptCopyWins(st, bestStat)) {
        if (best !== null) discarded.push(best);
        best = candidate;
        bestStat = st;
      } else {
        discarded.push(candidate);
      }
      break; // one root, one copy: see the header above
    }
  }
  if (discarded.length > 0) announceDuplicate(sessionId, best, discarded);
  return best;
}

/** Ids already reported as duplicated, so the resolution above is announced
 *  ONCE rather than on every poll tick. Not a cache of the answer — this module
 *  promises never to cache that, because a transcript can be renamed under us
 *  between two ticks — only a record of what has already been said. A duplicate
 *  that is healed and then recurs therefore goes unannounced the second time,
 *  which is the right trade against a log line every few seconds forever. */
const announcedDuplicates = new Set<string>();

function announceDuplicate(
  sessionId: string,
  kept: string | null,
  discarded: readonly string[],
): void {
  if (announcedDuplicates.has(sessionId)) return;
  announcedDuplicates.add(sessionId);
  log(
    'transcript:',
    sessionId,
    'resolves in more than one account — reading',
    kept ?? '(none)',
    'and ignoring',
    discarded.join(', '),
  );
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
 * load-bearing:
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
 *     Branch 3 is NOT stale, and it is the branch that carries every fork Flock
 *     makes, so it is worth confirming rather than assuming. Re-verified on a
 *     2.1.229 Flock fork: child 46ce37ae copied 371 of parent 0079b373's 379
 *     message records, all 371 rewritten to `sessionId: 46ce37ae…`, and 363 of
 *     them still carrying `session_id: 0079b373…` underneath. Zero of the 153
 *     Flock parent/child pairs on this machine carry a forkedFrom marker at
 *     all, across claude 2.1.207-2.1.248 — so for an interactive fork this
 *     branch is not a fallback, it is the only signal there is.
 *
 * Returns null — a graceful root, never a wrong edge — for a HEADLESS /
 * print-mode fork (`claude -p --resume P --fork-session`). On claude 2.1.218+
 * such a fork copies the parent's history into the child transcript but
 * rewrites EVERY line's `sessionId` to the child's own id and writes NO
 * `forkedFrom` and NO snake `session_id`, so no transcript-local signal
 * survives. Scope that to the headless run it was measured on: an INTERACTIVE
 * fork plainly does write the snake key (the 46ce37ae observation above), so
 * the two shapes differ and only the headless one is a lost edge. The one artefact that does survive — copied message `uuid`s — is
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

  if (deep) {
    let size: number;
    try {
      size = fs.statSync(tp).size;
    } catch (err) {
      logError(`transcript: unreadable (${tp})`, err);
      return null;
    }
    if (size > DEEP_SCAN_MAX_BYTES) {
      log('transcript: deep scan skipped, too large', tp, size);
      return null; // a lost edge, which this module already treats as acceptable
    }
  }

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
 * Deliberately non-load-bearing: these record shapes were never verified as
 * carefully as the lineage signals were, so each is read tolerantly across a
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
