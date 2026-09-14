// Codex conversation facts, shared by the roster and both tree renderers.
import * as fs from 'node:fs';
import { rolloutActivityMarkFromTail, type RolloutActivityMark } from './codex';
import {
  LAST_EXCHANGE_MAX_CHARS,
  TAIL_MAX_BYTES,
  readTranscriptTail,
  type TranscriptStats,
} from './usage';

/** A cold read can look behind a long tool turn for its prompt. Subsequent
 * reads cover appended bytes plus an overlap, and retain earlier facts. */
export const CODEX_STATS_MAX_BYTES = 4 * 1024 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageText(payload: Record<string, unknown>): string | undefined {
  if (!Array.isArray(payload['content'])) return undefined;
  const text = payload['content'].flatMap((part: unknown) =>
    object(part) && (part['type'] === 'input_text' || part['type'] === 'output_text') &&
      typeof part['text'] === 'string' ? [part['text']] : [],
  ).join('\n').trim();
  return text === '' ? undefined : text;
}

/** User-role setup and interrupted-turn envelopes are not submitted prompts. */
function isPrompt(text: string): boolean {
  return !/^(?:# AGENTS\.md instructions|<environment_context>|<permissions instructions>|<turn_aborted>|<subagent_notification>)/.test(text);
}

export function readFirstCodexPrompt(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const length = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.toString('utf8', 0, length).split('\n')) {
      const stats = parseCodexTranscriptStats(line);
      if (stats.lastPromptAt !== undefined && stats.lastExchange !== undefined) {
        return stats.lastExchange.replace(/\s+/g, ' ').trim();
      }
    }
  } catch { /* a new or unreadable rollout has no opening prompt yet */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return undefined;
}

export interface CodexTranscriptStats extends TranscriptStats {
  completedAt?: number;
}

export function parseCodexTranscriptStats(text: string): CodexTranscriptStats {
  const stats: CodexTranscriptStats = {};
  let assistant: string | undefined;
  let prompt: string | undefined;
  for (const line of text.split('\n')) {
    let rec: unknown;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!object(rec) || !object(rec['payload'])) continue;
    const payload = rec['payload'];
    const at = typeof rec['timestamp'] === 'string'
      ? Date.parse(rec['timestamp']) : Number.NaN;
    const type = payload['type'];
    let conversation = false;
    let userText: string | undefined;
    if (rec['type'] === 'event_msg') {
      if (type === 'user_message' && typeof payload['message'] === 'string') {
        userText = payload['message'].trim() || undefined;
      }
      if (type === 'task_started' || type === 'task_complete' || type === 'turn_aborted') {
        conversation = true;
      }
      if ((type === 'task_complete' || type === 'turn_aborted') && Number.isFinite(at)) {
        stats.completedAt = at;
      }
      if (type === 'token_count' && object(payload['info'])) {
        // last_token_usage describes the current context. total_token_usage
        // accumulates every request and would make a small session look full.
        const usage = payload['info']['last_token_usage'];
        if (object(usage)) {
          const total = usage['total_tokens'];
          if (typeof total === 'number' && Number.isFinite(total) && total > 0) {
            stats.tokens = total;
          }
        }
      }
    } else if (rec['type'] === 'response_item') {
      if (type === 'message') {
        const content = messageText(payload);
        if (payload['role'] === 'user' && content !== undefined && isPrompt(content)) {
          userText = content;
        } else if (payload['role'] === 'assistant') {
          conversation = true;
          if (content !== undefined) assistant = content;
        }
      } else if (type === 'agent_message') {
        conversation = true;
        if (Number.isFinite(at)) stats.sidechainAt = at;
      } else if (type === 'reasoning' || type === 'function_call' ||
          type === 'function_call_output' || type === 'custom_tool_call' ||
          type === 'custom_tool_call_output') {
        conversation = true;
      }
    }
    if (userText !== undefined) {
      prompt = userText;
      conversation = true;
      if (Number.isFinite(at)) stats.lastPromptAt = at;
    }
    if (conversation && Number.isFinite(at)) stats.lastRecordAt = at;
  }
  const exchange = assistant ?? prompt;
  if (exchange !== undefined) {
    stats.lastExchange = exchange.length > LAST_EXCHANGE_MAX_CHARS
      ? exchange.slice(0, LAST_EXCHANGE_MAX_CHARS - 1) + '…' : exchange;
  }
  return stats;
}

export interface CodexTranscriptReading {
  mtimeMs: number;
  size: number;
  stats: CodexTranscriptStats;
  activity: RolloutActivityMark | null;
}

interface CachedReading extends CodexTranscriptReading {
  ino: number;
  dev: number;
}

export class CodexTranscriptCache {
  private readonly cache = new Map<string, CachedReading>();

  get(file: string): CodexTranscriptReading | undefined {
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) return undefined;
      const hit = this.cache.get(file);
      const sameFile = hit !== undefined && hit.ino === st.ino && hit.dev === st.dev;
      if (sameFile && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
      const appended = sameFile && st.size > hit.size;
      const budget = Math.min(CODEX_STATS_MAX_BYTES,
        appended ? st.size - hit.size + TAIL_MAX_BYTES : st.size);
      const tail = readTranscriptTail(file, budget);
      const stats = parseCodexTranscriptStats(tail);
      const reading: CachedReading = {
        mtimeMs: st.mtimeMs,
        size: st.size,
        ino: st.ino,
        dev: st.dev,
        stats: appended ? { ...hit.stats, ...stats } : stats,
        activity: rolloutActivityMarkFromTail(tail) ?? (appended ? hit.activity : null),
      };
      this.cache.set(file, reading);
      return reading;
    } catch {
      this.cache.delete(file);
      return undefined;
    }
  }

  prune(files: ReadonlySet<string>): void {
    for (const file of this.cache.keys()) {
      if (!files.has(file)) this.cache.delete(file);
    }
  }

  dispose(): void { this.cache.clear(); }
}

/** An idle → idle poll can contain a complete short turn. Seed without
 * notifications on first sight; report only finishes observed afterwards. */
export class CodexCompletionTracker {
  private readonly seen = new Map<string, number | undefined>();

  observe(id: string, completedAt: number | undefined): boolean {
    const previous = this.seen.get(id);
    const advanced = this.seen.has(id) && completedAt !== undefined &&
      Number.isFinite(completedAt) && (previous === undefined || completedAt > previous);
    this.seen.set(id, completedAt ?? previous);
    return advanced;
  }

  prune(ids: ReadonlySet<string>): void {
    for (const id of this.seen.keys()) if (!ids.has(id)) this.seen.delete(id);
  }

  dispose(): void { this.seen.clear(); }
}
