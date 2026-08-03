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
  daemonRosterPathFor,
  factsOf,
  jobsDirForRosterPath,
  parentFromResumeSourceAlive,
  parseDaemonRoster,
  readJobState,
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

// ---------------------------------------------------------------------- M25
//
// The shapes below are taken from the REAL background-job `/fork` observed on
// CLI 2.1.220, the one M11 documented as a known gap and refused to guess at:
//
//   launch.sessionId = "<configDir>/jobs/<short>/tmp/parent-transcript.jsonl"
//   dispatch.env.CLAUDE_CODE_RESUME_SOURCE_ALIVE = "<child>|<ISO>|<PARENT>"
//   <configDir>/jobs/<short>/state.json = { forkParentSessionId, ... }
//
// The launch path has had the uuid scrubbed out of it; the other two name the
// parent exactly.

describe('daemon: parentFromResumeSourceAlive', () => {
  it('reads the parent out of the real "<child>|<ISO>|<parent>" shape', () => {
    expect(
      parentFromResumeSourceAlive(
        `${CHILD}|2026-08-02T23:22:56.658Z|${PARENT}`,
        CHILD,
      ),
    ).toBe(PARENT);
  });

  it('is read by content, not position — field order may change', () => {
    expect(
      parentFromResumeSourceAlive(`${PARENT}|2026-08-02T23:22:56.658Z|${CHILD}`, CHILD),
    ).toBe(PARENT);
  });

  it('refuses when two candidate parents are present (ambiguous)', () => {
    expect(
      parentFromResumeSourceAlive(`${CHILD}|${PARENT}|${OTHER}`, CHILD),
    ).toBeUndefined();
  });

  it('refuses when the only uuid is the worker itself, and on junk', () => {
    expect(parentFromResumeSourceAlive(`${CHILD}|x`, CHILD)).toBeUndefined();
    expect(parentFromResumeSourceAlive('', CHILD)).toBeUndefined();
    expect(parentFromResumeSourceAlive(undefined, CHILD)).toBeUndefined();
    expect(parentFromResumeSourceAlive(42, CHILD)).toBeUndefined();
  });
});

