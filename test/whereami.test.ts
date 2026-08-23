// test/whereami.test.ts — the "where am I" status line.
//
// src/whereami.ts imports ./projects, ./deepSwitch and ./types only, so none of
// this needs the vscode mock. What is under test is the DECISIONS: which facts
// earn a segment, which are left unsaid, and what a click does when the window
// and the keyboard disagree about which project you are in.

import { describe, expect, it } from 'vitest';

import { MAX_SEGMENT, whereAmI } from '../src/whereami';
import type { ProjectMatch } from '../src/projects';
import type { ProjectRecord, SubprojectRecord, Worktree } from '../src/types';

// ------------------------------------------------------------------ helpers

function project(over: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'p1',
    name: 'App',
    rootDir: '/code/app',
    dirs: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function claim(p: ProjectRecord, dir: string, own = true): ProjectMatch {
  return { project: p, dir, depth: dir.length, own };
}

function lane(over: Partial<SubprojectRecord> = {}): SubprojectRecord {
  return {
    id: 'l1',
    projectId: 'p1',
    name: 'ingest',
    dir: '/code/app',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

/** A repository whose MAIN checkout is first, as git reports it. */
const repo: Worktree[] = [
  { dir: '/code/app', branch: 'main', head: 'a1', detached: false },
  { dir: '/code/app-feat-x', branch: 'feat/x', head: 'b2', detached: false },
];

/** The common shape: standing in the active project's main directory. */
function atHome(over: Parameters<typeof whereAmI>[0] | object = {}) {
  const p = project();
  return whereAmI({
    active: p,
    sessionId: 's1',
    cwd: '/code/app',
    claimants: [claim(p, '/code/app')],
    lane: null,
    worktrees: repo,
    ...over,
  });
}

// ------------------------------------------------------------- no workspace

describe('whereAmI: no workspace', () => {
  it('says so, and offers the picker', () => {
    const out = whereAmI({
      active: null,
      sessionId: null,
      cwd: undefined,
      claimants: [],
      lane: null,
      worktrees: [],
    });
    expect(out.text).toBe('$(layers) No Workspace');
    expect(out.switchTo).toBeNull();
    expect(out.foreign).toBe(false);
  });

  it('is answered FIRST — a front conversation does not change it', () => {
    // Nothing about where the keyboard is makes an unscoped window scoped, and
    // naming the conversation's project here would read as "this window is that
    // project" when the tabs and the Explorer are showing everything.
    const p = project();
    const out = whereAmI({
      active: null,
      sessionId: 's1',
      cwd: '/code/app',
      claimants: [claim(p, '/code/app')],
      lane: null,
      worktrees: [],
    });
    expect(out.text).toBe('$(layers) No Workspace');
  });
});

// ----------------------------------------------------------------- at home

describe('whereAmI: inside the active project', () => {
  it('names the project alone when there is nothing to add', () => {
    expect(atHome().text).toBe('$(layers) App');
  });

  it('stays silent about the MAIN checkout of a repository on its own branch', () => {
    // The one case a branch segment would be pure noise: the workbench's own
    // git indicator is already saying `main`, and it has never been anything
    // else.
    expect(atHome().text).not.toContain('git-branch');
    expect(atHome().tooltip).toContain('Branch: main');
  });

  it('names a non-main directory of the project', () => {
    const p = project({ dirs: ['/code/lib'] });
    const out = whereAmI({
      active: p,
      sessionId: 's1',
      cwd: '/code/lib/src',
      claimants: [claim(p, '/code/lib')],
      lane: null,
      worktrees: [],
    });
    expect(out.text).toBe('$(layers) App › lib');
  });

  it('prefers the LANE name over the directory — the user chose it', () => {
    const p = project({ dirs: ['/code/lib'] });
    const out = whereAmI({
      active: p,
      sessionId: 's1',
      cwd: '/code/lib',
      claimants: [claim(p, '/code/lib')],
      lane: lane({ name: 'ingest', dir: '/code/lib' }),
      worktrees: [],
    });
    expect(out.text).toBe('$(layers) App › ingest');
    expect(out.tooltip).toContain('Lane: ingest');
  });

  it('answers with THIS project, not the claim list head', () => {
    // The bug this rule exists for: claims are plural and their order is a
    // stable alphabetical tie-break, so a directory two projects list reports
    // the alphabetical winner — and a window switched to the OTHER one would
    // read as foreign, in its own directory, for half the alphabet.
    const mine = project({ id: 'mine', name: 'Zebra', rootDir: '/code/shared' });
    const other = project({ id: 'other', name: 'Alpha', rootDir: '/code/shared' });
    const out = whereAmI({
      active: mine,
      sessionId: 's1',
      cwd: '/code/shared/pkg',
      claimants: [claim(other, '/code/shared'), claim(mine, '/code/shared')],
      lane: null,
      worktrees: [],
    });
    expect(out.foreign).toBe(false);
    expect(out.text).toBe('$(layers) Zebra');
    expect(out.switchTo).toBeNull();
  });
});

// ------------------------------------------------------------------- branch

describe('whereAmI: when the branch earns its space', () => {
  it('names a LINKED worktree by its branch, not by its directory', () => {
    // Both would be true; the branch is the one that says what the work IS, and
    // printing `App › app-feat-x $(git-branch) feat/x` says it twice.
    const p = project();
    const out = whereAmI({
      active: p,
      sessionId: 's1',
      cwd: '/code/app-feat-x/src',
      claimants: [claim(p, '/code/app-feat-x', false)],
      lane: null,
      worktrees: repo,
    });
    expect(out.text).toBe('$(layers) App $(git-branch) feat/x');
    expect(out.tooltip).toContain('Branch: feat/x (worktree app-feat-x)');
  });

  it('keeps the LANE name alongside the branch', () => {
    const p = project();
    const out = whereAmI({
      active: p,
      sessionId: 's1',
      cwd: '/code/app-feat-x',
      claimants: [claim(p, '/code/app-feat-x', false)],
      lane: lane({ name: 'feature', dir: '/code/app-feat-x', branch: 'feat/x' }),
      worktrees: repo,
    });
    expect(out.text).toBe('$(layers) App › feature $(git-branch) feat/x');
    expect(out.tooltip).toContain('Lane: feature — pinned to feat/x');
  });

  it('names a FEATURE branch on the main checkout — the common real state', () => {
    // A repository's own checkout sitting on a feature branch is what a
    // repository looks like while somebody works in it, and it is the fact the
    // line exists to carry. Only a TRUNK name is left unsaid.
    const p = project();
    const out = whereAmI({
      active: p,
      sessionId: 's1',
      cwd: '/code/app',
      claimants: [claim(p, '/code/app')],
      lane: null,
      worktrees: [
        { dir: '/code/app', branch: 'feat/growth', head: 'a1', detached: false },
      ],
    });
    expect(out.text).toBe('$(layers) App $(git-branch) feat/growth');
    expect(out.branch).toBe('feat/growth');
  });

  it('leaves every conventional trunk name unsaid on the main checkout', () => {
    const p = project();
    for (const trunk of ['main', 'master', 'trunk', 'develop', 'Main']) {
      const out = whereAmI({
        active: p,
        sessionId: 's1',
        cwd: '/code/app',
        claimants: [claim(p, '/code/app')],
        lane: null,
        worktrees: [
          { dir: '/code/app', branch: trunk, head: 'a1', detached: false },
        ],
      });
      expect(out.text, trunk).toBe('$(layers) App');
      expect(out.branch, trunk).toBe('');
    }
  });

  it('names a trunk branch in a LINKED checkout — there it is not the default', () => {
    // `main` checked out in a second worktree is a deliberate arrangement, not
    // the repository's resting state.
    const p = project();
    const out = whereAmI({
      active: p,
      sessionId: 's1',
      cwd: '/code/app-release',
      claimants: [claim(p, '/code/app-release', false)],
      lane: null,
      worktrees: [
        { dir: '/code/app', branch: 'feat/x', head: 'a1', detached: false },
        { dir: '/code/app-release', branch: 'main', head: 'b2', detached: false },
      ],
    });
    expect(out.text).toBe('$(layers) App $(git-branch) main');
  });

  it('shows a PINNED branch even in the main checkout', () => {
    // The pin is the lane's whole statement about itself: a lane pinned to
    // `main` is on `main` deliberately, and saying so is not noise.
    const p = project();
    const out = whereAmI({
      active: p,
      sessionId: 's1',
      cwd: '/code/app',
      claimants: [claim(p, '/code/app')],
      lane: lane({ branch: 'main' }),
      worktrees: repo,
    });
    expect(out.text).toBe('$(layers) App › ingest $(git-branch) main');
  });

  it('calls a detached HEAD detached rather than calling it nothing', () => {
    const p = project();
    const out = whereAmI({
      active: p,
      sessionId: 's1',
      cwd: '/code/app',
      claimants: [claim(p, '/code/app')],
      lane: null,
      worktrees: [{ dir: '/code/app', branch: '', head: 'c3', detached: true }],
    });
    expect(out.text).toBe('$(layers) App $(git-commit) detached');
    expect(out.tooltip).toContain('Branch: detached HEAD');
  });

  it('says nothing about git when the probe has not landed', () => {
    // An empty worktree list is both "not a repository" and "not probed yet",
    // and the line must degrade to silence for either — never to an error and
    // never to a guess.
    const p = project();
    const out = whereAmI({
      active: p,
      sessionId: 's1',
      cwd: '/code/app',
      claimants: [claim(p, '/code/app')],
      lane: null,
      worktrees: [],
    });
    expect(out.text).toBe('$(layers) App');
    expect(out.tooltip).not.toContain('Branch:');
  });
});

// ------------------------------------------------------------------ foreign

describe('whereAmI: the window and the keyboard disagree', () => {
  const mine = project({ id: 'mine', name: 'App' });
  const there = project({ id: 'there', name: 'API', rootDir: '/code/api' });

  const out = whereAmI({
    active: mine,
    sessionId: 's1',
    cwd: '/code/api/src',
    claimants: [claim(there, '/code/api')],
    lane: null,
    worktrees: [],
  });

  it('carries BOTH names and marks itself foreign', () => {
    expect(out.text).toBe('$(layers) App $(arrow-right) API');
    expect(out.foreign).toBe(true);
  });

  it('sends the click to the project you are actually in', () => {
    // The line just reported the disagreement; routing the click through the
    // picker would ask the user to answer a question already answered.
    expect(out.switchTo).toBe('there');
  });

  it('needs a front conversation — an active project alone is not a disagreement', () => {
    const quiet = whereAmI({
      active: mine,
      sessionId: null,
      cwd: '/code/api/src',
      claimants: [claim(there, '/code/api')],
      lane: null,
      worktrees: [],
    });
    expect(quiet.foreign).toBe(false);
    expect(quiet.text).toBe('$(layers) App');
    expect(quiet.tooltip).toContain('No conversation in front');
  });

  it('falls back to the workspace for a conversation NO project claims', () => {
    // A loose directory. "Nowhere" would be a louder claim than the truth: the
    // tabs and the Explorer are still showing the active project.
    const loose = whereAmI({
      active: mine,
      sessionId: 's1',
      cwd: '/tmp/scratch',
      claimants: [],
      lane: null,
      worktrees: [],
    });
    expect(loose.foreign).toBe(false);
    expect(loose.switchTo).toBeNull();
    expect(loose.text).toBe('$(layers) App');
  });

  it('says NOTHING about an unplaced conversation\'s branch or lane', () => {
    // Observed on real data: a window switched to one project, a conversation in
    // a loose directory that happened to be a git repository, and the line read
    // "<project> on clean-up" — filing that repository's branch under this
    // project's heading. The facts are real and the sentence is not.
    const loose = whereAmI({
      active: mine,
      sessionId: 's1',
      cwd: '/tmp/scratch',
      claimants: [],
      lane: lane({ name: 'ingest', dir: '/tmp/scratch' }),
      worktrees: [
        { dir: '/tmp/scratch', branch: 'clean-up', head: 'z9', detached: false },
      ],
    });
    expect(loose.text).toBe('$(layers) App');
    expect(loose.lane).toBe('');
    expect(loose.branch).toBe('');
    expect(loose.beyondTheFolder).toBe(false);
  });

  it('drops the DIRECTORY segment when a branch is coming', () => {
    // Three variable segments measured on real names run past sixty characters.
    // The branch survives; the Explorer's Project view carries the untruncated
    // pair, so nothing is lost.
    const p = project({ dirs: ['/code/lib'] });
    const out = whereAmI({
      active: p,
      sessionId: 's1',
      cwd: '/code/lib',
      claimants: [claim(p, '/code/lib')],
      lane: null,
      worktrees: [
        { dir: '/code/lib', branch: 'feat/long-branch-name', head: 'a', detached: false },
      ],
    });
    expect(out.text).toBe('$(layers) App $(git-branch) feat/long-branch-name');
    expect(out.text).not.toContain('lib');
    // A LANE is not dropped — it is user-chosen, short, and the one thing no
    // other surface says.
    const withLane = whereAmI({
      active: p,
      sessionId: 's1',
      cwd: '/code/lib',
      claimants: [claim(p, '/code/lib')],
      lane: lane({ name: 'ingest', dir: '/code/lib' }),
      worktrees: [
        { dir: '/code/lib', branch: 'feat/x', head: 'a', detached: false },
      ],
    });
    expect(withLane.text).toBe('$(layers) App › ingest $(git-branch) feat/x');
  });
});

// -------------------------------------------------------------------- width

describe('whereAmI: the line stays a line', () => {
  it('elides a long name rather than pushing the status bar around', () => {
    const long = 'a-very-long-client-project-name-indeed';
    const p = project({ name: long });
    const out = whereAmI({
      active: p,
      sessionId: null,
      cwd: undefined,
      claimants: [],
      lane: null,
      worktrees: [],
    });
    expect(out.text.length).toBeLessThan(long.length);
    expect(out.text.endsWith('…')).toBe(true);
    // The FULL name is still available where there is room for it.
    expect(out.tooltip).toContain(long);
  });

  it('leaves a name that fits exactly alone', () => {
    const exact = 'x'.repeat(MAX_SEGMENT);
    const out = whereAmI({
      active: project({ name: exact }),
      sessionId: null,
      cwd: undefined,
      claimants: [],
      lane: null,
      worktrees: [],
    });
    expect(out.text).toBe(`$(layers) ${exact}`);
  });
});
