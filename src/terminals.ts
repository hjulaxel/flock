// src/terminals.ts — terminal launch, binding, re-association, rename.
//
// Imports vscode, ./types, ./log, ./tmux, node:crypto, and ./accounts — the
// last only for its env-var-name guard, borrowed rather than copied so the two
// modules cannot disagree about what a legal variable name is.
//
// ACCOUNT ENVIRONMENT. `LaunchOptions.env` is the chosen account's
// environment (CLAUDE_CONFIG_DIR / CODEX_HOME / an API key), and it has to
// reach the claude process by BOTH routes this module can launch by:
// `creationOptions.env` for a bare launch, and the tmux wrap's `-e` for a
// detachable one. A wrapped launch that set only the terminal's env would hand
// the variables to the tmux CLIENT and leave claude — which lives inside the
// server — on whatever the SERVER was started with, i.e. on whichever account
// happened to open the first wrapped session since the last reboot. The stamp
// is written LAST in both places so a profile can never overwrite the node id
// the whole binding table is keyed on.
//
// Design invariants, each established empirically. Do not "improve" them away:
//
//   * claude IS the terminal process: `shellPath: <claude binary>` plus
//     `shellArgs: ['--session-id', <uuid>, …]`. No shell, no init race, no
//     half-eaten launch line, and the session id is ours by construction.
//     DETACH TIER (src/tmux.ts): when the wiring provides a tmux spawn, the
//     same argv is wrapped in `tmux -L lineage new-session -A -s <name> --`,
//     so the terminal process is the tmux CLIENT and claude runs inside the
//     private server. Everything above still holds — direct exec, no shell —
//     and disposing the terminal then DETACHES instead of killing, which is
//     what workspace parking rides on.
//   * Shell integration will NEVER activate for us — the pty host dispatches on
//     basename(executable) over exactly bash|fish|pwsh|zsh (+3 Windows names)
//     and otherwise returns `unsupportedShell`; custom shellArgs disqualify it
//     anyway. So this module never touches onDidStart/EndTerminalShellExecution,
//     TerminalShellExecution.read(), or shellIntegration.cwd, and there is no
//     "wait for shell integration" path. Liveness comes from the roster; close
//     detection from `Terminal.exitStatus` + onDidCloseTerminal (neither needs
//     shell integration).
//   * Re-association after a window RELOAD: the pty survives and the revived
//     Terminal object's `creationOptions` is reconstructed from the persisted
//     launch config INCLUDING `env`, so we stamp ENV_NODE_ID at creation and
//     read it back. After a full app RESTART the process is relaunched (new
//     pid), so we additionally match `Terminal.processId` against the roster's
//     per-session pid — claude being the terminal process makes that exact.
//   * Never set `strictEnv`: claude needs the inherited environment to find its
//     own configuration.
//   * Every Terminal member is readonly — name, icon and colour are fixed at
//     creation. Rename therefore goes through show(true) + the hidden
//     `renameWithArg` command; same pattern for moveToEditor / moveToPanel.
//
// Everything degrades: a missing CLI, an untrusted workspace, a host API that
// is not present (the unit-test mock exposes an empty `window`/`commands`) and
// a terminal that dies mid-launch all produce a logged no-op, never a throw.

import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';

import { ENV_NODE_ID, isSessionId, shortId } from './types';
import type {
  DisposableLike,
  LaunchOptions,
  ProviderId,
  RosterEntry,
  TerminalBinding,
  TerminalDeps,
  TerminalLocationPref,
  TmuxSpawn,
} from './types';
import { isEnvVarName } from './accounts';
import { buildCodexArgs } from './codex';
import { isPidAlive, listDescendants, reapSurvivors } from './procs';
import {
  buildTmuxArgs,
  sessionIdOfTmuxName,
  tmuxNameOfTerminal,
  tmuxSessionName,
} from './tmux';
import { log, logError } from './log';

// --------------------------------------------------------------- constants

/** Hidden (`f1:false`), active-terminal-only command. `executeCommand` still
 *  works — its precondition does not block programmatic invocation. */
export const RENAME_COMMAND = 'workbench.action.terminal.renameWithArg';
export const MOVE_TO_EDITOR_COMMAND = 'workbench.action.terminal.moveToEditor';
export const MOVE_TO_PANEL_COMMAND =
  'workbench.action.terminal.moveToTerminalPanel';
/** Floating-window support (VS Code 1.85+). Absent in older hosts and in
 *  Cursor builds that predate it — a failed executeCommand just leaves the
 *  session as an editor tab, which is the sane degradation. */
export const MOVE_EDITOR_TO_NEW_WINDOW_COMMAND =
  'workbench.action.moveEditorToNewWindow';

/** `vscode.TerminalLocation` is an enum the unit-test mock does not ship, and
 *  its values are API-stable. */
const TERMINAL_LOCATION_PANEL = 1;
const TERMINAL_LOCATION_EDITOR = 2;

/** Upper bound on any wait for `Terminal.processId` — see `pidOf`. */
const PID_TIMEOUT_MS = 5000;

/** Detach tier: how long/often the background pane-pid lookup retries. The
 *  tmux session is created by the command line the terminal is still
 *  starting, so the first attempts can race it; ten tries over ~3 s is far
 *  beyond any observed session start. */
const TMUX_PID_ATTEMPTS = 10;
const TMUX_PID_RETRY_MS = 300;

/** How long an active-instance-addressed move waits for its terminal to
 *  actually become the active one (see runOnFocusedTerminal), and how often
 *  it looks.
 *
 *  Three deadlines because there are three attempts, cheapest first. The soft
 *  one belongs to the reveal that does NOT take focus — it usually confirms
 *  immediately and, when it does not, giving up on it fast costs less than the
 *  keyboard jumping around the window for every session a switch stows. The
 *  last one is generous because by then the workbench is demonstrably busy and
 *  a skipped move is a session stranded as an editor tab. */
const ACTIVE_SOFT_WAIT_MS = 250;
const ACTIVE_WAIT_MS = 600;
const ACTIVE_LAST_WAIT_MS = 1000;
const ACTIVE_POLL_MS = 30;

/** Shutdown-time bare reap (see reapBareOnShutdown): how long to wait before
 *  RE-probing a pty root that was still alive when its close event fired. On
 *  a true window close VS Code's kill of the pty may land a beat after the
 *  event; on a reload the root never dies at all. One short beat separates
 *  the two without holding the dying host open. */
const SHUTDOWN_REAP_PROBE_MS = 400;
/** The escalation ladder's wait for that same path. REAP_WAIT_MS (1.5 s) is
 *  sized for a close verb's fire-and-forget comfort; here the extension host
 *  is dying under us and a ladder that cannot fit inside whatever time
 *  remains reaps nothing at all — and the children re-parented the instant
 *  the root died, so there is no parent-follows-child grace worth waiting
 *  out. Best-effort by construction; the persisted-snapshot rescue at next
 *  activation (extension.ts) is the reliable half. */
const SHUTDOWN_REAP_WAIT_MS = 300;

const MISSING_BINARY_MESSAGE =
  'Claude CLI not found — set lineage.claudeBinary to the full path of your ' +
  'claude executable.';
const MISSING_CODEX_BINARY_MESSAGE =
  'Codex CLI not found — set lineage.codexBinary to the full path of your ' +
  'codex executable.';
const RESTRICTED_MESSAGE =
  'Flock cannot start a Claude session here: VS Code blocks terminals in ' +
  'Restricted Mode. Trust this workspace and try again.';

/** How a bound terminal ended. `shutdown` = the window closed/reloaded (the
 *  session is very likely still alive), `user` = the user killed it. */
export type ExitReason = 'shutdown' | 'user' | 'other';

interface ExitEvent {
  sessionId: string;
  code: number | undefined;
  reason: ExitReason;
  /** The tmux session that backed the terminal, when the launch was wrapped.
   *  Carried on the event because the binding is already unbound by the time
   *  subscribers run — and the SHUTDOWN listener in extension.ts needs it to
   *  stamp the detach grace on a wrapped session the closing window is
   *  leaving behind (a running process must never be deadline-less). */
  tmuxName?: string;
}

