// test/chatAutoClose.test.ts — the chat auto-close window
// (`lineage.chat.autoCloseMinutes`): which idle chat tabs close themselves.
//
// The wiring in extension.ts supplies the world (bindings, roster status,
// transcript mtimes, the active tab) and closes what comes back; everything
// decided is here, against hand-built facts.

import { describe, expect, it } from 'vitest';

import {
  chatAutoCloseVictims,
  isChatConversation,
  type ChatChainReads,
  type ChatTabFacts,
} from '../src/chatAutoClose';
import type { EditorialRecord } from '../src/types';

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

// ---------------------------------------------------------------------------
// isChatConversation — THE answer to "is this conversation a chat?", shared by
// every rule that exempts one: solo mode (commands.soloEnforce), the layout
// snapshot and the switch's kill tier (workspaces), and the auto-switch that
// must not re-scope the window for a chat (extension.ts). The cases below are
// the ones each of those got wrong separately.

/** A store of records plus a chain, in the shape the predicate reads. `chain`
 *  maps any generation id to its tip; ids not in it are their own tip. */
function reads(
  records: Record<string, Partial<EditorialRecord>>,
  chain: Record<string, string> = {},
): ChatChainReads {
  const all = Object.fromEntries(
    Object.entries(records).map(([id, r]) => [id, { id, ...r } as EditorialRecord]),
  );
  return {
    getRecord: (id) => all[id],
    tipOf: (id) => chain[id] ?? id,
    allRecords: () => all,
  };
}

describe('isChatConversation', () => {
  it('a chat is a chat, and a session is not', () => {
    const r = reads({ c: { chat: true }, s: {} });
    expect(isChatConversation(r, 'c')).toBe(true);
    expect(isChatConversation(r, 's')).toBe(false);
  });

  it('an id nothing knows about is not a chat', () => {
    expect(isChatConversation(reads({}), 'never-seen')).toBe(false);
  });

  it('answers for the TIP when the flag is on the tip', () => {
    // The terminal is bound under the launch-time id; a re-key moved the row.
    const r = reads({ born: {}, tip: { chat: true } }, { born: 'tip' });
    expect(isChatConversation(r, 'born')).toBe(true);
  });

  it('answers for a REOPENED chat, whose bound id nothing ever flagged', () => {
    // The `chat` flag is written once, at birth. Reopen the chat from Chat
    // History and the terminal runs under a fresh generation: neither that id
    // nor the tip carries the flag, and only the birth record still says what
    // the conversation is. Getting this wrong is a chat that answers
    // "session" — which is a chat in a layout, parked under a grace deadline,
    // and an auto-switch fired off a question.
    const r = reads(
      { born: { chat: true }, again: {} },
      { born: 'again', again: 'again' },
    );
    expect(isChatConversation(r, 'again')).toBe(true);
  });

  it('does not spread across conversations that merely share a store', () => {
    // Another chat in the same project must not make this session one.
    const r = reads(
      { chatBorn: { chat: true }, chatTip: {}, session: {} },
      { chatBorn: 'chatTip' },
    );
    expect(isChatConversation(r, 'session')).toBe(false);
    expect(isChatConversation(r, 'chatTip')).toBe(true);
  });
});
