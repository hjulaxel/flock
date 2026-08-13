// src/projects.ts — projects, path matching and the grouping rules.
//
// Pure: it imports ./types and nothing else — no vscode, no node:path, no fs —
// so every rule in here is unit-testable without a workbench and can be called
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
  LocalBranch,
  ProjectGroupNode,
  ProjectRecord,
  ProviderId,
  SubprojectNode,
  SubprojectRecord,
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

/** The directory `p` sits in, or '' when there is nothing above it. Same
 *  no-node:path discipline as {@link baseName}, and used for the same one thing:
 *  telling two subprojects called `src` apart by what contains them. */
export function parentDir(p: string): string {
  const norm = normalizeDir(p);
  if (norm === '' || norm === '/') return '';
  const i = norm.lastIndexOf('/');
  if (i < 0) return '';
  return i === 0 ? '/' : norm.slice(0, i);
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

// --------------------------------------------------------------- subprojects
//
// A SUBPROJECT IS A DIRECTORY. That is the whole model, and it is worth stating
// plainly because it replaced one where a subproject was a project record filed
// under another project.
//
// What was wrong with the old one was not the tree — nesting drew fine — it was
// that a subproject was a full project in every other respect. It had its own
// name to invent, its own provider, its own AI account, its own saved workspace,
// its own settings menu, and its own directory that could be anywhere at all,
// including somewhere its parent had never heard of. Every one of those was a
// decision demanded of the user for something whose entire job was sorting rows,
// and together they were most of the reason a project's context menu had grown to
// fourteen entries.
//
// So: a project is scoped to ONE directory. Add a second and the project has two
// subprojects, one per directory, each holding the sessions running under it.
// There is nothing to name, nothing to configure, and nothing that can point
// somewhere surprising — the rows ARE the directories, so they cannot disagree
// with them.

/**
 * How many directories a project needs before its rows split up.
 *
 * TWO, for the reason BRANCH_CHIPS_MIN is two: at one directory there is nothing
 * to sort. Every project anybody has ever made has one, and giving each of them
 * a single subproject row — restating the project's own address, one level in,
 * above the same sessions that were there before — would cost a row per project
 * forever to say nothing. Below the threshold the tree is byte-identical to the
 * one before subprojects existed; add a directory and the split appears on its
 * own.
 */
export const SUBPROJECT_MIN = 2;

/**
 * The label each of a project's directories gets, disambiguated.
 *
 * The basename, which is what you call a directory — except that a monorepo
 * makes `api/src` and `web/src` an ordinary pair, and two rows both reading
 * `src` is a tree that cannot be used. Those get their parent prepended
 * (`api/src`), and anything STILL colliding after that gets the whole path,
 * because at that point the only honest label is the address itself.
 *
 * Case-insensitively, matching `pathKey`: on the two platforms this ships on,
 * `Src` and `src` are one name and would read as a duplicate on screen.
 */
export function subprojectLabels(dirs: readonly string[]): string[] {
  const bases = dirs.map((d) => baseName(d) || normalizeDir(d));
  const taken = (labels: readonly string[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const l of labels) {
      const key = l.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };

  const baseCounts = taken(bases);
  const second = dirs.map((d, i) => {
    if ((baseCounts.get(bases[i].toLowerCase()) ?? 0) < 2) return bases[i];
    const up = baseName(parentDir(d));
    return up === '' ? normalizeDir(d) : `${up}/${bases[i]}`;
  });

  const secondCounts = taken(second);
  return second.map((label, i) =>
    (secondCounts.get(label.toLowerCase()) ?? 0) < 2
      ? label
      : normalizeDir(dirs[i]),
  );
}

/**
 * A project's directories as rows, with its sessions filed into them.
 *
 * LONGEST MATCH WINS, exactly as project membership does (see matchProject) and
 * for the same reason: a project listing both `~/app` and `~/app/api` must put a
 * session in `~/app/api` under the api row, not under the one that merely
 * contains it. This is also what makes the v6 migration a no-op for the user —
 * a subproject that used to be its own record at `~/app/api` becomes a directory
 * at `~/app/api`, and its sessions land in the same place on screen.
 *
 * THERE IS NO PROJECT-WIDE ROOT. Once a project has directories, every session it
 * claims belongs to exactly one of them, and the main directory is not a bucket
 * for the ones that did not fit — it is directory number one and nothing more.
 * Making that true rather than merely stating it is what `worktreesOf` is for.
 *
 * The one way a session used to miss every directory was the common way: a linked
 * git WORKTREE. `matchProject` hands a project every checkout of every repository
 * its directories sit in (that is why an agent in `~/app-feat-x` is under the
 * project at `~/app` without anybody registering the path), and a rule that only
 * compared listed directories could not see those — so they piled into the main
 * row. So this asks the SAME question project membership asks, one level down:
 * a directory claims a session when the session is inside it, or inside a
 * checkout of the repository AT it.
 *
 * And it asks it about the MAIN CHECKOUT'S SPELLING of the path — see
 * canonicalCheckoutPath. A session in `~/app-feat-x/api`, in a linked worktree of
 * the monorepo at `~/app`, is working on `api`, so it belongs to the `api` row
 * rather than to whichever row happens to own the repository. Without that step a
 * split monorepo would send every worktree session to the main directory, which is
 * exactly the catch-all this design refuses.
 *
 * The `at < 0` fallback below is therefore unreachable through the product: any
 * cwd the project claimed, it claimed through one of these directories under this
 * same rule. It stays because the two rules are computed in different places from
 * different inputs (the grouping pass hands this function whatever `worktreesOf`
 * answered *this* tick, and a probe can land between the two), and because
 * dropping the row instead would make a stale cache a way to lose a running
 * agent. It is a bug-catcher, not a design feature — and a session sitting in the
 * main row that plainly is not inside it is the shape that bug would take.
 */
export interface SubprojectInput {
  project: ProjectRecord;
  rootIds: readonly string[];
  cwdOf: (sessionId: string) => string | undefined;
  /**
   * This project's NAMED lanes, in the order they were made. v7 — see
   * SubprojectRecord.
   *
   * Absent or empty is every project that has never used the feature, and gives
   * exactly the directory rows this function returned before lanes existed. The
   * caller filters by project; entries naming another one are ignored here anyway.
   */
  lanes?: readonly SubprojectRecord[];
  /**
   * The lane a session was STARTED in, from EditorialRecord.subprojectId, or
   * undefined for one that was not started in a lane.
   *
   * The only input that can tell two lanes on one directory apart, which is why it
   * exists at all: their directories are identical, so every derived rule answers
   * the same for both. Absent for every session that predates the field and every
   * one started by hand in a terminal — those are placed by directory, exactly as
   * they always have been.
   */
  stampOf?: (sessionId: string) => string | undefined;
  /**
   * The checkouts of the repository at one of this project's directories, MAIN
   * WORKTREE FIRST — which is the order `git worktree list` reports and
   * parseWorktreeList preserves (see src/git.ts). [] for a directory that is not
   * in a repository, and for one whose probe has not landed yet; the caller
   * cannot tell those apart and must not need to.
   *
   * Optional so every caller that does not care about worktrees — which is most
   * of the tests and every non-git project — behaves exactly as it did before this
   * argument existed.
   */
  worktreesOf?: (dir: string) => readonly Worktree[];
}

/** The identity of an implicit row: a directory with no lane named in it. Prefixed
 *  so it can never collide with a lane's uuid, and so a reader can tell the two
 *  kinds apart without consulting the store. See SubprojectNode.id. */
export const implicitSubprojectId = (dir: string): string =>
  `dir:${pathKey(dir)}`;

export function buildSubprojects(input: SubprojectInput): SubprojectNode[] {
  const project = input.project;
  const dirs = projectDirs(project);
  if (dirs.length === 0) return [];
  const labels = subprojectLabels(dirs);

  // The project's own lanes, in creation order, each with a usable name. A lane
  // whose name sanitized to '' still draws — the user can rename it — and takes
  // its directory's basename in the meantime, which is what an implicit row would
  // have said.
  const lanes = (input.lanes ?? []).filter(
    (l): l is SubprojectRecord =>
      !!l && l.deleted !== true && l.projectId === project.id && l.dir !== '',
  );

  const nodes: SubprojectNode[] = lanes.map((lane) => ({
    type: 'subproject',
    projectId: project.id,
    id: lane.id,
    name: lane.name,
    implicit: false,
    dir: normalizeDir(lane.dir),
    dirKey: pathKey(lane.dir),
    label: lane.name.trim() === '' ? baseName(lane.dir) : lane.name,
    // Never on a named lane: `main` marks the row standing for the project's own
    // address, which Remove Subproject refuses. Removing a LANE removes a name,
    // and is always allowed.
    main: false,
    rootIds: [],
  }));

  // One implicit row per DIRECTORY, lanes or no lanes. This is what keeps every
  // existing project's tree byte-identical: with no lanes at all, these are the
  // only nodes and they are the directory rows that were here before.
  //
  // A directory a lane already names gets one too, and it is the reason A NEW LANE
  // IS BORN EMPTY: the sessions that were in that folder before you typed the name
  // stay on the folder's own row, because a name you have just invented cannot
  // possibly describe work that predates it. The row is pruned again below the
  // moment it has nothing to hold, so naming every session's lane makes it go away
  // — it is a remainder, not a permanent leftover.
  const named = new Set(nodes.map((n) => n.dirKey));
  const implicitAt = new Map<string, number>();
  dirs.forEach((dir, i) => {
    const key = pathKey(dir);
    if (implicitAt.has(key)) return;
    implicitAt.set(key, nodes.length);
    nodes.push({
      type: 'subproject',
      projectId: project.id,
      id: implicitSubprojectId(dir),
      name: '',
      implicit: true,
      dir,
      dirKey: key,
      label: labels[i],
      main: i === 0,
      rootIds: [],
    });
  });

  // BELOW THE THRESHOLD THERE ARE NO ROWS, and the threshold now counts NODES
  // rather than directories — but a NAMED lane always earns its row. One
  // directory and no lanes is every project anybody has ever made, and giving it a
  // single row restating its own address would cost a row per project forever to
  // say nothing (see SUBPROJECT_MIN). One directory and one lane is different: you
  // typed that name on purpose, and the row is where its `+` and its branches live.
  if (nodes.length < SUBPROJECT_MIN && lanes.length === 0) return [];

  // Read ONCE per directory rather than once per session: `worktreesOf` is a
  // cache lookup, but a window with forty live sessions would otherwise run it
  // forty times over the same handful of directories.
  const checkouts = nodes.map((node) =>
    safeWorktrees(input.worktreesOf, node.dir),
  );
  const byId = new Map(nodes.map((node, i) => [node.id, i] as const));
  // Which node an unstamped session in a given directory belongs to: THE
  // DIRECTORY'S OWN ROW, never a lane. A lane is a name somebody typed, and the
  // only session it can be sure of is one that was started in it — so a lane holds
  // exactly its stamped sessions and nothing else, from the moment it is made.
  //
  // Falling back to the first lane instead would mean creating "Server rewrite"
  // silently swept every session already running in that folder into it, including
  // ones that are plainly the other lane's work. Nothing is orphaned by refusing
  // that: the folder's row is a subproject too, and it is where those sessions
  // already were.
  const defaultAt = new Map<string, number>(implicitAt);
  nodes.forEach((node, i) => {
    // Only reachable for a lane naming a directory the project no longer lists,
    // which has no implicit row to fall back to. Its own row is then the least
    // wrong home — the alternative is dropping the session.
    if (!defaultAt.has(node.dirKey)) defaultAt.set(node.dirKey, i);
  });

  for (const rootId of input.rootIds ?? []) {
    // THE STAMP FIRST. It is the user's own answer to a question nothing else can
    // answer, and it outranks every derived rule for the same reason an explicit
    // directory outranks an inferred worktree in matchProject.
    const stamped = byId.get(safeStamp(input.stampOf, rootId) ?? '');
    if (stamped !== undefined && !nodes[stamped].implicit) {
      nodes[stamped].rootIds.push(rootId);
      continue;
    }
    let cwd: string | undefined;
    try {
      cwd = input.cwdOf(rootId);
    } catch {
      // A cwd lookup that throws is a session with no address: it still belongs
      // to the project, so it goes to the main row rather than off the tree.
      cwd = undefined;
    }
    const at = subprojectIndexForCwd(nodes, checkouts, cwd);
    const home =
      at < 0
        ? // The bug-catcher above. The main DIRECTORY's row, which is a row this
          // session could plausibly be in — not nodes[0], which since lanes exist
          // may be a name somebody typed for something else entirely.
          (implicitAt.get(pathKey(dirs[0])) ?? 0)
        : (defaultAt.get(nodes[at].dirKey) ?? at);
    nodes[home].rootIds.push(rootId);
  }

  // A directory that has lanes keeps its own row only while it is HOLDING
  // something. That is the whole of the empty-row policy: the row exists to be
  // where the sessions nobody has assigned to a lane already are, so once there
  // are none it says nothing and goes. File every session into a lane and the
  // folder row disappears; start one by hand in that folder tomorrow and it comes
  // back, holding it, rather than that session being guessed into a lane.
  //
  // A directory with NO lane always keeps its row, sessions or none — that is the
  // pre-v7 tree, where a directory you added is a row whether or not you have run
  // anything in it yet.
  return nodes.filter(
    (node) =>
      !(node.implicit && named.has(node.dirKey) && node.rootIds.length === 0),
  );
}

/** `stampOf`, defended. A lookup that throws is a session with no stamp, which is
 *  the ordinary case for everything Flock did not start. */
function safeStamp(
  stampOf: ((sessionId: string) => string | undefined) | undefined,
  sessionId: string,
): string | undefined {
  if (!stampOf) return undefined;
  try {
    return stampOf(sessionId) ?? undefined;
  } catch {
    return undefined;
  }
}

/** `worktreesOf`, defended. A probe that throws is a directory with no checkouts
 *  — the same answer a non-git directory gives — and must not take the grouping
 *  pass down with it. */
function safeWorktrees(
  worktreesOf: ((dir: string) => readonly Worktree[]) | undefined,
  dir: string,
): readonly Worktree[] {
  if (!worktreesOf) return [];
  try {
    return worktreesOf(dir) ?? [];
  } catch {
    return [];
  }
}

/** `localBranchesOf`, defended, for the same reason and with the same answer: a
 *  directory whose enumeration failed has no fold under it, which is how a
 *  non-git directory already renders. */
function safeLocalBranches(
  localBranchesOf: ((dir: string) => readonly LocalBranch[]) | undefined,
  dir: string,
): readonly LocalBranch[] {
  if (!localBranchesOf) return [];
  try {
    return localBranchesOf(dir) ?? [];
  } catch {
    return [];
  }
}

/**
 * Where a path inside a LINKED worktree would sit in the main checkout.
 *
 * `~/app-feat-x/api/handlers`, in a repository whose main worktree is `~/app`,
 * is `~/app/api/handlers`. That is the path the project's directory list was
 * written against: somebody who splits a monorepo into `api` and `web` names the
 * directories once, in the checkout they were looking at, and every other
 * checkout of that repository has the same shape under a different prefix.
 *
 * Returns '' when there is nothing to translate — not a repository, no linked
 * worktree containing the path, or a path already in the main checkout — and the
 * caller then has nothing extra to consider. LONGEST checkout wins, because
 * `git worktree add` is perfectly capable of putting one checkout inside another
 * and the deeper prefix is the one the path is actually in.
 *
 * Sliced on the NORMALIZED spellings so the offset is meaningful: `isWithin`
 * compares case-folded prefixes of exactly these strings, so a match guarantees
 * the prefix is that many characters long. The case of what comes back is the
 * main worktree's own plus the tail as the session spelled it, which is the pair
 * every other comparison here is already case-insensitive about.
 */
export function canonicalCheckoutPath(
  checkouts: readonly Worktree[],
  cwd: string | undefined,
): string {
  const target = normalizeDir(cwd);
  if (target === '' || checkouts.length === 0) return '';
  const root = normalizeDir(checkouts[0]?.dir);
  if (root === '') return '';

  let best = '';
  for (const wt of checkouts) {
    const dir = normalizeDir(wt?.dir);
    if (dir === '' || !isWithin(dir, target)) continue;
    if (dir.length > best.length) best = dir;
  }
  // Nothing contains it, or the main checkout itself does — either way the
  // path needs no second spelling.
  if (best === '' || pathKey(best) === pathKey(root)) return '';
  return `${root}${target.slice(best.length)}`;
}

/**
 * Which directory row a session belongs to, or -1.
 *
 * Two passes over the same question, and the order between them is the whole
 * rule: a directory that CONTAINS the session outranks one that merely owns the
 * repository the session is checked out from. That mirrors matchProject's own
 * tie-break — an explicit statement beats an inference — one level down.
 *
 * Within a pass, deeper wins; at equal depth, the earlier directory wins, which
 * makes the answer stable and puts a genuine tie on the main directory (the same
 * choice every project-level verb makes).
 */
function subprojectIndexForCwd(
  nodes: readonly SubprojectNode[],
  checkouts: readonly (readonly Worktree[])[],
  cwd: string | undefined,
): number {
  const target = normalizeDir(cwd);
  if (target === '') return -1;

  const deepestContaining = (path: string): number => {
    let at = -1;
    let deepest = -1;
    for (let i = 0; i < nodes.length; i++) {
      if (!isWithin(nodes[i].dir, path)) continue;
      const depth = nodes[i].dirKey.length;
      if (depth > deepest) {
        deepest = depth;
        at = i;
      }
    }
    return at;
  };

  const direct = deepestContaining(target);
  if (direct >= 0) return direct;

  // Nothing lists a directory containing it. Ask again as the main checkout
  // would spell it, once per repository this project touches — two directories in
  // one repository produce the same translation, so the answer does not depend on
  // which of them is asked first.
  for (let i = 0; i < nodes.length; i++) {
    const canonical = canonicalCheckoutPath(checkouts[i] ?? [], target);
    if (canonical === '') continue;
    const derived = deepestContaining(canonical);
    if (derived >= 0) return derived;
  }

  // A checkout of a repository one of these directories sits in, whose path maps
  // nowhere they list — the repository's own root is outside the project, say.
  // The directory that owns the repository is the honest answer.
  for (let i = 0; i < nodes.length; i++) {
    for (const wt of checkouts[i] ?? []) {
      if (isWithin(normalizeDir(wt?.dir), target)) return i;
    }
  }
  return -1;
}

/**
 * v6: every nested project record folded into its top-level ancestor.
 *
 * Pure, and separate from the write for the usual reason — the RULES are worth
 * testing without a store — but also because this is the one migration in the
 * ladder that destroys something. A child's directories survive (they become the
 * ancestor's, which is what puts its sessions back on screen in the same place);
 * its NAME, provider, account override, saved workspace and closed-ness do not.
 * That is the cost of the model change and it is paid once, here, where it can be
 * read.
 *
 * Directories are collected in tree preorder — the ancestor's own first, then
 * each descendant's in display order — so the ancestor's `rootDir` never moves.
 * A project's main directory is what every project-level verb defaults to, and a
 * migration that silently re-pointed it would change where `+` starts a session.
 *
 * Deduped on `pathKey`, because a parent and child listing the same directory is
 * exactly the arrangement the old model tolerated (the deeper record won the tie)
 * and the new one has no room for.
 */
export interface FlattenedProjects {
  /** Ancestors whose directory list changed, with the list to write. */
  merged: { id: string; rootDir: string; dirs: string[] }[];
  /** Records to tombstone: every project that was filed under another one. */
  removed: string[];
}

export function flattenNestedProjects(
  projects: readonly ProjectRecord[],
): FlattenedProjects {
  const live = (projects ?? []).filter(
    (p): p is ProjectRecord => !!p?.id && p.deleted !== true,
  );
  const tree = buildProjectTree(live);
  const merged: FlattenedProjects['merged'] = [];
  const removed: string[] = [];

  for (const rootId of tree.roots) {
    const subtree = projectSubtree(tree, rootId);
    if (subtree.length < 2) continue; // nothing filed under it

    const dirs: string[] = [];
    const seen = new Set<string>();
    for (const id of subtree) {
      const p = tree.byId.get(id)?.project;
      if (!p) continue;
      for (const dir of projectDirs(p)) {
        const key = pathKey(dir);
        if (key === '' || seen.has(key)) continue;
        seen.add(key);
        dirs.push(dir);
      }
    }
    // A root with no usable directory of its own cannot be written (the store's
    // sanitizer drops a project with no rootDir), so leave the whole subtree
    // alone rather than half-migrate it. Unreachable through the product —
    // `newProjectFlow` refuses an empty directory — and reachable by hand-editing
    // state.json, which is exactly the case this guard is for.
    if (dirs.length === 0) continue;

    merged.push({ id: rootId, rootDir: dirs[0], dirs: dirs.slice(1) });
    for (const id of subtree.slice(1)) removed.push(id);
  }
  return { merged, removed };
}

// ------------------------------------------------------------ project tree
// A project may be filed under another project, to any depth and any
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

/**
 * The project that already lists `dir` itself, by exact path — or undefined.
 *
 * THE FAILURE THIS EXISTS TO REFUSE. Membership is containment, and the deepest
 * claim wins (see matchProject), so two projects listing the SAME directory is
 * the one arrangement the model has no answer for: the tie breaks on name, which
 * means every session in that directory belongs to whichever project sorts
 * first, and the other one displays nothing while still claiming everything.
 *
 * A subproject is where this used to happen by accident. Its directory pick opens
 * inside its parent, so accepting the dialog without navigating anywhere chose
 * the parent's OWN directory — and the new subproject then took the parent's
 * whole session list with it, which is not a thing anybody asks a new, empty
 * project to do.
 *
 * Exact paths only, deliberately. A subproject rooted at `app/api` SHOULD take
 * the sessions running under `app/api` off its parent — that is the entire
 * feature, and nesting by containment is how a project spanning a monorepo is
 * meant to be split up. What is refused is the duplicate claim, not the deeper
 * one.
 */
export function projectClaiming(
  projects: readonly ProjectRecord[],
  dir: string,
  /** Ignore this project — the one being edited, which is allowed to already
   *  list the directory it is being asked to keep. */
  exceptId?: string,
): ProjectRecord | undefined {
  const target = pathKey(normalizeDir(dir));
  if (target === '') return undefined;
  for (const project of projects ?? []) {
    if (!project || project.id === exceptId) continue;
    if (project.deleted === true) continue;
    for (const own of projectDirs(project)) {
      if (pathKey(own) === target) return project;
    }
  }
  return undefined;
}

export interface ProjectMatch {
  project: ProjectRecord;
  /** The specific directory of the project that matched. */
  dir: string;
  /** Length of the matched directory key — the tie-break for nesting. */
  depth: number;
  /** The matched directory is one the project LISTS, rather than one it
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
   * Directories a project owns WITHOUT having them listed — the worktrees
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
 * which is either a user mistake (the same path listed twice) or the nesting
 * case: a project and a subproject inside it, both of which see the same git
 * worktrees. Three rules, each with its own reason, then the stable name/id
 * fallback so the answer never depends on iteration order:
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
 * Every CHAT this project has ever had, newest first.
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

/**
 * Should this branch be on screen under a DIRECTORY row, absent any decision by
 * the user?
 *
 * The directory model's policy, and it is narrower than defaultBranchVisibility
 * on purpose — narrower because the list it curates is so much longer. That one
 * chose among a project's CHECKOUTS, of which there are two or six; this one
 * chooses among a repository's BRANCHES, of which there are eighty, and a rule
 * that promoted every checkout would put the ten stale worktrees somebody forgot
 * to prune above the sessions they are trying to read.
 *
 * So exactly two things earn a row outside the fold:
 *
 *   - the checkout AT this directory row. That branch is what the row currently
 *     IS: hiding a directory's own branch inside a fold labelled "everything
 *     else" would be hiding the row's own address from it.
 *   - a branch something is RUNNING on. This is the one the user asked for in so
 *     many words, and it is the same instinct defaultBranchVisibility had: a live
 *     agent whose row you cannot see is the worst outcome this feature could
 *     produce.
 *
 * Everything else folds — INCLUDING a checkout with nothing running in it, which
 * is the deliberate difference from the older policy. A worktree you are not
 * using this week is a directory on disk, not a piece of work in flight, and it
 * is one click away in the fold with its age beside it.
 *
 * Not a memory: recomputed every render, so a branch that goes quiet drops back
 * into the fold. `shownBranches` is how a user keeps one regardless.
 */
export function directoryBranchVisibility(branch: {
  dir: string;
  rootIds: readonly string[];
  ownCheckout: boolean;
}): boolean {
  if (branch.ownCheckout) return true;
  return branch.rootIds.length > 0;
}

/**
 * Every branch of the repository at ONE directory, as rows: promoted first, then
 * the fold's contents.
 *
 * This is the directory model's answer to buildBranches, and the differences are
 * the feature:
 *
 *   1. IT LISTS THE REPOSITORY, not the checkouts. `localBranches` is every
 *      `refs/heads/` entry (src/branchList.ts), so a branch nobody has checked
 *      out still gets a row — with `dir: ''`, because there is no directory to
 *      start a session in and the row offers a worktree instead.
 *   2. IT IS ANCHORED ON ONE DIRECTORY, so `primary` stops meaning "the
 *      repository's main worktree" as the only distinguished row and `ownCheckout`
 *      — the checkout AT this directory — becomes the one that matters. For a
 *      project whose directory IS the repository root those are the same branch;
 *      for a project pointed at `~/app/api` inside a monorepo, or at a linked
 *      worktree, they are not, and the row's own branch is the one it should lead
 *      with.
 *   3. IT DOES NOT DROP ANYTHING. Every branch is in the returned list; `shown`
 *      says which side of the fold it is on. A caller that ignores `shown`
 *      renders the whole repository, which is what makes the fold a layout rather
 *      than a filter.
 *
 * ORDER, which is the whole of the colour contract (see buildBranches): the
 * directory's own checkout first — so it keeps colour 0 for as long as it is
 * checked out there — then the rest of the promoted rows alphabetically, then the
 * fold NEWEST COMMIT FIRST. Recency is what makes a long fold navigable, and it
 * is only applied where the list is long: the promoted rows are few and are
 * scanned by name.
 */
export function buildDirectoryBranches(input: {
  /** The directory row this list hangs under. Its own checkout leads. */
  dir: string;
  /** `git worktree list` for that directory, main worktree first. */
  worktrees: readonly Worktree[];
  /** Every local branch of the same repository, from src/branchList.ts. Absent
   *  or empty gives a checkouts-only list, which is what a window shows in the
   *  moment before the enumeration lands. */
  localBranches?: readonly LocalBranch[];
  /** Sessions filed under this directory row. */
  rootIds: readonly string[];
  cwdOf: (sessionId: string) => string | undefined;
  /** For `shownBranches` / `hiddenBranches`. Curation is the PROJECT's, not the
   *  directory's: the lists are stored per project record, and a branch name is
   *  distinctive enough that pinning `feat/x` in a project with two repositories
   *  pinning it in both is a smaller surprise than a second pair of lists to
   *  keep. */
  project?: ProjectRecord;
}): BranchInfo[] {
  const own = pathKey(input.dir);
  const checkouts = dedupeWorktrees(input.worktrees);
  if (checkouts.length === 0 && (input.localBranches ?? []).length === 0) {
    return [];
  }

  interface Draft {
    name: string;
    dir: string;
    primary: boolean;
    ownCheckout: boolean;
    rootIds: string[];
    lastCommitAt?: number;
  }

  const drafts: Draft[] = checkouts.map((wt, index) => ({
    name: branchLabel(wt),
    dir: wt.dir,
    // Git lists the main worktree first, so index 0 is the repository's own root.
    primary: index === 0,
    ownCheckout: own !== '' && pathKey(wt.dir) === own,
    rootIds: [],
  }));

  // A directory that is in a repository but is not itself a checkout — `~/app/api`
  // inside the monorepo at `~/app` — has no own checkout among the worktrees. The
  // repository's main worktree is the row's branch in that case: it is the
  // checkout the directory is physically inside.
  if (!drafts.some((d) => d.ownCheckout)) {
    const inside = drafts.find((d) => isWithin(d.dir, input.dir));
    if (inside) inside.ownCheckout = true;
  }

  const byName = new Map<string, Draft>();
  for (const draft of drafts) byName.set(draft.name, draft);

  // Every ref that has no checkout. A branch already drafted from a worktree is
  // skipped rather than duplicated, and picks up its commit date on the way past —
  // the age is a fact about the branch, not about whether it has a directory.
  for (const local of input.localBranches ?? []) {
    const name = typeof local?.name === 'string' ? local.name.trim() : '';
    if (name === '') continue;
    const existing = byName.get(name);
    if (existing) {
      existing.lastCommitAt = local.committedAt;
      continue;
    }
    const draft: Draft = {
      name,
      dir: '',
      primary: false,
      ownCheckout: false,
      rootIds: [],
      lastCommitAt: local.committedAt,
    };
    byName.set(name, draft);
    drafts.push(draft);
  }

  // Sessions land on the CHECKOUT that contains them, longest match first — the
  // same rule as everywhere else here. A branch with no checkout can hold no
  // session, which is exactly why it cannot be promoted by one.
  for (const rootId of input.rootIds ?? []) {
    let cwd: string | undefined;
    try {
      cwd = input.cwdOf(rootId);
    } catch {
      cwd = undefined;
    }
    const at = branchIndexForCwd(drafts, cwd);
    if (at >= 0) drafts[at].rootIds.push(rootId);
  }

  const hidden = input.project?.hiddenBranches ?? [];
  const pinned = input.project?.shownBranches ?? [];
  const isShown = (draft: Draft): boolean => {
    if (hidden.includes(draft.name)) return false;
    if (pinned.includes(draft.name)) return true;
    return directoryBranchVisibility(draft);
  };

  const promoted = drafts.filter(isShown);
  const folded = drafts.filter((d) => !isShown(d));

  promoted.sort((a, b) => {
    // The row's own branch leads, whatever it is called.
    if (a.ownCheckout !== b.ownCheckout) return a.ownCheckout ? -1 : 1;
    return cmp(a.name.toLowerCase(), b.name.toLowerCase()) || cmp(a.dir, b.dir);
  });
  folded.sort(
    (a, b) =>
      // Newest first. An unread date is 0 and sorts last, which is where a
      // branch we know nothing about belongs.
      (b.lastCommitAt ?? 0) - (a.lastCommitAt ?? 0) ||
      cmp(a.name.toLowerCase(), b.name.toLowerCase()),
  );

  return [...promoted, ...folded].map((draft, position) => ({
    name: draft.name,
    dir: draft.dir,
    colorIndex: position % BRANCH_COLOR_COUNT,
    rootIds: draft.rootIds,
    primary: draft.primary,
    shown: isShown(draft),
    ...(draft.lastCommitAt === undefined ? {} : { lastCommitAt: draft.lastCommitAt }),
  }));
}

/**
 * Every branch a PROJECT can currently offer a verb, wherever the rows put it.
 *
 * The join between the two layouts, and the reason it exists is a verb rather than
 * a row: **New Worktree…** and **Remove Worktree** reach a project from the
 * command palette with no row to start from, and they resolve their target against
 * the branch list the view is showing (`getBranches`). Under the directory model a
 * split project's own `branches` is empty — its directories carry them — so a
 * palette verb reading only the project node would be told the repository has no
 * checkouts and refuse.
 *
 * The project's own list when it has one; otherwise the union of its directories',
 * in directory order. Deduped on NAME AND DIRECTORY together: two directories of
 * one repository report the same checkouts (that is one entry), and two directories
 * in two repositories can each have a `main` at a different path (that is two,
 * because they are two places a session can run).
 */
export function projectBranchList(
  node:
    | {
        branches?: readonly BranchInfo[];
        subprojects?: readonly { branches?: readonly BranchInfo[] }[];
      }
    | undefined,
): readonly BranchInfo[] {
  const own = node?.branches ?? [];
  if (own.length > 0) return own;
  const out: BranchInfo[] = [];
  const seen = new Set<string>();
  for (const sub of node?.subprojects ?? []) {
    for (const branch of sub?.branches ?? []) {
      if (!branch) continue;
      // A SPACE delimits the two halves: `git check-ref-format` forbids one in a
      // ref name, so the first space always ends the name however many the path
      // then contains. Deliberately not a control character — see the note on
      // hasControlChar in src/commands.ts for what a literal one in a source file
      // costs.
      const key = `${branch.name} ${pathKey(branch.dir)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(branch);
    }
  }
  return out;
}

/** The same normalize-and-dedupe pass projectWorktrees makes, for one directory:
 *  the same checkout reported twice would be the same branch twice. */
function dedupeWorktrees(worktrees: readonly Worktree[]): Worktree[] {
  const out: Worktree[] = [];
  const seen = new Set<string>();
  for (const wt of worktrees ?? []) {
    const dir = normalizeDir(wt?.dir);
    if (dir === '') continue;
    const key = pathKey(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      dir,
      branch: typeof wt.branch === 'string' ? wt.branch : '',
      head: typeof wt.head === 'string' ? wt.head : '',
      detached: wt.detached === true,
    });
  }
  return out;
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
  /** Anything with a `dir`. Widened from BranchInfo so the drafts inside
   *  buildDirectoryBranches can be filed by the same function that files the
   *  finished ones — two implementations of "which checkout is this session in"
   *  would disagree on the first nested worktree they met. */
  branches: readonly { dir: string }[],
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
   * The git worktrees visible from `dir`, or [] for a directory that is
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
  /**
   * `lineage.git.branches` — whether a project gets BRANCH ROWS at all.
   *
   * THE ONE GATE. Off, every project's `branches` is empty, which is the same
   * state a non-git project has always been in: no rows, no colours, no fold, no
   * "Others", and every downstream reader already handles it because it is the
   * ordinary case. That is why the switch lives here rather than in the two
   * renderers — one place to turn it off, and no surface can disagree with the
   * other about whether the feature is on.
   *
   * Absent reads as OFF, matching the setting's default. Note that this does NOT
   * gate `worktreesOf`: worktree-derived MEMBERSHIP still runs, so a session in a
   * linked checkout stays under the project that owns the repository. Hiding the
   * rows must not move anybody's sessions.
   */
  branchRows?: boolean;
  /* There was a second gate onto this list once — the session-line switch, which
   * needed the branch list without wanting the rows. It is gone with the switch:
   * the line and the colours are two MODES of one feature now
   * (`lineage.git.branchDisplay`), and `branchRows` is the single thing that
   * decides whether any of it is built. One gate, so no caller has to reason
   * about which half of a feature it just turned on. */
  /**
   * The local branches of the repository at `dir` — every `refs/heads/` entry,
   * not only the checked-out ones. From the cache in src/branchList.ts, and
   * synchronous by the same contract `worktreesOf` has: grouping must never be
   * the thing that waits on a subprocess.
   *
   * Absent gives a checkouts-only branch list, which is both what a window shows
   * in the moment before the enumeration lands and what every test that does not
   * care about branch rows already describes.
   */
  localBranchesOf?: (dir: string) => readonly LocalBranch[];
  /**
   * Every NAMED subproject, from the store. v7 — see SubprojectRecord.
   *
   * Absent or empty means no project has lanes, which is every store before v7 and
   * every project that has not used the feature: the rows are then exactly the
   * directory rows this pass has always produced.
   */
  subprojects?: readonly SubprojectRecord[];
  /**
   * The lane a session was started in — EditorialRecord.subprojectId.
   *
   * Kept out of the session's own record shape and passed as a lookup for the same
   * reason `cwdOf` is: this module is pure, and the forest it is handed carries
   * roster facts rather than editorial ones.
   */
  stampOf?: (sessionId: string) => string | undefined;
  /**
   * `lineage.preview.directoryModel` — branches hang off DIRECTORY rows.
   *
   * The whole of the preview switch, in one place for the reason `branchRows` is:
   * one gate, and no renderer can disagree with another about whether the feature
   * is on. Off (the default), every project's branch block is built exactly as it
   * was — a per-project union of checkouts under the project row — and each
   * subproject's `branches` is empty, which is the state every existing reader
   * already handles because it is the ordinary case.
   *
   * On, the two swap places: a project with one directory keeps its branches on
   * the project row (that row IS its directory), and a project with several puts
   * each repository's branches under the directory it belongs to.
   */
  directoryModel?: boolean;
}

/**
 * Sessions of a project that the branch block does NOT account for.
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
   *  own subtree. A caller that renders them flat gets the same order the
   *  older, non-nesting tree had whenever nobody has nested anything, and a
   *  sensible reading list otherwise; a caller that renders the nesting walks
   *  `childProjectIds` from the entries whose `depth` is 0. */
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

/** Subproject equality, for the identity-reuse pass. Same contract as
 *  {@link sameBranches}: everything the rows DRAW, session lists included, so a
 *  session moving from one directory to another repaints both rows and a poll
 *  tick that changed nothing repaints neither. */
function sameSubprojects(
  a: readonly SubprojectNode[] | undefined,
  b: readonly SubprojectNode[] | undefined,
): boolean {
  const x = a ?? [];
  const y = b ?? [];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    if (
      x[i].dirKey !== y[i].dirKey ||
      x[i].dir !== y[i].dir ||
      x[i].label !== y[i].label ||
      x[i].main !== y[i].main ||
      !sameIds(x[i].rootIds, y[i].rootIds) ||
      // The directory's own branch block, which under the directory model is most
      // of what the row draws. Without this a branch appearing under one
      // directory would hand the workbench the previous node and keep the old
      // rows until something else about the directory happened to change.
      !sameBranches(x[i].branches, y[i].branches)
    ) {
      return false;
    }
  }
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
      // The age the fold draws. Changes exactly when somebody commits to the
      // branch, which is exactly when the row is out of date.
      x[i].lastCommitAt !== y[i].lastCommitAt ||
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
  // The tree over ALL of them, closed ones included: a closed project
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
  // Read once, here, so every decision below asks the same two questions of the
  // same two answers.
  const branchRows = input?.branchRows === true;
  const directoryModel = input?.directoryModel === true;
  // ONE GATE. Both display modes read the same branch list — the colours key off
  // it, the line under a session names one entry of it — so the question is only
  // ever "did the user turn the branch feature on", which is `branchRows`.
  const anyBranchGate = branchRows;
  // The named lanes, bucketed by project ONCE. The store hands them over in
  // project-then-creation order, and that order is the row order, so bucketing
  // preserves it.
  const lanesByProject = new Map<string, SubprojectRecord[]>();
  for (const lane of input?.subprojects ?? []) {
    if (!lane || lane.deleted === true) continue;
    const list = lanesByProject.get(lane.projectId);
    if (list) list.push(lane);
    else lanesByProject.set(lane.projectId, [lane]);
  }

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
    // Matched against ALL projects, CLOSED ones included (the user-facing verb
    // is "close"; the field it writes is still called `hidden`). A closed
    // project still OWNS its directories: if the winning match is closed, the
    // session goes with it. Otherwise closing a project would just demote its
    // sessions to folder rows, i.e. close nothing — and a closed project nested
    // inside an open one (close `api`, keep `code`) would leak straight back.
    const match = matchProject(all, cwd, extraDirs);
    if (match) {
      // `closed`, not `match.project.hidden`: a subproject of a closed project
      // is closed too, and its sessions have to go away with it rather than
      // reappear under a folder row.
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

  // Depth-first over the VISIBLE half of the tree. `tree.order` is already a
  // preorder walk of every project, so filtering it keeps parents ahead of
  // their children and siblings in name order — which, whenever nothing is
  // nested, is exactly the flat name-ordered list the tree had before nesting
  // existed.
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
      // The project's NAMED lanes, plus one row per directory nobody named a lane
      // in — which for a project that has never used lanes is exactly the directory
      // rows this tree has always drawn. Independent of the branch block (a project
      // can be split whether or not it is a repository) but NOT independent of its
      // worktrees: the same checkouts that make a session this project's are what
      // decide which of its rows the session belongs to, so that there is nothing
      // left over. See buildSubprojects.
      const subprojects = buildSubprojects({
        project: p,
        rootIds,
        cwdOf: input.cwdOf,
        lanes: lanesByProject.get(p.id) ?? [],
        ...(input.stampOf === undefined ? {} : { stampOf: input.stampOf }),
        ...(input.worktreesOf === undefined
          ? {}
          : { worktreesOf: input.worktreesOf }),
      });
      // THE DIRECTORY MODEL'S ONE STRUCTURAL CHOICE, made here so that neither
      // renderer can make it differently: a project with several directories puts
      // each repository's branches under the directory it belongs to, and one with
      // a single directory keeps them on the project row — because that row IS its
      // directory. Both halves read the same builder, so the only difference
      // between them is which rows hold the result.
      const directoryBranches = directoryModel && branchRows;
      if (directoryBranches) {
        for (const sub of subprojects) {
          sub.branches = buildDirectoryBranches({
            dir: sub.dir,
            worktrees: safeWorktrees(input?.worktreesOf, sub.dir),
            localBranches: safeLocalBranches(input?.localBranchesOf, sub.dir),
            rootIds: sub.rootIds,
            cwdOf: input.cwdOf,
            project: p,
          });
        }
      }
      return {
        type: 'project',
        projectId: p.id,
        label: p.name,
        rootDir: dirs[0] ?? '',
        dirs,
        provider: providerOfProject(p),
        rootIds,
        subprojects,
        // Empty unless `lineage.git.branches` is on. Deliberately still built
        // from the same worktree data when it IS on, so turning the setting on
        // is the only difference between the two trees.
        //
        // A non-empty list still does NOT mean branch ROWS: the renderer keeps
        // its own half of the gate (ViewModelInput.branchBlock), and in inline
        // mode the block is shut by default — so most of the time this list
        // exists to be looked up by the line under a session and never drawn.
        //
        // Under the directory model a SPLIT project's branches live on its
        // directory rows instead, so this is empty for exactly the projects whose
        // subprojects now carry them — nothing is drawn twice and nothing is lost.
        branches: !anyBranchGate
          ? []
          : directoryBranches
            ? subprojects.length > 0
              ? []
              : buildDirectoryBranches({
                  dir: dirs[0] ?? '',
                  worktrees: safeWorktrees(input?.worktreesOf, dirs[0] ?? ''),
                  localBranches: safeLocalBranches(
                    input?.localBranchesOf,
                    dirs[0] ?? '',
                  ),
                  rootIds,
                  cwdOf: input.cwdOf,
                  project: p,
                })
              : buildBranches(
                  worktreesByProject.get(p.id) ?? [],
                  rootIds,
                  input.cwdOf,
                  p,
                ),
        // PASSED THROUGH, tri-state and all. `=== true` here was the bug that
        // made "shut until you ask" not work: it collapsed *never asked* and
        // *explicitly opened* into one `false`, and the renderer needs to tell
        // them apart — absent means the block has never been asked for and stays
        // shut, `false` is the record **Show Branches** writes.
        ...(p.branchesShown === undefined
          ? {}
          : { branchesShown: p.branchesShown }),
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
      old.branchesShown === p.branchesShown &&
      sameBranches(old.branches, p.branches) &&
      sameSubprojects(old.subprojects, p.subprojects) &&
      // Everything the row's PLACE in the tree draws. Without these a
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
