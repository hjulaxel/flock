// test/explorer.test.ts — the Explorer follows the project.
//
// What matters here is the SPLICE ARITHMETIC and the anchor invariant. The
// workbench half (updateWorkspaceFolders, the folder-change event) can only be
// exercised in a live host; every decision that reaches it is decided in pure
// code and asserted below — above all the one that cannot be allowed to go
// wrong: a splice at index 0 terminates and restarts the extension host, which
// would kill every session in the window. `planSplice` must never emit one, and
// `ExplorerSync` must refuse to splice at all in a window whose folder[0] has
// stopped being ours.

import { describe, expect, it } from 'vitest';

import {
  ANCHOR_LABEL,
  ExplorerSync,
  desiredFolders,
  isAnchored,
  nonAnchorFolders,
  planSplice,
  withAnchorName,
  workspaceFileJson,
  type ExplorerHost,
  type FolderSpec,
} from '../src/explorer';
import { PATHS_FOLD_CASE } from '../src/projects';
import type { ProjectRecord } from '../src/types';

const ANCHOR = '/Users/x/.lineage/anchor';

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

/** A host double that records everything and reports the folder list it was
 *  given, updated as splices land. */
function host(
  initial: FolderSpec[],
  over: Partial<ExplorerHost> = {},
): ExplorerHost & {
  calls: Array<{ start: number; deleteCount: number; add: FolderSpec[] }>;
  waits: number;
  current: FolderSpec[];
} {
  const state = {
    calls: [] as Array<{ start: number; deleteCount: number; add: FolderSpec[] }>,
    waits: 0,
    current: [...initial],
    folders: (): FolderSpec[] => [...state.current],
    splice: (start: number, deleteCount: number, add: readonly FolderSpec[]) => {
      state.calls.push({ start, deleteCount, add: [...add] });
      state.current.splice(start, deleteCount, ...add);
      return true;
    },
    awaitFolderChange: async (): Promise<void> => {
      state.waits += 1;
    },
    ...over,
  };
  return state;
}

const anchorFolder: FolderSpec = { path: ANCHOR, name: ANCHOR_LABEL };

