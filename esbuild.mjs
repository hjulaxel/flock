// esbuild.mjs — bundles src/extension.ts into dist/extension.js.
// SCAFFOLD-owned. `node esbuild.mjs` for a one-shot build, `--watch` to watch.
//
// The extension host loads CommonJS and provides `vscode` at runtime, so
// `vscode` is marked external and the output format is cjs.

import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
