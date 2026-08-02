// Owner A. Transcript location + the fork scan + header metadata.
// Every row of the SPEC §6 fixture/branch traceability table is pinned here.

import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  forkParentFromTranscript,
  hasTranscript,
  readTranscriptHeader,
  transcriptFile,
  transcriptMtimeMs,
} from '../src/transcript';
import { FORK_HEAD_LINES } from '../src/types';

const FIXTURES = path.join(__dirname, 'fixtures', 'transcripts');
const fx = (name: string): string => path.join(FIXTURES, name);

const NF_PARENT = '0f0000a1-0000-4000-8000-0000000000a1';
const CLI_PARENT = '0f0000a4-0000-4000-8000-0000000000a4';
const NEST_PARENT = '0f0000a5-0000-4000-8000-0000000000a5';
const HEADLESS_ID = '0f000006-0000-4000-8000-000000000006';

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Scan a fixture by path, both modes. */
function scan(fixture: string, sessionId: string, deep: boolean): string | null {
  return forkParentFromTranscript(sessionId, { hint: fx(fixture), deep });
}

describe('forkParentFromTranscript: the fixture traceability table', () => {
  it('root.jsonl — no signal at all, both modes', () => {
    expect(scan('root.jsonl', 'root', false)).toBeNull();
    expect(scan('root.jsonl', 'root', true)).toBeNull();
  });

  it('native_fork.jsonl — forkedFrom on line 1 resolves in the head scan', () => {
    expect(scan('native_fork.jsonl', 'child', false)).toBe(NF_PARENT);
    expect(scan('native_fork.jsonl', 'child', true)).toBe(NF_PARENT);
  });

  it('nested_fork.jsonl — the FIRST forkedFrom wins over a deeper ancestor value', () => {
    expect(scan('nested_fork.jsonl', 'child', false)).toBe(NEST_PARENT);
    expect(scan('nested_fork.jsonl', 'child', false)).not.toBe(
      '0f0000b5-0000-4000-8000-0000000000b5',
    );
  });

  it('cli_fork.jsonl — only the deep snake/camel scan sees it', () => {
    expect(scan('cli_fork.jsonl', 'child', true)).toBe(CLI_PARENT);
    expect(scan('cli_fork.jsonl', 'child', false)).toBeNull();
  });

  it('cli_fork_compact.jsonl — a compaction boundary aborts the deep scan', () => {
    expect(scan('cli_fork_compact.jsonl', 'child', true)).toBeNull();
    expect(scan('cli_fork_compact.jsonl', 'child', false)).toBeNull();
  });

  it('compact_successor.jsonl — a continuation is never a fork, both modes', () => {
    expect(scan('compact_successor.jsonl', 'self', false)).toBeNull();
    expect(scan('compact_successor.jsonl', 'self', true)).toBeNull();
  });

  it('headless_fork.jsonl — no safe transcript signal survives (plan risk #5)', () => {
    // Every line carries the CHILD's own sessionId; no forkedFrom, no snake
    // session_id. The copied message uuids are deliberately never used.
    expect(scan('headless_fork.jsonl', HEADLESS_ID, false)).toBeNull();
    expect(scan('headless_fork.jsonl', HEADLESS_ID, true)).toBeNull();
  });

  it('empty.jsonl — an empty file scans to null', () => {
    expect(scan('empty.jsonl', 'whatever', false)).toBeNull();
    expect(scan('empty.jsonl', 'whatever', true)).toBeNull();
  });

  it('malformed.jsonl — garbage lines are skipped, nothing throws', () => {
    expect(() => scan('malformed.jsonl', 'x', false)).not.toThrow();
    expect(scan('malformed.jsonl', 'x', false)).toBeNull();
    expect(scan('malformed.jsonl', 'x', true)).toBeNull();
  });
});

