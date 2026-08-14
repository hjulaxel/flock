// src/agentVerbs.ts — the opt-in in-session verbs: a session asks Flock to
// fork it.
//
// "Fork this session", typed to CLAUDE rather than clicked in the sidebar,
// has to end in the extension — the fork verb IS `forkFlow`, and only a window
// can run it. So the session's side is a tiny CLI that writes a REQUEST FILE,
// and the extension's side is a watcher that claims the file, runs the same
// fork the sidebar button runs, and writes a reply the CLI prints back to the
// model. Two files are installed, both behind one consent modal:
//
//   ~/.claude/skills/flock/SKILL.md     — teaches Claude the verb exists
//   ~/.lineage/flock-verbs.mjs          — the CLI the skill tells it to run
//
// The skill lands in the SKILLS DIRECTORY for the same reason the hooks plugin
// does (see hooks.ts): no marketplace, no settings.json edit, `rm -rf`
// uninstalls it — and profileConfig.ts already symlinks `skills` into every
// account's config dir, so one install covers every profile.
//
// THE PROTOCOL, and why it is a directory of files rather than a socket or a
// shared log:
//
//   request:  ~/.lineage/requests/<uuid>.json           (written by the CLI)
//   claim:    rename to <uuid>.json.claimed-<pid>       (won by ONE window)
//   reply:    ~/.lineage/requests/<uuid>.reply.json     (read by the CLI)
//
// Every open window watches the same directory, and a request must run
// EXACTLY ONCE — three windows each launching "three forks" is the failure
// mode this design exists to prevent. rename(2) is atomic on one filesystem,
// so the claim can only succeed in one window; every loser gets ENOENT and
// walks away. Which window should win is also decided here: the one whose
// terminal HOSTS the session claims immediately, every other window waits
// CLAIM_DELAY_MS first — so the fork's tab opens beside the conversation it
// branched from, exactly where the sidebar button would have put it, and the
// delay only ever matters for sessions no window is bound to.
//
// Nothing here is required for anything: with the verbs never installed (the
// default), no file exists, no watcher runs, and the extension is exactly what
// it was. Version-proofing follows hooks.ts to the letter — what persists into
// user-visible locations references only `$HOME`-relative paths we own, never
// an extension install path.

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as process from 'node:process';

import { isSessionId, shortId } from './types';
import type { DisposableLike, HookInstallState } from './types';
import { log, logError } from './log';

// --------------------------------------------------------------- constants

export const VERBS_SKILL_NAME = 'flock';
/** Bumped whenever the generated files change; drives silent self-heal, the
 *  same contract as hooks.PLUGIN_VERSION. */
export const VERBS_VERSION = 1;

const SCRIPT_BASENAME = 'flock-verbs.mjs';
const REQUESTS_DIR_BASENAME = 'requests';

/** The most forks one request may ask for. "Do three forks here" is the use
 *  case; eight is already a wall of terminal tabs, and a runaway loop in a
 *  model should hit a wall, not a fleet. Enforced in the CLI AND here — the
 *  request file is writable by anything on the machine. */
export const MAX_AGENT_FORKS = 8;
/** An opening prompt longer than this is refused rather than truncated —
 *  silently cutting a prompt changes what the fork does. */
export const MAX_AGENT_PROMPT_CHARS = 4000;
/** A request file larger than this is not even read. */
const MAX_REQUEST_BYTES = 64 * 1024;

/** A request older than this is answered "expired" instead of executed. The
 *  CLI gives up after 30 s; anything older is a request nobody is waiting
 *  for, and forking somebody's session minutes after they asked — say, when
 *  a window finally opens — is a jump scare, not a feature. */
const REQUEST_TTL_MS = 120_000;
/** How long a window that does NOT host the session waits before claiming, so
 *  the window that does host it wins the rename. */
const CLAIM_DELAY_MS = 600;
/** fs.watch is lossy (see hooks.ts on macOS FSEvents); a cheap readdir at
 *  this cadence is the floor. */
const WATCH_FALLBACK_MS = 2_000;
/** Leftover replies and claims older than this are swept at watcher start. */
const SWEEP_AGE_MS = 60 * 60_000;

const REQUEST_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i;
const CLAIM_RE = /\.json\.claimed-\d+$/;
const REPLY_SUFFIX = '.reply.json';

