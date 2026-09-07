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
  sendRefusalSentence,
} from '../src/forkNote';
import * as forkNote from '../src/forkNote';
import { mayTypeInto } from '../src/roster';

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

// TWO QUESTIONS, not one, and this is the seam between them. The host answers
// "is there a terminal to type into at all"; `mayTypeInto` answers "would
// typing into it answer somebody's permission dialog". No value of SessionHost
// can tell you the second — a parent hosted HERE may be sitting on a prompt
// this very second — so that refusal lives at the keystroke, in
// src/extension.ts's `sendTextToSession`, where the status is known.
describe('the host question is not the may-I-type question', () => {
  it('says `here` for a waiting parent, which the status then refuses', () => {
    // Read together, these two are the whole reason the guard is not here: a
    // deliverable parent is not the same thing as a typeable one.
    expect(forkNoteDeliverable('here')).toBe(true);
    expect(
      mayTypeInto({ status: 'waiting', row: true, rosterOk: true }),
    ).toBe('waiting');
  });

  it('keeps the may-I-type rule out of this module rather than copying it', () => {
    // A second copy of the roster's decision table is the failure mode this
    // pins: two predicates answering "may I type" that can drift apart. This
    // module composes text and asks about the host; the one thing it knows
    // about a refusal is what to SAY, which is text, which is what this module
    // is for.
    expect(Object.keys(forkNote).sort()).toEqual([
      'MAX_FORK_NOTE_CHARS',
      'composeForkNote',
      'forkNoteDeliverable',
      'forkPurposeOf',
      'sendRefusalSentence',
    ]);
  });
});

// THE REFUSAL SENTENCES. Each one is what a user reads when the channel
// declined, so each has to be true of the state it names and has to end in the
// thing that would change it. The bug these are pinned against is the opposite:
// "no terminal in this window" shown about a tab the user was looking at.
describe('sendRefusalSentence', () => {
  it('names the prompt for a waiting session, and what to do', () => {
    const s = sendRefusalSentence('waiting', 'auth work');
    expect(s).toContain('"auth work"');
    expect(s).toContain('waiting for your answer');
    expect(s).toContain('try again');
    // Never the sentence that is false while the tab is open in this window.
    expect(s).not.toContain('no terminal');
  });

  it('says Flock cannot TELL for a provider whose prompts are invisible', () => {
    const s = sendRefusalSentence('blind', 'codex run');
    expect(s).toContain('"codex run"');
    expect(s).toContain('cannot tell');
    // The remedy, because this one is permanent until the user acts: on the
    // default settings a hook-less Codex session never becomes typeable.
    expect(s).toContain('Codex hooks');
    // Not asserted as waiting: Flock does not know that it is.
    expect(s).not.toContain('is waiting for your answer');
  });

  it('says the tab is a shell for a session whose CLI has gone', () => {
    const s = sendRefusalSentence('gone', 'old branch');
    expect(s).toContain('"old branch"');
    expect(s).toContain('shell');
    expect(s).toContain('Relaunch');
  });

  it('leaves `sent` and `no-terminal` to the caller', () => {
    // `sent` needs no sentence; `no-terminal` is caller-specific — the wrap
    // verb names the foreign host, the fork note says nothing at all — so a
    // shared sentence there would be worse than none.
    expect(sendRefusalSentence('sent', 'x')).toBeNull();
    expect(sendRefusalSentence('no-terminal', 'x')).toBeNull();
  });

  it('survives a label that is empty or multi-line', () => {
    // Same one-line channel discipline as the note itself: these go into a
    // notification, and a label is user-supplied.
    expect(sendRefusalSentence('waiting', '')).toContain('"that session"');
    expect(sendRefusalSentence('waiting', '   ')).toContain('"that session"');
    expect(sendRefusalSentence('waiting', 'a\n  b')).toContain('"a b"');
  });
});
