// src/recommend.ts — what a fresh install should turn on, and why.
//
// THE PROBLEM THIS FILE EXISTS TO FIX. Flock contributes dozens of settings
// and a good many of them are booleans that ship OFF. They are off for four
// different reasons, and exactly one of those reasons is "you probably do not
// want this":
//
//   CONSENT     `hooks.enabled` and `verbs.enabled` are off because turning
//               them on writes files under the user's home directory. Both are
//               marquee features — instant updates instead of a three-second
//               poll, and "fork this session" said TO Claude — and both were
//               reachable only by somebody who already knew they existed. This
//               is the group a recommended setup is FOR.
//   POLICY      `showForeignSessions`, `showArchived`, `showPhantomRows` and
//               `unclaimedSessions` ARE the clean slate. Flipping any of them
//               for somebody undoes the thing that made their first launch
//               quiet, so nothing here may touch them, ever.
//   ROW BUDGET  the branch block works and costs rows in a 250px sidebar. That
//               is a preference about a person's own repositories, so it is
//               OFFERED here — unticked — and never assumed.
//   TASTE       `soloSession`, `showTokens`, `notifications.popup`, the two
//               previews, `offerSwitchAtLimit`. Not recommendable in either
//               direction; they stay in the settings UI where they belong.
//               TWO taste questions ARE worth asking out loud, because a
//               person who has never met the keys behind them cannot ask them
//               of themselves. Where sessions open (`terminalLocation` +
//               `soloSession` + `launch.mode`) is the `surface` step; what a
//               WINDOW is (`mode`, and the legacy `workspaces.enabled` it
//               supersedes) is the `windowModel` step. Both are explicit
//               questions, never pre-ticked checkboxes that write settings:
//               the steps themselves carry no settings at all, the writes
//               belong to whichever option is CHOSEN in the picker
//               (`surfaceChoices` / `windowModelChoices` below), and
//               cancelling either writes nothing.
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

import { resolveLaunchMode } from './hosts';
import { resolveMode } from './modes';
import { tmuxInstallHint } from './tmux';
import { CONFIG_KEYS, LEGACY_KEYS } from './types';
import type { RecommendedWorld } from './types';

export type { RecommendedWorld };

/** Every step id, in the order the checklist offers them. The order is the
 *  journey: repair what is switched off, get a row on the tree, then make the
 *  tree live, then the optional rows. */
export const RECOMMENDED_STEP_IDS = [
  'tmux',
  'surface',
  'windowModel',
  'project',
  'import',
  'hooks',
  'verbs',
  'worktrees',
] as const;

export type RecommendedStepId = (typeof RECOMMENDED_STEP_IDS)[number];

/** One setting write, section-relative (`git.branches`, not
 *  `lineage.git.branches`) — the spelling `CONFIG_KEYS` uses and the one a
 *  configuration scoped to `lineage` takes. `undefined` DELETES the key: the
 *  one write a retired key (`LEGACY_KEYS`) may receive, and only from a choice
 *  the user made that the old key would otherwise fold straight back. */
export interface RecommendedSetting {
  readonly key: string;
  readonly value: boolean | string | undefined;
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

  // ---- where sessions open --------------------------------------------------
  //
  // ALWAYS OFFERED, which makes it the one step with no `done` arm: a choice
  // has no "already done". Every other line here repairs or enables something,
  // so "already true" retires it; this one is a question, and the defaults
  // being AN answer is not the same as the person having been asked.
  //
  // It is TASTE, so it is ASKED — a FLOW step whose tick opens an explicit
  // four-way picker (commands.ts) — and never pre-answered: the step itself
  // writes nothing, and confirming the checklist with it ticked still writes
  // nothing until an option is chosen in that picker. The four options and
  // their writes are `surfaceChoices` below, so the sentence a person reads
  // and the keys it moves live in the same file.
  steps.push({
    id: 'surface',
    title: 'Choose where sessions open',
    why:
      'Four places a session can live: one pinned tab at a time, a tab per ' +
      'session beside your files, the official Claude Code extension’s own ' +
      'UI, or the terminal panel under your editor. The default is fine; the ' +
      'point is that it was never YOUR answer until you give it.',
    writes: 'opens a picker of the four — nothing until you choose one there',
    undo: 'run Recommended Setup again and choose differently',
    recommended: true,
    settings: [],
  });

