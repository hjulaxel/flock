// The two things every other suite in here builds on top of, pinned in one
// place: the shared contract in src/types.ts (command ids, state schema
// version, id shapes, provider table) and the nine transcript fixtures the
// parsing tests read verbatim.
//
// Nothing here exercises a feature. It exists so that a contract change shows
// up as one obvious failure in this file rather than as a scatter of confusing
// failures in the suites that assume the contract holds.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  BRAND_COLOR_ID,
  BRANCH_FEATURE_SWITCHES,
  CLOSED_COLOR_ID,
  COMMANDS,
  COMPACTING_COLOR_ID,
  CONFIG_SECTION,
  DONE_COLOR_ID,
  EXTENSION_ID,
  PROVIDERS,
  PROVIDER_IDS,
  PROVIDER_MEDIA_DIR,
  RUNNING_COLOR_ID,
  SESSION_ID_RE,
  STATE_SCHEMA_VERSION,
  contextValueOf,
  isSessionId,
  shortId,
} from '../src/types';
import type {
  PullRequest,
  PullRequestState,
  RecommendedWorld,
} from '../src/types';
import { recommendedPlan, surfaceChoices } from '../src/recommend';
import { branchStateIcon } from '../src/viewmodel';

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'transcripts');

const FIXTURES = [
  'root.jsonl',
  'native_fork.jsonl',
  'nested_fork.jsonl',
  'cli_fork.jsonl',
  'cli_fork_compact.jsonl',
  'compact_successor.jsonl',
  'headless_fork.jsonl',
  'empty.jsonl',
  'malformed.jsonl',
];

describe('scaffold: transcript fixtures', () => {
  it('ships all nine fixtures', () => {
    const present = fs.readdirSync(FIXTURE_DIR).sort();
    expect(present).toEqual([...FIXTURES].sort());
  });

  it('keeps empty.jsonl empty and every other fixture non-empty', () => {
    for (const name of FIXTURES) {
      const size = fs.statSync(path.join(FIXTURE_DIR, name)).size;
      if (name === 'empty.jsonl') expect(size).toBe(0);
      else expect(size).toBeGreaterThan(0);
    }
  });
});

