#!/usr/bin/env node
// prototype/flock/flock.mjs — the flock mechanism, standing on its own.
//
// A flock is two or three LONG-LIVED sessions working different areas of one
// problem — frontend and backend, or two paradigms — that stay aware of each
// other without merging. It is not a workflow: nothing fans in, nothing is
// harvested, and every member is a session you type into.
//
// Three parts, and only three:
//
//   THE CHARTER   Each lane is told, once, what the other lanes are doing.
//                 Injected at SessionStart. This is what stops two lanes
//                 doing the same work, and it costs one paragraph.
//
//   THE BOARD     An append-only ledger of CROSSINGS — decisions and
//                 constraints that change what another lane may assume.
//                 Addressed, never broadcast. Delivered to a lane at its
//                 next prompt boundary, which is the moment it is both
//                 actionable and observed.
//
//   THE APPROVAL  A crossing is PROPOSED by a session and PUBLISHED by the
//                 human, never the other way round. This is enforced, not
//                 requested: the PreToolUse hook refuses `flock ok` when it
//                 arrives as a tool call, so the model physically cannot
//                 approve its own proposal. Typed by a human in a terminal
//                 it goes through, because that is not a tool call.
//
// The scarcity rules below are the whole ballgame. A board nobody reads is
// worse than no board, because then the lanes BELIEVE they are coordinated.
// So: one sentence, addressed to one lane, four kinds, hard caps. Every
// refusal in this file exists to keep the ledger short enough to read.
//
// No dependencies, node builtins only. Every hook path is wrapped so that a
// broken flock can never break a session: hooks exit 0 and print nothing when
// anything at all goes wrong.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// ----------------------------------------------------------------- layout

const HOME = os.homedir();
const ROOT = path.join(HOME, '.lineage', 'flocks');
const INDEX = path.join(ROOT, 'index.json');

/** The extension's own store. We read it to find projects, and write it for
 *  exactly one verb (`promote`). Same path the VS Code extension uses. */
const STATE_DIR = path.join(
  HOME,
  'Library',
  'Application Support',
  'Code',
  'User',
  'globalStorage',
  'hjulaxel.flock',
);
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const STATE_LOCK = path.join(STATE_DIR, 'state.json.lock');

/** The four kinds a crossing may be, and nothing else.
 *
 *  These are not categories for tidiness. They are the complete list of things
 *  that change what ANOTHER lane may assume, which is the only test for
 *  whether something belongs on the board at all. Progress, reasoning and
 *  local implementation detail have no kind here on purpose. */
const KINDS = {
  contract: 'a shape or interface the other lane must now match',
  constraint: 'something that is not possible, invalidating an assumption',
  'dead-end': 'a path tried and abandoned, so nobody walks it twice',
  ready: 'something is done and the other lane can build on it',
};

// The caps. Deliberately low, and deliberately refusals rather than warnings.
const MAX_TEXT = 200;          // one sentence, not a paragraph
const MAX_OPEN_PROPOSALS = 4;  // per lane, awaiting the human
const MAX_PER_DAY = 12;        // approved crossings per lane per rolling day
const MAX_OPEN_QUESTIONS = 2;  // per lane, unanswered
const JOIN_TTL_MS = 15 * 60_000;

// ------------------------------------------------------------------ io

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Temp file beside the target, then rename — the same atomicity the
 *  extension's own store buys, for the same reason: a reader must see the old
 *  file or the whole new one, never a half-written blob. */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readLines(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function appendLine(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(obj)}\n`, 'utf8');
}

const nowIso = () => new Date().toISOString();

/** `~/code/web` is what a person types and what the README shows; only a
 *  shell expands it, and a lane spec after a colon never reaches one. */
function expandDir(p) {
  const s = String(p);
  if (s === '~') return HOME;
  if (s.startsWith('~/')) return path.join(HOME, s.slice(2));
  return path.resolve(s);
}

function ago(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// -------------------------------------------------------------- the index

function loadIndex() {
  return readJson(INDEX, { flocks: {}, bindings: {}, pendingJoin: null });
}
const saveIndex = (ix) => writeJson(INDEX, ix);

const flockDir = (id) => path.join(ROOT, id);
const flockFile = (id) => path.join(flockDir(id), 'flock.json');
const boardFile = (id) => path.join(flockDir(id), 'board.ndjson');
const pendingFile = (id) => path.join(flockDir(id), 'pending.ndjson');
const cursorFile = (id) => path.join(flockDir(id), 'cursors.json');

const loadFlock = (id) => readJson(flockFile(id), null);

/**
 * Proposals still awaiting a human, optionally narrowed to one lane.
 *
 * The pending log is append-only — a decision is a NEW line carrying the same
 * id, so the original 'pending' line survives it. Every reader therefore has
 * to subtract the decided ids, and every reader doing that by hand is how one
 * of them ends up counting approved crossings against the open-proposal cap.
 * So: one function, and nobody filters this log anywhere else.
 */
function openProposals(flockId, lane) {
  const rows = readLines(pendingFile(flockId));
  const decided = new Set(
    rows.filter((r) => r.state !== 'pending').map((r) => r.id),
  );
  return rows.filter(
    (r) =>
      r.state === 'pending' &&
      !decided.has(r.id) &&
      (lane === undefined || r.from === lane),
  );
}

/**
 * Which conversation is asking.
 *
 * The tmux path is the one that matters: Flock launches every session it owns
 * into a tmux session named `lineage-<session-id>`, so a Bash tool call made
 * BY that conversation can recover its own id from the pane it is running in.
 * That is what lets `flock propose` know who is proposing without the model
 * being told, or being able to lie about it.
 *
 * `--session` is the escape hatch for a session Flock did not launch. Null is
 * a normal answer, and every caller handles it.
 */
function resolveSessionId(argv) {
  const flag = argv.session;
  if (typeof flag === 'string' && flag.length > 0) return flag;
  if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;

  const pane = process.env.TMUX_PANE;
  if (pane && process.env.TMUX) {
    try {
      const name = execFileSync(
        'tmux',
        ['display-message', '-pt', pane, '#{session_name}'],
        { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      const m = /^lineage-([0-9a-f-]{36})$/i.exec(name);
      if (m) return m[1];
    } catch {
      /* not in tmux, or tmux is gone — a normal answer */
    }
  }
  return null;
}

/** The lane this invocation belongs to: {flockId, lane, flock} or null. */
function currentLane(argv) {
  const ix = loadIndex();
  const sid = resolveSessionId(argv);
  let binding = sid ? ix.bindings[sid] : null;

  // `--lane` names a lane directly, for testing from any shell.
  if (!binding && typeof argv.lane === 'string') {
    for (const [fid] of Object.entries(ix.flocks)) {
      const f = loadFlock(fid);
      if (f?.lanes.some((l) => l.name === argv.lane)) {
        binding = { flockId: fid, lane: argv.lane };
        break;
      }
    }
  }
  if (!binding) return null;
  const flock = loadFlock(binding.flockId);
  if (!flock) return null;
  return { ...binding, flock, sessionId: sid };
}

function die(msg) {
  process.stderr.write(`flock: ${msg}\n`);
  process.exit(1);
}

// --------------------------------------------------------------- charter

/**
 * What a lane is told about the others, once, at the start.
 *
 * The important half is not the description of its own lane — the session
 * already knows what it was asked to do. It is the list of the OTHER lanes,
 * because that is what turns "do this" into "do this and not that", which is
 * the whole reason a flock beats three unrelated sessions.
 */
function charterText(flock, laneName) {
  const me = flock.lanes.find((l) => l.name === laneName);
  const others = flock.lanes.filter((l) => l.name !== laneName);
  const lines = [];
  lines.push(`You are the \`${laneName}\` lane of the flock "${flock.name}".`);
  if (flock.brief) lines.push(``, `The flock is working on: ${flock.brief}`);
  if (me?.charter) lines.push(``, `Your lane: ${me.charter}`);
  if (others.length > 0) {
    lines.push(``, `The other lanes, which are live sessions, not subagents:`);
    for (const o of others) {
      lines.push(`  · \`${o.name}\` — ${o.charter || o.dir}`);
    }
    lines.push(
      ``,
      `Stay in your lane. Do not do their work, and do not guess at their`,
      `decisions — when you need one, ask (\`flock ask <lane> "..."\`) rather`,
      `than assuming.`,
    );
  }
  lines.push(
    ``,
    `When you make a decision or hit a constraint that changes what another`,
    `lane may assume, propose a crossing:`,
    `  flock propose --to <lane> --kind <${Object.keys(KINDS).join('|')}> "<one sentence>"`,
    `A proposal is NOT published, and the other lane does not see it, until the`,
    `human approves it. You cannot approve your own — the attempt is blocked.`,
    `Propose, say in one line that it is waiting, and carry on working.`,
  );
  return lines.join('\n');
}

