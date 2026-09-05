// src/hooks.ts — the opt-in hooks accelerator.
//
// Hooks buy instant updates and coverage of sessions we never launched. They
// are NEVER required: `disableAllHooks`, `allowManagedHooksOnly`,
// `--safe-mode` and `--bare` all skip hook discovery, so events may simply
// never arrive. Everything here is additive — the roster poller carries the
// extension on its own and nothing may assume events flow.
//
// Installation is a SKILLS-DIRECTORY PLUGIN, never a settings.json edit:
//
//   ~/.claude/skills/lineage-events/
//   ├── .claude-plugin/plugin.json
//   └── hooks/hooks.json
//
// That directory loads as `lineage-events@skills-dir` with no marketplace, no
// install step and no mutation of any shared file; `rm -rf` uninstalls it.
// Two costs are surfaced in the UI: hook changes need `/reload-plugins` (or a
// session restart), and plugin-provided SessionEnd hooks are capped at the
// default 1.5 s budget — per-hook timeouts do NOT raise it for plugin hooks —
// so the hook command must stay a single instant append and no slow wrap-up
// work may ever move into it.
//
// Version-proofing rule: what persists into a user-visible location is only a
// PATH-resolved invocation (`/bin/sh`) plus `$HOME`-relative paths into a
// directory we own and never version (`~/.lineage`). NEVER an extension
// install path — those are version- and target-scoped
// (`publisher.name-version-target`) and an update creates a NEW directory.
// `~/.claude/statusline.sh` is Anthropic's own precedent for the stable
// `$HOME`-relative shape.
//
// Self-heal happens on ACTIVATE (see selfHeal()). Nothing is ever cleaned up
// in deactivate(): config edits there are explicitly unsupported and
// globalState.update() silently no-ops.

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as process from 'node:process';

import { isSessionId } from './types';
import type {
  DisposableLike,
  HookDeps,
  HookEvent,
  HookInstallState,
} from './types';
import { log, logError } from './log';

// --------------------------------------------------------------- constants

export const PLUGIN_NAME = 'lineage-events';
/** Bumped whenever the generated files change; drives silent self-heal.
 *  v2: HOOK_COMMAND became a single-write append (see below).
 *  v3: the append wraps the payload with the LINEAGE_NODE_ID the hook
 *  inherited, and UserPromptSubmit joined the event list — together these are
 *  the enrollment channel: a hook event carries the id of the conversation the
 *  terminal was launched for, so a session whose id has churned can be re-keyed
 *  from an exact signal rather than a guess (see HookEvent.nodeId).
 *  v4: PreCompact joined the event list. It is the ONLY signal that says a
 *  compaction has STARTED — the roster reports such a session as plainly
 *  `busy`, indistinguishable from a turn, and the transcript's
 *  `compact_boundary` record is only written once the compaction is already
 *  over. Without it the purple ring has nothing to key on. */
export const PLUGIN_VERSION = 4;
/** semver stamped into plugin.json (the plugin loader wants a semver). */
const PLUGIN_SEMVER = '0.1.0';

const EVENTS_DIR_NAME = '.lineage';
const EVENTS_BASENAME = 'events.ndjson';

/** Truncate the append-only log once it grows past this. */
const MAX_EVENTS_BYTES = 5 * 1024 * 1024;
/** Never re-read more than this in one drain — skip to the tail instead. */
const MAX_DRAIN_BYTES = 4 * 1024 * 1024;
/** Cap on a partial (newline-less) tail we are willing to buffer. */
const MAX_PENDING_BYTES = 1024 * 1024;
/** fs.watch coalescing window. */
const DRAIN_DEBOUNCE_MS = 40;
/** Safety net: macOS coalesces FSEvents (a directory notification can arrive
 *  with the DIRECTORY's own name and nothing else), network filesystems drop
 *  them entirely, and a watcher can die silently. A statSync at this cadence
 *  is orders of magnitude cheaper than the roster poll it accelerates. */
const WATCH_FALLBACK_MS = 2_000;
/** An event this recent means hooks are demonstrably live. */
export const HOOK_ACTIVITY_WINDOW_MS = 10 * 60_000;
/** Installed + roster activity + no event for this long = report it. */
export const HOOK_SILENCE_WARN_MS = 5 * 60_000;
const SILENCE_CHECK_MS = 60_000;
/** Roster ticks carrying live sessions before "silent" is worth a toast. */
const SILENCE_MIN_ACTIVITY_TICKS = 3;

const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);

