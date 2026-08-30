// src/modes.ts — which of the three window models this window lives in.
//
// `lineage.mode` names a choice about what a WINDOW is. There are three
// answers, and they form a ladder from the window that holds one thing to the
// window that follows you:
//
//   * FOLDER mode, `folder` (the default) — ONE FOLDER PER PROJECT, and native
//     VS Code. A window IS the folder you opened, the way every other extension
//     assumes. The tree scopes itself to sessions under that folder, the
//     workspace status-bar item never appears, and the switch verb refuses.
//     Working on another project means going to (or opening) that project's
//     WINDOW — never rearranging this one. It needs no tmux and no window
//     management; it costs a window per project, and alt-tab is your switcher.
//   * ROOT mode, `root` — FLOCK ONLY. The window is Flock's: no folder is
//     fenced, nothing scopes the tree, and nothing rearranges itself behind
//     you. The sidebar holds everything on the machine and you go to a piece of
//     work by opening a window on it. The switch verb still exists here — this
//     model can switch on purpose — it just never fires by itself and never
//     advertises itself in the status bar. It costs you a window per piece of
//     work you actually want files for, and a sidebar with nothing narrowing it.
//   * PROJECT mode, `project` — AUTO-SWITCH. One window spanning many projects,
//     switched transactionally by workspaces.ts and switched FOR you when your
//     attention moves. The most convenient of the three and the hardest to keep
//     straight: it costs a window that rearranges itself, a one-time conversion
//     (`lineage.followInExplorer`, which is a reload) before the Explorer will
//     follow, and tmux, because the sessions you switch away from have to keep
//     running.
//
// WHY THREE AND NOT TWO. The third model was already here, spelled as a pair:
// `lineage.mode: project` with the older `lineage.workspaces.enabled: false`
// gave a window with no auto-switch, no status-bar button and no fence — which
// is exactly Flock-only — but you had to compute it from two keys to know that,
// and a model you cannot name is a model nobody chooses. `resolveMode` below
// folds that pair once, so the truth table becomes a value.
//
// NOT "LEVELS", here or anywhere user-facing. `design/levels-and-modes.md`
// numbers the SESSION LIFECYCLE — open, closed, archived — one to three, and
// two triples of three both called "level 2" is a collision nobody recovers
// from. These are window MODELS and they are named, never numbered.
//
// WHY `project` KEEPS ITS SPELLING even though its label is now "Auto-switch":
// the string is in users' settings.json, in the manifest's when-clauses, in the
// docs, in the CHANGELOG and in a shipped VSIX, and its MEANING did not change —
// the window follows the project you are in. Only its neighbours changed. A
// rename would buy a nicer identifier and cost a compatibility alias that would
// have to live forever; `enumItemLabels` in the manifest gives the dropdown the
// human words without touching the value.
//
// WHY THE DEFAULT IS STILL `folder`, even though Axel calls one-folder-per-
// project "not our main use case": the default has to be right for a window
// whose folder the extension did not choose, and `folder` is the only one of
// the three that is. Auto-switch needs a one-time window conversion that costs
// a RELOAD, and no default may require one. Flock-only assumes the window is
// not a project folder, which the extension cannot assume on somebody's behalf.
// Changing the default would move every user who never wrote the key, which is
// the largest population there is. And `folder` already degrades into the
// Flock-only shape when there is nothing to fence — `scopeFolders()` returns
// undefined for a window with no real folders — so the empty-window user is not
// badly served by it, they merely do not have a name for what they have. The
// answer to "then how does anyone find auto-switch?" is not a flipped default:
// it is that the choice is ASKED, in Recommended Setup and in `Flock: Choose
// Window Model…`, the way recommend.ts's `surface` step asks about taste.
//
// The 84-detached-sessions incident (design/levels-and-modes.md) is what makes
// that default argument sharp rather than timid: every in-window switch put a
// project's sessions into an invisible running state. The levels work made that
// state honest (a grace countdown, then a closed row), and the model that never
// switches in place cannot produce it at all. That argues about which model may
// be the DEFAULT — it never argued that the other models should not exist.
//
// PURE, in the shape chatAutoClose.ts established: this module decides, the
// wiring in extension.ts / commands.ts reads the world (settings, the opened
// folder, the window roster) and acts on the answers. No vscode import — every
// rule here is unit-testable without a workbench.

