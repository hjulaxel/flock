// src/codex.ts — the Codex CLI contract: its argv, its session store, and the
// one inference that makes a Codex launch bindable.
//
// It imports ./types, ./log and node builtins only, never vscode, so the whole
// contract is testable outside the extension host — the same discipline
// roster.ts and archive.ts keep.
//
// WHY THIS FILE EXISTS. Flock used to exec exactly one binary, and accounts.ts
// said so out loud: a launch on a Codex account would have run `claude` with
// `CODEX_HOME` set, landed on the machine's default Claude login, and pinned
// the conversation to an account it was never on. The fix is not to relax that
// rule — it is to make the second binary real, which means writing down what
// the Codex CLI actually accepts and where it actually keeps its sessions.
// Everything in here was verified against `codex-cli 0.139.0` rather than
// assumed, because a wrong flag here is a launch that dies in a pty with a
// usage message.
//
// THE ONE GENUINE DIFFERENCE FROM CLAUDE, and the reason this module is more
// than a table of flags: `claude` takes `--session-id` and lets Flock PRE-MINT
// the id, so the terminal ↔ session binding is exact by construction. `codex`
// has no such flag. Its id is minted inside the process and first shows up in
// the name of the rollout file it opens. So a Codex launch binds in two beats:
// a provisional local id at spawn time, then a re-key onto the real id once
// the rollout file appears (see matchRollout). That inference is narrow on
// purpose — same cwd, born after we spawned, not already claimed by another
// row — because a wrong match would put one conversation's row on another
// conversation's transcript, and the house rule is that a wrong edge is worse
// than no edge.
//
// WHAT CODEX DOES NOT HAVE, said here once so no caller has to rediscover it:
// no `--session-id`, no `--name`, and no `--append-system-prompt`. The first
// is handled above. The second means a Codex row wears Flock's own title only.
// The third is folded into the opening prompt by buildCodexArgs, visibly,
// because a project chat that never says which project it is about is worse
// than one that says so in its first turn.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as process from 'node:process';

import { log } from './log';
import { SESSION_ID_RE, isSessionId } from './types';
import type { LaunchOptions } from './types';
import type { DiscoveryWorld } from './roster';

// ------------------------------------------------------------------ layout

/** `~/.codex`, the root `CODEX_HOME` relocates. */
export function defaultCodexHome(): string {
  return path.join(os.homedir(), '.codex');
}

/**
 * Where rollout files live under a Codex home: `<home>/sessions`, then a
 * `YYYY/MM/DD` tree beneath that.
 *
 * The date tree is why the scan below walks three levels instead of the two
 * archive.ts walks for `~/.claude/projects/<project>/<id>.jsonl`, and it is
 * also why the scan can be bounded by DATE rather than by reading anything:
 * a directory named for a day older than the window is skipped without a
 * single stat inside it.
 */
export function codexSessionsDir(codexHome?: string): string {
  const home =
    typeof codexHome === 'string' && codexHome.trim() !== ''
      ? codexHome.trim()
      : defaultCodexHome();
  return path.join(home, 'sessions');
}

/** `<home>/auth.json` — the file whose existence means "there is a Codex login
 *  here to point an account row at". Read by the seeder and by the account
 *  view; never parsed, only stat'ed, because it holds a live token. */
export function codexAuthPath(codexHome?: string): string {
  const home =
    typeof codexHome === 'string' && codexHome.trim() !== ''
      ? codexHome.trim()
      : defaultCodexHome();
  return path.join(home, 'auth.json');
}

/**
 * A rollout file's basename, as Codex writes it:
 *
 *   rollout-2026-08-12T01-00-59-019ff30e-c6bd-79d1-83c9-800e9a651496.jsonl
 *           └──────── local wall clock ────┘└──────── session id ──────┘
 *
 * The timestamp in the name is LOCAL TIME — measured: a file named `T01-00-59`
 * carries the header timestamp `2026-08-11T23:00:59Z`, two hours behind. It is
 * therefore NEVER parsed as a date anywhere in this module; ages come from the
 * header's own ISO-Z stamp, with the file's birthtime as the fallback. The
 * name is used for exactly one thing, which it does exactly: the id.
 */
