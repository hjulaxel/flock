// src/accountsView.ts — the Accounts view, under Sessions.
//
// One row per AI ACCOUNT you can launch on. The list is short by construction
// — a person has a work plan, a personal plan, maybe an API key — so the whole
// view is flat, recomputed whole on every change, and never lazy. There is no
// expansion state to keep in sync and nothing here is expensive to build; the
// only thing that costs anything is the usage numbers, and those are cached.
//
// WHY A SECOND VIEW rather than a section of the tree: the sessions tree
// answers "what is running", and this answers "on whose subscription". Those
// two lists move at completely different rates — the tree repaints on every
// roster tick, this one changes when you add an account or a five-hour window
// rolls over — and the accounts rows would either be dragged through every
// tree repaint or freeze the tree behind a network read.
//
// This file must never render, log, or otherwise emit an environment VALUE.
// `AccountProfile.extraEnv` is the API-key case and on those profiles the value
// IS the credential. The tooltip names the variables and stops there; every
// string that leaves this file is a name, a path, or a number.
//
// The usage numbers arrive through `LimitsReader` (types.ts) wired in
// extension.ts, never by importing the limits module: this view is
// vscode-facing and that module is not, and the seam is also where the network
// lives. `AccountUsageCache` below is the only thing that ever holds a
// snapshot — the view reads it synchronously while rendering (a
// TreeDataProvider cannot await a network read per row), and refreshes it on
// three occasions and no others: the view became visible, five minutes passed
// WHILE it was visible, or the user asked. An invisible view polls nothing.

import * as vscode from 'vscode';

import {
  DEFAULT_PROVIDER,
  PROVIDERS,
  PROVIDER_MEDIA_DIR,
  contextValueOf,
} from './types';
import type {
  AccountProfile,
  DisposableLike,
  LimitsReader,
  ProviderId,
  RoutingChoice,
  UsageSnapshot,
  UsageWindow,
} from './types';
import { CONFIG_DIR_ENV, canHostSession, sortProfiles } from './accounts';
import { log, logError } from './log';

// -------------------------------------------------------------- identifiers

export const ACCOUNTS_VIEW_ID = 'lineageAccounts';

// The ten account verbs live in `COMMANDS` (types.ts) with every other id, and
// the setting behind this view is `CONFIG_KEYS.accountsEnabled`. Both were once
// local stand-ins here; a private table would have been a set of ids nothing
// checks, since a test cross-checks `COMMANDS` against the manifest in both
// directions.

// -------------------------------------------------------------------- deps

/**
 * Everything the accounts surface needs from the rest of the extension.
 *
 * Shared by this view AND by the verbs in commands.ts, which is why it lives
 * here rather than in either of them: the two halves have to agree on what an
 * account write means, and one interface is how they do that. Wired in
 * extension.ts over the state store, the limits reader and the terminal
 * registry, exactly as every other dependency interface in this codebase.
 */