/** <home>/.claude/skills/lineage-events */
export function pluginDir(home?: string): string {
  return path.join(homeDir(home), '.claude', 'skills', PLUGIN_NAME);
}

/** <home>/.lineage/events.ndjson — a $HOME-relative directory WE own and
 *  never version (never an extension install path: those are version- and
 *  target-scoped). */
export function eventsFile(home?: string): string {
  return path.join(homeDir(home), EVENTS_DIR_NAME, EVENTS_BASENAME);
}

/**
 * The append is instant — well inside the plugin-hook 1.5 s SessionEnd cap.
 * No slow work may ever move into this command.
 *
 * ONE write(2), deliberately. The earlier `{ cat; echo; } >> file` form issued
 * the payload and its terminating newline as two separate writes on the same
 * O_APPEND descriptor, so a hook firing concurrently in another session could
 * land its payload between them. That merges two JSON objects onto one line;
 * `parseEventLine` then rejects it and BOTH events are silently dropped —
 * measured at ~13% loss under eight concurrent appends, i.e. exactly the
 * parallel-session workload this extension exists for. Buffering the payload
 * and emitting it with a single `printf` makes the append atomic for any line
 * below PIPE_BUF.
 *
 * v3 shape: `{"lineage_node_id":"<env>","payload":<stdin JSON>}`. The
 * LINEAGE_NODE_ID environment variable is the stamp our terminals launch
 * claude with, inherited by the hook process — so every event says WHICH of
 * our launches it fired inside, which is what lets a re-minted session id
 * (plain --resume, /clear, compaction) be re-keyed onto its conversation
 * instead of becoming a duplicate row. Unset (a session we did not launch)
 * yields an empty string, and empty stdin degrades to `payload:null` — both
 * still parse, both still poke. Still ONE write(2); see the v2 note above on
 * why the append must stay a single printf.
 */
export const HOOK_COMMAND =
  '/bin/sh -c \'mkdir -p "$HOME/.lineage"; p=$(cat); [ -n "$p" ] || p=null; ' +
  'printf "{\\"lineage_node_id\\":\\"%s\\",\\"payload\\":%s}\\n" ' +
  '"${LINEAGE_NODE_ID:-}" "$p" >> "$HOME/.lineage/events.ndjson"\'';

/**
 * The same append, for Windows, in PowerShell.
 *
 * WHY POWERSHELL. Claude Code runs a shell-form hook through `sh -c` on
 * macOS and Linux, through Git Bash on Windows, and through PowerShell on a
 * Windows without Git Bash — and each hook may name its shell (`"shell":
 * "powershell"`), which `renderHooksJson` does for this one. PowerShell is
 * the shell every Windows has; Git Bash is optional. So the Windows hook is
 * written for the shell that is always there, and the `/bin/sh` line above
 * stays exactly what it was.
 *
 * WHAT IT DOES, line for line: reads the payload from stdin (`null` when
 * empty), makes `~/.lineage` (the profile folder is what `os.homedir()`
 * returns on Windows, so the extension and the hook agree on the path),
 * builds the same v3 envelope the POSIX command prints, and appends it with
 * ONE write through a stream opened for shared read-write — the closest
 * Windows comes to the atomic O_APPEND write the printf above relies on.
 * Two hooks landing in the same millisecond can still interleave here, and a
 * torn line is dropped by `parseEventLine` rather than misread; the poller
 * covers whatever a dropped event would have said.
 *
 * NO DOUBLE QUOTES ANYWHERE IN IT, on purpose: the string travels from
 * hooks.json into whatever argv the CLI builds for PowerShell, and a `"` is
 * the one character every layer on that path has an opinion about. `[char]34`
 * is the quote and `[char]10` the newline. The line ends in LF alone, which is
 * what the reader splits on.
 */
export const HOOK_COMMAND_WINDOWS =
  '$q=[char]34;$p=[Console]::In.ReadToEnd().Trim();if(-not $p){$p=\'null\'};' +
  '$d=Join-Path ([Environment]::GetFolderPath(\'UserProfile\')) \'.lineage\';' +
  'New-Item -ItemType Directory -Force -Path $d|Out-Null;' +
  '$n=[string]$env:LINEAGE_NODE_ID;' +
  '$b=[Text.Encoding]::UTF8.GetBytes(\'{\'+$q+\'lineage_node_id\'+$q+\':\'+$q+$n+$q+\',\'+$q+\'payload\'+$q+\':\'+$p+\'}\'+[char]10);' +
  '$s=[IO.File]::Open((Join-Path $d \'events.ndjson\'),\'Append\',\'Write\',\'ReadWrite\');' +
  'try{$s.Write($b,0,$b.Length)}finally{$s.Dispose()}';

