// test/notifications.test.ts — the unseen model, across its three pure homes:
// deriveUnseen (lineage.ts), the dot/count/bubble-up (viewmodel.ts), and the
// bell's content (commands.ts notificationItems).

import { describe, expect, it } from 'vitest';

import { buildForest, deriveUnseen } from '../src/lineage';
import {
  attentionCountOf,
  buildViewModel,
  statusTone,
  subtreeHasUnseen,
} from '../src/viewmodel';
import type { ViewModelInput } from '../src/viewmodel';
import { notificationItems } from '../src/commands';
import type {
  EditorialRecord,
  ProjectRecord,
  ProviderId,
  RosterEntry,
  SessionForest,
  SessionNode,
} from '../src/types';
import type { GroupingResult } from '../src/projects';

const A = '0f00000a-0000-4000-8000-00000000000a';
const B = '0f00000b-0000-4000-8000-00000000000b';
const C = '0f00000c-0000-4000-8000-00000000000c';

const T0 = '2026-07-29T10:00:00.000Z';
const T1 = '2026-07-29T11:00:00.000Z';
const T2 = '2026-07-29T12:00:00.000Z';

function record(
  id: string,
  extra: Partial<EditorialRecord> = {},
): EditorialRecord {
  return { id, createdAt: T0, updatedAt: T0, ...extra };
}

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
    generatedAt: 0,
  };
}

// ------------------------------------------------------------- deriveUnseen

describe('deriveUnseen', () => {
  it('a finished turn nobody looked at is unseen (idle + doneAt, no seenAt)', () => {
    expect(deriveUnseen('idle', record(A, { doneAt: T1 }), true)).toBe(true);
  });

  it('looking at it clears it (seenAt after doneAt)', () => {
    expect(
      deriveUnseen('idle', record(A, { doneAt: T1, seenAt: T2 }), true),
    ).toBe(false);
  });

  it('a NEW finish after the last look re-arms it', () => {
    expect(
      deriveUnseen('idle', record(A, { doneAt: T2, seenAt: T1 }), true),
    ).toBe(true);
  });

  it('an idle session with no observed finish stays quiet — no wall of dots at install', () => {
    expect(deriveUnseen('idle', record(A), true)).toBe(false);
    expect(deriveUnseen('idle', undefined, true)).toBe(false);
  });

  it('waiting is a standing ask: unseen until looked at, even unstamped', () => {
    expect(deriveUnseen('waiting', undefined, true)).toBe(true);
    expect(deriveUnseen('waiting', record(A), true)).toBe(true);
    expect(deriveUnseen('waiting', record(A, { seenAt: T1 }), true)).toBe(false);
    expect(
      deriveUnseen('waiting', record(A, { doneAt: T2, seenAt: T1 }), true),
    ).toBe(true);
  });

  it('busy and exited sessions have no unseen state', () => {
    expect(deriveUnseen('busy', record(A, { doneAt: T1 }), true)).toBeUndefined();
    expect(deriveUnseen('exited', record(A, { doneAt: T1 }), true)).toBeUndefined();
  });

  it('tracking off — globally, or muted per-session — yields undefined', () => {
    expect(deriveUnseen('waiting', record(A), false)).toBeUndefined();
    expect(
      deriveUnseen('idle', record(A, { doneAt: T1, notify: false }), true),
    ).toBeUndefined();
    // A per-session opt-IN survives a global off.
    expect(
      deriveUnseen('idle', record(A, { doneAt: T1, notify: true }), false),
    ).toBe(true);
  });
});

