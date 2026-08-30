// test/shellsView.test.ts — the Shells view: rows, counts, and the manifest.
//
// The provider is TreeDataProvider boilerplate over toolShells.ts (tested next
// door) plus two decisions of its own — which runs make the list, and whether
// a row says which session it came from. Those are pure functions here, and
// they are what this file pins.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  MAX_ROWS,
  SHELLS_VIEW_ID,
  pickShellRows,
  shellContextValue,
  shellsViewDescription,
} from '../src/shellsView';
import type { ShellRun } from '../src/toolShells';

const A = '0f00000a-0000-4000-8000-00000000000a';
const B = '0f00000b-0000-4000-8000-00000000000b';
const NOW = 1_785_160_000_000;

function run(id: string, over: Partial<ShellRun> = {}): ShellRun {
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

const labels = new Map([
  [A, 'the parser fix'],
  [B, 'the release'],
]);

describe('pickShellRows', () => {
  it('carries the SESSION id as `id`, so every session verb still works', () => {
    const rows = pickShellRows(new Map([[A, [run('toolu_1')]]]), labels);
    // Not the run's id: `sessionIdFromArg` reads `.id`, and Focus, Fork and
    // Rename all reach this view through it unchanged.
    expect(rows[0]?.id).toBe(A);
    expect(rows[0]?.run.id).toBe('toolu_1');
  });

  // One conversation means the same word on every row — a column of noise.
  it('leaves the session name off when there is only one session', () => {
    const rows = pickShellRows(
      new Map([[A, [run('toolu_1'), run('toolu_2')]]]),
      labels,
    );
    expect(rows.every((r) => r.sessionLabel === undefined)).toBe(true);
  });

  it('puts the session name on every row once the list spans two', () => {
    const rows = pickShellRows(
      new Map([
        [A, [run('toolu_1')]],
        [B, [run('toolu_2', { sessionId: B })]],
      ]),
      labels,
    );
    expect(rows.map((r) => r.sessionLabel).sort()).toEqual([
      'the parser fix',
      'the release',
    ]);
  });

  it('interleaves two sessions by time rather than grouping them', () => {
    const rows = pickShellRows(
      new Map([
        [A, [run('a1', { endedAt: NOW + 100 }), run('a2', { endedAt: NOW + 300 })]],
        [B, [run('b1', { sessionId: B, endedAt: NOW + 200 })]],
      ]),
      labels,
    );
    expect(rows.map((r) => r.run.id)).toEqual(['a2', 'b1', 'a1']);
  });

  // The cap exists so six sessions of history do not become 360 rows of
  // `git status`. It must never be what removes a running command.
  it('caps the list without ever dropping something that is running', () => {
    const finished = Array.from({ length: 40 }, (_, i) =>
      run(`done${i}`, { endedAt: NOW + i }),
    );
    const live = run('live', { outcome: 'running', endedAt: undefined });
    const rows = pickShellRows(new Map([[A, [...finished, live]]]), labels, 5);
    expect(rows).toHaveLength(5);
    expect(rows[0]?.run.id).toBe('live');
  });

  it('caps at MAX_ROWS by default', () => {
    const many = Array.from({ length: MAX_ROWS + 25 }, (_, i) =>
      run(`r${i}`, { endedAt: NOW + i }),
    );
    expect(pickShellRows(new Map([[A, many]]), labels)).toHaveLength(MAX_ROWS);
  });

  it('survives a session that reported nothing', () => {
    expect(pickShellRows(new Map([[A, []]]), labels)).toEqual([]);
    expect(pickShellRows(new Map(), new Map())).toEqual([]);
  });
});

describe('the row’s context value', () => {
  it('wraps its tokens in semicolons, so a `when` clause cannot half-match', () => {
    expect(shellContextValue(run('toolu_1'))).toBe(';shell;ok;');
    expect(shellContextValue(run('toolu_1', { outcome: 'running' }))).toBe(
      ';shell;running;live;',
    );
  });

  it('marks a row whose output is on disk, which is what puts Open Output on it', () => {
    const value = shellContextValue(
      run('toolu_1', { outcome: 'background', outputFile: '/tmp/x.output' }),
    );
    expect(value).toContain(';output;');
  });
});

describe('the view’s subtitle', () => {
  it('counts what is up, running and background apart', () => {
    expect(
      shellsViewDescription([
        run('a', { outcome: 'running' }),
        run('b', { outcome: 'running' }),
        run('c', { outcome: 'background' }),
        run('d'),
      ]),
    ).toBe('2 running · 1 background');
  });

  // A header that permanently reads "0 running" is a header nobody reads; the
  // point of the count is that it means something on the day it appears.
  it('says nothing at all when nothing is up', () => {
    expect(shellsViewDescription([run('a'), run('b', { outcome: 'failed' })])).toBe('');
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
