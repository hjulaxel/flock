// src/antigravity.ts — Google's Antigravity CLI (`agy`): finding it, launching
// it, reading its transcripts, and what its hook events mean. Plain functions,
// wired into the core next to the Codex ones (src/codex.ts).
//
// agy replaced the Gemini CLI for consumer accounts on 2026-06-18. It is a Go
// binary that shares its agent harness with the Antigravity desktop app and
// runs Gemini models, plus Claude and GPT-OSS ones, behind one command. Every
// fact below was OBSERVED on agy 1.3.4 (2026-10-13) unless it says otherwise.
//
// ============================================================================
// WHAT AGY GIVES FLOCK
// ============================================================================
//
//   BINARY — `agy`, installed by Google's script to `~/.local/bin/agy`
//     (Windows: `%LOCALAPPDATA%\agy\bin`). It updates itself. An extension
//     host started from the Dock often has no `~/.local/bin` on PATH, so that
//     directory is the fallback.
//
//   ARGV — `--conversation <id>` reopens a conversation; `-i` /
//     `--prompt-interactive <text>` runs an opening prompt and stays
//     interactive; `--add-dir <dir>` is repeatable, one directory per flag.
//     There is NO flag that chooses a new conversation's id, NO name flag, NO
//     system-prompt flag and NO fork flag. A slash command passed to `-i` is
//     sent to the model as text, not run, so `/rename` cannot ride the argv.
//
//   THE ID ARRIVES IN THE FIRST HOOK. agy mints the
//     conversation id inside the process. Its SessionStart hook carries it as
//     `conversationId`, and the hook process inherits the terminal's
//     environment, so the same event carries Flock's LINEAGE_NODE_ID. The core
//     moves the row from the launch id to the real one on that event
//     (`planAntigravityId` here, `adoptAntigravityId` in extension.ts): exact, because both ids came out of
//     one process, with no window and no guessing. That is what Codex's
//     thirty-second rollout watch has to approximate.
//
//   SessionStart does NOT fire on `--conversation` (a resume keeps the id
//     Flock already has) nor on `/fork`. After `/fork` the next turn's hooks
//     carry the NEW id under the same LINEAGE_NODE_ID: the tab now shows a
//     different conversation. The core treats that as a child of the one the
//     tab showed before, and moves the tab to it.
//
//   STATUS — three hook events: `PreInvocation` (the agent started a step:
//     busy) and `Stop` (with `fullyIdle: true`: idle). SessionStart says
//     nothing about status, on purpose: it fires BEFORE the folder-trust
//     prompt, and a row that read idle there would let Flock type into a trust
//     dialog.
//
//   NO "WAITING" SIGNAL. A permission prompt is a `PreToolUse` with no
//     `PostToolUse` after it, and agy's own database says RUNNING throughout.
//     That cannot be told apart from a slow command, so Flock never shows an
//     Antigravity row as waiting: it reads busy while agy asks. The keystroke guard
//     therefore allows typing only into a row whose last word was `Stop`
//     fully idle.
//
//   NO EXIT EVENT. `/exit` fires no hook. A row ends when its terminal's
//     process does, which the core already watches. It is also why only
//     sessions Flock launched get live rows: one started elsewhere would have
//     nothing to end its row, so it appears as history instead.
//
//   STORAGE — `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/
//     transcript.jsonl`, one step per line:
//       {"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT",
//        "created_at":"2026-10-13T20:05:43Z","content":"<USER_REQUEST>\n…"}
//       {"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE",
//        "input_tokens":11884,"cache_read_tokens":0,"output_tokens":1,…}
//     Timestamps are whole seconds. Titles, folders and parents are in
//     `conversation_summaries.db`, which is SQLite and which this extension
//     cannot read without a native dependency. So an archived row's folder
//     comes from Flock's own record, or from `cache/last_conversations.json`
//     (`{ "<abs folder>": "<latest id>" }`), and is otherwise left unknown
//     rather than guessed.
//
//   ACCOUNTS — none. agy keeps its sign-in in the OS keyring and documents no
//     variable that relocates its config, so an Antigravity account is the
//     machine's one login and claims no isolation.
//
// ============================================================================

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as process from 'node:process';

import { TAIL_MAX_BYTES, readTranscriptTail } from './usage';
import type { TranscriptStats } from './usage';
import type { ArchivedSession, HookEvent, LaunchOptions, SessionStatus } from './types';
import type { DiscoveryWorld } from './roster';
import { antigravityCliDir } from './antigravityHooks';

// ------------------------------------------------------------------- paths

