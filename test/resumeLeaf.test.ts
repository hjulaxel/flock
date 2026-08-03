// Resume-leaf repair. Pins the bug this module exists for: claude picks the
// message a `--resume` / `--fork-session` walks back from out of the
// transcript's `last-prompt` records, those are written MID-TURN and never
// corrected, so a fork inherits its parent's last turn only as far as its first
// tool result. Verified against claude 2.1.220 by forking a real session and
// diffing the child transcript against the parent.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { repairResumeLeaf } from '../src/resumeLeaf';

const SESSION = 'a1a8c30e-0000-4000-8000-000000000001';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A projects root holding one transcript, laid out the way claude does. */
function withTranscript(lines: unknown[], sessionId = SESSION): {
  projectsDir: string;
  file: string;
} {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leaf-'));
  tempDirs.push(projectsDir);
  const project = path.join(projectsDir, '-Users-x-proj');
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  // The freshness gate treats a just-written transcript as one a live claude is
  // mid-turn on. Age it past the quiet window.
  const old = Date.now() / 1000 - 60;
  fs.utimesSync(file, old, old);
  return { projectsDir, file };
}

function msg(
  uuid: string,
  parentUuid: string | null,
  type: string,
  timestamp: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { uuid, parentUuid, type, timestamp, sessionId: SESSION, ...extra };
}

function leafRecords(file: string): unknown[] {
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => r['type'] === 'last-prompt');
}

/**
 * The shape that shipped the bug: a turn that made two tool calls, whose
 * `last-prompt` landed between the two tool results. `u5`/`u6` — the assistant's
 * actual answer — hang off the SECOND result, so the recorded leaf (`u3`)
 * cannot reach them.
 */
const STALE = [
  msg('u1', null, 'user', '2026-08-03T07:52:07.000Z'),
  msg('u2', 'u1', 'assistant', '2026-08-03T07:52:15.000Z'),
  msg('u3', 'u2', 'user', '2026-08-03T07:52:20.000Z'),   // first tool result
  { type: 'last-prompt', lastPrompt: 'give me a list', leafUuid: 'u3', sessionId: SESSION },
  msg('u4', 'u2', 'user', '2026-08-03T07:52:22.000Z'),   // second tool result
  msg('u5', 'u4', 'assistant', '2026-08-03T07:52:38.000Z'),
  msg('u6', 'u5', 'assistant', '2026-08-03T07:52:53.000Z'), // the final answer
  msg('u7', 'u6', 'system', '2026-08-03T07:55:57.000Z', { subtype: 'away_summary' }),
];

