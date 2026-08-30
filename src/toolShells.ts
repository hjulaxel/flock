// src/toolShells.ts — the commands CLAUDE runs, read out of the transcript.
//
// THE UNIT HERE IS ONE `Bash` TOOL CALL, not a terminal. That distinction is
// the whole file. A terminal is the pty Flock launched claude INTO — one per
// session, yours, long-lived. A shell in this file's sense is the `npm test`
// claude decided to run inside that session eleven seconds ago and has not
// come back from, and there are hundreds of those per conversation. The two
// were conflated by the first Shells view, which listed the former and called
// it a process list; this module is the latter.
//
// WHERE THE FACTS COME FROM, and why the transcript rather than `ps`:
//
//   ps      tells you a `node` and a `zsh` exist. It cannot tell you which
//           session asked for them, what the command was, whether claude is
//           still waiting on it, or what it exited with. A pid is not an
//           answer to "what is Claude running".
//   hooks   PreToolUse/PostToolUse would be instant, but hooks are opt-in
//           everywhere in this extension and nothing may require them (see
//           hooks.ts). A view that is empty unless you installed a plugin is
//           not a view.
//   the transcript is the one source that is always there, is written by the
//           CLI itself, covers sessions Flock never launched, and lands the
//           `tool_use` record while the command is STILL RUNNING. That last
//           property is what makes a live row possible at all, so it was
//           measured rather than assumed: sampling a transcript once a second
//           from inside a twenty-second command, the record appeared about
//           three seconds in and then sat unanswered for the remaining fifteen.
//
//           THE THREE SECONDS ARE THE HONEST CAVEAT. The record is not written
//           the instant the model emits the call, so a command that finishes
//           faster than the flush is never seen mid-flight — it appears on the
//           list already finished. Add the roster tick this view scans on and
//           the floor is around five seconds. That is a real limit and it is
//           also the harmless one: a command too quick to catch is a command
//           nobody needed to watch, and every command worth opening this view
//           for is a long one.
//
// The pairing rule the whole parse rests on: every `tool_use` eventually gets
// a `tool_result` carrying its id. Verified over 6 890 Bash calls across the
// transcripts on this machine — zero orphans, interruptions and denials
// included. So a `tool_use` with no result IS a command still executing, and
// that is a fact rather than an inference.
//
// READS ARE INCREMENTAL, not a fixed tail. usage.ts re-reads a 96 kB tail per
// rebuild and can afford to because the facts it wants are always in the last
// few records; this view wants a HISTORY, and a session that just printed 200 kB
// of test output would push every earlier command out of any tail worth
// re-reading on a timer. So each session is opened once at a bounded tail and
// thereafter only the bytes appended since the last look are parsed — steady
// state is a stat plus a few kB, and the history accumulates in memory instead
// of being re-derived. A transcript that SHRANK (a compaction rewrote it) is
// detected on size and re-seeded from the tail.
//
// No vscode import, every effect injectable through plain fs: the parser and
// the formatting are the interesting parts and the tests bite there.

import * as fs from 'node:fs';

import type { ContextToken } from './types';
import { logError } from './log';

// -------------------------------------------------------------- dimensions

/** How much of a transcript to read the FIRST time a session is seen.
 *
 *  256 kB, and the number is a history budget rather than a correctness one:
 *  everything the view must get right (what is running now) is in the last few
 *  records, and this window only decides how far back the list already reaches
 *  the moment you open it. Bigger is paid exactly once per session per window,
 *  but it is paid on the UI thread, and past a couple of hundred kilobytes it
 *  buys commands old enough that the transcript itself is the better place to
 *  look for them. */
export const SEED_TAIL_BYTES = 256 * 1024;

/** Never parse more than this in one incremental step. A session that wrote
 *  8 MB while the view was collapsed gets re-seeded from its tail instead —
 *  the alternative is a multi-megabyte parse on the tick where you expanded
 *  the view, to recover history the cap below would discard anyway. */
export const MAX_STEP_BYTES = 2 * 1024 * 1024;

/** Cap on a newline-less tail we are willing to hold between reads. A single
 *  transcript record can be large (a tool result with a lot of stdout in it),
 *  but not this large, and a file being written by something that is not the
 *  CLI must not grow our heap without bound. */
