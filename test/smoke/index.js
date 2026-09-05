// test/smoke/index.js — runs INSIDE the extension host that run.mjs launches.
// Plain CommonJS with node:assert: the host loads this file directly, so there
// is no bundler and no test framework between the checks and the workbench.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');
const pkg = require('../../package.json');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The verdict goes to a file, not only to the exit code: the launcher
 *  (run.mjs) cannot rely on the editor exiting, so this is what it reads. */
function report(ok, message) {
  const file = process.env.FLOCK_SMOKE_RESULT;
  if (!file) return;
  try {
    fs.writeFileSync(file, JSON.stringify({ ok, message }));
  } catch {
    // Nothing to do: the launcher will time out and say so.
  }
}

exports.run = async function run() {
  try {
    const message = await suite();
    report(true, message);
    console.log(`smoke: ${message}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report(false, message);
    throw err;
  }
};

async function suite() {
  const id = `${pkg.publisher}.${pkg.name}`;

  // The isolation run.mjs promised, checked FIRST: every assertion below
  // exercises activation against a home directory, and if it is the real one
  // this test has already done the thing it exists to prevent.
  const expectedHome = process.env.FLOCK_SMOKE_HOME;
  assert.ok(expectedHome, 'FLOCK_SMOKE_HOME is not set — run this through test/smoke/run.mjs');
  assert.equal(os.homedir(), expectedHome, 'the extension host is not using the isolated home');

  const ext = vscode.extensions.getExtension(id);
  assert.ok(ext, `${id} is not loaded in the test host`);

  await ext.activate();
  assert.ok(ext.isActive, 'activate() resolved but isActive is false');

  // Every command the manifest contributes must exist, or the palette offers
  // verbs that fail with "command not found". getCommands(true) includes the
  // internal ones, which is what the `f1: false` entries are.
  const registered = new Set(await vscode.commands.getCommands(true));
  const missing = pkg.contributes.commands
    .map((c) => c.command)
    .filter((c) => !registered.has(c));
  assert.deepEqual(missing, [], `contributed but never registered: ${missing.join(', ')}`);

  // One verb end to end, the cheapest one: a refresh rebuilds the tree from
  // whatever the roster says, which here is nothing.
  await vscode.commands.executeCommand('lineage.refresh');

  // The machine-wide store must land under the ISOLATED home — proof that the
  // store resolved a home at all, and that it was ours, not the developer's.
  const stateFile = path.join(expectedHome, '.lineage', 'state', 'state.json');
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(stateFile) && Date.now() < deadline) await sleep(250);
  assert.ok(fs.existsSync(stateFile), `no state file appeared at ${stateFile}`);
  JSON.parse(fs.readFileSync(stateFile, 'utf8'));

  return (
    `${id} ${pkg.version} activated on ${process.platform}; ` +
    `${pkg.contributes.commands.length} commands registered; store at ${stateFile}`
  );
}
