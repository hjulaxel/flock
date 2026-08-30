// test/compaction.test.ts — the purple ring and the purple dot.
//
// Every rule about WHEN a session is in a compaction phase lives in
// src/compaction.ts, so it is all testable without a forest, a roster or a
// vscode double. What the phase then LOOKS like is viewmodel.test.ts's
// business (statusTone / badgeGlyph) and decorations' for the native tree.

import { describe, expect, it } from 'vitest';

import {
  COMPACTED_REST_MS,
  COMPACTING_STALE_MS,
  CompactionTracker,
} from '../src/compaction';

const A = '0f00000a-0000-4000-8000-00000000000a';
const B = '0f00000b-0000-4000-8000-00000000000b';
const NOW = 1_785_160_000_000;

/** The ordinary read: one session, not busy, asked at `now`. */
const phase = (
  t: CompactionTracker,
  ids: string[] = [A],
  now: number = NOW,
  busy = false,
): string | undefined => t.phaseOf(ids, now, busy);

/** A chain where `to` is the tip and `from` is the generation it replaced —
 *  the shape a compaction leaves behind. */
const tipOf =
  (from: string, to: string) =>
  (id: string): string =>
    id === from ? to : id;

/** Nobody is working. The ordinary second argument to settleSuperseded. */
const quiet = (): boolean => false;

describe('compaction: the two phases', () => {
  it('draws nothing for a session that has never compacted', () => {
    expect(phase(new CompactionTracker())).toBeUndefined();
  });

  it('rings while the compaction is underway', () => {
    const t = new CompactionTracker();
    t.noteStart(A, NOW);
    expect(phase(t, [A], NOW + 1_000)).toBe('compacting');
  });

  it('keeps the ring up while the session is busy — that IS the compaction', () => {
    // The bug this whole feature replaces: reading the status first painted
    // the amber running dot and the ring never appeared at all.
    const t = new CompactionTracker();
    t.noteStart(A, NOW);
    expect(phase(t, [A], NOW + 1_000, true)).toBe('compacting');
  });

  it('fills the dot once the compaction finishes', () => {
    const t = new CompactionTracker();
    t.noteStart(A, NOW);
    expect(t.noteFinish([A], NOW + 5_000, false)).toBe(true);
    expect(phase(t, [A], NOW + 6_000)).toBe('compacted');
  });

  it('withholds the resting dot while something IS behind it', () => {
    // "compacted and nothing running" stops being true the instant the roster
    // says the session is working again — but the phase itself survives, so a
    // turn that starts and ends leaves the dot where it was.
    const t = new CompactionTracker();
    t.noteStart(A, NOW);
    t.noteFinish([A], NOW + 5_000, false);
    expect(phase(t, [A], NOW + 6_000, true)).toBeUndefined();
    expect(phase(t, [A], NOW + 7_000, false)).toBe('compacted');
  });
});

