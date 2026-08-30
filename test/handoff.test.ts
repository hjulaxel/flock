// test/handoff.test.ts — the CONTRACT under test: src/handoff.ts.
//
// Pure module, no vscode, no fs. The contract worth pinning:
//
//   handoffRefusal     must PARTITION the world with switchRefusal — same CLI
//                      moves, different CLI hands off. A target both verbs
//                      accept, or both refuse (transcript permitting), is the
//                      bug these tests exist to catch.
//   buildHandoffPrompt the child's entire knowledge of the parent is this
//                      string: the path must be in it, the "not a resume"
//                      wording must survive edits, and nothing may truncate.

import { describe, expect, it } from 'vitest';

import { switchRefusal } from '../src/accounts';
import {
  CLI_DISPLAY_NAME,
  MAX_HANDOFF_PROMPT_CHARS,
  buildHandoffPrompt,
  handoffRefusal,
} from '../src/handoff';
import type { AccountProfile } from '../src/types';

// ------------------------------------------------------------------ helpers

function profile(id: string, over: Partial<AccountProfile> = {}): AccountProfile {
  return {
    id,
    provider: 'claude',
    label: `Label ${id}`,
    order: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const CLAUDE = profile('c1');
const CLAUDE2 = profile('c2');
const CODEX = profile('x1', { provider: 'codex' });
const GENERIC = profile('k1', { provider: 'generic' });
const GEMINI = profile('g1', { provider: 'gemini' });

// -------------------------------------------------------------- handoffRefusal

describe('handoffRefusal', () => {
  it('a missing or deleted target is no-target — before any CLI judgement', () => {
    expect(handoffRefusal(CLAUDE, null, true)).toBe('no-target');
    expect(handoffRefusal(CLAUDE, undefined, true)).toBe('no-target');
    expect(handoffRefusal(CLAUDE, profile('d', { deleted: true, provider: 'codex' }), true)).toBe(
      'no-target',
    );
  });

  it('same CLI is refused — fork and Move to Account… own that world', () => {
    expect(handoffRefusal(CLAUDE, CLAUDE2, true)).toBe('same-cli');
    // generic is an API-key CLAUDE launch: same CLI as a claude account.
    expect(handoffRefusal(CLAUDE, GENERIC, true)).toBe('same-cli');
    expect(handoffRefusal(CODEX, profile('x2', { provider: 'codex' }), true)).toBe('same-cli');
  });

  it('an unpinned conversation reads as claude, exactly as cliOfProfile does', () => {
    expect(handoffRefusal(null, CLAUDE, true)).toBe('same-cli');
    expect(handoffRefusal(undefined, CODEX, true)).toBe(null);
  });

  it('same-cli outranks cannot-host: a gemini target fails on hosting, not CLI', () => {
    // Different CLI (claude → gemini), so the durable same-cli test passes it
    // through, and the capability test is what refuses.
    expect(handoffRefusal(CLAUDE, GEMINI, true)).toBe('cannot-host');
  });

  it('the fork rule verbatim: no transcript yet, no handoff', () => {
    expect(handoffRefusal(CLAUDE, CODEX, false)).toBe('no-transcript');
  });

  it('claude → codex and codex → claude both pass with a transcript', () => {
    expect(handoffRefusal(CLAUDE, CODEX, true)).toBe(null);
    expect(handoffRefusal(CODEX, CLAUDE, true)).toBe(null);
    // Codex → API-key profile is also a cross-CLI continuation.
    expect(handoffRefusal(CODEX, GENERIC, true)).toBe(null);
  });

  it('partitions the world with switchRefusal: every pair is served by exactly one verb', () => {
    const pairs: Array<[AccountProfile | null, AccountProfile]> = [
      [CLAUDE, CLAUDE2],
      [CLAUDE, CODEX],
      [CODEX, CLAUDE],
      [CLAUDE, GENERIC],
      [null, CLAUDE],
      [null, CODEX],
    ];
    for (const [from, to] of pairs) {
      const move = switchRefusal(from, to) === null;
      const handoff = handoffRefusal(from, to, true) === null;
      expect(move !== handoff).toBe(true);
    }
  });
});

// ---------------------------------------------------------- buildHandoffPrompt

describe('buildHandoffPrompt', () => {
  const PATH = '/Users/x/.lineage/profiles/p/projects/-repo/abc.jsonl';

  it('names the transcript path, the source CLI, and says it is not a resume', () => {
    const brief = buildHandoffPrompt({ transcriptPath: PATH, sourceCli: 'claude' });
    expect(brief).toContain(PATH);
    expect(brief).toContain(CLI_DISPLAY_NAME.claude);
    expect(brief).toContain('not a resume');
  });

  it('carries title and cwd when given, and omits their lines when not', () => {
    const bare = buildHandoffPrompt({ transcriptPath: PATH, sourceCli: 'codex' });
    expect(bare).not.toContain('is titled');
    expect(bare).not.toContain('work happens in');
    const full = buildHandoffPrompt({
      transcriptPath: PATH,
      sourceCli: 'codex',
      parentTitle: 'auth 2',
      cwd: '/repo',
    });
    expect(full).toContain('"auth 2"');
    expect(full).toContain('/repo');
    expect(full).toContain(CLI_DISPLAY_NAME.codex);
  });

  it('whitespace-only metadata is omitted, not printed as blank claims', () => {
    const brief = buildHandoffPrompt({
      transcriptPath: PATH,
      sourceCli: 'claude',
      parentTitle: '   ',
      cwd: '',
    });
    expect(brief).not.toContain('is titled');
    expect(brief).not.toContain('work happens in');
  });

  it('refuses an empty path rather than briefing the child to fail', () => {
    expect(() =>
      buildHandoffPrompt({ transcriptPath: '  ', sourceCli: 'claude' }),
    ).toThrow(/empty/);
  });

  it('refuses to exceed the ceiling rather than truncate', () => {
    expect(() =>
      buildHandoffPrompt({
        transcriptPath: PATH,
        sourceCli: 'claude',
        parentTitle: 'x'.repeat(MAX_HANDOFF_PROMPT_CHARS),
      }),
    ).toThrow(/ceiling/);
  });

  it('an ordinary brief stays far under the ceiling', () => {
    const brief = buildHandoffPrompt({
      transcriptPath: PATH,
      sourceCli: 'claude',
      parentTitle: 'auth 2',
      cwd: '/repo',
    });
    expect(brief.length).toBeLessThan(MAX_HANDOFF_PROMPT_CHARS / 4);
  });
});