/** The hook command for a platform — `HOOK_COMMAND` everywhere but win32. */
export function hookCommandFor(platform: string): string {
  return platform === 'win32' ? HOOK_COMMAND_WINDOWS : HOOK_COMMAND;
}

/** The hook events we listen for. Every one is a pure accelerator.
 *  UserPromptSubmit (v3) is the freshness beat: it fires on every prompt, so
 *  a conversation whose id churned is re-keyed within one user action, which is
 *  the tightest cadence available without polling. */
const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'Stop',
  'Notification',
  'UserPromptSubmit',
  // PreCompact (v4) is the compaction beat, and the only one there is on the
  // way IN: a compacting session reports `busy` on the roster exactly like a
  // session mid-turn, and the transcript's `compact_boundary` record does not
  // exist until the compaction has already finished. The way OUT is
  // SessionStart's `source: 'compact'`, which we already listen for. See
  // src/compaction.ts for what the pair is read as.
  'PreCompact',
] as const;

/** JSON.stringify({name, version: '0.1.0', description}, null, 2) */
export function renderPluginJson(): string {
  return JSON.stringify(
    {
      name: PLUGIN_NAME,
      version: PLUGIN_SEMVER,
      description:
        'Appends Claude Code session events to ~/.lineage/events.ndjson so the ' +
        'Flock VS Code extension can refresh instantly. Delete this directory ' +
        'to uninstall.',
    },
    null,
    2,
  );
}

/** Every HOOK_EVENTS entry, each a single-element matcher-less array of
 *  {hooks:[{type:'command', command}]} — the platform's command, and on win32
 *  `shell: 'powershell'` beside it, so the CLI runs it through PowerShell
 *  whether or not Git Bash is installed. Rendered per machine: the plugin
 *  directory lives in the user's home, so a file written on Windows is only
 *  ever read on Windows, and self-heal compares against the same rendering. */
export function renderHooksJson(platform: string = process.platform): string {
  const hook: Record<string, string> = { type: 'command', command: hookCommandFor(platform) };
  if (platform === 'win32') hook['shell'] = 'powershell';
  const hooks: Record<string, unknown[]> = {};
  for (const event of HOOK_EVENTS) {
    hooks[event] = [{ hooks: [hook] }];
  }
  return JSON.stringify({ hooks }, null, 2);
}

/** JSON.parse; non-object -> null; hook_event_name/session_id/
 *  transcript_path mapped, session_id must pass isSessionId else null.
 *  Accepts BOTH line shapes: the v3 wrapper (`lineage_node_id` + `payload`)
 *  and the flat v2 payload — a v2 plugin keeps emitting flat lines until its
 *  session restarts, and dropping those would turn the upgrade into an
 *  outage. */
export function parseEventLine(line: string): HookEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  let body: Record<string, unknown> = parsed;
  let nodeId: string | null = null;
  if ('lineage_node_id' in parsed) {
    const nid = parsed['lineage_node_id'];
    nodeId = isSessionId(nid) ? nid : null;
    const payload = parsed['payload'];
    body = isRecord(payload) ? payload : {};
  }

  const name = body['hook_event_name'];
  const sid = body['session_id'];
  const tp = body['transcript_path'];
  // SessionStart carries `source`: 'startup' | 'resume' | 'clear' |
  // 'compact' | 'fork'. 'fork' is the one consumers must see — a node-id
  // mismatch on a fork is a new BRANCH, never a re-key.
  const src = body['source'];
  return {
    event: typeof name === 'string' && name.length > 0 ? name : null,
    sessionId: isSessionId(sid) ? sid : null,
    transcriptPath: typeof tp === 'string' && tp.length > 0 ? tp : null,
    nodeId,
    source: typeof src === 'string' && src.length > 0 ? src : null,
    raw: parsed,
  };
}

// ------------------------------------------------------------------ manager

interface DesiredFile {
  path: string;
  text: string;
  label: string;
}

interface Verdict {
  ok: boolean;
  reason?: string;
}

export class HooksManager implements DisposableLike {
  private readonly deps: HookDeps;
  private readonly home: string;

  // watcher plumbing
  private emit: ((e: HookEvent) => void) | null = null;
  private dirWatcher: fs.FSWatcher | null = null;
  private fileWatcher: fs.FSWatcher | null = null;
  private drainTimer: NodeJS.Timeout | null = null;
  private fallbackTimer: NodeJS.Timeout | null = null;
  private silenceTimer: NodeJS.Timeout | null = null;
  private offset = 0;
  private ino: number | null = null;
  private pending: Buffer = EMPTY;
  private draining = false;
  private disposed = false;
  private watchErrorLogged = false;

