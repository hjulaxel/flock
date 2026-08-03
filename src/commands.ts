// IMPLEMENTED BY: E  (M3 — the verbs)
//
// Tree row menus -> extension commands -> DIRECT function calls on CommandDeps.
// No HTTP, no subprocess-the-CLI, no marker channel: every bit of that
// machinery from the Python creemux daemon is deleted by this port.
//
// Imports allowed here: vscode, ./types, ./log, node:crypto, and the PURE
// helper modules the verbs share with the views (./projects, and since M22
// ./accounts + ./routing, plus the dependency interface and command ids that
// live beside the accounts view in ./accountsView).
// Must NOT: import terminals/state/windows/hooks (everything goes through
// CommandDeps), talk to the tree directly, or run `claude` itself.
// Every handler wraps its body in try/catch -> logError + showErrorMessage.
//
// M22 — ACCOUNTS. Every launch origin in this file now answers one extra
// question before it starts a process: whose subscription. There are exactly
// two answers and they are not interchangeable:
//
//   NEW conversation      routing decides (project override -> global default
//                         -> auto), and the chosen id is PINNED to the session.
//   EXISTING conversation the pin decides, always. A fork inherits its
//                         parent's; a resume re-injects the one the
//                         conversation started on. Routing is never consulted
//                         for something that already exists — a conversation's
//                         transcript lives inside one account's config
//                         directory, so re-routing it would either lose the
//                         history or bill the wrong plan for the same thread.
//
// No launch is ever BLOCKED by any of this: with no accounts configured, a
// dangling pin, or a wiring that has no accounts at all, the resolution is an
// empty environment — which is exactly the pre-M22 behaviour.

import { randomUUID } from 'node:crypto';

import * as vscode from 'vscode';

import { log, logError } from './log';
import {
  COMMANDS,
  CONTEXT_HOOKS_INSTALLED,
  MAX_PROJECT_NAME_LEN,
  PROVIDERS,
  PROVIDER_IDS,
  WRAP_PROMPT,
  isSessionId,
  shortId,
} from './types';
import type {
  AccountProfile,
  BackgroundJob,
  CommandDeps,
  DisposableLike,
  EditorialRecord,
  ProjectRecord,
  ProviderId,
  RoutingChoice,
  SessionForest,
  SessionNode,
} from './types';
import {
  buildProjectTree,
  canReparentProject,
  chatsForProject,
  isWithin,
  matchProject,
  normalizeDir,
  pathKey,
  projectDirs,
  projectSubtree,
  providerOfProject,
  validateProjectName,
} from './projects';
import {
  canHostSession,
  envForProfile,
  isDefaultAccount,
  isEnvVarName,
  moveDown,
  moveUp,
  slugify,
  uniqueAccountId,
  validateAccountLabel,
} from './accounts';
import {
  describeRouting,
  pinnedLaunchProfile,
  resolveRouting,
} from './routing';
import { accountIdOf, usageSummaryOf } from './accountsView';
import type { AccountDeps } from './accountsView';

// --------------------------------------------------------------- constants

/** Rename cap; keeps tree labels and terminal tab titles readable. */
const MAX_TITLE_LEN = 80;
/** How much of a chat's opening message labels its row in the history picker.
 *  A quick-pick row elides at its own width anyway; this only stops a pasted
 *  wall of text from being carried around as one. */
const CHAT_LABEL_LEN = 72;
/** The opening turn a "Fork and Compact" branch is launched with. A CLI slash
 *  command, passed as the positional prompt — so the compaction is the
 *  branch's FIRST turn and the parent is never asked to compact anything. */
const COMPACT_PROMPT = '/compact';

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

// ------------------------------------------------------------------ naming
// A new session is NAMED at birth rather than asked for an opening prompt: the
// name is the thing you need to tell two forks of one parent apart in the tree,
// and it is the thing only you can supply. The prompt you can just type into the
// terminal that is about to open.

/**
 * Strip a trailing ` <n>` counter so repeated forks read `auth 2`, `auth 3`
 * rather than `auth 2 2`. Only a SPACE-separated integer counts — a label that
 * genuinely ends in a number (`refactor v2`, `issue 412`) keeps it, because
 * `v2` / `412` are part of the name rather than a fork counter.
 */
export function stripForkCounter(label: string): string {
  const m = /^(.*\S)\s+(\d+)$/.exec(label.trim());
  if (!m) return label.trim();
  // A bare number label ("412") has no stem to fall back on.
  return m[1].length > 0 ? m[1] : label.trim();
}

/**
 * `stem` if nothing has taken it, else `stem 2`, `stem 3`, … — the first name
 * free of `taken`, compared case-insensitively and capped at `maxLen`.
 *
 * Counting what is CURRENTLY taken rather than keeping a running total is what
 * makes the answer stable: closing `auth 2` frees the number again instead of
 * leaving a permanent gap, and two windows naming a session at the same moment
 * land on the same candidate rather than racing a shared counter.
 *
 * `maxLen` exists because projects and sessions have different caps
 * (MAX_PROJECT_NAME_LEN vs MAX_TITLE_LEN) and a generated name that overruns
 * the cap would be rejected by the very validator that is about to see it.
 * The case-insensitive comparison here must stay in step with
 * `validateProjectName`'s duplicate check for the same reason.
 */
