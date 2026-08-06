// test/branchList.test.ts — enumerating the branches that have no checkout.
//
// The same two things test/git.test.ts tests, for the same reasons, plus one that
// is specific to this probe:
//
//   1. the FORMAT, against output captured from a real `git for-each-ref` — this
//      is the contract the branch fold is built on and nothing else in the
//      codebase would notice it changing;
//   2. the CACHE's timing — `get` never blocks, a stale entry keeps answering
//      while its own refresh runs, N callers in one tick share one spawn, and an
//      unchanged result fires no event;
//   3. the CAP AGREEMENT with the New Worktree picker in src/worktrees.ts. A
//      branch that shows in the fold and is then missing from the picker you
//      reach from that fold reads as a bug, and the two lists are built by two
//      argv builders in two modules — so the agreement is asserted rather than
//      commented.
//
// The `run` injection point means no `git` binary is involved anywhere below.

import { describe, expect, it, vi } from 'vitest';

import {
  BranchListCache,
  MAX_LOCAL_BRANCHES,
  branchListArgv,
  parseBranchList,
  readLocalBranchList,
} from '../src/branchList';
import { localBranchArgv } from '../src/worktrees';

/** Captured verbatim from
 *  `git for-each-ref --format=%(refname:short)%09%(committerdate:unix)%09%(objectname) --sort=-committerdate refs/heads/`
 *  in a repository with five local branches, two of which are checked out. */
const REAL_OUTPUT = [
  'feat/x\t1754300000\t1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
  'main\t1754100000\tfb7bf2d6cf045c5b14ecffb272c32978e9216c73',
  'fix/login\t1753900000\t9c1e0a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f',
  'spike/auth\t1753500000\t0f1e2d3c4b5a69788796a5b4c3d2e1f009182736',
  'release/1.4\t1750000000\tdeadbeefcafebabe0123456789abcdef01234567',
  '',
].join('\n');

describe('parseBranchList', () => {
  it('reads a real five-branch listing, newest first', () => {
    const out = parseBranchList(REAL_OUTPUT);
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual({
      name: 'feat/x',
      committedAt: 1754300000,
      head: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
    });
    // git already sorted by -committerdate and the parser must not re-sort: the
    // order on screen is the order git gave us.
    expect(out.map((b) => b.name)).toEqual([
      'feat/x',
      'main',
      'fix/login',
      'spike/auth',
      'release/1.4',
    ]);
  });

  it('keeps a slash in a branch name as one name, not a path', () => {
    expect(parseBranchList(REAL_OUTPUT)[2].name).toBe('fix/login');
  });

  it('keeps a branch whose date is unreadable, dating it 0', () => {
    // The name is the part a row cannot do without; the date only decorates it.
    // 0 rather than NaN or a guess — the sort sends it to the back, and a row
    // showing an age of "1970" would be a lie the parser invented.
    const out = parseBranchList('odd\tnot-a-date\tabc123');
    expect(out).toEqual([{ name: 'odd', committedAt: 0, head: 'abc123' }]);
  });

  it.each([
    ['an empty date field', 'odd\t\tabc123'],
    ['scientific notation', 'odd\t1e9\tabc123'],
    ['a negative number', 'odd\t-5\tabc123'],
    ['a float', 'odd\t1754300000.5\tabc123'],
  ])('refuses %s as a commit date', (_what, line) => {
    // Number() would accept every one of these, and a date read out of a
    // malformed line would then sort among the real ones.
    expect(parseBranchList(line)[0].committedAt).toBe(0);
  });

  it('survives a line with only a name', () => {
    // Forwards-compatibility, the same rule the other two parsers follow: a
    // format that loses a field still yields rows rather than nothing.
    expect(parseBranchList('lonely')).toEqual([
      { name: 'lonely', committedAt: 0, head: '' },
    ]);
  });

  it('drops blank lines rather than inventing a branch called ""', () => {
    expect(parseBranchList('\n\na\t1\tx\n\n')).toEqual([
      { name: 'a', committedAt: 1, head: 'x' },
    ]);
  });

  it('keeps the first of two lines naming one branch', () => {
    const out = parseBranchList('dup\t2\tsecond\ndup\t1\tfirst');
    expect(out).toHaveLength(1);
    expect(out[0].head).toBe('second');
  });

  it.each([
    ['undefined', undefined],
    ['a number', 42],
    ['an empty string', ''],
    ['whitespace', '   \n  '],
  ])('returns [] for %s', (_what, input) => {
    expect(parseBranchList(input)).toEqual([]);
  });
});

