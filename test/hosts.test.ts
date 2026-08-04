// test/hosts.test.ts — the ownership classifier, which is the gate every verb
// that could lie about a foreign session now sits behind.
//
// The asymmetry is the whole point and is asserted in both directions: a
// session is 'foreign' ONLY when every recorded fact is absent, and any one of
// them present pulls it back to 'flock'. Being wrong toward 'flock' costs a
// menu entry that refuses; being wrong toward 'foreign' would hide a verb the
// user needs. Both are cheaper than the failure this replaces — a Close that
// wrote a timestamp onto a conversation it could not stop.

import { describe, expect, it } from 'vitest';

import {
  DELEGATED_LOSSES,
  DELEGATES,
  canEndSession,
  delegateFor,
  hostMarker,
  hostOf,
  hostOfChain,
  hostSentence,
  hostTooltipLine,
  isLaunchMode,
  resolveLaunchMode,
} from '../src/hosts';
import type { EditorialRecord } from '../src/types';

const TIP = '0f0000c1-0000-4000-8000-0000000000c1';
const OLD = '0f0000a1-0000-4000-8000-0000000000a1';

describe('hostOf', () => {
  it('is here whenever this window holds the terminal, whatever else says', () => {
    // Direct observation outranks every record: one left behind by a previous
    // window must not make a tab we are holding right now read as somebody
    // else's.
    expect(hostOf({ live: true, boundHere: true })).toBe('here');
    expect(
      hostOf({
        live: false,
        boundHere: true,
        boundWindowId: 'some-other-window',
      }),
    ).toBe('here');
  });

  it('is none for a session the roster does not report', () => {
    // A closed session's record still names the window and the wrap that were
    // holding a process which has since exited. Ownership is not a question it
    // asks, and answering it would put a marker on every archived row.
    expect(hostOf({ live: false, boundHere: false })).toBe('none');
    expect(
      hostOf({ live: false, boundHere: false, tmuxName: 'lineage-x', launchedByUs: true }),
    ).toBe('none');
  });

  it('is flock for a parked wrap, another window, or one we launched', () => {
    expect(hostOf({ live: true, boundHere: false, tmuxName: `lineage-${TIP}` })).toBe(
      'flock',
    );
    expect(hostOf({ live: true, boundHere: false, boundWindowId: 'w-1' })).toBe(
      'flock',
    );
    expect(hostOf({ live: true, boundHere: false, launchedByUs: true })).toBe(
      'flock',
    );
  });

  it('is foreign only when every recorded fact is absent', () => {
    expect(hostOf({ live: true, boundHere: false })).toBe('foreign');
    // A kill-tier park writes `tmux: null` on purpose, and window pruning nulls
    // boundWindowId. Both mean "no longer ours to reach", not "ours".
    expect(
      hostOf({
        live: true,
        boundHere: false,
        tmuxName: null,
        boundWindowId: null,
        launchedByUs: false,
      }),
    ).toBe('foreign');
    // Whitespace is not a window id.
    expect(hostOf({ live: true, boundHere: false, boundWindowId: '   ' })).toBe(
      'foreign',
    );
  });

  it('is none for no facts at all', () => {
    expect(hostOf(undefined)).toBe('none');
    expect(hostOf(null)).toBe('none');
  });
});

describe('hostOfChain', () => {
  function io(
    records: Record<string, Partial<EditorialRecord>>,
    live: readonly string[],
    bound: readonly string[] = [],
  ): Parameters<typeof hostOfChain>[1] {
    return {
      live: (id) => live.includes(id),
      boundHere: (id) => bound.includes(id),
      record: (id) =>
        records[id] === undefined
          ? undefined
          : ({ id, ...records[id] } as EditorialRecord),
    };
  }

  it('reads ownership off an OLDER generation while liveness comes from the tip', () => {
    // The failure this exists to stop: generations.ts deliberately does not
    // carry launchedByUs / boundWindowId / tmux forward, so a re-keyed session
    // of ours has its liveness on the new id and its ownership on the old one.
    // Asking the tip alone called every such session foreign.
    expect(
      hostOfChain([TIP, OLD], io({ [OLD]: { launchedByUs: true } }, [TIP])),
    ).toBe('flock');
  });

  it('still says foreign when no id in the chain carries anything', () => {
    expect(hostOfChain([TIP, OLD], io({ [OLD]: { title: 'named' } }, [TIP]))).toBe(
      'foreign',
    );
  });

  it('is here when any id in the chain is bound in this window', () => {
    expect(hostOfChain([TIP, OLD], io({}, [TIP], [OLD]))).toBe('here');
  });

  it('is none for an empty chain, and survives a throwing dependency', () => {
    expect(hostOfChain([], io({}, []))).toBe('none');
    expect(
      hostOfChain([TIP], {
        live: () => {
          throw new Error('roster gone');
        },
        boundHere: () => {
          throw new Error('registry gone');
        },
        record: () => {
          throw new Error('store gone');
        },
      }),
    ).toBe('none');
  });
});

