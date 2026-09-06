// test/codexHooks.test.ts — the entries Flock merges into a Codex hooks.json,
// and the manager that keeps them there.
//
// What matters and is pinned here: the merge is ADDITIVE and REVERSIBLE — a
// file that already carries somebody else's hooks comes out with every one of
// them intact, and strip removes exactly Flock's entries and nothing else; the
// merge refuses (null) anything it cannot read as a hooks document rather than
// overwriting it; and the manager's self-heal honours a hand-removal (clears
// its stored flag; never re-adds) while repairing a partial file.
//
// The consent modal is not driven: against the mock's empty `window`,
// `showInfo` resolves undefined and install() reads that as declined. The
// no-consent paths — already installed, remove, self-heal — are the ones
// tested end to end; the write itself is the tested pure merge behind an
// atomic write hooks.ts already tests.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CODEX_HOOK_EVENTS,
  CODEX_HOOKS_VERSION,
  CodexHooksManager,
  RETIRED_CODEX_HOOK_COMMANDS,
  codexHooksCoverage,
  mergeCodexHooks,
  stripCodexHooks,
} from '../src/codexHooks';
import { CODEX_HOOK_COMMAND, HOOK_COMMAND, eventsFile, parseEventLine } from '../src/hooks';
import type { HookInstallState } from '../src/types';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-codex-hooks-'));
  temps.push(dir);
  return dir;
}

/** A hooks.json as this machine's own already looks: somebody else's hooks. */
const FOREIGN = {
  hooks: {
    SessionStart: [
      {
        hooks: [
          { type: 'command', command: '/Applications/cmux.app/Contents/Resources/bin/cmux claude-hook session-start' },
          { type: 'command', command: 'python3 ~/.magma-os/cmux/hooks/session_hook.py start' },
        ],
      },
    ],
    Stop: [{ hooks: [{ type: 'command', command: '/Applications/cmux.app/Contents/Resources/bin/cmux claude-hook stop' }] }],
  },
  somebodyElsesKey: { keep: true },
};

