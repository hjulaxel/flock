// src/modes.ts — which of the two window models this window lives in.
//
// `lineage.mode` names a choice about what a WINDOW is:
//
//   * FOLDER mode (the default) — native VS Code. A window IS the folder you
//     opened, the way every other extension assumes. The tree scopes itself to
//     sessions under that folder, the switch verbs and the workspace status-bar
//     item disappear, and workspaces.ts's save/clear/restore machinery never
//     runs. Working on another project means going to (or opening) that
//     project's WINDOW — never rearranging this one.
//   * PROJECT mode — one window spanning many projects, switched
//     transactionally by workspaces.ts. The pre-mode behaviour, kept for the
//     users who live that way, still additionally gated by the older
//     `lineage.workspaces.enabled`.
//
// Why the default flipped to folder: the 84-detached-sessions incident
// (design/levels-and-modes.md) was a direct product of in-window switching —
// every switch put a project's sessions into an invisible running state. The
// levels work made that state honest (grace countdown, then level 2), but the
// mode that never switches in place cannot produce it at all, and "window =
// folder" is what VS Code users already believe their window means.
//
// PURE, in the shape chatAutoClose.ts established: this module decides, the
// wiring in extension.ts / commands.ts reads the world (settings, the opened
// folder, the window roster) and acts on the answers. No vscode import — every
// rule here is unit-testable without a workbench.

import { isWithin, normalizeDir, pathKey } from './projects';
import type { ProjectMatch } from './projects';
import type { WindowRecord } from './types';

export type LineageMode = 'folder' | 'project';

/** The shipped default. See the header for why it is `folder` even though the
 *  switcher used to be on by default: the mode that cannot park is the mode
 *  that cannot reproduce the incident. */
export const DEFAULT_MODE: LineageMode = 'folder';

/**
 * `lineage.mode` as read from configuration, defensively: anything that is not
 * the literal string `'project'` — a typo, an old value, undefined — reads as
 * the default. Falling back to `folder` on garbage is the safe direction: the
 * worst a wrong `folder` does is hide a switch verb, where a wrong `project`
 * would let a switch rearrange a window the user thinks of as a plain folder.
 */
export function normalizeMode(raw: unknown): LineageMode {
  return raw === 'project' ? 'project' : DEFAULT_MODE;
}

/**
 * THE ONE GATE on in-window project switching: the switch verb, the workspace
 * status-bar item, focus-follows auto-switch, and every workspaces.ts
 * save/clear/restore path all ask this and nothing else, so no surface can
 * disagree with another about whether switching exists.
 *
 * Both settings must say yes. `lineage.mode` is the master — folder mode turns
 * switching off whatever the older key says — and `lineage.workspaces.enabled`
 * survives as the project-mode user's own off switch, because it predates the
 * mode and people have it set.
 */
export function projectSwitchingOn(
  mode: LineageMode,
  workspacesEnabled: boolean,
): boolean {
  return mode === 'project' && workspacesEnabled;
}

/**
 * Folder mode's "this row is not this window's to run": the session's cwd is
 * KNOWN and lies outside every folder this window opened.
 *
 * A UNION, not a single folder. "The folder you opened" is folder[0] only in
 * the simple case: a window converted by the explorer-follow feature is by
 * construction multi-root (its folder[0] is the Flock anchor — an empty
 * directory the extension owns, which the wiring must never hand in here),
 * and an ordinary multi-root workspace opens several folders on purpose. In
 * both, every real root is "the folder you opened", so a session under ANY of
 * them is this window's. Scoping to folder[0] alone was the bug that made the
 * default mode render zero sessions in converted windows — everything was
 * "outside" an anchor nothing runs in.
 *
 * Deliberately false for an unknown cwd and for a window with no real folders
 * (empty window, an untitled workspace): a session this window cannot place is
 * not thereby proven foreign, and refusing to act on it would strand the row —
 * a click that does nothing, with nothing on screen to say why. Only a
 * POSITIVE "that path is elsewhere" ever withholds the in-place verbs.
 */
export function outsideScope(
  scopeDirs: readonly string[] | undefined,
  cwd: string | undefined,
): boolean {
  const scopes = (scopeDirs ?? [])
    .map((d) => normalizeDir(d))
    .filter((d) => d !== '');
  const target = normalizeDir(cwd);
  if (scopes.length === 0 || target === '') return false;
  return !scopes.some((scope) => isWithin(scope, target));
}

