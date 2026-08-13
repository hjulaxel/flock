# flock — a prototype

Two or three long-lived sessions working different areas of one problem, that
stay aware of each other without merging.

This is **not** a workflow. A workflow parallelises a *task*: ephemeral agents,
one wavefront, a report at the end that nobody talks to. A flock parallelises a
*project*: every member is a session you type into, they run for days, and there
is no moment when all three are simultaneously done. So there is nothing to fan
in, and this prototype does not try. The value is in the middle.

Three parts, and deliberately only three.

**The charter.** Each lane is told once, at SessionStart, what the *other* lanes
are doing. That sentence is what stops two lanes doing the same work, and it
costs nothing.

**The board.** An append-only ledger of **crossings** — decisions and constraints
that change what another lane may assume. Addressed to one lane, never
broadcast. Delivered at that lane's **next prompt boundary**, which is the moment
it is both actionable and observed.

**The approval.** A crossing is *proposed* by a session and *published* by you.
This is enforced rather than requested: a `PreToolUse` hook refuses `flock ok`
when it arrives as a tool call, so the model physically cannot publish its own
proposal. Typed by you in a terminal it goes through, because that is not a tool
call.

## Try it in five minutes

Nothing is installed yet. Point `flock` at the checkout:

```sh
alias flock='node ~/Documents/lineage-sessions/prototype/flock/flock.mjs'
```

Make a flock, then wire up the hooks:

```sh
flock new search \
  --lane frontend:~/code/web --lane backend:~/code/api \
  --brief "type-ahead search across the corpus" \
  --charter frontend="the search box, results list and keyboard nav" \
  --charter backend="the query endpoint, ranking and pagination"

flock install-hooks     # copies the CLI to ~/.lineage/flock/ and writes the plugin
```

`install-hooks` writes into **this session's `CLAUDE_CONFIG_DIR`**, not
unconditionally into `~/.claude`. On this machine an account *is* a config
directory, so a plugin in `~/.claude/skills` is invisible to any session started
under a profile — and the failure is silent, which looks exactly like a flock
that does not work. Lanes spread across two accounts want `--all-profiles`; a
specific target wants `--config-dir <path>`.

Open two sessions — one per directory — and in each, run `/reload-plugins`, then:

```sh
flock join frontend     # and `flock join backend` in the other
```

It prints the charter, which is also injected at every SessionStart from now on.

Now make the thing happen. In the **frontend** session, ask Claude to do
something that forces a decision the backend must obey — then watch it propose:

```
flock propose --to backend --kind contract \
  "The list endpoint must return {items, cursor} — infinite scroll needs a cursor."
```

Nothing has crossed yet. The backend session sees nothing. At your next prompt in
the *frontend* session you get:

```
── flock ── 1 crossing waiting to be published
[p1] → backend · contract · "The list endpoint must return {items, cursor} …"
Only you can publish this, by typing in this terminal:
  flock ok p1      (or: flock no p1 <reason>)
```

Type `flock ok p1`. Then go to the **backend** session and press enter on any
prompt. Before your turn runs, it receives:

```
── flock: search — 1 for `backend` ──
[c1] contract · from frontend · 2m ago
    The list endpoint must return {items, cursor} — infinite scroll needs a cursor.
These are decisions from another lane of this flock. Treat them as
binding on your work, and do not re-litigate them here.
```

That is the whole idea. Ask Claude in the backend session to try approving
something itself — it gets refused by the hook, with a reason.

## The verbs

| | |
|---|---|
| `flock new <name> --lane a:<dir> --lane b:<dir>` | make one |
| `flock join <lane>` | bind this session |
| `flock status` | where am I, what is waiting |
| `flock propose --to <lane> --kind <kind> "…"` | agent-callable |
| `flock ask <lane> "…"` | the pull channel, no approval needed |
| `flock review` · `flock ok <id>` · `flock no <id>` | **yours only** |
| `flock board` · `flock inbox` | the ledger; undelivered, without consuming |
| `flock view --open` | the swimlane picture |
| `flock promote <lane>` | make the lane a real Flock subproject |

Kinds are `contract`, `constraint`, `dead-end`, `ready`. That list is the whole
test for whether something belongs on the board: does it change what another
lane may assume? Progress, reasoning and local detail have no kind on purpose.

## The scarcity rules, which are the whole ballgame

A board nobody reads is worse than no board, because then the lanes *believe*
they are coordinated. So every one of these is a refusal, not a warning:

- One sentence, 200 characters. More than that is reasoning, and reasoning stays
  in its lane.
- Addressed to exactly one lane. **There is no broadcast**, because "everyone
  should know this" is the thought that produces every piece of noise.
- Four open proposals per lane. Propose a fifth and you are told to get the
  others dealt with first.
- Twelve published crossings per lane per day.
- Two unanswered questions out at a time. A question closes itself when the lane
  it went to publishes anything back.

If a real flock ever hits these caps repeatedly, that is the signal the lanes
were not separable and the work wanted one session.

## `promote` — a lane that turned out to be real

Your subprojects are already *named lanes of work in a directory*, which is
exactly what a flock lane is. So a lane that stops being an exploration doesn't
have to be recreated by hand:

```sh
flock promote backend
```

writes a real `SubprojectRecord` into `state.json`, stamps every session bound to
that lane with its `subprojectId`, and leaves a `.bak-before-flock-promote`
beside it. It takes the same advisory lock `state.ts` takes and lands through a
temp file and a rename, so a window open at the time sees a whole file and merges
it on its next read.

## What is real and what is not

**Real:** the charter, the board, prompt-boundary delivery, the caps, the
approval gate and its enforcement, promotion to a subproject, the swimlane view.
All of it works today against live sessions.

**Not built:** anything in the sidebar. Spawning the lanes is still you opening
two sessions and typing `flock join` — the extension's `forkFlow(parentId,
{prompt})` already takes an opening prompt, so spawning a flock is N calls to it
plus a shared id, but that is extension work and this prototype deliberately
does not touch `src/`.

**Deliberately absent:** any fan-in. No merge, no synthesis, no "regroup" button.
If a flock ends, its lanes just close, and the board is what survives — which
turns out to be the useful artifact anyway: every decision load-bearing enough to
cross a lane boundary, in order, with its author. Nobody wrote it.

## Costs and caveats

- The `PreToolUse` hook runs on **every Bash tool call in every session on this
  machine**, at about **20 ms** each. That is the price of the approval
  guarantee. `rm -rf ~/.claude/skills/flock-lanes` uninstalls it completely.
- Session identity comes from the tmux session name (`lineage-<uuid>`), so
  `join` works out of the box in a Flock-launched session. Elsewhere it falls
  back to a claim that binds on the session's next prompt.
- Hooks are additive and separate from `lineage-events`; neither touches the
  other, and neither edits `settings.json`.
- Every hook path exits 0 and prints nothing on any error. A broken flock can
  never break a session.

## The open question

Whether a session can be trusted to author crossings at all.

Right now the model proposes and you dispose, which is the safe version. The
failure mode to watch for while testing is not the model publishing something
wrong — you will catch that — it is the model proposing *constantly*, so that
approving becomes a reflex and the gate stops being a gate. If that happens the
answer is probably to invert it: **you** mark a crossing from a turn you just
read, and the model only ever suggests one when asked.

Test it for a day on something real and see which way it goes.
