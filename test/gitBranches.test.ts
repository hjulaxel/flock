// test/gitBranches.test.ts — ahead/behind and dirt.
//
// Three things are worth testing here and the rest is subprocess plumbing:
//
//   1. the PORCELAIN v2 PARSER, against output captured from a real `git status
//      --porcelain=v2 --branch`, because that format is the contract this half of
//      the feature is built on and nothing else in the codebase would notice it
//      changing;
//   2. the CACHE's timing behaviour — that `get` never blocks, that a stale entry
//      keeps answering while its own refresh runs, that N callers in one tick
//      share one spawn, and that an unchanged result fires no event. Those four
//      are the difference between "numbers appear a moment later" and "the
//      sidebar spawns a git process per worktree per poll";
//   3. the two FORMATTERS, which live in src/viewmodel.ts rather than here —
//      how a row reads is a rendering decision and both surfaces have to make it
//      identically, which is also why viewmodel.ts may not import this module
//      (it spawns processes; the viewmodel imports ./types and ./projects and
//      nothing else).
//
// The `run` injection point means no `git` binary is involved anywhere below.

import { describe, expect, it, vi } from 'vitest';

import {
  BranchStatusCache,
  parseBranchStatus,
  readBranchStatus,
  statusArgv,
} from '../src/gitBranches';
import { branchIsDirty, branchStatusLines, formatBranchSync } from '../src/viewmodel';
import type { BranchStatus } from '../src/types';

/** Captured verbatim from `git status --porcelain=v2 --branch` in a worktree two
 *  commits ahead and one behind its upstream, with one modified tracked file,
 *  one staged rename and one file git has never been told about. */
const REAL_OUTPUT = `# branch.oid fb7bf2d6cf045c5b14ecffb272c32978e9216c73
# branch.head feat/x
# branch.upstream origin/feat/x
# branch.ab +2 -1
1 .M N... 100644 100644 100644 9c1e0a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f 9c1e0a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f src/a.ts
2 R. N... 100644 100644 100644 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b R100 src/new.ts	src/old.ts
? notes.md
`;

/** The common case: a checkout with nothing to report. `--branch` always emits
 *  its headers, so even this is never empty output. */
const CLEAN_OUTPUT = `# branch.oid fb7bf2d
# branch.head main
# branch.upstream origin/main
# branch.ab +0 -0
`;

const status = (over: Partial<BranchStatus> = {}): BranchStatus => ({
  ahead: 0,
  behind: 0,
  upstream: 'origin/main',
  dirty: false,
  untracked: false,
  ...over,
});

