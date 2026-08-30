// src/follow.ts — what the AUTO-SWITCH window follows: one session, two
// surfaces.
//
// THE FEATURE, in Axel's words: "you open VS Code, you don't open it in any
// specific folder, and from there, when you are in a project — or in a
// subproject — that subproject's related git worktree and the directory of that
// project/subproject will be shown in the Explorer and in the Source Control."
// So the unit of follow is the SESSION, not the project the window last
// switched to, and the answer has two halves that must agree: one directory for
// the file tree, one checkout for Source Control.
//
// WHY THIS IS ITS OWN MODULE. `src/explorer.ts` owns HOW the folder tree moves
// (the anchor, the minimal splice, the invariant that keeps a splice from
// restarting the extension host). It has never owned WHERE to move it — that
// arrived as a `currentDir` the wiring computed inline, one line of it, and
// that one line was wrong in the case Axel described: `activeSessionDir` asked
// `matchProjects` which of the project's directories claims the session's cwd,
// and for a session inside a LINKED WORKTREE the answer is the worktree ROOT,
// because that is the path the project reaches the session through. The sidebar
// meanwhile files the same session under the `api` lane. Two rules for one
// question is the design document's own definition of a bug, and the fix is a
// third place that both can be read from rather than a second inline patch.
//
// THE THREE CANDIDATES, and why DEEPEST WINS among them:
//
//   * THE LANE the session was started in, translated into the checkout the
//     session is actually running in. A name somebody typed outranks every
//     derived rule, exactly as it does in `buildSubprojects` — it is the user's
//     own answer to a question nothing else can answer.
//   * THE PROJECT DIRECTORY containing the session, asked as the MAIN CHECKOUT
//     would spell it (`canonicalCheckoutPath`) and then translated back into
//     the session's own checkout (`inCheckout`). This is the step that makes a
//     split monorepo work: the user named `api` and `web` once, in the checkout
//     they had open, and every other checkout of that repository has the same
//     shape under a different prefix.
//   * THE CHECKOUT itself, which is also the Source Control answer.
//
// Deepest wins because a checkout is a HARDER boundary than a folder claim: a
// project pointed at a parent of several repositories must not root the tree
// above the repository Source Control is about to show. A file tree spanning
// three repositories while the SCM view shows one is precisely the disagreement
// this model exists to remove. And equally, a lane inside a checkout beats the
// checkout, because the lane is the thing being worked on. Ties go to the
// earlier candidate, which puts the lane ahead of the directory row that merely
// contains it.
//
// EVERY CANDIDATE MUST CONTAIN THE SESSION'S CWD. A candidate that does not
// describes somewhere else — a lane redirected to another folder, a project
// directory that only reaches this session through a worktree that has since
// moved — and rooting the tree there is exactly the "showing them a tree they
// are not editing" failure `narrowToCurrent` already names. Containment is
// cheap, it is the same test project membership and the launch fence use, and
// it is what makes every rung of the ladder safe to fall down.
//
// `dir: ''` MEANS LEAVE EVERYTHING ALONE, and never "clear the tree". There is
// no conversation in front when the user clicks into a file, when a window
// first opens, or when the worktree probe has not landed; a file tree that
// blanked itself in any of those moments would be the worst behaviour this
// feature could produce. The caller reads an empty plan as "nothing to say" and
// does not splice. The same rule governs `repo: ''`: Source Control is left
// showing whatever it already shows rather than pointed at a guess.
//
// PURE, in the shape `deepSwitch.ts` and `whereami.ts` established: this module
// decides, and the wiring in extension.ts reads the world (the front
// conversation, the claim list, the lane record, the worktree cache) and acts.
// No vscode import and no filesystem — whether a directory EXISTS is
// `ExplorerSync.filterMissing`'s question, and giving two layers a vote on it
// is how they end up disagreeing.

import { checkoutAt } from './deepSwitch';
import {
  canonicalCheckoutPath,
  inCheckout,
  isWithin,
  normalizeDir,
  pathKey,
  projectDirs,
} from './projects';
import type { ProjectRecord, SubprojectRecord, Worktree } from './types';

/** The world one follow decision needs, all of it already read by the wiring
 *  that paints the "where am I" line — see extension.ts, where the two are
 *  computed on the same tick from the same reads so they cannot disagree. */
