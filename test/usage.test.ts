// test/usage.test.ts — what the transcript TAIL says about a session: when the
// user last prompted it, and how big the conversation has got.
//
// Written against temp files, never the real ~/.claude/projects: these
// assertions must not depend on which sessions happen to exist on the machine.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  HEAD_MAX_BYTES,
  LAST_EXCHANGE_MAX_CHARS,
  TAIL_MAX_BYTES,
  TranscriptStatsCache,
  contextTokensOf,
  isUserPrompt,
  readFirstPrompt,
  readTailStats,
} from '../src/usage';
import { formatTokens } from '../src/viewmodel';

const A = '0f00000a-0000-4000-8000-00000000000a';

let root: string;

function write(name: string, lines: unknown[]): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

/** A prompt the person typed. */
function prompt(timestamp: string, text = 'do the thing'): unknown {
  return {
    type: 'user',
    timestamp,
    message: { role: 'user', content: text },
  };
}

/** A tool RESULT, which the CLI also files under `type: 'user'`. */
function toolResult(timestamp: string): unknown {
  return {
    type: 'user',
    timestamp,
    toolUseResult: { stdout: 'ok' },
    message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
  };
}

function assistant(timestamp: string, usage: Record<string, number>): unknown {
  return {
    type: 'assistant',
    timestamp,
    message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage },
  };
}

const T1 = '2026-07-31T10:00:00.000Z';
const T2 = '2026-07-31T11:00:00.000Z';
const T3 = '2026-07-31T12:00:00.000Z';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-usage-'));
});

afterEach(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe('isUserPrompt: what counts as the user speaking', () => {
  it('accepts a plain string prompt', () => {
    expect(isUserPrompt(prompt(T1) as Record<string, unknown>)).toBe(true);
  });

  it('accepts a content array carrying a text block', () => {
    expect(
      isUserPrompt({
        type: 'user',
        message: { content: [{ type: 'text', text: 'hello' }] },
      }),
    ).toBe(true);
  });

  it('refuses a tool result', () => {
    // The load-bearing case: tool results outnumber real prompts roughly 4:1
    // in a working session, and counting them would make an unattended agentic
    // run read as somebody sitting there typing.
    expect(isUserPrompt(toolResult(T1) as Record<string, unknown>)).toBe(false);
  });

  it('refuses the CLI’s own injected preamble and a sub-agent’s turn', () => {
    expect(
      isUserPrompt({ type: 'user', isMeta: true, message: { content: 'x' } }),
    ).toBe(false);
    expect(
      isUserPrompt({ type: 'user', isSidechain: true, message: { content: 'x' } }),
    ).toBe(false);
  });

  it('refuses an assistant line, an empty prompt and a shapeless one', () => {
    expect(isUserPrompt({ type: 'assistant', message: { content: 'x' } })).toBe(false);
    expect(isUserPrompt({ type: 'user', message: { content: '   ' } })).toBe(false);
    expect(isUserPrompt({ type: 'user' })).toBe(false);
  });
});

describe('contextTokensOf: the size of the conversation', () => {
  it('counts the cache, which is where nearly all of it lives', () => {
    // Leaving cache_read out is the classic mistake: this exact usage record
    // (measured off a real transcript) would report "2 tokens" for a
    // 287k-token conversation.
    expect(
      contextTokensOf({
        input_tokens: 2,
        cache_creation_input_tokens: 1743,
        cache_read_input_tokens: 282_827,
        output_tokens: 2635,
      }),
    ).toBe(287_207);
  });

  it('costs a missing or junk field its own term, never the whole number', () => {
    expect(contextTokensOf({ input_tokens: 10, output_tokens: 5 })).toBe(15);
    expect(
      contextTokensOf({ input_tokens: 10, cache_read_input_tokens: 'lots' }),
    ).toBe(10);
    expect(contextTokensOf({})).toBe(0);
  });
});

describe('readTailStats', () => {
  it('reads the last prompt and the last usage, tracked independently', () => {
    // Mid-turn: the newest usage record is NEWER than the newest prompt, which
    // is the normal state of a session that is working.
    const file = write('a.jsonl', [
      prompt(T1, 'first'),
      assistant(T1, { input_tokens: 5, output_tokens: 5 }),
      prompt(T2, 'second'),
      toolResult(T3),
      assistant(T3, { input_tokens: 1, cache_read_input_tokens: 999 }),
    ]);
    expect(readTailStats(file)).toEqual({
      lastPromptAt: Date.parse(T2),
      tokens: 1000,
      // The idle clock: the newest REAL record of any kind — here the
      // assistant line still working at T3.
      lastRecordAt: Date.parse(T3),
      // The archived-row snippet source: the assistant's last words.
      lastExchange: 'hi',
    });
  });

  it('is silent about what it cannot see rather than guessing', () => {
    const noPrompt = write('b.jsonl', [assistant(T1, { input_tokens: 7 })]);
    expect(readTailStats(noPrompt)).toEqual({
      tokens: 7,
      lastRecordAt: Date.parse(T1),
      lastExchange: 'hi',
    });

    // A window with no assistant text falls back to the last PROMPT for the
    // exchange: an unanswered question is still what the session was about.
    const noUsage = write('c.jsonl', [prompt(T1)]);
    expect(readTailStats(noUsage)).toEqual({
      lastPromptAt: Date.parse(T1),
      lastRecordAt: Date.parse(T1),
      lastExchange: 'do the thing',
    });

    expect(readTailStats(path.join(root, 'nope.jsonl'))).toEqual({});
    expect(readTailStats(write('empty.jsonl', []))).toEqual({});
  });

  it('skips malformed lines instead of giving up on the file', () => {
    const file = path.join(root, 'd.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify(prompt(T1)),
        '{"broken": ',
        'not json at all',
        JSON.stringify(assistant(T2, { output_tokens: 3 })),
      ].join('\n') + '\n',
    );
    expect(readTailStats(file)).toEqual({
      lastPromptAt: Date.parse(T1),
      tokens: 3,
      lastRecordAt: Date.parse(T2),
      lastExchange: 'hi',
    });
  });

  it('reads only the tail, and drops the fragment the cut leaves behind', () => {
    // A prompt buried past the window is invisible on purpose — that is the
    // bound. The renderers fall back to the transcript mtime for it, which is
    // exactly what every row showed before this module existed.
    const filler = { type: 'assistant', message: { content: 'x'.repeat(2000) } };
    const lines: unknown[] = [prompt(T1, 'ancient')];
    for (let i = 0; i < 80; i++) lines.push(filler);
    lines.push(assistant(T3, { output_tokens: 11 }));
    const file = write('e.jsonl', lines);
    expect(fs.statSync(file).size).toBeGreaterThan(TAIL_MAX_BYTES);

    const stats = readTailStats(file);
    expect(stats.lastPromptAt).toBeUndefined();
    expect(stats.tokens).toBe(11);

    // The same file read whole DOES see it — proving the absence above is the
    // window, not a parsing bug.
    expect(readTailStats(file, 10 * 1024 * 1024).lastPromptAt).toBe(
      Date.parse(T1),
    );
  });

  it('keeps the first line when the window covered the whole file', () => {
    // The fragment-dropping rule must not eat a real first line of a short
    // transcript — which is every brand-new session.
    const file = write('f.jsonl', [prompt(T1)]);
    expect(readTailStats(file).lastPromptAt).toBe(Date.parse(T1));
  });
});

