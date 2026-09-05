// test/toolShells.test.ts — reading the commands Claude ran out of a transcript.
//
// The record shapes below are not invented. Every one of them was taken from a
// real transcript on the author's machine and reduced to the fields the parser
// reads, which is why the odd ones (a completion notice filed under
// `queue-operation`, a failure whose `toolUseResult` is a bare string) are here
// at all: each of those cost a bug the first time round.

import { describe, expect, it } from 'vitest';

import {
  ShellRunsTracker,
  formatDuration,
  isLive,
  parseShellRuns,
  shellRunDetail,
  shellRunIconId,
  shellRunLabel,
  shellRunTokens,
  shellRunTooltip,
  sortShellRuns,
} from '../src/toolShells';
import type { ShellRun } from '../src/toolShells';

const SESSION = '0f00000a-0000-4000-8000-00000000000a';
const T0 = '2026-08-30T01:00:00.000Z';
const T1 = '2026-08-30T01:00:12.000Z';
const MS0 = Date.parse(T0);
const MS1 = Date.parse(T1);

/** An assistant record issuing one Bash call. */
function ask(
  id: string,
  command: string,
  opts: { description?: string; at?: string; sidechain?: boolean } = {},
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: opts.at ?? T0,
    ...(opts.sidechain === true ? { isSidechain: true } : {}),
    message: {
      content: [
        {
          type: 'tool_use',
          id,
          name: 'Bash',
          input: {
            command,
            ...(opts.description === undefined
              ? {}
              : { description: opts.description }),
          },
        },
      ],
    },
  });
}

/** The user record carrying its result. */
function answer(
  id: string,
  opts: {
    at?: string;
    isError?: boolean;
    content?: string;
    toolUseResult?: unknown;
  } = {},
): string {
  return JSON.stringify({
    type: 'user',
    timestamp: opts.at ?? T1,
    ...(opts.toolUseResult === undefined
      ? {}
      : { toolUseResult: opts.toolUseResult }),
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          is_error: opts.isError === true,
          content: opts.content ?? 'ok',
        },
      ],
    },
  });
}

function only(lines: string[]): ShellRun {
  const runs = parseShellRuns(lines.join('\n'), SESSION);
  expect(runs).toHaveLength(1);
  return runs[0]!;
}

// ------------------------------------------------------------- the pairing

describe('pairing a command with its result', () => {
  it('reads the command, the description and the time it was asked for', () => {
    const run = only([
      ask('toolu_1', 'npm test', { description: 'Run the test suite' }),
      answer('toolu_1'),
    ]);
    expect(run.command).toBe('npm test');
    expect(run.description).toBe('Run the test suite');
    expect(run.startedAt).toBe(MS0);
    expect(run.endedAt).toBe(MS1);
    expect(run.outcome).toBe('ok');
  });

  // THE LOAD-BEARING CASE. A tool_use record reaches the transcript WHILE its
  // command is still running — measured by sampling from inside a twenty-second
  // command: the record appeared about three seconds in and stayed unanswered
  // for the remaining fifteen. So an unanswered one is a command executing
  // right now. If that ever stops holding, this view is fiction.
  //
  // (The flush delay is why a sub-second command is only ever seen as history.
  // That is a limit of the source, not of this parser, and it is the harmless
  // half: nobody opens a process list to catch a command that already ended.)
  it('calls an unanswered command running, with no end time', () => {
    const run = only([ask('toolu_1', 'sleep 300')]);
    expect(run.outcome).toBe('running');
    expect(run.endedAt).toBeUndefined();
    expect(isLive(run)).toBe(true);
  });

  it('ignores every tool that is not Bash', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: T0,
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_r', name: 'Read', input: { file_path: '/x' } },
          { type: 'tool_use', id: 'toolu_e', name: 'Edit', input: {} },
        ],
      },
    });
    expect(parseShellRuns(line, SESSION)).toHaveLength(0);
  });

  // The seed window cuts mid-conversation, so its first results answer calls
  // above the cut. Dropping them is right; throwing or inventing a row is not.
  it('drops a result whose command is above the window', () => {
    expect(parseShellRuns(answer('toolu_gone'), SESSION)).toHaveLength(0);
  });

  it('skips garbage lines rather than giving up on the file', () => {
    const runs = parseShellRuns(
      ['{ not json', ask('toolu_1', 'ls'), '', answer('toolu_1')].join('\n'),
      SESSION,
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.outcome).toBe('ok');
  });

  it('drops the first line when the caller says the window cut it', () => {
    const text = [ask('toolu_1', 'ls'), ask('toolu_2', 'pwd')].join('\n');
    expect(parseShellRuns(text, SESSION, true)).toHaveLength(1);
  });

  it('marks a sub-agent’s command as one', () => {
    const run = only([
      ask('toolu_1', 'ls', { sidechain: true }),
      answer('toolu_1'),
    ]);
    expect(run.sidechain).toBe(true);
  });
});

