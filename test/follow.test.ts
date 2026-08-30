// test/follow.test.ts — where the auto-switch window points itself.
//
// `planFollow` is the whole of the decision Axel described: session → its
// subproject's directory for the Explorer, session → its git worktree for
// Source Control. It imports ./projects, ./deepSwitch and ./types only, so none
// of this needs the vscode mock, which is the point of putting the rule in a
// pure module at all — the answer is easy to get subtly wrong and impossible to
// test inside a workbench.
//
// The first case below is the one that was WRONG before this module existed:
// `activeSessionDir` asked `matchProjects` which directory claims the session's
// cwd, and for a session in a linked worktree the answer is the worktree ROOT,
// while the sidebar files the same session under the `api` lane. Two rules for
// one question.

import { describe, expect, it } from 'vitest';

import { planFollow } from '../src/follow';
import type { ProjectRecord, SubprojectRecord, Worktree } from '../src/types';

const ANCHOR = '/Users/x/.lineage/anchor';

function project(over: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'p1',
    name: 'Mono',
    rootDir: '/m/mono/api',
    dirs: ['/m/mono/web'],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function lane(over: Partial<SubprojectRecord> = {}): SubprojectRecord {
  return {
    id: 'l1',
    projectId: 'p1',
    name: 'Server rewrite',
    dir: '/m/mono/api',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function wt(dir: string, branch: string, detached = false): Worktree {
  return { dir, branch, head: 'abc1234', detached };
}

/** The monorepo shape Axel described: one repository, two checkouts, the
 *  project split into `api` and `web` in the main one. */
const MONO: Worktree[] = [wt('/m/mono', 'main'), wt('/m/mono-feat-x', 'feat/x')];

describe('planFollow: the lane inside the session\'s own worktree', () => {
  it('roots at the lane directory TRANSLATED into the checkout the session is in', () => {
    // The case that was wrong. `matchProjects` answers `/m/mono-feat-x` here,
    // because that is the path the project REACHES the session through; the
    // sidebar answers `api`. The tree has to be the one the user is editing.
    const plan = planFollow({
      sessionId: 's1',
      cwd: '/m/mono-feat-x/api/src',
      project: project(),
      lane: null,
      worktrees: MONO,
      anchorPath: ANCHOR,
    });
    expect(plan.dir).toBe('/m/mono-feat-x/api');
    expect(plan.repo).toBe('/m/mono-feat-x');
    expect(plan.reason).toBe('directory');
  });

  it('roots at the project directory directly when the session is in the main checkout', () => {
    const plan = planFollow({
      sessionId: 's1',
      cwd: '/m/mono/web/app/pages',
      project: project(),
      lane: null,
      worktrees: MONO,
      anchorPath: ANCHOR,
    });
    expect(plan.dir).toBe('/m/mono/web');
    expect(plan.repo).toBe('/m/mono');
    expect(plan.reason).toBe('directory');
  });

  it('lets a NAMED lane outrank the directory row that contains it', () => {
    // A name somebody typed outranks every derived rule — the same precedence
    // buildSubprojects gives the stamp — and it is translated into the
    // session's checkout on the way, exactly as the directory row is.
    const plan = planFollow({
      sessionId: 's1',
      cwd: '/m/mono-feat-x/api/server/src',
      project: project(),
      lane: lane({ dir: '/m/mono/api/server' }),
      worktrees: MONO,
      anchorPath: ANCHOR,
    });
    expect(plan.dir).toBe('/m/mono-feat-x/api/server');
    expect(plan.reason).toBe('lane');
  });

  it('drops a candidate that does not contain the session', () => {
    // A lane redirected to another folder describes somewhere else. Rooting the
    // tree there is the "showing them a tree they are not editing" failure.
    const plan = planFollow({
      sessionId: 's1',
      cwd: '/m/mono/api/src',
      project: project(),
      lane: lane({ dir: '/m/other' }),
      worktrees: MONO,
      anchorPath: ANCHOR,
    });
    expect(plan.dir).toBe('/m/mono/api');
    expect(plan.reason).toBe('directory');
  });
});

describe('planFollow: the checkout is a harder boundary than a folder claim', () => {
  it('never roots the tree above the repository Source Control will show', () => {
    // A project pointed at a parent of several repositories. A file tree
    // spanning three repositories while the SCM view shows one is exactly the
    // disagreement this model exists to remove.
    const plan = planFollow({
      sessionId: 's1',
      cwd: '/code/app-x/src',
      project: project({ id: 'p2', rootDir: '/code', dirs: [] }),
      lane: null,
      worktrees: [wt('/code/app', 'main'), wt('/code/app-x', 'x')],
      anchorPath: ANCHOR,
    });
    expect(plan.dir).toBe('/code/app-x');
    expect(plan.repo).toBe('/code/app-x');
    expect(plan.reason).toBe('checkout');
  });

  it('still lets a lane INSIDE the checkout win, because that is the work', () => {
    const plan = planFollow({
      sessionId: 's1',
      cwd: '/code/app-x/api/src',
      project: project({ id: 'p2', rootDir: '/code', dirs: [] }),
      lane: lane({ projectId: 'p2', dir: '/code/app-x/api' }),
      worktrees: [wt('/code/app', 'main'), wt('/code/app-x', 'x')],
      anchorPath: ANCHOR,
    });
    expect(plan.dir).toBe('/code/app-x/api');
    expect(plan.reason).toBe('lane');
  });

  it('treats a detached HEAD as a repository like any other', () => {
    // Source Control is about the checkout, not about having a branch name.
    const plan = planFollow({
      sessionId: 's1',
      cwd: '/code/app-x/src',
      project: null,
      lane: null,
      worktrees: [wt('/code/app', 'main'), wt('/code/app-x', '', true)],
      anchorPath: ANCHOR,
    });
    expect(plan.repo).toBe('/code/app-x');
    expect(plan.dir).toBe('/code/app-x');
  });
});

describe('planFollow: the states where it deliberately says nothing', () => {
  it('says nothing at all with no conversation in front, or no cwd', () => {
    // `dir: ''` is LEAVE EVERYTHING ALONE and never "clear the tree". There is
    // no front conversation when the user clicks into a file, and a tree that
    // blanked itself for that would be the worst outcome available.
    const base = {
      project: project(),
      lane: null,
      worktrees: MONO,
      anchorPath: ANCHOR,
    };
    expect(planFollow({ ...base, sessionId: null, cwd: '/m/mono/api' })).toEqual(
      { dir: '', repo: '', reason: 'none' },
    );
    expect(planFollow({ ...base, sessionId: 's1', cwd: undefined })).toEqual({
      dir: '',
      repo: '',
      reason: 'none',
    });
    expect(planFollow({ ...base, sessionId: 's1', cwd: '' })).toEqual({
      dir: '',
      repo: '',
      reason: 'none',
    });
  });

  it('never answers with the anchor, which would collide with folder[0]', () => {
    // A splice naming one directory twice is rejected in its ENTIRETY, so an
    // anchor answer costs the user the whole tree rather than one row.
    expect(
      planFollow({
        sessionId: 's1',
        cwd: ANCHOR,
        project: null,
        lane: null,
        worktrees: [],
        anchorPath: ANCHOR,
      }).dir,
    ).toBe('');
    const plan = planFollow({
      sessionId: 's1',
      cwd: '/m/mono/api/src',
      project: project({ rootDir: ANCHOR, dirs: [] }),
      lane: lane({ dir: ANCHOR }),
      worktrees: MONO,
      anchorPath: ANCHOR,
    });
    expect(plan.dir).toBe('/m/mono');
    expect(plan.reason).toBe('checkout');
  });

  it('leaves Source Control alone while the worktree probe is cold', () => {
    // `[]` is both "not a repository" and "the probe has not landed", and the
    // caller cannot tell them apart. Pointing SCM at a guess is worse than
    // saying nothing for the ~40ms until the probe lands and repaints.
    const plan = planFollow({
      sessionId: 's1',
      cwd: '/m/mono/api/src',
      project: project(),
      lane: null,
      worktrees: [],
      anchorPath: ANCHOR,
    });
    expect(plan.repo).toBe('');
    expect(plan.dir).toBe('/m/mono/api');
  });
});

describe('planFollow: a session no project claims', () => {
  it('still roots the tree, at the checkout it is in', () => {
    // A loose repository the user has not filed into a project yet is still
    // somewhere they are working, and the auto-switch model follows the
    // SESSION rather than the project.
    const plan = planFollow({
      sessionId: 's1',
      cwd: '/tmp/scratch/src',
      project: null,
      lane: null,
      worktrees: [wt('/tmp/scratch', 'main')],
      anchorPath: ANCHOR,
    });
    expect(plan.dir).toBe('/tmp/scratch');
    expect(plan.repo).toBe('/tmp/scratch');
    expect(plan.reason).toBe('checkout');
  });

  it('falls all the way to the session\'s own directory when nothing else holds it', () => {
    const plan = planFollow({
      sessionId: 's1',
      cwd: '/tmp/scratch/src',
      project: null,
      lane: null,
      worktrees: [],
      anchorPath: ANCHOR,
    });
    expect(plan).toEqual({ dir: '/tmp/scratch/src', repo: '', reason: 'cwd' });
  });
});
