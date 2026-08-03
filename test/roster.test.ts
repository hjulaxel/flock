// test/roster.test.ts — reading the CLI's own session roster: parsing,
// normalisation, binary discovery and the poller.
// No test here ever runs the real `claude` binary.

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  RosterFilter,
  RosterPoller,
  destaleBusyStatus,
  fetchRoster,
  fetchRosterMulti,
  findClaudeBinary,
  isProcessAlive,
  isSpareCommand,
  normalizeStatus,
  parseRoster,
  reportsBusy,
  rosterEnvFor,
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
  { "pid": 79378, "cwd": "/Users/dev/Documents/legacy-addon", "kind": "interactive",
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

// -------------------------------------------------------- the phantom filter

/** The two real command lines measured on this machine, verbatim. */
const SPARE_CMD =
  'claude bg-spare --bg-spare /tmp/cc-daemon-501/9c0db7b2/spare/f196e5f7.claim.sock';
const SESSION_CMD =
  '/Users/axelh/.local/share/claude/versions/2.1.217 --session-id ' +
  '0408b335-a2d4-4d3e-a546-aba0937b32be --fork-session --resume /Users/axelh/.claude/projects/x';

const SPARE_ID = '3e6aa079-d114-40be-b788-ab9ba937f9d0';
const NOPID_ID = '9a5bf57b-1c2d-4e3f-9a8b-7c6d5e4f3a2b';
const REAL_ID = '1f743713-aa11-4bb2-8cc3-dd44ee55ff66';

/** A filter whose two syscalls are injected: `alive` lists the running pids,
 *  `cmds` the argv `ps` would report. */
function filterWith(
  alive: number[],
  cmds: Record<number, string>,
  onPs?: (pids: readonly number[]) => void,
): RosterFilter {
  const live = new Set(alive);
  return new RosterFilter({
    isAlive: (pid) => live.has(pid),
    psCommands: (pids) => {
      onPs?.(pids);
      const out = new Map<number, string>();
      for (const pid of pids) {
        const c = cmds[pid];
        if (c !== undefined) out.set(pid, c);
      }
      return Promise.resolve(out);
    },
  });
}

describe('isSpareCommand', () => {
  it('matches the measured warm-spare command line', () => {
    expect(isSpareCommand(SPARE_CMD)).toBe(true);
    expect(isSpareCommand('claude --bg-spare=/tmp/x.sock')).toBe(true);
    expect(isSpareCommand('claude --bg-spare')).toBe(true);
  });

  it('never matches a real session, however suggestive its argv', () => {
    expect(isSpareCommand(SESSION_CMD)).toBe(false);
    // The flag form is what makes these safe: a directory or a prompt word
    // containing "bg-spare" is not a spare.
    expect(isSpareCommand('claude --resume x /Users/a/bg-spare/notes.md')).toBe(
      false,
    );
    expect(isSpareCommand('claude -p "explain the bg-spare pool"')).toBe(false);
    expect(isSpareCommand('')).toBe(false);
    expect(isSpareCommand(undefined as unknown as string)).toBe(false);
  });
});

describe('isProcessAlive', () => {
  it('is true for this very process and false for a reaped pid', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    // pid 0 / negatives are process-GROUP selectors in the kill(2) API and
    // must never be probed — a bare guard, not a syscall.
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(1.5)).toBe(false);
    expect(isProcessAlive(NaN)).toBe(false);
  });

  it('is true for pid 1, which exists but we may not signal (EPERM)', () => {
    expect(isProcessAlive(1)).toBe(true);
  });
});

