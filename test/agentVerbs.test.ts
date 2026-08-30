// test/agentVerbs.test.ts — the in-session verbs: the request protocol a
// session's CLI writes into ~/.lineage/requests, the claim discipline that
// makes N watching windows run a request exactly once, and the fork executor
// that turns "do three forks" into three correctly-titled branches.
//
// Nothing here touches the real $HOME (every manager gets a mkdtemp home) and
// nothing needs a vscode host: the module's UI calls are optional shims, so
// against the mock's empty `window` they are silent no-ops. The one genuinely
// end-to-end block runs the RENDERED CLI under `process.execPath` against a
// temp home — the script is a generated artifact, and the only test that can
// catch it drifting from the watcher's protocol is one that executes it.

import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as process from 'node:process';

import {
  AgentVerbsManager,
  MAX_AGENT_FORKS,
  MAX_AGENT_PROMPT_CHARS,
  MAX_AGENT_TITLE_CHARS,
  VERBS_VERSION,
  clampForkCount,
  parseRequestText,
  renderSkillMd,
  renderVerbScript,
  requestsDir,
  verbsScriptPath,
  verbsSkillDir,
} from '../src/agentVerbs';
import type {
  AgentForkOutcome,
  AgentForkRequest,
  VerbExecutor,
} from '../src/agentVerbs';
import { forkForAgent } from '../src/commands';
import type { AccountCommandDeps } from '../src/commands';
import type {
  HookInstallState,
  LaunchOptions,
  SessionForest,
  SessionNode,
} from '../src/types';

const SID = '0f0000a1-0000-4000-8000-0000000000a1';
const REQ_ID = '11111111-2222-4333-8444-555555555555';

const temps: string[] = [];
const managers: AgentVerbsManager[] = [];

afterEach(() => {
  for (const m of managers.splice(0)) m.dispose();
  for (const dir of temps.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* leave it for the OS */
    }
  }
});

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-verbs-'));
  temps.push(dir);
  return dir;
}

function makeManager(
  home: string,
  opts: {
    initial?: HookInstallState;
    claimDelayMs?: number;
    fallbackMs?: number;
    requestTtlMs?: number;
  } = {},
) {
  let stored: HookInstallState = opts.initial ?? { installed: false };
  const manager = new AgentVerbsManager(
    {
      getStored: () => stored,
      setStored: (s) => {
        stored = s;
      },
    },
    home,
    {
      claimDelayMs: opts.claimDelayMs ?? 40,
      fallbackMs: opts.fallbackMs ?? 50,
      ...(opts.requestTtlMs !== undefined
        ? { requestTtlMs: opts.requestTtlMs }
        : {}),
    },
  );
  managers.push(manager);
  return { manager, stored: () => stored };
}

/** Write both files exactly as install() would, without the consent UI. */
function writeVerbs(home: string): void {
  const dir = verbsSkillDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), renderSkillMd());
  fs.mkdirSync(path.dirname(verbsScriptPath(home)), { recursive: true });
  fs.writeFileSync(verbsScriptPath(home), renderVerbScript());
}

function writeRequest(
  home: string,
  body: unknown,
  id: string = REQ_ID,
): string {
  const dir = requestsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(
    file,
    typeof body === 'string' ? body : JSON.stringify(body),
  );
  return file;
}

function replyPath(home: string, id: string = REQ_ID): string {
  return path.join(requestsDir(home), `${id}.reply.json`);
}

function readReply(home: string, id: string = REQ_ID): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(replyPath(home, id), 'utf8')) as Record<
    string,
    unknown
  >;
}

async function until(
  predicate: () => boolean,
  timeoutMs = 8000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
}

