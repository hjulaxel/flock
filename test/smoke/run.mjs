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
// a developer's live sessions. The suite also WRITES: it makes a project out
// of the folder the editor is open on, which is why that folder is a scratch
// one this launcher made and the suite re-checks before claiming it. Three
// walls, each sufficient on its own:
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
/**
 * WAS 180 s, on the measurement that a cold CI start is ten to twenty seconds.
 * A macos-latest runner blew through it while the same commit passed on the
 * other two, and the suite's own waits are all bounded (15 s for the store,
 * 15 s for the project), so what ran out was the EDITOR's cold start, not
 * anything under test. A generous ceiling costs nothing on a green run — the
 * launcher stops the moment the verdict file appears — and a tight one turns a
 * slow runner into a red build about nothing.
 */
const DEADLINE_MS = 300_000;
/** How long the editor gets to quit on its own after the verdict, before the
 *  tree is killed. It usually does not, which is why this is short. */
const QUIT_GRACE_MS = 5_000;
const POLL_MS = 250;

const root = fileURLToPath(new URL('../..', import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-smoke-'));
const home = path.join(scratch, 'home');
const userData = path.join(scratch, 'user-data');
const workspace = path.join(scratch, 'workspace');
/** Where the editor writes its extensions manifest. Under the throwaway, not
 *  under the cached `.vscode-test` — see the `--extensions-dir` comment. */
const extensionsDir = path.join(scratch, 'extensions');
const resultFile = path.join(scratch, 'result.json');
/** Overwritten by the suite as it advances, so a deadline can say where it
 *  stopped. Deliberately NOT the verdict file, which the launcher treats as
 *  final the moment it exists. */
const progressFile = path.join(scratch, 'progress.txt');
/** The extension mirrors its output channel here (FLOCK_LOG_FILE), which is
 *  the only way to read back what activation was doing when it stalled. */
const logFile = path.join(scratch, 'flock.log');
for (const dir of [home, userData, workspace, extensionsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

/** @type {Record<string, string>} */
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  // Read back inside the host (test/smoke/index.js) to prove the isolation
  // took, before anything else is asserted; and where the verdict goes.
  FLOCK_SMOKE_HOME: home,
  FLOCK_SMOKE_RESULT: resultFile,
  FLOCK_SMOKE_PROGRESS: progressFile,
  FLOCK_LOG_FILE: logFile,
  // The folder the editor is opened on, below. The suite makes a PROJECT out
  // of it, which is a write into the store naming a directory — so it checks
  // the folder the workbench reports against this one first, and refuses to
  // claim anything that is not the scratch directory.
  FLOCK_SMOKE_WORKSPACE: workspace,
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
    // THE THROWAWAY, not `cache`. CI caches the whole of `.vscode-test` —
    // that is the point, the editor download is ~150 MB per OS — and this
    // directory is the one thing under it the editor WRITES. A run left an
    // `extensions/extensions.json` in the cache, the next run restored it, and
    // a newer build refused it: "Unable to create file 'extensions.json' that
    // already exists when overwrite flag is not set". The host then came up
    // with the extension loaded and `activate()` never resolving — a 300-second
    // timeout on macOS whose cause was invisible until the suite started
    // stamping its phase. Runtime state does not belong in a cached directory.
    `--extensions-dir=${extensionsDir}`,
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
    // How far it got, when it got nowhere. The suite stamps each phase into a
    // second file (FLOCK_SMOKE_PROGRESS); without it a timeout said only "no
    // verdict", which does not distinguish an editor that never started from a
    // suite stuck on one assertion.
    let reached = 'nothing was stamped — the extension host may not have started';
    try {
      reached = fs.readFileSync(progressFile, 'utf8').trim() || reached;
    } catch {
      // The default says it.
    }
    // And what the extension itself last managed, which the phase alone does
    // not say: "activating" covers everything activate() does.
    let tail = '';
    try {
      const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length > 0) tail = `\n--- Flock log, last 12 lines ---\n${lines.slice(-12).join('\n')}`;
    } catch {
      tail = '\nThe extension logged nothing.';
    }
    verdict = {
      ok: false,
      message: `no verdict after ${String(DEADLINE_MS / 1000)}s; last phase: ${reached}${tail}`,
    };
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
