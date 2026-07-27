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
  SESSION_ID_RE,
  STATE_SCHEMA_VERSION,
  contextValueOf,
  isSessionId,
  shortId,
} from '../src/types';

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
    expect(STATE_SCHEMA_VERSION).toBe(1);
  });

  it('declares every contributed command id under the lineage. prefix', () => {
    const ids = Object.values(COMMANDS);
    expect(ids).toHaveLength(16); // 15 + resumeSession (M1.5)
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith('lineage.')).toBe(true);
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
