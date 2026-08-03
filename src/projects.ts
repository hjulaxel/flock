// IMPLEMENTED BY: M7 — the project-first rework.
//
// Pure. Imports ./types and NOTHING else — no vscode, no node:path, no fs — so
// every rule in here is unit-testable without a workbench and can be called
// from both the tree and the command layer.
//
// The model: a PROJECT owns a name and a set of directories. A SESSION owns a
// cwd. Membership is derived, never stored on the session: the project whose
// directory is the LONGEST match for the session's cwd wins. That is what lets
// a project be renamed, re-pointed or given another directory without
// rewriting a single session record — and what makes nested directories
// (~/code and ~/code/api as two different projects) land in the right row.

import {
  DEFAULT_PROVIDER,
  MAX_PROJECT_DEPTH,
  MAX_PROJECT_NAME_LEN,
  isProviderId,
} from './types';
import type {
  BranchInfo,
  EditorialRecord,
  GroupNode,
  ProjectGroupNode,
  ProjectRecord,
  ProviderId,
  Worktree,
} from './types';

/** Identity of the catch-all folder row for roots with no cwd. Kept as
 *  `(unknown)` even though the row now reads "(no directory)": the key is what
 *  collapse state and `groupCwdFromArg()` round-trip through, so renaming it
 *  would silently reset a user's collapsed rows for a cosmetic change. */
const UNKNOWN_GROUP_KEY = '(unknown)';

/** What that row is called in the tree. Parenthesised for the same reason as
 *  {@link DETACHED_BRANCH_LABEL} — no real directory can be mistaken for it. */
const UNKNOWN_GROUP_LABEL = '(no directory)';

/** How many distinct branch colours the palette holds. Both renderers define
 *  exactly this many `--lineage-branch-N` variables; a project with more
 *  branches wraps round, because a repeated hue is a smaller lie than a hue
 *  with no definition behind it (which would render as inherited grey and read
 *  as "no branch"). Six is what the stock `charts.*` theme colours give us
 *  while staying distinguishable at 11px. */
export const BRANCH_COLOR_COUNT = 6;

/** What a detached HEAD is called on a chip. Parenthesised so it cannot be
 *  mistaken for a branch someone actually named. */
export const DETACHED_BRANCH_LABEL = '(detached)';

/**
 * At or below this many worktrees, every branch is shown by default.
 *
 * The threshold exists because "most should be hidden" is right for a
 * repository with twenty worktrees and wrong for one with three. Below it there
 * is nothing to curate — the whole list fits, and hiding two of three branches
 * to save two rows would be a puzzle rather than a tidy-up. Above it the
 * default flips to the selective policy, and the user promotes what they want
 * back into the list.
 */
export const BRANCH_AUTOSHOW_LIMIT = 5;

/**
 * Should this branch be on screen, absent any decision by the user?
 *
 * Two things earn a branch a row for free, and they are the two you would be
 * annoyed to have to ask for:
 *
 *   - it is the repository's MAIN worktree, which is the one every repo has and
 *     the one you fall back to;
 *   - something is RUNNING on it. A live agent whose row you cannot see is the
 *     worst outcome this whole feature could produce, so an active branch
 *     always surfaces, even in a repo with fifty worktrees.
 *
 * Everything else starts folded away once the list is long enough to be worth
 * folding. Note what this is NOT: it is not a memory. It is recomputed every
 * render, so a branch that goes quiet drops back out of the default set — which
 * is exactly why an explicit `shownBranches` entry exists for the ones you want
 * to keep regardless.
 */
export function defaultBranchVisibility(
  branch: { primary: boolean; rootIds: readonly string[] },
  totalBranches: number,
): boolean {
  if (totalBranches <= BRANCH_AUTOSHOW_LIMIT) return true;
  if (branch.primary) return true;
  return branch.rootIds.length > 0;
}

/**
 * The user's curation applied over that policy.
 *
 * Explicit beats implicit in both directions, which is the whole reason
 * ProjectRecord keeps two lists rather than one — see the comment there.
 */
export function branchIsShown(
  project: ProjectRecord | undefined,
  branch: { name: string; primary: boolean; rootIds: readonly string[] },
  totalBranches: number,
): boolean {
  const hidden = project?.hiddenBranches ?? [];
  if (hidden.includes(branch.name)) return false;
  const shown = project?.shownBranches ?? [];
  if (shown.includes(branch.name)) return true;
  return defaultBranchVisibility(branch, totalBranches);
}

// --------------------------------------------------------------- path rules

/**
 * One canonical spelling of a directory path: `\` folded to `/`, repeated
 * separators collapsed, trailing separators dropped (except a bare root).
 * NOT case-folded — see `pathKey` for the comparison form.
 *
 * A LEADING double separator survives the collapse. That is the UNC share
 * prefix (`\\nas\code`, which is what `Uri.file()` hands back as `fsPath` for a
 * network share): collapsing it to `/nas/code` still compares consistently
 * against an identically-mangled session cwd, so grouping looks fine — but the
 * mangled string is what gets persisted and then handed to `Uri.file()` and to
 * a terminal `cwd`, where it names a local path that is not the share.
 */
