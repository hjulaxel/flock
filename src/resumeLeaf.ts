// src/resumeLeaf.ts — repair a transcript's RESUME LEAF before we `--resume`
// or `--fork-session` it.
//
// THE PROBLEM THIS FILE EXISTS TO FIX. A transcript is a DAG, not a list, so
// the CLI cannot just replay it from the top: it has to pick a leaf and walk
// `parentUuid` back from there. It picks that leaf from the `last-prompt`
// records the transcript carries — and only falls back to "the newest message"
// when there is no `last-prompt` leaf at all. Verified in claude 2.1.220:
//
//   let H = m$t(messages, m => leafUuids.has(m.uuid))
//           ?? (leafUuids.size === 0 && !clearedToEmpty
//                 ? m$t(messages, m => !m.isSidechain) : undefined)
//   let chain = jze(messages, H)          // walk parentUuid back from H
//
// `last-prompt` is written MID-TURN, in the metadata block next to `ai-title`
// / `mode` / `permission-mode`, and is not rewritten when the turn finishes.
// So a transcript whose final turn made two tool calls routinely ends with its
// recorded leaf pointing at the FIRST tool result — and everything the
// assistant said after that is unreachable. The sibling-recovery pass (`FBy`)
// pulls back the other blocks of that same assistant message, which is why the
// loss reads as "I only got the first part of the last message" rather than as
// a missing turn.
//
// Measured on this machine when the bug was found: 23 of 282 transcripts ended
// with a stale leaf, and a fork of one of them provably dropped the parent's
// final answer (child transcript contained the mid-turn tool result and not the
// text after it).
//
// THE FIX. Append one more `last-prompt` record naming the true tip. This is
// the CLI's own mechanism, used the way the CLI uses it, and it is append-only:
// nothing already in the transcript is rewritten or removed. Because the parse
// reduces `leafUuids` to the LAST leaf seen (unless `keepAllLeaves`), the
// appended record simply wins.
//
// Imports allowed here: ./types, ./log, ./transcript, node:fs.
// NEVER import vscode.
//
// This is the one module that WRITES into a transcript, so every gate below is
// load-bearing. It runs once per fork/resume click — never on a poll tick —
// which is what makes a full read affordable where transcript.ts must bound its
// scans.

import * as fs from 'node:fs';

import { log, logError } from './log';
import { transcriptFile, type TranscriptLocateOptions } from './transcript';
import { type ResumeLeafReport, shortId } from './types';

/** Transcripts above this are left alone. The cap is generous — the largest on
 *  the machine this was written against was 3.9 MB — and exists only so a
 *  pathological file cannot turn a click into a multi-second read. */
const REPAIR_MAX_BYTES = 64 * 1024 * 1024;

/** A transcript written to within this window is presumed to have a live writer
 *  mid-turn. We skip rather than append: the leaf would be mid-turn anyway, and
 *  this is the one case where our write could interleave with claude's. */
const QUIET_MS = 2_000;

interface MessageNode {
  uuid: string;
  parentUuid: string | null;
  type: string;
  timestamp: string;
  isSidechain: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Length of the `parentUuid` walk back from `from`, cycle-safe. Compared, not
 *  reported: the only question this answers is whether a candidate leaf reaches
 *  MORE of the conversation than the one already recorded. */
function chainLength(
  messages: ReadonlyMap<string, MessageNode>,
  from: string | undefined,
): number {
  if (from === undefined) return 0;
  const seen = new Set<string>();
  let cur = messages.get(from);
  while (cur !== undefined && !seen.has(cur.uuid)) {
    seen.add(cur.uuid);
    cur = cur.parentUuid !== null ? messages.get(cur.parentUuid) : undefined;
  }
  return seen.size;
}

/**
 * Make the transcript's recorded resume leaf name its actual tip, appending one
 * `last-prompt` record when — and only when — that strictly increases how much
 * of the conversation a `--resume` or `--fork-session` will see.
 *
 * The tip is restricted to a `user`/`assistant` record deliberately. One of the
 * CLI's two load paths selects with
 *
 *   m$t(messages, m => leafUuids.has(m.uuid) && (m.type === 'user' || m.type === 'assistant'))
 *
 * and, finding nothing, treats the transcript as having no conversation at all.
 * Naming a `system` or `attachment` uuid would therefore risk converting a
 * partial resume into a failed one. The trailing `turn_duration` / `away_summary`
 * records this skips are not conversation content, and the walk back from the
 * last real message passes through them anyway.
 *
 * Never throws. Every failure is a skip, and a skip leaves the transcript byte
 * for byte as it was — the caller launches exactly as it did before this module
 * existed.
 */
export function repairResumeLeaf(
  sessionId: string,
  opts?: TranscriptLocateOptions,
): ResumeLeafReport {
  const file = transcriptFile(sessionId, opts);
  if (file === null) return { repaired: false, skipped: 'no-transcript' };

  let size: number;
  let mtimeMs: number;
  try {
    const st = fs.statSync(file);
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    return { repaired: false, skipped: 'unreadable' };
  }
  if (size > REPAIR_MAX_BYTES) return { repaired: false, skipped: 'too-large' };
  // A live writer mid-turn. Not a correctness problem for the reader — claude
  // tolerates a malformed line — but our append is the only write here we could
  // interleave with, so it is not worth the risk for a leaf that is stale by
  // design until the turn ends.
  if (Date.now() - mtimeMs < QUIET_MS) {
    return { repaired: false, skipped: 'writing' };
  }

  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    logError(`resumeLeaf: unreadable (${file})`, err);
    return { repaired: false, skipped: 'unreadable' };
  }

