// test/accountMove.test.ts — moving a conversation between accounts
// (src/accountMove.ts).
//
// The contract under test, and all of it is about the filesystem: exactly ONE
// transcript for a session id exists at any moment, the sidecars follow, and
// nothing is overwritten. Real temp dirs rather than a mocked fs — rename
// semantics, directory creation and "does this path already exist" ARE the
// mechanism, and a mock would be testing the mock.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  SESSION_SIDECAR_DIRS,
  SET_ASIDE_SUFFIX,
  moveConversation,
  projectsRootOf,
  setAsideTranscript,
  sourceDirFor,
  transcriptCopyInConfigDir,
  transcriptInConfigDir,
} from '../src/accountMove';

const SESSION = '11111111-2222-3333-4444-555555555555';
const SLUG = '-Users-someone-code-thing';

let root: string;
let fromDir: string;
let toDir: string;

/** A transcript for `id` under `dir`, with `body` as its only line. */
function writeTranscript(dir: string, id: string, body: string): string {
  const target = path.join(projectsRootOf(dir), SLUG, `${id}.jsonl`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body, 'utf-8');
  return target;
}

/** A transcript for `id` under `dir`, in a slug of the caller's choosing —
 *  the slug is the cwd's encoding, so one conversation resumed from a git
 *  worktree of its own repo has a second, different one. */
function writeTranscriptAt(
  dir: string,
  slug: string,
  id: string,
  body: string,
): string {
  const target = path.join(projectsRootOf(dir), slug, `${id}.jsonl`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body, 'utf-8');
  return target;
}

/** Every `<id>.jsonl` anywhere under a config dir's projects root. */
function copiesUnder(dir: string, id: string): string[] {
  const root = projectsRootOf(dir);
  const out: string[] = [];
  for (const sub of fs.readdirSync(root)) {
    const candidate = path.join(root, sub, `${id}.jsonl`);
    if (fs.existsSync(candidate)) out.push(candidate);
  }
  return out;
}

function writeSidecar(dir: string, kind: string, id: string, body: string): void {
  const target = path.join(dir, kind, id);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'entry.json'), body, 'utf-8');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-acctmove-'));
  fromDir = path.join(root, 'from');
  toDir = path.join(root, 'to');
  fs.mkdirSync(fromDir, { recursive: true });
  fs.mkdirSync(toDir, { recursive: true });
});