export function normalizeDir(input: unknown): string {
  if (typeof input !== 'string') return '';
  const trimmed = input.trim();
  if (trimmed === '') return '';
  const slashed = trimmed.replace(/\\/g, '/');
  // Exactly two leading separators followed by a host character is a UNC
  // prefix. Three or more is not, and neither is a bare `//`.
  const unc = /^\/\/[^/]/.test(slashed) ? '//' : '';
  const body = slashed.slice(unc.length).replace(/\/{2,}/g, '/');
  if (unc === '' && body === '/') return '/';
  const tail = body.replace(/\/+$/, '');
  return tail === '' ? body : `${unc}${tail}`;
}

/**
 * The comparison form. Case-INSENSITIVE on purpose: the two platforms this
 * ships on (macOS, Windows) both have case-insensitive filesystems by default,
 * so `/Users/x/Code` and `/Users/x/code` are one directory and must group as
 * one. On Linux that is a theoretical over-match between two directories whose
 * names differ only in case — a trade this design accepts knowingly, because
 * the opposite error (a project silently not matching its own sessions) is the
 * one users would actually hit.
 */
export function pathKey(dir: string): string {
  return normalizeDir(dir).toLowerCase();
}

/** True when `target` IS `dir` or sits underneath it. Boundary-aware, so
 *  `/a/bc` is never considered to be inside `/a/b`. */
export function isWithin(dir: string, target: string): boolean {
  const d = pathKey(dir);
  const t = pathKey(target);
  if (d === '' || t === '') return false;
  if (d === t) return true;
  const prefix = d.endsWith('/') ? d : `${d}/`;
  return t.startsWith(prefix);
}

/** Path basename without node:path (works for `/` and `\` alike). */
export function baseName(p: string): string {
  const norm = normalizeDir(p);
  if (norm === '' || norm === '/') return norm === '' ? p : '/';
  const i = norm.lastIndexOf('/');
  return i < 0 ? norm : norm.slice(i + 1);
}

// ------------------------------------------------------------- project shape

/** rootDir first, then the extras, normalized and deduped. Always the list to
 *  match against — a project's rootDir is just its first directory. */
export function projectDirs(p: ProjectRecord): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown): void => {
    const dir = normalizeDir(raw);
    if (dir === '') return;
    const key = pathKey(dir);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(dir);
  };
  push(p?.rootDir);
  for (const d of p?.dirs ?? []) push(d);
  return out;
}

export function providerOfProject(p: ProjectRecord | undefined): ProviderId {
  return isProviderId(p?.provider) ? p.provider : DEFAULT_PROVIDER;
}

// ------------------------------------------------------------ project tree
// M26. A project may be filed under another project, to any depth and any
// breadth. The records store only a pointer UP (ProjectRecord.parentId); this
// is the one place those pointers become a tree, and the one place that has to
// survive them being wrong.

/** One project's resolved place in the tree. */
export interface ProjectTreeNode {
  project: ProjectRecord;
  /** The parent AS RESOLVED — null for a top-level project, and for one whose
   *  record names a parent this tree refused (missing, self, cyclic, too
   *  deep). */
  parentId: string | null;
  /** 0 for a top-level project. Never ≥ MAX_PROJECT_DEPTH. */
  depth: number;
  /** Child ids in display order. */
  childIds: string[];
}

export interface ProjectTree {
  byId: Map<string, ProjectTreeNode>;
  /** Top-level project ids, in display order. */
  roots: string[];
  /** Every id, depth-first preorder — a parent immediately followed by its own
   *  subtree. This IS the row order the views render in. */
  order: string[];
}

/** The order projects are drawn in among their siblings: name, then id so two
 *  projects sharing a name still land in a stable order across ticks. */
function byName(a: ProjectRecord, b: ProjectRecord): number {
  return cmp(a.name.toLowerCase(), b.name.toLowerCase()) || cmp(a.id, b.id);
}

/**
 * Turn a flat list of records into a tree, refusing every edge that cannot be
 * drawn.
 *
 * NOTHING about a parent pointer is trusted. These records are merged across
 * windows, hand-editable on disk, and outlive the projects they name, so all
 * four failure modes are ordinary rather than theoretical:
 *
 *   - a parent id naming nothing (deleted here, or not merged in yet) — the
 *     child becomes a ROOT. Never hidden: a project the user cannot see is a
 *     project they cannot fix, and "my subproject vanished when I deleted its
 *     parent" is the one outcome that would make nesting untrustworthy.
 *   - a project naming itself;
 *   - a cycle (a → b → a), broken at the first id the walk meets twice;
 *   - a chain deeper than MAX_PROJECT_DEPTH, cut at the cap.
 *
 * Deterministic under all of them: ids are resolved in display order, so two
 * windows looking at the same broken state draw the same tree.
 */
