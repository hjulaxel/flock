// src/state.ts — the editorial state layer.
//
// This is OUR JSON in <globalStorageUri>/state.json: everything the roster
// cannot know (per-session title/summary/closed/hidden/wrap state, the exact
// parent edges of sessions we launched, terminal bindings) plus each window's
// published focus handle.
//
// Why a file and not `globalState`: globalState has no change event and is
// last-writer-wins on the WHOLE blob, so two windows silently destroy each
// other's edits. A file in globalStorageUri can be watched cross-window
// (extension.ts: createFileSystemWatcher(new RelativePattern(
// context.globalStorageUri, 'state.json')) — a simple, non-recursive pattern
// with a RelativePattern base is the documented way to watch outside the
// workspace) and can be merged record-by-record instead of clobbered.
//
// This module deliberately depends on nothing from vscode — only ./types,
// ./log, ./projects, ./accounts (both pure) and node:fs/promises, node:path,
// node:process. The watcher lives in extension.ts and calls reloadFromDisk(),
// which is what keeps this module unit-testable with no mock.
//
// Two of the top-level shapes are about ACCOUNTS. `accounts` is an ordinary
// record map and merges like every other one. `accountSettings` is the file's
// one SINGLETON — one object with one clock, merged newest-wins as a whole
// rather than key by key, because its single field is a single choice and two
// windows disagreeing about it should resolve to the later opinion rather than
// to a blend. Nothing in either shape is a credential: an account is a path
// plus a label, and the one secret-bearing field (`extraEnv`) is validated by
// NAME and never by value, never echoed, never logged.

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as process from 'node:process';

import { log, logError } from './log';
import {
  ACCOUNT_TOMBSTONE_TTL_MS,
  DEFAULT_PROVIDER,
  MAX_ACCOUNT_LABEL_LEN,
  MAX_PROJECT_NAME_LEN,
  PROJECT_TOMBSTONE_TTL_MS,
  STATE_SCHEMA_VERSION,
  isProviderId,
  isRoutingChoice,
  isSessionId,
  type AccountProfile,
  type AccountSettings,
  type ChainRecord,
  type DisposableLike,
  type EditorialRecord,
  type HiddenFolder,
  type HookInstallState,
  type LineageState,
  type MintedBranchRecord,
  type ProjectRecord,
  type SubprojectRecord,
  type RoutingChoice,
  type WindowRecord,
  type WorkspaceSnapshot,
  type WorkspaceTabRecord,
} from './types';
import {
  canReparentProject,
  flattenNestedProjects,
  normalizeDir,
  pathKey,
  projectDirs,
} from './projects';
import { isAccountId, isEnvVarName, nextOrder, sortProfiles } from './accounts';

// ------------------------------------------------------------------ constants

const STATE_FILE = 'state.json';
/** Temp files are `state.json.<pid>.<n>.tmp`, always in the SAME directory as
 *  state.json (a cross-filesystem rename gives EXDEV). The pid/counter suffix
 *  matters: a shared `state.json.tmp` would let two windows write the same
 *  temp file at once and rename a torn blob over the real state. */
const TMP_PREFIX = `${STATE_FILE}.`;
const TMP_SUFFIX = '.tmp';
const CORRUPT_PREFIX = `${STATE_FILE}.corrupt-`;
/** Advisory cross-window mutex, held only for one read→merge→write pass.
 *  O_EXCL creation is the one atomic primitive every filesystem agrees on;
 *  this is the fs-level stand-in for the Python prototype's `flock`. */
const LOCK_FILE = `${STATE_FILE}.lock`;
/** A lock older than this belonged to a window that died mid-write. */
const LOCK_STALE_MS = 5_000;
/** Never block a mutation for longer than this; degrade to a lock-free write
 *  (the post-write verify still catches most of what the lock would have). */
const LOCK_MAX_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 8;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Window records older than this are pruned even if their pid looks alive
 *  (pids are recycled; a week-old handle is never useful). */
const WINDOW_TTL_MS = 7 * DAY_MS;
/** Temp files this old are leftovers from a crashed write — safe to remove. */
const STALE_TMP_MS = 5 * 60 * 1000;
/** Coalesce the burst of watcher events a single rename produces. */
const DEFAULT_RELOAD_DEBOUNCE_MS = 60;
/** Windows likes to fail a rename that raced an AV scanner; one retry. */
const RENAME_RETRY_MS = 100;
/** read → merge → write → verify, repeated while another window keeps racing
 *  us. The merge is monotone, so this converges in practice. */
const MAX_WRITE_ATTEMPTS = 3;
/** At most this many corrupt-file backups per store instance. */
const MAX_CORRUPT_BACKUPS = 5;
/** Depth guard for the canonicaliser (JSON input is acyclic; a caller could
 *  still hand us something exotic). */
const CANONICAL_MAX_DEPTH = 24;

/** INFERRED lineage sources are NEVER persisted — what survives a round trip
 *  is exact knowledge only: edges we minted ourselves, edges the user drew by
 *  hand, and edges the CLI daemon's own dispatch log recorded for a native
 *  `/fork`. 'daemon' qualifies because the roster entry is a dispatch record,
 *  not an inference — and it MUST be persisted, because the daemon roster is
 *  ephemeral and the fork child's transcript carries no marker at all. */
const PERSISTED_PARENT_SOURCES: ReadonlySet<string> = new Set([
  'minted',
  'reparent',
  'daemon',
]);

/** Patch keys the caller does not get to set: identity and the merge clock. */
const RESERVED_RECORD_KEYS: ReadonlySet<string> = new Set([
  'id',
  'createdAt',
  'updatedAt',
]);

// ------------------------------------------------------------------ helpers

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function errCode(e: unknown): string | undefined {
  return isPlainObject(e) && typeof e.code === 'string' ? e.code : undefined;
}

export function nowIso(): string {
  return new Date().toISOString();
}

function emptyState(): LineageState {
  return {
    version: STATE_SCHEMA_VERSION,
    records: {},
    windows: {},
    projects: {},
    subprojects: {},
    hiddenFolders: {},
    mintedBranches: {},
    chains: {},
    workspaces: {},
    accounts: {},
    accountSettings: {},
  };
}

/** Accounts are handed out as copies like every other record, and `extraEnv`
 *  gets its own copy: it is the one nested object in this file, and a caller
 *  mutating it would be editing the store's memory in place. */
function cloneAccount(a: AccountProfile): AccountProfile {
  return a.extraEnv ? { ...a, extraEnv: { ...a.extraEnv } } : { ...a };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Deep clone with sorted keys so the serialised file is byte-identical for
 *  identical content regardless of which window (or which merge order) wrote
 *  it. That makes `text === lastText` a real semantic comparison, which is
 *  what both the change event and the post-write conflict check rely on. */
function canonical(value: unknown, depth = 0): unknown {
  if (depth > CANONICAL_MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.map((v) => canonical(v, depth + 1));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = canonical(value[key], depth + 1);
      if (v !== undefined) out[key] = v;
    }
    return out;
  }
  return value;
}

function stableStringify(state: LineageState): string {
  return `${JSON.stringify(canonical(state), null, 2)}\n`;
}

function defaultIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but belongs to someone else.
    return errCode(e) === 'EPERM';
  }
}

function safeIsAlive(probe: (pid: number) => boolean, pid: number): boolean {
  try {
    return probe(pid);
  } catch (e) {
    logError('state: liveness probe threw', e);
    return true; // never prune on a broken probe
  }
}

// ------------------------------------------------------------------ sanitize

/** One record, sanitized. Unknown fields are PRESERVED verbatim so a state
 *  file written by a future version survives a round trip through this one. */
function sanitizeRecord(key: string, value: unknown): EditorialRecord | null {
  if (!isSessionId(key)) return null;
  if (!isPlainObject(value)) return null;
  const rec: Record<string, unknown> = { ...value };

  rec.id = key; // the map key is the identity; the field just mirrors it

  if (!isNonEmptyString(rec.createdAt)) rec.createdAt = nowIso();
  // Missing updatedAt falls back to createdAt, never to "now": stamping now
  // at load time would make a stale record win every merge it touches.
  if (!isNonEmptyString(rec.updatedAt)) rec.updatedAt = rec.createdAt;

  if (rec.parentSource !== undefined) {
    if (
      typeof rec.parentSource !== 'string' ||
      !PERSISTED_PARENT_SOURCES.has(rec.parentSource)
    ) {
      delete rec.parentSource;
    }
  }
  if (
    rec.parentId !== undefined &&
    rec.parentId !== null &&
    !isSessionId(rec.parentId)
  ) {
    delete rec.parentId;
  }
  for (const k of [
    'deleted',
    'launchedByUs',
    'notify',
    'parked',
    'chat',
  ] as const) {
    if (rec[k] !== undefined && typeof rec[k] !== 'boolean') delete rec[k];
  }
  // The hide verb is retired — tree membership is editorial and DELETE is the
  // one put-away verb (still restorable). A record hidden by an older version
  // reads as deleted, which is the same "off the tree, on purpose" state it was
  // in. Idempotent, so a stale window still writing `hidden` converges on the
  // next read here.
  if (rec.hidden === true) rec.deleted = true;
  delete rec.hidden;
  for (const k of [
    'title',
    'summary',
    'cwd',
    'wrapRequestedAt',
    'doneAt',
    'seenAt',
    'notifyDismissedAt',
  ] as const) {
    if (rec[k] !== undefined && typeof rec[k] !== 'string') delete rec[k];
  }
  for (const k of ['closed', 'boundWindowId', 'tmux'] as const) {
    if (rec[k] !== undefined && rec[k] !== null && typeof rec[k] !== 'string') {
      delete rec[k];
    }
  }
  if (rec.provider !== undefined && !isProviderId(rec.provider)) {
    delete rec.provider;
  }
  // The account pin. Validated against the strict slug shape rather than "is a
  // string", because this id is interpolated into a filesystem path by the
  // profile-directory helper and state.json is hand-editable.
  if (rec.profileId !== undefined && !isAccountId(rec.profileId)) {
    delete rec.profileId;
  }
  // The lane stamp. Only shape is checked here, deliberately: whether the lane
  // still EXISTS is a question about another map, it changes under this record
  // without the record being rewritten, and `getSessionSubproject` already treats a
  // dangling stamp as absent. Dropping it here instead would make deleting a lane
  // and then merging in an older window's copy of it lose the filing for good.
  {
    const raw = rec.subprojectId;
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (id === '') delete rec.subprojectId;
    else rec.subprojectId = id;
  }
  return rec as unknown as EditorialRecord;
}

/**
 * One account, sanitized.
 *
 * Strict about the KEY for a reason the other sanitizers do not have: an
 * account id names a directory under `~/.lineage/profiles/`, so a hand-edited
 * `"../../.claude"` would point a "separate" account straight back at the real
 * login. `isAccountId` is the same slug rule that mints them.
 *
 * `extraEnv` is inspected by NAME and TYPE only — never by value, never
 * logged, not even when a pair is rejected. On an API-key account that value
 * IS the credential.
 */
function sanitizeAccount(key: string, value: unknown): AccountProfile | null {
  if (!isAccountId(key)) return null;
  if (!isPlainObject(value)) return null;

  // A tombstone, exactly as with projects: an id plus a merge stamp, reduced
  // to the fields the merge compares so a hand-edited file cannot hand a
  // reader a half-real account.
  if (value.deleted === true) {
    const stamp = isNonEmptyString(value.updatedAt) ? value.updatedAt : nowIso();
    return {
      id: key,
      provider: DEFAULT_PROVIDER,
      label: '',
      order: 0,
      deleted: true,
      createdAt: isNonEmptyString(value.createdAt) ? value.createdAt : stamp,
      updatedAt: stamp,
    };
  }

  const acc: Record<string, unknown> = { ...value }; // unknown fields preserved
  acc.id = key;
  // An unreadable provider falls back rather than dropping the record: the
  // account still exists and still has credentials behind it, and rendering it
  // under the wrong logo is a far smaller failure than losing it.
  acc.provider = isProviderId(value.provider) ? value.provider : DEFAULT_PROVIDER;

  const rawLabel = typeof value.label === 'string' ? value.label.trim() : '';
  acc.label =
    rawLabel === '' ? key : rawLabel.slice(0, MAX_ACCOUNT_LABEL_LEN);

  const dir = typeof value.configDir === 'string' ? value.configDir.trim() : '';
  if (dir === '') delete acc.configDir;
  else acc.configDir = dir;

  const env: Record<string, string> = {};
  if (isPlainObject(value.extraEnv)) {
    for (const [name, v] of Object.entries(value.extraEnv)) {
      if (!isEnvVarName(name) || typeof v !== 'string') {
        log('state: dropped an unusable env entry from account', key, name);
        continue;
      }
      env[name] = v;
    }
  }
  if (Object.keys(env).length > 0) acc.extraEnv = env;
  else delete acc.extraEnv;

  acc.order =
    typeof value.order === 'number' && Number.isFinite(value.order)
      ? value.order
      : 0;

  delete acc.deleted; // handled above; anything falsy here is just noise
  if (!isNonEmptyString(acc.createdAt)) acc.createdAt = nowIso();
  if (!isNonEmptyString(acc.updatedAt)) acc.updatedAt = acc.createdAt;

  return acc as unknown as AccountProfile;
}

