// test/forkNote.test.ts — the sentence a fork types into its parent.
//
// The transport is `terminal.sendText(text, true)`, which appends the newline
// itself, so an embedded \n submits the note early and the rest lands as a
// second turn in somebody's conversation. That contract is what most of these
// pin — the same one test/commands.test.ts pins for WRAP_PROMPT.

import { describe, expect, it } from 'vitest';

import {
  MAX_FORK_NOTE_CHARS,
  composeForkNote,
  forkNoteDeliverable,
  forkPurposeOf,
} from '../src/forkNote';

describe('composeForkNote', () => {
  it('is a non-empty single line, trimmed and capped', () => {
    const note = composeForkNote({
      childLabel: 'auth 3',
      purpose: 'try the redis cache',
    });
    expect(note.length).toBeGreaterThan(0);
    expect(note).not.toContain('\n');
    expect(note.trim()).toBe(note);
    expect(note.length).toBeLessThanOrEqual(MAX_FORK_NOTE_CHARS);
  });

  it('caps a very long purpose rather than the branch name', () => {
    const note = composeForkNote({
      childLabel: 'auth 3',
      purpose: 'x'.repeat(5000),
    });
    expect(note.length).toBeLessThanOrEqual(MAX_FORK_NOTE_CHARS);
    // The name survives whole: a note whose reason is cut still tells you
    // which row to go and look at; one whose name is cut is unusable.
    expect(note).toContain('"auth 3"');
    expect(note).toContain('…');
  });

  it('folds a multi-line prompt onto one line', () => {
    const note = composeForkNote({
      childLabel: 'auth 3',
      purpose: 'first line\nsecond line\n\nthird',
    });
    expect(note).not.toContain('\n');
    expect(note).toContain('first line second line third');
  });

  it('names the branch and what it is for', () => {
    const note = composeForkNote({
      childLabel: 'redis cache',
      purpose: 'try the redis cache',
    });
    expect(note).toContain('"redis cache"');
    expect(note).toContain('try the redis cache');
  });

  it('invents no purpose when there is none', () => {
    const note = composeForkNote({ childLabel: 'auth 3' });
    expect(note).toContain('"auth 3"');
    // The tell of an invented reason: `defaultForkTitle`'s counter announced
    // to the parent as if it were something the user asked for.
    expect(note).not.toContain('It is for');
  });

  it('never cuts an emoji in half when it truncates', () => {
    // The cap counts UTF-16 units, which is what the terminal channel spends —
    // so a cut can land between the two halves of a surrogate pair and leave a
    // lone high surrogate, i.e. a replacement glyph typed into somebody's
    // conversation. A label of 60 bird emoji is 120 units against the 80-unit
    // label budget, so the cut falls mid-pair.
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
    expect(composeForkNote({ childLabel: '\u{1F426}'.repeat(60) })).not.toMatch(
      lone,
    );
    // And the purpose half, which is truncated by a budget computed at runtime.
    expect(
      composeForkNote({
        childLabel: 'auth 3',
        purpose: '\u{1F426}'.repeat(400),
      }),
    ).not.toMatch(lone);
  });

  it('survives an empty label rather than quoting nothing', () => {
    const note = composeForkNote({ childLabel: '   ' });
    expect(note).not.toContain('""');
    expect(note.length).toBeGreaterThan(0);
  });
});

describe('forkPurposeOf', () => {
  it('prefers the opening prompt, the one thing a person typed about purpose', () => {
    expect(
      forkPurposeOf({
        prompt: 'try the redis cache',
        title: 'auth 3',
        generatedTitle: true,
      }),
    ).toBe('try the redis cache');
  });

  it('falls back to a title the caller gave, but never to a generated one', () => {
    expect(forkPurposeOf({ title: 'redis cache', generatedTitle: false })).toBe(
      'redis cache',
    );
    expect(
      forkPurposeOf({ title: 'auth 3', generatedTitle: true }),
    ).toBeUndefined();
  });

  it('treats whitespace as nothing', () => {
    expect(
      forkPurposeOf({ prompt: '   ', title: '  ', generatedTitle: false }),
    ).toBeUndefined();
  });
});

describe('forkNoteDeliverable', () => {
  // The four SessionHost values. Only a terminal bound in THIS window can be
  // typed into; the other three are the ordinary states — another window's
  // tab, a process Flock never launched, a closed row — in which the note
  // simply does not happen.
  it('is true for a session hosted here and false for the other three', () => {
    expect(forkNoteDeliverable('here')).toBe(true);
    expect(forkNoteDeliverable('flock')).toBe(false);
    expect(forkNoteDeliverable('foreign')).toBe(false);
    expect(forkNoteDeliverable('none')).toBe(false);
  });
});
