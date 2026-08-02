// test/terminals.test.ts — owner D. SPEC.md §9: "pure parts only".
//
// The vscode mock exposes an empty `window`/`commands`, which doubles as the
// worst-case host: every registry method must degrade to a logged no-op rather
// than throw. That is asserted here too, since "degrade, never break" is a
// hard requirement of §4-D.

import { afterEach, describe, expect, it } from 'vitest';
import * as vscodeMock from 'vscode';

import {
  TerminalRegistry,
  buildShellArgs,
  defaultTerminalName,
  launchEnv,
  locationValueOf,
  mintSessionId,
  nodeIdOfTerminal,
} from '../src/terminals';
import { ENV_NODE_ID, SESSION_ID_RE } from '../src/types';

const CHILD = '0f0000c1-0000-4000-8000-0000000000c1';
const PARENT = '0f0000a1-0000-4000-8000-0000000000a1';

describe('buildShellArgs', () => {
  it('mints a root session with just --session-id', () => {
    expect(buildShellArgs({ sessionId: CHILD })).toEqual([
      '--session-id',
      CHILD,
    ]);
  });

  it('prepends the full fork form when a parent is known', () => {
    expect(buildShellArgs({ sessionId: CHILD, parentId: PARENT })).toEqual([
      '--fork-session',
      '--resume',
      PARENT,
      '--session-id',
      CHILD,
    ]);
  });

  it('appends a prompt as the final positional argument', () => {
    expect(buildShellArgs({ sessionId: CHILD, prompt: 'do the thing' })).toEqual(
      ['--session-id', CHILD, 'do the thing'],
    );
  });

  it('orders fork flags, session id and prompt correctly together', () => {
    expect(
      buildShellArgs({
        sessionId: CHILD,
        parentId: PARENT,
        prompt: 'do the thing',
      }),
    ).toEqual([
      '--fork-session',
      '--resume',
      PARENT,
      '--session-id',
      CHILD,
      'do the thing',
    ]);
  });

  it('ignores an empty or whitespace-only prompt', () => {
    expect(buildShellArgs({ sessionId: CHILD, prompt: '' })).toEqual([
      '--session-id',
      CHILD,
    ]);
    expect(buildShellArgs({ sessionId: CHILD, prompt: '   \n' })).toEqual([
      '--session-id',
      CHILD,
    ]);
  });

  it('ignores an empty parentId rather than emitting a bare --resume', () => {
    expect(buildShellArgs({ sessionId: CHILD, parentId: '' })).toEqual([
      '--session-id',
      CHILD,
    ]);
  });

  // ------------------------------------------------------- resume (M1.5)

  it('resumes with --resume ONLY — never also --session-id', () => {
    // Passing --session-id too would ask claude to both keep and replace the
    // id. (The CLI may re-mint the id anyway — M10's chains absorb that; the
    // argv shape here stays the same either way.)
    expect(buildShellArgs({ sessionId: PARENT, resumeId: PARENT })).toEqual([
      '--resume',
      PARENT,
    ]);
  });

  it('appends a prompt after the resume form', () => {
    expect(
      buildShellArgs({ sessionId: PARENT, resumeId: PARENT, prompt: 'go on' }),
    ).toEqual(['--resume', PARENT, 'go on']);
  });

  it('resume wins over fork when both are somehow set', () => {
    expect(
      buildShellArgs({ sessionId: CHILD, resumeId: PARENT, parentId: CHILD }),
    ).toEqual(['--resume', PARENT]);
  });

  it('ignores an empty resumeId and falls back to the mint form', () => {
    expect(buildShellArgs({ sessionId: CHILD, resumeId: '' })).toEqual([
      '--session-id',
      CHILD,
    ]);
  });

  // ------------------------------------------------------- chat (M16)

  it('emits --add-dir BEFORE the mode flags, because it is variadic', () => {
    // --add-dir consumes every following bare word. Emitted last it would eat
    // whatever came after it; emitted first, --session-id terminates it.
    expect(
      buildShellArgs({ sessionId: CHILD, addDirs: ['/a', '/b'] }),
    ).toEqual(['--add-dir', '/a', '/b', '--session-id', CHILD]);
  });

  it('leaves the prompt as the last argument, unabsorbed by --add-dir', () => {
    expect(
      buildShellArgs({
        sessionId: CHILD,
        addDirs: ['/a'],
        prompt: 'do the thing',
      }),
    ).toEqual(['--add-dir', '/a', '--session-id', CHILD, 'do the thing']);
  });

  it('emits --add-dir before the resume form too', () => {
    expect(
      buildShellArgs({ sessionId: PARENT, resumeId: PARENT, addDirs: ['/a'] }),
    ).toEqual(['--add-dir', '/a', '--resume', PARENT]);
  });

  it('emits --name and --append-system-prompt after the mode flags', () => {
    expect(
      buildShellArgs({
        sessionId: CHILD,
        sessionName: 'Chat · demo',
        appendSystemPrompt: 'you are in a chat window',
      }),
    ).toEqual([
      '--session-id',
      CHILD,
      '--name',
      'Chat · demo',
      '--append-system-prompt',
      'you are in a chat window',
    ]);
  });

  it('orders every chat flag together, prompt still last', () => {
    expect(
      buildShellArgs({
        sessionId: CHILD,
        addDirs: ['/a', '/b'],
        sessionName: 'Chat · demo',
        appendSystemPrompt: 'sys',
        prompt: 'hi',
      }),
    ).toEqual([
      '--add-dir',
      '/a',
      '/b',
      '--session-id',
      CHILD,
      '--name',
      'Chat · demo',
      '--append-system-prompt',
      'sys',
      'hi',
    ]);
  });

  it('emits nothing for empty or whitespace-only chat options', () => {
    expect(
      buildShellArgs({
        sessionId: CHILD,
        addDirs: [],
        sessionName: '',
        appendSystemPrompt: '   ',
      }),
    ).toEqual(['--session-id', CHILD]);
    expect(
      buildShellArgs({ sessionId: CHILD, addDirs: ['', '  \n'] }),
    ).toEqual(['--session-id', CHILD]);
  });
});

