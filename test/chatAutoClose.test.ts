// test/chatAutoClose.test.ts — the chat auto-close window
// (`lineage.chat.autoCloseMinutes`): which idle chat tabs close themselves.
//
// The wiring in extension.ts supplies the world (bindings, roster status,
// transcript mtimes, the active tab) and closes what comes back; everything
// decided is here, against hand-built facts.

import { describe, expect, it } from 'vitest';

import { chatAutoCloseVictims, type ChatTabFacts } from '../src/chatAutoClose';

const NOW = 1_755_600_000_000; // any fixed moment; only differences matter
const MIN = 60_000;

/** An idle chat, stale by exactly the default window unless overridden. */
function chat(sessionId: string, over: Partial<ChatTabFacts> = {}): ChatTabFacts {
  return {
    sessionId,
    isChat: true,
    isActiveTab: false,
    status: 'idle',
    lastActivityMs: NOW - 30 * MIN,
    ...over,
  };
}

function victims(
  tabs: ChatTabFacts[],
  autoCloseMinutes = 30,
  now = NOW,
): string[] {
  return chatAutoCloseVictims({ now, autoCloseMinutes, tabs });
}

describe('chatAutoCloseVictims', () => {
  it('closes a chat idle for the whole window, and keeps a fresher one', () => {
    expect(
      victims([
        chat('stale'),
        chat('fresh', { lastActivityMs: NOW - 29 * MIN }),
      ]),
    ).toEqual(['stale']);
  });

  it('the window boundary is inclusive — exactly N minutes idle closes', () => {
    expect(victims([chat('edge', { lastActivityMs: NOW - 30 * MIN })])).toEqual([
      'edge',
    ]);
    expect(
      victims([chat('inside', { lastActivityMs: NOW - 30 * MIN + 1 })]),
    ).toEqual([]);
  });

  it('never touches a SESSION tab, however stale — only chats are its to close', () => {
    expect(
      victims([chat('session', { isChat: false, lastActivityMs: NOW - 999 * MIN })]),
    ).toEqual([]);
  });

  it('never touches the active tab — "without use" cannot describe the tab being looked at', () => {
    expect(victims([chat('front', { isActiveTab: true })])).toEqual([]);
  });

  it('spares a busy or waiting chat — a turn in flight, or a dialog someone has to answer', () => {
    expect(victims([chat('busy', { status: 'busy' })])).toEqual([]);
    expect(victims([chat('blocked', { status: 'waiting' })])).toEqual([]);
    // Statuses that mean "nothing is happening" all close: a chat the roster
    // has forgotten (exited) or never met (unknown) is not being interrupted.
    expect(victims([chat('gone', { status: 'exited' })])).toEqual(['gone']);
    expect(victims([chat('offbook', { status: 'unknown' })])).toEqual([
      'offbook',
    ]);
  });

  it('minutes <= 0 disables everything — 0 is the off switch, not a zero-length window', () => {
    const stale = [chat('stale', { lastActivityMs: NOW - 999 * MIN })];
    expect(victims(stale, 0)).toEqual([]);
    expect(victims(stale, -5)).toEqual([]);
    expect(victims(stale, Number.NaN)).toEqual([]);
  });

  it('an unknown age keeps the tab — never closed on the strength of not knowing', () => {
    expect(victims([chat('mystery', { lastActivityMs: Number.NaN })])).toEqual(
      [],
    );
  });

  it('returns every victim, in input order, and nothing else', () => {
    expect(
      victims([
        chat('a'),
        chat('keep-active', { isActiveTab: true }),
        chat('b'),
        chat('keep-busy', { status: 'busy' }),
      ]),
    ).toEqual(['a', 'b']);
  });
});