// ------------------------------------------------------------- commands

function cmdNew(argv, rest) {
  const name = rest[0];
  if (!name) die('usage: flock new <name> --lane <lane>[:<dir>] ... [--brief "..."]');

  const laneArgs = [].concat(argv.lane ?? []);
  if (laneArgs.length < 2) die('a flock needs at least two lanes (--lane a --lane b)');

  const id = randomUUID();
  const cwd = process.cwd();
  const lanes = laneArgs.map((spec) => {
    const idx = String(spec).indexOf(':');
    const lname = idx === -1 ? String(spec) : String(spec).slice(0, idx);
    const dir = idx === -1 ? cwd : expandDir(String(spec).slice(idx + 1));
    return { name: lname, dir, charter: '' };
  });

  // --charter frontend="..." attaches a lane's own brief.
  for (const c of [].concat(argv.charter ?? [])) {
    const eq = String(c).indexOf('=');
    if (eq === -1) continue;
    const lname = String(c).slice(0, eq);
    const text = String(c).slice(eq + 1);
    const lane = lanes.find((l) => l.name === lname);
    if (lane) lane.charter = text;
  }

  const flock = {
    id,
    name,
    brief: typeof argv.brief === 'string' ? argv.brief : '',
    createdAt: nowIso(),
    lanes,
  };
  writeJson(flockFile(id), flock);
  writeJson(cursorFile(id), Object.fromEntries(lanes.map((l) => [l.name, 0])));

  const ix = loadIndex();
  ix.flocks[id] = { id, name, createdAt: flock.createdAt };
  saveIndex(ix);

  process.stdout.write(
    [
      `flock "${name}" created — ${lanes.length} lanes.`,
      ...lanes.map((l) => `  · ${l.name.padEnd(12)} ${l.dir}`),
      ``,
      `In each lane's session, run:  flock join <lane>`,
      `Then check it took:           flock status`,
      ``,
    ].join('\n'),
  );
}

function cmdJoin(argv, rest) {
  const laneName = rest[0];
  if (!laneName) die('usage: flock join <lane>');

  const ix = loadIndex();
  const ids = Object.keys(ix.flocks);
  if (ids.length === 0) die('no flocks yet — `flock new` first');

  // Newest flock containing this lane name, unless --flock names one.
  let target = null;
  const ordered = ids.sort((a, b) =>
    String(ix.flocks[b].createdAt).localeCompare(String(ix.flocks[a].createdAt)),
  );
  for (const fid of ordered) {
    const f = loadFlock(fid);
    if (!f) continue;
    if (argv.flock && f.name !== argv.flock && f.id !== argv.flock) continue;
    if (f.lanes.some((l) => l.name === laneName)) {
      target = f;
      break;
    }
  }
  if (!target) die(`no flock has a lane called "${laneName}"`);

  const sid = resolveSessionId(argv);
  if (sid) {
    ix.bindings[sid] = { flockId: target.id, lane: laneName };
    saveIndex(ix);
    process.stdout.write(`joined "${target.name}" as \`${laneName}\`.\n\n`);
    process.stdout.write(`${charterText(target, laneName)}\n`);
    return;
  }

  // No id to bind to yet — leave a claim the next prompt in this session
  // picks up. This is the path for a session Flock did not launch.
  ix.pendingJoin = {
    flockId: target.id,
    lane: laneName,
    at: nowIso(),
    cwd: process.cwd(),
  };
  saveIndex(ix);
  process.stdout.write(
    `claimed \`${laneName}\` — it binds on this session's next prompt.\n`,
  );
}