interface BoundEntry {
  terminal: vscode.Terminal;
  binding: TerminalBinding;
  /** BARE terminals only: the last descendant walk of `binding.pid`, taken at
   *  pid resolution and refreshed by the lifecycle sweep's minute tick. The
   *  post-mortem reap target list for a close the extension did NOT initiate
   *  (the user's tab X): by the time that close event arrives the pty is
   *  dead, the children have re-parented to PID 1 and a fresh ppid walk can
   *  never find them again — so the honest targets are the pids that were
   *  provably this root's descendants within the last minute. Pid reuse in
   *  that window is the accepted residual risk (the reap probes liveness and
   *  swallows ESRCH; macOS allocates pids upward). */
  bareKids?: number[];
}

// ----------------------------------------------------------- host adapters
// The vitest mock ships an intentionally empty `window`/`commands`, and a host
// (Cursor, Windsurf, an older build) may lack an individual member. Every
// access goes through these so importing this module — and unit-testing its
// pure helpers — never depends on a live workbench.

function windowApi(): Partial<typeof vscode.window> {
  return vscode.window;
}

function commandsApi(): Partial<typeof vscode.commands> {
  return vscode.commands;
}

function isWorkspaceTrusted(): boolean {
  const ws: { isTrusted?: boolean } | undefined = vscode.workspace;
  // Only an explicit `false` blocks us; an absent API means "assume trusted".
  return ws === undefined || ws.isTrusted !== false;
}

function showError(message: string): void {
  log('terminals:', message);
  try {
    const w = windowApi();
    if (typeof w.showErrorMessage === 'function') {
      void w.showErrorMessage(message);
    }
  } catch (err) {
    logError('terminals.showErrorMessage', err);
  }
}

/**
 * `value`, or `undefined` once `ms` has elapsed. The timer is always cleared,
 * so a resolved race never holds the host process open.
 */
function withTimeout<T>(
  value: Thenable<T>,
  ms: number,
): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    let done = false;
    const finish = (v: T | undefined): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => finish(undefined), ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    void Promise.resolve(value).then(finish, () => finish(undefined));
  });
}

/** Yield for `ms`. Unref'd so a poll in flight never holds the host open. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

/** Run `fn` on the next microtask, swallowing anything it throws. Used so that
 *  bind events raised by `reassociate()` still reach listeners that activation
 *  subscribes immediately AFTER the call. */
function soon(fn: () => void): void {
  void Promise.resolve().then(() => {
    try {
      fn();
    } catch (err) {
      logError('terminals.deferred', err);
    }
  });
}

/** `vscode.TerminalExitReason` is absent under the unit-test mock; fall back to
 *  the API's stable numeric values. */
function exitReasonOf(
  status: vscode.TerminalExitStatus | undefined,
): ExitReason {
  if (!status) return 'other';
  const reasons: typeof vscode.TerminalExitReason | undefined =
    vscode.TerminalExitReason;
  const shutdown = reasons ? reasons.Shutdown : 1;
  const user = reasons ? reasons.User : 3;
  if (status.reason === shutdown) return 'shutdown';
  if (status.reason === user) return 'user';
  return 'other';
}

// ------------------------------------------------------------ pure helpers

/** Pre-mint the session id so the terminal ↔ session binding is deterministic
 *  and exact, instead of scraped back out of claude's output. */
export function mintSessionId(): string {
  return randomUUID();
}

/**
 * Pure. Three mutually exclusive forms:
 *
 *  - resume  `['--resume', resumeId]` — reopen a CLOSED session. NO
 *    `--session-id` is passed: adding one would ask claude to both keep and
 *    replace the id. The caller sets `sessionId === resumeId` so the
 *    LINEAGE_NODE_ID stamp and the binding name the session being reopened —
 *    and when the CLI re-mints the id anyway (it can: a plain resume may
 *    write a fresh transcript under a fresh id), that stamp is
 *    precisely what lets the hook re-key the new generation onto this
 *    conversation instead of it surfacing as a duplicate row.
 *  - fork    `['--fork-session', '--resume', parentId, '--session-id', child]`
 *  - new     `['--session-id', id]`
 *
 * A non-empty `prompt` is APPENDED as the final positional argument.
 * `resumeId` wins if both are somehow set — resuming into a fork would be a
 * silent data-losing surprise, so the narrower intent is honoured.
 *
 * ORDERING IS LOAD-BEARING for `--add-dir`, which is VARIADIC: it consumes
 * every following bare word until the next flag. It therefore goes FIRST, so
 * one of the mode flags always terminates it. Emitted last it would swallow
 * the positional prompt as another directory.
 */
export function buildShellArgs(opts: LaunchOptions): string[] {
  const args: string[] = [];
  const resumeId =
    typeof opts.resumeId === 'string' && opts.resumeId.length > 0
      ? opts.resumeId
      : null;

  const dirs = (opts.addDirs ?? []).filter(
    (d) => typeof d === 'string' && d.trim() !== '',
  );
  if (dirs.length > 0) args.push('--add-dir', ...dirs);

  if (resumeId !== null) {
    args.push('--resume', resumeId);
  } else {
    if (typeof opts.parentId === 'string' && opts.parentId.length > 0) {
      args.push('--fork-session', '--resume', opts.parentId);
    }
    args.push('--session-id', opts.sessionId);
  }

  // Both take exactly one value, so they are safe anywhere after the mode
  // flags and before the positional prompt.
  if (
    typeof opts.sessionName === 'string' &&
    opts.sessionName.trim().length > 0
  ) {
    args.push('--name', opts.sessionName);
  }
  if (
    typeof opts.appendSystemPrompt === 'string' &&
    opts.appendSystemPrompt.trim().length > 0
  ) {
    args.push('--append-system-prompt', opts.appendSystemPrompt);
  }

  if (typeof opts.prompt === 'string' && opts.prompt.trim().length > 0) {
    args.push(opts.prompt);
  }
  return args;
}

/**
 * The account environment for a launch, cleaned.
 *
 * A launch env arrives from the routing resolver, which builds it from a state
 * file the user can hand-edit, so it is validated here as well: a key that is
 * not a legal environment variable name, or a value that is not a string,
 * would be silently dropped by the pty on one path and passed through as a
 * malformed `-e KEY=VALUE` on the other — the two tiers must agree on exactly
 * what the process gets.
 *
 * A NUL in a value cannot survive an execve, and a value containing a newline
 * would break the `-e` argument at a shell boundary we do not control; both
 * are dropped rather than truncated. Never logged: on an API-key profile the
 * value IS the credential.
 */