describe('readTailStats: lastExchange — what the session concluded', () => {
  it('prefers the assistant’s reply over a prompt typed after it', () => {
    // An unanswered "also fix X" typed just before closing is not the
    // conclusion; the answer above it is.
    const file = write('x1.jsonl', [
      assistant(T1, { output_tokens: 1 }),
      prompt(T2, 'also fix the other thing'),
    ]);
    expect(readTailStats(file).lastExchange).toBe('hi');
  });

  it('skips a sub-agent’s words — a sidechain is not the conversation', () => {
    const file = write('x2.jsonl', [
      assistant(T1, { output_tokens: 1 }),
      {
        type: 'assistant',
        timestamp: T2,
        isSidechain: true,
        message: { content: [{ type: 'text', text: 'sub-agent noise' }] },
      },
    ]);
    expect(readTailStats(file).lastExchange).toBe('hi');
  });

  it('contributes nothing for an all-tool-calls turn', () => {
    // No text block, no conclusion — right for a turn that only ran tools.
    const file = write('x3.jsonl', [
      {
        type: 'assistant',
        timestamp: T1,
        message: { content: [{ type: 'tool_use', name: 'Bash' }] },
      },
    ]);
    expect(readTailStats(file).lastExchange).toBeUndefined();
  });

  it('caps at LAST_EXCHANGE_MAX_CHARS with a visible cut', () => {
    const long = 'y'.repeat(LAST_EXCHANGE_MAX_CHARS * 2);
    const file = write('x4.jsonl', [
      {
        type: 'assistant',
        timestamp: T1,
        message: { content: [{ type: 'text', text: long }] },
      },
    ]);
    const got = readTailStats(file).lastExchange;
    expect(got).toBeDefined();
    expect(got!.length).toBe(LAST_EXCHANGE_MAX_CHARS);
    expect(got!.endsWith('…')).toBe(true);
  });
});

