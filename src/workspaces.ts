// src/workspaces.ts — project workspaces.
//
// The feature: while you work on a project, the window shows THAT project's
// tabs — its files, its sessions — and switching projects swaps the whole
// layout. The layout you leave is saved under the project you leave and
// restored when you come back, across window reloads and full app restarts
// (it lives in state.json).
//
// What a switch does, in order:
//
//   1. SAVE   — snapshot the layout under the project that was active: file
//               tabs by uri + editor group, sessions by session id — taken
//               from the TERMINAL REGISTRY, not from tab labels (claude
//               rewrites terminal titles while running, so labels identify
//               nothing). Sessions merely parked here by an earlier switch
//               are not part of the layout and are not snapshotted.
//   2. CLEAR  — hide what does not belong to the target project. A switch
//               NEVER parks: the old `parked` state (running, no tab, no
//               distinct row, no cap, no reaper) is retired at schema v8 —
//               it is how 84 detached sessions piled up unseen. Foreign
//               sessions follow the LEVELS (design/levels-and-modes.md):
//               * A DIRTY editor is never closed: unsaved work outranks tidy.
//               * A foreign SESSION leaves the screen in one of two ways:
//                 DETACH under GRACE (src/tmux.ts + src/idleClose.ts) — the
//                 session was launched inside the private tmux server, so
//                 disposing its terminal kills only the tmux client: the tab
//                 vanishes instantly and the claude process keeps running for
//                 `lineage.session.detachGraceMinutes`, so switching back
//                 re-attaches instantly. Busy sessions detach like idle ones
//                 — nothing is interrupted. The record gets `graceUntil` plus
//                 the tmux name; the tree shows a COUNTDOWN row (the one
//                 sanctioned detached-running state always renders), and at
//                 the deadline the lifecycle sweep ends it to level 2.
//                 CLOSE to level 2 (the always-available fallback: no tmux,
//                 Windows, a session launched outside the wrap) — the
//                 terminal is closed outright, the claude process ends,
//                 instantly and silently (an API dispose never raises the
//                 workbench's "terminate?" dialog). The record gets `closed`:
//                 an ordinary archived row, and `--resume` brings the
//                 conversation back whole (the re-key machinery absorbs the
//                 fresh generation id that mints).
//                 The terminal panel is NEVER involved in either tier: an
//                 earlier design stowed sessions into it, which was slow
//                 (each move is an active-terminal-addressed command that
//                 must reveal, confirm and race), lossy (a lost race
//                 stranded the session in the panel), and visible (the panel
//                 popped open full of claude tabs). Clearing by dispose is
//                 instant and leaves nothing to see.
//               * A BUSY or WAITING foreign session in the CLOSE tier is
//                 never closed — a turn in flight and a blocked permission
//                 dialog both outrank tidiness the same way unsaved work
//                 does. Its tab stays open, reported, and the next switch
//                 sweeps it once it is idle (or detaches it, tmux having
//                 appeared).
//               * A terminal Flock does not own is never touched at all.
//               * A tab the TARGET's own saved layout names is spared, even
//                 when it sits outside every one of the project's directories:
//                 closing it only to reopen it a moment later is churn the
//                 user watches.
//   3. RESTORE — reopen the target project's saved file tabs in their editor
//               groups and bring its put-away sessions back as editor tabs,
//               in parallel: one still under GRACE re-attaches to its
//               running process (`new-session -A` under the recorded name —
//               the same argv resumes it instead if it died while hidden),
//               an ARCHIVED one named by the layout is `--resume`d (capped).
//               An archived session still LIVE somewhere with no tmux name
//               is either panel-parked by an older build of this extension
//               (moved home, one-shot migration) or hosted by another window
//               (left alone).
//   4. REVEAL  — the deep switch's arrival gesture (design/levels-and-modes.md):
//               the target (sub)project's folder is revealed in the Explorer
//               and its git context — branch, worktree — lands in the summary
//               line. Decided by src/deepSwitch.ts, performed by the wiring's
//               `revealSwitchTarget` dep, and a pure courtesy: a switch without
//               the dep, or whose reveal fails, is still a complete switch.
//
// A project CHAT leaves with its project like any other session of ours —
// but it leaves by the KILL tier, always, wrapped or not. A chat is a
// conversation ABOUT the project, opened on demand and asked for through Chat
// History, never restored (src/chatAutoClose.ts: the close is a plain
// terminal close, never a park; the conversation survives in Chat History).
// Gracing one instead would mint a running detached chat — and chats have no
// tree row, so that is a running process with NO surface anywhere, the exact
// unrepresentable state this branch removes. It is NOT part of any layout:
// never snapshotted, never auto-resumed.
//
// Webview tabs (Simple Browser and friends) are closed but NOT captured: the
// tab API exposes a webview's viewType, not its URL, so restoring one
// faithfully is impossible and a blank browser tab would be worse than none.
// This is the one part of a layout the snapshot knowingly loses.
//
// Three things survive a switch and are REPORTED rather than fixed: a dirty
// foreign tab, a terminal tab that is not one of our sessions, and anything the
// host refused to move. The first two are deliberate; all three are named in
// the log, because "that tab is still there" is the complaint this file exists
// to answer and an unexplained survivor reads as a bug either way.
//
// This module depends only on vscode, ./types, ./log and ./projects —
// everything else a switch needs arrives through the deps interface below, so
// the planning half can be exercised without a running window.

import * as vscode from 'vscode';

import { log, logError } from './log';
import {
  isSessionId,
  shortId,
  type EditorialRecord,
  type LaunchOptions,
  type ProjectRecord,
  type TerminalBinding,
  type TerminalLocationPref,
  type WorkspaceSnapshot,
  type WorkspaceTabRecord,
} from './types';
import { isWithin, projectDirs } from './projects';

// ------------------------------------------------------------- pure helpers

/** One open tab, reduced to the facts the planner needs. Built from the real
 *  Tab objects by the manager; built by hand in tests. */
export interface TabFacts {
  kind: 'file' | 'session' | 'other';
  /** Uri.toString() — kind 'file' only. */
  uri?: string;
  /** Uri.fsPath for file-scheme tabs, used for project containment. */
  fsPath?: string;
  /** kind 'session' only. */
  sessionId?: string;
  /** kind 'session' only: this session is a project CHAT. A chat is ours
   *  and is project-scoped, so a switch stows it away from a foreign project
   *  and brings it back to its own exactly like any other session. What it is
   *  NOT is part of a layout — see `layoutFacts` — so it is never snapshotted
   *  and never auto-resumed. */
  chat?: boolean;
  /** The tab hosts a terminal (kind 'other' then). It could be running
   *  anything, so a switch never closes it — closing a live terminal tab is
   *  also what raises the workbench's own "terminate running processes?"
   *  dialog. Note that this covers OUR sessions' tabs too: the tab API exposes
   *  no link from a terminal tab to its Terminal, so a switch cannot tell them
   *  apart here and moves its own by way of the registry instead. */
  terminal?: boolean;
  viewColumn: number;
  active: boolean;
  pinned: boolean;
  dirty: boolean;
  label: string;
}

export interface SwitchPlan {
  /** Tabs that stay: they belong to the target project (or are dirty, or are
   *  busy sessions, or are terminals we do not own). */
  keep: TabFacts[];
  /** Non-session tabs to close. */
  close: TabFacts[];
  /** Session ids to PUT AWAY: their terminal is closed. A tmux-wrapped one
   *  detaches under the grace deadline (`graceUntil` + countdown row, the
   *  switch back re-attaches); a bare one's process ends and the record gets
   *  `closed` — an archived row the switch back `--resume`s when its layout
   *  names it. The field keeps its historical name: the plan's tests and
   *  every caller read `park` as "leaves the screen". */
  park: string[];
  /** Foreign sessions that are BUSY (mid-turn) or WAITING (blocked on a
   *  dialog) — kept open and reported, exactly like dirty editors: work in
   *  flight is never killed for tidiness. */
  busyKept: TabFacts[];
  /** Dirty tabs that WOULD have closed — kept open, reported to the user. */
  dirtySkipped: TabFacts[];
  /** Terminal tabs the switch declined to close — the rule "a terminal tab is
   *  never closed", written down where it can be counted and tested.
   *
   *  This is EVERY terminal tab in the editor area, ours included: the tab
   *  model cannot say which Terminal a tab hosts, so the only honest claim
   *  about this list is "nothing here was closed", never "none of these is
   *  ours". The ones that ARE ours and foreign to the target still leave, by
   *  way of `park` — the tab follows the terminal into the panel — so what a
   *  switch actually left behind is read from the settled tab model at the end
   *  and not from here. */
  terminalsKept: TabFacts[];
}

/** Does this path live inside any of the project's directories? */
export function insideProject(
  dirs: readonly string[],
  fsPath: string | undefined,
): boolean {
  if (fsPath === undefined || fsPath === '') return false;
  return dirs.some((dir) => isWithin(dir, fsPath));
}

/**
 * Decide each tab's fate for a switch onto `targetDirs` (empty = "no
 * workspace": everything is foreign to nothing, so everything stays).
 * Pure — this is where the rules live and the tests bite.
 *
 * `isBusy` marks the sessions a switch must not kill: a turn in flight or a
 * blocked permission dialog. Omitted (older callers, tests) means nobody is.
 */
export function planSwitch(
  tabs: readonly TabFacts[],
  targetDirs: readonly string[],
  sessionCwdOf: (sessionId: string) => string | undefined,
  isBusy: (sessionId: string) => boolean = () => false,
): SwitchPlan {
  const plan: SwitchPlan = {
    keep: [],
    close: [],
    park: [],
    busyKept: [],
    dirtySkipped: [],
    terminalsKept: [],
  };
  if (targetDirs.length === 0) {
    plan.keep = [...tabs];
    plan.terminalsKept = tabs.filter((t) => t.terminal === true);
    return plan;
  }
  for (const tab of tabs) {
    let belongs: boolean;
    if (tab.kind === 'file') {
      belongs = insideProject(targetDirs, tab.fsPath);
    } else if (tab.kind === 'session') {
      const cwd = tab.sessionId ? sessionCwdOf(tab.sessionId) : undefined;
      belongs = insideProject(targetDirs, cwd);
    } else if (tab.terminal === true) {
      // A terminal tab is NEVER ours to close: it could be running anything,
      // and closing it is exactly what pops the workbench's "terminate running
      // processes?" dialog. It stays — and it is recorded, because a terminal
      // still sitting there after a switch is one of the tabs users describe as
      // "lingering" and it deserves a reason in the log.
      plan.keep.push(tab);
      plan.terminalsKept.push(tab);
      continue;
    } else {
      // A webview / settings page / diff of unknown provenance belongs to the
      // context being left behind.
      belongs = false;
    }
    if (belongs) {
      plan.keep.push(tab);
      continue;
    }
    if (tab.dirty) {
      plan.keep.push(tab);
      plan.dirtySkipped.push(tab);
      continue;
    }
    if (tab.kind === 'session' && isSessionId(tab.sessionId)) {
      // Parking closes the terminal, so a session mid-turn — or blocked on a
      // permission dialog — is spared the way a dirty editor is: killing it
      // would abort real work. It stays open, named in the report, and the
      // next switch parks it once it has gone idle.
      if (isBusy(tab.sessionId)) {
        plan.keep.push(tab);
        plan.busyKept.push(tab);
      } else {
        plan.park.push(tab.sessionId);
      }
    } else {
      plan.close.push(tab);
    }
  }
  return plan;
}

