# Forking and context

What happens to a conversation's context when you fork it, when you fork and
compact it, when you resume a closed session, and when Claude forks itself.

This document was asked for as a question — *how is context used when we use
Flock to fork sessions?* — so it answers with numbers rather than with a
description of intent. Everything below was measured on this machine on
2026-08-28, against the Claude CLI **2.1.250** that is installed here and the
**584 transcripts** on disk (278 under `~/.claude/projects`, the rest under
`~/.lineage/profiles/magma` and `~/.lineage/profiles/personal`). Every claim
either cites a file and line in this repository or names the transcript it was
read out of. Where the honest answer is "the CLI does not tell us", it says so
under its own heading at the end.

---

## 1. The short answer

**A fork duplicates the conversation. It never reduces it.**

The child starts with everything the parent had — the whole chain, physically
copied into the child's own transcript file, and therefore the whole thing in
the model's context on the child's first turn. The parent is not touched: not
its file, not its context, not its row.

So forking is how you stop paying for a **bad direction**. It is not how you
stop paying for a **long** conversation. That is what **Fork and Compact** is
for, and section 5 says exactly what it costs and who pays it.

One measured example, end to end. Session `0079b373` is 566 lines and
**8,007,996 bytes** on disk, and was forked under claude 2.1.229. Its child
`46ce37ae` is 1,032 lines and **13,550,024 bytes**, of which **7,740,840 bytes
— 371 of the parent's 379 message records — are the parent's conversation
copied verbatim**, sitting at child lines 6 through 376. Nothing was written
into the parent to make that happen.

---

## 2. What a transcript is, and why a fork needs repairing first

A `.jsonl` transcript is a **DAG, not a list**. Every message record carries a
`uuid` and a `parentUuid`, and branches are ordinary: an interrupted prompt, a
rewound turn and a sub-agent all leave records that hang off the side.

So the CLI cannot replay a conversation by reading the file top to bottom. It
**picks a leaf and walks `parentUuid` backwards from there**. The leaf comes
from the `last-prompt` metadata records the transcript carries, and there are
two selection paths. Both are present, verbatim in shape, in the installed
2.1.250 binary — read out of it with `grep -a`, not guessed:

```
// path A
let it = Sx(R.values(), (Pt) => Oe.has(Pt.uuid))
      ?? (Oe.size === 0 && !pt ? Sx(R.values(), (Pt) => !Pt.isSidechain) : void 0);
if (!it) throw new MV("No valid conversation chain found in JSONL file", "no_chain");
// Oe = leafUuids, pt = clearedToEmpty

// path B
let sn = Sx(p.values(), (hn) => kt.has(hn.uuid) && (hn.type === "user" || hn.type === "assistant"));
if (!sn) { if (pn) return vIe(u, e, e.sessionId); return e }
let gn = hye(p, sn);            // hye = the parentUuid chain walk
```

Three consequences the rest of this document rests on:

- **The recorded leaf decides how much history a `--resume` or a
  `--fork-session` can see.** Anything not reachable from it by walking
  `parentUuid` back is simply not in the conversation.
- **A `/clear` writes `leafUuid: null, explicit: true`** and the conversation is
  deliberately empty. Nothing may resurrect it.
- **A `compact_boundary` that preserved nothing resets the parse** — records
  before it are no longer part of the conversation, and neither is a leaf that
  pointed into them.

`src/resumeLeaf.ts` replays exactly this state machine before every fork and
every resume, for the reason section 4 gives.

---

## 3. A plain fork — `lineage.forkSession`

### What Flock runs

```
claude --fork-session --resume <parent-id> --session-id <child-id> [prompt]
```

Built in `src/terminals.ts` (`buildShellArgs`, the fork branch at lines
311–318). Three things happen around it, in `forkFlow`
(`src/commands.ts:3276`):

1. **The transcript to replay is resolved, and it is not always the row you
   clicked.** `forkableAncestor` (`src/commands.ts:3032`) walks up through
   branches that have never taken a turn, because claude writes a transcript
   **lazily** — a branch you opened and never messaged has a row, a name and a
   directory, and no bytes anywhere. On this machine **65 of Flock's 221
   recorded fork edges have no child transcript at all**, which is what that
   number looks like in practice. The fork then replays the ancestor's
   transcript, which is precisely what that branch was showing on screen, and
   records the edge under the row you clicked.
