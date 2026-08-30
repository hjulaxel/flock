// src/deepSwitch.ts — what a project-mode switch REVEALS, decided before
// anything moves.
//
// The switch (workspaces.ts) has always been about tabs: save the layout you
// leave, restore the one you arrive at. The levels-and-modes design
// (design/levels-and-modes.md) asks it to also answer the question a person
// actually has on arrival — WHERE AM I? — with two gestures:
//
//   * an Explorer reveal of the (sub)project's folder, so the file tree is
//     looking at the same thing the tabs are;
//   * the git context of that folder — which branch, and whether it is a
//     linked worktree — surfaced in the switch summary, so "switched to API"
//     also says "on feat/ingest".
//
// Both gestures need the same decision: WHICH directory is the target's home
// right now. That is not always the directory on record. A lane
// (SubprojectRecord) may PIN a branch, and for somebody running one agent per
// worktree the lane's work lives wherever that branch is checked out TODAY —
// `~/code/app-feat-x` this week, gone next week when the worktree is removed.
// Following the pin is what "worktree-aware" means here: the branch outranks
// the folder, because the folder is just where the branch happened to be the
// day the lane was created.
//
// What this module never does: create anything. A pinned branch with no
// checkout falls back to the lane's own directory — `git worktree add` is a
// user-confirmed verb (src/worktrees.ts) and no switch, however deep, may
// reach it. A reveal that silently grew a directory would be navigation
// mutating the world, which is the exact category of surprise the levels
// design exists to remove.
//
// PURE, in the shape chatAutoClose.ts established: this module decides, the
// wiring (extension.ts supplies the worktree list and executes the reveal;
// commands.ts asks the same question for a lane's `+`) reads the world and
// acts. No vscode import, no git spawn — the worktree list arrives as data
// from src/git.ts's probe, already parsed.

import * as path from 'node:path';

import { isWithin, normalizeDir, pathKey } from './projects';
import type { Worktree } from './types';

/**
 * The checkout that CONTAINS `dir` — deepest containment wins, so a directory
 * inside `~/code/app-feat-x` answers with that worktree and not with a parent
 * checkout that happens to enclose both (nested worktrees are unusual but git
 * permits them, and the shallow answer would name the wrong branch).
 *
 * Containment rather than equality, for the same reason project membership
 * uses it: a lane at `~/code/app/src/api` is ON whatever branch the checkout
 * at `~/code/app` has out, and equality would say it is on nothing.
 *
 * Undefined when no checkout contains the directory — not a repository, or a
 * probe that has not landed. Callers treat that as "nothing to say", never as
 * an error: a project outside git still deserves its reveal.
 */
export function checkoutAt(
  worktrees: readonly Worktree[],
  dir: string | undefined,
): Worktree | undefined {
  const target = normalizeDir(dir);
  if (target === '') return undefined;
  let best: Worktree | undefined;
  let bestDepth = -1;
  for (const wt of worktrees ?? []) {
    const root = normalizeDir(wt?.dir);
    if (root === '' || !isWithin(root, target)) continue;
    const depth = pathKey(root).length;
    if (depth > bestDepth) {
      best = wt;
      bestDepth = depth;
    }
  }
  return best;
}

/**
 * The checkout OF `branch`, if the repository has one. Exact short-name match
 * (`feat/x`, not `refs/heads/feat/x` — parseWorktreeList already stripped the
 * prefix), because a branch has at most one checkout: git itself refuses a
 * second `worktree add` of a checked-out branch, so the first hit is the only
 * possible hit. Detached checkouts never match — their `branch` is '' and an
 * empty pin must not "find" them.
 */
export function worktreeForBranch(
  worktrees: readonly Worktree[],
  branch: string | undefined,
): Worktree | undefined {
  const name = typeof branch === 'string' ? branch.trim() : '';
  if (name === '') return undefined;
  return (worktrees ?? []).find(
    (wt) => wt?.detached !== true && wt?.branch === name,
  );
}