/**
 * What of the captured facts is actually THIS project's layout. Two kinds of
 * session are in the window but in no layout:
 *
 *   * one merely PUT AWAY here — a record still under a grace deadline whose
 *     tab an earlier switch failed to fully clear. Snapshotting it would make
 *     restoring this project revive a foreign session into it.
 *   * a project CHAT. A chat is a conversation ABOUT the project, not one
 *     of the tabs the project is worked in: it is opened on demand by the chat
 *     verb and closed when the thought is finished. Keeping it out of the
 *     snapshot is what stops a switch from reviving — or `--resume`ing — a chat
 *     the user is done with. It is still stowed and unstowed like any other
 *     session, so it does not linger in other projects' workspaces; only the
 *     LAYOUT never mentions it.
 */
export function layoutFacts(
  facts: readonly TabFacts[],
  isStowed: (sessionId: string) => boolean,
): TabFacts[] {
  return facts.filter((t) => {
    if (t.kind !== 'session') return true;
    if (t.chat === true) return false;
    if (t.sessionId === undefined) return true;
    return !isStowed(t.sessionId);
  });
}

/** The persistable part of a tab list: files and sessions, runtime facts
 *  stripped. */
export function snapshotTabs(tabs: readonly TabFacts[]): WorkspaceTabRecord[] {
  const out: WorkspaceTabRecord[] = [];
  for (const tab of tabs) {
    if (tab.kind === 'file' && typeof tab.uri === 'string' && tab.uri !== '') {
      const rec: WorkspaceTabRecord = {
        kind: 'file',
        uri: tab.uri,
        viewColumn: tab.viewColumn,
      };
      if (tab.active) rec.active = true;
      if (tab.pinned) rec.pinned = true;
      out.push(rec);
    } else if (
      tab.kind === 'session' &&
      // A chat is never part of a layout. `layoutFacts` already dropped it;
      // this is the belt to its braces, because a snapshot is the one thing a
      // switch writes that outlives the window, and a chat in there comes back
      // as a `--resume` on some future switch.
      tab.chat !== true &&
      isSessionId(tab.sessionId)
    ) {
      const rec: WorkspaceTabRecord = {
        kind: 'session',
        sessionId: tab.sessionId,
        viewColumn: tab.viewColumn,
      };
      if (tab.active) rec.active = true;
      out.push(rec);
    }
  }
  return out;
}

/** A tab's identity ACROSS the moves a switch makes. vscode.Tab objects are api
 *  wrappers the ext host may drop the moment a group opens or closes, and
 *  tabGroups.close() THROWS on a stale one and then closes NOTHING — so the
 *  close set travels as identities and is re-resolved against the live model at
 *  the moment of closing. */
export function tabIdentity(tab: TabFacts): string {
  if (tab.kind === 'file' && typeof tab.uri === 'string' && tab.uri !== '') {
    // Deliberately group-independent: the same uri open in two groups is
    // foreign in both, and both copies must be re-resolvable from one identity.
    return fileIdentity(tab.uri);
  }
  return `${tab.kind}|${tab.viewColumn}|${tab.label}`;
}

/** A file tab's identity from its uri alone — the ONE formula, shared by
 *  `tabIdentity` and `layoutIdentities` so that "spare what this layout wants"
 *  and "close this" can never disagree about what a tab is. */
function fileIdentity(uri: string): string {
  return `file|${uri}`;
}

/**
 * The identities of the tabs the target's saved layout is about to put back.
 *
 * A file the TARGET names in its own layout is not foreign to the target,
 * however its path reads — and the containment rule cannot see that. A layout
 * legitimately holds files outside every one of the project's directories (the
 * ~/.zshrc you opened while working on it), and an `untitled:` scratch tab has
 * no fsPath at all, so `planSwitch` calls both foreign and schedules them to
 * close. Closing one and then restoring it in the same switch is churn the user
 * WATCHES — the tab flashes shut and back — it double-counts in the summary
 * (once closed, once restored), and if the verify pass gets there afterwards
 * the tab is closed for good and the restored layout has silently lost it.
 *
 * Sparing them before anything closes is also what makes the verify pass safe
 * by construction: a tab that was never closed is never a tab a restore had to
 * reopen, so re-resolving the close set against the settled tab model cannot
 * reach anything the restore just opened.
 */
export function layoutIdentities(
  tabs: readonly WorkspaceTabRecord[],
): Set<string> {
  const out = new Set<string>();
  for (const tab of tabs) {
    if (tab.kind === 'file' && typeof tab.uri === 'string' && tab.uri !== '') {
      out.add(fileIdentity(tab.uri));
    }
  }
  return out;
}

/** What `restorePlan` decided, in the order a restore must replay it. */
export interface RestorePlan {
  /** File tabs still to open, grouped by ascending editor column. */
  files: WorkspaceTabRecord[];
  /** Session tabs to bring home — strictly after the files. */
  sessions: WorkspaceTabRecord[];
  /** The layout's active file, reported even when it is already open. */
  activeUri?: string;
  activeColumn?: number;
  /** The layout's active SESSION tab — the tab that held the keyboard when the
   *  layout was saved, when that tab was a session rather than a file. Never
   *  set alongside `activeUri`: exactly one tab in a window is the active one,
   *  and `captureTabs` only records a session as active when the active tab is
   *  a terminal tab. */
  activeSessionId?: string;
}

/**
 * Turn a saved layout into the order a restore must replay it in.
 *
 * Files come first and grouped by editor column, because the workbench reflows
 * the editor area per column: opening column 1's tabs, then column 2's, is one
 * reflow each instead of one per tab, and that interleaving is most of what a
 * switch looks like from the outside. Sessions come last so their fresh
 * terminal tabs land AFTER the files in each group — the shape the layout had.
 *
 * The active file is reported even when it is already open. The old restore
 * skipped an already-open tab outright and dropped the focus target with it —
 * so switching onto a project whose files were all still on screen left the
 * keyboard wherever it happened to be, which reads as the switch doing nothing.
 */
export function restorePlan(
  tabs: readonly WorkspaceTabRecord[],
  isOpen: (uri: string) => boolean,
): RestorePlan {
  const files: WorkspaceTabRecord[] = [];
  const sessions: WorkspaceTabRecord[] = [];
  let activeUri: string | undefined;
  let activeColumn: number | undefined;
  let activeSessionId: string | undefined;
  for (const tab of tabs) {
    if (tab.kind === 'file') {
      if (typeof tab.uri !== 'string' || tab.uri === '') continue;
      if (tab.active === true) {
        activeUri = tab.uri;
        activeColumn = tab.viewColumn;
      }
      if (isOpen(tab.uri)) continue;
      files.push(tab);
    } else if (tab.kind === 'session' && isSessionId(tab.sessionId)) {
      // Reported whether or not this session has to be resumed below: a
      // session already on screen is still the tab the layout was left on, and
      // dropping the target with the launch is what left the switch ending on
      // whichever restore happened to finish last.
      if (tab.active === true) activeSessionId = tab.sessionId;
      sessions.push(tab);
    }
  }
  // Array.prototype.sort is specified stable, so snapshot order survives
  // inside a column — a layout's tab order is part of the layout.
  files.sort((a, b) => a.viewColumn - b.viewColumn);
  const plan: RestorePlan = { files, sessions };
  if (activeUri !== undefined) {
    plan.activeUri = activeUri;
    plan.activeColumn = activeColumn;
  }
  if (activeSessionId !== undefined) plan.activeSessionId = activeSessionId;
  return plan;
}

/**
 * Everything a switch left on screen, each with the reason, one line per
 * category, in the form the log prints.
 *
 * Two of the three categories survive BY DESIGN and should: unsaved work
 * outranks tidiness, and a terminal tab we do not own is never closed because
 * closing a live one is exactly what raises the workbench's "terminate running
 * processes?" dialog — our own idle sessions are parked (their terminal
 * disposed via the API, which never prompts) and busy ones deliberately kept.
 * The third is honest failure: a tab the host refused to close, or a park
 * whose dispose threw.
 *
 * All three are named because the complaint a switch earns is always "that tab
 * is still there", and a survivor with a reason is a decision while a survivor
 * without one is a bug — the user cannot tell which from the tab alone.
 *
 * `terminalsLeft` is read from the SETTLED tab model rather than from the plan,
 * because the plan's terminal list is every terminal tab there was — including
 * the ones our own parks then closed. What the user is looking at is the only
 * honest answer to "what is still there".
 */
export function lingerLines(
  dirtyKept: readonly TabFacts[],
  terminalsLeft: readonly string[],
  unresolved: readonly string[],
): string[] {
  const name = (label: string): string =>
    label === '' ? '(untitled)' : label;
  const lines: string[] = [];
  if (dirtyKept.length > 0) {
    lines.push(
      'unsaved changes, never closed: ' +
        dirtyKept.map((t) => name(t.label)).join(', '),
    );
  }
  if (terminalsLeft.length > 0) {
    lines.push(
      'terminal tabs, never closed (a live terminal could be running ' +
        'anything; busy Flock sessions of other projects stay open until ' +
        'they finish): ' +
        terminalsLeft.map(name).join(', '),
    );
  }
  if (unresolved.length > 0) {
    lines.push(`would not clear: ${unresolved.join(', ')}`);
  }
  return lines;
}

// ------------------------------------------------------------- dependencies