/** <home>/.claude/skills/flock */
export function verbsSkillDir(home?: string): string {
  return path.join(homeDir(home), '.claude', 'skills', VERBS_SKILL_NAME);
}

/** <home>/.lineage/flock-verbs.mjs */
export function verbsScriptPath(home?: string): string {
  return path.join(homeDir(home), '.lineage', SCRIPT_BASENAME);
}

/** <home>/.lineage/requests */
export function requestsDir(home?: string): string {
  return path.join(homeDir(home), '.lineage', REQUESTS_DIR_BASENAME);
}

// ------------------------------------------------------------ file contents
//
// Both files are rendered from constants so install, verify and self-heal all
// compare against one source of truth, exactly as hooks.ts renders its two
// plugin files. The scripts avoid backticks and `${` on purpose: they live
// inside TypeScript template literals.

/** The skill Claude reads. The description is the retrieval surface — it has
 *  to contain the words a user actually says. */
export function renderSkillMd(): string {
  return [
    '---',
    `name: ${VERBS_SKILL_NAME}`,
    'description: Fork the current Claude Code session into new branches in',
    '  the Flock sidebar. Use when the user asks to fork this session, branch',
    '  this conversation, or make N forks/copies of it.',
    '---',
    '',
    '# Fork this session',
    '',
    'Flock (the VS Code sidebar this session may be running under) can fork',
    'the current conversation exactly the way its Fork button does. Ask it',
    'with:',
    '',
    '    node ~/.lineage/flock-verbs.mjs fork --count <n>',
    '',
    '- `--count <n>` — how many forks, 1 to 8. Omit it for one.',
    '- `--prompt "<text>"` — optional opening message sent to every fork.',
    '',
    'The command waits up to 30 seconds for a Flock window to answer, then',
    'prints the outcome. Report that outcome to the user — it names the new',
    'branches, or says exactly why nothing was forked.',
    '',
    'Notes:',
    '',
    '- "fork this session", "do three forks here", "branch off a copy" all',
    '  mean this verb. Parse the count from the request; default to 1.',
    '- Each fork opens as a terminal tab in VS Code holding a full copy of',
    '  this conversation. This session itself is never modified.',
    '- If the script cannot tell which session it is running in, say so —',
    '  that happens in terminals Flock did not launch.',
    '',
    '<!-- Written by the Flock VS Code extension (in-session verbs v' +
      String(VERBS_VERSION) +
      '). Remove with "Flock: Remove In-Session Verbs". -->',
    '',
  ].join('\n');
}

/** The CLI the skill invokes. Plain node, no dependencies, top-level await.
 *  Identity resolution mirrors what the extension itself relies on: the
 *  LINEAGE_NODE_ID stamp our terminals launch with (types.ENV_NODE_ID),
 *  CLAUDE_SESSION_ID where the CLI provides it, and the `lineage-<uuid>` tmux
 *  session name (tmux.ts) as the fallback that survives env stripping. */
