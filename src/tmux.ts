// src/tmux.ts — the detach tier.
//
// THE PROBLEM THIS FILE EXISTS TO FIX: a workspace switch must hide a foreign
// session's tab instantly and invisibly, but VS Code's API cannot separate a
// terminal's UI from its process — closing the tab kills the pty, and there is
// no detach/reattach. The earlier kill+resume parking therefore had to spare
// BUSY sessions, and lost live process state for idle ones. The one design that
// hides the view while the process keeps running is to have something OUTSIDE
// the window own the pty: tmux.
//
// Every Flock-launched session is wrapped — when tmux is installed and
// `lineage.tmux` is not 'off' — in a PRIVATE tmux server:
//
//   tmux -L lineage -f <conf> new-session -A -s lineage-<uuid> \
//        -c <cwd> -e LINEAGE_NODE_ID=<uuid> -- <claude> <args…>
//
// The VS Code terminal is then only the tmux CLIENT. Disposing it (a park)
// detaches: the client dies, the claude process keeps running, invisible.
// Re-running the SAME command re-attaches (`-A` = attach if the session
// exists) — and because the argv carries `--resume`, the same command also
// covers a session that died while parked. One command, both outcomes,
// verified on tmux 3.6a.
//
// Why each piece is what it is:
//
//   * `-L lineage` — a dedicated socket. The user's own tmux (sessions,
//     plugins, status bar) is never touched, and `exit-empty` (default on)
//     kills our server with its last session.
//   * `-f <conf>`  — our conf INSTEAD of ~/.tmux.conf (passing -f is also
//     what keeps the user's conf out). It silences everything that would
//     reveal tmux: no status bar, no prefix key (Ctrl+B belongs to claude's
//     own keymap, not to tmux), no title rewriting. Read at SERVER start
//     only, so a conf change applies when the server next restarts.
//   * `-e LINEAGE_NODE_ID` — the hook re-key stamp must be in the CLAUDE
//     process's environment. The server inherits the FIRST client's env and
//     keeps it for every later session, so without `-e` every session after
//     the first would inherit the first one's stamp. `-e` sets the session
//     environment, which wins. (The terminal's own env stamp still exists
//     for reload re-association; this one is for the hooks.)
//   * `--` before the command — tmux stops option parsing there, so no
//     future claude flag can be eaten as a tmux one. With multiple words the
//     command is exec'd directly, no shell in between (same guarantee the
//     plain launch has).
//
// EXIT TO THE SHELL (`lineage.exitToShell`, on by default). A wrap's pane holds
// exactly one process, so `/exit` used to take the tab with it: tmux destroyed
// the session, the client died, and VS Code closed the tab on someone who had
// exited only in order to start again. The conf now arms `remain-on-exit` and a
// `pane-died` hook that respawns the user's login shell in that same pane — same
// tmux session, same client, same tab, a prompt where the CLI was — then
// disarms itself so the shell's own exit still ends everything. `renderTmuxConf`
// carries the reasoning for each line; `queryWrapState` is the other half, the
// one that stops the resume verb from mistaking that shell for a live
// conversation. Off, and on the kill+resume tier, the old behaviour is exactly
// what happens.
//
// Windows is deliberately out: tmux is not a native Windows program, and a
// WSL/MSYS tmux found on PATH would run claude in the wrong world. Windows —
// and any machine without tmux — keeps the kill+resume tier, which every
// caller of these helpers must treat as the always-available fallback.
//
// This module NEVER imports vscode: everything in it is either pure or talks
// straight to the filesystem and to child processes, so it stays unit-testable
// outside a running workbench.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { logError } from './log';
import { isSessionId } from './types';
import type { TmuxSpawn, WrapState } from './types';

/** The private server's socket name (`tmux -L …`). Also the string a user
 *  needs to inspect it by hand: `tmux -L lineage list-sessions`. */
export const TMUX_SOCKET = 'lineage';

