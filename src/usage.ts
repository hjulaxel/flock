// src/usage.ts — what the age column means, and the token column.
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
// This module imports ./log and node:fs only, and never vscode: it is called
// from the same rebuild path as archive.ts and must stay unit-testable outside
// a workbench.
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

/** How much of the tail Close with Summary reads, looking for the CLI's own
 *  compaction summary.
 *
 *  Five hundred and twelve kilobytes, deliberately five times the window
 *  above, and the reason the two numbers differ is what they cost. The 96 kB
 *  window is paid on EVERY live session on EVERY rebuild and is sized for one
 *  turn; this one is paid once, on an explicit user verb, and has to contain a
 *  record whose body alone measured up to 27 kB on this machine with a
 *  conversation's worth of tool traffic appended after it. A summary is not
 *  worth putting on the rebuild's hot path — which is also why it is not a
 *  field of TranscriptStats — but it is worth a generous one-off read. */
export const SUMMARY_TAIL_MAX_BYTES = 512 * 1024;

export interface TranscriptStats {
  /** Epoch ms of the last real user prompt seen in the tail. */
  lastPromptAt?: number;
  /** Context size of the last assistant turn, in tokens. */
  tokens?: number;
  /** Epoch ms of the last REAL conversation record in the tail — any
   *  `user`/`assistant` line with a timestamp, tool results and sidechains
   *  included (a sub-agent writing is a session working). This is the idle
   *  clock the lifecycle sweep (src/idleClose.ts) runs on, and it exists
   *  because file MTIME is a liar here: hooks and last-prompt bookkeeping
   *  touch the transcript without appending conversation, so an mtime-fed
   *  timer keeps a long-abandoned session warm forever (measured on this
   *  machine — the spec forbids mtime as an idleness source). */
  lastRecordAt?: number;
  /**
   * Epoch ms of the last SIDECHAIN record in the tail — a line written by a
   * sub-agent rather than by the conversation itself.
   *
   * This is the only thing on the outside of a session that says work has
   * FANNED OUT: a workflow, a Task, an agent of any kind. From the roster the
   * session is `busy` and nothing more, exactly as it is for a one-line edit,
   * so a session with nine agents under it and one thinking about a typo are
   * the same amber dot — which is the gap this fills.
   *
   * FREE, and that is why it is here rather than anywhere else. This tail is
   * already read for every live session on every rebuild, `isSidechain` is
   * already inspected twice in the same loop (see lastExchange and
   * isUserPrompt, both of which SKIP sidechains for the opposite reason), and
   * this is one more assignment inside it. A signal worth a mark on a row is
   * not worth a second pass over the same bytes.
   *
   * A TIMESTAMP, NOT A BOOLEAN, because sidechain records do not expire out of
   * a transcript: every session that has ever used an agent has them somewhere
   * in its history, and "has ever" is not what a live mark may mean. The
   * freshness rule is the reader's — see lineage.SUBAGENT_FRESH_MS, which
   * compares this against `lastRecordAt` rather than against the wall clock,
   * so a machine whose clock disagrees with the transcript's cannot make a
   * session look busy with agents that finished yesterday.
   */
  sidechainAt?: number;
  /** The last conversation TEXT in the tail: the final assistant reply when
   *  the window holds one, else the last real user prompt. This is what an
   *  archived row shows when no close-with-summary was recorded — level 2
   *  exists to answer "what did that branch conclude?" without resuming, and
   *  the conclusion is the last thing said, not the last time something was.
   *  Sidechains are skipped for the same reason isUserPrompt skips them: a
   *  sub-agent's words are not the conversation's. Bounded to
   *  LAST_EXCHANGE_MAX_CHARS at capture — this is a fact for a one-line
   *  description and a hover, and an unbounded string would ride every
   *  rebuild's stats map for nothing. */
  lastExchange?: string;
}

/** How much of the last exchange to keep. Enough for a hover to say what the
 *  session concluded; the row itself truncates much harder (a rendering
 *  decision, so it lives in viewmodel.ts). Cut text gets a '…' HERE, because
 *  downstream cannot tell a 400-char answer from the first 400 chars of a
 *  longer one. */
