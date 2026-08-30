// test/switcher.test.ts — the tree as the session switcher.
//
// Two decisions, both pure: which conversation is in front, and whether the
// tree is allowed to move its own selection onto it. The gestures that USE
// those answers (the follow subscription, lineage.focusSessionsView, the
// alt+left binding) are wiring in extension.ts and the manifest.

import { describe, expect, it } from 'vitest';

import { frontSession, mayFollowSelection } from '../src/switcher';
import type { FrontSessionInput } from '../src/switcher';

const A = '0f00000a-0000-4000-8000-00000000000a';
const B = '0f00000b-0000-4000-8000-00000000000b';
const C = '0f00000c-0000-4000-8000-00000000000c';

function ask(over: Partial<FrontSessionInput> = {}): string | null {
  return frontSession({
    activeSessionId: null,
    lastFrontSessionId: null,
    tipOf: (id) => id,
    hasRow: () => true,
    ...over,
  });
}

describe('frontSession: which conversation am I in', () => {
  it('says nothing when nothing is in front', () => {
    expect(ask()).toBeNull();
  });

  it('takes the active terminal first', () => {
    expect(ask({ activeSessionId: A, lastFrontSessionId: B })).toBe(A);
  });

  it('falls back to the last conversation Flock put on screen', () => {
    // The delegated-open case: the conversation lives in the Claude Code
    // extension's panel, no terminal changed hands, and the id we passed to
    // its open command is the only handle there is.
    expect(ask({ activeSessionId: null, lastFrontSessionId: B })).toBe(B);
  });

  it('resolves onto the chain tip — the id the ROW carries', () => {
    // A terminal keeps its launch-time binding across every resume, /clear and
    // compaction the conversation goes through; the row collapsed onto the tip
    // long ago. Selecting the bound id would select nothing.
    expect(
      ask({
        activeSessionId: A,
        tipOf: (id) => (id === A ? C : id),
        hasRow: (id) => id === C,
      }),
    ).toBe(C);
  });

  it('falls back to the raw id when the chain has not been learnt yet', () => {
    // A fresh launch, before the hooks or the archive scan have connected the
    // generations: the row it does have is better than no row.
    expect(
      ask({
        activeSessionId: A,
        tipOf: (id) => (id === A ? C : id),
        hasRow: (id) => id === A,
      }),
    ).toBe(A);
  });

  it('refuses a conversation with no row at all', () => {
    // A silent no-op reveal would leave the LAST selection standing, which is
    // worse than doing nothing: the tree would then be confidently pointing at
    // the wrong conversation.
    expect(ask({ activeSessionId: A, hasRow: () => false })).toBeNull();
  });

  it('refuses an id that is not a session id', () => {
    expect(ask({ activeSessionId: 'not-a-uuid' })).toBeNull();
  });

  it('survives a throwing chain index', () => {
    expect(
      ask({
        activeSessionId: A,
        tipOf: () => {
          throw new Error('index rebuilding');
        },
      }),
    ).toBe(A);
  });
});

describe('mayFollowSelection: may the tree move its own selection', () => {
  it('follows while the mode is flock and the tree is on screen', () => {
    expect(mayFollowSelection({ mode: 'flock', treeVisible: true })).toBe(true);
  });

  it('stops having an opinion in claude mode', () => {
    expect(mayFollowSelection({ mode: 'claude', treeVisible: true })).toBe(
      false,
    );
  });

  it('never springs an unseen tree open', () => {
    // TreeView.reveal on a view that is not showing OPENS it — so without this
    // gate, a collapsed Flock sidebar (or a different activity-bar container
    // entirely) would pop open every time the user clicked between terminals.
    // There is also nothing to keep in sync in a tree nobody is looking at.
    expect(mayFollowSelection({ mode: 'flock', treeVisible: false })).toBe(
      false,
    );
  });
});
