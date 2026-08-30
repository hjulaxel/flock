// src/shellsView.ts — the Shells view: what CLAUDE is running, right now.
//
// One row per `Bash` command a session has issued — `npm test`, the migration
// script, the background job somebody started forty minutes ago and forgot.
// Not one row per terminal: a terminal is the pty Flock launched claude INTO,
// there is one per session, it is yours, and it never told you anything you
// did not already know from the tree. The thing that is genuinely invisible is
// what the model decided to execute inside it, and that is what this lists.
//
// (An earlier build of this view listed the terminals. It was a process list
// of the wrong processes: it answered "which shells do I have open", which the
// workbench's own terminal dropdown already answers, instead of "what is
// Claude running", which nothing did. The pid/tmux facts it carried are still
// reachable — they are on the session row's hover in the tree, which is where
// a fact about a session belongs.)
//
// WHY A VIEW OF ITS OWN rather than more rows under each session in the tree.
// The three sections answer three questions that change at three rates:
//
//   Sessions — what conversations exist and how they relate. Its unit is a
//     conversation, which outlives everything below.
//   Accounts — whose subscription is paying. Changes when a five-hour window
//     rolls over.
//   Shells  — what COMMANDS are executing. Its unit lives for eleven seconds,
//     there are hundreds per conversation, and folding them into the tree
//     would bury the lineage the tree exists to show under a scrolling log.
//
// SCOPE: every live session on this machine, not just this window's. The old
// view could only ever show its own window's terminals, because a
// `vscode.Terminal` does not cross the extension-host boundary; this one reads
// transcripts off disk, so a script running in a session another window
// launched is a row here like any other. That is a straight enlargement of
// what the section is worth opening for.
//
// COST, stated because this view reads files on a timer. Per live session the
// steady state is one `statSync` plus the bytes appended since the last look
// (see ShellRunsTracker) — the transcript is never re-read from the top. The
// scan runs on the roster tick whether or not the section is expanded, because
// the container BADGE is how a running script is noticed at all when the
// section is collapsed, and a badge that is only correct while you are looking
// at it is not a badge. The one-second clock that advances the elapsed times
// runs only while the view is visible AND something is actually live.

import * as vscode from 'vscode';

import { contextValueOf, isSessionId } from './types';
import type { DisposableLike } from './types';
import { COMMANDS } from './types';
import {
  ShellRunsTracker,
  isLive,
  shellRunDetail,
  shellRunIconId,
  shellRunLabel,
  shellRunTokens,
  shellRunTooltip,
  sortShellRuns,
} from './toolShells';
import type { ShellRun } from './toolShells';
import { log, logError } from './log';

// -------------------------------------------------------------- identifiers

export const SHELLS_VIEW_ID = 'lineageShells';

/**
 * Rows the view will draw, across every session.
 *
 * A cap on the LIST, on top of the per-session cap the tracker already holds.
 * Six sessions each keeping sixty commands is 360 rows of mostly `git status`,
 * and a list that long is not read, it is scrolled past. Live runs are never
 * the ones dropped — see pickShellRows.
 */
export const MAX_ROWS = 100;

/** How often the elapsed times advance while the view is visible and something
 *  is live. One second, because the numbers are in seconds: a clock that
 *  updates more slowly than its own smallest unit reads as frozen, which is
 *  the exact thing somebody watching a long command is trying to rule out. */
export const TICK_MS = 1_000;

// -------------------------------------------------------------------- deps

/** A session worth reading shells out of. */
export interface ShellSessionInfo {
  /** The claude session id — also what a session verb invoked from this view
   *  receives, so every existing command works here unchanged. */
  id: string;
  /** The conversation's display name, chain-resolved by the caller. */
  label: string;
  /** Its transcript. The one thing this view cannot work without. */
  transcriptPath: string;
  /** Where it is running, for the hover. */
  cwd?: string;
}

export interface ShellDeps {
  /**
   * The LIVE sessions, resolved to transcripts.
   *
   * Live only, and that is a correctness rule rather than a cost one. "No
   * result yet" means "still executing" — verified over 6 890 Bash calls, zero
   * orphans — but only for a session whose process is alive. A conversation
   * that was killed mid-command leaves a `tool_use` that will never be
   * answered, and listing it as running would be the view's one way to lie.
   */
  sessions(): readonly ShellSessionInfo[];
  /** Fires on the roster tick and whenever the forest changes. */
  onDidChange(listener: () => void): DisposableLike;
}

// -------------------------------------------------------------------- rows

/** The view is flat: one row per command. */
export interface ShellRow {
  kind: 'shell';
  run: ShellRun;
  /** The SESSION id, under the name `sessionIdFromArg` already reads — which
   *  is what lets Focus, Fork, Rename and the rest work from this view without
   *  a single new command. The run's own id is on `run.id`. */
  id: string;
  /** Set only when the list spans more than one conversation. */
  sessionLabel?: string;
}

