// test/smoke/run.mjs — the activation smoke test. `npm run test:smoke`.
//
// WHAT IT CATCHES that the unit suite cannot: the extension activating inside
// a real VS Code, on each OS in the CI matrix. A spawn that throws
// synchronously on Windows, a path built with the wrong separator, a `when`
// clause naming a context key nothing ever sets, a command contributed in the
// manifest and never registered — the unit tests mock `vscode` and see none
// of it. This does not mock anything.
//
// WHAT IT MUST NEVER DO: touch the machine it runs on. Activation reads and
// writes the home directory (~/.lineage, ~/.claude), polls `claude agents
// --json`, and reconciles the private tmux server — whose socket lives under
// /tmp, not under HOME, so an isolated home alone would not keep it away from
// a developer's live sessions. Three walls, each sufficient on its own:
//
//   1. an EMPTY, throwaway home, so the store, the transcripts and the
//      account profiles it sees are nobody's;
//   2. on POSIX, a PATH holding only the system directories, so the `tmux`
//      and `claude` a developer keeps under Homebrew or nvm are not found and
//      the reconcile has no server to judge;
//   3. the store's own rule (idleClose.reconcileTmuxDecisions): a store with
//      no session records reaps nothing, and a fresh home has none.
//
// Plus a throwaway user-data-dir, so the run leaves no trace in the editor
// either. Everything is deleted afterwards, pass or fail.
//
// WHY THIS SPAWNS THE EDITOR ITSELF instead of calling `runTests`: that helper
// resolves when the editor process exits, and the editor does not reliably
// exit. Measured on VS Code 1.136.1 / macOS: the extension host ran the suite,
// reported, and quit with code 0 within 70 ms of activation; the Electron main
// process was still alive fourteen minutes later. So the verdict travels
// through a RESULT FILE the suite writes (test/smoke/index.js), this launcher
// waits for that file — or a deadline — and then ends the process tree itself.

import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** How long the whole run may take once the editor is spawned. A cold start
 *  on a CI runner is ten to twenty seconds; the suite itself is under one. */
const DEADLINE_MS = 180_000;
/** How long the editor gets to quit on its own after the verdict, before the
 *  tree is killed. It usually does not, which is why this is short. */
const QUIT_GRACE_MS = 5_000;
const POLL_MS = 250;

const root = fileURLToPath(new URL('../..', import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-smoke-'));
const home = path.join(scratch, 'home');
const userData = path.join(scratch, 'user-data');
const workspace = path.join(scratch, 'workspace');
const resultFile = path.join(scratch, 'result.json');
for (const dir of [home, userData, workspace]) fs.mkdirSync(dir, { recursive: true });

/** @type {Record<string, string>} */
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  // Read back inside the host (test/smoke/index.js) to prove the isolation
  // took, before anything else is asserted; and where the verdict goes.
  FLOCK_SMOKE_HOME: home,
  FLOCK_SMOKE_RESULT: resultFile,
};
if (process.platform !== 'win32') env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** End the editor's whole process tree. The main process alone is not enough:
 *  its helpers hold the pipes, and on macOS they outlive it. */
function killTree(child) {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      // Spawned detached, so the pid is also the process group id.
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    // Already gone — the outcome we wanted.
  }
}

let verdict = { ok: false, message: 'the suite never reported' };
let child;
try {
  // The Electron executable itself — what runTests spawns — never the `code`
  // CLI wrapper, which hands off to the app and exits at once, taking the
  // "did it quit" signal with it.
  const executable = await downloadAndUnzipVSCode();
  const cache = path.join(root, '.vscode-test');
  const args = [
    workspace,
    // The same flags runTests passes, for the same reasons (see its source):
    // sandboxing that fails on CI runners, no update checks, no welcome page.
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-updates',
    '--skip-welcome',
    '--skip-release-notes',
    '--no-cached-data',
    '--disable-workspace-trust',
    '--disable-extensions',
    '--disable-gpu',
    `--extensions-dir=${path.join(cache, 'extensions')}`,
    `--user-data-dir=${userData}`,
    `--extensionDevelopmentPath=${root}`,
    `--extensionTestsPath=${path.join(root, 'test', 'smoke', 'index.js')}`,
  ];
  child = spawn(executable, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group on POSIX, so the whole tree can be ended at once.
    detached: process.platform !== 'win32',
  });
  // Electron is noisy on stderr (GPU, Fontconfig, dbus); it is kept, printed
  // only when the run fails, so a green run reads as one line.
  let noise = '';
  child.stdout.on('data', (d) => (noise += d));
  child.stderr.on('data', (d) => (noise += d));
  let exited = false;
  child.on('exit', () => (exited = true));

  const deadline = Date.now() + DEADLINE_MS;
  while (!fs.existsSync(resultFile) && !exited && Date.now() < deadline) await sleep(POLL_MS);

  if (fs.existsSync(resultFile)) {
    verdict = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  } else if (exited) {
    verdict = { ok: false, message: `the editor exited (code ${String(child.exitCode)}) before the suite reported` };
  } else {
    verdict = { ok: false, message: `no verdict after ${String(DEADLINE_MS / 1000)}s` };
  }

  // Let a well-behaved editor leave on its own, then insist.
  const quitBy = Date.now() + QUIT_GRACE_MS;
  while (!exited && Date.now() < quitBy) await sleep(POLL_MS);
  if (!exited) killTree(child);

  if (!verdict.ok && noise.trim() !== '') {
    console.error('--- editor output ---');
    console.error(noise.trim().split('\n').slice(-60).join('\n'));
    console.error('---------------------');
  }
} catch (err) {
  verdict = { ok: false, message: err instanceof Error ? err.message : String(err) };
  if (child) killTree(child);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console[verdict.ok ? 'log' : 'error'](`smoke: ${verdict.ok ? 'ok' : 'FAILED'} — ${verdict.message}`);
process.exit(verdict.ok ? 0 : 1);
