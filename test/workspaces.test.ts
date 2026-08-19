// test/workspaces.test.ts — project workspaces: the pure rules behind saving a
// project's editor layout and restoring it on a switch.
//
// The manager's vscode plumbing (tab capture, closing, vscode.open) can only
// be exercised in a live host; what is unit-tested here is every DECISION:
// which tab belongs to which project, which closes, which parks, which is
// spared for being dirty, and what survives into the persisted snapshot.

import { afterEach, describe, expect, it } from 'vitest';
import * as vscodeMock from 'vscode';

import {
  insideProject,
  layoutFacts,
  layoutIdentities,
  lingerLines,
  planSwitch,
  restorePlan,
  snapshotTabs,
  tabIdentity,
  WorkspaceManager,
  type TabFacts,
  type WorkspaceManagerDeps,
} from '../src/workspaces';
import type {
  EditorialRecord,
  LaunchOptions,
  ProjectRecord,
  WorkspaceSnapshot,
  WorkspaceTabRecord,
} from '../src/types';

const S1 = '0f0000a1-0000-4000-8000-0000000000a1';
const S2 = '0f0000a2-0000-4000-8000-0000000000a2';
/** A project chat — one of ours, project-scoped, in no layout. */
const CHAT = '0f0000c0-0000-4000-8000-0000000000c0';

function fileTab(fsPath: string, over: Partial<TabFacts> = {}): TabFacts {
  return {
    kind: 'file',
    uri: `file://${fsPath}`,
    fsPath,
    viewColumn: 1,
    active: false,
    pinned: false,
    dirty: false,
    label: fsPath.split('/').pop() ?? fsPath,
    ...over,
  };
}

function sessionTab(sessionId: string, over: Partial<TabFacts> = {}): TabFacts {
  return {
    kind: 'session',
    sessionId,
    viewColumn: 1,
    active: false,
    pinned: false,
    dirty: false,
    label: 'claude',
    ...over,
  };
}

function otherTab(over: Partial<TabFacts> = {}): TabFacts {
  return {
    kind: 'other',
    viewColumn: 1,
    active: false,
    pinned: false,
    dirty: false,
    label: 'Simple Browser',
    ...over,
  };
}

describe('workspaces: insideProject', () => {
  it('is boundary-aware containment over any project directory', () => {
    expect(insideProject(['/code/api'], '/code/api/src/x.ts')).toBe(true);
    expect(insideProject(['/code/api'], '/code/api')).toBe(true);
    expect(insideProject(['/code/api'], '/code/apix/y.ts')).toBe(false);
    expect(insideProject(['/a', '/b'], '/b/z')).toBe(true);
    expect(insideProject([], '/b/z')).toBe(false);
    expect(insideProject(['/a'], undefined)).toBe(false);
  });
});

describe('workspaces: planSwitch', () => {
  const cwds = new Map<string, string>([
    [S1, '/code/api/sub'],
    [S2, '/other/place'],
  ]);
  const cwdOf = (id: string): string | undefined => cwds.get(id);

  it('keeps what belongs to the target and closes/parks the rest', () => {
    const tabs = [
      fileTab('/code/api/src/main.ts'),
      fileTab('/somewhere/notes.md'),
      sessionTab(S1),
      sessionTab(S2),
      otherTab(),
    ];
    const plan = planSwitch(tabs, ['/code/api'], cwdOf);
    expect(plan.keep).toEqual([tabs[0], tabs[2]]);
    expect(plan.close).toEqual([tabs[1], tabs[4]]);
    expect(plan.park).toEqual([S2]);
    expect(plan.dirtySkipped).toEqual([]);
  });

  it('never closes a dirty editor — it is kept and reported', () => {
    const dirty = fileTab('/somewhere/wip.ts', { dirty: true });
    const plan = planSwitch([dirty], ['/code/api'], cwdOf);
    expect(plan.keep).toEqual([dirty]);
    expect(plan.close).toEqual([]);
    expect(plan.dirtySkipped).toEqual([dirty]);
  });

  it('no target dirs (leaving workspace mode) keeps everything', () => {
    const tabs = [fileTab('/x/y.ts'), sessionTab(S2), otherTab()];
    const plan = planSwitch(tabs, [], cwdOf);
    expect(plan.keep).toEqual(tabs);
    expect(plan.close).toEqual([]);
    expect(plan.park).toEqual([]);
  });

  it('a session with an unknown cwd is foreign — parked, not guessed', () => {
    const stray = sessionTab('0f0000a3-0000-4000-8000-0000000000a3');
    const plan = planSwitch([stray], ['/code/api'], cwdOf);
    expect(plan.park).toEqual([stray.sessionId]);
  });

  it('a session tab without a session id closes like any other tab', () => {
    const anonymous = sessionTab(S1);
    delete (anonymous as Partial<TabFacts>).sessionId;
    const plan = planSwitch([anonymous], ['/code/api'], cwdOf);
    expect(plan.park).toEqual([]);
    expect(plan.close).toEqual([anonymous]);
  });

  it('never closes a terminal it does not own — that pops the terminate dialog', () => {
    const foreignTerminal = otherTab({ terminal: true, label: 'zsh' });
    const webview = otherTab();
    const plan = planSwitch([foreignTerminal, webview], ['/code/api'], cwdOf);
    expect(plan.keep).toEqual([foreignTerminal]);
    expect(plan.close).toEqual([webview]);
    expect(plan.park).toEqual([]);
  });

  it('records every terminal tab it left alone, so the log can explain it', () => {
    // A terminal tab still on screen after a switch is one of the tabs users
    // call "lingering". It survives on purpose, and the plan is where that
    // purpose gets written down.
    const zsh = otherTab({ terminal: true, label: 'zsh' });
    const ours = otherTab({ terminal: true, label: 'claude' });
    const plan = planSwitch([zsh, ours, otherTab()], ['/code/api'], cwdOf);
    expect(plan.terminalsKept).toEqual([zsh, ours]);
    // Leaving workspace mode closes nothing, and says so with the same list.
    expect(planSwitch([zsh, ours], [], cwdOf).terminalsKept).toEqual([zsh, ours]);
  });

  it('a foreign project CHAT is parked like any other session of ours', () => {
    // REGRESSION. A chat left out of the plan entirely falls through to
    // "a terminal is never closed", and project A's chat then sits in project
    // B's window forever — the exact complaint workspaces exist to answer.
    const chat = sessionTab(CHAT, { chat: true, label: 'Chat · Web' });
    const plan = planSwitch([chat], ['/code/api'], () => '/code/web');
    expect(plan.park).toEqual([CHAT]);
    expect(plan.keep).toEqual([]);
    expect(plan.terminalsKept).toEqual([]);
  });

  it("the TARGET project's own chat is left alone, not parked", () => {
    const chat = sessionTab(CHAT, { chat: true, label: 'Chat · API' });
    const plan = planSwitch([chat], ['/code/api'], () => '/code/api/sub');
    expect(plan.keep).toEqual([chat]);
    expect(plan.park).toEqual([]);
  });

  it('never parks a BUSY foreign session — work in flight outranks tidy', () => {
    // Parking closes the terminal now, so a busy session gets the dirty-editor
    // treatment: kept open and reported, never killed mid-turn.
    const busy = sessionTab(S2, { label: 'claude · working' });
    const idle = sessionTab(S1);
    const plan = planSwitch(
      [busy, idle],
      ['/nowhere'],
      cwdOf,
      (id) => id === S2,
    );
    expect(plan.park).toEqual([S1]);
    expect(plan.keep).toEqual([busy]);
    expect(plan.busyKept).toEqual([busy]);
  });

  it('with no isBusy callback nobody is busy — everything foreign parks', () => {
    const plan = planSwitch([sessionTab(S2)], ['/code/api'], cwdOf);
    expect(plan.park).toEqual([S2]);
    expect(plan.busyKept).toEqual([]);
  });
});

describe('workspaces: layoutFacts', () => {
  it('drops parked sessions from the layout, keeps everything else', () => {
    const own = sessionTab(S1);
    const stashedHere = sessionTab(S2);
    const file = fileTab('/code/api/a.ts');
    const terminal = otherTab({ terminal: true, label: 'zsh' });
    const out = layoutFacts([own, stashedHere, file, terminal], (id) => id === S2);
    // Snapshotting a parked session would make restoring THIS project unstow
    // a foreign session into it.
    expect(out).toEqual([own, file, terminal]);
  });

  it('a session fact without an id is not the parked-filter problem', () => {
    const anonymous = sessionTab(S1);
    delete (anonymous as Partial<TabFacts>).sessionId;
    expect(layoutFacts([anonymous], () => true)).toEqual([anonymous]);
  });

  it('a project chat is in the window but in no layout', () => {
    // REGRESSION. The chat is planned, stowed and unstowed like any other
    // session — this filter, and not an absence from the facts, is the whole
    // of "a chat is not part of a layout".
    const chat = sessionTab(CHAT, { chat: true });
    const own = sessionTab(S1);
    expect(layoutFacts([chat, own], () => false)).toEqual([own]);
  });
});