describe('buildForest carries unseen onto live nodes', () => {
  const entry = (id: string, status: string): RosterEntry => ({
    sessionId: id,
    status,
    startedAt: 1,
  });

  it('stamps unseen for a finished-and-unlooked-at session', () => {
    const forest = buildForest({
      entries: [entry(A, 'idle')],
      resolutions: new Map(),
      records: { [A]: record(A, { doneAt: T1 }) },
    });
    expect(forest.nodes.get(A)?.unseen).toBe(true);
  });

  it('a hidden row never carries unseen — muting wins', () => {
    const forest = buildForest({
      entries: [entry(A, 'idle')],
      resolutions: new Map(),
      records: { [A]: record(A, { doneAt: T1, hidden: true }) },
    });
    expect(forest.nodes.get(A)?.unseen).toBeUndefined();
  });

  // The bell-red-over-an-empty-dropdown bug: `notificationItems` drops a
  // deleted session, so if the forest still stamped it unseen the dot had no
  // row behind it and no way to be cleared — the session it pointed at was
  // gone from the tree.
  it('a deleted row never carries unseen — it has no row to look at', () => {
    const forest = buildForest({
      entries: [entry(A, 'idle')],
      resolutions: new Map(),
      records: { [A]: record(A, { doneAt: T1, deleted: true }) },
    });
    expect(forest.nodes.get(A)?.unseen).toBeUndefined();
    expect(
      notificationItems(forest, { [A]: record(A, { doneAt: T1, deleted: true }) }, []),
    ).toEqual([]);
  });

  it('notificationsDefault: false leaves a node with no unseen state at all', () => {
    const forest = buildForest({
      entries: [entry(A, 'waiting')],
      resolutions: new Map(),
      records: { [A]: record(A, { seenAt: T2 }) },
      opts: { notificationsDefault: false },
    });
    expect(forest.nodes.get(A)?.unseen).toBeUndefined();
  });
});

// ---------------------------------------------------------------- statusTone

describe('statusTone with the unseen axis', () => {
  it('waiting stays lit while unseen and goes quiet once seen', () => {
    expect(statusTone(node(A, { status: 'waiting', unseen: true }))).toBe('done');
    expect(statusTone(node(A, { status: 'waiting' }))).toBe('done'); // legacy
    expect(statusTone(node(A, { status: 'waiting', unseen: false }))).toBe('idle');
  });

  it('an idle session lights up only when unseen', () => {
    expect(statusTone(node(A, { status: 'idle', unseen: true }))).toBe('done');
    expect(statusTone(node(A, { status: 'idle' }))).toBe('idle');
    expect(statusTone(node(A, { status: 'idle', unseen: false }))).toBe('idle');
  });

  it('busy and hidden are untouched by unseen', () => {
    expect(statusTone(node(A, { status: 'busy', unseen: true }))).toBe('running');
    expect(
      statusTone(node(A, { status: 'idle', unseen: true, hidden: true })),
    ).toBeUndefined();
  });
});

// -------------------------------------------------------- bubbling + counts

const EMPTY_GROUPING: GroupingResult = {
  projects: [],
  folders: [],
  loose: [],
  hiddenCount: 0,
  outOfScopeCount: 0,
  hiddenRunning: null,
};

function vmInput(
  forest: SessionForest,
  grouping: Partial<GroupingResult>,
): ViewModelInput {
  return {
    forest,
    grouping: { ...EMPTY_GROUPING, ...grouping },
    collapsed: new Set<string>(),
    providerFor: () => 'claude' as ProviderId,
    isBoundHere: () => false,
    viewId: 'lineageSessionsInline',
    now: 0,
  };
}

