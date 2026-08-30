// src/closeSummary.ts — what "close with a summary" summarises, and who wrote it.
//
// THE COMPLAINT. Close with Summary used to open an input box and ask the
// PERSON to type the summary. That is a strange thing for a button on a
// branch to do: the conversation that just happened is the one thing on screen
// that already knows what it concluded, and the human is the party with the
// least of it in their head. What was wanted is what you would do by hand —
// compact the branch, and pass some of that up to the parent so it knows what
// happened.
//
// WHAT FLOCK CAN ACTUALLY DO, stated plainly, because the whole feature turns
// on it. Flock cannot ask a model for a summary; it has no API client and no
// way to speak to the CLI except by typing into its terminal. What it CAN do
// is type `/compact` — a slash command the Claude CLI interprets, which is
// exactly the property `forkAndCompact` already rests on — and then read back
// what the CLI wrote. That readback is a genuine model-written summary, not a
// scrape of the last exchange: the CLI files it as its own transcript record.
// So the honest description of the mechanism, and the one used in the setting
// text, the docs and the changelog, is: **Flock drives `/compact` and reads
// the summary the CLI wrote.** Nowhere is it called "an AI summary Flock
// generated", because Flock generated nothing.
//
// THE EVIDENCE this parser is built on, measured over every transcript under
// ~/.claude/projects on the machine this was written on (43 manual
// compactions). Each fact below changes what the code must do:
//
//   * 43 of 43 compactions wrote a `{"type":"user","isCompactSummary":true}`
//     record one line after the `compact_boundary` system record. So there IS
//     a machine-readable summary, and it is found by the flag, not by
//     position.
//   * Matching the boundary by SUBSTRING rather than by a parsed record yields
//     27 false positives on the same corpus, every one of them a tool_result
//     that had read this repository's own source. So every line is JSON.parse
//     -ed and judged on its parsed fields, never grepped.
//   * The body carries a byte-identical preamble in all 43 ("This session is
//     being continued from a previous conversation…" up to a `Summary:` line).
//     It is boilerplate about a continuation that is not happening here, so it
//     is stripped — but only when it is actually the documented preamble, so
//     that a summary whose own prose contains the word cannot be beheaded.
//   * Bodies ran 12,942 to 27,147 characters. That is why nothing here returns
//     an unbounded string to a caller: the record is capped before it is
//     written to state.json, and the parent's note is capped again, much
//     harder, before it is typed into a live conversation.
//   * 29 of 43 stayed in the SAME transcript file as an earlier compaction, so
//     a file can hold more than one summary. Without a `sinceMs` floor the
//     reader would happily present last Tuesday's compaction as this branch's
//     conclusion.
//
// PURE, in the shape src/usage.ts's parsing and src/chatAutoClose.ts's
// deciding established: string work over JSONL with no file IO and no vscode,
// so the wiring locates and reads the transcript and this decides what is in
// it. The failure mode is designed to be benign in every direction — a shape
// this does not recognise yields `undefined`, and the verb that called it
// closes nothing and says so.

import { COMPACTING_STALE_MS } from './compaction';
import { MAX_FORK_NOTE_CHARS } from './forkNote';
import type { CloseSummaryMode } from './types';

// The mode enum, its guard and its default live in src/types.ts beside the
// other settings' unions — types.ts imports nothing, deliberately, and is the
// root every module may depend on. Re-exported here so that a reader of the
// close flow finds the vocabulary where the behaviour is.
export type { CloseSummaryMode };
export { DEFAULT_CLOSE_SUMMARY_MODE, isCloseSummaryMode } from './types';

/**
 * How long to wait for the CLI to finish compacting before giving up.
 *
 * Ten minutes, and deliberately the same number as the compaction tracker's
 * stale ceiling: the purple ring on the row and this wait must agree about
 * when a compaction has hung, or the row says "still going" while the verb has
 * already declared it dead. Measured compactions on this machine took 96 to
 * 180 seconds (median 123), so this is a stuck-state ceiling and not a budget
 * — the ordinary exit is the summary arriving.
 */
export const COMPACT_SUMMARY_WAIT_MS = COMPACTING_STALE_MS;

/**
 * How much of the summary is written onto the session's record.
 *
 * The record is persisted in state.json and rendered in a hover; the row shows
 * the first eighty characters of it. A 27,000-character body verbatim would
 * put a small novel in the state file for every closed branch, and the hover
 * truncates it anyway. A thousand characters is roughly the first two
 * paragraphs of a compaction summary, which is the part that says what the
 * branch was doing.
 */
export const MAX_RECORDED_SUMMARY_CHARS = 1000;

/** The CLI's own boilerplate ahead of every compaction summary. Matched as a
 *  PREFIX, so a summary that merely discusses continuations keeps its text. */