export function renderVerbScript(): string {
  return [
    '#!/usr/bin/env node',
    '// ~/.lineage/flock-verbs.mjs — written by the Flock VS Code extension',
    '// (in-session verbs v' + String(VERBS_VERSION) + '). A Claude Code session runs this to ask',
    '// Flock for a verb:',
    '//',
    '//   node ~/.lineage/flock-verbs.mjs fork [--count N] [--prompt "..."]',
    '//',
    '// The request lands in ~/.lineage/requests/, one Flock window claims it,',
    '// runs the same fork the sidebar button runs, and replies here.',
    "import { execFileSync } from 'node:child_process';",
    "import { randomUUID } from 'node:crypto';",
    "import * as fs from 'node:fs';",
    "import * as os from 'node:os';",
    "import * as path from 'node:path';",
    '',
    "const DIR = path.join(os.homedir(), '.lineage', 'requests');",
    'const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;',
    'const WAIT_MS = 30000;',
    'const POLL_MS = 250;',
    '',
    'function die(msg) { console.error(msg); process.exit(1); }',
    '',
    'function sessionId() {',
    '  const env = process.env;',
    "  if (UUID.test(env.LINEAGE_NODE_ID || '')) return env.LINEAGE_NODE_ID;",
    "  if (UUID.test(env.CLAUDE_SESSION_ID || '')) return env.CLAUDE_SESSION_ID;",
    '  if (env.TMUX && env.TMUX_PANE) {',
    '    try {',
    '      const name = execFileSync(',
    "        'tmux',",
    "        ['display-message', '-p', '-t', env.TMUX_PANE, '#S'],",
    "        { encoding: 'utf8' },",
    '      ).trim();',
    '      const m = /^lineage-([0-9a-f-]{36})$/i.exec(name);',
    '      if (m && UUID.test(m[1])) return m[1];',
    '    } catch { /* not in tmux, or tmux is gone — a normal answer */ }',
    '  }',
    '  return null;',
    '}',
    '',
    'const argv = process.argv.slice(2);',
    "if (argv[0] !== 'fork') {",
    '  die(\'usage: flock-verbs.mjs fork [--count N] [--prompt "..."]\');',
    '}',
    'let count = 1;',
    'let prompt;',
    'for (let i = 1; i < argv.length; i++) {',
    '  const a = argv[i];',
    "  if (a === '--count') count = Number(argv[++i]);",
    "  else if (a === '--prompt') prompt = argv[++i];",
    '  else if (/^--count=/.test(a)) count = Number(a.slice(8));',
    '  else if (/^--prompt=/.test(a)) prompt = a.slice(9);',
    "  else die('unknown argument: ' + a);",
    '}',
    'if (!Number.isInteger(count) || count < 1 || count > ' + String(MAX_AGENT_FORKS) + ') {',
    "  die('--count must be a whole number from 1 to " + String(MAX_AGENT_FORKS) + ".');",
    '}',
    "if (typeof prompt === 'string' && prompt.length > " + String(MAX_AGENT_PROMPT_CHARS) + ') {',
    "  die('--prompt is longer than " + String(MAX_AGENT_PROMPT_CHARS) + " characters.');",
    '}',
    'const node = sessionId();',
    'if (!node) {',
    "  die('Could not tell which session this is. Forking from inside works ' +",
    "    'in sessions launched by Flock (or any session that sets ' +",
    "    'CLAUDE_SESSION_ID).');",
    '}',
    '',
    'fs.mkdirSync(DIR, { recursive: true });',
    'const id = randomUUID();',
    "const reqFile = path.join(DIR, id + '.json');",
    "const replyFile = path.join(DIR, id + '.reply.json');",
    "const body = { v: 1, verb: 'fork', node, count };",
    "if (typeof prompt === 'string' && prompt.length > 0) body.prompt = prompt;",
    "const tmp = path.join(DIR, '.' + id + '.tmp');",
    "fs.writeFileSync(tmp, JSON.stringify(body) + '\\n');",
    'fs.renameSync(tmp, reqFile);',
    '',
    'const deadline = Date.now() + WAIT_MS;',
    'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
    'let reply = null;',
    'while (Date.now() < deadline) {',
    '  try {',
    "    reply = JSON.parse(fs.readFileSync(replyFile, 'utf8'));",
    '    break;',
    '  } catch { /* no reply yet */ }',
    '  await sleep(POLL_MS);',
    '}',
    'if (reply === null) {',
    '  // Unclaimed after the wait: withdraw the request, so a window opened',
    '  // an hour later does not run a fork nobody is waiting for. A claimed',
    '  // request is left alone — that fork is still coming.',
    '  let withdrawn = false;',
    '  try { fs.unlinkSync(reqFile); withdrawn = true; } catch { /* claimed */ }',
    '  die(withdrawn',
    "    ? 'No Flock window answered within 30 seconds. Is VS Code open ' +",
    "      'with the Flock extension running?'",
    "    : 'A Flock window claimed the request but has not replied yet — ' +",
    "      'check the Flock sidebar.');",
    '}',
    'try { fs.unlinkSync(replyFile); } catch { /* already gone is fine */ }',
    'if (reply.ok === true) {',
    '  const n = Array.isArray(reply.forked) ? reply.forked.length : 0;',
    '  const titles = Array.isArray(reply.titles) && reply.titles.length > 0',
    "    ? ' — ' + reply.titles.join(', ')",
    "    : '';",
    "  console.log('Forked ' + n + ' new session' + (n === 1 ? '' : 's') +",
    "    titles + '. They are open in the Flock sidebar.');",
    '} else {',
    "  die('Flock declined: ' + (reply.error || 'unknown error'));",
    '}',
    '',
  ].join('\n');
}

// ----------------------------------------------------------------- requests

