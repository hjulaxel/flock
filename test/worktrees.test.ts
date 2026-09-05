// test/worktrees.test.ts — the write side of worktrees.
//
// Two things here are not like the rest of the test suite, and both are the
// point of the file:
//
//   1. THE ARGV IS ASSERTED EXACTLY. These are the only two git commands in the
//      extension that change a repository, and the difference between
//      `worktree remove` and `worktree remove --force` is somebody's uncommitted
//      work. A test that checked "calls git with something about remove" would
//      not be a test of this.
//   2. THE REFUSALS ARE TESTED WITHOUT A WORKBENCH. planWorktreeRemoval is pure
//      precisely so that the rules — never the main worktree, a second Yes over
//      dirt, say so when a session is living in there — can be exercised without
//      scripting a modal. Rules that can only be reached through a dialog are
//      rules nobody re-checks after a refactor.
//
// The argv forms below were verified against a real git in a throwaway
// repository before they were written down here: `worktree add -b <b> -- <path>`,
// `worktree add -- <path> <b>`, `worktree remove [--force] -- <path>`, and git's
// own refusal ("contains modified or untracked files, use --force to delete it")
// which is the boundary the second confirmation stands at.

import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_WORKTREE_PATH_PATTERN,
  branchDeleteArgv,
  describeGitCommand,
  isCheckedOut,
  isExistingWorktree,
  localBranchArgv,
  parseLocalBranches,
  parseRevListCount,
  planBranchFate,
  planWorktreeRemoval,
  readAheadCount,
  readLocalBranches,
  revListCountArgv,
  runBranchDelete,
  runWorktreeAdd,
  runWorktreeRemove,
  sessionsInWorktree,
  slugifyBranch,
  suggestBranchName,
  worktreeAddArgv,
  worktreePathFor,
  worktreeRemoveArgv,
} from '../src/worktrees';
import type { BranchStatus, GitCommandResult } from '../src/types';
import { contributedSettings } from './manifest';

const status = (over: Partial<BranchStatus> = {}): BranchStatus => ({
  ahead: 0,
  behind: 0,
  upstream: 'origin/main',
  dirty: false,
  untracked: false,
  ...over,
});

describe('slugifyBranch', () => {
  it('turns the common case into one path component', () => {
    // Every `feat/…` branch has a separator in it, which is the whole reason
    // this function exists.
    expect(slugifyBranch('feat/x')).toBe('feat-x');
    expect(slugifyBranch('feature/discussion-points')).toBe(
      'feature-discussion-points',
    );
  });

  it('keeps the case, unlike the account slugger', () => {
    // A branch called JIRA-4021 becoming a directory called jira-4021 is a small
    // daily lie about what is checked out there. accounts.ts folds case because
    // it is minting an id Flock compares; this is a name a person types into cd.
    expect(slugifyBranch('JIRA-4021')).toBe('JIRA-4021');
    expect(slugifyBranch('Feat/Thing')).toBe('Feat-Thing');
  });

  it('keeps the result from being anything but a name', () => {
    // A leading dot is invisible in a file manager, and `..` is the parent
    // directory. Both are stripped, and the second is the one that matters.
    expect(slugifyBranch('..')).toBe('');
    expect(slugifyBranch('.hidden')).toBe('hidden');
    expect(slugifyBranch('/absolute/thing')).toBe('absolute-thing');
    expect(slugifyBranch('a/../../b')).toBe('a-b');
  });

  it('collapses runs and trims the edges', () => {
    expect(slugifyBranch('a//b')).toBe('a-b');
    expect(slugifyBranch('---a---')).toBe('a');
    expect(slugifyBranch('feat/x/')).toBe('feat-x');
  });

  it('folds accents rather than dropping the letters', () => {
    expect(slugifyBranch('feature/café')).toBe('feature-cafe');
  });

  it('keeps letters that are not Latin at all', () => {
    // A branch written in Chinese or Cyrillic used to slug to '', and an empty
    // slug is a refusal — the branch could never get a worktree, and the modal
    // blamed the worktreePath setting for it.
    expect(slugifyBranch('功能-测试')).toBe('功能-测试');
    expect(slugifyBranch('исправление-ошибки')).toBe('исправление-ошибки');
    expect(slugifyBranch('feature/日本語')).toBe('feature-日本語');
    // Two branches sharing an ASCII prefix must not slug to the same name, or
    // they would be offered the same path.
    expect(slugifyBranch('feature/中文')).toBe('feature-中文');
    // The vowel marks NFKD splits off stay attached to their letter.
    expect(slugifyBranch('feature/फ़ीचर')).toBe('feature-फ़ीचर');
  });

  it('caps the length, and does not leave a separator at the cut', () => {
    const long = `feat/${'a'.repeat(200)}`;
    const out = slugifyBranch(long);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith('-')).toBe(false);
    // A name that is nothing but separators past the cap must not come back as a
    // trailing dash either.
    expect(slugifyBranch(`${'x'.repeat(59)}/y`)).toBe('x'.repeat(59));
  });

  it('returns "" for anything with nothing usable in it', () => {
    // Every caller must treat this as a refusal: a path built from an empty slug
    // lands somewhere nobody asked for.
    expect(slugifyBranch('')).toBe('');
    expect(slugifyBranch('///')).toBe('');
    expect(slugifyBranch('...')).toBe('');
    expect(slugifyBranch(undefined)).toBe('');
    expect(slugifyBranch(42)).toBe('');
  });
});

