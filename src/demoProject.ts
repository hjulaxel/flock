// src/demoProject.ts — a fabricated project, for looking at the layout.
//
// Behind `lineage.preview.demoProject`, and it exists because the two questions
// you ask of a layout change need different things to look at. "Is this right for
// MY monorepo" needs real directories and real branches, which is what
// `lineage.preview.directoryModel` gives you. "Is this layout right AT ALL" needs
// a project engineered to have every shape the rows can draw at once — three
// directories, two repositories, a branch with sessions on it, a branch checked
// out with nothing running, a detached head, a fold with enough in it to be worth
// folding — and almost nobody has one of those lying around.
//
// NOTHING IN HERE IS REAL, and that is enforced rather than promised:
//
//   - every id starts with DEMO_PREFIX, and `isDemoId` is what the command layer
//     checks before it does anything at all;
//   - the project is built from a constant on every call, never read from or
//     written to `state.json`, so it cannot be renamed, deleted, re-pointed or
//     merged into a real record;
//   - its directories are under a path that says what it is
//     (`/flock-demo/...`) and are never handed to a terminal, a `cwd`, or
//     `Uri.file()`;
//   - it is injected into the GROUPING result, downstream of every rule that
//     decides what a session belongs to, so it cannot claim a real session or
//     move a real row.
//
// Turning the switch off removes it completely, because there was never anything
// of it anywhere else.

import { BRANCH_COLOR_COUNT } from './projects';
import type { BranchInfo, ProjectGroupNode, SubprojectNode } from './types';

/**
 * What every fabricated id begins with.
 *
 * Deliberately NOT a uuid: `isSessionId` rejects it, so a demo session id cannot
 * be mistaken for a real one by any of the guards that already parse ids — the
 * row simply resolves to nothing rather than to somebody else's session. The
 * prefix is the readable half of the same protection.
 */
export const DEMO_PREFIX = 'flock-demo:';

/** The one project id, so a `when` clause or a log line can name it. */
export const DEMO_PROJECT_ID = `${DEMO_PREFIX}project`;

/** Where the demo pretends to live. Under a root that exists on no machine, so a
 *  path that escapes into a message is self-evidently not the user's. */
const DEMO_ROOT = '/flock-demo';

/** True for anything this module minted. THE GATE every verb checks: a demo row
 *  carries a real-looking context object (that is the point — the menus have to
 *  draw), so the refusal has to happen where the verb starts rather than in the
 *  renderer. */
export function isDemoId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith(DEMO_PREFIX);
}

/** Seconds, for a commit date `n` days ago. The demo's ages have to move with
 *  the clock or the fold reads as frozen the day after it was written. */
function daysAgo(now: number, days: number): number {
  return Math.floor(now / 1000) - days * 24 * 60 * 60;
}

/**
 * One branch row's worth of fabricated facts.
 *
 * `dir: ''` is the load-bearing one — see BranchInfo.dir. It is how the demo shows
 * a branch that exists as a ref and nowhere on disk, which is what most of a real
 * repository's branches are and the whole reason the fold has anything in it.
 */
function branch(
  name: string,
  over: Partial<BranchInfo> & { shown: boolean },
): BranchInfo {
  return {
    name,
    dir: '',
    colorIndex: 0,
    rootIds: [],
    primary: false,
    ...over,
  };
}

/**
 * The demo project, as the grouping pass would have produced it.
 *
 * Three directories, because two is the threshold and three is the first number
 * that shows the threshold was not the point: `app` is a repository with two
 * checkouts and work in flight, `api` is a directory INSIDE that repository (the
 * monorepo split, where the directory's own branch is the repo's main worktree),
 * and `notes` is not a repository at all and draws no branches — which is the
 * case that proves the block is per-directory rather than per-project.
 *
 * `now` is passed in rather than read, so the ages are stable within one paint
 * and this function stays pure.
 */
