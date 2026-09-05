// src/codexHooks.ts — the Codex CLI's half of instant updates.
//
// hooks.ts installs a PLUGIN DIRECTORY under ~/.claude/skills, on the argument
// that a directory of its own can be created and removed without touching a
// file anybody else keeps. Codex offers no such door: it reads lifecycle hooks
// from ONE user-level file, `$CODEX_HOME/hooks.json` (or an inline `[hooks]`
// table in config.toml, or a per-repository `.codex/hooks.json`; verified on
// codex-cli 0.153.0 and its documentation). Plugins can bundle hooks too, but
// a Codex plugin is a marketplace artefact with its own install flow, and
// writing one to deliver a two-line shell command would be the heavier
// mutation wearing the lighter name.
//
// So this module does the thing the Claude side deliberately avoids, and does
// it as narrowly as it can be done: it MERGES one entry per event into
// hooks.json and STRIPS exactly those entries out again. Every other key in the
// file — other people's hooks, matchers, unknown top-level fields — is carried
// through byte-for-byte in meaning if not in whitespace, the merge is a pure
// function over the file's text (mergeCodexHooks / stripCodexHooks, both
// tested), and the write is the same tmp-fsync-validate-rename hooks.ts uses.
// The consent modal names the file and says "merged into, not replaced".
//
// THE EVENTS. Codex's hook vocabulary is Claude's with two additions worth
// having and one worth avoiding:
//
//   SessionStart, SessionEnd, Stop, UserPromptSubmit, PreCompact
//                       the five the Claude plugin subscribes to, same names,
//                       same payload fields (`hook_event_name`, `session_id`,
//                       `transcript_path`, `cwd`, SessionStart's `source`).
//   PostCompact         Codex says when a compaction ENDS. Claude has no such
//                       event, which is why compaction.ts has to infer the
//                       end from the roster going quiet.
//   PermissionRequest   Codex asking the user for approval — the only signal
//                       there is that a Codex row is WAITING FOR YOU, because
//                       the rollout never records an approval prompt. A
//                       command hook that prints nothing and exits 0 leaves
//                       the decision to the user, exactly as it would for a
//                       Claude PermissionRequest hook.
//   PreToolUse, PostToolUse, SubagentStart/Stop, Interrupt
//                       NOT subscribed. They fire per tool call — dozens a
//                       turn — and Flock has nothing to redraw on them.
//
// THE THING THIS INSTALL CANNOT DO. Codex trusts hooks per hash: an entry it
// has not seen is listed for review and NOT RUN until the user approves it
// (`/hooks` inside a Codex session). Flock must not — and does not — write
// that approval on the user's behalf. So an install here is complete when the
// file is right, and LIVE only after the user trusts the entry once; until
// then Codex writes no events and the roster poll carries the Codex rows
// exactly as it did before. HooksManager.codexHooksActive() is the honest
// report of which state we are in, and every message below says the step out
// loud rather than letting the user wonder why nothing changed.

import * as path from 'node:path';
import * as process from 'node:process';

import { codexHooksPath, defaultCodexHome } from './codex';
import {
  CODEX_HOOK_COMMAND,
  homeDir,
  readTextSync,
  showInfo,
  showWarning,
  writeFileAtomicSync,
} from './hooks';
import { log, logError } from './log';
import type { DisposableLike, HookDeps, HookInstallState } from './types';

// --------------------------------------------------------------- constants

/** The events Flock subscribes to on the Codex side. See the header for why
 *  each is in and what is out. */
export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'Stop',
  'UserPromptSubmit',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
] as const;

/** Bumped whenever the entries this module writes change (the command, the
 *  event list). Drives self-heal exactly as hooks.PLUGIN_VERSION does. */
export const CODEX_HOOKS_VERSION = 1;

// ------------------------------------------------------------------ merge

