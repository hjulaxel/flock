// src/antigravityHooks.ts — the Antigravity CLI's half of instant
// updates.
//
// A PLUGIN DIRECTORY, like the Claude side and unlike the Codex and Gemini
// merges. agy (Antigravity CLI 1.3.4) discovers plugins under
// `~/.gemini/config/plugins/<name>/`, each a `plugin.json` marker and, for a
// plugin with hooks, a `hooks.json` at its root. So Flock owns one directory of
// its own, writes it whole, and removes it whole. No file anybody else keeps is
// ever edited, which is why there is no merge here.
//
// WHY A PLUGIN AND NOT THE OTHER TWO PLACES agy READS HOOKS. Both were tried on
// agy 1.3.4:
//   * `.agents/hooks.json` in a workspace loads only AFTER the user answers the
//     folder-trust prompt, and a session started before that has no hooks for
//     its first turn: SessionStart and the opening prompt's events are lost,
//     which is exactly the event the row is re-keyed on.
//   * a `"hooks"` key in `~/.gemini/antigravity-cli/settings.json`, which the
//     docs mention, did not load at all.
// A plugin hook fired for SessionStart and the first turn in a folder that had
// never been trusted.
//
// THE PLUGIN ROOT IS SHARED with the Antigravity desktop app and IDE, which
// read the same `~/.gemini/config`. An event from one of them reaches the
// events file stamped `"cli":"antigravity"` with no LINEAGE_NODE_ID, and the
// adapter ignores any event whose transcript is not under `antigravity-cli/`
// (see antigravity.ts, `isCliEvent`).
//
// THREE EVENTS, and none of them carries a prompt or a reply:
//   SessionStart   a new conversation. Its id is the one the row is re-keyed to.
//   PreInvocation  the agent started working: the row goes busy.
//   Stop           the agent stopped; `fullyIdle` says whether it is done.
// PreToolUse / PostToolUse are left out: they fire per tool call and carry the
// call's arguments (file contents, commands), and nothing Flock draws needs
// them. PostInvocation says nothing Stop does not.
//
// WINDOWS: NOT INSTALLED, AND SAID SO. The command is a `/bin/sh` line and an
// agy hook entry cannot name a shell, so a Windows agy would fail every event.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as process from 'node:process';

import {
  antigravityHookCommand,
  clearEventsFile,
  eventsFile,
  homeDir,
  readTextSync,
  showInfo,
  showWarning,
  writeFileAtomicSync,
} from './hooks';
import { log, logError } from './log';
import type { DisposableLike, HookDeps, HookInstallState } from './types';

// ------------------------------------------------------------------- paths

/** `~/.gemini` — the root agy shares with the Antigravity app and IDE. */
export function antigravityGeminiDir(home: string | undefined): string {
  return path.join(home ?? os.homedir(), '.gemini');
}

/** `~/.gemini/antigravity-cli` — the CLI's own data: `brain/`, `cache/`, its
 *  `settings.json`. The app's is `antigravity`, the IDE's `antigravity-ide`. */
export function antigravityCliDir(home: string | undefined): string {
  return path.join(antigravityGeminiDir(home), 'antigravity-cli');
}

/** The directory agy discovers plugins in. */
export function antigravityPluginsDir(home: string | undefined): string {
  return path.join(antigravityGeminiDir(home), 'config', 'plugins');
}

// --------------------------------------------------------------- constants

/** The plugin's directory name, its `name`, and the key its hooks sit under.
 *  One word for all three, so `agy plugin list` and `/hooks` both say whose
 *  it is. */
export const ANTIGRAVITY_PLUGIN_NAME = 'flock';

export const ANTIGRAVITY_HOOK_EVENTS = ['SessionStart', 'PreInvocation', 'Stop'] as const;

/** Bumped whenever the files this module writes change. Drives self-heal the
 *  way `hooks.PLUGIN_VERSION` does. */
export const ANTIGRAVITY_HOOKS_VERSION = 1;

/** Seconds agy waits for one hook. The command is one append. */
const HOOK_TIMEOUT_SECONDS = 10;

export function antigravityPluginDir(home: string | undefined): string {
  return path.join(antigravityPluginsDir(home), ANTIGRAVITY_PLUGIN_NAME);
}

// ----------------------------------------------------------------- render

/** Pure. `plugin.json`. `version` is ours, for self-heal; agy ignores it. */
export function renderAntigravityPluginJson(): string {
  return `${JSON.stringify(
    {
      name: ANTIGRAVITY_PLUGIN_NAME,
      description: 'Flock: session status for the VS Code sidebar.',
      flockVersion: ANTIGRAVITY_HOOKS_VERSION,
    },
    null,
    2,
  )}\n`;
}

