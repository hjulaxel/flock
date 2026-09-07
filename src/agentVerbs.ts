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
// PROVENANCE: a request must carry a secret from the session it names. The
// requests directory is writable by anything running as this user, and the
// names it could put in a request are public — `claude agents --json` lists
// them. So until v5 a sub-agent, an MCP server or one talked-into Bash step
// could name ANOTHER conversation, ask for eight forks and write the opening
// prompt those forks would execute, quietly (the verb forks with quiet:true).
// A count cap is not a defence against that; the count was never the problem.
//
// The proof is a per-launch secret, minted and stamped by terminals.ts and
// remembered here — see the LAUNCH TOKEN section below for why it lives in
// memory only, why that means only the window that LAUNCHED a session can
// honour its verb, and why it is keyed on the launch id rather than the row's.
//
// WHAT THE TOKEN DOES NOT DO, stated here because the temptation is to read it
// as more. It stops any process that cannot READ THE NAMED SESSION'S
// ENVIRONMENT — which is the whole "name any uuid you can list" attack, and
// worth having. It is NOT a defence against a process running AS YOU that can
// read it, and on a normal machine several routes can:
//
//   * `ps eww -p <pid>` prints a same-user process's full environment on macOS
//     and Linux, so `ps eww -A | grep LINEAGE_VERB_TOKEN` yields every live
//     session's node id and its token together, with no race.
//   * a WRAPPED launch renders `-e LINEAGE_VERB_TOKEN=<hex>` into the tmux
//     CLIENT's argv (terminals.ts → tmux.buildSpawnArgs), which `ps` shows and
//     /proc/<pid>/cmdline exposes world-readably on Linux. Unavoidable while
//     the secret has to be in the CLI's environment BEFORE tmux spawns it:
//     `-e` is what does that, a later `set-environment` is too late for a
//     process already running, and every other route puts the secret in
//     another argv or in a file — and a file is the one thing the memory-only
//     rule below exists to forbid.
//   * it is in the tmux SESSION environment, so
//     `tmux -L <socket> show-environment -t =lineage-<uuid>` reads it back over
//     a same-user socket.
//   * the request file itself sits in a 0700 directory for the milliseconds
//     before a window claims it — private to this user, and this user is the
//     attacker in question.
//
// So a sub-agent, an MCP server or a talked-into Bash step running inside ANY
// Flock session can still forge a request naming any OTHER Flock session. What
// v5 removed is the ability to do it without reading another process's
// environment first, which is a real narrowing and not a closure. Closing it
// would take provenance the OS attests — a unix socket with peer credentials
// plus a pid → launched-session ancestry check — or human confirmation of a
// model-initiated fork that carries a prompt, the doctrine this codebase
// applies everywhere else. Neither is built, and nothing in the UI, the
// consent modal or the CLI's own text may claim otherwise.
//
// Nothing here is required for anything: with the verbs never installed (the
// default), no file exists, no watcher runs, and the extension is exactly what
// it was. Version-proofing follows hooks.ts to the letter — what persists into
// user-visible locations references only `$HOME`-relative paths we own, never
// an extension install path.

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as process from 'node:process';

import { ENV_NODE_ID, isSessionId, shortId } from './types';
import type { DisposableLike, HookInstallState } from './types';
import { log, logError } from './log';

// --------------------------------------------------------------- constants

