// src/chatAutoClose.ts — when does an idle chat tab close itself?
//
// A project CHAT is a scratch conversation: asked, answered, abandoned — and
// abandoned is its NORMAL ending, not a failure mode. But a chat has no tree
// row, which means none of the machinery that tidies session tabs applies to
// it: solo mode exempts it on purpose (a chat is not a session tab), and a
// workspace switch only stows it away from FOREIGN projects. So finished
// chats used to pile up as tabs until the user closed each one by hand — the
// cheapest object in the extension was the only one with no way off the
// screen.
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

import type { SessionStatus } from './types';

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
