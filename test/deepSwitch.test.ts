// test/deepSwitch.test.ts — where a project-mode switch reveals, and where a
// pinned lane launches.
//
// src/deepSwitch.ts imports ./projects and ./types only, so none of this needs
// the vscode mock. What is under test is the DECISIONS: which checkout contains
// a directory, which checkout a pinned branch resolves to, and how the two
// compose into a reveal target and a summary note — including every degradation
// (no repository, no pin, a pin with no checkout) landing on "the base
// directory, silently" rather than on an error.

import { describe, expect, it } from 'vitest';

import {
  checkoutAt,
  planDeepReveal,
  worktreeForBranch,
} from '../src/deepSwitch';
import type { Worktree } from '../src/types';

// ------------------------------------------------------------------ helpers

function wt(dir: string, branch: string, over: Partial<Worktree> = {}): Worktree {
  return { dir, branch, head: 'abc123', detached: false, ...over };
}

/** A repository the way `git worktree list` reports one: the MAIN checkout
 *  first, linked worktrees after — the order parseWorktreeList preserves and
 *  planDeepReveal's "is this the main checkout?" test relies on. */
const REPO: Worktree[] = [
  wt('/code/app', 'main'),
  wt('/code/app-feat-x', 'feat/x'),
  wt('/code/app-detached', '', { detached: true }),
];

// ---------------------------------------------------------------- checkoutAt

describe('deepSwitch: checkoutAt', () => {
  it('answers by CONTAINMENT, not equality — a lane inside the checkout is on its branch', () => {
    expect(checkoutAt(REPO, '/code/app/src/api')?.branch).toBe('main');
  });

  it('the deepest containing checkout wins', () => {
    // Nested worktrees are unusual but git permits them; the shallow answer
    // would name the wrong branch for everything under the inner one.
    const nested = [wt('/code/app', 'main'), wt('/code/app/wt', 'feat/inner')];
    expect(checkoutAt(nested, '/code/app/wt/deep')?.branch).toBe('feat/inner');
    expect(checkoutAt(nested, '/code/app/src')?.branch).toBe('main');
  });

  it('undefined outside every checkout, and for a blank directory', () => {
    expect(checkoutAt(REPO, '/somewhere/else')).toBeUndefined();
    expect(checkoutAt(REPO, '')).toBeUndefined();
    expect(checkoutAt(REPO, undefined)).toBeUndefined();
  });

  it('skips malformed entries rather than matching on them', () => {
    const dirty = [wt('', 'ghost'), ...REPO];
    expect(checkoutAt(dirty, '/code/app')?.branch).toBe('main');
  });
});

// --------------------------------------------------------- worktreeForBranch

describe('deepSwitch: worktreeForBranch', () => {
  it('finds the checkout of a branch by exact short name', () => {
    expect(worktreeForBranch(REPO, 'feat/x')?.dir).toBe('/code/app-feat-x');
  });

  it('trims the pin — a name with stray whitespace still matches', () => {
    expect(worktreeForBranch(REPO, '  feat/x ')?.dir).toBe('/code/app-feat-x');
  });

  it('an empty or missing pin matches NOTHING — not even a detached checkout', () => {
    // A detached checkout's branch is '', and an empty pin "finding" it would
    // send a lane to whatever directory happens to be detached today.
    expect(worktreeForBranch(REPO, '')).toBeUndefined();
    expect(worktreeForBranch(REPO, undefined)).toBeUndefined();
  });

  it('never matches a detached checkout by name either', () => {
    const odd = [wt('/code/x', 'feat/x', { detached: true })];
    expect(worktreeForBranch(odd, 'feat/x')).toBeUndefined();
  });
});

// -------------------------------------------------------------- planDeepReveal

describe('deepSwitch: planDeepReveal', () => {
  it('reveals the lane over the root — the lane is where the user moved into', () => {
    const plan = planDeepReveal({
      rootDir: '/code/app',
      laneDir: '/code/app/src/api',
      worktrees: REPO,
    });
    expect(plan.dir).toBe('/code/app/src/api');
    expect(plan.branch).toBe('main');
    expect(plan.redirected).toBe(false);
  });

  it('falls back to the project root when no lane narrows the target', () => {
    const plan = planDeepReveal({ rootDir: '/code/app', worktrees: REPO });
    expect(plan.dir).toBe('/code/app');
    expect(plan.note).toBe('now on main');
  });

  it('has nothing to reveal only on malformed input — and says so as data, not an error', () => {
    const plan = planDeepReveal({ rootDir: '', worktrees: REPO });
    expect(plan).toEqual({
      dir: '',
      branch: '',
      detached: false,
      redirected: false,
      note: '',
    });
  });

  it('a PINNED branch redirects to its checkout — the branch outranks the folder', () => {
    const plan = planDeepReveal({
      rootDir: '/code/app',
      laneDir: '/code/app',
      pinnedBranch: 'feat/x',
      worktrees: REPO,
    });
    expect(plan.dir).toBe('/code/app-feat-x');
    expect(plan.redirected).toBe(true);
    expect(plan.branch).toBe('feat/x');
    // The note names the worktree, because the answer is NOT the main checkout.
    expect(plan.note).toBe('now on feat/x (worktree app-feat-x)');
  });

  it('a pin with NO checkout leaves the base standing — nothing is ever created', () => {
    const plan = planDeepReveal({
      rootDir: '/code/app',
      pinnedBranch: 'feat/gone',
      worktrees: REPO,
    });
    expect(plan.dir).toBe('/code/app');
    expect(plan.redirected).toBe(false);
    expect(plan.note).toBe('now on main');
  });

  it('a pin already checked out AT the base is not a redirect', () => {
    const plan = planDeepReveal({
      rootDir: '/code/app',
      pinnedBranch: 'main',
      worktrees: REPO,
    });
    expect(plan.dir).toBe('/code/app');
    expect(plan.redirected).toBe(false);
    // No "(worktree app)" costume on the main checkout.
    expect(plan.note).toBe('now on main');
  });

  it('a base inside a LINKED worktree names it, pin or no pin', () => {
    const plan = planDeepReveal({
      rootDir: '/code/app-feat-x/src',
      worktrees: REPO,
    });
    expect(plan.note).toBe('now on feat/x (worktree app-feat-x)');
  });

  it('a detached HEAD is said in those words — not passed off as a branch', () => {
    const plan = planDeepReveal({
      rootDir: '/code/app-detached',
      worktrees: REPO,
    });
    expect(plan.branch).toBe('');
    expect(plan.detached).toBe(true);
    expect(plan.note).toBe('on a detached HEAD');
  });

  it('a directory git knows nothing about reveals silently — no note over noise', () => {
    const plan = planDeepReveal({ rootDir: '/notes/journal', worktrees: [] });
    expect(plan.dir).toBe('/notes/journal');
    expect(plan.branch).toBe('');
    expect(plan.note).toBe('');
  });

  it("serves a lane's `+` through the same rule: laneDir as the root, no laneDir", () => {
    // commands.lanePlacement calls with rootDir = lane.dir — prove the two
    // spellings agree, so the reveal and the placement cannot drift apart.
    const asLane = planDeepReveal({
      rootDir: '/code/app',
      pinnedBranch: 'feat/x',
      worktrees: REPO,
    });
    const asSwitch = planDeepReveal({
      rootDir: '/irrelevant-root',
      laneDir: '/code/app',
      pinnedBranch: 'feat/x',
      worktrees: REPO,
    });
    expect(asLane.dir).toBe(asSwitch.dir);
    expect(asLane.redirected).toBe(asSwitch.redirected);
  });
});
