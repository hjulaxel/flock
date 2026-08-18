# Proposal — Queued Dispatch, and Cross-Provider Handoff

**Status: proposal, 2026-08-18. The two pure cores (`src/dispatch.ts`,
`src/handoff.ts`) land with this document; the wiring milestones are marked.**
Both features monetize nothing and move no credential anywhere: they are
bookkeeping on top of the one fact accounts.ts already established — an
account is a config directory on this machine. The framing that matters is
*never lose your place*, not *extract more quota*: neither feature makes an
account do more than its own plan allows, they only spend attention better.

---

## 1. The two gaps, precisely

**Gap one.** When every account's five-hour window is spent, Flock's answer
today is a refusal with a good reason. The user's actual intent — "run this
when an account frees up" — has nowhere to live. They set an alarm, or they
forget. The `resetsAt` timestamp that names the exact moment the situation
changes is already sitting in every `UsageSnapshot`; nothing consumes it.

**Gap two.** `switchRefusal` (accounts.ts) refuses to move a conversation
between CLIs, and the refusal is honest: a Codex home holds no Claude
transcript, so there is nothing to resume. But "cannot resume" has been
quietly rounded up to "cannot continue", and those are different claims. The
transcript is a readable file on this disk. A new session on the other CLI can
be *briefed* to read it and carry on — not a resume, and the UI must never
call it one, but a real continuation with a real lineage edge.

## 2. Queued Dispatch

A queue entry is an intent to start a session: `{ id, createdAt, cwd?,
prompt?, title?, routing?, notBefore? }` — `routing` is the same
`RoutingChoice` a project pin uses, because "where may this run" must not
grow a second grammar.

The decision core is `decideDispatch(entries, profiles, usage, now)` in
`src/dispatch.ts` — pure, like routing.ts, and consulted the same way: plain
numbers in, a decision out. Its clauses, each a claim about how subscriptions
behave:

1. **The dispatcher's gate is the opposite of the router's tiebreak, on
   purpose.** The interactive router prefers an already-open window even at
   97%, because the user is present and an open window is a sunk cost. The
   dispatcher exists precisely when nobody is waiting — so a window above
   `DISPATCH_UTILIZATION_CEILING` (90) is a reason to sleep until `resetsAt`,
   not to squeeze. Same numbers, different intent, different rule.
2. **A tier never widens.** An entry routed to a named account waits for that
   account — rerouting it is a billing error, exactly as in routing.ts. A
   provider entry waits inside its provider. Only `auto` shops around, and it
   ranks the usable candidates with `resolveRouting` itself, so "which account
   is best" keeps one definition in one file.
3. **Unknown usage dispatches.** No data is not evidence of exhaustion
   (routing.ts said it first), and Codex usage always reads unknown — an
   entry queued for Codex must not wait forever for a number that will never
   come.
4. **One launch per account per decision.** Launching five queued entries
   onto one freshly-reset window at the same instant defeats the queue. The
   host re-decides after acting, so the rest follow as fast as they deserve.
5. **The queue never goes deaf.** `nextWakeAt` is the earliest `notBefore` or
   `resetsAt` that can change an answer; when entries remain and no reset is
   known, a `DISPATCH_RECHECK_MS` fallback keeps the queue breathing. An
   entry whose named account is gone is reported `stranded` with its reason,
   never silently dropped.

The host side (wiring, M-D2): persist the queue in state.json beside chains;
one timer armed to `nextWakeAt`; on wake, `force: true` usage refresh for the
accounts in play — a reset the cache has not seen must not block a launch —
then re-decide, launch via the ordinary `launchSession` path
(`recordLaunch(id, null, cwd)`, routed env), and let the existing bell say the
rest.

## 3. Cross-Provider Handoff

"Continue on Codex…" / "Continue on Claude…", offered exactly where Move to
Account… refuses with `different-cli` — the verb pair must partition the
world: same CLI moves, different CLI hands off, no target is served by both.

The mechanics compose three seams that already exist, which is the whole
argument for building it:

* **The child does the work.** Fork-and-Compact hands `/compact` to the child
  as its opening turn so the parent is never touched; the handoff hands the
  child a *brief* (`buildHandoffPrompt`, `src/handoff.ts`): read the parent's
  transcript at this path — a plain JSONL file for both CLIs — say where the
  work stands, continue from exactly there. No LLM in the extension, no
  transcript bytes in an argv, and the brief itself stays a few hundred
  characters.
* **The edge is minted, not inferred.** `recordLaunch(childId, clickedId,
  cwd)` records exact parentage independent of argv — the same call a fork
  makes. The launch itself carries NO `parentId`/`resumeId`: argv-wise it is
  a plain new session on the target CLI (`provider`, `env`, `profileId` from
  the chosen account), which is the truth.
* **The refusal logic mirrors switchRefusal.** `handoffRefusal` in
  handoff.ts: no target, then `same-cli` (fork and Move own that world —
  durable reason first, exactly as switchRefusal orders `different-cli` above
  `cannot-host`), then `cannot-host`, then `no-transcript` (same rule as
  fork: send one message first).

What the transcript path discloses, said out loud: the path's prefix names the
parent account's config directory. That is a location, not a credential, and
both processes already run as the same user on the same machine — but the
brief names the one file, never the directory.

Codex is id-provisional at spawn (rollout re-key, codex.ts); the handoff child
inherits that behaviour untouched, because it is just a launch.

## 4. What lands when

* **M-D1 (this branch): the cores.** `src/dispatch.ts`, `src/handoff.ts`,
  tests pinning every clause above. Pure, no vscode, no fs.
* **M-D2: dispatch wiring.** Queue persistence in state.ts, the two verbs
  (Queue for Dispatch…, a queue QuickPick with cancel), the timer, the
  force-refresh-on-wake. Queue rows in the accounts view come last and may
  slip: a QuickPick queue is usable, an unreadable sidebar is not.
* **M-D3: handoff wiring.** The verb on the session row, target picker with
  usage summaries, minted edge + briefed launch. Title follows the fork
  convention with the target CLI visible (`auth → codex`), because a row that
  hides its provider is a row that lies about what runs it.
