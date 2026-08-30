// test/closeSummary.test.ts — reading back the summary the Claude CLI wrote.
//
// The fixtures are built to the shape actually observed on disk: a
// `compact_boundary` system record, then one line later a
// `{"type":"user","isCompactSummary":true}` record whose message content
// carries the CLI's fixed preamble and then the body. Every assertion here is
// a fact measured over 43 real compactions, and the comments say which.

import { describe, expect, it } from 'vitest';

import { MAX_FORK_NOTE_CHARS } from '../src/forkNote';
import {
  MAX_RECORDED_SUMMARY_CHARS,
  parseCompactSummary,
  summaryForParentNote,
  summaryForRecord,
} from '../src/closeSummary';

const PREAMBLE =
  'This session is being continued from a previous conversation that ran ' +
  'out of context. The summary below covers the earlier portion of the ' +
  'conversation.\n\nSummary:\n';

function boundary(at: string): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    timestamp: at,
    compactMetadata: { trigger: 'manual', durationMs: 123368 },
  });
}

function summaryRecord(at: string, body: string): string {
  return JSON.stringify({
    type: 'user',
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
    timestamp: at,
    message: { role: 'user', content: PREAMBLE + body },
  });
}

const T1 = '2026-08-01T10:00:00.000Z';
const T2 = '2026-08-28T10:00:00.000Z';

describe('parseCompactSummary', () => {
  it('finds the summary and strips the CLI preamble', () => {
    const text = [
      JSON.stringify({ type: 'user', message: { content: 'hello' } }),
      boundary(T2),
      summaryRecord(T2, 'Traced the drift to a stale cache key.'),
      '',
    ].join('\n');
    expect(parseCompactSummary(text)).toBe(
      'Traced the drift to a stale cache key.',
    );
  });

  it('reads a content-block array as well as a plain string', () => {
    const line = JSON.stringify({
      type: 'user',
      isCompactSummary: true,
      timestamp: T2,
      message: {
        content: [
          { type: 'text', text: PREAMBLE + 'Part one.' },
          { type: 'text', text: 'Part two.' },
        ],
      },
    });
    expect(parseCompactSummary(line)).toBe('Part one.\nPart two.');
  });

  it('ignores a summary older than the request, and takes the last otherwise', () => {
    // 29 of 43 real compactions stayed in the SAME transcript file as an
    // earlier one, so a window holding two summaries is the ordinary case —
    // and reporting last month's as this branch's conclusion is a confident
    // lie rather than a missing feature.
    const text = [
      boundary(T1),
      summaryRecord(T1, 'The old conclusion.'),
      boundary(T2),
      summaryRecord(T2, 'The new conclusion.'),
    ].join('\n');
    expect(parseCompactSummary(text)).toBe('The new conclusion.');
    expect(parseCompactSummary(text, Date.parse(T2))).toBe(
      'The new conclusion.',
    );
    // A floor after both leaves nothing — which the verb reads as "not yet".
    expect(
      parseCompactSummary(text, Date.parse(T2) + 1000),
    ).toBeUndefined();
  });

  it('rejects a summary with no parsable timestamp when a floor is given', () => {
    const line = JSON.stringify({
      type: 'user',
      isCompactSummary: true,
      message: { content: PREAMBLE + 'Undated.' },
    });
    expect(parseCompactSummary(line)).toBe('Undated.');
    expect(parseCompactSummary(line, Date.parse(T1))).toBeUndefined();
  });

  it('is not fooled by a tool result that merely mentions the field names', () => {
    // Not hypothetical: an unparsed scan of ~/.claude/projects produced 27
    // such false positives, every one a tool_result that had read this
    // repository's own source.
    const text = JSON.stringify({
      type: 'user',
      timestamp: T2,
      toolUseResult: { stdout: 'compact_boundary isCompactSummary' },
      message: {
        content: [
          {
            type: 'tool_result',
            content:
              'src/closeSummary.ts: isCompactSummary === true, compact_boundary',
          },
        ],
      },
    });
    expect(parseCompactSummary(text)).toBeUndefined();
  });

  it('survives a truncated first line, garbage, and an empty file', () => {
    const good = summaryRecord(T2, 'Real.');
    expect(parseCompactSummary(`{"type":"user","isCom\n${good}`)).toBe('Real.');
    expect(parseCompactSummary('not json at all\n\n')).toBeUndefined();
    expect(parseCompactSummary('')).toBeUndefined();
  });

  it('leaves a body alone when it is not the documented preamble', () => {
    const line = JSON.stringify({
      type: 'user',
      isCompactSummary: true,
      timestamp: T2,
      message: {
        content: 'Summary: we decided to keep the cache key as it was.',
      },
    });
    // A wrong strip silently deletes the top of the summary, so the preamble
    // has to be recognised as itself rather than by the word "Summary:".
    expect(parseCompactSummary(line)).toBe(
      'Summary: we decided to keep the cache key as it was.',
    );
  });

  it('yields undefined for a message shape it does not recognise', () => {
    const line = JSON.stringify({
      type: 'user',
      isCompactSummary: true,
      timestamp: T2,
      message: { content: { unexpected: true } },
    });
    // Rather than `String(someObject)`, which is how "[object Object]" ends up
    // recorded as a branch's conclusion.
    expect(parseCompactSummary(line)).toBeUndefined();
  });
});

describe('the recorded summary and the parent note are both bounded', () => {
  // 27,147 characters is the real maximum measured on this machine.
  const HUGE = 'word '.repeat(6000);

  it('caps what goes on the record, on one line', () => {
    const recorded = summaryForRecord(HUGE);
    expect(recorded.length).toBeLessThanOrEqual(MAX_RECORDED_SUMMARY_CHARS);
    expect(recorded).not.toContain('\n');
    expect(recorded.endsWith('…')).toBe(true);
  });

  it('caps the parent note much harder, and names the branch first', () => {
    const note = summaryForParentNote(HUGE, 'auth 3');
    expect(note.length).toBeLessThanOrEqual(MAX_FORK_NOTE_CHARS);
    expect(note).not.toContain('\n');
    expect(note).toContain('"auth 3"');
  });

  it('never cuts an emoji in half when it truncates', () => {
    // Same defect, same reason as src/forkNote.ts's: the budget is counted in
    // the UTF-16 units the channel and state.json actually spend, so a cut can
    // land inside a surrogate pair. Here the broken half is also PERSISTED — it
    // goes onto the record and from there onto the row's description.
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
    const BIRDS = '\u{1F426}'.repeat(600);
    expect(summaryForRecord(BIRDS)).not.toMatch(lone);
    expect(summaryForParentNote(BIRDS, 'auth 3')).not.toMatch(lone);
    expect(summaryForParentNote('ok', '\u{1F426}'.repeat(60))).not.toMatch(lone);
  });

  it('leaves a short summary intact', () => {
    expect(summaryForRecord('  Fixed the cache key.  ')).toBe(
      'Fixed the cache key.',
    );
  });
});
