// test/webtree.test.ts — src/webtree.ts, the extension half of the webview
// sidebar: the message protocol the client speaks to it, the row-key parsing
// that turns a click into a session id, and the subscription bookkeeping.
//
// `LineageWebtreeProvider` is constructed directly — never through
// registerWebtree() or resolveWebviewView(), and html() is never called: the
// mock's Uri has no joinPath (test/mocks/vscode.ts), so any path that
// reaches vscode.Uri.joinPath throws. resolveWebviewView() calls html()
// unconditionally, so tests instead reach into the provider's private state
// with a cast — the same technique test/terminals.test.ts uses to seed a
// TerminalRegistry's `bound` map directly — and drive its private onMessage()
// the way the extension's own onDidReceiveMessage listener would.
//
// post()/rows()/refresh() ARE safe to call, despite also touching
// vscode.Uri.joinPath (inside iconMap()/mediaUri()): mediaUri() wraps that
// call in its own try/catch and degrades to '', so those methods only ever
// throw from html() itself.

import { afterEach, describe, expect, it } from 'vitest';

import {
  LineageWebtreeProvider,
  buildCsp,
  projectIdFromKey,
  sessionIdFromKey,
  sessionIdsFromKeys,
} from '../src/webtree';
import type { WebtreeDeps } from '../src/webtree';
import {
  folderRowKey,
  projectRowKey,
  sessionRowKey,
  subprojectRowKey,
} from '../src/viewmodel';
import type { ViewRow } from '../src/viewmodel';
import type {
  ProjectRecord,
  ProviderId,
  SessionForest,
  SessionNode,
  Worktree,
} from '../src/types';
import { Uri, commands } from './mocks/vscode';
// src/webtree.ts's own `import * as vscode from 'vscode'` resolves (for tsc,
// as opposed to vitest's runtime alias) to the REAL @types/vscode ambient
// declaration, so `LineageWebtreeProvider`'s `extensionUri: vscode.Uri`
// parameter is typed against that real Uri — which has a `toJSON` the mock's
// Uri does not implement. The bridge cast below is the only place that
// mismatch matters: `extensionUri` is never dereferenced by anything this
// file exercises (html()/mediaUri() are the only readers, and both are
// either unreachable or degrade through their own try/catch — see the file
// banner), so any object shaped enough to be a Uri is fine at runtime.
import type { Uri as RealUri } from 'vscode';

// ------------------------------------------------------------------ helpers

const ROOT = '0f00000a-0000-4000-8000-00000000000a';
const GHOST = '0f00000b-0000-4000-8000-00000000000b';
const CHILD = '0f00000c-0000-4000-8000-00000000000c';
const LEFTOVER = '0f00000d-0000-4000-8000-00000000000d';
const UNKNOWN = '0f000099-0000-4000-8000-000000000099';

const EXT_URI = Uri.file('/ext') as unknown as RealUri;

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

interface DepsCalls {
  assignToProject: Array<[string, string]>;
  renameSession: Array<[string, string]>;
  renameProject: Array<[string, string]>;
  renameCancelled: number;
  activateSession: string[];
  runCommand: Array<[string, unknown]>;
}

function makeDeps(
  forest: SessionForest,
  over: Partial<{
    projects: () => ProjectRecord[];
    groupByFolder: () => boolean;
    hiddenFolders: () => string[];
    onlyProjectSessions: () => boolean;
    isBoundHere: (id: string) => boolean;
    providerFor: (id: string) => ProviderId;
    worktreesOf: (dir: string) => readonly Worktree[];
    branchRows: () => boolean;
    groupSessionsByBranch: () => boolean;
    onlyActiveSessions: () => boolean;
  }> = {},
): { deps: WebtreeDeps; calls: DepsCalls } {
  const calls: DepsCalls = {
    assignToProject: [],
    renameSession: [],
    renameProject: [],
    renameCancelled: 0,
    activateSession: [],
    runCommand: [],
  };
  const deps: WebtreeDeps = {
    getForest: () => forest,
    onDidChangeData: () => ({ dispose: () => undefined }),
    isBoundHere: over.isBoundHere ?? (() => false),
    worktreesOf: over.worktreesOf ?? (() => []),
    branchRows: over.branchRows ?? (() => false),
    groupSessionsByBranch: over.groupSessionsByBranch ?? (() => false),
    groupByFolder: over.groupByFolder ?? (() => false),
    projects: over.projects ?? (() => []),
    hiddenFolders: over.hiddenFolders ?? (() => []),
    onlyProjectSessions: over.onlyProjectSessions ?? (() => false),
    ...(over.onlyActiveSessions === undefined
      ? {}
      : { onlyActiveSessions: over.onlyActiveSessions }),
    providerFor: over.providerFor ?? (() => 'claude'),
    mediaPath: () => undefined,
    assignToProject: async (sessionId, projectId) => {
      calls.assignToProject.push([sessionId, projectId]);
    },
    renameSession: async (sessionId, title) => {
      calls.renameSession.push([sessionId, title]);
    },
    renameProject: async (projectId, name) => {
      calls.renameProject.push([projectId, name]);
    },
    renameCancelled: () => {
      calls.renameCancelled++;
    },
    activateSession: async (sessionId) => {
      calls.activateSession.push(sessionId);
    },
    runCommand: async (command, arg) => {
      calls.runCommand.push([command, arg]);
    },
  };
  return { deps, calls };
}

/** A fake WebviewView: just enough surface for post()/reveal()/beginRename().
 *  Never wired through resolveWebviewView() — see the file banner. */
function fakeView(
  over: Partial<{
    visible: boolean;
    postMessage: (msg: unknown) => Promise<unknown>;
  }> = {},
) {
  return {
    visible: over.visible ?? true,
    webview: {
      postMessage: over.postMessage ?? (async () => true),
      asWebviewUri: (u: unknown) => u,
      cspSource: 'vscode-webview://x',
    },
    onDidDispose: () => ({ dispose: () => undefined }),
    onDidChangeVisibility: () => ({ dispose: () => undefined }),
    onDidReceiveMessage: () => ({ dispose: () => undefined }),
  };
}