// ------------------------------------------------------------- how it went

describe('how a command ended', () => {
  it('reads the exit code off a failure', () => {
    const run = only([
      ask('toolu_1', 'npm test'),
      answer('toolu_1', {
        isError: true,
        content: 'Exit code 1\nFAIL src/thing.test.ts',
        toolUseResult: 'Error: Exit code 1\nFAIL src/thing.test.ts',
      }),
    ]);
    expect(run.outcome).toBe('failed');
    expect(run.exitCode).toBe(1);
    expect(run.reason).toBe('Exit code 1');
  });

  // A refusal is not a failure: nothing ran. Reading it as one sends somebody
  // debugging a script that was never started.
  it('separates a refusal from a failure — the classifier', () => {
    const run = only([
      ask('toolu_1', 'rm -rf ~/.claude/skills'),
      answer('toolu_1', {
        isError: true,
        content:
          'Permission for this action was denied by the Claude Code auto mode classifier. Reason: Self-Modification',
      }),
    ]);
    expect(run.outcome).toBe('denied');
    expect(run.exitCode).toBeUndefined();
  });

  it('separates a refusal from a failure — the user said no', () => {
    const run = only([
      ask('toolu_1', 'git push --force'),
      answer('toolu_1', {
        isError: true,
        content: "The user doesn't want to proceed with this tool use.",
      }),
    ]);
    expect(run.outcome).toBe('denied');
  });

  it('separates a refusal from a failure — a hook blocked it', () => {
    const run = only([
      ask('toolu_1', 'sleep 45; cat out.txt'),
      answer('toolu_1', {
        isError: true,
        content: '<tool_use_error>Blocked: sleep 45 followed by: cat out.txt',
      }),
    ]);
    expect(run.outcome).toBe('denied');
    expect(run.reason).toBe('Blocked: sleep 45 followed by: cat out.txt');
  });

  // An `Exit code 3` PRINTED by a command is not the command's own — only the
  // head of the result is the CLI speaking.
  it('does not read an exit code out of the command’s own output', () => {
    const run = only([
      ask('toolu_1', 'echo hi'),
      answer('toolu_1', { content: 'the log said Exit code 3 and carried on' }),
    ]);
    expect(run.outcome).toBe('ok');
    expect(run.exitCode).toBe(0);
  });
});

// ------------------------------------------------------------- backgrounds

