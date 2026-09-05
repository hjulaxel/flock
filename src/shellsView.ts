// src/shellsView.ts — the Shells view: what CLAUDE is running, right now.
//
// One row per `Bash` command a session is running — `npm test`, the migration
// script, the background job somebody started forty minutes ago and forgot.
// Not one row per terminal: a terminal is the pty Flock launched claude INTO,
// there is one per session, it is yours, and it never told you anything you
// did not already know from the tree. The thing that is genuinely invisible is
// what the model decided to execute inside it, and that is what this lists.
//
// RUNNING, NOT RAN. A command that finishes leaves the list, the way it leaves
// the CLI's own "1 shell running" indicator — this section is that indicator,
// across every session at once, with the command and a clock on it. The first
// build kept a history of finished runs underneath the live ones, and the
// history was what you saw: a hundred rows of `git status` with exit codes,
// and the one row the section exists for somewhere among them or not there at
// all. What ran is in the conversation; what is running is not visible
// anywhere else, and that is the whole list now.
//
// (An earlier build still listed the terminals. It was a process list of the
// wrong processes: it answered "which shells do I have open", which the
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
// (see ShellRunsTracker) — the transcript is read from the top once, on the
// first look. The scan runs on EVERY roster tick, changed or not, whether or
// not the section is expanded: the container BADGE is how a running script is
// noticed at all when the section is collapsed, and a badge that is only
// correct while you are looking at it is not a badge. Every tick rather than
// every forest change, because the first build rode the forest and the forest
// only moves when the roster does — a session that stays `busy` while it runs
// one command after another never moves it, and the view showed the command
// before last until something unrelated happened. The one-second clock that
// advances the elapsed times runs only while the view is visible AND has rows.

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
 * A rail, not a budget: every row is a live command, and a machine with a
 * hundred of those has a bigger problem than a long list. It exists so a
 * pathological transcript cannot turn the section into a scrollbar.
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
  /** The roster says the session is blocked — on a permission prompt, or a
   *  question. An unanswered `Bash` call in such a session is not executing:
   *  it is the thing the prompt is asking about. The CLI writes the call
   *  before it asks, so without this the row would spin for as long as you
   *  took to read the prompt — measured across the denials on this machine,
   *  a median of 22 seconds and up to a minute of a clock on nothing. */
  waiting?: boolean;
}

export interface ShellDeps {
  /**
   * The LIVE sessions, resolved to transcripts.
   *
   * Live only, and that is a correctness rule rather than a cost one. "No
   * result yet" means "still executing" — but only for a session whose
   * process is alive. A conversation that was killed mid-command leaves a
   * `tool_use` that will never be answered, and listing it as running would
   * be the view's one way to lie.
   */
  sessions(): readonly ShellSessionInfo[];
  /** Fires on EVERY roster tick, and whenever the forest changes. The tick is
   *  the part that matters — see the header on cost. */
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
  /** The call is unanswered because its session is blocked at a prompt, not
   *  because the command is executing. Drawn without the spinner, worded as
   *  such, and left out of the running count. */
  awaiting?: true;
}

/**
 * Every LIVE run — executing, or detached and not yet finished — newest
 * first, capped. Finished runs are not rows: see the header.
 *
 * The session label is attached HERE rather than at render time, and only when
 * the rows span more than one conversation: in a window with one session it is
 * the same word on every row, which is a column of noise, and in a window with
 * four it is the only thing telling them apart.
 *
 * `waiting` names the sessions the roster reports blocked; a `running` run in
 * one of them is marked `awaiting` rather than dropped, because the command
 * Claude is asking to run is worth a row — it is just not a running one.
 */