describe('forkParentFromTranscript: bounds and guards', () => {
  it('stops the head scan at FORK_HEAD_LINES; the deep scan still finds it', () => {
    const dir = tempDir('lineage-head-');
    const file = path.join(dir, 'late.jsonl');
    const filler = Array.from({ length: FORK_HEAD_LINES }, () =>
      JSON.stringify({
        type: 'user',
        uuid: 'u',
        sessionId: '0f000009-0000-4000-8000-000000000009',
      }),
    );
    filler.push(
      JSON.stringify({
        type: 'attachment',
        sessionId: '0f000009-0000-4000-8000-000000000009',
        forkedFrom: { sessionId: NF_PARENT, messageUuid: 'm1' },
      }),
    );
    fs.writeFileSync(file, `${filler.join('\n')}\n`);

    expect(forkParentFromTranscript('child', { hint: file })).toBeNull();
    expect(forkParentFromTranscript('child', { hint: file, deep: true })).toBe(
      NF_PARENT,
    );
  });

  it('never returns the session itself as its own parent', () => {
    const dir = tempDir('lineage-self-');
    const file = path.join(dir, 'self.jsonl');
    fs.writeFileSync(
      file,
      `${JSON.stringify({
        type: 'attachment',
        sessionId: NF_PARENT,
        forkedFrom: { sessionId: NF_PARENT },
      })}\n`,
    );
    expect(forkParentFromTranscript(NF_PARENT, { hint: file })).toBeNull();
  });

  it('returns null (never throws) when the transcript cannot be found', () => {
    const dir = tempDir('lineage-empty-projects-');
    expect(
      forkParentFromTranscript('0f000001-0000-4000-8000-000000000001', {
        projectsDir: path.join(dir, 'nope'),
      }),
    ).toBeNull();
  });

  it('tolerates a truncated final line', () => {
    const dir = tempDir('lineage-trunc-');
    const file = path.join(dir, 'trunc.jsonl');
    fs.writeFileSync(
      file,
      `${JSON.stringify({ type: 'user', sessionId: 'a' })}\n{"type": "user", "session`,
    );
    expect(() => forkParentFromTranscript('child', { hint: file })).not.toThrow();
    expect(forkParentFromTranscript('child', { hint: file })).toBeNull();
  });
});

describe('transcriptFile / hasTranscript', () => {
  it('prefers a hint that names a real file', () => {
    const hint = fx('root.jsonl');
    expect(transcriptFile('any-id', { hint })).toBe(hint);
    expect(hasTranscript('any-id', { hint })).toBe(true);
  });

  it('falls back to the projectsDir glob when the hint is bogus', () => {
    const projectsDir = tempDir('lineage-projects-');
    const project = path.join(projectsDir, '-Users-axelh-code');
    fs.mkdirSync(project);
    const sid = '0f000010-0000-4000-8000-000000000010';
    const file = path.join(project, `${sid}.jsonl`);
    fs.writeFileSync(file, '');

    expect(
      transcriptFile(sid, { hint: '/no/such/file.jsonl', projectsDir }),
    ).toBe(file);
    expect(transcriptFile(sid, { projectsDir })).toBe(file);
    expect(hasTranscript(sid, { projectsDir })).toBe(true);
  });

  it('returns null for an unknown id with no hint', () => {
    const projectsDir = tempDir('lineage-projects-');
    fs.mkdirSync(path.join(projectsDir, 'proj'));
    expect(
      transcriptFile('0f0000ee-0000-4000-8000-0000000000ee', { projectsDir }),
    ).toBeNull();
    expect(
      hasTranscript('0f0000ee-0000-4000-8000-0000000000ee', { projectsDir }),
    ).toBe(false);
  });

  it('returns null when projectsDir does not exist', () => {
    expect(
      transcriptFile('0f0000ee-0000-4000-8000-0000000000ee', {
        projectsDir: '/definitely/not/here',
      }),
    ).toBeNull();
  });

  it('refuses an id that would escape projectsDir', () => {
    const projectsDir = tempDir('lineage-projects-');
    expect(transcriptFile('../../etc/passwd', { projectsDir })).toBeNull();
    expect(transcriptFile('', { projectsDir })).toBeNull();
  });
});