type FakeView = ReturnType<typeof fakeView>;

/** Reaches past `private` for the fields/methods no public API exposes. */
interface Internals {
  view?: FakeView;
  collapsed: Set<string>;
  onMessage(msg: Record<string, unknown>): Promise<void>;
  rows(): ViewRow[];
}

function internals(p: LineageWebtreeProvider): Internals {
  return p as unknown as Internals;
}

// -------------------------------------------------------------- buildCsp

describe('buildCsp', () => {
  it('nonces both style-src and script-src', () => {
    // REGRESSION. style-src carried no nonce, so Chromium silently
    // dropped the <style nonce> block defining every --lineage-* colour.
    const csp = buildCsp('ABC123', 'vscode-webview://x');
    expect(csp).toContain("style-src 'nonce-ABC123' vscode-webview://x");
    expect(csp).toContain("script-src 'nonce-ABC123'");
  });

  it('still authorises the external stylesheet <link> via cspSource', () => {
    const csp = buildCsp('ABC123', 'vscode-webview://x');
    expect(csp).toContain('img-src vscode-webview://x');
    expect(csp).toContain('font-src vscode-webview://x');
  });
});

// ---------------------------------------------------------------- sessionIdFromKey

describe('sessionIdFromKey', () => {
  it('accepts only a well-formed session: key', () => {
    expect(sessionIdFromKey(`session:${ROOT}`)).toBe(ROOT);
  });

  it('rejects everything else', () => {
    expect(sessionIdFromKey(`project:${ROOT}`)).toBeUndefined();
    expect(sessionIdFromKey(`folder:${ROOT}`)).toBeUndefined();
    expect(sessionIdFromKey(123)).toBeUndefined();
    expect(sessionIdFromKey(undefined)).toBeUndefined();
    expect(sessionIdFromKey(null)).toBeUndefined();
    expect(sessionIdFromKey('session:not-a-uuid')).toBeUndefined();
    expect(sessionIdFromKey('')).toBeUndefined();
  });
});

// ------------------------------------------------------------ sessionIdsFromKeys
// What the page reports as selected, turned into ids a verb can act on.

describe('sessionIdsFromKeys', () => {
  it('keeps the session keys, in the order the page sent them', () => {
    expect(
      sessionIdsFromKeys([
        `session:${CHILD}`,
        `session:${ROOT}`,
      ]),
    ).toEqual([CHILD, ROOT]);
  });

  it('drops the rows that are not sessions rather than refusing the lot', () => {
    // A selection is allowed to run across a project header — shift-clicking
    // down a tree does exactly that. The answer for a SESSION verb is that the
    // header is not one of its rows, not that the gesture was invalid.
    expect(
      sessionIdsFromKeys([
        `session:${ROOT}`,
        'project:p1',
        'folder:/tmp/w',
        `session:${CHILD}`,
      ]),
    ).toEqual([ROOT, CHILD]);
  });

  it('never names the same session twice', () => {
    // The client holds its selection in a Set and cannot produce a duplicate.
    // The delete path must not depend on that: deleting a row twice is a
    // second write, and the undo would only put one back.
    expect(
      sessionIdsFromKeys([`session:${ROOT}`, `session:${ROOT}`]),
    ).toEqual([ROOT]);
  });

  it('answers nothing for junk, and for a message with no list at all', () => {
    expect(sessionIdsFromKeys(undefined)).toEqual([]);
    expect(sessionIdsFromKeys('session:' + ROOT)).toEqual([]);
    expect(sessionIdsFromKeys([1, null, {}, 'session:nope'])).toEqual([]);
  });
});

// ---------------------------------------------------------------- projectIdFromKey

describe('projectIdFromKey', () => {
  it('accepts a project: key of any non-empty id', () => {
    expect(projectIdFromKey('project:p1')).toBe('p1');
    expect(projectIdFromKey(`project:${ROOT}`)).toBe(ROOT);
  });

  it('rejects every other row kind and every non-string', () => {
    expect(projectIdFromKey(`session:${ROOT}`)).toBeUndefined();
    expect(projectIdFromKey('folder:/w')).toBeUndefined();
    expect(projectIdFromKey('project:')).toBeUndefined();
    expect(projectIdFromKey(123)).toBeUndefined();
    expect(projectIdFromKey(undefined)).toBeUndefined();
    expect(projectIdFromKey(null)).toBeUndefined();
    expect(projectIdFromKey('')).toBeUndefined();
  });
});

describe('row-key round trips', () => {
  // The two id spaces are independent and share no discriminator: a project id
  // is a bare uuid too, so a project id fed through the session reader must
  // come back undefined rather than being accepted as a session.
  it('each reader accepts only its own writer, even for uuid-shaped ids', () => {
    expect(sessionIdFromKey(sessionRowKey(ROOT))).toBe(ROOT);
    expect(projectIdFromKey(projectRowKey(ROOT))).toBe(ROOT);
    expect(projectIdFromKey(sessionRowKey(ROOT))).toBeUndefined();
    expect(sessionIdFromKey(projectRowKey(ROOT))).toBeUndefined();
    expect(sessionIdFromKey(folderRowKey('/w'))).toBeUndefined();
    expect(projectIdFromKey(folderRowKey('/w'))).toBeUndefined();
  });
});

// ------------------------------------------------------------------ rename