/** An executor whose fork calls are recorded; `bound` decides claim priority. */
function makeExecutor(opts: { bound?: boolean; fail?: string } = {}) {
  const calls: AgentForkRequest[] = [];
  const executor: VerbExecutor = {
    isBoundHere: () => opts.bound === true,
    tipOf: (id) => id,
    runFork: async (request) => {
      calls.push(request);
      if (opts.fail !== undefined) {
        return { forked: [], titles: [], error: opts.fail };
      }
      const forked = Array.from({ length: request.count }, (_, i) =>
        SID.replace(/a1$/, `b${i}`),
      );
      const titles = forked.map((_, i) => `fork ${i + 2}`);
      return { forked, titles };
    },
  };
  return { executor, calls };
}

// ---------------------------------------------------------------- requests

describe('parseRequestText', () => {
  it('accepts a minimal fork request', () => {
    const parsed = parseRequestText(
      JSON.stringify({ v: 1, verb: 'fork', node: SID, count: 3 }),
    );
    expect(parsed).toEqual({ verb: 'fork', node: SID, count: 3 });
  });

  it('carries the prompt through', () => {
    const parsed = parseRequestText(
      JSON.stringify({ v: 1, verb: 'fork', node: SID, count: 1, prompt: 'go' }),
    );
    expect(parsed).toEqual({ verb: 'fork', node: SID, count: 1, prompt: 'go' });
  });

  it('rejects junk, wrong versions, unknown verbs and missing sessions', () => {
    expect(parseRequestText('not json')).toHaveProperty('error');
    expect(parseRequestText('[1,2]')).toHaveProperty('error');
    expect(
      parseRequestText(JSON.stringify({ v: 2, verb: 'fork', node: SID })),
    ).toHaveProperty('error');
    expect(
      parseRequestText(JSON.stringify({ v: 1, verb: 'merge', node: SID })),
    ).toHaveProperty('error');
    expect(
      parseRequestText(JSON.stringify({ v: 1, verb: 'fork', node: 'nope' })),
    ).toHaveProperty('error');
  });

  it('clamps the count instead of refusing it', () => {
    const at = (count: unknown) =>
      parseRequestText(JSON.stringify({ v: 1, verb: 'fork', node: SID, count }));
    expect(at(0)).toMatchObject({ count: 1 });
    expect(at(999)).toMatchObject({ count: MAX_AGENT_FORKS });
    expect(at('three')).toMatchObject({ count: 1 });
    expect(at(undefined)).toMatchObject({ count: 1 });
    expect(at(3.7)).toMatchObject({ count: 3 });
  });

  it('carries fork names through, trimmed', () => {
    const parsed = parseRequestText(
      JSON.stringify({
        v: 1,
        verb: 'fork',
        node: SID,
        count: 2,
        titles: [' redis cache ', 'SQL approach'],
      }),
    );
    expect(parsed).toEqual({
      verb: 'fork',
      node: SID,
      count: 2,
      titles: ['redis cache', 'SQL approach'],
    });
  });

  it('refuses names that do not line up one-per-fork', () => {
    const at = (count: number, titles: unknown) =>
      parseRequestText(
        JSON.stringify({ v: 1, verb: 'fork', node: SID, count, titles }),
      );
    expect(at(3, ['a', 'b'])).toHaveProperty('error');
    expect(at(1, [])).toHaveProperty('error');
    expect(at(2, ['a', 7])).toHaveProperty('error');
    expect(at(2, ['a', '  '])).toHaveProperty('error');
    expect(at(1, ['x'.repeat(MAX_AGENT_TITLE_CHARS + 1)])).toHaveProperty(
      'error',
    );
  });

  it('refuses an oversized or non-string prompt — never truncates one', () => {
    const long = 'x'.repeat(MAX_AGENT_PROMPT_CHARS + 1);
    expect(
      parseRequestText(
        JSON.stringify({ v: 1, verb: 'fork', node: SID, prompt: long }),
      ),
    ).toHaveProperty('error');
    expect(
      parseRequestText(
        JSON.stringify({ v: 1, verb: 'fork', node: SID, prompt: 7 }),
      ),
    ).toHaveProperty('error');
  });
});

