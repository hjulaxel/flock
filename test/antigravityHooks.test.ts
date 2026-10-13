// test/antigravityHooks.test.ts — the plugin folder Flock writes for the
// Antigravity CLI, the command inside it, and the manager that keeps it.
//
// The command is run for real through /bin/sh, because two of its properties
// cannot be seen in the string: the line it appends must parse, and it must
// print NOTHING (agy reads a PreToolUse hook's `{}` as "deny").

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { antigravityHookCommand, parseEventLine } from '../src/hooks';
import {
  ANTIGRAVITY_HOOK_EVENTS,
  ANTIGRAVITY_HOOKS_VERSION,
  AntigravityHooksManager,
  antigravityHooksCoverage,
  antigravityPluginDir,
  renderAntigravityHooksJson,
  renderAntigravityPluginJson,
} from '../src/antigravityHooks';
import type { HookInstallState } from '../src/types';

const homes: string[] = [];
function tmpHome(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-agy-hooks-'));
  homes.push(h);
  return h;
}
afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

/** Plant the plugin exactly as an accepted install writes it. The install
 *  itself is behind a consent modal the mock window declines. */
function plantPlugin(home: string): void {
  const dir = antigravityPluginDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), renderAntigravityPluginJson());
  fs.writeFileSync(path.join(dir, 'hooks.json'), renderAntigravityHooksJson());
}

function memoryDeps(initial: HookInstallState = { installed: false }) {
  let stored: HookInstallState = initial;
  return {
    getStored: () => stored,
    setStored: async (s: HookInstallState) => {
      stored = s;
    },
    get: () => stored,
  };
}

const CONV = '2c0655f7-0ff5-49d4-9ac5-1997e51f83db';
const NODE = '11111111-2222-4333-8444-555555555555';

describe.skipIf(process.platform === 'win32')('the hook command, run through /bin/sh', () => {
  it('appends one parsable line and prints nothing', () => {
    const home = tmpHome();
    const payload = JSON.stringify({
      conversationId: CONV,
      transcriptPath: `${home}/.gemini/antigravity-cli/brain/${CONV}/t.jsonl`,
      fullyIdle: true,
    });
    const stdout = execFileSync('/bin/sh', ['-c', antigravityHookCommand('Stop')], {
      input: payload,
      env: { HOME: home, LINEAGE_NODE_ID: NODE, PATH: process.env['PATH'] ?? '' },
    }).toString();
    expect(stdout).toBe('');
    const lines = fs.readFileSync(path.join(home, '.lineage', 'events.ndjson'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const e = parseEventLine(lines[0] ?? '');
    expect(e?.event).toBe('Stop');
    expect(e?.cli).toBe('antigravity');
    expect(e?.sessionId).toBe(CONV);
    expect(e?.nodeId).toBe(NODE);
  });

  it('records an empty node id for a session Flock did not launch', () => {
    const home = tmpHome();
    execFileSync('/bin/sh', ['-c', antigravityHookCommand('PreInvocation')], {
      input: JSON.stringify({ conversationId: CONV }),
      env: { HOME: home, PATH: process.env['PATH'] ?? '' },
    });
    const line = fs.readFileSync(path.join(home, '.lineage', 'events.ndjson'), 'utf8').trim();
    expect(parseEventLine(line)?.nodeId).toBeNull();
  });
});

describe('antigravityHookCommand', () => {
  it('refuses anything that is not a plain event name, since it is pasted into shell text', () => {
    expect(() => antigravityHookCommand("Stop'; rm -rf ~; '")).toThrow();
  });
});

describe('the plugin folder', () => {
  it("is agy's hooks.json shape: one named hook, handlers directly under each event", () => {
    const doc = JSON.parse(renderAntigravityHooksJson()) as Record<string, Record<string, unknown[]>>;
    expect(Object.keys(doc)).toEqual(['flock']);
    for (const event of ANTIGRAVITY_HOOK_EVENTS) {
      const handlers = doc['flock']?.[event] as Array<Record<string, unknown>>;
      expect(handlers).toHaveLength(1);
      expect(handlers[0]?.['type']).toBe('command');
      expect(handlers[0]?.['command']).toBe(antigravityHookCommand(event));
    }
  });

  it('subscribes to no tool events, whose payloads carry file contents', () => {
    expect(ANTIGRAVITY_HOOK_EVENTS).not.toContain('PreToolUse');
    expect(ANTIGRAVITY_HOOK_EVENTS).not.toContain('PostToolUse');
  });

  it('lands in ~/.gemini/config/plugins/flock', async () => {
    const home = tmpHome();
    plantPlugin(home);
    expect(antigravityPluginDir(home)).toBe(path.join(home, '.gemini', 'config', 'plugins', 'flock'));
    expect(fs.existsSync(path.join(antigravityPluginDir(home), 'plugin.json'))).toBe(true);
    expect(antigravityHooksCoverage(antigravityPluginDir(home)).missing).toEqual([]);
  });
});

describe('AntigravityHooksManager', () => {
  it('self-heal honours a hand-removal: the flag clears and nothing is re-added', async () => {
    const home = tmpHome();
    const deps = memoryDeps({ installed: true, pluginVersion: ANTIGRAVITY_HOOKS_VERSION });
    const manager = new AntigravityHooksManager(deps, { home, platform: 'darwin' });
    const state = await manager.selfHeal();
    expect(state.installed).toBe(false);
    expect(fs.existsSync(antigravityPluginDir(home))).toBe(false);
  });

  it('self-heal rewrites a folder of ours that an older version wrote', async () => {
    const home = tmpHome();
    plantPlugin(home);
    const hooksFile = path.join(antigravityPluginDir(home), 'hooks.json');
    fs.writeFileSync(hooksFile, '{"flock":{}}\n');
    const deps = memoryDeps({ installed: true, pluginVersion: ANTIGRAVITY_HOOKS_VERSION });
    const manager = new AntigravityHooksManager(deps, { home, platform: 'darwin' });
    await manager.selfHeal();
    expect(manager.isInstalled()).toBe(true);
    expect(fs.readFileSync(hooksFile, 'utf8')).toBe(renderAntigravityHooksJson());
  });

  it('remove deletes the folder it wrote, and leaves a stranger\'s alone', async () => {
    const home = tmpHome();
    plantPlugin(home);
    const manager = new AntigravityHooksManager(memoryDeps({ installed: true }), {
      home,
      platform: 'darwin',
    });
    expect((await manager.remove()).installed).toBe(false);
    expect(fs.existsSync(antigravityPluginDir(home))).toBe(false);

    const dir = antigravityPluginDir(home);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.json'), '{"name":"flock"}');
    await manager.remove();
    expect(fs.existsSync(path.join(dir, 'plugin.json'))).toBe(true);
  });

  it('install is declined without consent and writes nothing', async () => {
    const home = tmpHome();
    const manager = new AntigravityHooksManager(memoryDeps(), { home, platform: 'darwin' });
    const state = await manager.install();
    expect(state.installed).toBe(false);
    expect(fs.existsSync(antigravityPluginDir(home))).toBe(false);
  });

  it('does not install on Windows', async () => {
    const home = tmpHome();
    const manager = new AntigravityHooksManager(memoryDeps(), { home, platform: 'win32' });
    expect((await manager.install()).installed).toBe(false);
    expect(fs.existsSync(antigravityPluginDir(home))).toBe(false);
  });
});
