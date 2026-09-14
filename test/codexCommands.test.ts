import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { window } from './mocks/vscode';
import { compactCodexFork } from '../src/commands';
import type { CommandDeps, SessionNode } from '../src/types';

const ID = '01a097ea-a731-7783-a894-1e4c50e5e00e';
beforeEach(() => {
  (window as { showWarningMessage?: unknown }).showWarningMessage = vi.fn(async () => undefined);
});
afterEach(() => vi.useRealTimers());

function harness() {
  const state = { status: 'idle', closed: false, present: true };
  const send = vi.fn(() => 'sent' as const);
  const deps = {
    tipOf: () => ID,
    getRecord: () => state.closed ? { closed: '2026-09-13T10:00:00Z' } : {},
    getForest: () => ({ nodes: new Map(state.present ? [[ID, {
      id: ID, label: 'Codex fork', status: state.status, ghost: false, archived: false,
    } as SessionNode]] : []) }),
    sendTextToSession: send,
  } as unknown as CommandDeps;
  return { state, send, deps };
}

describe('Fork and Compact on Codex', () => {
  it('types /compact into the ready fork through the guarded send path', async () => {
    const h = harness();
    await compactCodexFork(h.deps, ID);
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.send).toHaveBeenCalledWith(ID, '/compact');
  });

  it('waits for the new row and never sends while the session is busy', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.state.present = false;
    const task = compactCodexFork(h.deps, ID);
    await vi.advanceTimersByTimeAsync(1000);
    h.state.present = true;
    h.state.status = 'busy';
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.send).not.toHaveBeenCalled();
    h.state.status = 'idle';
    await vi.advanceTimersByTimeAsync(1000);
    await task;
    expect(h.send).toHaveBeenCalledOnce();
  });

  it('honours the prompt-visibility guard and does not retry blind input', async () => {
    const h = harness();
    h.deps.sendTextToSession = vi.fn(() => 'blind' as const);
    await compactCodexFork(h.deps, ID);
    expect(h.deps.sendTextToSession).toHaveBeenCalledOnce();
  });

  it('stops if the fork closes while waiting for readiness', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.state.present = false;
    const task = compactCodexFork(h.deps, ID);
    h.state.closed = true;
    await vi.advanceTimersByTimeAsync(1000);
    await task;
    expect(h.send).not.toHaveBeenCalled();
  });
});
