// test/manifest.test.ts — the manifest is the one source of truth for the
// settings, and docs/settings.md is rendered from it.
//
// `contributes.configuration` is what the Settings editor draws, and since
// step C it is also what scripts/settings-doc.mjs renders into the table
// between two markers in docs/settings.md. The generator is dependency-free
// Node that runs outside vitest, so this suite checks its OUTPUT rather than
// its code: the markers are in the doc, every setting has exactly one row
// between them, the summary line's counts agree with a fresh count of the
// manifest, and `--check` — the gate the release runs — passes on the
// committed doc. A hand edit between the markers, a manifest edit without a
// rerun, or a generator that dropped a category all fail here by name.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { contributedSettings } from './manifest';

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
