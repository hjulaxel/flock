// test/terminalMatch.test.ts — identifying the open terminal that is running a
// session Flock never launched.
//
// The declines matter more than the matches, and get more tests: the whole
// point of this module is that clicking a row reveals a tab instead of offering
// to fork a duplicate, and the cost of being wrong is a reveal of somebody
// else's conversation. Every ambiguity in the header of src/terminalMatch.ts is
// exercised here.
//
// No workbench: `pidOf`, `terminals`, `roster` and the parent-pid walk are all
// injected, so the process tree under test is an object literal.

import { describe, expect, it } from 'vitest';

import {
  TerminalMatcher,
  ancestorChain,
  matchSessionsToTerminals,
} from '../src/terminalMatch';
import type { RosterEntry } from '../src/types';

const A = '0f00000a-0000-4000-8000-00000000000a';
const B = '0f00000b-0000-4000-8000-00000000000b';

// ------------------------------------------------------------ ancestorChain

/** A process table as `pid -> ppid`. Anything absent has no parent, which is
 *  what `ps` reports for a pid that has gone. */
function tableOf(table: Record<number, number>) {
  return async (pid: number): Promise<number | null> => table[pid] ?? null;
}

describe('ancestorChain', () => {
  it('walks up, tip first, and stops where the table does', async () => {
    // claude 900 in zsh 800, in the pty host 700.
    expect(
      await ancestorChain(900, tableOf({ 900: 800, 800: 700 })),
    ).toEqual([900, 800, 700]);
  });

  it('stops at init rather than reporting pid 1 as an ancestor', async () => {
    // Nothing above init can be a terminal, and a chain containing 1 would
    // match any terminal whose own pid lookup came back wrong.
    expect(await ancestorChain(900, tableOf({ 900: 1 }))).toEqual([900]);
  });

  it('returns the pid alone when the walk cannot proceed', async () => {
    // Not a failure: a session whose process IS the terminal's process still
    // matches at hop 0, which is how Flock launches its own (claude as
    // shellPath).
    expect(await ancestorChain(900, tableOf({}))).toEqual([900]);
    expect(
      await ancestorChain(900, () => {
        throw new Error('no ps here');
      }),
    ).toEqual([900]);
  });

  it('is cycle-safe and bounded', async () => {
    expect(await ancestorChain(900, tableOf({ 900: 800, 800: 900 }))).toEqual([
      900, 800,
    ]);
    // A chain longer than the hop budget is truncated, not followed forever.
    const deep: Record<number, number> = {};
    for (let pid = 100; pid < 130; pid++) deep[pid] = pid + 1;
    expect((await ancestorChain(100, tableOf(deep))).length).toBe(9);
  });

  it('refuses a pid that is not one', async () => {
    expect(await ancestorChain(0, tableOf({}))).toEqual([]);
    expect(await ancestorChain(-1, tableOf({}))).toEqual([]);
    expect(await ancestorChain(1.5, tableOf({}))).toEqual([]);
  });
});

// ------------------------------------------------- matchSessionsToTerminals

