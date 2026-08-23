// test/projectview.test.ts — the project header inside the Explorer.
//
// The view has no state and no lazy loading: its whole behaviour is WHICH ROWS
// appear for a given window, in which order, and what each row does when
// clicked. That is exactly what is asserted here — the provider is instantiated
// directly, the way tree.test.ts does it, and registerProjectView (which needs
// a real workbench) is never called.

import { describe, expect, it } from 'vitest';

import { ProjectViewProvider, projectRows } from '../src/projectview';
import type { ProjectViewDeps, ProjectViewRow } from '../src/projectview';
import { COMMANDS } from '../src/types';
import type { ProjectRecord } from '../src/types';

function project(over: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'p1',
    name: 'Magma Web',
    rootDir: '/Users/x/code/web',
    dirs: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function deps(over: Partial<ProjectViewDeps> = {}): ProjectViewDeps {
  return {
    activeProject: () => project(),
    anchored: () => true,
    onDidChangeData: () => ({ dispose: () => {} }),
    ...over,
  };
}

/** The command a row fires when clicked, if any. */
function commandOf(provider: ProjectViewProvider, row: ProjectViewRow): string {
  const item = provider.getTreeItem(row) as {
    command?: { command: string };
  };
  return item.command?.command ?? '';
}

// ---------------------------------------------------------------- the rows

describe('projectview: rows', () => {
  it('offers the one-time setup when the window is not a Flock workspace', () => {
    expect(projectRows(project(), false)).toEqual([{ kind: 'setup' }]);
  });

  it('offers setup even with no project — the row is the only door into the feature', () => {
    expect(projectRows(undefined, false)).toEqual([{ kind: 'setup' }]);
  });

  it('says so when the window is anchored but scoped to no project', () => {
    expect(projectRows(undefined, true)).toEqual([{ kind: 'none' }]);
  });

  it('is the project followed by one row per connected directory, main first', () => {
    const p = project({ dirs: ['/Users/x/deploy'] });
    expect(projectRows(p, true)).toEqual([
      { kind: 'project', project: p },
      {
        kind: 'dir',
        path: '/Users/x/code/web',
        label: 'web',
        main: true,
        // No scope given means 'project' — every directory is a root down
        // there, so every row is current and none is singled out.
        current: true,
        showing: false,
      },
      {
        kind: 'dir',
        path: '/Users/x/deploy',
        label: 'deploy',
        main: false,
        current: true,
        showing: false,
      },
    ]);
  });

  it('marks exactly one directory as main, however many there are', () => {
    const rows = projectRows(
      project({ dirs: ['/Users/x/a', '/Users/x/b', '/Users/x/c'] }),
      true,
    );
    const dirs = rows.filter((r) => r.kind === 'dir');
    expect(dirs).toHaveLength(4);
    expect(dirs.filter((r) => r.kind === 'dir' && r.main)).toHaveLength(1);
  });

  // ---------------------------------------------------- 'directory' scope

  const dirRows = (
    p: ProjectRecord,
    opts: { scope?: 'directory' | 'project'; currentDir?: string },
  ): Array<{ path: string; current: boolean; showing: boolean }> =>
    projectRows(p, true, opts).flatMap((r) =>
      r.kind === 'dir'
        ? [{ path: r.path, current: r.current, showing: r.showing }]
        : [],
    );

  it('marks exactly one directory current under directory scope', () => {
    const rows = dirRows(project({ dirs: ['/Users/x/a', '/Users/x/b'] }), {
      scope: 'directory',
      currentDir: '/Users/x/b',
    });
    expect(rows.filter((r) => r.current).map((r) => r.path)).toEqual([
      '/Users/x/b',
    ]);
    expect(rows.filter((r) => r.showing).map((r) => r.path)).toEqual([
      '/Users/x/b',
    ]);
  });

  it('falls back to the main directory when the current one is unknown', () => {
    for (const currentDir of [undefined, '', '/somewhere/else']) {
      const rows = dirRows(project({ dirs: ['/Users/x/a'] }), {
        scope: 'directory',
        currentDir,
      });
      expect(rows.filter((r) => r.current).map((r) => r.path)).toEqual([
        '/Users/x/code/web',
      ]);
    }
  });

  it('does not say "showing" when there is only one directory to show', () => {
    // The mark exists to tell one row from the others. With a single directory
    // it would be labelling the only row it could possibly mean.
    const rows = dirRows(project(), { scope: 'directory' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.current).toBe(true);
    expect(rows[0]!.showing).toBe(false);
  });
});

// ------------------------------------------------------------- the provider

describe('projectview: the `here` row', () => {
  const HERE = { lane: 'ingest', branch: 'feat/x', detached: false };

  it('sits directly under the project, above the directories', () => {
    const rows = projectRows(project({ dirs: ['/Users/x/code/api'] }), true, {
      here: HERE,
    });
    expect(rows.map((r) => r.kind)).toEqual(['project', 'here', 'dir', 'dir']);
  });

  it('draws nothing when there is nothing to say', () => {
    // The common case: no lane, and a branch whereAmI decided was not worth
    // naming. A permanent row carrying no information is worse than no row.
    const rows = projectRows(project(), true, {
      here: { lane: '', branch: '', detached: false },
    });
    expect(rows.map((r) => r.kind)).toEqual(['project', 'dir']);
  });

  it('draws for a lane alone, and for a branch alone', () => {
    const laneOnly = projectRows(project(), true, {
      here: { lane: 'ingest', branch: '', detached: false },
    });
    expect(laneOnly.map((r) => r.kind)).toContain('here');
    const branchOnly = projectRows(project(), true, {
      here: { lane: '', branch: 'feat/x', detached: false },
    });
    expect(branchOnly.map((r) => r.kind)).toContain('here');
    const detachedOnly = projectRows(project(), true, {
      here: { lane: '', branch: '', detached: true },
    });
    expect(detachedOnly.map((r) => r.kind)).toContain('here');
  });

  it('is absent entirely for a wiring that does not supply one', () => {
    expect(projectRows(project(), true).map((r) => r.kind)).toEqual([
      'project',
      'dir',
    ]);
  });

  it('labels itself with the lane, and the branch as its description', () => {
    const provider = new ProjectViewProvider(deps({ here: () => HERE }));
    const row = provider
      .getChildren()
      .find((r) => r.kind === 'here') as ProjectViewRow;
    const item = provider.getTreeItem(row) as {
      label?: string;
      description?: string;
    };
    expect(item.label).toBe('ingest');
    expect(item.description).toBe('feat/x');
  });

  it('says detached rather than naming an empty branch', () => {
    const provider = new ProjectViewProvider(
      deps({ here: () => ({ lane: '', branch: '', detached: true }) }),
    );
    const row = provider
      .getChildren()
      .find((r) => r.kind === 'here') as ProjectViewRow;
    const item = provider.getTreeItem(row) as {
      label?: string;
      description?: string;
    };
    expect(item.label).toBe('You are here');
    expect(item.description).toBe('detached HEAD');
  });

  it('does not navigate — the place it names is where you already are', () => {
    const provider = new ProjectViewProvider(deps({ here: () => HERE }));
    const row = provider
      .getChildren()
      .find((r) => r.kind === 'here') as ProjectViewRow;
    // commandOf reports '' for a row with no command at all.
    expect(commandOf(provider, row)).toBe('');
  });

  it('survives a `here` dep that throws', () => {
    const provider = new ProjectViewProvider(
      deps({
        here: () => {
          throw new Error('nope');
        },
      }),
    );
    // The whole getChildren try/catch degrades to the setup row rather than
    // taking the Explorer down with it.
    expect(() => provider.getChildren()).not.toThrow();
  });
});

describe('projectview: provider', () => {
  it('is flat — no row has children', () => {
    const provider = new ProjectViewProvider(deps());
    for (const row of provider.getChildren()) {
      expect(provider.getChildren(row)).toEqual([]);
    }
  });

  it('labels the project row with the project name and counts its sessions', () => {
    const provider = new ProjectViewProvider(
      deps({ sessionCount: () => 3 }),
    );
    const item = provider.getTreeItem(provider.getChildren()[0]!);
    expect(item.label).toBe('Magma Web');
    expect(item.description).toBe('3 sessions');
  });

  it('singularises the session count', () => {
    const provider = new ProjectViewProvider(deps({ sessionCount: () => 1 }));
    expect(provider.getTreeItem(provider.getChildren()[0]!).description).toBe(
      '1 session',
    );
  });

  it('omits the count when the host cannot supply one', () => {
    const provider = new ProjectViewProvider(deps());
    expect(
      provider.getTreeItem(provider.getChildren()[0]!).description,
    ).toBeUndefined();
  });

  it('survives a sessionCount that throws', () => {
    const provider = new ProjectViewProvider(
      deps({
        sessionCount: () => {
          throw new Error('forest is mid-rebuild');
        },
      }),
    );
    expect(
      provider.getTreeItem(provider.getChildren()[0]!).description,
    ).toBeUndefined();
  });

  it('shows the directory basename, its full path as the tooltip, and marks the main one', () => {
    const provider = new ProjectViewProvider(
      deps({ activeProject: () => project({ dirs: ['/Users/x/deploy'] }) }),
    );
    const [, main, extra] = provider.getChildren();
    const mainItem = provider.getTreeItem(main!);
    expect(mainItem.label).toBe('web');
    expect(mainItem.description).toBe('main');
    expect(mainItem.tooltip).toBe('/Users/x/code/web');
    const extraItem = provider.getTreeItem(extra!);
    expect(extraItem.label).toBe('deploy');
    expect(extraItem.description).toBeUndefined();
  });

  it('says which directory the tree is rooted at, under directory scope', () => {
    const provider = new ProjectViewProvider(
      deps({
        activeProject: () => project({ dirs: ['/Users/x/deploy'] }),
        scope: () => 'directory',
        currentDir: () => '/Users/x/deploy',
      }),
    );
    const [, main, extra] = provider.getChildren();
    expect(provider.getTreeItem(main!).description).toBe('main');
    expect(provider.getTreeItem(extra!).description).toBe('showing');
  });

  it('sends a click on a directory that is NOT in the tree to the re-root verb', () => {
    // Revealing it would do nothing — the path is not among the workspace
    // folders — so the row has to be able to put it there instead.
    const provider = new ProjectViewProvider(
      deps({
        activeProject: () => project({ dirs: ['/Users/x/deploy'] }),
        scope: () => 'directory',
        currentDir: () => '/Users/x/code/web',
      }),
    );
    const [, main, extra] = provider.getChildren();
    expect(commandOf(provider, main!)).toBe('revealInExplorer');
    expect(commandOf(provider, extra!)).toBe(
      COMMANDS.showDirectoryInExplorer,
    );
  });

  it('reveals rather than re-roots under project scope, where every row is a root', () => {
    const provider = new ProjectViewProvider(
      deps({ activeProject: () => project({ dirs: ['/Users/x/deploy'] }) }),
    );
    const [, main, extra] = provider.getChildren();
    expect(commandOf(provider, main!)).toBe('revealInExplorer');
    expect(commandOf(provider, extra!)).toBe('revealInExplorer');
  });

  it('routes the project row to the switcher and the setup row to the opt-in', () => {
    const anchored = new ProjectViewProvider(deps());
    expect(commandOf(anchored, anchored.getChildren()[0]!)).toBe(
      COMMANDS.switchWorkspace,
    );

    const plain = new ProjectViewProvider(deps({ anchored: () => false }));
    expect(commandOf(plain, plain.getChildren()[0]!)).toBe(
      COMMANDS.followInExplorer,
    );
  });

  it('routes the no-project row to the switcher, which is the only thing to do from there', () => {
    const provider = new ProjectViewProvider(
      deps({ activeProject: () => undefined }),
    );
    expect(commandOf(provider, provider.getChildren()[0]!)).toBe(
      COMMANDS.switchWorkspace,
    );
  });

  it('falls back to the setup row when the host itself throws', () => {
    // A view that renders nothing is indistinguishable from a broken one; the
    // setup row at least names a verb.
    const provider = new ProjectViewProvider(
      deps({
        activeProject: () => {
          throw new Error('store not loaded');
        },
      }),
    );
    expect(provider.getChildren()).toEqual([{ kind: 'setup' }]);
  });
});
