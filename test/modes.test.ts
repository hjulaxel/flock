// test/modes.test.ts — the three window models' rules.
//
// src/modes.ts imports ./projects and ./types only, so none of this needs the
// vscode mock. What is under test is the DECISIONS: how the setting parses, how
// the legacy `workspaces.enabled` pair folds into the third value, which gate
// hides which machinery, when a session counts as another window's, and which
// window a foreign directory routes to.
//
// The `resolveMode` block below is the MIGRATION TABLE, spelled out case by
// case and deliberately mirroring the table in docs/settings.md: the promise of
// this change is that nobody is moved, and a promise like that is only worth
// the enumeration that proves it.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MODE,
  explorerFollowOn,
  folderScoped,
  followsTheSession,
  launchableProjects,
  normalizeMode,
  openTargetFor,
  outsideScope,
  projectSwitchingOn,
  resolveMode,
  windowCovers,
  windowForDir,
} from '../src/modes';
import type { ProjectMatch } from '../src/projects';
import type { ProjectRecord, WindowRecord } from '../src/types';

// ------------------------------------------------------------------ helpers

function win(over: Partial<WindowRecord> = {}): WindowRecord {
  return {
    windowId: 'w1',
    focusHandle: { uri: 'vscode://x/focus?windowId=w1' },
    pid: 1234,
    publishedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function match(dir: string): ProjectMatch {
  const project: ProjectRecord = {
    id: 'p1',
    name: 'App',
    rootDir: dir,
    dirs: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  return { project, dir, depth: dir.length, own: true };
}

// ---------------------------------------------------------------- the mode

describe('normalizeMode', () => {
  it('reads each of the three level names unchanged', () => {
    expect(normalizeMode('folder')).toBe('folder');
    expect(normalizeMode('root')).toBe('root');
    expect(normalizeMode('project')).toBe('project');
  });

  it('folds garbage, typos and absence into the default', () => {
    // The safe direction, and now with two ways to be unsafe: a wrong `folder`
    // hides a verb, a wrong `project` lets a switch rearrange a window the user
    // thinks of as a plain folder, and a wrong `root` drops the fence off a
    // window somebody opened on a folder on purpose.
    expect(normalizeMode(undefined)).toBe(DEFAULT_MODE);
    expect(normalizeMode('Project')).toBe(DEFAULT_MODE);
    expect(normalizeMode('Flock')).toBe(DEFAULT_MODE);
    expect(normalizeMode('workflow')).toBe(DEFAULT_MODE);
    expect(normalizeMode(42)).toBe(DEFAULT_MODE);
    expect(DEFAULT_MODE).toBe('folder');
  });
});

describe('resolveMode: the migration table', () => {
  it('leaves an unset or folder-mode window exactly where it was', () => {
    // `workspaces.enabled` never meant anything to a window that was not in
    // project mode, and it still does not.
    expect(resolveMode(undefined, true)).toBe('folder');
    expect(resolveMode(undefined, false)).toBe('folder');
    expect(resolveMode('folder', true)).toBe('folder');
    expect(resolveMode('folder', false)).toBe('folder');
  });

  it('leaves the auto-switch user on auto-switch', () => {
    // Axel's own machine: `lineage.mode: "project"` and no `workspaces.enabled`
    // key at all, so the boolean arrives as its `true` default. Zero delta.
    expect(resolveMode('project', true)).toBe('project');
  });

  it('folds the old (project, workspaces off) pair to the Flock-only model', () => {
    // The whole point. That pair ALREADY behaved this way — no auto-switch, no
    // status-bar button, no fence, switch verb still available — so giving it a
    // name moves nobody. Honouring the mode alone instead would switch
    // auto-switching back on for the one population that turned it off by hand.
    expect(resolveMode('project', false)).toBe('root');
  });

  it('never demotes on anything but a literal false', () => {
    // An older wiring or a unit double handing in `undefined` means "no
    // opinion", and an absent opinion must not cost somebody their level.
    expect(
      resolveMode('project', undefined as unknown as boolean),
    ).toBe('project');
  });

  it('leaves an explicit flock window alone whatever the old key says', () => {
    expect(resolveMode('root', true)).toBe('root');
    expect(resolveMode('root', false)).toBe('root');
  });

  it('folds garbage to the default before the pair is even consulted', () => {
    expect(resolveMode('Project', false)).toBe('folder');
    expect(resolveMode(42, false)).toBe('folder');
  });

  it('folds the retired (project, autoSwitch off) pair to Flock-only the same way', () => {
    // `workspaces.autoSwitch: false` was a third spelling of the Root window:
    // auto-switch with the auto taken out, the switch verb still there, and a
    // status-bar item that model is defined by not having. Honouring the mode
    // alone would switch auto-switching back on for exactly the people who
    // turned it off by hand.
    expect(resolveMode('project', true, false)).toBe('root');
    // Either old key alone is enough; both together say the same thing.
    expect(resolveMode('project', false, true)).toBe('root');
    expect(resolveMode('project', false, false)).toBe('root');
  });

  it('leaves the auto-switch user alone when the retired key is absent or true', () => {
    // The third argument is optional and the callers that predate it hand in
    // nothing — "no opinion", never a demotion.
    expect(resolveMode('project', true)).toBe('project');
    expect(resolveMode('project', true, undefined)).toBe('project');
    expect(resolveMode('project', true, true)).toBe('project');
  });

  it('never lets the retired key move a window that is not in project mode', () => {
    expect(resolveMode('folder', true, false)).toBe('folder');
    expect(resolveMode('root', true, false)).toBe('root');
    expect(resolveMode(undefined, true, false)).toBe('folder');
  });
});

describe('the four gates', () => {
  it('projectSwitchingOn is true only where the window switches BY ITSELF', () => {
    // Auto-switch alone. The Flock-only window keeps the switch verb — it just
    // never fires it for you and never draws the status-bar button.
    expect(projectSwitchingOn('project')).toBe(true);
    expect(projectSwitchingOn('root')).toBe(false);
    expect(projectSwitchingOn('folder')).toBe(false);
  });

  it('folderScoped is true only where a folder fences the window', () => {
    // The scope fence and the launch fence are one fact, and it is `folder`:
    // the Flock-only model shows everything on purpose, and auto-switch cannot
    // fence because its roots change on every focus change.
    expect(folderScoped('folder')).toBe(true);
    expect(folderScoped('root')).toBe(false);
    expect(folderScoped('project')).toBe(false);
  });

  it('followsTheSession is true only in auto-switch, and adds NO enum value', () => {
    // The first draft of the follow work proposed a fourth `lineage.mode`
    // value for this. It was rejected: two values both meaning "the window
    // follows something" is the truth table the three-model consolidation
    // exists to remove. Following the session is what auto-switch MEANS.
    expect(followsTheSession('project')).toBe(true);
    expect(followsTheSession('root')).toBe(false);
    expect(followsTheSession('folder')).toBe(false);
  });

  it('explorerFollowOn is the model AND the user\'s own setting', () => {
    // Turning the file-tree follow off leaves you in the auto-switch model —
    // tabs still switch, the line still says where you are, Source Control
    // still follows the checkout. It is not a way to say "different model".
    expect(explorerFollowOn('project', true)).toBe(true);
    expect(explorerFollowOn('project', false)).toBe(false);
    expect(explorerFollowOn('root', true)).toBe(false);
    expect(explorerFollowOn('folder', true)).toBe(false);
  });
});

// ---------------------------------------------------------------- the fence

describe('outsideScope', () => {
  it('is true only for a KNOWN cwd outside the fence', () => {
    expect(outsideScope(['/code/app'], '/code/other')).toBe(true);
    expect(outsideScope(['/code/app'], '/code/app/src')).toBe(false);
    expect(outsideScope(['/code/app'], '/code/app')).toBe(false);
  });

  it('respects path boundaries — /code/app-x is not inside /code/app', () => {
    expect(outsideScope(['/code/app'], '/code/app-feat-x')).toBe(true);
  });

  it('is a UNION over every opened folder — inside ANY of them is in scope', () => {
    // The multi-root case the fence exists for: a converted explorer-follow
    // window (or a plain multi-root workspace) opened all of these, so a
    // session under the second folder is exactly as much this window's as one
    // under the first.
    expect(outsideScope(['/code/app', '/code/lib'], '/code/lib/src')).toBe(
      false,
    );
    expect(outsideScope(['/code/app', '/code/lib'], '/code/app')).toBe(false);
    expect(outsideScope(['/code/app', '/code/lib'], '/code/other')).toBe(true);
  });

  it('skips junk entries rather than fencing on them', () => {
    expect(outsideScope(['', '/code/app'], '/code/app/src')).toBe(false);
    // Only junk left = no fence at all.
    expect(outsideScope([''], '/code/other')).toBe(false);
  });

  it('never withholds on the strength of not knowing', () => {
    // No fence (project mode, an empty window) and no cwd both read as "not
    // proven foreign": only a POSITIVE elsewhere ever withholds a verb.
    expect(outsideScope(undefined, '/code/other')).toBe(false);
    expect(outsideScope([], '/code/other')).toBe(false);
    expect(outsideScope(['/code/app'], undefined)).toBe(false);
    expect(outsideScope(['/code/app'], '')).toBe(false);
  });
});

// --------------------------------------------------------- the self-check

describe('windowCovers', () => {
  // The mirror image of outsideScope, and the pair have to be read together:
  // one withholds a verb only on a POSITIVE elsewhere, the other suppresses a
  // new window only on a POSITIVE here. Getting the asymmetry backwards is
  // silent both ways — a verb that refuses everything, or one that opens a
  // second window on the folder you are already in.
  it('is true when any real folder of this window contains the target', () => {
    expect(windowCovers(['/code/app'], '/code/app')).toBe(true);
    expect(windowCovers(['/code/app'], '/code/app/src')).toBe(true);
    // Multi-root: the second root counts exactly as much as the first, which is
    // what makes a converted explorer-follow window (anchor at folder[0]) or an
    // ordinary multi-root workspace answer correctly.
    expect(windowCovers(['/code/app', '/code/lib'], '/code/lib/pkg')).toBe(
      true,
    );
  });

  it('is false for a sibling directory, prefixes included', () => {
    expect(windowCovers(['/code/app'], '/code/other')).toBe(false);
    // `/code/app-feat-x` is a worktree of the same repository and not a child
    // of the checkout — the case the verb exists for, so the string-prefix bug
    // here would be the one that hurts most.
    expect(windowCovers(['/code/app'], '/code/app-feat-x')).toBe(false);
  });

  it('claims nothing on the strength of knowing nothing', () => {
    // THE ASYMMETRY. `!outsideScope(undefined, dir)` is TRUE — no fence means
    // nothing is proven foreign — and a self-check written that way would make
    // the verb silently do nothing in every model but `folder`, which is
    // precisely the two models it was written for. An unknown target and a
    // window with no folders are both "no claim".
    expect(windowCovers(undefined, '/code/app')).toBe(false);
    expect(windowCovers([], '/code/app')).toBe(false);
    expect(outsideScope(undefined, '/code/app')).toBe(false);
    expect(windowCovers([''], '/code/app')).toBe(false);
    expect(windowCovers(['/code/app'], undefined)).toBe(false);
    expect(windowCovers(['/code/app'], '')).toBe(false);
  });

  it('ignores junk roots without losing the real ones', () => {
    expect(windowCovers(['', '/code/app'], '/code/app/src')).toBe(true);
  });
});

// -------------------------------------------------------------- the routing

describe('windowForDir', () => {
  const shallow = win({ windowId: 'shallow', folder: '/code' });
  const deep = win({ windowId: 'deep', folder: '/code/app' });
  const bare = win({ windowId: 'bare' }); // no folder: an empty window

  it('picks the window whose folder contains the directory', () => {
    expect(windowForDir([shallow], '/code/app/src')?.windowId).toBe('shallow');
    expect(windowForDir([shallow], '/elsewhere')).toBeUndefined();
  });

  it('prefers the deepest covering folder, whatever the order', () => {
    expect(windowForDir([shallow, deep], '/code/app/src')?.windowId).toBe('deep');
    expect(windowForDir([deep, shallow], '/code/app/src')?.windowId).toBe('deep');
    // A path only the shallow window covers still routes there.
    expect(windowForDir([deep, shallow], '/code/web')?.windowId).toBe('shallow');
  });

  it('breaks a same-folder tie on the freshest publication', () => {
    const older = win({
      windowId: 'older',
      folder: '/code',
      publishedAt: '2026-08-01T00:00:00.000Z',
    });
    const newer = win({
      windowId: 'newer',
      folder: '/code',
      publishedAt: '2026-08-20T00:00:00.000Z',
    });
    expect(windowForDir([older, newer], '/code/x')?.windowId).toBe('newer');
    expect(windowForDir([newer, older], '/code/x')?.windowId).toBe('newer');
  });

  it('skips windows with no folder, and answers nothing for no dir', () => {
    expect(windowForDir([bare], '/code/app')).toBeUndefined();
    expect(windowForDir([shallow], undefined)).toBeUndefined();
    expect(windowForDir([shallow], '')).toBeUndefined();
    expect(windowForDir([], '/code')).toBeUndefined();
  });

  it('routes on EVERY published folder of a multi-root window', () => {
    // The converted explorer-follow window: `folders` carries all its real
    // roots (the anchor already excluded by the publisher), and work under
    // any of them belongs to it — folder[0]-only routing was the bug that
    // made converted windows unreachable.
    const multi = win({
      windowId: 'multi',
      folder: '/code/app',
      folders: ['/code/app', '/code/lib'],
    });
    expect(windowForDir([multi], '/code/lib/src')?.windowId).toBe('multi');
    expect(windowForDir([multi], '/code/app/src')?.windowId).toBe('multi');
    expect(windowForDir([multi], '/code/other')).toBeUndefined();
  });

  it('a multi-root window competes with its DEEPEST containing folder', () => {
    const multi = win({
      windowId: 'multi',
      folder: '/code',
      folders: ['/code', '/code/app/inner'],
    });
    // multi's second root is deeper than deep's only one.
    expect(
      windowForDir([deep, multi], '/code/app/inner/src')?.windowId,
    ).toBe('multi');
    // ...but for a path only its shallow root covers, deep still wins.
    expect(windowForDir([deep, multi], '/code/app/src')?.windowId).toBe(
      'deep',
    );
  });
});

describe('openTargetFor', () => {
  it('prefers the owning project claim over the bare cwd', () => {
    // Opening the claim shows the whole project's rows; opening the cwd's
    // deep subdirectory shows almost none of them.
    expect(openTargetFor([match('/code/api')], '/code/api/src/x')).toBe(
      '/code/api',
    );
  });

  it('falls back to the cwd when nothing claims it', () => {
    expect(openTargetFor([], '/code/loose/dir')).toBe('/code/loose/dir');
    expect(openTargetFor([], undefined)).toBe('');
  });
});

describe('launchableProjects', () => {
  interface P {
    id: string;
    dirs: readonly string[];
  }
  const dirsOf = (p: P): readonly string[] => p.dirs;
  const app: P = { id: 'app', dirs: ['/code/app'] };
  const other: P = { id: 'other', dirs: ['/code/other'] };
  // A project spanning both: one in-scope directory is enough to launch in.
  const spanning: P = { id: 'span', dirs: ['/code/other', '/code/app/pkg'] };

  it('keeps only projects with a directory inside the scope', () => {
    expect(
      launchableProjects(['/code/app'], [app, other, spanning], dirsOf).map(
        (p) => p.id,
      ),
    ).toEqual(['app', 'span']);
  });

  it('passes everything through with no scope — project mode, empty window', () => {
    const all = [app, other];
    expect(launchableProjects(undefined, all, dirsOf)).toBe(all);
    expect(launchableProjects([], all, dirsOf)).toBe(all);
  });

  it('passes everything through when the scope matches NOTHING', () => {
    // An empty picker tells the user less than a full one: this window's
    // folder simply has no project on it yet. Filtering is a courtesy; the
    // launch fence is the rule, and it still refuses whatever gets picked.
    const all = [app, other];
    expect(launchableProjects(['/somewhere/else'], all, dirsOf)).toBe(all);
  });

  it('keeps a project whose directories it cannot place', () => {
    // outsideScope's asymmetry again: only a POSITIVE elsewhere excludes, so a
    // project with an empty or unknown directory list stays offerable.
    const vague: P = { id: 'vague', dirs: [''] };
    expect(
      launchableProjects(['/code/app'], [other, vague], dirsOf).map((p) => p.id),
    ).toEqual(['vague']);
  });
});
