// SPEC.md §9 — test/tree.test.ts (nominally owner C; written by the
// INTEGRATOR because owner C shipped src/tree.ts + src/decorations.ts only).
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
  WAITING_COLOR_ID,
} from '../src/types';
import type {
  DecorationDeps,
  GroupNode,
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
    visibleRoots: roots.filter((id) => !map.get(id)?.hidden),
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

interface Harness {
  deps: TreeDeps & DecorationDeps;
  reparented: Array<[string, string | null]>;
  setForest(f: SessionForest): void;
  setGrouping(on: boolean): void;
  setBound(ids: string[]): void;
}

function harness(forest: SessionForest): Harness {
  let current = forest;
  let grouping = true;
  let bound = new Set<string>();
  const reparented: Array<[string, string | null]> = [];
  return {
    reparented,
    setForest: (f) => {
      current = f;
    },
    setGrouping: (on) => {
      grouping = on;
    },
    setBound: (ids) => {
      bound = new Set(ids);
    },
    deps: {
      getForest: () => current,
      onDidChangeData: () => ({ dispose: () => undefined }),
      isBoundHere: (id) => bound.has(id),
      reparent: async (childId, newParentId) => {
        reparented.push([childId, newParentId]);
      },
      groupByFolder: () => grouping,
    },
  };
}

const ref = (id: string): SessionRef => ({ type: 'session', id });

// ------------------------------------------------------------------- pure

describe('formatAge', () => {
  it('honours the §4-C2 boundaries', () => {
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
    ).toBe('● dialog open');
    expect(statusDescriptor(node(A, { status: 'waiting' }))).toBe('● waiting');
    expect(statusDescriptor(node(A, { status: 'busy' }))).toBe('▶ busy');
    expect(statusDescriptor(node(A, { status: 'idle' }))).toBe('○ idle');
    expect(statusDescriptor(node(A, { status: 'exited' }))).toBe('✕ gone');
    expect(statusDescriptor(node(A, { status: 'unknown' }))).toBe('');
  });

  it('distinguishes an archived (reopenable) row from a ghost', () => {
    // Both are 'exited', but only one has a transcript behind it.
    expect(
      statusDescriptor(node(A, { status: 'exited', archived: true })),
    ).toBe('⏻ closed');
    expect(statusDescriptor(node(A, { status: 'exited', ghost: true }))).toBe(
      '✕ gone',
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
    ).toBe(';session;live;waiting;forked;');

    expect(sessionContextValue(node(A, { status: 'idle' }), true)).toBe(
      ';session;live;idle;bound;root;',
    );

    expect(
      sessionContextValue(node(A, { ghost: true, status: 'exited' }), false),
    ).toBe(';session;ghost;exited;root;');

    expect(
      sessionContextValue(node(A, { status: 'busy', source: 'minted' }), false),
    ).toBe(';session;live;busy;ours;root;');

    // Archived rows must NOT carry ;live;, or every live-gated verb
    // (fork inline, close, ask) would light up on a closed session.
    expect(
      sessionContextValue(
        node(A, { archived: true, status: 'exited' }),
        false,
      ),
    ).toBe(';session;archived;exited;root;');
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
    expect(p.getTreeItem(ref(A)).description).toBe('now · ● dialog open');
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
});

// ------------------------------------------------------------------- drag/drop

async function drop(
  p: LineageTreeProvider,
  target: SessionRef | GroupNode | undefined,
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

  it('refuses a drop onto the node itself', async () => {
    await drop(p, ref(A), [A]);
    expect(h.reparented).toEqual([]);
  });

  it('refuses a drop onto its own descendant (no cycles)', async () => {
    await drop(p, ref(D), [A]);
    expect(h.reparented).toEqual([]);
  });

  it('detaches to a root when dropped on a group or on empty space', async () => {
    const groups = p.getChildren() as GroupNode[];
    await drop(p, groups[1], [C]);
    await drop(p, undefined, [D]);
    expect(h.reparented).toEqual([
      [C, null],
      [D, null],
    ]);
  });

  it('reparents onto another session', async () => {
    await drop(p, ref(B), [C]);
    expect(h.reparented).toEqual([[C, B]]);
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

  it('badges a waiting session with ! in the lineage.waiting color', () => {
    const p = build([
      node(A, {
        status: 'waiting',
        attention: 'waiting',
        roster: { sessionId: A, waitingFor: 'dialog open' },
      }),
    ]);
    const d = p.provideFileDecoration(sessionUri(A) as never);
    expect(d?.badge).toBe('!');
    expect((d?.color as unknown as { id: string }).id).toBe(WAITING_COLOR_ID);
    expect(d?.tooltip).toBe('waiting: dialog open');
    expect(d?.propagate).toBe(false);
  });

  it('badges a busy session with »', () => {
    const p = build([node(A, { status: 'busy' })]);
    expect(p.provideFileDecoration(sessionUri(A) as never)?.badge).toBe('»');
  });

  it('dims a ghost with color only', () => {
    const p = build([node(A, { ghost: true, status: 'exited' })]);
    const d = p.provideFileDecoration(sessionUri(A) as never);
    expect(d?.badge).toBeUndefined();
    expect((d?.color as unknown as { id: string }).id).toBe('disabledForeground');
  });

  it('leaves an idle session, an unknown id and a foreign scheme alone', () => {
    const p = build([node(A, { status: 'idle' })]);
    expect(p.provideFileDecoration(sessionUri(A) as never)).toBeUndefined();
    expect(p.provideFileDecoration(sessionUri(B) as never)).toBeUndefined();
    expect(
      p.provideFileDecoration(Uri.file('/tmp/alpha/file.ts') as never),
    ).toBeUndefined();
  });
});