describe('LineageWebtreeProvider inline rename (via the "rename" message)', () => {
  function setup() {
    const forest = forestOf([node(ROOT, { cwd: '/proj' })]);
    const { deps, calls } = makeDeps(forest, {
      projects: () => [project('p1', 'P1', '/proj')],
    });
    const provider = new LineageWebtreeProvider(deps, EXT_URI);
    const priv = internals(provider);
    priv.view = fakeView();
    return { calls, priv, provider };
  }

  it('routes a session key to renameSession', async () => {
    const { calls, priv } = setup();
    await priv.onMessage({
      type: 'rename',
      key: sessionRowKey(ROOT),
      name: '  renamed  ',
    });
    expect(calls.renameSession).toEqual([[ROOT, 'renamed']]);
    expect(calls.renameProject).toEqual([]);
  });

  // REGRESSION (P3). A project row is editable in the client exactly like a
  // session row, but the committed name was only ever matched against
  // `session:` keys — so an inline project rename was silently dropped and the
  // row snapped back to its old label with no error anywhere.
  it('routes a project key to renameProject', async () => {
    const { calls, priv } = setup();
    await priv.onMessage({
      type: 'rename',
      key: projectRowKey('p1'),
      name: '  Renamed Project  ',
    });
    expect(calls.renameProject).toEqual([['p1', 'Renamed Project']]);
    expect(calls.renameSession).toEqual([]);
  });

  it('drops a rename aimed at a row kind that owns no name', async () => {
    const { calls, priv } = setup();
    await priv.onMessage({
      type: 'rename',
      key: folderRowKey('/proj'),
      name: 'nope',
    });
    expect(calls.renameSession).toEqual([]);
    expect(calls.renameProject).toEqual([]);
  });

  it('drops an empty or whitespace-only name for either row kind', async () => {
    const { calls, priv } = setup();
    await priv.onMessage({ type: 'rename', key: sessionRowKey(ROOT), name: '  ' });
    await priv.onMessage({ type: 'rename', key: projectRowKey('p1'), name: '' });
    expect(calls.renameSession).toEqual([]);
    expect(calls.renameProject).toEqual([]);
  });

  // An edit that ends with no name has to say so. The extension arms a
  // hand-the-keyboard-back target when it opens the editor, and silence on the
  // Escape path leaves it armed for the next rename of the same row.
  it('routes a cancelled edit so the focus hand-back can be disarmed', async () => {
    const { calls, priv } = setup();
    await priv.onMessage({ type: 'renameCancelled' });
    expect(calls.renameCancelled).toBe(1);
    expect(calls.renameSession).toEqual([]);
    expect(calls.renameProject).toEqual([]);
  });
});

// ----------------------------------------------------------- beginRenameProject

describe('LineageWebtreeProvider.beginRenameProject', () => {
  function setup(postMessage?: (msg: unknown) => Promise<unknown>) {
    const forest = forestOf([node(ROOT, { cwd: '/proj' })]);
    const { deps } = makeDeps(forest, {
      projects: () => [project('p1', 'P1', '/proj')],
    });
    const provider = new LineageWebtreeProvider(deps, EXT_URI);
    const priv = internals(provider);
    priv.view = fakeView(postMessage ? { postMessage } : {});
    return { provider, priv };
  }

  it('posts the project row key, so the client edits the right row', async () => {
    const posted: unknown[] = [];
    const { provider } = setup(async (msg) => {
      posted.push(msg);
      return true;
    });
    expect(await provider.beginRenameProject('p1')).toBe(true);
    expect(posted).toContainEqual({
      type: 'beginRename',
      key: projectRowKey('p1'),
    });
  });

  it('returns false for a project that has no row', async () => {
    // The caller has to know, so it can fall back to the quick-input rename
    // instead of silently doing nothing.
    const { provider } = setup();
    expect(await provider.beginRenameProject('gone')).toBe(false);
  });

  it('returns false when the view has not resolved', async () => {
    const forest = forestOf([node(ROOT, { cwd: '/proj' })]);
    const { deps } = makeDeps(forest, {
      projects: () => [project('p1', 'P1', '/proj')],
    });
    const provider = new LineageWebtreeProvider(deps, EXT_URI);
    expect(await provider.beginRenameProject('p1')).toBe(false);
  });
});

// ------------------------------------------------------------------ row actions

describe('LineageWebtreeProvider row actions (via the "action" message)', () => {
  function setup() {
    const forest = forestOf([node(ROOT, { cwd: '/proj' })]);
    const { deps, calls } = makeDeps(forest, {
      projects: () => [project('p1', 'P1', '/proj')],
    });
    const provider = new LineageWebtreeProvider(deps, EXT_URI);
    const priv = internals(provider);
    priv.view = fakeView();
    return { calls, priv };
  }

  it('routes the chat action to chatInProject with a project-shaped arg', async () => {
    const { calls, priv } = setup();
    await priv.onMessage({ type: 'action', key: 'project:p1', action: 'chat' });
    // Exactly what projectIdFromArg() reads, so the handler cannot tell this
    // from a native context-menu invocation.
    expect(calls.runCommand).toEqual([
      ['chatInProject', { type: 'project', projectId: 'p1' }],
    ]);
  });

  // The `+` on a project row. Same door as the chat, same arg shape, so
  // the handler cannot tell a row button from a context-menu click.
  it('routes the new-session action to newSessionInProject', async () => {
    const { calls, priv } = setup();
    await priv.onMessage({
      type: 'action',
      key: 'project:p1',
      action: 'newSession',
    });
    expect(calls.runCommand).toEqual([
      ['newSessionInProject', { type: 'project', projectId: 'p1' }],
    ]);
  });

  it('refuses an action name it was never offered', async () => {
    // The client sends an ALLOWLISTED action, never a command id — a page that
    // invents one must not be able to name a verb through this door.
    const { calls, priv } = setup();
    await priv.onMessage({
      type: 'action',
      key: 'project:p1',
      action: 'deleteProject',
    });
    expect(calls.runCommand).toEqual([]);
  });

  it('refuses a chat action aimed at a row that is not a project', async () => {
    const { calls, priv } = setup();
    await priv.onMessage({
      type: 'action',
      key: `session:${ROOT}`,
      action: 'chat',
    });
    expect(calls.runCommand).toEqual([]);
  });
});

// ------------------------------------------------------------------ beginRename

