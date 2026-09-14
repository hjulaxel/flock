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
// On Windows and Linux there is no second tier: the CLI keeps the OAuth blob in
// `<configDir>/.credentials.json` and nowhere else (`%USERPROFILE%\.claude\`
// for the default account, via os.homedir()). That one file therefore carries
// the whole verdict a Windows row shows, which is why `readCredentialBlob`
// below refuses to read anything into it that is not there: a file it cannot
// parse is "no credentials", and only a lapsed token with NO refresh token
// anywhere in the document is an expired sign-in.
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
// and backs off after a server error. Manual refresh bypasses cache freshness,
// while the scheduler enforces spacing and rate-limit cooldowns for every caller.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  codexAuthPath,
  codexSessionsDir,
  parseCodexAuth,
  readCodexUsage,
} from './codex';
import type { CodexIdentity, CodexRateLimits, CodexUsageReading } from './codex';
import { logError } from './log';
import { createUsageRequestScheduler } from './usageSchedule';
import type { UsageRequestScheduler } from './usageSchedule';
export { REQUEST_SPACING_MS } from './usageSchedule';
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

/** The Codex equivalent: `~/.codex`, the home `CODEX_HOME` relocates. */
export const DEFAULT_CODEX_HOME_NAME = '.codex';

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
 * launch env used, which for Flock profiles is `profile.configDir`
 * verbatim (the same string `envForProfile` exports).
 */
export function keychainServiceFor(configDir: string | undefined): string {
  const dir = typeof configDir === 'string' ? configDir.trim() : '';
  if (dir === '') return KEYCHAIN_SERVICE;
  const suffix = createHash('sha256').update(dir).digest('hex').slice(0, 8);
  return `${KEYCHAIN_SERVICE}-${suffix}`;
}

/** Ordinary polling cadence, shared across windows by the request scheduler. */
export const MIN_FETCH_INTERVAL_MS = 5 * 60_000;
/** A recent reading remains useful while Flock waits to refresh it. */
export const STALE_AFTER_MS = 15 * 60_000;
export const BACKOFF_BASE_MS = 2 * MIN_FETCH_INTERVAL_MS;
export const BACKOFF_MAX_MS = 30 * 60_000;

/**
 * How old a REMEMBERED reading may be before it is discarded unread.
 *
 * Five hours, because that is the length of the short window it describes: past
 * it, `fiveHour` is not stale, it is WRONG — the window has rolled and the
 * number belongs to a period that is over. A weekly figure ages more gracefully,
 * but a snapshot is kept or dropped whole; half a remembered snapshot would be
 * a third state to reason about for no benefit.
 *
 * This TTL is about what is safe to SHOW AT ALL, and it is the only age
 * question the cache itself answers. Whether a reading that survives it is
 * flagged `stale` is decided afresh by `isStale` when it is seeded — a reading
 * another window took ninety seconds ago is the current answer, and the flag
 * would be a lie about it. (It did once mark everything it served, which is how
 * a row that had just refreshed came to carry `· stale`.)
 */
export const USAGE_CACHE_TTL_MS = 5 * 60 * 60_000;

/** The remembered-readings file, beside `state.json` under `~/.lineage/state`. */
export const USAGE_CACHE_FILE_NAME = 'usage-cache.json';

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
  // A Codex profile authenticating by key has no plan windows either.
  'OPENAI_API_KEY',
];

// -------------------------------------------------------- injected seams

/** The subset of a `Response` this file uses. Structural on purpose: a test
 *  fake is an object literal with a status and a `text()`, not a polyfilled
 *  Response. `ok` is optional and derived from `status` when absent. */
