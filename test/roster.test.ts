// Owner A. Roster parsing / normalisation / binary discovery / poller.
// No test here ever runs the real `claude` binary.

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  RosterPoller,
  fetchRoster,
  findClaudeBinary,
  normalizeStatus,
  parseRoster,
  rosterSignature,
  sameRoster,
} from '../src/roster';
import { isSessionId, type RosterEntry, type RosterResult } from '../src/types';

/**
 * The measured output of `claude agents --json` on this machine (CLI 2.1.220).
 * Kept verbatim apart from the uuid tails, which were elided in the capture.
 * Note what is MISSING: row 2 has no `pid` and no `status`; row 3 has no
 * `state` and no `waitingFor`. That inconsistency is the whole reason every
 * field but sessionId is optional.
 */
const MEASURED_SAMPLE = `[
  { "pid": 11763, "id": "3e6aa079", "cwd": "/Users/axelh/Documents/Magma/research/BASALT",
    "kind": "background", "startedAt": 1783809914249,
    "sessionId": "3e6aa079-d114-40be-b788-ab9ba937f9d0",
    "name": "high-grades-stagnation results harvested",
    "status": "waiting", "waitingFor": "dialog open", "state": "blocked" },
  { "id": "9a5bf57b", "cwd": "/Users/axelh/Documents/Magma/research/BASALT", "kind": "background",
    "startedAt": 1783901749542,
    "sessionId": "9a5bf57b-1c2d-4e3f-9a8b-7c6d5e4f3a2b",
    "name": "second background agent", "state": "blocked" },
  { "pid": 79378, "cwd": "/Users/axelh/Documents/creemux-addon", "kind": "interactive",
    "startedAt": 1784792414124, "sessionId": "1f743713-aa11-4bb2-8cc3-dd44ee55ff66",
    "name": "Let's start working on this project. (Branch)", "status": "idle" }
]`;

describe('parseRoster: the measured sample', () => {
  const entries = parseRoster(MEASURED_SAMPLE);

  it('keeps all three rows and their session ids', () => {
    expect(entries).toHaveLength(3);
    for (const e of entries) expect(isSessionId(e.sessionId)).toBe(true);
    expect(entries[0].sessionId).toBe('3e6aa079-d114-40be-b788-ab9ba937f9d0');
  });

  it('carries the fields that are present and omits the ones that are not', () => {
    expect(entries[0].pid).toBe(11763);
    expect(entries[0].rosterId).toBe('3e6aa079');
    expect(entries[0].kind).toBe('background');
    expect(entries[0].startedAt).toBe(1783809914249);
    expect(typeof entries[0].startedAt).toBe('number');
    expect(entries[0].waitingFor).toBe('dialog open');

    // Row 2 has no pid and no status at all — both must stay undefined.
    expect(entries[1].pid).toBeUndefined();
    expect(entries[1].status).toBeUndefined();
    expect(entries[1].state).toBe('blocked');

    // Row 3 has no state / waitingFor.
    expect(entries[2].state).toBeUndefined();
    expect(entries[2].waitingFor).toBeUndefined();
    expect(entries[2].kind).toBe('interactive');
  });

  it('normalises each row to the right status/attention', () => {
    expect(normalizeStatus(entries[0])).toEqual({
      status: 'waiting',
      attention: 'waiting',
    });
    // waiting via `state: blocked` alone, with no `status` field.
    expect(normalizeStatus(entries[1])).toEqual({
      status: 'waiting',
      attention: 'waiting',
    });
    expect(normalizeStatus(entries[2])).toEqual({
      status: 'idle',
      attention: 'none',
    });
  });
});

