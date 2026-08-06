// test/commands.test.ts — src/commands.ts's pure surface, plus the two
// exported flows.
//
// registerCommands() talks to the real workbench and is mostly never exercised.
// `chatFlow` needs no workbench at all; `configureProjectFlow` opens a
// QuickPick, so the two host entry points it calls are scripted onto the mock's
// (deliberately empty) `window`/`commands` for the length of a test and removed
// again — see that describe block.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  adoptBackgroundJob,
  chatFlow,
  chatSystemPrompt,
  configureProjectFlow,
  defaultForkTitle,
  defaultSessionTitle,
  detachedTmuxName,
  nextFreeName,
  projectIdFromArg,
  registerCommands,
  chatHistoryFlow,
  closeProjectFlow,
  reopenProject,
  resumeFlow,
  selectedSessionIds,
  sessionIdFromArg,
  staleCandidates,
  stripForkCounter,
} from '../src/commands';
import type { AccountCommandDeps } from '../src/commands';
import type { AccountDeps } from '../src/accountsView';
import { validateProjectName } from '../src/projects';
import {
  COMMANDS,
  MAX_PROJECT_NAME_LEN,
  SESSION_ID_RE,
  WRAP_PROMPT,
  isSessionId,
} from '../src/types';
import { commands as mockCommands, window as mockWindow } from './mocks/vscode';
import type {
  AccountProfile,
  BackgroundJob,
  CommandDeps,
  EditorialRecord,
  LaunchOptions,
  ProjectRecord,
  RoutingChoice,
  SessionForest,
  SessionNode,
  SubprojectRecord,
} from '../src/types';

const VALID = 'ff2c0a73-26c4-46f1-bb6e-fe331fcb0ecf';

const HOUR = 3_600_000;
const NOW = 1_785_160_000_000;

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

const uuid = (n: number): string =>
  `0000000${n}-0000-4000-8000-00000000000${n}`;

describe('sessionIdFromArg', () => {
  it('accepts a validated session-id string', () => {
    expect(sessionIdFromArg(VALID)).toBe(VALID);
  });

  it('rejects a junk string', () => {
    expect(sessionIdFromArg('not-a-uuid')).toBeUndefined();
    expect(sessionIdFromArg('')).toBeUndefined();
  });

  it('unwraps a SessionRef', () => {
    expect(sessionIdFromArg({ type: 'session', id: VALID })).toBe(VALID);
  });

  it('unwraps any object with a uuid-shaped id (a TreeItem, say)', () => {
    expect(sessionIdFromArg({ id: VALID })).toBe(VALID);
    expect(sessionIdFromArg({ id: 'group:/tmp' })).toBeUndefined();
  });

  it('refuses a GroupNode — folder rows are not sessions', () => {
    expect(
      sessionIdFromArg({
        type: 'group',
        key: '/tmp/p',
        cwd: '/tmp/p',
        label: 'p',
        rootIds: [VALID],
      }),
    ).toBeUndefined();
  });

  it('refuses a ProjectGroupNode too', () => {
    expect(
      sessionIdFromArg({
        type: 'project',
        projectId: 'p1',
        label: 'API',
        rootDir: '/code/api',
        dirs: ['/code/api'],
        provider: 'claude',
        rootIds: [VALID],
      }),
    ).toBeUndefined();
  });

  it('refuses undefined and null (handlers then fall back to a QuickPick)', () => {
    expect(sessionIdFromArg(undefined)).toBeUndefined();
    expect(sessionIdFromArg(null)).toBeUndefined();
    expect(sessionIdFromArg(42)).toBeUndefined();
  });
});

describe('WRAP_PROMPT', () => {
  it('is a non-empty single line (sendText appends the newline itself)', () => {
    expect(WRAP_PROMPT.length).toBeGreaterThan(0);
    expect(WRAP_PROMPT).not.toContain('\n');
    expect(WRAP_PROMPT.trim()).toBe(WRAP_PROMPT);
  });
});

describe('isSessionId (the gate every verb resolves through)', () => {
  it('accepts a uuid and rejects near-misses', () => {
    expect(isSessionId(VALID)).toBe(true);
    expect(isSessionId(VALID.slice(0, -1))).toBe(false);
    expect(isSessionId(`${VALID} `)).toBe(false);
  });
});

// The three shapes a multi-row verb is invoked with. This is the whole of
// the argument handling for "delete the rows I have selected", and each shape
// comes from a different surface.
describe('selectedSessionIds', () => {
  const reporting = (ids: string[]) => ({ selectedSessions: () => ids });
  const A = uuid(1);
  const B = uuid(2);
  const C = uuid(3);

  it('takes the native tree at its word — arg 2 IS the selection', () => {
    // canSelectMany hands a row-menu command (clickedItem, wholeSelection).
    const ids = selectedSessionIds(reporting([]), [
      { type: 'session', id: B },
      [
        { type: 'session', id: A },
        { type: 'session', id: B },
      ],
    ]);
    expect(ids).toEqual([A, B]);
  });

  it('falls back to what the view reported, for a webview row menu', () => {
    // `data-vscode-context` can only carry the ONE row the menu was opened on,
    // so the rest of the selection has to come from the view's own report.
    expect(
      selectedSessionIds(reporting([A, B, C]), [{ type: 'session', id: B }]),
    ).toEqual([A, B, C]);
  });

  it('works from a keybinding, which passes no argument at all', () => {
    expect(selectedSessionIds(reporting([A, B]), [])).toEqual([A, B]);
    expect(selectedSessionIds(reporting([A, B]), [undefined])).toEqual([A, B]);
  });

  it('appends a clicked row that is not in the selection, never drops it', () => {
    // Both views collapse the selection onto a row right-clicked outside it
    // before the menu opens, so this is the belt-and-braces case — but a verb
    // that silently ignored the row you clicked would be the worst outcome.
    expect(
      selectedSessionIds(reporting([A, B]), [{ type: 'session', id: C }]),
    ).toEqual([A, B, C]);
  });

  it('never names the same session twice', () => {
    expect(
      selectedSessionIds(reporting([A, A, B]), [{ type: 'session', id: B }]),
    ).toEqual([A, B]);
  });

  it('still answers when the view cannot be asked', () => {
    const throwing = {
      selectedSessions: (): string[] => {
        throw new Error('no view');
      },
    };
    expect(selectedSessionIds(throwing, [{ type: 'session', id: A }])).toEqual([
      A,
    ]);
    expect(selectedSessionIds(throwing, [])).toEqual([]);
  });

  it('ignores rows that are not sessions', () => {
    expect(
      selectedSessionIds(reporting([]), [
        { type: 'project', projectId: 'p1' },
        [{ type: 'group', key: '/tmp', cwd: '/tmp', label: 't', rootIds: [] }],
      ]),
    ).toEqual([]);
  });
});

describe('projectIdFromArg', () => {
  it('unwraps a ProjectGroupNode', () => {
    expect(
      projectIdFromArg({
        type: 'project',
        projectId: 'p1',
        label: 'API',
        rootDir: '/code/api',
        dirs: ['/code/api'],
        provider: 'claude',
        rootIds: [],
      }),
    ).toBe('p1');
  });

  it('refuses everything that is not a project row', () => {
    // A session id is a uuid string, never a project row — the two arg
    // extractors must not both claim the same argument.
    expect(projectIdFromArg(VALID)).toBeUndefined();
    expect(projectIdFromArg({ type: 'session', id: VALID })).toBeUndefined();
    expect(
      projectIdFromArg({ type: 'group', key: '/tmp', cwd: '/tmp', label: 't', rootIds: [] }),
    ).toBeUndefined();
    expect(projectIdFromArg({ type: 'project', projectId: '' })).toBeUndefined();
    expect(projectIdFromArg(undefined)).toBeUndefined();
    expect(projectIdFromArg(null)).toBeUndefined();
  });
});

describe('staleCandidates', () => {
  const forest = forestOf([
    node(uuid(1), { startedAt: NOW - 6 * 24 * HOUR, label: 'six days' }),
    node(uuid(2), { startedAt: NOW - 3 * HOUR, label: 'three hours' }),
    node(uuid(3), { startedAt: NOW - 90 * 24 * HOUR, label: 'ninety days' }),
    node(uuid(4), { label: 'no timestamp' }),
  ]);

  it('sorts oldest first and puts unknown ages last', () => {
    const out = staleCandidates(forest, 48 * HOUR, NOW);
    expect(out.map((c) => c.label)).toEqual([
      'ninety days',
      'six days',
      'three hours',
      'no timestamp',
    ]);
  });

  it('pre-ticks only what is past the threshold — never an unknown age', () => {
    const out = staleCandidates(forest, 48 * HOUR, NOW);
    expect(out.filter((c) => c.stale).map((c) => c.label)).toEqual([
      'ninety days',
      'six days',
    ]);
    expect(out.find((c) => c.label === 'no timestamp')?.stale).toBe(false);
  });

  it('moves the threshold', () => {
    expect(
      staleCandidates(forest, 1 * HOUR, NOW).filter((c) => c.stale),
    ).toHaveLength(3);
    expect(
      staleCandidates(forest, 365 * 24 * HOUR, NOW).filter((c) => c.stale),
    ).toHaveLength(0);
  });

  it('pre-ticks nothing when the threshold is nonsense', () => {
    // A zero / negative / NaN setting must not mean "tick everything".
    for (const bad of [0, -5, Number.NaN]) {
      expect(staleCandidates(forest, bad, NOW).some((c) => c.stale)).toBe(
        false,
      );
    }
  });

  it('offers neither ghosts nor already-hidden rows', () => {
    const f = forestOf([
      node(uuid(1), { startedAt: NOW - 9 * 24 * HOUR }),
      node(uuid(2), { startedAt: NOW - 9 * 24 * HOUR, ghost: true }),
      node(uuid(3), { startedAt: NOW - 9 * 24 * HOUR, hidden: true }),
    ]);
    expect(staleCandidates(f, 48 * HOUR, NOW).map((c) => c.sessionId)).toEqual([
      uuid(1),
    ]);
  });

  it('ages an archived row from when it last did anything', () => {
    // buildForest stamps an archived node's lastActiveAt from the archive's
    // endedAt (src/lineage.ts), so the two travel together on a real row.
    const f = forestOf([
      node(uuid(1), {
        archived: true,
        status: 'exited',
        startedAt: NOW - 90 * 24 * HOUR,
        endedAt: NOW - 2 * HOUR,
        lastActiveAt: NOW - 2 * HOUR,
      }),
    ]);
    const [only] = staleCandidates(f, 48 * HOUR, NOW);
    // Started 90 days ago but was active 2 hours ago — not stale.
    expect(only.ageMs).toBe(2 * HOUR);
    expect(only.stale).toBe(false);
  });

  // REGRESSION. The age came off `startedAt` for anything not
  // archived, so a session worked on every day for a month was pre-ticked for
  // DELETION on the strength of when it was opened.
  it('ages a live row from its last activity, never from its start', () => {
    const f = forestOf([
      node(uuid(1), {
        label: 'worked on all week',
        startedAt: NOW - 30 * 24 * HOUR,
        lastActiveAt: NOW - 2 * HOUR,
      }),
      node(uuid(2), {
        label: 'opened and abandoned',
        startedAt: NOW - 3 * HOUR,
        lastActiveAt: NOW - 3 * HOUR,
      }),
    ]);
    const out = staleCandidates(f, 48 * HOUR, NOW);
    expect(out.find((c) => c.label === 'worked on all week')?.ageMs).toBe(
      2 * HOUR,
    );
    expect(out.some((c) => c.stale)).toBe(false);
  });

  it('is the same basis the rows on screen are aged off', () => {
    // viewmodel.ts and tree.ts both read `lastActiveAt ?? startedAt`. If this
    // list used a different one, "6d old" here would mean something other than
    // "6d" in the sidebar for the same row.
    const f = forestOf([
      node(uuid(1), {
        startedAt: NOW - 90 * 24 * HOUR,
        lastActiveAt: NOW - 6 * 24 * HOUR,
      }),
    ]);
    const [only] = staleCandidates(f, 48 * HOUR, NOW);
    expect(only.ageMs).toBe(6 * 24 * HOUR);
    expect(only.detail).toContain('6d old');
  });

  it('falls back to the start for a row no activity sweep has covered yet', () => {
    // A brand-new session has no transcript mtime yet; its start is the best
    // information there is.
    const f = forestOf([node(uuid(1), { startedAt: NOW - 5 * HOUR })]);
    expect(staleCandidates(f, 48 * HOUR, NOW)[0].ageMs).toBe(5 * HOUR);
  });

  it('treats a timestamp in the future as unknown rather than negative', () => {
    const f = forestOf([node(uuid(1), { startedAt: NOW + 60_000 })]);
    const [only] = staleCandidates(f, 48 * HOUR, NOW);
    expect(only.ageMs).toBe(-1);
    expect(only.stale).toBe(false);
    expect(only.detail).toContain('unknown age');
  });
});

// ----------------------------------------------------------------- naming
// A new branch is NAMED at birth (pre-filled, pre-selected) instead of being
// asked for an opening prompt, so the default name has to be worth accepting.

describe('stripForkCounter', () => {
  it('drops a trailing fork counter so names do not compound', () => {
    expect(stripForkCounter('auth 2')).toBe('auth');
    expect(stripForkCounter('auth 12')).toBe('auth');
  });

  it('keeps a number that is part of the name', () => {
    // No space before the digits — `v2` is one word, not a counter.
    expect(stripForkCounter('refactor v2')).toBe('refactor v2');
  });

  it('keeps a bare number, which has no stem to fall back on', () => {
    expect(stripForkCounter('412')).toBe('412');
  });

  it('trims without otherwise touching an ordinary name', () => {
    expect(stripForkCounter('  auth middleware  ')).toBe('auth middleware');
  });
});

describe('defaultForkTitle', () => {
  it('offers the parent name plus the next counter', () => {
    expect(defaultForkTitle('auth', [])).toBe('auth 2');
  });

  it('skips counters its siblings already took', () => {
    expect(defaultForkTitle('auth', ['auth 2'])).toBe('auth 3');
    expect(defaultForkTitle('auth', ['auth 2', 'auth 3'])).toBe('auth 4');
  });

  it('reuses a freed number rather than leaving a permanent gap', () => {
    // `auth 2` was closed and is gone from the tree; the next fork takes it
    // back. This is why siblings are counted instead of a running total.
    expect(defaultForkTitle('auth', ['auth 3'])).toBe('auth 2');
  });

  it('does not compound counters when forking a fork', () => {
    expect(defaultForkTitle('auth 2', [])).toBe('auth 3');
  });

  it('ignores sibling case when checking what is taken', () => {
    expect(defaultForkTitle('Auth', ['AUTH 2'])).toBe('Auth 3');
  });

  it('never returns the parent name itself', () => {
    expect(defaultForkTitle('auth', [])).not.toBe('auth');
  });

  it('falls back to a word when the parent has no usable label', () => {
    expect(defaultForkTitle('   ', [])).toBe('session 2');
  });

  it('stays within the rename cap', () => {
    const long = 'x'.repeat(200);
    expect(defaultForkTitle(long, []).length).toBeLessThanOrEqual(80);
  });
});