describe('clampForkCount', () => {
  it('is 1..MAX_AGENT_FORKS with 1 as the answer to nonsense', () => {
    expect(clampForkCount(1)).toBe(1);
    expect(clampForkCount(MAX_AGENT_FORKS)).toBe(MAX_AGENT_FORKS);
    expect(clampForkCount(MAX_AGENT_FORKS + 1)).toBe(MAX_AGENT_FORKS);
    expect(clampForkCount(-2)).toBe(1);
    expect(clampForkCount(NaN)).toBe(1);
    expect(clampForkCount('4')).toBe(1);
  });
});

// ------------------------------------------------------- the rendered files

describe('the rendered files', () => {
  it('the skill teaches the CLI invocation and carries our marker', () => {
    const skill = renderSkillMd();
    expect(skill).toContain('name: flock');
    expect(skill).toContain('flock-verbs.mjs fork');
    expect(skill).toContain('Flock VS Code extension');
  });

  it('the CLI enforces the same caps the watcher does', () => {
    const script = renderVerbScript();
    expect(script).toContain('Flock VS Code extension');
    expect(script).toContain(String(MAX_AGENT_FORKS));
    expect(script).toContain(String(MAX_AGENT_PROMPT_CHARS));
    expect(script).toContain('LINEAGE_NODE_ID');
    expect(script).toContain("'.lineage', 'requests'");
  });
});

// ------------------------------------------------- install-state lifecycle

describe('selfHeal', () => {
  it('clears the stored flag when the user rm -rf-ed the files', async () => {
    const home = tempHome();
    const { manager, stored } = makeManager(home, {
      initial: { installed: true, pluginVersion: 1 },
    });
    const state = await manager.selfHeal();
    expect(state.installed).toBe(false);
    expect(stored().installed).toBe(false);
  });

  it('rewrites a broken file when the stored version is stale', async () => {
    const home = tempHome();
    writeVerbs(home);
    fs.writeFileSync(verbsScriptPath(home), 'echo broken');
    const { manager } = makeManager(home, {
      initial: { installed: true, pluginVersion: 0 },
    });
    const state = await manager.selfHeal();
    expect(state.installed).toBe(true);
    expect(fs.readFileSync(verbsScriptPath(home), 'utf8')).toBe(
      renderVerbScript(),
    );
  });

  it('leaves a hand-edited install alone while it still carries our verb', async () => {
    const home = tempHome();
    writeVerbs(home);
    const skill = path.join(verbsSkillDir(home), 'SKILL.md');
    const edited = fs.readFileSync(skill, 'utf8') + '\nHouse rule: max 2.\n';
    fs.writeFileSync(skill, edited);
    const { manager } = makeManager(home, {
      initial: {
        installed: true,
        pluginVersion: VERBS_VERSION,
        pluginDir: verbsSkillDir(home),
      },
    });
    await manager.selfHeal();
    expect(fs.readFileSync(skill, 'utf8')).toBe(edited);
  });
});

describe('remove', () => {
  it('refuses a foreign skill directory', async () => {
    const home = tempHome();
    const dir = verbsSkillDir(home);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      '---\nname: flock\n---\nSomebody else made this.\n',
    );
    const { manager } = makeManager(home, { initial: { installed: true } });
    await manager.remove();
    expect(fs.existsSync(path.join(dir, 'SKILL.md'))).toBe(true);
  });

  it('removes our files and clears the stored flag', async () => {
    const home = tempHome();
    writeVerbs(home);
    const { manager, stored } = makeManager(home, {
      initial: { installed: true, pluginVersion: 1 },
    });
    await manager.remove();
    expect(fs.existsSync(verbsSkillDir(home))).toBe(false);
    expect(fs.existsSync(verbsScriptPath(home))).toBe(false);
    expect(stored().installed).toBe(false);
  });
});

// ----------------------------------------------------------- the watcher