export function buildProjectTree(
  projects: readonly ProjectRecord[],
): ProjectTree {
  const records = (projects ?? []).filter((p): p is ProjectRecord => !!p?.id);
  const byId = new Map<string, ProjectTreeNode>();
  const source = new Map<string, ProjectRecord>();
  for (const p of records) if (!source.has(p.id)) source.set(p.id, p);

  const ordered = Array.from(source.values()).sort(byName);

  /** The raw pointer, or '' — before any of the tree's own rules apply. */
  const rawParent = (p: ProjectRecord): string => {
    const raw = p.parentId;
    if (typeof raw !== 'string') return '';
    const id = raw.trim();
    if (id === '' || id === p.id || !source.has(id)) return '';
    return id;
  };

  // Depth resolution with an in-progress marker: meeting a node that is still
  // being resolved IS the cycle, and the node that met it is where the cycle is
  // broken. Iterating in display order makes which node that is deterministic.
  const depths = new Map<string, number>();
  const resolving = new Set<string>();
  const resolvedParent = new Map<string, string | null>();

  /** Depth of `p`, memoised, breaking any loop at the node that closes it.
   *
   *  `resolving` holds the chain currently being walked, so a parent already in
   *  it is by definition an ancestor of the node asking for it — which is the
   *  exact definition of the cycle. The node that MEETS the loop is the one
   *  cut loose, and because the walk starts from ids in display order, which
   *  node that is never varies between windows. */
  const resolve = (id: string): number => {
    const known = depths.get(id);
    if (known !== undefined) return known;
    const p = source.get(id);
    if (!p) return 0;
    const parentId = rawParent(p);
    if (parentId === '' || resolving.has(parentId)) {
      depths.set(id, 0);
      resolvedParent.set(id, null);
      return 0;
    }
    resolving.add(id);
    const depth = resolve(parentId) + 1;
    resolving.delete(id);
    if (depth >= MAX_PROJECT_DEPTH) {
      depths.set(id, 0);
      resolvedParent.set(id, null);
      return 0;
    }
    depths.set(id, depth);
    resolvedParent.set(id, parentId);
    return depth;
  };

  for (const p of ordered) resolve(p.id);

  for (const p of ordered) {
    byId.set(p.id, {
      project: p,
      parentId: resolvedParent.get(p.id) ?? null,
      depth: depths.get(p.id) ?? 0,
      childIds: [],
    });
  }
  const roots: string[] = [];
  for (const p of ordered) {
    const node = byId.get(p.id);
    if (!node) continue;
    if (node.parentId === null) roots.push(p.id);
    else byId.get(node.parentId)?.childIds.push(p.id);
  }

  // Preorder: a parent, then everything filed under it, then the next sibling.
  const order: string[] = [];
  const walk = (id: string): void => {
    const node = byId.get(id);
    if (!node) return;
    order.push(id);
    for (const child of node.childIds) walk(child);
  };
  for (const id of roots) walk(id);

  return { byId, roots, order };
}

/** Ids of `projectId` and everything filed under it, preorder. Used by every
 *  verb that acts on a subtree (close, delete, the move picker's refusal). */
export function projectSubtree(
  tree: ProjectTree,
  projectId: string,
): string[] {
  const out: string[] = [];
  const walk = (id: string): void => {
    const node = tree.byId.get(id);
    if (!node) return;
    out.push(id);
    for (const child of node.childIds) walk(child);
  };
  walk(projectId);
  return out;
}

/**
 * Would filing `projectId` under `newParentId` produce something drawable?
 *
 * Refuses the three moves that are not moves: onto itself, onto a project it
 * already contains (which would cut both loose from the tree), and past the
 * depth cap (which would silently re-root the whole subtree at the next
 * render — a move that appears to work and then does something else).
 *
 * `null` — move to the top level — is always allowed.
 */
export function canReparentProject(
  projects: readonly ProjectRecord[],
  projectId: string,
  newParentId: string | null,
): { ok: boolean; reason: string } {
  if (newParentId === null) return { ok: true, reason: '' };
  if (newParentId === projectId) {
    return { ok: false, reason: 'A project cannot be filed under itself.' };
  }
  const tree = buildProjectTree(projects);
  if (!tree.byId.has(projectId) || !tree.byId.has(newParentId)) {
    return { ok: false, reason: 'That project no longer exists.' };
  }
  if (projectSubtree(tree, projectId).includes(newParentId)) {
    return {
      ok: false,
      reason: 'A project cannot be filed under one of its own subprojects.',
    };
  }
  // The moved subtree keeps its shape, so what matters is its own height added
  // to the new parent's depth.
  const parentDepth = tree.byId.get(newParentId)?.depth ?? 0;
  const own = tree.byId.get(projectId)?.depth ?? 0;
  let height = 0;
  for (const id of projectSubtree(tree, projectId)) {
    height = Math.max(height, (tree.byId.get(id)?.depth ?? 0) - own);
  }
  if (parentDepth + 1 + height >= MAX_PROJECT_DEPTH) {
    return {
      ok: false,
      reason: `Projects nest at most ${MAX_PROJECT_DEPTH} deep.`,
    };
  }
  return { ok: true, reason: '' };
}

