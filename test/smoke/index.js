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

/** How long the store gets to show a write the workbench has been asked for.
 *  The same budget the state file itself gets: a save is debounced, and a cold
 *  CI runner is slow. */
const STORE_WAIT_MS = 15_000;

/**
 * One canonical spelling of a directory path — `\` folded to `/`, repeated
 * separators collapsed, a trailing separator dropped, a leading UNC `\\` kept.
 *
 * A COPY of `normalizeDir` in src/projects.ts, character for character, and it
 * has to be one: the extension host loads this file raw, with no bundler and
 * no TypeScript, so nothing under src/ is importable from here. The assertion
 * it serves is only as honest as the two staying identical — if normalizeDir
 * changes, change this with it.
 */
function normalizeDir(input) {
  if (typeof input !== 'string') return '';
  const trimmed = input.trim();
  if (trimmed === '') return '';
  const slashed = trimmed.replace(/\\/g, '/');
  const unc = /^\/\/[^/]/.test(slashed) ? '//' : '';
  const body = slashed.slice(unc.length).replace(/\/{2,}/g, '/');
  if (unc === '' && body === '/') return '/';
  const tail = body.replace(/\/+$/, '');
  return tail === '' ? body : `${unc}${tail}`;
}

/** Whether this platform's filesystems ignore case — `PATHS_FOLD_CASE` in
 *  src/projects.ts, and true for the same two platforms. */
const FOLD_CASE = process.platform === 'darwin' || process.platform === 'win32';

/**
 * Whether two REAL paths name the same directory. Both sides are expected to
 * have been through `fs.realpathSync` already; this is only the case rule.
 *
 * Folded on macOS and Windows because there `C:\Temp` and `c:\temp` are one
 * directory — and on Windows they genuinely turn up spelled differently in one
 * run: `os.tmpdir()` hands the launcher an upper-case drive letter, while a
 * `Uri.fsPath` from the workbench is lower-cased. Comparing those literally
 * would fail on a correct machine.
 */
function sameDir(a, b) {
  return FOLD_CASE ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The store as it is on disk right now, or undefined while it is not there
 *  or not yet whole. Undefined rather than a throw because every caller is a
 *  poll loop, and "not yet" is the ordinary answer to the first few reads. */
function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

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
  const deadline = Date.now() + STORE_WAIT_MS;
  while (!fs.existsSync(stateFile) && Date.now() < deadline) await sleep(250);
  assert.ok(fs.existsSync(stateFile), `no state file appeared at ${stateFile}`);
  assert.ok(readState(stateFile), `the store at ${stateFile} is not readable JSON`);

  const project = await makeAProject(stateFile);

  return (
    `${id} ${pkg.version} activated on ${process.platform}; ` +
    `${pkg.contributes.commands.length} commands registered; store at ${stateFile}; ` +
    `project "${project.name}" claims ${project.rootDir}`
  );
}

/**
 * MAKE A PROJECT OUT OF THE FOLDER THE WINDOW IS OPEN ON, and read the answer
 * back off disk. Returns the stored record.
 *
 * WHAT THIS CATCHES, and why it needs a real editor: creating a project stores
 * a directory path, and that path comes from the workbench — on Windows a
 * `Uri.fsPath`, which is backslashed and drive-lettered (`C:\Users\me\code`).
 * Every separator decision between the command's argument and the JSON on disk
 * is invisible to the unit suite, which builds its paths as literals and never
 * sees a Uri the workbench made. Here the path comes from the workbench, the
 * store is the real one, and the two are compared in the store's own canonical
 * spelling. A project filed under a mangled path — or under none — fails.
 */
async function makeAProject(stateFile) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'no workspace folder — run this through test/smoke/run.mjs');
  const folderPath = folder.uri.fsPath;

  // THE WALL, checked before the write and not after: a project is a claim on
  // a directory, so this must be the launcher's scratch folder and nothing a
  // developer keeps. Compared through `realpathSync` on both sides because the
  // scratch lives under the OS temp directory, which on macOS is reached by a
  // symlink (/var -> /private/var) that the workbench may or may not resolve.
  const expectedWorkspace = process.env.FLOCK_SMOKE_WORKSPACE;
  assert.ok(
    expectedWorkspace,
    'FLOCK_SMOKE_WORKSPACE is not set — run this through test/smoke/run.mjs',
  );
  const realFolder = fs.realpathSync(folderPath);
  const realScratch = fs.realpathSync(expectedWorkspace);
  assert.ok(
    sameDir(realFolder, realScratch),
    `the editor is open on ${realFolder}, not the scratch workspace ${realScratch}`,
  );

  // `{type:'group', cwd}` is the argument a FOLDER ROW hands the command
  // (groupCwdFromArg, src/commands.ts), and it is the only shape there is: the
  // command's palette entry is `when: false` and nothing contributes it to the
  // Explorer, so a tree row is the whole public entry point. Seeded this way
  // the flow skips the folder dialog — the point of the verb — and asks
  // nothing.
  //
  // NOT AWAITED, deliberately. The flow creates the project and THEN puts an
  // editable input on its new row: create first, name after, the same gesture
  // as "New File". That input waits for a person, so awaiting the command
  // would wait with it for the whole deadline. The verdict is the store,
  // polled below. A command that failed outright is remembered here so the
  // timeout can say why instead of "nothing appeared".
  let commandError = '';
  void Promise.resolve(
    vscode.commands.executeCommand('lineage.projectFromFolder', {
      type: 'group',
      cwd: folderPath,
    }),
  ).catch((err) => {
    commandError = err instanceof Error ? err.message : String(err);
  });

  const wanted = normalizeDir(folderPath);
  const deadline = Date.now() + STORE_WAIT_MS;
  let stored;
  for (;;) {
    const projects = readState(stateFile)?.projects;
    stored = Object.values(projects ?? {}).find(
      (p) => p !== null && typeof p === 'object' && normalizeDir(p.rootDir) === wanted,
    );
    if (stored || Date.now() >= deadline) break;
    await sleep(250);
  }
  assert.ok(
    stored,
    `no project claiming ${wanted} in ${stateFile} after ${STORE_WAIT_MS / 1000}s` +
      (commandError === '' ? '' : ` — the command failed: ${commandError}`),
  );

  // The SPELLING, not just the directory. Finding the record above tolerates
  // either spelling, because it normalises both sides; this pins that what
  // went to disk is already canonical. It matters beyond tidiness: `pathKey`,
  // `isWithin` and the whole of the grouping compare stored paths against each
  // other, and a rootDir that kept its backslashes would sort and match as a
  // different directory from every session cwd the roster normalises.
  assert.equal(
    stored.rootDir,
    wanted,
    'the stored rootDir is not the canonical spelling of the folder',
  );

  // The generated name is the directory's basename, and `baseName` in
  // src/projects.ts splits on both separators by hand rather than through
  // node:path. Pinned here because getting that wrong on Windows does not
  // throw — it names the project after the whole `C:\...\workspace` path.
  assert.equal(
    stored.name,
    path.basename(folderPath),
    'the project was not named after its directory',
  );

  // Whatever the flow left on screen — the inline input on the new row, or the
  // rename box behind it — is dismissed, so the editor is not sitting on a
  // prompt when the launcher goes looking for it. Best effort: the run is
  // already decided by this point.
  try {
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  } catch {
    // Nothing depends on it.
  }

  // One more refresh, now that there IS something to draw: the tree has no API
  // to read a row back from, so this is the cheap half — rebuilding it over a
  // real project record whose rootDir is a native path must not throw.
  await vscode.commands.executeCommand('lineage.refresh');

  return stored;
}