export interface WorkspaceManagerDeps {
  // projects + snapshots (state.json)
  getProject(id: string): ProjectRecord | undefined;
  getWorkspace(projectId: string): WorkspaceSnapshot | undefined;
  saveWorkspace(projectId: string, tabs: WorkspaceTabRecord[]): Promise<void>;
  // editorial records
  getRecord(sessionId: string): EditorialRecord | undefined;
  allRecords(): Record<string, EditorialRecord>;
  upsertRecord(sessionId: string, patch: Partial<EditorialRecord>): Promise<void>;
  // sessions
  sessionCwd(sessionId: string): string | undefined;
  /** Present on the live roster right now. */
  isLive(sessionId: string): boolean;
  bindings(): TerminalBinding[];
  /** Re-walk the host's terminals and rebuild the binding table before a
   *  switch reads it: a binding whose terminal the host no longer lists is
   *  pruned, a revived terminal carrying our env stamp is picked up. Without
   *  this a switch plans against terminals that no longer exist — parking
   *  sessions whose tab is long gone, or missing one a window reload just
   *  revived. */
  refreshBindings(): void;
  /** PARK a session: dispose its terminal. The tab closes — instantly and
   *  silently (an API dispose never raises the workbench's "terminate running
   *  processes?" dialog). For a tmux-wrapped session this DETACHES (only the
   *  client dies; claude keeps running); for a bare one the claude process
   *  ends and the conversation lives on in its transcript, to be resumed by
   *  the switch back. Synchronous and confirmation-free by design: this is
   *  what makes a switch as fast as changing a tab. False when nothing is
   *  bound here or the dispose threw. */
  closeSessionTab(sessionId: string): boolean;
  /** END a session for real: dispose its terminal AND kill the process —
   *  through the tree-reaping funnel (killTmuxSessionTree for a wrap, the
   *  registry's walk-before-dispose reap for a bare launch). The CHAT tier's
   *  kill: a chat is never graced (it has no tree row to render a countdown
   *  on), so a switch ends it outright and Chat History is how it is asked
   *  for again. Optional: an older wiring (and every unit double) falls back
   *  to `closeSessionTab` — the dispose still happens, the wrap of a wrapped
   *  chat is then the activation reconcile's to end (unclaimed, no grace). */
  endSessionTab?(sessionId: string): boolean;
  /** Is the session mid-turn (busy) or blocked on a dialog (waiting)? A
   *  switch never KILLS those — their tabs stay open and are reported. Only
   *  consulted where the sweep would KILL: the bare tier, and every chat
   *  (chats are killed, never detached, so a busy chat keeps its tab). */
  isSessionBusy(sessionId: string): boolean;
  /** Detach tier (src/tmux.ts): the tmux session name backing this session's
   *  terminal, when its launch was wrapped in the private server — undefined
   *  for a bare launch. Decides the parking tier: with a name, the dispose
   *  above only detaches. Probed under every generation id by the wiring.
   *  Optional so an older wiring (and the unit doubles) behaves as "none",
   *  which is the kill tier — always correct, merely lossier. */
  tmuxNameOf?(sessionId: string): string | undefined;
  /** LEGACY migration only: an older build of this extension parked sessions
   *  by moving their terminal into the terminal panel, where a still-running
   *  one may sit to this day. This brings such a terminal back as an editor
   *  tab (slow, active-terminal-addressed — acceptable for a one-shot
   *  migration path). Never called for sessions this build parked: those are
   *  dead by construction. */
  unstowSessionTab(sessionId: string): Promise<boolean>;
  /** Session id of the workbench's active terminal, when it is ours. */
  activeSessionId(): string | null;
  /** Reveal and focus a session's terminal. False when not bound here. */
  focusSession(sessionId: string): boolean;
  launchSession(opts: LaunchOptions): Promise<TerminalBinding | null>;
  /** The account environment a parked conversation must come back on — its
   *  PIN, resolved by the wiring (state.getSessionProfile ->
   *  routing.pinnedLaunchProfile -> accounts.envForProfile). A restore is a resume,
   *  and a resume that landed on a different account would point claude at a
   *  config directory that does not contain the conversation.
   *
   *  Optional, and undefined for a session with no pin (anything launched
   *  before accounts existed) — which restores exactly as it always did. Asked
   *  for the TIP id, the one the launch below uses.
   *
   *  Matters most on the KILL tier: the reattach tier hands the terminal back
   *  to a process that never died and still carries its original environment.
   *  It is passed on both paths anyway, because `new-session -A` falls through
   *  to `--resume` when the detached session died while it was parked. */
  accountLaunchFor?(sessionId: string): {
    env?: Readonly<Record<string, string>>;
    profileId?: string;
  } | undefined;
  hasTranscript(sessionId: string): boolean;
  /** Point the transcript's recorded resume leaf at its actual tip before the
   *  `--resume` below reads it — a restore is a resume, and inherits the same
   *  mid-turn-leaf truncation a fork does (see resumeLeaf.ts). Optional; absent
   *  means the restore behaves as it always has. */
  repairResumeLeaf?(sessionId: string): unknown;
  /** Chain routing — a parked id may have been superseded since. */
  tipOf(sessionId: string): string;
  // per-WINDOW persistence (workspaceState memento)
  getActive(): string | null;
  setActive(projectId: string | null): Promise<void>;
  // config
  resumeSessions(): boolean;
  /** `lineage.session.detachGraceMinutes` — how long a detached (tmux-backed)
   *  session may keep running after its tab closes, so switching back
   *  re-attaches instantly. The sweep in extension.ts ends it at the deadline.
   *  Optional: an older wiring (and every unit double) behaves as the shipped
   *  default. `0` means no grace — the record is written with an already-
   *  expired deadline and the next sweep tick (within a minute) kills the
   *  wrap, tree and all; the switch itself stays process-free either way. */
  detachGraceMinutes?(): number;
  /** `lineage.soloSession` — the quality-of-life mode: at most one session
   *  tab open at a time. Read by `parkOthers` (which is a no-op without it)
   *  and by the restore step, which then brings back only the session the
   *  user was last using instead of the whole saved set. Optional: an older
   *  wiring (and every unit double that does not care) behaves as OFF. */
  soloSession?(): boolean;
  /** Where new session terminals live. Optional: a host wiring that predates
   *  the setting simply behaves as `'editor'`, which is the default. */
  terminalLocation?(): TerminalLocationPref;
  refresh(): void;
  /** Point the BUILT-IN Explorer's folder tree at this project's
   *  directories — main root on top, extra connected directories as their own
   *  collapsible roots below it. See src/explorer.ts for why this is a folder
   *  splice and not a file tree of our own.
   *
   *  Optional, and a no-op in three ordinary cases: the window was never
   *  converted to a Flock workspace, the user turned the feature off, or this
   *  is a unit double. A switch never depends on it — the tabs are the
   *  workspace, the Explorer is a view of it. */
  syncExplorer?(project: ProjectRecord | null): Promise<void>;
  /** THE DEEP SWITCH's arrival gesture (design/levels-and-modes.md, project
   *  mode): reveal the target (sub)project's folder in the Explorer and read
   *  its git context — which branch, which worktree. The DECISION is
   *  src/deepSwitch.ts (pure); this dep is the wiring that owns the worktree
   *  probe, the lane lookup and the `revealInExplorer` call, none of which the
   *  manager can reach. `trigger` is the session that caused an auto switch,
   *  when there was one — its lane stamp is what narrows the reveal from the
   *  project's root to the lane the user actually moved into.
   *
   *  Returns a fragment for the switch summary's comma list ("now on feat/x
   *  (worktree app-feat-x)"), or '' when there is nothing worth a clause.
   *  Optional, and a switch works identically without it (older wiring, unit
   *  doubles): the reveal is a courtesy on top of the transaction, never a
   *  step of it — which is also why the manager swallows its failures. */
  revealSwitchTarget?(
    project: ProjectRecord,
    opts: { auto: boolean; trigger: string | null },
  ): Promise<string>;
  /** Stop repainting the sidebar until `resumeViews`. A switch writes a record
   *  per parked and per restored session and closes a batch of tabs; each of
   *  those fires a state change, and rebuilding the forest on every one
   *  repaints the tree a dozen times mid-switch — which is the flicker, and
   *  which also throws away the user's scroll position. */
  suspendViews(): void;
  /** Repaint once, at the end. Must be called even when the switch threw. */
  resumeViews(): void;
}

// ----------------------------------------------------------------- manager

/** Cap on auto-resumed sessions per switch: each one is a live claude
 *  process, and restoring a project must not silently fork-bomb the machine
 *  because a snapshot was taken on a very wide day. */
const MAX_AUTO_RESUME = 8;
/** Auto (focus-follows) switches ignore triggers this soon after the last
 *  switch — the events inside the window are the switch's own echoes. */
const AUTO_SWITCH_COOLDOWN_MS = 2_000;
/** How long a session this window just KILLED keeps overriding the roster's
 *  claim that it is live. `claude agents --json` needs a tick or two to drop
 *  a process we disposed, and a rapid switch-back inside that window would
 *  otherwise read the stale row as "running in another window" and restore
 *  nothing — stranding the session archived. Comfortably above any roster
 *  refresh interval; comfortably below how long a stale row could mislead.
 *  NOT the detach grace (`lineage.session.detachGraceMinutes`): this is
 *  roster-staleness bookkeeping measured in seconds, that is a lifecycle
 *  deadline measured in minutes. */
const KILL_GRACE_MS = 30_000;

/** What one restore did. The verify pass needs no restored-id bookkeeping any
 *  more: put-away sessions are resumed (never re-swept — the sweep set and
 *  the restore set are disjoint by project), and the close set was stripped
 *  of every identity this layout could reopen before anything closed at all
 *  (see `layoutIdentities`). */
interface RestoreResult {
  files: number;
  sessions: number;
  /** The session tab the layout was left on, when it named one. */
  activeSessionId?: string;
  activeUri?: string;
  activeColumn?: number;
}

export class WorkspaceManager {
  private readonly deps: WorkspaceManagerDeps;
  /** Re-entry guard: a switch rearranges tabs and terminals, which fires the
   *  very focus events that can trigger an auto switch. */
  private switching = false;
  /** End of the last switch, for the auto-switch cooldown below. */
  private lastSwitchDone = 0;
  /** Sessions THIS window parked (killed) recently, by id and by tip →
   *  timestamp. The roster keeps listing a disposed process for a tick or
   *  two, and a switch-back inside that window must read it as dead-by-us —
   *  resumable — rather than as live in another window. See KILL_GRACE_MS. */
  private readonly recentlyKilled = new Map<string, number>();
  /** Serialises legacy unstows. Restores run in PARALLEL now, but the unstow
   *  is an active-terminal-addressed move — two in flight would race each
   *  other's reveal/confirm and both could fail. Switches made by this build
   *  never take this path (parked sessions are dead), so the queue costs
   *  nothing outside the one-shot migration of panel-parked legacy sessions. */
  private unstowQueue: Promise<void> = Promise.resolve();

  constructor(deps: WorkspaceManagerDeps) {
    this.deps = deps;
  }

  activeProjectId(): string | null {
    try {
      return this.deps.getActive();
    } catch (err) {
      logError('workspaces.getActive', err);
      return null;
    }
  }

  /** True while a switch is rearranging the window. Extension.ts consults
   *  this to ignore the focus events the switch itself fires — stowing
   *  focuses each terminal it moves, and "the user looked at it" must not be
   *  inferred from that. */
  isSwitching(): boolean {
    return this.switching;
  }

  /**
   * QUALITY-OF-LIFE (`lineage.soloSession`): one session tab at a time.
   * Called by the wiring after a session's tab opened or was focused — put
   * away every OTHER session bound in this window, exactly the way a
   * workspace switch puts away a foreign one, so the two paths cannot
   * disagree about what leaving the screen means:
   *
   *   * DETACH under GRACE — tmux-wrapped: the tab closes, the process keeps
   *     running until the grace deadline (a countdown row in the tree), and
   *     clicking the row re-attaches. Busy or not.
   *   * CLOSE to level 2 — bare launch: the terminal is disposed and
   *     `--resume` brings the conversation back from the tree. A BUSY or
   *     WAITING bare session is spared — a turn in flight outranks tidiness
   *     here for the same reason it does in a switch.
   *
   * Returns null when the mode is off or a switch is mid-flight (the switch
   * owns the tabs right then and this must not fight it); otherwise how many
   * tabs were put away — zero is the ordinary answer once the invariant holds.
   *
   * `keepSessionId` is compared by CHAIN TIP: a re-keyed generation of the
   * kept conversation is the same tab, not a victim. Deliberately NOT gated
   * on `resumeSessions` (that setting is about what a switch restores
   * unasked); every session put away here has a row in the tree, and the row
   * is how it comes back.
   *
   * A project CHAT is never a victim: it is not a session tab, and "every
   * session put away here has a row" is exactly what a chat does not have —
   * sweeping one away because the user focused their pinned session throws
   * away a conversation they were mid-thought in, with nothing on screen to
   * say where it went. Its tab tidiness is the auto-close window
   * (`lineage.chat.autoCloseMinutes`), not solo mode. WORKSPACE-SWITCH
   * sweeping is deliberately untouched: a foreign chat must still leave the
   * screen when its project does, or project A's chats sit on project B's
   * screen.
   */
  /**
   * `opts.stow` — whether the records this puts away carry `stowedBySwitch`.
   *
   * TRUE in project mode, where the marker is the truth: a switch put the
   * session away and the switch BACK is what brings it home, so the marker is
   * how restoreSession tells a switch-stowed row from a user-closed one.
   *
   * FALSE in folder mode, which has no switch to come back. Writing the marker
   * there was a real leak, not a cosmetic one: solo mode reached straight into
   * the switcher's machinery, so a folder-mode window minted records saying
   * "a switch will bring this home" that nothing would ever honour. The grace
   * tier still applies — a graced session in folder mode is in scope, on
   * screen, counting down — it just isn't labelled as switch bookkeeping.
   */
  async parkOthers(
    keepSessionId: string,
    opts?: { stow?: boolean },
  ): Promise<number | null> {
    if (this.safeSolo() !== true) return null;
    if (this.switching) return null;
    try {
      this.deps.refreshBindings();
    } catch (err) {
      logError('workspaces.parkOthers.refreshBindings', err);
    }
    const keepTip = this.safeTip(keepSessionId);
    const victims: string[] = [];
    const seen = new Set<string>();
    for (const binding of this.safeBindings()) {
      const tip = this.safeTip(binding.sessionId);
      if (tip === keepTip || seen.has(tip)) continue;
      seen.add(tip);
      // A chat is exempt — see the contract above. Checked here, on the
      // victim side, rather than in the callers: solo mode itself must not be
      // able to sweep a chat away, whoever asked for the enforcement.
      if (this.isChat(binding.sessionId)) continue;
      // Same spare rule as planSwitch, same shape: busy only matters where
      // parking would kill.
      if (
        this.safeIsBusy(binding.sessionId) &&
        this.safeTmuxName(binding.sessionId) === undefined &&
        this.safeTmuxName(tip) === undefined
      ) {
        continue;
      }
      victims.push(binding.sessionId);
    }
    if (victims.length === 0) return 0;
    const writes: Array<Promise<void>> = [];
    const parked = this.parkSweep(victims, writes, opts?.stow !== false);
    await Promise.all(writes);
    log(
      `workspaces: solo — put away ${String(parked.detached + parked.killed)} ` +
        `session tab(s) (${String(parked.detached)} detached under grace, ` +
        `${String(parked.killed)} closed), keeping ${shortId(keepTip)}`,
    );
    this.deps.refresh();
    return parked.detached + parked.killed;
  }

