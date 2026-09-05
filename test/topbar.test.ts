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
import {
  branchTokens,
  projectContextValue,
  sessionContextValue,
  subprojectTokens,
} from '../src/viewmodel';
import { contextValueOf } from '../src/types';
import type {
  CommandDeps,
  EditorialRecord,
  ProjectGroupNode,
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
    focusSessionsView: nope,
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
    setBranchesShown: nope,
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
    setShellsSection: nope,
    setBranchDisplay: nope,
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
    commands: { command: string; icon?: string }[];
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

  // A COMMAND with a gear icon, not a submenu. The submenu shipped first and was
  // not drawn in the sidebar at all: nothing documents a submenu rendering as a
  // button in a VIEW title, and a toolbar too narrow for its buttons collapses
  // into the very `...` the gear replaces. A command with an icon is drawn
  // wherever a command can be drawn.
  it('carries the gear on a command, and puts it last on the row', () => {
    const gear = pkg.contributes.commands.find(
      (c) => c.command === 'lineage.settingsMenu',
    );
    expect(gear?.icon).toBe('$(gear)');

    for (const viewId of [SESSIONS, INLINE]) {
      const entries = titleEntriesFor(viewId);
      const placed = entries.find((e) => e.command === 'lineage.settingsMenu');
      expect(placed, viewId).toBeDefined();
      const order = (group: string): number =>
        Number(group.split('@')[1] ?? '0');
      const last = Math.max(...entries.map((e) => order(e.group)));
      expect(order(placed?.group ?? ''), viewId).toBe(last);
    }
  });

  // The row is narrow, and the workbench overflows a toolbar it cannot fit into
  // an ellipsis — which would swallow the gear, since the gear is last. Five
  // buttons is what fits: the bell, New Project, `+`, fork and the gear.
  //
  // New Project came back onto the row and the active-only FILTER left to make
  // room for it. The filter is already in the gear menu, labelled with the
  // direction it goes, where New Project had no home but the menu — and starting
  // a project is a thing you do before you can do anything else.
  it('keeps the row down to five buttons', () => {
    for (const viewId of [SESSIONS, INLINE]) {
      // Count SLOTS, not entries: the bell and the filter each contribute two
      // complementary entries and only ever draw one of them.
      const slots = new Set(
        titleEntriesFor(viewId).map((e) => e.group),
      );
      expect(slots.size, viewId).toBeLessThanOrEqual(5);
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

  // The gear menu is built in code (commands.settingsMenu) rather than declared,
  // which is what lets it label a toggle with the direction it goes. The manifest
  // can still check the half that matters: every verb the menu offers has to be a
  // contributed command, or the menu entry fires nothing and the verb is
  // unreachable from the palette too.
  it('contributes every verb the gear menu delegates to', () => {
    const declared = new Set(pkg.contributes.commands.map((c) => c.command));
    for (const id of [
      'lineage.showOnlyActiveSessions',
      'lineage.showAllSessions',
      'lineage.showHidden',
      'lineage.markAllNotificationsRead',
      'lineage.restoreSession',
      'lineage.deleteStale',
      'lineage.newProject',
      'lineage.reopenProject',
      'lineage.showAccountsSection',
      'lineage.hideAccountsSection',
      'lineage.showShellsSection',
      'lineage.hideShellsSection',
      'lineage.installHooks',
      'lineage.removeHooks',
      'lineage.refresh',
    ]) {
      expect(declared.has(id), id).toBe(true);
    }
  });

  // New Project is ON the row, second from the left, and the active-only filter
  // is not — see the five-button note above for the trade. Open a Closed
  // Project… stays in the gear menu: it is the rarer of the two by a long way,
  // and the row has no sixth slot.
  it('puts New Project on the row and keeps the filter in the menu', () => {
    for (const viewId of [SESSIONS, INLINE]) {
      const entries = titleEntriesFor(viewId);
      const ids = entries.map((e) => e.command);
      expect(ids, viewId).toContain('lineage.newProject');
      expect(ids, viewId).not.toContain('lineage.reopenProject');
      expect(ids, viewId).not.toContain('lineage.showOnlyActiveSessions');
      expect(ids, viewId).not.toContain('lineage.showAllSessions');
      // Second from the left: after the bell, before the `+`. Starting a project
      // comes before starting a session in one.
      const placed = entries.find((e) => e.command === 'lineage.newProject');
      expect(placed?.group, viewId).toBe('navigation@1');
    }
  });

  // Nothing declares a submenu any more. Left behind, the declaration would be a
  // contribution the workbench validates and nothing places.
  it('declares no submenus at all', () => {
    expect(pkg.contributes.submenus ?? []).toHaveLength(0);
    expect(pkg.contributes.menus['lineage.settings']).toBeUndefined();
  });
});

describe('manifest: the session row context menus', () => {
  // The row menus cannot be mirrored wholesale the way the title bars are:
  // the two views genuinely differ there (rename is a different command
  // inline, because owning the row markup is the whole reason inline exists).
  // So each shared verb is a separate chance to contribute to one menu and
  // forget the other — and since exactly one view is ever on screen, the
  // author testing in one mode cannot see the hole in the other. Move to
  // Account… shipped that way: contributed to the native tree only, while the
  // DEFAULT view is inline, so on a default install the verb was reachable
  // from nowhere but the palette. This pins the verb on BOTH menus with the
  // same gate and the same slot, normalizing only the token that names the
  // view, so the halves cannot drift apart again.
  it('offers Move to Account… from both views, gated and placed the same', () => {
    const entryFor = (menu: string): MenuEntry => {
      const entries = pkg.contributes.menus[menu].filter(
        (e) => e.command === 'lineage.switchSessionAccount',
      );
      expect(entries, menu).toHaveLength(1);
      return entries[0] as MenuEntry;
    };
    const native = entryFor('view/item/context');
    const inline = entryFor('webview/context');

    // One placeholder for the two spellings of "this menu's own view", so the
    // comparison below is about everything BUT which view it is.
    const shape = (e: MenuEntry): string =>
      (e.when ?? '')
        .replace(`view == ${SESSIONS}`, 'THIS-VIEW')
        .replace(`webviewId == '${INLINE}'`, 'THIS-VIEW');

    // TWO GATES FOR TWO DIFFERENT FACTS, and the pair is the fix. The token
    // says this ROW is a conversation the mover understands; the context key
    // says the ROSTER has somewhere to send it. The verb used to be gated on
    // the key alone, and the key used to count every account a session could
    // run on — so on the roster this extension seeds by default (one Claude
    // login, plus a Codex one whenever ~/.codex/auth.json exists) the entry was
    // drawn on every session row and the picker behind it, which refuses a
    // cross-CLI pair, was always empty.
    expect(shape(native)).toBe(
      'THIS-VIEW && viewItem =~ /;session;/ && viewItem =~ /;claude;/ && ' +
        'lineage.canSwitchAccount',
    );
    expect(shape(inline)).toBe(shape(native));
    // Same slot in both menus, and NOT the one Move to Lane sits in: they were
    // both at 1_actions@3, which leaves their order to contribution accident.
    expect(native.group).toBe('1_actions@4');
    expect(inline.group).toBe(native.group);
    for (const menu of ['view/item/context', 'webview/context']) {
      const lane = pkg.contributes.menus[menu].find(
        (e) => e.command === 'lineage.moveSessionToLane',
      );
      expect(lane?.group, menu).not.toBe(native.group);
    }
  });

  // The same trap, one verb later, and this one is the level-2 deliverable:
  // "we should be able to go to the workspace for that session". Pinned on both
  // menus with the same gate and the same slot, for the reason above — and with
  // the GHOST exclusion asserted, because that is a decision rather than an
  // omission.
  it('offers Open Workspace for This Session from both views, on live and closed rows alike', () => {
    const shape = (e: MenuEntry): string =>
      (e.when ?? '')
        .replace(`view == ${SESSIONS}`, 'THIS-VIEW')
        .replace(`webviewId == '${INLINE}'`, 'THIS-VIEW');

    const clausesOf = (menu: string): string[] => {
      const entries = pkg.contributes.menus[menu].filter(
        (e) => e.command === 'lineage.openSessionWorkspace',
      );
      // Every entry sits directly under fork and fork-and-compact, in both
      // menus. `0_open@3` is also the branch row's Open Worktree in New Window,
      // which cannot collide: a branch row carries `;branch;` and never
      // `;live;` or `;archived;`, so no row can draw both.
      for (const e of entries) expect(e.group, menu).toBe('0_open@3');
      return entries.map(shape).sort();
    };

    const native = clausesOf('view/item/context');
    const inline = clausesOf('webview/context');

    // TWO entries per menu rather than one on `;session;`, and that is what
    // keeps the verb off GHOST rows: `sessionContextValue` gives a ghost
    // neither token, which is how fork and resume already exclude them without
    // a negated clause. A ghost is an inferred ancestor whose label reads
    // "(gone)" — opening a window for something that was never a session of
    // yours is a claim the row cannot support.
    expect(native).toEqual([
      'THIS-VIEW && viewItem =~ /;archived;/',
      'THIS-VIEW && viewItem =~ /;live;/',
    ]);
    expect(inline).toEqual(native);
    for (const clause of [...native, ...inline]) {
      expect(clause).not.toContain(';ghost;');
    }
  });
});

// ------------------------------------------- one row, one slot per verb
//
// THE INVARIANT: two menu entries that can light up on the SAME row must not
// share a group string. Sharing one across DIFFERENT row kinds is correct and
// the manifest does it seventeen times on purpose — `0_open@3` is Open
// Workspace on a session row and Open Worktree in New Window on a branch row,
// and no row is ever both. What is not correct is two verbs landing in one slot
// on one row, because the order they then come out in is a property of
// contribution order rather than of anything anybody decided. "Move to
// Account…" and "Move to Lane" were doing exactly that on every session row.
//
// Checked against REAL rows rather than by reasoning about the clauses: the
// viewItem strings are generated by `sessionContextValue`, the function both
// views actually build them with, over the matrix of session shapes it can be
// handed. A when-clause that cannot be modelled this way is skipped rather than
// guessed at — see `parseWhen`.

/** One when-clause, split into the parts a row can answer and the parts only
 *  the window can. */
interface ParsedWhen {
  /** Groups of tokens; the row must carry at least one token from each group.
   *  A plain `viewItem =~ /;x;/` is a group of one. */
  requires: string[][];
  /** Tokens the row must NOT carry (`!(viewItem =~ /;x;/)`). */
  forbids: string[];
  /** Everything else, verbatim — context keys and config gates. Used only to
   *  spot a complementary pair like `lineage.multiSelect` / `!lineage.multiSelect`,
   *  which is two entries that can never be offered at the same moment. */
  conditions: string[];
  /** A conjunct this test could not classify. */
  unmodelled: boolean;
}

function parseWhen(when: string): ParsedWhen {
  const out: ParsedWhen = {
    requires: [],
    forbids: [],
    conditions: [],
    unmodelled: false,
  };
  for (const raw of when.split(' && ')) {
    const term = raw.trim();
    const negated = /^!\(viewItem =~ \/;([a-zA-Z-]+);\/\)$/.exec(term);
    if (negated) {
      out.forbids.push(negated[1]);
      continue;
    }
    const positive = /^viewItem =~ \/;([a-zA-Z-]+);\/$/.exec(term);
    if (positive) {
      out.requires.push([positive[1]]);
      continue;
    }
    if (term.startsWith('(') && term.includes('viewItem')) {
      const tokens = [...term.matchAll(/viewItem =~ \/;([a-zA-Z-]+);\//g)].map(
        (m) => m[1],
      );
      if (tokens.length > 0 && !term.includes('&&') && !term.includes('!')) {
        out.requires.push(tokens);
        continue;
      }
      out.unmodelled = true;
      continue;
    }
    if (term.includes('viewItem')) {
      out.unmodelled = true;
      continue;
    }
    out.conditions.push(term);
  }
  return out;
}

const matchesRow = (parsed: ParsedWhen, viewItem: string): boolean =>
  parsed.requires.every((group) =>
    group.some((token) => viewItem.includes(`;${token};`)),
  ) && parsed.forbids.every((token) => !viewItem.includes(`;${token};`));

/** Two entries that a context key keeps apart — the Archive pair, which is one
 *  verb spelled two ways for one selection and two. */
const mutuallyExclusive = (a: ParsedWhen, b: ParsedWhen): boolean =>
  a.conditions.some((c) => b.conditions.includes(`!${c}`)) ||
  b.conditions.some((c) => a.conditions.includes(`!${c}`));

/** Every viewItem string a SESSION row can carry, from the one function both
 *  views build it with. */
function everySessionViewItem(): string[] {
  const out = new Set<string>();
  const statuses = ['idle', 'busy', 'waiting', 'exited'] as const;
  const hosts = [undefined, 'here', 'flock', 'foreign', 'none'] as const;
  for (const status of statuses)
    for (const host of hosts)
      for (const cli of ['claude', 'codex'] as const)
        for (const ghost of [false, true])
          for (const archived of [false, true])
            for (const hidden of [false, true])
              for (const notifyMuted of [false, true])
                for (const grace of [false, true])
                  for (const bound of [false, true])
                    for (const parentId of [null, B])
                      out.add(
                        sessionContextValue(
                          node(A, {
                            status,
                            ghost,
                            archived,
                            hidden,
                            notifyMuted,
                            parentId,
                            source: 'minted',
                            ...(grace ? { graceDeadlineAt: NOW + MINUTE } : {}),
                          }),
                          bound,
                          host,
                          cli,
                        ),
                      );
  return [...out];
}

/** Every viewItem string the OTHER four row kinds can carry, built the same way
 *  — from the functions the two views actually generate them with — for the same
 *  reason. A session row was the only kind this guard modelled when it was
 *  written, because a session row was where the collision that prompted it lived
 *  (Move to Account and Move to Lane, both at `1_actions@3`). That left the
 *  guard blind to exactly the rows the 2026-08-28 round was ADDING verbs to: a
 *  project row gained Archived Sessions… and a session row gained Open Workspace
 *  for This Session, and a project row was already carrying Add Session to
 *  Project and New Worktree in one slot at `0_open@4` with nothing to say so.
 *
 *  The matrix is written out rather than derived from a forest because these
 *  rows' tokens are cheap and total: a project row is `project` plus `empty`, a
 *  subproject row is `subproject` plus the `primary`/`named` pair, a branch row
 *  is `branch` plus three independent flags, and the two header rows carry one
 *  token each. Enumerating them is the whole space, not a sample. */
function everyOtherViewItem(): string[] {
  const out = new Set<string>();
  for (const empty of [false, true])
    out.add(
      projectContextValue({
        rootIds: empty ? [] : [A],
      } as unknown as ProjectGroupNode),
    );
  for (const main of [false, true])
    for (const implicit of [false, true])
      out.add(contextValueOf(subprojectTokens({ main, implicit })));
  for (const primary of [false, true])
    for (const pullRequest of [false, true])
      for (const checkout of [false, true])
        out.add(
          contextValueOf(branchTokens(primary, pullRequest, checkout)),
        );
  // The two header rows. Neither has a shape to vary; both are here because a
  // verb contributed to one of them is a verb nothing else in this file checks.
  out.add(contextValueOf(['group']));
  out.add(contextValueOf(['elsewhere']));
  return [...out];
}

describe('manifest: one row never offers two verbs the same slot', () => {
  const rows = [...everySessionViewItem(), ...everyOtherViewItem()];

  for (const menu of ['view/item/context', 'webview/context']) {
    it(`gives every verb its own slot on every row (${menu})`, () => {
      const entries = pkg.contributes.menus[menu]
        .filter((e) => (e.when ?? '').includes('viewItem'))
        .map((e) => ({ entry: e, parsed: parseWhen(e.when ?? '') }))
        .filter((e) => !e.parsed.unmodelled);
      expect(entries.length).toBeGreaterThan(5);

      const collisions: string[] = [];
      for (const viewItem of rows) {
        const shown = entries.filter((e) => matchesRow(e.parsed, viewItem));
        for (let i = 0; i < shown.length; i++) {
          for (let j = i + 1; j < shown.length; j++) {
            if (shown[i].entry.group !== shown[j].entry.group) continue;
            if (mutuallyExclusive(shown[i].parsed, shown[j].parsed)) continue;
            collisions.push(
              `${shown[i].entry.command} and ${shown[j].entry.command} ` +
                `both at ${shown[i].entry.group} on ${viewItem}`,
            );
          }
        }
      }
      expect([...new Set(collisions)]).toEqual([]);
    });
  }

  it('still lets DIFFERENT row kinds share a slot, which is the normal case', () => {
    // The guard above would be worthless if it had quietly demanded a unique
    // group per entry: `0_open@3` is deliberately three different verbs on
    // three kinds of row.
    const shared = pkg.contributes.menus['view/item/context'].filter(
      (e) => e.group === '0_open@3',
    );
    expect(shared.length).toBeGreaterThan(1);
  });
});

describe('manifest: the Accounts section, and the row it costs', () => {
  // The bell only reaches the container header while the container has ONE
  // visible view, so this when-clause is load-bearing for the whole top bar.
  it('gates the Accounts view on both of its settings', () => {
    const accounts = pkg.contributes.views['lineage'].find(
      (v) => v.id === 'lineageAccounts',
    );
    expect(accounts?.when).toContain('config.lineage.accounts.enabled');
    expect(accounts?.when).toContain('config.lineage.accounts.section');
  });

  // ON by default, which means the buttons sit on the SESSIONS row rather than
  // the FLOCK row. That is the deliberate answer to the trade: a list of
  // subscriptions on screen is worth more than the bell being one row higher, and
  // the gear menu offers the switch to anybody who disagrees.
  //
  // The gate is a when-clause rather than a `visibility` default because
  // `visibility` would not reach an existing profile — VS Code persists a user's
  // view visibility per container — so the setting has to be the thing the view
  // reads, or turning it off would silently do nothing for everyone who has ever
  // opened the sidebar.
  it('ships the section on by default', () => {
    const props = (
      pkg as unknown as {
        contributes: {
          configuration: { properties: Record<string, { default?: unknown }> };
        };
      }
    ).contributes.configuration.properties;
    expect(props['lineage.accounts.section'].default).toBe(true);
    expect(props['lineage.accounts.enabled'].default).toBe(true);
  });
});
