// test/daemon.test.ts — the CLI daemon's dispatch roster (M11).
//
// The fixture shapes are taken from the REAL ~/.claude/daemon/roster.json on
// the machine this was built on (CLI 2.1.207–2.1.220): a /fork dispatch is a
// worker whose launch = {mode:'resume', sessionId:'<abs path>/<parent>.jsonl',
// fork:true}, and the fork child's transcript carries NO forkedFrom marker —
// this file is the only place the edge exists.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DaemonRosterReader,
  factsOf,
  parseDaemonRoster,
  resumedIdOf,
} from '../src/daemon';

const CHILD = '0408b335-a2d4-4d3e-a546-aba0937b32be';
const PARENT = '4a3adbc4-eb27-4af0-87e3-db02769cd723';
const OTHER = '0f0000a1-0000-4000-8000-0000000000a1';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function worker(
  sessionId: string,
  launch: Record<string, unknown>,
): Record<string, unknown> {
  return {
    pid: 8885,
    sessionId,
    cwd: '/Users/x/code',
    dispatch: {
      proto: 1,
      sessionId,
      source: 'slash',
      launch,
    },
  };
}

function roster(workers: Record<string, unknown>): Record<string, unknown> {
  return { proto: 1, supervisorPid: 1, updatedAt: 'x', workers };
}

describe('daemon: resumedIdOf', () => {
  it('extracts the uuid from an absolute transcript path (the real shape)', () => {
    expect(
      resumedIdOf(`/Users/x/.claude/projects/-Users-x-code/${PARENT}.jsonl`),
    ).toBe(PARENT);
  });

  it('accepts a bare uuid', () => {
    expect(resumedIdOf(PARENT)).toBe(PARENT);
  });

  it('accepts a Windows-separated path', () => {
    expect(resumedIdOf(`C:\\Users\\x\\${PARENT}.jsonl`)).toBe(PARENT);
  });

  it('refuses anything whose basename is not uuid-shaped', () => {
    expect(resumedIdOf('/tmp/notes.jsonl')).toBeUndefined();
    expect(resumedIdOf('/tmp/')).toBeUndefined();
    expect(resumedIdOf('')).toBeUndefined();
    expect(resumedIdOf(42)).toBeUndefined();
    expect(resumedIdOf(null)).toBeUndefined();
  });
});

describe('daemon: parseDaemonRoster', () => {
  it('reads a fork dispatch: child, parent, fork flag, mode', () => {
    const parsed = parseDaemonRoster(
      roster({
        w1: worker(CHILD, {
          mode: 'resume',
          sessionId: `/Users/x/.claude/projects/-p/${PARENT}.jsonl`,
          fork: true,
        }),
      }),
    );
    expect(parsed).toEqual([
      { sessionId: CHILD, resumedId: PARENT, fork: true, mode: 'resume' },
    ]);
  });

  it('a self-referencing resume (kept id) yields no edge', () => {
    const parsed = parseDaemonRoster(
      roster({
        w1: worker(CHILD, {
          mode: 'resume',
          sessionId: `/p/${CHILD}.jsonl`,
          fork: false,
        }),
      }),
    );
    expect(parsed[0].resumedId).toBeUndefined();
  });

  it('skips workers without a uuid sessionId and tolerates junk shapes', () => {
    expect(parseDaemonRoster(null)).toEqual([]);
    expect(parseDaemonRoster([])).toEqual([]);
    expect(parseDaemonRoster({ workers: 'nope' })).toEqual([]);
    expect(
      parseDaemonRoster(
        roster({
          bad1: { sessionId: 'not-a-uuid' },
          bad2: 7,
          bad3: { sessionId: CHILD, dispatch: 'nope' },
        }),
      ),
    ).toEqual([{ sessionId: CHILD, fork: false }]);
  });
});

describe('daemon: factsOf', () => {
  it('splits fork edges from plain-resume continuations', () => {
    const facts = factsOf([
      { sessionId: CHILD, resumedId: PARENT, fork: true, mode: 'resume' },
      { sessionId: OTHER, resumedId: PARENT, fork: false, mode: 'resume' },
      { sessionId: PARENT, fork: false, mode: 'new' }, // no edge at all
    ]);
    expect(facts.forkParents.get(CHILD)).toBe(PARENT);
    expect(facts.forkParents.has(OTHER)).toBe(false);
    expect(facts.resumeContinuations.get(OTHER)).toBe(PARENT);
    expect(facts.resumeContinuations.has(CHILD)).toBe(false);
  });

  it('a non-resume mode without fork contributes nothing', () => {
    const facts = factsOf([
      { sessionId: OTHER, resumedId: PARENT, fork: false, mode: 'new' },
    ]);
    expect(facts.forkParents.size).toBe(0);
    expect(facts.resumeContinuations.size).toBe(0);
  });
});

describe('daemon: DaemonRosterReader', () => {
  function tempRoster(content: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-daemon-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'roster.json');
    fs.writeFileSync(file, JSON.stringify(content));
    return file;
  }

  it('reads fork edges from disk and caches by stat', () => {
    const file = tempRoster(
      roster({
        w1: worker(CHILD, {
          mode: 'resume',
          sessionId: `/p/${PARENT}.jsonl`,
          fork: true,
        }),
      }),
    );
    const reader = new DaemonRosterReader(file);
    const first = reader.read();
    expect(first.forkParents.get(CHILD)).toBe(PARENT);
    // Unchanged file: the same object back (the stat cache).
    expect(reader.read()).toBe(first);
  });

  it('a missing roster yields empty facts, never a throw', () => {
    const reader = new DaemonRosterReader('/nonexistent/roster.json');
    const facts = reader.read();
    expect(facts.forkParents.size).toBe(0);
    expect(facts.resumeContinuations.size).toBe(0);
  });

  it('a torn write keeps the last good facts', () => {
    const file = tempRoster(
      roster({
        w1: worker(CHILD, {
          mode: 'resume',
          sessionId: `/p/${PARENT}.jsonl`,
          fork: true,
        }),
      }),
    );
    const reader = new DaemonRosterReader(file);
    const good = reader.read();
    expect(good.forkParents.size).toBe(1);
    fs.writeFileSync(file, '{"workers": {'); // mid-write
    const after = reader.read();
    expect(after.forkParents.get(CHILD)).toBe(PARENT); // last good answer
  });
});
