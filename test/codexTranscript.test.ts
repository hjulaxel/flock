import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CODEX_STATS_MAX_BYTES,
  CodexCompletionTracker,
  CodexTranscriptCache,
  parseCodexTranscriptStats,
  readFirstCodexPrompt,
} from '../src/codexTranscript';
import { readCodexSessionNames, rolloutActivityMarkFromTail } from '../src/codex';
import { parseCodexSummaryReply } from '../src/closeSummary';
import { buildForest } from '../src/lineage';
import { buildViewModel } from '../src/viewmodel';
import { STATUS_DOT } from '../src/types';

const ID = '01a097ea-a731-7783-a894-1e4c50e5e00e';
const T1 = '2026-09-13T10:00:00.000Z';
const T2 = '2026-09-13T10:05:00.000Z';
const T3 = '2026-09-13T10:10:00.000Z';
const event = (type: string, timestamp = T1, extra = {}) =>
  JSON.stringify({ type: 'event_msg', timestamp, payload: { type, ...extra } });
const item = (type: string, timestamp = T1, extra = {}) =>
  JSON.stringify({ type: 'response_item', timestamp, payload: { type, ...extra } });
const message = (role: string, text: string, timestamp = T1, extra = {}) =>
  item('message', timestamp, { role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }], ...extra });

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-codex-stats-'));
  file = path.join(dir, 'rollout.jsonl');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('Codex transcript facts', () => {
  it('reads real user prompts, context tokens and replies without counting setup or bookkeeping as use', () => {
    const stats = parseCodexTranscriptStats([
      message('user', 'Fix the session list'),
      message('assistant', 'Fixed it', T2, { phase: 'final_answer' }),
      message('user', '<environment_context>setup</environment_context>', T3),
      message('developer', 'instructions', T3),
      event('thread_settings_applied', T3),
      event('token_count', T3, { info: {
        total_token_usage: { total_tokens: 900_000 },
        last_token_usage: { total_tokens: 12_345 },
      } }),
    ].join('\n'));
    expect(stats).toEqual({ lastPromptAt: Date.parse(T1), lastRecordAt: Date.parse(T2),
      tokens: 12_345, lastExchange: 'Fixed it' });
  });

  it('also supports user_message events and skips malformed records and invalid usage', () => {
    const stats = parseCodexTranscriptStats([
      'half a JSON record', event('user_message', T2, { message: 'Hello' }),
      event('token_count', T3, { info: { last_token_usage: { total_tokens: -1 } } }),
      'null', '[]', '{"payload":null}',
    ].join('\n'));
    expect(stats).toEqual({ lastPromptAt: Date.parse(T2), lastRecordAt: Date.parse(T2), lastExchange: 'Hello' });
  });

  it('reads a usable opening prompt past session metadata and injected setup', () => {
    fs.writeFileSync(file, [JSON.stringify({ type: 'session_meta', payload: { base_instructions: 'x'.repeat(40_000) } }),
      message('user', '# AGENTS.md instructions\nSetup'), message('user', 'Fix\n the age'),
      message('user', 'The next request', T2)].join('\n'));
    expect(readFirstCodexPrompt(file)).toBe('Fix the age');
  });

  it('uses the newest session name across account indexes, tolerating a partial write', () => {
    const other = path.join(dir, 'other');
    fs.mkdirSync(other);
    const name = (thread_name: string, updated_at: string) => JSON.stringify({ id: ID, thread_name, updated_at });
    fs.writeFileSync(path.join(dir, 'session_index.jsonl'), name('New title', T2) + '\n{"id":');
    fs.writeFileSync(path.join(other, 'session_index.jsonl'), name('Old title', T1) + '\n');
    expect(readCodexSessionNames([path.join(dir, 'sessions'), path.join(other, 'sessions')]).get(ID)).toBe('New title');
  });

  it('finds a prompt behind a long tool turn and retains it as more output is appended', () => {
    fs.writeFileSync(file, [event('task_started'), message('user', 'Run tests'),
      item('custom_tool_call_output', T2, { output: 'x'.repeat(200_000) })].join('\n') + '\n');
    const cache = new CodexTranscriptCache();
    const first = cache.get(file)!;
    expect(first.stats.lastPromptAt).toBe(Date.parse(T1));
    expect(first.activity?.status).toBe('busy');
    expect(cache.get(file)).toBe(first);
    fs.appendFileSync(file, item('custom_tool_call_output', T3, { output: 'x'.repeat(CODEX_STATS_MAX_BYTES) }) + '\n');
    const next = cache.get(file)!;
    expect(next.stats.lastPromptAt).toBe(Date.parse(T1));
    expect(next.activity?.status).toBe('busy');
    fs.appendFileSync(file, event('task_complete', T3) + '\n');
    expect(cache.get(file)?.activity).toEqual({ status: 'idle', at: Date.parse(T3) });
  });

  it('discards old facts when a file is rewritten, removed or the cache is pruned', () => {
    const cache = new CodexTranscriptCache();
    fs.writeFileSync(file, message('user', 'Hello') + '\n');
    expect(cache.get(file)?.stats.lastPromptAt).toBe(Date.parse(T1));
    fs.writeFileSync(file, '{}\n');
    expect(cache.get(file)?.stats).toEqual({});
    const reading = cache.get(file);
    cache.prune(new Set());
    expect(cache.get(file)).not.toBe(reading);
    fs.unlinkSync(file);
    expect(cache.get(file)).toBeUndefined();
    expect(cache.get(dir)).toBeUndefined();
  });

  it('feeds the shared row an age and amber/red dots as a Codex turn runs and finishes', () => {
    const cache = new CodexTranscriptCache();
    fs.writeFileSync(file, event('task_started') + '\n' + message('user', 'Hello') + '\n');
    const row = (done = false) => {
      const reading = cache.get(file)!;
      const forest = buildForest({
        entries: [{ sessionId: ID, status: reading.activity?.status, kind: 'interactive' }],
        records: { [ID]: { id: ID, createdAt: T1, updatedAt: T1, provider: 'codex',
          ...(done ? { doneAt: T2 } : {}) } },
        resolutions: new Map(),
        activityMtimes: new Map([[ID, reading.mtimeMs]]),
        tailStats: new Map([[ID, reading.stats]]),
      });
      return buildViewModel({
        forest, grouping: { projects: [], folders: [], loose: [ID], hiddenCount: 0,
          outOfScopeCount: 0, hiddenRunning: null },
        collapsed: new Set(), providerFor: () => 'codex', isBoundHere: () => true,
        viewId: 'test', now: Date.parse(T3),
      }).find(r => r.kind === 'session')!;
    };
    expect(row().description).toContain('10m');
    expect(row().badge).toBe(STATUS_DOT);
    expect(row().badgeKind).toBe('running');
    fs.appendFileSync(file, event('task_complete', T2) + '\n');
    expect(row(true).description).toContain('10m');
    expect(row(true).badge).toBe(STATUS_DOT);
    expect(row(true).badgeKind).toBe('done');
  });
});

