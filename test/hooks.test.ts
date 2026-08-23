// test/hooks.test.ts — the hook plugin Flock writes into the user's
// ~/.claude, and the filesystem-side behaviour that must degrade rather than
// break: the safety-gated remove, activate-time self-heal, and the incremental
// events tail.
//
// Nothing here touches the real $HOME (every manager gets a mkdtemp home) and
// nothing here needs a vscode host: the module's UI calls are optional shims,
// so against the mock's empty `window` they are silent no-ops.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as process from 'node:process';
import * as vscodeMock from 'vscode';

import {
  HOOK_COMMAND,
  HooksManager,
  PLUGIN_NAME,
  PLUGIN_VERSION,
  eventsFile,
  parseEventLine,
  pluginDir,
  renderHooksJson,
  renderPluginJson,
} from '../src/hooks';
import type { HookEvent, HookInstallState } from '../src/types';

const SID = '0f0000a1-0000-4000-8000-0000000000a1';

const temps: string[] = [];
const managers: HooksManager[] = [];

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-hooks-'));
  temps.push(dir);
  return dir;
}

function makeManager(home: string, initial: HookInstallState = { installed: false }) {
  let stored: HookInstallState = initial;
  const manager = new HooksManager(
    {
      getStored: () => stored,
      setStored: async (s) => {
        stored = s;
      },
    },
    home,
  );
  managers.push(manager);
  return { manager, stored: () => stored };
}

/** Write the plugin exactly as install() would, without the consent UI. */
function writePlugin(home: string, manifest = renderPluginJson(), hooks = renderHooksJson()): void {
  const dir = pluginDir(home);
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), manifest);
  fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), hooks);
}

