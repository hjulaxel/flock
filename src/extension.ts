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
import * as fs from 'node:fs/promises';

import {
  listPidFacts,
  orphanRescueDecision,
  reapSurvivors,
  type PersistedPidFact,
} from './procs';

import {
  ARCHIVE_RESCAN_MIN_MS,
  COMMANDS,
  BRANCH_FEATURE_SWITCHES,
  DEFAULT_BRANCH_DISPLAY,
  isBranchDisplay,
  BRANCH_ROWS_PARKED_AT_SCHEMA,
  CONFIG_KEYS,
  CONFIG_SECTION,
  CONTEXT_HAS_FORKABLE,
  CONTEXT_HAS_UNSEEN,
  CONTEXT_EXPLORER_FOLLOW,
  CONTEXT_HOOKS_INSTALLED,
  CONTEXT_CAN_HAND_OFF,
  CONTEXT_CAN_SWITCH_ACCOUNT,
  CONTEXT_MODE,
  CONTEXT_NATIVE_TREE,
  CONTEXT_MULTI_SELECT,
  CONTEXT_ONLY_ACTIVE,
  DEFAULT_BUSY_STALE_MINUTES,
  DEFAULT_CHAT_AUTO_CLOSE_MINUTES,
  DEFAULT_SESSION_CLOSE_AFTER_MINUTES,
  DEFAULT_CLOSE_SUMMARY_MODE,
  DEFAULT_PROVIDER,
  DEFAULT_SESSION_SWITCHING,
  ENV_NODE_ID,
  EXTENSION_ID,
  LEGACY_KEYS,
  isCloseSummaryMode,
  isProviderId,
  isSessionId,
  isSessionSwitching,
  isTerminalLocationPref,
  shortId,
} from './types';
import type {
  AccountProfile,
  ArchivedSession,
  BackgroundJob,
  BranchDisplay,
  DecorationDeps,
  EditorialRecord,
  HookEvent,
  LaunchOptions,
  ProjectRecord,
  ProviderId,
  RosterEntry,
  RosterResult,
  SessionForest,
  SessionSwitching,
  SubprojectRecord,
  TerminalLocationPref,
  TmuxSpawn,
  TranscriptFacts,
  TranscriptHeaderMeta,
  TreeDeps,
  WrapState,
} from './types';
import {
  type TmuxAdvice,
  ensureTmuxConf,
  findTmuxBinary,
  killTmuxSessionTree,
  listTmuxSessions,
  queryClientSessions,
  queryPanePid,
  queryWrapState,
  resolveExitShell,
  resolveTmuxSpawn,
  respawnTmuxPane,
  sessionIdOfTmuxName,
  tmuxAdvice,
  tmuxInstallHint,
} from './tmux';
import {
  type ProjectMatch,
  matchProject,
  matchProjects,
  preferredClaimant,
  normalizeDir,
  pathKey,
  projectDirs,
  projectReach,
  providerOfProject,
  resolveUnclaimed,
  unclaimedFlags,
  validateProjectName,
} from './projects';
import {
  type LineageMode,
  explorerFollowOn,
  folderScoped,
  followsTheSession,
  outsideScope,
  projectSwitchingOn,
  resolveMode,
  windowForDir,
} from './modes';
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
  codexSessionsDir,
  findCodexBinary,
  matchRollout,
  scanRollouts,
} from './codex';
import { CODEX_HOME_ENV } from './accounts';

/** Codex id discovery (see adoptCodexSession): how often to look for the
 *  rollout a launch produced, and how long to keep looking. The CLI opens its
 *  rollout within a second of starting, so this is generous by an order of
 *  magnitude — the cost of waiting is one late re-key, and the cost of giving
 *  up early is a row stuck on an id nothing else will ever mention. */
const CODEX_ADOPT_POLL_MS = 400;
const CODEX_ADOPT_WINDOW_MS = 30_000;
import {
  forkParentFromTranscript,
  hasTranscript,
  readTranscriptHeader,
  transcriptFile,
  transcriptMtimeMs,
} from './transcript';
import { repairResumeLeaf } from './resumeLeaf';
import {
  TOUCH_COALESCE_MS,
  idleCloseDecisions,
  lastEngagementMs,
  reconcileTmuxDecisions,
} from './idleClose';
import type { ReconcileRecordFacts, SessionCloseFacts } from './idleClose';
import { LineageResolver, buildForest, resolveAll } from './lineage';
import type { ResolveOptions } from './lineage';
import {
  ArchiveIndexer,
  archivedAsEntries,
  keptArchived,
  memberKeepIds,
  unlistedPool,
} from './archive';
import {
  buildChainIndex,
  collapseChains,
  dropForkContinuations,
  emptyChainIndex,
} from './generations';
import type { ChainIndex } from './generations';
import {
  DaemonRosterReader,
  daemonRosterPathFor,
  defaultDaemonRosterPath,
  describeForkEdge,
} from './daemon';
import { BranchListCache } from './branchList';
import {
  recommendedNotice,
  surfaceChoices,
  surfaceOffer,
  windowModelChoices,
} from './recommend';
import type { ContextualOfferId } from './recommend';
import { chatAutoCloseVictims } from './chatAutoClose';
import { frontSession, mayFollowSelection } from './switcher';
import { type WhereAmI, whereAmI } from './whereami';
import { registerShellsView } from './shellsView';
import type { ShellSessionInfo } from './shellsView';
import { CompactionTracker } from './compaction';
import { planDeepReveal } from './deepSwitch';
import { WorktreeCache, branchRowsAdvice } from './git';
import { BranchStatusCache } from './gitBranches';
import {
  PullRequestCache,
  openPullRequestCreatePage,
  readRemoteUrl,
} from './pullRequests';
import {
  DEFAULT_WORKTREE_PATH_PATTERN,
  readAheadCount,
  readLocalBranches,
  runBranchDelete,
  runWorktreeAdd,
  runWorktreeRemove,
} from './worktrees';
import type { GenerationFacts } from './generations';
import {
  SUMMARY_TAIL_MAX_BYTES,
  TranscriptStatsCache,
  readFirstPrompt,
  readTailStats,
  readTranscriptTail,
} from './usage';
import type { TranscriptStats } from './usage';
// Close with Summary's read half: the pure parser that says which record in a
// transcript is the compaction summary Flock just asked for. The wiring below
// owns the locating, the chain walk and the polling; the module owns what
// counts as an answer.
import { parseCompactSummary } from './closeSummary';
import { WorkspaceManager } from './workspaces';
import {
  ANCHOR_DIR_NAME,
  ExplorerSync,
  WORKSPACE_FILE_NAME,
  anchorLabelFor,
  desiredFolders,
  nonAnchorFolders,
  withAnchorName,
  workspaceFileJson,
} from './explorer';
import type { ExplorerScope } from './explorer';
import { planFollow } from './follow';
import { SourceControlSync } from './sourceControl';
import type { GitHost } from './sourceControl';
import { registerProjectView } from './projectview';
import type { ProjectViewController } from './projectview';
// Accounts. The pure halves (accounts.ts / routing.ts) are imported here
// because this file is where the account roster, the pins and the launch env
// are joined up — the views and the verbs only ever see the interfaces.
import {
  accountEnvKeys,
  accountsSectionDrawn,
  canHandOff,
  canSwitchAccounts,
  configDirForProfile,
  envForProfile,
  offerSwitch,
  profileConfigDirFor,
  restoreEnvFor,
  seedDefaultProfiles,
  switchMovesNothing,
} from './accounts';
// The byte half of an account switch: a conversation's transcript is portable
// between config directories, and this is what moves it. Pure filesystem work,
// no vscode — see the module header for why the move is a rename.
import {
  moveConversation,
  setAsideTranscript,
  sourceDirFor,
  transcriptCopyInConfigDir,
} from './accountMove';
import { pinnedLaunchProfile, pinnedProfile, rankUsage } from './routing';
import { delegateFor, hostOfChain, resolveLaunchMode } from './hosts';
import type { SessionHost } from './hosts';
import { ensureProfileConfig } from './profileConfig';
import type { ProfileConfigSources } from './profileConfig';
import { AccountUsageCache, registerAccountsView } from './accountsView';
import type {
  AccountDeps,
  AccountsViewController,
  SwitchAccountRequest,
  SwitchAccountResult,
  SwitchRunningState,
} from './accountsView';
import { LimitsService, formatUsageSummary } from './limits';
import { StateStore } from './state';
import { registerDecorations } from './decorations';
// One pure function, for the project roll-up dot: the native tree's dot and
// the inline sidebar's must answer the same question, and statusTone is where
// that question is defined. See projectsWithUnseen below.
import { statusTone } from './viewmodel';
import { registerTree } from './tree';
import type { TreeController } from './tree';
import { registerWebtree } from './webtree';
import type { WebtreeController } from './webtree';
// The two pure builders the account switch needs to compose a resume by hand:
// every other launch in this file goes through `registry.launch`, but a tmux
// respawn replaces the pane's command directly and therefore has to spell the
// argv and the environment the same way the launcher would.
import { TerminalRegistry, buildShellArgs, launchEnv } from './terminals';
import { TerminalMatcher, terminalPid } from './terminalMatch';
import {
  adoptBackgroundJob,
  defaultSessionTitle,
  forkForAgent,
  hasForkableRow,
  notificationItems,
  registerCommands,
  tabTitleFrom,
} from './commands';
import type { AccountCommandDeps } from './commands';
// The dispatch queue's clockwork: decides (via src/dispatch.ts) when a queued
// session is worth launching and wakes at the moments that can change the
// answer. Node-only; this file hands it the store, the usage cache and the
// same launch path every clicked verb takes.
import { DispatchHost } from './dispatchHost';
import { registerFocusIntegration } from './windows';
import { openProject } from './surfaces';
import { HooksManager } from './hooks';
import { STATE_FILE_NAME, resolveStateDir } from './stateHome';
import { AgentVerbsManager } from './agentVerbs';

/** How often the roster is polled. A constant, not a setting: with the hooks
 *  installed the poll is a fallback, and without them three seconds is the
 *  tempo the tree was designed around — a knob here could only make the tree
 *  slower or the CLI busier, so it was a knob nobody should turn. */
const DEFAULT_POLL_INTERVAL_MS = 3000;
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
/** globalState, same reasoning as TMUX_NOTICE_KEY: a per-install "already
 *  asked" with nothing to merge across windows. */
const BRANCH_ROWS_NOTICE_KEY = 'lineage.branchRowsNoticeShown';
/** globalState, same reasoning again: the recommended setup is offered once per
 *  install, and answering it — either way — is the end of it. */
const RECOMMENDED_NOTICE_KEY = 'lineage.recommendedNoticeShown';
/** globalState once more: the walkthrough front door is decided once per
 *  install — opened or judged unnecessary — and either verdict is final. */
const WALKTHROUGH_KEY = 'lineage.walkthroughOpened';
/** globalState, one key per contextual offer (`ContextualOfferId`): the
 *  window-model question, asked the first time a folder-model window routes
 *  another project's session away, and the surface question, asked when a
 *  window's second session tab opens. Each is set by an answer — the offer's
 *  buttons, or the picker behind it being answered from anywhere — never by
 *  the X, and never on activation or a timer. */
const OFFER_KEYS: Record<ContextualOfferId, string> = {
  windowModel: 'lineage.windowModelOfferAnswered',
  surface: 'lineage.surfaceOfferAnswered',
};
/** What `workbench.action.openWalkthrough` takes: publisher.name#walkthroughId.
 *  The id half is `EXTENSION_ID`, which a test holds equal to the manifest;
 *  the fragment is the walkthrough's `id` in package.json. A walkthrough
 *  contribution has no command id of its own, so this string is the only
 *  address it has. */
const WALKTHROUGH_REF = `${EXTENSION_ID}#flockGettingStarted`;
/** Ahead of every toast, and short: the walkthrough is a PAGE, not a
 *  notification, and on the only install it fires for the editor area is
 *  empty anyway — there is nothing to wait for and nothing to cover up. */
const WALKTHROUGH_DELAY_MS = 2_500;
/** AHEAD of the tmux notice, which is the point: this fires only on a window
 *  with no projects at all, and on that window it is the more useful of the two
 *  — it names tmux itself, among everything else. Whichever fires suppresses
 *  the other for this session (see `recommendedNoticeOffered`), because two
 *  stacked toasts on somebody's first launch is a first impression worth
 *  avoiding. */
const RECOMMENDED_NOTICE_DELAY_MS = 8_000;
/** Staggered well behind the tmux notice. Both are once-per-install and rarely
 *  both apply, but an upgrade onto a machine without tmux is exactly when they
 *  would collide, and two stacked warnings read as something being wrong. */
