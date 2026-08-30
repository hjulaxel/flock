// test/tmux.test.ts — the detach tier's pure parts (src/tmux.ts).
//
// What matters here is the CONTRACT other modules lean on: the argv shape a
// wrap produces (terminals.ts execs it verbatim), the name round-trip through
// creationOptions (losing it downgrades a park from detach to kill — and the
// switch-back would then `--resume` a second claude beside the running one),
// and the conf keeping tmux invisible (no status bar, no prefix key).

import { afterEach, describe, expect, it } from 'vitest';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  TMUX_CONF,
  TMUX_EXITED_OPTION,
  TMUX_SOCKET,
  buildClearExitedArgs,
  buildRemoveEnvArgs,
  buildRespawnArgs,
  buildSetEnvArgs,
  buildTmuxArgs,
  ensureTmuxConf,
  parseWrapState,
  renderTmuxConf,
  resolveExitShell,
  findTmuxBinary,
  tmuxAdvice,
  tmuxInstallHint,
  killTmuxSessionTree,
  parseClientSessions,
  parsePanePid,
  parseTmuxSessions,
  resolveTmuxSpawn,
  respawnCommands,
  sessionIdOfTmuxName,
  tmuxNameOfTerminal,
  tmuxSessionName,
} from '../src/tmux';
import { CONFIG_DIR_ENV } from '../src/accounts';
import { ENV_NODE_ID } from '../src/types';

const SID = '0f0000a1-0000-4000-8000-0000000000a1';

const tempDirs: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-tmux-'));
  tempDirs.push(d);
  return d;
}