export interface AccountDeps {
  /** Live accounts, canonical order (accounts.sortProfiles). */
  accounts(): AccountProfile[];
  getAccount(id: string): AccountProfile | undefined;
  /** Every id the store holds, tombstones included — what a NEW id must not
   *  collide with, since pins outlive tombstones and a reused id answers old
   *  pins with a new account. Optional: a wiring without it dedupes against the
   *  live rows alone, which is what the add flow did before. */
  allAccountIds?(): readonly string[];
  upsertAccount(id: string, patch: Partial<AccountProfile>): Promise<void>;
  deleteAccount(id: string): Promise<void>;
  setAccountOrder(id: string, order: number): Promise<void>;
  /** Machine-wide default routing; undefined = never set = auto. */
  defaultRouting(): RoutingChoice | undefined;
  setDefaultRouting(choice: RoutingChoice | null): Promise<void>;
  /** null REMOVES a project's override (state.ts owns that spelling). */
  setProjectRouting(
    projectId: string,
    choice: RoutingChoice | null,
  ): Promise<void>;
  /** The account a conversation is pinned to, chain included. */
  sessionProfileId(sessionId: string): string | undefined;
  /** Write-once pin. A second, different pin is refused by the store. */
  pinSession(sessionId: string, profileId: string): Promise<void>;
  /** The cached snapshot for one account, without going anywhere. */
  usage(profile: AccountProfile): UsageSnapshot | null;
  /** All cached snapshots, keyed by account id — what routing.resolveRouting
   *  scores over. Never a network read: a launch must not wait on one. */
  usageMap(): ReadonlyMap<string, UsageSnapshot | null>;
  /** Fetch, honouring the cache unless `force`. Never throws, never rejects. */
  refreshUsage(profiles: readonly AccountProfile[], force: boolean): Promise<void>;
  onUsageChanged(listener: () => void): DisposableLike;
  /** Create `~/.lineage/profiles/<id>` and return it, or undefined when it
   *  could not be created — the caller must then NOT create the account, since
   *  a profile with no config dir silently shares the machine's login. */
  createProfileDir(id: string): Promise<string | undefined>;
  /** The claude CLI the extension located, for the sign-in terminal. */
  claudeBinary(): string | null;
  /** Absolute path of a file inside the install (provider logos). */
  mediaPath(relative: string): string | undefined;
  /** Repaint the accounts view. */
  refreshAccounts(): void;
  /** Optional: the limits module's own summary wording, so the meter reads the
   *  same here as it does anywhere else that module renders. Falls back to
   *  `formatUsageSummary` below, which is the wording this view shipped with. */
  formatUsage?(snapshot: UsageSnapshot | null): string;
}

// -------------------------------------------------------------------- rows

/** The view is flat: one row per account and nothing else. A discriminated
 *  object rather than a bare profile so the context-menu argument that arrives
 *  back in commands.ts is recognisable — see `accountIdOf`. */
export interface AccountRow {
  kind: 'account';
  profile: AccountProfile;
}

/**
 * The account id behind a command argument, or undefined.
 *
 * A row verb is reached three ways — the row's context menu (which hands back
 * the element object above), the command palette with nothing, and another
 * extension with whatever it likes — so this accepts the row, a bare id
 * string, and the profile itself, and refuses everything else. Validation of
 * the id shape is the store's job (`isAccountId`); this only has to find it.
 */
export function accountIdOf(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg === '' ? undefined : arg;
  if (!arg || typeof arg !== 'object') return undefined;
  const row = arg as { profile?: { id?: unknown }; id?: unknown };
  const nested = row.profile?.id;
  if (typeof nested === 'string' && nested !== '') return nested;
  const own = row.id;
  return typeof own === 'string' && own !== '' ? own : undefined;
}

/** `;account;` (+ `;default;`), through the repo's own token builder — the
 *  wrapping semicolons are what stop `viewItem =~ /;account;/` half-matching a
 *  longer token. */
export function accountContextValue(isDefault: boolean): string {
  return contextValueOf(isDefault ? ['account', 'default'] : ['account']);
}

// ------------------------------------------------------------------ usage

/** Below this age a cached snapshot is served rather than re-read. The five
 *  hour window moves in percent-of-an-hour steps; a minute of staleness is
 *  invisible and a burst of view repaints must not become a burst of network
 *  reads. */
const USAGE_MIN_AGE_MS = 60_000;
/** How often a VISIBLE accounts view re-reads. Off entirely while hidden. */
export const USAGE_POLL_MS = 5 * 60_000;

