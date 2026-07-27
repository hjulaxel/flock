// IMPLEMENTED BY: D (M2) — terminal launch, binding, re-association, rename.
// Contract: SPEC.md §4-D; plan of record §4 ("Terminals and session lifecycle").
//
// Imports allowed here: vscode, ./types, ./log, node:crypto.
//
// Design invariants (empirically established in the plan — do not "improve"):
//
//   * claude IS the terminal process: `shellPath: <claude binary>` plus
//     `shellArgs: ['--session-id', <uuid>, …]`. No shell, no init race, no
//     half-eaten launch line, and the session id is ours by construction.
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
  RosterEntry,
  TerminalBinding,
  TerminalDeps,
} from './types';
import { log, logError } from './log';

// --------------------------------------------------------------- constants

/** Hidden (`f1:false`), active-terminal-only command. `executeCommand` still
 *  works — its precondition does not block programmatic invocation. */
export const RENAME_COMMAND = 'workbench.action.terminal.renameWithArg';
export const MOVE_TO_EDITOR_COMMAND = 'workbench.action.terminal.moveToEditor';
export const MOVE_TO_PANEL_COMMAND =
  'workbench.action.terminal.moveToTerminalPanel';

const MISSING_BINARY_MESSAGE =
  'Claude CLI not found — set lineage.claudeBinary to the full path of your ' +
  'claude executable.';
const RESTRICTED_MESSAGE =
  'Lineage cannot start a Claude session here: VS Code blocks terminals in ' +
  'Restricted Mode. Trust this workspace and try again.';

/** How a bound terminal ended. `shutdown` = the window closed/reloaded (the
 *  session is very likely still alive), `user` = the user killed it. */
export type ExitReason = 'shutdown' | 'user' | 'other';

interface ExitEvent {
  sessionId: string;
  code: number | undefined;
  reason: ExitReason;
}