describe('LineageWebtreeProvider.beginRename', () => {
  function setup() {
    const forest = forestOf([
      node(ROOT, { cwd: '/proj' }),
      node(GHOST, { ghost: true, status: 'exited' }),
    ]);
    const { deps, calls } = makeDeps(forest);
    const provider = new LineageWebtreeProvider(deps, EXT_URI);
    return { provider, calls, priv: internals(provider) };
  }

  it('returns false when the view has not resolved', async () => {
    const { provider } = setup();
    expect(await provider.beginRename(ROOT)).toBe(false);
  });

  it('returns false when the view is resolved but not visible', async () => {
    const { provider, priv } = setup();
    priv.view = fakeView({ visible: false });
    expect(await provider.beginRename(ROOT)).toBe(false);
  });

  it('returns false for an unknown session id', async () => {
    const { provider, priv } = setup();
    priv.view = fakeView();
    expect(await provider.beginRename(UNKNOWN)).toBe(false);
  });

  it('returns false for a ghost row (canRename: false)', async () => {
    const { provider, priv } = setup();
    priv.view = fakeView();
    expect(await provider.beginRename(GHOST)).toBe(false);
  });

  // REGRESSION. beginRename used to return the postMessage delivery
  // boolean, so commands.ts's quick-input fallback ran only when the message
  // failed to REACH the client — never when the client itself refused the
  // row. The row check above is what makes this test meaningful: without it,
  // the ghost case above would also have returned true.
  it('returns true for a real renameable row when the client confirms delivery', async () => {
    const { provider, priv } = setup();
    priv.view = fakeView({ postMessage: async () => true });
    expect(await provider.beginRename(ROOT)).toBe(true);
  });

  it('still returns the delivery boolean when no session id is given (F2 with no explicit row)', async () => {
    const { provider, priv } = setup();
    priv.view = fakeView({ postMessage: async () => false });
    expect(await provider.beginRename()).toBe(false);
  });
});

// ------------------------------------------------------------------ focusView

describe('LineageWebtreeProvider.focusView', () => {
  /** The mock's `commands` is an empty object, which IS the "this host offers
   *  no such command" case. A test that needs the workbench half installs it
   *  for its own duration and takes it away again — the mock module object is
   *  shared with src/webtree.ts's own `import * as vscode`, which is exactly
   *  what makes the stub visible to the code under test. */
  type CommandHost = {
    executeCommand?: (id: string, ...rest: unknown[]) => Promise<unknown>;
  };

  afterEach(() => {
    delete (commands as CommandHost).executeCommand;
  });

  function setup() {
    const forest = forestOf([node(ROOT, { cwd: '/proj' })]);
    const { deps } = makeDeps(forest);
    const provider = new LineageWebtreeProvider(deps, EXT_URI);
    return { provider, priv: internals(provider) };
  }

  // REGRESSION. Nothing revealed the view before asking it for an
  // editable row, so "Flock: New Session" from the palette with the sidebar
  // collapsed always failed `beginRename`'s visibility check and landed in the
  // quick-input popup — the one thing the inline editor exists to replace.
  it('focuses the contributed view rather than merely revealing it', async () => {
    const asked: string[] = [];
    (commands as CommandHost).executeCommand = async (id) => {
      asked.push(id);
      return undefined;
    };
    const { provider, priv } = setup();
    priv.view = fakeView();
    await priv.onMessage({ type: 'ready' });

    expect(await provider.focusView()).toBe(true);
    // `<viewId>.focus` and not `<viewId>.reveal`/a container command: an
    // <input> focused inside a webview whose window does not have focus does
    // not receive keystrokes, so a reveal that leaves focus elsewhere renders
    // an edit box the user cannot type into.
    expect(asked).toEqual(['lineageSessionsInline.focus']);
  });

  it('waits for a view it just revealed to announce itself', async () => {
    // The cold case: the view does not exist until the focus command runs, and
    // the page that then loads is not listening until it says so. A
    // `beginRename` posted before that is a message nobody is subscribed to.
    const { provider, priv } = setup();
    expect(priv.view).toBeUndefined();
    (commands as CommandHost).executeCommand = async () => {
      priv.view = fakeView();
      await priv.onMessage({ type: 'ready' });
      return undefined;
    };
    expect(await provider.focusView()).toBe(true);
  });

  it('answers from the view itself on a host with no focus command', async () => {
    const { provider, priv } = setup();
    priv.view = fakeView();
    // Visible but never announced: the page is not listening, and claiming the
    // view is ready would swallow the rename instead of falling back to the
    // quick input.
    expect(await provider.focusView()).toBe(false);
    await priv.onMessage({ type: 'ready' });
    expect(await provider.focusView()).toBe(true);
  });

  it('answers false when the focus command throws', async () => {
    (commands as CommandHost).executeCommand = async () => {
      throw new Error('no such view');
    };
    const { provider, priv } = setup();
    priv.view = fakeView();
    await priv.onMessage({ type: 'ready' });
    // The view IS ready here, so the answer comes from its own state rather
    // than from the failure — a throwing reveal must not veto a view that is
    // already on screen.
    expect(await provider.focusView()).toBe(true);
  });

  it('stops trusting a page once its view is gone', async () => {
    const { provider, priv } = setup();
    priv.view = fakeView();
    await priv.onMessage({ type: 'ready' });
    provider.dispose();
    expect(await provider.focusView()).toBe(false);
  });
});

// ------------------------------------------------------------------ pruneCollapsed

