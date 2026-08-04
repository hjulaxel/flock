// test/pullRequests.test.ts — the `gh` bridge.
//
// This is the only feature in Flock that reaches the network, so the tests are
// weighted toward the ways it is allowed to fail rather than toward the way it
// works:
//
//   1. THE PARSER, against output shaped like real `gh pr list --json …` — and
//      then against malformed output, empty output, a missing binary and a
//      non-zero exit, because on most machines one of those four IS the outcome
//      and every one of them has to look exactly like "this branch has no pull
//      request".
//   2. THE GATE. A cache with the setting off must not spawn `gh` at all, and one
//      whose view is hidden must not either. There is no timer in the module: a
//      render schedules the refresh, so the gate is the whole of "poll only while
//      the view is visible" and a test that let it slip would let the extension
//      talk to GitHub with the sidebar shut.
//   3. ONE LOG LINE, EVER. Not a modal, not a toast, and not a line per refresh:
//      `gh` being absent is a fact about the machine, and repeating it four times
//      an hour would bury the output channel.
//
// The `run` injection point means no `gh` binary is involved anywhere below.

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PullRequestCache,
  createPullRequestArgv,
  openPullRequestCreatePage,
  parsePullRequests,
  pullRequestArgv,
  readPullRequests,
} from '../src/pullRequests';
import { formatPullRequestChip, pullRequestLines } from '../src/viewmodel';
import { setLogSink } from '../src/log';
import type { GitCommandResult, PullRequest } from '../src/types';

/** Shaped like real `gh pr list --json number,title,state,isDraft,headRefName,
 *  url,statusCheckRollup` output: one open request with a passing rollup, one
 *  draft with a run still going, one merged with no checks at all. */
const REAL_OUTPUT = JSON.stringify([
  {
    number: 42,
    title: 'Teach the tree about worktrees',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'feat/x',
    url: 'https://github.com/o/r/pull/42',
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'StatusContext', context: 'ci/lint', state: 'SUCCESS' },
    ],
  },
  {
    number: 43,
    title: 'Spike',
    state: 'OPEN',
    isDraft: true,
    headRefName: 'spike',
    url: 'https://github.com/o/r/pull/43',
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS', conclusion: null },
    ],
  },
  {
    number: 40,
    title: 'Older thing',
    state: 'MERGED',
    isDraft: false,
    headRefName: 'feat/done',
    url: 'https://github.com/o/r/pull/40',
    statusCheckRollup: null,
  },
]);

const ok = (output: string): GitCommandResult => ({ ok: true, output });
const failed = (output: string): GitCommandResult => ({ ok: false, output });

afterEach(() => {
  setLogSink(null);
});

describe('the argv', () => {
  it('asks for every state, bounded, with the fields the row draws', () => {
    const argv = pullRequestArgv();
    expect(argv.slice(0, 2)).toEqual(['pr', 'list']);
    // `--state all` is a deliberate widening of the default (open only): merged is
    // the state that matters most on a branch row, because it is the signal that
    // the worktree beside it is finished and can be removed.
    expect(argv).toContain('--state');
    expect(argv[argv.indexOf('--state') + 1]).toBe('all');
    // Bounded, because `--state all` on a busy repository is otherwise unbounded
    // for the sake of a handful of checked-out branches.
    expect(argv).toContain('--limit');
    expect(argv[argv.indexOf('--json') + 1]).toBe(
      'number,title,state,isDraft,headRefName,url,statusCheckRollup',
    );
    // A read. Nothing in here can change anything on GitHub.
    expect(argv).not.toContain('--web');
  });

  it('creates nothing — it opens a page', () => {
    // `--web` is the design, not a convenience: the title, the body, the base
    // branch and the decision to press the button all stay with the person.
    expect(createPullRequestArgv()).toEqual(['pr', 'create', '--web']);
  });

  it('hands back a fresh argv array every time', () => {
    pullRequestArgv().push('--repo=someone/else');
    expect(pullRequestArgv()).not.toContain('--repo=someone/else');
  });
});