  /**
   * The whole verb. `projectId === null` leaves workspace mode: the current
   * layout is saved under the project being left, and nothing is closed —
   * "show everything" must never cost the user a tab.
   *
   * `opts.auto` is the focus-follows path (extension.ts switches when the
   * user starts working in a session of another project). An auto switch
   * must never interrupt: its summary goes to the status bar rather than a
   * toast. Busy foreign sessions are kept open on BOTH paths — parking kills
   * the process now, and a switch never aborts work in flight.
   *
   * `opts.focusSessionId` is the session that TRIGGERED an auto switch, and it
   * is what the switch must end on — see `settleFocus`. The caller passes it
   * because it knows it for certain; by the time the switch finishes,
   * `window.activeTerminal` names whichever terminal the restore revealed last.
   */
  async switchTo(
    projectId: string | null,
    opts?: { auto?: boolean; focusSessionId?: string },
  ): Promise<void> {
    const auto = opts?.auto === true;
    if (this.switching) {
      log('workspaces: switch already in flight — ignored');
      return;
    }
    // Focus events keep arriving for a moment after a switch rearranged the
    // window (a closed tab hands focus on, a resumed terminal opens). An auto
    // trigger inside the cooldown is an echo of the switch itself, not the
    // user moving — dropping it is what makes focus-follows stable.
    if (auto && Date.now() - this.lastSwitchDone < AUTO_SWITCH_COOLDOWN_MS) {
      log('workspaces: auto switch inside the cooldown — ignored');
      return;
    }
    this.switching = true;
    // Views off for the duration. Everything below fires state changes — a
    // record per parked session, a record per restored one, a closed tab
    // batch — and a sidebar that rebuilds on each of them repaints a dozen
    // intermediate trees, loses the scroll position, and is most of what
    // "switching looks janky" describes.
    try {
      this.deps.suspendViews();
    } catch (err) {
      logError('workspaces.suspendViews', err);
    }
    try {
      // A manual switch is a user-initiated verb that can take a second or
      // two; the window spinner is what says "it is working" while the tabs
      // are still the old ones. An auto switch is a side effect of just
      // working and gets no chrome at all.
      await this.withIndicator(
        auto ? null : 'Flock: switching workspace…',
        () => this.doSwitch(projectId, auto, opts?.focusSessionId ?? null),
      );
    } finally {
      try {
        this.deps.resumeViews();
      } catch (err) {
        logError('workspaces.resumeViews', err);
      }
      this.switching = false;
      this.lastSwitchDone = Date.now();
    }
  }

  private async doSwitch(
    projectId: string | null,
    auto: boolean,
    trigger: string | null,
  ): Promise<void> {
    const current = this.activeProjectId();
    const target = projectId ? this.deps.getProject(projectId) : undefined;
    if (projectId && !target) {
      void this.message('Flock: that project no longer exists.');
      return;
    }
    log(
      'workspaces: switch',
      current ?? '(none)',
      '->',
      projectId ?? '(none)',
      auto ? '(auto)' : '(manual)',
    );

    // Where the keyboard is BEFORE anything moves: the closes can promote an
    // arbitrary neighbouring tab when the active one goes, so the switch has
    // to know where to hand focus back afterwards.
    const wasActive = this.safeActiveSession();

    // Re-walk the host's terminals FIRST. A binding whose terminal died with a
    // missed close event, or a terminal revived by a window reload that
    // nothing has claimed yet, both make the plan below describe a window that
    // no longer exists — and a put-away decision taken against a terminal that
    // is gone writes the record a grace deadline while the tab it meant to
    // move stays exactly where it is.
    try {
      this.deps.refreshBindings();
    } catch (err) {
      logError('workspaces.refreshBindings', err);
    }

    const facts = this.captureTabs();
    log(
      `workspaces: captured ${facts.length} tab(s) — ` +
        `${facts.filter((t) => t.kind === 'file').length} file, ` +
        `${facts.filter((t) => t.kind === 'session').length} session, ` +
        `${facts.filter((t) => t.kind === 'other').length} other`,
    );

    // 1. SAVE the layout under the project being left (or re-saved). A
    // session that is merely PUT AWAY here — still under a grace deadline —
    // is part of no layout: snapshotting it would make restoring THIS project
    // resume a foreign session. Nor is a session whose cwd lies outside the
    // project — a busy foreign session an earlier switch had to leave open is
    // in the window, but it is not part of this project's layout, and the
    // restore path would (rightly) refuse it anyway.
    const currentProject = current !== null ? this.deps.getProject(current) : undefined;
    if (current !== null && currentProject) {
      const currentDirs = projectDirs(currentProject);
      const layout = layoutFacts(facts, (id) => {
        const record =
          this.deps.getRecord(this.safeTip(id)) ?? this.deps.getRecord(id);
        return record?.graceUntil != null;
      }).filter(
        (t) =>
          t.kind !== 'session' ||
          insideProject(
            currentDirs,
            t.sessionId ? this.deps.sessionCwd(t.sessionId) : undefined,
          ),
      );
      try {
        await this.deps.saveWorkspace(current, snapshotTabs(layout));
        log('workspaces: saved layout for', current, `(${layout.length} tabs)`);
      } catch (err) {
        logError('workspaces.save', err);
      }
    }

    if (projectId === current) {
      if (projectId !== null && !auto) {
        void this.message(
          `Flock: "${target?.name ?? projectId}" is already the active ` +
            'workspace — layout saved.',
        );
      }
      return;
    }

    if (projectId === null || !target) {
      await this.deps.setActive(null);
      this.deps.refresh();
      // The Explorer is deliberately LEFT ALONE here. Leaving workspace
      // mode is the "show everything" door and its promise is that it costs
      // nothing — clearing the folder tree back to the bare anchor would be
      // this verb taking something away, which is the one thing it says it
      // never does. The folders stay until a switch moves them.
      void this.message('Flock: left workspace mode — nothing was closed.');
      return;
    }

    // 2. CLEAR what does not belong to the target.
    const dirs = projectDirs(target);
    const plan = planSwitch(
      facts,
      dirs,
      (id) => this.deps.sessionCwd(id),
      // "Busy" spares a session from the sweep because the close tier aborts
      // its turn. A tmux-backed session DETACHES under grace — the process
      // keeps running, on a visible countdown — so being busy is no reason to
      // keep its tab. A CHAT is the exception even when wrapped: chats are
      // KILLED, never graced (parkSweep's chat tier), so a busy chat keeps
      // its tab exactly like a busy bare session — never interrupted.
      (id) =>
        this.safeIsBusy(id) &&
        (this.safeTmuxName(id) === undefined || this.isChat(id)),
    );

    // Putting a session away assumes the switch back BRINGS IT BACK, so with
    // resume turned off the close tier would be a session silently archived
    // with no comeback, and the grace tier's re-attach after a death while
    // hidden is still a resume — which is exactly what the setting forbids.
    // The honest degradation for both tiers is the busy treatment: the tab
    // stays open, named in the report.
    const resumeOk = this.safeResumeSessions();
    const parkIds = resumeOk ? plan.park : [];
    const parkSkipped = resumeOk ? 0 : plan.park.length;
    if (parkSkipped > 0) {
      log(
        `workspaces: ${parkSkipped} foreign session(s) left open — ` +
          'lineage.workspaces.resumeSessions is off, so parking would not ' +
          'bring them back',
      );
    }

    // …except what the target's own layout names. A file can be in a project's
    // layout and outside all of its directories at once, and `planSwitch` —
    // which only knows paths — calls that foreign. Closing it here just to have
    // `restore` reopen it a moment later is a tab the user watches flash, a tab
    // counted twice in the summary, and, once the verify pass re-resolves the
    // same identity against the settled model, a tab the restored layout loses
    // outright. Spared once, up front: the close set below is the one used by
    // BOTH the close and the verify pass, so nothing the restore opens is ever
    // in it.
    const spared = layoutIdentities(this.savedTabs(projectId));
    const closeSet = plan.close.filter((t) => !spared.has(tabIdentity(t)));
    // Same correction for the report: a dirty tab that is part of the target's
    // layout was never "left behind", it belongs here.
    const dirtyKept = plan.dirtySkipped.filter(
      (t) => !spared.has(tabIdentity(t)),
    );
    log(
      `workspaces: plan — keep ${plan.keep.length}, close ${closeSet.length}, ` +
        `park ${parkIds.length}, busy-kept ${plan.busyKept.length}, ` +
        `dirty-kept ${dirtyKept.length}, ` +
        `terminal tabs left alone ${plan.terminalsKept.length}` +
        (plan.close.length > closeSet.length
          ? `, ${plan.close.length - closeSet.length} spared (in this ` +
            "project's own saved layout)"
          : ''),
    );

    // Every record this switch writes goes in here and is flushed ONCE at the
    // end. Each upsert is a state.json write plus an onDidChange, and awaiting
    // them inline is what made a switch cost one full forest rebuild per
    // parked session.
    const writes: Array<Promise<void>> = [];

    // CLOSE FIRST — one batched close, one editor reflow. The close set can
    // never hold a terminal tab (factOf marks every terminal tab kind 'other'
    // + terminal:true and planSwitch keeps those), so our own parks disposing
    // terminal editor tabs cannot invalidate the batch's api objects.
    let closed = await this.closeTabs(closeSet);

    // PUT AWAY foreign sessions: dispose each terminal — instant, silent, no
    // confirmation to wait on and no panel to reveal. This is the reason a
    // switch is as fast as changing a tab. A tmux-backed one thereby DETACHES
    // under a grace deadline (the process keeps working until the sweep's
    // countdown ends — visible as a countdown row, never a hidden park); a
    // bare one dies and its record is closed to level 2. The record's
    // `graceUntil` (plus the tmux name) or `closed` stamp is what tells the
    // switch-back how to bring each one home.
    const park = this.parkSweep(parkIds, writes);

    // 2b. The EXPLORER follows. Before the restore rather than after:
    // the restore reopens this project's files, and opening them into a folder
    // tree that still shows the OLD project is what makes every restored tab
    // read as "outside the workspace" for the second it takes to catch up.
    // Awaited, because the folder API forbids a second splice before its change
    // event lands and the next switch could be moments away.
    await this.syncExplorer(target);

    // 3. RESTORE the target's saved layout.
    const restored = await this.restore(target, writes);

    // 4. VERIFY. Everything this switch decided to CLOSE is checked against
    // the live model one more time, now that the layout has settled: a batch
    // the host refused, a tab that was dirty when the plan was made. It never
    // re-plans, and it cannot reach anything the restore opened — the close
    // set was stripped of every identity the layout could reopen up front.
    const verify = await this.verifyClose(closeSet, park.failed);
    closed += verify.closed;

    await this.deps.setActive(projectId);

    // 5. REVEAL where the user has landed — the deep switch's arrival gesture:
    // the target (sub)project's folder in the Explorer, plus the git context
    // the summary line below narrates. BEFORE settleFocus on purpose: a
    // `revealInExplorer` hands focus to the Explorer, and the switch's focus
    // contract is that settleFocus decides LAST — the reveal orients the file
    // tree, the settle puts the keyboard where the user asked. Failures are
    // swallowed (and '' returned): the reveal is a courtesy on top of the
    // transaction, and a switch that moved every tab correctly must not report
    // failure because a git probe timed out.
    const revealNote = await this.revealSwitchTarget(target, auto, trigger);

    // ONE focus decision, and it is the LAST thing the switch does.
    await this.settleFocus({ auto, trigger, wasActive, restored, parked: parkIds });

    // One coalesced flush: every parked/unparked record lands together, so the
    // store emits one change and the sidebar rebuilds once.
    await Promise.all(writes);
    this.deps.refresh();

    // Counts are what actually happened, not what was planned — a switch that
    // says "4 foreign tabs closed" while 4 are still on screen is worse than
    // saying nothing, and that gap is exactly the bug this reports on.
    const bits = [
      restored.files > 0 ? `${restored.files} tab${restored.files === 1 ? '' : 's'} restored` : '',
      restored.sessions > 0 ? `${restored.sessions} session${restored.sessions === 1 ? '' : 's'} resumed` : '',
      // The git context the arrival reveal read ("now on feat/x"), so the one
      // summary line answers "where am I?" as well as "what moved?".
      revealNote,
      park.detached > 0
        ? `${park.detached} session${park.detached === 1 ? '' : 's'} hidden ` +
          '(still running — they come back when you switch back)'
        : '',
      park.killed > 0
        ? `${park.killed} session${park.killed === 1 ? '' : 's'} closed (they resume when you switch back)`
        : '',
      // Chats do NOT come back on a switch-back — Chat History is how a chat
      // is asked for — so their count says so instead of borrowing the
      // sessions' "they resume" promise.
      park.chats > 0
        ? `${park.chats} chat${park.chats === 1 ? '' : 's'} closed (reopen from Chat History)`
        : '',
      closed > 0 ? `${closed} foreign tab${closed === 1 ? '' : 's'} closed` : '',
      // The remaining bits say WHY, not just how many: a count of tabs that
      // stayed put is the exact shape of "the switch did not work", and the
      // reason is the difference between a decision and a defect.
      plan.busyKept.length > 0
        ? `${plan.busyKept.length} busy session${plan.busyKept.length === 1 ? '' : 's'} ` +
          'left open (still working — never interrupted)'
        : '',
      parkSkipped > 0
        ? `${parkSkipped} foreign session${parkSkipped === 1 ? '' : 's'} left ` +
          'open (resumeSessions is off)'
        : '',
      dirtyKept.length > 0
        ? `${dirtyKept.length} unsaved tab${dirtyKept.length === 1 ? '' : 's'} ` +
          'kept open (unsaved work is never closed)'
        : '',
      verify.unresolved.length > 0
        ? `${verify.unresolved.length} could not be cleared (${verify.unresolved.join(', ')})`
        : '',
    ].filter((s) => s !== '');
    const summary =
      bits.length > 0
        ? `Flock: switched to the "${target.name}" workspace — ${bits.join(', ')}.`
        : `Flock: switched to the "${target.name}" workspace. Everything open ` +
          'already belongs to it; the layout is saved when you switch away and ' +
          'restored when you come back.';
    log('workspaces:', summary);
    // Every tab still on screen that the switch did not put there, with its
    // reason — including the two categories that survive by design. The status
    // bar cannot carry this much and a toast per switch would be worse than the
    // lingering tab, so it goes where a user who asks "why is that still open?"
    // can find the answer.
    for (const line of lingerLines(
      dirtyKept,
      this.terminalTabLabels(),
      verify.unresolved,
    )) {
      log('workspaces: left on screen —', line);
    }
    // A toast interrupts, so it is spent only on the outcome the user has to
    // act on: work we deliberately left open. Everything else the spinner
    // already answered — the tabs on screen are the report.
    if (!auto && dirtyKept.length > 0) this.toast(summary);
    else this.message(summary);
  }

