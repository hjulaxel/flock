// test/manifest.test.ts — the manifest is the one source of truth for the
// settings, and docs/settings.md is rendered from it.
//
// `contributes.configuration` is what the Settings editor draws, and it is
// also what scripts/settings-doc.mjs renders into the table between two
// markers in docs/settings.md. Two readers, one record: the first suite holds
// the record to what both need from every row — an order to sort by, one label
// and one sentence per enum value to pair by index, a `#lineage.x#` link that
// lands on a key that exists — and the second checks the generator's OUTPUT
// rather than its code, since it is dependency-free Node that runs outside
// vitest: the markers are in the doc, every setting has exactly one row
// between them, the summary line's counts agree with a fresh count of the
// manifest, and `--check` — the gate the release runs — passes on the
// committed doc. A hand edit between the markers, a manifest edit without a
// rerun, or a generator that dropped a category all fail here by name.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { contributedSettings, settingsCategories } from './manifest';

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'settings.md');
const GENERATOR = path.join(ROOT, 'scripts', 'settings-doc.mjs');
const START = '<!-- generated:settings:start -->';
const END = '<!-- generated:settings:end -->';

/** The text between the markers, or a failure naming the one that is missing. */
function generatedBlock(): string {
  const doc = fs.readFileSync(DOC, 'utf8');
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  expect(start, `docs/settings.md carries ${START}`).toBeGreaterThan(-1);
  expect(end, `docs/settings.md carries ${END}`).toBeGreaterThan(start);
  return doc.slice(start + START.length, end);
}

describe('the manifest: what the editor and the generator both read', () => {
  // test/settingsEditor.test.ts pins the stricter shape the editor wants
  // (1..n inside each category). The generator needs less — a number on every
  // row — but needs it on EVERY row: `sort` on a missing order is a table in
  // manifest order, which is the historical order the categories exist to end.
  it('gives every property a numeric order', () => {
    for (const [key, p] of Object.entries(contributedSettings())) {
      expect(typeof p.order, `${key} order`).toBe('number');
      expect(Number.isInteger(p.order), `${key} order is an integer`).toBe(true);
    }
  });

  // The generator pairs value i with label i and the editor pairs value i with
  // description i, so a list one short is a value with the wrong words beside
  // it on both surfaces, not a missing one.
  it('gives every enum as many labels and descriptions as values', () => {
    let enums = 0;
    for (const [key, p] of Object.entries(contributedSettings())) {
      if (p.enum === undefined) continue;
      enums += 1;
      expect(p.enumItemLabels, `${key} enumItemLabels`).toHaveLength(p.enum.length);
      expect(p.enumDescriptions, `${key} enumDescriptions`).toHaveLength(p.enum.length);
    }
    expect(enums).toBeGreaterThan(0);
  });

  // A superseded key is either the legacy half of the window model, which
  // belongs beside `lineage.mode` so the struck-through row and its
  // replacement are read together, or an advanced row on its way out. Anywhere
  // else it is a deprecated setting among the preferences a first-time reader
  // is meant to be able to read without it.
  it('keeps every deprecated key in Window or among the advanced rows', () => {
    let deprecated = 0;
    for (const category of settingsCategories()) {
      for (const [key, p] of Object.entries(category.properties)) {
        if (p.deprecationMessage === undefined && p.markdownDeprecationMessage === undefined) {
          continue;
        }
        deprecated += 1;
        const placed = category.title === 'Window' || (p.tags?.includes('advanced') ?? false);
        expect(placed, `${key} is deprecated in ${category.title} without the advanced tag`).toBe(
          true,
        );
      }
    }
    expect(deprecated).toBeGreaterThan(0);
  });

  // `#lineage.x#` is the editor's link syntax and the generator's cue to
  // backtick the key. Neither checks the target: the editor renders a dead
  // link and the doc a key that is not in its own tables. The deprecation
  // messages and the per-value sentences are scanned too — they are markdown
  // the editor renders the same way.
  it('links only to settings that exist', () => {
    const settings = contributedSettings();
    const keys = new Set(Object.keys(settings));
    let links = 0;
    for (const [key, p] of Object.entries(settings)) {
      const text = [
        p.markdownDescription ?? '',
        p.markdownDeprecationMessage ?? '',
        ...(p.enumDescriptions ?? []),
      ].join('\n');
      for (const match of text.matchAll(/#(lineage\.[\w.]+)#/g)) {
        links += 1;
        expect(keys.has(match[1] as string), `${key} links to ${match[1]}`).toBe(true);
      }
    }
    expect(links).toBeGreaterThan(0);
  });
});

describe('docs/settings.md is generated from the manifest', () => {
  it('carries both markers, start before end, and one of each', () => {
    const doc = fs.readFileSync(DOC, 'utf8');
    expect(doc.split(START).length - 1, 'start markers').toBe(1);
    expect(doc.split(END).length - 1, 'end markers').toBe(1);
    expect(doc.indexOf(START)).toBeLessThan(doc.indexOf(END));
  });

  // The set comparison names a missing or stale row rather than counting it,
  // and one row per key rather than one row somewhere: two rows for one key is
  // two descriptions to keep true, and a reader meets whichever they scroll
  // to first. Deliberately no pinned total — two branches adding settings then
  // merge without this test being a third count to resolve.
  it('documents every contributed setting exactly once between the markers', () => {
    const contributed = Object.keys(contributedSettings());
    const documented = [...generatedBlock().matchAll(/^\| `(lineage\.[^`]+)`/gm)].map(
      (m) => m[1] as string,
    );
    expect(documented.filter((k) => !contributed.includes(k))).toEqual([]);
    expect(contributed.filter((k) => !documented.includes(k))).toEqual([]);
    expect(
      documented.filter((k, at) => documented.indexOf(k) !== at),
      'settings documented twice',
    ).toEqual([]);
  });

  // Nothing outside the markers may quote a count: the numbers live in the
  // generated summary line and nowhere else in the repository's prose, so the
  // three that are printed there have to be the three the manifest gives.
  it('prints counts that match a fresh count of the manifest', () => {
    const settings = Object.values(contributedSettings());
    const total = settings.length;
    const off = settings.filter((p) => p.type === 'boolean' && p.default === false).length;
    const advanced = settings.filter((p) => p.tags?.includes('advanced')).length;

    const summary = generatedBlock().match(
      /\*\*(\d+) settings\*\*\. \*\*(\d+)\*\* of them are switches that ship off, and \*\*(\d+)\*\* are tagged \*advanced\*/,
    );
    expect(summary, 'the generated summary line').not.toBeNull();
    expect(Number(summary?.[1]), 'total').toBe(total);
    expect(Number(summary?.[2]), 'switches that ship off').toBe(off);
    expect(Number(summary?.[3]), 'tagged advanced').toBe(advanced);
    // Sanity on the fresh count itself: a manifest with no switch off or no
    // advanced row would make the line true and the page wrong.
    expect(off).toBeGreaterThan(0);
    expect(advanced).toBeGreaterThan(0);
  });

  // The generator's own --check is what `npm run release` gates on. Running it
  // here means `npm test` catches a manifest edit that was not followed by
  // `npm run docs:settings` — the same drift, found before the release does.
  it("is up to date: the generator's --check passes on the committed doc", () => {
    const result = spawnSync(process.execPath, [GENERATOR, '--check'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(result.status, `${result.stderr}${result.stdout}`).toBe(0);
  });
});