function parse(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

function commandsOf(doc: Record<string, unknown>, event: string): string[] {
  const hooks = (doc['hooks'] as Record<string, unknown>)[event] as Array<{ hooks: Array<{ command: string }> }>;
  return (hooks ?? []).flatMap((m) => m.hooks.map((h) => h.command));
}

/** The v1 command, exactly as CODEX_HOOKS_VERSION 1 wrote it into users'
 *  files. Pinned here as text, not derived: the retired list exists to
 *  recognise what is ALREADY on disk, and a test that derived it from the
 *  current command would follow any mistake in it. */
const V1_COMMAND =
  '/bin/sh -c \'mkdir -p "$HOME/.lineage"; p=$(cat); [ -n "$p" ] || p=null; ' +
  'printf "{\\"lineage_node_id\\":\\"%s\\",\\"cli\\":\\"codex\\",\\"payload\\":%s}\\n" ' +
  '"${LINEAGE_NODE_ID:-}" "$p" >> "$HOME/.lineage/events.ndjson"\'';

/** A hooks.json as a v1 install left it: FOREIGN plus one v1 entry per event. */
function v1File(): string {
  return mergeCodexHooks(JSON.stringify(FOREIGN), V1_COMMAND, CODEX_HOOK_EVENTS, [])!.text;
}

// ------------------------------------------------------------------ merge

describe('mergeCodexHooks', () => {
  it('into an empty or absent file: one Flock entry per event, nothing else', () => {
    const got = mergeCodexHooks(null);
    expect(got?.changed).toBe(true);
    const doc = parse(got!.text);
    expect(Object.keys(doc)).toEqual(['hooks']);
    expect(Object.keys(doc['hooks'] as object).sort()).toEqual([...CODEX_HOOK_EVENTS].sort());
    for (const event of CODEX_HOOK_EVENTS) {
      expect(commandsOf(doc, event)).toEqual([CODEX_HOOK_COMMAND]);
    }
    expect(got!.text.endsWith('\n')).toBe(true);
    expect(mergeCodexHooks('')?.text).toBe(got!.text);
  });

  it('into a file with other hooks: every foreign entry survives, ours is appended, unknown keys are kept in place', () => {
    const got = mergeCodexHooks(JSON.stringify(FOREIGN));
    expect(got?.changed).toBe(true);
    const doc = parse(got!.text);
    expect(Object.keys(doc)).toEqual(['hooks', 'somebodyElsesKey']);
    expect(doc['somebodyElsesKey']).toEqual({ keep: true });
    expect(commandsOf(doc, 'SessionStart')).toEqual([
      FOREIGN.hooks.SessionStart[0].hooks[0].command,
      FOREIGN.hooks.SessionStart[0].hooks[1].command,
      CODEX_HOOK_COMMAND,
    ]);
    expect(commandsOf(doc, 'Stop')).toEqual([FOREIGN.hooks.Stop[0].hooks[0].command, CODEX_HOOK_COMMAND]);
    expect(commandsOf(doc, 'PermissionRequest')).toEqual([CODEX_HOOK_COMMAND]);
  });

  it('is idempotent: a second merge changes nothing and hands the text back untouched', () => {
    const once = mergeCodexHooks(JSON.stringify(FOREIGN))!.text;
    const twice = mergeCodexHooks(once);
    expect(twice?.changed).toBe(false);
    expect(twice?.text).toBe(once);
  });

  it('fills in only the events that are missing when a file carries some of ours', () => {
    const partial = mergeCodexHooks(null, CODEX_HOOK_COMMAND, ['Stop'])!.text;
    const full = mergeCodexHooks(partial);
    expect(full?.changed).toBe(true);
    expect(commandsOf(parse(full!.text), 'Stop')).toEqual([CODEX_HOOK_COMMAND]);
    expect(codexHooksCoverage(full!.text).missing).toEqual([]);
  });

  it('refuses — null, nothing to write — a file it cannot read as a hooks document', () => {
    expect(mergeCodexHooks('not json')).toBeNull();
    expect(mergeCodexHooks('[1,2]')).toBeNull();
    expect(mergeCodexHooks(JSON.stringify({ hooks: 'a string' }))).toBeNull();
    expect(mergeCodexHooks(JSON.stringify({ hooks: { Stop: { not: 'an array' } } }))).toBeNull();
  });

  it('does not mistake the CLAUDE plugin command for its own', () => {
    const withClaude = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }] } });
    const got = mergeCodexHooks(withClaude);
    expect(commandsOf(parse(got!.text), 'Stop')).toEqual([HOOK_COMMAND, CODEX_HOOK_COMMAND]);
  });

  // v2 changed the command. Everything here is keyed by exact text, so
  // without this the v1 entry would be an orphan — still firing, invisible to
  // Remove, and DOUBLED by the next merge: every Codex event recorded twice.
  it('v2: replaces a v1 entry instead of joining it, and the retired list pins v1 verbatim', () => {
    expect(RETIRED_CODEX_HOOK_COMMANDS).toContain(V1_COMMAND);
    expect(V1_COMMAND).not.toBe(CODEX_HOOK_COMMAND);

    const got = mergeCodexHooks(v1File());
    expect(got?.changed).toBe(true);
    const doc = parse(got!.text);
    for (const event of CODEX_HOOK_EVENTS) {
      const ours = commandsOf(doc, event).filter((c) => c === CODEX_HOOK_COMMAND || c === V1_COMMAND);
      expect(ours).toEqual([CODEX_HOOK_COMMAND]); // exactly one of ours, the new one
    }
    // Foreign entries and unknown keys as they were.
    expect(commandsOf(doc, 'SessionStart').slice(0, 2)).toEqual(FOREIGN.hooks.SessionStart[0].hooks.map((h) => h.command));
    expect(doc['somebodyElsesKey']).toEqual({ keep: true });
    // And a second merge is a no-op: the upgrade is idempotent too.
    expect(mergeCodexHooks(got!.text)?.changed).toBe(false);
  });
});

// ------------------------------------------------------------------ strip