describe('a backgrounded command', () => {
  const detach = (id: string, task: string, at = T1): string =>
    answer(id, {
      at,
      content: `Command running in background with ID: ${task}. Output is being written to: /tmp/tasks/${task}.output. You will be notified when it completes.`,
      toolUseResult: { stdout: '', stderr: '', backgroundTaskId: task },
    });

  // The result says "detached", not "finished". A row that ended here would
  // report a job as done the instant it started.
  it('is still live after its result comes back', () => {
    const run = only([ask('toolu_1', './long.sh'), detach('toolu_1', 'bx1')]);
    expect(run.outcome).toBe('background');
    expect(run.endedAt).toBeUndefined();
    expect(isLive(run)).toBe(true);
    expect(run.backgroundId).toBe('bx1');
    expect(run.outputFile).toBe('/tmp/tasks/bx1.output');
  });

  const notice = (
    type: string,
    body: Record<string, unknown>,
    status = 'completed',
  ): string => {
    const block =
      `<task-notification>\n<task-id>bx1</task-id>\n` +
      `<tool-use-id>toolu_1</tool-use-id>\n` +
      `<output-file>/tmp/tasks/bx1.output</output-file>\n` +
      `<status>${status}</status>\n</task-notification>`;
    const filled = JSON.parse(
      JSON.stringify(body).replace(/"__BLOCK__"/g, JSON.stringify(block)),
    ) as Record<string, unknown>;
    return JSON.stringify({ type, timestamp: T1, ...filled });
  };

  // The notice has three homes depending on the CLI build, and reading only
  // one of them leaves every background job spinning forever. All three were
  // found in transcripts on ONE machine.
  it('finishes on a notice filed as a queue-operation', () => {
    const run = only([
      ask('toolu_1', './long.sh'),
      detach('toolu_1', 'bx1'),
      notice('queue-operation', { content: '__BLOCK__' }),
    ]);
    expect(run.outcome).toBe('ok');
    expect(run.endedAt).toBe(MS1);
  });

  it('finishes on a notice filed as an attachment', () => {
    const run = only([
      ask('toolu_1', './long.sh'),
      detach('toolu_1', 'bx1'),
      notice('attachment', { attachment: { prompt: '__BLOCK__' } }),
    ]);
    expect(run.outcome).toBe('ok');
  });

  it('finishes on a notice delivered as an ordinary user message', () => {
    const run = only([
      ask('toolu_1', './long.sh'),
      detach('toolu_1', 'bx1'),
      notice('user', { message: { content: '__BLOCK__' } }),
    ]);
    expect(run.outcome).toBe('ok');
  });

  it('reports a failed background job as failed', () => {
    const run = only([
      ask('toolu_1', './long.sh'),
      detach('toolu_1', 'bx1'),
      notice('queue-operation', { content: '__BLOCK__' }, 'failed'),
    ]);
    expect(run.outcome).toBe('failed');
    expect(run.reason).toContain('failed');
  });

  // The CLI records the notice more than once — an enqueue and a removal, at
  // different timestamps. The FIRST is when the command actually ended.
  it('takes the first notice, not the last, as the end time', () => {
    const later = JSON.stringify({
      type: 'queue-operation',
      timestamp: '2026-08-30T01:05:00.000Z',
      content:
        '<task-notification>\n<task-id>bx1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n</task-notification>',
    });
    const run = only([
      ask('toolu_1', './long.sh'),
      detach('toolu_1', 'bx1'),
      notice('queue-operation', { content: '__BLOCK__' }),
      later,
    ]);
    expect(run.endedAt).toBe(MS1);
  });
});

// -------------------------------------------------------------- formatting

describe('formatDuration', () => {
  // Seconds, unlike the tree's formatAge, which floors everything under 90 s
  // to `now` — most commands finish inside that, so every row would read `now`.
  it('counts in seconds under a minute', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(3_400)).toBe('3s');
    expect(formatDuration(59_999)).toBe('59s');
  });

  it('keeps the smaller unit alongside the larger one', () => {
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(130_000)).toBe('2m 10s');
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(3_900_000)).toBe('1h 5m');
    expect(formatDuration(90_000_000)).toBe('1d 1h');
  });

  it('renders nothing for a clock that cannot answer', () => {
    expect(formatDuration(Number.NaN)).toBe('');
    expect(formatDuration(-1)).toBe('');
  });
});