async function until(
  predicate: () => boolean,
  timeoutMs = 8000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

// ------------------------------------------------------- consent-modal shim
// The vscode mock exports `window = {}`, so hooks.ts's optional message shims
// are silent no-ops by default — which left install() with no coverage at all.
// Hanging a stub off that same object lets the consent modal be answered
// without registering anything with a workbench. Torn down after every test.

interface MessageStub {
  showInformationMessage?: (
    message: string,
    options: unknown,
    ...items: string[]
  ) => Promise<string | undefined>;
  showWarningMessage?: (
    message: string,
    options: unknown,
    ...items: string[]
  ) => Promise<string | undefined>;
}

const messageApi = vscodeMock.window as unknown as MessageStub;

interface Prompt {
  message: string;
  items: string[];
  modal: boolean;
}

/** Answers the consent modal with `answer` and records every message shown. */
function stubConsent(answer: string | undefined): Prompt[] {
  const prompts: Prompt[] = [];
  const record = (message: string, options: unknown, items: string[]): void => {
    const modal =
      typeof options === 'object' &&
      options !== null &&
      (options as { modal?: unknown }).modal === true;
    prompts.push({ message, items, modal });
  };
  messageApi.showInformationMessage = async (message, options, ...items) => {
    record(message, options, items);
    return items.includes('Install') ? answer : undefined;
  };
  messageApi.showWarningMessage = async (message, options, ...items) => {
    record(message, options, items);
    return undefined;
  };
  return prompts;
}

/** Prompts that actually asked the user to decide something. */
function decisions(prompts: Prompt[]): Prompt[] {
  return prompts.filter((p) => p.items.length > 0);
}

afterEach(() => {
  delete messageApi.showInformationMessage;
  delete messageApi.showWarningMessage;
  while (managers.length) managers.pop()?.dispose();
  while (temps.length) {
    const dir = temps.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('hooks: generated plugin files', () => {
  it('renders exactly the six events, each running HOOK_COMMAND', () => {
    const parsed = JSON.parse(renderHooksJson()) as {
      hooks: Record<string, Array<{ hooks: Array<Record<string, string>> }>>;
    };
    expect(Object.keys(parsed.hooks).sort()).toEqual(
      [
        'Notification',
        // v4. The only signal that a compaction has STARTED — the roster says
        // `busy` and the transcript's compact_boundary record does not exist
        // until it is over. See src/compaction.ts.
        'PreCompact',
        'SessionEnd',
        'SessionStart',
        'Stop',
        'UserPromptSubmit',
      ].sort(),
    );
    for (const matchers of Object.values(parsed.hooks)) {
      expect(matchers).toHaveLength(1);
      // matcher-less: the entry carries only `hooks`
      expect(Object.keys(matchers[0]!)).toEqual(['hooks']);
      expect(matchers[0]!.hooks).toHaveLength(1);
      expect(matchers[0]!.hooks[0]!.type).toBe('command');
      expect(matchers[0]!.hooks[0]!.command).toBe(HOOK_COMMAND);
    }
  });

  it('keeps the hook command PATH-resolved and $HOME-relative', () => {
    // Version-proofing: never an extension install path.
    expect(HOOK_COMMAND).toContain('$HOME/.lineage/events.ndjson');
    expect(HOOK_COMMAND).not.toMatch(/extensions?[/\\]/i);
  });

  it('v3: the command logs the inherited LINEAGE_NODE_ID envelope', () => {
    expect(HOOK_COMMAND).toContain('${LINEAGE_NODE_ID:-}');
    expect(HOOK_COMMAND).toContain('lineage_node_id');
    // Empty stdin must still produce parseable JSON (payload:null).
    expect(HOOK_COMMAND).toContain('p=null');
    // Still exactly one appending redirection — the single-write rule.
    expect(HOOK_COMMAND.split('>>').length).toBe(2);
  });

  it('renders a parseable plugin manifest named lineage-events', () => {
    const parsed = JSON.parse(renderPluginJson()) as Record<string, unknown>;
    expect(parsed.name).toBe(PLUGIN_NAME);
    expect(typeof parsed.version).toBe('string');
    expect(typeof parsed.description).toBe('string');
  });
});

describe('hooks: path shapes', () => {
  it('places the plugin under ~/.claude/skills and events under ~/.lineage', () => {
    expect(pluginDir('/tmp/h')).toBe('/tmp/h/.claude/skills/lineage-events');
    expect(eventsFile('/tmp/h')).toBe('/tmp/h/.lineage/events.ndjson');
  });
});

describe('hooks: parseEventLine', () => {
  it('maps the three payload fields and keeps the raw record', () => {
    const line = JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: SID,
      transcript_path: '/tmp/t.jsonl',
      extra: 1,
    });
    const event = parseEventLine(line);
    expect(event).not.toBeNull();
    expect(event!.event).toBe('SessionStart');
    expect(event!.sessionId).toBe(SID);
    expect(event!.transcriptPath).toBe('/tmp/t.jsonl');
    expect((event!.raw as Record<string, unknown>).extra).toBe(1);
  });

  it('nulls individual fields that are absent or malformed', () => {
    const event = parseEventLine(
      JSON.stringify({ session_id: 'not-a-uuid', transcript_path: 42 }),
    );
    expect(event).not.toBeNull();
    expect(event!.event).toBeNull();
    expect(event!.sessionId).toBeNull();
    expect(event!.transcriptPath).toBeNull();
  });

  it('rejects non-objects outright', () => {
    expect(parseEventLine('nope')).toBeNull();
    expect(parseEventLine('')).toBeNull();
    expect(parseEventLine('7')).toBeNull();
    expect(parseEventLine('"s"')).toBeNull();
    expect(parseEventLine('null')).toBeNull();
    expect(parseEventLine('[{"session_id":"x"}]')).toBeNull();
  });

  it('flat v2 lines parse with a null nodeId', () => {
    const event = parseEventLine(
      JSON.stringify({ hook_event_name: 'Stop', session_id: SID }),
    );
    expect(event).not.toBeNull();
    expect(event!.nodeId).toBeNull();
    expect(event!.sessionId).toBe(SID);
  });

  it('v3: unwraps the lineage_node_id envelope', () => {
    const NODE = '0e000000-0000-4000-8000-00000000000e';
    const event = parseEventLine(
      JSON.stringify({
        lineage_node_id: NODE,
        payload: {
          hook_event_name: 'UserPromptSubmit',
          session_id: SID,
          transcript_path: '/tmp/t.jsonl',
        },
      }),
    );
    expect(event).not.toBeNull();
    expect(event!.nodeId).toBe(NODE);
    expect(event!.event).toBe('UserPromptSubmit');
    expect(event!.sessionId).toBe(SID);
    expect(event!.transcriptPath).toBe('/tmp/t.jsonl');
  });

  it('v3: tolerates a blank node id and a null payload (empty stdin)', () => {
    const event = parseEventLine(
      JSON.stringify({ lineage_node_id: '', payload: null }),
    );
    expect(event).not.toBeNull();
    expect(event!.nodeId).toBeNull();
    expect(event!.event).toBeNull();
    expect(event!.sessionId).toBeNull();
  });

  it('surfaces SessionStart source so a fork is never chained', () => {
    const NODE = '0e000000-0000-4000-8000-00000000000e';
    const forked = parseEventLine(
      JSON.stringify({
        lineage_node_id: NODE,
        payload: {
          hook_event_name: 'SessionStart',
          session_id: SID,
          source: 'fork',
        },
      }),
    );
    expect(forked!.source).toBe('fork');
    expect(forked!.nodeId).toBe(NODE);

    const resumed = parseEventLine(
      JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: SID,
        source: 'resume',
      }),
    );
    expect(resumed!.source).toBe('resume');

    const none = parseEventLine(
      JSON.stringify({ hook_event_name: 'Stop', session_id: SID }),
    );
    expect(none!.source).toBeNull();

    const malformed = parseEventLine(
      JSON.stringify({ hook_event_name: 'SessionStart', source: 42 }),
    );
    expect(malformed!.source).toBeNull();
  });
});

