// src/handoff.ts — continuing a conversation on the OTHER CLI.
//
// Pure: it imports ./types and ./accounts (also pure) — never vscode, never
// node — so every rule here is testable with object literals, the same
// discipline routing.ts keeps.
//
// THE CLAIM THIS FILE MAKES. `switchRefusal` (accounts.ts) refuses to move a
// conversation between CLIs because there is nothing to resume: a Codex home
// does not hold a Claude transcript. That refusal is correct and stays. But
// "cannot resume" is not "cannot continue" — the transcript is a readable
// JSONL file on this disk, for both CLIs. A handoff is a NEW session on the
// target CLI whose opening turn is a brief: read that file, say where the work
// stands, carry on. Not a resume, never to be called one in any surface — and
// still a real continuation with a real (minted) lineage edge.
//
// WHY THE CHILD DOES THE READING. Fork-and-Compact hands `/compact` to the
// child as its opening turn so the parent is never asked to compact anything;
// the handoff follows the same shape for the same reasons. Summarizing in the
// extension would need a model the extension does not have (and must not grow
// — "no HTTP client anywhere" is a privacy promise, limits.ts excepted), and
// inlining transcript bytes into an argv would put conversation content into
// `ps` output and shell history. The brief therefore names the file and stays
// a few hundred characters; the child, which is an agent with file tools on
// this same machine, does the reading as its first turn.
//
// WHAT THE PATH DISCLOSES, said out loud: the transcript path's prefix names
// the parent account's config directory. That is a location, not a credential
// — both processes already run as the same user on the same machine — and the
// brief names the one file, never the directory root.

import type { AccountProfile } from './types';
import { canHostSession, cliOfProfile } from './accounts';
import type { SessionCli } from './accounts';

// ------------------------------------------------------------------ refusal

/** Why a conversation may not be handed off to a given account. `null` = it
 *  may. Mirrors `SwitchRefusal` deliberately: the two verbs must partition the
 *  world — same CLI moves, different CLI hands off, no target is served by
 *  both and none by neither (transcript permitting). */
export type HandoffRefusal =
  | 'no-target'
  | 'same-cli'
  | 'cannot-host'
  | 'no-transcript';

/**
 * May this conversation be handed off from `from`'s account to `to`?
 *
 * `from` is null for a conversation with no pin — the default `~/.claude`
 * login, which runs claude; `cliOfProfile` already reads it that way.
 *
 * ORDERING, same argument as switchRefusal's: `same-cli` outranks
 * `cannot-host` because it is the durable reason. Which providers Flock can
 * start a session on grows over time; which CLI wrote a conversation never
 * changes. A same-CLI target is refused for the reason that will still be
 * true in every future build — fork and Move to Account… own that world.
 *
 * `hasTranscript` is the fork rule verbatim ("send one message first"): a
 * brief that points at a file that does not exist briefs the child to fail.
 */
export function handoffRefusal(
  from: AccountProfile | null | undefined,
  to: AccountProfile | null | undefined,
  hasTranscript: boolean,
  /** The CLI that WROTE the conversation, when the caller knows it. Outranks
   *  the pin: a Codex conversation started in a terminal has no pin at all,
   *  and reading the missing pin as the default provider would judge it a
   *  Claude one and offer it a Codex account as "the other CLI" — the exact
   *  inversion `offerSwitch` fixed on the switch side. Absent, the pin's CLI
   *  stands, which is every caller written before Codex parents existed. */
  fromCli?: SessionCli,
): HandoffRefusal | null {
  // Existence first: `cliOfProfile` reads a missing profile as the default
  // provider, so a null target would otherwise be judged as a claude one.
  if (!to || to.deleted === true) return 'no-target';
  if ((fromCli ?? cliOfProfile(from)) === cliOfProfile(to)) return 'same-cli';
  if (!canHostSession(to)) return 'cannot-host';
  if (!hasTranscript) return 'no-transcript';
  return null;
}

// ------------------------------------------------------------------- brief

/** The names a person reads. `claude`/`codex`/`gemini` are provider ids, and a
 *  brief that opens "you are continuing a conversation from claude" reads like
 *  a config file. One wording, exported so the picker and the brief can never
 *  drift apart. */
export const CLI_DISPLAY_NAME: Readonly<Record<SessionCli, string>> = {
  claude: 'Claude Code',
  codex: 'the Codex CLI',
  gemini: 'the Gemini CLI',
};

