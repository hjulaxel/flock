// test/viewmodel.test.ts — M9, the inline-rename sidebar's model.
//
// This is where the whole rendering decision lives, so it is where the tests
// live: the webview client is a dumb painter with no model of its own.

import { describe, expect, it } from 'vitest';

import {
  attentionCountOf,
  badgeGlyph,
  buildViewModel,
  folderRowKey,
  projectRowKey,
  sessionRowKey,
} from '../src/viewmodel';
import type { ViewModelInput } from '../src/viewmodel';
import { STATUS_DOT } from '../src/types';
import type {
  ProviderId,
  SessionForest,
  SessionNode,
} from '../src/types';
import type { GroupingResult } from '../src/projects';

const A = '0f00000a-0000-4000-8000-00000000000a';
const B = '0f00000b-0000-4000-8000-00000000000b';
const C = '0f00000c-0000-4000-8000-00000000000c';
const D = '0f00000d-0000-4000-8000-00000000000d';

const NOW = 1_785_160_000_000;
const VIEW = 'lineageSessionsInline';

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
    visibleRoots: roots.filter((id) => !map.get(id)?.deleted),
    edges: [],
    attentionCount: 0,
    generatedAt: NOW,
  };
}

const EMPTY_GROUPING: GroupingResult = {
  projects: [],
  folders: [],
  loose: [],
  hiddenCount: 0,
};

function input(
  forest: SessionForest,
  grouping: Partial<GroupingResult> = {},
  over: Partial<ViewModelInput> = {},
): ViewModelInput {
  return {
    forest,
    grouping: { ...EMPTY_GROUPING, ...grouping },
    collapsed: new Set<string>(),
    providerFor: () => 'claude' as ProviderId,
    isBoundHere: () => false,
    viewId: VIEW,
    now: NOW,
    ...over,
  };
}

const keys = (rows: { key: string }[]): string[] => rows.map((r) => r.key);

describe('buildViewModel: flattening', () => {
  it('emits loose roots in order, at depth 0', () => {
    const rows = buildViewModel(
      input(forestOf([node(A), node(B)]), { loose: [A, B] }),
    );
    expect(keys(rows)).toEqual([sessionRowKey(A), sessionRowKey(B)]);
    expect(rows.map((r) => r.depth)).toEqual([0, 0]);
  });

  it('nests children one level deeper, depth-first', () => {
    const rows = buildViewModel(
      input(
        forestOf([
          node(A, { visibleChildren: [B] }),
          node(B, { parentId: A, visibleChildren: [C] }),
          node(C, { parentId: B }),
          node(D),
        ]),
        { loose: [A, D] },
      ),
    );
    expect(keys(rows)).toEqual([
      sessionRowKey(A),
      sessionRowKey(B),
      sessionRowKey(C),
      sessionRowKey(D),
    ]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 0]);
  });

  it('omits the subtree of a collapsed row but keeps the row expandable', () => {
    const rows = buildViewModel(
      input(
        forestOf([node(A, { visibleChildren: [B] }), node(B, { parentId: A })]),
        { loose: [A] },
        { collapsed: new Set([sessionRowKey(A)]) },
      ),
    );
    expect(keys(rows)).toEqual([sessionRowKey(A)]);
    expect(rows[0].expandable).toBe(true);
    expect(rows[0].expanded).toBe(false);
  });

  it('puts project rows first, then folders, then loose sessions', () => {
    const rows = buildViewModel(
      input(forestOf([node(A), node(B), node(C)]), {
        projects: [
          {
            type: 'project',
            projectId: 'p1',
            label: 'API',
            rootDir: '/code/api',
            dirs: ['/code/api'],
            provider: 'claude',
            rootIds: [A],
          },
        ],
        folders: [
          { type: 'group', key: '/w', cwd: '/w', label: 'w', rootIds: [B] },
        ],
        loose: [C],
      }),
    );
    expect(keys(rows)).toEqual([
      projectRowKey('p1'),
      sessionRowKey(A),
      folderRowKey('/w'),
      sessionRowKey(B),
      sessionRowKey(C),
    ]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 0, 1, 0]);
  });

  it('renders an empty project as an expandable row — that is where + lives', () => {
    const rows = buildViewModel(
      input(forestOf([]), {
        projects: [
          {
            type: 'project',
            projectId: 'p1',
            label: 'API',
            rootDir: '/code/api',
            dirs: ['/code/api'],
            provider: 'claude',
            rootIds: [],
          },
        ],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].expandable).toBe(true);
    // No session count on a project row at all — the rows underneath are it.
    expect(rows[0].description).toBe('');
  });

  it('never emits a row for a node the grouping did not hand it', () => {
    // A deleted node keeps a populated visibleChildren, so a flat pass over
    // forest.nodes would leak rows the tree must not show.
    const rows = buildViewModel(
      input(
        forestOf([
          node(A, { deleted: true, visibleChildren: [B] }),
          node(B, { parentId: A }),
        ]),
        { loose: [] },
      ),
    );
    expect(rows).toEqual([]);
  });
});