describe('branchListArgv', () => {
  it('asks for local branches only, newest first, capped', () => {
    const argv = branchListArgv();
    expect(argv[0]).toBe('for-each-ref');
    expect(argv).toContain('--sort=-committerdate');
    expect(argv).toContain(`--count=${MAX_LOCAL_BRANCHES}`);
    // refs/heads/ and nothing else: a remote-tracking ref is not somewhere a
    // session can run, so listing it would double the rows with things no verb
    // on the row can act on.
    expect(argv[argv.length - 1]).toBe('refs/heads/');
  });

  it('reads three tab-separated fields', () => {
    const format = branchListArgv().find((a) => a.startsWith('--format='));
    expect(format).toBe(
      '--format=%(refname:short)\t%(committerdate:unix)\t%(objectname)',
    );
  });

  it('is a fresh array, so a caller cannot mutate the next call', () => {
    const first = branchListArgv();
    first.push('--all');
    expect(branchListArgv()).not.toContain('--all');
  });

  it('caps at the same count as the New Worktree picker', () => {
    // THE AGREEMENT. Two modules build two argv vectors over the same refs; a
    // branch in the fold that the picker then cannot offer would read as a bug.
    const capOf = (argv: readonly string[]): string | undefined =>
      argv.find((a) => a.startsWith('--count='));
    expect(capOf(branchListArgv())).toBe(capOf(localBranchArgv()));
  });
});