import { isWithin, normalizeDir, pathKey } from './projects';
import type { ProjectMatch } from './projects';
import type { WindowRecord } from './types';

export type LineageMode = 'folder' | 'root' | 'project';

/** The shipped default. See the header for the five-part defence: it is the
 *  only value that is right for a window whose folder the extension did not
 *  choose, and the model that cannot switch in place is the model that cannot
 *  reproduce the incident. */
export const DEFAULT_MODE: LineageMode = 'folder';

/**
 * `lineage.mode` as read from configuration, defensively: anything that is not
 * one of the three model names — a typo, an old value, undefined — reads as the
 * default. This is the STRING PARSER and nothing else; the legacy pair is
 * folded by `resolveMode` below, so each function answers one question and the
 * migration stays readable as a table.
 *
 * Falling back to `folder` on garbage is still the safe direction, and now for
 * two reasons rather than one. The worst a wrong `folder` does is hide a switch
 * verb; a wrong `project` would let a switch rearrange a window the user thinks
 * of as a plain folder, and a wrong `root` would drop the fence off a window
 * that was opened on a folder on purpose — showing the whole machine's sessions
 * to somebody who asked for one project's.
 */
export function normalizeMode(raw: unknown): LineageMode {
  return raw === 'project' || raw === 'root' ? raw : DEFAULT_MODE;
}

/**
 * THE MIGRATION, and the only reader of `lineage.workspaces.enabled` left.
 *
 * `(mode: project, workspaces.enabled: false)` IS the Flock-only model today —
 * no auto-switch, no status-bar button, no scope fence, tree holds everything,
 * switching still available on purpose — because `workspaces.enabled` only ever
 * gated those first two things (see `projectSwitchingOn`). So folding that pair
 * to `root` moves nobody: it gives a model that already existed the name it
 * never had. Honouring `mode` alone instead would switch auto-switching back on
 * for the one population that went and explicitly turned it off, which is the
 * worst move available.
 *
 * The test is `workspacesEnabled === false` and not `!workspacesEnabled` on
 * purpose. An `undefined` arriving from an older wiring or a unit double means
 * "this caller has no opinion", and an absent opinion must not silently demote
 * somebody's auto-switching window to Flock-only.
 *
 * NOT A ONE-SHOT SETTINGS WRITE, deliberately, and this is the alternative that
 * was rejected: an activation that rewrites a `settings.json` nobody asked it
 * to touch is a worse citizen than one that keeps reading an old key, and
 * Settings Sync would carry that edit to machines running builds that have
 * never heard of the value `root`. This extension writes settings only behind
 * a user's own gesture, everywhere else; the shadow key retires the same way —
 * the window-model picker writes `workspaces.enabled: true` alongside
 * `mode: project` when somebody chooses auto-switch, because they asked.
 */
export function resolveMode(
  rawMode: unknown,
  workspacesEnabled: boolean,
): LineageMode {
  const named = normalizeMode(rawMode);
  if (named === 'project' && workspacesEnabled === false) return 'root';
  return named;
}

/**
 * Does this window REARRANGE ITSELF WITHOUT BEING ASKED?
 *
 * That is the whole of what this gates, and the whole of what separates
 * auto-switch from Flock-only: the focus-follows auto-switch (a session in
 * another project takes the window there) and whether the workspace status-bar
 * button is drawn at all. Two call sites, both in extension.ts.
 *
 * It is deliberately NOT the gate on the switch VERB or on workspaces.ts's
 * save/clear/restore — an earlier version of this comment claimed it was, and
 * that overstatement is exactly what made `lineage.workspaces.enabled` look
 * like a master switch it never was. Those are gated on the mode being `folder`
 * instead, which is the weaker and correct rule: in-window switching is
 * available at BOTH models that are not one-folder-per-project, so the
 * Flock-only window can still switch on purpose — it just never switches by
 * itself and never advertises that it could.
 */
export function projectSwitchingOn(mode: LineageMode): boolean {
  return mode === 'project';
}

/**
 * Is this window fenced to the folder it opened?
 *
 * The scope fence (which sessions get rows) and the launch fence (which
 * sessions this window may start) are one fact about the model, and it is
 * `folder` alone: the Flock-only window deliberately shows everything, which is
 * what "we just have the root, where we only see Flock" means, and the
 * auto-switch window's roots change under it on every focus change.
 *
 * A name rather than `mode === 'folder'` spelled out at each surface, because
 * with three values that literal stops being self-evident — a later reader
 * asking "and what about flock?" should find the answer here rather than
 * re-derive it, differently, in a fourth place.
 */