describe('TranscriptStatsCache', () => {
  it('re-reads only when the stat moved', () => {
    const file = write('g.jsonl', [prompt(T1)]);
    const cache = new TranscriptStatsCache();
    const first = cache.get(A, file, 100, 10);
    expect(first.lastPromptAt).toBe(Date.parse(T1));

    // Same (mtime, size): the answer must come back without touching the disk,
    // which is observable by rewriting the file underneath it.
    fs.writeFileSync(file, JSON.stringify(prompt(T3)) + '\n');
    expect(cache.get(A, file, 100, 10).lastPromptAt).toBe(Date.parse(T1));

    // A moved stat re-reads.
    expect(cache.get(A, file, 101, 12).lastPromptAt).toBe(Date.parse(T3));
  });

  it('forgets ids the caller stopped asking about', () => {
    const file = write('h.jsonl', [prompt(T1)]);
    const cache = new TranscriptStatsCache();
    cache.get(A, file, 1, 1);
    cache.prune(new Set());
    // Pruned, so this re-reads — and the rewritten file is what proves it.
    fs.writeFileSync(file, JSON.stringify(prompt(T3)) + '\n');
    expect(cache.get(A, file, 1, 1).lastPromptAt).toBe(Date.parse(T3));
  });

  it('forgets a stale id even when keep is the same size or bigger', () => {
    // Regression: prune() used to skip the membership sweep whenever
    // `keep.size >= cache.size`, which only holds if cache is a subset of
    // keep. Here `keep` names an id that was never actually cached, so the
    // sizes line up (1 vs 1) while the cached id (A) is not in keep at all.
    const file = write('i.jsonl', [prompt(T1)]);
    const cache = new TranscriptStatsCache();
    cache.get(A, file, 1, 1);
    cache.prune(new Set(['0f00000b-0000-4000-8000-00000000000b']));
    fs.writeFileSync(file, JSON.stringify(prompt(T3)) + '\n');
    expect(cache.get(A, file, 1, 1).lastPromptAt).toBe(Date.parse(T3));
  });

  it('never throws on an unreadable transcript', () => {
    const cache = new TranscriptStatsCache();
    expect(cache.get(A, path.join(root, 'gone.jsonl'), 1, 1)).toEqual({});
    cache.dispose();
  });
});

describe('formatTokens: how a row reads a count', () => {
  it('scales the unit and drops a spurious .0', () => {
    expect(formatTokens(840)).toBe('840');
    expect(formatTokens(12_345)).toBe('12.3k');
    expect(formatTokens(12_000)).toBe('12k');
    expect(formatTokens(287_207)).toBe('287k');
    expect(formatTokens(1_250_000)).toBe('1.3M');
    expect(formatTokens(2_000_000)).toBe('2M');
  });

  it('renders nothing at all for an unknown count', () => {
    // Not '0', not '—': an empty string is what keeps the description's ' · '
    // separator off a row that has no number to show.
    expect(formatTokens(undefined)).toBe('');
    expect(formatTokens(0)).toBe('');
    expect(formatTokens(-5)).toBe('');
    expect(formatTokens(Number.NaN)).toBe('');
  });
});

// ------------------------------------------------ the transcript's first line

describe('readFirstPrompt: what a chat was about', () => {
  it('returns the first thing the PERSON said', () => {
    const file = write('first.jsonl', [
      prompt(T1, 'why is the roster polling twice'),
      prompt(T2, 'and now this'),
    ]);
    expect(readFirstPrompt(file)).toBe('why is the roster polling twice');
  });

  it('steps over the CLI preamble that sits in front of it', () => {
    const file = write('preamble.jsonl', [
      { type: 'custom-title', customTitle: 'Chat · API' },
      { type: 'user', timestamp: T1, isMeta: true, message: { content: 'env dump' } },
      toolResult(T1),
      { type: 'assistant', timestamp: T1, message: { content: 'hello' } },
      prompt(T2, 'the actual question'),
    ]);
    expect(readFirstPrompt(file)).toBe('the actual question');
  });

  it('joins the text blocks of an array-content prompt and drops the rest', () => {
    const file = write('blocks.jsonl', [
      {
        type: 'user',
        timestamp: T1,
        message: {
          role: 'user',
          content: [
            { type: 'image', source: {} },
            { type: 'text', text: 'look at this' },
            { type: 'text', text: 'and this' },
          ],
        },
      },
    ]);
    expect(readFirstPrompt(file)).toBe('look at this\nand this');
  });

  it('keeps the newlines — trimming is the caller\'s business', () => {
    const file = write('multi.jsonl', [prompt(T1, 'line one\nline two')]);
    expect(readFirstPrompt(file)).toBe('line one\nline two');
  });

  it('is undefined for a transcript nobody has spoken to yet', () => {
    const file = write('quiet.jsonl', [
      { type: 'custom-title', customTitle: 'Chat · API' },
    ]);
    expect(readFirstPrompt(file)).toBeUndefined();
  });

  it('is undefined, never a throw, for a file that is not there', () => {
    expect(readFirstPrompt(path.join(root, 'nope.jsonl'))).toBeUndefined();
  });

  it('skips garbage lines instead of giving up on the file', () => {
    const file = path.join(root, 'garbage.jsonl');
    fs.writeFileSync(
      file,
      ['{not json', '', JSON.stringify(prompt(T1, 'still found'))].join('\n'),
    );
    expect(readFirstPrompt(file)).toBe('still found');
  });

  it('reads only the head, so a prompt past the window is not found', () => {
    // The bound is the point: a transcript is unbounded and this runs per row.
    const filler = { type: 'assistant', timestamp: T1, message: { content: 'x'.repeat(500) } };
    const file = write('big.jsonl', [
      ...Array.from({ length: 200 }, () => filler),
      prompt(T2, 'too deep to see'),
    ]);
    expect(readFirstPrompt(file, 1024)).toBeUndefined();
    // …and is found once the window covers it.
    expect(readFirstPrompt(file, HEAD_MAX_BYTES * 64)).toBe('too deep to see');
  });
});
