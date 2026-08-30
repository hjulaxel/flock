// src/worktrees.ts — the write side of worktrees, and the only one there is.
//
// src/git.ts and src/gitBranches.ts read; this module is the three commands
// that CHANGE a repository, plus the pure decisions in front of them:
//
//     git worktree add [-b <branch>] -- <path> [<branch>]
//     git worktree remove [--force] -- <path>
//     git branch -d -- <branch>
//
// Everything in here runs ONLY from a verb the user picked. The two
// DESTRUCTIVE ones — remove, and the branch delete — are confirmed in a modal
// that quotes the exact command besides. The ADD is the one write allowed to
// run straight off the `+` (`lineage.git.newSessionInWorktree`): it creates a
// directory and a fresh ref and touches nothing that already exists, so the
// click is the consent and the receipt says what it did. There is still no
// timer, no poll and no path that reaches any of these from a render, a
// roster tick or a settings change — which is the whole reason a read-only
// extension can have them at all. `git worktree remove` deletes a directory,
// and with `--force` deletes uncommitted work with it; `git branch -d`
// deletes a NAME, behind git's own merged-only gate. None of these is
// something to do on somebody's behalf because a cache went stale.
//
// The DECISIONS are pure and exported separately from the commands that carry
// them out — where the new checkout goes, and whether a removal may be offered
// at all. That split is not tidiness: the refusal rules are the safety of this
// feature, and rules buried inside a function that also spawns a process can
// only be tested by spawning one.
//
// This module never imports vscode: everything in it is either pure or talks
// straight to a child process, so it stays unit-testable outside a workbench.
// The modals belong to commands.ts, which calls in here for the decisions and
// reaches the two commands through CommandDeps — the same arrangement tmux.ts
// has, and for the same reason.

import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

import { isWithin, normalizeDir, pathKey } from './projects';
import type { BranchStatus, GitCommandResult } from './types';

/** A worktree verb is a person waiting on a modal, not a probe on a poll path,
 *  so it gets a budget the reads do not: `git worktree add` checks out a whole
 *  tree, which on a large repository is seconds of real work. */
const DEFAULT_TIMEOUT_MS = 60_000;
/** The branch list is a read like any other and keeps the probe budget. */
const READ_TIMEOUT_MS = 4000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/** How much of git's own output travels back to the user. Enough for the two or
 *  three lines git actually says on failure; capped because it lands in a modal,
 *  and a modal is not a log. */
const MAX_OUTPUT_LEN = 2000;

/** Cap on a slugged branch name inside a directory name. Most filesystems stop
 *  at 255 bytes per component and the pattern puts a repository name in front of
 *  this one, so the budget is shared. */
const MAX_SLUG_LEN = 60;

/** How many local branches the picker offers. A repository with more refs than
 *  this has refs nobody is working in, and `--count` is git's own way of saying
 *  so — cheaper than reading them all and slicing. */
const MAX_LOCAL_BRANCHES = 500;

/** The default of `lineage.git.worktreePath`, restated here because the pure
 *  path builder has to have something to fall back to when the setting is blank
 *  and must not have to ask a workspace configuration for it. Kept identical to
 *  the manifest's default; test/worktrees.test.ts cross-checks the two. */
export const DEFAULT_WORKTREE_PATH_PATTERN = '../${repo}-${branch}';

// ------------------------------------------------------------------- naming

/**
 * A branch name as a directory-name component: `feat/x` → `feat-x`.
 *
 * CASE IS PRESERVED, unlike accounts.ts's slugify. That one mints an id that
 * gets interpolated into a path Flock owns and compares by equality, so folding
 * it is a correctness measure; this one is a name a person will read in their
 * shell and type into `cd`, and a branch called `JIRA-4021` turning into a
 * directory called `jira-4021` is a small daily lie about what is checked out
 * there.
 *
 * What it does remove is everything a path component should not carry: a
 * separator (which is the common case — every `feat/…` branch has one), and
 * anything that could make the result relative rather than a name. A leading dot
 * is stripped for two reasons at once, and both matter: `.hidden` is invisible in
 * a file manager, and `..` is the parent directory.
 *
 * Returns '' for a name with nothing usable left in it, which every caller must
 * treat as a refusal rather than a default — a worktree at a path built from an
 * empty slug lands somewhere nobody asked for.
 */
