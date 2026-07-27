// test/archive.test.ts — the M1.5 history index.
//
// Written against a temp ~/.claude/projects tree, not the real one: these
// assertions must not depend on which sessions happen to be running.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ArchiveIndexer,
  archivedAsEntries,
  archivedLabel,
  archivedOnly,
  readHeadFacts,
} from '../src/archive';
import { buildForest } from '../src/lineage';
import type { ArchivedSession, ParentResolution } from '../src/types';

const A = '0f00000a-0000-4000-8000-00000000000a';
const B = '0f00000b-0000-4000-8000-00000000000b';
const C = '0f00000c-0000-4000-8000-00000000000c';

let root: string;
let projects: string;

function writeTranscript(
  project: string,
  sessionId: string,
  lines: unknown[],
): string {
  const dir = path.join(projects, project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-archive-'));
  projects = path.join(root, 'projects');
  fs.mkdirSync(projects, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('archive: readHeadFacts', () => {
  it('picks up custom-title and the first cwd', () => {
    const f = writeTranscript('-p', A, [
      { type: 'agent-color', agentColor: 'red', sessionId: A },
      { type: 'custom-title', customTitle: 'api refactor', sessionId: A },
      { type: 'user', cwd: '/Users/x/repo', timestamp: '2026-07-01T10:00:00Z' },
    ]);
    const facts = readHeadFacts(f);
    expect(facts.label).toBe('api refactor');
    expect(facts.cwd).toBe('/Users/x/repo');
    expect(facts.firstTimestamp).toBe(Date.parse('2026-07-01T10:00:00Z'));
  });

  it('skips malformed lines instead of throwing', () => {
    const dir = path.join(projects, '-p');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${A}.jsonl`);
    fs.writeFileSync(
      f,
      'not json\n{"type":"custom-title","customTitle":"ok"}\n{"cwd":"/tmp"}\n{partial',
    );
    const facts = readHeadFacts(f);
    expect(facts.label).toBe('ok');
    expect(facts.cwd).toBe('/tmp');
  });

  it('returns empty facts for a missing or empty file', () => {
    expect(readHeadFacts(path.join(projects, 'nope.jsonl'))).toEqual({});
    const f = writeTranscript('-p', A, []);
    fs.writeFileSync(f, '');
    expect(readHeadFacts(f)).toEqual({});
  });
});

describe('archive: ArchiveIndexer', () => {
  it('indexes every transcript across project dirs', () => {
    writeTranscript('-a', A, [{ type: 'custom-title', customTitle: 'one' }]);
    writeTranscript('-b', B, [{ cwd: '/Users/x/two' }]);
    const idx = new ArchiveIndexer(projects);
    const r = idx.scan();
    expect(r.ok).toBe(true);
    expect(r.sessions.map((s) => s.sessionId).sort()).toEqual([A, B].sort());
    const a = r.sessions.find((s) => s.sessionId === A);
    expect(a?.label).toBe('one');
    expect(a?.bytes).toBeGreaterThan(0);
    expect(a?.endedAt).toBeGreaterThan(0);
  });

  it('ignores files that are not <uuid>.jsonl', () => {
    writeTranscript('-a', A, [{}]);
    fs.writeFileSync(path.join(projects, '-a', 'notes.md'), 'hi');
    fs.writeFileSync(path.join(projects, '-a', 'summary.jsonl'), '{}');
    const r = new ArchiveIndexer(projects).scan();
    expect(r.sessions.map((s) => s.sessionId)).toEqual([A]);
  });

  it('re-reads only what changed (cache keyed on mtime+size)', () => {
    writeTranscript('-a', A, [{ type: 'custom-title', customTitle: 'one' }]);
    writeTranscript('-b', B, [{ type: 'custom-title', customTitle: 'two' }]);
    const idx = new ArchiveIndexer(projects);
    expect(idx.scan().reread).toBe(2);
    expect(idx.scan().reread).toBe(0); // warm: nothing re-read

    const f = path.join(projects, '-b', `${B}.jsonl`);
    fs.appendFileSync(f, JSON.stringify({ cwd: '/changed' }) + '\n');
    fs.utimesSync(f, new Date(), new Date(Date.now() + 1000));
    expect(idx.scan().reread).toBe(1); // only the changed one
  });

  it('does not head-read live sessions (their transcript is being written)', () => {
    writeTranscript('-a', A, [{ type: 'custom-title', customTitle: 'live' }]);
    const idx = new ArchiveIndexer(projects);
    const r = idx.scan({ liveIds: new Set([A]) });
    expect(r.reread).toBe(0);
    expect(r.sessions[0]?.label).toBeUndefined();
  });

  it('survives a missing projects dir and keeps the last good index', () => {
    writeTranscript('-a', A, [{}]);
    const idx = new ArchiveIndexer(projects);
    expect(idx.scan().sessions).toHaveLength(1);
    fs.rmSync(projects, { recursive: true, force: true });
    const r = idx.scan();
    expect(r.ok).toBe(false);
    expect(r.sessions).toHaveLength(1); // previous index, not an empty tree
    expect(r.error).toBeTruthy();
  });

  it('tolerates a stray file where a project dir was expected', () => {
    writeTranscript('-a', A, [{}]);
    fs.writeFileSync(path.join(projects, 'loose-file'), 'x');
    expect(new ArchiveIndexer(projects).scan().ok).toBe(true);
  });
});

describe('archive: helpers', () => {
  const mk = (id: string, over: Partial<ArchivedSession> = {}): ArchivedSession => ({
    sessionId: id,
    transcriptPath: `/tmp/${id}.jsonl`,
    endedAt: 1000,
    bytes: 10,
    ...over,
  });

  it('archivedOnly drops sessions that are live', () => {
    const out = archivedOnly([mk(A), mk(B)], new Set([A]));
    expect(out.map((s) => s.sessionId)).toEqual([B]);
  });

  it('archivedAsEntries carries only what resolveAll needs', () => {
    const [e] = archivedAsEntries([mk(A, { cwd: '/w', startedAt: 5 })]);
    expect(e).toEqual({ sessionId: A, cwd: '/w', startedAt: 5 });
    expect('pid' in e!).toBe(false); // no pid -> the argv branch self-skips
  });

  it('archivedLabel falls back to the short id', () => {
    expect(archivedLabel(mk(A))).toBe('0f00000a');
    expect(archivedLabel(mk(A, { label: 'named' }))).toBe('named');
  });
});

describe('archive: buildForest integration', () => {
  const mk = (id: string, over: Partial<ArchivedSession> = {}): ArchivedSession => ({
    sessionId: id,
    transcriptPath: `/tmp/${id}.jsonl`,
    endedAt: 1000,
    bytes: 10,
    ...over,
  });
  const res = (m: Record<string, string | null>): Map<string, ParentResolution> => {
    const out = new Map<string, ParentResolution>();
    for (const [k, v] of Object.entries(m)) {
      out.set(k, { parentId: v, source: v ? 'forkedFrom' : 'none' });
    }
    return out;
  };

  it('renders a closed session as an archived, non-ghost node', () => {
    const f = buildForest({
      entries: [],
      archived: [mk(A, { label: 'closed one', cwd: '/w', startedAt: 1 })],
      resolutions: res({ [A]: null }),
      records: {},
    });
    const n = f.nodes.get(A)!;
    expect(n.archived).toBe(true);
    expect(n.ghost).toBe(false);
    expect(n.status).toBe('exited');
    expect(n.label).toBe('closed one');
    expect(n.endedAt).toBe(1000);
    expect(f.visibleRoots).toContain(A); // survives ghost pruning
  });

  it('a live row always wins over its archived twin (no duplicate)', () => {
    const f = buildForest({
      entries: [{ sessionId: A, name: 'live one', status: 'idle' }],
      archived: [mk(A, { label: 'stale' })],
      resolutions: res({ [A]: null }),
      records: {},
    });
    expect(f.nodes.get(A)!.archived).toBe(false);
    expect(f.nodes.get(A)!.label).toBe('live one');
    expect(f.roots.filter((r) => r === A)).toHaveLength(1);
  });

  it('an archived parent replaces what would have been a ghost', () => {
    const withArchive = buildForest({
      entries: [{ sessionId: B, name: 'child', status: 'idle' }],
      archived: [mk(A, { label: 'the parent' })],
      resolutions: res({ [B]: A, [A]: null }),
      records: {},
    });
    const parent = withArchive.nodes.get(A)!;
    expect(parent.ghost).toBe(false);
    expect(parent.archived).toBe(true);
    expect(parent.label).toBe('the parent');
    expect(parent.visibleChildren).toEqual([B]);

    // Without the archive it degrades to the old "(gone)" ghost.
    const withoutArchive = buildForest({
      entries: [{ sessionId: B, name: 'child', status: 'idle' }],
      resolutions: res({ [B]: A, [A]: null }),
      records: {},
    });
    expect(withoutArchive.nodes.get(A)!.ghost).toBe(true);
  });

  it('sorts archived roots after live ones, most recent first', () => {
    const f = buildForest({
      entries: [{ sessionId: C, name: 'live', status: 'idle', startedAt: 9_000 }],
      archived: [
        mk(A, { label: 'older', endedAt: 100 }),
        mk(B, { label: 'newer', endedAt: 900 }),
      ],
      resolutions: res({ [A]: null, [B]: null, [C]: null }),
      records: {},
    });
    expect(f.visibleRoots).toEqual([C, B, A]);
  });

  it('an editorial title still wins over the archive label', () => {
    const f = buildForest({
      entries: [],
      archived: [mk(A, { label: 'from disk' })],
      resolutions: res({ [A]: null }),
      records: {
        [A]: { id: A, title: 'my name', createdAt: 'x', updatedAt: 'x' },
      },
    });
    expect(f.nodes.get(A)!.label).toBe('my name');
  });

  it('archived nodes never count toward the attention badge', () => {
    const f = buildForest({
      entries: [],
      archived: [mk(A), mk(B)],
      resolutions: res({ [A]: null, [B]: null }),
      records: {},
    });
    expect(f.attentionCount).toBe(0);
  });
});