  // liveness signals
  private lastEvent: number | null = null;
  private active = false;
  private watchStartedAt = 0;
  private rosterActivityTicks = 0;
  private silenceReported = false;
  private readonly activityListeners = new Set<(active: boolean) => void>();

  constructor(deps: HookDeps, home?: string) {
    this.deps = deps;
    this.home = homeDir(home);
  }

  // ------------------------------------------------------------- accessors

  /** The persisted install state, defensively normalized. */
  getState(): HookInstallState {
    try {
      const stored = this.deps.getStored() as HookInstallState | undefined;
      if (stored && typeof stored === 'object') {
        return { ...stored, installed: stored.installed === true };
      }
    } catch (err) {
      logError('hooks: read stored state', err);
    }
    return { installed: false };
  }

  /** Truth on disk, not the stored flag: the documented uninstall is
   *  `rm -rf`, so the filesystem is authoritative. */
  isInstalled(): boolean {
    return this.verify().ok;
  }

  /** <home>/.claude/skills/lineage-events */
  directory(): string {
    return pluginDir(this.home);
  }

  /** <home>/.lineage/events.ndjson */
  eventsPath(): string {
    return eventsFile(this.home);
  }

  /** True only when a hook event actually arrived recently — i.e. hooks are
   *  PROVEN live. Never a precondition for anything: the roster poller is the
   *  baseline and this signal only lets callers relax polling. */
  hooksActive(): boolean {
    if (!this.emit || this.lastEvent === null) return false;
    return Date.now() - this.lastEvent <= HOOK_ACTIVITY_WINDOW_MS;
  }

  /** Epoch ms of the last parsed hook event, or null if none ever arrived. */
  lastEventAt(): number | null {
    return this.lastEvent;
  }

  onDidChangeHooksActive(
    listener: (active: boolean) => void,
  ): DisposableLike {
    this.activityListeners.add(listener);
    return {
      dispose: () => {
        this.activityListeners.delete(listener);
      },
    };
  }

  /** Optional: feed the roster tick in so "installed but never firing" can be
   *  distinguished from "nothing is running". Safe to never call. */
  noteRosterActivity(liveSessions: number): void {
    if (liveSessions > 0) this.rosterActivityTicks += 1;
  }

  // --------------------------------------------------------------- install

  /** Idempotent. Consent-gated by ONE modal: what follows it is a plain
   *  mkdir -p plus an idempotent write, and nothing else may sit between the
   *  user clicking Install and the bytes landing. Never touches
   *  ~/.claude/settings.json. */
  async install(): Promise<HookInstallState> {
    const stored = this.getState();

    const files = this.desiredFiles();
    if (files.every((f) => readTextSync(f.path) === f.text)) {
      // Fully idempotent path: nothing changes, so nothing to consent to.
      log('hooks: already installed at', this.directory());
      const state = await this.markInstalled();
      void showInfo(`Flock hooks are already installed at ${this.directory()}.`);
      return state;
    }

    const consent = await showInfo(
      'Install the Flock instant-update hooks?',
      { modal: true, detail: this.consentDetail(files) },
      'Install',
    );
    if (consent !== 'Install') {
      log('hooks: install declined');
      return stored;
    }

    // The modal above is the SINGLE confirmation. This deliberately does NOT
    // go through a WorkspaceEdit: entries carrying `needsConfirmation` raise
    // VS Code's bulk-edit "Refactor Preview" as a second, non-modal consent
    // step, and a user who closes that tab instead of applying it would get a
    // silent no-op after having already clicked Install. Same direct atomic
    // write selfHeal() uses.
    const drifted = files.filter((f) => readTextSync(f.path) !== f.text);
    try {
      for (const f of drifted) {
        writeFileAtomicSync(f.path, f.text);
        log('hooks: wrote', f.label, '→', f.path);
      }
    } catch (err) {
      logError('hooks: write plugin files', err);
      void showWarning(
        `Could not write ${this.directory()} — see the Flock output channel.`,
      );
      return stored;
    }

    const verdict = this.verify();
    if (!verdict.ok) {
      log('hooks: install did not verify —', verdict.reason ?? 'unknown');
      void showWarning(
        `Flock hooks were not installed: ${verdict.reason ?? 'unknown error'}.`,
      );
      return stored;
    }

    this.ensureEventsDir();
    const state = await this.markInstalled();
    void showInfo(
      'Flock hooks installed. Run /reload-plugins in existing Claude ' +
        'sessions (or restart them) to activate.',
    );
    log('hooks: installed at', this.directory());
    return state;
  }