afterEach(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('accountMove: locating a transcript in one account', () => {
  it('finds it under any project slug', () => {
    const written = writeTranscript(fromDir, SESSION, '{}\n');
    expect(transcriptInConfigDir(fromDir, SESSION)).toBe(written);
  });

  it('answers null for an account that does not hold it', () => {
    writeTranscript(fromDir, SESSION, '{}\n');
    expect(transcriptInConfigDir(toDir, SESSION)).toBeNull();
  });

  it('answers null rather than escaping the projects root', () => {
    // The id reaches this module from a command argument, so traversal is
    // refused here and not only at the call site.
    expect(transcriptInConfigDir(fromDir, '../../etc/passwd')).toBeNull();
    expect(transcriptInConfigDir(fromDir, '..')).toBeNull();
  });
});

describe('accountMove: the move', () => {
  it('moves the transcript and leaves exactly one copy', async () => {
    const before = writeTranscript(fromDir, SESSION, '{"a":1}\n');

    const result = await moveConversation({ sessionId: SESSION, fromDir, toDir });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(before)).toBe(false);
    const after = transcriptInConfigDir(toDir, SESSION);
    expect(after).not.toBeNull();
    expect(result.transcriptPath).toBe(after);
    // THE INVARIANT: the id resolves in exactly one account. Two copies would
    // let transcript.transcriptFile answer with whichever root it scanned
    // first, which after a move is the stale one.
    expect(transcriptInConfigDir(fromDir, SESSION)).toBeNull();
  });

  it('keeps the project slug, so the resume looks in the same place', async () => {
    writeTranscript(fromDir, SESSION, '{}\n');
    await moveConversation({ sessionId: SESSION, fromDir, toDir });
    expect(
      fs.existsSync(path.join(projectsRootOf(toDir), SLUG, `${SESSION}.jsonl`)),
    ).toBe(true);
  });

  it('does not alter a single byte of the conversation', async () => {
    const body = '{"type":"user"}\n{"type":"assistant"}\n';
    writeTranscript(fromDir, SESSION, body);
    await moveConversation({ sessionId: SESSION, fromDir, toDir });
    const after = transcriptInConfigDir(toDir, SESSION);
    expect(fs.readFileSync(after as string, 'utf-8')).toBe(body);
  });

  it('takes the sidecars with it', async () => {
    writeTranscript(fromDir, SESSION, '{}\n');
    for (const kind of SESSION_SIDECAR_DIRS) {
      writeSidecar(fromDir, kind, SESSION, `{"kind":"${kind}"}`);
    }

    const result = await moveConversation({ sessionId: SESSION, fromDir, toDir });

    expect(result.ok).toBe(true);
    expect([...result.sidecars].sort()).toEqual([...SESSION_SIDECAR_DIRS].sort());
    expect(result.skipped).toEqual([]);
    for (const kind of SESSION_SIDECAR_DIRS) {
      expect(fs.existsSync(path.join(fromDir, kind, SESSION))).toBe(false);
      expect(
        fs.readFileSync(path.join(toDir, kind, SESSION, 'entry.json'), 'utf-8'),
      ).toBe(`{"kind":"${kind}"}`);
    }
  });

  it('does not invent sidecars that were never there', async () => {
    writeTranscript(fromDir, SESSION, '{}\n');
    const result = await moveConversation({ sessionId: SESSION, fromDir, toDir });
    expect(result.sidecars).toEqual([]);
    expect(result.skipped).toEqual([]);
    for (const kind of SESSION_SIDECAR_DIRS) {
      expect(fs.existsSync(path.join(toDir, kind, SESSION))).toBe(false);
    }
  });

  it('leaves another session in the same slug alone', async () => {
    const other = '99999999-8888-7777-6666-555555555555';
    writeTranscript(fromDir, SESSION, '{}\n');
    const untouched = writeTranscript(fromDir, other, '{"other":true}\n');

    await moveConversation({ sessionId: SESSION, fromDir, toDir });

    expect(fs.existsSync(untouched)).toBe(true);
    expect(transcriptInConfigDir(toDir, other)).toBeNull();
  });
});

describe('accountMove: the refusals', () => {
  it('refuses when the source account does not hold the conversation', async () => {
    const result = await moveConversation({ sessionId: SESSION, fromDir, toDir });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('nothing to move');
  });

  it('refuses rather than overwrite a transcript already at the target', async () => {
    const source = writeTranscript(fromDir, SESSION, '{"which":"source"}\n');
    const target = writeTranscript(toDir, SESSION, '{"which":"target"}\n');

    const result = await moveConversation({ sessionId: SESSION, fromDir, toDir });

    expect(result.ok).toBe(false);
    // BOTH still exist and both still say what they said: one of these is a
    // conversation, and the move has no way to tell which.
    expect(fs.readFileSync(source, 'utf-8')).toBe('{"which":"source"}\n');
    expect(fs.readFileSync(target, 'utf-8')).toBe('{"which":"target"}\n');
  });

  it('is a no-op when both accounts share a config directory', async () => {
    // Two accounts resolve here: the default account and any provider with no
    // config-dir variable. Renaming a file onto itself is not the answer.
    const written = writeTranscript(fromDir, SESSION, '{}\n');
    const result = await moveConversation({
      sessionId: SESSION,
      fromDir,
      toDir: fromDir,
    });
    expect(result.ok).toBe(true);
    expect(result.transcriptPath).toBeUndefined();
    expect(fs.readFileSync(written, 'utf-8')).toBe('{}\n');
  });

  it('refuses an empty session id or directory without touching anything', async () => {
    writeTranscript(fromDir, SESSION, '{}\n');
    for (const bad of [
      { sessionId: '', fromDir, toDir },
      { sessionId: SESSION, fromDir: '', toDir },
      { sessionId: SESSION, fromDir, toDir: '' },
    ]) {
      const result = await moveConversation(bad);
      expect(result.ok).toBe(false);
    }
    expect(transcriptInConfigDir(fromDir, SESSION)).not.toBeNull();
  });

  it('survives a sidecar that cannot land, once the transcript has', async () => {
    writeTranscript(fromDir, SESSION, '{}\n');
    writeSidecar(fromDir, 'tasks', SESSION, '{}');
    // Something is already at the sidecar's destination. The transcript has
    // moved by the time this is discovered, so the move stands and says which
    // sidecar stayed behind — rolling the conversation back to rescue a task
    // list would risk the one file that matters.
    fs.mkdirSync(path.join(toDir, 'tasks', SESSION), { recursive: true });

    const result = await moveConversation({ sessionId: SESSION, fromDir, toDir });

    expect(result.ok).toBe(true);
    expect(transcriptInConfigDir(toDir, SESSION)).not.toBeNull();
    expect(result.skipped).toEqual(['tasks']);
    expect(result.sidecars).toEqual([]);
  });
});