describe('matchSessionsToTerminals', () => {
  it('matches a session to the terminal above it', () => {
    const m = matchSessionsToTerminals(
      [{ sessionId: A, chain: [900, 800, 700] }],
      [800, 555],
    );
    expect(m.get(A)).toBe(800);
  });

  it('matches at hop 0, where the session IS the terminal process', () => {
    const m = matchSessionsToTerminals([{ sessionId: A, chain: [900] }], [900]);
    expect(m.get(A)).toBe(900);
  });

  it('declines when no terminal is anywhere in the chain', () => {
    const m = matchSessionsToTerminals(
      [{ sessionId: A, chain: [900, 800] }],
      [555],
    );
    expect(m.size).toBe(0);
  });

  // Refusal 1.
  it('declines a process id that two Terminal objects both report', () => {
    // The API permits it, and we cannot tell which tab to show — so neither.
    const m = matchSessionsToTerminals(
      [{ sessionId: A, chain: [900, 800] }],
      [800, 800],
    );
    expect(m.size).toBe(0);
  });

  // Refusal 2.
  it('declines when the chain reaches two terminals — one inside the other', () => {
    // Both are genuine ancestors; nothing says which layer "the terminal" means.
    const m = matchSessionsToTerminals(
      [{ sessionId: A, chain: [900, 800, 700] }],
      [800, 700],
    );
    expect(m.size).toBe(0);
  });

  // Refusal 3 — the one that actually happens. This is the shape a `/fork` in a
  // panel terminal leaves behind: two claude processes under one shell, both on
  // the roster. Revealing that tab for either row would be showing a tab where
  // only one of the two conversations is.
  it('declines a terminal that two live sessions both sit under', () => {
    const m = matchSessionsToTerminals(
      [
        { sessionId: A, chain: [900, 800] },
        { sessionId: B, chain: [901, 800] },
      ],
      [800],
    );
    expect(m.size).toBe(0);
  });

  it('keeps the unambiguous sessions when a sibling is ambiguous', () => {
    // One bad match must not cost the good one beside it.
    const m = matchSessionsToTerminals(
      [
        { sessionId: A, chain: [900, 800] },
        { sessionId: B, chain: [901, 800] },
        { sessionId: 'c', chain: [902, 810] },
      ],
      [800, 810],
    );
    expect(m.size).toBe(1);
    expect(m.get('c')).toBe(810);
  });

  it('ignores junk pids and empty inputs rather than matching on them', () => {
    expect(matchSessionsToTerminals([], []).size).toBe(0);
    expect(
      matchSessionsToTerminals([{ sessionId: A, chain: [0, -1] }], [0, -1]).size,
    ).toBe(0);
    // A duplicate INSIDE one chain (ps reporting the same pid twice) is not two
    // terminals; it must not trip refusal 2.
    expect(
      matchSessionsToTerminals(
        [{ sessionId: A, chain: [900, 800, 800] }],
        [800],
      ).get(A),
    ).toBe(800);
  });
});

// --------------------------------------------------------- TerminalMatcher

interface FakeTerminal {
  readonly name: string;
  readonly processId: Promise<number | undefined>;
  exitStatus?: unknown;
  shown: number;
  show(preserveFocus?: boolean): void;
}

function fakeTerminal(name: string, pid: number | undefined): FakeTerminal {
  return {
    name,
    processId: Promise.resolve(pid),
    exitStatus: undefined,
    shown: 0,
    show(): void {
      this.shown++;
    },
  };
}

function matcher(
  terminals: FakeTerminal[],
  roster: RosterEntry[],
  table: Record<number, number>,
): TerminalMatcher {
  return new TerminalMatcher({
    terminals: () => terminals as unknown as readonly never[],
    pidOf: async (t) => (t as unknown as FakeTerminal).processId,
    roster: () => roster,
    ppidOf: tableOf(table),
    now: () => 0,
  });
}