const MAX_PENDING_BYTES = 2 * 1024 * 1024;

/** How many runs to keep per session. Finished ones are dropped oldest-first
 *  when the list overflows; a RUNNING one is never dropped, whatever its age —
 *  the one row this view exists for cannot be evicted by history. */
export const MAX_RUNS_PER_SESSION = 60;

/** Commands are kept for the hover, and a hover is not a file viewer. A
 *  heredoc that writes a 40 kB script is a real and ordinary thing for Claude
 *  to run, and holding all of it on every row of a list that lives for the
 *  lifetime of the window is not. Cut text gets an ellipsis HERE, because a
 *  reader downstream cannot tell a short command from the start of a long one. */
export const MAX_COMMAND_CHARS = 2_000;

// -------------------------------------------------------------------- model

/**
 * How a run ended, or that it has not.
 *
 * `background` is deliberately NOT a terminal state and deliberately not
 * folded into `running`. A backgrounded command has handed claude its result
 * already (an id and an output path) and the conversation has moved on, so it
 * is not what the session is waiting on — but the process is still up, and it
 * is the single easiest thing in a Claude session to lose track of, which is
 * most of the reason this view exists. It gets its own word and its own glyph.
 *
 * `denied` is separated from `failed` for the same reason a 403 is not a 500:
 * nothing ran. A permission rule, a hook, or the user said no, and reading
 * that as "the script failed" sends you debugging a script that was never
 * started.
 */
export type ShellOutcome =
  | 'running'
  | 'background'
  | 'ok'
  | 'failed'
  | 'denied';

/** One `Bash` tool call. */
export interface ShellRun {
  /** The `tool_use` id (`toolu_…`). Unique per run and stable forever, which
   *  makes it the row's identity — a list that re-sorts as things finish must
   *  not make the workbench treat a moved row as a new one. */
  id: string;
  /** The conversation that ran it. */
  sessionId: string;
  /** The command, verbatim, bounded to MAX_COMMAND_CHARS. */
  command: string;
  /** Claude's own one-line summary of it ("Run the test suite"). Present on
   *  nearly every call, and it is what the row is NAMED with — a description
   *  written for a human beats the first 60 characters of a pipeline. */
  description?: string;
  /** Epoch ms the assistant asked for it. */
  startedAt: number;
  /** Epoch ms the result came back. Absent while `running`, and absent on
   *  `background` until its completion notice arrives — in both cases because
   *  the thing genuinely has not ended. */
  endedAt?: number;
  outcome: ShellOutcome;
  /** The exit code, when the result stated one. */
  exitCode?: number;
  /** Why it is not `ok`, in the CLI's own words, first line only: `Exit code
   *  1`, `The user doesn't want to proceed with this tool use.`. */
  reason?: string;
  /** Background runs: the CLI's task id, and the file its output is being
   *  written to. The file is the payoff — it is openable, and it is the only
   *  way to see what a detached command is doing without asking Claude. */
  backgroundId?: string;
  outputFile?: string;
  /** Run by a sub-agent rather than by the conversation itself. */
  sidechain?: true;
}

// -------------------------------------------------------------- formatting

/**
 * An elapsed time as this view reads it: `3s`, `45s`, `2m 10s`, `1h 4m`.
 *
 * SECONDS, unlike viewmodel.formatAge, and that is the point of having a
 * second formatter rather than reusing the tree's. `formatAge` answers "how
 * stale is this conversation" and floors everything under ninety seconds to
 * `now`, which is correct there and useless here: the overwhelming majority of
 * commands finish inside those ninety seconds, so every row would read `now`
 * and the one number the row exists to show would never move.
 *
 * The larger unit is always kept alongside the smaller one (`2m 10s`, not
 * `2m`) up to hours, because the question being asked of a running command is
 * "is this progressing or is it stuck", and that is answered by watching a
 * number change. Anything not a finite non-negative number renders as nothing.
 */
export function formatDuration(ms: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) {
    const rem = secs % 60;
    return rem === 0 ? `${mins}m` : `${mins}m ${rem}s`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const rem = mins % 60;
    return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
  }
  const days = Math.floor(hours / 24);
  const rem = hours % 24;
  return rem === 0 ? `${days}d` : `${days}d ${rem}h`;
}