/** One validated fork request. `count` is already clamped; anything the
 *  validator could not accept is an `{ error }` instead — the caller still
 *  claims the file and REPLIES with the error, so the CLI never times out on
 *  a request the extension actually saw. */
export type ParsedRequest =
  | { verb: 'fork'; node: string; count: number; prompt?: string }
  | { error: string };

export function parseRequestText(text: string): ParsedRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: 'the request file is not valid JSON' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'the request is not an object' };
  }
  const body = raw as Record<string, unknown>;
  if (body['v'] !== 1) return { error: 'unknown request version' };
  if (body['verb'] !== 'fork') {
    return { error: `unknown verb ${JSON.stringify(body['verb'])}` };
  }
  const node = body['node'];
  if (!isSessionId(node)) return { error: 'the request names no session' };
  const count = clampForkCount(body['count']);
  const prompt = body['prompt'];
  if (prompt !== undefined) {
    if (typeof prompt !== 'string' || prompt.length === 0) {
      return { error: 'the prompt is not a string' };
    }
    if (prompt.length > MAX_AGENT_PROMPT_CHARS) {
      return {
        error: `the prompt is longer than ${MAX_AGENT_PROMPT_CHARS} characters`,
      };
    }
    return { verb: 'fork', node, count, prompt };
  }
  return { verb: 'fork', node, count };
}

/** 1..MAX_AGENT_FORKS; anything unusable is 1, never a refusal — a count is a
 *  quantity, not a capability. */
export function clampForkCount(raw: unknown): number {
  const n = typeof raw === 'number' ? Math.trunc(raw) : NaN;
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_AGENT_FORKS);
}

/** What execution hands back; `titles` ride along so the CLI can name the
 *  branches in its one line of output. */
export interface AgentForkOutcome {
  forked: string[];
  titles: string[];
  error?: string;
}

/** The window-side capabilities the watcher runs requests against. Injected
 *  whole so the module never imports commands.ts or the terminal registry —
 *  and so a test can be three lambdas. */
export interface VerbExecutor {
  /** Does THIS window own a terminal for the session? Decides claim priority,
   *  never eligibility. */
  isBoundHere(sessionId: string): boolean;
  /** launch-id → current generation, chainIndex.tipOf. */
  tipOf(sessionId: string): string;
  /** The verb itself — forkForAgent(commandDeps, …) in the real wiring. */
  runFork(
    nodeId: string,
    count: number,
    prompt?: string,
  ): Promise<AgentForkOutcome>;
}

export interface VerbsDeps {
  getStored(): unknown;
  setStored(s: HookInstallState): Promise<void> | void;
}

/** Test seam: the two delays that make the claim protocol slow enough to be
 *  polite and would make a test slow enough to be flaky. */
export interface VerbsTiming {
  claimDelayMs?: number;
  fallbackMs?: number;
  requestTtlMs?: number;
}

// ------------------------------------------------------------------ manager

interface DesiredFile {
  path: string;
  text: string;
  label: string;
}

export class AgentVerbsManager implements DisposableLike {
  private readonly deps: VerbsDeps;
  private readonly home: string;
  private readonly claimDelayMs: number;
  private readonly fallbackMs: number;
  private readonly requestTtlMs: number;

  private executor: VerbExecutor | null = null;
  private dirWatcher: fs.FSWatcher | null = null;
  private fallbackTimer: NodeJS.Timeout | null = null;
  /** request id → the pending claim timer, so a second watch event for the
   *  same file cannot arm a second claim. */
  private readonly inFlight = new Map<string, NodeJS.Timeout>();
  private disposed = false;
  private watchErrorLogged = false;

  constructor(deps: VerbsDeps, home?: string, timing?: VerbsTiming) {
    this.deps = deps;
    this.home = homeDir(home);
    this.claimDelayMs = timing?.claimDelayMs ?? CLAIM_DELAY_MS;
    this.fallbackMs = timing?.fallbackMs ?? WATCH_FALLBACK_MS;
    this.requestTtlMs = timing?.requestTtlMs ?? REQUEST_TTL_MS;
  }

  // ------------------------------------------------------------- accessors

  getState(): HookInstallState {
    try {
      const stored = this.deps.getStored() as HookInstallState | undefined;
      if (stored && typeof stored === 'object') {
        return { ...stored, installed: stored.installed === true };
      }
    } catch (err) {
      logError('verbs: read stored state', err);
    }
    return { installed: false };
  }