describe('what a row says', () => {
  const run = (over: Partial<ShellRun> = {}): ShellRun => ({
    id: 'toolu_1',
    sessionId: SESSION,
    command: 'npm test -- --reporter=dot',
    startedAt: MS0,
    outcome: 'ok',
    endedAt: MS1,
    ...over,
  });

  it('names the row with Claude’s own description', () => {
    expect(shellRunLabel(run({ description: 'Run the test suite' }))).toBe(
      'Run the test suite',
    );
  });

  it('falls back to the command, on one line', () => {
    expect(shellRunLabel(run({ command: 'cat <<EOF\nhello\nEOF' }))).toBe(
      'cat <<EOF hello EOF',
    );
  });

  it('leads with the elapsed time, which is why you opened the view', () => {
    expect(shellRunDetail({ run: run(), now: MS1 })).toBe('12s');
  });

  // The command is on the row exactly when the row is named something else —
  // never twice, never nowhere.
  it('adds the command when the row is named after the description', () => {
    const text = shellRunDetail({
      run: run({ description: 'Run the test suite' }),
      now: MS1,
    });
    expect(text).toBe('12s · npm test -- --reporter=dot');
  });

  it('says how it failed, and which session, in truncation order', () => {
    const text = shellRunDetail({
      run: run({ outcome: 'failed', exitCode: 2 }),
      now: MS1,
      sessionLabel: 'flock',
    });
    expect(text).toBe('12s · exit 2 · flock');
  });

  // A running row measures against NOW; a finished one is frozen at its result.
  it('keeps counting while it runs and stops when it ends', () => {
    const live = run({ outcome: 'running', endedAt: undefined });
    expect(shellRunDetail({ run: live, now: MS0 + 5_000 })).toBe('5s');
    expect(shellRunDetail({ run: run(), now: MS0 + 999_000 })).toBe('12s');
  });

  it('says a background job is one, and keeps its clock going', () => {
    const bg = run({ outcome: 'background', endedAt: undefined });
    expect(shellRunDetail({ run: bg, now: MS0 + 60_000 })).toBe(
      '1m · background',
    );
  });

  it('spins only while something is actually running', () => {
    expect(shellRunIconId(run({ outcome: 'running' }))).toBe('loading~spin');
    expect(shellRunIconId(run({ outcome: 'background' }))).toBe('server-process');
    expect(shellRunIconId(run())).toBe('pass');
    // A refusal and a failure must not share a glyph: one says the script
    // broke, the other says it never started.
    expect(shellRunIconId(run({ outcome: 'failed' }))).toBe('error');
    expect(shellRunIconId(run({ outcome: 'denied' }))).toBe('circle-slash');
  });

  it('leads the hover with the command in full', () => {
    const text = shellRunTooltip({
      run: run({ command: 'a\nb\nc', description: 'Three things' }),
      now: MS1,
    });
    expect(text.split('\n').slice(0, 3)).toEqual(['a', 'b', 'c']);
    expect(text).toContain('took 12s');
  });

  it('names the output file, because it is the actionable line', () => {
    const text = shellRunTooltip({
      run: run({ outcome: 'background', outputFile: '/tmp/tasks/bx1.output' }),
      now: MS1,
    });
    expect(text).toContain('/tmp/tasks/bx1.output');
  });

  it('marks the outcome and an openable output on the context value', () => {
    expect(shellRunTokens(run({ outcome: 'running' }))).toEqual([
      'shell',
      'running',
      'live',
    ]);
    expect(
      shellRunTokens(run({ outcome: 'background', outputFile: '/tmp/x' })),
    ).toEqual(['shell', 'background', 'live', 'output']);
    expect(shellRunTokens(run())).toEqual(['shell', 'ok']);
  });
});

describe('sortShellRuns', () => {
  const at = (id: string, over: Partial<ShellRun>): ShellRun => ({
    id,
    sessionId: SESSION,
    command: id,
    startedAt: MS0,
    outcome: 'ok',
    endedAt: MS0,
    ...over,
  });

  // The one ordering rule: what is running is what you came for.
  it('pins live runs above finished ones, however old they are', () => {
    const order = sortShellRuns([
      at('new', { endedAt: MS0 + 100_000 }),
      at('old-but-running', {
        outcome: 'running',
        startedAt: MS0 - 900_000,
        endedAt: undefined,
      }),
    ]).map((r) => r.id);
    expect(order).toEqual(['old-but-running', 'new']);
  });

  it('orders each group newest first', () => {
    const order = sortShellRuns([
      at('a', { endedAt: MS0 }),
      at('c', { endedAt: MS0 + 200 }),
      at('b', { endedAt: MS0 + 100 }),
    ]).map((r) => r.id);
    expect(order).toEqual(['c', 'b', 'a']);
  });

  // A turn firing four commands at once stamps them with one millisecond;
  // they must not swap places between repaints.
  it('breaks ties on id, so a parallel turn never reshuffles', () => {
    const ids = sortShellRuns([at('z', {}), at('a', {}), at('m', {})]).map(
      (r) => r.id,
    );
    expect(ids).toEqual(['a', 'm', 'z']);
    expect(sortShellRuns([at('m', {}), at('z', {}), at('a', {})]).map((r) => r.id))
      .toEqual(ids);
  });
});

// ---------------------------------------------------------------- tracking

