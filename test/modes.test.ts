// test/modes.test.ts — the folder/project mode rules.
//
// src/modes.ts imports ./projects and ./types only, so none of this needs the
// vscode mock. What is under test is the DECISIONS: how the setting parses,
// which gate hides the switching machinery, when a session counts as another
// window's, and which window a foreign directory routes to.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MODE,
  launchableProjects,
  normalizeMode,
  openTargetFor,
  outsideScope,
  projectSwitchingOn,
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
  it('reads only the literal "project" as project mode', () => {
    expect(normalizeMode('project')).toBe('project');
    expect(normalizeMode('folder')).toBe('folder');
  });

  it('folds garbage, typos and absence into the default', () => {
    // The safe direction: a wrong `folder` hides a verb, a wrong `project`
    // lets a switch rearrange a window the user thinks of as a plain folder.
    expect(normalizeMode(undefined)).toBe(DEFAULT_MODE);
    expect(normalizeMode('Project')).toBe(DEFAULT_MODE);
    expect(normalizeMode('workflow')).toBe(DEFAULT_MODE);
    expect(normalizeMode(42)).toBe(DEFAULT_MODE);
    expect(DEFAULT_MODE).toBe('folder');
  });
});

describe('projectSwitchingOn: the one gate', () => {
  it('requires BOTH the mode and the old enabled key', () => {
    expect(projectSwitchingOn('project', true)).toBe(true);
    expect(projectSwitchingOn('project', false)).toBe(false);
    // Folder mode turns switching off whatever the older key says.
    expect(projectSwitchingOn('folder', true)).toBe(false);
    expect(projectSwitchingOn('folder', false)).toBe(false);
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