function cmdPropose(argv, rest) {
  const here = currentLane(argv);
  if (!here) die('this session is not in a flock (`flock join <lane>`)');

  const to = argv.to;
  const kind = argv.kind;
  const text = rest.join(' ').trim();

  // Every refusal below is a scarcity rule. They are the reason the board
  // stays short enough that a human keeps reading it.
  if (!to) die('--to is required: a crossing is addressed to ONE lane, never broadcast');
  if (to === here.lane) die('a crossing goes to another lane, not your own');
  if (!here.flock.lanes.some((l) => l.name === to)) {
    die(`no lane "${to}" in this flock — lanes are ${here.flock.lanes.map((l) => l.name).join(', ')}`);
  }
  if (!kind || !(kind in KINDS)) {
    die(
      `--kind must be one of:\n` +
        Object.entries(KINDS)
          .map(([k, d]) => `  ${k.padEnd(11)} ${d}`)
          .join('\n'),
    );
  }
  if (!text) die('a crossing needs one sentence of text');
  if (text.length > MAX_TEXT) {
    die(
      `${text.length} chars — a crossing is ONE sentence (max ${MAX_TEXT}). ` +
        `If it needs more, it is reasoning, and reasoning stays in your lane.`,
    );
  }
  if (text.includes('\n')) die('one sentence, one line');

  const pending = readLines(pendingFile(here.flockId));
  const open = openProposals(here.flockId, here.lane);
  if (open.length >= MAX_OPEN_PROPOSALS) {
    die(
      `${open.length} of your crossings are already waiting for approval. ` +
        `Nothing more may be proposed until those are dealt with.`,
    );
  }
  const board = readLines(boardFile(here.flockId));
  const dayAgo = Date.now() - 86_400_000;
  const today = board.filter(
    (c) => c.from === here.lane && new Date(c.at).getTime() > dayAgo,
  );
  if (today.length >= MAX_PER_DAY) {
    die(`this lane has published ${today.length} crossings today — that is the cap.`);
  }

  // Highest id wins +1, rather than the line count: the pending log is
  // append-only and a decision is a line too, so counting lines would make
  // ids jump around for no reason a reader could follow.
  const id = `p${String(
    pending.reduce((m, p) => Math.max(m, Number(String(p.id).slice(1)) || 0), 0) + 1,
  )}`;
  appendLine(pendingFile(here.flockId), {
    id,
    from: here.lane,
    to,
    kind,
    text,
    at: nowIso(),
    state: 'pending',
    ...(argv.supersedes ? { supersedes: String(argv.supersedes) } : {}),
    sessionId: here.sessionId ?? null,
  });

  process.stdout.write(
    [
      `proposed ${id} → \`${to}\` (${kind})`,
      `  "${text}"`,
      ``,
      `It is NOT on the board yet, and \`${to}\` has not seen it.`,
      `Waiting for the human to publish it:  flock ok ${id}`,
      ``,
    ].join('\n'),
  );
}

/**
 * Approve or reject — the human's verb, and only the human's.
 *
 * Nothing here checks who is calling, because it cannot: a tool call and a
 * typed command reach this function identically. The guarantee lives one
 * level up, in the PreToolUse hook, which refuses this command when it
 * arrives as a Bash tool call. That is the difference between a rule and an
 * enforcement, and it is why this verb is safe to leave unguarded.
 */
function cmdDecide(argv, rest, approve) {
  const id = rest[0];
  if (!id) die(`usage: flock ${approve ? 'ok' : 'no'} <id>`);

  const ix = loadIndex();
  for (const fid of Object.keys(ix.flocks)) {
    const rows = readLines(pendingFile(fid));
    const row = rows.find((r) => r.id === id && r.state === 'pending');
    if (!row) continue;

    // The pending log is append-only too: the decision is a new line, and
    // the original proposal stays exactly as it was written.
    appendLine(pendingFile(fid), {
      ...row,
      state: approve ? 'approved' : 'rejected',
      decidedAt: nowIso(),
      ...(rest[1] ? { reason: rest.slice(1).join(' ') } : {}),
    });

    if (approve) {
      const board = readLines(boardFile(fid));
      appendLine(boardFile(fid), {
        seq: board.length + 1,
        id: `c${String(board.length + 1)}`,
        from: row.from,
        to: row.to,
        kind: row.kind,
        text: row.text,
        at: nowIso(),
        proposedAt: row.at,
        ...(row.supersedes ? { supersedes: row.supersedes } : {}),
      });
      process.stdout.write(
        `published → \`${row.to}\` will see it at its next prompt.\n`,
      );
    } else {
      process.stdout.write(`rejected ${id} — nothing was published.\n`);
    }
    return;
  }
  die(`no pending crossing "${id}"`);
}

function cmdReview(argv) {
  const ix = loadIndex();
  let found = 0;
  for (const fid of Object.keys(ix.flocks)) {
    const flock = loadFlock(fid);
    if (!flock) continue;
    const open = openProposals(fid);
    if (open.length === 0) continue;
    found += open.length;
    process.stdout.write(`\n── ${flock.name} ──\n`);
    for (const r of open) {
      process.stdout.write(
        `  [${r.id}] ${r.from} → ${r.to} · ${r.kind} · ${ago(r.at)}\n` +
          `        "${r.text}"\n`,
      );
    }
  }
  if (found === 0) {
    process.stdout.write('nothing waiting for approval.\n');
    return;
  }
  process.stdout.write(`\napprove: flock ok <id>    reject: flock no <id> [reason]\n`);
}

