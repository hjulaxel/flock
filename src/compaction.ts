// src/compaction.ts — what a compacting session's dot says, and for how long.
//
// THE PROBLEM. A compaction is invisible to every signal the tree already
// reads. `claude agents --json` reports a compacting session as plainly
// `busy` — the same word it uses for a session mid-turn — so the row drew the
// amber running dot; then the compaction ended, the session went quiet, and
// the row drew the red attention dot, which is the mark that means "this one
// wants you". Neither is true. Compaction is the one thing a session does
// that is neither work you asked for nor a question for you, and it was
// wearing both of those costumes in turn.
//
// THE MARK. Compaction gets a hue of its own — purple, the one signal colour
// the sidebar had not spent (amber is running, red is attention, green is the
// brand, and the branch palette deliberately skips red for the same reason) —
// and the SHAPE carries the phase:
//
//   ◯  a purple RING, hollow, while the compaction is underway
//   ●  a full purple DOT once it is done and nothing else is running
//
// which is the same ring→fill grammar the tree already uses on its spine (an
// expandable node is a ring, a leaf is a filled dot). Empty means "still
// going", filled means "settled".
//
// THE PHASES, and the events behind them:
//
//   in  — the PreCompact hook. The ONLY signal that a compaction has started:
//         the roster says `busy` and nothing else, and the transcript's
//         `compact_boundary` record is not written until it is already over.
//         This is why src/hooks.ts grew a fifth event (PLUGIN_VERSION 4).
//   out — three signals, whichever lands first, because the tree must not
//         depend on hooks for anything (see the header of src/hooks.ts):
//         the Stop hook (the turn ended), the roster transition out of `busy`
//         that the poller sees anyway, and — when neither can happen, because
//         the turn carried straight on — the successor simply EXISTING in the
//         chain (`settleSuperseded`).
//
//         THE THIRD IS THE ONE THAT CANNOT LOSE A RACE, and it was added
//         because the other two both name the SUCCESSOR's id while the
//         PreCompact named its predecessor: they only meet over the chain
//         index, which is rebuilt on the poll. See `settleSuperseded` for the
//         ten-minute stuck ring that came of assuming they always would.
//
//         SessionStart `source: 'compact'` used to be a fourth, and is
//         deliberately not one any more. It is the earliest and most exact
//         statement that a compaction finished — but see `noteFinish`'s `busy`
//         argument: finishing is only half of what has to be decided, and at
//         that instant the roster still reports the compaction's own `busy`,
//         so the other half could only be answered wrongly.
//
// AND ONE THING THAT ENDS A COMPACTION WITHOUT RESTING A DOT. If the turn is
// still running when the compaction finishes — the ordinary shape of
// auto-compact, which fires mid-turn and hands straight back to the model —
// the phase is dropped rather than settled: "compacted, and nothing behind it"
// is not something you can say about a session that is visibly working. See
// `noteFinish`'s `busy` parameter.
//
// WHEN THE PURPLE DOT GOES AWAY. "Compacted" is a note, not an alarm: it says
// the conversation is freshly compacted and nothing has been asked of it
// since. So it clears when something IS asked of it — the next prompt
// (UserPromptSubmit), the next `busy` the roster reports — when the session
// ends, and when you OPEN the session, because opening it is reading the note.
//
// The ring is not cleared by opening. A compaction in flight is a fact about
// the process rather than a message for the user, and watching it happen does
// not make it stop happening — which is why `clearSettled` exists as something
// separate from `clear`.
//
// EVERY PHASE IS BOUNDED. A compaction that never reports finishing would
// otherwise leave a ring on the row forever — the crash, the hook that never
// fired, the `/reload-plugins` nobody ran. Both phases expire (see the two
// constants below), and an expired phase simply falls back to the tones the
// row drew before any of this existed. A wrong dot that heals in minutes is
// survivable; one that never does is what the whole "no mark without meaning"
// rule in viewmodel.badgeGlyph exists to prevent.
//
// PURE and vscode-free, in the shape src/chatAutoClose.ts and src/recommend.ts
// established: this decides, extension.ts reads the world (hook events, roster
// transitions, the chain index) and feeds it in. Time is always a parameter —
// nothing here calls Date.now().

import type { CompactionPhase } from './types';

export type { CompactionPhase };

/**
 * How long a `compacting` ring may stand without a completion signal.
 *
 * Generous on purpose: compacting a very long conversation is a real model
 * call over the whole transcript, and on a slow link it is minutes, not
 * seconds. The number is a stuck-state ceiling, not a timeout — the ordinary
 * exit is one of the completion signals in the header, all of which are far
 * faster than this.
 */
export const COMPACTING_STALE_MS = 10 * 60_000;

/**
 * How long a full purple dot rests before the row goes back to its ordinary
 * tones.
 *
 * The ordinary exit is the next prompt or the next `busy`, and both are
 * instant. This only covers the conversation that gets compacted and then
 * abandoned: an hour later "freshly compacted" is no longer a useful thing to
 * say about it, and a purple dot that outlives its own meaning is a mark the
 * eye learns to skip — the same argument badgeGlyph makes for drawing nothing
 * on an idle row.
 */