  // -------------------------------------------------------------- capture

  /** The live tab model, each tab paired with its facts. Read fresh every
   *  time it is needed: a vscode.Tab is an api wrapper the extension host may
   *  drop the moment a group opens or closes, and a stale one poisons the
   *  whole call it is passed to. Nothing here is ever cached across an await. */
  private liveTabs(): Array<{ tab: vscode.Tab; fact: TabFacts }> {
    const out: Array<{ tab: vscode.Tab; fact: TabFacts }> = [];
    for (const group of this.tabGroups()?.all ?? []) {
      for (const tab of group.tabs ?? []) {
        try {
          out.push({ tab, fact: this.factOf(tab, group) });
        } catch (err) {
          logError('workspaces.factOf', err);
        }
      }
    }
    return out;
  }

  private captureTabs(): TabFacts[] {
    const facts: TabFacts[] = this.liveTabs().map((entry) => entry.fact);

    // SESSIONS come from the terminal REGISTRY, not from the tabs above. A
    // terminal tab exposes no link to its Terminal object, and the first
    // implementation matched tab labels against binding names — which broke
    // the moment claude rewrote its terminal title (it does, constantly,
    // while running), leaving every session tab classified as a foreign
    // terminal: nothing parked, nothing saved. The registry holds the actual
    // Terminal for every session hosted by this window (re-bound across
    // reloads via the env stamp and roster pids), and stow/unstow act on that
    // Terminal directly, so no vscode.Tab is needed — the session's own tab,
    // captured above as an anonymous terminal ('other', kept, never closed),
    // simply follows the move.
    //
    // Unless sessions do not live in the editor area at all. With
    // `lineage.terminalLocation: 'panel'` a session has no editor tab, so
    // there is nothing for a switch to park — and the stow would resolve
    // against some other terminal — while the switch back would drag it into
    // an editor tab and permanently defeat the setting. Such a window's
    // snapshots are file-only, which is what a panel layout IS.
    if (this.terminalLocationPref() === 'panel') return facts;

    // WHICH session was in front, for the layout to be restored onto. The tab
    // API cannot say which Terminal a terminal tab hosts, so it is triangulated
    // from the two halves that are knowable: the tab holding the keyboard is a
    // terminal tab, and the workbench's active terminal is one of ours. Both
    // halves are required — `window.activeTerminal` keeps naming the last
    // terminal long after focus moved to an editor, and recording a session as
    // active while a FILE tab is the active one would put two active tabs in
    // one snapshot.
    const activeSession = facts.some((t) => t.active && t.terminal === true)
      ? this.safeActiveSession()
      : null;

    for (const binding of this.safeBindings()) {
      facts.push({
        kind: 'session',
        sessionId: binding.sessionId,
        // A project CHAT is a session for every purpose a switch has — it
        // is ours, and `ProjectRecord.chatSessionId` makes it as project-scoped
        // as any session's cwd does — so it is planned, stowed and unstowed
        // like one. Only its LAYOUT status differs (`layoutFacts` drops it),
        // which is what keeps a chat out of snapshots and out of the resume
        // path. Leaving it out of the facts entirely instead would leave its
        // terminal tab to the "a terminal is never closed" branch, and project
        // A's chat would then sit in project B's window forever.
        ...(this.isChat(binding.sessionId) ? { chat: true } : {}),
        // The tab API cannot say which editor group a terminal sits in, so a
        // restored session lands in group 1 — a knowingly lossy default.
        viewColumn: 1,
        active: activeSession === binding.sessionId,
        pinned: false,
        dirty: false,
        label: binding.terminalName,
      });
    }
    return facts;
  }

  private factOf(tab: vscode.Tab, group: vscode.TabGroup): TabFacts {
    const base: TabFacts = {
      kind: 'other',
      viewColumn: typeof group.viewColumn === 'number' ? group.viewColumn : 1,
      active: tab.isActive === true && group.isActive === true,
      pinned: tab.isPinned === true,
      dirty: tab.isDirty === true,
      label: typeof tab.label === 'string' ? tab.label : '',
    };

    const input: unknown = tab.input;
    const uri = fileUriOf(input);
    if (uri) {
      base.kind = 'file';
      base.uri = uri.toString();
      if (uri.scheme === 'file') base.fsPath = uri.fsPath;
      return base;
    }

    if (isTerminalInput(input)) {
      // EVERY terminal tab is hands-off, ours or not: sessions are identified
      // and moved via the registry (see captureTabs), and closing a terminal
      // tab is exactly what pops the workbench's "terminate running
      // processes?" dialog.
      base.terminal = true;
      return base;
    }

    return base;
  }

  // ---------------------------------------------------------------- close

  /**
   * Close what the plan said to close, and report how many actually went.
   *
   * The close set travels as IDENTITIES, not as vscode.Tab objects: a Tab is
   * an api wrapper the extension host can drop as soon as a group opens or
   * closes, `tabGroups.close()` throws on a stale one, and the throw takes the
   * whole batch with it — one dead wrapper and nothing at all closes. So the
   * identities are re-resolved against the live model here, at the moment of
   * closing.
   *
   * The batch is also all-or-nothing per group in the workbench: a single
   * dirty tab vetoes its group's close and every sibling in that group
   * survives with it. Hence the per-tab fallback — one bad apple must cost one
   * tab, not the sweep.
   */
  private async closeTabs(toClose: readonly TabFacts[]): Promise<number> {
    if (toClose.length === 0) return 0;
    const groupsApi = this.tabGroups();
    if (!groupsApi || typeof groupsApi.close !== 'function') {
      log('workspaces: tabGroups.close unavailable — foreign tabs stay open');
      return 0;
    }
    const wanted = new Set(toClose.map((fact) => tabIdentity(fact)));
    /** Everything still open that this switch decided to close. */
    const survivors = (): Array<{ tab: vscode.Tab; fact: TabFacts }> =>
      this.liveTabs().filter((entry) => wanted.has(tabIdentity(entry.fact)));

    const before = survivors();
    const closable = before.filter(({ tab, fact }) => {
      // A terminal tab is never ours to close — closing a live one is what
      // pops the workbench's "terminate running processes?" dialog. planSwitch
      // already keeps these; this is the belt to its braces.
      if (fact.terminal === true) return false;
      // Dirty RIGHT NOW, not dirty when the plan was made: a background save
      // or an edit lands between the two, and a dirty tab silently vetoes its
      // whole group's close batch.
      return tab.isDirty !== true;
    });
    if (closable.length === 0) return 0;

    // preserveFocus: closing foreign tabs must not move the user's focus —
    // an auto switch is triggered BY where their focus just went, and a
    // focus jump into a kept-open busy session of a third project would
    // ping-pong the switcher.
    let ok = false;
    try {
      ok = (await groupsApi.close(closable.map((e) => e.tab), true)) !== false;
    } catch (err) {
      logError('workspaces.closeTabs', err);
    }
    if (!ok) {
      for (const { tab } of closable) {
        try {
          await groupsApi.close(tab, true);
        } catch (err) {
          // A tab that vanished mid-switch is fine; nothing to unwind.
          logError('workspaces.closeTab', err);
        }
      }
    }

    const after = survivors();
    const closed = before.length - after.length;
    if (after.length > 0) {
      log(
        `workspaces: closed ${closed} of ${before.length} foreign tab(s) — ` +
          `still open: ${after.map((e) => e.fact.label).join(', ')}`,
      );
    } else if (closed > 0) {
      log(`workspaces: closed ${closed} foreign tab(s)`);
    }
    return closed;
  }

  // ----------------------------------------------------------------- park