describe('worktreePathFor', () => {
  it('puts a new checkout beside the main one, by default', () => {
    expect(
      worktreePathFor({ repoDir: '/Users/x/code/app', branch: 'feat/x' }),
    ).toBe('/Users/x/code/app-feat-x');
  });

  it('ships the same default the manifest does', () => {
    // Two copies of a default is one copy too many; this is the cross-check that
    // keeps them equal. The pure builder cannot ask a workspace configuration
    // for it, which is why the constant exists at all.
    expect(contributedSettings()['lineage.git.worktreePath']?.default).toBe(
      DEFAULT_WORKTREE_PATH_PATTERN,
    );
  });

  it('resolves a relative pattern against the repository, not the process', () => {
    // A VS Code window's cwd is whatever folder it happened to open, so the same
    // pattern would land somewhere different in every window.
    expect(
      worktreePathFor({
        pattern: '../trees/${repo}/${branch}',
        repoDir: '/Users/x/code/app',
        branch: 'feat/x',
      }),
    ).toBe('/Users/x/code/trees/app/feat-x');
  });

  it('uses an absolute pattern as written', () => {
    expect(
      worktreePathFor({
        pattern: '/tmp/wt/${repo}-${branch}',
        repoDir: '/Users/x/code/app',
        branch: 'feat/x',
      }),
    ).toBe('/tmp/wt/app-feat-x');
  });

  it('expands a leading ~/', () => {
    // Without this, an obviously-path-shaped setting would silently create a
    // directory literally named `~`, which is the kind of thing you find months
    // later.
    expect(
      worktreePathFor({
        pattern: '~/worktrees/${branch}',
        repoDir: '/Users/x/code/app',
        branch: 'feat/x',
      }),
    ).toBe(path.join(os.homedir(), 'worktrees', 'feat-x'));
  });

  it('falls back to the default for a blank pattern', () => {
    for (const pattern of ['', '   ', undefined]) {
      expect(worktreePathFor({ pattern, repoDir: '/c/app', branch: 'x' })).toBe(
        '/c/app-x',
      );
    }
  });

  it('refuses a pattern with no placeholder in it', () => {
    // It would resolve to ONE path for every branch, so the second worktree
    // would collide with the first. Refused rather than corrected: the setting is
    // wrong and the user has to see that.
    expect(
      worktreePathFor({
        pattern: '../worktree',
        repoDir: '/Users/x/code/app',
        branch: 'feat/x',
      }),
    ).toBe('');
  });

  it('refuses a branch that slugs to nothing, and a missing repository', () => {
    expect(worktreePathFor({ repoDir: '/c/app', branch: '///' })).toBe('');
    expect(worktreePathFor({ repoDir: '', branch: 'x' })).toBe('');
    expect(worktreePathFor({ repoDir: '   ', branch: 'x' })).toBe('');
  });
});