  /** Safety-gated `rm -rf`: only when <pluginDir>/.claude-plugin/plugin.json
   *  parses with name === PLUGIN_NAME. The events file is kept. Idempotent. */
  async remove(): Promise<HookInstallState> {
    const dir = this.directory();
    const manifest = readTextSync(this.manifestPath());
    if (manifest === null) {
      log('hooks: nothing to remove at', dir);
      return this.markRemoved();
    }
    if (path.basename(dir) !== PLUGIN_NAME || manifestName(manifest) !== PLUGIN_NAME) {
      void showWarning(
        `Refusing to remove ${dir}: it is not the Flock hook plugin. ` +
          'Delete it by hand if you are sure.',
      );
      log('hooks: remove refused — foreign directory at', dir);
      return this.getState();
    }
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch (err) {
      logError('hooks: remove plugin directory', err);
      void showWarning(
        `Could not remove ${dir} — see the Flock output channel.`,
      );
      return this.getState();
    }
    const state = await this.markRemoved();
    void showInfo(
      'Flock hook plugin removed. Existing Claude sessions keep it until ' +
        `/reload-plugins or a restart. Recorded events remain in ${this.eventsPath()}.`,
    );
    log('hooks: removed', dir);
    return state;
  }

  /** ACTIVATE-time reconciliation; never called from deactivate().
   *  - stored says not installed → no-op.
   *  - plugin directory gone (the documented `rm -rf` uninstall) → clear the
   *    stored flag; never silently recreate what the user deleted.
   *  - a file missing, broken, or PLUGIN_VERSION bumped → rewrite ours in
   *    place (the user already consented to exactly this content) and say so.
   *  - hand-edited but still running our command → left alone. */
  async selfHeal(): Promise<HookInstallState> {
    const stored = this.getState();
    if (!stored.installed) return stored;

    const files = this.desiredFiles();
    const onDisk = files.map((f) => readTextSync(f.path));
    if (onDisk.every((t) => t === null)) {
      log('hooks: plugin directory is gone; clearing stored install state');
      return this.markRemoved();
    }

    const drifted = files.filter((f, i) => onDisk[i] !== f.text);
    if (drifted.length === 0) {
      if (
        stored.pluginVersion === PLUGIN_VERSION &&
        stored.pluginDir === this.directory()
      ) {
        return stored;
      }
      return this.markInstalled();
    }

    const anyMissing = onDisk.some((t) => t === null);
    const versionBumped = stored.pluginVersion !== PLUGIN_VERSION;
    if (!anyMissing && !versionBumped && this.verify().ok) {
      // Hand-edited but still wired to us — the user's edit wins.
      log('hooks: plugin files were edited but still run our hook; leaving them');
      return stored.pluginDir === this.directory()
        ? stored
        : this.markInstalled();
    }

    try {
      for (const f of drifted) writeFileAtomicSync(f.path, f.text);
    } catch (err) {
      logError('hooks: self-heal', err);
      return stored;
    }
    const verdict = this.verify();
    if (!verdict.ok) {
      log('hooks: self-heal did not verify —', verdict.reason ?? 'unknown');
      return stored;
    }
    log('hooks: self-healed', String(drifted.length), 'file(s)');
    const state = await this.markInstalled();
    void showInfo(
      'Flock refreshed its hook plugin files. Run /reload-plugins in ' +
        'existing Claude sessions to pick up the change.',
    );
    return state;
  }

  // --------------------------------------------------------------- watcher

  /** fs.watch on ~/.lineage + incremental reads from a byte offset. Starts at
   *  the current end of file (no history replay). Debouncing of the resulting
   *  work is the caller's job. Safe to call when hooks were never installed —
   *  events simply never arrive. */
  startWatcher(onEvent: (e: HookEvent) => void): void {
    if (this.disposed) return;
    if (this.emit) {
      this.emit = onEvent; // idempotent: keep the single watcher, swap the sink
      return;
    }
    this.emit = onEvent;

    const file = this.eventsPath();
    this.ensureEventsDir();
    try {
      const st = fs.statSync(file);
      this.ino = st.ino;
      if (st.size > MAX_EVENTS_BYTES) {
        fs.truncateSync(file, 0);
        this.offset = 0;
        log('hooks: truncated oversized events file', file);
      } else {
        this.offset = st.size;
      }
    } catch {
      this.ino = null;
      this.offset = 0;
    }
    this.pending = EMPTY;
    this.watchStartedAt = Date.now();
    this.silenceReported = false;
    this.armWatchers();
    this.fallbackTimer = unref(
      setInterval(() => this.drain(), WATCH_FALLBACK_MS),
    );
    this.silenceTimer = unref(
      setInterval(() => this.checkSilence(), SILENCE_CHECK_MS),
    );
    log('hooks: watching', file, 'from byte', String(this.offset));
  }

