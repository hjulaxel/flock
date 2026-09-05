// test/procs.test.ts — the process-tree reaper.
//
// Every effect is injected (exec, kill, isAlive, sleep), so the whole ladder
// — walk before the kill, verify, SIGTERM, verify again, SIGKILL — runs here
// against a fake process table without spawning anything. The tmux-side
// composition (killTmuxSessionTree) is covered in test/tmux.test.ts.

import { describe, expect, it } from 'vitest';

import {
  descendantsOf,
  listDescendants,
  listPidFacts,
  orphanRescueDecision,
  parsePsPidFacts,
  parsePsPpids,
  reapSurvivors,
} from '../src/procs';

describe('parsePsPpids', () => {
  it('reads the ragged whitespace ps actually prints', () => {
    const table = parsePsPpids('    1     0\n  100     1\n42 100\n');
    expect(table.get(100)).toBe(1);
    expect(table.get(42)).toBe(100);
  });

  it('skips garbage lines rather than failing the walk', () => {
    const table = parsePsPpids('PID PPID\n100 1\nnot a line\n-3 1\n\n');
    expect([...table.keys()]).toEqual([100]);
  });
});

describe('descendantsOf', () => {
  const table = new Map<number, number>([
    // claude (100) → 3 MCP wrappers → their servers; an unrelated tree at 500.
    [100, 1],
    [101, 100],
    [102, 100],
    [103, 100],
    [201, 101],
    [202, 102],
    [500, 1],
    [501, 500],
  ]);

  it('walks the whole subtree, root excluded, parents before children', () => {
    const found = descendantsOf(100, table);
    expect(found.slice(0, 3).sort()).toEqual([101, 102, 103]);
    expect(found.slice(3).sort()).toEqual([201, 202]);
  });

  it('never strays into a sibling tree — identical binaries elsewhere are safe', () => {
    expect(descendantsOf(100, table)).not.toContain(501);
    expect(descendantsOf(500, table)).toEqual([501]);
  });

  it('a corrupt table with a cycle cannot loop', () => {
    const cyclic = new Map<number, number>([
      [2, 1],
      [1, 2],
    ]);
    expect(descendantsOf(1, cyclic)).toEqual([2]);
  });
});

describe('listDescendants', () => {
  it('walks via the injected exec', async () => {
    const asked: string[][] = [];
    const found = await listDescendants(100, async (cmd, args) => {
      asked.push([cmd, ...args]);
      return '100 1\n101 100\n201 101\n';
    });
    expect(asked).toEqual([['ps', '-axo', 'pid=,ppid=']]);
    expect(found.sort()).toEqual([101, 201]);
  });

  it('a broken ps yields nothing — the reap degrades, never throws', async () => {
    await expect(
      listDescendants(100, async () => {
        throw new Error('no ps here');
      }),
    ).resolves.toEqual([]);
  });

  it('refuses a nonsense root outright', async () => {
    await expect(listDescendants(-1)).resolves.toEqual([]);
    await expect(listDescendants(Number.NaN)).resolves.toEqual([]);
  });
});

describe('reapSurvivors', () => {
  /** A fake process world: pids in `alive` respond to signals by dying (or
   *  not, for the `stubborn`). */
  function world(aliveAtStart: number[], stubborn: number[] = []) {
    const alive = new Set(aliveAtStart);
    const signals: Array<[number, string]> = [];
    return {
      alive,
      signals,
      deps: {
        isAlive: (pid: number) => alive.has(pid),
        kill: (pid: number, sig: NodeJS.Signals) => {
          signals.push([pid, sig]);
          if (sig === 'SIGTERM' && stubborn.includes(pid)) return;
          alive.delete(pid);
        },
        sleep: async () => {},
        waitMs: 0,
      },
    };
  }

  it('signals nobody when the tree exited on its own — the ordinary outcome', async () => {
    const w = world([]);
    const out = await reapSurvivors([101, 102], w.deps);
    expect(out).toEqual({ exited: 2, termed: 0, killed: 0 });
    expect(w.signals).toEqual([]);
  });

  it('SIGTERMs survivors, and only them', async () => {
    const w = world([102]);
    const out = await reapSurvivors([101, 102], w.deps);
    expect(out).toEqual({ exited: 1, termed: 1, killed: 0 });
    expect(w.signals).toEqual([[102, 'SIGTERM']]);
  });

  it('escalates to SIGKILL only on what survived the SIGTERM', async () => {
    const w = world([101, 102], [102]);
    const out = await reapSurvivors([101, 102], w.deps);
    expect(out).toEqual({ exited: 0, termed: 2, killed: 1 });
    expect(w.signals).toEqual([
      [101, 'SIGTERM'],
      [102, 'SIGTERM'],
      [102, 'SIGKILL'],
    ]);
  });

  it('an ESRCH mid-ladder is the outcome we wanted, not an error', async () => {
    const alive = new Set([101]);
    const out = await reapSurvivors([101], {
      isAlive: (pid) => alive.has(pid),
      kill: () => {
        const err = new Error('gone') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        alive.delete(101);
        throw err;
      },
      sleep: async () => {},
      waitMs: 0,
    });
    expect(out.termed).toBe(1);
    expect(out.killed).toBe(0);
  });

  it('an empty target list costs nothing — not even the wait', async () => {
    let slept = 0;
    const out = await reapSurvivors([], {
      sleep: async () => {
        slept++;
      },
    });
    expect(out).toEqual({ exited: 0, termed: 0, killed: 0 });
    expect(slept).toBe(0);
  });
});