function cmdBoard(argv) {
  const ix = loadIndex();
  const here = currentLane(argv);
  const ids = argv.all || !here ? Object.keys(ix.flocks) : [here.flockId];
  for (const fid of ids) {
    const flock = loadFlock(fid);
    if (!flock) continue;
    const rows = readLines(boardFile(fid));
    const superseded = new Set(rows.map((r) => r.supersedes).filter(Boolean));
    process.stdout.write(`\n── ${flock.name} — ${rows.length} crossings ──\n`);
    if (rows.length === 0) process.stdout.write('  (nothing yet)\n');
    for (const r of rows) {
      const dead = superseded.has(r.id);
      process.stdout.write(
        `  ${dead ? '~' : ' '}[${r.id}] ${r.from} → ${r.to} · ${r.kind} · ${ago(r.at)}` +
          `${dead ? '  (superseded)' : ''}\n        "${r.text}"\n`,
      );
    }
  }
  process.stdout.write('\n');
}

// --------------------------------------------------------- ask / answer

/**
 * The pull channel.
 *
 * Questions do NOT need approval, and that is deliberate rather than an
 * oversight: a pushed crossing is one lane deciding another lane cares, which
 * is exactly the judgement that produces noise, and so it gets a human in the
 * loop. A question is the ASKER saying it is stuck, which is self-evidently
 * relevant to the asker and cannot flood anyone but the lane that chose to
 * ask. Capped anyway, because two open questions is already a lot of waiting.
 */
function cmdAsk(argv, rest) {
  const here = currentLane(argv);
  if (!here) die('this session is not in a flock');
  const to = rest[0];
  const text = rest.slice(1).join(' ').trim();
  if (!to || !text) die('usage: flock ask <lane> "<question>"');
  if (to === here.lane) die('you are the ' + to + ' lane');
  if (!here.flock.lanes.some((l) => l.name === to)) die(`no lane "${to}"`);

  const rows = readLines(boardFile(here.flockId));
  // A question counts as answered once the lane it was put to has published
  // ANYTHING back, after it. Nothing marks a question closed explicitly —
  // that would be a fifth verb, and a flag somebody has to remember to set is
  // a flag that stays false forever and silently jams the cap.
  const openQ = rows.filter(
    (r) =>
      r.kind === 'question' &&
      r.from === here.lane &&
      !rows.some(
        (b) => b.from === r.to && b.to === here.lane && Number(b.seq) > Number(r.seq),
      ),
  );
  if (openQ.length >= MAX_OPEN_QUESTIONS) {
    die(
      `you already have ${openQ.length} unanswered questions out to other lanes. ` +
        `Work on something else in your lane until one comes back.`,
    );
  }
  appendLine(boardFile(here.flockId), {
    seq: rows.length + 1,
    id: `q${String(rows.length + 1)}`,
    from: here.lane,
    to,
    kind: 'question',
    text,
    at: nowIso(),
  });
  process.stdout.write(`asked \`${to}\` — it arrives at that lane's next prompt.\n`);
}

// ----------------------------------------------------------- delivery

/**
 * What a lane has not taken delivery of yet, and the cursor advance.
 *
 * The cursor moves only when `advance` is set, which is true for the hook and
 * false for a human running `flock inbox` to look. Looking must never consume.
 */
function deliver(flockId, lane, advance) {
  const cursors = readJson(cursorFile(flockId), {});
  const at = Number(cursors[lane] ?? 0);
  const rows = readLines(boardFile(flockId));
  const superseded = new Set(rows.map((r) => r.supersedes).filter(Boolean));
  const fresh = rows.filter(
    (r) => Number(r.seq) > at && r.to === lane && !superseded.has(r.id),
  );
  if (advance && rows.length > 0) {
    cursors[lane] = rows[rows.length - 1].seq;
    writeJson(cursorFile(flockId), cursors);
  }
  return fresh;
}

function renderInbox(flock, lane, fresh) {
  const out = [];
  out.push(
    `── flock: ${flock.name} — ${fresh.length} for \`${lane}\` ──`,
  );
  for (const r of fresh) {
    const head =
      r.kind === 'question'
        ? `[${r.id}] question · from ${r.from} · ${ago(r.at)}`
        : `[${r.id}] ${r.kind} · from ${r.from} · ${ago(r.at)}`;
    out.push(head, `    ${r.text}`);
  }
  const q = fresh.filter((r) => r.kind === 'question');
  if (q.length > 0) {
    out.push(
      `Answer with: flock propose --to ${q[0].from} --kind contract "<answer>"`,
    );
  }
  out.push(
    `These are decisions from another lane of this flock. Treat them as`,
    `binding on your work, and do not re-litigate them here.`,
  );
  return out.join('\n');
}

function cmdInbox(argv) {
  const here = currentLane(argv);
  if (!here) die('this session is not in a flock');
  const fresh = deliver(here.flockId, here.lane, false);
  if (fresh.length === 0) {
    process.stdout.write('nothing undelivered.\n');
    return;
  }
  process.stdout.write(`${renderInbox(here.flock, here.lane, fresh)}\n`);
}

// -------------------------------------------------------------- hooks

/**
 * Every hook path is wrapped in this. A prototype that can wedge a session is
 * not testable, so the contract is absolute: on ANY error, print nothing and
 * exit 0, which is indistinguishable to Claude Code from a flock that does
 * not exist.
 */
function safely(fn) {
  try {
    fn();
  } catch {
    /* a broken flock never breaks a session */
  }
  process.exit(0);
}

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