const ROLLOUT_RE = new RegExp(
  `^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${SESSION_ID_RE.source.slice(1, -1)})\\.jsonl$`,
);

/** The session id a rollout basename names, or null when the name is not one
 *  of ours. Codex mints UUIDv7, which SESSION_ID_RE accepts unchanged — it is
 *  deliberately version-agnostic — so a Codex id is a session id everywhere
 *  else in this codebase with no special case. */
export function sessionIdOfRollout(basename: unknown): string | null {
  if (typeof basename !== 'string') return null;
  const m = ROLLOUT_RE.exec(basename);
  return m && isSessionId(m[1]) ? m[1] : null;
}

// -------------------------------------------------------------------- argv

/**
 * Pure. The argument vector for one Codex launch. Three mutually exclusive
 * forms, mirroring buildShellArgs's three:
 *
 *   resume  `['resume', <resumeId>, …]`  — reopen a session by id
 *   fork    `['fork', <parentId>, …]`    — branch off one
 *   new     `[…]`                        — no subcommand at all
 *
 * `resumeId` wins if both are somehow set, for the same reason it wins in
 * buildShellArgs: resuming into a fork would be a silent, data-losing surprise,
 * so the narrower intent is honoured.
 *
 * ORDERING. The subcommand comes first, its id positional immediately after
 * it, then the single-value flags, then the prompt as the final positional.
 * `codex resume` takes `[SESSION_ID] [PROMPT]` in that order, so the id has to
 * precede the prompt; putting it flush against the subcommand keeps it out of
 * reach of any flag. Note the contrast with buildShellArgs, where `--add-dir`
 * is VARIADIC and must therefore go first: Codex's `--add-dir` takes exactly
 * one directory, so it is repeated once per directory and can never swallow
 * the positional that follows it.
 *
 * `-C/--cd` is passed explicitly even though the terminal (and, under the
 * detach tier, the tmux wrap) already starts the process in `cwd`. It is not
 * redundant: the value Codex records in the rollout header's `cwd` is what
 * matchRollout later matches a launch against, and stating it on the command
 * line is what makes that value ours rather than whatever the pty inherited.
 *
 * `appendSystemPrompt` has no Codex flag. Rather than drop it — which would
 * leave a project chat with no idea what project it is about — it is folded
 * into the opening prompt, ahead of the user's own text and separated from it
 * by a blank line. Visible in the transcript, which is the honest trade: the
 * text is doing its job where the reader can see it, instead of silently not
 * doing it at all.
 *
 * `sessionName` is DROPPED, and this is the one place that says so. Codex has
 * no start-time naming flag, so a Codex row is named by Flock's terminal title
 * and by nothing on the CLI side.
 */
export function buildCodexArgs(opts: LaunchOptions): string[] {
  const args: string[] = [];

  const resumeId =
    typeof opts.resumeId === 'string' && opts.resumeId.length > 0
      ? opts.resumeId
      : null;
  const parentId =
    typeof opts.parentId === 'string' && opts.parentId.length > 0
      ? opts.parentId
      : null;

  if (resumeId !== null) {
    args.push('resume', resumeId);
  } else if (parentId !== null) {
    args.push('fork', parentId);
  }

  const cwd = typeof opts.cwd === 'string' ? opts.cwd.trim() : '';
  if (cwd !== '') args.push('--cd', cwd);

  // One flag per directory: Codex's --add-dir takes a single DIR, unlike the
  // Claude CLI's variadic form.
  for (const dir of opts.addDirs ?? []) {
    if (typeof dir === 'string' && dir.trim() !== '') args.push('--add-dir', dir);
  }

  const preamble =
    typeof opts.appendSystemPrompt === 'string'
      ? opts.appendSystemPrompt.trim()
      : '';
  const prompt = typeof opts.prompt === 'string' ? opts.prompt.trim() : '';
  const opening =
    preamble !== '' && prompt !== ''
      ? `${preamble}\n\n${prompt}`
      : preamble !== ''
        ? preamble
        : prompt;
  if (opening !== '') args.push(opening);

  return args;
}