describe('the argv', () => {
  it('creates a branch with -b and checks an existing one out without it', () => {
    // Not a preference: `-b` for a branch that exists fails, and its absence for
    // one that does not fails too. The flag IS which half of the picker was used.
    expect(
      worktreeAddArgv({ path: '/c/app-feat-x', branch: 'feat/x', create: true }),
    ).toEqual(['worktree', 'add', '-b', 'feat/x', '--', '/c/app-feat-x']);
    expect(
      worktreeAddArgv({ path: '/c/app-feat-x', branch: 'feat/x', create: false }),
    ).toEqual(['worktree', 'add', '--', '/c/app-feat-x', 'feat/x']);
  });

  it('stops option parsing before the path', () => {
    // A branch name may begin with `-`, and a path may come from a pattern that
    // does too.
    const argv = worktreeAddArgv({ path: '-weird', branch: '-b', create: false });
    expect(argv[argv.indexOf('--') + 1]).toBe('-weird');
  });

  it('adds --force only when asked, and never by default', () => {
    expect(worktreeRemoveArgv({ path: '/c/app-x', force: false })).toEqual([
      'worktree',
      'remove',
      '--',
      '/c/app-x',
    ]);
    expect(worktreeRemoveArgv({ path: '/c/app-x', force: true })).toEqual([
      'worktree',
      'remove',
      '--force',
      '--',
      '/c/app-x',
    ]);
  });

  it('reads local branches most recently committed first, bounded', () => {
    const argv = localBranchArgv();
    expect(argv[0]).toBe('for-each-ref');
    expect(argv).toContain('--sort=-committerdate');
    expect(argv).toContain('refs/heads/');
    // Bounded: a repository with more refs than this has refs nobody is working
    // in, and git's own --count is cheaper than reading them all and slicing.
    expect(argv.some((a) => a.startsWith('--count='))).toBe(true);
  });
});

describe('describeGitCommand', () => {
  it('shows the directory, because a command without one depends on where you run it', () => {
    expect(
      describeGitCommand('/Users/x/code/app', [
        'worktree',
        'add',
        '--',
        '/Users/x/code/app-feat-x',
        'feat/x',
      ]),
    ).toBe('git -C /Users/x/code/app worktree add -- /Users/x/code/app-feat-x feat/x');
  });

  it('quotes anything with a space in it', () => {
    // The string is never executed by anything — it exists to be read — so the
    // quoting only has to be honest about where the argument boundaries are.
    expect(describeGitCommand('/Users/x/My Code', ['worktree', 'list'])).toBe(
      "git -C '/Users/x/My Code' worktree list",
    );
  });
});

