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
    expect(t.noteFinish([A], NOW + 5_000)).toBe(true);
    expect(phase(t, [A], NOW + 6_000)).toBe('compacted');
  });

  it('withholds the resting dot while something IS behind it', () => {
    // "compacted and nothing running" stops being true the instant the roster
    // says the session is working again — but the phase itself survives, so a
    // turn that starts and ends leaves the dot where it was.
    const t = new CompactionTracker();
    t.noteStart(A, NOW);
    t.noteFinish([A], NOW + 5_000);
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
    expect(t.noteFinish([A], NOW)).toBe(false);
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
    settled.noteFinish([A], NOW + 1_000);
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
    t.noteFinish([A], NOW + 1_000);
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
    t.noteFinish([A], NOW + 1_000);
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
    expect(t.noteFinish([B, A], NOW + 5_000)).toBe(true);
    // Answered under the successor's id, which is the one the row now carries.
    expect(phase(t, [B, A], NOW + 6_000)).toBe('compacted');
  });

  it('leaves one entry per conversation, seated on the current id', () => {
    const t = new CompactionTracker();
    t.noteStart(A, NOW);
    t.noteFinish([B, A], NOW + 5_000);
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
    t.noteFinish([A], NOW);
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
    expect(t.noteFinish([A], Number.NaN)).toBe(false);
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
    expect(t.noteFinish([], NOW)).toBe(false);
  });
});
