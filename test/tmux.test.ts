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
  TMUX_SOCKET,
  buildTmuxArgs,
  ensureTmuxConf,
  findTmuxBinary,
  parseClientSessions,
  parsePanePid,
  resolveTmuxSpawn,
  sessionIdOfTmuxName,
  tmuxNameOfTerminal,
  tmuxSessionName,
} from '../src/tmux';
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