export function slugifyBranch(branch: unknown): string {
  if (typeof branch !== 'string') return '';
  const dashed = branch
    .normalize('NFKD')
    // Strip the combining marks NFKD just split off, so `feature/café` slugs to
    // `feature-cafe` rather than to `feature-caf-`.
    .replace(/[\u0300-\u036f]/g, '')
    // Letters and numbers in ANY script, not just ASCII: a branch named entirely
    // in Chinese or Cyrillic would otherwise slug to '' and be refused a worktree.
    // \p{M} keeps the vowel marks NFKD splits off Indic and Thai letters; the
    // Latin ones it splits off are already gone from the pass above.
    .replace(/[^\p{L}\p{N}\p{M}._-]+/gu, '-')
    // Runs of separators collapse to ONE dash, dots included — which is what
    // turns `a/../../b` into `a-b` rather than into `a-..-..-b`. A single dot
    // survives, because `v1.2` is a name somebody means; two in a row never are,
    // and `..` inside a directory name reads as a path when it is not one.
    .replace(/[-.]{2,}/g, '-');
  // Trimmed twice: once for the name, and again after the length cap, which can
  // itself land on a separator.
  return trimEdges(trimEdges(dashed).slice(0, MAX_SLUG_LEN));
}

function trimEdges(s: string): string {
  return s.replace(/^[-._]+/, '').replace(/[-._]+$/, '');
}

/** Cap on the `-2`, `-3`… suffixes tried when a suggested branch name is
 *  taken. Two digits of retries is already a repository with ninety-odd
 *  branches minted from the same session stem; past that the flow refuses and
 *  the user names the branch themselves. */
const MAX_NAME_BUMPS = 99;

/**
 * The branch a NEW worktree session gets, minted from the session's own name.
 *
 * `flock 3` → `flock-3`, or `axel/flock-3` under a prefix — the Claude Squad
 * convention — and the reason the `+` can cut a worktree without stopping to
 * ask: the answer a picker would ask for is derivable, readable in a git
 * prompt, and cheap to change later (`git branch -m`).
 *
 * The PREFIX is cleaned segment by segment with the same slug rule the title
 * gets, KEEPING its `/`s: a ref is allowed hierarchy where a directory
 * component is not, and `axel/` in front of every minted branch is the whole
 * point of the setting. A prefix that cleans away to nothing contributes
 * nothing rather than failing the launch over a setting.
 *
 * A TAKEN name gets `-2`, `-3`, … appended rather than returned anyway:
 * `git worktree add -b` refuses an existing ref, and this function exists so
 * the silent flow cannot steer itself into a refusal git would then have to
 * explain. Returns '' when the title slugs to nothing or the bumps run out —
 * callers treat '' as a refusal, never as a name.
 */
export function suggestBranchName(input: {
  /** `lineage.git.branchPrefix`. Blank contributes nothing. */
  prefix?: string;
  /** The session title the branch is named after. */
  title: string;
  /** Every name this repository already has — local branches and checked-out
   *  ones alike. Compared exactly: refs are case-sensitive. */
  taken: readonly string[];
}): string {
  const stem = slugifyBranch(input.title);
  if (stem === '') return '';
  const prefix = (typeof input.prefix === 'string' ? input.prefix : '')
    .split('/')
    .map((seg) => slugifyBranch(seg))
    .filter((seg) => seg !== '')
    .join('/');
  const base = prefix === '' ? stem : `${prefix}/${stem}`;
  const taken = new Set(input.taken);
  if (!taken.has(base)) return base;
  for (let n = 2; n <= MAX_NAME_BUMPS; n++) {
    const bumped = `${base}-${n}`;
    if (!taken.has(bumped)) return bumped;
  }
  return '';
}