/** The singleton account settings. Unknown keys survive, the one field we
 *  understand is validated, and a blob that is not an object at all becomes the
 *  empty record rather than being carried as junk. */
function sanitizeAccountSettings(value: unknown): AccountSettings {
  if (!isPlainObject(value)) return {};
  const out: Record<string, unknown> = { ...value };
  if (out.defaultRouting !== undefined && !isRoutingChoice(out.defaultRouting)) {
    log('state: dropped an unusable defaultRouting');
    delete out.defaultRouting;
  }
  if (out.updatedAt !== undefined && !isNonEmptyString(out.updatedAt)) {
    delete out.updatedAt;
  }
  return out as AccountSettings;
}

/**
 * A project record, sanitized. `rootDir` is the identity of the thing on disk
 * and a project without one cannot match any session, so a missing/blank
 * rootDir drops the whole record rather than leaving an unmatched row in the
 * tree. Unknown fields are preserved, same as everywhere else.
 */
function sanitizeProject(key: string, value: unknown): ProjectRecord | null {
  if (!isNonEmptyString(key)) return null;
  if (!isPlainObject(value)) return null;

  // A tombstone has no rootDir requirement — it is an id plus a merge stamp,
  // and the whole point is that it survives a round trip through this function.
  if (value.deleted === true) {
    const stamp = isNonEmptyString(value.updatedAt) ? value.updatedAt : nowIso();
    // Reduced to the merge-relevant fields on purpose. Nothing reads a
    // tombstone's name or dirs, and normalising them here means a hand-edited
    // file cannot hand a reader a `dirs` that is not an array.
    return {
      id: key,
      name: '',
      rootDir: '',
      dirs: [],
      deleted: true,
      createdAt: isNonEmptyString(value.createdAt) ? value.createdAt : stamp,
      updatedAt: stamp,
    };
  }

  const rootDir = normalizeDir(value.rootDir);
  if (rootDir === '') return null;

  const proj: Record<string, unknown> = { ...value };
  proj.id = key;
  proj.rootDir = rootDir;

  const rawName = typeof value.name === 'string' ? value.name.trim() : '';
  proj.name =
    rawName === ''
      ? rootDir.slice(rootDir.lastIndexOf('/') + 1) || rootDir
      : rawName.slice(0, MAX_PROJECT_NAME_LEN);

  // Extra directories only: rootDir living in both lists would double-count in
  // every membership walk.
  const dirs: string[] = [];
  const seen = new Set<string>([pathKey(rootDir)]);
  if (Array.isArray(value.dirs)) {
    for (const raw of value.dirs) {
      const dir = normalizeDir(raw);
      if (dir === '') continue;
      const k = pathKey(dir);
      if (seen.has(k)) continue;
      seen.add(k);
      dirs.push(dir);
    }
  }
  proj.dirs = dirs;

  if (proj.provider !== undefined && !isProviderId(proj.provider)) {
    delete proj.provider;
  }
  if (proj.hidden !== undefined && typeof proj.hidden !== 'boolean') {
    delete proj.hidden;
  }
  // The subproject pointer. Absent is the normal state, and the only thing
  // stored here is a non-empty id that is not this project's own — everything
  // else about it (does it exist, does it close a loop, is the chain too deep)
  // is decided at RENDER time by projects.buildProjectTree, which has the whole
  // set in front of it and this function does not. `null` is how the move-to-
  // top-level verb clears it, and it is stored as absence.
  {
    const raw = proj.parentId;
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (id === '' || id === key) delete proj.parentId;
    else proj.parentId = id;
  }
  // A routing override that does not parse is no override at all — the project
  // falls back to the global default, which is what it did before it had one.
  if (proj.routing !== undefined && !isRoutingChoice(proj.routing)) {
    delete proj.routing;
  }
  delete proj.deleted; // handled above; anything falsy here is just noise
  if (!isNonEmptyString(proj.createdAt)) proj.createdAt = nowIso();
  if (!isNonEmptyString(proj.updatedAt)) proj.updatedAt = proj.createdAt;

  return proj as unknown as ProjectRecord;
}

/**
 * A NAMED SUBPROJECT — a lane. v7.
 *
 * The same three-part shape sanitizeProject has, for the same reasons: a tombstone
 * survives a round trip reduced to its merge fields, a record missing the one thing
 * that makes it meaningful is dropped, and everything else is normalised rather
 * than trusted.
 *
 * What is required is `projectId` and `dir`. A lane with no project is a lane
 * nothing can draw — unlike a project with a dangling `parentId`, which renders at
 * the top level, there is no fallback position for a lane whose project is gone.
 * A lane with no directory has nowhere to start a session and no repository to list
 * branches from, which is the whole of what its row does.
 *
 * The NAME is allowed to be empty here and is defaulted at render time, not
 * refused: a hand-edited file with a blank name should still draw a row the user
 * can rename, rather than silently losing the lane and every session stamped with
 * it.
 */
function sanitizeSubproject(key: string, value: unknown): SubprojectRecord | null {
  if (!isNonEmptyString(key)) return null;
  if (!isPlainObject(value)) return null;

  if (value.deleted === true) {
    const stamp = isNonEmptyString(value.updatedAt) ? value.updatedAt : nowIso();
    return {
      id: key,
      // Reduced to the merge-relevant fields, exactly as a project tombstone is:
      // nothing reads a tombstone's name or directory.
      projectId: '',
      name: '',
      dir: '',
      deleted: true,
      createdAt: isNonEmptyString(value.createdAt) ? value.createdAt : stamp,
      updatedAt: stamp,
    };
  }

  const projectId =
    typeof value.projectId === 'string' ? value.projectId.trim() : '';
  if (projectId === '' || projectId === key) return null;
  const dir = normalizeDir(value.dir);
  if (dir === '') return null;

  const rawName = typeof value.name === 'string' ? value.name.trim() : '';
  const stamp = isNonEmptyString(value.createdAt) ? value.createdAt : nowIso();
  return {
    id: key,
    projectId,
    name: rawName.slice(0, MAX_PROJECT_NAME_LEN),
    dir,
    createdAt: stamp,
    updatedAt: isNonEmptyString(value.updatedAt) ? value.updatedAt : stamp,
  };
}

/** The map key is the normalized path; the record just mirrors it. */
function sanitizeHiddenFolder(key: string, value: unknown): HiddenFolder | null {
  const path = normalizeDir(key);
  if (path === '') return null;
  const at =
    isPlainObject(value) && isNonEmptyString(value.hiddenAt)
      ? value.hiddenAt
      : nowIso();
  return { path, hiddenAt: at };
}

/** The minted-branch map key: repo pathKey and branch, newline-joined. A ref
 *  cannot contain a newline (git-check-ref-format forbids ASCII control
 *  characters), so the two halves cannot collide however they are spelled. */
export function mintedBranchKey(repoDir: string, branch: string): string {
  return `${pathKey(repoDir)}\n${branch}`;
}

function sanitizeMintedBranch(value: unknown): MintedBranchRecord | null {
  if (!isPlainObject(value)) return null;
  const repo = isNonEmptyString(value.repo) ? pathKey(value.repo) : '';
  if (repo === '') return null;
  if (!isNonEmptyString(value.branch)) return null;
  const at = isNonEmptyString(value.mintedAt) ? value.mintedAt : nowIso();
  return { repo, branch: value.branch, mintedAt: at };
}

function sanitizeWindow(key: string, value: unknown): WindowRecord | null {
  if (!isNonEmptyString(key)) return null;
  if (!isPlainObject(value)) return null;
  if (!isNonEmptyString(value.windowId)) return null;
  const handle = value.focusHandle;
  if (!isPlainObject(handle) || !isNonEmptyString(handle.uri)) return null;
  if (typeof value.pid !== 'number' || !Number.isFinite(value.pid)) return null;

  const win: Record<string, unknown> = { ...value };
  win.windowId = key; // key is the namespace, exactly as with records
  win.focusHandle = { ...handle };
  if (!isNonEmptyString(win.publishedAt)) win.publishedAt = nowIso();
  if (win.folder !== undefined && typeof win.folder !== 'string') {
    delete win.folder;
  }
  return win as unknown as WindowRecord;
}

/** A generation chain. The key is the chain root id; members are deduped
 *  session ids with the root guaranteed present and first-or-earlier. A chain
 *  that sanitizes down to fewer than two members is dropped — it says nothing
 *  a plain session row does not. */
function sanitizeChain(key: string, value: unknown): ChainRecord | null {
  if (!isSessionId(key)) return null;
  if (!isPlainObject(value)) return null;

  const members: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown): void => {
    if (!isSessionId(raw) || seen.has(raw)) return;
    seen.add(raw);
    members.push(raw);
  };
  push(key); // the root is always a member, and always known
  if (Array.isArray(value.members)) for (const m of value.members) push(m);
  if (members.length < 2) return null;

  const createdAt = isNonEmptyString(value.createdAt) ? value.createdAt : nowIso();
  return {
    rootId: key,
    members,
    createdAt,
    updatedAt: isNonEmptyString(value.updatedAt) ? value.updatedAt : createdAt,
  };
}

/** A workspace snapshot. The map key is the project id; a snapshot with no
 *  usable tab list still round-trips (an empty layout is a valid layout —
 *  "close everything" is rememberable). */
function sanitizeWorkspace(key: string, value: unknown): WorkspaceSnapshot | null {
  if (!isNonEmptyString(key)) return null;
  if (!isPlainObject(value)) return null;

  const tabs: WorkspaceTabRecord[] = [];
  if (Array.isArray(value.tabs)) {
    for (const raw of value.tabs) {
      if (!isPlainObject(raw)) continue;
      const kind = raw.kind;
      if (kind !== 'file' && kind !== 'session') continue;
      const viewColumn =
        typeof raw.viewColumn === 'number' &&
        Number.isInteger(raw.viewColumn) &&
        raw.viewColumn > 0
          ? raw.viewColumn
          : 1;
      if (kind === 'file') {
        if (!isNonEmptyString(raw.uri)) continue;
        const tab: WorkspaceTabRecord = { kind, uri: raw.uri, viewColumn };
        if (raw.active === true) tab.active = true;
        if (raw.pinned === true) tab.pinned = true;
        tabs.push(tab);
      } else {
        if (!isSessionId(raw.sessionId)) continue;
        const tab: WorkspaceTabRecord = {
          kind,
          sessionId: raw.sessionId,
          viewColumn,
        };
        if (raw.active === true) tab.active = true;
        tabs.push(tab);
      }
    }
  }

  const savedAt = isNonEmptyString(value.savedAt) ? value.savedAt : nowIso();
  return {
    projectId: key,
    tabs,
    savedAt,
    updatedAt: isNonEmptyString(value.updatedAt) ? value.updatedAt : savedAt,
  };
}

function sanitizeHookState(value: unknown): HookInstallState | undefined {
  if (!isPlainObject(value)) return undefined;
  if (typeof value.installed !== 'boolean') return undefined;
  const h: Record<string, unknown> = { ...value };
  for (const k of ['pluginDir', 'installedAt'] as const) {
    if (h[k] !== undefined && typeof h[k] !== 'string') delete h[k];
  }
  if (h.pluginVersion !== undefined && typeof h.pluginVersion !== 'number') {
    delete h.pluginVersion;
  }
  return h as unknown as HookInstallState;
}

// ------------------------------------------------------------------ migration

/**
 * v0 → v1. "v0" is any blob without a numeric `version`: a pre-release file of
 * ours, or a state file from the Python prototype this extension replaced,
 * whose `nodes` map holds the same editorial fields under different names.
 * The fold is keyed on shape, not provenance, so it handles both.
 *
 * Only editorial fields are carried across. Legacy `parent` edges are
 * deliberately NOT imported: in the older format they could have come from
 * lineage inference, and an inferred edge is never persisted (see
 * PERSISTED_PARENT_SOURCES) — freezing one into `parentSource: 'minted'` would
 * make a guess permanent. The legacy `nodes` key itself is left in place
 * (unknown top-level keys are preserved), so nothing is destroyed by the fold.
 */
