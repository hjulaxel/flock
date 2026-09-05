// test/codex.test.ts — the Codex CLI contract.
//
// What is worth asserting here, and what is not. The argv builder and the id
// matcher are PURE decisions with real consequences — a wrong flag is a launch
// that dies in a pty, and a wrong match is one conversation's row pointing at
// another conversation's transcript — so they get the bulk of the file. The
// filesystem walkers get enough to prove they are bounded and do not throw,
// driven against a temp directory shaped like a real `$CODEX_HOME/sessions`
// tree rather than against a mock, because the shape IS the contract.
//
// Every flag asserted below was verified against `codex-cli 0.139.0`:
//
//   codex [--cd DIR] [--add-dir DIR]... [PROMPT]
//   codex resume <SESSION_ID> [--cd DIR] [--add-dir DIR]... [PROMPT]
//   codex fork   <SESSION_ID> [--cd DIR] [--add-dir DIR]... [PROMPT]

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DEFAULT_MATCH_WINDOW_MS,
  buildCodexArgs,
  codexAuthPath,
  codexSessionsDir,
  extractJsonString,
  findCodexBinary,
  codexFallbackBinDirs,
  matchRollout,
  readRolloutMeta,
  scanRollouts,
  sessionIdOfRollout,
} from '../src/codex';
import type { RolloutMeta } from '../src/codex';
import type { LaunchOptions } from '../src/types';

const ID_A = '019ff30e-c6bd-79d1-83c9-800e9a651496';
const ID_B = '019ff316-1ef6-7d33-935f-c37a948a410d';

function opts(over: Partial<LaunchOptions> = {}): LaunchOptions {
  return { sessionId: ID_A, ...over };
}

// ------------------------------------------------------------------- argv

describe('buildCodexArgs: the three launch forms', () => {
  it('a new session is a bare invocation — no subcommand at all', () => {
    expect(buildCodexArgs(opts())).toEqual([]);
  });

  it('never emits --session-id: codex has no such flag and mints its own', () => {
    // The whole reason adoptCodexSession exists. If this ever starts failing
    // because the flag was added upstream, the id discovery can be deleted.
    expect(buildCodexArgs(opts()).join(' ')).not.toContain('--session-id');
  });

  it('a resume is `resume <id>`', () => {
    expect(buildCodexArgs(opts({ resumeId: ID_B }))).toEqual(['resume', ID_B]);
  });

  it('a fork is `fork <parent>`', () => {
    expect(buildCodexArgs(opts({ parentId: ID_B }))).toEqual(['fork', ID_B]);
  });

  it('resume WINS over fork when a caller somehow sets both', () => {
    // Same rule buildShellArgs keeps: resuming into a fork would be a silent,
    // data-losing surprise, so the narrower intent is honoured.
    const args = buildCodexArgs(opts({ resumeId: ID_A, parentId: ID_B }));
    expect(args).toEqual(['resume', ID_A]);
    expect(args).not.toContain('fork');
  });

  it('empty-string ids are absent ids, not launch forms', () => {
    expect(buildCodexArgs(opts({ resumeId: '', parentId: '' }))).toEqual([]);
  });
});

describe('buildCodexArgs: flags and ordering', () => {
  it('passes the cwd as --cd, so the rollout header records what we match on', () => {
    expect(buildCodexArgs(opts({ cwd: '/code/api' }))).toEqual([
      '--cd',
      '/code/api',
    ]);
  });

  it('repeats --add-dir once per directory — codex takes ONE dir per flag', () => {
    // The contrast with the Claude CLI, whose --add-dir is variadic. Getting
    // this wrong would hand codex a second directory as a positional prompt.
    expect(buildCodexArgs(opts({ addDirs: ['/a', '/b'] }))).toEqual([
      '--add-dir',
      '/a',
      '--add-dir',
      '/b',
    ]);
  });

  it('drops blank directories rather than passing an empty argument', () => {
    expect(buildCodexArgs(opts({ addDirs: ['', '   ', '/real'] }))).toEqual([
      '--add-dir',
      '/real',
    ]);
  });

  it('the prompt is LAST, after every flag', () => {
    const args = buildCodexArgs(
      opts({ resumeId: ID_B, cwd: '/w', addDirs: ['/x'], prompt: 'go' }),
    );
    expect(args).toEqual([
      'resume',
      ID_B,
      '--cd',
      '/w',
      '--add-dir',
      '/x',
      'go',
    ]);
    expect(args[args.length - 1]).toBe('go');
  });

  it('the id sits flush against its subcommand, out of reach of any flag', () => {
    const args = buildCodexArgs(opts({ parentId: ID_B, addDirs: ['/x'] }));
    expect(args[0]).toBe('fork');
    expect(args[1]).toBe(ID_B);
  });
});

