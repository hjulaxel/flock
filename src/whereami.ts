// src/whereami.ts — what the window says about WHERE THE FRONT CONVERSATION IS.
//
// Project mode's promise is that one window spans many projects and the window
// follows you: the tabs, the Explorer's folder tree and the sidebar's selection
// all move to whatever you just started typing in. The gap this module fills is
// that none of them SAY so. The Explorer re-roots silently; the tree highlights
// a row you may not be looking at; the status bar named the project the window
// was switched to and stopped there, which is the one fact that is true even
// when everything else has moved on.
//
// So this decides one line: the project you are in, the lane inside it, and the
// branch — read off the conversation in front (src/switcher.ts's answer), not
// off the last switch. Three things follow from that choice:
//
//   * It updates on FOCUS, not on switching. Moving between two lanes of the
//     same project is not a switch — the auto-switch returns early, correctly,
//     because the project did not change — and before this there was no surface
//     that noticed. That move is most of the day for somebody running one lane
//     per worktree.
//   * It can DISAGREE with the window, and says which way. Focus a conversation
//     belonging to another project while auto-switching is off (or while its
//     project is closed) and the window is set up for one project while you are
//     typing in another. That is a real state, it is worth naming, and the click
//     is the way out of it — so the line carries both names and the verb goes to
//     the one you are actually in.
//   * It is SILENT about the obvious. A branch appears only when it is not the
//     one you would assume — a linked worktree, a detached HEAD, or a lane that
//     pins a branch — because a status bar that says `main` on every repository
//     that has never left `main` has spent the space and told you nothing.
//
// PURE, in the shape switcher.ts and deepSwitch.ts established: this decides,
// extension.ts reads the world (the registry, the chain, the projects, the
// worktree probe) and paints. No vscode import — the codicon syntax in the text
// is a string the status bar happens to interpret, and asserting the exact
// string is how the behaviour is tested without a workbench.

import { baseName, normalizeDir, pathKey } from './projects';
import { checkoutAt } from './deepSwitch';
import type { ProjectMatch } from './projects';
import type { ProjectRecord, SubprojectRecord, Worktree } from './types';

/**
 * How long a single name may be before it is elided.
 *
 * The status bar shares a line with the workbench's own items (branch, problems,
 * language) and a project called after a long client is a real thing; a line that
 * pushes the others off the screen is worse than one that ends in a `…`. Real
 * names measured on this machine run to `feat/magma-growth-display-transform` and
 * `feature/dt-v2-sbd-fallback`, so the caps are set from those rather than from
 * a guess.
 *
 * Per KIND, because the kinds are not worth the same: a lane is user-chosen and
 * therefore already short, a branch carries the most information per character,
 * and the project name is the segment a reader can most easily supply from
 * memory. The line's own budget is what keeps three of them from adding up —
 * see the directory rule in `whereAmI`.
 */
export const MAX_SEGMENT = 20;
const MAX_LANE = 16;
const MAX_BRANCH = 22;

/** Everything the line depends on, injected. */
export interface WhereAmIInput {
  /** The project this window is switched to — `WorkspaceManager.activeProjectId`
   *  resolved to a record. Null/undefined is "no workspace", which is a real
   *  state (the user left workspace mode) and not an error. */
  active: ProjectRecord | null | undefined;
  /** The conversation in front, from switcher.frontSession. Null when nothing
   *  is — an empty window, or focus in a file editor. */
  sessionId: string | null;
  /** That conversation's cwd, resolved over the generation chain by the caller
   *  (the same cascade the auto-switch uses). */
  cwd: string | undefined;
  /** EVERY project claiming `cwd`, best first — matchProjects WITH worktree
   *  reach. Plural because claims are (a directory may be listed by two
   *  projects); the head is not automatically the answer, see below. */
  claimants: readonly ProjectMatch[];
  /** The lane the front conversation was started in, when the lane still
   *  exists (`ProjectStore.getSessionSubproject` resolved to a record). */
  lane: SubprojectRecord | null | undefined;
  /** The checkouts of the repository at the front conversation's directory,
   *  from src/git.ts's probe. Empty (not a repository, probe not landed) means
   *  the line simply says nothing about git — never an error. */
  worktrees: readonly Worktree[];
}