describe('stripCodexHooks', () => {
  it('undoes the merge exactly: merge then strip is the original document', () => {
    const merged = mergeCodexHooks(JSON.stringify(FOREIGN))!.text;
    const stripped = stripCodexHooks(merged);
    expect(stripped?.changed).toBe(true);
    expect(parse(stripped!.text)).toEqual(FOREIGN);
  });

  it('on a file that was only ours, leaves an empty hooks map rather than nothing', () => {
    const ours = mergeCodexHooks(null)!.text;
    const stripped = stripCodexHooks(ours);
    expect(parse(stripped!.text)).toEqual({ hooks: {} });
  });

  it('a file with none of ours is unchanged; a matcher that mixes ours with another keeps the other', () => {
    const untouched = stripCodexHooks(JSON.stringify(FOREIGN));
    expect(untouched?.changed).toBe(false);
    expect(untouched?.text).toBe(JSON.stringify(FOREIGN));

    const mixed = JSON.stringify({
      hooks: { Stop: [{ matcher: 'x', hooks: [{ type: 'command', command: 'theirs' }, { type: 'command', command: CODEX_HOOK_COMMAND }] }] },
    });
    const got = stripCodexHooks(mixed)!;
    expect(got.changed).toBe(true);
    expect((parse(got.text)['hooks'] as Record<string, unknown>)['Stop']).toEqual([
      { matcher: 'x', hooks: [{ type: 'command', command: 'theirs' }] },
    ]);
  });

  it('refuses what merge refuses, and passes a hookless document through', () => {
    expect(stripCodexHooks('nope')).toBeNull();
    expect(stripCodexHooks(JSON.stringify({ hooks: 3 }))).toBeNull();
    expect(stripCodexHooks(JSON.stringify({ other: 1 }))).toEqual({ text: '{"other":1}', changed: false });
  });

  it('v2: removes a v1 entry too — Remove must not leave an earlier version firing', () => {
    const stripped = stripCodexHooks(v1File());
    expect(stripped?.changed).toBe(true);
    expect(parse(stripped!.text)).toEqual(FOREIGN);
  });
});

describe('codexHooksCoverage', () => {
  it('names present and missing events; junk is all-missing', () => {
    const partial = mergeCodexHooks(null, CODEX_HOOK_COMMAND, ['Stop', 'SessionEnd'])!.text;
    const cov = codexHooksCoverage(partial);
    expect(cov.present.sort()).toEqual(['SessionEnd', 'Stop']);
    expect(cov.missing).toHaveLength(CODEX_HOOK_EVENTS.length - 2);
    expect(cov.retired).toEqual([]);
    expect(codexHooksCoverage('junk').present).toEqual([]);
    expect(codexHooksCoverage(null).missing).toHaveLength(CODEX_HOOK_EVENTS.length);
  });

  it('v2: a v1 file is all-missing for the current command and all-retired', () => {
    const cov = codexHooksCoverage(v1File());
    expect(cov.present).toEqual([]);
    expect(cov.missing).toHaveLength(CODEX_HOOK_EVENTS.length);
    expect(cov.retired.sort()).toEqual([...CODEX_HOOK_EVENTS].sort());
  });
});

// ------------------------------------------------------------- the command

