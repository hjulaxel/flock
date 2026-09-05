// test/status.test.ts — the Status verb's rows, decided from a world.
//
// src/status.ts is pure, so this is a world in and rows out. What is pinned:
// that every row names an EXISTING flow (a contributed command, the editor at
// a key, the checklist's own tmux write, the shared surface picker) — a status
// row that grew a verb of its own would be one the palette does not have; that
// the two taste rows read through the same functions their pickers use; and
// that a row is drawn only for somebody it can mean something to.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  ADVANCED_SETTINGS_QUERY,
  SETTINGS_QUERY,
  statusFacts,
} from '../src/status';
import type { StatusFact } from '../src/status';
import { surfaceChoices, windowModelChoices } from '../src/recommend';
import { COMMANDS, CONFIG_KEYS } from '../src/types';
import type { RecommendedWorld } from '../src/types';
import { contributedSettings } from './manifest';

const ROOT = path.join(__dirname, '..');

/** tmux installed and on, both installs done, a claude on PATH. */
const settled: RecommendedWorld = {
  platform: 'darwin',
  tmuxBinary: '/opt/homebrew/bin/tmux',
  tmuxMode: 'auto',
  hooksInstalled: true,
  verbsInstalled: true,
  verbsAvailable: true,
  hasProjects: true,
  unlistedCount: 0,
  branchRowsEnabled: false,
  maxWorktrees: 1,
  terminalLocation: 'editor',
  soloSession: false,
  launchMode: 'flock',
  claudeExtensionInstalled: false,
  mode: undefined,
  workspacesEnabled: true,
};

const cli = { claude: '/usr/local/bin/claude', codex: null, codexConfigured: false };

const byId = (facts: StatusFact[], id: StatusFact['id']): StatusFact => {
  const found = facts.find((f) => f.id === id);
  if (!found) throw new Error(`no ${id} row`);
  return found;
};

describe('status: the rows', () => {
  it('lists the rows in the order a newcomer asks them, each with a label, a value and a next', () => {
    const facts = statusFacts({ world: settled, cli, hasCodexAccount: false });
    expect(facts.map((f) => f.id)).toEqual([
      'tmux',
      'hooks',
      'verbs',
      'claude',
      'windowModel',
      'surface',
    ]);
    for (const fact of facts) {
      expect(fact.label.trim().length, fact.id).toBeGreaterThan(0);
      expect(fact.value.trim().length, fact.id).toBeGreaterThan(0);
      expect(fact.next.trim().length, fact.id).toBeGreaterThan(0);
      expect(fact.icon).toMatch(/^[a-z][a-z-]*$/);
    }
  });

  it('says where tmux is and that it is on, and points at the setting', () => {
    const tmux = byId(statusFacts({ world: settled, cli, hasCodexAccount: false }), 'tmux');
    expect(tmux.value).toBe('installed at /opt/homebrew/bin/tmux, on');
    expect(tmux.action).toEqual({ kind: 'openSetting', key: 'lineage.tmux' });
  });

  // The write is the checklist's own `tmux` step, key for key: one place
  // decides what "turn tmux back on" writes.
  it('offers the checklist’s own write when tmux is installed but switched off', () => {
    const tmux = byId(
      statusFacts({ world: { ...settled, tmuxMode: 'off' }, cli, hasCodexAccount: false }),
      'tmux',
    );
    expect(tmux.value).toBe('installed at /opt/homebrew/bin/tmux, off by setting');
    expect(tmux.action.kind).toBe('writeSettings');
    if (tmux.action.kind === 'writeSettings') {
      expect(tmux.action.settings).toEqual([{ key: CONFIG_KEYS.tmux, value: 'auto' }]);
      expect(tmux.action.receipt.length).toBeGreaterThan(0);
    }
  });

  it('carries the install hint for the host when tmux is missing, and none where there is none', () => {
    const mac = byId(
      statusFacts({ world: { ...settled, tmuxBinary: null }, cli, hasCodexAccount: false }),
      'tmux',
    );
    expect(mac.value).toBe('not installed');
    expect(mac.action).toEqual({ kind: 'tmuxInstall', hint: 'brew install tmux' });
    expect(mac.next).toContain('brew install tmux');

    const elsewhere = byId(
      statusFacts({
        world: { ...settled, tmuxBinary: null, platform: 'freebsd' },
        cli,
        hasCodexAccount: false,
      }),
      'tmux',
    );
    expect(elsewhere.action).toEqual({ kind: 'tmuxInstall', hint: undefined });
  });

  it('offers each install one way round, by the contributed command', () => {
    const on = statusFacts({ world: settled, cli, hasCodexAccount: false });
    expect(byId(on, 'hooks').value).toBe('installed');
    expect(byId(on, 'hooks').action).toEqual({ kind: 'command', command: COMMANDS.removeHooks });
    expect(byId(on, 'verbs').action).toEqual({
      kind: 'command',
      command: COMMANDS.removeAgentVerbs,
    });

    const off = statusFacts({
      world: { ...settled, hooksInstalled: false, verbsInstalled: false },
      cli,
      hasCodexAccount: false,
    });
    expect(byId(off, 'hooks').value).toBe('not installed');
    expect(byId(off, 'hooks').action).toEqual({ kind: 'command', command: COMMANDS.installHooks });
    expect(byId(off, 'verbs').action).toEqual({
      kind: 'command',
      command: COMMANDS.installAgentVerbs,
    });
  });

  it('draws no verbs row for a wiring without the verbs manager', () => {
    const facts = statusFacts({
      world: { ...settled, verbsAvailable: false },
      cli,
      hasCodexAccount: false,
    });
    expect(facts.some((f) => f.id === 'verbs')).toBe(false);
  });
});