describe('compaction: what closes a phase', () => {
  it('refuses to finish a compaction that never started', () => {
    // Stop and the busy→quiet transition fire constantly for reasons that have
    // nothing to do with compaction. Without this gate every session that ever
    // ended a turn would wear a purple dot.
    const t = new CompactionTracker();
    expect(t.noteFinish([A], NOW, false)).toBe(false);
    expect(phase(t)).toBeUndefined();
    expect(t.size).toBe(0);
  });

  it('clearSettled takes down the dot and leaves the ring alone', () => {
    // The distinction the quiet→busy edge depends on: a compaction makes its
    // own session busy, so that edge fires on the compaction's first tick and
    // a blanket clear there would kill every ring one poll after it went up.
    const ringing = new CompactionTracker();
    ringing.noteStart(A, NOW);
    ringing.clearSettled([A]);
    expect(phase(ringing, [A], NOW + 1_000)).toBe('compacting');

    const settled = new CompactionTracker();
    settled.noteStart(A, NOW);
    settled.noteFinish([A], NOW + 1_000, false);
    settled.clearSettled([A]);
    expect(phase(settled, [A], NOW + 2_000)).toBeUndefined();
  });

  it('takes the dot down when the session is opened — reading the note', () => {
    // Opening the session is the signal extension.ts feeds in from
    // registry.onDidChangeActive, the same "the user is looking" event that
    // clears the red unseen dot. The purple one is a note saying "freshly
    // compacted, nothing asked of it since", and opening it reads the note.
    const t = new CompactionTracker();
    t.noteStart(A, NOW);
    t.noteFinish([A], NOW + 1_000, false);
    expect(phase(t, [A], NOW + 2_000)).toBe('compacted');
    t.clearSettled([A]); // ← what onDidChangeActive calls
    expect(phase(t, [A], NOW + 3_000)).toBeUndefined();
  });

  it('does NOT take the ring down when the session is opened', () => {
    // Watching a compaction happen does not make it stop happening. This is
    // the whole reason clearSettled is separate from clear.
    const t = new CompactionTracker();
    t.noteStart(A, NOW);
    t.clearSettled([A]);
    expect(phase(t, [A], NOW + 1_000)).toBe('compacting');
  });

  it('clear takes down both — a session that ended is not compacting', () => {
    const t = new CompactionTracker();
    t.noteStart(A, NOW);
    t.clear([A]);
    expect(phase(t, [A], NOW + 1_000)).toBeUndefined();
    expect(t.size).toBe(0);
  });

  it('re-arms on a second compaction, replacing the resting dot', () => {
    const t = new CompactionTracker();
    t.noteStart(A, NOW);
    t.noteFinish([A], NOW + 1_000, false);
    t.noteStart(A, NOW + 2_000);
    expect(phase(t, [A], NOW + 3_000)).toBe('compacting');
  });
});

describe('compaction: the chain', () => {
  it('meets a PreCompact on one generation with its finish on the next', () => {
    // THE case this module's id-list API exists for: a compaction re-mints the
    // session id, so PreCompact arrives under the predecessor and
    // SessionStart(source:'compact') under the successor. They only meet over
    // the chain.
    const t = new CompactionTracker();
    t.noteStart(A, NOW);
    expect(t.noteFinish([B, A], NOW + 5_000, false)).toBe(true);
    // Answered under the successor's id, which is the one the row now carries.
    expect(phase(t, [B, A], NOW + 6_000)).toBe('compacted');
  });

  it('leaves one entry per conversation, seated on the current id', () => {
    const t = new CompactionTracker();
    t.noteStart(A, NOW);
    t.noteFinish([B, A], NOW + 5_000, false);
    expect(t.size).toBe(1);
    // The predecessor's key is gone, so a later reveal of the old id alone
    // cannot resurrect a second phase for the same conversation.
    expect(phase(t, [A], NOW + 6_000)).toBeUndefined();
  });
});

describe('compaction: nothing lasts forever', () => {
  it('drops a ring whose compaction never reported finishing', () => {
    // The crash, the hook that never fired, the /reload-plugins nobody ran. A
    // wrong dot that heals is survivable; one that never does is not.
    const t = new CompactionTracker();
    t.noteStart(A, NOW);
    expect(phase(t, [A], NOW + COMPACTING_STALE_MS - 1)).toBe('compacting');
    expect(phase(t, [A], NOW + COMPACTING_STALE_MS)).toBeUndefined();
  });

  it('rests the purple dot for an hour, then lets the row go quiet', () => {
    const t = new CompactionTracker();
    t.noteStart(A, NOW);
    t.noteFinish([A], NOW, false);
    expect(phase(t, [A], NOW + COMPACTED_REST_MS - 1)).toBe('compacted');
    expect(phase(t, [A], NOW + COMPACTED_REST_MS)).toBeUndefined();
  });

  it('prunes sessions that left the tree, and phases that expired', () => {
    const t = new CompactionTracker();
    t.noteStart(A, NOW);
    t.noteStart(B, NOW);
    // A is gone from the forest; B is still live but its ring has gone stale.
    t.prune(new Set([B]), NOW + COMPACTING_STALE_MS);
    expect(t.size).toBe(0);
  });

  it('keeps a live, unexpired phase across a prune', () => {
    const t = new CompactionTracker();
    t.noteStart(A, NOW);
    t.prune(new Set([A]), NOW + 1_000);
    expect(phase(t, [A], NOW + 1_000)).toBe('compacting');
  });
});

