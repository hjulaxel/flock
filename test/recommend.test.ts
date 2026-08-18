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
} from '../src/recommend';
import type { RecommendedStepId } from '../src/recommend';
import type { RecommendedWorld } from '../src/types';

/** A machine on which nothing is left to do: tmux installed and on, a project,
 *  no unlisted history, both installs done, one checkout per repository. Each
 *  test moves exactly the fields it is about. */
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
  it('offers nothing on a machine where everything is already true', () => {
    const plan = recommendedPlan(settled);
    expect(plan.steps).toEqual([]);
    expect(plan.notes).toEqual([]);
    // Reported rather than dropped: "already installed" is the answer to "did
    // this command do anything".
    expect(plan.done).toContain('hooks');
    expect(plan.done).toContain('verbs');
    expect(plan.done).toContain('project');
    expect(plan.done).toContain('tmux');
  });

  it('offers the first-launch four, in journey order', () => {
    expect(ids(fresh)).toEqual(['project', 'import', 'hooks', 'verbs']);
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
    expect(ids(world({ hooksInstalled: false }))).toEqual(['hooks']);
    expect(ids(world({ verbsInstalled: false }))).toEqual(['verbs']);
  });

  it('does not offer verbs to a wiring that has none', () => {
    const plan = recommendedPlan(
      world({ verbsInstalled: false, verbsAvailable: false }),
    );
    // Neither offered nor claimed as done: a step that cannot be run must not
    // appear on either list.
    expect(plan.steps).toEqual([]);
    expect(plan.done).not.toContain('verbs');
  });

  it('offers the import only when something is unlisted, and counts it', () => {
    expect(ids(world({ unlistedCount: 0 }))).toEqual([]);
    const step = recommendedPlan(world({ unlistedCount: 12 })).steps[0];
    expect(step?.id).toBe('import');
    expect(step?.title).toContain('12');
  });

  it('offers a first project only to somebody who has none', () => {
    expect(ids(world({ hasProjects: false }))).toEqual(['project']);
    expect(ids(world({ hasProjects: true }))).toEqual([]);
  });
});

describe('recommendedPlan: tmux', () => {
  it('offers the switch back on when tmux is there and turned off', () => {
    const plan = recommendedPlan(world({ tmuxMode: 'off' }));
    expect(plan.steps.map((s) => s.id)).toEqual(['tmux']);
    expect(plan.steps[0]?.settings).toEqual([{ key: 'tmux', value: 'auto' }]);
    expect(plan.notes).toEqual([]);
  });

  it('says so as a NOTE when tmux is not installed — it cannot install it', () => {
    const plan = recommendedPlan(world({ tmuxBinary: null }));
    expect(plan.steps).toEqual([]);
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
    expect(plan.steps).toEqual([]);
    expect(plan.notes).toEqual([]);
    expect(plan.done).not.toContain('tmux');
  });
});

describe('recommendedPlan: the branch rows', () => {
  it('offers them only when a repository actually has two checkouts', () => {
    expect(ids(world({ maxWorktrees: 1 }))).toEqual([]);
    expect(ids(world({ maxWorktrees: 2 }))).toEqual(['worktrees']);
  });

  it('does not offer them to somebody who already has them', () => {
    const plan = recommendedPlan(
      world({ maxWorktrees: 4, branchRowsEnabled: true }),
    );
    expect(plan.steps).toEqual([]);
    expect(plan.done).toContain('worktrees');
  });

  it('writes git.branches ALONE — never the network one, never the previews', () => {
    const step = recommendedPlan(world({ maxWorktrees: 2 })).steps[0];
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
      'preview.demoProject',
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
      // A step that neither writes a setting nor is one of the four the flow
      // knows how to run would silently do nothing when ticked.
      const imperative: RecommendedStepId[] = [
        'hooks',
        'verbs',
        'project',
        'import',
      ];
      expect(
        step.settings.length > 0 || imperative.includes(step.id),
        step.id,
      ).toBe(true);
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
    // One recommended step, and the empty view already says it with a button
    // right there on screen. This is the threshold that keeps the notice from
    // firing for everybody who ever closed their last project.
    const almost = world({
      hasProjects: false,
      hooksInstalled: true,
      verbsInstalled: true,
      unlistedCount: 0,
    });
    expect(recommendedPlan(almost).steps.map((s) => s.id)).toEqual(['project']);
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
    expect(recommendedPlan(almost).steps).toHaveLength(2);
    expect(recommendedNotice({ world: almost, dismissed: false })).toBe('none');
  });
});