describe('ShellRunsTracker', () => {
  /** A fake filesystem holding one growing file. */
  function fakeFs(initial: string) {
    const state = { text: initial };
    const io = {
      statSync: (_p: string) => ({ size: Buffer.byteLength(state.text) }),
      openSync: (_p: string) => 1,
      readSync: (
        _fd: number,
        buf: Buffer,
        off: number,
        len: number,
        pos: number,
      ) => Buffer.from(state.text).copy(buf, off, pos, pos + len),
      closeSync: (_fd: number) => undefined,
    } as unknown as ConstructorParameters<typeof ShellRunsTracker>[0];
    return { state, io };
  }

  const ref = { id: SESSION, transcriptPath: '/fake/t.jsonl' };

  it('reads what is there, then only what was appended', () => {
    const { state, io } = fakeFs(ask('toolu_1', 'ls') + '\n');
    const tracker = new ShellRunsTracker(io);
    expect(tracker.update(ref).map((r) => r.outcome)).toEqual(['running']);

    state.text += answer('toolu_1') + '\n';
    const after = tracker.update(ref);
    expect(after).toHaveLength(1);
    expect(after[0]?.outcome).toBe('ok');
  });

  it('holds a half-written record until its newline arrives', () => {
    const { state, io } = fakeFs('');
    const tracker = new ShellRunsTracker(io);
    const line = ask('toolu_1', 'ls');
    state.text = line.slice(0, 20);
    expect(tracker.update(ref)).toHaveLength(0);
    state.text = line + '\n';
    expect(tracker.update(ref)).toHaveLength(1);
  });

  // The whole reason this is a tracker and not a re-read: in steady state a
  // tick on an idle session must cost one stat and nothing else. A live view
  // ticks once a second across every session on the machine.
  it('opens nothing when the file has not grown', () => {
    const text = ask('toolu_1', 'ls') + '\n';
    let opens = 0;
    const counted = {
      statSync: () => ({ size: Buffer.byteLength(text) }),
      openSync: () => {
        opens++;
        return 1;
      },
      readSync: (_fd: number, buf: Buffer, off: number, len: number, pos: number) =>
        Buffer.from(text).copy(buf, off, pos, pos + len),
      closeSync: () => undefined,
    } as unknown as ConstructorParameters<typeof ShellRunsTracker>[0];
    const tracker = new ShellRunsTracker(counted);
    tracker.update(ref);
    expect(opens).toBe(1);
    tracker.update(ref);
    tracker.update(ref);
    expect(opens).toBe(1);
  });

  // A compaction rewrites the transcript in place, so the old offset points
  // into the middle of a different record. Re-reading must not double the rows
  // it already has — runs are keyed by tool_use id, which is what makes it safe.
  it('survives a transcript that shrank, without duplicating history', () => {
    const first = [ask('toolu_1', 'ls'), answer('toolu_1')].join('\n') + '\n';
    const { state, io } = fakeFs(first);
    const tracker = new ShellRunsTracker(io);
    expect(tracker.update(ref)).toHaveLength(1);

    state.text = ask('toolu_1', 'ls') + '\n'; // rewritten, shorter
    const after = tracker.update(ref);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe('toolu_1');
  });

  it('gives back nothing rather than throwing on a file that is not there', () => {
    const io = {
      statSync: () => {
        throw new Error('ENOENT');
      },
      openSync: () => 1,
      readSync: () => 0,
      closeSync: () => undefined,
    } as unknown as ConstructorParameters<typeof ShellRunsTracker>[0];
    expect(new ShellRunsTracker(io).update(ref)).toEqual([]);
  });

  it('forgets sessions it is no longer asked about', () => {
    const { io } = fakeFs(ask('toolu_1', 'ls') + '\n');
    const tracker = new ShellRunsTracker(io);
    tracker.update(ref);
    tracker.prune(new Set());
    // Pruned, so the next look re-seeds from the file rather than serving a
    // cached list — same answer, fresh state.
    expect(tracker.update(ref)).toHaveLength(1);
  });
});

// ------------------------------------------------------- the orphan guard

/** An assistant record of message `messageId` with a text block and no call —
 *  the next turn, as the CLI writes it. */
function say(messageId: string, text: string, at = T1): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: at,
    message: { id: messageId, content: [{ type: 'text', text }] },
  });
}

/** `ask`, stamped with the API message id every real record carries. */
function askIn(messageId: string, id: string, command: string, at = T0): string {
  const rec = JSON.parse(ask(id, command, { at })) as {
    message: Record<string, unknown>;
  };
  rec.message['id'] = messageId;
  return JSON.stringify(rec);
}

