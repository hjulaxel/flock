// test/processTable.test.ts — the Windows process table: one CIM sweep,
// parsed once, cached briefly, shared by everything that used to run `ps`.
// Every effect is injected, so this runs — and means the same thing — on the
// macOS laptop it was written on and on the Windows leg of the CI matrix.

import { describe, expect, it } from 'vitest';

import {
  WINDOWS_SNAPSHOT_TTL_MS,
  WINDOWS_SWEEP_TIMEOUT_MS,
  WindowsProcessTable,
  parseWindowsProcessJson,
  windowsProcessQuery,
} from '../src/processTable';

const ROWS = JSON.stringify([
  { ProcessId: 4, ParentProcessId: 0, CommandLine: null, Start: '' },
  {
    ProcessId: 1200,
    ParentProcessId: 800,
    CommandLine: '"C:\\Users\\a\\.local\\bin\\claude.exe" --session-id abc',
    Start: '2026-09-05T18:05:47.1420000+02:00',
  },
  {
    ProcessId: 1300,
    ParentProcessId: 1200,
    CommandLine: 'node mcp-server.js',
    Start: '2026-09-05T18:05:48.0000000+02:00',
  },
]);

describe('windowsProcessQuery', () => {
  it('is powershell.exe, non-interactive, with one inline command', () => {
    const [command, ...args] = windowsProcessQuery();
    expect(command).toBe('powershell.exe');
    expect(args).toContain('-NoProfile');
    expect(args).toContain('-NonInteractive');
    expect(args[args.length - 2]).toBe('-Command');
    const script = args[args.length - 1] ?? '';
    // The four facts every caller needs, and nothing that could be user input.
    for (const token of ['Get-CimInstance Win32_Process', 'ProcessId', 'ParentProcessId', 'CommandLine', 'CreationDate', 'ConvertTo-Json']) {
      expect(script).toContain(token);
    }
    // An array even for a table of one, and UTF-8 for a path with an umlaut.
    expect(script).toContain('-InputObject @(');
    expect(script).toContain('OutputEncoding');
  });
});

describe('parseWindowsProcessJson', () => {
  it('reads pid, parent, command line and the start string from the sweep', () => {
    const table = parseWindowsProcessJson(ROWS);
    expect(table.get(1200)).toEqual({
      pid: 1200,
      ppid: 800,
      start: '2026-09-05T18:05:47.1420000+02:00',
      command: '"C:\\Users\\a\\.local\\bin\\claude.exe" --session-id abc',
    });
    // A system process Windows withholds the command line for is still a
    // row — its pid and parent are what the descendant walk needs.
    expect(table.get(4)).toEqual({ pid: 4, ppid: 0, start: '', command: '' });
  });

  it('reads a bare object as a table of one, and garbage as nothing', () => {
    expect(
      parseWindowsProcessJson(JSON.stringify({ ProcessId: 7, ParentProcessId: 1, CommandLine: 'x', Start: 's' })).get(7)
        ?.command,
    ).toBe('x');
    expect(parseWindowsProcessJson('not json').size).toBe(0);
    expect(parseWindowsProcessJson('').size).toBe(0);
    expect(parseWindowsProcessJson('[{"ProcessId":"nope"},{"ProcessId":-1},null,5]').size).toBe(0);
  });
});

describe('WindowsProcessTable', () => {
  function world(answers: () => string | Error) {
    const calls: Array<{ command: string; args: readonly string[]; timeout: number }> = [];
    let now = 1_000_000;
    const table = new WindowsProcessTable({
      exec: async (command, args, timeout) => {
        calls.push({ command, args, timeout });
        const a = answers();
        if (a instanceof Error) throw a;
        return a;
      },
      now: () => now,
    });
    return { table, calls, tick: (ms: number) => (now += ms) };
  }

  it('sweeps once and answers every asker in the same moment from the cache', async () => {
    const w = world(() => ROWS);
    const [a, b] = await Promise.all([w.table.snapshot(), w.table.snapshot()]);
    expect(a.get(1300)?.ppid).toBe(1200);
    expect(b).toBe(a);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]?.command).toBe('powershell.exe');
    expect(w.calls[0]?.timeout).toBe(WINDOWS_SWEEP_TIMEOUT_MS);
    // Inside the TTL, still the one sweep.
    w.tick(WINDOWS_SNAPSHOT_TTL_MS - 1);
    await w.table.snapshot();
    expect(w.calls).toHaveLength(1);
  });

  it('sweeps again once the table is stale, or when told to forget it', async () => {
    const w = world(() => ROWS);
    await w.table.snapshot();
    w.tick(WINDOWS_SNAPSHOT_TTL_MS);
    await w.table.snapshot();
    expect(w.calls).toHaveLength(2);
    w.table.invalidate();
    await w.table.snapshot();
    expect(w.calls).toHaveLength(3);
  });

  it('a failed sweep is an empty table — and is not cached, so the next asker retries', async () => {
    let fail = true;
    const w = world(() => (fail ? new Error('powershell.exe: not found') : ROWS));
    expect((await w.table.snapshot()).size).toBe(0);
    fail = false;
    expect((await w.table.snapshot()).size).toBe(3);
    expect(w.calls).toHaveLength(2);
  });
});
