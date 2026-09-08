// src/chatAutoClose.ts — the chat's own lifecycle: when does an idle chat
// tab close itself, and what IS a chat in the first place
// (`isChatConversation`, at the bottom — the one answer every exemption
// below reads).
//
// A project CHAT is a scratch conversation: asked, answered, abandoned — and
// abandoned is its NORMAL ending, not a failure mode. But a chat has no tree
// row, which means none of the machinery that tidies session tabs applies to
// it: solo mode exempts it on purpose (a chat is not a session tab), a
// layout never names it, the auto-switch never re-scopes the window for it,
// and a workspace switch only stows it away from FOREIGN projects. So
// finished chats used to pile up as tabs until the user closed each one by
// hand — the cheapest object in the extension was the only one with no way
// off the screen.
//
// EVERY ONE OF THOSE EXEMPTIONS IS THE SAME QUESTION, and it was answered in
// three places at once — commands.ts for solo mode, workspaces.ts for the
// switch, and nowhere at all for the auto-switch, which is how asking a
// question ABOUT project A from project B's workspace came to sweep project
// B's own sessions off the screen. `isChatConversation` is that question,
// stated once, so the next call site inherits the rule instead of re-deriving
// it.
//
// The answer is a lifecycle of the chat's own: after `autoCloseMinutes`
// without use, the tab closes itself. Nothing is lost — the conversation is
// its transcript, and Chat History reopens it — so the ONLY thing at stake is
// whether closing now would interrupt someone, which is what every rule below
// protects:
//
//   * only chats — a session tab is the user's layout, never touched here;
//   * never the ACTIVE tab — "without use" cannot describe the tab being
//     looked at, whatever its transcript's mtime says;
//   * never a busy or waiting chat — a turn in flight, or a permission dialog
//     someone has to answer, outranks tidiness exactly as it does everywhere
//     else in this extension;
//   * `minutes <= 0` disables the whole sweep — 0 is the setting's off
//     switch, not a zero-length window.
//
// PURE, in the shape `recommendedPlan` (src/recommend.ts) and `tmuxAdvice`
// (src/tmux.ts) established: this decides, the wiring in extension.ts reads
// the world (bindings, roster status, transcript mtimes, the active tab) and
// acts on the answer. What "use" means — the transcript's mtime, falling back
// to when the tab was bound — is deliberately the caller's problem: this
// module ranks moments, it does not locate files.

import type { EditorialRecord, SessionStatus } from './types';

/** One bound tab, reduced to the facts the decision needs. Built from the
 *  terminal registry by extension.ts; built by hand in tests. */
export interface ChatTabFacts {
  /** The id the terminal is BOUND under (its launch-time id) — the id the
   *  registry can close, which is why it is the one returned. */
  sessionId: string;
  /** The conversation is a project chat (extension.ts also folds
   *  `launchedByUs` in here: a chat Flock did not launch is not Flock's to
   *  close). */
  isChat: boolean;
  /** This tab is the one the user is looking at right now. */
  isActiveTab: boolean;
  /** The roster's answer, via the same normalizeStatus the tree's dots use. */
  status: SessionStatus;
  /** Epoch ms of the last sign of use — transcript mtime, or the bind time
   *  when no transcript exists yet. */
  lastActivityMs: number;
}

/**
 * `lineage.chat.autoCloseMinutes`: which of these tabs have sat unused long
 * enough to close. Returns their ids, in input order; empty is the ordinary
 * answer. Non-finite inputs always answer "keep" — a tab whose age is unknown
 * must never be closed on the strength of not knowing.
 */
export function chatAutoCloseVictims(input: {
  now: number;
  autoCloseMinutes: number;
  tabs: readonly ChatTabFacts[];
}): string[] {
  const { now, autoCloseMinutes, tabs } = input;
  if (!Number.isFinite(autoCloseMinutes) || autoCloseMinutes <= 0) return [];
  if (!Number.isFinite(now)) return [];
  const windowMs = autoCloseMinutes * 60_000;
  return tabs
    .filter(
      (tab) =>
        tab.isChat &&
        !tab.isActiveTab &&
        tab.status !== 'busy' &&
        tab.status !== 'waiting' &&
        Number.isFinite(tab.lastActivityMs) &&
        now - tab.lastActivityMs >= windowMs,
    )
    .map((tab) => tab.sessionId);
}

/** The store reads that answer "is this conversation a CHAT?" — satisfied by
 *  the state store plus the chain index (`get` / `all` / `tipOf`), by the
 *  command and workspace dep bags, and by hand in tests. */
export interface ChatChainReads {
  getRecord(sessionId: string): EditorialRecord | undefined;
  tipOf(sessionId: string): string;
  allRecords(): Record<string, EditorialRecord>;
}

/**
 * Is this id a project CHAT's? THE one answer — every rule that exempts a
 * chat from something sessions get reads it here, because the rules kept
 * diverging one call site at a time (see the header).
 *
 * Asked of the id, of its tip, and — because the `chat` flag is written once,
 * at birth, and inherited only in the forest's collapsed overlay, which a
 * rowless chat never surfaces through — of any record in the store whose
 * chain resolves to the same tip. Without the last step a chat reopened twice
 * answers "session": the id its terminal is bound under is a generation
 * nothing ever wrote `chat` onto.
 *
 * Pure and total: the reads are the caller's, and a caller whose reads can
 * throw wraps this and treats a throw as "not a chat" — which fails toward
 * the pre-chat behaviour rather than toward exempting a session.
 */
export function isChatConversation(
  reads: ChatChainReads,
  sessionId: string,
): boolean {
  if (reads.getRecord(sessionId)?.chat === true) return true;
  const tip = reads.tipOf(sessionId);
  if (tip !== sessionId && reads.getRecord(tip)?.chat === true) return true;
  return Object.values(reads.allRecords()).some(
    (r) => r.chat === true && reads.tipOf(r.id) === tip,
  );
}