describe('defaultSessionTitle', () => {
  it('uses the directory basename', () => {
    expect(defaultSessionTitle('/Users/a/code/api')).toBe('api');
    expect(defaultSessionTitle('/Users/a/code/api/')).toBe('api');
  });

  it('falls back to a word with no directory — never a uuid', () => {
    expect(defaultSessionTitle(undefined)).toBe('session');
    expect(defaultSessionTitle('')).toBe('session');
  });
});

describe('staleCandidates: hide/delete split', () => {
  it('skips a deleted session — it has no row to demote', () => {
    const f = forestOf([
      node(uuid(1), { startedAt: NOW - 90 * HOUR }),
      node(uuid(2), { deleted: true, startedAt: NOW - 90 * HOUR }),
    ]);
    expect(staleCandidates(f, 48 * HOUR, NOW).map((c) => c.sessionId)).toEqual([
      uuid(1),
    ]);
  });

  it('skips an already-hidden session — hiding it again is a no-op', () => {
    const f = forestOf([
      node(uuid(1), { startedAt: NOW - 90 * HOUR }),
      node(uuid(2), { hidden: true, startedAt: NOW - 90 * HOUR }),
    ]);
    expect(staleCandidates(f, 48 * HOUR, NOW).map((c) => c.sessionId)).toEqual([
      uuid(1),
    ]);
  });
});

describe('nextFreeName', () => {
  it('returns the stem untouched when nothing has taken it', () => {
    expect(nextFreeName('api', [])).toBe('api');
    expect(nextFreeName('api', ['web', 'infra'])).toBe('api');
  });

  it('adds the first free counter once the stem is taken', () => {
    expect(nextFreeName('api', ['api'])).toBe('api 2');
    expect(nextFreeName('api', ['api', 'api 2'])).toBe('api 3');
  });

  it('fills a gap rather than always appending', () => {
    expect(nextFreeName('api', ['api', 'api 3'])).toBe('api 2');
  });

  it('compares case-insensitively', () => {
    expect(nextFreeName('API', ['api'])).toBe('API 2');
  });

  it('falls back to a word for an empty stem', () => {
    expect(nextFreeName('   ', [])).toBe('session');
  });

  it('ignores blank entries in taken', () => {
    expect(nextFreeName('api', ['', '   '])).toBe('api');
  });

  it('stays within the rename cap', () => {
    expect(nextFreeName('x'.repeat(200), []).length).toBeLessThanOrEqual(80);
  });

  it('honours a caller-supplied cap without disturbing the default', () => {
    // A project name is capped at 60 and a session title at 80. A generated
    // project name that overran 60 would be refused by the very validator that
    // is about to see it, so the cap has to travel with the caller.
    expect(
      nextFreeName('x'.repeat(200), [], MAX_PROJECT_NAME_LEN).length,
    ).toBe(MAX_PROJECT_NAME_LEN);
    // The default is the session cap, unchanged for every existing call site.
    expect(nextFreeName('x'.repeat(200), []).length).toBe(80);
    expect(nextFreeName('api', ['api'], MAX_PROJECT_NAME_LEN)).toBe('api 2');
  });
});