/**
 * The window that should HOST `dir`: the one whose opened folder contains it,
 * deepest folder winning so a window on `~/code/api` beats one on `~/code`.
 * Ties (two windows on the same folder) break on `publishedAt`, newest first —
 * the most recently alive window is the one most likely to still be there.
 *
 * EVERY published folder counts, not just the first: `WindowRecord.folders`
 * carries all of a multi-root window's real roots (anchor already excluded by
 * the publisher — see windows.ts), so a converted explorer-follow window and
 * an ordinary multi-root window are both routable targets for anything under
 * any of their roots. `folder` alone is the pre-`folders` record shape,
 * still honoured so a window running an older build stays reachable.
 *
 * Undefined when no window covers the directory, which is the caller's cue to
 * offer `vscode.openFolder(..., { forceNewWindow: true })` instead. Windows
 * with no folder are skipped: an empty window is not "the window for" any
 * directory, whatever it happens to have bound.
 */
export function windowForDir(
  windows: readonly WindowRecord[],
  dir: string | undefined,
): WindowRecord | undefined {
  const target = normalizeDir(dir);
  if (target === '') return undefined;
  let best: WindowRecord | undefined;
  let bestDepth = -1;
  for (const rec of windows ?? []) {
    const published =
      rec?.folders !== undefined && rec.folders.length > 0
        ? rec.folders
        : [rec?.folder];
    // The window's DEEPEST containing folder is its claim strength: a window
    // whose second root is `~/code/api` beats one opened on `~/code`, exactly
    // as it would if that root were its only one.
    let depth = -1;
    for (const raw of published) {
      const folder = normalizeDir(raw);
      if (folder === '' || !isWithin(folder, target)) continue;
      const d = pathKey(folder).length;
      if (d > depth) depth = d;
    }
    if (depth < 0) continue;
    if (
      depth > bestDepth ||
      (depth === bestDepth &&
        best !== undefined &&
        rec.publishedAt > best.publishedAt)
    ) {
      best = rec;
      bestDepth = depth;
    }
  }
  return best;
}

/**
 * The projects this window could actually START a session in: those with at
 * least one directory inside `scopeDirs`.
 *
 * For the pickers that END IN A LAUNCH. The launch fence (extension.ts's
 * `launchSession` dep) is what makes a foreign launch impossible; this is what
 * keeps the user from being offered one and then refused. An option that says
 * no when clicked is the cumbersome half of the experience, not a safeguard —
 * and the administrative pickers (set-account, rename, delete) deliberately do
 * NOT use this, because they act on the record, not on this machine.
 *
 * Two deliberate refusals to over-filter:
 *
 *   * No scope (project mode, an empty window) returns everything, same
 *     passthrough as every other rule here.
 *   * A scope that matches NOTHING also returns everything. An empty picker
 *     tells the user less than a full one — this window's folder simply has no
 *     project on it yet, and the ordinary flow (which will name the project,
 *     or fall through to the fence's own message) is more use than a dead
 *     list. Filtering is a courtesy; the fence is the rule.
 */
export function launchableProjects<T extends { dirs?: readonly string[] }>(
  scopeDirs: readonly string[] | undefined,
  projects: readonly T[],
  dirsOf: (project: T) => readonly string[],
): readonly T[] {
  if (scopeDirs === undefined || scopeDirs.length === 0) return projects;
  const inScope = projects.filter((p) =>
    dirsOf(p).some((dir) => !outsideScope(scopeDirs, dir)),
  );
  return inScope.length > 0 ? inScope : projects;
}

/**
 * The folder a NEW window should open on to adopt a session, when no live
 * window covers it: the owning project's matched directory, else the session's
 * own cwd. The project's claim is preferred over the bare cwd because the new
 * window's scope should be the project the user filed the work under, not
 * whatever subdirectory the session happened to be started in — opening
 * `~/code/api` shows the whole project's rows; opening `~/code/api/src/x`
 * shows almost none of them.
 */
export function openTargetFor(
  matches: readonly ProjectMatch[],
  cwd: string | undefined,
): string {
  const claim = normalizeDir(matches?.[0]?.dir);
  if (claim !== '') return claim;
  return normalizeDir(cwd);
}
