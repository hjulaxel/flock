// src/limits.ts — how much of each account is left.
//
// Node-only: it imports ./types, ./log and node builtins, never vscode. This is
// the one seam that touches a credential store and the network, and it exists
// as its own file precisely so that everything downstream of it — routing.ts's
// auto-picker, the accounts view's meters — takes plain numbers and stays
// testable without either.
//
// WHAT IT READS, AND WHY IT IS A GUESS. Claude Code's own `/usage` screen is
// served by `GET https://api.anthropic.com/api/oauth/usage`, authenticated with
// the SAME OAuth access token the CLI already holds and gated behind the
// `anthropic-beta: oauth-2025-04-20` header. That endpoint is semi-documented:
// it is stable enough to build on and not stable enough to trust, so every
// field below is looked up through an alias table, every number is range-
// normalised, and a body we do not recognise is an `error: 'parse'` rather than
// a zero. A meter that reads 0% because a key was renamed would send every new
// session to an account that is actually full — the failure mode this whole
// file is arranged to avoid.
//
// WHERE THE TOKEN COMES FROM. An account is a config directory (see
// accounts.ts), and the token lives inside it:
//
//   1. `<configDir>/.credentials.json` -> `claudeAiOauth.accessToken`, with
//      `claudeAiOauth.expiresAt` honoured when present. `configDir` defaults to
//      `~/.claude`, which is what the default account inherits.
//   2. macOS only: the login keychain, read with `security find-generic-password
//      -s <service> -w`. Same JSON payload. The service name is PER CONFIG DIR:
//      the default login lives under `Claude Code-credentials`, and a custom
//      config dir under `Claude Code-credentials-<first 8 hex of
//      sha256(configDir)>` — verified empirically on 2026-08-02 against Claude
//      Code 2.1.220, where two profile dirs produced keychain items whose
//      suffixes matched their paths' sha256 prefixes exactly. This tier
//      exists because on macOS EVERY login normally goes to the keychain and
//      there is no credentials file at all; before the naming scheme was known,
//      custom dirs skipped the keychain entirely (the item was assumed shared,
//      and reading the DEFAULT account's token under another account's name is
//      the worst kind of wrong because it looks right) and every custom profile
//      on a Mac showed "not logged in" — which is exactly the confusion the
//      hashed service name resolves: the item IS per-config-dir, so the
//      fallback can never cross accounts.
//
// WHO IS SIGNED IN. Separately from the token, `<configDir>/.claude.json`
// (for the default account: `~/.claude.json`, at the home root) records the
// logged-in identity under `oauthAccount.emailAddress`. Every snapshot carries
// it as `signedInAs` when readable. An email is identity, not credential — it
// is shown in the view on purpose, so that a row whose usage cannot be read
// still says WHO it is instead of the flatly wrong "not logged in".
//
// SECRETS. The token exists in a local, in-memory value and in one
// `Authorization` header. It is never logged, never stored, never returned,
// never put in an error message or a snapshot. Neither is the response body.
// The only things this file logs are which profile id failed and how.
//
// COST. Pull-based: nothing here polls. `readUsage` refuses to hit the network
// twice for the same profile inside `MIN_FETCH_INTERVAL_MS`, dedupes concurrent
// calls onto one in-flight request (a view repaint asks for every row at once),
// and backs off exponentially after a server error. `force: true` — the manual
// refresh command — bypasses the interval and the backoff, because a person
// clicking Refresh is not a loop.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { logError } from './log';
import type {
  AccountProfile,
  DisposableLike,
  LimitsReader,
  UsageSnapshot,
  UsageWindow,
} from './types';

// ----------------------------------------------------------------- constants

/** The usage endpoint. GET, OAuth bearer, beta header. */
export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

/** The beta gate the CLI sends. Without it the endpoint 404s. */
export const OAUTH_BETA = 'oauth-2025-04-20';

/** The file inside a config directory that holds the OAuth blob. */
export const CREDENTIALS_FILE = '.credentials.json';

/** Where a profile with no configDir inherits its login from. */
export const DEFAULT_CONFIG_DIR_NAME = '.claude';

/** The macOS keychain service Claude Code stores the default login under. */
export const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** The file inside a config directory that records the signed-in identity
 *  (`oauthAccount.emailAddress`). For the DEFAULT account this file is
 *  `~/.claude.json` at the HOME ROOT — not inside `~/.claude` — which is where
 *  the CLI has always kept its main config. */
export const IDENTITY_FILE = '.claude.json';

/**
 * The keychain service a config directory's login is stored under.
 *
 * No directory — the default login — is the bare service name. A custom
 * directory appends the first 8 hex characters of the sha256 of the EXACT
 * path string the CLI was launched with: no realpath, no trailing-slash
 * folding, no case work. That exactness matters — the hash is of whatever
 * `CLAUDE_CONFIG_DIR` held, so the caller must pass the same spelling the
 * launch env used, which for Canopy profiles is `profile.configDir`
 * verbatim (the same string `envForProfile` exports).
 */
export function keychainServiceFor(configDir: string | undefined): string {
  const dir = typeof configDir === 'string' ? configDir.trim() : '';
  if (dir === '') return KEYCHAIN_SERVICE;
  const suffix = createHash('sha256').update(dir).digest('hex').slice(0, 8);
  return `${KEYCHAIN_SERVICE}-${suffix}`;
}