describe('planWorktreeRemoval', () => {
  it('never removes the main worktree', () => {
    // A refusal, not a warning. It is the checkout the repository's .git lives
    // in, git refuses it anyway, and the difference is that Flock says why
    // instead of showing git's error after making the user confirm something that
    // could not work.
    const plan = planWorktreeRemoval({
      branch: 'main',
      dir: '/c/app',
      primary: true,
      status: status({ dirty: true }),
      liveCwds: ['/c/app'],
    });
    expect(plan.refusal).toContain("main worktree");
    expect(plan.refusal).toContain('main');
    // Refused means refused: nothing else on the plan can be acted on.
    expect(plan.force).toBe(false);
    expect(plan.warnings).toEqual([]);
  });

  it('refuses a worktree with no path at all', () => {
    expect(planWorktreeRemoval({ branch: 'x', dir: '', primary: false }).refusal).not.toBe(
      '',
    );
    expect(
      planWorktreeRemoval({ branch: '', dir: '   ', primary: false }).refusal,
    ).toContain('that worktree');
  });

  it('allows a clean linked worktree with one confirmation', () => {
    const plan = planWorktreeRemoval({
      branch: 'feat/x',
      dir: '/c/app-feat-x',
      primary: false,
      status: status(),
      liveCwds: [],
    });
    expect(plan).toEqual({ refusal: '', warnings: [], force: false });
  });

  it('asks for --force over uncommitted changes, and names them', () => {
    // git refuses a dirty checkout on its own, so getting past it needs --force,
    // and --force deletes the work. `force: true` is therefore exactly "a second
    // confirmation is owed".
    const dirty = planWorktreeRemoval({
      branch: 'feat/x',
      dir: '/c/app-feat-x',
      primary: false,
      status: status({ dirty: true }),
    });
    expect(dirty.force).toBe(true);
    expect(dirty.warnings[0]).toBe('It has uncommitted changes.');

    const untracked = planWorktreeRemoval({
      branch: 'feat/x',
      dir: '/c/app-feat-x',
      primary: false,
      status: status({ untracked: true }),
    });
    expect(untracked.force).toBe(true);
    expect(untracked.warnings[0]).toBe('It has untracked files.');

    const both = planWorktreeRemoval({
      branch: 'feat/x',
      dir: '/c/app-feat-x',
      primary: false,
      status: status({ dirty: true, untracked: true }),
    });
    expect(both.warnings[0]).toBe('It has uncommitted changes and untracked files.');
  });

  it('does not ask for --force over commits that are merely unpushed', () => {
    // `git worktree remove` takes the checkout, not the ref, so commits on the
    // branch survive the removal. Forcing over them would be forcing over
    // nothing at risk.
    const plan = planWorktreeRemoval({
      branch: 'feat/x',
      dir: '/c/app-feat-x',
      primary: false,
      status: status({ ahead: 4, upstream: '' }),
    });
    expect(plan.force).toBe(false);
    expect(plan.warnings).toEqual([]);
  });

  it('never forces on a status it could not read', () => {
    // The conservative direction: a missing probe makes the verb fail safely
    // (git refuses, and says why), never delete something quietly.
    const plan = planWorktreeRemoval({
      branch: 'feat/x',
      dir: '/c/app-feat-x',
      primary: false,
      status: undefined,
    });
    expect(plan.force).toBe(false);
  });

  it('says out loud that a live session is living in there', () => {
    const plan = planWorktreeRemoval({
      branch: 'feat/x',
      dir: '/c/app-feat-x',
      primary: false,
      status: status(),
      liveCwds: ['/c/app-feat-x/src', '/c/app-feat-x', '/c/other'],
    });
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain('2 running Flock sessions');
    // Warned about, not refused: Flock cannot stop an agent mid-turn, and a verb
    // that refused would leave no way to clean up after one that had wandered off.
    expect(plan.refusal).toBe('');
  });

  it('puts the dirt warning before the session warning', () => {
    // Order is the order they are read in the dialog, and the dirt is what the
    // second confirmation will be about.
    const plan = planWorktreeRemoval({
      branch: 'feat/x',
      dir: '/c/app-feat-x',
      primary: false,
      status: status({ dirty: true }),
      liveCwds: ['/c/app-feat-x'],
    });
    expect(plan.warnings).toHaveLength(2);
    expect(plan.warnings[0]).toContain('uncommitted');
    expect(plan.warnings[1]).toContain('running Flock session');
  });
});