  /** Truth on disk, not the stored flag — `rm -rf` is a documented
   *  uninstall here too. */
  isInstalled(): boolean {
    return this.verify().ok;
  }

  directory(): string {
    return verbsSkillDir(this.home);
  }

  scriptFile(): string {
    return verbsScriptPath(this.home);
  }

  requestsPath(): string {
    return requestsDir(this.home);
  }

  // --------------------------------------------------------------- install

  /** Idempotent, consent-gated by ONE modal, exactly the hooks contract:
   *  nothing sits between the user clicking Install and the bytes landing. */
  async install(): Promise<HookInstallState> {
    const stored = this.getState();
    if (process.platform === 'win32') {
      void showWarning(
        'Flock in-session verbs need a POSIX home layout and are not ' +
          'supported on Windows yet.',
      );
      log('verbs: install skipped (win32)');
      return stored;
    }

    const files = this.desiredFiles();
    if (files.every((f) => readTextSync(f.path) === f.text)) {
      log('verbs: already installed at', this.directory());
      const state = await this.markInstalled();
      void showInfo(
        `Flock in-session verbs are already installed at ${this.directory()}.`,
      );
      return state;
    }

    const consent = await showInfo(
      'Let Claude fork its own session?',
      { modal: true, detail: this.consentDetail(files) },
      'Install',
    );
    if (consent !== 'Install') {
      log('verbs: install declined');
      return stored;
    }

    const drifted = files.filter((f) => readTextSync(f.path) !== f.text);
    try {
      for (const f of drifted) {
        writeTextAtomicSync(f.path, f.text);
        log('verbs: wrote', f.label, '→', f.path);
      }
    } catch (err) {
      logError('verbs: write files', err);
      void showWarning(
        'Could not write the in-session verb files — see the Flock output ' +
          'channel.',
      );
      return stored;
    }

    const verdict = this.verify();
    if (!verdict.ok) {
      log('verbs: install did not verify —', verdict.reason ?? 'unknown');
      void showWarning(
        `Flock in-session verbs were not installed: ${verdict.reason ?? 'unknown error'}.`,
      );
      return stored;
    }

    this.ensureRequestsDir();
    const state = await this.markInstalled();
    void showInfo(
      'In-session verbs installed. New Claude sessions can fork themselves; ' +
        'existing ones pick the skill up after /reload-plugins or a restart.',
    );
    log('verbs: installed at', this.directory());
    return state;
  }

  /** Safety-gated removal: the skill directory goes only when its SKILL.md is
   *  recognisably OURS, and the script only when it carries our header. The
   *  requests directory is kept — it is transient state, swept by the
   *  watcher, and deleting a directory another window may be mid-rename in
   *  is how claims get lost. */
  async remove(): Promise<HookInstallState> {
    const dir = this.directory();
    const skillText = readTextSync(this.skillPath());
    if (skillText !== null) {
      if (
        path.basename(dir) !== VERBS_SKILL_NAME ||
        !skillText.includes(SCRIPT_BASENAME)
      ) {
        void showWarning(
          `Refusing to remove ${dir}: it is not the Flock verbs skill. ` +
            'Delete it by hand if you are sure.',
        );
        log('verbs: remove refused — foreign directory at', dir);
        return this.getState();
      }
      try {
        await fsp.rm(dir, { recursive: true, force: true });
      } catch (err) {
        logError('verbs: remove skill directory', err);
        void showWarning(
          `Could not remove ${dir} — see the Flock output channel.`,
        );
        return this.getState();
      }
    }
    const script = this.scriptFile();
    const scriptText = readTextSync(script);
    if (scriptText !== null && scriptText.includes('Flock VS Code extension')) {
      try {
        await fsp.rm(script, { force: true });
      } catch (err) {
        logError('verbs: remove script', err);
      }
    }
    const state = await this.markRemoved();
    void showInfo(
      'Flock in-session verbs removed. Existing Claude sessions keep the ' +
        'skill until /reload-plugins or a restart.',
    );
    log('verbs: removed', dir);
    return state;
  }