/** Basename of the conf file written into globalStorage. */
export const TMUX_CONF_NAME = 'tmux.conf';

/**
 * The pane option the exit-to-shell hook stamps, and the one unambiguous way
 * to tell a wrap that is RUNNING its CLI from one that has exited and left a
 * shell behind. A user option (`@`-prefixed) so tmux stores it for us and no
 * future tmux release can mean something else by it.
 *
 * WHY A FLAG AND NOT A GUESS: the alternative reading is
 * `#{pane_current_command}` against a list of shell basenames, which is wrong
 * in both directions — a claude that shells out for a tool call momentarily
 * reads as a shell, and a user whose shell Flock has never heard of reads as
 * claude. The flag is set by the same hook that respawns the shell, so it says
 * exactly what happened rather than what the pane looks like.
 */
export const TMUX_EXITED_OPTION = '@flock_exited';

/**
 * The conf's fixed part. Its one job is to make tmux INVISIBLE: a wrapped
 * session must look and feel like a bare claude terminal.
 *
 * `prefix None` (both prefixes) is the load-bearing line: Claude Code owns
 * Ctrl+B (background a task), and a tmux that swallows it as its prefix would
 * be a keybinding regression in every wrapped session. Copy-mode stays
 * reachable — `mouse on` maps wheel-scroll into it, which is how scrollback
 * works in a wrapped session.
 */
export const TMUX_CONF = `# Written by the Flock extension on every activation — edits do not survive.
# This is the conf for Flock's PRIVATE tmux server (tmux -L ${TMUX_SOCKET}); your own
# tmux and ~/.tmux.conf are not involved. Read at server start only.
set -g status off
set -g prefix None
set -g prefix2 None
set -s escape-time 0
set -g mouse on
set -g history-limit 50000
set -g default-terminal "tmux-256color"
set -as terminal-features ",xterm*:RGB"
set -g focus-events on
set -g allow-passthrough on
set -s exit-empty on
set -g set-titles off
`;

/**
 * Characters that must never reach the shell path we interpolate into the
 * conf. The path lands inside a SINGLE-QUOTED tmux hook command, so a quote
 * or a backslash would end the string early and the rest of the line would be
 * parsed as tmux commands; whitespace would split it into a command plus
 * arguments; `#` starts a tmux comment, and `;` a new command. None of these
 * appear in a real shell path, so anything carrying one is rejected rather
 * than escaped — a launch must never turn into a conf we did not write.
 */