describe('nextFreeName agrees with validateProjectName', () => {
  // The generated project name and the validator that would refuse a duplicate
  // are two independently-written case-insensitive comparisons. If they ever
  // drift, "New Project" creates a project the rename box then refuses to
  // accept — so pin them against each other rather than against a literal.
  function proj(name: string): ProjectRecord {
    return {
      id: `id-${name}`,
      name,
      rootDir: `/w/${name}`,
      dirs: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  it('never generates a name validateProjectName would reject', () => {
    const existing = [proj('API'), proj('  api 2  '), proj('web')];
    const generated = nextFreeName(
      'api',
      existing.map((p) => p.name),
      MAX_PROJECT_NAME_LEN,
    );
    // 'API' and 'api 2' are both taken, differing only in case and padding.
    expect(generated).toBe('api 3');
    expect(validateProjectName(generated, existing)).toBe('');
  });

  it('a name it does dedupe past is one the validator would have refused', () => {
    const existing = [proj('API')];
    expect(validateProjectName('api', existing)).not.toBe('');
    expect(
      nextFreeName('api', existing.map((p) => p.name), MAX_PROJECT_NAME_LEN),
    ).toBe('api 2');
  });
});

describe('defaultSessionTitle: de-duplication', () => {
  it('offers the bare basename when the directory has no sessions yet', () => {
    expect(defaultSessionTitle('/Users/a/code/api', [])).toBe('api');
  });

  it('counts up past the sessions already living there', () => {
    // Clicking + twice in one directory must not produce two rows called `api`.
    expect(defaultSessionTitle('/Users/a/code/api', ['api'])).toBe('api 2');
    expect(defaultSessionTitle('/Users/a/code/api', ['api', 'api 2'])).toBe(
      'api 3',
    );
  });

  it('is unaffected by unrelated names', () => {
    expect(defaultSessionTitle('/Users/a/code/api', ['web'])).toBe('api');
  });
});

// --------------------------------------------------------------- the chat

describe('chatSystemPrompt', () => {
  const project: ProjectRecord = {
    id: 'p1',
    name: 'magma-os',
    rootDir: '/Users/a/code/magma',
    dirs: ['/Users/a/code/wiki'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('names the project', () => {
    expect(chatSystemPrompt(project, ['/Users/a/code/magma'])).toContain(
      'magma-os',
    );
  });

  it('lists every directory it is handed', () => {
    const text = chatSystemPrompt(project, [
      '/Users/a/code/magma',
      '/Users/a/code/wiki',
    ]);
    expect(text).toContain('/Users/a/code/magma');
    expect(text).toContain('/Users/a/code/wiki');
  });
});

/**
 * A CommandDeps double for the flows this file drives directly. Only the
 * members those flows touch do anything; the rest exist so the object
 * satisfies the interface without a cast that would hide a signature change.
 */
interface ChatCalls {
  order: string[];
  records: Array<{ id: string; patch: Partial<EditorialRecord> }>;
  launches: LaunchOptions[];
  projectPatches: Array<{ id: string; patch: Partial<ProjectRecord> }>;
  /** Every setProjectParent this double was asked for. */
  projectMoves: Array<[string, string | null]>;
  focused: string[];
  reveals: string[];
  inlineRenameProjects: string[];
}

function chatDeps(
  project: ProjectRecord | undefined,
  over: {
    focusSession?: (id: string) => boolean;
    hasTranscript?: (id: string) => boolean;
    tipOf?: (id: string) => string;
    beginInlineRename?: (id?: string) => boolean;
    beginInlineRenameProject?: (id: string) => boolean;
    /** The store the chat history and the chat ordinal read. */
    records?: Record<string, EditorialRecord>;
    /** Whether the store accepts a re-file (it refuses cycles). */
    setProjectParent?: (id: string, parentId: string | null) => boolean;
    /** Every project the flows can see, not just the one under test. */
    projects?: ProjectRecord[];
  } = {},
): { deps: CommandDeps; calls: ChatCalls } {
  const calls: ChatCalls = {
    order: [],
    records: [],
    launches: [],
    projectPatches: [],
    projectMoves: [],
    focused: [],
    reveals: [],
    inlineRenameProjects: [],
  };
  const nope = (): never => {
    throw new Error('not used by chatFlow');
  };
  const deps: CommandDeps = {
    getForest: () => forestOf([]),
    refresh: () => calls.order.push('refresh'),
    hasTranscript: over.hasTranscript ?? (() => false),
    tipOf: over.tipOf ?? ((id) => id),
    beginInlineRenameProject: async (id) => {
      calls.inlineRenameProjects.push(id);
      return over.beginInlineRenameProject
        ? over.beginInlineRenameProject(id)
        : false;
    },
    revealSession: async (id) => {
      calls.reveals.push(id);
    },
    revealProject: async (id) => {
      calls.reveals.push(id);
    },
    getRecord: (id) => over.records?.[id],
    allRecords: () => over.records ?? {},
    upsertRecord: async (id, patch) => {
      calls.order.push('upsertRecord');
      calls.records.push({ id, patch });
    },
    recordLaunch: async () => {
      calls.order.push('recordLaunch');
    },
    launchSession: async (opts) => {
      calls.order.push('launchSession');
      calls.launches.push(opts);
      return null;
    },
    // Defaults to `false`, which is what almost every test wants. The account
    // blocks below opt into `true` so that a just-created row's fallback
    // (`vscode.commands.executeCommand`) never has to be scripted onto the
    // mock's empty `commands`.
    beginInlineRename: async (id) =>
      over.beginInlineRename ? over.beginInlineRename(id) : false,
    focusSession: (id) => {
      calls.focused.push(id);
      return over.focusSession ? over.focusSession(id) : false;
    },
    renameTerminal: async () => false,
    sendTextToSession: () => false,
    closeTerminal: () => false,
    focusWindowFor: async () => false,
    openProject: async () => undefined,
    installHooks: nope,
    removeHooks: nope,
    getHookState: () => ({ installed: false }),
    setHooksEnabled: async () => undefined,
    allProjects: () => over.projects ?? (project ? [project] : []),
    getProject: (id) =>
      (over.projects ?? (project ? [project] : [])).find((p) => p.id === id),
    // This double drives chatFlow, which never reaches the branch verb. Empty
    // rather than `nope()`: an empty branch list is a real state (a project
    // that is not a repository) and the honest answer for a fixture with no
    // git anywhere near it.
    getBranches: () => [],
    setBranchShown: async () => undefined,
    setBranchesCollapsed: async () => undefined,
    upsertProject: async (id, patch) => {
      calls.order.push('upsertProject');
      calls.projectPatches.push({ id, patch });
    },
    setProjectParent: async (projectId, newParentId) => {
      calls.order.push('setProjectParent');
      calls.projectMoves.push([projectId, newParentId]);
      return over.setProjectParent ? over.setProjectParent(projectId, newParentId) : true;
    },
    deleteProject: async () => undefined,
    hiddenFolders: () => [],
    hideFolder: async () => undefined,
    unhideFolder: async () => undefined,
    staleAfterHours: () => 24,
    markSeen: async () => undefined,
    notificationsEnabled: () => true,
    setOnlyActiveSessions: async () => undefined,
    setAccountsSection: async () => undefined,
    selectedSessions: () => [],
    switchWorkspace: async () => undefined,
    activeWorkspace: () => null,
  };
  return { deps, calls };
}

function projectOf(over: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'p1',
    name: 'magma-os',
    rootDir: '/Users/a/code/magma',
    dirs: ['/Users/a/code/wiki', '/Users/a/code/docs'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

/** A chat record in `projectOf()`'s root directory — which is what makes it
 *  that project's chat: membership is derived from the cwd, not from a
 *  pointer on the project record. */
function chatRecord(
  id: string,
  over: Partial<EditorialRecord> = {},
): EditorialRecord {
  return {
    id,
    chat: true,
    cwd: '/Users/a/code/magma',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('chatFlow', () => {
  it('mints a chat, records it BEFORE launching, and remembers the id', async () => {
    const { deps, calls } = chatDeps(projectOf());
    await chatFlow(deps, 'p1');

    // The record has to be on disk before the CLI's transcript can be seen by
    // a roster tick, or the chat flashes into the tree as an ordinary row.
    expect(calls.order.indexOf('upsertRecord')).toBeLessThan(
      calls.order.indexOf('launchSession'),
    );

    expect(calls.records).toHaveLength(1);
    const rec = calls.records[0];
    expect(SESSION_ID_RE.test(rec.id)).toBe(true);
    expect(rec.patch.chat).toBe(true);
    expect(rec.patch.launchedByUs).toBe(true);
    expect(rec.patch.notify).toBe(false);
    expect(rec.patch.cwd).toBe('/Users/a/code/magma');

    expect(calls.launches).toHaveLength(1);
    const launch = calls.launches[0];
    expect(launch.sessionId).toBe(rec.id);
    expect(launch.cwd).toBe('/Users/a/code/magma');
    expect(launch.resumeId).toBeUndefined();
    expect(launch.chat).toBe(true);
    expect(launch.addDirs).toEqual([
      '/Users/a/code/wiki',
      '/Users/a/code/docs',
    ]);
    expect(launch.appendSystemPrompt).toContain('magma-os');

    // The project record is not touched at all: `chatSessionId` was the
    // one-chat-per-project pointer, and a project can now hold many chats, so
    // there is no longer one chat to point at.
    expect(calls.projectPatches).toEqual([]);
  });

  it('never mints tree membership via recordLaunch', async () => {
    const { deps, calls } = chatDeps(projectOf());
    await chatFlow(deps, 'p1');
    expect(calls.order).not.toContain('recordLaunch');
  });

  // Each of these used to be a resume, back when a project had one chat.

  it('mints a NEW chat even when one is already open in this window', async () => {
    const { deps, calls } = chatDeps(projectOf(), {
      records: { [VALID]: chatRecord(VALID) },
      // A one-chat-per-project build would have focused this instead of launching.
      focusSession: () => true,
    });
    await chatFlow(deps, 'p1');
    expect(calls.focused).toEqual([]);
    expect(calls.launches).toHaveLength(1);
    expect(calls.launches[0].sessionId).not.toBe(VALID);
    expect(calls.launches[0].resumeId).toBeUndefined();
  });

  it('mints a NEW chat even when the last one has a transcript to replay', async () => {
    const { deps, calls } = chatDeps(projectOf(), {
      records: { [VALID]: chatRecord(VALID) },
      hasTranscript: () => true,
    });
    await chatFlow(deps, 'p1');
    expect(calls.launches[0].resumeId).toBeUndefined();
    expect(calls.launches[0].sessionId).not.toBe(VALID);
  });

  it('numbers the tab from the chats the project already has', async () => {
    const first = chatDeps(projectOf());
    await chatFlow(first.deps, 'p1');
    expect(first.calls.launches[0].title).toBe('Chat · magma-os');

    // Two already on the books -> this one is the third.
    const third = chatDeps(projectOf(), {
      records: {
        [VALID]: chatRecord(VALID),
        [uuid(8)]: chatRecord(uuid(8)),
      },
    });
    await chatFlow(third.deps, 'p1');
    expect(third.calls.launches[0].title).toBe('Chat · magma-os 3');
    // Persisted, because the tab title dies with the tab and the history
    // picker needs a name for a chat that never got a first prompt.
    expect(third.calls.records[0].patch.title).toBe('Chat · magma-os 3');
  });

  it('counts only chats in THIS project towards the number', async () => {
    const { deps, calls } = chatDeps(projectOf(), {
      records: {
        // Right project.
        [VALID]: chatRecord(VALID),
        // A chat somewhere else entirely.
        [uuid(8)]: chatRecord(uuid(8), { cwd: '/Users/a/other' }),
        // A SESSION in this project — not a chat, not counted.
        [uuid(9)]: chatRecord(uuid(9), { chat: false }),
      },
    });
    await chatFlow(deps, 'p1');
    expect(calls.launches[0].title).toBe('Chat · magma-os 2');
  });

  it('never reveals a row, because a chat has none', async () => {
    const { deps, calls } = chatDeps(projectOf());
    await chatFlow(deps, 'p1');
    expect(calls.reveals).toEqual([]);
    expect(calls.order).not.toContain('refresh');
  });

  it('does nothing for an unknown project', async () => {
    const { deps, calls } = chatDeps(undefined);
    await chatFlow(deps, 'p1');
    expect(calls.launches).toEqual([]);
    expect(calls.records).toEqual([]);
  });
});

// ---------------------------------------------------- the chat history

/**
 * The picker over a project's chats. Needs a workbench for the same reason the
 * Configure Project menu does — the whole verb is a QuickPick and what happens
 * to what comes back out of it — so the two window entry points are scripted
 * for the length of each test, exactly as they are there.
 */
describe('chatHistoryFlow', () => {
  const A = uuid(11);
  const B = uuid(12);

  afterEach(() => {
    delete (mockWindow as QuickPickHost).showQuickPick;
    delete (mockWindow as QuickPickHost).showInformationMessage;
  });

  /** Answers the picker with the row at `index`, and keeps what it was shown. */
  function scriptPicker(index: number | undefined): {
    shown: Array<{ label: string; description?: string; sessionId: string }>;
    told: string[];
  } {
    const state = {
      shown: [] as Array<{ label: string; description?: string; sessionId: string }>,
      told: [] as string[],
    };
    (mockWindow as QuickPickHost).showQuickPick = async (items) => {
      state.shown = items as typeof state.shown;
      return index === undefined ? undefined : state.shown[index];
    };
    (mockWindow as QuickPickHost).showInformationMessage = async (message) => {
      state.told.push(message);
      return undefined;
    };
    return state;
  }

  it('says so, and opens nothing, when the project has never had a chat', async () => {
    const state = scriptPicker(0);
    const { deps, calls } = chatDeps(projectOf(), { records: {} });
    await chatHistoryFlow(deps, 'p1');
    expect(state.told[0]).toContain('No chats in "magma-os"');
    expect(state.shown).toEqual([]);
    expect(calls.launches).toEqual([]);
  });

  it('lists this project\'s chats and nothing else', async () => {
    const state = scriptPicker(undefined);
    const { deps } = chatDeps(projectOf(), {
      records: {
        [A]: chatRecord(A, { title: 'Chat · magma-os' }),
        // Another project's chat, and one of this project's SESSIONS.
        [B]: chatRecord(B, { cwd: '/elsewhere', title: 'not ours' }),
        [VALID]: chatRecord(VALID, { chat: false, title: 'a session' }),
      },
    });
    await chatHistoryFlow(deps, 'p1');
    expect(state.shown.map((r) => r.sessionId)).toEqual([A]);
  });

  it('labels a row with the first thing said, and orders on transcript activity', async () => {
    const state = scriptPicker(undefined);
    const { deps } = chatDeps(projectOf(), {
      records: {
        // Created FIRST, so record order would put it on top…
        [A]: chatRecord(A, { createdAt: '2026-01-01T00:00:00.000Z' }),
        [B]: chatRecord(B, { createdAt: '2026-01-02T00:00:00.000Z' }),
      },
    });
    // …but B's transcript is older, so A wins on the fact that matters.
    deps.transcriptFacts = (id) =>
      id === A
        ? { lastActiveAt: NOW, firstPrompt: 'why is the roster polling twice\nsecond line' }
        : { lastActiveAt: NOW - HOUR };
    await chatHistoryFlow(deps, 'p1');

    expect(state.shown.map((r) => r.sessionId)).toEqual([A, B]);
    // First LINE only: a pasted stack trace opens with something readable and
    // continues with something that is not.
    expect(state.shown[0].label).toBe('why is the roster polling twice');
  });

  it('marks a live chat and never launches a second process for it', async () => {
    const state = scriptPicker(0);
    const { deps, calls } = chatDeps(projectOf(), {
      records: { [A]: chatRecord(A) },
      focusSession: () => true,
    });
    deps.isLive = () => true;

    await chatHistoryFlow(deps, 'p1');

    expect(state.shown[0].description).toContain('open');
    // Focused, not resumed: a chat is not in the forest, so resumeFlow's own
    // "still running" guard cannot see one and this check is the only one.
    expect(calls.focused).toEqual([A]);
    expect(calls.launches).toEqual([]);
  });

  it('resumes a finished chat through its chain tip', async () => {
    const TIP = uuid(13);
    const state = scriptPicker(0);
    const { deps, calls } = chatDeps(projectOf(), {
      records: { [A]: chatRecord(A) },
      tipOf: (id) => (id === A ? TIP : id),
      hasTranscript: () => true,
    });

    await chatHistoryFlow(deps, 'p1');

    expect(state.shown).toHaveLength(1);
    expect(calls.launches).toHaveLength(1);
    // The resume contract: sessionId === resumeId, and both name the tip.
    expect(calls.launches[0].sessionId).toBe(TIP);
    expect(calls.launches[0].resumeId).toBe(TIP);
  });

  it('does nothing when the picker is dismissed', async () => {
    scriptPicker(undefined);
    const { deps, calls } = chatDeps(projectOf(), {
      records: { [A]: chatRecord(A) },
    });
    await chatHistoryFlow(deps, 'p1');
    expect(calls.launches).toEqual([]);
    expect(calls.focused).toEqual([]);
  });
});

// ------------------------------------------------- close / open a project

describe('closeProjectFlow', () => {
  beforeEach(() => {
    // The flow leaves a status-bar breadcrumb naming the way back in. The mock
    // window is empty by contract, so it is stubbed rather than asserted on.
    (mockWindow as StatusHost).setStatusBarMessage = () => undefined;
  });
  afterEach(() => {
    delete (mockWindow as WarningHost).showWarningMessage;
    delete (mockWindow as QuickPickHost).showInformationMessage;
    delete (mockWindow as StatusHost).setStatusBarMessage;
  });

  /** Scripts the modal's answer and keeps what it said. */
  function scriptConfirm(answer: string | undefined): {
    asked: Array<{ message: string; detail: string }>;
  } {
    const state = { asked: [] as Array<{ message: string; detail: string }> };
    (mockWindow as WarningHost).showWarningMessage = async (
      message: string,
      opts?: unknown,
    ) => {
      state.asked.push({
        message,
        detail: (opts as { detail?: string })?.detail ?? '',
      });
      return answer;
    };
    return state;
  }

  it('asks first, and writes nothing when the answer is no', async () => {
    const state = scriptConfirm(undefined);
    const { deps, calls } = chatDeps(projectOf());
    const closed = await closeProjectFlow(deps, projectOf());
    expect(closed).toBe(false);
    expect(state.asked).toHaveLength(1);
    expect(calls.projectPatches).toEqual([]);
  });

  it('closes by writing `hidden`, and touches nothing else', async () => {
    scriptConfirm('Close Project');
    const { deps, calls } = chatDeps(projectOf());
    const closed = await closeProjectFlow(deps, projectOf());
    expect(closed).toBe(true);
    expect(calls.projectPatches).toEqual([{ id: 'p1', patch: { hidden: true } }]);
    // No session is signalled and no record is written: closing a project is a
    // statement about the tree, not about anything running in it.
    expect(calls.records).toEqual([]);
    expect(calls.order).toContain('refresh');
  });

  it('warns about the sessions still running in it, by number', async () => {
    const state = scriptConfirm(undefined);
    const { deps } = chatDeps(projectOf());
    deps.getForest = () =>
      forestOf([
        node(uuid(21), { cwd: '/Users/a/code/magma', status: 'busy' }),
        node(uuid(22), { cwd: '/Users/a/code/wiki', status: 'waiting' }),
        // Not running, and not in the project: neither is counted.
        node(uuid(23), { cwd: '/Users/a/code/magma', status: 'exited' }),
        node(uuid(24), { cwd: '/somewhere/else', status: 'busy' }),
      ]);

    await closeProjectFlow(deps, projectOf());

    expect(state.asked[0].detail).toContain('2 sessions are still running');
    expect(state.asked[0].detail).toContain('They keep running');
  });

  it('says nothing about running sessions when there are none', async () => {
    const state = scriptConfirm(undefined);
    const { deps } = chatDeps(projectOf());
    await closeProjectFlow(deps, projectOf());
    expect(state.asked[0].detail).not.toContain('still running');
  });
});

describe('reopenProject', () => {
  it('clears the flag and asks nothing at all', async () => {
    const { deps, calls } = chatDeps(projectOf({ hidden: true }));
    await reopenProject(deps, projectOf({ hidden: true }));
    expect(calls.projectPatches).toEqual([{ id: 'p1', patch: { hidden: false } }]);
    expect(calls.order).toContain('refresh');
    // Straight to the row it just put back.
    expect(calls.reveals).toEqual(['p1']);
  });
});

// ------------------------------------------ Configure Project → Rename…

/**
 * The one flow in this file that needs a workbench: it opens a QuickPick, and
 * the branch under test is about what happens to that QuickPick afterwards.
 * The mock's `window`/`commands` are empty objects — the "this host offers
 * nothing" case every other test here relies on — so the two entry points the
 * flow calls are installed for the length of a test and taken away again.
 * Nothing is registered with a workbench; these are the flow's own answers,
 * scripted.
 */
type QuickPickHost = {
  showQuickPick?: (items: unknown, opts?: unknown) => Promise<unknown>;
  showInformationMessage?: (message: string) => Promise<unknown>;
};
type CommandHost = {
  executeCommand?: (id: string, ...rest: unknown[]) => Promise<unknown>;
};
/** The status-bar breadcrumb Close Project leaves behind. */
type StatusHost = {
  setStatusBarMessage?: (text: string, ms?: number) => void;
};
/** The modal behind Close Project. */
type WarningHost = {
  showWarningMessage?: (
    message: string,
    opts?: unknown,
    ...items: string[]
  ) => Promise<string | undefined>;
};

/** The folder dialog, scripted. Both subproject verbs and the create flow reach
 *  it, and it is the only host member `showOpenDialog` uses. */
type DialogHost = {
  showOpenDialog?: (opts?: unknown) => Promise<unknown>;
};

/** The name box behind Add Subproject and Rename Subproject. `validateInput` is
 *  the part worth scripting: the per-project name-collision rule lives in it. */
type InputHost = {
  showInputBox?: (opts?: {
    validateInput?: (value: string) => string | undefined | null;
  }) => Promise<string | undefined>;
};

// ------------------------------------------------------- subprojects, the verbs
//
// A subproject is a DIRECTORY of a project. Add Subproject either MAKES one or
// takes one that already exists; Remove Subproject takes one back off. Everything
// interesting is
// in the refusals — the main directory cannot be removed, and a directory another
// project already covers cannot be added.

describe('the subproject verbs', () => {
  afterEach(() => {
    delete (mockCommands as { registerCommand?: unknown }).registerCommand;
    delete (mockWindow as DialogHost).showOpenDialog;
    delete (mockWindow as InputHost).showInputBox;
    delete (mockWindow as QuickPickHost).showQuickPick;
    delete (mockWindow as QuickPickHost).showInformationMessage;
    delete (mockWindow as WarningHost).showWarningMessage;
  });

  /**
   * Answers each quick pick in turn by label, or cancels when the entry is
   * undefined. Add Subproject asks which directory the lane works in before it
   * asks anything else, so a test that only scripts the folder dialog never
   * reaches it.
   */
  function scriptPicks(...labels: (string | undefined)[]): {
    titles: string[];
    placeholders: string[];
    offered: string[][];
  } {
    const state = {
      titles: [] as string[],
      placeholders: [] as string[],
      offered: [] as string[][],
    };
    let at = 0;
    (mockWindow as QuickPickHost).showQuickPick = async (
      items: unknown,
      opts?: unknown,
    ) => {
      const options = (opts ?? {}) as { title?: string; placeHolder?: string };
      state.titles.push(options.title ?? '');
      state.placeholders.push(options.placeHolder ?? '');
      const list = (Array.isArray(items) ? items : []) as { label?: string }[];
      state.offered.push(list.map((i) => i?.label ?? ''));
      const want = labels[at];
      at += 1;
      if (want === undefined) return undefined;
      return list.find((i) => i?.label === want);
    };
    return state;
  }

  /** Answers the name box, running every candidate past the real validator on the
   *  way — the collision rule is the point of that step. */
  function scriptName(
    name: string | undefined,
    probe: string[] = [],
  ): { rejected: Record<string, string> } {
    const state = { rejected: {} as Record<string, string> };
    (mockWindow as InputHost).showInputBox = async (options?: {
      validateInput?: (value: string) => string | undefined | null;
    }) => {
      for (const candidate of ['', '   ', ...probe]) {
        const said = options?.validateInput?.(candidate);
        if (typeof said === 'string' && said !== '') {
          state.rejected[candidate] = said;
        }
      }
      return name;
    };
    return state;
  }

  /** Answers the folder dialog with `dir`, or cancels when it is undefined. */
  function scriptDialog(dir: string | undefined): { opened: number } {
    const state = { opened: 0 };
    (mockWindow as DialogHost).showOpenDialog = async () => {
      state.opened += 1;
      return dir === undefined ? undefined : [{ fsPath: dir }];
    };
    return state;
  }


  function scriptConfirm(answer: string | undefined): { asked: string[] } {
    const state = { asked: [] as string[] };
    (mockWindow as WarningHost).showWarningMessage = async (message) => {
      state.asked.push(message);
      return answer;
    };
    return state;
  }

  function told(): { messages: string[] } {
    const state = { messages: [] as string[] };
    (mockWindow as QuickPickHost).showInformationMessage = async (message) => {
      state.messages.push(message);
      return undefined;
    };
    return state;
  }

  const app = (over: Partial<ProjectRecord> = {}): ProjectRecord =>
    projectOf({ id: 'p1', name: 'app', rootDir: '/code/app', dirs: [], ...over });

  const ELSEWHERE = 'Another directory…';

  /** Collects what the verb wrote to the subproject store. */
  function laneStore(existing: SubprojectRecord[] = []): {
    deps: Record<string, unknown>;
    written: { id: string; patch: Partial<SubprojectRecord> }[];
    removed: string[];
  } {
    const written: { id: string; patch: Partial<SubprojectRecord> }[] = [];
    const removed: string[] = [];
    return {
      deps: {
        allSubprojects: () => existing,
        getSubproject: (id: string) => existing.find((l) => l.id === id),
        upsertSubproject: async (id: string, patch: Partial<SubprojectRecord>) => {
          written.push({ id, patch });
        },
        deleteSubproject: async (id: string) => {
          removed.push(id);
        },
      },
      written,
      removed,
    };
  }

  const lane = (over: Partial<SubprojectRecord> = {}): SubprojectRecord => ({
    id: 'lane-1',
    projectId: 'p1',
    name: 'Server rewrite',
    dir: '/code/app',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  it('makes a NAMED lane in a directory the project already covers', async () => {
    // THE CASE v7 EXISTS FOR: two subprojects in one folder. Nothing on disk tells
    // them apart, so the name is the whole of what is created — no directory is
    // added and nothing is touched on disk.
    scriptPicks('app');
    scriptName('Server rewrite');
    const store = laneStore();
    const { deps, calls } = chatDeps(app(), { projects: [app()] });
    Object.assign(deps as object, store.deps);
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.newSubproject, { type: 'project', projectId: 'p1' });

    expect(store.written).toEqual([
      { id: expect.any(String), patch: { projectId: 'p1', name: 'Server rewrite', dir: '/code/app' } },
    ]);
    // The project's directory list is untouched: the lane names a directory it
    // already covers.
    expect(calls.projectPatches).toEqual([]);
  });

  it('offers every directory plus the door to a new one, even at one directory', async () => {
    // Uniform at ONE directory for the reason that matters most: a flow that
    // skipped the pick there would leave no way to reach a second directory ever.
    const picks = scriptPicks(undefined);
    const { deps } = chatDeps(app(), { projects: [app()] });
    Object.assign(deps as object, laneStore().deps);
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.newSubproject, { type: 'project', projectId: 'p1' });

    expect(picks.offered[0]).toEqual(['app', ELSEWHERE]);
    expect(picks.placeholders[0]).toContain('Which directory');
  });

  it('adds the picked directory to the project, and a lane in it', async () => {
    // The old add-a-directory behaviour, now reached through "Another directory…".
    // The directory has to join the project or membership would not claim the
    // sessions the lane's own + starts there.
    scriptPicks(ELSEWHERE);
    const dialog = scriptDialog('/code/app/api');
    scriptName('API');
    const store = laneStore();
    const { deps, calls } = chatDeps(app(), { projects: [app()] });
    Object.assign(deps as object, store.deps);
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.newSubproject, { type: 'project', projectId: 'p1' });

    expect(dialog.opened).toBe(1);
    expect(calls.projectPatches).toEqual([
      { id: 'p1', patch: { dirs: ['/code/app/api'] } },
    ]);
    expect(store.written[0].patch).toEqual({
      projectId: 'p1',
      name: 'API',
      dir: '/code/app/api',
    });
  });

  it('does nothing at all when the directory pick is cancelled', async () => {
    scriptPicks(undefined);
    const dialog = scriptDialog('/code/app/api');
    const store = laneStore();
    const { deps, calls } = chatDeps(app(), { projects: [app()] });
    Object.assign(deps as object, store.deps);
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.newSubproject, { type: 'project', projectId: 'p1' });

    expect(dialog.opened).toBe(0);
    expect(store.written).toEqual([]);
    expect(calls.projectPatches).toEqual([]);
  });

  it('does nothing at all when the folder dialog is cancelled', async () => {
    scriptPicks(ELSEWHERE);
    scriptDialog(undefined);
    const store = laneStore();
    const { deps, calls } = chatDeps(app(), { projects: [app()] });
    Object.assign(deps as object, store.deps);
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.newSubproject, { type: 'project', projectId: 'p1' });

    expect(store.written).toEqual([]);
    expect(calls.projectPatches).toEqual([]);
  });

  it('creates nothing when the name is cancelled', async () => {
    scriptPicks('app');
    scriptName(undefined);
    const store = laneStore();
    const { deps, calls } = chatDeps(app(), { projects: [app()] });
    Object.assign(deps as object, store.deps);
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.newSubproject, { type: 'project', projectId: 'p1' });

    expect(store.written).toEqual([]);
    expect(calls.projectPatches).toEqual([]);
  });

  it('refuses a lane name the project already has', async () => {
    // Two lanes in one project with one name would be two rows you cannot tell
    // apart, which is the one thing the name exists to prevent.
    scriptPicks('app');
    const name = scriptName(undefined, ['Server rewrite', 'server REWRITE', 'CS tooling']);
    const store = laneStore([lane()]);
    const { deps } = chatDeps(app(), { projects: [app()] });
    Object.assign(deps as object, store.deps);
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.newSubproject, { type: 'project', projectId: 'p1' });

    expect(name.rejected['Server rewrite']).toContain('already has');
    // Case-insensitively, the way project names collide.
    expect(name.rejected['server REWRITE']).toContain('already has');
    expect(name.rejected['']).toContain('empty');
    expect(name.rejected['CS tooling']).toBeUndefined();
  });

  it('keeps the existing directories when adding a third', async () => {
    // A `dirs` patch replaces the list wholesale, so this is the assertion that
    // stops Add Subproject from being Replace Subprojects.
    scriptPicks(ELSEWHERE);
    scriptDialog('/code/app/web');
    scriptName('Web');
    const two = app({ dirs: ['/code/app/api'] });
    const { deps, calls } = chatDeps(two, { projects: [two] });
    Object.assign(deps as object, laneStore().deps);
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.newSubproject, { type: 'project', projectId: 'p1' });

    expect(calls.projectPatches).toEqual([
      { id: 'p1', patch: { dirs: ['/code/app/api', '/code/app/web'] } },
    ]);
  });

  it('refuses a directory another project already covers', async () => {
    // Two projects listing one directory have no defined owner for the sessions
    // in it — see projects.projectClaiming.
    scriptPicks(ELSEWHERE);
    scriptDialog('/code/other');
    scriptName('Other');
    const warned = scriptConfirm(undefined);
    const other = projectOf({
      id: 'p2',
      name: 'other',
      rootDir: '/code/other',
      dirs: [],
    });
    const store = laneStore();
    const { deps, calls } = chatDeps(app(), { projects: [app(), other] });
    Object.assign(deps as object, store.deps);
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.newSubproject, { type: 'project', projectId: 'p1' });

    expect(calls.projectPatches).toEqual([]);
    // And no lane either: a lane on a directory this project cannot claim would
    // draw a row that holds nothing.
    expect(store.written).toEqual([]);
    expect(warned.asked.join(' ')).toContain('other');
  });

  // --------------------------------------------------- the two lane-only verbs

  it('renames a lane, and only its name', async () => {
    scriptName('CS tooling');
    const store = laneStore([lane()]);
    const { deps } = chatDeps(app(), { projects: [app()] });
    Object.assign(deps as object, store.deps);
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.renameSubproject, {
      type: 'subproject',
      projectId: 'p1',
      dir: '/code/app',
      id: 'lane-1',
    });

    expect(store.written).toEqual([{ id: 'lane-1', patch: { name: 'CS tooling' } }]);
  });

  it('removes a lane once confirmed, and leaves the directory alone', async () => {
    const confirm = scriptConfirm('Remove Subproject');
    const store = laneStore([lane()]);
    const { deps, calls } = chatDeps(app(), { projects: [app()] });
    Object.assign(deps as object, store.deps);
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.removeSubproject, {
      type: 'subproject',
      projectId: 'p1',
      dir: '/code/app',
      id: 'lane-1',
    });

    expect(store.removed).toEqual(['lane-1']);
    // The directory stays the project's — removing a lane removes a NAME.
    expect(calls.projectPatches).toEqual([]);
    const said = confirm.asked.join(' ');
    expect(said).toContain('Server rewrite');
  });

  it('removes nothing when the confirmation is declined', async () => {
    scriptConfirm(undefined);
    const store = laneStore([lane()]);
    const { deps } = chatDeps(app(), { projects: [app()] });
    Object.assign(deps as object, store.deps);
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.removeSubproject, {
      type: 'subproject',
      projectId: 'p1',
      dir: '/code/app',
      id: 'lane-1',
    });

    expect(store.removed).toEqual([]);
  });

  it('takes a DIRECTORY row down the directory path, not the lane path', async () => {
    // An implicit row's id is `dir:<key>` and names no record, so Remove Subproject
    // has to fall through to taking the directory off the project.
    const confirm = scriptConfirm('Remove Subproject');
    const two = app({ dirs: ['/code/app/api'] });
    const store = laneStore();
    const { deps, calls } = chatDeps(two, { projects: [two] });
    Object.assign(deps as object, store.deps);
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.removeSubproject, {
      type: 'subproject',
      projectId: 'p1',
      dir: '/code/app/api',
      id: 'dir:/code/app/api',
    });

    expect(store.removed).toEqual([]);
    expect(calls.projectPatches).toEqual([{ id: 'p1', patch: { dirs: [] } }]);
    expect(confirm.asked.join(' ')).toContain('api');
  });


  it('removes a directory once confirmed, keeping the rest', async () => {
    const confirm = scriptConfirm('Remove Subproject');
    const three = app({ dirs: ['/code/app/api', '/code/app/web'] });
    const { deps, calls } = chatDeps(three, { projects: [three] });
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.removeSubproject, {
      type: 'subproject',
      projectId: 'p1',
      dir: '/code/app/api',
    });

    expect(confirm.asked).toHaveLength(1);
    expect(calls.projectPatches).toEqual([
      { id: 'p1', patch: { dirs: ['/code/app/web'] } },
    ]);
  });

  it('says what happens to the rows when the last one goes', async () => {
    const confirm = scriptConfirm(undefined);
    const two = app({ dirs: ['/code/app/api'] });
    const { deps, calls } = chatDeps(two, { projects: [two] });
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.removeSubproject, {
      type: 'subproject',
      projectId: 'p1',
      dir: '/code/app/api',
    });

    // Declined, so nothing was written — and the dialog named the consequence
    // rather than leaving the user to discover it.
    expect(calls.projectPatches).toEqual([]);
    expect(confirm.asked[0]).toContain('api');
  });

  it('refuses to remove the MAIN directory', async () => {
    // It is the project's own address; removing it is Delete Project wearing the
    // wrong label, and the store would refuse the write anyway.
    const warned = scriptConfirm(undefined);
    const two = app({ dirs: ['/code/app/api'] });
    const { deps, calls } = chatDeps(two, { projects: [two] });
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.removeSubproject, {
      type: 'subproject',
      projectId: 'p1',
      dir: '/code/app',
    });

    expect(calls.projectPatches).toEqual([]);
    expect(warned.asked[0]).toContain('main directory');
  });

  it('tells a single-directory project it has no subprojects', async () => {
    const messages = told();
    const { deps, calls } = chatDeps(app(), { projects: [app()] });
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.removeSubproject, { type: 'project', projectId: 'p1' });

    expect(calls.projectPatches).toEqual([]);
    expect(messages.messages.join(' ')).toContain('Add Subproject');
  });

  it('starts a session in the named directory, re-validated against the project', async () => {
    const two = app({ dirs: ['/code/app/api'] });
    const { deps, calls } = chatDeps(two, { projects: [two] });
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.newSessionInSubproject, {
      type: 'subproject',
      projectId: 'p1',
      dir: '/code/app/api',
    });

    expect(calls.launches).toHaveLength(1);
    expect(calls.launches[0].cwd).toBe('/code/app/api');
    // Named for the DIRECTORY, not the project: under a project that has split
    // into rows, "app 3" says nothing and "api" says which row it is in.
    expect(calls.launches[0].title).toBe('api');
  });

  it('refuses a directory the project no longer covers', async () => {
    const messages = told();
    const { deps, calls } = chatDeps(app(), { projects: [app()] });
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.newSessionInSubproject, {
      type: 'subproject',
      projectId: 'p1',
      dir: '/etc',
    });

    expect(calls.launches).toEqual([]);
    expect(messages.messages.join(' ')).toContain('no longer covers');
  });

  it('refuses an argument of the wrong shape outright', async () => {
    const { deps, calls } = chatDeps(app(), { projects: [app()] });
    const { run } = withRegisteredCommands(deps as never);
    // A project row's own argument shape. `type: 'project'` must not reach this
    // verb, or a project row would silently start a session in its main
    // directory through a verb that promises a named one.
    await run(COMMANDS.newSessionInSubproject, {
      type: 'project',
      projectId: 'p1',
      dir: '/code/app',
    });
    expect(calls.launches).toEqual([]);
  });
});