export interface WhereAmI {
  /** The status-bar text, codicons included. Never '' — there is always
   *  something honest to say, down to "No Workspace". */
  text: string;
  /** The hover: one fact per line, then what a click does. */
  tooltip: string;
  /**
   * The project id a click should switch to, or null for "open the switcher".
   *
   * Non-null in exactly one case — the front conversation belongs to a project
   * this window is NOT switched to. The click is then the resolution of a
   * disagreement the line just reported, and sending it through the picker
   * instead would make the user re-answer a question the line already answered.
   */
  switchTo: string | null;
  /** The front conversation is in a project other than the active one. Exposed
   *  because it is the one case a caller may want to style (and the one case
   *  worth a log line), not because the text depends on reading it. */
  foreign: boolean;
  /**
   * THE SAME FACTS, unrendered — for the second surface that shows them.
   *
   * The Explorer's Project view says where you are too (src/projectview.ts), and
   * it is a tree of rows rather than one string. Two surfaces re-deriving "which
   * lane, which branch" from the same inputs is two chances to disagree, so the
   * decision is made once here and rendered twice.
   *
   * `lane` is '' when the front conversation was not started in one. `branch`
   * carries the SAME SILENCE the text does — it is set only when the branch is
   * worth naming (a linked worktree, a pin, a detached HEAD), so a surface that
   * shows it cannot end up saying `main` on a repository that has never left it.
   */
  lane: string;
  branch: string;
  detached: boolean;
}

/** One name, capped. Cuts on the CAP rather than on a word boundary: the tail of
 *  a project name is usually what distinguishes it from its siblings, so an
 *  elision that keeps more characters is worth more than one that reads well. */