  /** The labels of the terminal tabs still in the editor area. Read once, at
   *  the end of a switch, so the log names the terminals the user is actually
   *  still looking at rather than the ones the plan saw before the parks
   *  closed half of them. */
  private terminalTabLabels(): string[] {
    return this.liveTabs()
      .filter((entry) => entry.fact.terminal === true)
      .map((entry) => entry.fact.label);
  }

  /**
   * Put away every session in `ids`: dispose its terminal and write the
   * record its LEVEL, in one synchronous sweep. There is nothing to confirm
   * and nothing to race — `dispose` is not a workbench command resolved
   * against some "active" instance, it acts on exactly the Terminal it is
   * called on — which is why this replaced the old move-to-panel stow: that
   * one was serial, slow (reveal + confirm + move per terminal) and lost
   * races that stranded sessions in the panel.
   *
   * Two tiers, decided per session by whether its terminal is tmux-backed —
   * and NEITHER is the retired `parked` flag (running, invisible, unbounded):
   *
   *   DETACH under GRACE — only the tmux client died; the claude process
   *   keeps running until `graceUntil`, so a switch-back re-attaches
   *   instantly. The record gets the deadline plus the tmux name, which is
   *   also what makes the state VISIBLE: the tree draws a countdown row from
   *   it, and the lifecycle sweep (extension.ts, src/idleClose.ts) ends the
   *   process at the deadline — killed to level 2 if idle, close-after-turn
   *   if mid-turn. Grace `0` writes an already-expired deadline instead of
   *   killing here: the sweep owns every kill (it reaps the process TREE),
   *   and one extra minute of countdown is cheaper than a second kill path.
   *   Does NOT enter `recentlyKilled` — the roster's "live" row for a
   *   detached session is the truth, not a stale echo.
   *
   *   CLOSE to level 2 — a bare launch's process died with its terminal. The
   *   record gets `closed`: an ordinary archived row, resumable from the
   *   tree, and the switch-back `--resume`s it when the target's layout
   *   names it. `tmux: null` rides along so no stale name from an earlier
   *   detach can outlive a close that really killed. Every close runs the
   *   at-rest resumeLeaf repair — a 1→2 transition mints an archived row,
   *   and an archived row must be provably resumable the moment it exists.
   *
   *   A CHAT always takes a third tier — KILL, wrapped or not: dispose plus
   *   the tree-reaping process kill (`endSessionTab`). A chat has no tree
   *   row, so a graced chat would be a running process with NO surface
   *   anywhere — the exact unrepresentable state the levels exist to remove.
   *   Killed matches the chat's own philosophy (chatAutoClose.ts): the close
   *   is a plain terminal close, never a park; the conversation survives in
   *   Chat History, which is how a chat is asked for.
   *
   * The record is written only when the dispose succeeded, so it can never
   * claim "put away" while the tab is still on screen.
   */
  private parkSweep(
    ids: readonly string[],
    writes: Array<Promise<void>>,
    /** Whether to stamp `stowedBySwitch` on what this puts away. Defaults to
     *  true — the switch's own callers want it; see parkOthers for the folder-
     *  mode caller that must not. */
    stow = true,
  ): { detached: number; killed: number; chats: number; failed: string[] } {
    const out = { detached: 0, killed: 0, chats: 0, failed: [] as string[] };
    // Two bindings can share one chain tip (a re-key leaves the terminal
    // bound under its launch-time id while the row wears the new one), and the
    // tip is what gets the record and what the restore path acts on. Sweep a
    // tip once.
    const sweptTips = new Set<string>();
    const graceMs = this.safeGraceMinutes() * 60_000;
    for (const sessionId of ids) {
      const tip = this.safeTip(sessionId);
      if (sweptTips.has(tip)) continue;
      // Read the tmux name BEFORE the dispose: the close drops the binding
      // that carries it.
      const tmuxName = this.safeTmuxName(sessionId) ?? this.safeTmuxName(tip);
      if (this.isChat(sessionId)) {
        // The chat tier — see the contract above. The kill goes through the
        // reaping funnel; `graceUntil: null` rides the write so no stale
        // deadline from an older build can resurrect the grace this tier
        // exists to forbid.
        if (!this.safeEndSession(sessionId)) {
          log('workspaces: sweep closed nothing for', shortId(sessionId));
          out.failed.push(sessionId);
          continue;
        }
        sweptTips.add(tip);
        const killedAt = Date.now();
        this.recentlyKilled.set(tip, killedAt);
        this.recentlyKilled.set(sessionId, killedAt);
        writes.push(
          this.safeWrite(tip, {
            closed: new Date(killedAt).toISOString(),
            graceUntil: null,
            tmux: null,
          }),
        );
        this.deps.repairResumeLeaf?.(tip);
        out.chats++;
        continue;
      }
      if (!this.safeCloseSession(sessionId)) {
        log('workspaces: sweep closed nothing for', shortId(sessionId));
        out.failed.push(sessionId);
        continue;
      }
      sweptTips.add(tip);
      const now = Date.now();
      if (tmuxName !== undefined) {
        // DETACH: only the tmux client died. The ROW — the chain tip — gets
        // the deadline and the name the restore must attach under.
        // `stowedBySwitch` rides along even though the grace itself already
        // vouches for the restore: if the grace EXPIRES before the switch
        // back (the sweep kills to level 2), the marker is what still says
        // "the switch did this, bring it home" — where a user-closed session
        // has no marker and stays closed.
        writes.push(
          this.safeWrite(tip, {
            graceUntil: new Date(now + graceMs).toISOString(),
            tmux: tmuxName,
            stowedBySwitch: stow,
          }),
        );
        out.detached++;
        continue;
      }
      // Both ids: the roster may know the session under either, and the
      // restore path checks both before trusting a stale "live" row.
      this.recentlyKilled.set(tip, now);
      this.recentlyKilled.set(sessionId, now);
      // Close the ROW — the chain tip — not necessarily the launch-time id the
      // terminal was bound under: the tip is what the tree shows and what the
      // restore path acts on.
      writes.push(
        this.safeWrite(tip, {
          closed: new Date(now).toISOString(),
          tmux: null,
          // The marker that distinguishes THIS close from every user close:
          // the switch put the session away, so the switch back may bring it
          // home. restoreSession's level-2 tier resumes ONLY records carrying
          // it; every user verb clears it. False when there is no switch to
          // come back — see parkOthers's `stow`.
          stowedBySwitch: stow,
        }),
      );
      // REPAIR AT REST: this write minted an archived row, and every 1→2
      // transition runs the resumeLeaf repair so the row is provably
      // resumable now, not only when clicked (the on-click repair remains
      // the second net for a transcript the dying process wrote seconds ago).
      this.deps.repairResumeLeaf?.(tip);
      out.killed++;
    }
    return out;
  }

  /**
   * The verify pass. Every CLOSE this switch decided is checked against the
   * LIVE tab model one more time, after the layout has settled: a close batch
   * the host refused, a tab that was dirty when the plan was made. It only
   * ever re-attempts what THIS switch already decided and never re-plans —
   * and it cannot reach anything the restore opened, because the close set
   * was stripped of every identity the target's layout could reopen before
   * the first close (see `layoutIdentities`). Parks need no retry pass: a
   * dispose either happened or threw, and a throw is reported, not retried.
   */
  private async verifyClose(
    closeSet: readonly TabFacts[],
    parkFailed: readonly string[],
  ): Promise<{ closed: number; unresolved: string[] }> {
    const closed = await this.closeTabs(closeSet);
    const unresolved: string[] = parkFailed.map((id) => shortId(id));
    // Name the survivors. Being told which tab would not go is the difference
    // between a bug report and a shrug.
    const stillOpen = this.liveTabs()
      .filter((entry) =>
        closeSet.some((fact) => tabIdentity(fact) === tabIdentity(entry.fact)),
      )
      .map((entry) => entry.fact.label);
    for (const label of stillOpen) unresolved.push(label);
    if (unresolved.length > 0) {
      log(
        `workspaces: could not clear ${unresolved.length} tab(s): ` +
          unresolved.join(', '),
      );
    }
    return { closed, unresolved };
  }

  // -------------------------------------------------------------- restore

  private async restore(
    project: ProjectRecord,
    writes: Array<Promise<void>>,
  ): Promise<RestoreResult> {
    const dirs = projectDirs(project);
    const saved = this.savedTabs(project.id);

    const openNow = new Set<string>();
    for (const group of this.tabGroups()?.all ?? []) {
      for (const tab of group.tabs ?? []) {
        const uri = fileUriOf(tab.input as unknown);
        if (uri) openNow.add(uri.toString());
      }
    }

    const plan = restorePlan(saved, (uri) => openNow.has(uri));

    let files = 0;
    for (const tab of plan.files) {
      if (await this.openFileTab(tab)) files++;
    }

    // A snapshot written by an older build can name sessions that were never
    // this project's, and a stale grace claim can cover a foreign one.
    // Restoring a project must only ever bring back ITS OWN sessions —
    // everything else keeps its record and waits for its own project's switch.
    let own = plan.sessions.filter(
      (tab) =>
        tab.sessionId !== undefined &&
        insideProject(dirs, this.deps.sessionCwd(tab.sessionId)),
    );
    // SOLO MODE (`lineage.soloSession`): the switch brings back ONE session —
    // the one the layout says was in front, or failing that the first — and
    // the rest stay put away, one row-click away. Restoring the whole set
    // would open the very wall of tabs the mode exists to prevent, and then
    // sweep all but one of them away again on the first focus.
    const solo = this.safeSolo();
    if (solo && own.length > 1) {
      const front =
        own.find((tab) => tab.sessionId === plan.activeSessionId) ?? own[0];
      log(
        `workspaces: solo — restoring 1 of ${String(own.length)} saved ` +
          'session(s); the rest stay put away (reopen them from the tree)',
      );
      own = front === undefined ? [] : [front];
    }
    if (own.length > MAX_AUTO_RESUME) {
      log(
        `workspaces: layout names ${own.length} sessions — resuming the ` +
          `first ${MAX_AUTO_RESUME}, the rest stay put away (reopen them ` +
          'from the tree)',
      );
    }
    // IN PARALLEL, and this matters: each resume awaits its terminal's pid
    // before reporting, and a serial loop paid that wait once per session.
    // The tabs all appear at once; claude loads inside each in its own time.
    const outcomes = await Promise.all(
      own.map((tab, i) =>
        this.restoreSession(
          tab.sessionId as string,
          tab.viewColumn,
          i < MAX_AUTO_RESUME,
          writes,
        ),
      ),
    );
    const sessions = outcomes.filter((o) => o !== false).length;

    // The project's CHATS deliberately do NOT come back. A switch KILLS a
    // chat on the way out (parkSweep's chat tier — never a grace, because a
    // chat has no tree row to render a countdown on), so by the time this
    // restore runs the chat is an ordinary level-2 conversation, and a
    // level-2 chat is asked for through Chat History, never revived unasked.
    // The comeback loop that used to live here was grace-gated; with the
    // grace gone its condition is unsatisfiable by construction, and a chat
    // record still carrying `graceUntil` from an older build is the lifecycle
    // sweep's to end, not this restore's to resurrect.

    const out: RestoreResult = { files, sessions };
    if (plan.activeUri !== undefined) {
      out.activeUri = plan.activeUri;
      out.activeColumn = plan.activeColumn;
    }
    if (plan.activeSessionId !== undefined) {
      out.activeSessionId = plan.activeSessionId;
    }
    return out;
  }

  /** Open one saved file tab. Never focuses: focus is decided once, at the end
   *  of the switch, because every later move would overwrite it anyway. */
  private async openFileTab(tab: WorkspaceTabRecord): Promise<boolean> {
    const cmds: Partial<typeof vscode.commands> = vscode.commands;
    if (typeof cmds.executeCommand !== 'function') return false;
    try {
      const uri = vscode.Uri.parse(tab.uri ?? '', true);
      // `vscode.open` routes to the right editor for the resource (text,
      // notebook, image, custom) — showTextDocument would choke on non-text.
      await cmds.executeCommand('vscode.open', uri, {
        viewColumn: tab.viewColumn,
        preview: false,
        preserveFocus: true,
      });
      return true;
    } catch (err) {
      // The file may be gone since the snapshot; a layout restore is
      // best-effort by nature.
      logError('workspaces.openFileTab', err);
      return false;
    }
  }