// ------------------------------------------------------ binary discovery

/**
 * The Codex executable, or null.
 *
 * A non-empty `configured` value is returned verbatim, no existence check —
 * the same contract findClaudeBinary keeps, and for the same reason: the user
 * knows where their CLI is, and an over-eager stat would reject a shim we
 * cannot see through.
 *
 * Otherwise PATH is scanned. The extra wrinkle Codex has and Claude does not,
 * on this machine and every other one running a node version manager: the
 * binary lives under the ACTIVE node version (`~/.nvm/versions/node/<v>/bin/
 * codex`), and the environment a VS Code extension host inherits is frequently
 * the one from before the shell profile selected that version. So a PATH miss
 * falls back to the well-known install roots rather than giving up — a bare
 * `codex` that only resolves inside an interactive shell is precisely the
 * failure that made "sign in" do nothing.
 */
export function findCodexBinary(
  configured?: string,
  world: DiscoveryWorld = {},
): string | null {
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return configured;
  }
  const platform = world.platform ?? process.platform;
  const env = world.env ?? process.env;
  const names = platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex'];

  const rawPath = env['PATH'] ?? env['Path'] ?? '';
  const dirs = rawPath.length > 0 ? rawPath.split(path.delimiter) : [];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const hit = fileAt(path.resolve(dir, name));
      if (hit !== null) return hit;
    }
  }

  for (const dir of codexFallbackBinDirs(world)) {
    for (const name of names) {
      const hit = fileAt(path.join(dir, name));
      if (hit !== null) return hit;
    }
  }
  return null;
}

function fileAt(candidate: string): string | null {
  try {
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null; // ENOENT / EACCES / broken symlink
  }
}

/**
 * Install roots to try when PATH does not have it. Ordered by how likely the
 * hit is to be the one the user actually runs, and every entry is a directory
 * an official installer really writes to:
 *
 *   ~/.codex/bin        the CLI's own updater (`codex update`)
 *   nvm                 every installed node version, NEWEST FIRST — the
 *                       active one is usually the latest, and picking an old
 *                       version's stale copy would run a CLI the user has
 *                       already moved on from
 *   ~/.local/bin        pipx / manual installs
 *   /opt/homebrew/bin   homebrew on apple silicon
 *   /usr/local/bin      homebrew on intel, and npm's default global prefix
 *
 * On Windows the roots are `~/.codex/bin` again, then `%APPDATA%\npm` (npm's
 * global bin, where the `codex.cmd` shim lands) and WinGet's portable links.
 * nvm-windows keeps its versions under `%APPDATA%\nvm` but exposes the active
 * one through a symlink that IS on PATH, so it needs no entry here.
 *
 * Never throws: an unreadable root is one that contributes no candidates.
 * Exported, with the machine facts injectable, so the table is testable on
 * any OS.
 */
export function codexFallbackBinDirs(world: DiscoveryWorld = {}): string[] {
  const platform = world.platform ?? process.platform;
  const env = world.env ?? process.env;
  const home = world.home ?? os.homedir();
  const out: string[] = [path.join(home, '.codex', 'bin')];

  if (platform === 'win32') {
    const appData = env['APPDATA'];
    if (typeof appData === 'string' && appData !== '') out.push(path.join(appData, 'npm'));
    const local = env['LOCALAPPDATA'];
    if (typeof local === 'string' && local !== '') {
      out.push(path.join(local, 'Microsoft', 'WinGet', 'Links'));
    }
    return out;
  }

  const nvmRoot = path.join(home, '.nvm', 'versions', 'node');
  try {
    const versions = fs
      .readdirSync(nvmRoot)
      .filter((v) => v.startsWith('v'))
      // Newest first, numerically per component: a plain string sort puts
      // v9 above v24, which is the wrong copy of the CLI.
      .sort((a, b) => compareNodeVersions(b, a));
    for (const v of versions) out.push(path.join(nvmRoot, v, 'bin'));
  } catch {
    // No nvm here. Normal.
  }

  out.push(
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  );
  return out;
}

/** `v24.13.0` vs `v9.1.0`, compared component-wise so 24 outranks 9. */
function compareNodeVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// ------------------------------------------------------------ rollout heads