const UNSAFE_IN_CONF = /['"\\;#\s]/;

/**
 * Pure. The shell to leave behind when a wrapped CLI exits, or null when there
 * should be no exit-to-shell at all (Windows, where the whole tier is absent —
 * see `findTmuxBinary`).
 *
 * `$SHELL` is the right source: it is the shell the user chose, and the one
 * their prompt, aliases and history belong to. It is also user-controlled
 * input reaching a file we generate, hence `UNSAFE_IN_CONF` and the absolute
 * -path requirement. A `$SHELL` that fails either test is not an error worth
 * a message — it falls back to the platform's own default, which is what the
 * pty would have used anyway.
 */
export function resolveExitShell(
  shell: string | undefined,
  platform: string,
): string | null {
  if (platform === 'win32') return null;
  const fallback = platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
  if (typeof shell !== 'string') return fallback;
  const trimmed = shell.trim();
  if (trimmed === '' || !trimmed.startsWith('/')) return fallback;
  if (UNSAFE_IN_CONF.test(trimmed)) return fallback;
  return trimmed;
}

/**
 * Pure. The whole conf, with or without the exit-to-shell block.
 *
 * THE PROBLEM THE BLOCK FIXES: `/exit` (or Ctrl+D) ends the claude process,
 * which is the wrap's only pane — so tmux destroys the session, `exit-empty`
 * reaps the server, the client dies and VS Code closes the tab. Someone who
 * exits meaning to start again immediately (new MCP server, edited settings,
 * a fresh context) does not get a prompt to type `claude --resume` at: they
 * get their tab pulled out from under them and have to go find the row again.
 *
 * The three hooks, verified against tmux 3.6a rather than assumed:
 *
 *   * `remain-on-exit on` keeps the pane — dead, but present — when its
 *     process exits, which is the only state from which `pane-died` fires at
 *     all. Without it tmux destroys the pane and only `pane-exited` fires,
 *     too late to put anything back.
 *   * `respawn-pane` puts a LOGIN shell in that same pane, at
 *     `#{pane_current_path}` so it opens where the conversation was working.
 *     Same pane means same tmux session, same client, same VS Code tab: the
 *     screen redraws to a prompt and nothing else moves.
 *   * `setw remain-on-exit off` is the safety half, and it is not optional.
 *     Left armed, exiting the SHELL would fire the hook again and respawn
 *     another one — a tab that cannot be closed from the inside and a tmux
 *     session that outlives every attempt to end it. Disarmed, the shell's
 *     own exit destroys the pane for real, `exit-empty` reaps the server, and
 *     the tab closes exactly as it does today.
 *   * the `TMUX_EXITED_OPTION` stamp is what Flock reads back: a wrap at a
 *     shell prompt is NOT a live conversation to attach to, and without this
 *     the resume verb would hand the user their own shell and call it a
 *     reopened session. See `queryWrapState`.
 *
 * `kill-session` is unaffected — it destroys the session outright, so the
 * hook never runs and a tab the user closes still ends the session (checked;
 * a resurrecting hook here would leak a tmux session per close). So is
 * `respawn-pane -k`, which replaces the process without firing `pane-died`,
 * leaving the account-move path exactly as it was.
 */
export function renderTmuxConf(exitShell?: string | null): string {
  if (typeof exitShell !== 'string' || exitShell === '') return TMUX_CONF;
  if (!exitShell.startsWith('/') || UNSAFE_IN_CONF.test(exitShell)) {
    return TMUX_CONF;
  }
  return (
    TMUX_CONF +
    `# Exit to the shell instead of closing the tab (lineage.exitToShell).\n` +
    `set -g remain-on-exit on\n` +
    `set-hook -g pane-died 'respawn-pane -k -c "#{pane_current_path}" -- ${exitShell} -l'\n` +
    `set-hook -ga pane-died 'setw remain-on-exit off'\n` +
    `set-hook -ga pane-died 'set -p ${TMUX_EXITED_OPTION} 1'\n`
  );
}

/**
 * The tmux session name for a Flock session. Prefixed so a hand-run
 * `list-sessions` reads as ours, and stable across generations only by
 * CHOICE of the caller: a launch derives it from the id it launches with,
 * and the park/restore path carries the recorded name instead of re-deriving
 * — a re-key while parked must not orphan the running process.
 * (Uuids are safe tmux names: no `.`/`:`, which tmux forbids.)
 */
export function tmuxSessionName(sessionId: string): string {
  return `${TMUX_SOCKET}-${sessionId}`;
}

/**
 * Pure. The full argv (after the tmux binary) that wraps `command`.
 * `-A` makes this attach-or-create: the SAME argv launches a session and
 * later re-attaches to it, which is what lets the restore path reuse the
 * ordinary launch machinery unchanged.
 */
export function buildTmuxArgs(opts: {
  /** Session name — `tmuxSessionName(...)` or the one recorded at park. */
  name: string;
  /** Conf to start the server with. Omitted, the server falls back to tmux
   *  defaults PLUS the user's ~/.tmux.conf — visibly tmux, but a working
   *  session. The option exists because writing the conf can fail and a
   *  launch must not. */
  confPath?: string;
  /** Start directory for the claude process (`-c`). */
  cwd?: string;
  /** Session environment (`-e`), applied to processes the session spawns.
   *  This is where LINEAGE_NODE_ID goes — see the file header. */
  env?: Readonly<Record<string, string>>;
  /** The unwrapped launch: [claudeBinary, ...claudeArgs]. */
  command: readonly string[];
}): string[] {
  const args: string[] = ['-L', TMUX_SOCKET];
  if (typeof opts.confPath === 'string' && opts.confPath !== '') {
    args.push('-f', opts.confPath);
  }
  args.push('new-session', '-A', '-s', opts.name);
  if (typeof opts.cwd === 'string' && opts.cwd !== '') {
    args.push('-c', opts.cwd);
  }
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    args.push('-e', `${key}=${value}`);
  }
  args.push('--', ...opts.command);
  return args;
}