const realPath = process.env['PATH'];
afterEach(() => {
  process.env['PATH'] = realPath;
  for (const d of tempDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('tmuxSessionName', () => {
  it('prefixes the session id so a hand-run list-sessions reads as ours', () => {
    expect(tmuxSessionName(SID)).toBe(`lineage-${SID}`);
  });
});

describe('buildTmuxArgs', () => {
  it('produces the full wrap: socket, conf, attach-or-create, cwd, env, --', () => {
    expect(
      buildTmuxArgs({
        name: tmuxSessionName(SID),
        confPath: '/store/tmux.conf',
        cwd: '/code/api',
        env: { [ENV_NODE_ID]: SID },
        command: ['/usr/local/bin/claude', '--session-id', SID],
      }),
    ).toEqual([
      '-L',
      TMUX_SOCKET,
      '-f',
      '/store/tmux.conf',
      'new-session',
      '-A',
      '-s',
      `lineage-${SID}`,
      '-c',
      '/code/api',
      '-e',
      `${ENV_NODE_ID}=${SID}`,
      '--',
      '/usr/local/bin/claude',
      '--session-id',
      SID,
    ]);
  });

  it('omits what it was not given — the command still exec-s after --', () => {
    expect(
      buildTmuxArgs({ name: 'lineage-x', command: ['claude', '--resume', SID] }),
    ).toEqual([
      '-L',
      TMUX_SOCKET,
      'new-session',
      '-A',
      '-s',
      'lineage-x',
      '--',
      'claude',
      '--resume',
      SID,
    ]);
  });

  it('is attach-or-create: -A is unconditional, so the restore path can reuse launch', () => {
    const args = buildTmuxArgs({ name: 'lineage-x', command: ['claude'] });
    expect(args).toContain('-A');
  });
});

describe('tmuxNameOfTerminal', () => {
  const wrapped = {
    creationOptions: {
      shellPath: '/opt/homebrew/bin/tmux',
      shellArgs: buildTmuxArgs({
        name: tmuxSessionName(SID),
        command: ['/usr/local/bin/claude', '--session-id', SID],
      }),
    },
  };

  it('round-trips the name through creationOptions (the reload survival path)', () => {
    expect(tmuxNameOfTerminal(wrapped)).toBe(`lineage-${SID}`);
  });

  it('never reads a bare claude launch as a wrap', () => {
    expect(
      tmuxNameOfTerminal({
        creationOptions: {
          shellPath: '/usr/local/bin/claude',
          shellArgs: ['--session-id', SID],
        },
      }),
    ).toBeUndefined();
  });

  it("never reads another program's -s as a session name", () => {
    expect(
      tmuxNameOfTerminal({
        creationOptions: {
          shellPath: '/bin/some-tool',
          shellArgs: ['-s', 'lineage-x'],
        },
      }),
    ).toBeUndefined();
  });

  it('stops at -- : an -s in the wrapped command belongs to claude', () => {
    expect(
      tmuxNameOfTerminal({
        creationOptions: {
          shellPath: '/opt/homebrew/bin/tmux',
          shellArgs: ['-L', 'lineage', 'kill-server', '--', 'x', '-s', 'y'],
        },
      }),
    ).toBeUndefined();
  });

  it('degrades on pty terminals and missing options', () => {
    expect(tmuxNameOfTerminal({ creationOptions: { pty: {} } })).toBeUndefined();
    expect(tmuxNameOfTerminal({})).toBeUndefined();
  });
});

describe('the conf keeps tmux invisible', () => {
  it('silences the chrome that would reveal tmux', () => {
    expect(TMUX_CONF).toContain('status off');
    expect(TMUX_CONF).toContain('set-titles off');
  });

  it("frees the prefix keys — Ctrl+B is claude's, not tmux's", () => {
    expect(TMUX_CONF).toContain('prefix None');
    expect(TMUX_CONF).toContain('prefix2 None');
  });

  it('keeps scrollback reachable (mouse copy-mode) with real history', () => {
    expect(TMUX_CONF).toContain('mouse on');
    expect(TMUX_CONF).toMatch(/history-limit \d{4,}/);
  });

  it("removes every config-dir variable from the server's global environment", () => {
    // NOT a tmux preference — an account fix. The server keeps the environment
    // of the FIRST client that forked it, so the first wrapped session started
    // on a custom account puts that account's CLAUDE_CONFIG_DIR into the
    // global environment and every later session inherits it: a conversation
    // on the default login running against somebody else's config directory,
    // with no verb used and nothing on screen to say so. Measured on 3.6a:
    // with these lines the pane sees the variable UNSET, and a session that
    // passes its own `-e` still wins, because a session value outranks the
    // global.
    expect(TMUX_CONF).toContain('set-environment -gr CLAUDE_CONFIG_DIR');
    expect(TMUX_CONF).toContain('set-environment -gr CODEX_HOME');
    // One line per config-dir variable, derived from the constant the LAUNCHER
    // reads, so a provider that gains one cannot be forgotten here.
    for (const key of Object.values(CONFIG_DIR_ENV)) {
      expect(TMUX_CONF).toContain(`set-environment -gr ${key}`);
    }
    expect(TMUX_CONF.match(/set-environment -gr /g) ?? []).toHaveLength(
      Object.values(CONFIG_DIR_ENV).length,
    );
  });
});

// Exit to the shell (`lineage.exitToShell`). Every claim below was checked
// against tmux 3.6a by hand before it was written down: the hook chain leaves a
// real login shell in the SAME pane at the conversation's own directory, the
// self-disarm is what stops the shell's own exit from respawning another one
// forever, and neither `kill-session` nor `respawn-pane -k` fires `pane-died`
// (so a closed tab still ends the session, and the account-move path is
// untouched).
describe('exit to the shell: the conf block', () => {
  const SH = '/bin/zsh';

  it('adds nothing at all when there is no shell to leave behind', () => {
    expect(renderTmuxConf(null)).toBe(TMUX_CONF);
    expect(renderTmuxConf(undefined)).toBe(TMUX_CONF);
    expect(renderTmuxConf('')).toBe(TMUX_CONF);
  });

  it('keeps the invisibility conf intact and appends to it', () => {
    const conf = renderTmuxConf(SH);
    expect(conf.startsWith(TMUX_CONF)).toBe(true);
  });

  it('arms remain-on-exit, without which pane-died never fires', () => {
    // tmux destroys the pane on process exit unless this is on, and then only
    // `pane-exited` fires — too late to put anything back in it.
    expect(renderTmuxConf(SH)).toContain('set -g remain-on-exit on');
  });

  it('respawns the shell in the same pane, at the conversation\u2019s own path', () => {
    const conf = renderTmuxConf(SH);
    expect(conf).toContain("set-hook -g pane-died 'respawn-pane -k");
    // Same pane means same tmux session, same client, same VS Code tab.
    expect(conf).toContain('-c "#{pane_current_path}"');
    // A LOGIN shell: the point is the user's own prompt, aliases and history.
    expect(conf).toContain(`-- ${SH} -l'`);
  });

  it('disarms itself, so exiting the SHELL really closes the tab', () => {
    // THE load-bearing safety line. Left armed, the hook fires on the shell's
    // own exit too and respawns another one: a tab that cannot be closed from
    // the inside, and a tmux session that outlives every attempt to end it.
    expect(renderTmuxConf(SH)).toContain(
      "set-hook -ga pane-died 'setw remain-on-exit off'",
    );
  });

  it('stamps the pane, which is how Flock tells a shell from a conversation', () => {
    expect(renderTmuxConf(SH)).toContain(
      `set-hook -ga pane-died 'set -p ${TMUX_EXITED_OPTION} 1'`,
    );
  });

  it('appends the hooks with -ga, or each would replace the last', () => {
    const conf = renderTmuxConf(SH);
    expect(conf.match(/set-hook -g pane-died/g)).toHaveLength(1);
    expect(conf.match(/set-hook -ga pane-died/g)).toHaveLength(2);
  });

  it('refuses a shell path that could break out of the hook string', () => {
    // The path lands inside a SINGLE-QUOTED tmux hook command. A quote would
    // end the string early and the rest of the line would parse as tmux
    // commands; whitespace splits it; `#` opens a comment and `;` a command.
    // None of these occurs in a real shell path, so the conf falls back to
    // having no block at all rather than to a conf we did not write.
    for (const bad of [
      "/bin/z'sh",
      '/bin/z sh',
      '/bin/zsh;kill-server',
      '/bin/zsh#x',
      '/bin/z"sh',
      '/bin/z\\sh',
      'zsh', // not absolute
    ]) {
      expect(renderTmuxConf(bad), bad).toBe(TMUX_CONF);
    }
  });
});

describe('resolveExitShell', () => {
  it('prefers $SHELL — the user\u2019s prompt, aliases and history', () => {
    expect(resolveExitShell('/opt/homebrew/bin/fish', 'darwin')).toBe(
      '/opt/homebrew/bin/fish',
    );
  });

  it('falls back to the platform default rather than failing a launch', () => {
    expect(resolveExitShell(undefined, 'darwin')).toBe('/bin/zsh');
    expect(resolveExitShell(undefined, 'linux')).toBe('/bin/bash');
    expect(resolveExitShell('', 'linux')).toBe('/bin/bash');
    // Relative, or carrying something that cannot survive the conf: the
    // default is what the pty would have used anyway.
    expect(resolveExitShell('zsh', 'darwin')).toBe('/bin/zsh');
    expect(resolveExitShell("/bin/z'sh", 'darwin')).toBe('/bin/zsh');
  });

  it('is null on Windows, where the whole detach tier is absent', () => {
    expect(resolveExitShell('C:\\Windows\\system32\\cmd.exe', 'win32')).toBeNull();
    expect(resolveExitShell(undefined, 'win32')).toBeNull();
  });
});

describe('parseWrapState', () => {
  it('tells a live conversation from a shell left by /exit', () => {
    // Both answer a pane pid, which is why the old `queryPanePid !== undefined`
    // probe read a shell as a session to attach to — and why resume would have
    // dropped the user at their own prompt and called it a reopened session.
    expect(parseWrapState('61862 \n')).toBe('running');
    expect(parseWrapState('61862 1\n')).toBe('exited');
  });

  it('reads an unset option as running — every pre-feature wrap', () => {
    // An unset user option formats as the empty string, so a wrap launched
    // before exit-to-shell existed, or with it off, must read as what it is.
    expect(parseWrapState('61862\n')).toBe('running');
  });

  it('is gone for no server, no session, and anything unparseable', () => {
    expect(parseWrapState('')).toBe('gone');
    expect(parseWrapState('\n\n')).toBe('gone');
    expect(parseWrapState("can't find session\n")).toBe('gone');
    expect(parseWrapState('0 1\n')).toBe('gone');
    expect(parseWrapState('-3\n')).toBe('gone');
  });

  it('claims nothing about a session with more than one pane', () => {
    // Same rule as parsePanePid: a wrap is built around a single command, so
    // two panes means this is not ours.
    expect(parseWrapState('61862 1\n61863 1\n')).toBe('gone');
  });
});

describe('buildClearExitedArgs', () => {
  it('unsets the stamp on the PANE, using the pane target form', () => {
    expect(buildClearExitedArgs('lineage-abc')).toEqual([
      '-L', 'lineage', 'set', '-p', '-t', '=lineage-abc:', '-u',
      TMUX_EXITED_OPTION,
    ]);
  });
});

describe('ensureTmuxConf', () => {
  it('writes the conf and is idempotent', () => {
    const dir = tempDir();
    const p = ensureTmuxConf(dir);
    expect(p).toBe(path.join(dir, 'tmux.conf'));
    expect(fs.readFileSync(p as string, 'utf8')).toBe(TMUX_CONF);
    expect(ensureTmuxConf(dir)).toBe(p);
  });

  it('overwrites a stale conf — edits do not survive, as the header warns', () => {
    const dir = tempDir();
    const p = path.join(dir, 'tmux.conf');
    fs.writeFileSync(p, 'set -g status on\n');
    ensureTmuxConf(dir);
    expect(fs.readFileSync(p, 'utf8')).toBe(TMUX_CONF);
  });

  it('degrades to undefined when the dir cannot exist', () => {
    expect(ensureTmuxConf('/dev/null/nope')).toBeUndefined();
  });

  it('writes the exit-to-shell block when one is asked for', () => {
    const dir = tempDir();
    const p = ensureTmuxConf(dir, '/bin/zsh') as string;
    expect(fs.readFileSync(p, 'utf8')).toBe(renderTmuxConf('/bin/zsh'));
  });

  it('rewrites the file when the setting is flipped, either way', () => {
    // The flip IS a file rewrite — the hooks live in the conf, not in the
    // launch argv. tmux reads the conf at SERVER start, so the rewrite is what
    // makes the next server agree with the setting.
    const dir = tempDir();
    const p = ensureTmuxConf(dir, '/bin/zsh') as string;
    expect(fs.readFileSync(p, 'utf8')).toContain('remain-on-exit on');
    ensureTmuxConf(dir, null);
    expect(fs.readFileSync(p, 'utf8')).toBe(TMUX_CONF);
    ensureTmuxConf(dir, '/bin/bash');
    expect(fs.readFileSync(p, 'utf8')).toContain('/bin/bash -l');
  });
});

describe('parsePanePid', () => {
  it('reads exactly one positive integer', () => {
    expect(parsePanePid('61862\n')).toBe(61862);
    expect(parsePanePid('  4242  \n')).toBe(4242);
  });

  it('claims nothing for anything else', () => {
    // Two panes means the session is not the single-command wrap we made.
    expect(parsePanePid('61862\n61863\n')).toBeUndefined();
    expect(parsePanePid('')).toBeUndefined();
    expect(parsePanePid('nope\n')).toBeUndefined();
    expect(parsePanePid('-5\n')).toBeUndefined();
    expect(parsePanePid('12.5\n')).toBeUndefined();
  });
});

describe('client → session mapping (the app-restart identity source)', () => {
  it('parses list-clients output into pid → name', () => {
    expect(parseClientSessions(`61854 lineage-${SID}\n6598 other\n`)).toEqual(
      new Map([
        [61854, `lineage-${SID}`],
        [6598, 'other'],
      ]),
    );
  });

  it('skips junk lines rather than failing the sweep', () => {
    expect(parseClientSessions('\nnope\n-3 x\n12\n0 name\n')).toEqual(
      new Map(),
    );
  });

  it('sessionIdOfTmuxName inverts tmuxSessionName and refuses strangers', () => {
    expect(sessionIdOfTmuxName(tmuxSessionName(SID))).toBe(SID);
    // A user's own tmux session — or any name we did not mint — claims no id.
    expect(sessionIdOfTmuxName('lineage-not-a-uuid')).toBeUndefined();
    expect(sessionIdOfTmuxName('my-own-session')).toBeUndefined();
    expect(sessionIdOfTmuxName('')).toBeUndefined();
  });
});

describe('findTmuxBinary / resolveTmuxSpawn', () => {
  it('finds tmux on PATH', function () {
    if (process.platform === 'win32') return; // the helper itself refuses win32
    const dir = tempDir();
    const bin = path.join(dir, 'tmux');
    fs.writeFileSync(bin, '#!/bin/sh\n');
    process.env['PATH'] = dir;
    expect(findTmuxBinary()).toBe(bin);
    expect(resolveTmuxSpawn('auto', '/store/tmux.conf')).toEqual({
      binary: bin,
      confPath: '/store/tmux.conf',
    });
    expect(resolveTmuxSpawn(undefined, undefined)).toEqual({ binary: bin });
  });

  it('yields null with no tmux anywhere — the kill tier, not an error', () => {
    process.env['PATH'] = tempDir();
    expect(findTmuxBinary()).toBeNull();
    expect(resolveTmuxSpawn('auto', undefined)).toBeNull();
  });

  it("respects 'off' without even probing the PATH", () => {
    process.env['PATH'] = '';
    expect(resolveTmuxSpawn('off', '/store/tmux.conf')).toBeNull();
  });
});

// The nudge matrix. This is the whole reason tmuxAdvice() is pure: the tier is
// INVISIBLE when it is absent — parking still works, it just kills and resumes
// instead of detaching — so the only thing standing between a user and a lost
// in-flight turn is whether this function speaks up at the right moment.
describe('tmuxAdvice', () => {
  const base = {
    platform: 'darwin',
    mode: 'auto' as string | undefined,
    binary: null as string | null,
    dismissed: false,
  };

  it('advises installing when the tier is unavailable and unconfigured', () => {
    expect(tmuxAdvice(base)).toBe('install');
  });

  it('says nothing once tmux is on the PATH — auto already used it', () => {
    expect(tmuxAdvice({ ...base, binary: '/opt/homebrew/bin/tmux' })).toBe('none');
  });

  it("advises enabling when tmux exists but the gate was switched off", () => {
    expect(tmuxAdvice({ ...base, mode: 'off', binary: '/usr/bin/tmux' })).toBe('enable');
  });

  it("stays quiet when off AND absent — two fixes in one toast is worse than none", () => {
    expect(tmuxAdvice({ ...base, mode: 'off', binary: null })).toBe('none');
  });

  it('never speaks on Windows, where the tier does not exist', () => {
    expect(tmuxAdvice({ ...base, platform: 'win32' })).toBe('none');
  });

  it('no longer depends on the workspace switcher being on', () => {
    // It used to return 'none' whenever `lineage.workspaces.enabled` was false,
    // on the grounds that workspace parking was the only feature the detach
    // tier served. That stopped being true: solo mode parks in every window
    // model and the detach grace runs at every level, so a machine with the
    // switcher off still detaches sessions and still loses in-flight turns
    // without tmux. The input is gone; the advice is the same whatever model
    // this window is in.
    expect(tmuxAdvice(base)).toBe('install');
    expect(tmuxAdvice({ ...base, mode: 'off', binary: '/usr/bin/tmux' })).toBe(
      'enable',
    );
  });

  it('is asked once per install, not on a timer', () => {
    expect(tmuxAdvice({ ...base, dismissed: true })).toBe('none');
    expect(tmuxAdvice({ ...base, mode: 'off', binary: '/usr/bin/tmux', dismissed: true })).toBe(
      'none',
    );
  });

  it('hints the package manager, and nothing at all where it cannot help', () => {
    expect(tmuxInstallHint('darwin')).toBe('brew install tmux');
    expect(tmuxInstallHint('linux')).toBe('sudo apt install tmux');
    expect(tmuxInstallHint('win32')).toBeUndefined();
  });
});

describe('buildRespawnArgs', () => {
  const argv = (over: Record<string, unknown> = {}): string[] =>
    buildRespawnArgs({
      name: 'lineage-abc',
      command: ['/bin/claude', '--resume', 'abc'],
      ...over,
    } as Parameters<typeof buildRespawnArgs>[0]);

  it('targets a PANE, which needs the trailing colon', () => {
    // Verified against tmux 3.6a: a bare `=name` is a SESSION target and
    // respawn-pane answers "can't find pane". Every session-targeting command
    // in the module uses the bare form, so this is the one place they differ
    // and the one place it is easy to get wrong.
    expect(argv()).toContain('=lineage-abc:');
    expect(argv()).not.toContain('=lineage-abc');
  });

  it('keeps the exact-match "=" that stops tmux prefix-matching a name', () => {
    const target = argv()[argv().indexOf('-t') + 1];
    expect(target.startsWith('=')).toBe(true);
  });

  it('kills what is in the pane, so the session cannot die between the two', () => {
    // -k is what makes kill-and-launch one operation. Without it tmux refuses
    // a pane that still has a process, and with a separate kill the pane would
    // empty and take the session (and the tab) with it.
    expect(argv()).toContain('-k');
  });

  it('runs on our own socket', () => {
    expect(argv().slice(0, 2)).toEqual(['-L', 'lineage']);
  });

  it('passes each environment entry as its own -e KEY=VALUE', () => {
    const out = argv({ env: { CLAUDE_CONFIG_DIR: '/home/p', LINEAGE_NODE_ID: 'abc' } });
    expect(out).toContain('CLAUDE_CONFIG_DIR=/home/p');
    expect(out).toContain('LINEAGE_NODE_ID=abc');
    expect(out.filter((a) => a === '-e')).toHaveLength(2);
  });

  it('puts the command last, after --', () => {
    const out = argv();
    expect(out.slice(-4)).toEqual(['--', '/bin/claude', '--resume', 'abc']);
  });

  it('omits -c entirely when there is no cwd', () => {
    expect(argv()).not.toContain('-c');
    expect(argv({ cwd: '/work' })).toContain('-c');
  });
});

describe('buildSetEnvArgs', () => {
  it('rewrites the SESSION environment, which -e on the respawn does not', () => {
    // The launch wrote CLAUDE_CONFIG_DIR into the session with `new-session
    // -e`, and a respawn's -e only reaches the new process — confirmed with
    // show-environment, which still reported the old value afterwards.
    expect(buildSetEnvArgs('lineage-abc', 'CLAUDE_CONFIG_DIR', '/home/p')).toEqual([
      '-L', 'lineage', 'set-environment', '-t', '=lineage-abc',
      'CLAUDE_CONFIG_DIR', '/home/p',
    ]);
  });
});

describe('buildRemoveEnvArgs', () => {
  it('uses -r, which shadows the global, and never -u, which does not', () => {
    // MEASURED on tmux 3.6a, not read off a manual page, because the two look
    // interchangeable and are not: our private server keeps the environment of
    // the FIRST client that forked it, so a CLAUDE_CONFIG_DIR that leaked in
    // that way is still visible through the global environment after `-u`
    // deletes the session's own entry. `-r` marks the name removed for the
    // session and shadows the global. `-e KEY=` is not a third option: that
    // sets the empty string, which is a config dir at the filesystem root.
    expect(buildRemoveEnvArgs('lineage-abc', 'CLAUDE_CONFIG_DIR')).toEqual([
      '-L', 'lineage', 'set-environment', '-t', '=lineage-abc',
      '-r', 'CLAUDE_CONFIG_DIR',
    ]);
  });
});

describe('respawnCommands', () => {
  it('runs the removals BEFORE the respawn and the sets after it', () => {
    // THE ORDER IS NOT COSMETIC. `respawn-pane` snapshots the environment the
    // new process gets at the moment it spawns (measured on 3.6a), so a
    // removal issued afterwards corrects the session's records about a process
    // that has already launched on the wrong account — which is exactly the
    // bug: `-e` can only SET, so moving a wrapped conversation back to the
    // default login left the previous account's config dir in place and the
    // resumed CLI read the account the transcript had just left.
    const cmds = respawnCommands({
      name: 'lineage-abc',
      env: { LINEAGE_NODE_ID: 'a' },
      remove: ['CLAUDE_CONFIG_DIR'],
      command: ['/bin/claude', '--resume', 'a'],
    });
    expect(cmds).toHaveLength(4);
    expect(cmds[0]).toEqual(buildRemoveEnvArgs('lineage-abc', 'CLAUDE_CONFIG_DIR'));
    expect(cmds[1]).toContain('respawn-pane');
    expect(cmds[2]).toEqual(buildClearExitedArgs('lineage-abc'));
    expect(cmds[3]).toEqual(
      buildSetEnvArgs('lineage-abc', 'LINEAGE_NODE_ID', 'a'),
    );
  });

  it('clears the exit stamp immediately after the respawn', () => {
    // The stamp is a PANE option, so it outlives the process it described. A
    // respawn that left it standing would make a live conversation read as
    // `exited` for good — and the resume verb, which believes that answer,
    // would kill and relaunch something running perfectly well. It rides in
    // this list rather than in the caller so the ORDER is what gets tested:
    // before the respawn it would stamp a pane that is about to be replaced.
    const cmds = respawnCommands({
      name: 'lineage-abc',
      command: ['/bin/claude'],
    });
    const at = cmds.findIndex((c) => c.includes('respawn-pane'));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(cmds[at + 1]).toEqual(buildClearExitedArgs('lineage-abc'));
  });

  it('does not remove a variable it is about to set', () => {
    // So a caller can hand over a blunt "everything any account on this roster
    // could set" list without having to subtract the destination's own keys.
    const cmds = respawnCommands({
      name: 'lineage-abc',
      env: { CLAUDE_CONFIG_DIR: '/b' },
      remove: ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'],
      command: ['/bin/claude'],
    });
    expect(cmds[0]).toEqual(buildRemoveEnvArgs('lineage-abc', 'CODEX_HOME'));
    expect(cmds[1]).toContain('respawn-pane');
    expect(cmds.filter((c) => c.includes('-r'))).toHaveLength(1);
  });

  it('is the respawn, the unstamp, and the sets when nothing is removed', () => {
    const opts = {
      name: 'lineage-abc',
      env: { LINEAGE_NODE_ID: 'a' },
      command: ['/bin/claude'],
    };
    expect(respawnCommands(opts)).toEqual([
      buildRespawnArgs(opts),
      buildClearExitedArgs('lineage-abc'),
      buildSetEnvArgs('lineage-abc', 'LINEAGE_NODE_ID', 'a'),
    ]);
  });
});

describe('parseTmuxSessions', () => {
  it('reads one name per line and skips blanks', () => {
    expect(parseTmuxSessions('lineage-a\n\nlineage-b\n')).toEqual([
      'lineage-a',
      'lineage-b',
    ]);
    expect(parseTmuxSessions('')).toEqual([]);
  });
});

describe('killTmuxSessionTree', () => {
  // The composition contract, with every side injected: WALK before the kill
  // (a dead root's children have re-parented to PID 1 and can never be found
  // again), then kill-session, then reap root + descendants by pid.
  function fakes(over: {
    panePid?: number | undefined;
    killOk?: boolean;
  } = {}) {
    const calls: string[] = [];
    let reaped: readonly number[] = [];
    const deps = {
      panePid: async () => {
        calls.push('walk-pid');
        return 'panePid' in over ? over.panePid : 100;
      },
      listDescendants: async (root: number) => {
        calls.push(`walk-tree:${root}`);
        return [101, 102];
      },
      killSession: async () => {
        calls.push('kill-session');
        return over.killOk ?? true;
      },
      reapSurvivors: async (pids: readonly number[]) => {
        calls.push('reap');
        reaped = pids;
        return { exited: pids.length, termed: 0, killed: 0 };
      },
    };
    return { calls, deps, reaped: () => reaped };
  }

  it('walks BEFORE the kill and reaps root plus descendants, by pid', async () => {
    const f = fakes();
    await expect(
      killTmuxSessionTree('/usr/bin/tmux', 'lineage-abc', f.deps),
    ).resolves.toBe(true);
    // The reap lands on a microtask behind the kill (fire-and-forget).
    await new Promise((r) => setTimeout(r, 0));
    expect(f.calls).toEqual(['walk-pid', 'walk-tree:100', 'kill-session', 'reap']);
    expect(f.reaped()).toEqual([100, 101, 102]);
  });

  it('a failed kill reaps NOTHING — no walk result is licence without a kill', async () => {
    const f = fakes({ killOk: false });
    await expect(
      killTmuxSessionTree('/usr/bin/tmux', 'lineage-abc', f.deps),
    ).resolves.toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(f.calls).toEqual(['walk-pid', 'walk-tree:100', 'kill-session']);
  });

  it('no pane pid (session already gone) still kills, but signals nobody', async () => {
    const f = fakes({ panePid: undefined });
    await killTmuxSessionTree('/usr/bin/tmux', 'lineage-abc', f.deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(f.calls).toEqual(['walk-pid', 'kill-session']);
  });
});