/** True while the process is up: nothing has come back, or it was detached and
 *  its completion notice has not arrived. The two states the view pins to the
 *  top and keeps a clock on. */
export function isLive(run: ShellRun): boolean {
  return run.outcome === 'running' || run.outcome === 'background';
}

/**
 * How long this run has been going, or went on for.
 *
 * A live run measures against NOW, a finished one against the timestamp its
 * result carried. Returns NaN — never 0 — when the clock cannot answer, so a
 * caller renders nothing instead of claiming a command took no time.
 */
export function runElapsedMs(run: ShellRun, now: number): number {
  const from = run.startedAt;
  if (!Number.isFinite(from)) return Number.NaN;
  const to = isLive(run) ? now : run.endedAt;
  if (to === undefined || !Number.isFinite(to)) return Number.NaN;
  return Math.max(0, to - from);
}

/**
 * The row's NAME: Claude's own description of the command, else the command
 * itself on one line.
 *
 * Description first because it is prose somebody meant to be read — "Run the
 * test suite" against `npm test -- --reporter=dot 2>&1 | tail -40`. The
 * command is not lost: it is the row's second line (see `shellRunDetail`) and
 * the top of its hover, so nothing is hidden, it is only ranked.
 *
 * A command with no description collapses to one line, because a heredoc's
 * first line is `cat > file <<'EOF'` and its newlines would otherwise turn one
 * row into six.
 */
export function shellRunLabel(run: ShellRun, maxChars = 60): string {
  const described = (run.description ?? '').replace(/\s+/g, ' ').trim();
  const text = described !== '' ? described : oneLine(run.command);
  if (text === '') return 'shell';
  return truncate(text, maxChars);
}

/** The command on one line, whitespace collapsed — what the row shows next to
 *  its name and what a hover leads with. */