export interface HttpResponseLike {
  status: number;
  ok?: boolean;
  text(): Promise<string>;
  /** Only ever read for `Retry-After`, and only on a 429. Optional and
   *  structural like the rest of this shape: a test fake is `{ status, text }`
   *  and stays that way, and a response object without headers simply means
   *  the throttle has no stated end. */
  headers?: { get(name: string): string | null } | undefined;
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

/** The newest rate-limit reading in a Codex store (`<home>/sessions`), or
 *  null when it holds none. Never rejects. The real one is codex.readCodexUsage
 *  behind a promise; a test hands back a literal. */
export type CodexUsageLike = (sessionsDir: string) => Promise<CodexUsageReading | null>;

/**
 * A place to REMEMBER the last good reading across windows and restarts.
 *
 * THE BUG THIS EXISTS FOR. Every failure in this file already degrades to the
 * last good numbers rather than blanking the row — `settleFailure` has done
 * that from the beginning. But "the last good numbers" lived only in this
 * process's memory, so they were empty in every freshly opened window, and a
 * throttle met before the first success meant a row with nothing on it at all.
 * On a machine where the endpoint throttles routinely that is most of the time,
 * which is how an account whose numbers are perfectly readable came to show
 * nothing for an entire evening.
 *
 * Successful readings are merged across windows; scheduling lives separately.
 * Losing a reading does not remove the shared request cooldown. That is why it is its own small file rather than a
 * section of `state.json`, whose newest-wins merge discipline exists for
 * editorial facts that must survive being written by two windows at once.
 *
 * `save` is deliberately fire-and-forget: a meter must never make a repaint
 * wait on a disk write, and a cache that fails to persist is a cache that
 * misses, not an error anybody needs to hear about.
 */
export interface UsageCacheStore {
  load(): Promise<ReadonlyMap<string, CachedUsage> | null>;
  /**
   * Read the file AGAIN, ignoring whatever the first load remembered.
   *
   * `load` is memoised — it runs once per window, at startup — which is right
   * for the common path and wrong for the two cases that matter most:
   *
   *   1. ANOTHER WINDOW got a reading this one cannot. The whole value of a
   *      shared file is that a success anywhere is a success everywhere, and a
   *      cache read once at startup never learns anything its neighbours find.
   *   2. Somebody put a reading there by hand while this window was running.
   *
   * Called only when a refresh has failed AND this window has no numbers of its
   * own to fall back on — the one moment where re-reading a small file is
   * obviously worth it. Optional, so a test double need not implement it.
   */
  reload?(): Promise<ReadonlyMap<string, CachedUsage> | null>;
  save(id: string, entry: CachedUsage): void;
}

export interface CachedUsage {
  /** What the reading was taken against. A profile whose config directory moved
   *  is a different login and its remembered numbers belong to the old one —
   *  the same rule the in-memory entry applies, for the same reason. */
  configDir: string;
  snapshot: UsageSnapshot;
}

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
  codexUsage?: CodexUsageLike;
  /** Where the last good reading is remembered across windows and restarts.
   *  Absent means "do not remember", which is how this file behaved before. */
  cache?: UsageCacheStore;
  /** Shared admission and cooldown state; production supplies a file-backed scheduler. */
  scheduler?: UsageRequestScheduler;
  /** Test seam for request spacing. */
  sleep?: (ms: number) => Promise<void>;
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
  /** Request fresh numbers, while still respecting request spacing and cooldowns. */
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

/** Synchronous underneath (codex.ts is a node-only module of bounded reads);
 *  wrapped so the seam has one shape whichever side of it a caller is on. */
async function realCodexUsage(sessionsDir: string): Promise<CodexUsageReading | null> {
  try {
    return readCodexUsage({ sessionsDirs: [sessionsDir] });
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

/** Retry-After is a minimum wait. Valid seconds and HTTP dates are never
 * shortened to a local ceiling; cooldowns are timestamps, not long timers. */
export function retryAfterMs(
  headers: { get(name: string): string | null } | undefined,
  now: number,
): number | undefined {
  if (headers === undefined || typeof headers.get !== 'function') return undefined;
  let raw: string | null = null;
  try {
    raw = headers.get('retry-after');
  } catch {
    return undefined;
  }
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const text = raw.trim();

  // Seconds first: the spelling this endpoint actually uses, and the only one
  // that cannot be confused with anything else.
  if (/^\d+$/.test(text)) {
    const ms = Number(text) * 1000;
    if (!Number.isFinite(ms) || ms <= 0) return undefined;
    return ms;
  }

  // Do not let Date.parse reinterpret a malformed numeric delay as a date.
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), /i.test(text)) return undefined;
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return undefined;
  const ms = at - (Number.isFinite(now) ? now : Date.now());
  if (ms <= 0) return undefined;
  return ms;
}

// ------------------------------------------------------- remembered readings

/** The on-disk shape. Versioned so a future change can be ignored rather than
 *  guessed at — an unknown version reads as an empty cache, which costs one
 *  network read and nothing else. */
const USAGE_CACHE_VERSION = 1;

/** Bounds on what is read back. A cache file is ours, but it is a file on a
 *  disk and a corrupt one must not be able to turn a repaint into anything
 *  expensive — or, worse, put numbers on a row that nobody measured. */
const USAGE_CACHE_MAX_ACCOUNTS = 64;

/** One window, validated. Anything unrecognisable is dropped rather than
 *  coerced: a meter is only allowed to show numbers a provider actually said,
 *  and that rule does not relax because the number came from our own file. */
function readCachedWindow(v: unknown): UsageWindow | undefined {
  if (!isPlainObject(v)) return undefined;
  const util = finiteNumber(v['utilization']);
  if (util === undefined || util < 0 || util > 100) return undefined;
  const out: UsageWindow = { utilization: util };
  const resets = finiteNumber(v['resetsAt']);
  if (resets !== undefined && resets > 0) out.resetsAt = resets;
  const minutes = finiteNumber(v['minutes']);
  if (minutes !== undefined && minutes > 0) out.minutes = minutes;
  return out;
}

/**
 * Pure. The cache file's text as entries, or null when there is nothing usable
 * in it. Exported for the test lane — it takes no credentials and touches no
 * disk.
 *
 * Only SUCCESSFUL readings are ever written, so anything here carrying an
 * `error` is a file somebody edited; it is dropped. What survives is marked
 * stale here as the CONSERVATIVE default — it was measured in another process
 * at another time. `seed` then re-decides it against `isStale` before any row
 * sees it, which is where that judgement belongs: one rule, applied once, at
 * the seam where a snapshot becomes something a person reads.
 */
export function parseUsageCache(
  text: string | null,
  now: number,
): Map<string, CachedUsage> | null {
  const root = parseJsonObject(text);
  if (root === undefined) return null;
  if (finiteNumber(root['version']) !== USAGE_CACHE_VERSION) return null;
  const accounts = root['accounts'];
  if (!isPlainObject(accounts)) return null;

  const out = new Map<string, CachedUsage>();
  for (const [id, raw] of Object.entries(accounts)) {
    if (out.size >= USAGE_CACHE_MAX_ACCOUNTS) break;
    if (!isAccountIdish(id) || !isPlainObject(raw)) continue;
    const configDir = typeof raw['configDir'] === 'string' ? raw['configDir'] : '';
    const snap = raw['snapshot'];
    if (!isPlainObject(snap)) continue;
    if (snap['error'] !== undefined) continue; // only successes are written
    const fetchedAt = finiteNumber(snap['fetchedAt']);
    if (fetchedAt === undefined || fetchedAt <= 0) continue;
    // Older than the window it describes: not stale, wrong.
    if (Number.isFinite(now) && now - fetchedAt > USAGE_CACHE_TTL_MS) continue;

    const snapshot: UsageSnapshot = { fetchedAt, stale: true };
    const five = readCachedWindow(snap['fiveHour']);
    if (five !== undefined) snapshot.fiveHour = five;
    const week = readCachedWindow(snap['sevenDay']);
    if (week !== undefined) snapshot.sevenDay = week;
    const opus = readCachedWindow(snap['sevenDayOpus']);
    if (opus !== undefined) snapshot.sevenDayOpus = opus;
    // A remembered snapshot with no windows in it is not worth remembering: it
    // would seed the row with the same nothing it already shows.
    if (
      snapshot.fiveHour === undefined &&
      snapshot.sevenDay === undefined &&
      snapshot.sevenDayOpus === undefined
    ) {
      continue;
    }
    if (typeof snap['signedInAs'] === 'string') snapshot.signedInAs = snap['signedInAs'];
    if (typeof snap['plan'] === 'string') snapshot.plan = snap['plan'];
    const observed = finiteNumber(snap['observedAt']);
    if (observed !== undefined && observed > 0) snapshot.observedAt = observed;
    out.set(id, { configDir, snapshot });
  }
  return out;
}

/** The id shape, kept local so this module does not import accounts.ts — that
 *  would drag the view layer's dependencies into the one file that has to stay
 *  node-only. Deliberately loose: this is a map key, not a capability, and the
 *  only thing it must exclude is a key that could not be an account id at all. */
const ACCOUNT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function isAccountIdish(v: unknown): v is string {
  return typeof v === 'string' && ACCOUNT_ID_RE.test(v);
}

/**
 * The real store: one small JSON file, read once and written behind a debounce.
 *
 * Never throws and never rejects — every failure is a cache miss. The write is
 * temp-file-then-rename in the same directory, the same discipline state.ts
 * uses, so a window killed mid-write leaves the previous file intact rather
 * than a truncated one.
 */
export function createUsageCache(filePath: string): UsageCacheStore {
  const entries = new Map<string, CachedUsage>();
  let loaded: Promise<ReadonlyMap<string, CachedUsage> | null> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;

  /**
   * Write our entries WITHOUT destroying anybody else's.
   *
   * THE BUG THIS EXISTS FOR, and it was in the first version of this file: the
   * write rebuilt the whole document from the accounts THIS window happened to
   * know about. Every account it had not successfully read — one that has been
   * throttled all evening, say, which is precisely the account the cache is for
   * — was dropped on the next write. A hand-seeded entry survived seven minutes
   * before the next repaint erased it.
   *
   * Two windows do the same to each other, which is the more important half:
   * each loads at startup, learns different accounts, and the later writer
   * silently deletes what the earlier one knew. "A cache, not a record, so it
   * is never merged" was wrong — the file is SHARED, and shared state that is
   * rewritten wholesale is state that gets lost.
   *
   * So: re-read, merge per account (newer `fetchedAt` wins), write. The entries
   * we merged in are kept in memory too, so a window that has been running for
   * hours does not have to re-learn them on every flush.
   */
  const flush = (): void => {
    timer = undefined;
    if (!dirty) return;
    dirty = false;
    void (async (): Promise<void> => {
      const tmp = `${filePath}.${String(process.pid)}.tmp`;
      try {
        // What is there NOW, not what was there when this window started.
        let onDisk: Map<string, CachedUsage> | null = null;
        try {
          onDisk = parseUsageCache(await fsp.readFile(filePath, 'utf-8'), Date.now());
        } catch {
          onDisk = null;
        }
        if (onDisk !== null) {
          for (const [id, entry] of onDisk) {
            const ours = entries.get(id);
            // Ours only wins when it is actually newer. A window that has been
            // idle must not push its stale reading over a fresher one.
            if (ours === undefined || ours.snapshot.fetchedAt < entry.snapshot.fetchedAt) {
              entries.set(id, entry);
            }
          }
        }
        const payload: Record<string, unknown> = {};
        for (const [id, entry] of entries) {
          // `stale` is a JUDGEMENT, not a measurement, and it does not belong
          // in a file. It arrives here only on the merge path — parseUsageCache
          // marks what it reads as the conservative default, and an entry this
          // window never refreshed is written straight back out carrying it —
          // so the file ends up storing one window's opinion about age instead
          // of the reading it took. Harmless today, because `seed` re-decides
          // with isStale before a row ever sees it, and exactly the kind of
          // derived state that stops being harmless the moment something
          // believes it. What is stored is `fetchedAt`; the flag is derived
          // from it, every time, at the one seam that draws a row.
          const { stale: _dropped, ...measured } = entry.snapshot;
          payload[id] = { configDir: entry.configDir, snapshot: measured };
        }
        const text = JSON.stringify({ version: USAGE_CACHE_VERSION, accounts: payload });
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        await fsp.writeFile(tmp, text, { encoding: 'utf-8', mode: 0o600 });
        await fsp.rename(tmp, filePath);
      } catch {
        // A cache that cannot be written is a cache that misses. Not worth a
        // line in the log on every repaint of a read-only home directory.
        try {
          await fsp.unlink(tmp);
        } catch {
          /* nothing to clean up */
        }
      }
    })();
  };

  return {
    reload(): Promise<ReadonlyMap<string, CachedUsage> | null> {
      loaded = null;
      return this.load();
    },
    load(): Promise<ReadonlyMap<string, CachedUsage> | null> {
      loaded ??= (async (): Promise<ReadonlyMap<string, CachedUsage> | null> => {
        let text: string | null = null;
        try {
          text = await fsp.readFile(filePath, 'utf-8');
        } catch {
          return null;
        }
        const parsed = parseUsageCache(text, Date.now());
        if (parsed === null) return null;
        for (const [id, entry] of parsed) entries.set(id, entry);
        return parsed;
      })();
      return loaded;
    },
    save(id: string, entry: CachedUsage): void {
      if (!isAccountIdish(id)) return;
      entries.set(id, entry);
      dirty = true;
      // Coalesced: several accounts settle within milliseconds of each other on
      // a repaint, and that is one file, once.
      if (timer !== undefined) return;
      timer = setTimeout(flush, 1_000);
      // Never hold the host open for a cache write.
      timer.unref?.();
    },
  };
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

/**
 * The word in front of a window's percentage. The slot's own name (`5h`, `wk`)
 * whenever the window is the length the slot was named for — or carries no
 * length at all, which is every Claude window — and the window's real
 * duration otherwise: `6h`, `3d`. Exported so the accounts view's formatter
 * can spell the same rule with its own words (`week`), and so the rule is
 * tested once.
 */
export function windowLabel(
  win: UsageWindow,
  slotName: string,
  weekWord: string = 'wk',
): string {
  const minutes = win.minutes;
  if (minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) return slotName;
  if (minutes === 300) return slotName === 'wk' || slotName === weekWord ? slotName : '5h';
  if (minutes === 10080) return slotName === '5h' ? slotName : weekWord;
  if (minutes < 60) return `${String(Math.round(minutes))}m`;
  if (minutes < 24 * 60) return `${String(Math.round(minutes / 60))}h`;
  return `${String(Math.round(minutes / (24 * 60)))}d`;
}

function weeklyReset(snapshot: UsageSnapshot): number | undefined {
  const a = snapshot.sevenDay?.resetsAt;
  if (a !== undefined && Number.isFinite(a)) return a;
  const b = snapshot.sevenDayOpus?.resetsAt;
  return b !== undefined && Number.isFinite(b) ? b : undefined;
}

/**
 * How long until a window rolls over — "1h 20m", "45m" — or '' when the
 * timestamp is absent, unreadable, or already behind us. A duration rather
 * than a clock time because the five-hour window is the one this decorates,
 * and "can I keep working here" is a question about hours left, not about
 * what the clock will say. (The WEEKLY reset stays a weekday for the same
 * reason in reverse: days out, the calendar is the answer.)
 *
 * Exported for the same reason `weekdayFor` is: the test builds its
 * expectation from the function instead of hardcoding arithmetic.
 */
export function resetInLabel(
  resetsAt: number | undefined,
  now: number,
): string {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return '';
  const ms = resetsAt - now;
  if (ms <= 0) return '';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${String(Math.max(1, minutes))}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(rest)}m`;
  }
  return `${String(Math.round(hours / 24))}d`;
}

/**
 * The one line the accounts view puts under an account's name.
 *
 *   "5h 62% → 1h 20m · wk 41% → Tue"   numbers, five-hour time left, weekly
 *                             rollover day. The five-hour arrow answers the
 *                             question the percentage cannot: 90% with ten
 *                             minutes to go and 90% with four hours to go are
 *                             opposite answers to "start another session
 *                             here?" — same rule the weekly arrow follows.
 *   "5h 62% · wk 41% · stale" the same, served from a cache we no longer trust
 *   "a@b.c · usage unavailable"  signed in (identity file says so) but the
 *                             credential could not be read — the state that
 *                             used to render, wrongly, as "not logged in"
 *   "not logged in"           never signed in on this account (no identity)
 *   "a@b.c · sign-in expired" / "sign-in expired"  the sign-in is over and
 *                             only the user can fix it — the row's **Sign In
 *                             to Account** action is the fix, and the hover
 *                             says so
 *   "a@b.c · usage n/a"       signed in, the cached token has aged out and the
 *                             CLI renews it on its next run: the METER is
 *                             missing, the login is not
 *   "usage unavailable"       the endpoint said something we could not use
 *   "usage stale"             nothing but an old failure to report
 *   "no usage yet"            answered, with nothing in it — a login that has
 *                             not taken a turn, not a fault
 *   ""                        NO answer at all — a Gemini, generic or API-key
 *                             account (Codex IS served: it reads off its own
 *                             rollouts)
 *
 * The empty string is the interesting one. `null` is not a failure: it is what
 * `readUsage` returns for every account this file knowingly does not serve.
 * Those rows are not broken and have nothing to report, so they say nothing —
 * a permanent "no usage yet" under accounts that will never have a meter is
 * noise that trains the eye to skip the line that matters. A snapshot that EXISTS and carries nothing is different:
 * something answered and we could not use it, which is worth a word.
 *
 * Pure string building. The clock arrives as an argument — defaulted to the
 * wall clock for the one live caller — so the test lane can still pin every
 * one of these.
 */
export function formatUsageSummary(
  snapshot: UsageSnapshot | null | undefined,
  now: number = Date.now(),
): string {
  if (snapshot === null || snapshot === undefined) return '';

  const parts: string[] = [];
  if (snapshot.fiveHour) {
    const left = resetInLabel(snapshot.fiveHour.resetsAt, now);
    parts.push(
      `${windowLabel(snapshot.fiveHour, '5h')} ${percentLabel(snapshot.fiveHour.utilization)}` +
        (left === '' ? '' : ` → ${left}`),
    );
  }
  if (snapshot.sevenDay) {
    parts.push(
      `${windowLabel(snapshot.sevenDay, 'wk')} ${percentLabel(snapshot.sevenDay.utilization)}`,
    );
  }
  if (snapshot.sevenDayOpus) parts.push(`opus ${percentLabel(snapshot.sevenDayOpus.utilization)}`);

  const who =
    typeof snapshot.signedInAs === 'string' && snapshot.signedInAs.trim() !== ''
      ? snapshot.signedInAs.trim()
      : '';
  const paused = snapshot.error === 'rate-limited' || snapshot.error === 'polling-paused';
  const back = paused ? resetInLabel(snapshot.retryAt, now) : '';
  const pause = paused
    ? 'Flock usage polling paused' + (back === '' ? '' : ` → ${back}`)
    : '';
  if (parts.length === 0) {
    switch (snapshot.error) {
      case 'no-credentials':
        // With an identity on record, "not logged in" would be a lie — the
        // login exists; it is the CREDENTIAL READ that came up empty.
        return who === '' ? 'not logged in' : `${who} · usage unavailable`;
      case 'expired':
        // "sign-in expired", the same words the row's own action is spelled
        // with (**Sign In to Account**) — a row that names a state the user
        // can act on should name the action too, and the hover says which.
        return who === '' ? 'sign-in expired' : `${who} · sign-in expired`;
      case 'token-stale':
        // NOT "login expired". The account is signed in; its access token has
        // simply aged out between CLI runs, and the next `claude` on this
        // profile renews it without asking. The meter is what is missing, and
        // that is all this says.
        return who === '' ? 'usage n/a' : `${who} · usage n/a`;
      case 'polling-paused':
      case 'rate-limited': {
        return who === '' ? pause : `${who} · ${pause}`;
      }
      case 'http':
      case 'parse':
        return 'usage unavailable';
      default: {
        // A signed-in account with no windows to show — a Codex login that has
        // not taken a turn yet, which is EVERY Codex row on a fresh machine —
        // still names itself: the name is the fact the row has. "no usage yet"
        // rather than "usage n/a" because nothing has failed here; Codex
        // publishes its rate limits only after a turn, and "n/a" under a
        // brand-new account reads as a fault the user is meant to fix.
        const word = snapshot.stale === true ? 'usage stale' : 'no usage yet';
        return who === '' ? word : `${who} · ${word}`;
      }
    }
  }

  let line = parts.join(' · ');
  const reset = weeklyReset(snapshot);
  const day = reset === undefined ? '' : weekdayFor(reset);
  if (day !== '') line += ` → ${day}`;
  if (snapshot.stale === true) line += ' · stale';
  // A remembered reading must not hide the reason it cannot be refreshed.
  // Lead with the pause so a narrow sidebar still shows the wait.
  return pause === '' ? line : `${pause} · ${line}`;
}

// ------------------------------------------------------------- credentials

/**
 * What a credential lookup produced. The token never leaves this module.
 *
 * `refreshable` is carried on every kind that has an opinion, and it is the
 * whole of the "login expired" fix: an access token lapses in HOURS, and the
 * CLI silently mints a new one from the refresh token sitting beside it the
 * next time it runs. So an expiry in the past says nothing about whether the
 * user is signed in — only whether THIS cached token can be spent — and the
 * refresh token is what tells the two apart.
 */
type CredentialResult =
  | { kind: 'ok'; token: string; refreshable: boolean }
  | { kind: 'missing'; why?: CredentialWhy }
  /** Lapsed access token and NO refresh token anywhere in the document: the
   *  sign-in really is over, and only the user can fix it. */
  | { kind: 'expired'; why?: CredentialWhy }
  /** Lapsed (or absent) access token WITH a refresh token: signed in, nothing
   *  to fix, and no point spending a round trip on a header that will 401. */
  | { kind: 'stale'; why?: CredentialWhy };

/**
 * WHICH fact produced a non-ok verdict, for the log and for nothing else.
 *
 * The credential tiers used to be the one part of this file that failed
 * silently: an HTTP failure names its status and an unusable body says so, but
 * every credential verdict — "not signed in", "sign-in expired", "usage n/a" —
 * reached the row as three words with no way to tell which of several quite
 * different situations produced them. That is exactly the gap that made a live
 * account reading `usage n/a` unfalsifiable from the outside.
 *
 * None of these carry a token, a path's contents, or any part of the blob.
 */
type CredentialWhy =
  /** Nothing to parse: no file, and the keychain returned nothing. */
  | 'no-document'
  /** A document that would not parse as JSON. */
  | 'unparseable'
  /** Parsed, but carries no access token under any known spelling. */
  | 'no-access-token'
  /** Parsed, has an access token, and its `expiresAt` is in the past. */
  | 'lapsed';

/** Squashed key spellings (`normKey` folds `refresh_token` onto
 *  `refreshtoken`), so one entry covers every casing and separator a CLI has
 *  been seen to write. */
const ACCESS_TOKEN_KEYS: readonly string[] = ['accesstoken'];
const REFRESH_TOKEN_KEYS: readonly string[] = ['refreshtoken'];
const EXPIRES_AT_KEYS: readonly string[] = ['expiresat'];
/** The section of the document that is Claude's own sign-in. */
const CLAUDE_OAUTH_SECTION_KEYS: readonly string[] = ['claudeaioauth'];
/** Sections that hold OTHER services' grants. Claude Code keeps every MCP
 *  server's OAuth tokens in the same document as the login, under `mcpOAuth`,
 *  and that section sits FIRST once it exists. Nothing in it is ever a token
 *  for Anthropic, so the walk never enters it. */
const FOREIGN_SECTION_KEYS: readonly string[] = ['mcpoauth'];

/** The first raw value under any of `keys`, matched on the squashed key. */
function rawUnder(obj: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const [key, value] of Object.entries(obj)) {
    if (keys.includes(normKey(key))) return value;
  }
  return undefined;
}

/**
 * JSON.parse for a file some other program wrote, as an object or undefined.
 *
 * The BOM is the Windows part: `%USERPROFILE%\.claude\.credentials.json` is
 * written by the CLI without one, but anything that has passed through
 * PowerShell's `Set-Content`/`Out-File` or Notepad comes back with a leading
 * U+FEFF, and `JSON.parse` throws on it. A credentials file we throw on reads
 * as "no credentials", which is a whole account rendered signed-out over one
 * invisible character.
 */
function parseJsonObject(text: string | null | undefined): Record<string, unknown> | undefined {
  if (typeof text !== 'string') return undefined;
  const body = text.replace(/^\uFEFF/, '').trim();
  if (body === '') return undefined;
  try {
    const root: unknown = JSON.parse(body);
    return isPlainObject(root) ? root : undefined;
  } catch {
    return undefined;
  }
}

interface CredentialFields {
  /** '' when the document holds no access token at all. */
  token: string;
  /** The expiry sitting BESIDE the access token, in epoch ms. */
  expiresAt?: number;
  /** A refresh token exists SOMEWHERE in the document. Presence only — never
   *  the value, which is a credential this file has no reason to hold. */
  refreshable: boolean;
}

/**
 * The fields a credentials document carries, found by a bounded walk rather
 * than at one hardcoded path.
 *
 * `claudeAiOauth.accessToken` is where Claude Code puts them, and when that
 * section exists it is the ONLY section read. The first version of this walk
 * took the first `accessToken` anywhere in the document, on the belief that
 * the login section came first in the file. It does not once an MCP server
 * has been authorised: the CLI stores every server's grant in the same
 * document under `mcpOAuth`, ahead of the login, and on a profile where one
 * of those grants was live the walk picked up a Figma token and sent it to
 * Anthropic as the Bearer for the usage read. The endpoint answered every
 * such request with a 429 and an hour-long Retry-After, for that one profile
 * only — the other profile's MCP tokens happened to be empty strings — and
 * the row read as an account that could not be polled, which is what the
 * cooldown rounds were then built against. So: when the login section exists,
 * the access token comes from inside it and nowhere else; a document without
 * one is walked for the other spellings; and `mcpOAuth` is skipped at any
 * depth in both cases, because nothing in it is ever a token for Anthropic.
 *
 * The walk exists for the other spellings: a token nested one level deeper,
 * or — the one that matters — a refresh token that is NOT a sibling of the
 * access token. "No refreshToken under this exact key" is the whole evidence
 * behind telling a user their sign-in expired, and that verdict must not rest
 * on the shape of a file another program owns — so refresh-token evidence is
 * still taken from the whole document (foreign sections excepted), even when
 * the access token is confined to the login section. Bounded by the same
 * depth and node budget the usage scan uses: a credentials file is a few
 * hundred bytes, and a strange one must not turn a repaint into a tree
 * traversal.
 */
function scanCredential(root: unknown): CredentialFields {
  let token = '';
  let expiresAt: number | undefined;
  let refreshable = false;
  let budget = SCAN_NODE_BUDGET;
  const hasLogin = isPlainObject(root) && isPlainObject(rawUnder(root, CLAUDE_OAUTH_SECTION_KEYS));

  const visit = (value: unknown, depth: number, inLogin: boolean): void => {
    if (budget <= 0 || depth > SCAN_MAX_DEPTH) return;
    budget -= 1;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1, inLogin);
      return;
    }
    if (!isPlainObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const squashed = normKey(key);
      if (FOREIGN_SECTION_KEYS.includes(squashed)) continue;
      const text = typeof child === 'string' ? child.trim() : '';
      if (
        text !== '' && ACCESS_TOKEN_KEYS.includes(squashed) && token === '' &&
        (inLogin || !hasLogin)
      ) {
        token = text;
        // The expiry that belongs to THIS token, not the first one in the file.
        expiresAt = parseResetAt(rawUnder(value, EXPIRES_AT_KEYS));
      }
      if (text !== '' && REFRESH_TOKEN_KEYS.includes(squashed)) refreshable = true;
      visit(child, depth + 1, inLogin || (depth === 0 && CLAUDE_OAUTH_SECTION_KEYS.includes(squashed)));
    }
  };

  visit(root, 0, false);
  return expiresAt === undefined ? { token, refreshable } : { token, expiresAt, refreshable };
}

/** Pull the access token out of the OAuth blob, honouring its expiry. Kept
 *  private: nothing outside this file has a reason to hold a token. */
function readCredentialBlob(text: string | null, now: number): CredentialResult {
  const root = parseJsonObject(text);
  // Unreadable is 'missing', never 'expired': a file we could not parse is a
  // file that said nothing, and "your sign-in expired" is a claim that needs
  // evidence. The two shades are still distinguished for the LOG — "there was
  // nothing there" and "there was something there and it was not JSON" send a
  // reader to completely different places.
  if (root === undefined) {
    const had = typeof text === 'string' && text.trim() !== '';
    return { kind: 'missing', why: had ? 'unparseable' : 'no-document' };
  }

  const { token, expiresAt, refreshable } = scanCredential(root);
  if (token === '') {
    // A refresh token with no access token beside it is a LIVE login whose
    // cached token has been spent or cleared — the CLI mints a new one on its
    // next run. Calling that "not signed in" is the same lie in a different
    // place.
    return refreshable
      ? { kind: 'stale', why: 'no-access-token' }
      : { kind: 'missing', why: 'no-access-token' };
  }

  // An expiry in the past means the CLI has not refreshed yet. Sending it would
  // buy a 401 and a wasted round trip; say so from here instead. WHICH thing it
  // says depends on the refresh token: with one, this is an ordinary lapsed
  // token on a live login and the CLI renews it unprompted; without one, the
  // sign-in is genuinely over and only the user can fix it.
  if (expiresAt !== undefined && expiresAt <= now) {
    return refreshable
      ? { kind: 'stale', why: 'lapsed' }
      : { kind: 'expired', why: 'lapsed' };
  }

  return { kind: 'ok', token, refreshable };
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
 * Two providers, two sources, one answer shape. An OAuth Claude account is
 * read from the usage endpoint; a Codex account is read off the newest rollout
 * in its home, where the CLI writes the server's rate limits after every turn
 * (see codex.ts's rate-limits section — the surface this used to call
 * undocumented, found and measured). Gemini, generic and API-key profiles
 * still get `null`, which routing.ts treats as "unknown" and the view renders
 * as no meter at all: a key has no plan windows to report.
 */
export function supportsUsage(profile: AccountProfile): boolean {
  if (hasApiKeyEnv(profile)) return false;
  return profile.provider === 'claude' || profile.provider === 'codex';
}

// -------------------------------------------------------------- codex shape

/** Windows a day or shorter take the short slot; anything longer, the weekly
 *  one. Codex's are 300 and 10080 minutes on every plan measured, so the rule
 *  is a formality with a tie-break: when both readings fall on one side, the
 *  second takes the free slot rather than overwriting the first. */
const SHORT_WINDOW_MAX_MINUTES = 24 * 60;

function codexSlotFor(
  minutes: number | undefined,
  snapshot: UsageSnapshot,
): 'fiveHour' | 'sevenDay' | undefined {
  const preferred: 'fiveHour' | 'sevenDay' =
    minutes === undefined || minutes <= SHORT_WINDOW_MAX_MINUTES ? 'fiveHour' : 'sevenDay';
  if (snapshot[preferred] === undefined) return preferred;
  const other: 'fiveHour' | 'sevenDay' = preferred === 'fiveHour' ? 'sevenDay' : 'fiveHour';
  return snapshot[other] === undefined ? other : undefined;
}

/**
 * Pure. A Codex reading and identity as the `UsageSnapshot` every consumer
 * already speaks.
 *
 * A window whose reset is already behind `now` is reported OPEN — 0%, no
 * reset — rather than at the percentage the file remembers: the reading is
 * only as fresh as the last Codex turn, and a five-hour window measured
 * yesterday has rolled over however full it was. `observedAt` carries the
 * reading's own stamp so the hover can say how old the numbers are. An
 * exported function rather than a private step so the mapping is pinned by
 * tests independently of the reader.
 */
export function buildCodexSnapshot(
  reading: CodexRateLimits | null,
  identity: CodexIdentity | null,
  now: number,
): UsageSnapshot {
  const snapshot: UsageSnapshot = { fetchedAt: now };
  if (identity?.email !== undefined) snapshot.signedInAs = identity.email;
  const plan = reading?.planType ?? identity?.planType;
  if (plan !== undefined) snapshot.plan = plan;
  if (reading === null) return snapshot;
  if (Number.isFinite(reading.observedAt) && reading.observedAt > 0) {
    snapshot.observedAt = reading.observedAt;
  }
  for (const win of [reading.primary, reading.secondary]) {
    if (win === undefined) continue;
    const slot = codexSlotFor(win.windowMinutes, snapshot);
    if (slot === undefined) continue;
    const built: UsageWindow = { utilization: clampPercent(win.usedPercent) };
    if (win.windowMinutes !== undefined) built.minutes = win.windowMinutes;
    if (win.resetsAt !== undefined) {
      if (win.resetsAt <= now) built.utilization = 0; // rolled over since
      else built.resetsAt = win.resetsAt;
    }
    snapshot[slot] = built;
  }
  return snapshot;
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

/** Does this snapshot actually carry a number a row could draw? */
function hasWindows(s: UsageSnapshot): boolean {
  return (
    s.fiveHour !== undefined || s.sevenDay !== undefined || s.sevenDayOpus !== undefined
  );
}

function cloneWindow(win: UsageWindow | undefined): UsageWindow | undefined {
  if (win === undefined) return undefined;
  const out: UsageWindow = { utilization: win.utilization };
  if (win.resetsAt !== undefined) out.resetsAt = win.resetsAt;
  if (win.minutes !== undefined) out.minutes = win.minutes;
  return out;
}

/**
 * Are these numbers old enough to warn about?
 *
 * ONE rule, in one place, because there were two and they disagreed. `cached()`
 * has always asked how old the reading actually is (STALE_AFTER_MS); the
 * failure paths asked a different question — "did the most recent ATTEMPT
 * fail?" — and flagged a thirty-second-old reading as stale because a refresh
 * behind it had just been throttled.
 *
 * That is the flag's own stated failure mode: "a snapshot between the two is
 * simply the current answer, and flagging it would train the user to ignore
 * the flag." A number measured two minutes ago IS the current answer, whatever
 * happened since. The failure is not lost — it rides on `error`, and the row's
 * hover names it — but it is a fact about the LAST ATTEMPT, not about the
 * numbers on the row.
 */
function isStale(fetchedAt: number, now: number): boolean {
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return true;
  return now - fetchedAt > STALE_AFTER_MS;
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
  if (snapshot.plan !== undefined) out.plan = snapshot.plan;
  if (snapshot.signedInAs !== undefined) out.signedInAs = snapshot.signedInAs;
  if (snapshot.retryAt !== undefined) out.retryAt = snapshot.retryAt;
  if (snapshot.observedAt !== undefined) out.observedAt = snapshot.observedAt;
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
  private readonly codexUsage: CodexUsageLike;
  private readonly cache: UsageCacheStore | undefined;
  private readonly scheduler: UsageRequestScheduler;
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
    this.codexUsage = deps.codexUsage ?? realCodexUsage;
    // No default. A service with no cache behaves exactly as this file did
    // before one existed — which is what every unit double wants, and what a
    // host that does not want a file on disk gets.
    this.cache = deps.cache;
    this.platform = deps.platform ?? process.platform;
    this.clock = deps.now ?? Date.now;
    this.scheduler = deps.scheduler ?? createUsageRequestScheduler(undefined, {
      now: this.clock, sleep: deps.sleep,
    });
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
      const needsSeed = entry === undefined;
      if (entry === undefined) {
        entry = { configDir, snapshot: null, lastAttemptAt: 0, nextAttemptAt: 0, backoffMs: 0 };
        this.entries.set(profile.id, entry);
      }
      // Include disk seeding and merging in the in-flight operation. A second
      // caller must not start a fetch while the first is still loading its seed.
      if (entry.inflight !== undefined) return await entry.inflight;
      const run = this.readEntry(profile, entry, options.force === true, needsSeed);
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

  private async readEntry(
    profile: AccountProfile,
    entry: CacheEntry,
    force: boolean,
    needsSeed: boolean,
  ): Promise<UsageSnapshot | null> {
    if (needsSeed) await this.seed(profile, entry, entry.configDir);
    if (this.disposed) return null;
    const now = this.clock();
    if (!force && entry.snapshot !== null) {
      if (now - entry.lastAttemptAt < this.minIntervalMs || entry.nextAttemptAt > now) {
        return this.cached(profile);
      }
    }
    const result = await this.refresh(profile, entry, force);
    if (result !== null && result.error !== undefined && !hasWindows(result)) {
      // Another window may have obtained a reading during this attempt.
      await this.seed(profile, entry, entry.configDir, true);
      if (entry.good !== undefined) {
        const merged = cloneSnapshot(entry.good);
        if (isStale(merged.fetchedAt, this.clock())) merged.stale = true;
        else delete merged.stale;
        merged.error = result.error;
        if (result.retryAt !== undefined) merged.retryAt = result.retryAt;
        if (result.signedInAs !== undefined) merged.signedInAs = result.signedInAs;
        entry.snapshot = merged;
        this.emit();
        return merged;
      }
    }
    return result;
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

  /** The directory this profile's login lives in — `~/.claude` or `~/.codex`
   *  by provider when the profile names none. Keys the cache too, so a profile
   *  whose directory moved reads as a different login. */
  private configDirFor(profile: AccountProfile): string {
    const configured = typeof profile.configDir === 'string' ? profile.configDir.trim() : '';
    if (configured !== '') return configured;
    if (this.homeDir === '') return '';
    return path.join(
      this.homeDir,
      profile.provider === 'codex' ? DEFAULT_CODEX_HOME_NAME : DEFAULT_CONFIG_DIR_NAME,
    );
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
    force = false,
  ): Promise<UsageSnapshot | null> {
    if (profile.provider === 'codex') return this.refreshCodex(profile, entry);
    const before = signature(entry.snapshot);
    let result: UsageSnapshot;
    try {
      entry.lastAttemptAt = this.clock();
      const cred = await this.resolveCredential(profile);
      if (cred.kind !== 'ok') {
        // No network was touched, so no backoff: a user who has just logged in
        // — or whose CLI has just refreshed a lapsed token — should see it on
        // their next look, not in fifteen minutes.
        result = this.settleFailure(
          entry,
          cred.kind === 'expired'
            ? 'expired'
            : cred.kind === 'stale'
              ? 'token-stale'
              : 'no-credentials',
          false,
        );
      } else {
        // Directory identity dedupes aliases without persisting credentials.
        const account = createHash('sha256').update(path.resolve(entry.configDir)).digest('hex');
        const scheduled = await this.scheduler.run(account, {
          force, minIntervalMs: this.minIntervalMs, cancelled: () => this.disposed,
        }, async () => {
          const value = await this.request(cred.token, profile.id);
          return {
            value, rateLimited: value.kind === 'rate-limited',
            ...(value.kind === 'rate-limited' ? { retryAfterMs: value.retryAfterMs } : {}),
          };
        });
        if (scheduled.kind === 'cancelled') return null;
        if (scheduled.kind !== 'sent') {
          await this.seed(profile, entry, entry.configDir, true);
          if (scheduled.kind === 'cached' && entry.good !== undefined) {
            result = entry.good;
            entry.snapshot = result;
          } else {
            result = this.settlePause(entry, scheduled.retryAt,
              scheduled.kind === 'paused' && scheduled.rateLimited
                ? 'rate-limited' : 'polling-paused');
          }
        } else {
          const res = scheduled.value;
          if (res.kind !== 'ok') {
            // A 401 on a token the file said was still good is the same fact the
            // expiry check reads, arriving from the other side: the token is dead.
            // It is only a SIGN-IN problem when there is no refresh token to mint
            // another one from — otherwise the CLI fixes it on its next run and
            // telling the user their login expired would send them to `/login`
            // for nothing.
            const error =
              res.kind === 'expired' && cred.refreshable ? 'token-stale' : res.kind;
            // A throttle backs off like an http failure — it is the one failure
            // where backing off is the entire point — and carries the wait the
            // server stated, which overrides the guessed ladder.
            result =
              res.kind === 'rate-limited'
                ? this.settlePause(entry, scheduled.retryAt!, 'rate-limited')
                : this.settleFailure(entry, error, res.kind === 'http');
          } else {
            const parsed = parseUsageBody(res.text, this.clock());
            if (parsed === null) {
              logError(
                'limits: unrecognised usage payload',
                new Error(`account ${profile.id}`),
              );
              result = this.settleFailure(entry, 'parse', true);
            } else {
              result = this.settleSuccess(entry, parsed, profile.id);
            }
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

  /**
   * The Codex attempt: two file reads, no network, no keychain.
   *
   *   1. `<home>/auth.json` missing → `no-credentials`: nothing is signed in
   *      here, and the row's Sign In is the fix. No backoff — a file read is
   *      free, and a user who has just signed in should see it next look.
   *   2. present → identity out of it (who, plan); then the newest rate-limit
   *      reading in `<home>/sessions`, which may be null for a login that has
   *      never taken a turn — a snapshot with a name and no windows, not an
   *      error, because nothing failed.
   *
   * A thrown read is `parse` without backoff: the disk did not say something
   * unusable, we failed to read it, and the next attempt costs nothing.
   */
  private async refreshCodex(
    profile: AccountProfile,
    entry: CacheEntry,
  ): Promise<UsageSnapshot | null> {
    const before = signature(entry.snapshot);
    let result: UsageSnapshot;
    try {
      entry.lastAttemptAt = this.clock();
      const home = this.configDirFor(profile);
      const authText = home === '' ? null : await this.readFile(codexAuthPath(home));
      const identity = parseCodexAuth(authText);
      if (authText === null) {
        result = this.settleFailure(entry, 'no-credentials', false);
      } else {
        const reading = await this.codexUsage(codexSessionsDir(home));
        result = this.settleSuccess(
          entry,
          buildCodexSnapshot(reading, identity, this.clock()),
          profile.id,
        );
      }
      // Identity rides on failure too, as it does for Claude: a login whose
      // meter cannot be read is still a login with a name.
      if (identity?.email !== undefined) result.signedInAs = identity.email;
      if (result.plan === undefined && identity?.planType !== undefined) {
        result.plan = identity.planType;
      }
    } catch (err) {
      logError('limits: codex usage read failed', err);
      result = this.settleFailure(entry, 'parse', false);
    }
    if (signature(result) !== before) this.emit();
    return result;
  }

  private settlePause(
    entry: CacheEntry,
    retryAt: number,
    error: 'rate-limited' | 'polling-paused',
  ): UsageSnapshot {
    const snapshot = this.settleFailure(entry, error, false);
    entry.nextAttemptAt = retryAt;
    snapshot.retryAt = retryAt;
    return snapshot;
  }

  private settleSuccess(
    entry: CacheEntry,
    snapshot: UsageSnapshot,
    profileId?: string,
  ): UsageSnapshot {
    entry.good = snapshot;
    entry.snapshot = snapshot;
    entry.backoffMs = 0;
    entry.nextAttemptAt = 0;
    // Remembered for the next window, and for the next throttle. Only
    // successes are ever written — a cache of failures would be a way to make
    // a row lie about numbers nobody measured.
    if (profileId !== undefined) {
      try {
        this.cache?.save(profileId, { configDir: entry.configDir, snapshot });
      } catch (err) {
        logError('limits: usage cache write failed', err);
      }
    }
    return snapshot;
  }

  /**
   * Fill a brand-new entry from the remembered readings, when there are any.
   *
   * The seeded snapshot becomes both `good` (what a failure degrades to) and
   * `snapshot` (what `cached()` serves before anything has been fetched), so a
   * freshly opened window shows the last numbers it knew instead of a blank row
   * while its first request is in flight — or refused.
   *
   * Guarded on the config directory for the same reason the in-memory entry is:
   * a profile that moved is a different login, and its old numbers are somebody
   * else's. Never throws; a cache that will not load is a cache that misses.
   */
  private async seed(
    profile: AccountProfile,
    entry: CacheEntry,
    configDir: string,
    /** Re-read the file rather than trusting what startup remembered. Used
     *  after a failure, when another window's success — or a hand-written
     *  entry — is the only thing that could put numbers on this row. */
    fresh = false,
  ): Promise<void> {
    if (this.cache === undefined) return;
    let all: ReadonlyMap<string, CachedUsage> | null = null;
    try {
      all =
        fresh && this.cache.reload !== undefined
          ? await this.cache.reload()
          : await this.cache.load();
    } catch (err) {
      logError('limits: usage cache read failed', err);
      return;
    }
    const remembered = all?.get(profile.id);
    if (remembered === undefined) return;
    if (remembered.configDir !== configDir) return;
    // Out of the cache, but that says nothing about its AGE: a reading another
    // window took ninety seconds ago is the current answer, and calling it
    // stale is the same over-eager flag isStale exists to stop. Old ones are
    // still marked, and anything past USAGE_CACHE_TTL_MS never gets this far.
    const snapshot = cloneSnapshot(remembered.snapshot);
    if (isStale(snapshot.fetchedAt, this.clock())) snapshot.stale = true;
    else delete snapshot.stale;
    entry.good = snapshot;
    entry.snapshot = snapshot;
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
      // Stale is about the NUMBERS' age, never about whether the attempt behind
      // them failed — see isStale.
      if (isStale(good.fetchedAt, this.clock())) snapshot.stale = true;
      else delete snapshot.stale;
      snapshot.error = error;
    }
    entry.snapshot = snapshot;
    if (backoff) {
      const guessed =
        entry.backoffMs <= 0 ? BACKOFF_BASE_MS : Math.min(entry.backoffMs * 2, BACKOFF_MAX_MS);
      entry.backoffMs = guessed;
      entry.nextAttemptAt = this.clock() + guessed;
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
    let tier = 'none';
    let result: CredentialResult = { kind: 'missing', why: 'no-document' };
    if (file !== '') {
      tier = 'credentials file';
      result = readCredentialBlob(await this.readFile(file), now);
      if (result.kind !== 'missing') {
        this.logCredential(profile, tier, result);
        return result;
      }
    }
    if (this.platform === 'darwin') {
      const configured =
        typeof profile.configDir === 'string' ? profile.configDir.trim() : '';
      const service = keychainServiceFor(configured || undefined);
      tier = `keychain ${service}`;
      const out = await this.exec(
        'security',
        ['find-generic-password', '-s', service, '-w'],
        this.execTimeoutMs,
      );
      result = readCredentialBlob(out, now);
    }
    this.logCredential(profile, tier, result);
    return result;
  }

  /**
   * One line naming WHICH tier answered and WHY it was not usable — the
   * credential half of the diagnosis the HTTP path already writes.
   *
   * A success logs nothing: the happy path runs on every repaint of the row and
   * a log that narrates it is a log nobody reads. Failures are what a person
   * is looking for, and every one of them used to arrive at the row as three
   * words ("usage n/a") with no way to tell a keychain the editor cannot read
   * from a token the CLI has not renewed yet.
   *
   * NOTHING SECRET GOES IN. The tier is a path or a keychain SERVICE NAME
   * (a public identifier — it is a hash of the config directory), and `why` is
   * one of four fixed words about the document's SHAPE. The token, the blob and
   * any part of either are never touched.
   */
  private logCredential(
    profile: AccountProfile,
    tier: string,
    result: CredentialResult,
  ): void {
    if (result.kind === 'ok') return;
    const why = result.why === undefined ? '' : `, ${result.why}`;
    logError(
      'limits: no usable credential',
      new Error(`account ${profile.id} — ${result.kind} from ${tier}${why}`),
    );
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
    // Through the same BOM-tolerant parse the credentials file gets: a
    // `.claude.json` that has been through a Windows editor still names its
    // account, and a row that loses its name is a row that says "not logged
    // in" about a login that exists.
    const root = parseJsonObject(text);
    if (root === undefined) return undefined;
    const account = root['oauthAccount'];
    if (!isPlainObject(account)) return undefined;
    const email = account['emailAddress'] ?? account['email_address'];
    return typeof email === 'string' && email.trim() !== '' ? email.trim() : undefined;
  }

  /** The GET. Distinguishes only the two things the caller can act on: a dead
   *  token (401) and everything else. */
  private async request(
    token: string,
    /** For the LOG only, and it earns its place: a machine with two accounts
     *  throttled at once produced two indistinguishable lines in the same
     *  second, and "which of them is still locked out" was unanswerable from
     *  them. An account id, never anything from the credential. */
    profileId: string,
  ): Promise<
    | { kind: 'ok'; text: string }
    | { kind: 'expired' }
    | { kind: 'http' }
    | { kind: 'rate-limited'; retryAfterMs?: number }
  > {
    // Admission has completed; the HTTP timeout starts only when sending.
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
      // A refusal of Flock's usage request says nothing about account capacity.
      if (status === 429) {
        const after = retryAfterMs(res.headers, this.clock());
        // Keep the server's exact header in the log. The scheduler decides
        // the actual wait, which may be longer because of fallback backoff.
        let raw: string | null = null;
        try {
          raw = res.headers?.get('retry-after') ?? null;
        } catch {
          raw = null;
        }
        const honoured =
          after === undefined ? '' : `, minimum wait ${String(Math.round(after / 1000))}s`;
        logError(
          'limits: usage request throttled',
          new Error(
            `account ${profileId} — ` +
              (raw === null
                ? 'HTTP 429, no retry-after (falling back to the guessed ladder)'
                : `HTTP 429, retry-after: ${raw}${honoured}`),
          ),
        );
        return after === undefined
          ? { kind: 'rate-limited' }
          : { kind: 'rate-limited', retryAfterMs: after };
      }
      const ok = res.ok ?? (status >= 200 && status < 300);
      if (!ok) {
        // THE ONE FAILURE THAT USED TO LEAVE NO TRACE. A throw is logged below
        // and an unusable body is logged by the caller, but a perfectly
        // well-formed non-2xx — 403 from a beta gate, 429 from too many
        // windows asking at once, a 5xx — returned silently, and the row it
        // produces says only "usage unavailable". So the single state a person
        // cannot diagnose from the row was also the single state the log did
        // not mention. The STATUS is the whole diagnosis and it is not a
        // secret; the body is not read, because an error body from this
        // endpoint is the one place a token could be echoed back.
        logError(
          'limits: usage request refused',
          new Error(`account ${profileId} — HTTP ${String(status)}`),
        );
        return { kind: 'http' };
      }
      const text = await res.text();
      return { kind: 'ok', text: typeof text === 'string' ? text : '' };
    } catch (err) {
      // Network errors name the host at worst; the token lives in a header and
      // never appears in one of these.
      logError(`limits: usage request failed for ${profileId}`, err);
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
