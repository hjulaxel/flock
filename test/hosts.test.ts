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
  delegateRefusal,
  hostMarker,
  hostOf,
  hostOfChain,
  hostSentence,
  hostTooltipLine,
  isLaunchMode,
  resolveLaunchMode,
} from '../src/hosts';
import type { AccountProfile, EditorialRecord } from '../src/types';

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
    // `--fork-session` is a launch-time CLI flag no contributed command
    // carries, so the fork verb keeps launching Flock's own terminal in every
    // mode. This asserts the fact rather than the wish.
    expect(DELEGATES).toHaveLength(1);
    expect(DELEGATES.every((d) => d.canFork === false)).toBe(true);
    expect(delegateFor('claudeExtension')?.extensionId).toBe(
      'Anthropic.claude-code',
    );
    expect(delegateFor('flock')).toBeUndefined();
  });

  it('can OPEN an existing session, through the deep-link command', () => {
    // `primaryEditor.open`, not `editor.open`: the latter overwrites the
    // user's claudeCode.preferredLocation as a side effect when called
    // without an explicit view column, and their placement is not ours to
    // change. The former is what the extension's own claude-code://open
    // deep link runs.
    expect(delegateFor('claudeExtension')?.openCommand).toBe(
      'claude-vscode.primaryEditor.open',
    );
  });

  it('spells out what the mode costs, including the two close verbs', () => {
    const text = DELEGATED_LOSSES.join(' | ');
    expect(text).toContain('tmux');
    expect(text).toContain('Close');
    expect(text).toContain('account');
  });
});

// ------------------------------------------------------- delegateRefusal
//
// The routing gate for a delegated NEW launch. The delegate runs its command
// on the machine's own default login, so the only routings it may be handed
// are the ones that resolve to exactly that — no account at all, or the
// default account. Everything else must open in Flock's own terminal, because
// handing it over would silently ignore the routing: the wrong CLI outright,
// or a launch that looks routed in the tree while its transcript is written
// where the account's next resume will never look.

describe('delegateRefusal', () => {
  const profile = (over: Partial<AccountProfile> = {}): AccountProfile => ({
    id: 'work',
    provider: 'claude',
    label: 'Work (Max)',
    order: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  it('lets an unrouted launch and the default account through', () => {
    // These resolve to an empty environment — exactly what the delegate runs
    // anyway, so refusing them would break delegation for the common case.
    expect(delegateRefusal(null)).toBeNull();
    expect(delegateRefusal(undefined)).toBeNull();
    expect(delegateRefusal(profile())).toBeNull();
    // An empty extraEnv is still the default account — the same rule
    // isDefaultAccount applies.
    expect(delegateRefusal(profile({ extraEnv: {} }))).toBeNull();
  });

  it('refuses another CLI, naming the account and the CLI', () => {
    const reason = delegateRefusal(
      profile({ provider: 'codex', label: 'Work (Codex)' }),
    );
    expect(reason).toContain('Work (Codex)');
    expect(reason).toContain('codex');
    expect(delegateRefusal(profile({ provider: 'gemini' }))).not.toBeNull();
  });

  it('refuses an account with its own config directory', () => {
    // The delegate would start the session on the default login, and the
    // transcript would land where this account's next resume will not look.
    const reason = delegateRefusal(profile({ configDir: '/work/.claude' }));
    expect(reason).toContain('Work (Max)');
  });

  it('refuses an API-key account for its environment, not its CLI', () => {
    // `generic` runs claude — the CLI test passes it — but its key would not
    // be carried by a launch the delegate performs.
    expect(
      delegateRefusal(
        profile({ provider: 'generic', extraEnv: { ANTHROPIC_API_KEY: 'k' } }),
      ),
    ).not.toBeNull();
  });
});
