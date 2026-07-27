// IMPLEMENTED BY: INTEGRATOR
// src/extension.ts — activate/deactivate and every cross-module wire.
//
// This file is the ONLY place the seven module groups meet: each of them talks
// exclusively through the dependency interfaces in types.ts, and this file is
// what implements them. The activation sequence is SPEC.md §4-I:
//
//   1. OutputChannel('Lineage') + setLogSink
//   2. StateStore(globalStorageUri.fsPath).load() + RelativePattern watcher
//   3. config read, LineageResolver, the fetch -> resolveAll -> buildForest
//      tick pipeline, forest cache, onForestChanged emitter
//   4. TerminalRegistry + bind/exit -> store.upsert
//   5. registerFocusIntegration (+ registry.reassociate() once windowId exists)
//   6. registerTree + registerDecorations
//   7. HooksManager + selfHeal + CONTEXT_HOOKS_INSTALLED
//   8. registerCommands
//   9. RosterPoller.start() (start() performs the immediate first fetch itself)
//  10. onDidChangeConfiguration re-read + hook watcher sync
//
// deactivate() does nothing but rely on subscription disposal — no config
// edits, no globalState writes (both explicitly unsupported there).

import * as vscode from 'vscode';

import {
  ARCHIVE_RESCAN_MIN_MS,
  CONFIG_KEYS,
  CONFIG_SECTION,
  CONTEXT_HOOKS_INSTALLED,
} from './types';
import type {
  ArchivedSession,
  CommandDeps,
  DecorationDeps,
  HookEvent,
  RosterEntry,
  RosterResult,
  SessionForest,
  TranscriptHeaderMeta,
  TreeDeps,
} from './types';
import { log, logError, setLogSink } from './log';
import {
  RosterPoller,
  fetchRoster,
  findClaudeBinary,
  sameRoster,
} from './roster';
import { hasTranscript, readTranscriptHeader } from './transcript';
import { LineageResolver, buildForest, resolveAll } from './lineage';
import { ArchiveIndexer, archivedAsEntries, archivedOnly } from './archive';
import { StateStore } from './state';
import { registerDecorations } from './decorations';
import { registerTree } from './tree';
import type { TreeController } from './tree';
import { TerminalRegistry } from './terminals';
import { registerCommands } from './commands';
import { registerFocusIntegration } from './windows';
import { openProject } from './surfaces';
import { HooksManager } from './hooks';

const DEFAULT_POLL_INTERVAL_MS = 3000;
const STATE_FILE_NAME = 'state.json';
/** A header read is a bounded SYNC read of the transcript head. Rebuilds fire
 *  on every roster status flip, so an empty result is re-checked at most this
 *  often and a non-empty one is kept for the window's lifetime. */