/** What one rollout file tells us about its session. Everything but the id is
 *  optional: the head is parsed defensively, and a rollout still being written
 *  when we read it is a normal state, not an error. */
export interface RolloutMeta {
  sessionId: string;
  path: string;
  /** `session_meta.payload.cwd` — the directory Codex recorded for the run. */
  cwd?: string;
  /** Epoch ms from the record's own ISO-Z timestamp; birthtime as a fallback.
   *  NEVER from the filename, whose clock is local (see ROLLOUT_RE). */
  startedAt?: number;
  /** File mtime — last activity, the same role `ArchivedSession.endedAt` has. */
  endedAt: number;
  bytes: number;
}

/**
 * How much of a rollout head to read. Larger than archive.ts's window on
 * purpose: a Codex `session_meta` line embeds `base_instructions.text`, the
 * entire system prompt, which measured over 20 KB on real files here. The
 * fields this module wants (`cwd`, the outer `timestamp`) sit in the first
 * ~250 bytes, well ahead of it — but the LINE does not end for tens of
 * kilobytes, which is exactly why the extraction below does not try to
 * JSON.parse it.
 */
const HEAD_MAX_BYTES = 32 * 1024;

/**
 * Pull a JSON string value out of a possibly-TRUNCATED JSON text.
 *
 * `JSON.parse` is not an option here and the reason is structural, not
 * defensive: the first line of a rollout is far longer than any head window
 * worth reading, so the text handed to this function is a valid JSON PREFIX
 * and never a valid JSON document. So the key is found literally and the
 * quoted value that follows it is scanned with escape awareness, then handed
 * to JSON.parse as a lone string — which is what unescapes `\\`, `\"` and
 * `\uXXXX` correctly instead of a regex pretending to.
 *
 * Returns undefined when the key is absent, or when its value runs past the
 * end of the window (a half-read path is not a path).
 */
export function extractJsonString(text: string, key: string): string | undefined {
  const needle = `"${key}":"`;
  const at = text.indexOf(needle);
  if (at < 0) return undefined;
  const start = at + needle.length - 1; // on the opening quote
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2; // skip the escaped char, whatever it is
      continue;
    }
    if (ch === '"') {
      try {
        const parsed: unknown = JSON.parse(text.slice(start, i + 1));
        return typeof parsed === 'string' && parsed !== '' ? parsed : undefined;
      } catch {
        return undefined;
      }
    }
    i++;
  }
  return undefined; // value never closed inside the window
}

/**
 * Read one rollout's facts. Bounded, never throws, returns null only when the
 * file is not a rollout at all or cannot be stat'ed.
 *
 * The id comes from the FILENAME rather than from `session_meta.payload
 * .session_id`, which also carries it. That is not laziness — it is the
 * cheaper and the more robust of the two: it costs no read, and it still
 * produces a correct id for a rollout whose head was truncated mid-write.
 */
export function readRolloutMeta(file: string): RolloutMeta | null {
  const sessionId = sessionIdOfRollout(path.basename(file));
  if (sessionId === null) return null;

  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;

  const out: RolloutMeta = {
    sessionId,
    path: file,
    endedAt: st.mtimeMs,
    bytes: st.size,
  };

  let head = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const want = Math.min(Math.max(st.size, 0), HEAD_MAX_BYTES);
      if (want > 0) {
        const buf = Buffer.alloc(want);
        const read = fs.readSync(fd, buf, 0, want, 0);
        head = buf.toString('utf-8', 0, read);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    head = '';
  }

  if (head !== '') {
    const cwd = extractJsonString(head, 'cwd');
    if (cwd !== undefined) out.cwd = cwd;
    const ts = extractJsonString(head, 'timestamp');
    if (ts !== undefined) {
      const parsed = Date.parse(ts);
      if (Number.isFinite(parsed)) out.startedAt = parsed;
    }
  }
  if (out.startedAt === undefined && Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0) {
    out.startedAt = st.birthtimeMs;
  }
  return out;
}

// ------------------------------------------------------------------- scan