describe('workspaces: snapshotTabs', () => {
  it('persists files and sessions, drops the unrestorable rest', () => {
    const snap = snapshotTabs([
      fileTab('/code/api/a.ts', { viewColumn: 2, pinned: true }),
      sessionTab(S1, { viewColumn: 1, active: true }),
      otherTab(), // webview: viewType but no URL — cannot be restored
    ]);
    expect(snap).toEqual([
      { kind: 'file', uri: 'file:///code/api/a.ts', viewColumn: 2, pinned: true },
      { kind: 'session', sessionId: S1, viewColumn: 1, active: true },
    ]);
  });

  it('omits false flags rather than writing noise', () => {
    const snap = snapshotTabs([fileTab('/a.ts')]);
    expect(snap[0]).toEqual({ kind: 'file', uri: 'file:///a.ts', viewColumn: 1 });
    expect('active' in snap[0]).toBe(false);
    expect('pinned' in snap[0]).toBe(false);
  });

  it('drops a file record with no uri and a session record with a bad id', () => {
    const noUri = fileTab('/a.ts');
    delete (noUri as Partial<TabFacts>).uri;
    const badSession = sessionTab(S1);
    badSession.sessionId = 'nope';
    expect(snapshotTabs([noUri, badSession])).toEqual([]);
  });

  it('never writes a chat into a snapshot', () => {
    // A snapshot outlives the window, and a chat in one comes back as a
    // `--resume` on some future switch.
    expect(snapshotTabs([sessionTab(CHAT, { chat: true })])).toEqual([]);
  });
});

describe('workspaces: layoutIdentities', () => {
  it('names every file the layout will put back, and nothing else', () => {
    const ids = layoutIdentities([
      { kind: 'file', uri: 'file:///home/me/.zshrc', viewColumn: 1 },
      { kind: 'file', uri: 'untitled:Untitled-1', viewColumn: 1 },
      { kind: 'session', sessionId: S1, viewColumn: 1 },
      { kind: 'file', viewColumn: 2 },
    ]);
    expect([...ids].sort()).toEqual([
      'file|file:///home/me/.zshrc',
      'file|untitled:Untitled-1',
    ]);
  });

  it('speaks the same identity language as tabIdentity', () => {
    // REGRESSION. The spare set and the close set are matched by identity
    // string; the moment the two formulas drift the spare set spares nothing
    // and the verify pass is free to close a restored tab again.
    const open = fileTab('/home/me/.zshrc');
    const saved: WorkspaceTabRecord = {
      kind: 'file',
      uri: open.uri,
      viewColumn: 3,
    };
    expect(layoutIdentities([saved]).has(tabIdentity(open))).toBe(true);
  });

  it("spares a foreign-looking file that is in the target's own layout", () => {
    // REGRESSION. ~/.zshrc lives outside every one of the project's
    // directories, so planSwitch calls it foreign — but it is in the layout the
    // switch is about to restore. Closing it means the user watches it flash,
    // the summary counts it twice, and the verify pass can close it for good.
    const zshrc = fileTab('/home/me/.zshrc');
    const notes = fileTab('/other/notes.md');
    const plan = planSwitch([zshrc, notes], ['/code/api'], () => undefined);
    expect(plan.close).toEqual([zshrc, notes]);

    const spared = layoutIdentities([
      { kind: 'file', uri: zshrc.uri, viewColumn: 1 },
    ]);
    const closeSet = plan.close.filter((t) => !spared.has(tabIdentity(t)));
    expect(closeSet).toEqual([notes]);
  });
});

describe('workspaces: lingerLines', () => {
  it('names each survivor and the reason it survived', () => {
    const dirty = fileTab('/x/wip.ts', { dirty: true });
    const lines = lingerLines([dirty], ['zsh'], ['a1b2']);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('unsaved');
    expect(lines[0]).toContain('wip.ts');
    expect(lines[1]).toContain('terminal');
    expect(lines[1]).toContain('zsh');
    expect(lines[2]).toContain('a1b2');
  });

  it('says nothing when a switch left nothing behind', () => {
    expect(lingerLines([], [], [])).toEqual([]);
  });

  it('gives an unlabelled tab a name rather than an empty gap', () => {
    expect(lingerLines([], [''], [])[0]).toContain('(untitled)');
  });
});

describe('workspaces: tabIdentity', () => {
  it('identifies a file by uri alone, across groups and across a copy', () => {
    const left = fileTab('/code/api/a.ts', { viewColumn: 1 });
    const right = fileTab('/code/api/a.ts', { viewColumn: 2, label: 'a.ts ×' });
    // The same uri open in two groups is foreign in both, so one identity has
    // to re-resolve to both live tabs.
    expect(tabIdentity(left)).toBe(tabIdentity(right));
    expect(tabIdentity({ ...left })).toBe(tabIdentity(left));
  });

  it('survives the label / active / dirty churn a switch causes', () => {
    const before = fileTab('/code/api/a.ts');
    const after = fileTab('/code/api/a.ts', {
      label: 'a.ts (working tree)',
      active: true,
      dirty: true,
      pinned: true,
    });
    expect(tabIdentity(after)).toBe(tabIdentity(before));
  });

  it('separates same-labelled non-file tabs in different groups', () => {
    // A webview exposes a viewType, never a url, so column + label is all
    // there is — and two Simple Browsers side by side must not collapse into
    // one identity or closing the set would only ever close half of it.
    const one = otherTab({ viewColumn: 1 });
    const two = otherTab({ viewColumn: 2 });
    expect(tabIdentity(one)).not.toBe(tabIdentity(two));
    expect(tabIdentity(one)).toBe(tabIdentity(otherTab({ viewColumn: 1 })));
  });

  it('a session fact is identified apart from a file with the same label', () => {
    const session = sessionTab(S1, { label: 'x' });
    const file = otherTab({ label: 'x' });
    expect(tabIdentity(session)).not.toBe(tabIdentity(file));
  });
});

describe('workspaces: restorePlan', () => {
  const file = (
    uri: string,
    viewColumn: number,
    over: Partial<WorkspaceTabRecord> = {},
  ): WorkspaceTabRecord => ({ kind: 'file', uri, viewColumn, ...over });
  const session = (sessionId: string, viewColumn = 1): WorkspaceTabRecord => ({
    kind: 'session',
    sessionId,
    viewColumn,
  });
  const nothingOpen = (): boolean => false;

  it('groups files by ascending column and keeps snapshot order inside one', () => {
    const plan = restorePlan(
      [
        file('file:///b2', 2),
        file('file:///a1', 1),
        file('file:///b1', 2),
        file('file:///a2', 1),
      ],
      nothingOpen,
    );
    expect(plan.files.map((t) => t.uri)).toEqual([
      'file:///a1',
      'file:///a2',
      'file:///b2',
      'file:///b1',
    ]);
  });

  it('puts every session strictly after every file', () => {
    const plan = restorePlan(
      [session(S1), file('file:///a', 1), session(S2), file('file:///b', 1)],
      nothingOpen,
    );
    expect(plan.files.map((t) => t.uri)).toEqual(['file:///a', 'file:///b']);
    expect(plan.sessions.map((t) => t.sessionId)).toEqual([S1, S2]);
  });

  it('reports the active file even when it is already open', () => {
    const plan = restorePlan(
      [file('file:///a', 2, { active: true }), file('file:///b', 1)],
      (uri) => uri === 'file:///a',
    );
    // Dropped from the work list — it is already on screen — but still the
    // thing the switch must put the keyboard on.
    expect(plan.files.map((t) => t.uri)).toEqual(['file:///b']);
    expect(plan.activeUri).toBe('file:///a');
    expect(plan.activeColumn).toBe(2);
  });

  it('has no active file when the layout named none', () => {
    const plan = restorePlan([file('file:///a', 1)], nothingOpen);
    expect(plan.activeUri).toBeUndefined();
    expect('activeUri' in plan).toBe(false);
  });

  it('reports the active SESSION tab, so a restore has somewhere to land', () => {
    // Without this the switch had no focus target at all when the layout was
    // left on a session tab, and ended on whichever session came home last.
    const plan = restorePlan(
      [session(S1), { ...session(S2), active: true }],
      nothingOpen,
    );
    expect(plan.activeSessionId).toBe(S2);
    expect(plan.activeUri).toBeUndefined();
  });

  it('has no active session when the layout named none', () => {
    const plan = restorePlan([session(S1)], nothingOpen);
    expect('activeSessionId' in plan).toBe(false);
  });

  it('drops a file with no uri and a session with a bad id', () => {
    const plan = restorePlan(
      [
        { kind: 'file', viewColumn: 1 },
        { kind: 'session', sessionId: 'nope', viewColumn: 1 },
      ],
      nothingOpen,
    );
    expect(plan.files).toEqual([]);
    expect(plan.sessions).toEqual([]);
  });
});

