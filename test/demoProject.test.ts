// test/demoProject.test.ts — the fabricated project cannot touch anything real.
//
// `lineage.preview.demoProject` puts a project in the tree that does not exist.
// Its rows carry real-looking context objects, because that is what makes the
// menus draw at all — so what is tested here is the containment: that every id it
// mints is recognisable, that nothing on it can be mistaken for a session, and
// that the shape it draws is the one the layout is meant to be judged by.
//
// The refusal itself (every command bouncing off a demo row) is tested where the
// commands are — see test/commands.test.ts.

import { describe, expect, it } from 'vitest';

import {
  DEMO_MAX_COLOR_INDEX,
  DEMO_PREFIX,
  DEMO_PROJECT_ID,
  buildDemoProject,
  isDemoId,
} from '../src/demoProject';
import { BRANCH_COLOR_COUNT } from '../src/projects';
import { isSessionId } from '../src/types';

const NOW = 1_785_160_000_000;

describe('isDemoId', () => {
  it('recognises what the module mints', () => {
    expect(isDemoId(DEMO_PROJECT_ID)).toBe(true);
    expect(isDemoId(`${DEMO_PREFIX}anything`)).toBe(true);
  });

  it.each([
    ['a real uuid', '0f00000a-0000-4000-8000-00000000000a'],
    ['an empty string', ''],
    ['undefined', undefined],
    ['a number', 7],
    ['a name that merely contains the word', 'my-flock-demo:project'],
  ])('does not claim %s', (_what, value) => {
    expect(isDemoId(value)).toBe(false);
  });
});

describe('buildDemoProject', () => {
  const demo = buildDemoProject(NOW);

  it('is not a session id, so no id guard can resolve it', () => {
    // The belt to `isDemoId`'s braces: every path that parses an id rejects this
    // one on its shape alone, before anything checks the prefix.
    expect(isSessionId(DEMO_PROJECT_ID)).toBe(false);
  });

  it('draws two named lanes in one folder, then two plain directories', () => {
    const subs = demo.subprojects ?? [];
    expect(subs.map((s) => s.label)).toEqual([
      'Server rewrite',
      'CS tooling',
      'api',
      'notes',
    ]);
    expect(subs.map((s) => s.implicit)).toEqual([false, false, true, true]);
    // The row that proves the branch block belongs to the DIRECTORY: a directory
    // with no repository has no branches under it.
    expect(subs[3].branches).toEqual([]);
  });

  it('puts the two named lanes on the SAME directory', () => {
    // THE WHOLE POINT OF v7. Nothing on disk tells them apart — same path, same
    // repository, same branch list — so the name is the only thing that can, and a
    // session belongs to one because it was started there.
    const [first, second] = demo.subprojects ?? [];
    expect(first.dir).toBe(second.dir);
    expect(first.dirKey).toBe(second.dirKey);
    expect(first.id).not.toBe(second.id);
    expect((first.branches ?? []).map((b) => b.name)).toEqual(
      (second.branches ?? []).map((b) => b.name),
    );
  });

  it('gives every row an identity that is not its directory', () => {
    // Two lanes share a dirKey, so the row key, the collapse state and every
    // verb's target have to hang off `id` instead.
    const ids = (demo.subprojects ?? []).map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    // An implicit row's id is prefixed, so it can never collide with a uuid.
    const implicit = (demo.subprojects ?? []).filter((s) => s.implicit);
    expect(implicit.every((s) => s.id.startsWith('dir:'))).toBe(true);
  });

  it('marks no row as the project’s main directory', () => {
    // `main` is what Remove Subproject refuses, and it belongs to an implicit row
    // standing for the project's own address — the demo's `app` directory is
    // covered by named lanes, so nothing here claims it.
    expect((demo.subprojects ?? []).every((s) => s.main === false)).toBe(true);
  });

  it('keeps its branches on the directories, never on the project row', () => {
    // Exactly what a real split project does — see computeGrouping. A branch drawn
    // in both places is a branch you can start two sessions on by accident.
    expect(demo.branches).toEqual([]);
  });

  it('leads each repository with its own checkout, at colour 0', () => {
    for (const sub of (demo.subprojects ?? []).filter(
      (s) => (s.branches ?? []).length > 0,
    )) {
      const first = (sub.branches ?? [])[0];
      expect(first.shown).toBe(true);
      expect(first.colorIndex).toBe(0);
      expect(first.dir).not.toBe('');
    }
  });

  it('shows a checkout that is folded away, which is the policy worth looking at', () => {
    const app = (demo.subprojects ?? [])[0];
    const spike = (app.branches ?? []).find((b) => b.name === 'spike/tmux-detach');
    // A worktree with nothing running in it: a directory on disk, not work in
    // flight, so it sits in the fold.
    expect(spike?.dir).not.toBe('');
    expect(spike?.shown).toBe(false);
  });

  it('shows branches that are refs and nothing else', () => {
    const app = (demo.subprojects ?? [])[0];
    const refs = (app.branches ?? []).filter((b) => b.dir === '');
    expect(refs.length).toBeGreaterThan(2);
    expect(refs.every((b) => b.shown === false)).toBe(true);
  });

  it('has no sessions anywhere, because it cannot have any', () => {
    // A session row is drawn from the real forest, so a fabricated id would draw
    // nothing — and a branch claiming a count you cannot expand into is a control
    // that does not work. See the note in src/demoProject.ts.
    expect(demo.rootIds).toEqual([]);
    for (const sub of demo.subprojects ?? []) {
      expect(sub.rootIds).toEqual([]);
      for (const branch of sub.branches ?? []) {
        expect(branch.rootIds).toEqual([]);
      }
    }
  });

  it('never asks for a colour the palette does not define', () => {
    expect(DEMO_MAX_COLOR_INDEX).toBe(BRANCH_COLOR_COUNT - 1);
    for (const sub of demo.subprojects ?? []) {
      for (const branch of sub.branches ?? []) {
        expect(branch.colorIndex).toBeGreaterThanOrEqual(0);
        expect(branch.colorIndex).toBeLessThanOrEqual(DEMO_MAX_COLOR_INDEX);
      }
    }
  });

  it('says on the row itself that it is a demo', () => {
    // A fabricated project that looked like a real one would be a trap the first
    // time somebody forgot the switch was on.
    expect(demo.label).toContain('demo');
  });

  it('points at no directory that could exist on a real machine', () => {
    for (const dir of demo.dirs) expect(dir.startsWith('/flock-demo/')).toBe(true);
  });

  it('moves its ages with the clock', () => {
    // Otherwise the fold reads as frozen the day after this file was written.
    const later = buildDemoProject(NOW + 5 * 24 * 60 * 60 * 1000);
    const ageOf = (p: ReturnType<typeof buildDemoProject>): number =>
      (p.subprojects ?? [])[0].branches?.[0].lastCommitAt ?? 0;
    expect(ageOf(later)).toBeGreaterThan(ageOf(demo));
  });

  it('is rebuilt from a constant, so nothing can accumulate on it', () => {
    const again = buildDemoProject(NOW);
    expect(again).toEqual(demo);
    expect(again).not.toBe(demo);
  });

  it('every subproject names the demo project, and nothing else', () => {
    for (const sub of demo.subprojects ?? []) {
      expect(sub.projectId).toBe(DEMO_PROJECT_ID);
      expect(isDemoId(sub.projectId)).toBe(true);
    }
  });
});