describe('parseRoster: shape drift never throws', () => {
  it('returns [] for non-JSON and for JSON that is not an array', () => {
    expect(parseRoster('')).toEqual([]);
    expect(parseRoster('not json at all')).toEqual([]);
    expect(parseRoster('{"agents": []}')).toEqual([]);
    expect(parseRoster('null')).toEqual([]);
    expect(parseRoster('42')).toEqual([]);
  });

  it('drops rows that are not objects or lack a uuid sessionId', () => {
    const raw = JSON.stringify([
      'a string',
      42,
      null,
      [],
      { cwd: '/x' },
      { sessionId: 'not-a-uuid' },
      { sessionId: '0f000001-0000-4000-8000-000000000001' },
    ]);
    const entries = parseRoster(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].sessionId).toBe('0f000001-0000-4000-8000-000000000001');
  });

  it('dedupes by sessionId, first occurrence wins', () => {
    const raw = JSON.stringify([
      { sessionId: '0f000001-0000-4000-8000-000000000001', name: 'first' },
      { sessionId: '0f000001-0000-4000-8000-000000000001', name: 'second' },
    ]);
    const entries = parseRoster(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('first');
  });

  it('rejects mistyped scalars rather than coercing them', () => {
    const raw = JSON.stringify([
      {
        sessionId: '0f000001-0000-4000-8000-000000000001',
        pid: '11763', // numeric STRING — not a pid
        startedAt: 'yesterday',
        cwd: '',
        name: 7,
        status: null,
        kind: 'weird-new-kind',
      },
    ]);
    const [e] = parseRoster(raw);
    expect(e.pid).toBeUndefined();
    expect(e.startedAt).toBeUndefined();
    expect(e.cwd).toBeUndefined();
    expect(e.name).toBeUndefined();
    expect(e.status).toBeUndefined();
    expect(e.kind).toBe('unknown'); // present but unrecognised
  });

  it('leaves kind undefined when the field is absent', () => {
    const [e] = parseRoster(
      JSON.stringify([{ sessionId: '0f000001-0000-4000-8000-000000000001' }]),
    );
    expect(e.kind).toBeUndefined();
    expect(e.pid).toBeUndefined();
  });

  it('rejects a non-positive or fractional pid', () => {
    const raw = JSON.stringify([
      { sessionId: '0f000001-0000-4000-8000-000000000001', pid: 0 },
      { sessionId: '0f000002-0000-4000-8000-000000000002', pid: -3 },
      { sessionId: '0f000003-0000-4000-8000-000000000003', pid: 12.5 },
      { sessionId: '0f000004-0000-4000-8000-000000000004', pid: 99 },
    ]);
    const entries = parseRoster(raw);
    expect(entries.map((e) => e.pid)).toEqual([
      undefined,
      undefined,
      undefined,
      99,
    ]);
  });
});

describe('normalizeStatus decision table', () => {
  const row = (patch: Partial<RosterEntry>): RosterEntry => ({
    sessionId: '0f000001-0000-4000-8000-000000000001',
    ...patch,
  });

  it('waiting wins from either field', () => {
    expect(normalizeStatus(row({ status: 'waiting' })).status).toBe('waiting');
    expect(normalizeStatus(row({ state: 'blocked' })).status).toBe('waiting');
    expect(normalizeStatus(row({ status: 'idle', state: 'blocked' }))).toEqual({
      status: 'waiting',
      attention: 'waiting',
    });
  });

  it('maps busy/working/running to busy with no attention', () => {
    for (const patch of [
      { status: 'busy' },
      { status: 'working' },
      { state: 'running' },
      { state: 'working' },
    ]) {
      expect(normalizeStatus(row(patch))).toEqual({
        status: 'busy',
        attention: 'none',
      });
    }
  });

  it('maps idle to idle and everything else to unknown', () => {
    expect(normalizeStatus(row({ status: 'idle' }))).toEqual({
      status: 'idle',
      attention: 'none',
    });
    expect(normalizeStatus(row({}))).toEqual({
      status: 'unknown',
      attention: 'none',
    });
    expect(normalizeStatus(row({ status: 'brand-new-status' }))).toEqual({
      status: 'unknown',
      attention: 'none',
    });
    expect(normalizeStatus({} as RosterEntry)).toEqual({
      status: 'unknown',
      attention: 'none',
    });
  });
});

describe('findClaudeBinary', () => {
  const savedPath = process.env['PATH'];
  afterEach(() => {
    process.env['PATH'] = savedPath;
  });

  it('returns a configured path verbatim, without touching the filesystem', () => {
    expect(findClaudeBinary('/explicit/path/to/claude')).toBe(
      '/explicit/path/to/claude',
    );
    expect(findClaudeBinary('  ')).not.toBe('  '); // blank falls back to PATH
  });

  it('finds an executable claude on PATH', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-bin-'));
    const bin = path.join(dir, 'claude');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env['PATH'] = dir;
    expect(findClaudeBinary()).toBe(bin);
    expect(findClaudeBinary('')).toBe(bin);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when PATH holds nothing named claude', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-bin-'));
    process.env['PATH'] = dir;
    expect(findClaudeBinary()).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ignores a PATH entry that is a directory named claude', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-bin-'));
    fs.mkdirSync(path.join(dir, 'claude'));
    process.env['PATH'] = dir;
    expect(findClaudeBinary()).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('fetchRoster', () => {
  it('resolves ok:false instead of rejecting when the binary is missing', async () => {
    const r = await fetchRoster({
      claudeBin: path.join(os.tmpdir(), 'definitely-not-a-real-claude-binary'),
      timeoutMs: 2000,
    });
    expect(r.ok).toBe(false);
    expect(r.entries).toEqual([]);
    expect(typeof r.error).toBe('string');
    expect(r.tookMs).toBeGreaterThanOrEqual(0);
  });
});

