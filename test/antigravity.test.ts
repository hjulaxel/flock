// test/antigravity.test.ts — the Antigravity CLI (`agy`): its argv, its
// transcripts, what its hook events mean, how the id it names itself is
// adopted, and the seams in the core that now know it exists. Every record
// shape here was observed on agy 1.3.4 (see src/antigravity.ts).

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  antigravityRequestText,
  antigravityStatusOf,
  antigravityTranscriptOf,
  antigravityTranscriptPath,
  buildAntigravityArgs,
  findAntigravityBinary,
  isCliEvent,
  listAntigravityHistory,
  parseAntigravitySummaryReply,
  parseAntigravityTranscriptStats,
  planAntigravityId,
  readFirstAntigravityPrompt,
} from '../src/antigravity';
import {
  CONFIG_DIR_ENV,
  SESSION_PROVIDERS,
  canHostSession,
  cliOfProfile,
  cliOfProvider,
  envForProfile,
  pickedByAuto,
  seedDefaultProfiles,
} from '../src/accounts';
import { resolveRouting } from '../src/routing';
import { CODEX_HOOK_COMMAND, parseEventLine } from '../src/hooks';
import { CODEX_SUMMARY_PROMPT } from '../src/closeSummary';
import { mayTypeInto } from '../src/roster';
import { defaultTerminalName, launchCliOf } from '../src/terminals';
import { PROVIDERS } from '../src/types';
import type { AccountProfile, HookEvent, UsageSnapshot } from '../src/types';

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});
function tmpHome(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-agy-'));
  homes.push(h);
  return h;
}

const CONV = '2c0655f7-0ff5-49d4-9ac5-1997e51f83db';
const FORK = 'dd819731-f8a3-467a-9cff-163532f2b800';
const LAUNCH = '11111111-2222-4333-8444-555555555555';
const CLI_TRANSCRIPT = `/Users/x/.gemini/antigravity-cli/brain/${CONV}/.system_generated/logs/transcript_full.jsonl`;

/** One step line, in the shape agy writes. */
function step(i: number, at: string, type: string, extra: Record<string, unknown>): string {
  const source = type === 'USER_INPUT' ? 'USER_EXPLICIT' : 'MODEL';
  return JSON.stringify({ step_index: i, source, type, status: 'DONE', created_at: at, ...extra });
}
function request(text: string): string {
  return `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: x.\n</ADDITIONAL_METADATA>`;
}

/** A home with ~/.gemini/antigravity-cli laid out as agy does. */
function agyHome(): string {
  const home = tmpHome();
  const write = (id: string, lines: string[]): void => {
    const file = antigravityTranscriptPath(home, id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join('\n') + '\n');
  };
  write(CONV, [
    step(0, '2026-10-13T20:05:00Z', 'USER_INPUT', { content: request('/model') }),
    step(1, '2026-10-13T20:05:43Z', 'USER_INPUT', { content: request('Explain   the roster\n poller') }),
    step(2, '2026-10-13T20:05:50Z', 'PLANNER_RESPONSE', {
      input_tokens: 11000, cache_read_tokens: 0, output_tokens: 40, content: 'It polls.',
    }),
    step(3, '2026-10-13T20:06:00Z', 'USER_INPUT', { content: request('And then?') }),
    step(4, '2026-10-13T20:06:09Z', 'PLANNER_RESPONSE', {
      input_tokens: 12000, cache_read_tokens: 500, output_tokens: 30, content: 'It merges.',
    }),
  ]);
  write(FORK, [step(0, '2026-10-12T09:00:00Z', 'USER_INPUT', { content: request('Hello') })]);
  // A conversation that never wrote a step, and something that is not one.
  fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli', 'brain', LAUNCH), { recursive: true });
  fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli', 'brain', 'scratch'), { recursive: true });
  const cache = path.join(home, '.gemini', 'antigravity-cli', 'cache');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'last_conversations.json'), JSON.stringify({ '/code/api': CONV }));
  return home;
}

