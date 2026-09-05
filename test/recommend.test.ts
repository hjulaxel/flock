// test/recommend.test.ts — what a fresh install is offered, and what it is not.
//
// src/recommend.ts is pure, so the whole of this suite is a world in and a plan
// out. Three things are worth pinning and they are pinned deliberately:
//
//   * a step is offered only when it would DO something — the checklist's whole
//     claim on somebody's attention;
//   * the POLICY group is never written. Turning `showForeignSessions` on for
//     somebody would undo the clean slate, so a test that only checked the keys
//     it does write would not notice the day one of those appears;
//   * the notice is hard to trigger. A notice that fires for everybody is a
//     notice about nothing, and the threshold is the only thing holding that.

import { describe, expect, it } from 'vitest';

import {
  RECOMMENDED_STEP_IDS,
  recommendedNotice,
  recommendedPlan,
  surfaceChoices,
  windowModelChoices,
} from '../src/recommend';
import type {
  RecommendedStepId,
  SurfaceChoiceId,
  WindowModelId,
} from '../src/recommend';
import { CONFIG_KEYS, LEGACY_KEYS } from '../src/types';
import type { RecommendedWorld } from '../src/types';

/** A machine on which nothing is left to do — except the surface question,
 *  which is on every plan: tmux installed and on, a project, no unlisted
 *  history, both installs done, one checkout per repository, sessions opening
 *  in the default editor tabs. Each test moves exactly the fields it is
 *  about. */
const settled: RecommendedWorld = {
  platform: 'darwin',
  tmuxBinary: '/opt/homebrew/bin/tmux',
  tmuxMode: 'auto',
  hooksInstalled: true,
  verbsInstalled: true,
  verbsAvailable: true,
  hasProjects: true,
  unlistedCount: 0,
  branchRowsEnabled: false,
  maxWorktrees: 1,
  terminalLocation: 'editor',
  soloSession: false,
  launchMode: 'flock',
  claudeExtensionInstalled: false,
  mode: undefined,
  workspacesEnabled: true,
};

/** A first launch: nothing installed, no projects, history on disk. */
const fresh: RecommendedWorld = {
  ...settled,
  hooksInstalled: false,
  verbsInstalled: false,
  hasProjects: false,
  unlistedCount: 12,
};

const world = (patch: Partial<RecommendedWorld>): RecommendedWorld => ({
  ...settled,
  ...patch,
});

const ids = (w: RecommendedWorld): RecommendedStepId[] =>
  recommendedPlan(w).steps.map((s) => s.id);

describe('recommendedPlan: what is offered', () => {
  it('offers only the surface question on a machine where everything else is true', () => {
    const plan = recommendedPlan(settled);
    // A choice has no "already done", so the surface step outlives every
    // repair — and nothing else survives a settled machine.
    expect(plan.steps.map((s) => s.id)).toEqual(['surface', 'windowModel']);
    expect(plan.notes).toEqual([]);
    // Reported rather than dropped: "already installed" is the answer to "did
    // this command do anything".
    expect(plan.done).toContain('hooks');
    expect(plan.done).toContain('verbs');
    expect(plan.done).toContain('project');
    expect(plan.done).toContain('tmux');
    expect(plan.done).not.toContain('surface');
  });

  it('offers the first-launch five, in journey order', () => {
    expect(ids(fresh)).toEqual([
      'surface',
      'windowModel',
      'project',
      'import',
      'hooks',
      'verbs',
    ]);
  });

  it('keeps every step in the declared order', () => {
    const order = ids(
      world({
        tmuxMode: 'off',
        hooksInstalled: false,
        verbsInstalled: false,
        hasProjects: false,
        unlistedCount: 3,
        maxWorktrees: 4,
      }),
    );
    expect(order).toEqual([...RECOMMENDED_STEP_IDS]);
  });

  it('recommends everything it offers except the branch rows', () => {
    const plan = recommendedPlan(
      world({
        tmuxMode: 'off',
        hooksInstalled: false,
        verbsInstalled: false,
        hasProjects: false,
        unlistedCount: 3,
        maxWorktrees: 4,
      }),
    );
    const unticked = plan.steps.filter((s) => !s.recommended).map((s) => s.id);
    // Offered, never assumed: what the rows are worth depends on how the user
    // works, and what they cost is rows in their own sidebar.
    expect(unticked).toEqual(['worktrees']);
  });

  it('says nothing about hooks or verbs that are already installed', () => {
    expect(ids(world({ hooksInstalled: false }))).toEqual([
      'surface',
      'windowModel',
      'hooks',
    ]);
    expect(ids(world({ verbsInstalled: false }))).toEqual([
      'surface',
      'windowModel',
      'verbs',
    ]);
  });

  it('does not offer verbs to a wiring that has none', () => {
    const plan = recommendedPlan(
      world({ verbsInstalled: false, verbsAvailable: false }),
    );
    // Neither offered nor claimed as done: a step that cannot be run must not
    // appear on either list.
    expect(plan.steps.map((s) => s.id)).toEqual(['surface', 'windowModel']);
    expect(plan.done).not.toContain('verbs');
  });

  it('offers the import only when something is unlisted, and counts it', () => {
    expect(ids(world({ unlistedCount: 0 }))).toEqual(['surface', 'windowModel']);
    const step = recommendedPlan(world({ unlistedCount: 12 })).steps.find(
      (s) => s.id === 'import',
    );
    expect(step).toBeDefined();
    expect(step?.title).toContain('12');
  });

  it('offers a first project only to somebody who has none', () => {
    expect(ids(world({ hasProjects: false }))).toEqual([
      'surface',
      'windowModel',
      'project',
    ]);
    expect(ids(world({ hasProjects: true }))).toEqual(['surface', 'windowModel']);
  });
});

