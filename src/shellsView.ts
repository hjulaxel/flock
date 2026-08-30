// src/shellsView.ts — the Shells view, under Sessions and Accounts.
//
// One row per TERMINAL this window has bound: the shells Flock launched, with
// the pid actually running in each, whether it is wrapped in tmux, and how old
// it is.
//
// WHY A THIRD VIEW rather than more columns on the tree. The three answer
// three different questions and change at three different rates:
//
//   Sessions — what conversations exist, and how do they relate. Repaints on
//     every roster tick; its unit is a conversation, which outlives any number
//     of terminals (every `--resume`, `/clear` and compaction mints a new
//     generation onto the same row).
//   Accounts — whose subscription is paying. Changes when you add an account
//     or a five-hour window rolls over.
//   Shells  — what PROCESSES are up right now. Its unit is a terminal, and a
//     terminal is a thing with a pid, a tmux name and an age, none of which
//     the tree has anywhere to put and none of which survive a re-key.
//
// The tree deliberately hides all of that: it collapses a conversation's
// generations onto one row precisely so that the machinery underneath stops
// being your problem. This view is where it stops being hidden, for the times
// when it IS your problem — a session that will not focus, a tmux wrap you
// want to confirm, an editor that has quietly accumulated eleven terminals.
//
// WHAT IT DOES NOT SHOW, and this is stated on the view itself rather than
// left to be discovered: terminals belonging to OTHER windows. A binding lives
// in the window that made it — `TerminalRegistry` holds `vscode.Terminal`
// objects, which do not cross the extension-host boundary — so a second window
// running four sessions is four shells this view cannot see. The Sessions tree
// covers those (the roster is machine-wide); this one is honest about being a
// window-local process list rather than pretending to a machine-wide one it
// cannot deliver.
//
// The row FORMATTING is pure and exported, and the tests bite there — a
// TreeDataProvider is almost impossible to assert against and almost entirely
// uninteresting, while "what does this row say" is the whole feature.

import * as vscode from 'vscode';

import { contextValueOf, isSessionId, shortId } from './types';
import type {
  DisposableLike,
  SessionStatus,
  TerminalBinding,
} from './types';
import { COMMANDS } from './types';
import { formatAge } from './viewmodel';
import { log, logError } from './log';

// -------------------------------------------------------------- identifiers

export const SHELLS_VIEW_ID = 'lineageShells';

// -------------------------------------------------------------------- deps

/**
 * Everything the view needs from the rest of the extension.
 *
 * Every session lookup is BY THE BOUND ID and every one is optional. A
 * terminal is bound under the id it was launched with, which after a re-key is
 * not the id its tree row carries — extension.ts resolves that over the chain
 * on the way in, so this file never has to know that generations exist. And a
 * shell whose conversation has no row is a real, ordinary state (a session the
 * roster has not reported yet, or one filtered out of the tree), so every
 * lookup may answer undefined and the row degrades to what the binding itself
 * knows.
 */
export interface ShellDeps {
  /** `TerminalRegistry.bindings()` — this window's terminals. */
  shells(): readonly TerminalBinding[];
  /** The conversation's display name, chain-resolved. */
  sessionLabel(sessionId: string): string | undefined;
  /** What the roster says, so a shell row and its tree row cannot disagree. */
  sessionStatus(sessionId: string): SessionStatus | undefined;
  /** Where it is running. */
  sessionCwd(sessionId: string): string | undefined;
  /** Fires whenever a terminal is bound, exits, or the roster ticks. */
  onDidChange(listener: () => void): DisposableLike;
}

// -------------------------------------------------------------------- rows

/** The view is flat: one row per terminal. Discriminated so that a context
 *  menu argument arriving back in commands.ts is recognisable, and so that
 *  `sessionIdFromArg` finds the `id` field without any special case. */
export interface ShellRow {
  kind: 'shell';
  binding: TerminalBinding;
  /** The bound session id, under the name `sessionIdFromArg` already reads —
   *  which is what lets every existing session verb work from this view
   *  without a single new command. */
  id: string;
}

/** `;shell;` (+ `;tmux;` when the terminal is wrapped), through the repo's own
 *  token builder — the wrapping semicolons are what stop a `viewItem =~
 *  /;shell;/` clause half-matching a longer token. */
export function shellContextValue(binding: TerminalBinding): string {
  return contextValueOf(
    binding?.tmuxName !== undefined ? ['shell', 'tmux'] : ['shell'],
  );
}

