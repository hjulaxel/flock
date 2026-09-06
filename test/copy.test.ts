// test/copy.test.ts — user-facing copy that keeps drifting from the code it
// describes. Each assertion here is a specific promise a pre-1.0 review found
// broken: a privacy section that named the wrong network calls, three files
// that still called the finished-turn dot green when `lineage.done` (see
// package.json's contributes.colors) has always painted it `charts.red`, a
// bug template that still said Canopy, and a codicon literal that renders as
// text in markdown instead of an icon. Node fs only — no vscode.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const REFERENCE = fs.readFileSync(path.join(ROOT, 'docs', 'reference.md'), 'utf8');
const BUG_REPORT = fs.readFileSync(
  path.join(ROOT, '.github', 'ISSUE_TEMPLATE', 'bug_report.yml'),
  'utf8',
);

const WALKTHROUGH_DIR = path.join(ROOT, 'media', 'walkthrough');
const walkthroughFiles = fs
  .readdirSync(WALKTHROUGH_DIR)
  .filter((f) => f.endsWith('.md'))
  .map((f) => ({ name: f, text: fs.readFileSync(path.join(WALKTHROUGH_DIR, f), 'utf8') }));

describe('the finished-turn dot is red everywhere, not green', () => {
  // The dot itself is `lineage.done`, which package.json's contributes.colors
  // paints charts.red in every theme — copy that still says "green" is
  // describing a color the UI has never shown for a finished turn. Chips for
  // a pull request are a different green dot and stay out of scope, but
  // nothing in these three files needs that exception today.
  it('README.md never calls a finished turn green', () => {
    expect(/green dot/i.test(README), 'README.md mentions a green dot').toBe(false);
  });

  it('docs/reference.md never calls a finished turn green', () => {
    expect(/green dot/i.test(REFERENCE), 'docs/reference.md mentions a green dot').toBe(false);
  });

  it('every media/walkthrough/*.md never calls a finished turn green', () => {
    for (const file of walkthroughFiles) {
      expect(/green dot/i.test(file.text), `${file.name} mentions a green dot`).toBe(false);
    }
    // Sanity: the directory is not empty and this ran on real files.
    expect(walkthroughFiles.length).toBeGreaterThan(0);
  });
});

describe('the product is named Flock, not Canopy', () => {
  // Canopy was the name before the rename in 0.2.0's settings pass; a bug
  // template that still says it sends every report in with the wrong product
  // name, the wrong output-channel path, and a version field mislabelled.
  it('bug_report.yml never says Canopy', () => {
    expect(BUG_REPORT.includes('Canopy'), 'bug_report.yml mentions Canopy').toBe(false);
  });
});

describe('README.md never leaks codicon syntax', () => {
  // `$(folder-opened)` is VS Code's icon syntax for a button label — it
  // renders as an icon inside the product, but as literal text on a markdown
  // page like the GitHub-rendered README, which is exactly the audience this
  // file is for.
  it('contains no "$(" codicon reference', () => {
    expect(README.includes('$('), 'README.md contains "$(" codicon syntax').toBe(false);
  });
});

/** The `## Privacy` section's own text, up to the next `##` heading (or the
 *  end of the file, if it is the last section). Module scope, not inside a
 *  test: every `it` below reads the same slice. */
function privacySection(): string {
  const start = README.indexOf('## Privacy');
  if (start === -1) return '';
  const end = README.indexOf('\n## ', start + 1);
  return README.slice(start, end === -1 ? undefined : end);
}

describe('the README Privacy section says what actually reaches the network', () => {
  // Every check below is meaningless against the wrong slice, so the heading
  // itself gets its own assertion rather than a silent empty string.
  it('has a ## Privacy section', () => {
    expect(privacySection().length, 'README.md has a ## Privacy section').toBeGreaterThan(0);
  });

  // The Accounts section reads usage from Anthropic's OAuth endpoint by
  // default (src/limits.ts's USAGE_URL) — the section used to promise nothing
  // leaves the machine unless the pull-request setting is on, which was false
  // the moment an account row existed.
  it('names the usage endpoint, api.anthropic.com', () => {
    expect(
      privacySection().includes('api.anthropic.com'),
      'Privacy section names api.anthropic.com',
    ).toBe(true);
  });

  // The opt-in events log is the other place prompts and answers leave the
  // in-editor UI for a plain file on disk (src/hooks.ts's EVENTS_BASENAME).
  it('names the events log, events.ndjson', () => {
    expect(privacySection().includes('events.ndjson'), 'Privacy section names events.ndjson').toBe(
      true,
    );
  });

  // Removing the hooks TRUNCATES that file — HooksManager.remove() and the
  // Codex manager's, both through src/hooks.ts's clearEventsFile. The section
  // used to promise the opposite ("stays on disk until you delete it
  // yourself"), written against an older remove() that left the file alone:
  // a false claim about the one file holding every prompt the user typed.
  it('says removing the hooks clears the events log, not that it stays on disk', () => {
    const section = privacySection();
    expect(section.includes('stays on disk'), 'Privacy section says the log stays on disk').toBe(
      false,
    );
    expect(
      /removing [^.]*hooks[^.]*clears/i.test(section),
      'Privacy section says removing the hooks clears the log',
    ).toBe(true);
  });
});