export function pickShellRows(
  perSession: ReadonlyMap<string, readonly ShellRun[]>,
  labels: ReadonlyMap<string, string>,
  opts: { waiting?: ReadonlySet<string>; max?: number } = {},
): ShellRow[] {
  const max = opts.max ?? MAX_ROWS;
  const waiting = opts.waiting ?? new Set<string>();
  const live: ShellRun[] = [];
  for (const runs of perSession.values()) {
    for (const run of runs ?? []) if (run && isLive(run)) live.push(run);
  }
  const kept = sortShellRuns(live).slice(0, Math.max(0, max));
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
      ...(run.outcome === 'running' && waiting.has(run.sessionId)
        ? { awaiting: true as const }
        : {}),
    };
  });
}

/** `;shell;` + the outcome (+ `;live;`, + `;awaiting;` on a call blocked at a
 *  prompt, + `;output;` when there is a file to open). Through the repo's own
 *  token builder — the wrapping semicolons are what stop a `viewItem =~ /;ok;/`
 *  clause half-matching a longer token. */
export function shellContextValue(run: ShellRun, awaiting = false): string {
  return contextValueOf(shellRunTokens(run, awaiting));
}

/** How many commands are executing right now, background jobs included and
 *  calls awaiting approval excluded. This is the badge. */
export function countRunning(rows: readonly ShellRow[]): number {
  let n = 0;
  for (const row of rows ?? []) {
    if (row && isLive(row.run) && row.awaiting !== true) n++;
  }
  return n;
}

/**
 * The view's own subtitle: `2 running`, `1 running · 1 background`,
 * `1 awaiting approval`, or nothing.
 *
 * Nothing when nothing is live, deliberately — a header that permanently reads
 * "0 running" is a header nobody reads, and the point of putting the count up
 * there is that it MEANS something on the day it appears.
 */
export function shellsViewDescription(rows: readonly ShellRow[]): string {
  let running = 0;
  let background = 0;
  let awaiting = 0;
  for (const row of rows ?? []) {
    const run = row?.run;
    if (run?.outcome === 'running') {
      if (row.awaiting === true) awaiting++;
      else running++;
    } else if (run?.outcome === 'background') background++;
  }
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (background > 0) parts.push(`${background} background`);
  if (awaiting > 0) parts.push(`${awaiting} awaiting approval`);
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
    const waiting = new Set<string>();
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
      if (session.waiting === true) waiting.add(session.id);
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
    this.rows = pickShellRows(perSession, labels, { waiting });
    return this.rows;
  }

  /** The rows from the last scan — no filesystem work. */
  current(): readonly ShellRow[] {
    return this.rows;
  }

  /** How many commands are executing right now, background jobs included and
   *  calls awaiting approval excluded. This is the badge. */
  liveCount(): number {
    return countRunning(this.rows);
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
    const awaiting = row.awaiting === true;
    item.iconPath = new vscode.ThemeIcon(shellRunIconId(run, awaiting));
    item.contextValue = shellContextValue(run, awaiting);
    item.description = shellRunDetail({
      run,
      now,
      awaiting,
      ...(row.sessionLabel === undefined ? {} : { sessionLabel: row.sessionLabel }),
    });
    const cwd = this.cwds.get(run.sessionId);
    item.tooltip = shellRunTooltip({
      run,
      now,
      awaiting,
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
 * one-second clock while the view has rows and is on screen.
 *
 * TWO CADENCES, because the two things being kept true have different costs.
 * The SCAN is what finds a new command and what the badge is computed from, so
 * it must run whether or not the section is expanded — it rides the roster
 * tick, which is the extension's existing heartbeat, and adds a stat plus a
 * few appended kilobytes per live session to it. The CLOCK only advances
 * numbers that are already on screen, so it is pure waste when nothing is
 * listed or nobody is looking, and it stops in both cases.
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
      view.description = shellsViewDescription(rows);
    } catch (err) {
      logError('shellsView.description', err);
    }
    // Rows, not `live`: a call awaiting approval has a clock too — how long
    // the prompt has been sitting there — and it is not in the badge count.
    schedule(rows.length > 0);
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
