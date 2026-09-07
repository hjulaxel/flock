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
  codexRowIds,
  codexSessionsDir,
  extractJsonString,
  findCodexBinary,
  codexFallbackBinDirs,
  matchRollout,
  readRolloutMeta,
  scanRollouts,
  sessionIdOfRollout,
} from '../src/codex';
import type { CodexRowFacts, RolloutMeta } from '../src/codex';
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

  it('the prompt is LAST, after every flag, behind the terminator', () => {
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
      '--',
      'go',
    ]);
    expect(args[args.length - 1]).toBe('go');
  });

  it('a prompt that starts with - is a prompt, not an option', () => {
    // clap stops option parsing at `--`, the same way Commander does for the
    // Claude CLI; without it `-x` is "unexpected argument" and the tab dies.
    const args = buildCodexArgs(opts({ prompt: '-x marks the spot' }));
    expect(args).toEqual(['--', '-x marks the spot']);
  });

  it('emits the terminator only when there is a prompt to protect', () => {
    expect(buildCodexArgs(opts({ resumeId: ID_B }))).not.toContain('--');
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
    expect(args).toEqual(['--', 'You are in project API.\n\nhello']);
  });

  it('carries appendSystemPrompt alone when there is no user prompt', () => {
    expect(buildCodexArgs(opts({ appendSystemPrompt: 'context' }))).toEqual([
      '--',
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
    meta: {
      cwd?: string;
      timestamp?: string;
      /** `payload.session_id`, which for an interactive session equals the id
       *  in the FILENAME and for a spawned thread does not. */
      sessionId?: string;
      parentThreadId?: string;
      originator?: string;
    } = {},
  ): string {
    const [y, m, d] = day.split('-');
    const dir = path.join(root, 'sessions', y, m, d);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-${day}T01-00-00-${id}.jsonl`);
    const payload = {
      // Ordered as codex-cli 0.153.4 writes it: the conversation's id first,
      // then this file's own, then the parent when there is one.
      session_id: meta.sessionId ?? id,
      id,
      ...(meta.parentThreadId !== undefined
        ? { parent_thread_id: meta.parentThreadId }
        : {}),
      cwd: meta.cwd ?? '/code/api',
      ...(meta.originator !== undefined ? { originator: meta.originator } : {}),
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

  // ---- a thread is not a session -------------------------------------
  //
  // Measured on codex-cli 0.153.4 with `features.multi_agent`: each thread
  // Codex spawns opens its OWN rollout, named for that thread's `payload.id`
  // while `payload.session_id` still names the conversation. Reading the name
  // as the session id turned one headless run's threads into session ids no
  // `codex resume` can reopen — and, because they share the parent's cwd,
  // into adoption candidates for an unrelated launch.

  it('readRolloutMeta MARKS a thread file rather than refusing it', () => {
    // The reader reports and the scan decides: one caller (the meter) wants
    // these files, and it does not care what id they carry.
    const file = writeRollout('2026-08-12', ID_A, {
      sessionId: ID_B,
      parentThreadId: ID_B,
      originator: 'codex_exec',
    });
    expect(readRolloutMeta(file)?.threadOf).toBe(ID_B);
  });

  it('readRolloutMeta marks on session_id alone, with no parent_thread_id', () => {
    const file = writeRollout('2026-08-12', ID_A, { sessionId: ID_B });
    expect(readRolloutMeta(file)?.threadOf).toBe(ID_B);
  });

  it('readRolloutMeta marks on parent_thread_id alone', () => {
    // A future shape that drops `session_id` but keeps the parent link is
    // still a thread, and each witness has to be enough on its own.
    const file = writeRollout('2026-08-12', ID_A, { parentThreadId: ID_B });
    expect(readRolloutMeta(file)?.threadOf).toBe(ID_B);
  });

  it('leaves threadOf unset on a session of its own', () => {
    const file = writeRollout('2026-08-12', ID_A, { sessionId: ID_A });
    expect(readRolloutMeta(file)?.threadOf).toBeUndefined();
  });

  it('readRolloutMeta keeps a file whose head AGREES with its name', () => {
    // The interactive case, and the reason the check is a disagreement test
    // rather than a "has a session_id" test: 0.153.4 writes the field on every
    // rollout, thread or not.
    const file = writeRollout('2026-08-12', ID_A, {
      sessionId: ID_A,
      originator: 'codex-tui',
    });
    const meta = readRolloutMeta(file);
    expect(meta?.sessionId).toBe(ID_A);
    expect(meta?.originator).toBe('codex-tui');
  });

  it('readRolloutMeta keeps a file with no session_id at all', () => {
    // The old robustness argument survives: a head truncated before the field
    // is written still gets its id from the name.
    const dir = path.join(root, 'sessions', '2026', '08', '12');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-08-12T01-00-00-${ID_A}.jsonl`);
    fs.writeFileSync(file, '{"timestamp":"2026-08-12T01:00:00.000Z"');
    expect(readRolloutMeta(file)?.sessionId).toBe(ID_A);
  });

  it('scanRollouts leaves thread files out of the store by default', () => {
    writeRollout('2026-08-12', ID_A, { originator: 'codex-tui' });
    writeRollout('2026-08-12', ID_B, {
      sessionId: ID_A,
      parentThreadId: ID_A,
      originator: 'codex_exec',
    });
    const found = scanRollouts({ sessionsDirs: [path.join(root, 'sessions')] });
    expect(found.map((r) => r.sessionId)).toEqual([ID_A]);
  });

  it('scanRollouts hands threads back when a caller asks for them', () => {
    // The meter's case: it reads the newest `token_count` record on a login
    // and never touches an id, so hiding threads from it would only make the
    // reading staler than it has to be.
    writeRollout('2026-08-12', ID_A, { originator: 'codex-tui' });
    writeRollout('2026-08-12', ID_B, {
      sessionId: ID_A,
      parentThreadId: ID_A,
    });
    const found = scanRollouts({
      sessionsDirs: [path.join(root, 'sessions')],
      includeThreads: true,
    });
    expect(found.map((r) => r.sessionId).sort()).toEqual([ID_A, ID_B].sort());
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
    // codexFallbackBinDirs joins with the AMBIENT node:path (not one picked by
    // `platform`), so on a real Windows host `path.join('/home/a', '.codex',
    // 'bin')` comes back backslash-separated even while asked for the 'linux'
    // table. Folded to '/' on both sides — same fix as stateHome.test.ts and
    // hooks.test.ts use for the identical reason — since separator style here
    // is a byproduct of the host, not part of what this list is pinning down.
    expect(
      codexFallbackBinDirs({ platform: 'linux', env: {}, home: '/home/a' }).map((d) =>
        d.replace(/\\/g, '/'),
      ),
    ).toEqual(['/home/a/.codex/bin', '/home/a/.local/bin', '/opt/homebrew/bin', '/usr/local/bin']);
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

  // ---- whose front end opened it ------------------------------------

  it('refuses a thread even when one is handed to it directly', () => {
    // scanRollouts already drops these, so this clause is the second lock:
    // the guarantee has to hold for any caller, not only the one that filters.
    const hit = matchRollout([meta({ sessionId: ID_A, threadOf: ID_B })], {
      spawnedAt: T,
      cwd: '/code/api',
    });
    expect(hit).toBeNull();
  });

  it('refuses a headless exec run that fits the window and the directory', () => {
    // The shape that cost two rows on a real machine: a `codex exec` harness
    // running in the very directory the user launches in. Every other clause
    // is satisfied, so the originator is the only thing left to tell them
    // apart — and Flock never spawns `exec`.
    const hit = matchRollout(
      [meta({ sessionId: ID_A, originator: 'codex_exec' })],
      { spawnedAt: T, cwd: '/code/api' },
    );
    expect(hit).toBeNull();
  });

  it('matches an interactive run, both spellings of the field', () => {
    for (const originator of ['codex-tui', 'codex_tui']) {
      const hit = matchRollout([meta({ sessionId: ID_A, originator })], {
        spawnedAt: T,
        cwd: '/code/api',
      });
      expect(hit?.sessionId).toBe(ID_A);
    }
  });

  it('matches a rollout that names no originator at all', () => {
    // Absence is not evidence. An older file carries no such field, and a
    // future rename of the value would otherwise stop every re-key silently —
    // which is a worse failure than the one this clause exists to prevent,
    // because it has no symptom.
    const hit = matchRollout([meta({ sessionId: ID_A })], {
      spawnedAt: T,
      cwd: '/code/api',
    });
    expect(hit?.sessionId).toBe(ID_A);
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

// --------------------------------------------------------------- live rows

describe('codexRowIds: one row per CONVERSATION, not per id', () => {
  // The bug, as it looked in the tree: two rows named `plan2` and two named
  // `BIG_BOI`, same branch, same project. A Codex conversation wears several
  // ids over its life — no `--session-id`, so a launch binds provisionally and
  // is re-keyed once its rollout appears — and the liveness stamps were
  // written on different generations at different moments with nothing
  // clearing the old one. Read per id, that is two live rows for one chat.
  const CONV = ID_A;
  const GEN_1 = ID_A; // the provisional id the launch was bound under
  const GEN_2 = ID_B; // the id codex minted, adopted a moment later
  const OTHER = '019ff400-0000-7000-8000-000000000001';

  function facts(over: Partial<CodexRowFacts> & { sessionId: string }): CodexRowFacts {
    return { conversationId: CONV, updatedAtMs: 1000, ...over };
  }

  it('collapses two stamped generations of one conversation into one row', () => {
    expect(
      codexRowIds([
        facts({ sessionId: GEN_1, windowStamped: true, updatedAtMs: 1000 }),
        facts({ sessionId: GEN_2, windowStamped: true, updatedAtMs: 2000 }),
      ]),
    ).toEqual([GEN_2]);
  });

  it('puts the row on the generation bound in THIS window', () => {
    // Ahead of every stamp and every timestamp: it is the id the terminal
    // verbs resolve, so a row anywhere else would have a Focus and a Close
    // that reach nothing.
    expect(
      codexRowIds([
        facts({ sessionId: GEN_1, boundHere: true, updatedAtMs: 1 }),
        facts({ sessionId: GEN_2, windowStamped: true, updatedAtMs: 9999 }),
      ]),
    ).toEqual([GEN_1]);
  });

  it('otherwise prefers the newest write, which is what makes a park win', () => {
    // The real pairing this settles: a since-detached terminal left a
    // `boundWindowId` on an older member, and the park that followed wrote its
    // `tmux` claim onto the current one. The claim is the later fact.
    expect(
      codexRowIds([
        facts({ sessionId: GEN_1, windowStamped: true, updatedAtMs: 1000 }),
        facts({ sessionId: GEN_2, tmuxNamed: true, updatedAtMs: 1001 }),
      ]),
    ).toEqual([GEN_2]);
  });

  it('gives two different conversations a row each', () => {
    expect(
      codexRowIds([
        facts({ sessionId: GEN_1, windowStamped: true }),
        facts({
          sessionId: OTHER,
          conversationId: OTHER,
          windowStamped: true,
        }),
      ]),
    ).toEqual([GEN_1, OTHER].sort());
  });

  it('treats an id in no chain as its own conversation', () => {
    expect(
      codexRowIds([
        { sessionId: GEN_1, windowStamped: true },
        { sessionId: OTHER, tmuxNamed: true },
      ]),
    ).toEqual([GEN_1, OTHER].sort());
  });

  it('drops a generation nothing vouches for', () => {
    expect(codexRowIds([facts({ sessionId: GEN_1 })])).toEqual([]);
  });

  // ---- what `closed` may and may not overrule -------------------------

  it('a closed record is not resurrected by a stamp nobody cleared', () => {
    // The "I keep seeing closed Codex runs" complaint. A close writes onto ONE
    // generation, and the sibling kept the stamp its own bind once wrote; with
    // the stamp believed unconditionally the sibling became the conversation's
    // only live generation and the closed session went on showing a row.
    expect(
      codexRowIds([
        facts({ sessionId: GEN_1, windowStamped: true, closed: true }),
        facts({ sessionId: GEN_2, tmuxNamed: true, closed: true }),
      ]),
    ).toEqual([]);
  });

  it('but a live binding outranks `closed` — never hide a session on screen', () => {
    // A stamp is bookkeeping and can be stale; a terminal this window is
    // holding is not. Suppressing THAT would be the one destructive rendering
    // mistake available here.
    expect(
      codexRowIds([facts({ sessionId: GEN_1, boundHere: true, closed: true })]),
    ).toEqual([GEN_1]);
  });

  it('a closed generation loses the row to a live sibling of the same chat', () => {
    expect(
      codexRowIds([
        facts({ sessionId: GEN_1, windowStamped: true, closed: true, updatedAtMs: 9999 }),
        facts({ sessionId: GEN_2, windowStamped: true, updatedAtMs: 1 }),
      ]),
    ).toEqual([GEN_2]);
  });

  // ---- the one place the reduction yields -----------------------------

  it('never collapses two generations that each have a terminal here', () => {
    // One process cannot be two terminals, so a chain claiming these are one
    // conversation is provably wrong — and the safe reading of a contradiction
    // is two rows, not a hidden session. `boundHere` is the only fact that can
    // prove it: a rebind MOVES the binding, so a stamp can go stale on an old
    // generation while this cannot.
    expect(
      codexRowIds([
        facts({ sessionId: GEN_1, boundHere: true }),
        facts({ sessionId: GEN_2, boundHere: true }),
      ]),
    ).toEqual([GEN_1, GEN_2].sort());
  });

  it('a bound generation still absorbs its conversation`s stale stamps', () => {
    // The duplicate-row case, which is the common one: one terminal, and a
    // stamp left behind on the generation it used to be bound under.
    expect(
      codexRowIds([
        facts({ sessionId: GEN_1, windowStamped: true, updatedAtMs: 9999 }),
        facts({ sessionId: GEN_2, boundHere: true, updatedAtMs: 1 }),
      ]),
    ).toEqual([GEN_2]);
  });

  it('a closed record with a terminal here still gets its row', () => {
    expect(
      codexRowIds([
        facts({ sessionId: GEN_1, boundHere: true, closed: true }),
        facts({ sessionId: GEN_2, windowStamped: true, closed: true }),
      ]),
    ).toEqual([GEN_1]);
  });

  // ---- totality ------------------------------------------------------

  it('is stable under input order and tolerates junk', () => {
    const a = facts({ sessionId: GEN_1, windowStamped: true, updatedAtMs: 5 });
    const b = facts({ sessionId: GEN_2, windowStamped: true, updatedAtMs: 5 });
    // Equal claims: the tie-break has to be total, or the row would flicker
    // between generations from one poll to the next.
    expect(codexRowIds([a, b])).toEqual(codexRowIds([b, a]));
    expect(
      codexRowIds([
        { sessionId: 'not-an-id', windowStamped: true },
        facts({ sessionId: GEN_1, windowStamped: true }),
      ]),
    ).toEqual([GEN_1]);
    expect(codexRowIds([])).toEqual([]);
  });

  it('an unknown updatedAt reads as oldest rather than as newest', () => {
    // An id nobody has written to since the launch is exactly the one that
    // should lose to a generation something has touched.
    expect(
      codexRowIds([
        { sessionId: GEN_1, conversationId: CONV, windowStamped: true },
        facts({ sessionId: GEN_2, windowStamped: true, updatedAtMs: 1 }),
      ]),
    ).toEqual([GEN_2]);
  });
});