/**
 * How many projects sit above this one, walking the RAW pointers.
 *
 * Used only as a tiebreak inside matchProject, which is handed a bare array
 * with no tree built over it — and is called once per session, so the walk is
 * deliberately lazy: it runs only when two projects claim the same directory,
 * which is the mistake case rather than the common one.
 */
function nestingDepth(
  projects: readonly ProjectRecord[],
  project: ProjectRecord,
): number {
  let depth = 0;
  let cursor: ProjectRecord | undefined = project;
  const seen = new Set<string>([project.id]);
  while (cursor && depth < MAX_PROJECT_DEPTH) {
    const raw: unknown = cursor.parentId;
    const parentId: string = typeof raw === 'string' ? raw.trim() : '';
    if (parentId === '' || seen.has(parentId)) break;
    seen.add(parentId);
    cursor = projects.find((p) => p?.id === parentId);
    if (!cursor) break;
    depth++;
  }
  return depth;
}

/** '' when the name is usable, else the reason it is not. */
export function validateProjectName(
  raw: string,
  existing: readonly ProjectRecord[],
  selfId?: string,
): string {
  const name = raw.trim();
  if (name.length === 0) return 'Name cannot be empty.';
  if (name.length > MAX_PROJECT_NAME_LEN) {
    return `Name must be ${MAX_PROJECT_NAME_LEN} characters or fewer (currently ${name.length}).`;
  }
  const clash = existing.some(
    (p) => p.id !== selfId && p.name.trim().toLowerCase() === name.toLowerCase(),
  );
  return clash ? 'A project with that name already exists.' : '';
}

// ---------------------------------------------------------------- matching

export interface ProjectMatch {
  project: ProjectRecord;
  /** The specific directory of the project that matched. */
  dir: string;
  /** Length of the matched directory key — the tie-break for nesting. */
  depth: number;
  /** M26. The matched directory is one the project LISTS, rather than one it
   *  merely reaches as a worktree of a repository it sits in. Part of the
   *  tie-break: an explicit statement outranks a derived one. */
  own?: boolean;
}

/**
 * The project owning `cwd`, or null. Longest matching directory wins so a
 * project rooted at `~/code/api` beats one rooted at `~/code`. Ties (the same
 * directory listed by two projects — a user mistake, not a crash) break on
 * project name then id, so the answer is stable across ticks.
 */
export function matchProject(
  projects: readonly ProjectRecord[],
  cwd: string | undefined,
  /**
   * M20. Directories a project owns WITHOUT having them listed — the worktrees
   * of the repositories its own directories sit in. A session running in
   * `~/code/app-feat-x`, a linked worktree of the repo at `~/code/app`, belongs
   * to the project rooted at `~/code/app` even though nobody added that path to
   * it; worktrees are created and deleted several times a day and asking the
   * user to register each one would make the feature worthless.
   *
   * Optional so the other callers of this function — which ask "which project
   * owns this path" about paths the user typed, where the literal answer is the
   * right one — are unchanged.
   */
  extraDirs?: (project: ProjectRecord) => readonly string[],
): ProjectMatch | null {
  const target = normalizeDir(cwd);
  if (target === '') return null;

  const all = projects ?? [];
  let best: ProjectMatch | null = null;
  for (const project of all) {
    if (!project) continue;
    const listed: (readonly [string, boolean])[] = projectDirs(project).map(
      (d) => [d, true] as const,
    );
    const dirs = extraDirs
      ? [
          ...listed,
          ...extraDirs(project).map((d) => [normalizeDir(d), false] as const),
        ]
      : listed;
    for (const [dir, own] of dirs) {
      if (dir === '' || !isWithin(dir, target)) continue;
      const depth = pathKey(dir).length;
      const candidate: ProjectMatch = { project, dir, depth, own };
      if (best === null || depth > best.depth) {
        best = candidate;
        continue;
      }
      if (depth === best.depth && beatsAtEqualDepth(all, candidate, best)) {
        best = candidate;
      }
    }
  }
  return best;
}

/**
 * Which of two projects claiming the SAME directory wins.
 *
 * Reached only when two projects match a cwd at identical directory depth,
 * which is either a user mistake (the same path listed twice) or the M26 case:
 * a project and a subproject inside it, both of which see the same git
 * worktrees. Three rules, each with its own reason, then the old stable
 * name/id fallback so the answer never depends on iteration order:
 *
 *  1. An OWN directory beats a DERIVED one. "I put this path in this project"
 *     is a statement; "this path is a worktree of a repository this project
 *     sits in" is an inference, and an inference must not overrule a
 *     statement.
 *  2. Both own -> the DEEPER project wins. The same directory listed on a
 *     subproject as well as on its parent is the more specific of two
 *     deliberate statements.
 *  3. Both derived -> the SHALLOWER project wins. A worktree belongs to
 *     whichever project owns the repository, not to every subproject that
 *     happens to sit inside a checkout of it — otherwise adding one subproject
 *     would quietly move every other worktree's sessions onto it.
 */