describe('mintSessionId', () => {
  it('produces session-id-shaped uuids', () => {
    expect(SESSION_ID_RE.test(mintSessionId())).toBe(true);
  });

  it('is unique across 100 mints', () => {
    const ids = new Set(Array.from({ length: 100 }, () => mintSessionId()));
    expect(ids.size).toBe(100);
  });
});

describe('nodeIdOfTerminal', () => {
  it('reads the stamp back out of reconstructed creationOptions', () => {
    expect(
      nodeIdOfTerminal({ creationOptions: { env: { [ENV_NODE_ID]: CHILD } } }),
    ).toBe(CHILD);
  });

  it('rejects a stamp that is not a session id', () => {
    expect(
      nodeIdOfTerminal({ creationOptions: { env: { [ENV_NODE_ID]: 'nope' } } }),
    ).toBeNull();
  });

  it('ignores ExtensionTerminalOptions (pty-backed) terminals', () => {
    expect(
      nodeIdOfTerminal({
        creationOptions: { pty: {}, env: { [ENV_NODE_ID]: CHILD } },
      }),
    ).toBeNull();
  });

  it('returns null for foreign terminals and missing options', () => {
    expect(nodeIdOfTerminal({ creationOptions: { env: {} } })).toBeNull();
    expect(nodeIdOfTerminal({ creationOptions: {} })).toBeNull();
    expect(nodeIdOfTerminal({})).toBeNull();
  });
});

describe('defaultTerminalName', () => {
  it('is the short id form', () => {
    expect(defaultTerminalName(CHILD)).toBe('claude · 0f0000c1');
  });
});

// -------------------------------------------- M22: the account environment

describe('launchEnv (M22 — cleans a chosen account\'s environment)', () => {
  it('passes through legal string entries untouched', () => {
    expect(
      launchEnv({ CLAUDE_CONFIG_DIR: '/work/.claude', FOO_BAR: 'baz' }),
    ).toEqual({ CLAUDE_CONFIG_DIR: '/work/.claude', FOO_BAR: 'baz' });
  });

  it('drops a key that is not a legal POSIX env var name', () => {
    expect(
      launchEnv({ 'bad key': 'x', '1LEADS_WITH_DIGIT': 'x', 'HAS-DASH': 'x' }),
    ).toEqual({});
  });

  it('drops a non-string value', () => {
    expect(launchEnv({ FOO: 42 as unknown as string })).toEqual({});
  });

  it('drops a value carrying a NUL or a newline — never truncates it', () => {
    expect(launchEnv({ A: 'x\0y', B: 'x\ny', GOOD: 'fine' })).toEqual({
      GOOD: 'fine',
    });
  });

  it('is {} for undefined, an array, or anything not a plain object', () => {
    expect(launchEnv(undefined)).toEqual({});
    expect(launchEnv([] as unknown as Record<string, string>)).toEqual({});
  });

  it('filters per-entry — one bad key never poisons a good one beside it', () => {
    expect(launchEnv({ GOOD: 'ok', 'bad key': 'x' })).toEqual({ GOOD: 'ok' });
  });
});