describe('LineageWebtreeProvider.refresh() / pruneCollapsed', () => {
  // REGRESSION. Only `session:` keys were ever pruned, so a deleted
  // project's or folder's collapsed key survived forever — until the
  // CACHE_SOFT_LIMIT in the `toggle` handler tripped and wiped the whole set,
  // which read as every row on screen abruptly re-expanding at once.
  it('drops a project:<id>/folder:<key> key whose group is gone and keeps a live one', () => {
    const forest = forestOf([
      node(ROOT, { cwd: '/proj' }),
      node(LEFTOVER, { cwd: '/other' }),
    ]);
    const { deps } = makeDeps(forest, {
      projects: () => [project('p1', 'P1', '/proj')],
      groupByFolder: () => true,
    });
    const provider = new LineageWebtreeProvider(deps, EXT_URI);
    const priv = internals(provider);
    priv.view = fakeView();

    priv.collapsed.add(projectRowKey('p1')); // live
    priv.collapsed.add(projectRowKey('gone')); // stale
    priv.collapsed.add(folderRowKey('/other')); // live
    priv.collapsed.add(folderRowKey('/nonexistent')); // stale
    priv.collapsed.add(`session:${ROOT}`); // live (existing behaviour)
    priv.collapsed.add(`session:${UNKNOWN}`); // stale (existing behaviour)

    provider.refresh();

    expect(priv.collapsed.has(projectRowKey('p1'))).toBe(true);
    expect(priv.collapsed.has(projectRowKey('gone'))).toBe(false);
    expect(priv.collapsed.has(folderRowKey('/other'))).toBe(true);
    expect(priv.collapsed.has(folderRowKey('/nonexistent'))).toBe(false);
    expect(priv.collapsed.has(`session:${ROOT}`)).toBe(true);
    expect(priv.collapsed.has(`session:${UNKNOWN}`)).toBe(false);
  });

  // REGRESSION. With `lineage.onlyActiveSessions` on, the grouping is computed
  // over the FILTERED roots, so a fold the filter was merely HIDING (a folder
  // whose sessions are all closed) had its key pruned on the next tick — and
  // "Show all sessions" brought every one of those rows back expanded.
  it('keeps grouping-derived keys while the active-only filter is on, and still prunes dead session keys', () => {
    // Under the filter the /other leftover is gone entirely: the forest the
    // provider sees carries only ROOT, so the /other folder has no row.
    const forest = forestOf([node(ROOT, { cwd: '/proj' })]);
    const { deps } = makeDeps(forest, {
      projects: () => [project('p1', 'P1', '/proj')],
      groupByFolder: () => true,
      onlyActiveSessions: () => true,
    });
    const provider = new LineageWebtreeProvider(deps, EXT_URI);
    const priv = internals(provider);
    priv.view = fakeView();

    priv.collapsed.add(folderRowKey('/other')); // hidden by the filter, NOT gone
    priv.collapsed.add(projectRowKey('gone')); // stale, but unprovable right now
    priv.collapsed.add(`session:${UNKNOWN}`); // dead for real — nodes is unfiltered

    provider.refresh();

    expect(priv.collapsed.has(folderRowKey('/other'))).toBe(true);
    expect(priv.collapsed.has(projectRowKey('gone'))).toBe(true);
    expect(priv.collapsed.has(`session:${UNKNOWN}`)).toBe(false);
  });
});

// ------------------------------------------------------------------ onDrop

describe('LineageWebtreeProvider onDrop (via the "drop" message)', () => {
  function forestWithChild() {
    return forestOf([
      node(ROOT, {
        cwd: '/proj',
        children: [CHILD],
        visibleChildren: [CHILD],
      }),
      node(CHILD, { parentId: ROOT, cwd: '/proj' }),
    ]);
  }

  it('refuses every drop onto a session — lineage is not draggable', async () => {
    // The gesture that could pull a fork out of the tree it branched from, or
    // file an unrelated conversation inside one. Both directions are gone: the
    // only thing a drag states now is which project a top-level session is
    // filed under.
    const { deps, calls } = makeDeps(forestWithChild());
    const provider = new LineageWebtreeProvider(deps, EXT_URI);
    const priv = internals(provider);
    priv.view = fakeView();

    for (const [dragged, targetKey] of [
      [ROOT, `session:${CHILD}`], // into a tree (and, here, a cycle)
      [CHILD, `session:${ROOT}`], // deeper into its own tree
      [ROOT, `session:${ROOT}`], // onto itself
    ] as const) {
      await priv.onMessage({ type: 'drop', sessionId: dragged, targetKey });
    }
    expect(calls.assignToProject).toEqual([]);
  });

  it('refuses a drop onto a folder row — that was the detach gesture', async () => {
    const { deps, calls } = makeDeps(forestWithChild(), {
      groupByFolder: () => true,
    });
    const provider = new LineageWebtreeProvider(deps, EXT_URI);
    const priv = internals(provider);
    priv.view = fakeView();

    await priv.onMessage({
      type: 'drop',
      sessionId: CHILD,
      targetKey: folderRowKey('/proj'),
    });
    expect(calls.assignToProject).toEqual([]);
  });

  it('refuses a non-root drop onto a project', async () => {
    const { deps, calls } = makeDeps(forestWithChild(), {
      projects: () => [project('p1', 'P1', '/proj')],
    });
    const provider = new LineageWebtreeProvider(deps, EXT_URI);
    const priv = internals(provider);
    priv.view = fakeView();

    // A project row renders roots only, so a nested fork dropped on it would
    // silently do nothing on screen while still teaching the project a
    // directory — refused instead.
    await priv.onMessage({
      type: 'drop',
      sessionId: CHILD,
      targetKey: 'project:p1',
    });
    expect(calls.assignToProject).toHaveLength(0);
  });

  it('accepts a visible root dropped onto a project', async () => {
    const { deps, calls } = makeDeps(forestWithChild(), {
      projects: () => [project('p1', 'P1', '/proj')],
    });
    const provider = new LineageWebtreeProvider(deps, EXT_URI);
    const priv = internals(provider);
    priv.view = fakeView();

    await priv.onMessage({
      type: 'drop',
      sessionId: ROOT,
      targetKey: 'project:p1',
    });
    expect(calls.assignToProject).toEqual([[ROOT, 'p1']]);
  });

  // ------------------------------------------ a project row no longer drags

  it('declines a dragged project instead of resolving it', async () => {
    // Dropping one project onto another filed it there as a subproject. Retired:
    // a subproject is a DIRECTORY now, and the row no longer offers the drag
    // (`canDrag` is false on it). A page that sends one anyway gets nothing.
    const { deps, calls } = makeDeps(forestWithChild(), {
      projects: () => [
        project('p1', 'P1', '/proj'),
        project('p2', 'P2', '/other'),
      ],
    });
    const provider = new LineageWebtreeProvider(deps, EXT_URI);
    internals(provider).view = fakeView();

    for (const targetKey of [
      projectRowKey('p1'),
      'background',
      `session:${ROOT}`,
      projectRowKey('p2'),
    ]) {
      await internals(provider).onMessage({
        type: 'drop',
        sourceKey: projectRowKey('p2'),
        targetKey,
      });
    }
    // And in particular NEVER the session path: a project id is a bare uuid
    // too, so falling through would have filed a conversation that does not
    // exist under a project.
    expect(calls.assignToProject).toEqual([]);
  });
});