describe('sessionsInWorktree', () => {
  it('counts by containment, not by equality', () => {
    // A session started in a subdirectory is just as stranded by the removal as
    // one started at the root, and this is the same rule project membership uses.
    expect(
      sessionsInWorktree('/c/app-x', ['/c/app-x', '/c/app-x/src/deep', '/c/app-y']),
    ).toBe(2);
  });

  it('is not confused by a sibling with a longer name', () => {
    // The classic prefix bug: /c/app-x must not claim /c/app-xy.
    expect(sessionsInWorktree('/c/app-x', ['/c/app-xy'])).toBe(0);
  });

  it('counts nothing for the kinds of nothing', () => {
    expect(sessionsInWorktree('', ['/c/app-x'])).toBe(0);
    expect(sessionsInWorktree('/c/app-x', undefined)).toBe(0);
    expect(sessionsInWorktree('/c/app-x', ['', '   '])).toBe(0);
  });
});

describe('isCheckedOut / isExistingWorktree', () => {
  const checkouts = [
    { name: 'main', dir: '/c/app' },
    { name: 'feat/x', dir: '/c/app-feat-x' },
  ];

  it('keeps a branch that already has a checkout out of the picker', () => {
    // `git worktree add` refuses one, so offering it would be offering a failure.
    expect(isCheckedOut('feat/x', checkouts)).toBe(true);
    expect(isCheckedOut('feat/y', checkouts)).toBe(false);
    expect(isCheckedOut('  feat/x  ', checkouts)).toBe(true);
    expect(isCheckedOut('', checkouts)).toBe(false);
  });

  it('spots a path that is already a worktree, case-insensitively', () => {
    expect(isExistingWorktree('/c/app-feat-x', checkouts)).toBe(true);
    expect(isExistingWorktree('/c/APP-FEAT-X', checkouts)).toBe(true);
    expect(isExistingWorktree('/c/app-feat-y', checkouts)).toBe(false);
    expect(isExistingWorktree('', checkouts)).toBe(false);
  });
});

describe('parseLocalBranches', () => {
  it('reads one branch per line and drops the trailing blank', () => {
    expect(parseLocalBranches('feat/x\nmain\nother\n')).toEqual([
      'feat/x',
      'main',
      'other',
    ]);
  });

  it('drops duplicates and blank lines rather than carrying them', () => {
    // A branch called '' would reach a quick pick as an unselectable row.
    expect(parseLocalBranches('a\n\n  \na\nb\n')).toEqual(['a', 'b']);
  });

  it('returns [] for every kind of nothing', () => {
    expect(parseLocalBranches('')).toEqual([]);
    expect(parseLocalBranches(undefined)).toEqual([]);
    expect(parseLocalBranches(42)).toEqual([]);
  });

  it('handles CRLF, because Windows', () => {
    expect(parseLocalBranches('a\r\nb\r\n')).toEqual(['a', 'b']);
  });
});