describe('buildViewModel: the spine', () => {
  it('gives a root session no rails — a lineage starts at its own root', () => {
    const rows = buildViewModel(
      input(forestOf([node(A), node(B)]), { loose: [A, B] }),
    );
    expect(rows.map((r) => r.rails)).toEqual([[], []]);
    expect(rows.map((r) => r.descends)).toEqual([false, false]);
  });

  it("marks an ancestor's rail as continuing only while it has more to come", () => {
    //   A
    //   ├─ B      rail under A carries on: C is still below
    //   │   └─ D  A's rail continues past D, B's stops (D is B's last)
    //   └─ C      last child of A: A's rail stops here
    const rows = buildViewModel(
      input(
        forestOf([
          node(A, { visibleChildren: [B, C] }),
          node(B, { parentId: A, visibleChildren: [D] }),
          node(D, { parentId: B }),
          node(C, { parentId: A }),
        ]),
        { loose: [A] },
      ),
    );
    expect(keys(rows)).toEqual([
      sessionRowKey(A),
      sessionRowKey(B),
      sessionRowKey(D),
      sessionRowKey(C),
    ]);
    expect(rows.map((r) => r.rails)).toEqual([
      [], // A — a root
      [true], // B — A has C still to come
      [true, false], // D — A's rail runs on, B's ends at this last child
      [false], // C — A's last child, so A's rail ends here
    ]);
  });

  it('runs a rail out of an expanded row and not out of a collapsed one', () => {
    const forest = forestOf([
      node(A, { visibleChildren: [B] }),
      node(B, { parentId: A }),
    ]);
    const open = buildViewModel(input(forest, { loose: [A] }));
    expect(open[0].descends).toBe(true);

    const shut = buildViewModel(
      input(forest, { loose: [A] }, { collapsed: new Set([sessionRowKey(A)]) }),
    );
    expect(shut).toHaveLength(1);
    // Expandable, but nothing is drawn beneath it to join: a rail into an
    // unrendered child is a line pointing at a row that is not there.
    expect(shut[0].expandable).toBe(true);
    expect(shut[0].descends).toBe(false);
  });

  it('starts a fresh spine under a header instead of hanging off it', () => {
    const rows = buildViewModel(
      input(forestOf([node(A), node(B)]), {
        projects: [
          {
            type: 'project',
            projectId: 'p1',
            label: 'API',
            rootDir: '/code/api',
            dirs: ['/code/api'],
            provider: 'claude',
            rootIds: [A],
          },
        ],
        folders: [
          { type: 'group', key: '/w', cwd: '/w', label: 'w', rootIds: [B] },
        ],
      }),
    );
    // Both headers are depth 0 and both sessions depth 1, but no session hangs
    // off a header: a project is a filing decision, not a fork.
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 0, 1]);
    expect(rows.map((r) => r.rails)).toEqual([[], [], [], []]);
    // Both headers are expandable and open — and still spawn no rail.
    expect(rows.map((r) => r.expandable && r.expanded)).toEqual([
      true,
      false,
      true,
      false,
    ]);
    expect(rows.map((r) => r.descends)).toEqual([false, false, false, false]);
  });

  it('leaves exactly one indent level for the client to pad, per row', () => {
    // The client draws `rails.length` levels inside the gutter and pads the
    // rest, so `depth - rails.length` is the padding it applies: 1 for anything
    // filed under a header, 0 for a loose root, and CONSTANT down a subtree —
    // if it ever grew with depth the spine would drift away from the label.
    const rows = buildViewModel(
      input(
        forestOf([
          node(A, { visibleChildren: [B] }),
          node(B, { parentId: A, visibleChildren: [C] }),
          node(C, { parentId: B }),
          node(D),
        ]),
        {
          projects: [
            {
              type: 'project',
              projectId: 'p1',
              label: 'API',
              rootDir: '/code/api',
              dirs: ['/code/api'],
              provider: 'claude',
              rootIds: [A],
            },
          ],
          loose: [D],
        },
      ),
    );
    expect(rows.map((r) => r.depth - r.rails.length)).toEqual([0, 1, 1, 1, 0]);
  });
});