describe('the dot bubbles up to the project row', () => {
  const nodes = [
    node(A, { status: 'idle', unseen: true, cwd: '/code/api' }),
    node(B, { status: 'idle', cwd: '/code/api' }),
  ];
  const forest = forestOf(nodes);
  const grouping: Partial<GroupingResult> = {
    projects: [
      {
        type: 'project',
        projectId: 'p1',
        label: 'API',
        rootDir: '/code/api',
        dirs: ['/code/api'],
        provider: 'claude',
        rootIds: [A, B],
      },
    ],
  };

  it('subtreeHasUnseen finds a nested unseen node and respects hidden', () => {
    expect(subtreeHasUnseen(forest, [A])).toBe(true);
    expect(subtreeHasUnseen(forest, [B])).toBe(false);
    const muted = forestOf([
      node(A, { status: 'idle', unseen: true, hidden: true }),
    ]);
    expect(subtreeHasUnseen(muted, [A])).toBe(false);
  });

  // THE ROLL-UP AND THE ROW BELOW IT ANSWER THE SAME QUESTION. Each of these
  // is a shape where the old hand-written "unseen-done" disagreed with
  // statusTone, and the disagreement is exactly what a project row's dot must
  // never be able to do: claim something is lit underneath it when nothing is,
  // or stay dark over a row that IS lit.
  it('a session that is OVER never rolls a dot up, however unseen', () => {
    for (const over of [
      { archived: true },
      { status: 'exited' as const },
      { ghost: true },
    ]) {
      const ended = forestOf([node(A, { status: 'idle', unseen: true, ...over })]);
      // The row itself draws nothing — statusTone is 'closed'.
      expect(statusTone(ended.nodes.get(A)!)).not.toBe('done');
      // ...so neither may the project above it.
      expect(subtreeHasUnseen(ended, [A])).toBe(false);
    }
  });

  it('a BUSY session does not roll red up over its own amber dot', () => {
    const working = forestOf([node(A, { status: 'busy', unseen: true })]);
    expect(statusTone(working.nodes.get(A)!)).toBe('running');
    expect(subtreeHasUnseen(working, [A])).toBe(false);
  });

  it('a waiting row with no unseen tracking lights its project too', () => {
    // unseen === undefined: an older record, or tracking off. statusTone reads
    // waiting as the ask and draws 'done', so the roll-up has to agree.
    const waiting = forestOf([node(A, { status: 'waiting', attention: 'waiting' })]);
    expect(statusTone(waiting.nodes.get(A)!)).toBe('done');
    expect(subtreeHasUnseen(waiting, [A])).toBe(true);
  });

  it('a COMPACTING session keeps its purple and rolls nothing up', () => {
    const mid = forestOf([
      node(A, { status: 'idle', unseen: true, compaction: 'compacting' }),
    ]);
    expect(statusTone(mid.nodes.get(A)!)).toBe('compacting');
    expect(subtreeHasUnseen(mid, [A])).toBe(false);
  });

  it('the project row carries the attention dot', () => {
    const rows = buildViewModel(vmInput(forest, grouping));
    const projectRow = rows.find((r) => r.kind === 'project');
    expect(projectRow?.badgeKind).toBe('done');
    expect(projectRow?.badge).toBe('●');
  });

  it('and drops it once everything under it was seen', () => {
    const seenForest = forestOf([
      node(A, { status: 'idle', unseen: false, cwd: '/code/api' }),
      node(B, { status: 'idle', cwd: '/code/api' }),
    ]);
    const rows = buildViewModel(vmInput(seenForest, grouping));
    const projectRow = rows.find((r) => r.kind === 'project');
    expect(projectRow?.badge).toBeUndefined();
  });

  it('attentionCountOf counts exactly the lit attention dots on screen', () => {
    // A unseen (lit), B idle (quiet) + one legacy waiting row (lit).
    const mixed = forestOf([
      node(A, { status: 'idle', unseen: true }),
      node(B, { status: 'idle' }),
      node(C, { status: 'waiting', attention: 'waiting' }),
    ]);
    expect(
      attentionCountOf(mixed, {
        ...EMPTY_GROUPING,
        loose: [A, B, C],
      }),
    ).toBe(2);
    // A waiting-but-seen row no longer counts: the badge equals the dots.
    const seen = forestOf([
      node(C, { status: 'waiting', attention: 'waiting', unseen: false }),
    ]);
    expect(
      attentionCountOf(seen, { ...EMPTY_GROUPING, loose: [C] }),
    ).toBe(0);
  });
});

// ------------------------------------------------------------------ the bell