describe('a call the conversation moved on from', () => {
  // Two of the 30 214 Bash calls on the machine this was written on have no
  // result: their sessions died under them and were resumed. The API refuses
  // a new assistant turn while a call is unanswered, so the next turn is the
  // proof that it ended.
  it('is settled by an assistant record of a LATER message', () => {
    const run = only([askIn('msg_1', 'toolu_1', 'npm test'), say('msg_2', 'Done.')]);
    expect(run.outcome).toBe('failed');
    expect(run.endedAt).toBe(MS1);
    expect(run.reason).toMatch(/moved on/);
  });

  // One turn lands as one record per content block, all sharing message.id —
  // a turn that fires four commands writes four records while all four run.
  it('is NOT settled by another block of the same message', () => {
    const runs = parseShellRuns(
      [
        askIn('msg_1', 'toolu_1', 'npm test'),
        askIn('msg_1', 'toolu_2', 'npm run lint'),
        JSON.stringify({
          type: 'assistant',
          timestamp: T0,
          message: { id: 'msg_1', content: [{ type: 'text', text: 'Running both.' }] },
        }),
      ].join('\n'),
      SESSION,
    );
    expect(runs.map((r) => r.outcome)).toEqual(['running', 'running']);
  });

  // A sub-agent's records interleave with the conversation's; neither chain
  // proves anything about the other.
  it('is NOT settled by the other chain', () => {
    const sub = JSON.parse(askIn('msg_9', 'toolu_sub', 'pytest')) as Record<string, unknown>;
    sub['isSidechain'] = true;
    const runs = parseShellRuns(
      [askIn('msg_1', 'toolu_main', 'npm test'), JSON.stringify(sub), say('msg_2', 'Next.')].join(
        '\n',
      ),
      SESSION,
    );
    const byId = new Map(runs.map((r) => [r.id, r.outcome]));
    expect(byId.get('toolu_main')).toBe('failed'); // same chain, later message
    expect(byId.get('toolu_sub')).toBe('running'); // other chain, untouched
  });

  // A record without a message id — the synthetic kind above, or a build that
  // stops writing one — proves nothing and settles nothing.
  it('is left alone when either record has no message id', () => {
    expect(only([ask('toolu_1', 'ls'), say('msg_2', 'Done.')]).outcome).toBe('running');
    const runs = parseShellRuns(
      [
        askIn('msg_1', 'toolu_1', 'ls'),
        JSON.stringify({
          type: 'assistant',
          timestamp: T1,
          message: { content: [{ type: 'text', text: 'Done.' }] },
        }),
      ].join('\n'),
      SESSION,
    );
    expect(runs[0]?.outcome).toBe('running');
  });

  it('does not touch a background job — its end is the notice, not the next turn', () => {
    const runs = parseShellRuns(
      [
        askIn('msg_1', 'toolu_bg', 'npm run dev'),
        answer('toolu_bg', {
          content: 'Command running in background with ID: bg1. Output is being written to: /tmp/bg1.output.',
          toolUseResult: { backgroundTaskId: 'bg1' },
        }),
        say('msg_2', 'The server is up.'),
      ].join('\n'),
      SESSION,
    );
    expect(runs[0]?.outcome).toBe('background');
  });
});

// --------------------------------------------------- the first look reads it all

describe('ShellRunsTracker — the first look', () => {
  function fakeFs(text: string) {
    return {
      statSync: () => ({ size: Buffer.byteLength(text) }),
      openSync: () => 1,
      readSync: (_fd: number, buf: Buffer, off: number, len: number, pos: number) =>
        Buffer.from(text).copy(buf, off, pos, pos + len),
      closeSync: () => undefined,
    } as unknown as ConstructorParameters<typeof ShellRunsTracker>[0];
  }

  // The scenario the tail-seeded first draft got wrong: a dev server started
  // in the session's first minute, a megabyte of conversation on top of it,
  // and a window reload. The CLI's indicator said "1 shell running"; the
  // section said nothing, because the job's record was above its window.
  it('finds a background job started a megabyte before the end of the file', () => {
    const filler = JSON.stringify({
      type: 'user',
      timestamp: T1,
      message: { content: [{ type: 'text', text: 'x'.repeat(4_000) }] },
    });
    const lines = [
      askIn('msg_1', 'toolu_server', 'npm run dev'),
      answer('toolu_server', {
        content: 'Command running in background with ID: srv. Output is being written to: /tmp/srv.output.',
        toolUseResult: { backgroundTaskId: 'srv' },
      }),
      ...Array.from({ length: 300 }, () => filler), // ~1.2 MB
      askIn('msg_2', 'toolu_late', 'git status'),
      answer('toolu_late'),
    ];
    const tracker = new ShellRunsTracker(fakeFs(lines.join('\n') + '\n'));
    const runs = tracker.update({ id: SESSION, transcriptPath: '/fake/t.jsonl' });
    const server = runs.find((r) => r.id === 'toolu_server');
    expect(server?.outcome).toBe('background');
    expect(server?.outputFile).toBe('/tmp/srv.output');
  });
});