/**
 * Where a new worktree goes: the pattern, with `${repo}` and `${branch}`
 * filled in, resolved against the repository's MAIN worktree.
 *
 * Relative by default (`../${repo}-${branch}`), so the new checkout lands beside
 * the one it came from — `~/code/app` and `~/code/app-feat-x` — which is the
 * layout `git worktree add` itself suggests and the one that keeps a repository's
 * checkouts findable next to each other. Resolved against the main worktree
 * rather than against the process's cwd, because a VS Code window's cwd is
 * whatever folder it happened to open and would put the same pattern in a
 * different place in every window.
 *
 * An ABSOLUTE pattern is used as written, and a leading `~/` expands. Without the
 * second, a setting that is obviously a path would silently create a directory
 * literally named `~` in the repository's parent, which is the kind of thing you
 * find months later.
 *
 * Returns '' when the pattern is unusable — every caller treats that as a refusal
 * and says so, rather than falling back to a path the user did not ask for.
 */
export function worktreePathFor(input: {
  /** `lineage.git.worktreePath`. Blank falls back to the shipped default. */
  pattern?: string;
  /** The repository's main worktree — what the pattern is relative to, and where
   *  `${repo}` comes from. */
  repoDir: string;
  branch: string;
}): string {
  const repoDir = normalizeDir(input.repoDir);
  if (repoDir === '') return '';
  const slug = slugifyBranch(input.branch);
  if (slug === '') return '';

  const raw =
    typeof input.pattern === 'string' && input.pattern.trim() !== ''
      ? input.pattern.trim()
      : DEFAULT_WORKTREE_PATH_PATTERN;

  const filled = raw
    .replace(/\$\{repo\}/g, path.basename(repoDir))
    .replace(/\$\{branch\}/g, slug);
  // A pattern that used neither placeholder resolves to ONE path for every
  // branch, so the second worktree would collide with the first. Refused rather
  // than silently corrected: the setting is wrong and the user has to see that.
  if (filled === '' || (!raw.includes('${branch}') && !raw.includes('${repo}'))) {
    return '';
  }

  const expanded = filled.startsWith('~/')
    ? path.join(os.homedir(), filled.slice(2))
    : filled;
  const resolved = path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(repoDir, expanded);
  return normalizeDir(resolved);
}

// -------------------------------------------------------------------- argv

/**
 * `git worktree add`, as the two shapes it has.
 *
 * `-b` is the whole difference between the two halves of the New Worktree
 * picker: an existing branch is CHECKED OUT at the new path, a name that does not
 * exist yet is CREATED there, from the main worktree's HEAD. Passing `-b` for a
 * branch that already exists fails (git refuses to clobber a ref), and omitting
 * it for one that does not fails too — so the flag is not a preference, it is the
 * answer to which half of the picker was used, and the caller must know which.
 *
 * `--` before the path because a branch name may begin with `-`. Verified against
 * git 2.x: `worktree add` stops option parsing there in both forms.
 */
export function worktreeAddArgv(opts: {
  path: string;
  branch: string;
  /** Create `branch` rather than check out an existing one. */
  create: boolean;
}): string[] {
  return opts.create
    ? ['worktree', 'add', '-b', opts.branch, '--', opts.path]
    : ['worktree', 'add', '--', opts.path, opts.branch];
}

/**
 * `git worktree remove`.
 *
 * `--force` is git's own gate on a checkout with modified or untracked files —
 * without it git refuses and says so — which is exactly the boundary the second
 * confirmation stands at. It is never set from a default or a setting: only
 * planWorktreeRemoval asks for it, and only the user's second Yes supplies it.
 *
 * The BRANCH is left alone either way. `git worktree remove` deletes the
 * checkout, not the ref, so the commits on it survive and the worktree can be
 * added back. That is why a removal needs one confirmation rather than the
 * ceremony a branch delete would.
 */
export function worktreeRemoveArgv(opts: {
  path: string;
  force: boolean;
}): string[] {
  return opts.force
    ? ['worktree', 'remove', '--force', '--', opts.path]
    : ['worktree', 'remove', '--', opts.path];
}

/** The local branches, most recently committed to first — which is the order the
 *  picker wants, because the branch you are about to make a worktree for is
 *  almost always one you touched today. Sorting is git's job here; doing it in
 *  the extension would mean reading a date per ref to sort by. */
