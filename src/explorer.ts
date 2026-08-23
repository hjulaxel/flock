// src/explorer.ts — the Explorer follows the project.
//
// THE FEATURE: switching projects in the Flock sidebar swaps what the
// built-in Explorer shows. Not a Flock-flavoured file tree in our own
// container — THE Explorer, with its real folder tree, its Outline and its
// Timeline.
//
// HOW MUCH it shows is `ExplorerScope`. By default ONE root: the directory
// being worked in, so the file tree reads like a plain folder window that
// happens to follow you. `'project'` scope is the older shape — every connected
// directory as its own collapsible root, the main one on top — and the two
// differ only in what `desiredFolders` returns; every splice below is identical.
//
// HOW, AND WHY THIS SHAPE:
//
// The Explorer's folder tree is `workspace.workspaceFolders` — there is no API
// to reroot it and no `when` clause an extension may put on
// `workbench.explorer.fileView`. So the only way to move it is to mutate the
// folder list, and there are exactly two ways to do that:
//
//   * `vscode.openFolder` — reloads the window. That restarts the extension
//     host and kills every terminal, which is the one thing the whole
//     terminal-survival design exists to avoid. Never used here (surfaces.ts
//     owns that verb, for window-per-project).
//   * `workspace.updateWorkspaceFolders` — an in-place splice. The API doc
//     names TWO cases that terminate and restart the extension host:
//       1. the FIRST workspace folder is added, removed or changed (the
//          deprecated `rootPath` has to be repointed), and
//       2. transitioning from an empty or single-folder workspace into a
//          multi-folder one.
//     Neither is a property of splicing as such. Both are avoidable, and this
//     module is built entirely around avoiding them.
//
// THE ANCHOR is what avoids them. The window runs a real multi-root
// `.code-workspace` whose folder[0] is a directory Flock owns and NEVER
// touches. Case 2 is gone at the first frame (the workspace is already
// multi-root when it opens) and case 1 is gone by construction (every splice
// this module emits starts at index >= 1 — `planSplice` cannot express one that
// does not, and `syncFolders` refuses outright if folder[0] has stopped being
// the anchor). The cost is one permanently visible root row, which is why it
// points at an empty directory: expanding it shows nothing.
//
// THE ANCHOR IS THE HEADER. Renaming a workspace folder through the API means
// removing and re-adding it, and for folder[0] that is case 1 above — so that
// road is closed. But the folder list is not only reachable through the API:
// the `.code-workspace` file on disk is the same list, VS Code watches it, and
// rewriting `folders[0].name` there is a rename that never goes through
// `updateWorkspaceFolders` at all. So the anchor carries the ACTIVE PROJECT's
// name, and the row we were paying for anyway becomes the caption that says
// which project the tree below it is: no empty "Flock" decoy, and the
// directory roots go back to being labelled by their own directories.
//
// That on-disk rename is the one part of this module resting on OBSERVED
// rather than DOCUMENTED behaviour — nothing promises VS Code applies an
// external `folders[0].name` edit in place. It degrades safely: the label is
// written, and if the workbench ignores it (or restarts) the header view in
// src/projectview.ts is still there saying the same thing. `anchorLabel()` is
// what lets the wiring tell which of the two happened — see
// CONTEXT_EXPLORER_FOLLOW.
//
// PURE ON PURPOSE: no `vscode` import. Everything the workbench provides
// arrives through `ExplorerHost`, the same shape WorkspaceManagerDeps uses, so
// the splice arithmetic — the part that is actually easy to get wrong — is unit
// tested without a workbench.

import { baseName, normalizeDir, pathKey, projectDirs } from './projects';
import { log, logError } from './log';
import type { ProjectRecord } from './types';

// ------------------------------------------------------------------ shapes

/** One workspace folder, in the form both the workspace file and
 *  `updateWorkspaceFolders` accept. `name` is the label the Explorer paints on
 *  the root row; absent means "use the directory's own basename". */
export interface FolderSpec {
  path: string;
  name?: string;
}