describe('workspaces: captureTabs honours lineage.terminalLocation', () => {
  function deps(over: Partial<WorkspaceManagerDeps> = {}): WorkspaceManagerDeps {
    return {
      getProject: () => undefined,
      getWorkspace: () => undefined,
      saveWorkspace: async () => {},
      getRecord: () => undefined,
      allRecords: () => ({}),
      upsertRecord: async () => {},
      sessionCwd: () => '/other/place',
      isLive: () => true,
      bindings: () => [
        {
          nodeId: S1,
          sessionId: S1,
          terminalName: 'claude',
          createdAt: 0,
        },
      ],
      refreshBindings: () => {},
      closeSessionTab: () => true,
      isSessionBusy: () => false,
      unstowSessionTab: async () => true,
      activeSessionId: () => null,
      focusSession: () => true,
      launchSession: async () => null,
      hasTranscript: () => true,
      tipOf: (id) => id,
      getActive: () => null,
      setActive: async () => {},
      resumeSessions: () => true,
      refresh: () => {},
      suspendViews: () => {},
      resumeViews: () => {},
      ...over,
    };
  }
  /** captureTabs is private by design — nothing outside the manager should
   *  reach for the live tab model — but the panel guard is a decision, and
   *  decisions are what this suite tests. */
  const capture = (d: WorkspaceManagerDeps): TabFacts[] =>
    (
      new WorkspaceManager(d) as unknown as { captureTabs(): TabFacts[] }
    ).captureTabs();

  it('parks a foreign session when terminals live in the editor area', () => {
    const facts = capture(deps());
    const plan = planSwitch(facts, ['/code/api'], () => '/other/place');
    expect(plan.park).toEqual([S1]);
  });

  it("parks nothing with terminalLocation 'panel' — there is no tab to move", () => {
    // A panel session has no editor tab: parking it would resolve the move
    // against some other terminal, and the switch back would drag it into an
    // editor tab and permanently defeat the setting.
    const facts = capture(deps({ terminalLocation: () => 'panel' }));
    expect(facts).toEqual([]);
    const plan = planSwitch(facts, ['/code/api'], () => '/other/place');
    expect(plan.park).toEqual([]);
  });

  it('captures a chat as a session, flagged — not as an anonymous terminal', () => {
    // REGRESSION. Dropping the chat here is what left its terminal tab to
    // the "a terminal is never closed" branch: project A's chat then stayed on
    // screen in project B, forever.
    const facts = capture(
      deps({
        getRecord: (id) =>
          id === S1
            ? { id, chat: true, createdAt: ISO, updatedAt: ISO }
            : undefined,
      }),
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]?.kind).toBe('session');
    expect(facts[0]?.chat).toBe(true);
  });

  it('reads chat-ness off the chain tip too — a resumed chat is still a chat', () => {
    const facts = capture(
      deps({
        tipOf: () => S2,
        getRecord: (id) =>
          id === S2
            ? { id, chat: true, createdAt: ISO, updatedAt: ISO }
            : undefined,
      }),
    );
    expect(facts[0]?.chat).toBe(true);
  });
});

// ------------------------------------------------- the switch, end to end
// The vscode mock (test/mocks/vscode.ts) ships an empty `window` and
// `commands`. Rather than widen the shared mock, a test hangs stand-ins off
// those already-exported objects for its own duration, exactly as
// test/windows.test.ts does for `env`. That is the only way to reach the
// close -> restore -> verify round trip, and the round trip is where a tab gets
// closed twice.

const ISO = '2026-07-31T00:00:00.000Z';

interface FakeTab {
  label: string;
  isActive: boolean;
  isPinned: boolean;
  isDirty: boolean;
  input: unknown;
}

interface FakeGroup {
  viewColumn: number;
  isActive: boolean;
  tabs: FakeTab[];
}

function fakeFileTab(uri: string): FakeTab {
  return {
    label: uri.split('/').pop() ?? uri,
    isActive: false,
    isPinned: false,
    isDirty: false,
    input: { uri: vscodeMock.Uri.parse(uri) },
  };
}

/** `isTerminalInput` duck-types on a `terminal` key when the host does not
 *  export TabInputTerminal — which the mock does not. */
function fakeTerminalTab(label: string): FakeTab {
  return {
    label,
    isActive: false,
    isPinned: false,
    isDirty: false,
    input: { terminal: {} },
  };
}

function stubTabModel(groups: FakeGroup[], closed: string[]): void {
  (vscodeMock.window as unknown as { tabGroups: unknown }).tabGroups = {
    all: groups,
    close: async (target: FakeTab | FakeTab[]): Promise<boolean> => {
      for (const tab of Array.isArray(target) ? target : [target]) {
        closed.push(tab.label);
        for (const group of groups) {
          const i = group.tabs.indexOf(tab);
          if (i >= 0) group.tabs.splice(i, 1);
        }
      }
      return true;
    },
  };
}

function stubOpen(groups: FakeGroup[], opened: string[]): void {
  (vscodeMock.commands as unknown as { executeCommand: unknown }).executeCommand =
    async (
      command: string,
      uri: { toString(): string },
      opts?: { viewColumn?: number },
    ): Promise<void> => {
      if (command !== 'vscode.open') return;
      opened.push(uri.toString());
      const column = opts?.viewColumn ?? 1;
      const group = groups.find((g) => g.viewColumn === column) ?? groups[0];
      group?.tabs.push(fakeFileTab(uri.toString()));
    };
}

/** Drop one terminal tab, the way the workbench does when a park disposes a
 *  terminal editor — the stand-in keeps the fake tab model honest about what
 *  is still on screen. */
function closeOneTerminalTab(groups: FakeGroup[]): void {
  for (const group of groups) {
    const i = group.tabs.findIndex(
      (t) => (t.input as { terminal?: unknown }).terminal !== undefined,
    );
    if (i >= 0) {
      group.tabs.splice(i, 1);
      return;
    }
  }
}

function project(
  id: string,
  name: string,
  rootDir: string,
  over: Partial<ProjectRecord> = {},
): ProjectRecord {
  return { id, name, rootDir, dirs: [], createdAt: ISO, updatedAt: ISO, ...over };
}

function record(id: string, over: Partial<EditorialRecord> = {}): EditorialRecord {
  return { id, createdAt: ISO, updatedAt: ISO, ...over };
}

interface Calls {
  saved: Array<{ projectId: string; tabs: WorkspaceTabRecord[] }>;
  written: Array<{ id: string; patch: Partial<EditorialRecord> }>;
  killed: string[];
  unstowed: string[];
  launched: string[];
  /** Every session the switch put the keyboard on, in order. There should
   *  never be more than one: the focus decision is made once, at the end. */
  focused: string[];
}

function harness(over: Partial<WorkspaceManagerDeps> = {}): {
  deps: WorkspaceManagerDeps;
  calls: Calls;
} {
  const calls: Calls = {
    saved: [],
    written: [],
    killed: [],
    unstowed: [],
    launched: [],
    focused: [],
  };
  const deps: WorkspaceManagerDeps = {
    getProject: () => undefined,
    getWorkspace: () => undefined,
    saveWorkspace: async (projectId, tabs) => {
      calls.saved.push({ projectId, tabs });
    },
    getRecord: () => undefined,
    allRecords: () => ({}),
    upsertRecord: async (id, patch) => {
      calls.written.push({ id, patch });
    },
    sessionCwd: () => undefined,
    isLive: () => true,
    bindings: () => [],
    refreshBindings: () => {},
    closeSessionTab: (id) => {
      calls.killed.push(id);
      return true;
    },
    isSessionBusy: () => false,
    unstowSessionTab: async (id) => {
      calls.unstowed.push(id);
      return true;
    },
    activeSessionId: () => null,
    focusSession: (id) => {
      calls.focused.push(id);
      return true;
    },
    launchSession: async (opts) => {
      calls.launched.push(opts.sessionId);
      return null;
    },
    hasTranscript: () => true,
    tipOf: (id) => id,
    getActive: () => null,
    setActive: async () => {},
    resumeSessions: () => true,
    refresh: () => {},
    suspendViews: () => {},
    resumeViews: () => {},
    ...over,
  };
  return { deps, calls };
}

