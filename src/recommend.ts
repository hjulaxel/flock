// src/recommend.ts — what a fresh install should turn on, and why.
//
// THE PROBLEM THIS FILE EXISTS TO FIX. Flock contributes forty settings and
// seventeen of them are booleans that ship OFF. They are off for four different
// reasons, and exactly one of those reasons is "you probably do not want this":
//
//   CONSENT     `hooks.enabled` and `verbs.enabled` are off because turning
//               them on writes files under the user's home directory. Both are
//               marquee features — instant updates instead of a three-second
//               poll, and "fork this session" said TO Claude — and both were
//               reachable only by somebody who already knew they existed. This
//               is the group a recommended setup is FOR.
//   POLICY      `showForeignSessions`, `showArchived`, `showPhantomRows` and
//               `onlyProjectSessions` ARE the clean slate. Flipping any of them
//               for somebody undoes the thing that made their first launch
//               quiet, so nothing here may touch them, ever.
//   ROW BUDGET  the branch block works and costs rows in a 250px sidebar. That
//               is a preference about a person's own repositories, so it is
//               OFFERED here — unticked — and never assumed.
//   TASTE       `soloSession`, `showTokens`, `notifications.popup`, the two
//               previews, `offerSwitchAtLimit`. Not recommendable in either
//               direction; they stay in the settings UI where they belong.
//
// A "recommended setup" is only honest if it moves the first group, asks about
// the third, and leaves the other two alone. That distinction is the whole
// content of this file, and the reason it is a module rather than six lines
// inside a command.
//
// PURE, in the shape `tmuxAdvice` (src/tmux.ts) and `branchRowsAdvice`
// (src/git.ts) already established: this decides, a caller supplies the world
// and acts on the answer. extension.ts reads the world (config, install state,
// one worktree probe); commands.ts runs the steps and does the talking.
//
// Every user-facing sentence a step is described by lives HERE, once, and is
// read by the checklist, by the receipt and by the docs that quote it. A `why`
// that only exists in a QuickPick is a `why` that goes stale the first time the
// feature changes.

import { tmuxInstallHint } from './tmux';
import { CONFIG_KEYS } from './types';
import type { RecommendedWorld } from './types';

export type { RecommendedWorld };

/** Every step id, in the order the checklist offers them. The order is the
 *  journey: repair what is switched off, get a row on the tree, then make the
 *  tree live, then the optional rows. */
export const RECOMMENDED_STEP_IDS = [
  'tmux',
  'project',
  'import',
  'hooks',
  'verbs',
  'worktrees',
] as const;

export type RecommendedStepId = (typeof RECOMMENDED_STEP_IDS)[number];

/** One setting write, section-relative (`git.branches`, not
 *  `lineage.git.branches`) — the spelling `CONFIG_KEYS` uses and the one a
 *  configuration scoped to `lineage` takes. */
export interface RecommendedSetting {
  readonly key: string;
  readonly value: boolean | string;
}

export interface RecommendedStep {
  readonly id: RecommendedStepId;
  /** The checklist label. */
  readonly title: string;
  /** WHY it is worth having, in one sentence a person who has never heard of
   *  the feature can act on. Never the setting's name. */
  readonly why: string;
  /** WHAT IT WRITES, short enough to sit beside the title in a 250px-wide
   *  picker and complete enough that nobody is surprised. The full consent —
   *  exact paths — belongs to the install dialog each file-writing step opens
   *  next, which is where it can be read properly. */
  readonly writes: string;
  /** How to undo it, as the verb a person would actually reach for. Said in
   *  the receipt: a setup command that cannot be walked back is a setup command
   *  people are right not to run. */
  readonly undo: string;
  /** Ticked when the checklist opens. False is a real answer: `worktrees` is
   *  offered and not recommended, because it is about the user's repositories
   *  rather than about Flock. */
  readonly recommended: boolean;
  /** Settings this step writes. Empty for a step whose work is a flow —
   *  installing the hooks, opening the folder dialog — which commands.ts runs
   *  by id. A step with neither is a step that does nothing. */
  readonly settings: readonly RecommendedSetting[];
}

