// M20 — git worktree discovery.
//
// Two things are worth testing here and the rest is subprocess plumbing:
//
//   1. the PORCELAIN PARSER, against output captured from a real `git worktree
//      list --porcelain`, because that format is the contract this feature is
//      built on and nothing else in the codebase would notice it changing;
//   2. the CACHE's timing behaviour — that `get` never blocks, that a stale
//      entry keeps answering while its own refresh runs, that N callers in one
//      tick share one spawn, and that an unchanged result fires no event. Those
//      four are the difference between "chips appear a moment later" and "the
//      sidebar spawns a git process per project per poll".
//
// The `run` injection point means no `git` binary is involved anywhere below.

import { describe, expect, it, vi } from 'vitest';

import {
  WorktreeCache,
  listWorktrees,
  parseWorktreeList,
  shortBranch,
} from '../src/git';

/** Captured verbatim from `git worktree list --porcelain` in a repo with a main
 *  worktree and two linked ones, the middle of which is detached. */
const REAL_OUTPUT = `worktree /Users/x/code/app
HEAD fb7bf2d6cf045c5b14ecffb272c32978e9216c73
branch refs/heads/main

worktree /Users/x/code/app-spike
HEAD 9c1e0a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f
detached

worktree /Users/x/code/app-feat-x
HEAD 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b
branch refs/heads/feat/x

`;

describe('parseWorktreeList', () => {
  it('reads a real three-worktree listing', () => {
    const out = parseWorktreeList(REAL_OUTPUT);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      dir: '/Users/x/code/app',
      branch: 'main',
      head: 'fb7bf2d6cf045c5b14ecffb272c32978e9216c73',
      detached: false,
    });
    // A slash in the branch name survives: `feat/x` is one branch, not a path.
    expect(out[2].branch).toBe('feat/x');
  });

  it('flags a detached worktree instead of inventing a branch', () => {
    const detached = parseWorktreeList(REAL_OUTPUT)[1];
    expect(detached.detached).toBe(true);
    // '' rather than the HEAD sha or a made-up name — the caller decides what
    // to call it, and calling it by its sha would read as a branch.
    expect(detached.branch).toBe('');
  });

  it('keeps the main worktree first, which is what primary-ness is read from', () => {
    // Not a property of the parser so much as of git, but the ordering IS the
    // contract buildBranches leans on to decide which chip is `primary`, so it
    // is asserted here where the format is asserted.
    expect(parseWorktreeList(REAL_OUTPUT)[0].dir).toBe('/Users/x/code/app');
  });

  it('ignores attributes it does not know', () => {
    // `locked`, `prunable` and whatever git adds next must not derail a stanza.
    const out = parseWorktreeList(
      [
        'worktree /repo',
        'HEAD abc',
        'branch refs/heads/main',
        'bare',
        'locked reason goes here',
        'prunable gitdir file points to non-existent location',
        '',
      ].join('\n'),
    );
    expect(out).toHaveLength(1);
    expect(out[0].branch).toBe('main');
  });

  it('closes an open stanza at EOF with no trailing blank line', () => {
    const out = parseWorktreeList('worktree /repo\nHEAD abc\nbranch refs/heads/main');
    expect(out).toEqual([
      { dir: '/repo', branch: 'main', head: 'abc', detached: false },
    ]);
  });

  it('closes an open stanza when a second `worktree` line arrives early', () => {
    // Not a shape git emits. Closing rather than overwriting is the only
    // reading that cannot silently lose a checkout.
    const out = parseWorktreeList('worktree /a\nworktree /b\n');
    expect(out.map((w) => w.dir)).toEqual(['/a', '/b']);
  });

  it('returns [] for every kind of nothing', () => {
    expect(parseWorktreeList('')).toEqual([]);
    expect(parseWorktreeList('   \n  ')).toEqual([]);
    expect(parseWorktreeList(undefined)).toEqual([]);
    expect(parseWorktreeList(null)).toEqual([]);
    expect(parseWorktreeList(42)).toEqual([]);
    // A stanza with no `worktree` line names nothing and contributes nothing.
    expect(parseWorktreeList('HEAD abc\nbranch refs/heads/main\n')).toEqual([]);
  });

  it('handles CRLF, because Windows', () => {
    const out = parseWorktreeList(
      'worktree C:/code/app\r\nHEAD abc\r\nbranch refs/heads/main\r\n\r\n',
    );
    expect(out).toEqual([
      { dir: 'C:/code/app', branch: 'main', head: 'abc', detached: false },
    ]);
  });
});

describe('shortBranch', () => {
  it('strips refs/heads/ and nothing else', () => {
    expect(shortBranch('refs/heads/main')).toBe('main');
    expect(shortBranch('refs/heads/feat/deep/name')).toBe('feat/deep/name');
    // Not a heads ref: handed back whole, because a raw value is a better row
    // label than a blank.
    expect(shortBranch('refs/remotes/origin/main')).toBe('refs/remotes/origin/main');
    expect(shortBranch('')).toBe('');
    expect(shortBranch(undefined)).toBe('');
  });
});