describe('buildCodexArgs: what codex cannot do natively', () => {
  it('folds appendSystemPrompt into the opening prompt, ahead of the user text', () => {
    // Codex has no --append-system-prompt. Dropping it would leave a project
    // chat with no idea what project it is about; folding it in is visible in
    // the transcript, which is the honest trade.
    const args = buildCodexArgs(
      opts({ appendSystemPrompt: 'You are in project API.', prompt: 'hello' }),
    );
    expect(args).toEqual(['You are in project API.\n\nhello']);
  });

  it('carries appendSystemPrompt alone when there is no user prompt', () => {
    expect(buildCodexArgs(opts({ appendSystemPrompt: 'context' }))).toEqual([
      'context',
    ]);
  });

  it('emits nothing when both are blank', () => {
    expect(buildCodexArgs(opts({ appendSystemPrompt: '  ', prompt: '' }))).toEqual(
      [],
    );
  });

  it('DROPS sessionName — codex has no start-time naming flag', () => {
    const args = buildCodexArgs(opts({ sessionName: 'my session' }));
    expect(args).toEqual([]);
    expect(args).not.toContain('--name');
  });
});

// -------------------------------------------------------------- rollout names

describe('sessionIdOfRollout', () => {
  it('reads the id out of a real rollout basename', () => {
    expect(
      sessionIdOfRollout(`rollout-2026-08-12T01-00-59-${ID_A}.jsonl`),
    ).toBe(ID_A);
  });

  it('accepts UUIDv7, which is what codex actually mints', () => {
    // SESSION_ID_RE is version-agnostic on purpose; this is the test that says
    // so out loud, because a version-pinned regex would reject every codex id.
    expect(ID_A[14]).toBe('7');
    expect(sessionIdOfRollout(`rollout-2026-01-01T00-00-00-${ID_A}.jsonl`)).toBe(
      ID_A,
    );
  });

  it('rejects anything that is not a rollout', () => {
    for (const name of [
      'history.jsonl',
      `${ID_A}.jsonl`,
      `rollout-${ID_A}.jsonl`,
      `rollout-2026-08-12T01-00-59-${ID_A}.json`,
      'rollout-2026-08-12T01-00-59-not-a-uuid.jsonl',
      '',
      undefined,
      null,
      42,
    ]) {
      expect(sessionIdOfRollout(name)).toBeNull();
    }
  });
});

// --------------------------------------------------------------- head parsing

describe('extractJsonString: reading a TRUNCATED json prefix', () => {
  // JSON.parse is not an option: a rollout's first line embeds the entire
  // system prompt and runs to tens of kilobytes, so any bounded head read
  // yields a valid JSON PREFIX and never a valid document.
  it('pulls a value out of a line that never closes', () => {
    const text = '{"type":"session_meta","payload":{"cwd":"/code/api","base":"aaaa';
    expect(extractJsonString(text, 'cwd')).toBe('/code/api');
  });

  it('unescapes properly — a regex pretending to would get this wrong', () => {
    const text = String.raw`{"cwd":"C:\\Users\\ax\"el","x":1`;
    expect(extractJsonString(text, 'cwd')).toBe('C:\\Users\\ax"el');
  });

  it('returns undefined for an absent key', () => {
    expect(extractJsonString('{"a":"b"}', 'cwd')).toBeUndefined();
  });

  it('returns undefined when the value runs past the window — half a path is not a path', () => {
    expect(extractJsonString('{"cwd":"/code/ap', 'cwd')).toBeUndefined();
  });

  it('returns undefined for an empty value rather than an empty string', () => {
    expect(extractJsonString('{"cwd":""}', 'cwd')).toBeUndefined();
  });
});

// ------------------------------------------------------------------ the store