function hookUserPromptSubmit() {
  const payload = readStdin();
  const sid = payload?.session_id;
  if (!sid) return;

  const ix = loadIndex();
  let binding = ix.bindings[sid];

  // Claim a pending join. This is how a session Flock did not launch — one
  // where we could not resolve an id at `join` time — gets bound: the first
  // prompt after the claim carries the id we were missing.
  if (!binding && ix.pendingJoin) {
    const fresh = Date.now() - new Date(ix.pendingJoin.at).getTime() < JOIN_TTL_MS;
    if (fresh) {
      binding = { flockId: ix.pendingJoin.flockId, lane: ix.pendingJoin.lane };
      ix.bindings[sid] = binding;
      ix.pendingJoin = null;
      saveIndex(ix);
      const f = loadFlock(binding.flockId);
      if (f) process.stdout.write(`${charterText(f, binding.lane)}\n`);
      return;
    }
  }
  if (!binding) return;

  const flock = loadFlock(binding.flockId);
  if (!flock) return;

  const blocks = [];

  const fresh = deliver(binding.flockId, binding.lane, true);
  if (fresh.length > 0) blocks.push(renderInbox(flock, binding.lane, fresh));

  // The author's own reminder. This is the second half of the approval
  // design: a proposal that nobody ever approves is a silent failure, so the
  // lane that made it is told, at the moment its human is demonstrably
  // present — they just typed a prompt.
  const mine = openProposals(binding.flockId, binding.lane);
  if (mine.length > 0) {
    const lines = [
      `── flock ── ${mine.length} crossing${mine.length > 1 ? 's' : ''} ` +
        `waiting to be published`,
    ];
    for (const r of mine) {
      lines.push(`[${r.id}] → ${r.to} · ${r.kind} · "${r.text}"`);
    }
    lines.push(
      `Only you can publish ${mine.length > 1 ? 'these' : 'this'}, by typing in this terminal:`,
      `  flock ok ${mine[0].id}      (or: flock no ${mine[0].id} <reason>)`,
      `Claude: you cannot run those, and asking for them to be run is not your`,
      `job either — this notice is already in front of the human.`,
    );
    blocks.push(lines.join('\n'));
  }

  if (blocks.length > 0) process.stdout.write(`${blocks.join('\n\n')}\n`);
}

function hookSessionStart() {
  const payload = readStdin();
  const sid = payload?.session_id;
  if (!sid) return;
  const ix = loadIndex();
  const binding = ix.bindings[sid];
  if (!binding) return;
  const flock = loadFlock(binding.flockId);
  if (!flock) return;
  process.stdout.write(`${charterText(flock, binding.lane)}\n`);
}

/**
 * The enforcement.
 *
 * "The user decides" is a promise until something refuses. This refuses: a
 * Bash tool call whose command approves or rejects a crossing is blocked
 * before it runs, with exit code 2, whose stderr Claude Code feeds back to
 * the model as the reason. A human typing the same words into the same
 * terminal is not a tool call and never reaches here.
 *
 * Matching is on the command STRING, so it holds for `flock ok p1`,
 * `cd /x && flock ok p1`, and the mjs path spelled out in full.
 */
function hookPreToolUse() {
  const payload = readStdin();
  if (!payload) return;
  if (payload.tool_name !== 'Bash') return;
  const cmd = String(payload.tool_input?.command ?? '');
  // Anchored at a COMMAND position — start of the line, or just after a
  // separator — so that writing *about* the verb (`echo "flock ok p1"`, this
  // file's own README) is not blocked, while every spelling that would
  // actually run it is. Optional `node` and an optional path cover the long
  // forms. False positives fail safe: the worst case is a refusal.
  if (
    !/(^|[\n;&|(]|&&|\|\|)\s*(node\s+)?(["']?[^\s"']*\/)?flock(\.mjs)?["']?\s+(ok|no|approve|reject)\b/.test(
      cmd,
    )
  ) {
    return;
  }
  process.stderr.write(
    'Blocked by the flock hook: publishing a crossing is the human\'s decision, ' +
      'not yours. You may propose (`flock propose --to <lane> --kind <kind> "..."`) ' +
      'and then say, in your reply, that it is waiting for approval. Do not try ' +
      'to approve it, and do not ask the user to paste a command that does it ' +
      'on your behalf — they already see the pending list at their next prompt.\n',
  );
  process.exit(2);
}

// ------------------------------------------------------- promote to lane

/**
 * Turn a flock lane into a real Flock subproject.
 *
 * This is the one verb that writes the extension's own store, and it is here
 * because the two models are already the same shape: a subproject IS a named
 * lane of work in a directory, and a session started there carries its id.
 * A flock lane that turned out to be real work — not an exploration — should
 * not have to be re-created by hand as a row in the sidebar.
 *
 * The write takes the extension's advisory lock and lands through a temp file
 * and a rename, which is the same protocol state.ts uses, so a window running
 * at the time sees a whole file and merges it on its next read.
 */
function cmdPromote(argv, rest) {
  const laneName = rest[0];
  if (!laneName) die('usage: flock promote <lane> [--project <name>]');

  // Looked up by NAME, never through the caller's own binding: promoting a
  // lane you are not sitting in is the ordinary case, and resolving through
  // `currentLane` would quietly promote the lane you happen to be in instead.
  const ix0 = loadIndex();
  let here = null;
  for (const fid of Object.keys(ix0.flocks)) {
    const f = loadFlock(fid);
    if (f?.lanes.some((l) => l.name === laneName)) {
      here = { flockId: fid, lane: laneName, flock: f };
      break;
    }
  }
  if (!here) die(`no lane "${laneName}" in any flock`);
  const lane = here.flock.lanes.find((l) => l.name === laneName);
  if (!lane) die(`no lane "${laneName}"`);
  if (lane.subprojectId) {
    die(`\`${laneName}\` is already subproject ${lane.subprojectId}`);
  }

  if (!fs.existsSync(STATE_FILE)) die(`no Flock state at ${STATE_FILE}`);

  // Advisory lock, exactly as state.ts takes it: create with `wx`, break it
  // if it is older than the staleness window, and go ahead regardless rather
  // than let a stuck lock mean the verb silently did nothing.
  let locked = false;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      fs.writeFileSync(STATE_LOCK, `${process.pid} ${nowIso()}\n`, { flag: 'wx' });
      locked = true;
      break;
    } catch {
      try {
        if (Date.now() - fs.statSync(STATE_LOCK).mtimeMs > 5000) {
          fs.rmSync(STATE_LOCK, { force: true });
          continue;
        }
      } catch {
        /* vanished under us — try again */
      }
    }
  }

  try {
    const state = readJson(STATE_FILE, null);
    if (!state) die('could not parse state.json');
    fs.copyFileSync(STATE_FILE, `${STATE_FILE}.bak-before-flock-promote`);

    // Which project owns this lane's directory: longest matching dir wins,
    // which is the question the sidebar itself asks (`matchProject`).
    let projectId = null;
    let best = -1;
    for (const [pid, p] of Object.entries(state.projects ?? {})) {
      if (p.deleted) continue;
      if (argv.project && (p.name === argv.project || pid === argv.project)) {
        projectId = pid;
        break;
      }
      if (argv.project) continue;
      for (const d of [p.rootDir, ...(p.dirs ?? [])].filter(Boolean)) {
        if ((lane.dir === d || lane.dir.startsWith(`${d}/`)) && d.length > best) {
          best = d.length;
          projectId = pid;
        }
      }
    }
    if (!projectId) {
      die(
        `no Flock project covers ${lane.dir} — name one with --project <name>, ` +
          `or add that directory to a project in the sidebar first.`,
      );
    }

    const subId = randomUUID();
    state.subprojects = state.subprojects ?? {};
    state.subprojects[subId] = {
      id: subId,
      projectId,
      name: laneName,
      dir: lane.dir,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    // Stamp the sessions that have been living in this lane, so the rows move
    // under it rather than the lane appearing empty next to the work it names.
    const ix = loadIndex();
    let stamped = 0;
    for (const [sid, b] of Object.entries(ix.bindings)) {
      if (b.flockId !== here.flockId || b.lane !== laneName) continue;
      const rec = state.records?.[sid];
      if (!rec || rec.deleted) continue;
      rec.subprojectId = subId;
      rec.updatedAt = nowIso();
      stamped++;
    }

    const tmp = `${STATE_FILE}.flock-promote.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    JSON.parse(fs.readFileSync(tmp, 'utf8')); // the bytes on disk parse
    fs.renameSync(tmp, STATE_FILE);

    lane.subprojectId = subId;
    writeJson(flockFile(here.flockId), here.flock);

    process.stdout.write(
      [
        `\`${laneName}\` is now a subproject of "${state.projects[projectId].name}".`,
        `  dir      ${lane.dir}`,
        `  sessions ${stamped} moved onto the lane`,
        `  backup   ${STATE_FILE}.bak-before-flock-promote`,
        ``,
        `The sidebar picks it up on its next read of state.json.`,
        ``,
      ].join('\n'),
    );
  } finally {
    if (locked) fs.rmSync(STATE_LOCK, { force: true });
  }
}