// ---------------------------------------------------------- creating a project

describe('newProject: one directory, no confirmation step', () => {
  afterEach(() => {
    delete (mockCommands as { registerCommand?: unknown }).registerCommand;
    delete (mockCommands as CommandHost).executeCommand;
    delete (mockWindow as DialogHost).showOpenDialog;
    delete (mockWindow as QuickPickHost).showQuickPick;
    delete (mockWindow as WarningHost).showWarningMessage;
  });

  it('creates the project straight from the folder dialog', async () => {
    // It used to open a quick pick — "Create Project" / "Add Another Directory…"
    // — and loop until the user committed. The dialog's own OK button is the
    // confirmation; the second directory is a thing you discover later, and it
    // has its own verb on the project by then.
    let picks = 0;
    (mockWindow as QuickPickHost).showQuickPick = async () => {
      picks += 1;
      return undefined;
    };
    (mockWindow as DialogHost).showOpenDialog = async () => [
      { fsPath: '/code/creemux' },
    ];
    // The create ends by revealing the row and opening an editor on its label,
    // which delegates to `renameProject`. Scripted so the hand-off resolves
    // instead of throwing out of the handler.
    (mockCommands as CommandHost).executeCommand = async () => undefined;
    const { deps, calls } = chatDeps(undefined, { projects: [] });
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.newProject);

    expect(picks).toBe(0);
    expect(calls.projectPatches).toHaveLength(1);
    expect(calls.projectPatches[0].patch).toMatchObject({
      name: 'creemux',
      rootDir: '/code/creemux',
      dirs: [],
    });
    // No parentId either: nesting records is retired.
    expect(calls.projectPatches[0].patch.parentId).toBeUndefined();
  });

  it('writes nothing when the dialog is cancelled', async () => {
    (mockWindow as DialogHost).showOpenDialog = async () => undefined;
    const { deps, calls } = chatDeps(undefined, { projects: [] });
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.newProject);

    expect(calls.projectPatches).toEqual([]);
  });

  it('refuses a directory an existing project already covers', async () => {
    const warned: string[] = [];
    (mockWindow as WarningHost).showWarningMessage = async (message) => {
      warned.push(message);
      return undefined;
    };
    (mockWindow as DialogHost).showOpenDialog = async () => [
      { fsPath: '/code/app' },
    ];
    const existing = projectOf({
      id: 'p1',
      name: 'app',
      rootDir: '/code/app',
      dirs: [],
    });
    const { deps, calls } = chatDeps(existing, { projects: [existing] });
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.newProject);

    expect(calls.projectPatches).toEqual([]);
    expect(warned.join(' ')).toContain('subproject');
  });
});