  /** ACTIVATE-time reconciliation, the hooks policy verbatim: gone → clear
   *  the stored flag (never recreate what the user deleted); broken or
   *  version-bumped → rewrite what was already consented to; hand-edited but
   *  still wired to us → left alone. */
  async selfHeal(): Promise<HookInstallState> {
    const stored = this.getState();
    if (!stored.installed) return stored;
    if (process.platform === 'win32') return stored;

    const files = this.desiredFiles();
    const onDisk = files.map((f) => readTextSync(f.path));
    if (onDisk.every((t) => t === null)) {
      log('verbs: files are gone; clearing stored install state');
      return this.markRemoved();
    }

    const drifted = files.filter((f, i) => onDisk[i] !== f.text);
    if (drifted.length === 0) {
      if (
        stored.pluginVersion === VERBS_VERSION &&
        stored.pluginDir === this.directory()
      ) {
        return stored;
      }
      return this.markInstalled();
    }

    const anyMissing = onDisk.some((t) => t === null);
    const versionBumped = stored.pluginVersion !== VERBS_VERSION;
    if (!anyMissing && !versionBumped && this.verify().ok) {
      log('verbs: files were edited but still carry our verb; leaving them');
      return stored.pluginDir === this.directory()
        ? stored
        : this.markInstalled();
    }

    try {
      for (const f of drifted) writeTextAtomicSync(f.path, f.text);
    } catch (err) {
      logError('verbs: self-heal', err);
      return stored;
    }
    const verdict = this.verify();
    if (!verdict.ok) {
      log('verbs: self-heal did not verify —', verdict.reason ?? 'unknown');
      return stored;
    }
    log('verbs: self-healed', String(drifted.length), 'file(s)');
    return this.markInstalled();
  }

  // --------------------------------------------------------------- watcher

  /** Watch the requests directory. Idempotent; a second call swaps the
   *  executor. Safe to call when nothing was ever installed — no request
   *  ever arrives. */
  startWatcher(executor: VerbExecutor): void {
    if (this.disposed) return;
    if (this.executor) {
      this.executor = executor;
      return;
    }
    this.executor = executor;
    this.ensureRequestsDir();
    this.sweep();
    this.armWatcher();
    this.fallbackTimer = unref(
      setInterval(() => this.scan(), this.fallbackMs),
    );
    log('verbs: watching', this.requestsPath());
    this.scan();
  }

  stopWatcher(): void {
    this.executor = null;
    this.closeWatcher();
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.fallbackTimer = null;
    for (const timer of this.inFlight.values()) clearTimeout(timer);
    this.inFlight.clear();
  }

  dispose(): void {
    // Removes NOTHING from disk — same deactivate() contract as hooks.ts.
    this.disposed = true;
    this.stopWatcher();
  }

  // ------------------------------------------------------------------ guts

  private skillPath(): string {
    return path.join(this.directory(), 'SKILL.md');
  }

  private desiredFiles(): DesiredFile[] {
    return [
      { path: this.skillPath(), text: renderSkillMd(), label: 'skill' },
      { path: this.scriptFile(), text: renderVerbScript(), label: 'verb CLI' },
    ];
  }

  private consentDetail(files: DesiredFile[]): string {
    return [
      'Flock will write a Claude Code skill and the small CLI it invokes. No',
      'marketplace, no install step, and no shared file (including',
      '~/.claude/settings.json) is touched:',
      '',
      ...files.map((f) => `    ${f.path}`),
      '',
      'With these in place, asking Claude to "fork this session" makes it run',
      'the CLI, which writes a request into',
      `${this.requestsPath()} — and a Flock window runs the same`,
      'fork the sidebar button runs. Nothing leaves your machine.',
      '',
      'Existing Claude sessions pick the skill up after /reload-plugins or a',
      'restart. Remove it any time with "Remove In-Session Verbs", or',
      `rm -rf ${this.directory()}`,
    ].join('\n');
  }

  private verify(): { ok: boolean; reason?: string } {
    const skill = readTextSync(this.skillPath());
    if (skill === null) return { ok: false, reason: 'SKILL.md is missing' };
    if (!skill.includes(SCRIPT_BASENAME)) {
      return { ok: false, reason: 'SKILL.md no longer invokes the Flock CLI' };
    }
    const script = readTextSync(this.scriptFile());
    if (script === null) {
      return { ok: false, reason: `${SCRIPT_BASENAME} is missing` };
    }
    if (!script.includes('Flock VS Code extension')) {
      return { ok: false, reason: `${SCRIPT_BASENAME} is not ours` };
    }
    return { ok: true };
  }

