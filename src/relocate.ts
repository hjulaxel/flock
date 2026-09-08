// src/relocate.ts — a project whose folder MOVED, and how Flock follows it.
//
// THE FAILURE THIS EXISTS FOR. A project owns directories by path and nothing
// else, so a folder that is moved on disk takes the whole project with it and
// leaves the record pointing at nothing. Every consequence is silent: the
// Explorer skips a missing directory, membership (a longest-path match) stops
// matching, and a launch into a cwd that is not there gets a shell that exits
// at once. On 2026-09-08 `research/ai-builder/plc-meeting` had become
// `research/plc-meeting`, and the project answered New Session with nothing
// whatsoever — four times, leaving four dead rows.
//
// The launch is refused by name now (terminals.directoryIsGone), which says
// WHAT is wrong. This module is the other half: where the folder went.
//
// WHY A MOVE CAN BE FOLLOWED AT ALL. A directory that moved keeps its name —
// that is what separates a move from a rename, and a rename is not something
// this can or should chase: a folder called something else, somewhere else, is
// indistinguishable from a different folder. So the rule is narrow on purpose:
// the same BASENAME, on an existing path, nearest to where the folder used to
// be. The caller supplies the candidates (it walks the filesystem; this module
// never touches it), and everything decided about them is here, pure.
//
// AMBIGUITY IS AN ANSWER. Two directories called `plc-meeting` equally close to
// the old path are not a 50/50 guess to take — repointing a project rewrites
// what every session in it belongs to, so the honest answer is to say there
// are two and let the person pick. `none` and `ambiguous` are outcomes the
// caller must render, not failures to swallow.
//
// FOLLOWING IS A PREFIX REWRITE, AND IT INCLUDES THE SESSIONS. A project that
// followed its folder while its own history stayed behind would be the feature
// half-done: membership is derived from each session's cwd, so the rows would
// leave the project on the way past. Everything at or under the old path moves
// with it — the project's own directories, the directories of any SUBPROJECT
// filed under it (they are ordinary projects with their own paths), and the
// recorded cwd of every session that ever ran there. One fact — that directory
// is over here now — applied everywhere it was written down.

import { isWithin, normalizeDir, pathKey } from './projects';
import type { EditorialRecord, ProjectRecord } from './types';

/** Where a candidate came from. Kept because the report says it ("found beside
 *  the old path" reads differently from "a session is running there"), and
 *  because a directory a session is ALREADY running in is the strongest
 *  evidence there is: something opened it after the move. */
export type RelocationSource = 'search' | 'session';

export interface RelocationCandidate {
  dir: string;
  source: RelocationSource;
}

export type RelocationPlan =
  /** One convincing answer. */
  | { kind: 'found'; dir: string; source: RelocationSource }
  /** Several, equally good. The caller asks. */
  | { kind: 'ambiguous'; dirs: string[] }
  /** Nowhere it could be. The caller offers the folder picker. */
  | { kind: 'none' };

/** How many leading path segments two paths share. The move measure: a folder
 *  that went up one level, down one, or sideways into a sibling keeps almost
 *  all of its path, and the candidate that kept the most of it is the one that
 *  moved the least. */
function sharedDepth(a: string, b: string): number {
  const left = pathKey(a).split('/');
  const right = pathKey(b).split('/');
  let n = 0;
  while (n < left.length && n < right.length && left[n] === right[n]) n++;
  return n;
}

function depth(p: string): number {
  return pathKey(p).split('/').length;
}

/**
 * Where did this folder go?
 *
 * `missing` is the directory that is no longer there; `candidates` are
 * directories that DO exist, gathered by the caller. The winner must:
 *
 *   1. carry the same basename — the one thing a move preserves;
 *   2. not be the missing path itself, nor a path under it (a folder cannot
 *      have moved inside itself, and a stale candidate list can say so);
 *   3. be nearest to where the folder used to be, measured by how much of the
 *      old path it still shares.
 *
 * A session's cwd outranks a search hit at equal distance: something is
 * actually running there, which is evidence rather than resemblance. Two hits
 * that are still level after both tests are `ambiguous` — see the header.
 */
