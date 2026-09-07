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
//   * It is REFUSED to a session Flock will not press Enter into — one that is
//     WAITING on a permission dialog, one whose provider cannot report a
//     dialog at all, and one whose CLI has exited leaving a bound login shell.
//     That rule is not enforced here and cannot be — see
//     `forkNoteDeliverable` — it lives in `mayTypeInto` (src/roster.ts) and is
//     applied where the channel is bound to the terminal registry
//     (src/extension.ts's `sendTextToSession`), immediately before the
//     keystroke, so it covers all four callers of the channel and any added
//     later. From here it shows up as the ordinary answer this module was
//     already built for: the note was not delivered.
//
//     "Immediately before" is code ORDER, not clock. The status it reads is a
//     roster snapshot up to one poll interval old (DEFAULT_POLL_INTERVAL_MS,
//     3 s, and older after a failed fetch, where the wiring keeps the last
//     good rows on purpose) — so a session that walked into a dialog within
//     the last few seconds still reads busy/idle and IS typed into. What the
//     placement buys is that all four callers are covered and that there is no
//     second, wider gap between an up-front check and the keystroke. The
//     sub-poll race stays open.
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
import type { SendTextOutcome } from './types';

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
 * `sendTextToSession` answers `'no-terminal'`. Asking this question up front
 * is what lets the caller log a reason a person can act on instead of
 * reporting a bare failure.
 *
 * WHAT IT DOES NOT ANSWER, deliberately: whether the parent may be typed into
 * RIGHT NOW. That is `mayTypeInto` (src/roster.ts) on the parent's roster
 * status, and it is a different question in three ways this predicate cannot
 * paper over. It asks a different fact — `HostFacts` carries `live` and, on
 * purpose, no `status`, and `CommandDeps` has no status accessor at all, so
 * the caller in commands.ts could not hand one over even if the signature took
 * it. It reads a different clock — a status is a snapshot from the last roster
 * tick, and a session can walk into a permission prompt between the check and
 * the keystroke, which is the same race this module's caller already logs when
 * a tab closes in that gap. And it protects something else — the host question
 * is about whether a note can be delivered, the status question is about
 * whether delivering it would ANSWER A DIALOG, which is not a courtesy that
 * may be paid a moment late. So the refusal is the last thing before the
 * keystroke, in the wiring, for every caller of the channel at once — which
 * covers all four callers but still reads a poll-old snapshot, so it narrows
 * that race rather than closing it (see the header). Read this predicate
 * accordingly: `true` means there is a terminal to type into, never that the
 * note will be typed.
 */
export function forkNoteDeliverable(host: SessionHost): boolean {
  return host === 'here';
}

/**
 * The sentence a caller shows when the channel refused — one per reason, and
 * each one ends in the thing the person can actually do.
 *
 * Here rather than at the four call sites because it is the same three
 * sentences in all of them, and because a refusal message is exactly the kind
 * of text this module exists to keep testable (see the header): the wrap
 * warning and the `/compact` warning had drifted into saying "no terminal in
 * this window" about a tab the user was looking at.
 *
 * `null` for the two outcomes a caller must word itself. `'sent'` needs no
 * sentence, and `'no-terminal'` is genuinely caller-specific — the wrap verb
 * names the foreign host, the fork note says nothing at all — so a shared
 * sentence there would be worse than none.
 */
export function sendRefusalSentence(
  outcome: SendTextOutcome,
  label: string,
): string | null {
  const name = collapse(label) || 'that session';
  switch (outcome) {
    case 'waiting':
      return `Flock: "${name}" is waiting for your answer — answer its prompt, then try again.`;
    // Named for what Flock cannot see rather than for what the session is
    // doing, because it does not know: a hook-less Codex row reads `busy`
    // whether or not a permission dialog is on screen.
    case 'blind':
      return `Flock cannot tell whether "${name}" is waiting for your approval, so it will not type into it — install the Codex hooks, or answer and quiet the session first.`;
    // Worded for what Flock OBSERVED — the row is absent — because the same
    // absence covers a session started seconds ago that has not registered
    // yet. Both answers are the same: do not type into it.
    case 'gone':
      return `Flock: "${name}" is not in the session roster — an exited CLI leaves its tab on a shell, so Flock will not type into it. Relaunch it from the Flock sidebar.`;
    default:
      return null;
  }
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