/**
 * Newest LAST, by launch time.
 *
 * The same order the workbench's own terminal list uses, which is the list the
 * user is cross-referencing when they open this view at all. Deliberately not
 * sorted by status: a row that jumps to the top the moment its session goes
 * busy is a row you cannot click, and this view exists to be clicked at
 * exactly the moment things are busy.
 *
 * Ties break on session id so the order is total — two terminals launched in
 * the same millisecond (a fork of N branches does this) must not swap places
 * between repaints.
 */
export function sortShells(
  bindings: readonly TerminalBinding[],
): TerminalBinding[] {
  return [...(bindings ?? [])]
    .filter((b) => b && isSessionId(b.sessionId))
    .sort((a, b) => {
      const at = Number.isFinite(a.createdAt) ? a.createdAt : 0;
      const bt = Number.isFinite(b.createdAt) ? b.createdAt : 0;
      if (at !== bt) return at - bt;
      return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
    });
}

/**
 * The right-hand line: `pid 40213 · tmux · 12m`.
 *
 * PID FIRST because it is the reason to open this view — it is the one fact
 * here that no other surface in the extension shows, and the one you need when
 * you are about to go and look at a process yourself. `tmux` is a word rather
 * than the session's name (that is in the hover): what matters at a glance is
 * the tier, since it decides whether a workspace switch will park this shell
 * or close it.
 *
 * A missing pid renders as `pid ?` rather than as nothing. A terminal whose
 * pid we never learnt is a real state — the pty is created asynchronously and
 * a wrapped terminal's own pid is the tmux client's, not claude's — and the
 * honest answer is that we do not know it, not silence that reads as though
 * the column did not apply.
 */
export function shellDescription(
  binding: TerminalBinding,
  now: number,
): string {
  const pid =
    typeof binding?.pid === 'number' && Number.isFinite(binding.pid)
      ? `pid ${binding.pid}`
      : 'pid ?';
  const age = formatAge(now - (binding?.createdAt ?? Number.NaN));
  return [pid, binding?.tmuxName !== undefined ? 'tmux' : '', age]
    .filter((s) => s !== '')
    .join(' · ');
}

/**
 * The hover: every fact the row had to leave out, one per line.
 *
 * Plain text, not markdown, and that is deliberate — a cwd is a path and a
 * label is a user string, and neither is trusted markup. The accounts view
 * escapes because it wants a markdown table; this wants none of that, and not
 * building the string as markup is a stronger guarantee than escaping it.
 */
export function shellTooltip(input: {
  binding: TerminalBinding;
  label?: string;
  status?: SessionStatus;
  cwd?: string;
  now: number;
}): string {
  const { binding, now } = input;
  const lines: string[] = [];
  lines.push(input.label ?? shortId(binding.sessionId));
  if (input.status !== undefined) lines.push(input.status);
  lines.push(`session ${binding.sessionId}`);
  if (typeof binding.pid === 'number' && Number.isFinite(binding.pid)) {
    // Said in full here rather than left implicit, because a wrapped
    // terminal's pid is a genuine trap: it is the tmux CLIENT's, and somebody
    // reading it as claude's will kill the wrong process.
    lines.push(
      binding.tmuxName !== undefined
        ? `pid ${binding.pid} (the tmux client, not claude)`
        : `pid ${binding.pid}`,
    );
  }
  if (binding.tmuxName !== undefined) {
    lines.push(`tmux session ${binding.tmuxName} — parks on a workspace switch`);
  } else {
    lines.push('no tmux wrap — a workspace switch closes this one');
  }
  if (input.cwd !== undefined && input.cwd !== '') lines.push(input.cwd);
  const age = formatAge(now - (binding.createdAt ?? Number.NaN));
  if (age !== '') lines.push(`opened ${age === 'now' ? 'just now' : `${age} ago`}`);
  lines.push(`terminal "${binding.terminalName}"`);
  return lines.join('\n');
}

/** The glyph. A wrapped shell says so in the icon as well as the description,
 *  because the tier is the only thing on this row with a consequence — it is
 *  what decides whether switching projects hides this process or ends it. */
export function shellIconId(binding: TerminalBinding): string {
  return binding?.tmuxName !== undefined ? 'server-process' : 'terminal';
}

// ---------------------------------------------------------------- provider

export class ShellsViewProvider implements vscode.TreeDataProvider<ShellRow> {
  private readonly deps: ShellDeps;
  private readonly emitter = new vscode.EventEmitter<ShellRow | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(deps: ShellDeps) {
    this.deps = deps;
  }