describe('TerminalRegistry degrades on a host without a terminal API', () => {
  it('never throws and reports nothing bound', async () => {
    const registry = new TerminalRegistry({ claudeBinary: () => null });

    expect(registry.reassociate()).toBe(0);
    expect(await registry.reassociateFromRoster([{ sessionId: CHILD }])).toBe(0);
    expect(registry.boundSessionIds()).toEqual([]);
    expect(registry.bindings()).toEqual([]);
    expect(registry.binding(CHILD)).toBeUndefined();
    expect(registry.isBoundHere(CHILD)).toBe(false);
    expect(registry.activeSessionId()).toBeNull();
    expect(registry.focus(CHILD)).toBe(false);
    expect(registry.sendText(CHILD, 'hi')).toBe(false);
    expect(registry.closeTerminal(CHILD)).toBe(false);
    expect(await registry.rename(CHILD, 'x')).toBe(false);
    expect(await registry.moveToEditor(CHILD)).toBe(false);
    expect(await registry.moveToTerminalPanel(CHILD)).toBe(false);

    // No claude binary: a logged message, not a rejection.
    expect(await registry.launch({ sessionId: CHILD })).toBeNull();

    registry.dispose();
    registry.dispose(); // idempotent
    expect(registry.reassociate()).toBe(0);
  });
});

describe('TerminalRegistry.rebind (M11 — /fork and re-key follow the terminal)', () => {
  const OTHER = '0f0000d1-0000-4000-8000-0000000000d1';

  /** Seed a binding directly: there is no public bind path without a live
   *  workbench, and rebind's contract is about the map, not the launch. */
  function seeded(): TerminalRegistry {
    const registry = new TerminalRegistry({ claudeBinary: () => null });
    (
      registry as unknown as {
        bound: Map<string, { terminal: unknown; binding: Record<string, unknown> }>;
      }
    ).bound.set(CHILD, {
      terminal: {},
      binding: {
        nodeId: CHILD,
        sessionId: CHILD,
        terminalName: 'auth',
        pid: 4242,
        createdAt: 1,
      },
    });
    return registry;
  }

  it('moves the binding to the new id and keeps the terminal facts', () => {
    const registry = seeded();
    expect(registry.rebind(CHILD, OTHER)).toBe(true);
    expect(registry.isBoundHere(CHILD)).toBe(false);
    expect(registry.isBoundHere(OTHER)).toBe(true);
    const binding = registry.binding(OTHER);
    expect(binding?.sessionId).toBe(OTHER);
    expect(binding?.nodeId).toBe(OTHER);
    expect(binding?.terminalName).toBe('auth');
    expect(binding?.pid).toBe(4242);
    registry.dispose();
  });

  it('announces the new binding through onDidBind', () => {
    const registry = seeded();
    const seen: string[] = [];
    registry.onDidBind((b) => seen.push(b.sessionId));
    registry.rebind(CHILD, OTHER);
    expect(seen).toEqual([OTHER]);
    registry.dispose();
  });

  it('refuses a self-rebind, a bad id, an unknown source and a clobber', () => {
    const registry = seeded();
    expect(registry.rebind(CHILD, CHILD)).toBe(false);
    expect(registry.rebind(CHILD, 'not-a-uuid')).toBe(false);
    expect(registry.rebind(OTHER, CHILD)).toBe(false); // OTHER not bound
    // Target already bound: never clobber.
    (
      registry as unknown as {
        bound: Map<string, unknown>;
      }
    ).bound.set(OTHER, {
      terminal: {},
      binding: { nodeId: OTHER, sessionId: OTHER, terminalName: 'x', createdAt: 2 },
    });
    expect(registry.rebind(CHILD, OTHER)).toBe(false);
    expect(registry.isBoundHere(CHILD)).toBe(true); // untouched
    registry.dispose();
  });
});