describe('parsePullRequests', () => {
  it('reads real output, keyed by head branch', () => {
    const byBranch = parsePullRequests(REAL_OUTPUT);
    expect([...byBranch.keys()].sort()).toEqual(['feat/done', 'feat/x', 'spike']);
    expect(byBranch.get('feat/x')).toEqual({
      number: 42,
      title: 'Teach the tree about worktrees',
      state: 'open',
      checks: 'pass',
      branch: 'feat/x',
      url: 'https://github.com/o/r/pull/42',
    });
  });

  it('makes draft a state of its own', () => {
    // `isDraft` is the useful half of "open": it is the one you do something
    // different about.
    expect(parsePullRequests(REAL_OUTPUT).get('spike')?.state).toBe('draft');
  });

  it('reads merged and closed, which is what --state all is for', () => {
    expect(parsePullRequests(REAL_OUTPUT).get('feat/done')?.state).toBe('merged');
    const closed = parsePullRequests(
      JSON.stringify([
        { number: 9, state: 'CLOSED', headRefName: 'abandoned', url: 'u', title: 't' },
      ]),
    );
    expect(closed.get('abandoned')?.state).toBe('closed');
  });

  it('reduces a rollup worst-first', () => {
    const checksOf = (rollup: unknown): string | undefined =>
      parsePullRequests(
        JSON.stringify([
          { number: 1, state: 'OPEN', headRefName: 'b', url: 'u', title: 't', statusCheckRollup: rollup },
        ]),
      ).get('b')?.checks;

    // One failure among twenty passes is the thing you need to see. A row that
    // averaged them would be a row that hid it.
    expect(
      checksOf([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'COMPLETED', conclusion: 'FAILURE' },
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
      ]),
    ).toBe('fail');
    // Not finished must never read as passed: a build that has not started would
    // otherwise show a green tick.
    expect(
      checksOf([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'QUEUED', conclusion: null },
      ]),
    ).toBe('pending');
    expect(checksOf([{ status: 'COMPLETED', conclusion: 'SKIPPED' }])).toBe('pass');
    expect(checksOf([{ state: 'PENDING' }])).toBe('pending');
    expect(checksOf([{ state: 'FAILURE' }])).toBe('fail');
  });

  it('reports no checks for a repository that has none', () => {
    const checksOf = (rollup: unknown): string | undefined =>
      parsePullRequests(
        JSON.stringify([
          { number: 1, state: 'OPEN', headRefName: 'b', url: 'u', title: 't', statusCheckRollup: rollup },
        ]),
      ).get('b')?.checks;
    // The common case, and it must cost the row nothing.
    expect(checksOf(null)).toBe('none');
    expect(checksOf([])).toBe('none');
    expect(checksOf(undefined)).toBe('none');
    expect(checksOf('not an array')).toBe('none');
  });

  it('treats a verdict it does not recognise as still running', () => {
    // "We cannot tell" must not read as "fine". A future conclusion word lands
    // here, and pending is the reading that cannot mislead.
    const out = parsePullRequests(
      JSON.stringify([
        {
          number: 1,
          state: 'OPEN',
          headRefName: 'b',
          url: 'u',
          title: 't',
          statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SOMETHING_NEW' }],
        },
      ]),
    );
    expect(out.get('b')?.checks).toBe('pending');
  });

  it('drops an entry with no number or no head branch', () => {
    // Neither has a sane default: one cannot be drawn, the other cannot be joined
    // onto a row. Dropped rather than guessed at.
    const out = parsePullRequests(
      JSON.stringify([
        { number: 0, state: 'OPEN', headRefName: 'a', url: 'u' },
        { number: 5, state: 'OPEN', headRefName: '', url: 'u' },
        { state: 'OPEN', headRefName: 'c', url: 'u' },
        { number: 7, state: 'OPEN', headRefName: 'd', url: 'u' },
      ]),
    );
    expect([...out.keys()]).toEqual(['d']);
  });

  it('prefers the live request when a branch has more than one', () => {
    // `--state all` makes this reachable: a branch that was merged, deleted and
    // re-created has two. Live beats finished, and within a tier the higher number
    // wins — fully ordered, so the chip cannot alternate between two requests
    // every five minutes.
    const out = parsePullRequests(
      JSON.stringify([
        { number: 10, state: 'OPEN', headRefName: 'feat/x', url: 'u10', title: 'live' },
        { number: 11, state: 'MERGED', headRefName: 'feat/x', url: 'u11', title: 'old' },
      ]),
    );
    expect(out.get('feat/x')?.number).toBe(10);

    const reversed = parsePullRequests(
      JSON.stringify([
        { number: 11, state: 'MERGED', headRefName: 'feat/x', url: 'u11', title: 'old' },
        { number: 10, state: 'OPEN', headRefName: 'feat/x', url: 'u10', title: 'live' },
      ]),
    );
    expect(reversed.get('feat/x')?.number).toBe(10);

    const finished = parsePullRequests(
      JSON.stringify([
        { number: 3, state: 'CLOSED', headRefName: 'feat/x', url: 'u3' },
        { number: 4, state: 'MERGED', headRefName: 'feat/x', url: 'u4' },
      ]),
    );
    // Merged outranks closed-unmerged: it is the one that actually landed.
    expect(finished.get('feat/x')?.number).toBe(4);
  });

  it('returns an empty map for malformed output', () => {
    // `gh` printing a warning ahead of its json, an HTML error page from a proxy,
    // a truncated response. All the same thing to a row: no pull request.
    expect(parsePullRequests('not json at all').size).toBe(0);
    expect(parsePullRequests('{"message":"Bad credentials"}').size).toBe(0);
    expect(parsePullRequests('[{"number":1,').size).toBe(0);
    expect(parsePullRequests('<html>502</html>').size).toBe(0);
    // Not an array at the top level.
    expect(parsePullRequests('42').size).toBe(0);
    expect(parsePullRequests('null').size).toBe(0);
  });

  it('returns an empty map for empty output and for non-strings', () => {
    expect(parsePullRequests('').size).toBe(0);
    expect(parsePullRequests('   ').size).toBe(0);
    expect(parsePullRequests('[]').size).toBe(0);
    expect(parsePullRequests(undefined).size).toBe(0);
    expect(parsePullRequests(null).size).toBe(0);
    expect(parsePullRequests(42).size).toBe(0);
  });

  it('survives junk inside an otherwise good array', () => {
    const out = parsePullRequests(
      JSON.stringify([
        null,
        'nonsense',
        42,
        { number: 7, state: 'OPEN', headRefName: 'd', url: 'u' },
      ]),
    );
    expect([...out.keys()]).toEqual(['d']);
  });
});