// ----------------------------------------------------------- the view

/**
 * The swimlane view, which is the picture a tree cannot draw.
 *
 * A tree draws where sessions came FROM. A flock's interesting structure is
 * what passes BETWEEN them, over time — so: lanes as rows, time to the right,
 * crossings as arrows from the lane that published to the lane that must obey.
 *
 * It audits the decomposition, which is the real reason to look at it. A few
 * arrows means the split was clean. A wall of arrows means the lanes were
 * never separable and the work wanted one session.
 */
function cmdView(argv) {
  const ix = loadIndex();
  const here = currentLane(argv);
  const fid =
    here?.flockId ??
    Object.keys(ix.flocks).sort((a, b) =>
      String(ix.flocks[b].createdAt).localeCompare(String(ix.flocks[a].createdAt)),
    )[0];
  if (!fid) die('no flocks yet');
  const flock = loadFlock(fid);
  const rows = readLines(boardFile(fid));
  const open = openProposals(fid);

  // x is ORDINAL, not wall-clock.
  //
  // Time looks like the obvious axis and is the wrong one: a flock's first
  // hour puts every crossing inside one pixel, so the picture is a blob
  // exactly when it is first looked at, and a flock left overnight puts one
  // crossing at each end with a desert between. Sequence spaces evenly and
  // reads the same on day one and day five. The clock lives in the table.
  const PAD = 150;
  const STEP = 74;
  const W = Math.max(900, PAD + 60 + rows.length * STEP);
  const laneY = (name) => 78 + flock.lanes.findIndex((l) => l.name === name) * 92;
  const xAt = (i) => PAD + 30 + i * STEP;

  const KIND_COLOR = {
    contract: '#3b82f6',
    constraint: '#f59e0b',
    'dead-end': '#ef4444',
    ready: '#10b981',
    question: '#a78bfa',
  };

  const H = 78 + (flock.lanes.length - 1) * 92 + 54;
  const arrows = rows
    .map((r, i) => {
      const x = xAt(i);
      const y1 = laneY(r.from);
      const y2 = laneY(r.to);
      const c = KIND_COLOR[r.kind] ?? '#888';
      const down = y2 > y1;
      const mid = (y1 + y2) / 2;
      // The id under the arrow is what ties the picture to the table below.
      const idY = H - 30;
      // Each arrow is a <g> so its <title> is the tooltip for THAT arrow. A
      // bare <title> directly under <svg> is the accessible name of the whole
      // graphic, and a stack of them silently fights the aria-label.
      const endY = down ? y2 - 7 : y2 + 7; // stop short so the head sits on the rule
      return `
    <g><title>${escapeHtml(r.kind)} · ${escapeHtml(r.from)} → ${escapeHtml(r.to)}: ${escapeHtml(r.text)} (${ago(r.at)})</title>
    <path d="M ${x} ${y1} C ${x + 22} ${mid}, ${x + 22} ${mid}, ${x} ${endY}"
          fill="none" stroke="${c}" stroke-width="2" marker-end="url(#a-${r.kind})"/>
    <circle cx="${x}" cy="${y1}" r="4.5" fill="${c}"/>
    <text x="${x}" y="${idY}" text-anchor="middle" class="cid">${escapeHtml(r.id)}</text></g>`;
    })
    .join('');

  const lanes = flock.lanes
    .map((l) => {
      const y = laneY(l.name);
      const sub = l.subprojectId ? ' · subproject' : '';
      return `
    <line x1="${PAD}" y1="${y}" x2="${W - 30}" y2="${y}"
          stroke="var(--rule)" stroke-width="1.5"/>
    <text x="${PAD - 16}" y="${y + 4}" text-anchor="end"
          class="lane">${escapeHtml(l.name)}</text>
    <text x="${PAD - 16}" y="${y + 19}" text-anchor="end"
          class="lanedir">${escapeHtml(path.basename(l.dir))}${sub}</text>`;
    })
    .join('');

  const markers = Object.entries(KIND_COLOR)
    .map(
      ([k, c]) => `<marker id="a-${k}" viewBox="0 0 8 8" refX="7" refY="4"
        markerWidth="6" markerHeight="6" orient="auto">
        <path d="M0,0 L8,4 L0,8 z" fill="${c}"/></marker>`,
    )
    .join('');

  const html = `<!doctype html><meta charset="utf-8">
<title>flock — ${escapeHtml(flock.name)}</title>
<style>
  :root { --bg:#fff; --fg:#1a1a1a; --dim:#666; --rule:#e3e3e3; --card:#f7f7f8; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#151517; --fg:#e8e8ea; --dim:#9a9aa2; --rule:#2c2c31; --card:#1d1d21; }
  }
  body { background:var(--bg); color:var(--fg); margin:0; padding:32px;
    font:14px/1.55 ui-sans-serif,-apple-system,"SF Pro Text",system-ui,sans-serif; }
  h1 { font-size:19px; margin:0 0 2px; font-weight:600; }
  .sub { color:var(--dim); margin:0 0 26px; }
  .wrap { overflow-x:auto; }
  .lane { fill:var(--fg); font:600 13px ui-sans-serif,system-ui,sans-serif; }
  .lanedir { fill:var(--dim); font:11px ui-monospace,SFMono-Regular,Menlo,monospace; }
  .cid { fill:var(--dim); font:11px ui-monospace,SFMono-Regular,Menlo,monospace; }
  .k { display:inline-flex; gap:6px; align-items:center; margin-right:14px;
       color:var(--dim); font-size:12px; }
  .sw { width:10px; height:10px; border-radius:2px; display:inline-block; }
  table { border-collapse:collapse; width:100%; margin-top:26px; }
  th { text-align:left; font-size:11px; letter-spacing:.06em; text-transform:uppercase;
       color:var(--dim); border-bottom:1px solid var(--rule); padding:6px 10px 6px 0; font-weight:600; }
  td { padding:9px 10px 9px 0; border-bottom:1px solid var(--rule); vertical-align:top; }
  .tag { font-size:11px; padding:2px 7px; border-radius:20px; color:#fff; white-space:nowrap; }
  .pend { background:var(--card); border:1px solid var(--rule); border-radius:8px;
          padding:14px 16px; margin-top:26px; }
  code { font:12px ui-monospace,SFMono-Regular,Menlo,monospace; }
</style>
<h1>${escapeHtml(flock.name)}</h1>
<p class="sub">${escapeHtml(flock.brief || 'no brief')} · ${flock.lanes.length} lanes · ${rows.length} crossings</p>
<div class="wrap">
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img"
     aria-label="Swimlane diagram: ${rows.length} crossings between ${flock.lanes.length} lanes">
  <defs>${markers}</defs>${lanes}${arrows}
</svg>
</div>
<p>${Object.entries(KIND_COLOR)
    .map(([k, c]) => `<span class="k"><span class="sw" style="background:${c}"></span>${k}</span>`)
    .join('')}</p>
${
  rows.length === 0
    ? '<p class="sub">No crossings yet — the lanes have not needed each other.</p>'
    : `<table><thead><tr><th>id</th><th>kind</th><th>from → to</th><th>crossing</th><th>when</th></tr></thead><tbody>
${rows
  .map(
    (r) => `<tr><td><code>${r.id}</code></td>
      <td><span class="tag" style="background:${KIND_COLOR[r.kind] ?? '#888'}">${r.kind}</span></td>
      <td>${escapeHtml(r.from)} → <strong>${escapeHtml(r.to)}</strong></td>
      <td>${escapeHtml(r.text)}</td><td>${ago(r.at)}</td></tr>`,
  )
  .join('\n')}
</tbody></table>`
}
${
  open.length > 0
    ? `<div class="pend"><strong>${open.length} waiting for your approval</strong>${open
        .map(
          (p) =>
            `<div style="margin-top:8px"><code>${p.id}</code> ${escapeHtml(p.from)} → ${escapeHtml(p.to)} · ${p.kind}<br>“${escapeHtml(p.text)}”</div>`,
        )
        .join('')}<p style="margin:12px 0 0"><code>flock ok &lt;id&gt;</code> · <code>flock no &lt;id&gt;</code></p></div>`
    : ''
}
`;
  const out = path.join(flockDir(fid), 'view.html');
  fs.writeFileSync(out, html, 'utf8');
  process.stdout.write(`${out}\n`);
  if (argv.open) {
    try {
      execFileSync('open', [out], { stdio: 'ignore' });
    } catch {
      /* no opener — the path is on stdout either way */
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

// -------------------------------------------------------------- status

function cmdStatus(argv) {
  const ix = loadIndex();
  const here = currentLane(argv);
  const sid = resolveSessionId(argv);
  process.stdout.write(
    `session   ${sid ?? '(unresolved — not in a Flock tmux session)'}\n`,
  );
  if (!here) {
    process.stdout.write(`lane      (not in a flock)\n`);
    const names = Object.values(ix.flocks).map((f) => f.name);
    if (names.length) process.stdout.write(`flocks    ${names.join(', ')}\n`);
    return;
  }
  const fresh = deliver(here.flockId, here.lane, false);
  const open = openProposals(here.flockId, here.lane);
  process.stdout.write(
    [
      `flock     ${here.flock.name}`,
      `lane      ${here.lane}`,
      `lanes     ${here.flock.lanes.map((l) => l.name).join(', ')}`,
      `inbox     ${fresh.length} undelivered`,
      `awaiting  ${open.length} of your proposals need approval`,
      '',
    ].join('\n'),
  );
}

// ------------------------------------------------------- hook install

const INSTALLED_CLI = path.join(HOME, '.lineage', 'flock', 'flock.mjs');

/**
 * Where a plugin has to land to be loaded.
 *
 * NOT `~/.claude` unconditionally. An account on this machine IS a config
 * directory — Flock runs each one with its own `CLAUDE_CONFIG_DIR`, so a
 * plugin written to `~/.claude/skills` is invisible to every session started
 * under a profile, and the failure is silent: hooks simply never fire, which
 * looks exactly like a flock that does not work.
 *
 * So: the config dir this process was launched under, which is the one the
 * session running this command uses. `--all-profiles` covers every account,
 * for a flock whose lanes are not all on the same plan.
 */
function configDirs(argv) {
  if (typeof argv['config-dir'] === 'string') return [expandDir(argv['config-dir'])];
  if (argv['all-profiles']) {
    const dirs = [path.join(HOME, '.claude')];
    const profiles = path.join(HOME, '.lineage', 'profiles');
    try {
      for (const name of fs.readdirSync(profiles)) {
        const d = path.join(profiles, name);
        if (fs.statSync(d).isDirectory()) dirs.push(d);
      }
    } catch {
      /* no profiles on this machine */
    }
    return dirs;
  }
  return [process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude')];
}

function cmdInstallHooks(argv) {
  // The CLI is COPIED to a $HOME-relative path we own, and the hooks name
  // that copy — never this file's path. A prototype that lives in a checkout
  // would otherwise break the moment the checkout moves.
  fs.mkdirSync(path.dirname(INSTALLED_CLI), { recursive: true });
  fs.copyFileSync(new URL(import.meta.url).pathname, INSTALLED_CLI);
  fs.chmodSync(INSTALLED_CLI, 0o755);

  // The `[ -f ] || exit 0` guard makes a half-install — plugin present, CLI
  // deleted or never copied — a silent no-op rather than a node stack trace
  // in front of every prompt. `exec` is load-bearing: PreToolUse blocks by
  // exiting 2, and a subshell would swallow that.
  const run = (event) =>
    `/bin/sh -c '[ -f "$HOME/.lineage/flock/flock.mjs" ] || exit 0; ` +
    `exec /usr/bin/env node "$HOME/.lineage/flock/flock.mjs" hook ${event}'`;

  const written = [];
  for (const base of configDirs(argv)) {
    const dir = path.join(base, 'skills', 'flock-lanes');
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.claude-plugin', 'plugin.json'),
      `${JSON.stringify(
        {
          name: 'flock-lanes',
          version: '0.0.1',
          description:
            'Delivers flock crossings at the prompt boundary, and refuses to let ' +
            'an agent approve its own. Delete this directory to uninstall.',
        },
        null,
        2,
      )}\n`,
    );
    fs.writeFileSync(
      path.join(dir, 'hooks', 'hooks.json'),
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              { hooks: [{ type: 'command', command: run('SessionStart') }] },
            ],
            UserPromptSubmit: [
              { hooks: [{ type: 'command', command: run('UserPromptSubmit') }] },
            ],
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [{ type: 'command', command: run('PreToolUse') }],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );
    written.push(dir);
  }

  process.stdout.write(
    [
      ...written.map((d) => `installed → ${d}`),
      `cli       → ${INSTALLED_CLI}`,
      ``,
      process.env.CLAUDE_CONFIG_DIR
        ? `This session's CLAUDE_CONFIG_DIR is ${process.env.CLAUDE_CONFIG_DIR} — a` +
          `\nlane on a different account needs --all-profiles.`
        : `No CLAUDE_CONFIG_DIR set, so this installed to the default ~/.claude.`,
      ``,
      `Run /reload-plugins in each lane's session (or restart it) before testing.`,
      `Uninstall: rm -rf ${written.map((d) => d).join(' ')}`,
      ``,
    ].join('\n'),
  );
}

// ---------------------------------------------------------------- argv

function parse(args) {
  const argv = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      let val;
      if (eq !== -1) val = a.slice(eq + 1);
      else if (i + 1 < args.length && !args[i + 1].startsWith('--')) val = args[++i];
      else val = true;
      // Repeated flags collect, which is how `--lane a --lane b` works.
      if (key in argv) argv[key] = [].concat(argv[key], val);
      else argv[key] = val;
    } else rest.push(a);
  }
  return { argv, rest };
}

