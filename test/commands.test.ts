// SPEC.md §9 — test/commands.test.ts (nominally owner E; written by the
// INTEGRATOR because owner E was scoped to src/commands.ts only).
//
// Pure surface only: registerCommands() talks to the real workbench and the
// frozen vscode mock exports an empty `commands`, so it is never exercised.

import { describe, expect, it } from 'vitest';

import { sessionIdFromArg } from '../src/commands';
import { WRAP_PROMPT, isSessionId } from '../src/types';

const VALID = 'ff2c0a73-26c4-46f1-bb6e-fe331fcb0ecf';

describe('sessionIdFromArg', () => {
  it('accepts a validated session-id string', () => {
    expect(sessionIdFromArg(VALID)).toBe(VALID);
  });

  it('rejects a junk string', () => {
    expect(sessionIdFromArg('not-a-uuid')).toBeUndefined();
    expect(sessionIdFromArg('')).toBeUndefined();
  });

  it('unwraps a SessionRef', () => {
    expect(sessionIdFromArg({ type: 'session', id: VALID })).toBe(VALID);
  });

  it('unwraps any object with a uuid-shaped id (a TreeItem, say)', () => {
    expect(sessionIdFromArg({ id: VALID })).toBe(VALID);
    expect(sessionIdFromArg({ id: 'group:/tmp' })).toBeUndefined();
  });

  it('refuses a GroupNode — folder rows are not sessions', () => {
    expect(
      sessionIdFromArg({
        type: 'group',
        key: '/tmp/p',
        cwd: '/tmp/p',
        label: 'p',
        rootIds: [VALID],
      }),
    ).toBeUndefined();
  });

  it('refuses undefined and null (handlers then fall back to a QuickPick)', () => {
    expect(sessionIdFromArg(undefined)).toBeUndefined();
    expect(sessionIdFromArg(null)).toBeUndefined();
    expect(sessionIdFromArg(42)).toBeUndefined();
  });
});

describe('WRAP_PROMPT', () => {
  it('is a non-empty single line (sendText appends the newline itself)', () => {
    expect(WRAP_PROMPT.length).toBeGreaterThan(0);
    expect(WRAP_PROMPT).not.toContain('\n');
    expect(WRAP_PROMPT.trim()).toBe(WRAP_PROMPT);
  });
});

describe('isSessionId (the gate every verb resolves through)', () => {
  it('accepts a uuid and rejects near-misses', () => {
    expect(isSessionId(VALID)).toBe(true);
    expect(isSessionId(VALID.slice(0, -1))).toBe(false);
    expect(isSessionId(`${VALID} `)).toBe(false);
  });
});
