// test/shellsView.test.ts — what a row in the Shells view says.
//
// The provider itself is three lines of TreeDataProvider boilerplate over
// these functions; the interesting part is the wording and the ordering, so
// that is what is pinned here.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  SHELLS_VIEW_ID,
  shellContextValue,
  shellDescription,
  shellIconId,
  shellTooltip,
  sortShells,
} from '../src/shellsView';
import type { TerminalBinding } from '../src/types';

const A = '0f00000a-0000-4000-8000-00000000000a';
const B = '0f00000b-0000-4000-8000-00000000000b';
const NOW = 1_785_160_000_000;

function binding(over: Partial<TerminalBinding> = {}): TerminalBinding {
  return {
    nodeId: A,
    sessionId: A,
    terminalName: 'claude — flock',
    createdAt: NOW,
    ...over,
  };
}

describe('shellDescription', () => {
  it('leads with the pid, because that is why you opened this view', () => {
    expect(shellDescription(binding({ pid: 40213 }), NOW)).toBe('pid 40213 · now');
  });

  it('says the tmux tier as a word', () => {
    // The TIER is what matters at a glance: it decides whether a workspace
    // switch parks this shell or closes it. The session's name is in the hover.
    expect(
      shellDescription(binding({ pid: 40213, tmuxName: 'lineage-0f00000a' }), NOW),
    ).toBe('pid 40213 · tmux · now');
  });

  it('admits an unknown pid rather than going quiet', () => {
    // A pty is created asynchronously and a wrapped terminal's own pid is the
    // tmux client's — "we do not know yet" is a real state, and silence there
    // reads as though the column did not apply.
    expect(shellDescription(binding(), NOW)).toBe('pid ? · now');
  });

  it('ages', () => {
    expect(shellDescription(binding({ pid: 7 }), NOW + 12 * 60_000)).toBe(
      'pid 7 · 12m',
    );
  });

  it('drops the age rather than printing nonsense for a broken clock', () => {
    expect(shellDescription(binding({ pid: 7, createdAt: Number.NaN }), NOW)).toBe(
      'pid 7',
    );
  });
});

describe('shellTooltip', () => {
  it('warns that a wrapped terminal’s pid is the tmux client’s', () => {
    // A genuine trap: somebody reading that number as claude's will kill the
    // wrong process.
    const text = shellTooltip({
      binding: binding({ pid: 40213, tmuxName: 'lineage-0f00000a' }),
      now: NOW,
    });
    expect(text).toContain('pid 40213 (the tmux client, not claude)');
    expect(text).toContain('lineage-0f00000a');
  });

  it('says what an unwrapped shell costs on a workspace switch', () => {
    expect(shellTooltip({ binding: binding({ pid: 9 }), now: NOW })).toContain(
      'no tmux wrap',
    );
  });

  it('carries the label, status and cwd when the tree knows them', () => {
    const text = shellTooltip({
      binding: binding({ pid: 9 }),
      label: 'the parser fix',
      status: 'busy',
      cwd: '/Users/x/repo',
      now: NOW,
    });
    expect(text.split('\n')[0]).toBe('the parser fix');
    expect(text).toContain('busy');
    expect(text).toContain('/Users/x/repo');
    expect(text).toContain(`session ${A}`);
  });

  it('falls back to the short id for a shell with no row', () => {
    // Ordinary, not exceptional: a session the roster has not reported yet, or
    // one a filter keeps out of the tree.
    expect(shellTooltip({ binding: binding(), now: NOW }).split('\n')[0]).toBe(
      A.slice(0, 8),
    );
  });
});

describe('sortShells', () => {
  it('orders by launch time, newest last — the terminal list’s own order', () => {
    const rows = sortShells([
      binding({ sessionId: B, nodeId: B, createdAt: NOW + 1_000 }),
      binding({ sessionId: A, nodeId: A, createdAt: NOW }),
    ]);
    expect(rows.map((b) => b.sessionId)).toEqual([A, B]);
  });

  it('breaks ties on id, so a fork of N never reshuffles between repaints', () => {
    const rows = sortShells([
      binding({ sessionId: B, nodeId: B }),
      binding({ sessionId: A, nodeId: A }),
    ]);
    expect(rows.map((b) => b.sessionId)).toEqual([A, B]);
  });

  it('drops anything that is not a real binding', () => {
    const rows = sortShells([
      binding(),
      { ...binding(), sessionId: 'nope' },
      undefined as unknown as TerminalBinding,
    ]);
    expect(rows).toHaveLength(1);
  });
});

describe('the row’s marks', () => {
  it('gives a wrapped shell its own token and glyph', () => {
    const wrapped = binding({ tmuxName: 'lineage-0f00000a' });
    expect(shellContextValue(wrapped)).toBe(';shell;tmux;');
    expect(shellIconId(wrapped)).toBe('server-process');
  });

  it('leaves a bare terminal as just a shell', () => {
    expect(shellContextValue(binding())).toBe(';shell;');
    expect(shellIconId(binding())).toBe('terminal');
  });
});

// ------------------------------------------------------- the contribution

describe('package.json — the Shells surface is wired, not just declared', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
  ) as {
    contributes: {
      views: Record<string, { id: string; when?: string; visibility?: string }[]>;
      viewsWelcome: { view: string; contents: string }[];
      configuration: {
        properties: Record<string, { type?: string; default?: unknown }>;
      };
    };
  };

  it('puts Shells inside the lineage activity-bar container', () => {
    const view = (pkg.contributes.views['lineage'] ?? []).find(
      (v) => v.id === SHELLS_VIEW_ID,
    );
    expect(view, 'lineageShells not under contributes.views.lineage').toBeDefined();
    expect(view?.when).toContain('config.lineage.shells.section');
  });

  it('ships collapsed — a process list is a thing you go and open', () => {
    const view = (pkg.contributes.views['lineage'] ?? []).find(
      (v) => v.id === SHELLS_VIEW_ID,
    );
    expect(view?.visibility).toBe('collapsed');
  });

  // A when-clause rather than `visibility` alone, for the reason the Accounts
  // section documents: VS Code persists a user's view visibility per container,
  // so a `visibility` default never reaches an existing profile and the setting
  // has to be the thing the view actually reads.
  it('declares lineage.shells.section as a boolean defaulting to true', () => {
    const prop =
      pkg.contributes.configuration.properties['lineage.shells.section'];
    expect(prop, 'lineage.shells.section not declared').toBeDefined();
    expect(prop?.type).toBe('boolean');
    expect(prop?.default).toBe(true);
  });

  // An empty Shells view is the ordinary state of a window with nothing
  // running, and a blank section says neither what it is for nor that the
  // window is the reason it is empty.
  it('explains itself when there is nothing to list', () => {
    const welcome = pkg.contributes.viewsWelcome.find(
      (w) => w.view === SHELLS_VIEW_ID,
    );
    expect(welcome, 'no viewsWelcome for lineageShells').toBeDefined();
    expect(welcome?.contents).toContain('THIS window');
  });
});