describe('parseBranchStatus', () => {
  it('reads a real diverged, dirty, untracked worktree', () => {
    expect(parseBranchStatus(REAL_OUTPUT)).toEqual({
      ahead: 2,
      behind: 1,
      upstream: 'origin/feat/x',
      dirty: true,
      untracked: true,
    });
  });

  it('reads a clean, in-sync worktree without inventing anything', () => {
    expect(parseBranchStatus(CLEAN_OUTPUT)).toEqual({
      ahead: 0,
      behind: 0,
      upstream: 'origin/main',
      dirty: false,
      untracked: false,
    });
  });

  it('keeps "no upstream" apart from "in sync"', () => {
    // A branch that tracks nothing has NO branch.upstream and NO branch.ab line.
    // Reporting it as 0/0 would make a spike branch read as up to date with
    // something, which is the one thing the hover must not say.
    const out = parseBranchStatus(
      '# branch.oid abc\n# branch.head spike\n',
    );
    expect(out).toEqual({
      ahead: 0,
      behind: 0,
      upstream: '',
      dirty: false,
      untracked: false,
    });
  });

  it('counts every kind of tracked change as dirty, and only those', () => {
    const dirtyOf = (entry: string): boolean | undefined =>
      parseBranchStatus(`# branch.oid abc\n# branch.head main\n${entry}\n`)?.dirty;
    // 1 = ordinary change, 2 = rename/copy, u = unresolved merge.
    expect(dirtyOf('1 .M N... 100644 100644 100644 a b src/a.ts')).toBe(true);
    expect(dirtyOf('2 R. N... 100644 100644 100644 a b R100 new	old')).toBe(true);
    expect(dirtyOf('u UU N... 100644 100644 100644 100644 a b c src/a.ts')).toBe(true);
    // An untracked path is NOT a tracked change, and an ignored one is not a
    // change at all.
    expect(dirtyOf('? notes.md')).toBe(false);
    expect(dirtyOf('! dist/bundle.js')).toBe(false);
  });

  it('keeps untracked apart from dirty', () => {
    const out = parseBranchStatus(
      '# branch.oid abc\n# branch.head main\n? notes.md\n',
    );
    // Remove Worktree has to name which of the two it is about to delete, so a
    // parser that folded them together would make the confirmation lie.
    expect(out?.dirty).toBe(false);
    expect(out?.untracked).toBe(true);
  });

  it('ignores headers it does not know', () => {
    // `stash`, and whatever git adds next, must not derail the parse.
    const out = parseBranchStatus(
      [
        '# branch.oid abc',
        '# branch.head main',
        '# branch.upstream origin/main',
        '# branch.ab +1 -0',
        '# stash 3',
        '# something.new whatever',
        '',
      ].join('\n'),
    );
    expect(out?.ahead).toBe(1);
    expect(out?.upstream).toBe('origin/main');
  });

  it('drops an unreadable ahead/behind rather than guessing at it', () => {
    const out = parseBranchStatus(
      '# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab ??\n',
    );
    // The upstream is still known; the counts fall back to zero, which reads as
    // "up to date" — the one wrong answer that cannot make a row nag.
    expect(out).toEqual({
      ahead: 0,
      behind: 0,
      upstream: 'origin/main',
      dirty: false,
      untracked: false,
    });
  });

  it('returns undefined for every kind of nothing', () => {
    // EMPTY IS NOT CLEAN. `--branch` always emits headers, so empty output means
    // the command did not run — and a caller reading `dirty: false` off it would
    // be reading it off a probe that never happened.
    expect(parseBranchStatus('')).toBeUndefined();
    expect(parseBranchStatus('   \n  ')).toBeUndefined();
    expect(parseBranchStatus(undefined)).toBeUndefined();
    expect(parseBranchStatus(null)).toBeUndefined();
    expect(parseBranchStatus(42)).toBeUndefined();
    // Entry lines with no header at all are not a --branch status, whatever else
    // they are.
    expect(parseBranchStatus('1 .M N... 100644 100644 100644 a b src/a.ts\n')).toBeUndefined();
  });

  it('handles CRLF, because Windows', () => {
    expect(
      parseBranchStatus(
        '# branch.oid abc\r\n# branch.head main\r\n# branch.ab +1 -2\r\n? a.txt\r\n',
      ),
    ).toEqual({
      ahead: 1,
      behind: 2,
      upstream: '',
      dirty: false,
      untracked: true,
    });
  });
});

describe('readBranchStatus', () => {
  it('passes the read-only argv and the directory to the runner', async () => {
    const run = vi.fn(
      async (_f: string, _a: string[], _cwd: string, _t: number) => REAL_OUTPUT,
    );
    const out = await readBranchStatus('/Users/x/code/app-feat-x', { run });
    expect(out?.ahead).toBe(2);
    const [file, args, cwd] = run.mock.calls[0];
    expect(file).toBe('git');
    // The whole argv, asserted exactly. `--porcelain=v2 --branch` is one spawn
    // for both facts, and nothing in it can write.
    expect(args).toEqual(['status', '--porcelain=v2', '--branch']);
    expect(cwd).toBe('/Users/x/code/app-feat-x');
  });

  it('hands back a fresh argv array every time', () => {
    // A caller that mutated a shared constant would change what every later
    // probe runs.
    const a = statusArgv();
    a.push('--ignored');
    expect(statusArgv()).toEqual(['status', '--porcelain=v2', '--branch']);
  });

  it('honours a configured git binary', async () => {
    const run = vi.fn(
      async (_f: string, _a: string[], _cwd: string, _t: number) => '',
    );
    await readBranchStatus('/repo', { run, gitBinary: '/opt/homebrew/bin/git' });
    expect(run.mock.calls[0][0]).toBe('/opt/homebrew/bin/git');
  });

  it('resolves to undefined rather than throwing when git fails', async () => {
    const boom = vi.fn(async () => {
      throw new Error('not a git repository');
    });
    await expect(readBranchStatus('/tmp', { run: boom })).resolves.toBeUndefined();
  });

  it('refuses an empty directory without spawning anything', async () => {
    const run = vi.fn(async () => REAL_OUTPUT);
    expect(await readBranchStatus('', { run })).toBeUndefined();
    expect(await readBranchStatus('   ', { run })).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });
});