describe('configureProjectFlow: the project Settings menu', () => {
  afterEach(() => {
    delete (mockWindow as QuickPickHost).showQuickPick;
    delete (mockWindow as QuickPickHost).showInformationMessage;
    delete (mockCommands as CommandHost).executeCommand;
  });

  /** Scripts one answer per QuickPick the flow opens, and records how many it
   *  actually opened — which is the whole question here. */
  function scriptMenu(answers: Array<{ action: string } | undefined>): {
    opened: number;
    ran: Array<[string, unknown]>;
    items: unknown[][];
  } {
    const state = { opened: 0, ran: [] as Array<[string, unknown]>, items: [] as unknown[][] };
    (mockWindow as QuickPickHost).showQuickPick = async (items: unknown) => {
      state.opened += 1;
      state.items.push(Array.isArray(items) ? items : []);
      return answers.shift();
    };
    (mockCommands as CommandHost).executeCommand = async (id, arg) => {
      state.ran.push([id, arg]);
      return undefined;
    };
    return state;
  }

  // The split that defines this menu: the seven verbs anybody reaches for are on
  // the row, and what a project IS lives in here. Rename, Close and Delete used
  // to be in both places, which is how a right-click grew to fourteen entries.
  it('offers none of the seven verbs that are on the row', () => {
    const state = scriptMenu([undefined]);
    const { deps } = chatDeps(projectOf());
    return configureProjectFlow(deps, 'p1').then(() => {
      const labels = (state.items[0] as Array<{ label: string }>).map(
        (i) => i.label,
      );
      const joined = labels.join(' | ');
      for (const gone of ['Rename', 'Close Project', 'Delete Project', 'New Chat']) {
        expect(joined, gone).not.toContain(gone);
      }
      expect(joined).toContain('Set Provider');
      expect(joined).toContain('Set AI Account');
      expect(joined).toContain('Switch Workspace');
      expect(joined).toContain('Open in New Window');
    });
  });

  // Four entries are DELEGATED to the commands that already own them, rather
  // than reimplemented: each has a picker, a refusal and a message of its own
  // that must not exist twice.
  it.each([
    ['account', COMMANDS.setProjectAccount],
    ['sessionFrom', COMMANDS.newSessionFromPicker],
    ['workspace', COMMANDS.switchWorkspace],
    ['openWindow', COMMANDS.openProject],
  ])('delegates %s and closes the menu', async (action, command) => {
    const state = scriptMenu([{ action }]);
    const { deps } = chatDeps(projectOf());

    await configureProjectFlow(deps, 'p1');

    expect(state.ran).toEqual([[command, { type: 'project', projectId: 'p1' }]]);
    // ONE QuickPick. Each of these opens a picker or a window of its own, and a
    // menu reopening behind one takes the keyboard off it — the same rule the
    // rename hand-off followed before it moved to the row.
    expect(state.opened).toBe(1);
  });

  // Only offered on a project that HAS more than one directory: both verbs are
  // about choosing between them, and a choice between one thing is a menu entry
  // that has to explain itself when clicked.
  it('withholds the directory verbs from a single-directory project', async () => {
    const state = scriptMenu([undefined]);
    const { deps } = chatDeps(projectOf({ dirs: [] }));

    await configureProjectFlow(deps, 'p1');

    const labels = (state.items[0] as Array<{ label: string }>).map((i) => i.label);
    expect(labels.join(' | ')).not.toContain('Set Main Directory');
    expect(labels.join(' | ')).not.toContain('Remove Subproject');
  });

  it('offers them once there are two', async () => {
    const state = scriptMenu([undefined]);
    const { deps } = chatDeps(projectOf());

    await configureProjectFlow(deps, 'p1');

    const labels = (state.items[0] as Array<{ label: string }>).map((i) => i.label);
    expect(labels.join(' | ')).toContain('Set Main Directory');
    expect(labels.join(' | ')).toContain('Remove Subproject');
  });
});