describe('scaffold: the shared types contract', () => {
  // Cross-checked against the manifest, NOT against a copy of the literals in
  // types.ts. VS Code resolves `vscode://<publisher>.<name>/focus` by extension
  // id, so if these drift apart cross-window focus breaks and nothing else
  // notices — the URI just never arrives. A test that restates the constant
  // cannot catch that; this one can.
  it('derives an extension id that matches package.json', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
    ) as { publisher: string; name: string };
    expect(EXTENSION_ID).toBe(`${pkg.publisher}.${pkg.name}`);
    // Pinned so that bumping the schema is a deliberate two-part edit. Every
    // bump has to be paired with a step in `migrateState`'s ladder
    // (src/state.ts); a bump on its own stamps an old-shaped file as the new
    // version without materialising the maps that version promises, and the
    // reader then finds them missing on a file it believes is current.
    expect(STATE_SCHEMA_VERSION).toBe(8);
  });

  it('declares every contributed command id under the lineage. prefix', () => {
    const ids = Object.values(COMMANDS);
    // The count is pinned so that gaining or losing a verb cannot happen by
    // accident. The manifest cross-check below only proves the two SIDES agree
    // — a bad merge that drops a verb from COMMANDS and its package.json entry
    // together, or a copy-paste that adds one to both, passes it happily. The
    // number is the thing that makes either show up in review.
    //
    // Bump it in the same commit as the verb, and check the new id reaches a
    // menu: a command nobody can invoke is not a feature.
    expect(ids).toHaveLength(89);
    // Duplicate values would make one of them unreachable — the later key wins
    // at registration and the earlier verb's menu entry fires the wrong flow.
    expect(new Set(ids).size).toBe(ids.length);
    // The `lineage.` prefix is what namespaces us in the global command
    // palette; an unprefixed id can collide with another extension's.
    for (const id of ids) expect(id.startsWith('lineage.')).toBe(true);
  });

  // A command in COMMANDS but not in the manifest is invisible to the user; a
  // command in the manifest but not in COMMANDS throws "command not found"
  // when clicked. Only a cross-check catches either, and the count above
  // catches neither.
  it('contributes exactly the COMMANDS set in package.json', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
    ) as { contributes: { commands: { command: string }[] } };
    const contributed = pkg.contributes.commands.map((c) => c.command).sort();
    expect(contributed).toEqual([...Object.values(COMMANDS)].sort());
  });

  // A ThemeColor naming an id the manifest does not contribute resolves to
  // nothing — the badge simply renders in the theme's own foreground, which
  // for the compaction ring means an indistinguishable grey circle and no
  // error anywhere. Only a cross-check catches it.
  it('contributes every colour id the code paints with', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
    ) as { contributes: { colors: { id: string }[] } };
    const contributed = new Set(pkg.contributes.colors.map((c) => c.id));
    for (const id of [
      BRAND_COLOR_ID,
      RUNNING_COLOR_ID,
      DONE_COLOR_ID,
      CLOSED_COLOR_ID,
      COMPACTING_COLOR_ID,
    ]) {
      expect(contributed.has(id)).toBe(true);
    }
  });

  // `lineage.showBranchesAndWorktrees` writes six settings and its partner writes
  // the defaults back, which only works while BRANCH_FEATURE_SWITCHES agrees with
  // the manifest about both halves. A key that is not a real setting is a silent
  // no-op — `update()` on an undeclared key throws, and the command reports it as
  // unwritable — and an `off` value that is not the shipped default turns the
  // Hide half into a verb that leaves the tree somewhere nobody asked for.
  it('turns the branch feature on and off against settings that exist', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
    ) as {
      contributes: {
        configuration: { properties: Record<string, { default?: unknown }> };
      };
    };
    const properties = pkg.contributes.configuration.properties;
    expect(BRANCH_FEATURE_SWITCHES.length).toBe(5);
    for (const { key, on, off } of BRANCH_FEATURE_SWITCHES) {
      const full = `${CONFIG_SECTION}.${key}`;
      const declared = properties[full];
      expect(declared, `${full} is not a contributed setting`).toBeDefined();
      expect(declared.default, `${full} default`).toEqual(off);
      // A switch whose two positions are the same value is a row in this table
      // that does nothing, in either direction.
      expect(on, full).not.toEqual(off);
    }
  });

  // The recommended setup writes settings named by a table in src/recommend.ts,
  // and two things can go silently wrong there. A key that is not a contributed
  // setting makes `update()` throw, so the step reports itself unwritable for a
  // reason nobody can act on. A value outside a string setting's `enum` is
  // written and then ignored by every reader, which looks exactly like the step
  // having worked.
  //
  // NOT asserted: that the value differs from the shipped default. It is true of
  // every step that turns something ON and deliberately false of the one that
  // puts something BACK — `tmux` is offered only to somebody who switched it to
  // `off` by hand, and what it writes is the default they left. A step's value
  // has to differ from the world it was offered in, which is `recommendedPlan`'s
  // own condition and is pinned in test/recommend.test.ts.
  it('recommends settings that exist, and values those settings accept', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
    ) as {
      contributes: {
        configuration: {
          properties: Record<
            string,
            { default?: unknown; type?: string; enum?: unknown[] }
          >;
        };
      };
    };
    const properties = pkg.contributes.configuration.properties;
    // A world in which every settings-bearing step is on offer at once: tmux
    // installed but switched off, and a repository with more than one checkout
    // whose rows are not drawn.
    const world: RecommendedWorld = {
      platform: 'darwin',
      tmuxBinary: '/opt/homebrew/bin/tmux',
      tmuxMode: 'off',
      hooksInstalled: true,
      verbsInstalled: true,
      verbsAvailable: true,
      hasProjects: true,
      unlistedCount: 0,
      branchRowsEnabled: false,
      maxWorktrees: 3,
      terminalLocation: 'editor',
      soloSession: false,
      launchMode: 'flock',
      claudeExtensionInstalled: false,
    };
    // The surface step itself carries no settings — its four OPTIONS do, and
    // each is a write the picker can perform, so each is held to the same
    // manifest contract as a step's own table.
    const entries = [
      ...recommendedPlan(world).steps.flatMap((s) => s.settings),
      ...surfaceChoices(world).flatMap((c) => c.settings),
    ];
    // The loop asserting nothing is the failure mode this guards against.
    expect(entries.length).toBeGreaterThan(0);
    for (const { key, value } of entries) {
      const full = `${CONFIG_SECTION}.${key}`;
      const declared = properties[full];
      expect(declared, `${full} is not a contributed setting`).toBeDefined();
      expect(typeof value, `${full} type`).toBe(declared.type);
      if (declared.enum !== undefined) {
        expect(declared.enum, `${full} accepts ${String(value)}`).toContain(value);
      }
    }
  });

  // docs/settings.md opens with "All N settings" over a table with one row per
  // setting. Both drifted from the manifest silently — the table was two rows
  // short and the header three behind the table — because nothing tied either
  // to `contributes.configuration`. This asserts the SETS match (so a missing
  // or stale row is named, not counted) and that the header's N is the real
  // count. Deliberately no pinned number: two branches adding settings then
  // merge without this test being a third count to resolve.
  //
  // The README's own "all N" is checked here too, and that is the whole reason
  // it is: settings.md was tied to the manifest and the README was not, so a
  // branch that counted its own settings correctly still shipped a README three
  // behind after a merge brought the other branch's in. Two documents claiming a
  // count means two documents to hold to it.
  it('documents every contributed setting in docs/settings.md, and counts them right', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
    ) as {
      contributes: { configuration: { properties: Record<string, unknown> } };
    };
    const contributed = Object.keys(pkg.contributes.configuration.properties);
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'settings.md'), 'utf8');
    const documented = [...doc.matchAll(/^\| `(lineage\.[^`]+)` \|/gm)].map(
      (m) => m[1] as string,
    );
    expect(documented.filter((k) => !contributed.includes(k))).toEqual([]);
    expect(contributed.filter((k) => !documented.includes(k))).toEqual([]);
    const header = doc.match(/^All (\d+) settings, as contributed\./m);
    expect(header, 'the "All N settings" opening line').not.toBeNull();
    expect(Number(header?.[1])).toBe(contributed.length);

    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const pointer = readme.match(/all (\d+), with defaults\./);
    expect(pointer, "the README's Settings pointer").not.toBeNull();
    expect(Number(pointer?.[1])).toBe(contributed.length);
  });

  it('ships an icon file for every provider', () => {
    for (const id of PROVIDER_IDS) {
      const info = PROVIDERS[id];
      expect(info.id).toBe(id);
      const file = path.join(ROOT, PROVIDER_MEDIA_DIR, info.iconFile);
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).toContain('<svg');
    }
  });

  it('ships every row glyph the webview masks', () => {
    // They are fetched by uri under the webview's img-src, so a missing file is
    // a silently empty button (or an unmarked row) rather than an error anyone
    // would notice.
    for (const name of [
      'chat.svg',
      'add.svg',
      'bell-slash.svg',
      // The mark that leads a branch, in each of the states branchStateIcon
      // names. A missing one here is a branch line with a gap where its state
      // should be, on the rows that have the most to say.
      'git-branch.svg',
      'git-pull-request.svg',
      'git-pull-request-draft.svg',
      'git-pull-request-closed.svg',
      'git-merge.svg',
    ]) {
      const file = path.join(ROOT, 'media', 'icons', name);
      expect(fs.existsSync(file), name).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).toContain('<svg');
    }
  });

  it('names a shipped file for every mark branchStateIcon can return', () => {
    // The two halves of one table: the function picks a codicon id, the webview
    // looks that id up in its own svg allowlist, and the native tree hands it
    // straight to a ThemeIcon. A state whose glyph is not on disk draws nothing
    // in the sidebar while looking perfectly correct in the native tree.
    const pr = (state: PullRequestState): PullRequest => ({
      number: 1,
      title: 't',
      state,
      checks: 'none',
      branch: 'b',
      url: 'u',
    });
    const states: PullRequestState[] = ['draft', 'open', 'merged', 'closed'];
    const named = [
      branchStateIcon(undefined),
      ...states.map((s) => branchStateIcon(pr(s))),
    ];
    // Five states, five distinct marks — a duplicate would be a state the reader
    // cannot tell from another.
    expect(new Set(named).size).toBe(named.length);
    for (const name of named) {
      const file = path.join(ROOT, 'media', 'icons', `${name}.svg`);
      expect(fs.existsSync(file), name).toBe(true);
    }
  });

  // An svg reached as a CSS `mask-image` or an <img> src is parsed as STRICT
  // XML, and XML forbids `--` inside a comment. A file that trips it does not
  // warn and does not fall back: it renders as nothing at all, which looks
  // exactly like a button that was never wired up. add.svg shipped that way
  // once — its comment mentioned `--vscode-icon-foreground` — and the plus was
  // invisible while every other layer of the feature worked.
  it('ships no svg with a comment XML would reject', () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return walk(full);
        return e.isFile() && e.name.endsWith('.svg') ? [full] : [];
      });

    const files = walk(path.join(ROOT, 'media'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const name = path.relative(ROOT, file);
      for (let at = text.indexOf('<!--'); at !== -1; at = text.indexOf('<!--', at + 4)) {
        const end = text.indexOf('-->', at + 4);
        expect(end, `${name}: unterminated comment`).toBeGreaterThan(-1);
        const body = text.slice(at + 4, end);
        expect(body.includes('--'), `${name}: '--' inside a comment`).toBe(false);
        at = end;
      }
    }
  });

  // A command whose `icon` names a file that is not there renders as NOTHING in
  // the view title — no glyph, no error — so the bell would simply vanish the
  // moment something went unread.
  it('ships every icon file a command declares', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
    ) as {
      contributes: {
        commands: { command: string; icon?: string | { light: string; dark: string } }[];
      };
    };
    let checked = 0;
    for (const command of pkg.contributes.commands) {
      const icon = command.icon;
      if (icon === undefined || typeof icon === 'string') continue; // $(codicon)
      for (const relative of [icon.light, icon.dark]) {
        const file = path.join(ROOT, relative);
        expect(fs.existsSync(file), `${command.command} -> ${relative}`).toBe(true);
        expect(fs.readFileSync(file, 'utf8')).toContain('<svg');
        checked++;
      }
    }
    // The loop asserting nothing is the failure mode this guards against.
    expect(checked).toBeGreaterThan(0);
  });

  it('gates session ids on the exact uuid shape', () => {
    expect(isSessionId('0f0000a1-0000-4000-8000-0000000000a1')).toBe(true);
    expect(isSessionId('not-a-uuid')).toBe(false);
    expect(isSessionId(42)).toBe(false);
    expect(SESSION_ID_RE.test('0f0000a1-0000-4000-8000-0000000000a1')).toBe(
      true,
    );
    expect(shortId('0f0000a1-0000-4000-8000-0000000000a1')).toBe('0f0000a1');
  });

  it('wraps context tokens so `viewItem =~ /;token;/` cannot half-match', () => {
    expect(contextValueOf(['session', 'live', 'waiting'])).toBe(
      ';session;live;waiting;',
    );
    expect(contextValueOf(['session'])).toContain(';session;');
  });
});