function migrateV0ToV1(src: Record<string, unknown>): Record<string, unknown> {
  if (isPlainObject(src.records)) return src; // already our shape
  const nodes = src.nodes;
  if (!isPlainObject(nodes)) return src;

  const records: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(nodes)) {
    if (!isSessionId(id) || !isPlainObject(raw)) continue;
    const rec: Record<string, unknown> = { id };
    if (isNonEmptyString(raw.title)) rec.title = raw.title;
    if (isNonEmptyString(raw.summary)) rec.summary = raw.summary;
    if (isNonEmptyString(raw.cwd)) rec.cwd = raw.cwd;
    if (typeof raw.hidden === 'boolean') rec.hidden = raw.hidden;
    if (isNonEmptyString(raw.closed)) rec.closed = raw.closed;
    const created = isNonEmptyString(raw.created) ? raw.created : nowIso();
    rec.createdAt = created;
    rec.updatedAt = created;
    records[id] = rec;
  }
  const migrated = Object.keys(records).length;
  if (migrated > 0) {
    log('state: migrated', migrated, 'legacy node(s) into records (v0 -> v1)');
  }
  return { ...src, records };
}

/**
 * v5 → v6. Every project filed UNDER another project is folded into its
 * top-level ancestor: the ancestor gains the child's directories, the child
 * becomes a tombstone.
 *
 * THE FIRST STEP IN THIS LADDER THAT DESTROYS ANYTHING, and the reason is a model
 * change rather than a bug: a subproject is a DIRECTORY of a project now, not a
 * project record with a parent pointer (see COMMANDS.newSubproject). The rules
 * live in projects.flattenNestedProjects, pure and tested; what is here is the
 * write.
 *
 * What survives is what the user sees: the directories, and therefore the
 * sessions, which have always derived their membership from their cwd and so
 * reappear under the same directory's row. What does NOT survive is everything a
 * subproject had only because it was a whole project — its name, its provider, its
 * account override, its saved workspace layout, and its closed-ness. A closed
 * subproject's directory joins an open parent and its sessions come back into the
 * tree; that is logged, per project, because it is the one outcome somebody might
 * come looking for an explanation of.
 *
 * TOMBSTONES, not deletions, exactly as `deleteProject` writes them: `state.json`
 * is merged newest-clock-wins per record across windows, so a dropped key is
 * indistinguishable from "the other window has not heard of this project yet" and
 * would be re-added on its next write. A tombstone is a value the merge can
 * compare.
 *
 * Self-healing under a mixed install. An older window writes version 5 and its own
 * copies of the child records; this step runs again on the next load, because the
 * ladder is keyed on the version the FILE claims rather than on a flag of ours.
 */
function migrateV5ToV6(src: Record<string, unknown>): Record<string, unknown> {
  if (!isPlainObject(src.projects)) return src;

  const live: ProjectRecord[] = [];
  for (const [id, value] of Object.entries(src.projects)) {
    const proj = sanitizeProject(id, value);
    if (proj && proj.deleted !== true) live.push(proj);
  }
  if (live.length === 0) return src;

  const { merged, removed } = flattenNestedProjects(live);
  if (merged.length === 0 && removed.length === 0) return src;

  const stamp = nowIso();
  const projects: Record<string, unknown> = { ...src.projects };
  const nameOf = (id: string): string =>
    live.find((p) => p.id === id)?.name ?? id;

  for (const patch of merged) {
    const prev = projects[patch.id];
    if (!isPlainObject(prev)) continue;
    projects[patch.id] = {
      ...prev,
      rootDir: patch.rootDir,
      dirs: patch.dirs,
      updatedAt: stamp,
    };
  }
  for (const id of removed) {
    const gone = live.find((p) => p.id === id);
    log(
      'state: folded subproject',
      nameOf(id),
      'into its parent as',
      projectDirs(gone ?? ({} as ProjectRecord)).join(', ') || '(no directory)',
      gone?.hidden === true
        ? '— it was CLOSED, and its directories are now part of an open project'
        : '',
    );
    projects[id] = {
      id,
      name: '',
      rootDir: '',
      dirs: [],
      deleted: true,
      createdAt: isPlainObject(projects[id])
        ? ((projects[id] as { createdAt?: unknown }).createdAt ?? stamp)
        : stamp,
      updatedAt: stamp,
    };
  }
  log(
    'state: v5 -> v6 flattened',
    removed.length,
    'nested project(s) into',
    merged.length,
    'parent(s) — a subproject is a directory now',
  );
  return { ...src, projects };
}

/**
 * Sanitize + version-stamp an arbitrary parsed blob.
 *
 * Forward compatibility is the point of the odd-looking rules: unknown
 * TOP-LEVEL keys and unknown per-record/per-window fields are preserved
 * verbatim, so an older build never silently deletes a newer build's data.
 * `version` is still stamped down to STATE_SCHEMA_VERSION, because a future
 * migration ladder must be able to recognise v1-shaped content — claiming a
 * version we did not write would be the dangerous direction.
 */
export function migrateState(raw: unknown): LineageState {
  if (!isPlainObject(raw)) return emptyState();

  const versionRaw = raw.version;
  const version =
    typeof versionRaw === 'number' && Number.isFinite(versionRaw)
      ? versionRaw
      : 0;
  if (version > STATE_SCHEMA_VERSION) {
    log(
      'state: file claims version',
      version,
      '— reading it as v' +
        String(STATE_SCHEMA_VERSION) +
        ' (unknown keys preserved)',
    );
  }

  // Migration ladder. Each step takes the blob one version forward; add the
  // next one here rather than editing the sanitizer below.
  let working: Record<string, unknown> = { ...raw };
  if (version < 1) working = migrateV0ToV1(working);
  // v1 -> v2 is purely additive: the two new maps are created empty by the
  // sanitizer below, so there is no step to run. Recorded here so the ladder
  // still reads as a complete history. v2 -> v5 likewise.
  if (version < 6) working = migrateV5ToV6(working);
  // v6 -> v7 is purely additive: named subprojects arrive as an empty map, so
  // every project keeps drawing exactly the directory rows it drew before.
  // v7 -> v8 likewise: minted-branch records arrive as an empty map.

  const out: Record<string, unknown> = { ...working }; // keeps unknown keys

  const records: Record<string, EditorialRecord> = {};
  if (isPlainObject(working.records)) {
    for (const [key, value] of Object.entries(working.records)) {
      const rec = sanitizeRecord(key, value);
      if (rec) records[key] = rec;
      else log('state: dropped unusable record', key);
    }
  }
  out.records = records;

  const windows: Record<string, WindowRecord> = {};
  if (isPlainObject(working.windows)) {
    for (const [key, value] of Object.entries(working.windows)) {
      const win = sanitizeWindow(key, value);
      if (win) windows[key] = win;
      else log('state: dropped unusable window record', key);
    }
  }
  out.windows = windows;

  const projects: Record<string, ProjectRecord> = {};
  const tombstoneCutoff = Date.now() - PROJECT_TOMBSTONE_TTL_MS;
  if (isPlainObject(working.projects)) {
    for (const [key, value] of Object.entries(working.projects)) {
      const proj = sanitizeProject(key, value);
      if (!proj) {
        log('state: dropped unusable project record', key);
        continue;
      }
      // Sweep tombstones no window can still be contradicting. The TTL is much
      // longer than WINDOW_TTL_MS, so by now nothing holds the live record.
      if (proj.deleted === true) {
        const at = Date.parse(proj.updatedAt);
        if (Number.isFinite(at) && at < tombstoneCutoff) {
          log('state: swept an expired project tombstone', key);
          continue;
        }
      }
      projects[key] = proj;
    }
  }
  out.projects = projects;

  // v7 added the NAMED SUBPROJECTS. Purely additive like v2, v3 and v4 — an older
  // file yields the empty map, and a project with no lanes draws exactly the
  // directory rows it drew before, so nothing about an existing tree moves.
  //
  // Two sweeps rather than one, and the second is the reason this is not a
  // copy-paste of the projects loop: a lane whose PROJECT is gone has nowhere to
  // draw. A dangling `parentId` renders at the top level, which is why
  // buildProjectTree tolerates one; a lane is meaningless without the project it
  // names, and leaving it would keep every session stamped with it filed under a
  // row nobody draws.
  const subprojects: Record<string, SubprojectRecord> = {};
  if (isPlainObject(working.subprojects)) {
    for (const [key, value] of Object.entries(working.subprojects)) {
      const lane = sanitizeSubproject(key, value);
      if (!lane) {
        log('state: dropped unusable subproject record', key);
        continue;
      }
      if (lane.deleted === true) {
        const at = Date.parse(lane.updatedAt);
        if (Number.isFinite(at) && at < tombstoneCutoff) {
          log('state: swept an expired subproject tombstone', key);
          continue;
        }
        subprojects[key] = lane;
        continue;
      }
      // A live lane whose project is missing OR tombstoned. Not swept outright —
      // the project may simply not have merged in from another window yet, and
      // dropping the lane would lose a name the user typed. Kept, and the render
      // path ignores a lane whose project it cannot find.
      const owner = projects[lane.projectId];
      if (owner === undefined) {
        log('state: kept a subproject whose project is not here yet', key);
      } else if (owner.deleted === true) {
        log('state: dropped a subproject whose project is deleted', key);
        continue;
      }
      subprojects[key] = lane;
    }
  }
  out.subprojects = subprojects;

  const hiddenFolders: Record<string, HiddenFolder> = {};
  if (isPlainObject(working.hiddenFolders)) {
    for (const [key, value] of Object.entries(working.hiddenFolders)) {
      const folder = sanitizeHiddenFolder(key, value);
      if (folder) hiddenFolders[folder.path] = folder;
      else log('state: dropped unusable hidden-folder record', key);
    }
  }
  out.hiddenFolders = hiddenFolders;

  // v8 added the MINTED-BRANCH records. Purely additive: an older file yields
  // the empty map, and a branch with no record never gets a delete offer —
  // the conservative direction for missing data, here as everywhere. Re-keyed
  // from the record's own fields on every load, the way hidden folders are,
  // so a hand-edited key cannot make two entries disagree about one ref.
  const mintedBranches: Record<string, MintedBranchRecord> = {};
  if (isPlainObject(working.mintedBranches)) {
    for (const [key, value] of Object.entries(working.mintedBranches)) {
      const rec = sanitizeMintedBranch(value);
      if (rec) mintedBranches[mintedBranchKey(rec.repo, rec.branch)] = rec;
      else log('state: dropped unusable minted-branch record', key);
    }
  }
  out.mintedBranches = mintedBranches;

  // v3 added the generation chains. Purely additive, exactly like v1 -> v2: an
  // older file simply yields the empty map.
  const chains: Record<string, ChainRecord> = {};
  if (isPlainObject(working.chains)) {
    for (const [key, value] of Object.entries(working.chains)) {
      const chain = sanitizeChain(key, value);
      if (chain) chains[key] = chain;
      else log('state: dropped unusable chain record', key);
    }
  }
  out.chains = chains;

  // v4 added the workspace snapshots. Purely additive again.
  const workspaces: Record<string, WorkspaceSnapshot> = {};
  if (isPlainObject(working.workspaces)) {
    for (const [key, value] of Object.entries(working.workspaces)) {
      const ws = sanitizeWorkspace(key, value);
      if (ws) workspaces[key] = ws;
      else log('state: dropped unusable workspace record', key);
    }
  }
  out.workspaces = workspaces;

  // v5 added the account roster and its settings record. Additive again: a v4
  // file yields an empty roster and empty settings, which is exactly the state
  // of a machine that has never opened the accounts view — one implicit default
  // login, no rows.
  const accounts: Record<string, AccountProfile> = {};
  const accountCutoff = Date.now() - ACCOUNT_TOMBSTONE_TTL_MS;
  if (isPlainObject(working.accounts)) {
    for (const [key, value] of Object.entries(working.accounts)) {
      const acc = sanitizeAccount(key, value);
      if (!acc) {
        log('state: dropped unusable account record', key);
        continue;
      }
      if (acc.deleted === true) {
        const at = Date.parse(acc.updatedAt);
        if (Number.isFinite(at) && at < accountCutoff) {
          log('state: swept an expired account tombstone', key);
          continue;
        }
      }
      accounts[key] = acc;
    }
  }
  out.accounts = accounts;
  out.accountSettings = sanitizeAccountSettings(working.accountSettings);

  const hook = sanitizeHookState(working.hookInstall);
  if (hook) out.hookInstall = hook;
  else delete out.hookInstall;

  const verbs = sanitizeHookState(working.verbsInstall);
  if (verbs) out.verbsInstall = verbs;
  else delete out.verbsInstall;

  out.version = STATE_SCHEMA_VERSION;
  return out as unknown as LineageState;
}

