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
// catch it drifting from the watcher's protocol is one that executes it. Under
// `process.execPath` and not the shebang: a `#!` line is a POSIX kernel
// feature, and Windows would refuse the file. The temp home is spelled to the
// child as both HOME and USERPROFILE, for the reason `cliEnv` gives.

import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as process from 'node:process';

import {
  AgentVerbsManager,
  ENV_VERB_TOKEN,
  MAX_AGENT_FORKS,
  MAX_AGENT_PROMPT_CHARS,
  MAX_AGENT_TITLE_CHARS,
  VERBS_VERSION,
  adoptVerbToken,
  clampForkCount,
  ensureVerbToken,
  fallbackHome,
  parseRequestText,
  renderSkillMd,
  renderVerbScript,
  requestsDir,
  verbTokenVerdict,
  verbsScriptPath,
  verbsSkillDir,
} from '../src/agentVerbs';
import { setLogSink } from '../src/log';
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
const OTHER_SID = '0f0000d1-0000-4000-8000-0000000000d1';
const REQ_ID = '11111111-2222-4333-8444-555555555555';

/** The launch token this "window" holds for a session — the same call
 *  terminals.launch() makes when it stamps the session's environment, and
 *  idempotent, so asking again is asking for the value that was stamped.
 *  A test that wants a session Flock never launched simply never calls it. */
const tokenFor = (sessionId: string): string => ensureVerbToken(sessionId);

/** A well-formed token that belongs to nobody. */
const STRANGER_TOKEN = 'c0ffee'.padEnd(64, '0');

/** A valid v2 fork request for `node`, with the proof in it. */
function forkRequest(
  over: Record<string, unknown> = {},
  node: string = SID,
): Record<string, unknown> {
  return {
    v: 2,
    verb: 'fork',
    node,
    token: tokenFor(node),
    count: 1,
    ...over,
  };
}

/** Mode bits are a POSIX idea; on Windows Node reports 0666/0444 whatever
 *  the ACL says, so the permission tests have nothing to measure there. */
const onPosix = process.platform === 'win32' ? it.skip : it;

function modeOf(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

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
  fs.writeFileSync(path.join(dir, 'SKILL.md'), renderSkillMd(verbsScriptPath(home)));
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
    const parsed = parseRequestText(JSON.stringify(forkRequest({ count: 3 })));
    expect(parsed).toEqual({
      verb: 'fork',
      node: SID,
      token: tokenFor(SID),
      count: 3,
    });
  });

  it('carries the prompt through', () => {
    const parsed = parseRequestText(
      JSON.stringify(forkRequest({ prompt: 'go' })),
    );
    expect(parsed).toEqual({
      verb: 'fork',
      node: SID,
      token: tokenFor(SID),
      count: 1,
      prompt: 'go',
    });
  });

  it('rejects junk, wrong versions, unknown verbs and missing sessions', () => {
    expect(parseRequestText('not json')).toHaveProperty('error');
    expect(parseRequestText('[1,2]')).toHaveProperty('error');
    expect(
      parseRequestText(JSON.stringify(forkRequest({ v: 3 }))),
    ).toHaveProperty('error');
    expect(
      parseRequestText(JSON.stringify(forkRequest({ verb: 'merge' }))),
    ).toHaveProperty('error');
    expect(
      parseRequestText(JSON.stringify(forkRequest({ node: 'nope' }))),
    ).toHaveProperty('error');
  });

  it('rejects v1: a CLI that old cannot have carried a token', () => {
    // The whole v4 wire format, which is now exactly the request a forger
    // would hand-write. Refused by VERSION, so "no token" below means one
    // thing only.
    const parsed = parseRequestText(
      JSON.stringify({ v: 1, verb: 'fork', node: SID, count: 3 }),
    );
    expect(parsed).toEqual({ error: 'unknown request version' });
  });

  it('refuses a request with no launch token, or a malformed one', () => {
    // The identity check v4 had was `isSessionId(node)` and nothing else —
    // i.e. anything that could type a uuid could name any session on the
    // machine. A name is not a proof.
    const without = { ...forkRequest() };
    delete without['token'];
    expect(parseRequestText(JSON.stringify(without))).toEqual({
      error:
        'the request carries no launch token — only a session Flock started ' +
        'can ask Flock to fork it',
    });
    for (const bad of ['', 'nope', 'A'.repeat(64), 'ab', 7, null, {}]) {
      expect(
        parseRequestText(JSON.stringify(forkRequest({ token: bad }))),
        JSON.stringify(bad),
      ).toHaveProperty('error');
    }
  });

  it('clamps the count instead of refusing it', () => {
    const at = (count: unknown) =>
      parseRequestText(JSON.stringify(forkRequest({ count })));
    expect(at(0)).toMatchObject({ count: 1 });
    expect(at(999)).toMatchObject({ count: MAX_AGENT_FORKS });
    expect(at('three')).toMatchObject({ count: 1 });
    expect(at(undefined)).toMatchObject({ count: 1 });
    expect(at(3.7)).toMatchObject({ count: 3 });
  });

  it('carries fork names through, trimmed', () => {
    const parsed = parseRequestText(
      JSON.stringify(
        forkRequest({ count: 2, titles: [' redis cache ', 'SQL approach'] }),
      ),
    );
    expect(parsed).toEqual({
      verb: 'fork',
      node: SID,
      token: tokenFor(SID),
      count: 2,
      titles: ['redis cache', 'SQL approach'],
    });
  });

  it('refuses names that do not line up one-per-fork', () => {
    const at = (count: number, titles: unknown) =>
      parseRequestText(JSON.stringify(forkRequest({ count, titles })));
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
      parseRequestText(JSON.stringify(forkRequest({ prompt: long }))),
    ).toHaveProperty('error');
    expect(
      parseRequestText(JSON.stringify(forkRequest({ prompt: 7 }))),
    ).toHaveProperty('error');
  });
});