describe('compaction: bad input is never fatal', () => {
  it('ignores a non-finite clock rather than writing a phase it cannot expire', () => {
    const t = new CompactionTracker();
    t.noteStart(A, Number.NaN);
    expect(t.size).toBe(0);
    t.noteStart(A, NOW);
    expect(t.noteFinish([A], Number.NaN, false)).toBe(false);
    expect(phase(t, [A], Number.NaN)).toBeUndefined();
  });

  it('ignores an empty id', () => {
    const t = new CompactionTracker();
    t.noteStart('', NOW);
    expect(t.size).toBe(0);
  });

  it('answers undefined for an empty chain', () => {
    const t = new CompactionTracker();
    t.noteStart(A, NOW);
    expect(t.phaseOf([], NOW, false)).toBeUndefined();
    expect(t.noteFinish([], NOW, false)).toBe(false);
  });
});

// ------------------------------------- the compaction that ends mid-turn

describe('a compaction the turn carries straight on from', () => {
  it('rests NO dot when the conversation is still working', () => {
    // The ordinary shape of auto-compact: it fires when the context fills,
    // mints the successor, and hands straight back to the model for another
    // few minutes of the same turn. "Compacted, and nothing behind it" is
    // false while that is happening, so there is nothing to rest.
    const t = new CompactionTracker();
    t.noteStart(A, NOW);
    expect(t.noteFinish([A], NOW + 5_000, true)).toBe(true);
    expect(phase(t, [A], NOW + 6_000)).toBeUndefined();
    expect(t.size).toBe(0);
  });

  it('so the row is free to say what it has to say when the turn ends', () => {
    // The regression this closes: the dot rested mid-turn was still standing
    // when the turn ended — up to COMPACTED_REST_MS later — so the row said
    // "compacted" in purple at the one moment it had "finished, and waiting on
    // you" to say in red.
    const t = new CompactionTracker();
    t.noteStart(A, NOW);
    t.noteFinish([A], NOW + 5_000, true);
    expect(phase(t, [A], NOW + 20 * 60_000)).toBeUndefined();
  });

  it('still rests the dot when the compaction was the only thing running', () => {
    // The other shape — a `/compact` typed at an idle session — is unchanged,
    // and it is the case the purple dot exists for.
    const t = new CompactionTracker();
    t.noteStart(A, NOW);
    t.noteFinish([A], NOW + 5_000, false);
    expect(phase(t, [A], NOW + 6_000)).toBe('compacted');
  });

  it('reports the finish either way — it did happen', () => {
    const t = new CompactionTracker();
    t.noteStart(A, NOW);
    expect(t.noteFinish([A], NOW + 1, true)).toBe(true);
    // ...and still refuses one that never started.
    expect(t.noteFinish([A], NOW + 2, true)).toBe(false);
  });
});

// ------------------------------------------ the successor as the signal