export const VERBS_SKILL_NAME = 'flock';
/** Bumped whenever the generated files change; drives silent self-heal, the
 *  same contract as hooks.PLUGIN_VERSION.
 *  v2: `--name` — the model can title each fork from the user's own words.
 *  v3: the skill names the CLI by its ABSOLUTE path instead of `~/…`. A tilde
 *  is the shell's to expand, and only some shells do: Git Bash and every POSIX
 *  shell yes, PowerShell and cmd.exe — the shells Claude Code runs the Bash
 *  tool through on a Windows without Git — no. The rendered path is the one
 *  the extension itself wrote the script to, so it is right by construction,
 *  and it is what lets the install run on Windows at all.
 *  v4: the CLI creates `~/.lineage/requests` 0700 and each request file
 *  0600. A request carries the `--prompt` — the opening message for every
 *  fork, i.e. the user's own words — and v3 left it world-readable for the
 *  seconds it sat on disk. Same reason hooks.PLUGIN_VERSION went to v5.
 *  v5: the CLI reads ENV_VERB_TOKEN out of its own environment and puts it in
 *  the request, which is now `v: 2` — the wire version moves with it, so a
 *  request from a pre-v5 CLI is refused as the OLD protocol instead of as a
 *  forgery. See the LAUNCH TOKEN section: without this a request could name
 *  any session on the machine.
 *  v6: TEXT ONLY — the no-stamp refusal said "Flock did not launch this
 *  session", which is false for the three commonest ways a session loses its
 *  stamp (it was running when the extension updated, it was revived after an
 *  app restart, or another window re-attached it) and buried the remedy
 *  mid-sentence. The model relays that sentence to the user as fact, so it
 *  has to be one. */
export const VERBS_VERSION = 6;

const SCRIPT_BASENAME = 'flock-verbs.mjs';
const REQUESTS_DIR_BASENAME = 'requests';

/** The most forks one request may ask for. "Do three forks here" is the use
 *  case; eight is already a wall of terminal tabs, and a runaway loop in a
 *  model should hit a wall, not a fleet. Enforced in the CLI AND here — the
 *  request file is writable by anything on the machine, which is also why the
 *  request has to carry the launch token below: a cap only bounds the damage
 *  a forged request can do, it does not stop one. */
export const MAX_AGENT_FORKS = 8;
/** An opening prompt longer than this is refused rather than truncated —
 *  silently cutting a prompt changes what the fork does. */
export const MAX_AGENT_PROMPT_CHARS = 4000;
/** The protocol bound on one fork NAME. Deliberately looser than the 80
 *  characters a row displays: a name is cosmetic, so an overlong one is
 *  TRUNCATED downstream (nextFreeName, the same treatment every generated
 *  title gets) rather than refused — only something file-abuse-sized is. */
export const MAX_AGENT_TITLE_CHARS = 200;
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
/** How long a window waits before refusing a request on TOKEN MISMATCH.
 *
 *  Strictly longer than any claim delay, and that is the whole point. Every
 *  other error verdict (too large, expired, malformed) is one every window
 *  reaches identically, so arming it at the claim delay is harmless. A
 *  mismatch is window-DEPENDENT: after a park and restore by a second window,
 *  that window minted its own token for the session while the running process
 *  still holds the launching window's — so it holds the WRONG token and would
 *  arm a refusal at exactly the delay the window with the RIGHT token uses.
 *  The refusal renames and deletes the file, so winning that race turns a
 *  genuine self-fork into an intermittent accusation. Three claim delays is
 *  far longer than the rename any real claimant needs and far inside the CLI's
 *  own 30 s wait, so a mismatch still gets an answer rather than a timeout. */
const REFUSAL_DELAY_MS = CLAIM_DELAY_MS * 3;
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