describe('TerminalMatcher.reveal', () => {
  it('reveals the panel terminal a hand-run session is inside', async () => {
    // The whole feature: `claude` typed into the bottom panel, clicked in the
    // sidebar, and the tab three inches below it comes forward instead of a
    // dialog offering to fork a copy.
    const shell = fakeTerminal('zsh', 800);
    const other = fakeTerminal('build', 555);
    const m = matcher([shell, other], [{ sessionId: A, pid: 900 }], {
      900: 800,
      800: 700,
    });

    expect(await m.reveal(A)).toBe(true);
    expect(shell.shown).toBe(1);
    expect(other.shown).toBe(0);
    m.dispose();
  });

  it('declines — and touches nothing — when the session is not on the roster', async () => {
    const shell = fakeTerminal('zsh', 800);
    const m = matcher([shell], [{ sessionId: B, pid: 901 }], { 901: 800 });
    expect(await m.reveal(A)).toBe(false);
    expect(shell.shown).toBe(0);
    m.dispose();
  });

  it('declines when the CLI build reports no pid for the row', async () => {
    // Without a pid there is no chain to walk, and a cwd match is not evidence
    // (see the module header). Nothing is revealed.
    const shell = fakeTerminal('zsh', 800);
    const m = matcher([shell], [{ sessionId: A }], {});
    expect(await m.reveal(A)).toBe(false);
    expect(shell.shown).toBe(0);
    m.dispose();
  });

  it('declines when no terminal resolves a process id', async () => {
    const dead = fakeTerminal('never launched', undefined);
    const m = matcher([dead], [{ sessionId: A, pid: 900 }], { 900: 800 });
    expect(await m.reveal(A)).toBe(false);
    m.dispose();
  });

  it('ignores a terminal that has already exited', async () => {
    const gone = fakeTerminal('zsh', 800);
    gone.exitStatus = { code: 0 };
    const m = matcher([gone], [{ sessionId: A, pid: 900 }], { 900: 800 });
    expect(await m.reveal(A)).toBe(false);
    expect(gone.shown).toBe(0);
    m.dispose();
  });

  it('declines when two live sessions share the terminal', async () => {
    const shell = fakeTerminal('zsh', 800);
    const m = matcher(
      [shell],
      [
        { sessionId: A, pid: 900 },
        { sessionId: B, pid: 901 },
      ],
      { 900: 800, 901: 800 },
    );
    expect(await m.reveal(A)).toBe(false);
    expect(shell.shown).toBe(0);
    m.dispose();
  });

  it('finds a re-keyed conversation under any id it has worn', async () => {
    // The roster carries the NEW generation's id; the row was clicked under the
    // old one. Both name one tab, so either is a valid way in.
    const shell = fakeTerminal('zsh', 800);
    const m = matcher([shell], [{ sessionId: B, pid: 900 }], { 900: 800 });
    expect(await m.reveal(A, [B])).toBe(true);
    expect(shell.shown).toBe(1);
    m.dispose();
  });

  it('declines when the chain aliases point at two different tabs', async () => {
    // Two generations of one conversation somehow running in two terminals is
    // not a thing to pick a winner from.
    const first = fakeTerminal('zsh 1', 800);
    const second = fakeTerminal('zsh 2', 810);
    const m = matcher(
      [first, second],
      [
        { sessionId: A, pid: 900 },
        { sessionId: B, pid: 901 },
      ],
      { 900: 800, 901: 810 },
    );
    expect(await m.reveal(A, [B])).toBe(false);
    expect(first.shown).toBe(0);
    expect(second.shown).toBe(0);
    m.dispose();
  });

  it('degrades to nothing on a host with no terminals, and after dispose', async () => {
    const empty = new TerminalMatcher({
      terminals: () => undefined,
      pidOf: async () => undefined,
      roster: () => [{ sessionId: A, pid: 900 }],
      ppidOf: tableOf({}),
    });
    expect(await empty.reveal(A)).toBe(false);
    empty.dispose();

    const shell = fakeTerminal('zsh', 800);
    const m = matcher([shell], [{ sessionId: A, pid: 900 }], { 900: 800 });
    m.dispose();
    expect(await m.reveal(A)).toBe(false);
    expect(shell.shown).toBe(0);
  });

  it('survives a throwing roster and a throwing terminal list', async () => {
    const thrower = new TerminalMatcher({
      terminals: () => {
        throw new Error('no window');
      },
      pidOf: async () => 800,
      roster: () => {
        throw new Error('no roster');
      },
      ppidOf: tableOf({}),
    });
    expect(await thrower.reveal(A)).toBe(false);
    thrower.dispose();
  });

  it('walks the process tree once per pid inside the cache window', async () => {
    // One click asks for every live session's chain, and two sessions under one
    // shell share most of theirs. A `ps` per hop per row per click is what the
    // cache exists to stop.
    const shell = fakeTerminal('zsh', 800);
    let walks = 0;
    const m = new TerminalMatcher({
      terminals: () => [shell] as unknown as readonly never[],
      pidOf: async () => 800,
      roster: () => [{ sessionId: A, pid: 900 }],
      ppidOf: async (pid) => {
        walks++;
        return ({ 900: 800, 800: 700 } as Record<number, number>)[pid] ?? null;
      },
      now: () => 0,
    });
    expect(await m.reveal(A)).toBe(true);
    const first = walks;
    expect(first).toBeGreaterThan(0);
    expect(await m.reveal(A)).toBe(true);
    expect(walks).toBe(first);
    m.dispose();
  });
});