// install() is POSIX-only by design (the hook command is /bin/sh).
const posix = process.platform === 'win32' ? it.skip : it;

describe('hooks: install writes the plugin after exactly one confirmation', () => {
  const manifestOf = (home: string): string =>
    path.join(pluginDir(home), '.claude-plugin', 'plugin.json');
  const hooksOf = (home: string): string =>
    path.join(pluginDir(home), 'hooks', 'hooks.json');

  posix('writes both files as soon as the modal is accepted', async () => {
    const home = tempHome();
    const prompts = stubConsent('Install');
    const { manager, stored } = makeManager(home);

    const state = await manager.install();

    // REGRESSION. The write must land the moment install()
    // resolves. Routing it through a WorkspaceEdit with needsConfirmation used
    // to raise VS Code's bulk-edit "Refactor Preview" as a SECOND consent step
    // after this modal, and dismissing that preview silently wrote nothing.
    expect(fs.readFileSync(manifestOf(home), 'utf8')).toBe(renderPluginJson());
    expect(fs.readFileSync(hooksOf(home), 'utf8')).toBe(renderHooksJson());
    expect(state.installed).toBe(true);
    expect(state.pluginDir).toBe(pluginDir(home));
    expect(state.pluginVersion).toBe(PLUGIN_VERSION);
    expect(stored()).toEqual(state);
    expect(manager.isInstalled()).toBe(true);

    // Exactly one decision was asked of the user, and it was modal.
    const asked = decisions(prompts);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.items).toEqual(['Install']);
    expect(asked[0]!.modal).toBe(true);
  });

  posix('creates the events directory so the watcher has something to watch', async () => {
    const home = tempHome();
    stubConsent('Install');
    const { manager } = makeManager(home);
    await manager.install();
    expect(fs.existsSync(path.dirname(eventsFile(home)))).toBe(true);
  });

  posix('never touches ~/.claude/settings.json', async () => {
    const home = tempHome();
    const settings = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, '{"untouched":true}');
    stubConsent('Install');
    const { manager } = makeManager(home);

    await manager.install();
    expect(fs.readFileSync(settings, 'utf8')).toBe('{"untouched":true}');
  });

  posix('writes nothing when the modal is dismissed', async () => {
    const home = tempHome();
    stubConsent(undefined);
    const { manager, stored } = makeManager(home);

    const state = await manager.install();
    expect(state.installed).toBe(false);
    expect(stored().installed).toBe(false);
    expect(fs.existsSync(pluginDir(home))).toBe(false);
  });

  posix('is idempotent — a second install asks nothing and rewrites nothing', async () => {
    const home = tempHome();
    stubConsent('Install');
    const { manager } = makeManager(home);
    await manager.install();
    const before = fs.statSync(hooksOf(home)).mtimeMs;

    const prompts = stubConsent('Install');
    const state = await manager.install();

    expect(decisions(prompts)).toHaveLength(0);
    expect(state.installed).toBe(true);
    expect(fs.statSync(hooksOf(home)).mtimeMs).toBe(before);
  });

  posix('repairs a half-written install, rewriting only the drifted file', async () => {
    const home = tempHome();
    writePlugin(home, renderPluginJson(), '{"hooks":{}}');
    const manifestBefore = fs.statSync(manifestOf(home)).mtimeMs;
    stubConsent('Install');
    const { manager } = makeManager(home);

    const state = await manager.install();
    expect(fs.readFileSync(hooksOf(home), 'utf8')).toBe(renderHooksJson());
    expect(fs.statSync(manifestOf(home)).mtimeMs).toBe(manifestBefore);
    expect(state.installed).toBe(true);
  });

  posix('reports rather than claims success when the write cannot verify', async () => {
    const home = tempHome();
    // A file where the plugin directory needs to be: every write below it
    // fails with ENOTDIR.
    fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
    fs.writeFileSync(pluginDir(home), 'in the way');
    const prompts = stubConsent('Install');
    const { manager, stored } = makeManager(home);

    const state = await manager.install();
    expect(state.installed).toBe(false);
    expect(stored().installed).toBe(false);
    expect(prompts.some((p) => p.items.length === 0)).toBe(true); // warned
  });
});