describe('RosterFilter', () => {
  it('drops the warm-spare and the unreaped row, keeps the real session', async () => {
    const entries = parseRoster(MEASURED_SAMPLE);
    const kept = await filterWith(
      [11763, 79378],
      { 11763: SPARE_CMD, 79378: SESSION_CMD },
    ).apply(entries);

    expect(kept.map((e) => e.sessionId)).toEqual([REAL_ID]);
  });

  it('drops a row whose pid has exited', async () => {
    const entries = parseRoster(MEASURED_SAMPLE);
    // 11763 is gone; the spare probe never even runs for it.
    const kept = await filterWith([79378], { 79378: SESSION_CMD }).apply(
      entries,
    );
    expect(kept.map((e) => e.sessionId)).toEqual([REAL_ID]);
  });

  it('stands down entirely when NO row reports a pid', async () => {
    // A CLI build that stopped reporting pids must not empty the tree.
    const entries: RosterEntry[] = [
      { sessionId: SPARE_ID, name: 'a' },
      { sessionId: NOPID_ID, name: 'b' },
    ];
    const kept = await filterWith([], {}).apply(entries);
    expect(kept).toBe(entries);
  });

  it('asks ps once per pid, then answers from cache', async () => {
    const seen: number[][] = [];
    const filter = filterWith(
      [11763, 79378],
      { 11763: SPARE_CMD, 79378: SESSION_CMD },
      (pids) => seen.push([...pids]),
    );
    const entries = parseRoster(MEASURED_SAMPLE);
    await filter.apply(entries);
    await filter.apply(entries);
    await filter.apply(entries);
    expect(seen).toHaveLength(1);
    expect(seen[0].sort()).toEqual([11763, 79378]);
  });

  it('re-probes a pid after it leaves the roster, so recycling cannot poison it', async () => {
    const seen: number[][] = [];
    const cmds: Record<number, string> = { 79378: SPARE_CMD };
    const filter = filterWith([79378], cmds, (pids) => seen.push([...pids]));
    const row: RosterEntry[] = [{ sessionId: REAL_ID, pid: 79378 }];

    expect(await filter.apply(row)).toEqual([]); // classified as a spare

    // The roster goes elsewhere, evicting 79378's verdict. (That pass probes
    // nothing itself: 11763 is not alive, so it is dropped before ps.)
    await filter.apply([{ sessionId: SPARE_ID, pid: 11763 }]);
    // ...and the pid comes back as something else entirely.
    cmds[79378] = SESSION_CMD;
    expect(await filter.apply(row)).toEqual(row);
    // Probed on the first pass and again on the third — never served from a
    // verdict that outlived the pid it was about.
    expect(seen).toEqual([[79378], [79378]]);
  });

  // Regression: eviction only ran on the success path, so the two early
  // returns — an empty roster, and a roster where no row carries a pid — left
  // stale per-pid verdicts behind. Those are exactly the ticks on which pids
  // leave the roster, so a spare verdict could outlive its pid and silently
  // filter out a real session that later landed on the recycled number.
  it('evicts verdicts on a tick where the roster went empty', async () => {
    const seen: number[][] = [];
    const cmds: Record<number, string> = { 79378: SPARE_CMD };
    const filter = filterWith([79378], cmds, (pids) => seen.push([...pids]));
    const row: RosterEntry[] = [{ sessionId: REAL_ID, pid: 79378 }];

    expect(await filter.apply(row)).toEqual([]); // classified as a spare
    await filter.apply([]); // everything closed — must clear the verdict

    cmds[79378] = SESSION_CMD; // the pid is recycled by a real session
    expect(await filter.apply(row)).toEqual(row);
    expect(seen).toEqual([[79378], [79378]]);
  });

  it('evicts verdicts on a tick where no row reports a pid', async () => {
    const seen: number[][] = [];
    const cmds: Record<number, string> = { 79378: SPARE_CMD };
    const filter = filterWith([79378], cmds, (pids) => seen.push([...pids]));
    const row: RosterEntry[] = [{ sessionId: REAL_ID, pid: 79378 }];

    expect(await filter.apply(row)).toEqual([]);
    await filter.apply([{ sessionId: NOPID_ID }]); // pid-less build / tick

    cmds[79378] = SESSION_CMD;
    expect(await filter.apply(row)).toEqual(row);
    expect(seen).toEqual([[79378], [79378]]);
  });

  it('keeps a row whose argv ps could not report, rather than guessing', async () => {
    // A transient ps failure must never permanently whitelist OR drop a row.
    const seen: number[][] = [];
    const filter = filterWith([79378], {}, (pids) => seen.push([...pids]));
    const row: RosterEntry[] = [{ sessionId: REAL_ID, pid: 79378 }];
    expect(await filter.apply(row)).toEqual(row);
    // Unclassified, so the next pass asks again instead of caching a guess.
    await filter.apply(row);
    expect(seen).toHaveLength(2);
  });

  it('returns the roster untouched when the probes throw', async () => {
    const filter = new RosterFilter({
      isAlive: () => {
        throw new Error('boom');
      },
    });
    const entries = parseRoster(MEASURED_SAMPLE);
    expect(await filter.apply(entries)).toBe(entries);
  });

  it('passes an empty roster straight through', async () => {
    const empty: RosterEntry[] = [];
    expect(await filterWith([], {}).apply(empty)).toBe(empty);
  });
});