const SUMMARY_PREAMBLE_PREFIX =
  'This session is being continued from a previous conversation';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The compaction summary in a transcript window, or undefined.
 *
 * `sinceMs`, when given, is a floor on the record's own timestamp: only a
 * summary written at or after the moment Flock asked for the compaction counts
 * as this close's answer. A record with no parsable timestamp is rejected
 * under a floor for the same reason — it cannot be shown to be new, and
 * guessing here means attributing an old conclusion to a branch that has
 * spent the last hour doing something else. With no floor the LAST summary in
 * the window wins, which is the right answer for "what did this conversation
 * most recently conclude".
 *
 * Every line is parsed and every parse failure is skipped in silence: the
 * window is a byte range off the end of a growing file, so its first line is
 * routinely a fragment, and a transcript being appended to while this reads
 * is the normal case rather than corruption.
 */
export function parseCompactSummary(
  text: string,
  sinceMs?: number,
): string | undefined {
  let best: string | undefined;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(rec)) continue;
    // The flag is read off the PARSED record, at the top level. This is the
    // whole defence against the 27 false positives: a tool result that has
    // read this file's own source contains the literal string
    // `isCompactSummary` inside its content and carries none of these fields.
    if (rec['type'] !== 'user') continue;
    if (rec['isCompactSummary'] !== true) continue;
    if (rec['toolUseResult'] !== undefined) continue;
    if (sinceMs !== undefined && Number.isFinite(sinceMs)) {
      const at = Date.parse(String(rec['timestamp'] ?? ''));
      if (!Number.isFinite(at) || at < sinceMs) continue;
    }
    const body = summaryTextOf(rec['message']);
    if (body !== undefined) best = body;
  }
  return best;
}

/**
 * The words out of an `isCompactSummary` record's message.
 *
 * Two shapes were observed and both are handled: a plain string, and the
 * content-block array whose `text` blocks are concatenated. A third shape
 * yields undefined rather than a coerced string — `String(someObject)` in a
 * parser like this is how "[object Object]" ends up recorded as a branch's
 * conclusion.
 */
function summaryTextOf(message: unknown): string | undefined {
  if (!isPlainObject(message)) return undefined;
  const content = message['content'];
  let raw: string | undefined;
  if (typeof content === 'string') raw = content;
  else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (
        isPlainObject(block) &&
        block['type'] === 'text' &&
        typeof block['text'] === 'string'
      ) {
        parts.push(block['text']);
      }
    }
    if (parts.length > 0) raw = parts.join('\n');
  }
  if (raw === undefined) return undefined;
  const stripped = stripPreamble(raw).trim();
  return stripped === '' ? undefined : stripped;
}

/** Drop the CLI's continuation boilerplate, and only that. The text has to
 *  BEGIN with the known preamble and the `Summary:` line has to be inside the
 *  first stretch of it; anything else is returned untouched, because a wrong
 *  strip silently deletes the top of the summary. */
function stripPreamble(raw: string): string {
  const head = raw.trimStart();
  if (!head.startsWith(SUMMARY_PREAMBLE_PREFIX)) return raw;
  const marker = head.indexOf('Summary:');
  if (marker < 0 || marker > 2000) return raw;
  return head.slice(marker + 'Summary:'.length);
}

/**
 * The summary as it is written onto the session's record.
 *
 * Collapsed to one line on purpose: the two places a recorded summary is
 * rendered are a tree row's description and a hover sentence, and neither
 * shows markdown structure. Keeping the newlines would only mean the row
 * truncating at the first heading.
 */
export function summaryForRecord(s: string): string {
  return capped(collapse(s), MAX_RECORDED_SUMMARY_CHARS);
}

/**
 * The summary as it is typed into the PARENT conversation.
 *
 * Capped at the fork note's budget and for the same reason: this is
 * keystrokes into a running conversation, so it costs the parent a turn and
 * the words cost it context. The branch's name leads, because the useful thing
 * for the parent is knowing which row this conclusion belongs to — the full
 * text is on that row's hover, one click away, and does not need to be spent
 * here.
 */
export function summaryForParentNote(s: string, childLabel: string): string {
  const label = capped(collapse(childLabel) || 'a branch', 80);
  const head = `[Flock] The branch "${label}" was closed. Its compaction summary begins: `;
  const room = MAX_FORK_NOTE_CHARS - head.length - 1;
  if (room < 12) return `${head}(too long to quote).`;
  return `${head}${capped(collapse(s), room)}`;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// Same shape as src/forkNote.ts's `capped`, and the trailing-high-surrogate
// drop is there for the same reason: the cap is counted in the UTF-16 units the
// terminal channel and state.json actually spend, but a cut that lands inside a
// surrogate pair leaves half an emoji, which shows as a replacement glyph in
// the parent's conversation and on the row's description forever after. The
// orphan is dropped rather than switching the whole function to code points,
// because the budget must keep counting what is typed. Two copies rather than a
// shared helper is deliberate: both modules are pure, vscode-free string
// composers with no dependency on each other, and a `text.ts` holding one
// four-line function would be a module invented for tidiness — but the two must
// be changed together, which is why each comment names the other.
function capped(s: string, max: number): string {
  if (max <= 1) return '';
  if (s.length <= max) return s;
  let cut = s.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}