/** A line exactly as the plugin's command writes it, parsed by the core. */
function agyEvent(event: string, payload: Record<string, unknown>, nodeId = ''): HookEvent {
  const e = parseEventLine(JSON.stringify({ lineage_node_id: nodeId, cli: 'antigravity', event, payload }));
  if (e === null) throw new Error('did not parse');
  return e;
}

function profile(id: string, p: Partial<AccountProfile>): AccountProfile {
  return { id, provider: 'claude', label: id, ...p } as AccountProfile;
}

describe('agy argv', () => {
  it('starts a new conversation with no id: agy names it, the first hook reports it', () => {
    const args = buildAntigravityArgs({
      sessionId: LAUNCH,
      cwd: '/code/api',
      addDirs: ['/code/shared'],
      sessionName: 'the roster round',
      appendSystemPrompt: 'You are in Flock.',
      prompt: 'Explain the roster poller',
    });
    expect(args).toEqual(['--add-dir=/code/shared', '--prompt-interactive=Explain the roster poller']);
    // No id, no name, no system prompt: agy has no flag for any of them.
    expect(args.join(' ')).not.toContain(LAUNCH);
    expect(args.join(' ')).not.toContain('the roster round');
    expect(args.join(' ')).not.toContain('You are in Flock.');
  });

  it('reopens with --conversation', () => {
    expect(buildAntigravityArgs({ sessionId: CONV, resumeId: CONV, cwd: '/code' })).toEqual([
      '--conversation',
      CONV,
    ]);
  });

  it('keeps a prompt that starts with a dash as the prompt', () => {
    expect(buildAntigravityArgs({ sessionId: LAUNCH, cwd: '/c', prompt: '-v please' })).toEqual([
      '--prompt-interactive=-v please',
    ]);
  });
});

describe('finding agy', () => {
  it('falls back to ~/.local/bin, where its installer puts it', () => {
    const home = tmpHome();
    const bin = path.join(home, '.local', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'agy'), '#!/bin/sh\n');
    expect(findAntigravityBinary(undefined, { home, env: { PATH: '' }, platform: 'darwin' })).toBe(
      path.join(bin, 'agy'),
    );
  });

  it('returns a configured path verbatim, and null when there is none', () => {
    expect(findAntigravityBinary('/opt/agy', { env: { PATH: '' } })).toBe('/opt/agy');
    const home = tmpHome();
    expect(findAntigravityBinary(undefined, { home, env: { PATH: '' }, platform: 'darwin' })).toBeNull();
  });
});

describe('the launcher', () => {
  it('runs agy for an Antigravity launch, with its own argv, tab and not-found sentence', () => {
    const cli = launchCliOf('antigravity');
    expect(cli.cli).toBe('antigravity');
    expect(cli.missing).toContain('lineage.antigravityBinary');
    expect(cli.args({ sessionId: CONV, resumeId: CONV, cwd: '/c' })).toEqual(['--conversation', CONV]);
    expect(defaultTerminalName(CONV, 'antigravity')).toBe(`agy · ${CONV.slice(0, 8)}`);
  });

  it('keeps Claude and Codex exactly as they were', () => {
    expect(launchCliOf(undefined).cli).toBe('claude');
    expect(launchCliOf('generic').cli).toBe('claude');
    expect(launchCliOf('codex').cli).toBe('codex');
    expect(defaultTerminalName(CONV, 'codex')).toBe(`codex · ${CONV.slice(0, 8)}`);
    expect(defaultTerminalName(CONV)).toBe(`claude · ${CONV.slice(0, 8)}`);
  });
});