export function localBranchArgv(): string[] {
  return [
    'for-each-ref',
    '--format=%(refname:short)',
    '--sort=-committerdate',
    `--count=${MAX_LOCAL_BRANCHES}`,
    'refs/heads/',
  ];
}

/**
 * `git branch -d` — LOWERCASE, and that is the safety of the whole delete
 * offer: `-d` is git's own refusal over a branch not merged into HEAD, so
 * even a probe that lied cannot cost commits — git re-checks at the moment of
 * deletion and refuses in its own words. `-D` does not appear in this module
 * and must never be added to it.
 */
export function branchDeleteArgv(branch: string): string[] {
  return ['branch', '-d', '--', branch];
}

/** `git rev-list --count <main>..<branch>` — how many commits the branch has
 *  that the main branch does not. One spawn answers both "is it merged" (0)
 *  and the dialog's sentence (N). Runs only inside the removal verb, never on
 *  a poll path. The `--` closes the range off from ever reading as a path. */
export function revListCountArgv(mainName: string, branch: string): string[] {
  return ['rev-list', '--count', `${mainName}..${branch}`, '--'];
}

/** `rev-list --count` output → a count, or undefined for anything that is
 *  not one. Undefined is load-bearing: planBranchFate reads it as "keep the
 *  branch", so garbage can only make the flow conservative. */
export function parseRevListCount(stdout: unknown): number | undefined {
  if (typeof stdout !== 'string') return undefined;
  const m = /^\s*(\d+)\s*$/.exec(stdout);
  return m ? Number(m[1]) : undefined;
}

/**
 * The command as the user will see it in the confirmation, and as they could
 * paste it into a shell themselves.
 *
 * `-C <repoDir>` even though the real call passes a cwd instead: a command with
 * no directory in it is a command whose effect depends on where you run it, and
 * the whole point of showing it is that the user can check what it will do. The
 * quoting is deliberately minimal — a shell-exact escaper would be a second
 * implementation of quoting that nothing executes, and this string is never
 * executed by anything. It exists to be read.
 */
export function describeGitCommand(repoDir: string, argv: readonly string[]): string {
  const quote = (s: string): string =>
    s === '' || /[\s"'\\$`]/.test(s) ? `'${s.replace(/'/g, "'\\''")}'` : s;
  return ['git', '-C', quote(repoDir), ...argv.map(quote)].join(' ');
}

// --------------------------------------------------------------- refusals

/**
 * Whether a worktree may be removed, and what the user has to be told first.
 *
 * Pure, and the safety of the whole verb. Three rules, in the order they are
 * decided:
 *
 *   1. THE MAIN WORKTREE IS NEVER REMOVED. Not "is warned about" — refused. It
 *      is the checkout the repository's `.git` lives in, the one every linked
 *      worktree points back at, and `git worktree remove` refuses it anyway; the
 *      difference is that Flock says why instead of showing git's error after
 *      making the user confirm something that could not work.
 *   2. UNCOMMITTED WORK NEEDS A SECOND YES. git itself refuses a checkout with
 *      modified or untracked files unless `--force`, and `--force` deletes them.
 *      So `force` here means precisely "the user has been told what is about to
 *      be destroyed", and the caller must not set it any other way.
 *   3. A LIVE SESSION IN THERE IS SAID OUT LOUD. Flock cannot stop an agent
 *      mid-turn and must not pretend the removal is unrelated to it: the process
 *      keeps running with its working directory pulled out from under it, which
 *      fails in ways nobody enjoys reading.
 *
 * A status that was never read produces no dirt warning and no `force`, which
 * means the removal is attempted WITHOUT it — and git then refuses on its own
 * and says why. That is the conservative direction: a missing probe can make the
 * verb fail safely, never make it delete something quietly.
 */
export interface RemovalPlan {
  /** Non-empty = a hard refusal, and this is the sentence the user is shown.
   *  `warnings` and `force` are meaningless when it is set. */
  refusal: string;
  /** What the user must be told before the FIRST confirmation, in order. */
  warnings: string[];
  /** The removal needs `--force`, and therefore a second confirmation naming
   *  what that destroys. */
  force: boolean;
}

export function planWorktreeRemoval(input: {
  branch: string;
  dir: string;
  primary: boolean;
  /** From src/gitBranches.ts. Undefined = never read; see the note above. */
  status?: BranchStatus | undefined;
  /** Working directories of the sessions Flock currently shows as RUNNING. The
   *  caller decides what counts as running; this only asks which of them are
   *  inside the directory about to go away. */
  liveCwds?: readonly string[];
}): RemovalPlan {
  const dir = normalizeDir(input.dir);
  const branch = typeof input.branch === 'string' ? input.branch : '';
  const named = branch === '' ? 'that worktree' : branch;

  if (dir === '') {
    return {
      refusal: `${named} has no worktree path Flock can act on.`,
      warnings: [],
      force: false,
    };
  }
  if (input.primary) {
    return {
      refusal: `${named} is the repository's main worktree. That one stays.`,
      warnings: [],
      force: false,
    };
  }

  const warnings: string[] = [];
  const status = input.status;
  const dirty = status?.dirty === true;
  const untracked = status?.untracked === true;
  if (dirty && untracked) warnings.push('It has uncommitted changes and untracked files.');
  else if (dirty) warnings.push('It has uncommitted changes.');
  else if (untracked) warnings.push('It has untracked files.');

  const inside = sessionsInWorktree(dir, input.liveCwds);
  if (inside > 0) {
    warnings.push(
      `${inside} running Flock session${inside === 1 ? '' : 's'} ` +
        `${inside === 1 ? 'has' : 'have'} its working directory in there.`,
    );
  }

  return { refusal: '', warnings, force: dirty || untracked };
}