describe('hooks: remove is safety-gated and idempotent', () => {
  it('removes only a directory whose manifest is ours', async () => {
    const home = tempHome();
    writePlugin(home);
    const { manager, stored } = makeManager(home, {
      installed: true,
      pluginDir: pluginDir(home),
      pluginVersion: PLUGIN_VERSION,
    });
    expect(manager.isInstalled()).toBe(true);

    const state = await manager.remove();
    expect(state.installed).toBe(false);
    expect(stored().installed).toBe(false);
    expect(fs.existsSync(pluginDir(home))).toBe(false);
  });

  it('refuses to delete a foreign directory at our path', async () => {
    const home = tempHome();
    writePlugin(home, JSON.stringify({ name: 'someone-elses-plugin' }));
    const { manager } = makeManager(home, { installed: true });

    const state = await manager.remove();
    expect(state.installed).toBe(true); // stored state left untouched
    expect(fs.existsSync(pluginDir(home))).toBe(true);
  });

  it('refuses when the manifest does not parse', async () => {
    const home = tempHome();
    writePlugin(home, '{ not json');
    const { manager } = makeManager(home, { installed: true });

    await manager.remove();
    expect(fs.existsSync(pluginDir(home))).toBe(true);
  });

  it('is a no-op when nothing is installed', async () => {
    const home = tempHome();
    const { manager } = makeManager(home, { installed: true });
    const state = await manager.remove();
    expect(state.installed).toBe(false);
  });

  it('keeps the events file', async () => {
    const home = tempHome();
    writePlugin(home);
    fs.mkdirSync(path.dirname(eventsFile(home)), { recursive: true });
    fs.writeFileSync(eventsFile(home), '{}\n');
    const { manager } = makeManager(home, { installed: true });

    await manager.remove();
    expect(fs.existsSync(eventsFile(home))).toBe(true);
  });
});

