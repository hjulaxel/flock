// IMPLEMENTED BY: M18 — what the age column means, and the token column.
//
// Two facts that are only in the transcript's TAIL, and that nothing else in
// the extension had a source for:
//
//   lastPromptAt  when the USER last sent this session a request. The age
//                 column claimed to be this and was actually the transcript's
//                 mtime, which moves for every token Claude writes and for a
//                 resume that only reopened the tab. A session left running
//                 unattended therefore read as "now" forever, and the one
//                 number the tree exists to sort by was the one it got wrong.
//   tokens        the size of the conversation: the context the last assistant
//                 turn ran with (prompt + cache + output). NOT a running bill —
//                 a cumulative total would grow without bound while the thing
//                 you actually want to know is "is this session getting full".
//
// Imports allowed here: ./log, node:fs. NEVER import vscode — this is read by
// the same rebuild path as archive.ts and must stay unit-testable.
//
// Reads are BOUNDED and cached on (mtimeMs, size), the same discipline
// archive.ts uses: the tail is the last TAIL_MAX_BYTES of the file, so cost is
// flat in transcript size, and a file whose stat has not moved is never read
// twice. A live session's transcript does move, but only live sessions' do —
// in steady state that is a handful of files per rebuild.

import * as fs from 'node:fs';

import { logError } from './log';

/** How much of the tail to read. A turn is a user prompt followed by however
 *  many tool calls it takes, and the prompt has to still be inside the window
 *  when the turn ends — measured across the transcripts on this machine, 96 kB
 *  covers the last prompt on the overwhelming majority and the fallback for
 *  the rest (mtime) is exactly what the column showed before. Bigger windows
 *  buy very little and are paid for on every live session, every rebuild. */
export const TAIL_MAX_BYTES = 96 * 1024;

export interface TranscriptStats {
  /** Epoch ms of the last real user prompt seen in the tail. */
  lastPromptAt?: number;
  /** Context size of the last assistant turn, in tokens. */
  tokens?: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Read at most `maxBytes` from the END of a file.
 *
 * The first line of the window is almost always a fragment — the cut lands mid
 * record — and is dropped by the caller rather than repaired: a partial JSON
 * line cannot be parsed, and guessing at its contents is how a token count
 * becomes fiction. Invalid UTF-8 at the cut becomes U+FFFD, that line then
 * fails JSON.parse, and it is skipped by the same rule.
 */
function readTail(file: string, maxBytes: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (!Number.isFinite(size) || size <= 0) return '';
    const want = Math.min(size, maxBytes);
    const from = size - want;
    const buf = Buffer.alloc(want);
    const read = fs.readSync(fd, buf, 0, want, from);
    return buf.toString('utf-8', 0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * A `type: 'user'` line that is a REQUEST FROM THE PERSON, as opposed to the
 * three other things the CLI files under the same type:
 *
 *   - a tool RESULT, which carries `toolUseResult` and whose content is a
 *     `tool_result` block. These outnumber real prompts roughly 4:1 in a
 *     working session, and counting them is what would make an unattended
 *     agentic run look like someone was sitting there typing.
 *   - a `isMeta` line — the CLI's own injected preamble, not something anyone
 *     wrote.
 *   - a SIDECHAIN line: a sub-agent's conversation, spliced into the same
 *     file. The user did not send it; the orchestrator did.
 *
 * What is left is either a plain string content or a content array carrying at
 * least one `text` block, which is exactly what a typed prompt looks like.
 */
export function isUserPrompt(rec: Record<string, unknown>): boolean {
  if (rec['type'] !== 'user') return false;
  if (rec['toolUseResult'] !== undefined) return false;
  if (rec['isMeta'] === true) return false;
  if (rec['isSidechain'] === true) return false;
  const message = rec['message'];
  if (!isPlainObject(message)) return false;
  const content = message['content'];
  if (typeof content === 'string') return content.trim() !== '';
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) => isPlainObject(block) && block['type'] === 'text',
  );
}

/**
 * M24. The FIRST thing the person typed, for the chat-history picker.
 *
 * The mirror image of `readTailStats` and bounded the same way: a chat is
 * identified by how it opened ("why is the roster poll firing twice"), which is
 * the one line of a conversation that never changes and is always in the first
 * few kilobytes. The CLI writes its own preamble ahead of it — `isMeta` lines,
 * a `custom-title` header, the environment dump — and `isUserPrompt` is exactly
 * the filter that steps over all of it.
 *
 * Returns the raw text, newlines and all: trimming and truncation are the
 * caller's, because how much of it fits depends on what it is being drawn into.
 * `undefined` when the window holds no prompt — a conversation nobody has said
 * anything to yet, which is a perfectly ordinary state for a chat opened a
 * second ago.
 */
export function readFirstPrompt(
  file: string,
  maxBytes: number = HEAD_MAX_BYTES,
): string | undefined {
  let text: string;
  try {
    text = readHead(file, maxBytes);
  } catch {
    return undefined; // raced deletion / EACCES — no signal, not an error
  }
  if (text === '') return undefined;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.trim() === '') continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      // The LAST line of a head window is the truncated one, and a partial
      // record cannot be parsed. Every other failure is garbage in the middle
      // of a file, and skipping is what every other scan in this extension
      // does with one.
      continue;
    }
    if (!isPlainObject(rec) || !isUserPrompt(rec)) continue;
    const text = promptTextOf(rec);
    if (text !== undefined) return text;
  }
  return undefined;
}