describe('buildViewModel: row content', () => {
  it('describes a live row with its age alone — state is the dot', () => {
    const rows = buildViewModel(
      input(
        forestOf([node(A, { startedAt: NOW - 7_200_000, status: 'idle' })]),
        { loose: [A] },
      ),
    );
    expect(rows[0].description).toBe('2h');
  });

  // P5, the filed bug and the reason this batch exists: a session started
  // hours ago but typed in seconds ago must read as "just now", not "hours
  // ago". Direct regression coverage for the age basis switching from
  // startedAt to lastActiveAt.
  it('ages a busy row off its last activity, not its start time', () => {
    const rows = buildViewModel(
      input(
        forestOf([
          node(A, {
            startedAt: NOW - 7_200_000, // started 2h ago
            lastActiveAt: NOW - 30_000, // typed in 30s ago
            status: 'busy',
          }),
        ]),
        { loose: [A] },
      ),
    );
    expect(rows[0].description).toBe('now');
  });

  it('falls back to startedAt when lastActiveAt is unset (too new for the sweep)', () => {
    const rows = buildViewModel(
      input(
        forestOf([node(A, { startedAt: NOW - 7_200_000, status: 'idle' })]),
        { loose: [A] },
      ),
    );
    expect(rows[0].description).toBe('2h');
  });

  // M18. The transcript's mtime moves for every token Claude writes, so a
  // session left running unattended kept reporting "now" however long ago you
  // had last said anything to it. The age means "how long since I spoke to
  // this", and lastPromptAt is the only source that actually says so.
  it('ages a row off the last USER prompt, not the transcript mtime', () => {
    const rows = buildViewModel(
      input(
        forestOf([
          node(A, {
            startedAt: NOW - 7_200_000, // started 2h ago
            lastPromptAt: NOW - 3_600_000, // last asked 1h ago
            lastActiveAt: NOW - 5_000, // still churning out tokens
            status: 'busy',
          }),
        ]),
        { loose: [A] },
      ),
    );
    expect(rows[0].description).toBe('1h');
  });

  it('falls back through mtime, then start, when no prompt is visible', () => {
    // The bounded tail read can miss a prompt buried behind a long tool run —
    // that row must degrade to what it showed before M18, not to blank.
    const rows = buildViewModel(
      input(
        forestOf([
          node(A, {
            startedAt: NOW - 7_200_000,
            lastActiveAt: NOW - 30_000,
            status: 'idle',
          }),
        ]),
        { loose: [A] },
      ),
    );
    expect(rows[0].description).toBe('now');
  });

  it('puts the token count left of the age, and only when asked for', () => {
    const forest = forestOf([
      node(A, { startedAt: NOW - 7_200_000, tokens: 287_207, status: 'idle' }),
    ]);
    expect(
      buildViewModel(input(forest, { loose: [A] }))[0].description,
    ).toBe('2h');
    expect(
      buildViewModel({
        ...input(forest, { loose: [A] }),
        showTokens: true,
      })[0].description,
    ).toBe('287k · 2h');
  });

  it('costs the row nothing when the count is unknown', () => {
    // No number is not the same as a zero: an unreadable transcript must not
    // put a stray separator on the row.
    const rows = buildViewModel({
      ...input(
        forestOf([node(A, { startedAt: NOW - 7_200_000, status: 'idle' })]),
        { loose: [A] },
      ),
      showTokens: true,
    });
    expect(rows[0].description).toBe('2h');
  });

  it('keeps the words a mark cannot carry: what it waits for, and which kind of dead', () => {
    const waiting = buildViewModel(
      input(
        forestOf([
          node(A, {
            startedAt: NOW - 120_000,
            status: 'waiting',
            attention: 'waiting',
            roster: { sessionId: A, waitingFor: 'dialog open' },
          }),
        ]),
        { loose: [A] },
      ),
    )[0];
    expect(waiting.description).toBe('2m · dialog open');

    // Closed is the dimmed row, not a word. What survives as text is the one
    // thing dimming cannot draw: an archived row reopens on a click, a ghost
    // has possibly nothing behind it.
    const closed = buildViewModel(
      input(
        forestOf([
          node(A, { status: 'exited', archived: true, startedAt: NOW - 120_000 }),
        ]),
        { loose: [A] },
      ),
    )[0];
    expect(closed.description).toBe('2m');

    const ghost = buildViewModel(
      input(
        forestOf([
          node(A, { status: 'exited', ghost: true, startedAt: NOW - 120_000 }),
        ]),
        { loose: [A] },
      ),
    )[0];
    expect(ghost.description).toBe('2m · gone');
  });

  it('greys a hidden row, marks it, and drops its badge', () => {
    const rows = buildViewModel(
      input(
        forestOf([
          node(A, {
            hidden: true,
            status: 'waiting',
            attention: 'waiting',
            startedAt: NOW - 3_600_000,
          }),
        ]),
        { loose: [A] },
      ),
    );
    const row = rows[0];
    expect(row.muted).toBe(true);
    expect(row.description).toContain('hidden');
    // Putting a session away is how you tell it to stop asking for you.
    expect(row.badge).toBeUndefined();
    expect(row.icon).toEqual({ type: 'codicon', id: 'eye-closed', tone: 'muted' });
  });

  it('lights one dot per row, in the tone statusTone() decides', () => {
    // A session that has stopped and wants you IS the finished one — 'done'.
    const waiting = buildViewModel(
      input(
        forestOf([node(A, { status: 'waiting', attention: 'waiting' })]),
        { loose: [A] },
      ),
    )[0];
    expect(waiting.badge).toBe(STATUS_DOT);
    expect(waiting.badgeKind).toBe('done');

    const busy = buildViewModel(
      input(forestOf([node(A, { status: 'busy' })]), { loose: [A] }),
    )[0];
    expect(busy.badge).toBe(STATUS_DOT);
    expect(busy.badgeKind).toBe('running');

    // Idle is a TONE with no glyph: the row is known-quiet, which is worth a
    // word in the hover and worth drawing nothing for.
    const idle = buildViewModel(
      input(forestOf([node(A, { status: 'idle' })]), { loose: [A] }),
    )[0];
    expect(idle.badge).toBeUndefined();
    expect(idle.badgeKind).toBe('idle');
  });

  it('gives a put-away or unknown row no dot at all', () => {
    for (const over of [{ hidden: true }, { status: 'unknown' as const }]) {
      const row = buildViewModel(
        input(forestOf([node(A, over)]), { loose: [A] }),
      )[0];
      expect(row.badge).toBeUndefined();
      expect(row.badgeKind).toBeUndefined();
    }
  });

  it('gives a dead row a tone but no mark of its own (M19)', () => {
    // The ring it used to carry is gone: a closed row is dimmed and its logo
    // greyed, so the circle was a second mark for something the row already
    // said — and an empty circle beside every finished session is what teaches
    // the eye past the column the two lit dots live in. The TONE stays, because
    // the stylesheet still keys the column's width on it.
    for (const over of [
      { ghost: true, status: 'exited' as const },
      { archived: true, status: 'exited' as const },
    ]) {
      const row = buildViewModel(
        input(forestOf([node(A, over)]), { loose: [A] }),
      )[0];
      expect(row.badge).toBeUndefined();
      expect(row.badgeKind).toBe('closed');
    }
  });

  it('strikes through what is closed — but never a ghost', () => {
    const closedOf = (over: Partial<SessionNode>): boolean =>
      buildViewModel(input(forestOf([node(A, over)]), { loose: [A] }))[0].closed;

    expect(closedOf({ archived: true, status: 'exited' })).toBe(true);
    expect(closedOf({ status: 'exited' })).toBe(true);
    // A ghost is an inferred ancestor, never a session of yours that ran and
    // stopped — striking its name through would claim a history it lacks.
    expect(closedOf({ ghost: true, status: 'exited' })).toBe(false);
    expect(closedOf({ status: 'idle' })).toBe(false);

    // A container is never over: a project outlives every session under it.
    const rows = buildViewModel(
      input(forestOf([node(A)]), {
        projects: [
          {
            type: 'project',
            projectId: 'p1',
            label: 'API',
            rootDir: '/code/api',
            dirs: ['/code/api'],
            provider: 'claude',
            rootIds: [],
          },
        ],
        folders: [{ type: 'group', key: '/w', cwd: '/w', label: 'w', rootIds: [] }],
      }),
    );
    expect(rows.map((r) => r.kind)).toEqual(['project', 'folder']);
    for (const row of rows) expect(row.closed).toBe(false);
  });

  it('gives a project row no provider mark, even when its sessions have one', () => {
    // A project can hold sessions from several providers at once, and it is a
    // container rather than a session itself — 'none' tells the client to
    // draw an empty icon box; the section-header CSS is what says "root" here.
    const rows = buildViewModel(
      input(forestOf([node(A)]), {
        projects: [
          {
            type: 'project',
            projectId: 'p1',
            label: 'API',
            rootDir: '/code/api',
            dirs: ['/code/api'],
            provider: 'codex',
            rootIds: [],
          },
        ],
      }),
    );
    expect(rows[0].kind).toBe('project');
    expect(rows[0].icon).toEqual({ type: 'codicon', id: 'none' });
  });

  it('gives a project row the chat and then the new-session action, both named after it', () => {
    const rows = buildViewModel(
      input(forestOf([node(A)]), {
        projects: [
          {
            type: 'project',
            projectId: 'p1',
            label: 'API',
            rootDir: '/code/api',
            dirs: ['/code/api'],
            provider: 'claude',
            rootIds: [],
          },
        ],
      }),
    );
    // Order is the contract, not just the contents: the client paints the strip
    // left to right, and the `+` is specified to sit RIGHT of the chat glyph.
    expect(rows[0].actions).toEqual([
      { id: 'chat', icon: 'chat', title: 'Chat in API' },
      { id: 'newSession', icon: 'add', title: 'New Session in API' },
    ]);
  });

  it('gives session and folder rows no actions at all', () => {
    // Absent rather than empty: the client only reserves the button column's
    // width for rows that carry one, so session-row geometry never shifts.
    const rows = buildViewModel(
      input(forestOf([node(A)]), {
        folders: [
          { type: 'group', key: '/w', cwd: '/w', label: 'w', rootIds: [A] },
        ],
      }),
    );
    expect(rows.map((r) => r.kind)).toEqual(['folder', 'session']);
    for (const row of rows) expect(row.actions).toBeUndefined();
  });

  it('keeps `closed` on a row that has been put away — it cannot be inferred', () => {
    // The case that proves the field has to exist: hidden wins the tone, so
    // there is no badgeKind to read "closed" back out of.
    const row = buildViewModel(
      input(
        forestOf([node(A, { hidden: true, archived: true, status: 'exited' })]),
        { loose: [A] },
      ),
    )[0];
    expect(row.closed).toBe(true);
    expect(row.badgeKind).toBeUndefined();
    // The hover is the last place the fact survives on a muted row.
    expect(row.tooltip).toContain('closed');
  });

  it('badgeGlyph gives only the lit tones a character', () => {
    expect(badgeGlyph('running')).toBe(STATUS_DOT);
    expect(badgeGlyph('done')).toBe(STATUS_DOT);
    // Nothing for the quiet tones — including 'closed' since M19.
    expect(badgeGlyph('closed')).toBeUndefined();
    expect(badgeGlyph('idle')).toBeUndefined();
    expect(badgeGlyph(undefined)).toBeUndefined();
  });

  // M19 — the struck-through bell, right of the name.
  describe('the notification mark', () => {
    const marksOf = (over: Partial<SessionNode>): unknown =>
      buildViewModel(input(forestOf([node(A, over)]), { loose: [A] }))[0].marks;

    it('marks a session whose notifications are hidden', () => {
      expect(marksOf({ notifyMuted: true })).toEqual([
        { icon: 'bell-slash', title: 'Notifications hidden' },
      ]);
    });

    it('leaves an ordinary row without the field at all', () => {
      // Absent, not empty: a row with nothing to mark must cost no width, and
      // the client only appends the box for rows that carry one.
      expect(marksOf({})).toBeUndefined();
    });

    it('says so in the hover too — the native tree draws no bell', () => {
      const row = buildViewModel(
        input(forestOf([node(A, { notifyMuted: true })]), { loose: [A] }),
      )[0];
      expect(row.tooltip).toContain('notifications: hidden');
    });

    it('never marks a project row', () => {
      const rows = buildViewModel(
        input(forestOf([]), {
          projects: [
            {
              type: 'project',
              projectId: 'p1',
              label: 'API',
              rootDir: '/code/api',
              dirs: ['/code/api'],
              provider: 'claude',
              rootIds: [],
            },
          ],
        }),
      );
      expect(rows[0].marks).toBeUndefined();
    });
  });

  it('never puts the word "closed" in a row description', () => {
    // It is a dimmed row now, not a word competing with the age for the same
    // few pixels.
    for (const over of [
      { archived: true, status: 'exited' as const },
      { ghost: true, status: 'exited' as const },
      { status: 'exited' as const },
      { hidden: true, archived: true, status: 'exited' as const },
    ]) {
      const rows = buildViewModel(
        input(forestOf([node(A, over)]), { loose: [A] }),
      );
      for (const row of rows) expect(row.description).not.toContain('closed');
    }
  });

  it('gives a ghost no provider — an inferred node has none to claim', () => {
    const rows = buildViewModel(
      input(
        forestOf([node(A, { ghost: true, status: 'exited' })]),
        { loose: [A] },
      ),
    );
    expect(rows[0].icon).toEqual({
      type: 'codicon',
      id: 'circle-slash',
      tone: 'brand',
    });
    // …and cannot be renamed: there is no editorial identity behind it.
    expect(rows[0].canRename).toBe(false);
    expect(rows[0].canDrag).toBe(false);
  });

  it('uses the provider mark for a real session', () => {
    const rows = buildViewModel(
      input(forestOf([node(A)]), { loose: [A] }, { providerFor: () => 'codex' }),
    );
    expect(rows[0].icon).toEqual({ type: 'provider', provider: 'codex' });
    expect(rows[0].canRename).toBe(true);
  });

  it('spells out both timestamps in the tooltip when both are known', () => {
    const rows = buildViewModel(
      input(
        forestOf([
          node(A, {
            startedAt: Date.parse('2026-07-01T10:00:00.000Z'),
            lastActiveAt: Date.parse('2026-07-01T12:00:00.000Z'),
            status: 'idle',
          }),
        ]),
        { loose: [A] },
      ),
    );
    expect(rows[0].tooltip).toContain('started: 2026-07-01T10:00:00.000Z');
    expect(rows[0].tooltip).toContain(
      'last active: 2026-07-01T12:00:00.000Z',
    );
  });

  it('omits the last-active tooltip line cleanly when it is unset', () => {
    const rows = buildViewModel(
      input(
        forestOf([
          node(A, {
            startedAt: Date.parse('2026-07-01T10:00:00.000Z'),
            status: 'idle',
          }),
        ]),
        { loose: [A] },
      ),
    );
    expect(rows[0].tooltip).toContain('started: 2026-07-01T10:00:00.000Z');
    expect(rows[0].tooltip).not.toContain('last active:');
  });

  it('survives a providerFor that throws', () => {
    const rows = buildViewModel(
      input(
        forestOf([node(A)]),
        { loose: [A] },
        {
          providerFor: () => {
            throw new Error('boom');
          },
        },
      ),
    );
    // A broken dependency must never blank a row.
    expect(rows).toHaveLength(1);
    expect(rows[0].icon.type).toBe('codicon');
  });
});