/**
 * Read the tmux session name back out of a terminal's creation options —
 * `undefined` for a terminal that is not a tmux wrap. This is what makes the
 * name survive a window RELOAD: the revived Terminal's creationOptions carry
 * the original shellPath/shellArgs, and a rebuilt binding that lost the name
 * would downgrade the session's next park from detach to kill — disposing
 * what is only a client while recording the conversation as dead, and the
 * switch-back would then `--resume` a SECOND claude beside the running one.
 */
export function tmuxNameOfTerminal(terminal: {
  readonly creationOptions?: unknown;
}): string | undefined {
  const opts = terminal.creationOptions;
  if (!opts || typeof opts !== 'object') return undefined;
  if ('pty' in opts) return undefined; // ExtensionTerminalOptions — not ours
  const { shellPath, shellArgs } = opts as {
    shellPath?: unknown;
    shellArgs?: unknown;
  };
  // Only a terminal whose PROCESS is tmux can be a wrap — a `-s` in some
  // other program's args must not be read as a session name.
  if (typeof shellPath !== 'string' || !path.basename(shellPath).startsWith('tmux')) {
    return undefined;
  }
  if (!Array.isArray(shellArgs)) return undefined;
  for (let i = 0; i < shellArgs.length - 1; i++) {
    if (shellArgs[i] === '--') break; // past tmux's own args — nothing to find
    if (shellArgs[i] === '-s') {
      const name = shellArgs[i + 1];
      return typeof name === 'string' && name !== '' ? name : undefined;
    }
  }
  return undefined;
}

/**
 * The tmux binary, or null. Null ALWAYS on win32 — see the file header — and
 * on a machine without tmux, which is the everyday fallback, not an error.
 * PATH-scanned per call (a launch is rare and a scan is a handful of stats)
 * so installing tmux needs no reload. No config override on purpose: the one
 * knob is `lineage.tmux` on/off, and a wrong custom path would produce
 * launches that die instantly with nothing on screen to explain why.
 */
export function findTmuxBinary(): string | null {
  if (process.platform === 'win32') return null;
  const rawPath = process.env['PATH'] ?? '';
  if (rawPath.length === 0) return null;
  for (const dir of rawPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.resolve(dir, 'tmux');
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // ENOENT / EACCES / broken symlink — try the next PATH entry.
    }
  }
  return null;
}

/**
 * Write the conf into `dir` (globalStorage) and return its path — or
 * undefined when the write failed, which degrades to launching without `-f`.
 * Idempotent: an up-to-date file is left untouched, so activation costs one
 * read in the steady state.
 */
export function ensureTmuxConf(
  dir: string,
  exitShell?: string | null,
): string | undefined {
  const confPath = path.join(dir, TMUX_CONF_NAME);
  const wanted = renderTmuxConf(exitShell);
  try {
    let existing: string | undefined;
    try {
      existing = fs.readFileSync(confPath, 'utf8');
    } catch {
      existing = undefined;
    }
    if (existing !== wanted) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(confPath, wanted);
    }
    return confPath;
  } catch (err) {
    logError('tmux.ensureConf', err);
    return undefined;
  }
}