// ----------------------------------------------- the branch row's own `+`

describe('LineageWebtreeProvider: grouped branch rows', () => {
  const WORKTREES: Worktree[] = [
    { dir: '/proj', branch: 'main', head: 'aaa', detached: false },
    { dir: '/proj-feat', branch: 'feat/x', head: 'bbb', detached: false },
  ];

  function setup() {
    const forest = forestOf([node(ROOT, { cwd: '/proj' })]);
    const { deps, calls } = makeDeps(forest, {
      projects: () => [project('p1', 'P1', '/proj')],
      worktreesOf: () => WORKTREES,
      // The block's master switch — off by default, so a branch test has to ask
      // for it. See CONFIG_KEYS.gitBranches.
      branchRows: () => true,
      groupSessionsByBranch: () => true,
    });
    const provider = new LineageWebtreeProvider(deps, EXT_URI);
    internals(provider).view = fakeView();
    return { provider, calls };
  }

  it('resolves the + on a branch row through the model it rendered', async () => {
    const { provider, calls } = setup();
    await internals(provider).onMessage({
      type: 'action',
      action: 'newSessionInBranch',
      key: branchRowKey('p1', 'feat/x'),
    });
    expect(calls.runCommand).toEqual([
      [
        'newSessionInBranch',
        {
          type: 'branch',
          projectId: 'p1',
          dir: '/proj-feat',
          branch: 'feat/x',
        },
      ],
    ]);
  });

  it('refuses a branch the current model does not show', async () => {
    const { provider, calls } = setup();
    await internals(provider).onMessage({
      type: 'action',
      action: 'newSessionInBranch',
      key: branchRowKey('p1', 'no-such-branch'),
    });
    expect(calls.runCommand).toEqual([]);
  });

  it('resolves the `#42` link through the same model, on a branch row', async () => {
    const { provider, calls } = setup();
    await internals(provider).onMessage({
      type: 'action',
      action: 'openPullRequest',
      key: branchRowKey('p1', 'feat/x'),
    });
    // The command gets a CHECKOUT, never a url: it looks its own one up in the
    // cache the row rendered from. See openPullRequestFlow.
    expect(calls.runCommand).toEqual([
      [
        'openPullRequest',
        { type: 'branch', projectId: 'p1', dir: '/proj-feat', branch: 'feat/x' },
      ],
    ]);
  });

  it('refuses a link on a row the model does not have', async () => {
    const { provider, calls } = setup();
    for (const key of [
      branchRowKey('p1', 'no-such-branch'),
      'session:not-a-row',
      'background',
      '',
    ]) {
      await internals(provider).onMessage({
        type: 'action',
        action: 'openBranchOnRemote',
        key,
      });
    }
    expect(calls.runCommand).toEqual([]);
  });

  it('runs no command for an action name it was never offered', async () => {
    // The third allowlist (BRANCH_LINK_ACTIONS). A page that made a name up must
    // reach nothing at all.
    const { provider, calls } = setup();
    await internals(provider).onMessage({
      type: 'action',
      action: 'openBranchOnRemoteAndDeleteEverything',
      key: branchRowKey('p1', 'feat/x'),
    });
    expect(calls.runCommand).toEqual([]);
  });
});

// -------------------------------------- the links on a session's branch line

describe('LineageWebtreeProvider: the branch line under a session', () => {
  const WORKTREES: Worktree[] = [
    { dir: '/proj', branch: 'main', head: 'aaa', detached: false },
    { dir: '/proj-feat', branch: 'feat/x', head: 'bbb', detached: false },
  ];

  function setup() {
    // Two checkouts and a session in each, so the branch line is drawn at all
    // (BRANCH_CHIPS_MIN) — and NOT grouped, where the branch row above would say
    // it instead.
    const forest = forestOf([
      node(ROOT, { cwd: '/proj' }),
      node(CHILD, { cwd: '/proj-feat' }),
    ]);
    const { deps, calls } = makeDeps(forest, {
      projects: () => [project('p1', 'P1', '/proj')],
      worktreesOf: () => WORKTREES,
      branchRows: () => true,
    });
    const provider = new LineageWebtreeProvider(deps, EXT_URI);
    internals(provider).view = fakeView();
    return { provider, calls };
  }

  it('resolves a link on the line through the session row it lives in', async () => {
    const { provider, calls } = setup();
    await internals(provider).onMessage({
      type: 'action',
      action: 'openBranchOnRemote',
      key: `session:${CHILD}`,
    });
    // The DIRECTORY comes off the line, not off the session's cwd: a session can
    // be running in a subdirectory of the checkout, and every verb downstream
    // matches worktrees by path.
    expect(calls.runCommand).toEqual([
      [
        'openBranchOnRemote',
        { type: 'branch', projectId: 'p1', dir: '/proj-feat', branch: 'feat/x' },
      ],
    ]);
  });
});

// ---------------------------------------------------------- project rows