/** Never two network reads for the same profile inside this. Sized to the
 *  cadence a human refreshes at, not to the endpoint's rate limit: the numbers
 *  move in five-hour and seven-day units, so a minute of staleness is invisible
 *  and a request per view repaint would be rude. */
export const MIN_FETCH_INTERVAL_MS = 60_000;

/** After this, `cached()` starts marking what it returns as stale. Longer than
 *  the fetch interval on purpose — a snapshot between the two is simply the
 *  current answer, and flagging it would train the user to ignore the flag. */
export const STALE_AFTER_MS = 5 * 60_000;

/** First backoff step after a server error, doubling to BACKOFF_MAX_MS. TWICE
 *  the fetch interval, because a first step at or below it would be invisible:
 *  the interval guard already refuses everything shorter, so a 60 s "backoff"
 *  would be exactly the ordinary cadence and the endpoint would keep being
 *  asked once a minute while it is down. */
export const BACKOFF_BASE_MS = 2 * MIN_FETCH_INTERVAL_MS;
export const BACKOFF_MAX_MS = 15 * 60_000;

/** The HTTP request budget. The accounts view awaits this. */
export const FETCH_TIMEOUT_MS = 10_000;

/** The `security` budget. Longer than it needs to be for the happy path,
 *  because the FIRST read from a VS Code window puts up the system "allow
 *  access?" panel — Claude Code's ACL covers Claude Code, not us — and killing
 *  the child dismisses that panel out from under the user. Ten seconds is long
 *  enough to click Allow and short enough that an unattended window is not
 *  wedged on it. */
export const KEYCHAIN_TIMEOUT_MS = 10_000;

/** Both a credentials file and a keychain payload are a few hundred bytes. */
const MAX_BUFFER_BYTES = 1024 * 1024;

/** Bounds on the defensive walk of an unknown JSON body. A hostile or merely
 *  bizarre payload must not turn a repaint into a tree traversal. */
const SCAN_MAX_DEPTH = 5;
const SCAN_NODE_BUDGET = 256;

/** An account whose credential is one of these is an API-KEY account: it bills
 *  per token, it has no five-hour window, and the OAuth usage endpoint has
 *  nothing to say about it. Detected by NAME only — the value is never read. */
const API_KEY_ENV_NAMES: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
];

// -------------------------------------------------------- injected seams

/** The subset of a `Response` this file uses. Structural on purpose: a test
 *  fake is an object literal with a status and a `text()`, not a polyfilled
 *  Response. `ok` is optional and derived from `status` when absent. */
export interface HttpResponseLike {
  status: number;
  ok?: boolean;
  text(): Promise<string>;
}

export interface HttpRequestInit {
  method: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
}

export type FetchLike = (
  url: string,
  init: HttpRequestInit,
) => Promise<HttpResponseLike>;

/** Capture a command's stdout, or null for ANY failure. Never rejects. */
export type ExecLike = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<string | null>;

/** Read a UTF-8 file, or null when it is missing or unreadable. Never rejects
 *  — a missing credentials file is the normal state of a fresh profile, not an
 *  exception. */
export type ReadFileLike = (file: string) => Promise<string | null>;

/**
 * Everything this module would otherwise reach for directly. Mirrors the house
 * pattern (git.ts's `ProbeOptions.run`, tmux.ts's `resolveTmuxSpawn`): real
 * defaults, so production code constructs it with `new LimitsService()`, and a
 * test replaces exactly the seams it cares about.
 */
export interface LimitsDeps {
  fetch?: FetchLike;
  exec?: ExecLike;
  readFile?: ReadFileLike;
  /** `process.platform`. Gates the keychain tier. */
  platform?: string;
  now?: () => number;
  /** `os.homedir()`. Where `~/.claude` is. */
  homeDir?: string;
  minIntervalMs?: number;
  fetchTimeoutMs?: number;
  execTimeoutMs?: number;
}

export interface ReadUsageOptions {
  /** Bypass the min-interval guard AND the backoff. The manual refresh verb. */
  force?: boolean;
}

// ------------------------------------------------------------ real defaults

function realFetch(url: string, init: HttpRequestInit): Promise<HttpResponseLike> {
  if (typeof fetch !== 'function') {
    // Every host behind engines.vscode ^1.94 has global fetch; if one somehow
    // does not, this reads as an ordinary network failure rather than a crash.
    return Promise.reject(new Error('global fetch unavailable'));
  }
  return fetch(url, init);
}

function realExec(
  file: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    try {
      execFile(
        file,
        [...args],
        { timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES, windowsHide: true },
        (err, stdout) => {
          // stdout here is credential material on the happy path. It goes
          // straight to the caller and is never touched by the log.
          resolve(err ? null : String(stdout ?? ''));
        },
      );
    } catch {
      resolve(null);
    }
  });
}

async function realReadFile(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, 'utf-8');
  } catch {
    return null;
  }
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(ms);
    }
  } catch {
    // An AbortSignal we cannot build is not worth failing a request over.
  }
  return undefined;
}

// -------------------------------------------------------------- tiny helpers

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A finite number, from a number or a numeric string (some payloads quote). */
function finiteNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Alias matching is done on a squashed key so `five_hour`, `fiveHour`,
 *  `Five Hour` and `five-hour` are all one thing. */
function normKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ------------------------------------------------------------ time and text

const FALLBACK_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * The weekday a reset falls on, in the reader's own locale, falling back to the
 * same three-letter English table routing.ts uses when the runtime has no ICU.
 * LOCAL, not UTC: the person reading it is looking at their own calendar.
 *
 * Exported so a test can build its expectation from this function rather than
 * hardcoding a day that depends on the machine's timezone.
 */
export function weekdayFor(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return '';
  const when = new Date(epochMs);
  try {
    const label = when.toLocaleDateString(undefined, { weekday: 'short' });
    if (typeof label === 'string' && label.trim() !== '') return label.trim();
  } catch {
    // Small-ICU builds throw on some option combinations. Fall through.
  }
  return FALLBACK_WEEKDAYS[when.getDay()] ?? '';
}

/**
 * Epoch ms from whatever the payload spells a timestamp as: an ISO string,
 * epoch seconds, or epoch ms. The seconds/ms split is by magnitude — anything
 * below 1e12 is seconds, which stays true until the year 33658 and is wrong
 * only for timestamps before 1970, which a reset time cannot be.
 */
export function parseResetAt(v: unknown): number | undefined {
  const n = finiteNumber(v);
  if (n !== undefined) {
    if (n <= 0) return undefined;
    const ms = n < 1e12 ? n * 1000 : n;
    return Number.isFinite(ms) ? Math.round(ms) : undefined;
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const parsed = Date.parse(v.trim());
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

// --------------------------------------------------------------- body parsing

type WindowField = 'fiveHour' | 'sevenDay' | 'sevenDayOpus';

/** Squashed aliases -> field. Everything the endpoint has been observed or is
 *  plausibly going to spell these windows as. Unknown keys are ignored, which
 *  is why an added window in a future version costs nothing here. */
const WINDOW_ALIASES: ReadonlyMap<string, WindowField> = new Map([
  ['fivehour', 'fiveHour'],
  ['fivehourlimit', 'fiveHour'],
  ['fivehourwindow', 'fiveHour'],
  ['fivehourly', 'fiveHour'],
  ['5h', 'fiveHour'],
  ['5hour', 'fiveHour'],
  ['sevenday', 'sevenDay'],
  ['sevendaylimit', 'sevenDay'],
  ['sevendaywindow', 'sevenDay'],
  ['weekly', 'sevenDay'],
  ['7d', 'sevenDay'],
  ['7day', 'sevenDay'],
  ['sevendayopus', 'sevenDayOpus'],
  ['sevendayopuslimit', 'sevenDayOpus'],
  ['sevendayoauthopus', 'sevenDayOpus'],
  ['weeklyopus', 'sevenDayOpus'],
  ['opusweekly', 'sevenDayOpus'],
  ['7dopus', 'sevenDayOpus'],
  ['opus', 'sevenDayOpus'],
] as ReadonlyArray<[string, WindowField]>);

/** Squashed keys that carry the percentage. */
const UTIL_KEYS: readonly string[] = [
  'utilization',
  'utilisation',
  'utilizationpercent',
  'utilizationpct',
  'percentused',
  'usedpercent',
  'usagepercent',
  'percentage',
  'percent',
  'pct',
  'usage',
];

/** Squashed keys that carry the rollover time. */
const RESET_KEYS: readonly string[] = [
  'resetsat',
  'resetat',
  'resets',
  'reset',
  'resettime',
  'resetsatms',
  'nextreset',
  'nextresetat',
  'expiresat',
];

/** Squashed keys whose STRING value names the window: `{ name: 'five_hour' }`,
 *  the shape an array-of-limits payload would use. */
const NAME_KEYS: readonly string[] = ['name', 'type', 'window', 'key', 'limittype', 'id'];

/** A used/total pair, for a payload that reports raw counts instead of a
 *  percentage. Only honoured as a PAIR: a bare `used: 12345` is a token count,
 *  and reading it as a percentage would peg every meter at 100%. */
const USED_KEYS: readonly string[] = ['used', 'consumed', 'usedtokens'];
const TOTAL_KEYS: readonly string[] = ['limit', 'total', 'max', 'allowance', 'quota', 'cap'];

interface RawWindow {
  /** Unscaled — the 0-1 vs 0-100 decision is made once, for the whole body. */
  util: number;
  resetsAt?: number;
}

function pickNumber(obj: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const [key, value] of Object.entries(obj)) {
    if (!keys.includes(normKey(key))) continue;
    const n = finiteNumber(value);
    if (n !== undefined) return n;
  }
  return undefined;
}

/** The percentage inside one window value, or undefined. A window value that
 *  is itself a bare number is that number. */
function readUtil(value: unknown): number | undefined {
  const direct = finiteNumber(value);
  if (direct !== undefined) return direct;
  if (!isPlainObject(value)) return undefined;
  const named = pickNumber(value, UTIL_KEYS);
  if (named !== undefined) return named;
  const used = pickNumber(value, USED_KEYS);
  const total = pickNumber(value, TOTAL_KEYS);
  if (used !== undefined && total !== undefined && total > 0) return (used / total) * 100;
  return undefined;
}

function readReset(value: unknown): number | undefined {
  if (!isPlainObject(value)) return undefined;
  for (const [key, raw] of Object.entries(value)) {
    if (!RESET_KEYS.includes(normKey(key))) continue;
    const at = parseResetAt(raw);
    if (at !== undefined) return at;
  }
  return undefined;
}

/** A window we can use, or null. A window with a rollover time but no readable
 *  percentage is dropped rather than reported as 0%: every number this file
 *  hands out has to be one the endpoint actually said. */
function readWindow(value: unknown): RawWindow | null {
  const util = readUtil(value);
  if (util === undefined) return null;
  const resetsAt = readReset(value);
  return resetsAt === undefined ? { util } : { util, resetsAt };
}

function fieldForName(obj: Record<string, unknown>): WindowField | null {
  for (const [key, value] of Object.entries(obj)) {
    if (!NAME_KEYS.includes(normKey(key))) continue;
    if (typeof value !== 'string') continue;
    const field = WINDOW_ALIASES.get(normKey(value));
    if (field !== undefined) return field;
  }
  return null;
}

interface ScanResult {
  /** We recognised at least one window KEY, even if it carried no numbers. An
   *  account with no window open is a legitimate empty answer; a body with no
   *  recognisable keys at all is a parse failure. */
  sawWindowKey: boolean;
  raw: Map<WindowField, RawWindow>;
}

function scanWindows(root: unknown): ScanResult {
  const raw = new Map<WindowField, RawWindow>();
  let sawWindowKey = false;
  let budget = SCAN_NODE_BUDGET;

  const visit = (value: unknown, depth: number): void => {
    if (budget <= 0 || depth > SCAN_MAX_DEPTH) return;
    budget -= 1;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!isPlainObject(value)) return;

    // A self-describing entry — `{ name: 'seven_day', utilization: 41 }` — as
    // an array-of-limits payload would spell it.
    const named = fieldForName(value);
    if (named !== null) {
      sawWindowKey = true;
      if (!raw.has(named)) {
        const win = readWindow(value);
        if (win !== null) raw.set(named, win);
      }
    }

    for (const [key, child] of Object.entries(value)) {
      const field = WINDOW_ALIASES.get(normKey(key));
      if (field !== undefined) {
        sawWindowKey = true;
        if (!raw.has(field)) {
          const win = readWindow(child);
          if (win !== null) raw.set(field, win);
        }
      }
      // Recurse regardless: the windows are as likely to sit under `usage`,
      // `limits` or `data` as at the root, and guessing the wrapper's name is
      // exactly the guess this walk exists to avoid.
      visit(child, depth + 1);
    }
  };

  visit(root, 0);
  return { sawWindowKey, raw };
}