// ------------------------------------------------- detach tier (src/tmux.ts)

describe('launch wraps in the private tmux server when the wiring says so', () => {
  afterEach(() => {
    delete (vscodeMock.window as { createTerminal?: unknown }).createTerminal;
  });

  /** The one host API this path needs: createTerminal capturing its options
   *  and returning a terminal that resolves a pid (launch awaits it). */
  function fakeHost(captured: Array<Record<string, unknown>>): void {
    (
      vscodeMock.window as {
        createTerminal?: (o: Record<string, unknown>) => unknown;
      }
    ).createTerminal = (opts) => {
      captured.push(opts);
      return {
        name: opts['name'],
        creationOptions: opts,
        processId: Promise.resolve(42),
        show: () => {},
        dispose: () => {},
      };
    };
  }

  it('wraps the argv and records the tmux name on the binding', async () => {
    const captured: Array<Record<string, unknown>> = [];
    fakeHost(captured);
    const registry = new TerminalRegistry({
      claudeBinary: () => '/bin/claude',
      tmux: () => ({
        binary: '/opt/homebrew/bin/tmux',
        confPath: '/store/tmux.conf',
      }),
    });

    const binding = await registry.launch({ sessionId: CHILD, cwd: '/code/api' });

    expect(binding?.tmuxName).toBe(`lineage-${CHILD}`);
    expect(registry.tmuxNameOf(CHILD)).toBe(`lineage-${CHILD}`);
    expect(captured[0]?.['shellPath']).toBe('/opt/homebrew/bin/tmux');
    expect(captured[0]?.['shellArgs']).toEqual([
      '-L',
      'lineage',
      '-f',
      '/store/tmux.conf',
      'new-session',
      '-A',
      '-s',
      `lineage-${CHILD}`,
      '-c',
      '/code/api',
      '-e',
      `${ENV_NODE_ID}=${CHILD}`,
      '--',
      '/bin/claude',
      '--session-id',
      CHILD,
    ]);
    registry.dispose();
  });

  it('opts.tmuxName wins — the restore path re-attaches under the RECORDED name', async () => {
    // A re-key while parked means the tip id differs from the id the tmux
    // session was named after at launch. Deriving a fresh name here would
    // orphan the running process and `--resume` a second claude beside it.
    const captured: Array<Record<string, unknown>> = [];
    fakeHost(captured);
    const registry = new TerminalRegistry({
      claudeBinary: () => '/bin/claude',
      tmux: () => ({ binary: '/bin/tmux' }),
    });

    const binding = await registry.launch({
      sessionId: CHILD,
      resumeId: CHILD,
      tmuxName: `lineage-${PARENT}`,
    });

    expect(binding?.tmuxName).toBe(`lineage-${PARENT}`);
    const args = captured[0]?.['shellArgs'] as string[];
    expect(args).toContain(`lineage-${PARENT}`);
    expect(args).toContain('--resume');
    registry.dispose();
  });

  it('no tmux in the wiring: bare claude, and the binding carries no name', async () => {
    const captured: Array<Record<string, unknown>> = [];
    fakeHost(captured);
    const registry = new TerminalRegistry({
      claudeBinary: () => '/bin/claude',
      tmux: () => null,
    });

    const binding = await registry.launch({ sessionId: CHILD });

    expect(binding?.tmuxName).toBeUndefined();
    expect(registry.tmuxNameOf(CHILD)).toBeUndefined();
    expect(captured[0]?.['shellPath']).toBe('/bin/claude');
    expect(captured[0]?.['shellArgs']).toEqual(['--session-id', CHILD]);
    registry.dispose();
  });

  it("carries CLAUDE's pid (the pane's) — never the tmux client's", async () => {
    // The fake host resolves processId 42: the CLIENT pid. It must never land
    // on a wrapped binding — it matches nothing on the roster, and a binding
    // wearing it would blind the M11 re-key detector (the "session's own tab
    // on screen while its row says running-outside-this-editor" bug). The
    // pane lookup owns the field.
    const captured: Array<Record<string, unknown>> = [];
    fakeHost(captured);
    const registry = new TerminalRegistry({
      claudeBinary: () => '/bin/claude',
      tmux: () => ({ binary: '/bin/tmux' }),
      tmuxPanePid: async () => 61862,
    });

    await registry.launch({ sessionId: CHILD });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(registry.binding(CHILD)?.pid).toBe(61862);
    registry.dispose();
  });

  it('without a pane lookup a wrapped binding carries NO pid at all', async () => {
    const captured: Array<Record<string, unknown>> = [];
    fakeHost(captured);
    const registry = new TerminalRegistry({
      claudeBinary: () => '/bin/claude',
      tmux: () => ({ binary: '/bin/tmux' }),
    });

    await registry.launch({ sessionId: CHILD });

    // Degraded honestly: no pid beats the client's wrong one.
    expect(registry.binding(CHILD)?.pid).toBeUndefined();
    registry.dispose();
  });

  it('a revived terminal recovers the name from creationOptions (reload path)', () => {
    // No launch here: the registry re-binds via the env stamp after a window
    // reload, and the binding must get its tmux name back from the persisted
    // creationOptions — losing it would downgrade the session's next park
    // from detach to kill.
    const registry = new TerminalRegistry({ claudeBinary: () => null });
    const revived = {
      name: 'claude',
      creationOptions: {
        shellPath: '/bin/tmux',
        shellArgs: [
          '-L',
          'lineage',
          'new-session',
          '-A',
          '-s',
          `lineage-${CHILD}`,
          '--',
          '/bin/claude',
          '--session-id',
          CHILD,
        ],
        env: { [ENV_NODE_ID]: CHILD },
      },
    };
    const binding = (
      registry as unknown as {
        bind(sessionId: string, terminal: unknown): { tmuxName?: string };
      }
    ).bind(CHILD, revived);
    expect(binding.tmuxName).toBe(`lineage-${CHILD}`);
    expect(registry.tmuxNameOf(CHILD)).toBe(`lineage-${CHILD}`);
    registry.dispose();
  });
});