/**
 * Pure. `hooks.json`: one named hook, one command per event.
 *
 * The shape is agy's: `{ "<hook name>": { "<Event>": [handler, …] } }`, where
 * SessionStart, PreInvocation, PostInvocation and Stop take handlers directly
 * and only the tool events take `{matcher, hooks}` (agy hooks docs, and
 * confirmed by `agy plugin validate`).
 */
export function renderAntigravityHooksJson(): string {
  const hook: Record<string, unknown> = {};
  for (const event of ANTIGRAVITY_HOOK_EVENTS) {
    hook[event] = [
      {
        type: 'command',
        command: antigravityHookCommand(event),
        timeout: HOOK_TIMEOUT_SECONDS,
      },
    ];
  }
  return `${JSON.stringify({ [ANTIGRAVITY_PLUGIN_NAME]: hook }, null, 2)}\n`;
}

/** What a plugin directory on disk says, against what this version writes. */
export function antigravityHooksCoverage(dir: string): {
  present: string[];
  missing: string[];
  /** The directory is ours (a `plugin.json` naming Flock) but older. */
  stale: boolean;
  /** Anything of ours is there at all. */
  ours: boolean;
} {
  const pluginText = readTextSync(path.join(dir, 'plugin.json'));
  const hooksText = readTextSync(path.join(dir, 'hooks.json'));
  // Ours only when it carries Flock's own marker: a plugin somebody else named
  // `flock` is not Flock's to rewrite or delete.
  let ours = false;
  try {
    const manifest: unknown = pluginText === null ? null : JSON.parse(pluginText);
    ours =
      typeof manifest === 'object' &&
      manifest !== null &&
      (manifest as Record<string, unknown>)['name'] === ANTIGRAVITY_PLUGIN_NAME &&
      'flockVersion' in (manifest as Record<string, unknown>);
  } catch {
    ours = false;
  }
  const present: string[] = [];
  const missing: string[] = [];
  let hooks: Record<string, unknown> = {};
  try {
    const parsed: unknown = hooksText === null ? null : JSON.parse(hooksText);
    const named =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)[ANTIGRAVITY_PLUGIN_NAME]
        : undefined;
    if (typeof named === 'object' && named !== null) hooks = named as Record<string, unknown>;
  } catch {
    hooks = {};
  }
  for (const event of ANTIGRAVITY_HOOK_EVENTS) {
    const handlers = hooks[event];
    const carries =
      Array.isArray(handlers) &&
      handlers.some(
        (h: unknown) =>
          typeof h === 'object' &&
          h !== null &&
          (h as Record<string, unknown>)['command'] === antigravityHookCommand(event),
      );
    (carries ? present : missing).push(event);
  }
  const stale =
    ours &&
    (missing.length > 0 ||
      pluginText !== renderAntigravityPluginJson() ||
      hooksText !== renderAntigravityHooksJson());
  return { present, missing, stale, ours };
}

/** Write both files. Throws on a write failure; the caller reports it. */
function writePlugin(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomicSync(path.join(dir, 'plugin.json'), renderAntigravityPluginJson());
  writeFileAtomicSync(path.join(dir, 'hooks.json'), renderAntigravityHooksJson());
}

/** Remove the directory, but only when it is ours: a `flock` plugin somebody
 *  else wrote is left where it is. True when something was removed. */