// -------------------------------------------------------------- launch token
//
// The one thing that makes a request more than a wish: a secret only the
// named session's own processes can read.
//
// terminals.ts mints one per launch and stamps it into that session's
// environment beside ENV_NODE_ID — so the CLI (and a sub-agent, and any Bash
// step, all of which inherit it) can read it. The extension then accepts a
// request only if the token in it is the one stamped for the session the
// request names.
//
// That makes a request unforgeable by anything that cannot read the named
// session's environment. It does NOT make it unforgeable by a process running
// as you that can — `ps eww` prints another process's environment to its own
// user — and the PROVENANCE note in the header lists every copy of the secret
// and what it would take to close that. The rules below are what keep the
// narrowing worth having; they are not what would make the claim bigger.
//
// IN MEMORY, AND ONLY IN MEMORY. This table must never be written to disk,
// the store, or a log line. A session's Bash tool runs as the user with the
// user's read permissions: any file the extension can read to verify a token,
// that session can read to forge every other session's token — which would
// hand back exactly the hole this closes. The window's heap is the one place
// a session cannot reach. Two consequences, both deliberate:
//
//   * Only the window that LAUNCHED a session holds its token, so only that
//     window can honour the verb for it. A window that holds no token for the
//     named session does not claim the request at all (scan()) — it may well
//     belong to another window, and the sibling that launched it claims it
//     first anyway (it hosts the terminal, so its delay is zero).
//   * A session Flock did NOT launch has no token and therefore no verb.
//     That is a removal: v4 accepted a request from any session that could
//     name itself, including through CLAUDE_SESSION_ID or the tmux session
//     name. Those two say which session is asking; neither says that the
//     ASKER is that session, and forking somebody else's conversation with a
//     prompt of your choosing is not a mistake worth leaving open for the
//     convenience of a terminal Flock did not start. The CLI says so plainly
//     rather than timing out (renderVerbScript), and the fix is to relaunch
//     the session from the sidebar.
//
// KEYED ON THE LAUNCH ID, which is what makes it survive the generation
// chain. The row's id changes — a plain resume, `/clear` or a compaction
// re-mints it and terminals.rebind() moves the binding onto the new
// generation id — but the environment stamp inside the running process never
// does, and the CLI reports what it reads there. So the key is the stamped
// launch id on both sides, and a re-keyed session keeps its verb. (The
// window-reload path keeps it too: creationOptions.env comes back with the
// terminal, so terminals.bind() re-learns the token from the same place it
// re-learns the node id, and nothing has to be persisted.)

/** The environment variable the stamp lands in. Lives here, next to the two
 *  functions that mint and check it and the CLI text that reads it, rather
 *  than in types.ts beside ENV_NODE_ID: the node id is what the whole
 *  extension keys on, this is one channel's private proof, and the fewer
 *  modules that can name it the better. */
export const ENV_VERB_TOKEN = 'LINEAGE_VERB_TOKEN';

/** 32 bytes, hex. Long enough that guessing is not a strategy, and hex so it
 *  survives an `-e KEY=VALUE` tmux flag, a JSON string and a Windows
 *  environment block without any quoting question. Lower case only, and no
 *  `i` flag: the token is compared byte for byte, so there is no case to
 *  fold — and the CLI's own copy of this pattern is RENDERED from this
 *  constant, so the two ends cannot drift apart. */
const VERB_TOKEN_BYTES = 32;
const VERB_TOKEN_RE = /^[0-9a-f]{64}$/;

/** launch id (the ENV_NODE_ID stamp) → the secret stamped beside it.
 *
 *  Module scope, not a field on the registry or the manager, for two reasons:
 *  one extension host is one window, so a module-level table already has
 *  exactly the lifetime and the privacy of "this window"; and the two sides
 *  (terminals.ts stamps, the watcher below checks) must be looking at ONE
 *  table — an injected lookup would be a seam a wiring could forget to
 *  connect, and a guard that a missing wire turns off is not a guard. */
const launchTokens = new Map<string, string>();

/** The token for `sessionId`, minted on first ask.
 *
 *  Idempotent, because the launch verb is not: the workspace restore path
 *  re-runs it to RE-ATTACH a session that is still alive in tmux, and that
 *  process already holds the token it was created with (tmux's `-e` sets the
 *  environment of a session it creates; there is nothing to set when `-A`
 *  attaches to one that exists). Handing back the same token keeps the verb
 *  working across a park and restore in this window. */
export function ensureVerbToken(sessionId: string): string {
  const held = launchTokens.get(sessionId);
  if (held !== undefined) return held;
  const token = randomBytes(VERB_TOKEN_BYTES).toString('hex');
  launchTokens.set(sessionId, token);
  return token;
}

/** Re-learn a token a window ALREADY stamped, from the place a revived
 *  terminal keeps it (creationOptions.env). Ignores anything that is not a
 *  token and never overwrites one we hold: the live process's secret is the
 *  fact, and a second source of truth for it is how a session would lose its
 *  verb halfway through a reload. */