describe('hooks: activate-time self-heal', () => {
  it('does nothing when hooks were never installed', async () => {
    const home = tempHome();
    const { manager } = makeManager(home);
    const state = await manager.selfHeal();
    expect(state.installed).toBe(false);
    expect(fs.existsSync(pluginDir(home))).toBe(false);
  });

  it('rewrites drifted files in place', async () => {
    const home = tempHome();
    writePlugin(home, renderPluginJson(), '{"hooks":{}}');
    const { manager } = makeManager(home, {
      installed: true,
      pluginDir: pluginDir(home),
      pluginVersion: PLUGIN_VERSION,
    });

    const state = await manager.selfHeal();
    expect(state.installed).toBe(true);
    expect(
      fs.readFileSync(path.join(pluginDir(home), 'hooks', 'hooks.json'), 'utf8'),
    ).toBe(renderHooksJson());
  });

  it('never recreates a directory the user deleted', async () => {
    const home = tempHome();
    const { manager, stored } = makeManager(home, {
      installed: true,
      pluginDir: pluginDir(home),
      pluginVersion: PLUGIN_VERSION,
    });

    const state = await manager.selfHeal();
    expect(state.installed).toBe(false);
    expect(stored().installed).toBe(false);
    expect(fs.existsSync(pluginDir(home))).toBe(false);
  });

  it('leaves a hand-edited but still-wired hooks.json alone', async () => {
    const home = tempHome();
    const custom = JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: 'command', command: HOOK_COMMAND },
                { type: 'command', command: 'echo mine' },
              ],
            },
          ],
        },
      },
      null,
      2,
    );
    writePlugin(home, renderPluginJson(), custom);
    const { manager } = makeManager(home, {
      installed: true,
      pluginDir: pluginDir(home),
      pluginVersion: PLUGIN_VERSION,
    });

    await manager.selfHeal();
    expect(
      fs.readFileSync(path.join(pluginDir(home), 'hooks', 'hooks.json'), 'utf8'),
    ).toBe(custom);
  });

  it('restores a single file deleted from an otherwise intact plugin', async () => {
    const home = tempHome();
    writePlugin(home);
    fs.rmSync(path.join(pluginDir(home), 'hooks', 'hooks.json'));
    const { manager } = makeManager(home, {
      installed: true,
      pluginDir: pluginDir(home),
      pluginVersion: PLUGIN_VERSION,
    });

    const state = await manager.selfHeal();
    expect(state.installed).toBe(true);
    expect(manager.isInstalled()).toBe(true);
  });

  it('stamps the plugin version when the files are already correct', async () => {
    const home = tempHome();
    writePlugin(home);
    const { manager } = makeManager(home, { installed: true });
    const state = await manager.selfHeal();
    expect(state.pluginVersion).toBe(PLUGIN_VERSION);
    expect(state.pluginDir).toBe(pluginDir(home));
  });
});