describe('BranchStatusCache', () => {
  /** A runner whose answer the test controls, counting how often it is asked. */
  function runner(answer: () => string) {
    const calls: string[] = [];
    const run = async (_f: string, _a: string[], cwd: string) => {
      calls.push(cwd);
      return answer();
    };
    return { run, calls };
  }

  it('answers undefined on the first read and does not block', () => {
    const { run } = runner(() => REAL_OUTPUT);
    const cache = new BranchStatusCache({ run });
    // Synchronous by contract — buildViewModel calls this inside a paint.
    expect(cache.get('/repo')).toBeUndefined();
    cache.dispose();
  });

  it('serves the probe once it lands, and fires onDidChange exactly once', async () => {
    const { run } = runner(() => REAL_OUTPUT);
    const cache = new BranchStatusCache({ run });
    const changed = vi.fn();
    cache.onDidChange(changed);

    expect((await cache.warm('/repo'))?.ahead).toBe(2);
    expect(cache.get('/repo')?.behind).toBe(1);
    expect(changed).toHaveBeenCalledTimes(1);
    cache.dispose();
  });

  it('stays silent when a refresh finds the same answer', async () => {
    const { run } = runner(() => REAL_OUTPUT);
    let clock = 0;
    const cache = new BranchStatusCache({ run, ttlMs: 10, now: () => clock });
    const changed = vi.fn();
    cache.onDidChange(changed);

    await cache.warm('/repo');
    expect(changed).toHaveBeenCalledTimes(1);

    // Past the TTL, so this re-probes — but the answer is identical, and a
    // repaint every TTL forever is exactly what the equality check prevents.
    clock = 1000;
    await cache.warm('/repo');
    expect(changed).toHaveBeenCalledTimes(1);
    cache.dispose();
  });

  it('fires when a file is saved into a clean checkout', async () => {
    let answer = CLEAN_OUTPUT;
    const { run } = runner(() => answer);
    let clock = 0;
    const cache = new BranchStatusCache({ run, ttlMs: 10, now: () => clock });
    const changed = vi.fn();
    cache.onDidChange(changed);

    await cache.warm('/repo');
    expect(cache.get('/repo')?.dirty).toBe(false);

    answer = REAL_OUTPUT;
    clock = 1000;
    await cache.warm('/repo');
    expect(cache.get('/repo')?.dirty).toBe(true);
    expect(changed).toHaveBeenCalledTimes(2);
    cache.dispose();
  });

  it('fires when a readable status becomes unreadable, and back', async () => {
    // undefined is a real answer, not the absence of one: a worktree that has
    // been removed under us must stop reporting numbers.
    let answer = REAL_OUTPUT;
    const { run } = runner(() => answer);
    let clock = 0;
    const cache = new BranchStatusCache({ run, ttlMs: 10, now: () => clock });
    const changed = vi.fn();
    cache.onDidChange(changed);

    await cache.warm('/repo');
    answer = '';
    clock = 1000;
    await cache.warm('/repo');
    expect(cache.get('/repo')).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(2);
    cache.dispose();
  });

  it('shares one spawn between callers in the same tick', async () => {
    const { run, calls } = runner(() => REAL_OUTPUT);
    const cache = new BranchStatusCache({ run });
    // What a render does: the chip row and the hover asking about the same
    // worktree before any probe has landed.
    cache.get('/repo');
    cache.get('/repo');
    cache.get('/repo');
    await cache.warm('/repo');
    expect(calls.filter((c) => c === '/repo')).toHaveLength(1);
    cache.dispose();
  });

  it('keeps serving a stale entry while its refresh is in flight', async () => {
    let answer = REAL_OUTPUT;
    const { run } = runner(() => answer);
    let clock = 0;
    const cache = new BranchStatusCache({ run, ttlMs: 10, now: () => clock });

    await cache.warm('/repo');
    expect(cache.get('/repo')?.ahead).toBe(2);

    // Past the TTL: this `get` schedules a refresh AND must still answer with
    // what it has. A blank frame here is a number that vanishes and comes back
    // every fifteen seconds.
    answer = CLEAN_OUTPUT;
    clock = 1000;
    expect(cache.get('/repo')?.ahead).toBe(2);
    cache.dispose();
  });

  it('re-probes after invalidate without waiting out the TTL', async () => {
    let answer = CLEAN_OUTPUT;
    const { run, calls } = runner(() => answer);
    const cache = new BranchStatusCache({ run, ttlMs: 1_000_000 });

    await cache.warm('/repo');
    expect(calls).toHaveLength(1);

    // What the two worktree verbs do: they know something changed.
    answer = REAL_OUTPUT;
    cache.invalidate('/repo');
    await cache.warm('/repo');
    expect(cache.get('/repo')?.ahead).toBe(2);
    cache.dispose();
  });

  it('survives a listener that throws', async () => {
    const { run } = runner(() => REAL_OUTPUT);
    const cache = new BranchStatusCache({ run });
    const after = vi.fn();
    cache.onDidChange(() => {
      throw new Error('listener exploded');
    });
    cache.onDidChange(after);

    await cache.warm('/repo');
    expect(after).toHaveBeenCalledTimes(1);
    expect(cache.get('/repo')?.ahead).toBe(2);
    cache.dispose();
  });

  it('answers undefined and probes nothing once disposed', async () => {
    const { run, calls } = runner(() => REAL_OUTPUT);
    const cache = new BranchStatusCache({ run });
    await cache.warm('/repo');
    cache.dispose();
    expect(cache.get('/repo')).toBeUndefined();
    const before = calls.length;
    cache.get('/repo');
    expect(calls).toHaveLength(before);
  });
});

