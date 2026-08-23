// test/viewmodel.test.ts — the webview sidebar's model.
//
// This is where the whole rendering decision lives, so it is where the tests
// live: the webview client is a dumb painter with no model of its own.

import { describe, expect, it } from 'vitest';

import {
  SNIPPET_MAX_CHARS,
  attentionCountOf,
  badgeGlyph,
  buildViewModel,
  folderRowKey,
  formatGraceCountdown,
  projectRowKey,
  runningCountOf,
  sessionBranchLine,
  sessionRowKey,
  sessionSnippet,
  subtreeHasRunning,
} from '../src/viewmodel';
import type { ViewModelInput } from '../src/viewmodel';
import { CLOSED_DOT, STATUS_DOT } from '../src/types';
import type {
  BranchStatus,
  ProviderId,
  PullRequest,
  PullRequestChecks,
  PullRequestState,
  SessionForest,
  SessionNode,
} from '../src/types';
import { HIDDEN_RUNNING_GROUP_KEY } from '../src/projects';
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
  outOfScopeCount: 0,
  hiddenRunning: null,
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

  // REGRESSION. A session started hours ago but typed into seconds ago must
  // read as "just now", not "hours ago" — the age basis is lastActiveAt, never
  // startedAt.
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

  // The transcript's mtime moves for every token Claude writes, so a
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
    // that row must degrade to the mtime or the start time, not to blank.
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

  it('gives a dead row a tone but no mark of its own', () => {
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
      { id: 'chat', icon: 'chat', title: 'New chat in API' },
      { id: 'newSession', icon: 'add', title: 'New session in API' },
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
    // Compaction: the same filled dot once it has settled, the hollow ring
    // while it runs. The webview draws both in CSS and only asks whether there
    // is anything to draw; the native tree types these two characters into a
    // FileDecoration badge, which can hold nothing else.
    expect(badgeGlyph('compacted')).toBe(STATUS_DOT);
    expect(badgeGlyph('compacting')).toBe(CLOSED_DOT);
    // Nothing for the quiet tones, 'closed' included.
    expect(badgeGlyph('closed')).toBeUndefined();
    expect(badgeGlyph('idle')).toBeUndefined();
    expect(badgeGlyph(undefined)).toBeUndefined();
  });

  describe('the compaction mark', () => {
    const rowOf = (over: Partial<SessionNode>): { badge?: string; badgeKind?: string; tooltip: string } => {
      const row = buildViewModel(
        input(forestOf([node(A, over)]), { loose: [A] }),
      )[0] as { badge?: string; badgeKind?: string; tooltip: string };
      return row;
    };

    it('rings a compacting session instead of drawing it as running', () => {
      // The whole point: a compacting session reports `busy`, and before this
      // the row wore the amber running dot for work nobody asked for.
      const row = rowOf({ status: 'busy', compaction: 'compacting' });
      expect(row.badgeKind).toBe('compacting');
      expect(row.badge).toBe(CLOSED_DOT);
      expect(row.tooltip).toContain('compacting');
    });

    it('fills the dot when the compaction is over and nothing is behind it', () => {
      // A compaction ends with the session quiet and waiting, which is the red
      // attention dot's territory — so the purple has to outrank it, or it
      // would never draw at all. Withholding the phase while the session is
      // busy again is src/compaction.ts's job, not this one's.
      const row = rowOf({
        status: 'waiting',
        attention: 'waiting',
        compaction: 'compacted',
      });
      expect(row.badgeKind).toBe('compacted');
      expect(row.badge).toBe(STATUS_DOT);
      expect(row.tooltip).toContain('compacted');
    });

    it('still refuses a lit mark to a row that was put away', () => {
      // Hide is "stop telling me about this one", and it outranks every tone —
      // compaction included.
      const row = rowOf({ hidden: true, compaction: 'compacting' });
      expect(row.badgeKind).toBeUndefined();
      expect(row.badge).toBeUndefined();
    });

    it('lets a closed row stay closed', () => {
      const row = rowOf({ archived: true, compaction: 'compacted' });
      expect(row.badgeKind).toBe('closed');
      expect(row.badge).toBeUndefined();
    });
  });

  // The struck-through bell, right of the name.
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

  it('offers the drag to top-level rows only — a fork is frozen where it is', () => {
    // What a drag can change is which project a session is filed under, and a
    // row drawn inside a tree has no filing of its own: it is wherever the
    // session it branched from is. So the rows that move are exactly the ones
    // at the top of their group, which is also the only rule that can be read
    // off the screen. Renaming is unaffected — a fork has a name of its own.
    const rows = buildViewModel(
      input(
        forestOf([
          node(A, { visibleChildren: [B] }),
          node(B, { parentId: A, visibleChildren: [C] }),
          node(C, { parentId: B }),
        ]),
        { loose: [A] },
      ),
    );
    expect(rows.map((r) => [r.depth, r.canDrag])).toEqual([
      [0, true],
      [1, false],
      [2, false],
    ]);
    expect(rows.every((r) => r.canRename)).toBe(true);
  });

  it('still offers it to a root drawn UNDER a project, where depth is not 0', () => {
    // The trap this rule has to avoid: a project row and its directory rows are
    // above every session in the outline, so `depth` is 1 or 2 for sessions
    // that are perfectly ordinary roots — and keying the drag on depth would
    // have frozen the exact gesture that survives (file this session under that
    // project). What separates them is being drawn inside a TREE, which is what
    // the spine (`rails`) records.
    const rows = buildViewModel(
      input(
        forestOf([node(A, { visibleChildren: [B] }), node(B, { parentId: A })]),
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
        },
      ),
    );
    const sessions = rows.filter((r) => r.kind === 'session');
    expect(sessions.map((r) => [r.depth, r.rails.length, r.canDrag])).toEqual([
      [1, 0, true], // the root: nested by the PROJECT, not by a tree
      [2, 1, false], // its fork
    ]);
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
    expect(ctx.viewItem).toBe(
      ';session;shown;notified;live;idle;hosted;ours;root;',
    );
    expect(ctx.webviewSection).toBe('session');
    expect(ctx.webviewId).toBe(VIEW);
    // sessionIdFromArg() reads `id`, so every per-session verb takes this
    // object unchanged — that is what keeps all 14 handlers working.
    expect(ctx.id).toBe(A);
    expect(ctx.preventDefaultContextMenuItems).toBe(true);
  });

  // A session Flock did not launch has to READ as one — otherwise the only
  // clue is that its menu is one entry shorter than its neighbour's.
  it('marks a foreign row "elsewhere" and says why in the hover', () => {
    const rows = buildViewModel(
      input(forestOf([node(A, { status: 'idle' })]), { loose: [A] }, {
        hostOf: () => 'foreign',
      }),
    );
    expect(rows[0].description).toContain('elsewhere');
    expect(rows[0].tooltip).toContain('outside Flock');
    expect(rows[0].context.viewItem).toContain(';foreign;');
  });

  it('marks nothing when Flock owns the session, or when nothing knows', () => {
    for (const hostOf of [
      () => 'here' as const,
      () => 'flock' as const,
      undefined,
    ]) {
      const rows = buildViewModel(
        input(forestOf([node(A, { status: 'idle' })]), { loose: [A] }, {
          ...(hostOf === undefined ? {} : { hostOf }),
        }),
      );
      expect(rows[0].description).not.toContain('elsewhere');
      expect(rows[0].tooltip).not.toContain('outside Flock');
      expect(rows[0].context.viewItem).toContain(';hosted;');
    }
  });

  it('survives a throwing hostOf by claiming nothing about ownership', () => {
    const rows = buildViewModel(
      input(forestOf([node(A, { status: 'idle' })]), { loose: [A] }, {
        hostOf: () => {
          throw new Error('no roster');
        },
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].description).not.toContain('elsewhere');
    expect(rows[0].context.viewItem).toContain(';hosted;');
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

  it('shapes a folder row for groupCwdFromArg, including "(no directory)"', () => {
    const rows = buildViewModel(
      input(forestOf([]), {
        folders: [
          { type: 'group', key: '/w', cwd: '/w', label: 'w', rootIds: [] },
          {
            type: 'group',
            key: '(unknown)',
            cwd: '',
            label: '(no directory)',
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
    expect(rows[1].label).toBe('(no directory)');
    // Identity survives the label: collapse state round-trips through key.
    expect(rows[1].context.key).toBe('(unknown)');
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

// ---------------------------------------------------- the three visual states

describe('formatGraceCountdown', () => {
  it('rounds UP to whole minutes — a countdown never claims time it lost', () => {
    expect(formatGraceCountdown(9 * 60_000 + 41_000)).toBe('closing in 10m');
    expect(formatGraceCountdown(60_000)).toBe('closing in 1m');
    expect(formatGraceCountdown(20_000)).toBe('closing in 1m');
  });

  it('says "closing now" past the deadline — the row must not go quiet', () => {
    // A busy session outlives its deadline on purpose (close-after-turn);
    // its row keeps saying the process is on its way out.
    expect(formatGraceCountdown(0)).toBe('closing now');
    expect(formatGraceCountdown(-5_000)).toBe('closing now');
  });

  it('renders nothing for a non-number, same rule as formatAge', () => {
    expect(formatGraceCountdown(Number.NaN)).toBe('');
    expect(formatGraceCountdown(Number.POSITIVE_INFINITY)).toBe('');
  });
});

describe('buildViewModel: the grace countdown state', () => {
  const graceAt = NOW + 9 * 60_000 + 41_000;

  it('puts the countdown in the description and the token in the context', () => {
    const rows = buildViewModel(
      input(forestOf([node(A, { graceDeadlineAt: graceAt })]), { loose: [A] }),
    );
    expect(rows[0].description).toContain('closing in 10m');
    const viewItem = rows[0].context.viewItem as string;
    // Grace is a THIRD token beside live + ownership, never a replacement:
    // the row keeps every live verb and gains Close Now / Keep Awake.
    expect(viewItem).toContain(';grace;');
    expect(viewItem).toContain(';live;');
    expect(viewItem).toContain(';hosted;');
  });

  it('keeps the token and says "closing now" past the deadline', () => {
    const rows = buildViewModel(
      input(forestOf([node(A, { graceDeadlineAt: NOW - 1_000 })]), {
        loose: [A],
      }),
    );
    expect(rows[0].description).toContain('closing now');
    expect(rows[0].context.viewItem as string).toContain(';grace;');
  });

  it('spells out the deal and the absolute deadline in the hover', () => {
    const rows = buildViewModel(
      input(forestOf([node(A, { graceDeadlineAt: graceAt })]), { loose: [A] }),
    );
    expect(rows[0].tooltip).toContain(
      'detached: tab closed, process kept for instant re-attach',
    );
    expect(rows[0].tooltip).toContain(
      `closes at ${new Date(graceAt).toISOString()}`,
    );
  });

  it('never marks a row that is not under grace', () => {
    const rows = buildViewModel(input(forestOf([node(A)]), { loose: [A] }));
    expect(rows[0].description).not.toContain('closing');
    expect(rows[0].context.viewItem as string).not.toContain(';grace;');
  });

  it('never marks an archived row — a dead process has nothing to count down', () => {
    // buildForest only stamps live nodes, but the context builder must hold the
    // line on its own: the grace verbs act on a process, and there is none.
    const rows = buildViewModel(
      input(
        forestOf([
          node(A, { archived: true, status: 'exited', graceDeadlineAt: graceAt }),
        ]),
        { loose: [A] },
      ),
    );
    expect(rows[0].context.viewItem as string).not.toContain(';grace;');
  });
});

describe('sessionSnippet: what a level-2 row concluded', () => {
  it('prefers the summary the user wrote for exactly this line', () => {
    expect(
      sessionSnippet(
        node(A, { summary: 'shipped it', lastExchange: 'the long answer' }),
      ),
    ).toBe('shipped it');
  });

  it('falls back to the last exchange, collapsed to one line', () => {
    expect(
      sessionSnippet(node(A, { lastExchange: 'done —\n  see\tsrc/x.ts' })),
    ).toBe('done — see src/x.ts');
  });

  it('truncates with a visible cut at the cap', () => {
    const got = sessionSnippet(node(A, { lastExchange: 'z'.repeat(200) }));
    expect(got.length).toBe(SNIPPET_MAX_CHARS);
    expect(got.endsWith('…')).toBe(true);
  });

  it('is empty when the node has neither', () => {
    expect(sessionSnippet(node(A))).toBe('');
  });
});

describe('buildViewModel: the archived conclusion', () => {
  it('surfaces the snippet on an archived row', () => {
    const rows = buildViewModel(
      input(
        forestOf([
          node(A, {
            archived: true,
            status: 'exited',
            lastExchange: 'concluded: use BM25',
          }),
        ]),
        { loose: [A] },
      ),
    );
    expect(rows[0].description).toContain('concluded: use BM25');
  });

  it('withholds it from a live row — its last line is on screen in its tab', () => {
    const rows = buildViewModel(
      input(
        forestOf([node(A, { lastExchange: 'concluded: use BM25' })]),
        { loose: [A] },
      ),
    );
    expect(rows[0].description).not.toContain('concluded');
  });

  it('puts the longer text in the hover when no summary was written', () => {
    const rows = buildViewModel(
      input(
        forestOf([
          node(A, {
            archived: true,
            status: 'exited',
            lastExchange: 'concluded: use BM25',
          }),
        ]),
        { loose: [A] },
      ),
    );
    expect(rows[0].tooltip).toContain('last exchange: concluded: use BM25');
  });

  it('does not double up in the hover when a summary exists', () => {
    const rows = buildViewModel(
      input(
        forestOf([
          node(A, {
            archived: true,
            status: 'exited',
            summary: 'shipped it',
            lastExchange: 'the long answer',
          }),
        ]),
        { loose: [A] },
      ),
    );
    expect(rows[0].tooltip).toContain('summary: shipped it');
    expect(rows[0].tooltip).not.toContain('last exchange:');
  });
});

describe('runningCountOf', () => {
  it('counts every live process — grace and unknown status included', () => {
    const forest = forestOf([
      node(A, { status: 'busy' }),
      node(B, { status: 'idle', graceDeadlineAt: NOW + 60_000 }),
      node(C, { status: 'unknown' }),
    ]);
    expect(runningCountOf(forest)).toBe(3);
  });

  it('counts nothing that is over — archived, exited, ghost', () => {
    const forest = forestOf([
      node(A, { archived: true, status: 'exited' }),
      node(B, { status: 'exited' }),
      node(C, { ghost: true, status: 'exited' }),
    ]);
    expect(runningCountOf(forest)).toBe(0);
  });

  it('still counts a MUTED live row — the process is no less real', () => {
    // attentionCountOf excludes hidden rows because muting means "stop
    // demanding me"; the running count is about processes, and a muted row is
    // still on screen (sorted last, greyed).
    const forest = forestOf([node(A, { status: 'busy', hidden: true })]);
    expect(runningCountOf(forest)).toBe(1);
  });

  it('counts MACHINE-WIDE — a live row a filter removed still counts', () => {
    // The badge is the levels invariant as a number: a running process costs
    // the machine the same memory whichever window's filters apply, so every
    // window shows the same count. The rows keep up from the other side — a
    // filtered RUNNING root renders in the "Still running" group.
    const forest = forestOf([node(A, { status: 'busy' })]);
    expect(runningCountOf(forest)).toBe(1);
  });

  it('counts a live row inside a collapsed parent', () => {
    const forest = forestOf([
      node(A, { visibleChildren: [B] }),
      node(B, { parentId: A, status: 'busy' }),
    ]);
    expect(runningCountOf(forest)).toBe(2);
  });

  // The badge must count what the window can SHOW. Folder mode's fence drops
  // other folders' rows outright, so a machine-wide number here would be a
  // badge you cannot click through — the same defect as a rowless process,
  // pointing the other way.
  it('excludes out-of-scope sessions when a scope is given', () => {
    const forest = forestOf([
      node(A, { cwd: '/code/app/src', status: 'busy' }),
      node(B, { cwd: '/code/other', status: 'busy' }),
    ]);
    expect(runningCountOf(forest, ['/code/app'])).toBe(1);
    // No scope (project mode, an empty window, an older wiring): unchanged.
    expect(runningCountOf(forest)).toBe(2);
    expect(runningCountOf(forest, [])).toBe(2);
  });

  it('still counts a session whose cwd it cannot place', () => {
    // modes.outsideScope's asymmetry, carried through: only a POSITIVE
    // "elsewhere" excludes. An unplaceable session keeps its row, so it keeps
    // its place in the count.
    const forest = forestOf([node(A, { status: 'busy' })]);
    expect(runningCountOf(forest, ['/code/app'])).toBe(1);
  });
});

describe('buildViewModel: the "Still running" appendix row', () => {
  const elsewhere = {
    type: 'group' as const,
    key: HIDDEN_RUNNING_GROUP_KEY,
    cwd: '',
    label: 'Still running',
    rootIds: [B],
  };

  it('renders LAST, wears its own token, and lists its sessions when expanded', () => {
    const rows = buildViewModel(
      input(forestOf([node(A), node(B, { status: 'busy' })]), {
        loose: [A],
        hiddenRunning: elsewhere,
      }),
    );
    const last = rows[rows.length - 2];
    expect(last?.kind).toBe('folder');
    expect(last?.label).toBe('Still running');
    // Its own token, NOT ';group;': the folder verbs act on a directory this
    // row does not have.
    expect(last?.context.viewItem).toContain(';elsewhere;');
    expect(last?.context.viewItem).not.toContain(';group;');
    expect(rows[rows.length - 1]?.key).toBe(sessionRowKey(B));
  });

  it('collapsed (the host seeds the key), only the header renders', () => {
    const rows = buildViewModel(
      input(
        forestOf([node(B, { status: 'busy' })]),
        { hiddenRunning: elsewhere },
        { collapsed: new Set([folderRowKey(elsewhere.key)]) },
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe('Still running');
    expect(rows[0]?.expanded).toBe(false);
  });

  it('absent, nothing extra renders', () => {
    const rows = buildViewModel(input(forestOf([node(A)]), { loose: [A] }));
    expect(rows).toHaveLength(1);
  });
});

describe('subtreeHasRunning', () => {
  it('finds a running descendant through the visible chain', () => {
    const forest = forestOf([
      node(A, { archived: true, status: 'exited', visibleChildren: [B] }),
      node(B, { parentId: A, status: 'busy' }),
    ]);
    expect(subtreeHasRunning(forest, A)).toBe(true);
  });

  it('is false for an all-over subtree and an unknown root', () => {
    const forest = forestOf([node(A, { archived: true, status: 'exited' })]);
    expect(subtreeHasRunning(forest, A)).toBe(false);
    expect(subtreeHasRunning(forest, 'ffffffff-0000-4000-8000-00000000ffff')).toBe(
      false,
    );
  });
});

// ------------------------------------------------------------ branch rows

import {
  branchRowKey,
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

/** A project whose branch block has been ASKED FOR, in colour mode.
 *
 *  Both defaults are stated rather than inherited, because both changed: the
 *  block is shut on every project until **Show Branches** writes
 *  `branchesShown: true`, and the display mode a project meets is `inline`.
 *  The tests below are about what the block DRAWS and what a colour does, so
 *  they open it and pick the mode; the ones about the defaults themselves say so
 *  in their names. */
const rowsFor = (
  branches: BranchInfo[],
  over: Partial<ProjectGroupNode> = {},
  input2: Partial<ViewModelInput> = {},
) =>
  buildViewModel(
    input(
      forest2(),
      {
        projects: [
          projectNode(branches, [A, B], { branchesShown: true, ...over }),
        ],
      },
      { branchDisplay: 'color', ...input2 },
    ),
  );

describe('buildViewModel: branch rows', () => {
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
    // An ordinary repository with no worktrees sees no branch rows at all.
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
      input(
        unseen,
        {
          projects: [
            projectNode([MAIN, FEAT], [A, B], { branchesShown: true }),
          ],
        },
        { branchDisplay: 'color' },
      ),
    );
    const branchRows = rows.filter((r) => r.kind === 'branch');
    expect(branchRows.map((r) => r.chip?.count)).toEqual([1, 1]);
    expect(branchRows.map((r) => r.chip?.attention)).toEqual([false, true]);
  });

  it('hides a branch the grouping marked unshown, and leaves no row behind it', () => {
    // There was an "Others (1)" row here — a fold at the tail of the block,
    // standing for the branches not on screen. It is gone: the count is on the
    // project row's hover and **Choose Branches to Show…** on its menu is what
    // the row opened. A fold inside a block that is itself folded was one door
    // too many, and the row nobody could read.
    const hidden = branch('feat/y', '/code/app-y', 2, [], false, false);
    const rows = rowsFor([MAIN, FEAT, hidden]);
    expect(keys(rows)).toEqual([
      projectRowKey('p1'),
      branchRowKey('p1', 'main'),
      branchRowKey('p1', 'feat/x'),
      sessionRowKey(A),
      sessionRowKey(B),
    ]);
    expect(rows[0].tooltip).toContain('1 branch not shown');
  });

  it('folds the whole block away, leaving the project row to say so', () => {
    const rows = rowsFor([MAIN, FEAT], { branchesShown: false });
    expect(keys(rows)).toEqual([
      projectRowKey('p1'),
      sessionRowKey(A),
      sessionRowKey(B),
    ]);
    // Folded, the toggle offers the way back and names what is behind it.
    const fold = rows[0].actions?.find((x) => x.id === 'unfoldBranches');
    expect(fold?.icon).toBe('git-branch');
    expect(fold?.title).toContain('2');
  });

  it('offers the fold toggle only where there is a block to fold', () => {
    expect(rowsFor([MAIN, FEAT])[0].actions?.map((x) => x.id)).toEqual([
      'foldBranches',
      'chat',
      'newSession',
    ]);
    // Below the threshold there is no block, so no toggle.
    expect(rowsFor([MAIN])[0].actions?.map((x) => x.id)).toEqual([
      'chat',
      'newSession',
    ]);
  });

  it('marks the fold with a BRANCH glyph, in both positions and both modes', () => {
    // Not a chevron. The row's own twisty is already a chevron and already means
    // "this opens" — a second one says "more below" where this has to say WHAT
    // is below. The same glyph open and shut, because the state is the block
    // itself: six rows on screen, or none.
    for (const display of ['color', 'inline'] as const) {
      const open = rowsFor([MAIN, FEAT], {}, { branchDisplay: display });
      const shut = rowsFor(
        [MAIN, FEAT],
        { branchesShown: false },
        { branchDisplay: display },
      );
      expect(open[0].actions?.[0]).toEqual({
        id: 'foldBranches',
        icon: 'git-branch',
        title: 'Hide branches',
      });
      expect(shut[0].actions?.[0]).toEqual({
        id: 'unfoldBranches',
        icon: 'git-branch',
        title: 'Show 2 branches',
      });
    }
  });

  it('draws no branch rows until the block has been asked for', () => {
    // The default, in BOTH modes: a project with six checkouts is not six rows
    // before its first session on anybody who has never opened the block.
    for (const display of ['color', 'inline'] as const) {
      const rows = buildViewModel(
        input(
          forest2(),
          { projects: [projectNode([MAIN, FEAT], [A, B])] },
          { branchDisplay: display },
        ),
      );
      expect(rows.some((r) => r.kind === 'branch'), display).toBe(false);
      expect(rows.map((r) => r.key), display).toEqual([
        projectRowKey('p1'),
        sessionRowKey(A),
        sessionRowKey(B),
      ]);
    }
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
      input(forked, { projects: [projectNode([MAIN, FEAT], [A])] }, {
        branchDisplay: 'color',
      }),
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
    //
    // `checkout` is on both because both came from a worktree, which is the only
    // way a branch row exists at all with the directory preview off. It is the
    // token the verbs needing a directory match on — see the ContextToken note.
    expect(mainRow.context.viewItem).toBe(';branch;primary;checkout;');
    expect(featRow.context.viewItem).toBe(';branch;checkout;');
    expect(rows[0].context.viewItem).toContain(';project;');
    // The shape branchArgOf() reads, so a context-menu verb takes it verbatim.
    expect(featRow.context.type).toBe('branch');
    expect(featRow.context.branch).toBe('feat/x');
    expect(featRow.context.dir).toBe('/code/app-feat-x');
  });

  it('titles the + on a branch with no checkout after what it will do', () => {
    // The row that used to refuse the button. It cuts the worktree first now,
    // through New Worktree…'s own confirmation, and the title is what stops that
    // being a surprise: a `+` that is about to write has to say so before it is
    // clicked.
    const ref = branch('feat/y', '', 2, [], false, true);
    const row = rowsFor([MAIN, FEAT, ref]).find(
      (r) => r.key === branchRowKey('p1', 'feat/y'),
    );
    expect(row?.actions?.map((a) => a.id)).toEqual(['newSessionInBranch']);
    expect(row?.actions?.[0].title).toBe('New worktree and session on feat/y');
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

// ---------------------------------------------------------------------------
// The branch, on a second line under the session (`lineage.git.sessionBranch`).
//
// Two things are under test and they are worth naming separately: the FORMATTER,
// which decides what a line says at each detail level, and the RULE, which
// decides which rows get one at all. The rule is the half that can quietly go
// wrong — a line on every row is a tree twice as tall for no new information.

describe('sessionBranchLine', () => {
  const status = (over: Partial<BranchStatus> = {}): BranchStatus => ({
    upstream: 'origin/feat/x',
    ahead: 0,
    behind: 0,
    dirty: false,
    untracked: false,
    ...over,
  });
  const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
    number: 128,
    title: 'Rank by BM25',
    state: 'open' as PullRequestState,
    checks: 'pass' as PullRequestChecks,
    branch: 'feat/x',
    url: 'https://github.com/acme/app/pull/128',
    ...over,
  });

  it('says the branch and where the checkout stands, and nothing else', () => {
    expect(
      sessionBranchLine('feat/x', status({ ahead: 4, dirty: true }), undefined, 'standard'),
    ).toEqual({
      name: 'feat/x',
      glyph: 'git-branch',
      // Against the NAME, not out with the arrows: `↑4` is where this checkout
      // stands against its upstream and the star is what is in it.
      dirty: true,
      link: true,
      sync: '↑4',
    });
  });

  it('makes the name a link only where there is a page to open', () => {
    // `upstream` non-empty is the probe saying this branch tracks a remote one,
    // which is the only case where a branch page can exist. A branch nobody has
    // pushed and a branch nobody has looked at both draw plain text — a name
    // that looks clickable has to be.
    expect(sessionBranchLine('feat/x', status(), undefined, 'standard').link).toBe(true);
    expect(
      sessionBranchLine('spike/x', status({ upstream: '' }), undefined, 'standard').link,
    ).toBeUndefined();
    expect(sessionBranchLine('spike/x', undefined, undefined, 'standard').link).toBeUndefined();
  });

  it('carries the checkout back for the link to resolve through, undrawn', () => {
    expect(
      sessionBranchLine('feat/x', status(), undefined, 'standard', '/code/app-feat-x').dir,
    ).toBe('/code/app-feat-x');
    // Absent rather than '', so a line with no directory behind it costs the
    // same as one that never had the field.
    expect(sessionBranchLine('feat/x', status(), undefined, 'standard').dir).toBeUndefined();
  });

  it('reserves no width when there is nothing to report', () => {
    // Absent, not '' — the rule every other optional row field follows, and what
    // stops a column of clean branches from holding a gap open.
    expect(sessionBranchLine('main', status(), undefined, 'standard')).toEqual({
      name: 'main',
      glyph: 'git-branch',
      link: true,
    });
    expect(sessionBranchLine('main', undefined, undefined, 'standard')).toEqual({
      name: 'main',
      glyph: 'git-branch',
    });
  });

  it('withholds the request at the standard level, even when there is one', () => {
    // The standard level is the vocabulary a git prompt already speaks. A chip
    // in it would be the second dialect the whole level exists to avoid.
    expect(
      sessionBranchLine('feat/x', status({ behind: 3 }), pr(), 'standard'),
    ).toEqual({ name: 'feat/x', glyph: 'git-branch', link: true, sync: '↓3' });
  });

  it('withholds the request MARK at the standard level too', () => {
    // The shape and colour of the mark are the request's, and the standard level
    // does not consult it — so a green arrow here would be the same second
    // dialect a chip would be, drawn from a source this level otherwise ignores.
    const line = sessionBranchLine('feat/x', status(), pr(), 'standard');
    expect(line.glyph).toBe('git-branch');
    expect(line.state).toBeUndefined();
  });

  it('adds the request at the detailed level, chip and all', () => {
    expect(
      sessionBranchLine('feat/x', status({ ahead: 4, dirty: true }), pr(), 'detailed'),
    ).toEqual({
      name: 'feat/x',
      // GitHub's own vocabulary: an open request leads its branch with the
      // pull-request mark, and the state travels as the class both that mark and
      // the chip take their colour from.
      glyph: 'git-pull-request',
      state: 'open',
      dirty: true,
      link: true,
      sync: '↑4',
      pr: { label: '#128 ✓', state: 'open', checks: 'pass' },
    });
  });

  it('gives each request state its own mark', () => {
    const glyphFor = (state: PullRequestState): string | undefined =>
      sessionBranchLine('feat/x', status(), pr({ state }), 'detailed').glyph;
    expect(glyphFor('open' as PullRequestState)).toBe('git-pull-request');
    expect(glyphFor('draft' as PullRequestState)).toBe('git-pull-request-draft');
    expect(glyphFor('merged' as PullRequestState)).toBe('git-merge');
    expect(glyphFor('closed' as PullRequestState)).toBe('git-pull-request-closed');
    // No request at all keeps the mark this line has always had.
    expect(sessionBranchLine('feat/x', status(), undefined, 'detailed').glyph).toBe(
      'git-branch',
    );
  });

  it('spells `merged` as a word rather than leaving it to the chip colour', () => {
    // The whole point of moving the branch off the session's NAME is that a row
    // should not need colour to be read — and merged is the one state that says
    // the worktree can go.
    const line = sessionBranchLine(
      'fix/csv',
      status({ upstream: 'origin/fix/csv' }),
      pr({ number: 124, state: 'merged' as PullRequestState, checks: 'none' as PullRequestChecks }),
      'detailed',
    );
    expect(line.pr?.label).toBe('#124 merged');
    expect(line.pr?.state).toBe('merged');
  });

  it('says `local` for a branch that tracks nothing, which the arrows draw blank', () => {
    const line = sessionBranchLine(
      'spike/cache',
      status({ upstream: '', dirty: true }),
      undefined,
      'detailed',
    );
    expect(line.sync).toBe('local');
    expect(line.dirty).toBe(true);
  });

  it('says `local` alone on a clean never-pushed branch', () => {
    expect(
      sessionBranchLine('spike/cache', status({ upstream: '' }), undefined, 'detailed').sync,
    ).toBe('local');
  });

  it('does not call an unprobed branch local', () => {
    // "never pushed" and "not looked at yet" are different claims, and only one
    // of them is ours to make.
    expect(
      sessionBranchLine('spike/cache', undefined, undefined, 'detailed'),
    ).toEqual({ name: 'spike/cache', glyph: 'git-branch' });
  });

  it('withholds `local` at the standard level', () => {
    const line = sessionBranchLine(
      'spike/cache',
      status({ upstream: '', dirty: true }),
      undefined,
      'standard',
    );
    expect(line.sync).toBeUndefined();
    // The star is not part of that word and does not go with it: it is a fact
    // about the checkout, which the standard level reports.
    expect(line.dirty).toBe(true);
  });
});

describe('buildViewModel: the branch under a session', () => {
  const on = (over: Partial<ViewModelInput> = {}) =>
    buildViewModel(
      input(forest2(), { projects: [projectNode([MAIN, FEAT], [A, B])] }, {
        branchDisplay: 'inline',
        ...over,
      }),
    );
  const lineOn = (rows: ReturnType<typeof buildViewModel>, id: string) =>
    rows.find((r) => r.sessionId === id)?.branchLine;

  it('gives each session the branch of its own checkout', () => {
    const rows = on();
    expect(lineOn(rows, A)?.name).toBe('main');
    expect(lineOn(rows, B)?.name).toBe('feat/x');
  });

  it('draws no line at all in colour mode', () => {
    const rows = buildViewModel(
      input(forest2(), { projects: [projectNode([MAIN, FEAT], [A, B])] }, {
        branchDisplay: 'color',
      }),
    );
    expect(lineOn(rows, A)).toBeUndefined();
    expect(lineOn(rows, B)).toBeUndefined();
  });

  it('takes the tint off the name when the line goes on', () => {
    // Mutually exclusive: two things saying "this is on feat/x" is one too many,
    // and the tint is the one that competes with the status dot.
    const rows = on();
    expect(rows.find((r) => r.sessionId === A)?.branchColor).toBeUndefined();
    expect(rows.find((r) => r.sessionId === B)?.branchColor).toBeUndefined();
    // The NAME survives — the hover still answers "which branch is this".
    expect(rows.find((r) => r.sessionId === A)?.branch).toBe('main');
  });

  it('says nothing on a fork that stayed in its parent’s worktree', () => {
    // A repeated branch name down a spine is noise, and the spine is drawn.
    const forked = forestOf([
      node(A, { cwd: '/code/app/src', visibleChildren: [C] }),
      node(C, { parentId: A, cwd: '/code/app/src' }),
    ]);
    const rows = buildViewModel(
      input(forked, { projects: [projectNode([MAIN, FEAT], [A])] }, { branchDisplay: 'inline' }),
    );
    expect(lineOn(rows, A)?.name).toBe('main');
    expect(lineOn(rows, C)).toBeUndefined();
  });

  it('speaks up on a fork that moved to another checkout', () => {
    const forked = forestOf([
      node(A, { cwd: '/code/app/src', visibleChildren: [B] }),
      node(B, { parentId: A, cwd: '/code/app-feat-x' }),
    ]);
    const rows = buildViewModel(
      input(forked, { projects: [projectNode([MAIN, FEAT], [A])] }, { branchDisplay: 'inline' }),
    );
    expect(lineOn(rows, B)?.name).toBe('feat/x');
  });

  it('speaks again where a grandchild moves back', () => {
    // parentBranchAt is THIS row's checkout, not the one the walk started at.
    const forked = forestOf([
      node(A, { cwd: '/code/app/src', visibleChildren: [B] }),
      node(B, { parentId: A, cwd: '/code/app-feat-x', visibleChildren: [C] }),
      node(C, { parentId: B, cwd: '/code/app/src' }),
    ]);
    const rows = buildViewModel(
      input(forked, { projects: [projectNode([MAIN, FEAT], [A])] }, { branchDisplay: 'inline' }),
    );
    expect(lineOn(rows, C)?.name).toBe('main');
  });

  it('stays quiet in a project with one checkout, where it distinguishes nothing', () => {
    const rows = buildViewModel(
      input(forest2(), { projects: [projectNode([MAIN], [A, B])] }, { branchDisplay: 'inline' }),
    );
    expect(lineOn(rows, A)).toBeUndefined();
  });

  it('stays quiet under branch grouping, where the row above already says it', () => {
    const rows = on({ groupByBranch: true });
    expect(lineOn(rows, A)).toBeUndefined();
    expect(lineOn(rows, B)).toBeUndefined();
  });

  it('draws no branch ROWS for the session line alone', () => {
    // The two gates are separate on purpose: the grouping builds the branch list
    // for either switch, and this is what stops the light half of the feature
    // from dragging a row per branch in behind it.
    const rows = on({ branchBlock: false });
    expect(rows.some((r) => r.kind === 'branch')).toBe(false);
    expect(lineOn(rows, B)?.name).toBe('feat/x');
  });

  it('still draws the branch rows in inline mode once they are unfolded', () => {
    // Inline mode shuts the block by default, so the rows come back the way the
    // user asks for them: `branchesShown: true` is the record **Show
    // Branches** writes.
    const rows = buildViewModel(
      input(
        forest2(),
        {
          projects: [
            projectNode([MAIN, FEAT], [A, B], { branchesShown: true }),
          ],
        },
        { branchDisplay: 'inline', branchBlock: true },
      ),
    );
    expect(rows.filter((r) => r.kind === 'branch')).toHaveLength(2);
    expect(lineOn(rows, B)?.name).toBe('feat/x');
  });

  it('carries the checkout’s status onto the line', () => {
    const rows = on({
      branchStatusOf: (dir) =>
        dir === '/code/app-feat-x'
          ? {
              branch: 'feat/x',
              upstream: 'origin/feat/x',
              ahead: 4,
              behind: 0,
              dirty: true,
              untracked: false,
            }
          : undefined,
    });
    expect(lineOn(rows, B)?.sync).toBe('↑4');
    // The star travels separately now, next to the name it is about.
    expect(lineOn(rows, B)?.dirty).toBe(true);
    expect(lineOn(rows, A)?.sync).toBeUndefined();
    expect(lineOn(rows, A)?.dirty).toBeUndefined();
  });

  it('says in the hover what the marks on the line say in shorthand', () => {
    // A green mark and `↑4 *` are exactly the kind of shorthand that has to be
    // spelled out somewhere, and a row has one tooltip. Same two functions the
    // native tree's branch row hovers with, so the words do not differ by
    // surface.
    const rows = on({
      sessionBranchDetail: 'detailed',
      branchStatusOf: (dir) =>
        dir === '/code/app-feat-x'
          ? {
              branch: 'feat/x',
              upstream: 'origin/feat/x',
              ahead: 4,
              behind: 0,
              dirty: true,
              untracked: false,
            }
          : undefined,
      pullRequestFor: (_repoDir, branchName) =>
        branchName === 'feat/x'
          ? {
              number: 128,
              title: 'Rank by BM25',
              state: 'open' as PullRequestState,
              checks: 'pass' as PullRequestChecks,
              branch: 'feat/x',
              url: 'https://github.com/acme/app/pull/128',
            }
          : undefined,
    });
    const tooltip = rows.find((r) => r.sessionId === B)?.tooltip ?? '';
    expect(tooltip).toContain('branch: feat/x');
    expect(tooltip).toContain('4 ahead origin/feat/x');
    expect(tooltip).toContain('uncommitted changes');
    expect(tooltip).toContain('pull request #128 — open, checks passing');
  });

  it('leaves the hover alone when there is nothing to add to it', () => {
    const tooltip = on().find((r) => r.sessionId === B)?.tooltip ?? '';
    expect(tooltip).toContain('branch: feat/x');
    expect(tooltip).not.toContain('pull request');
  });

  it('hands the line its own checkout, for the link to resolve through', () => {
    // Never drawn. It is what lets a click on the name name a ROW and have the
    // extension read the directory off the model it posted.
    const rows = on();
    expect(lineOn(rows, B)?.dir).toBe('/code/app-feat-x');
    // And the project the branch belongs to, on the session row itself — a
    // session row carries one only when it drew a line.
    expect(rows.find((r) => r.sessionId === B)?.projectId).toBe('p1');
  });

  it('asks for a pull request only at the detailed level', () => {
    // `branchBlock: false` so the only lookups counted are the LINE's — a branch
    // row draws its own chip and asks for its own request either way.
    const asked: string[] = [];
    const pullRequestFor = (_repoDir: string, branchName: string) => {
      asked.push(branchName);
      return undefined;
    };
    on({ pullRequestFor, branchBlock: false });
    expect(asked).toEqual([]);
    on({ pullRequestFor, branchBlock: false, sessionBranchDetail: 'detailed' });
    expect(asked).toEqual(['main', 'feat/x']);
  });

  it('anchors the request lookup on the repository’s main worktree', () => {
    // One directory per repository, so six checkouts ask `gh` once for an answer
    // that is the same from any of them.
    const anchors: string[] = [];
    on({
      branchBlock: false,
      sessionBranchDetail: 'detailed',
      pullRequestFor: (repoDir) => {
        anchors.push(repoDir);
        return undefined;
      },
    });
    expect(new Set(anchors)).toEqual(new Set(['/code/app']));
  });

  it('survives a status lookup that throws', () => {
    // A lookup that throws is a lookup that answered nothing — a row with no
    // numbers is a valid row, and a paint must not be the thing that fails.
    const rows = on({
      branchStatusOf: () => {
        throw new Error('cache exploded');
      },
    });
    expect(lineOn(rows, B)).toEqual({
      name: 'feat/x',
      glyph: 'git-branch',
      dir: '/code/app-feat-x',
    });
  });
});

// ------------------------------------------- what the `+` on a project means

describe('buildViewModel: the + and lineage.git.newSessionInWorktree', () => {
  const projectRow = (over: Partial<ViewModelInput> = {}) =>
    buildViewModel(
      input(
        forestOf([node(A)]),
        {
          projects: [
            {
              type: 'project',
              projectId: 'p1',
              label: 'API',
              rootDir: '/code/api',
              dirs: ['/code/api'],
              provider: 'claude' as ProviderId,
              rootIds: [],
            },
          ],
        },
        over,
      ),
    )[0];

  it('says "in API" while the setting is off', () => {
    const plus = projectRow().actions?.find((a) => a.id === 'newSession');
    expect(plus?.title).toBe('New session in API');
  });

  it('says a worktree is coming, when that is what the button will do', () => {
    // The whole justification for putting the `+` back on a row that has to pick
    // a directory: the button states its answer before it is clicked. A guess
    // you can read is not a guess.
    const plus = projectRow({ newSessionInWorktree: true }).actions?.find(
      (a) => a.id === 'newSession',
    );
    expect(plus?.title).toBe('New session in a new worktree of API');
  });

  it('is on the row in both modes and at every branch count', () => {
    // It used to be withdrawn wherever branch rows were on screen. Nothing
    // withdraws it now — a project rows always has one, which is where people
    // went looking for it.
    for (const display of ['color', 'inline'] as const) {
      const rows = rowsFor([MAIN, FEAT], {}, { branchDisplay: display });
      expect(
        rows[0].actions?.some((a) => a.id === 'newSession'),
        display,
      ).toBe(true);
    }
  });
});

// ------------------------------------------ colours belong to one mode only

describe('buildViewModel: the branch rows take no colour in inline mode', () => {
  const shown = (display: 'color' | 'inline') =>
    buildViewModel(
      input(
        forest2(),
        {
          projects: [
            projectNode([MAIN, FEAT], [A, B], { branchesShown: true }),
          ],
        },
        { branchDisplay: display },
      ),
    ).filter((r) => r.kind === 'branch');

  it('hands the client a colour index in colour mode, and none in inline', () => {
    // The client's whole test for which treatment to draw: a chip with an index
    // gets the coloured square and a tinted name, one without gets the
    // git-branch mark and the theme's own foreground. Two marks saying "this is
    // on feat/x" is one too many, and in inline mode the words already said it.
    expect(shown('color').map((r) => r.chip?.colorIndex)).toEqual([0, 1]);
    expect(shown('inline').map((r) => r.chip?.colorIndex)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('names a mark for the chip in BOTH modes, so the state is never lost', () => {
    // In inline mode the mark stands where the swatch went; in colour mode the
    // swatch is the key and the client does not draw it. It travels either way
    // because which of those is true is the client's decision, not this one.
    for (const display of ['color', 'inline'] as const) {
      expect(shown(display).map((r) => r.chip?.glyph), display).toEqual([
        'git-branch',
        'git-branch',
      ]);
    }
  });

  it('gives the chip the request’s mark and the checkout’s star', () => {
    const rows = buildViewModel(
      input(
        forest2(),
        {
          projects: [
            projectNode([MAIN, FEAT], [A, B], { branchesShown: true }),
          ],
        },
        {
          branchDisplay: 'inline',
          branchStatusOf: (dir) =>
            dir === '/code/app-feat-x'
              ? {
                  branch: 'feat/x',
                  upstream: 'origin/feat/x',
                  ahead: 0,
                  behind: 0,
                  dirty: false,
                  untracked: true,
                }
              : undefined,
          pullRequestFor: (_repoDir, branchName) =>
            branchName === 'feat/x'
              ? {
                  number: 128,
                  title: 'Rank by BM25',
                  state: 'draft' as PullRequestState,
                  checks: 'none' as PullRequestChecks,
                  branch: 'feat/x',
                  url: 'https://github.com/acme/app/pull/128',
                }
              : undefined,
        },
      ),
    ).filter((r) => r.kind === 'branch');
    const feat = rows.find((r) => r.chip?.full === 'feat/x')?.chip;
    expect(feat?.glyph).toBe('git-pull-request-draft');
    expect(feat?.state).toBe('draft');
    // Untracked files count as dirt: the row warns that there is uncommitted
    // work, not how much of it there is.
    expect(feat?.dirty).toBe(true);
    const main = rows.find((r) => r.chip?.full === 'main')?.chip;
    expect(main?.glyph).toBe('git-branch');
    expect(main?.dirty).toBeUndefined();
  });

  it('still colours the session names in colour mode only', () => {
    const tinted = buildViewModel(
      input(forest2(), { projects: [projectNode([MAIN, FEAT], [A, B])] }, {
        branchDisplay: 'color',
      }),
    );
    const plain = buildViewModel(
      input(forest2(), { projects: [projectNode([MAIN, FEAT], [A, B])] }, {
        branchDisplay: 'inline',
      }),
    );
    expect(tinted.find((r) => r.sessionId === A)?.branchColor).toBe(0);
    expect(plain.find((r) => r.sessionId === A)?.branchColor).toBeUndefined();
  });
});