function clip(name: string, max = MAX_SEGMENT): string {
  const s = typeof name === 'string' ? name.trim() : '';
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Branch names that carry no information on a repository's MAIN checkout.
 *
 * The one place this module guesses, and it guesses about a naming convention
 * rather than about the user's work. Both failure directions are cheap: a
 * repository whose trunk is called `release` spends one short segment saying so,
 * and a feature branch someone genuinely named `develop` goes unnamed in the main
 * checkout. Neither is a wrong statement — only a differently useful one.
 */
const TRUNK_NAMES = new Set(['main', 'master', 'trunk', 'develop', 'default']);

/**
 * The branch clause, and the rule for whether there is one.
 *
 * SHOWN when the checkout is not the repository's main one, when HEAD is
 * detached, when the lane pins a branch, or when the branch is simply not a
 * trunk name. SILENT for `main` on the main checkout: the workbench's own git
 * indicator is right there saying it, and a segment that reads `main` on every
 * repository that has never left `main` has spent the space and told you nothing.
 *
 * The trunk-name test rather than "is this the main checkout" alone, because the
 * main checkout of a repository sitting on a feature branch is a real and common
 * state — it is what a repository looks like while somebody works in it — and
 * that IS the fact this line exists to carry.
 *
 * git guarantees the main worktree is the first stanza of `worktree list`, which
 * parseWorktreeList preserves — so "linked" is "not the first one".
 */
function branchClause(
  worktrees: readonly Worktree[],
  cwd: string | undefined,
  pinned: string | undefined,
): { branch: string; detached: boolean; linked: boolean; show: boolean } {
  const checkout = checkoutAt(worktrees, cwd);
  const detached = checkout?.detached === true;
  const branch = detached ? '' : checkout?.branch ?? '';
  const main = normalizeDir(worktrees?.[0]?.dir);
  const linked =
    checkout !== undefined &&
    main !== '' &&
    pathKey(normalizeDir(checkout.dir)) !== pathKey(main);
  const pinnedHere = typeof pinned === 'string' && pinned.trim() !== '';
  const offTrunk = branch !== '' && !TRUNK_NAMES.has(branch.toLowerCase());
  return {
    branch,
    detached,
    linked,
    show:
      detached ||
      (branch !== '' && (linked || offTrunk || pinnedHere)),
  };
}

/**
 * The line.
 *
 * The order of questions is the order the answers matter in:
 *
 *   1. NO WORKSPACE — the window is not scoped to anything. Nothing about the
 *      front conversation changes that, so it is answered first and alone.
 *   2. THIS project's own claim on the front conversation. Claims are plural
 *      and their head is a stable alphabetical tie-break, so the head is the
 *      wrong thing to ask for here: a directory shared by the project you
 *      switched into and one other would report the OTHER one for half the
 *      alphabet. What matters is whether the active project claims where you
 *      are, so that is the question asked.
 *   3. FOREIGN — no claim from the active project, but some other project
 *      claims it. Both names, and the click goes to the one you are in.
 *   4. UNPLACED — a conversation no project claims (a loose directory). The
 *      line falls back to naming the workspace, because saying "nowhere" about
 *      the project the tabs and the Explorer are still showing would be a
 *      louder claim than the truth.
 */
export function whereAmI(input: WhereAmIInput): WhereAmI {
  const active = input.active ?? null;
  if (!active) {
    return {
      text: '$(layers) No Workspace',
      tooltip:
        'Flock: this window is not scoped to a project.\n' +
        'Click to pick one — its tabs, its sessions and its folders come with it.',
      switchTo: null,
      foreign: false,
      lane: '',
      branch: '',
      detached: false,
    };
  }

  const claimants = input.claimants ?? [];
  const mine = claimants.find((m) => m.project.id === active.id);

  // 3. FOREIGN: the window is set up for one project, the keyboard is in
  // another. Reported rather than fixed — fixing it silently is what the
  // auto-switch does when it is on, and when it is off the user turned it off.
  //
  // A CLOSED project is skipped rather than offered. `hidden` means the user put
  // it away: it has no row in any tree, and a status bar naming it — with a click
  // that reopens it by switching — would make the status bar the only place a put
  // away project appears. If every claimant is closed the line falls through to
  // naming the workspace, which is the honest answer for a conversation whose
  // project is not on screen anywhere.
  const there = claimants.find((m) => m.project.hidden !== true);
  if (mine === undefined && there !== undefined && input.sessionId !== null) {
    return {
      text: `$(layers) ${clip(active.name)} $(arrow-right) ${clip(there.project.name)}`,
      tooltip: [
        `This window is set up for ${active.name}, but the conversation in ` +
          `front belongs to ${there.project.name}.`,
        `Directory: ${there.dir}`,
        '',
        `Click to switch this window to ${there.project.name}.`,
      ].join('\n'),
      switchTo: there.project.id,
      foreign: true,
      // Nothing about a project this window is not showing: the lane and the
      // branch belong to a place the surfaces below are not looking at, and
      // drawing them into THIS project's rows would file them under the wrong
      // heading.
      lane: '',
      branch: '',
      detached: false,
    };
  }

  // 2 / 4. Home, or at least nothing that contradicts home.
  //
  // EVERYTHING BELOW IS CONDITIONAL ON `mine`. The fall-through case — a
  // conversation in a directory NO project claims — reaches here too, and there
  // the lane and the branch describe somewhere this project has nothing to do
  // with. Observed on real data: a window switched to one project, a conversation
  // running in a loose directory, and the line read "<project> on clean-up" —
  // naming that directory's branch under this project's heading, which is a
  // sentence nobody could act on. Unplaced conversations get the project name and
  // nothing else.
  const placed = mine !== undefined;
  const lane = placed ? input.lane ?? null : null;
  const laneName = lane !== null ? clip(lane.name, MAX_LANE) : '';
  const git = placed
    ? branchClause(input.worktrees, input.cwd, lane?.branch)
    : { branch: '', detached: false, linked: false, show: false };

  // The directory segment, and when it earns its space. The project's MAIN
  // directory is already named by the project, and a checkout the branch clause
  // is about to name is named twice — in both cases the segment is dropped.
  let dirSegment = '';
  const dir = mine?.dir;
  if (dir !== undefined && dir !== '') {
    const isMain = pathKey(normalizeDir(dir)) === pathKey(normalizeDir(active.rootDir));
    // Dropped whenever a branch segment is coming. THE LINE'S BUDGET: three
    // variable segments measured out on real names run past sixty characters and
    // push the workbench's own items off the screen. The branch is the segment
    // that survives, because it carries the most information per character — and
    // because the Explorer's Project view now says the same thing untruncated,
    // with the directory in its hover, so the terse version costs nothing.
    if (!isMain && !git.show) dirSegment = clip(baseName(dir) || dir);
  }

  const where = laneName !== '' ? laneName : dirSegment;
  const parts = [`$(layers) ${clip(active.name)}`];
  if (where !== '') parts.push(`› ${where}`);
  if (git.show) {
    parts.push(
      git.detached
        ? '$(git-commit) detached'
        : `$(git-branch) ${clip(git.branch, MAX_BRANCH)}`,
    );
  }

  const lines = [`Project: ${active.name}`];
  if (mine?.dir !== undefined && mine.dir !== '') lines.push(`Directory: ${mine.dir}`);
  if (lane !== null) {
    lines.push(
      lane.branch !== undefined && lane.branch !== ''
        ? `Lane: ${lane.name} — pinned to ${lane.branch}`
        : `Lane: ${lane.name}`,
    );
  }
  if (git.detached) {
    lines.push('Branch: detached HEAD');
  } else if (git.branch !== '') {
    const checkout = checkoutAt(input.worktrees, input.cwd);
    lines.push(
      git.linked
        ? `Branch: ${git.branch} (worktree ${baseName(normalizeDir(checkout?.dir))})`
        : `Branch: ${git.branch}`,
    );
  }
  if (input.sessionId === null) {
    lines.push('', 'No conversation in front — this is the window\'s project.');
  }
  lines.push('', 'Click to switch project.');

  return {
    text: parts.join(' '),
    tooltip: lines.join('\n'),
    switchTo: null,
    foreign: false,
    lane: lane?.name ?? '',
    branch: git.show && !git.detached ? git.branch : '',
    detached: git.show && git.detached,
  };
}