  // ---- what a window is -----------------------------------------------------
  //
  // ALWAYS OFFERED, the second step with no `done` arm, and for exactly the
  // reason the one above has none: this is a question, and the default being AN
  // answer is not the same as the person having been asked. It is a stronger
  // case than `surface`, if anything — `lineage.mode` decides what a window IS,
  // and until now the only route to it was a dropdown among forty-odd settings
  // whose values read `folder` / `flock` / `project` rather than in words
  // anybody uses. A three-way choice nobody can find is not a choice.
  //
  // It writes nothing itself: the tick opens `windowModelChoices`'s picker
  // (commands.ts, the same plumbing `surface` uses) and the OPTION writes, so a
  // cancelled picker is "no" and costs nothing.
  //
  // The default stays `folder` whatever anybody picks here — that is the point
  // of asking rather than flipping. Somebody who wants the auto-switching window
  // gets it because they chose it, and their choice also retires the legacy
  // `workspaces.enabled` key on their machine, which no activation of ours is
  // ever going to do for them.
  steps.push({
    id: 'windowModel',
    title: 'Choose what a window is',
    why:
      'Three ways to live: one folder per project, where a window is the ' +
      'folder you opened; Flock only, where the window is the sidebar and you ' +
      'open a window when you want files; or auto-switch, where one window ' +
      'follows whichever project you are working in. Each costs something ' +
      'different, and the default was never your answer.',
    writes: 'opens a picker of the three — nothing until you choose one there',
    undo: 'run Recommended Setup again, or Flock: Choose Window Model…',
    recommended: true,
    settings: [],
  });

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
      undo: 'Archive Session on any row (restorable)',
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
  // It writes `git.branches` ALONE, not the four-key bundle behind
  // `lineage.showBranchesAndWorktrees`. One of those four is a thing Flock
  // otherwise never does unasked — `gh pr list` reaches the network — and that
  // one is enough on its own to keep the bundle out of here: a step labelled
  // "recommended" is read as Flock's own advice, and Flock may not advise
  // itself into talking to a server on somebody's behalf. Offering the bundle
  // and letting the person decline it was the alternative, and it is worse: the
  // decline has to be read to be made, and the whole point of this list is that
  // it can be accepted without reading.
  if (world.maxWorktrees >= 2 && !world.branchRowsEnabled) {
    steps.push({
      id: 'worktrees',
      title: 'Show branch and worktree rows',
      why:
        `One of your repositories has ${world.maxWorktrees} checkouts. Branch ` +
        'rows give each one a row — with New Worktree and Remove Worktree on ' +
        'it — and every session says which checkout it is running in.',
      writes: 'sets lineage.git.branches only — no network, no preview',
      undo: 'Flock: Hide Branches and Worktrees',
      recommended: false,
      settings: [{ key: CONFIG_KEYS.gitBranches, value: true }],
    });
  } else if (world.branchRowsEnabled) {
    done.push('worktrees');
  }

  return { steps, done, notes };
}

// ---------------------------------------------------------- where sessions open

export type SurfaceChoiceId = 'pinnedTab' | 'editorTabs' | 'claudeExtension' | 'panel';

/** One of the four places a session can open — a row of the picker the
 *  `surface` step runs. The settings are written all together when THIS option
 *  is chosen there, and not a moment sooner. */
export interface SurfaceChoice {
  readonly id: SurfaceChoiceId;
  /** The picker label. */
  readonly label: string;
  /** What living there is like, in one sentence. */
  readonly description: string;
  /** Section-relative, `RecommendedSetting`'s own contract. */
  readonly settings: readonly RecommendedSetting[];
  /** Where sessions open TODAY, so the picker can say "(current)" and start
   *  the cursor there. At most one is current; a `newWindow` world marks none,
   *  because a fifth place is not one of these four. */
  readonly current: boolean;
}

