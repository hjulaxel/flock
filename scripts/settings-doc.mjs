// scripts/settings-doc.mjs — the settings table in docs/settings.md is
// generated from the manifest, so a setting is described in one place.
//
// WHY THIS EXISTS: every description used to live twice — once in
// `contributes.configuration`, where the Settings editor reads it, and once in
// a hand-kept table of fifty-odd rows — and the copies drifted on the first
// edit nobody made twice: the table ran two rows short, its header quoted a
// count three behind, and a description reworded in one place stayed the old
// way in the other. The manifest is what the editor actually draws, so it is
// the truth, and this script renders it. Node builtins only; package.json in,
// markdown out, nothing else touched.
//
//   node scripts/settings-doc.mjs           # rewrite the block in docs/settings.md
//   node scripts/settings-doc.mjs --check   # exit 1 if that block is behind
//
// Only the text between the two markers is replaced. The prose around them is
// hand-written and stays exactly as it is.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'package.json');
const DOC = join(ROOT, 'docs', 'settings.md');
const START = '<!-- generated:settings:start -->';
const END = '<!-- generated:settings:end -->';

const check = process.argv.includes('--check');

const die = (msg, fix) => {
  console.error(`\n  ✗ ${msg}`);
  if (fix) console.error(`    ${fix}`);
  console.error('');
  process.exit(1);
};

// ----------------------------------------------------------------- rendering

/** Everything a table cell cannot carry, taken out of an otherwise verbatim
 *  description: a newline would end the row, an unescaped pipe would split it,
 *  and `#lineage.x#` is the Settings editor's own link syntax — in a markdown
 *  file it reads as a typo, so it becomes the backticked key the surrounding
 *  prose already uses. The backticked form is handled first so a manifest that
 *  wrote `#lineage.x#` inside code ticks does not come out double-ticked. */
const cell = (text) =>
  text
    .replace(/`#(lineage\.[\w.]+)#`/g, '`$1`')
    .replace(/#(lineage\.[\w.]+)#/g, '`$1`')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();

const isAdvanced = (p) => Array.isArray(p.tags) && p.tags.includes('advanced');
const deprecationOf = (p) => p.deprecationMessage ?? p.markdownDeprecationMessage;

/** One row. The label beside each enum value is the one the editor's dropdown
 *  shows, so the table and the dropdown cannot disagree about what a value
 *  means; the value itself stays, because settings.json takes the value. */
const row = (key, p) => {
  const deprecated = deprecationOf(p);
  const parts = [];
  if (isAdvanced(p)) parts.push('Advanced —');
  parts.push(p.markdownDescription ?? p.description ?? '');
  if (Array.isArray(p.enum)) {
    const values = p.enum.map((value, at) => {
      const label = p.enumItemLabels?.[at];
      return label ? `\`${String(value)}\` — ${label}` : `\`${String(value)}\``;
    });
    parts.push(`Values: ${values.join('; ')}.`);
  }
  if (deprecated) parts.push(`Deprecated: ${deprecated}`);
  const name = `\`${key}\`${deprecated ? ' (deprecated)' : ''}`;
  return `| ${name} | \`${JSON.stringify(p.default)}\` | ${cell(parts.join(' '))} |`;
};

const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);

/** The whole generated block: a summary line, then a table per category in
 *  the order the editor lists them, rows in the order the editor draws them. */
function render(configuration) {
  const categories = [...configuration].sort(byOrder);
  const all = categories.flatMap((c) => Object.values(c.properties));
  const total = all.length;
  const off = all.filter((p) => p.type === 'boolean' && p.default === false).length;
  const advanced = all.filter(isAdvanced).length;

  const lines = [
    `Flock contributes **${total} settings**. **${off}** of them are switches that ` +
      `ship off, and **${advanced}** are tagged *advanced* — paths, timings, ` +
      'diagnostics and previews, the rows `@tag:advanced` finds in the Settings ' +
      'editor. Advanced rows are marked below and sit last in their category.',
    '',
  ];
  for (const category of categories) {
    lines.push(`### ${category.title}`, '');
    lines.push('| Setting | Default | What it does |', '| --- | --- | --- |');
    const entries = Object.entries(category.properties).sort(([, a], [, b]) => byOrder(a, b));
    for (const [key, p] of entries) lines.push(row(key, p));
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/** The document with its generated block replaced, or a reason it cannot be. */
function splice(doc, block) {
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  if (start === -1 || end === -1 || end < start) return null;
  return `${doc.slice(0, start + START.length)}\n\n${block}\n\n${doc.slice(end)}`;
}

// --------------------------------------------------------------------- main

const pkg = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const configuration = pkg.contributes?.configuration;
if (!Array.isArray(configuration)) {
  die(
    'contributes.configuration is not an array of categories.',
    'The generator renders one table per category; see design/settings-tiers.md §4.',
  );
}

const current = readFileSync(DOC, 'utf8');
const next = splice(current, render(configuration));
const docPath = relative(process.cwd(), DOC) || DOC;
if (next === null) {
  die(
    `${docPath} has no generated block to replace.`,
    `It needs both markers, in order: ${START} … ${END}`,
  );
}

if (next === current) {
  console.log(`  ✓ ${docPath} matches package.json`);
} else if (check) {
  die(
    `${docPath} is behind package.json.`,
    'Run `npm run docs:settings` and commit the result.',
  );
} else {
  writeFileSync(DOC, next);
  console.log(`  ✓ wrote ${docPath} from package.json`);
}