// ------------------------------------------------------------------ merge

function newerWins<T>(
  disk: Record<string, T> | undefined,
  mem: Record<string, T> | undefined,
  stampOf: (v: T) => string,
): Record<string, T> {
  const out: Record<string, T> = {};
  const d = disk ?? {};
  const m = mem ?? {};
  for (const key of new Set([...Object.keys(d), ...Object.keys(m)])) {
    const dv = d[key];
    const mv = m[key];
    if (dv === undefined) {
      if (mv !== undefined) out[key] = mv;
      continue;
    }
    if (mv === undefined) {
      out[key] = dv;
      continue;
    }
    // ISO-8601 strings compare correctly as strings; ties go to memory.
    out[key] = stampOf(dv) > stampOf(mv) ? dv : mv;
  }
  return out;
}

/** Union two chain records: the newer side's member order wins, the older
 *  side's unseen members are appended. Exported for tests. */
export function mergeChainRecords(a: ChainRecord, b: ChainRecord): ChainRecord {
  const [newer, older] =
    (a.updatedAt ?? '') >= (b.updatedAt ?? '') ? [a, b] : [b, a];
  const members: string[] = [];
  const seen = new Set<string>();
  for (const m of [...newer.members, ...older.members]) {
    if (!seen.has(m)) {
      seen.add(m);
      members.push(m);
    }
  }
  return {
    rootId: newer.rootId,
    members,
    createdAt:
      (a.createdAt ?? '') <= (b.createdAt ?? '') ? a.createdAt : b.createdAt,
    updatedAt: newer.updatedAt,
  };
}

function mergeChainMaps(
  disk: Record<string, ChainRecord> | undefined,
  mem: Record<string, ChainRecord> | undefined,
): Record<string, ChainRecord> {
  const out: Record<string, ChainRecord> = {};
  const d = disk ?? {};
  const m = mem ?? {};
  for (const key of new Set([...Object.keys(d), ...Object.keys(m)])) {
    const dv = d[key];
    const mv = m[key];
    if (dv === undefined) {
      if (mv !== undefined) out[key] = mv;
      continue;
    }
    if (mv === undefined) {
      out[key] = dv;
      continue;
    }
    out[key] = mergeChainRecords(dv, mv);
  }
  return out;
}

/**
 * Record-level newest-wins merge. This is what makes multiple windows safe: a
 * window never writes its whole in-memory blob over the file, it writes the
 * union of the file and its own newer records.
 */
export function mergeStates(
  disk: LineageState,
  mem: LineageState,
): LineageState {
  const out: Record<string, unknown> = {
    ...(disk as unknown as Record<string, unknown>),
    ...(mem as unknown as Record<string, unknown>), // unknown keys: mem wins
  };

  out.records = newerWins(disk.records, mem.records, (r) => r.updatedAt ?? '');
  out.windows = newerWins(
    disk.windows,
    mem.windows,
    (w) => w.publishedAt ?? '',
  );
  out.projects = newerWins(
    disk.projects,
    mem.projects,
    (p) => p.updatedAt ?? '',
  );
  // Named subprojects are ordinary records with their own clocks — one per lane,
  // which is the whole reason a lane is a record rather than an entry in an array
  // on the project. Newest-wins per lane means two windows each adding one keeps
  // both; a list on ProjectRecord would have kept whichever wrote last. See
  // SubprojectRecord.
  out.subprojects = newerWins(
    disk.subprojects,
    mem.subprojects,
    (s) => s.updatedAt ?? '',
  );
  // A hidden folder is a tombstone, not a value: there is nothing to merge
  // field-wise, so the union of both sides is the whole answer. Un-hiding
  // deletes the key, and a delete only sticks if the other window is not
  // simultaneously re-hiding it — which is exactly the intended semantics.
  out.hiddenFolders = newerWins(
    disk.hiddenFolders,
    mem.hiddenFolders,
    (f) => f.hiddenAt ?? '',
  );

  // A minted-branch record is the same shape of fact as a hidden folder — a
  // marker with nothing to merge field-wise — so the merge is the same
  // per-key newest-wins. A prune only sticks if the other window is not
  // simultaneously re-minting the ref, which is the intended semantics.
  out.mintedBranches = newerWins(
    disk.mintedBranches,
    mem.mintedBranches,
    (b) => b.mintedAt ?? '',
  );

  // Chains are append-mostly member SETS, so newest-wins would drop a member
  // the other window observed: the merge is a member UNION, ordered by the
  // newer record first (its view of the order is the fresher one), with the
  // older record's stragglers appended.
  out.chains = mergeChainMaps(disk.chains, mem.chains);

  // A workspace snapshot is one VALUE — the layout as last saved — so
  // newest-wins is the whole story.
  out.workspaces = newerWins(
    disk.workspaces,
    mem.workspaces,
    (w) => w.updatedAt ?? '',
  );

  // Accounts are ordinary records: one row per account, each with its own
  // clock, so the same newest-wins rule projects use is the whole story. It is
  // also what makes reordering safe across windows — a move writes several
  // records, and each lands or loses on its own merit rather than the whole
  // list being replaced by whichever window wrote last.
  out.accounts = newerWins(disk.accounts, mem.accounts, (a) => a.updatedAt ?? '');

  // The settings record is ONE value with one clock. Newest wins wholesale
  // rather than field-by-field: the only field in it is a single choice, and
  // "the later opinion" is a better answer than a blend of two.
  out.accountSettings = newerSettings(disk.accountSettings, mem.accountSettings);

  const hook = mem.hookInstall ?? disk.hookInstall;
  if (hook) out.hookInstall = hook;
  else delete out.hookInstall;

  const verbs = mem.verbsInstall ?? disk.verbsInstall;
  if (verbs) out.verbsInstall = verbs;
  else delete out.verbsInstall;

  out.version = STATE_SCHEMA_VERSION;
  return out as unknown as LineageState;
}

/** Newest-wins over the whole settings record; ties go to memory, exactly as
 *  `newerWins` resolves them. A side with no stamp always loses, which is what
 *  makes a window that has never touched the setting harmless. */
function newerSettings(
  disk: AccountSettings | undefined,
  mem: AccountSettings | undefined,
): AccountSettings {
  const d = disk ?? {};
  const m = mem ?? {};
  const ds = typeof d.updatedAt === 'string' ? d.updatedAt : '';
  const ms = typeof m.updatedAt === 'string' ? m.updatedAt : '';
  return ds > ms ? { ...d } : { ...m };
}

// ------------------------------------------------------------------ store

type Mutator = (state: LineageState, stamp: string) => void;

interface DiskRead {
  state: LineageState;
  /** Canonical serialisation of `state` — comparable across windows. */
  text: string;
  /** false only for a hard read error (NOT for "missing" and NOT for
   *  "corrupt", both of which are recoverable and yield an empty state). */
  ok: boolean;
}

export interface StateStoreOptions {
  /** Coalescing window for reloadFromDisk(); a single rename fires several
   *  watcher events. Default 60 ms. */
  reloadDebounceMs?: number;
  /** Timer seam (tests inject a fake clock). */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** Liveness probe used to prune window records.
   *  Default: process.kill(pid, 0). */
  isAlive?: (pid: number) => boolean;
}

/**
 * The editorial store: `<globalStorageUri>/state.json`.
 *
 * Write discipline (multiple windows write this file concurrently):
 *   1. every mutator goes through one serialised queue — two mutations in
 *      this window can never interleave, and a burst coalesces into a single
 *      read/merge/write pass;
 *   2. the pass takes an advisory O_EXCL lock file (stale locks from a
 *      crashed window are broken after 5 s; a lock we cannot take degrades to
 *      a lock-free write rather than dropping the user's edit);
 *   3. it re-reads and re-migrates the file at write time and merges
 *      `mergeStates(freshDisk, memory)` — no parsed disk copy is ever held
 *      across an await before the write;
 *   4. it writes a temp file in the SAME directory, fsyncs it, re-reads and
 *      re-parses the bytes, then renames over state.json (retrying
 *      EPERM/EBUSY once);
 *   5. it re-reads afterwards: if another window's rename clobbered ours in
 *      the gap, it merges their content in and writes again (bounded).
 *
 * Nothing here is cleaned up in deactivate() — that is unsupported by the
 * host. The store self-heals on load() instead (mkdir, stale temp files,
 * corrupt-file backup).
 */
export class StateStore implements DisposableLike {
  readonly storageDir: string;
  readonly filePath: string;
  private readonly lockPath: string;
  /** Distinguishes two stores that share a pid (two windows never do, but two
   *  StateStore instances in one test process do — and a shared temp filename
   *  is a truncation race either way). */
  private readonly tmpToken = Math.random().toString(36).slice(2, 10);
  /** Best-effort counters; handy in the output channel and in tests. */
  readonly stats = { reads: 0, writes: 0, conflicts: 0, corruptBackups: 0 };

  /** The schema version state.json CLAIMED the first time this store read it,
   *  before the ladder ran — or null when there was no file to read.
   *
   *  It is the only honest answer to "which build did this install last run",
   *  and it is captured rather than derived because it survives for exactly one
   *  read: the first write stamps the file forward, after which nothing on disk
   *  remembers. Set once and never updated, so a later reload (which by then
   *  sees the migrated version) cannot erase the evidence.
   *
   *  `null` means a fresh install, NOT "an old file we could not date": a hard
   *  read error leaves it null too, and an upgrade notice that fires on an IO
   *  error would be worse than one that stays quiet. */
  private schemaVersionSeen: number | null = null;
  private schemaVersionCaptured = false;

  /** @see schemaVersionSeen */
  get schemaVersionAtLoad(): number | null {
    return this.schemaVersionSeen;
  }

  private memory: LineageState = emptyState();
  private serialized: string = stableStringify(emptyState());
  private pendingMutations: Mutator[] = [];
  private tail: Promise<void> = Promise.resolve();
  private listeners: Array<() => void> = [];
  private disposed = false;
  private tmpCounter = 0;
  private lastCorruptText: string | null = null;

  private reloadTimer: unknown = null;
  private pendingReload: {
    promise: Promise<void>;
    resolve: () => void;
  } | null = null;

  private readonly reloadDebounceMs: number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly isAliveFn: (pid: number) => boolean;