export function nextFreeName(
  stem: string,
  taken: readonly string[],
  maxLen: number = MAX_TITLE_LEN,
): string {
  const base = stem.trim() || 'session';
  const used = new Set(
    (taken ?? []).map((t) => t.trim().toLowerCase()).filter((t) => t !== ''),
  );
  if (!used.has(base.toLowerCase())) return truncate(base, maxLen);
  for (let n = 2; n < 1000; n++) {
    const candidate = truncate(`${base} ${n}`, maxLen);
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return truncate(base, maxLen);
}

/** The name a new fork is offered: the parent's, plus the next free counter. */
export function defaultForkTitle(
  parentLabel: string,
  siblingLabels: readonly string[],
): string {
  const stem = stripForkCounter(parentLabel) || parentLabel.trim() || 'session';
  // The parent owns both the bare stem AND its own label — forking `auth 2` must
  // not hand the child `auth 2` as well, which is what reserving only the stem
  // would do. Seeding both guarantees a fork always gets a counter.
  return nextFreeName(stem, [...(siblingLabels ?? []), stem, parentLabel]);
}

/** The name a new root session is offered: its directory's basename, then the
 *  next free counter among the sessions already living there. Never the session
 *  id — a uuid is not a name anyone confirms with a keystroke. */
export function defaultSessionTitle(
  cwd: string | undefined,
  taken: readonly string[] = [],
): string {
  const base = cwd ? baseName(cwd).trim() : '';
  return nextFreeName(base !== '' ? base : 'session', taken);
}

/**
 * The text appended to the CLI's system prompt for a project chat. A chat has
 * no tree row and no title the user typed, so the CLI itself is the only place
 * that can be told what this window is for: which project, which directories,
 * and that it is a scratch conversation rather than a piece of work someone
 * will come back to. Pure, so the wording is testable without a CLI.
 */
export function chatSystemPrompt(
  project: ProjectRecord,
  dirs: readonly string[],
): string {
  return [
    `You are in a chat window for the project "${project.name}".`,
    `Its directories are: ${dirs.join(', ')}.`,
    'This is a short, throwaway conversation for questions and orientation — ' +
      'answer directly and keep it brief.',
  ].join('\n');
}

/** '' when the name is usable, else the reason it is not. */
function titleRefusal(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'Name cannot be empty.';
  if (trimmed.length > MAX_TITLE_LEN) {
    return `Name must be ${MAX_TITLE_LEN} characters or fewer (currently ${trimmed.length}).`;
  }
  return '';
}

/**
 * Ask for a name with `value` pre-filled AND fully selected, so Enter accepts it
 * and typing replaces it — the Explorer's rename interaction, as closely as the
 * extension API allows.
 *
 * This is the FALLBACK path only: every create verb and both rename verbs try
 * the inline editor on the row first, and that attempt reveals and focuses the
 * inline view before it asks — a collapsed sidebar is not a reason to open a
 * popup. What is left here is the case where no such view can exist at all:
 * `lineage.viewStyle` is `native`, or the host refused to bring the view up.
 * A QuickInput rather than an editable tree row because the TreeView API
 * exposes no inline label editing at all: `TreeItem` has no editable state and
 * `createTreeView` has no option for one. The Explorer's in-place rename box is
 * workbench-internal and not reachable from an extension, which is exactly why
 * the inline view is a webview and the native tree cannot offer this.
 *
 * Returns the trimmed name, or undefined on Escape.
 */
async function askForName(
  value: string,
  title: string,
  prompt: string,
): Promise<string | undefined> {
  const raw = await vscode.window.showInputBox({
    title,
    prompt,
    value,
    // The whole point: the standard name arrives selected, so Enter approves it
    // and the first keystroke overwrites it.
    valueSelection: [0, value.length],
    ignoreFocusOut: true,
    validateInput: (v) => titleRefusal(v) || undefined,
  });
  // (An omitted valueSelection happens to select the whole value today; stating
  // it is what makes the requirement legible and independent of that default.)
  if (raw === undefined) return undefined;
  const name = raw.trim();
  return titleRefusal(name) === '' ? name : undefined;
}

/**
 * Put an editable input on a row that was JUST created, falling back to the
 * quick-input rename when there is no inline view to do it in.
 *
 * Create-then-name, rather than name-then-create, is the Explorer's "New File"
 * gesture: the thing already exists under a standard name, so nothing is
 * blocked on a keystroke, Escape ends the rename instead of destroying what was
 * just made, and a crash mid-rename still leaves a correctly-named record.
 *
 * The hand-over brings the sidebar up and gives it the keyboard first (see
 * `beginInlineRename`), which is the whole reason the fallback below is rare:
 * a session is usually created from the command palette, and the sidebar is
 * usually not the thing on screen when it is. It also costs the just-launched
 * terminal its focus for as long as the edit box is open — the trade the "name
 * it on the row" requirement asks for — and the keyboard goes back to that
 * terminal when the name is committed.
 */
async function nameJustCreatedSession(
  deps: CommandDeps,
  sessionId: string,
): Promise<void> {
  if (await deps.beginInlineRename(sessionId)) return;
  await vscode.commands.executeCommand(COMMANDS.renameSession, sessionId);
}

/** The same handover for a project. Two methods rather than one because
 *  session and project ids are both bare uuids and cannot be told apart by
 *  shape — see COMMANDS.renameProjectInline. */
async function nameJustCreatedProject(
  deps: CommandDeps,
  projectId: string,
): Promise<void> {
  if (await deps.beginInlineRenameProject(projectId)) return;
  await vscode.commands.executeCommand(COMMANDS.renameProject, {
    type: 'project',
    projectId,
  });
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

/**
 * M22. Every session a multi-row verb was invoked on, in display order.
 *
 * Three shapes reach it, because the same command is on three surfaces:
 *
 *   the NATIVE TREE  passes `(clickedItem, wholeSelection[])` to a row menu
 *                    command whenever the view is `canSelectMany` — the second
 *                    argument IS the selection, straight from the workbench.
 *   the WEBVIEW      passes only the row its menu was opened on, because that
 *                    is all `data-vscode-context` can carry. The rest of the
 *                    selection comes from `deps.selectedSessions()`, which the
 *                    view reported as it changed.
 *   a KEYBINDING or
 *   the PALETTE      passes nothing at all, so the reported selection is the
 *                    only thing there is.
 *
 * The clicked row is UNIONED with the reported selection rather than replacing
 * it, and its position is respected: right-clicking a row inside a selection
 * acts on the selection (what every file manager does), while right-clicking
 * one outside it is a gesture the view has already resolved — both webtree.js
 * and the workbench collapse the selection onto that row before the menu opens,
 * so by the time this runs there is nothing to disagree with. The union is the
 * belt-and-braces case for a host that does not.
 *
 * Exported for test: this is the whole of the argument handling, and the three
 * shapes are exactly the thing worth pinning.
 */
export function selectedSessionIds(
  deps: Pick<CommandDeps, 'selectedSessions'>,
  args: readonly unknown[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (id: string | undefined): void => {
    if (id === undefined || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };

  let reported: string[] = [];
  try {
    reported = deps.selectedSessions() ?? [];
  } catch {
    reported = [];
  }

  // The native tree's second argument, when there is one.
  const fromArgs: string[] = [];
  for (const arg of args) {
    if (!Array.isArray(arg)) continue;
    for (const item of arg) {
      const id = sessionIdFromArg(item);
      if (id !== undefined) fromArgs.push(id);
    }
  }

  // Order: whichever LIST we have, so the rows come out top-to-bottom as they
  // sit on screen. The clicked row is appended, not prepended — it is almost
  // always already in the list, and when it is not it is one extra row at the
  // end rather than a jump in the middle.
  for (const id of fromArgs.length > 0 ? fromArgs : reported) push(id);
  push(sessionIdFromArg(args[0]));
  return out;
}

/** A GroupNode's cwd, when the command came from a folder row. */
function groupCwdFromArg(arg: unknown): string | undefined {
  if (arg === null || typeof arg !== 'object') return undefined;
  const obj = arg as { type?: unknown; cwd?: unknown };
  if (obj.type !== 'group') return undefined;
  return typeof obj.cwd === 'string' && obj.cwd.length > 0 ? obj.cwd : undefined;
}

/** True when the command came from a folder row at all — including the
 *  "(no directory)" row, whose cwd is ''. The distinction matters: every folder
 *  row carries the same contextValue, so the row-scoped verbs are offered on
 *  "(no directory)" too, and falling through to a picker there would silently
 *  retarget the action at a DIFFERENT folder the user never clicked. */
function isGroupArg(arg: unknown): boolean {
  if (arg === null || typeof arg !== 'object') return false;
  return (arg as { type?: unknown }).type === 'group';
}

/** '' when the row is actionable, else the reason it is not. */
function unknownGroupRefusal(arg: unknown): string {
  if (!isGroupArg(arg) || groupCwdFromArg(arg) !== undefined) return '';
  return 'Canopy: those sessions report no working directory, so there is no folder to act on.';
}

/** A ProjectGroupNode's id, when the command came from a project row. */
export function projectIdFromArg(arg: unknown): string | undefined {
  if (arg === null || typeof arg !== 'object') return undefined;
  const obj = arg as { type?: unknown; projectId?: unknown };
  if (obj.type !== 'project') return undefined;
  return typeof obj.projectId === 'string' && obj.projectId.length > 0
    ? obj.projectId
    : undefined;
}

/** Write to the clipboard and say so, without letting a clipboard that refuses
 *  (a headless host, a locked session) throw out of a copy verb. */
async function copyToClipboard(text: string, said: string): Promise<void> {
  if (typeof text !== 'string' || text === '') return;
  try {
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage(`Canopy: ${said}`);
  } catch (err) {
    logError('commands.copyToClipboard', err);
  }
}

/**
 * A branch-chip invocation: `{type:'branch', projectId, dir, branch}`.
 *
 * Shaped like the other `*FromArg` readers and just as suspicious of its input.
 * `dir` is only ever a HINT here — the command re-resolves it against the
 * project's live branch list before spawning anything (see
 * newSessionInBranch) — so this is a shape check, not a trust boundary.
 */
export function branchArgOf(
  arg: unknown,
): { projectId: string; dir: string; branch: string } | undefined {
  if (arg === null || typeof arg !== 'object') return undefined;
  const obj = arg as {
    type?: unknown;
    projectId?: unknown;
    dir?: unknown;
    branch?: unknown;
  };
  if (obj.type !== 'branch') return undefined;
  if (typeof obj.projectId !== 'string' || obj.projectId === '') return undefined;
  if (typeof obj.dir !== 'string' || obj.dir.trim() === '') return undefined;
  return {
    projectId: obj.projectId,
    dir: obj.dir,
    branch: typeof obj.branch === 'string' ? obj.branch : '',
  };
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

/** Labels of the sessions already in `cwd` (or anywhere beneath it), so a new
 *  session there is offered a name that is not already on screen. Deleted rows
 *  are excluded: they are not visible, so they must not push the counter up. */
function namesUnder(deps: CommandDeps, dirs: readonly string[]): string[] {
  const out: string[] = [];
  try {
    for (const node of deps.getForest().nodes.values()) {
      if (node.deleted || node.ghost) continue;
      if (dirs.some((dir) => isWithin(dir, node.cwd ?? ''))) out.push(node.label);
    }
  } catch (err) {
    // A name suggestion is never worth failing the verb over.
    logError('commands.namesUnder', err);
  }
  return out;
}

function labelFor(deps: CommandDeps, sessionId: string): string {
  const node = deps.getForest().nodes.get(sessionId);
  if (node) return node.label;
  const record = deps.getRecord(sessionId);
  return record?.title ?? shortId(sessionId);
}

/**
 * The name a session's TERMINAL TAB should carry, or undefined when the
 * session has no name of its own and the tab's `claude · 1a2b3c4d` default is
 * the honest answer.
 *
 * `labelFor` is the wrong tool for this: it falls back to the short id, and a
 * launch handed that would put a bare code on the tab — worse than the default,
 * which at least says what the tab is. So the shortId fallbacks the forest
 * builds for an unnamed session (`1a2b3c4d`, `1a2b3c4d (gone)`) are rejected
 * here, and everything a human or the CLI actually named survives:
 * `record.title` > roster name > transcript `customTitle`, which is the label
 * precedence the row already renders.
 */
export function tabTitleFor(
  deps: CommandDeps,
  sessionId: string,
): string | undefined {
  return tabTitleFrom(
    sessionId,
    deps.getForest().nodes.get(sessionId)?.label,
    deps.getRecord(sessionId)?.title,
  );
}

/** Pure core of `tabTitleFor`, so the wiring — which holds the forest and the
 *  store directly, not a CommandDeps — can answer the same question the same
 *  way. See tabTitleFor for why the shortId fallbacks are rejected. */
export function tabTitleFrom(
  sessionId: string,
  label: string | undefined,
  recordTitle: string | undefined,
): string | undefined {
  const short = shortId(sessionId);
  const name = label?.trim();
  if (name !== undefined && name !== '') {
    if (name !== short && name !== `${short} (gone)`) return name;
  }
  const title = recordTitle?.trim();
  return title !== undefined && title !== '' ? title : undefined;
}

// ------------------------------------------------------------- staleness

/** tree.ts owns the tree's own age rendering and commands.ts may not import
 *  it, so this is the same shape kept deliberately coarse — a QuickPick line
 *  wants "6d", not "6d 4h 11m". */
function ageLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown age';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m old`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h old`;
  return `${Math.floor(ms / 86_400_000)}d old`;
}

export interface StaleCandidate {
  sessionId: string;
  label: string;
  /** -1 when the session carries no usable timestamp. */
  ageMs: number;
  /** Whether the checkbox starts ticked. Never more than a suggestion. */
  stale: boolean;
  cwd?: string;
  detail: string;
}

/**
 * The rows `lineage.deleteStale` offers, oldest first.
 *
 * Ghosts are excluded on purpose: a ghost exists only because a live child
 * points at it, so removing it while keeping the child on screen would leave
 * an orphan whose lineage silently changed. Delete the child and the ghost
 * goes by itself. Deleted rows are excluded because they are already gone.
 *
 * A session with no timestamp is offered but never pre-ticked, and sorts last:
 * an unknown age is not evidence of staleness.
 */
export function staleCandidates(
  forest: SessionForest,
  staleAfterMs: number,
  now: number,
): StaleCandidate[] {
  const threshold =
    Number.isFinite(staleAfterMs) && staleAfterMs > 0
      ? staleAfterMs
      : Number.POSITIVE_INFINITY;

  const out: StaleCandidate[] = [];
  for (const node of orderedNodes(forest)) {
    if (node.hidden || node.deleted || node.ghost) continue;
    // Age is time since the session last DID anything, never since it started —
    // that is the number the user is judging it on, and it is the same basis
    // every row on screen is aged off (viewmodel.ts / tree.ts), so "6d old" in
    // this list means what "6d" means in the sidebar. Ageing a live session
    // off `startedAt` instead pre-ticks a session that has been worked on
    // continuously for a week for deletion, which is the opposite of stale.
    // An archived row needs no special case: buildForest stamps its
    // `lastActiveAt` from the archive's `endedAt`.
    const stamp = node.lastActiveAt ?? node.startedAt;
    const ageMs =
      typeof stamp === 'number' && Number.isFinite(stamp) && stamp <= now
        ? now - stamp
        : -1;
    out.push({
      sessionId: node.id,
      label: node.label,
      ageMs,
      stale: ageMs >= 0 && ageMs >= threshold,
      ...(node.cwd === undefined ? {} : { cwd: node.cwd }),
      detail: [shortId(node.id), ageLabel(ageMs), node.status].join(' · '),
    });
  }
  // Oldest first; unknown ages last, because they are the ones the user has to
  // think about rather than skim.
  out.sort((a, b) => {
    if (a.ageMs < 0 !== b.ageMs < 0) return a.ageMs < 0 ? 1 : -1;
    return b.ageMs - a.ageMs;
  });
  return out;
}

// ---------------------------------------------------------- notifications

/** One bell-dropdown row (M12). Pure data; ordering rules live in
 *  `notificationItems`, where the tests bite. */
export interface NotificationItem {
  sessionId: string;
  label: string;
  /** Green: finished and not looked at. */
  unseen: boolean;
  /** ISO of the finish, when one was stamped. */
  doneAt?: string;
  projectName?: string;
  status: SessionNode['status'];
  waitingFor?: string;
}

/**
 * The bell's content: latest finished sessions, cmux-style — unseen first
 * (they are what the bell exists for), then already-seen history, both newest
 * finish first. Muted (`notify: false`), hidden and deleted sessions never
 * appear; ghosts have nothing to report. Neither does a session the user has
 * taken off the list with its × — see `dismissed` below.
 */
export function notificationItems(
  forest: SessionForest,
  records: Record<string, EditorialRecord>,
  projects: readonly ProjectRecord[],
  limit = 25,
): NotificationItem[] {
  const out: NotificationItem[] = [];
  for (const node of forest.nodes.values()) {
    if (node.ghost || node.deleted || node.hidden) continue;
    const record = records[node.id];
    if (record?.notify === false) continue;
    const unseen = node.unseen === true;
    const doneAt = record?.doneAt;
    if (!unseen && doneAt === undefined) continue; // nothing ever finished here
    // Dismissed (M18), and only for the finish it was dismissed FOR: a newer
    // `doneAt` is a new thing to report and outranks the ×. Compared as ISO
    // strings, which sort lexicographically iff they are the same shape — both
    // are written by nowIso(), so they are. A session with no `doneAt` at all
    // but an `unseen` standing ask is dismissible too, and stays dismissed
    // until it finishes something.
    const dismissedAt = record?.notifyDismissedAt;
    if (dismissedAt !== undefined && (doneAt === undefined || doneAt <= dismissedAt)) {
      continue;
    }
    const item: NotificationItem = {
      sessionId: node.id,
      label: node.label,
      unseen,
      status: node.status,
    };
    if (doneAt !== undefined) item.doneAt = doneAt;
    const waitingFor = node.roster?.waitingFor;
    if (waitingFor !== undefined && waitingFor.trim() !== '') {
      item.waitingFor = waitingFor.trim();
    }
    const match = matchProject(projects, node.cwd);
    if (match) item.projectName = match.project.name;
    out.push(item);
  }
  out.sort((a, b) => {
    if (a.unseen !== b.unseen) return a.unseen ? -1 : 1;
    const ad = a.doneAt ?? '';
    const bd = b.doneAt ?? '';
    if (ad !== bd) return ad > bd ? -1 : 1; // newest finish first
    return a.sessionId < b.sessionId ? -1 : 1;
  });
  return out.slice(0, Math.max(0, limit));
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
  // `!n.deleted`, not `!n.hidden`: a deleted session has no row, so offering it
  // would act on something the user cannot see. A HIDDEN one is on screen —
  // greyed, at the bottom — and every verb still applies to it.
  const nodes = orderedNodes(deps.getForest()).filter(
    (n) => !n.deleted && filter(n),
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
 * Sessions carrying `deleted`, for the restore verb.
 *
 * Driven off the RECORDS rather than the forest on purpose: a deleted session
 * has no visible row and may not be in the forest at all, so the editorial
 * store is the only place that still remembers the user removed it.
 */
async function pickFlaggedSession(
  deps: CommandDeps,
  flag: 'deleted',
  placeHolder: string,
): Promise<string | undefined> {
  const flagged = Object.values(deps.allRecords()).filter(
    (record) => record[flag] === true,
  );
  if (flagged.length === 0) {
    void vscode.window.showInformationMessage(
      'Canopy: no deleted sessions to restore.',
    );
    return undefined;
  }
  const forest = deps.getForest();
  const items: SessionPick[] = flagged.map((record) => {
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
        ? 'Canopy: no live Claude sessions right now.'
        : 'Canopy: no sessions in the tree yet.'),
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

/**
 * The folder this WINDOW is open on, or undefined when it does not claim one.
 *
 * The active editor's folder first: in a multi-root window "current" means the
 * file you are looking at, not the first entry in the workspace file. Then the
 * single-folder case, which is the overwhelming majority. A multi-root window
 * with no editor open genuinely has no answer and says so.
 */
function openWorkspaceFolder(): string | undefined {
  // The WHOLE body is guarded, not just the call. This module is unit-tested
  // against a hand-written `vscode` stub whose namespaces are mostly empty, so
  // every reach into the workbench here is a possible TypeError rather than a
  // compile error — and "no folder" is the correct answer in that case anyway.
  try {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) return undefined;

    const doc = vscode.window.activeTextEditor?.document;
    if (doc?.uri && typeof vscode.workspace.getWorkspaceFolder === 'function') {
      const owner = vscode.workspace.getWorkspaceFolder(doc.uri);
      const fsPath = owner?.uri?.fsPath;
      if (typeof fsPath === 'string' && fsPath.length > 0) return fsPath;
    }

    if (folders.length !== 1) return undefined;
    const only = folders[0]?.uri?.fsPath;
    return typeof only === 'string' && only.length > 0 ? only : undefined;
  } catch (err) {
    logError('commands.openWorkspaceFolder', err);
    return undefined;
  }
}

/**
 * Where the view title's `+` starts a session, with nothing asked: the project
 * the window is open on.
 *
 * An open folder INSIDE a project launches at the project's own directory
 * rather than at the folder — the `+` files the session under the project row
 * you are already looking at, and that is the directory every other session in
 * it was started from. Undefined means the window makes no claim, and the
 * caller falls back to the picker.
 */
function defaultLaunchFolder(deps: CommandDeps): string | undefined {
  const open = openWorkspaceFolder();
  if (open === undefined) return undefined;
  const visible = deps.allProjects().filter((p) => p.hidden !== true);
  return matchProject(visible, open)?.dir ?? open;
}

/** Projects first — they are the unit of organisation, so they are the unit of
 *  "where does this session go". Then workspace folders, then roster cwds,
 *  then an explicit "Other…". */
async function pickLaunchFolder(
  deps: CommandDeps,
): Promise<{ cwd?: string } | undefined> {
  const items: FolderPick[] = [];
  const listed = new Set<string>();

  for (const project of deps.allProjects()) {
    if (project.hidden === true) continue;
    for (const [i, dir] of projectDirs(project).entries()) {
      const key = pathKey(dir);
      if (listed.has(key)) continue;
      listed.add(key);
      items.push({
        label: `$(project) ${project.name}${i === 0 ? '' : ` — ${baseName(dir)}`}`,
        description: dir,
        folder: dir,
      });
    }
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const fsPath = folder.uri.fsPath;
    if (listed.has(pathKey(fsPath))) continue;
    listed.add(pathKey(fsPath));
    items.push({
      label: `$(root-folder) ${folder.name}`,
      description: fsPath,
      folder: fsPath,
    });
  }
  for (const cwd of rosterFolders(deps)) {
    if (listed.has(pathKey(cwd))) continue;
    listed.add(pathKey(cwd));
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

async function pickOpenableFolder(
  deps: CommandDeps,
): Promise<string | undefined> {
  const items: FolderPick[] = [];
  const listed = new Set<string>();
  for (const project of deps.allProjects()) {
    for (const dir of projectDirs(project)) {
      if (listed.has(pathKey(dir))) continue;
      listed.add(pathKey(dir));
      items.push({
        label: `$(project) ${project.name}`,
        description: dir,
        folder: dir,
      });
    }
  }
  for (const cwd of rosterFolders(deps)) {
    if (listed.has(pathKey(cwd))) continue;
    listed.add(pathKey(cwd));
    items.push({ label: `$(folder) ${baseName(cwd)}`, description: cwd, folder: cwd });
  }
  if (items.length === 0) {
    void vscode.window.showInformationMessage(
      'Canopy: no project or session directories to open.',
    );
    return undefined;
  }
  const chosen = await vscode.window.showQuickPick(items, {
    placeHolder: 'Open which directory in a new window?',
    matchOnDescription: true,
    ignoreFocusOut: true,
  });
  return chosen?.folder;
}

/** Folders currently in the tree that a hide would actually remove: no
 *  project covers them and they are not hidden already. */
async function pickHideableFolder(
  deps: CommandDeps,
): Promise<string | undefined> {
  const projects = deps.allProjects().filter((p) => p.hidden !== true);
  const hidden = new Set(deps.hiddenFolders().map((f) => pathKey(f.path)));
  const items: FolderPick[] = [];
  for (const cwd of rosterFolders(deps)) {
    if (hidden.has(pathKey(cwd))) continue;
    if (matchProject(projects, cwd)) continue;
    items.push({ label: baseName(cwd), description: cwd, folder: cwd });
  }
  if (items.length === 0) {
    void vscode.window.showInformationMessage(
      'Canopy: every folder in the tree already belongs to a project or is hidden.',
    );
    return undefined;
  }
  const chosen = await vscode.window.showQuickPick(items, {
    placeHolder: 'Remove which folder from the tree?',
    matchOnDescription: true,
    ignoreFocusOut: true,
  });
  return chosen?.folder;
}

// -------------------------------------------------------------- projects

interface ProjectPick extends vscode.QuickPickItem {
  projectId: string;
}

interface ActionPick extends vscode.QuickPickItem {
  action: string;
  payload?: string;
}

/** One folder from the OS picker, normalized. */
async function pickDirectory(
  openLabel: string,
  title?: string,
  /** M26. Where the dialog opens. A path, not a Uri, so this module keeps its
   *  one vscode dependency (the dialog itself) and the callers keep handing
   *  round plain strings. Ignored when the host's Uri.file is unavailable —
   *  the unit-test double — or when the path is empty. */
  defaultDir?: string,
): Promise<string | undefined> {
  let defaultUri: vscode.Uri | undefined;
  const opensAt = normalizeDir(defaultDir);
  if (opensAt !== '') {
    try {
      defaultUri = vscode.Uri.file(opensAt);
    } catch (err) {
      logError('commands.pickDirectory.defaultUri', err);
    }
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel,
    title,
    ...(defaultUri ? { defaultUri } : {}),
  });
  const uri = picked?.[0];
  if (!uri) return undefined;
  const dir = normalizeDir(uri.fsPath);
  return dir === '' ? undefined : dir;
}

async function pickProject(
  deps: CommandDeps,
  placeHolder: string,
  opts?: { includeHidden?: boolean },
): Promise<string | undefined> {
  const projects = deps
    .allProjects()
    .filter((p) => (opts?.includeHidden ? true : p.hidden !== true));
  if (projects.length === 0) {
    void vscode.window.showInformationMessage(
      'Canopy: no projects yet — create one with "Canopy: New Project…".',
    );
    return undefined;
  }
  // M26. Listed in TREE order and indented, not alphabetically flat: with
  // nesting, two projects can legitimately be called "api" and the only thing
  // telling them apart in a picker is what they are filed under.
  const tree = buildProjectTree(projects);
  const shown = new Set(projects.map((p) => p.id));
  const ordered = tree.order.filter((id) => shown.has(id));
  const items: ProjectPick[] = ordered.map((id) => {
    const node = tree.byId.get(id);
    const p = node?.project ?? projects.find((x) => x.id === id)!;
    const dirs = projectDirs(p);
    const depth = node?.depth ?? 0;
    return {
      label: `${'    '.repeat(depth)}${depth > 0 ? '$(chevron-right) ' : ''}${p.name}`,
      description: [
        PROVIDERS[providerOfProject(p)].label,
        dirs.length > 1 ? `${dirs.length} directories` : '',
        p.hidden === true ? 'closed' : '',
      ]
        .filter((s) => s !== '')
        .join(' · '),
      detail: dirs.join('  ·  '),
      projectId: p.id,
    };
  });
  const chosen = await vscode.window.showQuickPick(items, {
    placeHolder,
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  return chosen?.projectId;
}

/** The directory a new session in this project should start in. One dir =
 *  no question asked; several = pick, because that IS the point of a
 *  multi-directory project. */
async function pickProjectDirectory(
  project: ProjectRecord,
  placeHolder: string,
): Promise<string | undefined> {
  const dirs = projectDirs(project);
  if (dirs.length === 0) return undefined;
  if (dirs.length === 1) return dirs[0];
  const items: FolderPick[] = dirs.map((dir, i) => ({
    label: `${i === 0 ? '$(star-full)' : '$(folder)'} ${baseName(dir)}`,
    description: i === 0 ? `${dir} — main` : dir,
    folder: dir,
  }));
  const chosen = await vscode.window.showQuickPick(items, {
    placeHolder,
    matchOnDescription: true,
    ignoreFocusOut: true,
  });
  return chosen?.folder;
}

/**
 * Create a project: a name, a main directory, and as many extra directories as
 * the user wants to add before committing.
 *
 * The directory list is built BEFORE anything is written, so escaping at any
 * step leaves no half-made project behind. `seed` lets "Make Project from this
 * Folder" skip straight to the directory list.
 *
 * The name is generated, not asked for: the project is created under its main
 * directory's basename (deduped the same case-insensitive way
 * `validateProjectName` refuses a clash) and renamed in place on its own row
 * afterwards, which is the same create-then-name gesture every other verb uses.
 */
async function newProjectFlow(
  deps: CommandDeps,
  seed?: { rootDir?: string; name?: string; parentId?: string },
): Promise<string | undefined> {
  // M26. A subproject starts its directory pick INSIDE its parent, because
  // that is where it is going to be nine times out of ten — `~/code/app` then
  // `api`, not `~/code/app` then a walk back up from wherever the last dialog
  // happened to be. The dialog is still a full picker; only its opening
  // directory changes, so filing a subproject somewhere else entirely (a
  // sibling checkout, a notes folder) is exactly as available as it was.
  const parent = seed?.parentId ? deps.getProject(seed.parentId) : undefined;
  const rootDir =
    normalizeDir(seed?.rootDir) ||
    (await pickDirectory(
      'Use as Main Directory',
      parent
        ? `Main directory for a project inside ${parent.name}`
        : 'Main directory for the project',
      parent ? projectDirs(parent)[0] : undefined,
    ));
  if (!rootDir) return undefined;

  const existing = deps.allProjects();
  const name = nextFreeName(
    seed?.name ?? baseName(rootDir),
    existing.map((p) => p.name),
    MAX_PROJECT_NAME_LEN,
  );

  const extraDirs: string[] = [];
  const seen = new Set<string>([pathKey(rootDir)]);
  for (;;) {
    const items: ActionPick[] = [
      {
        label: '$(check) Create Project',
        description: `${name} · ${1 + extraDirs.length} director${
          extraDirs.length === 0 ? 'y' : 'ies'
        }`,
        action: 'done',
      },
      {
        label: '$(add) Add Another Directory…',
        description: 'A project can span any number of directories',
        action: 'add',
      },
    ];
    for (const dir of extraDirs) {
      items.push({
        label: `$(close) Remove ${baseName(dir)}`,
        description: dir,
        action: 'remove',
        payload: dir,
      });
    }
    const chosen = await vscode.window.showQuickPick(items, {
      title: parent ? `New Project in ${parent.name} — ${name}` : `New Project — ${name}`,
      placeHolder: `Main: ${rootDir}`,
      ignoreFocusOut: true,
    });
    if (!chosen) return undefined; // escape cancels the whole verb
    if (chosen.action === 'done') break;
    if (chosen.action === 'remove' && chosen.payload) {
      const i = extraDirs.indexOf(chosen.payload);
      if (i >= 0) extraDirs.splice(i, 1);
      seen.delete(pathKey(chosen.payload));
      continue;
    }
    const dir = await pickDirectory('Add to Project', `Add a directory to ${name}`);
    if (!dir) continue;
    if (seen.has(pathKey(dir))) {
      void vscode.window.showInformationMessage(
        `"${baseName(dir)}" is already in this project.`,
      );
      continue;
    }
    seen.add(pathKey(dir));
    extraDirs.push(dir);
  }

  const id = randomUUID();
  await deps.upsertProject(id, {
    name,
    rootDir,
    dirs: extraDirs,
    // Written with the create rather than through setProjectParent: there is
    // no cycle to check against a project that does not exist yet, and one
    // write means a half-made project cannot exist even for a tick.
    ...(parent ? { parentId: parent.id } : {}),
  });
  log(
    'project: created',
    id,
    name,
    rootDir,
    `+${extraDirs.length} dir(s)`,
    parent ? `under ${parent.name}` : '(top level)',
  );
  deps.refresh();
  // Select the new project's row and open an editor on its label: the tree is
  // where the name lives from now on, and the generated one is only a default.
  await deps.revealProject(id);
  await nameJustCreatedProject(deps, id);
  return id;
}

// ------------------------------------------------------------- verb flows

/**
 * Start a session in `cwd` (undefined = wherever the shell lands).
 *
 * Create first, name after — the Explorer's "New File" gesture. The standard
 * name is good enough to run under, so nothing blocks the launch; the row is
 * then revealed with an editable input on it, and Escape simply keeps the
 * standard name instead of throwing the session away. There is no
 * opening-prompt box either: the terminal opens a keystroke later and is a
 * better place to type one.
 */
async function newSessionFlow(
  deps: AccountCommandDeps,
  cwd: string | undefined,
  account?: AccountProfile,
): Promise<void> {
  const title = defaultSessionTitle(
    cwd,
    cwd === undefined ? [] : namesUnder(deps, [cwd]),
  );

  // M22: routed by the project this directory belongs to, if any — a folder
  // that is part of a project inherits that project's account even when the
  // launch came from the folder rather than from the project's row.
  const routed = routeNewSession(deps, projectIdForCwd(deps, cwd), account);

  const sessionId = randomUUID();
  await deps.recordLaunch(sessionId, null, cwd);
  await deps.upsertRecord(sessionId, { title });
  log('new:', shortId(sessionId), cwd ?? '(no cwd)');
  const binding = await deps.launchSession({
    sessionId,
    cwd,
    title,
    ...launchAccountOptions(routed),
  });
  if (!binding) {
    log('new: launch failed for', shortId(sessionId));
    return;
  }
  await pinLaunch(deps, sessionId, routed);
  routed.announce?.();
  deps.refresh();
  // Select the row so the name is visible where it will live from now on, then
  // put an editable input on it. `revealSession` is deliberately not awaited —
  // it will wait up to REVEAL_WAIT_MS for the roster to notice the new process
  // — while `beginInlineRename` does its own, immediate reveal against the
  // inline view's model, which already has the row.
  void deps.revealSession(sessionId);
  await nameJustCreatedSession(deps, sessionId);
}

/**
 * A session in a project, started from the project's own row.
 *
 * The project's MAIN directory, with nothing asked. This verb is the `+` on a
 * project row (M18) and a `+` that opens a dialog is not a `+`: the session is
 * meant to exist by the time the click finishes, named on its own row. A
 * multi-directory project starts in its rootDir — which is what "main" means,
 * and what every other project verb already uses — and `claude --add-dir` is
 * not needed for the others to be reachable. Choosing a different directory is
 * what "New Claude Session in Folder…" is for.
 *
 * Extracted from the command handler in M22 so "New Session From…" — the same
 * launch with the account picked by hand — cannot drift from it.
 */
async function newSessionInProjectFlow(
  deps: AccountCommandDeps,
  projectId: string,
  account?: AccountProfile,
): Promise<void> {
  const project = deps.getProject(projectId);
  if (!project) return;
  const cwd = projectDirs(project)[0];
  if (!cwd) return;

  // Named, not prompted — same as every other create path. The stem is the
  // PROJECT's name rather than the directory's: you clicked `+` on that
  // project, and a project spanning several directories would otherwise
  // suggest a different name depending on which one you picked.
  const title = nextFreeName(
    project.name,
    namesUnder(deps, projectDirs(project)),
  );
  const routed = routeNewSession(deps, project.id, account);

  const sessionId = randomUUID();
  await deps.recordLaunch(sessionId, null, cwd);
  await deps.upsertRecord(sessionId, { title });
  log('new:', shortId(sessionId), 'in project', project.name, cwd);
  const binding = await deps.launchSession({
    sessionId,
    cwd,
    title,
    ...launchAccountOptions(routed),
  });
  if (!binding) {
    log('new: launch failed for', shortId(sessionId));
    return;
  }
  await pinLaunch(deps, sessionId, routed);
  routed.announce?.();
  deps.refresh();
  void deps.revealSession(sessionId);
  await nameJustCreatedSession(deps, sessionId);
}

/**
 * Fork = mint a child uuid, record the parent edge BEFORE launching, then
 * launch `--fork-session --resume <parent> --session-id <child>`. The edge is
 * exact by construction; nothing about it is ever inferred.
 */
/**
 * Fork = a new branch off a live or closed session.
 *
 * `opts.title` set (the ask verb, whose question IS the name) skips naming
 * entirely. Otherwise the branch launches immediately under a standard name —
 * the parent's, plus the next free counter — and is renamed in place on its own
 * row afterwards. Computing the name before launch is deliberate: the terminal
 * is created with the right tab title instead of being renamed a moment later,
 * and a crash between here and launch leaves a correctly-named record either
 * way. Escape during the rename keeps the standard name; it never discards a
 * branch that is already running.
 */
async function forkFlow(
  deps: AccountCommandDeps,
  parentIdArg: string,
  opts?: { prompt?: string; title?: string },
): Promise<string | undefined> {
  // M10: fork the conversation's CURRENT generation, whatever id the caller
  // held. A row can be superseded between render and click (a resume that
  // re-minted the id, a /clear, a compaction), and forking the id as-clicked
  // is exactly the fork-an-older-version bug this milestone removes.
  const parentId = deps.tipOf(parentIdArg);
  // Claude writes a transcript lazily; there is nothing to resume until it has.
  if (!deps.hasTranscript(parentId)) {
    void vscode.window.showWarningMessage(
      'Session has no transcript yet — send one message first.',
    );
    return undefined;
  }
  const forest = deps.getForest();
  const node = forest.nodes.get(parentId);
  const cwd = node?.cwd ?? deps.getRecord(parentId)?.cwd;

  let title = opts?.title;
  const titleGiven = title !== undefined;
  if (title === undefined) {
    const parentLabel = node?.label ?? labelFor(deps, parentId);
    const siblings = (node?.children ?? [])
      .map((id) => forest.nodes.get(id)?.label)
      .filter((l): l is string => typeof l === 'string');
    title = defaultForkTitle(parentLabel, siblings);
  }

  const childId = randomUUID();

  // M22: a fork INHERITS its parent's account, never a routed one. The launch
  // is `--fork-session --resume <parent>`, so it has to read the parent's
  // transcript — which lives inside the parent account's config directory and
  // nowhere else. Routing a fork would break it, not merely misbill it.
  const routed = pinnedLaunch(deps, parentId);

  // Record the edge at mint time — before the terminal exists, so a crash
  // between here and launch still leaves the lineage correct.
  await deps.recordLaunch(childId, parentId, cwd);
  await deps.upsertRecord(childId, { title });

  log('fork:', shortId(childId), 'from', shortId(parentId), cwd ?? '(no cwd)');
  const binding = await deps.launchSession({
    sessionId: childId,
    parentId,
    cwd,
    prompt: opts?.prompt,
    title,
    ...launchAccountOptions(routed),
  });
  if (!binding) {
    log('fork: launch failed for', shortId(childId));
    return undefined;
  }
  await pinLaunch(deps, childId, routed);
  deps.refresh();
  // Select the new branch's row: the tree is where its name lives from now on.
  void deps.revealSession(childId);
  // The ask verb's question already IS the name, so there is nothing to
  // confirm — only a branch that fell back to the generated name opens an
  // editor on its row.
  if (!titleGiven) await nameJustCreatedSession(deps, childId);
  return childId;
}

/**
 * M25. Adopt a native `/fork` — finish turning it into the session that
 * clicking **Fork Session** would have produced.
 *
 * `/fork` does not open a tab anywhere. It dispatches a BACKGROUND JOB: a live
 * process holding the child's session id, parked on "send a prompt to start",
 * whose pty lives on a daemon socket no editor can attach to. M11 taught the
 * tree to NEST such a child; this is what makes it OPEN. The user typed the
 * fork verb, so they get the fork verb's result.
 *
 * Adoption is a HAND-OFF, not a copy. The job is stopped and the SAME session
 * id is relaunched here under our own terminal, so the row that was clicked is
 * the row that opens — same id, same parent edge, same place in the tree — and
 * the branch arrives with the name, the account pin and the tab that `forkFlow`
 * gives every other fork.
 *
 * Four refusals, each of which leaves the caller's existing fallback intact:
 *
 *  * `job.attached` — a terminal has driven this job before, so it has an
 *    owner. Relaunching would put a second writer on one transcript, the one
 *    corruption this extension is careful never to cause.
 *  * `!job.live` — the job has finished (`done`/`failed`/`stopped`). The
 *    daemon does not reap a finished worker's roster row promptly, so this is
 *    the difference between adopting a branch and resurrecting a conversation
 *    the user ended.
 *  * no `parentId` — a background job that is not a fork. Nothing to relaunch
 *    it from.
 *  * no parent transcript — `--fork-session --resume` has nothing to read.
 *
 * The relaunch forks the parent's CURRENT transcript rather than the copy the
 * job snapshotted at its fork boundary, so an adopted branch can carry a few
 * more turns of the parent than the raw `/fork` would have. That is the same
 * history clicking Fork Session right now would give, which is the behaviour
 * this whole path is converging on.
 */
export async function adoptBackgroundJob(
  deps: AccountCommandDeps,
  sessionId: string,
  job: BackgroundJob,
): Promise<boolean> {
  if (job.attached || !job.live) return false;
  const parentId = job.parentId;
  if (parentId === undefined || parentId === sessionId) return false;
  if (!deps.hasTranscript(parentId)) return false;

  const node = deps.getForest().nodes.get(sessionId);
  const cwd = job.cwd ?? node?.cwd ?? deps.getRecord(parentId)?.cwd;

  // Name it the way a fork is named here, unless the user has already renamed
  // the row. The CLI seeds a job's own name by COPYING the parent's, which is
  // the duplicate-looking row this replaces.
  const record = deps.getRecord(sessionId);
  let title = record?.title;
  if (title === undefined || title.trim() === '') {
    const parentNode = deps.getForest().nodes.get(parentId);
    const parentLabel = parentNode?.label ?? labelFor(deps, parentId);
    const siblings = (parentNode?.children ?? [])
      .filter((id) => id !== sessionId)
      .map((id) => deps.getForest().nodes.get(id)?.label)
      .filter((l): l is string => typeof l === 'string');
    title = defaultForkTitle(parentLabel, siblings);
  }

  // Stop the job BEFORE relaunching: two processes must never hold one session
  // id. Verified on CLI 2.1.220 that SIGTERM to the roster pid takes the whole
  // worker down and the daemon does NOT respawn it. A pid that is already gone
  // (ESRCH) is the success case, not a failure — but any other error means we
  // do not know that the id is free, so we refuse rather than double-write.
  const pid = node?.roster?.pid;
  if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ESRCH') {
        logError('adopt: could not stop background job', err);
        return false;
      }
    }
  }

  // Same edge bookkeeping as forkFlow, and for the same reason: recorded
  // before the process exists, so a crash between here and launch still leaves
  // the lineage correct.
  await deps.recordLaunch(sessionId, parentId, cwd);
  await deps.upsertRecord(sessionId, { title });

  // M22: a fork inherits its parent's account, never a routed one — the launch
  // reads the parent's transcript, which lives in that account's config dir.
  const routed = pinnedLaunch(deps, parentId);

  log('adopt:', shortId(sessionId), 'from background job of', shortId(parentId));
  const binding = await deps.launchSession({
    sessionId,
    parentId,
    cwd,
    title,
    ...launchAccountOptions(routed),
  });
  if (!binding) {
    log('adopt: launch failed for', shortId(sessionId));
    return false;
  }
  await pinLaunch(deps, sessionId, routed);
  deps.refresh();
  void deps.revealSession(sessionId);
  return true;
}

/**
 * Detach tier (src/tmux.ts): the tmux session name this conversation's record
 * carries, probed under the clicked id and its chain tip. A name here was
 * written when a workspace switch parked the session by DETACH — the process
 * is running HIDDEN in the private tmux server, no window shows a tab — and
 * the way back in is to ATTACH, never to fork it or `--resume` a second
 * process beside it.
 */
export function detachedTmuxName(
  deps: CommandDeps,
  sessionId: string,
): string | undefined {
  const name =
    deps.getRecord(deps.tipOf(sessionId))?.tmux ??
    deps.getRecord(sessionId)?.tmux;
  return typeof name === 'string' && name !== '' ? name : undefined;
}

/**
 * Resume = reopen a CLOSED session in a terminal here, under its own id.
 *
 * Safe precisely because the session is not running: `--resume` reuses the
 * original session id, so pointing a second claude process at a transcript
 * another process is actively appending to would be two writers on one file.
 * That is why this refuses a live session and offers a fork instead — forking
 * is the supported way to branch off something that is already running.
 *
 * ONE exception: a live session whose record names a tmux session (detach
 * tier) is ours, hidden, and attaching is not a second writer — the launch
 * wraps in `new-session -A` under the recorded name, and tmux hands back the
 * very process already writing the transcript. For those this flow IS the
 * attach verb.
 */
export async function resumeFlow(
  deps: AccountCommandDeps,
  sessionIdArg: string,
): Promise<boolean> {
  // M10: same tip routing as forkFlow — resuming a superseded generation
  // would branch the conversation's history without the user asking for it.
  const sessionId = deps.tipOf(sessionIdArg);
  const node = deps.getForest().nodes.get(sessionId);
  const detached = detachedTmuxName(deps, sessionIdArg);

  if (node && !node.archived && node.status !== 'exited' && detached === undefined) {
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
  log(
    'resume:',
    shortId(sessionId),
    cwd ?? '(no cwd)',
    ...(detached !== undefined ? [`(attach: ${detached})`] : []),
  );

  // M22: the account this conversation started on, re-injected. Passed even on
  // the ATTACH path, where the already-running process keeps the environment
  // it was launched with and the `-e` flags are ignored — because `-A` falls
  // through to a fresh `--resume` when the detached session died while parked,
  // and that launch must land on the same account as the first one.
  const routed = pinnedLaunch(deps, sessionId);

  // The resumed process keeps this id, so sessionId === resumeId: the
  // LINEAGE_NODE_ID stamp and the binding both name what will be running.
  // Explicit tmuxName for the detach case — relying on the wiring's record
  // lookup would leave this flow's correctness in another file.
  // The tab is named from the ROW's name, exactly as the workspace restore
  // does it. Omitting it was the bug behind "the session is named fine but its
  // tab says claude · 1a2b3c4d": every other create verb passes a title, so
  // resume was the one path that dropped the name the user had given the
  // conversation and let the launch fall back to the short id.
  const tabTitle = tabTitleFor(deps, sessionId);

  const binding = await deps.launchSession({
    sessionId,
    resumeId: sessionId,
    cwd,
    ...(tabTitle !== undefined ? { title: tabTitle } : {}),
    ...(detached !== undefined ? { tmuxName: detached } : {}),
    ...launchAccountOptions(routed),
  });
  if (!binding) {
    log('resume: launch failed for', shortId(sessionId));
    return false;
  }
  // Records the pin on THIS generation's record when the answer came from the
  // chain — a no-op when it was already there (the store's pin is write-once).
  await pinLaunch(deps, sessionId, routed);
  // Reopening un-closes it (and un-parks it — a session the user reopened by
  // hand must not be resumed a second time by the next workspace switch).
  // `tmux: null` settles the detach-tier claim the same way the workspace
  // restore does: the tab is back, the record must stop saying "hidden".
  await deps.upsertRecord(sessionId, { closed: null, parked: false, tmux: null });
  deps.refresh();
  return true;
}

/**
 * One menu for everything you can do to a project. A separate command per
 * field would be six more palette entries and six more context-menu rows for
 * operations you touch about once per project per year.
 *
 * Every branch re-reads the project through `deps.getProject` afterwards, so
 * an edit made in another window between two steps is never clobbered by a
 * stale copy captured at the top.
 */
export async function configureProjectFlow(
  deps: CommandDeps,
  projectId: string,
): Promise<void> {
  for (;;) {
    const project = deps.getProject(projectId);
    if (!project) {
      void vscode.window.showInformationMessage(
        'Canopy: that project no longer exists.',
      );
      return;
    }
    const dirs = projectDirs(project);
    const items: ActionPick[] = [
      {
        label: '$(edit) Rename…',
        description: project.name,
        action: 'rename',
      },
      {
        label: '$(add) Add Directory…',
        description: `${dirs.length} in this project`,
        action: 'addDir',
      },
    ];
    if (dirs.length > 1) {
      items.push(
        {
          label: '$(star-full) Set Main Directory…',
          description: dirs[0],
          action: 'setMain',
        },
        {
          label: '$(remove) Remove Directory…',
          description: 'Keeps the directory on disk',
          action: 'removeDir',
        },
      );
    }
    items.push(
      {
        label: '$(symbol-color) Set Provider…',
        description: PROVIDERS[providerOfProject(project)].label,
        action: 'provider',
      },
      {
        // M24: the same flag, said the way the verbs on the row now say it.
        // "Hide" and "Show" described a filter; this is a project you put away
        // and take back out, and calling it two different things in two menus
        // is how a user ends up believing they are two features.
        label:
          project.hidden === true
            ? '$(folder-opened) Open Project'
            : '$(archive) Close Project…',
        description:
          project.hidden === true
            ? 'Bring this project back into the tree'
            : 'Leaves the tree; nothing is deleted and nothing stops',
        action: 'toggleHidden',
      },
      {
        label: '$(trash) Delete Project',
        description: 'Removes the project only — never the directories',
        action: 'delete',
      },
    );

    const chosen = await vscode.window.showQuickPick(items, {
      title: `Project — ${project.name}`,
      placeHolder: dirs.join('  ·  '),
      ignoreFocusOut: true,
    });
    if (!chosen) return;

    if (chosen.action === 'rename') {
      // The in-place editor wherever one exists, the quick input only where one
      // does not — the same two-step every other naming path takes.
      //
      // The two halves end this menu differently ON PURPOSE. An inline edit is
      // handed to the sidebar row and is still open when this call returns:
      // reopening the QuickPick behind it would take the keyboard back, blur
      // the input, and the client commits on blur — so the rename would post
      // the UNCHANGED name and visibly do nothing, with the Configure menu
      // sitting on top of it. The menu therefore closes and the row is where
      // the interaction continues. The quick-input fallback, by contrast, is
      // finished by the time it resolves, so the loop can reopen the menu and
      // re-read `project` to show the new name.
      if (await deps.beginInlineRenameProject(projectId)) return;
      await vscode.commands.executeCommand(COMMANDS.renameProject, {
        type: 'project',
        projectId,
      });
      continue;
    }

    if (chosen.action === 'addDir') {
      const dir = await pickDirectory(
        'Add to Project',
        `Add a directory to ${project.name}`,
      );
      if (!dir) continue;
      await addDirectoryToProject(deps, projectId, dir);
      continue;
    }

    if (chosen.action === 'setMain') {
      const picked = await pickProjectDirectory(project, 'Which directory is the main one?');
      if (!picked) continue;
      // Re-read AFTER the picker. `dirs` was captured before it opened, and
      // the picker sits there with ignoreFocusOut — another window, or a drag
      // onto this very project row, can add a directory in the meantime, and
      // a `dirs` patch replaces the list wholesale.
      const fresh = deps.getProject(projectId);
      if (!fresh) continue;
      const rest = projectDirs(fresh).filter(
        (d) => pathKey(d) !== pathKey(picked),
      );
      await deps.upsertProject(projectId, { rootDir: picked, dirs: rest });
      deps.refresh();
      continue;
    }

    if (chosen.action === 'removeDir') {
      const removable: FolderPick[] = dirs.slice(1).map((dir) => ({
        label: baseName(dir),
        description: dir,
        folder: dir,
      }));
      const pick = await vscode.window.showQuickPick(removable, {
        placeHolder: 'Remove which directory from the project?',
        matchOnDescription: true,
        ignoreFocusOut: true,
      });
      if (!pick?.folder) continue;
      // Re-read after the picker — same reason as setMain above.
      const fresh = deps.getProject(projectId);
      if (!fresh) continue;
      const removed = pick.folder;
      await deps.upsertProject(projectId, {
        dirs: projectDirs(fresh)
          .slice(1)
          .filter((d) => pathKey(d) !== pathKey(removed)),
      });
      deps.refresh();
      continue;
    }

    if (chosen.action === 'provider') {
      const current = providerOfProject(project);
      const pick = await vscode.window.showQuickPick(
        PROVIDER_IDS.map((id) => ({
          label: PROVIDERS[id].label,
          description: id === current ? 'current' : '',
          provider: id,
        })),
        {
          placeHolder: 'Which model provider does this project run?',
          ignoreFocusOut: true,
        },
      );
      if (!pick) continue;
      await deps.upsertProject(projectId, { provider: pick.provider });
      deps.refresh();
      continue;
    }

    if (chosen.action === 'toggleHidden') {
      // Through the same flows the row's own verbs use, so the confirmation
      // and the running-session warning cannot be skipped by coming in through
      // this menu instead. Reopening asks nothing — putting something away is
      // the direction that deserves a question.
      if (project.hidden === true) await reopenProject(deps, project);
      else if (!(await closeProjectFlow(deps, project))) continue;
      return;
    }

    if (chosen.action === 'delete') {
      const confirmed = await confirmDeleteProject(deps, project);
      if (confirmed) return;
      continue;
    }
  }
}

/**
 * M24. CLOSE a project — the put-away that is not a delete.
 *
 * What it does is small and is meant to be: the row leaves the tree and takes
 * its sessions' rows with it. Nothing is deleted, no transcript is touched, no
 * process is signalled, and no terminal tab closes. Whatever was running in the
 * project when you closed it is still running when you open it again, in the
 * same tabs, mid-turn if it was mid-turn.
 *
 * ALWAYS CONFIRMED, even though nothing is destroyed. Closing a project takes
 * a whole column of the sidebar away at once, and the difference between this
 * and Delete Project is a sentence the user has to have read at least once —
 * an unconfirmed close would be indistinguishable from a delete to anyone who
 * clicked the wrong row, and they would go looking for their sessions in the
 * wrong place.
 *
 * When something is RUNNING in the project the dialog says so and says how
 * many, because that is the fact the user is about to lose sight of: a busy
 * agent whose row you can no longer see is the one outcome worth a sentence of
 * its own. It is a warning, not a refusal — closing a project with work in it
 * is a perfectly ordinary thing to do, and the work keeps going.
 */
export async function closeProjectFlow(
  deps: CommandDeps,
  project: ProjectRecord,
): Promise<boolean> {
  const running = runningInProject(deps, project);
  // M26. Closing a parent closes everything under it (computeGrouping), so the
  // dialog has to say so — a project putting four other projects away with it
  // is exactly the surprise a confirmation exists to prevent.
  const nested = subprojectCount(deps, project.id);
  const detail = [
    'The project leaves the tree, with its sessions. Nothing is deleted: no ' +
      'transcript, no directory, no record — and nothing stops.',
    nested > 0
      ? `Its ${nested} subproject${nested === 1 ? '' : 's'} ${
          nested === 1 ? 'goes' : 'go'
        } with it, and ${nested === 1 ? 'comes' : 'come'} back when it does.`
      : '',
    running > 0
      ? `${running} session${running === 1 ? '' : 's'} ${
          running === 1 ? 'is' : 'are'
        } still running in it. ${
          running === 1 ? 'It keeps' : 'They keep'
        } running, with no row to watch ${running === 1 ? 'it' : 'them'} from ` +
        'until you open the project again.'
      : '',
    'Open it again from the $(folder-opened) button at the top of the view.',
  ]
    .filter((s) => s !== '')
    .join('\n\n');

  const choice = await vscode.window.showWarningMessage(
    `Close the project "${project.name}"?`,
    { modal: true, detail },
    'Close Project',
  );
  if (choice !== 'Close Project') return false;
  await deps.upsertProject(project.id, { hidden: true });
  log('project: closed', project.id, project.name, `(${running} running)`);
  deps.refresh();
  vscode.window.setStatusBarMessage(
    `Canopy: closed ${project.name} — reopen it with "Canopy: Open Project…"`,
    4000,
  );
  return true;
}

/**
 * M26. Re-file a project: pick where it goes, or Top Level.
 *
 * The picker lists every project the move is LEGAL for and nothing else — the
 * subtree being moved is absent (you cannot file something under itself), and
 * so is anything that would take the chain past the depth cap. Offering a
 * choice and then refusing it is how a picker teaches people not to trust it;
 * `canReparentProject` is the same function the store enforces with, so the two
 * cannot drift.
 *
 * No confirmation. Moving a project changes where a row is drawn and nothing
 * else — no session moves, no directory changes, no membership is recomputed —
 * and it is undone by moving it back.
 */
export async function moveProjectFlow(
  deps: CommandDeps,
  projectId: string,
): Promise<boolean> {
  const project = deps.getProject(projectId);
  if (!project) return false;
  const all = deps.allProjects();
  const tree = buildProjectTree(all);
  const shown = new Set(all.map((p) => p.id));

  const items: ActionPick[] = [];
  if (typeof project.parentId === 'string' && project.parentId !== '') {
    items.push({
      label: '$(home) Top Level',
      description: 'Not filed under anything',
      action: 'top',
    });
  }
  for (const id of tree.order) {
    if (!shown.has(id) || id === projectId) continue;
    const node = tree.byId.get(id);
    const candidate = node?.project;
    if (!candidate) continue;
    if (candidate.id === project.parentId) continue; // already there
    if (!canReparentProject(all, projectId, candidate.id).ok) continue;
    const depth = node?.depth ?? 0;
    items.push({
      label: `${'    '.repeat(depth)}$(folder) ${candidate.name}`,
      description: candidate.hidden === true ? 'closed' : '',
      detail: projectDirs(candidate)[0] ?? '',
      action: 'project',
      payload: candidate.id,
    });
  }

  if (items.length === 0) {
    void vscode.window.showInformationMessage(
      `Canopy: there is nowhere to move "${project.name}" — every other project is inside it.`,
    );
    return false;
  }

  const chosen = await vscode.window.showQuickPick(items, {
    title: `Move ${project.name}`,
    placeHolder: 'File this project under…',
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  if (!chosen) return false;

  const target = chosen.action === 'top' ? null : (chosen.payload ?? null);
  const ok = await deps.setProjectParent(projectId, target);
  if (!ok) {
    void vscode.window.showWarningMessage(
      `Canopy: could not move "${project.name}" there.`,
    );
    return false;
  }
  log('project: moved', project.name, '->', target ?? '(top level)');
  deps.refresh();
  void deps.revealProject(projectId);
  return true;
}

/** The other half, and deliberately question-free: a project coming back
 *  cannot surprise anybody, and the whole feature is worthless if taking
 *  something out of the cupboard costs a dialog too. */
export async function reopenProject(
  deps: CommandDeps,
  project: ProjectRecord,
): Promise<void> {
  await deps.upsertProject(project.id, { hidden: false });
  log('project: opened', project.id, project.name);
  deps.refresh();
  void deps.revealProject(project.id);
}

/**
 * How many sessions are alive in this project right now.
 *
 * Counted off the FOREST rather than the roster, so it counts what the user
 * can currently see under the row — which is what the dialog is telling them
 * they are about to lose sight of. Archived and exited rows are not running
 * and are not counted; a chat is not in the forest at all, and so is not
 * counted either, which is right: a chat has no row to lose.
 */
function runningInProject(deps: CommandDeps, project: ProjectRecord): number {
  const projects = deps.allProjects();
  let count = 0;
  for (const node of deps.getForest().nodes.values()) {
    if (node.archived || node.deleted || node.status === 'exited') continue;
    if (matchProject(projects, node.cwd)?.project.id !== project.id) continue;
    count++;
  }
  return count;
}

/** M26. How many projects are filed under this one, at any depth. */
function subprojectCount(deps: CommandDeps, projectId: string): number {
  const tree = buildProjectTree(deps.allProjects());
  // The subtree includes the project itself, which is not a subproject of
  // itself — hence the -1, and hence 0 for a project that has none.
  return Math.max(0, projectSubtree(tree, projectId).length - 1);
}

/**
 * What a closed project's row says about itself in the history picker.
 *
 * Closing a project removes it from the GROUPING, not from the forest, so the
 * rows it would have shown are all still there to be counted — which is what
 * makes this list worth reading rather than a column of bare names: "the one
 * with four sessions, two of them still going" is how anybody actually
 * identifies a project they put away last week.
 */
function sessionsInProjectLabel(
  deps: CommandDeps,
  project: ProjectRecord,
): string {
  const projects = deps.allProjects();
  let total = 0;
  let running = 0;
  for (const node of deps.getForest().nodes.values()) {
    if (node.deleted) continue;
    if (matchProject(projects, node.cwd)?.project.id !== project.id) continue;
    total++;
    if (!node.archived && node.status !== 'exited') running++;
  }
  if (total === 0) return 'no sessions';
  const sessions = `${total} session${total === 1 ? '' : 's'}`;
  return running > 0 ? `${sessions} · ${running} running` : sessions;
}

async function confirmDeleteProject(
  deps: CommandDeps,
  project: ProjectRecord,
): Promise<boolean> {
  // M26. Deleting a parent does NOT delete its children — they are re-rooted
  // at the top level by the tree builder, which treats a parent pointer at
  // nothing as no pointer at all. Said out loud here because the close verb
  // right above does take the subtree with it, and two neighbouring verbs that
  // differ on that must not leave the user to find out which is which.
  const nested = subprojectCount(deps, project.id);
  const choice = await vscode.window.showWarningMessage(
    `Delete the project "${project.name}"?`,
    {
      modal: true,
      detail: [
        'Only the project grouping is removed. No directory, session or ' +
          'transcript is touched, and its sessions reappear under their ' +
          'folders.',
        nested > 0
          ? `Its ${nested} subproject${nested === 1 ? '' : 's'} ${
              nested === 1 ? 'is' : 'are'
            } kept and ${nested === 1 ? 'moves' : 'move'} to the top level.`
          : '',
      ]
        .filter((t) => t !== '')
        .join('\n\n'),
    },
    'Delete Project',
  );
  if (choice !== 'Delete Project') return false;
  await deps.deleteProject(project.id);
  log('project: deleted', project.id, project.name);
  deps.refresh();
  return true;
}

/** Additive and idempotent: adding a directory a project already covers is a
 *  no-op with a message, not an error and not a duplicate entry. */
async function addDirectoryToProject(
  deps: CommandDeps,
  projectId: string,
  rawDir: string,
): Promise<boolean> {
  const dir = normalizeDir(rawDir);
  if (dir === '') return false;
  const project = deps.getProject(projectId);
  if (!project) return false;

  const dirs = projectDirs(project);
  if (dirs.some((d) => pathKey(d) === pathKey(dir))) {
    void vscode.window.showInformationMessage(
      `"${baseName(dir)}" is already in "${project.name}".`,
    );
    return false;
  }
  await deps.upsertProject(projectId, { dirs: [...dirs.slice(1), dir] });
  log('project:', projectId, 'gained directory', dir);
  deps.refresh();
  return true;
}

/**
 * Open a NEW chat on a project.
 *
 * Split out of the command handler and EXPORTED because everything interesting
 * about the verb happens after the project is known — the ordering of the
 * record write against the launch, the naming, the routing — and none of it
 * needs a workbench. The handler keeps only the quick-pick that picks the
 * project.
 *
 * M24 — ALWAYS NEW, never a resume. M16 shipped one chat per project: the
 * button focused the terminal if it was open, `--resume`d the conversation if
 * it was not, and minted only when there had never been one. Which meant the
 * second question you thought of while the first was still answering had
 * nowhere to go — clicking the button took you back to the conversation you
 * were trying to leave alone, and the only way to have two was to have asked
 * neither.
 *
 * A chat is the cheapest object in this extension: no row, no parent, no name
 * to invent, no place in a lineage. Minting one per click is what the button
 * always should have done, and the ones behind it are a list away
 * (`chatHistory`) instead of a click away.
 */
export async function chatFlow(
  deps: AccountCommandDeps,
  projectId: string,
): Promise<void> {
  const project = deps.getProject(projectId);
  if (!project) return;

  // No pickProjectDirectory: a chat is ABOUT the project, so it always starts
  // at rootDir and reaches the rest through --add-dir. Asking which directory
  // would be asking a question the feature has already answered.
  const dirs = projectDirs(project);
  const cwd = dirs[0];
  if (!cwd) return;

  const sessionId = randomUUID();
  // Numbered from what the project ALREADY has, so two chats never wear the
  // same tab title — the one thing that stops "several chats at once" from
  // being several identical tabs. Ordinal, not a short id: `Chat · api 3` is
  // something you can say out loud, and the id is one hover away in the
  // history list anyway. It is a LABEL and nothing reads it back, so the
  // renumbering that follows a delete costs nothing.
  const ordinal = chatsForProject(deps.allRecords(), deps.allProjects(), project.id)
    .length + 1;
  const title =
    ordinal > 1 ? `Chat · ${project.name} ${ordinal}` : `Chat · ${project.name}`;

  // AWAITED BEFORE THE LAUNCH. The roster poller can see the new transcript
  // within a tick of the CLI starting, and the `chat` flag is the only thing
  // keeping a row from appearing for it — written after the launch, the chat
  // flashes into the tree. `notify: false` because a chat finishing a turn is
  // not something to chase the user about; `launchedByUs` so the usual binding
  // bookkeeping applies. NOT recordLaunch — that one mints tree membership,
  // which is exactly what a chat must not have.
  //
  // `title` is persisted (M24) because it is now the only durable name a chat
  // has: the history picker labels rows with it until the transcript has a
  // first prompt to show instead, and a terminal title dies with its terminal.
  await deps.upsertRecord(sessionId, {
    chat: true,
    cwd,
    title,
    launchedByUs: true,
    notify: false,
  });

  // M22: a NEW conversation routes (project override -> global default ->
  // auto). Every chat is new now, so this is the only branch left — the pin
  // path moved to the history picker, which is where a chat gets resumed.
  const routed = routeNewSession(deps, project.id);

  log('chat:', shortId(sessionId), 'in project', project.name, cwd);
  const binding = await deps.launchSession({
    sessionId,
    cwd,
    title,
    chat: true,
    sessionName: title,
    addDirs: dirs.slice(1),
    appendSystemPrompt: chatSystemPrompt(project, dirs),
    ...launchAccountOptions(routed),
  });
  // M22: a launch that never started is not pinned and not announced. The pin
  // is write-once, so a failed id would hold that account for good, and a
  // status line naming the subscription a chat did not start on is worse than
  // silence.
  if (binding) {
    await pinLaunch(deps, sessionId, routed);
    routed.announce?.();
  } else {
    log('chat: launch failed for', shortId(sessionId));
  }
  // No revealSession and no refresh: there is no row to reveal, and the tree's
  // contents are unchanged by design.
}

/**
 * The chat-history picker: every chat this project has had, newest first.
 *
 * Shaped like the CLI's own `--resume` list on purpose — one row per
 * conversation, what was said first as the label, how long ago on the right —
 * because that is the list people already know how to read, and a chat has
 * exactly the same problem it solves: a conversation with no handle on it.
 *
 * Picking one takes the cheapest route to it that is true:
 *
 *   1. bound in THIS window  -> show the terminal. Nothing is launched.
 *   2. bound in ANOTHER      -> raise that window. Nothing is launched.
 *   3. otherwise             -> `--resume` it here, on its own account pin.
 *
 * The order matters more for a chat than for a session: chats are excluded
 * from the forest, so `resumeFlow`'s "this is still running, fork it instead"
 * guard — which reads the forest — cannot see one. Without the two focus
 * checks above, reopening a chat that is already open would quietly attach a
 * second claude to a transcript the first one is writing.
 */
export async function chatHistoryFlow(
  deps: AccountCommandDeps,
  projectId: string,
): Promise<void> {
  const project = deps.getProject(projectId);
  if (!project) return;

  const chats = chatsForProject(
    deps.allRecords(),
    deps.allProjects(),
    project.id,
  );
  if (chats.length === 0) {
    void vscode.window.showInformationMessage(
      `No chats in "${project.name}" yet — the chat button on its row starts one.`,
    );
    return;
  }

  const now = Date.now();
  const rows = chats
    .map((record) => {
      const facts = deps.transcriptFacts?.(record.id) ?? {};
      const stamped = Date.parse(record.updatedAt ?? record.createdAt ?? '');
      const when =
        facts.lastActiveAt ?? (Number.isFinite(stamped) ? stamped : 0);
      // Liveness is asked of the TIP: a chat resumed once already runs under a
      // newer generation id, and the roster only knows that one.
      const live = deps.isLive?.(deps.tipOf(record.id)) === true;
      return { record, facts, when, live };
    })
    // Transcript activity beats record order: the record only moves when WE
    // write it, so ordering on it alone sorts by "when was this last parked",
    // not by "when did you last talk to it".
    .sort((a, b) => b.when - a.when);

  const picks: SessionPick[] = rows.map(({ record, facts, when, live }) => ({
    // The first thing said, exactly as `--resume` labels its rows, falling
    // back to the tab name the chat was born with. Never the bare id if
    // anything better exists: a list of eight short hex strings is a list you
    // have to open all eight of.
    label: `${live ? '$(circle-filled) ' : ''}${
      firstLine(facts.firstPrompt) ?? record.title ?? shortId(record.id)
    }`,
    description: [when > 0 ? ageLabel(now - when) : '', live ? 'open' : '']
      .filter((s) => s !== '')
      .join(' · '),
    detail: shortId(record.id),
    sessionId: record.id,
  }));

  const chosen = await vscode.window.showQuickPick(picks, {
    title: `Chats · ${project.name}`,
    placeHolder: 'Reopen which chat?',
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  if (!chosen?.sessionId) return;

  // Through the tip, like every other verb that reopens something: a chat that
  // was resumed once already lives under a newer generation id, and the
  // terminal (if any) is bound to THAT one.
  const id = deps.tipOf(chosen.sessionId);
  if (deps.focusSession(id)) return;
  if (await deps.focusWindowFor(id)) return;
  await resumeFlow(deps, id);
}

/** The first line of a prompt, trimmed to something a quick-pick row can hold.
 *  A pasted stack trace is a perfectly ordinary first message and its second
 *  line is never the useful one. */
function firstLine(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const line = text.split('\n').find((l) => l.trim() !== '');
  if (line === undefined) return undefined;
  const trimmed = line.trim();
  return trimmed === '' ? undefined : truncate(trimmed, CHAT_LABEL_LEN);
}

/**
 * Unhide = the exact inverse of hide, so it brings back the TAB as well as
 * ungreying the row.
 *
 * THE INVARIANT: unhiding must never make the row disappear. Hide ended the
 * process, which makes it a closed session — and closed sessions are off by
 * default (`lineage.showArchived`), so merely clearing the flag would drop the
 * row out of the tree, i.e. the precise opposite of what was asked. So a closed
 * session is reopened FIRST and the flag is cleared only once that succeeded; if
 * it cannot be reopened, the flag stays set and the greyed row stays visible.
 *
 * A session that is still running (hidden from a window that never hosted it)
 * has no tab here to restore, so that case is a plain ungrey.
 */
async function closeFlow(
  deps: CommandDeps,
  sessionId: string,
  extra?: Partial<EditorialRecord>,
): Promise<void> {
  const closedTerminal = deps.closeTerminal(sessionId);
  await deps.upsertRecord(sessionId, {
    closed: nowIso(),
    // Only OUR binding is cleared. Nulling it for a session hosted by another
    // window would break that window's cross-window focus until it happens to
    // rebind.
    ...(closedTerminal ? { boundWindowId: null } : {}),
    ...extra,
  });
  log(
    'close:',
    shortId(sessionId),
    closedTerminal ? '(terminal disposed)' : '(no terminal in this window)',
  );
  deps.refresh();
  if (!closedTerminal) {
    // The roster is the liveness truth, so a session we do not host keeps
    // running and its row is unchanged after the refresh. Saying nothing here
    // leaves the user believing a confirmed "Close Session" did something.
    void vscode.window.showWarningMessage(
      'Canopy: this session is not hosted by this window, so it is still ' +
        'running — only the editorial record was marked closed.',
    );
  }
}

// -------------------------------------------------------------- M22 accounts
// The account half of every verb: which subscription a launch lands on, and
// the ten verbs that manage the list itself.
//
// `deps.accounts` is OPTIONAL throughout. A wiring without it (an older host,
// every unit double in test/) behaves exactly as this file did before M22 —
// no environment, no pin, no dialogs — which is what makes the whole feature
// additive rather than a second code path through every launch.

/**
 * The account half of a LaunchOptions, plus the note to show once the launch
 * has actually happened.
 *
 * `announce` is separate from the two option fields because it must not fire
 * for a launch that failed: telling somebody a session started on their work
 * account when no session started is worse than saying nothing.
 */
interface RoutedLaunch {
  env?: Readonly<Record<string, string>>;
  profileId?: string;
  announce?: () => void;
}

/** The LaunchOptions fragment. Spread, so an empty resolution adds no keys at
 *  all and a launch on a machine with no accounts is byte-for-byte the launch
 *  this file made before M22. */
function launchAccountOptions(
  routed: RoutedLaunch,
): { env?: Readonly<Record<string, string>>; profileId?: string } {
  return {
    ...(routed.env !== undefined ? { env: routed.env } : {}),
    ...(routed.profileId !== undefined ? { profileId: routed.profileId } : {}),
  };
}

/** Status-bar only, never a modal: routing is a decision the user asked the
 *  extension to make, so the report belongs where a report belongs. Says the
 *  account and the rule that chose it — the reason string is what makes the
 *  auto-picker inspectable instead of magic. */
function announceAccount(profile: AccountProfile, reason: string): void {
  try {
    vscode.window.setStatusBarMessage(
      `Canopy: ${profile.label}${reason === '' ? '' : ` — ${reason}`}`,
      5000,
    );
  } catch (err) {
    logError('commands.announceAccount', err);
  }
}

/**
 * Which account a NEW session launches on.
 *
 * `forced` is the manual override (the "on this account" verbs) and skips both
 * the resolution and the announcement: the user just picked it, so there is
 * nothing to explain.
 *
 * The announcement fires only when the account the user NAMED is not the one
 * that won, and the winner is not the default account — i.e. only when the
 * extension routed the session somewhere the user did not ask for and that is
 * not simply "whatever this machine is logged in as". Announcing a choice the
 * user made would be telling somebody what they themselves configured, on
 * every launch; staying silent when their choice was DEGRADED (the named
 * account was deleted from another window, or cannot run a session) would land
 * the session on a different subscription without a word, which is the failure
 * the reason string exists for.
 */
function routeNewSession(
  deps: AccountCommandDeps,
  projectId: string | undefined,
  forced?: AccountProfile,
): RoutedLaunch {
  const accts = deps.accounts;
  if (!accts) return {};
  try {
    if (forced) {
      // Belt and braces: every call site asks `refuseUnlaunchable` first and
      // says so out loud. Reaching here anyway means launching with no account
      // rather than pinning a conversation to one it cannot run on.
      if (!canHostSession(forced)) {
        log('accounts: refusing to launch on', forced.id, '- provider cannot host sessions');
        return {};
      }
      return { env: envForProfile(forced), profileId: forced.id };
    }
    const profiles = accts.accounts();
    if (profiles.length === 0) return {};
    const project =
      projectId !== undefined ? deps.getProject(projectId) : undefined;
    const override = project?.routing;
    const globalDefault = accts.defaultRouting();
    const { profile, reason } = resolveRouting(
      override,
      globalDefault,
      profiles,
      accts.usageMap(),
      Date.now(),
    );
    if (!profile) return {};
    // Against the RESOLUTION, never against the request: a project naming an
    // account that no longer resolves gets the note it needs precisely because
    // its choice did not win.
    const requested = override ?? globalDefault;
    const gotWhatTheyNamed =
      requested?.kind === 'account' && requested.id === profile.id;
    return {
      env: envForProfile(profile),
      profileId: profile.id,
      ...(gotWhatTheyNamed || isDefaultAccount(profile)
        ? {}
        : { announce: () => announceAccount(profile, reason) }),
    };
  } catch (err) {
    logError('commands.routeNewSession', err);
    return {};
  }
}

/**
 * The account an EXISTING conversation is pinned to.
 *
 * A missing pin resolves to nothing rather than to a routed guess: a session
 * that launched before accounts existed lives in the default config directory,
 * and handing its resume some other account's environment would point claude
 * at a store that does not contain the conversation. Same for a pin naming an
 * account that has since been deleted, or naming one no session can run on —
 * `routing.pinnedLaunchProfile` returns null for both deliberately, and this
 * passes that through.
 */
function pinnedLaunch(
  deps: AccountCommandDeps,
  sessionId: string,
): RoutedLaunch {
  const accts = deps.accounts;
  if (!accts) return {};
  try {
    const profile = pinnedLaunchProfile(
      accts.sessionProfileId(sessionId),
      accts.accounts(),
    );
    if (!profile) return {};
    return { env: envForProfile(profile), profileId: profile.id };
  } catch (err) {
    logError('commands.pinnedLaunch', err);
    return {};
  }
}

/** Record the pin. Write-once in the store, so calling it on a resume that
 *  already carries one is a no-op rather than a correction. */
async function pinLaunch(
  deps: AccountCommandDeps,
  sessionId: string,
  routed: RoutedLaunch,
): Promise<void> {
  const accts = deps.accounts;
  if (!accts || routed.profileId === undefined) return;
  try {
    await accts.pinSession(sessionId, routed.profileId);
  } catch (err) {
    logError('commands.pinLaunch', err);
  }
}

/** The project a directory belongs to, for routing purposes only. */
function projectIdForCwd(
  deps: CommandDeps,
  cwd: string | undefined,
): string | undefined {
  if (typeof cwd !== 'string' || cwd === '') return undefined;
  try {
    return matchProject(
      deps.allProjects().filter((p) => p.hidden !== true),
      cwd,
    )?.project.id;
  } catch (err) {
    logError('commands.projectIdForCwd', err);
    return undefined;
  }
}

interface AccountPick extends vscode.QuickPickItem {
  accountId: string;
}

interface RoutingPick extends vscode.QuickPickItem {
  /** null = clear the project's override and fall back to the global default.
   *  Distinct from `{ kind: 'auto' }`, which PINS the project to auto. */
  choice: RoutingChoice | null;
}

/** One line of usage for a picker row — the same wording the view's rows use,
 *  so the number does not change spelling between two surfaces. */
function accountPickDescription(
  accts: AccountDeps,
  profile: AccountProfile,
): string {
  const provider = PROVIDERS[profile.provider]?.label ?? profile.provider;
  let usage = '';
  try {
    usage = usageSummaryOf(accts, accts.usage(profile));
  } catch (err) {
    logError('commands.accountPickDescription', err);
  }
  return [provider, usage].filter((s) => s !== '').join(' · ');
}

/**
 * Say no, out loud, to starting a session on an account no session can run on.
 *
 * Out loud because the row is right there and looks like every other row: the
 * user picked a Codex account, and the alternatives to this message are a
 * launch on the wrong subscription (what happens if nobody checks) or a verb
 * that appears to do nothing. Returns true when the launch must NOT proceed.
 */
function refuseUnlaunchable(profile: AccountProfile): boolean {
  if (canHostSession(profile)) return false;
  const provider = PROVIDERS[profile.provider]?.label ?? profile.provider;
  void vscode.window.showWarningMessage(
    `Canopy: "${profile.label}" is a ${provider} account. Canopy starts ` +
      'Claude Code sessions, so it cannot start one there — sign in from ' +
      'that row and use the CLI directly.',
  );
  return true;
}

/** `launchable` restricts the list to accounts a session can actually run on.
 *  Off for the verbs that manage the LIST (sign in, remove, reorder), which
 *  apply to every account this extension knows about. */
async function pickAccount(
  deps: AccountCommandDeps,
  placeHolder: string,
  opts?: { launchable?: boolean },
): Promise<AccountProfile | undefined> {
  const accts = deps.accounts;
  if (!accts) return undefined;
  const all = accts.accounts();
  const profiles =
    opts?.launchable === true ? all.filter(canHostSession) : all;
  if (profiles.length === 0) {
    if (all.length > 0) {
      void vscode.window.showInformationMessage(
        'Canopy: none of your accounts can run a session — Canopy starts ' +
          'Claude Code sessions only.',
      );
      return undefined;
    }
    const ADD = 'Add Account…';
    const choice = await vscode.window.showInformationMessage(
      'Canopy: no AI accounts configured yet.',
      ADD,
    );
    if (choice === ADD) await addAccountFlow(deps);
    return undefined;
  }
  const fallback = accts.defaultRouting();
  const defaultId = fallback?.kind === 'account' ? fallback.id : undefined;
  const items: AccountPick[] = profiles.map((p) => ({
    // Quick-pick labels DO parse codicons, unlike TreeItem descriptions.
    label: p.id === defaultId ? `$(star-full) ${p.label}` : p.label,
    description: accountPickDescription(accts, p),
    accountId: p.id,
  }));
  const chosen = await vscode.window.showQuickPick(items, {
    placeHolder,
    matchOnDescription: true,
    ignoreFocusOut: true,
  });
  if (!chosen) return undefined;
  return accts.getAccount(chosen.accountId);
}

/**
 * Add an account.
 *
 * The config directory is created BEFORE the record, and a failure to create
 * it abandons the whole flow. That is the one hard rule in this verb: a
 * profile with no config directory is the DEFAULT account, so an account that
 * was meant to be isolated and silently is not would sign sessions into
 * whichever login the machine already has — the exact failure this feature
 * exists to prevent, wearing the label of the account you thought you made.
 */
async function addAccountFlow(deps: AccountCommandDeps): Promise<void> {
  const accts = deps.accounts;
  if (!accts) return;

  interface ProviderPick extends vscode.QuickPickItem {
    provider: ProviderId;
    apiKey?: boolean;
  }
  const providerPicks: ProviderPick[] = [
    {
      label: '$(sparkle) Claude',
      description: 'A Claude subscription (Pro, Max, Team)',
      detail:
        'Gets its own config directory, so signing in here does not sign you ' +
        'out anywhere else. One sign-in, once.',
      provider: 'claude',
    },
    {
      label: '$(circuit-board) Codex / OpenAI',
      description: 'A ChatGPT / Codex subscription',
      detail: 'Same, via CODEX_HOME.',
      provider: 'codex',
    },
    {
      label: '$(key) API key…',
      description: 'Authenticate with an environment variable instead',
      detail:
        'For an API key rather than a subscription login. Billed per token.',
      provider: 'generic',
      apiKey: true,
    },
  ];
  const provider = await vscode.window.showQuickPick(providerPicks, {
    placeHolder: 'What kind of account?',
    ignoreFocusOut: true,
  });
  if (!provider) return;

  const existing = accts.accounts();
  const label = await vscode.window.showInputBox({
    title: 'New Account',
    prompt: 'A name for this account — "Work", "Personal", "Client X".',
    ignoreFocusOut: true,
    validateInput: (value) => {
      const refusal = validateAccountLabel(value, existing);
      return refusal === '' ? undefined : refusal;
    },
  });
  if (label === undefined) return;
  const name = label.trim();
  if (validateAccountLabel(name, existing) !== '') return;

  // Against TOMBSTONES as well as live rows: a removed account's id can still
  // be named by the pins of every conversation that ran on it, and handing it
  // to a different kind of account would answer those pins with a different
  // login. The collision suffix costs one character and closes it.
  const id = uniqueAccountId(slugify(name), [
    ...existing.map((p) => p.id),
    ...(accts.allAccountIds?.() ?? []),
  ]);

  let configDir: string | undefined;
  let extraEnv: Record<string, string> | undefined;

  if (provider.apiKey === true) {
    // Two things the user has to be told BEFORE typing a key, because both are
    // irreversible in the way that matters: where it is stored, and what it
    // does to the bill.
    const GO = 'I Understand — Continue';
    const consent = await vscode.window.showWarningMessage(
      'Add an account that authenticates with an API key?',
      {
        modal: true,
        detail:
          "The key is stored in plain text in Canopy's state file (it is " +
          'passed to the CLI as an environment variable, so it cannot be ' +
          'kept anywhere the CLI cannot read). Sessions on this account are ' +
          'billed per token instead of against a subscription.',
      },
      GO,
    );
    if (consent !== GO) return;

    const variable = await vscode.window.showInputBox({
      title: 'API Key Account',
      prompt: 'Which environment variable carries the key?',
      value: 'ANTHROPIC_API_KEY',
      ignoreFocusOut: true,
      validateInput: (value) =>
        isEnvVarName(value.trim())
          ? undefined
          : 'That is not a legal environment variable name.',
    });
    if (variable === undefined) return;
    const key = variable.trim();
    if (!isEnvVarName(key)) return;

    const value = await vscode.window.showInputBox({
      title: 'API Key Account',
      prompt: `Value for ${key}`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) =>
        v.trim() === '' ? 'A value is required.' : undefined,
    });
    // Nothing about the value is logged, echoed or put in a message — here or
    // anywhere downstream of here.
    if (value === undefined || value.trim() === '') return;
    extraEnv = { [key]: value.trim() };
  } else {
    configDir = await accts.createProfileDir(id);
    if (configDir === undefined || configDir === '') {
      void vscode.window.showErrorMessage(
        'Canopy: could not create a config directory for this account, so ' +
          'it was not added — an account without its own directory would ' +
          'share the login you are already signed in as.',
      );
      return;
    }
  }

  await accts.upsertAccount(id, {
    provider: provider.provider,
    label: name,
    ...(configDir !== undefined ? { configDir } : {}),
    ...(extraEnv !== undefined ? { extraEnv } : {}),
  });
  accts.refreshAccounts();
  log('accounts: added', id, provider.provider);

  if (provider.apiKey === true) {
    vscode.window.setStatusBarMessage(`Canopy: added "${name}".`, 4000);
    return;
  }
  const SIGN_IN = 'Sign In Now';
  const choice = await vscode.window.showInformationMessage(
    `Canopy: added "${name}". It has no login of its own yet — sign in ` +
      'once and every session on this account reuses it.',
    SIGN_IN,
  );
  if (choice === SIGN_IN) await loginAccountFlow(deps, id);
}

/** POSIX single-quoting. The binary path is ours, but it can contain spaces,
 *  and the sign-in line is typed into a real shell. */
function shellQuote(s: string): string {
  return `'${s.split("'").join(`'\\''`)}'`;
}

/**
 * Sign an account in: a PLAIN SHELL terminal carrying that account's
 * environment, with the login command typed into it.
 *
 * Deliberately not a session launch. This terminal is not bound to anything,
 * has no session id and never appears in the tree — it exists for the length
 * of one OAuth round trip. The environment is handed to the pty through
 * `creationOptions.env`, never echoed as an `export` line, because on an
 * API-key profile that line would print the credential into the scrollback.
 */
async function loginAccountFlow(
  deps: AccountCommandDeps,
  accountId: string,
): Promise<void> {
  const accts = deps.accounts;
  if (!accts) return;
  const profile = accts.getAccount(accountId);
  if (!profile) return;

  if (Object.keys(profile.extraEnv ?? {}).length > 0) {
    void vscode.window.showInformationMessage(
      `Canopy: "${profile.label}" authenticates with an environment ` +
        'variable — there is no sign-in to complete.',
    );
    return;
  }

  let command: string;
  if (profile.provider === 'claude') {
    const binary = accts.claudeBinary();
    if (!binary) {
      void vscode.window.showErrorMessage(
        'Claude CLI not found — set lineage.claudeBinary to the full path of ' +
          'your claude executable.',
      );
      return;
    }
    // `/login` as the opening turn, the same trick "Fork and Compact" uses to
    // hand the CLI a slash command at start-up.
    command = `${shellQuote(binary)} /login`;
  } else if (profile.provider === 'codex') {
    command = 'codex login';
  } else {
    void vscode.window.showInformationMessage(
      `Canopy: Canopy does not know how to sign "${profile.label}" in — ` +
        'open a terminal and run that CLI’s own login command.',
    );
    return;
  }

  const w: Partial<typeof vscode.window> = vscode.window;
  if (typeof w.createTerminal !== 'function') return;
  const terminal = w.createTerminal({
    name: `Sign in · ${profile.label}`,
    env: envForProfile(profile),
    iconPath: new vscode.ThemeIcon('key'),
  });
  terminal.show();
  terminal.sendText(command);
  log('accounts: sign-in terminal for', profile.id);
}

/**
 * Remove an account from the LIST. Nothing on disk is touched.
 *
 * Said in the dialog rather than implied, because the two are genuinely
 * different operations and only one of them is reversible: the config
 * directory holds a working OAuth token, so re-adding the account picks the
 * same login straight back up — while deleting the directory would mean
 * signing in again, and would strand every session pinned to it.
 */
async function removeAccountFlow(
  deps: AccountCommandDeps,
  accountId: string,
): Promise<void> {
  const accts = deps.accounts;
  if (!accts) return;
  const profile = accts.getAccount(accountId);
  if (!profile) return;

  const REMOVE = 'Remove Account';
  const answer = await vscode.window.showWarningMessage(
    `Remove "${profile.label}" from Canopy?`,
    {
      modal: true,
      detail:
        'Only the list entry goes. The account stays signed in on disk' +
        (typeof profile.configDir === 'string' && profile.configDir !== ''
          ? ` (${profile.configDir})`
          : '') +
        ', so adding it again picks the same login back up. Sessions already ' +
        'running on it are not touched.',
    },
    REMOVE,
  );
  if (answer !== REMOVE) return;

  await accts.deleteAccount(accountId);
  // A default pointing at an account that no longer exists resolves to "the
  // default account is gone" on every single launch. Clearing it here means
  // the cascade falls back to auto silently instead of narrating a stale
  // setting forever.
  const current = accts.defaultRouting();
  if (current?.kind === 'account' && current.id === accountId) {
    await accts.setDefaultRouting(null);
  }
  accts.refreshAccounts();
  log('accounts: removed', accountId);
}

/** Reorder. `moveUp`/`moveDown` return only the entries whose order CHANGED —
 *  an empty list means the move was impossible (already at the end), which is
 *  a no-op and not an error. */
async function moveAccountFlow(
  deps: AccountCommandDeps,
  accountId: string,
  up: boolean,
): Promise<void> {
  const accts = deps.accounts;
  if (!accts) return;
  const profiles = accts.accounts();
  const orders = up ? moveUp(profiles, accountId) : moveDown(profiles, accountId);
  if (orders.length === 0) return;
  for (const entry of orders) {
    await accts.setAccountOrder(entry.id, entry.order);
  }
  accts.refreshAccounts();
}

/**
 * Which account a PROJECT's new sessions launch on.
 *
 * Four kinds of answer, in the order somebody actually thinks about them:
 * auto, any-of-a-provider, one named account, or "stop overriding". The last
 * one is null rather than `{ kind: 'auto' }` — clearing an override and
 * pinning the project to auto look identical today and stop being identical
 * the moment the global default changes.
 */
async function setProjectAccountFlow(
  deps: AccountCommandDeps,
  projectId: string,
): Promise<void> {
  const accts = deps.accounts;
  if (!accts) return;
  const project = deps.getProject(projectId);
  if (!project) return;
  const profiles = accts.accounts();
  if (profiles.length === 0) {
    void vscode.window.showInformationMessage(
      'Canopy: no AI accounts configured yet — add one in the Accounts view.',
    );
    return;
  }
  // The CHOICES are drawn from the accounts a session can run on; the wording
  // of the current setting still reads against the whole list, so a routing
  // choice made before an account changed kind still renders as itself.
  const choosable = profiles.filter(canHostSession);
  if (choosable.length === 0) {
    void vscode.window.showInformationMessage(
      'Canopy: none of your accounts can run a session — Canopy starts ' +
        'Claude Code sessions only.',
    );
    return;
  }

  const current = project.routing;
  const same = (choice: RoutingChoice | null): boolean => {
    if (choice === null) return current === undefined;
    if (!current || current.kind !== choice.kind) return false;
    if (choice.kind === 'account') {
      return current.kind === 'account' && current.id === choice.id;
    }
    if (choice.kind === 'provider') {
      return current.kind === 'provider' && current.provider === choice.provider;
    }
    return true;
  };
  const mark = (choice: RoutingChoice | null): Partial<RoutingPick> =>
    same(choice) ? { picked: true, detail: 'Current setting' } : {};

  const items: RoutingPick[] = [
    {
      label: '$(sparkle) Auto (best of all accounts)',
      description: 'Prefer an open five-hour window, then the soonest weekly reset',
      choice: { kind: 'auto' },
      ...mark({ kind: 'auto' }),
    },
  ];
  for (const id of PROVIDER_IDS) {
    const owned = choosable.filter((p) => p.provider === id);
    if (owned.length === 0) continue;
    const choice: RoutingChoice = { kind: 'provider', provider: id };
    items.push({
      label: `$(layers) Any ${PROVIDERS[id].label} account`,
      description: `${String(owned.length)} account${owned.length === 1 ? '' : 's'}`,
      choice,
      ...mark(choice),
    });
  }
  for (const profile of choosable) {
    const choice: RoutingChoice = { kind: 'account', id: profile.id };
    items.push({
      label: profile.label,
      description: accountPickDescription(accts, profile),
      choice,
      ...mark(choice),
    });
  }
  items.push({
    label: '$(discard) Use the global default',
    description: describeRouting(accts.defaultRouting(), profiles),
    choice: null,
    ...mark(null),
  });

  const chosen = await vscode.window.showQuickPick(items, {
    placeHolder: `Which AI account do new sessions in ${project.name} use?`,
    matchOnDescription: true,
    ignoreFocusOut: true,
  });
  if (!chosen) return;

  await accts.setProjectRouting(projectId, chosen.choice);
  deps.refresh();
  vscode.window.setStatusBarMessage(
    `Canopy: ${project.name} → ${
      chosen.choice === null
        ? 'the global default'
        : describeRouting(chosen.choice, profiles)
    }`,
    4000,
  );
}

// ---------------------------------------------------------- registration

type Handler = (...args: unknown[]) => void | Promise<void>;

/**
 * M22. `CommandDeps` plus the accounts wiring, which is optional because the
 * accounts feature is: a host (or a test) that never wires it gets a file that
 * behaves exactly as it did before this milestone.
 *
 * It stays a separate type rather than an optional member of `CommandDeps`.
 * `AccountDeps` is declared in accountsView.ts — beside the view that is half
 * its implementation — and types.ts may not import a vscode-facing module,
 * since every pure module in the tree imports types.ts. Moving the declaration
 * would work (the interface names no vscode type), but it would put a contract
 * only two vscode-facing files use into the file every module reads. The
 * intersection is the cheaper half of that trade: one alias here, nothing
 * anywhere else.
 */
export type AccountCommandDeps = CommandDeps & { accounts?: AccountDeps };

export function registerCommands(deps: AccountCommandDeps): DisposableLike {
  const disposables: vscode.Disposable[] = [];

  const register = (id: string, human: string, handler: Handler): void => {
    const guarded = async (...args: unknown[]): Promise<void> => {
      try {
        await handler(...args);
      } catch (err) {
        logError(`command ${id}`, err);
        void vscode.window.showErrorMessage(
          `Canopy: ${human} failed — ${errText(err)}`,
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

    // Detach tier: a record naming a tmux session is OURS, running hidden in
    // the private server — a workspace switch parked it, so its tree row is
    // live while no window shows a tab. Focusing it means bringing the tab
    // back: attach (resumeFlow's live guard steps aside for a detached
    // record, and the launch wraps in `new-session -A` under the recorded
    // name). The fork toast below would read as "somebody else owns this",
    // which is exactly wrong here. Works dead-or-alive: a detached session
    // that died while hidden falls through `-A` to its `--resume` argv.
    if (detachedTmuxName(deps, id) !== undefined) {
      await resumeFlow(deps, id);
      return;
    }

    // Nothing here owns a terminal for this session. That is the DEFAULT state
    // for every session the extension did not launch — on a machine already
    // running dozens of sessions elsewhere it is every row in the tree — so a
    // bare "no terminal bound" is a dead end at exactly the wrong moment.
    // Offer the verbs that actually apply instead.
    const node = deps.getForest().nodes.get(id);
    const label = node?.label ?? shortId(id);

    if (node && (node.archived || node.status === 'exited')) {
      const OPEN = 'Open Here';
      const choice = await vscode.window.showInformationMessage(
        `"${label}" is not running.`,
        OPEN,
        'Copy Session ID',
      );
      if (choice === OPEN) await resumeFlow(deps, id);
      else if (choice === 'Copy Session ID') {
        await vscode.env.clipboard.writeText(id);
      }
      return;
    }

    // M25. A native `/fork` parked in a background job: live, unowned, and no
    // pty any editor can attach to — the shape that used to fall all the way
    // through to the "another app or terminal" dead end on a branch the user
    // had just asked for. Adopt it in place: same id, same row, our terminal.
    // Unconditional, no prompt — clicking a fork you just made IS the intent,
    // and the refusals inside adoptBackgroundJob keep it to jobs nobody owns.
    const job = deps.backgroundJob?.(id);
    if (job && (await adoptBackgroundJob(deps, id, job))) return;

    // The last resort, and it must stay rare: every session of OURS is
    // reachable above (bound tab, detached-in-tmux, another Canopy window, or
    // an unowned background job). What remains is a process some other host
    // owns — a plain terminal, another tool — whose live state no editor can
    // adopt. Forking a copy is the one genuine "open" such a session has.
    const FORK = 'Fork Here';
    const choice = await vscode.window.showInformationMessage(
      `"${label}" is running in another app or terminal` +
        (node?.roster?.pid ? ` (pid ${node.roster.pid})` : '') +
        ' that Canopy cannot adopt a tab from. Fork it to branch off a ' +
        'copy you own here.',
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

  // The `+` in the view title. It asks nothing when the window is open on a
  // folder — that folder, or the project owning it, IS the answer — and falls
  // back to the picker only when there is genuinely no window to read it off:
  // no folder open, or a multi-root window with no editor to break the tie.
  register(COMMANDS.newSession, 'new session', async () => {
    const cwd = defaultLaunchFolder(deps);
    if (cwd !== undefined) {
      await newSessionFlow(deps, cwd);
      return;
    }
    const folder = await pickLaunchFolder(deps);
    if (!folder) return;
    await newSessionFlow(deps, folder.cwd);
  });

  // The same verb with the question forced back on, for the one case the
  // default cannot serve: a folder no session has ever run in, in a window
  // open on something else.
  register(COMMANDS.newSessionIn, 'new session in folder', async () => {
    const folder = await pickLaunchFolder(deps);
    if (!folder) return;
    await newSessionFlow(deps, folder.cwd);
  });

  // --------------------------------------------------------------- fork

  register(COMMANDS.forkSession, 'fork session', async (arg?: unknown) => {
    const parentId = await targetSession(deps, arg, 'Fork which session?', {
      liveOnly: false,
    });
    if (!parentId) return;
    await forkFlow(deps, parentId);
  });

  /**
   * Fork, and compact the branch on its way up.
   *
   * The same exact `--fork-session --resume <parent> --session-id <child>` edge
   * as a plain fork — nothing about the lineage differs — with `/compact`
   * handed to the CHILD as its opening turn. Branching and compacting are the
   * two things you do to a conversation that has got long, and doing them
   * separately means picking which one to regret: compact first and you have
   * squashed the history you were about to branch away from; fork first and the
   * branch starts already too full to work in.
   *
   * The compaction runs in the child and only in the child, which is the whole
   * point of doing it here rather than typing `/compact` in the parent: the
   * parent keeps its full history, on disk and in the tree, exactly as it was.
   */
  register(
    COMMANDS.forkAndCompact,
    'fork and compact',
    async (arg?: unknown) => {
      const parentId = await targetSession(
        deps,
        arg,
        'Fork and compact which session?',
        { liveOnly: false },
      );
      if (!parentId) return;
      await forkFlow(deps, parentId, { prompt: COMPACT_PROMPT });
    },
  );

  // REMOVED — `lineage.askSession`, "Ask in a Fork…" (M3–M23).
  //
  // It was a fork whose opening turn came from an input box, and the question
  // it answered is one nothing else in the sidebar asks: a fork already opens
  // a terminal with a cursor in it, so "type the first message HERE instead of
  // THERE" bought a modal and nothing else. What it cost was a third fork verb
  // in every session menu — Fork, Fork and Compact, Ask in a Fork — where two
  // of the three do the same thing to the lineage and only one of them says so.
  //
  // Asking a question about a project is now the CHAT's job (chatInProject),
  // which is where people were reaching anyway: it needs no parent, leaves no
  // row, and you can have as many open at once as you have questions.

  // ------------------------------------------------------------- rename

  /**
   * Inline rename — the F2 keybinding and the right-click entry in the webview
   * sidebar. Asks the view to put an editable input on the row itself, which is
   * how the Explorer renames a file.
   *
   * Falls through to the quick-input rename whenever there is no inline view to
   * do it in: `lineage.viewStyle` is `native`, the panel is closed, or the
   * webview has not finished resolving. A rename verb that silently did nothing
   * would be worse than one that opens in the wrong place.
   */
  register(
    COMMANDS.renameSessionInline,
    'rename session',
    async (arg?: unknown) => {
      const direct = sessionIdFromArg(arg);
      if (await deps.beginInlineRename(direct)) return;
      await vscode.commands.executeCommand(
        COMMANDS.renameSession,
        ...(direct === undefined ? [] : [direct]),
      );
    },
  );

  register(COMMANDS.renameSession, 'rename session', async (arg?: unknown) => {
    const id = await targetSession(deps, arg, 'Rename which session?', {
      liveOnly: false,
    });
    if (!id) return;
    // Same interaction as naming a new branch: current name pre-filled and
    // selected, so Enter keeps it and typing replaces it.
    const title = await askForName(
      labelFor(deps, id),
      'Rename Session',
      'Enter to keep this name, or type a new one',
    );
    if (title === undefined) return;
    await deps.upsertRecord(id, { title });
    // Best-effort: no rename API exists, so this is show(true) + renameWithArg
    // inside the terminals module and can legitimately fail.
    await deps.renameTerminal(id, title);
    deps.refresh();
    void deps.revealSession(id);
  });

  /**
   * The project pair, mirroring the session pair exactly. Two verbs and not one
   * overloaded pair because a project id and a session id are both bare uuids
   * with nothing to tell them apart — see COMMANDS.renameProjectInline.
   */
  register(
    COMMANDS.renameProjectInline,
    'rename project',
    async (arg?: unknown) => {
      const id =
        projectIdFromArg(arg) ??
        (await pickProject(deps, 'Rename which project?', {
          includeHidden: true,
        }));
      if (!id) return;
      if (await deps.beginInlineRenameProject(id)) return;
      await vscode.commands.executeCommand(COMMANDS.renameProject, {
        type: 'project',
        projectId: id,
      });
    },
  );

  register(COMMANDS.renameProject, 'rename project', async (arg?: unknown) => {
    const id =
      projectIdFromArg(arg) ??
      (await pickProject(deps, 'Rename which project?', {
        includeHidden: true,
      }));
    if (!id) return;
    const project = deps.getProject(id);
    if (!project) return;
    // The name is re-validated after the box closes as well as inside it: the
    // box sits there with ignoreFocusOut, and another window can take the name
    // in the meantime.
    const others = deps.allProjects();
    const raw = await vscode.window.showInputBox({
      title: 'Rename Project',
      value: project.name,
      valueSelection: [0, project.name.length],
      ignoreFocusOut: true,
      validateInput: (v) => validateProjectName(v, others, id) || undefined,
    });
    if (raw === undefined) return;
    const name = raw.trim();
    if (validateProjectName(name, deps.allProjects(), id) !== '') return;
    await deps.upsertProject(id, { name });
    deps.refresh();
  });

  // -------------------------------------------------------------- close

  register(COMMANDS.closeSession, 'close session', async (arg?: unknown) => {
    const id = await targetSession(deps, arg, 'Close which session?', {
      liveOnly: false,
    });
    if (!id) return;
    const label = labelFor(deps, id);
    // No confirmation (M14): the row stays in the tree as an inactive session,
    // so a close is always one click from undone — resuming picks up from the
    // last saved turn. A modal in front of a recoverable verb costs more than
    // the mistake it prevents.
    await closeFlow(deps, id);
    vscode.window.setStatusBarMessage(
      `Canopy: closed "${label}" — its row stays in the tree, click it to resume`,
      5000,
    );
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
      `Canopy: asked "${labelFor(deps, id)}" to wrap up`,
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

  // ------------------------------------------------ close / delete (M14)
  //
  // Two verbs on a row, deliberately no third:
  //
  //   CLOSE  ends the TAB. Because the terminal's process IS claude
  //          (shellPath), closing the tab ends the run — but the ROW STAYS in
  //          the tree as an inactive session: transcript on disk, resumable
  //          with one click. Tab state is presentation, not membership.
  //   DELETE removes the ROW and leaves any tab alone. Children are promoted
  //          to the nearest visible ancestor so no lineage is lost. Fully
  //          restorable — a view-level delete, nothing on disk is touched.
  //
  // M8's hide verb (grey the row, sort it last) is retired: rows persisting
  // after close made "put away but keep" exactly what CLOSE does, and the
  // remaining "get it out of the tree" is DELETE. Old hidden records read as
  // deleted (state.sanitizeRecord).

  /**
   * Delete one or more rows, then offer one Undo for the lot.
   *
   * An Undo button rather than a confirmation modal, however many rows there
   * are. The action is view-level and fully reversible — nothing on disk is
   * touched and no process is signalled — so a modal in front of every delete
   * would cost more than the mistake does. But the way back has to be one
   * click, not a command name the user has to know to go looking for, and it
   * has to undo the WHOLE gesture: half a restored selection is a worse state
   * than either end of it.
   */
  const deleteSessionsFlow = async (ids: string[]): Promise<void> => {
    if (ids.length === 0) return;
    // Names read BEFORE the writes, or the message would describe rows that
    // have already left the tree.
    const label = ids.length === 1 ? labelFor(deps, ids[0]) : '';
    // Sequential, not Promise.all: every write goes through the store's own
    // mutation queue anyway, and awaiting each keeps a failure attributable.
    for (const id of ids) await deps.upsertRecord(id, { deleted: true });
    log('delete:', ids.map(shortId).join(' '));
    deps.refresh();

    const UNDO = 'Undo';
    const choice = await vscode.window.showInformationMessage(
      ids.length === 1
        ? `Removed "${label}" from the tree. The session and its transcript are ` +
            'untouched; forks of it moved up to its parent.'
        : `Removed ${ids.length} sessions from the tree. Their transcripts are ` +
            'untouched; forks of them moved up to their parents.',
      UNDO,
    );
    if (choice !== UNDO) return;
    for (const id of ids) await deps.upsertRecord(id, { deleted: false });
    log('delete: undone for', ids.map(shortId).join(' '));
    deps.refresh();
    // Reveal only when there is one row to reveal: scrolling to the last of
    // eight restored rows would name one of them as the interesting one.
    if (ids.length === 1) void deps.revealSession(ids[0]);
  };

  register(COMMANDS.deleteSession, 'delete session', async (arg?: unknown) => {
    const id = await targetSession(deps, arg, 'Delete which session from the tree?', {
      liveOnly: false,
    });
    if (!id) return;
    await deleteSessionsFlow([id]);
  });

  // The multi-selection's own verb. A separate command from the one above
  // because the two say different things in a menu and a contributed command
  // has one title; their `when` clauses are complements of `lineage.multiSelect`
  // so exactly one is ever on a row.
  register(COMMANDS.deleteSessions, 'delete sessions', async (...args: unknown[]) => {
    const ids = selectedSessionIds(deps, args);
    if (ids.length === 0) {
      // Reachable from the palette with nothing selected. Say so rather than
      // opening a picker: this verb means "the rows I have highlighted", and a
      // list to choose from is what Delete Stale Sessions… already is.
      void vscode.window.showInformationMessage(
        'Canopy: select the sessions you want to remove first — shift-click ' +
          'or ctrl-click rows in the tree.',
      );
      return;
    }
    await deleteSessionsFlow(ids);
  });

  register(COMMANDS.restoreSession, 'restore session', async (arg?: unknown) => {
    const direct = sessionIdFromArg(arg);
    const id =
      direct ??
      (await pickFlaggedSession(deps, 'deleted', 'Restore which session?'));
    if (!id) return;
    await deps.upsertRecord(id, { deleted: false });
    log('restore:', shortId(id));
    deps.refresh();
    void deps.revealSession(id);
  });

  register(COMMANDS.deleteStale, 'delete stale sessions', async () => {
    const hours = deps.staleAfterHours();
    const candidates = staleCandidates(
      deps.getForest(),
      hours * 3_600_000,
      Date.now(),
    );
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage(
        'Canopy: nothing in the tree to delete.',
      );
      return;
    }
    const items: (SessionPick & { picked: boolean })[] = candidates.map((c) => ({
      label: c.label,
      description: c.detail,
      ...(c.cwd === undefined ? {} : { detail: c.cwd }),
      sessionId: c.sessionId,
      picked: c.stale,
    }));
    const chosen = await vscode.window.showQuickPick(items, {
      title: `Delete stale sessions — pre-ticked at ${hours}h and older`,
      placeHolder: 'Tick every row to remove from the tree, then press Enter',
      canPickMany: true,
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true,
    });
    // undefined is Escape (do nothing); an EMPTY array is a deliberate
    // "actually, none of these" — also nothing to do, but not an error.
    if (!chosen || chosen.length === 0) return;
    // Sequential, not Promise.all: every write goes through the store's own
    // mutation queue anyway, and awaiting each keeps the failure attributable.
    // The multi-select IS the confirmation. Rows only — a live pick keeps its
    // process and its tab; delete's contract is the tree, never the terminal.
    for (const pick of chosen) {
      await deps.upsertRecord(pick.sessionId, { deleted: true });
    }
    log('delete stale:', String(chosen.length), 'session(s) removed');
    deps.refresh();
    const UNDO = 'Undo';
    const choice = await vscode.window.showInformationMessage(
      `Removed ${chosen.length} stale session${chosen.length === 1 ? '' : 's'} ` +
        'from the tree. Transcripts are untouched — Restore Deleted Session ' +
        'brings any of them back.',
      UNDO,
    );
    if (choice !== UNDO) return;
    for (const pick of chosen) {
      await deps.upsertRecord(pick.sessionId, { deleted: false });
    }
    log('delete stale: undone');
    deps.refresh();
  });


  // ------------------------------------------------------------- projects

  register(COMMANDS.openProject, 'open project', async (arg?: unknown) => {
    const projectId = projectIdFromArg(arg);
    if (projectId) {
      const project = deps.getProject(projectId);
      const dir = project
        ? await pickProjectDirectory(project, 'Open which directory in a new window?')
        : undefined;
      if (!dir) return;
      await deps.openProject(dir, true);
      return;
    }
    const refusal = unknownGroupRefusal(arg);
    if (refusal !== '') {
      void vscode.window.showInformationMessage(refusal);
      return;
    }
    const cwd = groupCwdFromArg(arg) ?? (await pickOpenableFolder(deps));
    if (!cwd) return;
    await deps.openProject(cwd, true);
  });

  register(COMMANDS.newProject, 'new project', async () => {
    await newProjectFlow(deps);
  });

  // M26 — the two nesting verbs. Both take a project row's argument shape and
  // both fall back to a picker, so each is equally usable from the palette
  // (where a subproject of nothing is the one thing they must not create —
  // hence the pick, not a silent top-level project).
  register(COMMANDS.newSubproject, 'new subproject', async (arg?: unknown) => {
    const parentId =
      projectIdFromArg(arg) ??
      (await pickProject(deps, 'Create a subproject inside which project?'));
    if (!parentId) return;
    if (!deps.getProject(parentId)) return;
    await newProjectFlow(deps, { parentId });
  });

  register(COMMANDS.moveProject, 'move project', async (arg?: unknown) => {
    const id =
      projectIdFromArg(arg) ??
      (await pickProject(deps, 'Move which project?', { includeHidden: true }));
    if (!id) return;
    await moveProjectFlow(deps, id);
  });

  // M24 — the open/close pair. Two verbs and not one toggle, for the reason
  // every other pair in this manifest is two (the bell, the active filter): a
  // contributed command has one title and one icon, and "Close Project" on a
  // project that is already closed is a menu entry that lies about what it is
  // about to do. Their `when` clauses are complements — close is on the row,
  // open is at the top of the view, because a closed project HAS no row.
  register(COMMANDS.closeProject, 'close project', async (arg?: unknown) => {
    const id =
      projectIdFromArg(arg) ?? (await pickProject(deps, 'Close which project?'));
    if (!id) return;
    const project = deps.getProject(id);
    if (!project) return;
    if (project.hidden === true) {
      void vscode.window.showInformationMessage(
        `"${project.name}" is already closed.`,
      );
      return;
    }
    await closeProjectFlow(deps, project);
  });

  /**
   * The project history: every closed project, most recently touched first.
   *
   * The list IS the feature. A closed project has no row, so without a place
   * that enumerates them a close is indistinguishable from a delete — you
   * would have to remember that you closed something, and its name, to ever
   * see it again. Sorted by `updatedAt` so the one you closed last (and are
   * most likely reaching back for) is the one under the cursor.
   */
  register(COMMANDS.reopenProject, 'reopen project', async () => {
    const closed = deps
      .allProjects()
      .filter((p) => p.hidden === true)
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    if (closed.length === 0) {
      void vscode.window.showInformationMessage(
        'Canopy: no closed projects — every project you have is already in the tree.',
      );
      return;
    }
    const items: ActionPick[] = closed.map((p) => ({
      label: `$(archive) ${p.name}`,
      description: sessionsInProjectLabel(deps, p),
      detail: projectDirs(p).join('  ·  '),
      action: 'project',
      payload: p.id,
    }));
    const chosen = await vscode.window.showQuickPick(items, {
      title: 'Closed projects',
      placeHolder: 'Open which project?',
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true,
    });
    if (!chosen?.payload) return;
    const project = deps.getProject(chosen.payload);
    if (!project) return;
    await reopenProject(deps, project);
  });

  register(
    COMMANDS.projectFromFolder,
    'make project from folder',
    async (arg?: unknown) => {
      const cwd = groupCwdFromArg(arg);
      if (!cwd) {
        await newProjectFlow(deps);
        return;
      }
      // The folder is already on screen with sessions in it, so its own path is
      // the main directory and its basename the name stem — which skips the
      // directory picker entirely and goes straight to the extras list.
      await newProjectFlow(deps, { rootDir: cwd, name: baseName(cwd) });
    },
  );

  register(
    COMMANDS.configureProject,
    'configure project',
    async (arg?: unknown) => {
      const id =
        projectIdFromArg(arg) ??
        (await pickProject(deps, 'Configure which project?', {
          includeHidden: true,
        }));
      if (!id) return;
      await configureProjectFlow(deps, id);
    },
  );

  register(COMMANDS.deleteProject, 'delete project', async (arg?: unknown) => {
    const id =
      projectIdFromArg(arg) ??
      (await pickProject(deps, 'Delete which project?', { includeHidden: true }));
    if (!id) return;
    const project = deps.getProject(id);
    if (!project) return;
    await confirmDeleteProject(deps, project);
  });

  register(
    COMMANDS.addProjectDirectory,
    'add directory to project',
    async (arg?: unknown) => {
      const id =
        projectIdFromArg(arg) ??
        (await pickProject(deps, 'Add a directory to which project?'));
      if (!id) return;
      const project = deps.getProject(id);
      if (!project) return;
      const dir = await pickDirectory(
        'Add to Project',
        `Add a directory to ${project.name}`,
      );
      if (!dir) return;
      await addDirectoryToProject(deps, id, dir);
    },
  );

  register(
    COMMANDS.newSessionInProject,
    'new session in project',
    async (arg?: unknown) => {
      const id =
        projectIdFromArg(arg) ??
        (await pickProject(deps, 'Start a session in which project?'));
      if (!id) return;
      await newSessionInProjectFlow(deps, id);
    },
  );

  // M20 — the branch chips. One click starts a session in a specific WORKTREE
  // of a project, which is the whole point of the strip: `+` on the project row
  // has to guess a directory and guesses rootDir, and for somebody running one
  // agent per worktree that is the checkout they least often mean.
  //
  // The directory arrives already resolved (webtree.ts looks it up in the model
  // it rendered rather than trusting a path from the page) but is re-validated
  // here anyway, because this is a registered command: the palette, a keybinding
  // and another extension can all reach it with an argument nobody vetted.
  register(
    COMMANDS.newSessionInBranch,
    'new session in branch',
    async (arg?: unknown) => {
      const parsed = branchArgOf(arg);
      if (!parsed) return;
      const project = deps.getProject(parsed.projectId);
      if (!project) return;

      // The directory must be one the CURRENT grouping reports for this
      // project. A worktree deleted between render and click, or a path made up
      // by a caller, both land here and both get nothing — never a shell spawned
      // somewhere the tree never showed.
      const known = deps
        .getBranches(parsed.projectId)
        .find((b) => pathKey(b.dir) === pathKey(parsed.dir));
      if (!known) {
        void vscode.window.showWarningMessage(
          `Canopy: ${parsed.branch || 'that branch'} is no longer a worktree of ${project.name}.`,
        );
        return;
      }

      // Named for the BRANCH, not the project: on a project whose chips are
      // showing, "app 3" tells you nothing and "feat/x 2" tells you everything.
      // The counter is scoped to the whole project so two branches never
      // produce the same name.
      const title = nextFreeName(
        known.name,
        namesUnder(deps, [...projectDirs(project), known.dir]),
      );

      // M22: a worktree belongs to the project whose chip row it came from, so
      // the routing question is already answered — no directory lookup.
      const routed = routeNewSession(deps, project.id);

      const sessionId = randomUUID();
      await deps.recordLaunch(sessionId, null, known.dir);
      await deps.upsertRecord(sessionId, { title });
      log('new:', shortId(sessionId), 'on branch', known.name, known.dir);
      const binding = await deps.launchSession({
        sessionId,
        cwd: known.dir,
        title,
        ...launchAccountOptions(routed),
      });
      if (!binding) {
        log('new: launch failed for', shortId(sessionId));
        return;
      }
      await pinLaunch(deps, sessionId, routed);
      routed.announce?.();
      deps.refresh();
      void deps.revealSession(sessionId);
      await nameJustCreatedSession(deps, sessionId);
    },
  );

  // M20 branch curation. Every one of these resolves the branch against the
  // grouping the VIEW rendered (deps.getBranches) rather than trusting the
  // argument, for the same reason newSessionInBranch does: a registered command
  // can be reached from the palette, a keybinding, or another extension, and
  // the only directories this feature may ever touch are the ones git reported
  // for a project the user created.

  register(COMMANDS.hideBranch, 'hide branch', async (arg?: unknown) => {
    const parsed = branchArgOf(arg);
    if (!parsed) return;
    const known = deps
      .getBranches(parsed.projectId)
      .find((b) => b.name === parsed.branch);
    if (!known) return;
    // The primary branch is not hideable. It is the one checkout every
    // repository has, the fallback when a worktree is removed, and the anchor a
    // block reduced to nothing would have to be repaired from — and the repair
    // lives behind "Others", which is itself only discoverable while the block
    // has a row on screen.
    if (known.primary) {
      void vscode.window.showInformationMessage(
        `Canopy: ${known.name} is the repository's main worktree and stays in the list.`,
      );
      return;
    }
    await deps.setBranchShown(parsed.projectId, known.name, false);
    deps.refresh();
  });

  register(COMMANDS.showBranches, 'show branches', async (arg?: unknown) => {
    const id =
      projectIdFromArg(arg) ??
      (await pickProject(deps, 'Show branches in which project?'));
    if (!id) return;
    const project = deps.getProject(id);
    if (!project) return;
    const branches = deps.getBranches(id);
    const hidden = branches.filter((b) => !b.shown);
    if (hidden.length === 0) {
      void vscode.window.showInformationMessage(
        `Canopy: every branch in ${project.name} is already shown.`,
      );
      return;
    }

    // Multi-select, and pre-ticked with nothing: this picker is reached from a
    // row that says "Others (12)", so the question it answers is "which of
    // these do I want to see", not "here is your current state, edit it". A
    // pre-ticked list would also make OK-with-no-changes ambiguous.
    const picks = await vscode.window.showQuickPick(
      hidden.map((b) => ({
        label: b.name,
        description:
          b.rootIds.length > 0
            ? `${b.rootIds.length} session${b.rootIds.length === 1 ? '' : 's'}`
            : '',
        detail: b.dir,
        branch: b.name,
      })),
      {
        canPickMany: true,
        title: `Branches not shown in ${project.name}`,
        placeHolder: 'Pick the branches to add to the list',
      },
    );
    if (!picks || picks.length === 0) return;
    for (const pick of picks) {
      await deps.setBranchShown(id, pick.branch, true);
    }
    deps.refresh();
  });

  register(COMMANDS.foldBranches, 'fold branches', async (arg?: unknown) => {
    const id = projectIdFromArg(arg);
    if (!id) return;
    await deps.setBranchesCollapsed(id, true);
    deps.refresh();
  });

  register(COMMANDS.unfoldBranches, 'unfold branches', async (arg?: unknown) => {
    const id = projectIdFromArg(arg);
    if (!id) return;
    await deps.setBranchesCollapsed(id, false);
    deps.refresh();
  });

  register(COMMANDS.revealBranch, 'reveal branch', async (arg?: unknown) => {
    const parsed = branchArgOf(arg);
    if (!parsed) return;
    const known = deps
      .getBranches(parsed.projectId)
      .find((b) => pathKey(b.dir) === pathKey(parsed.dir));
    if (!known) return;
    try {
      await vscode.commands.executeCommand(
        'revealFileInOS',
        vscode.Uri.file(known.dir),
      );
    } catch (err) {
      logError('commands.revealBranch', err);
    }
  });

  register(COMMANDS.copyBranchName, 'copy branch name', async (arg?: unknown) => {
    const parsed = branchArgOf(arg);
    // The name off the ARGUMENT, not re-resolved: copying a string to the
    // clipboard touches nothing, so the re-resolution the spawning verbs need
    // would only make the verb fail on a branch that had just been removed.
    if (!parsed || parsed.branch === '') return;
    await copyToClipboard(parsed.branch, `Copied ${parsed.branch}`);
  });

  register(COMMANDS.copyBranchPath, 'copy branch path', async (arg?: unknown) => {
    const parsed = branchArgOf(arg);
    if (!parsed) return;
    await copyToClipboard(parsed.dir, 'Copied worktree path');
  });

  // M16 — the chat. Deliberately NOT a session verb: a chat has no row, no
  // name to confirm, no directory to pick and no reveal afterwards. Always at
  // the project's rootDir with the extra directories added.
  //
  // M24: every click is a NEW chat (see chatFlow), and the ones before it are
  // in `chatHistory` rather than behind the same button.
  register(COMMANDS.chatInProject, 'chat in project', async (arg?: unknown) => {
    const id =
      projectIdFromArg(arg) ?? (await pickProject(deps, 'Chat in which project?'));
    if (!id) return;
    await chatFlow(deps, id);
  });

  register(COMMANDS.chatHistory, 'chat history', async (arg?: unknown) => {
    const id =
      projectIdFromArg(arg) ??
      (await pickProject(deps, "Whose chats do you want to see?", {
        includeHidden: true,
      }));
    if (!id) return;
    await chatHistoryFlow(deps, id);
  });

  // ----------------------------------------------------------- visibility

  register(COMMANDS.hideFolder, 'hide folder', async (arg?: unknown) => {
    const refusal = unknownGroupRefusal(arg);
    if (refusal !== '') {
      void vscode.window.showInformationMessage(refusal);
      return;
    }
    const cwd = groupCwdFromArg(arg) ?? (await pickHideableFolder(deps));
    if (!cwd) return;
    // A folder covered by a project would come straight back on the next
    // tick, so say why instead of writing a hide that does nothing.
    const owning = matchProject(
      deps.allProjects().filter((p) => p.hidden !== true),
      cwd,
    );
    if (owning) {
      const CONFIGURE = 'Configure Project…';
      const choice = await vscode.window.showWarningMessage(
        `"${baseName(cwd)}" belongs to the project "${owning.project.name}", ` +
          'so hiding the folder would have no effect. Remove the directory ' +
          'from the project, or hide the project itself.',
        CONFIGURE,
      );
      if (choice === CONFIGURE) {
        await configureProjectFlow(deps, owning.project.id);
      }
      return;
    }
    await deps.hideFolder(cwd);
    log('hide folder:', cwd);
    deps.refresh();
    vscode.window.setStatusBarMessage(
      `Canopy: hid ${baseName(cwd)} — restore it with "Canopy: Show Hidden…"`,
      4000,
    );
  });

  // Still lists closed projects as well as hidden folders, and deliberately:
  // this is the "what have I put away" door, and a user who does not yet know
  // about the Open Project button has to be able to find a project from it.
  // M24 only changed what the rows are CALLED — a project is closed, a folder
  // is hidden, and the two menus must not describe one flag two ways.
  register(COMMANDS.showHidden, 'show hidden', async () => {
    const folders = deps.hiddenFolders();
    const projects = deps.allProjects().filter((p) => p.hidden === true);
    if (folders.length === 0 && projects.length === 0) {
      void vscode.window.showInformationMessage(
        'Canopy: nothing is put away — every folder and project is in the tree.',
      );
      return;
    }
    const items: ActionPick[] = [
      ...projects.map((p) => ({
        label: `$(archive) ${p.name}`,
        description: 'closed project',
        detail: projectDirs(p).join('  ·  '),
        action: 'project',
        payload: p.id,
      })),
      ...folders.map((f) => ({
        label: `$(folder) ${baseName(f.path)}`,
        description: f.path,
        action: 'folder',
        payload: f.path,
      })),
    ];
    const chosen = await vscode.window.showQuickPick(items, {
      title: 'Put away — closed projects and hidden folders',
      placeHolder: 'Bring which one back?',
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true,
    });
    if (!chosen?.payload) return;
    if (chosen.action === 'project') {
      await deps.upsertProject(chosen.payload, { hidden: false });
    } else {
      await deps.unhideFolder(chosen.payload);
    }
    log('unhide:', chosen.action, chosen.payload);
    deps.refresh();
  });

  // -------------------------------------------------- notifications (M12)

  const MARK_ALL_SENTINEL = '__lineage_mark_all__';

  // `buttons` comes from QuickPickItem itself — the row's × lands there.
  type NotificationPick = SessionPick & { markAll?: boolean };

  /**
   * The bell's rows, built from the current model. Re-derived rather than
   * cached, because the list is rebuilt in place after every dismissal — the
   * whole point of the × is that the row goes away while the popup stays open.
   *
   * Separators divide unseen from already-seen the way cmux divides its
   * popover. The mock (and a slim host) may not ship QuickPickItemKind — then
   * the list is simply undivided.
   */
  const notificationPicks = (
    items: readonly NotificationItem[],
    now: number,
  ): NotificationPick[] => {
    const picks: NotificationPick[] = [];
    const separatorKind: number | undefined = (
      vscode as unknown as { QuickPickItemKind?: { Separator?: number } }
    ).QuickPickItemKind?.Separator;
    const pushSeparator = (label: string): void => {
      if (separatorKind === undefined) return;
      picks.push({
        label,
        kind: separatorKind,
        sessionId: '',
      } as unknown as NotificationPick);
    };

    const unseen = items.filter((i) => i.unseen);
    const seenOnes = items.filter((i) => !i.unseen);
    const rowOf = (i: NotificationItem): NotificationPick => {
      const age =
        i.doneAt !== undefined ? ageLabel(now - Date.parse(i.doneAt)) : '';
      const what =
        i.status === 'waiting'
          ? `waiting${i.waitingFor ? `: ${i.waitingFor}` : ''}`
          : 'done';
      const pick: NotificationPick = {
        label: `${i.unseen ? '$(circle-filled) ' : ''}${i.label}`,
        description: [what, age].filter((s) => s !== '').join(' · '),
        detail: i.projectName !== undefined ? `in ${i.projectName}` : undefined,
        sessionId: i.sessionId,
      };
      // The × (M18). Item buttons only exist on a QuickPick built with
      // createQuickPick — showQuickPick has no event to report one — so this is
      // set unconditionally and the fallback path below simply ignores it.
      const button = dismissButton();
      if (button !== undefined) pick.buttons = [button];
      return pick;
    };
    if (unseen.length > 0) {
      pushSeparator('new');
      picks.push(...unseen.map(rowOf));
    }
    if (seenOnes.length > 0) {
      pushSeparator('seen');
      picks.push(...seenOnes.map(rowOf));
    }
    if (unseen.length > 0) {
      pushSeparator('');
      picks.push({
        label: '$(check-all) Mark all as read',
        description: `${unseen.length} unseen`,
        sessionId: MARK_ALL_SENTINEL,
        markAll: true,
      });
    }
    return picks;
  };

  /** The × on a bell row, or undefined on a host with no ThemeIcon (the unit
   *  mock's `vscode` has the class but a slim host may not). A button without a
   *  glyph is an invisible hit target, so no button at all is the better
   *  degradation. */
  const dismissButton = (): vscode.QuickInputButton | undefined => {
    try {
      if (typeof vscode.ThemeIcon !== 'function') return undefined;
      return {
        iconPath: new vscode.ThemeIcon('close'),
        tooltip: 'Remove from this list',
      };
    } catch {
      return undefined;
    }
  };

  /**
   * Take one session off the bell without touching the session itself.
   *
   * Two writes, and both are needed: `markSeen` puts the attention dot out,
   * and `notifyDismissedAt` is what keeps the row off the list afterwards —
   * an item qualifies for the bell on `doneAt` alone, so marking it seen would
   * leave it sitting in the "seen" section forever. Dismissal is per FINISH,
   * not permanent: the next turn this session completes stamps a newer `doneAt`
   * and the row comes straight back, which is the difference between "I have
   * dealt with this one" and "never tell me about this session again" (that is
   * what Mute is for).
   */
  const dismissNotification = async (sessionId: string): Promise<void> => {
    await deps.markSeen(sessionId);
    await deps.upsertRecord(sessionId, { notifyDismissedAt: nowIso() });
    log('notifications: dismissed', shortId(sessionId));
    deps.refresh();
  };

  /** The pre-M18 popup, kept for a host without `createQuickPick`: same rows,
   *  same verbs, no × (item buttons need the object-shaped API). */
  const showNotificationsSimple = async (
    picks: NotificationPick[],
    unseenCount: number,
  ): Promise<void> => {
    const chosen = await vscode.window.showQuickPick(picks, {
      title: 'Finished sessions',
      placeHolder:
        unseenCount > 0
          ? `${unseenCount} session${unseenCount === 1 ? '' : 's'} finished since you last looked`
          : 'Everything has been seen',
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true,
    });
    if (!chosen || chosen.sessionId === '') return;
    if (chosen.markAll === true) {
      await vscode.commands.executeCommand(COMMANDS.markAllNotificationsRead);
      return;
    }
    await deps.markSeen(chosen.sessionId);
    deps.refresh();
    await vscode.commands.executeCommand(COMMANDS.focusSession, chosen.sessionId);
  };

  const showNotificationsFlow = async (): Promise<void> => {
    const readItems = (): NotificationItem[] =>
      notificationItems(
        deps.getForest(),
        deps.allRecords(),
        deps.allProjects(),
      );
    const items = readItems();
    if (items.length === 0) {
      void vscode.window.showInformationMessage(
        deps.notificationsEnabled()
          ? 'Canopy: no finished sessions yet — a session appears here when it completes a turn.'
          : 'Canopy: notifications are off — enable `lineage.notifications.enabled` to track finished sessions.',
      );
      return;
    }

    const picks = notificationPicks(items, Date.now());
    const unseenCount = items.filter((i) => i.unseen).length;

    // `createQuickPick` is the only API that reports a click on an ITEM's
    // button, which is what the × is. Absent (the unit mock, a slim host) the
    // list still opens, just without the per-row remove.
    const host: Partial<typeof vscode.window> = vscode.window;
    if (typeof host.createQuickPick !== 'function') {
      await showNotificationsSimple(picks, unseenCount);
      return;
    }

    const quickPick = host.createQuickPick<NotificationPick>();
    quickPick.title = 'Finished sessions';
    quickPick.placeholder =
      unseenCount > 0
        ? `${unseenCount} session${unseenCount === 1 ? '' : 's'} finished since you last looked`
        : 'Everything has been seen';
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    quickPick.ignoreFocusOut = true;
    quickPick.items = picks;

    // Resolves when the popup is finished with, whichever way it ended. The
    // verb that follows an accepted row (focus the session, possibly switching
    // windows) deliberately runs AFTER the popup is disposed rather than from
    // inside the event handler — raising another window while a quick input is
    // still open leaves the input orphaned on the old one.
    await new Promise<void>((resolve) => {
      let picked: NotificationPick | undefined;
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };

      quickPick.onDidTriggerItemButton((event) => {
        const id = event.item?.sessionId;
        if (typeof id !== 'string' || !isSessionId(id)) return;
        void (async () => {
          try {
            await dismissNotification(id);
            const left = readItems();
            if (left.length === 0) {
              // Nothing to come back to: closing IS the answer, and an empty
              // popup with a placeholder is a worse one.
              quickPick.hide();
              return;
            }
            // Rebuilt in place, so the popup stays open and the user can carry
            // on clearing rows — which is the whole reason the × exists rather
            // than a "dismiss which one?" second menu.
            quickPick.items = notificationPicks(left, Date.now());
          } catch (err) {
            logError('command show notifications (dismiss)', err);
          }
        })();
      });

      quickPick.onDidAccept(() => {
        picked = quickPick.selectedItems[0];
        quickPick.hide();
      });

      quickPick.onDidHide(() => {
        quickPick.dispose();
        void (async () => {
          try {
            const chosen = picked;
            if (!chosen || chosen.sessionId === '') return;
            if (chosen.markAll === true) {
              await vscode.commands.executeCommand(
                COMMANDS.markAllNotificationsRead,
              );
              return;
            }
            // Opening the row IS looking at it — mark first, so the dot is out
            // even if the focus lands in another window.
            await deps.markSeen(chosen.sessionId);
            deps.refresh();
            await vscode.commands.executeCommand(
              COMMANDS.focusSession,
              chosen.sessionId,
            );
          } catch (err) {
            logError('command show notifications', err);
          } finally {
            finish();
          }
        })();
      });

      quickPick.show();
    });
  };

  register(COMMANDS.showNotifications, 'show notifications', showNotificationsFlow);
  // The bell-dot twin: same verb, second id, because a contributed command has
  // exactly one icon and the bell must light up when something is unseen.
  register(
    COMMANDS.showNotificationsUnread,
    'show notifications',
    showNotificationsFlow,
  );

  register(
    COMMANDS.markAllNotificationsRead,
    'mark all notifications read',
    async () => {
      const items = notificationItems(
        deps.getForest(),
        deps.allRecords(),
        deps.allProjects(),
        Number.MAX_SAFE_INTEGER,
      ).filter((i) => i.unseen);
      for (const item of items) await deps.markSeen(item.sessionId);
      deps.refresh();
      vscode.window.setStatusBarMessage(
        `Canopy: marked ${items.length} session${items.length === 1 ? '' : 's'} as read`,
        3000,
      );
    },
  );

  /**
   * The per-session mute (M19), as a SET rather than a toggle.
   *
   * Two commands with complementary `when` clauses (`;silenced;` / `;notified;`
   * on the row's context value), because one entry reading "Mute / Unmute
   * Notifications" cannot tell you which way it is about to go — and the row
   * already knows, so the menu should say. Setting rather than toggling is what
   * makes the palette path honest too: from there the answer is picked out of a
   * list, with no row to have read a state off.
   */
  const setSessionNotify = async (
    arg: unknown,
    on: boolean,
  ): Promise<void> => {
    const id = await targetSession(
      deps,
      arg,
      on ? 'Show notifications for which session?' : 'Hide notifications for which session?',
      { liveOnly: false },
    );
    if (!id) return;
    await deps.upsertRecord(id, { notify: on });
    deps.refresh();
    vscode.window.setStatusBarMessage(
      on
        ? `Canopy: notifications shown for "${labelFor(deps, id)}"`
        : `Canopy: notifications hidden for "${labelFor(deps, id)}" — no dot, no bell entry`,
      4000,
    );
  };

  register(
    COMMANDS.muteSessionNotifications,
    'hide session notifications',
    (arg?: unknown) => setSessionNotify(arg, false),
  );
  register(
    COMMANDS.unmuteSessionNotifications,
    'show session notifications',
    (arg?: unknown) => setSessionNotify(arg, true),
  );

  // ------------------------------------------------ the active-only filter
  //
  // A view-title switch, and therefore two commands: a contributed button
  // carries one icon and one title, so each position of the switch needs its
  // own id and they take turns on `lineage.onlyActive`. Neither reads the
  // setting — each one knows the value it means — and the state the user reads
  // back is the icon itself.

  register(COMMANDS.showOnlyActiveSessions, 'show only active sessions', async () => {
    await deps.setOnlyActiveSessions(true);
    vscode.window.setStatusBarMessage(
      'Canopy: showing only active sessions — closed ones are filtered out, not deleted',
      4000,
    );
  });

  register(COMMANDS.showAllSessions, 'show all sessions', async () => {
    await deps.setOnlyActiveSessions(false);
    vscode.window.setStatusBarMessage('Canopy: showing closed sessions too', 4000);
  });

  // ------------------------------------------------------ workspaces (M13)

  register(COMMANDS.switchWorkspace, 'switch workspace', async (arg?: unknown) => {
    const direct = projectIdFromArg(arg);
    if (direct) {
      await deps.switchWorkspace(direct);
      return;
    }
    const active = deps.activeWorkspace();
    const projects = deps.allProjects().filter((p) => p.hidden !== true);
    if (projects.length === 0) {
      void vscode.window.showInformationMessage(
        'Canopy: no projects yet — a workspace is a project\'s saved window ' +
          'layout. Create one with "Canopy: New Project…".',
      );
      return;
    }
    const items: ActionPick[] = projects.map((p) => ({
      label: `$(project) ${p.name}`,
      description: [
        p.id === active ? 'active' : '',
        projectDirs(p)[0] ?? '',
      ]
        .filter((s) => s !== '')
        .join(' · '),
      action: 'switch',
      payload: p.id,
    }));
    if (active !== null) {
      items.push({
        label: '$(clear-all) Leave Workspace Mode',
        description: 'Stop scoping this window; nothing is closed',
        action: 'leave',
      });
    }
    const chosen = await vscode.window.showQuickPick(items, {
      title: 'Switch Workspace',
      placeHolder:
        'Only the chosen project\'s tabs stay open; the current layout is saved first',
      matchOnDescription: true,
      ignoreFocusOut: true,
    });
    if (!chosen) return;
    if (chosen.action === 'leave') {
      await deps.switchWorkspace(null);
      return;
    }
    if (chosen.payload) await deps.switchWorkspace(chosen.payload);
  });

  // ------------------------------------------- the Explorer follows (M21)
  //
  // Both verbs RELOAD the window — that is what `vscode.openFolder` on the
  // current window means — so both confirm first, modally. This is the one
  // place in Canopy where a reload is the correct answer rather than the
  // thing being designed around: converting a plain folder window into a
  // multi-root workspace (or back) cannot be done in place at all, and the
  // whole point of paying it once is that every project switch afterwards is
  // a folder splice that costs nothing. Session tabs come back the way they
  // come back from any reload — tmux-wrapped ones reattach, the rest resume.

  register(COMMANDS.followInExplorer, 'set up Explorer following', async () => {
    const follow = deps.followInExplorer;
    if (!follow || !deps.explorerAnchored) {
      void vscode.window.showInformationMessage(
        'Canopy: this build cannot repoint the Explorer.',
      );
      return;
    }
    if (deps.explorerAnchored()) {
      void vscode.window.showInformationMessage(
        'Canopy: the Explorer already follows the active project in this ' +
          'window.',
      );
      return;
    }
    const go = 'Convert and Reload';
    const answer = await vscode.window.showWarningMessage(
      'Make the Explorer follow the active project?',
      {
        modal: true,
        detail:
          'This window becomes a Canopy workspace, which takes one reload ' +
          'now. After that, switching projects swaps the Explorer instantly ' +
          "— the project's main directory on top, any extra connected " +
          'directories as their own roots below it — without reloading and ' +
          'without losing a session.',
      },
      go,
    );
    if (answer !== go) return;
    await follow.call(deps);
  });

  register(
    COMMANDS.stopFollowingInExplorer,
    'stop Explorer following',
    async () => {
      const stop = deps.stopFollowingInExplorer;
      if (!stop || !deps.explorerAnchored) return;
      if (!deps.explorerAnchored()) {
        void vscode.window.showInformationMessage(
          'Canopy: the Explorer does not follow the active project in this ' +
            'window.',
        );
        return;
      }
      const go = 'Reopen as a Folder';
      const answer = await vscode.window.showWarningMessage(
        'Stop following the active project in the Explorer?',
        {
          modal: true,
          detail:
            "This window reopens on the active project's main directory as " +
            'an ordinary folder, which takes one reload. Projects, sessions ' +
            'and saved layouts are untouched.',
        },
        go,
      );
      if (answer !== go) return;
      await stop.call(deps);
    },
  );

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
    if (state.installed === true) {
      // Installing the plugin only makes Claude WRITE the events file. The
      // reader is gated on `lineage.hooks.enabled`, which defaults to false
      // and which nothing else ever sets — so without this the marquee
      // instant-update feature stays inert after a successful install, no
      // event is ever read, and the ndjson grows unbounded (the size cap lives
      // in the watcher). Installing IS the opt-in; the user already consented
      // through a modal that named every file.
      await deps.setHooksEnabled(true);
    }
    await syncHookContext(state.installed === true);
    log('hooks: install ->', state.installed ? 'installed' : 'not installed');
  });

  register(COMMANDS.removeHooks, 'remove hooks', async () => {
    if (!deps.getHookState().installed) {
      void vscode.window.showInformationMessage(
        'Canopy: instant-update hooks are not installed.',
      );
      await syncHookContext(false);
      return;
    }
    const state = await deps.removeHooks();
    if (state.installed !== true) await deps.setHooksEnabled(false);
    await syncHookContext(state.installed === true);
    log('hooks: remove ->', state.installed ? 'still installed' : 'removed');
  });

  // ------------------------------------------------------------ accounts
  //
  // Every one of these is a no-op without the accounts wiring rather than an
  // error: the commands are contributed unconditionally (a `when` clause hides
  // the view, not the palette), so a host with the feature turned off must
  // simply do nothing rather than report a failure the user cannot act on.

  /** The account a row verb was invoked on, or a picked one for the palette. */
  const targetAccount = async (
    arg: unknown,
    placeHolder: string,
  ): Promise<AccountProfile | undefined> => {
    const accts = deps.accounts;
    if (!accts) return undefined;
    const id = accountIdOf(arg);
    if (id !== undefined) {
      const found = accts.getAccount(id);
      if (found) return found;
    }
    return pickAccount(deps, placeHolder);
  };

  register(COMMANDS.addAccount, 'add account', async () => {
    await addAccountFlow(deps);
  });

  register(COMMANDS.loginAccount, 'sign in', async (arg?: unknown) => {
    const profile = await targetAccount(arg, 'Sign in to which account?');
    if (!profile) return;
    await loginAccountFlow(deps, profile.id);
  });

  register(
    COMMANDS.removeAccount,
    'remove account',
    async (arg?: unknown) => {
      const profile = await targetAccount(arg, 'Remove which account?');
      if (!profile) return;
      await removeAccountFlow(deps, profile.id);
    },
  );

  register(
    COMMANDS.setDefaultAccount,
    'set default account',
    async (arg?: unknown) => {
      const accts = deps.accounts;
      if (!accts) return;
      const profile = await targetAccount(
        arg,
        'Which account do new sessions use by default?',
      );
      if (!profile) return;
      // A default nothing can launch on is a setting that degrades on every
      // single new session. Refused where it is asked for, not at launch time.
      if (refuseUnlaunchable(profile)) return;
      await accts.setDefaultRouting({ kind: 'account', id: profile.id });
      accts.refreshAccounts();
      vscode.window.setStatusBarMessage(
        `Canopy: new sessions default to ${profile.label}.`,
        4000,
      );
    },
  );

  register(
    COMMANDS.moveAccountUp,
    'move account up',
    async (arg?: unknown) => {
      const id = accountIdOf(arg);
      if (id === undefined) return;
      await moveAccountFlow(deps, id, true);
    },
  );

  register(
    COMMANDS.moveAccountDown,
    'move account down',
    async (arg?: unknown) => {
      const id = accountIdOf(arg);
      if (id === undefined) return;
      await moveAccountFlow(deps, id, false);
    },
  );

  register(
    COMMANDS.refreshAccountUsage,
    'refresh account usage',
    async () => {
      const accts = deps.accounts;
      if (!accts) return;
      // Forced: this verb exists precisely for the moment the cached numbers
      // are not believed.
      await accts.refreshUsage(accts.accounts(), true);
      accts.refreshAccounts();
    },
  );

  // The manual override: one session, on the account whose row you clicked,
  // still pinned for life like every other launch.
  register(
    COMMANDS.newSessionFromAccount,
    'new session on this account',
    async (arg?: unknown) => {
      const profile = await targetAccount(arg, 'Start a session on which account?');
      if (!profile) return;
      // The row verb reaches every row — the menu's `when` cannot tell a Codex
      // row from a Claude one — so the refusal lives here, where it can say
      // which account and why.
      if (refuseUnlaunchable(profile)) return;
      const cwd = defaultLaunchFolder(deps);
      if (cwd !== undefined) {
        await newSessionFlow(deps, cwd, profile);
        return;
      }
      const folder = await pickLaunchFolder(deps);
      if (!folder) return;
      await newSessionFlow(deps, folder.cwd, profile);
    },
  );

  // The same override from the other end: a project row, then the account.
  register(
    COMMANDS.newSessionFromPicker,
    'new session from account',
    async (arg?: unknown) => {
      const id =
        projectIdFromArg(arg) ??
        (await pickProject(deps, 'Start a session in which project?'));
      if (!id) return;
      const project = deps.getProject(id);
      if (!project) return;
      const profile = await pickAccount(
        deps,
        `Start a session in ${project.name} on which account?`,
        { launchable: true },
      );
      if (!profile) return;
      await newSessionInProjectFlow(deps, id, profile);
    },
  );

  register(
    COMMANDS.setProjectAccount,
    'set project account',
    async (arg?: unknown) => {
      const id =
        projectIdFromArg(arg) ??
        (await pickProject(deps, 'Set the AI account for which project?'));
      if (!id) return;
      await setProjectAccountFlow(deps, id);
    },
  );

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