// -------------------------------------------- M22: the account environment

describe('launch carries LaunchOptions.env into BOTH tiers (M22)', () => {
  afterEach(() => {
    delete (vscodeMock.window as { createTerminal?: unknown }).createTerminal;
  });

  /** Same shape as the tmux-wrap describe block's own fixture above — kept
   *  local rather than shared, matching this file's existing convention of a
   *  fixture per describe block (see `seed`/`seeded` elsewhere in the file). */
  function fakeHost(captured: Array<Record<string, unknown>>): void {
    (
      vscodeMock.window as {
        createTerminal?: (o: Record<string, unknown>) => unknown;
      }
    ).createTerminal = (opts) => {
      captured.push(opts);
      return {
        name: opts['name'],
        creationOptions: opts,
        processId: Promise.resolve(42),
        show: () => {},
        dispose: () => {},
      };
    };
  }

  it('a bare launch merges the profile env into creationOptions.env, never strictEnv', async () => {
    const captured: Array<Record<string, unknown>> = [];
    fakeHost(captured);
    const registry = new TerminalRegistry({ claudeBinary: () => '/bin/claude' });

    const binding = await registry.launch({
      sessionId: CHILD,
      env: { CLAUDE_CONFIG_DIR: '/work/.claude' },
    });

    expect(binding).not.toBeNull();
    expect(captured[0]?.['env']).toEqual({
      CLAUDE_CONFIG_DIR: '/work/.claude',
      [ENV_NODE_ID]: CHILD,
    });
    expect(captured[0]).not.toHaveProperty('strictEnv');
    // The account env rides ONLY creationOptions.env — argv is unaffected.
    expect(captured[0]?.['shellArgs']).toEqual(['--session-id', CHILD]);
    registry.dispose();
  });

  it('the node-id stamp always wins a collision with the profile env', async () => {
    const captured: Array<Record<string, unknown>> = [];
    fakeHost(captured);
    const registry = new TerminalRegistry({ claudeBinary: () => '/bin/claude' });

    await registry.launch({
      sessionId: CHILD,
      env: { [ENV_NODE_ID]: 'poisoned-value' },
    });

    expect((captured[0]?.['env'] as Record<string, string>)[ENV_NODE_ID]).toBe(
      CHILD,
    );
    registry.dispose();
  });

  it('with no env at all, creationOptions.env is exactly the pre-M22 stamp', async () => {
    const captured: Array<Record<string, unknown>> = [];
    fakeHost(captured);
    const registry = new TerminalRegistry({ claudeBinary: () => '/bin/claude' });

    await registry.launch({ sessionId: CHILD });

    expect(captured[0]?.['env']).toEqual({ [ENV_NODE_ID]: CHILD });
    registry.dispose();
  });

  it('an illegal env entry never reaches creationOptions', async () => {
    const captured: Array<Record<string, unknown>> = [];
    fakeHost(captured);
    const registry = new TerminalRegistry({ claudeBinary: () => '/bin/claude' });

    await registry.launch({
      sessionId: CHILD,
      env: { 'bad key': 'x', GOOD: 'y' },
    });

    expect(captured[0]?.['env']).toEqual({ GOOD: 'y', [ENV_NODE_ID]: CHILD });
    registry.dispose();
  });

  it('a tmux-wrapped launch carries the SAME env as -e flags, profile keys before the stamp', async () => {
    const captured: Array<Record<string, unknown>> = [];
    fakeHost(captured);
    const registry = new TerminalRegistry({
      claudeBinary: () => '/bin/claude',
      tmux: () => ({ binary: '/opt/homebrew/bin/tmux' }),
    });

    await registry.launch({
      sessionId: CHILD,
      cwd: '/code/api',
      env: { CLAUDE_CONFIG_DIR: '/work/.claude' },
    });

    expect(captured[0]?.['shellArgs']).toEqual([
      '-L',
      'lineage',
      'new-session',
      '-A',
      '-s',
      `lineage-${CHILD}`,
      '-c',
      '/code/api',
      '-e',
      'CLAUDE_CONFIG_DIR=/work/.claude',
      '-e',
      `${ENV_NODE_ID}=${CHILD}`,
      '--',
      '/bin/claude',
      '--session-id',
      CHILD,
    ]);
    // The terminal's OWN creationOptions.env carries the same profile env too
    // (that copy only ever reaches the tmux CLIENT and exists for a window
    // RELOAD to reconstruct the same account — see the file header); the -e
    // flags above are what actually reach the CLAUDE process inside the
    // server, which is the assertion this test exists for.
    expect(captured[0]?.['env']).toEqual({
      CLAUDE_CONFIG_DIR: '/work/.claude',
      [ENV_NODE_ID]: CHILD,
    });
    registry.dispose();
  });
});

