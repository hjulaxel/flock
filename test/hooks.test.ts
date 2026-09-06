// test/hooks.test.ts — the hook plugin Flock writes into the user's
// ~/.claude, and the filesystem-side behaviour that must degrade rather than
// break: the safety-gated remove, activate-time self-heal, and the incremental
// events tail.
//
// Nothing here touches the real $HOME (every manager gets a mkdtemp home) and
// nothing here needs a vscode host: the module's UI calls are optional shims,
// so against the mock's empty `window` they are silent no-ops.

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as process from 'node:process';
import * as vscodeMock from 'vscode';

import {
  CODEX_HOOK_COMMAND,
  HOOK_COMMAND,
  HOOK_COMMAND_WINDOWS,
  hookCommandFor,
  HooksManager,
  PLUGIN_NAME,
  PLUGIN_VERSION,
  eventsFile,
  isRotated,
  parseEventLine,
  pluginDir,
  renderHooksJson,
  renderPluginJson,
} from '../src/hooks';
import type { FileIdentity } from '../src/hooks';
import type { HookEvent, HookInstallState } from '../src/types';

const SID = '0f0000a1-0000-4000-8000-0000000000a1';

/** Mode bits are a POSIX idea; on Windows Node reports 0666/0444 whatever
 *  the ACL says, so the permission tests have nothing to measure there. */
const onPosix = process.platform === 'win32' ? it.skip : it;