describe('buildViewModel: the row context (native menus + command args)', () => {
  it('publishes viewItem so the /;token;/ when-clauses work verbatim', () => {
    const rows = buildViewModel(
      input(
        forestOf([node(A, { status: 'idle', source: 'minted' })]),
        { loose: [A] },
      ),
    );
    const ctx = rows[0].context;
    expect(ctx.viewItem).toBe(';session;shown;notified;live;idle;ours;root;');
    expect(ctx.webviewSection).toBe('session');
    expect(ctx.webviewId).toBe(VIEW);
    // sessionIdFromArg() reads `id`, so every per-session verb takes this
    // object unchanged — that is what keeps all 14 handlers working.
    expect(ctx.id).toBe(A);
    expect(ctx.preventDefaultContextMenuItems).toBe(true);
  });

  it('marks a hidden row so the menu offers Unhide instead of Hide', () => {
    const rows = buildViewModel(
      input(forestOf([node(A, { hidden: true })]), { loose: [A] }),
    );
    expect(rows[0].context.viewItem).toContain(';hidden;');
    expect(rows[0].context.viewItem).not.toContain(';shown;');
  });

  it('shapes a project row for projectIdFromArg', () => {
    const rows = buildViewModel(
      input(forestOf([]), {
        projects: [
          {
            type: 'project',
            projectId: 'p1',
            label: 'API',
            rootDir: '/code/api',
            dirs: ['/code/api', '/code/infra'],
            provider: 'claude',
            rootIds: [],
          },
        ],
      }),
    );
    expect(rows[0].context.type).toBe('project');
    expect(rows[0].context.projectId).toBe('p1');
    expect(rows[0].context.viewItem).toBe(';project;empty;');
    // The project row says NOTHING. `+1 dir` was true and useless — a fact you
    // set up once, restated forever in the widest row in the tree. It lives in
    // the hover now, which is where a permanent fact belongs.
    expect(rows[0].description).toBe('');
    expect(rows[0].tooltip).toContain('/code/api');
  });

  it('shapes a folder row for groupCwdFromArg, including "(unknown)"', () => {
    const rows = buildViewModel(
      input(forestOf([]), {
        folders: [
          { type: 'group', key: '/w', cwd: '/w', label: 'w', rootIds: [] },
          {
            type: 'group',
            key: '(unknown)',
            cwd: '',
            label: '(unknown)',
            rootIds: [],
          },
        ],
      }),
    );
    expect(rows[0].context.type).toBe('group');
    expect(rows[0].context.cwd).toBe('/w');
    // cwd '' is what makes unknownGroupRefusal() explain itself instead of the
    // verb silently retargeting a different folder.
    expect(rows[1].context.cwd).toBe('');
    expect(rows[1].label).toBe('(unknown)');
  });
});