  /** Stop tailing without disposing — the manager stays reusable, so this is
   *  the right call when `lineage.hooks.enabled` is switched off. */
  stopWatcher(): void {
    this.emit = null;
    this.closeWatcher('all');
    if (this.drainTimer) clearTimeout(this.drainTimer);
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    if (this.silenceTimer) clearInterval(this.silenceTimer);
    this.drainTimer = null;
    this.fallbackTimer = null;
    this.silenceTimer = null;
    this.pending = EMPTY;
    this.setActive(false);
  }

  dispose(): void {
    // Deliberately removes NOTHING from disk. Cleanup in deactivate() is
    // unsupported and would silently corrupt a user's opt-in.
    this.disposed = true;
    this.stopWatcher();
    this.activityListeners.clear();
  }

  // ---------------------------------------------------------------- guts

  private desiredFiles(): DesiredFile[] {
    return [
      {
        path: this.manifestPath(),
        text: renderPluginJson(),
        label: 'plugin manifest',
      },
      {
        path: path.join(this.directory(), 'hooks', 'hooks.json'),
        text: renderHooksJson(),
        label: 'hook definitions',
      },
    ];
  }

  private manifestPath(): string {
    return path.join(this.directory(), '.claude-plugin', 'plugin.json');
  }

  private consentDetail(files: DesiredFile[]): string {
    return [
      'Flock will create a Claude Code plugin directory. No marketplace, no',
      'install step, and no shared file (including ~/.claude/settings.json) is',
      'touched:',
      '',
      ...files.map((f) => `    ${f.path}`),
      '',
      'Each hook runs exactly this, and nothing else:',
      '',
      `    ${hookCommandFor(process.platform)}`,
      '',
      `Session events are appended to ${this.eventsPath()}.`,
      '',
      'Existing Claude sessions pick the plugin up after /reload-plugins or a',
      'restart. Remove it any time with "Remove Instant-Update Hooks", or',
      `rm -rf ${this.directory()}`,
    ].join('\n');
  }

  private verify(): Verdict {
    const manifest = readTextSync(this.manifestPath());
    if (manifest === null) {
      return { ok: false, reason: 'plugin.json is missing' };
    }
    const name = manifestName(manifest);
    if (name === undefined) {
      return { ok: false, reason: 'plugin.json is not valid JSON' };
    }
    if (name !== PLUGIN_NAME) {
      return { ok: false, reason: `plugin.json names "${name}"` };
    }
    const hooksText = readTextSync(
      path.join(this.directory(), 'hooks', 'hooks.json'),
    );
    if (hooksText === null) {
      return { ok: false, reason: 'hooks.json is missing' };
    }
    let hooksJson: unknown;
    try {
      hooksJson = JSON.parse(hooksText);
    } catch {
      return { ok: false, reason: 'hooks.json is not valid JSON' };
    }
    if (!carriesOurCommand(hooksJson)) {
      return {
        ok: false,
        reason: 'hooks.json no longer runs the Flock hook command',
      };
    }
    return { ok: true };
  }

  private ensureEventsDir(): void {
    try {
      fs.mkdirSync(path.dirname(this.eventsPath()), { recursive: true });
    } catch (err) {
      logError('hooks: create events directory', err);
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
      pluginVersion: PLUGIN_VERSION,
    };
    await this.store(state);
    return state;
  }

  private async markRemoved(): Promise<HookInstallState> {
    const state: HookInstallState = { installed: false };
    await this.store(state);
    this.setActive(false);
    return state;
  }

  private async store(state: HookInstallState): Promise<void> {
    try {
      await this.deps.setStored(state);
    } catch (err) {
      logError('hooks: persist install state', err);
    }
  }

