// src/extension.ts — the extension entry point: activation order, provider
// wiring and disposal.
//
// This file is the ONLY place the module groups meet: each of them talks
// exclusively through the dependency interfaces in types.ts, and this file is
// what implements them. The activation sequence is:
//
//   1. OutputChannel('Flock') + setLogSink
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

import * as path from 'node:path';
import * as os from 'node:os';

import {
  ARCHIVE_RESCAN_MIN_MS,
  COMMANDS,
  CONFIG_KEYS,
  CONFIG_SECTION,
  CONTEXT_HAS_UNSEEN,
  CONTEXT_EXPLORER_FOLLOW,
  CONTEXT_HOOKS_INSTALLED,
  CONTEXT_NATIVE_TREE,
  CONTEXT_MULTI_SELECT,
  CONTEXT_ONLY_ACTIVE,
  DEFAULT_BUSY_STALE_MINUTES,
  DEFAULT_PROVIDER,
  DEFAULT_STALE_AFTER_HOURS,
  isProviderId,
  isSessionId,
  isTerminalLocationPref,
  shortId,
} from './types';
import type {
  ArchivedSession,
  BackgroundJob,
  DecorationDeps,
  EditorialRecord,
  HookEvent,
  ProjectRecord,
  ProviderId,
  RosterEntry,
  RosterResult,
  SessionForest,
  TerminalLocationPref,
  TmuxSpawn,
  TranscriptFacts,
  TranscriptHeaderMeta,
  TreeDeps,
} from './types';
import {
  type TmuxAdvice,
  ensureTmuxConf,
  findTmuxBinary,
  killTmuxSession,
  queryClientSessions,
  queryPanePid,
  resolveTmuxSpawn,
  tmuxAdvice,
  tmuxInstallHint,
} from './tmux';
import {
  matchProject,
  pathKey,
  projectDirs,
  providerOfProject,
  validateProjectName,
} from './projects';
import { log, logError, setLogSink } from './log';
import {
  RosterFilter,
  RosterPoller,
  fetchRosterMulti,
  findClaudeBinary,
  normalizeStatus,
  sameRoster,
} from './roster';
import {
  forkParentFromTranscript,
  hasTranscript,
  readTranscriptHeader,
  transcriptMtimeMs,
} from './transcript';
import { repairResumeLeaf } from './resumeLeaf';
import { LineageResolver, buildForest, resolveAll } from './lineage';
import type { ResolveOptions } from './lineage';
import {
  ArchiveIndexer,
  archivedAsEntries,
  keptArchived,
  memberKeepIds,
} from './archive';
import {
  buildChainIndex,
  collapseChains,
  emptyChainIndex,
} from './generations';
import type { ChainIndex } from './generations';
import {
  DaemonRosterReader,
  daemonRosterPathFor,
  defaultDaemonRosterPath,
  describeForkEdge,
} from './daemon';
import { WorktreeCache } from './git';
import { BranchStatusCache } from './gitBranches';
import {
  DEFAULT_WORKTREE_PATH_PATTERN,
  readLocalBranches,
  runWorktreeAdd,
  runWorktreeRemove,
} from './worktrees';
import type { GenerationFacts } from './generations';
import { TranscriptStatsCache, readFirstPrompt } from './usage';
import type { TranscriptStats } from './usage';
import { WorkspaceManager } from './workspaces';
import {
  ANCHOR_DIR_NAME,
  ExplorerSync,
  WORKSPACE_FILE_NAME,
  anchorLabelFor,
  desiredFolders,
  withAnchorName,
  workspaceFileJson,
} from './explorer';
import { registerProjectView } from './projectview';
import type { ProjectViewController } from './projectview';
// Accounts. The pure halves (accounts.ts / routing.ts) are imported here
// because this file is where the account roster, the pins and the launch env
// are joined up — the views and the verbs only ever see the interfaces.
import {
  envForProfile,
  profileConfigDirFor,
  seedDefaultProfiles,
} from './accounts';
import { pinnedLaunchProfile } from './routing';
import { ensureProfileConfig } from './profileConfig';
import type { ProfileConfigSources } from './profileConfig';
import { AccountUsageCache, registerAccountsView } from './accountsView';
import type { AccountDeps, AccountsViewController } from './accountsView';
import { LimitsService, formatUsageSummary } from './limits';
import { StateStore } from './state';
import { registerDecorations } from './decorations';
import { registerTree } from './tree';
import type { TreeController } from './tree';
import { registerWebtree } from './webtree';
import type { WebtreeController } from './webtree';
import { TerminalRegistry } from './terminals';
import {
  adoptBackgroundJob,
  notificationItems,
  registerCommands,
  tabTitleFrom,
} from './commands';
import type { AccountCommandDeps } from './commands';
import { registerFocusIntegration } from './windows';
import { openProject } from './surfaces';
import { HooksManager } from './hooks';

const DEFAULT_POLL_INTERVAL_MS = 3000;
const STATE_FILE_NAME = 'state.json';
/** workspaceState key holding this window's active project workspace. */
const ACTIVE_WORKSPACE_KEY = 'lineage.activeWorkspace';
/** workspaceState key counting extension-host activations in this window — the
 *  restart probe. See the log line in `activate`. */
const ACTIVATION_COUNT_KEY = 'lineage.activationCount';

/** globalState, not the editorial store: this is a per-install "already asked",
 *  it needs no change event and no cross-window merge. Same reasoning as the
 *  activation counter above. */
const TMUX_NOTICE_KEY = 'lineage.tmuxNoticeShown';
/** Long enough that the tree has drawn and the user is looking at their
 *  sessions rather than at an empty sidebar with a toast over it. */
const TMUX_NOTICE_DELAY_MS = 12_000;
const TMUX_INSTALL_URL = 'https://github.com/tmux/tmux/wiki/Installing';
/** One turn end can be reported twice (Stop hook + the poll transition); a
 *  second doneAt stamp inside this window is the same turn, not a new one. */