function beatsAtEqualDepth(
  projects: readonly ProjectRecord[],
  candidate: ProjectMatch,
  best: ProjectMatch,
): boolean {
  if (candidate.own !== best.own) return candidate.own === true;
  const a = nestingDepth(projects, candidate.project);
  const b = nestingDepth(projects, best.project);
  if (a !== b) return candidate.own === true ? a > b : a < b;
  const x = `${candidate.project.name}\u0000${candidate.project.id}`;
  const y = `${best.project.name}\u0000${best.project.id}`;
  return x < y;
}

// ------------------------------------------------------------------- chats

/**
 * M24. Every CHAT this project has ever had, newest first.
 *
 * Membership is derived exactly as it is for a session — the project whose
 * directory is the longest match for the conversation's cwd — and for the same
 * reason: a chat is a conversation running somewhere, and the alternative (a
 * list of ids kept on the ProjectRecord) is a set stored in a record whose
 * merge rule is newest-WINS, not newest-unions. Two windows opening a chat in
 * the same project a second apart would each write a one-element list and the
 * loser's chat would drop off the history for good.
 *
 * A chat with NO cwd, or one whose directory no project claims, belongs to no
 * project and appears in no history. That is the honest answer: the project it
 * was opened on has since been re-pointed away from that directory, and
 * pretending otherwise would put someone else's conversation in this list.
 *
 * Order is `createdAt` descending — the one fact every record has. The caller
 * re-sorts on transcript activity when it can read it (see TranscriptFacts);
 * this is the floor, not the intended final order.
 */
export function chatsForProject(
  records: Record<string, EditorialRecord> | undefined,
  projects: readonly ProjectRecord[],
  projectId: string,
  extraDirs?: (project: ProjectRecord) => readonly string[],
): EditorialRecord[] {
  const out: EditorialRecord[] = [];
  for (const record of Object.values(records ?? {})) {
    if (!record || record.chat !== true || record.deleted === true) continue;
    const match = matchProject(projects, record.cwd, extraDirs);
    if (match?.project.id !== projectId) continue;
    out.push(record);
  }
  return out.sort(
    (a, b) => cmp(b.createdAt ?? '', a.createdAt ?? '') || cmp(a.id, b.id),
  );
}