/**
 * The one place a usage snapshot is held.
 *
 * The reader is a `LimitsReader` (types.ts) — the seam that keeps this
 * vscode-facing file from importing the module that owns the network and the
 * credential store. It may implement `cached` (then this is a thin
 * pass-through with a repaint signal) or only `readUsage` (then this IS the
 * cache). Both are supported because a render path that cannot await must have
 * an answer either way.
 *
 * FORCE is passed straight through: the reader keeps its own minimum interval
 * — it must, or a repaint storm would become a request storm — and the whole
 * point of the refresh verb is to step over it. A reader with no such notion
 * ignores the flag, and this cache's own age guard (below) still applies.
 *
 * Every failure resolves to `null` — "no answer for this account" — which the
 * auto-picker reads as unknown rather than as broken, and which the row
 * renders as no meter rather than as an error. An account with no limits data
 * is the ordinary state of an account you have not used today.
 */
export class AccountUsageCache implements DisposableLike {
  private readonly reader: LimitsReader | undefined;
  private readonly snapshots = new Map<string, UsageSnapshot | null>();
  private readonly readAt = new Map<string, number>();
  private readonly inflight = new Set<string>();
  private readonly emitter = new vscode.EventEmitter<void>();
  private readerSub: DisposableLike | undefined;

  readonly onDidChange = this.emitter.event;

  constructor(reader?: LimitsReader) {
    this.reader = reader;
    try {
      this.readerSub = reader?.onDidChange?.(() => this.emit());
    } catch (err) {
      logError('accountsView.usage.onDidChange', err);
    }
  }

  /** Synchronous, for render paths. The reader's own cache wins when it has
   *  one: it may know something this process never fetched. */
  get(profile: AccountProfile): UsageSnapshot | null {
    if (!profile || typeof profile.id !== 'string') return null;
    try {
      const own = this.reader?.cached?.(profile);
      if (own) return own;
    } catch (err) {
      logError('accountsView.usage.cached', err);
    }
    return this.snapshots.get(profile.id) ?? null;
  }

  /** What we know about these accounts, keyed by id — the shape
   *  `routing.resolveRouting` scores over. Takes the roster rather than
   *  returning an internal map because the answer per account may come from
   *  the SOURCE's cache, which this object does not enumerate. Synchronous by
   *  contract: a launch must never wait on a network read to pick an account,
   *  and an account we know nothing about ranks as unknown, not as broken. */
  mapFor(
    profiles: readonly AccountProfile[],
  ): ReadonlyMap<string, UsageSnapshot | null> {
    const out = new Map<string, UsageSnapshot | null>();
    for (const profile of profiles ?? []) {
      if (!profile || typeof profile.id !== 'string' || profile.id === '') {
        continue;
      }
      out.set(profile.id, this.get(profile));
    }
    return out;
  }

  /**
   * Read `profiles`, skipping any read younger than USAGE_MIN_AGE_MS unless
   * `force`. Resolves when every read has settled; never rejects, so a caller
   * can `await` it in a command handler without a guard.
   */
  async refresh(
    profiles: readonly AccountProfile[],
    opts?: { force?: boolean },
  ): Promise<void> {
    const reader = this.reader;
    if (!reader) return;
    const force = opts?.force === true;
    const now = Date.now();
    const due = (profiles ?? []).filter((p) => {
      if (!p || typeof p.id !== 'string' || p.id === '') return false;
      if (this.inflight.has(p.id)) return false;
      if (force) return true;
      const at = this.readAt.get(p.id);
      return at === undefined || now - at >= USAGE_MIN_AGE_MS;
    });
    if (due.length === 0) return;

    let changed = false;
    await Promise.all(
      due.map(async (profile) => {
        this.inflight.add(profile.id);
        try {
          const snapshot = await reader.readUsage(profile, { force });
          this.snapshots.set(profile.id, snapshot ?? null);
          changed = true;
        } catch (err) {
          // A reader that throws is a reader bug; the account is simply
          // unknown until the next attempt.
          logError('accountsView.usage.readUsage', err);
          this.snapshots.set(profile.id, null);
          changed = true;
        } finally {
          this.readAt.set(profile.id, Date.now());
          this.inflight.delete(profile.id);
        }
      }),
    );
    if (changed) this.emit();
  }