/**
 * 0-1 or 0-100? Decided ONCE for the whole body, from the largest value seen:
 * anything above 1 can only be a percentage, and everything at or below 1 is
 * read as a fraction.
 *
 * The interesting case is a lone `1`. As a fraction it is a FULL window; as a
 * percentage it is an almost untouched one. Read it as full: mistaking an
 * exhausted account for a fresh one routes the next session straight into a
 * rate limit, while the opposite mistake only makes the auto-picker prefer the
 * other account for a few minutes.
 */
function scaleFor(raw: ReadonlyMap<WindowField, RawWindow>): number {
  let max = 0;
  for (const win of raw.values()) if (win.util > max) max = win.util;
  return max > 1 ? 1 : 100;
}

/** Into 0-100, and rounded to two decimals. The rounding is not cosmetic: a
 *  0-1 payload scaled by 100 arrives carrying float dust (`0.62 * 100`), and a
 *  utilisation of `62.000000000000006` would leak into tooltips and, worse,
 *  into any equality the view or a test wants to write. */
function clampPercent(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 100) return 100;
  return Math.round(n * 100) / 100;
}

/**
 * The body of a 200, as a snapshot — or null, meaning "this is not a usage
 * document", which the caller turns into `error: 'parse'` while keeping the
 * last good numbers. Exported for the test lane; it takes no credentials and
 * returns no secrets.
 */