/** How many of `cwds` sit inside `dir`. Containment, not equality — a session
 *  started in a subdirectory of the worktree is just as stranded by the removal
 *  as one started at its root — and the same rule project membership uses, so the
 *  two cannot disagree about what "in there" means. */
export function sessionsInWorktree(
  dir: string,
  cwds: readonly string[] | undefined,
): number {
  const target = normalizeDir(dir);
  if (target === '') return 0;
  let n = 0;
  for (const raw of cwds ?? []) {
    const cwd = normalizeDir(raw);
    if (cwd !== '' && isWithin(target, cwd)) n++;
  }
  return n;
}

/**
 * What happens to the BRANCH when its worktree goes — the second half of a
 * removal, decided apart from planWorktreeRemoval because the two questions
 * have different stakes: the worktree is a directory git can recreate in
 * seconds; the branch is the name of the work.
 *
 * The rule is the field's (docs/proposal-worktree-sessions.md): deletion is
 * OFFERED only when Flock minted the ref AND everything on it is already on
 * the main branch. Everything else keeps the ref, and the sentence says which
 * case this was — a dialog that silently kept the branch would leave "did it
 * delete my branch?" to be answered by running git.
 *
 * `aheadOfMain === undefined` means the probe failed or never ran, and it
 * reads as "keep": a missing read may make this verb more conservative, never
 * more destructive — the same direction planWorktreeRemoval falls in.
 */
export interface BranchFate {
  /** Offer "Remove and Delete Branch" beside plain removal. */
  offerDelete: boolean;
  /** The dialog's sentence about the branch. Always set. */
  sentence: string;
}

export function planBranchFate(input: {
  branch: string;
  /** Flock created this ref — a minted-branch record exists for it. */
  minted: boolean;
  /** `git rev-list --count main..branch`, or undefined for a failed probe. */
  aheadOfMain: number | undefined;
  /** The main worktree's branch name, for the sentence. */
  mainName: string;
  primary: boolean;
}): BranchFate {
  const name = input.branch === '' ? 'the branch' : `"${input.branch}"`;
  const main = input.mainName === '' ? 'the main branch' : input.mainName;
  const kept = {
    offerDelete: false,
    sentence: `The branch ${name} itself is kept — only the checkout goes away.`,
  };
  // The primary worktree never reaches a removal (planWorktreeRemoval refuses
  // it first); refusing again keeps this function safe to call on its own.
  if (input.primary || !input.minted) return kept;
  if (input.aheadOfMain === undefined) return kept;
  if (input.aheadOfMain > 0) {
    const n = input.aheadOfMain;
    return {
      offerDelete: false,
      sentence:
        `Flock created ${name}, but ${n} commit${n === 1 ? '' : 's'} on it ` +
        `${n === 1 ? 'is' : 'are'} not on ${main} — the branch is kept.`,
    };
  }
  return {
    offerDelete: true,
    sentence: `Flock created ${name} and everything on it is on ${main}.`,
  };
}