describe('accountMove: sourceDirFor — the pin is a claim, the file is the fact', () => {
  it('answers with the preferred dir when the pin is right', () => {
    writeTranscript(fromDir, SESSION, '{}\n');
    expect(
      sourceDirFor(SESSION, { preferred: fromDir, roots: [fromDir, toDir] }),
    ).toEqual({ dir: fromDir, matchedPreferred: true });
  });

  it('finds it in another account when the pin has come apart from the bytes', () => {
    // Not a hypothetical: the tmux environment leak this change also fixes is a
    // mechanism that produced exactly this state, by resuming a moved
    // conversation under the config dir it had just left. Before this the verb
    // stopped the process, then refused with "no transcript in the account it
    // is pinned to" — a sentence about a pin, for a conversation sitting on
    // disk one directory over.
    const third = path.join(root, 'third');
    fs.mkdirSync(third, { recursive: true });
    writeTranscript(third, SESSION, '{}\n');
    expect(
      sourceDirFor(SESSION, { preferred: fromDir, roots: [fromDir, toDir, third] }),
    ).toEqual({ dir: third, matchedPreferred: false });
  });

  it('is null when the conversation is in none of them', () => {
    expect(
      sourceDirFor(SESSION, { preferred: fromDir, roots: [fromDir, toDir] }),
    ).toBeNull();
    // And with nothing to search at all, rather than throwing.
    expect(sourceDirFor(SESSION, { preferred: '', roots: [] })).toBeNull();
  });

  it('refuses a session id shaped like a traversal', () => {
    // Same guard `transcriptInConfigDir` applies, re-asserted through the new
    // entry point: this module is reachable from a command argument.
    expect(
      sourceDirFor('../../etc', { preferred: fromDir, roots: [fromDir] }),
    ).toBeNull();
  });

  it('still leaves exactly one transcript when the move runs from what it found', () => {
    // The module's own invariant, re-asserted across the self-healing path:
    // two copies of one transcript resolve to whichever root is scanned first,
    // which after a move is the stale one.
    const third = path.join(root, 'third');
    fs.mkdirSync(third, { recursive: true });
    writeTranscript(third, SESSION, '{"who":"third"}\n');

    const found = sourceDirFor(SESSION, {
      preferred: fromDir,
      roots: [fromDir, toDir, third],
    });
    expect(found?.dir).toBe(third);

    return moveConversation({
      sessionId: SESSION,
      fromDir: found!.dir,
      toDir,
    }).then((result) => {
      expect(result.ok).toBe(true);
      expect(transcriptInConfigDir(toDir, SESSION)).not.toBeNull();
      expect(transcriptInConfigDir(third, SESSION)).toBeNull();
      expect(transcriptInConfigDir(fromDir, SESSION)).toBeNull();
    });
  });
});