describe('rosterSignature / sameRoster', () => {
  const a: RosterEntry = {
    sessionId: '0f000001-0000-4000-8000-000000000001',
    status: 'idle',
  };
  const b: RosterEntry = {
    sessionId: '0f000002-0000-4000-8000-000000000002',
    status: 'waiting',
  };

  it('is order independent', () => {
    expect(sameRoster([a, b], [b, a])).toBe(true);
  });

  it('detects a status change and a membership change', () => {
    expect(sameRoster([a], [{ ...a, status: 'busy' }])).toBe(false);
    expect(sameRoster([a], [a, b])).toBe(false);
    expect(rosterSignature([])).toBe('');
  });
});

describe('RosterPoller', () => {
  const ok = (): RosterResult => ({ ok: true, entries: [], tookMs: 1 });
  const bad = (): RosterResult => ({
    ok: false,
    entries: [],
    error: 'boom',
    tookMs: 1,
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches immediately on start, then on the interval, and stops', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const results: RosterResult[] = [];
    const poller = new RosterPoller(
      async () => {
        calls++;
        return ok();
      },
      (r) => results.push(r),
      1000,
    );

    poller.start();
    expect(calls).toBe(1); // no waiting a whole interval for the first paint
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(3);

    poller.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(3);
    expect(results).toHaveLength(3);
    poller.dispose();
  });

  it('backs off only after three consecutive failures and resets on success', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let healthy = false;
    const poller = new RosterPoller(
      async () => {
        calls++;
        return healthy ? ok() : bad();
      },
      () => undefined,
      1000,
    );

    poller.start();
    expect(calls).toBe(1); // failure #1
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2); // failure #2 — still at the base interval
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(3); // failure #3 — from here the interval doubles

    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(3); // 1000 ms is no longer enough
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(4); // fired at 2000 ms

    healthy = true;
    await vi.advanceTimersByTimeAsync(4000); // failure #4 waited 4000 ms
    expect(calls).toBe(5);
    await vi.advanceTimersByTimeAsync(1000); // success reset the interval
    expect(calls).toBe(6);
    poller.dispose();
  });

  it('coalesces pokes inside the 500 ms window', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const poller = new RosterPoller(
      async () => {
        calls++;
        return ok();
      },
      () => undefined,
      100_000,
    );
    poller.start();
    await vi.advanceTimersByTimeAsync(0); // let the start fetch settle
    expect(calls).toBe(1);

    poller.pokeNow();
    poller.pokeNow();
    poller.pokeNow();
    expect(calls).toBe(2); // three pokes, one fetch

    await vi.advanceTimersByTimeAsync(600);
    poller.pokeNow();
    expect(calls).toBe(3);
    poller.dispose();
  });

  it('never overlaps fetches, and runs one more tick for a poke that arrived mid-flight', async () => {
    vi.useFakeTimers();
    let calls = 0;
    // A FIFO of pending resolvers rather than a reassigned `let`: the
    // assignment only happens inside the async fetch callback, so TS narrows a
    // bare `let release: (() => void) | null = null` to `never` at the call
    // sites below (TS2349, invisible until test/ is actually typechecked).
    const gate: Array<() => void> = [];
    const releaseNext = (): void => {
      gate.shift()?.();
    };
    const poller = new RosterPoller(
      async () => {
        calls++;
        await new Promise<void>((resolve) => {
          gate.push(resolve);
        });
        return ok();
      },
      () => undefined,
      100_000,
    );

    poller.start();
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(600);
    poller.pokeNow(); // arrives while the first fetch is still in flight
    expect(calls).toBe(1);

    releaseNext();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2); // the deferred poke ran exactly once
    releaseNext();
    await vi.advanceTimersByTimeAsync(0);
    poller.dispose();
  });

  it('survives a fetch that rejects and a listener that throws', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const seen: RosterResult[] = [];
    const poller = new RosterPoller(
      async () => {
        calls++;
        if (calls === 1) throw new Error('spawn exploded');
        return ok();
      },
      (r) => {
        seen.push(r);
        if (seen.length === 1) throw new Error('listener exploded');
      },
      1000,
    );

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen[0].ok).toBe(false);
    expect(seen[0].error).toContain('spawn exploded');

    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toHaveLength(2); // the loop kept running
    expect(seen[1].ok).toBe(true);
    poller.dispose();
  });

  it('is inert after dispose', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const poller = new RosterPoller(
      async () => {
        calls++;
        return ok();
      },
      () => undefined,
      1000,
    );
    poller.start();
    poller.dispose();
    poller.pokeNow();
    poller.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(1);
  });
});
