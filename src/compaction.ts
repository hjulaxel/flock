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
//         SessionStart `source: 'compact'` (the successor generation being
//         minted — instant and exact), the Stop hook (the turn ended), or the
//         roster transition out of `busy` that the poller sees anyway.
//
// WHEN THE PURPLE DOT GOES AWAY. "Compacted" is a resting state, not a
// notification: it says the conversation is freshly compacted and nothing is
// on top of it. So it clears the moment something IS on top of it — the next
// prompt (UserPromptSubmit), the next `busy` the roster reports — and when the
// session ends. It is deliberately NOT cleared by looking at the row: unlike
// the red dot it is not asking for anything, so "seen" is not a state it has.
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
 * exit is one of the three completion signals, all of which are far faster
 * than this.
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
   * compacting — the three completion signals (SessionStart `source:
   * 'compact'`, the Stop hook, the roster leaving `busy`) all fire constantly
   * for reasons that have nothing to do with compaction, and a `finishedAt`
   * written without a `startedAt` would put a purple dot on every session that
   * ever ended a turn.
   *
   * The list is the conversation's chain: the completion signal names the
   * SUCCESSOR generation while the PreCompact named its predecessor, so the
   * two only meet over the chain. The phase is re-seated onto `sessionIds[0]`
   * — the id the caller considers current — and the rest are dropped, so a
   * conversation never carries two entries.
   */
  noteFinish(sessionIds: readonly string[], now: number): boolean {
    if (!Number.isFinite(now)) return false;
    const started = this.startOf(sessionIds);
    if (started === undefined) return false;
    for (const id of sessionIds) this.entries.delete(id);
    const head = sessionIds[0];
    if (head === undefined) return false;
    this.entries.set(head, { startedAt: started, finishedAt: now });
    return true;
  }

  /** The session is over. Clears the conversation outright, `compacting`
   *  included — a session that has ended is not compacting either. */
  clear(sessionIds: readonly string[]): void {
    for (const id of sessionIds) this.entries.delete(id);
  }

  /**
   * Something is on top of the compaction now: a new prompt, or the roster
   * reporting work again. Clears the RESTING DOT ONLY.
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