2. **The resume leaf is repaired** — section 4.
3. **The edge is written to `state.json` BEFORE the terminal is created**
   (`recordLaunch(childId, clickedId, cwd)`, `src/commands.ts:3367`), so a
   crash between minting and launching still leaves the lineage correct. Flock's
   edges are exact by construction; nothing about a fork Flock made is ever
   inferred from the transcript.

### What the CLI writes into the child

The 2.1.250 fork writer, read out of the binary:

```
if (!Ux(e) || e.isSidechain || !A.has(e.uuid)) continue;
R = { ...o, ...y, sessionId: i, parentUuid: I, isSidechain: !1,
      sessionKind: void 0, forkedFrom: { sessionId: a, messageUuid: o.uuid } };
if (o.type !== "progress") I = o.uuid;
```

Read that filter first: only transcript-typed records, **never sidechains**,
and only uuids in the selected chain `A`. Then per record:

| Field | What happens |
| --- | --- |
| `uuid` | **preserved** — the child carries the parent's own message uuids |
| `parentUuid` | **relinked** to the previous emitted record, flattening the DAG into the selected chain |
| camel `sessionId` | **rewritten** to the child's id |
| snake `session_id` | **left naming the parent** |
| `isSidechain` | forced `false` |
| `sessionKind` | dropped |

The snake `session_id` is not in that snippet, and that is why it survives: the
writer builds each record by spreading the original (`{...o, …}`) and overriding
named fields, so every key it does not name rides through untouched. The camel
key is named. The snake key is not.

Measured on `46ce37ae` (claude 2.1.229): all 371 copied records carry
`sessionId: 46ce37ae…`, and 363 of them also carry `session_id: 0079b373…` —
221 assistant, 123 user, 18 attachment, 1 system. **That snake/camel
disagreement is the only fork signal a Flock fork leaves inside its own
transcript**, and it is exactly what `forkParentFromTranscript`'s deep branch 3
reads (`src/transcript.ts:183–187`).

### What is NOT copied

- **Metadata records.** The child's first five lines are its own `ai-title`,
  `mode`, `permission-mode` and two `file-history-snapshot` records; the copy
  starts at line 6 with the parent's root record and `parentUuid: null`. The
  child writes its own `last-prompt`, `custom-title` and `file-history-*`
  records from scratch.
- **Off-chain branches.** Only uuids in the selected chain are copied. On
  `8c6fa59a ← caa0edb5` two user records that predate the fork were left
  behind, and both are abandoned sibling branches. On `023b71cc ← 596031f1` and
  `43fb72aa ← f49c7e2d` the count of dropped predating records is **zero**.
- **Sub-agent transcripts.** These live under `<session-id>/subagents/**` and
  are `isSidechain`, so the copy filter skips them. Measured: `33e1d284` has
  **24** sub-agent transcripts; its fork child `1f743713` has **none**. A fork
  inherits what a sub-agent *reported back*, because that is an ordinary tool
  result in the main chain — it does not inherit the sub-agent's own
  conversation.

### The `forkedFrom` marker, and why Flock's forks do not have one

The 2.1.250 writer above stamps `forkedFrom` on **every copied line**, not once
at the fork point — so it is provenance, not a marker. And yet:

> **Zero of the 153 parent/child pairs Flock has made on this machine carry a
> `forkedFrom` record.** Those 153 span claude **2.1.207 → 2.1.248**. Flock's
> state holds 613 session records, 221 with a recorded parent edge, and 153 of
> those have both transcripts still on disk.

The **only five** transcripts anywhere on this machine that carry a real
`forkedFrom` record are `8ed3903b` (2.1.210), `ea6dc5ca` (2.1.215), `1f743713`
(2.1.217), `544ae224` and `59bcae42` (both 2.1.218) — and none of the five
appears in Flock's state at all. They are native in-app `/fork` children, made
by the CLI's *other* fork writer (the one that also mints fresh uuids and
titles the child `"… (fork)"`), not by Flock.

