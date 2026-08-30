// src/forkNote.ts — the sentence a fork types into its parent's conversation.
//
// WHAT THIS IS NOT. It is not "the branches talking to each other". Flock has
// no session-to-session messaging and never has had: the in-session verbs
// channel (src/agentVerbs.ts) runs one way, session → extension, and carries
// exactly one verb; the only text that has ever travelled parent → child is
// the fork's OPENING PROMPT, handed to the new CLI as a positional argument
// once, at birth. What is built here is new construction on top of the single
// remaining extension → live-session channel, `sendTextToSession`, which the
// wrap verb already uses and which the codebase calls "the ONE remaining
// sendText in the whole extension". Nothing about this note should be read as
// extending a proven mechanism, because there was not one.
//
// WHAT THE CHANNEL COSTS, and why every rule below follows from it:
//
//   * It is KEYSTROKES. `terminal.sendText(text, true)` types the string into
//     the CLI's input and presses Enter, so the note becomes a real user turn
//     in the parent — it costs that conversation tokens and a reply. Hence the
//     cap: a note is a sentence, not a briefing.
//   * It is ONE LINE. sendText appends the newline itself, so an embedded \n
//     submits the message early and the remainder lands as a second turn.
//     test/commands.test.ts pins the same rule for WRAP_PROMPT.
//   * It reaches ONLY a terminal bound in THIS window. A parent that is
//     closed, hosted by another Flock window, running outside Flock, or parked
//     detached under the tmux grace has no binding here, and the note simply
//     does not happen. Those are the ordinary cases, not the edge cases, which
//     is why `forkNoteDeliverable` exists as its own testable predicate and
//     why the setting that turns this on is off by default.
//
// NOTHING IS QUEUED when the note cannot be delivered, and that is a decision
// rather than an omission. A mailbox would be a second lifecycle to get wrong
// — how long does an undelivered note live, does it fire when the parent is
// resumed six days later, into what turn — and the human already learns about
// the fork the way they always did, from the child's row nested under the
// parent's in the tree. The note is a courtesy to the MODEL, not the record.
//
// PURE and vscode-free, in the shape src/chatAutoClose.ts and
// src/compaction.ts established: this composes and decides, and the wiring in
// commands.ts does the typing. Composing a sentence is exactly the kind of
// string work that otherwise ends up reachable only through a registered
// command and a mock window, which is how this codebase has repeatedly ended
// up with untested text.

import type { SessionHost } from './hosts';

/**
 * How long a note into a live conversation may be.
 *
 * Four hundred characters is about three lines of terminal — enough to name
 * the branch and say what it is for, and short enough that the parent's reply
 * is not a summary of a paragraph it did not ask for. The number is a budget
 * on someone else's context window, so it is deliberately mean.
 */
export const MAX_FORK_NOTE_CHARS = 400;

/**
 * What the fork is FOR, in the user's own words, or nothing.
 *
 * The opening prompt is the only thing on a fork that a person actually typed
 * about its purpose, so it wins. A title is second and only when the caller
 * says it was NOT generated: `defaultForkTitle` mints names like `auth 3`, and
 * announcing that to the parent as the branch's purpose would dress a counter
 * up as an intention. When neither exists the honest answer is undefined, and
 * `composeForkNote` writes a shorter sentence rather than inventing a reason.
 */
export function forkPurposeOf(opts: {
  prompt?: string;
  title?: string;
  generatedTitle: boolean;
}): string | undefined {
  const prompt = collapse(opts.prompt ?? '');
  if (prompt !== '') return prompt;
  if (opts.generatedTitle) return undefined;
  const title = collapse(opts.title ?? '');
  return title === '' ? undefined : title;
}

/**
 * The one line a fork types into its parent.
 *
 * Addressed to the model, and phrased so that the model's correct response is
 * to note it and carry on: the parent has not changed, nothing has been asked
 * of it, and a branch is running elsewhere. The `[Flock]` prefix is there so
 * that a person reading the transcript later can tell at a glance that this
 * turn was typed by the extension rather than by them.
 *
 * The PURPOSE is what gets truncated when the whole thing will not fit, never
 * the branch's name: a note whose name is cut is unusable, where a note whose
 * reason is cut still says which branch to go and look at.
 */
export function composeForkNote(opts: {
  childLabel: string;
  purpose?: string;
}): string {
  const label = capped(collapse(opts.childLabel) || 'a new branch', 80);
  const head = `[Flock] A branch of this session was just forked, named "${label}".`;
  const tail = ' It is running separately; nothing here has changed.';
  const purpose = collapse(opts.purpose ?? '');
  if (purpose === '') return head + tail;
  // What is left for the reason once the fixed sentence is paid for — the two
  // halves plus the thirteen characters of ` It is for: ` and its full stop.
  // Below a dozen characters a truncated reason is noise, so the note drops it
  // whole rather than ending on an ellipsis that says nothing.
  const room = MAX_FORK_NOTE_CHARS - (head.length + tail.length + 13);
  if (room < 12) return head + tail;
  return `${head} It is for: ${capped(purpose, room)}.${tail}`;
}

/**
 * Can this parent be told at all?
 *
 * `here` and only `here`. The other three values of SessionHost each name a
 * real, ordinary state in which the extension has no terminal to type into —
 * `flock` is another window's tab or a parked wrap, `foreign` is a process
 * Flock never launched, `none` is a closed row — and in every one of them
 * `sendTextToSession` returns false. Asking this question up front is what
 * lets the caller log a reason a person can act on instead of reporting a
 * bare failure.
 */
export function forkNoteDeliverable(host: SessionHost): boolean {
  return host === 'here';
}

/** Whitespace collapsed to single spaces and trimmed — the shape the one-line
 *  channel requires, applied at composition time so no caller can forget. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Cut with an ellipsis, so that downstream cannot mistake the first N
 *  characters of a long reason for a short one.
 *
 *  The budget is counted in UTF-16 units, because that is what the terminal
 *  channel and the record both spend, but a cut that lands between the two
 *  halves of a surrogate pair leaves a lone high surrogate — an emoji sliced
 *  down the middle, which renders as a replacement glyph in the parent's
 *  conversation and on the row. Dropping that orphan is a character cheaper
 *  than the budget allows, which is the right way to be wrong here. The
 *  alternative of measuring in code points instead ([...s]) was rejected: the
 *  cap exists to bound what is TYPED, so it has to keep counting the units the
 *  channel counts, and it would still cut a grapheme cluster (a flag, a
 *  skin-tone sequence) in half without solving anything.
 *
 *  src/closeSummary.ts has the same four lines for the same reason. They are
 *  not shared: both modules are pure string composers that depend on nothing,
 *  and a module invented to hold one helper would be tidiness rather than
 *  structure — but the two must be changed together. */
function capped(s: string, max: number): string {
  if (max <= 1) return '';
  if (s.length <= max) return s;
  let cut = s.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}