/** What the switch does with the answer: reveal `dir`, say `note`. */
export interface DeepRevealPlan {
  /** The directory to reveal — the target's home right now. '' means the
   *  switch has nothing to reveal (no root, no lane), which only happens on
   *  malformed input; a plan is never an error. */
  dir: string;
  /** The branch checked out at `dir`, short name. '' when the directory is
   *  not in any known checkout, or the checkout is detached. */
  branch: string;
  /** HEAD is detached at `dir`. Kept distinct from `branch === ''` meaning
   *  "not in a repository" — the two want different words on screen. */
  detached: boolean;
  /** The pin moved the answer: `dir` is the pinned branch's checkout, not the
   *  directory the lane names. What tells a caller the placement was
   *  branch-driven — the lane's `+` logs the redirect, the reveal does not
   *  care. */
  redirected: boolean;
  /** The git-context fragment for the switch summary, in the summary's own
   *  list style ("now on feat/x (worktree app-feat-x)"), or '' when there is
   *  nothing worth a clause — a folder outside git says nothing rather than
   *  "on no branch". */
  note: string;
}

/**
 * Where a switch should land its reveal — and, through the same rule, where a
 * lane's `+` should start its session.
 *
 * The decision, in order:
 *
 *   1. The BASE is the lane's directory when the switch knows its lane (the
 *      auto-switch's trigger session carries a lane stamp), else the
 *      project's root. A switch that cannot name a lane reveals the project —
 *      the coarse answer is still the right building.
 *   2. The PIN wins over the base. A lane pinning `feat/x` whose checkout
 *      lives at `~/code/app-feat-x` is revealed THERE: the lane's work is the
 *      branch, and the recorded directory is only where the branch used to
 *      be. No checkout for the pin → the base stands (see the header: nothing
 *      is ever created on this path).
 *   3. The NOTE narrates whatever checkout contains the answer. It is a
 *      fragment for the switch summary's comma list, so it reads as one more
 *      fact ("now on feat/x"), and it stays '' for a directory git knows
 *      nothing about — silence over noise.
 */
export function planDeepReveal(input: {
  /** The project's rootDir — the fallback when no lane narrows the target. */
  rootDir: string | undefined;
  /** The lane's directory, when the switch knows which lane it is arriving
   *  at. Also the base a lane's `+` resolves against (pass the lane's dir as
   *  `rootDir` and leave this unset — same answer either way). */
  laneDir?: string | undefined;
  /** SubprojectRecord.branch — the lane's pinned branch, when it has one. */
  pinnedBranch?: string | undefined;
  /** The repository's checkouts at the target, from src/git.ts's probe. An
   *  empty list (not a repository, probe not landed) degrades to "reveal the
   *  base, say nothing" — never to an error. */
  worktrees: readonly Worktree[];
}): DeepRevealPlan {
  const base = normalizeDir(input.laneDir) || normalizeDir(input.rootDir);
  if (base === '') {
    return { dir: '', branch: '', detached: false, redirected: false, note: '' };
  }

  const pinned = worktreeForBranch(input.worktrees, input.pinnedBranch);
  const dir = pinned !== undefined ? normalizeDir(pinned.dir) || base : base;
  const redirected = pathKey(dir) !== pathKey(base);

  const checkout = checkoutAt(input.worktrees, dir);
  const branch = checkout?.detached === true ? '' : checkout?.branch ?? '';
  const detached = checkout?.detached === true;

  let note = '';
  if (detached) {
    note = 'on a detached HEAD';
  } else if (branch !== '') {
    // The worktree is named only when the answer is NOT the repository's main
    // checkout — "on main (worktree app)" would be the main checkout wearing a
    // costume. git guarantees the main worktree is the first stanza of
    // `worktree list`, which parseWorktreeList preserves.
    const main = normalizeDir(input.worktrees?.[0]?.dir);
    const linked = checkout !== undefined && pathKey(checkout.dir) !== '' &&
      main !== '' && pathKey(normalizeDir(checkout.dir)) !== pathKey(main);
    note = linked
      ? `now on ${branch} (worktree ${path.basename(normalizeDir(checkout?.dir))})`
      : `now on ${branch}`;
  }

  return { dir, branch, detached, redirected, note };
}