  refresh(): void {
    try {
      this.emitter.fire(undefined);
    } catch (err) {
      logError('shellsView.refresh', err);
    }
  }

  getChildren(element?: ShellRow): ShellRow[] {
    if (element) return []; // flat by construction
    try {
      return sortShells(this.deps.shells()).map((binding) => ({
        kind: 'shell' as const,
        binding,
        id: binding.sessionId,
      }));
    } catch (err) {
      logError('shellsView.getChildren', err);
      return [];
    }
  }

  getTreeItem(row: ShellRow): vscode.TreeItem {
    const binding = row.binding;
    const now = Date.now();
    const label = this.ask('sessionLabel', () =>
      this.deps.sessionLabel(binding.sessionId),
    );
    const item = new vscode.TreeItem(
      label ?? shortId(binding.sessionId),
      vscode.TreeItemCollapsibleState.None,
    );
    // Keyed on the SESSION, not on the terminal name: claude rewrites its
    // terminal's title constantly while it runs, and an item id that moved
    // with it would make the workbench treat every repaint as a new row.
    item.id = `shell:${binding.sessionId}`;
    item.iconPath = new vscode.ThemeIcon(shellIconId(binding));
    item.contextValue = shellContextValue(binding);
    item.description = shellDescription(binding, now);
    item.tooltip = shellTooltip({
      binding,
      now,
      ...(label === undefined ? {} : { label }),
      ...(() => {
        const status = this.ask('sessionStatus', () =>
          this.deps.sessionStatus(binding.sessionId),
        );
        return status === undefined ? {} : { status };
      })(),
      ...(() => {
        const cwd = this.ask('sessionCwd', () =>
          this.deps.sessionCwd(binding.sessionId),
        );
        return cwd === undefined ? {} : { cwd };
      })(),
    });
    // Clicking a shell brings its terminal to the front — which is what a
    // process list is FOR, and is already exactly what `focusSession` does,
    // tiers and all. The id goes through as a bare string, the shape
    // `sessionIdFromArg` reads first, so this view adds no command of its own.
    item.command = {
      command: COMMANDS.focusSession,
      title: 'Focus',
      arguments: [binding.sessionId],
    };
    return item;
  }

  /** Every dep call is a lookup into machinery that may be mid-rebuild, and a
   *  throw inside getTreeItem blanks the whole view. Same guard shape the
   *  native tree uses (`safe`), for the same reason. */
  private ask<T>(what: string, read: () => T | undefined): T | undefined {
    try {
      return read();
    } catch (err) {
      logError(`shellsView.${what}`, err);
      return undefined;
    }
  }

  dispose(): void {
    try {
      this.emitter.dispose();
    } catch (err) {
      logError('shellsView.dispose', err);
    }
  }
}

// ------------------------------------------------------------- registration

export interface ShellsViewController extends DisposableLike {
  refresh(): void;
}

/**
 * createTreeView(SHELLS_VIEW_ID) + a repaint on every bind, exit and roster
 * tick.
 *
 * No timer of its own, unlike the accounts view: nothing here is fetched, and
 * every fact on a row changes only when something the extension already
 * watches changes. The one exception is the AGE, which drifts — and a section
 * that repaints itself on a timer to advance `12m` to `13m` would be a
 * background task bought with nothing. The roster tick moves it along often
 * enough.
 */
export function registerShellsView(deps: ShellDeps): ShellsViewController {
  const provider = new ShellsViewProvider(deps);
  const view = vscode.window.createTreeView<ShellRow>(SHELLS_VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: false,
    canSelectMany: false,
  });

  // Said on the view rather than in the docs, because the scope is the first
  // thing somebody will get wrong about it: this is THIS WINDOW's terminals,
  // and a second window's sessions are in the tree above but not here.
  try {
    view.description = 'this window';
  } catch (err) {
    logError('shellsView.description', err);
  }

  let sub: DisposableLike | undefined;
  try {
    sub = deps.onDidChange(() => provider.refresh());
  } catch (err) {
    logError('shellsView.onDidChange', err);
  }

  log('shells: view registered');

  return {
    refresh(): void {
      provider.refresh();
    },
    dispose(): void {
      try {
        sub?.dispose();
      } catch (err) {
        logError('shellsView.dispose.sub', err);
      }
      try {
        view.dispose();
      } catch (err) {
        logError('shellsView.dispose.view', err);
      }
      provider.dispose();
    },
  };
}