/**
 * How much of the active project the Explorer shows.
 *
 * `'directory'` — ONE root: the directory being worked in. A project with three
 * connected directories is still three directories, but the file tree is the one
 * you are in, the way a plain folder window is the folder you opened. Which one
 * that is comes from the active session's cwd (see `matchProject`), so the tree
 * follows attention rather than needing a verb.
 *
 * `'project'` — every connected directory as its own collapsible root, which is
 * what this module did before the setting existed and what the `.code-workspace`
 * shape has always been able to express.
 *
 * The DEFAULT HERE IS `'project'` — absent host support means "behave as
 * before". The product's default is `'directory'`, set in package.json; the two
 * differ on purpose, so a host wiring that predates the setting (and every unit
 * double) is unaffected by it.
 */
export type ExplorerScope = 'directory' | 'project';

/** Narrowing input for {@link desiredFolders}. */
export interface DesiredFoldersOptions {
  /** Defaults to `'project'` — see {@link ExplorerScope}. */
  scope?: ExplorerScope;
  /** The directory being worked in, under `'directory'` scope. Ignored under
   *  `'project'` scope, and an unknown or empty value falls back to the
   *  project's main directory. */
  currentDir?: string;
}

/** A splice, in `updateWorkspaceFolders(start, deleteCount, ...add)` terms.
 *  `start` is ALWAYS >= 1: see the anchor note at the top of the file. */
export interface FolderSplice {
  start: number;
  deleteCount: number;
  add: FolderSpec[];
}

/** What one `syncFolders` call did. Everything except `spliced` is a no-op —
 *  they are distinguished so the caller can log the reason rather than leave
 *  the user with an Explorer that silently stopped following. */
export type SyncOutcome =
  | 'spliced' // folders changed
  | 'unchanged' // already showing exactly this
  | 'not-anchored' // this window is not a Flock workspace; feature is off
  | 'rejected'; // the host refused the splice (see log)

/** The workbench surface this module needs. Implemented in extension.ts over
 *  `vscode.workspace`; doubled in tests. */
export interface ExplorerHost {
  /** Workspace folders as the window currently has them, in order. */
  folders(): FolderSpec[];
  /** `workspace.updateWorkspaceFolders`. False when the host rejected the
   *  arguments outright — which it does for a duplicate URI, hence
   *  `desiredFolders` deduping before we ever get here. */
  splice(start: number, deleteCount: number, add: readonly FolderSpec[]): boolean;
  /** Resolve when the host reports the folder list settled (its
   *  `onDidChangeWorkspaceFolders`), or after `timeoutMs`, whichever is first.
   *  The API forbids a second `updateWorkspaceFolders` before that event, so
   *  this is what makes back-to-back switches safe. */
  awaitFolderChange(timeoutMs: number): Promise<void>;
  /** Optional existence probe. A directory that fails is dropped rather than
   *  added as one of the Explorer's greyed-out missing roots — a project's
   *  `dirs` outlive the directories they name. Absent means "add them all",
   *  which is always correct and merely uglier. */
  exists?(path: string): Promise<boolean>;
  /** Rewrite `folders[0].name` in the `.code-workspace` file ON DISK — the one
   *  way to relabel the anchor without the remove-and-re-add that restarts the
   *  extension host. Optional: absent means the anchor keeps whatever label it
   *  was created with, and the header view carries the project name instead. */
  renameAnchor?(name: string): Promise<void>;
  /** How much of the project to show, read FRESH on every sync so the setting
   *  takes effect without a reload. Optional: absent means `'project'`, which is
   *  what this module did before the setting existed. */
  scope?(): ExplorerScope;
}

/** How long a splice waits for the host's folder-change event before giving up
 *  and letting the next one through. A splice that never reports back must not
 *  wedge every future switch. */
export const FOLDER_CHANGE_TIMEOUT_MS = 2_000;

/** The anchor's label when no project is active — the only time it is not the
 *  project's own name. Deliberately the product name: it is a permanent row,
 *  and a row the user cannot explain is worse than a row that is redundant. */
