// src/processTable.ts — the process table on Windows.
//
// THE PROBLEM THIS FILE EXISTS TO FIX. Four things in Flock read the process
// table, and every one of them did it by running `ps`: the descendant walk
// before a kill (procs.listDescendants), the start-time identity check behind
// the window-close orphan rescue (procs.listPidFacts), the parent walk that
// finds a CLI fork's parent in its argv (lineage.psPpidCommand, also the
// terminal-match ancestor chain), and the warm-spare filter that keeps
// `claude bg-spare` off the tree (roster.psCommands). Windows has no `ps`, so
// each of them short-circuited there: a closed session's MCP children were
// never reaped, a fork typed at the CLI drew as a root, and a spare row was a
// row.
//
// Windows does have the table — `Win32_Process` through CIM — and one sweep
// of it answers all four questions at once: pid, parent, creation date (the
// identity string the rescue compares), command line. So this module is one
// PowerShell call, parsed into one map, and cached for a moment so the argv
// walk's five hops and the roster's spare check in the same tick cost one
// process, not six. PowerShell's cold start is a few hundred milliseconds;
// the cache is what makes that affordable.
//
// POSIX keeps its `ps` calls exactly as they were. They are cheap and
// targeted, and the callers only reach for this module on win32.
//
// PowerShell rather than `wmic` (removed from Windows 11) or `tasklist` (no
// parent, no command line). `powershell.exe` rather than `pwsh`: only the
// former ships with Windows. Never imports vscode; every effect is injectable.

import { execFile } from 'node:child_process';

import { logError } from './log';

/** One process, as the sweep reports it. `start` is the CIM creation date in
 *  ISO 8601 round-trip form — an opaque identity string to the callers, which
 *  compare it with `===` and never parse it. `command` is the full command
 *  line, '' when Windows withholds it (system processes, other users'). */
export interface ProcessFact {
  pid: number;
  ppid: number;
  start: string;
  command: string;
}

export type ProcessSnapshot = ReadonlyMap<number, ProcessFact>;

/** Injectable `execFile` — resolves stdout, rejects on error. The same shape
 *  procs.ts uses, so one test double serves both. */
export type ExecFn = (
  cmd: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<string>;

/** A table of a few hundred processes with their command lines is a megabyte
 *  or two of JSON; sixteen leaves room for the machine that runs everything. */
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * PowerShell's cold start dominates; the query itself is tens of milliseconds
 * once CIM is only asked for four properties.
 *
 * WAS 8 SECONDS, on the reasoning that a machine which cannot answer in that
 * long is not going to. A GitHub windows-latest runner disproved it: two real
 * sweeps in `test/lineage.test.ts` took the file to 18.7 s and both came back
 * empty, so `psPpidCommand(process.pid)` reported no parent for the process
 * asking — and the whole point of this module is that Windows stops being the
 * platform where a CLI fork draws as a root. A timeout here is SILENT by
 * design (an empty table means "nothing verifiable"), which is exactly why it
 * must not be tight enough to hit on a busy machine.
 */
export const WINDOWS_SWEEP_TIMEOUT_MS = 15_000;

/** How long one sweep answers for. The callers that share a tick — the argv
 *  walk's hops, the spare check, a kill's descendant walk — arrive within
 *  milliseconds of each other; anything asking later deserves a fresh table,
 *  because the question is usually "did that process exit". */
export const WINDOWS_SNAPSHOT_TTL_MS = 1_500;

const defaultExec: ExecFn = (cmd, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      [...args],
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES, windowsHide: true },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
  });

/**
 * Pure. The PowerShell invocation, as [command, ...args].
 *
 * `-NoProfile` keeps the user's profile script — and its cost, and its
 * output — out of a query we parse. `-NonInteractive` means a prompt is a
 * failure rather than a hang. `-ExecutionPolicy Bypass` applies to script
 * FILES; this is an inline `-Command`, which the policy never governed, but a
 * machine with a restrictive policy logs less noise for saying so. The
 * console encoding is forced to UTF-8 first, because PowerShell 5.1 writes
 * the OEM code page by default and a command line with a non-ASCII path in it
 * would otherwise arrive mangled.
 *
 * `-InputObject @(...)` rather than a pipe into ConvertTo-Json: the pipe
 * unrolls an array, and a table of exactly one process would come back as a
 * bare object. `-Depth 2` is one more than the objects need. A process whose
 * CreationDate Windows withholds gets '' rather than a method call on null.
 */