describe('CODEX_HOOK_COMMAND', () => {
  it('differs from the Claude command only by the cli field, and the parser reads it back', () => {
    expect(CODEX_HOOK_COMMAND).not.toBe(HOOK_COMMAND);
    expect(CODEX_HOOK_COMMAND.replace('\\"cli\\":\\"codex\\",', '')).toBe(HOOK_COMMAND);
    // What the command's printf emits, for a Stop payload shaped as Codex writes it.
    const line = JSON.stringify({
      lineage_node_id: '0f0000a1-0000-4000-8000-0000000000a1',
      cli: 'codex',
      payload: {
        hook_event_name: 'Stop',
        session_id: '01a072bd-848d-7fc0-9e53-82e2cfda013e',
        transcript_path: '/h/.codex/sessions/2026/09/05/rollout-x.jsonl',
        cwd: '/w',
        stop_hook_active: false,
      },
    });
    const event = parseEventLine(line);
    expect(event?.cli).toBe('codex');
    expect(event?.event).toBe('Stop');
    expect(event?.sessionId).toBe('01a072bd-848d-7fc0-9e53-82e2cfda013e');
    expect(event?.nodeId).toBe('0f0000a1-0000-4000-8000-0000000000a1');
    // The Claude wrapper carries no cli and reads as claude; the flat v2
    // shape has no wrapper and says nothing.
    expect(parseEventLine(JSON.stringify({ lineage_node_id: '', payload: { hook_event_name: 'Stop' } }))?.cli).toBe('claude');
    expect(parseEventLine(JSON.stringify({ hook_event_name: 'Stop' }))?.cli).toBeNull();
  });

  it('v2: opens with umask 077, so what it creates is private to the user', () => {
    // The payload is prompts and replies; the directory and file it creates
    // must not inherit the hook process's 022. hooks.test.ts runs the command
    // for real and checks the resulting modes.
    expect(CODEX_HOOK_COMMAND.startsWith("/bin/sh -c 'umask 077; mkdir -p")).toBe(true);
    expect(CODEX_HOOKS_VERSION).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------- manager

function makeManager(home: string, homes: string[] = [], initial: HookInstallState = { installed: false }) {
  let stored = initial;
  const manager = new CodexHooksManager(
    {
      getStored: () => stored,
      setStored: async (s) => {
        stored = s;
      },
    },
    { home, homes: () => homes },
  );
  return { manager, stored: () => stored };
}

describe('CodexHooksManager', () => {
  it('lists ~/.codex/hooks.json first and each account home once', () => {
    const home = tempHome();
    const { manager } = makeManager(home, ['/acct/a', '/acct/a/', '/acct/b']);
    expect(manager.files()).toEqual([
      path.join(home, '.codex', 'hooks.json'),
      path.join('/acct/a', 'hooks.json'),
      path.join('/acct/b', 'hooks.json'),
    ]);
  });

  it('install with everything already present needs no consent and records the install', async () => {
    const home = tempHome();
    const file = path.join(home, '.codex', 'hooks.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, mergeCodexHooks(JSON.stringify(FOREIGN))!.text);
    const { manager, stored } = makeManager(home);
    const state = await manager.install();
    expect(state.installed).toBe(true);
    expect(state.pluginDir).toBe(file);
    expect(state.pluginVersion).toBe(CODEX_HOOKS_VERSION);
    expect(stored().installed).toBe(true);
    expect(manager.isInstalled()).toBe(true);
    // And the foreign hooks are exactly as they were.
    expect(commandsOf(parse(fs.readFileSync(file, 'utf8')), 'Stop')[0]).toBe(FOREIGN.hooks.Stop[0].hooks[0].command);
  });

  it('install without consent (the mock has no modal) writes nothing', async () => {
    const home = tempHome();
    const { manager, stored } = makeManager(home);
    const state = await manager.install();
    expect(state.installed).toBe(false);
    expect(stored().installed).toBe(false);
    expect(fs.existsSync(path.join(home, '.codex', 'hooks.json'))).toBe(false);
  });

  it('remove strips only our entries from every home and clears the flag', async () => {
    const home = tempHome();
    const acct = path.join(home, 'acct');
    const files = [path.join(home, '.codex', 'hooks.json'), path.join(acct, 'hooks.json')];
    for (const file of files) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, mergeCodexHooks(JSON.stringify(FOREIGN))!.text);
    }
    const { manager, stored } = makeManager(home, [acct], { installed: true, pluginDir: files[0] });
    const state = await manager.remove();
    expect(state.installed).toBe(false);
    expect(stored().installed).toBe(false);
    for (const file of files) expect(parse(fs.readFileSync(file, 'utf8'))).toEqual(FOREIGN);
  });

  // The SAME events file the Claude plugin writes, and the same rule on
  // removal: cleared by truncation, never unlinked — a watcher in another
  // window keeps the inode and rewinds; an unlinked file would leave it
  // tailing a ghost while the next hook recreates the file beside it.
  it('remove clears the recorded events but keeps the file: same inode, zero bytes', async () => {
    const home = tempHome();
    const hooks = path.join(home, '.codex', 'hooks.json');
    fs.mkdirSync(path.dirname(hooks), { recursive: true });
    fs.writeFileSync(hooks, mergeCodexHooks(JSON.stringify(FOREIGN))!.text);
    const events = eventsFile(home);
    fs.mkdirSync(path.dirname(events), { recursive: true });
    fs.writeFileSync(events, '{"cli":"codex","payload":{"prompt":"my secret plan"}}\n');
    const ino = fs.statSync(events).ino;
    const { manager } = makeManager(home, [], { installed: true, pluginDir: hooks });

    await manager.remove();
    expect(fs.existsSync(events)).toBe(true);
    expect(fs.statSync(events).size).toBe(0);
    expect(fs.statSync(events).ino).toBe(ino);
    // The hooks file itself came out exactly as it went in, minus ours.
    expect(parse(fs.readFileSync(hooks, 'utf8'))).toEqual(FOREIGN);
  });

  it('remove clears the events even when no file carried our entries, and never creates one', async () => {
    const home = tempHome();
    const events = eventsFile(home);
    fs.mkdirSync(path.dirname(events), { recursive: true });
    fs.writeFileSync(events, '{}\n{}\n');
    const { manager } = makeManager(home, [], { installed: true });
    await manager.remove();
    expect(fs.statSync(events).size).toBe(0);

    const bare = tempHome();
    await makeManager(bare, [], { installed: true }).manager.remove();
    expect(fs.existsSync(eventsFile(bare))).toBe(false);
  });

  it('self-heal: hand-removed entries clear the stored flag and are NOT re-added', async () => {
    const home = tempHome();
    const file = path.join(home, '.codex', 'hooks.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(FOREIGN));
    const { manager, stored } = makeManager(home, [], { installed: true, pluginDir: file, pluginVersion: CODEX_HOOKS_VERSION });
    const state = await manager.selfHeal();
    expect(state.installed).toBe(false);
    expect(stored().installed).toBe(false);
    expect(parse(fs.readFileSync(file, 'utf8'))).toEqual(FOREIGN);
  });

  // The upgrade path every existing Codex install takes on the first activate
  // after v2: the file carries only the v1 command and the stored version is
  // 1. Before the retired list, this read as "hand-removed" — flag cleared,
  // v1 entry left firing, and the next install would have doubled it.
  it('self-heal: v2 rewrites a v1 install in place — one entry per event, the new command, foreign hooks intact', async () => {
    const home = tempHome();
    const file = path.join(home, '.codex', 'hooks.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, v1File());
    const { manager, stored } = makeManager(home, [], { installed: true, pluginDir: file, pluginVersion: 1 });

    const state = await manager.selfHeal();
    expect(state.installed).toBe(true);
    expect(state.pluginVersion).toBe(CODEX_HOOKS_VERSION);
    expect(stored().installed).toBe(true);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain(V1_COMMAND);
    expect(codexHooksCoverage(text).missing).toEqual([]);
    expect(codexHooksCoverage(text).retired).toEqual([]);
    expect(manager.isInstalled()).toBe(true);
    // Strip what we wrote and FOREIGN is exactly what remains.
    expect(parse(stripCodexHooks(text)!.text)).toEqual(FOREIGN);
  });

  it('remove strips a v1 install too', async () => {
    const home = tempHome();
    const file = path.join(home, '.codex', 'hooks.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, v1File());
    const { manager, stored } = makeManager(home, [], { installed: true, pluginDir: file, pluginVersion: 1 });
    await manager.remove();
    expect(stored().installed).toBe(false);
    expect(parse(fs.readFileSync(file, 'utf8'))).toEqual(FOREIGN);
  });

  it('self-heal: a file with SOME of our entries gets the rest back; a foreign-only account file is left alone', async () => {
    const home = tempHome();
    const file = path.join(home, '.codex', 'hooks.json');
    const acct = path.join(home, 'acct');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(acct, { recursive: true });
    fs.writeFileSync(file, mergeCodexHooks(JSON.stringify(FOREIGN), CODEX_HOOK_COMMAND, ['Stop'])!.text);
    fs.writeFileSync(path.join(acct, 'hooks.json'), JSON.stringify(FOREIGN));
    const { manager } = makeManager(home, [acct], { installed: true, pluginDir: file, pluginVersion: CODEX_HOOKS_VERSION });
    const state = await manager.selfHeal();
    expect(state.installed).toBe(true);
    expect(codexHooksCoverage(fs.readFileSync(file, 'utf8')).missing).toEqual([]);
    expect(parse(fs.readFileSync(path.join(acct, 'hooks.json'), 'utf8'))).toEqual(FOREIGN);
  });

  it('self-heal: not installed is a no-op that touches no file', async () => {
    const home = tempHome();
    const { manager } = makeManager(home);
    expect((await manager.selfHeal()).installed).toBe(false);
    expect(fs.existsSync(path.join(home, '.codex'))).toBe(false);
  });
});