export function adoptVerbToken(
  sessionId: string | null | undefined,
  token: unknown,
): void {
  if (typeof sessionId !== 'string' || !isSessionId(sessionId)) return;
  if (!isVerbToken(token)) return;
  if (launchTokens.has(sessionId)) return;
  launchTokens.set(sessionId, token);
}

/** Shape only — says nothing about whether it is the RIGHT token. */
function isVerbToken(raw: unknown): raw is string {
  return typeof raw === 'string' && VERB_TOKEN_RE.test(raw);
}

/**
 * What this window can say about a request's token.
 *
 *   'ok'       — it is the token stamped for that session here: run the verb.
 *   'mismatch' — this window stamped a DIFFERENT token for that session, so
 *                the request did not come from it. Refuse, with a reply, so
 *                the asker gets an answer instead of a timeout.
 *   'unknown'  — this window never launched that session. Say nothing and
 *                claim nothing: another window may hold the token.
 *
 * A plain `===`. The comparison leaks one bit per request — "was that the
 * token" — which is the same bit the reply carries anyway, and there is no
 * per-byte feedback to walk towards a 256-bit secret. `timingSafeEqual`
 * would also throw on the unequal lengths a forged request can hand us,
 * turning a refusal into a logged exception.
 */
export type TokenVerdict = 'ok' | 'mismatch' | 'unknown';

export function verbTokenVerdict(
  sessionId: string,
  token: unknown,
): TokenVerdict {
  const held = launchTokens.get(sessionId);
  if (held === undefined) return 'unknown';
  return isVerbToken(token) && token === held ? 'ok' : 'mismatch';
}

// ------------------------------------------------------------ file contents
//
// Both files are rendered from constants so install, verify and self-heal all
// compare against one source of truth, exactly as hooks.ts renders its two
// plugin files. The scripts avoid backticks and `${` on purpose: they live
// inside TypeScript template literals.

/**
 * The skill Claude reads. The description is the retrieval surface — it has
 * to contain the words a user actually says.
 *
 * `scriptPath` is where THIS install put the CLI (`verbsScriptPath`), spelled
 * absolutely and double-quoted in the invocation, which is the one quoting
 * bash, PowerShell and cmd.exe all agree on for a path with a space in it.
 * Never `~`: see VERBS_VERSION v3.
 */
export function renderSkillMd(scriptPath: string): string {
  const invoke = `node "${scriptPath}" fork`;
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
    `    ${invoke} --count <n>`,
    '',
    '- `--count <n>` — how many forks, 1 to 8. Omit it for one.',
    '- `--name "<title>"` — a name for a fork, repeatable: give one per fork,',
    '  in order. With names given, `--count` may be omitted (it becomes the',
    '  number of names).',
    '- `--prompt "<text>"` — optional opening message sent to every fork.',
    '',
    'The command waits up to 30 seconds for a Flock window to answer, then',
    'prints the outcome. Report that outcome to the user — it names the new',
    'branches, or says exactly why nothing was forked.',
    '',
    'Naming the forks:',
    '',
    '- When the user says what each fork is FOR — "one to try the redis',
    '  cache, one for the SQL approach" — pass a short `--name` per fork in',
    '  their own words: `--name "redis cache" --name "SQL approach"`.',
    '- When the request implies a single purpose ("fork this to try X"),',
    '  name that one fork after the purpose.',
    '- When the user just wants copies ("do three forks"), pass no names —',
    '  Flock numbers them after this session, which is what they expect.',
    '- Keep names short, like branch names: 2-5 words, no punctuation needed.',
    '',
    'Notes:',
    '',
    '- "fork this session", "do three forks here", "branch off a copy" all',
    '  mean this verb. Parse the count from the request; default to 1.',
    '- Each fork opens as a terminal tab in VS Code holding a full copy of',
    '  this conversation. This session itself is never modified.',
    '- The verb only works in a session Flock itself launched: the command',
    '  proves which session it is with a secret Flock put in the environment',
    "  of that session. Anywhere else it exits saying so — report that, don't",
    '  work around it.',
    '',
    '<!-- Written by the Flock VS Code extension (in-session verbs v' +
      String(VERBS_VERSION) +
      '). Remove with "Flock: Remove In-Session Verbs". -->',
    '',
  ].join('\n');
}