describe('recommendedPlan: tmux', () => {
  it('offers the switch back on when tmux is there and turned off', () => {
    const plan = recommendedPlan(world({ tmuxMode: 'off' }));
    expect(plan.steps.map((s) => s.id)).toEqual(['tmux', 'surface', 'windowModel']);
    expect(plan.steps[0]?.settings).toEqual([{ key: 'tmux', value: 'auto' }]);
    expect(plan.notes).toEqual([]);
  });

  it('says so as a NOTE when tmux is not installed — it cannot install it', () => {
    const plan = recommendedPlan(world({ tmuxBinary: null }));
    expect(plan.steps.map((s) => s.id)).toEqual(['surface', 'windowModel']);
    expect(plan.notes).toHaveLength(1);
    expect(plan.notes[0]).toContain('brew install tmux');
  });

  it('offers a linux install line, and none where it does not know one', () => {
    expect(recommendedPlan(world({ platform: 'linux', tmuxBinary: null })).notes[0]).toContain(
      'apt install tmux',
    );
    const unknown = recommendedPlan(
      world({ platform: 'sunos', tmuxBinary: null }),
    ).notes[0];
    expect(unknown).toContain('tmux is not installed');
    expect(unknown).not.toContain('install it with');
  });

  it('says nothing at all on Windows, which has no detach tier to offer', () => {
    const plan = recommendedPlan(
      world({ platform: 'win32', tmuxBinary: null, tmuxMode: 'off' }),
    );
    expect(plan.steps.map((s) => s.id)).toEqual(['surface', 'windowModel']);
    expect(plan.notes).toEqual([]);
    expect(plan.done).not.toContain('tmux');
  });
});

describe('recommendedPlan: the branch rows', () => {
  it('offers them only when a repository actually has two checkouts', () => {
    expect(ids(world({ maxWorktrees: 1 }))).toEqual(['surface', 'windowModel']);
    expect(ids(world({ maxWorktrees: 2 }))).toEqual([
      'surface',
      'windowModel',
      'worktrees',
    ]);
  });

  it('does not offer them to somebody who already has them', () => {
    const plan = recommendedPlan(
      world({ maxWorktrees: 4, branchRowsEnabled: true }),
    );
    expect(plan.steps.map((s) => s.id)).toEqual(['surface', 'windowModel']);
    expect(plan.done).toContain('worktrees');
  });

  it('writes git.branches ALONE — never the network one, never the previews', () => {
    const step = recommendedPlan(world({ maxWorktrees: 2 })).steps.find(
      (s) => s.id === 'worktrees',
    );
    expect(step?.settings).toEqual([{ key: 'git.branches', value: true }]);
  });
});