  /**
   * Bring one put-away session of the target project home. Only a session the
   * SWITCH can vouch for is touched: one still under a GRACE deadline (its
   * process detached, likely running — only navigation ever writes a grace)
   * or one ARCHIVED with the `stowedBySwitch` marker (the switch's own kill
   * tier, or a grace the sweep since expired). The layout naming a session is
   * NOT enough for the archived tier: the layout is a snapshot, and a user
   * Close / Close Now / Delete performed AFTER it was saved is exactly the
   * case the marker exists for — every user verb clears it, so "user closed
   * stays closed" holds on the record itself, whatever the layout remembers.
   * (Chats are in no layout — a switch KILLS them, and Chat History brings
   * them back.)
   *
   * Three ways home, decided by the record:
   *
   *   * ATTACH (grace) — the record carries a tmux name under `graceUntil`:
   *     the process is (very likely) still running, counting down, and the
   *     ordinary launch verb re-attaches to it, because a wrapped launch is
   *     `new-session -A` under that recorded name. If it died while hidden,
   *     the SAME argv falls through to its `--resume` instead — one command,
   *     both outcomes. The roster's "live" is true for these, so it must not
   *     gate the restore, and the resume cap does not apply: an attach spawns
   *     a tmux client, not a claude process.
   *   * RESUME (level 2) — no tmux name: the session is dead by construction
   *     and `--resume` (chain-tip routed) brings the conversation back as a
   *     fresh editor tab.
   *   * UNSTOW — legacy migration: an older build parked sessions by moving
   *     their terminal into the terminal panel, where a still-live one may
   *     sit — that one is moved home rather than duplicated.
   */
  private async restoreSession(
    sessionId: string,
    viewColumn: number,
    canLaunch: boolean,
    writes: Array<Promise<void>>,
  ): Promise<'unstowed' | 'resumed' | 'attached' | false> {
    try {
      const tip = this.safeTip(sessionId);
      const record = this.deps.getRecord(tip) ?? this.deps.getRecord(sessionId);
      // Rests on an invariant this switch maintains by construction: put-away
      // and restore act on disjoint session sets — a session leaves the
      // screen because it is foreign to the target, and comes home because it
      // belongs to it. So a grace deadline read here can never be one this
      // switch just wrote. A record on neither level-2 nor grace is live
      // (hosted here or elsewhere) and has nothing to restore.
      //
      // The archived tier additionally demands the switch's own marker: a
      // bare `closed` could just as well be the user's Close (from the tree,
      // while this project was away) or the idle timer's — see the contract
      // above. Grace needs no marker: only navigation detaches (a user verb
      // on a grace row kills AND stamps closed), so a live deadline is the
      // switch's own claim, and re-attaching costs no new process anyway.
      const graced = record?.graceUntil != null;
      const archived =
        record?.closed != null && record?.stowedBySwitch === true;
      if (record === undefined || (!graced && !archived)) return false;

      // Written by parkSweep next to the deadline it rides with. Its presence
      // IS the tier decision. Only trusted under grace: a stale name on an
      // archived record is a pointer at a session the sweep already killed.
      const tmuxName =
        graced && typeof record.tmux === 'string' && record.tmux !== ''
          ? record.tmux
          : undefined;

      // `closeAfterTurn` clears with the claim it rode in on: the mark is
      // minted when a grace deadline lands on a busy session, and a mark that
      // survived the re-attach would close the very tab this restore just
      // brought home on its first idle tick — navigation mutating lifecycle.
      // `stowedBySwitch` clears with them: the restore consumed the claim it
      // carried, and a marker that outlived its restore would let a LATER
      // user close be resurrected by the switch after next.
      const clearStow = (): void => {
        writes.push(
          this.safeWrite(tip, {
            graceUntil: null,
            tmux: null,
            closeAfterTurn: false,
            stowedBySwitch: false,
          }),
        );
        if (tip !== sessionId) {
          writes.push(
            this.safeWrite(sessionId, {
              graceUntil: null,
              tmux: null,
              closeAfterTurn: false,
              stowedBySwitch: false,
            }),
          );
        }
      };

      if (tmuxName === undefined) {
        // "Live" on the roster is trusted EXCEPT for sessions this window just
        // killed: `claude agents --json` keeps listing a disposed process for a
        // tick or two, and believing it would strand a rapid switch-back —
        // "running in another window", restore nothing, session parked forever.
        const live =
          !(this.wasKilledHere(tip) || this.wasKilledHere(sessionId)) &&
          (this.deps.isLive(tip) || this.deps.isLive(sessionId));
        if (live) {
          // Genuinely still running — in this window's terminal PANEL (parked
          // there by an older build of this extension) or in another window.
          // Never launch a second process. The unstow only succeeds for a
          // terminal bound HERE; anything else keeps its flag and stays where
          // it is.
          const back = await this.queuedUnstow(tip);
          if (!back) return false;
          clearStow();
          return 'unstowed';
        }

        if (!this.deps.resumeSessions() || !canLaunch) return false;
      }

      // A terminal in THIS window already hosts it, so there is nothing to
      // bring home — and both tiers below would put a SECOND one on the same
      // conversation: the attach tier a second tmux client, the resume tier a
      // second claude appending to one transcript. The binding is replaced
      // either way, which strands the first tab with no owner.
      //
      // The ordinary way into this state is the click that caused the switch:
      // `focusSession` on a session of another project resumes it, and
      // `resumeFlow` clears the grace claim only once the launch resolves, so
      // the read above can still say "put away" about a tab that is already
      // on screen. Also covers a sweep whose dispose failed. The claim is
      // cleared either way — the record must stop saying a visible tab is
      // hidden.
      //
      // Below the legacy unstow deliberately: that tier NEEDS its terminal
      // bound, because it moves the tab home instead of making one.
      if (this.boundHere(tip) || this.boundHere(sessionId)) {
        log(
          `workspaces: ${shortId(sessionId)} already has a terminal here — ` +
            'nothing to restore',
        );
        clearStow();
        return false;
      }

      // A session that never took a turn wrote no transcript, so there is
      // nothing to `--resume` — and refusing here was how a workspace switch
      // lost every session created and not yet written in: parked on the way
      // out, silently skipped on the way back, still flagged `parked` and now
      // unreachable from the switch that put it there. It comes home the only
      // way it can, by starting under its own id (free: no transcript claims
      // it), which is the same answer `resumeFlow` gives the click.
      //
      // NOT a never-started FORK, which is why the recorded edge is consulted:
      // that branch is displaying its ancestor's history, and only a replay
      // (`--fork-session --resume <ancestor>`) brings it back as what it was.
      // Getting that wrong would not merely skip the row, it would spend the
      // id on a blank conversation and lose the branch for good — so an
      // unstarted fork stays skipped here and reopens from its own click,
      // where `resumeFlow` has the ancestor walk to do it properly.
      const started = this.deps.hasTranscript(tip);
      if (!started) {
        const recordedParent = record.parentId;
        if (typeof recordedParent === 'string' && recordedParent !== '') return false;
      }
      if (started) this.deps.repairResumeLeaf?.(tip);
      const account = this.accountLaunch(tip);
      const binding = await this.deps.launchSession({
        sessionId: tip,
        ...(started ? { resumeId: tip } : {}),
        ...account,
        cwd: this.deps.sessionCwd(tip) ?? record?.cwd,
        ...(record?.title !== undefined ? { title: record.title } : {}),
        viewColumn,
        // The switch is a side effect of where the user already is — a
        // resumed session must come back without taking the keyboard.
        preserveFocus: true,
        // The attach path: makes the wrapped launch's `new-session -A` find
        // the running detached session instead of minting a fresh name.
        ...(tmuxName !== undefined ? { tmuxName } : {}),
      });
      if (!binding) return false;
      clearStow();
      writes.push(this.safeWrite(tip, { closed: null }));
      return tmuxName !== undefined ? 'attached' : 'resumed';
    } catch (err) {
      logError('workspaces.restoreSession', err);
      return false;
    }
  }

  // ------------------------------------------------------------- utilities

  /** The pinned account's launch fields, or `{}`. Never throws and never
   *  guesses: a wiring without the dep, a session with no pin, and a pin whose
   *  account was deleted all resolve to no environment, which lands the resume
   *  on the machine's default login — the same place its transcript would be
   *  if the conversation had never had an account. */
  private accountLaunch(sessionId: string): {
    env?: Readonly<Record<string, string>>;
    profileId?: string;
  } {
    const fn = this.deps.accountLaunchFor;
    if (!fn) return {};
    try {
      const found = fn.call(this.deps, sessionId);
      if (!found) return {};
      return {
        ...(found.env !== undefined ? { env: found.env } : {}),
        ...(found.profileId !== undefined ? { profileId: found.profileId } : {}),
      };
    } catch (err) {
      logError('workspaces.accountLaunch', err);
      return {};
    }
  }

  private tabGroups(): Partial<typeof vscode.window.tabGroups> | undefined {
    const w: Partial<typeof vscode.window> = vscode.window;
    const groups = w.tabGroups;
    return groups && Array.isArray(groups.all) ? groups : undefined;
  }

  /** Is this session a project chat? Asked of BOTH the launch-time id and the
   *  chain tip: a terminal is bound under the id it launched with, while a
   *  `--resume` mints a new generation and the record follows the tip. Being a
   *  chat names the conversation, so either id carrying the flag settles it.
   *
   *  When neither does, the STORE is walked for any record whose chain
   *  resolves to the same tip: the `chat` flag is written once, at birth, so
   *  a chat reopened twice runs bound under a generation id nothing ever
   *  flagged — and only its birth record still says what the conversation
   *  is. */
  private isChat(sessionId: string): boolean {
    try {
      if (this.deps.getRecord(sessionId)?.chat === true) return true;
      const tip = this.safeTip(sessionId);
      if (tip !== sessionId && this.deps.getRecord(tip)?.chat === true) {
        return true;
      }
      return Object.values(this.deps.allRecords()).some(
        (r) => r.chat === true && this.safeTip(r.id) === tip,
      );
    } catch (err) {
      logError('workspaces.isChat', err);
      return false;
    }
  }

  /** The target's saved layout, or nothing. Read twice per switch — once to
   *  spare its tabs from the close set, once to replay it — and never allowed
   *  to take a switch down with it. */
  private savedTabs(projectId: string): WorkspaceTabRecord[] {
    try {
      return this.deps.getWorkspace(projectId)?.tabs ?? [];
    } catch (err) {
      logError('workspaces.getWorkspace', err);
      return [];
    }
  }

  private safeBindings(): TerminalBinding[] {
    try {
      return this.deps.bindings();
    } catch (err) {
      logError('workspaces.bindings', err);
      return [];
    }
  }

  /** Does a terminal in THIS window already host this session? Parking
   *  disposes the terminal, so for a parked record the answer is normally no —
   *  a yes means something brought the tab back while the switch was in
   *  flight. */
  private boundHere(sessionId: string): boolean {
    return this.safeBindings().some((b) => b.sessionId === sessionId);
  }

  private safeCloseSession(sessionId: string): boolean {
    try {
      return this.deps.closeSessionTab(sessionId);
    } catch (err) {
      logError('workspaces.park', err);
      return false;
    }
  }