describe('repairResumeLeaf', () => {
  it('repoints a mid-turn leaf at the last real message', () => {
    const { projectsDir, file } = withTranscript(STALE);
    const report = repairResumeLeaf(SESSION, { projectsDir });

    expect(report.repaired).toBe(true);
    expect(report.staleLeaf).toBe('u3');
    expect(report.tip).toBe('u6');
    expect(report.gained).toBeGreaterThan(0);

    const appended = leafRecords(file).at(-1) as Record<string, unknown>;
    expect(appended['leafUuid']).toBe('u6');
    expect(appended['sessionId']).toBe(SESSION);
    // Carried over so the CLI's own --resume picker keeps its label.
    expect(appended['lastPrompt']).toBe('give me a list');
  });

  it('names a user/assistant record, never the trailing system ones', () => {
    // Naming a non-message uuid is the one way this could make things WORSE:
    // one of claude's load paths selects with `leafUuids.has(uuid) && (type ===
    // 'user' || type === 'assistant')` and, finding nothing, reports the
    // transcript as having no conversation at all.
    const { projectsDir } = withTranscript(STALE);
    const report = repairResumeLeaf(SESSION, { projectsDir });
    expect(report.tip).toBe('u6'); // not u7, the away_summary
  });

  it('appends only — nothing already in the transcript is touched', () => {
    const { projectsDir, file } = withTranscript(STALE);
    const before = fs.readFileSync(file, 'utf-8');
    repairResumeLeaf(SESSION, { projectsDir });
    const after = fs.readFileSync(file, 'utf-8');
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length).split('\n').filter((l) => l !== ''))
      .toHaveLength(1);
  });

  it('is idempotent — a second call finds the leaf already correct', () => {
    const { projectsDir, file } = withTranscript(STALE);
    expect(repairResumeLeaf(SESSION, { projectsDir }).repaired).toBe(true);
    const afterFirst = fs.readFileSync(file, 'utf-8');
    const age = Date.now() / 1000 - 60;
    fs.utimesSync(file, age, age);

    const second = repairResumeLeaf(SESSION, { projectsDir });
    expect(second.repaired).toBe(false);
    expect(second.skipped).toBe('already-tip');
    expect(fs.readFileSync(file, 'utf-8')).toBe(afterFirst);
  });

  it('leaves a healthy transcript alone', () => {
    const { projectsDir, file } = withTranscript([
      msg('u1', null, 'user', '2026-08-03T07:52:07.000Z'),
      msg('u2', 'u1', 'assistant', '2026-08-03T07:52:15.000Z'),
      { type: 'last-prompt', leafUuid: 'u2', sessionId: SESSION },
    ]);
    const before = fs.readFileSync(file, 'utf-8');
    const report = repairResumeLeaf(SESSION, { projectsDir });
    expect(report.repaired).toBe(false);
    expect(report.skipped).toBe('already-tip');
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });

  it('leaves a transcript with no last-prompt record alone', () => {
    // claude already falls back to the newest message when there is no recorded
    // leaf, which is the behaviour this module restores. Writing here would add
    // risk and buy nothing.
    const { projectsDir, file } = withTranscript([
      msg('u1', null, 'user', '2026-08-03T07:52:07.000Z'),
      msg('u2', 'u1', 'assistant', '2026-08-03T07:52:15.000Z'),
    ]);
    const before = fs.readFileSync(file, 'utf-8');
    const report = repairResumeLeaf(SESSION, { projectsDir });
    expect(report.skipped).toBe('no-leaf-record');
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });

  it('refuses to resurrect a /clear-ed conversation', () => {
    const { projectsDir, file } = withTranscript([
      ...STALE,
      { type: 'last-prompt', leafUuid: null, explicit: true, sessionId: SESSION },
    ]);
    const before = fs.readFileSync(file, 'utf-8');
    const report = repairResumeLeaf(SESSION, { projectsDir });
    expect(report.repaired).toBe(false);
    expect(report.skipped).toBe('cleared');
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });

  it('ignores records dropped by a compaction boundary', () => {
    // A boundary that preserved nothing resets the parse: the pre-boundary
    // messages and the leaf pointing into them are gone, so there is no stale
    // leaf left to repair.
    const { projectsDir, file } = withTranscript([
      ...STALE,
      { type: 'system', subtype: 'compact_boundary', uuid: 'c1', timestamp: '2026-08-03T08:00:00.000Z' },
      msg('u8', null, 'assistant', '2026-08-03T08:00:01.000Z'),
    ]);
    const before = fs.readFileSync(file, 'utf-8');
    const report = repairResumeLeaf(SESSION, { projectsDir });
    expect(report.skipped).toBe('no-leaf-record');
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });

  it('skips a transcript being written to right now', () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leaf-'));
    tempDirs.push(projectsDir);
    const project = path.join(projectsDir, '-Users-x-proj');
    fs.mkdirSync(project, { recursive: true });
    const file = path.join(project, `${SESSION}.jsonl`);
    fs.writeFileSync(file, STALE.map((l) => JSON.stringify(l)).join('\n') + '\n');
    // No utimes: mtime is now, so a live writer is presumed mid-turn.
    const before = fs.readFileSync(file, 'utf-8');
    expect(repairResumeLeaf(SESSION, { projectsDir }).skipped).toBe('writing');
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });

  it('skips a session with no transcript', () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leaf-'));
    tempDirs.push(projectsDir);
    expect(repairResumeLeaf(SESSION, { projectsDir }).skipped).toBe('no-transcript');
  });

  it('survives malformed lines', () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leaf-'));
    tempDirs.push(projectsDir);
    const project = path.join(projectsDir, '-Users-x-proj');
    fs.mkdirSync(project, { recursive: true });
    const file = path.join(project, `${SESSION}.jsonl`);
    fs.writeFileSync(
      file,
      STALE.map((l) => JSON.stringify(l)).join('\n') + '\n{"truncated":',
    );
    const age = Date.now() / 1000 - 60;
    fs.utimesSync(file, age, age);
    const report = repairResumeLeaf(SESSION, { projectsDir });
    expect(report.repaired).toBe(true);
    expect(report.tip).toBe('u6');
  });

  it('ignores subagent (sidechain) messages when choosing the tip', () => {
    const { projectsDir } = withTranscript([
      ...STALE,
      msg('s1', 'u6', 'assistant', '2026-08-03T09:00:00.000Z', { isSidechain: true }),
    ]);
    const report = repairResumeLeaf(SESSION, { projectsDir });
    expect(report.tip).toBe('u6');
  });
});