/** The one shape both of the checks below need: a checkout, by branch name and
 *  path. Structural on purpose — BranchInfo (what the views hand over) and
 *  Worktree (what git.ts parses) both satisfy it under the same field name, and a
 *  helper that insisted on one of them would need a second copy for the other. */
export interface NamedCheckout {
  name: string;
  dir: string;
}

/** Whether `branch` already has a checkout of its own, by name. What the New
 *  Worktree picker filters on: `git worktree add` refuses a branch that is
 *  already checked out somewhere, so offering it would be offering a failure. */
export function isCheckedOut(
  branch: string,
  checkouts: readonly NamedCheckout[],
): boolean {
  const name = typeof branch === 'string' ? branch.trim() : '';
  if (name === '') return false;
  return checkouts.some((c) => c.name === name);
}

/** Whether `dir` is already one of the repository's checkouts. Cheap pre-flight
 *  for the path the pattern produced: git would refuse it too, but with a
 *  message about a directory the user never typed. */
export function isExistingWorktree(
  dir: string,
  checkouts: readonly NamedCheckout[],
): boolean {
  const key = pathKey(dir);
  if (key === '') return false;
  return checkouts.some((c) => pathKey(c.dir) === key);
}

// -------------------------------------------------------------- the commands

export interface WorktreeRunOptions {
  /** Full path to the git binary, or 'git' to search PATH. */
  gitBinary?: string;
  timeoutMs?: number;
  /** Injected in tests. Real callers leave it alone and get execFile. */
  run?: (
    file: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
  ) => Promise<GitCommandResult>;
}

function execGit(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<GitCommandResult> {
  return new Promise<GitCommandResult>((resolve) => {
    try {
      execFile(
        file,
        args,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: MAX_BUFFER_BYTES,
          windowsHide: true,
          // GIT_TERMINAL_PROMPT=0 for the same reason every read here sets it: a
          // repository whose config would prompt must fail rather than hang on a
          // dialog nobody can see. GIT_OPTIONAL_LOCKS is deliberately NOT set —
          // this command is a write, and taking the index lock is the correct
          // thing for it to do.
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        },
        (err, stdout, stderr) => {
          // git says useful things on BOTH streams here ("Preparing worktree…"
          // on stdout, the reason for a refusal on stderr), and the caller shows
          // whichever one carries the failure. Joined rather than picked,
          // because which stream a given git version uses is not a contract.
          const output = capOutput(`${String(stdout ?? '')}${String(stderr ?? '')}`);
          resolve({ ok: !err, output });
        },
      );
    } catch (err) {
      // A binary that is not there, an argv the platform rejects. Reported as a
      // failed command rather than thrown, because a verb the user confirmed has
      // to end in a message either way.
      resolve({ ok: false, output: capOutput(String(err)) });
    }
  });
}

function capOutput(s: string): string {
  const trimmed = s.trim();
  return trimmed.length > MAX_OUTPUT_LEN
    ? `${trimmed.slice(0, MAX_OUTPUT_LEN)}…`
    : trimmed;
}

/**
 * Run `git worktree add`. ONE call, from ONE confirmed verb.
 *
 * `repoDir` is the cwd, so this is always the repository the user was looking at
 * — the path and the branch cannot redirect the command at another one, whatever
 * they contain.
 */
export function runWorktreeAdd(
  opts: {
    repoDir: string;
    path: string;
    branch: string;
    create: boolean;
  },
  run?: WorktreeRunOptions,
): Promise<GitCommandResult> {
  return runGit(
    opts.repoDir,
    worktreeAddArgv({ path: opts.path, branch: opts.branch, create: opts.create }),
    run,
  );
}

