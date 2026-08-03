// scripts/release.mjs — the pre-flight for a marketplace release.
//
// WHY THIS EXISTS: the VS Code Marketplace reads exactly one thing, `version`
// in package.json, and records nothing about git. `vsce package` embeds no
// commit sha either. So a VSIX built from a dirty tree is unattributable
// FOREVER — and marketplace versions are immutable and append-only, so you
// cannot re-upload the number to correct it. You ship 0.1.1 instead.
//
// Publishing through the marketplace web UI (drag a .vsix onto a web form)
// removes the one guardrail `vsce publish` gave you: it bumped the version and
// tagged the commit for you. This script puts that back.
//
// It never pushes and never uploads. It verifies, packages, and tags locally,
// then prints the two outward-facing steps for you to run deliberately.
//
//   node scripts/release.mjs            # verify + package + tag
//   node scripts/release.mjs --no-tag   # verify + package only

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const noTag = process.argv.includes('--no-tag');

const run = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe' }).trim();

const die = (msg, fix) => {
  console.error(`\n  ✗ ${msg}`);
  if (fix) console.error(`    ${fix}`);
  console.error('');
  process.exit(1);
};

const step = (msg) => console.log(`  · ${msg}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const { publisher, name, version } = pkg;
const id = `${publisher}.${name}`;
const tag = `v${version}`;

console.log(`\n  Releasing ${id} @ ${version}\n`);

// 1. A dirty tree is the whole reason this file exists.
const dirty = run('git', ['status', '--porcelain']);
if (dirty) {
  die(
    'Working tree is not clean. The VSIX would not correspond to any commit.',
    `Commit or stash first:\n${dirty
      .split('\n')
      .map((l) => `      ${l}`)
      .join('\n')}`,
  );
}
ok('working tree clean');

// 2. Releases come off the default branch, or "what is published" and "what is
//    on main" drift apart on the first hotfix.
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== 'main') {
  die(
    `On branch "${branch}", not main.`,
    'Merge to main first, or pass --no-tag if you know why you are doing this.',
  );
}
ok(`on ${branch}`);

// 3. The tag existing means this version was already built. Since marketplace
//    versions are immutable, reusing one is always a mistake.
const tags = run('git', ['tag', '-l']).split('\n').filter(Boolean);
if (tags.includes(tag)) {
  die(
    `Tag ${tag} already exists — ${version} has been released before.`,
    'Bump "version" in package.json first. Marketplace versions cannot be reused.',
  );
}
ok(`${tag} is unused`);

// 4. Never ship red.
step('typecheck…');
try {
  execFileSync('npm', ['run', 'typecheck'], { stdio: 'pipe' });
} catch {
  die('Typecheck failed.', 'npm run typecheck');
}
ok('typecheck clean');

step('tests…');
let testOut = '';
try {
  testOut = execFileSync('npm', ['test'], { encoding: 'utf8', stdio: 'pipe' });
} catch (err) {
  die('Tests failed.', 'npm test');
}
const counts = /Tests\s+(\d+) passed\s+\((\d+)\)/.exec(testOut);
ok(counts ? `${counts[1]}/${counts[2]} tests pass` : 'tests pass');

// 5. Package. `vsce` runs vscode:prepublish itself, which is the production
//    esbuild build.
const vsix = `${name}-${version}.vsix`;
step(`packaging ${vsix}…`);
try {
  execFileSync('npx', ['--yes', '@vscode/vsce@latest', 'package', '--out', vsix], {
    stdio: 'pipe',
  });
} catch (err) {
  die('vsce package failed.', String(err.stdout ?? err.message).trim());
}
if (!existsSync(vsix)) die(`vsce reported success but ${vsix} is missing.`);
ok(`packaged ${vsix}`);

// 6. Tag the exact commit these bytes came from. Local only — pushing a tag is
//    outward-facing and stays a deliberate act.
const sha = run('git', ['rev-parse', '--short', 'HEAD']);
if (noTag) {
  console.log(`\n  ! --no-tag: ${tag} NOT created. ${vsix} is unattributed.\n`);
} else {
  execFileSync('git', ['tag', '-a', tag, '-m', `${pkg.displayName} ${version}`]);
  ok(`tagged ${tag} at ${sha}`);
}

console.log(`
  Ready. Nothing has left this machine yet.

    1. Upload ${vsix}
       https://marketplace.visualstudio.com/manage/publishers/${publisher}
       Version ${version} becomes permanent the moment it lands.

    2. Publish the provenance
       git push origin main --tags

    3. Open VSX, so Cursor / Windsurf / VSCodium can find it
       npx ovsx publish ${vsix} -p <token>
`);