describe('closing a wrapped session: user close KILLS, parking detaches', () => {
  const TMUX_NAME = `lineage-${CHILD}`;

  afterEach(() => {
    delete (vscodeMock.window as { onDidCloseTerminal?: unknown })
      .onDidCloseTerminal;
  });

  function seed(
    registry: TerminalRegistry,
    terminal: unknown,
    tmuxName?: string,
  ): void {
    (
      registry as unknown as {
        bound: Map<string, { terminal: unknown; binding: unknown }>;
      }
    ).bound.set(CHILD, {
      terminal,
      binding: {
        nodeId: CHILD,
        sessionId: CHILD,
        terminalName: 'x',
        createdAt: 1,
        ...(tmuxName !== undefined ? { tmuxName } : {}),
      },
    });
  }

  it('the close VERB (killTmux intent) ends the tmux session too', () => {
    const killed: string[] = [];
    const registry = new TerminalRegistry({
      claudeBinary: () => null,
      tmuxKillSession: async (name) => {
        killed.push(name);
        return true;
      },
    });
    seed(registry, { dispose: () => {} }, TMUX_NAME);

    expect(registry.closeTerminal(CHILD, { killTmux: true })).toBe(true);
    expect(killed).toEqual([TMUX_NAME]);
    registry.dispose();
  });

  it('a PARK (no intent) only detaches — the process must survive', () => {
    const killed: string[] = [];
    const registry = new TerminalRegistry({
      claudeBinary: () => null,
      tmuxKillSession: async (name) => {
        killed.push(name);
        return true;
      },
    });
    seed(registry, { dispose: () => {} }, TMUX_NAME);

    expect(registry.closeTerminal(CHILD)).toBe(true);
    expect(killed).toEqual([]);
    registry.dispose();
  });

  it("the user's tab X kills; a reload/extension dispose never does", () => {
    // Reason numbers are API-stable: Shutdown=1 (reload — the session must
    // survive for revival), User=3 (the tab X — "closing a tab closes the
    // session"), Extension=4 (parking — detach on purpose).
    for (const [reason, expectKill] of [
      [3, true],
      [1, false],
      [4, false],
    ] as const) {
      const killed: string[] = [];
      let closeHandler: ((t: unknown) => void) | undefined;
      (
        vscodeMock.window as {
          onDidCloseTerminal?: (h: (t: unknown) => void) => { dispose(): void };
        }
      ).onDidCloseTerminal = (h) => {
        closeHandler = h;
        return { dispose() {} };
      };
      const registry = new TerminalRegistry({
        claudeBinary: () => null,
        tmuxKillSession: async (name) => {
          killed.push(name);
          return true;
        },
      });
      const terminal = { exitStatus: { code: 0, reason } };
      seed(registry, terminal, TMUX_NAME);

      closeHandler?.(terminal);

      expect(killed, `reason ${reason}`).toEqual(
        expectKill ? [TMUX_NAME] : [],
      );
      registry.dispose();
      delete (vscodeMock.window as { onDidCloseTerminal?: unknown })
        .onDidCloseTerminal;
    }
  });
});