/** Everything the brief is composed from. All of it is display-grade metadata
 *  the tree already shows — nothing here is a credential, and the transcript
 *  CONTENT never passes through this function at all. */
export interface HandoffBriefInput {
  /** Absolute path of the parent's transcript (claude project JSONL or codex
   *  rollout — both are JSONL, so the brief's wording holds for either). */
  transcriptPath: string;
  /** The CLI that wrote the transcript, so the child knows whose idioms the
   *  file speaks (slash commands, tool names) and does not imitate them. */
  sourceCli: SessionCli;
  /** The parent row's label, when it has one worth repeating. */
  parentTitle?: string;
  /** Where the work happens. Repeated in the brief because a conversation
   *  that never says which directory it is about wastes its first exchange
   *  rediscovering it — the same reason buildCodexArgs folds the project into
   *  the opening prompt. */
  cwd?: string;
}

/**
 * One or two lines telling the child how the OTHER CLI's file is laid out, so
 * its first minute is reading rather than reverse-engineering. Measured on real
 * files, not guessed:
 *
 *   Claude   one record per line; `type` is `user` or `assistant`, the text is
 *            under `message.content` (a string, or an array of blocks with a
 *            `text` field).
 *   Codex    one record per line; the first is a `session_meta` header tens of
 *            kilobytes long (the whole system prompt) and is skippable. The
 *            conversation is in `response_item` records whose payload is a
 *            `message` with `role` user/assistant and `content` blocks of
 *            `input_text` / `output_text`; `event_msg` records of type
 *            `user_message` and `agent_message` repeat the same text compactly.
 *
 * Gemini has no line because Flock never reads a Gemini transcript (it is not a
 * session provider); the brief still composes for it, wordlessly.
 */
const TRANSCRIPT_SHAPE: Readonly<Record<SessionCli, readonly string[]>> = {
  claude: [
    'Layout: one JSON record per line; "type" is "user" or "assistant" and',
    'the text is under message.content (a string, or blocks with a "text").',
  ],
  codex: [
    'Layout: a Codex rollout. Skip the long first line (the session header).',
    'The conversation is in "response_item" records whose payload is a',
    '"message" with role user/assistant; "event_msg" records of type',
    '"user_message" and "agent_message" carry the same text more compactly.',
  ],
  gemini: [],
};

/** Ceiling for the composed brief, same figure as MAX_AGENT_PROMPT_CHARS and
 *  for the same reason: an opening turn is an argv, and argvs have budgets.
 *  The template plus a pathological path stays far under it; the guard exists
 *  so a future caller cannot silently push a novel through. */
export const MAX_HANDOFF_PROMPT_CHARS = 4000;

/**
 * The opening turn a handoff child is launched with.
 *
 * Wording choices that are contracts, not prose: "not a resume" keeps the
 * child from claiming its parent's identity; "recent entries first" is the
 * reading order that fits a long transcript into a first turn; "don't ask
 * what the transcript already answers" is the difference between a handoff
 * and an interrogation. Throws on an empty path or an oversize result rather
 * than truncating — a brief cut mid-sentence changes what the child does,
 * the exact rule agentVerbs applies to its prompt.
 */
export function buildHandoffPrompt(input: HandoffBriefInput): string {
  const path = input.transcriptPath.trim();
  if (path.length === 0) {
    throw new Error('handoff: transcript path is empty');
  }
  const source = CLI_DISPLAY_NAME[input.sourceCli];
  const title = input.parentTitle?.trim();
  const cwd = input.cwd?.trim();
  const lines = [
    'You are taking over an existing conversation. It ran on ' +
      source +
      '; this is a handoff, not a resume — you have none of its context yet.',
    '',
    'Its full transcript is the JSONL file at:',
    '',
    '  ' + path,
    '',
    'Read it before doing anything else, recent entries first: user and',
    'assistant text carry the state, tool output mostly does not.',
    ...TRANSCRIPT_SHAPE[input.sourceCli],
  ];
  if (title) lines.push('The conversation is titled "' + title + '".');
  if (cwd) lines.push('The work happens in ' + cwd + '.');
  lines.push(
    '',
    'Then say, in a few lines, where the work stands, and continue from',
    'exactly there. Do not redo finished steps, and do not ask what the',
    'transcript already answers.',
  );
  const brief = lines.join('\n');
  if (brief.length > MAX_HANDOFF_PROMPT_CHARS) {
    throw new Error('handoff: composed brief exceeds the prompt ceiling');
  }
  return brief;
}
