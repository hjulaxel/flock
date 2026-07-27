// src/state.ts — the editorial state layer (owner B, M1).
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
// Imports allowed here: ./types, ./log, node:fs/promises, node:path,
// node:process. NEVER vscode — the watcher lives in extension.ts and calls
// reloadFromDisk(); this module stays unit-testable with no mock.

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as process from 'node:process';

import { log, logError } from './log';
import {
  STATE_SCHEMA_VERSION,
  isSessionId,
  type DisposableLike,
  type EditorialRecord,
  type HookInstallState,
  type LineageState,
  type WindowRecord,
} from './types';

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
 *  this is the fs-level stand-in for the Python's `flock`. */
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

/** Inferred lineage sources are NEVER persisted (SPEC §5.5) — only edges we
 *  minted ourselves or the user drew by hand survive a round trip. */
const PERSISTED_PARENT_SOURCES: ReadonlySet<string> = new Set([
  'minted',
  'reparent',
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
  return { version: STATE_SCHEMA_VERSION, records: {}, windows: {} };
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
  for (const k of ['hidden', 'launchedByUs'] as const) {
    if (rec[k] !== undefined && typeof rec[k] !== 'boolean') delete rec[k];
  }
  for (const k of ['title', 'summary', 'cwd', 'wrapRequestedAt'] as const) {
    if (rec[k] !== undefined && typeof rec[k] !== 'string') delete rec[k];
  }
  for (const k of ['closed', 'boundWindowId'] as const) {
    if (rec[k] !== undefined && rec[k] !== null && typeof rec[k] !== 'string') {
      delete rec[k];
    }
  }
  return rec as unknown as EditorialRecord;
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
 * v0 → v1. "v0" is any blob without a numeric `version` — in practice either
 * a pre-release file of ours or a creemux (Python) project state, whose
 * `nodes` map holds the same editorial fields under different names.
 *
 * Only editorial fields are carried across. Legacy `parent` edges are
 * deliberately NOT imported: in creemux they could come from lineage
 * inference, and SPEC §5.5 forbids persisting an inferred edge — freezing one
 * into `parentSource: 'minted'` would make a guess permanent. The legacy
 * `nodes` key itself is left in place (unknown top-level keys are preserved),
 * so nothing is destroyed by the fold.
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
 * Sanitize + version-stamp an arbitrary parsed blob (SPEC §4-B).
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

  const hook = sanitizeHookState(working.hookInstall);
  if (hook) out.hookInstall = hook;
  else delete out.hookInstall;

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

  const hook = mem.hookInstall ?? disk.hookInstall;
  if (hook) out.hookInstall = hook;
  else delete out.hookInstall;

  out.version = STATE_SCHEMA_VERSION;
  return out as unknown as LineageState;
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
   * Re-read from disk. Wired by the INTEGRATOR to the FileSystemWatcher's
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
   * Merge a patch into one record (mirrors Python `upsert_node`): `undefined`
   * values never clobber an existing field, an explicit `null` DOES write —
   * that is how `closed`, `parentId` and `boundWindowId` get cleared.
   * `id`/`createdAt`/`updatedAt` in the patch are ignored; the store owns them.
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
      // SPEC §5.5: inferred sources are recomputed every tick, never stored.
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

  setHookState(s: HookInstallState): Promise<void> {
    const clean = sanitizeHookState(s) ?? { installed: false };
    return this.enqueue((state) => {
      state.hookInstall = clean;
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
    let applied = false;

    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const disk = await this.readDisk();
      // Nothing parsed survives across an await from here to the write: the
      // merge, patch and serialise below are synchronous, and the queue keeps
      // any other mutator out until this pass finishes.
      const merged = mergeStates(
        disk.ok ? disk.state : emptyState(),
        this.memory,
      );
      if (!applied) {
        for (const mutate of batch) {
          try {
            mutate(merged, stamp);
          } catch (e) {
            logError('state: mutation threw', e);
          }
        }
        applied = true;
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

  private async readDisk(): Promise<DiskRead> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.filePath, 'utf8');
      this.stats.reads++;
    } catch (e) {
      if (errCode(e) === 'ENOENT') {
        const state = emptyState();
        return { state, text: stableStringify(state), ok: true };
      }
      logError('state: cannot read ' + this.filePath, e);
      return { state: emptyState(), text: '', ok: false };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (e) {
      logError('state: state.json is not valid JSON', e);
      await this.backupCorrupt(raw);
      const state = emptyState();
      return { state, text: stableStringify(state), ok: true };
    }
    if (!isPlainObject(parsed)) {
      logError('state: state.json is not an object', new Error(typeof parsed));
      await this.backupCorrupt(raw);
      const state = emptyState();
      return { state, text: stableStringify(state), ok: true };
    }

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