export const COMPACTED_REST_MS = 60 * 60_000;

interface Entry {
  /** Epoch ms of the PreCompact that opened this phase. */
  startedAt?: number;
  /** Epoch ms the compaction was observed to finish. */
  finishedAt?: number;
}

/**
 * The compaction phase of every session that has one, keyed by session id.
 *
 * KEYED BY THE PHYSICAL ID, NOT THE ROW. A compaction re-mints the session id
 * — that is what a "compaction successor" is — so the PreCompact arrives under
 * the old generation's id and the SessionStart under the new one, while the
 * tree collapses both onto a single row. Rather than teach this module about
 * chains, every read and every clear takes an id LIST (the conversation's
 * chain members, which extension.ts already has) and answers for the
 * conversation. See `phaseOf`.
 */
export class CompactionTracker {
  private readonly entries = new Map<string, Entry>();

  /** PreCompact: a compaction is starting on this generation. Re-arming an
   *  entry that was already `compacted` is deliberate — a second compaction is
   *  a new phase, and the ring must replace the dot rather than lose to it. */
  noteStart(sessionId: string, now: number): void {
    if (!sessionId || !Number.isFinite(now)) return;
    this.entries.set(sessionId, { startedAt: now });
  }

  /**
   * The compaction finished. Only ever acts on a session already known to be
   * compacting — the completion signals (the Stop hook, the roster leaving
   * `busy`) both fire constantly for reasons that have nothing to do with
   * compaction, and a `finishedAt` written without a `startedAt` would put a
   * purple dot on every session that ever ended a turn.
   *
   * The list is the conversation's chain: the completion signal names the
   * SUCCESSOR generation while the PreCompact named its predecessor, so the
   * two only meet over the chain. The phase is re-seated onto `sessionIds[0]`
   * — the id the caller considers current — and the rest are dropped, so a
   * conversation never carries two entries.
   */
  noteFinish(
    sessionIds: readonly string[],
    now: number,
    /**
     * Is the conversation STILL WORKING at the moment this compaction ended?
     *
     * When it is, the phase is dropped outright rather than settling into a
     * resting dot — and that is not a nicety, it is what makes the resting dot
     * mean anything. "Compacted, and nothing behind it" is FALSE the instant a
     * turn is running behind it, and the commonest compaction of all runs
     * mid-turn: auto-compact fires when the context fills, the successor is
     * minted, and the same turn carries straight on for another few minutes.
     * Resting a dot there put a purple mark on the row that survived the whole
     * rest of the turn and was still standing when the turn ENDED — so the one
     * moment the row genuinely had something to say ("finished, and waiting on
     * you") it said "compacted" instead, in purple, for up to an hour.
     *
     * The two callers that know the turn is over — the Stop hook and the
     * roster's own busy→quiet edge — pass `false` and get the dot. The two
     * that can land mid-turn (the successor being minted, and the supersession
     * sweep) pass the status they can actually see.
     */
    busy: boolean,
  ): boolean {
    if (!Number.isFinite(now)) return false;
    const started = this.startOf(sessionIds);
    if (started === undefined) return false;
    for (const id of sessionIds) this.entries.delete(id);
    if (busy) return true; // finished, and something is already behind it
    const head = sessionIds[0];
    if (head === undefined) return false;
    this.entries.set(head, { startedAt: started, finishedAt: now });
    return true;
  }

  /** Is this conversation mid-compaction right now? The ring, asked as a
   *  question rather than drawn — `detectTurnTransitions` needs to know that a
   *  busy→quiet edge belongs to a compaction BEFORE it settles it. */
  isCompacting(sessionIds: readonly string[]): boolean {
    return this.startOf(sessionIds) !== undefined;
  }