const API = project('pa', 'API', '/code/api');
const WEB = project('pw', 'Web', '/code/web');
const twoProjects = (id: string): ProjectRecord | undefined =>
  id === 'pa' ? API : id === 'pw' ? WEB : undefined;

afterEach(() => {
  delete (vscodeMock.window as unknown as { tabGroups?: unknown }).tabGroups;
  delete (vscodeMock.commands as unknown as { executeCommand?: unknown })
    .executeCommand;
});

describe('workspaces: a switch never undoes its own restore', () => {
  it("keeps a foreign-looking file that is in the target's saved layout", async () => {
    // REGRESSION. ~/.zshrc sits outside every one of the project's
    // directories but is part of its layout. It used to be closed by the plan,
    // reopened by the restore, and closed AGAIN by the verify pass — the user
    // watched it flash, the summary counted it twice, and the restored layout
    // silently lost it.
    const groups: FakeGroup[] = [
      {
        viewColumn: 1,
        isActive: true,
        tabs: [
          fakeFileTab('file:///home/me/.zshrc'),
          fakeFileTab('file:///other/notes.md'),
        ],
      },
    ];
    const closed: string[] = [];
    const opened: string[] = [];
    stubTabModel(groups, closed);
    stubOpen(groups, opened);

    const snapshot: WorkspaceSnapshot = {
      projectId: 'pa',
      tabs: [{ kind: 'file', uri: 'file:///home/me/.zshrc', viewColumn: 1 }],
      savedAt: ISO,
      updatedAt: ISO,
    };
    const { deps } = harness({
      getProject: twoProjects,
      getWorkspace: (id) => (id === 'pa' ? snapshot : undefined),
      getActive: () => 'pw',
    });

    await new WorkspaceManager(deps).switchTo('pa');

    // Closed once, and only the tab no layout wanted.
    expect(closed).toEqual(['notes.md']);
    // Never reopened, because it was never closed.
    expect(opened).toEqual([]);
    expect(groups[0]?.tabs.map((t) => t.label)).toEqual(['.zshrc']);
  });

  it('an untitled scratch tab in the layout survives the same way', async () => {
    // An untitled tab has no fsPath at all, so containment calls it foreign
    // every time — and it is snapshotted like any other file tab.
    const groups: FakeGroup[] = [
      { viewColumn: 1, isActive: true, tabs: [fakeFileTab('untitled:Untitled-1')] },
    ];
    const closed: string[] = [];
    const opened: string[] = [];
    stubTabModel(groups, closed);
    stubOpen(groups, opened);

    const snapshot: WorkspaceSnapshot = {
      projectId: 'pa',
      tabs: [{ kind: 'file', uri: 'untitled:Untitled-1', viewColumn: 1 }],
      savedAt: ISO,
      updatedAt: ISO,
    };
    const { deps } = harness({
      getProject: twoProjects,
      getWorkspace: (id) => (id === 'pa' ? snapshot : undefined),
      getActive: () => 'pw',
    });

    await new WorkspaceManager(deps).switchTo('pa');

    expect(closed).toEqual([]);
    expect(opened).toEqual([]);
    expect(groups[0]?.tabs).toHaveLength(1);
  });
});

describe('workspaces: a project chat travels with its project', () => {
  const binding = (sessionId: string, terminalName: string) => ({
    nodeId: sessionId,
    sessionId,
    terminalName,
    createdAt: 0,
  });

  it('parks the chat of the project being left, and snapshots it nowhere', async () => {
    // REGRESSION. A chat that is not planned as a session falls through to
    // "a terminal we do not own is never closed", so project A's chat stayed
    // visible in project B's workspace forever.
    const groups: FakeGroup[] = [
      {
        viewColumn: 1,
        isActive: true,
        tabs: [fakeTerminalTab('Chat · API'), fakeTerminalTab('claude')],
      },
    ];
    stubTabModel(groups, []);

    const records: Record<string, EditorialRecord> = {
      [CHAT]: record(CHAT, { chat: true, cwd: '/code/api' }),
    };
    // The stand-in closes the tab the way a real dispose does, keeping the
    // fake tab model honest about what is still on screen.
    const killed: string[] = [];
    const { deps, calls } = harness({
      getProject: twoProjects,
      getActive: () => 'pa',
      getRecord: (id) => records[id],
      bindings: () => [binding(CHAT, 'Chat · API'), binding(S1, 'claude')],
      sessionCwd: () => '/code/api',
      closeSessionTab: (id) => {
        killed.push(id);
        closeOneTerminalTab(groups);
        return true;
      },
    });

    await new WorkspaceManager(deps).switchTo('pw');

    // It leaves with its project, like every other session of ours.
    expect(killed).toEqual([CHAT, S1]);
    expect(
      calls.written
        .filter((w) => w.patch.parked === true)
        .map((w) => w.id)
        .sort(),
    ).toEqual([CHAT, S1].sort());
    expect(groups[0]?.tabs).toEqual([]);
    // …but it is part of no layout, so the snapshot names the session only.
    expect(calls.saved.find((s) => s.projectId === 'pa')?.tabs).toEqual([
      { kind: 'session', sessionId: S1, viewColumn: 1 },
    ]);
  });

  it('moves a legacy panel-parked chat home on the way back', async () => {
    // An older build parked by stowing into the terminal panel, so a chat can
    // be parked AND still live. That one is moved home, never duplicated.
    //
    // Found by scanning the RECORDS for parked chats in the project's
    // directories, not by reading one id off the project — a project has as
    // many chats as you have opened.
    const records: Record<string, EditorialRecord> = {
      [CHAT]: record(CHAT, { chat: true, parked: true, cwd: '/code/api' }),
    };
    const { deps, calls } = harness({
      getProject: twoProjects,
      getActive: () => 'pw',
      getRecord: (id) => records[id],
      allRecords: () => records,
      sessionCwd: () => '/code/api',
    });

    await new WorkspaceManager(deps).switchTo('pa');

    expect(calls.unstowed).toEqual([CHAT]);
    expect(calls.launched).toEqual([]);
    expect(calls.written).toContainEqual({
      id: CHAT,
      patch: { parked: false, tmux: null },
    });
  });

  it('resumes the chat a switch parked — only a USER-closed chat stays dead', async () => {
    // Parking closes the terminal now, so the chat the switch put away is dead
    // by construction and coming home means `--resume`. The `parked` gate is
    // what keeps the old rule's substance: a chat the user closed was never
    // parked, so no switch ever revives it.
    const records: Record<string, EditorialRecord> = {
      [CHAT]: record(CHAT, { chat: true, parked: true, cwd: '/code/api' }),
    };
    const { deps, calls } = harness({
      getProject: twoProjects,
      getActive: () => 'pw',
      getRecord: (id) => records[id],
      allRecords: () => records,
      sessionCwd: () => '/code/api',
      isLive: () => false,
      hasTranscript: () => true,
      resumeSessions: () => true,
      launchSession: async (opts) => {
        calls.launched.push(opts.sessionId);
        return {
          nodeId: opts.sessionId,
          sessionId: opts.sessionId,
          terminalName: 'chat',
          createdAt: 0,
        };
      },
    });

    await new WorkspaceManager(deps).switchTo('pa');

    expect(calls.launched).toEqual([CHAT]);
    expect(calls.unstowed).toEqual([]);
    expect(calls.written).toContainEqual({
      id: CHAT,
      patch: { parked: false, tmux: null },
    });
  });

  it('a user-closed chat (never parked) is not revived by a switch', async () => {
    const withChat = project('pa', 'API', '/code/api', { chatSessionId: CHAT });
    const records: Record<string, EditorialRecord> = {
      [CHAT]: record(CHAT, { chat: true, cwd: '/code/api' }),
    };
    const { deps, calls } = harness({
      getProject: (id) => (id === 'pa' ? withChat : id === 'pw' ? WEB : undefined),
      getActive: () => 'pw',
      getRecord: (id) => records[id],
      sessionCwd: () => '/code/api',
      isLive: () => false,
    });

    await new WorkspaceManager(deps).switchTo('pa');

    expect(calls.launched).toEqual([]);
    expect(calls.unstowed).toEqual([]);
  });
});