/**
 * Every run, newest and live first, capped.
 *
 * The session label is attached HERE rather than at render time, and only when
 * the rows span more than one conversation: in a window with one session it is
 * the same word on all hundred rows, which is a column of noise, and in a
 * window with four it is the only thing telling them apart.
 */
export function pickShellRows(
  perSession: ReadonlyMap<string, readonly ShellRun[]>,
  labels: ReadonlyMap<string, string>,
  max: number = MAX_ROWS,
): ShellRow[] {
  const all: ShellRun[] = [];
  for (const runs of perSession.values()) {
    for (const run of runs ?? []) if (run) all.push(run);
  }
  // sortShellRuns puts live first, so a cap can only ever cut history.
  const kept = sortShellRuns(all).slice(0, Math.max(0, max));
  const spread = new Set(kept.map((r) => r.sessionId)).size > 1;
  return kept.map((run) => {
    const label = labels.get(run.sessionId);
    return {
      kind: 'shell' as const,
      run,
      id: run.sessionId,
      ...(spread && label !== undefined && label !== ''
        ? { sessionLabel: label }
        : {}),
    };
  });
}

/** `;shell;` + the outcome (+ `;live;`, + `;output;` when there is a file to
 *  open). Through the repo's own token builder — the wrapping semicolons are
 *  what stop a `viewItem =~ /;ok;/` clause half-matching a longer token. */
export function shellContextValue(run: ShellRun): string {
  return contextValueOf(shellRunTokens(run));
}

/**
 * The view's own subtitle: `2 running`, `1 running · 1 background`, or nothing.
 *
 * Nothing when nothing is live, deliberately — a header that permanently reads
 * "0 running" is a header nobody reads, and the point of putting the count up
 * there is that it MEANS something on the day it appears.
 */