**This costs nothing**, because Flock records its own edges before launch and
never needs to infer them. It matters only for a fork Flock did **not** make,
where the transcript is the only witness — see section 9 for what is genuinely
unsettled about it.

---

## 4. Exactly how much of the parent's last turn the child inherits

This is the question `src/resumeLeaf.ts` exists for, and the honest answer has
two halves: the ordinary case, and a rare one that used to be common.

**The problem.** `last-prompt` is written **mid-turn**, in the metadata block
beside `ai-title` and `mode`, and it is not rewritten when the turn finishes. A
turn that makes two tool calls can therefore leave its recorded leaf pointing at
the **first tool result** — and everything the assistant said after that is
unreachable by the chain walk. Users report this as *"I only get the first part
of the last message"*, because the CLI's sibling-recovery pass pulls back the
other content blocks of that same assistant message and the loss reads as a
truncation rather than as a missing turn.

**How often that actually bites, today.** Replaying `repairResumeLeaf`'s exact
algorithm over the 278 transcripts under `~/.claude/projects`, and classifying
each recorded leaf against the newest non-sidechain `user`/`assistant` record:

| Where the recorded leaf sits | Files | What a fork loses |
| --- | ---: | --- |
| **past** the last message (a trailing `away_summary` / `turn_duration` / `attachment`) | 222 | nothing |
| **is** the last message | 37 | nothing |
| on an unrelated branch | 7 | varies |
| **before** the last message — the genuine stale leaf | **5** | 1, 1, 1, 2 and 13 records |

So: **normally a fork inherits the parent's conversation complete as of the
click.** Verified end to end on `023b71cc ← 596031f1` — **1,017 of 1,017**
message records copied, nothing predating the fork left behind. In the five
files where the leaf is genuinely stale, the child would inherit everything up
to that leaf and lose the tail: four of the five lose one or two records, and
the worst case on this disk (`18f40292`) loses thirteen.

**What Flock does about it.** Before every fork and every resume, `forkFlow`
calls `reportResumeLeaf` (`src/commands.ts:3325`), which calls
`repairResumeLeaf`. The repair **appends one more `last-prompt` record** naming
the true tip. It is the CLI's own mechanism used the way the CLI uses it, and it
is append-only — nothing already in the transcript is rewritten or removed, and
the parse reduces `leafUuids` to the last leaf seen, so the appended record
simply wins. The tip is restricted to a `user`/`assistant` record on purpose:
path B above refuses any other type and would report the transcript as having no
conversation at all.

**And it declines far more often than it acts** — 227 of the 278 files above
skip with `no-gain`. That is the guard working, not the module being dead. In
225 of those 227 the recorded leaf is *deeper* than the newest message (the
gain distribution is `-5: 64`, `-3: 49`, `-2: 33`, `-4: 27`, …) because the CLI
now usually records its leaf on a trailing system record that hangs off the
last message. The `no-gain` guard is what keeps a shallow post-compaction tip
from replacing a deeper pre-compaction leaf, which would be a regression dressed
as a fix.

Two more skips are worth knowing, because they are both correct:

- **`writing`** — the transcript was appended to less than 2 seconds ago
  (`QUIET_MS`, `src/resumeLeaf.ts:84`). A live writer is mid-turn, the leaf is
  stale *by design* until the turn ends, and this is the one write Flock could
  interleave with. It matters in section 7.
- **`cleared`** — a `/clear`. Naming a tip there would resurrect history
  somebody deliberately dropped.

---

## 5. Fork and Compact — `lineage.forkAndCompact`

**Correct the intuition first: the full copy still lands on disk.** Fork and
Compact is the *same* `--fork-session --resume <parent> --session-id <child>`
edge as a plain fork, with `/compact` handed to the child as its **opening
positional prompt** (`COMPACT_PROMPT`, `src/types.ts:801`, passed at
`src/commands.ts:7332`). It saves **context**, not bytes.