/** Drain the microtask queue. `sync()` defers onto a promise chain and awaits
 *  the existence filter, so "has the splice happened yet" is several ticks
 *  away — but never a timer, so this settles everything that is not gated. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

// --------------------------------------------------------------- isAnchored

describe('explorer: isAnchored', () => {
  it('is true when folder[0] is the anchor', () => {
    expect(isAnchored([anchorFolder, { path: '/a' }], ANCHOR)).toBe(true);
  });

  it('ignores trailing separators, which the two sides spell differently', () => {
    expect(isAnchored([{ path: `${ANCHOR}/` }], ANCHOR)).toBe(true);
  });

  it.runIf(PATHS_FOLD_CASE)('ignores case where the platform does', () => {
    expect(isAnchored([{ path: ANCHOR.toUpperCase() }], ANCHOR)).toBe(true);
  });

  it('is false when the anchor is present but NOT first', () => {
    // A user who dragged another folder above ours: index 1 no longer means
    // what the module thinks it means, so nothing may be spliced.
    expect(isAnchored([{ path: '/a' }, anchorFolder], ANCHOR)).toBe(false);
  });

  it('is false for an empty window and for an empty anchor path', () => {
    expect(isAnchored([], ANCHOR)).toBe(false);
    expect(isAnchored([anchorFolder], '')).toBe(false);
  });
});

// --------------------------------------------------------- nonAnchorFolders

describe('explorer: nonAnchorFolders', () => {
  it('strips the anchor and keeps every real folder, order intact', () => {
    // The converted-window shape: anchor first, the user's folders after. The
    // real folders are the window's identity — what the folder-mode fence
    // scopes to and what the WindowRecord publishes for routing.
    expect(nonAnchorFolders(ANCHOR, [ANCHOR, '/a', '/b'])).toEqual([
      '/a',
      '/b',
    ]);
  });

  it('strips the anchor wherever it sits, however it is spelled', () => {
    // A rearranged window is degraded for splices (isAnchored says no) but
    // its real folders are still its real folders.
    expect(
      nonAnchorFolders(ANCHOR, ['/a', `${ANCHOR}/`, '/b']),
    ).toEqual(['/a', '/b']);
    if (PATHS_FOLD_CASE) {
      expect(nonAnchorFolders(ANCHOR, [ANCHOR.toUpperCase(), '/a'])).toEqual([
        '/a',
      ]);
    }
  });

  it('drops junk entries and passes unconverted windows through unchanged', () => {
    expect(nonAnchorFolders(ANCHOR, ['', '/a'])).toEqual(['/a']);
    expect(nonAnchorFolders(ANCHOR, ['/x', '/y'])).toEqual(['/x', '/y']);
    expect(nonAnchorFolders(ANCHOR, [])).toEqual([]);
  });

  it('an empty anchor path strips nothing', () => {
    expect(nonAnchorFolders('', ['/a'])).toEqual(['/a']);
  });
});

// ----------------------------------------------------------- desiredFolders

describe('explorer: desiredFolders', () => {
  it('labels every root by its own directory — the project name lives on the anchor above them', () => {
    const rows = desiredFolders(
      project({ dirs: ['/Users/x/sandbox'] }),
      ANCHOR,
    );
    expect(rows).toEqual([
      { path: '/Users/x/code/web', name: 'web' },
      { path: '/Users/x/sandbox', name: 'sandbox' },
    ]);
  });

  it('falls back to the path for a filesystem root, which has no basename', () => {
    expect(desiredFolders(project({ rootDir: '/' }), ANCHOR)).toEqual([
      { path: '/', name: '/' },
    ]);
  });

  it('keeps the main directory first and the extras in order below it', () => {
    const rows = desiredFolders(
      project({ dirs: ['/Users/x/deploy', '/Users/x/sandbox'] }),
      ANCHOR,
    );
    expect(rows.map((r) => r.path)).toEqual([
      '/Users/x/code/web',
      '/Users/x/deploy',
      '/Users/x/sandbox',
    ]);
  });

  it('never emits the same directory twice — a duplicate URI makes the workbench reject the WHOLE splice', () => {
    // Spelled with a trailing separator, which every platform folds; the
    // case variant is a second duplicate only where the platform folds case.
    const rows = desiredFolders(
      project({
        dirs: PATHS_FOLD_CASE
          ? ['/Users/x/code/web', '/Users/X/CODE/WEB']
          : ['/Users/x/code/web', '/Users/x/code/web/'],
      }),
      ANCHOR,
    );
    expect(rows).toHaveLength(1);
  });

  it('excludes the anchor, which would collide with folder[0]', () => {
    const rows = desiredFolders(
      project({ rootDir: '/Users/x/code/web', dirs: [ANCHOR] }),
      ANCHOR,
    );
    expect(rows.map((r) => r.path)).toEqual(['/Users/x/code/web']);
  });

  it('is empty for no project', () => {
    expect(desiredFolders(null, ANCHOR)).toEqual([]);
    expect(desiredFolders(undefined, ANCHOR)).toEqual([]);
  });
});

// ------------------------------------------------------- 'directory' scope
//
// The narrowing is a property of what is DESIRED, not of how it is applied:
// every splice below this point is identical either way. So the whole of the
// setting's behaviour is decided here, in one pure function.

describe('explorer: desiredFolders under directory scope', () => {
  const web = project({ dirs: ['/Users/x/deploy', '/Users/x/sandbox'] });

  it('shows ONE root — the directory being worked in', () => {
    expect(
      desiredFolders(web, ANCHOR, {
        scope: 'directory',
        currentDir: '/Users/x/deploy',
      }),
    ).toEqual([{ path: '/Users/x/deploy', name: 'deploy' }]);
  });

  it('falls back to the main directory when nothing says where we are', () => {
    for (const currentDir of [undefined, '']) {
      expect(
        desiredFolders(web, ANCHOR, { scope: 'directory', currentDir }),
      ).toEqual([{ path: '/Users/x/code/web', name: 'web' }]);
    }
  });

  it.runIf(PATHS_FOLD_CASE)('matches the current directory the way every other path compare does', () => {
    // pathKey, not string equality: on macOS and Windows the Explorer would
    // otherwise re-root itself over a difference in case. Linux compares
    // exactly, so there the two spellings ARE two directories and this
    // expectation does not apply.
    expect(
      desiredFolders(web, ANCHOR, {
        scope: 'directory',
        currentDir: '/Users/X/DEPLOY/',
      }),
    ).toEqual([{ path: '/Users/x/deploy', name: 'deploy' }]);
  });

  it('honours a directory the project does not list — a linked worktree is the point', () => {
    // matchProject hands a project every checkout of every repository its
    // directories sit in, so this is the ordinary way to be somewhere real that
    // is not in `dirs`. Rooting at the main directory instead would show a tree
    // the user is not editing.
    expect(
      desiredFolders(web, ANCHOR, {
        scope: 'directory',
        currentDir: '/Users/x/web-feat-x',
      }),
    ).toEqual([{ path: '/Users/x/web-feat-x', name: 'web-feat-x' }]);
  });

  it('refuses the anchor, which would collide with folder[0]', () => {
    expect(
      desiredFolders(web, ANCHOR, { scope: 'directory', currentDir: ANCHOR }),
    ).toEqual([{ path: '/Users/x/code/web', name: 'web' }]);
  });

  it('is empty for a project with no directories, exactly as project scope is', () => {
    const bare = project({ rootDir: '', dirs: [] });
    expect(desiredFolders(bare, ANCHOR, { scope: 'directory' })).toEqual(
      desiredFolders(bare, ANCHOR),
    );
  });

  it('roots at the current directory when NO project claims the session', () => {
    // The auto-switch model follows the SESSION, and a session may be running
    // in a loose checkout nobody has filed into a project yet. Clearing the
    // tree back to the anchor because of that is the one outcome a following
    // Explorer may never produce.
    expect(
      desiredFolders(null, ANCHOR, {
        scope: 'directory',
        currentDir: '/tmp/scratch',
      }),
    ).toEqual([{ path: '/tmp/scratch', name: 'scratch' }]);
  });

  it('still answers nothing for no project under project scope, or with no directory', () => {
    // `'project'` scope has no directory LIST to expand into roots without a
    // project, so [] stays the only honest answer there — and an absent
    // `currentDir` is the "leave workspace" path, which must stay byte-identical.
    expect(
      desiredFolders(null, ANCHOR, {
        scope: 'project',
        currentDir: '/tmp/scratch',
      }),
    ).toEqual([]);
    expect(desiredFolders(null, ANCHOR, { scope: 'directory' })).toEqual([]);
    expect(
      desiredFolders(null, ANCHOR, { scope: 'directory', currentDir: ANCHOR }),
    ).toEqual([]);
  });

  it('is unchanged from before when the scope is project, or absent', () => {
    const all = desiredFolders(web, ANCHOR);
    expect(desiredFolders(web, ANCHOR, {})).toEqual(all);
    expect(
      desiredFolders(web, ANCHOR, {
        scope: 'project',
        currentDir: '/Users/x/deploy',
      }),
    ).toEqual(all);
    expect(all).toHaveLength(3);
  });
});

// --------------------------------------------------------------- planSplice

describe('explorer: planSplice', () => {
  it('returns null when the Explorer already shows exactly this', () => {
    const current = [anchorFolder, { path: '/a', name: 'A' }];
    expect(planSplice(current, [{ path: '/a', name: 'A' }])).toBeNull();
  });

  it('adds the whole tail to a bare anchor', () => {
    const plan = planSplice(
      [anchorFolder],
      [
        { path: '/a', name: 'A' },
        { path: '/b', name: 'B' },
      ],
    );
    expect(plan).toEqual({
      start: 1,
      deleteCount: 0,
      add: [
        { path: '/a', name: 'A' },
        { path: '/b', name: 'B' },
      ],
    });
  });

  it('trims the common prefix, so a shared directory keeps its expansion state', () => {
    // Two projects that both include /shared: switching between them must not
    // tear /shared down and rebuild it (a rebuilt root comes back collapsed).
    const plan = planSplice(
      [anchorFolder, { path: '/shared', name: 'shared' }, { path: '/old', name: 'old' }],
      [
        { path: '/shared', name: 'shared' },
        { path: '/new', name: 'new' },
      ],
    );
    expect(plan).toEqual({
      start: 2,
      deleteCount: 1,
      add: [{ path: '/new', name: 'new' }],
    });
  });

  it('removes what a narrower project does not have', () => {
    const plan = planSplice(
      [anchorFolder, { path: '/a', name: 'A' }, { path: '/b', name: 'B' }],
      [{ path: '/a', name: 'A' }],
    );
    expect(plan).toEqual({ start: 2, deleteCount: 1, add: [] });
  });

  it('clears the tail back to the anchor for no project', () => {
    const plan = planSplice([anchorFolder, { path: '/a', name: 'A' }], []);
    expect(plan).toEqual({ start: 1, deleteCount: 1, add: [] });
  });

  it('splices on a LABEL change alone — that is how a renamed project reaches the Explorer', () => {
    const plan = planSplice(
      [anchorFolder, { path: '/a', name: 'Old Name' }],
      [{ path: '/a', name: 'New Name' }],
    );
    expect(plan).toEqual({
      start: 1,
      deleteCount: 1,
      add: [{ path: '/a', name: 'New Name' }],
    });
  });

  it('NEVER starts below 1 — index 0 restarts the extension host', () => {
    const tails: FolderSpec[][] = [
      [],
      [{ path: '/a', name: 'A' }],
      [{ path: '/a', name: 'A' }, { path: '/b', name: 'B' }],
      [{ path: '/b', name: 'B' }],
    ];
    for (const current of tails) {
      for (const desired of tails) {
        const plan = planSplice([anchorFolder, ...current], desired);
        if (plan) expect(plan.start).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

// --------------------------------------------------------- workspaceFileJson

describe('explorer: workspaceFileJson', () => {
  it('puts the anchor first, labelled, with the project tail after it', () => {
    const parsed = JSON.parse(
      workspaceFileJson(ANCHOR, [{ path: '/Users/x/code/web', name: 'Magma Web' }]),
    ) as { folders: FolderSpec[]; settings: Record<string, unknown> };
    expect(parsed.folders[0]).toEqual({ path: ANCHOR, name: ANCHOR_LABEL });
    expect(parsed.folders[1]).toEqual({
      path: '/Users/x/code/web',
      name: 'Magma Web',
    });
  });

  it('writes no settings — the file becomes the window settings root and Flock has no opinions to put in it', () => {
    const parsed = JSON.parse(workspaceFileJson(ANCHOR, [])) as {
      settings: Record<string, unknown>;
    };
    expect(parsed.settings).toEqual({});
  });
});

// -------------------------------------------------------------- ExplorerSync

describe('explorer: ExplorerSync', () => {
  it('refuses to touch a window that is not anchored', async () => {
    const h = host([{ path: '/somewhere/else' }]);
    const sync = new ExplorerSync(h, ANCHOR);
    expect(sync.anchored()).toBe(false);
    expect(await sync.sync(project())).toBe('not-anchored');
    expect(h.calls).toHaveLength(0);
  });

  it('refuses when a foreign folder has been dragged above the anchor', async () => {
    const h = host([{ path: '/foreign' }, anchorFolder, { path: '/a' }]);
    expect(await new ExplorerSync(h, ANCHOR).sync(project())).toBe(
      'not-anchored',
    );
    expect(h.calls).toHaveLength(0);
  });

  it('splices the project in and waits for the folder-change event', async () => {
    const h = host([anchorFolder]);
    const sync = new ExplorerSync(h, ANCHOR);
    expect(await sync.sync(project({ dirs: ['/Users/x/sandbox'] }))).toBe(
      'spliced',
    );
    expect(h.calls).toEqual([
      {
        start: 1,
        deleteCount: 0,
        add: [
          { path: '/Users/x/code/web', name: 'web' },
          { path: '/Users/x/sandbox', name: 'sandbox' },
        ],
      },
    ]);
    // The API forbids a second update before the event lands.
    expect(h.waits).toBe(1);
  });

  it('does nothing the second time the same project is synced', async () => {
    const h = host([anchorFolder]);
    const sync = new ExplorerSync(h, ANCHOR);
    await sync.sync(project());
    expect(await sync.sync(project())).toBe('unchanged');
    expect(h.calls).toHaveLength(1);
  });

  it('splices in ONE root under directory scope', async () => {
    const h = host([anchorFolder], { scope: () => 'directory' });
    const sync = new ExplorerSync(h, ANCHOR);
    expect(
      await sync.sync(
        project({ dirs: ['/Users/x/sandbox'] }),
        '/Users/x/sandbox',
      ),
    ).toBe('spliced');
    expect(h.current).toEqual([
      anchorFolder,
      { path: '/Users/x/sandbox', name: 'sandbox' },
    ]);
  });

  it('re-roots in place when attention moves to another directory', async () => {
    const h = host([anchorFolder], { scope: () => 'directory' });
    const sync = new ExplorerSync(h, ANCHOR);
    const p = project({ dirs: ['/Users/x/sandbox'] });
    await sync.sync(p, '/Users/x/code/web');
    expect(await sync.sync(p, '/Users/x/sandbox')).toBe('spliced');
    // The splice still starts at 1 — the anchor invariant is not something
    // narrowing is allowed to weaken.
    expect(h.calls.every((c) => c.start >= 1)).toBe(true);
    expect(h.current).toEqual([
      anchorFolder,
      { path: '/Users/x/sandbox', name: 'sandbox' },
    ]);
  });

  it('re-reads the scope on every sync, so the setting needs no reload', async () => {
    let scope: 'directory' | 'project' = 'directory';
    const h = host([anchorFolder], { scope: () => scope });
    const sync = new ExplorerSync(h, ANCHOR);
    const p = project({ dirs: ['/Users/x/sandbox'] });
    await sync.sync(p, '/Users/x/code/web');
    expect(h.current).toHaveLength(2);
    scope = 'project';
    expect(await sync.sync(p, '/Users/x/code/web')).toBe('spliced');
    expect(h.current).toHaveLength(3);
  });

  it('treats a scope reader that throws as project scope, not as a broken sync', async () => {
    const h = host([anchorFolder], {
      scope: () => {
        throw new Error('configuration is mid-reload');
      },
    });
    const sync = new ExplorerSync(h, ANCHOR);
    expect(
      await sync.sync(project({ dirs: ['/Users/x/sandbox'] }), '/Users/x/sandbox'),
    ).toBe('spliced');
    expect(h.current).toHaveLength(3);
  });

  it('clears the tail back to the anchor for a null project', async () => {
    const h = host([anchorFolder, { path: '/a', name: 'A' }]);
    expect(await new ExplorerSync(h, ANCHOR).sync(null)).toBe('spliced');
    expect(h.current).toEqual([anchorFolder]);
  });

  it('reports a rejected splice and does NOT wait for an event that is not coming', async () => {
    const h = host([anchorFolder], { splice: () => false });
    const sync = new ExplorerSync(h, ANCHOR);
    expect(await sync.sync(project())).toBe('rejected');
    expect(h.waits).toBe(0);
  });

  it('serialises overlapping syncs — a second splice before the first event is undefined behaviour', async () => {
    const order: string[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = host([anchorFolder], {
      awaitFolderChange: async (): Promise<void> => {
        order.push('wait:start');
        await gate;
        order.push('wait:end');
      },
    });
    const sync = new ExplorerSync(h, ANCHOR);

    const first = sync.sync(project({ id: 'p1', rootDir: '/a', name: 'A' }));
    const second = sync.sync(project({ id: 'p2', rootDir: '/b', name: 'B' }));
    // Let the first sync reach its splice and park on the gate. Both syncs are
    // pure microtasks up to that point, so draining the queue is enough — and
    // nothing may advance past the gate, which is the assertion below.
    await flush();
    // The FIRST splice has landed; the second has not been issued, because the
    // first is still waiting on its folder-change event.
    expect(h.calls).toHaveLength(1);

    release();
    await first;
    await second;
    expect(order).toEqual(['wait:start', 'wait:end', 'wait:start', 'wait:end']);
    expect(h.calls).toHaveLength(2);
    expect(h.current.map((f) => f.path)).toEqual([ANCHOR, '/b']);
  });

  it('keeps the queue moving after a host that throws', async () => {
    let boom = true;
    const h = host([anchorFolder], {
      splice: (start: number, deleteCount: number, add: readonly FolderSpec[]) => {
        if (boom) throw new Error('workbench said no');
        h.calls.push({ start, deleteCount, add: [...add] });
        h.current.splice(start, deleteCount, ...add);
        return true;
      },
    });
    const sync = new ExplorerSync(h, ANCHOR);
    expect(await sync.sync(project())).toBe('rejected');
    boom = false;
    expect(await sync.sync(project())).toBe('spliced');
  });

  it('drops directories that no longer exist rather than adding a permanent error row', async () => {
    const h = host([anchorFolder], {
      exists: async (p: string) => p !== '/Users/x/gone',
    });
    const sync = new ExplorerSync(h, ANCHOR);
    await sync.sync(project({ dirs: ['/Users/x/gone', '/Users/x/sandbox'] }));
    expect(h.current.map((f) => f.path)).toEqual([
      ANCHOR,
      '/Users/x/code/web',
      '/Users/x/sandbox',
    ]);
  });

  it('keeps a directory whose existence probe THREW — unreadable is not missing', async () => {
    const h = host([anchorFolder], {
      exists: async (): Promise<boolean> => {
        throw new Error('EACCES');
      },
    });
    await new ExplorerSync(h, ANCHOR).sync(project());
    expect(h.current.map((f) => f.path)).toEqual([ANCHOR, '/Users/x/code/web']);
  });
});

// ------------------------------------------------------- the anchor's label

describe('explorer: currentRoots — the mark reads off the tree', () => {
  it('reports the live folder list with the anchor dropped', () => {
    const h = host([anchorFolder, { path: '/code/lib' }]);
    expect(new ExplorerSync(h, ANCHOR).currentRoots()).toEqual(['/code/lib']);
  });

  it('follows a splice, so it cannot name a root that is not there', async () => {
    // The disagreement this exists to remove: the header used to RECOMPUTE which
    // directory the tree was showing from where the active session is, and when
    // the front conversation belonged to none of the project's directories the
    // follow listener correctly left the tree alone while the recomputed mark
    // moved to the project's main folder on its own.
    const h = host([anchorFolder]);
    const sync = new ExplorerSync(h, ANCHOR);
    expect(sync.currentRoots()).toEqual([]);
    await sync.sync(project({ dirs: ['/Users/x/sandbox'] }));
    expect(sync.currentRoots()).toContain('/Users/x/sandbox');
  });

  it('is empty, not an error, when the host throws', () => {
    const h = host([anchorFolder], {
      folders: () => {
        throw new Error('no workspace');
      },
    });
    expect(new ExplorerSync(h, ANCHOR).currentRoots()).toEqual([]);
  });
});

describe('explorer: the anchor carries the project name', () => {
  /** A host whose anchor label actually follows the on-disk rename, i.e. a
   *  workbench that applies the edit — the case this design is betting on. */
  function labelling(initial: FolderSpec[]) {
    const h = host(initial, {
      renameAnchor: async (name: string): Promise<void> => {
        h.renamed.push(name);
        h.current[0] = { ...h.current[0]!, name };
      },
    }) as ReturnType<typeof host> & { renamed: string[] };
    h.renamed = [];
    return h;
  }

  it('relabels the anchor to the active project after the splice settles', async () => {
    const h = labelling([anchorFolder]);
    await new ExplorerSync(h, ANCHOR).sync(project());
    expect(h.renamed).toEqual(['Magma Web']);
    expect(h.current[0]?.name).toBe('Magma Web');
  });

  it('relabels on a project RENAME, when no folder moved at all', async () => {
    const h = labelling([anchorFolder]);
    const sync = new ExplorerSync(h, ANCHOR);
    await sync.sync(project());
    expect(await sync.sync(project({ name: 'Magma Web v2' }))).toBe('unchanged');
    expect(h.renamed).toEqual(['Magma Web', 'Magma Web v2']);
  });

  it('stops writing the file once the workbench agrees', async () => {
    const h = labelling([anchorFolder]);
    const sync = new ExplorerSync(h, ANCHOR);
    await sync.sync(project());
    await sync.sync(project());
    expect(h.renamed).toEqual(['Magma Web']);
  });

  it('KEEPS re-attempting against a workbench that ignores the rename', async () => {
    // The whole point of comparing to the live label rather than to what we
    // last wrote: a workbench that never applies it must not be written off
    // after one try, because the header view's `when` clause reads the same
    // live label to decide whether it is still needed.
    const renamed: string[] = [];
    const h = host([anchorFolder], {
      renameAnchor: async (name: string): Promise<void> => {
        renamed.push(name);
      },
    });
    const sync = new ExplorerSync(h, ANCHOR);
    await sync.sync(project());
    await sync.sync(project());
    expect(renamed).toEqual(['Magma Web', 'Magma Web']);
    expect(sync.anchorLabel()).toBe(ANCHOR_LABEL);
  });

  it('falls back to the product name when the window is scoped to nothing', async () => {
    const h = labelling([{ path: ANCHOR, name: 'Magma Web' }]);
    await new ExplorerSync(h, ANCHOR).sync(null);
    expect(h.renamed).toEqual([ANCHOR_LABEL]);
  });

  it('does nothing at all when the host cannot rename', async () => {
    const h = host([anchorFolder]);
    await new ExplorerSync(h, ANCHOR).sync(project());
    expect(h.current[0]?.name).toBe(ANCHOR_LABEL);
  });

  it('never lets a rename that throws break the switch', async () => {
    const h = host([anchorFolder], {
      renameAnchor: async (): Promise<void> => {
        throw new Error('EROFS');
      },
    });
    expect(await new ExplorerSync(h, ANCHOR).sync(project())).toBe('spliced');
  });
});

