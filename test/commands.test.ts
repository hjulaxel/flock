// SPEC.md §9 — test/commands.test.ts (nominally owner E; written by the
// INTEGRATOR because owner E was scoped to src/commands.ts only).
//
// Pure surface, plus the two exported flows: registerCommands() talks to the
// real workbench and is never exercised. `chatFlow` needs no workbench at all;
// `configureProjectFlow` opens a QuickPick, so the two host entry points it
// calls are scripted onto the mock's (deliberately empty) `window`/`commands`
// for the length of a test and removed again — see that describe block.

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
  moveProjectFlow,
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

// M22 — the three shapes a multi-row verb is invoked with. This is the whole of
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

  // REGRESSION (M5 / plan §4). The age came off `startedAt` for anything not
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

// ------------------------------------------------------------- M8: naming
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

// ------------------------------------------------------------- chat (M16)

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
  /** M26. Every setProjectParent this double was asked for. */
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
    /** M24. The store the chat history and the chat ordinal read. */
    records?: Record<string, EditorialRecord>;
    /** M26. Whether the store accepts a re-file (it refuses cycles). */
    setProjectParent?: (id: string, parentId: string | null) => boolean;
    /** M26. Every project the flows can see, not just the one under test. */
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
    // beginInlineRename is untouched by any existing test — default stays the
    // same hardcoded `false` it always was; M22's own tests opt into `true`
    // so a just-created row's fallback (`vscode.commands.executeCommand`)
    // never has to be scripted onto the mock's empty `commands`.
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
 *  that project's chat, since M24 derives the membership from the cwd. */
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

    // M24: the project record is not touched at all. `chatSessionId` was the
    // one-chat-per-project pointer and there is no longer one chat to point at.
    expect(calls.projectPatches).toEqual([]);
  });

  it('never mints tree membership via recordLaunch', async () => {
    const { deps, calls } = chatDeps(projectOf());
    await chatFlow(deps, 'p1');
    expect(calls.order).not.toContain('recordLaunch');
  });

  // M24 — THE change. Every one of these used to be a resume.

  it('mints a NEW chat even when one is already open in this window', async () => {
    const { deps, calls } = chatDeps(projectOf(), {
      records: { [VALID]: chatRecord(VALID) },
      // Would have been focused instead of launched, pre-M24.
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

// ------------------------------------------------ M24: the chat history

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

// -------------------------------------------- M24: close / open a project

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

// ------------------------------------------- M17: Configure Project → Rename…

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
/** M24. The status-bar breadcrumb Close Project leaves behind. */
type StatusHost = {
  setStatusBarMessage?: (text: string, ms?: number) => void;
};
/** M24. The modal behind Close Project. */
type WarningHost = {
  showWarningMessage?: (
    message: string,
    opts?: unknown,
    ...items: string[]
  ) => Promise<string | undefined>;
};

describe('configureProjectFlow: the Rename… branch', () => {
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
  } {
    const state = { opened: 0, ran: [] as Array<[string, unknown]> };
    (mockWindow as QuickPickHost).showQuickPick = async () => {
      state.opened += 1;
      return answers.shift();
    };
    (mockCommands as CommandHost).executeCommand = async (id, arg) => {
      state.ran.push([id, arg]);
      return undefined;
    };
    return state;
  }

  // REGRESSION (M3). The rename branch used to fire the verb and `continue`,
  // and the verb resolves as soon as the `beginRename` message is DELIVERED —
  // not when the user finishes typing. So the QuickPick reopened in the same
  // tick, took the keyboard back, blurred the input, and the client's
  // commit-on-blur posted the UNCHANGED name: the rename visibly did nothing.
  it('hands over to the inline editor and does not reopen the menu', async () => {
    const state = scriptMenu([{ action: 'rename' }]);
    const { deps, calls } = chatDeps(projectOf(), {
      beginInlineRenameProject: () => true,
    });

    await configureProjectFlow(deps, 'p1');

    expect(calls.inlineRenameProjects).toEqual(['p1']);
    expect(state.opened).toBe(1);
    // Nothing may run on top of an open editor — least of all the quick-input
    // rename, which would ask for the same name in a second place.
    expect(state.ran).toEqual([]);
  });

  it('still reopens the menu behind the quick-input fallback', async () => {
    // The fallback is finished by the time it resolves, so the loop can come
    // back with the project re-read — the native view style has no editable
    // row and this is the only rename it will ever get.
    const state = scriptMenu([{ action: 'rename' }, undefined]);
    const { deps, calls } = chatDeps(projectOf(), {
      beginInlineRenameProject: () => false,
    });

    await configureProjectFlow(deps, 'p1');

    expect(calls.inlineRenameProjects).toEqual(['p1']);
    expect(state.ran).toEqual([
      [COMMANDS.renameProject, { type: 'project', projectId: 'p1' }],
    ]);
    expect(state.opened).toBe(2);
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

  it('detachedTmuxName reads the name off the id or its chain tip', () => {
    const { deps } = chatDeps(undefined);
    const tip = uuid(9);
    const viaTip: CommandDeps = {
      ...deps,
      tipOf: () => tip,
      getRecord: (id) => (id === tip ? rec({ id: tip, tmux: TMUX }) : undefined),
    };
    expect(detachedTmuxName(viaTip, VALID)).toBe(TMUX);
    // A kill park writes `tmux: null` — that is NOT a detached session.
    const killed: CommandDeps = {
      ...deps,
      getRecord: () => rec({ tmux: null, parked: true }),
    };
    expect(detachedTmuxName(killed, VALID)).toBeUndefined();
    expect(detachedTmuxName(deps, VALID)).toBeUndefined();
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

// ---------------------------------------------------------------- M22: accounts
//
// `forkFlow`/`newSessionFlow`/`newSessionInProjectFlow` went module-private in
// M22 (only reachable through their registered commands — see the note beside
// `AccountCommandDeps` in src/commands.ts) precisely so nothing outside
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
 * `registerCommands()` is documented (top of this file) as never exercised —
 * true until M22 pushed the launch flows behind it. Scripting
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

describe('M22: fork inherits the PARENT pin, never the routing choice of the day', () => {
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

  it('with no pin recorded (a pre-M22 conversation), forks with no env at all', async () => {
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

describe('M22: a new session (newSessionInBranch) is routed and its pin recorded', () => {
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

  it('with no accounts wiring at all, launches exactly as before M22 — no env, no pin', async () => {
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
      // deps.accounts intentionally left undefined — the pre-M22 wiring.
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
describe('M22: a session never starts on an account no session can run on', () => {
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

describe('M22: removeAccount removes only the list entry, never the config directory', () => {
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

// ---------------------------------------------------------------------- M25
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

// -------------------------------------------------------- M26: moveProject
//
// The picker is the whole verb: what it OFFERS is the feature (a list you can
// trust has no illegal move in it), and what it does with the answer is one
// call. Both halves are scripted here the same way every other QuickPick flow
// in this file is.

describe('moveProjectFlow', () => {
  type Row = { label: string; action: string; payload?: string };

  afterEach(() => {
    delete (mockWindow as QuickPickHost).showQuickPick;
    delete (mockWindow as QuickPickHost).showInformationMessage;
    delete (mockWindow as WarningHost).showWarningMessage;
  });

  function scriptPicker(pick: (rows: Row[]) => Row | undefined): {
    shown: Row[];
    told: string[];
  } {
    const state = { shown: [] as Row[], told: [] as string[] };
    (mockWindow as QuickPickHost).showQuickPick = async (items) => {
      state.shown = items as Row[];
      return pick(state.shown);
    };
    (mockWindow as QuickPickHost).showInformationMessage = async (message) => {
      state.told.push(message);
      return undefined;
    };
    return state;
  }

  const app = (over: Partial<ProjectRecord> = {}): ProjectRecord =>
    projectOf({ id: 'app', name: 'app', rootDir: '/code/app', dirs: [], ...over });
  const api = (over: Partial<ProjectRecord> = {}): ProjectRecord =>
    projectOf({
      id: 'api',
      name: 'api',
      rootDir: '/code/app/api',
      dirs: [],
      parentId: 'app',
      ...over,
    });
  const solo = (over: Partial<ProjectRecord> = {}): ProjectRecord =>
    projectOf({ id: 'solo', name: 'solo', rootDir: '/code/solo', dirs: [], ...over });

  it('offers Top Level only to a project that is nested', async () => {
    const nested = scriptPicker(() => undefined);
    const { deps } = chatDeps(undefined, { projects: [app(), api()] });
    await moveProjectFlow(deps, 'api');
    expect(nested.shown[0].action).toBe('top');

    const root = scriptPicker(() => undefined);
    await moveProjectFlow(deps, 'app');
    expect(root.shown.some((r) => r.action === 'top')).toBe(false);
  });

  it('leaves its own subtree out of the list', async () => {
    const state = scriptPicker(() => undefined);
    const { deps } = chatDeps(undefined, { projects: [app(), api(), solo()] });
    await moveProjectFlow(deps, 'app');
    // Not itself, not its child; the unrelated project is the only candidate.
    expect(state.shown.map((r) => r.payload)).toEqual(['solo']);
  });

  it('leaves out the parent it is already filed under', async () => {
    const state = scriptPicker(() => undefined);
    const { deps } = chatDeps(undefined, { projects: [app(), api(), solo()] });
    await moveProjectFlow(deps, 'api');
    expect(state.shown.filter((r) => r.action === 'project').map((r) => r.payload)).toEqual([
      'solo',
    ]);
  });

  it('files the project under the chosen parent', async () => {
    scriptPicker((rows) => rows.find((r) => r.payload === 'app'));
    const { deps, calls } = chatDeps(undefined, { projects: [app(), solo()] });
    expect(await moveProjectFlow(deps, 'solo')).toBe(true);
    expect(calls.projectMoves).toEqual([['solo', 'app']]);
    expect(calls.reveals).toContain('solo');
  });

  it('sends a nested project back to the top level', async () => {
    scriptPicker((rows) => rows.find((r) => r.action === 'top'));
    const { deps, calls } = chatDeps(undefined, { projects: [app(), api()] });
    expect(await moveProjectFlow(deps, 'api')).toBe(true);
    expect(calls.projectMoves).toEqual([['api', null]]);
  });

  it('writes nothing when the picker is dismissed', async () => {
    scriptPicker(() => undefined);
    const { deps, calls } = chatDeps(undefined, { projects: [app(), solo()] });
    expect(await moveProjectFlow(deps, 'solo')).toBe(false);
    expect(calls.projectMoves).toEqual([]);
  });

  it('says so when there is nowhere to move to', async () => {
    const state = scriptPicker(() => undefined);
    const { deps, calls } = chatDeps(undefined, { projects: [app(), api()] });
    // `app` has one candidate (its own child) and it is refused, so the list
    // is empty and the verb has to say why rather than open nothing.
    await moveProjectFlow(deps, 'app');
    expect(state.told[0]).toContain('nowhere to move');
    expect(calls.projectMoves).toEqual([]);
  });

  it('reports a store refusal instead of pretending it moved', async () => {
    scriptPicker((rows) => rows.find((r) => r.payload === 'app'));
    const warned: string[] = [];
    (mockWindow as WarningHost).showWarningMessage = async (message) => {
      warned.push(message);
      return undefined;
    };
    const { deps } = chatDeps(undefined, {
      projects: [app(), solo()],
      setProjectParent: () => false,
    });
    expect(await moveProjectFlow(deps, 'solo')).toBe(false);
    expect(warned[0]).toContain('could not move');
  });
});
