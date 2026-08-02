// SCAFFOLD-owned smoke test. It exists so `npm test` is green from the first
// commit and so the two things every implementer depends on — the frozen
// types contract and the nine verbatim transcript fixtures — are pinned.
// Implementers: do not edit; add your own test/<module>.test.ts instead.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  COMMANDS,
  EXTENSION_ID,
  PROVIDERS,
  PROVIDER_IDS,
  PROVIDER_MEDIA_DIR,
  SESSION_ID_RE,
  STATE_SCHEMA_VERSION,
  contextValueOf,
  isSessionId,
  shortId,
} from '../src/types';

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

describe('scaffold: frozen types contract', () => {
  it('exposes the neutral extension id', () => {
    expect(EXTENSION_ID).toBe('creemux.lineage-sessions');
    // v2 added `projects` and `hiddenFolders` (M7); v3 added `chains` (M10);
    // v4 added `workspaces` (M13); v5 added `accounts` and `accountSettings`
    // (M22).
    expect(STATE_SCHEMA_VERSION).toBe(5);
  });

  it('declares every contributed command id under the lineage. prefix', () => {
    const ids = Object.values(COMMANDS);
    // 15 + resumeSession (M1.5) + 8 project/visibility verbs (M7)
    // + deleteSession/restoreSession (M8) + renameSessionInline (M9)
    // + 4 notification verbs (M12) + switchWorkspace (M13)
    // + deleteStale (M14; replaced M7.1's hideStale)
    // − hideSession/unhideSession (M14: hide verb retired)
    // + chatInProject (M16)
    // + renameProject/renameProjectInline (M17)
    // + forkAndCompact, newSessionIn (M18)
    // + showOnlyActiveSessions/showAllSessions (M19 filter toggle)
    // + mute/unmuteSessionNotifications (M19; replaced toggleSessionNotifications)
    // + followInExplorer/stopFollowingInExplorer (M21 explorer header)
    // + newSessionInBranch (M20 branch chips)
    // + deleteSessions (multi-select plural verb)
    // + 7 branch-curation verbs (M20: hide/showBranches, fold/unfold,
    //   reveal, copy name, copy path)
    // + 10 account verbs (M22)
    // − askSession (M24: the third fork verb, retired)
    // + chatHistory, closeProject, reopenProject (M24)
    expect(ids).toHaveLength(62);
    expect(new Set(ids).size).toBe(ids.length);
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
    for (const name of ['chat.svg', 'add.svg', 'bell-slash.svg']) {
      const file = path.join(ROOT, 'media', 'icons', name);
      expect(fs.existsSync(file), name).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).toContain('<svg');
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