describe('formatBranchSync', () => {
  it('says nothing at all about a clean, in-sync checkout', () => {
    // The default state of every checkout anybody has. A row that spent width on
    // it would spend it on every row.
    expect(formatBranchSync(status())).toBe('');
    // And nothing about one that was never probed, which on a row is the same
    // thing.
    expect(formatBranchSync(undefined)).toBe('');
  });

  it('puts ahead before behind', () => {
    expect(formatBranchSync(status({ ahead: 2 }))).toBe('↑2');
    expect(formatBranchSync(status({ behind: 1 }))).toBe('↓1');
    expect(formatBranchSync(status({ ahead: 3, behind: 2 }))).toBe('↑3 ↓2');
  });

  it('says nothing about uncommitted work, which is not about the upstream', () => {
    // The `*` used to be the last token of this string and now sits against the
    // branch NAME instead — see branchIsDirty. This assertion is the whole of
    // that move: a checkout with changes and nothing to push reports nothing
    // here, because there is nothing to say about where it stands.
    expect(formatBranchSync(status({ dirty: true }))).toBe('');
    expect(formatBranchSync(status({ ahead: 3, behind: 2, dirty: true }))).toBe(
      '↑3 ↓2',
    );
  });

  it('draws one mark for dirt, whichever kind it is', () => {
    // A count of changed files is a number nobody acts on; the existence of
    // uncommitted work is the whole of what the row can usefully warn about.
    expect(branchIsDirty(status({ untracked: true }))).toBe(true);
    expect(branchIsDirty(status({ dirty: true }))).toBe(true);
    expect(branchIsDirty(status({ dirty: true, untracked: true }))).toBe(true);
    expect(branchIsDirty(status())).toBe(false);
    // Never probed is not "clean" — but on a row the two draw the same, and
    // this is the surface that has to pick one.
    expect(branchIsDirty(undefined)).toBe(false);
  });

  it('ignores a nonsense count rather than drawing it', () => {
    expect(formatBranchSync(status({ ahead: Number.NaN }))).toBe('');
    expect(formatBranchSync(status({ behind: -3 }))).toBe('');
  });
});

describe('branchStatusLines', () => {
  it('contributes nothing for a status that was never read', () => {
    // The hover of an unprobed row is the hover it always had.
    expect(branchStatusLines(undefined)).toEqual([]);
  });

  it('says "up to date" where the row says nothing', () => {
    // The one place the difference between "clean and in sync" and "not read
    // yet" is worth a sentence.
    expect(branchStatusLines(status())).toEqual(['up to date with origin/main']);
  });

  it('says a branch tracks nothing rather than reporting a zero', () => {
    expect(branchStatusLines(status({ upstream: '' }))).toEqual([
      'no upstream branch',
    ]);
  });

  it('names what the branch is ahead of', () => {
    expect(branchStatusLines(status({ ahead: 2, behind: 1 }))).toEqual([
      '2 ahead, 1 behind origin/main',
    ]);
    expect(branchStatusLines(status({ ahead: 2 }))).toEqual([
      '2 ahead origin/main',
    ]);
  });

  it('names which kind of uncommitted work there is', () => {
    expect(branchStatusLines(status({ dirty: true }))[1]).toBe(
      'uncommitted changes',
    );
    expect(branchStatusLines(status({ untracked: true }))[1]).toBe(
      'untracked files',
    );
    expect(branchStatusLines(status({ dirty: true, untracked: true }))[1]).toBe(
      'uncommitted changes and untracked files',
    );
  });
});