  /** Drop an account's cached numbers — it was deleted, or its config dir
   *  changed under it and the old numbers now describe a different login. */
  forget(id: string): void {
    this.snapshots.delete(id);
    this.readAt.delete(id);
  }

  private emit(): void {
    try {
      this.emitter.fire();
    } catch (err) {
      logError('accountsView.usage.emit', err);
    }
  }

  dispose(): void {
    try {
      this.readerSub?.dispose();
    } catch (err) {
      logError('accountsView.usage.dispose.sub', err);
    }
    try {
      this.emitter.dispose();
    } catch (err) {
      logError('accountsView.usage.dispose', err);
    }
  }
}

// -------------------------------------------------------------- formatting

function pct(win: UsageWindow | undefined): number | undefined {
  const n = win?.utilization;
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  const clamped = Math.max(0, Math.min(100, n));
  // Same rule as limits.ts percentLabel, so the tooltip never disagrees with the
  // row: never round UP to 100 — a window at 99.6% is still open.
  return clamped >= 100 ? 100 : Math.min(99, Math.round(clamped));
}

/** "in 2h 10m" / "in 3d" / '' — how long until a window rolls over. Relative
 *  rather than a clock time because the question a meter answers is "can I
 *  keep working", and that is a duration. */
export function untilLabel(resetsAt: number | undefined, now: number): string {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return '';
  const ms = resetsAt - now;
  if (ms <= 0) return '';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${String(Math.max(1, minutes))}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `in ${String(hours)}h` : `in ${String(hours)}h ${String(rest)}m`;
  }
  const days = Math.round(hours / 24);
  return `in ${String(days)}d`;
}

/**
 * The row's one-line meter: `5h 42% · week 18%`, or a reason there is none.
 *
 * Deliberately terse and deliberately percent-first: the number that decides
 * whether to start another session here is the five-hour one, and it has to be
 * readable at the width a sidebar description gets before it is elided.
 *
 * The limits module may supply its own wording through
 * `AccountDeps.formatUsage` — this is the fallback, and the shape both must
 * keep.
 */
export function formatUsageSummary(
  snapshot: UsageSnapshot | null | undefined,
  now: number,
): string {
  if (!snapshot) return '';
  // With an identity on record, "not signed in" would be false — the sign-in
  // exists, the credential read failed. Same rule as limits.ts.
  const who =
    typeof snapshot.signedInAs === 'string' ? snapshot.signedInAs.trim() : '';
  if (snapshot.error === 'no-credentials') {
    return who === '' ? 'not signed in' : `${who} · usage unavailable`;
  }
  if (snapshot.error === 'expired') {
    return who === '' ? 'sign-in expired' : `${who} · sign-in expired`;
  }
  // An access token that aged out between CLI runs is NOT an expired sign-in —
  // the CLI renews it from the refresh token beside it, unprompted. Saying
  // otherwise is what sent people to `/login` to repair a working account. Same
  // rule and same wording as limits.ts.
  if (snapshot.error === 'token-stale') {
    return who === '' ? 'usage n/a' : `${who} · usage n/a`;
  }
  if (snapshot.error !== undefined) return 'usage unavailable';

  const parts: string[] = [];
  const five = pct(snapshot.fiveHour);
  if (five !== undefined) {
    // The reset earns its place on the row: 90% with ten minutes to go and 90%
    // with four hours to go are opposite answers to "start another session
    // here?", and the percentage alone cannot tell them apart.
    const until = untilLabel(snapshot.fiveHour?.resetsAt, now);
    parts.push(`5h ${String(five)}%${until === '' ? '' : ` · resets ${until}`}`);
  }
  const week = pct(snapshot.sevenDay);
  if (week !== undefined) parts.push(`week ${String(week)}%`);
  const opus = pct(snapshot.sevenDayOpus);
  if (opus !== undefined) parts.push(`opus ${String(opus)}%`);
  if (parts.length === 0) return snapshot.stale === true ? 'stale' : '';
  return parts.join(' · ') + (snapshot.stale === true ? ' (stale)' : '');
}