describe('LineageWebtreeProvider: project rows', () => {
  it('draws only the projects the deps supply', () => {
    // REGRESSION, and a standing guard rather than a test of one bug. The
    // grouping this sidebar renders is exactly what computeGrouping returned;
    // nothing is appended to it afterwards. The one time something was — the
    // demo project, spliced in behind `lineage.preview.demoProject` on the
    // argument that a fabricated project with prefixed ids and no real
    // directory could not hurt anybody — the fence held and it did not matter,
    // because `lineage.showBranchesAndWorktrees` wrote that switch ON as part
    // of the branch bundle and people who had never heard of it found a
    // project called *Flock (demo)* sitting among their own work.
    //
    // So the assertion is deliberately an equality and not a "contains": a
    // project row this side draws that no rule of membership produced is the
    // bug, whatever it is called next time.
    const forest = forestOf([node(ROOT, { cwd: '/proj' })]);
    const { deps } = makeDeps(forest, {
      projects: () => [project('p1', 'P1', '/proj')],
    });
    const provider = new LineageWebtreeProvider(deps, EXT_URI);
    internals(provider).view = fakeView();
    const drawn = internals(provider)
      .rows()
      .filter((r) => r.kind === 'project')
      .map((r) => r.label);
    expect(drawn).toEqual(['P1']);
  });
});

// --------------------------------------------- the "Still running" appendix

describe('LineageWebtreeProvider: a running process with no row of its own', () => {
  // The inline surface reads the same grouping as the native tree and must
  // make the same rescue, or the badge is honest in one view style and a lie in
  // the other. The shape is an ARCHIVED record whose process the roster still
  // reports: `deleted: true` takes the row away, `sessionIsOver` stays false,
  // so the container badge counts a process the tree draws nowhere.
  it('draws the archived-but-live session in the appendix, not as an ordinary row', () => {
    const forest = forestOf([
      node(ROOT, { cwd: '/proj', status: 'busy' }),
      node(CHILD, { cwd: '/proj', status: 'busy', deleted: true }),
    ]);
    const { deps } = makeDeps(forest);
    const provider = new LineageWebtreeProvider(deps, EXT_URI);
    internals(provider).view = fakeView();
    // The appendix is seeded COLLAPSED (it is a ledger, not a workspace), so
    // the row under it only exists once it is opened — open it, because the
    // point of the rescue is that the session can be reached from there.
    (internals(provider).collapsed as Set<string>).clear();
    const rows = internals(provider).rows();
    const appendix = rows.findIndex((r) => r.label === 'Still running');
    expect(appendix).toBeGreaterThan(-1);
    expect(rows.slice(appendix + 1).map((r) => r.key)).toContain(
      sessionRowKey(CHILD),
    );
    // ...and it is not an ordinary row anywhere above the appendix.
    expect(rows.slice(0, appendix).map((r) => r.key)).not.toContain(
      sessionRowKey(CHILD),
    );
    expect(provider.runningCount()).toBe(2);
  });
});

// ------------------------------------------------------- subproject rows

describe('LineageWebtreeProvider: subproject rows', () => {
  function setup() {
    const forest = forestOf([
      node(ROOT, { cwd: '/proj' }),
      node(CHILD, { cwd: '/proj/api' }),
    ]);
    const { deps, calls } = makeDeps(forest, {
      projects: () => [project('p1', 'P1', '/proj', { dirs: ['/proj/api'] })],
    });
    const provider = new LineageWebtreeProvider(deps, EXT_URI);
    internals(provider).view = fakeView();
    return { provider, calls };
  }

  it('resolves the + through the model it rendered, never the message', async () => {
    // The page names a ROW; this side reads the directory out of the grouping it
    // posted. A path taken from the message would be the webview naming a
    // directory for the extension to spawn a shell in.
    const { provider, calls } = setup();
    await internals(provider).onMessage({
      type: 'action',
      action: 'newSessionInSubproject',
      key: subprojectRowKey('p1', 'dir:/proj/api'),
    });
    expect(calls.runCommand).toEqual([
      [
        'newSessionInSubproject',
        { type: 'subproject', projectId: 'p1', dir: '/proj/api' },
      ],
    ]);
  });

  it('refuses a directory the current model does not show', async () => {
    const { provider, calls } = setup();
    await internals(provider).onMessage({
      type: 'action',
      action: 'newSessionInSubproject',
      key: subprojectRowKey('p1', 'dir:/etc'),
    });
    expect(calls.runCommand).toEqual([]);
  });

  it('takes a session dropped on a directory into that project', async () => {
    // The gesture means "this work belongs over there", and the row aimed at is
    // one of the project's directories — a subproject row counts as its
    // project, which is the whole of what a drag can say.
    const { provider, calls } = setup();
    await internals(provider).onMessage({
      type: 'drop',
      sessionId: ROOT,
      sourceKey: sessionRowKey(ROOT),
      targetKey: subprojectRowKey('p1', 'dir:/proj/api'),
    });
    expect(calls.assignToProject).toEqual([[ROOT, 'p1']]);
  });
});

// ------------------------------------------------------------ branch chips

import {
  branchPalette,
  branchRowParts,
  sanitizeBranchColor,
} from '../src/webtree';
import { branchRowKey } from '../src/viewmodel';
import { BRANCH_COLOR_COUNT } from '../src/projects';