  /**
   * Settle every ring whose generation has been SUPERSEDED — the hook-free
   * answer to "did that compaction ever end?", and the one signal that cannot
   * lose a race.
   *
   * A COMPACTION RE-MINTS THE SESSION ID; that is what a compaction successor
   * IS. So a generation that has acquired a successor has, by definition,
   * finished compacting — the successor is the compaction's own output, and
   * its existence is the completion signal. No hook, no roster edge, no
   * transcript record: just the chain, read on the rebuild that has already
   * built it.
   *
   * WHY IT IS NEEDED even though two completion signals already exist. Both
   * name the SUCCESSOR's id while the PreCompact named its predecessor, so
   * both depend on the chain index having already learnt the pairing — and the
   * index is rebuilt on the poll, while a hook arrives the instant the CLI
   * writes it. A hook that beats its own chain fact finds no open ring and
   * returns false; and if the turn then carries on (the mid-turn auto-compact
   * again) the roster never produces a busy→quiet edge to try again with. The
   * ring stood — outranking the amber the row should have been drawing,
   * because `statusTone` gives a compaction precedence over the status
   * underneath it — until COMPACTING_STALE_MS finally expired it ten minutes
   * later. This closes that window to one poll.
   *
   * `now` is when we NOTICED, not when the compaction ended, and the two can
   * differ by a poll interval. That is the honest number to rest a dot from:
   * it is the first moment the fact was knowable here, and erring later means
   * the dot is never shown for longer than it was earned.
   */
  settleSuperseded(
    /** The current tip of the chain `id` belongs to; `id` itself when it is
     *  the tip, or when the chain is not known. */
    tipOf: (id: string) => string,
    /** Is the conversation at that tip working right now? Passed through to
     *  `noteFinish` — a compaction that ended mid-turn rests no dot. */
    busyAt: (tipId: string) => boolean,
    now: number,
  ): void {
    if (!Number.isFinite(now)) return;
    for (const [id, entry] of [...this.entries]) {
      if (entry.startedAt === undefined || entry.finishedAt !== undefined) {
        continue;
      }
      let tip: string;
      try {
        tip = tipOf(id);
      } catch {
        continue; // a chain index mid-rebuild is not worth a thrown rebuild
      }
      if (tip === id || tip === '') continue; // still the current generation
      // A SECOND COMPACTION ALREADY RUNNING ON THE SUCCESSOR OUTRANKS THIS.
      // Re-seating onto the tip would overwrite a newer, live ring with an
      // older, finished one — the row would go from "compacting" back to
      // "compacted" while a compaction was visibly underway.
      if (this.entries.get(tip)?.startedAt !== undefined) {
        this.entries.delete(id);
        continue;
      }
      this.entries.delete(id);
      let busy = false;
      try {
        busy = busyAt(tip);
      } catch {
        busy = false;
      }
      if (busy) continue; // finished, and the turn carried on: no resting dot
      this.entries.set(tip, { startedAt: entry.startedAt, finishedAt: now });
    }
  }

  /** The session is over. Clears the conversation outright, `compacting`
   *  included — a session that has ended is not compacting either. */
  clear(sessionIds: readonly string[]): void {
    for (const id of sessionIds) this.entries.delete(id);
  }

  /**
   * The note has been read, or something is on top of it now: the session was
   * opened, a new prompt arrived, or the roster is reporting work again.
   * Clears the RESTING DOT ONLY.
   *
   * Leaving `compacting` alone is not a nicety, it is the whole reason this is
   * a separate method from `clear`. A compaction makes its session busy, so
   * the caller's quiet→busy edge fires on the compaction's own first tick —
   * and a blanket clear there would take the ring down one poll interval after
   * PreCompact put it up, every single time. The ring comes down when the
   * compaction ENDS, which is `noteFinish`'s job and nothing else's.
   */
  clearSettled(sessionIds: readonly string[]): void {
    for (const id of sessionIds) {
      if (this.entries.get(id)?.finishedAt !== undefined) {
        this.entries.delete(id);
      }
    }
  }

  /**
   * The phase to draw for a conversation, or undefined for "no compaction
   * mark" — which includes every phase that has expired.
   *
   * `busy` is the caller's live status for the row and it OUTRANKS the resting
   * dot: "compacted, and nothing behind it" stops being true the instant
   * something is behind it, and the roster saying `busy` is exactly that. It
   * does NOT outrank the ring — a compaction in flight IS busy, and reading
   * the ring off the same status that produced it would mean it never drew.
   */
  phaseOf(
    sessionIds: readonly string[],
    now: number,
    busy: boolean,
  ): CompactionPhase | undefined {
    if (!Number.isFinite(now)) return undefined;
    for (const id of sessionIds) {
      const entry = this.entries.get(id);
      if (entry === undefined) continue;
      if (entry.finishedAt !== undefined) {
        if (now - entry.finishedAt >= COMPACTED_REST_MS) continue;
        return busy ? undefined : 'compacted';
      }
      if (entry.startedAt !== undefined) {
        if (now - entry.startedAt >= COMPACTING_STALE_MS) continue;
        return 'compacting';
      }
    }
    return undefined;
  }

  /** Drop every entry for a session no longer in the tree, and every entry
   *  whose phase has expired. Called on the rebuild, so the map cannot outgrow
   *  the forest on a long-lived window. */
  prune(liveIds: ReadonlySet<string>, now: number): void {
    for (const [id, entry] of [...this.entries]) {
      if (!liveIds.has(id)) {
        this.entries.delete(id);
        continue;
      }
      if (!Number.isFinite(now)) continue;
      const at = entry.finishedAt ?? entry.startedAt;
      if (at === undefined) {
        this.entries.delete(id);
        continue;
      }
      const ceiling =
        entry.finishedAt !== undefined ? COMPACTED_REST_MS : COMPACTING_STALE_MS;
      if (now - at >= ceiling) this.entries.delete(id);
    }
  }

  /** Test/diagnostic read: how many conversations currently carry a phase. */
  get size(): number {
    return this.entries.size;
  }

  /** The `startedAt` of whichever chain member is mid-compaction, if any. */
  private startOf(sessionIds: readonly string[]): number | undefined {
    for (const id of sessionIds) {
      const entry = this.entries.get(id);
      if (entry?.startedAt !== undefined && entry.finishedAt === undefined) {
        return entry.startedAt;
      }
    }
    return undefined;
  }
}