export function planRelocation(input: {
  missing: string;
  candidates: readonly RelocationCandidate[];
}): RelocationPlan {
  const missing = normalizeDir(input.missing);
  if (missing === '' || missing === '/') return { kind: 'none' };
  const wanted = pathKey(baseNameOf(missing));
  if (wanted === '') return { kind: 'none' };

  const seen = new Set<string>();
  const viable = (input.candidates ?? [])
    .map((c) => ({ ...c, dir: normalizeDir(c.dir) }))
    .filter((c) => {
      if (c.dir === '' || pathKey(baseNameOf(c.dir)) !== wanted) return false;
      // Under the missing path is not a place the missing path went.
      if (isWithin(missing, c.dir)) return false;
      const key = pathKey(c.dir);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (viable.length === 0) return { kind: 'none' };

  const scored = viable.map((c) => ({
    ...c,
    shared: sharedDepth(missing, c.dir),
    // A tie on shared prefix goes to the shallower path: a folder that moved
    // UP is the ordinary case (a nested project pulled out to sit beside its
    // former parent), and a deep hit at the same distance is more likely a
    // copy somebody left inside a build directory.
    depth: depth(c.dir),
    running: c.source === 'session' ? 1 : 0,
  }));
  scored.sort(
    (a, b) =>
      b.shared - a.shared ||
      b.running - a.running ||
      a.depth - b.depth ||
      pathKey(a.dir).localeCompare(pathKey(b.dir)),
  );

  const best = scored[0];
  if (!best) return { kind: 'none' };
  const tied = scored.filter(
    (c) =>
      c.shared === best.shared &&
      c.running === best.running &&
      c.depth === best.depth,
  );
  if (tied.length > 1) return { kind: 'ambiguous', dirs: tied.map((c) => c.dir) };
  return { kind: 'found', dir: best.dir, source: best.source };
}

/** Basename without node:path, so this module stays as importable as
 *  projects.ts is. Mirrors projects.baseName; kept local rather than exported
 *  from there twice. */
function baseNameOf(p: string): string {
  const norm = normalizeDir(p);
  if (norm === '' || norm === '/') return '';
  const i = norm.lastIndexOf('/');
  return i < 0 ? norm : norm.slice(i + 1);
}

/** `path` with `from` swapped for `to`, when `path` is `from` or sits under
 *  it; otherwise `path` unchanged. Case-folding follows the platform, so a
 *  recorded `/Users/x/Code/api` moves when the project says `/users/x/code`
 *  on macOS and does not on Linux — the same rule `isWithin` already applies
 *  to membership. */
function reparent(path: string, from: string, to: string): string {
  const p = normalizeDir(path);
  if (p === '' || !isWithin(from, p)) return p;
  const suffix = p.slice(normalizeDir(from).length);
  return `${normalizeDir(to)}${suffix}`;
}

export interface RelocationWrites {
  /** Project patches, keyed by id. Only projects that actually move appear. */
  projects: Array<{
    id: string;
    patch: { rootDir?: string; dirs?: string[] };
  }>;
  /** Session records whose recorded cwd moves with the folder. */
  records: Array<{ id: string; cwd: string }>;
  /** Every directory that changed, old → new, for the report. */
  moved: Array<{ from: string; to: string }>;
}

/**
 * Everything that has to be written down once we know a folder moved from
 * `from` to `to`.
 *
 * Pure and exhaustive: it looks at every project (not just the one that
 * noticed) and every record, because one move can be the answer for several of
 * them at once — a project, its subprojects, and the sessions of all of them.
 * A patch is produced only where something actually changes, so applying this
 * twice writes nothing the second time.
 *
 * `dirs` is patched WHOLESALE when any of its entries move, because that is
 * how the store's project patch works; the entries that did not move are
 * carried through unchanged and in order.
 */
export function relocationWrites(input: {
  from: string;
  to: string;
  projects: readonly ProjectRecord[];
  records: Readonly<Record<string, EditorialRecord>>;
}): RelocationWrites {
  const from = normalizeDir(input.from);
  const to = normalizeDir(input.to);
  const out: RelocationWrites = { projects: [], records: [], moved: [] };
  if (from === '' || to === '' || pathKey(from) === pathKey(to)) return out;

  const noteMove = (before: string, after: string): void => {
    if (pathKey(before) === pathKey(after)) return;
    if (out.moved.some((m) => pathKey(m.from) === pathKey(before))) return;
    out.moved.push({ from: before, to: after });
  };

  for (const project of input.projects ?? []) {
    if (!project || typeof project.id !== 'string') continue;
    const patch: { rootDir?: string; dirs?: string[] } = {};

    const root = normalizeDir(project.rootDir);
    const movedRoot = reparent(root, from, to);
    if (root !== '' && pathKey(movedRoot) !== pathKey(root)) {
      patch.rootDir = movedRoot;
      noteMove(root, movedRoot);
    }

    const dirs = Array.isArray(project.dirs) ? project.dirs : [];
    const movedDirs = dirs.map((d) => reparent(d, from, to));
    if (movedDirs.some((d, i) => pathKey(d) !== pathKey(normalizeDir(dirs[i] ?? '')))) {
      patch.dirs = movedDirs;
      for (const [i, before] of dirs.entries()) {
        noteMove(normalizeDir(before), movedDirs[i] ?? '');
      }
    }

    if (patch.rootDir !== undefined || patch.dirs !== undefined) {
      out.projects.push({ id: project.id, patch });
    }
  }

  for (const [id, record] of Object.entries(input.records ?? {})) {
    const cwd = normalizeDir(record?.cwd);
    if (cwd === '') continue;
    const movedCwd = reparent(cwd, from, to);
    if (pathKey(movedCwd) !== pathKey(cwd)) out.records.push({ id, cwd: movedCwd });
  }

  return out;
}

/**
 * WHERE TO LOOK, nearest ring first: the missing folder's parent, then its
 * grandparent, and so on for `maxClimb` levels — never past the filesystem
 * root, never the missing path itself.
 *
 * Pure because getting it wrong is silent and this is exactly how it was got
 * wrong first: the search started at the nearest SURVIVING ancestor and looked
 * only downward, which for `research/ai-builder/plc-meeting` means starting at
 * `ai-builder` — still there, and no longer containing anything. The folder had
 * gone UP, to `research/plc-meeting`, and a downward-only search cannot see
 * that however deep it goes. A folder that moved went somewhere NEAR where it
 * was, in any direction, so the rings have to widen.
 *
 * Nearest first because the caller spends one shared visit budget across them
 * and should spend it close to home.
 */
export function searchRoots(missing: string, maxClimb: number): string[] {
  const start = normalizeDir(missing);
  if (start === '' || start === '/') return [];
  const roots: string[] = [];
  let dir = parentOf(start);
  for (let i = 0; i <= maxClimb && dir !== ''; i++) {
    roots.push(dir);
    const up = parentOf(dir);
    if (up === dir) break;
    dir = up;
  }
  return roots;
}

/** The directory above `p`, or '' at the top. Local for the same reason
 *  {@link baseNameOf} is. */
function parentOf(p: string): string {
  const norm = normalizeDir(p);
  if (norm === '' || norm === '/') return '';
  const i = norm.lastIndexOf('/');
  if (i < 0) return '';
  return i === 0 ? '/' : norm.slice(0, i);
}