describe('hooks: events watcher', () => {
  it('tails appended events without replaying history', async () => {
    const home = tempHome();
    const file = eventsFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ hook_event_name: 'Old', session_id: SID }) + '\n',
    );

    const { manager } = makeManager(home, { installed: true });
    const seen: HookEvent[] = [];
    manager.startWatcher((e) => seen.push(e));
    expect(manager.hooksActive()).toBe(false);

    fs.appendFileSync(
      file,
      JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: SID,
        transcript_path: '/tmp/t.jsonl',
      }) + '\n',
    );

    expect(await until(() => seen.length > 0)).toBe(true);
    expect(seen).toHaveLength(1); // pre-existing line never replayed
    expect(seen[0]!.event).toBe('SessionStart');
    expect(seen[0]!.sessionId).toBe(SID);
    expect(manager.hooksActive()).toBe(true);
    expect(manager.lastEventAt()).not.toBeNull();
  });

  it('skips malformed lines and survives rotation', async () => {
    const home = tempHome();
    const file = eventsFile(home);
    const { manager } = makeManager(home, { installed: true });
    const seen: HookEvent[] = [];
    manager.startWatcher((e) => seen.push(e));

    fs.appendFileSync(file, 'not json\n{"hook_event_name":"Stop"}\n');
    expect(await until(() => seen.length > 0)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.event).toBe('Stop');
    expect(seen[0]!.sessionId).toBeNull();

    // Rotation: a new inode whose size still exceeds our old offset — only the
    // inode check can see this.
    fs.rmSync(file);
    fs.writeFileSync(
      file,
      JSON.stringify({ hook_event_name: 'SessionEnd', session_id: SID }) +
        '\n' +
        JSON.stringify({ hook_event_name: 'SessionStart', session_id: SID }) +
        '\n',
    );
    expect(await until(() => seen.length > 2)).toBe(true);
    expect(seen[1]!.event).toBe('SessionEnd');
    expect(seen[2]!.event).toBe('SessionStart');
  }, 20_000);

  it('recovers from an in-place truncation', async () => {
    const home = tempHome();
    const file = eventsFile(home);
    const { manager } = makeManager(home, { installed: true });
    const seen: HookEvent[] = [];
    manager.startWatcher((e) => seen.push(e));

    fs.appendFileSync(file, '{"hook_event_name":"Stop"}\n');
    expect(await until(() => seen.length > 0)).toBe(true);

    // In-place truncation keeps the inode, so a drain that lands after the
    // file has already grown past the old offset reads a partial line and
    // drops it. The contract is that the stream RECOVERS on the next complete
    // line — no wedged watcher, at worst one lost accelerator event.
    fs.truncateSync(file, 0);
    fs.appendFileSync(
      file,
      JSON.stringify({ hook_event_name: 'SessionEnd', session_id: SID }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 2_500));
    fs.appendFileSync(
      file,
      JSON.stringify({ hook_event_name: 'Notification', session_id: SID }) +
        '\n',
    );
    expect(
      await until(() => seen.some((e) => e.event === 'Notification')),
    ).toBe(true);
  }, 20_000);

  it('never throws when a listener does', async () => {
    const home = tempHome();
    const file = eventsFile(home);
    const { manager } = makeManager(home, { installed: true });
    let calls = 0;
    manager.startWatcher(() => {
      calls += 1;
      throw new Error('listener blew up');
    });

    fs.appendFileSync(file, '{"hook_event_name":"Stop"}\n');
    expect(await until(() => calls > 0)).toBe(true);
    expect(manager.hooksActive()).toBe(true);
  });

  it('reports activity transitions and stops on dispose', async () => {
    const home = tempHome();
    const file = eventsFile(home);
    const { manager } = makeManager(home, { installed: true });
    const transitions: boolean[] = [];
    manager.onDidChangeHooksActive((a) => transitions.push(a));
    manager.startWatcher(() => undefined);

    fs.appendFileSync(file, '{"hook_event_name":"Stop"}\n');
    expect(await until(() => transitions.length > 0)).toBe(true);
    expect(transitions[0]).toBe(true);

    expect(transitions).toContain(true);

    manager.stopWatcher();
    expect(manager.hooksActive()).toBe(false);
    expect(transitions[transitions.length - 1]).toBe(false);

    manager.dispose();
    // dispose must never delete anything the user opted into
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(path.dirname(file))).toBe(true);
  });

  // REGRESSION. MAX_EVENTS_BYTES used to be checked only at
  // startWatcher() time (a fresh activation), so a window left open for days
  // grew events.ndjson without bound — reclaimed only by quitting and
  // relaunching. drain() now truncates in place once the running total
  // crosses the cap, as long as everything read so far was a complete line.
  it('truncates the events file once it grows past MAX_EVENTS_BYTES while running', async () => {
    const home = tempHome();
    const file = eventsFile(home);
    const { manager } = makeManager(home, { installed: true });
    const seen: HookEvent[] = [];
    manager.startWatcher((e) => seen.push(e));

    // Each line pads out to ~900KB so a handful of appends cross the 5MB
    // rollover without any single drain's BACKLOG exceeding MAX_DRAIN_BYTES
    // (4MB) — that skip-the-backlog path is what "skips malformed lines and
    // survives rotation" above exercises, not this test. A rollover shows up
    // as the file getting SMALLER than it was a moment ago: ordinary growth
    // only ever adds to it, so that is the unambiguous signal to watch for
    // rather than picking a fixed byte total (which, if it truncated a beat
    // earlier than expected, would then just start growing again from zero).
    const padding = 'x'.repeat(900_000);
    let n = 0;
    let previousSize = 0;
    let rolledOver = false;
    while (!rolledOver) {
      n += 1;
      if (n > 20) throw new Error('rollover did not happen in time');
      const line =
        JSON.stringify({
          hook_event_name: 'Notification',
          session_id: SID,
          padding,
          n,
        }) + '\n';
      fs.appendFileSync(file, line);
      expect(await until(() => seen.length >= n)).toBe(true);
      const size = fs.statSync(file).size;
      if (size < previousSize) rolledOver = true;
      previousSize = size;
    }

    expect(rolledOver).toBe(true);

    const seenBefore = seen.length;
    fs.appendFileSync(
      file,
      JSON.stringify({ hook_event_name: 'Stop', session_id: SID }) + '\n',
    );
    expect(await until(() => seen.length > seenBefore)).toBe(true);
    // Nothing already emitted was replayed by the truncation.
    expect(seen.filter((e) => e.event === 'Stop')).toHaveLength(1);
  }, 20_000);
});