export const ANCHOR_LABEL = 'Flock';

/** Basename of the workspace file Flock generates, inside globalStorage. */
export const WORKSPACE_FILE_NAME = 'lineage.code-workspace';
/** Basename of the anchor directory, inside globalStorage. Stays EMPTY. */
export const ANCHOR_DIR_NAME = 'anchor';

// ------------------------------------------------------------------- pure

/** Is folder[0] the anchor? Every splice is gated on this: if the user added a
 *  folder above ours, or opened a different workspace entirely, index 1 no
 *  longer means what this module thinks it means and we do nothing at all. */
export function isAnchored(
  folders: readonly FolderSpec[],
  anchorPath: string,
): boolean {
  const anchor = normalizeDir(anchorPath);
  if (anchor === '') return false;
  const first = folders[0];
  if (!first) return false;
  return pathKey(normalizeDir(first.path)) === pathKey(anchor);
}

/**
 * The window's REAL folders: the workspace folder list with the anchor
 * removed, order kept.
 *
 * The anchor is Flock's own — an empty directory in globalStorage that exists
 * only to hold folder[0] so splices never restart the extension host (see the
 * header) — so it must never count as something this window "opened": nothing
 * runs in it, nothing is under it, and any consumer that treats it as a real
 * root gets a nonsense answer (folder mode scoping a converted window to it
 * rendered zero sessions; windowForDir routing on it made the window
 * unreachable). This module owns the anchor's identity, so this is where the
 * question "which folders are actually the user's?" is answered — every other
 * file asks it rather than re-deriving the anchor path comparison.
 *
 * Matching is by path identity ANYWHERE in the list, not just index 0: a
 * window whose user rearranged folders above the anchor is degraded (splices
 * are off, see isAnchored) but its real folders are still its real folders.
 */
export function nonAnchorFolders(
  anchorPath: string,
  folders: readonly string[],
): string[] {
  const anchorKey = pathKey(normalizeDir(anchorPath));
  const out: string[] = [];
  for (const raw of folders ?? []) {
    const dir = normalizeDir(raw);
    if (dir === '') continue;
    if (anchorKey !== '' && pathKey(dir) === anchorKey) continue;
    out.push(raw);
  }
  return out;
}

/**
 * The folder rows a project should occupy, in Explorer order: main directory
 * first, extras below. Never includes the anchor.
 *
 * NAMING. Every root is labelled by its OWN directory. The project's name is
 * not repeated down here because the anchor above already carries it — and a
 * root labelled "Magma Web" sitting directly under a row labelled "Magma Web"
 * reads as a duplicate rather than as a caption and its contents. What the
 * directory rows answer is "where does it live", which is their basename.
 *
 * DEDUPE is not cosmetic: `updateWorkspaceFolders` returns false for a folder
 * list containing the same URI twice, so one repeated directory would silently
 * cost the user the entire splice. `projectDirs` already dedupes a project's
 * own list; the anchor is excluded here because a project pointed at it (odd,
 * but reachable) would collide with folder[0].
 */
export function desiredFolders(
  project: ProjectRecord | undefined | null,
  anchorPath: string,
  opts: DesiredFoldersOptions = {},
): FolderSpec[] {
  if (!project) return [];
  const anchorKey = pathKey(normalizeDir(anchorPath));
  const all: FolderSpec[] = [];
  const seen = new Set<string>();
  for (const dir of projectDirs(project)) {
    const key = pathKey(dir);
    if (key === anchorKey || seen.has(key)) continue;
    seen.add(key);
    // `baseName` is empty for a filesystem root, which would render an
    // unlabelled row; the path itself is the honest fallback.
    all.push({ path: dir, name: baseName(dir) || dir });
  }
  if ((opts.scope ?? 'project') === 'project') return all;
  return narrowToCurrent(all, opts.currentDir, anchorKey);
}

