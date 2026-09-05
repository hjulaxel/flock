// test/shellsView.test.ts — the Shells view: rows, counts, and the manifest.
//
// The provider is TreeDataProvider boilerplate over toolShells.ts (tested next
// door) plus three decisions of its own — which runs make the list (the live
// ones, and only those), whether a row says which session it came from, and
// when an unanswered call is a prompt rather than a process. Those are pure
// functions here, and they are what this file pins.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  MAX_ROWS,
  SHELLS_VIEW_ID,
  countRunning,
  pickShellRows,
  shellContextValue,
  shellsViewDescription,
} from '../src/shellsView';
import type { ShellRow } from '../src/shellsView';
import type { ShellRun } from '../src/toolShells';

const A = '0f00000a-0000-4000-8000-00000000000a';
const B = '0f00000b-0000-4000-8000-00000000000b';
const NOW = 1_785_160_000_000;

/** A finished run — the kind the view no longer lists. */
function done(id: string, over: Partial<ShellRun> = {}): ShellRun {
  return {
    id,
    sessionId: A,
    command: `echo ${id}`,
    startedAt: NOW,
    endedAt: NOW + 1_000,
    outcome: 'ok',
    ...over,
  };
}

/** A run still executing. */
function live(id: string, over: Partial<ShellRun> = {}): ShellRun {
  return {
    id,
    sessionId: A,
    command: `sleep ${id}`,
    startedAt: NOW,
    outcome: 'running',
    ...over,
  };
}

function row(run: ShellRun, over: Partial<ShellRow> = {}): ShellRow {
  return { kind: 'shell', run, id: run.sessionId, ...over };
}

const labels = new Map([
  [A, 'the parser fix'],
  [B, 'the release'],
]);

describe('pickShellRows', () => {
  it('carries the SESSION id as `id`, so every session verb still works', () => {
    const rows = pickShellRows(new Map([[A, [live('toolu_1')]]]), labels);
    // Not the run's id: `sessionIdFromArg` reads `.id`, and Focus, Fork and
    // Rename all reach this view through it unchanged.
    expect(rows[0]?.id).toBe(A);
    expect(rows[0]?.run.id).toBe('toolu_1');
  });

  // The list is the CLI's own "1 shell running" indicator across every
  // session, not a history: what ran is in the conversation, what is running
  // is the thing nothing else shows.
  it('lists what is live and nothing that has finished', () => {
    const rows = pickShellRows(
      new Map([
        [
          A,
          [
            done('ok'),
            done('bad', { outcome: 'failed', exitCode: 1 }),
            done('no', { outcome: 'denied' }),
            live('fg'),
            live('bg', { outcome: 'background', outputFile: '/tmp/bg.output' }),
          ],
        ],
      ]),
      labels,
    );
    expect(rows.map((r) => r.run.id).sort()).toEqual(['bg', 'fg']);
  });

  // One conversation means the same word on every row — a column of noise.
  it('leaves the session name off when there is only one session', () => {
    const rows = pickShellRows(
      new Map([[A, [live('toolu_1'), live('toolu_2')]]]),
      labels,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.sessionLabel === undefined)).toBe(true);
  });

  it('puts the session name on every row once the list spans two', () => {
    const rows = pickShellRows(
      new Map([
        [A, [live('toolu_1')]],
        [B, [live('toolu_2', { sessionId: B })]],
      ]),
      labels,
    );
    expect(rows.map((r) => r.sessionLabel).sort()).toEqual([
      'the parser fix',
      'the release',
    ]);
  });

  it('interleaves two sessions by time rather than grouping them, newest first', () => {
    const rows = pickShellRows(
      new Map([
        [A, [live('a1', { startedAt: NOW + 100 }), live('a2', { startedAt: NOW + 300 })]],
        [B, [live('b1', { sessionId: B, startedAt: NOW + 200 })]],
      ]),
      labels,
    );
    expect(rows.map((r) => r.run.id)).toEqual(['a2', 'b1', 'a1']);
  });

  // The CLI writes the call before it asks for permission, so an unanswered
  // call in a session the roster reports blocked is the thing the prompt is
  // about. It is worth a row — you can see what Claude wants to run — but not
  // a spinner, and not a place in the running count.
  it('marks a running call in a blocked session as awaiting approval', () => {
    const rows = pickShellRows(
      new Map([
        [A, [live('asked')]],
        [B, [live('going', { sessionId: B })]],
      ]),
      labels,
      { waiting: new Set([A]) },
    );
    const byId = new Map(rows.map((r) => [r.run.id, r]));
    expect(byId.get('asked')?.awaiting).toBe(true);
    expect(byId.get('going')?.awaiting).toBeUndefined();
  });

  // A detached job is up regardless of what its session is doing now: the
  // prompt the session is blocked on is about something else.
  it('leaves a background job alone in a blocked session', () => {
    const rows = pickShellRows(
      new Map([[A, [live('bg', { outcome: 'background' })]]]),
      labels,
      { waiting: new Set([A]) },
    );
    expect(rows[0]?.awaiting).toBeUndefined();
  });

  it('caps the list', () => {
    const many = Array.from({ length: MAX_ROWS + 25 }, (_, i) =>
      live(`r${i}`, { startedAt: NOW + i }),
    );
    expect(pickShellRows(new Map([[A, many]]), labels)).toHaveLength(MAX_ROWS);
    expect(pickShellRows(new Map([[A, many]]), labels, { max: 5 })).toHaveLength(5);
  });

  it('survives a session that reported nothing', () => {
    expect(pickShellRows(new Map([[A, []]]), labels)).toEqual([]);
    expect(pickShellRows(new Map(), new Map())).toEqual([]);
  });
});