export function parseUsageBody(text: string, now: number): UsageSnapshot | null {
  if (typeof text !== 'string' || text.trim() === '') return null;
  let root: unknown;
  try {
    root = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const { sawWindowKey, raw } = scanWindows(root);
  if (!sawWindowKey) return null;

  const scale = scaleFor(raw);
  const snapshot: UsageSnapshot = { fetchedAt: Number.isFinite(now) ? now : Date.now() };
  for (const field of ['fiveHour', 'sevenDay', 'sevenDayOpus'] as const) {
    const win = raw.get(field);
    if (win === undefined) continue;
    const built: UsageWindow =
      win.resetsAt === undefined
        ? { utilization: clampPercent(win.util * scale) }
        : { utilization: clampPercent(win.util * scale), resetsAt: win.resetsAt };
    snapshot[field] = built;
  }
  return snapshot;
}

// ------------------------------------------------------------------ the row

/** Display percentage. Never rounds UP to 100: a window at 99.6% is open, and
 *  a row that says 100% next to an account the picker is still willing to use
 *  reads as a bug. */
function percentLabel(utilization: number): string {
  const pct = clampPercent(utilization);
  if (pct >= 100) return '100%';
  return `${Math.min(99, Math.round(pct))}%`;
}

function weeklyReset(snapshot: UsageSnapshot): number | undefined {
  const a = snapshot.sevenDay?.resetsAt;
  if (a !== undefined && Number.isFinite(a)) return a;
  const b = snapshot.sevenDayOpus?.resetsAt;
  return b !== undefined && Number.isFinite(b) ? b : undefined;
}

/**
 * The one line the accounts view puts under an account's name.
 *
 *   "5h 62% · wk 41% → Tue"   numbers, weekly rollover day
 *   "5h 62% · wk 41% · stale" the same, served from a cache we no longer trust
 *   "a@b.c · usage unavailable"  signed in (identity file says so) but the
 *                             credential could not be read — the state that
 *                             used to render, wrongly, as "not logged in"
 *   "not logged in"           never signed in on this account (no identity)
 *   "a@b.c · login expired" / "login expired"  the token needs renewing
 *   "usage unavailable"       the endpoint said something we could not use
 *   "usage stale"             nothing but an old failure to report
 *   "usage n/a"               answered, with nothing in it
 *   ""                        NO answer at all — Codex, an API-key account
 *
 * The empty string is the interesting one. `null` is not a failure: it is what
 * `readUsage` returns for every account this file knowingly does not serve, and
 * that is most rows on a machine with a Codex login. Those rows are not broken
 * and have nothing to report, so they say nothing — a permanent "usage n/a"
 * under half the accounts in the view is noise that trains the eye to skip the
 * line that matters. A snapshot that EXISTS and carries nothing is different:
 * something answered and we could not use it, which is worth a word.
 *
 * Pure string building, no clock beyond the timestamps in the snapshot, so the
 * test lane can pin every one of these.
 */
export function formatUsageSummary(snapshot: UsageSnapshot | null | undefined): string {
  if (snapshot === null || snapshot === undefined) return '';

  const parts: string[] = [];
  if (snapshot.fiveHour) parts.push(`5h ${percentLabel(snapshot.fiveHour.utilization)}`);
  if (snapshot.sevenDay) parts.push(`wk ${percentLabel(snapshot.sevenDay.utilization)}`);
  if (snapshot.sevenDayOpus) parts.push(`opus ${percentLabel(snapshot.sevenDayOpus.utilization)}`);

  const who =
    typeof snapshot.signedInAs === 'string' && snapshot.signedInAs.trim() !== ''
      ? snapshot.signedInAs.trim()
      : '';
  if (parts.length === 0) {
    switch (snapshot.error) {
      case 'no-credentials':
        // With an identity on record, "not logged in" would be a lie — the
        // login exists; it is the CREDENTIAL READ that came up empty.
        return who === '' ? 'not logged in' : `${who} · usage unavailable`;
      case 'expired':
        return who === '' ? 'login expired' : `${who} · login expired`;
      case 'http':
      case 'parse':
        return 'usage unavailable';
      default:
        return snapshot.stale === true ? 'usage stale' : 'usage n/a';
    }
  }

  let line = parts.join(' · ');
  const reset = weeklyReset(snapshot);
  const day = reset === undefined ? '' : weekdayFor(reset);
  if (day !== '') line += ` → ${day}`;
  if (snapshot.stale === true) line += ' · stale';
  return line;
}

// ------------------------------------------------------------- credentials

/** What a credential lookup produced. The token never leaves this module. */
type CredentialResult =
  | { kind: 'ok'; token: string }
  | { kind: 'missing' }
  | { kind: 'expired' };

/** Pull the access token out of the OAuth blob, honouring its expiry. Kept
 *  private: nothing outside this file has a reason to hold a token. */
function readCredentialBlob(text: string | null, now: number): CredentialResult {
  if (typeof text !== 'string' || text.trim() === '') return { kind: 'missing' };
  let root: unknown;
  try {
    root = JSON.parse(text) as unknown;
  } catch {
    return { kind: 'missing' };
  }
  if (!isPlainObject(root)) return { kind: 'missing' };

  const nested = root['claudeAiOauth'] ?? root['claude_ai_oauth'];
  const blob = isPlainObject(nested) ? nested : root;

  const raw = blob['accessToken'] ?? blob['access_token'];
  const token = typeof raw === 'string' ? raw.trim() : '';
  if (token === '') return { kind: 'missing' };

  // An expiry in the past means the CLI has not refreshed yet. Sending it would
  // buy a 401 and a wasted round trip; say so from here instead.
  const expiresAt = parseResetAt(blob['expiresAt'] ?? blob['expires_at']);
  if (expiresAt !== undefined && expiresAt <= now) return { kind: 'expired' };

  return { kind: 'ok', token };
}

/**
 * The credentials file for a profile, or '' when there is nowhere to look.
 * Pure and exported so the path rule can be tested without a filesystem.
 */
export function credentialsPathFor(profile: AccountProfile, homeDir: string): string {
  const configured = typeof profile.configDir === 'string' ? profile.configDir.trim() : '';
  if (configured !== '') return path.join(configured, CREDENTIALS_FILE);
  const home = typeof homeDir === 'string' ? homeDir.trim() : '';
  if (home === '') return '';
  return path.join(home, DEFAULT_CONFIG_DIR_NAME, CREDENTIALS_FILE);
}

/** Does this profile carry its own API key? Then it has no windows to report,
 *  and the OAuth endpoint would answer about a subscription it does not use. */
function hasApiKeyEnv(profile: AccountProfile): boolean {
  const env = profile.extraEnv;
  if (env === undefined || env === null) return false;
  for (const key of Object.keys(env)) {
    if (API_KEY_ENV_NAMES.includes(key.toUpperCase())) return true;
  }
  return false;
}

/**
 * Whether this file has anything to say about a profile at all.
 *
 * Today this answers for OAuth Claude accounts only. Codex's usage lives behind
 * a different (and, at the time of writing, undocumented) surface, and
 * inventing one would produce numbers rather than an absence — so Codex,
 * Gemini, generic and API-key profiles get `null`, which routing.ts already
 * treats as "unknown" and the view renders as no meter at all. This is a
 * deliberate stub: when the Codex endpoint is known, it becomes another branch
 * here and nothing downstream has to change.
 */
export function supportsUsage(profile: AccountProfile): boolean {
  if (profile.provider !== 'claude') return false;
  return !hasApiKeyEnv(profile);
}

// ---------------------------------------------------------------- the reader

interface CacheEntry {
  /** What the entry was fetched against. A profile whose configDir moved is a
   *  different login, and its cached numbers belong to the old one. */
  configDir: string;
  /** What the last call resolved to — success or a failure carrying the last
   *  good numbers. */
  snapshot: UsageSnapshot | null;
  /** The last SUCCESSFUL read, kept so a failure can degrade to it. */
  good?: UsageSnapshot;
  lastAttemptAt: number;
  /** Backoff gate; 0 when there is no backoff in force. */
  nextAttemptAt: number;
  backoffMs: number;
  inflight?: Promise<UsageSnapshot | null>;
}

function cloneWindow(win: UsageWindow | undefined): UsageWindow | undefined {
  if (win === undefined) return undefined;
  return win.resetsAt === undefined
    ? { utilization: win.utilization }
    : { utilization: win.utilization, resetsAt: win.resetsAt };
}

function cloneSnapshot(snapshot: UsageSnapshot): UsageSnapshot {
  const out: UsageSnapshot = { fetchedAt: snapshot.fetchedAt };
  const five = cloneWindow(snapshot.fiveHour);
  if (five !== undefined) out.fiveHour = five;
  const week = cloneWindow(snapshot.sevenDay);
  if (week !== undefined) out.sevenDay = week;
  const opus = cloneWindow(snapshot.sevenDayOpus);
  if (opus !== undefined) out.sevenDayOpus = opus;
  if (snapshot.stale === true) out.stale = true;
  if (snapshot.error !== undefined) out.error = snapshot.error;
  return out;
}

/** Cheap change detection for the onDidChange fan-out. Snapshots are a handful
 *  of numbers; stringifying one is cheaper than the repaint it might save. */
function signature(snapshot: UsageSnapshot | null): string {
  if (snapshot === null) return '';
  try {
    return JSON.stringify(snapshot);
  } catch {
    return String(snapshot.fetchedAt);
  }
}

/**
 * The `LimitsReader` the accounts view and the auto-picker are wired to.
 *
 * Everything it owns is a cache: there is no timer, no watcher and no
 * background work. It answers when asked, refuses to answer twice too quickly,
 * and never throws — every failure is a snapshot with `error` set, or `null`.
 */
export class LimitsService implements LimitsReader, DisposableLike {
  private readonly fetchImpl: FetchLike;
  private readonly exec: ExecLike;
  private readonly readFile: ReadFileLike;
  private readonly platform: string;
  private readonly clock: () => number;
  private readonly homeDir: string;
  private readonly minIntervalMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly execTimeoutMs: number;

  private readonly entries = new Map<string, CacheEntry>();
  private listeners: Array<() => void> = [];
  private disposed = false;

  constructor(deps: LimitsDeps = {}) {
    this.fetchImpl = deps.fetch ?? realFetch;
    this.exec = deps.exec ?? realExec;
    this.readFile = deps.readFile ?? realReadFile;
    this.platform = deps.platform ?? process.platform;
    this.clock = deps.now ?? Date.now;
    this.homeDir = deps.homeDir ?? safeHomedir();
    this.minIntervalMs =
      typeof deps.minIntervalMs === 'number' && deps.minIntervalMs >= 0
        ? deps.minIntervalMs
        : MIN_FETCH_INTERVAL_MS;
    this.fetchTimeoutMs =
      typeof deps.fetchTimeoutMs === 'number' && deps.fetchTimeoutMs > 0
        ? deps.fetchTimeoutMs
        : FETCH_TIMEOUT_MS;
    this.execTimeoutMs =
      typeof deps.execTimeoutMs === 'number' && deps.execTimeoutMs > 0
        ? deps.execTimeoutMs
        : KEYCHAIN_TIMEOUT_MS;
  }

  // ------------------------------------------------------------- LimitsReader

  /**
   * The account's windows. Serves the cache inside the min-interval, dedupes
   * concurrent callers onto one request, and honours the backoff. `null` means
   * this file has nothing to say about the profile — not that something failed.
   */
  async readUsage(
    profile: AccountProfile,
    options: ReadUsageOptions = {},
  ): Promise<UsageSnapshot | null> {
    try {
      if (this.disposed) return null;
      if (!isUsableProfile(profile) || !supportsUsage(profile)) return null;

      const configDir = this.configDirFor(profile);
      let entry = this.entries.get(profile.id);
      if (entry !== undefined && entry.configDir !== configDir) {
        this.entries.delete(profile.id);
        entry = undefined;
      }
      if (entry === undefined) {
        entry = { configDir, snapshot: null, lastAttemptAt: 0, nextAttemptAt: 0, backoffMs: 0 };
        this.entries.set(profile.id, entry);
      }

      // One request per profile, however many rows asked for it.
      if (entry.inflight !== undefined) return entry.inflight;

      const force = options.force === true;
      const now = this.clock();
      if (!force && entry.snapshot !== null) {
        if (now - entry.lastAttemptAt < this.minIntervalMs) return entry.snapshot;
        if (entry.nextAttemptAt > now) return entry.snapshot;
      }

      const run = this.refresh(profile, entry);
      entry.inflight = run;
      try {
        return await run;
      } finally {
        entry.inflight = undefined;
      }
    } catch (err) {
      // Belt and braces: a caller must never have to try/catch a meter.
      logError('limits: readUsage failed', err);
      return null;
    }
  }

  /** The last answer for this profile without going anywhere, for render paths
   *  that cannot await. Marked stale once it is older than STALE_AFTER_MS. */
  cached(profile: AccountProfile): UsageSnapshot | null {
    if (!isUsableProfile(profile)) return null;
    const entry = this.entries.get(profile.id);
    const snapshot = entry?.snapshot ?? null;
    if (snapshot === null) return null;
    if (snapshot.stale === true) return snapshot;
    if (this.clock() - snapshot.fetchedAt <= STALE_AFTER_MS) return snapshot;
    const aged = cloneSnapshot(snapshot);
    aged.stale = true;
    return aged;
  }

  onDidChange(listener: () => void): DisposableLike {
    this.listeners.push(listener);
    return {
      dispose: (): void => {
        const i = this.listeners.indexOf(listener);
        if (i >= 0) this.listeners.splice(i, 1);
      },
    };
  }

  // ------------------------------------------------------------- conveniences

  /**
   * What `resolveRouting` wants: every profile's last known snapshot, cache
   * only. Profiles this file cannot answer for map to `null`, which is exactly
   * how the picker wants to hear "unknown".
   */
  snapshotMap(profiles: readonly AccountProfile[]): Map<string, UsageSnapshot | null> {
    const out = new Map<string, UsageSnapshot | null>();
    for (const profile of profiles) {
      if (!isUsableProfile(profile)) continue;
      out.set(profile.id, this.cached(profile));
    }
    return out;
  }

  /** Drop a profile's cache — it was deleted, or its config directory moved. */
  forget(profileId: string): void {
    if (this.entries.delete(profileId)) this.emit();
  }

  dispose(): void {
    this.disposed = true;
    this.entries.clear();
    this.listeners = [];
  }

  // ------------------------------------------------------------------ private

  private configDirFor(profile: AccountProfile): string {
    const configured = typeof profile.configDir === 'string' ? profile.configDir.trim() : '';
    if (configured !== '') return configured;
    return this.homeDir === '' ? '' : path.join(this.homeDir, DEFAULT_CONFIG_DIR_NAME);
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (err) {
        logError('limits: onDidChange listener threw', err);
      }
    }
  }

  /** One full attempt: credentials, request, parse, store. Never rejects. */
  private async refresh(
    profile: AccountProfile,
    entry: CacheEntry,
  ): Promise<UsageSnapshot | null> {
    const before = signature(entry.snapshot);
    let result: UsageSnapshot;
    try {
      entry.lastAttemptAt = this.clock();
      const cred = await this.resolveCredential(profile);
      if (cred.kind !== 'ok') {
        // No network was touched, so no backoff: a user who has just logged in
        // should see it on their next look, not in fifteen minutes.
        result = this.settleFailure(entry, cred.kind === 'expired' ? 'expired' : 'no-credentials', false);
      } else {
        const res = await this.request(cred.token);
        if (res.kind !== 'ok') {
          result = this.settleFailure(entry, res.kind, res.kind === 'http');
        } else {
          const parsed = parseUsageBody(res.text, this.clock());
          if (parsed === null) {
            logError(
              'limits: unrecognised usage payload',
              new Error(`account ${profile.id}`),
            );
            result = this.settleFailure(entry, 'parse', true);
          } else {
            result = this.settleSuccess(entry, parsed);
          }
        }
      }
    } catch (err) {
      logError('limits: usage refresh failed', err);
      result = this.settleFailure(entry, 'http', true);
    }
    // Identity rides on every snapshot, success or failure — the failure is
    // where it earns its keep: "axel@… · usage unavailable" instead of telling
    // a signed-in user they are not. Attached before the change signature is
    // taken so a newly-readable identity repaints the row like any other change.
    try {
      const who = await this.readIdentity(profile);
      if (who !== undefined) result.signedInAs = who;
    } catch {
      /* expected-failure tier: the snapshot simply goes out without a name */
    }
    if (signature(result) !== before) this.emit();
    return result;
  }

  private settleSuccess(entry: CacheEntry, snapshot: UsageSnapshot): UsageSnapshot {
    entry.good = snapshot;
    entry.snapshot = snapshot;
    entry.backoffMs = 0;
    entry.nextAttemptAt = 0;
    return snapshot;
  }

  /**
   * Degrade rather than blank out: a failure keeps the last good numbers and
   * flags them stale, because "62% as of ten minutes ago" is a far better
   * answer than an empty row while the endpoint is having a bad afternoon.
   */
  private settleFailure(
    entry: CacheEntry,
    error: NonNullable<UsageSnapshot['error']>,
    backoff: boolean,
  ): UsageSnapshot {
    const good = entry.good;
    const snapshot: UsageSnapshot =
      good === undefined ? { fetchedAt: this.clock(), error } : cloneSnapshot(good);
    if (good !== undefined) {
      snapshot.stale = true;
      snapshot.error = error;
    }
    entry.snapshot = snapshot;
    if (backoff) {
      entry.backoffMs =
        entry.backoffMs <= 0 ? BACKOFF_BASE_MS : Math.min(entry.backoffMs * 2, BACKOFF_MAX_MS);
      entry.nextAttemptAt = this.clock() + entry.backoffMs;
    } else {
      entry.backoffMs = 0;
      entry.nextAttemptAt = 0;
    }
    return snapshot;
  }

  /** File first, then — macOS only — the profile's own keychain item. Safe for
   *  custom config dirs: the service name is derived from the config dir
   *  (`keychainServiceFor`), so the lookup can only ever land on THIS profile's
   *  login, never the default account's. */
  private async resolveCredential(profile: AccountProfile): Promise<CredentialResult> {
    const now = this.clock();
    const file = credentialsPathFor(profile, this.homeDir);
    if (file !== '') {
      const fromFile = readCredentialBlob(await this.readFile(file), now);
      if (fromFile.kind !== 'missing') return fromFile;
    }
    if (this.platform !== 'darwin') return { kind: 'missing' };
    const configured =
      typeof profile.configDir === 'string' ? profile.configDir.trim() : '';
    const out = await this.exec(
      'security',
      ['find-generic-password', '-s', keychainServiceFor(configured || undefined), '-w'],
      this.execTimeoutMs,
    );
    return readCredentialBlob(out, now);
  }

  /** The identity file for a profile: `<configDir>/.claude.json`, or for the
   *  default account `~/.claude.json` at the home root (NOT inside ~/.claude —
   *  that spelling does not exist). '' when there is nowhere to look. */
  private identityPathFor(profile: AccountProfile): string {
    const configured =
      typeof profile.configDir === 'string' ? profile.configDir.trim() : '';
    if (configured !== '') return path.join(configured, IDENTITY_FILE);
    return this.homeDir === '' ? '' : path.join(this.homeDir, IDENTITY_FILE);
  }

  /** Who this profile is signed in as, per its identity file. An email, or
   *  undefined when the file is missing, unreadable, or shaped otherwise —
   *  every one of which is an expected state, not an error. */
  private async readIdentity(profile: AccountProfile): Promise<string | undefined> {
    const file = this.identityPathFor(profile);
    if (file === '') return undefined;
    const text = await this.readFile(file);
    if (typeof text !== 'string' || text.trim() === '') return undefined;
    try {
      const root: unknown = JSON.parse(text);
      if (!isPlainObject(root)) return undefined;
      const account = root['oauthAccount'];
      if (!isPlainObject(account)) return undefined;
      const email = account['emailAddress'] ?? account['email_address'];
      return typeof email === 'string' && email.trim() !== '' ? email.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  /** The GET. Distinguishes only the two things the caller can act on: a dead
   *  token (401) and everything else. */
  private async request(
    token: string,
  ): Promise<{ kind: 'ok'; text: string } | { kind: 'expired' | 'http' }> {
    const signal = timeoutSignal(this.fetchTimeoutMs);
    const init: HttpRequestInit = {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA,
        Accept: 'application/json',
      },
      ...(signal === undefined ? {} : { signal }),
    };
    try {
      const res = await this.fetchImpl(USAGE_URL, init);
      const status = typeof res.status === 'number' ? res.status : 0;
      // 401 is the one status that means "the user must do something". 403 is
      // deliberately NOT folded in: it is far likelier to be the beta gate than
      // an expired token, and telling someone to log in again when their login
      // is fine is worse than saying nothing.
      if (status === 401) return { kind: 'expired' };
      const ok = res.ok ?? (status >= 200 && status < 300);
      if (!ok) return { kind: 'http' };
      const text = await res.text();
      return { kind: 'ok', text: typeof text === 'string' ? text : '' };
    } catch (err) {
      // Network errors name the host at worst; the token lives in a header and
      // never appears in one of these.
      logError('limits: usage request failed', err);
      return { kind: 'http' };
    }
  }
}

function isUsableProfile(profile: AccountProfile | null | undefined): profile is AccountProfile {
  return (
    profile !== null &&
    profile !== undefined &&
    typeof profile.id === 'string' &&
    profile.id !== ''
  );
}

function safeHomedir(): string {
  try {
    return os.homedir();
  } catch {
    return '';
  }
}

/** Factory, for callers that would rather not `new`. Same defaults. */
export function createLimitsService(deps: LimitsDeps = {}): LimitsService {
  return new LimitsService(deps);
}