describe('verbTokenVerdict', () => {
  it('vouches for a session this window launched, and for nothing else', () => {
    const launched = '0f0000b1-0000-4000-8000-0000000000b1';
    const never = '0f0000b2-0000-4000-8000-0000000000b2';
    const token = tokenFor(launched);

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(verbTokenVerdict(launched, token)).toBe('ok');
    // The attack this exists for: a session that knows ITS token and another
    // session's id (they are listed by `claude agents --json`).
    expect(verbTokenVerdict(launched, tokenFor(never))).toBe('mismatch');
    expect(verbTokenVerdict(launched, STRANGER_TOKEN)).toBe('mismatch');
    expect(verbTokenVerdict(launched, undefined)).toBe('mismatch');
    expect(verbTokenVerdict(launched, token.toUpperCase())).toBe('mismatch');
    // A session this window never launched: no opinion, so the watcher
    // leaves the request alone rather than answering for another window.
    const unknown = '0f0000b3-0000-4000-8000-0000000000b3';
    expect(verbTokenVerdict(unknown, STRANGER_TOKEN)).toBe('unknown');
  });

  it('adopts a token once — a second source of truth never overwrites it', () => {
    // The window-reload path (terminals.bind) re-learns a token from a
    // revived terminal's creationOptions. The live process holds the fact, so
    // the first value in wins and anything shaped wrong is ignored.
    const adopted = '0f0000b4-0000-4000-8000-0000000000b4';
    adoptVerbToken(adopted, 'not a token');
    expect(verbTokenVerdict(adopted, 'not a token')).toBe('unknown');
    adoptVerbToken(adopted, STRANGER_TOKEN);
    expect(verbTokenVerdict(adopted, STRANGER_TOKEN)).toBe('ok');
    adoptVerbToken(adopted, 'd'.repeat(64));
    expect(verbTokenVerdict(adopted, 'd'.repeat(64))).toBe('mismatch');
    // And nothing is remembered for a name that is not a session id.
    adoptVerbToken('nope', STRANGER_TOKEN);
    expect(verbTokenVerdict('nope', STRANGER_TOKEN)).toBe('unknown');
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

describe('fallbackHome', () => {
  it('names the variable each platform really keeps a home in', () => {
    // Reached only when os.homedir() itself fails — but when it is reached it
    // has to answer with the directory the rest of the extension already
    // resolved. The platform is a parameter, so the win32 branch runs on macOS
    // CI and the POSIX branch on Windows CI.
    expect(
      fallbackHome({ HOME: '/Users/a', USERPROFILE: 'C:\\Users\\a' }, 'darwin'),
    ).toBe('/Users/a');
    // HOME on Windows is Git Bash's invention: a POSIX-shaped path, sometimes
    // a different directory entirely. os.homedir() there reads USERPROFILE, so
    // the fallback must too — a CLI and a window that disagree about home
    // disagree about ~/.lineage/requests, and nothing is ever claimed.
    expect(
      fallbackHome({ HOME: '/c/Users/a', USERPROFILE: 'C:\\Users\\a' }, 'win32'),
    ).toBe('C:\\Users\\a');
    expect(
      fallbackHome({ HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\a' }, 'win32'),
    ).toBe(path.win32.join('C:', '\\Users\\a'));
    expect(fallbackHome({ HOME: '/c/Users/a' }, 'win32')).toBe('.');
    expect(fallbackHome({}, 'linux')).toBe('.');
  });
});

// ------------------------------------------------------- the rendered files

describe('the rendered files', () => {
  it('the skill teaches the CLI invocation and carries our marker', () => {
    const skill = renderSkillMd('/home/u/.lineage/flock-verbs.mjs');
    expect(skill).toContain('name: flock');
    expect(skill).toContain('flock-verbs.mjs" fork');
    expect(skill).toContain('Flock VS Code extension');
  });

  it('names the CLI by its absolute, quoted path — never a tilde', () => {
    // A tilde is the shell's to expand, and PowerShell and cmd.exe — the shells
    // Claude Code runs the Bash tool through on a Windows without Git — do
    // not. The path the extension wrote the script to is right by
    // construction, and double quotes are the one spelling every shell reads.
    const posix = renderSkillMd('/Users/a b/.lineage/flock-verbs.mjs');
    expect(posix).toContain('node "/Users/a b/.lineage/flock-verbs.mjs" fork --count <n>');
    expect(posix).not.toContain('~/');
    const win = renderSkillMd('C:\\Users\\a b\\.lineage\\flock-verbs.mjs');
    expect(win).toContain('node "C:\\Users\\a b\\.lineage\\flock-verbs.mjs" fork');
  });

  it('the CLI enforces the same caps the watcher does', () => {
    const script = renderVerbScript();
    expect(script).toContain('Flock VS Code extension');
    expect(script).toContain(String(MAX_AGENT_FORKS));
    expect(script).toContain(String(MAX_AGENT_PROMPT_CHARS));
    expect(script).toContain('LINEAGE_NODE_ID');
    expect(script).toContain("'.lineage', 'requests'");
  });

  it('v4: the CLI creates the requests directory 0700 and the request file 0600', () => {
    // The request carries --prompt, the user's own words. "the rendered CLI"
    // below runs the script and measures the modes it actually leaves.
    const script = renderVerbScript();
    expect(script).toContain('fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });');
    expect(script).toContain("{ mode: 0o600 });");
    expect(VERBS_VERSION).toBeGreaterThanOrEqual(4);
  });

  it('v5: the CLI reads the launch token and puts it in a v2 request', () => {
    // The rendered CLI is the only place the token can come from — it is a
    // generated artifact, so a bump has to rewrite installed copies (the
    // selfHeal tests above are what make that true).
    const script = renderVerbScript();
    expect(script).toContain(ENV_VERB_TOKEN);
    expect(script).toContain('token: proof.token');
    expect(script).toContain('v: 2');
    // And it never prints the thing: the only mention is the read and the
    // assignment into the body.
    expect(script.match(/LINEAGE_VERB_TOKEN/g)).toHaveLength(1);
    expect(script).not.toContain('console.log(proof');
    expect(VERBS_VERSION).toBeGreaterThanOrEqual(5);
  });

  it('pins the rendered artifacts to the version, so text cannot change without a bump', () => {
    // WHY A FINGERPRINT. The two assertions above are floors
    // (`toBeGreaterThanOrEqual`), which is right for "v4's mode arguments are
    // still there" but does not do the job the version exists for: the CLI and
    // the skill are files written into the user's home, and `selfHeal` rewrites
    // an installed copy only when the STORED version is older than
    // VERBS_VERSION. Change the rendered text without bumping and every
    // existing install keeps running the old script for ever, silently — the
    // failure this suite cannot otherwise see.
    //
    // So: any edit to either artifact changes this hash and fails here. Bump
    // VERBS_VERSION and update both constants in the same commit, which is the
    // whole point — the two facts move together or the test says so.
    const fingerprint = createHash('sha256')
      .update(renderVerbScript())
      .update(renderSkillMd('/home/u/.lineage/flock-verbs.mjs'))
      .digest('hex');
    expect({ version: VERBS_VERSION, fingerprint }).toEqual({
      version: 6,
      fingerprint: '563db0743df47c7077a4971f7fb068bcd7d2c162124b3d47cc3444197e0d44d6',
    });
  });

  it('v5: the skill tells the model the verb needs a Flock-launched session', () => {
    const skill = renderSkillMd('/home/u/.lineage/flock-verbs.mjs');
    expect(skill).toContain('only works in a session Flock itself launched');
    // Never the variable name, and never a way to fish for the value.
    expect(skill).not.toContain(ENV_VERB_TOKEN);
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
  onPosix('creates the requests directory private to the user, and tightens one that is not', async () => {
    // Fresh home: mkdir without a mode would give 0755 under the usual 022.
    const fresh = tempHome();
    makeManager(fresh).manager.startWatcher(makeExecutor({ bound: true }).executor);
    expect(modeOf(requestsDir(fresh))).toBe(0o700);

    // What a v3 CLI left behind: a 0755 directory. The watcher chmods it.
    const loose = tempHome();
    fs.mkdirSync(requestsDir(loose), { recursive: true, mode: 0o755 });
    fs.chmodSync(requestsDir(loose), 0o755);
    expect(modeOf(requestsDir(loose))).toBe(0o755);
    makeManager(loose).manager.startWatcher(makeExecutor({ bound: true }).executor);
    expect(modeOf(requestsDir(loose))).toBe(0o700);
  });

  it('runs a request and writes the reply the CLI is polling for', async () => {
    const home = tempHome();
    const { manager } = makeManager(home);
    const { executor, calls } = makeExecutor({ bound: true });
    manager.startWatcher(executor);

    writeRequest(
      home,
      forkRequest({ count: 2, prompt: 'start with the tests' }),
    );
    expect(await until(() => fs.existsSync(replyPath(home)))).toBe(true);

    // The token stopped at the watcher: the executor runs the fork and never
    // holds the secret.
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
    // Hosting decides claim PRIORITY, holding the launch token decides
    // eligibility — a window that launched a session it no longer hosts (it
    // was parked, or its tab was closed) still answers for it.
    const home = tempHome();
    const { manager } = makeManager(home, { claimDelayMs: 30 });
    const { executor, calls } = makeExecutor({ bound: false });
    manager.startWatcher(executor);

    writeRequest(home, forkRequest());
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

    writeRequest(home, forkRequest({ count: 3 }));
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
    const file = writeRequest(home, forkRequest());
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

    writeRequest(home, forkRequest());
    expect(await until(() => fs.existsSync(replyPath(home)))).toBe(true);
    const reply = readReply(home);
    expect(reply.ok).toBe(false);
    expect(reply.error).toBe('no transcript');
  });
});

// ------------------------------------------------- provenance (v5)

describe('a fork request must prove it came from the session it names', () => {
  // THE HOLE this closes: ~/.lineage/requests is writable by anything running
  // as this user, session ids are discoverable (`claude agents --json`), and
  // v4 checked only that `node` was uuid-SHAPED. So one Bash step, sub-agent
  // or MCP server inside session A could ask for eight forks of session B
  // with an opening prompt of its choosing — and the verb forks quietly.
  //
  // Every case below writes the request file directly, which is exactly what
  // the attacker can do; the difference is only ever what is inside it.

  afterEach(() => setLogSink(null));

  it('the right token forks', async () => {
    const home = tempHome();
    const { manager } = makeManager(home);
    const { executor, calls } = makeExecutor({ bound: true });
    manager.startWatcher(executor);

    writeRequest(home, forkRequest({ count: 2 }));
    expect(await until(() => fs.existsSync(replyPath(home)))).toBe(true);
    expect(calls).toHaveLength(1);
    expect(readReply(home).ok).toBe(true);
  });

  it('refuses a request with no token at all', async () => {
    const home = tempHome();
    const { manager } = makeManager(home, { claimDelayMs: 10 });
    const { executor, calls } = makeExecutor({ bound: true });
    manager.startWatcher(executor);

    const body = { ...forkRequest({ count: 8 }) };
    delete body['token'];
    writeRequest(home, body);

    expect(await until(() => fs.existsSync(replyPath(home)))).toBe(true);
    expect(calls).toHaveLength(0);
    const reply = readReply(home);
    expect(reply.ok).toBe(false);
    expect(String(reply.error)).toContain('no launch token');
  });

  it('refuses a made-up token for a session it did launch', async () => {
    const home = tempHome();
    const { manager } = makeManager(home, { claimDelayMs: 10 });
    const { executor, calls } = makeExecutor({ bound: true });
    tokenFor(SID); // this window launched it, so it has an opinion
    manager.startWatcher(executor);

    writeRequest(home, forkRequest({ token: STRANGER_TOKEN }));

    expect(await until(() => fs.existsSync(replyPath(home)))).toBe(true);
    expect(calls).toHaveLength(0);
    const reply = readReply(home);
    expect(reply.ok).toBe(false);
    // Worded for the BENIGN cause it usually is — another window re-attached
    // the terminal, so the running process still holds that window's token —
    // and pointing at the one thing that fixes it. Not an accusation: this
    // window's evidence is that the token is not the one IT stamped, which is
    // not evidence that nobody stamped it.
    expect(String(reply.error)).toContain('re-attached by another Flock window');
    expect(String(reply.error)).toContain('relaunch');
  });

  // THE REFUSAL MUST NOT RACE THE WINDOW THAT CAN HONOUR THE REQUEST. Every
  // other error verdict (too large, expired, malformed) is one every window
  // reaches identically, so arming it at the claim delay is harmless. A
  // MISMATCH is window-DEPENDENT: after a park and restore by a second window,
  // that window minted its own token for the session while the running process
  // still holds the launching window's — so it holds the WRONG token and would
  // otherwise arm a refusal at exactly the delay the window with the RIGHT
  // token uses. The refusal renames and deletes the file, so winning that race
  // turns a genuine self-fork into an intermittent accusation.
  //
  // The token table is module scope — one per extension host, which is what
  // makes it private to a window — so two windows cannot be modelled in one
  // process. What is pinned instead is the ORDERING that makes the race
  // unloseable: a claimable request always gets its answer before a mismatched
  // one gets its refusal, however slow the machine is.
  it('arms a mismatch refusal strictly after any claim could land', async () => {
    const home = tempHome();
    const { manager } = makeManager(home, { claimDelayMs: 120 });
    const { executor, calls } = makeExecutor({ bound: true });
    tokenFor(SID); // this window launched SID, so it has an opinion
    manager.startWatcher(executor);

    const MISMATCH = '33333333-3333-4333-8444-555555555555';
    // The mismatched one FIRST, so it has every advantage.
    writeRequest(home, forkRequest({ token: STRANGER_TOKEN }), MISMATCH);
    writeRequest(home, forkRequest({}, OTHER_SID));

    // The honourable request is answered...
    expect(await until(() => fs.existsSync(replyPath(home)))).toBe(true);
    expect(calls).toHaveLength(1);
    // ...while the refusal is still waiting out its longer delay, even though
    // its file was written first.
    expect(fs.existsSync(replyPath(home, MISMATCH))).toBe(false);
    // And it does land eventually — a mismatch gets an answer, not a timeout.
    expect(await until(() => fs.existsSync(replyPath(home, MISMATCH)))).toBe(
      true,
    );
    expect(readReply(home, MISMATCH).ok).toBe(false);
  });

  it('refuses a token that belongs to a DIFFERENT session', async () => {
    // The whole attack in one line: session OTHER_SID holds its own token
    // (it inherited it, legitimately), and names SID in the request.
    const home = tempHome();
    const { manager } = makeManager(home, { claimDelayMs: 10 });
    const { executor, calls } = makeExecutor({ bound: true });
    manager.startWatcher(executor);

    writeRequest(
      home,
      forkRequest({ token: tokenFor(OTHER_SID), count: MAX_AGENT_FORKS }),
    );

    expect(await until(() => fs.existsSync(replyPath(home)))).toBe(true);
    expect(calls).toHaveLength(0);
    expect(readReply(home).ok).toBe(false);
  });

  it('a session no window launched is left alone, not answered', async () => {
    // This window cannot tell a real request from a forged one for a session
    // it never launched — another window may hold that token — so it claims
    // nothing. Nobody answering is what the CLI's 30-second withdrawal is
    // for, and it reports exactly that.
    const home = tempHome();
    const NEVER = '0f0000f1-0000-4000-8000-0000000000f1';
    const { manager } = makeManager(home, { claimDelayMs: 10 });
    const { executor, calls } = makeExecutor({ bound: true });
    manager.startWatcher(executor);

    const file = writeRequest(home, {
      v: 2,
      verb: 'fork',
      node: NEVER,
      token: STRANGER_TOKEN,
      count: 3,
    });

    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(replyPath(home))).toBe(false);
    expect(fs.existsSync(file)).toBe(true); // still there for its own window
  });

  it('says it once, not once per tick, about a request it left alone', async () => {
    // The file it declined to claim stays in the directory for up to the
    // CLI's 30 seconds, and the fallback tick re-reads the directory every
    // couple of seconds. One line, then silence.
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    const home = tempHome();
    const NEVER = '0f0000f2-0000-4000-8000-0000000000f2';
    const { manager } = makeManager(home, { claimDelayMs: 10, fallbackMs: 20 });
    manager.startWatcher(makeExecutor({ bound: true }).executor);

    writeRequest(home, {
      v: 2,
      verb: 'fork',
      node: NEVER,
      token: STRANGER_TOKEN,
      count: 1,
    });
    await new Promise((r) => setTimeout(r, 220));

    expect(
      lines.filter((l) => l.includes('no launch token here')),
    ).toHaveLength(1);
  });

  it('never writes a token to the log, the reply or a message', async () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    const home = tempHome();
    const { manager } = makeManager(home, { claimDelayMs: 10 });
    const { executor } = makeExecutor({ bound: true });
    manager.startWatcher(executor);

    // One honoured request and one refused one, so both paths are covered.
    writeRequest(home, forkRequest({ prompt: 'go' }));
    expect(await until(() => fs.existsSync(replyPath(home)))).toBe(true);
    const goodReply = fs.readFileSync(replyPath(home), 'utf8');

    const second = '22222222-2222-4333-8444-555555555555';
    writeRequest(home, forkRequest({ token: STRANGER_TOKEN }), second);
    expect(await until(() => fs.existsSync(replyPath(home, second)))).toBe(
      true,
    );
    const badReply = fs.readFileSync(replyPath(home, second), 'utf8');

    const log = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0); // the sink is really installed
    // It did explain — and the line says what this window can actually see
    // ("not the token stamped here") rather than pronouncing a forgery.
    expect(log).toContain('does not carry the token stamped here');
    for (const secret of [tokenFor(SID), STRANGER_TOKEN]) {
      expect(log).not.toContain(secret);
      expect(goodReply).not.toContain(secret);
      expect(badReply).not.toContain(secret);
    }
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
    sendTextToSession: () => 'no-terminal',
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
    markSeen: async () => undefined,
    notificationsEnabled: () => false,
    setOnlyActiveSessions: async () => undefined,
    setAccountsSection: async () => undefined,
    setShellsSection: async () => undefined,
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
  /** Every test here spawns a real node; a cold Windows runner can spend a
   *  second or two on the first one, and vitest's 5 s default turns that into
   *  an opaque timeout instead of the assertion that actually failed. `until`
   *  still gives up at 8 s, well inside this. */
  const CLI_TIMEOUT_MS = 20_000;

  /** A launch token as the extension would have stamped it: 32 bytes of hex.
   *  Spelled out rather than minted so the assertions can name the value the
   *  child is expected to copy into its request. */
  const CLI_TOKEN = 'ab'.repeat(32);

  /** The environment a Flock-launched session gives the CLI: the node id and
   *  the proof, which is the only pair the CLI accepts. */
  const inSession = (): Record<string, string> => ({
    LINEAGE_NODE_ID: SID,
    [ENV_VERB_TOKEN]: CLI_TOKEN,
  });

  /** The env the CLI child runs with. Minimal ON PURPOSE: the test runner may
   *  itself live inside tmux or a Flock terminal, and inheriting that env
   *  would hand the script an identity the test did not choose.
   *
   *  The home is spelled BOTH ways because os.homedir() — what the CLI builds
   *  ~/.lineage/requests from — reads HOME on POSIX and USERPROFILE on
   *  Windows, where it ignores HOME entirely and falls back to the account's
   *  real profile directory rather than to it. Setting only HOME therefore
   *  leaves a Windows CLI writing its request under C:\\Users\\<you> while the
   *  test watches the temp home: nothing arrives, and the test dies waiting
   *  out the CLI's 30-second poll. SystemRoot and SystemDrive ride along for
   *  the same reason in reverse — they describe the OS, not the session, and
   *  "minimal" here means no identity, not no Windows. */
  function cliEnv(
    home: string,
    extra: Record<string, string> = {},
  ): Record<string, string> {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      USERPROFILE: home,
    };
    for (const key of ['SystemRoot', 'SystemDrive'] as const) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    return { ...env, ...extra };
  }

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
        { env: cliEnv(home, env) },
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

  it('gives the child the temp home THIS platform resolves to', async () => {
    // The one fact every test below stands on: the home the harness hands the
    // CLI is the home os.homedir() gives it back. HOME alone is not that fact
    // on Windows — libuv reads USERPROFILE there — so the env spells both, and
    // a real child says which directory that lands in.
    const home = tempHome();
    expect(cliEnv(home)).toMatchObject({ HOME: home, USERPROFILE: home });

    // A probe script rather than `node -p`: an argument is quoted by the OS on
    // its way into the child, and a file path is the one form both agree on.
    const probe = path.join(home, 'homedir-probe.mjs');
    fs.writeFileSync(
      probe,
      "import * as os from 'node:os';\nprocess.stdout.write(os.homedir());\n",
    );
    const resolved = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [probe],
        { env: cliEnv(home) },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });
    expect(resolved).toBe(home);
  }, CLI_TIMEOUT_MS);

  it('writes the request, waits for the reply, and reports the branches', async () => {
    const home = tempHome();
    fs.mkdirSync(path.dirname(verbsScriptPath(home)), { recursive: true });
    fs.writeFileSync(verbsScriptPath(home), renderVerbScript());

    const done = runCli(
      home,
      ['fork', '--count', '2', '--prompt', 'hello'],
      inSession(),
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
      v: 2,
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
  }, CLI_TIMEOUT_MS);

  onPosix('v4: leaves the request readable by this user alone', async () => {
    const home = tempHome();
    fs.mkdirSync(path.dirname(verbsScriptPath(home)), { recursive: true });
    fs.writeFileSync(verbsScriptPath(home), renderVerbScript());

    const done = runCli(
      home,
      ['fork', '--prompt', 'the plan nobody else should read'],
      inSession(),
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
    // The CLI created both under the child process's own umask (022 on any
    // ordinary machine); without explicit modes they would be 0755 and 0644.
    expect(modeOf(dir)).toBe(0o700);
    expect(modeOf(path.join(dir, reqName))).toBe(0o600);

    // Let it finish, so the test does not wait out the CLI's 30 s.
    fs.writeFileSync(
      path.join(dir, reqName.replace(/\.json$/, '.reply.json')),
      JSON.stringify({ ok: true, forked: [SID], titles: ['fork 2'] }),
    );
    expect((await done).code).toBe(0);
  }, CLI_TIMEOUT_MS);

  it('relays a refusal and exits nonzero', async () => {
    const home = tempHome();
    fs.mkdirSync(path.dirname(verbsScriptPath(home)), { recursive: true });
    fs.writeFileSync(verbsScriptPath(home), renderVerbScript());

    const done = runCli(home, ['fork'], inSession());
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
  }, CLI_TIMEOUT_MS);

  it('says so when the environment names no Flock launch at all', async () => {
    const home = tempHome();
    fs.mkdirSync(path.dirname(verbsScriptPath(home)), { recursive: true });
    fs.writeFileSync(verbsScriptPath(home), renderVerbScript());

    const result = await runCli(home, ['fork'], {});
    expect(result.code).toBe(1);
    // NOT "Flock did not launch this session", which is false for the three
    // commonest ways a live session loses its stamp — running when the
    // extension updated, revived after an app restart, re-attached in another
    // window — and which the model relays to the user as fact.
    expect(result.stderr).toContain('no Flock launch stamp');
    expect(result.stderr).toContain('relaunched from the Flock sidebar');
    expect(result.stderr).not.toContain('Flock did not launch this session');
    // And it left no request behind for a window to trip over later.
    expect(
      fs.existsSync(requestsDir(home)) &&
        fs.readdirSync(requestsDir(home)).length > 0,
    ).toBe(false);
  }, CLI_TIMEOUT_MS);

  it('names imply the count, and land in the request as titles', async () => {
    const home = tempHome();
    fs.mkdirSync(path.dirname(verbsScriptPath(home)), { recursive: true });
    fs.writeFileSync(verbsScriptPath(home), renderVerbScript());

    const done = runCli(
      home,
      ['fork', '--name', 'redis cache', '--name', 'SQL approach'],
      inSession(),
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
  }, CLI_TIMEOUT_MS);

  it('refuses a name/count mismatch before writing anything', async () => {
    const home = tempHome();
    fs.mkdirSync(path.dirname(verbsScriptPath(home)), { recursive: true });
    fs.writeFileSync(verbsScriptPath(home), renderVerbScript());

    const result = await runCli(
      home,
      ['fork', '--count', '3', '--name', 'only one'],
      inSession(),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('one --name per fork');
    expect(
      fs.existsSync(requestsDir(home)) &&
        fs.readdirSync(requestsDir(home)).length > 0,
    ).toBe(false);
  }, CLI_TIMEOUT_MS);

  it('refuses a count outside 1..8 before writing anything', async () => {
    const home = tempHome();
    fs.mkdirSync(path.dirname(verbsScriptPath(home)), { recursive: true });
    fs.writeFileSync(verbsScriptPath(home), renderVerbScript());

    const result = await runCli(home, ['fork', '--count', '50'], inSession());
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--count');
  }, CLI_TIMEOUT_MS);

  it('v5: writes the launch token it was given, and nothing else', async () => {
    const home = tempHome();
    fs.mkdirSync(path.dirname(verbsScriptPath(home)), { recursive: true });
    fs.writeFileSync(verbsScriptPath(home), renderVerbScript());

    const done = runCli(home, ['fork', '--count', '2'], inSession());
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
    // The proof, copied verbatim out of the environment the launch stamped,
    // on the version of the wire that carries it.
    expect(body).toMatchObject({ v: 2, node: SID, token: CLI_TOKEN });

    fs.writeFileSync(
      path.join(dir, reqName.replace(/\.json$/, '.reply.json')),
      JSON.stringify({ ok: true, forked: [SID, SID], titles: ['a', 'b'] }),
    );
    const result = await done;
    expect(result.code).toBe(0);
    // Not into the terminal, and not into the transcript: whatever the CLI
    // says about the fork, it never says the secret.
    expect(result.stdout).not.toContain(CLI_TOKEN);
    expect(result.stderr).not.toContain(CLI_TOKEN);
  }, CLI_TIMEOUT_MS);

  it('v5: refuses to write a request when the environment has no token', async () => {
    // A session Flock did not launch — or one launched by a Flock older than
    // this build. v4 wrote the request anyway (it only needed an id), and the
    // extension would now refuse it; dying here with the reason beats a
    // 30-second wait for that refusal.
    const home = tempHome();
    fs.mkdirSync(path.dirname(verbsScriptPath(home)), { recursive: true });
    fs.writeFileSync(verbsScriptPath(home), renderVerbScript());

    const envs: Array<Record<string, string>> = [
      { LINEAGE_NODE_ID: SID }, // id, no proof
      { LINEAGE_NODE_ID: SID, [ENV_VERB_TOKEN]: 'not-a-token' },
      { [ENV_VERB_TOKEN]: CLI_TOKEN }, // proof, no id
      { CLAUDE_SESSION_ID: SID }, // v4 accepted this one on its own
    ];
    for (const env of envs) {
      const result = await runCli(home, ['fork'], env);
      expect(result.code, JSON.stringify(env)).toBe(1);
      expect(result.stderr).toContain('no Flock launch stamp');
      expect(result.stderr).not.toContain('Flock did not launch this session');
      expect(
        fs.existsSync(requestsDir(home)) &&
          fs.readdirSync(requestsDir(home)).length > 0,
        'it left a request behind',
      ).toBe(false);
    }
  }, CLI_TIMEOUT_MS);
});