describe('Codex summaries and completion notifications', () => {
  it('accepts only a new final answer as the requested closing summary', () => {
    const text = [message('assistant', 'Old answer', T1, { phase: 'final_answer' }),
      message('assistant', 'Working on it', T2, { phase: 'commentary' })].join('\n');
    expect(parseCodexSummaryReply(text, Date.parse(T2))).toBeUndefined();
    expect(parseCodexSummaryReply(text + '\n' + message('assistant', 'Verified the fix', T3,
      { phase: 'final_answer' }), Date.parse(T2))).toBe('Verified the fix');
  });

  it('notifies for a whole turn between two idle polls without replaying a backlog at startup', () => {
    const tracker = new CodexCompletionTracker();
    expect(tracker.observe(ID, Date.parse(T1))).toBe(false);
    expect(tracker.observe(ID, Date.parse(T1))).toBe(false);
    expect(tracker.observe(ID, Date.parse(T2))).toBe(true);
    expect(tracker.observe(ID, Date.parse(T2))).toBe(false);
    tracker.prune(new Set());
    expect(tracker.observe(ID, Date.parse(T3))).toBe(false);
    expect(tracker.observe('new', undefined)).toBe(false);
    expect(tracker.observe('new', Date.parse(T3))).toBe(true);
  });
});

describe('Codex activity beyond the turn boundary', () => {
  it('keeps a long turn working when only tool traffic fits in the tail', () => {
    expect(rolloutActivityMarkFromTail(item('function_call', T2, { name: 'exec_command' })))
      .toEqual({ status: 'busy', at: Date.parse(T2) });
    expect(rolloutActivityMarkFromTail(message('assistant', 'Done', T3, { phase: 'final_answer' })))
      .toEqual({ status: 'idle', at: Date.parse(T3) });
  });

  it('does not let bookkeeping or fields inside another record forge a status', () => {
    expect(rolloutActivityMarkFromTail(event('thread_settings_applied', T3))).toBeNull();
    expect(rolloutActivityMarkFromTail(JSON.stringify({ type: 'other', event_msg: true,
      payload: { type: 'task_started' } }))).toBeNull();
    expect(rolloutActivityMarkFromTail([event('task_complete', T2),
      event('thread_settings_applied', T3)].join('\n'))).toEqual({ status: 'idle', at: Date.parse(T2) });
  });
});