function removePlugin(dir: string): boolean {
  if (!antigravityHooksCoverage(dir).ours) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

// ---------------------------------------------------------------- manager

export interface AntigravityHooksManagerOptions {
  /** `$HOME`. Tests inject a temp directory. */
  home?: string;
  /** The platform being installed FOR, `process.platform` by default. */
  platform?: string;
}

/**
 * Install / remove / self-heal for the Flock plugin, with the contract
 * `HooksManager` and `CodexHooksManager` keep: consent before the first write,
 * a hand-removal is honoured (never re-added), a version bump rewrites what
 * the user already accepted. The events land in the shared
 * `~/.lineage/events.ndjson`, which `HooksManager` already watches.
 */
export class AntigravityHooksManager implements DisposableLike {
  private readonly deps: HookDeps;
  private readonly home: string;
  private readonly platform: string;

  constructor(deps: HookDeps, opts?: AntigravityHooksManagerOptions) {
    this.deps = deps;
    this.home = homeDir(opts?.home);
    this.platform = opts?.platform ?? process.platform;
  }

  getState(): HookInstallState {
    try {
      const stored = this.deps.getStored() as HookInstallState | undefined;
      if (stored && typeof stored === 'object') {
        return { ...stored, installed: stored.installed === true };
      }
    } catch (err) {
      logError('antigravity hooks: read stored state', err);
    }
    return { installed: false };
  }

  /** Truth on disk: the plugin is there, current, with every event. */
  isInstalled(): boolean {
    const c = antigravityHooksCoverage(this.dir());
    return c.ours && !c.stale;
  }

  dir(): string {
    return antigravityPluginDir(this.home === '' ? undefined : this.home);
  }

  async install(): Promise<HookInstallState> {
    const stored = this.getState();
    if (this.platform === 'win32') {
      void showWarning(
        'Flock does not install its Antigravity hooks on Windows yet: the hook ' +
          'needs /bin/sh. Antigravity rows still show what Flock sees from its ' +
          'own terminals.',
      );
      log('antigravity hooks: install refused on win32');
      return stored;
    }
    const dir = this.dir();
    if (this.isInstalled()) {
      const state = await this.markInstalled();
      void showInfo(`Flock's Antigravity hooks are already installed in ${dir}.`);
      return state;
    }
    const consent = await showInfo(
      'Add the Flock status hooks to Antigravity?',
      { modal: true, detail: this.consentDetail(dir) },
      'Add',
    );
    if (consent !== 'Add') {
      log('antigravity hooks: install declined');
      return stored;
    }
    try {
      writePlugin(dir);
    } catch (err) {
      logError('antigravity hooks: write plugin', err);
      void showWarning('Could not write the Antigravity plugin. See the Flock output channel.');
      return stored;
    }
    if (!this.isInstalled()) {
      void showWarning(`Flock's Antigravity hooks did not verify in ${dir}.`);
      return stored;
    }
    const state = await this.markInstalled();
    void showInfo(
      'Flock hooks added to Antigravity. Sessions already running load hooks ' +
        'when they start, so restart those.',
    );
    log('antigravity hooks: installed in', dir);
    return state;
  }

  /** Remove the plugin and clear the recorded events, as every other
   *  remove does. */
  async remove(): Promise<HookInstallState> {
    const dir = this.dir();
    let removed = false;
    try {
      removed = removePlugin(dir);
    } catch (err) {
      logError('antigravity hooks: remove plugin', err);
      void showWarning(`Could not remove ${dir}. See the Flock output channel.`);
      return this.getState();
    }
    const events = eventsFile(this.home);
    const cleared = clearEventsFile(events);
    const state = await this.markRemoved();
    const eventsNote = cleared
      ? `The recorded events in ${events} were cleared.`
      : `No recorded events were found at ${events}.`;
    void showInfo(
      removed
        ? `Flock's Antigravity hooks were removed. Running sessions keep them until restarted. ${eventsNote}`
        : `Flock's Antigravity hooks were not installed. ${eventsNote}`,
    );
    log('antigravity hooks: removed', removed ? dir : '(nothing there)');
    return state;
  }

  /**
   * ACTIVATE-time reconciliation:
   *   - stored says not installed → nothing.
   *   - the directory is gone → the user removed it; clear the flag, never
   *     re-add.
   *   - the directory is ours but older, or the version bumped → rewrite it.
   */
  async selfHeal(): Promise<HookInstallState> {
    const stored = this.getState();
    if (!stored.installed) return stored;
    if (this.platform === 'win32') return stored;
    const dir = this.dir();
    const coverage = antigravityHooksCoverage(dir);
    if (!coverage.ours) {
      log('antigravity hooks: plugin is gone; clearing stored install state');
      return this.markRemoved();
    }
    if (!coverage.stale && stored.pluginVersion === ANTIGRAVITY_HOOKS_VERSION) return stored;
    try {
      writePlugin(dir);
    } catch (err) {
      logError('antigravity hooks: self-heal', err);
      return stored;
    }
    log('antigravity hooks: self-healed', dir);
    return this.markInstalled();
  }

  dispose(): void {
    // Removes nothing from disk, for the reason HooksManager gives.
  }

  private consentDetail(dir: string): string {
    return [
      'Flock will create a plugin folder for the Antigravity CLI (agy):',
      '',
      `    ${dir}`,
      '',
      `Events: ${ANTIGRAVITY_HOOK_EVENTS.join(', ')}. Each hook runs only this:`,
      '',
      `    ${antigravityHookCommand('Stop')}`,
      '',
      `It appends one line to ${eventsFile(this.home)}: the conversation id,`,
      'its folder, its transcript path and the model name. No prompts and no',
      'replies. The file is private to your user (0600).',
      '',
      'The Antigravity desktop app reads the same plugins folder. Flock ignores',
      'its events.',
      '',
      'Remove any time with "Remove Antigravity Hooks", which deletes this folder.',
    ].join('\n');
  }

  private async markInstalled(): Promise<HookInstallState> {
    const prev = this.getState();
    const state: HookInstallState = {
      installed: true,
      pluginDir: this.dir(),
      installedAt:
        prev.installed && typeof prev.installedAt === 'string'
          ? prev.installedAt
          : new Date().toISOString(),
      pluginVersion: ANTIGRAVITY_HOOKS_VERSION,
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
      logError('antigravity hooks: persist install state', err);
    }
  }
}