describe('the rollout store on disk', () => {
  let root: string;

  /** Write a rollout with a real `session_meta` first line, in the
   *  `sessions/YYYY/MM/DD/` tree codex actually uses. */
  function writeRollout(
    day: string,
    id: string,
    meta: { cwd?: string; timestamp?: string } = {},
  ): string {
    const [y, m, d] = day.split('-');
    const dir = path.join(root, 'sessions', y, m, d);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-${day}T01-00-00-${id}.jsonl`);
    const payload = {
      session_id: id,
      cwd: meta.cwd ?? '/code/api',
      // A stand-in for the tens of kilobytes of system prompt a real rollout
      // carries here — the reason the head parser cannot use JSON.parse.
      base_instructions: { text: 'x'.repeat(40_000) },
    };
    fs.writeFileSync(
      file,
      `${JSON.stringify({
        timestamp: meta.timestamp ?? '2026-08-12T01:00:00.000Z',
        type: 'session_meta',
        payload,
      })}\n`,
    );
    return file;
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-codex-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('readRolloutMeta takes the id from the NAME and the facts from the head', () => {
    const file = writeRollout('2026-08-12', ID_A, {
      cwd: '/code/api',
      timestamp: '2026-08-12T01:00:00.000Z',
    });
    const meta = readRolloutMeta(file);
    expect(meta?.sessionId).toBe(ID_A);
    expect(meta?.cwd).toBe('/code/api');
    expect(meta?.startedAt).toBe(Date.parse('2026-08-12T01:00:00.000Z'));
    expect(meta?.bytes).toBeGreaterThan(40_000);
  });

  it('readRolloutMeta survives a head far larger than its read window', () => {
    // The 40 KB of base_instructions above sits past the bounded read; cwd and
    // timestamp sit before it. Both facts must still come back.
    const file = writeRollout('2026-08-12', ID_A);
    expect(readRolloutMeta(file)?.cwd).toBe('/code/api');
  });

  it('readRolloutMeta returns null for a file that is not a rollout, and never throws', () => {
    const notOne = path.join(root, 'history.jsonl');
    fs.writeFileSync(notOne, '{}');
    expect(readRolloutMeta(notOne)).toBeNull();
    expect(readRolloutMeta(path.join(root, 'nope.jsonl'))).toBeNull();
  });

  it('scanRollouts walks the YYYY/MM/DD tree', () => {
    writeRollout('2026-08-12', ID_A);
    writeRollout('2026-08-12', ID_B);
    const found = scanRollouts({
      sessionsDirs: [path.join(root, 'sessions')],
      maxAgeDays: 100_000,
    });
    expect(found.map((f) => f.sessionId).sort()).toEqual([ID_A, ID_B].sort());
  });

  it('scanRollouts bounds by day-directory age before reading anything inside', () => {
    writeRollout('1999-01-01', ID_A);
    const found = scanRollouts({
      sessionsDirs: [path.join(root, 'sessions')],
      maxAgeDays: 30,
    });
    expect(found).toEqual([]);
  });

  it('scanRollouts honours its file limit', () => {
    writeRollout('2026-08-12', ID_A);
    writeRollout('2026-08-12', ID_B);
    expect(
      scanRollouts({
        sessionsDirs: [path.join(root, 'sessions')],
        maxAgeDays: 100_000,
        limit: 1,
      }),
    ).toHaveLength(1);
  });

  it('scanRollouts returns [] for a store that does not exist, rather than throwing', () => {
    expect(scanRollouts({ sessionsDirs: [path.join(root, 'nope')] })).toEqual([]);
  });

  it('scanRollouts yields one row per id even when two stores hold the same file', () => {
    writeRollout('2026-08-12', ID_A);
    const dir = path.join(root, 'sessions');
    expect(
      scanRollouts({ sessionsDirs: [dir, dir], maxAgeDays: 100_000 }),
    ).toHaveLength(1);
  });
});

describe('store paths', () => {
  it('codexSessionsDir and codexAuthPath hang off the given home', () => {
    expect(codexSessionsDir('/tmp/ch')).toBe(path.join('/tmp/ch', 'sessions'));
    expect(codexAuthPath('/tmp/ch')).toBe(path.join('/tmp/ch', 'auth.json'));
  });

  it('a blank home falls back to ~/.codex rather than to a relative path', () => {
    expect(path.isAbsolute(codexSessionsDir('   '))).toBe(true);
    expect(codexSessionsDir('')).toContain('.codex');
  });
});

describe('findCodexBinary', () => {
  it('returns a configured path verbatim, with no existence check', () => {
    // Same contract findClaudeBinary keeps: the user knows where their CLI is,
    // and an over-eager stat would reject a shim we cannot see through.
    expect(findCodexBinary('/opt/weird/codex')).toBe('/opt/weird/codex');
  });

  it('ignores a blank configured value and goes looking', () => {
    // Only asserts that blank is not treated as a path; whether this machine
    // HAS codex is not this test's business.
    const found = findCodexBinary('   ');
    expect(found === null || path.isAbsolute(found)).toBe(true);
  });

  it('knows where each platform’s installers put the CLI', () => {
    // Pure, so the Windows answer is testable from anywhere. The POSIX list
    // also carries every nvm version, newest first, when ~/.nvm exists — this
    // fake home has none, so only the fixed roots remain.
    expect(
      codexFallbackBinDirs({
        platform: 'win32',
        env: { APPDATA: 'C:\\Users\\a\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' },
        home: 'C:\\Users\\a',
      }),
    ).toEqual([
      path.join('C:\\Users\\a', '.codex', 'bin'),
      path.join('C:\\Users\\a\\AppData\\Roaming', 'npm'),
      path.join('C:\\Users\\a\\AppData\\Local', 'Microsoft', 'WinGet', 'Links'),
    ]);
    expect(codexFallbackBinDirs({ platform: 'linux', env: {}, home: '/home/a' })).toEqual([
      '/home/a/.codex/bin',
      '/home/a/.local/bin',
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ]);
  });
});

// ------------------------------------------------------------- id discovery

describe('matchRollout: which rollout did this launch produce', () => {
  const T = 1_000_000_000_000;
  function meta(over: Partial<RolloutMeta> & { sessionId: string }): RolloutMeta {
    return {
      path: `/s/${over.sessionId}.jsonl`,
      endedAt: T,
      bytes: 1,
      cwd: '/code/api',
      startedAt: T + 500,
      ...over,
    };
  }

  it('matches a rollout born just after the spawn, in the same directory', () => {
    const hit = matchRollout([meta({ sessionId: ID_A })], {
      spawnedAt: T,
      cwd: '/code/api',
    });
    expect(hit?.sessionId).toBe(ID_A);
  });

  it('refuses one born BEFORE the spawn — that is somebody else‘s session', () => {
    const hit = matchRollout(
      [meta({ sessionId: ID_A, startedAt: T - 60_000 })],
      { spawnedAt: T, cwd: '/code/api' },
    );
    expect(hit).toBeNull();
  });

  it('allows a second of clock skew, because codex stamps from its own clock', () => {
    // An exact `>=` against our pre-spawn reading would reject the very file
    // we are looking for whenever the two clocks disagree by a hair.
    const hit = matchRollout([meta({ sessionId: ID_A, startedAt: T - 400 })], {
      spawnedAt: T,
      cwd: '/code/api',
    });
    expect(hit?.sessionId).toBe(ID_A);
  });

  it('refuses one born after the belief window closes', () => {
    const hit = matchRollout(
      [meta({ sessionId: ID_A, startedAt: T + DEFAULT_MATCH_WINDOW_MS + 1 })],
      { spawnedAt: T, cwd: '/code/api' },
    );
    expect(hit).toBeNull();
  });

  it('refuses a different directory', () => {
    const hit = matchRollout([meta({ sessionId: ID_A, cwd: '/elsewhere' })], {
      spawnedAt: T,
      cwd: '/code/api',
    });
    expect(hit).toBeNull();
  });

  it('refuses an id another row already claimed, however well it matches', () => {
    const hit = matchRollout([meta({ sessionId: ID_A })], {
      spawnedAt: T,
      cwd: '/code/api',
      taken: new Set([ID_A]),
    });
    expect(hit).toBeNull();
  });

  it('takes the EARLIEST survivor — our launch happened first', () => {
    // If a second codex session appeared in the same directory while we were
    // still waiting, the older file is ours and the newer one is theirs.
    const hit = matchRollout(
      [
        meta({ sessionId: ID_B, startedAt: T + 3000 }),
        meta({ sessionId: ID_A, startedAt: T + 100 }),
      ],
      { spawnedAt: T, cwd: '/code/api' },
    );
    expect(hit?.sessionId).toBe(ID_A);
  });

  it('skips a candidate with no start time at all', () => {
    const hit = matchRollout(
      [meta({ sessionId: ID_A, startedAt: undefined })],
      { spawnedAt: T, cwd: '/code/api' },
    );
    expect(hit).toBeNull();
  });

  it('a launch with no known cwd skips the directory clause instead of matching everything', () => {
    const hit = matchRollout([meta({ sessionId: ID_A, cwd: '/anywhere' })], {
      spawnedAt: T,
    });
    expect(hit?.sessionId).toBe(ID_A);
  });

  it('a CANDIDATE with no cwd is refused when the launch has one', () => {
    // The launch knows where it started; a rollout that cannot say where it
    // did is not evidence of anything.
    const hit = matchRollout([meta({ sessionId: ID_A, cwd: undefined })], {
      spawnedAt: T,
      cwd: '/code/api',
    });
    expect(hit).toBeNull();
  });

  it('returns null for an empty candidate list — "not yet", never "no session"', () => {
    expect(matchRollout([], { spawnedAt: T, cwd: '/code/api' })).toBeNull();
  });
});