/**
 * Pure. The pid in `list-panes -F '#{pane_pid}'` output, or undefined for
 * anything that does not read as exactly one positive integer. One pane per
 * wrap by construction (the session is created around a single command), so
 * multiple lines mean the session is not what we made and nothing is claimed.
 */
export function parsePanePid(stdout: string): number | undefined {
  const lines = stdout.split('\n').filter((l) => l.trim() !== '');
  if (lines.length !== 1) return undefined;
  const pid = Number((lines[0] ?? '').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * CLAUDE's real pid inside a wrapped session — the pane's root process, which
 * is claude itself because the wrap execs it directly (no shell in between).
 *
 * WHY THIS EXISTS: a wrapped terminal's own process is the tmux CLIENT, so
 * `Terminal.processId` identifies nothing on the roster — and every pid-keyed
 * mechanism goes blind: the re-key detector never sees "same pid, new
 * session id" (a wrapped `--resume` that mints a fresh generation leaves the
 * terminal bound to the OLD id — the session's own tab on screen while its
 * row says "running outside this editor"), and app-restart re-association
 * never matches. The pane pid is the one pid tmux and the roster agree on.
 *
 * Never throws; a missing server, name or tmux is `undefined`.
 */
export function queryPanePid(
  binary: string,
  name: string,
): Promise<number | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(
        binary,
        ['-L', TMUX_SOCKET, 'list-panes', '-t', `=${name}`, '-F', '#{pane_pid}'],
        { timeout: 2000 },
        (err, stdout) => {
          resolve(err ? undefined : parsePanePid(stdout));
        },
      );
    } catch (err) {
      logError('tmux.queryPanePid', err);
      resolve(undefined);
    }
  });
}

/**
 * Pure. `list-panes -F '#{pane_pid} #{TMUX_EXITED_OPTION}'` output as a state.
 *
 * Same one-pane rule as `parsePanePid`, and for the same reason: a wrap is
 * created around a single command, so anything answering with two panes is not
 * what we made and nothing is claimed about it. An unset user option formats
 * as the empty string, so a wrap launched before exit-to-shell existed — or
 * with it switched off — reads `running`, which is what it is.
 */
export function parseWrapState(stdout: string): WrapState {
  const lines = stdout.split('\n').filter((l) => l.trim() !== '');
  if (lines.length !== 1) return 'gone';
  const parts = (lines[0] ?? '').trim().split(/\s+/);
  const pid = Number(parts[0] ?? '');
  if (!Number.isInteger(pid) || pid <= 0) return 'gone';
  return (parts[1] ?? '') === '1' ? 'exited' : 'running';
}

/**
 * Whether the server holds this wrap, and whether its CLI is still in it.
 *
 * One exec, and it replaces `queryPanePid(...) !== undefined` everywhere the
 * question being asked is "is there a conversation here" rather than "what pid
 * is claude". Never throws; a missing server, name or tmux is `gone`.
 */
export function queryWrapState(
  binary: string,
  name: string,
): Promise<WrapState> {
  return new Promise((resolve) => {
    try {
      execFile(
        binary,
        [
          '-L',
          TMUX_SOCKET,
          'list-panes',
          '-t',
          `=${name}`,
          '-F',
          `#{pane_pid} #{${TMUX_EXITED_OPTION}}`,
        ],
        { timeout: 2000 },
        (err, stdout) => {
          resolve(err ? 'gone' : parseWrapState(stdout));
        },
      );
    } catch (err) {
      logError('tmux.queryWrapState', err);
      resolve('gone');
    }
  });
}

/**
 * Pure. The session id a wrap's session name encodes, or undefined for any
 * name we did not mint. The inverse of `tmuxSessionName` — the name IS the
 * launch-time session id, which is exactly what a binding is keyed by.
 */
export function sessionIdOfTmuxName(name: string): string | undefined {
  const prefix = `${TMUX_SOCKET}-`;
  if (!name.startsWith(prefix)) return undefined;
  const id = name.slice(prefix.length);
  return isSessionId(id) ? id : undefined;
}