  /** Watch the directory (catches create/rotate) AND the file itself (macOS
   *  coalesces appends into a directory-level notification that carries the
   *  DIRECTORY's own name, so filtering on the filename loses events — never
   *  filter, and never rely on either watcher alone). Re-armed from drain(). */
  private armWatchers(): void {
    if (this.disposed || !this.emit) return;
    const file = this.eventsPath();
    const dir = path.dirname(file);
    if (!this.dirWatcher && fs.existsSync(dir)) {
      try {
        const watcher = fs.watch(dir, { persistent: false }, () =>
          this.scheduleDrain(),
        );
        watcher.on('error', (err) => {
          logError('hooks: events dir watcher', err);
          this.closeWatcher('dir');
        });
        this.dirWatcher = watcher;
        this.watchErrorLogged = false;
      } catch (err) {
        // Re-armed every drain, so log the cause once and stay quiet after.
        if (!this.watchErrorLogged) {
          logError('hooks: fs.watch events dir', err);
          this.watchErrorLogged = true;
        }
        this.dirWatcher = null;
      }
    }
    if (!this.fileWatcher && fs.existsSync(file)) {
      try {
        const watcher = fs.watch(file, { persistent: false }, (event) => {
          // 'rename' means the inode we hold is no longer the events file.
          if (event === 'rename') this.closeWatcher('file');
          this.scheduleDrain();
        });
        watcher.on('error', (err) => {
          logError('hooks: events file watcher', err);
          this.closeWatcher('file');
        });
        this.fileWatcher = watcher;
        this.watchErrorLogged = false;
      } catch (err) {
        if (!this.watchErrorLogged) {
          logError('hooks: fs.watch events file', err);
          this.watchErrorLogged = true;
        }
        this.fileWatcher = null;
      }
    }
  }

  private closeWatcher(which: 'dir' | 'file' | 'all'): void {
    const close = (watcher: fs.FSWatcher | null): null => {
      if (watcher) {
        try {
          watcher.close();
        } catch (err) {
          logError('hooks: close watcher', err);
        }
      }
      return null;
    };
    if (which === 'dir' || which === 'all') {
      this.dirWatcher = close(this.dirWatcher);
    }
    if (which === 'file' || which === 'all') {
      this.fileWatcher = close(this.fileWatcher);
    }
  }

  private scheduleDrain(): void {
    if (this.disposed || this.drainTimer) return;
    this.drainTimer = unref(
      setTimeout(() => {
        this.drainTimer = null;
        this.drain();
      }, DRAIN_DEBOUNCE_MS),
    );
  }