describe('agy hook events', () => {
  it('parse: the event name comes from the wrapper, the id from conversationId', () => {
    const e = agyEvent('Stop', { conversationId: CONV, transcriptPath: CLI_TRANSCRIPT, fullyIdle: true }, LAUNCH);
    expect(e).toMatchObject({ event: 'Stop', cli: 'antigravity', sessionId: CONV, nodeId: LAUNCH });
    expect(e.transcriptPath).toBe(CLI_TRANSCRIPT);
  });

  it('leaves Claude and Codex lines parsed exactly as before', () => {
    const claude = parseEventLine(
      JSON.stringify({ lineage_node_id: '', payload: { hook_event_name: 'Stop', session_id: CONV } }),
    );
    expect(claude).toMatchObject({ event: 'Stop', cli: 'claude', sessionId: CONV });
    const codex = parseEventLine(
      JSON.stringify({ lineage_node_id: '', cli: 'codex', payload: { hook_event_name: 'Stop', session_id: CONV } }),
    );
    expect(codex?.cli).toBe('codex');
    expect(CODEX_HOOK_COMMAND).toContain('\\"cli\\":\\"codex\\"');
  });

  it('PreInvocation is busy; Stop fully idle is idle; Stop with work left is busy', () => {
    const base = { conversationId: CONV, transcriptPath: CLI_TRANSCRIPT };
    expect(antigravityStatusOf(agyEvent('PreInvocation', base))?.status).toBe('busy');
    expect(antigravityStatusOf(agyEvent('Stop', { ...base, fullyIdle: true }))?.status).toBe('idle');
    expect(antigravityStatusOf(agyEvent('Stop', { ...base, fullyIdle: false }))?.status).toBe('busy');
  });

  it('SessionStart says nothing about status: it fires before the trust prompt', () => {
    expect(antigravityStatusOf(agyEvent('SessionStart', { conversationId: CONV, transcriptPath: CLI_TRANSCRIPT }))).toBeUndefined();
  });

  it('ignores the Antigravity desktop app, which reads the same plugin folder', () => {
    const app = agyEvent('Stop', {
      conversationId: CONV,
      transcriptPath: `/Users/x/.gemini/antigravity/brain/${CONV}/t.jsonl`,
      fullyIdle: true,
    });
    expect(isCliEvent(app)).toBe(false);
    expect(antigravityStatusOf(app)).toBeUndefined();
  });

  it('never throws on a payload that is not what it should be', () => {
    const e = parseEventLine('{"lineage_node_id":"","cli":"antigravity","event":"Stop","payload":null}');
    expect(() => antigravityStatusOf(e as HookEvent)).not.toThrow();
  });
});

describe('the id agy names itself', () => {
  const base = { launchProvider: 'antigravity' };

  it('adopts the real id for a fresh launch, whose id agy never used', () => {
    expect(planAntigravityId({ ...base, nodeId: LAUNCH, current: LAUNCH, realId: CONV, currentHasTranscript: false })).toEqual({
      kind: 'adopt', from: LAUNCH, to: CONV,
    });
  });

  it('does nothing once the tab is on that id', () => {
    expect(planAntigravityId({ ...base, nodeId: LAUNCH, current: CONV, realId: CONV, currentHasTranscript: true })).toEqual({ kind: 'none' });
  });

  it('a new id after the tab showed a real conversation is a FORK, not a re-key', () => {
    expect(planAntigravityId({ ...base, nodeId: LAUNCH, current: CONV, realId: FORK, currentHasTranscript: true })).toEqual({
      kind: 'fork', parent: CONV, child: FORK,
    });
  });

  it('a resume keeps its id, and a fork from it is a child of it', () => {
    expect(planAntigravityId({ ...base, nodeId: CONV, current: CONV, realId: CONV, currentHasTranscript: true })).toEqual({ kind: 'none' });
    expect(planAntigravityId({ ...base, nodeId: CONV, current: CONV, realId: FORK, currentHasTranscript: true })).toEqual({
      kind: 'fork', parent: CONV, child: FORK,
    });
  });

  it("never moves a launch that was not Antigravity's", () => {
    for (const launchProvider of ['claude', 'codex', undefined]) {
      expect(
        planAntigravityId({ launchProvider, nodeId: LAUNCH, current: LAUNCH, realId: CONV, currentHasTranscript: false }),
      ).toEqual({ kind: 'none' });
    }
  });
});