/**
 * Pure. `list-clients -F '#{client_pid} #{session_name}'` output as a map.
 * Unparseable lines are skipped, never fatal.
 */
export function parseClientSessions(stdout: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of stdout.split('\n')) {
    const space = line.indexOf(' ');
    if (space <= 0) continue;
    const pid = Number(line.slice(0, space).trim());
    const name = line.slice(space + 1).trim();
    if (!Number.isInteger(pid) || pid <= 0 || name === '') continue;
    out.set(pid, name);
  }
  return out;
}

/**
 * Which wrapped session each live tmux CLIENT is attached to, by client pid.
 *
 * WHY THIS EXISTS: after a full app RESTART a revived terminal's
 * creationOptions carry no env stamp (a window reload keeps it; a restart
 * does not), and `reassociateFromRoster` matches CLAUDE pids — which a
 * wrapped terminal's own pid (the client's) never is. So a restart left
 * every wrapped terminal a stranger to the registry: its tab on screen,
 * its session live on the roster, and a row click insisting the session was
 * "running outside this editor". The tmux server is the one party that
 * always knows which terminal shows which session, and the client pid is
 * exactly `Terminal.processId`.
 *
 * Never throws; no server / no tmux is an empty map.
 */
export function queryClientSessions(
  binary: string,
): Promise<ReadonlyMap<number, string>> {
  return new Promise((resolve) => {
    try {
      execFile(
        binary,
        ['-L', TMUX_SOCKET, 'list-clients', '-F', '#{client_pid} #{session_name}'],
        { timeout: 2000 },
        (err, stdout) => {
          resolve(err ? new Map() : parseClientSessions(stdout));
        },
      );
    } catch (err) {
      logError('tmux.queryClientSessions', err);
      resolve(new Map());
    }
  });
}

/**
 * End a wrapped session for real: `kill-session` tells the server to destroy
 * the pane, which ends the claude process inside.
 *
 * WHY THIS EXISTS: disposing a wrapped terminal kills only the CLIENT — that
 * is the whole point of the detach tier, and exactly wrong when the user
 * CLOSES the tab. The contract is "closing a tab closes the session" (the
 * row goes inactive); without this, a user-closed wrapped session kept
 * running invisibly and its row stayed lit forever. Only workspace switches
 * detach; a user close ends the session, same as it always did for bare
 * terminals (where claude WAS the terminal process).
 */
export function killTmuxSession(
  binary: string,
  name: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile(
        binary,
        ['-L', TMUX_SOCKET, 'kill-session', '-t', `=${name}`],
        { timeout: 2000 },
        (err) => resolve(!err),
      );
    } catch (err) {
      logError('tmux.killSession', err);
      resolve(false);
    }
  });
}

/**
 * Pure. The argv (after the tmux binary) that RESTARTS a wrapped session's
 * process on a new command and a new environment, in the pane it is already in.
 *
 * `-k` kills whatever is running there first, and it is what makes this one
 * operation rather than two: there is no instant at which the pane is empty, so
 * the tmux session cannot hit its "last process exited" rule and destroy itself
 * between the kill and the launch.
 *
 * TARGET FORM, verified against tmux 3.6a rather than assumed: a pane target is
 * `session:window.pane`, so the bare `=<name>` that every SESSION-targeting
 * command in this file uses is rejected here with `can't find pane`. The
 * trailing colon is what makes it a pane target — session matched exactly, its
 * current window, that window's active pane — and the `=` is kept for the same
 * reason `killTmuxSession` keeps it: without it tmux prefix-matches, and every
 * name we mint is a prefix of nothing but itself only by luck.
 */