describe('readPullRequests', () => {
  it('passes the argv and the directory to the runner', async () => {
    const run = vi.fn(
      async (_f: string, _a: string[], _cwd: string, _t: number) => ok(REAL_OUTPUT),
    );
    const read = await readPullRequests('/c/app', { run });
    expect(read.ok).toBe(true);
    expect(read.byBranch.size).toBe(3);
    const [file, args, cwd] = run.mock.calls[0];
    expect(file).toBe('gh');
    expect(args).toEqual(pullRequestArgv());
    expect(cwd).toBe('/c/app');
  });

  it('honours a configured gh binary', async () => {
    const run = vi.fn(
      async (_f: string, _a: string[], _cwd: string, _t: number) => ok('[]'),
    );
    await readPullRequests('/c/app', { run, ghBinary: '/opt/homebrew/bin/gh' });
    expect(run.mock.calls[0][0]).toBe('/opt/homebrew/bin/gh');
  });

  it('reports a non-zero exit as a failure with an empty map', async () => {
    // What an unauthenticated `gh` and a repository with no GitHub remote both
    // look like. Neither is an error the user made.
    const run = vi.fn(async () => failed('gh: To get started with GitHub CLI, run: gh auth login'));
    const read = await readPullRequests('/c/app', { run });
    expect(read.ok).toBe(false);
    expect(read.byBranch.size).toBe(0);
    expect(read.detail).toContain('gh auth login');
  });

  it('reports a missing binary the same way', async () => {
    // The single most likely outcome of this whole feature.
    const run = vi.fn(async () => {
      throw new Error('spawn gh ENOENT');
    });
    const read = await readPullRequests('/c/app', { run });
    expect(read.ok).toBe(false);
    expect(read.byBranch.size).toBe(0);
    expect(read.detail).toContain('ENOENT');
  });

  it('reports success-with-garbage as success and no requests', async () => {
    // The exit status says the command ran; the parse says there is nothing in it.
    // Those are different facts and the cache keeps them apart, because only the
    // first decides how long to wait before asking again.
    const run = vi.fn(async () => ok('not json'));
    const read = await readPullRequests('/c/app', { run });
    expect(read.ok).toBe(true);
    expect(read.byBranch.size).toBe(0);
  });

  it('refuses an empty directory without spawning anything', async () => {
    const run = vi.fn(async () => ok(REAL_OUTPUT));
    expect((await readPullRequests('', { run })).ok).toBe(false);
    expect((await readPullRequests('   ', { run })).ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('openPullRequestCreatePage', () => {
  it('runs `gh pr create --web` in the worktree', async () => {
    const run = vi.fn(
      async (_f: string, _a: string[], _cwd: string, _t: number) => ok(''),
    );
    const result = await openPullRequestCreatePage('/c/app-feat-x', { run });
    expect(result.ok).toBe(true);
    expect(run.mock.calls[0][1]).toEqual(['pr', 'create', '--web']);
    // The WORKTREE, not the main one: which branch the compare page is for is
    // decided by where the command runs.
    expect(run.mock.calls[0][2]).toBe('/c/app-feat-x');
  });

  it('reports a failure rather than throwing one', async () => {
    const run = vi.fn(async () => {
      throw new Error('spawn gh ENOENT');
    });
    const result = await openPullRequestCreatePage('/c/app', { run });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('ENOENT');
    expect((await openPullRequestCreatePage('')).ok).toBe(false);
  });
});

describe('PullRequestCache', () => {
  function runner(answer: () => GitCommandResult) {
    const calls: string[] = [];
    const run = async (_f: string, _a: string[], cwd: string) => {
      calls.push(cwd);
      return answer();
    };
    return { run, calls };
  }

  it('reaches the network NEVER without a gate', async () => {
    // A cache constructed with no `enabled` predicate is off. The default has to
    // be the one that cannot surprise anybody.
    const { run, calls } = runner(() => ok(REAL_OUTPUT));
    const cache = new PullRequestCache({ run });
    expect(cache.get('/c/app', 'feat/x')).toBeUndefined();
    await cache.warm('/c/app');
    expect(calls).toHaveLength(0);
    cache.dispose();
  });

  it('spawns nothing while the gate is shut, and starts when it opens', async () => {
    // Both halves of the gate live behind this predicate in the wiring: the
    // setting, and whether a view that would draw the answer is on screen. With
    // no timer in the module, this is the whole of "poll only while visible".
    let open = false;
    const { run, calls } = runner(() => ok(REAL_OUTPUT));
    const cache = new PullRequestCache({ run, enabled: () => open });

    cache.get('/c/app', 'feat/x');
    await cache.warm('/c/app');
    expect(calls).toHaveLength(0);

    open = true;
    await cache.warm('/c/app');
    expect(calls).toHaveLength(1);
    expect(cache.get('/c/app', 'feat/x')?.number).toBe(42);

    // And it stops answering the moment the gate shuts again, cache or no cache:
    // with the setting off there is no pull request to know about.
    open = false;
    expect(cache.get('/c/app', 'feat/x')).toBeUndefined();
    cache.dispose();
  });

  it('treats a gate that throws as a no', async () => {
    const { run, calls } = runner(() => ok(REAL_OUTPUT));
    const cache = new PullRequestCache({
      run,
      enabled: () => {
        throw new Error('configuration exploded');
      },
    });
    expect(cache.get('/c/app', 'feat/x')).toBeUndefined();
    await cache.warm('/c/app');
    // The network is the one thing here that must never happen by accident.
    expect(calls).toHaveLength(0);
    cache.dispose();
  });

  it('answers undefined on the first read and does not block', () => {
    const { run } = runner(() => ok(REAL_OUTPUT));
    const cache = new PullRequestCache({ run, enabled: () => true });
    // Synchronous by contract — buildViewModel calls this inside a paint.
    expect(cache.get('/c/app', 'feat/x')).toBeUndefined();
    cache.dispose();
  });

  it('serves the probe once it lands, and fires onDidChange once', async () => {
    const { run } = runner(() => ok(REAL_OUTPUT));
    const cache = new PullRequestCache({ run, enabled: () => true });
    const changed = vi.fn();
    cache.onDidChange(changed);
    await cache.warm('/c/app');
    expect(cache.get('/c/app', 'spike')?.state).toBe('draft');
    expect(changed).toHaveBeenCalledTimes(1);
    cache.dispose();
  });

  it('stays silent when a refresh finds the same answer', async () => {
    const { run } = runner(() => ok(REAL_OUTPUT));
    let clock = 0;
    const cache = new PullRequestCache({
      run,
      enabled: () => true,
      ttlMs: 10,
      now: () => clock,
    });
    const changed = vi.fn();
    cache.onDidChange(changed);
    await cache.warm('/c/app');
    clock = 1000;
    await cache.warm('/c/app');
    expect(changed).toHaveBeenCalledTimes(1);
    cache.dispose();
  });

  it('fires when a request is merged under it', async () => {
    let answer = ok(REAL_OUTPUT);
    const { run } = runner(() => answer);
    let clock = 0;
    const cache = new PullRequestCache({
      run,
      enabled: () => true,
      ttlMs: 10,
      now: () => clock,
    });
    const changed = vi.fn();
    cache.onDidChange(changed);
    await cache.warm('/c/app');
    answer = ok(
      JSON.stringify([
        { number: 42, state: 'MERGED', headRefName: 'feat/x', url: 'u', title: 'x' },
      ]),
    );
    clock = 1000;
    await cache.warm('/c/app');
    expect(cache.get('/c/app', 'feat/x')?.state).toBe('merged');
    expect(changed).toHaveBeenCalledTimes(2);
    cache.dispose();
  });

  it('shares one spawn between callers in the same tick', async () => {
    const { run, calls } = runner(() => ok(REAL_OUTPUT));
    const cache = new PullRequestCache({ run, enabled: () => true });
    // What a render does: six branch rows of one repository, all asking at once.
    // Anchoring on the repository is what makes this ONE `gh` call rather than
    // six for an answer that is the same from any checkout.
    cache.get('/c/app', 'main');
    cache.get('/c/app', 'feat/x');
    cache.get('/c/app', 'spike');
    await cache.warm('/c/app');
    expect(calls).toHaveLength(1);
    cache.dispose();
  });

  it('waits longer before retrying a failure than a success', async () => {
    // Failure is the common case and is usually permanent — `gh` is not
    // installed, or this repository is not on GitHub. Retrying on the success
    // schedule would mean spawning a process that cannot work, four times an
    // hour, forever, per repository.
    const { run, calls } = runner(() => failed('gh not found'));
    let clock = 0;
    const cache = new PullRequestCache({
      run,
      enabled: () => true,
      ttlMs: 100,
      failureTtlMs: 10_000,
      now: () => clock,
    });
    await cache.warm('/c/app');
    expect(calls).toHaveLength(1);

    // Past the SUCCESS ttl, nowhere near the failure one.
    clock = 500;
    cache.get('/c/app', 'feat/x');
    await Promise.resolve();
    expect(calls).toHaveLength(1);

    clock = 20_000;
    cache.get('/c/app', 'feat/x');
    await cache.warm('/c/app');
    expect(calls.length).toBeGreaterThan(1);
    cache.dispose();
  });

  it('logs a failure ONCE per repository, and no more', async () => {
    // Not a modal, not a toast, and not a line per refresh.
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    const { run } = runner(() => failed('gh: command not found'));
    let clock = 0;
    const cache = new PullRequestCache({
      run,
      enabled: () => true,
      failureTtlMs: 10,
      now: () => clock,
    });
    await cache.warm('/c/app');
    clock = 1000;
    await cache.warm('/c/app');
    clock = 2000;
    await cache.warm('/c/app');
    const mine = lines.filter((l) => l.includes('/c/app'));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toContain('no pull requests');
    cache.dispose();
  });

  it('reports a later failure again once it has worked in between', async () => {
    // `gh auth login` is a thing people do without restarting their editor, so a
    // repository that starts working must not have its next failure swallowed
    // forever.
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    let answer = failed('gh: not signed in');
    const { run } = runner(() => answer);
    let clock = 0;
    const cache = new PullRequestCache({
      run,
      enabled: () => true,
      ttlMs: 10,
      failureTtlMs: 10,
      now: () => clock,
    });
    await cache.warm('/c/app');
    answer = ok(REAL_OUTPUT);
    clock = 1000;
    await cache.warm('/c/app');
    answer = failed('gh: not signed in');
    clock = 2000;
    await cache.warm('/c/app');
    expect(lines.filter((l) => l.includes('/c/app'))).toHaveLength(2);
    cache.dispose();
  });

  it('refuses the kinds of nothing without spawning', async () => {
    const { run, calls } = runner(() => ok(REAL_OUTPUT));
    const cache = new PullRequestCache({ run, enabled: () => true });
    expect(cache.get('', 'feat/x')).toBeUndefined();
    expect(cache.get('   ', 'feat/x')).toBeUndefined();
    expect(cache.get('/c/app', '')).toBeUndefined();
    expect(calls).toHaveLength(0);
    cache.dispose();
  });

  it('re-probes after invalidate, which is what the settings flip uses', async () => {
    let answer = failed('gh: command not found');
    const { run, calls } = runner(() => answer);
    const cache = new PullRequestCache({
      run,
      enabled: () => true,
      failureTtlMs: 1_000_000,
    });
    await cache.warm('/c/app');
    expect(calls).toHaveLength(1);
    // Somebody installed `gh` and turned the setting on again. Without the
    // invalidate they would sit in front of a remembered "no" for a quarter of an
    // hour.
    answer = ok(REAL_OUTPUT);
    cache.invalidate();
    await cache.warm('/c/app');
    expect(cache.get('/c/app', 'feat/x')?.number).toBe(42);
    cache.dispose();
  });

  it('survives a listener that throws', async () => {
    const { run } = runner(() => ok(REAL_OUTPUT));
    const cache = new PullRequestCache({ run, enabled: () => true });
    const after = vi.fn();
    cache.onDidChange(() => {
      throw new Error('listener exploded');
    });
    cache.onDidChange(after);
    await cache.warm('/c/app');
    expect(after).toHaveBeenCalledTimes(1);
    expect(cache.get('/c/app', 'feat/x')?.number).toBe(42);
    cache.dispose();
  });

  it('answers undefined and probes nothing once disposed', async () => {
    const { run, calls } = runner(() => ok(REAL_OUTPUT));
    const cache = new PullRequestCache({ run, enabled: () => true });
    await cache.warm('/c/app');
    cache.dispose();
    expect(cache.get('/c/app', 'feat/x')).toBeUndefined();
    const before = calls.length;
    cache.get('/c/app', 'feat/x');
    await cache.warm('/c/app');
    expect(calls).toHaveLength(before);
  });
});

// The two formatters live in src/viewmodel.ts, for the reason formatAge does:
// both renderers have to say the same thing, and the viewmodel is the module
// neither of them can skip.
describe('formatPullRequestChip', () => {
  const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
    number: 42,
    title: 'A thing',
    state: 'open',
    checks: 'none',
    branch: 'feat/x',
    url: 'https://example.invalid/42',
    ...over,
  });

  it('leads with the number, which is what you say out loud', () => {
    expect(formatPullRequestChip(pr())).toBe('#42');
  });

  it('adds one glyph for the rollup, and nothing when there is none', () => {
    expect(formatPullRequestChip(pr({ checks: 'pass' }))).toBe('#42 ✓');
    expect(formatPullRequestChip(pr({ checks: 'fail' }))).toBe('#42 ✕');
    expect(formatPullRequestChip(pr({ checks: 'pending' }))).toBe('#42 •');
    expect(formatPullRequestChip(pr({ checks: 'none' }))).toBe('#42');
  });

  it('leaves the state out of the text', () => {
    // Four colours cost no width; four words would cost more than the branch name
    // has to spare. The hover says the word.
    for (const state of ['open', 'draft', 'merged', 'closed'] as const) {
      expect(formatPullRequestChip(pr({ state }))).toBe('#42');
    }
  });

  it('says the state and the checks in words in the hover', () => {
    expect(pullRequestLines(pr({ state: 'draft', checks: 'pending' }))).toEqual([
      'pull request #42 — draft, checks running',
      'A thing',
    ]);
    expect(pullRequestLines(pr({ state: 'merged', checks: 'none' }))[0]).toBe(
      'pull request #42 — merged',
    );
    // A request with no title contributes no second line rather than an empty one.
    expect(pullRequestLines(pr({ title: '   ' }))).toHaveLength(1);
    // And nothing at all with the feature off, which is the default.
    expect(pullRequestLines(undefined)).toEqual([]);
  });
});
