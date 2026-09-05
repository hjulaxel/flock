// test/manifest.ts — the one reader of `contributes.configuration` the suites
// share.
//
// The configuration contribution is an ARRAY of categories — one per group of
// the settings design, each with a title and an order — because that is what
// the built-in Settings editor draws as a table of contents under
// Extensions › Flock. Six suites want the properties as one flat record the way
// they read it when the manifest was a single object, and a flattening loop
// copied into each of them is six places to fix the day a seventh shape is
// wanted. Not a test file: vitest collects `*.test.ts` only, and tsconfig.test
// still typechecks it.

import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..');

/** The fields of one property the suites and the editor read. */
export interface SettingSchema {
  type?: string;
  default?: unknown;
  order?: number;
  tags?: string[];
  enum?: unknown[];
  enumItemLabels?: string[];
  enumDescriptions?: string[];
  description?: string;
  markdownDescription?: string;
  deprecationMessage?: string;
  markdownDeprecationMessage?: string;
}

/** One category of the configuration contribution. */
export interface SettingsCategory {
  title: string;
  order?: number;
  properties: Record<string, SettingSchema>;
}

/** The categories, in manifest order. */
export function settingsCategories(): SettingsCategory[] {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
  ) as { contributes: { configuration: SettingsCategory[] } };
  return pkg.contributes.configuration;
}

/** Every contributed setting as one flat record, whichever category it sits
 *  in. A key contributed twice keeps the LAST copy here; the uniqueness of the
 *  set is asserted by test/settingsEditor.test.ts, where a duplicate is named
 *  rather than silently folded. */
export function contributedSettings(): Record<string, SettingSchema> {
  const flat: Record<string, SettingSchema> = {};
  for (const category of settingsCategories()) {
    Object.assign(flat, category.properties);
  }
  return flat;
}