describe('attentionCountOf', () => {
  it('counts waiting rows that are actually rendered', () => {
    const forest = forestOf([
      node(A, { status: 'waiting', attention: 'waiting' }),
      node(B, { status: 'waiting', attention: 'waiting' }),
    ]);
    expect(
      attentionCountOf(forest, { ...EMPTY_GROUPING, loose: [A, B] }),
    ).toBe(2);
  });

  it('ignores a waiting row no group handed over', () => {
    // Removed by a hidden folder / hidden project / onlyProjectSessions: badging
    // it would leave a count with no row anywhere to open or dismiss.
    const forest = forestOf([node(A, { status: 'waiting', attention: 'waiting' })]);
    expect(attentionCountOf(forest, EMPTY_GROUPING)).toBe(0);
  });

  it('ignores a muted row', () => {
    const forest = forestOf([
      node(A, { status: 'waiting', attention: 'waiting', hidden: true }),
    ]);
    expect(attentionCountOf(forest, { ...EMPTY_GROUPING, loose: [A] })).toBe(0);
  });

  it('still counts a waiting row inside a collapsed parent', () => {
    // It is one click from view and its ancestor IS on screen.
    const forest = forestOf([
      node(A, { visibleChildren: [B] }),
      node(B, { parentId: A, status: 'waiting', attention: 'waiting' }),
    ]);
    expect(attentionCountOf(forest, { ...EMPTY_GROUPING, loose: [A] })).toBe(1);
  });
});