export interface RolloutScanOptions {
  /** Roots to walk — one `<CODEX_HOME>/sessions` per account profile, plus the
   *  default. Duplicates are collapsed by resolved path. */
  sessionsDirs?: readonly string[];
  /** Ignore day directories older than this many days. Bounds a store that
   *  grows forever: a year of daily use is 365 directories, and the tree only
   *  ever shows a window of them. */
  maxAgeDays?: number;
  /** Hard cap on files returned, newest day first. */
  limit?: number;
}

const DEFAULT_MAX_AGE_DAYS = 90;
const DEFAULT_LIMIT = 2000;

/**
 * Every rollout in the given stores, newest DAY first.
 *
 * Bounded twice — by day-directory age before anything inside is touched, and
 * by a file count after — because this runs on the same cadence as the archive
 * scan and a Codex store is append-only forever. The age bound is what makes
 * it cheap: a day outside the window costs one string comparison, not a
 * readdir.
 *
 * Never throws. An unreadable root, year, month or day is skipped; the result
 * is a shorter list, never an exception and never a partial-failure flag,
 * because a caller who cannot act on "three of your day directories are
 * unreadable" is a caller who should not be handed it.
 */
export function scanRollouts(opts?: RolloutScanOptions): RolloutMeta[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const raw of opts?.sessionsDirs ?? [codexSessionsDir()]) {
    const dir = typeof raw === 'string' ? raw.trim() : '';
    if (dir === '') continue;
    const key = path.resolve(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(dir);
  }

  const maxAgeDays =
    typeof opts?.maxAgeDays === 'number' && Number.isFinite(opts.maxAgeDays)
      ? Math.max(0, opts.maxAgeDays)
      : DEFAULT_MAX_AGE_DAYS;
  const limit =
    typeof opts?.limit === 'number' && Number.isFinite(opts.limit)
      ? Math.max(0, opts.limit)
      : DEFAULT_LIMIT;
  // Compared as a STRING against the `YYYY/MM/DD` the tree is named with, so
  // the cutoff needs no date parsing per directory — lexical order on a
  // zero-padded date is chronological order.
  const cutoff = dayKeyOf(Date.now() - maxAgeDays * 86_400_000);

  const days: Array<{ key: string; dir: string }> = [];
  for (const root of roots) {
    for (const year of readdirSafe(root)) {
      if (!/^\d{4}$/.test(year)) continue;
      for (const month of readdirSafe(path.join(root, year))) {
        if (!/^\d{2}$/.test(month)) continue;
        for (const day of readdirSafe(path.join(root, year, month))) {
          if (!/^\d{2}$/.test(day)) continue;
          const key = `${year}-${month}-${day}`;
          if (key < cutoff) continue;
          days.push({ key, dir: path.join(root, year, month, day) });
        }
      }
    }
  }
  days.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));

  const out: RolloutMeta[] = [];
  const claimed = new Set<string>();
  for (const { dir } of days) {
    if (out.length >= limit) break;
    for (const file of readdirSafe(dir)) {
      if (out.length >= limit) break;
      if (sessionIdOfRollout(file) === null) continue;
      const meta = readRolloutMeta(path.join(dir, file));
      // One id, one row: the same session copied into two stores (a profile
      // that inherited a directory, say) must not produce two rows.
      if (meta === null || claimed.has(meta.sessionId)) continue;
      claimed.add(meta.sessionId);
      out.push(meta);
    }
  }
  return out;
}

function readdirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** `YYYY-MM-DD` in LOCAL time, matching how Codex names its day directories
 *  (verified: a session at 01:00 local sits under that local day, not the UTC
 *  one). Local is therefore correct here, and UTC would drop a day at every
 *  boundary for anyone east of Greenwich. */