// ----------------------------------------------------------- frozen "busy"

describe('reportsBusy', () => {
  it('is true exactly for the rows normalizeStatus calls busy', () => {
    expect(reportsBusy({ sessionId: 'x', status: 'busy' })).toBe(true);
    expect(reportsBusy({ sessionId: 'x', status: 'working' })).toBe(true);
    expect(reportsBusy({ sessionId: 'x', state: 'running' })).toBe(true);
    expect(reportsBusy({ sessionId: 'x', state: 'working' })).toBe(true);
    // Case / whitespace tolerant, matching normalizeStatus.
    expect(reportsBusy({ sessionId: 'x', status: '  BUSY ' })).toBe(true);
  });

  it('is false for waiting/blocked, which win ahead of busy', () => {
    // A row can carry BOTH — waiting must never be reclassified as stale-busy.
    expect(reportsBusy({ sessionId: 'x', status: 'waiting', state: 'running' })).toBe(false);
    expect(reportsBusy({ sessionId: 'x', status: 'busy', state: 'blocked' })).toBe(false);
  });

  it('is false for idle / unknown / empty', () => {
    expect(reportsBusy({ sessionId: 'x', status: 'idle' })).toBe(false);
    expect(reportsBusy({ sessionId: 'x' })).toBe(false);
    expect(reportsBusy({ sessionId: 'x', state: 'done' })).toBe(false);
    expect(reportsBusy(null)).toBe(false);
  });
});

describe('destaleBusyStatus', () => {
  const NOW = 1_000_000_000_000;
  const WINDOW = 5 * 60_000;

  it('rewrites a frozen busy to idle once the transcript is silent past the window', () => {
    // The measured bug: interactive session, status stuck at busy, transcript
    // untouched for 22 minutes.
    const entry: RosterEntry = { sessionId: 'x', pid: 1, status: 'busy' };
    const out = destaleBusyStatus(entry, NOW - 22 * 60_000, NOW, WINDOW);
    expect(out).not.toBe(entry); // a clone
    expect(out.status).toBe('idle');
    expect(entry.status).toBe('busy'); // input never mutated
  });

  it('leaves a genuinely busy session alone while its transcript is fresh', () => {
    const entry: RosterEntry = { sessionId: 'x', pid: 1, status: 'busy' };
    const out = destaleBusyStatus(entry, NOW - 27_000, NOW, WINDOW);
    expect(out).toBe(entry); // untouched, same reference
  });

  it('clears only a busy-inducing state, so the busy branch cannot re-fire', () => {
    const entry: RosterEntry = { sessionId: 'x', pid: 1, state: 'running' };
    const out = destaleBusyStatus(entry, NOW - 10 * 60_000, NOW, WINDOW);
    expect(out.status).toBe('idle');
    expect(out.state).toBeUndefined();
    // And the downgraded row now normalises to idle in both tables.
    expect(normalizeStatus(out)).toEqual({ status: 'idle', attention: 'none' });
  });

  it('never touches waiting/blocked, idle, or non-busy rows', () => {
    const waiting: RosterEntry = { sessionId: 'x', status: 'waiting', state: 'blocked' };
    expect(destaleBusyStatus(waiting, NOW - 99 * 60_000, NOW, WINDOW)).toBe(waiting);
    const idle: RosterEntry = { sessionId: 'x', status: 'idle' };
    expect(destaleBusyStatus(idle, NOW - 99 * 60_000, NOW, WINDOW)).toBe(idle);
  });

  it('keeps the CLI claim when there is no transcript signal', () => {
    // A busy row with no locatable transcript stays busy — we never invent a
    // downgrade from the absence of a signal.
    const entry: RosterEntry = { sessionId: 'x', status: 'busy' };
    expect(destaleBusyStatus(entry, null, NOW, WINDOW)).toBe(entry);
  });

  it('is a no-op when the window is zero or negative (disabled)', () => {
    const entry: RosterEntry = { sessionId: 'x', status: 'busy' };
    expect(destaleBusyStatus(entry, NOW - 99 * 60_000, NOW, 0)).toBe(entry);
    expect(destaleBusyStatus(entry, NOW - 99 * 60_000, NOW, -1)).toBe(entry);
  });
});