describe('notificationItems (the bell dropdown)', () => {
  const project: ProjectRecord = {
    id: 'p1',
    name: 'API',
    rootDir: '/code/api',
    dirs: [],
    createdAt: T0,
    updatedAt: T0,
  };

  it('unseen first, then seen history, newest finish first inside each', () => {
    const forest = forestOf([
      node(A, { status: 'idle', unseen: true, cwd: '/code/api' }),
      node(B, { status: 'idle', cwd: '/elsewhere' }),
      node(C, { status: 'idle', unseen: true }),
    ]);
    const records = {
      [A]: record(A, { doneAt: T1 }),
      [B]: record(B, { doneAt: T2, seenAt: T2 }), // seen — history
      [C]: record(C, { doneAt: T2 }),
    };
    const items = notificationItems(forest, records, [project]);
    expect(items.map((i) => i.sessionId)).toEqual([C, A, B]);
    expect(items[0].unseen).toBe(true);
    expect(items[2].unseen).toBe(false);
    expect(items[1].projectName).toBe('API');
    expect(items[2].projectName).toBeUndefined();
  });

  it('muted, hidden, deleted and ghost sessions never ring the bell', () => {
    const forest = forestOf([
      node(A, { status: 'idle', unseen: true }),
      node(B, { status: 'idle', hidden: true }),
      node(C, { ghost: true, status: 'exited' }),
    ]);
    const records = {
      [A]: record(A, { doneAt: T1, notify: false }), // muted
      [B]: record(B, { doneAt: T1 }),
      [C]: record(C, { doneAt: T1 }),
    };
    expect(notificationItems(forest, records, [])).toEqual([]);
  });

  it('a session that never finished anything is not listed', () => {
    const forest = forestOf([node(A, { status: 'idle' })]);
    expect(notificationItems(forest, { [A]: record(A) }, [])).toEqual([]);
  });

  it('honours the cap', () => {
    const nodes: SessionNode[] = [];
    const records: Record<string, EditorialRecord> = {};
    for (let i = 0; i < 30; i++) {
      const id = `0f0000${String(i).padStart(2, '0')}-0000-4000-8000-000000000000`;
      nodes.push(node(id, { status: 'idle', unseen: true }));
      records[id] = record(id, { doneAt: T1 });
    }
    expect(notificationItems(forestOf(nodes), records, [], 5)).toHaveLength(5);
  });
});

// The × on a bell row. Dismissal is per FINISH, which is the whole distinction
// between it and Mute: one says "I have dealt with this one", the other says
// "never tell me about this session".
describe('dismissing a bell row', () => {
  it('takes a dismissed row off the list', () => {
    const forest = forestOf([node(A, { status: 'idle' })]);
    const records = {
      [A]: record(A, { doneAt: T1, seenAt: T1, notifyDismissedAt: T1 }),
    };
    expect(notificationItems(forest, records, [])).toEqual([]);
  });

  it('brings it back the next time that session finishes something', () => {
    const forest = forestOf([node(A, { status: 'idle', unseen: true })]);
    const records = {
      // Dismissed at T1, finished again at T2 — a NEW thing to report.
      [A]: record(A, { doneAt: T2, seenAt: T1, notifyDismissedAt: T1 }),
    };
    expect(notificationItems(forest, records, []).map((i) => i.sessionId)).toEqual([A]);
  });

  it('dismisses a standing ask that has no doneAt at all', () => {
    // A waiting session is unseen with nothing stamped (deriveUnseen's
    // "waiting IS the ask" branch). It has to be dismissible too, or the one
    // row kind that can sit on the bell indefinitely is the one the × cannot
    // clear.
    const forest = forestOf([node(A, { status: 'waiting', unseen: true })]);
    const records = { [A]: record(A, { notifyDismissedAt: T1 }) };
    expect(notificationItems(forest, records, [])).toEqual([]);
  });

  it('leaves every other session alone', () => {
    const forest = forestOf([
      node(A, { status: 'idle', unseen: true }),
      node(B, { status: 'idle', unseen: true }),
    ]);
    const records = {
      [A]: record(A, { doneAt: T1, notifyDismissedAt: T1 }),
      [B]: record(B, { doneAt: T1 }),
    };
    expect(notificationItems(forest, records, []).map((i) => i.sessionId)).toEqual([B]);
  });
});
