// test/topbar.test.ts — the view title's two RESOLVING buttons, and the manifest
// entries that put them there.
//
// Both buttons are unusual in the same way: a `view/title` command is invoked
// with no argument at all, so unlike every row verb neither is handed its target
// and each has to work out what the click meant from the window. That resolution
// is the whole feature and it is pure, so it is tested directly here —
// `activeForkTarget` (which conversation to branch) and `newSessionTarget` (which
// project to start in), plus `hasForkableRow`, the predicate the fork button's
// when-clause is driven from.
//
// The manifest block at the bottom guards the contribution invariants those
// buttons rely on and that nothing else in the suite checks: every command named
// by a menu exists, the native and inline view ids stay mirrored entry for entry,
// and nothing is left in a secondary group — because one straggler there brings
// the overflow `...` back and the gear was contributed to remove it.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  activeForkTarget,
  hasForkableRow,
  newSessionTarget,
} from '../src/commands';
import type {
  CommandDeps,
  EditorialRecord,
  ProjectRecord,
  SessionForest,
  SessionNode,
} from '../src/types';
import * as vscodeMock from './mocks/vscode';

const ROOT = path.join(__dirname, '..');

const NOW = 1_785_160_000_000;
const MINUTE = 60_000;

const uuid = (n: number): string =>
  `0000000${n}-0000-4000-8000-00000000000${n}`;

/** Every id these tests name, so a test reads as prose rather than as uuids. */
const A = uuid(1);
const B = uuid(2);
const C = uuid(3);

function node(id: string, over: Partial<SessionNode> = {}): SessionNode {
  return {
    id,
    parentId: null,
    source: 'none',
    ghost: false,
    archived: false,
    hidden: false,
    deleted: false,
    status: 'idle',
    attention: 'none',
    label: id.slice(0, 8),
    kind: 'interactive',
    children: [],
    visibleChildren: [],
    ...over,
  };
}

function forestOf(nodes: SessionNode[]): SessionForest {
  const map = new Map(nodes.map((n) => [n.id, n] as const));
  const roots = nodes.filter((n) => n.parentId === null).map((n) => n.id);
  return {
    nodes: map,
    roots,
    visibleRoots: roots,
    edges: [],
    attentionCount: 0,
    generatedAt: NOW,
  };
}