/**
 * The single root `'directory'` scope shows: the one being worked in, or the
 * project's main directory when nothing better is known.
 *
 * A `currentDir` the project does not LIST is still honoured, because the
 * common way to get one is the case worth honouring — a linked git worktree of
 * a repository the project sits in. `matchProject` hands a project every
 * checkout of every repository its directories are in, so a session in
 * `~/app-feat-x` belongs to the project at `~/app` without anybody registering
 * that path; rooting the Explorer at `~/app` while the user works in
 * `~/app-feat-x` would show them a tree they are not editing.
 *
 * The anchor is refused for the same reason `desiredFolders` excludes it: a
 * duplicate URI makes the workbench reject the entire splice.
 */
function narrowToCurrent(
  all: readonly FolderSpec[],
  currentDir: string | undefined,
  anchorKey: string,
): FolderSpec[] {
  const wanted = normalizeDir(currentDir ?? '');
  if (wanted !== '' && pathKey(wanted) !== anchorKey) {
    const listed = all.find(
      (f) => pathKey(normalizeDir(f.path)) === pathKey(wanted),
    );
    if (listed) return [listed];
    return [{ path: wanted, name: baseName(wanted) || wanted }];
  }
  // Directory number one, which is the honest answer to "which directory am I
  // in" before anything has told us otherwise. Empty for a project with no
  // directories at all, exactly as `'project'` scope would be.
  return all.length > 0 ? [all[0]!] : [];
}

/** The anchor's label for a given project: its name, or the product name when
 *  the window is scoped to nothing. Trimmed and non-empty by construction — an
 *  empty `name` makes VS Code fall back to the anchor DIRECTORY's basename,
 *  which is the literal string "anchor". */
export function anchorLabelFor(project: ProjectRecord | undefined | null): string {
  const name = typeof project?.name === 'string' ? project.name.trim() : '';
  return name === '' ? ANCHOR_LABEL : name;
}

/** Two rows are the same row when they name the same directory under the same
 *  label. A label-only change still has to splice — that is how a renamed
 *  project reaches the Explorer. */
function sameFolder(a: FolderSpec, b: FolderSpec): boolean {
  return (
    pathKey(normalizeDir(a.path)) === pathKey(normalizeDir(b.path)) &&
    (a.name ?? '') === (b.name ?? '')
  );
}

/**
 * The minimal splice turning `current` into `[anchor, ...desired]`, or null
 * when the Explorer already shows exactly that.
 *
 * MINIMAL MATTERS. The obvious implementation replaces the whole tail on every
 * switch, which tears down and rebuilds roots that were not going to change —
 * and a rebuilt root comes back COLLAPSED, losing wherever the user had
 * scrolled and expanded to. Trimming the common prefix means switching between
 * two projects that share a directory leaves that directory's tree alone.
 *
 * `current` is the FULL folder list (anchor included); the returned `start` is
 * therefore never below 1, which is the invariant the whole module rests on.
 */
export function planSplice(
  current: readonly FolderSpec[],
  desired: readonly FolderSpec[],
): FolderSplice | null {
  const tail = current.slice(1);
  let i = 0;
  while (i < tail.length && i < desired.length && sameFolder(tail[i]!, desired[i]!)) {
    i += 1;
  }
  if (i === tail.length && i === desired.length) return null;
  return {
    start: 1 + i,
    deleteCount: tail.length - i,
    add: desired.slice(i),
  };
}

/** The generated `.code-workspace`, as text. Written once, at opt-in; VS Code
 *  itself rewrites the `folders` array on every splice from then on. Settings
 *  are left empty on purpose — this file becomes the window's settings root,
 *  and Flock putting opinions in it would quietly outrank the user's own
 *  folder settings. */
export function workspaceFileJson(
  anchorPath: string,
  tail: readonly FolderSpec[],
  anchorName: string = ANCHOR_LABEL,
): string {
  const folders = [
    { path: normalizeDir(anchorPath), name: anchorName },
    ...tail.map((f) => ({ path: normalizeDir(f.path), name: f.name })),
  ];
  return `${JSON.stringify({ folders, settings: {} }, null, 2)}\n`;
}