export function oneLine(command: string): string {
  return (command ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * The dim right-hand text: `12s · npm test`, `3m 4s · exit 1 · flock · ./deploy`.
 *
 * ORDERED BY WHAT MUST SURVIVE A NARROW SIDEBAR, because the workbench
 * truncates a description from the right. Elapsed time is first and is the
 * only field never dropped: every other fact here answers a question you ask
 * afterwards, and this one answers the question you opened the view with —
 * whether the thing Claude has been sitting on for four minutes is still
 * moving. Then how it went, then which conversation, then the command.
 *
 * The COMMAND comes last and only when the row is named something else. When
 * Claude wrote a description the row is titled with it, and the command is the
 * detail that fills the rest of the line and is the first thing to go when
 * there is no room; when Claude wrote no description the command is already
 * the row's name and repeating it here would be a line saying itself twice.
 *
 * The session's name is included only when given, so a window with one
 * conversation does not repeat it down the whole list, and a window running
 * three of them — which is what this extension is for — can still tell them
 * apart.
 */
export function shellRunDetail(input: {
  run: ShellRun;
  now: number;
  sessionLabel?: string;
  maxCommandChars?: number;
}): string {
  const { run, now } = input;
  const parts: string[] = [];
  const elapsed = formatDuration(runElapsedMs(run, now));
  if (elapsed !== '') parts.push(elapsed);
  if (run.outcome === 'background') parts.push('background');
  if (run.outcome === 'denied') parts.push('denied');
  if (run.outcome === 'failed') {
    parts.push(
      run.exitCode !== undefined && Number.isFinite(run.exitCode)
        ? `exit ${run.exitCode}`
        : 'failed',
    );
  }
  if (run.sidechain === true) parts.push('sub-agent');
  const label = (input.sessionLabel ?? '').trim();
  if (label !== '') parts.push(label);
  const described = (run.description ?? '').trim() !== '';
  if (described) {
    const command = truncate(oneLine(run.command), input.maxCommandChars ?? 48);
    if (command !== '') parts.push(command);
  }
  return parts.join(' · ');
}

/**
 * The hover: the command in full, then everything the row had to leave out.
 *
 * Plain text, not markdown, and for the same reason the accounts view escapes
 * and this one does not build markup at all: a command is the least trusted
 * string in the extension. It is written by a model, it routinely contains
 * backticks, pipes, angle brackets and heredocs, and there is no version of
 * "render it as markdown" that is worth the class of bug where a command
 * containing the wrong three characters rewrites the rest of the tooltip. The
 * command reads perfectly as plain text; that is the whole requirement.
 */
export function shellRunTooltip(input: {
  run: ShellRun;
  now: number;
  sessionLabel?: string;
  cwd?: string;
}): string {
  const { run, now } = input;
  const lines: string[] = [];
  lines.push(run.command === '' ? '(no command)' : run.command);
  lines.push('');
  lines.push(outcomeWord(run));
  if (run.reason !== undefined && run.reason !== '') lines.push(run.reason);
  const elapsed = formatDuration(runElapsedMs(run, now));
  if (elapsed !== '') {
    lines.push(isLive(run) ? `running for ${elapsed}` : `took ${elapsed}`);
  }
  if (run.description !== undefined && run.description !== '') {
    lines.push(run.description);
  }
  if (run.sidechain === true) lines.push('run by a sub-agent, not the conversation');
  if (input.sessionLabel !== undefined && input.sessionLabel !== '') {
    lines.push(`session ${input.sessionLabel}`);
  }
  if (input.cwd !== undefined && input.cwd !== '') lines.push(input.cwd);
  if (run.outputFile !== undefined && run.outputFile !== '') {
    // Named in full, because it is the actionable line in this hover: a
    // detached command's output is on disk and readable right now, without
    // interrupting the session to ask what it is doing.
    lines.push(`output → ${run.outputFile}`);
  }
  return lines.join('\n');
}

/** The outcome as a sentence, for the hover's second block. */
export function outcomeWord(run: ShellRun): string {
  switch (run.outcome) {
    case 'running':
      return 'running now — the session is waiting on it';
    case 'background':
      return 'running in the background — the session moved on';
    case 'ok':
      return 'finished';
    case 'denied':
      return 'never ran — permission refused';
    case 'failed':
    default:
      return 'failed';
  }
}

/**
 * The glyph.
 *
 * `loading~spin` on a running row, which the workbench animates: the one thing
 * on this view that changes on its own should look like it. Everything else is
 * a still, and the two failure glyphs are kept apart on purpose — `error` says
 * the script broke, `circle-slash` says it was refused and never started.
 */
export function shellRunIconId(run: ShellRun): string {
  switch (run.outcome) {
    case 'running':
      return 'loading~spin';
    case 'background':
      return 'server-process';
    case 'ok':
      return 'pass';
    case 'denied':
      return 'circle-slash';
    case 'failed':
    default:
      return 'error';
  }
}

/** `;shell;` plus the outcome, and `;background;` on a detached run so the
 *  menu can offer its output file. Wrapping semicolons through the repo's own
 *  token rule, so a `viewItem =~ /;ok;/` clause cannot half-match. */
export function shellRunTokens(run: ShellRun): ContextToken[] {
  const tokens: ContextToken[] = ['shell', run.outcome];
  if (isLive(run)) tokens.push('live');
  if (run.outputFile !== undefined && run.outputFile !== '') tokens.push('output');
  return tokens;
}

/**
 * LIVE RUNS FIRST, then finished, each newest first.
 *
 * The old terminal list argued against sorting by status, and it was right for
 * what it listed: a terminal is a stable thing you go and click, and a row
 * that jumps when its session goes busy is a row you cannot hit. Nothing here
 * is stable — a run is born, lives for eleven seconds and is history — so the
 * argument does not carry over, and the question the view is opened with is
 * "what is running", not "what ran". The move a finished command makes is one
 * step, from the bottom of the live group to the top of the finished group
 * directly beneath it.
 *
 * Ties break on id so the order is total: a turn that fires four commands in
 * parallel stamps them with the same millisecond, and they must not swap
 * places between repaints.
 */
export function sortShellRuns(runs: readonly ShellRun[]): ShellRun[] {
  return [...(runs ?? [])]
    .filter((r): r is ShellRun => !!r && typeof r.id === 'string' && r.id !== '')
    .sort((a, b) => {
      const al = isLive(a) ? 0 : 1;
      const bl = isLive(b) ? 0 : 1;
      if (al !== bl) return al - bl;
      const at = sortTime(a);
      const bt = sortTime(b);
      if (at !== bt) return bt - at; // newest first
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

function sortTime(run: ShellRun): number {
  const t = run.endedAt ?? run.startedAt;
  return Number.isFinite(t) ? t : 0;
}

// ----------------------------------------------------------------- parsing

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function truncate(text: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 1 || text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars - 1).trimEnd() + '…';
}

function epochOf(rec: Record<string, unknown>): number {
  const ts = rec['timestamp'];
  if (typeof ts !== 'string' || ts === '') return Number.NaN;
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** Text out of a message content field, which is a bare string on some records
 *  and a block array on others. Both shapes occur on `user` records in the
 *  same transcript. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') parts.push(block);
    else if (isRecord(block) && typeof block['text'] === 'string') {
      parts.push(block['text']);
    }
  }
  return parts.join('\n');
}

/** The blocks of `rec.message.content`, or none. */
function blocksOf(rec: Record<string, unknown>): Record<string, unknown>[] {
  const message = rec['message'];
  if (!isRecord(message)) return [];
  const content = message['content'];
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord);
}

/**
 * The `<task-notification>` block, from wherever this record keeps it.
 *
 * It has no single home, and all three shapes were found in transcripts on one
 * machine written by builds weeks apart:
 *
 *   type `queue-operation`  a top-level `content` string (twice — once to
 *                           enqueue the notice, once to remove it again)
 *   type `attachment`       `attachment.prompt`, with commandMode
 *                           `task-notification`
 *   type `user`             ordinary `message.content`, when the notice was
 *                           delivered straight into the turn
 *
 * Reading only the one the current CLI happens to write would leave every
 * backgrounded command on this view spinning forever the day that changes —
 * which is exactly the bug the first draft of this file had. So the notice is
 * looked for on every record and in every place it is known to live, and the
 * duplicates are made harmless by settling only a run that is still live.
 */
function notificationTextOf(rec: Record<string, unknown>): string {
  const direct = rec['content'];
  if (typeof direct === 'string' && direct.includes('<task-notification>')) {
    return direct;
  }
  const attachment = rec['attachment'];
  if (isRecord(attachment)) {
    const prompt = attachment['prompt'];
    if (typeof prompt === 'string' && prompt.includes('<task-notification>')) {
      return prompt;
    }
  }
  const message = rec['message'];
  if (isRecord(message)) {
    const text = textOf(message['content']);
    if (text.includes('<task-notification>')) return text;
  }
  return '';
}

/**
 * A refusal, not a failure. Three shapes, all of them real and all of them
 * meaning nothing was executed:
 *
 *   the permission classifier   "Permission for this action was denied…"
 *   the user, at the prompt     "The user doesn't want to proceed…"
 *   a hook or the harness       "<tool_use_error>Blocked: …"
 *
 * Matched on the CLI's wording, which is the only signal there is — the result
 * carries no machine-readable reason code. A wording change downgrades a
 * denial to a plain failure, which is a wrong word on a row rather than a
 * broken view, and is why nothing else keys on this.
 */
function looksDenied(text: string): boolean {
  return (
    /permission for this action was denied/i.test(text) ||
    /doesn['’]t want to proceed/i.test(text) ||
    /\bBlocked:/.test(text) ||
    /blocked by hook/i.test(text)
  );
}

/** `Exit code 1` → 1. Only ever read off the head of the result text, where
 *  the CLI puts it; a `Exit code 3` printed BY the command must not be
 *  mistaken for the command's own. */
function exitCodeOf(text: string): number | undefined {
  const m = /^(?:Error:\s*)?Exit code (\d+)/.exec(text.trimStart());
  if (!m) return undefined;
  const code = Number(m[1]);
  return Number.isInteger(code) ? code : undefined;
}

/** `Output is being written to: /path/x.output` — the CLI's own sentence, and
 *  the only place a foreground reader learns where a detached command's output
 *  went. The `<output-file>` of the later completion notice says the same
 *  thing; whichever arrives is taken.
 *
 *  The trailing full stop is TRIMMED, and it is not a nicety: the path sits
 *  mid-sentence ("…/bx1.output. You will be notified when it completes."), so
 *  a plain `\S+` captures `bx1.output.` and Open Output then points at a file
 *  that does not exist — for every background job, silently. A path ending in
 *  a sentence's punctuation is always the sentence's, never the path's. */
function outputFileOf(text: string): string | undefined {
  const m = /Output is being written to:\s*(\S+)/.exec(text);
  if (!m) return undefined;
  const file = m[1].replace(/[.,;:)\]]+$/, '');
  return file === '' ? undefined : file;
}

/** The first line of an error, for the hover. Bounded — a failing command's
 *  result is its entire stderr, and a row's hover wants the verdict. */
function reasonOf(text: string): string | undefined {
  const first = text.split('\n').find((l) => l.trim() !== '');
  if (first === undefined) return undefined;
  const trimmed = first.replace(/^<tool_use_error>/, '').trim();
  return trimmed === '' ? undefined : truncate(trimmed, 200);
}

/**
 * The parser's working set for one session: id → run, in arrival order.
 *
 * A Map rather than an array because the pairing is by id and a transcript
 * interleaves freely — a turn issues four commands and their four results come
 * back in whatever order they finish.
 */
export class ShellRunSet {
  private readonly runs = new Map<string, ShellRun>();
  /** backgroundTaskId → tool_use id, so a completion notice that names only
   *  the task can still find its run. */
  private readonly byTask = new Map<string, string>();

  constructor(private readonly sessionId: string) {}

  /** Newest-first, live first. */
  list(): ShellRun[] {
    return sortShellRuns([...this.runs.values()]);
  }

  size(): number {
    return this.runs.size;
  }

  /** Feed one transcript record. Unknown shapes are ignored, never fatal. */
  ingest(rec: Record<string, unknown>): void {
    const type = rec['type'];
    if (type === 'assistant') this.ingestAssistant(rec);
    else if (type === 'user') this.ingestUser(rec);
    // Checked on EVERY record, not just `user` ones — see notificationTextOf
    // for why the completion notice has no single home.
    this.ingestNotification(rec);
  }

  private ingestAssistant(rec: Record<string, unknown>): void {
    const at = epochOf(rec);
    for (const block of blocksOf(rec)) {
      if (block['type'] !== 'tool_use' || block['name'] !== 'Bash') continue;
      const id = block['id'];
      if (typeof id !== 'string' || id === '') continue;
      if (this.runs.has(id)) continue; // a re-read of the same record
      const input = isRecord(block['input']) ? block['input'] : {};
      const command = typeof input['command'] === 'string' ? input['command'] : '';
      const description =
        typeof input['description'] === 'string' && input['description'] !== ''
          ? input['description']
          : undefined;
      const run: ShellRun = {
        id,
        sessionId: this.sessionId,
        command: truncate(command, MAX_COMMAND_CHARS),
        startedAt: at,
        outcome: 'running',
        ...(description === undefined ? {} : { description }),
        ...(rec['isSidechain'] === true ? { sidechain: true as const } : {}),
      };
      this.runs.set(id, run);
    }
    this.trim();
  }

  private ingestUser(rec: Record<string, unknown>): void {
    const at = epochOf(rec);
    for (const block of blocksOf(rec)) {
      if (block['type'] !== 'tool_result') continue;
      const id = block['tool_use_id'];
      if (typeof id !== 'string') continue;
      const run = this.runs.get(id);
      // An orphan result is ordinary, not an error: the seed window starts
      // mid-conversation, so the first few results in it answer tool_use
      // records above the cut. Nothing to attach them to; drop them.
      if (run === undefined) continue;
      this.settle(run, rec, block, at);
    }
  }

  private settle(
    run: ShellRun,
    rec: Record<string, unknown>,
    block: Record<string, unknown>,
    at: number,
  ): void {
    const result = rec['toolUseResult'];
    const text =
      textOf(block['content']) || (typeof result === 'string' ? result : '');

    // A backgrounded command has NOT ended — this result only says it was
    // detached. Its end arrives later as a task notification, and until then
    // the row keeps counting.
    if (isRecord(result) && typeof result['backgroundTaskId'] === 'string') {
      const task = result['backgroundTaskId'];
      run.outcome = 'background';
      run.backgroundId = task;
      this.byTask.set(task, run.id);
      const file = outputFileOf(text);
      if (file !== undefined) run.outputFile = file;
      return;
    }

    run.endedAt = at;
    if (block['is_error'] === true) {
      run.outcome = looksDenied(text) ? 'denied' : 'failed';
      const code = exitCodeOf(text);
      if (code !== undefined) run.exitCode = code;
      const why = reasonOf(text);
      if (why !== undefined) run.reason = why;
      return;
    }
    if (isRecord(result) && result['interrupted'] === true) {
      run.outcome = 'failed';
      run.reason = 'interrupted';
      return;
    }
    run.outcome = 'ok';
    if (run.exitCode === undefined) run.exitCode = 0;
  }

  /**
   * `<task-notification>` — the only signal that a detached command is done.
   *
   * Matched on `<tool-use-id>` when it carries one (exact, and it always has
   * so far) and on `<task-id>` otherwise. The block is read with regexes
   * rather than parsed, because it is not JSON and never was: it is a
   * pseudo-XML notice the CLI injects into the conversation as ordinary text.
   *
   * Only a run that is still LIVE is settled, because the notice arrives
   * two or three times — the CLI records the enqueue, the removal and the
   * attachment separately, all carrying the same block — and the first arrival
   * is the one whose timestamp is the truth about when the command ended.
   */
  private ingestNotification(rec: Record<string, unknown>): void {
    const text = notificationTextOf(rec);
    if (text === '') return;
    const at = epochOf(rec);
    const useId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(text)?.[1]?.trim();
    const taskId = /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1]?.trim();
    const id =
      (useId !== undefined && this.runs.has(useId) ? useId : undefined) ??
      (taskId !== undefined ? this.byTask.get(taskId) : undefined);
    if (id === undefined) return;
    const run = this.runs.get(id);
    if (run === undefined || !isLive(run)) return;
    const status = /<status>([^<]+)<\/status>/.exec(text)?.[1]?.trim();
    run.endedAt = at;
    run.outcome = status === 'completed' ? 'ok' : 'failed';
    if (run.outcome === 'failed') {
      run.reason = status === undefined ? 'ended' : `background task ${status}`;
    }
    const file = /<output-file>([^<]+)<\/output-file>/.exec(text)?.[1]?.trim();
    if (file !== undefined && file !== '') run.outputFile = file;
  }

  /** Hold the cap by dropping the OLDEST FINISHED runs. A live one is never
   *  evicted: a background job started an hour ago and still going is exactly
   *  the row somebody opened this view to find, and letting sixty subsequent
   *  `git status` calls push it out would defeat the feature. */
  private trim(): void {
    if (this.runs.size <= MAX_RUNS_PER_SESSION) return;
    const finished = [...this.runs.values()]
      .filter((r) => !isLive(r))
      .sort((a, b) => sortTime(a) - sortTime(b));
    let over = this.runs.size - MAX_RUNS_PER_SESSION;
    for (const run of finished) {
      if (over <= 0) break;
      this.runs.delete(run.id);
      if (run.backgroundId !== undefined) this.byTask.delete(run.backgroundId);
      over--;
    }
  }
}