/** True when `cwd` sits inside any hidden folder. */
export function isHiddenFolder(
  hiddenFolders: readonly string[],
  cwd: string | undefined,
): boolean {
  const target = normalizeDir(cwd);
  if (target === '') return false;
  for (const dir of hiddenFolders ?? []) {
    if (isWithin(dir, target)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- branches

/**
 * Every worktree reachable from any of a project's directories, deduped.
 *
 * Union rather than "the first directory that is a repo": a project is
 * explicitly allowed to span several ("a repo, its infra directory and its
 * notes" — README), and two of those can be separate repositories with
 * worktrees of their own. Asking each and merging is the only answer that does
 * not silently drop the second repo's branches.
 *
 * Deduped on the normalized dir key because the SAME repo reached through two
 * of the project's directories reports the same worktree list twice, and a chip
 * row with `main` on it twice is worse than no chip row.
 */
function projectWorktrees(
  project: ProjectRecord,
  worktreesOf: ((dir: string) => readonly Worktree[]) | undefined,
): Worktree[] {
  if (!worktreesOf) return [];
  const out: Worktree[] = [];
  const seen = new Set<string>();
  for (const dir of projectDirs(project)) {
    let found: readonly Worktree[];
    try {
      found = worktreesOf(dir) ?? [];
    } catch {
      // A probe that throws is a probe that failed: no branches for this
      // directory, and the rest of the project still gets its chips.
      continue;
    }
    for (const wt of found) {
      const normalized = normalizeDir(wt?.dir);
      if (normalized === '') continue;
      const key = pathKey(normalized);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        dir: normalized,
        branch: typeof wt.branch === 'string' ? wt.branch : '',
        head: typeof wt.head === 'string' ? wt.head : '',
        detached: wt.detached === true,
      });
    }
  }
  return out;
}

/**
 * Worktrees → the chips under a project row, in display order.
 *
 * Order is the whole of the colour contract, because `colorIndex` is just a
 * position: the MAIN worktree first (git lists it first, and it is the one a
 * repo has before anybody adds another — so `main` keeps colour 0 forever),
 * then the rest alphabetically. Anything derived from the branch NAME instead
 * — a hash, say — would be stable too, but would hand two branches the same
 * colour inside one project often enough to matter, and the colour exists
 * precisely to tell them apart.
 *
 * The cost of position-indexing is that adding a branch alphabetically before
 * an existing one shifts that one's colour. That is a rare, visible, harmless
 * event; a permanent collision between two branches someone is actively working
 * on is neither rare nor harmless.
 *
 * A worktree with no session in it still gets a chip. That is the point of
 * reading git rather than the roster: you make a worktree and THEN want to
 * start a session in it, so the chip has to exist before the session does.
 */
export function buildBranches(
  worktrees: readonly Worktree[],
  rootIds: readonly string[],
  cwdOf: (sessionId: string) => string | undefined,
  /** The project these branches belong to, for its curation lists. Optional so
   *  the pure tests can build a branch list without inventing a project. */
  project?: ProjectRecord,
): BranchInfo[] {
  if (worktrees.length === 0) return [];

  const ordered = worktrees
    .map((wt, index) => ({ wt, index }))
    .sort((a, b) => {
      // Git lists the main worktree first; index 0 is therefore "primary" and
      // keeps that position regardless of what it is called.
      if (a.index === 0 || b.index === 0) return a.index - b.index;
      return (
        cmp(branchLabel(a.wt).toLowerCase(), branchLabel(b.wt).toLowerCase()) ||
        cmp(a.wt.dir, b.wt.dir)
      );
    });

  const branches: BranchInfo[] = ordered.map(({ wt, index }, position) => ({
    name: branchLabel(wt),
    dir: wt.dir,
    colorIndex: position % BRANCH_COLOR_COUNT,
    rootIds: [],
    primary: index === 0,
    // Provisional: the policy needs each branch's session list, which is filled
    // in below. Resolved in the second pass.
    shown: true,
  }));

  // Longest-match, exactly as project membership works: a worktree nested
  // inside another checkout's directory must win over the one containing it.
  for (const rootId of rootIds) {
    const cwd = cwdOf(rootId);
    const at = branchIndexForCwd(branches, cwd);
    if (at >= 0) branches[at].rootIds.push(rootId);
  }

  // Visibility LAST, because the default policy asks whether anything is
  // running on a branch and that is only known once the sessions are filed.
  for (const branch of branches) {
    branch.shown = branchIsShown(project, branch, branches.length);
  }
  return branches;
}

/** A worktree's chip label: its branch, or the detached marker. */
function branchLabel(wt: Worktree): string {
  const name = typeof wt.branch === 'string' ? wt.branch.trim() : '';
  if (name !== '') return name;
  return DETACHED_BRANCH_LABEL;
}

/**
 * Index into `branches` of the worktree containing `cwd`, or -1.
 *
 * Exported because the viewmodel needs exactly this to colour a session's name,
 * and a second implementation of "which branch is this session on" would
 * disagree with the chips on the first nested-worktree it met.
 */
export function branchIndexForCwd(
  branches: readonly BranchInfo[],
  cwd: string | undefined,
): number {
  const target = normalizeDir(cwd);
  if (target === '') return -1;
  let best = -1;
  let bestDepth = -1;
  for (let i = 0; i < branches.length; i++) {
    const dir = branches[i]?.dir;
    if (!dir || !isWithin(dir, target)) continue;
    const depth = pathKey(dir).length;
    if (depth > bestDepth) {
      bestDepth = depth;
      best = i;
    }
  }
  return best;
}

// ---------------------------------------------------------------- grouping

export interface GroupingInput {
  /** forest.visibleRoots, in tree order. */
  visibleRootIds: readonly string[];
  cwdOf(sessionId: string): string | undefined;
  projects: readonly ProjectRecord[];
  hiddenFolders: readonly string[];
  /** lineage.groupByFolder — applies to what is left over after projects. */
  groupByFolder: boolean;
  /** lineage.onlyProjectSessions — drop everything no project claims. Ignored
   *  when no project exists, or the tree would just be empty. */
  onlyProjectSessions: boolean;
  /**
   * M20. The git worktrees visible from `dir`, or [] for a directory that is
   * not a repository (and for one whose probe has not landed yet — the caller
   * cannot tell those apart, and must not need to).
   *
   * A FUNCTION rather than pre-resolved data because this module is pure and
   * synchronous: the implementation behind it is a cache that answers instantly
   * and refreshes itself in the background (src/git.ts), and grouping must
   * never be the thing that waits on a subprocess. Absent entirely in tests
   * that do not care about branches, which then behave exactly as before.
   */
  worktreesOf?: (dir: string) => readonly Worktree[];
}

/**
 * M26. Sessions of a project that the branch block does NOT account for.
 *
 * Under `lineage.groupSessionsByBranch` the shown branches take their own
 * sessions as children, and whatever is left has to stay visible directly under
 * the project: a session in a folded-away branch, one in a checkout git no
 * longer reports, one whose cwd is a project directory outside the repository
 * altogether. Dropping those would make a setting that "regroups rows" silently
 * a filter, which is the one thing a view option must never be.
 */
export function unbranchedRoots(
  rootIds: readonly string[],
  branches: readonly BranchInfo[],
): string[] {
  const claimed = new Set<string>();
  for (const branch of branches) {
    if (branch.shown === false) continue;
    for (const id of branch.rootIds) claimed.add(id);
  }
  return rootIds.filter((id) => !claimed.has(id));
}

export interface GroupingResult {
  /** Every VISIBLE project, depth-first: a parent immediately followed by its
   *  own subtree (M26). A caller that renders them flat gets the pre-M26 tree
   *  whenever nobody has nested anything, and a sensible reading list
   *  otherwise; a caller that renders the nesting walks `childProjectIds` from
   *  the entries whose `depth` is 0. */
  projects: ProjectGroupNode[];
  /** Folder rows for the leftovers. Empty when grouping does not apply. */
  folders: GroupNode[];
  /** Leftover roots rendered as bare session rows. */
  loose: string[];
  /** How many root sessions were removed by folder-hiding / project-only. */
  hiddenCount: number;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Chip-row equality, for the identity-reuse pass. Compares everything the row
 *  DRAWS — including each chip's session list, because that is what lights its
 *  attention dot — so a branch gaining an unseen session produces a fresh
 *  object and a repaint, and a poll tick that changed nothing does not. */
function sameBranches(
  a: readonly BranchInfo[] | undefined,
  b: readonly BranchInfo[] | undefined,
): boolean {
  const x = a ?? [];
  const y = b ?? [];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    if (
      x[i].name !== y[i].name ||
      x[i].dir !== y[i].dir ||
      x[i].colorIndex !== y[i].colorIndex ||
      x[i].primary !== y[i].primary ||
      x[i].shown !== y[i].shown ||
      !sameIds(x[i].rootIds, y[i].rootIds)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Split the visible roots into project rows, folder rows and loose rows.
 *
 * Order of the rules matters and is deliberate:
 *   1. project membership is checked FIRST, so a folder the user hid can still
 *      show its sessions through a project that explicitly lists it — the
 *      explicit statement outranks the blanket one;
 *   2. then folder-hiding removes what is left in a hidden directory;
 *   3. then onlyProjectSessions (if any project exists) removes the rest.
 *
 * Projects with no sessions are still rendered: the user created them on
 * purpose, and an empty project row is where "New Session in Project" lives.
 */
export function computeGrouping(
  input: GroupingInput,
  prev?: GroupingResult | null,
): GroupingResult {
  const all = (input?.projects ?? []).filter((p): p is ProjectRecord => !!p);
  // M26. The tree over ALL of them, closed ones included: a closed project
  // still owns its directories (see the session loop below), and its children
  // have to be reachable from it in order to be closed along with it.
  const tree = buildProjectTree(all);
  // CLOSING A PARENT CLOSES ITS SUBTREE. Anything else would be a lie about
  // what the gesture did: the subprojects would stay on screen as top-level
  // rows — promoted by the very act of putting their parent away — and closing
  // "app" would scatter its four services across the tree instead of taking
  // them with it. Reopening the parent brings the whole thing back, because
  // nothing was written on the children.
  const closed = new Set<string>();
  for (const id of tree.order) {
    const node = tree.byId.get(id);
    if (!node) continue;
    const inheritedlyClosed =
      node.parentId !== null && closed.has(node.parentId);
    if (node.project.hidden === true || inheritedlyClosed) closed.add(id);
  }
  const projects = all.filter((p) => !closed.has(p.id));
  const hiddenFolders = input?.hiddenFolders ?? [];
  const hasProjects = projects.length > 0;

  // Resolved ONCE per project, not once per session: `worktreesOf` is a cache
  // read, but the union-and-dedupe below is not free and a window with 40 live
  // sessions would otherwise run it 40 times over the same handful of projects.
  const worktreesByProject = new Map<string, Worktree[]>();
  for (const p of all) {
    worktreesByProject.set(p.id, projectWorktrees(p, input?.worktreesOf));
  }
  const extraDirs = (p: ProjectRecord): readonly string[] =>
    (worktreesByProject.get(p.id) ?? []).map((w) => w.dir);

  const claimed = new Map<string, string[]>(); // projectId -> rootIds
  for (const p of projects) claimed.set(p.id, []);

  const leftover: string[] = [];
  let hiddenCount = 0;

  for (const rootId of input?.visibleRootIds ?? []) {
    const cwd = input.cwdOf(rootId);
    // Matched against ALL projects, CLOSED ones included (M24 renamed the verb
    // that writes `hidden`; the rule is unchanged). A closed project still OWNS
    // its directories: if the winning match is closed, the session goes with
    // it. Otherwise closing a project would just demote its sessions to folder
    // rows, i.e. close nothing — and a closed project nested inside an open one
    // (close `api`, keep `code`) would leak straight back.
    const match = matchProject(all, cwd, extraDirs);
    if (match) {
      // `closed`, not `match.project.hidden`: M26 makes a subproject of a
      // closed project closed too, and its sessions have to go away with it
      // rather than reappear under a folder row.
      if (closed.has(match.project.id)) hiddenCount++;
      else claimed.get(match.project.id)?.push(rootId);
      continue;
    }
    if (isHiddenFolder(hiddenFolders, cwd)) {
      hiddenCount++;
      continue;
    }
    if (hasProjects && input.onlyProjectSessions) {
      hiddenCount++;
      continue;
    }
    leftover.push(rootId);
  }

  // Depth-first over the VISIBLE half of the tree (M26). `tree.order` is
  // already a preorder walk of every project, so filtering it keeps parents
  // ahead of their children and siblings in name order, which is exactly the
  // pre-M26 ordering whenever nothing is nested.
  const visible = new Set(projects.map((p) => p.id));
  const projectNodes: ProjectGroupNode[] = tree.order
    .filter((id) => visible.has(id))
    .map((id): ProjectGroupNode | null => {
      const node = tree.byId.get(id);
      // `visible` is built from the same tree, so this cannot miss — the guard
      // is here because a null node would otherwise take the whole view down.
      const p = node?.project ?? projects.find((x) => x.id === id);
      if (!p) return null;
      const dirs = projectDirs(p);
      const rootIds = claimed.get(p.id) ?? [];
      return {
        type: 'project',
        projectId: p.id,
        label: p.name,
        rootDir: dirs[0] ?? '',
        dirs,
        provider: providerOfProject(p),
        rootIds,
        branches: buildBranches(
          worktreesByProject.get(p.id) ?? [],
          rootIds,
          input.cwdOf,
          p,
        ),
        branchesCollapsed: p.branchesCollapsed === true,
        parentProjectId: node?.parentId ?? null,
        depth: node?.depth ?? 0,
        // Only the children that are themselves on screen. A closed child takes
        // its own subtree with it, so this can never name a row nobody draws.
        childProjectIds: (node?.childIds ?? []).filter((c) => visible.has(c)),
      } satisfies ProjectGroupNode;
    })
    .filter((n): n is ProjectGroupNode => n !== null);

  // Folder rows for the leftovers. The "fewer than two folders is just noise"
  // rule is kept from the folder-only design, but only when there is nothing
  // above them: next to project rows a single folder row reads as a peer, and
  // a bare session row there would look like it belonged to no address at all.
  const byKey = new Map<string, GroupNode>();
  if (input.groupByFolder) {
    for (const rootId of leftover) {
      const cwd = normalizeDir(input.cwdOf(rootId));
      const key = cwd === '' ? UNKNOWN_GROUP_KEY : cwd;
      let group = byKey.get(key);
      if (!group) {
        group = {
          type: 'group',
          key,
          cwd,
          label: cwd === '' ? UNKNOWN_GROUP_LABEL : baseName(cwd),
          rootIds: [],
        };
        byKey.set(key, group);
      }
      group.rootIds.push(rootId);
    }
  }

  const grouping =
    byKey.size >= 2 || (byKey.size === 1 && projectNodes.length > 0);

  const folders = grouping
    ? Array.from(byKey.values()).sort(
        (a, b) => cmp(a.label, b.label) || cmp(a.key, b.key),
      )
    : [];
  const loose = grouping ? [] : leftover.slice();

  const result: GroupingResult = {
    projects: projectNodes,
    folders,
    loose,
    hiddenCount,
  };
  return prev ? reuseUnchanged(result, prev) : result;
}

/**
 * Hand back the PREVIOUS object for any row whose content is byte-identical.
 * The workbench keys its internal node map on element identity, so reusing the
 * object is what stops every refresh from collapsing the user's expanded rows.
 */
function reuseUnchanged(
  next: GroupingResult,
  prev: GroupingResult,
): GroupingResult {
  const prevProjects = new Map(prev.projects.map((p) => [p.projectId, p] as const));
  const projects = next.projects.map((p) => {
    const old = prevProjects.get(p.projectId);
    if (
      old &&
      old.label === p.label &&
      old.rootDir === p.rootDir &&
      old.provider === p.provider &&
      sameIds(old.dirs, p.dirs) &&
      sameIds(old.rootIds, p.rootIds) &&
      old.branchesCollapsed === p.branchesCollapsed &&
      sameBranches(old.branches, p.branches) &&
      // M26. Everything the row's PLACE in the tree draws. Without these a
      // project that was moved, or that gained a subproject, would hand the
      // workbench the previous object and keep its old indent until something
      // else about it happened to change.
      (old.parentProjectId ?? null) === (p.parentProjectId ?? null) &&
      (old.depth ?? 0) === (p.depth ?? 0) &&
      sameIds(old.childProjectIds ?? [], p.childProjectIds ?? [])
    ) {
      return old;
    }
    return p;
  });

  const prevFolders = new Map(prev.folders.map((g) => [g.key, g] as const));
  const folders = next.folders.map((g) => {
    const old = prevFolders.get(g.key);
    if (
      old &&
      old.label === g.label &&
      old.cwd === g.cwd &&
      sameIds(old.rootIds, g.rootIds)
    ) {
      return old;
    }
    return g;
  });

  return { ...next, projects, folders };
}