describe('daemon: background-job forks (M25)', () => {
  /** A `<configDir>` laid out the way the CLI lays one out. */
  function configDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-cfg-'));
    tmpDirs.push(dir);
    return dir;
  }

  function writeRoster(dir: string, content: unknown): string {
    const file = daemonRosterPathFor(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(content));
    return file;
  }

  function writeJob(
    dir: string,
    short: string,
    state: Record<string, unknown>,
  ): void {
    const jobDir = path.join(dir, 'jobs', short);
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(path.join(jobDir, 'state.json'), JSON.stringify(state));
  }

  /** The dispatch a background-job /fork actually writes. */
  function jobWorker(dir: string, short: string): Record<string, unknown> {
    return {
      pid: 77049,
      sessionId: CHILD,
      cwd: '/Users/x/code',
      dispatch: {
        proto: 1,
        short,
        sessionId: CHILD,
        source: 'slash',
        launch: {
          mode: 'resume',
          // The uuid is GONE from this path — that is the whole gap.
          sessionId: path.join(dir, 'jobs', short, 'tmp', 'parent-transcript.jsonl'),
          fork: true,
        },
        env: {
          CLAUDE_CONFIG_DIR: dir,
          CLAUDE_CODE_RESUME_SOURCE_ALIVE: `${CHILD}|2026-08-02T23:22:56.658Z|${PARENT}`,
        },
      },
    };
  }

  it('jobsDirForRosterPath finds the jobs dir beside the daemon dir', () => {
    expect(jobsDirForRosterPath('/cfg/daemon/roster.json')).toBe('/cfg/jobs');
    expect(jobsDirForRosterPath(daemonRosterPathFor('/cfg'))).toBe('/cfg/jobs');
  });

  it('parseDaemonRoster falls back to the dispatch env when the path has no uuid', () => {
    const dir = configDir();
    const parsed = parseDaemonRoster(roster({ w1: jobWorker(dir, '5d0a7866') }));
    expect(parsed).toEqual([
      {
        sessionId: CHILD,
        resumedId: PARENT,
        fork: true,
        mode: 'resume',
        short: '5d0a7866',
      },
    ]);
  });

  it('readJobState reads the parent, name, cwd and unattached flag', () => {
    const dir = configDir();
    writeJob(dir, '5d0a7866', {
      forkSessionId: CHILD,
      forkParentSessionId: PARENT,
      name: 'Understanding /branch and /fork commands',
      cwd: '/Users/x/code',
      state: 'blocked',
      firstTerminalAt: null,
      needs: 'send a prompt to start',
    });
    expect(readJobState(path.join(dir, 'jobs'), '5d0a7866', dir)).toEqual({
      sessionId: CHILD,
      parentId: PARENT,
      name: 'Understanding /branch and /fork commands',
      cwd: '/Users/x/code',
      configDir: dir,
      short: '5d0a7866',
      attached: false,
      live: true,
    });
  });

  it('a job a terminal has already driven reports attached — it has an owner', () => {
    const dir = configDir();
    writeJob(dir, 'aa11bb22', {
      forkSessionId: CHILD,
      forkParentSessionId: PARENT,
      firstTerminalAt: '2026-08-02T23:30:00.000Z',
    });
    expect(readJobState(path.join(dir, 'jobs'), 'aa11bb22', dir)?.attached).toBe(
      true,
    );
  });

  it('readJobState refuses a traversing short and a missing job, never throws', () => {
    const dir = configDir();
    expect(readJobState(path.join(dir, 'jobs'), '../../etc', dir)).toBeUndefined();
    expect(readJobState(path.join(dir, 'jobs'), 'a/b', dir)).toBeUndefined();
    expect(readJobState(path.join(dir, 'jobs'), '', dir)).toBeUndefined();
    expect(readJobState(path.join(dir, 'jobs'), 'nosuch', dir)).toBeUndefined();
  });

  it('factsOf takes a job parent only when the dispatch named none', () => {
    const job = {
      sessionId: CHILD,
      parentId: OTHER,
      configDir: '/cfg',
      short: 's',
      attached: false,
      live: true,
    };
    // Dispatch is silent: the job answers.
    expect(
      factsOf([{ sessionId: CHILD, fork: true }], [job]).forkParents.get(CHILD),
    ).toBe(OTHER);
    // Dispatch spoke: the live roster wins over the on-disk copy.
    expect(
      factsOf(
        [{ sessionId: CHILD, resumedId: PARENT, fork: true, mode: 'resume' }],
        [job],
      ).forkParents.get(CHILD),
    ).toBe(PARENT);
    // Either way the job itself is surfaced, so focus can adopt it.
    expect(factsOf([], [job]).jobs.get(CHILD)).toBe(job);
  });

  it('backfills a job parent from the roster when state.json has none', () => {
    // The common /fork: the launch path named the parent uuid, so the roster
    // carries the edge and the job state does not. The adopt path asks the
    // JOB for its parent, so the job has to know.
    const bare = {
      sessionId: CHILD,
      configDir: '/cfg',
      short: 's',
      attached: false,
      live: true,
    };
    const facts = factsOf(
      [{ sessionId: CHILD, resumedId: PARENT, fork: true, mode: 'resume' }],
      [bare],
    );
    expect(facts.jobs.get(CHILD)?.parentId).toBe(PARENT);
    // A job with no edge anywhere is left exactly as it was.
    expect(factsOf([], [bare]).jobs.get(CHILD)).toBe(bare);
  });

  it('the whole path end to end: a background /fork yields an edge and a job', () => {
    const dir = configDir();
    writeJob(dir, '5d0a7866', {
      forkSessionId: CHILD,
      forkParentSessionId: PARENT,
      name: 'a branch',
      state: 'working',
      firstTerminalAt: null,
    });
    const file = writeRoster(dir, roster({ w1: jobWorker(dir, '5d0a7866') }));

    const facts = new DaemonRosterReader(file).read();
    expect(facts.forkParents.get(CHILD)).toBe(PARENT);
    const job = facts.jobs.get(CHILD);
    expect(job?.attached).toBe(false);
    expect(job?.parentId).toBe(PARENT);
    expect(job?.configDir).toBe(dir);
  });

  it('merges every account roster — M22 gives each its own config dir', () => {
    const a = configDir();
    const b = configDir();
    writeRoster(
      a,
      roster({
        w1: worker(CHILD, {
          mode: 'resume',
          sessionId: `/p/${PARENT}.jsonl`,
          fork: true,
        }),
      }),
    );
    writeJob(b, 'bb22cc33', {
      forkSessionId: OTHER,
      forkParentSessionId: PARENT,
      firstTerminalAt: null,
    });
    writeRoster(b, roster({ w1: { ...jobWorker(b, 'bb22cc33'), sessionId: OTHER } }));

    const reader = new DaemonRosterReader([
      daemonRosterPathFor(a),
      daemonRosterPathFor(b),
    ]);
    const facts = reader.read();
    // The default-account fork AND the other account's background job.
    expect(facts.forkParents.get(CHILD)).toBe(PARENT);
    expect(facts.forkParents.get(OTHER)).toBe(PARENT);
    expect(facts.jobs.has(OTHER)).toBe(true);
    // Nothing moved: identity is stable across ticks.
    expect(reader.read()).toBe(facts);
  });

  it('the path list is re-evaluated per read — accounts come and go', () => {
    const a = configDir();
    const b = configDir();
    writeRoster(
      a,
      roster({
        w1: worker(CHILD, {
          mode: 'resume',
          sessionId: `/p/${PARENT}.jsonl`,
          fork: true,
        }),
      }),
    );
    writeRoster(
      b,
      roster({
        w1: worker(OTHER, {
          mode: 'resume',
          sessionId: `/p/${PARENT}.jsonl`,
          fork: true,
        }),
      }),
    );
    let paths = [daemonRosterPathFor(a)];
    const reader = new DaemonRosterReader(() => paths);
    expect(reader.read().forkParents.has(OTHER)).toBe(false);

    paths = [daemonRosterPathFor(a), daemonRosterPathFor(b)]; // account added
    expect(reader.read().forkParents.get(OTHER)).toBe(PARENT);

    paths = [daemonRosterPathFor(a)]; // account removed
    const after = reader.read();
    expect(after.forkParents.has(OTHER)).toBe(false);
    expect(after.forkParents.get(CHILD)).toBe(PARENT);
  });
});
