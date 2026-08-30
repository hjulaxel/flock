// test/tree.test.ts — the native TreeDataProvider (src/tree.ts) and the file
// decorations that badge its rows (src/decorations.ts).
//
// Everything here goes through test/mocks/vscode.ts. registerTree() /
// registerDecorations() touch the real workbench (`window` is empty in the
// mock) and are deliberately never called.

import { describe, expect, it, beforeEach } from 'vitest';

import {
  LineageTreeProvider,
  formatAge,
  sessionContextValue,
  statusDescriptor,
} from '../src/tree';
import { SessionDecorationProvider, sessionUri } from '../src/decorations';
import {
  COMMANDS,
  SESSION_URI_SCHEME,
  TREE_DND_MIME,
  CLOSED_COLOR_ID,
  DONE_COLOR_ID,
  CLOSED_DOT,
  COMPACTING_COLOR_ID,
  RUNNING_COLOR_ID,
  STATUS_DOT,
} from '../src/types';
import type {
  DecorationDeps,
  GroupNode,
  ProjectGroupNode,
  ProjectRecord,
  ProviderId,
  SessionForest,
  SessionNode,
  SessionRef,
  TreeDeps,
} from '../src/types';
import {
  DataTransfer,
  DataTransferItem,
  TreeItemCollapsibleState,
  Uri,
} from './mocks/vscode';

// ------------------------------------------------------------------ helpers

const A = '0f00000a-0000-4000-8000-00000000000a';
const B = '0f00000b-0000-4000-8000-00000000000b';
const C = '0f00000c-0000-4000-8000-00000000000c';
const D = '0f00000d-0000-4000-8000-00000000000d';

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
    // `deleted`, not `hidden`: a hidden row is muted, still on screen.
    visibleRoots: roots.filter((id) => !map.get(id)?.deleted),
    edges: nodes
      .filter((n) => n.parentId !== null)
      .map((n) => ({
        childId: n.id,
        parentId: n.parentId as string,
        source: n.source,
      })),
    attentionCount: nodes.filter((n) => n.attention === 'waiting').length,
    generatedAt: Date.now(),
  };
}