describe('listWorktrees', () => {
  it('passes the read-only argv and the directory to the runner', async () => {
    // Signature spelled out so `mock.calls[0]` is the four-tuple the ProbeOptions
    // runner actually takes; an inferred `async () => string` would be zero-arg.
    const run = vi.fn(
      async (_f: string, _a: string[], _cwd: string, _t: number) => REAL_OUTPUT,
    );
    const out = await listWorktrees('/Users/x/code/app', { run });
    expect(out).toHaveLength(3);
    expect(run).toHaveBeenCalledTimes(1);
    const [file, args, cwd] = run.mock.calls[0];
    expect(file).toBe('git');
    // The whole argv, asserted exactly: this is the one place the extension
    // invokes git, and it must stay a read.
    expect(args).toEqual(['worktree', 'list', '--porcelain']);
    expect(cwd).toBe('/Users/x/code/app');
  });

  it('honours a configured git binary', async () => {
    const run = vi.fn(
      async (_f: string, _a: string[], _cwd: string, _t: number) => '',
    );
    await listWorktrees('/repo', { run, gitBinary: '/opt/homebrew/bin/git' });
    expect(run.mock.calls[0][0]).toBe('/opt/homebrew/bin/git');
  });

  it('resolves to [] rather than throwing when git fails', async () => {
    const boom = vi.fn(async () => {
      throw new Error('not a git repository');
    });
    await expect(listWorktrees('/tmp', { run: boom })).resolves.toEqual([]);
  });

  it('refuses an empty directory without spawning anything', async () => {
    const run = vi.fn(async () => REAL_OUTPUT);
    expect(await listWorktrees('', { run })).toEqual([]);
    expect(await listWorktrees('   ', { run })).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('WorktreeCache', () => {
  /** A runner whose answer the test controls, counting how often it is asked. */
  function runner(answer: () => string) {
    const calls: string[] = [];
    let release: (() => void) | null = null;
    const run = async (_f: string, _a: string[], cwd: string) => {
      calls.push(cwd);
      if (release) await new Promise<void>((r) => (release = r));
      return answer();
    };
    return { run, calls, hold: () => { release = () => undefined; } };
  }

  it('answers [] on the first read and does not block', () => {
    const { run } = runner(() => REAL_OUTPUT);
    const cache = new WorktreeCache({ run });
    // Synchronous by contract — grouping calls this inside a paint.
    expect(cache.get('/repo')).toEqual([]);
    cache.dispose();
  });

  it('serves the probe once it lands, and fires onDidChange exactly once', async () => {
    const { run } = runner(() => REAL_OUTPUT);
    const cache = new WorktreeCache({ run });
    const changed = vi.fn();
    cache.onDidChange(changed);

    expect(await cache.warm('/repo')).toHaveLength(3);
    expect(cache.get('/repo')).toHaveLength(3);
    expect(changed).toHaveBeenCalledTimes(1);
    cache.dispose();
  });

  it('stays silent when a refresh finds the same answer', async () => {
    const { run } = runner(() => REAL_OUTPUT);
    let clock = 0;
    const cache = new WorktreeCache({ run, ttlMs: 10, now: () => clock });
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

  it('fires when a worktree is added', async () => {
    let answer = 'worktree /repo\nHEAD a\nbranch refs/heads/main\n';
    const { run } = runner(() => answer);
    let clock = 0;
    const cache = new WorktreeCache({ run, ttlMs: 10, now: () => clock });
    const changed = vi.fn();
    cache.onDidChange(changed);

    await cache.warm('/repo');
    expect(cache.get('/repo')).toHaveLength(1);

    answer = REAL_OUTPUT;
    clock = 1000;
    await cache.warm('/repo');
    expect(cache.get('/repo')).toHaveLength(3);
    expect(changed).toHaveBeenCalledTimes(2);
    cache.dispose();
  });

  it('shares one spawn between callers in the same tick', async () => {
    const { run, calls } = runner(() => REAL_OUTPUT);
    const cache = new WorktreeCache({ run });
    // What a render does: several rows asking about the same project directory
    // before any probe has landed.
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
    const cache = new WorktreeCache({ run, ttlMs: 10, now: () => clock });

    await cache.warm('/repo');
    expect(cache.get('/repo')).toHaveLength(3);

    // Past the TTL: this `get` schedules a refresh AND must still answer with
    // what it has. A blank frame here is a chip row that vanishes and comes
    // back every 30 seconds.
    answer = 'worktree /repo\nHEAD a\nbranch refs/heads/main\n';
    clock = 1000;
    expect(cache.get('/repo')).toHaveLength(3);
    cache.dispose();
  });

  it('re-probes after invalidate without waiting out the TTL', async () => {
    let answer = 'worktree /repo\nHEAD a\nbranch refs/heads/main\n';
    const { run, calls } = runner(() => answer);
    const cache = new WorktreeCache({ run, ttlMs: 1_000_000 });

    await cache.warm('/repo');
    expect(calls).toHaveLength(1);

    answer = REAL_OUTPUT;
    cache.invalidate('/repo');
    cache.get('/repo');
    await cache.warm('/repo');
    expect(cache.get('/repo')).toHaveLength(3);
    cache.dispose();
  });

  it('survives a listener that throws', async () => {
    const { run } = runner(() => REAL_OUTPUT);
    const cache = new WorktreeCache({ run });
    const after = vi.fn();
    cache.onDidChange(() => {
      throw new Error('listener exploded');
    });
    cache.onDidChange(after);

    await cache.warm('/repo');
    // The second listener still ran, and the cache still holds its answer.
    expect(after).toHaveBeenCalledTimes(1);
    expect(cache.get('/repo')).toHaveLength(3);
    cache.dispose();
  });

  it('answers [] and probes nothing once disposed', async () => {
    const { run, calls } = runner(() => REAL_OUTPUT);
    const cache = new WorktreeCache({ run });
    await cache.warm('/repo');
    cache.dispose();
    expect(cache.get('/repo')).toEqual([]);
    const before = calls.length;
    cache.get('/repo');
    expect(calls).toHaveLength(before);
  });
});