function modeOf(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

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
    const parsed = JSON.parse(renderHooksJson('linux')) as {
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
      // No `shell` field: the CLI's default (sh -c) is the one we wrote for.
      expect(matchers[0]!.hooks[0]!['shell']).toBeUndefined();
    }
  });

  it('on Windows renders the PowerShell command and names its shell', () => {
    const parsed = JSON.parse(renderHooksJson('win32')) as {
      hooks: Record<string, Array<{ hooks: Array<Record<string, string>> }>>;
    };
    expect(Object.keys(parsed.hooks)).toHaveLength(6);
    for (const matchers of Object.values(parsed.hooks)) {
      const hook = matchers[0]!.hooks[0]!;
      expect(hook.type).toBe('command');
      expect(hook.command).toBe(HOOK_COMMAND_WINDOWS);
      // Without this the CLI would hand the line to Git Bash where it has one.
      expect(hook['shell']).toBe('powershell');
    }
    expect(hookCommandFor('win32')).toBe(HOOK_COMMAND_WINDOWS);
    expect(hookCommandFor('darwin')).toBe(HOOK_COMMAND);
    // The platform default is whichever this test host is.
    expect(renderHooksJson()).toBe(renderHooksJson(process.platform));
  });

  it('the Windows command carries no double quote and the same envelope', () => {
    // A `"` is the one character every layer between hooks.json and
    // PowerShell's argv has an opinion about; [char]34 stands in for it.
    expect(HOOK_COMMAND_WINDOWS).not.toContain('"');
    expect(HOOK_COMMAND_WINDOWS).toContain('[char]34');
    expect(HOOK_COMMAND_WINDOWS).toContain('lineage_node_id');
    expect(HOOK_COMMAND_WINDOWS).toContain('LINEAGE_NODE_ID');
    expect(HOOK_COMMAND_WINDOWS).toContain("'null'");
    expect(HOOK_COMMAND_WINDOWS).toContain("'.lineage'");
    expect(HOOK_COMMAND_WINDOWS).toContain("'events.ndjson'");
    // The profile folder — what os.homedir() returns on Windows — never an
    // extension install path.
    expect(HOOK_COMMAND_WINDOWS).toContain("GetFolderPath('UserProfile')");
    expect(HOOK_COMMAND_WINDOWS).not.toMatch(/extensions?[/\\]/i);
    // One write of the whole line, LF-terminated.
    expect(HOOK_COMMAND_WINDOWS.split('.Write(').length).toBe(2);
    expect(HOOK_COMMAND_WINDOWS).toContain('[char]10');
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

  it('v5: both /bin/sh commands open with umask 077, before anything is created', () => {
    // The payload is the user's prompts and the model's replies. umask governs
    // creation, so it has to come before the mkdir and before the `>>`.
    expect(HOOK_COMMAND.startsWith("/bin/sh -c 'umask 077; mkdir -p")).toBe(true);
    expect(CODEX_HOOK_COMMAND.startsWith("/bin/sh -c 'umask 077; mkdir -p")).toBe(true);
  });

  onPosix('v5: run for real, the hook creates ~/.lineage 0700 and events.ndjson 0600', () => {
    const home = tempHome();
    const NODE = '0e000000-0000-4000-8000-00000000000e';
    const payload = { hook_event_name: 'UserPromptSubmit', session_id: SID, prompt: 'secret' };
    // Exactly how the CLI runs a shell-form hook: `sh -c "<command>"`, with the
    // payload on stdin and LINEAGE_NODE_ID inherited from the terminal.
    const run = (command: string): void => {
      execFileSync('/bin/sh', ['-c', command], {
        env: { PATH: process.env.PATH ?? '', HOME: home, LINEAGE_NODE_ID: NODE },
        input: JSON.stringify(payload),
      });
    };
    run(HOOK_COMMAND);
    run(CODEX_HOOK_COMMAND);

    const file = eventsFile(home);
    // Without the umask both would inherit the test process's own — 0755 and
    // 0644 on any ordinary machine, which is what a v4 install left behind.
    expect(modeOf(path.dirname(file))).toBe(0o700);
    expect(modeOf(file)).toBe(0o600);

    // And the appended lines are still the v3 envelope the parser reads.
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const claude = parseEventLine(lines[0]!);
    expect(claude?.event).toBe('UserPromptSubmit');
    expect(claude?.sessionId).toBe(SID);
    expect(claude?.nodeId).toBe(NODE);
    expect(claude?.cli).toBe('claude');
    expect(parseEventLine(lines[1]!)?.cli).toBe('codex');
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

// install() used to be POSIX-only (the hook command was /bin/sh). It renders
// the platform's own command now, so these run everywhere; `posix` keeps its
// name so the diff that lifted the gate stays readable.
const posix = it;

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

  onPosix('creates the events directory private to the user (0700)', async () => {
    const home = tempHome();
    stubConsent('Install');
    const { manager } = makeManager(home);
    await manager.install();
    // mkdir without a mode would give 0755 under the ordinary 022 umask.
    expect(modeOf(path.dirname(eventsFile(home)))).toBe(0o700);
  });

  posix('the consent text says what the file records and that it is private', async () => {
    const home = tempHome();
    const details: string[] = [];
    messageApi.showInformationMessage = async (_message, options) => {
      const detail = (options as { detail?: unknown }).detail;
      if (typeof detail === 'string') details.push(detail);
      return undefined; // dismissed: the text is what is under test
    };
    const { manager } = makeManager(home);
    await manager.install();
    expect(details).toHaveLength(1);
    const detail = details[0]!;
    // "Session events are appended" was the whole of it before; a user could
    // not learn from it that their prompts are in the file.
    expect(detail).toContain('each prompt you type');
    expect(detail).toContain('last assistant message');
    expect(detail).toContain('every Claude Code session on this');
    expect(detail).toContain('private');
    expect(detail).toContain(eventsFile(home));
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

  // The events file holds every prompt and last assistant message since the
  // install. Removing the hooks CLEARS it — and by truncation, not unlink: a
  // watcher in another window holds the inode and rewinds on `size < offset`,
  // where an unlinked file would leave it tailing a ghost.
  it('clears the recorded events but keeps the file: same inode, zero bytes', async () => {
    const home = tempHome();
    writePlugin(home);
    const file = eventsFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"payload":{"prompt":"my secret plan"}}\n');
    const ino = fs.statSync(file).ino;
    const prompts = stubConsent(undefined);
    const { manager } = makeManager(home, { installed: true });

    await manager.remove();
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).size).toBe(0);
    expect(fs.statSync(file).ino).toBe(ino);
    // The message says so, in words: "remain in" was the old copy.
    const said = prompts.map((p) => p.message).join('\n');
    expect(said).toContain('were cleared');
    expect(said).toContain('every prompt and last assistant message');
    expect(said).not.toContain('remain in');
  });

  it('clears the recorded events even when there is no plugin left to remove', async () => {
    // `rm -rf`-ed by hand, then "Remove" clicked for good measure: the
    // gesture still means "stop keeping my prompts".
    const home = tempHome();
    const file = eventsFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}\n{}\n');
    const { manager } = makeManager(home, { installed: true });

    await manager.remove();
    expect(fs.statSync(file).size).toBe(0);
  });

  it('does not create an events file that was never there', async () => {
    const home = tempHome();
    writePlugin(home);
    const { manager } = makeManager(home, { installed: true });
    await manager.remove();
    expect(fs.existsSync(eventsFile(home))).toBe(false);
  });

  it('leaves the events alone when it refuses a foreign directory', async () => {
    const home = tempHome();
    writePlugin(home, JSON.stringify({ name: 'someone-elses-plugin' }));
    const file = eventsFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}\n');
    const { manager } = makeManager(home, { installed: true });

    await manager.remove();
    // Nothing was removed, so nothing is cleared: the two go together.
    expect(fs.readFileSync(file, 'utf8')).toBe('{}\n');
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

  // The upgrade every existing install takes on the first activate after v5:
  // hooks.json on disk still runs the v4 command (no umask), the stored
  // version says 4. Without the bump this would read as "hand-edited but
  // still ours" and be left alone — and the file would go on being created
  // world-readable.
  it('v5: rewrites a v4 install whose hooks.json still runs the umask-less command', async () => {
    const home = tempHome();
    const V4_COMMAND =
      '/bin/sh -c \'mkdir -p "$HOME/.lineage"; p=$(cat); [ -n "$p" ] || p=null; ' +
      'printf "{\\"lineage_node_id\\":\\"%s\\",\\"payload\\":%s}\\n" ' +
      '"${LINEAGE_NODE_ID:-}" "$p" >> "$HOME/.lineage/events.ndjson"\'';
    expect(V4_COMMAND).not.toBe(HOOK_COMMAND);
    const v4 = JSON.parse(renderHooksJson('linux')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    for (const matchers of Object.values(v4.hooks)) matchers[0]!.hooks[0]!.command = V4_COMMAND;
    writePlugin(home, renderPluginJson(), JSON.stringify(v4, null, 2));
    const { manager, stored } = makeManager(home, {
      installed: true,
      pluginDir: pluginDir(home),
      pluginVersion: 4,
    });
    expect(manager.isInstalled()).toBe(false); // verify() knows only the current command

    const state = await manager.selfHeal();
    expect(state.installed).toBe(true);
    expect(state.pluginVersion).toBe(PLUGIN_VERSION);
    expect(stored().pluginVersion).toBe(PLUGIN_VERSION);
    expect(
      fs.readFileSync(path.join(pluginDir(home), 'hooks', 'hooks.json'), 'utf8'),
    ).toBe(renderHooksJson());
    expect(manager.isInstalled()).toBe(true);
  });
});

// The rotation decision, on its own. The integration test above can only
// produce whatever THIS machine's filesystem does with a freed inode; these
// pin every case, including the one ubuntu CI produces and APFS never will.
describe('hooks: isRotated', () => {
  const id = (ino: number, birthtimeMs: number, size: number): FileIdentity => ({
    ino,
    birthtimeMs,
    size,
  });

  it('is false for the same file, grown or unchanged', () => {
    expect(isRotated(id(7, 1000, 40), id(7, 1000, 40), 40)).toBe(false);
    expect(isRotated(id(7, 1000, 40), id(7, 1000, 120), 40)).toBe(false);
  });

  it('is true when the inode changed, whatever the size', () => {
    expect(isRotated(id(7, 1000, 40), id(8, 1000, 120), 40)).toBe(true);
    expect(isRotated(id(7, 1000, 40), id(8, 1000, 40), 40)).toBe(true);
  });

  it('ext4: is true for the SAME inode born again, even when the file is larger', () => {
    // rm + recreate on ext4 reuses the inode number. The size exceeds our
    // offset, the inode is unchanged — only the birth time moved. Reading on
    // from the stale offset here is what produced garbage in CI.
    expect(isRotated(id(7, 1000, 40), id(7, 2000, 120), 40)).toBe(true);
  });

  it('ignores a birth time the filesystem does not report (0 on either side)', () => {
    // Zero means "no creation time here", not "born at the epoch": a change
    // to or from zero must not read as a rotation.
    expect(isRotated(id(7, 0, 40), id(7, 2000, 120), 40)).toBe(false);
    expect(isRotated(id(7, 1000, 40), id(7, 0, 120), 40)).toBe(false);
    expect(isRotated(id(7, 0, 40), id(7, 0, 120), 40)).toBe(false);
  });

  it('ignores an inode of 0 (platforms that report none), and falls back to the other signals', () => {
    expect(isRotated(id(0, 1000, 40), id(0, 1000, 120), 40)).toBe(false);
    expect(isRotated(id(7, 1000, 40), id(0, 1000, 120), 40)).toBe(false);
    expect(isRotated(id(0, 1000, 40), id(0, 2000, 120), 40)).toBe(true);
  });

  it('is true when the file is shorter than what was read from it', () => {
    // In-place truncation: same inode, same birth time, only the size says.
    expect(isRotated(id(7, 1000, 40), id(7, 1000, 10), 40)).toBe(true);
    expect(isRotated(null, id(7, 1000, 10), 40)).toBe(true);
  });

  it('with nothing to compare against, only the size can speak', () => {
    expect(isRotated(null, id(7, 1000, 120), 0)).toBe(false);
    expect(isRotated(null, id(7, 1000, 120), 40)).toBe(false);
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

    // Rotation: a recreated file whose size still exceeds our old offset, so
    // the size check cannot see it. On APFS the new file wears a new inode;
    // on ext4 it very often wears the SAME one (freed inode numbers are
    // handed straight back), and only the birth time tells — see isRotated
    // and its unit tests below. Both filesystems run this test in CI.
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

  onPosix('tightens a world-readable events file and directory on start', async () => {
    // What a v4 hook left behind: 0644 in 0755. umask in the v5 command only
    // governs creation, so the extension has to chmod what already exists.
    const home = tempHome();
    const file = eventsFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.chmodSync(path.dirname(file), 0o755);
    fs.writeFileSync(file, '{"hook_event_name":"Stop"}\n', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    expect(modeOf(file)).toBe(0o644);

    const { manager } = makeManager(home, { installed: true });
    const seen: HookEvent[] = [];
    manager.startWatcher((e) => seen.push(e));

    expect(modeOf(path.dirname(file))).toBe(0o700);
    expect(modeOf(file)).toBe(0o600);
    // ...and the tail still works afterwards, from the end, as before.
    fs.appendFileSync(file, '{"hook_event_name":"Notification"}\n');
    expect(await until(() => seen.length > 0)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.event).toBe('Notification');
  });

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