describe('explorer: withAnchorName', () => {
  const file = JSON.stringify(
    {
      folders: [
        { path: '/anchor', name: 'Flock' },
        { name: 'web', path: '../../web' },
      ],
      settings: {},
    },
    null,
    2,
  );

  it('replaces folders[0].name and leaves everything else exactly as found', () => {
    const out = withAnchorName(file, 'Magma Web');
    const parsed = JSON.parse(out ?? '') as {
      folders: FolderSpec[];
      settings: unknown;
    };
    expect(parsed.folders[0]).toEqual({ path: '/anchor', name: 'Magma Web' });
    // VS Code rewrites the tail on every splice — a relative path it chose
    // stays relative, and the key order it chose stays put.
    expect(parsed.folders[1]).toEqual({ name: 'web', path: '../../web' });
    expect(JSON.stringify(parsed.folders[1])).toBe('{"name":"web","path":"../../web"}');
  });

  it('returns the text untouched when the name is already right', () => {
    expect(withAnchorName(file, 'Flock')).toBe(file);
  });

  it('refuses to clobber a file it could not parse', () => {
    // A .code-workspace may legally carry comments; a mislabelled row is a far
    // smaller problem than a workspace file replaced by our idea of it.
    expect(withAnchorName('// a comment\n{ "folders": [] }', 'X')).toBeNull();
    expect(withAnchorName('not json at all', 'X')).toBeNull();
    expect(withAnchorName('{"folders":[]}', 'X')).toBeNull();
    expect(withAnchorName('{}', 'X')).toBeNull();
  });
});