The whole verb rests on one property of the Claude CLI: a positional prompt
beginning with `/` is interpreted as a **command**. The Codex CLI takes a
positional prompt too, but as ordinary user text — it would open the branch by
saying the literal characters "/compact" to a model and compact nothing — so a
Codex session is offered the plain fork by name instead.

**What it looks like on disk**, from `023b71cc` (fork of `596031f1`):

| Child line | Record |
| ---: | --- |
| 8 – 1024 | the parent's chain, all **1,017** message records, copied |
| 1025 | the child's first own message: the literal text `/compact` |
| 1036 | `system` / `compact_boundary`, `trigger: manual` |
| 1037 | `user` with `isCompactSummary: true` — the summary the model wrote, 17,003 bytes of it |
| 1038 → | the **preserved segment**, re-emitted under fresh uuids but carrying its **original timestamps** — 6 such records here, the first of them the boundary's own `anchorUuid` |

That boundary's `compactMetadata` reads:

```
{ "trigger": "manual", "preTokens": 567809, "postTokens": 6034,
  "cumulativeDroppedTokens": 561775, "durationMs": 118702,
  "preservedSegment": { "headUuid": …, "anchorUuid": …, "tailUuid": … } }
```

**Across all 76 distinct compactions on this machine** (all three config roots;
every one of them `trigger: manual`, every one carrying a `preservedSegment`,
and every one followed within three records by an `isCompactSummary` record):

- `preTokens` ran **60,645 → 587,282**; `postTokens` **4,748 → 27,315**; the
  median `post/pre` ratio is **4.4%**.
- `durationMs` ran **58.9 s → 243.2 s**, median **128.2 s**. (`docs/reference.md`
  quotes a narrower 96–180 s: it was measured over `~/.claude/projects` alone,
  which is 43 of these 76. Both are right about their own corpus; this one is
  the wider net, and it is the one to quote when telling somebody how long to
  wait.)

**The price, said out loud: the compaction is a real model call over the whole
inherited history, it takes one to four minutes, and the CHILD pays it.** That
is the entire point of doing it here rather than typing `/compact` in the
parent: the parent keeps its full history, on disk and in the tree, exactly as
it was.

One caution about reading these numbers back yourself. A fork **copies its
parent's compaction boundaries too**, so a boundary near the top of a file is
not evidence that this branch compacted — `09b5e39e` and `8c0b9c89` both look
like fork-and-compacts and are plain forks of an already-compacted parent. The
correct discriminator is **a boundary record whose uuid is not present in the
parent transcript**; without it a scan overcounts fork-and-compact by roughly
five to one.

---

## 6. Resuming a closed session

`--resume <id>` with **no** `--session-id` (`src/terminals.ts:279–286`; adding
one would ask claude to both keep and replace the id). In the ordinary case
**nothing is copied**: the same transcript file is reopened and appended to, and
the conversation continues where it was.

**The exception is that the CLI may re-mint the id** — write a fresh transcript
under a fresh id and copy the predecessor's records into it as a prefix. That is
why generation chains exist at all (`src/generations.ts`). Measured on chain
`d7d507f3` (claude 2.1.240): the older generation holds 13 message records and
91,939 bytes, the successor `f024b543` holds 262 records and 830,882 bytes, and
shares **exactly those 13 uuids**. In the successor the copied records carry
camel `sessionId` = the **successor's own id**, and only the snake `session_id`
on 6 of them still names the predecessor — which is why `continuationOf`
(`src/archive.ts:304`) returns nothing for it and the chain there came from the
recorded `LINEAGE_NODE_ID` re-key instead. Flock's state holds 5 such chains
among 613 session records, so this is real but uncommon.

Four things happen around a resume, all in `src/commands.ts`:

- **The tip is resolved first.** Every verb acts on the conversation's current
  generation, never on a stale id.
- **The second-writer backstop.** A row shows as closed whenever the roster does
  not carry it — which is also what a `claude` running somewhere Flock cannot
  see looks like. Before resuming, Flock checks whether the transcript has been
  written to *after* the moment it was recorded closed; if it has, it refuses
  rather than put a second writer on one transcript.
