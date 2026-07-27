// test/terminals.test.ts — owner D. SPEC.md §9: "pure parts only".
//
// The vscode mock exposes an empty `window`/`commands`, which doubles as the
// worst-case host: every registry method must degrade to a logged no-op rather
// than throw. That is asserted here too, since "degrade, never break" is a
// hard requirement of §4-D.

import { describe, expect, it } from 'vitest';

import {
  TerminalRegistry,
  buildShellArgs,
  defaultTerminalName,
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
    // --resume reuses the original id; passing --session-id too would ask
    // claude to both keep and replace it.
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
