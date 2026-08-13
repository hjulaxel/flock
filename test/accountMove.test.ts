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
  moveConversation,
  projectsRootOf,
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