const BRANCH_ROWS_NOTICE_DELAY_MS = 30_000;
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
  /** `lineage.unclaimedSessions`, with the two booleans it replaced still read
   *  where they are all somebody has set (projects.resolveUnclaimed), and split
   *  back into the two flags the grouping code has always taken. Re-read per
   *  call like every setting here; the configuration listener's rebuild is
   *  what makes a flip show. */
  const unclaimed = (): ReturnType<typeof unclaimedFlags> =>
    unclaimedFlags(
      resolveUnclaimed(
        cfg().get<string>(CONFIG_KEYS.unclaimedSessions),
        cfg().get<unknown>(LEGACY_KEYS.groupByFolder),
        cfg().get<unknown>(LEGACY_KEYS.onlyProjectSessions),
      ),
    );
  /** The detach grace window (minutes). Not numCfg: 0 is a real value here —
   *  "no grace, the sweep kills on its next tick" — not an unset. Shared by
   *  the workspace switch's detach tier and the window-close stamp below. */
  const detachGraceMinutes = (): number => {
    const v = cfg().get<number>(CONFIG_KEYS.sessionDetachGraceMinutes);
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 10;
  };
  /** The reload-detection window, in seconds — see
   *  CONFIG_KEYS.sessionReloadGraceSeconds for why window close measures
   *  rather than kills. Clamped to a minute: anything longer stops being a
   *  measurement and becomes an unwatched process. */
  const reloadGraceSeconds = (): number => {
    const v = cfg().get<number>(CONFIG_KEYS.sessionReloadGraceSeconds);
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 45;
    return Math.min(v, 60);
  };
  /** WHICH OF THE THREE WINDOW MODELS this window is in, resolved
   *  (src/modes.ts) — the mode string, the legacy `lineage.workspaces.enabled`
   *  and the retired `lineage.workspaces.autoSwitch` folded into one value
   *  here, so no surface downstream can compute the model differently from
   *  another. The single reader of both old keys.
   *
   *  Re-read on every call like every other setting here, and safely: the
   *  configuration listener below already fires on all three keys and already
   *  calls `syncModeContext()` unconditionally, so a change to any one repaints
   *  the when-clause key, the status bar and the forest with no reload. */
  const lineageMode = (): LineageMode =>
    resolveMode(
      cfg().get<string>(CONFIG_KEYS.mode),
      boolCfg(CONFIG_KEYS.workspacesEnabled, true),
      cfg().get<boolean>(LEGACY_KEYS.workspacesAutoSwitch),
    );

  /** The Flock anchor's path (src/explorer.ts owns its identity): the empty
   *  globalStorage directory a converted explorer-follow window carries at
   *  folder[0] so splices never restart the extension host. Needed up here —
   *  long before the Explorer wiring — because BOTH windows this extension
   *  publishes about itself (the folder-mode scope below, the WindowRecord
   *  folders) must exclude it: it is Flock's plumbing, not a folder the user
   *  opened. */
  const anchorPath = path.join(
    context.globalStorageUri.fsPath,
    ANCHOR_DIR_NAME,
  );

  /** The REAL workspace folders — everything the user opened, the anchor
   *  filtered out. The one list both the folder-mode fence and the published
   *  WindowRecord read, so what this window scopes to and what other windows
   *  route to it can never be two different sets of directories. */
  const realWorkspaceFolders = (): string[] =>
    nonAnchorFolders(
      anchorPath,
      (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    );

  /** FOLDER MODE's fence: every real folder this window opened, or undefined
   *  when nothing is fenced. The UNION of all real roots, never folder[0]
   *  alone: a converted explorer-follow window keeps the anchor at index 0 (an
   *  empty directory no session runs under — scoping to it rendered zero
   *  sessions), and an ordinary multi-root window opened every one of its
   *  folders on purpose.
   *
   *  Undefined for the other two models, and for two different reasons worth
   *  keeping apart. `flock` does not fence ON PURPOSE — "we just have the root,
   *  where we only see Flock" means the sidebar holds everything, and a fence
   *  would be the one thing that model is defined by not having. `project`
   *  cannot fence: its roots change under it on every focus change, so a fence
   *  derived from them would be a claim that expires between two clicks.
   *
   *  A folder-mode window with no real folder returns undefined too, which is
   *  why the default is not wrong for somebody who opened no folder: they
   *  already have the Flock-only behaviour, they simply do not have its
   *  name. */
  const scopeFolders = (): string[] | undefined => {
    if (!folderScoped(lineageMode())) return undefined;
    const real = realWorkspaceFolders();
    return real.length > 0 ? real : undefined;
  };

  /** Mirror the RESOLVED mode into the when-clause key (see CONTEXT_MODE for
   *  why the manifest cannot read the setting directly). At activation and on
   *  every configuration change. */
  const syncModeContext = async (): Promise<void> => {
    try {
      await vscode.commands.executeCommand(
        'setContext',
        CONTEXT_MODE,
        lineageMode(),
      );
    } catch (err) {
      logError('extension.modeContext', err);
    }
  };
  void syncModeContext();

  // Re-read on every call so a settings change takes effect without rebuilding
  // the poller or the terminal registry.
  const claudeBin = (): string | null =>
    findClaudeBinary(cfg().get<string>(CONFIG_KEYS.claudeBinary));
  const codexBin = (): string | null =>
    findCodexBinary(cfg().get<string>(CONFIG_KEYS.codexBinary));

  const terminalLocation = (): TerminalLocationPref => {
    const v = cfg().get<string>(CONFIG_KEYS.terminalLocation);
    return isTerminalLocationPref(v) ? v : 'editor';
  };

  /** How much of the project the Explorer shows. Defaults to `'directory'` —
   *  ONE root, the one being worked in — which is the product default; the
   *  explorer module itself defaults to `'project'` so a wiring without this
   *  reader behaves as it did before the setting existed. */
  const explorerScope = (): ExplorerScope => {
    const v = cfg().get<string>(CONFIG_KEYS.explorerScope);
    return v === 'project' || v === 'directory' ? v : 'directory';
  };

  // Detach tier (src/tmux.ts): wrap Flock-launched sessions in the private
  // tmux server so a workspace switch can hide a session's tab while the
  // conversation keeps running. The conf is written once per activation; the
  // binary and the `lineage.tmux` gate are re-probed per launch, so
  // installing tmux (or flipping the setting) needs no reload. Null — off,
  // no tmux, Windows — means the kill+resume tier, which stays fully wired.
  //
  // `lineage.exitToShell` rides in the conf: it is three hook lines, not a
  // launch flag. The conf is read at SERVER start only, so a flip applies to
  // the next server — which in practice means once every wrapped session has
  // ended. Rewritten on the config change below rather than only here, so the
  // file on disk always says what the setting says.
  const exitShell = (): string | null =>
    cfg().get<boolean>(CONFIG_KEYS.exitToShell) === false
      ? null
      : resolveExitShell(process.env['SHELL'], process.platform);
  let tmuxConfPath = ensureTmuxConf(
    context.globalStorageUri.fsPath,
    exitShell(),
  );
  const rewriteTmuxConf = (): void => {
    tmuxConfPath = ensureTmuxConf(context.globalStorageUri.fsPath, exitShell());
  };
  const tmuxSpawn = (): TmuxSpawn | null =>
    resolveTmuxSpawn(cfg().get<string>(CONFIG_KEYS.tmux), tmuxConfPath);

  // One-time nudges about the detach tier. The decision is `tmuxAdvice` in
  // src/tmux.ts, pure and tested; this only supplies the world and acts on the
  // answer. TWO moments, one per verdict:
  //
  //   * 'enable' — tmux is here and switched off by hand — is said once, a few
  //     seconds after activation, deferred off the activation path because it
  //     is advice and nothing about startup should wait on a toast.
  //   * 'install' — no tmux at all — is said at the first PROJECT SWITCH
  //     attempted without it (`noteMissingTmux`, run by the verb and by the
  //     auto-switch alike), which is the moment the missing tier costs
  //     something: the switch about to happen closes the other project's
  //     sessions instead of hiding them. Said at activation it was a warning
  //     about a feature the person might never use; the Status verb carries
  //     the fact permanently, install line included, for the time in between.
  //
  // One dismissal key for both: "Don't remind me" about tmux is one answer,
  // whichever sentence it was given to.
  const tmuxNoticeShown = (): boolean =>
    context.globalState.get<boolean>(TMUX_NOTICE_KEY) === true;
  const suppressTmuxNotice = (): void => {
    void context.globalState.update(TMUX_NOTICE_KEY, true);
  };
  const tmuxVerdict = (): TmuxAdvice =>
    tmuxAdvice({
      platform: process.platform,
      mode: cfg().get<string>(CONFIG_KEYS.tmux),
      binary: findTmuxBinary(),
      dismissed: tmuxNoticeShown(),
    });
  const NEVER_REMIND = "Don't remind me";
  const noteMissingTmux = (): void => {
    try {
      if (tmuxVerdict() !== 'install') return;
    } catch (err) {
      logError('tmux.notice', err);
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
        NEVER_REMIND,
      )
      .then((choice) => {
        if (choice === HOW) {
          void vscode.env.openExternal(vscode.Uri.parse(TMUX_INSTALL_URL));
          suppressTmuxNotice();
        } else if (choice === NEVER_REMIND) {
          suppressTmuxNotice();
        }
      });
  };
  /** Set by the recommended-setup notice, four seconds earlier, when it speaks.
   *  Not persisted and not a dismissal: it silences the tmux notice for THIS
   *  session only, so a window that met the setup offer does not also get a
   *  warning the offer already covers. Next launch asks again if it still
   *  applies. */
  let recommendedNoticeOffered = false;
  setTimeout(() => {
    if (recommendedNoticeOffered) return;
    let advice: TmuxAdvice;
    try {
      advice = tmuxVerdict();
    } catch (err) {
      logError('tmux.notice', err);
      return;
    }
    // 'install' is not this timer's to say — see noteMissingTmux above.
    if (advice !== 'enable') return;

    const TURN_ON = 'Turn it on';
    void vscode.window
      .showWarningMessage(
        'Flock needs tmux to keep sessions running while you work elsewhere. ' +
          'You have tmux, but it is switched off, so switching projects ' +
          'closes the other project’s sessions instead of hiding them.',
        TURN_ON,
        NEVER_REMIND,
      )
      .then((choice) => {
        if (choice === TURN_ON) {
          void cfg().update(CONFIG_KEYS.tmux, 'auto', vscode.ConfigurationTarget.Global);
          suppressTmuxNotice();
        } else if (choice === NEVER_REMIND) {
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

  // `~/.lineage/state`, NOT globalStorage — one store per machine, because
  // everything in it (the tmux server, the roster, the transcripts, the
  // checkouts) is one per machine. globalStorage is per editor APPLICATION,
  // so the same install seen from Cursor and from VS Code used to be two
  // flocks that could not see each other, and the second one's activation
  // reaper killed the first one's sessions. src/stateHome.ts carries the
  // whole argument and the one-time adoption of the old per-app file.
  const stateHome = resolveStateDir({
    legacyDir: context.globalStorageUri.fsPath,
    homeDir: os.homedir(),
  });
  if (stateHome.status === 'failed') {
    log(
      'state: could not reach the shared store — staying on this ' +
        `application's own copy at ${context.globalStorageUri.fsPath}`,
    );
  }
  const store = new StateStore(stateHome.dir);
  context.subscriptions.push(store);
  await store.load();

  // Cross-window sync — and, now that the file is shared, cross-APPLICATION
  // sync on the same mechanism. A simple non-recursive pattern with a
  // RelativePattern base is what makes watching outside the workspace work.
  // reloadFromDisk() coalesces a burst itself and stays silent on a
  // byte-identical re-read, so the echo of our own write never causes a
  // double refresh.
  try {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        vscode.Uri.file(stateHome.dir),
        STATE_FILE_NAME,
      ),
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

  /**
   * Which conversations are mid-compaction, and which have just finished one.
   * The purple ring and the purple dot — see src/compaction.ts for the rules
   * and for why compaction needed a mark of its own at all.
   *
   * IN MEMORY, never on disk. A compaction phase is a fact about a running
   * process that lasts minutes; an editorial record outlives the process by
   * design, so a phase written there would be a stale ring on a row whose
   * session ended last Tuesday.
   *
   * Fed from four places, all of them below: the PreCompact hook (in), the
   * SessionStart-`compact` and Stop hooks and the roster's own busy→quiet
   * transition (out), and UserPromptSubmit plus the quiet→busy transition
   * (something is behind it now, so the dot clears). Every read and clear goes
   * through `chainAliases`, because a compaction re-mints the session id and
   * the two ends of one compaction therefore arrive under different ones.
   */
  const compaction = new CompactionTracker();

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

  // -------------------------------------------------- delegated launches
  //
  // `lineage.launch.mode`. When the user has asked for it, the `+` runs another
  // extension's "new conversation" command instead of opening a terminal here —
  // and then has to find the session again, because a delegate mints its own
  // session id and tells nobody.
  //
  // THE BIND-BACK. Flock's own launches pre-mint the id, which is what makes
  // their lineage exact by construction; there is no such handle here, so the
  // only way back to a tree row is the roster. One claim is held, and the FIRST
  // new row that matches it is adopted. The safety is all in "matches":
  //
  //   * the id was not on the roster when the delegate was asked;
  //   * it has no editorial record, so a session another Flock window launched
  //     (records are shared through state.json) can never be claimed;
  //   * its cwd is the one we asked the delegate to open, when we know it;
  //   * and there is EXACTLY ONE such row. Two sessions appearing together
  //     drops the claim rather than picking one — a wrong claim would put
  //     somebody else's conversation under the name and project this click
  //     meant, and the cost of dropping it is a row that is merely unnamed.
  //
  // The adopted record deliberately does NOT carry `launchedByUs`. Flock did not
  // launch that process and cannot end it, so claiming ownership would put Close
  // back on a row where it can only write a timestamp — the exact lie hosts.ts
  // exists to remove. What the record does carry is the cwd and the name, which
  // is what files the row under its project and labels it.

  /** How long a claim waits for its session to appear. Generous: the delegate
   *  may show a sign-in prompt, download a CLI update, or sit on an empty input
   *  until the user types. Bounded so a conversation the user opened an hour
   *  later is never mistaken for this one. */
  const DELEGATED_CLAIM_TTL_MS = 120_000;

  interface DelegatedClaim {
    at: number;
    cwd?: string;
    title?: string;
    /** Session ids already on the roster when the delegate was asked. */
    before: ReadonlySet<string>;
  }
  let delegatedClaim: DelegatedClaim | null = null;
  /** The "your delegate is not installed" note is said once per window, not once
   *  per click: a `+` that toasts every time is a `+` nobody presses twice. */
  let delegateFallbackTold = false;

  const settleDelegatedClaim = (entries: readonly RosterEntry[]): void => {
    const claim = delegatedClaim;
    if (claim === null) return;
    if (Date.now() - claim.at > DELEGATED_CLAIM_TTL_MS) {
      delegatedClaim = null;
      log('launch: delegated session never appeared on the roster — claim dropped');
      return;
    }
    const wantCwd =
      claim.cwd === undefined ? undefined : normalizeDir(claim.cwd);
    const candidates = entries.filter((e) => {
      if (claim.before.has(e.sessionId)) return false;
      if (store.get(e.sessionId) !== undefined) return false;
      if (wantCwd === undefined) return true;
      return e.cwd !== undefined && normalizeDir(e.cwd) === wantCwd;
    });
    if (candidates.length === 0) return; // keep waiting
    delegatedClaim = null;
    if (candidates.length > 1) {
      log(
        'launch: several new sessions appeared at once — delegated claim dropped',
        'rather than guessing which one the click made',
      );
      return;
    }
    const adopted = candidates[0] as RosterEntry;
    void store.upsert(adopted.sessionId, {
      ...(claim.cwd === undefined ? {} : { cwd: claim.cwd }),
      ...(claim.title === undefined ? {} : { title: claim.title }),
    });
    log('launch: adopted delegated session', shortId(adopted.sessionId));
    void revealSession(adopted.sessionId);
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
      // And the graves. Removing an account does not remove the conversations
      // that were moved onto it, and this is a READ path — every consumer of
      // this list is looking for a transcript, never for somewhere to launch.
      // Without them a removal made every such conversation look like it had
      // never taken a turn. See state.retiredClaudeConfigDirs.
      for (const dir of store.retiredClaudeConfigDirs()) {
        if (!out.includes(dir)) out.push(dir);
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
   * Every Codex session store to index: the machine's own `~/.codex/sessions`
   * plus one per Codex account that has its own `CODEX_HOME`.
   *
   * The default root is ALWAYS included, even when every account relocates its
   * own — it is where a Codex session started outside Flock lands, and those
   * are exactly the rows the history index exists to rescue.
   */
  const codexSessionsDirs = (): string[] => {
    const out = [codexSessionsDir()];
    try {
      for (const profile of store.getAccounts()) {
        if (profile.provider !== 'codex') continue;
        const dir =
          typeof profile.configDir === 'string' ? profile.configDir.trim() : '';
        if (dir !== '') out.push(codexSessionsDir(dir));
      }
    } catch (err) {
      logError('extension.codexSessionsDirs', err);
    }
    return out;
  };

  /**
   * The Codex half of the history index.
   *
   * archive.ts indexes `~/.claude/projects/**\/<id>.jsonl` and cannot be
   * pointed at a Codex store: the layout is a `YYYY/MM/DD` tree, the id is in
   * the FILENAME rather than in the records, and the first line is a
   * `session_meta` blob tens of kilobytes long that no Claude-shaped head
   * parser will read. So the walk lives in codex.ts and the result is
   * translated to `ArchivedSession` here, which is the type the whole tree
   * already speaks — the forest, the filters and `keptArchived` then treat a
   * closed Codex session exactly as they treat a closed Claude one, and none
   * of them learns a second shape.
   *
   * Throttled on the same interval as the Claude scan and cached between
   * ticks, because this runs on the roster cadence.
   */
  let codexArchiveCache: ArchivedSession[] = [];
  let lastCodexScan = 0;
  const codexArchived = (): ArchivedSession[] => {
    const now = Date.now();
    if (lastCodexScan !== 0 && now - lastCodexScan < ARCHIVE_RESCAN_MIN_MS) {
      return codexArchiveCache;
    }
    lastCodexScan = now;
    try {
      codexArchiveCache = scanRollouts({
        sessionsDirs: codexSessionsDirs(),
      }).map((meta) => {
        const session: ArchivedSession = {
          sessionId: meta.sessionId,
          transcriptPath: meta.path,
          endedAt: meta.endedAt,
          bytes: meta.bytes,
        };
        if (meta.startedAt !== undefined) session.startedAt = meta.startedAt;
        if (meta.cwd !== undefined) session.cwd = meta.cwd;
        // No `label` and no `continuesId`, deliberately. A Codex rollout has
        // no custom-title record to read a name from, and no continuation
        // marker — so rather than guess at either, the row wears its id and
        // stands alone, which is what both fields being absent already means
        // everywhere else in the tree.
        return session;
      });
    } catch (err) {
      logError('extension.codexArchived', err);
    }
    return codexArchiveCache;
  };

  /**
   * Which CLI owns a conversation, for the launch paths that have to exec one
   * (`CommandDeps.sessionProvider`). Two sources, in order of how much they
   * prove:
   *
   *   1. the session's own record, written at launch by Flock itself;
   *   2. which history STORE its transcript was found in — the only thing that
   *      knows for a session Flock never launched, since a Codex session
   *      started in a terminal leaves no record at all.
   *
   * Deliberately NOT `providerFor`, the glyph resolver, which falls back to
   * the owning project's provider. That fallback is right for an icon and
   * catastrophic here: a project switched to Codex would make this claim every
   * Claude conversation in it, and each resume would hand `codex` a session id
   * it has never seen.
   */
  const sessionProviderFor = (id: string): ProviderId | undefined => {
    try {
      if (store.get(id)?.provider === 'codex') return 'codex';
      return codexArchived().some((s) => s.sessionId === id)
        ? 'codex'
        : undefined;
    } catch (err) {
      logError('extension.sessionProviderFor', err);
      return undefined;
    }
  };

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
   * explicit ARCHIVE removes it (`deleted` on the record — the field keeps its
   * old name because the state file is on real users' disks; see
   * EditorialRecord.deleted). `showArchived` widens the gate to sessions with
   * no record at all: foreign history found on disk. That setting is about
   * level 2, closed sessions read off disk, and has nothing to do with the
   * Archive verb — the two words collided before the verb was renamed.
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
    // Both stores, one filter. A closed Codex session is kept or hidden by
    // exactly the rule that keeps or hides a closed Claude one — it has a
    // record, or `showArchived` is on — so the setting means the same thing
    // whichever CLI wrote the history.
    return keptArchived(
      [...archiveIndexer.current(), ...codexArchived()],
      liveIds,
      { showArchived, keepIds },
    );
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
   * CommandDeps.transcriptFacts — what the chat-history picker and the
   * per-project archive browser label, file and order their rows with.
   *
   * Everything but the on-demand prompt read comes off work already done.
   * `lastActiveAt` is the archive index's own mtime for the transcript, so no
   * `statSync` is added to anything, and `cwd`, `label` and `aiTitle` are
   * FREE in the strictest sense: the index read them out of the same bounded
   * head it read the mtime beside, and they were simply not being forwarded.
   * That matters here because this block's whole argument is about cost.
   *
   * The archive browser needs all three. `cwd` is the only working directory
   * a fifth of the archived records have, so without it a project's archive
   * silently omits them; `label` and `aiTitle` are the two name sources an
   * editorial record never learns, and a list of hex ids is a list you have to
   * open every row of. The first prompt is read on demand — this runs when a human
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
    if (entry.cwd !== undefined) facts.cwd = entry.cwd;
    if (entry.label !== undefined) facts.label = entry.label;
    if (entry.aiTitle !== undefined) facts.aiTitle = entry.aiTitle;
    // The INDEX's opening prompt wins over the on-demand read below when it
    // has one. Both answer "what did this conversation open with", but the
    // index's version is the filtered one — envelopes rejected, slash-command
    // wrappers unwrapped, whitespace collapsed — and it is the version the
    // tree row already renders. Two surfaces disagreeing about a session's
    // name is worse than either of them being wrong. The on-demand read stays
    // as the fallback: the index skips a file it saw being written, so a LIVE
    // chat has no indexed prompt and would otherwise lose its label.
    if (entry.firstPrompt !== undefined) {
      facts.firstPrompt = entry.firstPrompt;
      return facts;
    }
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
    // A fork is never a re-key: where a continuation claim names the same
    // (child, parent) pair as a persisted fork edge, the edge — recorded
    // before the child process existed — wins and the claim is dropped.
    // Without this, the daemon roster's transient `mode: 'resume'` view of a
    // fork launch chains the child onto its parent and the collapse swallows
    // the parent's row (see dropForkContinuations).
    const forkParentOf = (childId: string): string | undefined => {
      const record = records[childId];
      if (record === undefined || !isSessionId(record.parentId)) {
        return undefined;
      }
      const src = record.parentSource;
      return src === 'minted' || src === 'daemon' ? record.parentId : undefined;
    };
    chainIndex = buildChainIndex({
      facts: dropForkContinuations(
        [...archiveIndexer.chainFacts(), ...daemonChainFacts],
        forkParentOf,
      ),
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
    const entriesNoChat = collapsed.entries.filter((e) => !isChat(e.sessionId));
    const archived2 = archived.filter((a) => !isChat(a.sessionId));

    // FOREIGN live sessions — `claude` running somewhere Flock does not own.
    // With `lineage.showForeignSessions` off (the default), they never reach
    // the forest: no row, no folder group minted for their directory, and —
    // because detectTurnTransitions and noteSessionDone both stop at the
    // forest's edge — no doneAt stamp and no bell. The stamp is the part that
    // matters most: it writes an editorial record, and a record is tree
    // membership, so the old behaviour quietly IMPORTED every session anyone
    // ever ran on the machine. What stays regardless: anything with a record
    // on its chain (launched here, added, imported, titled, parked), anything
    // bound to a terminal in THIS window, and this window's own launches still
    // in their pending gap. The filter sits HERE, after the collapse, for the
    // chat filter's reason — membership must be asked of the chain, not of one
    // physical id — and `liveIds`/`prevLiveIds` above keep the raw entries so
    // the chain index and archive scan still learn foreign re-keys.
    let entries2 = entriesNoChat;
    if (!boolCfg(CONFIG_KEYS.showForeignSessions, false)) {
      const keep = memberKeepIds(collapsed.records, (id) =>
        chainIndex.tipOf(id),
      );
      for (const id of registry.boundSessionIds()) {
        keep.add(id);
        keep.add(chainIndex.tipOf(id));
      }
      for (const e of pending) keep.add(e.sessionId);
      entries2 = entriesNoChat.filter((e) => keep.has(e.sessionId));
    }

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
    // The compaction phases, asked per row rather than handed over as a map:
    // the answer depends on the CHAIN (a compaction re-mints the id, so the
    // PreCompact and its completion arrive under different generations) and on
    // the live status, and buildForest knows about neither. Pruned first, so a
    // window left open for a week cannot accumulate phases for sessions that
    // are long gone.
    const compactionNow = Date.now();
    compaction.prune(new Set(liveIds), compactionNow);
    forest = buildForest({
      entries: entries2,
      resolutions,
      records: collapsed.records,
      headers,
      archived: archived2,
      activityMtimes,
      tailStats,
      compactionOf: (id, status) =>
        compaction.phaseOf(chainAliases(id), compactionNow, status === 'busy'),
      opts: {
        // Always. Ghost ancestors — the exited sessions live ones were forked
        // from — are what keep the tree's ancestry honest, and a toggle that
        // could hide them was a setting nobody should turn; the parameter
        // stays on buildForest so the ghost rules remain testable in
        // isolation.
        showGhosts: true,
        notificationsDefault: boolCfg(CONFIG_KEYS.notificationsEnabled, true),
        onlyActive: boolCfg(CONFIG_KEYS.onlyActiveSessions, false),
      },
    });
    // THE FOURTH COMPLETION SIGNAL, and the only one that cannot lose a race:
    // a generation that has acquired a successor has finished compacting,
    // because minting that successor is what a compaction DOES. See
    // compaction.settleSuperseded for the ten-minute stuck ring it exists to
    // take down.
    //
    // AFTER buildForest, not beside the prune above, and the reason is the
    // second argument. "Is that conversation still working?" decides whether
    // this rests a purple dot or simply ends the phase, and the only clean
    // answer to it is `node.status` — the roster's raw `state`/`status` pair
    // has not been through normalizeStatus or the frozen-busy correction yet,
    // so reading it here would call a session busy that the tree itself is
    // about to draw as idle. The cost is that the settle lands on the NEXT
    // rebuild, one poll interval later; the ring it is taking down had been
    // standing for minutes.
    compaction.settleSuperseded(
      (id) => chainIndex.tipOf(id),
      (tipId) =>
        chainAliases(tipId).some(
          (id) => forest.nodes.get(id)?.status === 'busy',
        ),
      compactionNow,
    );
    unseenProjectsCache = null;
    fireForestChanged();
    detectTurnTransitions();
    void syncUnseenContext();
    void syncForkableContext();
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
  /** Repaint the "where am I" status line. Late-bound like `isWorkspaceSwitching`:
   *  the real function is `updateWorkspaceStatusBar`, defined with the rest of
   *  the workspace wiring hundreds of lines below, and the events that ought to
   *  repaint it (a landed worktree probe, a forest change) start firing before
   *  then. A no-op until it exists is right — there is no item yet to be wrong. */
  let refreshWhereAmI = (): void => {};

  const refreshViews = (): void => {
    // Suspended for the duration of a workspace switch — see suspendViews.
    if (viewsSuspended) return;
    treeController?.refresh();
    webtreeController?.refresh();
    // Same signal, same suspension: a landed git probe or a new roster tick can
    // change which branch the line names, and a status bar that only repaints on
    // a SWITCH would sit on a stale answer until the next one.
    refreshWhereAmI();
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

  // One-time nudge about the rows 0.1.2 turned off. Deferred and staggered
  // behind the tmux one for the same reason that one is deferred — it is
  // advice, nothing about startup should wait on a toast, and two warnings
  // stacked on top of each other is not a first impression worth having.
  //
  // The decision is `branchRowsAdvice` in src/git.ts, pure and tested; this
  // supplies the world. The world costs one `git worktree list` per project
  // directory, which is why it is `warm` (awaited, off the render path) rather
  // than `get`: the answer has to be real before we speak, and a notice that
  // fired on a cold cache would say "you have one checkout" to everybody.
  const branchNoticeShown = (): boolean =>
    context.globalState.get<boolean>(BRANCH_ROWS_NOTICE_KEY) === true;
  const suppressBranchNotice = (): void => {
    void context.globalState.update(BRANCH_ROWS_NOTICE_KEY, true);
  };
  setTimeout(() => {
    void (async (): Promise<void> => {
      try {
        // Cheap tests first: every one of these avoids the probes entirely.
        if (
          branchRowsAdvice({
            branchRowsEnabled: boolCfg(CONFIG_KEYS.gitBranches, false),
            schemaVersionAtLoad: store.schemaVersionAtLoad,
            parkedAtSchema: BRANCH_ROWS_PARKED_AT_SCHEMA,
            maxWorktrees: 2, // assumed, pending the probe below
            dismissed: branchNoticeShown(),
          }) === 'none'
        ) {
          return;
        }

        let maxWorktrees = 0;
        for (const project of store.getProjects()) {
          if (project.deleted === true) continue;
          for (const dir of projectDirs(project)) {
            const list = await worktrees.warm(dir);
            maxWorktrees = Math.max(maxWorktrees, list.length);
            if (maxWorktrees >= 2) break;
          }
          if (maxWorktrees >= 2) break;
        }

        if (
          branchRowsAdvice({
            branchRowsEnabled: boolCfg(CONFIG_KEYS.gitBranches, false),
            schemaVersionAtLoad: store.schemaVersionAtLoad,
            parkedAtSchema: BRANCH_ROWS_PARKED_AT_SCHEMA,
            maxWorktrees,
            dismissed: branchNoticeShown(),
          }) !== 'offer'
        ) {
          return;
        }

        const SHOW = 'Show branch rows';
        const KEEP_OFF = 'Keep them off';
        const choice = await vscode.window.showInformationMessage(
          'Flock used to give every checkout of a repository its own row. ' +
            'Those rows are behind a setting now, off by default, because a ' +
            'repository with six checkouts is six rows before the first ' +
            'session. Nothing moved: your worktree sessions are filed exactly ' +
            'where they were.',
          SHOW,
          KEEP_OFF,
        );
        if (choice === SHOW) {
          await cfg().update(
            CONFIG_KEYS.gitBranches,
            true,
            vscode.ConfigurationTarget.Global,
          );
          suppressBranchNotice();
        } else if (choice === KEEP_OFF) {
          suppressBranchNotice();
        }
        // Dismissed with the X: not suppressed, so it asks once more next
        // time. Same rule as the tmux notice above.
      } catch (err) {
        logError('branchRows.notice', err);
      }
    })();
  }, BRANCH_ROWS_NOTICE_DELAY_MS);

  // What each of those checkouts can say about itself: ahead/behind and dirt.
  // A second cache rather than more fields on the first, because the two probes
  // cost different amounts — one spawn per PROJECT versus one per WORKTREE — and
  // therefore cannot share a schedule. Same discipline either way: read
  // synchronously from cache, refresh in the background, repaint on a landed
  // change through the path a roster tick already uses.
  const branchStatus = new BranchStatusCache();
  context.subscriptions.push(branchStatus);
  context.subscriptions.push(branchStatus.onDidChange(() => refreshViews()));

  // And which branches EXIST, checked out or not — the fold's contents under
  // `lineage.preview.directoryModel`. A third cache for the reason there is a
  // second: one spawn per repository, on the same 30s schedule as the worktree
  // list it is read beside, so a directory's two answers land together and cost
  // one repaint. Deliberately NOT gated on the preview setting: the probe is one
  // `for-each-ref` per project directory and the alternative is a first paint
  // with an empty fold every time somebody turns the switch on.
  const branchList = new BranchListCache();
  context.subscriptions.push(branchList);
  context.subscriptions.push(branchList.onDidChange(() => refreshViews()));

  // PULL REQUESTS — the one thing in this extension that reaches the network, and
  // the only cache here with a gate in front of its refresh. Two conditions, ANDed,
  // and both are needed:
  //
  //   * `lineage.git.pullRequests` is on. Off by default, and reading it per call
  //     rather than at construction means turning it off stops the traffic on the
  //     next tick rather than on a window reload.
  //   * a view that would DRAW the answer is on screen. There is no timer in
  //     src/pullRequests.ts: a render is the only thing that schedules a refresh,
  //     so this predicate is the whole of "poll only while the view is visible" —
  //     without it, `post()` on a hidden webview would keep asking GitHub about a
  //     tree nobody can see.
  //
  // The controllers are `let` and are assigned further down, which is exactly why
  // this is a closure and not a captured value.
  const pullRequestsEnabled = (): boolean =>
    boolCfg(CONFIG_KEYS.gitPullRequests, false) &&
    (webtreeController?.visible === true || treeController?.visible === true);
  const pullRequests = new PullRequestCache({ enabled: pullRequestsEnabled });
  context.subscriptions.push(pullRequests);
  context.subscriptions.push(pullRequests.onDidChange(() => refreshViews()));

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
    codexBinary: () => codexBin(),
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
    // the session's real end here. The TREE kill, not the plain one: every
    // session spawns ~8 MCP children that `kill-session` orphans to PID 1,
    // and this dep is the funnel every close path (verb, chat sweep, idle
    // sweep, user tab-close) runs through — one reap point covers them all.
    tmuxKillSession: (name) => {
      const binary = tmuxSpawn()?.binary ?? findTmuxBinary();
      return binary !== null
        ? killTmuxSessionTree(binary, name)
        : Promise.resolve(false);
    },
    // Exit-to-shell: whether a wrap under this name still holds a CLI. The
    // launch path's `new-session -A` would otherwise attach to the shell a
    // `/exit` left behind instead of starting anything.
    tmuxWrapState: (name) => {
      const binary = tmuxSpawn()?.binary ?? findTmuxBinary();
      return binary !== null
        ? queryWrapState(binary, name)
        : Promise.resolve<WrapState>('gone');
    },
  });
  context.subscriptions.push(registry);

  // The read-only half of the terminal story: which OPEN terminal is running a
  // session Flock never launched, so clicking that row reveals the tab instead
  // of offering to fork a duplicate of a conversation sitting in the panel. The
  // roster it matches against is `lastEntries` — the same rows the tree is drawn
  // from, so the answer can never be about a session the user cannot see.
  const terminalMatcher = new TerminalMatcher({
    pidOf: (terminal) => terminalPid(terminal),
    roster: () => lastEntries,
  });
  context.subscriptions.push(terminalMatcher);

  context.subscriptions.push(
    registry.onDidExit((sessionId, _code, reason, tmuxName) => {
      void store.upsert(sessionId, { boundWindowId: null });
      // The tab X is a 1→2 transition too (the close handler kills the wrap),
      // so it gets the same at-rest repair every other close path runs. Only
      // reason 'user': an extension dispose is the workspace sweep (which has
      // its own bookkeeping) and a shutdown keeps the session for revival.
      if (reason === 'user') {
        repairResumeLeaf(sessionId, {
          extraProjectsDirs: profileProjectsDirs(),
        });
      }
      // WINDOW CLOSE (reason 'shutdown'): the window that owned this session
      // is going away, and with the strict scope fence no OTHER window will
      // ever show it — folder mode drops out-of-scope rows outright now. So
      // "survives the window" would mean "runs where nothing can see it",
      // which is the state this whole design exists to make unreachable. A
      // closed window's sessions END, at level 2: the transcript is the
      // session, and `--resume` brings the conversation back whole.
      //
      // Why a SHORT grace and not an immediate kill: VS Code reports a window
      // RELOAD with the same exit reason as a window CLOSE (see
      // terminals.ts's ExitReason) and gives the extension no way to tell
      // them apart. A reload comes back and reattaches within a second or
      // two; a close never comes back. The grace IS that measurement — long
      // enough that a reload reattaches and clears it (the reattach path
      // wipes graceUntil), short enough that a real close settles to level 2
      // in under a minute instead of holding a process for the full detach
      // grace's ten. It is not a park and not a reprieve; it is how long it
      // takes to find out which event just happened.
      //
      // Not exempted for PINNED sessions any more. The pin means "the idle
      // sweep must not close me while I work", which is a promise about a
      // window that exists; it cannot mean "outlive every window", because
      // there would be no row anywhere to act on the survivor from.
      //
      // If this window dies before the async write flushes, the next
      // activation's reconcile kills the unclaimed wrap — that is also the
      // only backstop a force-quit (deactivate never runs) leaves us.
      if (reason === 'shutdown' && tmuxName !== undefined) {
        void store.upsert(chainIndex.tipOf(sessionId), {
          graceUntil: new Date(
            Date.now() + reloadGraceSeconds() * 1000,
          ).toISOString(),
          tmux: tmuxName,
        });
      }
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
    // The anchor-free folder list the published WindowRecord carries — same
    // reader as the folder-mode fence, so what this window claims to host and
    // what it scopes its own tree to are one set of directories.
    // NOTHING IN AUTO-SWITCH, on purpose, and this is the one place a level-1
    // window is deliberately less useful to its neighbours. A following
    // window's roots change on every focus change, while a `WindowRecord` is
    // republished at most every six hours (windows.ts) — so publishing them
    // makes this window the advertised host for whatever directory it happened
    // to be rooted at when it activated, and `windowForDir` then routes other
    // windows' work here on a claim that expired minutes ago. That is the
    // 84-detached-sessions incident arriving by a different road: work sent to
    // a roost that no longer exists. The consequence is intended, not a defect
    // — a level-1 window is never `windowForDir`'s answer, because it is not
    // the window FOR any directory, it is the window that follows you, and the
    // honest published shape for that is an empty window's.
    //
    // ROUTING ONLY, never scoping: the folder-mode fence reads the LIVE folder
    // list rather than this record, and auto-switch is unfenced anyway
    // (`scopeFolders` returns undefined for every model that is not `folder`).
    realFolders: () =>
      followsTheSession(lineageMode()) ? [] : realWorkspaceFolders(),
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
      // Same refusal as tabTitleFor: a label that is a QUOTATION of the
      // conversation's opening words is a row treatment, not a name, and must
      // never become a tab title. See tabTitleFor for why.
      const node = forest.nodes.get(id);
      const name = tabTitleFrom(
        id,
        node?.labelIsFallback === true ? undefined : node?.label,
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

  // ------------------------------------------------- 5b. tmux reconcile
  //
  // Once per activation: `tmux -L lineage list-sessions` against state. The
  // invariant is "no running process without a visible row", and two lies
  // survive a crash, a window closed mid-grace, or an old build's parked
  // leftovers: a LIVE session nothing claims (killed here, tree and all — the
  // record, if any, becomes an archived row), and a record NAMING a dead
  // session (name cleared, or the next resume would attach to a ghost; a
  // graced one is closed outright — its detached row was covering a corpse).
  // This is also the process half of the v7→v8 migration: sanitizeRecord
  // flipped `parked` records to archived at load and deliberately discarded
  // their tmux names — the live names themselves encode the session ids, so
  // the orphans those records left running die right here, on the first
  // activation of the new build. The decision is reconcileTmuxDecisions
  // (src/idleClose.ts, pure and tested); a freshness guard in it spares
  // records another window wrote moments ago whose claim has not flushed yet.
  //
  // AFTER reassociate(), deliberately: a window reload's revived terminals
  // and an app restart's tmux-client adoptions must be bound — claimed —
  // before anything judges a live session unclaimed.
  void (async () => {
    try {
      const binary = tmuxSpawn()?.binary ?? findTmuxBinary();
      if (binary === null) return;
      const liveNames = await listTmuxSessions(binary);
      // Machine-wide, unlike everything below it: `list-clients` answers for
      // the whole server, so a session another editor's terminal is showing
      // is claimed here even though this store has never heard of it. See
      // idleClose.AttachedNames for the incident that put this line in.
      const attachedNames = new Set(
        (await queryClientSessions(binary)).values(),
      );
      const records = store.all();
      const liveWindows = new Set(store.getWindows().map((w) => w.windowId));
      const boundHere = new Set<string>();
      for (const b of registry.bindings()) {
        for (const id of chainAliases(b.sessionId)) boundHere.add(id);
      }
      const recordFacts: ReconcileRecordFacts[] = Object.values(records).map(
        (r) => {
          const grace = r.graceUntil != null ? Date.parse(r.graceUntil) : NaN;
          const updated = Date.parse(r.updatedAt);
          return {
            sessionId: r.id,
            tmux: r.tmux,
            // An unparseable deadline still claims: expiry is the sweep's
            // call, and the sweep reads the same stamp as already expired.
            ...(r.graceUntil != null
              ? { graceUntilMs: Number.isFinite(grace) ? grace : 0 }
              : {}),
            // Chain-expanded, same as boundHere and the shutdown stamp's own
            // check: the pin may sit on any generation while the wrap name
            // lives on the tip. A pinned chain's window-close deliberately
            // skipped the grace stamp (the pin means "outlives my windows"),
            // so without this fact the reconcile would kill exactly the
            // survivor that skip protected.
            pinned: chainAliases(r.id).some(
              (id) => records[id]?.pinned === true,
            ),
            boundToLiveWindow:
              typeof r.boundWindowId === 'string' &&
              liveWindows.has(r.boundWindowId),
            updatedAtMs: Number.isFinite(updated) ? updated : 0,
          };
        },
      );
      const plan = reconcileTmuxDecisions({
        now: Date.now(),
        liveNames,
        records: recordFacts,
        boundHere,
        attachedNames,
      });
      if (
        plan.killNames.length === 0 &&
        plan.closeIds.length === 0 &&
        plan.clearTmuxIds.length === 0
      ) {
        return;
      }
      log(
        `reconcile: ${String(liveNames.length)} live tmux session(s) — ` +
          `killing ${String(plan.killNames.length)} unclaimed, closing ` +
          `${String(plan.closeIds.length)} record(s), clearing ` +
          `${String(plan.clearTmuxIds.length)} stale name(s)`,
      );
      for (const name of plan.killNames) {
        await killTmuxSessionTree(binary, name);
        // A live session with NO record still deserves an archived row: the
        // transcript exists, and a row is how the user finds out what died.
        // Only when nothing in the plan already closes a record for this wrap
        // — the grace holder lives on the chain TIP, and a second record
        // under the launch-generation id would be a duplicate row.
        const id = sessionIdOfTmuxName(name);
        const holderClosed = Object.values(records).some(
          (r) => r.tmux === name && plan.closeIds.includes(r.id),
        );
        if (id !== undefined && !holderClosed && !plan.closeIds.includes(id)) {
          void store.upsert(id, {
            closed: new Date().toISOString(),
            graceUntil: null,
            tmux: null,
          });
        }
      }
      for (const id of plan.closeIds) {
        void store.upsert(id, {
          closed: new Date().toISOString(),
          graceUntil: null,
          tmux: null,
          closeAfterTurn: false,
        });
        repairResumeLeaf(id, { extraProjectsDirs: profileProjectsDirs() });
      }
      for (const id of plan.clearTmuxIds) {
        void store.upsert(id, { tmux: null });
      }
      pokeNow();
    } catch (err) {
      logError('extension.reconcileTmux', err);
    }
  })();

  // ------------------------------------------- 5c. bare-orphan rescue
  //
  // The reconcile above is TMUX-ONLY: a BARE session's window close has no
  // server to interrogate. VS Code kills the bare claude root itself, its
  // MCP children re-parent to PID 1, and the shutdown-time best-effort reap
  // (terminals.reapBareOnShutdown) runs inside a dying extension host that
  // may not live out even one wait. So the mechanism is a persisted ledger:
  //
  //   * each window writes its bare pid snapshot — root + descendants, with
  //     each pid's `ps lstart` — to its OWN file under globalStorage
  //     (`bare-rescue/<extension-host-pid>.json`, so no window ever clobbers
  //     another's), refreshed on the same 60 s tick that refreshes the
  //     in-memory snapshots. What a crash or close leaves behind is at most
  //     a minute stale;
  //   * the NEXT activation — any window's — reads every leftover file and
  //     reaps what PROVABLY orphaned. "Provably" is procs.ts's
  //     orphanRescueDecision: pid alive + start time identical (a recycled
  //     pid is somebody else's process, however long the gap) + ppid 1
  //     (still-parented pids belong to a live window's session or a reload's
  //     revived terminal, and are left alone — this check, not window
  //     bookkeeping, is what makes reading other windows' files safe).
  //
  // A file is deleted once nothing in it is verifiably alive-and-parented;
  // one that still names a living claimed tree is its owner's (or its
  // reloaded heir's) and stays. Files therefore self-clean one activation
  // after their processes end, and a torn write (a crash mid-rename) parses
  // as nothing verifiable and is removed the same way.
  const bareRescueDir = path.join(
    context.globalStorageUri.fsPath,
    'bare-rescue',
  );
  const bareRescueFile = path.join(
    bareRescueDir,
    `${String(process.pid)}.json`,
  );

  const persistBareRescueSnapshot = async (): Promise<void> => {
    try {
      const pids = registry.bareSnapshotPids();
      if (pids.length === 0) {
        // Nothing bare and bare here: an empty ledger is a stale ledger, and
        // leaving one behind would make the next activation verify pids this
        // window already reaped through the ordinary funnels.
        await fs.rm(bareRescueFile, { force: true });
        return;
      }
      // Start times captured NOW, against the same parser the rescue's
      // verification uses — string equality across the two is the identity
      // check. A pid ps cannot see any more is already gone and not written.
      const facts = await listPidFacts(pids);
      const entries: PersistedPidFact[] = [];
      for (const pid of pids) {
        const start = facts.get(pid)?.start;
        if (start !== undefined) entries.push({ pid, start });
      }
      await fs.mkdir(bareRescueDir, { recursive: true });
      // Write-then-rename so a reader never sees half a ledger; the .tmp of
      // a host that died mid-write is swept by the rescue below.
      const tmp = `${bareRescueFile}.tmp`;
      await fs.writeFile(
        tmp,
        JSON.stringify({ savedAt: new Date().toISOString(), pids: entries }),
        'utf8',
      );
      await fs.rename(tmp, bareRescueFile);
    } catch (err) {
      logError('extension.persistBareRescue', err);
    }
  };

  void (async () => {
    try {
      let names: string[];
      try {
        names = await fs.readdir(bareRescueDir);
      } catch {
        return; // no ledger directory = no window has ever persisted one
      }
      for (const name of names) {
        const file = path.join(bareRescueDir, name);
        // Ours only via an OS-recycled extension-host pid; either way this
        // incarnation owns the name now and will overwrite it on the tick.
        if (file === bareRescueFile) continue;
        if (!name.endsWith('.json')) {
          await fs.rm(file, { force: true }); // a dead host's torn .tmp
          continue;
        }
        let saved: PersistedPidFact[] = [];
        try {
          const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
          const list = (parsed as { pids?: unknown }).pids;
          if (Array.isArray(list)) {
            saved = list.filter(
              (e): e is PersistedPidFact =>
                typeof e === 'object' &&
                e !== null &&
                Number.isInteger((e as { pid?: unknown }).pid) &&
                typeof (e as { start?: unknown }).start === 'string',
            );
          }
        } catch {
          // Unreadable = nothing verifiable = nothing to act on, ever; the
          // deletion below is what keeps a corrupt ledger from lingering.
        }
        const facts =
          saved.length > 0
            ? await listPidFacts(saved.map((e) => e.pid))
            : new Map<number, { ppid: number; start: string }>();
        const decision = orphanRescueDecision(saved, facts);
        if (decision.reap.length > 0) {
          log(
            `bare rescue: ${name} left ${String(decision.reap.length)} ` +
              `verified orphan(s) — reaping by pid`,
          );
          await reapSurvivors(decision.reap);
        }
        if (!decision.ownerLikelyAlive) {
          await fs.rm(file, { force: true });
        }
      }
    } catch (err) {
      logError('extension.bareOrphanRescue', err);
    }
  })();

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

  /**
   * WHICH PROJECTS OWN A DIRECTORY — the one answer every surface in this file
   * asks for, and the one place worktree reach is supplied.
   *
   * `matchProjects`' `extraDirs` is what makes a session in `~/app-feat-x` — a
   * linked checkout of the repository at `~/app` — belong to the project rooted
   * at `~/app` without anybody registering that path. For a while `computeGrouping`
   * was the ONLY caller that passed it, so the sidebar filed such a session under
   * its project while every other question about the same session was asked
   * without reach and answered `null`: focus-follows-project did not follow into a
   * worktree, the Explorer did not re-root there, the provider glyph fell back to
   * the default and the project's unseen dot stayed dark. Membership is one rule
   * or it is a bug, so it is asked in one place.
   *
   * The resolver is built PER CALL (projects.projectReach memoizes for its own
   * lifetime): worktrees are created and removed several times a day, and a
   * long-lived cache would answer for a checkout that is no longer there. A
   * caller with a LOOP passes its own hoisted `reach` so the memo does its job.
   */
  const projectReachNow = (): ((p: ProjectRecord) => readonly string[]) =>
    projectReach((dir) => worktrees.get(dir));

  const claimantsOf = (
    cwd: string | undefined,
    reach: (p: ProjectRecord) => readonly string[] = projectReachNow(),
  ): ProjectMatch[] => matchProjects(allProjects(), cwd, reach);

  /** The single project a single-project question should answer with: the
   *  ACTIVE one when it is among the claimants (the spec's "prefer the active
   *  project in project mode"), else the static tie-break. */
  const claimantOf = (
    cwd: string | undefined,
    preferProjectId?: string | null,
    reach?: (p: ProjectRecord) => readonly string[],
  ): ProjectMatch | null =>
    preferredClaimant(claimantsOf(cwd, reach), preferProjectId ?? null);
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

  /**
   * THE TOUCH: the user just used this session — clicked its row, focused its
   * tab, revealed its terminal. Stamps `touchedAt`, which is half the idle
   * clock the lifecycle sweep closes on (see EditorialRecord.touchedAt and
   * idleClose.lastEngagementMs). Deliberately separate from `markSeen`: that
   * one writes only when a look clears an attention dot, so it cannot answer
   * "when was this last used".
   *
   * Coalesced against the stamp ALREADY ON THE RECORD rather than an
   * in-memory map: the throttle then survives a reload, and two windows
   * flicking between the same session cannot write past each other. Written
   * to the chain TIP, like every other lifecycle fact, so a `/clear` that
   * mints a new generation does not reset the conversation's clock to zero.
   */
  const noteTouched = (sessionId: string): void => {
    const tip = chainIndex.tipOf(sessionId);
    const now = Date.now();
    const prev = chainAliases(sessionId)
      .map((id) => Date.parse(store.get(id)?.touchedAt ?? ''))
      .filter((ms) => Number.isFinite(ms));
    const newest = prev.length > 0 ? Math.max(...prev) : Number.NaN;
    if (Number.isFinite(newest) && now - newest < TOUCH_COALESCE_MS) return;
    void store.upsert(tip, { touchedAt: new Date(now).toISOString() });
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
    // THE BELL STOPS AT THE FOREST'S EDGE. A session with no row cannot light
    // it: the roster and the hook stream are both machine-wide, so without
    // this gate a `claude` run in some other app's terminal would toast here —
    // and worse, the doneAt stamp below would write an editorial record, which
    // is tree membership, silently importing a session nobody asked Flock to
    // watch. The poll-side detector already iterates the forest and cannot
    // reach this for a foreign session; this is the same rule for the hook
    // path. Asked of the id AND its chain tip, because a Stop event names the
    // physical id while the collapse may have re-keyed the row.
    if (
      !forest.nodes.has(sessionId) &&
      !forest.nodes.has(chainIndex.tipOf(sessionId))
    ) {
      return;
    }
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
      // The compaction half of the same two transitions, and it runs BEFORE
      // the `hidden` gate below on purpose: hiding a row is "stop telling me
      // about this one", not "freeze its state", and a hidden session whose
      // compaction finished must still stop being mid-compaction — or
      // unhiding it weeks later would produce a ring for a compaction that
      // ended before lunch. (buildForest is what keeps a hidden row's mark off
      // the screen, exactly as it does for the unseen dot.)
      //
      // This is the hook-free path to both edges: quiet→busy means something
      // is behind the compaction now, busy→quiet means it is over. Slower than
      // the hooks above by up to one poll interval, and the only path at all
      // when hooks are off.
      const aliases = chainAliases(node.id);
      // Was this quiet the END OF A COMPACTION rather than the end of a turn?
      // Asked BEFORE the settle below, because the settle is what makes the
      // answer stop being readable — and asked as "does this conversation
      // carry any live phase at all", so it is still true when a hook beat the
      // poller to the finish by less than one interval and the ring is already
      // a resting dot.
      //
      // A resting dot cannot survive into a REAL turn's ending and so cannot
      // suppress its toast: going busy is the only way back to something worth
      // announcing, and both paths out of quiet — the UserPromptSubmit hook
      // and the quiet→busy edge below — clear a settled phase on the way.
      //
      // Only computed on the edge that reads it: this loop runs over every
      // node on every poll.
      const quieting = prev === 'busy' && node.status !== 'busy';
      const wasCompaction =
        quieting &&
        (compaction.isCompacting(aliases) ||
          compaction.phaseOf(aliases, Date.now(), false) !== undefined);
      if (quieting) {
        // `busy: false` is not a guess here — the edge we are standing on IS
        // the roster leaving `busy`.
        compaction.noteFinish(aliases, Date.now(), false);
      } else if (prev !== undefined && prev !== 'busy' && node.status === 'busy') {
        compaction.clearSettled(aliases);
      }
      if (node.hidden) continue;
      // The turn ended: it was working, now it is not.
      if (prev === 'busy' && (node.status === 'waiting' || node.status === 'idle')) {
        // ...UNLESS what just ended was a compaction. A compaction is neither
        // work you asked for nor a question for you (the whole argument for
        // giving it a mark of its own — see src/compaction.ts), so calling it
        // a finished turn was wrong twice over: it toasted "X finished its
        // turn" at a conversation nobody had asked anything of, and it left
        // the row unseen-done, which is the red attention dot. The purple mark
        // hid that red dot while it lasted and the red one surfaced when it
        // expired — a session lighting up for attention an hour after a
        // compaction it did on its own.
        if (!wasCompaction) noteSessionDone(node.id);
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

  let lastHasForkable: boolean | null = null;

  /**
   * Light the view title's fork button only while there is something for it to
   * be about.
   *
   * The predicate lives in commands.ts (`hasForkableRow`), beside the verb that
   * refuses when it is false — one line for the button's `when` clause and the
   * verb's own answer, so the two cannot come to disagree about an empty tree.
   *
   * Only on a CHANGE, like the multi-select key: `setContext` is a round trip to
   * the workbench and a rebuild happens every poll interval, whereas this flips
   * roughly twice in a session — once when the first row appears.
   */
  async function syncForkableContext(): Promise<void> {
    let has = false;
    try {
      has = hasForkableRow(forest);
    } catch (err) {
      logError('extension.forkableContext', err);
      return;
    }
    if (has === lastHasForkable) return;
    lastHasForkable = has;
    try {
      await vscode.commands.executeCommand(
        'setContext',
        CONTEXT_HAS_FORKABLE,
        has,
      );
    } catch (err) {
      logError('extension.forkableContext', err);
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
      // One resolver for the whole loop — see projectReachNow.
      const reach = projectReachNow();
      for (const node of forest.nodes.values()) {
        // THE SAME QUESTION THE ROW'S OWN DOT ANSWERS, asked with the same
        // function — see viewmodel.subtreeHasUnseen, which is this loop's twin
        // for the inline sidebar and carries the argument in full. A
        // hand-written `unseen === true && !hidden` disagreed with statusTone
        // in three directions (a session that is OVER, one that is BUSY again,
        // one WAITING with unseen tracking off), and every disagreement showed
        // up as a project row whose dot contradicted the rows beneath it.
        if (statusTone(node) !== 'done') continue;
        // EVERY claimant, not one: a twice-claimed session renders under both
        // project rows (see matchProjects), so the dot has to light both — a
        // row showing the session while its sibling carries the green mark
        // would read as two different sessions.
        for (const match of claimantsOf(node.cwd, reach)) {
          if (match.project.hidden !== true) out.add(match.project.id);
        }
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
  /** The project this window is switched to, safe to ask DURING activation.
   *  Same late-binding as `isWorkspaceSwitching` and for the same reason —
   *  `workspaceManager` is a `const` declared hundreds of lines below, so a
   *  render triggered by a terminal event before then would not read `undefined`
   *  from it, it would throw on the temporal dead zone. Null until the manager
   *  exists, which reads as "no active project": the honest answer that early. */
  let activeProjectIdNow = (): string | null => null;

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
      // And the idle clock's user half, on the same signal and behind the same
      // mid-switch guard — for the same reason the guard is here at all. A
      // switch focuses every terminal it moves, so without it the stow would
      // stamp "the user just used this" on the whole set it is putting away,
      // which is the precise opposite of what happened.
      noteTouched(sessionId);
      // The purple dot goes out for the same reason and on the same signal.
      // A compaction that has SETTLED is a note saying "this conversation was
      // just compacted and nothing has been asked of it since" — and opening
      // it is reading the note. The ring is untouched: a compaction still in
      // flight is a fact about the process, not a message for the user, and
      // watching it happen does not make it stop happening.
      compaction.clearSettled(chainAliases(sessionId));
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
    // A Codex session Flock never launched has no record to read, so the store
    // its transcript lives in is what earns it the OpenAI mark. Asked BEFORE
    // the project fallback, because it is evidence rather than inheritance:
    // this session really is a Codex one, whatever the project it sits in is
    // set to.
    if (sessionProviderFor(sessionId) === 'codex') return 'codex';
    const cwd = forest.nodes.get(sessionId)?.cwd ?? record?.cwd;
    // Through claimantOf, so the glyph is decided by the same ownership rule
    // that decided the ROW the session is filed under — including worktree
    // reach, without which a session in a linked checkout drew the default
    // mark while sitting under a project set to another provider.
    const match = claimantOf(cwd, activeProjectIdNow());
    return match ? providerOfProject(match.project) : DEFAULT_PROVIDER;
  };

  /**
   * WHO is running a session (src/hosts.ts), the one answer every surface uses:
   * the row's ownership token pair (which decides whether the Close verbs are in
   * the menu at all), the row's `elsewhere` marker and hover, and the verbs'
   * refusals.
   *
   * Asked over the generation CHAIN. Ownership evidence — `launchedByUs`,
   * `boundWindowId`, the parked wrap's name — is deliberately not carried
   * forward when a conversation re-mints its id (see generations.ts), so a
   * re-keyed session of ours has its liveness on the new id and its ownership on
   * an older one. Asking the tip alone would call it foreign.
   *
   * Liveness comes from `prevLiveIds` rather than from `lastEntries`, for both
   * reasons: it is a Set, and this runs once per rendered row on every repaint;
   * and it is assigned by the same rebuild that produced the forest the rows are
   * drawn from, so a row that renders as live is always a row this can see. A
   * scan of the raw roster can be a tick AHEAD of the forest, which is exactly
   * the window in which a row and its ownership marker would disagree.
   */
  const sessionHostOf = (sessionId: string): SessionHost =>
    hostOfChain(chainAliases(sessionId), {
      live: (id) => prevLiveIds.has(id),
      boundHere: (id) => registry.isBoundHere(id),
      record: (id) => store.get(id),
    });

  const viewDeps: TreeDeps & DecorationDeps = {
    getForest: () => forest,
    onDidChangeData: (listener) => onForestChanged.event(listener),
    projectsWithUnseen,
    isBoundHere: (id) => registry.isBoundHere(id),
    hostOf: sessionHostOf,
    // The account label for the hover, on both surfaces. `pinnedProfile`, not
    // `pinnedLaunchProfile`: this states what the conversation CLAIMS, and a
    // pin naming an account no session could start on today is still the true
    // answer to "whose subscription is this on". Undefined for a conversation
    // with no pin — the machine's default login, which has no name to give.
    accountLabelOf: (id) => {
      try {
        return (
          pinnedProfile(store.getSessionProfile(id), store.getAccounts())
            ?.label ?? undefined
        );
      } catch (err) {
        logError('extension.accountLabelOf', err);
        return undefined;
      }
    },
    // `reparent` was here: a drag onto a session row wrote a hand-made parent
    // edge, and a drag onto a folder row erased one. Retired — lineage is not
    // something a gesture may state, see WebtreeDeps and webtree.onDrop. The
    // store still READS the 'reparent' edges it wrote; nothing writes new ones.
    // Both halves of `lineage.unclaimedSessions`: the renderers never learn
    // the enum, so neither did their signatures.
    groupByFolder: () => unclaimed().groupByFolder,
    projects: allProjects,
    hiddenFolders: () => store.getHiddenFolders().map((f) => f.path),
    onlyProjectSessions: () => unclaimed().onlyProjectSessions,
    // Folder mode's fence, undefined whenever nothing is fenced. The same
    // answer the command layer's scopeDirs dep gives, so the rows a window
    // draws and the sessions its verbs will act on in place are one set.
    scopeDirs: () => scopeFolders(),
    onlyActiveSessions: () => boolCfg(CONFIG_KEYS.onlyActiveSessions, false),
    noteSelection,
    showTokens: () => boolCfg(CONFIG_KEYS.showTokens, false),
    worktreesOf: (dir) => worktrees.get(dir),
    branchStatusOf: (dir) => branchStatus.get(dir),
    pullRequestFor: (repoDir, branch) => pullRequests.get(repoDir, branch),
    // Read raw and sanitised at the point of use, not here: the value is a
    // user-editable array that lands in an inline <style> block, and the one
    // place that knows what a legal palette entry looks like is the function
    // that writes the CSS (sanitizeBranchColor).
    branchColors: () =>
      cfg().get<unknown[]>(CONFIG_KEYS.branchColors, [])?.map(String) ?? [],
    // `lineage.runningBadge` — the count on the activity-bar icon, off by
    // default. Read live (both halves), so the number appears and disappears on
    // the next tick rather than on a window reload — including when
    // `lineage.viewStyle` moves between the two sidebars, which is what the
    // surface half is comparing against. See TreeDeps.runningBadge.
    runningBadge: (surface) =>
      boolCfg(CONFIG_KEYS.runningBadge, false) && viewStyle() === surface,
    // `lineage.git.branches` — the whole branch block, off by default. Read per
    // render like every other setting here, so the rows appear and disappear on
    // the next tick rather than on a window reload.
    //
    // Note that this does NOT gate `worktreesOf` above: the probe still runs, so
    // a session in a linked checkout stays under the project that owns the
    // repository. Hiding the rows must not move anybody's sessions.
    branchRows: () => boolCfg(CONFIG_KEYS.gitBranches, false),
    // `lineage.git.branchDisplay` — WHICH of the two ways a session says its
    // worktree. Not a second gate: with `branchRows` off there is nothing to
    // display either way. Anything unrecognised reads as the shipped mode.
    branchDisplay: () => {
      const raw = cfg().get<string>(
        CONFIG_KEYS.gitBranchDisplay,
        DEFAULT_BRANCH_DISPLAY,
      );
      return isBranchDisplay(raw) ? raw : DEFAULT_BRANCH_DISPLAY;
    },
    // What the `+` on a project or subproject row does.
    newSessionInWorktree: () =>
      boolCfg(CONFIG_KEYS.gitNewSessionInWorktree, true),
    // Anything that is not 'detailed' reads as 'standard' — a mistyped setting
    // should show the quieter line, not no line and not a crash.
    sessionBranchDetail: () =>
      cfg().get<string>(CONFIG_KEYS.gitSessionBranchDetail, 'standard') ===
      'detailed'
        ? 'detailed'
        : 'standard',
    // Read per render like every other setting here, so the layout flips
    // on the next tick rather than on a window reload.
    groupSessionsByBranch: () =>
      boolCfg(CONFIG_KEYS.groupSessionsByBranch, false),
    // THE DIRECTORY MODEL (preview). One read, per render for the same reason as
    // everything above: the whole value of shipping this as a switch is being
    // able to flip it and look.
    localBranchesOf: (dir) => branchList.get(dir),
    directoryModel: () => boolCfg(CONFIG_KEYS.previewDirectoryModel, false),
    // NAMED SUBPROJECTS (v7) and the stamp that files a session into one. Not
    // behind a setting: a lane is stored state the user created on purpose, and a
    // switch that hid it would hide the rows their sessions are filed under. A
    // store with no lanes — every store until somebody makes one — yields the
    // directory rows this tree has always drawn.
    subprojects: () => store.getSubprojects(),
    stampOf: (id) => store.getSessionSubproject(id),
    // `reparentProject` was here: dropping a project row onto another filed it
    // there as a subproject. Retired with record nesting — a subproject is a
    // directory now, so a project row no longer drags and neither view resolves
    // the drop.
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
    // the same thing up to one poll interval later. (`Notification` is claude
    // asking for the user, same urgency.)
    if (e.sessionId && (e.event === 'Stop' || e.event === 'Notification')) {
      noteSessionDone(e.sessionId);
    }
    // ---- compaction (src/compaction.ts) -------------------------------
    //
    // PreCompact is the ONLY signal that a compaction has begun: the roster
    // reports a compacting session as plainly `busy`, and the transcript's
    // compact_boundary record is not written until it is already over. Hence
    // the fifth hook event, and hence PLUGIN_VERSION 4.
    //
    // Out again on any of three, whichever lands first — the successor
    // generation being minted, the turn ending, or (in detectTurnTransitions
    // below) the roster simply going quiet. Three, because nothing in this
    // extension is allowed to REQUIRE hooks: with them off the ring never
    // appears at all, which is the old behaviour and fine, but a ring that
    // appeared must always be able to come down.
    if (e.sessionId) {
      const aliases = chainAliases(e.sessionId);
      if (e.event === 'PreCompact') {
        compaction.noteStart(e.sessionId, Date.now());
      } else if (e.event === 'Stop') {
        // `busy: false` is what `Stop` MEANS — the turn ended — and it is the
        // argument that decides whether this rests a purple dot or simply ends
        // the phase. See noteFinish.
        compaction.noteFinish(aliases, Date.now(), false);
        //
        // SESSIONSTART `source: 'compact'` USED TO END THE PHASE HERE TOO, and
        // it no longer does. It is still the earliest and most exact statement
        // that a compaction finished — but finishing is only half of what this
        // has to decide, and it cannot answer the other half. "Is the
        // conversation still working?" would have to come from the roster, and
        // the roster reports a COMPACTING session as plainly `busy`: that
        // confound is the whole reason src/compaction.ts exists. So the probe
        // says "busy" for the `/compact` typed at an idle session as readily as
        // for the auto-compact that fires mid-turn, and the one case the purple
        // dot exists for would have been the one that never got it.
        //
        // Nothing is lost by dropping it. When the conversation really is quiet
        // afterwards, the roster's own busy→quiet edge and this `Stop` are both
        // immediate and both know it. When the turn carries on, there is no
        // quiet edge to have — and `settleSuperseded`, running on the next
        // rebuild, reads a status taken AFTER the compaction rather than during
        // it, which is the only reading of "still working" that means anything
        // here.
      } else if (e.event === 'UserPromptSubmit') {
        // A new prompt IS the "other command behind it" the resting dot
        // promises there is none of, and it arrives a poll interval before the
        // roster would say so. Settled phases only — `/compact` is itself a
        // prompt, and clearing outright here would take down the ring the
        // PreCompact immediately after it is about to raise.
        compaction.clearSettled(aliases);
      } else if (e.event === 'SessionEnd') {
        compaction.clear(aliases);
      }
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

  // ------------------------------------------------- 7b. in-session verbs

  const verbsManager = new AgentVerbsManager({
    getStored: () => store.getVerbsState(),
    setStored: (s) => store.setVerbsState(s),
  });
  context.subscriptions.push(verbsManager);
  try {
    await verbsManager.selfHeal();
  } catch (err) {
    logError('extension.verbs.selfHeal', err);
  }

  /** The verbs twin of syncHookWatcher. Its executor closes over
   *  `commandDeps`, declared in section 8 below — legal because the closure
   *  only runs from calls that all happen after activation reaches it, and
   *  deliberate: the executor must run THE command wiring, not a parallel
   *  one that could drift from what the sidebar button does. */
  const syncVerbsWatcher = (): void => {
    try {
      if (
        boolCfg(CONFIG_KEYS.verbsEnabled, false) &&
        verbsManager.getState().installed
      ) {
        verbsManager.startWatcher({
          isBoundHere: (id) => registry.isBoundHere(id),
          tipOf: (id) => chainIndex.tipOf(id),
          runFork: (request) =>
            forkForAgent(commandDeps, request.node, {
              count: request.count,
              ...(request.prompt !== undefined
                ? { prompt: request.prompt }
                : {}),
              ...(request.titles !== undefined
                ? { titles: request.titles }
                : {}),
            }),
        });
      } else {
        verbsManager.stopWatcher();
      }
    } catch (err) {
      logError('extension.verbs.watcher', err);
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

  // ------------------------------------------- the sidebar as the switcher
  //
  // `lineage.sessionSwitching` (see the type in types.ts for the whole
  // argument). Two halves:
  //
  //   1. FOLLOW. The row of whatever conversation is in front stays selected,
  //      so the sidebar always already says where you are. This is what makes
  //      the Claude extension's back arrow survivable without intercepting it:
  //      you cannot land on the agent list "having lost your place", because
  //      the tree never lost it.
  //   2. JUMP. COMMANDS.focusSessionsView puts the keyboard on that row, which
  //      is what turns a highlighted row into a switcher — up and down move
  //      between sessions from there. Bound to alt+left while Claude's panel
  //      or sidebar has focus, which is the gesture the arrow is standing in
  //      for.
  //
  // WHAT FLOCK CANNOT DO, so that nobody looks for it here: intercept the
  // arrow. It is a route change inside another extension's webview and it
  // produces nothing observable on the outside — no tab, no title, no command,
  // no context key. The click is not preventable, catchable, or even visible.

  const sessionSwitching = (): SessionSwitching => {
    const raw = cfg().get<string>(CONFIG_KEYS.sessionSwitching);
    return isSessionSwitching(raw) ? raw : DEFAULT_SESSION_SWITCHING;
  };

  /**
   * The conversation in front, as far as this window can tell.
   *
   * The active TERMINAL first, because that is the one thing the workbench
   * reports precisely; then the last session Flock itself put in front, which
   * is the only handle there is on a conversation living in the Claude
   * extension's panel (it exposes no "which session is this tab" API, and a
   * webview tab carries nothing but a viewType).
   *
   * Answered over the chain, because every one of those handles names the
   * generation that was CURRENT when it was recorded, and the row now carries
   * the tip.
   */
  let lastFrontSessionId: string | null = null;
  const frontSessionId = (): string | null =>
    frontSession({
      activeSessionId: registry.activeSessionId(),
      lastFrontSessionId,
      tipOf: (id) => chainIndex.tipOf(id),
      hasRow: (id) => forest.nodes.has(id),
    });

  /** Record a conversation as the one in front. Called wherever Flock puts a
   *  session on screen by a route the active-terminal read cannot see — the
   *  delegated open, above all, which hands the conversation to another
   *  extension's panel and never touches a terminal. */
  const noteFrontSession = (sessionId: string): void => {
    if (isSessionId(sessionId)) lastFrontSessionId = sessionId;
  };

  /**
   * Half 1: keep the selection on the conversation in front.
   *
   * Never takes the keyboard — the user is typing in the thing they just
   * switched to, and a reveal that stole focus would eat the keystroke. And
   * never through `revealSession`, whose wait-for-the-row-to-exist loop is
   * right for a launch and wrong here: this fires on every terminal switch,
   * and a fifteen-second waiter per switch would pile up subscriptions for
   * rows that are simply not in the tree.
   */
  const followFrontSession = (): void => {
    const visible =
      webtreeController?.visible === true || treeController?.visible === true;
    if (!mayFollowSelection({ mode: sessionSwitching(), treeVisible: visible })) {
      return;
    }
    const id = frontSessionId();
    if (id === null) return;
    void treeController?.revealSession(id);
    void webtreeController?.revealSession(id);
  };

  try {
    context.subscriptions.push(
      registry.onDidChangeActive((sessionId) => {
        if (sessionId !== null) noteFrontSession(sessionId);
        followFrontSession();
        // The line follows the FRONT conversation, so this is its primary
        // signal — and the only one that fires for a move BETWEEN LANES of one
        // project, which no switch and no forest change reports.
        refreshWhereAmI();
      }),
    );
  } catch (err) {
    logError('extension.followFrontSession', err);
  }

  /** Half 2: the jump. Reveals the sidebar, selects the row and hands it the
   *  keyboard — whichever of the two surfaces is the live one. Falsy return
   *  means neither could be brought up, and the caller says so rather than
   *  leaving the gesture looking broken. */
  const focusSessionsView = async (): Promise<boolean> => {
    const id = frontSessionId();
    if (id === null) return false;
    // Exactly one of the two views is ever on screen (their `when` clauses are
    // complements), so this is a try-both, not a do-both.
    if ((await webtreeController?.focusSession(id)) === true) return true;
    return (await treeController?.focusSession(id)) === true;
  };

  // ----------------------------------------------------- project workspaces

  // --------------------------------------- the Explorer follows the project
  //
  // The built-in Explorer's folder tree IS `workspace.workspaceFolders` — there
  // is no API to reroot it — so making it follow the active project means
  // splicing that list. src/explorer.ts owns the arithmetic and the anchor
  // invariant that keeps a splice from restarting the extension host; this is
  // only the workbench half of it.
  // Hoisted to the config section (the scope fence and the window publisher
  // need it long before the Explorer wiring runs); aliased here so the
  // explorer half keeps reading under the name that says whose path it is.
  const explorerAnchorPath = anchorPath;
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
      scope: () => explorerScope(),
    },
    explorerAnchorPath,
  );

  // SOURCE CONTROL, the second half of the auto-switch follow.
  //
  // The SPLICE above is the mechanism: the built-in git extension listens on
  // `onDidChangeWorkspaceFolders` and opens a repository for every folder that
  // appears, so a spliced root that IS a repository (or a linked worktree,
  // which git reports as its own toplevel) reaches Source Control with no code
  // at all. src/sourceControl.ts is the belt to that braces, for the case a
  // spliced folder sits BELOW a repository root, and it is written to be a
  // silent no-op whenever the splice already did the job. Read its header for
  // what is proven and what is not; docs/reference.md carries the manual
  // experiment that settles the difference.
  //
  // THE ONLY PLACE FLOCK TALKS TO ANOTHER EXTENSION, and it degrades exactly
  // the way src/git.ts and src/roster.ts degrade: a missing extension, a
  // disabled feature, an API version that moved and a rejected promise all mean
  // one thing to the caller — no Source Control following, everything else
  // unchanged. `getAPI(1)` throws outright when `git.enabled` is false, which
  // is why `exports.enabled` is consulted first; the extension activates on
  // `*` so there is never a wait worth designing around, but `activate()` is
  // still awaited once, because an unactivated extension has no model behind
  // its `getAPI` and would throw. Resolved lazily and remembered, so a window
  // where git is disabled does not re-probe on every focus change.
  interface GitApiLike {
    repositories?: readonly { rootUri?: { fsPath?: string } }[];
    openRepository?(uri: vscode.Uri): Promise<unknown>;
  }
  let gitApi: GitApiLike | null | undefined;
  const gitApiOnce = async (): Promise<GitApiLike | null> => {
    if (gitApi !== undefined) return gitApi;
    gitApi = null;
    try {
      const ext = vscode.extensions.getExtension('vscode.git');
      if (!ext) return gitApi;
      const exports: unknown = ext.isActive
        ? ext.exports
        : await ext.activate();
      const api = exports as {
        enabled?: boolean;
        getAPI?(version: number): GitApiLike;
      } | null;
      if (!api || api.enabled !== true || typeof api.getAPI !== 'function') {
        return gitApi;
      }
      gitApi = api.getAPI(1) ?? null;
    } catch (err) {
      logError('extension.gitApi', err);
      gitApi = null;
    }
    return gitApi;
  };
  const gitHost: GitHost = {
    // Synchronous by contract, so this reports nothing until the API has been
    // resolved once — which costs at most one extra `open` attempt on the very
    // first follow, and that attempt is itself harmless (the git extension
    // no-ops an already-open repository).
    repositories: () =>
      (gitApi?.repositories ?? [])
        .map((r) => r?.rootUri?.fsPath ?? '')
        .filter((p) => p !== ''),
    open: async (dir) => {
      const api = await gitApiOnce();
      if (!api || typeof api.openRepository !== 'function') return false;
      return (await api.openRepository(vscode.Uri.file(dir))) != null;
    },
  };
  const sourceControlSync = new SourceControlSync(gitHost);

  // WHICH DIRECTORY THE EXPLORER IS ROOTED AT, under `'directory'` scope.
  //
  // Normally nobody decides this: it is wherever the user's attention is. The
  // active session has a cwd, `matchProject` says which of the project's
  // directories claims that cwd (the same question the sidebar's subproject rows
  // ask, so the two always agree), and that is the answer.
  //
  // The OVERRIDE is the exception, and it exists because attention is not the
  // only way to mean a directory: clicking a row in the Project view means it
  // too, and there may be no session in that directory to focus. It is held
  // per window and in memory only — a reload lands back on the active session's
  // directory, which is the honest default rather than a stale click.
  let explorerDirOverride: string | null = null;

  /** The cwd of a session, by the same cascade the auto-switch uses: the tip of
   *  its chain first, since that is the row the user is actually looking at. */
  const cwdOfSession = (sessionId: string): string | undefined => {
    const tip = chainIndex.tipOf(sessionId);
    return (
      forest.nodes.get(tip)?.cwd ??
      forest.nodes.get(sessionId)?.cwd ??
      store.get(tip)?.cwd ??
      store.get(sessionId)?.cwd
    );
  };

  /** The lane a session was STARTED in, as a record — the only input that can
   *  tell two lanes on one directory apart, and the first rung of the follow
   *  ladder. Null for every session started by hand in a terminal and every one
   *  that predates the field, which is a normal state and not a gap. */
  const laneOfSession = (sessionId: string): SubprojectRecord | null => {
    try {
      const laneId = store.getSessionSubproject(sessionId);
      if (laneId === undefined) return null;
      return store.getSubproject(laneId) ?? null;
    } catch (err) {
      logError('extension.laneOfSession', err);
      return null;
    }
  };

  /** The directory the active session is working IN, as this project files it,
   *  or undefined when there is no active session or it belongs to some other
   *  project.
   *
   *  THIS project's claim gates the answer, not the tie-break's winner. Claims
   *  are plural (matchProjects): a directory two projects list answers with a
   *  stable alphabetical head, and asking for the head here meant that working
   *  in a shared directory of the project you are switched INTO re-rooted the
   *  Explorer at that project's main folder — because the head named the other
   *  one, and a foreign match reads as "no answer". The question this function
   *  asks is "does THIS project claim where the active session is, and where
   *  should the tree be rooted if so".
   *
   *  The claim is the GATE and no longer the answer. `ProjectMatch.dir` is the
   *  directory the project reaches the session THROUGH, which for a session
   *  inside a linked worktree is the worktree ROOT — so a session in
   *  `~/mono-feat-x/api/src` used to root the Explorer at `~/mono-feat-x` while
   *  the sidebar filed the very same session under the `api` lane. Two rules
   *  for one question. `planFollow` (src/follow.ts, pure and tested) is now the
   *  single rule, and it is deliberately called from HERE rather than beside the
   *  switch: this function is what the switch, the reload heal, the Project
   *  view's fallback mark and `showDirectoryInExplorer` all read, so routing it
   *  through the plan is what keeps every one of them from having its own
   *  answer. The claim remains the floor — a plan that says nothing leaves the
   *  behaviour exactly as it was before the plan existed. */
  const activeSessionDir = (project: ProjectRecord | null): string | undefined => {
    if (!project) return undefined;
    try {
      const sessionId = registry.activeSessionId();
      if (!sessionId) return undefined;
      const cwd = cwdOfSession(sessionId);
      const claim = claimantsOf(cwd).find((m) => m.project.id === project.id);
      if (!claim) return undefined;
      const plan = planFollow({
        sessionId,
        cwd,
        project,
        lane: laneOfSession(sessionId),
        worktrees: cwd !== undefined ? worktrees.get(cwd) : [],
        anchorPath,
      });
      return plan.dir === '' ? claim.dir : plan.dir;
    } catch (err) {
      logError('extension.activeSessionDir', err);
      return undefined;
    }
  };

  /** What `ExplorerSync` should root the tree at. Undefined means "you decide",
   *  which `desiredFolders` resolves to the project's main directory. */
  const explorerDirFor = (project: ProjectRecord | null): string | undefined =>
    explorerDirOverride ?? activeSessionDir(project);

  // ---------------------------------------------------------- 6b. accounts
  //
  // The one place the accounts feature is assembled: the store (the roster and
  // the pins), the limits reader (the usage numbers, and the only part of this
  // that touches the network), and the pure resolvers in accounts.ts /
  // routing.ts that neither of the two view layers may import directly.
  //
  // Everything below is wired unconditionally except the VIEW, which
  // `lineage.accounts.section` gates. The verbs stay registered either way:
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

  /** Mirror "is there anywhere to move a conversation TO" into the context key
   *  the session menu's `when` reads. Re-run on every store change: accounts
   *  are added and removed from this window and from others, and a menu entry
   *  that needed a reload to appear would be a menu entry nobody finds.
   *
   *  Through `canSwitchAccounts`, which is the same rule the PICKER is built
   *  from. It used to count `canHostSession` instead, and the two stopped
   *  agreeing the day the launcher learned to exec `codex`: on the roster this
   *  extension seeds by default — one Claude login, plus a Codex one whenever
   *  `~/.codex/auth.json` exists — the old count said two and the picker,
   *  which refuses a cross-CLI pair, was always empty. */
  let lastCanSwitch: boolean | null = null;
  const syncCanSwitchAccountContext = async (): Promise<void> => {
    let can = false;
    try {
      can = canSwitchAccounts(store.getAccounts());
    } catch (err) {
      logError('extension.canSwitchAccountContext', err);
      return;
    }
    if (can === lastCanSwitch) return;
    lastCanSwitch = can;
    try {
      await vscode.commands.executeCommand(
        'setContext',
        CONTEXT_CAN_SWITCH_ACCOUNT,
        can,
      );
    } catch (err) {
      logError('extension.canSwitchAccountContext', err);
    }
  };
  await syncCanSwitchAccountContext();
  context.subscriptions.push(
    store.onDidChange(() => {
      void syncCanSwitchAccountContext();
    }),
  );

  /** The same mirror for the HANDOFF entry, which asks the opposite question:
   *  two accounts running different clis rather than the same one. Kept as its
   *  own key and its own cache rather than folded into the block above, so
   *  that neither verb can start drawing on the other's roster. */
  let lastCanHandOff: boolean | null = null;
  const syncCanHandOffContext = async (): Promise<void> => {
    let can = false;
    try {
      can = canHandOff(store.getAccounts());
    } catch (err) {
      logError('extension.canHandOffContext', err);
      return;
    }
    if (can === lastCanHandOff) return;
    lastCanHandOff = can;
    try {
      await vscode.commands.executeCommand(
        'setContext',
        CONTEXT_CAN_HAND_OFF,
        can,
      );
    } catch (err) {
      logError('extension.canHandOffContext', err);
    }
  };
  await syncCanHandOffContext();
  context.subscriptions.push(
    store.onDidChange(() => {
      void syncCanHandOffContext();
    }),
  );

  /** The pinned account's launch fields for a conversation — what a resume, a
   *  reattach and a workspace restore all re-inject. `pinnedLaunchProfile`
   *  returns null for a dangling pin — and for a pin naming an account no
   *  session can run on — deliberately; both land the launch on the machine's
   *  default login rather than on somebody else's subscription. */
  const accountLaunchFor = (
    sessionId: string,
  ):
    | {
        env?: Readonly<Record<string, string>>;
        profileId?: string;
        provider?: ProviderId;
      }
    | undefined => {
    try {
      const profile = pinnedLaunchProfile(
        store.getSessionProfile(sessionId),
        store.getAccounts(),
      );
      if (!profile) return undefined;
      // From the SESSION's own record, never from the pinned account — see
      // commands.sessionLaunchProvider for why the two are allowed to differ
      // and why the conversation wins when they do.
      const provider = store.get(sessionId)?.provider === 'codex' ? 'codex' : undefined;
      return {
        env: envForProfile(profile),
        profileId: profile.id,
        ...(provider !== undefined ? { provider } : {}),
      };
    } catch (err) {
      logError('extension.accountLaunchFor', err);
      return undefined;
    }
  };

  /**
   * What a wrapped pane runs BETWEEN the two respawns — see
   * `switchSessionAccount` for why there are two.
   *
   * `exec` so the shell replaces itself and the pane's root process is the
   * sleep, which is what makes the next respawn's `-k` a clean single kill. The
   * duration is a day because nothing is ever supposed to reach it: if this is
   * still running, the switch died between its two halves and the user is
   * looking at the message, which is a better end state than an empty pane.
   */
  const SWITCH_HOLD_COMMAND: readonly string[] = [
    'sh',
    '-c',
    'echo "Flock: switching account — restarting Claude Code…"; exec sleep 86400',
  ];

  /** Poll until the wrapped pane's root process is no longer `was`, so the move
   *  cannot start while the old CLI is still flushing its transcript. Bounded:
   *  a pid we cannot read is not a reason to hang, and the respawn that changed
   *  it has already returned successfully. */
  const awaitPanePidChange = async (
    binary: string,
    name: string,
    was: number | undefined,
  ): Promise<void> => {
    if (was === undefined) return;
    for (let i = 0; i < 20; i++) {
      const now = await queryPanePid(binary, name);
      if (now === undefined || now !== was) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  /** Resolve once the registry says this session's terminal is gone, or after
   *  `ms`. The timeout is not a failure: `closeTerminal` disposes the pty
   *  synchronously and this only waits for the close EVENT, so a host that does
   *  not deliver one must not stall the switch forever. */
  const awaitTerminalExit = (sessionId: string, ms: number): Promise<void> =>
    new Promise((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        try {
          sub.dispose();
        } catch {
          /* already gone */
        }
        resolve();
      };
      const sub = registry.onDidExit((id) => {
        if (id === sessionId) finish();
      });
      setTimeout(finish, ms);
    });

  /**
   * THE MECHANISM behind "move this conversation to another account".
   * commands.ts owns the decision; this owns the four steps it takes, in the
   * one order that can be unwound.
   *
   *   1. STOP the process. Nothing may be moved while a claude is appending to
   *      it — that is the second-writer failure every resume path in this
   *      extension is built to avoid, arriving from the other direction.
   *   2. MOVE the bytes (accountMove.ts). The only step whose failure aborts,
   *      and the reason step 1 is separable: if this refuses, the process is
   *      restarted where it was and nothing has changed but a few seconds.
   *   3. RE-PIN, chain-wide (state.moveSessionProfile), and wire the target
   *      account's shared configuration. Without that last part a switch onto
   *      an account that has never been in this directory greets the resumed
   *      conversation with a trust dialog — technically correct, and not what
   *      anybody asked for by clicking "switch account".
   *   4. START it again on the new environment.
   *
   * TWO RESPAWNS, on the wrapped tier. `respawn-pane -k` kills and launches as
   * one operation, which is exactly what keeps the pane (and therefore the tab)
   * alive — and exactly why it cannot be the whole answer: there is no moment
   * between the kill and the launch to move a file in. So the pane is first
   * respawned onto a placeholder, which is the "stopped" state this function
   * needs and the user's only visible sign that anything is happening, and then
   * respawned again onto the resume once the bytes are where the resume will
   * look for them.
   */
  const switchSessionAccount = async (
    request: SwitchAccountRequest,
  ): Promise<SwitchAccountResult> => {
    const { sessionId, from, to, cwd, tabTitle } = request;
    const fail = (error: string): SwitchAccountResult => ({
      ok: false,
      inPlace: false,
      skipped: [],
      error,
    });

    const sources = profileConfigSources();
    if (sources.defaultDir === '') {
      return fail('Flock could not work out where your Claude config lives.');
    }
    const claude = claudeBin();
    if (claude === null) {
      return fail('the Claude Code binary could not be found.');
    }

    const pinnedDir = configDirForProfile(from, sources.defaultDir);
    const toDir = configDirForProfile(to, sources.defaultDir);
    const resumeArgv = [
      claude,
      ...buildShellArgs({ sessionId, resumeId: sessionId }),
    ];
    // Same shape the launcher builds, stamp last so it wins a collision.
    const envFor = (
      profile: AccountProfile | null,
    ): Record<string, string> => ({
      ...launchEnv(envForProfile(profile)),
      [ENV_NODE_ID]: sessionId,
    });
    /** Everything a launch on this roster could have set, minus everything the
     *  process being started actually needs — the variables it must NOT
     *  inherit.
     *
     *  Union with `accountEnvKeys` rather than just the source profile's own
     *  keys, because the pin does not know about the two ways a variable gets
     *  there without it: leaked from the tmux server's global environment (see
     *  TMUX_CONF), or left by a previous switch on an even older account.
     *  `envFor` always carries `LINEAGE_NODE_ID`, so the re-key stamp can never
     *  land in here.
     *
     *  `keep` is the ENVIRONMENT rather than the profile it usually comes from,
     *  and that is deliberate: the restore path has to keep a config dir the
     *  profile does not name (see `restoreEnv` below), and computing the removal
     *  list from the profile while the respawn is handed a different environment
     *  is how a variable ends up both set and removed in one command. */
    const staleEnvFor = (
      keep: Record<string, string>,
      leaving: AccountProfile | null,
    ): string[] => {
      const candidates = new Set<string>([
        ...Object.keys(envForProfile(leaving)),
        ...accountEnvKeys(store.getAccounts()),
      ]);
      return [...candidates].filter((key) => !(key in keep));
    };

    // WHICH TIER, over the whole generation chain. A terminal is bound — and a
    // tmux session named — under whichever id it LAUNCHED with, and a
    // compaction or a resume re-mints that id, so the tip alone is not where a
    // live process necessarily answers from. Every other terminal verb in this
    // file probes `chainAliases` for exactly this reason; asking the tip only
    // made this one verb blind to a binding sitting on an older generation, and
    // what a miss produces here is not a cosmetic slip: nothing gets stopped,
    // and the transcript is renamed out from under a running CLI.
    //
    // A recorded tmux name counts even when no terminal here is bound to it: a
    // parked conversation is running in the server, and restarting it there is
    // the same operation as restarting an attached one.
    const aliases = chainAliases(sessionId);
    const tmuxBinary = tmuxSpawn()?.binary ?? findTmuxBinary();
    const tmuxName =
      aliases
        .map((id) => registry.tmuxNameOf(id))
        .find((name): name is string => typeof name === 'string' && name !== '') ??
      aliases
        .map((id) => store.get(id)?.tmux)
        .find((name): name is string => typeof name === 'string' && name !== '');
    const boundHere = aliases.some((id) => registry.isBoundHere(id));

    // WHERE THE BYTES ACTUALLY ARE, and it is hoisted ABOVE the stop on
    // purpose. This function's own header promises that until the move lands
    // nothing has been touched, and that was only true of the move's own
    // refusals — a conversation whose pin had come apart from its file reached
    // `moveConversation`'s "no transcript in the account it is pinned to" after
    // the process had already been killed and restarted, so a user lost a turn
    // in flight to be told about a pin. Probing first makes a refusal free.
    //
    // And the probe FALLS BACK past the pin, because the pin is a claim and the
    // file is a fact: the tmux environment leak this same change fixes is a
    // mechanism that actively produced the disagreement, by resuming a moved
    // conversation under the config dir it had just left.
    const source = sourceDirFor(sessionId, {
      preferred: pinnedDir,
      roots: [sources.defaultDir, ...claudeProfileConfigDirs()],
    });
    if (source === null) {
      return fail(
        'its transcript could not be found in any account on this machine.',
      );
    }
    if (!source.matchedPreferred) {
      log(
        'accounts: switch found',
        shortId(sessionId),
        'outside the account it is pinned to —',
        source.dir,
      );
    }
    const fromDir = source.dir;

    // A MOVE THAT MOVES NOTHING, short-circuited above the stop.
    //
    // Two profiles can resolve to one config directory — the default login and
    // any provider with no config-dir variable both land on `~/.claude` — so
    // the palette can offer a "switch" that is a re-pin and nothing else, and
    // `moveConversation` says so by early-returning `ok` having renamed
    // nothing. It says so from inside step 2, though, which is after step 1 has
    // already killed and respawned the CLI: a change of label was costing the
    // turn in flight that the confirmation dialog warns about. `accounts.
    // switchMovesNothing` compares the ENVIRONMENTS as well as the
    // directories, because two profiles sharing a directory can still differ in
    // `extraEnv` (an API-key account is exactly that shape) and there the
    // restart is the entire point.
    //
    // Step 3's `ensureProfileConfig` is skipped along with the rest, and that is
    // not an omission: the directory the target account would be wired in is the
    // directory this conversation is already running in, so whatever wiring the
    // trust dialog needs has been there since the session started.
    if (switchMovesNothing({ fromDir, toDir, from, to })) {
      await store.moveSessionProfile(sessionId, to.id);
      log('accounts: re-pinned', shortId(sessionId), '->', to.id, '(in place)');
      return { ok: true, inPlace: true, running: 'in-place', skipped: [] };
    }

    // THE COLLISION, probed here rather than left to the move, for the same
    // reason `sourceDirFor` above it is: a refusal that arrives after the stop
    // costs a turn in flight to reach a sentence. `moveConversation` still
    // carries its own guard — it is the one that has to be right, since it
    // guards the rename itself — but by the time it fires the process is down.
    //
    // The facts on both files travel with the refusal, because this is the only
    // failure here that a person can act on: one of these two is their
    // conversation, and a size and a date is what tells them which.
    if (path.resolve(fromDir) !== path.resolve(toDir)) {
      const blocking = transcriptCopyInConfigDir(toDir, sessionId);
      const mine = transcriptCopyInConfigDir(fromDir, sessionId);
      if (blocking !== null && mine !== null) {
        return {
          ...fail(
            `the account it would move to already holds a transcript for it, ` +
              `at ${blocking.path}.`,
          ),
          duplicate: {
            otherPath: blocking.path,
            otherBytes: blocking.bytes,
            otherMtimeMs: blocking.mtimeMs,
            thisPath: mine.path,
            thisBytes: mine.bytes,
            thisMtimeMs: mine.mtimeMs,
          },
        };
      }
    }

    // ---- 1. stop ---------------------------------------------------------
    let wrapped = false;
    if (tmuxBinary !== null && tmuxName !== undefined) {
      const wasPid = await queryPanePid(tmuxBinary, tmuxName);
      wrapped = await respawnTmuxPane(tmuxBinary, {
        name: tmuxName,
        ...(cwd !== undefined ? { cwd } : {}),
        command: SWITCH_HOLD_COMMAND,
      });
      if (wrapped) await awaitPanePidChange(tmuxBinary, tmuxName, wasPid);
      // A respawn that failed means the server does not hold this session after
      // all — the name is stale. Fall through to the tiers below rather than
      // treating a missing wrap as a missing session.
    }
    const disposed = !wrapped && boundHere
      ? registry.closeTerminal(sessionId, { killTmux: true })
      : false;
    if (disposed) await awaitTerminalExit(sessionId, 3000);

    /** Put it back exactly where it was. Called only when the MOVE refused, so
     *  by definition the transcript never left the old account.
     *
     *  WHERE IT WAS IS `fromDir`, NOT THE PIN. `sourceDirFor` above looks past
     *  the pin on purpose — the pin is a claim, the file is a fact — and this
     *  function was rebuilding its environment from the profile, so on the one
     *  path that reaches it with a wrong pin (a pin naming one account, the
     *  bytes in a second, a collision in the third) the CLI came back up with
     *  `CLAUDE_CONFIG_DIR` pointing at an account that does not contain the
     *  conversation, and `claude --resume` found nothing. `restoreEnvFor` is
     *  `envForProfile` whenever the pin was right, so the ordinary path is
     *  untouched. */
    const restoreEnv = restoreEnvFor(from, fromDir, sources.defaultDir);
    const restore = async (): Promise<void> => {
      try {
        const restoreLaunchEnv = {
          ...launchEnv(restoreEnv),
          [ENV_NODE_ID]: sessionId,
        };
        if (wrapped && tmuxBinary !== null && tmuxName !== undefined) {
          const back = await respawnTmuxPane(tmuxBinary, {
            name: tmuxName,
            ...(cwd !== undefined ? { cwd } : {}),
            env: restoreLaunchEnv,
            // The roles reversed, and it matters for the same reason it
            // matters below: if `from` is the DEFAULT account its environment
            // names no config dir at all, so putting the conversation back
            // without a removal list would leave it running under whatever the
            // pane last had. Computed from the environment we are actually
            // handing the respawn, so a config dir `restoreEnv` had to add
            // cannot appear in both lists at once.
            remove: staleEnvFor(restoreLaunchEnv, to),
            command: resumeArgv,
          });
          if (back) return;
          // The pane will not take the conversation back; do not leave the
          // placeholder sitting there pretending to be a session.
          await killTmuxSessionTree(tmuxBinary, tmuxName);
        } else if (!disposed) {
          return; // nothing was stopped, so there is nothing to put back
        }
        await registry.launch({
          sessionId,
          resumeId: sessionId,
          ...(cwd !== undefined ? { cwd } : {}),
          ...(tabTitle !== undefined ? { title: tabTitle } : {}),
          env: restoreEnv,
          ...(from !== null ? { profileId: from.id } : {}),
        });
      } catch (err) {
        logError('extension.switchSessionAccount: restore failed', err);
      }
    };

    // ---- 2. move ---------------------------------------------------------
    const moved = await moveConversation({ sessionId, fromDir, toDir });
    if (!moved.ok) {
      await restore();
      return fail(moved.error ?? 'its transcript could not be moved.');
    }

    // ---- 3. re-pin and wire the target account ---------------------------
    await store.moveSessionProfile(sessionId, to.id);
    if (toDir !== sources.defaultDir) {
      // Idempotent and additive; the cost of calling it on an already-wired
      // profile is a handful of lstats, and the cost of NOT calling it on a
      // fresh one is a trust dialog in front of a conversation the user was
      // reading a second ago.
      //
      // AND FROM THE ACCOUNT IT IS LEAVING, as a second source. Seeding from
      // `~/.claude.json` alone covered exactly the moves that start at the
      // default login; an A → B move where only A had ever been in this
      // directory still met the dialog this call exists to prevent, because
      // the answer it needed was in A's identity file and nowhere else. A is
      // where the conversation was running a second ago, so A is where the
      // answer honestly comes from.
      await ensureProfileConfig(toDir, {
        ...sources,
        ...(fromDir !== sources.defaultDir
          ? { alsoSeedFrom: path.join(fromDir, '.claude.json') }
          : {}),
      });
    }

    // ---- 4. start --------------------------------------------------------
    let inPlace = false;
    if (wrapped && tmuxBinary !== null && tmuxName !== undefined) {
      inPlace = await respawnTmuxPane(tmuxBinary, {
        name: tmuxName,
        ...(cwd !== undefined ? { cwd } : {}),
        env: envFor(to),
        // THE HALF THAT WAS MISSING, and the reason a switch could look like it
        // worked and resume on the wrong account anyway. `-e` on a respawn can
        // only SET; the tmux session environment survives the respawn intact.
        // So moving a wrapped conversation to an account with a smaller
        // environment than the one it is leaving — most obviously back to the
        // default login, which sets no config dir at all — left the previous
        // account's `CLAUDE_CONFIG_DIR` sitting there, and `claude --resume`
        // went looking in the directory the transcript had just been moved out
        // of. See tmux.respawnCommands for why the removals must precede the
        // respawn rather than follow it.
        remove: staleEnvFor(envFor(to), from),
        command: resumeArgv,
      });
      if (!inPlace) {
        // The placeholder is still in that pane, and `new-session -A` below
        // would ATTACH to it rather than start anything. Kill it first.
        await killTmuxSessionTree(tmuxBinary, tmuxName);
      }
    }
    if (!inPlace && (wrapped || disposed)) {
      const binding = await registry.launch({
        sessionId,
        resumeId: sessionId,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(tabTitle !== undefined ? { title: tabTitle } : {}),
        env: envForProfile(to),
        profileId: to.id,
      });
      if (binding === null) {
        // The conversation IS on the new account — the bytes and the pin both
        // moved — it simply has no terminal. Say so rather than claiming a
        // failure that would send the user looking for a session that is fine.
        // `inPlace: false` alone used to render as "(in a new terminal)",
        // which sent them looking anyway; `running` is what carries the
        // difference now.
        return {
          ok: true,
          inPlace: false,
          running: 'not-running',
          skipped: moved.skipped,
        };
      }
    }
    // WHAT IS RUNNING, in the four states rather than the two.
    //
    // The last of them is the one worth the extra field. Nothing was wrapped
    // and nothing was disposed means nothing here could be stopped — which is
    // "nothing was running" only when nothing WAS. It is also what a session
    // held by another Flock window looks like from here on a machine with no
    // tmux, and that case used to be reported as a clean in-place move while
    // the bytes had in fact been renamed under a live CLI. commands.ts now
    // refuses that before we are reached, so this should be unreachable; it is
    // reported honestly rather than assumed away, because "should be
    // unreachable" is how the first version of this got written.
    const running: SwitchRunningState = inPlace
      ? 'in-place'
      : wrapped || disposed
        ? 'relaunched'
        : sessionHostOf(sessionId) === 'none'
          ? 'not-running'
          : 'unknown';
    log('accounts: switched', shortId(sessionId), '->', to.id, `(${running})`);
    return {
      ok: true,
      // The boolean every existing caller reads, and it cannot disagree with
      // the state above: only 'in-place' is in place.
      inPlace: running === 'in-place',
      running,
      skipped: moved.skipped,
    };
  };

  let accountsViewController: AccountsViewController | undefined;

  /** The retired `lineage.accounts.enabled`, raw. Only a literal `false`
   *  still means anything (accounts.accountsSectionDrawn). Read fresh on every
   *  call, so deleting the key by hand takes effect on the next configuration
   *  event rather than the next reload. */
  const legacyAccountsEnabled = (): unknown =>
    cfg().get<unknown>(LEGACY_KEYS.accountsEnabled);
  /** Whether the Accounts list should be registered: the section switch, with
   *  the folded key honoured where it still says `false`. */
  const accountsSectionOn = (): boolean =>
    accountsSectionDrawn(
      boolCfg(CONFIG_KEYS.accountsSection, true),
      legacyAccountsEnabled(),
    );

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
    switchSessionAccount,
    // The same probe `switchSessionAccount` runs before its stop step, asked
    // one step earlier so the refusal can be a sentence instead of a
    // half-finished move. Over the whole generation chain, because a terminal
    // and a tmux session are named after whichever id the launch used and a
    // compaction re-mints that id. See AccountDeps.canRestartSession.
    canRestartSession: (sessionId) => {
      try {
        if ((tmuxSpawn()?.binary ?? findTmuxBinary()) === null) return false;
        return chainAliases(sessionId).some((id) => {
          const recorded = store.get(id)?.tmux;
          return (
            registry.tmuxNameOf(id) !== undefined ||
            (typeof recorded === 'string' && recorded !== '')
          );
        });
      } catch (err) {
        logError('extension.canRestartSession', err);
        return false;
      }
    },
    // Asked by the confirmation dialog so the sentence in front of the user
    // matches what the mechanism will do — see AccountDeps.switchMovesNothing.
    // It re-runs the same `sourceDirFor` probe rather than trusting the pin,
    // because the whole question is whether the BYTES have anywhere to go.
    switchMovesNothing: (sessionId, to) => {
      try {
        const sources = profileConfigSources();
        if (sources.defaultDir === '') return false;
        const from = pinnedProfile(
          store.getSessionProfile(sessionId),
          store.getAccounts(),
        );
        const found = sourceDirFor(sessionId, {
          preferred: configDirForProfile(from, sources.defaultDir),
          roots: [sources.defaultDir, ...claudeProfileConfigDirs()],
        });
        if (found === null) return false;
        return switchMovesNothing({
          fromDir: found.dir,
          toDir: configDirForProfile(to, sources.defaultDir),
          from,
          to,
        });
      } catch (err) {
        logError('extension.switchMovesNothing', err);
        return false;
      }
    },
    setAsideTranscript: (transcriptPath) => setAsideTranscript(transcriptPath),
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
    codexBinary: () => codexBin(),
    mediaPath,
    refreshAccounts: () => accountsViewController?.refresh(),
    // The limits module's own wording, so the meter reads identically wherever
    // it appears — the row, the account picker, the project's routing dialog.
    formatUsage: (snapshot) => formatUsageSummary(snapshot),
  };

  if (accountsSectionOn()) {
    accountsViewController = registerAccountsView(accountDeps);
    context.subscriptions.push(accountsViewController);
  } else if (legacyAccountsEnabled() === false) {
    // Said once, here, because the Settings editor no longer can: the key is
    // gone from the manifest, so nothing else on screen explains why the list
    // is missing. Only the section key can hide the header now, and only the
    // user's own gear gesture writes it.
    log(
      'accounts: lineage.accounts.enabled is retired but still honoured — it is false here, so the Accounts list is not registered.',
      'lineage.accounts.section is the switch now; Hide Accounts Section in the gear writes it and clears the old key.',
    );
  }

  // ------------------------------------------------------------ 6c. shells
  //
  // The third section: one row per COMMAND Claude is running — the `npm test`
  // it decided to execute inside a session, not the terminal the session
  // itself lives in. See src/shellsView.ts for why that is a view of its own
  // rather than more rows in the tree: its unit lives for eleven seconds and
  // there are hundreds per conversation, so folding them in would bury the
  // lineage the tree exists to show.
  //
  // MACHINE-WIDE, unlike everything else registered in this block. The facts
  // come off transcripts on disk rather than out of this window's terminal
  // registry, so a script running in a session another window launched is a
  // row here like any other.
  /**
   * The live sessions, resolved to transcripts.
   *
   * LIVE ONLY, and that is the view's correctness rule rather than a cost
   * saving: "no result yet" means "still executing" only for a session whose
   * process is alive, and a conversation killed mid-command leaves behind a
   * tool call that will never be answered. See ShellDeps.sessions.
   *
   * Paths come off the archive index, which has already stat'ed every
   * transcript on its own sweep, and fall back to a direct resolve for a
   * session so new the last sweep has not seen it — which is exactly the
   * session most likely to be running something right now.
   */
  const shellSessions = (): ShellSessionInfo[] => {
    const paths = new Map<string, string>();
    for (const s of archiveIndexer.current()) {
      paths.set(s.sessionId, s.transcriptPath);
    }
    const out: ShellSessionInfo[] = [];
    for (const node of forest.nodes.values()) {
      if (node.ghost || node.archived || node.deleted) continue;
      if (node.status === 'exited') continue;
      // A Codex session's rollout file is a different format entirely and
      // holds no Bash tool calls of this shape; it would parse to nothing.
      if (sessionProviderFor(node.id) === 'codex') continue;
      const file =
        paths.get(node.id) ??
        transcriptFile(node.id, { extraProjectsDirs: profileProjectsDirs() });
      if (file === null || file === undefined || file === '') continue;
      out.push({
        id: node.id,
        label: node.label,
        transcriptPath: file,
        ...(node.cwd === undefined ? {} : { cwd: node.cwd }),
      });
    }
    return out;
  };
  const shellsViewController = registerShellsView({
    sessions: shellSessions,
    // The roster tick, which is also what rebuilds the forest — so the scan
    // for new commands rides the extension's existing heartbeat rather than
    // adding a timer of its own. The view starts its own one-second clock on
    // top of this only while something is actually running and on screen.
    onDidChange: (listener) => {
      const subs = [onForestChanged.event(() => listener())];
      return {
        dispose(): void {
          for (const sub of subs) {
            try {
              sub.dispose();
            } catch (err) {
              logError('extension.shells.dispose', err);
            }
          }
        },
      };
    },
  });
  context.subscriptions.push(shellsViewController);

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

  // ------------------------------------------------- the at-the-limit offer
  //
  // OFF BY DEFAULT (CONFIG_KEYS.offerSwitchAtLimit). Flock already knows every
  // account's five-hour window, and the moment one of them fills is exactly the
  // moment somebody with a second subscription wants to move the conversation
  // they were in the middle of — so the extension is in a position to say so
  // before the user goes looking. It is still an interruption, and one that
  // proposes another interruption, which is why it is opt-in rather than
  // merely dismissible.
  //
  // ONCE PER WINDOW, keyed on the exhausted window's own reset time: the usage
  // cache re-reads on a timer, so a naive check would re-offer on every fetch
  // until the window rolled over. When it does roll over the key changes by
  // itself, and a conversation that fills the SAME account again gets one fresh
  // offer, which is right — that is a new thing having happened.
  const offeredAtLimit = new Map<string, number>();

  /** Non-exhausted accounts this conversation could move to, best first: an
   *  already-open window beats an untouched one, for the reason routing.ts
   *  gives — the open window is a sunk cost and spending it is free.
   *
   *  Through `offerSwitch` and therefore through the CONVERSATION's CLI, which
   *  is the sessionId argument's only job. Filtering on `switchRefusal` alone
   *  — what this used to do — asks half the question: two Codex logins are a
   *  legal pair by that rule, because they really are the same CLI, and the
   *  verb behind the notification button then refuses every non-Claude
   *  conversation. The result was an offer whose one button led to a refusal,
   *  which is a worse interruption than the silence it replaced. */
  const switchTargetsFor = (
    sessionId: string,
    from: AccountProfile | null,
    now: number,
  ): AccountProfile[] => {
    const offer = offerSwitch({
      cli: sessionProviderFor(sessionId) === 'codex' ? 'codex' : 'claude',
      from,
      profiles: store.getAccounts(),
    });
    if (offer.kind !== 'ok') return [];
    const rank = (p: AccountProfile): number =>
      rankUsage(usageCache.get(p), now) === 'open' ? 0 : 1;
    return offer.targets
      .filter((p) => rankUsage(usageCache.get(p), now) !== 'exhausted')
      .sort((a, b) => rank(a) - rank(b));
  };

  const maybeOfferSwitchAtLimit = async (): Promise<void> => {
    if (!boolCfg(CONFIG_KEYS.offerSwitchAtLimit, false)) return;
    const now = Date.now();
    const accounts = store.getAccounts();
    // Sessions THIS window hosts, and only those: the offer restarts a process,
    // and two windows both proposing to restart the same one is a race with a
    // dialog in it.
    for (const sessionId of registry.boundSessionIds()) {
      try {
        const from = pinnedProfile(store.getSessionProfile(sessionId), accounts);
        if (from === null) continue; // no pin, no meter, nothing to be full
        const snapshot = usageCache.get(from);
        if (rankUsage(snapshot, now) !== 'exhausted') continue;

        const key = snapshot?.fiveHour?.resetsAt;
        if (typeof key !== 'number' || !Number.isFinite(key)) continue;
        if (offeredAtLimit.get(sessionId) === key) continue;

        const [best] = switchTargetsFor(sessionId, from, now);
        if (!best) continue; // nowhere to go: the offer would be a complaint
        offeredAtLimit.set(sessionId, key);

        const label =
          forest.nodes.get(sessionId)?.label ??
          store.get(sessionId)?.title ??
          shortId(sessionId);
        const MOVE = `Move to ${best.label}`;
        const choice = await vscode.window.showInformationMessage(
          `Flock: ${from.label} has used up its five-hour window, and ` +
            `"${label}" is running on it.`,
          MOVE,
        );
        if (choice !== MOVE) continue;
        // Through the ordinary verb, with the account already named. The modal
        // it puts up is not skipped: pressing a notification button is not
        // consent to restart a process and lose a prompt cache.
        await vscode.commands.executeCommand(
          COMMANDS.switchSessionAccount,
          sessionId,
          best.id,
        );
      } catch (err) {
        logError('extension.maybeOfferSwitchAtLimit', err);
      }
    }
  };
  context.subscriptions.push(
    usageCache.onDidChange(() => {
      void maybeOfferSwitchAtLimit();
    }),
  );

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
    // The chat tier's kill: `killTmux` sends a wrapped chat through
    // killTmuxSessionTree, and the registry's bare path walks and reaps on
    // its own — either way the whole process tree ends, never just the pane
    // root. Chats are the one thing a switch ends rather than detaches: they
    // have no tree row, so a graced chat would be a running process with no
    // surface anywhere.
    endSessionTab: (id) =>
      chainAliases(id).some((alias) =>
        registry.closeTerminal(alias, { killTmux: true }),
      ),
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
    // The detach grace window (minutes) — the shared reader above, so the
    // switch's detach tier and the window-close stamp can never disagree.
    detachGraceMinutes,
    // The quality-of-life mode: parkOthers is a no-op without it, and the
    // restore step brings back one session instead of the whole saved set.
    soloSession: () => boolCfg(CONFIG_KEYS.soloSession, false),
    // With sessions in the panel there are no session tabs to park or restore,
    // so a switch leaves terminals alone entirely and snapshots files only.
    terminalLocation,
    // Swap the Explorer's folder tree to the target project as part of
    // the switch. Gated on the setting, and a no-op in any window that was
    // never converted into a Flock workspace — the switch itself does not
    // care either way (see WorkspaceManagerDeps.syncExplorer).
    syncExplorer: async (project) => {
      if (!boolCfg(CONFIG_KEYS.explorerFollowProject, true)) return;
      // A switch is a new project, so a click made inside the old one no longer
      // means anything — the tree lands on whatever the target's own attention
      // says, which for a restore is the session it is about to focus.
      explorerDirOverride = null;
      await explorerSync.sync(project, explorerDirFor(project));
    },
    // THE DEEP SWITCH's arrival gesture. The decision is planDeepReveal
    // (src/deepSwitch.ts, pure); this supplies its world:
    //
    //   * the LANE — the auto-switch's trigger session carries a lane stamp
    //     (EditorialRecord.subprojectId, read off the chain tip because a
    //     re-key moves the record), and that lane is what narrows the reveal
    //     from the project's root to the folder the user actually moved into.
    //     A stamp naming another project's lane is ignored, not followed: the
    //     switch is arriving at THIS project.
    //   * the WORKTREES — deliberately NOT behind `lineage.git.branches`.
    //     That setting hides the branch ROWS; the probe itself already runs
    //     ungated for grouping (see worktreesOf above), and the deep switch is
    //     specified to work with the rows off. A MANUAL switch warms the probe
    //     (a user-facing verb under a spinner can afford one `git worktree
    //     list`); an AUTO switch takes the cache as it stands — focus-follows
    //     is a side effect of just working and must not gain a subprocess
    //     await, so a cold cache merely costs it the note, never the switch.
    revealSwitchTarget: async (project, opts) => {
      let lane;
      if (opts.trigger !== null) {
        const rec =
          store.get(chainIndex.tipOf(opts.trigger)) ?? store.get(opts.trigger);
        const laneId = rec?.subprojectId;
        if (typeof laneId === 'string' && laneId !== '') {
          const candidate = store.getSubproject(laneId);
          if (candidate && candidate.projectId === project.id) lane = candidate;
        }
      }
      const probeDir = lane?.dir ?? project.rootDir;
      if (typeof probeDir !== 'string' || probeDir.trim() === '') return '';
      const list = opts.auto
        ? worktrees.get(probeDir)
        : await worktrees.warm(probeDir);
      const plan = planDeepReveal({
        rootDir: project.rootDir,
        laneDir: lane?.dir,
        pinnedBranch: lane?.branch,
        worktrees: list,
      });
      if (plan.dir === '') return '';
      // The REVEAL is manual-only. An auto switch fires every time focus moves
      // into another project's session — yanking the Explorer's selection (and
      // momentarily its focus) on every such click is chrome the "side effect
      // of just working" path must not have. The git-context note still
      // travels: it costs nothing and lands in a status-bar summary.
      if (!opts.auto) {
        try {
          // `revealInExplorer` on a folder outside the window's workspace
          // roots is a no-op in some hosts and a rejection in others; both are
          // fine — the unconverted-window case degrades to "no reveal",
          // exactly as the syncExplorer splice above does.
          await vscode.commands.executeCommand(
            'revealInExplorer',
            vscode.Uri.file(plan.dir),
          );
        } catch (err) {
          log('workspaces: explorer reveal skipped —', String(err));
        }
      }
      return plan.note;
    },
    refresh: () => refreshNow(),
    suspendViews,
    resumeViews,
  });
  isWorkspaceSwitching = () => workspaceManager.isSwitching();
  activeProjectIdNow = () => workspaceManager.activeProjectId();

  /**
   * `lineage.soloSession`, second half: pin the kept session's editor tab so
   * it sits at the left of its group and survives "Close Others". Best-effort
   * and guarded three ways, because `workbench.action.pinEditor` acts on
   * whatever editor is active and cannot report that it pinned the wrong one:
   * the workbench's active terminal must be the kept session's (every flow
   * that calls this has just revealed it), the active TAB must be a terminal
   * tab (panel-located sessions have none, and the pref check alone cannot
   * cover a session launched under an older pref), and an already-pinned tab
   * is left alone.
   */
  const pinSoloTab = async (sessionId: string): Promise<void> => {
    try {
      if (terminalLocation() === 'panel') return;
      const active = registry.activeSessionId();
      if (active === null || !chainAliases(sessionId).includes(active)) return;
      const tab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
      if (!tab || !(tab.input instanceof vscode.TabInputTerminal)) return;
      if (tab.isPinned === true) return;
      await vscode.commands.executeCommand('workbench.action.pinEditor');
    } catch (err) {
      logError('extension.pinSoloTab', err);
    }
  };

  // ------------------------------------------------- chat auto-close sweep
  //
  // `lineage.chat.autoCloseMinutes`: a project chat's tab closes itself after
  // N minutes without use. A chat has no tree row, so none of the machinery
  // that tidies session tabs applies to it — solo mode exempts it on purpose,
  // and a switch only stows it away from foreign projects — which is how
  // finished chats piled up as tabs. The DECISION is chatAutoCloseVictims
  // (src/chatAutoClose.ts, pure and tested); this supplies the world: which
  // tabs are chats, which is active, what the roster says, when each was last
  // used. Every read is the same source its surface uses — status from the
  // roster entries the tree's dots read, activity from the transcript mtime
  // the busy-destaler reads — so the sweep cannot disagree with the screen.

  /** Not numCfg: that helper treats a non-positive value as "unset" and would
   *  resurrect the default — but 0 is this setting's off switch. */
  const chatAutoCloseMinutes = (): number => {
    const v = cfg().get<number>(CONFIG_KEYS.chatAutoCloseMinutes);
    return typeof v === 'number' && Number.isFinite(v) && v >= 0
      ? v
      : DEFAULT_CHAT_AUTO_CLOSE_MINUTES;
  };
  const sweepIdleChats = (): void => {
    try {
      // A switch owns the tabs while it runs: it disposes and launches
      // terminals of its own, and a close landing mid-switch would race the
      // restore's bookkeeping. The next tick is a minute away — nothing about
      // "idle for half an hour" needs it sooner.
      if (workspaceManager.isSwitching()) return;
      const minutes = chatAutoCloseMinutes();
      if (minutes <= 0) return;
      const now = Date.now();
      const active = registry.activeSessionId();
      const activeTip = active === null ? null : chainIndex.tipOf(active);
      const tabs = registry.bindings().map((binding) => {
        // Every fact is asked over the CHAIN, not one id: the terminal is
        // bound under its launch-time id, the roster reports whichever
        // generation is running, and the `chat`/`launchedByUs` flags live on
        // the birth record — after a reopen or two those are three different
        // ids for one conversation.
        const aliases = chainAliases(binding.sessionId);
        const entry = lastEntries.find((e) => aliases.includes(e.sessionId));
        // Last use = the newest transcript write any generation made, the
        // same freshness probe the busy-destaler trusts. A chat that has not
        // been spoken to yet has no transcript (claude writes lazily), so the
        // bind time stands in — the window then counts from the tab opening.
        const mtimes = aliases
          .map((id) =>
            transcriptMtimeMs(id, { extraProjectsDirs: profileProjectsDirs() }),
          )
          .filter((m): m is number => m !== null);
        return {
          sessionId: binding.sessionId,
          // `launchedByUs` folded in: a chat some other window launched is
          // not this window's to close — its own sweep will get it.
          isChat:
            aliases.some((id) => store.get(id)?.chat === true) &&
            aliases.some((id) => store.get(id)?.launchedByUs === true),
          isActiveTab:
            activeTip !== null && chainIndex.tipOf(binding.sessionId) === activeTip,
          status: entry === undefined ? ('unknown' as const) : normalizeStatus(entry).status,
          // The user half of the clock, exactly as the session sweep folds it
          // in: opening a chat to re-read the answer is using the chat, and it
          // writes nothing to the transcript. Without it a chat you had open
          // and kept glancing at closed on the strength of the model's silence.
          lastActivityMs: lastEngagementMs({
            lastRecordMs: mtimes.length > 0 ? Math.max(...mtimes) : undefined,
            touchedMs: lastTouchedMs(aliases),
            fallbackMs: binding.createdAt,
          }),
        };
      });
      const idleOf = new Map(tabs.map((t) => [t.sessionId, t.lastActivityMs]));
      for (const id of chatAutoCloseVictims({
        now,
        autoCloseMinutes: minutes,
        tabs,
      })) {
        // `killTmux`, and NEVER `parked`: parked means "a switch will bring
        // this back", which is exactly wrong here — the chat is done until
        // asked for, and Chat History is how it is asked for. Without the
        // kill a wrapped chat would only detach, leaving a hidden claude
        // running forever for a conversation nobody is in.
        if (registry.closeTerminal(id, { killTmux: true })) {
          const idleMin = Math.round((now - (idleOf.get(id) ?? now)) / 60_000);
          log(`chat: auto-closed ${shortId(id)} after ${String(idleMin)}m idle`);
        }
      }
    } catch (err) {
      logError('extension.sweepIdleChats', err);
    }
  };
  // ------------------------------------------------- session lifecycle sweep
  //
  // The chat sweep, generalized to EVERY session (design/levels-and-modes.md):
  // level 1 (running, shown) drains to level 2 (archived row, click to
  // resume) on `lineage.session.closeAfterMinutes` of idleness, and the
  // detach grace — the countdown a workspace switch leaves a tmux-wrapped
  // process running under — expires here too. The DECISION is
  // idleCloseDecisions (src/idleClose.ts, pure and tested); this supplies the
  // world and acts. Two fact sources, one decision:
  //
  //   * BOUND tabs — this window's terminals, same reads as the chat sweep,
  //     except idleness: the last REAL transcript record's timestamp (via
  //     readTailStats), never mtime — hooks touch transcripts without new
  //     content, and an mtime clock never fires on an abandoned session.
  //   * GRACED records — sessions detached under a deadline. No binding
  //     anywhere (their terminal was disposed), so they are read off the
  //     store; expiry kills the wrap's whole process TREE (~8 MCP children).
  //
  // Every 1→2 transition runs the resumeLeaf repair, so an archived row is
  // provably resumable AT REST, not just when clicked. (The repair may skip
  // with 'writing' right after a kill — the on-resume-click repair still
  // covers that row; the spec runs it at both points for exactly this
  // reason.)

  /** Same not-numCfg rule as the chat window: 0 is the off switch. */
  const sessionCloseAfterMinutes = (): number => {
    const v = cfg().get<number>(CONFIG_KEYS.sessionCloseAfterMinutes);
    return typeof v === 'number' && Number.isFinite(v) && v >= 0
      ? v
      : DEFAULT_SESSION_CLOSE_AFTER_MINUTES;
  };

  /** Epoch ms of the newest `touchedAt` any generation carries — the USER
   *  half of the idle clock (see noteTouched). Non-finite when the
   *  conversation has never been clicked since the field shipped, which every
   *  reader below folds away rather than treats as zero. */
  const lastTouchedMs = (aliases: readonly string[]): number => {
    let best = Number.NaN;
    for (const id of aliases) {
      const at = Date.parse(store.get(id)?.touchedAt ?? '');
      if (!Number.isFinite(at)) continue;
      if (!Number.isFinite(best) || at > best) best = at;
    }
    return best;
  };

  /** Epoch ms of the last real conversation record any generation wrote —
   *  the CONVERSATION half of the idle clock. Non-finite (NaN) when no
   *  generation has a transcript yet, which the decision reads as "never
   *  close on not knowing". */
  const lastRealActivityMs = (aliases: readonly string[]): number => {
    let best = Number.NaN;
    for (const id of aliases) {
      const file = transcriptFile(id, {
        extraProjectsDirs: profileProjectsDirs(),
      });
      if (file === null) continue;
      const at = readTailStats(file).lastRecordAt;
      if (at !== undefined && (!Number.isFinite(best) || at > best)) best = at;
    }
    return best;
  };

  /** End a DETACHED session to level 2: kill its wrap (tree and all), stamp
   *  the record archived, run the at-rest repair. The one kill everything
   *  detached funnels through — grace expiry, pool eviction, the Close Now
   *  verb, the activation reconcile. */
  const endDetached = async (sessionId: string, why: string): Promise<void> => {
    const record = store.get(sessionId);
    const name =
      typeof record?.tmux === 'string' && record.tmux !== ''
        ? record.tmux
        : undefined;
    if (name !== undefined) {
      const binary = tmuxSpawn()?.binary ?? findTmuxBinary();
      if (binary !== null) await killTmuxSessionTree(binary, name);
    }
    await store.upsert(sessionId, {
      closed: new Date().toISOString(),
      graceUntil: null,
      tmux: null,
      closeAfterTurn: false,
    });
    repairResumeLeaf(sessionId, { extraProjectsDirs: profileProjectsDirs() });
    log(`lifecycle: ${why} — ${shortId(sessionId)} is archived (level 2)`);
  };

  const sweepSessionLifecycle = (): void => {
    try {
      // Same guard as the chat sweep: a switch owns the tabs while it runs.
      if (workspaceManager.isSwitching()) return;
      const now = Date.now();
      const active = registry.activeSessionId();
      const activeTip = active === null ? null : chainIndex.tipOf(active);
      const facts: SessionCloseFacts[] = [];
      const boundTips = new Set<string>();

      for (const binding of registry.bindings()) {
        const aliases = chainAliases(binding.sessionId);
        const tip = chainIndex.tipOf(binding.sessionId);
        boundTips.add(tip);
        // Chats have their own sweep above (their rules and their setting
        // predate this one); a session another window launched is not this
        // window's to close — its own sweep will get it.
        if (aliases.some((id) => store.get(id)?.chat === true)) continue;
        if (!aliases.some((id) => store.get(id)?.launchedByUs === true)) continue;
        const entry = lastEntries.find((e) => aliases.includes(e.sessionId));
        facts.push({
          sessionId: binding.sessionId,
          isActiveTab: activeTip !== null && tip === activeTip,
          status:
            entry === undefined ? ('unknown' as const) : normalizeStatus(entry).status,
          pinned: aliases.some((id) => store.get(id)?.pinned === true),
          closeAfterTurn: aliases.some(
            (id) => store.get(id)?.closeAfterTurn === true,
          ),
          // BOTH halves of the clock, newest wins. A session that has neither
          // counts from its tab opening, exactly as the chat sweep does — and
          // note that the touch is what makes that fallback safe: a long-open
          // tab whose transcript tail happened to hide its last record used to
          // read as idle since the tab opened, which for a tab opened this
          // morning meant closing a session clicked a minute ago.
          lastActivityMs: lastEngagementMs({
            lastRecordMs: lastRealActivityMs(aliases),
            touchedMs: lastTouchedMs(aliases),
            fallbackMs: binding.createdAt,
          }),
        });
      }

      const liveWindows = new Set(store.getWindows().map((w) => w.windowId));
      for (const record of Object.values(store.all())) {
        if (record.graceUntil == null) continue;
        const tip = chainIndex.tipOf(record.id);
        // Bound here = already level 1 again; a restore raced the sweep and
        // the bound facts above own the row now.
        if (boundTips.has(tip)) continue;
        // Claimed by a live foreign window (mid-restore there) — not ours.
        if (
          typeof record.boundWindowId === 'string' &&
          record.boundWindowId !== focusIntegration.windowId &&
          liveWindows.has(record.boundWindowId)
        ) {
          continue;
        }
        const deadline = Date.parse(record.graceUntil);
        const aliases = chainAliases(record.id);
        const entry = lastEntries.find((e) => aliases.includes(e.sessionId));
        facts.push({
          sessionId: record.id,
          isActiveTab: false, // grace means the tab is gone by definition
          status:
            entry === undefined ? ('unknown' as const) : normalizeStatus(entry).status,
          pinned: aliases.some((id) => store.get(id)?.pinned === true),
          closeAfterTurn: record.closeAfterTurn === true,
          // An unparseable deadline reads as already expired: a corrupt stamp
          // must not hold a hidden process open forever.
          graceUntilMs: Number.isFinite(deadline) ? deadline : 0,
          // No fallback: a graced record with neither clock is genuinely
          // unknown, and unknown is never closed by the timer and sorts LAST
          // out the door on pool overflow. The grace's own deadline still
          // expires on time — that is an absolute stamp, not an idleness
          // measurement, and a touch does not extend it.
          lastActivityMs: lastEngagementMs({
            lastRecordMs: lastRealActivityMs(aliases),
            touchedMs: lastTouchedMs(aliases),
          }),
        });
      }

      const plan = idleCloseDecisions({
        now,
        closeAfterMinutes: sessionCloseAfterMinutes(),
        sessions: facts,
      });

      for (const id of plan.close) {
        // `killTmux` — the dep is the TREE kill, so the wrap's MCP children
        // go with it — and never a detach: the timer's whole verdict is that
        // nobody is coming back soon.
        if (registry.closeTerminal(id, { killTmux: true })) {
          const tip = chainIndex.tipOf(id);
          void store.upsert(tip, {
            closed: new Date().toISOString(),
            closeAfterTurn: false,
            boundWindowId: null,
          });
          repairResumeLeaf(tip, { extraProjectsDirs: profileProjectsDirs() });
          log(`lifecycle: idle-closed ${shortId(id)} (level 2)`);
        }
      }
      for (const id of plan.graceKill) {
        void endDetached(id, 'grace expired');
      }
      for (const id of plan.graceEvict) {
        void endDetached(id, 'grace pool over cap (oldest idle)');
      }
      for (const id of plan.markCloseAfterTurn) {
        void store.upsert(chainIndex.tipOf(id), { closeAfterTurn: true });
        log(`lifecycle: ${shortId(id)} is busy — closing after this turn`);
      }
      for (const id of plan.clearCloseAfterTurn) {
        void store.upsert(chainIndex.tipOf(id), { closeAfterTurn: false });
      }
    } catch (err) {
      logError('extension.sweepSessionLifecycle', err);
    }
  };

  // Its own timer rather than a rider on the roster poll: the poll interval is
  // a latency knob (and pokeNow bursts it), while this is a lifecycle measured
  // in tens of minutes — one check a minute is both cheap and plenty. The
  // session sweep rides the SAME tick as the chat sweep (the spec's "widen the
  // existing timer"): one clock, two decision tables, no second cadence to
  // reason about.
  const chatSweepTimer = setInterval(() => {
    sweepIdleChats();
    sweepSessionLifecycle();
    // Keep each bare terminal's descendant snapshot fresh (terminals.ts): the
    // user's tab X reaches the registry only after the pty died, so its reap
    // acts on the last walk — this tick is what bounds that walk's age to a
    // minute. A handful of `ps` calls, and only for bare bindings.
    try {
      registry.refreshBareDescendants();
    } catch (err) {
      logError('extension.refreshBareDescendants', err);
    }
    // And persist that snapshot to this window's rescue ledger (5c above) on
    // the same beat: what a crash or a window close leaves on disk is then at
    // most a minute behind the truth — the bound the next activation's
    // verified reap works within. (Reads the PREVIOUS tick's walk, which only
    // widens the bound by the walk's own latency, never breaks it.)
    void persistBareRescueSnapshot();
    // The countdown rides this tick too — and since the 2026-08-28 review it
    // is the HOVER it keeps honest, not a row. The distinction matters here and
    // nowhere else: the native tree resolves its tooltip lazily, at the moment
    // the pointer stops, so that surface is always current on its own. The
    // inline sidebar computes `row.tooltip` at BUILD time and posts it to the
    // webview with the model, so without this nudge a webview left alone would
    // hand back "closing in 9m" ten minutes after the fact. Rows repaint on
    // data change (the 3 s roster poll when the roster moved, any editorial
    // write); a machine where NOTHING changes for a minute is exactly the
    // machine where that stale string sits. Minute granularity (see
    // viewmodel.formatGraceCountdown) is what makes one nudge a minute enough;
    // a repaint is view-local string work, no roster read and no rebuild, and
    // it is skipped entirely while no grace deadline exists to count down.
    try {
      if (Object.values(store.all()).some((r) => r.graceUntil != null)) {
        refreshViews();
      }
    } catch (err) {
      logError('extension.graceRepaint', err);
    }
  }, 60_000);
  context.subscriptions.push({
    dispose: () => {
      clearInterval(chatSweepTimer);
    },
  });

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
  // and the summary goes to the status bar. There is no separate off switch:
  // a window that should not switch by itself is the Root model, and the
  // retired `lineage.workspaces.autoSwitch: false` resolves to it
  // (modes.resolveMode). The explicit command remains in every model but
  // `folder`.
  context.subscriptions.push(
    registry.onDidChangeActive((sessionId) => {
      try {
        if (!sessionId) return;
        // A switch disposes and launches terminals, so it fires a burst of
        // active-terminal events itself — drop them here, silently, instead
        // of logging an "auto-switching / ignored" pair for every one.
        if (workspaceManager.isSwitching()) return;
        // AUTO-SWITCH IS LEVEL 1 AND ONLY LEVEL 1: `project` is the one window
        // model that rearranges itself without being asked. Folder mode never
        // mutates the window at all (design/levels-and-modes.md), and the
        // Flock-only model keeps the switch VERB but never fires it for you —
        // that difference is the whole of what separates the two.
        if (!projectSwitchingOn(lineageMode())) return;
        const tip = chainIndex.tipOf(sessionId);
        const cwd =
          forest.nodes.get(tip)?.cwd ??
          forest.nodes.get(sessionId)?.cwd ??
          store.get(tip)?.cwd ??
          store.get(sessionId)?.cwd;
        // Through preferredClaimant, not the static head: a directory two
        // projects share must not auto-switch AWAY from the one the user is
        // in whenever the tie-break happens to favour the other. The active
        // project outranks the tie-break among actual claimants (the spec's
        // "prefer the ACTIVE project in project mode"), which turns the
        // shared-directory case into the no-op two lines down.
        const match = claimantOf(cwd, workspaceManager.activeProjectId());
        if (!match || match.project.hidden === true) return;
        if (match.project.id === workspaceManager.activeProjectId()) return;
        log(
          'workspaces: focus moved into',
          match.project.name,
          '— auto-switching',
        );
        // The trigger travels with the switch. It is what the user just moved
        // into, and the restore reveals terminals of its own — each of which
        // takes the front of its editor group — so without naming it here the
        // switch ends on whichever session came home last. That is the "clicked
        // progress, landed on update-specs, clicked again and it worked" bug.
        //
        // The first switch without tmux is the moment the missing detach tier
        // costs something — said here, once, and never at activation.
        noteMissingTmux();
        void workspaceManager.switchTo(match.project.id, {
          auto: true,
          focusSessionId: sessionId,
        });
      } catch (err) {
        logError('extension.autoSwitch', err);
      }
    }),
  );

  /**
   * THE WINDOW FOLLOWS THE SESSION — the auto-switch model's whole promise,
   * applied to both surfaces at once.
   *
   * Axel: "you open VS Code, you don't open it in any specific folder, and from
   * there, when you are in a project — or in a subproject — that subproject's
   * related git worktree and the directory of that project/subproject will be
   * shown in the Explorer and in the Source Control." The decision is
   * `planFollow` (src/follow.ts, pure and tested); this reads the world and
   * acts on the answer.
   *
   * WHY IT LIVES BESIDE `whereAmI` AND IS DRIVEN BY THE SAME CALL. The status
   * line, the Explorer's Project view, the folder tree and now Source Control
   * are four renderings of one fact — where the conversation in front is — and
   * the design document's own rule is that one decision gets one derivation. So
   * they are computed from the same reads on the same tick and cannot disagree,
   * and there is no second focus listener to keep in step with the first. It
   * also gets the triggers right for nothing: `updateWorkspaceStatusBar` runs on
   * every focus change (`registry.onDidChangeActive`), on every roster tick, on
   * every completed switch (`setActive`) and — the one that matters here — when
   * the worktree probe LANDS, because `WorktreeCache.onDidChange` calls
   * `refreshViews`. A cold cache means the first focus into a new directory has
   * no checkout and Source Control says nothing; the probe lands a moment later
   * and it does, which is the same trade src/git.ts already documents for the
   * branch chips.
   *
   * THIS REPLACED A DEDICATED FOCUS LISTENER, which is why the guards below
   * read like a list: they are that listener's, kept whole. `isSwitching`
   * because a switch focuses terminals as a side effect and every one of those
   * echoes back here; `anchored` because a window that is not a Flock workspace
   * has no anchor to splice below and must be left alone; the scope check
   * because `'project'` scope ignores `currentDir` entirely and expands every
   * project directory into a root, which is a different feature and a user's
   * own choice.
   *
   * THE CROSS-PROJECT CASE BELONGS TO THE AUTO-SWITCH, not to this. When the
   * front conversation belongs to a project this window is not switched into,
   * the switch is about to take the window there and sync the Explorer itself —
   * so following here first would splice once for our answer and again for the
   * switch's, and a rebuilt root comes back COLLAPSED (see planSplice). Left
   * alone, the switch lands, `setActive` calls this again, and the second pass
   * is the one that narrows to the lane. The condition mirrors the auto-switch's
   * own, so turning the auto-switch OFF hands the case back here rather than
   * leaving nothing following at all.
   *
   * A CLOSED PROJECT IS NO PROJECT HERE, the same rule `whereAmI` applies:
   * putting a project away removes its rows everywhere, and this must not be
   * the one surface where its name comes back on the anchor row. The tree still
   * follows — down to the checkout or the session's own directory — because the
   * user is plainly typing in it.
   *
   * THE MEMO IS A REQUIREMENT, not an optimisation. This sits on the roster
   * poll, so without it every tick would re-run the anchor relabel and ask the
   * git extension about a repository it already has open.
   */
  let lastFollow: { dir: string; repo: string } | null = null;
  const applyFollow = async (): Promise<void> => {
    try {
      if (!followsTheSession(lineageMode())) return;
      if (!explorerSync.anchored()) return;
      if (workspaceManager.isSwitching()) return;
      const front = frontSessionId();
      if (front === null) return;
      const cwd = cwdOfSession(front);
      const activeId = workspaceManager.activeProjectId();
      const preferred = claimantOf(cwd, activeId);
      const claimant =
        preferred !== null && preferred.project.hidden !== true
          ? preferred
          : null;
      // Another project's session in front is the AUTO-SWITCH's case, not
      // this one's: in the one model where this runs the window is about to
      // move to that project and follow from there, and rooting the tree
      // first would show a directory the switch is about to leave. (A
      // separate auto-switch-off setting used to let the follow proceed here
      // instead; that window is the Root model now, which never reaches this
      // line.)
      if (claimant !== null && claimant.project.id !== activeId) return;
      const project = claimant?.project ?? null;
      const plan = planFollow({
        sessionId: front,
        cwd,
        project,
        lane: laneOfSession(front),
        worktrees: cwd !== undefined ? worktrees.get(cwd) : [],
        anchorPath,
      });
      // NOTHING TO SAY leaves both surfaces exactly as they are. A tree that
      // blanked itself because the front conversation went away would be the
      // worst thing this feature could do.
      if (plan.dir === '') return;
      // Moving into a different directory RETIRES a Project-view click: the
      // click meant "show me this one", and the user has since said where they
      // are by going there. Moving back into the overridden directory leaves it
      // set, which costs nothing — the two agree.
      if (
        explorerDirOverride !== null &&
        pathKey(normalizeDir(explorerDirOverride)) !== pathKey(plan.dir)
      ) {
        explorerDirOverride = null;
      }
      const dir = explorerDirOverride ?? plan.dir;
      if (
        lastFollow !== null &&
        lastFollow.dir === dir &&
        lastFollow.repo === plan.repo
      ) {
        return;
      }
      lastFollow = { dir, repo: plan.repo };
      if (
        explorerFollowOn(
          lineageMode(),
          boolCfg(CONFIG_KEYS.explorerFollowProject, true),
        ) &&
        explorerScope() === 'directory'
      ) {
        const outcome = await explorerSync.sync(project, dir);
        if (outcome === 'spliced') refreshExplorerHeader();
      }
      // Source Control follows even when the FOLDER TREE was told not to. The
      // setting says "do not drag my file tree around"; it has never said
      // anything about which repository the SCM view is about, and in this
      // model that is still the checkout the session is running in.
      await sourceControlSync.follow(plan.repo);
    } catch (err) {
      logError('extension.applyFollow', err);
    }
  };

  /**
   * WHERE AM I — the AUTO-SWITCH model's status-bar item, saying where the
   * conversation in front is. `src/whereami.ts` decides the words; this reads
   * the world and paints.
   *
   * ONE GATE, `modes.projectSwitchingOn`, and that is the whole visibility
   * rule: the item is drawn for the window that rearranges itself and for no
   * other. Clicking switches, and when the front conversation belongs to
   * another project the click goes straight there.
   *
   * WHAT WENT AWAY, and why, because it is easier to re-add a mistake than to
   * remember one. An earlier unreleased version also drew the item in folder
   * mode whenever the line said something the folder did not — a lane, or a
   * branch that is not the one you would assume — with a click that jumped to
   * the row instead of offering a switch that would refuse. Three things were
   * wrong with it. A window that IS its folder has no workspace to name, so the
   * item was answering a question nobody in that model had asked. The lane and
   * the branch it added are worth saying, but the Explorer's Project view
   * already says them, untruncated, in its `here` row — and one fact rendered
   * in two places is one place too many to keep honest. And that condition was
   * true for most real sessions (any lane, any linked worktree, any branch that
   * is not a trunk name), so what it produced in practice was chrome that
   * appeared and disappeared as you moved between branches, in the model whose
   * entire promise is that nothing moves unless you move it. The predicate it
   * was gated on (`WhereAmI.beyondTheFolder`) went with it, so that no later
   * reader finds a field whose only documented purpose is a feature that is no
   * longer there. Axel's words for the level-2 window were "the workspace button
   * should be turned off, like, normally, when you are just using Flock", and
   * this is that: off wherever the window does not switch by itself.
   *
   * LOOK BELOW BEFORE OPTIMISING. Everything down to `refreshExplorerHeader()`
   * runs in every model, deliberately: the answer is still computed, and the
   * Explorer's rendering of it is still painted, in exactly the windows that no
   * longer get an item. A future reader who sees the early return and moves the
   * work behind it will silently freeze the `here` row on a stale lane.
   */
  let workspaceStatusBar: vscode.StatusBarItem | undefined;
  /** The last answer, for the OTHER surface that shows it — the Explorer's
   *  Project view reads this instead of re-deriving the lane and the branch, so
   *  the two can never disagree. Null until the first paint. */
  let lastWhereAmI: WhereAmI | null = null;
  const updateWorkspaceStatusBar = (): void => {
    try {
      const w: Partial<typeof vscode.window> = vscode.window;
      const switching = projectSwitchingOn(lineageMode());
      const activeId = switching ? workspaceManager.activeProjectId() : null;
      // In FOLDER MODE the project the line is about is the one claiming the
      // front conversation, not a window-level active project — there is none,
      // and a stale id left over from a project-mode session must not become
      // one. Resolved from the claim list below, so `active` and `claimants`
      // cannot name different projects.
      const project = activeId ? store.getProject(activeId) : undefined;
      // WHERE AM I, not merely which project was switched to last. The line is
      // read off the conversation in FRONT (src/whereami.ts for the whole
      // argument): moving between two lanes of one project is not a switch, so
      // before this there was no surface that noticed the most common move of
      // the day. Everything here is a cache read — `worktrees.get` never blocks
      // and repaints through `refreshViews` when its probe lands — so this is
      // cheap enough to run on every focus change.
      const front = frontSessionId();
      const cwd = front !== null ? cwdOfSession(front) : undefined;
      const laneId =
        front !== null ? store.getSessionSubproject(front) : undefined;
      const claimants = claimantsOf(cwd);
      // THE PROJECT THE LINE IS ABOUT. Project mode: the window's active
      // workspace. Folder mode: whichever project claims the front
      // conversation — drawn from the SAME claim list, so `active` and
      // `claimants` can never name different projects and the foreign branch
      // (which folder mode has no verb for) is unreachable there.
      const named =
        project ??
        (switching
          ? undefined
          : claimants.find((m) => m.project.hidden !== true)?.project);
      const here = whereAmI({
        active: named ?? null,
        sessionId: front,
        cwd,
        claimants,
        lane: laneId !== undefined ? store.getSubproject(laneId) : null,
        worktrees: cwd !== undefined ? worktrees.get(cwd) : [],
      });
      lastWhereAmI = here;
      // The Explorer header renders the SAME answer, so it repaints here — after
      // the answer exists, and before anything below can return early. Both of
      // the returns below are ordinary states (folder mode with nothing to add;
      // a host with no status bar at all), and neither may leave the header
      // frozen on a stale lane.
      refreshExplorerHeader();
      // And the folder tree and Source Control render it too, in the one model
      // that follows. Above the returns for the same reason the header is, and
      // deliberately NOT awaited: this function paints a status bar and must
      // stay synchronous, while a splice waits on a workbench event. See
      // `applyFollow` for why it is driven from here rather than from a
      // listener of its own.
      void applyFollow();
      // The item itself, created on first need. A host without one — the unit
      // doubles, a future workbench that drops the API — still gets everything
      // above: the answer is computed and the Explorer's half of it is drawn.
      if (!workspaceStatusBar) {
        if (typeof w.createStatusBarItem !== 'function') return;
        workspaceStatusBar = w.createStatusBarItem(
          vscode.StatusBarAlignment.Left,
          90,
        );
        context.subscriptions.push(workspaceStatusBar);
      }
      // THE ONE GATE — see the header. `hide()` rather than never creating the
      // item, so changing `lineage.mode` brings it back (or takes it away)
      // without a reload: the configuration listener re-runs this, and an item
      // that had never been created would need a restart to appear.
      if (!switching) {
        workspaceStatusBar.hide();
        return;
      }
      workspaceStatusBar.text = here.text;
      workspaceStatusBar.tooltip = here.tooltip;
      // The click resolves the disagreement the line just reported: straight to
      // the project the conversation is in, rather than through a picker that
      // would ask the user to re-answer it. Only the switching model reaches
      // this line, so there is no longer a non-switching arm — the item and the
      // switch are the same feature and are gated once, above.
      workspaceStatusBar.command =
        here.switchTo === null
          ? COMMANDS.switchWorkspace
          : {
              command: COMMANDS.switchWorkspace,
              title: 'Switch Workspace',
              // The TREE-ROW shape, not a bare id: `projectIdFromArg` reads
              // `{type:'project', projectId}` and nothing else, deliberately, so
              // that no project verb can be handed a directory row by accident.
              // A string here would silently fall through to the picker.
              arguments: [{ type: 'project', projectId: here.switchTo }],
            };
      workspaceStatusBar.show();
    } catch (err) {
      logError('extension.workspaceStatusBar', err);
    }
  };
  refreshWhereAmI = updateWorkspaceStatusBar;
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
    // Whether the switch VERB would do anything, which is the weaker of the two
    // mode gates and the right one here: `switchWorkspace` refuses in folder
    // mode and works in the other two, so the Flock-only window keeps a header
    // whose click works. Gating this on `projectSwitchingOn` — the item-and-
    // auto-switch gate — would silently take that click away from every window
    // the legacy `workspaces.enabled: false` pair migrated. The view can
    // outlive a change of model (its when-clause is about the Explorer follow,
    // and the active project id is per-window state nothing clears), which is
    // why it needs a gate at all.
    switching: () => !folderScoped(lineageMode()),
    // Counted over the RENDERED forest, the same population the sidebar shows,
    // so the header's number and the sidebar's rows never disagree.
    sessionCount: (projectId) => {
      // EVERY claimant, for the reason projectsWithUnseen gives: a twice-claimed
      // session draws a row under both projects, so counting only the tie-break's
      // winner made this header disagree with the rows directly under it.
      const reach = projectReachNow();
      let n = 0;
      for (const node of forest.nodes.values()) {
        if (claimantsOf(node.cwd, reach).some((m) => m.project.id === projectId)) {
          n += 1;
        }
      }
      return n;
    },
    scope: () => explorerScope(),
    // The header names the directories; this is what marks the one the folder
    // tree below is actually rooted at — READ BACK from the live folder list
    // rather than recomputed. Recomputing it meant the mark could point at a
    // root that was not there: when the front conversation belongs to none of
    // this project's directories the follow listener correctly leaves the tree
    // alone, while `explorerDirFor` fell back to the project's main directory
    // and the mark moved on its own. Falls back to the computed answer only
    // when the live list has nothing to report (an unconverted window).
    currentDir: () => {
      const live = explorerSync.currentRoots()[0];
      if (live !== undefined) return live;
      const id = workspaceManager.activeProjectId();
      const active = id ? store.getProject(id) : undefined;
      return explorerDirFor(active ?? null);
    },
    // The `here` row: read off the status line's answer, never re-derived. A
    // FOREIGN answer contributes nothing — its lane and branch belong to a
    // project this view is not showing, and whereAmI blanks them for exactly
    // that reason.
    here: () =>
      lastWhereAmI === null
        ? undefined
        : {
            lane: lastWhereAmI.lane,
            branch: lastWhereAmI.branch,
            detached: lastWhereAmI.detached,
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
  //
  // NEVER IN FOLDER MODE, and this is a correctness fix that only became
  // visible once the models were named. `workspaceManager.activeProjectId()`
  // lives in `context.workspaceState`, so a window that was once in project
  // mode still carries a project id after being set to folder mode — the
  // setting changed, the leftover did not. Under `directory` scope a re-splice
  // replaces the folder tail with exactly ONE root (src/explorer.ts), and
  // `scopeFolders()` reads the LIVE folder list — so a background re-splice in
  // folder mode drags the fence with it and rows the user was looking at
  // vanish. Nothing asked for that and nothing on screen would explain it.
  //
  // AND ONLY IN AUTO-SWITCH, which is narrower than the guard this started
  // with. The Flock-only model keeps the switch VERB, so an earlier version
  // healed there too on the grounds that it has no fence to drag — but that
  // model is defined by nothing rearranging itself without being asked, and a
  // tree that re-roots on its own at every reload is exactly that. Following is
  // one model's behaviour (`explorerFollowOn`, which also folds in the user's
  // own `lineage.explorer.followProject`); the Flock-only window's Explorer
  // stays wherever the user left it, and its switch verb still moves it when
  // they run it.
  if (
    explorerSync.anchored() &&
    explorerFollowOn(
      lineageMode(),
      boolCfg(CONFIG_KEYS.explorerFollowProject, true),
    )
  ) {
    const activeId = workspaceManager.activeProjectId();
    const active = activeId ? store.getProject(activeId) : undefined;
    if (active) {
      void explorerSync.sync(active, explorerDirFor(active));
    }
  }

  // THE TREE FOLLOWS ATTENTION under `'directory'` scope — no verb, no click,
  // the file tree is wherever you are — and there is no listener here any more
  // because that is now `applyFollow`, driven from `updateWorkspaceStatusBar`
  // where the same focus event already lands. The listener this replaced asked
  // `activeSessionDir` for a project directory and spliced; it could not follow
  // a session into its lane, it could not say anything to Source Control, and
  // being a SECOND subscriber to `onDidChangeActive` it had to be positioned by
  // hand relative to the auto-switch to keep the two from racing. All three are
  // gone with it. Its guards are kept verbatim in `applyFollow` — read them
  // there.

  /**
   * Does some record on this session's chain name a LIVE window other than
   * this one? The cross-window RESTORE-RACE guard, and deliberately the same
   * probe the lifecycle sweep runs before acting on a graced record: another
   * window's restore binds the terminal (stamping `boundWindowId`) first and
   * clears `graceUntil`/`tmux` only after its launch resolves, so for a few
   * seconds the record reads as a detached claim while the process already
   * has a tab THERE. Chain-expanded like focusWindowFor, because
   * boundWindowId is view-state that never inherits across generations.
   * getWindows() already drops dead pids, so "live" means a window that is
   * actually up, not a week-old record. Total: a throwing store answers
   * false, which only ever costs the caller a kill it could also have done.
   */
  const boundToLiveForeignWindow = (sessionId: string): boolean => {
    try {
      const liveWindows = new Set(store.getWindows().map((w) => w.windowId));
      return chainAliases(sessionId).some((id) => {
        const windowId = store.get(id)?.boundWindowId;
        return (
          typeof windowId === 'string' &&
          windowId !== focusIntegration.windowId &&
          liveWindows.has(windowId)
        );
      });
    } catch (err) {
      logError('extension.boundToLiveForeignWindow', err);
      return false;
    }
  };

  /**
   * WHICH generation of this conversation carries the detached claim — the
   * `graceUntil` countdown or the `tmux` wrap name — or undefined when none
   * does.
   *
   * CHAIN-WIDE, and that is the whole point. The claim is stamped on the id
   * that was parked, and `INHERITED_RECORD_KEYS` deliberately keeps `tmux` and
   * `graceUntil` off a successor generation, so a conversation that re-mints
   * its id afterwards leaves the claim on an older member. `killDetached`
   * always searched the chain for it; the VERBS that decide whether to call
   * killDetached asked the tip record alone, found nothing, and skipped the
   * kill — Archive wrote `deleted: true` over a live wrap on this very machine.
   * This function is the one probe both halves now share, so the question "is
   * a detached process behind this row" cannot be answered two ways again.
   *
   * The rejected alternative was to make `Store.get` chain-aliasing. That
   * would have fixed these four call sites and silently changed the reading of
   * every other field in the extension — `closed`, `deleted`, `boundWindowId`
   * — several of which are deliberately generation-local. One probe with one
   * job is the smaller claim.
   *
   * Total, like every other dep here: a throwing store answers undefined,
   * which costs a caller only a kill it could equally have skipped before.
   */
  const detachedClaimHolder = (sessionId: string): string | undefined => {
    try {
      return chainAliases(sessionId).find((id) => {
        const r = store.get(id);
        return (
          r?.graceUntil != null ||
          (typeof r?.tmux === 'string' && r.tmux !== '')
        );
      });
    } catch (err) {
      logError('extension.detachedClaimHolder', err);
      return undefined;
    }
  };

  // Assigned right after `commandDeps` exists — the host launches THROUGH
  // commandDeps.launchSession, and the verbs poke the host, so one of the two
  // references has to be late-bound. The verbs' poke is the safe one to
  // defer: a poke before construction is a poke about an empty queue.
  let dispatchHost: DispatchHost | undefined;

  /** Whether the official Claude Code extension is installed — probed by the
   *  same extension id `resolveLaunchMode`'s installed callback gets at every
   *  launch, so the surface picker, the gear's entry for it and the launcher
   *  cannot disagree about whether the delegate is really there. */
  const claudeExtensionInstalled = (): boolean => {
    const delegate = delegateFor('claudeExtension');
    return (
      delegate !== undefined &&
      vscode.extensions?.getExtension(delegate.extensionId) !== undefined
    );
  };

  // THE TWO CONTEXTUAL OFFERS' stamps. Once per install, the way every notice
  // here is; the decisions are `windowModelOffer` and `surfaceOffer` in
  // src/recommend.ts, and the two verbs stamp these too when answered from
  // the gear, so a question already settled is never asked.
  const offerAnswered = (offer: ContextualOfferId): boolean =>
    context.globalState.get<boolean>(OFFER_KEYS[offer]) === true;
  const markOfferAnswered = async (offer: ContextualOfferId): Promise<void> => {
    await context.globalState.update(OFFER_KEYS[offer], true);
  };

  /** "Where should sessions open?", asked ONCE, at the moment it becomes real:
   *  the second session tab in a window. `surfaceOffer` decides; this draws
   *  the message and acts on the answer on the terms every notice here keeps
   *  — "Choose…" stamps and runs the picker, "Not now" stamps, the X stamps
   *  nothing. Called from the launch funnel below and nowhere else: never
   *  from activation, never from a timer, never from a reload's
   *  re-association, so the tabs counted are tabs a gesture opened. The
   *  window-model twin lives in commands.ts beside the routing it hangs off. */
  const offerSurfaceOnSecondTab = (): void => {
    try {
      const verdict = surfaceOffer({
        boundTabs: registry.boundSessionIds().length,
        answered: offerAnswered('surface'),
      });
      if (verdict !== 'offer') return;
      const CHOOSE = 'Choose…';
      const NOT_NOW = 'Not now';
      void vscode.window
        .showInformationMessage(
          'Flock: that is your second session tab. Sessions can open as ' +
            'editor tabs, one pinned tab at a time, in the terminal panel, ' +
            'in a window of their own, or in the Claude Code extension. ' +
            'Choose where they open?',
          CHOOSE,
          NOT_NOW,
        )
        .then(
          async (answer) => {
            if (answer === CHOOSE) {
              await markOfferAnswered('surface');
              await vscode.commands.executeCommand(COMMANDS.chooseSurface);
            } else if (answer === NOT_NOW) {
              await markOfferAnswered('surface');
            }
          },
          (err) => logError('surface.offer', err),
        );
    } catch (err) {
      logError('surface.offer', err);
    }
  };

  const commandDeps: AccountCommandDeps = {
    // The whole accounts surface, as ONE optional member: the verbs guard
    // on its presence, so a build without it behaves exactly as this extension
    // did before accounts existed.
    accounts: accountDeps,

    // The dispatch queue: the store persists it, the host (below) acts on it,
    // and the verbs only park, list and cancel. Cancel IS settle — the record
    // stays as its own tombstone, so another window can never relaunch it.
    dispatch: {
      entries: () => store.dispatchEntries(),
      queue: (entry) => store.queueDispatch(entry),
      cancel: (id) => store.settleDispatch(id, 'cancelled'),
      poke: () => dispatchHost?.poke(),
    },

    getForest: () => forest,
    refresh: refreshNow,
    hasTranscript: (sessionId) =>
      hasTranscript(sessionId, { extraProjectsDirs: profileProjectsDirs() }),
    // The same lookup hasTranscript runs, kept as a pair on purpose: the
    // handoff brief has to NAME the file, and two different searches answering
    // the two questions would eventually disagree.
    transcriptPathOf: (sessionId) =>
      transcriptFile(sessionId, { extraProjectsDirs: profileProjectsDirs() }),
    repairResumeLeaf: (sessionId) =>
      repairResumeLeaf(sessionId, { extraProjectsDirs: profileProjectsDirs() }),
    transcriptFacts,
    // The archive browser files a session under a project by the same rule the
    // sidebar groups by, worktrees included — see projectReachNow for why the
    // resolver is built per call rather than kept.
    projectReach: projectReachNow,
    // The roster's own answer, one tick old at worst. `prevLiveIds` is
    // assigned the CURRENT set at the end of every rebuild — the name is about
    // where it is read from inside the rebuild, not about how stale it is —
    // and it is the only live-id set that outlives one.
    isLive: (sessionId) => prevLiveIds.has(sessionId),
    // The same ownership answer the rows are drawn from, so a verb's refusal
    // and the marker on the row it refused can never disagree.
    hostOf: sessionHostOf,
    // A terminal in this window that we did not create but that is running this
    // session — `claude` typed into the bottom panel, most often. Asked under
    // every generation id, like every other terminal lookup here.
    //
    // Marking it seen is the second half of the verb, not an extra: the focus
    // path for a session we own clears the attention dot through
    // onDidChangeActiveTerminal, and the registry does not recognise a terminal
    // it never bound — so without this, revealing a foreign session would leave
    // its dot lit with no way to put it out.
    revealHostTerminal: async (sessionId) => {
      const revealed = await terminalMatcher.reveal(
        sessionId,
        chainAliases(sessionId),
      );
      if (!revealed) return false;
      await markSeen(sessionId);
      // Revealing a foreign session is a click on its row like any other, and
      // the focus listener above cannot see it: the registry never bound this
      // terminal, so `onDidChangeActive` does not fire for it.
      noteTouched(sessionId);
      return true;
    },
    tipOf: (sessionId) => chainIndex.tipOf(sessionId),
    // The background job holding this id, if one does — the shape a
    // native `/fork` dispatches. Stat-cached inside the reader, so asking on
    // every focus costs nothing.
    backgroundJob: (sessionId) => daemonReader.read().jobs.get(sessionId),
    // Detach tier: does the private server still hold this wrap, with a
    // CONVERSATION in it? Probed even when the config gate is off, like
    // tmuxPanePid above: sessions wrapped before the flip are still wrapped.
    //
    // "With a conversation in it" is the whole of `queryWrapState`'s reason to
    // exist, and why this is no longer a pane-pid test. Exit-to-shell leaves a
    // wrap alive with a SHELL in the pane, which answers a pane pid perfectly
    // well — so the old probe would report that session live, `detachedTmuxName`
    // would hand `resumeFlow` an attach target, and clicking Resume would drop
    // the user at their own shell prompt and record the conversation as
    // reopened. An `exited` wrap is deliberately indistinguishable from `gone`
    // here: there is nothing to attach to either way, so resume takes the
    // ordinary `--resume` path, with every guard on it.
    tmuxSessionLive: async (name) => {
      const binary = tmuxSpawn()?.binary ?? findTmuxBinary();
      if (binary === null) return false;
      return (await queryWrapState(binary, name)) === 'running';
    },
    revealSession,
    focusSessionsView,

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
    sessionProvider: (id) => sessionProviderFor(id),
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
      // ---------------------------------------------------- the scope fence
      //
      // FOLDER MODE's boundary, and the ONE place it is enforced. Every verb
      // that can put a claude process on this machine — new session, resume,
      // fork, worktree, branch, chat, the palette, a keybinding, a URI
      // handler, whatever gets written next — funnels through this dep. Fence
      // it here and "you cannot open another project in this window" is a
      // property of the extension; fence it in the verbs and it is a property
      // of however many verbs remembered to ask.
      //
      // That distinction is not theoretical. The fence used to live in
      // routeForeign, called from the resume path only, so the entire
      // new-session family (project, directory, branch, worktree, subproject)
      // could launch into another folder from a folder-mode window — which is
      // exactly how a BASALT session came to be running inside a
      // lineage-sessions window while the tree, correctly scoped, had no row
      // for it.
      //
      // routeForeign still runs AHEAD of this, and still matters: it offers
      // the right window and is how a cross-folder notification takes you
      // there. This is the backstop under it, for the paths that never asked.
      //
      // `scopeFolders()` is undefined in project mode and in an empty window,
      // so outsideScope is false there and this costs nothing: a project-mode
      // switch restoring sessions across its project's directories is
      // untouched.
      if (outsideScope(scopeFolders(), opts.cwd)) {
        log(
          'launch: REFUSED —',
          opts.cwd,
          'is outside this folder-mode window;',
          shortId(opts.sessionId),
          'belongs to its own window',
        );
        void vscode.window.showInformationMessage(
          `Flock: ${opts.cwd} is outside this window's folder. Open that ` +
            'folder in its own window to work there — this window only ever ' +
            'runs the folder you opened.',
        );
        // `null`, the same answer a failed launch gives: every caller already
        // treats it as "no binding, stop here" and logs its own line. A refusal
        // needs no new contract.
        return null;
      }
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
      // THE LANE STAMP, inherited when the launch did not name one. A FORK is a
      // new session id with a parent rather than a member of the parent's chain
      // (which `getSessionSubproject` already walks), so the inheritance has to
      // happen here — and a fork of the server rewrite is the server rewrite. Same
      // shape and same reason as the account backfill above: the one place every
      // launch passes through, so no verb has to remember.
      if (
        launchOpts.subprojectId === undefined &&
        typeof launchOpts.parentId === 'string' &&
        launchOpts.parentId !== ''
      ) {
        const parentLane = store.getSessionSubproject(launchOpts.parentId);
        if (parentLane !== undefined) {
          launchOpts = { ...launchOpts, subprojectId: parentLane };
        }
      }
      // Read BEFORE the spawn, not after: adoptCodexSession rejects any
      // rollout older than this, and a reading taken after the terminal came
      // up would be later than the header stamp of the very file it is looking
      // for.
      const spawnedAt = Date.now();
      const binding = await registry.launch(launchOpts);
      // The second tab in a window is the moment the surface question becomes
      // real (`offerSurfaceOnSecondTab`); a launch that never started is not a
      // tab. Here and not on `onDidBind`, because binds also arrive from a
      // reload's re-association and from adoptions — none of them a gesture.
      if (binding) offerSurfaceOnSecondTab();
      // A launch that never started must not leave an optimistic row standing
      // for the whole TTL: the terminal failed loudly, and a row for a session
      // that does not exist is worse than no row.
      if (!binding) {
        pendingLaunches.delete(opts.sessionId);
      } else if (parkedAlias !== undefined) {
        // The record claimed "detached, maybe running"; the tab now exists, so
        // the claim is settled — the same clear the workspace restore writes.
        // `graceUntil` goes with the name: an attached session is level 1
        // again, and a countdown left behind would have the sweep kill the
        // very tab the user just opened. `closeAfterTurn` goes with them for
        // the same reason: the mark was a grace deadline landing on a busy
        // session, and left behind it would close the re-attached tab on its
        // first idle tick — navigation mutating lifecycle, the forbidden move.
        // `stowedBySwitch` is consumed with the claim it rode in on: the tab
        // is back, so a later user close must stay closed across switches.
        void store.upsert(parkedAlias, {
          graceUntil: null,
          tmux: null,
          closeAfterTurn: false,
          stowedBySwitch: false,
        });
      }
      // Persisted only for a launch that actually STARTED, and only forward: the
      // store keeps the first stamp a session ever gets (see
      // setSessionSubproject), so a resume of a session already in a lane is a
      // no-op rather than a re-file.
      if (binding && launchOpts.subprojectId !== undefined) {
        void store.setSessionSubproject(opts.sessionId, launchOpts.subprojectId);
      }
      // WHICH CLI THIS CONVERSATION IS, written down once, at the only moment
      // it is known for certain. Every later resume reads it back (see
      // commands.sessionLaunchProvider) instead of re-deriving it from the
      // account, which can be re-pinned, or from the project, which is a glyph
      // heuristic. Claude launches write nothing: absent already means claude,
      // and stamping every row would make the field's presence meaningless.
      if (binding && launchOpts.provider === 'codex') {
        void store.upsert(opts.sessionId, { provider: 'codex' });
        // Codex mints its own session id, so the binding above is under a
        // PROVISIONAL one. Hand it to the watcher that finds the real id and
        // re-keys the row onto it.
        //
        // Run for EVERY Codex launch, resumes included, and the asymmetry is
        // the point: a resume that appends to the rollout it was given writes
        // no new file, so the watcher matches nothing and the row keeps the id
        // it already had — the correct outcome, reached by finding nothing. A
        // resume that instead re-mints (which `fork` certainly does, and which
        // a future `resume` might) writes one, and the watcher re-keys onto it.
        // Exempting resumes would get the first case right by luck and the
        // second wrong for good.
        adoptCodexSession(opts.sessionId, launchOpts, spawnedAt);
      }
      return binding;
    },

    /**
     * `lineage.launch.mode`: run another extension's new-conversation command
     * instead of opening a terminal here, and arm the claim that binds whatever
     * session id turns up back onto a tree row (see settleDelegatedClaim).
     *
     * Every failure returns null, which sends the caller straight back to its own
     * launch: the mode is `flock`, the named extension is not installed, or the
     * command threw. A `+` that opens nothing is not an acceptable outcome of a
     * setting, so the only thing a bad mode costs is one note.
     */
    delegateLaunch: async ({ cwd, title }) => {
      const resolved = resolveLaunchMode(
        cfg().get<string>(CONFIG_KEYS.launchMode),
        (id) => vscode.extensions?.getExtension(id) !== undefined,
      );
      if (resolved.fellBack) {
        if (!delegateFallbackTold) {
          delegateFallbackTold = true;
          void vscode.window.showWarningMessage(
            'Flock: `lineage.launch.mode` names an extension that is not ' +
              'installed, so this session opened here instead.',
          );
        }
        return null;
      }
      const delegate = resolved.delegate;
      if (delegate === undefined) return null;

      // Captured BEFORE the command runs, so the claim's "was it already there"
      // test cannot include the session the command is about to start.
      const before = new Set(lastEntries.map((e) => e.sessionId));
      try {
        await vscode.commands.executeCommand(delegate.newCommand);
      } catch (err) {
        logError('extension.delegateLaunch', err);
        return null;
      }
      delegatedClaim = {
        at: Date.now(),
        before,
        ...(cwd === undefined ? {} : { cwd }),
        ...(title === undefined ? {} : { title }),
      };
      // The delegate's session will not be on the roster for up to a poll
      // interval, and the user is looking at the panel it just opened.
      pokeNow();
      return { label: delegate.label };
    },

    /**
     * The RESUME half of `lineage.launch.mode`: open an existing conversation
     * in the delegate's own UI (claude-vscode.primaryEditor.open — the command
     * the extension's own deep link runs; it reveals the existing panel when
     * the session is already open in one). Same failure contract as
     * delegateLaunch: every null sends the caller back to its own terminal.
     * No claim is armed — the row already exists, and whatever generation id
     * the resume mints is re-keyed onto it by the chain machinery exactly as
     * for any other resume Flock did not perform.
     */
    delegateOpenSession: async (sessionId) => {
      const resolved = resolveLaunchMode(
        cfg().get<string>(CONFIG_KEYS.launchMode),
        (id) => vscode.extensions?.getExtension(id) !== undefined,
      );
      if (resolved.fellBack) {
        if (!delegateFallbackTold) {
          delegateFallbackTold = true;
          void vscode.window.showWarningMessage(
            'Flock: `lineage.launch.mode` names an extension that is not ' +
              'installed, so this session opened here instead.',
          );
        }
        return null;
      }
      const delegate = resolved.delegate;
      if (delegate?.openCommand === undefined) return null;
      try {
        await vscode.commands.executeCommand(delegate.openCommand, sessionId);
      } catch (err) {
        logError('extension.delegateOpenSession', err);
        return null;
      }
      // The one handle there is on a conversation living in the delegate's own
      // panel: it opened because WE named this id, and no terminal changed
      // hands, so the active-terminal read that feeds `frontSessionId` will
      // never see it. Without this the sidebar's selection would go on
      // following whatever terminal happened to be active last, which is the
      // opposite of "the tree always says where you are".
      noteFrontSession(sessionId);
      // The resumed process will not be on the roster for up to a poll
      // interval, and the user is looking at the panel it just opened.
      pokeNow();
      return { label: delegate.label };
    },

    /** The NEW-conversation twin of delegateOpenInfo, for the routing gate's
     *  "opened here" note (commands.delegated): same pure read, minus the
     *  openCommand requirement — every delegate has a newCommand. Never the
     *  thing that decides a handover; delegateLaunch above does, by trying. */
    delegateNewInfo: () => {
      try {
        const resolved = resolveLaunchMode(
          cfg().get<string>(CONFIG_KEYS.launchMode),
          (id) => vscode.extensions?.getExtension(id) !== undefined,
        );
        const delegate = resolved.delegate;
        if (resolved.fellBack || delegate === undefined) return null;
        return { label: delegate.label };
      } catch (err) {
        logError('extension.delegateNewInfo', err);
        return null;
      }
    },

    /** What the focus verb's dead-end dialog may offer. Pure read, no
     *  side effects, no fallback warning — a dialog being CONSTRUCTED is not
     *  the moment to toast about a missing extension. */
    delegateOpenInfo: () => {
      try {
        const resolved = resolveLaunchMode(
          cfg().get<string>(CONFIG_KEYS.launchMode),
          (id) => vscode.extensions?.getExtension(id) !== undefined,
        );
        const delegate = resolved.delegate;
        if (resolved.fellBack || delegate?.openCommand === undefined) {
          return null;
        }
        return { label: delegate.label };
      } catch (err) {
        logError('extension.delegateOpenInfo', err);
        return null;
      }
    },

    /**
     * `lineage.soloSession` — one session tab at a time. The park half is the
     * workspace switcher's own machinery (same tiers, same records — see
     * workspaces.parkOthers), the pin half is local. Consulted by every flow
     * that opens or fronts a session tab; a no-op while the setting is off.
     *
     * `stow` follows the MODE, and this is the second half of the same lesson
     * the launch fence above teaches. Solo mode borrowed the switcher's park
     * wholesale, marker included, so a folder-mode window — which has no
     * switcher at all — was writing `stowedBySwitch` onto every session solo
     * put away. Harmless-looking bookkeeping that no folder-mode path would
     * ever honour, and a live example of the switch machinery reaching into a
     * mode that retired it. In folder mode solo still closes and still graces;
     * it just stops pretending a switch did it.
     *
     * The test is "not folder", not "is project", and that spelling is
     * load-bearing now that there are three models: BOTH `flock` and `project`
     * have a switcher that can redeem a `stowedBySwitch` marker (workspaces.ts's
     * restore is the only thing that ever honours one), and the Flock-only model
     * is where the `(project, workspaces.enabled: false)` population landed. Had
     * this stayed `=== 'project'` they would have quietly lost a restore in the
     * migration — a move nobody asked for, in a change that promised to move
     * nobody.
     */
    soloEnforce: async (keepSessionId) => {
      if (!boolCfg(CONFIG_KEYS.soloSession, false)) return;
      await workspaceManager.parkOthers(keepSessionId, {
        stow: !folderScoped(lineageMode()),
      });
      await pinSoloTab(keepSessionId);
    },
    focusSession: (sessionId) => {
      const bound = chainAliases(sessionId).find(
        (id) => registry.binding(id) !== undefined,
      );
      if (!bound) return false;
      // (The old `parked`-with-a-live-binding special case — a legacy
      // panel-stowed tab moved home on focus — is gone with the flag itself:
      // sanitizeRecord flips parked records to archived at load, so no record
      // can carry the state past schema v8.)
      return registry.focus(bound);
    },
    // "The conversation you are looking at", for the two view-title buttons that
    // are handed no row: the fork button's first tier, and the `+`'s last one.
    // The registry answers only for a terminal it bound itself, so a shell
    // someone typed `claude` into is correctly not mistaken for one of ours.
    activeSessionId: () => registry.activeSessionId(),
    renameTerminal: async (sessionId, name) => {
      for (const id of chainAliases(sessionId)) {
        if (await registry.rename(id, name)) return true;
      }
      return false;
    },
    sendTextToSession: (sessionId, text) =>
      chainAliases(sessionId).some((id) => registry.sendText(id, text)),
    // The CLOSE verb means "end this session" — for a wrapped terminal the
    // dispose only detaches, so the kill intent rides along. The workspace
    // sweep calls the registry directly, without it.
    closeTerminal: (sessionId) =>
      chainAliases(sessionId).some((id) =>
        registry.closeTerminal(id, { killTmux: true }),
      ),
    // Close Now's second tier: a session with no terminal anywhere — counting
    // down in the grace pool — dies through the same funnel as a grace
    // expiry: tree-reaping kill, archived stamp, at-rest repair.
    killDetached: async (sessionId) => {
      // The restore-race guard, HERE as well as in the verbs that call this:
      // a live foreign window's binding means the wrap has a tab there and
      // the "detached" claim is only its not-yet-cleared grace stamp.
      // Guarding in the funnel itself means no future caller can kill a
      // session out from under the window that just re-attached it.
      if (boundToLiveForeignWindow(sessionId)) return false;
      // The SAME probe the verbs use to decide whether to call this at all —
      // see detachedClaimHolder. Kept as one function rather than two copies
      // of the same `find` because the copies had drifted: the verbs' copy
      // read the tip only, so the kill was never reached for a re-keyed
      // conversation and its wrap outlived its row.
      const holder = detachedClaimHolder(sessionId);
      if (holder === undefined) return false;
      await endDetached(holder, 'closed now (user verb)');
      return true;
    },
    boundToLiveForeignWindow,
    detachedClaimHolder,

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

    // Folder mode's routing arm: no binding to follow (the session is
    // detached, archived, or was never this machine's terminal), so the
    // DIRECTORY says which window should host it. The resolver is pure
    // (modes.windowForDir); getWindows() has already dropped dead pids, and
    // this window itself is skipped — a caller asking to route elsewhere has
    // already established that "here" is the wrong answer.
    focusWindowForDir: async (dir, sessionId) => {
      const others = store
        .getWindows()
        .filter((w) => w.windowId !== focusIntegration.windowId);
      const rec = windowForDir(others, dir);
      if (!rec) return false;
      return focusIntegration.focusWindow(rec, sessionId);
    },
    lineageMode: () => lineageMode(),
    scopeDirs: () => scopeFolders(),
    // GEOGRAPHY, not the fence: what this window actually has open, in every
    // model. `scopeDirs` answers undefined outside folder mode by design, so a
    // verb asking "do I already have that directory?" has to ask this instead
    // — the same list the published WindowRecord carries, so what this window
    // says about itself to other windows and what it believes about itself are
    // one answer.
    windowFolders: () => realWorkspaceFolders(),

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

    installAgentVerbs: async () => {
      const state = await verbsManager.install();
      syncVerbsWatcher();
      return state;
    },
    removeAgentVerbs: async () => {
      const state = await verbsManager.remove();
      syncVerbsWatcher();
      return state;
    },
    getAgentVerbsState: () => verbsManager.getState(),
    setAgentVerbsEnabled: async (enabled) => {
      try {
        await cfg().update(
          CONFIG_KEYS.verbsEnabled,
          enabled,
          vscode.ConfigurationTarget.Global,
        );
      } catch (err) {
        logError('extension.setAgentVerbsEnabled', err);
      }
      syncVerbsWatcher();
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
    setBranchesShown: async (projectId, shown) => {
      await store.upsertProject(projectId, { branchesShown: shown });
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
    // A WARMED read, for the placement decision a lane's `+` makes off a pinned
    // branch: the launch is a user verb, so it can afford the one `git worktree
    // list` that makes the answer current — the sync cache is for renders.
    worktreesFor: (dir) => worktrees.warm(dir),
    addWorktree: (opts) => runWorktreeAdd(opts),
    removeWorktree: (opts) => runWorktreeRemove(opts),
    deleteBranch: (opts) => runBranchDelete(opts),
    aheadCount: (repoDir, mainName, branch) =>
      readAheadCount(repoDir, mainName, branch),
    branchPrefix: () => cfg().get<string>(CONFIG_KEYS.gitBranchPrefix, '') ?? '',
    // The minted-branch ledger, straight through to the store — the same
    // window-shared file every other record lives in, because the delete
    // offer has to survive the window that minted the ref.
    isMintedBranch: (repoDir, branch) => store.isMintedBranch(repoDir, branch),
    recordMintedBranch: (repoDir, branch) =>
      store.recordMintedBranch(repoDir, branch),
    forgetMintedBranch: (repoDir, branch) =>
      store.forgetMintedBranch(repoDir, branch),
    pruneMintedBranches: (repoDir, existing) =>
      store.pruneMintedBranches(repoDir, existing),
    pullRequestFor: (repoDir, branch) => pullRequests.get(repoDir, branch),
    // Gated on the SETTING and not on view visibility, unlike the cache's own
    // refresh: this is a verb somebody just picked, and refusing it because the
    // sidebar happened to be collapsed would be refusing for a reason nobody can
    // see. Off means off, though — `lineage.git.pullRequests` is the promise that
    // Flock does not reach the network, and a verb is not an exception to it.
    createPullRequest: (dir) =>
      boolCfg(CONFIG_KEYS.gitPullRequests, false)
        ? openPullRequestCreatePage(dir)
        : Promise.resolve({
            ok: false,
            output:
              'lineage.git.pullRequests is off, so Flock does not run gh.',
          }),
    // NOT behind `lineage.git.pullRequests`, and the difference is the whole
    // reason it is a member of its own: `gh` is a program that talks to GitHub,
    // where this reads .git/config on the local disk. The setting above is the
    // promise about the first thing; gating the second on it would be gating a
    // branch link on a network feature it does not use.
    remoteUrlOf: (dir, remote) => readRemoteUrl(dir, remote),
    // All three caches, all wholesale. A worktree that appeared or disappeared
    // changes the LIST for every directory of the repository (any checkout
    // reports the same set), the per-worktree statuses keyed under it are about a
    // directory that may not exist any more, and `git worktree add -b` CREATES A
    // REF — so the branch enumeration is stale too, and a new branch that took
    // thirty seconds to appear in the fold it was just made from would read as the
    // verb having failed.
    worktreesChanged: (dir) => {
      worktrees.invalidate();
      branchStatus.invalidate();
      branchList.invalidate();
      log('worktree: caches invalidated after a change at', dir);
      refreshViews();
    },
    // NAMED SUBPROJECTS (v7). The lane verbs' writes; the two READS the renderers
    // need are wired onto the tree deps above.
    allSubprojects: () => store.getSubprojects(),
    getSubproject: (id) => store.getSubproject(id),
    // Resolved over the generation CHAIN by the store, so a `/clear`ed
    // conversation reports the lane it was started in rather than nothing.
    getSessionLane: (id) => store.getSessionSubproject(id),
    upsertSubproject: (id, patch) => store.upsertSubproject(id, patch),
    deleteSubproject: (id) => store.deleteSubproject(id),
    moveSessionSubproject: (sessionId, subprojectId) =>
      store.moveSessionSubproject(sessionId, subprojectId),
    upsertProject: (id, patch) => store.upsertProject(id, patch),
    // Its own store method rather than an upsert with a `parentId` in it:
    // the cycle check has to run against the whole project set at write time.
    setProjectParent: (id, parentId) => store.setProjectParent(id, parentId),
    deleteProject: (id) => store.deleteProject(id),
    hiddenFolders: () => store.getHiddenFolders(),
    hideFolder: (dir) => store.hideFolder(dir),
    unhideFolder: (dir) => store.unhideFolder(dir),
    // The Add Session / Import pool: what this machine knows that the tree is
    // not showing. Snapshots of caches the rebuild already maintains — the
    // last roster tick and the archive index — so opening a picker costs no
    // scan and no subprocess.
    unlistedSessions: () =>
      unlistedPool({
        entries: lastEntries,
        archived: archiveIndexer.current(),
        records: store.all(),
        tipOf: (id) => chainIndex.tipOf(id),
        shownIds: new Set(forest.nodes.keys()),
      }),

    // Notifications
    markSeen: (sessionId) => markSeen(sessionId),
    notificationsEnabled: () => notificationsOn(),
    // `lineage.soloSession`, read live — the multi-open verb refuses while it
    // is on, because solo mode would park each session as the next one opened.
    soloSessionEnabled: () => boolCfg(CONFIG_KEYS.soloSession, false),

    // Telling a parent conversation what happened to it. Both settings are
    // read on every call, like every other one here, so a change takes effect
    // on the next fork or the next close with no reload.
    notifyParentOnFork: () => boolCfg(CONFIG_KEYS.forkNotifyParent, false),
    closeSummaryMode: () => {
      const raw = cfg().get<string>(CONFIG_KEYS.closeSummaryMode);
      return isCloseSummaryMode(raw) ? raw : DEFAULT_CLOSE_SUMMARY_MODE;
    },
    /**
     * Wait for the Claude CLI to write a compaction summary, and hand back its
     * words.
     *
     * THE CHAIN WALK IS NOT OPTIONAL. A compaction re-mints the session id in
     * roughly a third of cases — the summary lands in a NEW transcript under a
     * NEW id, with only `logicalParentUuid` joining the two — and
     * `chainAliases` is the machinery that already knows those ids are one
     * conversation, for exactly the reason compaction.phaseOf takes an id list
     * rather than an id. Reading only the id that was asked about would miss
     * every re-minted case, which is the majority of the interesting ones.
     *
     * `extraProjectsDirs` matters for the same reason it does everywhere else
     * here: an account-pinned session writes its transcript under that
     * profile's config directory and nowhere else.
     *
     * POLLING, not the hook stream, and deliberately. There IS a PreCompact
     * hook and it would tell us a compaction started — but hooks are an
     * accelerator that may never be installed (see the header of src/hooks.ts),
     * and a verb the user just clicked must not silently do nothing on a
     * machine that never ran the installer. Two seconds is far below the
     * 96-to-180-second compactions measured on this machine, so the poll is
     * never the thing that makes the wait feel long.
     */
    awaitCompactSummary: async (sessionId, sinceMs, timeoutMs) => {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      const read = (): string | undefined => {
        for (const id of chainAliases(chainIndex.tipOf(sessionId))) {
          const file = transcriptFile(id, {
            extraProjectsDirs: profileProjectsDirs(),
          });
          if (file === null) continue;
          try {
            const found = parseCompactSummary(
              readTranscriptTail(file, SUMMARY_TAIL_MAX_BYTES),
              sinceMs,
            );
            if (found !== undefined) return found;
          } catch (err) {
            // A transcript that vanished or is being rewritten under us is a
            // reason to look again in two seconds, never a reason to fail the
            // verb — the caller reads `undefined` as "not yet".
            logError('extension.awaitCompactSummary', err);
          }
        }
        return undefined;
      };
      for (;;) {
        const found = read();
        if (found !== undefined) return found;
        if (Date.now() >= deadline) return undefined;
        await new Promise<void>((resolve) => setTimeout(resolve, 2000));
      }
    },

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

    // The Accounts section. No context key to follow: the view's `when` clause
    // and the gear menu's two halves all read `config.lineage.accounts.section`
    // directly, and the workbench re-evaluates a `config.` clause itself.
    setAccountsSection: async (on) => {
      try {
        await cfg().update(
          CONFIG_KEYS.accountsSection,
          on,
          vscode.ConfigurationTarget.Global,
        );
        // The same gesture retires the folded key. Whichever way the section
        // was just set, the new key states the answer now, and an old
        // `accounts.enabled: false` left beside it would go on hiding a list
        // the person just asked for. Deleted rather than rewritten — VS Code
        // permits removing a key it no longer knows — and only here, under
        // the user's own hand; activation never touches it.
        if (
          cfg().inspect(LEGACY_KEYS.accountsEnabled)?.globalValue !== undefined
        ) {
          await cfg().update(
            LEGACY_KEYS.accountsEnabled,
            undefined,
            vscode.ConfigurationTarget.Global,
          );
        }
      } catch (err) {
        // Same failure mode as the filter above, and the same reason to say so
        // out loud: silently leaving the section where it was would read as a
        // menu entry that does nothing.
        logError('extension.setAccountsSection', err);
        void vscode.window.showWarningMessage(
          'Flock: could not save the Accounts section setting — check that ' +
            'settings are writable.',
        );
      }
    },

    // The Shells section: the same write as Accounts, for the same reason —
    // its `when` clause is a `config.` clause the workbench re-evaluates itself.
    setShellsSection: async (on) => {
      try {
        await cfg().update(
          CONFIG_KEYS.shellsSection,
          on,
          vscode.ConfigurationTarget.Global,
        );
      } catch (err) {
        logError('extension.setShellsSection', err);
        void vscode.window.showWarningMessage(
          'Flock: could not save the Shells section setting — check that ' +
            'settings are writable.',
        );
      }
    },

    // The line under a session. No context key either: the gear menu reads the
    // value through menuState, and the views read it per render — so the write
    // is the whole of the update, and the config listener at the bottom of
    // activate() repaints on it like any other `lineage.*` change.
    setBranchDisplay: async (mode) => {
      try {
        await cfg().update(
          CONFIG_KEYS.gitBranchDisplay,
          mode,
          vscode.ConfigurationTarget.Global,
        );
      } catch (err) {
        // Same failure mode, same reason to say so: a menu entry that leaves
        // the rows exactly as they were reads as a broken control.
        logError('extension.setBranchDisplay', err);
        void vscode.window.showWarningMessage(
          'Flock: could not save the branch display mode — check that ' +
            'settings are writable.',
        );
      }
    },

    // Every branch-and-worktree switch, written together. See
    // COMMANDS.showBranchesAndWorktrees for why the verb exists and
    // BRANCH_FEATURE_SWITCHES for which six settings it is; what is decided here
    // is only how they are written.
    //
    // The OFF column is the manifest's own defaults, restated rather than
    // deleted: `update(key, undefined)` would clear the value and let a Workspace
    // or a Folder setting show through, which is a different tree from the one
    // the person just asked for. Writing the default Global explicitly means OFF
    // is the exact inverse of ON from wherever ON left things.
    setBranchAndWorktreeFeatures: async (on) => {
      const failed: string[] = [];
      for (const switch_ of BRANCH_FEATURE_SWITCHES) {
        try {
          await cfg().update(
            switch_.key,
            on ? switch_.on : switch_.off,
            vscode.ConfigurationTarget.Global,
          );
        } catch (err) {
          // Keep going rather than returning on the first failure. Six writes
          // that mostly succeeded is a tree with most of the feature in it; six
          // writes abandoned halfway is the same tree plus a command that looks
          // like it did nothing. Either way the person is told which keys are
          // still where they were.
          logError('extension.setBranchAndWorktreeFeatures', err);
          failed.push(`lineage.${switch_.key}`);
        }
      }
      if (failed.length > 0) {
        void vscode.window.showWarningMessage(
          `Flock: could not save ${failed.join(', ')} — check that settings are ` +
            'writable. Everything else was set.',
        );
      }
    },

    // ---- the recommended setup ---------------------------------------------
    //
    // The world `recommendedPlan` decides from. Everything but the last field is
    // a cache read; `maxWorktrees` costs one `git worktree list` per project
    // directory, which is why this is async and why it stops at two — the only
    // question that field answers is "does anybody have more than one checkout",
    // and probing the rest to say `47` would be work spent on a number nobody
    // reads. It rides the same WorktreeCache the branch-rows notice warms, so on
    // a window that has drawn a project it is usually already hot.
    recommendedWorld: async () => {
      let maxWorktrees = 0;
      for (const project of store.getProjects()) {
        if (project.deleted === true) continue;
        for (const dir of projectDirs(project)) {
          try {
            maxWorktrees = Math.max(maxWorktrees, (await worktrees.warm(dir)).length);
          } catch (err) {
            logError('extension.recommendedWorld', err);
          }
          if (maxWorktrees >= 2) break;
        }
        if (maxWorktrees >= 2) break;
      }
      return {
        platform: process.platform,
        tmuxBinary: findTmuxBinary(),
        tmuxMode: cfg().get<string>(CONFIG_KEYS.tmux),
        hooksInstalled: store.getHookState().installed === true,
        verbsInstalled: store.getVerbsState().installed === true,
        verbsAvailable: true,
        // CLOSED projects count. Somebody who put their last project away has
        // met the concept, and "make your first project" would be wrong.
        hasProjects: store.getProjects().some((p) => p.deleted !== true),
        unlistedCount: commandDeps.unlistedSessions?.().length ?? 0,
        branchRowsEnabled: boolCfg(CONFIG_KEYS.gitBranches, false),
        maxWorktrees,
        // The same normalizing reader every launch uses, so the picker's
        // "current" and the launcher cannot disagree about a hand-edited value.
        terminalLocation: terminalLocation(),
        soloSession: boolCfg(CONFIG_KEYS.soloSession, false),
        launchMode: cfg().get<string>(CONFIG_KEYS.launchMode),
        // RAW, both of them — `launchMode`'s contract above, for the same
        // reason. `windowModelChoices` folds the pair with the same
        // `resolveMode` this window's own gates run, so the picker's "(current)"
        // is the model the user is actually in and not the string they typed.
        mode: cfg().get<string>(CONFIG_KEYS.mode),
        workspacesEnabled: boolCfg(CONFIG_KEYS.workspacesEnabled, true),
        workspacesAutoSwitch: cfg().get<boolean>(LEGACY_KEYS.workspacesAutoSwitch),
        claudeExtensionInstalled: claudeExtensionInstalled(),
      };
    },

    // The table-driven setter behind the recommended steps. Two guards, and the
    // first is the one that matters: `update()` on a key the manifest does not
    // declare throws, so an entry that is not a contributed setting is refused
    // by name here rather than reported as a mysterious failure. The one
    // exception is DELETING a retired key: VS Code permits removing a key it no
    // longer knows, and a choice that supersedes an old spelling takes it away
    // so it cannot fold the new answer back — never given a value, only
    // removed, and only inside the user's own gesture. Writes keep going after
    // one fails, exactly as setBranchAndWorktreeFeatures does — a half-written
    // plan the person is told about beats an abandoned one they are not.
    writeSettings: async (entries) => {
      const declared = new Set<string>(Object.values(CONFIG_KEYS));
      const retired = new Set<string>(Object.values(LEGACY_KEYS));
      const unwritable: string[] = [];
      for (const entry of entries) {
        const deletesRetired =
          retired.has(entry.key) && entry.value === undefined;
        if (!declared.has(entry.key) && !deletesRetired) {
          logError(
            'extension.writeSettings',
            new Error(`${entry.key} is not a contributed setting`),
          );
          unwritable.push(entry.key);
          continue;
        }
        try {
          await cfg().update(
            entry.key,
            entry.value,
            vscode.ConfigurationTarget.Global,
          );
        } catch (err) {
          logError('extension.writeSettings', err);
          unwritable.push(entry.key);
        }
      }
      return unwritable;
    },

    // The Status verb's two binary rows: the same probes every launch makes,
    // with the same settings applied, so a row saying "found at" names the
    // binary a launch would actually run.
    cliBinaries: () => ({
      claude: claudeBin(),
      codex: codexBin(),
      codexConfigured:
        (cfg().get<string>(CONFIG_KEYS.codexBinary) ?? '').trim() !== '',
    }),

    // What the gear menu labels itself with. Read here, together, at the moment
    // the menu opens — the same three facts the `when` clauses this replaced read
    // off two context keys and one configuration value. `hookState` is the live
    // record the context key is set from, so the menu and the palette cannot
    // disagree about whether hooks are installed.
    // Through `windowModelChoices` rather than off `lineage.mode`, so the gear
    // menu's sentence and the picker's "(current)" mark come from one function
    // — and so the legacy `workspaces.enabled` pair is folded by the same
    // `resolveMode` every gate here runs, which a raw read of the setting would
    // miss. RAW values in, exactly as `recommendedWorld` hands them over.
    windowModel: () =>
      windowModelChoices({
        mode: cfg().get<string>(CONFIG_KEYS.mode),
        workspacesEnabled: boolCfg(CONFIG_KEYS.workspacesEnabled, true),
        workspacesAutoSwitch: cfg().get<boolean>(LEGACY_KEYS.workspacesAutoSwitch),
      }).find((c) => c.current)?.label,
    // The same four reads the checklist's world makes for the surface
    // question, and nothing else — no worktree probe behind opening a menu.
    surface: () =>
      surfaceChoices({
        terminalLocation: terminalLocation(),
        soloSession: boolCfg(CONFIG_KEYS.soloSession, false),
        launchMode: cfg().get<string>(CONFIG_KEYS.launchMode),
        claudeExtensionInstalled: claudeExtensionInstalled(),
      }).find((c) => c.current)?.label,
    offers: { answered: offerAnswered, markAnswered: markOfferAnswered },

    menuState: () => ({
      hooksInstalled: store.getHookState().installed === true,
      verbsInstalled: store.getVerbsState().installed === true,
      onlyActive: boolCfg(CONFIG_KEYS.onlyActiveSessions, false),
      accountsSection: boolCfg(CONFIG_KEYS.accountsSection, true),
      shellsSection: boolCfg(CONFIG_KEYS.shellsSection, true),
      branchDisplay: isBranchDisplay(
        cfg().get<string>(CONFIG_KEYS.gitBranchDisplay, DEFAULT_BRANCH_DISPLAY),
      )
        ? (cfg().get<string>(
            CONFIG_KEYS.gitBranchDisplay,
            DEFAULT_BRANCH_DISPLAY,
          ) as BranchDisplay)
        : DEFAULT_BRANCH_DISPLAY,
    }),

    // Project workspaces. The first switch to a project without tmux is the
    // moment the missing detach tier costs something — see noteMissingTmux.
    switchWorkspace: (projectId) => {
      if (projectId !== null) noteMissingTmux();
      return workspaceManager.switchTo(projectId);
    },
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
        ? desiredFolders(project, explorerAnchorPath, {
            scope: explorerScope(),
            currentDir: explorerDirFor(project),
          })
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
    // Re-root the tree at one directory, and HOLD it there. No reload, no
    // confirmation: it is the same in-place splice a switch does, and the way
    // out is to click another row or focus a session somewhere else.
    showDirectoryInExplorer: async (dir) => {
      const activeId = workspaceManager.activeProjectId();
      const active = activeId ? store.getProject(activeId) : undefined;
      if (!active) return;
      if (!explorerSync.anchored()) {
        void vscode.window.showInformationMessage(
          'Flock: this window is not a Flock workspace, so the Explorer ' +
            'cannot be repointed. Run "Flock: Follow the Session I Am In" ' +
            'once to set it up.',
        );
        return;
      }
      explorerDirOverride = normalizeDir(dir);
      const outcome = await explorerSync.sync(active, explorerDirOverride);
      if (outcome === 'not-anchored' || outcome === 'rejected') {
        // Nothing moved, so the mark must not claim it did.
        explorerDirOverride = null;
      }
      refreshExplorerHeader();
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

  // The dispatch queue's clockwork. Launches go through commandDeps.
  // launchSession so a dispatched session takes the same account-safe path
  // every clicked one does (pin backfill, parked-alias attach); the entry's
  // id becomes the session id — minted at queue time, so a crash between
  // decide and launch cannot double-start.
  dispatchHost = new DispatchHost({
    pending: () => store.dispatchEntries().filter((d) => d.done === undefined),
    settle: (id, done) => store.settleDispatch(id, done),
    profiles: () => accountDeps.accounts(),
    usageMap: () => accountDeps.usageMap(),
    refreshUsage: (profiles, force) => accountDeps.refreshUsage(profiles, force),
    defaultRouting: () => accountDeps.defaultRouting(),
    launch: async (l) => {
      const entry = l.entry;
      const title = entry.title ?? defaultSessionTitle(entry.cwd, []);
      await commandDeps.recordLaunch(entry.id, null, entry.cwd);
      await commandDeps.upsertRecord(entry.id, { title });
      const binding = await commandDeps.launchSession({
        sessionId: entry.id,
        ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
        ...(entry.prompt !== undefined ? { prompt: entry.prompt } : {}),
        title,
        env: envForProfile(l.profile),
        profileId: l.profile.id,
        ...(l.profile.provider === 'codex'
          ? { provider: 'codex' as const }
          : {}),
      });
      if (!binding) return false;
      try {
        await accountDeps.pinSession(entry.id, l.profile.id);
      } catch (err) {
        logError('dispatch.pinSession', err);
      }
      refreshNow();
      return true;
    },
    now: () => Date.now(),
    notify: (m) => void vscode.window.showInformationMessage(m),
  });
  context.subscriptions.push(dispatchHost);
  // Fresh usage numbers are the signal the gate waits on; queue edits poke
  // through the verbs directly, and the activation poke below covers a queue
  // that waited out a restart. Cross-window edits arrive with the next usage
  // tick — the queue's cadence never depends on a repaint.
  context.subscriptions.push(
    accountDeps.onUsageChanged(() => dispatchHost?.poke()),
  );
  dispatchHost.poke();

  context.subscriptions.push(registerCommands(commandDeps));

  // THE ONE GUARANTEED FRONT DOOR. Every other first-launch surface here is
  // deliberately hard to trigger — the recommended-setup notice below needs no
  // projects AND two recommended steps left, the tmux notice needs tmux missing
  // — so an install where none of them fires greets its person with an empty
  // sidebar and silence. A genuinely fresh install deserves exactly one thing
  // it can count on: the walkthrough, opened for it, once.
  //
  // "Genuinely fresh" is the store's own testimony — no projects and no session
  // records — because those are the two things every path into Flock writes,
  // and either one existing means somebody has already been through a door.
  // The key is stamped BEFORE the check, not after the command: whichever way
  // the freshness question resolves is this install's answer for good, so an
  // upgrade with a tree full of sessions is judged once and never re-asked, and
  // a failure to open cannot queue a second attempt onto some later launch
  // where the page would arrive as a non sequitur.
  setTimeout(() => {
    void (async (): Promise<void> => {
      try {
        if (context.globalState.get<boolean>(WALKTHROUGH_KEY) === true) return;
        await context.globalState.update(WALKTHROUGH_KEY, true);
        const fresh =
          store.getProjects().length === 0 &&
          Object.keys(store.all()).length === 0;
        if (!fresh) return;
        await vscode.commands.executeCommand(
          'workbench.action.openWalkthrough',
          WALKTHROUGH_REF,
        );
        // ONE DOOR. The walkthrough's second step offers the checklist the
        // recommended-setup toast below would offer, so on the launch that
        // opened the page the toast is stamped as shown rather than fired a
        // few seconds later on top of it — the same offer twice is a first
        // impression worth avoiding. Stamped AFTER the open, so a page that
        // failed to open leaves the toast as the fallback door; and stamped
        // for good, because this install has now been shown the offer, by the
        // page. The toast stays for the install the page never opens for: an
        // upgrade with no projects and two things left to turn on.
        await context.globalState.update(RECOMMENDED_NOTICE_KEY, true);
      } catch (err) {
        logError('walkthrough.frontDoor', err);
      }
    })();
  }, WALKTHROUGH_DELAY_MS);

  // THE ONE-TIME OFFER OF THE RECOMMENDED SETUP. Same shape as the two notices
  // above — deferred off the activation path, decided by a pure function
  // (`recommendedNotice` in src/recommend.ts), suppressed only by an explicit
  // answer — and scheduled from here rather than from beside them because the
  // world it needs is `commandDeps.recommendedWorld`, which does not exist
  // until this line.
  //
  // It is deliberately hard to trigger: a tree with NO PROJECTS and at least
  // two things left to turn on. That is a first launch, or near enough, and it
  // is the one state where the sidebar has nothing else to say — except on the
  // genuinely fresh install, where the walkthrough above has already opened
  // and stamped this key: the page is the one door, and this toast is for the
  // upgrade the page never opens for.
  const recommendedNoticeShown = (): boolean =>
    context.globalState.get<boolean>(RECOMMENDED_NOTICE_KEY) === true;
  setTimeout(() => {
    void (async (): Promise<void> => {
      try {
        if (recommendedNoticeShown()) return;
        const world = await commandDeps.recommendedWorld?.();
        if (!world) return;
        if (
          recommendedNotice({ world, dismissed: recommendedNoticeShown() }) !==
          'offer'
        ) {
          return;
        }
        recommendedNoticeOffered = true;
        const SET_UP = 'Set It Up';
        const NEVER = 'Not now';
        const choice = await vscode.window.showInformationMessage(
          'Flock works out of the box, but the parts that make it fast are ' +
            'off until you ask: instant updates instead of a three-second ' +
            'poll, and letting Claude fork its own sessions. Both write files ' +
            'in your home directory, which is why nothing turned them on for ' +
            'you. The setup checklist says what each one does before you tick ' +
            'it.',
          SET_UP,
          NEVER,
        );
        if (choice === SET_UP) {
          await context.globalState.update(RECOMMENDED_NOTICE_KEY, true);
          await vscode.commands.executeCommand(COMMANDS.recommendedSetup);
        } else if (choice === NEVER) {
          await context.globalState.update(RECOMMENDED_NOTICE_KEY, true);
        }
        // Dismissed with the X: not suppressed, so it asks once more next
        // time. The same rule both notices above follow.
      } catch (err) {
        logError('recommended.notice', err);
      }
    })();
  }, RECOMMENDED_NOTICE_DELAY_MS);

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

  // ------------------------------------------------------------- codex rows
  //
  // `claude agents --json` is the roster, and it is a CLAUDE registry: it will
  // never list a Codex session, because Codex has no equivalent command to ask.
  // So the roster this window renders is the fetched one PLUS the Codex rows
  // Flock can vouch for itself, merged before change detection so that every
  // consumer downstream — the forest, the dots, the ages, the workspace
  // manager — treats the two identically and none of them has to know.
  //
  // WHAT COUNTS AS LIVE, and why it is these three facts and no others. There
  // is no process to poll, so liveness is what Flock recorded when it acted:
  //
  //   bound here     a terminal in THIS window is holding it. Direct
  //                  observation, and the only fact needing no record.
  //   boundWindowId  SOME live window is holding it. Machine-wide and
  //                  self-cleaning: window pruning nulls this field on every
  //                  session bound to a window that has gone (state.ts), which
  //                  is what stops a crashed window's rows from being live
  //                  forever.
  //   tmux           a workspace switch parked it into the private tmux
  //                  server, so it is running detached.
  //
  // `launchedByUs` is deliberately NOT in that list, though hostOf uses it for
  // OWNERSHIP. It is written once and never cleared, so a session that ended
  // months ago still carries it; believing it here would make every Codex
  // session Flock ever started immortal in the tree. Ownership is a permanent
  // fact and liveness is not, and this is the seam where they part company.
  //
  // A Codex session that is NOT live by this test is not lost — the rollout
  // index gives it an archived row, exactly as a closed Claude session gets
  // one from its transcript.
  const codexLiveEntries = (): RosterEntry[] => {
    const out: RosterEntry[] = [];
    let records: Record<string, EditorialRecord>;
    try {
      records = store.all();
    } catch (err) {
      logError('extension.codexLiveEntries', err);
      return out;
    }
    for (const [id, rec] of Object.entries(records)) {
      if (!rec || rec.provider !== 'codex') continue;
      if (!isSessionId(id)) continue;
      const held =
        registry.isBoundHere(id) ||
        (typeof rec.boundWindowId === 'string' && rec.boundWindowId !== '') ||
        (typeof rec.tmux === 'string' && rec.tmux !== '');
      if (!held) continue;
      const entry: RosterEntry = { sessionId: id, kind: 'interactive' };
      if (typeof rec.cwd === 'string' && rec.cwd !== '') entry.cwd = rec.cwd;
      out.push(entry);
    }
    return out;
  };

  /** The fetched roster with this window's Codex rows folded in. A Codex id
   *  the fetch somehow already carries wins, so the merge can never double a
   *  row. */
  const withCodexRows = (entries: RosterEntry[]): RosterEntry[] => {
    const extra = codexLiveEntries();
    if (extra.length === 0) return entries;
    const seen = new Set(entries.map((e) => e.sessionId));
    return [...entries, ...extra.filter((e) => !seen.has(e.sessionId))];
  };

  /**
   * Find the session id a just-launched Codex process minted, and move the row
   * onto it.
   *
   * THE PROBLEM. `claude` takes `--session-id`, so Flock pre-mints the id and
   * the binding is exact from the first instant. `codex` has no such flag: it
   * mints its own id internally and the first place that id becomes visible is
   * the name of the rollout file it opens. So a Codex launch is bound under a
   * PROVISIONAL id and has to be moved onto the real one a moment later.
   *
   * THE MOVE is the same one a Claude `/fork` or `/clear` already performs when
   * the CLI re-keys itself mid-session (see detectPidRekeys): `rebind` moves
   * the terminal, `appendChainMember` records that the two ids are generations
   * of one conversation, and the collapse in generations.ts renders them as a
   * single row. Reusing that path rather than inventing one is what keeps the
   * provisional id from ever surfacing as a second row.
   *
   * NEVER GUESSES. Every poll re-reads the store, so ids already claimed by
   * another row are excluded, and matchRollout additionally demands the same
   * cwd and a start inside the window. When nothing matches for the whole
   * window the launch is left on its provisional id and a line goes to the log
   * — the session is still bound, still closable and still in the tree; it
   * simply does not get its archived twin. That is a worse row, not a wrong
   * one, which is the correct direction to fail in.
   */
  const adoptCodexSession = (
    provisionalId: string,
    opts: LaunchOptions,
    spawnedAt: number,
  ): void => {
    const sessionsDir = codexSessionsDir(
      opts.env?.[CODEX_HOME_ENV] ?? undefined,
    );
    const deadline = spawnedAt + CODEX_ADOPT_WINDOW_MS;

    const attempt = (): void => {
      if (Date.now() > deadline) {
        log(
          'codex: no rollout matched the launch of',
          shortId(provisionalId),
          '— the row keeps its provisional id',
        );
        return;
      }
      let hit: ReturnType<typeof matchRollout> = null;
      try {
        // Re-read the claimed set every attempt: another window may have
        // adopted a rollout since the last one.
        const taken = new Set<string>();
        for (const [id, rec] of Object.entries(store.all())) {
          if (rec?.provider === 'codex' && id !== provisionalId) taken.add(id);
        }
        hit = matchRollout(
          scanRollouts({ sessionsDirs: [sessionsDir], maxAgeDays: 1 }),
          {
            spawnedAt,
            taken,
            windowMs: CODEX_ADOPT_WINDOW_MS,
            ...(typeof opts.cwd === 'string' && opts.cwd !== ''
              ? { cwd: opts.cwd }
              : {}),
          },
        );
      } catch (err) {
        logError('extension.adoptCodexSession', err);
        hit = null;
      }

      if (hit === null) {
        const timer = setTimeout(attempt, CODEX_ADOPT_POLL_MS);
        (timer as unknown as { unref?: () => void }).unref?.();
        return;
      }

      const realId = hit.sessionId;
      log(
        'codex: adopting',
        shortId(realId),
        'for the launch bound as',
        shortId(provisionalId),
      );
      // The record FIRST, so the row that appears under the real id already
      // knows it is a Codex session, which account it is on and where it runs
      // — otherwise the next rebuild draws it with a Claude glyph and no pin.
      const patch: Record<string, unknown> = {
        provider: 'codex',
        launchedByUs: true,
      };
      if (typeof opts.cwd === 'string' && opts.cwd !== '') patch.cwd = opts.cwd;
      void store.upsert(realId, patch);
      if (opts.profileId !== undefined) {
        void store.setSessionProfile(realId, opts.profileId);
      }
      if (opts.subprojectId !== undefined) {
        void store.setSessionSubproject(realId, opts.subprojectId);
      }
      void store.appendChainMember(provisionalId, realId);
      registry.rebind(provisionalId, realId);
      if (haveRoster) void scheduleRebuild(lastEntries);
    };

    const timer = setTimeout(attempt, CODEX_ADOPT_POLL_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
  };

  const onResult = (rawResult: RosterResult): void => {
    if (!rawResult.ok) {
      // Keep the last good forest — the tree must not flash empty because the
      // CLI was briefly unavailable.
      log('roster: fetch failed —', rawResult.error ?? 'unknown error');
      return;
    }

    // Codex rows join HERE, before anything reads the entries, so change
    // detection, re-association, the forest and every consumer past this point
    // see one roster rather than two. See codexLiveEntries.
    const r: RosterResult = {
      ...rawResult,
      entries: withCodexRows(rawResult.entries),
    };

    detectPidRekeys(r.entries);
    // Before `lastEntries` moves: the claim's baseline is the roster as it was
    // when the delegate was asked, and this is the pass that can see a row the
    // previous one could not.
    settleDelegatedClaim(r.entries);

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

  poller = new RosterPoller(fetchFiltered, onResult, DEFAULT_POLL_INTERVAL_MS);
  context.subscriptions.push(poller);
  // start() already performs the immediate first fetch — a separate first tick
  // would only be coalesced away.
  poller.start();

  // The watcher callback closes over the poller, so it starts last.
  syncHookWatcher();
  syncVerbsWatcher();

  // ---------------------------------------------------- 10. config changes

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(CONFIG_SECTION)) return;
      syncHookWatcher();
      syncVerbsWatcher();
      // Flipping showArchived on must populate the index immediately rather
      // than at the next 30 s window, or the setting looks broken.
      if (e.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_KEYS.showArchived}`)) {
        forceArchiveScan = true;
      }
      // The exit-to-shell hooks live in the tmux conf, so the flip is a file
      // rewrite. It cannot take effect on sessions already running: tmux reads
      // the conf when the SERVER starts, and ours outlives every one of them.
      if (
        e.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_KEYS.exitToShell}`)
      ) {
        rewriteTmuxConf();
        log(
          'tmux:',
          exitShell() === null
            ? 'exit-to-shell off — /exit closes the tab again'
            : `exit-to-shell on (${exitShell()}) — applies to sessions started after the tmux server next restarts`,
        );
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
      // The status bar's visibility follows the resolved window model, so every
      // key `resolveMode` reads has to wake it: the mode itself, the deprecated
      // `workspaces.enabled` and the retired `workspaces.autoSwitch`, either of
      // which still folds a `project` window down to `root`. Watching only the
      // mode would leave somebody who deleted an old key looking at a stale
      // button until their next reload.
      if (
        e.affectsConfiguration(
          `${CONFIG_SECTION}.${CONFIG_KEYS.workspacesEnabled}`,
        ) ||
        e.affectsConfiguration(
          `${CONFIG_SECTION}.${LEGACY_KEYS.workspacesAutoSwitch}`,
        ) ||
        e.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_KEYS.mode}`)
      ) {
        updateWorkspaceStatusBar();
      }
      // The mode's when-clause mirror follows the setting wherever it was
      // edited; the grouping change (folder scope on/off) rides the rebuild
      // at the bottom of this handler.
      void syncModeContext();
      // Turning pull requests ON has to clear the cache, and specifically the
      // FAILURES in it: the cache holds a failed probe for fifteen minutes on
      // purpose (see src/pullRequests.ts), so somebody who turned the setting on,
      // installed `gh` and turned it on again would otherwise sit in front of a
      // remembered "no" for a quarter of an hour. Turning it OFF clears it too,
      // which is what stops a request that is no longer being refreshed from
      // staying on a row.
      if (
        e.affectsConfiguration(
          `${CONFIG_SECTION}.${CONFIG_KEYS.gitPullRequests}`,
        )
      ) {
        pullRequests.invalidate();
        log(
          'pr:',
          boolCfg(CONFIG_KEYS.gitPullRequests, false)
            ? 'enabled — Flock will run `gh pr list` while the view is visible'
            : 'disabled — Flock makes no network requests',
        );
        refreshViews();
      }
      // The accounts view is contributed under a `config.` when-clause, so
      // turning the section on reveals a view whose provider does not exist
      // yet — the workbench then renders "no data provider registered" until a
      // reload. Registering it here on the way up closes that gap. There is no
      // way down: a TreeView cannot be un-registered without leaking the old
      // one, and the when-clause has already hidden it, so turning the section
      // off simply leaves an invisible provider that nothing ever resolves.
      // The retired key is watched too: deleting an old `accounts.enabled:
      // false` by hand is the other way the answer flips to "draw it".
      if (
        (e.affectsConfiguration(
          `${CONFIG_SECTION}.${CONFIG_KEYS.accountsSection}`,
        ) ||
          e.affectsConfiguration(
            `${CONFIG_SECTION}.${LEGACY_KEYS.accountsEnabled}`,
          )) &&
        accountsViewController === undefined &&
        accountsSectionOn()
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
      // onlyActiveSessions and notifications.enabled are read per buildForest,
      // unclaimedSessions per getChildren — a rebuild covers them all.
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