const DONE_DEDUPE_MS = 15_000;
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

  const channel = vscode.window.createOutputChannel('Flock');
  context.subscriptions.push(channel);
  setLogSink((line) => channel.appendLine(line));
  context.subscriptions.push({ dispose: () => setLogSink(null) });
  // The activation COUNT, not just the fact of one. The Explorer sync splices
  // workspace folders in place on the strength of the API's promise that only
  // index 0 restarts the extension host, and a restart is otherwise almost
  // invisible — terminals survive it (the pty host outlives us, which is what
  // `registry.reassociate()` exists to pick up), so the only symptom is Flock
  // quietly rebuilding. If this number climbs when you switch projects, a
  // splice restarted the host and the anchor invariant has a hole in it.
  const activations =
    (context.workspaceState.get<number>(ACTIVATION_COUNT_KEY) ?? 0) + 1;
  void context.workspaceState.update(ACTIVATION_COUNT_KEY, activations);
  log(`activate: starting (host activation #${activations} for this window)`);

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

  const terminalLocation = (): TerminalLocationPref => {
    const v = cfg().get<string>(CONFIG_KEYS.terminalLocation);
    return isTerminalLocationPref(v) ? v : 'editor';
  };

  // Detach tier (src/tmux.ts): wrap Flock-launched sessions in the private
  // tmux server so a workspace switch can hide a session's tab while the
  // conversation keeps running. The conf is written once per activation; the
  // binary and the `lineage.tmux` gate are re-probed per launch, so
  // installing tmux (or flipping the setting) needs no reload. Null — off,
  // no tmux, Windows — means the kill+resume tier, which stays fully wired.
  const tmuxConfPath = ensureTmuxConf(context.globalStorageUri.fsPath);
  const tmuxSpawn = (): TmuxSpawn | null =>
    resolveTmuxSpawn(cfg().get<string>(CONFIG_KEYS.tmux), tmuxConfPath);

  // One-time nudge about the detach tier. Deferred off the activation path: it
  // is advice, and nothing about startup should wait on a toast. The decision
  // itself is `tmuxAdvice` in src/tmux.ts, which is pure and tested; this only
  // supplies the world and acts on the answer.
  const tmuxNoticeShown = (): boolean =>
    context.globalState.get<boolean>(TMUX_NOTICE_KEY) === true;
  const suppressTmuxNotice = (): void => {
    void context.globalState.update(TMUX_NOTICE_KEY, true);
  };
  setTimeout(() => {
    let advice: TmuxAdvice;
    try {
      advice = tmuxAdvice({
        platform: process.platform,
        mode: cfg().get<string>(CONFIG_KEYS.tmux),
        binary: findTmuxBinary(),
        workspacesEnabled: boolCfg(CONFIG_KEYS.workspacesEnabled, true),
        dismissed: tmuxNoticeShown(),
      });
    } catch (err) {
      logError('tmux.notice', err);
      return;
    }
    if (advice === 'none') return;

    const NEVER = "Don't remind me";
    if (advice === 'enable') {
      const TURN_ON = 'Turn it on';
      void vscode.window
        .showWarningMessage(
          'Flock needs tmux to keep sessions running while you work elsewhere. ' +
            'You have tmux, but it is switched off, so switching projects ' +
            'closes the other project’s sessions instead of hiding them.',
          TURN_ON,
          NEVER,
        )
        .then((choice) => {
          if (choice === TURN_ON) {
            void cfg().update(CONFIG_KEYS.tmux, 'auto', vscode.ConfigurationTarget.Global);
            suppressTmuxNotice();
          } else if (choice === NEVER) {
            suppressTmuxNotice();
          }
        });
      return;
    }

    const hint = tmuxInstallHint(process.platform);
    const HOW = 'How to install';
    void vscode.window
      .showWarningMessage(
        'Flock needs tmux. Without it, switching projects closes the other ' +
          'project’s sessions instead of hiding them, and anything a session ' +
          'was in the middle of is lost.' +
          (hint === undefined ? '' : ` Run: ${hint}`),
        HOW,
        NEVER,
      )
      .then((choice) => {
        if (choice === HOW) {
          void vscode.env.openExternal(vscode.Uri.parse(TMUX_INSTALL_URL));
          suppressTmuxNotice();
        } else if (choice === NEVER) {
          suppressTmuxNotice();
        }
      });
  }, TMUX_NOTICE_DELAY_MS);

  /** Absolute path to a file inside the extension install. `extensionUri` is
   *  a Uri because a remote/web host may serve the extension over a non-file
   *  scheme; the tree only ever passes this to Uri.file, so a non-file scheme
   *  must degrade to the codicon fallback rather than a broken icon. */
  const mediaPath = (relative: string): string | undefined => {
    try {
      const root = context.extensionUri;
      if (!root || root.scheme !== 'file') return undefined;
      return path.join(root.fsPath, ...relative.split('/'));
    } catch (err) {
      logError('extension.mediaPath', err);
      return undefined;
    }
  };

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

  // VIEW SUSPENSION. A workspace switch closes a batch of tabs,
  // disposes a terminal per parked session and writes a record for each one —
  // and every one of those fires a state change that would rebuild the forest
  // and repaint the sidebar. Repainting a dozen intermediate trees is the flicker
  // a switch is accused of, and it also throws away the user's scroll position
  // and row focus. So the switch suspends the views for its duration, and the
  // resume repaints exactly once from the settled state.
  let viewsSuspended = false;
  let forestChangePending = false;
  /** Announce a new forest — unless a switch is mid-flight, in which case the
   *  announcement is coalesced into the one `resumeViews` makes. */
  const fireForestChanged = (): void => {
    if (viewsSuspended) {
      forestChangePending = true;
      return;
    }
    onForestChanged.fire();
  };
  const suspendViews = (): void => {
    viewsSuspended = true;
    forestChangePending = false;
  };
  const resumeViews = (): void => {
    if (!viewsSuspended) return;
    viewsSuspended = false;
    if (forestChangePending) {
      forestChangePending = false;
      onForestChanged.fire();
    }
    refreshViews();
  };

  // Seeded BEFORE the tree is registered so getForest() is never called on an
  // undefined; commands rely on the same guarantee.
  let forest: SessionForest = buildForest({
    entries: [],
    resolutions: new Map(),
    records: {},
  });

  // The generation-chain index for the CURRENT forest: which session ids
  // are worn by one logical conversation, and which member is its tip. Rebuilt
  // every tick alongside the forest; seeded empty for the same reason.
  let chainIndex: ChainIndex = emptyChainIndex();

  /** Chained ids in clicked-id-first order, for the terminal fallbacks further
   *  down: a conversation's terminal is bound under whichever generation's id
   *  it was LAUNCHED with, which after a re-key is not the id the row now
   *  carries. Declared up here beside the index it reads because the tab-name
   *  reconciler needs it before activate() reaches its first `await` — see
   *  onDidBind below. */
  const chainAliases = (sessionId: string): string[] => [
    sessionId,
    ...chainIndex.membersOf(sessionId).filter((m) => m !== sessionId),
  ];

  let lastEntries: RosterEntry[] = [];
  let haveRoster = false;
  /** An editorial change (label / hidden / recorded edge) arrived since the
   *  last build — those live only in `records`, so a byte-identical roster
   *  still has to be re-rendered. */
  let editorialDirty = false;
  let rebuildTail: Promise<void> = Promise.resolve();

  // ------------------------------------------------------ pending launches
  //
  // A session we just started exists in three places over the next few
  // seconds, and for a moment it is in none of them: the roster
  // (`claude agents --json`, polled every 3 s), the archive index (its
  // transcript, which claude writes lazily and only once there is something to
  // write) and the editorial store (immediately — but a record alone builds no
  // node). So between "launched" and "the poller noticed" a brand-new session
  // had NO ROW, which is precisely the window in which it is created, revealed
  // and named. The inline rename lands on a row that does not exist yet, refuses
  // itself, and the create verb falls back to the quick-input box — a popup, on
  // the one path that is supposed to name the thing on its own row.
  //
  // The fix is an optimistic entry: the launch is a fact this window knows
  // first-hand, so it is fed into the forest as a roster row of its own until
  // one of the two real sources catches up.

  /** How long an unconfirmed launch keeps its row. Long enough to cover a slow
   *  claude start plus a poll interval or two; short enough that a launch which
   *  never came up (a bad binary, an instant crash) does not leave a row that
   *  answers to nothing. Its record survives either way — this only governs the
   *  optimistic ROW. */
  const PENDING_LAUNCH_TTL_MS = 90_000;
  const pendingLaunches = new Map<string, { entry: RosterEntry; at: number }>();

  const notePendingLaunch = (sessionId: string, cwd?: string): void => {
    if (!isSessionId(sessionId)) return;
    const at = Date.now();
    // `idle` rather than `busy`: the session is starting, not working, and
    // `busy` would light an amber dot that nothing ever puts out if the launch
    // fails. `startedAt` is now, which is also what the age column shows until
    // the first prompt lands.
    const entry: RosterEntry = {
      sessionId,
      startedAt: at,
      status: 'idle',
      kind: 'interactive',
    };
    if (cwd !== undefined && cwd !== '') entry.cwd = cwd;
    pendingLaunches.set(sessionId, { entry, at });
  };

  /** The optimistic rows still worth showing, and the pruning that keeps the
   *  map from being a leak. A launch is forgotten as soon as the roster reports
   *  it (the real row is strictly better — it has a pid and a live status) or
   *  once it has had its window to appear. */
  const takePendingEntries = (rosterIds: ReadonlySet<string>): RosterEntry[] => {
    if (pendingLaunches.size === 0) return [];
    const now = Date.now();
    const out: RosterEntry[] = [];
    for (const [id, held] of [...pendingLaunches]) {
      if (rosterIds.has(id) || now - held.at > PENDING_LAUNCH_TTL_MS) {
        pendingLaunches.delete(id);
        continue;
      }
      out.push(held.entry);
    }
    return out;
  };

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

  // The archive. `claude agents --json` is live-only, so without this a closed
  // session leaves the tree entirely. Re-scanned at most every
  // ARCHIVE_RESCAN_MIN_MS on the rebuild path (the archive changes slowly and a
  // cold scan of 217 transcripts measured 0.20 s); an explicit refresh or a
  // config flip forces it.
  const archiveIndexer = new ArchiveIndexer();
  context.subscriptions.push(archiveIndexer);
  let lastArchiveScan = 0;
  let forceArchiveScan = true;
  let prevLiveIds: ReadonlySet<string> = new Set<string>();

  /**
   * The config dirs and projects roots of every account profile that has its
   * own directory. Computed fresh at each use — the account roster changes at
   * runtime and a stale list is exactly a disappearing session.
   * Only claude-provider profiles: they are the only ones whose sessions and
   * transcripts this extension launches and indexes.
   */
  const claudeProfileConfigDirs = (): string[] => {
    try {
      const out: string[] = [];
      for (const profile of store.getAccounts()) {
        if (profile.provider !== 'claude') continue;
        const dir =
          typeof profile.configDir === 'string' ? profile.configDir.trim() : '';
        if (dir !== '') out.push(dir);
      }
      return out;
    } catch (err) {
      logError('extension.claudeProfileConfigDirs', err);
      return [];
    }
  };
  const profileProjectsDirs = (): string[] =>
    claudeProfileConfigDirs().map((dir) => path.join(dir, 'projects'));

  /**
   * Throttled scan of ~/.claude/projects. Runs on schedule even when every
   * archived ROW is currently gated off: chain detection reads the
   * index — a live session that continues an older transcript is only
   * recognisable because the older head was scanned. Cached by (mtime, size);
   * the steady-state cost is one readdir per project dir plus one stat per
   * transcript.
   */
  const ensureArchiveScan = (liveIds: ReadonlySet<string>): void => {
    const now = Date.now();
    if (
      forceArchiveScan ||
      !archiveIndexer.hasIndexed() ||
      now - lastArchiveScan >= ARCHIVE_RESCAN_MIN_MS
    ) {
      try {
        archiveIndexer.scan({ liveIds, extraProjectsDirs: profileProjectsDirs() });
      } catch (err) {
        logError('extension.archiveScan', err);
      }
      lastArchiveScan = now;
      forceArchiveScan = false;
    }
  };

  /**
   * Tree membership is editorial: any session with a non-deleted record
   * keeps its row when its terminal closes — it flips to an INACTIVE
   * (archived, resumable) row instead of leaving the tree, and only an
   * explicit Delete removes it. `showArchived` widens the gate to sessions
   * with no record at all: foreign history found on disk.
   *
   * Called AFTER the chain index is rebuilt, so a record written against a
   * superseded generation id routes to its conversation's tip — the one row
   * the collapse will actually keep.
   */
  const archiveFor = (
    liveIds: ReadonlySet<string>,
    records: Record<string, EditorialRecord>,
  ): ArchivedSession[] => {
    const showArchived = boolCfg(CONFIG_KEYS.showArchived, false);
    const keepIds = showArchived
      ? new Set<string>()
      : memberKeepIds(records, (id) => chainIndex.tipOf(id));
    if (!showArchived && keepIds.size === 0) return [];
    return keptArchived(archiveIndexer.current(), liveIds, {
      showArchived,
      keepIds,
    });
  };

  // What the transcript TAIL says about a session: when the user last
  // prompted it (the age column's real meaning) and how many tokens the last
  // turn ran with. Cached on the (mtime, size) the archive indexer already
  // stat'ed, so a transcript nobody has written to is never re-read.
  const statsCache = new TranscriptStatsCache();
  context.subscriptions.push(statsCache);

  /**
   * Tail stats for the sessions the tree is about to render.
   *
   * Scoped to the user's OWN sessions — live rows plus rows that exist because
   * of an editorial record — rather than every transcript on disk. With
   * `lineage.showArchived` on, this machine carries 800+ foreign transcripts,
   * and reading a 96 kB tail off each of them on the first rebuild would block
   * the extension host for about a second to answer a question nobody asked
   * about somebody else's session. A row left out simply falls back to the
   * transcript mtime, which is exactly what every row showed in older builds.
   *
   * Paths and stat values come from the archive index rather than a fresh
   * `statSync` per session: that sweep has already run, and a second
   * filesystem pass per rebuild would buy nothing but latency.
   */
  const tailStatsFor = (
    liveIds: ReadonlySet<string>,
    records: Record<string, EditorialRecord>,
  ): Map<string, TranscriptStats> => {
    const out = new Map<string, TranscriptStats>();
    const wanted = new Set<string>(liveIds);
    for (const record of Object.values(records)) {
      if (record.deleted === true) continue;
      wanted.add(record.id);
      wanted.add(chainIndex.tipOf(record.id));
    }
    for (const s of archiveIndexer.current()) {
      if (!wanted.has(s.sessionId)) continue;
      out.set(
        s.sessionId,
        statsCache.get(s.sessionId, s.transcriptPath, s.endedAt, s.bytes),
      );
    }
    statsCache.prune(wanted);
    return out;
  };

  /**
   * CommandDeps.transcriptFacts — what the chat-history picker labels and
   * orders its rows with.
   *
   * Both halves come off work already done. `lastActiveAt` is the archive
   * index's own mtime for the transcript, so no `statSync` is added to
   * anything. The first prompt is read on demand — this runs when a human
   * opens a picker, not on the render path — and cached FOREVER once found,
   * because a transcript is append-only and its opening line is the one thing
   * in it that can never change. A miss is not cached: an empty chat gets a
   * prompt the moment somebody types one.
   *
   * The id→entry map is rebuilt only when the indexer hands back a different
   * array, which is once per scan rather than once per row.
   */
  const firstPromptCache = new Map<string, string>();
  let factsIndex: {
    from: readonly ArchivedSession[];
    byId: Map<string, ArchivedSession>;
  } | null = null;
  const transcriptFacts = (sessionId: string): TranscriptFacts => {
    const all = archiveIndexer.current();
    if (factsIndex === null || factsIndex.from !== all) {
      factsIndex = {
        from: all,
        byId: new Map(all.map((s) => [s.sessionId, s] as const)),
      };
    }
    const entry = factsIndex.byId.get(sessionId);
    if (!entry) return {};
    const facts: TranscriptFacts = { lastActiveAt: entry.endedAt };
    const cached = firstPromptCache.get(sessionId);
    if (cached !== undefined) {
      facts.firstPrompt = cached;
      return facts;
    }
    let prompt: string | undefined;
    try {
      prompt = readFirstPrompt(entry.transcriptPath);
    } catch (err) {
      // readFirstPrompt swallows its own io errors; this is the belt to that
      // brace, because a picker must never fail to open over a bad file.
      logError('extension.transcriptFacts', err);
    }
    if (prompt !== undefined) {
      firstPromptCache.set(sessionId, prompt);
      facts.firstPrompt = prompt;
    }
    return facts;
  };

  // The CLI daemon's dispatch roster: fork edges for native /fork children
  // (whose transcripts carry no marker at all), resume continuations for
  // daemon-dispatched re-keys. Cached by stat inside the reader.
  //
  // There is not ONE roster. The daemon writes its roster inside
  // `CLAUDE_CONFIG_DIR`, and every account has its own — so a /fork on a
  // non-default account dispatched into a file this reader never opened, and
  // rendered as a flat root. The machine default plus every account config dir
  // are all read and merged. Re-evaluated per tick: accounts come and go.
  const daemonRosterPaths = (): string[] => {
    const paths = [defaultDaemonRosterPath()];
    for (const profile of store.getAccounts()) {
      const dir =
        typeof profile.configDir === 'string' ? profile.configDir.trim() : '';
      if (dir !== '') paths.push(daemonRosterPathFor(dir));
    }
    return paths;
  };
  const daemonReader = new DaemonRosterReader(daemonRosterPaths);

  /**
   * Persist newly observed daemon fork edges. The roster is ephemeral —
   * the daemon rewrites it — so each edge is written into the editorial store
   * as `parentSource: 'daemon'` the first time it is seen. A record that
   * already carries an exact edge (`minted`, a user `reparent`, an earlier
   * `daemon` write) is never touched: the user's drag must beat the log.
   */
  const persistDaemonForkEdges = (
    forkParents: ReadonlyMap<string, string>,
    records: Record<string, EditorialRecord>,
  ): void => {
    for (const [childId, parentId] of forkParents) {
      if (!isSessionId(childId) || !isSessionId(parentId)) continue;
      if (childId === parentId) continue;
      const record = records[childId];
      if (record?.parentSource !== undefined) continue; // exact edge already
      log('daemon:', describeForkEdge(childId, parentId));
      void store.upsert(childId, { parentId, parentSource: 'daemon' });
      resolver.invalidate(childId);
    }
  };

  /**
   * Assigned once `commandDeps` exists (it is built far below, and the
   * adopt flow needs all of it). Until then every tick simply skips the pass —
   * a fork job that arrives during activation is picked up on the next tick,
   * or by the click path, and neither loses anything.
   */
  let adoptForkJobs:
    | ((jobs: ReadonlyMap<string, BackgroundJob>) => void)
    | undefined;

  const rebuild = async (rosterEntries: RosterEntry[]): Promise<void> => {
    // ONE records snapshot, handed to both calls — resolveAll must be awaited
    // before buildForest and both must observe the same object.
    const records = store.all();
    // Sessions this window launched that the roster has not caught up
    // with, folded in as ordinary entries so everything downstream — chain
    // collapse, resolution, grouping, the views — treats them as the live
    // sessions they are. Merged HERE rather than in the poller so the raw
    // fetch, its change detection and `lastEntries` all stay exactly what the
    // CLI said.
    const rosterIds = new Set(rosterEntries.map((e) => e.sessionId));
    const pending = takePendingEntries(rosterIds);
    const entries =
      pending.length > 0 ? [...rosterEntries, ...pending] : rosterEntries;
    const liveIds = new Set(entries.map((e) => e.sessionId));

    // A session leaving the roster is the exact moment its row must flip
    // live → inactive. Force the scan so a transcript too young for the
    // throttle to have indexed is picked up NOW, not a rescan interval later
    // — a row that vanishes for 30 s reads as data loss.
    for (const id of prevLiveIds) {
      if (!liveIds.has(id)) {
        forceArchiveScan = true;
        break;
      }
    }
    prevLiveIds = liveIds;
    ensureArchiveScan(liveIds);

    // Daemon facts: fork edges are persisted (they land via the records
    // snapshot on the NEXT rebuild, which the upsert itself triggers), resume
    // continuations feed the chain index below alongside the transcript
    // signal.
    const daemonFacts = daemonReader.read();
    persistDaemonForkEdges(daemonFacts.forkParents, records);
    adoptForkJobs?.(daemonFacts.jobs);
    const daemonChainFacts: GenerationFacts[] = [];
    for (const [childId, parentId] of daemonFacts.resumeContinuations) {
      daemonChainFacts.push({ sessionId: childId, continuesId: parentId });
    }

    // Generation chains. Facts come from the archive index (which covers
    // EVERY transcript, live included — chainFacts, not current()), re-keys
    // from the persisted chains. The collapse then drops superseded
    // generations from every input and surfaces each chain's editorial
    // history on its tip, so the forest below never sees more than one row
    // per logical conversation.
    chainIndex = buildChainIndex({
      facts: [...archiveIndexer.chainFacts(), ...daemonChainFacts],
      recorded: store.getChains(),
      liveIds,
    });
    // Membership reads chainIndex.tipOf, so it must run on the FRESH index.
    const archivedRows = archiveFor(liveIds, records);
    const collapsed = collapseChains({
      entries,
      archived: archivedRows,
      records,
      chains: chainIndex,
    });
    const archived = collapsed.archived;

    // A project chat has no row anywhere in the tree. The filter sits
    // HERE, after the collapse, so it reads the chain-collapsed records — a
    // chat that was `--resume`d onto a fresh generation inherits `chat` on its
    // tip (generations.INHERITED_RECORD_KEYS) and is still filtered out.
    // `liveIds`/`prevLiveIds` above deliberately keep the RAW entries: the
    // chain index and the archive scan must still see the chat's transcript,
    // or its re-keys would never be learned and the row it must not have
    // would be exactly what comes back.
    const isChat = (id: string): boolean => collapsed.records[id]?.chat === true;
    const entries2 = collapsed.entries.filter((e) => !isChat(e.sessionId));
    const archived2 = archived.filter((a) => !isChat(a.sessionId));

    // Archived sessions go through resolveAll too: it resolves their forkedFrom
    // edges AND registers them as known ids, which stops a live child from
    // synthesizing a "(gone)" ghost for a parent we can now render for real.
    // Archived transcripts are finished files whose path we already know.
    // Telling the resolver both turns a per-tick, per-session 512 KB
    // synchronous head read (plus a readdir over every project dir) into a
    // once-per-window one — the previous behaviour re-swept the whole archive
    // every time the 60 s negative-resolution TTL lapsed, blocking the
    // extension-host thread for ~200 ms each time.
    const extras = new Map<string, ResolveOptions>();
    for (const a of archived2) {
      extras.set(a.sessionId, {
        transcriptPath: a.transcriptPath,
        immutable: true,
      });
    }
    const resolutions = await resolveAll(
      archived2.length > 0
        ? [...entries2, ...archivedAsEntries(archived2)]
        : entries2,
      resolver,
      collapsed.records,
      extras,
      // Any parent edge landing on a superseded generation re-points at the
      // conversation's tip — applied inside resolveAll so its ghost walk never
      // synthesizes a "(gone)" row for an id the collapse just removed.
      (parentId) => chainIndex.tipOf(parentId),
    );
    const headers = new Map<string, TranscriptHeaderMeta>();
    for (const e of entries2) {
      if (!e.name) headers.set(e.sessionId, headerFor(e.sessionId));
    }
    if (headerCache.size > HEADER_CACHE_SOFT_MAX) {
      const live = new Set(entries2.map((e) => e.sessionId));
      for (const id of [...headerCache.keys()]) {
        if (!live.has(id)) headerCache.delete(id);
      }
    }
    // Last-activity timestamps for the age column. This reads the archive
    // indexer's own transcript-mtime sweep (throttled to ensureArchiveScan's
    // cadence, ≤30 s) rather than adding a per-session fs.statSync to the 3 s
    // roster poll. Keys are session ids as the archive sees them — i.e.
    // chain-tip-collapsed — so this must be built AFTER collapseChains has
    // already run (it has, above) or a superseded generation's stale key
    // would never match a live entry's collapsed id.
    const activityMtimes = archiveIndexer.transcriptMtimes();
    // Same keying and the same "must run after collapseChains" rule as
    // activityMtimes above, and for the same reason: a superseded generation's
    // id would never match a live entry's collapsed one.
    const tailStats = tailStatsFor(liveIds, collapsed.records);
    forest = buildForest({
      entries: entries2,
      resolutions,
      records: collapsed.records,
      headers,
      archived: archived2,
      activityMtimes,
      tailStats,
      opts: {
        showGhosts: boolCfg(CONFIG_KEYS.showGhosts, true),
        notificationsDefault: boolCfg(CONFIG_KEYS.notificationsEnabled, true),
        onlyActive: boolCfg(CONFIG_KEYS.onlyActiveSessions, false),
      },
    });
    unseenProjectsCache = null;
    fireForestChanged();
    detectTurnTransitions();
    void syncUnseenContext();
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
  let webtreeController: WebtreeController | null = null;
  /** The project header inside the Explorer container. */
  let projectViewController: ProjectViewController | null = null;
  /** Repaints that header and re-evaluates its `when` key. Replaced once the
   *  view is registered; a no-op until then, because the active-workspace path
   *  that calls it runs earlier in activation than the view does. */
  let refreshExplorerHeader: () => void = () => {};

  /** Which sidebar is shown. `inline` is the webview one, whose rows can be
   *  renamed in place; `native` is the built-in tree widget, kept as a fallback
   *  because it is the one with real accessibility and keyboard support. */
  const viewStyle = (): 'inline' | 'native' =>
    cfg().get<string>(CONFIG_KEYS.viewStyle) === 'native' ? 'native' : 'inline';

  /** Refresh whichever view is on screen. Both are cheap no-ops when hidden. */
  const refreshViews = (): void => {
    // Suspended for the duration of a workspace switch — see suspendViews.
    if (viewsSuspended) return;
    treeController?.refresh();
    webtreeController?.refresh();
  };

  // Git worktree discovery, shared by both views and by the chip verb.
  //
  // Created here rather than inside a view because BOTH views group with it and
  // they must agree: two caches would probe on different schedules and could
  // briefly file the same session under different projects. Its refreshes are
  // background work, so a landed probe repaints through the same path a roster
  // tick does — the first paint of a project shows no chips and the one a
  // moment later shows them, which is the trade described in src/git.ts.
  const worktrees = new WorktreeCache();
  context.subscriptions.push(worktrees);
  context.subscriptions.push(worktrees.onDidChange(() => refreshViews()));

  // What each of those checkouts can say about itself: ahead/behind and dirt.
  // A second cache rather than more fields on the first, because the two probes
  // cost different amounts — one spawn per PROJECT versus one per WORKTREE — and
  // therefore cannot share a schedule. Same discipline either way: read
  // synchronously from cache, refresh in the background, repaint on a landed
  // change through the path a roster tick already uses.
  const branchStatus = new BranchStatusCache();
  context.subscriptions.push(branchStatus);
  context.subscriptions.push(branchStatus.onDidChange(() => refreshViews()));

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
    else refreshViews();
  };

  // Editorial changes (this window's mutations and other windows' writes alike)
  // must rebuild without waiting for a roster change.
  context.subscriptions.push(
    store.onDidChange(() => {
      editorialDirty = true;
      // A switch writes a record per parked and per restored session; rebuilding
      // the forest on each one repaints the sidebar a dozen times mid-switch.
      // The switch flushes its writes together at the end and resumes the views
      // itself, which is where the one rebuild comes from.
      if (viewsSuspended) return;
      if (haveRoster) void scheduleRebuild(lastEntries);
    }),
  );

  // ------------------------------------------------------------ 4. terminals

  const registry = new TerminalRegistry({
    claudeBinary: () => claudeBin(),
    terminalLocation,
    tmux: tmuxSpawn,
    // Claude's REAL pid inside a wrapped session (the terminal's own pid is
    // the tmux client's) — what keeps pid-keyed re-key detection alive for
    // wrapped terminals. Probed even when the config gate is off: sessions
    // wrapped before the flip still need their pids.
    tmuxPanePid: (name) => {
      const binary = tmuxSpawn()?.binary ?? findTmuxBinary();
      return binary !== null
        ? queryPanePid(binary, name)
        : Promise.resolve(undefined);
    },
    // The app-restart re-association source for wrapped terminals: which
    // session each live tmux client (== Terminal.processId) is attached to.
    tmuxClientSessions: () => {
      const binary = tmuxSpawn()?.binary ?? findTmuxBinary();
      return binary !== null
        ? queryClientSessions(binary)
        : Promise.resolve(new Map<number, string>());
    },
    // Closing a tab closes the SESSION (the sidebar contract) — for a
    // wrapped terminal the dispose only detached, so the registry asks for
    // the session's real end here.
    tmuxKillSession: (name) => {
      const binary = tmuxSpawn()?.binary ?? findTmuxBinary();
      return binary !== null
        ? killTmuxSession(binary, name)
        : Promise.resolve(false);
    },
  });
  context.subscriptions.push(registry);

  context.subscriptions.push(
    registry.onDidExit((sessionId) => {
      void store.upsert(sessionId, { boundWindowId: null });
      pokeNow();
    }),
    registry.onDidChangeActive(() => {
      // Re-render so the tree can restyle the active row. A switch focuses
      // every terminal it moves, so this fires dozens of times inside one —
      // coalesced into the single repaint the resume makes.
      fireForestChanged();
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
      void webtreeController?.revealSession(id);
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

  /** The name the ROW shows for a conversation, looked up over the whole chain
   *  — a re-keyed generation carries its title on an OLDER id, and the tab has
   *  to follow the name the user can see, not the id it happens to be bound
   *  under. Undefined when the conversation has no name of its own, which is
   *  when the terminal's `claude · 1a2b3c4d` default is the honest answer. */
  const tabNameFor = (sessionId: string): string | undefined => {
    for (const id of chainAliases(sessionId)) {
      const name = tabTitleFrom(
        id,
        forest.nodes.get(id)?.label,
        store.get(id)?.title,
      );
      if (name !== undefined) return name;
    }
    return undefined;
  };

  // TAB-NAME RECONCILIATION. Every bind funnels through onDidBind: the launch
  // (already named from the same source, so this is a no-op), the window-reload
  // reassociate below, the roster- and tmux-pid adoptions, and the re-key
  // rebind. Only a tab that DRIFTED does any work — one whose name still
  // matches its row is left alone, so a reload with ten live sessions renames
  // nothing and moves no focus.
  //
  // Drift is how a good name turns into a code with nobody touching it: claude
  // rewrites its terminal title while it runs (see the note in
  // workspaces.captureTabs), an adopted terminal is bound under whatever name
  // it happens to be wearing at the moment we find it, and a re-key rebinds a
  // binding whose name was minted for the previous generation. In each case the
  // row keeps the name and only the tab loses it — which is exactly the
  // complaint "the session is named fine but the tab shows a code".
  //
  // Subscribed HERE, above `reassociate()`, and not further down beside the
  // other terminal wiring: activate() awaits several times on the way there,
  // so the reload path's bind events — which land on a microtask — would have
  // come and gone before a later subscription existed.
  context.subscriptions.push(
    registry.onDidBind((b) => {
      const name = tabNameFor(b.sessionId);
      if (name === undefined || name === b.terminalName) return;
      // Best-effort, exactly as the rename verbs are: show(true) +
      // renameWithArg, and a tab left with the wrong name is not worth failing
      // a bind over. `rename` returns false rather than throwing.
      void registry.rename(b.sessionId, name);
    }),
  );

  // Window-RELOAD path: the ptys survive and creationOptions.env is rebuilt.
  // Idempotent, never throws. Its bind events land on a microtask, i.e. after
  // the subscriptions above.
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

  // `providerFor` runs once per rendered row and the grouping pass reads this
  // too, so the list is memoised rather than rebuilt (and re-copied out of the
  // store) each time. Invalidated by the store's own change event, which fires
  // for our writes and for another window's alike.
  //
  // HIDDEN PROJECTS ARE INCLUDED. `computeGrouping` does its own visible/
  // hidden split and needs to see the hidden ones, because a hidden project
  // still OWNS its directories: filter them out here and "Hide from Tree"
  // stops hiding anything — the project row goes away but its sessions come
  // straight back as a folder row, and a hidden project nested inside a
  // visible one silently re-homes its sessions under the outer one.
  let projectCache: ProjectRecord[] | null = null;
  const allProjects = (): ProjectRecord[] => {
    if (projectCache === null) projectCache = store.getProjects();
    return projectCache;
  };
  context.subscriptions.push(
    store.onDidChange(() => {
      projectCache = null;
    }),
  );

  // --------------------------------------------------------- notifications
  // The unseen model: a session that FINISHES a turn gets `doneAt` stamped;
  // looking at it stamps `seenAt`; `doneAt > seenAt` is the green dot. The
  // roster transition (busy → waiting/idle) is the poll-side detector, the
  // Stop hook the instant one; both funnel through noteSessionDone, which
  // dedupes the double report of a single turn.

  let unseenProjectsCache: Set<string> | null = null;
  const prevStatusById = new Map<string, string>();
  const recentlyDoneAt = new Map<string, number>();
  let lastHasUnseen: boolean | null = null;

  const notificationsOn = (): boolean =>
    boolCfg(CONFIG_KEYS.notificationsEnabled, true);

  /** Per-session override beats the global default. */
  const notifyFor = (sessionId: string): boolean => {
    const record = store.get(sessionId);
    return record?.notify ?? notificationsOn();
  };

  const markSeen = async (sessionId: string): Promise<void> => {
    await store.upsert(sessionId, { seenAt: new Date().toISOString() });
  };

  /** The session's terminal is the ACTIVE one in this window — under any of
   *  its generation ids, since the binding lives under the launch-time id. */
  const isWatchedHere = (sessionId: string): boolean => {
    const active = registry.activeSessionId();
    if (active === null) return false;
    if (active === sessionId) return true;
    return chainIndex.membersOf(sessionId).includes(active);
  };

  const noteSessionDone = (
    sessionId: string,
    opts?: { quiet?: boolean },
  ): void => {
    // notifyFor already folds in the global default, so a per-session
    // `notify: true` opt-in works even with the default off — the same rule
    // deriveUnseen applies.
    if (!notifyFor(sessionId)) return;
    const nowMs = Date.now();
    if (nowMs - (recentlyDoneAt.get(sessionId) ?? 0) < DONE_DEDUPE_MS) return;
    recentlyDoneAt.set(sessionId, nowMs);
    const stamp = new Date(nowMs).toISOString();
    // Watching the session as it finishes IS seeing the finish — the same
    // reason a chat app withdraws its notification for the conversation you
    // already have open.
    const watched = isWatchedHere(sessionId);
    void store.upsert(sessionId, {
      doneAt: stamp,
      ...(watched ? { seenAt: stamp } : {}),
    });
    if (opts?.quiet === true || watched) return;
    if (!boolCfg(CONFIG_KEYS.notificationsPopup, false)) return;
    const label = forest.nodes.get(sessionId)?.label ?? shortId(sessionId);
    const FOCUS = 'Focus';
    void vscode.window
      .showInformationMessage(`Flock: "${label}" finished its turn.`, FOCUS)
      .then((choice) => {
        if (choice !== FOCUS) return;
        void markSeen(sessionId);
        void vscode.commands.executeCommand(COMMANDS.focusSession, sessionId);
      });
  };

  /** Runs after every rebuild: status flips against the previous tick. A
   *  `function` declaration on purpose — rebuild() is defined above and calls
   *  it, and hoisting is what makes that ordering legal. */
  function detectTurnTransitions(): void {
    const present = new Set<string>();
    for (const node of forest.nodes.values()) {
      if (node.ghost || node.archived) continue;
      present.add(node.id);
      const prev = prevStatusById.get(node.id);
      prevStatusById.set(node.id, node.status);
      if (node.hidden) continue;
      // The turn ended: it was working, now it is not.
      if (prev === 'busy' && (node.status === 'waiting' || node.status === 'idle')) {
        noteSessionDone(node.id);
        continue;
      }
      // A session found already waiting (window opened onto it, idle →
      // waiting) is a standing ask — stamp it QUIETLY so unseen/seen compares
      // against a real timestamp, without toasting a backlog at startup.
      if (node.status === 'waiting' && prev !== 'waiting') {
        if (store.get(node.id)?.doneAt === undefined) {
          noteSessionDone(node.id, { quiet: true });
        }
      }
    }
    for (const id of [...prevStatusById.keys()]) {
      if (!present.has(id)) {
        prevStatusById.delete(id);
        recentlyDoneAt.delete(id);
      }
    }
  }

  /**
   * The bell icon flips between `bell` and `bell-dot` on this key.
   *
   * Asked of `notificationItems` rather than re-derived from the forest, so
   * that "the bell is lit" and "the dropdown has a green row" cannot answer
   * differently — they are now literally the same predicate. A second copy of
   * the filter here is what put the bell permanently red over an empty list
   * once a session was deleted while unseen.
   *
   * No projects: the dot needs `unseen` and nothing else, and project
   * attribution is a `matchProject` walk per node on every single rebuild for
   * a label thrown away on the next line.
   */
  async function syncUnseenContext(): Promise<void> {
    let has = false;
    try {
      has = notificationItems(
        forest,
        store.all(),
        [],
        Number.MAX_SAFE_INTEGER,
      ).some((i) => i.unseen);
    } catch (err) {
      logError('extension.unseenContext', err);
      return;
    }
    if (has === lastHasUnseen) return;
    lastHasUnseen = has;
    try {
      await vscode.commands.executeCommand('setContext', CONTEXT_HAS_UNSEEN, has);
    } catch (err) {
      logError('extension.unseenContext', err);
    }
  }

  /** The active-only filter is a two-position switch in the view title, and
   *  a contributed button has no state of its own: this mirrors the setting into
   *  the context key the two halves' `when` clauses read, so exactly one of them
   *  is ever on screen. Called at activation, after our own write, and on any
   *  configuration change — the setting can also be edited in settings.json,
   *  and the button has to agree with the tree it is filtering. */
  async function syncOnlyActiveContext(): Promise<void> {
    try {
      await vscode.commands.executeCommand(
        'setContext',
        CONTEXT_ONLY_ACTIVE,
        boolCfg(CONFIG_KEYS.onlyActiveSessions, false),
      );
    } catch (err) {
      logError('extension.onlyActiveContext', err);
    }
  }

  /**
   * THE session selection, whichever view reported it.
   *
   * One store for both views, because a command cannot tell which one it was
   * invoked from and must not have to: only one of the two is ever on screen
   * (their `when` clauses are complements), so the last report is always the
   * live one. The webview posts its own on every change; the native tree
   * forwards `onDidChangeSelection`.
   */
  let selectedSessionIds: string[] = [];
  let lastMultiSelect = false;

  const noteSelection = (ids: string[]): void => {
    selectedSessionIds = Array.isArray(ids) ? [...ids] : [];
    const many = selectedSessionIds.length > 1;
    // Only on a CHANGE: setContext is a round trip to the workbench and a
    // selection changes on every arrow key.
    if (many === lastMultiSelect) return;
    lastMultiSelect = many;
    void (async (): Promise<void> => {
      try {
        await vscode.commands.executeCommand(
          'setContext',
          CONTEXT_MULTI_SELECT,
          many,
        );
      } catch (err) {
        logError('extension.multiSelectContext', err);
      }
    })();
  };

  /** Project rows carrying the bubbled-up green dot, for the decoration
   *  provider (native tree) — the webview computes its own from the rows. */
  const projectsWithUnseen = (): ReadonlySet<string> => {
    if (unseenProjectsCache) return unseenProjectsCache;
    const out = new Set<string>();
    try {
      for (const node of forest.nodes.values()) {
        if (node.unseen !== true || node.hidden) continue;
        const match = matchProject(allProjects(), node.cwd);
        if (match && match.project.hidden !== true) out.add(match.project.id);
      }
    } catch (err) {
      logError('extension.projectsWithUnseen', err);
    }
    unseenProjectsCache = out;
    return out;
  };

  // Rebound to the real WorkspaceManager below (it does not exist yet, and
  // terminal events can fire during activation's awaits).
  let isWorkspaceSwitching = (): boolean => false;

  // Looking at a session clears its dot: the terminal becoming ACTIVE in this
  // window is the strongest "the user is looking" signal the API offers.
  // Except mid-switch — stowing focuses each terminal it moves, and a
  // green dot must survive its session being tucked into the panel.
  context.subscriptions.push(
    registry.onDidChangeActive((sessionId) => {
      if (!sessionId) return;
      if (isWorkspaceSwitching()) return;
      const rowId = chainIndex.tipOf(sessionId);
      const node = forest.nodes.get(rowId) ?? forest.nodes.get(sessionId);
      if (node?.unseen === true) void markSeen(node.id);
    }),
  );

  /** Provider glyph for a session: an explicit per-session override wins,
   *  then the project that owns its cwd, then the default. Hidden projects
   *  count — a hidden project still owns its directories, and the same
   *  ownership rule has to hold everywhere or the glyph disagrees with the
   *  row the session is filed under. */
  const providerFor = (sessionId: string): ProviderId => {
    const record = store.get(sessionId);
    if (isProviderId(record?.provider)) return record.provider;
    const cwd = forest.nodes.get(sessionId)?.cwd ?? record?.cwd;
    const match = matchProject(allProjects(), cwd);
    return match ? providerOfProject(match.project) : DEFAULT_PROVIDER;
  };

  const viewDeps: TreeDeps & DecorationDeps = {
    getForest: () => forest,
    onDidChangeData: (listener) => onForestChanged.event(listener),
    projectsWithUnseen,
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
    projects: allProjects,
    hiddenFolders: () => store.getHiddenFolders().map((f) => f.path),
    onlyProjectSessions: () =>
      boolCfg(CONFIG_KEYS.onlyProjectSessions, false),
    onlyActiveSessions: () => boolCfg(CONFIG_KEYS.onlyActiveSessions, false),
    noteSelection,
    showTokens: () => boolCfg(CONFIG_KEYS.showTokens, false),
    worktreesOf: (dir) => worktrees.get(dir),
    branchStatusOf: (dir) => branchStatus.get(dir),
    // Read raw and sanitised at the point of use, not here: the value is a
    // user-editable array that lands in an inline <style> block, and the one
    // place that knows what a legal palette entry looks like is the function
    // that writes the CSS (sanitizeBranchColor).
    branchColors: () =>
      cfg().get<unknown[]>(CONFIG_KEYS.branchColors, [])?.map(String) ?? [],
    // Read per render like every other setting here, so the layout flips
    // on the next tick rather than on a window reload.
    groupSessionsByBranch: () =>
      boolCfg(CONFIG_KEYS.groupSessionsByBranch, false),
    // Dropping a project row onto another project row files it there;
    // onto the background (or a folder row) it goes back to the top level. The
    // store owns the cycle refusal — see StateStore.setProjectParent — and a
    // refused move is silent here on purpose: the gesture is cheap, repeatable
    // and its own feedback (the row does not move), where a modal for a drag
    // that landed somewhere illegal is a dialog nobody asked for.
    reparentProject: async (projectId, newParentId) => {
      const moved = await store.setProjectParent(projectId, newParentId);
      if (!moved) return;
      log(
        'project:',
        store.getProject(projectId)?.name ?? projectId,
        'filed under',
        newParentId === null
          ? '(top level)'
          : (store.getProject(newParentId)?.name ?? newParentId),
      );
      refreshNow();
    },
    providerFor,
    mediaPath,
    // Dropping a session onto a project row teaches the project the directory
    // that session runs in — membership is derived from cwd, so there is
    // nothing to write on the session itself.
    assignToProject: async (sessionId, projectId) => {
      const project = store.getProject(projectId);
      if (!project) return;
      const cwd = forest.nodes.get(sessionId)?.cwd ?? store.get(sessionId)?.cwd;
      if (!cwd) {
        void vscode.window.showWarningMessage(
          'Flock: that session has no known working directory to add.',
        );
        return;
      }
      // Membership is CONTAINMENT, not path equality — the same rule
      // matchProject uses. An exact-match test lets a session already filed
      // under this very row (its cwd sits below one of the project's dirs)
      // append a redundant deeper path, which then wins matchProject's
      // longest-match tiebreak and starts stealing sessions from a project
      // rooted at a shallower ancestor.
      if (matchProject([project], cwd)) return; // already ours
      await store.upsertProject(projectId, {
        dirs: [...projectDirs(project).slice(1), cwd],
      });

      // A drop is a MOVE. Adding the directory is not enough when the previous
      // owner lists it too: matchProject then sees two equal-depth matches and
      // breaks the tie on project name, so the session stays where it was and
      // the gesture succeeds or fails purely on alphabetical order — while the
      // target silently keeps a directory it does not display.
      for (const other of store.getProjects()) {
        if (other.id === projectId) continue;
        const dirs = projectDirs(other);
        const keep = dirs.filter((d) => pathKey(d) !== pathKey(cwd));
        if (keep.length === dirs.length) continue;
        if (keep.length === 0) {
          // Its only directory was the one being moved away; hiding it would
          // be a silent delete, so leave it and say what happened.
          void vscode.window.showWarningMessage(
            `Flock: "${other.name}" only covers ${cwd}, so it still claims ` +
              `it. Remove the directory there, or delete that project.`,
          );
          continue;
        }
        await store.upsertProject(other.id, {
          rootDir: keep[0],
          dirs: keep.slice(1),
        });
        log('project:', other.name, 'lost', cwd, 'to', project.name);
      }

      log('project:', project.name, 'gained', cwd, 'via drag');
      refreshNow();
    },
  };

  // Both views are registered unconditionally; `lineage.nativeTree` decides
  // which one the workbench SHOWS (their `when` clauses are complements). That
  // is cheaper and far less fragile than registering conditionally — a view
  // provider cannot be un-registered and re-registered on a settings change
  // without leaking the old one, and the hidden view costs nothing: its
  // provider never resolves, so it never builds a model.
  const inlineView = viewStyle() === 'inline';
  await vscode.commands.executeCommand(
    'setContext',
    CONTEXT_NATIVE_TREE,
    !inlineView,
  );
  // The filter's title button reads this; without it the view opens showing the
  // "turn it on" half while the tree is already filtered.
  await syncOnlyActiveContext();

  treeController = registerTree(viewDeps);
  context.subscriptions.push(treeController);
  context.subscriptions.push(registerDecorations(viewDeps));

  /**
   * The session whose terminal had the keyboard when an inline rename took it
   * away, and which therefore gets it back when that rename commits.
   *
   * Naming a row lives in the sidebar, so `beginInlineRename` focuses the view
   * — which means a session named right after it was created loses the
   * terminal that opened a moment earlier. Handing the keyboard back on commit
   * is what makes that trade invisible: you type the name, press Enter, and
   * you are typing in the session again.
   *
   * Only the session the focus was taken FROM, never every rename: renaming a
   * background row from the sidebar must leave focus in the sidebar, which is
   * what the Explorer does and what someone renaming several rows in a row
   * expects. Set on every inline-rename hand-over (to undefined when the rule
   * does not apply), consumed once.
   */
  let renameFocusReturnId: string | undefined;

  webtreeController = registerWebtree(
    {
      ...viewDeps,
      renameSession: async (sessionId, title) => {
        await store.upsert(sessionId, { title });
        // Best-effort, exactly as the palette rename is: there is no terminal
        // rename API, so this is show(true) + renameWithArg and can fail.
        //
        // Over the CHAIN, like every other terminal verb here (see
        // chainAliases): after a re-key the terminal is still bound under
        // the generation id it was LAUNCHED with, not the id this row now
        // carries — so renaming only `sessionId` silently hit nothing and left
        // the tab on its old name (a `claude · 1a2b3c4d` default, usually)
        // while the row took the new one. That split is the whole bug.
        for (const id of chainAliases(sessionId)) {
          if (await registry.rename(id, title)) break;
        }
        refreshNow();
        // After the terminal rename, which deliberately preserves focus — so
        // this is the only call that moves it, and it moves it back to where
        // the edit box took it from.
        //
        // Re-checked rather than trusted: the terminal can be closed while the
        // edit box is open, and `focusSession` on a session with no terminal
        // here is not a no-op — it offers to resume it, which is a dialog
        // nobody asked for on the back of a rename.
        if (renameFocusReturnId === sessionId) {
          renameFocusReturnId = undefined;
          if (isWatchedHere(sessionId)) {
            await vscode.commands.executeCommand(
              COMMANDS.focusSession,
              sessionId,
            );
          }
        }
      },
      renameCancelled: () => {
        // The edit ended with no name. Disarm — see renameFocusReturnId.
        renameFocusReturnId = undefined;
      },
      renameProject: async (projectId, name) => {
        // The client cannot validate this one: it has no view of the other
        // projects, and no way to know the project cap (60) is lower than the
        // session cap (80) its own editor enforces. So a name the row happily
        // accepted can still be refused here — and refusing it silently is
        // what makes the row look broken, because all the user sees is the
        // next model post repainting the old label with nothing to say why.
        // The quick-input path shows the reason inside the box; this is the
        // same reason, in the only place this path has to put it.
        const refusal = validateProjectName(name, allProjects(), projectId);
        if (refusal !== '') {
          void vscode.window.showWarningMessage(`Flock: ${refusal}`);
          return;
        }
        await store.upsertProject(projectId, { name });
        refreshNow();
      },
      activateSession: async (sessionId) => {
        // One entry point for a row click, so the webview never has to know
        // whether a session is live, hosted elsewhere, or closed.
        await vscode.commands.executeCommand(COMMANDS.focusSession, sessionId);
      },
      runCommand: async (command, arg) => {
        await vscode.commands.executeCommand(COMMANDS[command], arg);
      },
    },
    context.extensionUri,
  );
  context.subscriptions.push(webtreeController);

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
    // Re-key. The hook inherited LINEAGE_NODE_ID from a terminal WE
    // stamped, and the CLI in that terminal is now running a different
    // session id: the conversation moved (plain --resume, /clear, compaction
    // — whichever, the CLI minted a new generation). Exact by construction —
    // both ids name the same terminal — and this is the whole enrollment
    // payload: appendChainMember fires the store's change event, which
    // rebuilds, which collapses the old id's row into the new tip.
    //
    // Exception: `source: 'fork'` is a NEW BRANCH, not a re-key. Chaining
    // it would collapse the parent into its own fork — the parent edge comes
    // from the daemon roster (or the transcript marker) instead.
    if (
      e.sessionId &&
      e.nodeId &&
      e.nodeId !== e.sessionId &&
      e.source !== 'fork'
    ) {
      void store.appendChainMember(e.nodeId, e.sessionId);
    }
    // Stop is the turn ending, right now — the poll transition would say
    // the same thing up to pollIntervalMs later. (`Notification` is claude
    // asking for the user, same urgency.)
    if (e.sessionId && (e.event === 'Stop' || e.event === 'Notification')) {
      noteSessionDone(e.sessionId);
    }
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

  /**
   * Select a session's row, waiting for the row to EXIST first.
   *
   * A session the extension just launched is not in the forest yet: the roster
   * is `claude agents --json`, and the process needs a moment to appear in it.
   * An immediate reveal() would therefore silently no-op on exactly the rows we
   * most want selected — the branch that was just created and named. So: reveal
   * now if it is already there, otherwise on the first rebuild that contains it,
   * and give up quietly once the wait expires (a launch can always fail).
   */
  const REVEAL_WAIT_MS = 15_000;
  const revealSession = (sessionId: string): Promise<void> => {
    if (!isSessionId(sessionId)) return Promise.resolve();
    const reveal = (): Promise<void> =>
      Promise.all([
        treeController?.revealSession(sessionId),
        webtreeController?.revealSession(sessionId),
      ]).then(
        () => undefined,
        (err: unknown) => {
          logError('extension.revealSession', err);
        },
      );
    if (forest.nodes.has(sessionId)) return reveal();

    return new Promise<void>((resolve) => {
      let sub: vscode.Disposable | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (found: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        try {
          sub?.dispose();
        } catch (err) {
          logError('extension.revealSession.dispose', err);
        }
        if (!found) return resolve();
        void reveal().then(() => resolve());
      };
      timer = setTimeout(() => finish(false), REVEAL_WAIT_MS);
      try {
        sub = onForestChanged.event(() => {
          if (forest.nodes.has(sessionId)) finish(true);
        });
      } catch (err) {
        logError('extension.revealSession.subscribe', err);
        finish(false);
      }
    });
  };

  // ----------------------------------------------------- project workspaces

  // --------------------------------------- the Explorer follows the project
  //
  // The built-in Explorer's folder tree IS `workspace.workspaceFolders` — there
  // is no API to reroot it — so making it follow the active project means
  // splicing that list. src/explorer.ts owns the arithmetic and the anchor
  // invariant that keeps a splice from restarting the extension host; this is
  // only the workbench half of it.
  const explorerAnchorPath = path.join(
    context.globalStorageUri.fsPath,
    ANCHOR_DIR_NAME,
  );
  const explorerWorkspaceFile = path.join(
    context.globalStorageUri.fsPath,
    WORKSPACE_FILE_NAME,
  );
  const explorerSync = new ExplorerSync(
    {
      folders: () =>
        (vscode.workspace.workspaceFolders ?? []).map((f) => ({
          path: f.uri.fsPath,
          name: f.name,
        })),
      splice: (start, deleteCount, add) =>
        vscode.workspace.updateWorkspaceFolders(
          start,
          deleteCount,
          ...add.map((f) => ({ uri: vscode.Uri.file(f.path), name: f.name })),
        ),
      // `updateWorkspaceFolders` may not be called again before its change
      // event has fired. The timeout is the safety valve: a splice the
      // workbench never reports back must not wedge every later switch.
      awaitFolderChange: (timeoutMs) =>
        new Promise<void>((resolve) => {
          let sub: vscode.Disposable | undefined;
          let timer: ReturnType<typeof setTimeout> | undefined;
          let done = false;
          const finish = (): void => {
            if (done) return;
            done = true;
            if (timer !== undefined) clearTimeout(timer);
            try {
              sub?.dispose();
            } catch (err) {
              logError('extension.folderChange.dispose', err);
            }
            resolve();
          };
          try {
            sub = vscode.workspace.onDidChangeWorkspaceFolders(finish);
          } catch (err) {
            logError('extension.folderChange', err);
          }
          timer = setTimeout(finish, timeoutMs);
        }),
      exists: async (p) => {
        try {
          await vscode.workspace.fs.stat(vscode.Uri.file(p));
          return true;
        } catch {
          return false;
        }
      },
      // Relabel the anchor row by editing the workspace file on disk. This is
      // the ONE thing here that rests on observed rather than documented
      // behaviour — nothing promises VS Code applies an external
      // `folders[0].name` edit in place — so it is written to be harmless when
      // it does not take: the file is left valid, and the header view is still
      // there saying the same thing.
      renameAnchor: async (name) => {
        const uri = vscode.Uri.file(explorerWorkspaceFile);
        const raw = await vscode.workspace.fs.readFile(uri);
        const next = withAnchorName(
          new TextDecoder().decode(raw),
          name,
        );
        if (next === null) {
          log(
            'explorer: workspace file is not plain JSON — leaving the anchor ' +
              'label alone rather than clobbering it',
          );
          return;
        }
        await vscode.workspace.fs.writeFile(
          uri,
          new TextEncoder().encode(next),
        );
      },
    },
    explorerAnchorPath,
  );

  // ---------------------------------------------------------- 6b. accounts
  //
  // The one place the accounts feature is assembled: the store (the roster and
  // the pins), the limits reader (the usage numbers, and the only part of this
  // that touches the network), and the pure resolvers in accounts.ts /
  // routing.ts that neither of the two view layers may import directly.
  //
  // Everything below is wired unconditionally except the VIEW, which
  // `lineage.accounts.enabled` gates. The verbs stay registered either way:
  // turning the view off is "I do not want a second list in my sidebar", not
  // "unregister ten commands so the palette reports them missing".

  /** Where a new profile's private config directory goes. `os.homedir()` is
   *  the caller's job — accounts.ts stays filesystem- and os-free so its rules
   *  are testable without either. */
  const profileHome = (): string => {
    try {
      return os.homedir();
    } catch (err) {
      logError('extension.homedir', err);
      return '';
    }
  };

  // The usage numbers. This is the ONLY place the limits module is named: it
  // is not vscode-facing, the view and the verbs are, and neither may import
  // the other — so it crosses as a `LimitsReader` (types.ts), which the service
  // implements outright. No adapter: the interface carries `force`, because a
  // manual refresh that could not step over the service's own minimum-interval
  // guard would be a button that silently returns the cache.
  const limits = new LimitsService();
  context.subscriptions.push(limits);
  const usageCache = new AccountUsageCache(limits);
  context.subscriptions.push(usageCache);

  /** Where the SHARED configuration lives — the default config dir for the
   *  symlinked items, the home-root `.claude.json` for trust seeding. */
  const profileConfigSources = (): ProfileConfigSources => {
    const home = profileHome();
    return {
      defaultDir: home === '' ? '' : path.join(home, '.claude'),
      defaultIdentityFile: home === '' ? '' : path.join(home, '.claude.json'),
    };
  };

  /** Retrofit: profiles created before the shared-config wiring existed (or on
   *  another machine) get their symlinks and trust seeding here. Idempotent
   *  and additive — a profile that already has everything is a no-op, one that
   *  diverged on purpose is left diverged. */
  const wireProfileConfigs = async (): Promise<void> => {
    try {
      const sources = profileConfigSources();
      if (sources.defaultDir === '') return;
      for (const profile of store.getAccounts()) {
        const dir =
          typeof profile.configDir === 'string' ? profile.configDir.trim() : '';
        if (dir === '' || profile.provider !== 'claude') continue;
        await ensureProfileConfig(dir, sources);
      }
    } catch (err) {
      logError('extension.wireProfileConfigs', err);
    }
  };

  /** First run: give the machine's existing logins a row each, so a user who
   *  never opens this view still has their sessions pinned to something with a
   *  name. Additive — `seedDefaultProfiles` returns only what is missing, so
   *  this is safe on every activation. */
  const seedAccounts = async (): Promise<void> => {
    try {
      let hasCodexAuth = false;
      const home = profileHome();
      if (home !== '') {
        try {
          await vscode.workspace.fs.stat(
            vscode.Uri.file(path.join(home, '.codex', 'auth.json')),
          );
          hasCodexAuth = true;
        } catch {
          hasCodexAuth = false;
        }
      }
      // Tombstones: a deleted seed stays deleted. `accountIds()` is
      // every id including tombstoned ones; live ids are subtracted so only
      // the graves remain.
      const live = store.getAccounts();
      const liveIds = new Set(live.map((p) => p.id));
      const tombstonedIds = store.accountIds().filter((id) => !liveIds.has(id));
      const seeds = seedDefaultProfiles(live, { hasCodexAuth, tombstonedIds });
      for (const seed of seeds) {
        await store.upsertAccount(seed.id, {
          provider: seed.provider,
          label: seed.label,
        });
        log('accounts: seeded', seed.id);
      }
    } catch (err) {
      logError('extension.seedAccounts', err);
    }
  };
  await seedAccounts();
  await wireProfileConfigs();

  /** The pinned account's launch fields for a conversation — what a resume, a
   *  reattach and a workspace restore all re-inject. `pinnedLaunchProfile`
   *  returns null for a dangling pin — and for a pin naming an account no
   *  session can run on — deliberately; both land the launch on the machine's
   *  default login rather than on somebody else's subscription. */
  const accountLaunchFor = (
    sessionId: string,
  ): { env?: Readonly<Record<string, string>>; profileId?: string } | undefined => {
    try {
      const profile = pinnedLaunchProfile(
        store.getSessionProfile(sessionId),
        store.getAccounts(),
      );
      if (!profile) return undefined;
      return { env: envForProfile(profile), profileId: profile.id };
    } catch (err) {
      logError('extension.accountLaunchFor', err);
      return undefined;
    }
  };

  let accountsViewController: AccountsViewController | undefined;

  const accountDeps: AccountDeps = {
    accounts: () => store.getAccounts(),
    getAccount: (id) => store.getAccount(id),
    allAccountIds: () => store.accountIds(),
    upsertAccount: (id, patch) => store.upsertAccount(id, patch),
    deleteAccount: async (id) => {
      await store.deleteAccount(id);
      // The numbers described a login this window is no longer showing; a
      // re-added account must not inherit them. Both caches, because both
      // hold one.
      usageCache.forget(id);
      limits.forget(id);
    },
    setAccountOrder: (id, order) => store.setAccountOrder(id, order),
    defaultRouting: () => store.getDefaultRouting(),
    setDefaultRouting: (choice) => store.setDefaultRouting(choice),
    setProjectRouting: (projectId, choice) =>
      store.setProjectRouting(projectId, choice),
    sessionProfileId: (sessionId) => store.getSessionProfile(sessionId),
    pinSession: (sessionId, profileId) =>
      store.setSessionProfile(sessionId, profileId),
    usage: (profile) => usageCache.get(profile),
    usageMap: () => usageCache.mapFor(store.getAccounts()),
    refreshUsage: (profiles, force) => usageCache.refresh(profiles, { force }),
    onUsageChanged: (listener) => usageCache.onDidChange(listener),
    createProfileDir: async (id) => {
      try {
        const dir = profileConfigDirFor(id, profileHome());
        if (dir === '') return undefined;
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
        // A new profile isolates the LOGIN, not the person. Wire the
        // shared settings/skills/trust in before the first session ever runs,
        // so account number two does not greet the user like a fresh install.
        await ensureProfileConfig(dir, profileConfigSources());
        return dir;
      } catch (err) {
        logError('extension.createProfileDir', err);
        return undefined;
      }
    },
    claudeBinary: () => claudeBin(),
    mediaPath,
    refreshAccounts: () => accountsViewController?.refresh(),
    // The limits module's own wording, so the meter reads identically wherever
    // it appears — the row, the account picker, the project's routing dialog.
    formatUsage: (snapshot) => formatUsageSummary(snapshot),
  };

  if (boolCfg(CONFIG_KEYS.accountsEnabled, true)) {
    accountsViewController = registerAccountsView(accountDeps);
    context.subscriptions.push(accountsViewController);
  }

  // ONE read at start-up, whether or not the view exists and whether or not
  // anybody is looking at it. The meters are not only decoration: the
  // auto-picker scores accounts on them, and it runs on every new session —
  // including on a machine where the Accounts view is collapsed (its shipped
  // state) or switched off entirely. Without this the picker sees an empty map,
  // every account ranks "no usage data", and the whole feature degrades to
  // "first in your list" while the status line says so. Fire-and-forget:
  // activation must not wait on the network, the cache's own age guard makes a
  // second call from a visible view a no-op, and every failure inside resolves
  // to "unknown", never a throw.
  void usageCache.refresh(store.getAccounts());

  const workspaceManager = new WorkspaceManager({
    getProject: (id) => store.getProject(id),
    // A restore is a resume: it re-injects the account the conversation
    // was pinned to, never a freshly routed one.
    accountLaunchFor,
    getWorkspace: (id) => store.getWorkspace(id),
    saveWorkspace: (id, tabs) => store.saveWorkspace(id, tabs),
    getRecord: (id) => store.get(id),
    allRecords: () => store.all(),
    upsertRecord: (id, patch) => store.upsert(id, patch),
    // Tip-routed: a terminal is bound under its LAUNCH-time id, but after a
    // re-key the forest only knows the chain tip.
    sessionCwd: (id) => {
      const tip = chainIndex.tipOf(id);
      return (
        forest.nodes.get(tip)?.cwd ??
        forest.nodes.get(id)?.cwd ??
        store.get(tip)?.cwd ??
        store.get(id)?.cwd
      );
    },
    isLive: (id) =>
      chainAliases(id).some((alias) =>
        lastEntries.some((e) => e.sessionId === alias),
      ),
    bindings: () => registry.bindings(),
    // Re-walk the host's terminals before a switch reads the binding table.
    // reassociate() is idempotent and never throws: it picks up terminals
    // revived by a window reload and drops bindings whose terminal the host no
    // longer lists — a switch that plans against a dead binding "stows"
    // nothing while marking the session parked.
    refreshBindings: () => {
      registry.reassociate();
    },
    // PARK: dispose the session's terminal — instant, silent (an API dispose
    // never raises the "terminate running processes?" dialog), and the
    // terminal panel is never involved. The conversation survives in its
    // transcript; the switch back resumes it. Probed under every generation
    // id, because the binding lives under the launch-time one.
    closeSessionTab: (id) =>
      chainAliases(id).some((alias) => registry.closeTerminal(alias)),
    // A switch must never abort work in flight: a session mid-turn (busy) or
    // blocked on a permission dialog (waiting) keeps its tab — in the KILL
    // tier. A tmux-backed session is detached instead, which interrupts
    // nothing, so the manager only consults this when tmuxNameOf is empty.
    isSessionBusy: (id) =>
      chainAliases(id).some((alias) => {
        const entry = lastEntries.find((e) => e.sessionId === alias);
        if (!entry) return false;
        const status = normalizeStatus(entry).status;
        return status === 'busy' || status === 'waiting';
      }),
    // Detach tier: the binding holds the tmux session name under whichever
    // generation id the terminal LAUNCHED with, so probe the whole chain.
    tmuxNameOf: (id) => {
      for (const alias of chainAliases(id)) {
        const name = registry.tmuxNameOf(alias);
        if (name !== undefined) return name;
      }
      return undefined;
    },
    // Legacy migration: an older build parked sessions into the terminal
    // panel; a still-live one is moved home as an editor tab on the first
    // switch back to its project.
    unstowSessionTab: async (id) => {
      for (const alias of chainAliases(id)) {
        if (await registry.moveToEditor(alias)) return true;
      }
      return false;
    },
    activeSessionId: () => registry.activeSessionId(),
    focusSession: (id) => {
      for (const alias of chainAliases(id)) {
        if (registry.focus(alias)) return true;
      }
      return false;
    },
    launchSession: (opts) => registry.launch(opts),
    hasTranscript: (id) =>
      hasTranscript(id, { extraProjectsDirs: profileProjectsDirs() }),
    repairResumeLeaf: (id) =>
      repairResumeLeaf(id, { extraProjectsDirs: profileProjectsDirs() }),
    tipOf: (id) => chainIndex.tipOf(id),
    getActive: () => {
      const v = context.workspaceState.get<string>(ACTIVE_WORKSPACE_KEY);
      return typeof v === 'string' && v.length > 0 ? v : null;
    },
    setActive: async (id) => {
      await context.workspaceState.update(ACTIVE_WORKSPACE_KEY, id ?? undefined);
      updateWorkspaceStatusBar();
    },
    resumeSessions: () =>
      boolCfg(CONFIG_KEYS.workspacesResumeSessions, true),
    // With sessions in the panel there are no session tabs to park or restore,
    // so a switch leaves terminals alone entirely and snapshots files only.
    terminalLocation,
    // Swap the Explorer's folder tree to the target project as part of
    // the switch. Gated on the setting, and a no-op in any window that was
    // never converted into a Flock workspace — the switch itself does not
    // care either way (see WorkspaceManagerDeps.syncExplorer).
    syncExplorer: async (project) => {
      if (!boolCfg(CONFIG_KEYS.explorerFollowProject, true)) return;
      await explorerSync.sync(project);
    },
    refresh: () => refreshNow(),
    suspendViews,
    resumeViews,
  });
  isWorkspaceSwitching = () => workspaceManager.isSwitching();

  // THE SIDEBAR MIRRORS THE TAB STRIP: selecting a session's tab selects its
  // row (scrolled into view, never taking the keyboard — revealSession's own
  // contract). Guarded during switches, which focus terminals as side
  // effects — the selection must not be dragged around the tree by echoes.
  context.subscriptions.push(
    registry.onDidChangeActive((sessionId) => {
      try {
        if (!sessionId || workspaceManager.isSwitching()) return;
        void treeController?.revealSession(sessionId);
        void webtreeController?.revealSession(sessionId);
      } catch (err) {
        logError('extension.revealOnActive', err);
      }
    }),
  );

  // FOCUS FOLLOWS PROJECT (the marquee behaviour): start working in a session
  // that belongs to another project and the window switches to that project's
  // workspace by itself — the current layout is saved, foreign tabs close,
  // the project's saved layout comes back. "When we are in a certain project,
  // we only see that project's tabs" without ever hunting for a verb. The
  // auto path never interrupts: busy foreign sessions stay open (no modal)
  // and the summary goes to the status bar. `lineage.workspaces.autoSwitch`
  // (default true) turns it off; the explicit command remains either way.
  context.subscriptions.push(
    registry.onDidChangeActive((sessionId) => {
      try {
        if (!sessionId) return;
        // A switch disposes and launches terminals, so it fires a burst of
        // active-terminal events itself — drop them here, silently, instead
        // of logging an "auto-switching / ignored" pair for every one.
        if (workspaceManager.isSwitching()) return;
        if (!boolCfg(CONFIG_KEYS.workspacesEnabled, true)) return;
        if (!boolCfg(CONFIG_KEYS.workspacesAutoSwitch, true)) return;
        const tip = chainIndex.tipOf(sessionId);
        const cwd =
          forest.nodes.get(tip)?.cwd ??
          forest.nodes.get(sessionId)?.cwd ??
          store.get(tip)?.cwd ??
          store.get(sessionId)?.cwd;
        const match = matchProject(allProjects(), cwd);
        if (!match || match.project.hidden === true) return;
        if (match.project.id === workspaceManager.activeProjectId()) return;
        log(
          'workspaces: focus moved into',
          match.project.name,
          '— auto-switching',
        );
        void workspaceManager.switchTo(match.project.id, { auto: true });
      } catch (err) {
        logError('extension.autoSwitch', err);
      }
    }),
  );

  /** `$(layers) <project>` in the status bar; clicking opens the switcher.
   *  Gated on `lineage.workspaces.enabled` and re-evaluated on config change. */
  let workspaceStatusBar: vscode.StatusBarItem | undefined;
  const updateWorkspaceStatusBar = (): void => {
    try {
      // The Explorer header names the same thing the status bar does, so it
      // repaints on the same signal — and BEFORE the enabled check below, or
      // turning the status bar off would silently freeze the header too.
      refreshExplorerHeader();
      const w: Partial<typeof vscode.window> = vscode.window;
      if (!boolCfg(CONFIG_KEYS.workspacesEnabled, true)) {
        workspaceStatusBar?.hide();
        return;
      }
      if (!workspaceStatusBar) {
        if (typeof w.createStatusBarItem !== 'function') return;
        workspaceStatusBar = w.createStatusBarItem(
          vscode.StatusBarAlignment.Left,
          90,
        );
        workspaceStatusBar.command = COMMANDS.switchWorkspace;
        context.subscriptions.push(workspaceStatusBar);
      }
      const activeId = workspaceManager.activeProjectId();
      const project = activeId ? store.getProject(activeId) : undefined;
      workspaceStatusBar.text = `$(layers) ${project ? project.name : 'No Workspace'}`;
      workspaceStatusBar.tooltip = project
        ? `Flock workspace: ${project.name} — click to switch`
        : 'Flock: click to scope this window to a project workspace';
      workspaceStatusBar.show();
    } catch (err) {
      logError('extension.workspaceStatusBar', err);
    }
  };
  updateWorkspaceStatusBar();

  /** `lineage.explorerFollow` — see CONTEXT_EXPLORER_FOLLOW for why it is not
   *  simply "this window is anchored". */
  const updateExplorerContext = async (): Promise<void> => {
    try {
      const activeId = workspaceManager.activeProjectId();
      const active = activeId ? store.getProject(activeId) : undefined;
      // The header view exists to say which project the folder tree is
      // showing. Once the ANCHOR ROW is painting that name itself, a second row
      // repeating it is noise — so the view hides. Read back from the live
      // folder list rather than from what we wrote, so the view comes straight
      // back if the workbench ever stops applying the on-disk rename.
      const anchorSaysIt =
        active !== undefined &&
        explorerSync.anchorLabel() === anchorLabelFor(active);
      const on =
        boolCfg(CONFIG_KEYS.explorerFollowProject, true) &&
        !anchorSaysIt &&
        (explorerSync.anchored() || activeId !== null);
      await vscode.commands.executeCommand(
        'setContext',
        CONTEXT_EXPLORER_FOLLOW,
        on,
      );
    } catch (err) {
      logError('extension.explorerContext', err);
    }
  };

  projectViewController = registerProjectView({
    activeProject: () => {
      const id = workspaceManager.activeProjectId();
      return id ? store.getProject(id) : undefined;
    },
    anchored: () => explorerSync.anchored(),
    // Counted over the RENDERED forest, the same population the sidebar shows,
    // so the header's number and the sidebar's rows never disagree.
    sessionCount: (projectId) => {
      const projects = allProjects();
      let n = 0;
      for (const node of forest.nodes.values()) {
        if (matchProject(projects, node.cwd)?.project.id === projectId) n += 1;
      }
      return n;
    },
    onDidChangeData: (listener) => onForestChanged.event(listener),
  });
  context.subscriptions.push(projectViewController);
  refreshExplorerHeader = (): void => {
    projectViewController?.refresh();
    void updateExplorerContext();
  };
  refreshExplorerHeader();

  // A window reload rebuilds the folder list from the workspace file, so the
  // Explorer normally comes back already pointed at the right project. This
  // heals the cases where it does not: the project gained or lost a directory
  // while another window was the one switching, or it was renamed (the main
  // root carries the project's name, not the directory's).
  if (explorerSync.anchored()) {
    const activeId = workspaceManager.activeProjectId();
    const active = activeId ? store.getProject(activeId) : undefined;
    if (active && boolCfg(CONFIG_KEYS.explorerFollowProject, true)) {
      void explorerSync.sync(active);
    }
  }

  const commandDeps: AccountCommandDeps = {
    // The whole accounts surface, as ONE optional member: the verbs guard
    // on its presence, so a build without it behaves exactly as this extension
    // did before accounts existed.
    accounts: accountDeps,

    getForest: () => forest,
    refresh: refreshNow,
    hasTranscript: (sessionId) =>
      hasTranscript(sessionId, { extraProjectsDirs: profileProjectsDirs() }),
    repairResumeLeaf: (sessionId) =>
      repairResumeLeaf(sessionId, { extraProjectsDirs: profileProjectsDirs() }),
    transcriptFacts,
    // The roster's own answer, one tick old at worst. `prevLiveIds` is
    // assigned the CURRENT set at the end of every rebuild — the name is about
    // where it is read from inside the rebuild, not about how stale it is —
    // and it is the only live-id set that outlives one.
    isLive: (sessionId) => prevLiveIds.has(sessionId),
    tipOf: (sessionId) => chainIndex.tipOf(sessionId),
    // The background job holding this id, if one does — the shape a
    // native `/fork` dispatches. Stat-cached inside the reader, so asking on
    // every focus costs nothing.
    backgroundJob: (sessionId) => daemonReader.read().jobs.get(sessionId),
    // Detach tier: does the private server still hold this wrap? Same probe
    // the registry uses for pane pids — a name that answers with one is a
    // session that exists. Probed even when the config gate is off, like
    // tmuxPanePid above: sessions wrapped before the flip are still wrapped.
    tmuxSessionLive: async (name) => {
      const binary = tmuxSpawn()?.binary ?? findTmuxBinary();
      if (binary === null) return false;
      return (await queryPanePid(binary, name)) !== undefined;
    },
    revealSession,

    /** No wait-for-it loop, unlike revealSession: a project exists in the model
     *  the moment it is written, because it comes from `state.json` rather than
     *  from a roster tick. The native tree has no project reveal, so this is
     *  the inline view or nothing. */
    revealProject: async (projectId) => {
      try {
        await webtreeController?.revealProject(projectId);
      } catch (err) {
        logError('extension.revealProject', err);
      }
    },

    /** True only when the inline view actually took the edit. The native tree
     *  has no editable row, and a hidden webview has no DOM to put an input in,
     *  so both must report failure and let the caller fall back to the
     *  quick-input rename rather than swallow the verb. */
    beginInlineRename: async (sessionId) => {
      if (viewStyle() !== 'inline' || !webtreeController) return false;
      // Read BEFORE the view takes focus, or the answer is about the state the
      // steal already produced rather than the state it interrupted. A session
      // named right after it was created is the case this catches: its terminal
      // opened a moment ago and is the active one, so the keyboard goes back to
      // it when the name is committed.
      renameFocusReturnId =
        sessionId !== undefined && isWatchedHere(sessionId)
          ? sessionId
          : undefined;
      // Show the view and give it the KEYBOARD first, and await it: the inline
      // editor is only reachable on a visible view, and an <input> focused
      // inside a webview whose window does not have focus does not receive
      // keystrokes. Both halves of that are why the quick-input fallback used
      // to be the normal path for "Flock: New Session" from the palette —
      // see LineageWebtreeProvider.focusView.
      //
      // Its answer is load-bearing, not advisory. `false` means the page is not
      // listening — a cold boot that outran the wait, or a client script that
      // never ran at all — and postMessage still resolves `true` against such a
      // view, because the host reports DELIVERY, not that anyone subscribed. So
      // without this check beginRename would report success into the void and
      // the create verbs would silently skip naming forever.
      if (!(await webtreeController.focusView())) return false;
      // Then let any queued rebuild land. The create verbs call refresh() and
      // hand straight over to this, and the rebuild they kicked off is what
      // puts the new session's row in the model — `beginRename` refuses a key
      // that is not in the CURRENT rows, so racing it is the difference
      // between naming on the row and falling back to a popup.
      await rebuildTail;
      // Then the row itself: an inline edit needs the row on screen, and F2 can
      // arrive from the palette with no selection at all.
      if (sessionId !== undefined) await webtreeController.revealSession(sessionId);
      return webtreeController.beginRename(sessionId);
    },

    /** The project half of the pair. Same contract, same fallback, and a
     *  separate method because the two id spaces are indistinguishable by
     *  shape — see COMMANDS.renameProjectInline. */
    beginInlineRenameProject: async (projectId) => {
      if (viewStyle() !== 'inline' || !webtreeController) return false;
      // A project row owns no terminal, so there is nothing to hand the
      // keyboard back to and nothing to remember; clearing keeps a stale
      // session id from a previous hand-over out of the next commit.
      renameFocusReturnId = undefined;
      // Same contract as the session half: a view that is up but not listening
      // must fall back to the quick input rather than swallow the rename.
      if (!(await webtreeController.focusView())) return false;
      await webtreeController.revealProject(projectId);
      return webtreeController.beginRenameProject(projectId);
    },

    getRecord: (id) => store.get(id),
    allRecords: () => store.all(),
    upsertRecord: (id, patch) => store.upsert(id, patch),
    recordLaunch: async (childId, parentId, cwd) => {
      // Every create verb calls this BEFORE launching, which is exactly when
      // the optimistic row wants to exist: the record is written, the row
      // appears on the next rebuild, and the naming that follows has something
      // to land on. See notePendingLaunch.
      notePendingLaunch(childId, cwd);
      await store.recordLaunch(childId, parentId, cwd);
    },

    launchSession: async (opts) => {
      // Detach tier: a record still naming a tmux session is a conversation
      // that may be RUNNING, hidden (parked by detach; the user clicked its
      // row instead of switching workspaces). Routing the launch under that
      // name makes the wrap's `new-session -A` attach to it — a plain
      // `--resume` would start a second claude on the same conversation.
      // Only records with a name match (written at park, cleared on restore),
      // so every other launch is untouched.
      let launchOpts = opts;
      let parkedAlias: string | undefined;
      // SAFETY NET. Every verb resolves the account itself — it has to,
      // since only the verb knows whether this is a new conversation (route)
      // or an existing one (pin). This backfills the ONE case a verb can get
      // wrong: a launch for a session that is already pinned, arriving with no
      // environment at all. Injecting the pin here cannot change where a
      // routed launch lands (that one always carries an env, `{}` included),
      // and it means a path that forgets lands on the conversation's own
      // account rather than on whatever the machine is logged in as.
      if (launchOpts.env === undefined && launchOpts.profileId === undefined) {
        const pinned = accountLaunchFor(opts.sessionId);
        if (pinned) {
          log('launch: re-injecting the pinned account for', shortId(opts.sessionId));
          launchOpts = { ...launchOpts, ...pinned };
        }
      }
      if (launchOpts.tmuxName === undefined) {
        for (const id of chainAliases(opts.sessionId)) {
          const recorded = store.get(id)?.tmux;
          if (typeof recorded === 'string' && recorded !== '') {
            parkedAlias = id;
            // Spread `launchOpts`, NOT `opts`: the account backfilled just
            // above must survive this branch. `-A` attaches when the parked
            // wrap is still alive, but falls through to the argv's `--resume`
            // when it died while parked — and that resume without
            // CLAUDE_CONFIG_DIR would look for the conversation in a config
            // directory it was never written to.
            launchOpts = { ...launchOpts, tmuxName: recorded };
            break;
          }
        }
      }
      const binding = await registry.launch(launchOpts);
      // A launch that never started must not leave an optimistic row standing
      // for the whole TTL: the terminal failed loudly, and a row for a session
      // that does not exist is worse than no row.
      if (!binding) {
        pendingLaunches.delete(opts.sessionId);
      } else if (parkedAlias !== undefined) {
        // The record claimed "hidden, maybe running"; the tab now exists, so
        // the claim is settled — the same clear the workspace restore writes.
        void store.upsert(parkedAlias, { parked: false, tmux: null });
      }
      return binding;
    },
    focusSession: (sessionId) => {
      const bound = chainAliases(sessionId).find(
        (id) => registry.binding(id) !== undefined,
      );
      if (!bound) return false;
      const tip = chainIndex.tipOf(sessionId);
      if (store.get(tip)?.parked === true) {
        // A parked session with a LIVE binding here can only be a legacy one:
        // an older build parked by stowing the tab into the terminal panel
        // (today's park closes the terminal, so nothing stays bound). Asking
        // for the session means "bring the tab home", not "open the panel":
        // move it to the editor area and clear the flag — only on success, or
        // a failed move would strand it with nothing to retry.
        // Fire-and-forget: the deps contract is a synchronous boolean.
        void (async () => {
          const moved = await registry.moveToEditor(bound);
          if (moved) await store.upsert(tip, { parked: false });
        })();
        return true;
      }
      return registry.focus(bound);
    },
    renameTerminal: async (sessionId, name) => {
      for (const id of chainAliases(sessionId)) {
        if (await registry.rename(id, name)) return true;
      }
      return false;
    },
    sendTextToSession: (sessionId, text) =>
      chainAliases(sessionId).some((id) => registry.sendText(id, text)),
    // The CLOSE verb means "end this session" — for a wrapped terminal the
    // dispose only detaches, so the kill intent rides along. Workspace
    // parking calls the registry directly, without it.
    closeTerminal: (sessionId) =>
      chainAliases(sessionId).some((id) =>
        registry.closeTerminal(id, { killTmux: true }),
      ),

    focusWindowFor: async (sessionId) => {
      // boundWindowId is view-state and never inherited across a chain, so
      // probe every generation the conversation has worn.
      for (const id of chainAliases(sessionId)) {
        const windowId = store.get(id)?.boundWindowId;
        if (!windowId) continue;
        // getWindows() already drops dead pids and records older than 7 days.
        const rec = store.getWindows().find((w) => w.windowId === windowId);
        if (!rec) continue;
        return focusIntegration.focusWindow(rec, id);
      }
      return false;
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
    setHooksEnabled: async (enabled) => {
      try {
        await cfg().update(
          CONFIG_KEYS.hooksEnabled,
          enabled,
          vscode.ConfigurationTarget.Global,
        );
      } catch (err) {
        // A settings write can fail (read-only profile, sync conflict). The
        // watcher gate is re-evaluated below either way.
        logError('extension.setHooksEnabled', err);
      }
      syncHookWatcher();
    },

    allProjects: () => store.getProjects(),
    getProject: (id) => store.getProject(id),
    // Answered by the view that DREW the chips, not by a fresh grouping:
    // the verb's whole safety argument is that it can only start a session in a
    // directory the user was looking at, and recomputing here would open a
    // window where the answer differs from the row that was clicked. [] when
    // that view has not rendered — which refuses the click, correctly.
    //
    // The INLINE view first, because it is the one that draws chips and
    // therefore the one a click came from. The native tree is asked only when the
    // inline view has nothing to say — which used to be unreachable and no longer
    // is: the worktree verbs are in the command palette, and the native tree's
    // branch rows carry the same context menu, so a verb can now be invoked with
    // the other view style on screen. Falling through on an EMPTY answer rather
    // than on a missing controller, because a view that has not rendered returns
    // [] and not undefined.
    getBranches: (projectId) => {
      const inline = webtreeController?.branchesOf(projectId) ?? [];
      if (inline.length > 0) return inline;
      return treeController?.branchesOf(projectId) ?? [];
    },
    // Writes ONE list and clears the other, which is the whole of the
    // three-state contract on ProjectRecord: "shown" and "hidden" are decisions,
    // and a branch can only carry one of them. Removing it from both would drop
    // it back to the default policy, which is a third thing neither verb means.
    setBranchShown: async (projectId, branch, shown) => {
      const project = store.getProject(projectId);
      if (!project) return;
      const drop = (list: string[] | undefined): string[] =>
        (list ?? []).filter((b) => b !== branch);
      await store.upsertProject(projectId, {
        shownBranches: shown
          ? [...drop(project.shownBranches), branch]
          : drop(project.shownBranches),
        hiddenBranches: shown
          ? drop(project.hiddenBranches)
          : [...drop(project.hiddenBranches), branch],
      });
    },
    setBranchesCollapsed: async (projectId, collapsed) => {
      await store.upsertProject(projectId, { branchesCollapsed: collapsed });
    },

    // THE WORKTREE VERBS. The only wiring in this file behind which the user's
    // repository gets written to, and the reason each of these is a separate
    // member rather than one generic `git()`: a single entry point would make
    // "which git commands can Flock run" a question you answer by reading
    // commands.ts, where four named ones make it a question you answer by reading
    // this block.
    branchStatusOf: (dir) => branchStatus.get(dir),
    worktreePathPattern: () =>
      cfg().get<string>(CONFIG_KEYS.gitWorktreePath, DEFAULT_WORKTREE_PATH_PATTERN) ??
      DEFAULT_WORKTREE_PATH_PATTERN,
    localBranches: (dir) => readLocalBranches(dir),
    addWorktree: (opts) => runWorktreeAdd(opts),
    removeWorktree: (opts) => runWorktreeRemove(opts),
    // Both caches, both wholesale. A worktree that appeared or disappeared
    // changes the LIST for every directory of the repository (any checkout
    // reports the same set), and the per-worktree statuses keyed under it are
    // about a directory that may not exist any more — so waiting out either TTL
    // would leave the tree showing the state before the verb ran.
    worktreesChanged: (dir) => {
      worktrees.invalidate();
      branchStatus.invalidate();
      log('worktree: caches invalidated after a change at', dir);
      refreshViews();
    },
    upsertProject: (id, patch) => store.upsertProject(id, patch),
    // Its own store method rather than an upsert with a `parentId` in it:
    // the cycle check has to run against the whole project set at write time.
    setProjectParent: (id, parentId) => store.setProjectParent(id, parentId),
    deleteProject: (id) => store.deleteProject(id),
    hiddenFolders: () => store.getHiddenFolders(),
    hideFolder: (dir) => store.hideFolder(dir),
    unhideFolder: (dir) => store.unhideFolder(dir),
    staleAfterHours: () =>
      numCfg(CONFIG_KEYS.staleAfterHours, DEFAULT_STALE_AFTER_HOURS),

    // Notifications
    markSeen: (sessionId) => markSeen(sessionId),
    notificationsEnabled: () => notificationsOn(),

    // The live selection, for the verbs a row's context menu cannot hand
    // it (see CommandDeps.selectedSessions). Read through a closure rather than
    // captured, so it is whatever the view last reported and never a snapshot.
    selectedSessions: () => [...selectedSessionIds],

    // Active-only filter. The write is enough to repaint: the config
    // listener at the bottom of activate() rebuilds the forest on any
    // `lineage.*` change, and buildForest reads the flag per build.
    setOnlyActiveSessions: async (on) => {
      try {
        await cfg().update(
          CONFIG_KEYS.onlyActiveSessions,
          on,
          vscode.ConfigurationTarget.Global,
        );
      } catch (err) {
        // A settings write can fail (read-only profile, sync conflict). Say so
        // rather than leaving a title button that silently does nothing.
        logError('extension.setOnlyActiveSessions', err);
        void vscode.window.showWarningMessage(
          'Flock: could not save the session filter — check that settings are writable.',
        );
        return;
      }
      await syncOnlyActiveContext();
    },

    // Project workspaces
    switchWorkspace: (projectId) => workspaceManager.switchTo(projectId),
    activeWorkspace: () => workspaceManager.activeProjectId(),

    // The Explorer follows the project. Both verbs reload the window —
    // converting a plain folder window into a multi-root workspace cannot be
    // done in place — and both are confirmed modally by commands.ts first.
    explorerAnchored: () => explorerSync.anchored(),
    followInExplorer: async () => {
      // What the converted window opens on: the active project's directories
      // when there is one, otherwise the folders this window already has.
      // Converting must never lose the tree the user is looking at.
      const activeId = workspaceManager.activeProjectId();
      const project = activeId ? store.getProject(activeId) : undefined;
      const tail = project
        ? desiredFolders(project, explorerAnchorPath)
        : (vscode.workspace.workspaceFolders ?? []).map((f) => ({
            path: f.uri.fsPath,
            name: f.name,
          }));
      // The anchor is an EMPTY directory Flock owns, and it stays empty: it
      // exists only to hold workspace folder[0] still forever, so that every
      // later splice lands at index >= 1 and never restarts the extension host.
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.file(explorerAnchorPath),
      );
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(explorerWorkspaceFile),
        new TextEncoder().encode(
          workspaceFileJson(explorerAnchorPath, tail, anchorLabelFor(project)),
        ),
      );
      log('explorer: converting this window to', explorerWorkspaceFile);
      await vscode.commands.executeCommand(
        'vscode.openFolder',
        vscode.Uri.file(explorerWorkspaceFile),
        { forceNewWindow: false },
      );
    },
    stopFollowingInExplorer: async () => {
      const activeId = workspaceManager.activeProjectId();
      const project = activeId ? store.getProject(activeId) : undefined;
      // Land on the project's main directory, or failing that on the first
      // root that is not the anchor — the anchor is empty, and reopening the
      // window on it would leave the user staring at nothing.
      const target =
        (project ? projectDirs(project)[0] : undefined) ??
        (vscode.workspace.workspaceFolders ?? [])[1]?.uri.fsPath;
      if (target === undefined) {
        void vscode.window.showWarningMessage(
          'Flock: nothing to reopen — this workspace has no project ' +
            'directory in it. Switch to a project first.',
        );
        return;
      }
      await openProject(target, false);
    },
  };

  context.subscriptions.push(registerCommands(commandDeps));

  // `/fork` ≡ Fork Session. A native `/fork` dispatches a background job
  // instead of opening a tab, so the branch the user just asked for arrives
  // unowned and unopenable. The moment the roster shows one, the window that
  // owns its PARENT adopts it: the job is stopped and the same session id
  // relaunches here as an ordinary fork tab.
  //
  // Ownership is what keeps this single-shot across windows. Every window
  // polls the same rosters, so without a guard they would all race to adopt
  // the same job; `isBoundHere(parent)` is true in exactly one of them — the
  // window the user typed `/fork` in, which is the window the branch belongs
  // in. A fork whose parent is bound nowhere here is left for the click path.
  // Ids this window has taken on, held for the LIFETIME of the window and
  // never cleared on success. The daemon does not reap a killed worker's
  // roster row promptly (verified: the row outlives the process), so the same
  // job keeps arriving tick after tick — and once its tab has been opened and
  // then closed by the user, a second adopt would silently resurrect a session
  // they had just dismissed. Cleared only when an attempt FAILED, so a
  // transient error can be retried.
  const adopting = new Set<string>();
  adoptForkJobs = (jobs) => {
    for (const [childId, job] of jobs) {
      if (job.attached || !job.live || job.parentId === undefined) continue;
      if (adopting.has(childId)) continue;      // taken, or in flight
      if (registry.isBoundHere(childId)) continue; // already ours
      if (!registry.isBoundHere(job.parentId)) continue;
      adopting.add(childId);
      void (async () => {
        let ok = false;
        try {
          ok = await adoptBackgroundJob(commandDeps, childId, job);
          if (ok) {
            log('adopt: /fork adopted', shortId(childId), '— tab opened here');
          }
        } catch (err) {
          logError('extension.adoptForkJobs', err);
        }
        if (!ok) adopting.delete(childId);
      })();
    }
  };

  // ------------------------------------------------------------ 9. poller

  /** App-RESTART re-association: a revived terminal has no LINEAGE_NODE_ID in
   *  creationOptions any more, but its `claude` process still matches a roster
   *  pid. Revived terminals arrive within the first seconds, so this is capped
   *  rather than run forever — it awaits a processId per terminal. */
  let rosterReassociated = false;
  let rosterReassociateAttempts = 0;
  const ROSTER_REASSOCIATE_MAX_ATTEMPTS = 10;

  /**
   * The claude process inside one of OUR terminals is now reporting a
   * DIFFERENT session id at the same pid: a /fork that switched the terminal
   * over, or a plain resume // clear // compaction that re-minted. Re-bind the
   * terminal so every verb keeps finding it, and classify the move — a FORK
   * (daemon dispatch record, or a transcript marker) is a new branch and must
   * NOT be chained; anything else is a re-key, which this path detects without
   * needing the hooks installed.
   */
  const detectPidRekeys = (entries: readonly RosterEntry[]): void => {
    try {
      const liveIds = new Set(entries.map((e) => e.sessionId));
      const byPid = new Map<number, string>();
      for (const e of entries) {
        if (typeof e.pid === 'number' && e.pid > 0 && !byPid.has(e.pid)) {
          byPid.set(e.pid, e.sessionId);
        }
      }
      for (const binding of registry.bindings()) {
        const pid = binding.pid;
        if (typeof pid !== 'number' || pid <= 0) continue;
        if (liveIds.has(binding.sessionId)) continue; // still current
        const nowId = byPid.get(pid);
        if (!nowId || nowId === binding.sessionId) continue;
        if (!registry.rebind(binding.sessionId, nowId)) continue;
        // rebind() emits onDidBind, which stamps boundWindowId for the new id.
        resolver.invalidate(nowId);
        const facts = daemonReader.read();
        let isFork = facts.forkParents.has(nowId);
        if (!isFork) {
          try {
            isFork = forkParentFromTranscript(nowId, { deep: false }) !== null;
          } catch (err) {
            logError('extension.rekeyClassify', err);
          }
        }
        if (isFork) {
          log(
            'roster: terminal re-keyed by /fork —',
            shortId(binding.sessionId),
            '->',
            shortId(nowId),
          );
        } else {
          log(
            'roster: terminal re-keyed —',
            shortId(binding.sessionId),
            '->',
            shortId(nowId),
            '(chained)',
          );
          void store.appendChainMember(binding.sessionId, nowId);
        }
      }
    } catch (err) {
      logError('extension.detectPidRekeys', err);
    }
  };

  const onResult = (r: RosterResult): void => {
    if (!r.ok) {
      // Keep the last good forest — the tree must not flash empty because the
      // CLI was briefly unavailable.
      log('roster: fetch failed —', r.error ?? 'unknown error');
      return;
    }

    detectPidRekeys(r.entries);

    const changed =
      !haveRoster || editorialDirty || !sameRoster(lastEntries, r.entries);
    lastEntries = r.entries;
    haveRoster = true;

    if (
      !rosterReassociated &&
      rosterReassociateAttempts < ROSTER_REASSOCIATE_MAX_ATTEMPTS
    ) {
      rosterReassociateAttempts++;
      // Two additive sources, tried together: roster pids identify revived
      // BARE terminals (claude is the terminal process), tmux clients
      // identify revived WRAPPED ones (the terminal process is a tmux
      // client, whose pid the roster never carries — see queryClientSessions).
      void Promise.all([
        registry.reassociateFromRoster(r.entries),
        registry.reassociateFromTmux(),
      ])
        .then(([byPid, byTmux]) => {
          if (byPid + byTmux > 0) {
            rosterReassociated = true;
            log(
              'roster: re-associated',
              String(byPid + byTmux),
              `terminal(s) (${byPid} by pid, ${byTmux} by tmux client)`,
            );
          }
        })
        .catch((err: unknown) => {
          logError('extension.reassociate', err);
        });
    }

    try {
      hooksManager.noteRosterActivity(r.entries.length);
    } catch (err) {
      logError('extension.noteRosterActivity', err);
    }

    // Keep this window's published focus handle from ageing past
    // WINDOW_TTL_MS. It is only ever written at activation, and once it
    // expires any other window's next publish deletes the record AND nulls
    // boundWindowId on every session bound here. Self-throttled to hours.
    void focusIntegration.refreshPublication();

    if (!changed) return;
    void scheduleRebuild(r.entries);
  };

  // Phantom rows (dead pids, `claude bg-spare` warm-spares) are dropped
  // BETWEEN the fetch and onResult, so nothing downstream — change detection,
  // lineage resolution, the archive's liveIds set — ever learns they existed.
  // The filter never rejects and never throws; a bad pass returns the roster
  // untouched, which is exactly the pre-filter behaviour.
  // The filter also corrects a frozen `busy`: an interactive session whose turn
  // ended but whose roster status the CLI never flipped back. The transcript
  // mtime is the hook-free freshness signal (wired here because roster.ts may
  // not import ./transcript), and the window is read fresh each pass so a
  // config change lands on the next tick.
  const rosterFilter = new RosterFilter({
    transcriptMtime: (sessionId) => transcriptMtimeMs(sessionId),
    busyStaleMs: () =>
      numCfg(CONFIG_KEYS.busyStaleMinutes, DEFAULT_BUSY_STALE_MINUTES) * 60_000,
  });
  const fetchFiltered = async (): Promise<RosterResult> => {
    // The agents registry is per config dir, so the roster asks every
    // account profile's dir and merges — otherwise a session on a custom
    // account is invisible to the poll and vanishes from the tree.
    const result = await fetchRosterMulti({
      claudeBin: claudeBin() ?? 'claude',
      configDirs: claudeProfileConfigDirs(),
    });
    if (!result.ok) return result;
    if (boolCfg(CONFIG_KEYS.showPhantomRows, false)) return result;
    return { ...result, entries: await rosterFilter.apply(result.entries) };
  };

  poller = new RosterPoller(
    fetchFiltered,
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
      // Same reasoning for phantom rows, and it needs more than a rebuild:
      // `lastEntries` has ALREADY had them removed, so only a fresh fetch can
      // bring them back. The busy-stale window is corrected in the same filter
      // pass, so `lastEntries` is likewise already destaled — a fresh fetch is
      // what re-applies the new window.
      if (
        e.affectsConfiguration(
          `${CONFIG_SECTION}.${CONFIG_KEYS.showPhantomRows}`,
        ) ||
        e.affectsConfiguration(
          `${CONFIG_SECTION}.${CONFIG_KEYS.busyStaleMinutes}`,
        )
      ) {
        pokeNow();
      }
      // The status bar's visibility is config-gated.
      if (
        e.affectsConfiguration(
          `${CONFIG_SECTION}.${CONFIG_KEYS.workspacesEnabled}`,
        )
      ) {
        updateWorkspaceStatusBar();
      }
      // The accounts view is contributed under a `config.` when-clause, so
      // turning the setting on reveals a view whose provider does not exist yet
      // — the workbench then renders "no data provider registered" until a
      // reload. Registering it here on the way up closes that gap. There is no
      // way down: a TreeView cannot be un-registered without leaking the old
      // one, and the when-clause has already hidden it, so turning the setting
      // off simply leaves an invisible provider that nothing ever resolves.
      if (
        e.affectsConfiguration(
          `${CONFIG_SECTION}.${CONFIG_KEYS.accountsEnabled}`,
        ) &&
        accountsViewController === undefined &&
        boolCfg(CONFIG_KEYS.accountsEnabled, true)
      ) {
        try {
          accountsViewController = registerAccountsView(accountDeps);
          context.subscriptions.push(accountsViewController);
        } catch (err) {
          logError('extension.registerAccountsView', err);
        }
      }
      // The filter can also be flipped from settings.json, and the title button
      // is a picture of the setting — it has to follow either way in.
      void syncOnlyActiveContext();
      // showGhosts, onlyActiveSessions and notifications.enabled are read per
      // buildForest, groupByFolder per getChildren — a rebuild covers them all.
      if (haveRoster) void scheduleRebuild(lastEntries);
      else refreshViews();
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
