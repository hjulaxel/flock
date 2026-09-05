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
  addSessionToProjectFlow,
  adoptBackgroundJob,
  chatFlow,
  importSessionsFlow,
  recommendedSetupFlow,
  chatSystemPrompt,
  configureProjectFlow,
  defaultForkTitle,
  defaultSessionTitle,
  forkForAgent,
  forkStemFor,
  detachedTmuxName,
  nextFreeName,
  projectIdFromArg,
  registerCommands,
  archivedSessionsFlow,
  chatHistoryFlow,
  closeProjectFlow,
  reopenProject,
  resumeFlow,
  partitionForClose,
  partitionForOpen,
  selectedSessionIds,
  skippedForOpenSentence,
  sessionIdFromArg,
  sessionWorkspaceTarget,
  staleCandidates,
  stripForkCounter,
  tabTitleFrom,
} from '../src/commands';
import type { AccountCommandDeps } from '../src/commands';
import type { AccountDeps, SwitchAccountResult } from '../src/accountsView';
import { isWithin, validateProjectName } from '../src/projects';
import {
  COMMANDS,
  MAX_PROJECT_NAME_LEN,
  SESSION_ID_RE,
  WRAP_PROMPT,
  isSessionId,
} from '../src/types';
import {
  commands as mockCommands,
  env as mockEnv,
  window as mockWindow,
} from './mocks/vscode';
import * as vscodeMock from './mocks/vscode';
import type { CloseSummaryMode } from '../src/types';
import type {
  AccountProfile,
  BackgroundJob,
  CommandDeps,
  EditorialRecord,
  LaunchOptions,
  ProjectRecord,
  RecommendedWorld,
  RoutingChoice,
  SessionForest,
  SessionNode,
  SubprojectRecord,
  UnlistedSession,
  Worktree,
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

// A terminal tab is named from the ROW's name — including on the resume path,
// which is exactly how a closed row becomes a tab. Two shapes the row builds
// for an unnamed session are refused here, because the CLI's own
// `claude · 1a2b3c4d` default is a better tab title than either.
describe('tabTitleFrom', () => {
  const ID = '1a2b3c4d-0000-4000-8000-00000000000a';

  it('takes a real name', () => {
    expect(tabTitleFrom(ID, 'api refactor', undefined)).toBe('api refactor');
  });

  it('refuses the short-id shapes the forest builds for an unnamed session', () => {
    expect(tabTitleFrom(ID, '1a2b3c4d', undefined)).toBeUndefined();
    expect(tabTitleFrom(ID, '1a2b3c4d (gone)', undefined)).toBeUndefined();
  });

  // The third shape: the QUOTATION an archived row falls back to when the
  // transcript offers no title. The caller strips it (keyed on
  // SessionNode.labelIsFallback, never on a leading quote character — a user is
  // allowed to name a session with one), which reaches this function as an
  // absent label.
  it('falls through to the record title when the label was withheld', () => {
    expect(tabTitleFrom(ID, undefined, 'editorial title')).toBe(
      'editorial title',
    );
    expect(tabTitleFrom(ID, undefined, undefined)).toBeUndefined();
    // ...and a quotation handed in verbatim is NOT sniffed for here: that is
    // the caller's job, and this function must keep honouring a name someone
    // really did type in quotes.
    expect(tabTitleFrom(ID, '“cd ..”', undefined)).toBe('“cd ..”');
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

// Opening several closed sessions at once: which of the selected rows the verb
// can actually open, and what it says about the ones it cannot.
describe('partitionForOpen (the multi-open decision)', () => {
  const A = uuid(1);
  const B = uuid(2);
  const C = uuid(3);
  const D = uuid(4);

  /** A forest reader over a fixed list, plus "nothing is open in this window"
   *  unless `openHere` names it. */
  const from = (
    nodes: SessionNode[],
    openHere: readonly string[] = [],
  ): {
    nodeOf: (id: string) => SessionNode | undefined;
    focusHere: (id: string) => boolean;
  } => ({
    nodeOf: (id) => nodes.find((n) => n.id === id),
    focusHere: (id) => openHere.includes(id),
  });

  it('opens the closed ones and keeps the order they were given in', () => {
    // The tabs must arrive in the order the rows were selected: a person who
    // shift-clicked top to bottom will notice if they do not.
    const { nodeOf, focusHere } = from([
      node(A, { archived: true }),
      node(B, { status: 'exited' }),
      node(C, { archived: true }),
    ]);
    expect(partitionForOpen([C, A, B], nodeOf, focusHere).targets).toEqual([
      C,
      A,
      B,
    ]);
  });

  it('refuses a session that is still running', () => {
    // Resuming it would put a SECOND claude on a transcript the first is
    // appending to — the worst thing commands.ts can do.
    const { nodeOf, focusHere } = from([
      node(A, { status: 'busy' }),
      node(B, { archived: true }),
    ]);
    const out = partitionForOpen([A, B], nodeOf, focusHere);
    expect(out.targets).toEqual([B]);
    expect(out.live).toEqual([A]);
  });

  it('reveals a running session this window already has, rather than refusing it', () => {
    // "Open it" for a row already open means "show it to me", and that is free
    // — so it is neither a target nor a refusal.
    const shown: string[] = [];
    const nodes = [node(A, { status: 'busy' }), node(B, { archived: true })];
    const out = partitionForOpen(
      [A, B],
      (id) => nodes.find((n) => n.id === id),
      (id) => {
        shown.push(id);
        return id === A;
      },
    );
    expect(out.targets).toEqual([B]);
    expect(out.live).toEqual([]);
    expect(shown).toEqual([A]);
  });

  it('refuses a ghost — there is no transcript to reopen', () => {
    const { nodeOf, focusHere } = from([
      node(A, { ghost: true }),
      node(B, { archived: true }),
    ]);
    const out = partitionForOpen([A, B], nodeOf, focusHere);
    expect(out.targets).toEqual([B]);
    expect(out.ghosts).toEqual([A]);
  });

  it('treats a row the forest has never heard of as openable', () => {
    // An id with no node is the ordinary shape of a session read off disk,
    // which is exactly what this verb is for.
    const { nodeOf, focusHere } = from([]);
    expect(partitionForOpen([A], nodeOf, focusHere).targets).toEqual([A]);
  });

  it('never names the same session twice', () => {
    const { nodeOf, focusHere } = from([node(A, { archived: true })]);
    expect(partitionForOpen([A, A], nodeOf, focusHere).targets).toEqual([A]);
  });

  it('survives a forest or a focus probe that throws', () => {
    const nodes = [node(A, { status: 'busy' })];
    expect(
      partitionForOpen(
        [A],
        () => {
          throw new Error('no forest');
        },
        () => false,
      ).targets,
    ).toEqual([A]);
    // A focus that throws is "not shown", so the row is a refusal, not a
    // silent drop.
    const out = partitionForOpen(
      [A],
      (id) => nodes.find((n) => n.id === id),
      () => {
        throw new Error('no window');
      },
    );
    expect(out.live).toEqual([A]);
  });

  it('sorts a mixed selection into all three piles at once', () => {
    const { nodeOf, focusHere } = from([
      node(A, { archived: true }),
      node(B, { status: 'waiting' }),
      node(C, { ghost: true }),
      node(D, { status: 'exited' }),
    ]);
    const out = partitionForOpen([A, B, C, D], nodeOf, focusHere);
    expect(out.targets).toEqual([A, D]);
    expect(out.live).toEqual([B]);
    expect(out.ghosts).toEqual([C]);
  });
});

// Closing several selected sessions at once: which rows the verb can reach.
describe('partitionForClose (the multi-close decision)', () => {
  const A = uuid(1);
  const B = uuid(2);
  const C = uuid(3);

  const from = (
    nodes: SessionNode[],
    reachable: readonly string[],
  ): {
    nodeOf: (id: string) => SessionNode | undefined;
    canEnd: (id: string) => boolean;
  } => ({
    nodeOf: (id) => nodes.find((n) => n.id === id),
    canEnd: (id) => reachable.includes(id),
  });

  it('closes the live rows Flock can reach, in the order given', () => {
    const { nodeOf, canEnd } = from(
      [node(A, { status: 'busy' }), node(B, { status: 'waiting' })],
      [A, B],
    );
    expect(partitionForClose([B, A], nodeOf, canEnd).targets).toEqual([B, A]);
  });

  it('sets aside a session running somewhere Flock cannot reach', () => {
    // The singular verb meets this with a whole dialog offering to fork it
    // instead; five of those before the first tab closes is an obstacle, not a
    // report, so the batch counts them.
    const { nodeOf, canEnd } = from(
      [node(A, { status: 'busy' }), node(B, { status: 'busy' })],
      [B],
    );
    const out = partitionForClose([A, B], nodeOf, canEnd);
    expect(out.targets).toEqual([B]);
    expect(out.foreign).toEqual([A]);
  });

  it('counts an already-closed row separately — it is not a refusal', () => {
    for (const over of [
      { archived: true },
      { status: 'exited' as const },
      { ghost: true },
    ]) {
      const { nodeOf, canEnd } = from([node(A, over)], [A]);
      const out = partitionForClose([A], nodeOf, canEnd);
      expect(out.targets).toEqual([]);
      expect(out.over).toEqual([A]);
      expect(out.foreign).toEqual([]);
    }
  });

  it('never names the same session twice', () => {
    const { nodeOf, canEnd } = from([node(A, { status: 'busy' })], [A]);
    expect(partitionForClose([A, A], nodeOf, canEnd).targets).toEqual([A]);
  });

  it('survives a forest or a reachability probe that throws', () => {
    // A probe that throws is "cannot reach", so the row is set aside rather
    // than closed on a guess — the safe direction for a verb that ends
    // processes.
    const out = partitionForClose(
      [A],
      () => {
        throw new Error('no forest');
      },
      () => {
        throw new Error('no registry');
      },
    );
    expect(out.targets).toEqual([]);
    expect(out.foreign).toEqual([A]);
  });

  it('sorts a mixed selection into all three piles at once', () => {
    const { nodeOf, canEnd } = from(
      [
        node(A, { status: 'busy' }),
        node(B, { status: 'busy' }),
        node(C, { archived: true }),
      ],
      [A],
    );
    const out = partitionForClose([A, B, C], nodeOf, canEnd);
    expect(out.targets).toEqual([A]);
    expect(out.foreign).toEqual([B]);
    expect(out.over).toEqual([C]);
  });
});

describe('skippedForOpenSentence', () => {
  it('says nothing when nothing was skipped', () => {
    expect(skippedForOpenSentence(0, 0)).toBe('');
  });

  it('names the two refusals separately — they leave you different work', () => {
    expect(skippedForOpenSentence(1, 0)).toContain('is still running');
    expect(skippedForOpenSentence(3, 0)).toContain('are still running');
    expect(skippedForOpenSentence(0, 1)).toContain('has no transcript');
    expect(skippedForOpenSentence(0, 2)).toContain('have no transcript');
  });

  it('gives up and counts only when the selection mixed both', () => {
    const both = skippedForOpenSentence(2, 3);
    expect(both).toContain('5 of them');
    expect(both).toContain('some are still running');
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
    focusSessionsView: async () => true,
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
    setBranchesShown: async () => undefined,
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
    markSeen: async () => undefined,
    notificationsEnabled: () => true,
    setOnlyActiveSessions: async () => undefined,
    setAccountsSection: async () => undefined,
    setShellsSection: async () => undefined,
    setBranchDisplay: async () => undefined,
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

// ------------------------------------------- chats never take the solo pin

/**
 * `lineage.soloSession` and chats: a chat is a normal tab beside the pinned
 * session, never the solo tab. Opening one must not park the session tabs,
 * and every verb that REOPENS a chat by id (the chat history lands in
 * resumeFlow) must skip the enforcement too — the wrapper refuses chat ids,
 * so the rule holds for the call site nobody remembers to exempt.
 */
describe('solo mode never fires for a chat', () => {
  const CHAT_ID = uuid(41);
  const SESSION_ID = uuid(42);

  function soloHarness(records: Record<string, EditorialRecord>): {
    deps: CommandDeps;
    enforced: string[];
  } {
    const enforced: string[] = [];
    const { deps, calls } = chatDeps(projectOf(), {
      records,
      hasTranscript: () => true,
    });
    const harness: CommandDeps = {
      ...deps,
      // Closed rows, so resumeFlow's "still running — fork instead" guard
      // stays quiet and the flow reaches its launch (and the enforcement).
      getForest: () =>
        forestOf([
          node(CHAT_ID, { archived: true, status: 'exited' }),
          node(SESSION_ID, { archived: true, status: 'exited' }),
        ]),
      launchSession: async (opts) => {
        calls.launches.push(opts);
        return {
          nodeId: opts.sessionId,
          sessionId: opts.sessionId,
          terminalName: 'claude',
          createdAt: 0,
        };
      },
      soloEnforce: async (id) => {
        enforced.push(id);
      },
    };
    return { deps: harness, enforced };
  }

  it('opening a NEW chat parks nothing and pins nothing', async () => {
    const { deps, enforced } = soloHarness({});
    await chatFlow(deps, 'p1');
    expect(enforced).toEqual([]);
  });

  it('REOPENING a chat (resumeFlow, where the history picker lands) skips the enforcement', async () => {
    const { deps, enforced } = soloHarness({
      [CHAT_ID]: chatRecord(CHAT_ID),
    });
    expect(await resumeFlow(deps, CHAT_ID)).toBe(true);
    expect(enforced).toEqual([]);
  });

  it('recognises a chat by any chain member — a reopened generation carries no flag of its own', async () => {
    // The tip GEN is a generation minted by an earlier reopen: no record says
    // `chat` under it, only the birth record — a chain sibling — does.
    const GEN = uuid(43);
    const { deps, enforced } = soloHarness({
      [CHAT_ID]: chatRecord(CHAT_ID),
    });
    const chained: CommandDeps = {
      ...deps,
      getForest: () => forestOf([node(GEN, { archived: true, status: 'exited' })]),
      tipOf: (id) => (id === CHAT_ID || id === GEN ? GEN : id),
    };
    expect(await resumeFlow(chained, GEN)).toBe(true);
    expect(enforced).toEqual([]);
  });

  it('a plain SESSION resume still enforces — the exemption is the chat flag, not the flow', async () => {
    const { deps, enforced } = soloHarness({
      [SESSION_ID]: chatRecord(SESSION_ID, { chat: false }),
    });
    expect(await resumeFlow(deps, SESSION_ID)).toBe(true);
    expect(enforced).toEqual([SESSION_ID]);
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

// ------------------------------------------ the per-project archive browser
//
// Archiving takes a row out of the tree, which makes the archive the one place
// a session can be without being anywhere you can look. These pin what the
// browser lists (this project's, not everything), what it CALLS things (the
// shared name chain, with a quoted opening prompt marked as a quotation rather
// than passed off as a title), and that ticking rows restores exactly those.

describe('archivedSessionsFlow', () => {
  const A = uuid(21);
  const B = uuid(22);
  const C = uuid(23);

  afterEach(() => {
    delete (mockWindow as QuickPickHost).showQuickPick;
    delete (mockWindow as QuickPickHost).showInformationMessage;
  });

  const gone = (
    id: string,
    over: Partial<EditorialRecord> = {},
  ): EditorialRecord => ({
    id,
    deleted: true,
    cwd: '/Users/a/code/magma',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  interface PickState {
    shown: Array<{ label: string; description?: string; detail?: string; sessionId: string }>;
    opts: { title?: string; canPickMany?: boolean } | undefined;
    told: string[];
  }

  /** Ticks the rows at `indexes`; `undefined` is Escape. */
  function scriptChecklist(indexes: number[] | undefined): PickState {
    const state: PickState = { shown: [], opts: undefined, told: [] };
    (mockWindow as QuickPickHost).showQuickPick = async (items, opts) => {
      state.shown = items as PickState['shown'];
      state.opts = opts as PickState['opts'];
      return indexes === undefined
        ? undefined
        : indexes.map((i) => state.shown[i]);
    };
    (mockWindow as QuickPickHost).showInformationMessage = async (message) => {
      state.told.push(message);
      return undefined;
    };
    return state;
  }

  it('says where things come back from when the project has archived nothing', () => {
    const state = scriptChecklist([0]);
    const { deps, calls } = chatDeps(projectOf(), { records: {} });
    return archivedSessionsFlow(deps, 'p1').then(() => {
      expect(state.told[0]).toContain('Nothing archived in "magma-os"');
      expect(state.shown).toEqual([]);
      expect(calls.records).toEqual([]);
    });
  });

  it("lists this project's archived sessions and nothing else", async () => {
    const state = scriptChecklist(undefined);
    const { deps } = chatDeps(projectOf(), {
      records: {
        [A]: gone(A),
        // Another project's directory, a session that is only CLOSED, and a
        // chat — none of the three is this project's archive.
        [B]: gone(B, { cwd: '/elsewhere' }),
        [C]: gone(C, { deleted: false }),
        [VALID]: gone(VALID, { chat: true }),
      },
    });
    await archivedSessionsFlow(deps, 'p1');
    expect(state.shown.map((r) => r.sessionId)).toEqual([A]);
    // A checklist, not a one-shot picker: restoring four things should be one
    // gesture rather than four trips through the same list.
    expect(state.opts?.canPickMany).toBe(true);
    expect(state.opts?.title).toBe('Archived · magma-os');
  });

  it('names a row with the best name it has, and marks a quoted one', async () => {
    const state = scriptChecklist(undefined);
    const D = uuid(24);
    const { deps } = chatDeps(projectOf(), {
      records: {
        [A]: gone(A, { title: 'the auth fix', updatedAt: '2026-04-04T00:00:00.000Z' }),
        [B]: gone(B, { updatedAt: '2026-04-03T00:00:00.000Z' }),
        [C]: gone(C, { updatedAt: '2026-04-02T00:00:00.000Z' }),
        [D]: gone(D, { updatedAt: '2026-04-01T00:00:00.000Z' }),
      },
    });
    deps.transcriptFacts = (id) =>
      id === B
        ? { label: 'renamed at the CLI' }
        : id === C
          ? { aiTitle: 'Locate AWS configuration file' }
          : id === D
            ? { firstPrompt: 'why is the roster polling twice' }
            : {};
    await archivedSessionsFlow(deps, 'p1');

    expect(state.shown.map((r) => r.label)).toEqual([
      'the auth fix',
      'renamed at the CLI',
      'Locate AWS configuration file',
      '“why is the roster polling twice”',
    ]);
    // ONLY the quotation is marked. A generated title is still a title OF the
    // conversation; the opening words are not a name anybody chose, and the
    // marker is what says so.
    expect(
      state.shown.map((r) => (r.description ?? '').includes('first message')),
    ).toEqual([false, false, false, true]);
  });

  it("shows the directory, falling back to the transcript's when the record has none", async () => {
    const state = scriptChecklist(undefined);
    const { deps } = chatDeps(projectOf(), {
      records: {
        [A]: gone(A, { cwd: '/Users/a/code/magma/api' }),
        [B]: gone(B, { cwd: undefined }),
      },
    });
    deps.transcriptFacts = (id) =>
      id === B ? { cwd: '/Users/a/code/magma/web' } : {};
    await archivedSessionsFlow(deps, 'p1');
    const byId = new Map(state.shown.map((r) => [r.sessionId, r]));
    expect(byId.get(A)?.detail).toBe('/Users/a/code/magma/api');
    // The 32-of-159 case: without this the row would not be in the list at all.
    expect(byId.get(B)?.detail).toBe('/Users/a/code/magma/web');
  });

  it('restores every ticked row in one gesture, and reveals only a single one', async () => {
    scriptChecklist([0, 2]);
    const { deps, calls } = chatDeps(projectOf(), {
      records: {
        [A]: gone(A, { updatedAt: '2026-04-03T00:00:00.000Z' }),
        [B]: gone(B, { updatedAt: '2026-04-02T00:00:00.000Z' }),
        [C]: gone(C, { updatedAt: '2026-04-01T00:00:00.000Z' }),
      },
    });
    await archivedSessionsFlow(deps, 'p1');
    expect(calls.records).toEqual([
      { id: A, patch: { deleted: false } },
      { id: C, patch: { deleted: false } },
    ]);
    // Scrolling to the last of two would name one of them as the interesting
    // one, so nothing is revealed unless there is exactly one answer.
    expect(calls.reveals).toEqual([]);
    expect(calls.order).toContain('refresh');
  });

  it('reveals the row when exactly one was restored', async () => {
    scriptChecklist([0]);
    const { deps, calls } = chatDeps(projectOf(), { records: { [A]: gone(A) } });
    await archivedSessionsFlow(deps, 'p1');
    expect(calls.reveals).toEqual([A]);
  });

  it('restores nothing on Escape, and nothing on an empty tick', async () => {
    for (const answer of [undefined, []] as (number[] | undefined)[]) {
      scriptChecklist(answer);
      const { deps, calls } = chatDeps(projectOf(), {
        records: { [A]: gone(A) },
      });
      await archivedSessionsFlow(deps, 'p1');
      // A deliberate "actually, none of these" is not an error.
      expect(calls.records).toEqual([]);
    }
  });

  it('files a worktree session under the project through the reach resolver', async () => {
    const state = scriptChecklist(undefined);
    const { deps } = chatDeps(projectOf(), {
      records: { [A]: gone(A, { cwd: '/Users/a/wt/feature' }) },
    });
    await archivedSessionsFlow(deps, 'p1');
    expect(state.shown).toEqual([]);

    const state2 = scriptChecklist(undefined);
    const { deps: deps2 } = chatDeps(projectOf(), {
      records: { [A]: gone(A, { cwd: '/Users/a/wt/feature' }) },
    });
    deps2.projectReach = () => (p) =>
      p.id === 'p1' ? ['/Users/a/wt/feature'] : [];
    await archivedSessionsFlow(deps2, 'p1');
    expect(state2.shown.map((r) => r.sessionId)).toEqual([A]);
  });

  it('says so when a restored row is still hidden by the active-only filter', async () => {
    // A restore into a filtered tree looks exactly like a restore that did
    // nothing. menuState already knew; nothing had ever asked it.
    const notes: string[] = [];
    (mockWindow as StatusHost).setStatusBarMessage = (text) => {
      notes.push(text);
    };
    scriptChecklist([0]);
    const { deps } = chatDeps(projectOf(), { records: { [A]: gone(A) } });
    deps.menuState = () => ({
      hooksInstalled: false,
      onlyActive: true,
      accountsSection: false,
      shellsSection: false,
    });
    await archivedSessionsFlow(deps, 'p1');
    delete (mockWindow as StatusHost).setStatusBarMessage;
    expect(notes.join(' ')).toContain('Show Only Active Sessions');
  });

  it('says which closed project is hiding the restored row, and offers it back', async () => {
    // The archive browser is deliberately reachable for a CLOSED project — the
    // palette entry passes includeHidden so "where did that session go" has an
    // answer. But the restore then landed on no surface at all: the grouping
    // files the row under the closed project and drops it, the record is no
    // longer `deleted` so the browser it came from skips it too, and the only
    // note in the flow spoke about the active-only filter. Success was reported
    // and nothing on screen changed.
    const told: Array<{ message: string; items: string[] }> = [];
    scriptChecklist([0]);
    (mockWindow as QuickPickHost).showInformationMessage = async (
      message,
      ...items
    ) => {
      told.push({ message: String(message), items: items.map(String) });
      return items[0];
    };
    const { deps, calls } = chatDeps(projectOf({ hidden: true }), {
      records: { [A]: gone(A) },
    });
    await archivedSessionsFlow(deps, 'p1');

    expect(told).toHaveLength(1);
    expect(told[0].message).toContain('"magma-os" is closed');
    expect(told[0].items).toEqual(['Reopen "magma-os"']);
    // And the button did the one thing it says it does.
    expect(calls.projectPatches).toEqual([
      { id: 'p1', patch: { hidden: false } },
    ]);
  });

  it('reopens the closed PARENT too, because that is what put the row away', async () => {
    // Closing a project closes its subtree (projects.closedProjectIds), so
    // clearing the flag on the subproject alone would leave the row exactly as
    // absent and the button would be a lie about what it did.
    scriptChecklist([0]);
    (mockWindow as QuickPickHost).showInformationMessage = async (
      _message,
      ...items
    ) => items[0];
    const parent = projectOf({
      id: 'p0',
      name: 'code',
      rootDir: '/Users/a/code',
      dirs: [],
      hidden: true,
    });
    const child = projectOf({ parentId: 'p0' });
    const { deps, calls } = chatDeps(child, {
      records: { [A]: gone(A) },
      projects: [parent, child],
    });
    await archivedSessionsFlow(deps, 'p1');

    // p1 itself is not hidden — it is closed by inheritance — so p0 is the one
    // record that has to change.
    expect(calls.projectPatches).toEqual([
      { id: 'p0', patch: { hidden: false } },
    ]);
  });

  it('says nothing when another project claiming the directory is open', async () => {
    // Claims are non-exclusive: a directory two projects list draws its row
    // under both, so the row is on screen and there is nothing to explain.
    const told: string[] = [];
    scriptChecklist([0]);
    (mockWindow as QuickPickHost).showInformationMessage = async (message) => {
      told.push(String(message));
      return undefined;
    };
    const closedOne = projectOf({ hidden: true });
    const openOne = projectOf({
      id: 'p2',
      name: 'magma-too',
      rootDir: '/Users/a/code/magma',
      dirs: [],
    });
    const { deps, calls } = chatDeps(closedOne, {
      records: { [A]: gone(A) },
      projects: [closedOne, openOne],
    });
    await archivedSessionsFlow(deps, 'p1');

    expect(told).toEqual([]);
    expect(calls.projectPatches).toEqual([]);
  });

  it('says nothing about a closed project when nothing is closed', async () => {
    const told: string[] = [];
    scriptChecklist([0]);
    (mockWindow as QuickPickHost).showInformationMessage = async (message) => {
      told.push(String(message));
      return undefined;
    };
    const { deps } = chatDeps(projectOf(), { records: { [A]: gone(A) } });
    await archivedSessionsFlow(deps, 'p1');
    expect(told).toEqual([]);
  });

  it('says nothing when the restored session is still RUNNING — its row is right there', async () => {
    // An archived-but-live record is a real state (this machine had two of
    // them), and `onlyActive` hides rows that are OVER — never a live one. The
    // note used to ask only how the filter was set, so it told the user to turn
    // a filter off to reveal a row revealSession had just scrolled to.
    const notes: string[] = [];
    (mockWindow as StatusHost).setStatusBarMessage = (text) => {
      notes.push(text);
    };
    scriptChecklist([0]);
    const { deps } = chatDeps(projectOf(), { records: { [A]: gone(A) } });
    deps.menuState = () => ({
      hooksInstalled: false,
      onlyActive: true,
      accountsSection: false,
      shellsSection: false,
    });
    deps.getForest = () => forestOf([node(A, { status: 'busy' })]);
    await archivedSessionsFlow(deps, 'p1');
    delete (mockWindow as StatusHost).setStatusBarMessage;
    expect(notes).toEqual([]);
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
  // The items are the buttons: the archive browser's closed-project note
  // offers "Reopen …" and acts on the answer, so a test has to be able to
  // press it.
  showInformationMessage?: (
    message: string,
    ...items: string[]
  ) => Promise<unknown>;
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

/** The information toast — how every branch verb says "there is nothing here".
 *  Distinct from WarningHost above: these carry no buttons and answer nothing. */
type InfoHost = {
  showInformationMessage?: (
    message: string,
    ...items: string[]
  ) => Promise<string | undefined>;
};
/** The browser hand-off. Scripted so a test can read the url that was built
 *  rather than the fact that something was opened. */
type ExternalHost = {
  openExternal?: (uri: { toString(): string }) => Promise<boolean>;
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


  function scriptConfirm(answer: string | undefined): {
    asked: string[];
    details: string[];
  } {
    const state = { asked: [] as string[], details: [] as string[] };
    (mockWindow as WarningHost).showWarningMessage = async (
      message: string,
      opts?: unknown,
    ) => {
      state.asked.push(message);
      state.details.push((opts as { detail?: string })?.detail ?? '');
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

  // ------------------------------------------------ filing existing work
  //
  // The missing half of named lanes: the stamp was written at LAUNCH and nowhere
  // else, so a conversation that predated the lane could never join it. Measured
  // on a real store before this verb existed: two live lanes, 556 session
  // records, not one stamp between them.

  /** Collects re-filings, and reports the lane a session is already in. */
  function laneMoves(current?: string): {
    deps: Record<string, unknown>;
    moved: { sessionId: string; laneId: string | null }[];
  } {
    const moved: { sessionId: string; laneId: string | null }[] = [];
    return {
      deps: {
        getSessionLane: () => current,
        moveSessionSubproject: async (
          sessionId: string,
          laneId: string | null,
        ) => {
          moved.push({ sessionId, laneId });
        },
      },
      moved,
    };
  }

  const SESSION = uuid(7);

  /** Deps with one session sitting in `cwd`. */
  function withSessionAt(cwd: string, projects: ProjectRecord[]) {
    const { deps } = chatDeps(projects[0], { projects });
    (deps as { getForest: () => SessionForest }).getForest = () =>
      forestOf([node(SESSION, { cwd })]);
    return deps;
  }

  it('offers the lanes of the project the SESSION is in', async () => {
    const picks = scriptPicks('Server rewrite');
    const store = laneStore([lane(), lane({ id: 'lane-2', name: 'Bug hunt' })]);
    const moves = laneMoves();
    const deps = withSessionAt('/code/app/src', [app()]);
    Object.assign(deps as object, store.deps, moves.deps);
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.moveSessionToLane, { type: 'session', id: SESSION });

    expect(picks.offered[0]).toEqual(['Bug hunt', 'Server rewrite']);
    // No "No subproject" exit: this session is not filed anywhere yet, so there
    // is nothing to take it out of.
    expect(picks.offered[0]).not.toContain('No subproject');
    expect(moves.moved).toEqual([{ sessionId: SESSION, laneId: 'lane-1' }]);
  });

  it('offers the way OUT only when the session is filed somewhere', async () => {
    const picks = scriptPicks('No subproject');
    const store = laneStore([lane()]);
    const moves = laneMoves('lane-1');
    const deps = withSessionAt('/code/app', [app()]);
    Object.assign(deps as object, store.deps, moves.deps);
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.moveSessionToLane, { type: 'session', id: SESSION });

    expect(picks.offered[0]).toContain('No subproject');
    // Clearing the stamp is a null, not a delete — the session goes back to
    // being placed by its directory.
    expect(moves.moved).toEqual([{ sessionId: SESSION, laneId: null }]);
  });

  it('writes nothing when the chosen lane is the one it is already in', async () => {
    scriptPicks('Server rewrite');
    const store = laneStore([lane()]);
    const moves = laneMoves('lane-1');
    const deps = withSessionAt('/code/app', [app()]);
    Object.assign(deps as object, store.deps, moves.deps);
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.moveSessionToLane, { type: 'session', id: SESSION });
    expect(moves.moved).toEqual([]);
  });

  it('writes nothing when the picker is cancelled', async () => {
    scriptPicks(undefined);
    const store = laneStore([lane()]);
    const moves = laneMoves();
    const deps = withSessionAt('/code/app', [app()]);
    Object.assign(deps as object, store.deps, moves.deps);
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.moveSessionToLane, { type: 'session', id: SESSION });
    expect(moves.moved).toEqual([]);
  });

  it('never offers ANOTHER project\'s lanes', async () => {
    // The project is derived from the SESSION, never from the row that was
    // clicked: a stamp naming a lane of a project that does not claim the
    // session is a stamp no reader would ever resolve.
    const picks = scriptPicks(undefined);
    const other = projectOf({
      id: 'p2',
      name: 'api',
      rootDir: '/code/api',
      dirs: [],
    });
    const store = laneStore([
      lane({ id: 'mine', name: 'app lane', projectId: 'p1' }),
      lane({ id: 'theirs', name: 'api lane', projectId: 'p2', dir: '/code/api' }),
    ]);
    const moves = laneMoves();
    const deps = withSessionAt('/code/api/src', [app(), other]);
    Object.assign(deps as object, store.deps, moves.deps);
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.moveSessionToLane, { type: 'session', id: SESSION });
    expect(picks.offered[0]).toEqual(['api lane']);
  });

  it('says so rather than opening an empty picker when the project has no lanes', async () => {
    const picks = scriptPicks(undefined);
    const said = told();
    const store = laneStore([]);
    const moves = laneMoves();
    const deps = withSessionAt('/code/app', [app()]);
    Object.assign(deps as object, store.deps, moves.deps);
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.moveSessionToLane, { type: 'session', id: SESSION });

    expect(picks.offered).toEqual([]);
    expect(said.messages.join(' ')).toContain('no named subprojects yet');
    expect(moves.moved).toEqual([]);
  });

  it('says so when no project covers the session at all', async () => {
    const said = told();
    const store = laneStore([lane()]);
    const moves = laneMoves();
    const deps = withSessionAt('/somewhere/loose', [app()]);
    Object.assign(deps as object, store.deps, moves.deps);
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.moveSessionToLane, { type: 'session', id: SESSION });

    expect(said.messages.join(' ')).toContain('no project covers');
    expect(moves.moved).toEqual([]);
  });

  it('reaches a session in a LINKED CHECKOUT through the repository it belongs to', async () => {
    // A worktree of the project's repository. Nobody listed that path and
    // nobody should have to — worktrees come and go several times a day. One
    // probe of the session's own directory names the repository's main checkout,
    // and the project that claims THAT is the project whose lanes are offered.
    const picks = scriptPicks('Server rewrite');
    const store = laneStore([lane()]);
    const moves = laneMoves();
    const deps = withSessionAt('/code/app-feat-x/src', [app()]);
    const probed: string[] = [];
    Object.assign(deps as object, store.deps, moves.deps, {
      worktreesFor: async (dir: string) => {
        probed.push(dir);
        return [
          { dir: '/code/app', branch: 'main', head: 'a', detached: false },
          { dir: '/code/app-feat-x', branch: 'feat/x', head: 'b', detached: false },
        ];
      },
    });
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.moveSessionToLane, { type: 'session', id: SESSION });

    expect(probed).toEqual(['/code/app-feat-x/src']);
    expect(picks.offered[0]).toEqual(['Server rewrite']);
    expect(moves.moved).toEqual([{ sessionId: SESSION, laneId: 'lane-1' }]);
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

  it('announces a directory another project already covers, and adds it anyway', async () => {
    // Claims are NON-EXCLUSIVE (see projects.matchProjects): the directory
    // joins this project too, the lane is created, and grouping shows the
    // sessions there under both claimants. What survives of the old refusal is
    // the announcement — the user hears "shared" at the moment they share it.
    scriptPicks(ELSEWHERE);
    scriptDialog('/code/other');
    scriptName('Other');
    const informed = told();
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

    expect(calls.projectPatches).toEqual([
      { id: 'p1', patch: { dirs: ['/code/other'] } },
    ]);
    expect(store.written).toHaveLength(1);
    expect(store.written[0].patch).toMatchObject({
      projectId: 'p1',
      name: 'Other',
      dir: '/code/other',
    });
    // The other claimant is NAMED — an accident announced is an accident the
    // user can still undo.
    expect(informed.messages.join(' ')).toContain('other');
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

  it('takes the lanes named in a directory away with the directory', async () => {
    // A lane is a name for work IN a folder. Leaving one behind after the project
    // stops covering that folder would strand a row nothing can ever be filed
    // under again — the project no longer claims a session in there to hold.
    const confirm = scriptConfirm('Remove Subproject');
    const two = app({ dirs: ['/code/app/api'] });
    const store = laneStore([
      lane({ id: 'l1', name: 'Handlers', dir: '/code/app/api' }),
      lane({ id: 'l2', name: 'Schemas', dir: '/CODE/APP/API' }),
      lane({ id: 'l3', name: 'Elsewhere', dir: '/code/app' }),
      lane({ id: 'l4', name: 'Another project', dir: '/code/app/api', projectId: 'p2' }),
    ]);
    const { deps, calls } = chatDeps(two, { projects: [two] });
    Object.assign(deps as object, store.deps);
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.removeSubproject, {
      type: 'subproject',
      projectId: 'p1',
      dir: '/code/app/api',
      id: 'dir:/code/app/api',
    });

    // Both of this project's lanes in that directory, matched the way every other
    // path comparison in Flock matches. Not the one in another directory, and not
    // another project's.
    expect(store.removed).toEqual(['l1', 'l2']);
    expect(calls.projectPatches).toEqual([{ id: 'p1', patch: { dirs: [] } }]);
    expect(confirm.details[0]).toContain('2 subprojects');
  });

  it('names the single lane it is about to take with it', async () => {
    const confirm = scriptConfirm(undefined);
    const two = app({ dirs: ['/code/app/api'] });
    const store = laneStore([
      lane({ id: 'l1', name: 'Handlers', dir: '/code/app/api' }),
    ]);
    const { deps, calls } = chatDeps(two, { projects: [two] });
    Object.assign(deps as object, store.deps);
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.removeSubproject, {
      type: 'subproject',
      projectId: 'p1',
      dir: '/code/app/api',
      id: 'dir:/code/app/api',
    });

    // Declined: the dialog said the name would go, and nothing went.
    expect(confirm.details[0]).toContain('"Handlers"');
    expect(store.removed).toEqual([]);
    expect(calls.projectPatches).toEqual([]);
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

  it("a lane pinning a branch launches in that branch's CHECKOUT — worktree-aware placement", async () => {
    const two = app();
    const store = laneStore([lane({ branch: 'feat/x' })]);
    const { deps, calls } = chatDeps(two, { projects: [two] });
    Object.assign(deps as object, store.deps);
    const probed: string[] = [];
    (deps as { worktreesFor?: unknown }).worktreesFor = async (dir: string) => {
      probed.push(dir);
      return [
        { dir: '/code/app', branch: 'main', head: 'a', detached: false },
        { dir: '/code/app-feat-x', branch: 'feat/x', head: 'b', detached: false },
      ];
    };
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.newSessionInSubproject, {
      type: 'subproject',
      projectId: 'p1',
      dir: '/code/app',
      id: 'lane-1',
    });

    // Probed at the lane's own directory — the only address the lane has.
    expect(probed).toEqual(['/code/app']);
    expect(calls.launches).toHaveLength(1);
    // The launch followed the BRANCH; the session keeps the LANE's name — the
    // lane is the identity, the worktree is placement.
    expect(calls.launches[0].cwd).toBe('/code/app-feat-x');
    expect(calls.launches[0].title).toBe('Server rewrite');
    expect(calls.launches[0].subprojectId).toBe('lane-1');
  });

  it('a pin with no checkout falls back to the lane directory — never refuses, never creates', async () => {
    const two = app();
    const store = laneStore([lane({ branch: 'feat/gone' })]);
    const { deps, calls } = chatDeps(two, { projects: [two] });
    Object.assign(deps as object, store.deps);
    (deps as { worktreesFor?: unknown }).worktreesFor = async () => [
      { dir: '/code/app', branch: 'main', head: 'a', detached: false },
    ];
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.newSessionInSubproject, {
      type: 'subproject',
      projectId: 'p1',
      dir: '/code/app',
      id: 'lane-1',
    });

    expect(calls.launches).toHaveLength(1);
    expect(calls.launches[0].cwd).toBe('/code/app');
  });

  it('a wiring without worktreesFor places by the lane directory — the pre-pin behaviour', async () => {
    // Also every unpinned lane's path: no pin, no probe, no redirect.
    const two = app();
    const store = laneStore([lane({ branch: 'feat/x' })]);
    const { deps, calls } = chatDeps(two, { projects: [two] });
    Object.assign(deps as object, store.deps);
    const { run } = withRegisteredCommands(deps as never);

    await run(COMMANDS.newSessionInSubproject, {
      type: 'subproject',
      projectId: 'p1',
      dir: '/code/app',
      id: 'lane-1',
    });

    expect(calls.launches).toHaveLength(1);
    expect(calls.launches[0].cwd).toBe('/code/app');
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
    delete (mockWindow as QuickPickHost).showInformationMessage;
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

  it('announces a directory an existing project already covers, and creates anyway', async () => {
    // Claims are NON-EXCLUSIVE (see projects.matchProjects): the second project
    // is created on the shared directory and its sessions show under both. The
    // old modal refusal survives only as an announcement naming the other
    // claimant.
    const informed: string[] = [];
    (mockWindow as QuickPickHost).showInformationMessage = async (message) => {
      informed.push(message);
      return undefined;
    };
    (mockCommands as CommandHost).executeCommand = async () => undefined;
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

    expect(calls.projectPatches).toHaveLength(1);
    expect(calls.projectPatches[0].patch).toMatchObject({
      rootDir: '/code/app',
    });
    // Not "app": the name defaults from the directory's basename, and "app" is
    // taken — nextFreeName steps past the collision.
    expect(calls.projectPatches[0].patch.name).not.toBe('app');
    expect(informed.join(' ')).toContain('app');
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
      getRecord: () => rec({ tmux: null, graceUntil: null }),
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
        getRecord: () => rec({ tmux: null, graceUntil: null }),
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
      getRecord: () => rec({ tmux: TMUX, graceUntil: '2099-01-01T00:00:00.000Z' }),
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
    // The tab is back: the record must stop claiming "hidden" — and a
    // close-after-turn mark minted against the detached deadline clears with
    // it, or the sweep would close the tab the user just re-attached.
    expect(calls.records).toContainEqual({
      id: VALID,
      patch: {
        closed: null,
        graceUntil: null,
        tmux: null,
        closeAfterTurn: false,
        stowedBySwitch: false,
      },
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

// ------------------- forking a row named only by a quotation of its first prompt
//
// A closed session with no title of any kind is labelled with its opening words
// in typographic quotes (archive.transcriptFallbackName), and the quotes are what
// tell the reader it is not a name anybody chose. `tabTitleFor` already refuses
// that string on the resume path — a quotation on a terminal tab, stripped of the
// row that framed it, is worse than `claude · 1a2b3c4d`. The FORK paths bypassed
// that guard and, worse, wrote the quotation into the child's `record.title`,
// which is where every later tab name and workspace restore reads from: the
// guard was then defeated for good rather than for one launch.
//
// What replaces it is NOT the short id `labelFor` falls back to. A bare hex row
// name is the thing the archived-naming work exists to remove, so a fork of such
// a row is named after its CHECKOUT — `defaultSessionTitle`, the same name a
// brand-new root in that directory is offered. See forkStemFor.

describe('a fork is never named after its parent’s quoted first prompt', () => {
  afterEach(() => {
    delete (mockCommands as { registerCommand?: unknown }).registerCommand;
  });

  const PARENT = uuid(1);
  const QUOTED = '\u201cI want to post this on linkedIn, help me write it\u201d';

  const quotedParent = (over: Partial<SessionNode> = {}): SessionNode =>
    node(PARENT, {
      cwd: '/code/app',
      archived: true,
      status: 'exited',
      label: QUOTED,
      labelIsFallback: true,
      ...over,
    });

  it('unit: the stem falls through the quotation to the checkout, not to a hex id', () => {
    const { deps } = chatDeps(undefined);
    const withParent: CommandDeps = {
      ...deps,
      getForest: () => forestOf([quotedParent()]),
    };
    expect(forkStemFor(withParent, PARENT)).toBe('app');
    // A row that HAS a name keeps it, quotes or not — a user may legitimately
    // name a session with a quotation mark.
    const named: CommandDeps = {
      ...deps,
      getForest: () => forestOf([quotedParent({ labelIsFallback: undefined })]),
    };
    expect(forkStemFor(named, PARENT)).toBe(QUOTED);
  });

  it('the CLICK path: neither the terminal tab nor the stored title carries it', async () => {
    const { deps, calls } = chatDeps(undefined, {
      hasTranscript: () => true,
      beginInlineRename: () => true,
    });
    const withParent: AccountCommandDeps = {
      ...deps,
      getForest: () => forestOf([quotedParent()]),
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
    };
    const harness = withRegisteredCommands(withParent);
    await harness.run(COMMANDS.forkSession, PARENT);

    expect(calls.launches).toHaveLength(1);
    const launched = calls.launches[0];
    // The checkout's name plus the fork counter — what a new root here gets.
    expect(launched.title).toBe('app 2');
    expect(launched.title).not.toContain('\u201c');
    // And the RECORD, which is where the next resume and workspaces.ts read the
    // tab name from. Fixing only the launch leaves the quotation to come back.
    const titled = calls.records.filter((r) => r.patch.title !== undefined);
    expect(titled).toHaveLength(1);
    expect(titled[0].patch.title).toBe('app 2');
    // Not the hex id either: `labelFor`'s fallback would have said '00000001 2'.
    expect(titled[0].patch.title).not.toContain('0000000');
  });

  it('the AGENT path names it the same way', async () => {
    const { deps, calls } = chatDeps(undefined, { hasTranscript: () => true });
    const withParent: AccountCommandDeps = {
      ...deps,
      getForest: () => forestOf([quotedParent()]),
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
    const outcome = await forkForAgent(withParent, PARENT, { count: 1 });
    expect(outcome.titles).toEqual(['app 2']);
    expect(calls.launches[0].title).toBe('app 2');
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

// The launcher execs the CLI the account's provider names — `claude` for a
// Claude or API-key account, `codex` for a Codex one. A provider whose CLI it
// does NOT exec (Gemini) would launch `claude` on the machine's DEFAULT login
// while the pin, the row and the status line all named the other account, so
// the verbs refuse that out loud and the router never offers it.
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

  it('"New Session on this account" on a Gemini row refuses instead of launching', async () => {
    const warnings = captureWarnings();
    const GEMINI = accountProfile('gemini-default', {
      provider: 'gemini',
      label: 'Gemini — default',
    });
    const { accounts, calls: acctCalls } = fakeAccountDeps([GEMINI]);
    const { deps, calls } = chatDeps(undefined);
    const withAccounts: AccountCommandDeps = { ...deps, accounts };

    const harness = withRegisteredCommands(withAccounts);
    await harness.run(COMMANDS.newSessionFromAccount, GEMINI.id);

    expect(calls.launches).toEqual([]);
    expect(acctCalls.pinned).toEqual([]);
    expect(warnings.join(' ')).toContain('Gemini');
  });

  it('it cannot be made the default for new sessions either', async () => {
    captureWarnings();
    const GEMINI = accountProfile('gemini-default', { provider: 'gemini' });
    const { accounts, calls: acctCalls } = fakeAccountDeps([GEMINI]);
    const { deps } = chatDeps(undefined);
    const withAccounts: AccountCommandDeps = { ...deps, accounts };

    const harness = withRegisteredCommands(withAccounts);
    await harness.run(COMMANDS.setDefaultAccount, GEMINI.id);

    expect(acctCalls.defaultRoutingSet).toEqual([]);
  });

  it('a pin left on such an account resumes with no environment at all', async () => {
    const PARENT = uuid(1);
    const GEMINI = accountProfile('gemini-default', {
      provider: 'gemini',
      configDir: '/gemini/home',
    });
    const { accounts, calls: acctCalls } = fakeAccountDeps([GEMINI], {
      sessionProfileId: () => GEMINI.id,
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

// The other half of the same rule, and the one this feature exists for: a
// Codex account IS a place a session starts, and the launch has to say so on
// the way out. `provider: 'codex'` is what makes TerminalRegistry.launch exec
// `codex` rather than `claude`, so a launch carrying CODEX_HOME WITHOUT it
// would be precisely the credential-sharing failure the old refusal existed to
// prevent — the account's variable set on a CLI that ignores it.
describe('a session on a Codex account launches the Codex CLI', () => {
  // The flow reads `vscode.workspace.workspaceFolders` to decide where a
  // no-project launch runs. The shared mock exports no `workspace` at all, so
  // these tests hang one off it for their own duration — the same trick
  // test/topbar.test.ts documents — rather than widening a mock every other
  // test is happy without.
  beforeEach(() => {
    (vscodeMock as unknown as { workspace: unknown }).workspace = {
      workspaceFolders: [{ uri: { fsPath: '/code/api' }, name: 'api' }],
    };
  });
  afterEach(() => {
    delete (mockCommands as { registerCommand?: unknown }).registerCommand;
    delete (vscodeMock as unknown as { workspace?: unknown }).workspace;
  });

  function launchDeps(profiles: AccountProfile[]): {
    withAccounts: AccountCommandDeps;
    calls: ChatCalls;
    acctCalls: ReturnType<typeof fakeAccountDeps>['calls'];
  } {
    const { accounts, calls: acctCalls } = fakeAccountDeps(profiles);
    const { deps, calls } = chatDeps(undefined, { beginInlineRename: () => true });
    const withAccounts: AccountCommandDeps = {
      ...deps,
      launchSession: async (opts) => {
        calls.launches.push(opts);
        return {
          nodeId: opts.sessionId,
          sessionId: opts.sessionId,
          terminalName: 'codex',
          createdAt: 0,
        };
      },
      accounts,
    };
    return { withAccounts, calls, acctCalls };
  }

  it('"New Session on this account" launches, pins, and marks the launch codex', async () => {
    const CODEX = accountProfile('codex-default', {
      provider: 'codex',
      label: 'Codex — default',
      configDir: '/codex/home',
    });
    const { withAccounts, calls, acctCalls } = launchDeps([CODEX]);

    const harness = withRegisteredCommands(withAccounts);
    await harness.run(COMMANDS.newSessionFromAccount, CODEX.id);

    expect(calls.launches).toHaveLength(1);
    expect(calls.launches[0].provider).toBe('codex');
    // The isolation the row claims is the isolation the process gets: the
    // account's own CODEX_HOME, reaching a CLI that actually reads it.
    expect(calls.launches[0].env).toEqual({ CODEX_HOME: '/codex/home' });
    expect(acctCalls.pinned).toEqual([
      { sessionId: calls.launches[0].sessionId, profileId: CODEX.id },
    ]);
  });

  it('an API-key account launches CLAUDE, never a binary named after its provider', async () => {
    const KEY = accountProfile('api-key', {
      provider: 'generic',
      extraEnv: { ANTHROPIC_API_KEY: 'sk-test' },
    });
    const { withAccounts, calls } = launchDeps([KEY]);

    const harness = withRegisteredCommands(withAccounts);
    await harness.run(COMMANDS.newSessionFromAccount, KEY.id);

    expect(calls.launches).toHaveLength(1);
    // Absent, not 'generic': `generic` is a Claude launch authenticated by a
    // variable, and naming it here would send the launcher looking for a
    // binary called `generic`.
    expect(calls.launches[0].provider).toBeUndefined();
  });
});

// Which CLI a RESUME or a FORK execs is a fact about the conversation, and the
// three tests below are the three ways that fact can be learned — and the one
// way it must NOT be. Getting this wrong hands `codex resume` a Claude session
// id, or `claude --resume` a Codex one; both fail against a store that has
// never heard of the id.
describe('an existing conversation keeps its own CLI', () => {
  afterEach(() => {
    delete (mockCommands as { registerCommand?: unknown }).registerCommand;
  });

  function forkDeps(over: {
    records?: Record<string, EditorialRecord>;
    sessionProvider?: (id: string) => 'codex' | undefined;
    profiles?: AccountProfile[];
    sessionProfileId?: (id: string) => string | undefined;
  }): { withAccounts: AccountCommandDeps; calls: ChatCalls; parent: string } {
    const PARENT = uuid(1);
    const { accounts } = fakeAccountDeps(over.profiles ?? [], {
      sessionProfileId: over.sessionProfileId ?? (() => undefined),
    });
    const { deps, calls } = chatDeps(undefined, {
      hasTranscript: () => true,
      beginInlineRename: () => true,
      ...(over.records !== undefined ? { records: over.records } : {}),
    });
    const withAccounts: AccountCommandDeps = {
      ...deps,
      ...(over.sessionProvider !== undefined
        ? { sessionProvider: over.sessionProvider }
        : {}),
      getForest: () => forestOf([node(PARENT, { cwd: '/code/api' })]),
      launchSession: async (opts) => {
        calls.launches.push(opts);
        return {
          nodeId: opts.sessionId,
          sessionId: opts.sessionId,
          terminalName: 'codex',
          createdAt: 0,
        };
      },
      accounts,
    };
    return { withAccounts, calls, parent: PARENT };
  }

  it('a fork of a Codex session is a Codex fork — from the record', () => {
    const PARENT = uuid(1);
    const { withAccounts, calls } = forkDeps({
      records: {
        [PARENT]: {
          id: PARENT,
          provider: 'codex',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        } as EditorialRecord,
      },
    });
    const harness = withRegisteredCommands(withAccounts);
    return harness.run(COMMANDS.forkSession, PARENT).then(() => {
      expect(calls.launches).toHaveLength(1);
      expect(calls.launches[0].provider).toBe('codex');
      expect(calls.launches[0].parentId).toBe(PARENT);
    });
  });

  it('a fork of a FOREIGN Codex session works too — from which store holds it', async () => {
    // No record at all: a codex session started in a terminal. The only thing
    // that knows is the wiring, which holds both history indexes.
    const { withAccounts, calls, parent } = forkDeps({
      sessionProvider: (id) => (id === uuid(1) ? 'codex' : undefined),
    });
    const harness = withRegisteredCommands(withAccounts);
    await harness.run(COMMANDS.forkSession, parent);

    expect(calls.launches).toHaveLength(1);
    expect(calls.launches[0].provider).toBe('codex');
    // No account, and that is correct rather than a gap: `codex fork <id>` on
    // the machine's own login is exactly where that conversation lives.
    expect(calls.launches[0].profileId).toBeUndefined();
  });

  it('a CLAUDE session re-pinned onto a Codex account still forks under claude', async () => {
    // The pin and the conversation disagree, and the conversation wins: the
    // transcript is a Claude one, so `codex fork` would be handed an id Codex
    // has never seen. This is the case a naive "read the account's provider"
    // implementation gets wrong.
    const PARENT = uuid(1);
    const CODEX = accountProfile('codex-acct', {
      provider: 'codex',
      configDir: '/codex/home',
    });
    const { withAccounts, calls } = forkDeps({
      profiles: [CODEX],
      sessionProfileId: (id) => (id === PARENT ? CODEX.id : undefined),
      // No record provider and no store evidence — it is a Claude session.
    });
    const harness = withRegisteredCommands(withAccounts);
    await harness.run(COMMANDS.forkSession, PARENT);

    expect(calls.launches).toHaveLength(1);
    expect(calls.launches[0].provider).toBeUndefined();
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

  // The third of the three fork-naming sites — see the quoted-first-prompt block
  // above for why the quotation must not reach a tab or a record. Reaching this
  // state takes an ARCHIVED parent that still owns a live background job, which
  // is contrived; the call is shared anyway, because "how a fork is named" is not
  // allowed two answers.
  it('never names it after the parent’s quoted first prompt', async () => {
    const { deps, calls } = adoptDeps({
      getForest: () =>
        forestOf([
          node(PARENT, {
            cwd: '/code/app',
            archived: true,
            status: 'exited',
            label: '\u201cwrite me a linkedIn post\u201d',
            labelIsFallback: true,
          }),
          node(CHILD, { roster: { sessionId: CHILD, pid: 0 } }),
        ]),
    });

    expect(await adoptBackgroundJob(deps, CHILD, job())).toBe(true);
    expect(calls.launches[0].title).toBe('app 2');
    expect(calls.records).toContainEqual({
      id: CHILD,
      patch: { title: 'app 2' },
    });
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

// --------------------------------- close/archive over a RUNNING session
//
// A grace row is a RUNNING process whose only surface is the tree row — its
// tab is gone by definition. Two verbs used to be able to make that process
// invisible: Close stamped `closed` while the wrap ran on (the record lying
// for up to the rest of the grace window), and Delete removed the row without
// killing anything (running + shown nowhere — the exact unrepresentable state
// the levels exist to remove, permanent when the record was pinned). Both now
// route the process through the wiring's tree-reaping `killDetached` FIRST.
//
// ARCHIVE'S HALF OF THIS WAS ONLY HALF FIXED, and the rest of it is pinned
// below. `claimsDetachedProcess` is false for a session that has a TAB, so the
// old flow skipped it and wrote `deleted: true` straight over a live process:
// the row left the tree, the process carried on, and because `pickSession`
// filters archived rows out of every verb the user could not even close the
// thing they had just archived. Archive now means close-then-hide — and the
// one case it refuses rather than forces is a session somebody else is
// running, because killing that ends a conversation another window is looking
// at.

describe('archive ends a running session before it takes the row away', () => {
  afterEach(() => {
    delete (mockCommands as { registerCommand?: unknown }).registerCommand;
    delete (mockWindow as { showWarningMessage?: unknown }).showWarningMessage;
    delete (mockWindow as { showInformationMessage?: unknown })
      .showInformationMessage;
    delete (mockWindow as { showQuickPick?: unknown }).showQuickPick;
    delete (mockWindow as { setStatusBarMessage?: unknown }).setStatusBarMessage;
  });

  const SESSION = uuid(1);
  const GRACE = '2099-01-01T00:00:00.000Z';

  interface GraceHarness {
    /** Everything the flow did, in order: 'killDetached' entries interleaved
     *  with 'upsert:<flag>' entries — the ORDER is the invariant under test
     *  (the process must be gone before its last row is). */
    order: string[];
    patches: Array<{ id: string; patch: Partial<EditorialRecord> }>;
    warnings: string[];
    /** The MODAL confirmations only, message and detail together, so a test
     *  can assert on what the dialog promised without matching against every
     *  non-modal warning the flows also raise. */
    modals: string[];
    closedHere: string[];
    run: (command: string, arg?: unknown) => Promise<void>;
  }

  /** An OLDER generation of the same conversation. The detached claim is
   *  written onto whichever id was parked and is deliberately not inherited by
   *  a successor (generations.INHERITED_RECORD_KEYS), so this is where a
   *  re-keyed session's `graceUntil`/`tmux` actually lives. */
  const OLDER = uuid(2);

  function graceHarness(over: {
    record?: Partial<EditorialRecord>;
    /** The claim, on OLDER rather than on the row's own id — the shape a
     *  parked conversation that has since re-minted its id really has. Wires
     *  `detachedClaimHolder` exactly as extension.ts does (a chain search) and
     *  leaves `getRecord(SESSION)` claiming nothing, which is what the tip
     *  record really says. */
    chainClaim?: Partial<EditorialRecord>;
    killResult?: boolean;
    host?: 'here' | 'flock' | 'foreign' | 'none';
    forest?: SessionForest;
    /** The cross-window restore-race guard's answer: the record is bound to
     *  a LIVE window that is not this one. Absent = dep unwired (old
     *  wirings), which must read as false. */
    foreignLive?: boolean;
    /** This window holds a terminal for the session — the tab-hosted case the
     *  archive verb has to close before it takes the row away. */
    hasTerminal?: boolean;
    /** Answer the archive confirmation with Cancel instead of its button. */
    decline?: boolean;
  }): GraceHarness {
    const order: string[] = [];
    const patches: Array<{ id: string; patch: Partial<EditorialRecord> }> = [];
    const warnings: string[] = [];
    const modals: string[] = [];
    const closedHere: string[] = [];
    (
      mockWindow as {
        showWarningMessage?: (m: unknown, ...rest: unknown[]) => Promise<unknown>;
      }
    ).showWarningMessage = async (message, ...rest) => {
      warnings.push(String(message));
      const opts = rest[0] as { modal?: boolean; detail?: string } | undefined;
      const isModal =
        typeof opts === 'object' && opts !== null && opts.modal === true;
      if (!isModal) return undefined;
      modals.push(`${String(message)}\n${opts?.detail ?? ''}`);
      // The confirm button is the last argument, exactly as the workbench
      // renders it. Declining answers `undefined`, which is what Cancel and
      // Escape both produce.
      return over.decline === true ? undefined : rest[rest.length - 1];
    };
    // The delete flows end on an information toast with an Undo button;
    // returning undefined is "no Undo". The stale picker's QuickPick is
    // scripted per test where needed.
    (
      mockWindow as { showInformationMessage?: () => Promise<unknown> }
    ).showInformationMessage = async () => undefined;
    (
      mockWindow as { setStatusBarMessage?: (m: string, ms?: number) => void }
    ).setStatusBarMessage = () => {};

    const hostAnswer = over.host;
    const { deps } = chatDeps(undefined);
    const withGrace: AccountCommandDeps = {
      ...deps,
      getForest: () => over.forest ?? forestOf([node(SESSION)]),
      getRecord: (id) =>
        id === SESSION && over.record !== undefined
          ? { id, createdAt: GRACE, updatedAt: GRACE, ...over.record }
          : id === OLDER && over.chainClaim !== undefined
            ? { id, createdAt: GRACE, updatedAt: GRACE, ...over.chainClaim }
            : undefined,
      upsertRecord: async (id, patch) => {
        for (const key of Object.keys(patch)) order.push(`upsert:${key}`);
        patches.push({ id, patch });
      },
      // A grace row has no terminal anywhere; `hasTerminal` opts into the
      // other case the archive verb has to handle — a session still open in a
      // tab in THIS window.
      closeTerminal: (id) => {
        if (over.hasTerminal !== true) return false;
        order.push('closeTerminal');
        closedHere.push(id);
        return true;
      },
      killDetached: async () => {
        order.push('killDetached');
        return over.killResult ?? true;
      },
      ...(over.chainClaim === undefined
        ? {}
        : {
            // The wiring's own probe, mirrored: search the CHAIN for the
            // generation that carries the claim (extension.detachedClaimHolder).
            detachedClaimHolder: (id: string) =>
              id === SESSION || id === OLDER
                ? [SESSION, OLDER].find((alias) => {
                    const r = alias === SESSION ? over.record : over.chainClaim;
                    return (
                      r?.graceUntil != null ||
                      (typeof r?.tmux === 'string' && r.tmux !== '')
                    );
                  })
                : undefined,
          }),
      ...(hostAnswer === undefined ? {} : { hostOf: () => hostAnswer }),
      ...(over.foreignLive === undefined
        ? {}
        : { boundToLiveForeignWindow: () => over.foreignLive === true }),
    };
    const harness = withRegisteredCommands(withGrace);
    return {
      order,
      patches,
      warnings,
      modals,
      closedHere,
      run: (c, a) => harness.run(c, a ?? SESSION),
    };
  }

  it('ARCHIVE kills the graced wrap BEFORE writing deleted', async () => {
    const h = graceHarness({ record: { graceUntil: GRACE, tmux: 'lineage-x' } });
    await h.run(COMMANDS.deleteSession);
    // The write also clears the switch's stow marker — delete is a user verb.
    expect(h.order).toEqual([
      'killDetached',
      'upsert:deleted',
      'upsert:stowedBySwitch',
    ]);
    expect(h.patches).toContainEqual({
      id: SESSION,
      patch: { deleted: true, stowedBySwitch: false },
    });
  });

  // ---- the claim on an OLDER generation id
  //
  // THE LEAK THIS BLOCK PINS, and it was found running on a real machine: a
  // `claude` process 31 hours old, its row long gone. The claim is stamped on
  // whichever id was parked; a conversation that re-mints its id afterwards (a
  // plain resume, a compaction) does NOT carry `tmux`/`graceUntil` onto the
  // successor, so the claim sits on a middle member while the ROW is the tip.
  // Every verb below read the TIP record, concluded "nothing detached", and
  // skipped the kill `killDetached` would happily have performed — because it
  // searched the chain all along. Archive then wrote `deleted: true` over the
  // live wrap: row gone, process running, nothing counting it.

  it('ARCHIVE kills a wrap whose claim sits on an OLDER generation id', async () => {
    const h = graceHarness({
      record: {},
      chainClaim: { graceUntil: GRACE, tmux: 'lineage-x' },
    });
    await h.run(COMMANDS.deleteSession);
    expect(h.order).toEqual([
      'killDetached',
      'upsert:deleted',
      'upsert:stowedBySwitch',
    ]);
  });

  it('the dialog counts the older generation\'s wrap too', async () => {
    // The modal must be counted with the function that acts. It used to ask its
    // own tip-only question, so for this shape it promised nothing and then
    // (before the fix above) delivered nothing either — the user was never told
    // a running session was about to lose its row.
    const h = graceHarness({
      record: {},
      chainClaim: { graceUntil: GRACE, tmux: 'lineage-x' },
    });
    await h.run(COMMANDS.deleteSession);
    expect(h.modals[0]).toContain('still running');
  });

  it('CLOSE routes an older generation\'s wrap through killDetached', async () => {
    // Same undercount, Close verb: it stamped `closed` on the row while the
    // wrap ran on, which is the record lying about the process.
    const h = graceHarness({
      record: {},
      chainClaim: { graceUntil: GRACE, tmux: 'lineage-x' },
    });
    await h.run(COMMANDS.closeSession);
    expect(h.order).toEqual(['killDetached', 'upsert:stowedBySwitch']);
    expect(h.warnings).toEqual([]);
  });

  it('CLOSE NOW routes an older generation\'s wrap through killDetached', async () => {
    const h = graceHarness({
      record: {},
      chainClaim: { graceUntil: GRACE, tmux: 'lineage-x' },
    });
    await h.run(COMMANDS.closeSessionNow);
    expect(h.order[0]).toBe('killDetached');
    expect(h.patches.some((p) => typeof p.patch.closed === 'string')).toBe(false);
  });

  it('an explicit ARCHIVE outranks the pin — pinned graced rows are killed too', async () => {
    // The permanent variant of the leak: pinned + graced + deleted was a
    // process that ran FOREVER with no row and no reaper (the sweep skips
    // pinned records before any grace handling). The pin exempts a session
    // from the automatic sweeps, not from the user saying "remove this".
    const h = graceHarness({
      record: { graceUntil: GRACE, tmux: 'lineage-x', pinned: true },
    });
    await h.run(COMMANDS.deleteSession);
    expect(h.order[0]).toBe('killDetached');
  });

  it('ARCHIVE on a row that is already over signals nothing', async () => {
    const h = graceHarness({ record: { closed: GRACE } });
    await h.run(COMMANDS.deleteSession);
    expect(h.order).toEqual(['upsert:deleted', 'upsert:stowedBySwitch']);
  });

  it('ARCHIVE spares a STALE detached claim whose terminal is bound HERE', async () => {
    // A restore clears the grace only after its launch resolves, so a bound
    // tab can briefly coexist with the claim. The tab is the surface then,
    // and delete's contract is to never touch tabs — killing would end the
    // session the user just re-attached.
    const h = graceHarness({
      record: { graceUntil: GRACE, tmux: 'lineage-x' },
      host: 'here',
    });
    await h.run(COMMANDS.deleteSession);
    expect(h.order).toEqual(['upsert:deleted', 'upsert:stowedBySwitch']);
  });

  it('ARCHIVE refuses a claim bound to a LIVE foreign window — the cross-window restore race', async () => {
    // Window B's restore stamps boundWindowId at bind time but clears the
    // grace claim only after its launch resolves, so for a few seconds this
    // record reads as detached HERE while the process has a tab THERE.
    //
    // This USED to remove the row anyway and signal nothing, on the argument
    // that removing a row is archive's contract. That argument died with the
    // verb's meaning: archive now closes what it archives, and the only two
    // things it could do here are kill a session somebody else just
    // re-attached, or hide a running process behind no row at all. Both are
    // worse than saying so, so it says so and writes nothing.
    const h = graceHarness({
      record: { graceUntil: GRACE, tmux: 'lineage-x' },
      foreignLive: true,
    });
    await h.run(COMMANDS.deleteSession);
    expect(h.order).toEqual([]);
    expect(h.patches).toEqual([]);
    expect(h.modals).toEqual([]);
    // Named precisely, because a session another Flock window is holding is
    // something the user can go and close; the wording has to say which door.
    expect(h.warnings.join(' ')).toContain('running in another Flock window');
  });

  it('ARCHIVE refuses a live session of OURS that this window cannot end', async () => {
    // The third way "somebody else has it" happens, and the one that used to
    // fall through every guard: a session Flock launched whose tab has gone
    // (`boundWindowId` nulled on exit, or naming a window that is no longer
    // live) and which is live again outside this window — resumed in a plain
    // terminal, or waiting for a reload's reassociate to rebind it. hostOf
    // answers 'flock', so neither the foreign nor the other-window arm fired;
    // there was no terminal to dispose and no claim to kill through, so
    // archive ended nothing, said nothing, and wrote `deleted: true` over a
    // live process. Because pickSession filters archived rows out of every
    // verb in commands.ts, the user could not even close it afterwards.
    const h = graceHarness({ record: { launchedByUs: true }, host: 'flock' });
    await h.run(COMMANDS.deleteSession);
    expect(h.order).toEqual([]);
    expect(h.patches).toEqual([]);
    expect(h.modals).toEqual([]);
    expect(h.warnings.join(' ')).toContain('not in a tab this window holds');
  });

  it('...but archives an ordinary PARKED session of ours, which it can end', async () => {
    // The control for the refusal above: 'flock' is also what a session parked
    // into the private tmux server answers, and that one this window CAN end —
    // through the detached funnel. A refusal here would have broken the
    // commonest archive there is.
    const h = graceHarness({
      record: { graceUntil: GRACE, tmux: 'lineage-x' },
      host: 'flock',
    });
    await h.run(COMMANDS.deleteSession);
    expect(h.order).toEqual([
      'killDetached',
      'upsert:deleted',
      'upsert:stowedBySwitch',
    ]);
  });

  it('ARCHIVE refuses a session running OUTSIDE Flock', async () => {
    // The other way "somebody else has it" happens. Flock never started this
    // process and cannot end it, so the choice is the same one as above and
    // the answer is the same: refuse, and say which session and why.
    const h = graceHarness({ record: { closed: GRACE }, host: 'foreign' });
    await h.run(COMMANDS.deleteSession);
    expect(h.patches).toEqual([]);
    expect(h.warnings.join(' ')).toContain('running outside Flock');
    expect(h.warnings.join(' ')).toContain('cannot archive it');
  });

  it('ARCHIVE closes a TAB-hosted session before writing deleted', async () => {
    // The bug this block exists for. A session with a terminal claims no
    // detached process, so the old flow ended nothing and removed its row —
    // running, and shown nowhere. The terminal is disposed first now, in the
    // same before-the-flag order the grace row has always had.
    const h = graceHarness({ record: {}, hasTerminal: true });
    await h.run(COMMANDS.deleteSession);
    // The record also learns what closeFlow would have told it on an ordinary
    // close — this window ended the run, and its binding is gone — because
    // this is the one tier nothing else records. The detached kill funnel
    // stamps the record on its own way through.
    expect(h.order).toEqual([
      'closeTerminal',
      'upsert:deleted',
      'upsert:stowedBySwitch',
      'upsert:closed',
      'upsert:boundWindowId',
    ]);
    expect(h.closedHere).toEqual([SESSION]);
    expect(h.patches[0]?.patch.boundWindowId).toBe(null);
    expect(typeof h.patches[0]?.patch.closed).toBe('string');
  });

  it('ARCHIVE asks first, and a declined dialog writes nothing', async () => {
    const h = graceHarness({
      record: { graceUntil: GRACE, tmux: 'lineage-x' },
      decline: true,
    });
    await h.run(COMMANDS.deleteSession);
    expect(h.modals).toHaveLength(1);
    expect(h.order).toEqual([]);
    expect(h.patches).toEqual([]);
  });

  it('the dialog names the session it is about to close, and the way back', async () => {
    // The one thing Undo cannot bring back is the process, and the only place
    // that can honestly be said is before the click.
    const h = graceHarness({ record: { graceUntil: GRACE, tmux: 'lineage-x' } });
    await h.run(COMMANDS.deleteSession);
    expect(h.modals[0]).toContain('still running');
    expect(h.modals[0]).toContain('A resume brings the conversation back');
    expect(h.modals[0]).toContain('Undo on the toast brings the row back');
    expect(h.modals[0]).toContain('Archived Sessions...');
  });

  it('the dialog says nothing about closing a session that is already over', async () => {
    const h = graceHarness({ record: { closed: GRACE } });
    await h.run(COMMANDS.deleteSession);
    expect(h.modals[0]).not.toContain('still running');
    expect(h.modals[0]).toContain('The row leaves the tree');
  });

  it('CLOSE on a claim a live foreign window owns falls back to stamp-and-warn', async () => {
    // Same race, Close verb: killing would end the session window B just
    // re-attached, so the flow takes the announce path instead — stamp the
    // record closed and say honestly that the session is still running.
    const h = graceHarness({
      record: { graceUntil: GRACE, tmux: 'lineage-x' },
      foreignLive: true,
    });
    await h.run(COMMANDS.closeSession);
    expect(h.order).not.toContain('killDetached');
    expect(h.patches.some((p) => typeof p.patch.closed === 'string')).toBe(true);
    expect(h.warnings.some((w) => w.includes('still'))).toBe(true);
  });

  it('the Archive Stale picker ends graced picks first, same order', async () => {
    (
      mockWindow as {
        showQuickPick?: (items: unknown[]) => Promise<unknown[]>;
      }
    ).showQuickPick = async (items) => items; // tick every offered row
    const h = graceHarness({
      record: { graceUntil: GRACE, tmux: 'lineage-x' },
      forest: forestOf([node(SESSION, { lastActiveAt: NOW - 100 * HOUR })]),
    });
    await h.run(COMMANDS.deleteStale, undefined as unknown as string);
    expect(h.order).toEqual([
      'killDetached',
      'upsert:deleted',
      'upsert:stowedBySwitch',
    ]);
  });

  it('CLOSE on a grace row routes through killDetached — no stamp, no warning', async () => {
    // The old behaviour stamped `closed` while the process ran (the record
    // lying for up to the rest of the grace window) and then warned "still
    // running". The kill funnel already stamps the record archived, so the
    // flow writes nothing of its own and has nothing to warn about.
    const h = graceHarness({ record: { graceUntil: GRACE, tmux: 'lineage-x' } });
    await h.run(COMMANDS.closeSession);
    // The one write after the kill is the user-verb marker clear — the kill
    // funnel keeps `stowedBySwitch` for the sweep's sake, so Close clears it.
    expect(h.order).toEqual(['killDetached', 'upsert:stowedBySwitch']);
    expect(h.warnings).toEqual([]);
  });

  it('CLOSE WITH SUMMARY lands the summary after the kill settled the record', async () => {
    (
      mockWindow as { showInputBox?: () => Promise<string> }
    ).showInputBox = async () => 'traced the leak to the park path';
    const h = graceHarness({ record: { graceUntil: GRACE, tmux: 'lineage-x' } });
    await h.run(COMMANDS.closeWithSummary);
    delete (mockWindow as { showInputBox?: unknown }).showInputBox;
    expect(h.order).toEqual([
      'killDetached',
      'upsert:stowedBySwitch',
      'upsert:summary',
    ]);
    expect(h.patches).toContainEqual({
      id: SESSION,
      patch: {
        stowedBySwitch: false,
        summary: 'traced the leak to the park path',
      },
    });
  });

  it('CLOSE falls back to the honest stamp-and-warn when the kill fails', async () => {
    // killDetached returning false means the wiring found no wrap to end —
    // the record's claim was stale. The flow keeps its old shape then:
    // stamp closed, and say why the row may still read live.
    const h = graceHarness({
      record: { graceUntil: GRACE, tmux: 'lineage-x' },
      killResult: false,
    });
    await h.run(COMMANDS.closeSession);
    expect(h.order[0]).toBe('killDetached');
    expect(h.patches.some((p) => typeof p.patch.closed === 'string')).toBe(true);
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
    over: {
      /** Account routing the launch resolves BEFORE the delegation gate. */
      accounts?: AccountDeps;
      /** The pure "which delegate is configured" read the refusal note uses.
       *  Absent everywhere the note is not under test — an old wiring. */
      delegateNewInfo?: () => { label: string } | null;
    } = {},
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
      ...(over.accounts === undefined ? {} : { accounts: over.accounts }),
      ...(over.delegateNewInfo === undefined
        ? {}
        : { delegateNewInfo: over.delegateNewInfo }),
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

  // ---- the routing gate: hosts.delegateRefusal, driven through the flow.
  //
  // Routing resolves BEFORE the handover, and a routing the delegate cannot
  // honour keeps the launch here. The delegate runs on the machine's own
  // default login: handing it a Codex-routed conversation would open the
  // wrong CLI, and handing it one routed to an account with its own config
  // directory would open a session that LOOKS routed in the tree while its
  // transcript lands where that account's next resume will never look.

  it('is never asked for a conversation routed to a Codex account', async () => {
    const { accounts } = fakeAccountDeps(
      [accountProfile('codex-work', { provider: 'codex', label: 'Work (Codex)' })],
      { defaultRouting: () => ({ kind: 'account', id: 'codex-work' }) },
    );
    const h = delegateHarness({ label: 'Claude Code extension' }, { accounts });
    await h.run(COMMANDS.newSessionInProject, { type: 'project', projectId: 'api' });
    expect(h.asked).toEqual([]); // never handed over
    expect(h.launches).toHaveLength(1); // Flock's own terminal opened instead
    expect(h.launches[0]?.provider).toBe('codex'); // ...as routed
    expect(h.launches[0]?.profileId).toBe('codex-work');
  });

  it('is never asked when the routed account pins its own config directory', async () => {
    const { accounts } = fakeAccountDeps(
      [accountProfile('work', { configDir: '/work/.claude' })],
      { defaultRouting: () => ({ kind: 'account', id: 'work' }) },
    );
    const h = delegateHarness({ label: 'Claude Code extension' }, { accounts });
    await h.run(COMMANDS.newSessionInProject, { type: 'project', projectId: 'api' });
    expect(h.asked).toEqual([]);
    expect(h.launches).toHaveLength(1);
    expect(h.launches[0]?.env?.CLAUDE_CONFIG_DIR).toBe('/work/.claude');
  });

  it('still takes a launch routed to the default account — exactly what it runs anyway', async () => {
    const { accounts } = fakeAccountDeps(
      [accountProfile('default-login')], // no configDir, no extraEnv
      { defaultRouting: () => ({ kind: 'account', id: 'default-login' }) },
    );
    const h = delegateHarness({ label: 'Claude Code extension' }, { accounts });
    await h.run(COMMANDS.newSessionInProject, { type: 'project', projectId: 'api' });
    expect(h.asked).toHaveLength(1);
    expect(h.launches).toEqual([]);
  });

  it('says in the status bar why the routed launch opened here', async () => {
    const { accounts } = fakeAccountDeps(
      [accountProfile('codex-work', { provider: 'codex', label: 'Work (Codex)' })],
      { defaultRouting: () => ({ kind: 'account', id: 'codex-work' }) },
    );
    const h = delegateHarness(
      { label: 'Claude Code extension' },
      { accounts, delegateNewInfo: () => ({ label: 'Claude Code extension' }) },
    );
    await h.run(COMMANDS.newSessionInProject, { type: 'project', projectId: 'api' });
    expect(h.said[0]).toContain('opened here');
    expect(h.said[0]).toContain('Work (Codex)');
    expect(h.said[0]).toContain('Claude Code extension');
  });

  it('keeps the refusal silent in flock mode, where opening here is not news', async () => {
    const { accounts } = fakeAccountDeps(
      [accountProfile('codex-work', { provider: 'codex', label: 'Work (Codex)' })],
      { defaultRouting: () => ({ kind: 'account', id: 'codex-work' }) },
    );
    const h = delegateHarness(null, {
      accounts,
      delegateNewInfo: () => null,
    });
    await h.run(COMMANDS.newSessionInProject, { type: 'project', projectId: 'api' });
    expect(h.said).toEqual([]);
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
// `lineage.launch.mode`, the RESUME half: a plain resume of an unpinned
// Claude conversation is handed to the delegate's open-session command, which
// resumes it in the official extension's own UI. What is pinned here is the
// boundary: which resumes are handed over, and which stay Flock's own.

describe('resume hands a plain reopen to the launch delegate', () => {
  const SESSION = uuid(5);

  function delegatedResumeHarness(
    over: {
      delegate?: { label: string } | null | 'throws' | 'unwired';
      hasTranscript?: boolean;
      pinnedTo?: { id: string; configDir?: string };
    } = {},
  ) {
    const asked: string[] = [];
    const delegateOver = over.delegate;
    const { deps, calls } = chatDeps(undefined, {
      hasTranscript: () => over.hasTranscript ?? true,
    });
    const profiles =
      over.pinnedTo === undefined
        ? []
        : [
            accountProfile(over.pinnedTo.id, {
              ...(over.pinnedTo.configDir === undefined
                ? {}
                : { configDir: over.pinnedTo.configDir }),
            }),
          ];
    const { accounts } = fakeAccountDeps(profiles, {
      sessionProfileId: (id) =>
        id === SESSION ? over.pinnedTo?.id : undefined,
    });
    const harness: AccountCommandDeps = {
      ...deps,
      accounts,
      getForest: () =>
        forestOf([
          node(SESSION, { archived: true, status: 'exited', cwd: '/code/api' }),
        ]),
      launchSession: async (opts) => {
        calls.launches.push(opts);
        return {
          nodeId: opts.sessionId,
          sessionId: opts.sessionId,
          terminalName: 'claude',
          createdAt: 0,
        };
      },
      ...(delegateOver === 'unwired'
        ? {}
        : {
            delegateOpenSession: async (sessionId: string) => {
              asked.push(sessionId);
              if (delegateOver === 'throws') throw new Error('gone');
              return delegateOver ?? null;
            },
          }),
    };
    return { deps: harness, calls, asked };
  }

  it('opens no terminal of its own when the delegate took the reopen — and un-closes the record', async () => {
    const h = delegatedResumeHarness({
      delegate: { label: 'Claude Code extension' },
    });
    expect(await resumeFlow(h.deps, SESSION)).toBe(true);
    expect(h.asked).toEqual([SESSION]);
    expect(h.calls.launches).toEqual([]);
    // The same record the launch path writes: the tab is back — in the
    // delegate's UI, but back.
    const patch = h.calls.records.find((r) => r.id === SESSION)?.patch;
    expect(patch?.closed).toBeNull();
    expect(patch?.graceUntil).toBeNull();
  });

  it('launches here when the delegate declines, throws, or is unwired', async () => {
    for (const delegate of [null, 'throws', 'unwired'] as const) {
      const h = delegatedResumeHarness({ delegate });
      expect(await resumeFlow(h.deps, SESSION)).toBe(true);
      expect(h.calls.launches).toHaveLength(1);
      expect(h.calls.launches[0]?.resumeId).toBe(SESSION);
    }
  });

  it('is not consulted for a COLD open — the flags it needs are not the delegate\'s to carry', async () => {
    const h = delegatedResumeHarness({
      delegate: { label: 'Claude Code extension' },
      hasTranscript: false,
    });
    expect(await resumeFlow(h.deps, SESSION)).toBe(true);
    expect(h.asked).toEqual([]);
    expect(h.calls.launches).toHaveLength(1);
    // A fresh start under the same id, exactly as before.
    expect(h.calls.launches[0]?.resumeId).toBeUndefined();
  });

  it('is not consulted when the account pin sets an environment — the delegate could not find the transcript', async () => {
    const h = delegatedResumeHarness({
      delegate: { label: 'Claude Code extension' },
      pinnedTo: { id: 'work', configDir: '/work/.claude' },
    });
    expect(await resumeFlow(h.deps, SESSION)).toBe(true);
    expect(h.asked).toEqual([]);
    expect(h.calls.launches).toHaveLength(1);
  });

  it('IS consulted for a pin that sets no environment — the default login can see that transcript', async () => {
    const h = delegatedResumeHarness({
      delegate: { label: 'Claude Code extension' },
      pinnedTo: { id: 'default' },
    });
    expect(await resumeFlow(h.deps, SESSION)).toBe(true);
    expect(h.asked).toEqual([SESSION]);
    expect(h.calls.launches).toEqual([]);
  });
});

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
    expect(patch).toMatchObject({ closed: null, graceUntil: null, tmux: null });
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

// ------------------------------------------ every git switch, in one verb

describe('Show / Hide Branches and Worktrees', () => {
  beforeEach(() => {
    (mockWindow as StatusHost).setStatusBarMessage = () => undefined;
    (mockWindow as QuickPickHost).showInformationMessage = async () => undefined;
  });
  afterEach(() => {
    delete (mockCommands as { registerCommand?: unknown }).registerCommand;
    delete (mockWindow as StatusHost).setStatusBarMessage;
    delete (mockWindow as QuickPickHost).showInformationMessage;
  });

  /** Both halves, and what each one said afterwards. */
  function switchHarness(over: Partial<AccountCommandDeps> = {}): {
    written: boolean[];
    messages: string[];
    status: string[];
    run: (command: string) => Promise<void>;
  } {
    const written: boolean[] = [];
    const messages: string[] = [];
    const status: string[] = [];
    (mockWindow as QuickPickHost).showInformationMessage = async (message) => {
      messages.push(message);
      return undefined;
    };
    (mockWindow as StatusHost).setStatusBarMessage = (text) => {
      status.push(text);
    };
    const { deps } = chatDeps(undefined);
    const harness = withRegisteredCommands({
      ...deps,
      setBranchAndWorktreeFeatures: async (on: boolean) => {
        written.push(on);
      },
      ...over,
    });
    return { written, messages, status, run: (command) => harness.run(command) };
  }

  it('writes the four on, and back off again, from one call each', async () => {
    const h = switchHarness();
    await h.run(COMMANDS.showBranchesAndWorktrees);
    await h.run(COMMANDS.hideBranchesAndWorktrees);
    // The pair is an inverse, and neither half reads the current value first:
    // each knows the value it means, like every other switch in this file.
    expect(h.written).toEqual([true, false]);
  });

  it('says out loud that it turned the network one on', async () => {
    // The receipt is the whole reason ON uses a message where every other
    // toggle flashes the status bar: `gh pr list` reaches the network, which is
    // a thing Flock otherwise never does unasked, and a person who typed "show
    // branches" has not read the settings for it. The other three announce
    // themselves the moment the tree redraws; the network does not.
    const h = switchHarness();
    await h.run(COMMANDS.showBranchesAndWorktrees);
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]).toContain('gh pr list');
    expect(h.messages[0]).toContain('two lines');
    // And it names the way back, since four settings is not something anybody
    // will undo by hand.
    expect(h.messages[0]).toContain('Hide Branches and Worktrees');
    expect(h.status).toEqual([]);
  });

  it('flashes and goes on the way out', async () => {
    const h = switchHarness();
    await h.run(COMMANDS.hideBranchesAndWorktrees);
    expect(h.status).toHaveLength(1);
    expect(h.messages).toEqual([]);
  });

  it('stays registered, and silent, on a wiring that cannot write settings', async () => {
    // The dep is optional (an older host, every unit double). The command must
    // still exist — "command not found" from the palette is worse than a verb
    // that does nothing — and must not claim to have changed anything.
    const h = switchHarness({ setBranchAndWorktreeFeatures: undefined });
    await h.run(COMMANDS.showBranchesAndWorktrees);
    await h.run(COMMANDS.hideBranchesAndWorktrees);
    expect(h.written).toEqual([]);
    expect(h.messages).toEqual([]);
    expect(h.status).toEqual([]);
  });
});

// ------------------------------------------------ the branch name as a link

describe('opening a branch on its remote', () => {
  afterEach(() => {
    delete (mockCommands as { registerCommand?: unknown }).registerCommand;
    delete (mockWindow as InfoHost).showInformationMessage;
    delete (mockEnv as ExternalHost).openExternal;
  });

  const ARG = {
    type: 'branch',
    projectId: 'p1',
    dir: '/Users/a/code/magma-feat-x',
    branch: 'feat/x',
  };

  function harness(
    over: {
      upstream?: string;
      status?: boolean;
      remoteUrl?: string;
    } = {},
  ): {
    opened: string[];
    said: string[];
    asked: Array<{ dir: string; remote: string }>;
    run: (command: string, arg?: unknown) => Promise<void>;
  } {
    const opened: string[] = [];
    const said: string[] = [];
    const asked: Array<{ dir: string; remote: string }> = [];
    (mockWindow as InfoHost).showInformationMessage = async (message: string) => {
      said.push(message);
      return undefined;
    };
    (mockEnv as ExternalHost).openExternal = async (uri: { toString(): string }) => {
      opened.push(String(uri));
      return true;
    };
    const { deps } = chatDeps(projectOf());
    const h = withRegisteredCommands({
      ...deps,
      getProject: () => projectOf(),
      getBranches: () => [
        {
          name: 'feat/x',
          dir: '/Users/a/code/magma-feat-x',
          colorIndex: 0,
          rootIds: [],
          primary: false,
          shown: true,
        },
      ],
      branchStatusOf: () =>
        over.status === false
          ? undefined
          : {
              branch: 'feat/x',
              upstream: over.upstream ?? 'origin/feat/x',
              ahead: 0,
              behind: 0,
              dirty: false,
              untracked: false,
            },
      remoteUrlOf: async (dir, remote) => {
        asked.push({ dir, remote });
        return over.remoteUrl ?? 'git@github.com:acme/app.git';
      },
    });
    return { opened, said, asked, run: (command, arg) => h.run(command, arg) };
  }

  it('builds the page out of the upstream and the remote, and opens it', async () => {
    const h = harness();
    await h.run(COMMANDS.openBranchOnRemote, ARG);
    // The remote is read in the CHECKOUT, and named by the upstream rather than
    // assumed to be `origin`.
    expect(h.asked).toEqual([
      { dir: '/Users/a/code/magma-feat-x', remote: 'origin' },
    ]);
    expect(h.opened).toEqual(['https://github.com/acme/app/tree/feat/x']);
    expect(h.said).toEqual([]);
  });

  it('follows the upstream when it is not the local name', async () => {
    // A branch checked out as `feat/x` and pushed as `axel/feat/x` has a page at
    // the second name only. Guessing the local one would open a 404 that looks
    // like the extension being wrong about the branch.
    const h = harness({ upstream: 'fork/axel/feat/x' });
    await h.run(COMMANDS.openBranchOnRemote, ARG);
    expect(h.asked[0].remote).toBe('fork');
    expect(h.opened).toEqual(['https://github.com/acme/app/tree/axel/feat/x']);
  });

  it('says so, and asks nothing, for a branch that tracks nothing', async () => {
    const h = harness({ upstream: '' });
    await h.run(COMMANDS.openBranchOnRemote, ARG);
    expect(h.opened).toEqual([]);
    expect(h.asked).toEqual([]);
    expect(h.said[0]).toContain('no upstream');
  });

  it('says so for an unprobed branch too, rather than guessing origin', async () => {
    const h = harness({ status: false });
    await h.run(COMMANDS.openBranchOnRemote, ARG);
    expect(h.opened).toEqual([]);
    expect(h.said).toHaveLength(1);
  });

  it('opens nothing when the remote is not a url it can turn into a page', async () => {
    const h = harness({ remoteUrl: '/srv/git/app.git' });
    await h.run(COMMANDS.openBranchOnRemote, ARG);
    expect(h.opened).toEqual([]);
    expect(h.said[0]).toContain('origin');
  });
});

// ------------------------------- the + that cuts a worktree, and the ref's +

describe('starting a session on a branch that has no checkout', () => {
  afterEach(() => {
    delete (mockCommands as { registerCommand?: unknown }).registerCommand;
    delete (mockWindow as WarningHost).showWarningMessage;
    delete (mockWindow as StatusHost).setStatusBarMessage;
  });

  const REF = { projectId: 'p1', dir: '', branch: 'feat/y', type: 'branch' };

  /** Records the modal without answering it, which is enough to prove WHICH
   *  flow the click reached: the worktree one asks before it writes. */
  function harness(branches: Array<{ name: string; dir: string }>): {
    asked: string[];
    run: (command: string, arg?: unknown) => Promise<void>;
  } {
    const asked: string[] = [];
    (mockWindow as WarningHost).showWarningMessage = async (
      message: string,
    ) => {
      asked.push(message);
      return undefined; // dismissed — nothing is created
    };
    (mockWindow as StatusHost).setStatusBarMessage = () => undefined;
    const { deps } = chatDeps(projectOf());
    const h = withRegisteredCommands({
      ...deps,
      getProject: () => projectOf(),
      getBranches: () =>
        branches.map((b) => ({
          name: b.name,
          dir: b.dir,
          colorIndex: 0,
          rootIds: [],
          primary: false,
          shown: true,
        })),
      localBranches: async () => ['feat/y'],
      worktreePathPattern: () => '../${repo}-${branch}',
      addWorktree: async () => ({ ok: true, output: '' }),
    });
    return { asked, run: (command, arg) => h.run(command, arg) };
  }

  it('asks before it writes, quoting the git command', async () => {
    const h = harness([
      { name: 'main', dir: '/Users/a/code/magma' },
      { name: 'feat/y', dir: '' },
    ]);
    await h.run(COMMANDS.newSessionInBranch, REF);
    // The confirmation is the whole reason this verb can live on a `+`: nothing
    // is created without the exact command being shown first.
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toContain('feat/y');
  });

  it('refuses a branch the grouping no longer reports', async () => {
    // The same re-validation the checkout path does, on the field a ref has:
    // its NAME. A stale row must not be able to name a branch into existence.
    const h = harness([{ name: 'main', dir: '/Users/a/code/magma' }]);
    await h.run(COMMANDS.newSessionInBranch, REF);
    // It says so rather than doing nothing, and what it says is not a
    // confirmation: no `git worktree add` was ever offered.
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toContain('no longer a branch');
  });
});

// --------------------------------------------------- add / import sessions
//
// The two doors of the clean-slate default: with `lineage.showForeignSessions`
// off nothing reaches the tree until the user launches it in Flock or names it
// here, and these flows are the naming. Both write records — presence IS
// membership (archive.memberKeepIds) — and neither ever writes a filing:
// where a row lands stays derived from its own cwd.
describe('the add / import flows', () => {
  const S1 = '0a00000 1-0000-4000-8000-000000000001'.replace(' ', '');
  const S2 = '0a000002-0000-4000-8000-000000000002';
  const S3 = '0a000003-0000-4000-8000-000000000003';

  interface PoolCalls {
    upserts: { id: string; patch: Partial<EditorialRecord> }[];
    refreshes: number;
    reveals: string[];
    infos: string[];
    warnings: string[];
    /** The recommended setup's two side effects, in the order they landed. */
    settings: { key: string; value: boolean | string | undefined }[];
    installs: string[];
    projectDirs: string[];
  }

  function poolDeps(over: {
    pool?: UnlistedSession[];
    projects?: ProjectRecord[];
    forest?: SessionForest;
    hasTranscript?: (id: string) => boolean;
    tipOf?: (id: string) => string;
    /** null = a wiring that cannot answer, which is what an older host and
     *  every double that does not care about the setup looks like. */
    world?: RecommendedWorld | null;
    /** Keys `writeSettings` should report it could not write. */
    unwritable?: string[];
    /** What the two installers report back. Declining the consent modal is
     *  `installed: false`, which is an answer rather than a failure. */
    hooksInstall?: boolean;
    verbsInstall?: boolean;
  } = {}): { deps: CommandDeps; calls: PoolCalls } {
    const calls: PoolCalls = {
      upserts: [],
      refreshes: 0,
      reveals: [],
      infos: [],
      warnings: [],
      settings: [],
      installs: [],
      projectDirs: [],
    };
    const nope = (): never => {
      throw new Error('not used by the add/import flows');
    };
    const projects = over.projects ?? [];
    const deps: CommandDeps = {
      getForest: () => over.forest ?? forestOf([]),
      refresh: () => {
        calls.refreshes += 1;
      },
      hasTranscript: over.hasTranscript ?? (() => false),
      tipOf: over.tipOf ?? ((id) => id),
      beginInlineRename: async () => false,
      beginInlineRenameProject: async () => false,
      revealSession: async (id) => {
        calls.reveals.push(id);
      },
      focusSessionsView: async () => true,
      revealProject: async (id) => {
        calls.reveals.push(id);
      },
      getRecord: () => undefined,
      allRecords: () => ({}),
      upsertRecord: async (id, patch) => {
        calls.upserts.push({ id, patch });
      },
      recordLaunch: nope,
      launchSession: nope,
      focusSession: () => false,
      renameTerminal: async () => false,
      sendTextToSession: () => false,
      closeTerminal: () => false,
      focusWindowFor: async () => false,
      openProject: async () => undefined,
      installHooks: async () => {
        calls.installs.push('hooks');
        return { installed: over.hooksInstall ?? true };
      },
      removeHooks: nope,
      getHookState: () => ({ installed: false }),
      setHooksEnabled: async (enabled) => {
        calls.installs.push(`hooks.enabled=${String(enabled)}`);
      },
      installAgentVerbs: async () => {
        calls.installs.push('verbs');
        return { installed: over.verbsInstall ?? true };
      },
      setAgentVerbsEnabled: async (enabled) => {
        calls.installs.push(`verbs.enabled=${String(enabled)}`);
      },
      recommendedWorld:
        over.world === null ? undefined : async () => over.world ?? settledWorld,
      writeSettings: async (entries) => {
        for (const entry of entries) calls.settings.push({ ...entry });
        return (over.unwritable ?? []).filter((k) =>
          entries.some((e) => e.key === k),
        );
      },
      allProjects: () => projects,
      getProject: (id) => projects.find((p) => p.id === id),
      getBranches: () => [],
      setBranchShown: async () => undefined,
      setBranchesShown: async () => undefined,
      upsertProject: async (_id, patch) => {
        const dir = (patch as { rootDir?: string }).rootDir;
        if (dir !== undefined) calls.projectDirs.push(dir);
      },
      setProjectParent: async () => true,
      deleteProject: async () => undefined,
      hiddenFolders: () => [],
      hideFolder: async () => undefined,
      unhideFolder: async () => undefined,
      unlistedSessions: () => over.pool ?? [],
      markSeen: async () => undefined,
      notificationsEnabled: () => true,
      setOnlyActiveSessions: async () => undefined,
      setAccountsSection: async () => undefined,
      setShellsSection: async () => undefined,
      setBranchDisplay: async () => undefined,
      selectedSessions: () => [],
      switchWorkspace: async () => undefined,
      activeWorkspace: () => null,
    };
    return { deps, calls };
  }

  function project(id: string, rootDir: string, name = 'api'): ProjectRecord {
    return {
      id,
      name,
      rootDir,
      dirs: [],
      createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z',
    };
  }

  type Host = {
    showQuickPick?: (items: unknown, opts?: unknown) => Promise<unknown>;
    showInputBox?: (opts?: unknown) => Promise<string | undefined>;
    showInformationMessage?: (
      message: string,
      ...rest: unknown[]
    ) => Promise<string | undefined>;
    showWarningMessage?: (
      message: string,
      ...rest: unknown[]
    ) => Promise<string | undefined>;
  };
  const host = mockWindow as Host;

  /** Answers each quick pick in turn: by label, by index, or — for the
   *  multi-pick — with a label array. undefined cancels. Also records what was
   *  offered, because "the picker only offered the project's own sessions" is
   *  half of what these tests assert. */
  function scriptPicks(...answers: (string | string[] | undefined)[]): {
    offered: string[][];
    many: boolean[];
    /** Which rows arrived TICKED. The recommended setup's whole claim is that
     *  the defaults are considered, so what it pre-ticks is an assertion. */
    picked: string[][];
  } {
    const state = {
      offered: [] as string[][],
      many: [] as boolean[],
      picked: [] as string[][],
    };
    let at = 0;
    host.showQuickPick = async (items: unknown, opts?: unknown) => {
      const list = (Array.isArray(items) ? items : []) as {
        label?: string;
        kind?: number;
        picked?: boolean;
      }[];
      const rows = list.filter((i) => i.kind === undefined);
      state.offered.push(rows.map((i) => i.label ?? ''));
      state.picked.push(
        rows.filter((i) => i.picked === true).map((i) => i.label ?? ''),
      );
      state.many.push(
        (opts as { canPickMany?: boolean } | undefined)?.canPickMany === true,
      );
      const want = answers[at];
      at += 1;
      if (want === undefined) return undefined;
      if (Array.isArray(want)) {
        return rows.filter((i) => want.includes(i.label ?? ''));
      }
      return rows.find((i) => i.label === want);
    };
    return state;
  }

  function scriptInput(value: string | undefined): void {
    host.showInputBox = async () => value;
  }

  let saidInfo: string[];
  let saidWarning: string[];
  let warningAnswer: string | undefined;

  beforeEach(() => {
    saidInfo = [];
    saidWarning = [];
    warningAnswer = undefined;
    host.showInformationMessage = async (message) => {
      saidInfo.push(message);
      return undefined;
    };
    host.showWarningMessage = async (message) => {
      saidWarning.push(message);
      return warningAnswer;
    };
  });

  afterEach(() => {
    delete host.showQuickPick;
    delete host.showInputBox;
    delete host.showInformationMessage;
    delete host.showWarningMessage;
  });

  const pooled = (
    id: string,
    over: Partial<UnlistedSession> = {},
  ): UnlistedSession => ({ sessionId: id, live: false, ...over });

  /** A machine with nothing left to recommend — except the surface question,
   *  which is on every plan. Each setup test moves exactly the fields it is
   *  about, so what it is testing is what it changed. */
  const settledWorld: RecommendedWorld = {
    platform: 'darwin',
    tmuxBinary: '/opt/homebrew/bin/tmux',
    tmuxMode: 'auto',
    hooksInstalled: true,
    verbsInstalled: true,
    verbsAvailable: true,
    hasProjects: true,
    unlistedCount: 0,
    branchRowsEnabled: false,
    maxWorktrees: 1,
    terminalLocation: 'editor',
    soloSession: false,
    launchMode: 'flock',
    claudeExtensionInstalled: false,
    mode: undefined,
    workspacesEnabled: true,
  };

  describe('addSessionToProjectFlow', () => {
    it('offers only the sessions this project claims, and adopting one writes cwd', async () => {
      const p = project('p1', '/w/api');
      const { deps, calls } = poolDeps({
        pool: [
          pooled(S1, { cwd: '/w/api/sub', label: 'the rewrite', endedAt: 1 }),
          pooled(S2, { cwd: '/elsewhere', label: 'not ours' }),
        ],
        projects: [p],
      });
      const picks = scriptPicks('$(archive) the rewrite');
      await addSessionToProjectFlow(deps, 'p1');
      // The out-of-project session was never offered — the picker's promise
      // and the grouping's answer are the same matchProject call.
      expect(picks.offered[0]!.join('|')).toContain('the rewrite');
      expect(picks.offered[0]!.join('|')).not.toContain('not ours');
      expect(calls.upserts).toEqual([
        { id: S1, patch: { deleted: false, cwd: '/w/api/sub' } },
      ]);
      expect(calls.refreshes).toBe(1);
      expect(calls.reveals).toEqual([S1]);
    });

    it('a nested project owns its directory — the longest match wins here too', async () => {
      const outer = project('p1', '/w', 'code');
      const inner = project('p2', '/w/api');
      const { deps, calls } = poolDeps({
        pool: [pooled(S1, { cwd: '/w/api/x', label: 'inner session' })],
        projects: [outer, inner],
      });
      scriptPicks(undefined);
      scriptInput(undefined); // the empty-list fallback is the id input box
      await addSessionToProjectFlow(deps, 'p1');
      // Offered nothing for the OUTER project (its only candidate belongs to
      // the inner one), so the flow fell through to the id box, was cancelled,
      // and wrote nothing.
      expect(calls.upserts).toEqual([]);
    });

    it('Add all adopts every candidate and says how many', async () => {
      const p = project('p1', '/w/api');
      const { deps, calls } = poolDeps({
        pool: [
          pooled(S1, { cwd: '/w/api/a', endedAt: 2 }),
          pooled(S2, { cwd: '/w/api/b', endedAt: 1 }),
        ],
        projects: [p],
      });
      scriptPicks('$(cloud-download) Add all 2 sessions');
      await addSessionToProjectFlow(deps, 'p1');
      expect(calls.upserts.map((u) => u.id).sort()).toEqual([S1, S2]);
      expect(calls.reveals).toEqual(['p1']);
      expect(saidInfo.join(' ')).toContain('added 2 sessions');
    });

    it('a typed id that is already in the tree reveals instead of duplicating', async () => {
      const p = project('p1', '/w/api');
      const { deps, calls } = poolDeps({
        pool: [],
        projects: [p],
        forest: forestOf([node(S3)]),
      });
      scriptInput(S3);
      await addSessionToProjectFlow(deps, 'p1');
      expect(calls.upserts).toEqual([]);
      expect(calls.reveals).toEqual([S3]);
      expect(saidInfo.join(' ')).toContain('already in the tree');
    });

    it('a typed id nothing backs warns, and only Add Anyway proceeds', async () => {
      const p = project('p1', '/w/api');
      const first = poolDeps({ pool: [], projects: [p] });
      scriptInput(S3);
      warningAnswer = undefined; // dismissed
      await addSessionToProjectFlow(first.deps, 'p1');
      expect(saidWarning.join(' ')).toContain('nothing on this machine');
      expect(first.calls.upserts).toEqual([]);

      const second = poolDeps({ pool: [], projects: [p] });
      warningAnswer = 'Add Anyway';
      await addSessionToProjectFlow(second.deps, 'p1');
      expect(second.calls.upserts).toEqual([
        { id: S3, patch: { deleted: false } },
      ]);
    });

    it('a typed id whose directory files elsewhere says so', async () => {
      const home = project('p1', '/w/api');
      const other = project('p2', '/w/web', 'web');
      const { deps, calls } = poolDeps({
        pool: [pooled(S3, { cwd: '/w/web/x', label: 'webby' })],
        projects: [home, other],
      });
      // Nothing of p1's in the pool -> straight to the id box.
      scriptInput(S3);
      await addSessionToProjectFlow(deps, 'p1');
      expect(calls.upserts).toEqual([
        { id: S3, patch: { deleted: false, cwd: '/w/web/x' } },
      ]);
      // Membership is derived; the flow must not pretend the click filed it.
      expect(saidInfo.join(' ')).toContain('"web"');
    });
  });

  describe('importSessionsFlow', () => {
    it('says when there is nothing to import, and writes nothing', async () => {
      const { deps, calls } = poolDeps({ pool: [] });
      await importSessionsFlow(deps);
      expect(saidInfo.join(' ')).toContain('nothing to import');
      expect(calls.upserts).toEqual([]);
      expect(calls.refreshes).toBe(0);
    });

    it('Import all adopts the whole pool, cwd and all', async () => {
      const { deps, calls } = poolDeps({
        pool: [
          pooled(S1, { cwd: '/w/api', endedAt: 2 }),
          pooled(S2, { cwd: '/w/web', endedAt: 1 }),
        ],
      });
      scriptPicks('$(cloud-download) Import all 2 sessions');
      await importSessionsFlow(deps);
      expect(calls.upserts).toEqual([
        { id: S1, patch: { deleted: false, cwd: '/w/api' } },
        { id: S2, patch: { deleted: false, cwd: '/w/web' } },
      ]);
      expect(calls.refreshes).toBe(1);
      expect(saidInfo.join(' ')).toContain('imported 2 sessions');
    });

    it('Choose imports exactly what was ticked', async () => {
      const { deps, calls } = poolDeps({
        pool: [
          pooled(S1, { cwd: '/w/api', label: 'keep me', endedAt: 2 }),
          pooled(S2, { cwd: '/w/web', label: 'leave me', endedAt: 1 }),
        ],
      });
      const picks = scriptPicks(
        '$(checklist) Choose which sessions to import…',
        ['$(archive) keep me'],
      );
      await importSessionsFlow(deps);
      // The second pick was the multi-select.
      expect(picks.many).toEqual([false, true]);
      expect(calls.upserts).toEqual([
        { id: S1, patch: { deleted: false, cwd: '/w/api' } },
      ]);
      expect(saidInfo.join(' ')).toContain('imported 1 session');
    });

    it('cancelling either step imports nothing', async () => {
      const { deps, calls } = poolDeps({
        pool: [pooled(S1, { cwd: '/w/api' })],
      });
      scriptPicks(undefined);
      await importSessionsFlow(deps);
      expect(calls.upserts).toEqual([]);

      scriptPicks('$(checklist) Choose which sessions to import…', []);
      await importSessionsFlow(deps);
      expect(calls.upserts).toEqual([]);
      expect(calls.refreshes).toBe(0);
    });
  });

  // ------------------------------------------------------ recommended setup
  //
  // The third door of the same problem, and the widest: the clean slate decides
  // what is IN the tree, and this decides what is switched ON around it. What is
  // offered is `recommendedPlan`'s (test/recommend.test.ts); what is asserted
  // here is that a tick becomes exactly the side effect it promised, that an
  // untick becomes none, and that one step saying no does not silence the rest.
  describe('recommendedSetupFlow', () => {
    const HOOKS = 'Instant updates (hooks)';
    const VERBS = 'Let Claude fork its own sessions';
    const PROJECT = 'Make your first project';
    const BRANCHES = 'Show branch and worktree rows';
    const SURFACE = 'Choose where sessions open';
    const WINDOW_MODEL = 'Choose what a window is';

    beforeEach(() => {
      // newProjectFlow names the project it just made, and falls back to this
      // command when there is no inline rename to run.
      (mockCommands as { executeCommand?: unknown }).executeCommand =
        async () => undefined;
    });

    afterEach(() => {
      delete (mockCommands as { executeCommand?: unknown }).executeCommand;
      delete (mockWindow as { showOpenDialog?: unknown }).showOpenDialog;
    });

    it('says so, and asks nothing, where the wiring cannot answer', async () => {
      const { deps, calls } = poolDeps({ world: null });
      const asked = scriptPicks();
      await recommendedSetupFlow(deps);
      expect(asked.offered).toEqual([]);
      expect(saidInfo.join(' ')).toContain('not available in this window');
      expect(calls.settings).toEqual([]);
    });

    it('still asks the two taste questions on a machine with nothing else to do, and the receipt carries the notes', async () => {
      // The old "everything recommended is already set up" outcome is gone on
      // purpose: neither taste step has an "already done", so even a settled
      // machine is offered the checklist — with exactly those two rows on it —
      // and the notes ride the receipt.
      const { deps, calls } = poolDeps({
        world: { ...settledWorld, tmuxBinary: null },
      });
      const asked = scriptPicks([SURFACE], 'Editor tabs (current)');
      await recommendedSetupFlow(deps);
      expect(asked.offered[0]).toEqual([SURFACE, WINDOW_MODEL]);
      // Choosing an option — even the current one — writes it, explicitly.
      expect(calls.settings).toEqual([
        { key: 'terminalLocation', value: 'editor' },
        { key: 'soloSession', value: false },
        { key: 'launch.mode', value: 'flock' },
      ]);
      // The one thing it cannot do for you is still said.
      expect(saidInfo.join(' ')).toContain('tmux is not installed');
      expect(saidInfo.join(' ')).toContain('choose differently');
    });

    it('ticks what recommendedPlan recommends, and leaves the rest alone', async () => {
      const { deps } = poolDeps({
        world: { ...settledWorld, hooksInstalled: false, maxWorktrees: 3 },
      });
      const asked = scriptPicks(undefined);
      await recommendedSetupFlow(deps);
      expect(asked.many).toEqual([true]);
      expect(asked.offered[0]).toEqual([SURFACE, WINDOW_MODEL, HOOKS, BRANCHES]);
      expect(asked.picked[0]).toEqual([SURFACE, WINDOW_MODEL, HOOKS]);
    });

    it('opens the three window models, cursor on the one you are in', async () => {
      // The taste contract again: the tick opens the question, the OPTION
      // writes. `folder` alone here, because that is the whole of what the
      // Flock-only and one-folder-per-project answers move.
      const { deps, calls } = poolDeps({
        world: { ...settledWorld, mode: 'root' },
      });
      const asked = scriptPicks([WINDOW_MODEL], 'One folder per project');
      await recommendedSetupFlow(deps);
      expect(asked.offered[1]).toEqual([
        'One folder per project',
        'Flock only (current)',
        'Auto-switch',
      ]);
      expect(calls.settings).toEqual([{ key: 'mode', value: 'folder' }]);
    });

    it('untangles the legacy pair when auto-switch is chosen', async () => {
      // A user carrying `workspaces.enabled: false` is shown as Flock only —
      // which is what their window has always been — and choosing Auto-switch
      // has to write BOTH keys, or `resolveMode` would fold them straight back
      // with nothing on screen to explain it. The retired `autoSwitch` key
      // folds the same way, so the same choice deletes it (value undefined).
      const { deps, calls } = poolDeps({
        world: { ...settledWorld, mode: 'project', workspacesEnabled: false },
      });
      const asked = scriptPicks([WINDOW_MODEL], 'Auto-switch');
      await recommendedSetupFlow(deps);
      expect(asked.offered[1]).toContain('Flock only (current)');
      expect(calls.settings).toEqual([
        { key: 'mode', value: 'project' },
        { key: 'workspaces.enabled', value: true },
        { key: 'workspaces.autoSwitch', value: undefined },
      ]);
    });

    it('writes nothing for a ticked window-model step whose picker was cancelled', async () => {
      const { deps, calls } = poolDeps({ world: settledWorld });
      scriptPicks([WINDOW_MODEL], undefined);
      await recommendedSetupFlow(deps);
      expect(calls.settings).toEqual([]);
      expect(saidInfo.join(' ')).toContain('nothing was changed');
    });

    it('is also a verb of its own, with a receipt naming the model', async () => {
      // The checklist asks this once, when somebody meets the product. The
      // standalone command is for the other moment — a month in, wanting a
      // different model — and it is the one that matters more, because the
      // route it replaces is knowing that the key is called `lineage.mode` and
      // that `project` is spelled that way while meaning "auto-switch".
      const said: string[] = [];
      (
        mockWindow as { setStatusBarMessage?: (t: string, ms?: number) => void }
      ).setStatusBarMessage = (text) => {
        said.push(text);
      };
      try {
        const { deps, calls } = poolDeps({ world: settledWorld });
        const asked = scriptPicks('Flock only');
        const harness = withRegisteredCommands(deps);
        await harness.run(COMMANDS.chooseWindowModel);
        expect(asked.offered[0]).toEqual([
          'One folder per project (current)',
          'Flock only',
          'Auto-switch',
        ]);
        expect(calls.settings).toEqual([{ key: 'mode', value: 'root' }]);
        // By its LABEL, not its value: the receipt has to be readable by the
        // same person the picker was.
        expect(said.join(' ')).toContain('Flock only');
        expect(calls.refreshes).toBeGreaterThan(0);
      } finally {
        delete (mockWindow as { setStatusBarMessage?: unknown })
          .setStatusBarMessage;
        delete (mockCommands as { registerCommand?: unknown }).registerCommand;
      }
    });

    it('writes nothing for a ticked surface step whose picker was cancelled', async () => {
      // The tick opened the question; only an ANSWER writes. Escape on the
      // four-way picker is "no", not an error, and the receipt says nothing
      // happened.
      const { deps, calls } = poolDeps({ world: settledWorld });
      scriptPicks([SURFACE], undefined);
      await recommendedSetupFlow(deps);
      expect(calls.settings).toEqual([]);
      expect(saidInfo.join(' ')).toContain('nothing was changed');
    });

    it('writes launch.mode ALONE for the extension option, installed or not', async () => {
      const { deps, calls } = poolDeps({ world: settledWorld });
      const asked = scriptPicks([SURFACE], 'Claude Code extension');
      await recommendedSetupFlow(deps);
      // The row is on offer even though the extension is missing — the
      // description says so, and the launcher already falls back.
      expect(asked.offered[1]).toContain('Claude Code extension');
      expect(calls.settings).toEqual([
        { key: 'launch.mode', value: 'claudeExtension' },
      ]);
    });

    it('suffixes the current arrangement, and moves off it when asked', async () => {
      const { deps, calls } = poolDeps({
        world: { ...settledWorld, soloSession: true },
      });
      const asked = scriptPicks([SURFACE], 'Bottom terminal panel');
      await recommendedSetupFlow(deps);
      expect(asked.offered[1]).toContain('One pinned session tab (current)');
      expect(calls.settings).toEqual([
        { key: 'terminalLocation', value: 'panel' },
        { key: 'soloSession', value: false },
        { key: 'launch.mode', value: 'flock' },
      ]);
    });

    it('installs and enables, in that order, for a ticked hooks step', async () => {
      const { deps, calls } = poolDeps({
        world: { ...settledWorld, hooksInstalled: false, verbsInstalled: false },
      });
      scriptPicks([HOOKS, VERBS]);
      await recommendedSetupFlow(deps);
      // Install is the opt-in: the plugin only makes Claude WRITE the events,
      // and the setting is the half that reads them.
      expect(calls.installs).toEqual([
        'hooks',
        'hooks.enabled=true',
        'verbs',
        'verbs.enabled=true',
      ]);
      expect(saidInfo.join(' ')).toContain('Remove Instant-Update Hooks');
    });

    it('does not enable a reader for an install the user declined', async () => {
      const { deps, calls } = poolDeps({
        world: { ...settledWorld, hooksInstalled: false },
        hooksInstall: false,
      });
      scriptPicks([HOOKS]);
      await recommendedSetupFlow(deps);
      // Declining the consent modal is an ANSWER: nothing installed, so nothing
      // to switch on, and the receipt must not claim it was set up.
      expect(calls.installs).toEqual(['hooks']);
      expect(saidInfo.join(' ')).toContain('nothing was changed');
    });

    it('writes a settings step from its own table', async () => {
      const { deps, calls } = poolDeps({
        world: { ...settledWorld, maxWorktrees: 4 },
      });
      scriptPicks([BRANCHES]);
      await recommendedSetupFlow(deps);
      expect(calls.settings).toEqual([{ key: 'git.branches', value: true }]);
      expect(saidInfo.join(' ')).toContain('Hide Branches and Worktrees');
    });

    it('names the keys it could not write, and claims nothing about them', async () => {
      const { deps } = poolDeps({
        world: { ...settledWorld, maxWorktrees: 4 },
        unwritable: ['git.branches'],
      });
      scriptPicks([BRANCHES]);
      await recommendedSetupFlow(deps);
      expect(saidInfo.join(' ')).toContain('Could not set up');
      expect(saidInfo.join(' ')).toContain('git.branches');
    });

    it('carries on past a step the user backed out of', async () => {
      const { deps, calls } = poolDeps({
        world: { ...settledWorld, hasProjects: false, hooksInstalled: false },
      });
      // The folder dialog cancelled: no project. The hooks step must still run.
      (mockWindow as { showOpenDialog?: unknown }).showOpenDialog =
        async () => undefined;
      scriptPicks([PROJECT, HOOKS]);
      await recommendedSetupFlow(deps);
      expect(calls.projectDirs).toEqual([]);
      expect(calls.installs).toEqual(['hooks', 'hooks.enabled=true']);
      expect(saidInfo.join(' ')).toContain(HOOKS);
    });

    it('makes the project when the dialog answers', async () => {
      const { deps, calls } = poolDeps({
        world: { ...settledWorld, hasProjects: false },
      });
      (mockWindow as { showOpenDialog?: unknown }).showOpenDialog = async () => [
        { fsPath: '/w/api' },
      ];
      scriptPicks([PROJECT]);
      await recommendedSetupFlow(deps);
      expect(calls.projectDirs).toEqual(['/w/api']);
      expect(calls.refreshes).toBeGreaterThan(0);
    });

    it('writes nothing when the checklist is cancelled or emptied', async () => {
      const { deps, calls } = poolDeps({
        world: { ...settledWorld, hooksInstalled: false, maxWorktrees: 4 },
      });
      scriptPicks(undefined);
      await recommendedSetupFlow(deps);
      scriptPicks([]);
      await recommendedSetupFlow(deps);
      expect(calls.installs).toEqual([]);
      expect(calls.settings).toEqual([]);
      // Not even a receipt: nothing happened, and saying so twice is noise.
      expect(saidInfo).toEqual([]);
    });
  });
});

// ------------------------------------------------- folder mode: route, never adopt
//
// A window in folder mode IS the folder it opened. A session living in another
// folder is another window's work: clicking or resuming it here must ROUTE —
// to the window that has it bound, else to a window on its folder, else to an
// OFFER of a new window — and never attach, adopt, fork or resume in place.
// The decision helpers are src/modes.ts; what is under test here is that the
// verbs actually stop at the fence.

describe('folder mode: foreign rows route to their own window', () => {
  afterEach(() => {
    delete (mockCommands as { registerCommand?: unknown }).registerCommand;
    delete (mockWindow as { showInformationMessage?: unknown })
      .showInformationMessage;
  });

  const SESSION = uuid(7);

  function routeHarness(over: {
    cwd?: string;
    choose?: string;
    focusWindowFor?: (id: string) => Promise<boolean>;
    focusWindowForDir?: (dir: string, id?: string) => Promise<boolean>;
  }): {
    told: string[];
    opened: Array<[string, boolean]>;
    calls: ChatCalls;
    run: (command: string, arg: string) => Promise<void>;
  } {
    const told: string[] = [];
    const opened: Array<[string, boolean]> = [];
    (
      mockWindow as {
        showInformationMessage?: (
          m: unknown,
          ...rest: unknown[]
        ) => Promise<unknown>;
      }
    ).showInformationMessage = async (message) => {
      told.push(String(message));
      return over.choose;
    };
    const other = projectOf({ id: 'p9', name: 'other', rootDir: '/code/other' });
    const { deps, calls } = chatDeps(undefined, { projects: [other] });
    const harness = withRegisteredCommands({
      ...deps,
      getForest: () =>
        forestOf([
          node(SESSION, {
            status: 'idle',
            cwd: over.cwd ?? '/code/other/task',
            roster: { sessionId: SESSION, pid: 4242 },
          }),
        ]),
      lineageMode: () => 'folder',
      scopeDirs: () => ['/code/app'],
      focusWindowFor: over.focusWindowFor ?? (async () => false),
      ...(over.focusWindowForDir === undefined
        ? {}
        : { focusWindowForDir: over.focusWindowForDir }),
      openProject: async (fsPath, newWindow) => {
        opened.push([fsPath, newWindow]);
      },
      markSeen: async () => undefined,
    });
    return { told, opened, calls, run: (c, a) => harness.run(c, a) };
  }

  it('routes to the window that has the session bound, and stops', async () => {
    const focused: string[] = [];
    const h = routeHarness({
      focusWindowFor: async (id) => {
        focused.push(id);
        return true;
      },
    });
    await h.run(COMMANDS.focusSession, SESSION);
    expect(focused).toEqual([SESSION]);
    expect(h.told).toEqual([]);
    expect(h.calls.launches).toEqual([]);
  });

  it('falls to the window whose folder covers the cwd', async () => {
    const routed: Array<[string, string | undefined]> = [];
    const h = routeHarness({
      focusWindowForDir: async (dir, id) => {
        routed.push([dir, id]);
        return true;
      },
    });
    await h.run(COMMANDS.focusSession, SESSION);
    // Routed by the session's OWN cwd — the deepest-folder resolver wants the
    // real path, not the project claim.
    expect(routed).toEqual([['/code/other/task', SESSION]]);
    expect(h.told).toEqual([]);
    expect(h.calls.launches).toEqual([]);
  });

  it('offers a NEW window on the owning claim — and never resumes here', async () => {
    const h = routeHarness({
      focusWindowForDir: async () => false,
      choose: 'Open in New Window',
    });
    await h.run(COMMANDS.focusSession, SESSION);
    // The offer names the project's claimed directory, and accepting opens
    // THAT in a new window: the new window's scope is the whole project.
    expect(h.told[0]).toContain('/code/other');
    expect(h.opened).toEqual([['/code/other', true]]);
    // Nothing was adopted in place: no launch, no fork dialog beyond the offer.
    expect(h.calls.launches).toEqual([]);
  });

  it('routes a RESUME too — level 2 elsewhere is still elsewhere', async () => {
    const routed: string[] = [];
    const h = routeHarness({
      focusWindowForDir: async (dir) => {
        routed.push(dir);
        return true;
      },
    });
    await h.run(COMMANDS.resumeSession, SESSION);
    expect(routed).toEqual(['/code/other/task']);
    expect(h.calls.launches).toEqual([]);
  });

  it('leaves an in-scope session to the ordinary tiers', async () => {
    const routed: string[] = [];
    const h = routeHarness({
      cwd: '/code/app/src',
      focusWindowForDir: async (dir) => {
        routed.push(dir);
        return true;
      },
    });
    await h.run(COMMANDS.focusSession, SESSION);
    // The fence did not fire; the flow fell through to the last-resort dialog
    // exactly as it does without a mode.
    expect(routed).toEqual([]);
    expect(h.told[0]).toContain('outside Flock');
  });
});

describe('folder mode: the switch verb refuses', () => {
  afterEach(() => {
    delete (mockCommands as { registerCommand?: unknown }).registerCommand;
    delete (mockWindow as { showInformationMessage?: unknown })
      .showInformationMessage;
  });

  it('refuses with directions instead of switching', async () => {
    const told: string[] = [];
    (
      mockWindow as { showInformationMessage?: (m: unknown) => Promise<unknown> }
    ).showInformationMessage = async (message) => {
      told.push(String(message));
      return undefined;
    };
    const switched: Array<string | null> = [];
    const { deps } = chatDeps(projectOf());
    const harness = withRegisteredCommands({
      ...deps,
      lineageMode: () => 'folder',
      switchWorkspace: async (projectId: string | null) => {
        switched.push(projectId);
      },
    });
    await harness.run(COMMANDS.switchWorkspace, {
      type: 'project',
      projectId: 'p1',
    });
    expect(switched).toEqual([]);
    // The message names the MODEL the way the picker does, points at the verb
    // that changes it, and still names the key for anybody who prefers the
    // settings file. It stopped saying "folder mode" because there are three
    // models now and only one of them is refusing.
    expect(told[0]).toContain('one folder per project');
    expect(told[0]).toContain('Choose Window Model');
    expect(told[0]).toContain('lineage.mode');
  });

  it('switches as before in project mode', async () => {
    const switched: Array<string | null> = [];
    const { deps } = chatDeps(projectOf());
    const harness = withRegisteredCommands({
      ...deps,
      lineageMode: () => 'project',
      switchWorkspace: async (projectId: string | null) => {
        switched.push(projectId);
      },
    });
    await harness.run(COMMANDS.switchWorkspace, {
      type: 'project',
      projectId: 'p1',
    });
    expect(switched).toEqual(['p1']);
  });

  it('switches in the Flock-only model too — it keeps the verb on purpose', async () => {
    // The migration's promise. `(mode: project, workspaces.enabled: false)`
    // resolves to `flock`, and that pair has always been able to switch on
    // purpose — it just never switched by itself. Narrowing this refusal to
    // `projectSwitchingOn` would take a working verb away from exactly the
    // population the fold was written to leave alone.
    const told: string[] = [];
    (
      mockWindow as { showInformationMessage?: (m: unknown) => Promise<unknown> }
    ).showInformationMessage = async (message) => {
      told.push(String(message));
      return undefined;
    };
    const switched: Array<string | null> = [];
    const { deps } = chatDeps(projectOf());
    const harness = withRegisteredCommands({
      ...deps,
      lineageMode: () => 'root',
      switchWorkspace: async (projectId: string | null) => {
        switched.push(projectId);
      },
    });
    await harness.run(COMMANDS.switchWorkspace, {
      type: 'project',
      projectId: 'p1',
    });
    expect(switched).toEqual(['p1']);
    expect(told).toEqual([]);
  });
});

// ------------------------------------------ converting a window to follow
//
// `lineage.followInExplorer` costs a RELOAD and buys a permanently visible
// anchor row, and what it buys back — a window that follows the session you are
// in — only exists in the auto-switch model. Converting a window that is not in
// that model is therefore the one outcome this verb must refuse, and the
// refusal has to name the fix rather than write it: `lineage.mode` has exactly
// one writer, and a second would be a second answer to "which model is this".

describe('followInExplorer: it refuses to convert a window that would not follow', () => {
  function convertDeps(mode: 'folder' | 'root' | 'project' | undefined) {
    const told: string[] = [];
    (
      mockWindow as { showInformationMessage?: (m: unknown) => Promise<unknown> }
    ).showInformationMessage = async (message) => {
      told.push(String(message));
      return undefined;
    };
    (
      mockWindow as { showWarningMessage?: (m: unknown) => Promise<unknown> }
    ).showWarningMessage = async (message) => {
      told.push(`WARN:${String(message)}`);
      return undefined;
    };
    const converted: number[] = [];
    const { deps } = chatDeps(projectOf());
    const harness = withRegisteredCommands({
      ...deps,
      lineageMode: mode === undefined ? undefined : () => mode,
      explorerAnchored: () => false,
      followInExplorer: async () => {
        converted.push(1);
      },
    });
    return { harness, told, converted };
  }

  it.each([['folder'], ['root']] as const)(
    'says so, and points at the model picker, in %s',
    async (mode) => {
      const { harness, told, converted } = convertDeps(mode);
      await harness.run(COMMANDS.followInExplorer);
      expect(converted).toEqual([]);
      expect(told[0]).toContain('Auto-switch');
      expect(told[0]).toContain('reload');
    },
  );

  it('offers the modal as before in auto-switch', async () => {
    const { harness, told, converted } = convertDeps('project');
    await harness.run(COMMANDS.followInExplorer);
    // The modal is declined by the double, so nothing converts — what is
    // asserted is that the REFUSAL above did not fire and the question was
    // actually asked.
    expect(converted).toEqual([]);
    expect(told[0]).toContain('WARN:');
    expect(told[0]).toContain('follow the session you are in');
  });

  it('goes ahead when the wiring has no opinion about the model', async () => {
    // Absent reads as "no opinion", the way `resolveMode` treats an undefined
    // `workspaces.enabled`: a caller that cannot answer must not veto.
    const { harness, told } = convertDeps(undefined);
    await harness.run(COMMANDS.followInExplorer);
    expect(told[0]).toContain('WARN:');
  });
});

// ---------------------------------------------------- go to the workspace
//
// Axel's level-2 verb: "we should be able to go to the workspace for that
// session, to open a new window". The resolver below is the whole of WHERE, and
// it is asserted separately from the verb because the ladder is the part that
// is easy to get subtly wrong — every rung has to CONTAIN the session's cwd, or
// the window that opens has no row for the session and cannot resume it.

describe('sessionWorkspaceTarget: the worktree, then the lane, then the claim', () => {
  const SESSION = uuid(7);

  function resolverDeps(over: {
    cwd?: string;
    projects?: ProjectRecord[];
    lane?: SubprojectRecord;
    laneId?: string;
    worktrees?: (dir: string) => Promise<readonly Worktree[]>;
  }): CommandDeps {
    const projects = over.projects ?? [];
    const { deps } = chatDeps(projects[0], { projects });
    return {
      ...deps,
      getForest: () =>
        forestOf(
          over.cwd === undefined
            ? [node(SESSION)]
            : [node(SESSION, { cwd: over.cwd })],
        ),
      getSessionLane: () => over.laneId,
      getSubproject: (id: string) =>
        over.lane && over.lane.id === id ? over.lane : undefined,
      ...(over.worktrees === undefined ? {} : { worktreesFor: over.worktrees }),
    } as CommandDeps;
  }

  const app = (): ProjectRecord =>
    projectOf({ id: 'p1', name: 'App', rootDir: '/code/app', dirs: [] });

  const lane = (over: Partial<SubprojectRecord> = {}): SubprojectRecord => ({
    id: 'lane-1',
    projectId: 'p1',
    name: 'Server rewrite',
    dir: '/code/app',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  it('prefers the session\'s own CHECKOUT to the project\'s root', async () => {
    // The case `openTargetFor` alone gets wrong, and the reason the worktree is
    // tier one: the project claims `/code/app`, but this conversation is
    // running in a linked worktree, and a window on the project's root would
    // show the main checkout's branch in Source Control — the wrong branch, on
    // the wrong files, for the session it was opened for.
    const probed: string[] = [];
    const deps = resolverDeps({
      cwd: '/code/app-feat-x/src',
      projects: [app()],
      worktrees: async (dir) => {
        probed.push(dir);
        return [
          { dir: '/code/app', branch: 'main', head: 'a', detached: false },
          {
            dir: '/code/app-feat-x',
            branch: 'feat/x',
            head: 'b',
            detached: false,
          },
        ];
      },
    });
    expect(await sessionWorkspaceTarget(deps, SESSION)).toBe('/code/app-feat-x');
    expect(probed).toEqual(['/code/app-feat-x/src']);
  });

  it('falls to the LANE when there is no checkout to name', async () => {
    // A lane in a plain directory — no git anywhere near it. The lane is the
    // editorial answer to "which piece of work", and it beats the project root
    // for the same reason the worktree does: it is narrower and still true.
    const deps = resolverDeps({
      cwd: '/code/app/services/api/src',
      projects: [app()],
      laneId: 'lane-1',
      lane: lane({ dir: '/code/app/services/api' }),
    });
    expect(await sessionWorkspaceTarget(deps, SESSION)).toBe(
      '/code/app/services/api',
    );
  });

  it('SKIPS a lane whose directory does not contain the session', async () => {
    // `SubprojectRecord.dir` is editorial and is explicitly allowed to point
    // outside the project's own directories; a pinned lane can also be
    // redirected to a checkout that has nothing to do with this conversation.
    // Trusting it would open a window whose fences exclude the very session it
    // was opened for — no row, and no resume.
    const deps = resolverDeps({
      cwd: '/code/app/src',
      projects: [app()],
      laneId: 'lane-1',
      lane: lane({ dir: '/elsewhere/entirely' }),
    });
    expect(await sessionWorkspaceTarget(deps, SESSION)).toBe('/code/app');
  });

  it('falls to the project\'s claim, and then to the cwd itself', async () => {
    const claimed = resolverDeps({ cwd: '/code/app/src/x', projects: [app()] });
    expect(await sessionWorkspaceTarget(claimed, SESSION)).toBe('/code/app');
    // No project claims it: the directory the conversation is actually in is
    // still a true answer, and a window on it is still better than a refusal.
    const loose = resolverDeps({ cwd: '/tmp/scratch', projects: [app()] });
    expect(await sessionWorkspaceTarget(loose, SESSION)).toBe('/tmp/scratch');
  });

  it('answers with nothing at all when the row records no directory', async () => {
    const deps = resolverDeps({ projects: [app()] });
    expect(await sessionWorkspaceTarget(deps, SESSION)).toBe('');
  });

  it('survives a worktree probe that throws', async () => {
    // The probe shells out. A repository that has just been deleted, a git that
    // is not on PATH — the verb still has two rungs below this one, and a
    // failure to answer "which checkout" is not a reason to refuse to open a
    // window at all.
    const deps = resolverDeps({
      cwd: '/code/app/src',
      projects: [app()],
      worktrees: async () => {
        throw new Error('not a git repository');
      },
    });
    expect(await sessionWorkspaceTarget(deps, SESSION)).toBe('/code/app');
  });

  it('never answers with a directory that does not CONTAIN the session', async () => {
    // The invariant every tier exists to satisfy, asserted as itself rather
    // than inferred from the cases above: the new window's launch fence and its
    // grouping fence are both containment tests against this directory.
    const cases: Array<{ cwd: string; deps: CommandDeps }> = [
      { cwd: '/code/app-feat-x/src', deps: resolverDeps({
        cwd: '/code/app-feat-x/src',
        projects: [app()],
        worktrees: async () => [
          { dir: '/code/app', branch: 'main', head: 'a', detached: false },
          { dir: '/code/app-feat-x', branch: 'feat/x', head: 'b', detached: false },
        ],
      }) },
      { cwd: '/code/app/src', deps: resolverDeps({
        cwd: '/code/app/src',
        projects: [app()],
        laneId: 'lane-1',
        lane: lane({ dir: '/elsewhere/entirely' }),
      }) },
      { cwd: '/tmp/scratch', deps: resolverDeps({ cwd: '/tmp/scratch' }) },
    ];
    for (const c of cases) {
      const target = await sessionWorkspaceTarget(c.deps, SESSION);
      expect(target).not.toBe('');
      expect(isWithin(target, c.cwd), `${target} must contain ${c.cwd}`).toBe(
        true,
      );
    }
  });
});

describe('Open Workspace for This Session picks the window', () => {
  afterEach(() => {
    delete (mockCommands as { registerCommand?: unknown }).registerCommand;
    delete (mockWindow as { showInformationMessage?: unknown })
      .showInformationMessage;
    delete (mockWindow as { setStatusBarMessage?: unknown }).setStatusBarMessage;
  });

  const SESSION = uuid(7);

  function verbHarness(over: {
    cwd?: string;
    windowFolders?: string[];
    focusWindowForDir?: (dir: string, id?: string) => Promise<boolean>;
  }): {
    told: string[];
    opened: Array<[string, boolean]>;
    calls: ChatCalls;
    run: (command: string, arg: unknown) => Promise<void>;
  } {
    const told: string[] = [];
    const opened: Array<[string, boolean]> = [];
    (
      mockWindow as { showInformationMessage?: (m: unknown) => Promise<unknown> }
    ).showInformationMessage = async (message) => {
      told.push(String(message));
      return undefined;
    };
    (mockWindow as { setStatusBarMessage?: (m: unknown) => void })
      .setStatusBarMessage = (message) => {
      told.push(String(message));
    };
    const project = projectOf({
      id: 'p1',
      name: 'App',
      rootDir: '/code/app',
      dirs: [],
    });
    const { deps, calls } = chatDeps(project, { projects: [project] });
    const harness = withRegisteredCommands({
      ...deps,
      getForest: () =>
        forestOf(
          over.cwd === undefined
            ? [node(SESSION)]
            : [node(SESSION, { cwd: over.cwd })],
        ),
      ...(over.windowFolders === undefined
        ? {}
        : { windowFolders: () => over.windowFolders as string[] }),
      ...(over.focusWindowForDir === undefined
        ? {}
        : { focusWindowForDir: over.focusWindowForDir }),
      openProject: async (fsPath: string, newWindow: boolean) => {
        opened.push([fsPath, newWindow]);
      },
    } as never);
    return { told, opened, calls, run: (c, a) => harness.run(c, a) };
  }

  it('opens a NEW window on the session\'s directory', async () => {
    const h = verbHarness({ cwd: '/code/app/src' });
    await h.run(COMMANDS.openSessionWorkspace, { type: 'session', id: SESSION });
    expect(h.opened).toEqual([['/code/app', true]]);
  });

  it('reveals the row instead when THIS window already has that folder', async () => {
    // `focusWindowForDir` excludes this window on purpose, so without a
    // self-check the verb would open a second window on the folder the user is
    // standing in — two roosts for one piece of work.
    const h = verbHarness({
      cwd: '/code/app/src',
      windowFolders: ['/code/app'],
      focusWindowForDir: async () => true,
    });
    await h.run(COMMANDS.openSessionWorkspace, { type: 'session', id: SESSION });
    expect(h.opened).toEqual([]);
    expect(h.calls.reveals).toEqual([SESSION]);
    expect(h.told.join(' ')).toContain('already open on /code/app');
  });

  it('reads the window\'s real folders, not the folder-mode fence', async () => {
    // The check has to fire in the two models where `scopeDirs()` is undefined
    // by construction — which are exactly the models this verb was written for.
    // A window that publishes no folders makes no claim and gets a new window.
    const h = verbHarness({
      cwd: '/code/app/src',
      windowFolders: ['/code/other'],
    });
    await h.run(COMMANDS.openSessionWorkspace, { type: 'session', id: SESSION });
    expect(h.opened).toEqual([['/code/app', true]]);
  });

  it('raises a live window that covers the directory rather than opening a second', async () => {
    const routed: Array<[string, string | undefined]> = [];
    const h = verbHarness({
      cwd: '/code/app/src',
      focusWindowForDir: async (dir, id) => {
        routed.push([dir, id]);
        return true;
      },
    });
    await h.run(COMMANDS.openSessionWorkspace, { type: 'session', id: SESSION });
    expect(routed).toEqual([['/code/app', SESSION]]);
    expect(h.opened).toEqual([]);
  });

  it('says so rather than guessing when the row has no directory', async () => {
    const h = verbHarness({});
    await h.run(COMMANDS.openSessionWorkspace, { type: 'session', id: SESSION });
    expect(h.opened).toEqual([]);
    expect(h.told.join(' ')).toContain('no directory on record');
  });
});

// ------------------------------- telling a parent conversation what happened
//
// Two features on one transport. Flock has NO session-to-session messaging —
// the in-session verbs channel runs one way, session → extension, and the only
// text that ever went the other way is a fork's opening prompt, delivered once
// at birth. Both the fork note and the close-with-summary note ride
// `sendTextToSession`, which types into a terminal bound in THIS window and
// reaches nothing else. These pin the two things that follow from that: what
// is sent, and the far more common case of nothing being sent at all.

describe('a fork tells its parent, when asked to', () => {
  afterEach(() => {
    delete (mockCommands as { registerCommand?: unknown }).registerCommand;
    delete (mockWindow as { showWarningMessage?: unknown }).showWarningMessage;
  });

  const PARENT = uuid(1);

  interface NoteHarness {
    sends: Array<[string, string]>;
    launches: LaunchOptions[];
    warnings: string[];
    deps: AccountCommandDeps;
    run: (command: string, ...args: unknown[]) => Promise<void>;
  }

  function noteHarness(
    over: {
      notifyParentOnFork?: () => boolean;
      sendTextToSession?: (id: string, text: string) => boolean;
      host?: 'here' | 'flock' | 'foreign' | 'none';
    } = {},
  ): NoteHarness {
    const sends: Array<[string, string]> = [];
    const launches: LaunchOptions[] = [];
    const warnings: string[] = [];
    (
      mockWindow as { showWarningMessage?: (m: unknown) => Promise<unknown> }
    ).showWarningMessage = async (message: unknown) => {
      warnings.push(String(message));
      return undefined;
    };
    // A LIVE record map: `labelFor` reads the store, and in the real wiring the
    // child's title is already written there by the time the note is composed.
    // A frozen fixture would quietly make every note say a hex id.
    const records: Record<string, EditorialRecord> = {
      [PARENT]: {
        id: PARENT,
        parentId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    };
    const { accounts } = fakeAccountDeps([], { sessionProfileId: () => undefined });
    const { deps } = chatDeps(undefined, {
      records,
      hasTranscript: () => true,
      beginInlineRename: () => true,
    });
    const withNote: AccountCommandDeps = {
      ...deps,
      getForest: () => forestOf([node(PARENT, { cwd: '/code/api', label: 'auth' })]),
      getRecord: (id) => records[id],
      upsertRecord: async (id, patch) => {
        records[id] = {
          ...(records[id] ?? {
            id,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          }),
          ...patch,
        } as EditorialRecord;
      },
      hostOf: () => over.host ?? 'here',
      sendTextToSession: (id, text) => {
        sends.push([id, text]);
        return over.sendTextToSession ? over.sendTextToSession(id, text) : true;
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
      ...(over.notifyParentOnFork
        ? { notifyParentOnFork: over.notifyParentOnFork }
        : {}),
      accounts,
    };
    const harness = withRegisteredCommands(withNote);
    return { sends, launches, warnings, deps: withNote, run: harness.run };
  }

  it('types exactly one single line into the parent when the setting is on', async () => {
    const h = noteHarness({ notifyParentOnFork: () => true });
    await h.run(COMMANDS.forkSession, PARENT);
    expect(h.sends).toHaveLength(1);
    const [target, text] = h.sends[0];
    expect(target).toBe(PARENT);
    // sendText appends the newline itself; an embedded one submits early and
    // drops the rest of the sentence into the parent as a second turn.
    expect(text).not.toContain('\n');
    expect(text).toContain('auth 2');
  });

  it('sends nothing at all with the setting off, or with no dep at all', async () => {
    for (const over of [{ notifyParentOnFork: () => false }, {}]) {
      const h = noteHarness(over);
      await h.run(COMMANDS.forkSession, PARENT);
      expect(h.sends).toEqual([]);
    }
  });

  it('sends nothing when the parent is not hosted in this window', async () => {
    // The ordinary cases, not the exotic ones: a closed parent, one in another
    // Flock window, one running outside Flock, one parked by a switch. Nothing
    // is queued and nothing is retried in any of them.
    for (const host of ['flock', 'foreign', 'none'] as const) {
      const h = noteHarness({ notifyParentOnFork: () => true, host });
      await h.run(COMMANDS.forkSession, PARENT);
      expect(h.sends).toEqual([]);
      expect(h.launches).toHaveLength(1);
    }
  });

  it('never fails the fork when the note does not land', async () => {
    const h = noteHarness({
      notifyParentOnFork: () => true,
      sendTextToSession: () => false,
    });
    await h.run(COMMANDS.forkSession, PARENT);
    expect(h.launches).toHaveLength(1);
    expect(h.warnings).toEqual([]);
  });

  it('the AGENT-verbs fork types nothing into the parent', async () => {
    // The most important one in the set. There the fork was requested BY the
    // parent conversation, and the verbs CLI already reports the new branches
    // into that same turn — a second copy typed into its terminal would both
    // duplicate the sentence and land keystrokes mid-turn.
    const h = noteHarness({ notifyParentOnFork: () => true });
    const outcome = await forkForAgent(h.deps, PARENT, { count: 2 });
    expect(outcome.forked).toHaveLength(2);
    expect(h.sends).toEqual([]);
  });

  it('fork-and-compact notifies too, and still launches with /compact', async () => {
    const h = noteHarness({ notifyParentOnFork: () => true });
    await h.run(COMMANDS.forkAndCompact, PARENT);
    expect(h.launches[0].prompt).toBe('/compact');
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0][1]).toContain('auth 2');
  });

  it('never announces /compact as the branch purpose', async () => {
    // `/compact` is machinery Flock injects, not a person saying what a branch
    // is for, and forkPurposeOf's rule is "the user's own words". The note used
    // to read `It is for: /compact.`, presenting the compaction command to the
    // parent's model as the branch's stated intention. It must fall through to
    // the same short sentence a plain unnamed fork gets.
    const h = noteHarness({ notifyParentOnFork: () => true });
    await h.run(COMMANDS.forkAndCompact, PARENT);
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0][1]).not.toContain('/compact');
    expect(h.sends[0][1]).not.toContain('It is for:');
    // The name still gets there — the note is not silenced, only the purpose.
    expect(h.sends[0][1]).toContain('auth 2');
  });
});

describe('close with summary drives /compact and reads back what the CLI wrote', () => {
  afterEach(() => {
    delete (mockCommands as { registerCommand?: unknown }).registerCommand;
    delete (mockWindow as { showWarningMessage?: unknown }).showWarningMessage;
    delete (mockWindow as { showInputBox?: unknown }).showInputBox;
    delete (mockWindow as { setStatusBarMessage?: unknown }).setStatusBarMessage;
  });

  const PARENT = uuid(1);
  const CHILD = uuid(2);
  const SUCCESSOR = uuid(3);

  interface SummaryHarness {
    sends: Array<[string, string]>;
    patches: Array<{ id: string; patch: Partial<EditorialRecord> }>;
    closedTerminals: string[];
    warnings: string[];
    waits: Array<[string, number, number]>;
    /** The store itself, so a test can act as ANOTHER actor: the compaction
     *  wait is up to two minutes long, and the idle sweep, a second window or
     *  the user's own Close Now can close the session inside it. */
    records: Record<string, EditorialRecord>;
    run: (command: string, ...args: unknown[]) => Promise<void>;
  }

  function summaryHarness(
    over: {
      mode?: CloseSummaryMode | undefined;
      summary?: string | undefined;
      reader?: boolean;
      sendTextToSession?: (id: string, text: string) => boolean;
      provider?: 'codex';
      answer?: string;
      tipOf?: (id: string) => string;
      /** Fired inside the wait — i.e. while the CLI is compacting, which is
       *  when a session id really does get re-minted. */
      onWait?: () => void;
    } = {},
  ): SummaryHarness {
    const sends: Array<[string, string]> = [];
    const patches: Array<{ id: string; patch: Partial<EditorialRecord> }> = [];
    const closedTerminals: string[] = [];
    const warnings: string[] = [];
    const waits: Array<[string, number, number]> = [];
    (
      mockWindow as {
        showWarningMessage?: (m: unknown, ...rest: unknown[]) => Promise<unknown>;
      }
    ).showWarningMessage = async (message) => {
      warnings.push(String(message));
      return over.answer;
    };
    (
      mockWindow as { setStatusBarMessage?: (m: string, ms?: number) => void }
    ).setStatusBarMessage = () => {};

    const records: Record<string, EditorialRecord> = {
      [PARENT]: { id: PARENT, parentId: null },
      [CHILD]: {
        id: CHILD,
        parentId: PARENT,
        ...(over.provider ? { provider: over.provider } : {}),
      },
    } as Record<string, EditorialRecord>;
    const { accounts } = fakeAccountDeps([], { sessionProfileId: () => undefined });
    const { deps } = chatDeps(undefined, { records });
    const withSummary: AccountCommandDeps = {
      ...deps,
      getForest: () =>
        forestOf([
          node(PARENT, { label: 'auth' }),
          node(CHILD, { parentId: PARENT, label: 'redis cache' }),
          node(SUCCESSOR, { parentId: PARENT, label: 'redis cache' }),
        ]),
      getRecord: (id) => records[id],
      upsertRecord: async (id, patch) => {
        patches.push({ id, patch });
        records[id] = { ...(records[id] as EditorialRecord), ...patch };
      },
      closeTerminal: (id) => {
        closedTerminals.push(id);
        return true;
      },
      hostOf: () => 'here',
      ...(over.tipOf ? { tipOf: over.tipOf } : {}),
      sendTextToSession: (id, text) => {
        sends.push([id, text]);
        return over.sendTextToSession ? over.sendTextToSession(id, text) : true;
      },
      ...(over.mode !== undefined
        ? { closeSummaryMode: (): CloseSummaryMode => over.mode as CloseSummaryMode }
        : {}),
      ...(over.reader === false
        ? {}
        : {
            awaitCompactSummary: async (id, sinceMs, timeoutMs) => {
              waits.push([id, sinceMs, timeoutMs]);
              over.onWait?.();
              return over.summary;
            },
          }),
      accounts,
    };
    const harness = withRegisteredCommands(withSummary);
    return {
      sends,
      patches,
      closedTerminals,
      warnings,
      waits,
      records,
      run: harness.run,
    };
  }

  it('sends /compact, records a bounded summary, tells the parent, and closes', async () => {
    const h = summaryHarness({
      mode: 'compact-and-tell-parent',
      summary: 'Traced the drift to a stale cache key; fix in PR 412.',
    });
    const before = Date.now();
    await h.run(COMMANDS.closeWithSummary, CHILD);

    // The keystroke, then the wait, then the parent's note.
    expect(h.sends[0]).toEqual([CHILD, '/compact']);
    expect(h.waits).toHaveLength(1);
    expect(h.waits[0][0]).toBe(CHILD);
    // The floor exists so that a compaction summary from last week cannot be
    // reported as this branch's conclusion.
    expect(h.waits[0][1]).toBeGreaterThanOrEqual(before);
    expect(h.patches.some((p) => p.patch.summaryRequestedAt !== undefined)).toBe(
      true,
    );
    const summaryPatch = h.patches.find((p) => p.patch.summary !== undefined);
    expect(summaryPatch?.id).toBe(CHILD);
    expect(summaryPatch?.patch.summary).toContain('stale cache key');
    expect(summaryPatch?.patch.closed).toBeTruthy();
    expect(h.closedTerminals).toEqual([CHILD]);

    const note = h.sends[1];
    expect(note[0]).toBe(PARENT);
    expect(note[1]).not.toContain('\n');
    expect(note[1]).toContain('redis cache');
  });

  it('does not re-close a session another actor closed during the wait', async () => {
    // The wait is up to two minutes. Anything can close the session inside it:
    // the idle-close sweep, a second Flock window, the user's own Close Now.
    // Closing it again re-stamped `closed` with the later time — losing the
    // real one — nulled the binding, disposed a terminal that had already gone
    // and warned that the session was "still running". The summary is the only
    // thing the user asked for, so the summary is the only thing written.
    const CLOSED_AT = '2026-08-28T00:00:00.000Z';
    const h = summaryHarness({
      mode: 'compact-only',
      summary: 'done',
      onWait: () => {
        h.records[CHILD] = { ...h.records[CHILD], closed: CLOSED_AT };
      },
    });
    await h.run(COMMANDS.closeWithSummary, CHILD);
    expect(h.records[CHILD].closed).toBe(CLOSED_AT);
    expect(h.records[CHILD].summary).toContain('done');
    expect(h.closedTerminals).toEqual([]);
  });

  it('records the summary on a session ARCHIVED during the wait, and nothing else', async () => {
    // The same race with the archive verb, where a second close is worse than
    // untidy: the record ended up `{ deleted: true, closed: <fresh> }` — an
    // archived row that had just acquired a new close stamp.
    const h = summaryHarness({
      mode: 'compact-only',
      summary: 'done',
      onWait: () => {
        h.records[CHILD] = { ...h.records[CHILD], deleted: true };
      },
    });
    await h.run(COMMANDS.closeWithSummary, CHILD);
    expect(h.records[CHILD].closed).toBeUndefined();
    expect(h.records[CHILD].deleted).toBe(true);
    expect(h.records[CHILD].summary).toContain('done');
    expect(h.closedTerminals).toEqual([]);
  });

  it('closes the id the conversation is on AFTER the compaction, not before', async () => {
    // A compaction re-mints the session id in roughly a third of real cases.
    // Closing the pre-compaction id would stamp `closed` on a superseded
    // generation while its successor kept running.
    let compacted = false;
    const h = summaryHarness({
      mode: 'compact-only',
      summary: 'done',
      // The re-key lands DURING the compaction, which is when it really
      // happens — so the send goes to the old id and the close must not.
      onWait: () => {
        compacted = true;
      },
      tipOf: (id) => (id === CHILD && compacted ? SUCCESSOR : id),
    });
    await h.run(COMMANDS.closeWithSummary, CHILD);
    expect(h.sends).toEqual([[CHILD, '/compact']]);
    expect(h.closedTerminals).toEqual([SUCCESSOR]);
  });

  it('compact-only tells nobody', async () => {
    const h = summaryHarness({ mode: 'compact-only', summary: 'done' });
    await h.run(COMMANDS.closeWithSummary, CHILD);
    expect(h.sends).toEqual([[CHILD, '/compact']]);
  });

  it('a compaction that never answers closes NOTHING', async () => {
    // The session is mid-model-call: closing its tab would abort the
    // compaction and leave the branch neither compacted nor summarised.
    const h = summaryHarness({
      mode: 'compact-and-tell-parent',
      summary: undefined,
    });
    await h.run(COMMANDS.closeWithSummary, CHILD);
    expect(h.closedTerminals).toEqual([]);
    expect(h.patches.some((p) => p.patch.closed !== undefined)).toBe(false);
    expect(h.warnings.join(' ')).toContain('no summary came back');
  });

  it('refuses before typing anything when the session has no terminal here', async () => {
    const h = summaryHarness({
      mode: 'compact-and-tell-parent',
      sendTextToSession: () => false,
    });
    await h.run(COMMANDS.closeWithSummary, CHILD);
    expect(h.waits).toEqual([]);
    expect(h.closedTerminals).toEqual([]);
    expect(h.warnings.join(' ')).toContain('no terminal in this window');
  });

  it('declines by name on Codex, and sends nothing when the offer is refused', async () => {
    const h = summaryHarness({
      mode: 'compact-and-tell-parent',
      provider: 'codex',
      summary: 'unused',
    });
    await h.run(COMMANDS.closeWithSummary, CHILD);
    expect(h.sends).toEqual([]);
    expect(h.closedTerminals).toEqual([]);
    expect(h.warnings.join(' ')).toContain('Codex');
  });

  it('falls back to the input box when the wiring cannot read a summary back', async () => {
    (mockWindow as { showInputBox?: () => Promise<string> }).showInputBox =
      async () => 'typed by hand';
    const h = summaryHarness({ mode: 'compact-and-tell-parent', reader: false });
    await h.run(COMMANDS.closeWithSummary, CHILD);
    expect(h.sends).toEqual([]);
    expect(
      h.patches.find((p) => p.patch.summary !== undefined)?.patch.summary,
    ).toBe('typed by hand');
  });

  it('ask-me is exactly the old input box, and so is an absent dep', async () => {
    (mockWindow as { showInputBox?: () => Promise<string> }).showInputBox =
      async () => 'typed by hand';
    for (const mode of ['ask-me', undefined] as const) {
      const h = summaryHarness({ mode, summary: 'never read' });
      await h.run(COMMANDS.closeWithSummary, CHILD);
      expect(h.sends).toEqual([]);
      expect(h.waits).toEqual([]);
      expect(
        h.patches.find((p) => p.patch.summary !== undefined)?.patch.summary,
      ).toBe('typed by hand');
    }
  });

  it('off closes with no summary and no keystroke', async () => {
    const h = summaryHarness({ mode: 'off', summary: 'never read' });
    await h.run(COMMANDS.closeWithSummary, CHILD);
    expect(h.sends).toEqual([]);
    expect(h.waits).toEqual([]);
    expect(h.closedTerminals).toEqual([CHILD]);
    expect(
      h.patches.find((p) => p.patch.summary !== undefined),
    ).toBeUndefined();
  });
});

// ---------------------------------------------- Move to Account…, the flow
//
// `switchAccountFlow` had no test at all, which is how its three layers came
// to disagree: the menu counted one thing, the picker filtered on another and
// the at-the-limit notification on a third. These pin the two refusals that
// were wrong, both of them ahead of anything that touches a process.

describe('switchAccountFlow refuses by what a conversation IS, before it moves anything', () => {
  const SESSION = uuid(1);

  afterEach(() => {
    delete (mockCommands as { registerCommand?: unknown }).registerCommand;
    delete (mockWindow as { showWarningMessage?: unknown }).showWarningMessage;
    delete (mockWindow as { showInformationMessage?: unknown })
      .showInformationMessage;
    delete (mockWindow as { setStatusBarMessage?: unknown }).setStatusBarMessage;
    delete (mockWindow as { withProgress?: unknown }).withProgress;
    delete (mockWindow as { showErrorMessage?: unknown }).showErrorMessage;
    delete (vscodeMock as { ProgressLocation?: unknown }).ProgressLocation;
  });

  function switchHarness(over: {
    sessionProvider?: (id: string) => string | undefined;
    hostOf?: () => 'here' | 'flock' | 'foreign' | 'none';
    profiles?: AccountProfile[];
    sessionProfileId?: () => string | undefined;
    canRestartSession?: () => boolean;
    confirm?: string;
    /** Answers `AccountDeps.switchMovesNothing`, the dialog's question. */
    movesNothing?: boolean;
    /** One result per call, so a refusal followed by a retry can be scripted. */
    results?: SwitchAccountResult[];
    /** What the user clicks on the error toast, by literal label. */
    pressError?: string;
    /** What `setAsideTranscript` reports. */
    aside?: { ok: boolean; path?: string; error?: string };
  }): {
    run: (id: string, ...args: unknown[]) => Promise<void>;
    warnings: string[];
    /** The modal `detail` of every dialog, in order — the sentence that makes a
     *  promise about what the switch costs. */
    details: string[];
    errors: string[];
    infos: string[];
    switched: number;
    setAside: string[];
    transcriptAsked: number;
  } {
    const warnings: string[] = [];
    const details: string[] = [];
    const errors: string[] = [];
    const infos: string[] = [];
    const setAside: string[] = [];
    const state = { switched: 0, transcriptAsked: 0 };
    (
      mockWindow as {
        showWarningMessage?: (m: unknown, ...rest: unknown[]) => Promise<unknown>;
      }
    ).showWarningMessage = async (message, ...rest) => {
      warnings.push(String(message));
      const opts = rest[0];
      if (
        typeof opts === 'object' &&
        opts !== null &&
        typeof (opts as { detail?: unknown }).detail === 'string'
      ) {
        details.push((opts as { detail: string }).detail);
      }
      return over.confirm;
    };
    (
      mockWindow as {
        showInformationMessage?: (m: unknown) => Promise<unknown>;
      }
    ).showInformationMessage = async (message) => {
      infos.push(String(message));
      return undefined;
    };
    (
      mockWindow as { setStatusBarMessage?: (m: string, ms?: number) => void }
    ).setStatusBarMessage = () => {};
    // The move runs inside a progress notification; the mock's window has no
    // such host, so it is scripted to just run the task.
    (
      mockWindow as {
        withProgress?: (opts: unknown, task: () => Promise<unknown>) => Promise<unknown>;
      }
    ).withProgress = async (_opts, task) => task();
    (
      vscodeMock as { ProgressLocation?: Record<string, number> }
    ).ProgressLocation = { Notification: 15 };
    (
      mockWindow as { showErrorMessage?: (m: unknown) => Promise<unknown> }
    ).showErrorMessage = async (message) => {
      warnings.push(String(message));
      errors.push(String(message));
      return over.pressError;
    };

    const { accounts } = fakeAccountDeps(
      over.profiles ?? [
        accountProfile('work', { configDir: '/work/.claude' }),
        accountProfile('personal', { configDir: '/personal/.claude' }),
      ],
      {
        sessionProfileId: over.sessionProfileId ?? (() => undefined),
        ...(over.canRestartSession
          ? { canRestartSession: over.canRestartSession }
          : {}),
        switchSessionAccount: async () => {
          state.switched += 1;
          const scripted = over.results?.[state.switched - 1];
          return (
            scripted ?? {
              ok: true,
              inPlace: true,
              running: 'in-place' as const,
              skipped: [],
            }
          );
        },
        ...(over.movesNothing !== undefined
          ? { switchMovesNothing: () => over.movesNothing === true }
          : {}),
        ...(over.aside !== undefined
          ? {
              setAsideTranscript: async (file: string) => {
                setAside.push(file);
                return over.aside as {
                  ok: boolean;
                  path?: string;
                  error?: string;
                };
              },
            }
          : {}),
      },
    );
    const { deps } = chatDeps(undefined, {
      hasTranscript: () => {
        state.transcriptAsked += 1;
        return true;
      },
    });
    const withAccounts: AccountCommandDeps = {
      ...deps,
      getForest: () => forestOf([node(SESSION, { label: 'auth', cwd: '/code' })]),
      hostOf: over.hostOf ?? (() => 'here'),
      ...(over.sessionProvider
        ? { sessionProvider: over.sessionProvider as never }
        : {}),
      accounts,
    };
    const harness = withRegisteredCommands(withAccounts);
    return {
      run: harness.run,
      warnings,
      details,
      errors,
      infos,
      setAside,
      get switched(): number {
        return state.switched;
      },
      get transcriptAsked(): number {
        return state.transcriptAsked;
      },
    };
  }

  it('refuses an UNPINNED Codex conversation, and never tells it it has taken no turns', async () => {
    // The gate used to read the PIN. A Codex session started in a terminal has
    // no pin at all, an absent pin resolves to the default provider, and so it
    // sailed through and met `hasTranscript` — which only knows how to look for
    // a Claude transcript — and was told it "has not taken a turn yet". That is
    // the exact sentence this gate exists to prevent.
    const h = switchHarness({ sessionProvider: () => 'codex' });
    await h.run(COMMANDS.switchSessionAccount, SESSION);

    expect(h.warnings.join(' ')).toContain('Codex');
    expect(h.warnings.join(' ')).not.toContain('has not taken a turn');
    expect(h.transcriptAsked).toBe(0);
    expect(h.switched).toBe(0);
  });

  it('refuses a session ANOTHER Flock window is running', async () => {
    // Only 'foreign' was refused. A session held by another Flock window with
    // no tmux wrap — tmux off, or Windows, where the tier does not exist — had
    // nothing stopped, its transcript renamed under a live CLI, and the result
    // still reported a clean in-place move.
    // With no way to reach it: no tmux name resolves, so `canRestartSession`
    // says no — and an ABSENT dep says no too, because a wiring that cannot
    // tell must not be the one deciding to restart somebody's process.
    for (const over of [
      { hostOf: () => 'flock' as const },
      { hostOf: () => 'flock' as const, canRestartSession: () => false },
    ]) {
      const h = switchHarness(over);
      await h.run(COMMANDS.switchSessionAccount, SESSION);
      expect(h.warnings.join(' ')).toContain('another Flock window');
      expect(h.switched).toBe(0);
    }
  });

  it('does NOT refuse one this window parked into tmux, which it can respawn', async () => {
    // 'flock' is one word for two situations with opposite answers. A
    // conversation parked by a workspace switch is Flock's, not bound here, and
    // perfectly restartable from this window — refusing it would remove a move
    // that works and print a sentence about another window that is not true.
    const h = switchHarness({
      hostOf: () => 'flock',
      canRestartSession: () => true,
      // Named account, so the picker is skipped; the modal is then confirmed.
      confirm: 'Switch Account',
    });
    await h.run(COMMANDS.switchSessionAccount, SESSION, 'personal');
    expect(h.warnings.join(' ')).not.toContain('another Flock window');
    expect(h.switched).toBe(1);
  });

  it('still refuses one running outside Flock, in its own words', async () => {
    const h = switchHarness({ hostOf: () => 'foreign' });
    await h.run(COMMANDS.switchSessionAccount, SESSION);
    expect(h.warnings.join(' ')).toContain('running outside Flock');
    expect(h.switched).toBe(0);
  });

  it('does not promise a lost turn for a move that moves nothing', async () => {
    // Two profiles can resolve to one config directory, so "move it there" can
    // be a re-pin with no bytes and no restart behind it. The dialog was
    // promising a cut-off turn and a cold prompt cache for a change of label.
    const h = switchHarness({
      hostOf: () => 'here',
      movesNothing: true,
      confirm: 'Switch Account',
    });
    await h.run(COMMANDS.switchSessionAccount, SESSION, 'personal');
    expect(h.switched).toBe(1);
    expect(h.details.join(' ')).toContain('Nothing is moved and nothing is restarted');
    expect(h.details.join(' ')).not.toContain('cut off');
  });

  it('still promises the restart when the move really moves something', async () => {
    const h = switchHarness({
      hostOf: () => 'here',
      movesNothing: false,
      confirm: 'Switch Account',
    });
    await h.run(COMMANDS.switchSessionAccount, SESSION, 'personal');
    expect(h.details.join(' ')).toContain('turn in progress is cut off');
    expect(h.details.join(' ')).not.toContain('Nothing is moved');
  });

  it('offers a way out of the duplicate refusal, names both files, and retries', async () => {
    // The refusal that was a permanent dead end: two files claim one session id,
    // so the move will not overwrite either, and every future attempt refuses
    // identically. Three ids on the author's machine are in exactly this state.
    const duplicate = {
      otherPath: '/personal/.claude/projects/-code/x.jsonl',
      otherBytes: 2273,
      otherMtimeMs: Date.UTC(2026, 0, 2),
      thisPath: '/work/.claude/projects/-code/x.jsonl',
      thisBytes: 12_001_952,
      thisMtimeMs: Date.UTC(2026, 0, 3),
    };
    const h = switchHarness({
      hostOf: () => 'here',
      confirm: 'Switch Account',
      pressError: 'Set the Other Copy Aside',
      aside: { ok: true, path: `${duplicate.otherPath}.superseded-2026` },
      results: [
        { ok: false, inPlace: false, skipped: [], error: 'blocked', duplicate },
        { ok: true, inPlace: true, running: 'in-place', skipped: [] },
      ],
    });
    await h.run(COMMANDS.switchSessionAccount, SESSION, 'personal');

    // Both copies described, with sizes a person can tell apart at a glance.
    const offer = h.errors.join(' ');
    expect(offer).toContain(duplicate.otherPath);
    expect(offer).toContain(duplicate.thisPath);
    expect(offer).toContain('2 KB');
    expect(offer).toContain('11.4 MB');
    expect(offer).toContain('nothing is deleted');
    // The blocking copy — never the conversation being moved — is set aside…
    expect(h.setAside).toEqual([duplicate.otherPath]);
    // …and the flow starts over, modal included, rather than moving on a
    // button press: a button on an error toast is not consent to restart a
    // process.
    expect(h.switched).toBe(2);
  });

  it('leaves both files alone when the offer is dismissed', async () => {
    const duplicate = {
      otherPath: '/personal/x.jsonl',
      otherBytes: 10,
      otherMtimeMs: Date.UTC(2026, 0, 2),
      thisPath: '/work/x.jsonl',
      thisBytes: 20,
      thisMtimeMs: Date.UTC(2026, 0, 3),
    };
    const h = switchHarness({
      hostOf: () => 'here',
      confirm: 'Switch Account',
      aside: { ok: true },
      results: [
        { ok: false, inPlace: false, skipped: [], error: 'blocked', duplicate },
      ],
    });
    await h.run(COMMANDS.switchSessionAccount, SESSION, 'personal');
    expect(h.setAside).toEqual([]);
    expect(h.switched).toBe(1);
  });

  it('says there is nowhere to go on the roster this extension seeds by default', async () => {
    // One Claude login plus one Codex login — what `seedDefaultProfiles` mints
    // wherever ~/.codex/auth.json exists. The picker was always empty here,
    // while the row menu drew the verb on every session.
    const h = switchHarness({
      profiles: [
        accountProfile('claude-default'),
        accountProfile('codex-default', { provider: 'codex' }),
      ],
      sessionProfileId: () => 'claude-default',
    });
    await h.run(COMMANDS.switchSessionAccount, SESSION);
    expect(h.infos.join(' ')).toContain('no other account');
    expect(h.switched).toBe(0);
  });
});

// ---------------------- the + that IS a worktree, and the ref's retirement

/** The error modal — the auto flow's one loud ending. */
type ErrorHost = {
  showErrorMessage?: (
    message: string,
    opts?: unknown,
    ...items: string[]
  ) => Promise<string | undefined>;
};

describe('the + cuts a worktree per root session', () => {
  afterEach(() => {
    delete (mockCommands as { registerCommand?: unknown }).registerCommand;
    delete (mockWindow as WarningHost).showWarningMessage;
    delete (mockWindow as ErrorHost).showErrorMessage;
    delete (mockWindow as StatusHost).setStatusBarMessage;
  });

  const REPO = '/Users/a/code/magma';
  const PROJECT_ARG = { type: 'project', projectId: 'p1' };

  interface AutoCalls {
    added: Array<{ repoDir: string; path: string; branch: string; create: boolean }>;
    minted: Array<{ repoDir: string; branch: string }>;
    pruned: Array<{ repoDir: string; existing: readonly string[] }>;
    launches: Array<{ cwd: string; title: string }>;
    warnings: string[];
    errors: string[];
  }

  function autoHarness(over: Partial<AccountCommandDeps> = {}): {
    calls: AutoCalls;
    run: (command: string, arg?: unknown) => Promise<void>;
  } {
    const calls: AutoCalls = {
      added: [],
      minted: [],
      pruned: [],
      launches: [],
      warnings: [],
      errors: [],
    };
    (mockWindow as WarningHost).showWarningMessage = async (message) => {
      calls.warnings.push(message);
      return undefined;
    };
    (mockWindow as ErrorHost).showErrorMessage = async (message) => {
      calls.errors.push(message);
      return undefined;
    };
    (mockWindow as StatusHost).setStatusBarMessage = () => undefined;

    const project = projectOf();
    const { deps } = chatDeps(project);
    const h = withRegisteredCommands({
      ...deps,
      getProject: () => project,
      newSessionInWorktree: () => true,
      getBranches: () => [
        {
          name: 'main',
          dir: REPO,
          colorIndex: 0,
          rootIds: [],
          primary: true,
          shown: true,
        },
      ],
      localBranches: async () => ['main'],
      worktreePathPattern: () => '../${repo}-${branch}',
      branchPrefix: () => 'axel/',
      addWorktree: async (opts) => {
        calls.added.push(opts);
        return { ok: true, output: '' };
      },
      recordMintedBranch: async (repoDir: string, branch: string) => {
        calls.minted.push({ repoDir, branch });
      },
      pruneMintedBranches: async (repoDir: string, existing: readonly string[]) => {
        calls.pruned.push({ repoDir, existing });
      },
      launchSession: async (opts) => {
        calls.launches.push({ cwd: opts.cwd ?? '', title: opts.title ?? '' });
        return {
          nodeId: opts.sessionId,
          sessionId: opts.sessionId,
          terminalName: 'claude',
          createdAt: 0,
        };
      },
      ...over,
    });
    return { calls, run: (command, arg) => h.run(command, arg) };
  }

  it('mints the branch from the session name and launches in the new checkout', async () => {
    const h = autoHarness();
    await h.run(COMMANDS.newSessionInProject, PROJECT_ARG);
    // No dialog: nothing was asked, something was DONE, and each half of it is
    // asserted exactly — this is the one write in Flock behind no modal.
    expect(h.calls.warnings).toEqual([]);
    expect(h.calls.added).toEqual([
      {
        repoDir: REPO,
        path: '/Users/a/code/magma-axel-magma-os',
        branch: 'axel/magma-os',
        create: true,
      },
    ]);
    // The ledger entry that later earns the ref its delete offer.
    expect(h.calls.minted).toEqual([{ repoDir: REPO, branch: 'axel/magma-os' }]);
    // The read the flow needed anyway swept the ledger against live refs.
    expect(h.calls.pruned).toEqual([{ repoDir: REPO, existing: ['main'] }]);
    // The session runs on the new floor, named the way every `+` names.
    expect(h.calls.launches).toEqual([
      { cwd: '/Users/a/code/magma-axel-magma-os', title: 'magma-os' },
    ]);
  });

  it('falls back to a plain session when the project has no repository', async () => {
    const h = autoHarness({ getBranches: () => [] });
    await h.run(COMMANDS.newSessionInProject, PROJECT_ARG);
    expect(h.calls.added).toEqual([]);
    expect(h.calls.launches).toHaveLength(1);
    expect(h.calls.launches[0].cwd).toBe(REPO);
  });

  it('keeps the old + when the setting is off', async () => {
    const h = autoHarness({ newSessionInWorktree: () => false });
    await h.run(COMMANDS.newSessionInProject, PROJECT_ARG);
    expect(h.calls.added).toEqual([]);
    expect(h.calls.launches).toHaveLength(1);
    expect(h.calls.launches[0].cwd).toBe(REPO);
  });

  it("stops and shows git's own words when the add fails — no session", async () => {
    const h = autoHarness({
      addWorktree: async () => ({ ok: false, output: 'fatal: boom' }),
    });
    await h.run(COMMANDS.newSessionInProject, PROJECT_ARG);
    expect(h.calls.launches).toEqual([]);
    expect(h.calls.minted).toEqual([]);
    expect(h.calls.errors).toHaveLength(1);
    expect(h.calls.errors[0]).toContain('fatal: boom');
  });

  it('bumps past a branch name the repository already holds', async () => {
    const h = autoHarness({
      localBranches: async () => ['main', 'axel/magma-os'],
    });
    await h.run(COMMANDS.newSessionInProject, PROJECT_ARG);
    expect(h.calls.added[0].branch).toBe('axel/magma-os-2');
  });
});

describe('Remove Worktree decides the branch fate', () => {
  afterEach(() => {
    delete (mockCommands as { registerCommand?: unknown }).registerCommand;
    delete (mockWindow as WarningHost).showWarningMessage;
  });

  const REPO = '/Users/a/code/magma';
  const WT = '/Users/a/code/magma-axel-x';
  const ARG = { type: 'branch', projectId: 'p1', dir: WT, branch: 'axel/x' };

  interface FateCalls {
    dialogs: Array<{ message: string; detail: string; items: string[] }>;
    order: string[];
    deleted: Array<{ repoDir: string; branch: string }>;
    forgotten: Array<{ repoDir: string; branch: string }>;
  }

  function fateHarness(over: {
    minted?: boolean;
    ahead?: number | undefined;
    answer?: string;
  } = {}): {
    calls: FateCalls;
    run: (command: string, arg?: unknown) => Promise<void>;
  } {
    const calls: FateCalls = { dialogs: [], order: [], deleted: [], forgotten: [] };
    (mockWindow as WarningHost).showWarningMessage = async (
      message,
      opts,
      ...items
    ) => {
      calls.dialogs.push({
        message,
        detail:
          typeof (opts as { detail?: unknown })?.detail === 'string'
            ? ((opts as { detail: string }).detail)
            : '',
        items,
      });
      return over.answer;
    };
    const project = projectOf();
    const { deps } = chatDeps(project);
    const h = withRegisteredCommands({
      ...deps,
      getProject: () => project,
      getBranches: () => [
        { name: 'main', dir: REPO, colorIndex: 0, rootIds: [], primary: true, shown: true },
        { name: 'axel/x', dir: WT, colorIndex: 1, rootIds: [], primary: false, shown: true },
      ],
      removeWorktree: async () => {
        calls.order.push('removeWorktree');
        return { ok: true, output: '' };
      },
      deleteBranch: async (opts) => {
        calls.order.push('deleteBranch');
        calls.deleted.push(opts);
        return { ok: true, output: '' };
      },
      forgetMintedBranch: async (repoDir: string, branch: string) => {
        calls.forgotten.push({ repoDir, branch });
      },
      isMintedBranch: () => over.minted === true,
      aheadCount: async () => over.ahead,
    });
    return { calls, run: (command, arg) => h.run(command, arg) };
  }

  it('offers Remove and Delete Branch only for a minted, fully-merged ref — and quotes both commands', async () => {
    const h = fateHarness({ minted: true, ahead: 0, answer: undefined });
    await h.run(COMMANDS.removeWorktree, ARG);
    expect(h.calls.dialogs).toHaveLength(1);
    const d = h.calls.dialogs[0];
    expect(d.items).toEqual(['Remove and Delete Branch', 'Remove Worktree Only']);
    // The confirmation's worth is that it says exactly what will run — BOTH
    // commands, the second included because a button carries it.
    expect(d.detail).toContain('worktree remove');
    expect(d.detail).toContain("branch -d -- axel/x");
    expect(d.detail).toContain('everything on it is on main');
    // Dismissed: nothing ran.
    expect(h.calls.order).toEqual([]);
  });

  it('runs remove THEN delete when the second button is taken, and forgets the mint', async () => {
    const h = fateHarness({ minted: true, ahead: 0, answer: 'Remove and Delete Branch' });
    await h.run(COMMANDS.removeWorktree, ARG);
    expect(h.calls.order).toEqual(['removeWorktree', 'deleteBranch']);
    expect(h.calls.deleted).toEqual([{ repoDir: REPO, branch: 'axel/x' }]);
    expect(h.calls.forgotten).toEqual([{ repoDir: REPO, branch: 'axel/x' }]);
  });

  it('keeps a minted ref with commits main does not have, and counts them', async () => {
    const h = fateHarness({ minted: true, ahead: 3 });
    await h.run(COMMANDS.removeWorktree, ARG);
    const d = h.calls.dialogs[0];
    expect(d.items).toEqual(['Remove Worktree']);
    expect(d.detail).toContain('3 commits');
    expect(d.detail).not.toContain('branch -d');
  });

  it('never offers deletion for a ref Flock did not mint', async () => {
    const h = fateHarness({ minted: false, ahead: 0 });
    await h.run(COMMANDS.removeWorktree, ARG);
    const d = h.calls.dialogs[0];
    expect(d.items).toEqual(['Remove Worktree']);
    expect(d.detail).toContain('is kept');
  });
});

describe('archiving the last session in a minted worktree offers the cleanup', () => {
  afterEach(() => {
    delete (mockCommands as { registerCommand?: unknown }).registerCommand;
    delete (mockWindow as InfoHost).showInformationMessage;
    delete (mockWindow as ErrorHost).showErrorMessage;
  });

  const REPO = '/Users/a/code/magma';
  const WT = '/Users/a/code/magma-axel-x';
  const S1 = uuid(7);
  const S2 = uuid(8);

  function offerHarness(over: {
    minted?: boolean;
    secondSession?: boolean;
  } = {}): {
    infos: string[];
    errors: string[];
    warns: string[];
    run: (command: string, arg?: unknown) => Promise<void>;
  } {
    const infos: string[] = [];
    const errors: string[] = [];
    const warns: string[] = [];
    (mockWindow as InfoHost).showInformationMessage = async (message) => {
      infos.push(message);
      return undefined; // the undo toast expires; the offer is declined
    };
    (mockWindow as ErrorHost).showErrorMessage = async (message) => {
      errors.push(message);
      return undefined;
    };
    // 0.1.7 moved the confirm from an info message to a MODAL warning, so the
    // harness has to answer it here or the flow stops before it writes
    // anything — and the offer this block is about never gets reached. Takes
    // the confirm button (the last item passed) rather than a literal, so a
    // reworded button does not quietly turn these three tests into no-ops.
    (mockWindow as unknown as { showWarningMessage?: unknown }).showWarningMessage =
      async (message: string, ...rest: unknown[]) => {
        warns.push(message);
        const items = rest.filter((r): r is string => typeof r === 'string');
        return items[items.length - 1];
      };
    const project = projectOf();
    const { deps } = chatDeps(project);
    const deletedIds = new Set<string>();
    const nodes = () => {
      const out = [
        node(S1, { cwd: WT, label: 'magma-os 2', deleted: deletedIds.has(S1) }),
      ];
      if (over.secondSession === true) {
        out.push(node(S2, { cwd: WT, label: 'magma-os 3', deleted: deletedIds.has(S2) }));
      }
      return out;
    };
    const h = withRegisteredCommands({
      ...deps,
      getForest: () => forestOf(nodes()),
      allProjects: () => [project],
      getProject: () => project,
      upsertRecord: async (id, patch) => {
        if (patch.deleted === true) deletedIds.add(id);
        if (patch.deleted === false) deletedIds.delete(id);
      },
      getBranches: () => [
        { name: 'main', dir: REPO, colorIndex: 0, rootIds: [], primary: true, shown: true },
        { name: 'axel/x', dir: WT, colorIndex: 1, rootIds: [], primary: false, shown: true },
      ],
      isMintedBranch: () => over.minted !== false,
    });
    return { infos, errors, warns, run: (command, arg) => h.run(command, arg) };
  }

  it('offers once, after the undo window, naming the branch', async () => {
    const h = offerHarness();
    await h.run(COMMANDS.deleteSession, S1);
    expect(h.errors).toEqual([]);
    expect(h.infos).toHaveLength(2);
    expect(h.infos[0]).toContain('Archived');
    expect(h.infos[1]).toContain('"axel/x" has no sessions left');
  });

  it('stays quiet while any session still lives there — closed ones included', async () => {
    const h = offerHarness({ secondSession: true });
    await h.run(COMMANDS.deleteSession, S1);
    expect(h.infos).toHaveLength(1);
  });

  it('stays quiet for a worktree Flock did not mint', async () => {
    const h = offerHarness({ minted: false });
    await h.run(COMMANDS.deleteSession, S1);
    expect(h.infos).toHaveLength(1);
  });
});

// The gear is built when it opens so that each toggle can carry the direction
// it goes — a claim the manifest cannot check, since nothing there declares the
// menu. These read it the way a person does: the unit double has no
// QuickPickItemKind, so the separators are not emitted and the list is flat,
// and the codicon prefix is stripped so the assertions name the titles shown.
describe('the gear menu offers each section switch one way round', () => {
  type MenuState = ReturnType<NonNullable<CommandDeps['menuState']>>;

  afterEach(() => {
    delete (mockCommands as { registerCommand?: unknown }).registerCommand;
    delete (mockCommands as CommandHost).executeCommand;
    delete (mockWindow as QuickPickHost).showQuickPick;
    delete (mockWindow as StatusHost).setStatusBarMessage;
  });

  /** Opens the gear against a wiring that reports `state` — undefined being a
   *  wiring with no menuState at all — answers the pick with the row titled
   *  `choose` (undefined dismisses), and returns the titles offered and the
   *  commands that ran. */
  async function openGear(
    state: MenuState | undefined,
    choose?: string,
  ): Promise<{ offered: string[]; ran: string[] }> {
    const { deps } = chatDeps(projectOf());
    const { accounts } = fakeAccountDeps([]);
    const wired: AccountCommandDeps = { ...deps, accounts };
    if (state !== undefined) wired.menuState = () => state;
    const offered: string[] = [];
    const ran: string[] = [];
    (mockWindow as QuickPickHost).showQuickPick = async (items) => {
      const rows = (items as { label: string; kind?: number }[]).filter(
        (i) => i.kind === undefined,
      );
      const titles = rows.map((r) => r.label.replace(/^\$\([^)]+\) /, ''));
      offered.push(...titles);
      if (choose === undefined) return undefined;
      const at = titles.indexOf(choose);
      return at === -1 ? undefined : rows[at];
    };
    (mockCommands as CommandHost).executeCommand = async (id) => {
      ran.push(id);
      return undefined;
    };
    const harness = withRegisteredCommands(wired);
    await harness.run(COMMANDS.settingsMenu);
    return { offered, ran };
  }

  const known = (over: Partial<MenuState> = {}): MenuState => ({
    hooksInstalled: true,
    onlyActive: false,
    accountsSection: true,
    shellsSection: true,
    ...over,
  });

  it('offers Hide Accounts Section, and not Show, while the section is drawn', async () => {
    const { offered } = await openGear(known({ accountsSection: true }));
    expect(offered).toContain('Hide Accounts Section');
    expect(offered).not.toContain('Show Accounts Section');
  });

  it('offers Show Accounts Section, and not Hide, while it is folded away', async () => {
    const { offered } = await openGear(known({ accountsSection: false }));
    expect(offered).toContain('Show Accounts Section');
    expect(offered).not.toContain('Hide Accounts Section');
  });

  it('does the same for Shells', async () => {
    const drawn = await openGear(known({ shellsSection: true }));
    expect(drawn.offered).toContain('Hide Shells Section');
    expect(drawn.offered).not.toContain('Show Shells Section');

    const folded = await openGear(known({ shellsSection: false }));
    expect(folded.offered).toContain('Show Shells Section');
    expect(folded.offered).not.toContain('Hide Shells Section');
  });

  it('keeps the two pairs together, Accounts first, as one Sections group', async () => {
    const { offered } = await openGear(known());
    const accounts = offered.indexOf('Hide Accounts Section');
    expect(accounts).toBeGreaterThan(-1);
    expect(offered[accounts + 1]).toBe('Hide Shells Section');
  });

  it('offers both halves of each pair when the wiring cannot say which way it goes', async () => {
    // Absent state must not guess: the wrong label on a toggle is worse than
    // two entries.
    const { offered } = await openGear(undefined);
    for (const title of [
      'Show Accounts Section',
      'Hide Accounts Section',
      'Show Shells Section',
      'Hide Shells Section',
    ]) {
      expect(offered).toContain(title);
    }
  });

  it('runs the command behind the row that was picked', async () => {
    const shells = await openGear(known(), 'Hide Shells Section');
    expect(shells.ran).toEqual([COMMANDS.hideShellsSection]);

    const accounts = await openGear(
      known({ accountsSection: false }),
      'Show Accounts Section',
    );
    expect(accounts.ran).toEqual([COMMANDS.showAccountsSection]);
  });

  it('runs nothing when the menu is dismissed', async () => {
    const { ran } = await openGear(known());
    expect(ran).toEqual([]);
  });

  // The Setup group is the top of the menu, and its order is an argument: the
  // settings page for the person who knows what they want, the status for the
  // person checking, the checklist for the person who does not know yet, the
  // model picker, and the advanced rows last because they are the ones a
  // first-time reader is meant to be able to skip.
  it('opens with the Setup group in the order the design reads', async () => {
    const { offered } = await openGear(known());
    expect(offered.slice(0, 5)).toEqual([
      'Flock Settings...',
      'Status...',
      'Recommended Setup...',
      'Choose Window Model...',
      'Open Advanced Settings',
    ]);
  });

  it('runs the settings verbs behind the rows that open them', async () => {
    const settings = await openGear(known(), 'Flock Settings...');
    expect(settings.ran).toEqual([COMMANDS.openSettings]);
    const status = await openGear(known(), 'Status...');
    expect(status.ran).toEqual([COMMANDS.showStatus]);
    const advanced = await openGear(known(), 'Open Advanced Settings');
    expect(advanced.ran).toEqual([COMMANDS.openAdvancedSettings]);
  });
});

// The two settings verbs open the BUILT-IN editor at a filter — there is no
// page of Flock's own — and the Status verb draws facts whose pick runs an
// existing flow. These check the door, not the room: the query handed to the
// workbench, and that a picked row reaches the verb the fact names.
describe('the settings editor verbs and the Status picker', () => {
  type World = Awaited<ReturnType<NonNullable<CommandDeps['recommendedWorld']>>>;

  afterEach(() => {
    delete (mockCommands as { registerCommand?: unknown }).registerCommand;
    delete (mockCommands as CommandHost).executeCommand;
    delete (mockWindow as QuickPickHost).showQuickPick;
    delete (mockWindow as QuickPickHost).showInformationMessage;
    delete (mockWindow as StatusHost).setStatusBarMessage;
  });

  /** tmux installed and on, hooks not yet, verbs in, a claude on PATH and no
   *  codex anywhere — a machine with exactly one thing left to fix. */
  const world: World = {
    platform: 'darwin',
    tmuxBinary: '/opt/homebrew/bin/tmux',
    tmuxMode: 'auto',
    hooksInstalled: false,
    verbsInstalled: true,
    verbsAvailable: true,
    hasProjects: true,
    unlistedCount: 0,
    branchRowsEnabled: false,
    maxWorktrees: 1,
    terminalLocation: 'editor',
    soloSession: false,
    launchMode: 'flock',
    claudeExtensionInstalled: false,
    mode: undefined,
    workspacesEnabled: true,
  };

  function harnessWith(over: Partial<AccountCommandDeps> = {}): {
    run: (id: string, ...args: unknown[]) => Promise<void>;
    executed: { id: string; args: unknown[] }[];
  } {
    const { deps } = chatDeps(projectOf());
    const { accounts } = fakeAccountDeps([]);
    const executed: { id: string; args: unknown[] }[] = [];
    (mockCommands as CommandHost).executeCommand = async (id, ...args) => {
      executed.push({ id, args });
      return undefined;
    };
    const harness = withRegisteredCommands({ ...deps, accounts, ...over });
    return { run: harness.run, executed };
  }

  it('opens the editor filtered to Flock, and to the advanced rows', async () => {
    const { run, executed } = harnessWith();
    await run(COMMANDS.openSettings);
    await run(COMMANDS.openAdvancedSettings);
    expect(executed).toEqual([
      { id: 'workbench.action.openSettings', args: ['@ext:hjulaxel.flock'] },
      {
        id: 'workbench.action.openSettings',
        args: ['@ext:hjulaxel.flock @tag:advanced'],
      },
    ]);
  });

  it('draws the facts as rows and runs the verb behind the one picked', async () => {
    const offered: { label: string; description?: string }[] = [];
    (mockWindow as QuickPickHost).showQuickPick = async (items) => {
      const rows = items as { label: string; description?: string }[];
      offered.push(...rows);
      return rows.find((r) => r.label.endsWith('Instant-update hooks'));
    };
    const { run, executed } = harnessWith({
      recommendedWorld: async () => world,
      cliBinaries: () => ({
        claude: '/usr/local/bin/claude',
        codex: null,
        codexConfigured: false,
      }),
    });
    await run(COMMANDS.showStatus);
    const titles = offered.map((r) => r.label.replace(/^\$\([^)]+\) /, ''));
    expect(titles).toEqual([
      'tmux',
      'Instant-update hooks',
      'In-session verbs',
      'claude CLI',
      'Window model',
      'Where sessions open',
    ]);
    expect(offered[0]?.description).toBe('installed at /opt/homebrew/bin/tmux, on');
    expect(offered[1]?.description).toBe('not installed');
    // Picking the hooks row runs the install — the same contributed command
    // the gear and the palette run, by id.
    expect(executed.map((e) => e.id)).toEqual([COMMANDS.installHooks]);
  });

  it('opens the editor at the key when a binary row is picked', async () => {
    (mockWindow as QuickPickHost).showQuickPick = async (items) =>
      (items as { label: string }[]).find((r) => r.label.endsWith('claude CLI'));
    const { run, executed } = harnessWith({
      recommendedWorld: async () => world,
      cliBinaries: () => ({ claude: null, codex: null, codexConfigured: false }),
    });
    await run(COMMANDS.showStatus);
    expect(executed).toEqual([
      { id: 'workbench.action.openSettings', args: ['lineage.claudeBinary'] },
    ]);
  });

  it('says so, and runs nothing, in a window without the world', async () => {
    const said: string[] = [];
    (mockWindow as QuickPickHost).showInformationMessage = async (message) => {
      said.push(message);
      return undefined;
    };
    const { run, executed } = harnessWith();
    await run(COMMANDS.showStatus);
    expect(said).toEqual(['Flock: status is not available in this window.']);
    expect(executed).toEqual([]);
  });

  it('the Shells pair writes the value each half names, through the wiring', async () => {
    const wrote: boolean[] = [];
    const { deps } = chatDeps(projectOf());
    const { accounts } = fakeAccountDeps([]);
    (mockWindow as StatusHost).setStatusBarMessage = () => undefined;
    const harness = withRegisteredCommands({
      ...deps,
      accounts,
      setShellsSection: async (on) => {
        wrote.push(on);
      },
    });
    await harness.run(COMMANDS.hideShellsSection);
    await harness.run(COMMANDS.showShellsSection);
    expect(wrote).toEqual([false, true]);
  });
});