describe('branchRowParts', () => {
  it('splits a branch row key into project and branch', () => {
    expect(branchRowParts('branch:p1:main')).toEqual({
      projectId: 'p1',
      branch: 'main',
    });
    expect(branchRowParts(branchRowKey(ROOT, 'feat/x'))).toEqual({
      projectId: ROOT,
      branch: 'feat/x',
    });
  });

  it('splits on the FIRST colon only, so a branch name may contain one', () => {
    // A ref may legally contain a colon; a greedy split would mangle it into a
    // project id nobody has. The project id is a uuid and cannot contain one,
    // so the first separator is always the right one.
    expect(branchRowParts('branch:p1:feat:thing')).toEqual({
      projectId: 'p1',
      branch: 'feat:thing',
    });
    expect(branchRowParts(branchRowKey(ROOT, 'a:b:c'))).toEqual({
      projectId: ROOT,
      branch: 'a:b:c',
    });
  });

  it('refuses the other rows that carry the same project id', () => {
    // A branch row and the project header name the same project under different
    // prefixes. A parser that took either would let one row's message invoke the
    // other row's verb.
    expect(branchRowParts(projectRowKey(ROOT))).toBeUndefined();
    expect(projectIdFromKey(branchRowKey(ROOT, 'main'))).toBeUndefined();
  });

  it('rejects malformed keys and every non-string', () => {
    expect(branchRowParts('branch:p1')).toBeUndefined();      // no branch
    expect(branchRowParts('branch:p1:')).toBeUndefined();     // empty branch
    expect(branchRowParts('branch::main')).toBeUndefined();   // empty project
    expect(branchRowParts(`session:${ROOT}`)).toBeUndefined();
    expect(branchRowParts(123)).toBeUndefined();
    expect(branchRowParts(undefined)).toBeUndefined();
    expect(branchRowParts(null)).toBeUndefined();
    expect(branchRowParts('')).toBeUndefined();
  });
});

describe('sanitizeBranchColor', () => {
  // This is a SECURITY boundary, not a validation nicety: the return value is
  // interpolated into an inline <style nonce> block, and the CSP that stops
  // script injection does nothing about a value that closes the declaration and
  // opens a rule of its own.

  it('accepts every hex length CSS does', () => {
    expect(sanitizeBranchColor('#abc')).toBe('#abc');
    expect(sanitizeBranchColor('#abcd')).toBe('#abcd');
    expect(sanitizeBranchColor('#7aa2f7')).toBe('#7aa2f7');
    expect(sanitizeBranchColor('#7aa2f780')).toBe('#7aa2f780');
    expect(sanitizeBranchColor('  #7AA2F7  ')).toBe('#7AA2F7');
  });

  it('turns a theme colour id into the workbench variable for it', () => {
    expect(sanitizeBranchColor('charts.blue')).toBe(
      'var(--vscode-charts-blue, var(--vscode-foreground))',
    );
    expect(sanitizeBranchColor('terminal.ansiCyan')).toBe(
      'var(--vscode-terminal-ansiCyan, var(--vscode-foreground))',
    );
  });

  it('refuses anything that could close a declaration or open a rule', () => {
    for (const attack of [
      'red; } body { display: none',
      '#fff; }',
      'url(https://evil.example/x.png)',
      'var(--x); background: url(x)',
      'expression(alert(1))',
      '#abc/*',
      'charts.blue}',
      'charts blue',
      '--lineage-done',
      'rgb(1,2,3)',
    ]) {
      expect(sanitizeBranchColor(attack), attack).toBe('');
    }
  });

  it('refuses hex that is not a hex', () => {
    expect(sanitizeBranchColor('#')).toBe('');
    expect(sanitizeBranchColor('#gg')).toBe('');
    expect(sanitizeBranchColor('#abcde')).toBe('');
    expect(sanitizeBranchColor('#abcdefg')).toBe('');
  });

  it('refuses every non-string and every empty thing', () => {
    expect(sanitizeBranchColor(undefined)).toBe('');
    expect(sanitizeBranchColor(null)).toBe('');
    expect(sanitizeBranchColor(42)).toBe('');
    expect(sanitizeBranchColor({})).toBe('');
    expect(sanitizeBranchColor('')).toBe('');
    expect(sanitizeBranchColor('   ')).toBe('');
  });
});

describe('branchPalette', () => {
  it('always returns exactly BRANCH_COLOR_COUNT entries', () => {
    // The length is a contract: projects.ts assigns colorIndex modulo this, so
    // a short palette leaves the tail on variables that do not exist.
    expect(branchPalette()).toHaveLength(BRANCH_COLOR_COUNT);
    expect(branchPalette([])).toHaveLength(BRANCH_COLOR_COUNT);
    expect(branchPalette(['#fff'])).toHaveLength(BRANCH_COLOR_COUNT);
    expect(
      branchPalette(Array(20).fill('#fff')),
    ).toHaveLength(BRANCH_COLOR_COUNT);
  });

  it('defaults to muted theme colours and spends no red', () => {
    const palette = branchPalette();
    // Softened toward the editor foreground rather than used raw — six signal
    // colours down a sidebar out-shout the status dot.
    expect(palette[0]).toContain('color-mix');
    expect(palette[0]).toContain('--vscode-charts-blue');
    // Red belongs to the attention dot (lineage.done). A branch wearing it
    // would turn the one mark that means "come back to this" into decoration.
    expect(palette.join('|')).not.toContain('charts-red');
    expect(palette.join('|')).not.toContain('ansiRed');
  });

  it('fills from the default rather than truncating', () => {
    // Setting one colour re-tints one branch, not the other five.
    const palette = branchPalette(['#7aa2f7']);
    expect(palette[0]).toBe('#7aa2f7');
    expect(palette[1]).toContain('color-mix');
  });

  it('uses a custom entry raw — the softening is the default, not a filter', () => {
    const palette = branchPalette(['#7aa2f7', 'charts.green']);
    expect(palette[0]).toBe('#7aa2f7');
    expect(palette[1]).toBe('var(--vscode-charts-green, var(--vscode-foreground))');
    expect(palette[1]).not.toContain('color-mix');
  });

  it('falls back to the built-in colour for a refused entry', () => {
    const palette = branchPalette(['red; } body {', '#7aa2f7']);
    // The bad slot keeps its default; the good one after it still applies.
    expect(palette[0]).toContain('color-mix');
    expect(palette[1]).toBe('#7aa2f7');
  });

  it('emits no CSS-breaking character, whatever it is handed', () => {
    const palette = branchPalette([
      '}',
      'a; b',
      'url(x)',
      '#fff',
      'charts.blue',
      '/*',
    ]);
    for (const value of palette) {
      expect(value).not.toContain('}');
      expect(value).not.toContain(';');
      expect(value).not.toContain('/*');
    }
  });
});