export function launchEnv(
  env: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env || typeof env !== 'object' || Array.isArray(env)) return out;
  for (const [key, value] of Object.entries(env)) {
    if (!isEnvVarName(key)) continue;
    if (typeof value !== 'string') continue;
    if (value.includes('\0') || value.includes('\n')) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Read our node-id stamp back out of a terminal's creation options. Guarded:
 * `creationOptions` is `TerminalOptions | ExtensionTerminalOptions`, and the
 * latter (a pty-backed extension terminal) has no `env` at all.
 */
export function nodeIdOfTerminal(terminal: {
  readonly creationOptions?: unknown;
}): string | null {
  const opts = terminal.creationOptions;
  if (!opts || typeof opts !== 'object') return null;
  if ('pty' in opts) return null; // ExtensionTerminalOptions — not ours
  const env = (opts as { env?: unknown }).env;
  if (!env || typeof env !== 'object') return null;
  const raw = (env as Record<string, unknown>)[ENV_NODE_ID];
  return isSessionId(raw) ? raw : null;
}

/** Default terminal name for a session: the CLI that is running in it, then
 *  the short id. Provider-aware because the tab is the one place a user reads
 *  what a terminal IS, and every Codex tab calling itself `claude` would be a
 *  lie told several times per window. */
export function defaultTerminalName(
  sessionId: string,
  provider?: ProviderId,
): string {
  return `${provider === 'codex' ? 'codex' : 'claude'} · ${shortId(sessionId)}`;
}

/**
 * Pure. The numeric `TerminalOptions.location` for a preference, or undefined
 * to let the host decide.
 *
 * A Claude session is a place you work in for an hour, not a command you run —
 * so it belongs in the editor area as a normal tab (its own title, its own
 * split, side by side with files), not squeezed into the terminal panel. That
 * is why 'editor' is the default and why 'newWindow' also starts as an editor
 * tab: the floating window is produced by MOVING that tab afterwards, which is
 * the only mechanism the API offers.
 */
export function locationValueOf(
  pref: TerminalLocationPref | undefined,
): number | undefined {
  const loc: { Panel?: number; Editor?: number } | undefined =
    vscode.TerminalLocation;
  const panel = loc?.Panel ?? TERMINAL_LOCATION_PANEL;
  const editor = loc?.Editor ?? TERMINAL_LOCATION_EDITOR;
  if (pref === 'panel') return panel;
  if (pref === 'editor' || pref === 'newWindow' || pref === undefined) {
    return editor;
  }
  return undefined;
}

// ------------------------------------------------------------- the registry

export class TerminalRegistry implements DisposableLike {
  private readonly deps: TerminalDeps;
  private readonly bound = new Map<string, BoundEntry>();
  private readonly subs: DisposableLike[] = [];

  private readonly bindEmitter = new vscode.EventEmitter<TerminalBinding>();
  private readonly exitEmitter = new vscode.EventEmitter<ExitEvent>();
  private readonly activeEmitter = new vscode.EventEmitter<string | null>();

  /** Session ids `launch()` is mid-way through claiming. The host normally
   *  delivers onDidOpenTerminal asynchronously, but this keeps the open
   *  handler from binding (and announcing) a terminal launch() owns even if it
   *  ever arrives synchronously from createTerminal. */
  private readonly claiming = new Set<string>();

  /** Last value pushed through `onDidChangeActive`, so we never re-announce an
   *  unchanged selection (each announcement costs a tree refresh). */
  private lastActive: string | null = null;
  /** False when the host gave us no onDidCloseTerminal — then `closeTerminal`
   *  must synthesize the unbind itself. */
  private closeWatched = false;
  private disposed = false;

  constructor(deps: TerminalDeps) {
    this.deps = deps;

    const w = windowApi();

    if (typeof w.onDidCloseTerminal === 'function') {
      this.track(w.onDidCloseTerminal((t) => this.handleClose(t)));
      this.closeWatched = true;
    } else {
      log('terminals: onDidCloseTerminal unavailable — exit events degraded');
    }

    // Revived terminals can arrive after activation on a window reload; rebind
    // them the moment they show up rather than only at reassociate() time.
    if (typeof w.onDidOpenTerminal === 'function') {
      this.track(w.onDidOpenTerminal((t) => this.handleOpen(t)));
    }

    if (typeof w.onDidChangeActiveTerminal === 'function') {
      this.track(w.onDidChangeActiveTerminal((t) => this.handleActive(t)));
    }
  }

  // ------------------------------------------------------------ re-binding

  /**
   * Window-reload path. Walks `vscode.window.terminals` and rebinds every
   * terminal carrying our `ENV_NODE_ID` stamp in `creationOptions.env`; also
   * prunes bindings whose terminal is no longer present. Idempotent — safe to
   * call more than once. Returns the number of terminals newly re-associated.
   */
  reassociate(): number {
    if (this.disposed) return 0;
    const terminals = this.allTerminals();
    if (!terminals) return 0;

    const present = new Set<vscode.Terminal>();
    const fresh: TerminalBinding[] = [];

    for (const terminal of terminals) {
      present.add(terminal);
      if (this.findByTerminal(terminal)) continue;
      const sessionId = nodeIdOfTerminal(terminal);
      if (!sessionId) continue;
      if (this.bound.has(sessionId) || this.claiming.has(sessionId)) continue;
      const binding = this.bind(sessionId, terminal);
      fresh.push(binding);
      // A revived BARE terminal needs its pid back (same rule as handleOpen:
      // wrapped bindings get theirs from the pane lookup) — without it the
      // close-time tree reap has no root to walk and silently degrades to the
      // orphaning dispose this build exists to remove.
      if (binding.tmuxName === undefined) {
        void this.pidOf(terminal).then((pid) => {
          if (
            pid !== undefined &&
            this.bound.get(sessionId)?.binding === binding
          ) {
            binding.pid = pid;
            this.snapshotBareKidsSoon(sessionId);
          }
        });
      }
    }

    // A terminal we had bound but that the host no longer lists is gone (a
    // missed close event, or a full app restart that dropped the pty).
    for (const [sessionId, entry] of [...this.bound]) {
      if (!present.has(entry.terminal)) this.bound.delete(sessionId);
    }

    if (fresh.length > 0) {
      log(
        `terminals: re-associated ${fresh.length} terminal(s) via ` +
          `${ENV_NODE_ID}`,
      );
      soon(() => {
        for (const binding of fresh) this.emitBind(binding);
        this.syncActive();
      });
    } else {
      soon(() => this.syncActive());
    }
    return fresh.length;
  }

  /**
   * App-restart path. After a full restart the pty is relaunched, so
   * `processId` no longer matches anything we recorded — but claude IS the
   * terminal process, so a roster row's `pid` identifies its terminal exactly.
   * Binds any still-unbound terminal whose process id matches a roster entry.
   * Purely additive to `reassociate()`; call it after each roster tick until it
   * returns 0, or just on the first successful tick.
   */
  async reassociateFromRoster(
    entries: readonly RosterEntry[],
  ): Promise<number> {
    if (this.disposed) return 0;
    const terminals = this.allTerminals();
    if (!terminals) return 0;

    const byPid = new Map<number, string>();
    for (const entry of entries) {
      if (!isSessionId(entry.sessionId)) continue;
      if (this.bound.has(entry.sessionId)) continue;
      const pid = entry.pid;
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
        continue;
      }
      if (!byPid.has(pid)) byPid.set(pid, entry.sessionId);
    }
    if (byPid.size === 0) return 0;

    const fresh: TerminalBinding[] = [];
    for (const terminal of terminals) {
      if (this.disposed) break;
      if (this.findByTerminal(terminal)) continue;
      if (terminal.exitStatus !== undefined) continue; // already dead
      const pid = await this.pidOf(terminal);
      if (pid === undefined) continue;
      const sessionId = byPid.get(pid);
      if (!sessionId || this.bound.has(sessionId)) continue;
      const binding = this.bind(sessionId, terminal);
      binding.pid = pid;
      // Roster-pid adoptions are bare by construction (a wrapped terminal's
      // pid is the tmux client's and never matches the roster) — arm the
      // reap snapshot exactly as launch() does.
      this.snapshotBareKidsSoon(sessionId);
      fresh.push(binding);
    }

    if (fresh.length > 0) {
      log(`terminals: re-associated ${fresh.length} terminal(s) via roster pid`);
      for (const binding of fresh) this.emitBind(binding);
      this.syncActive();
    }
    return fresh.length;
  }

  /**
   * App-restart path for WRAPPED terminals. A revived terminal carries no env
   * stamp (a window reload keeps creationOptions; a full restart does not),
   * and `reassociateFromRoster` matches CLAUDE pids — which a wrapped
   * terminal's own pid (the tmux client's) never is. So a restart used to
   * leave every wrapped terminal a stranger: tab on screen, session live on
   * the roster, and a row click insisting it was "running outside this
   * editor". The tmux server knows exactly which session each client shows,
   * and the client pid IS `Terminal.processId` — so match through it and
   * bind under the id the session's name encodes (the launch-time id, the
   * same key an ordinary launch binds under). Purely additive, like
   * `reassociateFromRoster`; call it until it returns 0.
   */
  async reassociateFromTmux(): Promise<number> {
    if (this.disposed) return 0;
    const lookup = this.deps.tmuxClientSessions;
    if (typeof lookup !== 'function') return 0;
    const terminals = this.allTerminals();
    if (!terminals) return 0;
    const unbound = terminals.filter(
      (t) => !this.findByTerminal(t) && t.exitStatus === undefined,
    );
    if (unbound.length === 0) return 0;

    let clients: ReadonlyMap<number, string>;
    try {
      clients = await lookup();
    } catch (err) {
      logError('terminals.tmuxClientSessions', err);
      return 0;
    }
    if (clients.size === 0) return 0;

    const fresh: TerminalBinding[] = [];
    for (const terminal of unbound) {
      if (this.disposed) break;
      if (this.findByTerminal(terminal)) continue; // bound meanwhile
      const pid = await this.pidOf(terminal);
      if (pid === undefined) continue;
      const name = clients.get(pid);
      if (name === undefined) continue;
      const sessionId = sessionIdOfTmuxName(name);
      if (sessionId === undefined) continue;
      if (this.bound.has(sessionId) || this.claiming.has(sessionId)) continue;
      const binding = this.bind(sessionId, terminal);
      // creationOptions had nothing to derive from (that is why we are
      // here), so the name — and the pane-pid lookup it feeds — is set from
      // the client match instead.
      if (binding.tmuxName === undefined) {
        binding.tmuxName = name;
        this.resolveTmuxPidSoon(binding);
      }
      fresh.push(binding);
    }

    if (fresh.length > 0) {
      log(
        `terminals: re-associated ${fresh.length} terminal(s) via tmux clients`,
      );
      for (const binding of fresh) this.emitBind(binding);
      this.syncActive();
    }
    return fresh.length;
  }

  // ---------------------------------------------------------------- launch

  /**
   * Create a terminal whose process IS claude. Returns the binding, or null
   * when we could not launch (no binary, restricted workspace, host refusal) —
   * every failure path shows a message and logs; none throws.
   */
  async launch(opts: LaunchOptions): Promise<TerminalBinding | null> {
    if (this.disposed) return null;

    const sessionId = opts.sessionId;
    if (!isSessionId(sessionId)) {
      showError('Refusing to launch: the session id is not a valid uuid.');
      return null;
    }

    if (!isWorkspaceTrusted()) {
      showError(RESTRICTED_MESSAGE);
      return null;
    }

    // WHICH CLI. The one branch that makes a Codex account a place a session
    // can start: everything below this point is binary-agnostic, so the whole
    // difference between the two providers is this pair of lookups plus the
    // argv builder they select.
    const isCodex = opts.provider === 'codex';
    const binary = isCodex
      ? (this.deps.codexBinary?.() ?? null)
      : this.deps.claudeBinary();
    if (!binary) {
      showError(isCodex ? MISSING_CODEX_BINARY_MESSAGE : MISSING_BINARY_MESSAGE);
      return null;
    }

    const w = windowApi();
    if (typeof w.createTerminal !== 'function') {
      showError('This editor build does not expose the terminal API.');
      return null;
    }

    const name =
      typeof opts.title === 'string' && opts.title.trim().length > 0
        ? opts.title
        : defaultTerminalName(sessionId, opts.provider);

    const pref = this.locationPref();

    // The workspace restore path knows which editor group a session tab
    // lived in. A TerminalEditorLocationOptions only makes sense for editor
    // tabs; the panel preference keeps winning.
    const location: vscode.TerminalOptions['location'] =
      typeof opts.viewColumn === 'number' &&
      Number.isInteger(opts.viewColumn) &&
      opts.viewColumn > 0 &&
      pref !== 'panel'
        ? ({
            viewColumn: opts.viewColumn,
            preserveFocus: true,
          } as unknown as vscode.TerminalOptions['location'])
        : (locationValueOf(pref) as vscode.TerminalOptions['location']);

    // The chosen account's environment, cleaned once and used by BOTH tiers
    // below. `{}` — the default account, and every launch made before accounts
    // existed — must behave exactly as passing no environment at all did.
    const profileEnv = launchEnv(opts.env);

    // DETACH TIER: wrap the launch in the private tmux server when the wiring
    // says so. The terminal process becomes the tmux client; claude runs in
    // the server, and disposing the terminal detaches instead of killing.
    // `-A` makes the same argv attach-or-create, so the workspace restore
    // path passes the name recorded at park time (opts.tmuxName) and reuses
    // this launch verb unchanged to RE-ATTACH a still-running session.
    const tmux = this.tmuxSpawnOf();
    let shellPath = binary;
    let shellArgs = isCodex ? buildCodexArgs(opts) : buildShellArgs(opts);
    let tmuxName: string | undefined;
    if (tmux) {
      const recordedName =
        typeof opts.tmuxName === 'string' && opts.tmuxName !== ''
          ? opts.tmuxName
          : undefined;
      tmuxName = recordedName ?? tmuxSessionName(sessionId);
      // EXIT-TO-SHELL, the launch side. `new-session -A` attaches when the
      // name exists, which is the entire mechanism behind restoring a parked
      // session — and exactly wrong when what exists is a wrap the user
      // `/exit`ed out of, whose pane now holds a shell. Attaching there would
      // show them that shell and never run the argv, so Flock would report a
      // resumed conversation over a bash prompt. Ending the stale wrap first
      // turns the `-A` back into a create.
      //
      // Only for a DERIVED name: a name that arrived in `opts` came from the
      // park record and means "re-attach to this", and the restore path has
      // its own liveness answer. Nothing is killed unless the probe says
      // `exited`, so a running conversation is never touched.
      if (recordedName === undefined) await this.clearExitedWrap(tmuxName);
      shellArgs = buildTmuxArgs({
        name: tmuxName,
        ...(tmux.confPath !== undefined ? { confPath: tmux.confPath } : {}),
        ...(typeof opts.cwd === 'string' && opts.cwd !== ''
          ? { cwd: opts.cwd }
          : {}),
        // The hook re-key stamp must reach the CLAUDE process's environment,
        // and the server keeps the FIRST client's env for every later
        // session — `-e` (session environment) is what makes each wrap carry
        // its own id. The terminal's env stamp below still exists, but it
        // only reaches the tmux client. The account environment rides the same
        // flags, for exactly the same reason, and is written FIRST so the stamp
        // always wins a collision.
        env: { ...profileEnv, [ENV_NODE_ID]: sessionId },
        command: [binary, ...shellArgs],
      });
      shellPath = tmux.binary;
    }

    let terminal: vscode.Terminal;
    this.claiming.add(sessionId);
    try {
      terminal = w.createTerminal({
        name,
        shellPath,
        shellArgs,
        cwd: opts.cwd,
        // The stamp that survives a window reload inside creationOptions, and
        // the account environment beside it. Both are reconstructed for a
        // revived terminal, so a reloaded window's re-launch (if any) lands on
        // the same account.
        env: { ...profileEnv, [ENV_NODE_ID]: sessionId },
        // NEVER strictEnv — claude needs the inherited environment.
        location,
        // A project chat sits among session tabs and must read as a different
        // KIND of thing at a glance, hence its own icon and colour.
        iconPath: new vscode.ThemeIcon(
          opts.chat ? 'comment-discussion' : opts.parentId ? 'git-branch' : 'terminal',
        ),
        color: opts.chat
          ? new vscode.ThemeColor('terminal.ansiMagenta')
          : opts.parentId
            ? new vscode.ThemeColor('terminal.ansiCyan')
            : undefined,
      });
    } catch (err) {
      // Restricted Mode refuses the pty outright; so can a bad cwd.
      this.claiming.delete(sessionId);
      logError('terminals.launch', err);
      showError(
        `Could not start ${isCodex ? 'Codex' : 'Claude'}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }

    if (this.bound.has(sessionId)) {
      log(
        `terminals: replacing an existing binding for ${shortId(sessionId)}`,
      );
    }

    const binding = this.bind(sessionId, terminal, name);
    // Authoritative here; bind()'s creationOptions derivation is for revived
    // terminals, whose launch-time knowledge is gone. On a host that hands
    // back a terminal with empty creationOptions the derivation found
    // nothing, so the pane-pid lookup is kicked here instead.
    if (tmuxName !== undefined && binding.tmuxName === undefined) {
      binding.tmuxName = tmuxName;
      this.resolveTmuxPidSoon(binding);
    }
    this.claiming.delete(sessionId);
    this.safeShow(terminal, opts.preserveFocus === true);
    this.emitBind(binding);

    // Await the pid BEFORE the newWindow move. `createTerminal` is a one-way
    // notification: the instance, its editor input and its tab do not exist
    // until the main thread has resolved the profile and opened the editor,
    // and `executeCommand` is not sequenced behind any of that. Firing
    // moveEditorToNewWindow in the same tick therefore moves whatever editor
    // was active BEFORE our tab existed — it rips out an unrelated file, or
    // no-ops when the group was empty, and neither throws. A resolved
    // processId is proof the instance is up; the wait is bounded (see pidOf),
    // so a pty that never launches costs a skipped move, not a hang.
    const pid = await this.pidOf(terminal);
    // The terminal may already have died while we awaited the pid. For a
    // WRAPPED launch the resolved pid is the tmux client's and is never
    // written to the binding — bind() already kicked off the pane-pid lookup
    // that owns `binding.pid` there, and the client pid would poison the
    // pid-keyed re-key detection it exists to feed.
    const stillOurs = this.bound.get(sessionId)?.binding === binding;
    if (pid !== undefined && stillOurs && tmuxName === undefined) {
      binding.pid = pid;
      // A bare root's descendants can only be reaped from a list walked while
      // they were still its descendants — start the snapshot the moment the
      // root is known (the sweep tick keeps it fresh from here).
      this.snapshotBareKidsSoon(sessionId);
    }

    if (pref === 'newWindow' && stillOurs) await this.moveToNewWindow(terminal);

    return binding;
  }

  // ------------------------------------------------------------- accessors

  isBoundHere(sessionId: string): boolean {
    return this.bound.has(sessionId);
  }

  boundSessionIds(): string[] {
    return [...this.bound.keys()];
  }

  /** Snapshot of every binding held by THIS window. */
  bindings(): TerminalBinding[] {
    return [...this.bound.values()].map((e) => ({ ...e.binding }));
  }

  /** The binding for one session, or undefined when it is not bound here. */
  binding(sessionId: string): TerminalBinding | undefined {
    const entry = this.bound.get(sessionId);
    return entry ? { ...entry.binding } : undefined;
  }

  /** Session id of the workbench's active terminal, when we own it. */
  activeSessionId(): string | null {
    const active = windowApi().activeTerminal;
    if (!active) return null;
    return this.findByTerminal(active)?.binding.sessionId ?? null;
  }

  /** Detach tier: the tmux session backing a bound terminal, or undefined for
   *  a bare launch (or nothing bound here). What workspace parking consults to
   *  decide detach vs kill. */
  tmuxNameOf(sessionId: string): string | undefined {
    return this.bound.get(sessionId)?.binding.tmuxName;
  }

  // ---------------------------------------------------------------- verbs

  /** Reveal and focus the bound terminal. False when nothing is bound here. */
  focus(sessionId: string): boolean {
    const entry = this.bound.get(sessionId);
    if (!entry) return false;
    this.safeShow(entry.terminal, false);
    return true;
  }

  /**
   * Terminal names are readonly, so renaming goes: `show(true)` (makes it the
   * active instance while preserving focus) → the hidden `renameWithArg`
   * command. The previously active terminal is restored afterwards so a
   * background rename does not steal the terminal panel. False on any throw.
   */
  async rename(sessionId: string, name: string): Promise<boolean> {
    const entry = this.bound.get(sessionId);
    if (!entry) return false;
    const trimmed = name.trim();
    if (trimmed.length === 0) return false;

    const previous = windowApi().activeTerminal;
    const ok = await this.runOnTerminal(entry, RENAME_COMMAND, {
      name: trimmed,
    });
    if (!ok) return false;

    entry.binding.terminalName = trimmed;
    if (previous && previous !== entry.terminal) {
      this.safeShow(previous, true);
    }
    return true;
  }

  /** Move the bound terminal from the panel into an editor group. Same
   *  active-instance-addressed workbench command as moveToTerminalPanel (it
   *  resolves against the active PANEL instance), same cure: reveal, confirm,
   *  then move — or a loop restoring several sessions strands some in the
   *  panel.
   *
   *  Note for callers: `moveToEditor` is declared with
   *  `runAfter: i => i.at(-1)?.focus()`, so the terminal it moves takes the
   *  keyboard on arrival. Anything that restores several sessions must
   *  therefore make its focus decision LAST — see WorkspaceManager.doSwitch. */
  async moveToEditor(sessionId: string): Promise<boolean> {
    const entry = this.bound.get(sessionId);
    if (!entry) return false;
    return this.runOnFocusedTerminal(entry, MOVE_TO_EDITOR_COMMAND);
  }

  /**
   * Move the bound terminal from the editor area into the terminal panel.
   *
   * Unlike every other terminal command this one is ACTIVE-INSTANCE-addressed:
   * the workbench resolves it against the active terminal EDITOR. Revealing
   * one does set the active instance — `$show` calls setActiveInstance before
   * and independently of the focus argument — but the reveal and the command
   * are separate fire-and-forget messages to the renderer, so the command can
   * still arrive while the workbench considers the PREVIOUS terminal active.
   * Stowing several terminals in a loop therefore kept re-targeting whichever
   * tab happened to be active: moving one twice and leaving the rest in place.
   * The cure was never focus, it was CONFIRMATION — this verb reveals the
   * terminal, waits until the extension host can see it became the active one,
   * and only then runs the move. A terminal that never becomes active fails
   * the verb rather than moving somebody else's tab.
   */
  async moveToTerminalPanel(sessionId: string): Promise<boolean> {
    const entry = this.bound.get(sessionId);
    if (!entry) return false;
    return this.runOnFocusedTerminal(entry, MOVE_TO_PANEL_COMMAND);
  }

  /** The one sanctioned sendText use is the wrap verb. Never for launching. */
  sendText(sessionId: string, text: string): boolean {
    const entry = this.bound.get(sessionId);
    if (!entry) return false;
    try {
      entry.terminal.sendText(text, true);
      return true;
    } catch (err) {
      logError('terminals.sendText', err);
      return false;
    }
  }

  /**
   * The claude process in a bound terminal re-keyed itself: the roster
   * now reports the SAME pid under a NEW session id (a `/fork` that switched
   * the terminal over, a plain resume that re-minted, `/clear`). Move the
   * binding so every verb keeps finding the terminal under the id the tree
   * now shows. The terminal object, its tab and its pty are untouched.
   */
  rebind(oldSessionId: string, newSessionId: string): boolean {
    if (this.disposed) return false;
    if (!isSessionId(newSessionId) || oldSessionId === newSessionId) {
      return false;
    }
    const entry = this.bound.get(oldSessionId);
    if (!entry) return false;
    if (this.bound.has(newSessionId)) return false; // never clobber a binding
    this.bound.delete(oldSessionId);
    entry.binding.sessionId = newSessionId;
    entry.binding.nodeId = newSessionId;
    this.bound.set(newSessionId, entry);
    log(
      `terminals: re-bound ${shortId(oldSessionId)} -> ` +
        `${shortId(newSessionId)} (same terminal)`,
    );
    this.emitBind(entry.binding);
    return true;
  }

  /**
   * Dispose the bound terminal; the close handler unbinds and emits exit.
   *
   * `opts.killTmux` is the CLOSE-vs-PARK intent for wrapped sessions: a
   * dispose only detaches those (the claude process keeps running), so a
   * caller that means "end this session" — the close verb — must say so and
   * the tmux session is killed too. Workspace parking never passes it; that
   * dispose IS the detach.
   *
   * For a BARE terminal (no wrap) the dispose IS the kill — of the pane root
   * only. Its MCP children re-parent to PID 1 the instant the root dies, so
   * the dispose is deferred behind a descendant walk (one `ps`, tens of
   * milliseconds) and the whole tree is reaped after — the same walk-first /
   * verify / escalate ladder every tmux kill runs, because a bare close that
   * skips it is exactly how the 32 GB of orphaned `uv` wrappers accumulated.
   * `true` therefore means "the close is UNDERWAY" on this tier; the unbind
   * still arrives through the ordinary close event when the dispose lands.
   */
  closeTerminal(
    sessionId: string,
    opts?: { killTmux?: boolean },
  ): boolean {
    const entry = this.bound.get(sessionId);
    if (!entry) return false;
    const tmuxName = entry.binding.tmuxName;
    const barePid = tmuxName === undefined ? entry.binding.pid : undefined;
    if (barePid !== undefined) {
      // WALK BEFORE KILL (see src/procs.ts's header): fire-and-forget, but
      // the dispose inside waits for the walk — a dead root's children can
      // never be found again.
      void this.disposeBareTree(entry, barePid);
    } else {
      try {
        entry.terminal.dispose();
      } catch (err) {
        logError('terminals.closeTerminal', err);
        return false;
      }
      if (opts?.killTmux === true && tmuxName !== undefined) {
        this.killTmuxSoon(tmuxName, entry.binding.sessionId);
      }
    }
    if (!this.closeWatched) {
      // No onDidCloseTerminal in this host: unbind ourselves so state does not
      // keep claiming the session is hosted here.
      this.bound.delete(sessionId);
      this.exitEmitter.fire({
        sessionId,
        code: undefined,
        reason: 'other',
        ...(tmuxName !== undefined ? { tmuxName } : {}),
      });
      this.syncActive();
    }
    return true;
  }

  // ---------------------------------------------------------------- events

  onDidBind(cb: (b: TerminalBinding) => void): DisposableLike {
    return this.bindEmitter.event(cb);
  }

  onDidExit(
    cb: (
      sessionId: string,
      code: number | undefined,
      reason: 'shutdown' | 'user' | 'other',
      /** The wrap that backed the terminal, when there was one — see
       *  ExitEvent.tmuxName for why it travels on the event. */
      tmuxName?: string,
    ) => void,
  ): DisposableLike {
    return this.exitEmitter.event((e) =>
      cb(e.sessionId, e.code, e.reason, e.tmuxName),
    );
  }

  onDidChangeActive(cb: (sessionId: string | null) => void): DisposableLike {
    return this.activeEmitter.event(cb);
  }

  // --------------------------------------------------------------- teardown

  /** Drops subscriptions and bindings. Terminals are deliberately NOT disposed:
   *  the sessions must survive a window reload so `reassociate()` can find
   *  them again. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const sub of this.subs) {
      try {
        sub.dispose();
      } catch (err) {
        logError('terminals.dispose', err);
      }
    }
    this.subs.length = 0;
    this.bound.clear();
    this.claiming.clear();
    this.bindEmitter.dispose();
    this.exitEmitter.dispose();
    this.activeEmitter.dispose();
  }

  // --------------------------------------------------------------- internals

  private track(sub: DisposableLike | undefined): void {
    if (sub) this.subs.push(sub);
  }

  /** Config-driven, re-read per launch so a settings change needs no reload.
   *  A dep that is absent or throws means the default: an editor tab. */
  private locationPref(): TerminalLocationPref {
    try {
      return this.deps.terminalLocation?.() ?? 'editor';
    } catch (err) {
      logError('terminals.terminalLocation', err);
      return 'editor';
    }
  }

  /** Fire-and-forget kill of a wrapped session — the close verb's second
   *  half. Absent dep = logged, so a session left running invisibly is at
   *  least never silent. */
  private killTmuxSoon(name: string, sessionId: string): void {
    const kill = this.deps.tmuxKillSession;
    if (typeof kill !== 'function') {
      log(
        `terminals: no tmuxKillSession dep — ${shortId(sessionId)} may keep ` +
          `running detached as ${name}`,
      );
      return;
    }
    void Promise.resolve(kill(name)).then(
      (ok) => {
        log(
          `terminals: ${ok ? 'killed' : 'could not kill'} tmux session ` +
            `${name} (close of ${shortId(sessionId)})`,
        );
      },
      (err: unknown) => {
        logError('terminals.tmuxKillSession', err);
      },
    );
  }

  // ------------------------------------------------------ bare-tree reaping
  //
  // The tmux tier funnels every kill through killTmuxSessionTree; this is the
  // BARE tier's equivalent. A bare terminal's pty root IS the claude process
  // (shellPath), and disposing it orphans the ~8 MCP children to PID 1 — the
  // incident this branch exists to fix, just without the tmux server in the
  // middle. Three pieces: a walk (injectable, defaults to procs.ts), a reap
  // (same), and a per-binding descendant SNAPSHOT for the one path where a
  // pre-kill walk is impossible — the user's own tab X, which reaches us only
  // after the root is dead.

  private walkDescendantsOf(rootPid: number): Promise<number[]> {
    const walk = this.deps.listDescendants ?? listDescendants;
    return Promise.resolve(walk(rootPid)).catch((err: unknown) => {
      logError('terminals.listDescendants', err);
      return [];
    });
  }

  /** Fire-and-forget escalation over explicitly-walked pids. Quiet when
   *  everything exited on its own — the log earns a line only when a signal
   *  was actually needed, mirroring killTmuxSessionTree's report. */
  private reapBareSoon(pids: readonly number[], sessionId: string): void {
    if (pids.length === 0) return;
    const reap = this.deps.reapSurvivors ?? reapSurvivors;
    void Promise.resolve(reap(pids)).then(
      (r) => {
        if (r.termed > 0 || r.killed > 0) {
          log(
            `terminals: reaped bare tree of ${shortId(sessionId)} — ` +
              `${String(r.exited)} exited on their own, ` +
              `${String(r.termed)} SIGTERMed, ${String(r.killed)} SIGKILLed`,
          );
        }
      },
      (err: unknown) => logError('terminals.reapBare', err),
    );
  }

  /** The extension-initiated bare close: walk FIRST (a dead root's children
   *  have already re-parented and can never be found again), THEN dispose,
   *  then verify/escalate on root + walked descendants. The dispose waits on
   *  one `ps` — tens of milliseconds against a tab close, and the difference
   *  between ending a session and orphaning its MCP servers. */
  private async disposeBareTree(entry: BoundEntry, rootPid: number): Promise<void> {
    const kids = await this.walkDescendantsOf(rootPid);
    try {
      entry.terminal.dispose();
    } catch (err) {
      // The dispose failed, so nothing died: reaping now would kill the tree
      // out from under a tab that is still on screen.
      logError('terminals.closeTerminal', err);
      return;
    }
    // The root rides along, exactly as in killTmuxSessionTree: a claude that
    // ignores its pty's death would otherwise survive as the biggest orphan.
    this.reapBareSoon([rootPid, ...kids], entry.binding.sessionId);
  }

  /** Take (or retake) the descendant snapshot for one bare binding — the
   *  post-mortem target list for a user tab X (see BoundEntry.bareKids). */
  private snapshotBareKidsSoon(sessionId: string): void {
    const entry = this.bound.get(sessionId);
    if (!entry || entry.binding.tmuxName !== undefined) return;
    const pid = entry.binding.pid;
    if (pid === undefined) return;
    void this.walkDescendantsOf(pid).then((kids) => {
      // Still the same entry? A rebind moves the entry object under a new
      // key; the object identity is what says the snapshot still applies.
      const current = [...this.bound.values()].find((e) => e === entry);
      if (current) current.bareKids = kids;
    });
  }

  /** Refresh every bare binding's descendant snapshot. Called by the
   *  extension's 60 s lifecycle sweep, so a tab-X reap never acts on targets
   *  more than a minute old. A handful of `ps` calls a minute, machine-wide. */
  refreshBareDescendants(): void {
    if (this.disposed) return;
    for (const sessionId of this.bound.keys()) {
      this.snapshotBareKidsSoon(sessionId);
    }
  }

  /** Every pid the persisted window-close rescue should remember: each bare
   *  binding's root plus its last descendant snapshot, deduped. The wiring
   *  writes these (with their ps start times) to globalStorage on the same
   *  sweep tick that refreshes the snapshots, so what survives a crash or a
   *  window close is at most a minute stale — and the NEXT activation's
   *  rescue (procs.orphanRescueDecision) verifies identity per pid before it
   *  signals anything, which is what makes acting on a persisted list honest.
   *  Roots ride along deliberately: a claude that ignores its pty's death
   *  orphans to PID 1 like any child and passes the same verification. */
  bareSnapshotPids(): number[] {
    const out = new Set<number>();
    for (const entry of this.bound.values()) {
      if (entry.binding.tmuxName !== undefined) continue;
      const pid = entry.binding.pid;
      if (pid !== undefined) out.add(pid);
      for (const kid of entry.bareKids ?? []) out.add(kid);
    }
    return [...out];
  }

  /**
   * The window-close half of the bare tier (reason 'shutdown', see
   * handleClose). Post-mortem like the tab X — VS Code's pty teardown killed
   * the root, so the snapshot is the target list — but with one decision the
   * tab X never faces: reason 'shutdown' is ALSO what a window RELOAD
   * reports, and a reload keeps the pty (and the whole claude tree) alive for
   * revival. The root's own liveness is what separates the two — probe it
   * now, and if it still breathes give VS Code's kill one short beat to land
   * and probe once more; a root alive after that is a revival in progress and
   * its tree must not be touched. Only the KIDS are signalled (the root's
   * death is the premise that authorizes the reap), on the short ladder —
   * the host is dying, so whatever this best effort misses is the persisted
   * rescue's job at next activation.
   */
  private reapBareOnShutdown(entry: BoundEntry): void {
    const rootPid = entry.binding.pid;
    const kids = entry.bareKids ?? [];
    // No root pid = no way to tell close from reload: do nothing here and
    // leave the whole question to the verified rescue. No kids = nothing the
    // root's death could have orphaned.
    if (rootPid === undefined || kids.length === 0) return;
    const alive = this.deps.isPidAlive ?? isPidAlive;
    const reapKids = (): void => {
      const reap =
        this.deps.reapSurvivors ??
        ((pids: readonly number[]) =>
          reapSurvivors(pids, { waitMs: SHUTDOWN_REAP_WAIT_MS }));
      void Promise.resolve(reap(kids)).then(
        (r) => {
          if (r.termed > 0 || r.killed > 0) {
            log(
              `terminals: shutdown-reaped bare tree of ` +
                `${shortId(entry.binding.sessionId)} — ${String(r.exited)} ` +
                `exited, ${String(r.termed)} SIGTERMed, ${String(r.killed)} ` +
                `SIGKILLed`,
            );
          }
        },
        (err: unknown) => logError('terminals.reapBareShutdown', err),
      );
    };
    try {
      if (!alive(rootPid)) {
        reapKids();
        return;
      }
    } catch (err) {
      logError('terminals.reapBareShutdown.probe', err);
      return;
    }
    void delay(SHUTDOWN_REAP_PROBE_MS).then(() => {
      try {
        if (!alive(rootPid)) reapKids();
        // Still alive: a reload's revival. The binding is gone but the
        // process is not orphaned — handleOpen will re-bind it in the next
        // incarnation of this very extension host.
      } catch (err) {
        logError('terminals.reapBareShutdown.reprobe', err);
      }
    });
  }

  /**
   * AWAITED, unlike `killTmuxSoon`: the `new-session` that follows would
   * otherwise race the kill and could still find the session there to attach
   * to. Both probe and kill are best-effort — no dep, a throw, or a kill that
   * fails all fall through to the launch, which is the pre-fix behaviour and
   * no worse than not having looked.
   */
  private async clearExitedWrap(name: string): Promise<void> {
    const probe = this.deps.tmuxWrapState;
    const kill = this.deps.tmuxKillSession;
    if (typeof probe !== 'function' || typeof kill !== 'function') return;
    try {
      if ((await probe(name)) !== 'exited') return;
      const ok = await kill(name);
      log(
        `terminals: ${ok ? 'ended' : 'could not end'} the exited wrap ${name} ` +
          'before relaunching into its name',
      );
    } catch (err) {
      logError('terminals.clearExitedWrap', err);
    }
  }

  /** Detach tier, re-resolved per launch (installing tmux or flipping
   *  `lineage.tmux` needs no reload). Absent or throwing means bare claude —
   *  the always-available tier. */
  private tmuxSpawnOf(): TmuxSpawn | null {
    try {
      return this.deps.tmux?.() ?? null;
    } catch (err) {
      logError('terminals.tmux', err);
      return null;
    }
  }

  /** Pop the editor terminal out into its own OS window. Only ever called once
   *  the instance demonstrably exists (launch() awaits its pid first), because
   *  the command acts on whatever editor is active and cannot report that it
   *  moved the wrong one. Lost harmlessly on hosts without the command. */
  private async moveToNewWindow(terminal: vscode.Terminal): Promise<void> {
    const cmds = commandsApi();
    if (typeof cmds.executeCommand !== 'function') return;
    try {
      terminal.show(false);
      await cmds.executeCommand(MOVE_EDITOR_TO_NEW_WINDOW_COMMAND);
    } catch (err) {
      logError('terminals.moveEditorToNewWindow', err);
    }
  }

  private allTerminals(): readonly vscode.Terminal[] | null {
    const list: readonly vscode.Terminal[] | undefined = windowApi().terminals;
    if (!list || typeof list.length !== 'number') return null;
    return list;
  }

  private findByTerminal(terminal: vscode.Terminal): BoundEntry | undefined {
    for (const entry of this.bound.values()) {
      if (entry.terminal === terminal) return entry;
    }
    return undefined;
  }

  private bind(
    sessionId: string,
    terminal: vscode.Terminal,
    name?: string,
  ): TerminalBinding {
    const terminalName =
      name ??
      (typeof terminal.name === 'string' && terminal.name.length > 0
        ? terminal.name
        : defaultTerminalName(sessionId));
    const binding: TerminalBinding = {
      nodeId: sessionId, // node id == session id in this design
      sessionId,
      terminalName,
      createdAt: Date.now(),
    };
    // Detach tier: recover the tmux session name from creationOptions, which
    // is how a REVIVED terminal (window reload) keeps it. Losing it would
    // downgrade the session's next park from detach to kill — the dispose
    // would only detach, but the record would say the conversation died, and
    // the switch-back would `--resume` a second claude beside the running one.
    const tmuxName = tmuxNameOfTerminal(terminal);
    if (tmuxName !== undefined) binding.tmuxName = tmuxName;
    this.bound.set(sessionId, { terminal, binding });
    // Wrapped: the pid that matters is CLAUDE's, and only tmux knows it.
    if (tmuxName !== undefined) this.resolveTmuxPidSoon(binding);
    return binding;
  }

  /**
   * Detach tier. A wrapped terminal's own process is the tmux CLIENT, whose
   * pid matches nothing on the roster — so a wrapped binding must carry the
   * PANE's root pid (claude itself; the wrap execs it directly) or the two
   * pid-keyed mechanisms go blind: the re-key detector never notices the
   * fresh generation id a wrapped `--resume` mints (leaving the session's own
   * tab on screen while its row claims "running outside this editor"), and
   * app-restart re-association never matches. Background with retries: the
   * session is created by the command line the terminal is still starting.
   * The dep is optional — absent (unit doubles, tmux flipped off) the binding
   * simply keeps no pid, degrading exactly those two mechanisms.
   */
  private resolveTmuxPidSoon(binding: TerminalBinding): void {
    const name = binding.tmuxName;
    const lookup = this.deps.tmuxPanePid;
    if (name === undefined || typeof lookup !== 'function') return;
    void (async () => {
      for (let attempt = 0; attempt < TMUX_PID_ATTEMPTS; attempt++) {
        if (this.disposed) return;
        // Still current? rebind() moves the same binding object under a new
        // key, so identity — not the session-id key — is the check.
        if (![...this.bound.values()].some((e) => e.binding === binding)) {
          return;
        }
        let pid: number | undefined;
        try {
          pid = await lookup(name);
        } catch (err) {
          logError('terminals.tmuxPanePid', err);
          return;
        }
        if (pid !== undefined) {
          binding.pid = pid;
          return;
        }
        await delay(TMUX_PID_RETRY_MS);
      }
      log(
        `terminals: no pane pid for ${name} — re-key detection degraded for ` +
          shortId(binding.sessionId),
      );
    })();
  }

  private emitBind(binding: TerminalBinding): void {
    if (this.disposed) return;
    try {
      this.bindEmitter.fire({ ...binding });
    } catch (err) {
      logError('terminals.onDidBind', err);
    }
  }

  /**
   * `Terminal.processId` NEVER settles when the pty fails to launch: the ext
   * host resolves it only from `$acceptTerminalProcessId`, which the main
   * thread sends only once a process id exists, and neither close nor dispose
   * settles it. It cannot reject either, so a try/catch is no protection. A
   * bare await therefore wedges `launch()` forever on a typo'd
   * `lineage.claudeBinary` — no failure log, no toast, and the caller never
   * reaches its `if (!binding)` branch. Every wait here is bounded; a missing
   * pid degrades to `undefined`, which both callers already handle.
   */
  private async pidOf(terminal: vscode.Terminal): Promise<number | undefined> {
    try {
      const pid = await withTimeout(terminal.processId, PID_TIMEOUT_MS);
      return typeof pid === 'number' && pid > 0 ? pid : undefined;
    } catch (err) {
      logError('terminals.processId', err);
      return undefined;
    }
  }

  private safeShow(terminal: vscode.Terminal, preserveFocus: boolean): void {
    try {
      terminal.show(preserveFocus);
    } catch (err) {
      logError('terminals.show', err);
    }
  }

  private async runOnTerminal(
    entry: BoundEntry,
    command: string,
    arg?: unknown,
  ): Promise<boolean> {
    const cmds = commandsApi();
    if (typeof cmds.executeCommand !== 'function') return false;
    try {
      // show(true) makes it the ACTIVE terminal instance without stealing
      // focus — these commands are active-terminal-only.
      entry.terminal.show(true);
      if (arg === undefined) {
        await cmds.executeCommand(command);
      } else {
        await cmds.executeCommand(command, arg);
      }
      return true;
    } catch (err) {
      logError(`terminals.${command}`, err);
      return false;
    }
  }

  /**
   * Reveal the terminal, CONFIRM the workbench agrees it is the active one
   * (`window.activeTerminal`), then run an active-instance-addressed command.
   * Both the reveal and the command are fire-and-forget IPC to the renderer,
   * so without the confirmation the command can execute while the workbench
   * still considers the PREVIOUS terminal active — see moveToTerminalPanel.
   * Never runs the command unconfirmed: on a terminal the workbench refuses to
   * activate, a skipped move is recoverable; a move applied to the wrong tab is
   * not.
   *
   * Three attempts, cheapest first. The first reveals WITHOUT taking focus:
   * the workbench sets the active instance on any reveal, independently of the
   * focus argument, so a preserveFocus reveal is usually enough to make this
   * the instance the command resolves against — and a switch that stows a
   * dozen sessions must not throw the keyboard around the window a dozen
   * times. The two fallbacks take focus and wait longer, which is what makes
   * the polite first attempt safe to try at all.
   */
  private async runOnFocusedTerminal(
    entry: BoundEntry,
    command: string,
  ): Promise<boolean> {
    const cmds = commandsApi();
    if (typeof cmds.executeCommand !== 'function') return false;
    const waits = [ACTIVE_SOFT_WAIT_MS, ACTIVE_WAIT_MS, ACTIVE_LAST_WAIT_MS];
    for (let attempt = 0; attempt < waits.length; attempt++) {
      this.safeShow(entry.terminal, attempt === 0);
      if (await this.becameActive(entry.terminal, waits[attempt] ?? ACTIVE_WAIT_MS)) {
        try {
          await cmds.executeCommand(command);
          return true;
        } catch (err) {
          logError(`terminals.${command}`, err);
          return false;
        }
      }
      // Let the workbench settle before the last, longest attempt — the usual
      // reason the second one failed is that it is still busy reflowing.
      if (attempt === 1) await delay(ACTIVE_POLL_MS);
    }
    log(
      `terminals: ${command} skipped for ` +
        `${shortId(entry.binding.sessionId)} — never became the active ` +
        `terminal after ${waits.length} attempts`,
    );
    return false;
  }

  /** Bounded wait for the workbench to report this terminal as active. On a
   *  host that does not track an active terminal at all, proceed on faith —
   *  an unverifiable verb still beats an impossible one.
   *
   *  Event-driven where the host offers the event, so a confirmation costs a
   *  round-trip rather than a poll interval; the interval stays as a backstop
   *  for a host that changes the active terminal without announcing it. */
  private async becameActive(
    terminal: vscode.Terminal,
    waitMs: number,
  ): Promise<boolean> {
    const w = windowApi();
    // MUST stay first: a host with no notion of an active terminal cannot
    // confirm anything, and this is also the unit-test mock's escape hatch.
    if (!('activeTerminal' in w)) return true;
    if (w.activeTerminal === terminal) return true;

    const onChange = w.onDidChangeActiveTerminal;
    if (typeof onChange !== 'function') {
      const deadline = Date.now() + waitMs;
      for (;;) {
        if (windowApi().activeTerminal === terminal) return true;
        if (Date.now() >= deadline) return false;
        await delay(ACTIVE_POLL_MS);
      }
    }

    return new Promise<boolean>((resolve) => {
      let done = false;
      let sub: vscode.Disposable | undefined;
      let poll: ReturnType<typeof setInterval> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      // One idempotent exit that always clears both timers and the
      // subscription — mirrors withTimeout above, for the same reason: a race
      // left holding a timer keeps the host process alive.
      const finish = (ok: boolean): void => {
        if (done) return;
        done = true;
        if (poll !== undefined) clearInterval(poll);
        if (timer !== undefined) clearTimeout(timer);
        try {
          sub?.dispose();
        } catch (err) {
          logError('terminals.becameActive.dispose', err);
        }
        resolve(ok);
      };
      try {
        sub = onChange((active) => {
          if (active === terminal) finish(true);
        });
      } catch (err) {
        logError('terminals.onDidChangeActiveTerminal', err);
      }
      poll = setInterval(() => {
        if (windowApi().activeTerminal === terminal) finish(true);
      }, ACTIVE_POLL_MS);
      (poll as unknown as { unref?: () => void }).unref?.();
      timer = setTimeout(() => finish(false), waitMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      // The reveal may already have landed in the gap between the check above
      // and the subscription.
      if (windowApi().activeTerminal === terminal) finish(true);
    });
  }

  private handleOpen(terminal: vscode.Terminal): void {
    if (this.disposed) return;
    if (this.findByTerminal(terminal)) return; // ours already
    const sessionId = nodeIdOfTerminal(terminal);
    if (!sessionId) return;
    if (this.bound.has(sessionId) || this.claiming.has(sessionId)) return;
    const binding = this.bind(sessionId, terminal);
    log(`terminals: bound revived terminal for ${shortId(sessionId)}`);
    this.emitBind(binding);
    // Same wrap rule as launch(): a wrapped terminal's own pid is the tmux
    // client's — bind() owns the pane-pid lookup for those.
    if (binding.tmuxName !== undefined) return;
    void this.pidOf(terminal).then((pid) => {
      if (pid !== undefined && this.bound.get(sessionId)?.binding === binding) {
        binding.pid = pid;
        this.snapshotBareKidsSoon(sessionId);
      }
    });
  }

  private handleClose(terminal: vscode.Terminal): void {
    if (this.disposed) return;
    const entry = this.findByTerminal(terminal);
    if (!entry) return;
    const sessionId = entry.binding.sessionId;
    this.bound.delete(sessionId);

    let status: vscode.TerminalExitStatus | undefined;
    try {
      status = terminal.exitStatus;
    } catch (err) {
      logError('terminals.exitStatus', err);
    }
    const reason = exitReasonOf(status);
    // The sidebar contract: closing a tab closes the SESSION. For a wrapped
    // terminal the dispose the user just caused killed only the tmux client,
    // so the session must be ended explicitly — reason 'user' is exactly the
    // tab X / kill action (an extension dispose reports Extension: that is
    // parking, which detaches on purpose, and a window reload/close reports
    // Shutdown, which must keep the session for revival).
    if (reason === 'user' && entry.binding.tmuxName !== undefined) {
      this.killTmuxSoon(entry.binding.tmuxName, sessionId);
    }
    // The same tab X on a BARE terminal already killed the pane root — the
    // pty died before this event fired, so a fresh walk would find nothing
    // (the children re-parented the instant claude died). The SNAPSHOT is the
    // honest target list here: pids that were provably this root's
    // descendants within the last sweep tick. Extension-initiated disposes
    // (reason Extension → 'other') never take this branch — closeTerminal
    // already walked and reaped, and a second ladder would be noise.
    if (reason === 'user' && entry.binding.tmuxName === undefined) {
      const pid = entry.binding.pid;
      this.reapBareSoon(
        [...(pid !== undefined ? [pid] : []), ...(entry.bareKids ?? [])],
        sessionId,
      );
    }
    // WINDOW CLOSE (reason 'shutdown') on a BARE terminal: a wrapped session
    // survives its window on purpose (revival) — a bare one CANNOT, because
    // VS Code kills its pty root, and that kill is ours to clean up after:
    // the ~8 MCP children re-parent to PID 1 and the tmux-only activation
    // reconcile will never hunt them. Best-effort, from the same snapshot the
    // tab-X reap uses; the persisted-snapshot rescue at next activation is
    // the reliable backstop for a host that dies before this finishes.
    if (reason === 'shutdown' && entry.binding.tmuxName === undefined) {
      this.reapBareOnShutdown(entry);
    }
    log(
      `terminals: ${shortId(sessionId)} closed (reason=${reason}, code=` +
        `${status?.code ?? 'n/a'})`,
    );
    try {
      this.exitEmitter.fire({
        sessionId,
        code: status?.code,
        reason,
        ...(entry.binding.tmuxName !== undefined
          ? { tmuxName: entry.binding.tmuxName }
          : {}),
      });
    } catch (err) {
      logError('terminals.onDidExit', err);
    }
    this.syncActive();
  }

  private handleActive(terminal: vscode.Terminal | undefined): void {
    if (this.disposed) return;
    const sessionId = terminal
      ? (this.findByTerminal(terminal)?.binding.sessionId ?? null)
      : null;
    this.announceActive(sessionId);
  }

  /** Recompute the active binding from the host and announce it if changed. */
  private syncActive(): void {
    if (this.disposed) return;
    this.announceActive(this.activeSessionId());
  }

  private announceActive(sessionId: string | null): void {
    if (sessionId === this.lastActive) return;
    this.lastActive = sessionId;
    try {
      this.activeEmitter.fire(sessionId);
    } catch (err) {
      logError('terminals.onDidChangeActive', err);
    }
  }
}