function projectOf(over: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'p1',
    name: 'Storefront',
    rootDir: '/code/store',
    dirs: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

/**
 * A CommandDeps double for the two resolvers.
 *
 * Everything they are allowed to read is scriptable; everything else throws.
 * `nope()` rather than a stub is the point — a resolution that reached for a
 * launch, a terminal or the store would be doing something neither of these
 * functions is permitted to do, and a silent stand-in would hide it. The full
 * interface is satisfied rather than cast, so a signature change in types.ts
 * fails here instead of passing quietly.
 */
function depsOf(
  over: {
    nodes?: SessionNode[];
    /** What the workbench reports as the active terminal's session. */
    activeSessionId?: () => string | null;
    /** Which sessions have a transcript on disk. Defaults to "all of them",
     *  since the fork resolution's candidates need one. */
    hasTranscript?: (id: string) => boolean;
    projects?: ProjectRecord[];
    activeWorkspace?: () => string | null;
    records?: Record<string, EditorialRecord>;
    tipOf?: (id: string) => string;
  } = {},
): CommandDeps {
  const nope = (): never => {
    throw new Error('not readable by a view-title resolution');
  };
  const forest = forestOf(over.nodes ?? []);
  return {
    getForest: () => forest,
    refresh: nope,
    hasTranscript: over.hasTranscript ?? ((): boolean => true),
    tipOf: over.tipOf ?? ((id) => id),
    beginInlineRename: nope,
    beginInlineRenameProject: nope,
    revealSession: nope,
    revealProject: nope,
    getRecord: (id) => over.records?.[id],
    allRecords: () => over.records ?? {},
    upsertRecord: nope,
    recordLaunch: nope,
    launchSession: nope,
    focusSession: nope,
    ...(over.activeSessionId ? { activeSessionId: over.activeSessionId } : {}),
    renameTerminal: nope,
    sendTextToSession: nope,
    closeTerminal: nope,
    focusWindowFor: nope,
    openProject: nope,
    installHooks: nope,
    removeHooks: nope,
    getHookState: () => ({ installed: false }),
    setHooksEnabled: nope,
    allProjects: () => over.projects ?? [],
    getProject: (id) => (over.projects ?? []).find((p) => p.id === id),
    getBranches: () => [],
    setBranchShown: nope,
    setBranchesCollapsed: nope,
    upsertProject: nope,
    setProjectParent: nope,
    deleteProject: nope,
    hiddenFolders: () => [],
    hideFolder: nope,
    unhideFolder: nope,
    staleAfterHours: () => 48,
    markSeen: nope,
    notificationsEnabled: () => true,
    setOnlyActiveSessions: nope,
    setAccountsSection: nope,
    selectedSessions: () => [],
    switchWorkspace: nope,
    activeWorkspace: over.activeWorkspace ?? ((): string | null => null),
  };
}

/**
 * `openWorkspaceFolder` reads `vscode.workspace.workspaceFolders`, and the mock
 * exports no `workspace` at all — the same gap test/windows.test.ts documents for
 * `env`. So the tests that need this window to be open on a folder hang a stub
 * off the mock's module object for their own duration, rather than widening the
 * shared mock: with no stub the read throws inside the resolver's own guard and
 * "this window claims no folder" is the correct answer anyway, which is what
 * every other test here wants.
 */
function stubOpenFolder(fsPath: string | undefined): void {
  (vscodeMock as unknown as { workspace: unknown }).workspace = {
    workspaceFolders:
      fsPath === undefined ? [] : [{ uri: { fsPath }, name: 'w' }],
  };
}

afterEach(() => {
  delete (vscodeMock as unknown as { workspace?: unknown }).workspace;
});

// ------------------------------------------------------------ hasForkableRow

describe('hasForkableRow: is there anything to fork at all', () => {
  it('says no for an empty tree', () => {
    expect(hasForkableRow(forestOf([]))).toBe(false);
  });

  it('says yes for one ordinary row', () => {
    expect(hasForkableRow(forestOf([node(A)]))).toBe(true);
  });

  // A deleted row is off screen, so a button lit by one would be lit by
  // something the user cannot see.
  it('does not count a deleted row', () => {
    expect(hasForkableRow(forestOf([node(A, { deleted: true })]))).toBe(false);
  });

  // A ghost is INFERRED from a child's edge and may have no transcript anywhere.
  it('does not count a ghost', () => {
    expect(hasForkableRow(forestOf([node(A, { ghost: true })]))).toBe(false);
  });

  it('counts a closed session that is really on disk', () => {
    expect(
      hasForkableRow(
        forestOf([node(A, { archived: true, status: 'exited' })]),
      ),
    ).toBe(true);
  });
});

// --------------------------------------------------------- activeForkTarget

describe('activeForkTarget: which conversation the fork button is about', () => {
  it('takes the session whose terminal is active here', () => {
    const deps = depsOf({
      nodes: [node(A), node(B)],
      activeSessionId: () => A,
    });
    expect(activeForkTarget(deps)).toEqual({ sessionId: A, why: 'active' });
  });

  // The whole point of putting the bound terminal first: the freshest row is not
  // the one on screen, and the row on screen is what the click meant.
  it('prefers the active terminal over a more recently prompted row', () => {
    const deps = depsOf({
      nodes: [
        node(A, { lastPromptAt: NOW - 10 * MINUTE }),
        node(B, { lastPromptAt: NOW }),
      ],
      activeSessionId: () => A,
    });
    expect(activeForkTarget(deps).sessionId).toBe(A);
  });

  // The binding lives under the id the terminal LAUNCHED with; the row may have
  // been re-minted since (a resume, a /clear, a compaction).
  it('reads the active binding through its current generation', () => {
    const deps = depsOf({
      nodes: [node(B)],
      activeSessionId: () => A,
      tipOf: (id) => (id === A ? B : id),
    });
    expect(activeForkTarget(deps)).toEqual({ sessionId: B, why: 'active' });
  });

  // A session launched a second ago is bound here and not yet on the roster.
  // Falling through would fork a DIFFERENT conversation, which is the one
  // outcome the resolution exists to prevent — so the binding is trusted and
  // forkFlow gets to say "send one message first" if there is no history yet.
  it('trusts the active binding even with no row for it yet', () => {
    const deps = depsOf({ nodes: [node(B)], activeSessionId: () => C });
    expect(activeForkTarget(deps)).toEqual({ sessionId: C, why: 'active' });
  });

  it('ignores an active binding whose row has been deleted', () => {
    const deps = depsOf({
      nodes: [
        node(A, { deleted: true, lastPromptAt: NOW }),
        node(B, { lastPromptAt: NOW - MINUTE }),
        node(C, { lastPromptAt: NOW - 10 * MINUTE }),
      ],
      activeSessionId: () => A,
    });
    // Falls all the way through to the ranking, and the deleted row does not
    // win it either despite being the most recently prompted of the three.
    expect(activeForkTarget(deps)).toEqual({ sessionId: B, why: 'recent' });
  });

  it('survives a host whose activeSessionId throws', () => {
    const deps = depsOf({
      nodes: [node(A)],
      activeSessionId: () => {
        throw new Error('no window');
      },
    });
    expect(activeForkTarget(deps)).toEqual({ sessionId: A, why: 'only' });
  });

  it('falls back to the live session prompted most recently', () => {
    const deps = depsOf({
      nodes: [
        node(A, { lastPromptAt: NOW - 10 * MINUTE }),
        node(B, { lastPromptAt: NOW }),
        node(C, { lastPromptAt: NOW - MINUTE }),
      ],
    });
    expect(activeForkTarget(deps)).toEqual({ sessionId: B, why: 'recent' });
  });

  it('takes the only live session there is, prompt or no prompt', () => {
    const deps = depsOf({
      nodes: [node(A), node(B, { status: 'exited' })],
    });
    expect(activeForkTarget(deps)).toEqual({ sessionId: A, why: 'only' });
  });

  // No basis to rank them, so no guess. This is the case the whole "ask rather
  // than fork the wrong thread" rule is written for.
  it('asks when two candidates report no prompt at all', () => {
    const deps = depsOf({ nodes: [node(A), node(B)] });
    expect(activeForkTarget(deps)).toEqual({ why: 'ask' });
  });

  it('asks on a tie for most recently prompted', () => {
    const deps = depsOf({
      nodes: [node(A, { lastPromptAt: NOW }), node(B, { lastPromptAt: NOW })],
    });
    expect(activeForkTarget(deps)).toEqual({ why: 'ask' });
  });

  it('asks when one of two candidates has no prompt to compare', () => {
    const deps = depsOf({
      nodes: [node(A, { lastPromptAt: NOW }), node(B)],
    });
    // A is strictly the most recent — B contributes no timestamp at all, so it
    // cannot outrank it, and the maximum is unambiguous.
    expect(activeForkTarget(deps)).toEqual({ sessionId: A, why: 'recent' });
  });

  it('does not offer a live session with no history to branch off', () => {
    const deps = depsOf({
      nodes: [node(A), node(B)],
      hasTranscript: (id) => id === B,
    });
    expect(activeForkTarget(deps)).toEqual({ sessionId: B, why: 'only' });
  });

  // An unstarted branch shows its parent's conversation and has no transcript of
  // its own; forking it replays the parent, exactly as clicking its row does.
  it('counts an unstarted branch through its recorded parent', () => {
    const deps = depsOf({
      nodes: [node(B, { parentId: A })],
      hasTranscript: (id) => id === A,
      records: {
        [B]: {
          id: B,
          parentId: A,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    });
    expect(activeForkTarget(deps)).toEqual({ sessionId: B, why: 'only' });
  });

  // Fork works perfectly well on a closed conversation — that is what Fork on an
  // archived row is — but nothing here can say WHICH, so the picker lists them.
  it('asks when the tree holds only closed sessions', () => {
    const deps = depsOf({
      nodes: [node(A, { archived: true, status: 'exited' })],
    });
    expect(activeForkTarget(deps)).toEqual({ why: 'ask' });
  });

  it('reports an empty tree as empty, not as a question', () => {
    expect(activeForkTarget(depsOf())).toEqual({ why: 'empty' });
  });

  it('reports a tree of nothing but deleted rows as empty', () => {
    const deps = depsOf({ nodes: [node(A, { deleted: true })] });
    expect(activeForkTarget(deps)).toEqual({ why: 'empty' });
  });
});

// ---------------------------------------------------------- newSessionTarget

describe('newSessionTarget: where the + starts a session', () => {
  const store = projectOf();
  const other = projectOf({ id: 'p2', name: 'API', rootDir: '/code/api' });

  it('takes the project this window is scoped to, first of all', () => {
    // Open on a DIFFERENT project's folder — the bug this ordering fixes: the
    // window scope is the explicit statement of which project you are in.
    stubOpenFolder('/code/api');
    const deps = depsOf({
      projects: [store, other],
      activeWorkspace: () => 'p1',
    });
    expect(newSessionTarget(deps)).toEqual({
      projectId: 'p1',
      why: 'workspace',
    });
  });

  // The scoped id is persisted per window, so it outlives the project being
  // closed out of the tree or deleted outright.
  it('ignores a scope naming a project that is no longer visible', () => {
    stubOpenFolder(undefined);
    const deps = depsOf({
      projects: [projectOf({ hidden: true })],
      activeWorkspace: () => 'p1',
    });
    expect(newSessionTarget(deps)).toEqual({ why: 'ask' });
  });

  it('takes the project owning the folder this window is open on', () => {
    stubOpenFolder('/code/store/packages/web');
    const deps = depsOf({ projects: [store, other] });
    expect(newSessionTarget(deps)).toEqual({
      projectId: 'p1',
      why: 'folder-project',
    });
  });

  it('takes the project of the session holding the keyboard', () => {
    // The window is open on somewhere no project claims, so tier 2 declines.
    stubOpenFolder('/tmp/scratch');
    const deps = depsOf({
      nodes: [node(A, { cwd: '/code/api/src' })],
      projects: [store, other],
      activeSessionId: () => A,
    });
    expect(newSessionTarget(deps)).toEqual({
      projectId: 'p2',
      why: 'session-project',
    });
  });

  it('reads the active session through its current generation', () => {
    stubOpenFolder('/tmp/scratch');
    const deps = depsOf({
      nodes: [node(B, { cwd: '/code/api' })],
      projects: [other],
      activeSessionId: () => A,
      tipOf: (id) => (id === A ? B : id),
    });
    expect(newSessionTarget(deps).projectId).toBe('p2');
  });

  it('falls back to the session record when the row carries no cwd', () => {
    stubOpenFolder('/tmp/scratch');
    const deps = depsOf({
      nodes: [node(A)],
      projects: [other],
      activeSessionId: () => A,
      records: {
        [A]: {
          id: A,
          cwd: '/code/api',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    });
    expect(newSessionTarget(deps).projectId).toBe('p2');
  });

  // Unchanged behaviour, and the reason the folder tier is kept below the three
  // project ones rather than replaced by them.
  it('starts in the open folder when no project claims anything', () => {
    stubOpenFolder('/tmp/scratch');
    const deps = depsOf({ projects: [store] });
    expect(newSessionTarget(deps)).toEqual({
      cwd: '/tmp/scratch',
      why: 'folder',
    });
  });

  it('prefers the folder itself over an active session in no project', () => {
    stubOpenFolder('/tmp/scratch');
    const deps = depsOf({
      nodes: [node(A, { cwd: '/elsewhere' })],
      activeSessionId: () => A,
    });
    expect(newSessionTarget(deps)).toEqual({
      cwd: '/tmp/scratch',
      why: 'folder',
    });
  });

  it('asks only when the window answers none of the four', () => {
    stubOpenFolder(undefined);
    expect(newSessionTarget(depsOf())).toEqual({ why: 'ask' });
  });

  it('asks when there is no workspace surface to read at all', () => {
    // No stub: the read throws inside the resolver's guard, which is a window
    // that claims nothing.
    expect(newSessionTarget(depsOf())).toEqual({ why: 'ask' });
  });
});

// ------------------------------------------------------- manifest invariants

interface MenuEntry {
  command?: string;
  submenu?: string;
  when?: string;
  group: string;
}

interface Manifest {
  contributes: {
    commands: { command: string }[];
    submenus?: { id: string; label: string; icon?: string }[];
    views: Record<string, { id: string; when?: string }[]>;
    menus: Record<string, MenuEntry[]>;
  };
}

const pkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
) as Manifest;

const SESSIONS = 'lineageSessions';
const INLINE = 'lineageSessionsInline';

/** The `view/title` entries belonging to one of the two Sessions views. */
const titleEntriesFor = (viewId: string): MenuEntry[] =>
  pkg.contributes.menus['view/title'].filter((e) =>
    // `lineageSessions` is a prefix of `lineageSessionsInline`, so the test for
    // the shorter id has to reject the longer one explicitly.
    viewId === SESSIONS
      ? (e.when ?? '').includes(`view == ${SESSIONS}`) &&
        !(e.when ?? '').includes(`view == ${INLINE}`)
      : (e.when ?? '').includes(`view == ${INLINE}`),
  );

describe('manifest: the view title contributions', () => {
  it('names only commands that are actually contributed', () => {
    const declared = new Set(pkg.contributes.commands.map((c) => c.command));
    let checked = 0;
    for (const [id, entries] of Object.entries(pkg.contributes.menus)) {
      for (const entry of entries) {
        if (entry.command === undefined) continue;
        expect(declared.has(entry.command), `${id} -> ${entry.command}`).toBe(
          true,
        );
        checked++;
      }
    }
    // A loop that asserted nothing is the failure this guards against.
    expect(checked).toBeGreaterThan(0);
  });

  it('places only submenus it declares', () => {
    const declared = new Set(
      (pkg.contributes.submenus ?? []).map((s) => s.id),
    );
    for (const [id, entries] of Object.entries(pkg.contributes.menus)) {
      for (const entry of entries) {
        if (entry.submenu === undefined) continue;
        expect(declared.has(entry.submenu), `${id} -> ${entry.submenu}`).toBe(
          true,
        );
      }
    }
  });

  it('declares no submenu it never places', () => {
    const placed = new Set(
      Object.values(pkg.contributes.menus)
        .flat()
        .map((e) => e.submenu)
        .filter((s): s is string => s !== undefined),
    );
    for (const submenu of pkg.contributes.submenus ?? []) {
      expect(placed.has(submenu.id), submenu.id).toBe(true);
    }
  });

  // The two Sessions views are complementary halves of one setting
  // (`lineage.viewStyle`), so exactly one is ever on screen — which means every
  // difference between their title bars is invisible in whichever mode the author
  // was testing and broken in the other. There is no way to notice that by
  // looking; the only guard is a test.
  it('mirrors the native and inline views entry for entry', () => {
    const shape = (viewId: string): string[] =>
      titleEntriesFor(viewId)
        .map((e) =>
          [
            e.command ?? `submenu:${e.submenu ?? ''}`,
            e.group,
            (e.when ?? '')
              .replace(`view == ${INLINE}`, 'view == VIEW')
              .replace(`view == ${SESSIONS}`, 'view == VIEW'),
          ].join(' | '),
        )
        .sort();

    const native = shape(SESSIONS);
    expect(native.length).toBeGreaterThan(0);
    expect(shape(INLINE)).toEqual(native);
  });

  // The gear exists to remove the overflow `...`, and the workbench draws that
  // the moment ANY entry sits outside `navigation`. One straggler and the ellipsis
  // is back, sitting next to the gear that was contributed to replace it.
  it('leaves nothing in a secondary group, or the ... comes back', () => {
    for (const viewId of [SESSIONS, INLINE]) {
      for (const entry of titleEntriesFor(viewId)) {
        expect(
          entry.group.startsWith('navigation'),
          `${viewId}: ${entry.command ?? entry.submenu} is in ${entry.group}`,
        ).toBe(true);
      }
    }
  });

  it('carries the gear on the submenu, and puts it last on the row', () => {
    const gear = (pkg.contributes.submenus ?? []).find(
      (s) => s.id === 'lineage.settings',
    );
    // Without an icon the workbench renders an empty slot in a toolbar, not a
    // labelled button (microsoft/vscode#206326).
    expect(gear?.icon).toBe('$(gear)');

    for (const viewId of [SESSIONS, INLINE]) {
      const entries = titleEntriesFor(viewId);
      const placed = entries.find((e) => e.submenu === 'lineage.settings');
      expect(placed, viewId).toBeDefined();
      const order = (group: string): number =>
        Number(group.split('@')[1] ?? '0');
      const last = Math.max(...entries.map((e) => order(e.group)));
      expect(order(placed?.group ?? ''), viewId).toBe(last);
    }
  });

  // "Move bell, ideally up, on the same row as the name" — leftmost is @0, and
  // both halves of the bell (plain and dotted) have to agree on it or the icon
  // jumps along the row the moment something goes unread.
  it('keeps both halves of the bell leftmost', () => {
    for (const viewId of [SESSIONS, INLINE]) {
      const bells = titleEntriesFor(viewId).filter((e) =>
        (e.command ?? '').startsWith('lineage.showNotifications'),
      );
      expect(bells).toHaveLength(2);
      for (const bell of bells) expect(bell.group).toBe('navigation@0');
    }
  });

  it('keeps every moved item in the gear menu, grouped as it was', () => {
    const items = pkg.contributes.menus['lineage.settings'] ?? [];
    const byCommand = new Map(items.map((e) => [e.command, e.group] as const));
    // The exact set that used to live in `2_manage` and `1_hooks` on the view
    // title, plus the Accounts toggle. A verb that goes missing from here is a
    // verb with no menu at all — invisible, not merely misplaced.
    expect([...byCommand.keys()].sort()).toEqual(
      [
        'lineage.deleteStale',
        'lineage.hideAccountsSection',
        'lineage.installHooks',
        'lineage.markAllNotificationsRead',
        'lineage.refresh',
        'lineage.removeHooks',
        'lineage.restoreSession',
        'lineage.showAccountsSection',
        'lineage.showHidden',
      ].sort(),
    );
    // Still sectioned, so the menu reads the way the overflow did.
    expect(byCommand.get('lineage.installHooks')).toBe('1_hooks@1');
    expect(byCommand.get('lineage.showHidden')).toBe('2_manage@0');
    expect(byCommand.get('lineage.showAccountsSection')).toBe('3_accounts@0');
  });

  // The items are declared ONCE rather than per view: a submenu only renders
  // where it is placed, and it is placed in both view titles, so a `view ==`
  // clause there would only have been doing the mirroring by hand.
  it('declares the gear menu once, not per view', () => {
    for (const entry of pkg.contributes.menus['lineage.settings'] ?? []) {
      expect(entry.when ?? '', entry.command).not.toContain('view ==');
    }
  });
});

describe('manifest: the Accounts section is what frees the FLOCK row', () => {
  // The bell only reaches the container header while the container has ONE
  // visible view, so this when-clause is load-bearing for the whole top bar.
  it('gates the Accounts view on both of its settings', () => {
    const accounts = pkg.contributes.views['lineage'].find(
      (v) => v.id === 'lineageAccounts',
    );
    expect(accounts?.when).toContain('config.lineage.accounts.enabled');
    expect(accounts?.when).toContain('config.lineage.accounts.section');
  });

  // A `visibility` default would not reach an existing profile — VS Code
  // persists a user's view visibility per container — so the gate has to be a
  // when-clause or the row silently stays as it was for everyone who has ever
  // opened the sidebar.
  it('ships the section off by default', () => {
    const props = (
      pkg as unknown as {
        contributes: {
          configuration: { properties: Record<string, { default?: unknown }> };
        };
      }
    ).contributes.configuration.properties;
    expect(props['lineage.accounts.section'].default).toBe(false);
    expect(props['lineage.accounts.enabled'].default).toBe(true);
  });
});
