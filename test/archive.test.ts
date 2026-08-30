// test/archive.test.ts — the history index: sessions the CLI's live roster has
// forgotten, recovered from the transcripts left on disk.
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
  continuationOf,
  keptArchived,
  memberKeepIds,
  PROMPT_LABEL_MAX_CHARS,
  readHeadFacts,
  transcriptFallbackName,
  unlistedPool,
} from '../src/archive';
import { buildForest } from '../src/lineage';
import type {
  ArchivedSession,
  EditorialRecord,
  ParentResolution,
  RosterEntry,
} from '../src/types';

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

  // The name a closed row falls back to. Both of these are READ here and
  // ranked by the caller — the reader has no opinion about precedence, which
  // is what lets buildForest put an editorial title above either of them.
  it('picks up the CLI’s own generated title', () => {
    const f = writeTranscript('-p', A, [
      { type: 'mode', sessionId: A },
      { type: 'ai-title', aiTitle: 'Fix auth bug and score drift' },
      { type: 'user', message: { content: 'hello' }, cwd: '/w' },
    ]);
    const facts = readHeadFacts(f);
    expect(facts.aiTitle).toBe('Fix auth bug and score drift');
    expect(facts.label).toBeUndefined();
  });

  it('reads a chosen title and a generated one side by side', () => {
    const f = writeTranscript('-p', A, [
      { type: 'custom-title', customTitle: 'api refactor' },
      { type: 'ai-title', aiTitle: 'Fix auth bug' },
    ]);
    const facts = readHeadFacts(f);
    expect(facts.label).toBe('api refactor');
    expect(facts.aiTitle).toBe('Fix auth bug');
  });

  // First-wins, which on real data is also last-wins: 144 of the transcripts
  // on this machine carry the record more than once and not one of them ever
  // emits a different string.
  it('takes the first ai-title when the CLI re-emits it', () => {
    const f = writeTranscript('-p', A, [
      { type: 'ai-title', aiTitle: 'first' },
      { type: 'ai-title', aiTitle: 'second' },
      { type: 'ai-title', aiTitle: 'third' },
    ]);
    expect(readHeadFacts(f).aiTitle).toBe('first');
  });

  it('takes the first thing a PERSON typed, past the CLI’s own preamble', () => {
    const f = writeTranscript('-p', A, [
      { type: 'mode', sessionId: A },
      {
        type: 'user',
        isMeta: true,
        message: { content: '<local-command-caveat>…</local-command-caveat>' },
      },
      {
        type: 'user',
        message: { content: 'why is the roster\n  poll firing twice' },
        cwd: '/w',
      },
    ]);
    expect(readHeadFacts(f).firstPrompt).toBe(
      'why is the roster poll firing twice',
    );
  });

  it('refuses every shape that is not something a person typed', () => {
    const cases: Record<string, unknown> = {
      toolResult: { type: 'user', toolUseResult: {}, message: { content: 'x' } },
      sidechain: { type: 'user', isSidechain: true, message: { content: 'x' } },
      compaction: {
        type: 'user',
        isCompactSummary: true,
        message: { content: 'This session is being continued from…' },
      },
      bashEcho: {
        type: 'user',
        message: { content: '<bash-input>creemux br test 2</bash-input>' },
      },
    };
    for (const [name, rec] of Object.entries(cases)) {
      const f = writeTranscript('-p', A, [{ type: 'mode' }, rec]);
      expect(readHeadFacts(f).firstPrompt, name).toBeUndefined();
    }
  });

  // The one envelope worth keeping: the name inside it IS what was typed.
  it('unwraps a slash command to the command itself', () => {
    const f = writeTranscript('-p', A, [
      {
        type: 'user',
        message: {
          content:
            '<command-name>/terminal-setup</command-name><command-message>x</command-message>',
        },
      },
    ]);
    expect(readHeadFacts(f).firstPrompt).toBe('/terminal-setup');
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

  // Regression: the cache was keyed on (mtime, size, path) only, so the
  // fact-less row cached during the live scan was still a "hit" after the
  // session closed — and a closed transcript never changes again, so the
  // archived row lost its cwd and title for the lifetime of the window.
  it('re-reads the head once a scanned-while-live session goes archived', () => {
    writeTranscript('-a', A, [
      { type: 'custom-title', customTitle: 'api refactor' },
      { type: 'user', cwd: '/Users/x/repo' },
    ]);
    const idx = new ArchiveIndexer(projects);

    const live = idx.scan({ liveIds: new Set([A]) });
    expect(live.reread).toBe(0);
    expect(live.sessions[0]?.label).toBeUndefined();
    expect(live.sessions[0]?.cwd).toBeUndefined();

    // The session closes. The transcript is untouched — same mtime, same size.
    const closed = idx.scan({ liveIds: new Set<string>() });
    expect(closed.reread).toBe(1);
    expect(closed.sessions[0]?.label).toBe('api refactor');
    expect(closed.sessions[0]?.cwd).toBe('/Users/x/repo');

    // ...and the now-complete entry is cached, so it is read exactly once.
    expect(idx.scan({ liveIds: new Set<string>() }).reread).toBe(0);
  });

  // The two new head facts ride that same rule and add NOTHING to the cache
  // key: they come from the same bytes as `label` and `cwd`, so any change that
  // could alter them has already moved (mtimeMs, size). This matters most for
  // ai-title, which the CLI writes early in a conversation that is still
  // running — so the first scan after it closes is the first scan that can see
  // it at all.
  it('picks up the generated title on the scan after a live session closes', () => {
    writeTranscript('-a', A, [
      { type: 'ai-title', aiTitle: 'Debug Mars database connection' },
      { type: 'user', message: { content: 'the mars box is refusing me' } },
    ]);
    const idx = new ArchiveIndexer(projects);

    const live = idx.scan({ liveIds: new Set([A]) });
    expect(live.sessions[0]?.aiTitle).toBeUndefined();
    expect(live.sessions[0]?.firstPrompt).toBeUndefined();

    // Same file, same mtime, same size — only its liveness changed.
    const closed = idx.scan({ liveIds: new Set<string>() });
    expect(closed.sessions[0]?.aiTitle).toBe('Debug Mars database connection');
    expect(closed.sessions[0]?.firstPrompt).toBe(
      'the mars box is refusing me',
    );
    // Cached from here on, exactly as label and cwd are.
    expect(idx.scan({ liveIds: new Set<string>() }).reread).toBe(0);
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

  it('transcriptMtimes() covers a live id and a closed id alike', () => {
    writeTranscript('-a', A, [{ type: 'custom-title', customTitle: 'live' }]);
    writeTranscript('-b', B, [{ type: 'custom-title', customTitle: 'closed' }]);
    const idx = new ArchiveIndexer(projects);
    idx.scan({ liveIds: new Set([A]) });
    const mtimes = idx.transcriptMtimes();
    expect(mtimes.get(A)).toBeGreaterThan(0);
    expect(mtimes.get(B)).toBeGreaterThan(0);
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

  // A generated title is a NAME; an opening prompt is a QUOTATION. The `{ text,
  // fallback }` shape is what lets a row show the difference with quote marks
  // and lets code (terminal-tab naming, the archive picker) act on it.
  describe('transcriptFallbackName', () => {
    it('shows a generated title bare', () => {
      expect(transcriptFallbackName({ aiTitle: 'Fix auth bug' })).toEqual({
        text: 'Fix auth bug',
        fallback: false,
      });
    });

    it('quotes an opening prompt, and says it is a fallback', () => {
      expect(transcriptFallbackName({ firstPrompt: 'cd ..' })).toEqual({
        text: '“cd ..”',
        fallback: true,
      });
    });

    it('prefers the generated title over the prompt', () => {
      expect(
        transcriptFallbackName({ aiTitle: 'Fix auth bug', firstPrompt: 'cd ..' })
          ?.text,
      ).toBe('Fix auth bug');
    });

    it('cuts a long prompt INSIDE the quotes', () => {
      const got = transcriptFallbackName({ firstPrompt: 'z'.repeat(200) });
      expect(got?.text.startsWith('“')).toBe(true);
      expect(got?.text.endsWith('…”')).toBe(true);
      // Quotes are two characters on top of the capped text.
      expect(got?.text.length).toBe(PROMPT_LABEL_MAX_CHARS + 2);
    });

    it('is undefined when the transcript offered neither', () => {
      expect(transcriptFallbackName({})).toBeUndefined();
    });
  });

  it('archivedLabel prefers a chosen title, then a generated one, then a quote', () => {
    expect(
      archivedLabel(mk(A, { label: 'named', aiTitle: 'generated' })),
    ).toBe('named');
    expect(
      archivedLabel(mk(A, { aiTitle: 'generated', firstPrompt: 'cd ..' })),
    ).toBe('generated');
    expect(archivedLabel(mk(A, { firstPrompt: 'cd ..' }))).toBe('“cd ..”');
  });

  // Tree membership is editorial: a session with a non-deleted record
  // keeps its row when its terminal closes — the row flips to inactive rather
  // than leaving the tree. keepIds carries that membership past the
  // `showArchived` gate.
  describe('keptArchived', () => {
    const none = new Set<string>();

    it('returns nothing when history is off and nothing is a member', () => {
      expect(
        keptArchived([mk(A), mk(B)], none, { showArchived: false }),
      ).toEqual([]);
      expect(
        keptArchived([mk(A), mk(B)], none, {
          showArchived: false,
          keepIds: none,
        }),
      ).toEqual([]);
    });

    it('keeps a MEMBER session even with history off', () => {
      const out = keptArchived([mk(A), mk(B)], none, {
        showArchived: false,
        keepIds: new Set([B]),
      });
      // Without this a session's row would vanish on the roster tick after its
      // tab closed — the "closed tab = gone from the tree" behaviour that keepIds
      // exists to prevent.
      expect(out.map((s) => s.sessionId)).toEqual([B]);
    });

    it('returns every non-live session when history is on', () => {
      const out = keptArchived([mk(A), mk(B)], none, { showArchived: true });
      expect(out.map((s) => s.sessionId)).toEqual([A, B]);
    });

    it('never returns a live session, member or not', () => {
      // A live row already exists for it; the archived twin would duplicate it.
      expect(
        keptArchived([mk(A)], new Set([A]), {
          showArchived: false,
          keepIds: new Set([A]),
        }),
      ).toEqual([]);
      expect(keptArchived([mk(A)], new Set([A]), { showArchived: true })).toEqual(
        [],
      );
    });

    it('ignores a kept id with no transcript behind it', () => {
      const out = keptArchived([mk(A)], none, {
        showArchived: false,
        keepIds: new Set([C]),
      });
      expect(out).toEqual([]);
    });
  });

  // Which records earn membership, and how chain re-keys route.
  describe('memberKeepIds', () => {
    const rec = (id: string, over: Partial<EditorialRecord> = {}): EditorialRecord => ({
      id,
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z',
      ...over,
    });
    const self = (id: string): string => id;

    it('every non-deleted record is a member; deleted ones are not', () => {
      const keep = memberKeepIds(
        {
          [A]: rec(A, { title: 'kept' }),
          [B]: rec(B, { deleted: true }),
          [C]: rec(C, { closed: '2026-07-29T00:00:00.000Z' }),
        },
        self,
      );
      // A record is the evidence the session was ever the user's — a closed
      // stamp included: CLOSE ends the tab, never the row.
      expect(keep).toEqual(new Set([A, C]));
    });

    it('routes a record on a superseded generation to its chain tip', () => {
      const keep = memberKeepIds({ [A]: rec(A) }, (id) => (id === A ? B : id));
      // Both ids survive: the tip is the row the collapse keeps, the original
      // id still matters while the index has not caught up.
      expect(keep).toEqual(new Set([A, B]));
    });

    it('a chat record contributes neither its own id nor its chain tip', () => {
      // Without this skip, a chat would come back as an inactive "closed" row
      // the moment its tab shut — the exact row the feature exists to avoid.
      const keep = memberKeepIds(
        { [A]: rec(A, { chat: true }), [C]: rec(C) },
        (id) => (id === A ? B : id),
      );
      expect(keep).toEqual(new Set([C]));
    });
  });
});

// What the Add Session / Import pickers offer: everything this machine knows
// that the tree is not showing — the other half of keptArchived.
describe('unlistedPool', () => {
  const D = '0f00000d-0000-4000-8000-00000000000d';
  const mk = (id: string, over: Partial<ArchivedSession> = {}): ArchivedSession => ({
    sessionId: id,
    transcriptPath: `/tmp/${id}.jsonl`,
    endedAt: 1000,
    bytes: 10,
    ...over,
  });
  const rec = (id: string, over: Partial<EditorialRecord> = {}): EditorialRecord => ({
    id,
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    ...over,
  });
  const entry = (id: string, over: Partial<RosterEntry> = {}): RosterEntry => ({
    sessionId: id,
    ...over,
  });
  const self = (id: string): string => id;
  const none = new Set<string>();

  it('lists a foreign live row once, with what the roster knew', () => {
    const out = unlistedPool({
      entries: [entry(A, { cwd: '/w', name: 'ranking' })],
      archived: [],
      records: {},
      tipOf: self,
      shownIds: none,
    });
    expect(out).toEqual([
      { sessionId: A, live: true, cwd: '/w', label: 'ranking' },
    ]);
  });

  it('skips anything the forest is already rendering', () => {
    const out = unlistedPool({
      entries: [entry(A)],
      archived: [mk(B)],
      records: {},
      tipOf: self,
      shownIds: new Set([A, B]),
    });
    expect(out).toEqual([]);
  });

  it('skips deleted and chat records — Restore and the chat picker own those doors', () => {
    const out = unlistedPool({
      entries: [entry(A)],
      archived: [mk(B), mk(C)],
      records: {
        [A]: rec(A, { deleted: true }),
        [B]: rec(B, { chat: true }),
      },
      tipOf: self,
      shownIds: none,
    });
    expect(out.map((s) => s.sessionId)).toEqual([C]);
  });

  it('asks deleted/chat of the chain tip too, not only the physical id', () => {
    // The record sits on the TIP (B); the transcript on disk is the old id (A).
    const out = unlistedPool({
      entries: [],
      archived: [mk(B)],
      records: { [B]: rec(B, { deleted: true }) },
      tipOf: (id) => (id === A ? B : id),
      shownIds: none,
    });
    expect(out).toEqual([]);
  });

  it('collapses a chain to one entry: superseded generations never list', () => {
    // A's transcript is a superseded generation of B. Only B may appear —
    // importing A would mint a row the next rebuild collapses away.
    const tip = (id: string): string => (id === A ? B : id);
    const out = unlistedPool({
      entries: [],
      archived: [mk(A), mk(B)],
      records: {},
      tipOf: tip,
      shownIds: none,
    });
    expect(out.map((s) => s.sessionId)).toEqual([B]);
  });

  it('a live row swallows its own archived twin', () => {
    // The archive indexes live transcripts too; the pool must not offer the
    // same conversation twice.
    const out = unlistedPool({
      entries: [entry(A, { cwd: '/w' })],
      archived: [mk(A, { cwd: '/w' })],
      records: {},
      tipOf: self,
      shownIds: none,
    });
    expect(out).toEqual([{ sessionId: A, live: true, cwd: '/w' }]);
  });

  it('a SHOWN live row keeps its archived twin out as well', () => {
    const out = unlistedPool({
      entries: [entry(A)],
      archived: [mk(A)],
      records: {},
      tipOf: self,
      shownIds: new Set([A]),
    });
    expect(out).toEqual([]);
  });

  it('orders live first, then newest activity first', () => {
    const out = unlistedPool({
      entries: [entry(D)],
      archived: [
        mk(A, { endedAt: 100 }),
        mk(B, { endedAt: 300 }),
        mk(C, { endedAt: 200 }),
      ],
      records: {},
      tipOf: self,
      shownIds: none,
    });
    expect(out.map((s) => s.sessionId)).toEqual([D, B, C, A]);
  });

  it('carries the archived head facts the picker renders', () => {
    const out = unlistedPool({
      entries: [],
      archived: [mk(A, { cwd: '/w/api', label: 'the rewrite', endedAt: 42 })],
      records: {},
      tipOf: self,
      shownIds: none,
    });
    expect(out).toEqual([
      {
        sessionId: A,
        live: false,
        cwd: '/w/api',
        label: 'the rewrite',
        endedAt: 42,
      },
    ]);
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

  // The hide verb is retired, but buildForest still honours a node-level
  // hidden flag — this pins the rendering old state written by other windows
  // can still reach: archived rather than live, on screen, greyed and last.
  it('keeps a hidden+archived session on screen, sorted after live rows', () => {
    const f = buildForest({
      entries: [{ sessionId: B, name: 'still working', status: 'idle' }],
      archived: [mk(A, { label: 'put away', cwd: '/w', startedAt: 1 })],
      resolutions: res({ [A]: null, [B]: null }),
      records: {
        [A]: {
          id: A,
          hidden: true,
          closed: '2026-07-28T00:00:00.000Z',
          createdAt: '2026-07-28T00:00:00.000Z',
          updatedAt: '2026-07-28T00:00:00.000Z',
        },
      },
    });
    const n = f.nodes.get(A)!;
    expect(n.hidden).toBe(true);
    expect(n.deleted).toBe(false);
    expect(n.archived).toBe(true);
    // The point of the whole change: hiding must not remove the row.
    expect(f.visibleRoots).toContain(A);
    expect(f.visibleRoots).toEqual([B, A]);
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

  it('sorts archived roots after live ones, by startedAt like every other row', () => {
    const f = buildForest({
      entries: [{ sessionId: C, name: 'live', status: 'idle', startedAt: 9_000 }],
      archived: [
        // Deliberately the OPPOSITE of "most recently ended first" (the
        // pre-P7 rule): A started first but ENDED long after B. If the sort
        // still keyed off endedAt/recency, B would lead A here.
        mk(A, { label: 'started first', startedAt: 100, endedAt: 900 }),
        mk(B, { label: 'started later', startedAt: 900, endedAt: 100 }),
      ],
      resolutions: res({ [A]: null, [B]: null, [C]: null }),
      records: {},
    });
    expect(f.visibleRoots).toEqual([C, A, B]);
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

  // P5: an archived node's transcript is not being written to anymore, so its
  // own endedAt IS the last-activity timestamp — no activityMtimes lookup
  // needed, and it must win even when the map disagrees (it never should, but
  // the archived path must not depend on it being right).
  it('gives an archived node lastActiveAt === its own endedAt, always', () => {
    const f = buildForest({
      entries: [],
      archived: [mk(A, { endedAt: 12_345 })],
      resolutions: res({ [A]: null }),
      records: {},
      activityMtimes: new Map([[A, 1]]), // deliberately wrong; must be ignored
    });
    expect(f.nodes.get(A)!.lastActiveAt).toBe(12_345);
  });
});

// --------------------------------------------------------- generation chains

describe('archive: continuation detection', () => {
  it('flags a plain-resume continuation via its copied head', () => {
    // B's transcript starts with lines copied from A — sessionId A, no
    // forkedFrom — exactly what a plain `--resume` re-mint writes on disk.
    const f = writeTranscript('-p', B, [
      { type: 'user', sessionId: A, cwd: '/x', timestamp: '2026-07-01T10:00:00Z' },
      { type: 'assistant', sessionId: A },
      { type: 'user', sessionId: B },
    ]);
    const facts = readHeadFacts(f, B);
    expect(facts.firstSessionId).toBe(A);
    expect(facts.forkMarker).toBeUndefined();
    expect(continuationOf(B, facts)).toBe(A);
  });

  it('a fork transcript (forkedFrom, rewritten head) is NOT a continuation', () => {
    const f = writeTranscript('-p', B, [
      { forkedFrom: { sessionId: A }, sessionId: B, type: 'user' },
      { type: 'assistant', sessionId: B },
    ]);
    const facts = readHeadFacts(f, B);
    expect(facts.forkMarker).toBe(true);
    expect(continuationOf(B, facts)).toBeUndefined();
  });

  it('a deep forkedFrom marker vetoes even a mismatched head', () => {
    // Defensive: should a fork ever keep the parent's id in its copied head,
    // the marker anywhere in the window still vetoes the continuation verdict.
    const f = writeTranscript('-p', B, [
      { type: 'user', sessionId: A },
      { type: 'user', sessionId: A },
      { forkedFrom: { sessionId: A }, sessionId: B },
    ]);
    expect(continuationOf(B, readHeadFacts(f, B))).toBeUndefined();
  });

  it('a plain transcript whose head is its own id is nobody\'s continuation', () => {
    const f = writeTranscript('-p', A, [
      { type: 'user', sessionId: A, cwd: '/x' },
    ]);
    expect(continuationOf(A, readHeadFacts(f, A))).toBeUndefined();
  });

  it('indexes continuesId and serves chainFacts for LIVE files too', () => {
    writeTranscript('-p', A, [{ type: 'user', sessionId: A, cwd: '/x' }]);
    writeTranscript('-p', B, [
      { type: 'user', sessionId: A },
      { type: 'user', sessionId: B },
    ]);
    const idx = new ArchiveIndexer(projects);
    // B is live: its display facts are skipped, but the chain verdict is
    // still read (once — the head never changes).
    const r = idx.scan({ liveIds: new Set([B]) });
    expect(r.ok).toBe(true);

    const byId = new Map(idx.chainFacts().map((f) => [f.sessionId, f]));
    expect(byId.get(B)?.continuesId).toBe(A);
    expect(byId.get(A)?.continuesId).toBeUndefined();
    expect(byId.get(B)?.mtimeMs).toBeGreaterThan(0);

    const row = idx.current().find((s) => s.sessionId === B);
    expect(row?.continuesId).toBe(A);
    idx.dispose();
  });
});

// ═══════════════════════════ multi-root indexing ════════════════════════════

describe('archive: extraProjectsDirs', () => {
  const C = '0f0000c9-0000-4000-8000-0000000000c9';

  /** A transcript in a PROFILE's own projects root, not the primary one. */
  function writeProfileTranscript(profileRoot: string, sessionId: string): string {
    const dir = path.join(profileRoot, '-p');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      file,
      JSON.stringify({ type: 'custom-title', customTitle: 'profile session' }) + '\n',
    );
    return file;
  }

  it('indexes a profile root beside the primary, transcriptPath pointing into it', () => {
    writeTranscript('-a', A, [{ type: 'custom-title', customTitle: 'default' }]);
    const profileProjects = path.join(root, 'profiles', 'personal', 'projects');
    const profileFile = writeProfileTranscript(profileProjects, C);

    const idx = new ArchiveIndexer(projects);
    const result = idx.scan({ extraProjectsDirs: [profileProjects] });
    expect(result.ok).toBe(true);
    const ids = result.sessions.map((s) => s.sessionId).sort();
    expect(ids).toEqual([A, C].sort());
    const profileRow = result.sessions.find((s) => s.sessionId === C);
    expect(profileRow?.transcriptPath).toBe(profileFile);
    expect(profileRow?.label).toBe('profile session');
    idx.dispose();
  });

  it('an unreadable extra root is skipped silently — the primary result stands', () => {
    writeTranscript('-a', A, [{ cwd: '/x' }]);
    const idx = new ArchiveIndexer(projects);
    const result = idx.scan({
      extraProjectsDirs: [path.join(root, 'no-such-profile', 'projects')],
    });
    expect(result.ok).toBe(true);
    expect(result.sessions.map((s) => s.sessionId)).toEqual([A]);
    idx.dispose();
  });

  it('an id in TWO accounts is indexed once, from the newer copy', () => {
    // The bug this pins: roots are walked in account order and the first
    // occurrence won, so two of the author's archived rows were built from a
    // nine-line metadata stub — no cwd, no opening prompt — while the real
    // conversation sat in the other account. The rule is now the same one
    // `transcript.transcriptFile` resolves with, so the row and every reader
    // open the same file.
    const stub = writeTranscript('-a', C, [
      { type: 'custom-title', customTitle: 'the stub' },
    ]);
    const otherRoot = path.join(root, 'profiles', 'personal', 'projects');
    const otherDir = path.join(otherRoot, '-p');
    fs.mkdirSync(otherDir, { recursive: true });
    const realFile = path.join(otherDir, `${C}.jsonl`);
    fs.writeFileSync(
      realFile,
      JSON.stringify({ type: 'custom-title', customTitle: 'the conversation' }) +
        '\n' +
        JSON.stringify({ cwd: '/code/real' }) +
        '\n',
    );
    const old = Date.now() - 86_400_000;
    fs.utimesSync(stub, old / 1000, old / 1000);
    const recent = Date.now() - 60_000;
    fs.utimesSync(realFile, recent / 1000, recent / 1000);

    const idx = new ArchiveIndexer(projects);
    const result = idx.scan({ extraProjectsDirs: [otherRoot] });
    expect(result.ok).toBe(true);
    const rows = result.sessions.filter((s) => s.sessionId === C);
    expect(rows).toHaveLength(1);
    expect(rows[0].transcriptPath).toBe(realFile);
    expect(rows[0].label).toBe('the conversation');
    idx.dispose();
  });

  it('a duplicate root (the primary listed again) does not double-index', () => {
    writeTranscript('-a', A, [{ cwd: '/x' }]);
    const idx = new ArchiveIndexer(projects);
    const result = idx.scan({ extraProjectsDirs: [projects] });
    expect(result.ok).toBe(true);
    expect(result.sessions.map((s) => s.sessionId)).toEqual([A]);
    expect(result.scanned).toBe(1);
    idx.dispose();
  });

  it('a PRIMARY root failure still aborts to the previous index, extras or not', () => {
    const idx = new ArchiveIndexer(path.join(root, 'missing-primary'));
    const profileProjects = path.join(root, 'profiles', 'personal', 'projects');
    writeProfileTranscript(profileProjects, C);
    const result = idx.scan({ extraProjectsDirs: [profileProjects] });
    expect(result.ok).toBe(false);
    expect(result.sessions).toEqual([]);
    idx.dispose();
  });
});