describe('transcriptMtimeMs', () => {
  it('returns the file mtime for a located transcript', () => {
    const projectsDir = tempDir('lineage-projects-');
    const project = path.join(projectsDir, '-Users-axelh-code');
    fs.mkdirSync(project);
    const sid = '0f000020-0000-4000-8000-000000000020';
    const file = path.join(project, `${sid}.jsonl`);
    fs.writeFileSync(file, '{}');
    const past = Date.now() - 3_600_000;
    fs.utimesSync(file, past / 1000, past / 1000);

    const mtime = transcriptMtimeMs(sid, { projectsDir });
    expect(mtime).not.toBeNull();
    // Filesystems vary in mtime resolution; a second of slack is plenty.
    expect(Math.abs((mtime as number) - past)).toBeLessThan(1000);
  });

  it('returns null when no transcript can be located', () => {
    const projectsDir = tempDir('lineage-projects-');
    expect(
      transcriptMtimeMs('0f0000ee-0000-4000-8000-0000000000ee', { projectsDir }),
    ).toBeNull();
    // A path-escaping id never even stats.
    expect(transcriptMtimeMs('../../etc/passwd', { projectsDir })).toBeNull();
  });
});

describe('readTranscriptHeader', () => {
  it('returns {} for a transcript with no header records', () => {
    expect(readTranscriptHeader('root', { hint: fx('root.jsonl') })).toEqual({});
  });

  it('returns {} and does not throw when there is no transcript', () => {
    expect(
      readTranscriptHeader('nope', { projectsDir: '/definitely/not/here' }),
    ).toEqual({});
  });

  it('does not throw on malformed lines', () => {
    expect(() =>
      readTranscriptHeader('x', { hint: fx('malformed.jsonl') }),
    ).not.toThrow();
  });

  it('extracts the four header records, last write wins', () => {
    const dir = tempDir('lineage-header-');
    const file = path.join(dir, 'hdr.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'custom-title', customTitle: 'first title' }),
        JSON.stringify({ type: 'agent-color', color: 'cyan' }),
        JSON.stringify({ type: 'agent-name', value: 'scout' }),
        JSON.stringify({ type: 'mode', mode: 'plan' }),
        'garbage line',
        JSON.stringify({ type: 'custom-title', title: 'second title' }),
        JSON.stringify({ type: 'custom-title', title: '' }), // empty never wins
      ].join('\n'),
    );
    expect(readTranscriptHeader('x', { hint: file })).toEqual({
      customTitle: 'second title',
      agentColor: 'cyan',
      agentName: 'scout',
      mode: 'plan',
    });
  });

  it('reads the mode record the headless fixture happens to carry', () => {
    expect(
      readTranscriptHeader(HEADLESS_ID, { hint: fx('headless_fork.jsonl') }).mode,
    ).toBe('default');
  });
});

// ═════════════════════════ M22.3: extra projects roots ══════════════════════

describe('transcriptFile: extraProjectsDirs (M22.3)', () => {
  const ID = '0f0000d7-0000-4000-8000-0000000000d7';

  function writeAt(projectsRoot: string, sessionId: string, body: string): string {
    const dir = path.join(projectsRoot, '-proj');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, body);
    return file;
  }

  it('finds a transcript that lives only in a profile root', () => {
    const primary = tempDir('lineage-primary-');
    const profile = tempDir('lineage-profile-');
    const file = writeAt(profile, ID, '{"cwd":"/x"}\n');
    expect(
      transcriptFile(ID, { projectsDir: primary, extraProjectsDirs: [profile] }),
    ).toBe(file);
    expect(
      hasTranscript(ID, { projectsDir: primary, extraProjectsDirs: [profile] }),
    ).toBe(true);
  });

  it('the primary root wins when both hold the id', () => {
    const primary = tempDir('lineage-primary-');
    const profile = tempDir('lineage-profile-');
    const primaryFile = writeAt(primary, ID, '{"cwd":"/primary"}\n');
    writeAt(profile, ID, '{"cwd":"/profile"}\n');
    expect(
      transcriptFile(ID, { projectsDir: primary, extraProjectsDirs: [profile] }),
    ).toBe(primaryFile);
  });

  it('an unreadable extra root is skipped, not fatal', () => {
    const primary = tempDir('lineage-primary-');
    expect(
      transcriptFile(ID, {
        projectsDir: primary,
        extraProjectsDirs: [path.join(primary, 'nope', 'projects')],
      }),
    ).toBeNull();
  });
});