  private ensureRequestsDir(): void {
    try {
      fs.mkdirSync(this.requestsPath(), { recursive: true });
    } catch (err) {
      logError('verbs: create requests directory', err);
    }
  }

  private async markInstalled(): Promise<HookInstallState> {
    const prev = this.getState();
    const state: HookInstallState = {
      installed: true,
      pluginDir: this.directory(),
      installedAt:
        prev.installed && typeof prev.installedAt === 'string'
          ? prev.installedAt
          : new Date().toISOString(),
      pluginVersion: VERBS_VERSION,
    };
    await this.store(state);
    return state;
  }

  private async markRemoved(): Promise<HookInstallState> {
    const state: HookInstallState = { installed: false };
    await this.store(state);
    return state;
  }

  private async store(state: HookInstallState): Promise<void> {
    try {
      await this.deps.setStored(state);
    } catch (err) {
      logError('verbs: persist install state', err);
    }
  }

  private armWatcher(): void {
    if (this.disposed || !this.executor || this.dirWatcher) return;
    const dir = this.requestsPath();
    if (!fs.existsSync(dir)) return;
    try {
      const watcher = fs.watch(dir, { persistent: false }, () => this.scan());
      watcher.on('error', (err) => {
        logError('verbs: requests watcher', err);
        this.closeWatcher();
      });
      this.dirWatcher = watcher;
      this.watchErrorLogged = false;
    } catch (err) {
      if (!this.watchErrorLogged) {
        logError('verbs: fs.watch requests dir', err);
        this.watchErrorLogged = true;
      }
      this.dirWatcher = null;
    }
  }

  private closeWatcher(): void {
    if (this.dirWatcher) {
      try {
        this.dirWatcher.close();
      } catch (err) {
        logError('verbs: close watcher', err);
      }
      this.dirWatcher = null;
    }
  }

  /** One pass over the directory. Never throws; every failure leaves the
   *  request for the fallback tick or another window. */
  private scan(): void {
    const executor = this.executor;
    if (this.disposed || !executor) return;
    this.armWatcher(); // re-arm a watcher that died or a dir created late
    let entries: string[];
    try {
      entries = fs.readdirSync(this.requestsPath());
    } catch {
      return; // directory missing: nothing to claim
    }
    for (const entry of entries) {
      const m = REQUEST_RE.exec(entry);
      if (!m) continue;
      const id = m[1].toLowerCase();
      if (this.inFlight.has(id)) continue;
      const file = path.join(this.requestsPath(), entry);

      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue; // claimed or withdrawn between readdir and stat
      }
      if (st.size > MAX_REQUEST_BYTES) {
        this.armClaim(id, file, this.claimDelayMs, {
          error: 'the request file is too large',
        });
        continue;
      }
      const expired = Date.now() - st.mtimeMs > this.requestTtlMs;
      if (expired) {
        this.armClaim(id, file, this.claimDelayMs, {
          error: 'the request expired before a Flock window saw it',
        });
        continue;
      }

      const text = readTextSync(file);
      if (text === null) continue;
      const parsed = parseRequestText(text);
      if ('error' in parsed) {
        this.armClaim(id, file, this.claimDelayMs, parsed);
        continue;
      }

      // Priority: the window whose terminal hosts the conversation claims at
      // once; everybody else gives it CLAIM_DELAY_MS of head start. Bound
      // nowhere, every window races at the delay and rename picks one.
      let delay = this.claimDelayMs;
      try {
        if (executor.isBoundHere(executor.tipOf(parsed.node))) delay = 0;
      } catch (err) {
        logError('verbs: bound check', err);
      }
      this.armClaim(id, file, delay, parsed);
    }
  }

  private armClaim(
    id: string,
    file: string,
    delay: number,
    parsed: ParsedRequest,
  ): void {
    const timer = unref(
      setTimeout(() => {
        this.inFlight.delete(id);
        void this.claimAndRun(id, file, parsed);
      }, delay),
    );
    this.inFlight.set(id, timer);
  }

  private async claimAndRun(
    id: string,
    file: string,
    parsed: ParsedRequest,
  ): Promise<void> {
    const executor = this.executor;
    if (this.disposed || !executor) return;
    const claimed = `${file}.claimed-${process.pid}`;
    try {
      fs.renameSync(file, claimed);
    } catch {
      return; // another window won, or the CLI withdrew it. Both fine.
    }

    // Re-entry guard: while the fork runs, keep the id in-flight so the
    // fallback tick cannot see a half-written state and start again.
    this.inFlight.set(id, unref(setTimeout(() => undefined, 0)));
    let outcome: AgentForkOutcome;
    try {
      if ('error' in parsed) {
        outcome = { forked: [], titles: [], error: parsed.error };
      } else {
        log(
          'verbs: fork ×' + String(parsed.count),
          'of',
          shortId(parsed.node),
          parsed.prompt !== undefined ? '(with prompt)' : '',
        );
        outcome = await executor.runFork(
          parsed.node,
          parsed.count,
          parsed.prompt,
        );
      }
    } catch (err) {
      logError('verbs: run fork', err);
      outcome = {
        forked: [],
        titles: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const reply: Record<string, unknown> = {
      ok: outcome.forked.length > 0 && outcome.error === undefined,
      forked: outcome.forked,
      titles: outcome.titles,
    };
    if (outcome.error !== undefined) reply.error = outcome.error;
    try {
      writeTextAtomicSync(
        path.join(this.requestsPath(), `${id}${REPLY_SUFFIX}`),
        JSON.stringify(reply) + '\n',
      );
    } catch (err) {
      logError('verbs: write reply', err);
    }
    try {
      fs.unlinkSync(claimed);
    } catch (err) {
      logError('verbs: remove claimed request', err);
    }
    this.inFlight.delete(id);
  }

  /** Startup hygiene: replies nobody collected, claims from a window that
   *  crashed mid-fork, hour-old anything. Bounded by directory size and run
   *  once per watcher start. */
  private sweep(): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.requestsPath());
    } catch {
      return;
    }
    const cutoff = Date.now() - SWEEP_AGE_MS;
    for (const entry of entries) {
      const stale =
        entry.endsWith(REPLY_SUFFIX) ||
        CLAIM_RE.test(entry) ||
        entry.startsWith('.');
      const file = path.join(this.requestsPath(), entry);
      try {
        const st = fs.statSync(file);
        if (st.mtimeMs >= cutoff) continue;
        if (!stale && !REQUEST_RE.test(entry)) continue; // not ours to sweep
        fs.unlinkSync(file);
        log('verbs: swept stale', entry);
      } catch {
        /* a race with another window's sweep; nothing to do */
      }
    }
  }
}