describe('the keystroke guard', () => {
  const target = { row: true, rosterOk: true, provider: 'antigravity' as const };

  it('types only into a fully idle row with the hooks installed', () => {
    expect(mayTypeInto({ ...target, status: 'idle', promptsVisible: true })).toBe('ok');
  });

  it('refuses anything else: a busy row may be showing a permission prompt', () => {
    expect(mayTypeInto({ ...target, status: 'busy', promptsVisible: true })).toBe('blind');
    expect(mayTypeInto({ ...target, status: 'unknown', promptsVisible: true })).toBe('blind');
    expect(mayTypeInto({ ...target, status: 'idle', promptsVisible: false })).toBe('blind');
  });

  it('is unchanged for Claude and Codex', () => {
    expect(mayTypeInto({ status: 'busy', row: true, rosterOk: true })).toBe('ok');
    expect(mayTypeInto({ status: 'idle', row: true, rosterOk: true, provider: 'codex', promptsVisible: false })).toBe('blind');
    expect(mayTypeInto({ status: 'idle', row: true, rosterOk: true, provider: 'codex', promptsVisible: true })).toBe('ok');
  });
});

describe('agy transcripts', () => {
  it('reads what is inside <USER_REQUEST>, not what agy appends', () => {
    expect(antigravityRequestText(request('hi  there'))).toBe('hi there');
  });

  it('reads the first thing a person typed, skipping a slash command', () => {
    const home = agyHome();
    expect(readFirstAntigravityPrompt(antigravityTranscriptPath(home, CONV))).toBe('Explain the roster poller');
    expect(readFirstAntigravityPrompt(path.join(home, 'missing.jsonl'))).toBeUndefined();
  });

  it('reads the age and the context size from the tail', () => {
    const home = agyHome();
    const stats = parseAntigravityTranscriptStats(fs.readFileSync(antigravityTranscriptPath(home, CONV), 'utf8'));
    expect(stats.tokens).toBe(12500);
    expect(stats.lastPromptAt).toBe(Date.parse('2026-10-13T20:06:00Z'));
    expect(stats.lastRecordAt).toBe(Date.parse('2026-10-13T20:06:09Z'));
  });

  it('lists conversations with a transcript, with a folder only where agy recorded one', () => {
    const home = agyHome();
    const byId = new Map(listAntigravityHistory(home).map((s) => [s.sessionId, s]));
    expect([...byId.keys()].sort()).toEqual([CONV, FORK].sort());
    expect(byId.get(CONV)?.cwd).toBe('/code/api');
    expect(byId.get(FORK)?.cwd).toBeUndefined();
    expect(byId.get(CONV)?.startedAt).toBe(Date.parse('2026-10-13T20:05:00Z'));
  });

  it('answers nothing for a home without agy', () => {
    expect(listAntigravityHistory(tmpHome())).toEqual([]);
  });

  it('finds a transcript by id, and nothing for an id that is not a conversation', () => {
    const home = agyHome();
    expect(antigravityTranscriptOf(CONV, home)).toBe(antigravityTranscriptPath(home, CONV));
    expect(antigravityTranscriptOf(LAUNCH, home)).toBeNull();
    expect(antigravityTranscriptOf('../etc', home)).toBeNull();
  });

  it('reads the reply to Flock\'s summary request, never the turn before it', () => {
    const at = '2026-10-13T20:06:09Z';
    const sent = Date.parse(at) + 700; // the same second the previous turn ended
    const lines = [
      step(0, at, 'USER_INPUT', { content: request('And then?') }),
      step(1, at, 'PLANNER_RESPONSE', { content: 'It merges.' }),
    ];
    // Asked, not yet answered: the previous turn's reply is not the summary.
    const asked = [...lines, step(2, at, 'USER_INPUT', { content: request(CODEX_SUMMARY_PROMPT) })];
    expect(parseAntigravitySummaryReply(asked.join('\n'), sent)).toBeUndefined();
    const answered = [...asked, step(3, at, 'PLANNER_RESPONSE', { content: 'Done: the roster merges.' })];
    expect(parseAntigravitySummaryReply(answered.join('\n'), sent)).toBe('Done: the roster merges.');
    // A request from an earlier close does not count for this one.
    expect(parseAntigravitySummaryReply(answered.join('\n'), sent + 5000)).toBeUndefined();
  });
});