describe('workspaces: parking closes, never the panel', () => {
  const binding = (sessionId: string, terminalName: string) => ({
    nodeId: sessionId,
    sessionId,
    terminalName,
    createdAt: 0,
  });

  it('kills idle foreign sessions, keeps busy ones open, and reports both', async () => {
    const groups: FakeGroup[] = [
      {
        viewColumn: 1,
        isActive: true,
        tabs: [fakeTerminalTab('claude · idle'), fakeTerminalTab('claude · busy')],
      },
    ];
    stubTabModel(groups, []);

    const killed: string[] = [];
    const { deps, calls } = harness({
      getProject: twoProjects,
      getActive: () => 'pa',
      bindings: () => [binding(S1, 'claude · idle'), binding(S2, 'claude · busy')],
      sessionCwd: () => '/code/api',
      isSessionBusy: (id) => id === S2,
      closeSessionTab: (id) => {
        killed.push(id);
        closeOneTerminalTab(groups);
        return true;
      },
    });

    await new WorkspaceManager(deps).switchTo('pw');

    expect(killed).toEqual([S1]);
    expect(
      calls.written.filter((w) => w.patch.parked === true).map((w) => w.id),
    ).toEqual([S1]);
    // The busy session's tab is still on screen — never killed mid-turn.
    expect(groups[0]?.tabs.map((t) => t.label)).toEqual(['claude · busy']);
  });

  it('a failed dispose never writes `parked` — the flag stays honest', async () => {
    const groups: FakeGroup[] = [
      { viewColumn: 1, isActive: true, tabs: [fakeTerminalTab('claude')] },
    ];
    stubTabModel(groups, []);
    const { deps, calls } = harness({
      getProject: twoProjects,
      getActive: () => 'pa',
      bindings: () => [binding(S1, 'claude')],
      sessionCwd: () => '/code/api',
      closeSessionTab: () => false,
    });

    await new WorkspaceManager(deps).switchTo('pw');

    expect(calls.written.filter((w) => w.patch.parked === true)).toEqual([]);
  });

  it('parks nothing when resumeSessions is off — a park could not come back', async () => {
    const groups: FakeGroup[] = [
      { viewColumn: 1, isActive: true, tabs: [fakeTerminalTab('claude')] },
    ];
    stubTabModel(groups, []);
    const killed: string[] = [];
    const { deps, calls } = harness({
      getProject: twoProjects,
      getActive: () => 'pa',
      bindings: () => [binding(S1, 'claude')],
      sessionCwd: () => '/code/api',
      resumeSessions: () => false,
      closeSessionTab: (id) => {
        killed.push(id);
        return true;
      },
    });

    await new WorkspaceManager(deps).switchTo('pw');

    expect(killed).toEqual([]);
    expect(calls.written.filter((w) => w.patch.parked === true)).toEqual([]);
    expect(groups[0]?.tabs).toHaveLength(1);
  });

  it('a rapid switch-back resumes what THIS window just killed, despite a stale roster', async () => {
    // The roster keeps listing a disposed process for a tick or two. Without
    // the recently-killed override, the switch back would read the stale row
    // as "running in another window", restore nothing, and strand the session
    // parked with its flag set.
    const records: Record<string, EditorialRecord> = {};
    const snapshot: WorkspaceSnapshot = {
      projectId: 'pa',
      tabs: [{ kind: 'session', sessionId: S1, viewColumn: 1 }],
      savedAt: ISO,
      updatedAt: ISO,
    };
    const groups: FakeGroup[] = [
      { viewColumn: 1, isActive: true, tabs: [fakeTerminalTab('claude')] },
    ];
    stubTabModel(groups, []);

    let active: string | null = 'pa';
    // The registry, honestly: a park DISPOSES the terminal, so it stops
    // listing the session — and the restore refuses to launch a session that
    // still has a terminal here, because that would be a second process on one
    // transcript.
    const bound = new Set([S1]);
    const { deps, calls } = harness({
      getProject: twoProjects,
      getWorkspace: (id) => (id === 'pa' ? snapshot : undefined),
      getActive: () => active,
      setActive: async (id) => {
        active = id;
      },
      getRecord: (id) => records[id],
      upsertRecord: async (id, patch) => {
        records[id] = { ...(records[id] ?? record(id)), ...patch };
        calls.written.push({ id, patch });
      },
      bindings: () => [...bound].map((id) => binding(id, 'claude')),
      sessionCwd: () => '/code/api',
      // The roster never notices the kill inside this test — the stale case.
      isLive: () => true,
      hasTranscript: () => true,
      closeSessionTab: (id) => {
        calls.killed.push(id);
        bound.delete(id);
        closeOneTerminalTab(groups);
        return true;
      },
      // The terminal is gone, so a legacy unstow could never succeed here.
      unstowSessionTab: async () => false,
      launchSession: async (opts) => {
        calls.launched.push(opts.sessionId);
        bound.add(opts.sessionId);
        return {
          nodeId: opts.sessionId,
          sessionId: opts.sessionId,
          terminalName: 'claude',
          createdAt: 0,
        };
      },
    });

    const manager = new WorkspaceManager(deps);
    await manager.switchTo('pw');
    expect(calls.killed).toEqual([S1]);
    expect(records[S1]?.parked).toBe(true);

    await manager.switchTo('pa');
    // The stale "live" row did not stop the resume, and no legacy unstow was
    // attempted against a terminal that no longer exists.
    expect(calls.launched).toEqual([S1]);
    expect(calls.unstowed).toEqual([]);
    expect(records[S1]?.parked).toBe(false);
  });
});

describe('workspaces: a session that never took a turn still comes home', () => {
  const binding = (sessionId: string, terminalName: string) => ({
    nodeId: sessionId,
    sessionId,
    terminalName,
    createdAt: 0,
  });

  /** Park S1 on the way out of 'pa', switch back, and report how it relaunched.
   *  `parentId` is the recorded edge — set it to make S1 an unstarted FORK. */
  async function roundTrip(over: { parentId?: string } = {}): Promise<{
    launched: LaunchOptions[];
    records: Record<string, EditorialRecord>;
  }> {
    const records: Record<string, EditorialRecord> = {
      [S1]: {
        ...record(S1),
        ...(over.parentId === undefined ? {} : { parentId: over.parentId }),
      },
    };
    const snapshot: WorkspaceSnapshot = {
      projectId: 'pa',
      tabs: [{ kind: 'session', sessionId: S1, viewColumn: 1 }],
      savedAt: ISO,
      updatedAt: ISO,
    };
    const groups: FakeGroup[] = [
      { viewColumn: 1, isActive: true, tabs: [fakeTerminalTab('claude')] },
    ];
    stubTabModel(groups, []);

    let active: string | null = 'pa';
    const launched: LaunchOptions[] = [];
    const bound = new Set([S1]);
    const { deps, calls } = harness({
      getProject: twoProjects,
      getWorkspace: (id) => (id === 'pa' ? snapshot : undefined),
      getActive: () => active,
      setActive: async (id) => {
        active = id;
      },
      getRecord: (id) => records[id],
      upsertRecord: async (id, patch) => {
        records[id] = { ...(records[id] ?? record(id)), ...patch };
        calls.written.push({ id, patch });
      },
      bindings: () => [...bound].map((id) => binding(id, 'claude')),
      sessionCwd: () => '/code/api',
      isLive: () => false,
      // The whole point: claude never wrote one.
      hasTranscript: () => false,
      closeSessionTab: (id) => {
        calls.killed.push(id);
        bound.delete(id);
        closeOneTerminalTab(groups);
        return true;
      },
      unstowSessionTab: async () => false,
      launchSession: async (opts) => {
        launched.push(opts);
        bound.add(opts.sessionId);
        return {
          nodeId: opts.sessionId,
          sessionId: opts.sessionId,
          terminalName: 'claude',
          createdAt: 0,
        };
      },
    });

    const manager = new WorkspaceManager(deps);
    await manager.switchTo('pw');
    await manager.switchTo('pa');
    return { launched, records };
  }

  it('starts it fresh instead of skipping it', async () => {
    // REGRESSION. A session created and not yet written in was parked on the
    // way out and silently dropped on the way back — no tab, and a record
    // still claiming `parked`, which is a row the switch could never restore
    // again.
    const { launched, records } = await roundTrip();
    expect(launched.map((l) => l.sessionId)).toEqual([S1]);
    // `--session-id <id>`, no `--resume`: there is no transcript to name.
    expect(launched[0]?.resumeId).toBeUndefined();
    expect(records[S1]?.parked).toBe(false);
  });

  it('leaves an unstarted FORK for its own click', async () => {
    // A branch that never took a turn is displaying its ancestor's history,
    // and only a replay brings that back. Starting it blank here would spend
    // the id on an empty conversation and lose the branch — so the bulk
    // restore declines and `resumeFlow`, which knows how to walk to the
    // ancestor, does it properly when the row is clicked.
    const { launched } = await roundTrip({ parentId: S2 });
    expect(launched).toEqual([]);
  });
});