export function antigravityBrainDir(home: string | undefined): string {
  return path.join(antigravityCliDir(home), 'brain');
}

/** The transcript agy writes for one conversation. */
export function antigravityTranscriptPath(home: string | undefined, id: string): string {
  return path.join(
    antigravityBrainDir(home),
    id,
    '.system_generated',
    'logs',
    'transcript.jsonl',
  );
}

// ------------------------------------------------------------------ binary

/** Where agy's installer puts it, beyond PATH. */
export function antigravityFallbackBinDirs(world: DiscoveryWorld = {}): string[] {
  const platform = world.platform ?? process.platform;
  const env = world.env ?? process.env;
  const home = world.home ?? os.homedir();
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA'];
    return typeof local === 'string' && local !== '' ? [path.join(local, 'agy', 'bin')] : [];
  }
  return [path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
}

function fileAt(candidate: string): string | null {
  try {
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

/** The `agy` executable, or null. A configured path wins verbatim. */
export function findAntigravityBinary(
  configured?: string,
  world: DiscoveryWorld = {},
): string | null {
  if (typeof configured === 'string' && configured.trim().length > 0) return configured;
  const platform = world.platform ?? process.platform;
  const env = world.env ?? process.env;
  const names = platform === 'win32' ? ['agy.exe'] : ['agy'];
  const rawPath = env['PATH'] ?? env['Path'] ?? '';
  const dirs = rawPath.length > 0 ? rawPath.split(path.delimiter) : [];
  for (const dir of [...dirs, ...antigravityFallbackBinDirs(world)]) {
    if (!dir) continue;
    for (const name of names) {
      const hit = fileAt(path.resolve(dir, name));
      if (hit !== null) return hit;
    }
  }
  return null;
}

// -------------------------------------------------------------------- argv

/**
 * PURE. The argv for one launch.
 *
 * A NEW launch carries no id: agy names the conversation itself and the first
 * hook reports it (see the header). A RESUME is `--conversation <id>`.
 *
 * The prompt rides `--prompt-interactive=<text>` in the `=` form. agy parses
 * flags with Go's flag package, which takes the next argument as a flag's
 * value, but the `=` form leaves nothing to interpret: a prompt beginning with
 * `-` is still the prompt. It is last, as the contract asks.
 *
 * Not here: `sessionName` (no flag), `appendSystemPrompt` (no flag, and
 * GEMINI.md / AGENTS.md are agy's own place for standing instructions),
 * `parentId` (no fork flag).
 */
export function buildAntigravityArgs(opts: LaunchOptions): string[] {
  const args: string[] = [];
  const resume = typeof opts.resumeId === 'string' ? opts.resumeId.trim() : '';
  if (resume !== '') args.push('--conversation', resume);
  for (const dir of opts.addDirs ?? []) {
    const d = typeof dir === 'string' ? dir.trim() : '';
    if (d !== '') args.push(`--add-dir=${d}`);
  }
  const prompt = typeof opts.prompt === 'string' ? opts.prompt.trim() : '';
  if (prompt !== '') args.push(`--prompt-interactive=${prompt}`);
  return args;
}

// ---------------------------------------------------------- transcript reads

const HEAD_MAX_BYTES = 64 * 1024;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readHead(file: string, maxBytes: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (!Number.isFinite(size) || size <= 0) return '';
    const want = Math.min(size, maxBytes);
    const buf = Buffer.alloc(want);
    const read = fs.readSync(fd, buf, 0, want, 0);
    return buf.toString('utf-8', 0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/** Every parsable step in a window of a transcript. A torn line at either end
 *  of a window is ordinary and skipped. */
function stepsIn(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      const rec: unknown = JSON.parse(line);
      if (isRecord(rec)) out.push(rec);
    } catch {
      // torn line
    }
  }
  return out;
}

function stepAt(rec: Record<string, unknown>): number {
  return typeof rec['created_at'] === 'string' ? Date.parse(rec['created_at']) : Number.NaN;
}

/** A step a person typed, as opposed to one agy injected. */
function isPersonInput(rec: Record<string, unknown>): boolean {
  return rec['type'] === 'USER_INPUT' && rec['source'] === 'USER_EXPLICIT';
}

/**
 * The words inside `<USER_REQUEST>…</USER_REQUEST>`, collapsed.
 *
 * agy wraps what a person typed in that tag and appends its own blocks
 * (`<ADDITIONAL_METADATA>`, `<USER_SETTINGS_CHANGE>`) after it. Content with no
 * tag is taken whole, since that is the only honest reading of a format that
 * changed.
 */
export function antigravityRequestText(content: unknown): string {
  if (typeof content !== 'string') return '';
  const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(content);
  const body = m ? (m[1] ?? '') : content;
  return body.replace(/\s+/g, ' ').trim();
}

export function readFirstAntigravityPrompt(file: string): string | undefined {
  let text: string;
  try {
    text = readHead(file, HEAD_MAX_BYTES);
  } catch {
    return undefined;
  }
  for (const rec of stepsIn(text)) {
    if (!isPersonInput(rec)) continue;
    const body = antigravityRequestText(rec['content']);
    if (body !== '' && !body.startsWith('/')) return body;
  }
  return undefined;
}

/**
 * Age and context size from the tail. `tokens` is the last model step's
 * `input_tokens + cache_read_tokens`: the size of the context that step was
 * given, which is what a context meter shows.
 */
export function parseAntigravityTranscriptStats(text: string): TranscriptStats {
  const stats: TranscriptStats = {};
  for (const rec of stepsIn(text)) {
    const at = stepAt(rec);
    if (Number.isFinite(at)) stats.lastRecordAt = at;
    if (isPersonInput(rec)) {
      if (Number.isFinite(at)) stats.lastPromptAt = at;
      continue;
    }
    if (rec['type'] === 'PLANNER_RESPONSE' && typeof rec['input_tokens'] === 'number') {
      const cached = typeof rec['cache_read_tokens'] === 'number' ? rec['cache_read_tokens'] : 0;
      stats.tokens = rec['input_tokens'] + cached;
    }
  }
  return stats;
}

/** The opening words of Flock's own close-with-summary request
 *  (closeSummary.CODEX_SUMMARY_PROMPT), which is what the reply is found
 *  after. */
const SUMMARY_REQUEST_PREFIX = '[Flock] This session is about to be closed.';

/**
 * agy's answer to the close-with-summary request, or undefined.
 *
 * ANCHORED ON THE REQUEST, not on the clock alone. agy writes whole seconds,
 * so a time floor cannot tell the reply from the previous turn's answer when
 * the user closes within the same second that turn ended. The reply is the
 * last model step AFTER the step that carries Flock's request, and only a
 * request at or after `sinceMs` (floored to its second) counts, so an older
 * summary already in the transcript is never reported as this one.
 */
export function parseAntigravitySummaryReply(text: string, sinceMs: number): string | undefined {
  const floor = Math.floor(sinceMs / 1000) * 1000;
  const steps = stepsIn(text);
  let anchor = -1;
  for (let i = steps.length - 1; i >= 0; i--) {
    const rec = steps[i] as Record<string, unknown>;
    if (rec['type'] !== 'USER_INPUT') continue;
    if (!antigravityRequestText(rec['content']).startsWith(SUMMARY_REQUEST_PREFIX)) continue;
    const at = stepAt(rec);
    if (Number.isFinite(at) && at >= floor) anchor = i;
    break;
  }
  if (anchor < 0) return undefined;
  let reply: string | undefined;
  for (const rec of steps.slice(anchor + 1)) {
    if (rec['type'] !== 'PLANNER_RESPONSE') continue;
    const body = typeof rec['content'] === 'string' ? rec['content'].trim() : '';
    if (body !== '') reply = body;
  }
  return reply;
}

// ------------------------------------------------------------------ history

/** `{ "<abs folder>": "<id>" }`, read backwards: id → folder. Only the latest
 *  conversation per folder is in it. */
function foldersById(home: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const raw: unknown = JSON.parse(
      fs.readFileSync(path.join(antigravityCliDir(home), 'cache', 'last_conversations.json'), 'utf8'),
    );
    if (isRecord(raw)) {
      for (const [dir, id] of Object.entries(raw)) {
        if (typeof id === 'string' && typeof dir === 'string' && dir !== '') out.set(id, dir);
      }
    }
  } catch {
    // no cache yet
  }
  return out;
}

/** Conversation ids are uuids. A directory under `brain/` that is not one is
 *  not a conversation. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A conversation's first step time, re-read only when its file changed:
 *  history is rescanned on the roster cadence and a head read per
 *  conversation per scan would add up. */
const startedCache = new Map<string, { key: string; at: number | undefined }>();
function startedAtOf(file: string, stat: fs.Stats): number | undefined {
  const key = `${String(stat.mtimeMs)}:${String(stat.size)}`;
  const hit = startedCache.get(file);
  if (hit !== undefined && hit.key === key) return hit.at;
  let at: number | undefined;
  try {
    const first = stepsIn(readHead(file, 4096))[0];
    const t = first ? stepAt(first) : Number.NaN;
    at = Number.isFinite(t) ? t : undefined;
  } catch {
    at = undefined;
  }
  startedCache.set(file, { key, at });
  return at;
}

export function listAntigravityHistory(home: string): ArchivedSession[] {
  const brain = antigravityBrainDir(home);
  let ids: string[];
  try {
    ids = fs.readdirSync(brain).filter((d) => UUID_RE.test(d));
  } catch {
    return [];
  }
  const folders = foldersById(home);
  const out: ArchivedSession[] = [];
  for (const id of ids) {
    const file = antigravityTranscriptPath(home, id);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue; // a conversation that never wrote a step
    }
    const session: ArchivedSession = {
      sessionId: id,
      transcriptPath: file,
      endedAt: stat.mtimeMs,
      bytes: stat.size,
    };
    const started = startedAtOf(file, stat);
    if (started !== undefined) session.startedAt = started;
    const cwd = folders.get(id);
    if (cwd !== undefined) session.cwd = cwd;
    out.push(session);
  }
  return out;
}