/**
 * Parse a block of transcript text into runs. Pure — this is what the tests
 * drive.
 *
 * `dropFirstLine` because a bounded tail almost always cuts mid-record: the
 * fragment cannot be parsed, and guessing at it is how a command list acquires
 * fiction. Every other unparseable line is skipped by the same rule, which is
 * also what makes a live transcript's half-written last line a non-event.
 */
export function parseShellRuns(
  text: string,
  sessionId: string,
  dropFirstLine = false,
): ShellRun[] {
  const set = new ShellRunSet(sessionId);
  feed(set, text, dropFirstLine);
  return set.list();
}

function feed(set: ShellRunSet, text: string, dropFirstLine: boolean): void {
  const lines = text.split('\n');
  for (let i = dropFirstLine ? 1 : 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.trim() === '') continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(rec)) continue;
    try {
      set.ingest(rec);
    } catch (err) {
      logError('toolShells.ingest', err);
    }
  }
}

// ----------------------------------------------------------------- tracking

interface SessionTail {
  file: string;
  /** Bytes of `file` already parsed. */
  offset: number;
  /** A trailing fragment with no newline yet — the CLI's last write landed
   *  mid-record and the rest is coming. */
  pending: string;
  set: ShellRunSet;
}

/** What a tracker needs to know about a session to read its shells. */
export interface ShellSessionRef {
  id: string;
  transcriptPath: string;
}