describe('readLocalBranchList', () => {
  it('parses what the runner returns', async () => {
    const run = vi.fn().mockResolvedValue(REAL_OUTPUT);
    const out = await readLocalBranchList('/code/app', { run });
    expect(out).toHaveLength(5);
    expect(run).toHaveBeenCalledWith('git', branchListArgv(), '/code/app', 4000);
  });

  it('honours an injected git binary and timeout', async () => {
    const run = vi.fn().mockResolvedValue('');
    await readLocalBranchList('/code/app', {
      run,
      gitBinary: '/opt/git',
      timeoutMs: 99,
    });
    expect(run).toHaveBeenCalledWith('/opt/git', branchListArgv(), '/code/app', 99);
  });

  it.each([
    ['a blank directory', '   '],
    ['an empty directory', ''],
  ])('returns [] for %s without spawning anything', async (_what, dir) => {
    const run = vi.fn();
    expect(await readLocalBranchList(dir, { run })).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it('returns [] when the runner rejects', async () => {
    // A probe that fails is a directory with no fold, never an exception on a
    // paint path.
    const run = vi.fn().mockRejectedValue(new Error('git exploded'));
    expect(await readLocalBranchList('/code/app', { run })).toEqual([]);
  });

  it('returns [] when the runner throws synchronously', async () => {
    const run = vi.fn(() => {
      throw new Error('no binary');
    });
    expect(await readLocalBranchList('/code/app', { run })).toEqual([]);
  });
});

describe('BranchListCache', () => {
  const twoBranches = 'b\t2\tyy\na\t1\txx\n';

  it('answers [] on the first call and the list once the probe lands', async () => {
    // The contract: `get` NEVER blocks. A paint that needed the answer would be
    // a paint waiting on a subprocess.
    const run = vi.fn().mockResolvedValue(twoBranches);
    const cache = new BranchListCache({ run });
    expect(cache.get('/code/app')).toEqual([]);
    await cache.warm('/code/app');
    expect(cache.get('/code/app').map((b) => b.name)).toEqual(['b', 'a']);
    cache.dispose();
  });

  it('shares one spawn between callers in the same tick', async () => {
    const run = vi.fn().mockResolvedValue(twoBranches);
    const cache = new BranchListCache({ run });
    cache.get('/code/app');
    cache.get('/code/app');
    cache.get('/code/app');
    await cache.warm('/code/app');
    expect(run).toHaveBeenCalledTimes(1);
    cache.dispose();
  });

  it('keeps answering from a stale entry while its refresh runs', async () => {
    let now = 1000;
    const run = vi.fn().mockResolvedValue(twoBranches);
    const cache = new BranchListCache({ run, ttlMs: 100, now: () => now });
    await cache.warm('/code/app');
    now = 5000; // well past the TTL
    // The stale answer, not []: a tree that blanked its branches every TTL would
    // flicker once every thirty seconds.
    expect(cache.get('/code/app').map((b) => b.name)).toEqual(['b', 'a']);
    cache.dispose();
  });

  it('stays silent when a landed probe changed nothing', async () => {
    const run = vi.fn().mockResolvedValue(twoBranches);
    const cache = new BranchListCache({ run, ttlMs: 0 });
    const listener = vi.fn();
    cache.onDidChange(listener);
    await cache.warm('/code/app');
    expect(listener).toHaveBeenCalledTimes(1); // [] -> two branches
    await cache.warm('/code/app');
    expect(listener).toHaveBeenCalledTimes(1); // same answer, no repaint
    cache.dispose();
  });

  it('fires when a branch tip moves, even with the same names', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce('a\t1\told')
      .mockResolvedValueOnce('a\t2\tnew');
    const cache = new BranchListCache({ run, ttlMs: 0 });
    const listener = vi.fn();
    cache.onDidChange(listener);
    await cache.warm('/code/app');
    await cache.warm('/code/app');
    expect(listener).toHaveBeenCalledTimes(2);
    cache.dispose();
  });

  it('fires when the order changes, because the order is what the fold draws', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce('a\t2\txx\nb\t1\tyy')
      .mockResolvedValueOnce('b\t3\tyy\na\t2\txx');
    const cache = new BranchListCache({ run, ttlMs: 0 });
    const listener = vi.fn();
    cache.onDidChange(listener);
    await cache.warm('/code/app');
    await cache.warm('/code/app');
    expect(listener).toHaveBeenCalledTimes(2);
    cache.dispose();
  });

  it('re-probes after invalidate, without waiting out the TTL', async () => {
    const run = vi.fn().mockResolvedValue(twoBranches);
    const cache = new BranchListCache({ run, ttlMs: 999_999 });
    await cache.warm('/code/app');
    expect(run).toHaveBeenCalledTimes(1);
    cache.invalidate('/code/app');
    expect(cache.get('/code/app')).toEqual([]);
    await cache.warm('/code/app');
    expect(run).toHaveBeenCalledTimes(2);
    cache.dispose();
  });

  it('invalidate() with no argument clears everything', async () => {
    const run = vi.fn().mockResolvedValue(twoBranches);
    const cache = new BranchListCache({ run, ttlMs: 999_999 });
    await cache.warm('/a');
    await cache.warm('/b');
    cache.invalidate();
    expect(cache.get('/a')).toEqual([]);
    expect(cache.get('/b')).toEqual([]);
    cache.dispose();
  });

  it('answers [] and spawns nothing once disposed', async () => {
    const run = vi.fn().mockResolvedValue(twoBranches);
    const cache = new BranchListCache({ run });
    await cache.warm('/code/app');
    cache.dispose();
    expect(cache.get('/code/app')).toEqual([]);
    const before = run.mock.calls.length;
    cache.get('/code/app');
    expect(run.mock.calls.length).toBe(before);
  });

  it('survives a listener that throws, and still calls the next one', async () => {
    const run = vi.fn().mockResolvedValue(twoBranches);
    const cache = new BranchListCache({ run, ttlMs: 0 });
    const second = vi.fn();
    cache.onDidChange(() => {
      throw new Error('listener exploded');
    });
    cache.onDidChange(second);
    await cache.warm('/code/app');
    expect(second).toHaveBeenCalled();
    cache.dispose();
  });

  it('a disposed listener stops being called', async () => {
    const run = vi.fn().mockResolvedValue(twoBranches);
    const cache = new BranchListCache({ run, ttlMs: 0 });
    const listener = vi.fn();
    const sub = cache.onDidChange(listener);
    sub.dispose();
    await cache.warm('/code/app');
    expect(listener).not.toHaveBeenCalled();
    cache.dispose();
  });

  it.each([
    ['a blank directory', '   '],
    ['an empty directory', ''],
  ])('answers [] for %s without spawning', (_what, dir) => {
    const run = vi.fn();
    const cache = new BranchListCache({ run });
    expect(cache.get(dir)).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    cache.dispose();
  });
});