describe('what a host may be told to do', () => {
  it('withholds ending a session only from the foreign case', () => {
    expect(canEndSession('here')).toBe(true);
    expect(canEndSession('flock')).toBe(true);
    expect(canEndSession('none')).toBe(true);
    expect(canEndSession('foreign')).toBe(false);
  });

  it('marks only the foreign row — a word on every row says nothing', () => {
    expect(hostMarker('foreign')).toBe('elsewhere');
    expect(hostMarker('here')).toBeUndefined();
    expect(hostMarker('flock')).toBeUndefined();
    expect(hostMarker('none')).toBeUndefined();
    expect(hostTooltipLine('foreign')).toContain('outside Flock');
    expect(hostTooltipLine('here')).toBeUndefined();
  });

  it('names the host rather than the verb, and includes a pid when there is one', () => {
    const said = hostSentence('foreign', { label: 'auth', pid: 4242 });
    expect(said).toContain('"auth"');
    expect(said).toContain('pid 4242');
    expect(said).toContain('outside Flock');
    // A bogus pid is left out rather than printed as `pid 0`.
    expect(hostSentence('foreign', { label: 'auth', pid: 0 })).not.toContain('pid');
    expect(hostSentence('none', { label: 'auth' })).toContain('not running');
  });
});

// ------------------------------------------------------- launch delegation

describe('resolveLaunchMode', () => {
  const installed = (ids: readonly string[]) => (id: string) =>
    ids.some((i) => i.toLowerCase() === id.toLowerCase());

  it('accepts the delegate mode when its extension is installed', () => {
    const r = resolveLaunchMode('claudeExtension', installed(['Anthropic.claude-code']));
    expect(r.mode).toBe('claudeExtension');
    expect(r.delegate?.newCommand).toBe('claude-vscode.newConversation');
    expect(r.fellBack).toBe(false);
  });

  it('falls back to flock — and SAYS so — when the extension is absent', () => {
    // The whole point of `fellBack`: a `+` that silently opens nothing is worse
    // than one that opens Flock's own terminal and mentions why.
    const r = resolveLaunchMode('claudeExtension', installed([]));
    expect(r.mode).toBe('flock');
    expect(r.delegate).toBeUndefined();
    expect(r.fellBack).toBe(true);
  });

  it('falls back silently for flock and for junk — neither is a broken setting', () => {
    for (const value of ['flock', undefined, null, 'nonsense', 7]) {
      const r = resolveLaunchMode(value, installed(['Anthropic.claude-code']));
      expect(r.mode).toBe('flock');
      expect(r.fellBack).toBe(false);
    }
  });

  it('treats a throwing host lookup as not installed', () => {
    const r = resolveLaunchMode('claudeExtension', () => {
      throw new Error('no extensions API');
    });
    expect(r.mode).toBe('flock');
    expect(r.fellBack).toBe(true);
  });

  it('guards the setting value', () => {
    expect(isLaunchMode('flock')).toBe(true);
    expect(isLaunchMode('claudeExtension')).toBe(true);
    expect(isLaunchMode('claude')).toBe(false);
    expect(isLaunchMode(undefined)).toBe(false);
  });
});

describe('the delegate table', () => {
  it('names one delegate, which cannot fork', () => {
    // No contributed command of the official extension takes a session id, so
    // the fork verb keeps launching Flock's own terminal in every mode. This
    // asserts the fact rather than the wish.
    expect(DELEGATES).toHaveLength(1);
    expect(DELEGATES.every((d) => d.canFork === false)).toBe(true);
    expect(delegateFor('claudeExtension')?.extensionId).toBe(
      'Anthropic.claude-code',
    );
    expect(delegateFor('flock')).toBeUndefined();
  });

  it('spells out what the mode costs, including the two close verbs', () => {
    const text = DELEGATED_LOSSES.join(' | ');
    expect(text).toContain('tmux');
    expect(text).toContain('Close');
    expect(text).toContain('account');
  });
});