export function buildRespawnArgs(opts: {
  /** The wrapped session's name — `tmuxSessionName(...)`, or the one recorded
   *  at park. */
  name: string;
  /** Start directory for the new process (`-c`). */
  cwd?: string;
  /** Environment for the new process (`-e`). Overrides the SESSION environment
   *  the original `new-session -e` set, which is the entire point: that is
   *  where the old account's config dir is, and it does not go away on its own.
   *  See `respawnTmuxPane` for the other half of that. */
  env?: Readonly<Record<string, string>>;
  /** The unwrapped launch: [binary, ...args]. */
  command: readonly string[];
}): string[] {
  const args: string[] = ['-L', TMUX_SOCKET, 'respawn-pane', '-k'];
  if (typeof opts.cwd === 'string' && opts.cwd !== '') {
    args.push('-c', opts.cwd);
  }
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    args.push('-e', `${key}=${value}`);
  }
  args.push('-t', `=${opts.name}:`);
  args.push('--', ...opts.command);
  return args;
}

/**
 * Pure. The argv that rewrites ONE variable in a wrapped session's own
 * environment. See `respawnTmuxPane` for why a respawn is not enough on its own.
 */
export function buildSetEnvArgs(
  name: string,
  key: string,
  value: string,
): string[] {
  return ['-L', TMUX_SOCKET, 'set-environment', '-t', `=${name}`, key, value];
}

/**
 * Pure. The argv that unsets the exit-to-shell stamp on a wrap's pane.
 *
 * Belongs to every path that puts a CLI back into a pane: the stamp records
 * that the pane holds a SHELL, and a respawn makes that false. Left behind, a
 * live conversation would read as `exited` forever — and the resume verb would
 * kill and relaunch a process that was running fine. Pane target form (`=name:`)
 * for the reason `buildRespawnArgs` documents.
 */
export function buildClearExitedArgs(name: string): string[] {
  return [
    '-L',
    TMUX_SOCKET,
    'set',
    '-p',
    '-t',
    `=${name}:`,
    '-u',
    TMUX_EXITED_OPTION,
  ];
}

/**
 * Restart a wrapped session's process IN PLACE, on a different environment.
 *
 * WHY THIS EXISTS: an account is a config directory, and a config directory is
 * an environment variable read once, at exec. So moving a live conversation to
 * another account means restarting the CLI — and every other way of restarting
 * it costs the user their tab. Disposing the terminal and launching a new one
 * puts the session at the end of the terminal list, in a tab they have to go
 * find again, which for a switch made *because you hit a limit mid-thought* is
 * most of the interruption the feature exists to avoid. Respawning the pane
 * keeps the tmux session, the client attached to it, and therefore the VS Code
 * tab exactly where they were: the screen redraws and nothing else moves.
 *
 * TWO COMMANDS, not one, and the second is not belt-and-braces. `-e` on the
 * respawn sets the environment of the new PROCESS; the SESSION environment that
 * `new-session -e` wrote at launch still holds the old account's config dir
 * afterwards (confirmed: `show-environment` still reported the original value
 * after a successful respawn). Anything that later reads the session's
 * environment — a person debugging, a future pane — would be told the
 * conversation is on an account it left. So each variable is written into the
 * session too.
 *
 * Returns whether the RESPAWN succeeded; a `set-environment` that fails is
 * logged and survived, because by then the process is already running on the
 * right account and the stale copy is a cosmetic lie rather than a wrong launch.
 *
 * Never throws. `false` means the caller must fall back to disposing the
 * terminal and launching afresh — which is what a session outside the detach
 * tier does anyway.
 */