describe('Antigravity accounts', () => {
  it('can host a session, claims no isolation, and is its own CLI', () => {
    const agy = profile('a', { provider: 'antigravity', configDir: '/would/be/wrong' });
    expect(SESSION_PROVIDERS).toContain('antigravity');
    expect(canHostSession(agy)).toBe(true);
    expect(CONFIG_DIR_ENV.antigravity).toBeUndefined();
    expect(envForProfile(agy)).toEqual({});
    expect(cliOfProfile(agy)).toBe('antigravity');
  });

  it('cliOfProvider: generic is Claude, every other provider is itself', () => {
    expect(cliOfProvider('generic')).toBe('claude');
    expect(cliOfProvider('claude')).toBe('claude');
    expect(cliOfProvider('codex')).toBe('codex');
    expect(cliOfProvider('antigravity')).toBe('antigravity');
  });

  it('is seeded when agy is on the machine, and not otherwise', () => {
    const none = seedDefaultProfiles([], { hasCodexAuth: false, now: 0 });
    expect(none.map((p) => p.provider)).toEqual(['claude']);
    const withAgy = seedDefaultProfiles([], { hasCodexAuth: false, hasAntigravityBinary: true, now: 0 });
    expect(withAgy.map((p) => p.provider)).toEqual(['claude', 'antigravity']);
  });

  it('wears the Gemini mark, which Flock already bundles', () => {
    expect(PROVIDERS.antigravity.iconFile).toBe('gemini.svg');
    expect(fs.existsSync(path.join(__dirname, '..', 'media', 'providers', 'gemini.svg'))).toBe(true);
  });
});

describe('Auto never routes new work onto Antigravity', () => {
  // Auto ranks accounts by their usage windows, and an account with no meter
  // reads as the best kind. agy has no meter, so without this rule every Auto
  // launch on a machine with agy installed would go to Gemini.
  const claudeFull = profile('c', { provider: 'claude', order: 0 } as Partial<AccountProfile>);
  const agy = profile('g', { provider: 'antigravity', order: 1 } as Partial<AccountProfile>);
  const NOW = Date.parse('2026-10-13T12:00:00Z');
  const usage = new Map([
    ['c', { fiveHour: { utilization: 100, resetsAt: NOW + 3_600_000 } } as unknown as UsageSnapshot],
  ]);

  it('passes over an Antigravity account on Auto, even when every Claude window is full', () => {
    expect(resolveRouting(undefined, undefined, [claudeFull, agy], usage, NOW).profile?.id).toBe('c');
    expect(resolveRouting({ kind: 'auto' }, undefined, [agy, claudeFull], usage, NOW).profile?.id).toBe('c');
  });

  it('uses it when it is chosen: the account, or its provider', () => {
    expect(resolveRouting({ kind: 'account', id: 'g' }, undefined, [claudeFull, agy], usage, NOW).profile?.id).toBe('g');
    expect(resolveRouting({ kind: 'provider', provider: 'antigravity' }, undefined, [claudeFull, agy], usage, NOW).profile?.id).toBe('g');
  });

  it('is the answer only when it is the only account there is', () => {
    expect(resolveRouting(undefined, undefined, [agy], new Map(), NOW).profile?.id).toBe('g');
  });

  it('pickedByAuto says so in one place', () => {
    expect(pickedByAuto(agy)).toBe(false);
    expect(pickedByAuto(claudeFull)).toBe(true);
    expect(pickedByAuto(profile('x', { provider: 'codex' }))).toBe(true);
  });
});