// ---------------------------------------------------- M20 branch rows

import {
  branchRowKey,
  othersRowKey,
  BRANCH_CHIPS_MIN,
} from '../src/viewmodel';
import type { BranchInfo, ProjectGroupNode } from '../src/types';

function branch(
  name: string,
  dir: string,
  colorIndex: number,
  rootIds: string[] = [],
  primary = false,
  shown = true,
): BranchInfo {
  return { name, dir, colorIndex, rootIds, primary, shown };
}

function projectNode(
  branches: BranchInfo[],
  rootIds: string[] = [],
  over: Partial<ProjectGroupNode> = {},
): ProjectGroupNode {
  return {
    type: 'project',
    projectId: 'p1',
    label: 'App',
    rootDir: '/code/app',
    dirs: ['/code/app'],
    provider: 'claude' as ProviderId,
    rootIds,
    branches,
    ...over,
  };
}

const MAIN = branch('main', '/code/app', 0, [A], true);
const FEAT = branch('feat/x', '/code/app-feat-x', 1, [B]);

const forest2 = () =>
  forestOf([
    node(A, { cwd: '/code/app/src' }),
    node(B, { cwd: '/code/app-feat-x' }),
  ]);

const rowsFor = (branches: BranchInfo[], over: Partial<ProjectGroupNode> = {}) =>
  buildViewModel(
    input(forest2(), { projects: [projectNode(branches, [A, B], over)] }),
  );