/** How much of the head to read. Two orders of magnitude smaller than the tail
 *  window because the target is at a KNOWN end of the file: the opening prompt
 *  sits behind the CLI's preamble and nothing else, and a transcript whose
 *  first 16 kB is all preamble is one whose first prompt is a paste this list
 *  could not show anyway. */
export const HEAD_MAX_BYTES = 16 * 1024;

/** Read at most `maxBytes` from the START of a file. The LAST line of the
 *  window is the fragment here (the mirror of readTail's first), and it is
 *  dropped by the same rule: it fails JSON.parse and the scan skips it. */
function readHead(file: string, maxBytes: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (!Number.isFinite(size) || size <= 0) return '';
    const want = Math.min(size, maxBytes);
    const buf = Buffer.alloc(want);
    const read = fs.readSync(fd, buf, 0, want, 0);
    return buf.toString('utf-8', 0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/** The text of a prompt record, in both shapes the CLI writes: a bare string,
 *  or a content array whose `text` blocks are joined. Blocks that are not text
 *  (an image, a pasted file reference) contribute nothing rather than a
 *  placeholder — "[object Object]" in a picker is worse than a short label. */
function promptTextOf(rec: Record<string, unknown>): string | undefined {
  const message = rec['message'];
  if (!isPlainObject(message)) return undefined;
  const content = message['content'];
  if (typeof content === 'string') {
    return content.trim() === '' ? undefined : content;
  }
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (!isPlainObject(block) || block['type'] !== 'text') continue;
    const text = block['text'];
    if (typeof text === 'string' && text.trim() !== '') parts.push(text);
  }
  return parts.length === 0 ? undefined : parts.join('\n');
}

/**
 * Context size for one assistant turn: everything the model was handed plus
 * everything it produced.
 *
 * `cache_read_input_tokens` is the bulk of it in any real session and leaving
 * it out is the classic mistake — a 280 k-token conversation reports "2
 * tokens" because only the uncached delta was counted. Every field is read
 * defensively and independently: the shape has gained keys before (server tool
 * use, per-iteration breakdowns) and a missing one must cost its own term, not
 * the whole number.
 */
export function contextTokensOf(usage: Record<string, unknown>): number {
  let total = 0;
  for (const key of [
    'input_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
    'output_tokens',
  ] as const) {
    const v = usage[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) total += v;
  }
  return total;
}

/**
 * Pull both facts out of a transcript's tail. Pure, bounded, never throws — a
 * transcript that cannot be read yields `{}` and every renderer falls back to
 * what it showed before this module existed.
 *
 * Both answers are the LAST occurrence in the window, and they are tracked
 * independently: a session mid-turn has a newer usage record than prompt, and
 * a session that has just been asked something has a newer prompt than usage.
 */
export function readTailStats(
  file: string,
  maxBytes: number = TAIL_MAX_BYTES,
): TranscriptStats {
  const out: TranscriptStats = {};
  let text: string;
  try {
    text = readTail(file, maxBytes);
  } catch {
    return out; // raced deletion / EACCES — no signal, not an error
  }
  if (text === '') return out;

  const lines = text.split('\n');
  // Drop the first line unless the window happens to start exactly at a record
  // boundary: when the read covered the WHOLE file there is nothing to cut.
  const from = text.length < maxBytes ? 0 : 1;
  for (let i = from; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.trim() === '') continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // partial write or garbage — skip, same rule as every other scan
    }
    if (!isPlainObject(rec)) continue;

    if (isUserPrompt(rec)) {
      const ts = rec['timestamp'];
      if (typeof ts === 'string' && ts !== '') {
        const parsed = Date.parse(ts);
        if (Number.isFinite(parsed)) out.lastPromptAt = parsed;
      }
    }

    const message = rec['message'];
    if (isPlainObject(message) && isPlainObject(message['usage'])) {
      const tokens = contextTokensOf(message['usage']);
      if (tokens > 0) out.tokens = tokens;
    }
  }
  return out;
}

interface StatsCacheEntry {
  mtimeMs: number;
  size: number;
  stats: TranscriptStats;
}

/**
 * `readTailStats` with archive.ts's cache discipline: keyed on (path, mtimeMs,
 * size), so a transcript nobody has written to since the last rebuild is never
 * re-read. The stat values are handed IN rather than taken here — the archive
 * indexer already stat'ed every transcript on its own sweep, and a second stat
 * per session per rebuild would be a filesystem pass bought for nothing.
 */
export class TranscriptStatsCache {
  private cache = new Map<string, StatsCacheEntry>();

  /** Empty stats — the honest answer — for anything unreadable. */
  get(
    sessionId: string,
    file: string,
    mtimeMs: number,
    size: number,
  ): TranscriptStats {
    const hit = this.cache.get(sessionId);
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.stats;
    let stats: TranscriptStats;
    try {
      stats = readTailStats(file);
    } catch (err) {
      logError('usage.readTailStats', err);
      stats = {};
    }
    this.cache.set(sessionId, { mtimeMs, size, stats });
    return stats;
  }

  /** Forget every id not in `keep`. Called with the ids the rebuild actually
   *  asked about, so the cache is bounded by what is on screen rather than by
   *  every transcript this window has ever rendered. */
  prune(keep: ReadonlySet<string>): void {
    if (this.cache.size <= keep.size) return;
    for (const id of [...this.cache.keys()]) {
      if (!keep.has(id)) this.cache.delete(id);
    }
  }

  dispose(): void {
    this.cache = new Map();
  }
}