/**
 * The meter line for one account, through the wiring's formatter when there is
 * one. ONE function for every surface — the row, the account picker, the
 * project's routing dialog — because a number that changes spelling depending
 * on which menu you found it in reads as two different numbers.
 */
export function usageSummaryOf(
  deps: AccountDeps,
  snapshot: UsageSnapshot | null,
): string {
  const custom = deps.formatUsage;
  if (custom) {
    try {
      const text = custom.call(deps, snapshot);
      if (typeof text === 'string') return text;
    } catch (err) {
      logError('accountsView.formatUsage', err);
    }
  }
  return formatUsageSummary(snapshot, Date.now());
}

/** Markdown-escape, same rule and same reason as tree.ts: a label is a user
 *  string and a config dir is a path, and neither is trusted markup. */
function mdEscape(s: string): string {
  return s.replace(/[\\`*_[\]<>#|]/g, (m) => `\\${m}`);
}

// ---------------------------------------------------------------- provider

export class AccountsViewProvider implements vscode.TreeDataProvider<AccountRow> {
  private readonly deps: AccountDeps;
  private readonly emitter = new vscode.EventEmitter<AccountRow | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(deps: AccountDeps) {
    this.deps = deps;
  }

  refresh(): void {
    try {
      this.emitter.fire(undefined);
    } catch (err) {
      logError('accountsView.refresh', err);
    }
  }

  getChildren(element?: AccountRow): AccountRow[] {
    if (element) return []; // flat by construction
    try {
      return sortProfiles(this.deps.accounts()).map((profile) => ({
        kind: 'account' as const,
        profile,
      }));
    } catch (err) {
      logError('accountsView.getChildren', err);
      return [];
    }
  }

  getTreeItem(row: AccountRow): vscode.TreeItem {
    const profile = row.profile;
    const item = new vscode.TreeItem(
      profile.label,
      vscode.TreeItemCollapsibleState.None,
    );
    const isDefault = this.isDefault(profile.id);
    item.id = `account:${profile.id}`;
    item.iconPath = this.providerIcon(profile.provider);
    item.contextValue = accountContextValue(isDefault);
    item.description = this.describe(profile, isDefault);
    item.tooltip = this.tooltip(profile, isDefault);
    return item;
  }

  /** Whether the machine-wide default routing names this account. */
  private isDefault(id: string): boolean {
    try {
      const choice = this.deps.defaultRouting();
      return choice?.kind === 'account' && choice.id === id;
    } catch (err) {
      logError('accountsView.isDefault', err);
      return false;
    }
  }

  private usageOf(profile: AccountProfile): UsageSnapshot | null {
    try {
      return this.deps.usage(profile);
    } catch (err) {
      logError('accountsView.usage', err);
      return null;
    }
  }

  private summary(snapshot: UsageSnapshot | null): string {
    return usageSummaryOf(this.deps, snapshot);
  }

  /** `★ default · 5h 42% · week 18%`. The star is a literal glyph rather than
   *  a `$(codicon)`: a TreeItem description is plain text and would print the
   *  codicon source verbatim. Quick picks, which DO parse them, use
   *  `$(star-full)`. */
  private describe(profile: AccountProfile, isDefault: boolean): string {
    const parts = [
      isDefault ? '★ default' : '',
      this.summary(this.usageOf(profile)),
    ].filter((s) => s !== '');
    return parts.join(' · ');
  }

  /**
   * The hover: provider, where this account's credentials live, and every
   * window with a number.
   *
   * `extraEnv` appears as NAMES ONLY. On an API-key profile the value is the
   * credential, and a tooltip is one screenshot away from being public.
   */
  private tooltip(
    profile: AccountProfile,
    isDefault: boolean,
  ): vscode.MarkdownString | string {
    const info = PROVIDERS[profile.provider] ?? PROVIDERS[DEFAULT_PROVIDER];
    const now = Date.now();
    const snapshot = this.usageOf(profile);
    try {
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**${mdEscape(profile.label)}**\n\n`);
      md.appendMarkdown(`${mdEscape(info.label)}`);
      if (isDefault) md.appendMarkdown(' · default for new sessions');
      md.appendMarkdown('\n\n');

      // Said on the row rather than discovered at launch time: this extension
      // starts Claude Code sessions, so an account for another CLI is a place
      // to sign in and read meters, not a place a session can begin.
      if (!canHostSession(profile)) {
        md.appendMarkdown(
          'New sessions cannot start on this account — Flock launches ' +
            'Claude Code.\n\n',
        );
      }

      // Identity outranks inference: when the profile's own config dir NAMES
      // its login, say that — it is the one line that settles "did my sign-in
      // take?" without a terminal.
      const who =
        typeof snapshot?.signedInAs === 'string' ? snapshot.signedInAs.trim() : '';
      if (who !== '') md.appendMarkdown(`Signed in as **${mdEscape(who)}**\n\n`);

      const dir =
        typeof profile.configDir === 'string' ? profile.configDir.trim() : '';
      // A directory is only shown when it is actually USED. CONFIG_DIR_ENV is
      // partial by design (claude and codex only), and printing a path that
      // `envForProfile` ignores would describe an isolation this account does
      // not have — the exact "looks isolated, shares credentials" reading the
      // whole feature is built to avoid.
      const dirVar = CONFIG_DIR_ENV[profile.provider];
      if (dir === '') {
        if (who === '') {
          md.appendMarkdown(
            'Signed in as whatever this machine is already logged in as.\n\n',
          );
        }
      } else if (dirVar !== undefined) {
        md.appendMarkdown(`Config directory: \`${mdEscape(dir)}\`\n\n`);
      } else {
        md.appendMarkdown(
          `Config directory: \`${mdEscape(dir)}\` — not used. Flock has no ` +
            `config-directory variable for ${mdEscape(info.label)} accounts, ` +
            'so this one signs in as whatever this machine is already logged ' +
            'in as.\n\n',
        );
      }

      const names = Object.keys(profile.extraEnv ?? {});
      if (names.length > 0) {
        // Names, never values — see the file header.
        md.appendMarkdown(`Environment: ${names.map(mdEscape).join(', ')}\n\n`);
      }

      const rows: string[] = [];
      const line = (name: string, win: UsageWindow | undefined): void => {
        const p = pct(win);
        if (p === undefined) return;
        const until = untilLabel(win?.resetsAt, now);
        rows.push(`${name}: ${String(p)}%${until === '' ? '' : ` (resets ${until})`}`);
      };
      line('Five-hour window', snapshot?.fiveHour);
      line('Weekly', snapshot?.sevenDay);
      line('Weekly (Opus)', snapshot?.sevenDayOpus);
      if (rows.length > 0) md.appendMarkdown(rows.join('\n\n') + '\n\n');
      else md.appendMarkdown(`${this.summary(snapshot) || 'No usage data.'}\n\n`);
      return md;
    } catch (err) {
      logError('accountsView.tooltip', err);
      return profile.label;
    }
  }

  /** The provider's brand mark, light/dark paired only when BOTH files
   *  resolved — half a pair renders nothing on the missing side. Mirrors
   *  tree.ts's providerIcon, including the codicon fallback for a host (or a
   *  test double) with no media path. */
  private providerIcon(
    provider: ProviderId,
  ): vscode.ThemeIcon | vscode.Uri | { light: vscode.Uri; dark: vscode.Uri } {
    const info = PROVIDERS[provider] ?? PROVIDERS[DEFAULT_PROVIDER];
    const lightPath = this.iconPath(info.iconFile);
    const darkPath = this.iconPath(info.iconFileDark);
    if (lightPath !== '') {
      try {
        const light = vscode.Uri.file(lightPath);
        return darkPath !== ''
          ? { light, dark: vscode.Uri.file(darkPath) }
          : light;
      } catch (err) {
        logError('accountsView.providerIcon', err);
      }
    }
    return new vscode.ThemeIcon(info.fallbackIcon);
  }

  private iconPath(file: string | undefined): string {
    if (file === undefined || file === '') return '';
    try {
      return this.deps.mediaPath(`${PROVIDER_MEDIA_DIR}/${file}`) ?? '';
    } catch (err) {
      logError('accountsView.mediaPath', err);
      return '';
    }
  }

  dispose(): void {
    try {
      this.emitter.dispose();
    } catch (err) {
      logError('accountsView.dispose', err);
    }
  }
}