// ------------------------------------------------------------------- status

/**
 * Is this an event from the CLI, rather than from the desktop app or the IDE?
 * The plugin folder is shared by all three; the transcript path says which
 * one wrote it. An event with no path says nothing either way and is kept.
 */
export function isCliEvent(e: HookEvent): boolean {
  const tp = e.transcriptPath;
  if (typeof tp !== 'string' || tp === '') return true;
  return tp.replace(/\\/g, '/').includes('/antigravity-cli/');
}

function payloadOf(e: HookEvent): Record<string, unknown> {
  const raw = isRecord(e.raw) ? e.raw : {};
  return isRecord(raw['payload']) ? raw['payload'] : raw;
}

export function antigravityStatusOf(
  e: HookEvent,
): { status: SessionStatus; at: number } | undefined {
  if (!isCliEvent(e)) return undefined;
  const at = Date.now();
  switch (e.event) {
    case 'PreInvocation':
      return { status: 'busy', at };
    case 'Stop':
      // `fullyIdle: false` is a stop with work still pending (a subagent, a
      // background task): not available yet.
      return { status: payloadOf(e)['fullyIdle'] === true ? 'idle' : 'busy', at };
    default:
      // SessionStart fires before the trust prompt; see the header.
      return undefined;
  }
}

/** The transcript for one conversation, or null when it has none (a launch
 *  agy never used, or an id that is not a conversation id). */