  // Replays the parser's state machine (`HBe`) over the records that decide a
  // leaf, and nothing else.
  const messages = new Map<string, MessageNode>();
  let leaf: string | undefined;        // the surviving `last-prompt` leafUuid
  let cleared = false;                 // an explicit `leafUuid: null` — a /clear
  let ownSessionId: string | null = null;
  let lastPrompt: string | null = null;

  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line) as unknown;
    } catch {
      continue; // partial / malformed line — exactly what claude skips too
    }
    if (!isPlainObject(rec)) continue;
    const type = rec['type'];

    if (type === 'last-prompt') {
      const l = rec['leafUuid'];
      if (typeof l === 'string' && l.length > 0) {
        leaf = l;
        cleared = false;
      } else if (l === null && rec['explicit'] === true) {
        // `/clear` — the conversation is intentionally empty. Naming a tip here
        // would resurrect history the user deliberately dropped.
        cleared = true;
        leaf = undefined;
      }
      const p = rec['lastPrompt'];
      if (typeof p === 'string') lastPrompt = p;
      continue;
    }

    // A compaction boundary that preserved nothing resets the parse: records
    // before it are not part of the conversation any more, and neither is the
    // leaf that pointed into them.
    if (type === 'system' && rec['subtype'] === 'compact_boundary') {
      const meta = rec['compactMetadata'];
      const preserved =
        isPlainObject(meta) &&
        (Boolean(meta['preservedSegment']) || Boolean(meta['preservedMessages']));
      if (!preserved) {
        messages.clear();
        leaf = undefined;
        cleared = false;
      }
      continue;
    }

    const uuid = str(rec['uuid']);
    const timestamp = str(rec['timestamp']);
    if (uuid === null || timestamp === null) continue;
    if (typeof type !== 'string') continue;
    const parent = rec['parentUuid'];
    messages.set(uuid, {
      uuid,
      parentUuid: str(parent),
      type,
      timestamp,
      isSidechain: rec['isSidechain'] === true,
    });
    // The transcript's own idea of its session id. A generation re-mint leaves
    // the file named for one id and its records stamped with another, and the
    // record we append has to agree with the records around it.
    ownSessionId = str(rec['sessionId']) ?? ownSessionId;
  }

  if (cleared) return { repaired: false, skipped: 'cleared' };
  // No recorded leaf at all: the CLI's own fallback already picks the newest
  // message, which is the behaviour this module is trying to restore.
  if (leaf === undefined) return { repaired: false, skipped: 'no-leaf-record' };

  let tip: MessageNode | undefined;
  for (const m of messages.values()) {
    if (m.isSidechain) continue;
    if (m.type !== 'user' && m.type !== 'assistant') continue;
    if (tip === undefined || m.timestamp > tip.timestamp) tip = m;
  }
  if (tip === undefined) return { repaired: false, skipped: 'no-tip' };
  if (tip.uuid === leaf) {
    return { repaired: false, staleLeaf: leaf, tip: tip.uuid, skipped: 'already-tip' };
  }

  // NEVER MAKE IT WORSE. A tip whose walk reaches no further than the recorded
  // leaf's is not an improvement, and one that reaches less would be a
  // regression dressed as a fix.
  const gained = chainLength(messages, tip.uuid) - chainLength(messages, leaf);
  if (gained <= 0) {
    return { repaired: false, staleLeaf: leaf, tip: tip.uuid, skipped: 'no-gain' };
  }

  const record: Record<string, unknown> = { type: 'last-prompt' };
  if (lastPrompt !== null) record['lastPrompt'] = lastPrompt;
  record['leafUuid'] = tip.uuid;
  record['sessionId'] = ownSessionId ?? sessionId;

  try {
    // O_APPEND, one short line, one call: the write cannot land anywhere but
    // the end of the file, and claude skips a line it cannot parse.
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf-8');
  } catch (err) {
    logError(`resumeLeaf: append failed (${file})`, err);
    return { repaired: false, staleLeaf: leaf, tip: tip.uuid, skipped: 'write-failed' };
  }

  log(
    'resumeLeaf:',
    shortId(sessionId),
    `leaf ${shortId(leaf)} -> ${shortId(tip.uuid)}`,
    `(+${gained} records)`,
  );
  return { repaired: true, staleLeaf: leaf, tip: tip.uuid, gained };
}