describe('workspaces: the detach tier (tmux)', () => {
  const binding = (sessionId: string, terminalName: string) => ({
    nodeId: sessionId,
    sessionId,
    terminalName,
    createdAt: 0,
  });
  const TMUX_S1 = `lineage-${S1}`;

  it('a busy tmux-backed session detaches; a busy bare one keeps its tab', async () => {
    // The busy carve-out exists because a KILL aborts the turn. A detach
    // interrupts nothing — the process keeps running, hidden — so tmux-backed
    // sessions park busy or not, and only the bare one is spared.
    const groups: FakeGroup[] = [
      {
        viewColumn: 1,
        isActive: true,
        tabs: [fakeTerminalTab('claude · tmux'), fakeTerminalTab('claude · bare')],
      },
    ];
    stubTabModel(groups, []);

    const { deps, calls } = harness({
      getProject: twoProjects,
      getActive: () => 'pa',
      bindings: () => [binding(S1, 'claude · tmux'), binding(S2, 'claude · bare')],
      sessionCwd: () => '/code/api',
      isSessionBusy: () => true,
      tmuxNameOf: (id) => (id === S1 ? TMUX_S1 : undefined),
      closeSessionTab: (id) => {
        calls.killed.push(id);
        closeOneTerminalTab(groups);
        return true;
      },
    });

    await new WorkspaceManager(deps).switchTo('pw');

    expect(calls.killed).toEqual([S1]);
    expect(
      calls.written.filter((w) => w.patch.parked === true).map((w) => w.id),
    ).toEqual([S1]);
    // The bare busy session's tab is still on screen — never killed mid-turn.
    expect(groups[0]?.tabs.map((t) => t.label)).toEqual(['claude · bare']);
  });

  it('a detach park records the tmux name; a kill park erases it', async () => {
    // The name IS the tier decision at restore time: with it, re-attach;
    // without it, `--resume`. A kill writing `tmux: null` is what stops a
    // stale name from an earlier detach outliving a park that really killed.
    const groups: FakeGroup[] = [
      {
        viewColumn: 1,
        isActive: true,
        tabs: [fakeTerminalTab('claude · tmux'), fakeTerminalTab('claude · bare')],
      },
    ];
    stubTabModel(groups, []);

    const { deps, calls } = harness({
      getProject: twoProjects,
      getActive: () => 'pa',
      bindings: () => [binding(S1, 'claude · tmux'), binding(S2, 'claude · bare')],
      sessionCwd: () => '/code/api',
      tmuxNameOf: (id) => (id === S1 ? TMUX_S1 : undefined),
      closeSessionTab: (id) => {
        calls.killed.push(id);
        closeOneTerminalTab(groups);
        return true;
      },
    });

    await new WorkspaceManager(deps).switchTo('pw');

    const parks = calls.written.filter((w) => w.patch.parked === true);
    expect(parks).toContainEqual({
      id: S1,
      patch: { parked: true, tmux: TMUX_S1 },
    });
    expect(parks).toContainEqual({ id: S2, patch: { parked: true, tmux: null } });
  });

  it('switch-back reattaches — the roster row is LIVE and blocks nothing', async () => {
    // In the kill tier a live roster row means "running somewhere else: never
    // launch". A detached session is live BY DESIGN, and the recorded name
    // routes the launch to `new-session -A`, which attaches to that very
    // process — so live must not gate this path, and no unstow is attempted.
    const records: Record<string, EditorialRecord> = {};
    const snapshot: WorkspaceSnapshot = {
      projectId: 'pa',
      tabs: [{ kind: 'session', sessionId: S1, viewColumn: 1 }],
      savedAt: ISO,
      updatedAt: ISO,
    };
    const groups: FakeGroup[] = [
      { viewColumn: 1, isActive: true, tabs: [fakeTerminalTab('claude')] },
    ];
    stubTabModel(groups, []);

    let active: string | null = 'pa';
    const launchedWith: Array<{ sessionId: string; tmuxName?: string }> = [];
    // A detach park disposes the terminal too — only the tmux server keeps the
    // process. So the registry stops listing the session, which is what lets
    // the restore re-attach: a session that still has a terminal here is one
    // the restore leaves alone rather than opening a second client onto.
    const bound = new Set([S1]);
    const { deps, calls } = harness({
      getProject: twoProjects,
      getWorkspace: (id) => (id === 'pa' ? snapshot : undefined),
      getActive: () => active,
      setActive: async (id) => {
        active = id;
      },
      getRecord: (id) => records[id],
      upsertRecord: async (id, patch) => {
        records[id] = { ...(records[id] ?? record(id)), ...patch };
        calls.written.push({ id, patch });
      },
      bindings: () => [...bound].map((id) => binding(id, 'claude')),
      sessionCwd: () => '/code/api',
      isLive: () => true, // the detached process really is running
      hasTranscript: () => true,
      tmuxNameOf: (id) => (id === S1 ? TMUX_S1 : undefined),
      closeSessionTab: (id) => {
        calls.killed.push(id);
        bound.delete(id);
        closeOneTerminalTab(groups);
        return true;
      },
      unstowSessionTab: async (id) => {
        calls.unstowed.push(id);
        return false;
      },
      launchSession: async (opts) => {
        launchedWith.push({
          sessionId: opts.sessionId,
          ...(opts.tmuxName !== undefined ? { tmuxName: opts.tmuxName } : {}),
        });
        bound.add(opts.sessionId);
        return {
          nodeId: opts.sessionId,
          sessionId: opts.sessionId,
          terminalName: 'claude',
          createdAt: 0,
          ...(opts.tmuxName !== undefined ? { tmuxName: opts.tmuxName } : {}),
        };
      },
    });

    const manager = new WorkspaceManager(deps);
    await manager.switchTo('pw');
    expect(records[S1]?.parked).toBe(true);
    expect(records[S1]?.tmux).toBe(TMUX_S1);

    await manager.switchTo('pa');
    expect(calls.unstowed).toEqual([]);
    expect(launchedWith).toEqual([{ sessionId: S1, tmuxName: TMUX_S1 }]);
    expect(records[S1]?.parked).toBe(false);
    expect(records[S1]?.tmux).toBeNull();
  });

  it('with resumeSessions off a tmux-backed session is not parked either', async () => {
    // A detach could hide a session that then DIES while hidden, and bringing
    // it back would be the very resume the setting forbids — so the honest
    // degradation is the same as the kill tier's: the tab stays open.
    const groups: FakeGroup[] = [
      { viewColumn: 1, isActive: true, tabs: [fakeTerminalTab('claude')] },
    ];
    stubTabModel(groups, []);
    const { deps, calls } = harness({
      getProject: twoProjects,
      getActive: () => 'pa',
      bindings: () => [binding(S1, 'claude')],
      sessionCwd: () => '/code/api',
      resumeSessions: () => false,
      tmuxNameOf: () => TMUX_S1,
      closeSessionTab: (id) => {
        calls.killed.push(id);
        return true;
      },
    });

    await new WorkspaceManager(deps).switchTo('pw');

    expect(calls.killed).toEqual([]);
    expect(calls.written.filter((w) => w.patch.parked === true)).toEqual([]);
    expect(groups[0]?.tabs).toHaveLength(1);
  });
});