describe('the row’s context value', () => {
  it('wraps its tokens in semicolons, so a `when` clause cannot half-match', () => {
    expect(shellContextValue(done('toolu_1'))).toBe(';shell;ok;');
    expect(shellContextValue(live('toolu_1'))).toBe(';shell;running;live;');
  });

  it('marks a call awaiting approval, and only a running one', () => {
    expect(shellContextValue(live('toolu_1'), true)).toBe(
      ';shell;running;live;awaiting;',
    );
    expect(shellContextValue(live('bg', { outcome: 'background' }), true)).toBe(
      ';shell;background;live;',
    );
  });

  it('marks a row whose output is on disk, which is what puts Open Output on it', () => {
    const value = shellContextValue(
      live('toolu_1', { outcome: 'background', outputFile: '/tmp/x.output' }),
    );
    expect(value).toContain(';output;');
  });
});

describe('the badge and the view’s subtitle', () => {
  const rows = [
    row(live('a')),
    row(live('b')),
    row(live('c', { outcome: 'background' })),
    row(live('d'), { awaiting: true }),
  ];

  it('counts what is executing — background included, awaiting excluded', () => {
    expect(countRunning(rows)).toBe(3);
    expect(countRunning([])).toBe(0);
  });

  it('counts running, background and awaiting apart', () => {
    expect(shellsViewDescription(rows)).toBe(
      '2 running · 1 background · 1 awaiting approval',
    );
  });

  // A header that permanently reads "0 running" is a header nobody reads; the
  // point of the count is that it means something on the day it appears.
  it('says nothing at all when nothing is up', () => {
    expect(shellsViewDescription([])).toBe('');
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
      commands: { command: string; title: string }[];
      menus: Record<string, { command: string; when?: string; group?: string }[]>;
      configuration: {
        properties: Record<
          string,
          { type?: string; default?: unknown; markdownDescription?: string }
        >;
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

  it('ships collapsed — the badge is what makes a running command noticed', () => {
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

  // The scope changed with the rewrite — this view used to be window-local
  // because it listed `vscode.Terminal` objects, and now reads transcripts off
  // disk. The setting's own text is where a user finds that out.
  it('says in the setting that it covers the whole machine', () => {
    const prop =
      pkg.contributes.configuration.properties['lineage.shells.section'];
    expect(prop?.markdownDescription).toContain('Every live session on this machine');
  });

  it('explains itself when there is nothing to list', () => {
    const welcome = pkg.contributes.viewsWelcome.find(
      (w) => w.view === SHELLS_VIEW_ID,
    );
    expect(welcome, 'no viewsWelcome for lineageShells').toBeDefined();
    expect(welcome?.contents).toContain('Bash');
  });

  it('contributes both row verbs', () => {
    const ids = pkg.contributes.commands.map((c) => c.command);
    expect(ids).toContain('lineage.copyShellCommand');
    expect(ids).toContain('lineage.openShellOutput');
  });

  // Open Output is on a row that HAS one, and nowhere else: a menu entry that
  // is always there and usually refuses is worse than no entry.
  it('offers Open Output only on a row with a file behind it', () => {
    const entries = (pkg.contributes.menus['view/item/context'] ?? []).filter(
      (m) => m.command === 'lineage.openShellOutput',
    );
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.when).toContain(`view == ${SHELLS_VIEW_ID}`);
      expect(entry.when).toContain(';output;');
    }
  });

  it('offers Copy Command on every shell row', () => {
    const entry = (pkg.contributes.menus['view/item/context'] ?? []).find(
      (m) => m.command === 'lineage.copyShellCommand',
    );
    expect(entry?.when).toContain(';shell;');
  });

  // There is no sane answer to "which of the four hundred commands did you
  // mean", so neither verb is reachable without a row.
  it('keeps both verbs off the command palette', () => {
    for (const id of ['lineage.copyShellCommand', 'lineage.openShellOutput']) {
      const entry = (pkg.contributes.menus['commandPalette'] ?? []).find(
        (m) => m.command === id,
      );
      expect(entry, `${id} not hidden from the palette`).toBeDefined();
      expect(entry?.when).toBe('false');
    }
  });
});
