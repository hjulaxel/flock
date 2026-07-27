// IMPLEMENTED BY: E  (M3 — the verbs)
//
// Tree row menus -> extension commands -> DIRECT function calls on CommandDeps.
// No HTTP, no subprocess-the-CLI, no marker channel: every bit of that
// machinery from the Python creemux daemon is deleted by this port.
//
// Imports allowed here: vscode, ./types, ./log, node:crypto.
// Must NOT: import terminals/state/windows/hooks (everything goes through
// CommandDeps), talk to the tree directly, or run `claude` itself.
// Every handler wraps its body in try/catch -> logError + showErrorMessage.

import { randomUUID } from 'node:crypto';

import * as vscode from 'vscode';

import { log, logError } from './log';
import {
  COMMANDS,
  CONTEXT_HOOKS_INSTALLED,
  WRAP_PROMPT,
  isSessionId,
  shortId,
} from './types';
import type {
  CommandDeps,
  DisposableLike,
  EditorialRecord,
  SessionForest,
  SessionNode,
} from './types';

// --------------------------------------------------------------- constants

/** Rename cap; keeps tree labels and terminal tab titles readable. */
const MAX_TITLE_LEN = 80;
/** An ask's opening question doubles as its title, truncated (creemux-ask). */
const ASK_TITLE_LEN = 40;

// ----------------------------------------------------------------- helpers