const HEADER_NEGATIVE_TTL_MS = 60_000;
/** Above this the header memo is pruned down to the ids still on the roster. */
const HEADER_CACHE_SOFT_MAX = 256;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  // ------------------------------------------------------------------ 1. log

  const channel = vscode.window.createOutputChannel('Lineage');
  context.subscriptions.push(channel);
  setLogSink((line) => channel.appendLine(line));
  context.subscriptions.push({ dispose: () => setLogSink(null) });
  log('activate: starting');

  // --------------------------------------------------------------- config

  const cfg = (): vscode.WorkspaceConfiguration =>
    vscode.workspace.getConfiguration(CONFIG_SECTION);

  const boolCfg = (key: string, dflt: boolean): boolean => {
    const v = cfg().get<boolean>(key);
    return typeof v === 'boolean' ? v : dflt;
  };
  const numCfg = (key: string, dflt: number): number => {
    const v = cfg().get<number>(key);
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : dflt;
  };
  // Re-read on every call so a settings change takes effect without rebuilding
  // the poller or the terminal registry.
  const claudeBin = (): string | null =>
    findClaudeBinary(cfg().get<string>(CONFIG_KEYS.claudeBinary));

  // ------------------------------------------------------- 2. editorial state

  const store = new StateStore(context.globalStorageUri.fsPath);
  context.subscriptions.push(store);
  await store.load();

  // Cross-window sync. A simple non-recursive pattern with a RelativePattern
  // base is what makes watching outside the workspace work. reloadFromDisk()
  // coalesces a burst itself and stays silent on a byte-identical re-read, so
  // the echo of our own write never causes a double refresh.
  try {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(context.globalStorageUri, STATE_FILE_NAME),
    );
    const reload = (): void => {
      void store.reloadFromDisk();
    };
    context.subscriptions.push(
      watcher,
      watcher.onDidChange(reload),
      watcher.onDidCreate(reload),
      watcher.onDidDelete(reload),
    );
  } catch (err) {
    logError('extension.stateWatcher', err);
  }

  // --------------------------------------------- 3. forest cache + pipeline

  const resolver = new LineageResolver();
  const onForestChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(onForestChanged);

  // Seeded BEFORE the tree is registered so getForest() is never called on an
  // undefined; commands rely on the same guarantee.
  let forest: SessionForest = buildForest({
    entries: [],
    resolutions: new Map(),
    records: {},
  });

  let lastEntries: RosterEntry[] = [];
  let haveRoster = false;
  /** An editorial change (label / hidden / recorded edge) arrived since the
   *  last build — those live only in `records`, so a byte-identical roster
   *  still has to be re-rendered. */
  let editorialDirty = false;
  let rebuildTail: Promise<void> = Promise.resolve();

  // Label-fallback headers only, memoised: readTranscriptHeader is a bounded
  // synchronous read and the tree rebuilds on every status flip.
  const headerCache = new Map<
    string,
    { meta: TranscriptHeaderMeta; at: number }
  >();
  const headerFor = (sessionId: string): TranscriptHeaderMeta => {
    const now = Date.now();
    const hit = headerCache.get(sessionId);
    if (
      hit &&
      (Object.keys(hit.meta).length > 0 ||
        now - hit.at < HEADER_NEGATIVE_TTL_MS)
    ) {
      return hit.meta;
    }
    const meta = readTranscriptHeader(sessionId);
    headerCache.set(sessionId, { meta, at: now });
    return meta;
  };

  // M1.5 archive. `claude agents --json` is live-only, so without this a closed
  // session leaves the tree entirely. Re-scanned at most every
  // ARCHIVE_RESCAN_MIN_MS on the rebuild path (the archive changes slowly and a
  // cold scan of 217 transcripts measured 0.20 s); an explicit refresh or a
  // config flip forces it.
  const archiveIndexer = new ArchiveIndexer();
  context.subscriptions.push(archiveIndexer);
  let lastArchiveScan = 0;
  let forceArchiveScan = true;

  const archiveFor = (liveIds: ReadonlySet<string>): ArchivedSession[] => {
    if (!boolCfg(CONFIG_KEYS.showArchived, false)) return [];
    const now = Date.now();
    if (
      forceArchiveScan ||
      !archiveIndexer.hasIndexed() ||
      now - lastArchiveScan >= ARCHIVE_RESCAN_MIN_MS
    ) {
      try {
        archiveIndexer.scan({ liveIds });
      } catch (err) {
        logError('extension.archiveScan', err);
      }
      lastArchiveScan = now;
      forceArchiveScan = false;
    }
    return archivedOnly(archiveIndexer.current(), liveIds);
  };

  const rebuild = async (entries: RosterEntry[]): Promise<void> => {
    // ONE records snapshot, handed to both calls — resolveAll must be awaited
    // before buildForest and both must observe the same object.
    const records = store.all();
    const liveIds = new Set(entries.map((e) => e.sessionId));
    const archived = archiveFor(liveIds);
    // Archived sessions go through resolveAll too: it resolves their forkedFrom
    // edges AND registers them as known ids, which stops a live child from
    // synthesizing a "(gone)" ghost for a parent we can now render for real.
    const resolutions = await resolveAll(
      archived.length > 0 ? [...entries, ...archivedAsEntries(archived)] : entries,
      resolver,
      records,
    );
    const headers = new Map<string, TranscriptHeaderMeta>();
    for (const e of entries) {
      if (!e.name) headers.set(e.sessionId, headerFor(e.sessionId));
    }
    if (headerCache.size > HEADER_CACHE_SOFT_MAX) {
      const live = new Set(entries.map((e) => e.sessionId));
      for (const id of [...headerCache.keys()]) {
        if (!live.has(id)) headerCache.delete(id);
      }
    }
    forest = buildForest({
      entries,
      resolutions,
      records,
      headers,
      archived,
      opts: {
        showGhosts: boolCfg(CONFIG_KEYS.showGhosts, true),
        sortWaitingFirst: boolCfg(CONFIG_KEYS.sortWaitingFirst, true),
      },
    });
    onForestChanged.fire();
  };

  /** Serialize rebuilds so two overlapping ticks cannot fire out of order.
   *  The tail never rejects, so one bad rebuild cannot wedge the chain. */
  const scheduleRebuild = (entries: RosterEntry[]): Promise<void> => {
    editorialDirty = false;
    const next = rebuildTail
      .then(() => rebuild(entries))
      .catch((err: unknown) => {
        logError('extension.rebuild', err);
      });
    rebuildTail = next;
    return next;
  };

  let poller: RosterPoller | null = null;
  let treeController: TreeController | null = null;

  const pokeNow = (): void => {
    try {
      poller?.pokeNow();
    } catch (err) {
      logError('extension.pokeNow', err);
    }
  };

  /** The explicit refresh path (lineage.refresh, and every verb that mutated
   *  editorial state). Pulls the next roster tick forward AND re-renders from
   *  the records we already have. */
  const refreshNow = (): void => {
    pokeNow();
    forceArchiveScan = true; // an explicit refresh must see new/closed sessions
    if (haveRoster) void scheduleRebuild(lastEntries);
    else treeController?.refresh();
  };

  // Editorial changes (this window's mutations and other windows' writes alike)
  // must rebuild without waiting for a roster change.
  context.subscriptions.push(
    store.onDidChange(() => {
      editorialDirty = true;
      if (haveRoster) void scheduleRebuild(lastEntries);
    }),
  );

  // ------------------------------------------------------------ 4. terminals

  const registry = new TerminalRegistry({ claudeBinary: () => claudeBin() });
  context.subscriptions.push(registry);

  context.subscriptions.push(
    registry.onDidExit((sessionId) => {
      void store.upsert(sessionId, { boundWindowId: null });
      pokeNow();
    }),
    registry.onDidChangeActive(() => {
      // Re-render so the tree can restyle the active row.
      onForestChanged.fire();
    }),
  );

  // ------------------------------------------------------- 5. window focus

  const focusIntegration = await registerFocusIntegration({
    publishWindow: (rec) => store.publishWindow(rec),
    onFocusRequest: (id) => {
      if (!id) return;
      // treeController is a `let` on purpose — this closure runs long after
      // activation, never at creation time.
      void treeController?.revealSession(id);
      registry.focus(id);
    },
  });
  context.subscriptions.push(focusIntegration);

  // onDidBind stamps focusIntegration.windowId, so it is subscribed only once
  // that value exists — no TDZ window, no binding written against `null`.
  context.subscriptions.push(
    registry.onDidBind((b) => {
      void store.upsert(b.sessionId, {
        boundWindowId: focusIntegration.windowId,
      });
    }),
  );

  // Window-RELOAD path: the ptys survive and creationOptions.env is rebuilt.
  // Idempotent, never throws. Its bind events land on a microtask, i.e. after
  // the subscription above.
  try {
    const revived = registry.reassociate();
    if (revived > 0) {
      log('activate: re-associated', String(revived), 'terminals');
    }
  } catch (err) {
    logError('extension.reassociate', err);
  }
  // Belt and braces for anything the registry bound while we were awaiting the
  // focus handle (its own onDidOpenTerminal listener). upsert is a no-op when
  // the content already matches.
  for (const b of registry.bindings()) {
    void store.upsert(b.sessionId, {
      boundWindowId: focusIntegration.windowId,
    });
  }

  // ------------------------------------------------- 6. tree + decorations

  const viewDeps: TreeDeps & DecorationDeps = {
    getForest: () => forest,
    onDidChangeData: (listener) => onForestChanged.event(listener),
    isBoundHere: (id) => registry.isBoundHere(id),
    reparent: async (childId, newParentId) => {
      await store.upsert(childId, {
        parentId: newParentId,
        parentSource: 'reparent',
      });
      // Required when a record is later cleared; a live recorded edge already
      // bypasses the resolution cache.
      resolver.invalidate(childId);
      if (haveRoster) await scheduleRebuild(lastEntries);
    },
    groupByFolder: () => boolCfg(CONFIG_KEYS.groupByFolder, true),
  };

  treeController = registerTree(viewDeps);
  context.subscriptions.push(treeController);
  context.subscriptions.push(registerDecorations(viewDeps));

  // ------------------------------------------------------------- 7. hooks

  const hooksManager = new HooksManager({
    getStored: () => store.getHookState(),
    setStored: (s) => store.setHookState(s),
  });
  context.subscriptions.push(hooksManager);

  let hookState = store.getHookState();
  try {
    hookState = await hooksManager.selfHeal();
  } catch (err) {
    logError('extension.hooks.selfHeal', err);
  }
  await setHooksContext(hookState.installed);

  const hookEventSink = (e: HookEvent): void => {
    if (e.sessionId) resolver.invalidate(e.sessionId);
    pokeNow();
  };
  /** startWatcher/stopWatcher are both idempotent; this is safe to call from
   *  activation, from a config change and after install/remove. */
  const syncHookWatcher = (): void => {
    try {
      if (
        boolCfg(CONFIG_KEYS.hooksEnabled, false) &&
        hooksManager.getState().installed
      ) {
        hooksManager.startWatcher(hookEventSink);
      } else {
        hooksManager.stopWatcher();
      }
    } catch (err) {
      logError('extension.hooks.watcher', err);
    }
  };

  // ---------------------------------------------------------- 8. commands

  const commandDeps: CommandDeps = {
    getForest: () => forest,
    refresh: refreshNow,
    hasTranscript: (sessionId) => hasTranscript(sessionId),

    getRecord: (id) => store.get(id),
    allRecords: () => store.all(),
    upsertRecord: (id, patch) => store.upsert(id, patch),
    recordLaunch: (childId, parentId, cwd) =>
      store.recordLaunch(childId, parentId, cwd),

    launchSession: (opts) => registry.launch(opts),
    focusSession: (sessionId) => registry.focus(sessionId),
    renameTerminal: (sessionId, name) => registry.rename(sessionId, name),
    sendTextToSession: (sessionId, text) => registry.sendText(sessionId, text),
    closeTerminal: (sessionId) => registry.closeTerminal(sessionId),

    focusWindowFor: async (sessionId) => {
      const windowId = store.get(sessionId)?.boundWindowId;
      if (!windowId) return false;
      // getWindows() already drops dead pids and records older than 7 days.
      const rec = store.getWindows().find((w) => w.windowId === windowId);
      if (!rec) return false;
      return focusIntegration.focusWindow(rec, sessionId);
    },

    openProject: (fsPath, newWindow) => openProject(fsPath, newWindow),

    installHooks: async () => {
      const state = await hooksManager.install();
      syncHookWatcher();
      return state;
    },
    removeHooks: async () => {
      const state = await hooksManager.remove();
      syncHookWatcher();
      return state;
    },
    getHookState: () => hooksManager.getState(),
  };

  context.subscriptions.push(registerCommands(commandDeps));

  // ------------------------------------------------------------ 9. poller

  /** App-RESTART re-association: a revived terminal has no LINEAGE_NODE_ID in
   *  creationOptions any more, but its `claude` process still matches a roster
   *  pid. Revived terminals arrive within the first seconds, so this is capped
   *  rather than run forever — it awaits a processId per terminal. */
  let rosterReassociated = false;
  let rosterReassociateAttempts = 0;
  const ROSTER_REASSOCIATE_MAX_ATTEMPTS = 10;

  const onResult = (r: RosterResult): void => {
    if (!r.ok) {
      // Keep the last good forest — the tree must not flash empty because the
      // CLI was briefly unavailable.
      log('roster: fetch failed —', r.error ?? 'unknown error');
      return;
    }

    const changed =
      !haveRoster || editorialDirty || !sameRoster(lastEntries, r.entries);
    lastEntries = r.entries;
    haveRoster = true;

    if (
      !rosterReassociated &&
      rosterReassociateAttempts < ROSTER_REASSOCIATE_MAX_ATTEMPTS
    ) {
      rosterReassociateAttempts++;
      void registry
        .reassociateFromRoster(r.entries)
        .then((n) => {
          if (n > 0) {
            rosterReassociated = true;
            log('roster: re-associated', String(n), 'terminals by pid');
          }
        })
        .catch((err: unknown) => {
          logError('extension.reassociateFromRoster', err);
        });
    }

    try {
      hooksManager.noteRosterActivity(r.entries.length);
    } catch (err) {
      logError('extension.noteRosterActivity', err);
    }

    if (!changed) return;
    void scheduleRebuild(r.entries);
  };

  poller = new RosterPoller(
    () => fetchRoster({ claudeBin: claudeBin() ?? 'claude' }),
    onResult,
    numCfg(CONFIG_KEYS.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS),
  );
  context.subscriptions.push(poller);
  // start() already performs the immediate first fetch — a separate first tick
  // would only be coalesced away.
  poller.start();

  // The watcher callback closes over the poller, so it starts last.
  syncHookWatcher();

  // ---------------------------------------------------- 10. config changes

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(CONFIG_SECTION)) return;
      poller?.setIntervalMs(numCfg(CONFIG_KEYS.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS));
      syncHookWatcher();
      // Flipping showArchived on must populate the index immediately rather
      // than at the next 30 s window, or the setting looks broken.
      if (e.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_KEYS.showArchived}`)) {
        forceArchiveScan = true;
      }
      // showGhosts / sortWaitingFirst are read per buildForest and
      // groupByFolder per getChildren — a rebuild covers all three.
      if (haveRoster) void scheduleRebuild(lastEntries);
      else treeController?.refresh();
    }),
  );

  log('activate: ready');
}

export function deactivate(): void {
  // Intentionally empty. Disposal happens through context.subscriptions;
  // configuration edits and globalState writes are unsupported here.
}

async function setHooksContext(installed: boolean): Promise<void> {
  try {
    await vscode.commands.executeCommand(
      'setContext',
      CONTEXT_HOOKS_INSTALLED,
      installed,
    );
  } catch (err) {
    logError('extension.setHooksContext', err);
  }
}