export interface RecommendedPlan {
  /** What is left to do, in `RECOMMENDED_STEP_IDS` order. */
  readonly steps: readonly RecommendedStep[];
  /** What is already true. Named in the receipt rather than dropped: "already
   *  installed" is the answer to "did this command do anything", and a
   *  checklist that silently omits it looks like it forgot. */
  readonly done: readonly RecommendedStepId[];
  /** Advice this command cannot act on — today, exactly one thing: tmux is not
   *  installed, and installing it is a package manager's job. Said in the
   *  receipt instead of faked as a step nobody can tick. */
  readonly notes: readonly string[];
}

/**
 * The plan for this machine.
 *
 * Every step is offered only when it would DO something: hooks that are already
 * installed, an import with an empty pool, branch rows for somebody with one
 * checkout each — each of those is a line that wastes the reader's attention on
 * a thing that is already true, and a checklist people learn to skim is worse
 * than no checklist.
 */
export function recommendedPlan(world: RecommendedWorld): RecommendedPlan {
  const steps: RecommendedStep[] = [];
  const done: RecommendedStepId[] = [];
  const notes: string[] = [];

  // ---- tmux ---------------------------------------------------------------
  //
  // Not a feature: the detach tier every other promise in the product rests on.
  // Three worlds, and only the middle one is a step — Windows has no detach
  // tier at all (so there is nothing to say to it), a missing binary is a note
  // because `brew install tmux` is not ours to run, and tmux switched off by
  // hand is one settings write.
  if (world.platform !== 'win32') {
    if (world.tmuxBinary === null) {
      const hint = tmuxInstallHint(world.platform);
      notes.push(
        'tmux is not installed. Without it, switching projects CLOSES the ' +
          'other project’s sessions and resumes them from their transcripts — ' +
          'whatever a session was in the middle of is lost.' +
          (hint === undefined ? '' : ` Install it with \`${hint}\`.`),
      );
    } else if (world.tmuxMode === 'off') {
      steps.push({
        id: 'tmux',
        title: 'Turn tmux back on',
        why:
          'A session keeps running while you look at something else. With ' +
          'tmux off, switching projects closes the other project’s sessions ' +
          'instead of hiding them, and anything they were in the middle of is ' +
          'lost.',
        writes: 'sets lineage.tmux back to auto',
        undo: 'set lineage.tmux to off again',
        recommended: true,
        settings: [{ key: CONFIG_KEYS.tmux, value: 'auto' }],
      });
    } else {
      done.push('tmux');
    }
  }

  // ---- a project ----------------------------------------------------------
  if (world.hasProjects) {
    done.push('project');
  } else {
    steps.push({
      id: 'project',
      title: 'Make your first project',
      why:
        'A project is a name and a directory. Every session running in it ' +
        'groups under it, it gets a workspace of its own to switch to, and it ' +
        'can pin the account its sessions launch on. Without one, sessions sit ' +
        'on plain folder rows.',
      writes: 'a folder dialog — nothing on disk is touched',
      undo: 'Close Project, or Delete Project',
      recommended: true,
      settings: [],
    });
  }

  // ---- the history door ---------------------------------------------------
  //
  // The clean slate's other half. Offering this is not a retreat from it: the
  // tree stays empty until somebody asks, and this is the asking.
  if (world.unlistedCount > 0) {
    steps.push({
      id: 'import',
      title: `Import your previous sessions (${world.unlistedCount})`,
      why:
        'Flock starts empty on purpose — sessions from before it, or running ' +
        'in another terminal, stay off the tree until you say so. This is the ' +
        'bulk door: everything this machine knows that has no row, grouped by ' +
        'folder, newest first.',
      writes: 'a row per session you tick — nothing is resumed or moved',
      undo: 'Delete Session on any row (restorable)',
      recommended: true,
      settings: [],
    });
  } else {
    done.push('import');
  }

  // ---- instant updates ----------------------------------------------------
  if (world.hooksInstalled) {
    done.push('hooks');
  } else {
    steps.push({
      id: 'hooks',
      title: 'Instant updates (hooks)',
      why:
        'Without them the tree is a three-second poll: a session that finishes ' +
        'lights its dot up to three seconds late, and a fork appears on the ' +
        'next tick. With them Claude writes each event as it happens and the ' +
        'tree redraws immediately.',
      writes: 'a plugin directory under ~/.claude/skills — named in full next',
      undo: 'Flock: Remove Instant-Update Hooks',
      recommended: true,
      settings: [],
    });
  }

  // ---- in-session verbs ---------------------------------------------------
  if (!world.verbsAvailable) {
    // Nothing said in either direction: a wiring without the verbs manager has
    // no verbs to recommend and no verbs to report as done.
  } else if (world.verbsInstalled) {
    done.push('verbs');
  } else {
    steps.push({
      id: 'verbs',
      title: 'Let Claude fork its own sessions',
      why:
        '"Fork this session" — or "fork this twice, one for the redis cache, ' +
        'one for the SQL approach" — typed TO Claude runs the same fork the ' +
        'sidebar button runs, names the forks from your own words, and records ' +
        'the same lineage edge before the child starts.',
      writes: 'a skill file and a small CLI — both named in full next',
      undo: 'Flock: Remove In-Session Verbs',
      recommended: true,
      settings: [],
    });
  }

  // ---- the branch rows ----------------------------------------------------
  //
  // OFFERED, NOT RECOMMENDED, and the one step here that ships unticked. Two
  // reasons, both about honesty rather than about the feature: what it costs is
  // rows in a sidebar the person has to live in, and what it is worth depends
  // on how THEY use worktrees, which Flock cannot know. It appears at all only
  // when a repository of theirs actually has more than one checkout — the same
  // load-bearing test `branchRowsAdvice` makes, for the same reason: a
  // single-checkout repository drew no branch rows either way.
  //
  // It writes `git.branches` ALONE, not the five-key bundle behind
  // `lineage.showBranchesAndWorktrees`. Two of those five are things Flock
  // otherwise never does unasked — `gh pr list` reaches the network, and the
  // demo project puts fabricated rows in the tree — and a step called
  // "recommended" may not be the thing that turns either on.
  if (world.maxWorktrees >= 2 && !world.branchRowsEnabled) {
    steps.push({
      id: 'worktrees',
      title: 'Show branch and worktree rows',
      why:
        `One of your repositories has ${world.maxWorktrees} checkouts. Branch ` +
        'rows give each one a row — with New Worktree and Remove Worktree on ' +
        'it — and every session says which checkout it is running in.',
      writes: 'sets lineage.git.branches only — no network, no previews',
      undo: 'Flock: Hide Branches and Worktrees',
      recommended: false,
      settings: [{ key: CONFIG_KEYS.gitBranches, value: true }],
    });
  } else if (world.branchRowsEnabled) {
    done.push('worktrees');
  }

  return { steps, done, notes };
}

/**
 * Should activation OFFER the recommended setup, unprompted?
 *
 * Deliberately hard to trigger, in `branchRowsAdvice`'s spirit: a notice that
 * fires for everybody is a notice about nothing. All of these have to hold —
 *
 *   * it has never been shown (or answered) on this install;
 *   * the tree has NO PROJECTS, which is the strongest signal there is of a
 *     first launch, and the one state in which the sidebar is empty anyway;
 *   * and there are at least TWO recommended steps left.
 *
 * The last one is what keeps it from being noise. With no projects there is
 * always a `project` step, so a threshold of one would make this fire for
 * anybody who ever closed their last project — and say only what the empty view
 * already says, with a button, right there on screen.
 */
export function recommendedNotice(opts: {
  world: RecommendedWorld;
  dismissed: boolean;
}): 'offer' | 'none' {
  if (opts.dismissed) return 'none';
  if (opts.world.hasProjects) return 'none';
  const plan = recommendedPlan(opts.world);
  const recommended = plan.steps.filter((s) => s.recommended).length;
  return recommended >= 2 ? 'offer' : 'none';
}