describe('reassociateFromTmux (app-restart path for wrapped terminals)', () => {
  afterEach(() => {
    delete (vscodeMock.window as { terminals?: unknown }).terminals;
  });

  it('binds a revived stamp-less terminal through its tmux client pid', async () => {
    // A full restart drops creationOptions, and the terminal's pid is the
    // tmux CLIENT's — invisible to both existing re-association paths. This
    // was "small-ui": tab on screen, session live, row insisting the session
    // ran outside this editor.
    const revived = {
      name: 'claude',
      creationOptions: {},
      processId: Promise.resolve(61854),
      show: () => {},
    };
    (vscodeMock.window as { terminals?: unknown }).terminals = [revived];
    const registry = new TerminalRegistry({
      claudeBinary: () => null,
      tmuxClientSessions: async () => new Map([[61854, `lineage-${CHILD}`]]),
      tmuxPanePid: async () => 4242,
    });

    expect(await registry.reassociateFromTmux()).toBe(1);
    expect(registry.isBoundHere(CHILD)).toBe(true);
    expect(registry.tmuxNameOf(CHILD)).toBe(`lineage-${CHILD}`);
    // Idempotent: nothing unbound remains.
    expect(await registry.reassociateFromTmux()).toBe(0);
    // And the binding gets CLAUDE's pid (the pane's), not the client's.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(registry.binding(CHILD)?.pid).toBe(4242);
    registry.dispose();
  });

  it('claims neither foreign terminals nor foreign tmux sessions', async () => {
    const zsh = {
      name: 'zsh',
      creationOptions: {},
      processId: Promise.resolve(111),
      show: () => {},
    };
    const attachedToOwnTmux = {
      name: 'tmux',
      creationOptions: {},
      processId: Promise.resolve(222),
      show: () => {},
    };
    (vscodeMock.window as { terminals?: unknown }).terminals = [
      zsh,
      attachedToOwnTmux,
    ];
    const registry = new TerminalRegistry({
      claudeBinary: () => null,
      // 222 is attached to a session WE did not mint — no id, no claim.
      tmuxClientSessions: async () => new Map([[222, 'my-own-session']]),
    });

    expect(await registry.reassociateFromTmux()).toBe(0);
    expect(registry.boundSessionIds()).toEqual([]);
    registry.dispose();
  });

  it('degrades to 0 without the dep — the unit doubles and tmux-less hosts', async () => {
    const registry = new TerminalRegistry({ claudeBinary: () => null });
    expect(await registry.reassociateFromTmux()).toBe(0);
    registry.dispose();
  });
});

// ---------------------------------------------------------- launch location

describe('locationValueOf', () => {
  it('defaults to the editor area — a session is a place, not a command', () => {
    // `vscode.TerminalLocation` is absent under the mock, which is exactly the
    // degraded host this has to keep working on: the numbers are API-stable.
    expect(locationValueOf(undefined)).toBe(2);
    expect(locationValueOf('editor')).toBe(2);
  });

  it('starts a newWindow session as an editor tab (the move comes after)', () => {
    expect(locationValueOf('newWindow')).toBe(2);
  });

  it('honours an explicit panel preference', () => {
    expect(locationValueOf('panel')).toBe(1);
  });
});