- **The same leaf repair as the fork path** (`src/commands.ts:3920`), for the
  same reason: a plain `--resume` walks back from the same recorded leaf, so
  reopening a session could drop the tail of the very turn you were reading when
  you closed it. A **cold open** — a branch that never took a turn — repairs the
  transcript it is about to replay, which is its ancestor's.
- **A plain resume of an unpinned Claude conversation may be handed to the
  Claude Code extension** instead of opened in a Flock terminal
  (`lineage.launch.mode`). Everything above still ran; the delegate performs the
  same `--resume`.

Resuming does not compact, summarise or trim anything. A closed session comes
back with the context it had.

---

## 7. When Claude forks itself — the in-session verbs

`src/agentVerbs.ts`. The session's side is a small CLI
(`~/.lineage/flock-verbs.mjs`, installed here, 4,879 bytes) that writes a
request file into `~/.lineage/requests/`; every open Flock window watches that
directory; one window claims the file with an atomic `rename(2)` — the window
that *hosts* the session claims immediately, the others wait `CLAIM_DELAY_MS`
(600 ms) — and the winner runs `forkForAgent` → **the same `forkFlow`**, with
explicit titles and `quiet: true`. The reply goes back as a file the CLI prints
for the model to relay.

The context consequence is the part worth understanding, and it follows from
one fact: **the fork is executed while the parent is mid-turn**, blocked on the
Bash call that asked for it.

- The parent's transcript at that moment ends at the assistant record holding
  that `tool_use`. So **the child inherits the parent's conversation up to and
  including the request to fork**, and never sees the parent's own account of
  what it did afterwards.
- `repairResumeLeaf` will usually return `skipped: 'writing'` here, because the
  parent was written to less than two seconds ago. That is the right trade: the
  leaf is stale by design mid-turn, and this is the one moment Flock's append
  could interleave with the CLI's own writer.
- The fork note of section 8 is **deliberately not sent** on this path
  (`src/commands.ts:3432`): the verbs CLI already reports the new branches into
  that same turn, and typing a second copy into the terminal would both
  duplicate it and land keystrokes mid-turn.

**This section is reasoned from the code, not observed.** No agent-verb fork has
ever run on this machine — `~/.lineage/requests/` is empty and always has been —
so the exact record at which the copy stops, relative to the `tool_use` that
requested it, has not been measured. Everything else in this document has.

---

## 8. There is no sibling-to-sibling channel

This needs saying plainly, because it is easy to believe otherwise once you
have watched a session fork itself into three branches:

> **Flock has no session-to-session messaging, and never has had. Branches do
> not talk to each other.**

What exists, and only this:

| Channel | Direction | When | What it carries |
| --- | --- | --- | --- |
| The fork's **opening prompt** | parent → child | **once**, at birth | one positional argument, handed to the new CLI at launch |
| The **agent-verbs request** | session → Flock | on demand | exactly one verb (`fork`), plus a count, names and a prompt |
| The **reply file** | Flock → the requesting session | once per request | the names of the branches made, or why none were |

That is the whole set. The opening prompt is delivered at launch and never
again; there is no way for a running branch to send anything to another running
branch, and no queue, mailbox or bus anywhere in the extension.

**What is new, as of this round**, is one further channel — and it is new
construction, not an existing mechanism being switched on:

- `src/forkNote.ts` composes **one sentence** naming a new branch and, where the
  fork was given an opening prompt, what it is for. `lineage.fork.notifyParent`
  turns it on; it is **off by default**.
- `src/closeSummary.ts` parses the `isCompactSummary` record the CLI files after
  a compaction, and `lineage.close.summaryMode` decides what **Close with
  Summary** does with it: `compact-and-tell-parent` (the default),
  `compact-only`, `ask-me` (the old input box) or `off`.

Both ride the single channel that can put text into a conversation that is
already **running**: Flock typing into its terminal, the same thing the **Wrap
Up Session** prompt does. Read that literally, because every limit follows from
it:

- **It is keystrokes.** The note becomes a real user turn in the parent. It
  costs that conversation tokens and a reply, which is why a note is capped at
  400 characters (`MAX_FORK_NOTE_CHARS`) and a summary quoted to a parent is
  capped at the same budget.
- **It is one line.** `sendText` appends the newline itself, so an embedded
  newline would submit early and strand the remainder as a second turn.
- **It reaches only a session bound in THIS window.** A parent that is closed,
  hosted by another VS Code window, running outside Flock, or parked detached
  under the tmux grace has no binding here — and in all four cases **nothing is
  queued and nothing is retried**. The note simply does not happen, with one
  line in the Flock output channel. Those are the ordinary cases, not the edge
  cases, which is why `forkNoteDeliverable` is its own predicate and why the
  setting is off by default.

And note what the close-with-summary path is **not**: Flock cannot ask a model
for a summary. It has no API client. What it does is send `/compact` and read
back the record the CLI wrote. The words are genuinely the model's; the driving
is a keystroke. Nothing in the UI calls it a summary Flock generated, because
Flock generated nothing.

---

## 9. What the CLI does not tell us

Stated bluntly, because a document like this is only worth anything if its
edges are marked.

- **We cannot see the model's actual context window.** Everything here is read
  off transcripts on disk. What the CLI sends to the API on a given turn is not
  observable from outside it.
- **`preTokens` / `postTokens` are the CLI's numbers, and we have not verified
  what they count.** `023b71cc`'s boundary reports `postTokens: 6034`, while the
  summary record it wrote is 17,003 bytes on its own and six preserved records
  follow it — so `postTokens` is very likely the **summarised head only**, with
  the preserved segment carried on top of it. Until that is settled, **do not
  read `postTokens` as the child's starting context.** The experiment that
  settles it: run `/compact` in a scratch session, then `/context`, and compare
  the reported window against the boundary's `postTokens`.
- **Why Flock's forks carry no `forkedFrom` is unsettled**, and the two possible
  causes are confounded in the data here: all 5 marked transcripts are native
  `/fork` children from 2.1.210–2.1.218, and all 153 unmarked ones are Flock's
  `--fork-session --resume … --session-id` combination from 2.1.207–2.1.248. It
  could be the `--session-id` flag, or it could be a version change. Note that
  **both** writers in the installed 2.1.250 binary do stamp it — so a fork made
  today may well carry one, and no fork Flock has made under 2.1.250 exists on
  this disk yet (the newest of the 153 pairs is 2.1.248). One run settles it:
  fork a closed session under the current CLI, send one message, and grep the
  new transcript for `forkedFrom`.
- **`fork-context-ref` is new in 2.1.250 and Flock does not read it.** Its
  writer sits immediately beside `Failed to record sidechain transcript` in the
  binary, and the record-policy table classifies it `accumulate`, so it looks
  like sub-agent context rather than session forking — but that is a guess, and
  it is written down here as one. No transcript on this disk contains one.
- **The agent-verbs section is reasoned, not observed** (section 7).
- **Every number here is a claim about a closed-source CLI that ships several
  times a week.** The transcripts on disk span 2.1.181 → 2.1.250 (569 of the
  584 carry a version at all), and most of the fork evidence above is from the
  2.1.220–2.1.248 band. The CLI has moved since some of it was written and will
  move again.

---

## 10. Reproducing this

Every number above comes from three places and nothing else:

- `~/.claude/projects/*/*.jsonl` — 278 transcripts here.
- `~/.lineage/profiles/*/projects/*/*.jsonl` — 306 more. **A scan of
  `~/.claude/projects` alone sees less than half of Flock's sessions**, which is
  why `src/extension.ts` passes `extraProjectsDirs: profileProjectsDirs()`.
- `state.json` under the extension's `globalStorage` — 613 session records, 221
  fork edges, 5 generation chains.

The CLI internals were read with `grep -a` over
`~/.local/share/claude/versions/2.1.250`, a 206 MB Mach-O binary — there is no
readable `cli.js` any more.

Written 2026-08-28 against claude **2.1.250** installed, transcripts on disk
**2.1.181 – 2.1.250**. Re-take the numbers rather than trusting these when the
CLI has moved on.