describe('status: the binaries', () => {
  it('names the claude found, or the key to set, and opens the editor there', () => {
    const found = byId(statusFacts({ world: settled, cli, hasCodexAccount: false }), 'claude');
    expect(found.value).toBe('found at /usr/local/bin/claude');
    expect(found.action).toEqual({ kind: 'openSetting', key: 'lineage.claudeBinary' });

    const missing = byId(
      statusFacts({ world: settled, cli: { ...cli, claude: null }, hasCodexAccount: false }),
      'claude',
    );
    expect(missing.value).toBe('not found — set lineage.claudeBinary');
    expect(missing.action).toEqual({ kind: 'openSetting', key: 'lineage.claudeBinary' });
  });

  it('draws the codex row only for a Codex account or a configured path', () => {
    const nobody = statusFacts({ world: settled, cli, hasCodexAccount: false });
    expect(nobody.some((f) => f.id === 'codex')).toBe(false);

    const account = byId(statusFacts({ world: settled, cli, hasCodexAccount: true }), 'codex');
    expect(account.value).toBe('not found — set lineage.codexBinary');
    expect(account.action).toEqual({ kind: 'openSetting', key: 'lineage.codexBinary' });

    const configured = byId(
      statusFacts({
        world: settled,
        cli: { ...cli, codex: '/Users/me/.codex/bin/codex', codexConfigured: true },
        hasCodexAccount: false,
      }),
      'codex',
    );
    expect(configured.value).toBe('found at /Users/me/.codex/bin/codex');
  });

  // "Not found" about a machine nothing looked at is a false alarm; the
  // honest answer to a wiring without the probes is no row.
  it('draws no CLI rows at all when the probes are not wired', () => {
    const facts = statusFacts({ world: settled, hasCodexAccount: true });
    expect(facts.map((f) => f.id)).toEqual(['tmux', 'hooks', 'verbs', 'windowModel', 'surface']);
  });
});

describe('status: the two taste rows read as their pickers do', () => {
  it('names the window model with the picker’s label, legacy pair included', () => {
    for (const world of [
      settled,
      { ...settled, mode: 'root' },
      { ...settled, mode: 'project' },
      // The old `(project, false)` pair resolves to Flock only, and the row
      // must say so rather than echo the string in settings.json.
      { ...settled, mode: 'project', workspacesEnabled: false },
    ]) {
      const row = byId(statusFacts({ world, cli, hasCodexAccount: false }), 'windowModel');
      const current = windowModelChoices(world).find((c) => c.current);
      expect(row.value).toBe(current?.label);
      expect(row.action).toEqual({ kind: 'command', command: COMMANDS.chooseWindowModel });
    }
    expect(
      byId(
        statusFacts({
          world: { ...settled, mode: 'project', workspacesEnabled: false },
          cli,
          hasCodexAccount: false,
        }),
        'windowModel',
      ).value,
    ).toBe('Flock only');
  });

  it('names where sessions open with the surface picker’s label, and opens that picker', () => {
    for (const world of [
      settled,
      { ...settled, soloSession: true },
      { ...settled, terminalLocation: 'panel' as const },
      { ...settled, launchMode: 'claudeExtension', claudeExtensionInstalled: true },
    ]) {
      const row = byId(statusFacts({ world, cli, hasCodexAccount: false }), 'surface');
      const current = surfaceChoices(world).find((c) => c.current);
      expect(current, 'a world the picker marks').toBeDefined();
      expect(row.value).toBe(current?.label);
      // The same contributed command the gear runs, by id — not a picker of
      // the Status verb's own.
      expect(row.action).toEqual({ kind: 'command', command: COMMANDS.chooseSurface });
    }
  });

  // The fifth place the picker does not offer yet — a window of its own — is
  // named rather than left as a blank the reader has to explain to themselves.
  it('names the own-window arrangement the picker cannot mark current', () => {
    const row = byId(
      statusFacts({
        world: { ...settled, terminalLocation: 'newWindow' },
        cli,
        hasCodexAccount: false,
      }),
      'surface',
    );
    expect(surfaceChoices({ ...settled, terminalLocation: 'newWindow' }).some((c) => c.current)).toBe(
      false,
    );
    expect(row.value).toBe('Own window per session');
  });
});

describe('status: the settings queries', () => {
  it('filters the editor to this extension by its manifest id', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
    ) as { publisher: string; name: string };
    expect(SETTINGS_QUERY).toBe(`@ext:${pkg.publisher}.${pkg.name}`);
  });

  // `@tag:advanced` is only a list if the manifest tags rows `advanced`; the
  // query and the tag are two halves of one filter.
  it('narrows to a tag the manifest actually uses', () => {
    expect(ADVANCED_SETTINGS_QUERY).toBe(`${SETTINGS_QUERY} @tag:advanced`);
    const tagged = Object.values(contributedSettings()).filter((p) =>
      p.tags?.includes('advanced'),
    );
    expect(tagged.length).toBeGreaterThan(0);
  });
});