export async function respawnTmuxPane(
  binary: string,
  opts: {
    name: string;
    cwd?: string;
    env?: Readonly<Record<string, string>>;
    command: readonly string[];
  },
): Promise<boolean> {
  const ok = await new Promise<boolean>((resolve) => {
    try {
      execFile(
        binary,
        buildRespawnArgs(opts),
        { timeout: 5000 },
        (err) => resolve(!err),
      );
    } catch (err) {
      logError('tmux.respawnPane', err);
      resolve(false);
    }
  });
  if (!ok) return false;

  // The pane holds a CLI again, so it is no longer "exited to a shell".
  // Defensive rather than reached today (the resume path clears an exited wrap
  // by killing it, not by respawning into it), and cheap enough to keep the
  // stamp from ever outliving what it describes.
  await new Promise<void>((resolve) => {
    try {
      execFile(
        binary,
        buildClearExitedArgs(opts.name),
        { timeout: 2000 },
        (err) => {
          if (err) logError('tmux.clearExited', err);
          resolve();
        },
      );
    } catch (err) {
      logError('tmux.clearExited', err);
      resolve();
    }
  });

  for (const [key, value] of Object.entries(opts.env ?? {})) {
    await new Promise<void>((resolve) => {
      try {
        execFile(
          binary,
          buildSetEnvArgs(opts.name, key, value),
          { timeout: 2000 },
          (err) => {
            // Never logs the VALUE: on an API-key account it is the credential.
            if (err) logError(`tmux.setEnvironment: ${key} not updated`, err);
            resolve();
          },
        );
      } catch (err) {
        logError('tmux.setEnvironment', err);
        resolve();
      }
    });
  }
  return true;
}

/**
 * Resolve how (whether) to wrap a launch, from the config gate and the PATH.
 * One call per launch, so both react to the world without a reload.
 */
export function resolveTmuxSpawn(
  mode: string | undefined,
  confPath: string | undefined,
): TmuxSpawn | null {
  if (mode === 'off') return null;
  const binary = findTmuxBinary();
  if (binary === null) return null;
  return confPath !== undefined ? { binary, confPath } : { binary };
}

/** What, if anything, to tell the user about tmux once per install.
 *  `install` — the detach tier is unavailable and they probably do not know.
 *  `enable`  — they HAVE tmux and have switched the tier off by hand. */
export type TmuxAdvice = 'none' | 'install' | 'enable';

/**
 * Whether to nudge about tmux, and which way. Pure so the matrix is testable
 * without a workbench — the wiring in extension.ts only supplies the inputs.
 *
 * The nudge exists because the detach tier is invisible when it is missing:
 * parking still works, so nothing looks broken. It just kills and resumes
 * instead of detaching, which loses a busy session's in-flight turn. Someone
 * who never installed tmux has no way to learn that from the product.
 *
 * It stays quiet in every case where it would be noise:
 *  - Windows, where the tier does not exist at all (see findTmuxBinary).
 *  - Workspaces off, which is the only feature the tier serves — no parking,
 *    no reason to care how parking is implemented.
 *  - `lineage.tmux: off` on a machine with no tmux: two problems to fix in one
 *    toast is a worse message than none, and this user has opted out anyway.
 *  - Already dismissed. Asked once per install, never on a timer.
 */
export function tmuxAdvice(opts: {
  platform: string;
  /** `lineage.tmux`. */
  mode: string | undefined;
  /** findTmuxBinary(), injected so tests need no PATH. */
  binary: string | null;
  /** `lineage.workspaces.enabled`. */
  workspacesEnabled: boolean;
  dismissed: boolean;
}): TmuxAdvice {
  if (opts.dismissed) return 'none';
  if (opts.platform === 'win32') return 'none';
  if (!opts.workspacesEnabled) return 'none';
  // Switched off by hand. Worth one reminder if the tier is actually available,
  // silence otherwise.
  if (opts.mode === 'off') return opts.binary === null ? 'none' : 'enable';
  return opts.binary === null ? 'install' : 'none';
}

/** Install line for the host, or undefined where we should not advise one.
 *  Deliberately the package manager and nothing else — a curl-to-shell in a
 *  toast is not something a session manager should be teaching. */
export function tmuxInstallHint(platform: string): string | undefined {
  if (platform === 'darwin') return 'brew install tmux';
  if (platform === 'linux') return 'sudo apt install tmux';
  return undefined;
}