describe('detach tier: resumeFlow is the attach verb for hidden sessions', () => {
  // A workspace switch detached the session: the process runs, hidden, in the
  // private tmux server, and the record carries the tmux name. Clicking its
  // row must ATTACH — the old "still running, fork it instead" refusal was
  // written for sessions other windows own, and a detached one is ours.
  const TMUX = `lineage-${VALID}`;
  const rec = (over: Partial<EditorialRecord> = {}): EditorialRecord => ({
    id: VALID,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  afterEach(() => {
    delete (mockWindow as { showWarningMessage?: unknown }).showWarningMessage;
  });

  function warnCounter(): { count: number } {
    const state = { count: 0 };
    (
      mockWindow as {
        showWarningMessage?: (m: string) => Promise<unknown>;
      }
    ).showWarningMessage = async () => {
      state.count += 1;
      return undefined;
    };
    return state;
  }

  it('detachedTmuxName reads the name off the id or its chain tip', async () => {
    const { deps } = chatDeps(undefined);
    const tip = uuid(9);
    const viaTip: CommandDeps = {
      ...deps,
      tipOf: () => tip,
      getRecord: (id) => (id === tip ? rec({ id: tip, tmux: TMUX }) : undefined),
    };
    expect(await detachedTmuxName(viaTip, VALID)).toBe(TMUX);
    // A kill park writes `tmux: null` — that is NOT a detached session.
    const killed: CommandDeps = {
      ...deps,
      getRecord: () => rec({ tmux: null, parked: true }),
    };
    expect(await detachedTmuxName(killed, VALID)).toBeUndefined();
    // No probe wired (every unit double): recorded names only.
    expect(await detachedTmuxName(deps, VALID)).toBeUndefined();
  });

  /**
   * A record only names a wrap that a PARK created, but the launch wraps
   * everything it starts. A session that was launched, bound to a tab and
   * never parked therefore has a live wrap nothing recorded — invisible while
   * the tab answers first, and the reason 21 of 40 live wraps became "running
   * in another app or terminal" after a VS Code restart.
   */
  describe('an unrecorded wrap is still found, by deriving the name', () => {
    it('probes the derived name when the record carries none', async () => {
      const { deps } = chatDeps(undefined);
      const asked: string[] = [];
      const probed: CommandDeps = {
        ...deps,
        tmuxSessionLive: async (name) => {
          asked.push(name);
          return name === `lineage-${VALID}`;
        },
      };

      expect(await detachedTmuxName(probed, VALID)).toBe(`lineage-${VALID}`);
      expect(asked).toEqual([`lineage-${VALID}`]);
    });

    it('does not resurrect a wrap a kill-tier park really killed', async () => {
      const { deps } = chatDeps(undefined);
      // `tmux: null` says the park killed it; the server agrees by not
      // answering. The probe is ground truth, so deriving is safe here.
      const killed: CommandDeps = {
        ...deps,
        getRecord: () => rec({ tmux: null, parked: true }),
        tmuxSessionLive: async () => false,
      };

      expect(await detachedTmuxName(killed, VALID)).toBeUndefined();
    });

    it('prefers the recorded name over deriving, and skips the probe', async () => {
      const { deps } = chatDeps(undefined);
      let probes = 0;
      // A re-key while parked leaves the wrap under the id it was LAUNCHED
      // with; only the record remembers which that was, so it must win.
      const recorded: CommandDeps = {
        ...deps,
        getRecord: () => rec({ tmux: TMUX }),
        tmuxSessionLive: async () => {
          probes += 1;
          return true;
        },
      };

      expect(await detachedTmuxName(recorded, VALID)).toBe(TMUX);
      expect(probes).toBe(0);
    });

    it('tries the chain tip and the clicked id, and gives up quietly if the probe throws', async () => {
      const { deps } = chatDeps(undefined);
      const tip = uuid(9);
      const asked: string[] = [];
      const viaTip: CommandDeps = {
        ...deps,
        tipOf: () => tip,
        tmuxSessionLive: async (name) => {
          asked.push(name);
          return name === `lineage-${VALID}`;
        },
      };

      expect(await detachedTmuxName(viaTip, VALID)).toBe(`lineage-${VALID}`);
      expect(asked).toEqual([`lineage-${tip}`, `lineage-${VALID}`]);

      const throws: CommandDeps = {
        ...deps,
        tmuxSessionLive: async () => {
          throw new Error('tmux: no server running');
        },
      };
      expect(await detachedTmuxName(throws, VALID)).toBeUndefined();
    });
  });

  it('attaches to a LIVE detached session instead of refusing it', async () => {
    const warned = warnCounter();
    const { deps, calls } = chatDeps(undefined);
    const live: CommandDeps = {
      ...deps,
      getForest: () => forestOf([node(VALID, { status: 'busy' })]),
      getRecord: () => rec({ tmux: TMUX, parked: true }),
      hasTranscript: () => true,
      launchSession: async (opts) => {
        calls.launches.push(opts);
        return {
          nodeId: opts.sessionId,
          sessionId: opts.sessionId,
          terminalName: 'claude',
          createdAt: 0,
        };
      },
    };

    expect(await resumeFlow(live, VALID)).toBe(true);
    expect(warned.count).toBe(0);
    expect(calls.launches).toEqual([
      expect.objectContaining({
        sessionId: VALID,
        resumeId: VALID,
        tmuxName: TMUX,
      }),
    ]);
    // The tab is back: the record must stop claiming "hidden".
    expect(calls.records).toContainEqual({
      id: VALID,
      patch: { closed: null, parked: false, tmux: null },
    });
  });

  it('still refuses a live session with NO tmux record — fork it instead', async () => {
    const warned = warnCounter();
    const { deps, calls } = chatDeps(undefined);
    const live: CommandDeps = {
      ...deps,
      getForest: () => forestOf([node(VALID, { status: 'busy' })]),
      hasTranscript: () => true,
    };

    expect(await resumeFlow(live, VALID)).toBe(false);
    expect(warned.count).toBe(1);
    expect(calls.launches).toEqual([]);
  });
});

// -------------------------------------------------------------- accounts
//
// `forkFlow`/`newSessionFlow`/`newSessionInProjectFlow` are module-private —
// only reachable through their registered commands, see the note beside
// `AccountCommandDeps` in src/commands.ts — precisely so nothing outside
// commands.ts can drift from the account handling every launch origin shares.
// `resumeFlow` above is the one exported entry point and already proves the
// PIN wins over routing for an existing conversation; the two blocks below
// reach the private flows the same way test/commands.test.ts already reaches
// `configureProjectFlow`'s QuickPick branches — by registering the real
// commands against the mock and scripting only what each path touches.

function accountProfile(
  id: string,
  over: Partial<AccountProfile> = {},
): AccountProfile {
  return {
    id,
    provider: 'claude',
    label: id,
    order: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

interface AccountCalls {
  pinned: Array<{ sessionId: string; profileId: string }>;
  deleted: string[];
  defaultRoutingSet: Array<RoutingChoice | null>;
  refreshed: number;
  createdDirs: string[];
}

function fakeAccountDeps(
  profiles: AccountProfile[],
  over: Partial<AccountDeps> = {},
): { accounts: AccountDeps; calls: AccountCalls } {
  const calls: AccountCalls = {
    pinned: [],
    deleted: [],
    defaultRoutingSet: [],
    refreshed: 0,
    createdDirs: [],
  };
  const accounts: AccountDeps = {
    accounts: () => profiles,
    getAccount: (id) => profiles.find((p) => p.id === id),
    upsertAccount: async () => undefined,
    deleteAccount: async (id) => {
      calls.deleted.push(id);
    },
    setAccountOrder: async () => undefined,
    defaultRouting: () => undefined,
    setDefaultRouting: async (choice) => {
      calls.defaultRoutingSet.push(choice);
    },
    setProjectRouting: async () => undefined,
    sessionProfileId: () => undefined,
    pinSession: async (sessionId, profileId) => {
      calls.pinned.push({ sessionId, profileId });
    },
    usage: () => null,
    usageMap: () => new Map(),
    refreshUsage: async () => undefined,
    onUsageChanged: () => ({ dispose: () => undefined }),
    createProfileDir: async (id) => {
      calls.createdDirs.push(id);
      return `/created/${id}`;
    },
    claudeBinary: () => null,
    mediaPath: () => undefined,
    refreshAccounts: () => {
      calls.refreshed += 1;
    },
    ...over,
  };
  return { accounts, calls };
}

/**
 * `registerCommands()` is documented (top of this file) as never exercised,
 * and that holds everywhere except here: the launch flows live behind it.
 * Scripting
 * `vscode.commands.registerCommand` to capture handlers by id is the one way
 * to reach them without widening commands.ts's exported surface just for
 * tests.
 */
function withRegisteredCommands(deps: AccountCommandDeps): {
  run: (id: string, ...args: unknown[]) => Promise<void>;
} {
  type Handler = (...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  (
    mockCommands as {
      registerCommand?: (id: string, handler: Handler) => { dispose(): void };
    }
  ).registerCommand = (id, handler) => {
    handlers.set(id, handler);
    return {
      dispose(): void {
        handlers.delete(id);
      },
    };
  };
  registerCommands(deps);
  return {
    async run(id, ...args) {
      const handler = handlers.get(id);
      if (!handler) throw new Error(`command not registered: ${id}`);
      await handler(...args);
    },
  };
}

describe('fork inherits the PARENT pin, never the routing choice of the day', () => {
  afterEach(() => {
    delete (mockCommands as { registerCommand?: unknown }).registerCommand;
  });

  it("carries the parent's profile env/id even when the global default names someone else", async () => {
    const PARENT = uuid(1);
    const WORK = accountProfile('work', { configDir: '/work/.claude', order: 0 });
    const PERSONAL = accountProfile('personal', {
      configDir: '/personal/.claude',
      order: 1,
    });
    const { accounts, calls: acctCalls } = fakeAccountDeps([WORK, PERSONAL], {
      sessionProfileId: (id) => (id === PARENT ? PERSONAL.id : undefined),
      // What auto/global-default routing would pick TODAY, if fork asked it —
      // which it must not: a fork reads the parent's OWN transcript, which
      // lives inside the parent account's config directory and nowhere else.
      defaultRouting: () => ({ kind: 'account', id: WORK.id }),
    });
    const { deps, calls } = chatDeps(undefined, {
      hasTranscript: () => true,
      beginInlineRename: () => true,
    });
    const withAccounts: AccountCommandDeps = {
      ...deps,
      getForest: () => forestOf([node(PARENT, { cwd: '/code/api', label: 'auth' })]),
      launchSession: async (opts) => {
        calls.launches.push(opts);
        return {
          nodeId: opts.sessionId,
          sessionId: opts.sessionId,
          terminalName: 'claude',
          createdAt: 0,
        };
      },
      accounts,
    };

    const harness = withRegisteredCommands(withAccounts);
    await harness.run(COMMANDS.forkSession, PARENT);

    expect(calls.launches).toHaveLength(1);
    const launch = calls.launches[0];
    expect(launch.parentId).toBe(PARENT);
    expect(launch.profileId).toBe(PERSONAL.id);
    expect(launch.env).toEqual({ CLAUDE_CONFIG_DIR: '/personal/.claude' });
    expect(acctCalls.pinned).toEqual([
      { sessionId: launch.sessionId, profileId: PERSONAL.id },
    ]);
  });

  it('with no pin recorded (a conversation started before accounts existed), forks with no env at all', async () => {
    const PARENT = uuid(1);
    const WORK = accountProfile('work', { configDir: '/work/.claude' });
    const { accounts, calls: acctCalls } = fakeAccountDeps([WORK], {
      sessionProfileId: () => undefined, // never pinned
      defaultRouting: () => ({ kind: 'account', id: WORK.id }),
    });
    const { deps, calls } = chatDeps(undefined, {
      hasTranscript: () => true,
      beginInlineRename: () => true,
    });
    const withAccounts: AccountCommandDeps = {
      ...deps,
      getForest: () => forestOf([node(PARENT, { cwd: '/code/api' })]),
      launchSession: async (opts) => {
        calls.launches.push(opts);
        return {
          nodeId: opts.sessionId,
          sessionId: opts.sessionId,
          terminalName: 'claude',
          createdAt: 0,
        };
      },
      accounts,
    };

    const harness = withRegisteredCommands(withAccounts);
    await harness.run(COMMANDS.forkSession, PARENT);

    expect(calls.launches[0].env).toBeUndefined();
    expect(calls.launches[0].profileId).toBeUndefined();
    expect(acctCalls.pinned).toEqual([]);
  });
});

/**
 * Forking an UNSTARTED branch — the row that shows a full conversation and has
 * written nothing.
 *
 * `--fork-session --resume` renders the inherited history as soon as the
 * terminal opens, but claude writes the transcript lazily, so until the branch
 * takes its first turn there is no file under its own id. Reported as "I
 * clicked Fork and Compact and got 'session has no transcript yet' on a session
 * I have been reading all afternoon".
 */
describe('fork falls back to the parent of a branch that never took a turn', () => {
  afterEach(() => {
    delete (mockCommands as { registerCommand?: unknown }).registerCommand;
    delete (mockWindow as { showWarningMessage?: unknown }).showWarningMessage;
  });

  interface ForkHarness {
    launches: LaunchOptions[];
    edges: Array<[string, string | null]>;
    titles: string[];
    warnings: string[];
    run: (command: string, arg: string) => Promise<void>;
  }

  /** `started` owns a transcript; every other id in `records` does not. */
  function forkHarness(
    started: string,
    records: Record<string, EditorialRecord>,
  ): ForkHarness {
    const launches: LaunchOptions[] = [];
    const edges: Array<[string, string | null]> = [];
    const titles: string[] = [];
    const warnings: string[] = [];
    (
      mockWindow as { showWarningMessage?: (m: unknown) => Promise<unknown> }
    ).showWarningMessage = async (message: unknown) => {
      warnings.push(String(message));
      return undefined;
    };
    const { accounts } = fakeAccountDeps([], {
      sessionProfileId: () => undefined,
    });
    const { deps } = chatDeps(undefined, {
      records,
      hasTranscript: (id) => id === started,
      beginInlineRename: () => true,
    });
    const withAccounts: AccountCommandDeps = {
      ...deps,
      getForest: () =>
        forestOf(
          Object.keys(records).map((id) =>
            // 8 chars, not 3: `uuid(n)` only differs at index 7, and a fork's
            // generated name is derived from its parent's LABEL — a 3-char
            // slice makes every node here read as '000' and quietly defeats
            // any assertion about which row the name came from.
            node(id, { cwd: '/code/api', label: id.slice(0, 8) }),
          ),
        ),
      recordLaunch: async (childId, parentId) => {
        edges.push([childId, parentId]);
      },
      upsertRecord: async (id, patch) => {
        if (typeof patch.title === 'string') titles.push(patch.title);
        return deps.upsertRecord(id, patch);
      },
      launchSession: async (opts) => {
        launches.push(opts);
        return {
          nodeId: opts.sessionId,
          sessionId: opts.sessionId,
          terminalName: 'claude',
          createdAt: 0,
        };
      },
      accounts,
    };
    const harness = withRegisteredCommands(withAccounts);
    return {
      launches,
      edges,
      titles,
      warnings,
      run: (command, arg) => harness.run(command, arg),
    };
  }

  function record(id: string, parentId: string | null): EditorialRecord {
    return {
      id,
      parentId,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  it('resumes the parent transcript, but lands the branch UNDER the clicked row', async () => {
    const STARTED = uuid(1);
    const UNSTARTED = uuid(2);
    const h = forkHarness(STARTED, {
      [STARTED]: record(STARTED, null),
      [UNSTARTED]: record(UNSTARTED, STARTED),
    });

    await h.run(COMMANDS.forkAndCompact, UNSTARTED);

    expect(h.warnings).toEqual([]);
    expect(h.launches).toHaveLength(1);
    // The launch reads the only transcript that exists — forced by disk.
    expect(h.launches[0].parentId).toBe(STARTED);
    expect(h.launches[0].prompt).toBe('/compact');
    // The EDGE is the free choice, and it follows the click. Recording STARTED
    // here is what put forks beside the branch the user aimed at instead of
    // under it; the bytes are identical either way, so the tie breaks on intent.
    expect(h.edges).toEqual([[h.launches[0].sessionId, UNSTARTED]]);
  });

  it('names the branch after the clicked row, not the transcript it replayed', async () => {
    const STARTED = uuid(1);
    const UNSTARTED = uuid(2);
    const h = forkHarness(STARTED, {
      [STARTED]: record(STARTED, null),
      [UNSTARTED]: record(UNSTARTED, STARTED),
    });

    // forkHarness labels every node `id.slice(0, 8)`, so the two are distinct.
    await h.run(COMMANDS.forkSession, UNSTARTED);

    // The visible tell of the old mix-up: forking `accounts` produced a branch
    // called `shipping 3`, announcing the silent retarget as the user's choice.
    expect(h.titles).toHaveLength(1);
    expect(h.titles[0]).toContain(UNSTARTED.slice(0, 8));
    expect(h.titles[0]).not.toContain(STARTED.slice(0, 8));
  });

  it('walks up a run of unstarted branches to the last one that wrote', async () => {
    const STARTED = uuid(1);
    const MIDDLE = uuid(2);
    const LEAF = uuid(3);
    const h = forkHarness(STARTED, {
      [STARTED]: record(STARTED, null),
      [MIDDLE]: record(MIDDLE, STARTED),
      [LEAF]: record(LEAF, MIDDLE),
    });

    await h.run(COMMANDS.forkSession, LEAF);

    // Walks past MIDDLE for the bytes...
    expect(h.launches[0].parentId).toBe(STARTED);
    // ...but the branch still hangs off the row that was clicked, however many
    // unstarted hops the walk crossed to find a transcript.
    expect(h.edges).toEqual([[h.launches[0].sessionId, LEAF]]);
  });

  it('still refuses a session with no transcript anywhere above it', async () => {
    const FRESH = uuid(1);
    const h = forkHarness(uuid(9), { [FRESH]: record(FRESH, null) });

    await h.run(COMMANDS.forkSession, FRESH);

    expect(h.launches).toEqual([]);
    expect(h.warnings).toEqual([
      'Session has no transcript yet — send one message first.',
    ]);
  });

  it('refuses rather than looping when the recorded edges form a cycle', async () => {
    const A = uuid(1);
    const B = uuid(2);
    const h = forkHarness(uuid(9), {
      [A]: record(A, B),
      [B]: record(B, A),
    });

    await h.run(COMMANDS.forkSession, A);

    expect(h.launches).toEqual([]);
    expect(h.warnings).toHaveLength(1);
  });
});

describe('a new session (newSessionInBranch) is routed and its pin recorded', () => {
  const PROJECT = 'p1';

  afterEach(() => {
    delete (mockCommands as { registerCommand?: unknown }).registerCommand;
  });

  function projectAndBranch(): {
    project: ProjectRecord;
    branchArg: { type: 'branch'; projectId: string; dir: string; branch: string };
  } {
    const project: ProjectRecord = {
      id: PROJECT,
      name: 'API',
      rootDir: '/code/api',
      dirs: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    return {
      project,
      branchArg: { type: 'branch', projectId: PROJECT, dir: '/code/api', branch: 'main' },
    };
  }

  it('routes via the global default and records the winning profile as the pin', async () => {
    const { project, branchArg } = projectAndBranch();
    const PERSONAL = accountProfile('personal', { configDir: '/personal/.claude' });
    const { accounts, calls: acctCalls } = fakeAccountDeps([PERSONAL], {
      defaultRouting: () => ({ kind: 'account', id: PERSONAL.id }),
    });
    const { deps, calls } = chatDeps(project, { beginInlineRename: () => true });
    const withAccounts: AccountCommandDeps = {
      ...deps,
      getBranches: () => [
        { name: 'main', dir: '/code/api', colorIndex: 0, rootIds: [], primary: true, shown: true },
      ],
      launchSession: async (opts) => {
        calls.launches.push(opts);
        return {
          nodeId: opts.sessionId,
          sessionId: opts.sessionId,
          terminalName: 'claude',
          createdAt: 0,
        };
      },
      accounts,
    };

    const harness = withRegisteredCommands(withAccounts);
    await harness.run(COMMANDS.newSessionInBranch, branchArg);

    expect(calls.launches).toHaveLength(1);
    const launch = calls.launches[0];
    expect(launch.profileId).toBe(PERSONAL.id);
    expect(launch.env).toEqual({ CLAUDE_CONFIG_DIR: '/personal/.claude' });
    expect(SESSION_ID_RE.test(launch.sessionId)).toBe(true);
    expect(acctCalls.pinned).toEqual([
      { sessionId: launch.sessionId, profileId: PERSONAL.id },
    ]);
  });

  it('a project override wins over the global default', async () => {
    const { project: base, branchArg } = projectAndBranch();
    const project: ProjectRecord = {
      ...base,
      routing: { kind: 'account', id: 'pinned-project-account' },
    };
    const PROJECT_ACCT = accountProfile('pinned-project-account', {
      configDir: '/client/.claude',
    });
    const OTHER = accountProfile('other', { configDir: '/other/.claude' });
    const { accounts, calls: acctCalls } = fakeAccountDeps(
      [PROJECT_ACCT, OTHER],
      { defaultRouting: () => ({ kind: 'account', id: OTHER.id }) },
    );
    const { deps, calls } = chatDeps(project, { beginInlineRename: () => true });
    const withAccounts: AccountCommandDeps = {
      ...deps,
      getBranches: () => [
        { name: 'main', dir: '/code/api', colorIndex: 0, rootIds: [], primary: true, shown: true },
      ],
      launchSession: async (opts) => {
        calls.launches.push(opts);
        return {
          nodeId: opts.sessionId,
          sessionId: opts.sessionId,
          terminalName: 'claude',
          createdAt: 0,
        };
      },
      accounts,
    };

    const harness = withRegisteredCommands(withAccounts);
    await harness.run(COMMANDS.newSessionInBranch, branchArg);

    expect(calls.launches[0].profileId).toBe(PROJECT_ACCT.id);
    expect(acctCalls.pinned).toEqual([
      { sessionId: calls.launches[0].sessionId, profileId: PROJECT_ACCT.id },
    ]);
  });

  it('with no accounts wiring at all, launches plainly — no env, no pin', async () => {
    const { project, branchArg } = projectAndBranch();
    const { deps, calls } = chatDeps(project, { beginInlineRename: () => true });
    const withoutAccounts: AccountCommandDeps = {
      ...deps,
      getBranches: () => [
        { name: 'main', dir: '/code/api', colorIndex: 0, rootIds: [], primary: true, shown: true },
      ],
      launchSession: async (opts) => {
        calls.launches.push(opts);
        return {
          nodeId: opts.sessionId,
          sessionId: opts.sessionId,
          terminalName: 'claude',
          createdAt: 0,
        };
      },
      // deps.accounts intentionally left undefined: a host with no accounts.
    };

    const harness = withRegisteredCommands(withoutAccounts);
    await harness.run(COMMANDS.newSessionInBranch, branchArg);

    expect(calls.launches).toHaveLength(1);
    expect('env' in calls.launches[0]).toBe(false);
    expect('profileId' in calls.launches[0]).toBe(false);
  });
});

// The launcher execs the Claude CLI and nothing else. An account whose
// isolation lives in another tool's variable (`CODEX_HOME`) would launch
// `claude` on the machine's DEFAULT login while the pin, the row and the
// status line all named the other account — so the verbs refuse it out loud
// instead, and the router never offers it in the first place.
describe('a session never starts on an account no session can run on', () => {
  afterEach(() => {
    delete (mockCommands as { registerCommand?: unknown }).registerCommand;
    delete (mockWindow as { showWarningMessage?: unknown }).showWarningMessage;
  });

  function captureWarnings(): string[] {
    const seen: string[] = [];
    (
      mockWindow as { showWarningMessage?: (...args: unknown[]) => Promise<unknown> }
    ).showWarningMessage = async (message: unknown) => {
      seen.push(String(message));
      return undefined;
    };
    return seen;
  }

  it('"New Session on this account" on a Codex row refuses instead of launching', async () => {
    const warnings = captureWarnings();
    const CODEX = accountProfile('codex-default', {
      provider: 'codex',
      label: 'Codex — default',
    });
    const { accounts, calls: acctCalls } = fakeAccountDeps([CODEX]);
    const { deps, calls } = chatDeps(undefined);
    const withAccounts: AccountCommandDeps = { ...deps, accounts };

    const harness = withRegisteredCommands(withAccounts);
    await harness.run(COMMANDS.newSessionFromAccount, CODEX.id);

    expect(calls.launches).toEqual([]);
    expect(acctCalls.pinned).toEqual([]);
    expect(warnings.join(' ')).toContain('Codex');
  });

  it('it cannot be made the default for new sessions either', async () => {
    captureWarnings();
    const CODEX = accountProfile('codex-default', { provider: 'codex' });
    const { accounts, calls: acctCalls } = fakeAccountDeps([CODEX]);
    const { deps } = chatDeps(undefined);
    const withAccounts: AccountCommandDeps = { ...deps, accounts };

    const harness = withRegisteredCommands(withAccounts);
    await harness.run(COMMANDS.setDefaultAccount, CODEX.id);

    expect(acctCalls.defaultRoutingSet).toEqual([]);
  });

  it('a pin left on such an account resumes with no environment, not with CODEX_HOME', async () => {
    const PARENT = uuid(1);
    const CODEX = accountProfile('codex-default', {
      provider: 'codex',
      configDir: '/codex/home',
    });
    const { accounts, calls: acctCalls } = fakeAccountDeps([CODEX], {
      sessionProfileId: () => CODEX.id,
    });
    const { deps, calls } = chatDeps(undefined, {
      hasTranscript: () => true,
      beginInlineRename: () => true,
    });
    const withAccounts: AccountCommandDeps = {
      ...deps,
      getForest: () => forestOf([node(PARENT, { cwd: '/code/api' })]),
      launchSession: async (opts) => {
        calls.launches.push(opts);
        return {
          nodeId: opts.sessionId,
          sessionId: opts.sessionId,
          terminalName: 'claude',
          createdAt: 0,
        };
      },
      accounts,
    };

    const harness = withRegisteredCommands(withAccounts);
    await harness.run(COMMANDS.forkSession, PARENT);

    expect(calls.launches).toHaveLength(1);
    expect(calls.launches[0].env).toBeUndefined();
    expect(calls.launches[0].profileId).toBeUndefined();
    expect(acctCalls.pinned).toEqual([]);
  });
});

describe('removeAccount removes only the list entry, never the config directory', () => {
  afterEach(() => {
    delete (mockCommands as { registerCommand?: unknown }).registerCommand;
    delete (mockWindow as { showWarningMessage?: unknown }).showWarningMessage;
  });

  function confirmRemoval(): void {
    (
      mockWindow as { showWarningMessage?: (...args: unknown[]) => Promise<unknown> }
    ).showWarningMessage = async () => 'Remove Account';
  }

  it('calls deleteAccount (the list-only removal) and never touches the filesystem', async () => {
    confirmRemoval();
    const WORK = accountProfile('work', { configDir: '/work/.claude' });
    const { accounts, calls: acctCalls } = fakeAccountDeps([WORK], {
      defaultRouting: () => undefined,
    });
    const { deps } = chatDeps(undefined);
    const withAccounts: AccountCommandDeps = { ...deps, accounts };

    const harness = withRegisteredCommands(withAccounts);
    await harness.run(COMMANDS.removeAccount, WORK.id);

    expect(acctCalls.deleted).toEqual([WORK.id]);
    // AccountDeps has no directory-delete operation at all — createProfileDir
    // is the only filesystem-touching member the interface exposes, and
    // removal must never reach for it.
    expect(acctCalls.createdDirs).toEqual([]);
    expect(acctCalls.refreshed).toBeGreaterThan(0);
  });

  it('clears a default routing that named the removed account', async () => {
    confirmRemoval();
    const WORK = accountProfile('work');
    const { accounts, calls: acctCalls } = fakeAccountDeps([WORK], {
      defaultRouting: () => ({ kind: 'account', id: WORK.id }),
    });
    const { deps } = chatDeps(undefined);
    const withAccounts: AccountCommandDeps = { ...deps, accounts };

    const harness = withRegisteredCommands(withAccounts);
    await harness.run(COMMANDS.removeAccount, WORK.id);

    expect(acctCalls.defaultRoutingSet).toEqual([null]);
  });

  it('leaves an unrelated default routing alone', async () => {
    confirmRemoval();
    const WORK = accountProfile('work');
    const OTHER = accountProfile('other');
    const { accounts, calls: acctCalls } = fakeAccountDeps([WORK, OTHER], {
      defaultRouting: () => ({ kind: 'account', id: OTHER.id }),
    });
    const { deps } = chatDeps(undefined);
    const withAccounts: AccountCommandDeps = { ...deps, accounts };

    const harness = withRegisteredCommands(withAccounts);
    await harness.run(COMMANDS.removeAccount, WORK.id);

    expect(acctCalls.defaultRoutingSet).toEqual([]);
  });

  it('does nothing when the user declines the confirmation', async () => {
    (
      mockWindow as { showWarningMessage?: (...args: unknown[]) => Promise<unknown> }
    ).showWarningMessage = async () => undefined;
    const WORK = accountProfile('work');
    const { accounts, calls: acctCalls } = fakeAccountDeps([WORK]);
    const { deps } = chatDeps(undefined);
    const withAccounts: AccountCommandDeps = { ...deps, accounts };

    const harness = withRegisteredCommands(withAccounts);
    await harness.run(COMMANDS.removeAccount, WORK.id);

    expect(acctCalls.deleted).toEqual([]);
  });
});

// --------------------------------------------------- adopting a native /fork
//
// `/fork` ≡ Fork Session. A native /fork dispatches a BACKGROUND JOB — a live
// process holding the child id, parked on "send a prompt to start", whose pty
// is a daemon socket no editor can attach to. Adoption stops the job and
// relaunches the SAME id here as an ordinary fork tab.

describe('adoptBackgroundJob', () => {
  const CHILD = uuid(3);
  const PARENT = uuid(4);

  function job(over: Partial<BackgroundJob> = {}): BackgroundJob {
    return {
      sessionId: CHILD,
      parentId: PARENT,
      name: 'copied from the parent',
      cwd: '/Users/a/code/magma',
      configDir: '/Users/a/.lineage/profiles/magma',
      short: '5d0a7866',
      attached: false,
      live: true,
      ...over,
    };
  }

  /** A window where the parent exists and has a transcript to fork from. */
  function adoptDeps(over: Partial<CommandDeps> = {}): {
    deps: CommandDeps;
    calls: ReturnType<typeof chatDeps>['calls'];
  } {
    const { deps, calls } = chatDeps(undefined);
    return {
      deps: {
        ...deps,
        hasTranscript: (id) => id === PARENT,
        getForest: () =>
          forestOf([
            node(PARENT, { label: 'auth' }),
            node(CHILD, { roster: { sessionId: CHILD, pid: 0 } }),
          ]),
        launchSession: async (opts) => {
          calls.order.push('launchSession');
          calls.launches.push(opts);
          return {
            nodeId: opts.sessionId,
            sessionId: opts.sessionId,
            terminalName: 'claude',
            createdAt: 0,
          };
        },
        ...over,
      },
      calls,
    };
  }

  it('relaunches the SAME id as a fork of its parent, and names it like one', async () => {
    const { deps, calls } = adoptDeps();

    expect(await adoptBackgroundJob(deps, CHILD, job())).toBe(true);

    // The clicked row is the row that opens: same id, forked off the parent.
    expect(calls.launches).toEqual([
      expect.objectContaining({
        sessionId: CHILD,
        parentId: PARENT,
        cwd: '/Users/a/code/magma',
        title: 'auth 2',
      }),
    ]);
    // Named the way forkFlow names a branch — NOT the parent's copied title.
    expect(calls.records).toContainEqual({ id: CHILD, patch: { title: 'auth 2' } });
    // Edge recorded BEFORE the launch, exactly as forkFlow does it.
    expect(calls.order.indexOf('recordLaunch')).toBeLessThan(
      calls.order.indexOf('launchSession'),
    );
    expect(calls.reveals).toContain(CHILD);
  });

  it('keeps a title the user already gave the row', async () => {
    const { deps, calls } = adoptDeps({
      getRecord: (id) =>
        id === CHILD
          ? {
              id: CHILD,
              title: 'the good branch',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            }
          : undefined,
    });

    expect(await adoptBackgroundJob(deps, CHILD, job())).toBe(true);
    expect(calls.launches[0].title).toBe('the good branch');
  });

  it('refuses a job a terminal already drives — never a second writer', async () => {
    const { deps, calls } = adoptDeps();
    expect(await adoptBackgroundJob(deps, CHILD, job({ attached: true }))).toBe(
      false,
    );
    expect(calls.launches).toEqual([]);
    expect(calls.order).toEqual([]);
  });

  it('refuses a FINISHED job — a stale roster row must not resurrect it', async () => {
    const { deps, calls } = adoptDeps();
    expect(await adoptBackgroundJob(deps, CHILD, job({ live: false }))).toBe(
      false,
    );
    expect(calls.launches).toEqual([]);
    expect(calls.order).toEqual([]);
  });

  it('refuses a background job that is not a fork, and a self-parented one', async () => {
    const { deps, calls } = adoptDeps();
    const noParent = job();
    delete noParent.parentId;
    expect(await adoptBackgroundJob(deps, CHILD, noParent)).toBe(false);
    expect(
      await adoptBackgroundJob(deps, CHILD, job({ parentId: CHILD })),
    ).toBe(false);
    expect(calls.launches).toEqual([]);
  });

  it('refuses when the parent has no transcript to fork from', async () => {
    const { deps, calls } = adoptDeps({ hasTranscript: () => false });
    expect(await adoptBackgroundJob(deps, CHILD, job())).toBe(false);
    expect(calls.launches).toEqual([]);
  });

  it('reports failure when the relaunch itself fails', async () => {
    const { deps, calls } = adoptDeps({ launchSession: async () => null });
    expect(await adoptBackgroundJob(deps, CHILD, job())).toBe(false);
    // The edge was still recorded — a crash mid-adopt must not lose lineage.
    expect(calls.order).toContain('recordLaunch');
  });
});

// ------------------------------------------------------------- moveProject
//
// The picker is the whole verb: what it OFFERS is the feature (a list you can
// trust has no illegal move in it), and what it does with the answer is one
// call. Both halves are scripted here the same way every other QuickPick flow
// in this file is.

// ------------------------------------------- verbs on a session we do not own
//
// The roster is machine-wide, so most rows in a busy tree belong to a process
// this window never started. Close used to act and then apologise: dispose
// nothing, write `closed: <iso>` onto the record, and warn in a toast that the
// session was still running. The record was the only thing that changed, and it
// was the one thing that was wrong — `buildForest` treats the roster as the
// liveness truth, so the row carried on rendering as live while its record
// claimed otherwise.
//
// These assert the refusal happens BEFORE the write, and that it applies only
// to a POSITIVELY foreign session — every other host keeps the behaviour it had.

describe('close refuses a session running outside Flock', () => {
  afterEach(() => {
    delete (mockCommands as { registerCommand?: unknown }).registerCommand;
    delete (mockWindow as { showWarningMessage?: unknown }).showWarningMessage;
    delete (mockWindow as { setStatusBarMessage?: unknown }).setStatusBarMessage;
  });

  const SESSION = uuid(1);

  interface CloseHarness {
    patches: Array<{ id: string; patch: Partial<EditorialRecord> }>;
    closed: string[];
    warnings: string[];
    run: (command: string, arg: string) => Promise<void>;
  }

  function closeHarness(
    host: 'here' | 'flock' | 'foreign' | 'none' | undefined,
    answer?: string,
  ): CloseHarness {
    const patches: Array<{ id: string; patch: Partial<EditorialRecord> }> = [];
    const closed: string[] = [];
    const warnings: string[] = [];
    (
      mockWindow as {
        showWarningMessage?: (m: unknown, ...rest: unknown[]) => Promise<unknown>;
      }
    ).showWarningMessage = async (message) => {
      warnings.push(String(message));
      return answer;
    };
    // The close verb ends with a status-bar line, and the mock ships no window
    // members at all — without this the handler throws and the "wrote nothing"
    // assertions below would pass for the wrong reason.
    (
      mockWindow as { setStatusBarMessage?: (m: string, ms?: number) => void }
    ).setStatusBarMessage = () => {};

    const { deps } = chatDeps(undefined);
    const withHost: AccountCommandDeps = {
      ...deps,
      getForest: () =>
        forestOf([node(SESSION, { roster: { sessionId: SESSION, pid: 4242 } })]),
      upsertRecord: async (id, patch) => {
        patches.push({ id, patch });
      },
      closeTerminal: (id) => {
        closed.push(id);
        return true;
      },
      ...(host === undefined ? {} : { hostOf: () => host }),
    };
    const harness = withRegisteredCommands(withHost);
    return {
      patches,
      closed,
      warnings,
      run: (command, arg) => harness.run(command, arg),
    };
  }

  it('writes nothing, disposes nothing, and names the host', async () => {
    const h = closeHarness('foreign');
    await h.run(COMMANDS.closeSession, SESSION);
    expect(h.patches).toEqual([]);
    expect(h.closed).toEqual([]);
    expect(h.warnings[0]).toContain('outside Flock');
    // The pid is what turns "somewhere else" into something the user can go and
    // find.
    expect(h.warnings[0]).toContain('pid 4242');
  });

  it('refuses close WITH SUMMARY on the same terms', async () => {
    // The summary box IS that verb's confirmation, so without this gate the
    // user types a summary of work they have not stopped and it lands on a
    // record whose session is still running.
    const h = closeHarness('foreign');
    await h.run(COMMANDS.closeWithSummary, SESSION);
    expect(h.patches).toEqual([]);
    expect(h.closed).toEqual([]);
    expect(h.warnings[0]).toContain('outside Flock');
  });

  it('hands off to the fork, which is the one honest open such a session has', async () => {
    const h = closeHarness('foreign', 'Fork Here');
    await h.run(COMMANDS.closeSession, SESSION);
    // forkFlow refuses on its own in this harness (no transcript). The point is
    // that the refusal handed OFF instead of dead-ending, and still wrote
    // nothing onto the session it was asked to close.
    expect(h.patches).toEqual([]);
  });

  it('closes normally for every host that is not foreign', async () => {
    for (const host of ['here', 'flock', 'none', undefined] as const) {
      const h = closeHarness(host);
      await h.run(COMMANDS.closeSession, SESSION);
      expect(h.closed).toEqual([SESSION]);
      expect(h.patches.map((p) => p.id)).toEqual([SESSION]);
      expect(h.patches[0]?.patch.closed).toBeTruthy();
    }
  });
});

// --------------------------------------------------- lineage.launch.mode
//
// The verb layer's whole part in delegation: decide the launch is not ours to
// make. Which extension, whether it is installed and adopting the session id
// that turns up afterwards all live in the wiring — see
// hosts.resolveLaunchMode (unit-tested in test/hosts.test.ts) and
// extension.settleDelegatedClaim.
//
// What matters here is the fallback: a `+` must never open nothing.

describe('a new session can be handed to another extension', () => {
  afterEach(() => {
    delete (mockCommands as { registerCommand?: unknown }).registerCommand;
    delete (mockWindow as { setStatusBarMessage?: unknown }).setStatusBarMessage;
  });

  // Driven through the PROJECT `+` rather than the folder one: that handler
  // takes its directory from the project record, so the flow needs no folder
  // picker and therefore no `vscode.workspace` the mock does not ship.
  const PROJECT: ProjectRecord = {
    id: 'api',
    name: 'Storefront',
    rootDir: '/code/api',
    dirs: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  interface DelegateHarness {
    launches: LaunchOptions[];
    asked: Array<{ cwd?: string; title?: string }>;
    said: string[];
    run: (command: string, arg?: unknown) => Promise<void>;
  }

  function delegateHarness(
    delegate: null | { label: string } | 'throws' | 'unwired',
  ): DelegateHarness {
    const launches: LaunchOptions[] = [];
    const asked: Array<{ cwd?: string; title?: string }> = [];
    const said: string[] = [];
    (
      mockWindow as { setStatusBarMessage?: (m: string, ms?: number) => void }
    ).setStatusBarMessage = (m) => {
      said.push(m);
    };

    const { deps } = chatDeps(PROJECT, { beginInlineRename: () => true });
    const harness = withRegisteredCommands({
      ...deps,
      getForest: () => forestOf([]),
      launchSession: async (opts) => {
        launches.push(opts);
        return {
          nodeId: opts.sessionId,
          sessionId: opts.sessionId,
          terminalName: 'claude',
          createdAt: 0,
        };
      },
      ...(delegate === 'unwired'
        ? {}
        : {
            delegateLaunch: async (opts: { cwd?: string; title?: string }) => {
              asked.push(opts);
              if (delegate === 'throws') throw new Error('command not found');
              return delegate;
            },
          }),
    });
    return {
      launches,
      asked,
      said,
      run: (command, arg) => harness.run(command, arg),
    };
  }

  it('opens no terminal of its own when the delegate took the launch', async () => {
    const h = delegateHarness({ label: 'Claude Code extension' });
    await h.run(COMMANDS.newSessionInProject, { type: 'project', projectId: 'api' });
    expect(h.asked).toHaveLength(1);
    expect(h.launches).toEqual([]);
    // No row exists yet — and may never — so the status line is what says the
    // click landed.
    expect(h.said[0]).toContain('Claude Code extension');
  });

  it('carries the folder and the name it would have used', async () => {
    const h = delegateHarness({ label: 'Claude Code extension' });
    await h.run(COMMANDS.newSessionInProject, { type: 'project', projectId: 'api' });
    expect(h.asked[0]?.cwd).toBe('/code/api');
    expect(h.asked[0]?.title).toBe('Storefront');
  });

  it('launches here when the mode is flock, or the delegate declines', async () => {
    const h = delegateHarness(null);
    await h.run(COMMANDS.newSessionInProject, { type: 'project', projectId: 'api' });
    expect(h.launches).toHaveLength(1);
    expect(h.said).toEqual([]);
  });

  it('launches here when the delegate THROWS — a + must never open nothing', async () => {
    const h = delegateHarness('throws');
    await h.run(COMMANDS.newSessionInProject, { type: 'project', projectId: 'api' });
    expect(h.launches).toHaveLength(1);
  });

  it('is not consulted at all by a wiring without the setting', async () => {
    const h = delegateHarness('unwired');
    await h.run(COMMANDS.newSessionInProject, { type: 'project', projectId: 'api' });
    expect(h.asked).toEqual([]);
    expect(h.launches).toHaveLength(1);
  });
});

// ------------------------------- clicking a row whose terminal is not ours
//
// `claude` typed into the bottom panel is in the tree like anything else, and
// clicking it used to walk every tier Flock has, find nothing, and offer to fork
// a copy of a conversation sitting three inches below the sidebar. The reveal
// tier goes in front of that dialog and nowhere else: it sits BELOW every tier
// that knows its answer exactly, and above the last resort.

describe('focus reveals a terminal Flock did not create', () => {
  afterEach(() => {
    delete (mockCommands as { registerCommand?: unknown }).registerCommand;
    delete (mockWindow as { showInformationMessage?: unknown })
      .showInformationMessage;
  });

  const SESSION = uuid(3);

  function focusHarness(over: {
    revealHostTerminal?: (id: string) => Promise<boolean>;
    focusSession?: (id: string) => boolean;
  }): {
    told: string[];
    seen: string[];
    run: (command: string, arg: string) => Promise<void>;
  } {
    const told: string[] = [];
    const seen: string[] = [];
    (
      mockWindow as {
        showInformationMessage?: (
          m: unknown,
          ...rest: unknown[]
        ) => Promise<unknown>;
      }
    ).showInformationMessage = async (message) => {
      told.push(String(message));
      return undefined;
    };
    const { deps } = chatDeps(undefined, {
      focusSession: over.focusSession ?? (() => false),
    });
    const harness = withRegisteredCommands({
      ...deps,
      getForest: () =>
        forestOf([
          node(SESSION, {
            status: 'idle',
            roster: { sessionId: SESSION, pid: 4242 },
          }),
        ]),
      markSeen: async (id) => {
        seen.push(id);
      },
      ...(over.revealHostTerminal === undefined
        ? {}
        : { revealHostTerminal: over.revealHostTerminal }),
    });
    return { told, seen, run: (command, arg) => harness.run(command, arg) };
  }

  it('reveals the terminal instead of offering to fork a duplicate', async () => {
    const asked: string[] = [];
    const h = focusHarness({
      revealHostTerminal: async (id) => {
        asked.push(id);
        return true;
      },
    });
    await h.run(COMMANDS.focusSession, SESSION);
    expect(asked).toEqual([SESSION]);
    expect(h.told).toEqual([]); // no dialog at all
  });

  it('falls through to the fork dialog when the match declines', async () => {
    const h = focusHarness({ revealHostTerminal: async () => false });
    await h.run(COMMANDS.focusSession, SESSION);
    expect(h.told[0]).toContain('outside Flock');
    expect(h.told[0]).toContain('pid 4242');
  });

  it('behaves exactly as before on a wiring with no matcher', async () => {
    const h = focusHarness({});
    await h.run(COMMANDS.focusSession, SESSION);
    expect(h.told[0]).toContain('outside Flock');
  });

  it('never asks once a bound terminal here has answered', async () => {
    const asked: string[] = [];
    const h = focusHarness({
      focusSession: () => true,
      revealHostTerminal: async (id) => {
        asked.push(id);
        return true;
      },
    });
    await h.run(COMMANDS.focusSession, SESSION);
    expect(asked).toEqual([]);
    expect(h.told).toEqual([]);
  });
});

// --------------------------------------------- resume: the second-writer guard
//
// Two claude processes on one transcript is the worst thing this file can cause.
// resumeFlow already refuses a session the FOREST calls live; this covers the
// direction the forest gets wrong — a row reads as closed whenever the roster
// does not carry it, which is also what a session running somewhere the roster
// cannot see looks like.

describe('resume asks before starting a second writer', () => {
  afterEach(() => {
    delete (mockWindow as { showWarningMessage?: unknown }).showWarningMessage;
  });

  const SESSION = uuid(4);

  function resumeHarness(
    over: {
      lastActiveAt?: number;
      closed?: string;
      answer?: string;
    } = {},
  ): {
    launches: LaunchOptions[];
    warnings: string[];
    deps: AccountCommandDeps;
  } {
    const launches: LaunchOptions[] = [];
    const warnings: string[] = [];
    (
      mockWindow as {
        showWarningMessage?: (m: unknown, ...rest: unknown[]) => Promise<unknown>;
      }
    ).showWarningMessage = async (message) => {
      warnings.push(String(message));
      return over.answer;
    };
    const records: Record<string, EditorialRecord> = {
      [SESSION]: {
        id: SESSION,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        ...(over.closed === undefined ? {} : { closed: over.closed }),
      },
    };
    const { deps } = chatDeps(undefined, {
      records,
      hasTranscript: () => true,
    });
    return {
      launches,
      warnings,
      deps: {
        ...deps,
        // An ARCHIVED row: the forest's live-session refusal does not apply, so
        // this guard is the only thing between the click and a second process.
        getForest: () =>
          forestOf([
            node(SESSION, { archived: true, status: 'exited', cwd: '/code/api' }),
          ]),
        ...(over.lastActiveAt === undefined
          ? {}
          : { transcriptFacts: () => ({ lastActiveAt: over.lastActiveAt }) }),
        launchSession: async (opts) => {
          launches.push(opts);
          return {
            nodeId: opts.sessionId,
            sessionId: opts.sessionId,
            terminalName: 'claude',
            createdAt: 0,
          };
        },
      },
    };
  }

  it('refuses when the transcript was written after we recorded it closed', async () => {
    const h = resumeHarness({
      lastActiveAt: Date.now() - 5_000,
      closed: '2026-01-01T00:00:00.000Z',
    });
    expect(await resumeFlow(h.deps, SESSION)).toBe(false);
    expect(h.launches).toEqual([]);
    expect(h.warnings[0]).toContain('second Claude');
  });

  it('resumes anyway when the user says so out loud', async () => {
    const h = resumeHarness({
      lastActiveAt: Date.now() - 5_000,
      answer: 'Resume Anyway',
    });
    expect(await resumeFlow(h.deps, SESSION)).toBe(true);
    expect(h.launches).toHaveLength(1);
  });

  it('does NOT ask on the ordinary close-then-reopen', async () => {
    // claude writes a final record or two on its way out, so a freshness test
    // alone would put a modal in front of the commonest resume in the product.
    // The write has to be LATER than the recorded close for the guard to fire.
    const closedAt = new Date().toISOString();
    const h = resumeHarness({
      lastActiveAt: Date.parse(closedAt) - 1_000,
      closed: closedAt,
    });
    expect(await resumeFlow(h.deps, SESSION)).toBe(true);
    expect(h.warnings).toEqual([]);
    expect(h.launches).toHaveLength(1);
  });

  it('does not ask about a transcript nothing has touched in a while', async () => {
    const h = resumeHarness({ lastActiveAt: Date.now() - 10 * 60_000 });
    expect(await resumeFlow(h.deps, SESSION)).toBe(true);
    expect(h.warnings).toEqual([]);
  });

  it('resumes unchanged on a wiring that cannot read a transcript mtime', async () => {
    // The guard needs a reading and must never invent one — every unit double,
    // and any host without the transcript cache, keeps the old behaviour.
    const h = resumeHarness({});
    expect(await resumeFlow(h.deps, SESSION)).toBe(true);
    expect(h.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A row you created and never wrote in. Claude writes its transcript lazily, so
// this session exists everywhere except on disk — and it used to be the one row
// in the tree that could not be opened at all.

describe('a session that never took a turn opens by starting', () => {
  afterEach(() => {
    delete (mockWindow as { showWarningMessage?: unknown }).showWarningMessage;
  });

  const SESSION = uuid(5);
  const PARENT = uuid(6);

  function coldHarness(
    over: {
      /** Ids the wiring can find a transcript for. Empty = nothing on disk. */
      transcripts?: string[];
      /** The recorded edge, as `recordLaunch` would have written it. */
      parentId?: string;
      node?: Partial<SessionNode>;
    } = {},
  ): {
    launches: LaunchOptions[];
    warnings: string[];
    calls: ChatCalls;
    deps: AccountCommandDeps;
  } {
    const launches: LaunchOptions[] = [];
    const warnings: string[] = [];
    (
      mockWindow as {
        showWarningMessage?: (m: unknown, ...rest: unknown[]) => Promise<unknown>;
      }
    ).showWarningMessage = async (message) => {
      warnings.push(String(message));
      return undefined;
    };
    const transcripts = new Set(over.transcripts ?? []);
    const records: Record<string, EditorialRecord> = {
      [SESSION]: {
        id: SESSION,
        title: 'shipping',
        cwd: '/code/api',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        ...(over.parentId === undefined ? {} : { parentId: over.parentId }),
      },
      [PARENT]: {
        id: PARENT,
        cwd: '/code/api',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    };
    const { deps, calls } = chatDeps(undefined, {
      records,
      hasTranscript: (id) => transcripts.has(id),
    });
    return {
      launches,
      warnings,
      calls,
      deps: {
        ...deps,
        // Closed, which is what a row whose tab was shut looks like — the live
        // refusal above does not apply and the flow reaches the cold path.
        getForest: () =>
          forestOf([
            node(SESSION, {
              archived: true,
              status: 'exited',
              cwd: '/code/api',
              ...over.node,
            }),
            node(PARENT, { archived: true, status: 'exited', cwd: '/code/api' }),
          ]),
        launchSession: async (opts) => {
          launches.push(opts);
          return {
            nodeId: opts.sessionId,
            sessionId: opts.sessionId,
            terminalName: 'claude',
            createdAt: 0,
          };
        },
      },
    };
  }

  it('starts a fresh conversation under the row’s own id', async () => {
    const h = coldHarness();
    expect(await resumeFlow(h.deps, SESSION)).toBe(true);
    expect(h.warnings).toEqual([]);
    expect(h.launches).toHaveLength(1);
    const [launch] = h.launches;
    expect(launch.sessionId).toBe(SESSION);
    // Neither: `--session-id <id>` and nothing else. A resumeId would name a
    // transcript that is not there, and a parentId would fork from nowhere.
    expect(launch.resumeId).toBeUndefined();
    expect(launch.parentId).toBeUndefined();
    // Same directory and same name — this is the row reopening, not a new one.
    expect(launch.cwd).toBe('/code/api');
    expect(launch.title).toBe('shipping');
  });

  it('un-closes and un-parks the row it just started', async () => {
    const h = coldHarness();
    await resumeFlow(h.deps, SESSION);
    // The same bookkeeping a resume does: a row with a tab must not read as
    // closed, and must not be resumed a second time by the next switch.
    const patch = h.calls.records.find((r) => r.id === SESSION)?.patch;
    expect(patch).toMatchObject({ closed: null, parked: false, tmux: null });
  });

  it('replays the ancestor when the unstarted row is a FORK', async () => {
    // What it was showing on screen before the tab closed is its parent's
    // history, so it comes back as the fork it was — not as a blank session
    // that happens to sit under the same parent.
    const h = coldHarness({ parentId: PARENT, transcripts: [PARENT] });
    expect(await resumeFlow(h.deps, SESSION)).toBe(true);
    expect(h.launches).toHaveLength(1);
    const [launch] = h.launches;
    expect(launch.sessionId).toBe(SESSION);
    expect(launch.parentId).toBe(PARENT);
    expect(launch.resumeId).toBeUndefined();
  });

  it('starts fresh when the recorded ancestor has no transcript either', async () => {
    // A fork of a fork, neither ever messaged: the walk finds nothing to
    // replay and the row still has to open.
    const h = coldHarness({ parentId: PARENT });
    expect(await resumeFlow(h.deps, SESSION)).toBe(true);
    const [launch] = h.launches;
    expect(launch.parentId).toBeUndefined();
    expect(launch.resumeId).toBeUndefined();
  });

  it('still resumes normally once there IS a transcript', async () => {
    const h = coldHarness({ transcripts: [SESSION] });
    expect(await resumeFlow(h.deps, SESSION)).toBe(true);
    const [launch] = h.launches;
    expect(launch.resumeId).toBe(SESSION);
    expect(launch.parentId).toBeUndefined();
  });

  it('refuses a GHOST, which is inferred rather than created', async () => {
    // A ghost id was never a row anything here minted — starting a
    // conversation under it would invent the history the tree is guessing at.
    const h = coldHarness({ node: { ghost: true } });
    expect(await resumeFlow(h.deps, SESSION)).toBe(false);
    expect(h.launches).toEqual([]);
    expect(h.warnings[0]).toContain('No transcript on disk');
  });
});

describe('wrap names the host when there is no terminal to type into', () => {
  afterEach(() => {
    delete (mockCommands as { registerCommand?: unknown }).registerCommand;
    delete (mockWindow as { showWarningMessage?: unknown }).showWarningMessage;
  });

  const SESSION = uuid(2);

  function wrapHarness(host: 'foreign' | 'flock'): {
    warnings: string[];
    run: (command: string, arg: string) => Promise<void>;
  } {
    const warnings: string[] = [];
    (
      mockWindow as { showWarningMessage?: (m: unknown) => Promise<unknown> }
    ).showWarningMessage = async (message) => {
      warnings.push(String(message));
      return undefined;
    };
    const { deps } = chatDeps(undefined);
    const harness = withRegisteredCommands({
      ...deps,
      getForest: () => forestOf([node(SESSION)]),
      sendTextToSession: () => false,
      hostOf: () => host,
    });
    return { warnings, run: (command, arg) => harness.run(command, arg) };
  }

  it('explains WHY there is no terminal, for a foreign session', async () => {
    const h = wrapHarness('foreign');
    await h.run(COMMANDS.wrapSession, SESSION);
    expect(h.warnings[0]).toContain('outside Flock');
  });

  it('keeps the plain message for a session of ours in another window', async () => {
    const h = wrapHarness('flock');
    await h.run(COMMANDS.wrapSession, SESSION);
    expect(h.warnings[0]).toContain('this window');
  });
});