describe('workspaces: the Explorer follows the switch', () => {
  it('hands the TARGET project to the Explorer, before the restore reopens a thing', async () => {
    const groups: FakeGroup[] = [{ viewColumn: 1, isActive: true, tabs: [] }];
    const opened: string[] = [];
    stubTabModel(groups, []);
    stubOpen(groups, opened);

    const seen: Array<string | null> = [];
    let openedWhenExplorerMoved = -1;
    const snapshot: WorkspaceSnapshot = {
      projectId: 'pw',
      tabs: [{ kind: 'file', uri: 'file:///code/web/index.ts', viewColumn: 1 }],
      savedAt: ISO,
      updatedAt: ISO,
    };
    const { deps } = harness({
      getProject: twoProjects,
      getWorkspace: (id) => (id === 'pw' ? snapshot : undefined),
      getActive: () => 'pa',
      syncExplorer: async (project) => {
        seen.push(project?.id ?? null);
        openedWhenExplorerMoved = opened.length;
      },
    });

    await new WorkspaceManager(deps).switchTo('pw');

    expect(seen).toEqual(['pw']);
    // The Explorer moved while nothing had been reopened yet, so the restored
    // files land in a folder tree that ALREADY shows the target project —
    // rather than reading as "outside the workspace" until it catches up.
    expect(openedWhenExplorerMoved).toBe(0);
    expect(opened).toEqual(['file:///code/web/index.ts']);
  });

  it('leaves the Explorer alone when leaving workspace mode — that door costs nothing', async () => {
    const seen: Array<string | null> = [];
    stubTabModel([], []);
    const { deps } = harness({
      getProject: twoProjects,
      getActive: () => 'pa',
      syncExplorer: async (project) => {
        seen.push(project?.id ?? null);
      },
    });

    await new WorkspaceManager(deps).switchTo(null);

    expect(seen).toEqual([]);
  });

  it('completes the switch when the Explorer refuses to move', async () => {
    // The tabs are the workspace; the Explorer is a view of it. A folder tree
    // that would not splice must not strand a half-switched window.
    const groups: FakeGroup[] = [
      { viewColumn: 1, isActive: true, tabs: [fakeFileTab('file:///code/api/a.ts')] },
    ];
    const closed: string[] = [];
    stubTabModel(groups, closed);
    stubOpen(groups, []);
    const { deps } = harness({
      getProject: twoProjects,
      getActive: () => 'pa',
      syncExplorer: async () => {
        throw new Error('the workbench said no');
      },
    });

    await new WorkspaceManager(deps).switchTo('pw');

    expect(closed).toEqual(['a.ts']);
  });

  it('is optional — a wiring without it switches exactly as before', async () => {
    stubTabModel([], []);
    const { deps } = harness({ getProject: twoProjects, getActive: () => 'pa' });
    await expect(
      new WorkspaceManager(deps).switchTo('pw'),
    ).resolves.toBeUndefined();
  });
});

describe('workspaces: a switch ends on the tab you asked for', () => {
  const binding = (sessionId: string, terminalName: string) => ({
    nodeId: sessionId,
    sessionId,
    terminalName,
    createdAt: 0,
  });
  const parkedIn = (dir: string) => ({ parked: true, cwd: dir });
  const resumes = (calls: Calls): WorkspaceManagerDeps['launchSession'] =>
    async (opts) => {
      calls.launched.push(opts.sessionId);
      return {
        nodeId: opts.sessionId,
        sessionId: opts.sessionId,
        terminalName: 'claude',
        createdAt: 0,
      };
    };

  it('an auto switch ends on the session that TRIGGERED it', async () => {
    // THE BUG. Clicking a session of another project resumes it, which triggers
    // the auto switch, whose restore then brings its siblings home — and
    // revealing a terminal takes the front of its editor group whatever
    // preserveFocus says. So the click landed you on a sibling tab, and only a
    // second click (with the workspace already switched) went where you asked.
    const records: Record<string, EditorialRecord> = {
      [S1]: record(S1, parkedIn('/code/api')),
      [S2]: record(S2, parkedIn('/code/api')),
    };
    const snapshot: WorkspaceSnapshot = {
      projectId: 'pa',
      tabs: [
        { kind: 'session', sessionId: S1, viewColumn: 1 },
        { kind: 'session', sessionId: S2, viewColumn: 1 },
      ],
      savedAt: ISO,
      updatedAt: ISO,
    };
    stubTabModel([{ viewColumn: 1, isActive: true, tabs: [] }], []);

    const { deps, calls } = harness({
      getProject: twoProjects,
      getWorkspace: (id) => (id === 'pa' ? snapshot : undefined),
      getActive: () => 'pw',
      getRecord: (id) => records[id],
      allRecords: () => records,
      sessionCwd: () => '/code/api',
      isLive: () => false,
      hasTranscript: () => true,
    });
    deps.launchSession = resumes(calls);

    await new WorkspaceManager(deps).switchTo('pa', {
      auto: true,
      focusSessionId: S1,
    });

    // Both sessions came home...
    expect(calls.launched).toEqual([S1, S2]);
    // ...and the keyboard ends on the one that was clicked, not on whichever
    // restore finished last.
    expect(calls.focused).toEqual([S1]);
  });

  it('a manual switch ends on the session tab its layout was left on', async () => {
    // Same defect through the other door: the status-bar switcher. The layout
    // knows which tab had the keyboard, and when that tab was a session the
    // switch used to drop the target and land on a race winner.
    const records: Record<string, EditorialRecord> = {
      [S1]: record(S1, parkedIn('/code/api')),
      [S2]: record(S2, parkedIn('/code/api')),
    };
    const snapshot: WorkspaceSnapshot = {
      projectId: 'pa',
      tabs: [
        { kind: 'session', sessionId: S1, viewColumn: 1 },
        { kind: 'session', sessionId: S2, viewColumn: 1, active: true },
      ],
      savedAt: ISO,
      updatedAt: ISO,
    };
    stubTabModel([{ viewColumn: 1, isActive: true, tabs: [] }], []);

    const { deps, calls } = harness({
      getProject: twoProjects,
      getWorkspace: (id) => (id === 'pa' ? snapshot : undefined),
      getActive: () => 'pw',
      getRecord: (id) => records[id],
      allRecords: () => records,
      sessionCwd: () => '/code/api',
      isLive: () => false,
      hasTranscript: () => true,
    });
    deps.launchSession = resumes(calls);

    await new WorkspaceManager(deps).switchTo('pa');

    expect(calls.focused).toEqual([S2]);
  });

  it('saves WHICH session tab had the keyboard, for that way back', async () => {
    // The tab API cannot link a terminal tab to its Terminal, so this is
    // triangulated: the active tab is a terminal tab, and the workbench's
    // active terminal is one of ours.
    const front = fakeTerminalTab('claude · progress');
    front.isActive = true;
    const groups: FakeGroup[] = [
      { viewColumn: 1, isActive: true, tabs: [front, fakeTerminalTab('claude · specs')] },
    ];
    stubTabModel(groups, []);

    const { deps, calls } = harness({
      getProject: twoProjects,
      getActive: () => 'pa',
      bindings: () => [
        binding(S1, 'claude · progress'),
        binding(S2, 'claude · specs'),
      ],
      activeSessionId: () => S1,
      sessionCwd: () => '/code/api',
    });

    await new WorkspaceManager(deps).switchTo('pw');

    const tabs = calls.saved.find((s) => s.projectId === 'pa')?.tabs ?? [];
    expect(tabs).toContainEqual({
      kind: 'session',
      sessionId: S1,
      viewColumn: 1,
      active: true,
    });
    expect(tabs).toContainEqual({
      kind: 'session',
      sessionId: S2,
      viewColumn: 1,
    });
  });

  it('leaves the active tab to the FILE when a file has the keyboard', async () => {
    // `window.activeTerminal` keeps naming the last terminal long after focus
    // moved to an editor. Recording the session as active on that alone would
    // put two active tabs in one snapshot, and the file — the one the user is
    // actually looking at — would lose the tie.
    const front = fakeFileTab('file:///code/api/a.ts');
    front.isActive = true;
    const groups: FakeGroup[] = [
      { viewColumn: 1, isActive: true, tabs: [front, fakeTerminalTab('claude · progress')] },
    ];
    stubTabModel(groups, []);

    const { deps, calls } = harness({
      getProject: twoProjects,
      getActive: () => 'pa',
      bindings: () => [binding(S1, 'claude · progress')],
      activeSessionId: () => S1,
      sessionCwd: () => '/code/api',
    });

    await new WorkspaceManager(deps).switchTo('pw');

    const tabs = calls.saved.find((s) => s.projectId === 'pa')?.tabs ?? [];
    expect(tabs.filter((t) => t.active === true)).toEqual([
      { kind: 'file', uri: 'file:///code/api/a.ts', viewColumn: 1, active: true },
    ]);
  });

  it('never launches a session that already has a terminal here', async () => {
    // The click that triggers an auto switch resumes the session itself, and
    // `resumeFlow` clears `parked` only once its launch resolves — so the
    // restore can still read "parked" about a tab that is already on screen.
    // Launching then puts a second tmux client (or a second claude, on one
    // transcript) on the conversation and orphans the first tab.
    const records: Record<string, EditorialRecord> = {
      [S1]: record(S1, parkedIn('/code/api')),
    };
    const snapshot: WorkspaceSnapshot = {
      projectId: 'pa',
      tabs: [{ kind: 'session', sessionId: S1, viewColumn: 1 }],
      savedAt: ISO,
      updatedAt: ISO,
    };
    stubTabModel(
      [{ viewColumn: 1, isActive: true, tabs: [fakeTerminalTab('claude')] }],
      [],
    );

    const { deps, calls } = harness({
      getProject: twoProjects,
      getWorkspace: (id) => (id === 'pa' ? snapshot : undefined),
      getActive: () => 'pw',
      getRecord: (id) => records[id],
      allRecords: () => records,
      bindings: () => [binding(S1, 'claude')],
      sessionCwd: () => '/code/api',
      isLive: () => true,
      hasTranscript: () => true,
    });
    deps.launchSession = resumes(calls);

    await new WorkspaceManager(deps).switchTo('pa', {
      auto: true,
      focusSessionId: S1,
    });

    expect(calls.launched).toEqual([]);
    // And the record stops claiming a visible tab is hidden.
    expect(calls.written).toContainEqual({
      id: S1,
      patch: { parked: false, tmux: null },
    });
    expect(calls.focused).toEqual([S1]);
  });

  it('never focuses a session the same switch parked', async () => {
    // The trigger belongs to the target by construction, so this is defensive:
    // its terminal is disposed, and the reveal would land on whatever the
    // workbench promoted in its place.
    stubTabModel(
      [{ viewColumn: 1, isActive: true, tabs: [fakeTerminalTab('claude')] }],
      [],
    );
    const { deps, calls } = harness({
      getProject: twoProjects,
      getActive: () => 'pa',
      bindings: () => [binding(S1, 'claude')],
      sessionCwd: () => '/other/place',
    });

    await new WorkspaceManager(deps).switchTo('pw', {
      auto: true,
      focusSessionId: S1,
    });

    expect(calls.killed).toEqual([S1]);
    expect(calls.focused).toEqual([]);
  });
});