describe('running the commands', () => {
  const ok = (output = ''): GitCommandResult => ({ ok: true, output });

  it('runs add in the repository, with the argv it announced', async () => {
    const run = vi.fn(
      async (_f: string, _a: string[], _cwd: string, _t: number) => ok('Preparing worktree'),
    );
    const result = await runWorktreeAdd(
      { repoDir: '/c/app', path: '/c/app-feat-x', branch: 'feat/x', create: true },
      { run },
    );
    expect(result.ok).toBe(true);
    const [file, args, cwd] = run.mock.calls[0];
    expect(file).toBe('git');
    expect(args).toEqual(['worktree', 'add', '-b', 'feat/x', '--', '/c/app-feat-x']);
    // The cwd is the repository, which is why neither the path nor the branch can
    // redirect the command at another one whatever they contain.
    expect(cwd).toBe('/c/app');
  });

  it('runs remove with --force only when the caller asked', async () => {
    const run = vi.fn(
      async (_f: string, _a: string[], _cwd: string, _t: number) => ok(),
    );
    await runWorktreeRemove({ repoDir: '/c/app', path: '/c/app-x', force: false }, { run });
    expect(run.mock.calls[0][1]).not.toContain('--force');
    await runWorktreeRemove({ repoDir: '/c/app', path: '/c/app-x', force: true }, { run });
    expect(run.mock.calls[1][1]).toContain('--force');
  });

  it('refuses without a repository, and spawns nothing', async () => {
    const run = vi.fn(async () => ok());
    const result = await runWorktreeAdd(
      { repoDir: '', path: '/c/app-x', branch: 'x', create: true },
      { run },
    );
    expect(result.ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('reports a failure rather than throwing one', async () => {
    const run = vi.fn(async () => {
      throw new Error('git exploded');
    });
    const result = await runWorktreeRemove(
      { repoDir: '/c/app', path: '/c/app-x', force: false },
      { run },
    );
    // A verb the user confirmed has to end in a message either way.
    expect(result.ok).toBe(false);
    expect(result.output).toContain('git exploded');
  });

  it('honours a configured git binary on the write path too', async () => {
    const run = vi.fn(
      async (_f: string, _a: string[], _cwd: string, _t: number) => ok(),
    );
    await runWorktreeAdd(
      { repoDir: '/c/app', path: '/c/app-x', branch: 'x', create: true },
      { run, gitBinary: '/opt/homebrew/bin/git' },
    );
    expect(run.mock.calls[0][0]).toBe('/opt/homebrew/bin/git');
  });

  it('gives the branch picker an empty list when the read fails', async () => {
    // Which leaves the picker as a free-text field — exactly the half of itself
    // that needs no git at all.
    const failing = vi.fn(async () => ({ ok: false, output: 'not a repository' }));
    expect(await readLocalBranches('/tmp', { run: failing })).toEqual([]);
    const throwing = vi.fn(async () => {
      throw new Error('nope');
    });
    expect(await readLocalBranches('/tmp', { run: throwing })).toEqual([]);
    expect(await readLocalBranches('')).toEqual([]);
  });

  it('reads the branch list off a successful run', async () => {
    const run = vi.fn(
      async (_f: string, _a: string[], _cwd: string, _t: number) => ok('main\nfeat/x\n'),
    );
    expect(await readLocalBranches('/c/app', { run })).toEqual(['main', 'feat/x']);
  });
});

describe('suggestBranchName', () => {
  it('mints the branch from the session title', () => {
    expect(suggestBranchName({ title: 'flock 3', taken: [] })).toBe('flock-3');
  });

  it('keeps the prefix hierarchy and slugs its segments', () => {
    expect(
      suggestBranchName({ prefix: 'axel/', title: 'flock 3', taken: [] }),
    ).toBe('axel/flock-3');
    // Case preserved, separator normalised — the same promises slugifyBranch
    // makes about the title.
    expect(
      suggestBranchName({ prefix: 'Axel Häg/', title: 'x', taken: [] }),
    ).toBe('Axel-Hag/x');
  });

  it('lets a prefix that cleans away contribute nothing', () => {
    expect(suggestBranchName({ prefix: '///', title: 'x', taken: [] })).toBe('x');
  });

  it('bumps past taken names rather than steering into a refusal', () => {
    expect(suggestBranchName({ title: 'flock 3', taken: ['flock-3'] })).toBe(
      'flock-3-2',
    );
    expect(
      suggestBranchName({ title: 'flock 3', taken: ['flock-3', 'flock-3-2'] }),
    ).toBe('flock-3-3');
  });

  it('refuses a title with nothing usable in it', () => {
    expect(suggestBranchName({ title: '///', taken: [] })).toBe('');
  });

  it('refuses when the bumps run out', () => {
    const taken = ['x', ...Array.from({ length: 98 }, (_, i) => `x-${i + 2}`)];
    expect(suggestBranchName({ title: 'x', taken })).toBe('');
  });
});

describe('planBranchFate', () => {
  const base = { branch: 'axel/x', mainName: 'main', primary: false };

  it('keeps a branch Flock did not mint', () => {
    const fate = planBranchFate({ ...base, minted: false, aheadOfMain: 0 });
    expect(fate.offerDelete).toBe(false);
    expect(fate.sentence).toContain('is kept');
  });

  it('keeps a minted branch with commits main does not have, and counts them', () => {
    const fate = planBranchFate({ ...base, minted: true, aheadOfMain: 3 });
    expect(fate.offerDelete).toBe(false);
    expect(fate.sentence).toContain('3 commits');
  });

  it('speaks singular for one commit', () => {
    expect(
      planBranchFate({ ...base, minted: true, aheadOfMain: 1 }).sentence,
    ).toContain('1 commit on it is');
  });

  it('keeps the branch when the probe never answered', () => {
    // Undefined is the conservative direction, same as a missing status in
    // planWorktreeRemoval: a failed read must never widen the offer.
    expect(
      planBranchFate({ ...base, minted: true, aheadOfMain: undefined })
        .offerDelete,
    ).toBe(false);
  });

  it('offers deletion only for a minted, fully-merged branch', () => {
    const fate = planBranchFate({ ...base, minted: true, aheadOfMain: 0 });
    expect(fate.offerDelete).toBe(true);
    expect(fate.sentence).toContain('everything on it is on main');
  });

  it('never offers on the primary worktree, whatever else is true', () => {
    expect(
      planBranchFate({ ...base, primary: true, minted: true, aheadOfMain: 0 })
        .offerDelete,
    ).toBe(false);
  });
});

describe('branch delete and the merged probe', () => {
  const okResult = (output = ''): GitCommandResult => ({ ok: true, output });

  it('always says -d, never -D', () => {
    // Lowercase -d is git's own gate on unmerged work; the argv is asserted
    // exactly for the same reason worktreeRemoveArgv's is.
    expect(branchDeleteArgv('axel/x')).toEqual(['branch', '-d', '--', 'axel/x']);
  });

  it('asks rev-list for the exact range, closed off from paths', () => {
    expect(revListCountArgv('main', 'axel/x')).toEqual([
      'rev-list',
      '--count',
      'main..axel/x',
      '--',
    ]);
  });

  it('parses a count and refuses everything else', () => {
    expect(parseRevListCount('0\n')).toBe(0);
    expect(parseRevListCount(' 42 ')).toBe(42);
    expect(parseRevListCount('')).toBeUndefined();
    expect(parseRevListCount('fatal: bad revision')).toBeUndefined();
    expect(parseRevListCount(undefined)).toBeUndefined();
  });

  it('runs the delete in the repository it was asked about', async () => {
    const run = vi.fn(
      async (_f: string, _a: string[], _cwd: string, _t: number) => okResult(),
    );
    await runBranchDelete({ repoDir: '/c/app', branch: 'axel/x' }, { run });
    expect(run.mock.calls[0][1]).toEqual(['branch', '-d', '--', 'axel/x']);
    expect(run.mock.calls[0][2]).toBe('/c/app');
  });

  it('reads the ahead count and folds every failure to undefined', async () => {
    const run = vi.fn(async () => okResult('2\n'));
    expect(await readAheadCount('/c/app', 'main', 'axel/x', { run })).toBe(2);
    const failing = vi.fn(async () => ({ ok: false, output: 'boom' }));
    expect(
      await readAheadCount('/c/app', 'main', 'axel/x', { run: failing }),
    ).toBeUndefined();
    const throwing = vi.fn(async () => {
      throw new Error('nope');
    });
    expect(
      await readAheadCount('/c/app', 'main', 'axel/x', { run: throwing }),
    ).toBeUndefined();
    expect(await readAheadCount('', 'main', 'x')).toBeUndefined();
    expect(await readAheadCount('/c/app', '', 'x')).toBeUndefined();
  });
});