describe('recommendedPlan: what it may never touch', () => {
  // The clean slate, the previews and the taste settings. Asserted over EVERY
  // world that offers everything at once, so a step added later that quietly
  // reaches for one of these fails here rather than in somebody's sidebar.
  it('never writes a setting from the policy or preview groups', () => {
    const everything = recommendedPlan(
      world({
        tmuxMode: 'off',
        hooksInstalled: false,
        verbsInstalled: false,
        hasProjects: false,
        unlistedCount: 5,
        maxWorktrees: 9,
      }),
    );
    const keys = everything.steps.flatMap((s) => s.settings.map((x) => x.key));
    for (const forbidden of [
      'showForeignSessions',
      'showArchived',
      'showPhantomRows',
      'onlyProjectSessions',
      'preview.directoryModel',
      'git.pullRequests',
      'soloSession',
      'showTokens',
      'notifications.popup',
      'accounts.offerSwitchAtLimit',
    ]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  it('gives every step a reason, a cost and a way back', () => {
    const everything = recommendedPlan(
      world({
        tmuxMode: 'off',
        hooksInstalled: false,
        verbsInstalled: false,
        hasProjects: false,
        unlistedCount: 5,
        maxWorktrees: 9,
      }),
    );
    expect(everything.steps).toHaveLength(RECOMMENDED_STEP_IDS.length);
    for (const step of everything.steps) {
      expect(step.why.length, step.id).toBeGreaterThan(40);
      expect(step.writes.length, step.id).toBeGreaterThan(0);
      expect(step.undo.length, step.id).toBeGreaterThan(0);
      // A step that neither writes a setting nor is one of the five the flow
      // knows how to run would silently do nothing when ticked.
      const imperative: RecommendedStepId[] = [
        'hooks',
        'verbs',
        'project',
        'import',
        'surface',
        'windowModel',
      ];
      expect(
        step.settings.length > 0 || imperative.includes(step.id),
        step.id,
      ).toBe(true);
    }
  });
});

describe('surfaceChoices: where sessions open', () => {
  const currentOf = (w: RecommendedWorld): SurfaceChoiceId | undefined =>
    surfaceChoices(w).find((c) => c.current)?.id;

  it('is asked, never pre-answered: the surface STEP carries no settings', () => {
    // The taxonomy's whole point for TASTE: the checklist tick opens the
    // question, and only an option chosen in the picker writes anything.
    const step = recommendedPlan(settled).steps.find((s) => s.id === 'surface');
    expect(step).toBeDefined();
    expect(step?.settings).toEqual([]);
    expect(step?.recommended).toBe(true);
  });

  it('offers exactly the four places, in a stable order', () => {
    expect(surfaceChoices(settled).map((c) => c.id)).toEqual([
      'pinnedTab',
      'editorTabs',
      'claudeExtension',
      'panel',
    ]);
  });

  it('marks the default world as editor tabs', () => {
    expect(currentOf(settled)).toBe('editorTabs');
  });

  it('marks the pinned tab for editor + solo', () => {
    expect(currentOf(world({ soloSession: true }))).toBe('pinnedTab');
  });

  it('marks the panel, solo or not — the pin is an editor-tab arrangement', () => {
    expect(currentOf(world({ terminalLocation: 'panel' }))).toBe('panel');
    expect(
      currentOf(world({ terminalLocation: 'panel', soloSession: true })),
    ).toBe('panel');
  });

  it('marks the extension only when the mode actually RESOLVES there', () => {
    expect(
      currentOf(
        world({ launchMode: 'claudeExtension', claudeExtensionInstalled: true }),
      ),
    ).toBe('claudeExtension');
    // Configured but not installed: every launch falls back to Flock's own
    // terminal, so calling the extension "current" would mark a place no
    // session actually opens in.
    expect(
      currentOf(
        world({ launchMode: 'claudeExtension', claudeExtensionInstalled: false }),
      ),
    ).toBe('editorTabs');
  });

  it('marks nothing current in a new-window world — a fifth place is not these four', () => {
    expect(currentOf(world({ terminalLocation: 'newWindow' }))).toBeUndefined();
  });

  it('keeps the extension on offer when it is missing, and says so', () => {
    const option = surfaceChoices(settled).find(
      (c) => c.id === 'claudeExtension',
    );
    expect(option?.description).toContain('not installed');
    const installed = surfaceChoices(
      world({ claudeExtensionInstalled: true }),
    ).find((c) => c.id === 'claudeExtension');
    expect(installed?.description).not.toContain('not installed');
  });

  it('moves the mode with every Flock-side option, and ONLY the mode with the extension', () => {
    const byId = new Map(surfaceChoices(settled).map((c) => [c.id, c]));
    // Picked from extension mode, a Flock-side option must actually move you —
    // so all three write launch.mode back to flock alongside their arrangement.
    expect(byId.get('pinnedTab')?.settings).toEqual([
      { key: 'terminalLocation', value: 'editor' },
      { key: 'soloSession', value: true },
      { key: 'launch.mode', value: 'flock' },
    ]);
    expect(byId.get('editorTabs')?.settings).toEqual([
      { key: 'terminalLocation', value: 'editor' },
      { key: 'soloSession', value: false },
      { key: 'launch.mode', value: 'flock' },
    ]);
    expect(byId.get('panel')?.settings).toEqual([
      { key: 'terminalLocation', value: 'panel' },
      { key: 'soloSession', value: false },
      { key: 'launch.mode', value: 'flock' },
    ]);
    // The extension option leaves the Flock-side arrangement where it was, for
    // whenever the person comes back.
    expect(byId.get('claudeExtension')?.settings).toEqual([
      { key: 'launch.mode', value: 'claudeExtension' },
    ]);
  });
});

describe('windowModelChoices: what a window is', () => {
  const currentOf = (w: RecommendedWorld): WindowModelId | undefined =>
    windowModelChoices(w).find((c) => c.current)?.id;

  it('is asked, never pre-answered: the windowModel STEP carries no settings', () => {
    // Same contract as `surface`, for the same reason — the tick opens the
    // question and only an option chosen in the picker writes anything.
    const step = recommendedPlan(settled).steps.find(
      (s) => s.id === 'windowModel',
    );
    expect(step).toBeDefined();
    expect(step?.settings).toEqual([]);
    expect(step?.recommended).toBe(true);
    // A choice has no "already done": it must never appear as settled, however
    // deliberately the person answered it last time.
    expect(recommendedPlan(settled).done).not.toContain('windowModel');
  });

  it('always names exactly one current model, and names it in words', () => {
    // What the GEAR MENU shows. Its entry previews the current model by
    // reading this list's `current` label — "Currently “Auto-switch”" — rather
    // than mapping `lineage.mode` to a wording of its own, so that the
    // sentence in the menu and the "(current)" mark in the picker one click
    // later cannot say different things. Two properties hold that up: exactly
    // one choice is ever current (so the preview is never blank or ambiguous),
    // and its label is human wording rather than the stored enum value.
    const worlds: RecommendedWorld[] = [
      settled,
      { ...settled, mode: 'folder' },
      { ...settled, mode: 'root' },
      { ...settled, mode: 'project' },
      // The legacy pair, which a raw `lineage.mode` read would get wrong: no
      // mode set, workspaces off, is the folder window — and the gear must not
      // report the enum's default at somebody it does not describe.
      { ...settled, mode: undefined, workspacesEnabled: false },
      // And a hand-edited typo, which resolveMode folds to the default.
      { ...settled, mode: 'PROJECT ' },
    ];
    for (const w of worlds) {
      const current = windowModelChoices(w).filter((c) => c.current);
      expect(current, JSON.stringify({ mode: w.mode })).toHaveLength(1);
      const label = current[0].label;
      expect(label).not.toBe('');
      // Never the raw setting value: those are 'folder' / 'root' / 'project',
      // and a menu that says "Currently “project”" has leaked its storage.
      expect(['folder', 'root', 'project']).not.toContain(label);
    }
  });

  it('offers exactly the three models, in ladder order', () => {
    // Most contained to most following, so the list itself teaches the
    // progression rather than making the reader assemble it.
    expect(windowModelChoices(settled).map((c) => c.id)).toEqual([
      'folder',
      'root',
      'project',
    ]);
  });

  it('marks an unset mode as one folder per project — the shipped default', () => {
    expect(currentOf(settled)).toBe('folder');
  });

  it('marks the auto-switch user as auto-switch', () => {
    expect(currentOf(world({ mode: 'project', workspacesEnabled: true }))).toBe(
      'project',
    );
  });

  it('marks the OLD (project, workspaces off) pair as Flock only', () => {
    // The picker agrees with `resolveMode`, which is the whole reason `current`
    // is resolved rather than read. Showing this person "Auto-switch (current)"
    // would name a model their window has never actually been in — and this is
    // the one person in the product most in need of a straight answer.
    expect(currentOf(world({ mode: 'project', workspacesEnabled: false }))).toBe(
      'root',
    );
  });

  it('marks the retired (project, autoSwitch off) pair as Flock only too', () => {
    // The same fold for the key that used to switch the auto-switch off on its
    // own. A world that does not carry the key at all — every double that
    // predates it — reads as no opinion.
    expect(
      currentOf(world({ mode: 'project', workspacesAutoSwitch: false })),
    ).toBe('root');
    expect(
      currentOf(world({ mode: 'project', workspacesAutoSwitch: true })),
    ).toBe('project');
  });

  it('always marks exactly one, garbage included', () => {
    for (const w of [
      settled,
      world({ mode: 'root' }),
      world({ mode: 'Project' }),
      world({ mode: 'workflow', workspacesEnabled: false }),
    ]) {
      expect(windowModelChoices(w).filter((c) => c.current)).toHaveLength(1);
    }
  });

  it('writes the mode alone, except auto-switch, which untangles the old pair', () => {
    const byId = new Map(windowModelChoices(settled).map((c) => [c.id, c]));
    expect(byId.get('folder')?.settings).toEqual([
      { key: 'mode', value: 'folder' },
    ]);
    expect(byId.get('root')?.settings).toEqual([
      { key: 'mode', value: 'root' },
    ]);
    // Without the second write, somebody carrying `workspaces.enabled: false`
    // would pick Auto-switch, watch resolveMode fold them straight back to
    // Flock only, and have nothing on screen to explain it. The third entry
    // is the same repair for the retired `workspaces.autoSwitch`, whose
    // `false` folds identically — DELETED rather than set, since the manifest
    // no longer declares it. These are the only places either old key is ever
    // touched — by the user's own choice, which is the only way this extension
    // touches a settings file.
    expect(byId.get('project')?.settings).toEqual([
      { key: 'mode', value: 'project' },
      { key: 'workspaces.enabled', value: true },
      { key: 'workspaces.autoSwitch', value: undefined },
    ]);
  });

  it('writes only keys the manifest contributes, and only deletes retired ones', () => {
    // The same guard `writeSettings` applies at the wiring (it refuses a key
    // the extension does not declare, except to remove a retired one),
    // asserted here so a typo fails as a test rather than as a silent no-op
    // inside the picker.
    const contributed = new Set<string>(Object.values(CONFIG_KEYS));
    const retired = new Set<string>(Object.values(LEGACY_KEYS));
    for (const choice of windowModelChoices(settled)) {
      for (const setting of choice.settings) {
        if (retired.has(setting.key)) {
          expect(setting.value, `${setting.key} may only be deleted`).toBeUndefined();
        } else {
          expect(contributed, setting.key).toContain(setting.key);
        }
      }
    }
  });

  it('says what each model COSTS, not only what it gives', () => {
    // A picker that listed benefits alone would be selling rather than asking,
    // and each of these three is genuinely worse than the others at something.
    for (const choice of windowModelChoices(settled)) {
      expect(choice.description.toLowerCase(), choice.id).toContain('cost');
    }
  });
});

describe('recommendedNotice: the one-time offer', () => {
  it('offers on a first launch', () => {
    expect(recommendedNotice({ world: fresh, dismissed: false })).toBe('offer');
  });

  it('never speaks twice', () => {
    expect(recommendedNotice({ world: fresh, dismissed: true })).toBe('none');
  });

  it('stays quiet for anybody who has a project', () => {
    expect(
      recommendedNotice({ world: { ...fresh, hasProjects: true }, dismissed: false }),
    ).toBe('none');
  });

  it('stays quiet when the only thing left is the project itself', () => {
    // One recommended step besides the ever-present surface question, and the
    // empty view already says it with a button right there on screen. This is
    // the threshold that keeps the notice from firing for everybody who ever
    // closed their last project.
    const almost = world({
      hasProjects: false,
      hooksInstalled: true,
      verbsInstalled: true,
      unlistedCount: 0,
    });
    expect(recommendedPlan(almost).steps.map((s) => s.id)).toEqual([
      'surface',
      'windowModel',
      'project',
    ]);
    expect(recommendedNotice({ world: almost, dismissed: false })).toBe('none');
  });

  it('does not count the branch rows towards the threshold', () => {
    // They are offered unticked, so a person with two checkouts and one thing
    // to do is still a person with one thing to do.
    const almost = world({
      hasProjects: false,
      hooksInstalled: true,
      verbsInstalled: true,
      unlistedCount: 0,
      maxWorktrees: 6,
    });
    expect(recommendedPlan(almost).steps).toHaveLength(4);
    expect(recommendedNotice({ world: almost, dismissed: false })).toBe('none');
  });

  it('does not count the two taste questions either — they are on every plan', () => {
    // Counting a step that is always offered would lower the threshold to
    // "anybody with no projects", which is the exact firing-for-everybody the
    // threshold exists to stop. With TWO always-offered questions the
    // subtraction stopped being merely correct and became load-bearing: they
    // alone would meet a threshold of two.
    const nothingButChoices = world({ hasProjects: false });
    expect(
      recommendedPlan(nothingButChoices)
        .steps.filter((s) => s.recommended)
        .map((s) => s.id),
    ).toEqual(['surface', 'windowModel', 'project']);
    expect(
      recommendedNotice({ world: nothingButChoices, dismissed: false }),
    ).toBe('none');
  });
});