// -------------------------------------------------- solo mode (soloSession)

describe('workspaces: solo mode (lineage.soloSession)', () => {
  const S3 = '0f0000a3-0000-4000-8000-0000000000a3';
  const binding = (sessionId: string, terminalName: string) => ({
    nodeId: sessionId,
    sessionId,
    terminalName,
    createdAt: 0,
  });
  const TMUX_S2 = `lineage-${S2}`;

  it('parkOthers is a hard no-op — null — while the mode is off or unwired', async () => {
    const { deps, calls } = harness({
      bindings: () => [binding(S1, 'a'), binding(S2, 'b')],
    });
    // Unwired: the dep is optional and every older wiring omits it.
    expect(await new WorkspaceManager(deps).parkOthers(S1)).toBeNull();
    expect(calls.killed).toEqual([]);

    const off = harness({
      bindings: () => [binding(S1, 'a'), binding(S2, 'b')],
      soloSession: () => false,
    });
    expect(await new WorkspaceManager(off.deps).parkOthers(S1)).toBeNull();
    expect(off.calls.killed).toEqual([]);
    expect(off.calls.written).toEqual([]);
  });

  it('parks every other tab through the same two tiers a switch uses', async () => {
    // S1 is kept. S2 is tmux-backed and BUSY — detached anyway, name recorded.
    // S3 is bare and idle — killed, name erased.
    const { deps, calls } = harness({
      bindings: () => [
        binding(S1, 'keep'),
        binding(S2, 'tmux'),
        binding(S3, 'bare'),
      ],
      isSessionBusy: (id) => id === S2,
      tmuxNameOf: (id) => (id === S2 ? TMUX_S2 : undefined),
      soloSession: () => true,
    });

    expect(await new WorkspaceManager(deps).parkOthers(S1)).toBe(2);

    expect(calls.killed.sort()).toEqual([S2, S3].sort());
    const parked = calls.written.filter((w) => w.patch.parked === true);
    expect(parked.find((w) => w.id === S2)?.patch.tmux).toBe(TMUX_S2);
    expect(parked.find((w) => w.id === S3)?.patch.tmux).toBeNull();
    expect(parked.some((w) => w.id === S1)).toBe(false);
  });

  it('spares a busy BARE session — a park there would abort its turn', async () => {
    const { deps, calls } = harness({
      bindings: () => [binding(S1, 'keep'), binding(S2, 'busy bare')],
      isSessionBusy: (id) => id === S2,
      soloSession: () => true,
    });

    expect(await new WorkspaceManager(deps).parkOthers(S1)).toBe(0);
    expect(calls.killed).toEqual([]);
    expect(calls.written).toEqual([]);
  });

  it('never parks a CHAT — it is not a session tab, and it has no row to come back by', async () => {
    // Focusing the pinned session S1 must sweep the ordinary session S2 and
    // leave the chat's tab exactly where it is, idle or not.
    const records: Record<string, EditorialRecord> = {
      [CHAT]: record(CHAT, { chat: true }),
    };
    const { deps, calls } = harness({
      bindings: () => [binding(S1, 'keep'), binding(S2, 'session'), binding(CHAT, 'chat')],
      getRecord: (id) => records[id],
      allRecords: () => records,
      soloSession: () => true,
    });

    expect(await new WorkspaceManager(deps).parkOthers(S1)).toBe(1);
    expect(calls.killed).toEqual([S2]);
    expect(calls.written.some((w) => w.id === CHAT)).toBe(false);
  });

  it('recognises a reopened chat by its BIRTH record — the bound generation carries no flag', async () => {
    // A chat reopened twice is bound under a generation id nothing ever wrote
    // `chat` onto; only the birth record (a chain member) still says what the
    // conversation is. S3 is the bound generation, CHAT its birth id.
    const records: Record<string, EditorialRecord> = {
      [CHAT]: record(CHAT, { chat: true }),
    };
    const tip = (id: string): string => (id === CHAT || id === S3 ? S3 : id);
    const { deps, calls } = harness({
      bindings: () => [binding(S1, 'keep'), binding(S3, 'reopened chat')],
      getRecord: (id) => records[id],
      allRecords: () => records,
      tipOf: tip,
      soloSession: () => true,
    });

    expect(await new WorkspaceManager(deps).parkOthers(S1)).toBe(0);
    expect(calls.killed).toEqual([]);
  });

  it("keeps the kept conversation's WHOLE CHAIN — a re-keyed generation is the same tab", async () => {
    // The terminal is bound under its launch-time id S2; the row (and the
    // caller) know the conversation as its tip S1.
    const { deps, calls } = harness({
      bindings: () => [binding(S2, 'kept, under its launch id')],
      tipOf: (id) => (id === S2 ? S1 : id),
      soloSession: () => true,
    });

    expect(await new WorkspaceManager(deps).parkOthers(S1)).toBe(0);
    expect(calls.killed).toEqual([]);
  });

  it('a switch restores ONE session — the one the layout says was in front', async () => {
    const records: Record<string, EditorialRecord> = {
      [S1]: record(S1, { parked: true }),
      [S2]: record(S2, { parked: true }),
    };
    const snapshot: WorkspaceSnapshot = {
      projectId: 'pw',
      tabs: [
        { kind: 'session', sessionId: S1, viewColumn: 1 },
        { kind: 'session', sessionId: S2, viewColumn: 1, active: true },
      ],
      savedAt: ISO,
      updatedAt: ISO,
    };
    stubTabModel([{ viewColumn: 1, isActive: true, tabs: [] }], []);

    const { deps, calls } = harness({
      getProject: twoProjects,
      getWorkspace: (id) => (id === 'pw' ? snapshot : undefined),
      getActive: () => 'pa',
      getRecord: (id) => records[id],
      sessionCwd: () => '/code/web',
      isLive: () => false,
      soloSession: () => true,
      launchSession: async (opts) => {
        calls.launched.push(opts.sessionId);
        return {
          nodeId: opts.sessionId,
          sessionId: opts.sessionId,
          terminalName: 'claude',
          createdAt: 0,
        };
      },
    });

    await new WorkspaceManager(deps).switchTo('pw');

    // Only the layout's ACTIVE session came back; S1 stays parked, one
    // row-click away.
    expect(calls.launched).toEqual([S2]);
  });
});