  /** Incremental tail read. Never throws; a broken read just means the poller
   *  keeps carrying the extension. */
  private drain(): void {
    const emit = this.emit;
    if (this.disposed || !emit || this.draining) return;
    this.draining = true;
    try {
      this.armWatchers(); // re-arm anything that died or was not there yet
      const file = this.eventsPath();
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        // File not created yet (or removed): rewind and wait.
        this.offset = 0;
        this.ino = null;
        this.pending = EMPTY;
        this.closeWatcher('file');
        return;
      }
      const size = st.size;
      // Rotation (rm + recreate) leaves the size larger than our offset, so a
      // size check alone cannot see it — the inode can.
      if (this.ino !== null && st.ino !== 0 && st.ino !== this.ino) {
        this.offset = 0;
        this.pending = EMPTY;
        this.closeWatcher('file');
        log('hooks: events file was replaced; reading from the start');
      }
      this.ino = st.ino;
      if (size < this.offset) {
        this.offset = 0;
        this.pending = EMPTY;
      }
      if (size === this.offset) return;
      if (size - this.offset > MAX_DRAIN_BYTES) {
        log(
          'hooks: skipping',
          String(size - this.offset),
          'bytes of event backlog',
        );
        this.offset = size;
        this.pending = EMPTY;
        return;
      }

      const length = size - this.offset;
      const buf = Buffer.allocUnsafe(length);
      let read = 0;
      const fd = fs.openSync(file, 'r');
      try {
        read = fs.readSync(fd, buf, 0, length, this.offset);
      } finally {
        fs.closeSync(fd);
      }
      if (read <= 0) return;
      this.offset += read;

      const chunk = buf.subarray(0, read);
      const data =
        this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
      const lastNewline = data.lastIndexOf(NEWLINE);
      if (lastNewline < 0) {
        // No complete line yet; keep the tail (bounded) for the next drain.
        this.pending =
          data.length > MAX_PENDING_BYTES ? EMPTY : Buffer.from(data);
        return;
      }
      const complete = data.subarray(0, lastNewline).toString('utf8');
      this.pending = Buffer.from(data.subarray(lastNewline + 1));

      for (const line of complete.split('\n')) {
        if (line.length === 0) continue;
        const event = parseEventLine(line);
        if (!event) continue;
        this.noteEvent();
        try {
          emit(event);
        } catch (err) {
          logError('hooks: event listener', err);
        }
      }

      // startWatcher() only ever checks MAX_EVENTS_BYTES once, at activation,
      // so a window left open for days would grow ~/.lineage/events.ndjson
      // without bound — every event ever appended, reclaimable only by
      // quitting and relaunching. Checking again here, right after a drain
      // that consumed every complete line, is safe exactly because nothing is
      // left unread: `this.pending` is only non-empty when the tail we just
      // read ends mid-line, and truncating THEN would throw away bytes nobody
      // has parsed yet. Cross-window safety (another window truncates the
      // same file concurrently) is already handled by the rewind at the
      // `size < this.offset` check above.
      if (this.offset > MAX_EVENTS_BYTES && this.pending.length === 0) {
        try {
          fs.truncateSync(file, 0);
          this.offset = 0;
          this.ino = fs.statSync(file).ino;
          log(
            'hooks: truncated the events file at',
            String(MAX_EVENTS_BYTES),
            'bytes',
          );
        } catch (err) {
          logError('hooks: truncate events file', err);
        }
      }
    } catch (err) {
      logError('hooks: drain events', err);
    } finally {
      this.draining = false;
    }
  }

  private noteEvent(): void {
    this.lastEvent = Date.now();
    this.setActive(true);
  }

  private setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    for (const listener of [...this.activityListeners]) {
      try {
        listener(active);
      } catch (err) {
        logError('hooks: activity listener', err);
      }
    }
  }

  /** "Installed but never firing" detection. Reported once, never fatal:
   *  disableAllHooks / allowManagedHooksOnly / --safe-mode / --bare all make
   *  this the expected steady state. */
  private checkSilence(): void {
    if (this.disposed || !this.emit) return;
    const now = Date.now();
    if (this.lastEvent !== null) {
      if (now - this.lastEvent > HOOK_ACTIVITY_WINDOW_MS) this.setActive(false);
      return;
    }
    if (this.silenceReported) return;
    if (now - this.watchStartedAt < HOOK_SILENCE_WARN_MS) return;
    if (!this.getState().installed) return;
    this.silenceReported = true;
    log(
      'hooks: no hook events after',
      String(Math.round((now - this.watchStartedAt) / 1000)),
      's — the plugin likely needs /reload-plugins (or hooks are disabled)',
    );
    if (this.rosterActivityTicks >= SILENCE_MIN_ACTIVITY_TICKS) {
      void showWarning(
        'Flock hooks are installed but no hook events have arrived. Run ' +
          '/reload-plugins in your Claude sessions (or restart them). Flock ' +
          'keeps updating by polling meanwhile.',
      );
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
    logError('hooks: homedir', err);
  }
  return process.env['HOME'] ?? '.';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The `name` field of a plugin manifest, or undefined when it does not
 *  parse. Used as the safety gate before any recursive delete. */
function manifestName(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return undefined;
    const name = parsed['name'];
    return typeof name === 'string' ? name : '';
  } catch {
    return undefined;
  }
}

/** Structural check for our fingerprint command inside a parsed hooks.json.
 *  A raw substring test would never match: JSON.stringify escapes the quotes
 *  inside HOOK_COMMAND. */
function carriesOurCommand(parsed: unknown): boolean {
  if (!isRecord(parsed)) return false;
  const hooks = parsed['hooks'];
  if (!isRecord(hooks)) return false;
  for (const matchers of Object.values(hooks)) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      if (!isRecord(matcher)) continue;
      const commands = matcher['hooks'];
      if (!Array.isArray(commands)) continue;
      for (const command of commands) {
        // Either platform's command counts: a hooks.json written on Windows
        // carries the PowerShell line, and verify() must not call that drift.
        if (
          isRecord(command) &&
          (command['command'] === HOOK_COMMAND || command['command'] === HOOK_COMMAND_WINDOWS)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function readTextSync(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** tmp file in the SAME directory, fsync, validate, rename. */
function writeFileAtomicSync(file: string, text: string): void {
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
    JSON.parse(fs.readFileSync(tmp, 'utf8'));
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

// The vscode host surface is reached through these narrow, optional shims so
// that a missing API (older host, unit-test double) degrades to "no UI"
// instead of throwing across the module boundary.

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
    logError('hooks: information message', err);
    return undefined;
  }
}

async function showWarning(message: string): Promise<string | undefined> {
  const api = windowApi();
  if (typeof api.showWarningMessage !== 'function') return undefined;
  try {
    return await api.showWarningMessage(message, {});
  } catch (err) {
    logError('hooks: warning message', err);
    return undefined;
  }
}