function project(
  id: string,
  name: string,
  rootDir: string,
  over: Partial<ProjectRecord> = {},
): ProjectRecord {
  return {
    id,
    name,
    rootDir,
    dirs: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

interface Harness {
  deps: TreeDeps & DecorationDeps;
  assigned: Array<[string, string]>;
  setForest(f: SessionForest): void;
  setGrouping(on: boolean): void;
  setBound(ids: string[]): void;
  setProjects(list: ProjectRecord[]): void;
  setHiddenFolders(list: string[]): void;
  setOnlyProjectSessions(on: boolean): void;
  setProvider(id: ProviderId): void;
  setMediaPath(fn: (relative: string) => string | undefined): void;
}

function harness(forest: SessionForest): Harness {
  let current = forest;
  let grouping = true;
  let bound = new Set<string>();
  let projects: ProjectRecord[] = [];
  let hiddenFolders: string[] = [];
  let onlyProjectSessions = false;
  let provider: ProviderId = 'claude';
  // Default: no media on disk, so the tree takes its codicon fallback. Tests
  // that care about the svg path install their own.
  let mediaPath: (relative: string) => string | undefined = () => undefined;
  const assigned: Array<[string, string]> = [];
  return {
    assigned,
    setForest: (f) => {
      current = f;
    },
    setGrouping: (on) => {
      grouping = on;
    },
    setBound: (ids) => {
      bound = new Set(ids);
    },
    setProjects: (list) => {
      projects = list;
    },
    setHiddenFolders: (list) => {
      hiddenFolders = list;
    },
    setOnlyProjectSessions: (on) => {
      onlyProjectSessions = on;
    },
    setProvider: (id) => {
      provider = id;
    },
    setMediaPath: (fn) => {
      mediaPath = fn;
    },
    deps: {
      getForest: () => current,
      onDidChangeData: () => ({ dispose: () => undefined }),
      isBoundHere: (id) => bound.has(id),
      groupByFolder: () => grouping,
      projects: () => projects,
      hiddenFolders: () => hiddenFolders,
      onlyProjectSessions: () => onlyProjectSessions,
      providerFor: () => provider,
      mediaPath: (relative) => mediaPath(relative),
      assignToProject: async (sessionId, projectId) => {
        assigned.push([sessionId, projectId]);
      },
    },
  };
}

const ref = (id: string): SessionRef => ({ type: 'session', id });

// ------------------------------------------------------------------- pure

describe('formatAge', () => {
  it('rounds at the boundaries the sidebar is read at', () => {
    expect(formatAge(0)).toBe('now');
    expect(formatAge(89_999)).toBe('now');
    expect(formatAge(90_000)).toBe('1m');
    expect(formatAge(3_599_999)).toBe('59m');
    expect(formatAge(3_600_000)).toBe('1h');
    expect(formatAge(86_399_999)).toBe('23h');
    expect(formatAge(86_400_000)).toBe('1d');
  });

  it('renders an unknown age as nothing', () => {
    expect(formatAge(Number.NaN)).toBe('');
    expect(formatAge(-1)).toBe('');
    expect(formatAge(Number.POSITIVE_INFINITY)).toBe('');
  });
});

describe('statusDescriptor', () => {
  it('names what a waiting session is waiting for', () => {
    expect(
      statusDescriptor(
        node(A, {
          status: 'waiting',
          roster: { sessionId: A, waitingFor: 'dialog open' },
        }),
      ),
    ).toBe('dialog open');
    // Nothing to say when the roster does not name what it is waiting for — the
    // dot already says "waiting on you".
    expect(statusDescriptor(node(A, { status: 'waiting' }))).toBe('');
    // busy / idle are the dot's job: two rows differing only in state should
    // differ only in the colour of one dot.
    expect(statusDescriptor(node(A, { status: 'busy' }))).toBe('');
    expect(statusDescriptor(node(A, { status: 'idle' }))).toBe('');
    // Being over is the dimmed row's job, not a word's — same reason as busy
    // and idle.
    expect(statusDescriptor(node(A, { status: 'exited' }))).toBe('');
    expect(statusDescriptor(node(A, { status: 'unknown' }))).toBe('');
  });

  it('names a ghost, because dimming cannot tell it from an archived row', () => {
    // Both are 'exited' and both read as over, but only one has a transcript
    // behind it. 'gone' is what stops a ghost reading as something to resume.
    expect(statusDescriptor(node(A, { status: 'exited', archived: true }))).toBe(
      '',
    );
    expect(statusDescriptor(node(A, { status: 'exited', ghost: true }))).toBe(
      'gone',
    );
  });
});

describe('sessionContextValue', () => {
  it('emits the tokens the package.json `when` clauses match on', () => {
    expect(
      sessionContextValue(
        node(A, { status: 'waiting', attention: 'waiting', parentId: B }),
        false,
      ),
    ).toBe(';session;shown;notified;live;waiting;hosted;here;claude;forked;');

    expect(sessionContextValue(node(A, { status: 'idle' }), true)).toBe(
      ';session;shown;notified;live;idle;hosted;here;claude;bound;root;',
    );

    expect(
      sessionContextValue(node(A, { ghost: true, status: 'exited' }), false),
    ).toBe(';session;shown;notified;ghost;exited;root;');

    expect(
      sessionContextValue(node(A, { status: 'busy', source: 'minted' }), false),
    ).toBe(';session;shown;notified;live;busy;hosted;here;claude;ours;root;');

    // Archived rows must NOT carry ;live;, or every live-gated verb
    // (fork inline, close, ask) would light up on a closed session.
    expect(
      sessionContextValue(
        node(A, { archived: true, status: 'exited' }),
        false,
      ),
    ).toBe(';session;shown;notified;archived;exited;claude;root;');
  });

  // The ownership pair the Close verbs are gated on. Exactly one of the two on
  // every live row, and neither on a closed one — a session that is over has no
  // host, and Close is not offered on it anyway.
  it('names who is running a live session, and nobody for a closed one', () => {
    for (const host of ['here', 'flock', 'none'] as const) {
      const v = sessionContextValue(node(A, { status: 'idle' }), false, host);
      expect(v).toContain(';hosted;');
      expect(v).not.toContain(';foreign;');
    }
    const foreign = sessionContextValue(
      node(A, { status: 'idle' }),
      false,
      'foreign',
    );
    expect(foreign).toContain(';foreign;');
    expect(foreign).not.toContain(';hosted;');

    // An ABSENT host is the pre-ownership wiring, and must keep every verb.
    expect(sessionContextValue(node(A, { status: 'idle' }), false)).toContain(
      ';hosted;',
    );

    const closed = sessionContextValue(
      node(A, { archived: true, status: 'exited' }),
      false,
      'foreign',
    );
    expect(closed).not.toContain(';hosted;');
    expect(closed).not.toContain(';foreign;');
  });

  // Exactly one of the pair, always — the two mute menu entries are
  // complementary `when` clauses and each needs a positive token to match.
  it('names which half of the notification mute a row offers', () => {
    expect(
      sessionContextValue(node(A, { status: 'idle', notifyMuted: true }), false),
    ).toContain(';silenced;');
    expect(
      sessionContextValue(node(A, { status: 'idle', notifyMuted: true }), false),
    ).not.toContain(';notified;');
    expect(sessionContextValue(node(A, { status: 'idle' }), false)).toContain(
      ';notified;',
    );
  });

  // WHICH CLI WROTE THIS, as a complementary pair — the same shape as
  // hidden/shown and hosted/foreign, and for the same reason: "Move to
  // Account…" needs a POSITIVE clause to match on, because this manifest never
  // negates a viewItem regex.
  it("names the conversation's CLI, and never claims one for a ghost", () => {
    expect(
      sessionContextValue(node(A, { status: 'idle' }), false, 'here', 'codex'),
    ).toContain(';codex;');
    expect(
      sessionContextValue(node(A, { status: 'idle' }), false, 'here', 'codex'),
    ).not.toContain(';claude;');
    expect(
      sessionContextValue(node(A, { status: 'idle' }), false, 'here', 'claude'),
    ).toContain(';claude;');

    // An ABSENT lookup reads as claude, deliberately. The failure this token
    // exists to stop is a Codex row being OFFERED the verb, not a Claude row
    // being denied it, so a wiring with no opinion keeps the menu it had.
    expect(sessionContextValue(node(A, { status: 'idle' }), false)).toContain(
      ';claude;',
    );

    // A ghost is an inferred ancestor with no transcript on disk, so either
    // answer would be invented — the same refusal the provider glyph makes.
    const ghost = sessionContextValue(
      node(A, { ghost: true, status: 'exited' }),
      false,
      undefined,
      'claude',
    );
    expect(ghost).not.toContain(';claude;');
    expect(ghost).not.toContain(';codex;');
  });

  it('is delimited on both sides so /;live;/ cannot match ;livewire;', () => {
    const v = sessionContextValue(node(A, { status: 'idle' }), false);
    expect(v.startsWith(';')).toBe(true);
    expect(v.endsWith(';')).toBe(true);
    expect(/;live;/.test(v)).toBe(true);
    expect(/;ghost;/.test(v)).toBe(false);
  });
});

// -------------------------------------------------------------- getChildren

describe('LineageTreeProvider.getChildren', () => {
  it('groups two distinct cwds into GroupNodes with the right rootIds', () => {
    const f = forestOf([
      node(A, { cwd: '/tmp/alpha' }),
      node(B, { cwd: '/tmp/beta' }),
      node(C, { cwd: '/tmp/alpha' }),
    ]);
    const h = harness(f);
    const p = new LineageTreeProvider(h.deps);

    const roots = p.getChildren() as GroupNode[];
    expect(roots).toHaveLength(2);
    expect(roots.every((g) => g.type === 'group')).toBe(true);
    expect(roots.map((g) => g.label)).toEqual(['alpha', 'beta']);
    expect(roots[0].rootIds).toEqual([A, C]);
    expect(roots[1].rootIds).toEqual([B]);

    expect(p.getChildren(roots[0])).toEqual([ref(A), ref(C)]);
  });

  it('skips grouping for a single cwd (one group is just noise)', () => {
    const h = harness(
      forestOf([node(A, { cwd: '/tmp/alpha' }), node(B, { cwd: '/tmp/alpha' })]),
    );
    const p = new LineageTreeProvider(h.deps);
    expect(p.getChildren()).toEqual([ref(A), ref(B)]);
  });

  it('returns visibleRoots directly when grouping is off', () => {
    const h = harness(
      forestOf([node(A, { cwd: '/tmp/alpha' }), node(B, { cwd: '/tmp/beta' })]),
    );
    h.setGrouping(false);
    const p = new LineageTreeProvider(h.deps);
    expect(p.getChildren()).toEqual([ref(A), ref(B)]);
  });

  it('returns visibleChildren for a session and [] for an unknown id', () => {
    const h = harness(
      forestOf([
        node(A, { visibleChildren: [B], children: [B] }),
        node(B, { parentId: A }),
      ]),
    );
    const p = new LineageTreeProvider(h.deps);
    expect(p.getChildren(ref(A))).toEqual([ref(B)]);
    expect(p.getChildren(ref(D))).toEqual([]);
  });

  it('drops an out-of-scope session ENTIRELY, running or not — no appendix row', () => {
    // Folder mode's fence is a boundary, not a filter: B is running and still
    // gets no row here, because this window has no verb that could act on it
    // (the launch fence in extension.ts refuses a foreign cwd outright). Its
    // own window shows it; if no window has /code/other open then nothing of
    // its is running at all — window close ends a folder's sessions after the
    // reload grace. The dead out-of-scope session C is dropped as always.
    const h = harness(
      forestOf([
        node(A, { cwd: '/code/app/src', status: 'busy' }),
        node(B, { cwd: '/code/other', status: 'busy' }),
        node(C, { cwd: '/code/other', archived: true, status: 'exited' }),
      ]),
    );
    const p = new LineageTreeProvider({
      ...h.deps,
      scopeDirs: () => ['/code/app'],
    });

    const roots = p.getChildren();
    // Only A survives, and nothing appendix-shaped was appended.
    expect(roots.map((r) => (r as { id?: string }).id ?? null)).toEqual([A]);
    expect(
      roots.some((r) => (r as GroupNode).label === 'Still running'),
    ).toBe(false);
  });

  // END TO END for the badge's own broken promise: the provider counts every
  // live process on the machine, and an ARCHIVED record whose process the
  // roster still reports had no row anywhere to point at — found on a real
  // machine reading 6 with four rows. The rescue is a row, not a smaller
  // number: making the badge agree with the view would delete the only
  // on-screen evidence of a running process nothing owns.
  it('appends an ARCHIVED session whose process is still running', () => {
    const h = harness(
      forestOf([
        node(A, { cwd: '/code/app/src', status: 'busy' }),
        node(B, { cwd: '/code/app/src', status: 'busy', deleted: true }),
      ]),
    );
    const p = new LineageTreeProvider(h.deps);

    const roots = p.getChildren();
    // B is archived, so it is NOT an ordinary row in the tree.
    expect(
      roots.filter((n) => n.type === 'session').map((n) => (n as SessionRef).id),
    ).not.toContain(B);
    const last = roots[roots.length - 1] as GroupNode;
    expect(last.label).toBe('Still running');
    expect(last.rootIds).toEqual([B]);
    // And the number the badge shows has a row behind every unit of it.
    expect(p.runningCount()).toBe(2);
    expect(p.getChildren(last)).toEqual([ref(B)]);
  });

  it('still appends IN-SCOPE running work a view preference hid', () => {
    // The appendix survives for what it was always for: a session this window
    // owns, that the user's own filter would hide. B is inside the scope and
    // in a hidden folder — rescued, and its verbs work.
    const h = harness(
      forestOf([
        node(A, { cwd: '/code/app/src', status: 'busy' }),
        node(B, { cwd: '/code/app/vendor', status: 'busy' }),
      ]),
    );
    h.setHiddenFolders(['/code/app/vendor']);
    const p = new LineageTreeProvider({
      ...h.deps,
      scopeDirs: () => ['/code/app'],
    });

    const roots = p.getChildren();
    const last = roots[roots.length - 1] as GroupNode;
    expect(last.type).toBe('group');
    expect(last.label).toBe('Still running');
    expect(last.rootIds).toEqual([B]);
    // Its children are ordinary session rows, one click from Close Now.
    expect(p.getChildren(last)).toEqual([ref(B)]);

    // Collapsed by default (a ledger, not a workspace) and NOT a folder row:
    // no folder verbs on a row with no directory.
    const item = p.getTreeItem(last);
    expect(item.collapsibleState).toBe(1); // TreeItemCollapsibleState.Collapsed
    expect(item.contextValue).toContain(';elsewhere;');
    expect(item.contextValue).not.toContain(';group;');

    // The user expanding it is remembered.
    p.noteExpanded(last);
    expect(p.getTreeItem(last).collapsibleState).toBe(2); // Expanded
    p.noteCollapsed(last);
    expect(p.getTreeItem(last).collapsibleState).toBe(1);
  });
});

// --------------------------------------------------------------- getTreeItem

describe('LineageTreeProvider.getTreeItem', () => {
  let h: Harness;
  let p: LineageTreeProvider;

  beforeEach(() => {
    h = harness(forestOf([node(A)]));
    p = new LineageTreeProvider(h.deps);
  });

  it('keys the item on the sessionId and decorates it via lineage-session:', () => {
    const item = p.getTreeItem(ref(A));
    expect(item.id).toBe(A);
    const res = item.resourceUri as unknown as { scheme: string; path: string };
    expect(res.scheme).toBe(SESSION_URI_SCHEME);
    expect(res.path).toBe(`/${A}`);
  });

  it('describes a waiting session as "now · ● dialog open"', () => {
    h.setForest(
      forestOf([
        node(A, {
          status: 'waiting',
          attention: 'waiting',
          startedAt: Date.now(),
          roster: { sessionId: A, waitingFor: 'dialog open' },
        }),
      ]),
    );
    expect(p.getTreeItem(ref(A)).description).toBe('now · dialog open');
  });

  // P5: mirrors the viewmodel regression — a session started hours ago but
  // typed in seconds ago must read as "just now" in the native tree too.
  it('ages a row off lastActiveAt, not startedAt', () => {
    h.setForest(
      forestOf([
        node(A, {
          status: 'idle',
          startedAt: Date.now() - 7_200_000,
          lastActiveAt: Date.now() - 30_000,
        }),
      ]),
    );
    expect(p.getTreeItem(ref(A)).description).toBe('now');
  });

  // Both surfaces must read a grace row identically. Since the 2026-08-28
  // review that means the countdown is NOT on the row — the row's existence,
  // not its wording, is what makes the detached state reachable — and the hover
  // is where the words went.
  it('keeps the grace countdown out of the description', () => {
    h.setForest(
      forestOf([
        node(A, {
          status: 'idle',
          startedAt: Date.now(),
          graceDeadlineAt: Date.now() + 9 * 60_000 + 41_000,
        }),
      ]),
    );
    expect(p.getTreeItem(ref(A)).description).toBe('now');
  });

  it('keeps the archived conclusion out of the description', () => {
    h.setForest(
      forestOf([
        node(A, {
          archived: true,
          status: 'exited',
          startedAt: Date.now(),
          lastExchange: 'concluded:\n use BM25',
        }),
      ]),
    );
    // A closed row is a name and an age. The conclusion is one hover away —
    // see the resolveTreeItem tests.
    expect(p.getTreeItem(ref(A)).description).toBe('now');
  });

  it('is Expanded iff it has visibleChildren', () => {
    h.setForest(
      forestOf([
        node(A, { children: [B], visibleChildren: [B] }),
        node(B, { parentId: A }),
      ]),
    );
    expect(p.getTreeItem(ref(A)).collapsibleState).toBe(
      TreeItemCollapsibleState.Expanded,
    );
    expect(p.getTreeItem(ref(B)).collapsibleState).toBe(
      TreeItemCollapsibleState.None,
    );
  });

  it('gives non-ghosts a focus command carrying the SessionRef', () => {
    h.setForest(forestOf([node(A), node(B, { ghost: true, status: 'exited' })]));
    const live = p.getTreeItem(ref(A)).command as {
      command: string;
      arguments: unknown[];
    };
    expect(live.command).toBe(COMMANDS.focusSession);
    expect(live.arguments[0]).toEqual(ref(A));
    expect(p.getTreeItem(ref(B)).command).toBeUndefined();
  });

  it('marks a bound row so the /;bound;/ wrap menu shows up', () => {
    h.setBound([A]);
    expect(p.getTreeItem(ref(A)).contextValue).toContain(';bound;');
  });

  it('renders a group row with its cwd as the description', () => {
    const f = forestOf([
      node(A, { cwd: '/tmp/alpha' }),
      node(B, { cwd: '/tmp/beta' }),
    ]);
    h.setForest(f);
    const groups = p.getChildren() as GroupNode[];
    const item = p.getTreeItem(groups[0]);
    expect(item.id).toBe('group:/tmp/alpha');
    expect(item.description).toBe('/tmp/alpha');
    expect(item.contextValue).toBe(';group;');
    // Groups are not sessions: no resourceUri, so no FileDecoration lookup.
    expect(item.resourceUri).toBeUndefined();
  });
});

// ----------------------------------------------------------------- getParent

describe('LineageTreeProvider.getParent', () => {
  it('inverts getChildren at the group and the session level', () => {
    const f = forestOf([
      node(A, { cwd: '/tmp/alpha', children: [C], visibleChildren: [C] }),
      node(B, { cwd: '/tmp/beta' }),
      node(C, { parentId: A, cwd: '/tmp/alpha' }),
    ]);
    const h = harness(f);
    const p = new LineageTreeProvider(h.deps);

    const groups = p.getChildren() as GroupNode[];
    expect(p.getParent(ref(A))).toBe(groups[0]);
    expect(p.getParent(ref(C))).toEqual(ref(A));
    expect(p.getParent(groups[0])).toBeUndefined();
  });

  it('returns undefined for a root when grouping is off', () => {
    const h = harness(forestOf([node(A, { cwd: '/tmp/alpha' })]));
    h.setGrouping(false);
    const p = new LineageTreeProvider(h.deps);
    expect(p.getParent(ref(A))).toBeUndefined();
  });

  // Regression: the parent index used to be built by walking EVERY node and
  // reading its visibleChildren. buildForest fills that list in on invisible
  // nodes too, so a hidden ancestor claimed the child it had been spliced out
  // of — handing reveal() a path through a row getChildren() never returns.
  it('never reports a hidden ancestor as the visible parent', () => {
    const f = forestOf([
      node(A, { hidden: true, cwd: '/tmp/alpha', children: [C], visibleChildren: [C] }),
      node(C, { parentId: A, cwd: '/tmp/alpha' }),
    ]);
    // A is hidden, so C is promoted to a visible root.
    f.visibleRoots = [C];
    const h = harness(f);
    h.setGrouping(false);
    const p = new LineageTreeProvider(h.deps);

    // Session rows only: A is live and this hand-built fixture gives it no row,
    // so it is now also rescued into the "Still running" appendix (see
    // viewmodel.runningWithoutRow) — a group row at the tail, and nothing this
    // test is about.
    expect(
      p
        .getChildren()
        .filter((n) => n.type === 'session')
        .map((n) => (n as SessionRef).id),
    ).toEqual([C]);
    expect(p.getParent(ref(C))).toBeUndefined();
  });

  it('splices a hidden node out of the middle of a chain', () => {
    // A (visible) -> B (hidden) -> C (visible, promoted under A).
    const f = forestOf([
      node(A, { cwd: '/tmp/alpha', children: [B], visibleChildren: [C] }),
      node(B, { parentId: A, hidden: true, children: [C], visibleChildren: [C] }),
      node(C, { parentId: B, cwd: '/tmp/alpha' }),
    ]);
    f.visibleRoots = [A];
    const h = harness(f);
    h.setGrouping(false);
    const p = new LineageTreeProvider(h.deps);

    expect(p.getChildren(ref(A)).map((n) => (n as SessionRef).id)).toEqual([C]);
    // Not B — that row is not in the tree at all.
    expect(p.getParent(ref(C))).toEqual(ref(A));
  });
});

// -------------------------------------------------------------- attention

describe('LineageTreeProvider.attentionCount', () => {
  const waiting = (id: string, cwd: string): SessionNode =>
    node(id, { cwd, status: 'waiting', attention: 'waiting' });

  it('counts the waiting sessions that are actually rendered', () => {
    const h = harness(forestOf([waiting(A, '/tmp/alpha'), node(B, { cwd: '/tmp/beta' })]));
    const p = new LineageTreeProvider(h.deps);
    expect(p.attentionCount()).toBe(1);
  });

  it('counts waiting descendants of a rendered root', () => {
    const f = forestOf([
      node(A, { cwd: '/tmp/alpha', children: [C], visibleChildren: [C] }),
      { ...waiting(C, '/tmp/alpha'), parentId: A },
    ]);
    const h = harness(f);
    const p = new LineageTreeProvider(h.deps);
    expect(p.attentionCount()).toBe(1);
  });

  // FLIPPED with the appendix rescue. These two once locked a regression fix
  // ("the badge counted a waiting session in a hidden folder that had no row
  // behind it") by dropping the count to zero — but the honest fix for a
  // RUNNING session was never to drop the count, it was to give it the row:
  // hidden-folder and onlyProjectSessions drops now rescue running roots into
  // "Still running" exactly like the scope fence and closed projects do,
  // so the dot renders and the badge counts what the tree shows. (A waiting
  // session is by definition a running one; dead sessions still drop and
  // still count nothing — see the projects describe below.)
  it('counts a waiting session inside a hidden folder — it renders in the appendix now', () => {
    const h = harness(forestOf([waiting(A, '/tmp/alpha')]));
    h.setHiddenFolders(['/tmp/alpha']);
    const p = new LineageTreeProvider(h.deps);
    expect(p.attentionCount()).toBe(1);
  });

  it('counts a waiting session onlyProjectSessions rescued into the appendix', () => {
    const h = harness(forestOf([waiting(A, '/tmp/alpha')]));
    h.setProjects([project('p1', 'Beta', '/tmp/beta')]);
    h.setOnlyProjectSessions(true);
    const p = new LineageTreeProvider(h.deps);
    expect(p.attentionCount()).toBe(1);
  });

  it('counts a WAITING session of a hidden project — it renders in "Still running"', () => {
    // A waiting session is a running one, and closing its project no longer
    // drops its row (that hid a live process): it files into the collapsed
    // appendix group instead, dot and all — so the badge counts what the
    // tree shows. A DEAD session of a hidden project stays dropped and
    // uncounted, as before.
    const h = harness(forestOf([waiting(A, '/tmp/alpha')]));
    h.setProjects([project('p1', 'Alpha', '/tmp/alpha', { hidden: true })]);
    const p = new LineageTreeProvider(h.deps);
    expect(p.attentionCount()).toBe(1);
  });
});

describe('LineageTreeProvider.runningCount', () => {
  it('counts rendered live processes — grace included, closed rows not', () => {
    const h = harness(
      forestOf([
        node(A, { cwd: '/tmp/alpha', status: 'busy' }),
        node(B, {
          cwd: '/tmp/alpha',
          status: 'idle',
          graceDeadlineAt: 2_000_000,
        }),
        node(C, { cwd: '/tmp/alpha', archived: true, status: 'exited' }),
      ]),
    );
    const p = new LineageTreeProvider(h.deps);
    expect(p.runningCount()).toBe(2);
  });

  it('counts a live session inside a hidden folder — the badge is machine-wide', () => {
    // The count is the levels invariant as a number: a running process costs
    // the machine the same memory whichever window's filters apply, so no
    // filter may shrink it. (Filtered RUNNING roots keep a row too — the
    // "Still running" group — for the fence and closed-project drops.)
    const h = harness(forestOf([node(A, { cwd: '/tmp/alpha', status: 'busy' })]));
    h.setHiddenFolders(['/tmp/alpha']);
    const p = new LineageTreeProvider(h.deps);
    expect(p.runningCount()).toBe(1);
  });
});

// ------------------------------------------------------------ resolveTreeItem

describe('LineageTreeProvider.resolveTreeItem', () => {
  it('builds a lazy tooltip carrying the session id and cwd', () => {
    const h = harness(
      forestOf([node(A, { cwd: '/tmp/alpha', startedAt: 1_700_000_000_000 })]),
    );
    const p = new LineageTreeProvider(h.deps);
    const item = p.resolveTreeItem(p.getTreeItem(ref(A)), ref(A));
    const tip = item.tooltip as { value: string; isTrusted: boolean };
    expect(tip.isTrusted).toBe(true);
    expect(tip.value).toContain(A);
    expect(tip.value).toContain('/tmp/alpha');
    expect(tip.value).toContain('parent: none (root)');
  });

  // The hover is now the only place either surface says how long a detached
  // process has left — and the sentence is viewmodel.graceTooltipLine's, shared
  // with the inline sidebar so the two cannot drift.
  it('carries the whole detached-running deal, countdown included', () => {
    const deadline = Date.now() + 9 * 60_000 + 41_000;
    const h = harness(
      forestOf([node(A, { status: 'idle', graceDeadlineAt: deadline })]),
    );
    const p = new LineageTreeProvider(h.deps);
    const item = p.resolveTreeItem(p.getTreeItem(ref(A)), ref(A));
    const tip = item.tooltip as { value: string };
    expect(tip.value).toContain(
      'detached: tab closed, process kept for instant re-attach',
    );
    expect(tip.value).toContain('closing in 10m');
    expect(tip.value).toContain('closes at');
  });

  // The other half of what came off the row: a closed session's conclusion is
  // still readable without resuming, it is just readable on hover.
  it('still carries a closed session’s last exchange', () => {
    const h = harness(
      forestOf([
        node(A, {
          archived: true,
          status: 'exited',
          lastExchange: 'concluded:\n use BM25',
        }),
      ]),
    );
    const p = new LineageTreeProvider(h.deps);
    const item = p.resolveTreeItem(p.getTreeItem(ref(A)), ref(A));
    const tip = item.tooltip as { value: string };
    expect(tip.value).toContain('last exchange: concluded: use BM25');
  });

  // Same rule as the inline hover, and the pair of tests exists so the two
  // cannot drift: a recorded summary must not swallow the last exchange, since
  // neither is on the row any more and the hover is the only surface left.
  it('carries the summary AND the last exchange when both exist', () => {
    const h = harness(
      forestOf([
        node(A, {
          archived: true,
          status: 'exited',
          summary: 'shipped it',
          lastExchange: 'the long answer',
        }),
      ]),
    );
    const p = new LineageTreeProvider(h.deps);
    const item = p.resolveTreeItem(p.getTreeItem(ref(A)), ref(A));
    const tip = item.tooltip as { value: string };
    expect(tip.value).toContain('summary: shipped it');
    expect(tip.value).toContain('last exchange: the long answer');
    expect(tip.value.indexOf('summary:')).toBeLessThan(
      tip.value.indexOf('last exchange:'),
    );
  });

  it('spells out last active alongside started, when both are known', () => {
    const h = harness(
      forestOf([
        node(A, {
          cwd: '/tmp/alpha',
          startedAt: 1_700_000_000_000,
          lastActiveAt: 1_700_003_600_000,
        }),
      ]),
    );
    const p = new LineageTreeProvider(h.deps);
    const item = p.resolveTreeItem(p.getTreeItem(ref(A)), ref(A));
    const tip = item.tooltip as { value: string; isTrusted: boolean };
    expect(tip.value).toContain(`started: ${new Date(1_700_000_000_000).toISOString()}`);
    expect(tip.value).toContain(
      `last active: ${new Date(1_700_003_600_000).toISOString()}`,
    );
  });
});

// ---------------------------------------------------------------- projects

describe('LineageTreeProvider projects', () => {
  const forest = (): SessionForest =>
    forestOf([
      node(A, { cwd: '/code/api/src' }),
      node(B, { cwd: '/code/web' }),
      node(C, { cwd: '/elsewhere' }),
    ]);

  it('puts project rows above folder rows at the top level', () => {
    const h = harness(forest());
    h.setProjects([project('p1', 'API', '/code/api')]);
    const p = new LineageTreeProvider(h.deps);

    const roots = p.getChildren();
    expect(roots.map((r) => r.type)).toEqual(['project', 'group', 'group']);
    const projectRow = roots[0] as ProjectGroupNode;
    expect(projectRow.label).toBe('API');
    expect(projectRow.rootIds).toEqual([A]);
    expect(p.getChildren(projectRow)).toEqual([ref(A)]);
  });

  it('renders a project row with its extra-dir count and nothing else', () => {
    const h = harness(forest());
    h.setProjects([project('p1', 'API', '/code/api', { dirs: ['/shared'] })]);
    const p = new LineageTreeProvider(h.deps);

    const item = p.getTreeItem(p.getChildren()[0]);
    expect(item.id).toBe('project:p1');
    expect(item.label).toBe('API');
    expect(item.description).toBe('+1 dir');
    expect(item.contextValue).toBe(';project;');
    // A project is not a session — it must never take a SESSION decoration.
    // It carries its own scheme, which decorates only the bubbled-up unseen
    // dot and renders nothing otherwise.
    const uri = item.resourceUri as { scheme: string; path: string };
    expect(uri.scheme).toBe('lineage-project');
    expect(uri.path).toBe('/p1');
  });

  // Both root kinds read as the same "this is a container" shape — a project
  // is not a fancier folder, it just also carries the unseen-dot decoration
  // exercised above, which this icon change leaves untouched.
  it('gives a folder row the same unbranded root-folder icon as a project row', () => {
    const h = harness(forest());
    h.setProjects([project('p1', 'API', '/code/api')]);
    const p = new LineageTreeProvider(h.deps);

    const roots = p.getChildren();
    expect(roots.map((r) => r.type)).toEqual(['project', 'group', 'group']);
    const projectIcon = p.getTreeItem(roots[0]).iconPath as unknown as {
      id: string;
      color?: unknown;
    };
    const folderIcon = p.getTreeItem(roots[1]).iconPath as unknown as {
      id: string;
      color?: unknown;
    };
    expect(projectIcon.id).toBe('root-folder');
    expect(projectIcon.color).toBeUndefined();
    expect(folderIcon.id).toBe('root-folder');
    expect(folderIcon.color).toBeUndefined();
  });

  it('marks an empty project so its menu can differ', () => {
    const h = harness(forestOf([]));
    h.setProjects([project('p1', 'API', '/code/api')]);
    const p = new LineageTreeProvider(h.deps);

    const item = p.getTreeItem(p.getChildren()[0]);
    // No description at all: a project row no longer restates its session
    // count, and "no sessions" is what the absence of child rows already says.
    expect(item.description).toBeUndefined();
    // `;empty;` is what the menu keys off, and it is still there.
    expect(item.contextValue).toBe(';project;empty;');
    // Still expandable: collapsing it would hide the only affordance it has.
    expect(item.collapsibleState).toBe(TreeItemCollapsibleState.Expanded);
  });

  it('walks a session up to its project row via getParent', () => {
    const h = harness(forest());
    h.setProjects([project('p1', 'API', '/code/api')]);
    const p = new LineageTreeProvider(h.deps);

    const roots = p.getChildren();
    expect(p.getParent(ref(A))).toBe(roots[0]);
    expect(p.getParent(roots[0])).toBeUndefined();
  });

  it('a hidden folder drops its DEAD sessions; a RUNNING one moves to the appendix', () => {
    // FLIPPED with the appendix rescue: the fixture's sessions are live
    // (status 'idle' is a running process), and no view preference may hide a
    // process that is still spending this machine's memory — so hiding
    // /elsewhere re-files C under "Still running" instead of dropping it.
    const h = harness(forest());
    h.setHiddenFolders(['/elsewhere']);
    const p = new LineageTreeProvider(h.deps);
    expect((p.getChildren() as GroupNode[]).map((g) => g.label)).toEqual([
      'src',
      'web',
      'Still running',
    ]);

    // The half the verb actually promises: once nothing runs there, a hidden
    // folder is hidden ENTIRELY — the rescue lives exactly as long as the
    // process.
    const dead = harness(
      forestOf([
        node(A, { cwd: '/code/api/src' }),
        node(C, { cwd: '/elsewhere', status: 'exited' }),
      ]),
    );
    dead.setHiddenFolders(['/elsewhere']);
    const pd = new LineageTreeProvider(dead.deps);
    // One root (A's, rendered however a lone root renders) and no appendix.
    const roots = pd.getChildren();
    expect(roots).toHaveLength(1);
    expect(
      roots.some((r) => (r as GroupNode).label === 'Still running'),
    ).toBe(false);
  });

  it('honours onlyProjectSessions for DEAD sessions; RUNNING ones keep an appendix row', () => {
    // FLIPPED with the appendix rescue, same reasoning as the hidden-folder
    // test above: the filter still applies, but its running victims file into
    // the collapsed group rather than out of the tree.
    const h = harness(forest());
    h.setProjects([project('p1', 'API', '/code/api')]);
    h.setOnlyProjectSessions(true);
    const p = new LineageTreeProvider(h.deps);

    const roots = p.getChildren();
    expect(roots).toHaveLength(2); // the project + the appendix
    expect((roots[0] as ProjectGroupNode).rootIds).toEqual([A]);
    expect((roots[1] as GroupNode).label).toBe('Still running');

    const dead = harness(
      forestOf([
        node(A, { cwd: '/code/api/src' }),
        node(C, { cwd: '/elsewhere', status: 'exited' }),
      ]),
    );
    dead.setProjects([project('p1', 'API', '/code/api')]);
    dead.setOnlyProjectSessions(true);
    const pd = new LineageTreeProvider(dead.deps);
    expect(pd.getChildren()).toHaveLength(1);
  });

  it('recomputes when a project changes even though the forest did not', () => {
    const h = harness(forest());
    const p = new LineageTreeProvider(h.deps);
    expect(p.getChildren().map((r) => r.type)).toEqual([
      'group',
      'group',
      'group',
    ]);

    h.setProjects([project('p1', 'API', '/code/api')]);
    expect(p.getChildren().map((r) => r.type)).toEqual([
      'project',
      'group',
      'group',
    ]);
  });

  it('keeps rendering when every project dependency throws', () => {
    const h = harness(forest());
    const broken: TreeDeps & DecorationDeps = {
      ...h.deps,
      projects: () => {
        throw new Error('boom');
      },
      hiddenFolders: () => {
        throw new Error('boom');
      },
      onlyProjectSessions: () => {
        throw new Error('boom');
      },
      providerFor: () => {
        throw new Error('boom');
      },
      mediaPath: () => {
        throw new Error('boom');
      },
    };
    const p = new LineageTreeProvider(broken);
    expect(p.getChildren()).toHaveLength(3);
    expect(p.getTreeItem(ref(A)).label).toBe(node(A).label);
  });
});

// --------------------------------------------------------- provider icons

describe('provider icons', () => {
  it('uses the provider svg from the extension install', () => {
    const h = harness(forestOf([node(A, { cwd: '/code/api' })]));
    h.setProvider('gemini');
    h.setMediaPath((relative) => `/ext/${relative}`);
    const p = new LineageTreeProvider(h.deps);

    const icon = p.getTreeItem(ref(A)).iconPath as unknown as Uri;
    expect(icon.scheme).toBe('file');
    expect(icon.path).toBe('/ext/media/providers/gemini.svg');
  });

  it('falls back to a codicon when no media path is available', () => {
    const h = harness(forestOf([node(A)]));
    const p = new LineageTreeProvider(h.deps);
    const icon = p.getTreeItem(ref(A)).iconPath as unknown as { id: string };
    expect(icon.id).toBe('sparkle'); // PROVIDERS.claude.fallbackIcon
  });

  it('falls back to claude for an unknown provider id', () => {
    const h = harness(forestOf([node(A)]));
    h.setProvider('llama' as ProviderId);
    h.setMediaPath((relative) => `/ext/${relative}`);
    const p = new LineageTreeProvider(h.deps);
    const icon = p.getTreeItem(ref(A)).iconPath as unknown as Uri;
    expect(icon.path).toBe('/ext/media/providers/claude.svg');
  });

  it('gives an archived session the provider glyph too', () => {
    const h = harness(forestOf([node(A, { archived: true, status: 'exited' })]));
    h.setMediaPath((relative) => `/ext/${relative}`);
    const p = new LineageTreeProvider(h.deps);
    const item = p.getTreeItem(ref(A));
    expect((item.iconPath as unknown as Uri).path).toBe(
      '/ext/media/providers/claude.svg',
    );
    // And "closed" is NOT in the description — it is the decoration's ring and
    // the grey label its colour brings with it.
    expect(item.description).not.toContain('closed');
  });

  it('keeps circle-slash for a ghost — an inferred node has no provider', () => {
    const h = harness(forestOf([node(A, { ghost: true, status: 'exited' })]));
    h.setMediaPath((relative) => `/ext/${relative}`);
    const p = new LineageTreeProvider(h.deps);
    const icon = p.getTreeItem(ref(A)).iconPath as unknown as { id: string };
    expect(icon.id).toBe('circle-slash');
  });

  // A project is a container, not a session — it claims no provider's logo,
  // regardless of what a session underneath it would resolve to. Unbranded
  // ThemeIcon, no ThemeColor: the section-header treatment in webtree.css
  // (native parity has none, hence no colour here either) carries "this is a
  // root" instead of a mark.
  it('gives a project row an unbranded root-folder icon, not its provider glyph', () => {
    const h = harness(forestOf([]));
    h.setProjects([project('p1', 'Codex work', '/code', { provider: 'codex' })]);
    h.setMediaPath((relative) => `/ext/${relative}`);
    const p = new LineageTreeProvider(h.deps);
    const icon = p.getTreeItem(p.getChildren()[0]).iconPath as unknown as {
      id: string;
      color?: unknown;
    };
    expect(icon.id).toBe('root-folder');
    expect(icon.color).toBeUndefined();
  });

  // The codex half-pair-missing case above pushes providerIcon() down its
  // single-file fallback branch for a SESSION row; a project row must not
  // reach providerIcon() at all, in either branch, so the same unbranded icon
  // comes out here too.
  it('gives a project row the same unbranded icon when its provider media is only half present', () => {
    const h = harness(forestOf([]));
    h.setProjects([project('p1', 'Codex work', '/code', { provider: 'codex' })]);
    h.setMediaPath((relative) =>
      relative.includes('codex-dark') ? undefined : `/ext/${relative}`,
    );
    const p = new LineageTreeProvider(h.deps);
    const icon = p.getTreeItem(p.getChildren()[0]).iconPath as unknown as {
      id: string;
      color?: unknown;
    };
    expect(icon.id).toBe('root-folder');
    expect(icon.color).toBeUndefined();
  });
});

// ------------------------------------------------------------------- hidden

describe('hidden (muted) rows', () => {
  it('greys the row with eye-closed instead of the brand glyph', () => {
    const h = harness(forestOf([node(A, { hidden: true })]));
    h.setMediaPath((relative) => `/ext/${relative}`);
    const p = new LineageTreeProvider(h.deps);
    const item = p.getTreeItem(ref(A));
    const icon = item.iconPath as unknown as { id: string; color?: unknown };
    // A file iconPath is never recoloured by the workbench, so the brand svg
    // cannot be greyed — a themed codicon can.
    expect(icon.id).toBe('eye-closed');
  });

  it('says "hidden" in the description, not only in the colour', () => {
    const h = harness(forestOf([node(A, { hidden: true })]));
    const p = new LineageTreeProvider(h.deps);
    // FileDecoration colours are user-gated; the description never is.
    expect(p.getTreeItem(ref(A)).description).toContain('hidden');
  });

  it('carries a ;hidden; token so the menu can offer Unhide', () => {
    const h = harness(forestOf([node(A, { hidden: true })]));
    const p = new LineageTreeProvider(h.deps);
    const cv = p.getTreeItem(ref(A)).contextValue;
    expect(cv).toContain(';hidden;');
    expect(cv).not.toContain(';shown;');
  });

  it('carries the complementary ;shown; token on a normal row', () => {
    // Exactly one of the pair, always — so neither menu entry needs a negated
    // `when` clause.
    const h = harness(forestOf([node(A)]));
    const p = new LineageTreeProvider(h.deps);
    const cv = p.getTreeItem(ref(A)).contextValue;
    expect(cv).toContain(';shown;');
    expect(cv).not.toContain(';hidden;');
  });

  it('does not badge the view for a muted session that is waiting', () => {
    const h = harness(
      forestOf([
        node(A, { hidden: true, attention: 'waiting', status: 'waiting' }),
        node(B, { attention: 'waiting', status: 'waiting' }),
      ]),
    );
    const p = new LineageTreeProvider(h.deps);
    expect(p.attentionCount()).toBe(1);
  });
});

// ------------------------------------------------------------------- drag/drop

async function drop(
  p: LineageTreeProvider,
  target: SessionRef | GroupNode | ProjectGroupNode | undefined,
  ids: string[],
): Promise<void> {
  const dt = new DataTransfer();
  dt.set(TREE_DND_MIME, new DataTransferItem(JSON.stringify(ids)));
  await p.handleDrop(target, dt as never);
}

describe('LineageTreeProvider drag and drop', () => {
  let h: Harness;
  let p: LineageTreeProvider;

  beforeEach(() => {
    // A ← C ← D  (D is a descendant of A)
    h = harness(
      forestOf([
        node(A, { cwd: '/tmp/alpha', children: [C], visibleChildren: [C] }),
        node(B, { cwd: '/tmp/beta' }),
        node(C, { parentId: A, children: [D], visibleChildren: [D] }),
        node(D, { parentId: C }),
      ]),
    );
    p = new LineageTreeProvider(h.deps);
  });

  it('publishes the dragged ids under the intra-tree mime', () => {
    const dt = new DataTransfer();
    p.handleDrag([ref(A), { type: 'group' } as GroupNode], dt as never);
    expect(dt.get(TREE_DND_MIME)?.value).toBe(JSON.stringify([A]));
    expect(dt.get('text/plain')?.value).toBe(A);
  });

  it('never picks up a session drawn inside a tree', () => {
    // C is a fork of A. It has no filing of its own — it is wherever A is —
    // so the one drop it could be offered would be refused, and it is simply
    // never picked up. A mixed selection drags the roots and leaves it.
    const forks = new DataTransfer();
    p.handleDrag([ref(C)], forks as never);
    expect(forks.get(TREE_DND_MIME)).toBeUndefined();
    expect(forks.get('text/plain')).toBeUndefined();

    const mixed = new DataTransfer();
    p.handleDrag([ref(B), ref(C)], mixed as never);
    expect(mixed.get(TREE_DND_MIME)?.value).toBe(JSON.stringify([B]));
  });

  it('refuses every drop onto a session — lineage is not draggable', async () => {
    // Onto itself, onto a descendant, and onto an unrelated root: all three
    // used to write (or refuse) a hand-made parent edge. None of them moves
    // anything now.
    await drop(p, ref(A), [A]);
    await drop(p, ref(D), [A]);
    await drop(p, ref(B), [C]);
    expect(h.assigned).toEqual([]);
  });

  it('refuses a drop on a group or on empty space — that was the detach', async () => {
    const groups = p.getChildren() as GroupNode[];
    await drop(p, groups[1], [C]);
    await drop(p, undefined, [D]);
    expect(h.assigned).toEqual([]);
  });

  it('assigns to the project when dropped on one', async () => {
    h.setProjects([project('p1', 'Alpha', '/tmp/alpha')]);
    const roots = p.getChildren();
    const projectRow = roots.find((r) => r.type === 'project');
    expect(projectRow).toBeDefined();

    await drop(p, projectRow as ProjectGroupNode, [B]);
    expect(h.assigned).toEqual([[B, 'p1']]);
  });

  it('ignores a non-root session dropped on a project', async () => {
    // A project row renders visible ROOTS only, so assigning a nested fork
    // could never move it on screen — it would just append its cwd to the
    // project's directory list and look like the gesture had failed. The drag
    // no longer offers one either; this is the guard on the message.
    h.setProjects([project('p1', 'Alpha', '/tmp/alpha')]);
    const projectRow = p.getChildren().find((r) => r.type === 'project');

    await drop(p, projectRow as ProjectGroupNode, [C]);
    expect(h.assigned).toEqual([]);
  });

  it('assigns only the roots when a mixed selection is dropped', async () => {
    h.setProjects([project('p1', 'Alpha', '/tmp/alpha')]);
    const projectRow = p.getChildren().find((r) => r.type === 'project');

    await drop(p, projectRow as ProjectGroupNode, [B, C]);
    expect(h.assigned).toEqual([[B, 'p1']]);
  });
});

// ----------------------------------------------------------------- decorations

describe('SessionDecorationProvider.provideFileDecoration', () => {
  const build = (nodes: SessionNode[]): SessionDecorationProvider => {
    const f = forestOf(nodes);
    const deps: DecorationDeps = {
      getForest: () => f,
      onDidChangeData: () => ({ dispose: () => undefined }),
    };
    return new SessionDecorationProvider(deps);
  };

  it('lights the dot in the done colour for a session waiting on you', () => {
    const p = build([
      node(A, {
        status: 'waiting',
        attention: 'waiting',
        roster: { sessionId: A, waitingFor: 'dialog open' },
      }),
    ]);
    const d = p.provideFileDecoration(sessionUri(A) as never);
    expect(d?.badge).toBe(STATUS_DOT);
    expect((d?.color as unknown as { id: string }).id).toBe(DONE_COLOR_ID);
    expect(d?.tooltip).toBe('waiting: dialog open');
    expect(d?.propagate).toBe(false);
  });

  it('lights the dot in the running colour for a busy session', () => {
    const p = build([node(A, { status: 'busy' })]);
    const d = p.provideFileDecoration(sessionUri(A) as never);
    expect(d?.badge).toBe(STATUS_DOT);
    expect((d?.color as unknown as { id: string }).id).toBe(RUNNING_COLOR_ID);
  });

  it('rings a compacting session in purple rather than running-amber', () => {
    // A compaction reports `busy`, so without the tone this row wore the amber
    // dot for work nobody asked for — then the red one when it finished.
    const p = build([node(A, { status: 'busy', compaction: 'compacting' })]);
    const d = p.provideFileDecoration(sessionUri(A) as never);
    expect(d?.badge).toBe(CLOSED_DOT);
    expect((d?.color as unknown as { id: string }).id).toBe(COMPACTING_COLOR_ID);
    expect(d?.tooltip).toBe('compacting');
  });

  it('fills the purple dot once the compaction has settled', () => {
    // Same colour, filled — and it outranks the 'waiting' underneath it,
    // because a compaction ends with the session quiet and the purple would
    // otherwise never draw.
    const p = build([
      node(A, {
        status: 'waiting',
        attention: 'waiting',
        compaction: 'compacted',
      }),
    ]);
    const d = p.provideFileDecoration(sessionUri(A) as never);
    expect(d?.badge).toBe(STATUS_DOT);
    expect((d?.color as unknown as { id: string }).id).toBe(COMPACTING_COLOR_ID);
  });

  // Greys the ghost, draws no mark: an empty ring here would say what the grey
  // label already says, on every dead row in the tree.
  it('greys a ghost without marking it', () => {
    const p = build([node(A, { ghost: true, status: 'exited' })]);
    const d = p.provideFileDecoration(sessionUri(A) as never);
    expect(d?.badge).toBeUndefined();
    expect((d?.color as unknown as { id: string }).id).toBe(CLOSED_COLOR_ID);
    // The hover is the only place left to say which kind of dead this is.
    expect(d?.tooltip).toBe('gone');
  });

  it('greys an archived session, with the word only in the hover', () => {
    const p = build([node(A, { archived: true, status: 'exited' })]);
    const d = p.provideFileDecoration(sessionUri(A) as never);
    expect(d?.badge).toBeUndefined();
    expect((d?.color as unknown as { id: string }).id).toBe(CLOSED_COLOR_ID);
    expect(d?.tooltip).toBe('closed');
  });

  it('draws nothing at all for an idle session', () => {
    // Quiet is the absence of a mark, not a mark of its own: a tree where every
    // idle row carries a dot teaches the eye to skip dots.
    const p = build([node(A, { status: 'idle' })]);
    expect(p.provideFileDecoration(sessionUri(A) as never)).toBeUndefined();
  });

  it('leaves an unknown id and a foreign scheme alone', () => {
    const p = build([node(A, { status: 'idle' })]);
    expect(p.provideFileDecoration(sessionUri(B) as never)).toBeUndefined();
    expect(
      p.provideFileDecoration(Uri.file('/tmp/alpha/file.ts') as never),
    ).toBeUndefined();
  });

  it('dims a hidden session with color only', () => {
    const p = build([node(A, { hidden: true })]);
    const d = p.provideFileDecoration(sessionUri(A) as never);
    expect(d?.badge).toBeUndefined();
    expect((d?.color as unknown as { id: string }).id).toBe('disabledForeground');
    expect(d?.tooltip).toBe('hidden');
  });

  it('leaves a hidden session no dot at all, even when it is waiting', () => {
    // Hide is checked ahead of attention: a muted row that keeps shouting
    // would fail at the one thing the user hid it to achieve.
    const p = build([
      node(A, {
        hidden: true,
        status: 'waiting',
        attention: 'waiting',
        roster: { sessionId: A, waitingFor: 'dialog open' },
      }),
    ]);
    const d = p.provideFileDecoration(sessionUri(A) as never);
    expect(d?.badge).toBeUndefined();
    expect((d?.color as unknown as { id: string }).id).toBe('disabledForeground');
  });
});

// ---------------------------------------------------------------- nesting
//
// The native tree's half of subprojects and branch grouping. It renders the
// same grouping the inline sidebar does (that is the point — the two views
// must never disagree about what a project contains), but through TreeNodes
// rather than a flat row list, so the walk is what has to be tested here.

describe('LineageTreeProvider: subprojects', () => {
  const APP = project('app', 'app', '/code/app');
  const API = project('api', 'api', '/code/app/api', { parentId: 'app' });

  function nested(): { provider: LineageTreeProvider; harness: Harness } {
    const h = harness(
      forestOf([node(A, { cwd: '/code/app' }), node(B, { cwd: '/code/app/api' })]),
    );
    h.setProjects([APP, API]);
    return { provider: new LineageTreeProvider(h.deps), harness: h };
  }

  it('shows only top-level projects at the root', () => {
    const { provider } = nested();
    const roots = provider.getChildren();
    expect(roots).toHaveLength(1);
    expect((roots[0] as ProjectGroupNode).projectId).toBe('app');
  });

  it('returns the subproject from its parent, ahead of the sessions', () => {
    const { provider } = nested();
    const app = provider.getChildren()[0] as ProjectGroupNode;
    const kids = provider.getChildren(app);
    expect(kids.map((k) => (k.type === 'project' ? k.projectId : k.type === 'session' ? k.id : k.type))).toEqual([
      'api',
      A,
    ]);
    const api = kids[0] as ProjectGroupNode;
    expect(provider.getChildren(api).map((k) => (k as SessionRef).id)).toEqual([B]);
  });

  it('walks back up: getParent of a subproject is its parent project', () => {
    const { provider } = nested();
    const app = provider.getChildren()[0] as ProjectGroupNode;
    const api = provider.getChildren(app)[0] as ProjectGroupNode;
    expect((provider.getParent(api) as ProjectGroupNode)?.projectId).toBe('app');
    expect((provider.getParent(ref(B)) as ProjectGroupNode)?.projectId).toBe('api');
  });

  it('gives a legacy nested project row its own glyph, and no nesting token', () => {
    const { provider } = nested();
    const app = provider.getChildren()[0] as ProjectGroupNode;
    const api = provider.getChildren(app)[0] as ProjectGroupNode;
    const item = provider.getTreeItem(api);
    expect((item.iconPath as unknown as { id: string }).id).toBe('folder-library');
    // `;subproject;` belongs to a DIRECTORY row now, and a project row must not
    // match it — the two carry the same projectId, so a shared token would put
    // Remove Subproject on a project and Delete Project on a directory.
    expect(item.contextValue).toBe(';project;');
    expect(provider.getTreeItem(app).contextValue).toBe(';project;');
  });

  it('does not drag a project row at all', async () => {
    // The gesture filed one project under another; nesting records is retired, so
    // there is no legal target left and the payload is never produced.
    const h = harness(forestOf([node(A, { cwd: '/code/app' })]));
    h.setProjects([APP, project('other', 'other', '/code/other')]);
    const provider = new LineageTreeProvider(h.deps);
    const roots = provider.getChildren() as ProjectGroupNode[];
    const app = roots.find((p) => p.projectId === 'app') as ProjectGroupNode;
    const other = roots.find((p) => p.projectId === 'other') as ProjectGroupNode;

    const dt = new DataTransfer();
    provider.handleDrag([other], dt as never);
    await provider.handleDrop(app, dt as never);
    // Nothing was carried, so nothing happened — and in particular the
    // project's id was not read as a session id by the path below it.
    expect(h.assigned).toEqual([]);
  });

  it('declines a project payload from an older window rather than reading it as a session', async () => {
    // A mixed install can still be the SOURCE of a drag: 0.1.1 puts
    // `project:<uuid>` in the same array session ids travel in. Falling
    // through would hand that string to the session path.
    const h = harness(forestOf([node(A, { cwd: '/code/app' })]));
    h.setProjects([APP]);
    const provider = new LineageTreeProvider(h.deps);
    const app = provider.getChildren()[0] as ProjectGroupNode;
    const dt = new DataTransfer();
    dt.set(
      'application/vnd.code.tree.lineagesessions',
      { asString: async () => JSON.stringify([`project:${A}`]) } as never,
    );
    await provider.handleDrop(app, dt as never);
    expect(h.assigned).toEqual([]);
  });

  it('never lets a project drag reach the session path', async () => {
    const h = harness(forestOf([node(A, { cwd: '/code/app' })]));
    h.setProjects([APP]);
    const provider = new LineageTreeProvider(h.deps);
    const app = provider.getChildren()[0] as ProjectGroupNode;
    const dt = new DataTransfer();
    provider.handleDrag([app], dt as never);
    await provider.handleDrop(ref(A), dt as never);
    expect(h.assigned).toEqual([]);
  });
});

describe('LineageTreeProvider: directory subprojects', () => {
  const SPLIT = project('p1', 'app', '/code/app', { dirs: ['/code/app/api'] });

  function build() {
    const h = harness(
      forestOf([
        node(A, { cwd: '/code/app/lib' }),
        node(B, { cwd: '/code/app/api/handlers' }),
      ]),
    );
    h.setProjects([SPLIT]);
    return { provider: new LineageTreeProvider(h.deps), harness: h };
  }

  it('hangs one row per directory under the project, main first', () => {
    const { provider } = build();
    const app = provider.getChildren()[0] as ProjectGroupNode;
    const kids = provider.getChildren(app);
    expect(kids.map((k) => k.type)).toEqual(['subproject', 'subproject']);
    expect(kids.map((k) => (k.type === 'subproject' ? k.label : ''))).toEqual([
      'app',
      'api',
    ]);
  });

  it('lists no session directly under the project', () => {
    // The split is exclusive, exactly as it is in the inline sidebar: every
    // session the project claimed is inside one of these rows, so listing them
    // here too would draw each one twice. The two views must not disagree about
    // which rows a project contains.
    const { provider } = build();
    const app = provider.getChildren()[0] as ProjectGroupNode;
    expect(
      provider.getChildren(app).filter((k) => k.type === 'session'),
    ).toEqual([]);
  });

  it('files each session under the directory that contains it', () => {
    const { provider } = build();
    const app = provider.getChildren()[0] as ProjectGroupNode;
    const [main, api] = provider.getChildren(app);
    expect(provider.getChildren(main).map((k) => (k as SessionRef).id)).toEqual([A]);
    expect(provider.getChildren(api).map((k) => (k as SessionRef).id)).toEqual([B]);
  });

  it('interns the node so an open directory survives a roster tick', () => {
    // The workbench keys expansion state on element identity: a fresh object per
    // refresh would shut every open row on every poll.
    const { provider, harness: h } = build();
    const first = provider.getChildren(
      provider.getChildren()[0] as ProjectGroupNode,
    )[0];
    h.setForest(
      forestOf([
        node(A, { cwd: '/code/app/lib' }),
        node(B, { cwd: '/code/app/api/handlers' }),
      ]),
    );
    const second = provider.getChildren(
      provider.getChildren()[0] as ProjectGroupNode,
    )[0];
    expect(second).toBe(first);
  });

  it('gives the row the subproject token, and `primary` on the main one', () => {
    const { provider } = build();
    const app = provider.getChildren()[0] as ProjectGroupNode;
    const [main, api] = provider.getChildren(app);
    expect(provider.getTreeItem(main).contextValue).toBe(';subproject;primary;');
    expect(provider.getTreeItem(api).contextValue).toBe(';subproject;');
    // The count, and the folder glyph against the project's root marker: the
    // native tree draws no band, so the icon is most of what says which rows are
    // the roots of the view.
    expect(provider.getTreeItem(api).description).toBe('1');
    expect(
      (provider.getTreeItem(api).iconPath as unknown as { id: string }).id,
    ).toBe('folder');
  });

  it('stays expandable with nothing in it', () => {
    const h = harness(forestOf([]));
    h.setProjects([SPLIT]);
    const provider = new LineageTreeProvider(h.deps);
    const app = provider.getChildren()[0] as ProjectGroupNode;
    const [main] = provider.getChildren(app);
    expect(provider.getTreeItem(main).collapsibleState).toBe(
      TreeItemCollapsibleState.Expanded,
    );
    expect(provider.getTreeItem(main).description).toBeUndefined();
  });

  it('takes a session dropped on a directory into that project', async () => {
    // A subproject row counts as its project: the gesture means "this work
    // belongs over there", and the row aimed at is one of that project's
    // directories.
    const { provider, harness: h } = build();
    const app = provider.getChildren()[0] as ProjectGroupNode;
    const api = provider.getChildren(app)[1];
    const dt = new DataTransfer();
    provider.handleDrag([ref(A)], dt as never);
    await provider.handleDrop(api, dt as never);
    expect(h.assigned).toEqual([[A, 'p1']]);
  });

  it('emits nothing for a single-directory project', () => {
    const h = harness(forestOf([node(A, { cwd: '/code/app' })]));
    h.setProjects([project('p1', 'app', '/code/app')]);
    const provider = new LineageTreeProvider(h.deps);
    const app = provider.getChildren()[0] as ProjectGroupNode;
    expect(provider.getChildren(app).map((k) => k.type)).toEqual(['session']);
  });
});

// A2 on the native surface. This renderer has no second line to withhold — the
// branch reaches a row as the FIRST token of its description — so the
// compaction here is dropping that token, and the transparency rule
// (sessionBranchNamesFor's `spoken`) is the same one the inline renderer
// applies. Both are pinned, in both files, because a disagreement between them
// would be silent.
describe('LineageTreeProvider: the branch name on a session row', () => {
  const APP = project('app', 'app', '/code/app');
  const WORKTREES = [
    { dir: '/code/app', branch: 'main', head: 'aaa', detached: false },
    { dir: '/code/app-feat', branch: 'feat/x', head: 'bbb', detached: false },
  ];

  const build = (
    forest: ReturnType<typeof forestOf>,
    over: Partial<TreeDeps> = {},
  ): LineageTreeProvider => {
    const h = harness(forest);
    h.setProjects([APP]);
    const provider = new LineageTreeProvider({
      ...h.deps,
      worktreesOf: () => WORKTREES,
      branchRows: () => true,
      branchDisplay: () => 'inline',
      ...over,
    });
    // Warms the grouping — sessionBranchNamesFor reads the group cache, which
    // only the children walk fills.
    provider.getChildren();
    return provider;
  };
  const desc = (p: LineageTreeProvider, id: string): string =>
    String(p.getTreeItem(ref(id)).description ?? '');
  const hover = (p: LineageTreeProvider, id: string): string =>
    (p.resolveTreeItem(p.getTreeItem(ref(id)), ref(id)).tooltip as {
      value: string;
    }).value;

  it('names the branch on a live row and withholds it from a closed one', () => {
    const p = build(
      forestOf([
        node(A, { cwd: '/code/app', archived: true, status: 'exited' }),
        node(B, { cwd: '/code/app-feat', status: 'idle' }),
      ]),
    );
    expect(desc(p, A)).not.toContain('main');
    expect(desc(p, B).startsWith('feat/x')).toBe(true);
  });

  it('is transparent: a live child of a closed row names the branch instead', () => {
    const p = build(
      forestOf([
        node(A, {
          cwd: '/code/app',
          archived: true,
          status: 'exited',
          children: [C],
          visibleChildren: [C],
        }),
        node(C, { parentId: A, cwd: '/code/app', status: 'idle' }),
      ]),
    );
    expect(desc(p, A)).not.toContain('main');
    expect(desc(p, C).startsWith('main')).toBe(true);
  });

  // THE HOVER IS WHERE THE FACT SURVIVES THE COMPACTION. The description can
  // only afford the name on some rows — never on a closed one — so with no
  // branch line in this renderer's hover, closing a session took the branch
  // name out of the native tree altogether. The inline surface has always
  // carried `branch: …` on every row a scope claims (pinned beside this in
  // test/viewmodel.test.ts), and one of the two surfaces losing a fact the
  // other keeps is the silent disagreement both of these files exist to catch.
  it('names the branch in the hover on a closed row as well as a live one', () => {
    const p = build(
      forestOf([
        node(A, { cwd: '/code/app', archived: true, status: 'exited' }),
        node(B, { cwd: '/code/app-feat', status: 'idle' }),
      ]),
    );
    // The row itself is compacted — this is the fact having nowhere else to be.
    expect(desc(p, A)).not.toContain('main');
    expect(hover(p, A)).toContain('branch: main');
    expect(hover(p, B)).toContain('branch: feat/x');
  });

  // A single-checkout project draws no branch chips at all (BRANCH_CHIPS_MIN),
  // and no row of it says a branch — but the inline hover still does, so this
  // one does too. The gates are about ROW WIDTH; a hover has none.
  it('names it in the hover even below the chip threshold', () => {
    const h = harness(forestOf([node(A, { cwd: '/code/app' })]));
    h.setProjects([APP]);
    const p = new LineageTreeProvider({
      ...h.deps,
      worktreesOf: () => [WORKTREES[0]],
      branchRows: () => true,
      branchDisplay: () => 'inline',
    });
    p.getChildren();
    expect(desc(p, A)).not.toContain('main');
    expect(hover(p, A)).toContain('branch: main');
  });

  // Under `lineage.groupSessionsByBranch` the session hangs off a BRANCH ROW,
  // which says the name one line up and in bigger type — so the description
  // repeating it is the same redundancy the transparency rule already removes
  // from a fork that stayed in its parent's checkout. What must NOT happen is
  // the blunt fix: a fork in ANOTHER worktree nests under its parent, so the
  // row above it names the wrong checkout and its name is load-bearing.
  it('lets the branch ROW speak for its own sessions, but not for a fork in another worktree', () => {
    const p = build(
      forestOf([
        node(A, { cwd: '/code/app', children: [C], visibleChildren: [C] }),
        node(C, { parentId: A, cwd: '/code/app-feat' }),
      ]),
      { groupSessionsByBranch: () => true },
    );
    expect(desc(p, A)).not.toContain('main');
    expect(desc(p, C).startsWith('feat/x')).toBe(true);
    // And the hover keeps both, grouping or not.
    expect(hover(p, A)).toContain('branch: main');
  });
});

describe('LineageTreeProvider: branch grouping', () => {
  const APP = project('app', 'app', '/code/app');
  const WORKTREES = [
    { dir: '/code/app', branch: 'main', head: 'aaa', detached: false },
    { dir: '/code/app-feat', branch: 'feat/x', head: 'bbb', detached: false },
  ];

  function build(on: boolean): { provider: LineageTreeProvider } {
    const h = harness(
      forestOf([
        node(A, { cwd: '/code/app' }),
        node(B, { cwd: '/code/app-feat' }),
      ]),
    );
    h.setProjects([APP]);
    const deps: TreeDeps = {
      ...h.deps,
      worktreesOf: () => WORKTREES,
      // The block's master switch. Explicit in every branch test now that it is
      // off by default — `lineage.git.branches`, see CONFIG_KEYS.gitBranches.
      branchRows: () => true,
      groupSessionsByBranch: () => on,
    };
    return { provider: new LineageTreeProvider(deps) };
  }

  it('is off by default: a project lists its sessions directly', () => {
    const { provider } = build(false);
    const app = provider.getChildren()[0] as ProjectGroupNode;
    expect(provider.getChildren(app).map((k) => (k as SessionRef).id)).toEqual([
      A,
      B,
    ]);
  });

  it('puts a branch row between the project and its sessions when on', () => {
    const { provider } = build(true);
    const app = provider.getChildren()[0] as ProjectGroupNode;
    const kids = provider.getChildren(app);
    expect(kids.map((k) => k.type)).toEqual(['branch', 'branch']);
    const main = kids[0];
    expect(main.type === 'branch' && main.branch).toBe('main');
    expect(provider.getChildren(main).map((k) => (k as SessionRef).id)).toEqual([
      A,
    ]);
  });

  it('reveals a session through the branch that contains it', () => {
    const { provider } = build(true);
    const parent = provider.getParent(ref(B));
    expect(parent?.type).toBe('branch');
    expect(parent?.type === 'branch' && parent.branch).toBe('feat/x');
    // ...and the branch's own parent is the project, so reveal() can walk up.
    const grand = parent ? provider.getParent(parent) : undefined;
    expect(grand?.type === 'project' && grand.projectId).toBe('app');
  });

  it('hands back the same branch object while nothing about it changed', () => {
    const { provider } = build(true);
    const app = provider.getChildren()[0] as ProjectGroupNode;
    const first = provider.getChildren(app)[0];
    const second = provider.getChildren(app)[0];
    expect(second).toBe(first);
  });

  it('renders the count and keeps an empty branch clickable', () => {
    const h = harness(forestOf([node(A, { cwd: '/code/app' })]));
    h.setProjects([APP]);
    const provider = new LineageTreeProvider({
      ...h.deps,
      worktreesOf: () => WORKTREES,
      branchRows: () => true,
      groupSessionsByBranch: () => true,
    });
    const app = provider.getChildren()[0] as ProjectGroupNode;
    const [main, feat] = provider.getChildren(app);
    expect(provider.getTreeItem(main).description).toBe('1');
    const featItem = provider.getTreeItem(feat);
    expect(featItem.description).toBeUndefined();
    expect(featItem.collapsibleState).toBe(TreeItemCollapsibleState.None);
    expect(featItem.command?.command).toBe(COMMANDS.newSessionInBranch);
  });

  it('puts the star against the label and the request mark in the icon', () => {
    // The two moves the inline row made, followed here so the surfaces say the
    // same thing in the same place. A description is drawn immediately after the
    // label, so the `*` leading it IS "against the name" — the label itself is
    // the row's identity and the star does not belong in it.
    const h = harness(forestOf([node(A, { cwd: '/code/app' })]));
    h.setProjects([APP]);
    const provider = new LineageTreeProvider({
      ...h.deps,
      worktreesOf: () => WORKTREES,
      branchRows: () => true,
      groupSessionsByBranch: () => true,
      branchStatusOf: (dir) =>
        dir === '/code/app'
          ? {
              branch: 'main',
              upstream: 'origin/main',
              ahead: 2,
              behind: 0,
              dirty: true,
              untracked: false,
            }
          : undefined,
      pullRequestFor: (_repoDir, branch) =>
        branch === 'main'
          ? {
              number: 42,
              title: 'Rank by BM25',
              state: 'merged',
              checks: 'none',
              branch: 'main',
              url: 'https://github.com/acme/app/pull/42',
            }
          : undefined,
    });
    const app = provider.getChildren()[0] as ProjectGroupNode;
    const mainItem = provider.getTreeItem(provider.getChildren(app)[0]);
    expect(mainItem.description).toBe('* ↑2 #42 1');
    // Merged: git's merge mark, in GitHub's purple. Made by the same function
    // the webview's mask is named from, so the two cannot drift.
    expect((mainItem.iconPath as { id?: string }).id).toBe('git-merge');
    expect((mainItem.iconPath as { color?: { id?: string } }).color?.id).toBe(
      'charts.purple',
    );
  });

  it('leaves a branch with no request the icon it always had', () => {
    const h = harness(forestOf([node(A, { cwd: '/code/app' })]));
    h.setProjects([APP]);
    const provider = new LineageTreeProvider({
      ...h.deps,
      worktreesOf: () => WORKTREES,
      branchRows: () => true,
      groupSessionsByBranch: () => true,
    });
    const app = provider.getChildren()[0] as ProjectGroupNode;
    const mainItem = provider.getTreeItem(provider.getChildren(app)[0]);
    expect((mainItem.iconPath as { id?: string }).id).toBe('git-branch');
    expect((mainItem.iconPath as { color?: unknown }).color).toBeUndefined();
  });
});