/**
 * The incremental reader: one tail position per session, runs accumulated
 * across ticks.
 *
 * The alternative — re-read a fixed tail every tick, the way usage.ts does —
 * was measured against what this view actually needs and fails it in both
 * directions. It costs a full window parse per live session per repaint, and
 * it still cannot show a history longer than the window, so a session that
 * printed a megabyte of test output would forget everything it ran before.
 *
 * `fs` is injected so the tests can drive this over a fake filesystem without
 * writing transcripts to disk.
 */
export class ShellRunsTracker {
  private readonly tails = new Map<string, SessionTail>();
  private readonly io: Pick<typeof fs, 'statSync' | 'openSync' | 'readSync' | 'closeSync'>;

  constructor(io?: Pick<typeof fs, 'statSync' | 'openSync' | 'readSync' | 'closeSync'>) {
    this.io = io ?? fs;
  }

  /**
   * Bring one session up to date and return its runs, newest and live first.
   *
   * Never throws: a transcript that vanished, is unreadable, or was replaced
   * gives back whatever was already known rather than emptying the view.
   */
  update(session: ShellSessionRef): ShellRun[] {
    const id = session?.id;
    const file = session?.transcriptPath;
    if (typeof id !== 'string' || id === '') return [];
    if (typeof file !== 'string' || file === '') return [];

    let tail = this.tails.get(id);
    if (tail === undefined || tail.file !== file) {
      tail = { file, offset: 0, pending: '', set: new ShellRunSet(id) };
      this.tails.set(id, tail);
    }

    let size: number;
    try {
      size = this.io.statSync(file, { throwIfNoEntry: false })?.size ?? -1;
    } catch {
      return tail.set.list();
    }
    if (size < 0) return tail.set.list();
    if (size === tail.offset) return tail.set.list(); // nothing appended

    // Three cases seek to a bounded tail instead of reading forward: the FIRST
    // look at this session, a file that SHRANK (a compaction rewrote it in
    // place, so the old offset now points into the middle of a different
    // record), and a jump too big to parse in one tick (the view was collapsed
    // while the session worked). All three land on the same window, and none
    // of them needs to discard what is already known: `ingest` keys runs by
    // their tool_use id and ignores an id it has already seen, so re-reading
    // records is idempotent — which is what lets a compaction keep its history
    // rather than blank the view.
    const first = tail.offset === 0 && tail.pending === '';
    let seeding = false;
    if (first || size < tail.offset || size - tail.offset > MAX_STEP_BYTES) {
      const from = Math.max(0, size - SEED_TAIL_BYTES);
      tail.offset = from;
      tail.pending = '';
      // A window that starts past byte 0 cut a record in half; its first line
      // is a fragment and is dropped rather than guessed at.
      seeding = from > 0;
    }

    let chunk: string;
    try {
      chunk = this.read(file, tail.offset, size - tail.offset);
    } catch (err) {
      logError('toolShells.read', err);
      return tail.set.list();
    }
    tail.offset = size;

    const text = tail.pending + chunk;
    const cut = text.lastIndexOf('\n');
    if (cut === -1) {
      // No complete record yet. Hold it, unless it has grown past anything a
      // transcript record plausibly is — then drop it and resynchronise on the
      // next newline rather than buffer without bound.
      tail.pending = text.length > MAX_PENDING_BYTES ? '' : text;
      return tail.set.list();
    }
    tail.pending = text.slice(cut + 1);
    feed(tail.set, text.slice(0, cut), seeding);
    return tail.set.list();
  }

  /** Forget every session not in `keep`, so the tracker is bounded by what is
   *  live rather than by everything this window has ever watched. */
  prune(keep: ReadonlySet<string>): void {
    for (const id of [...this.tails.keys()]) {
      if (!keep.has(id)) this.tails.delete(id);
    }
  }

  dispose(): void {
    this.tails.clear();
  }

  private read(file: string, from: number, want: number): string {
    const fd = this.io.openSync(file, 'r');
    try {
      const size = Math.min(want, MAX_STEP_BYTES);
      if (size <= 0) return '';
      const buf = Buffer.alloc(size);
      const read = this.io.readSync(fd, buf, 0, size, from);
      return buf.toString('utf-8', 0, read);
    } finally {
      try {
        this.io.closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}