export function windowsProcessQuery(): [string, ...string[]] {
  const script = [
    // UTF8Encoding($false) — WITHOUT the preamble. `[Text.Encoding]::UTF8`
    // carries one, and .NET writes it on the first redirected write, so stdout
    // began with a BOM that `JSON.parse` rejects; the parser below caught the
    // throw and returned an EMPTY table, which reads to every caller as "no
    // such process". Belt and braces: the parser now strips it too, because
    // this line cannot be tested from macOS and a silent empty table is the
    // most expensive way for this module to fail.
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false;',
    'ConvertTo-Json -Compress -Depth 2 -InputObject @(',
    // `-Property` limits what CIM MATERIALISES per process, which is where the
    // sweep's time goes — Win32_Process fetches every column otherwise, and a
    // `Select-Object` after the fact has already paid for them.
    'Get-CimInstance -ClassName Win32_Process',
    '-Property ProcessId, ParentProcessId, CommandLine, CreationDate |',
    'Select-Object ProcessId, ParentProcessId, CommandLine,',
    "@{ n = 'Start'; e = { if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { '' } } }",
    ')',
  ].join(' ');
  return [
    'powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ];
}

/**
 * Pure. The sweep's JSON as a pid → fact map. A bare object (an old
 * PowerShell that unrolled the array anyway) is read as a table of one;
 * anything unparseable, or any row without a usable pid, is skipped. Never
 * throws — the rescue and the reap both treat an empty map as "nothing
 * verifiable, so nothing to signal".
 */
export function parseWindowsProcessJson(stdout: string): Map<number, ProcessFact> {
  const out = new Map<number, ProcessFact>();
  let parsed: unknown;
  try {
    // A LEADING BOM IS NOT A PARSE ERROR HERE. PowerShell's console encoding
    // can put one in front of the JSON (see `windowsProcessQuery`), and
    // `JSON.parse` refuses it — which used to mean an empty table, i.e. every
    // Windows caller silently told "no such process". Stripped rather than
    // trusted away, since the shape of stdout is the one thing this module
    // does not control.
    parsed = JSON.parse(stdout.replace(/^﻿/, ''));
  } catch {
    return out;
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const pid = Number(r['ProcessId']);
    const ppid = Number(r['ParentProcessId']);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    out.set(pid, {
      pid,
      ppid: Number.isInteger(ppid) && ppid >= 0 ? ppid : 0,
      start: typeof r['Start'] === 'string' ? r['Start'] : '',
      command: typeof r['CommandLine'] === 'string' ? r['CommandLine'] : '',
    });
  }
  return out;
}

/**
 * One sweep, shared and briefly cached. Concurrent askers await the same
 * in-flight promise rather than each spawning a PowerShell. A sweep that
 * fails yields an empty table — and is NOT cached, so the next asker retries.
 */
export class WindowsProcessTable {
  private readonly exec: ExecFn;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private cached: { at: number; table: Map<number, ProcessFact> } | null = null;
  private inFlight: Promise<Map<number, ProcessFact>> | null = null;

  constructor(deps: { exec?: ExecFn; now?: () => number; ttlMs?: number } = {}) {
    this.exec = deps.exec ?? defaultExec;
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? WINDOWS_SNAPSHOT_TTL_MS;
  }

  snapshot(): Promise<ProcessSnapshot> {
    const now = this.now();
    if (this.cached !== null && now - this.cached.at < this.ttlMs) {
      return Promise.resolve(this.cached.table);
    }
    if (this.inFlight !== null) return this.inFlight;
    const [command, ...args] = windowsProcessQuery();
    this.inFlight = this.exec(command, args, WINDOWS_SWEEP_TIMEOUT_MS)
      .then((stdout) => {
        const table = parseWindowsProcessJson(stdout);
        this.cached = { at: this.now(), table };
        return table;
      })
      .catch((err: unknown) => {
        logError('processTable.snapshot', err);
        return new Map<number, ProcessFact>();
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** Drop the cache — after a kill, when the next question is "is it gone". */
  invalidate(): void {
    this.cached = null;
  }
}

let shared: WindowsProcessTable | null = null;

/** The one table every Windows caller shares, so a tick's several questions
 *  cost one PowerShell between them. Created on first use, never on POSIX. */
export function sharedWindowsProcessTable(): WindowsProcessTable {
  if (shared === null) shared = new WindowsProcessTable();
  return shared;
}

/** Test seam: replace (or clear, with null) the shared instance. */
export function setSharedWindowsProcessTable(table: WindowsProcessTable | null): void {
  shared = table;
}