  constructor(storageDir: string, opts: StateStoreOptions = {}) {
    this.storageDir = storageDir;
    this.filePath = path.join(storageDir, STATE_FILE);
    this.lockPath = path.join(storageDir, LOCK_FILE);
    this.reloadDebounceMs = opts.reloadDebounceMs ?? DEFAULT_RELOAD_DEBOUNCE_MS;
    this.setTimeoutFn =
      opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms) as unknown);
    this.clearTimeoutFn =
      opts.clearTimeout ??
      ((handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      });
    this.isAliveFn = opts.isAlive ?? defaultIsAlive;
  }

  // ---------------------------------------------------------------- lifecycle

  /** mkdir -p the storage dir (it is NOT guaranteed to exist), read + migrate
   *  (missing file → empty state), and sweep leftovers from a crashed write.
   *  Never throws; a broken storage dir degrades to an in-memory-only store. */
  async load(): Promise<void> {
    await this.ensureDir();
    await this.chain(async () => {
      const disk = await this.readDisk();
      if (!disk.ok) return; // keep whatever we have; do not wipe on IO error
      this.memory = disk.state;
      this.serialized = disk.text;
    });
    await this.sweepStaleTemp();
  }

  /**
   * Re-read from disk. extension.ts wires this to the FileSystemWatcher's
   * onDidChange/onDidCreate/onDidDelete. Calls inside the debounce window
   * collapse into one read (a single rename produces a burst of events, and
   * every window sees its own writes too). Fires onDidChange only when the
   * loaded content actually differs from what we hold.
   */
  reloadFromDisk(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pendingReload) return this.pendingReload.promise;

    let resolveFn: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      resolveFn = resolve;
    });
    this.pendingReload = { promise, resolve: resolveFn };
    this.reloadTimer = this.setTimeoutFn(() => {
      this.reloadTimer = null;
      const pending = this.pendingReload;
      this.pendingReload = null;
      const done = (): void => pending?.resolve();
      this.chain(() => this.doReload()).then(done, done);
    }, this.reloadDebounceMs);
    return promise;
  }

  dispose(): void {
    this.disposed = true;
    if (this.reloadTimer !== null) {
      try {
        this.clearTimeoutFn(this.reloadTimer);
      } catch (e) {
        logError('state: clearTimeout failed', e);
      }
      this.reloadTimer = null;
    }
    const pending = this.pendingReload;
    this.pendingReload = null;
    pending?.resolve();
    this.listeners = [];
  }

  // ------------------------------------------------------------------- reads

  get(id: string): EditorialRecord | undefined {
    const rec = this.memory.records[id];
    return rec ? { ...rec } : undefined;
  }

  all(): Record<string, EditorialRecord> {
    return { ...this.memory.records };
  }

  /** Window records that still plausibly exist, newest publish first. Dead
   *  pids are filtered here as well as pruned on publish, so a stale focus
   *  handle never becomes a dead end between two activations. */
  getWindows(): WindowRecord[] {
    const cutoff = Date.now() - WINDOW_TTL_MS;
    return Object.values(this.memory.windows)
      .filter((w) => {
        const ts = Date.parse(w.publishedAt);
        if (Number.isFinite(ts) && ts < cutoff) return false;
        return safeIsAlive(this.isAliveFn, w.pid);
      })
      .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  }

  getHookState(): HookInstallState {
    const h = this.memory.hookInstall;
    return h ? { ...h } : { installed: false };
  }

  /** The in-session verbs' install record — hookInstall's twin, and stored
   *  under its own key so installing one never claims the other. */
  getVerbsState(): HookInstallState {
    const v = this.memory.verbsInstall;
    return v ? { ...v } : { installed: false };
  }

  /** Every project, name-sorted. Hidden ones are INCLUDED — the tree filters,
   *  and "Show Hidden…" has to be able to list them. Deleted ones are not:
   *  a tombstone is a merge artefact, never a row. */
  getProjects(): ProjectRecord[] {
    return Object.values(this.memory.projects ?? {})
      .filter((p) => p.deleted !== true)
      .map((p) => ({ ...p, dirs: [...(p.dirs ?? [])] }))
      .sort((a, b) => {
        const an = a.name.toLowerCase();
        const bn = b.name.toLowerCase();
        return an < bn ? -1 : an > bn ? 1 : a.id < b.id ? -1 : 1;
      });
  }

  getProject(id: string): ProjectRecord | undefined {
    const p = this.memory.projects?.[id];
    if (!p || p.deleted === true) return undefined;
    return { ...p, dirs: [...(p.dirs ?? [])] };
  }

  getHiddenFolders(): HiddenFolder[] {
    return Object.values(this.memory.hiddenFolders ?? {})
      .map((f) => ({ ...f }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  onDidChange(listener: () => void): DisposableLike {
    this.listeners.push(listener);
    return {
      dispose: (): void => {
        const i = this.listeners.indexOf(listener);
        if (i >= 0) this.listeners.splice(i, 1);
      },
    };
  }

  // ----------------------------------------------------------------- mutators

  /**
   * Merge a patch into one record (mirrors the Python prototype's
   * `upsert_node`): `undefined` values never clobber an existing field, an
   * explicit `null` DOES write — that is how `closed`, `parentId` and
   * `boundWindowId` get cleared. `id`/`createdAt`/`updatedAt` in the patch are
   * ignored; the store owns them.
   */
  upsert(id: string, patch: Partial<EditorialRecord>): Promise<void> {
    if (!isSessionId(id)) {
      log('state: refusing to upsert non-session id', id);
      return Promise.resolve();
    }
    const copy: Record<string, unknown> = { ...patch };
    for (const key of RESERVED_RECORD_KEYS) delete copy[key];
    if (
      copy.parentSource !== undefined &&
      (typeof copy.parentSource !== 'string' ||
        !PERSISTED_PARENT_SOURCES.has(copy.parentSource))
    ) {
      // Inferred sources are recomputed every tick, never stored.
      log('state: dropping non-persistable parentSource', copy.parentSource);
      delete copy.parentSource;
    }
    return this.enqueue((state, stamp) => {
      const prev = state.records[id];
      const next: Record<string, unknown> = prev ? { ...prev } : {};
      for (const [key, value] of Object.entries(copy)) {
        if (value === undefined) continue; // undefined never clobbers
        next[key] = value; // explicit null DOES write
      }
      next.id = id;
      next.createdAt = isNonEmptyString(next.createdAt) ? next.createdAt : stamp;
      next.updatedAt = stamp;
      state.records[id] = next as unknown as EditorialRecord;
    });
  }

  /**
   * Record an edge we know exactly because we minted both ids at launch.
   * `parentId: null` is still `'minted'` — "we know it has no parent" is
   * itself exact knowledge and must beat any later transcript inference.
   */
  recordLaunch(
    childId: string,
    parentId: string | null,
    cwd?: string,
  ): Promise<void> {
    return this.upsert(childId, {
      parentId,
      parentSource: 'minted',
      launchedByUs: true,
      cwd,
    });
  }

  // ---------------------------------------------------------------- chains

  /** Every persisted generation chain. Copies, in no meaningful order. */
  getChains(): ChainRecord[] {
    return Object.values(this.memory.chains ?? {}).map((c) => ({
      ...c,
      members: [...c.members],
    }));
  }

  /**
   * Record that `newId` is a NEW GENERATION of the conversation `anchorId`
   * belongs to — the re-key. `anchorId` may be any member of an existing chain
   * (typically the LINEAGE_NODE_ID a hook event inherited); when it belongs to
   * none, a fresh chain rooted at it is created. If the two ids turn out to
   * already sit in different chains, the chains are merged into the anchor's —
   * both were observations of the same conversation, and losing either's
   * members would orphan rows.
   */
  appendChainMember(anchorId: string, newId: string): Promise<void> {
    if (!isSessionId(anchorId) || !isSessionId(newId) || anchorId === newId) {
      return Promise.resolve();
    }
    return this.enqueue((state, stamp) => {
      if (!isPlainObject(state.chains)) state.chains = {};
      const chains = state.chains;

      const owner = (id: string): ChainRecord | undefined =>
        chains[id] ??
        Object.values(chains).find((c) => c.members.includes(id));

      const anchorChain = owner(anchorId);
      const newChain = owner(newId);

      if (anchorChain && newChain && anchorChain !== newChain) {
        const merged = mergeChainRecords(anchorChain, newChain);
        merged.rootId = anchorChain.rootId;
        merged.updatedAt = stamp;
        delete chains[newChain.rootId];
        chains[anchorChain.rootId] = merged;
        log(
          'state: merged chains',
          anchorChain.rootId,
          '+',
          newChain.rootId,
        );
        return;
      }
      const chain = anchorChain ?? newChain;
      if (chain) {
        if (chain.members.includes(newId) && chain.members.includes(anchorId)) {
          return; // already known — no write, no change event
        }
        if (!chain.members.includes(anchorId)) chain.members.push(anchorId);
        if (!chain.members.includes(newId)) chain.members.push(newId);
        chain.updatedAt = stamp;
        return;
      }
      chains[anchorId] = {
        rootId: anchorId,
        members: [anchorId, newId],
        createdAt: stamp,
        updatedAt: stamp,
      };
      log('state: new chain', anchorId, '→', newId);
    });
  }

  /**
   * Publish this window's focus handle and prune the windows that are gone.
   * Window records are namespaced by windowId, so another window's merge can
   * never overwrite ours. Pruning also clears `boundWindowId` on any session
   * that pointed at a window we just removed — a binding to a dead extension
   * host would otherwise route focus into the void forever.
   */
  publishWindow(
    rec: WindowRecord,
    isAlive?: (pid: number) => boolean,
  ): Promise<void> {
    const probe = isAlive ?? this.isAliveFn;
    return this.enqueue((state, stamp) => {
      const clean = sanitizeWindow(rec?.windowId ?? '', {
        ...rec,
        publishedAt: isNonEmptyString(rec?.publishedAt)
          ? rec.publishedAt
          : stamp,
      });
      if (!clean) {
        log('state: refusing to publish malformed window record');
        return;
      }
      state.windows[clean.windowId] = clean;

      const cutoff = Date.parse(stamp) - WINDOW_TTL_MS;
      const pruned: string[] = [];
      for (const [id, win] of Object.entries(state.windows)) {
        if (id === clean.windowId) continue;
        const ts = Date.parse(win.publishedAt);
        const expired = Number.isFinite(ts) ? ts < cutoff : true;
        if (expired || !safeIsAlive(probe, win.pid)) {
          delete state.windows[id];
          pruned.push(id);
        }
      }
      if (pruned.length > 0) {
        clearBindings(state, pruned, stamp);
        log('state: pruned', pruned.length, 'dead window record(s)');
      }
    });
  }

  removeWindow(windowId: string): Promise<void> {
    if (!isNonEmptyString(windowId)) return Promise.resolve();
    return this.enqueue((state, stamp) => {
      if (state.windows[windowId] === undefined) return;
      delete state.windows[windowId];
      clearBindings(state, [windowId], stamp);
    });
  }

  // -------------------------------------------------------------- projects

  /**
   * Merge a patch into one project. Same rules as `upsert`: `undefined` never
   * clobbers, the store owns id/createdAt/updatedAt. The whole record is run
   * back through `sanitizeProject` afterwards, so a patch can never install a
   * rootDir-less project or a `dirs` list that shadows the rootDir.
   */
  upsertProject(id: string, patch: Partial<ProjectRecord>): Promise<void> {
    if (!isNonEmptyString(id)) {
      log('state: refusing to upsert a project with no id');
      return Promise.resolve();
    }
    const copy: Record<string, unknown> = { ...patch };
    for (const key of RESERVED_RECORD_KEYS) delete copy[key];

    return this.enqueue((state, stamp) => {
      if (!isPlainObject(state.projects)) state.projects = {};
      const prev = state.projects[id];
      const next: Record<string, unknown> = prev ? { ...prev } : {};
      for (const [key, value] of Object.entries(copy)) {
        if (value === undefined) continue;
        next[key] = value;
      }
      next.id = id;
      next.createdAt = isNonEmptyString(next.createdAt) ? next.createdAt : stamp;
      const clean = sanitizeProject(id, next);
      if (!clean) {
        log('state: refusing to write a project with no usable rootDir', id);
        return;
      }
      clean.updatedAt = stamp;
      state.projects[id] = clean;
    });
  }

  /**
   * File a project under another one, or at the top level (`null`).
   *
   * Its own method rather than `upsertProject({ parentId })` for the reason
   * `setProjectRouting` is not one either: the write has a RULE attached that
   * the generic patch path knows nothing about. A move that closes a loop
   * (filing a project under its own subproject) would cut both subtrees out of
   * every render — the tree builder breaks the cycle, so nothing crashes and
   * nothing says why two projects jumped to the top level — and the check has
   * to happen against the whole set, at write time, in the one place that holds
   * it.
   *
   * Answers whether the move happened, so the verb can say what it refused
   * rather than silently doing nothing. Refuses to create a project as a side
   * effect: nesting is a property OF a project, and a rootDir-less record
   * minted here would be dropped by the sanitizer anyway.
   */
  setProjectParent(projectId: string, newParentId: string | null): Promise<boolean> {
    if (!isNonEmptyString(projectId)) return Promise.resolve(false);
    let ok = false;
    return this.enqueue((state, stamp) => {
      if (!isPlainObject(state.projects)) state.projects = {};
      const prev = state.projects[projectId];
      if (!prev || prev.deleted === true) {
        log('state: no such project to re-file', projectId);
        return;
      }
      const parentId =
        typeof newParentId === 'string' && newParentId.trim() !== ''
          ? newParentId.trim()
          : null;
      if (parentId !== null) {
        const live = Object.values(state.projects).filter(
          (p): p is ProjectRecord => !!p && p.deleted !== true,
        );
        const verdict = canReparentProject(live, projectId, parentId);
        if (!verdict.ok) {
          log('state: refused project re-file —', verdict.reason);
          return;
        }
      }
      const next: Record<string, unknown> = { ...prev };
      if (parentId === null) delete next.parentId;
      else next.parentId = parentId;
      const clean = sanitizeProject(projectId, next);
      if (!clean) return;
      clean.updatedAt = stamp;
      state.projects[projectId] = clean;
      ok = true;
    }).then(() => ok);
  }

  /**
   * Delete, recorded as a TOMBSTONE rather than a dropped key.
   *
   * `newerWins` keeps any key present on only one side, so a plain `delete`
   * cannot be told apart from "the other window has not heard of this project
   * yet": any window still holding the record in memory re-adds it on its very
   * next write, silently undoing a confirmed modal delete. Keeping the id with
   * `deleted: true` and a fresh `updatedAt` makes the delete a value the merge
   * can compare, so it wins over every older copy. Readers filter tombstones
   * out and `migrateState` sweeps them once they are older than any window.
   */
  deleteProject(id: string): Promise<void> {
    if (!isNonEmptyString(id)) return Promise.resolve();
    return this.enqueue((state, stamp) => {
      if (!isPlainObject(state.projects)) state.projects = {};
      state.projects[id] = {
        id,
        name: '',
        rootDir: '',
        dirs: [],
        deleted: true,
        createdAt: state.projects[id]?.createdAt ?? stamp,
        updatedAt: stamp,
      };
      // ITS LANES GO WITH IT. A lane is meaningless without the project it names —
      // unlike a nested project, which the tree could re-root at the top level —
      // so leaving them would keep every session stamped with one filed under a row
      // nobody draws. Tombstoned rather than dropped, for the same reason the
      // project itself is: a dropped key is indistinguishable from "not merged in
      // yet" and another window would re-add it.
      if (!isPlainObject(state.subprojects)) state.subprojects = {};
      for (const [laneId, lane] of Object.entries(state.subprojects)) {
        if (lane?.projectId !== id || lane.deleted === true) continue;
        state.subprojects[laneId] = {
          id: laneId,
          projectId: '',
          name: '',
          dir: '',
          deleted: true,
          createdAt: lane.createdAt ?? stamp,
          updatedAt: stamp,
        };
      }
    });
  }

  // ----------------------------------------------------- named subprojects

  /** Every live lane, project-then-creation ordered — which is the order the rows
   *  draw in, so a lane added today lands at the bottom of its project's list and
   *  nothing above it moves. Copies, like every other record this store hands
   *  out. */
  getSubprojects(): SubprojectRecord[] {
    return Object.values(this.memory.subprojects ?? {})
      .filter((s) => s.deleted !== true)
      .map((s) => ({ ...s }))
      .sort((a, b) => {
        if (a.projectId !== b.projectId) {
          return a.projectId < b.projectId ? -1 : 1;
        }
        if (a.createdAt !== b.createdAt) {
          return a.createdAt < b.createdAt ? -1 : 1;
        }
        return a.id < b.id ? -1 : 1;
      });
  }

  getSubproject(id: string): SubprojectRecord | undefined {
    const lane = this.memory.subprojects?.[id];
    if (!lane || lane.deleted === true) return undefined;
    return { ...lane };
  }

  /** Merge a patch into one lane. Same rules as `upsertProject`: `undefined` never
   *  clobbers, the store owns id/createdAt/updatedAt, and the whole record goes
   *  back through `sanitizeSubproject` — so a patch cannot install a lane with no
   *  project or no directory. */
  upsertSubproject(id: string, patch: Partial<SubprojectRecord>): Promise<void> {
    if (!isNonEmptyString(id)) {
      log('state: refusing to upsert a subproject with no id');
      return Promise.resolve();
    }
    const copy: Record<string, unknown> = { ...patch };
    for (const key of RESERVED_RECORD_KEYS) delete copy[key];

    return this.enqueue((state, stamp) => {
      if (!isPlainObject(state.subprojects)) state.subprojects = {};
      const prev = state.subprojects[id];
      const next: Record<string, unknown> = prev ? { ...prev } : {};
      for (const [key, value] of Object.entries(copy)) {
        if (value === undefined) continue;
        next[key] = value;
      }
      next.id = id;
      next.createdAt = isNonEmptyString(next.createdAt) ? next.createdAt : stamp;
      const clean = sanitizeSubproject(id, next);
      if (!clean) {
        log('state: refusing to write a subproject with no project or directory', id);
        return;
      }
      clean.updatedAt = stamp;
      state.subprojects[id] = clean;
    });
  }

  /**
   * Tombstone one lane.
   *
   * The sessions STAMPED with it are deliberately left alone. Their stamp becomes
   * dangling, which every reader treats as absent — so they fall back to being
   * placed by directory, exactly as a session started by hand in a terminal always
   * has been. Rewriting the stamps here would be the destructive reading of
   * "remove a row", and it would also be a write over every session in the lane
   * from one window while another may still hold the record.
   */
  deleteSubproject(id: string): Promise<void> {
    if (!isNonEmptyString(id)) return Promise.resolve();
    return this.enqueue((state, stamp) => {
      if (!isPlainObject(state.subprojects)) state.subprojects = {};
      state.subprojects[id] = {
        id,
        projectId: '',
        name: '',
        dir: '',
        deleted: true,
        createdAt: state.subprojects[id]?.createdAt ?? stamp,
        updatedAt: stamp,
      };
    });
  }

  // --------------------------------------------------------- hidden folders

  hideFolder(dir: string): Promise<void> {
    const path = normalizeDir(dir);
    if (path === '') return Promise.resolve();
    return this.enqueue((state, stamp) => {
      if (!isPlainObject(state.hiddenFolders)) state.hiddenFolders = {};
      state.hiddenFolders[path] = { path, hiddenAt: stamp };
    });
  }

  /** Removes the exact key AND any key that only differs by case/separator,
   *  so un-hiding always undoes the hide the user is looking at. */
  unhideFolder(dir: string): Promise<void> {
    const key = pathKey(dir);
    if (key === '') return Promise.resolve();
    return this.enqueue((state) => {
      if (!isPlainObject(state.hiddenFolders)) state.hiddenFolders = {};
      for (const existing of Object.keys(state.hiddenFolders)) {
        if (pathKey(existing) === key) delete state.hiddenFolders[existing];
      }
    });
  }

  // --------------------------------------------------------- minted branches

  /** Record that Flock created `branch` (`git worktree add -b`). Written once,
   *  from the verb that ran the add — never from a probe or a poll. */
  recordMintedBranch(repoDir: string, branch: string): Promise<void> {
    const repo = pathKey(repoDir);
    if (repo === '' || branch === '') return Promise.resolve();
    return this.enqueue((state, stamp) => {
      if (!isPlainObject(state.mintedBranches)) state.mintedBranches = {};
      state.mintedBranches[mintedBranchKey(repo, branch)] = {
        repo,
        branch,
        mintedAt: stamp,
      };
    });
  }

  /** Whether Flock created `branch` — what earns the delete OFFER when its
   *  worktree is removed. Absent means no offer, which is the right reading
   *  for a ref minted by another tool, by hand, or by a build before v8. */
  isMintedBranch(repoDir: string, branch: string): boolean {
    const repo = pathKey(repoDir);
    if (repo === '' || branch === '') return false;
    return (
      this.memory.mintedBranches?.[mintedBranchKey(repo, branch)] !== undefined
    );
  }

  /** Drop the record — after the ref is deleted, or found already gone. */
  forgetMintedBranch(repoDir: string, branch: string): Promise<void> {
    const repo = pathKey(repoDir);
    if (repo === '' || branch === '') return Promise.resolve();
    return this.enqueue((state) => {
      if (!isPlainObject(state.mintedBranches)) state.mintedBranches = {};
      delete state.mintedBranches[mintedBranchKey(repo, branch)];
    });
  }

  /** Sweep one repository's records against the refs that still exist. Called
   *  only from a verb that has just READ the branch list anyway (the `+`'s
   *  auto flow) — never from a timer. A record another window's merge
   *  resurrects is swept again on the next call, which costs nothing. */
  pruneMintedBranches(
    repoDir: string,
    existing: readonly string[],
  ): Promise<void> {
    const repo = pathKey(repoDir);
    if (repo === '') return Promise.resolve();
    const live = new Set(existing);
    return this.enqueue((state) => {
      if (!isPlainObject(state.mintedBranches)) state.mintedBranches = {};
      for (const [key, rec] of Object.entries(state.mintedBranches)) {
        if (rec.repo === repo && !live.has(rec.branch)) {
          delete state.mintedBranches[key];
        }
      }
    });
  }

  setHookState(s: HookInstallState): Promise<void> {
    const clean = sanitizeHookState(s) ?? { installed: false };
    return this.enqueue((state) => {
      state.hookInstall = clean;
    });
  }

  setVerbsState(s: HookInstallState): Promise<void> {
    const clean = sanitizeHookState(s) ?? { installed: false };
    return this.enqueue((state) => {
      state.verbsInstall = clean;
    });
  }

  // ------------------------------------------------------------- workspaces

  /** The saved layout for one project, or undefined. */
  getWorkspace(projectId: string): WorkspaceSnapshot | undefined {
    const ws = this.memory.workspaces?.[projectId];
    return ws ? { ...ws, tabs: ws.tabs.map((t) => ({ ...t })) } : undefined;
  }

  /** Replace one project's saved layout wholesale — a layout is a value, not
   *  a set, so there is nothing to merge field-wise. */
  saveWorkspace(projectId: string, tabs: WorkspaceTabRecord[]): Promise<void> {
    if (!isNonEmptyString(projectId)) return Promise.resolve();
    return this.enqueue((state, stamp) => {
      if (!isPlainObject(state.workspaces)) state.workspaces = {};
      const clean = sanitizeWorkspace(projectId, {
        tabs,
        savedAt: stamp,
        updatedAt: stamp,
      });
      if (!clean) return;
      state.workspaces[projectId] = clean;
    });
  }

  deleteWorkspace(projectId: string): Promise<void> {
    if (!isNonEmptyString(projectId)) return Promise.resolve();
    return this.enqueue((state) => {
      if (!isPlainObject(state.workspaces)) state.workspaces = {};
      delete state.workspaces[projectId];
    });
  }

  // ---------------------------------------------------------------- accounts
  // The account roster, its one settings record, and the two writes that attach
  // a routing choice to a project and a PIN to a session.

  /** Every live account, in the user's own arrangement (accounts.sortProfiles
   *  — the same order the view draws and the auto-picker breaks ties on).
   *  Tombstones are never returned: a deleted account is gone, and the record
   *  that proves it is a merge artefact, not a row. */
  getAccounts(): AccountProfile[] {
    return sortProfiles(
      Object.values(this.memory.accounts ?? {}).filter((a) => a.deleted !== true),
    ).map(cloneAccount);
  }

  getAccount(id: string): AccountProfile | undefined {
    const a = this.memory.accounts?.[id];
    if (!a || a.deleted === true) return undefined;
    return cloneAccount(a);
  }

  /**
   * Every account id this store holds, TOMBSTONES INCLUDED — for minting a new
   * id, and for nothing else.
   *
   * Pins outlive tombstones (a pin is forever, a tombstone 30 days), so an id
   * handed back out is an id that some conversation may still name. Re-adding
   * an account with the same LABEL is meant to pick the same login back up —
   * and does, when the replacement is the same kind of account — but a
   * replacement that authenticates differently would answer those old pins
   * with a different subscription, without a word. Dedupe against this and the
   * collision suffix takes care of it.
   */
  accountIds(): string[] {
    return Object.keys(this.memory.accounts ?? {});
  }

  /** The machine-wide default routing, or undefined for "never set" — which
   *  every consumer must read as `{ kind: 'auto' }` rather than as an error. */
  getDefaultRouting(): RoutingChoice | undefined {
    const choice = this.memory.accountSettings?.defaultRouting;
    return isRoutingChoice(choice) ? choice : undefined;
  }

  /**
   * The account a CONVERSATION is pinned to, chain included.
   *
   * The session's own record first, then — if it carries no pin — the earliest
   * pin held by any member of its generation chain. That second step is the
   * whole reason this lives in the store rather than at the call site: a plain
   * `--resume` can mint a fresh session id, and the new generation's record is
   * brand new and empty. Reading only its own field would launch generation two
   * of a conversation on a different account from generation one, which is
   * precisely the failure `profileId` exists to prevent.
   *
   * Members are ordered oldest → newest, so the answer is the account the
   * conversation STARTED on. Forks are not covered here (a fork is a different
   * conversation with its own record); the launcher copies the parent's pin at
   * fork time, when it still knows who the parent is.
   */
  getSessionProfile(sessionId: string): string | undefined {
    const own = this.memory.records[sessionId]?.profileId;
    if (isAccountId(own)) return own;
    for (const chain of Object.values(this.memory.chains ?? {})) {
      if (!chain.members.includes(sessionId)) continue;
      for (const member of chain.members) {
        const pin = this.memory.records[member]?.profileId;
        if (isAccountId(pin)) return pin;
      }
      break; // a session belongs to at most one chain
    }
    return undefined;
  }

  /**
   * The LANE a session was started in — EditorialRecord.subprojectId.
   *
   * The same shape as `getSessionProfile` above, and deliberately: the two fields
   * have the same contract (written once at launch, never re-decided) and
   * therefore the same inheritance. A `/clear` starts a fresh transcript under a
   * new id and it is still the same piece of work, so a new generation reads the
   * chain's stamp rather than losing the row it was filed under.
   *
   * A stamp naming a lane that no longer exists resolves to `undefined`, which
   * every reader treats as "not started in a lane" — the session is then placed by
   * directory, which is the answer that cannot be wrong. That is what makes
   * deleteSubproject safe to leave every stamp alone.
   */
  getSessionSubproject(sessionId: string): string | undefined {
    const live = (id: unknown): string | undefined => {
      if (typeof id !== 'string' || id === '') return undefined;
      const lane = this.memory.subprojects?.[id];
      return lane && lane.deleted !== true ? id : undefined;
    };
    const own = live(this.memory.records[sessionId]?.subprojectId);
    if (own !== undefined) return own;
    for (const chain of Object.values(this.memory.chains ?? {})) {
      if (!chain.members.includes(sessionId)) continue;
      for (const member of chain.members) {
        const stamp = live(this.memory.records[member]?.subprojectId);
        if (stamp !== undefined) return stamp;
      }
      break; // a session belongs to at most one chain
    }
    return undefined;
  }

  /**
   * Merge a patch into one account. Same rules as `upsertProject`: `undefined`
   * never clobbers, the store owns id/createdAt/updatedAt, and the whole record
   * is run back through `sanitizeAccount` so a patch cannot install an env key
   * a launch would silently drop.
   *
   * Writing over a TOMBSTONE starts from a blank record rather than from the
   * tombstone: re-creating an account someone deleted has to produce an
   * account, and inheriting `deleted: true` would make the write a no-op that
   * looked like it worked.
   */
  upsertAccount(id: string, patch: Partial<AccountProfile>): Promise<void> {
    if (!isAccountId(id)) {
      log('state: refusing to upsert an account with an unusable id', id);
      return Promise.resolve();
    }
    const copy: Record<string, unknown> = { ...patch };
    for (const key of RESERVED_RECORD_KEYS) delete copy[key];
    delete copy.deleted; // deleteAccount owns the tombstone

    return this.enqueue((state, stamp) => {
      if (!isPlainObject(state.accounts)) state.accounts = {};
      const prev = state.accounts[id];
      const base = prev && prev.deleted !== true ? prev : undefined;
      const next: Record<string, unknown> = base ? { ...base } : {};
      for (const [key, value] of Object.entries(copy)) {
        if (value === undefined) continue;
        next[key] = value;
      }
      next.id = id;
      next.createdAt = isNonEmptyString(next.createdAt) ? next.createdAt : stamp;
      // A new account lands at the END of the list. Anything else would move
      // the rows the user already arranged.
      if (next.order === undefined) {
        next.order = nextOrder(
          Object.values(state.accounts).filter((a) => a.deleted !== true),
        );
      }
      const clean = sanitizeAccount(id, next);
      if (!clean) {
        log('state: refusing to write an unusable account', id);
        return;
      }
      clean.updatedAt = stamp;
      state.accounts[id] = clean;
    });
  }

  /** Delete, as a TOMBSTONE — for the same reason `deleteProject` writes one:
   *  a dropped key is indistinguishable from "the other window has not heard of
   *  this account yet", and every live window would re-add it on its next
   *  write. Sessions pinned to it keep the dangling id on purpose; they resume
   *  on the default login (see routing.pinnedProfile) rather than being
   *  silently moved to somebody else's subscription. */
  deleteAccount(id: string): Promise<void> {
    if (!isNonEmptyString(id)) return Promise.resolve();
    return this.enqueue((state, stamp) => {
      if (!isPlainObject(state.accounts)) state.accounts = {};
      state.accounts[id] = {
        id,
        provider: DEFAULT_PROVIDER,
        label: '',
        order: 0,
        deleted: true,
        createdAt: state.accounts[id]?.createdAt ?? stamp,
        updatedAt: stamp,
      };
    });
  }

  /** One account's position. Its own method rather than `upsertAccount({order})`
   *  because a reorder must never MINT an account: the caller computes moves
   *  from a list it rendered (accounts.moveUp / moveDown), and an id that has
   *  since been deleted in another window has to be a no-op, not a resurrection.
   */
  setAccountOrder(id: string, order: number): Promise<void> {
    if (!isAccountId(id) || !Number.isFinite(order)) return Promise.resolve();
    return this.enqueue((state, stamp) => {
      if (!isPlainObject(state.accounts)) state.accounts = {};
      const prev = state.accounts[id];
      if (!prev || prev.deleted === true) return;
      if (prev.order === order) return; // no write, no change event
      state.accounts[id] = { ...prev, order, updatedAt: stamp };
    });
  }

  /** The machine-wide default routing. `null` clears it, which reads as
   *  `{ kind: 'auto' }` everywhere — the same thing an untouched install has. */
  setDefaultRouting(choice: RoutingChoice | null): Promise<void> {
    if (choice !== null && !isRoutingChoice(choice)) {
      log('state: refusing to store an unusable default routing');
      return Promise.resolve();
    }
    return this.enqueue((state, stamp) => {
      const next: AccountSettings = { ...(state.accountSettings ?? {}) };
      if (choice === null) delete next.defaultRouting;
      else next.defaultRouting = choice;
      next.updatedAt = stamp;
      state.accountSettings = next;
    });
  }

  /**
   * A project's routing override. `null` REMOVES it (back to the global
   * default), which is why this is not `upsertProject({ routing })`: that path
   * treats `undefined` as "leave alone" and has no spelling for "unset", and a
   * persisted `routing: null` would be a third state nobody wants to reason
   * about.
   *
   * Refuses to create a project that does not exist. Routing is a property OF a
   * project, and a rootDir-less record minted here would be dropped by the
   * sanitizer on the next load anyway.
   */
  setProjectRouting(
    projectId: string,
    choice: RoutingChoice | null,
  ): Promise<void> {
    if (!isNonEmptyString(projectId)) return Promise.resolve();
    if (choice !== null && !isRoutingChoice(choice)) {
      log('state: refusing to store an unusable project routing', projectId);
      return Promise.resolve();
    }
    return this.enqueue((state, stamp) => {
      if (!isPlainObject(state.projects)) state.projects = {};
      const prev = state.projects[projectId];
      if (!prev || prev.deleted === true) {
        log('state: no such project to set routing on', projectId);
        return;
      }
      const next: Record<string, unknown> = { ...prev };
      if (choice === null) delete next.routing;
      else next.routing = choice;
      const clean = sanitizeProject(projectId, next);
      if (!clean) return;
      clean.updatedAt = stamp;
      state.projects[projectId] = clean;
    });
  }

  /**
   * PIN a session to the account it launched on. Write-once, deliberately.
   *
   * A conversation belongs to one account for life: its transcript lives inside
   * that account's config directory, and every later resume has to re-inject
   * the same environment or it will either fail to find the conversation or
   * bill a different subscription for the same thread. So a second, different
   * pin is not a correction — it is a bug at the call site, and the store keeps
   * the original and says so rather than making the session's history
   * ambiguous.
   */
  setSessionProfile(sessionId: string, profileId: string): Promise<void> {
    if (!isSessionId(sessionId)) return Promise.resolve();
    if (!isAccountId(profileId)) {
      log('state: refusing to pin a session to an unusable account id');
      return Promise.resolve();
    }
    return this.enqueue((state, stamp) => {
      const prev = state.records[sessionId];
      const existing = prev?.profileId;
      if (isAccountId(existing)) {
        if (existing !== profileId) {
          log(
            'state: session',
            sessionId,
            'is already pinned to',
            existing,
            '— keeping it',
          );
        }
        return; // no write, no change event
      }
      const next: Record<string, unknown> = prev ? { ...prev } : {};
      next.id = sessionId;
      next.profileId = profileId;
      next.createdAt = isNonEmptyString(next.createdAt) ? next.createdAt : stamp;
      next.updatedAt = stamp;
      state.records[sessionId] = next as unknown as EditorialRecord;
    });
  }

  /**
   * RE-PIN a conversation onto another account — the one write allowed to
   * replace a pin, because the user is the one asking.
   *
   * Deliberately a different method from `setSessionProfile` above, exactly as
   * `moveSessionSubproject` is from `setSessionSubproject`, so that "the launch
   * path must not overwrite" and "the user may move this conversation" never
   * have to be the same rule. A launch reaching this by accident would be the
   * silent re-billing the write-once pin exists to prevent; a user reaching it
   * on purpose has already been told what it costs.
   *
   * CHAIN-WIDE, and that is the whole reason this is a store method rather than
   * one `upsert`. `getSessionProfile` falls back to the EARLIEST pin held by any
   * member of the conversation's generation chain, so re-pinning the tip alone
   * would leave a `/clear`-era generation quietly dragging the conversation back
   * to the account it came from on the next resume. Every member that already
   * carries a pin is rewritten with it.
   *
   * Members with NO pin are left alone, which is not an oversight: tree
   * membership in this extension is editorial, so minting a record for a
   * generation that never had one would put an old row back on screen as a side
   * effect of a billing change. They read the chain's answer through
   * `getSessionProfile` regardless.
   *
   * The BYTES are somebody else's job (see accountMove.ts). This method records
   * where the conversation now belongs; it does not move it there, and calling
   * it without moving the transcript would leave a pin naming an account whose
   * config directory does not hold the conversation.
   */
  moveSessionProfile(sessionId: string, profileId: string): Promise<void> {
    if (!isSessionId(sessionId)) return Promise.resolve();
    if (!isAccountId(profileId)) {
      log('state: refusing to move a session to an unusable account id');
      return Promise.resolve();
    }
    return this.enqueue((state, stamp) => {
      const repin = (id: string): boolean => {
        const prev = state.records[id];
        if (prev?.profileId === profileId) return false;
        const next: Record<string, unknown> = prev ? { ...prev } : {};
        next.id = id;
        next.profileId = profileId;
        next.createdAt = isNonEmptyString(next.createdAt)
          ? next.createdAt
          : stamp;
        next.updatedAt = stamp;
        state.records[id] = next as unknown as EditorialRecord;
        return true;
      };

      let moved = repin(sessionId) ? 1 : 0;
      for (const chain of Object.values(state.chains ?? {})) {
        if (!chain.members.includes(sessionId)) continue;
        for (const member of chain.members) {
          if (member === sessionId) continue;
          // Only a member that ALREADY answers the pin question — see above.
          if (!isAccountId(state.records[member]?.profileId)) continue;
          if (repin(member)) moved++;
        }
        break; // a session belongs to at most one chain
      }
      if (moved > 0) {
        log(
          'state: moved',
          sessionId,
          'to account',
          profileId,
          `(${String(moved)} record(s))`,
        );
      }
    });
  }

  /**
   * Stamp a session with the LANE it was started in. Once, and never again.
   *
   * The same write-once discipline as `setSessionProfile` above, for a related but
   * weaker reason. A second account pin would make a conversation's billing history
   * ambiguous; a second lane stamp is merely a lie about where the work was
   * started, which is what the row is for. Either way a re-stamp is a bug at the
   * call site rather than a correction, and the store keeps the first answer.
   *
   * MOVING a session between lanes is a separate verb with a separate method
   * (`moveSessionSubproject`), so that "the launch path must not overwrite" and
   * "the user may re-file" do not have to be the same rule.
   */
  setSessionSubproject(sessionId: string, subprojectId: string): Promise<void> {
    if (!isSessionId(sessionId)) return Promise.resolve();
    if (!isNonEmptyString(subprojectId)) {
      log('state: refusing to stamp a session with an unusable subproject id');
      return Promise.resolve();
    }
    return this.enqueue((state, stamp) => {
      const prev = state.records[sessionId];
      const existing = prev?.subprojectId;
      if (isNonEmptyString(existing)) {
        if (existing !== subprojectId) {
          log(
            'state: session',
            sessionId,
            'was already started in subproject',
            existing,
            '— keeping it',
          );
        }
        return; // no write, no change event
      }
      const next: Record<string, unknown> = prev ? { ...prev } : {};
      next.id = sessionId;
      next.subprojectId = subprojectId;
      next.createdAt = isNonEmptyString(next.createdAt) ? next.createdAt : stamp;
      next.updatedAt = stamp;
      state.records[sessionId] = next as unknown as EditorialRecord;
    });
  }

  /**
   * RE-FILE a session into another lane — or out of every lane (`null`).
   *
   * The one write that is allowed to replace a stamp, because the user is the one
   * asking: they dragged the row. Deliberately a different method from the launch
   * stamp so that neither rule has to know about the other.
   *
   * `null` clears it, and the session goes back to being placed by DIRECTORY —
   * which is the same state every session that Flock did not start is already in,
   * so there is nothing special about the result.
   */
  moveSessionSubproject(
    sessionId: string,
    subprojectId: string | null,
  ): Promise<void> {
    if (!isSessionId(sessionId)) return Promise.resolve();
    return this.enqueue((state, stamp) => {
      const prev = state.records[sessionId];
      const before = prev?.subprojectId;
      const after = isNonEmptyString(subprojectId) ? subprojectId : undefined;
      if (before === after) return; // no write, no change event
      const next: Record<string, unknown> = prev ? { ...prev } : {};
      next.id = sessionId;
      if (after === undefined) delete next.subprojectId;
      else next.subprojectId = after;
      next.createdAt = isNonEmptyString(next.createdAt) ? next.createdAt : stamp;
      next.updatedAt = stamp;
      state.records[sessionId] = next as unknown as EditorialRecord;
    });
  }

  // -------------------------------------------------------------- internals

  private emitChange(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (e) {
        logError('state: onDidChange listener threw', e);
      }
    }
  }

  /** Serialise every disk operation. `op` runs after everything queued before
   *  it, whether that succeeded or not. */
  private chain(op: () => Promise<void>): Promise<void> {
    const run = this.tail.then(op, op);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Queue a mutation. Mutations that pile up while a write is in flight are
   *  applied together in the next pass, so a burst costs one write and no
   *  mutation can be lost behind another. Never rejects. */
  private enqueue(mutate: Mutator): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.pendingMutations.push(mutate);
    return this.chain(() => this.flush()).catch((e) => {
      logError('state: flush failed', e);
    });
  }

  private async flush(): Promise<void> {
    const batch = this.pendingMutations;
    if (batch.length === 0) return; // an earlier pass already took them
    this.pendingMutations = [];

    const before = this.serialized;
    // The globalStorage dir can be deleted under a running window; recreate
    // it here rather than failing the lock and every write after it.
    await this.ensureDir();
    const locked = await this.acquireLock();
    try {
      await this.flushLocked(batch);
    } finally {
      if (locked) await this.releaseLock();
    }
    if (this.serialized !== before) this.emitChange();
  }

  /** The read → merge → patch → write → verify pass itself. Runs under the
   *  advisory lock when we got it; the verify/re-merge loop is what keeps it
   *  correct when we did not. */
  private async flushLocked(batch: Mutator[]): Promise<void> {
    const stamp = nowIso();

    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const disk = await this.readDisk();
      // Nothing parsed survives across an await from here to the write: the
      // merge, patch and serialise below are synchronous, and the queue keeps
      // any other mutator out until this pass finishes.
      const merged = mergeStates(
        disk.ok ? disk.state : emptyState(),
        this.memory,
      );
      // Re-applied on EVERY attempt, not just the first. A retry happens
      // because another window clobbered us, so it re-reads their content —
      // and a mutation that removes something (a tombstone, an unhide) would
      // otherwise be undone by the very merge that noticed the conflict. Every
      // mutator is idempotent given a fixed `stamp`, which is why this is safe.
      for (const mutate of batch) {
        try {
          mutate(merged, stamp);
        } catch (e) {
          logError('state: mutation threw', e);
        }
      }

      let text: string;
      try {
        text = stableStringify(merged);
      } catch (e) {
        logError('state: could not serialise state', e);
        return;
      }
      this.memory = merged;
      this.serialized = text;

      if (disk.ok && text === disk.text) break; // disk already agrees

      try {
        await this.writeAtomic(text);
        this.stats.writes++;
      } catch (e) {
        logError('state: write failed (change kept in memory only)', e);
        break;
      }

      const after = await this.readDisk();
      if (!after.ok || after.text === text) break; // our bytes are on disk
      this.stats.conflicts++;
      log('state: another window wrote concurrently — re-merging');
      if (attempt === MAX_WRITE_ATTEMPTS - 1) {
        logError(
          'state: gave up after repeated concurrent writes',
          new Error(this.filePath),
        );
      }
    }
  }

  /**
   * Take the advisory lock, or give up and say so. Returns false when the
   * lock could not be taken — the caller writes anyway, because a stuck lock
   * must never mean the user's rename silently does nothing.
   */
  private async acquireLock(): Promise<boolean> {
    const deadline = Date.now() + LOCK_MAX_WAIT_MS;
    for (;;) {
      try {
        const handle = await fsp.open(this.lockPath, 'wx');
        try {
          await handle.writeFile(`${String(process.pid)} ${nowIso()}\n`, 'utf8');
        } finally {
          await handle.close();
        }
        return true;
      } catch (e) {
        if (errCode(e) !== 'EEXIST') {
          logError('state: could not create the lock file', e);
          return false;
        }
      }
      // Held by someone else — or by a window that died mid-write.
      let broke = false;
      try {
        const st = await fsp.stat(this.lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          log('state: breaking a stale state lock');
          await fsp.rm(this.lockPath, { force: true });
          broke = true;
        }
      } catch {
        broke = true; // vanished under us: try again immediately
      }
      if (Date.now() >= deadline) {
        log('state: state lock is busy — writing without it');
        return false;
      }
      if (broke) continue; // retry the create immediately
      await delay(LOCK_RETRY_MS + Math.floor(Math.random() * LOCK_RETRY_MS));
    }
  }

  private async releaseLock(): Promise<void> {
    try {
      await fsp.rm(this.lockPath, { force: true });
    } catch (e) {
      logError('state: could not release the state lock', e);
    }
  }

  private async doReload(): Promise<void> {
    if (this.disposed) return;
    const disk = await this.readDisk();
    if (!disk.ok) return; // transient IO error: keep what we have
    if (disk.text === this.serialized) return; // byte-identical: no event
    this.memory = disk.state;
    this.serialized = disk.text;
    this.emitChange();
  }

  /** Record what the file claimed, once, on the first read that got far enough
   *  to have an opinion. Every later read sees a version this process wrote. */
  private captureSchemaVersion(version: number | null): void {
    if (this.schemaVersionCaptured) return;
    this.schemaVersionCaptured = true;
    this.schemaVersionSeen = version;
  }

  private async readDisk(): Promise<DiskRead> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.filePath, 'utf8');
      this.stats.reads++;
    } catch (e) {
      if (errCode(e) === 'ENOENT') {
        // No file: a fresh install, and the one case that is genuinely "no
        // previous version" rather than "we could not tell".
        this.captureSchemaVersion(null);
        const state = emptyState();
        return { state, text: stableStringify(state), ok: true };
      }
      // Deliberately NOT captured: a hard read error dates nothing, and the
      // next read may well succeed and have the real answer.
      logError('state: cannot read ' + this.filePath, e);
      return { state: emptyState(), text: '', ok: false };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      // The ERROR OBJECT is deliberately not logged. This file can hold API
      // keys (AccountProfile.extraEnv), and V8's SyntaxError message quotes the
      // source either side of the fault — corruption landing near a key would
      // put that key in the output channel. The backup path already never logs
      // the text; this is the same rule for the message about it.
      logError(
        'state: state.json is not valid JSON',
        new Error(this.filePath),
      );
      await this.backupCorrupt(raw);
      this.captureSchemaVersion(null);
      const state = emptyState();
      return { state, text: stableStringify(state), ok: true };
    }
    if (!isPlainObject(parsed)) {
      logError('state: state.json is not an object', new Error(typeof parsed));
      await this.backupCorrupt(raw);
      this.captureSchemaVersion(null);
      const state = emptyState();
      return { state, text: stableStringify(state), ok: true };
    }

    // Read BEFORE the ladder runs — migrateState stamps the current version
    // onto whatever it returns, so afterwards there is nothing left to read.
    const claimed = parsed.version;
    this.captureSchemaVersion(
      typeof claimed === 'number' && Number.isFinite(claimed) ? claimed : 0,
    );

    const state = migrateState(parsed);
    return { state, text: stableStringify(state), ok: true };
  }

  /** A corrupt file must never brick the extension: move it aside loudly and
   *  start fresh. The backup keeps whatever the user's editorial layer held,
   *  so the loss is recoverable by hand. */
  private async backupCorrupt(raw: string): Promise<void> {
    if (this.lastCorruptText === raw) return; // already dealt with this blob
    this.lastCorruptText = raw;
    if (this.stats.corruptBackups >= MAX_CORRUPT_BACKUPS) {
      logError(
        'state: too many corrupt-state backups, not writing another',
        new Error(this.filePath),
      );
      return;
    }
    const stampedName =
      CORRUPT_PREFIX + new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(this.storageDir, stampedName);
    try {
      await fsp.rename(this.filePath, dest);
    } catch (e) {
      logError('state: could not move corrupt state aside', e);
      try {
        await fsp.writeFile(dest, raw, 'utf8');
      } catch (e2) {
        logError('state: could not back up corrupt state', e2);
        return;
      }
    }
    this.stats.corruptBackups++;
    logError(
      'state: corrupt state.json backed up to ' + dest + ' — starting fresh',
      new Error('corrupt state'),
    );
  }

  /**
   * Temp file in the same directory (a rename across filesystems gives
   * EXDEV), fsync, re-read + re-parse the bytes we wrote, then rename. The
   * rename is the atomic step: a reader in another window sees either the old
   * file or the whole new one, never a half-written blob.
   */
  private async writeAtomic(text: string): Promise<void> {
    await this.ensureDir();
    this.tmpCounter += 1;
    const tmp = path.join(
      this.storageDir,
      `${TMP_PREFIX}${String(process.pid)}.${this.tmpToken}.${String(
        this.tmpCounter,
      )}${TMP_SUFFIX}`,
    );
    try {
      let handle: fsp.FileHandle | undefined;
      try {
        handle = await fsp.open(tmp, 'w');
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally {
        if (handle) await handle.close();
      }
      const back = await fsp.readFile(tmp, 'utf8');
      if (back !== text) {
        throw new Error('temp file did not round-trip (short write?)');
      }
      JSON.parse(back); // proves the bytes on disk are parseable
      await this.renameWithRetry(tmp, this.filePath);
    } catch (e) {
      try {
        await fsp.rm(tmp, { force: true });
      } catch {
        /* best effort */
      }
      throw e;
    }
  }

  /** globalStorageUri is NOT guaranteed to exist, and can vanish at runtime. */
  private async ensureDir(): Promise<void> {
    try {
      await fsp.mkdir(this.storageDir, { recursive: true });
    } catch (e) {
      logError('state: cannot create storage dir ' + this.storageDir, e);
    }
  }

  private async renameWithRetry(tmp: string, dest: string): Promise<void> {
    try {
      await fsp.rename(tmp, dest);
    } catch (e) {
      const code = errCode(e);
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw e;
      await delay(RENAME_RETRY_MS);
      await fsp.rename(tmp, dest);
    }
  }

  /** Leftovers from a crashed write (ours or another window's). Age-gated so
   *  we never delete a temp file a live window is still filling. */
  private async sweepStaleTemp(): Promise<void> {
    let names: string[];
    try {
      names = await fsp.readdir(this.storageDir);
    } catch {
      return;
    }
    const cutoff = Date.now() - STALE_TMP_MS;
    for (const name of names) {
      if (!name.startsWith(TMP_PREFIX) || !name.endsWith(TMP_SUFFIX)) continue;
      const full = path.join(this.storageDir, name);
      try {
        const st = await fsp.stat(full);
        if (st.mtimeMs < cutoff) {
          await fsp.rm(full, { force: true });
          log('state: removed stale temp file', name);
        }
      } catch {
        /* best effort */
      }
    }
  }
}

/** Clear session→window bindings that point at windows which are gone. */
function clearBindings(
  state: LineageState,
  windowIds: readonly string[],
  stamp: string,
): void {
  const gone = new Set(windowIds);
  for (const [id, rec] of Object.entries(state.records)) {
    if (rec.boundWindowId && gone.has(rec.boundWindowId)) {
      state.records[id] = { ...rec, boundWindowId: null, updatedAt: stamp };
    }
  }
}