export function shellsViewDescription(runs: readonly ShellRun[]): string {
  let running = 0;
  let background = 0;
  for (const run of runs ?? []) {
    if (run?.outcome === 'running') running++;
    else if (run?.outcome === 'background') background++;
  }
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (background > 0) parts.push(`${background} background`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------- provider

export class ShellsViewProvider implements vscode.TreeDataProvider<ShellRow> {
  private readonly deps: ShellDeps;
  private readonly tracker = new ShellRunsTracker();
  private readonly emitter = new vscode.EventEmitter<ShellRow | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  /** The last scan's rows, so the badge and the description can be read
   *  without a second pass over the filesystem. */
  private rows: ShellRow[] = [];
  /** sessionId → cwd, from the same scan. The hover wants the directory a
   *  command ran in — `npm test` means two different things in two worktrees —
   *  and the row itself has nowhere to put a path. */
  private cwds = new Map<string, string>();

  constructor(deps: ShellDeps) {
    this.deps = deps;
  }

  /**
   * Re-read every live session's transcript and rebuild the row list.
   *
   * Returns the rows rather than only storing them, because the caller wants
   * the same scan for three things at once — the tree data, the container
   * badge and the view's subtitle — and doing it three times would triple the
   * only expensive thing this file does.
   */
  scan(): ShellRow[] {
    const perSession = new Map<string, readonly ShellRun[]>();
    const labels = new Map<string, string>();
    let sessions: readonly ShellSessionInfo[] = [];
    try {
      sessions = this.deps.sessions() ?? [];
    } catch (err) {
      logError('shellsView.sessions', err);
    }
    const seen = new Set<string>();
    for (const session of sessions) {
      if (!session || !isSessionId(session.id)) continue;
      if (typeof session.transcriptPath !== 'string') continue;
      if (session.transcriptPath === '') continue;
      seen.add(session.id);
      labels.set(session.id, session.label ?? '');
      if (session.cwd !== undefined && session.cwd !== '') {
        this.cwds.set(session.id, session.cwd);
      }
      try {
        perSession.set(
          session.id,
          this.tracker.update({
            id: session.id,
            transcriptPath: session.transcriptPath,
          }),
        );
      } catch (err) {
        logError('shellsView.track', err);
      }
    }
    // Bounded by what is live, so a window left open for a week does not
    // accumulate a tail position per session it once watched.
    this.tracker.prune(seen);
    for (const id of [...this.cwds.keys()]) {
      if (!seen.has(id)) this.cwds.delete(id);
    }
    this.rows = pickShellRows(perSession, labels);
    return this.rows;
  }

  /** The rows from the last scan — no filesystem work. */
  current(): readonly ShellRow[] {
    return this.rows;
  }

  /** How many commands are executing right now, background jobs included.
   *  This is the badge. */
  liveCount(): number {
    return this.rows.filter((row) => isLive(row.run)).length;
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
    return this.rows;
  }

  getTreeItem(row: ShellRow): vscode.TreeItem {
    const run = row.run;
    const now = Date.now();
    const item = new vscode.TreeItem(
      shellRunLabel(run),
      vscode.TreeItemCollapsibleState.None,
    );
    // Keyed on the RUN, which never changes and is never reused — a list that
    // re-sorts as things finish must not make the workbench treat a row that
    // moved as a row that appeared.
    item.id = `shell:${run.id}`;
    item.iconPath = new vscode.ThemeIcon(shellRunIconId(run));
    item.contextValue = shellContextValue(run);
    item.description = shellRunDetail({
      run,
      now,
      ...(row.sessionLabel === undefined ? {} : { sessionLabel: row.sessionLabel }),
    });
    const cwd = this.cwds.get(run.sessionId);
    item.tooltip = shellRunTooltip({
      run,
      now,
      ...(row.sessionLabel === undefined ? {} : { sessionLabel: row.sessionLabel }),
      ...(cwd === undefined ? {} : { cwd }),
    });
    // Clicking goes to the CONVERSATION, not to the command: a command is not
    // a thing you can open, and the question a row provokes ("why is this
    // still going?") is answered in the session that started it. `focusSession`
    // already does that, tiers and all, and takes a bare id — the shape
    // `sessionIdFromArg` reads first — so this view adds no command of its own
    // for the common gesture.
    item.command = {
      command: COMMANDS.focusSession,
      title: 'Focus',
      arguments: [run.sessionId],
    };
    return item;
  }

  dispose(): void {
    this.cwds.clear();
    try {
      this.tracker.dispose();
    } catch (err) {
      logError('shellsView.dispose.tracker', err);
    }
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
 * createTreeView(SHELLS_VIEW_ID), a scan on every roster tick, and a
 * one-second clock while something is live and the view is on screen.
 *
 * TWO CADENCES, because the two things being kept true have different costs.
 * The SCAN is what finds a new command and what the badge is computed from, so
 * it must run whether or not the section is expanded — it rides the roster
 * tick, which is the extension's existing heartbeat, and adds a stat plus a
 * few appended kilobytes per live session to it. The CLOCK only advances
 * numbers that are already on screen, so it is pure waste when nothing is
 * running or nobody is looking, and it stops in both cases.
 */
export function registerShellsView(deps: ShellDeps): ShellsViewController {
  const provider = new ShellsViewProvider(deps);
  const view = vscode.window.createTreeView<ShellRow>(SHELLS_VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: false,
    canSelectMany: false,
  });

  let tick: NodeJS.Timeout | null = null;
  let disposed = false;

  const paint = (): void => {
    if (disposed) return;
    let rows: readonly ShellRow[];
    try {
      rows = provider.scan();
    } catch (err) {
      logError('shellsView.scan', err);
      rows = provider.current();
    }
    provider.refresh();

    const live = provider.liveCount();
    try {
      // The same shape the Sessions view's badge uses (see
      // types.RUNNING_BADGE_ENABLED): a count of processes, ON the container,
      // so "nothing is running that has no row" is a claim you can check.
      view.badge =
        live > 0
          ? {
              value: live,
              tooltip: `${live} command${live === 1 ? '' : 's'} running`,
            }
          : undefined;
    } catch (err) {
      logError('shellsView.badge', err);
    }
    try {
      view.description = shellsViewDescription(rows.map((r) => r.run));
    } catch (err) {
      logError('shellsView.description', err);
    }
    schedule(live > 0);
  };

  /** Start or stop the clock. Never two timers, and never one that outlives
   *  the reason it was started. */
  const schedule = (wanted: boolean): void => {
    const want = wanted && !disposed && view.visible;
    if (want && tick === null) {
      tick = setInterval(paint, TICK_MS);
    } else if (!want && tick !== null) {
      clearInterval(tick);
      tick = null;
    }
  };

  const subs: DisposableLike[] = [];
  try {
    subs.push(deps.onDidChange(() => paint()));
  } catch (err) {
    logError('shellsView.onDidChange', err);
  }
  try {
    // Expanding the section is itself a reason to repaint: the rows were
    // scanned on the roster tick, but their elapsed times are as old as that
    // tick and the first thing a reader does is look at them.
    subs.push(view.onDidChangeVisibility(() => paint()));
  } catch (err) {
    logError('shellsView.onDidChangeVisibility', err);
  }

  paint();
  log('shells: view registered');

  return {
    refresh(): void {
      paint();
    },
    dispose(): void {
      disposed = true;
      if (tick !== null) {
        clearInterval(tick);
        tick = null;
      }
      for (const sub of subs) {
        try {
          sub.dispose();
        } catch (err) {
          logError('shellsView.dispose.sub', err);
        }
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