export function antigravityTranscriptOf(id: string, home?: string): string | null {
  if (!UUID_RE.test(id)) return null;
  return fileAt(antigravityTranscriptPath(home, id));
}

/** Age and context size from a transcript's tail. Never throws. */
export function readAntigravityStats(file: string): TranscriptStats {
  try {
    return parseAntigravityTranscriptStats(readTranscriptTail(file, TAIL_MAX_BYTES));
  } catch {
    return {};
  }
}

// ------------------------------------------------------- the id agy names

/**
 * What one Antigravity hook event means for the row Flock launched: nothing,
 * an ADOPTION, or a FORK. Pure; extension.ts (`adoptAntigravityId`) acts on it.
 *
 *   nodeId    the LINEAGE_NODE_ID the event carried: the id Flock bound the
 *             tab under at launch.
 *   current   the id the tab is on now (after an earlier adoption or fork),
 *             else `nodeId`.
 *   realId    the conversation the event is about.
 *   currentHasTranscript  whether `current` is a conversation agy wrote.
 *
 * A launch id agy never used has no transcript, so a new id on it is the same
 * session getting its real name: ADOPT (chain edge, the row moves). A tab that
 * already showed a real conversation and now shows another forked inside agy
 * (`/fork`): FORK (parent edge, no chain; the old row keeps its transcript).
 */
export type AntigravityIdPlan =
  | { kind: 'none' }
  | { kind: 'adopt'; from: string; to: string }
  | { kind: 'fork'; parent: string; child: string };

export function planAntigravityId(input: {
  /** The provider on the record for `nodeId`. Anything but antigravity is not
   *  ours to move. */
  launchProvider: string | undefined;
  nodeId: string;
  current: string;
  realId: string;
  currentHasTranscript: boolean;
}): AntigravityIdPlan {
  if (input.launchProvider !== 'gemini') return { kind: 'none' };
  if (input.realId === input.current || input.realId === input.nodeId) return { kind: 'none' };
  if (input.currentHasTranscript) {
    return { kind: 'fork', parent: input.current, child: input.realId };
  }
  return { kind: 'adopt', from: input.current, to: input.realId };
}