/** Run `git worktree remove`. See planWorktreeRemoval for where `force` may
 *  come from — and only from there. */
export function runWorktreeRemove(
  opts: { repoDir: string; path: string; force: boolean },
  run?: WorktreeRunOptions,
): Promise<GitCommandResult> {
  return runGit(
    opts.repoDir,
    worktreeRemoveArgv({ path: opts.path, force: opts.force }),
    run,
  );
}

/** Run `git branch -d`. Only ever AFTER a successful worktree removal (git
 *  refuses to delete a checked-out branch), and only from the button
 *  planBranchFate put on the dialog. */
export function runBranchDelete(
  opts: { repoDir: string; branch: string },
  run?: WorktreeRunOptions,
): Promise<GitCommandResult> {
  return runGit(opts.repoDir, branchDeleteArgv(opts.branch), run);
}

/** How far `branch` is ahead of `mainName`, or undefined when git cannot
 *  say. A READ on the probe budget, with readLocalBranches's failure
 *  contract: any failure at all is undefined, and undefined only ever makes
 *  the caller keep the branch. */
export function readAheadCount(
  repoDir: string,
  mainName: string,
  branch: string,
  opts?: WorktreeRunOptions,
): Promise<number | undefined> {
  const dir = normalizeDir(repoDir);
  if (dir === '' || mainName === '' || branch === '') {
    return Promise.resolve(undefined);
  }
  const exec = opts?.run ?? execGit;
  try {
    return exec(
      opts?.gitBinary ?? 'git',
      revListCountArgv(mainName, branch),
      dir,
      opts?.timeoutMs ?? READ_TIMEOUT_MS,
    )
      .then((r) => (r.ok ? parseRevListCount(r.output) : undefined))
      .catch(() => undefined);
  } catch {
    return Promise.resolve(undefined);
  }
}

function runGit(
  repoDir: string,
  argv: string[],
  opts?: WorktreeRunOptions,
): Promise<GitCommandResult> {
  const dir = normalizeDir(repoDir);
  if (dir === '') {
    return Promise.resolve({ ok: false, output: 'no repository directory' });
  }
  const exec = opts?.run ?? execGit;
  try {
    return exec(
      opts?.gitBinary ?? 'git',
      argv,
      dir,
      opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ).catch((err: unknown) => ({ ok: false, output: capOutput(String(err)) }));
  } catch (err) {
    // A runner that throws SYNCHRONOUSLY, which the injected ones in tests can
    // and execGit cannot. Both endings have to be the same one: a verb the user
    // confirmed ends in a message either way.
    return Promise.resolve({ ok: false, output: capOutput(String(err)) });
  }
}

/** `git for-each-ref` output → branch names. Blank lines dropped rather than
 *  carried, so a trailing newline does not become a branch called ''. */
export function parseLocalBranches(stdout: unknown): string[] {
  if (typeof stdout !== 'string') return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of stdout.split(/\r?\n/)) {
    const name = raw.trim();
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * The repository's local branches, for the New Worktree picker.
 *
 * A READ, on the same terms as everything in git.ts: it runs only when the user
 * opens that picker, and a failure gives an empty list — which the picker then
 * shows as "type a name", i.e. exactly the half of itself that needs no git at
 * all. Nothing about this can block a render; there is no cache because there is
 * no repeat caller.
 */
export function readLocalBranches(
  repoDir: string,
  opts?: WorktreeRunOptions,
): Promise<string[]> {
  const dir = normalizeDir(repoDir);
  if (dir === '') return Promise.resolve([]);
  const exec = opts?.run ?? execGit;
  try {
    return exec(
      opts?.gitBinary ?? 'git',
      localBranchArgv(),
      dir,
      opts?.timeoutMs ?? READ_TIMEOUT_MS,
    )
      .then((result) => (result.ok ? parseLocalBranches(result.output) : []))
      .catch(() => []);
  } catch {
    return Promise.resolve([]);
  }
}