describe('settleSuperseded: the ring a successor takes down', () => {
  it('settles a ring on a generation that has been replaced', () => {
    // A compaction re-mints the session id; that IS what a successor is. So a
    // generation with one has finished compacting, whatever the hooks did.
    const t = new CompactionTracker();
    t.noteStart(A, NOW);
    t.settleSuperseded(tipOf(A, B), quiet, NOW + 30_000);
    // Re-seated onto the tip, as the resting dot...
    expect(phase(t, [B, A], NOW + 31_000)).toBe('compacted');
    expect(t.size).toBe(1);
  });

  it('is what takes down the ring the three hook signals all missed', () => {
    // All three completion signals name the SUCCESSOR's id while the
    // PreCompact named its predecessor, so all three depend on the chain index
    // having caught up. When the SessionStart beats its own chain fact and the
    // turn then carries on, the roster never produces a busy→quiet edge
    // either — and the ring stood, outranking the amber the row should have
    // been drawing, until COMPACTING_STALE_MS expired it ten minutes later.
    const t = new CompactionTracker();
    t.noteStart(A, NOW);
    // The hook arrives before the chain knows B: no chain member is compacting.
    expect(t.noteFinish([B], NOW + 1_000, false)).toBe(false);
    expect(phase(t, [A], NOW + 2_000)).toBe('compacting'); // the stuck ring
    // One rebuild later the chain knows, and the sweep closes it.
    t.settleSuperseded(tipOf(A, B), quiet, NOW + 3_000);
    expect(phase(t, [B, A], NOW + 4_000)).not.toBe('compacting');
  });

  it('rests no dot when the successor is already working', () => {
    // Same rule as noteFinish's `busy`, reached the other way round.
    const t = new CompactionTracker();
    t.noteStart(A, NOW);
    t.settleSuperseded(tipOf(A, B), () => true, NOW + 30_000);
    expect(phase(t, [B, A], NOW + 31_000)).toBeUndefined();
    expect(t.size).toBe(0);
  });

  it('leaves a generation that is still the tip alone', () => {
    const t = new CompactionTracker();
    t.noteStart(A, NOW);
    t.settleSuperseded((id) => id, quiet, NOW + 30_000);
    expect(phase(t, [A], NOW + 31_000)).toBe('compacting');
  });

  it('never overwrites a LIVE ring on the successor with an older finish', () => {
    // A second compaction already running on the tip outranks a first one that
    // has finished: the row must not go from "compacting" back to "compacted"
    // while a compaction is visibly underway.
    const t = new CompactionTracker();
    t.noteStart(A, NOW);
    t.noteStart(B, NOW + 10_000);
    t.settleSuperseded(tipOf(A, B), quiet, NOW + 20_000);
    expect(phase(t, [B, A], NOW + 21_000)).toBe('compacting');
    expect(t.size).toBe(1); // and the superseded entry is gone, not kept
  });

  it('leaves a settled dot alone — it has already finished', () => {
    const t = new CompactionTracker();
    t.noteStart(A, NOW);
    t.noteFinish([A], NOW + 1_000, false);
    t.settleSuperseded(tipOf(A, B), quiet, NOW + 2_000);
    expect(phase(t, [A], NOW + 3_000)).toBe('compacted');
  });

  it('survives a tipOf or a busy probe that throws', () => {
    // A chain index mid-rebuild is not worth a thrown rebuild.
    const t = new CompactionTracker();
    t.noteStart(A, NOW);
    expect(() => {
      t.settleSuperseded(
        () => {
          throw new Error('no index');
        },
        quiet,
        NOW + 1_000,
      );
    }).not.toThrow();
    expect(phase(t, [A], NOW + 2_000)).toBe('compacting');
    expect(() => {
      t.settleSuperseded(
        tipOf(A, B),
        () => {
          throw new Error('no forest');
        },
        NOW + 3_000,
      );
    }).not.toThrow();
    // Threw on the busy probe → treated as quiet, so the dot still rests.
    expect(phase(t, [B, A], NOW + 4_000)).toBe('compacted');
  });

  it('ignores a non-finite clock', () => {
    const t = new CompactionTracker();
    t.noteStart(A, NOW);
    t.settleSuperseded(tipOf(A, B), quiet, Number.NaN);
    expect(phase(t, [A], NOW + 1_000)).toBe('compacting');
  });
});

// ----------------------------------------------------- isCompacting

describe('isCompacting: the ring asked as a question', () => {
  it('is true only while a compaction is actually in flight', () => {
    // detectTurnTransitions needs to know a busy→quiet edge belongs to a
    // compaction BEFORE it settles it — or it toasts "X finished its turn" at
    // a conversation nobody asked anything of, and leaves the row unseen-done.
    const t = new CompactionTracker();
    expect(t.isCompacting([A])).toBe(false);
    t.noteStart(A, NOW);
    expect(t.isCompacting([A])).toBe(true);
    t.noteFinish([A], NOW + 1_000, false);
    expect(t.isCompacting([A])).toBe(false);
  });

  it('answers over the chain, like every other read here', () => {
    const t = new CompactionTracker();
    t.noteStart(A, NOW);
    expect(t.isCompacting([B])).toBe(false);
    expect(t.isCompacting([B, A])).toBe(true);
  });
});