/**
 * The four places, with the current one marked.
 *
 * CURRENT IS DERIVED, launch mode first: `resolveLaunchMode` — the exact
 * function every launch runs — decides whether `launch.mode` actually lands in
 * the Claude Code extension, so the picker can never call "current" a mode the
 * launcher would silently fall back from. Only a launch that stays Flock's own
 * consults `terminalLocation` + `soloSession`.
 *
 * The extension option is on offer EVEN WHEN THE EXTENSION IS MISSING, with the
 * absence said in its description instead of the row hidden: the setting is
 * legal to want first and install second, and the launcher already falls back
 * to Flock's own terminal (with a note) until the extension arrives. What the
 * three Flock-side options write includes `launch.mode: flock` for the same
 * honesty in reverse — picked from extension mode, they must actually move you.
 * The extension option writes `launch.mode` ALONE, leaving the Flock-side
 * arrangement where it was for whenever the person comes back.
 */
export function surfaceChoices(
  /** The FOUR fields this actually reads, rather than the whole world — the
   *  narrowing `windowModelChoices` makes, for the same reason: the gear menu
   *  names the current arrangement in its entry, and assembling a full
   *  `RecommendedWorld` for that would probe every project's worktrees behind
   *  opening a menu. Every existing caller passes a full world. */
  world: Pick<
    RecommendedWorld,
    'terminalLocation' | 'soloSession' | 'launchMode' | 'claudeExtensionInstalled'
  >,
): SurfaceChoice[] {
  const resolved = resolveLaunchMode(
    world.launchMode,
    () => world.claudeExtensionInstalled,
  );
  const current: SurfaceChoiceId | undefined =
    resolved.mode === 'claudeExtension'
      ? 'claudeExtension'
      : world.terminalLocation === 'panel'
        ? 'panel'
        : world.terminalLocation === 'editor'
          ? world.soloSession
            ? 'pinnedTab'
            : 'editorTabs'
          : undefined;

  return [
    {
      id: 'pinnedTab',
      label: 'One pinned session tab',
      description:
        'Sessions open as editor tabs, one at a time — the open one is ' +
        'pinned, and the rest park to the tree.',
      settings: [
        { key: CONFIG_KEYS.terminalLocation, value: 'editor' },
        { key: CONFIG_KEYS.soloSession, value: true },
        { key: CONFIG_KEYS.launchMode, value: 'flock' },
      ],
      current: current === 'pinnedTab',
    },
    {
      id: 'editorTabs',
      label: 'Editor tabs',
      description:
        'Every session gets its own tab beside your files — the default.',
      settings: [
        { key: CONFIG_KEYS.terminalLocation, value: 'editor' },
        { key: CONFIG_KEYS.soloSession, value: false },
        { key: CONFIG_KEYS.launchMode, value: 'flock' },
      ],
      current: current === 'editorTabs',
    },
    {
      id: 'claudeExtension',
      label: 'Claude Code extension',
      description:
        'New conversations open in the official extension’s own UI.' +
        (world.claudeExtensionInstalled
          ? ''
          : ' It is not installed on this machine yet, so launches fall ' +
            'back to Flock’s own terminal until it is.'),
      settings: [{ key: CONFIG_KEYS.launchMode, value: 'claudeExtension' }],
      current: current === 'claudeExtension',
    },
    {
      id: 'panel',
      label: 'Bottom terminal panel',
      description: 'Sessions open in the terminal panel under your editor.',
      settings: [
        { key: CONFIG_KEYS.terminalLocation, value: 'panel' },
        { key: CONFIG_KEYS.soloSession, value: false },
        { key: CONFIG_KEYS.launchMode, value: 'flock' },
      ],
      current: current === 'panel',
    },
  ];
}

// ---------------------------------------------------------- what a window is

export type WindowModelId = 'folder' | 'root' | 'project';

/** One of the three window models — a row of the picker the `windowModel` step
 *  runs, and of `Flock: Choose Window Model…`. Shaped exactly like
 *  `SurfaceChoice` because it IS the same question in a different subject: a
 *  taste choice whose settings are written all together when this option is
 *  chosen, and not a moment sooner. */
export interface WindowModelChoice {
  readonly id: WindowModelId;
  /** The picker label — Axel's words for the model, never the enum value. */
  readonly label: string;
  /** What living there is like AND what it costs, in one sentence. The cost
   *  half is not decoration: each of the three is genuinely better than the
   *  others at something and worse at something, and a picker that only listed
   *  the benefits would be selling rather than asking. */
  readonly description: string;
  /** Section-relative, `RecommendedSetting`'s own contract. */
  readonly settings: readonly RecommendedSetting[];
  /** The model this window is in TODAY, so the picker can say "(current)" and
   *  start the cursor there. Exactly one is always current — unlike the surface
   *  question, every window is in one of these three by construction. */
  readonly current: boolean;
}