// ------------------------------------------- window-close orphan rescue
//
// The persisted half of the bare tier: a window close kills the pty root via
// VS Code itself, so the reap has to happen from a snapshot written BEFORE
// the death — possibly a long time before the next activation reads it. The
// decision is pure; what it authorizes is exactly the three-check proof in
// the procs.ts header (exists + start-time identity + orphaned to PID 1).

describe('parsePsPidFacts', () => {
  it('reads pid, ppid and the lstart tail, collapsing its ragged padding', () => {
    const table = parsePsPidFacts(
      '  100     1 Sat Aug 23 07:00:00 2026\n' +
        '42 100 Mon Aug  4 09:05:00 2026\n',
    );
    expect(table.get(100)).toEqual({ ppid: 1, start: 'Sat Aug 23 07:00:00 2026' });
    // "Aug  4" (padded day) and "Aug 4" must compare equal across the
    // snapshot and the verification — the collapse is the identity check.
    expect(table.get(42)?.start).toBe('Mon Aug 4 09:05:00 2026');
  });

  it('skips garbage lines rather than failing the rescue', () => {
    const table = parsePsPidFacts('PID PPID STARTED\nnope\n100 1 Sat Aug 23 07:00:00 2026\n');
    expect([...table.keys()]).toEqual([100]);
  });
});

describe('listPidFacts', () => {
  it('sweeps the whole table (never `-p`, which fails when any pid is gone) and filters', async () => {
    const asked: string[][] = [];
    const facts = await listPidFacts([101, 999], async (cmd, args) => {
      asked.push([cmd, ...args]);
      return '101 1 Sat Aug 23 07:00:00 2026\n102 101 Sat Aug 23 07:00:01 2026\n';
    });
    expect(asked).toEqual([['ps', '-axo', 'pid=,ppid=,lstart=']]);
    expect(facts.get(101)?.ppid).toBe(1);
    expect(facts.has(102)).toBe(false); // present but not asked for
    expect(facts.has(999)).toBe(false); // asked for but gone
  });

  it('a broken ps yields no facts — and no facts means no signal', async () => {
    await expect(
      listPidFacts([101], async () => {
        throw new Error('no ps here');
      }),
    ).resolves.toEqual(new Map());
  });
});

describe('orphanRescueDecision', () => {
  const START = 'Sat Aug 23 07:00:00 2026';
  const saved = [{ pid: 101, start: START }];

  it('reaps a pid that exists, wears the snapshotted start time, and hangs off PID 1', () => {
    const d = orphanRescueDecision(saved, new Map([[101, { ppid: 1, start: START }]]));
    expect(d).toEqual({ reap: [101], ownerLikelyAlive: false });
  });

  it('a pid that exited needs nothing', () => {
    expect(orphanRescueDecision(saved, new Map())).toEqual({
      reap: [],
      ownerLikelyAlive: false,
    });
  });

  it('a RECYCLED pid — same number, different start — is never signalled', () => {
    // Hours may separate the crash from this activation; the number alone is
    // not identity. Not "owner alive" either: whoever owns the recycled pid,
    // it is not the snapshotted process.
    const d = orphanRescueDecision(
      saved,
      new Map([[101, { ppid: 1, start: 'Sun Aug 24 09:00:00 2026' }]]),
    );
    expect(d).toEqual({ reap: [], ownerLikelyAlive: false });
  });

  it('a still-PARENTED pid is spared and marks the owner alive — the reload/live-window guard', () => {
    // A window reload revives the SAME processes with the SAME start times;
    // what tells them from orphans is that they still hang off a live claude
    // root, not PID 1. ownerLikelyAlive is what keeps the ledger file in
    // place for the owner that is still refreshing it.
    const d = orphanRescueDecision(
      [...saved, { pid: 102, start: START }],
      new Map([
        [101, { ppid: 1, start: START }],
        [102, { ppid: 500, start: START }],
      ]),
    );
    expect(d).toEqual({ reap: [101], ownerLikelyAlive: true });
  });

  it('junk entries in a persisted ledger are skipped, never signalled', () => {
    const d = orphanRescueDecision(
      [
        { pid: -1, start: START },
        { pid: 101, start: '' },
        { pid: 101, start: START },
        { pid: 101, start: START }, // duplicate — counted once
      ],
      new Map([[101, { ppid: 1, start: START }]]),
    );
    expect(d.reap).toEqual([101]);
  });
});

// ------------------------------------------------- the real ps, once each
//
// Everything above injects its `ps` output, which is what makes the ladder
// testable — and what lets a machine whose `ps` rejects our flags pass every
// test while reaping nothing. These run the REAL sweeps once, against this
// process, so a `ps` that does not accept `-axo` (BusyBox on Alpine) or prints
// `lstart` in a shape parsePsPidFacts cannot read fails here, on every OS in
// the CI matrix that has a `ps`, instead of on a user's machine.

describe('the ps sweeps, against this machine', () => {
  const posix = process.platform === 'win32' ? it.skip : it;

  posix('listDescendants walks the real table: this process hangs off its parent', async () => {
    const kids = await listDescendants(process.ppid);
    expect(kids).toContain(process.pid);
  });

  posix('listPidFacts reads a real start time and parent for this process', async () => {
    const facts = await listPidFacts([process.pid]);
    const fact = facts.get(process.pid);
    expect(fact).toBeDefined();
    expect(fact?.ppid).toBe(process.ppid);
    expect((fact?.start ?? '').length).toBeGreaterThan(0);
    // Two sweeps a moment apart must agree on the identity string, or the
    // orphan rescue can never match a snapshot against a later verification.
    const again = await listPidFacts([process.pid]);
    expect(again.get(process.pid)?.start).toBe(fact?.start);
  });
});