describe('the request watcher', () => {
  it('runs a request and writes the reply the CLI is polling for', async () => {
    const home = tempHome();
    const { manager } = makeManager(home);
    const { executor, calls } = makeExecutor({ bound: true });
    manager.startWatcher(executor);

    writeRequest(home, {
      v: 1,
      verb: 'fork',
      node: SID,
      count: 2,
      prompt: 'start with the tests',
    });
    expect(await until(() => fs.existsSync(replyPath(home)))).toBe(true);

    expect(calls).toEqual([
      { node: SID, count: 2, prompt: 'start with the tests' },
    ]);
    const reply = readReply(home);
    expect(reply.ok).toBe(true);
    expect(reply.forked).toHaveLength(2);
    expect(reply.titles).toEqual(['fork 2', 'fork 3']);
    // The request itself is consumed — nothing for another window to claim.
    expect(
      fs.existsSync(path.join(requestsDir(home), `${REQ_ID}.json`)),
    ).toBe(false);
  });

  it('a window that does not host the session still answers, after its head start', async () => {
    const home = tempHome();
    const { manager } = makeManager(home, { claimDelayMs: 30 });
    const { executor, calls } = makeExecutor({ bound: false });
    manager.startWatcher(executor);

    writeRequest(home, { v: 1, verb: 'fork', node: SID, count: 1 });
    expect(await until(() => fs.existsSync(replyPath(home)))).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('N windows, ONE fork: the bound window wins the rename', async () => {
    const home = tempHome();
    const behind = makeManager(home, { claimDelayMs: 400 });
    const bound = makeManager(home);
    const loser = makeExecutor({ bound: false });
    const winner = makeExecutor({ bound: true });
    behind.manager.startWatcher(loser.executor);
    bound.manager.startWatcher(winner.executor);

    writeRequest(home, { v: 1, verb: 'fork', node: SID, count: 3 });
    expect(await until(() => fs.existsSync(replyPath(home)))).toBe(true);
    // Give the slow window's claim timer time to fire into the rename ENOENT.
    await new Promise((r) => setTimeout(r, 500));

    expect(winner.calls).toHaveLength(1);
    expect(loser.calls).toHaveLength(0);
  });

  it('replies with the error instead of letting the CLI time out on junk', async () => {
    const home = tempHome();
    const { manager } = makeManager(home, { claimDelayMs: 10 });
    const { executor, calls } = makeExecutor();
    manager.startWatcher(executor);

    writeRequest(home, 'this is not json');
    expect(await until(() => fs.existsSync(replyPath(home)))).toBe(true);
    expect(calls).toHaveLength(0);
    const reply = readReply(home);
    expect(reply.ok).toBe(false);
    expect(String(reply.error)).toContain('JSON');
  });

  it('answers a stale request "expired" rather than forking it late', async () => {
    const home = tempHome();
    const { manager } = makeManager(home, {
      claimDelayMs: 10,
      requestTtlMs: 50,
    });
    const { executor, calls } = makeExecutor({ bound: true });
    const file = writeRequest(home, { v: 1, verb: 'fork', node: SID, count: 1 });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file, old, old);
    manager.startWatcher(executor);

    expect(await until(() => fs.existsSync(replyPath(home)))).toBe(true);
    expect(calls).toHaveLength(0);
    const reply = readReply(home);
    expect(reply.ok).toBe(false);
    expect(String(reply.error)).toContain('expired');
  });

  it('an executor failure comes back in the reply, never as a hang', async () => {
    const home = tempHome();
    const { manager } = makeManager(home);
    const { executor } = makeExecutor({ bound: true, fail: 'no transcript' });
    manager.startWatcher(executor);

    writeRequest(home, { v: 1, verb: 'fork', node: SID, count: 1 });
    expect(await until(() => fs.existsSync(replyPath(home)))).toBe(true);
    const reply = readReply(home);
    expect(reply.ok).toBe(false);
    expect(reply.error).toBe('no transcript');
  });
});

// -------------------------------------------------------------- the fork

/** The minimal honest AccountCommandDeps for forkForAgent: a parent with a
 *  transcript, one existing branch, and a launch that succeeds. Every member
 *  the flow never reaches throws, so a new dependency shows up as a test
 *  failure instead of a silent undefined. */
function forkDeps(over: { launchFails?: boolean } = {}) {
  const PARENT = SID;
  const CHILD1 = '0f0000a1-0000-4000-8000-0000000000c1';
  const node = (id: string, o: Partial<SessionNode> = {}): SessionNode => ({
    id,
    parentId: null,
    source: 'none',
    ghost: false,
    archived: false,
    hidden: false,
    deleted: false,
    status: 'idle',
    attention: 'none',
    label: id.slice(0, 8),
    kind: 'interactive',
    children: [],
    visibleChildren: [],
    ...o,
  });
  const parent = node(PARENT, {
    label: 'auth',
    cwd: '/tmp/auth',
    children: [CHILD1],
    visibleChildren: [CHILD1],
  });
  const child = node(CHILD1, { label: 'auth 2', parentId: PARENT });
  const forest: SessionForest = {
    nodes: new Map([
      [PARENT, parent],
      [CHILD1, child],
    ]),
    roots: [PARENT],
    visibleRoots: [PARENT],
    edges: [],
    attentionCount: 0,
    generatedAt: 0,
  };
  const launches: LaunchOptions[] = [];
  const nope = (): never => {
    throw new Error('not used by forkForAgent');
  };
  const deps: AccountCommandDeps = {
    getForest: () => forest,
    refresh: () => undefined,
    hasTranscript: (id) => id === PARENT,
    tipOf: (id) => id,
    beginInlineRename: async () => false,
    beginInlineRenameProject: async () => false,
    revealSession: async () => undefined,
    focusSessionsView: async () => true,
    revealProject: async () => undefined,
    getRecord: () => undefined,
    allRecords: () => ({}),
    upsertRecord: async () => undefined,
    recordLaunch: async () => undefined,
    launchSession: async (opts) => {
      launches.push(opts);
      if (over.launchFails === true) return null;
      return {
        nodeId: opts.sessionId,
        sessionId: opts.sessionId,
        terminalName: 'claude',
        createdAt: 0,
      };
    },
    focusSession: () => false,
    renameTerminal: async () => false,
    sendTextToSession: () => false,
    closeTerminal: () => false,
    focusWindowFor: async () => false,
    openProject: async () => undefined,
    installHooks: nope,
    removeHooks: nope,
    getHookState: () => ({ installed: false }),
    setHooksEnabled: async () => undefined,
    allProjects: () => [],
    getProject: () => undefined,
    getBranches: () => [],
    setBranchShown: async () => undefined,
    setBranchesShown: async () => undefined,
    upsertProject: async () => undefined,
    setProjectParent: async () => true,
    deleteProject: async () => undefined,
    hiddenFolders: () => [],
    hideFolder: async () => undefined,
    unhideFolder: async () => undefined,
    staleAfterHours: () => 24,
    markSeen: async () => undefined,
    notificationsEnabled: () => false,
    setOnlyActiveSessions: async () => undefined,
    setAccountsSection: async () => undefined,
    setBranchDisplay: async () => undefined,
    selectedSessions: () => [],
    switchWorkspace: async () => undefined,
    activeWorkspace: () => null,
  };
  return { deps, launches, PARENT };
}

describe('forkForAgent', () => {
  it('titles N forks past the parent AND each other, and forks the parent', async () => {
    const { deps, launches, PARENT } = forkDeps();
    const outcome: AgentForkOutcome = await forkForAgent(deps, PARENT, {
      count: 3,
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.forked).toHaveLength(3);
    // 'auth' is the parent, 'auth 2' its existing branch — three more must
    // walk on from there, not stack up on 'auth 2'.
    expect(outcome.titles).toEqual(['auth 3', 'auth 4', 'auth 5']);
    expect(launches).toHaveLength(3);
    for (const launch of launches) {
      expect(launch.parentId).toBe(PARENT);
      expect(launch.cwd).toBe('/tmp/auth');
    }
  });

  it('hands the prompt to every fork', async () => {
    const { deps, launches, PARENT } = forkDeps();
    await forkForAgent(deps, PARENT, { count: 2, prompt: 'compact first' });
    expect(launches.map((l) => l.prompt)).toEqual([
      'compact first',
      'compact first',
    ]);
  });

  it('wears the names the model asked for, in order', async () => {
    const { deps, PARENT } = forkDeps();
    const outcome = await forkForAgent(deps, PARENT, {
      count: 2,
      titles: ['redis cache', 'SQL approach'],
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.titles).toEqual(['redis cache', 'SQL approach']);
  });

  it('a name that collides — with a row or with itself — gets a counter, not a twin', async () => {
    // 'auth 2' already exists as the parent's branch; asking for it twice
    // more must yield three DISTINCT rows.
    const { deps, PARENT } = forkDeps();
    const outcome = await forkForAgent(deps, PARENT, {
      count: 2,
      titles: ['auth 2', 'auth 2'],
    });
    expect(outcome.titles).toHaveLength(2);
    expect(new Set(outcome.titles).size).toBe(2);
    expect(outcome.titles).not.toContain('auth 2');
  });

  it('clamps a runaway count', async () => {
    const { deps, launches, PARENT } = forkDeps();
    const outcome = await forkForAgent(deps, PARENT, { count: 999 });
    expect(outcome.forked).toHaveLength(MAX_AGENT_FORKS);
    expect(launches).toHaveLength(MAX_AGENT_FORKS);
  });

  it('says "no transcript" as a value, not a toast', async () => {
    const { deps } = forkDeps();
    const outcome = await forkForAgent(
      deps,
      '0f0000a1-0000-4000-8000-0000000000ff',
      { count: 1 },
    );
    expect(outcome.forked).toEqual([]);
    expect(outcome.error).toContain('no transcript');
  });

  it('reports a partial launch as exactly what it was', async () => {
    const { deps, PARENT } = forkDeps({ launchFails: true });
    const outcome = await forkForAgent(deps, PARENT, { count: 2 });
    expect(outcome.forked).toEqual([]);
    expect(outcome.error).toContain('did not launch');
  });
});

// ------------------------------------------------------- the CLI, executed

describe('the rendered CLI', () => {
  function runCli(
    home: string,
    args: string[],
    env: Record<string, string>,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const script = verbsScriptPath(home);
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [script, ...args],
        // A minimal env ON PURPOSE: the test runner may itself live inside
        // tmux or a Flock terminal, and inheriting that env would hand the
        // script an identity the test did not choose.
        { env: { PATH: process.env.PATH ?? '', HOME: home, ...env } },
        (err, stdout, stderr) => {
          const code =
            err && typeof (err as { code?: unknown }).code === 'number'
              ? ((err as { code?: number }).code ?? 1)
              : err
                ? 1
                : 0;
          resolve({ code, stdout, stderr });
        },
      );
    });
  }

  it('writes the request, waits for the reply, and reports the branches', async () => {
    const home = tempHome();
    fs.mkdirSync(path.dirname(verbsScriptPath(home)), { recursive: true });
    fs.writeFileSync(verbsScriptPath(home), renderVerbScript());

    const done = runCli(
      home,
      ['fork', '--count', '2', '--prompt', 'hello'],
      { LINEAGE_NODE_ID: SID },
    );

    // Play the extension's part: claim the request, write the reply.
    const dir = requestsDir(home);
    expect(
      await until(() =>
        fs.existsSync(dir) &&
        fs.readdirSync(dir).some((f) => /^[0-9a-f-]{36}\.json$/.test(f)),
      ),
    ).toBe(true);
    const reqName = fs
      .readdirSync(dir)
      .find((f) => /^[0-9a-f-]{36}\.json$/.test(f))!;
    const body = JSON.parse(
      fs.readFileSync(path.join(dir, reqName), 'utf8'),
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      v: 1,
      verb: 'fork',
      node: SID,
      count: 2,
      prompt: 'hello',
    });
    fs.writeFileSync(
      path.join(dir, reqName.replace(/\.json$/, '.reply.json')),
      JSON.stringify({ ok: true, forked: [SID, SID], titles: ['auth 2', 'auth 3'] }),
    );

    const result = await done;
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Forked 2 new sessions');
    expect(result.stdout).toContain('auth 2, auth 3');
  });

  it('relays a refusal and exits nonzero', async () => {
    const home = tempHome();
    fs.mkdirSync(path.dirname(verbsScriptPath(home)), { recursive: true });
    fs.writeFileSync(verbsScriptPath(home), renderVerbScript());

    const done = runCli(home, ['fork'], { LINEAGE_NODE_ID: SID });
    const dir = requestsDir(home);
    expect(
      await until(() =>
        fs.existsSync(dir) &&
        fs.readdirSync(dir).some((f) => /^[0-9a-f-]{36}\.json$/.test(f)),
      ),
    ).toBe(true);
    const reqName = fs
      .readdirSync(dir)
      .find((f) => /^[0-9a-f-]{36}\.json$/.test(f))!;
    fs.writeFileSync(
      path.join(dir, reqName.replace(/\.json$/, '.reply.json')),
      JSON.stringify({ ok: false, error: 'this session has no transcript' }),
    );

    const result = await done;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('no transcript');
  });

  it('says so when it cannot tell which session it is in', async () => {
    const home = tempHome();
    fs.mkdirSync(path.dirname(verbsScriptPath(home)), { recursive: true });
    fs.writeFileSync(verbsScriptPath(home), renderVerbScript());

    const result = await runCli(home, ['fork'], {});
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Could not tell which session');
    // And it left no request behind for a window to trip over later.
    expect(
      fs.existsSync(requestsDir(home)) &&
        fs.readdirSync(requestsDir(home)).length > 0,
    ).toBe(false);
  });

  it('names imply the count, and land in the request as titles', async () => {
    const home = tempHome();
    fs.mkdirSync(path.dirname(verbsScriptPath(home)), { recursive: true });
    fs.writeFileSync(verbsScriptPath(home), renderVerbScript());

    const done = runCli(
      home,
      ['fork', '--name', 'redis cache', '--name', 'SQL approach'],
      { LINEAGE_NODE_ID: SID },
    );
    const dir = requestsDir(home);
    expect(
      await until(() =>
        fs.existsSync(dir) &&
        fs.readdirSync(dir).some((f) => /^[0-9a-f-]{36}\.json$/.test(f)),
      ),
    ).toBe(true);
    const reqName = fs
      .readdirSync(dir)
      .find((f) => /^[0-9a-f-]{36}\.json$/.test(f))!;
    const body = JSON.parse(
      fs.readFileSync(path.join(dir, reqName), 'utf8'),
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      count: 2,
      titles: ['redis cache', 'SQL approach'],
    });
    fs.writeFileSync(
      path.join(dir, reqName.replace(/\.json$/, '.reply.json')),
      JSON.stringify({
        ok: true,
        forked: [SID, SID],
        titles: ['redis cache', 'SQL approach'],
      }),
    );
    const result = await done;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('redis cache, SQL approach');
  });

  it('refuses a name/count mismatch before writing anything', async () => {
    const home = tempHome();
    fs.mkdirSync(path.dirname(verbsScriptPath(home)), { recursive: true });
    fs.writeFileSync(verbsScriptPath(home), renderVerbScript());

    const result = await runCli(
      home,
      ['fork', '--count', '3', '--name', 'only one'],
      { LINEAGE_NODE_ID: SID },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('one --name per fork');
    expect(
      fs.existsSync(requestsDir(home)) &&
        fs.readdirSync(requestsDir(home)).length > 0,
    ).toBe(false);
  });

  it('refuses a count outside 1..8 before writing anything', async () => {
    const home = tempHome();
    fs.mkdirSync(path.dirname(verbsScriptPath(home)), { recursive: true });
    fs.writeFileSync(verbsScriptPath(home), renderVerbScript());

    const result = await runCli(home, ['fork', '--count', '50'], {
      LINEAGE_NODE_ID: SID,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--count');
  });
});