interface BoundEntry {
  terminal: vscode.Terminal;
  binding: TerminalBinding;
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

/** Run `fn` on the next microtask, swallowing anything it throws. Used so that
 *  bind events raised by `reassociate()` still reach listeners the integrator
 *  subscribes immediately AFTER calling it (SPEC §4-I step 4 order). */
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
 *  - resume  `['--resume', resumeId]` — reopen a CLOSED session. `--resume`
 *    reuses the original session id (that is precisely why `--fork-session`
 *    exists as a separate flag), so NO `--session-id` is passed: adding one
 *    would ask claude to both keep and replace the id. The caller sets
 *    `sessionId === resumeId` so the LINEAGE_NODE_ID stamp and the binding
 *    still name the session that will actually be running.
 *  - fork    `['--fork-session', '--resume', parentId, '--session-id', child]`
 *  - new     `['--session-id', id]`
 *
 * A non-empty `prompt` is APPENDED as the final positional argument.
 * `resumeId` wins if both are somehow set — resuming into a fork would be a
 * silent data-losing surprise, so the narrower intent is honoured.
 */
export function buildShellArgs(opts: LaunchOptions): string[] {
  const args: string[] = [];
  const resumeId =
    typeof opts.resumeId === 'string' && opts.resumeId.length > 0
      ? opts.resumeId
      : null;

  if (resumeId !== null) {
    args.push('--resume', resumeId);
  } else {
    if (typeof opts.parentId === 'string' && opts.parentId.length > 0) {
      args.push('--fork-session', '--resume', opts.parentId);
    }
    args.push('--session-id', opts.sessionId);
  }

  if (typeof opts.prompt === 'string' && opts.prompt.trim().length > 0) {
    args.push(opts.prompt);
  }
  return args;
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

/** Default terminal name for a session. */
export function defaultTerminalName(sessionId: string): string {
  return `claude · ${shortId(sessionId)}`;
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
      fresh.push(this.bind(sessionId, terminal));
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
      fresh.push(binding);
    }

    if (fresh.length > 0) {
      log(`terminals: re-associated ${fresh.length} terminal(s) via roster pid`);
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

    const binary = this.deps.claudeBinary();
    if (!binary) {
      showError(MISSING_BINARY_MESSAGE);
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
        : defaultTerminalName(sessionId);

    let terminal: vscode.Terminal;
    this.claiming.add(sessionId);
    try {
      terminal = w.createTerminal({
        name,
        shellPath: binary,
        shellArgs: buildShellArgs(opts),
        cwd: opts.cwd,
        // The stamp that survives a window reload inside creationOptions.
        env: { [ENV_NODE_ID]: sessionId },
        // NEVER strictEnv — claude needs the inherited environment.
        iconPath: new vscode.ThemeIcon(opts.parentId ? 'git-branch' : 'terminal'),
        color: opts.parentId
          ? new vscode.ThemeColor('terminal.ansiCyan')
          : undefined,
      });
    } catch (err) {
      // Restricted Mode refuses the pty outright; so can a bad cwd.
      this.claiming.delete(sessionId);
      logError('terminals.launch', err);
      showError(
        `Could not start Claude: ${
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
    this.claiming.delete(sessionId);
    this.safeShow(terminal, false);
    this.emitBind(binding);

    const pid = await this.pidOf(terminal);
    // The terminal may already have died while we awaited the pid.
    if (pid !== undefined && this.bound.get(sessionId)?.binding === binding) {
      binding.pid = pid;
    }
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

  /** Move the bound terminal into an editor group (show(true) + command). */
  async moveToEditor(sessionId: string): Promise<boolean> {
    const entry = this.bound.get(sessionId);
    if (!entry) return false;
    return this.runOnTerminal(entry, MOVE_TO_EDITOR_COMMAND);
  }

  /** Move the bound terminal back into the terminal panel. */
  async moveToTerminalPanel(sessionId: string): Promise<boolean> {
    const entry = this.bound.get(sessionId);
    if (!entry) return false;
    return this.runOnTerminal(entry, MOVE_TO_PANEL_COMMAND);
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

  /** Dispose the bound terminal; the close handler unbinds and emits exit. */
  closeTerminal(sessionId: string): boolean {
    const entry = this.bound.get(sessionId);
    if (!entry) return false;
    try {
      entry.terminal.dispose();
    } catch (err) {
      logError('terminals.closeTerminal', err);
      return false;
    }
    if (!this.closeWatched) {
      // No onDidCloseTerminal in this host: unbind ourselves so state does not
      // keep claiming the session is hosted here.
      this.bound.delete(sessionId);
      this.exitEmitter.fire({ sessionId, code: undefined, reason: 'other' });
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
    ) => void,
  ): DisposableLike {
    return this.exitEmitter.event((e) => cb(e.sessionId, e.code, e.reason));
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
    this.bound.set(sessionId, { terminal, binding });
    return binding;
  }

  private emitBind(binding: TerminalBinding): void {
    if (this.disposed) return;
    try {
      this.bindEmitter.fire({ ...binding });
    } catch (err) {
      logError('terminals.onDidBind', err);
    }
  }

  private async pidOf(terminal: vscode.Terminal): Promise<number | undefined> {
    try {
      const pid = await terminal.processId;
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

  private handleOpen(terminal: vscode.Terminal): void {
    if (this.disposed) return;
    if (this.findByTerminal(terminal)) return; // ours already
    const sessionId = nodeIdOfTerminal(terminal);
    if (!sessionId) return;
    if (this.bound.has(sessionId) || this.claiming.has(sessionId)) return;
    const binding = this.bind(sessionId, terminal);
    log(`terminals: bound revived terminal for ${shortId(sessionId)}`);
    this.emitBind(binding);
    void this.pidOf(terminal).then((pid) => {
      if (pid !== undefined && this.bound.get(sessionId)?.binding === binding) {
        binding.pid = pid;
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
    log(
      `terminals: ${shortId(sessionId)} closed (reason=${reason}, code=` +
        `${status?.code ?? 'n/a'})`,
    );
    try {
      this.exitEmitter.fire({ sessionId, code: status?.code, reason });
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