export function folderScoped(mode: LineageMode): boolean {
  return mode === 'folder';
}

/**
 * Is the thing this window follows a SESSION?
 *
 * True for auto-switch and nothing else, and it is deliberately a NAME rather
 * than a fourth enum value. The first draft of the auto-switch work proposed
 * one — a `follow` model sitting between `root` and `project` — and it was
 * rejected for the reason the whole three-model exercise exists: four values in
 * which two both mean "the window follows something" is precisely the truth
 * table `lineage.mode` was consolidated to remove. Following the session is not
 * a different model from auto-switching, it is what auto-switching MEANS once
 * it is done properly: the window that rearranges itself has to rearrange
 * itself around something, and the thing a person is in is a conversation, not
 * a project they switched to twenty minutes ago.
 *
 * Read as: in this model the Explorer is rooted at the session's own lane
 * directory inside the session's own checkout, and Source Control is showing
 * that checkout (src/follow.ts decides both). The other two models never move
 * either — folder mode because the window IS the folder it opened, Flock-only
 * because nothing there rearranges without being asked.
 */
export function followsTheSession(mode: LineageMode): boolean {
  return mode === 'project';
}

/**
 * May the Explorer's folder tree actually MOVE?
 *
 * The model says the window follows; `lineage.explorer.followProject` says
 * whether the user wants the FILE TREE dragged along with it, and the answer is
 * the conjunction. Two predicates rather than one because they are two
 * different questions and only one of them has a setting behind it: a person
 * who turns the tree-following off is still in the auto-switch model — their
 * tabs still switch, the status-bar line still says where they are, and Source
 * Control still follows the checkout, because none of that reroots a tree they
 * asked to be left alone. Collapsing the two would silently make that setting
 * mean "leave the whole model", which is a thing they can already say by
 * choosing a different model.
 *
 * The setting keeps its old name on purpose even though what it follows is now
 * a session: it is in people's settings.json, and renaming a key to reflect an
 * improved answer to the same question buys nothing and costs a compatibility
 * alias that lives forever. See docs/settings.md, which says what it now does.
 */
export function explorerFollowOn(
  mode: LineageMode,
  followProjectSetting: boolean,
): boolean {
  return followsTheSession(mode) && followProjectSetting !== false;
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
 * Does THIS window already have `dir` open — is one of its real workspace
 * folders a parent of (or the same as) that directory?
 *
 * The self-check for every verb that would otherwise open a window: the one
 * window `windowForDir` cannot answer with is the one you are sitting in
 * (extension.ts's `focusWindowForDir` excludes it on purpose, because a caller
 * asking to route elsewhere has already decided "here" is wrong), so without a
 * check of our own "go to that workspace" would cheerfully open a second window
 * on the folder the user is already standing in. Two windows on one directory
 * is the shape that produced the 84-detached-sessions incident's cousins — two
 * roosts for one piece of work, each unaware the other has it.
 *
 * NOT `!outsideScope(...)`, which is the same containment test with the
 * opposite asymmetry, and the difference is load-bearing. `outsideScope` is
 * deliberately permissive about an absent list, so that only a POSITIVE "that
 * path is elsewhere" ever withholds a verb — which means it answers `true`
 * ("not outside") for a window that published no folders at all. Here the
 * asymmetry has to run the other way: only a POSITIVE "this window already has
 * it" may suppress the window, so no folders means no claim, and the verb goes
 * ahead and opens one.
 *
 * REAL WORKSPACE FOLDERS, not the folder-mode scope fence. `scopeDirs()` is
 * `undefined` in every model except `folder` by construction, so a check
 * written over it would silently never fire in exactly the two models this
 * verb was asked for — the caller must hand in what this window actually
 * opened, whatever model it is in. A window is one directory or another
 * regardless of how it chooses to file the sessions it can see.
 */
export function windowCovers(
  folders: readonly string[] | undefined,
  dir: string | undefined,
): boolean {
  const roots = (folders ?? [])
    .map((d) => normalizeDir(d))
    .filter((d) => d !== '');
  const target = normalizeDir(dir);
  if (roots.length === 0 || target === '') return false;
  return roots.some((root) => isWithin(root, target));
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