/**
 * The same file with `folders[0].name` replaced — the surgical edit
 * `ExplorerHost.renameAnchor` applies. Takes and returns TEXT because the file
 * belongs to VS Code, which rewrites it on every splice: everything except the
 * one field is round-tripped exactly as found, so a path VS Code rewrote to be
 * workspace-relative stays relative and a key it reordered stays reordered.
 *
 * Returns null when the file cannot be parsed or has no folders — a
 * `.code-workspace` may legally carry comments, and clobbering a file we could
 * not read is worse than leaving a row mislabelled.
 */
export function withAnchorName(text: string, name: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const folders = (parsed as { folders?: unknown }).folders;
  if (!Array.isArray(folders) || folders.length === 0) return null;
  const first = folders[0];
  if (typeof first !== 'object' || first === null) return null;
  if ((first as { name?: unknown }).name === name) return text;
  (first as { name?: unknown }).name = name;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

// ------------------------------------------------------------------ driver

/**
 * Keeps the Explorer's folder list pointed at the active project.
 *
 * Calls are SERIALISED. `updateWorkspaceFolders` may not be called again
 * before its change event has fired, and a switch can easily be followed by
 * another one before the workbench has caught up — focus-follows-project fires
 * on terminal focus, which a restore moves around. An unserialised second call
 * is not merely dropped, it is undefined behaviour.
 */
export class ExplorerSync {
  private readonly host: ExplorerHost;
  private readonly anchorPath: string;
  /** Tail of the promise chain every sync appends itself to. */
  private queue: Promise<unknown> = Promise.resolve();
  /** So a window that is not anchored says so once, not once per switch. */
  private warnedNotAnchored = false;

  constructor(host: ExplorerHost, anchorPath: string) {
    this.host = host;
    this.anchorPath = normalizeDir(anchorPath);
  }

  /** Is this window a Flock workspace — i.e. can the Explorer follow at all?
   *  Drives the header view's `when` clause and the opt-in command's wording. */
  anchored(): boolean {
    try {
      return isAnchored(this.host.folders(), this.anchorPath);
    } catch (err) {
      logError('explorer.anchored', err);
      return false;
    }
  }

  /**
   * The label the WORKBENCH is currently painting on the anchor row — read
   * back from the live folder list, not from what we last wrote.
   *
   * That difference is the whole point. Writing `folders[0].name` to disk is a
   * rename VS Code is not documented to apply in place, so the only way to know
   * whether the anchor is doing the header's job is to ask what it actually
   * says. When this equals the active project's name the header view is
   * redundant and hides itself; when it does not, the view stays and says it
   * instead.
   */
  anchorLabel(): string {
    try {
      return this.host.folders()[0]?.name ?? '';
    } catch (err) {
      logError('explorer.anchorLabel', err);
      return '';
    }
  }

  /** The scope the HOST reports right now. Read per sync rather than cached so
   *  flipping the setting takes effect on the next switch, and defaulting to
   *  `'project'` so a host that does not implement it behaves as before. */
  private scope(): ExplorerScope {
    try {
      return this.host.scope?.() ?? 'project';
    } catch (err) {
      logError('explorer.scope', err);
      return 'project';
    }
  }

  /**
   * Point the Explorer at `project` (null clears the tail back to the anchor
   * alone). Never throws, never rejects: a switch must not fail because the
   * file tree would not move.
   *
   * `currentDir` is the directory being worked in. It decides the single root
   * under `'directory'` scope and is ignored under `'project'` scope, so every
   * caller may pass it without knowing which is configured.
   */
  async sync(
    project: ProjectRecord | null,
    currentDir?: string,
  ): Promise<SyncOutcome> {
    const run = async (): Promise<SyncOutcome> => {
      try {
        return await this.syncOnce(project, currentDir);
      } catch (err) {
        logError('explorer.sync', err);
        return 'rejected';
      }
    };
    // Append to the chain and hand back THIS link, so callers await their own
    // splice. `.then(run, run)` rather than `.finally` — a rejected predecessor
    // must not skip the successor or poison the chain.
    const next = this.queue.then(run, run);
    this.queue = next;
    return next;
  }

  private async syncOnce(
    project: ProjectRecord | null,
    currentDir?: string,
  ): Promise<SyncOutcome> {
    const current = this.host.folders();
    if (!isAnchored(current, this.anchorPath)) {
      if (!this.warnedNotAnchored) {
        this.warnedNotAnchored = true;
        log(
          'explorer: this window is not a Flock workspace (folder[0] is not ' +
            'the anchor) — the Explorer will not follow the active project. ' +
            'Run "Flock: Follow the Active Project in the Explorer" to set ' +
            'one up.',
        );
      }
      return 'not-anchored';
    }
    this.warnedNotAnchored = false;

    const desired = await this.filterMissing(
      desiredFolders(project, this.anchorPath, {
        scope: this.scope(),
        currentDir,
      }),
    );
    const plan = planSplice(current, desired);
    if (plan === null) {
      log('explorer: folders already match', project?.name ?? '(none)');
      // Still relabel: a project can be RENAMED without its directories
      // changing, and that rename has to reach the anchor row somehow.
      await this.applyAnchorLabel(project);
      return 'unchanged';
    }

    log(
      `explorer: splice at ${plan.start} — remove ${plan.deleteCount}, ` +
        `add ${plan.add.length} [${plan.add.map((f) => f.name ?? baseName(f.path)).join(', ')}]`,
    );
    const ok = this.host.splice(plan.start, plan.deleteCount, plan.add);
    if (!ok) {
      // The host validates before applying, so this is an argument problem —
      // a duplicate URI is the only one reachable from here — and no event is
      // coming. Returning without waiting keeps the queue moving.
      logError(
        'explorer.splice',
        new Error('the workbench rejected the folder update'),
      );
      return 'rejected';
    }
    await this.host.awaitFolderChange(FOLDER_CHANGE_TIMEOUT_MS);
    // AFTER the splice has settled, never before. VS Code persists the folder
    // list to the workspace file when it applies a splice, and it writes from
    // its own in-memory model — a label written ahead of that write is a label
    // the workbench immediately overwrites with the one it still remembers.
    await this.applyAnchorLabel(project);
    return 'spliced';
  }

  /**
   * Point the anchor row's label at the active project, by rewriting
   * `folders[0].name` in the workspace file.
   *
   * Compared against the LIVE label rather than against what we last wrote, so
   * a workbench that ignores the on-disk rename is re-attempted on every
   * switch rather than silently written off after the first — and a workbench
   * that applies it stops writing the file at all once the two agree.
   */
  private async applyAnchorLabel(project: ProjectRecord | null): Promise<void> {
    const rename = this.host.renameAnchor;
    if (!rename) return;
    const target = anchorLabelFor(project);
    if (this.anchorLabel() === target) return;
    try {
      await rename.call(this.host, target);
      log('explorer: anchor label ->', target);
    } catch (err) {
      logError('explorer.renameAnchor', err);
    }
  }

  /** Drop directories that no longer exist, when the host can tell us. A
   *  project's `dirs` outlive the directories they name (a cleared worktree, an
   *  unmounted volume), and a missing root is a permanent error row in the
   *  Explorer rather than an absence. */
  private async filterMissing(specs: FolderSpec[]): Promise<FolderSpec[]> {
    const probe = this.host.exists;
    if (!probe) return specs;
    const out: FolderSpec[] = [];
    for (const spec of specs) {
      let present = true;
      try {
        present = await probe.call(this.host, spec.path);
      } catch (err) {
        // An unreadable path is not a missing one — a permissions error must
        // not silently drop a directory the user can still see.
        logError('explorer.exists', err);
        present = true;
      }
      if (present) out.push(spec);
      else log('explorer: skipping missing directory', spec.path);
    }
    return out;
  }
}