  /** The chat tier's kill: dispose AND end the process through the reaping
   *  funnel. Falls back to the plain dispose when the wiring predates the
   *  dep — degraded (a wrapped chat's process is then the reconcile's to
   *  end), never a refusal, because the tab must still leave with its
   *  project either way. */
  private safeEndSession(sessionId: string): boolean {
    try {
      const end = this.deps.endSessionTab;
      if (typeof end === 'function') return end.call(this.deps, sessionId);
      return this.deps.closeSessionTab(sessionId);
    } catch (err) {
      logError('workspaces.endSession', err);
      return false;
    }
  }

  private safeIsBusy(sessionId: string): boolean {
    try {
      return this.deps.isSessionBusy(sessionId);
    } catch (err) {
      logError('workspaces.isSessionBusy', err);
      // When in doubt, do not kill: an unreadable status is treated as busy,
      // which costs a lingering tab rather than an aborted turn.
      return true;
    }
  }

  /** Detach tier: the tmux name backing a session's terminal, or undefined.
   *  An absent dep or a throw means the kill tier — always correct, merely
   *  lossier — for the same reason safeIsBusy errs toward "busy": a wrong
   *  "detachable" would kill a session while recording it as still running. */
  private safeTmuxName(sessionId: string): string | undefined {
    try {
      return this.deps.tmuxNameOf?.(sessionId);
    } catch (err) {
      logError('workspaces.tmuxNameOf', err);
      return undefined;
    }
  }

  private safeResumeSessions(): boolean {
    try {
      return this.deps.resumeSessions();
    } catch (err) {
      logError('workspaces.resumeSessions', err);
      return false;
    }
  }

  /** `lineage.session.detachGraceMinutes`. Absent dep or a throw is the
   *  shipped default (10) — the grace is what keeps a switch-back instant,
   *  and a wiring gap must not silently downgrade every detach to a kill. */
  private safeGraceMinutes(): number {
    try {
      const v = this.deps.detachGraceMinutes?.();
      return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 10;
    } catch (err) {
      logError('workspaces.detachGraceMinutes', err);
      return 10;
    }
  }

  /** `lineage.soloSession`. Absent dep or a throw is OFF — the mode parks
   *  tabs, and a mode that parks tabs must never be inferred. */
  private safeSolo(): boolean {
    try {
      return this.deps.soloSession?.() === true;
    } catch (err) {
      logError('workspaces.soloSession', err);
      return false;
    }
  }

  /** Move the Explorer, swallowing everything. The dep is absent in a
   *  window that never opted in and in every unit double, and a splice that
   *  throws is a file tree that did not move — neither is a reason for the
   *  switch that owns the user's tabs to stop half-done. */
  private async syncExplorer(project: ProjectRecord | null): Promise<void> {
    const fn = this.deps.syncExplorer;
    if (!fn) return;
    try {
      await fn.call(this.deps, project);
    } catch (err) {
      logError('workspaces.syncExplorer', err);
    }
  }

  /** The deep switch's arrival reveal, on syncExplorer's terms exactly: absent
   *  dep and thrown error both degrade to "no reveal, no note" — the reveal is
   *  a courtesy on top of the transaction, never a step of it. */
  private async revealSwitchTarget(
    project: ProjectRecord,
    auto: boolean,
    trigger: string | null,
  ): Promise<string> {
    const fn = this.deps.revealSwitchTarget;
    if (!fn) return '';
    try {
      const note = await fn.call(this.deps, project, { auto, trigger });
      return typeof note === 'string' ? note : '';
    } catch (err) {
      logError('workspaces.revealSwitchTarget', err);
      return '';
    }
  }

  /** One legacy unstow at a time — see `unstowQueue`. */
  private queuedUnstow(tip: string): Promise<boolean> {
    const run = this.unstowQueue.then(() => this.deps.unstowSessionTab(tip));
    this.unstowQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Did THIS window park (kill) the session within the grace window? Expired
   *  entries are dropped on read, so the map never grows past a busy day. */
  private wasKilledHere(id: string): boolean {
    const at = this.recentlyKilled.get(id);
    if (at === undefined) return false;
    if (Date.now() - at > KILL_GRACE_MS) {
      this.recentlyKilled.delete(id);
      return false;
    }
    return true;
  }

  /** A deferred record write. Never awaited where it is made: a switch queues
   *  every one of them and flushes the lot at the end, so the store emits one
   *  change and the sidebar rebuilds once. Never rejects, for the same reason
   *  a failed park must not abort the rest of a sweep. */
  private safeWrite(
    sessionId: string,
    patch: Partial<EditorialRecord>,
  ): Promise<void> {
    try {
      return this.deps.upsertRecord(sessionId, patch).catch((err: unknown) => {
        logError('workspaces.record', err);
      });
    } catch (err) {
      logError('workspaces.record', err);
      return Promise.resolve();
    }
  }

  /**
   * Where the keyboard ends up, decided once and applied last.
   *
   * Nothing above steals focus on purpose — closes preserve it, parks dispose
   * background tabs, restores launch with `preserveFocus` — but "preserve
   * focus" is not "stay behind": revealing a terminal makes its tab the visible
   * one in its group whatever that argument says (see the note on
   * `runOnFocusedTerminal` in terminals.ts), and the workbench promotes some
   * neighbour when the ACTIVE tab is among the closed. So a switch that brings
   * back three sessions ends on whichever finished last, which is a race, not a
   * decision. This settles it, in order:
   *
   *   * The session that TRIGGERED an auto switch. The user clicked its row (or
   *     typed into its terminal) and the switch is a side effect of that, so
   *     ending anywhere else is the switch overruling the very act that caused
   *     it — the bug where clicking a session in another project took you to a
   *     sibling tab and only a second click landed.
   *   * The layout's active FILE. A manual switch is a request to LOOK at the
   *     project, and this is the tab it was left on.
   *   * The layout's active SESSION, when a session tab had the keyboard when
   *     the layout was saved.
   *   * The session that had the keyboard on the way in, when it belongs to the
   *     target too and survived — two projects sharing a directory, say.
   *
   * A session this switch PARKED is never focused: its terminal is disposed, so
   * the reveal would land on whatever the workbench promoted in its place.
   */
  private async settleFocus(opts: {
    auto: boolean;
    trigger: string | null;
    wasActive: string | null;
    restored: RestoreResult;
    parked: readonly string[];
  }): Promise<void> {
    const goneIds = new Set<string>();
    for (const id of opts.parked) {
      goneIds.add(id);
      goneIds.add(this.safeTip(id));
    }
    const survivor = (id: string | undefined | null): string | null =>
      typeof id === 'string' &&
      id !== '' &&
      !goneIds.has(id) &&
      !goneIds.has(this.safeTip(id))
        ? id
        : null;

    if (opts.auto) {
      // An auto switch never opens a file to interrupt with, so this is its
      // whole decision — and skipping it is what left the trigger session
      // behind a restored sibling.
      const trigger = survivor(opts.trigger);
      if (trigger !== null) this.safeFocusSession(trigger);
      return;
    }
    if (opts.restored.activeUri !== undefined) {
      await this.focusFile(opts.restored.activeUri, opts.restored.activeColumn);
      return;
    }
    const layoutSession = survivor(opts.restored.activeSessionId);
    if (layoutSession !== null) {
      this.safeFocusSession(layoutSession);
      return;
    }
    const kept = survivor(opts.wasActive);
    if (kept !== null) this.safeFocusSession(kept);
  }

  private safeFocusSession(sessionId: string): void {
    try {
      this.deps.focusSession(sessionId);
    } catch (err) {
      logError('workspaces.focusSession', err);
    }
  }

  /** Put the keyboard on the layout's active file. Part of the ONE focus
   *  decision above, and it runs last: `moveToEditor` is declared with
   *  `runAfter: i => i.at(-1)?.focus()`, so a session coming home focuses
   *  itself and would silently win over anything decided earlier. */
  private async focusFile(
    uri: string,
    viewColumn: number | undefined,
  ): Promise<void> {
    const cmds: Partial<typeof vscode.commands> = vscode.commands;
    if (typeof cmds.executeCommand !== 'function') return;
    try {
      await cmds.executeCommand('vscode.open', vscode.Uri.parse(uri, true), {
        viewColumn: viewColumn ?? 1,
        preview: false,
        preserveFocus: false,
      });
    } catch (err) {
      logError('workspaces.focusFile', err);
    }
  }

  private terminalLocationPref(): TerminalLocationPref {
    try {
      return this.deps.terminalLocation?.() ?? 'editor';
    } catch (err) {
      logError('workspaces.terminalLocation', err);
      return 'editor';
    }
  }

  /**
   * Run `body` under the window's own progress spinner, when the host has one.
   * Feature-detected rather than referenced directly: `vscode.ProgressLocation`
   * is an enum the unit-test mock does not ship, and a switch must never
   * depend on chrome being available.
   */
  private async withIndicator<T>(
    title: string | null,
    body: () => Promise<T>,
  ): Promise<T> {
    if (title === null) return body();
    const w: Partial<typeof vscode.window> = vscode.window;
    const location = (vscode as Partial<typeof vscode>).ProgressLocation?.Window;
    if (typeof w.withProgress !== 'function' || location === undefined) {
      return body();
    }
    let ran = false;
    const run = (): Promise<T> => {
      ran = true;
      return body();
    };
    try {
      return await Promise.resolve(w.withProgress({ location, title }, run));
    } catch (err) {
      // The switch itself failing must surface; only a host that cannot show
      // the spinner at all falls back to running without one.
      if (ran) throw err;
      logError('workspaces.withProgress', err);
      return run();
    }
  }

  private safeTip(sessionId: string): string {
    try {
      return this.deps.tipOf(sessionId);
    } catch (err) {
      logError('workspaces.tipOf', err);
      return sessionId;
    }
  }

  private safeActiveSession(): string | null {
    try {
      return this.deps.activeSessionId();
    } catch (err) {
      logError('workspaces.activeSessionId', err);
      return null;
    }
  }

  private message(text: string): void {
    try {
      const w: Partial<typeof vscode.window> = vscode.window;
      if (typeof w.setStatusBarMessage === 'function') {
        w.setStatusBarMessage(text, 6000);
      } else if (typeof w.showInformationMessage === 'function') {
        void w.showInformationMessage(text);
      } else {
        log('workspaces:', text);
      }
    } catch (err) {
      logError('workspaces.message', err);
    }
  }

  /** A real toast, for the one message per switch that must not be missed. */
  private toast(text: string): void {
    try {
      const w: Partial<typeof vscode.window> = vscode.window;
      if (typeof w.showInformationMessage === 'function') {
        void w.showInformationMessage(text);
      } else {
        this.message(text);
      }
    } catch (err) {
      logError('workspaces.toast', err);
    }
  }

}

// --------------------------------------------------------------- tab shapes
// `tab.input` is a union of TabInput* classes; instanceof is unreliable under
// a mock (and across extension-host reloads), so these go by shape.

function fileUriOf(input: unknown): vscode.Uri | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as { uri?: unknown; modified?: unknown };
  const candidate = record.uri ?? record.modified; // diff tabs: keep the RHS
  if (!candidate || typeof candidate !== 'object') return undefined;
  const uri = candidate as vscode.Uri;
  return typeof uri.scheme === 'string' && typeof uri.toString === 'function'
    ? uri
    : undefined;
}

function isTerminalInput(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  // instanceof against the API class is the ONLY reliable test: production
  // VS Code minifies its classes, so `constructor.name` is a mangled letter
  // there — the old name check classified every terminal tab as a closable
  // plain tab, and closing those is what popped the "terminate running
  // processes?" dialogs. TabInputTerminal has no data members to duck-type.
  const cls = (vscode as Partial<typeof vscode>).TabInputTerminal;
  if (typeof cls === 'function' && input instanceof cls) return true;
  // Fallbacks for hosts and mocks that do not export the class.
  const name = (input as { constructor?: { name?: string } }).constructor?.name;
  return name === 'TabInputTerminal' || 'terminal' in (input as object);
}
