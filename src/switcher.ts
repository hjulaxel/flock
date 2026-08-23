// src/switcher.ts — which conversation am I in, and may the tree say so?
//
// `lineage.sessionSwitching` (see SessionSwitching in types.ts for the whole
// argument) makes the Flock tree the place you switch conversations, in two
// halves: the row of whatever is in front stays SELECTED, and one key puts the
// KEYBOARD on that row so the arrows move between sessions. Both halves need
// the same answer to one question — which conversation is in front — and this
// is where that answer is decided.
//
// THE QUESTION IS HARDER THAN IT LOOKS, because a conversation can be in front
// in two quite different ways:
//
//   * in a terminal Flock owns, which the workbench reports precisely
//     (`window.activeTerminal`, via TerminalRegistry.onDidChangeActive);
//   * in the Claude Code extension's own panel, which reports NOTHING. A
//     webview tab exposes its viewType and nothing else, that extension
//     publishes no "which session is this tab" API, and its panels are all one
//     viewType anyway. The only handle is that Flock ASKED for it: a delegated
//     open names the session id, so the id we passed is the id that is now on
//     screen until something else takes over.
//
// So the answer is "the active terminal, else the last one we put there", and
// the second half is a memory rather than an observation. That is stated
// plainly here rather than hidden behind a lookup, because it is the reason
// the feature behaves the way it does: switch to a Claude panel by clicking
// its tab and Flock will not notice, because nothing told it.
//
// PURE, in the shape chatAutoClose.ts and compaction.ts established: this
// decides, extension.ts reads the world (the registry, the chain index, the
// forest) and acts on the answer.

import { isSessionId } from './types';
import type { SessionSwitching } from './types';

/** Everything the answer depends on, injected. */
export interface FrontSessionInput {
  /** `TerminalRegistry.activeSessionId()` — the session whose terminal has the
   *  workbench's focus, under the id it was BOUND with (a launch-time id,
   *  which after a re-key is not the id its row now carries). */
  activeSessionId: string | null;
  /** The last conversation Flock itself put on screen by a route the active
   *  terminal cannot show — the delegated open, above all. */
  lastFrontSessionId: string | null;
  /** The current generation of a conversation: `ChainIndex.tipOf`. */
  tipOf(sessionId: string): string;
  /** Whether the forest has a row under this exact id. */
  hasRow(sessionId: string): boolean;
}

/**
 * The row to select, or null for "nothing to say".
 *
 * ALWAYS RESOLVED OVER THE CHAIN and always checked against the forest, in
 * that order. Both matter:
 *
 *   * the chain, because every handle above names the generation that was
 *     current when it was recorded — a terminal is bound under its launch-time
 *     id and keeps that binding across every `--resume`, `/clear` and
 *     compaction the conversation goes through, while the row it belongs to
 *     collapsed onto the tip long ago;
 *   * the forest, because a row that is not rendered cannot be selected, and
 *     asking for one is a silent no-op that leaves the LAST selection standing
 *     — which is worse than doing nothing, since the tree would then be
 *     confidently pointing at the wrong conversation.
 *
 * The tip is tried first and the raw id second, so a conversation whose chain
 * has not been learnt yet (a fresh launch, before the hooks or the archive
 * scan have connected the generations) still selects the row it does have.
 */
export function frontSession(input: FrontSessionInput): string | null {
  const candidate = input.activeSessionId ?? input.lastFrontSessionId;
  if (candidate === null || !isSessionId(candidate)) return null;
  let tip = candidate;
  try {
    tip = input.tipOf(candidate);
  } catch {
    tip = candidate;
  }
  if (isSessionId(tip) && input.hasRow(tip)) return tip;
  return input.hasRow(candidate) ? candidate : null;
}

/**
 * May the tree move its own selection right now?
 *
 * Two gates, and the second is the one that keeps this feature polite.
 *
 * The MODE gate is the setting: `claude` means the user keeps the Claude Code
 * extension's agent list and Flock stops having an opinion about where they
 * are.
 *
 * The VISIBILITY gate is the important one. Selecting a row in the native tree
 * goes through `TreeView.reveal`, and revealing an element in a view that is
 * not on screen OPENS it — so a Flock sidebar the user had collapsed, or a
 * different activity-bar container entirely, would spring open every time they
 * clicked between terminals. Following is a courtesy for a tree somebody is
 * looking at; for a tree nobody is looking at it is an interruption, and there
 * is nothing to keep in sync anyway. The jump verb reveals the view on
 * purpose, which is the one place that IS asked for.
 */
export function mayFollowSelection(input: {
  mode: SessionSwitching;
  treeVisible: boolean;
}): boolean {
  return input.mode === 'flock' && input.treeVisible;
}