export const LAST_EXCHANGE_MAX_CHARS = 400;

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
 *
 * Exported because the compaction-summary read (src/closeSummary.ts, wired in
 * extension.ts) needs exactly this discipline over exactly these files, and a
 * second copy of a bounded tail reader is a thing that drifts: the day one of
 * them learns about a new encoding case and the other does not is the day two
 * readers of one transcript disagree. It throws on a missing file, like every
 * fs call here — callers wrap.
 */
export function readTranscriptTail(file: string, maxBytes: number): string {
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
 * The FIRST thing the person typed, for the chat-history picker.
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
 *  placeholder — "[object Object]" in a picker is worse than a short label.
 *
 *  Exported for archive.ts's head scan, which needs the opening prompt out of
 *  records it is ALREADY parsing for `cwd` and the title. Calling
 *  `readFirstPrompt` from there would mean a second bounded read of every
 *  transcript on the index path; reusing this and `isUserPrompt` is also what
 *  stops a second copy of "what counts as something a person typed" existing. */
export function promptTextOf(rec: Record<string, unknown>): string | undefined {
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
    text = readTranscriptTail(file, maxBytes);
  } catch {
    return out; // raced deletion / EACCES — no signal, not an error
  }
  if (text === '') return out;

  // The two candidates for lastExchange, tracked separately so the verdict at
  // the end can prefer the assistant's reply over a prompt that came after it:
  // an unanswered "also fix X" typed just before closing is not what the
  // session concluded — the answer above it is.
  let lastAssistantText: string | undefined;
  let lastPromptText: string | undefined;

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
      const prompt = promptTextOf(rec);
      if (prompt !== undefined) lastPromptText = prompt;
    }

    // The assistant half of lastExchange. promptTextOf reads message.content
    // text blocks, which is the same shape assistant lines carry — a turn that
    // was all tool calls has no text block and contributes nothing, exactly
    // right for "what did it conclude". Sidechains are a sub-agent's words.
    if (rec['type'] === 'assistant' && rec['isSidechain'] !== true) {
      const reply = promptTextOf(rec);
      if (reply !== undefined) lastAssistantText = reply;
    }

    // The idle clock: any real conversation record moves it (see the field's
    // doc above) — but never a `system`/`summary`/hook line, which is exactly
    // the traffic that made mtime unusable.
    if (rec['type'] === 'user' || rec['type'] === 'assistant') {
      const ts = rec['timestamp'];
      if (typeof ts === 'string' && ts !== '') {
        const parsed = Date.parse(ts);
        if (Number.isFinite(parsed)) out.lastRecordAt = parsed;
        // The same records, asked one more question: was this one written by a
        // SUB-AGENT? Set here rather than in a branch of its own so the two
        // clocks are read off exactly the same lines — `sidechainAt` is only
        // ever meaningful relative to `lastRecordAt`, and a field that could
        // advance on a line the other ignored would make that comparison a
        // lie.
        if (rec['isSidechain'] === true && Number.isFinite(parsed)) {
          out.sidechainAt = parsed;
        }
      }
    }

    const message = rec['message'];
    if (isPlainObject(message) && isPlainObject(message['usage'])) {
      const tokens = contextTokensOf(message['usage']);
      if (tokens > 0) out.tokens = tokens;
    }
  }

  const exchange = lastAssistantText ?? lastPromptText;
  if (exchange !== undefined) {
    const trimmed = exchange.trim();
    if (trimmed !== '') {
      out.lastExchange =
        trimmed.length > LAST_EXCHANGE_MAX_CHARS
          ? trimmed.slice(0, LAST_EXCHANGE_MAX_CHARS - 1) + '…'
          : trimmed;
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
    for (const id of [...this.cache.keys()]) {
      if (!keep.has(id)) this.cache.delete(id);
    }
  }

  dispose(): void {
    this.cache = new Map();
  }
}