describe('buildViewModel: branch rows (M20)', () => {
  it('stacks one row per branch between the header and the sessions', () => {
    // The strip this replaced put every branch on one line, which lost to the
    // fact that branch names are long. Stacked, each gets the sidebar's width.
    expect(keys(rowsFor([MAIN, FEAT]))).toEqual([
      projectRowKey('p1'),
      branchRowKey('p1', 'main'),
      branchRowKey('p1', 'feat/x'),
      sessionRowKey(A),
      sessionRowKey(B),
    ]);
  });

  it('draws nothing below the threshold', () => {
    // An ordinary repository with no worktrees sees the pre-M20 tree exactly.
    expect(keys(rowsFor([MAIN]))).toEqual([
      projectRowKey('p1'),
      sessionRowKey(A),
      sessionRowKey(B),
    ]);
    expect(BRANCH_CHIPS_MIN).toBe(2);
  });

  it('carries the branch name whole, never pre-truncated', () => {
    const long = branch('feat/discussion-points-hawaiian-locale', '/code/w', 1, [B]);
    const rows = rowsFor([MAIN, long]);
    const row = rows.find((r) => r.kind === 'branch' && r.chip?.primary === false);
    // WHOLE, not pre-cut: the stylesheet truncates from the end at the actual
    // available width, so the model must hand it the real name.
    expect(row?.label).toBe(long.name);
    expect(row?.chip?.full).toBe(long.name);
    expect(row?.chip?.dir).toBe('/code/w');
    expect(row?.cwd).toBe('/code/w');
  });

  it('counts sessions and lights the branch that has finished work', () => {
    const unseen = forestOf([
      node(A, { cwd: '/code/app/src' }),
      node(B, { cwd: '/code/app-feat-x', status: 'waiting', unseen: true }),
    ]);
    const rows = buildViewModel(
      input(unseen, { projects: [projectNode([MAIN, FEAT], [A, B])] }),
    );
    const branchRows = rows.filter((r) => r.kind === 'branch');
    expect(branchRows.map((r) => r.chip?.count)).toEqual([1, 1]);
    expect(branchRows.map((r) => r.chip?.attention)).toEqual([false, true]);
  });

  it('hides a branch the grouping marked unshown, and counts it under Others', () => {
    const hidden = branch('feat/y', '/code/app-y', 2, [], false, false);
    const rows = rowsFor([MAIN, FEAT, hidden]);
    expect(keys(rows)).toEqual([
      projectRowKey('p1'),
      branchRowKey('p1', 'main'),
      branchRowKey('p1', 'feat/x'),
      othersRowKey('p1'),
      sessionRowKey(A),
      sessionRowKey(B),
    ]);
    const others = rows.find((r) => r.kind === 'branchOthers');
    expect(others?.othersCount).toBe(1);
    expect(others?.description).toBe('1');
  });

  it('omits Others when everything is shown', () => {
    expect(rowsFor([MAIN, FEAT]).some((r) => r.kind === 'branchOthers')).toBe(false);
  });

  it('folds the whole block away, leaving the project row to say so', () => {
    const rows = rowsFor([MAIN, FEAT], { branchesCollapsed: true });
    expect(keys(rows)).toEqual([
      projectRowKey('p1'),
      sessionRowKey(A),
      sessionRowKey(B),
    ]);
    // Folded, the chevron offers the way back and names what is behind it.
    const fold = rows[0].actions?.find((x) => x.id === 'unfoldBranches');
    expect(fold?.icon).toBe('chevron-right');
    expect(fold?.title).toContain('2');
  });

  it('offers the fold chevron only where there is a block to fold', () => {
    expect(rowsFor([MAIN, FEAT])[0].actions?.map((x) => x.id)).toEqual([
      'foldBranches',
      'chat',
    ]);
    // Below the threshold: no chevron, and the `+` is back because the branch
    // rows are not there to replace it.
    expect(rowsFor([MAIN])[0].actions?.map((x) => x.id)).toEqual([
      'chat',
      'newSession',
    ]);
  });

  it('colours each session name with its own branch', () => {
    const rows = rowsFor([MAIN, FEAT]);
    expect(rows.find((r) => r.sessionId === A)?.branchColor).toBe(0);
    expect(rows.find((r) => r.sessionId === B)?.branchColor).toBe(1);
    expect(rows.find((r) => r.sessionId === A)?.branch).toBe('main');
  });

  it('still colours a session whose branch is hidden from the list', () => {
    // Hiding is a statement about how many ROWS the block is worth, never about
    // the sessions underneath. A session that lost its colour because you tidied
    // the list above it would read as having moved.
    const hiddenFeat = branch('feat/x', '/code/app-feat-x', 1, [B], false, false);
    const rows = rowsFor([MAIN, hiddenFeat]);
    expect(rows.some((r) => r.key === branchRowKey('p1', 'feat/x'))).toBe(false);
    expect(rows.find((r) => r.sessionId === B)?.branchColor).toBe(1);
  });

  it('colours a fork by ITS OWN cwd, not its parent branch', () => {
    const forked = forestOf([
      node(A, { cwd: '/code/app/src', visibleChildren: [B] }),
      node(B, { parentId: A, cwd: '/code/app-feat-x' }),
    ]);
    const rows = buildViewModel(
      input(forked, { projects: [projectNode([MAIN, FEAT], [A])] }),
    );
    expect(rows.find((r) => r.sessionId === A)?.branchColor).toBe(0);
    expect(rows.find((r) => r.sessionId === B)?.branchColor).toBe(1);
  });

  it('names the branch in a session hover even below the threshold', () => {
    const rows = rowsFor([MAIN]);
    const a = rows.find((r) => r.sessionId === A);
    expect(a?.branchColor).toBeUndefined();
    expect(a?.branch).toBe('main');
    expect(a?.tooltip).toContain('branch: main');
  });

  it('gives branch rows their own context tokens, and flags the primary one', () => {
    const rows = rowsFor([MAIN, FEAT]);
    const [mainRow, featRow] = rows.filter((r) => r.kind === 'branch');
    // Both rows carry the same projectId as the header; distinct tokens are what
    // stop the project's whole menu appearing on them.
    expect(mainRow.context.viewItem).toBe(';branch;primary;');
    expect(featRow.context.viewItem).toBe(';branch;');
    expect(rows[0].context.viewItem).toContain(';project;');
    // The shape branchArgOf() reads, so a context-menu verb takes it verbatim.
    expect(featRow.context.type).toBe('branch');
    expect(featRow.context.branch).toBe('feat/x');
    expect(featRow.context.dir).toBe('/code/app-feat-x');
  });

  it('marks the Others row as its own kind, not as a branch', () => {
    const hidden = branch('feat/y', '/code/app-y', 2, [], false, false);
    const others = rowsFor([MAIN, FEAT, hidden]).find(
      (r) => r.kind === 'branchOthers',
    );
    // None of the branch verbs apply — there is no single worktree behind it.
    expect(others?.context.viewItem).toBe(';branchOthers;');
    expect(others?.chip).toBeUndefined();
    expect(others?.canRename).toBe(false);
    expect(others?.canDrag).toBe(false);
  });

  it('hides the whole block with the project collapsed', () => {
    const rows = buildViewModel(
      input(
        forest2(),
        { projects: [projectNode([MAIN, FEAT], [A, B])] },
        { collapsed: new Set([projectRowKey('p1')]) },
      ),
    );
    expect(keys(rows)).toEqual([projectRowKey('p1')]);
  });

  it('leaves a session outside every worktree uncoloured', () => {
    const stray = forestOf([node(A, { cwd: '/somewhere/else' })]);
    const rows = buildViewModel(
      input(stray, { projects: [projectNode([MAIN, FEAT], [A])] }),
    );
    expect(rows.find((r) => r.sessionId === A)?.branchColor).toBeUndefined();
    expect(rows.find((r) => r.sessionId === A)?.branch).toBeUndefined();
  });

  it('does not colour rows under a folder row', () => {
    // branchScope is a PROJECT's answer. A session under a folder row must not
    // pick up the colours of whichever project rendered last.
    const rows = buildViewModel(
      input(forestOf([node(A, { cwd: '/code/app/src' })]), {
        projects: [projectNode([MAIN, FEAT], [])],
        folders: [
          { type: 'group', key: '/code/app', cwd: '/code/app', label: 'app', rootIds: [A] },
        ],
      }),
    );
    expect(rows.find((r) => r.sessionId === A)?.branchColor).toBeUndefined();
  });

  it('keys a branch row by name, colons and all', () => {
    // A branch name may legally contain a colon; the key must survive it.
    const odd = branch('feat:thing', '/code/w', 1, []);
    const rows = rowsFor([MAIN, odd]);
    expect(rows.some((r) => r.key === 'branch:p1:feat:thing')).toBe(true);
  });
});