export function buildDemoProject(now: number): ProjectGroupNode {
  const dirs = [`${DEMO_ROOT}/app`, `${DEMO_ROOT}/app/api`, `${DEMO_ROOT}/notes`];

  const appBranches: BranchInfo[] = [
    // The directory's own checkout. Colour 0, first row — the position the real
    // builder gives it and the reason `main` keeps one hue forever.
    branch('main', {
      dir: `${DEMO_ROOT}/app`,
      primary: true,
      shown: true,
      colorIndex: 0,
      lastCommitAt: daysAgo(now, 0),
    }),
    // A second promoted row: a linked worktree the user has PINNED
    // (`shownBranches`), which is how a branch stays out of the fold without a
    // session on it. Promoted here by fiat — the demo sets `shown` itself rather
    // than deriving it, because it has no sessions for the real policy to read.
    branch('feat/webtree-layout', {
      dir: `${DEMO_ROOT}/app-feat-webtree-layout`,
      shown: true,
      colorIndex: 1,
      lastCommitAt: daysAgo(now, 1),
    }),
    // A CHECKOUT WITH NOTHING RUNNING IN IT, folded away. The deliberate
    // difference from the old policy, and the one worth looking at: a worktree you
    // are not using this week is a directory, not work in flight.
    branch('spike/tmux-detach', {
      dir: `${DEMO_ROOT}/app-spike-tmux-detach`,
      shown: false,
      colorIndex: 2,
      lastCommitAt: daysAgo(now, 6),
    }),
    branch('fix/roster-rekey', { shown: false, lastCommitAt: daysAgo(now, 2) }),
    branch('fix/hook-truncation', { shown: false, lastCommitAt: daysAgo(now, 9) }),
    branch('release/0.1.1', { shown: false, lastCommitAt: daysAgo(now, 21) }),
    branch('chore/deps', { shown: false, lastCommitAt: daysAgo(now, 48) }),
    branch('old/first-draft', { shown: false, lastCommitAt: daysAgo(now, 400) }),
  ];

  const apiBranches: BranchInfo[] = [
    // Inside the same repository, so its own branch IS the repo's main worktree —
    // the row leads with the checkout it physically sits in.
    branch('main', {
      dir: `${DEMO_ROOT}/app`,
      primary: true,
      shown: true,
      colorIndex: 0,
      lastCommitAt: daysAgo(now, 0),
    }),
    branch('feat/api-pagination', {
      shown: false,
      lastCommitAt: daysAgo(now, 3),
    }),
    branch('(detached)', {
      dir: `${DEMO_ROOT}/app-detached`,
      shown: false,
      colorIndex: 1,
      lastCommitAt: daysAgo(now, 12),
    }),
  ];

  // NO SESSIONS, ANYWHERE, and this is the one thing the demo cannot fake.
  //
  // A session row is drawn by looking its id up in the FOREST — the real roster of
  // real processes — so a fabricated id draws nothing whatever this list says. The
  // choice was between an empty list and one that makes a branch row claim a
  // session count you cannot expand into: a control that does not work, which is
  // worse than a demo that says plainly it has no sessions in it.
  //
  // So the demo is about the SHAPE — how directories, branches and the fold sit
  // together — and `lineage.preview.directoryModel` over your own repositories is
  // where sessions under a branch are worth looking at.
  const subprojects: SubprojectNode[] = [
    {
      // A NAMED LANE, and the row the whole v7 model exists for: it and the one
      // below name the SAME directory. Nothing on disk tells them apart — same
      // path, same repository, same branches — so the name is the only thing that
      // can, and a session belongs to one because it was started there.
      type: 'subproject',
      projectId: DEMO_PROJECT_ID,
      id: `${DEMO_PREFIX}lane-server`,
      name: 'Server rewrite',
      implicit: false,
      dir: dirs[0],
      dirKey: dirs[0].toLowerCase(),
      label: 'Server rewrite',
      main: false,
      rootIds: [],
      branches: appBranches,
    },
    {
      // The second lane on the same directory. Its branch list is the same
      // repository's, because the branches belong to the DIRECTORY — two lanes in
      // one folder see the same branches, and which of them a session is in is not
      // a question git can answer.
      type: 'subproject',
      projectId: DEMO_PROJECT_ID,
      id: `${DEMO_PREFIX}lane-cs`,
      name: 'CS tooling',
      implicit: false,
      dir: dirs[0],
      dirKey: dirs[0].toLowerCase(),
      label: 'CS tooling',
      main: false,
      rootIds: [],
      branches: appBranches,
    },
    {
      // An IMPLICIT row: a directory nobody has named a lane in, labelled by its
      // basename. Every project that has never used lanes draws only these, which
      // is why the tree is unchanged for them.
      type: 'subproject',
      projectId: DEMO_PROJECT_ID,
      id: `dir:${dirs[1].toLowerCase()}`,
      name: '',
      implicit: true,
      dir: dirs[1],
      dirKey: dirs[1].toLowerCase(),
      label: 'api',
      main: false,
      rootIds: [],
      branches: apiBranches,
    },
    {
      // Not a repository: no branches and no fold. The row that shows the block
      // belongs to the directory rather than to the project.
      type: 'subproject',
      projectId: DEMO_PROJECT_ID,
      id: `dir:${dirs[2].toLowerCase()}`,
      name: '',
      implicit: true,
      dir: dirs[2],
      dirKey: dirs[2].toLowerCase(),
      label: 'notes',
      main: false,
      rootIds: [],
      branches: [],
    },
  ];

  return {
    type: 'project',
    projectId: DEMO_PROJECT_ID,
    // Says what it is on the row itself, because a fabricated project that looked
    // like a real one would be a trap the first time somebody forgot the switch
    // was on.
    label: 'Flock (demo)',
    rootDir: dirs[0],
    dirs,
    provider: 'claude',
    rootIds: [],
    subprojects,
    // Empty for the same reason a real split project's is: the directories carry
    // the branches, and drawing them here as well would draw them twice.
    branches: [],
    branchesCollapsed: false,
    parentProjectId: null,
    depth: 0,
    childProjectIds: [],
  };
}

/** How many colours the demo's branches may use, asserted against the palette so
 *  a fabricated row can never ask for a hue the stylesheets do not define. */
export const DEMO_MAX_COLOR_INDEX = BRANCH_COLOR_COUNT - 1;