describe('accountMove: the collision guard is per-ACCOUNT, not per-slug', () => {
  it('refuses when the destination already holds this id under ANY slug', async () => {
    // The guard used to ask "is there a file at the exact path I am about to
    // write", which is strictly narrower than the invariant this module's header
    // claims to enforce. A copy under another slug sailed through, the rename
    // landed beside it, and one account ended up holding two files named after
    // one conversation — the state every reader then has to guess its way out
    // of. Different slugs are ordinary: the slug encodes the cwd, and a
    // conversation resumed from a worktree of its own repo has a different one.
    writeTranscriptAt(fromDir, '-Users-me-repo', SESSION, '{"which":"source"}\n');
    writeTranscriptAt(
      toDir,
      '-Users-me-repo-worktree',
      SESSION,
      '{"which":"stale"}\n',
    );

    const result = await moveConversation({ sessionId: SESSION, fromDir, toDir });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('-Users-me-repo-worktree');
    expect(copiesUnder(toDir, SESSION)).toHaveLength(1);
    expect(copiesUnder(fromDir, SESSION)).toHaveLength(1);
  });

  it('reports the path it actually found, not the one it was going to write', async () => {
    writeTranscriptAt(fromDir, '-a', SESSION, '{}\n');
    const blocking = writeTranscriptAt(toDir, '-b', SESSION, '{}\n');
    const result = await moveConversation({ sessionId: SESSION, fromDir, toDir });
    expect(result.error).toContain(blocking);
  });
});

describe('accountMove: setting a duplicate aside', () => {
  it('renames rather than deletes, and the bytes are still readable', async () => {
    // Nothing is deleted on purpose: when an id exists twice, one of those files
    // is somebody's conversation and this module cannot tell which — that is the
    // whole reason the move refuses instead of overwriting.
    const file = writeTranscript(toDir, SESSION, '{"which":"other"}\n');
    const result = await setAsideTranscript(file);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(result.path).toContain(SET_ASIDE_SUFFIX);
    expect(fs.readFileSync(result.path as string, 'utf-8')).toBe(
      '{"which":"other"}\n',
    );
  });

  it('takes the id out of every reader\'s namespace, because the name stops ending in .jsonl', async () => {
    const file = writeTranscript(toDir, SESSION, '{}\n');
    expect(transcriptInConfigDir(toDir, SESSION)).toBe(file);
    await setAsideTranscript(file);
    expect(transcriptInConfigDir(toDir, SESSION)).toBeNull();
    expect(path.extname(String((await setAsideTranscript(file)).path))).not.toBe(
      '.jsonl',
    );
  });

  it('unblocks the move that refused, which is the whole point', async () => {
    const mine = writeTranscript(fromDir, SESSION, '{"which":"mine"}\n');
    const blocking = writeTranscriptAt(toDir, '-elsewhere', SESSION, '{}\n');

    const refused = await moveConversation({ sessionId: SESSION, fromDir, toDir });
    expect(refused.ok).toBe(false);

    expect((await setAsideTranscript(blocking)).ok).toBe(true);
    const second = await moveConversation({ sessionId: SESSION, fromDir, toDir });
    expect(second.ok).toBe(true);
    expect(copiesUnder(toDir, SESSION)).toHaveLength(1);
    expect(fs.existsSync(mine)).toBe(false);
  });

  it('does not clobber a file already set aside under the same name', async () => {
    const first = writeTranscript(toDir, SESSION, '{"n":1}\n');
    const one = await setAsideTranscript(first);
    const second = writeTranscript(toDir, SESSION, '{"n":2}\n');
    fs.utimesSync(
      second,
      fs.statSync(one.path as string).mtimeMs / 1000,
      fs.statSync(one.path as string).mtimeMs / 1000,
    );
    const two = await setAsideTranscript(second);
    expect(two.ok).toBe(true);
    expect(two.path).not.toBe(one.path);
    expect(fs.readFileSync(one.path as string, 'utf-8')).toBe('{"n":1}\n');
    expect(fs.readFileSync(two.path as string, 'utf-8')).toBe('{"n":2}\n');
  });

  it('says no rather than throwing when there is nothing there', async () => {
    const result = await setAsideTranscript(path.join(toDir, 'nope.jsonl'));
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('accountMove: transcriptCopyInConfigDir', () => {
  it('carries the size and the mtime, so a refusal can describe what it found', () => {
    const file = writeTranscript(fromDir, SESSION, '{"a":1}\n');
    const facts = transcriptCopyInConfigDir(fromDir, SESSION);
    expect(facts?.path).toBe(file);
    expect(facts?.bytes).toBe(fs.statSync(file).size);
    expect(facts?.mtimeMs).toBe(fs.statSync(file).mtimeMs);
  });

  it('is null for an account that does not hold it', () => {
    expect(transcriptCopyInConfigDir(toDir, SESSION)).toBeNull();
  });
});