function nowIso(): string {
  return new Date().toISOString();
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** node:path is not an allowed import here; this is all we need of basename. */
function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter((s) => s.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : p;
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Accepts a validated session-id string, a SessionRef ({type:'session', id}),
 * or any object with a uuid-shaped `id` (a TreeItem, say). Anything else —
 * including a GroupNode and `undefined` — yields undefined, at which point the
 * handler falls back to a QuickPick so palette invocation still works.
 */
export function sessionIdFromArg(arg: unknown): string | undefined {
  if (isSessionId(arg)) return arg;
  if (arg === null || typeof arg !== 'object') return undefined;
  const obj = arg as { type?: unknown; id?: unknown };
  if (obj.type === 'group') return undefined;
  if (isSessionId(obj.id)) return obj.id;
  return undefined;
}

/** A GroupNode's cwd, when the command came from a folder row. */
function groupCwdFromArg(arg: unknown): string | undefined {
  if (arg === null || typeof arg !== 'object') return undefined;
  const obj = arg as { type?: unknown; cwd?: unknown };
  if (obj.type !== 'group') return undefined;
  return typeof obj.cwd === 'string' && obj.cwd.length > 0 ? obj.cwd : undefined;
}

/** Depth-first over roots, so QuickPicks read in the same order as the tree. */
function orderedNodes(forest: SessionForest): SessionNode[] {
  const out: SessionNode[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    const node = forest.nodes.get(id);
    if (!node) return;
    seen.add(id);
    out.push(node);
    for (const child of node.children) visit(child);
  };
  for (const root of forest.roots) visit(root);
  // Defensive: anything the roots walk missed (cut cycle, mid-tick change).
  for (const node of forest.nodes.values()) {
    if (!seen.has(node.id)) {
      seen.add(node.id);
      out.push(node);
    }
  }
  return out;
}

function isLive(node: SessionNode): boolean {
  return !node.ghost && node.status !== 'exited';
}

function pickDescription(node: SessionNode): string {
  const bits: string[] = [shortId(node.id)];
  if (node.attention === 'waiting') {
    bits.push(
      node.roster?.waitingFor ? `waiting: ${node.roster.waitingFor}` : 'waiting',
    );
  } else if (node.ghost) {
    bits.push('gone');
  } else if (node.status !== 'unknown') {
    bits.push(node.status);
  }
  return bits.join(' · ');
}

function labelFor(deps: CommandDeps, sessionId: string): string {
  const node = deps.getForest().nodes.get(sessionId);
  if (node) return node.label;
  const record = deps.getRecord(sessionId);
  return record?.title ?? shortId(sessionId);
}

function liveDescendantCount(forest: SessionForest, id: string): number {
  const root = forest.nodes.get(id);
  if (!root) return 0;
  const seen = new Set<string>([id]);
  const stack = [...root.children];
  let count = 0;
  for (;;) {
    const cur = stack.pop();
    if (cur === undefined) break;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const node = forest.nodes.get(cur);
    if (!node) continue;
    if (!node.hidden && isLive(node)) count += 1;
    stack.push(...node.children);
  }
  return count;
}

// ---------------------------------------------------------------- pickers

interface SessionPick extends vscode.QuickPickItem {
  sessionId: string;
}

interface FolderPick extends vscode.QuickPickItem {
  folder?: string;
  browse?: boolean;
}

async function pickSession(
  deps: CommandDeps,
  placeHolder: string,
  filter: (node: SessionNode) => boolean,
  emptyMessage: string,
): Promise<string | undefined> {
  const nodes = orderedNodes(deps.getForest()).filter(
    (n) => !n.hidden && filter(n),
  );
  if (nodes.length === 0) {
    void vscode.window.showInformationMessage(emptyMessage);
    return undefined;
  }
  const items: SessionPick[] = nodes.map((node) => ({
    label: node.label,
    description: pickDescription(node),
    detail: node.cwd,
    sessionId: node.id,
  }));
  const chosen = await vscode.window.showQuickPick(items, {
    placeHolder,
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  return chosen?.sessionId;
}

/**
 * Every per-session verb funnels through here: the tree row's element when it
 * came from a context menu, a QuickPick when it came from the palette.
 */
async function targetSession(
  deps: CommandDeps,
  arg: unknown,
  placeHolder: string,
  opts?: { liveOnly?: boolean; emptyMessage?: string },
): Promise<string | undefined> {
  const direct = sessionIdFromArg(arg);
  if (direct) return direct;
  const liveOnly = opts?.liveOnly ?? true;
  return pickSession(
    deps,
    placeHolder,
    (n) => (liveOnly ? isLive(n) : true),
    opts?.emptyMessage ??
      (liveOnly
        ? 'Lineage: no live Claude sessions right now.'
        : 'Lineage: no sessions in the tree yet.'),
  );
}

/** Distinct cwds known to the roster, most-populated tree order. */
function rosterFolders(deps: CommandDeps): string[] {
  const seen = new Set<string>();
  for (const node of orderedNodes(deps.getForest())) {
    if (node.cwd && node.cwd.length > 0) seen.add(node.cwd);
  }
  return [...seen];
}

/** Workspace folders first, then roster cwds, then an explicit "Other…". */
async function pickLaunchFolder(
  deps: CommandDeps,
): Promise<{ cwd?: string } | undefined> {
  const items: FolderPick[] = [];
  const listed = new Set<string>();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const fsPath = folder.uri.fsPath;
    if (listed.has(fsPath)) continue;
    listed.add(fsPath);
    items.push({
      label: `$(root-folder) ${folder.name}`,
      description: fsPath,
      folder: fsPath,
    });
  }
  for (const cwd of rosterFolders(deps)) {
    if (listed.has(cwd)) continue;
    listed.add(cwd);
    items.push({
      label: `$(folder) ${baseName(cwd)}`,
      description: cwd,
      folder: cwd,
    });
  }
  items.push({ label: '$(folder-opened) Other…', browse: true });

  const chosen = await vscode.window.showQuickPick(items, {
    placeHolder: 'Working directory for the new Claude session',
    matchOnDescription: true,
    ignoreFocusOut: true,
  });
  if (!chosen) return undefined;
  if (chosen.browse) {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Start Session Here',
    });
    const uri = picked?.[0];
    if (!uri) return undefined;
    return { cwd: uri.fsPath };
  }
  return { cwd: chosen.folder };
}

async function pickProjectFolder(
  deps: CommandDeps,
): Promise<string | undefined> {
  const folders = rosterFolders(deps);
  if (folders.length === 0) {
    void vscode.window.showInformationMessage(
      'Lineage: no session working directories to open.',
    );
    return undefined;
  }
  const items: FolderPick[] = folders.map((cwd) => ({
    label: baseName(cwd),
    description: cwd,
    folder: cwd,
  }));
  const chosen = await vscode.window.showQuickPick(items, {
    placeHolder: 'Open project folder in a new window',
    matchOnDescription: true,
    ignoreFocusOut: true,
  });
  return chosen?.folder;
}

// ------------------------------------------------------------- verb flows

/**
 * Fork = mint a child uuid, record the parent edge BEFORE launching, then
 * launch `--fork-session --resume <parent> --session-id <child>`. The edge is
 * exact by construction; nothing about it is ever inferred.
 */
async function forkFlow(
  deps: CommandDeps,
  parentId: string,
  opts?: { prompt?: string; title?: string },
): Promise<string | undefined> {
  // Claude writes a transcript lazily; there is nothing to resume until it has.
  if (!deps.hasTranscript(parentId)) {
    void vscode.window.showWarningMessage(
      'Session has no transcript yet — send one message first.',
    );
    return undefined;
  }
  const node = deps.getForest().nodes.get(parentId);
  const cwd = node?.cwd ?? deps.getRecord(parentId)?.cwd;
  const childId = randomUUID();

  // Record the edge at mint time — before the terminal exists, so a crash
  // between here and launch still leaves the lineage correct.
  await deps.recordLaunch(childId, parentId, cwd);
  if (opts?.title) await deps.upsertRecord(childId, { title: opts.title });

  log('fork:', shortId(childId), 'from', shortId(parentId), cwd ?? '(no cwd)');
  const binding = await deps.launchSession({
    sessionId: childId,
    parentId,
    cwd,
    prompt: opts?.prompt,
    title: opts?.title,
  });
  if (!binding) {
    log('fork: launch failed for', shortId(childId));
    return undefined;
  }
  deps.refresh();
  return childId;
}

/**
 * Resume = reopen a CLOSED session in a terminal here, keeping its id.
 *
 * Safe precisely because the session is not running: `--resume` reuses the
 * original session id, so pointing a second claude process at a transcript
 * another process is actively appending to would be two writers on one file.
 * That is why this refuses a live session and offers a fork instead — forking
 * is the supported way to branch off something that is already running.
 */
async function resumeFlow(
  deps: CommandDeps,
  sessionId: string,
): Promise<boolean> {
  const node = deps.getForest().nodes.get(sessionId);

  if (node && !node.archived && node.status !== 'exited') {
    const FORK = 'Fork It Instead';
    const choice = await vscode.window.showWarningMessage(
      `"${node.label}" is still running — resuming would attach a second ` +
        'process to a transcript it is writing. Fork it instead to branch ' +
        'off a copy.',
      FORK,
      'Copy Session ID',
    );
    if (choice === FORK) await forkFlow(deps, sessionId);
    else if (choice === 'Copy Session ID') {
      await vscode.env.clipboard.writeText(sessionId);
    }
    return false;
  }

  if (!deps.hasTranscript(sessionId)) {
    void vscode.window.showWarningMessage(
      'No transcript on disk for this session — there is nothing to reopen.',
    );
    return false;
  }

  const cwd = node?.cwd ?? deps.getRecord(sessionId)?.cwd;
  log('resume:', shortId(sessionId), cwd ?? '(no cwd)');

  // The resumed process keeps this id, so sessionId === resumeId: the
  // LINEAGE_NODE_ID stamp and the binding both name what will be running.
  const binding = await deps.launchSession({
    sessionId,
    resumeId: sessionId,
    cwd,
  });
  if (!binding) {
    log('resume: launch failed for', shortId(sessionId));
    return false;
  }
  // Reopening un-closes it; the roster will confirm within a poll or two.
  await deps.upsertRecord(sessionId, { closed: null });
  deps.refresh();
  return true;
}

async function closeFlow(
  deps: CommandDeps,
  sessionId: string,
  extra?: Partial<EditorialRecord>,
): Promise<void> {
  const closedTerminal = deps.closeTerminal(sessionId);
  await deps.upsertRecord(sessionId, {
    closed: nowIso(),
    boundWindowId: null,
    ...extra,
  });
  log(
    'close:',
    shortId(sessionId),
    closedTerminal ? '(terminal disposed)' : '(no terminal in this window)',
  );
  deps.refresh();
}

// ---------------------------------------------------------- registration

type Handler = (...args: unknown[]) => void | Promise<void>;

export function registerCommands(deps: CommandDeps): DisposableLike {
  const disposables: vscode.Disposable[] = [];

  const register = (id: string, human: string, handler: Handler): void => {
    const guarded = async (...args: unknown[]): Promise<void> => {
      try {
        await handler(...args);
      } catch (err) {
        logError(`command ${id}`, err);
        void vscode.window.showErrorMessage(
          `Lineage: ${human} failed — ${errText(err)}`,
        );
      }
    };
    disposables.push(vscode.commands.registerCommand(id, guarded));
  };

  // ------------------------------------------------------------- refresh

  register(COMMANDS.refresh, 'refresh', () => {
    deps.refresh();
  });

  // --------------------------------------------------------------- focus

  register(COMMANDS.focusSession, 'focus session', async (arg?: unknown) => {
    const id = await targetSession(deps, arg, 'Focus a Claude session', {
      liveOnly: false,
    });
    if (!id) return;
    if (deps.focusSession(id)) return;
    if (await deps.focusWindowFor(id)) return;

    // Nothing here owns a terminal for this session. That is the DEFAULT state
    // for every session the extension did not launch — on a machine already
    // running dozens of sessions elsewhere it is every row in the tree — so a
    // bare "no terminal bound" is a dead end at exactly the wrong moment.
    // Offer the verbs that actually apply instead.
    const node = deps.getForest().nodes.get(id);
    const label = node?.label ?? shortId(id);

    if (node && (node.archived || node.status === 'exited')) {
      const RESUME = 'Resume Here';
      const choice = await vscode.window.showInformationMessage(
        `"${label}" is not running.`,
        RESUME,
        'Copy Session ID',
      );
      if (choice === RESUME) await resumeFlow(deps, id);
      else if (choice === 'Copy Session ID') {
        await vscode.env.clipboard.writeText(id);
      }
      return;
    }

    const FORK = 'Fork Here';
    const choice = await vscode.window.showInformationMessage(
      `"${label}" is running outside this editor` +
        (node?.roster?.pid ? ` (pid ${node.roster.pid})` : '') +
        '. Fork it to branch off a copy you own.',
      FORK,
      'Copy Session ID',
    );
    if (choice === FORK) await forkFlow(deps, id);
    else if (choice === 'Copy Session ID') {
      await vscode.env.clipboard.writeText(id);
    }
  });

  // -------------------------------------------------------------- resume

  register(COMMANDS.resumeSession, 'resume session', async (arg?: unknown) => {
    const id = await targetSession(deps, arg, 'Resume which session?', {
      liveOnly: false,
    });
    if (!id) return;
    // Already open here? Just show it — reopening would be a second process.
    if (deps.focusSession(id)) return;
    await resumeFlow(deps, id);
  });

  // ---------------------------------------------------------------- new

  register(COMMANDS.newSession, 'new session', async () => {
    const folder = await pickLaunchFolder(deps);
    if (!folder) return;
    const raw = await vscode.window.showInputBox({
      prompt: 'Opening prompt (optional) — leave empty to start at a blank prompt',
      placeHolder: 'e.g. review the auth middleware',
      ignoreFocusOut: true,
    });
    if (raw === undefined) return; // escaped: cancel the whole verb
    const prompt = raw.trim() || undefined;

    const sessionId = randomUUID();
    await deps.recordLaunch(sessionId, null, folder.cwd);
    log('new:', shortId(sessionId), folder.cwd ?? '(no cwd)');
    const binding = await deps.launchSession({
      sessionId,
      cwd: folder.cwd,
      prompt,
    });
    if (!binding) {
      log('new: launch failed for', shortId(sessionId));
      return;
    }
    deps.refresh();
  });

  // --------------------------------------------------------------- fork

  register(COMMANDS.forkSession, 'fork session', async (arg?: unknown) => {
    const parentId = await targetSession(deps, arg, 'Fork which session?', {
      liveOnly: false,
    });
    if (!parentId) return;
    await forkFlow(deps, parentId);
  });

  // ---------------------------------------------------------------- ask

  register(COMMANDS.askSession, 'ask in a fork', async (arg?: unknown) => {
    const parentId = await targetSession(
      deps,
      arg,
      'Ask a question in a fork of which session?',
      { liveOnly: false },
    );
    if (!parentId) return;
    if (!deps.hasTranscript(parentId)) {
      void vscode.window.showWarningMessage(
        'Session has no transcript yet — send one message first.',
      );
      return;
    }
    const raw = await vscode.window.showInputBox({
      prompt: `Ask in a fork of "${labelFor(deps, parentId)}"`,
      placeHolder: 'What should the fork look into?',
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.trim().length === 0 ? 'Enter a question or task.' : undefined,
    });
    if (raw === undefined) return;
    const prompt = raw.trim();
    if (!prompt) return; // empty -> cancel, per spec
    await forkFlow(deps, parentId, {
      prompt,
      title: truncate(prompt, ASK_TITLE_LEN),
    });
  });

  // ------------------------------------------------------------- rename

  register(COMMANDS.renameSession, 'rename session', async (arg?: unknown) => {
    const id = await targetSession(deps, arg, 'Rename which session?', {
      liveOnly: false,
    });
    if (!id) return;
    const current = labelFor(deps, id);
    const raw = await vscode.window.showInputBox({
      title: 'Rename Session',
      prompt: 'New name for this session',
      value: current,
      ignoreFocusOut: true,
      validateInput: (value) => {
        const trimmed = value.trim();
        if (trimmed.length === 0) return 'Name cannot be empty.';
        if (trimmed.length > MAX_TITLE_LEN) {
          return `Name must be ${MAX_TITLE_LEN} characters or fewer (currently ${trimmed.length}).`;
        }
        return undefined;
      },
    });
    if (raw === undefined) return;
    const title = raw.trim();
    if (!title || title.length > MAX_TITLE_LEN) return;
    await deps.upsertRecord(id, { title });
    // Best-effort: no rename API exists, so this is show(true) + renameWithArg
    // inside the terminals module and can legitimately fail.
    await deps.renameTerminal(id, title);
    deps.refresh();
  });

  // -------------------------------------------------------------- close

  register(COMMANDS.closeSession, 'close session', async (arg?: unknown) => {
    const id = await targetSession(deps, arg, 'Close which session?', {
      liveOnly: false,
    });
    if (!id) return;
    const label = labelFor(deps, id);
    const descendants = liveDescendantCount(deps.getForest(), id);
    const detail = [
      'Its terminal in this window is disposed and the session is marked closed.',
      descendants > 0
        ? `${descendants} live session(s) forked from it keep running.`
        : '',
      `The transcript is kept — resume it later with: claude --resume ${id}`,
    ]
      .filter((s) => s.length > 0)
      .join('\n');
    const choice = await vscode.window.showWarningMessage(
      `Close session "${label}"?`,
      { modal: true, detail },
      'Close Session',
    );
    if (choice !== 'Close Session') return;
    await closeFlow(deps, id);
  });

  register(
    COMMANDS.closeWithSummary,
    'close with summary',
    async (arg?: unknown) => {
      const id = await targetSession(deps, arg, 'Close which session?', {
        liveOnly: false,
      });
      if (!id) return;
      const label = labelFor(deps, id);
      // The summary box IS the confirmation — no second modal.
      const raw = await vscode.window.showInputBox({
        title: `Close "${label}" with a summary`,
        prompt: 'What did this session accomplish? (recorded on the node)',
        placeHolder: 'e.g. traced the drift to a stale cache key; fix in PR 412',
        ignoreFocusOut: true,
        validateInput: (value) =>
          value.trim().length === 0 ? 'Enter a summary, or press Escape.' : undefined,
      });
      if (raw === undefined) return;
      const summary = raw.trim();
      if (!summary) return;
      await closeFlow(deps, id, { summary });
    },
  );

  // --------------------------------------------------------------- wrap

  register(COMMANDS.wrapSession, 'wrap session', async (arg?: unknown) => {
    const id = await targetSession(deps, arg, 'Wrap up which session?');
    if (!id) return;
    // The ONE remaining sendText in the whole extension.
    if (!deps.sendTextToSession(id, WRAP_PROMPT)) {
      void vscode.window.showWarningMessage(
        'Wrap needs the session terminal in this window.',
      );
      return;
    }
    await deps.upsertRecord(id, { wrapRequestedAt: nowIso() });
    log('wrap: requested for', shortId(id));
    vscode.window.setStatusBarMessage(
      `Lineage: asked "${labelFor(deps, id)}" to wrap up`,
      3000,
    );
  });

  // -------------------------------------------------------------- copy id

  register(COMMANDS.copySessionId, 'copy session id', async (arg?: unknown) => {
    const id = await targetSession(deps, arg, 'Copy which session id?', {
      liveOnly: false,
    });
    if (!id) return;
    await vscode.env.clipboard.writeText(id);
    vscode.window.setStatusBarMessage(`Copied session id ${shortId(id)}…`, 2000);
  });

  // ------------------------------------------------------- hide / unhide

  register(COMMANDS.hideSession, 'hide session', async (arg?: unknown) => {
    const id = await targetSession(deps, arg, 'Hide which session?', {
      liveOnly: false,
    });
    if (!id) return;
    // Recoverable delete: children keep their lineage and are promoted under
    // the nearest visible ancestor.
    await deps.upsertRecord(id, { hidden: true });
    log('hide:', shortId(id));
    deps.refresh();
    vscode.window.setStatusBarMessage(
      'Lineage: session hidden — restore it with "Lineage: Unhide Session…"',
      4000,
    );
  });

  register(COMMANDS.unhideSession, 'unhide session', async (arg?: unknown) => {
    const direct = sessionIdFromArg(arg);
    if (direct) {
      await deps.upsertRecord(direct, { hidden: false });
      deps.refresh();
      return;
    }
    const hidden = Object.values(deps.allRecords()).filter(
      (record) => record.hidden === true,
    );
    if (hidden.length === 0) {
      void vscode.window.showInformationMessage('Lineage: no hidden sessions.');
      return;
    }
    const forest = deps.getForest();
    const items: SessionPick[] = hidden.map((record) => {
      const node = forest.nodes.get(record.id);
      return {
        label: record.title ?? node?.label ?? shortId(record.id),
        description: [
          shortId(record.id),
          node ? (node.ghost ? 'gone' : node.status) : 'not running',
        ].join(' · '),
        detail: record.cwd ?? node?.cwd,
        sessionId: record.id,
      };
    });
    const chosen = await vscode.window.showQuickPick(items, {
      placeHolder: 'Unhide which session?',
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true,
    });
    if (!chosen) return;
    await deps.upsertRecord(chosen.sessionId, { hidden: false });
    log('unhide:', shortId(chosen.sessionId));
    deps.refresh();
  });

  // ------------------------------------------------------------- project

  register(COMMANDS.openProject, 'open project', async (arg?: unknown) => {
    const fromGroup = groupCwdFromArg(arg);
    const cwd = fromGroup ?? (await pickProjectFolder(deps));
    if (!cwd) return;
    await deps.openProject(cwd, true);
  });

  // --------------------------------------------------------------- hooks

  const syncHookContext = async (installed: boolean): Promise<void> => {
    await vscode.commands.executeCommand(
      'setContext',
      CONTEXT_HOOKS_INSTALLED,
      installed,
    );
  };

  register(COMMANDS.installHooks, 'install hooks', async () => {
    const state = await deps.installHooks();
    await syncHookContext(state.installed === true);
    log('hooks: install ->', state.installed ? 'installed' : 'not installed');
  });

  register(COMMANDS.removeHooks, 'remove hooks', async () => {
    if (!deps.getHookState().installed) {
      void vscode.window.showInformationMessage(
        'Lineage: instant-update hooks are not installed.',
      );
      await syncHookContext(false);
      return;
    }
    const state = await deps.removeHooks();
    await syncHookContext(state.installed === true);
    log('hooks: remove ->', state.installed ? 'still installed' : 'removed');
  });

  return {
    dispose(): void {
      for (const disposable of disposables.reverse()) {
        try {
          disposable.dispose();
        } catch (err) {
          logError('command dispose', err);
        }
      }
      disposables.length = 0;
    },
  };
}