// ------------------------------------------------------------------ helpers

function homeDir(home?: string): string {
  if (typeof home === 'string' && home.length > 0) return home;
  try {
    const h = os.homedir();
    if (typeof h === 'string' && h.length > 0) return h;
  } catch (err) {
    logError('verbs: homedir', err);
  }
  return process.env['HOME'] ?? '.';
}

function readTextSync(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** tmp file in the SAME directory, fsync, rename. Unlike hooks.ts's variant
 *  this validates nothing — SKILL.md and the CLI are not JSON. */
function writeTextAtomicSync(file: string, text: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* the temp file is ours; a failed cleanup is not worth reporting */
    }
    throw err;
  }
}

function unref(timer: NodeJS.Timeout): NodeJS.Timeout {
  timer.unref?.();
  return timer;
}

// The same narrow vscode shims hooks.ts uses, so a unit-test double without
// the message APIs degrades to "no UI" instead of throwing.

interface MessageApi {
  showInformationMessage?(
    message: string,
    options: vscode.MessageOptions,
    ...items: string[]
  ): Thenable<string | undefined>;
  showWarningMessage?(
    message: string,
    options: vscode.MessageOptions,
    ...items: string[]
  ): Thenable<string | undefined>;
}

function windowApi(): MessageApi {
  return (vscode.window ?? {}) as unknown as MessageApi;
}

async function showInfo(
  message: string,
  options?: vscode.MessageOptions,
  ...items: string[]
): Promise<string | undefined> {
  const api = windowApi();
  if (typeof api.showInformationMessage !== 'function') return undefined;
  try {
    return await api.showInformationMessage(message, options ?? {}, ...items);
  } catch (err) {
    logError('verbs: information message', err);
    return undefined;
  }
}

async function showWarning(message: string): Promise<string | undefined> {
  const api = windowApi();
  if (typeof api.showWarningMessage !== 'function') return undefined;
  try {
    return await api.showWarningMessage(message, {});
  } catch (err) {
    logError('verbs: warning message', err);
    return undefined;
  }
}