/**
 * The three models, with the current one marked.
 *
 * CURRENT IS RESOLVED, not read: `resolveMode` — the exact function every gate
 * in the extension runs — folds the raw `lineage.mode` string together with the
 * legacy `lineage.workspaces.enabled`, so a window carrying the old
 * `(project, false)` pair is correctly shown as **Flock only**, which is what it
 * has always actually been. A picker that called "current" a value the runtime
 * resolves differently would be lying to the one person trying to find out
 * where they are, and that is precisely the confusion this whole change exists
 * to end. Same contract as `surfaceChoices` and `resolveLaunchMode` above.
 *
 * AUTO-SWITCH WRITES THREE KEYS. `folder` and `flock` write `lineage.mode`
 * alone; `project` also writes `lineage.workspaces.enabled: true` and DELETES
 * the retired `lineage.workspaces.autoSwitch`, because without those a user
 * with an old `false` sitting in their settings would choose Auto-switch, watch
 * `resolveMode` fold them straight back to Flock only, and have no way to see
 * why. These are the only places either old key is ever touched, and both
 * happen by somebody's own choice — which is the only way this extension
 * touches a settings file. The retired key is deleted rather than set: the
 * manifest no longer declares it, and VS Code refuses a value on a key it does
 * not know but permits removing one.
 */
export function windowModelChoices(
  /** The THREE fields this actually reads, rather than the whole world.
   *  Narrowed so a caller that only wants to name the current model — the gear
   *  menu's preview — does not have to build (or await) the rest of it:
   *  assembling a `RecommendedWorld` probes every project's worktrees, which is
   *  far too much work to put behind opening a menu. Every existing caller
   *  passes a full world and is unaffected. */
  world: Pick<
    RecommendedWorld,
    'mode' | 'workspacesEnabled' | 'workspacesAutoSwitch'
  >,
): WindowModelChoice[] {
  const current = resolveMode(
    world.mode,
    world.workspacesEnabled,
    world.workspacesAutoSwitch,
  );

  return [
    {
      id: 'folder',
      label: 'One folder per project',
      description:
        'A window is the folder you opened, like every other extension ' +
        'assumes — the sidebar shows only that folder’s sessions, and nothing ' +
        'ever rearranges itself. Costs a window per project, and alt-tab is ' +
        'your switcher.',
      settings: [{ key: CONFIG_KEYS.mode, value: 'folder' }],
      current: current === 'folder',
    },
    {
      id: 'root',
      label: 'Flock only',
      description:
        'The window is Flock’s: no folder, nothing scoped, everything on the ' +
        'machine in one sidebar, and a session opens its own window when you ' +
        'want files. Costs you that window, and a sidebar with nothing ' +
        'narrowing it.',
      settings: [{ key: CONFIG_KEYS.mode, value: 'root' }],
      current: current === 'root',
    },
    {
      id: 'project',
      label: 'Auto-switch',
      description:
        'One window follows you: work in another project’s session and the ' +
        'window goes there — its tabs, its files, its branch. The most ' +
        'convenient of the three and the hardest to keep straight. Costs you ' +
        'a window that rearranges itself, tmux to keep what you left running, ' +
        'and one reload before the file tree follows too.',
      settings: [
        { key: CONFIG_KEYS.mode, value: 'project' },
        { key: CONFIG_KEYS.workspacesEnabled, value: true },
        { key: LEGACY_KEYS.workspacesAutoSwitch, value: undefined },
      ],
      current: current === 'project',
    },
  ];
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
  // The `surface` and `windowModel` steps are on EVERY plan by design — a
  // choice has no "already done" — so counting them would quietly lower the
  // threshold to "anybody with no projects", the exact firing this threshold
  // exists to stop. Two always-offered steps rather than one makes this
  // subtraction load-bearing rather than merely correct: without it the
  // threshold of two would be met by them alone.
  const recommended = plan.steps.filter(
    (s) => s.recommended && s.id !== 'surface' && s.id !== 'windowModel',
  ).length;
  return recommended >= 2 ? 'offer' : 'none';
}