export interface FollowInput {
  /** The conversation in FRONT, or null when there is none. */
  sessionId: string | null;
  /** Its working directory. Undefined for a session whose cwd is not known
   *  yet, which is a "say nothing" state and not an error. */
  cwd: string | undefined;
  /** The project this window is filing that session under, or null when no
   *  project claims it. A null project is a normal state in this model — a
   *  loose checkout the user has not filed yet is still somewhere they are
   *  working. */
  project: ProjectRecord | null;
  /** The lane the session was STARTED in (`EditorialRecord.subprojectId`
   *  resolved to its record), or null. The only input that can tell two lanes
   *  on one directory apart. */
  lane: SubprojectRecord | null;
  /** The checkouts of the repository the session sits in, MAIN WORKTREE FIRST
   *  — the order `git worktree list` reports and `parseWorktreeList`
   *  preserves. `[]` for a directory that is not in a repository AND for one
   *  whose probe has not landed; the caller cannot tell those apart and must
   *  not need to. */
  worktrees: readonly Worktree[];
  /** The Flock anchor, which is never a follow target: it is an empty
   *  directory the extension owns, and a splice naming it twice is a splice the
   *  workbench rejects outright. */
  anchorPath?: string;
}

/** One decision, for both surfaces. */
export interface FollowPlan {
  /** The single Explorer root, or '' for "leave the tree where it is". */
  dir: string;
  /** The repository Source Control should be showing, or '' for "say
   *  nothing" — a cold worktree probe, or a directory outside git. */
  repo: string;
  /** Which rung answered. Carried for the log, so a follow that lands
   *  somewhere surprising can be explained without re-deriving it. */
  reason: 'lane' | 'directory' | 'checkout' | 'cwd' | 'none';
}

const NOTHING: FollowPlan = { dir: '', repo: '', reason: 'none' };

/** The deepest directory of `project` that contains the session, asked in the
 *  main checkout's spelling and answered in the session's own. Separate from
 *  `planFollow` only because the two-spellings dance is the part worth reading
 *  twice. '' when the project lists nothing containing the session. */
function directoryRow(
  project: ProjectRecord | null,
  worktrees: readonly Worktree[],
  here: Worktree | undefined,
  cwd: string,
): string {
  if (!project) return '';
  // The same two passes `subprojectIndexForCwd` makes, and in the same order:
  // a directory that literally contains the session outranks one that only
  // reaches it through a checkout. Asking the canonical question FIRST would
  // send a session in the main checkout on a pointless round trip.
  const canonical = canonicalCheckoutPath(worktrees, cwd);
  for (const probe of [cwd, canonical]) {
    if (probe === '') continue;
    let best = '';
    for (const dir of projectDirs(project)) {
      if (!isWithin(dir, probe)) continue;
      if (dir.length > best.length) best = dir;
    }
    if (best !== '') return inCheckout(worktrees, here, best);
  }
  return '';
}

/**
 * Where the Explorer and Source Control should be pointed for the conversation
 * in front. See the header for the ladder and for why each rung is the shape it
 * is; nothing here is allowed to throw, because a follow that fails must leave
 * the window exactly as it was.
 */
export function planFollow(input: FollowInput): FollowPlan {
  const cwd = normalizeDir(input?.cwd);
  if (!input || input.sessionId === null || cwd === '') return NOTHING;

  const anchorKey = pathKey(normalizeDir(input.anchorPath));
  // A session running IN the anchor is not a thing the product can produce —
  // the anchor is an empty directory nothing is launched in — but a window
  // whose state got into that shape must not answer with it: the anchor is
  // already folder[0], and a splice naming one directory twice is rejected in
  // its entirety, which would cost the user the whole tree rather than one row.
  if (anchorKey !== '' && pathKey(cwd) === anchorKey) return NOTHING;

  const here = checkoutAt(input.worktrees ?? [], cwd);
  const repo = normalizeDir(here?.dir);

  const candidates: { dir: string; reason: FollowPlan['reason'] }[] = [
    {
      dir: inCheckout(input.worktrees ?? [], here, input.lane?.dir),
      reason: 'lane',
    },
    {
      dir: directoryRow(input.project ?? null, input.worktrees ?? [], here, cwd),
      reason: 'directory',
    },
    { dir: repo, reason: 'checkout' },
  ];

  let best: { dir: string; reason: FollowPlan['reason'] } | null = null;
  for (const candidate of candidates) {
    const dir = normalizeDir(candidate.dir);
    if (dir === '') continue;
    if (anchorKey !== '' && pathKey(dir) === anchorKey) continue;
    // The containment rule. A candidate that does not hold the session is
    // describing somewhere else, and this is the one place that is checked —
    // every rung below is reached BECAUSE the rung above failed it.
    if (!isWithin(dir, cwd)) continue;
    if (best === null || pathKey(dir).length > pathKey(best.dir).length) {
      best = { dir, reason: candidate.reason };
    }
  }

  // The session's own directory, which is where it is. Reached when the project
  // claims it through something that has since moved, when there is no project
  // and no repository, or when a lane was pointed somewhere else — and it is
  // still a tree the user is editing, which is the whole bar a candidate has to
  // clear here.
  if (best === null) return { dir: cwd, repo, reason: 'cwd' };
  return { dir: best.dir, repo, reason: best.reason };
}