const USAGE = `flock — long-lived parallel sessions that stay aware of each other

  flock new <name> --lane <lane>[:<dir>] --lane <lane>[:<dir>]
                   [--brief "..."] [--charter <lane>="..."]
  flock join <lane>                  bind THIS session to a lane
  flock status                       where am I, what is waiting

  flock propose --to <lane> --kind <kind> "<one sentence>"
                                     propose a crossing (agent-callable)
  flock ask <lane> "<question>"      the pull channel, no approval needed

  flock review                       what is waiting for you  (human)
  flock ok <id>  /  flock no <id>    publish or refuse        (human only)

  flock board [--all]                the ledger
  flock inbox                        undelivered, without consuming
  flock view [--open]                the swimlane picture
  flock promote <lane> [--project X] make the lane a real Flock subproject

  flock install-hooks                wire up prompt-boundary delivery

kinds: ${Object.keys(KINDS).join(', ')}
`;

function main() {
  const [, , cmd, ...args] = process.argv;
  const { argv, rest } = parse(args);

  switch (cmd) {
    case 'new': return cmdNew(argv, rest);
    case 'join': return cmdJoin(argv, rest);
    case 'status': return cmdStatus(argv);
    case 'charter': {
      const here = currentLane(argv);
      if (!here) die('this session is not in a flock');
      return void process.stdout.write(`${charterText(here.flock, here.lane)}\n`);
    }
    case 'propose': return cmdPropose(argv, rest);
    case 'ask': return cmdAsk(argv, rest);
    case 'review': return cmdReview(argv);
    case 'ok': case 'approve': return cmdDecide(argv, rest, true);
    case 'no': case 'reject': return cmdDecide(argv, rest, false);
    case 'board': return cmdBoard(argv);
    case 'inbox': return cmdInbox(argv);
    case 'view': return cmdView(argv);
    case 'promote': return cmdPromote(argv, rest);
    case 'install-hooks': return cmdInstallHooks(argv);
    case 'hook': {
      const event = rest[0];
      if (event === 'UserPromptSubmit') return safely(hookUserPromptSubmit);
      if (event === 'SessionStart') return safely(hookSessionStart);
      if (event === 'PreToolUse') return safely(hookPreToolUse);
      return void process.exit(0);
    }
    default:
      process.stdout.write(USAGE);
      process.exit(cmd ? 1 : 0);
  }
}

main();