function dayKeyOf(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ------------------------------------------------------------- id discovery

export interface MatchRolloutOptions {
  /** The directory the launch was started in. */
  cwd?: string;
  /** Epoch ms just BEFORE the spawn. Nothing older can be this launch. */
  spawnedAt: number;
  /** Ids already owned by another row. A rollout carrying one of these is
   *  somebody else's conversation, however well it matches. */
  taken?: ReadonlySet<string>;
  /** How far past `spawnedAt` to keep believing a match. Beyond it the launch
   *  is assumed to have failed (a bad flag, a missing login), and claiming
   *  whatever rollout turns up next would bind the row to an unrelated
   *  session the user started by hand. */
  windowMs?: number;
}

/** Default belief window for a match. Generous next to a CLI that opens its
 *  rollout within a second of starting, because the cost of being slow is one
 *  late bind and the cost of being hasty is the wrong conversation. */
export const DEFAULT_MATCH_WINDOW_MS = 60_000;

/**
 * Pick the rollout a just-spawned Codex launch produced, or null.
 *
 * THE INFERENCE, stated as narrowly as it is implemented. A candidate must:
 *
 *   1. not already be claimed by another row (`taken`);
 *   2. have started at or after the spawn, less a small skew allowance —
 *      Codex stamps the header from its own clock and writes it a beat after
 *      exec, so an exact `>=` against our pre-spawn reading would reject the
 *      very file we are looking for;
 *   3. have started inside the belief window;
 *   4. name the SAME directory, compared after normalisation — trailing
 *      slashes and `/tmp` vs `/private/tmp` are the same place, and a launch
 *      whose cwd we never knew skips this clause rather than matching
 *      everything.
 *
 * Among survivors the EARLIEST start wins, not the latest. That is deliberate:
 * the launch we are matching happened first, so if a second Codex session
 * appeared in the same directory while we were still waiting, the older file
 * is ours and the newer one belongs to whoever started it.
 *
 * Returns null on no match, which the caller must read as "not yet" and retry,
 * never as "this launch has no session".
 */
export function matchRollout(
  candidates: readonly RolloutMeta[],
  opts: MatchRolloutOptions,
): RolloutMeta | null {
  const spawnedAt =
    typeof opts?.spawnedAt === 'number' && Number.isFinite(opts.spawnedAt)
      ? opts.spawnedAt
      : 0;
  const windowMs =
    typeof opts?.windowMs === 'number' && Number.isFinite(opts.windowMs)
      ? opts.windowMs
      : DEFAULT_MATCH_WINDOW_MS;
  const taken = opts?.taken ?? new Set<string>();
  const wantCwd = normalizeDir(opts?.cwd);

  // Clocks: ours reads `spawnedAt` before exec, Codex stamps the header from
  // its own. A second of slack costs nothing and buys immunity to both the
  // ordering and to a filesystem timestamp rounded down.
  const floor = spawnedAt - 1000;
  const ceiling = spawnedAt + windowMs;

  let best: RolloutMeta | null = null;
  for (const meta of candidates ?? []) {
    if (!meta || !isSessionId(meta.sessionId)) continue;
    if (taken.has(meta.sessionId)) continue;
    const startedAt = meta.startedAt;
    if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) continue;
    if (startedAt < floor || startedAt > ceiling) continue;
    if (wantCwd !== undefined) {
      const got = normalizeDir(meta.cwd);
      if (got === undefined || got !== wantCwd) continue;
    }
    if (best === null || startedAt < (best.startedAt ?? Infinity)) best = meta;
  }
  if (best !== null) {
    log(`codex: matched rollout ${best.sessionId} for a launch in ${wantCwd ?? '(no cwd)'}`);
  }
  return best;
}

/**
 * A directory in the one spelling every comparison in this module uses:
 * symlinks resolved where the filesystem will say, backslashes folded to
 * forward ones, trailing separators dropped.
 *
 * The realpath call is what makes `/tmp` and `/private/tmp` compare equal on
 * macOS — the single most likely way a correct match would otherwise be
 * rejected, since VS Code hands terminals whichever spelling the workspace
 * folder was opened under. A path that cannot be resolved (it has since been
 * removed) falls back to the lexical form rather than dropping out: the
 * comparison is still meaningful when BOTH sides fail the same way.
 */
function normalizeDir(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  let resolved = trimmed;
  try {
    resolved = fs.realpathSync(trimmed);
  } catch {
    // Gone, or never existed. Keep the lexical form.
  }
  const slashed = resolved.replace(/\\/g, '/').replace(/\/+$/, '');
  return slashed === '' ? '/' : slashed;
}