export interface HooksEdit {
  /** The document to write. Equal in meaning to the input when `changed` is
   *  false — and then the caller must not write it, so a file whose only
   *  difference would be whitespace is left exactly as its owner keeps it. */
  text: string;
  changed: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The document, or null when the text is not a JSON object. An absent or
 *  empty file is an empty document — the ordinary state of a machine that has
 *  never configured a Codex hook. */
function parseDocument(text: string | null): Record<string, unknown> | null {
  if (text === null || text.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Does any matcher entry in this event's array already run `command`? */
function matchersCarry(matchers: readonly unknown[], command: string): boolean {
  for (const matcher of matchers) {
    if (!isRecord(matcher)) continue;
    const hooks = matcher['hooks'];
    if (!Array.isArray(hooks)) continue;
    for (const hook of hooks) {
      if (isRecord(hook) && hook['command'] === command) return true;
    }
  }
  return false;
}

/**
 * Pure. `existing` with one Flock entry per event added wherever it is
 * missing. Null when the file is not something this module may edit: text that
 * is not a JSON object, a `hooks` key that is not an object, or an event key
 * that is not an array. Refusing is the right answer to all three, because a
 * "repair" of a file we do not understand is how somebody's own hooks get
 * lost.
 *
 * Entries already present — this exact command, under any matcher — are left
 * alone, which is what makes install idempotent and self-heal cheap.
 */
export function mergeCodexHooks(
  existing: string | null,
  command: string = CODEX_HOOK_COMMAND,
  events: readonly string[] = CODEX_HOOK_EVENTS,
): HooksEdit | null {
  const doc = parseDocument(existing);
  if (doc === null) return null;
  const hooksRaw = doc['hooks'];
  if (hooksRaw !== undefined && !isRecord(hooksRaw)) return null;
  const hooks: Record<string, unknown> = hooksRaw === undefined ? {} : { ...hooksRaw };

  let changed = false;
  for (const event of events) {
    const raw = hooks[event];
    if (raw !== undefined && !Array.isArray(raw)) return null;
    const matchers: unknown[] = Array.isArray(raw) ? [...raw] : [];
    if (matchersCarry(matchers, command)) continue;
    matchers.push({ hooks: [{ type: 'command', command }] });
    hooks[event] = matchers;
    changed = true;
  }
  if (!changed) return { text: existing ?? '', changed: false };
  // Spread keeps every other top-level key in its place; `hooks` replaces
  // itself where it was, or lands last on a document that had none.
  return { text: `${JSON.stringify({ ...doc, hooks }, null, 2)}\n`, changed: true };
}

/**
 * Pure. `existing` with every hook running `command` removed. A matcher entry
 * left with no hooks is dropped; an event left with no matchers is dropped; a
 * `hooks` map left empty is kept as `{}` rather than the file being deleted,
 * because whether Flock created the file is not something this module
 * records, and an empty map is harmless where a missing file might not be.
 *
 * Null for the same non-JSON-object inputs merge refuses. A file that carries
 * none of our entries comes back unchanged.
 */
export function stripCodexHooks(
  existing: string | null,
  command: string = CODEX_HOOK_COMMAND,
): HooksEdit | null {
  const doc = parseDocument(existing);
  if (doc === null) return null;
  const hooksRaw = doc['hooks'];
  if (hooksRaw === undefined) return { text: existing ?? '', changed: false };
  if (!isRecord(hooksRaw)) return null;

  let changed = false;
  const hooks: Record<string, unknown> = {};
  for (const [event, raw] of Object.entries(hooksRaw)) {
    if (!Array.isArray(raw)) {
      hooks[event] = raw; // not ours to judge; carried through
      continue;
    }
    const kept: unknown[] = [];
    for (const matcher of raw) {
      if (!isRecord(matcher) || !Array.isArray(matcher['hooks'])) {
        kept.push(matcher);
        continue;
      }
      const remaining = matcher['hooks'].filter(
        (hook: unknown) => !(isRecord(hook) && hook['command'] === command),
      );
      if (remaining.length === matcher['hooks'].length) {
        kept.push(matcher);
        continue;
      }
      changed = true;
      if (remaining.length > 0) kept.push({ ...matcher, hooks: remaining });
    }
    if (kept.length > 0) hooks[event] = kept;
    else if (raw.length > 0) changed = true; // every matcher was ours
    else hooks[event] = raw; // was already empty; not our doing
  }
  if (!changed) return { text: existing ?? '', changed: false };
  return { text: `${JSON.stringify({ ...doc, hooks }, null, 2)}\n`, changed: true };
}

/** Which of `events` carry `command` in this document. `missing` is empty for
 *  a fully installed file; both are empty for text that is not a document at
 *  all, which callers read as "not installed" rather than as an error. */
export function codexHooksCoverage(
  text: string | null,
  command: string = CODEX_HOOK_COMMAND,
  events: readonly string[] = CODEX_HOOK_EVENTS,
): { present: string[]; missing: string[] } {
  const doc = parseDocument(text);
  const hooks = doc === null ? undefined : doc['hooks'];
  const present: string[] = [];
  const missing: string[] = [];
  for (const event of events) {
    const raw = isRecord(hooks) ? hooks[event] : undefined;
    if (Array.isArray(raw) && matchersCarry(raw, command)) present.push(event);
    else missing.push(event);
  }
  return { present, missing };
}

// ---------------------------------------------------------------- manager

export interface CodexHooksManagerOptions {
  /** Every Codex home to keep hooks in: the machine's own `~/.codex` and one
   *  per Codex account with its own `CODEX_HOME`. Read on every call rather
   *  than once, because accounts come and go. The default home is always
   *  first and always present; duplicates are collapsed. */
  homes?: () => readonly string[];
  /** `$HOME`, for the default Codex home. Tests inject a temp directory. */
  home?: string;
}

interface Verdict {
  ok: boolean;
  reason?: string;
}

/**
 * Install / remove / self-heal for the Codex hook entries, with the same
 * three-way contract HooksManager keeps and none of its watching: the events
 * land in the SAME `~/.lineage/events.ndjson`, and HooksManager's single
 * watcher reads them. This class owns files; that class owns the tail.
 */
export class CodexHooksManager implements DisposableLike {
  private readonly deps: HookDeps;
  private readonly homesFn: (() => readonly string[]) | undefined;
  private readonly home: string;

  constructor(deps: HookDeps, opts?: CodexHooksManagerOptions) {
    this.deps = deps;
    this.homesFn = opts?.homes;
    this.home = homeDir(opts?.home);
  }

  // ------------------------------------------------------------- accessors

  getState(): HookInstallState {
    try {
      const stored = this.deps.getStored() as HookInstallState | undefined;
      if (stored && typeof stored === 'object') {
        return { ...stored, installed: stored.installed === true };
      }
    } catch (err) {
      logError('codex hooks: read stored state', err);
    }
    return { installed: false };
  }

  /** Truth on disk: the default home's hooks.json carries every event. */
  isInstalled(): boolean {
    return this.verify().ok;
  }

  /** The machine's own Codex home — `~/.codex` under the configured $HOME. */
  defaultHome(): string {
    return this.home === '' ? defaultCodexHome() : path.join(this.home, '.codex');
  }

  /** Every `hooks.json` this manager writes, default home first, deduped. */
  files(): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (home: string): void => {
      const dir = typeof home === 'string' ? home.trim() : '';
      if (dir === '') return;
      const file = codexHooksPath(dir);
      const key = path.resolve(file);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(file);
    };
    push(this.defaultHome());
    try {
      for (const home of this.homesFn?.() ?? []) push(home);
    } catch (err) {
      logError('codex hooks: list homes', err);
    }
    return out;
  }

  // --------------------------------------------------------------- install

  /**
   * Idempotent. Consent-gated by ONE modal that names every file and shows
   * the exact command and the exact events, then merges. Refuses — without
   * writing anything — a file this module cannot parse as a hooks document,
   * naming it, because overwriting an unreadable hooks.json is precisely the
   * failure the merge exists to rule out.
   */
  async install(): Promise<HookInstallState> {
    const stored = this.getState();
    if (process.platform === 'win32') {
      void showWarning(
        'Flock hooks need a POSIX shell (/bin/sh) and are not supported on ' +
          'Windows. Flock keeps updating Codex rows by polling.',
      );
      log('codex hooks: install skipped (win32)');
      return stored;
    }

    const files = this.files();
    const plans = files.map((file) => ({
      file,
      edit: mergeCodexHooks(readTextSync(file)),
    }));
    const unreadable = plans.filter((p) => p.edit === null).map((p) => p.file);
    if (unreadable.length > 0) {
      void showWarning(
        `Flock cannot edit ${unreadable.join(', ')}: not a JSON object with a ` +
          '"hooks" map. Fix or move the file and try again; nothing was written.',
      );
      log('codex hooks: install refused — unreadable', unreadable.join(', '));
      return stored;
    }
    const toWrite = plans.filter((p) => p.edit !== null && p.edit.changed);
    if (toWrite.length === 0) {
      log('codex hooks: already installed in', files.join(', '));
      const state = await this.markInstalled();
      void showInfo(
        `Flock's Codex hook entries are already in ${files.join(', ')}. ` +
          'If Codex rows still update slowly, run /hooks in a Codex session ' +
          'and trust the Flock entry.',
      );
      return state;
    }

    const consent = await showInfo(
      'Add the Flock instant-update hooks to Codex?',
      { modal: true, detail: this.consentDetail(files) },
      'Add',
    );
    if (consent !== 'Add') {
      log('codex hooks: install declined');
      return stored;
    }

    try {
      for (const plan of toWrite) {
        if (plan.edit === null) continue;
        writeFileAtomicSync(plan.file, plan.edit.text);
        log('codex hooks: merged entries into', plan.file);
      }
    } catch (err) {
      logError('codex hooks: write hooks.json', err);
      void showWarning(
        'Could not write a Codex hooks.json — see the Flock output channel.',
      );
      return stored;
    }

    const verdict = this.verify();
    if (!verdict.ok) {
      log('codex hooks: install did not verify —', verdict.reason ?? 'unknown');
      void showWarning(
        `Flock's Codex hooks were not installed: ${verdict.reason ?? 'unknown error'}.`,
      );
      return stored;
    }

    const state = await this.markInstalled();
    void showInfo(
      'Flock hooks added to Codex. One step is yours: Codex runs a new hook ' +
        'only after you trust it — start a Codex session, run /hooks, and ' +
        'approve the Flock entry. Sessions already running load hooks at ' +
        'start, so restart those.',
    );
    log('codex hooks: installed in', files.join(', '));
    return state;
  }

  /** Strip our entries from every file that has them. Nothing else in any
   *  file is touched, and a file with none of our entries is not rewritten. */
  async remove(): Promise<HookInstallState> {
    const files = this.files();
    let removedFrom = 0;
    for (const file of files) {
      const text = readTextSync(file);
      if (text === null) continue;
      const edit = stripCodexHooks(text);
      if (edit === null) {
        void showWarning(
          `Flock could not read ${file} as a hooks document and left it alone.`,
        );
        log('codex hooks: remove skipped unreadable', file);
        continue;
      }
      if (!edit.changed) continue;
      try {
        writeFileAtomicSync(file, edit.text);
        removedFrom++;
        log('codex hooks: stripped entries from', file);
      } catch (err) {
        logError('codex hooks: remove entries', err);
        void showWarning(`Could not rewrite ${file} — see the Flock output channel.`);
        return this.getState();
      }
    }
    const state = await this.markRemoved();
    void showInfo(
      removedFrom === 0
        ? "Flock's Codex hook entries were not present; nothing to remove."
        : `Flock's Codex hook entries removed from ${String(removedFrom)} ` +
            `file${removedFrom === 1 ? '' : 's'}. Running Codex sessions keep ` +
            'them until restarted. Recorded events remain in ~/.lineage.',
    );
    return state;
  }

  /**
   * ACTIVATE-time reconciliation, HooksManager.selfHeal's rules translated to
   * a merged file:
   *   - stored says not installed → no-op.
   *   - NO file carries any of our entries → the user removed them by hand;
   *     clear the stored flag and never re-add what was deleted.
   *   - a file carries SOME of our entries, or the version bumped → re-merge
   *     the missing ones into the files that already have ours (the user
   *     consented to exactly this content). Files with none of ours are left
   *     alone: a new account home gets its entries from an explicit install.
   */
  async selfHeal(): Promise<HookInstallState> {
    const stored = this.getState();
    if (!stored.installed) return stored;
    if (process.platform === 'win32') return stored;

    const files = this.files();
    const texts = files.map((f) => readTextSync(f));
    const coverage = texts.map((t) => codexHooksCoverage(t));
    const carrying = files.filter((_, i) => (coverage[i]?.present.length ?? 0) > 0);
    if (carrying.length === 0) {
      log('codex hooks: no file carries our entries; clearing stored install state');
      return this.markRemoved();
    }

    const versionBumped = stored.pluginVersion !== CODEX_HOOKS_VERSION;
    const partial = files.filter(
      (_, i) =>
        (coverage[i]?.present.length ?? 0) > 0 &&
        (coverage[i]?.missing.length ?? 0) > 0,
    );
    if (partial.length === 0 && !versionBumped) {
      if (stored.pluginDir === this.defaultFile()) return stored;
      return this.markInstalled();
    }

    let healed = 0;
    for (const file of partial.length > 0 ? partial : carrying) {
      const edit = mergeCodexHooks(readTextSync(file));
      if (edit === null || !edit.changed) continue;
      try {
        writeFileAtomicSync(file, edit.text);
        healed++;
      } catch (err) {
        logError('codex hooks: self-heal', err);
        return stored;
      }
    }
    if (healed > 0) {
      log('codex hooks: self-healed', String(healed), 'file(s)');
      void showInfo(
        "Flock refreshed its Codex hook entries. Codex will ask you to trust " +
          'the changed entry once (/hooks in a Codex session).',
      );
    }
    return this.markInstalled();
  }

  dispose(): void {
    // Removes NOTHING from disk, for the reason HooksManager gives.
  }

  // ------------------------------------------------------------------ guts

  private defaultFile(): string {
    return codexHooksPath(this.defaultHome());
  }

  private consentDetail(files: string[]): string {
    return [
      'Flock will MERGE one entry per event into each of these files — every',
      'other entry in them is kept; a file that does not exist is created:',
      '',
      ...files.map((f) => `    ${f}`),
      '',
      `Events: ${CODEX_HOOK_EVENTS.join(', ')}.`,
      '',
      'Each hook runs exactly this, and nothing else:',
      '',
      `    ${CODEX_HOOK_COMMAND}`,
      '',
      'Session events are appended to ~/.lineage/events.ndjson, the same file',
      'the Claude hooks write.',
      '',
      'One step Flock cannot do for you: Codex runs a new hook only after you',
      'trust it. In your next Codex session, run /hooks and approve the Flock',
      'entry. Until then Codex writes no events and Flock keeps polling.',
      '',
      'Remove any time with "Remove Codex Hooks", which strips exactly these',
      'entries and nothing else.',
    ].join('\n');
  }

  private verify(): Verdict {
    const file = this.defaultFile();
    const text = readTextSync(file);
    if (text === null) return { ok: false, reason: `${file} is missing` };
    if (parseDocument(text) === null) {
      return { ok: false, reason: `${file} is not a JSON object` };
    }
    const { missing } = codexHooksCoverage(text);
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `${file} lacks the Flock entry for ${missing.join(', ')}`,
      };
    }
    return { ok: true };
  }

  private async markInstalled(): Promise<HookInstallState> {
    const prev = this.getState();
    const state: HookInstallState = {
      installed: true,
      pluginDir: this.defaultFile(),
      installedAt:
        prev.installed && typeof prev.installedAt === 'string'
          ? prev.installedAt
          : new Date().toISOString(),
      pluginVersion: CODEX_HOOKS_VERSION,
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
      logError('codex hooks: persist install state', err);
    }
  }
}