// ----------------------------------------------------------- registration

export interface AccountsViewController extends DisposableLike {
  refresh(): void;
  /** Force a usage read for every account and repaint. What the view-title
   *  refresh button runs. */
  refreshUsage(force: boolean): Promise<void>;
}

/**
 * createTreeView(ACCOUNTS_VIEW_ID) + the visibility-driven refresh loop.
 *
 * The timer only exists while the view is visible, and is torn down when it is
 * not: an accounts view nobody is looking at must not hold a five-minute
 * network read open forever, and the numbers are re-read the moment it comes
 * back anyway.
 */
export function registerAccountsView(
  deps: AccountDeps,
): AccountsViewController {
  const provider = new AccountsViewProvider(deps);
  const view = vscode.window.createTreeView<AccountRow>(ACCOUNTS_VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: false,
    canSelectMany: false,
  });

  let timer: ReturnType<typeof setInterval> | undefined;

  const readUsage = (force: boolean): Promise<void> => {
    try {
      return deps
        .refreshUsage(deps.accounts(), force)
        .then(
          () => {
            provider.refresh();
          },
          (err: unknown) => {
            logError('accountsView.refreshUsage', err);
          },
        );
    } catch (err) {
      logError('accountsView.refreshUsage', err);
      return Promise.resolve();
    }
  };

  const stopTimer = (): void => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };

  const startTimer = (): void => {
    if (timer !== undefined) return;
    timer = setInterval(() => {
      void readUsage(false);
    }, USAGE_POLL_MS);
  };

  const onVisible = (visible: boolean): void => {
    if (!visible) {
      stopTimer();
      return;
    }
    startTimer();
    void readUsage(false);
  };

  let visibilitySub: DisposableLike | undefined;
  try {
    visibilitySub = view.onDidChangeVisibility((e) => onVisible(e.visible));
    // The POLL is visibility-gated; the first read is not. This view ships
    // collapsed, and `TreeView.visible` is false for a collapsed section — so
    // gating the initial read on visibility left a machine that never expanded
    // Accounts with no numbers at all, which is not merely a blank row: the
    // auto-picker scores on the same cache and would fall through to "first in
    // your list" forever. One read here, then nothing until it is looked at.
    if (view.visible) startTimer();
    void readUsage(false);
  } catch (err) {
    logError('accountsView.visibility', err);
  }

  let usageSub: DisposableLike | undefined;
  try {
    usageSub = deps.onUsageChanged(() => provider.refresh());
  } catch (err) {
    logError('accountsView.onUsageChanged', err);
  }

  log('accounts: view registered');

  return {
    refresh(): void {
      provider.refresh();
    },
    refreshUsage(force: boolean): Promise<void> {
      return readUsage(force);
    },
    dispose(): void {
      stopTimer();
      for (const sub of [visibilitySub, usageSub]) {
        try {
          sub?.dispose();
        } catch (err) {
          logError('accountsView.dispose.sub', err);
        }
      }
      try {
        view.dispose();
      } catch (err) {
        logError('accountsView.dispose.view', err);
      }
      provider.dispose();
    },
  };
}