describe('RosterFilter: destaling a frozen busy', () => {
  const FRESH = '11111111-1111-4111-8111-111111111111';
  const FROZEN = '22222222-2222-4222-8222-222222222222';
  const NOW = 1_000_000_000_000;

  /** A filter with both processes alive and NOT spares, plus a controlled
   *  clock, window, and per-session transcript mtime. */
  function filter(mtimes: Record<string, number | null>): RosterFilter {
    return new RosterFilter({
      isAlive: () => true,
      psCommands: (pids) =>
        Promise.resolve(new Map(pids.map((p) => [p, SESSION_CMD]))),
      transcriptMtime: (sid) => (sid in mtimes ? mtimes[sid] : null),
      now: () => NOW,
      busyStaleMs: () => 5 * 60_000,
    });
  }

  const rows: RosterEntry[] = [
    { sessionId: FRESH, pid: 101, status: 'busy' },
    { sessionId: FROZEN, pid: 102, status: 'busy' },
  ];

  it('downgrades the silent busy row to idle and leaves the writing one busy', async () => {
    const kept = await filter({
      [FRESH]: NOW - 20_000, // wrote 20s ago — genuinely working
      [FROZEN]: NOW - 22 * 60_000, // silent 22 min — frozen
    }).apply(rows);

    const byId = Object.fromEntries(kept.map((e) => [e.sessionId, e]));
    expect(byId[FRESH].status).toBe('busy');
    expect(byId[FROZEN].status).toBe('idle');
    // The whole point: the tree now paints a running dot only on FRESH.
    expect(normalizeStatus(byId[FROZEN])).toEqual({ status: 'idle', attention: 'none' });
    expect(normalizeStatus(byId[FRESH])).toEqual({ status: 'busy', attention: 'none' });
  });

  it('is stable across ticks — a destaled row does not churn the signature', async () => {
    const f = filter({ [FRESH]: NOW - 20_000, [FROZEN]: NOW - 22 * 60_000 });
    const a = await f.apply(rows);
    const b = await f.apply(rows);
    expect(sameRoster(a, b)).toBe(true);
  });

  it('leaves both busy when the phantom filter stands down (no pids)', async () => {
    // No row carries a pid → the whole filter, destale included, stays out.
    const noPids: RosterEntry[] = [{ sessionId: FROZEN, status: 'busy' }];
    const kept = await filter({ [FROZEN]: NOW - 99 * 60_000 }).apply(noPids);
    expect(kept).toBe(noPids);
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

// ═══════════════════════════ multi-config-dir roster ════════════════════════

describe('rosterEnvFor', () => {
  it('no dir / blank dir -> the parent env, SAME object, untouched', () => {
    expect(rosterEnvFor(undefined)).toBe(process.env);
    expect(rosterEnvFor('')).toBe(process.env);
    expect(rosterEnvFor('   ')).toBe(process.env);
  });

  it('a dir -> a COPY with CLAUDE_CONFIG_DIR set; process.env never mutated', () => {
    const before = process.env['CLAUDE_CONFIG_DIR'];
    const env = rosterEnvFor('/Users/x/.lineage/profiles/personal');
    expect(env).not.toBe(process.env);
    expect(env['CLAUDE_CONFIG_DIR']).toBe('/Users/x/.lineage/profiles/personal');
    expect(process.env['CLAUDE_CONFIG_DIR']).toBe(before);
  });
});

describe('fetchRosterMulti', () => {
  const RA = '0f0000a1-0000-4000-8000-0000000000a1';
  const RB = '0f0000b2-0000-4000-8000-0000000000b2';
  const RC = '0f0000c3-0000-4000-8000-0000000000c3';
  const entry = (sessionId: string, cwd?: string): RosterEntry =>
    cwd === undefined ? { sessionId } : { sessionId, cwd };
  const ok = (...entries: RosterEntry[]): RosterResult => ({
    ok: true,
    entries,
    tookMs: 1,
  });
  const bad = (error: string): RosterResult => ({
    ok: false,
    entries: [],
    error,
    tookMs: 1,
  });

  it('fetches the default dir FIRST, then each extra once — trimmed, deduped', async () => {
    const seen: Array<string | undefined> = [];
    const fetchImpl = vi.fn(async (o: { configDir?: string }): Promise<RosterResult> => {
      seen.push(o.configDir);
      return ok();
    });
    await fetchRosterMulti(
      { claudeBin: 'claude', configDirs: ['', ' /a ', '/a', '/b'] },
      fetchImpl,
    );
    expect(seen).toEqual([undefined, '/a', '/b']);
  });

  it('merges entries across dirs; on a duplicate id the DEFAULT dir wins', async () => {
    const fetchImpl = async (o: { configDir?: string }): Promise<RosterResult> => {
      if (o.configDir === undefined) return ok(entry(RA, '/from-default'));
      if (o.configDir === '/p1') return ok(entry(RA, '/from-profile'), entry(RB));
      return ok(entry(RC));
    };
    const out = await fetchRosterMulti({ configDirs: ['/p1', '/p2'] }, fetchImpl);
    expect(out.ok).toBe(true);
    expect(out.entries.map((e) => e.sessionId)).toEqual([RA, RB, RC]);
    expect(out.entries[0].cwd).toBe('/from-default');
  });

  it('a failed dir degrades that ACCOUNT, not the tree: ok if ANY succeeded, errors joined', async () => {
    const fetchImpl = async (o: { configDir?: string }): Promise<RosterResult> =>
      o.configDir === undefined ? bad('default down') : ok(entry(RB));
    const out = await fetchRosterMulti({ configDirs: ['/p1'] }, fetchImpl);
    expect(out.ok).toBe(true);
    expect(out.entries.map((e) => e.sessionId)).toEqual([RB]);
    expect(out.error).toContain('default down');
  });

  it('every dir failing is a failed fetch, entries empty', async () => {
    const fetchImpl = async (): Promise<RosterResult> => bad('boom');
    const out = await fetchRosterMulti({ configDirs: ['/p1'] }, fetchImpl);
    expect(out.ok).toBe(false);
    expect(out.entries).toEqual([]);
    expect(out.error).toBe('boom | boom');
  });

  it('with no configDirs it is ONE fetch of the default dir', async () => {
    const fetchImpl = vi.fn(async (): Promise<RosterResult> => ok(entry(RA)));
    const out = await fetchRosterMulti({}, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(out.entries.map((e) => e.sessionId)).toEqual([RA]);
  });
});