/** The CLI the skill invokes. Plain node, no dependencies, top-level await.
 *
 *  Identity and PROOF come from the same place, and there is only one place:
 *  the LINEAGE_NODE_ID stamp our terminals launch with (types.ENV_NODE_ID)
 *  and the ENV_VERB_TOKEN stamped beside it. v4 also accepted
 *  CLAUDE_SESSION_ID and the `lineage-<uuid>` tmux session name (tmux.ts) —
 *  both say which session is asking, neither says the asker IS that session,
 *  and a request with no token is refused by every window now. So they are
 *  gone: dying here with the reason beats writing a request that cannot be
 *  honoured and waiting 30 seconds to be told so. */
export function renderVerbScript(): string {
  return [
    '#!/usr/bin/env node',
    '// ~/.lineage/flock-verbs.mjs — written by the Flock VS Code extension',
    '// (in-session verbs v' + String(VERBS_VERSION) + '). A Claude Code session runs this to ask',
    '// Flock for a verb:',
    '//',
    '//   node ~/.lineage/flock-verbs.mjs fork [--count N] [--name "..."]... [--prompt "..."]',
    '//',
    '// The request lands in ~/.lineage/requests/, one Flock window claims it,',
    '// runs the same fork the sidebar button runs, and replies here.',
    '//',
    '// The request carries the launch token this session was started with, and',
    '// only the window that started the session knows it — so a request can',
    '// only ever fork the session it was written from.',
    "import { randomUUID } from 'node:crypto';",
    "import * as fs from 'node:fs';",
    "import * as os from 'node:os';",
    "import * as path from 'node:path';",
    '',
    "const DIR = path.join(os.homedir(), '.lineage', 'requests');",
    'const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;',
    'const TOKEN = ' + String(VERB_TOKEN_RE) + ';',
    'const WAIT_MS = 30000;',
    'const POLL_MS = 250;',
    '',
    'function die(msg) { console.error(msg); process.exit(1); }',
    '',
    '// Who this session is, and the proof — one environment stamp, both halves',
    '// or neither. The token is never printed: not here, not in an error.',
    'function launchProof() {',
    '  const env = process.env;',
    '  const node = env.' + ENV_NODE_ID + " || '';",
    '  const token = env.' + ENV_VERB_TOKEN + " || '';",
    '  if (!UUID.test(node) || !TOKEN.test(token)) return null;',
    '  return { node, token };',
    '}',
    '',
    'const argv = process.argv.slice(2);',
    "if (argv[0] !== 'fork') {",
    '  die(\'usage: flock-verbs.mjs fork [--count N] [--name "..."]... [--prompt "..."]\');',
    '}',
    'let count;',
    'let prompt;',
    'const names = [];',
    'for (let i = 1; i < argv.length; i++) {',
    '  const a = argv[i];',
    "  if (a === '--count') count = Number(argv[++i]);",
    "  else if (a === '--prompt') prompt = argv[++i];",
    "  else if (a === '--name') names.push(argv[++i]);",
    '  else if (/^--count=/.test(a)) count = Number(a.slice(8));',
    '  else if (/^--prompt=/.test(a)) prompt = a.slice(9);',
    '  else if (/^--name=/.test(a)) names.push(a.slice(7));',
    "  else die('unknown argument: ' + a);",
    '}',
    '// Names imply the count; both given, they have to agree — a third fork',
    '// wearing a name meant for nobody is worse than an error here.',
    'if (names.length > 0 && count === undefined) count = names.length;',
    'if (count === undefined) count = 1;',
    'if (names.length > 0 && names.length !== count) {',
    "  die('give one --name per fork (' + count + '), or none.');",
    '}',
    'for (const name of names) {',
    "  if (typeof name !== 'string' || name.trim() === '') {",
    "    die('--name needs a non-empty title.');",
    '  }',
    '  if (name.length > ' + String(MAX_AGENT_TITLE_CHARS) + ') {',
    "    die('a --name is longer than " + String(MAX_AGENT_TITLE_CHARS) + " characters.');",
    '  }',
    '}',
    'if (!Number.isInteger(count) || count < 1 || count > ' + String(MAX_AGENT_FORKS) + ') {',
    "  die('--count must be a whole number from 1 to " + String(MAX_AGENT_FORKS) + ".');",
    '}',
    "if (typeof prompt === 'string' && prompt.length > " + String(MAX_AGENT_PROMPT_CHARS) + ') {',
    "  die('--prompt is longer than " + String(MAX_AGENT_PROMPT_CHARS) + " characters.');",
    '}',
    'const proof = launchProof();',
    'if (!proof) {',
    "  die('This session carries no Flock launch stamp, so Flock cannot ' +",
    "    'prove the request came from it. Sessions started before Flock was ' +",
    "    'updated, revived after a restart, or re-attached in another window ' +",
    "    'need to be relaunched from the Flock sidebar to use this verb. ' +",
    "    'Tell the user that; there is nothing to work around.');",
    '}',
    '',
    '// The request carries the prompt AND the launch token, so the directory',
    '// is 0700 and the file 0600 — readable by this user alone (v4). Modes are',
    "// creation-only and ignored on Windows, where the profile folder's ACL",
    '// already does this. The file is short-lived either way: a window claims',
    '// it in milliseconds, and an unanswered one is withdrawn below.',
    'fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });',
    'const id = randomUUID();',
    "const reqFile = path.join(DIR, id + '.json');",
    "const replyFile = path.join(DIR, id + '.reply.json');",
    'const body = {',
    '  v: 2,',
    "  verb: 'fork',",
    '  node: proof.node,',
    '  token: proof.token,',
    '  count,',
    '};',
    "if (typeof prompt === 'string' && prompt.length > 0) body.prompt = prompt;",
    'if (names.length > 0) body.titles = names.map((n) => n.trim());',
    "const tmp = path.join(DIR, '.' + id + '.tmp');",
    "fs.writeFileSync(tmp, JSON.stringify(body) + '\\n', { mode: 0o600 });",
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

/** One validated fork request, as the executor receives it. */
export interface AgentForkRequest {
  node: string;
  count: number;
  prompt?: string;
  /** One title per fork, in order, from the model — derived from the user's
   *  own words ("one for auth, one for search"). Absent, the forks get the
   *  numbered defaults the sidebar button generates. */
  titles?: string[];
}

/** `count` is already clamped; anything the validator could not accept is an
 *  `{ error }` instead — the caller still claims the file and REPLIES with
 *  the error, so the CLI never times out on a request the extension actually
 *  saw.
 *
 *  `token` rides HERE and not on AgentForkRequest: AgentForkRequest is what
 *  crosses into the command wiring, and the thing that runs the fork has no
 *  business holding the secret that authorised it. */
export type ParsedRequest =
  | ({ verb: 'fork'; token: string } & AgentForkRequest)
  | { error: string };

/** The wire version this build speaks. v1 is a pre-v5 CLI, which cannot have
 *  carried a token — refused by version, so "no token" means exactly one
 *  thing: a request somebody wrote by hand. */
const REQUEST_WIRE_VERSION = 2;

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
  if (body['v'] !== REQUEST_WIRE_VERSION) {
    return { error: 'unknown request version' };
  }
  if (body['verb'] !== 'fork') {
    return { error: `unknown verb ${JSON.stringify(body['verb'])}` };
  }
  const node = body['node'];
  if (!isSessionId(node)) return { error: 'the request names no session' };
  // The proof, checked for SHAPE here and for VALUE by the watcher, which is
  // the only place that knows what this window stamped. Absent is refused
  // outright rather than passed on as "unknown session": nothing on the
  // machine can honour a request with no token, so answering it here saves
  // the asker a 30-second wait.
  const token = body['token'];
  if (!isVerbToken(token)) {
    return {
      error:
        'the request carries no launch token — only a session Flock started ' +
        'can ask Flock to fork it',
    };
  }
  const count = clampForkCount(body['count']);

  const out: { verb: 'fork'; token: string } & AgentForkRequest = {
    verb: 'fork',
    token,
    node,
    count,
  };

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
    out.prompt = prompt;
  }

  const titles = body['titles'];
  if (titles !== undefined) {
    if (!Array.isArray(titles) || titles.length === 0) {
      return { error: 'titles is not a list of names' };
    }
    // One per fork, exactly — the CLI enforces the same, so a mismatch here
    // is a hand-written request, and a fork wearing a name meant for a
    // different one is worse than the refusal.
    if (titles.length !== count) {
      return { error: `one name per fork (${count}), or none` };
    }
    const clean: string[] = [];
    for (const raw of titles) {
      if (typeof raw !== 'string' || raw.trim() === '') {
        return { error: 'a fork name is not a non-empty string' };
      }
      if (raw.length > MAX_AGENT_TITLE_CHARS) {
        return {
          error: `a fork name is longer than ${MAX_AGENT_TITLE_CHARS} characters`,
        };
      }
      clean.push(raw.trim());
    }
    out.titles = clean;
  }
  return out;
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
  runFork(request: AgentForkRequest): Promise<AgentForkOutcome>;
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
  /** Derived from `claimDelayMs`, never injected separately: the ONE property
   *  that matters is that it is longer than any window's claim delay, and two
   *  independent knobs are how a test would silently stop testing that. */
  private readonly refusalDelayMs: number;
  private readonly fallbackMs: number;
  private readonly requestTtlMs: number;

  private executor: VerbExecutor | null = null;
  private dirWatcher: fs.FSWatcher | null = null;
  private fallbackTimer: NodeJS.Timeout | null = null;
  /** request id → the pending claim timer, so a second watch event for the
   *  same file cannot arm a second claim. */
  private readonly inFlight = new Map<string, NodeJS.Timeout>();
  /** Requests this window decided not to claim (no launch token for the
   *  session they name). They are NOT in flight — another window's to run —
   *  so they sit in the directory until that window claims them or the CLI
   *  withdraws them, and every fallback tick would re-log the same line. Held
   *  as ids and pruned against the directory in `scan`, so the set cannot
   *  outgrow what is actually on disk. */
  private readonly leftAlone = new Set<string>();
  private disposed = false;
  private watchErrorLogged = false;

  constructor(deps: VerbsDeps, home?: string, timing?: VerbsTiming) {
    this.deps = deps;
    this.home = homeDir(home);
    this.claimDelayMs = timing?.claimDelayMs ?? CLAIM_DELAY_MS;
    this.refusalDelayMs =
      timing?.claimDelayMs === undefined
        ? REFUSAL_DELAY_MS
        : timing.claimDelayMs * 3;
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
    this.leftAlone.clear();
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
      { path: this.skillPath(), text: renderSkillMd(this.scriptFile()), label: 'skill' },
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
      'A request has to carry a secret Flock puts in the named session\'s own',
      'environment at launch, so nothing that cannot read that environment can',
      'ask for a fork of a conversation it is not. A program already running as',
      'you can read it, so this narrows the channel rather than sealing it.',
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

  /** mkdir -p `~/.lineage/requests`, 0700, and tighten it if it already
   *  exists looser. Request files hold the fork prompt — the user's words —
   *  and the CLI (v4) creates both directory and file private; a directory a
   *  v3 CLI created is 0755 until this chmods it. The chmod is best effort:
   *  it must never stop the watcher, so a failure is logged and ignored (and
   *  skipped outright on Windows, where NTFS has ACLs, not mode bits). */
  private ensureRequestsDir(): void {
    const dir = this.requestsPath();
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      logError('verbs: create requests directory', err);
      return;
    }
    if (process.platform === 'win32') return;
    try {
      if ((fs.statSync(dir).mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
    } catch (err) {
      logError('verbs: restrict requests directory', err);
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
    const present = new Set<string>();
    for (const entry of entries) {
      const m = REQUEST_RE.exec(entry);
      if (!m) continue;
      const id = m[1].toLowerCase();
      present.add(id);
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

      // PROVENANCE, before anything else is decided about the request. The
      // token is the only thing here that a process outside the named session
      // cannot produce; the id in the request is a claim, and count, prompt
      // and titles are all instructions from whoever wrote the file.
      const verdict = verbTokenVerdict(parsed.node, parsed.token);
      if (verdict === 'unknown') {
        // Not a session this window launched, so this window cannot tell a
        // real request from a forged one. Claim nothing — the window that
        // launched it holds the token and claims first (it hosts the
        // terminal, so its delay is zero). If no window does, the CLI
        // withdraws the request after its 30 s and says nobody answered,
        // which is the truth.
        //
        // Said ONCE per request: the file stays put, so every fallback tick
        // sees it again, and a line every two seconds for half a minute is
        // noise in a channel somebody reads to diagnose the opposite problem.
        if (!this.leftAlone.has(id)) {
          this.leftAlone.add(id);
          log(
            'verbs: no launch token here for',
            shortId(parsed.node),
            '— leaving the request to the window that launched it',
          );
        }
        continue;
      }
      if (verdict === 'mismatch') {
        // Positive evidence that the token is not OURS — which is not the same
        // as positive evidence that it is nobody's. The benign and commonest
        // cause is a session re-attached by another window: a tmux attach
        // cannot be re-stamped, so the running process keeps the token of
        // whoever created it while THIS window minted a second one on the
        // attach launch. That makes the verdict window-dependent, so the
        // refusal is armed at REFUSAL_DELAY_MS — long enough that a window
        // holding the real token always wins the rename — while the log line
        // stays immediate. The token itself is never written to the log.
        log(
          'verbs: a fork request for',
          shortId(parsed.node),
          'does not carry the token stamped here — refusing it unless another',
          'window claims it first',
        );
        this.armClaim(id, file, this.refusalDelayMs, {
          error:
            "this session's terminal was re-attached by another Flock window " +
            'since it launched, so this window cannot vouch for it — relaunch ' +
            'it from the Flock sidebar to use the verb',
        });
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

    // A request we left alone is gone — claimed elsewhere or withdrawn — so
    // forget it; the set tracks the directory and nothing more.
    for (const id of this.leftAlone) {
      if (!present.has(id)) this.leftAlone.delete(id);
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
          parsed.titles !== undefined ? '(named)' : '',
          parsed.prompt !== undefined ? '(with prompt)' : '',
        );
        // The token stops here: it has done its job (scan() checked it), and
        // the executor — forkForAgent, i.e. the whole command wiring — has no
        // reason to hold a secret.
        const { verb: _verb, token: _token, ...request } = parsed;
        outcome = await executor.runFork(request);
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
  return fallbackHome(process.env, process.platform);
}

/** The env fallback for a home directory, reached only when os.homedir()
 *  itself fails. Platform-explicit because HOME is a POSIX idea: os.homedir()
 *  on Windows reads USERPROFILE and never HOME, so USERPROFILE is the variable
 *  that names the SAME directory a window resolved — while HOME on Windows is
 *  Git Bash's own invention, a POSIX-shaped path that can point somewhere else
 *  entirely. A CLI and a window that disagree about home disagree about the
 *  requests directory, and then nothing is ever claimed. HOMEDRIVE + HOMEPATH
 *  is the older pair Windows still sets when USERPROFILE is missing. The
 *  platform is a parameter, not `process.platform`, so both branches run on
 *  every machine in the CI matrix. */
export function fallbackHome(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  if (platform === 'win32') {
    const profile = env['USERPROFILE'];
    if (profile) return profile;
    const drive = env['HOMEDRIVE'];
    const rest = env['HOMEPATH'];
    if (drive && rest) return path.win32.join(drive, rest);
    return '.';
  }
  return env['HOME'] || '.';
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
