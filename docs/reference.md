# Flock — reference

The depth that does not belong on a marketplace page. For the pitch and the
feature list, see the [README](../README.md); for every setting, see
[settings.md](settings.md).

## The recommended setup

**Flock: Recommended Setup** — on the empty view, in the gear menu, in the
palette — is a checklist of what a fresh install should turn on, with the reason
on every line.

It exists because "off by default" means four different things here, and only
one of them means "you probably do not want this":

| Why it ships off | Settings | What the checklist does |
| --- | --- | --- |
| **Consent** — turning it on writes files in your home directory | `hooks.enabled`, `verbs.enabled` | Offers them, ticked. This is the group it is for. |
| **Policy** — it *is* the clean slate | `showForeignSessions`, `showArchived`, `showPhantomRows`, `onlyProjectSessions` | Never touches them. |
| **Row budget** — it works, and it costs rows | `git.branches` and the five beside it | Offers `git.branches`, unticked, and only when one of your repositories actually has two checkouts. |
| **Taste** | `soloSession`, `showTokens`, `notifications.popup`, the previews, `accounts.offerSwitchAtLimit` | Leaves them in the settings UI. |

Everything the checklist can offer:

| Step | Offered when | Ticked | Writes |
| --- | --- | --- | --- |
| **Turn tmux back on** | tmux is installed and `lineage.tmux` is `off` | yes | `lineage.tmux: auto` |
| **Make your first project** | you have no projects | yes | nothing on disk — a folder dialog |
| **Import your previous sessions (N)** | this machine has sessions with no row | yes | a row per session you tick |
| **Instant updates (hooks)** | not installed | yes | a plugin directory under `~/.claude/skills` |
| **Let Claude fork its own sessions** | not installed | yes | a skill file and a small CLI |
| **Show branch and worktree rows** | a repository of yours has ≥2 checkouts, rows off | **no** | `lineage.git.branches` alone |

Four rules it keeps:

- **Nothing is written until you confirm**, and every line says what it writes
  before you tick it. The two steps that write *files* then open their own
  dialog naming every path — the same consent the two Install verbs have always
  asked for, unchanged.
- **The receipt says how to undo each thing** it set up, per step.
- **A step you decline does not stop the rest.** Closing the folder dialog, or
  saying no to the hooks consent, is an answer about that step.
- **It never turns on `lineage.git.pullRequests`.** That is the one setting in
  Flock that reaches the network, and a command called "recommended" is not the
  thing that should switch it on. **Flock: Show Branches and Worktrees** is
  still there for somebody who wants the whole branch feature, network chip
  included — see [Turning it all on at once](#turning-it-all-on-at-once).

It is also **offered once, unprompted**, a few seconds after a window opens —
but only on a tree with no projects at all and at least two things left to turn
on, which is a first launch or near enough. Answering it either way is the end
of it; dismissing it with the X asks again next time. The same shape as the tmux
and branch-row notices, and whichever of them fires suppresses the others for
that session.

## How it works

Every window independently polls `claude agents --json` — the CLI's own
scriptable, global session registry — and reads session transcripts to recover
parent/child edges for sessions it did not launch itself. Sessions Flock
launches get a pre-minted `--session-id`, so their lineage is exact by
construction rather than inferred.

**One row per conversation.** Claude Code sometimes re-mints a session's id: a
plain resume, `/clear`, or compaction can start a fresh transcript that
continues the same conversation under a new id. Flock detects these
*generation chains* — from the transcripts themselves, and instantly via hooks
when installed — and shows a single row: the current generation, wearing the
conversation's name and history. Fork and resume always act on that newest
generation, never on a stale copy.

**Worktrees are read on a timer, and changed only when you ask.** One of the two
commands below runs on any install; the other only with the branch rows on.

The `git worktree list` probe is not part of `lineage.git.branches`, and that is
deliberate: it is what files a session running in a linked checkout under the
project that owns the repository, and turning a view option off must never move
somebody's sessions. The status probe *is* — its only reader is the `↑2 ↓1` and the `*` on a
branch row, so with the rows off it never runs.

Both are reads, both cached:

| Command | When | Cached |
| --- | --- | --- |
| `git worktree list --porcelain` | once per project directory, always | 30 s |
| `git status --porcelain=v2 --branch` | once per worktree, for the `↑2 ↓1` and the `*` on its row — `lineage.git.branches` only | 15 s |

The status probe runs with `GIT_OPTIONAL_LOCKS=0`, because `git status` otherwise
rewrites the index to save the stat cache it just refreshed — which would be a
write to your repository from a probe you did not ask for. A directory that is not
a repository, a machine with no `git` on `PATH`, and a probe that times out all
produce the same result — no branch rows, or a row with no numbers — and the tree
renders as it did before the feature existed.

Three more git commands exist and none of them can run without you:
`git for-each-ref …refs/heads/` when the **New Worktree…** picker opens, and
`git worktree add` / `git worktree remove` from the two verbs below, each behind a
confirmation that quotes the exact command. Nothing on a timer writes anything,
and no branch is ever switched or deleted.

**What a fork does to the conversation** — what the child inherits, what a
compaction costs and who pays it, and what the CLI does not tell us — is a
document of its own: [Forking and context](forking-and-context.md), measured
against the transcripts on disk rather than described.

### Turning it all on at once

**Flock: Show Branches and Worktrees** in the command palette writes four
settings at once:

| Setting                          | On       | Default    |
|----------------------------------|----------|------------|
| `lineage.git.branches`           | `true`   | `false`    |
| `lineage.git.sessionBranchDetail`| `detailed` | `standard` |
| `lineage.git.pullRequests`       | `true`   | `false`    |
| `lineage.preview.directoryModel` | `true`   | `false`    |

**Flock: Hide Branches and Worktrees** writes that last column back, so the pair
is an exact inverse — including the detail level, and including a value a
Workspace or Folder setting would otherwise show through. Each setting is still
its own switch for anyone who wants three of the four; this is for trying the
feature out, and for lighting up an Extension Development Host in one keystroke.

`lineage.git.branchDisplay` is deliberately **not** in the table. It is a
preference about how rows read rather than something to switch on, its default is
already the mode you want to meet the feature in, and writing it back on the way
out would throw away a choice you made — where every line above only restores a
default.

One of the four is worth knowing you turned on, which is why this verb leaves a
message where Flock's other switches flash the status bar: `lineage.git.pullRequests`
is the one setting in Flock that reaches the network. The other three announce
themselves the moment the tree redraws; a `gh pr list` running in the background
is the one thing here you could not have discovered by looking at your sidebar.

### Making and unmaking worktrees

Everything in this section needs `lineage.git.branches`, which is **off** — see
[Branches and worktrees are parked](../README.md#branches-and-worktrees-are-parked).
With it off, none of these verbs is in a menu or in the palette, and nothing here
can run.

**New Worktree…** is on a branch row and in the command palette. It offers the repository's local branches — minus any that
already have a checkout, which `git worktree add` refuses — plus **New branch…**
for a name that does not exist yet. Typing the name of a branch that does exist
means "check that one out here", and Flock drops the `-b` accordingly.

The path is not asked for: `lineage.git.worktreePath` decides it, defaulting to a
sibling of the main worktree. The exact path appears inside the command the
confirmation shows you. Afterwards Flock starts a session in the new checkout,
through the same path a click on an existing branch row takes.

**Remove Worktree** refuses the main worktree outright — that is the checkout your
`.git` lives in. It warns when a running Flock session has its working directory
inside the one you are removing (Flock cannot stop an agent mid-turn, and will not
pretend the removal is unrelated to it). And it asks a **second** time when the
checkout is dirty: `git worktree remove` refuses a worktree with modified or
untracked files, so getting past that needs `--force`, and `--force` deletes them.
The branch itself always survives — only the checkout goes away — so a worktree
you remove can be added back.

### The two display modes

`lineage.git.branchDisplay` decides **how a session says which worktree it is
running in**. Two ways of answering one question, and they are alternatives
rather than levels — the branch rows, the worktree verbs and the pull-request
lookup are the same in both.

**`color`**. The session's name is tinted from a
per-branch palette, and the project's branch rows are the key to it. It costs no
width at all and answers "are these two on the same thing" down a whole column
without reading a word. What it cannot say is *which* thing, so everything a
colour cannot carry — `↑4 ↓3 *`, the request — is in the hover.

**`inline`** *(the default, once the feature is on)*. The branch is written under
the session instead:

```
▾ magma-cs-mcp                                          3
  ▸ ⧉ Ranking: BM25 vs embeddings                12m ago ●
       ⇡ feat/search-ranking *      ↑4      #128 ✓
  ▸ ⧉ CSV import, the quoting case                2h ago
       ⑃ fix/csv-import                     #124 merged
      ⧉ CSV import — minimal repro                2h ago
```

The name goes back to the theme's own colour, so the only mark left competing for
your eye is the status dot. It answers *which*, and carries the state tokens
where they can be read at a glance. What it costs is **height**: twelve sessions
become twenty-four rows' worth.

**The branch rows are shut until you ask for them**, in both modes and on every
project — a repository with six checkouts is not six rows before its first
session. The way in is **Show Branches** on the project's or the directory's
right-click, or the git-branch button on the project row itself, and the answer
is remembered per project as `branchesShown`, a record only that verb writes. (A chevron there would have been the row's second one,
saying "this opens" where the mark has to say *what* opens.) The one exception is
`lineage.groupSessionsByBranch`, where the branch rows are what the sessions hang
off, so folding them by default would undo the setting.

A line is drawn only where it says something the row above it did not: on a
session whose checkout differs from its parent's, in a project with **more than
one checkout**. A fork made in its parent's worktree gets none — the spine
already draws the relationship, and a branch name repeated down it is noise. It
is suppressed entirely under `lineage.groupSessionsByBranch`, where the branch
row the session hangs off says it one line up.

A **closed** session never draws one, in either display mode and whatever the
setting says: a closed row is one row — its name and its age — so that leaving
**Show Closed Sessions Too** on permanently stays comfortable. The branch is
still in its hover. A closed row is also *transparent* to the rule above: since
it said nothing, the first live descendant in the same checkout says the branch
instead, rather than staying quiet about a worktree nothing above it ever
named.

`lineage.git.sessionBranchDetail` decides how much the line says:

| Level                  | On the line                                            |
|------------------------|--------------------------------------------------------|
| `standard` *(default)* | `⎇ feat/x *` `↑4` `↓3` — local files only               |
| `detailed`             | also the state mark, `#128 ✓`, `merged`, and `local`    |

#### The mark on the left, and the star on the right

The mark leading the line is **GitHub's own**, because a green arrow and a purple
merge are already read without being learned:

| Mark                     | Means                                    |
|--------------------------|------------------------------------------|
| `git-branch`, theme grey | no pull request — most branches          |
| green pull request       | open                                     |
| grey, ending in a dash   | draft: not asking anything of anybody yet|
| purple merge             | merged — this worktree can go            |
| dimmed, crossed          | closed and unmerged                      |

It is a `detailed`-level mark: `standard` reaches nothing but the local status
cache, and a green arrow in it would be drawn from a source that level does not
otherwise consult. The native tree draws the same five marks in the same five
colours on its branch rows, from the same table.

The **`*` for uncommitted work sits against the branch name**, not out with the
arrows. `↑4 ↓3` is where this checkout stands against its *upstream*; the star is
what is in the checkout, which is a different question and is the one Remove
Worktree asks a second time over. Every surface places it the same way — in the
native tree it leads the description, which is drawn immediately after the label.

Both are shorthand, and the row's **hover spells them out**: where the branch
stands, in words, and the request's state and title.

#### The two links

With `inline` on, **the branch name and the `#42` are links**. The name opens the
branch's page on the remote it tracks; the number opens the request. On a branch
row only the number is a link — there the name *is* the row, and clicking it
already means "start a session on this branch".

The name is a link **only when the branch has an upstream**: work nobody has
pushed has no page, and a name that looks clickable has to be. The url is built
from `git remote get-url` and the branch's upstream — both reads of the local
repository — which is why it needs no `gh` and is not behind
`lineage.git.pullRequests`. The only thing that leaves the machine is the browser
your own click hands the url to. Both verbs are on the row's right-click as well
(**Open Branch on GitHub**, **Open Pull Request in Browser**), which is where the
keyboard reaches them.

`standard` is the vocabulary git prompts and the SCM view already use, so the
line reads without being learned. `detailed` adds the pull-request chip (which
needs `lineage.git.pullRequests` on as well — that is what fills the cache) plus
the two states the arrows render as blank: **`local`**, a branch that tracks
nothing and was never pushed, and **`merged`**, the signal that the worktree can
be removed.

There is deliberately **no "can this be merged" mark** at either level.
Ready-to-merge is the *absence* of tokens — a line that says a branch name and
`#128 ✓` and nothing else. A real mergeability flag would need `gh pr view` per
branch where Flock does one `gh pr list` per repository, and GitHub computes
`mergeable` asynchronously and answers `UNKNOWN` on a first read, so the mark
would flicker on a row that repaints on every roster tick.

**Show Branch Under Session** and **Colour Sessions by Branch** in the gear menu
are the same switch, for finding it without knowing its name.

Under `lineage.viewStyle: native` the line degrades to the branch **name in the
row's description**, left of the age — a `TreeItem` has one label and one
description and nowhere to put a second line, the same concession the branch rows
already make about their colours.

### What the `+` does

Every project and every subproject row carries a `+`.
`lineage.git.newSessionInWorktree` decides what it means: **off**, it starts a
session in that directory as it is; **on**, it cuts a new worktree first and
starts the session there. The button's tooltip says which, before it is clicked.

It is a default and never a restriction — both verbs are on the row's right-click
either way. Branch rows carry a `+` too, including a branch with **no checkout**:
there it runs the worktree flow for that branch and starts the session in what it
made. Every path that writes still shows the exact `git worktree add` first.

### Pull requests

Off by default, behind `lineage.git.pullRequests`, and the only thing in Flock
that reaches the network. It needs `lineage.git.branches` on as well — the chip it
draws lives on a branch row, and there are no branch rows without it. Turning both
on has Flock run

```sh
gh pr list --state all --limit 100 \
  --json number,title,state,isDraft,headRefName,url,statusCheckRollup
```

in each project's repository — through the [`gh` CLI](https://cli.github.com) you
installed and authenticated, never as an HTTP request from the extension, and
never with a bundled API client. Flock does not see, store or refresh a token, and
`gh` decides which host it talks to.

`--state all` rather than the default open-only, because **merged** is the state
that matters most on a branch row: it is the signal that the worktree beside it is
finished and can be removed. When a branch has several requests, a live one wins
over a finished one and the higher number wins within a tier, so the chip does not
alternate.

There is no polling timer. A repaint schedules the refresh, and the refresh is
gated on the setting *and* a visible Sessions view — so a hidden sidebar asks
nothing. At most once every five minutes per repository, anchored on the main
worktree so a project with six checkouts makes one call, not six. A failure is
remembered for fifteen minutes instead of five, because failure is the common case
and usually permanent.

Failure is silent by design. Missing `gh`, no `gh auth login`, no GitHub remote and
a branch with no request are one outcome from the outside: the row renders exactly
as it does with the setting off. One line goes to the **Flock** output channel, once
per repository per window; there is no dialog and no repeating toast.

**Create Pull Request…** runs `gh pr create --web`, which opens the compare page
in your browser. Flock never submits it. The title, the body, the base branch and
the decision to press the button are yours — a verb that created a request from a
sidebar would turn a mis-click into a notification for everybody watching the
repository.

There is no daemon, no background service, and no Python. Your editorial layer
(titles, summaries, deleted flags) lives in the extension's own `globalStorage`
directory; nothing else on disk is modified.

**Hooks are optional.** Flock is fully functional without them. If you opt in,
they install as a self-contained plugin under `~/.claude/skills/lineage-events/`
and are removed by deleting that directory. Flock **never** edits
`~/.claude/settings.json`.

## Projects

A project is **a name and a directory**. Create one from the new-folder icon at
the top of the view (**New Project…**) or from a folder row's **Make a Project
from this Folder…**; either way it is one folder dialog and no confirmation step.
The name is generated from the directory and selected on its own row for you to
type over.

Membership is derived from each session's working directory, never stored on the
session: the project whose directory is the *longest* match wins, so `~/code`
and `~/code/api` can both be projects and each session lands in the right one.
Nothing is written to your session records, so renaming a project, adding a
directory, or deleting it entirely never rewrites session state.

A right-click gives you nine things — **Switch Workspace…** (not in the
one-folder-per-project model: scope this window to this project, from the row you
are already looking at),
**New Session**, **New Chat**, **Old Chats…**, **Archived Sessions…** (this
project's archived sessions, searchable by name, showing each one's age and
directory, restorable several at a time),
**Add Subproject**, **Rename
Project**, **Close Project**, **Delete Project** — and **Settings**, which holds
what a project *is* rather than what you do to it: which directory is the main
one, which to remove, the provider, the AI account, **Switch Workspace…** again
and **Open in New Window**. Deleting a project
removes the grouping only — never a directory, session or transcript.

Dragging a session onto a project row adds that session's directory to the
project. That is the only thing a drag does.

**Lineage is not draggable.** Only a top-level session can be picked up, and a
project row (or one of its subproject rows) is the only place it can be dropped
— so a fork cannot be dragged out of the tree it branched from, and nothing can
be dragged into one. A tree that says "this branched from that" has to be true,
and it is: every edge comes from the fork that created it or from the
transcripts, never from a gesture. Project rows themselves do not drag either.

### Subprojects

**A subproject is a lane of work in a directory.** A project is scoped to one
directory, and that is the ordinary case: a single-directory project with no lanes
has no subproject rows at all, and its sessions sit directly under it exactly as
they always have.

There are two ways a project comes to have rows, and they are different questions:

- **Two lanes in the same directory.** `~/magma-cs-mcp` is one folder, and "the
  server rewrite" and "the CS tooling" are two bodies of work in it. Nothing on
  disk tells those apart — same path, same repository, same branches — so a lane
  has a **name**, and that name is the only thing that can.
- **Two directories.** A project spanning a repo, an infra directory and a notes
  folder gets a row per directory, labelled by its basename. These need no name:
  the directory is the answer.

**Add Subproject** asks which directory the lane works in — the project's own
directories, or **Another directory…** for one it does not cover yet — and then
asks for a name. The directory pick is offered even when the project has only one
directory, because those are always both things this verb can mean. It creates
nothing on disk: Flock does not make directories, and a directory that does not
exist yet is one to make in a terminal or a file manager and then pick here.

**A new lane is empty.** It does not adopt the sessions already running in that
folder, and there is no migration step that sweeps them in. A name you have just
invented cannot describe work that predates it — half of what is in `~/magma-cs-mcp`
today is the *other* lane's, and Flock has no way to know which half. So the folder
keeps a row of its own, labelled by its basename, holding everything nobody has
assigned to a lane: the sessions that were there before, and any started by hand in a
terminal since. **That row goes away by itself once it is empty**, so filing the last
one leaves you with the lanes and nothing else. It is a remainder, not a permanent
leftover bucket.

**Move to Subproject…**, on a session row, is how work gets filed. It offers the
subprojects of the project *that session* is in — derived from the session's own
directory, not from the row you clicked, and reaching a session in a linked
worktree through the repository it belongs to. Starting a session from a lane's
`+` files it there from the beginning; this is for everything that was already
running, which is most of what is in a folder the day you name a lane in it.
**No subproject** takes one back out, and is not a delete: the session returns to
being placed by its directory.

**Rename Subproject** and **Remove Subproject** are on a lane. Removing one removes
a **name**: the directory stays, nothing running stops, and the sessions filed there
keep their rows — they go back to being placed by directory, which is where a session
you started outside Flock already sits. On a plain **directory** row, Remove
Subproject takes the directory off the project instead, along with any lanes named in
it — a lane whose folder the project no longer covers could never hold a session
again — and the project's main directory is refused, since that is its own address
and **Delete Project** is the verb for it.

**Which lane a session is in is the one thing Flock stores about a session.**
Everything else — which project, which directory, which branch — is derived from its
working directory, every render, and nothing is written to your session records. Two
lanes in one folder have identical working directories, so there is nothing to derive
from: a session belongs to the lane whose `+` started it, recorded once at launch and
never re-decided. A fork carries its parent's lane, and a `/clear` carries the
conversation's. A session Flock did not start carries nothing, and lands on the row
for the directory it is running in — never in a lane, because guessing which one
would be wrong about half the time.

Which **directory** row an unstamped session lands in is the same longest-match rule
project membership uses: with `~/code/app` and `~/code/app/api` both listed, a
session in `~/code/app/api/handlers` is under `api` and one in `~/code/app/lib` is
under `app`.

**There is no project-wide row.** Once a project has two directories, every
session it claims belongs to exactly one of them, and the main directory is
directory number one rather than a bucket for the ones that fit nowhere. What
makes that true rather than merely stated is that a directory claims a session the
same way a project does — the directory *plus the worktrees of the repository at
it*. So a session in `~/code/app-feat`, a linked worktree of the monorepo at
`~/code/app`, belongs to `app`; and one in `~/code/app-feat/api` belongs to **api**,
because that is what it is working on. A worktree path is read as the main
checkout would spell it, which is the spelling your directory list was written
against.

A lane has a **name and a directory, and nothing else**: no provider, no AI
account, no saved workspace, no settings menu, and it cannot contain another lane.
The project's own `+` is withdrawn while the rows exist, because a `+` there would
have to guess which of them you meant.

> **Projects inside projects is retired, and this is not it coming back.** Until
> 0.1.1 a subproject was a whole project record filed under another one — its own
> name, provider, AI account, routing and saved workspace, nested to any depth — and
> all of that was decided for something whose job was sorting rows. The first launch
> of 0.1.2 folds every nested project into its ancestor's directory list and removes
> the child record; the child's provider, account override and closed-ness do not
> survive, and the **Flock** output channel names each one it folded.
>
> A lane is a name, a directory and a parent. It exists because the directory-only
> model could not express two pieces of work in one folder — which is a real thing
> people do, and the only thing that came back.

### Branch grouping

Both of these need `lineage.git.branches`, which is **off** — see
[Branches and worktrees are parked](../README.md#branches-and-worktrees-are-parked).

`lineage.groupSessionsByBranch` changes what a project's branch rows *are*.
Normally they are a list above the sessions: which worktrees exist, what colour
each one is, click to start a session there. With the setting on, each branch row
becomes a container — its sessions hang underneath it, it folds shut, and the `+`
on the row is what starts a session in that worktree.

It applies to a project with two or more worktrees, which is the same threshold
the branch rows themselves appear at, and **not** to a project that has split into
subproject directories: a session cannot be filed under a directory and a branch
at once, so the directories win and the branch rows stay the flat list. Anything
the branch rows do not account for — a session on a branch you folded away into
**Others**, or in a project directory outside the repository — keeps its place
directly under the project. It is a layout, never a filter: no setting in Flock
hides a session's row.

### The directory model (preview)

`lineage.preview.directoryModel` moves the branch rows off the project and onto a
**directory**, and lists **every local branch** of that directory's repository
instead of only the checked-out ones. It needs `lineage.git.branches` too, and it
is off by default.

The two changes are one idea. A project's directories are its subprojects, and a
directory is exactly one git repository or none — so a directory is what a branch
belongs *under*. A project spanning three repositories used to show three branches
called `main` with nothing to say which was which; now each one sits under the
directory it came from. A project with a single directory keeps its branches on the
project row, because that row *is* its directory.

And once a branch row is anchored on a repository rather than on a union, listing
the whole repository becomes affordable:

```
▾ app                      ← the project, and its first directory
    main            ↑1     ← this directory's own checkout
  ▸ Branches (183)         ← every other local branch, shut
  ▾ api                    ← another directory, another branch list
      main
    ▸ Branches (12)
  ▾ notes                  ← not a repository: no branches at all
```

Outside the fold: the directory's **own checkout**, and any branch with a
**session running on it**. Everything else folds — including a worktree with
nothing running in it, which is the deliberate difference from the older policy: a
checkout you are not using this week is a directory on disk, not work in flight.
**Hide Branch** and **Show Branches…** still override both directions.

The fold is **shut by default** and holds the rest of the repository newest-commit
first, each row with its age (`2d`, `3w`). A branch with no checkout has no
directory to run in, so it has no `+` and no session verbs — its swatch is hollow
and its menu offers **New Worktree…**, which is the verb that gives it somewhere to
live. Nothing about the fold hides a session: a branch cannot be folded away while
something is running on it.

Two sessions or more on different branches of one directory nest under their branch
rows; a single promoted branch draws its sessions directly under the directory,
because nesting costs every row a level and one branch has nothing to tell apart.

> Draws in the **inline** sidebar (`lineage.viewStyle: inline`, the default). With
> `native` the tree keeps the rows it has today — directories and their sessions,
> no branch block — which is what it already drew.

## Notifications

The red dot is an **unread marker**. It appears when a session completes a turn
(or asks for input) while you are not looking at it, and clears the moment you
focus that session. Red rather than green because it is the one row asking for
you — green is what everything else on screen uses to mean "nothing to do here".
It rolls up onto the project row, so a collapsed project still shows there is
something to come back to — and the roll-up asks exactly the question the rows
below it do, so a project dot always has a lit row under it: a session that is
closed, or busy again, or muted, lights nothing.

The numeric badge on the view container counts something else: how many
sessions are **running on this machine** — open tabs plus any session still
running under a detach grace, in every window — so a number you did not expect
is a process you did not know about. It is **off by default**
(`lineage.runningBadge`), because a number that changes every few seconds on the
icon you navigate by is motion with nothing to do about it. With it on, a
running session whose row would be filtered out of this window (another
folder's work in folder mode, a closed project's) renders in a collapsed
**Running elsewhere** group at the bottom instead: the badge never counts a
process you cannot see and act on.

The **bell** — leftmost in the view title — lists the latest finished sessions,
unseen above a divider, then history, each with its project and how long ago it
finished. Clicking an entry focuses the session and marks it read; *Mark All
Notifications as Read* is in the gear menu, and a command of its own.

Each row carries an **×** that takes it off the list without going near the
session. That is per *finish*, not per session: the next turn that session
completes puts it straight back. Silencing a session for good is Mute, which is
a different verb on purpose — a one-click × that could permanently hide a
session's notifications would be the most destructive control in the popup.

A session whose work has **fanned out** — a workflow, a Task, sub-agents of any
kind — carries a small **run-all** mark beside its name while that is
happening. The dot cannot say it: from the outside a session with nine agents
under it and one thinking about a typo are the same word, `busy`, so they were
the same amber dot. The mark is read from the transcript the sidebar already
reads on every tick (an `isSidechain` line no more than 90 seconds behind the
session's own last line), which is why it costs nothing and why it says only
that the work fanned out — not how many agents, or which kind. It goes out with
the turn that raised it. The native tree draws no mark and says the same thing
in the hover.

A silenced session never dots, never rings the bell, never toasts, and carries a
**struck-through bell** beside its name, so a session that has gone quiet
because you silenced it cannot be mistaken for one that has gone quiet because
nothing happened. The menu offers whichever half applies rather than a toggle
you have to guess the direction of. Muting follows the conversation across
re-minted session ids.

**The bell stops at the tree's edge.** Only a session with a row can dot, ring
or toast. The roster and the hook stream are both machine-wide, so without that
rule a `claude` run in some other app's terminal would notify here — and, worse,
the finish-stamp would quietly import it into your tree for good. A session
running elsewhere stays silent until you add it (or turn
`lineage.showForeignSessions` on), and from the moment it has a row it notifies
like any other.

## Workspaces

A **workspace** scopes a window to one project. Everything in this section
belongs to the **Auto-switch** window model (`lineage.mode: project`) — the
shipped default is *One folder per project*, where a window simply is the folder
you opened and none of this runs. [The three window models
→](settings.md#the-three-window-models)

Inside Auto-switch, the workspace **follows your focus** by default: start
working in a session that belongs to another project and the window switches to
that project's workspace by itself — nothing is stopped and nothing asks a
question. Turn that off with `lineage.workspaces.autoSwitch`. You
can always switch explicitly from the palette (**Flock: Switch Workspace…**) or
a project row's context menu — and, in the auto-switch model, from the
`$(layers)` status-bar item, which that model is the only one to draw.

### Where you are

The `$(layers)` item says where the conversation **in front** is, not merely
which project the window was last switched to — `Magma Score › ingest`, with the
branch when the branch is not the one you would assume (a linked worktree, a
detached HEAD, a lane's pinned branch, or any name that is not `main`, `master`,
`trunk` or `develop`). It moves on **focus**, so switching between two lanes of
one project — which is not a workspace switch at all — is visible. The Explorer's
**Project** view carries the same answer as a row of its own, untruncated.

When the window and the keyboard disagree — you focused a conversation belonging
to another project, with auto-switching off — the line carries both names
(`App → API`) and clicking it switches straight to the one you are in. A project
you have **closed** is never named there: putting one away removes its rows, and
this must not become the one place it comes back.

**Outside auto-switch there is no item at all.** The `$(layers)` item belongs to
the window that rearranges itself, and it is drawn in that window and no other.
That covers both of the other models, for two different reasons: the
one-folder-per-project window has no in-window switching to advertise, and the
Flock-only window has the switch verb but nothing that fires it for you — so a
button offering one would be chrome nobody in that model asked for. Switching
there is something you do on purpose, from a project row or the palette.

What those windows show instead is the Explorer's **Project** view: the same
lane and the same branch, untruncated, in a row of their own, decided once by
the same code that writes the status line. A one-folder-per-project window that
has never been converted has neither — which is the honest answer for a window
that already *is* its folder, since the one thing it could add is the name of
the folder in your title bar.

Switching:

1. **saves** the current layout — file tabs with their editor groups and
   pinning, plus your session tabs, including which tab had the keyboard —
   under the project you are leaving;
2. **hides** what does not belong to the target. A foreign *session* leaves the
   screen one of two ways. With tmux it **detaches under a grace**: the tab
   closes, the conversation keeps running in the private server, and **its row
   stays** — the one detached-running state, and it always has a row, because a
   running process with nothing on screen is the state this design exists to
   make unreachable. The row's hover says the process is detached and when it
   closes; the row itself reads like any other. At the deadline it ends to level
   2 (no process, a **closed** row, `--resume` brings the conversation back
   whole). Without tmux it
   closes to level 2 straight away. Nothing ever asks to terminate. Unsaved
   editors are never closed, terminals Flock does not own are never touched, and
   a session mid-turn is never killed;
3. **restores** the target's saved layout: files reopen in their editor groups,
   sessions still under the grace re-attach to the tmux session they were
   detached from, and one that ended (or died) while out of sight is resumed from
   its transcript;
4. **reveals** where you landed: a manual switch selects the target's folder in
   the Explorer, and the summary line names the branch checked out there — for a
   subproject that pins a branch, the folder is whatever worktree has that branch
   checked out today. Purely a courtesy: a folder outside git reveals silently,
   and no switch ever creates a worktree;
5. **lands** on one tab, chosen rather than raced. When the switch happened
   because you clicked a session of another project, that is the session you end
   up in; otherwise it is the tab the target's layout was left on, file or
   session.

Layouts persist in the extension's own storage, so they survive window reloads
and full app restarts. *Leave Workspace Mode* saves and closes nothing. Browser
(webview) tabs cannot be captured — the API exposes no URL to restore — so they
close on switch and are not remembered. With
`lineage.terminalLocation: "panel"` a session has no editor tab at all, so
layouts are files only and switching leaves your terminals exactly where they
are.

### What the window follows

In the **Auto-switch** model, and only there, the window points *itself* at the
conversation in front — one directory in the Explorer, one repository in Source
Control. The choice is made once, in `src/follow.ts`, and both surfaces render
that one answer, so they cannot disagree about which piece of work you are
looking at.

The directory is the first of these that actually **contains** the session's
working directory, deepest winning:

1. **the lane you started it in** — a subproject you named, translated into the
   checkout the session is running in. A name somebody typed outranks every
   derived rule;
2. **the project directory that holds it**, asked in the *main checkout's*
   spelling and answered in the session's own. This is the step that makes a
   split monorepo work: you named `api` and `web` once, in whichever checkout
   you had open, and every other checkout of that repository has the same shape
   under a different prefix;
3. **the checkout itself**, which is also the Source Control answer;
4. **the session's own working directory**, when nothing above holds it.

The containment rule is what makes the ladder safe to fall down: a candidate
that does not contain the session is describing somewhere else, and rooting a
file tree there shows you a tree you are not editing. A checkout beats a folder
claim at equal reach for a related reason — a project pointed at a parent of
three repositories must not root the tree above the one repository Source
Control is about to show.

Two states deliberately say nothing rather than guess. With no conversation in
front — you clicked into a file, the window just opened — **nothing moves**; a
file tree that blanked itself for that would be the worst thing this feature
could do. And while the git probe for a directory is still cold, Source Control
is left alone; the probe lands a moment later and the view repaints, which is
the same trade the branch chips already make.

`lineage.explorer.followProject` turns off the *file tree* half and nothing
else. `lineage.explorer.scope: "project"` also stops the tree following, because
a scope that expands every project directory into its own root has nothing left
to narrow. Source Control follows in both cases.

### Does Source Control really follow?

The Explorer half of this is not in doubt: Flock splices the directory into
`workspace.workspaceFolders`, which is the only way to move the built-in file
tree at all, and it has worked that way since the anchor design shipped. Source
Control rides on the same splice — VS Code's built-in git extension listens for
workspace folders appearing and opens a repository for each one — and *that* is
the part worth checking on your own machine before trusting it, because a
directory that sits **below** a repository root may instead produce VS Code's
"a git repository was found in the parent folders" prompt and an empty SCM view.
Flock also asks the git extension directly (`getAPI(1).openRepository`), which
is the documented way past that prompt, but which editor builds honour is not
something this repository has been able to prove from the outside.

The experiment takes a minute, and this repository has the right shape for it:
`.claude/worktrees/` holds several real linked worktrees of the main checkout.

1. `F5` in this repository to launch the Extension Development Host.
2. In that host, open **Output → Git** and set the channel's log level to
   **Trace** (the Output panel's gear).
3. Run **Flock: Follow the Session I Am In** once and let the window reload.
4. Focus a session running in `.claude/worktrees/donations` — a whole linked
   worktree, so the spliced folder *is* a repository root. Watch the Git log
   for `[Model][onDidChangeWorkspaceFolders]` naming that path, then
   `[Model][openRepository] Opened repository` for it, and check that the SCM
   view shows **donations** on the `donations` branch rather than the main
   checkout on its own.
5. Now focus a session running in a *subdirectory* — say `src/` inside that
   worktree — so the spliced folder sits below the repository root. This is the
   case in question.

Two outcomes, and they mean different things:

- **The SCM view shows the worktree.** The splice, or Flock's direct
  `openRepository`, got there. Nothing to do.
- **The SCM view is empty and the log says `Repository in parent folder`.** Your
  editor's git build declined the direct open too. The remedy is yours to set,
  not Flock's: `"git.openRepositoryInParentFolders": "always"`. It is left to
  you deliberately — it changes behaviour for every repository you ever open,
  and an extension writing that on your behalf would be making a decision about
  your whole editor to fix its own feature.

Either way the Explorer half is unaffected, and nothing Flock opened is ever
closed by Flock: removing the spliced folder is what disposes the repository,
which is the git extension's own bookkeeping and not a list of yours being
edited behind your back.

### Going to a session's workspace

Right-click any session row — live or closed, in either sidebar — and
**Open Workspace for This Session** opens a window on that conversation's own
directory. It is the row-level counterpart of a project row's **Open in New
Window**, and it is the answer to "go to that workspace" in every window model,
not only the ones that switch.

Which directory, in order:

1. **the session's worktree** — the checkout its working directory is in. For
   anyone running one agent per worktree this is the answer that gets both
   halves right: the files in the Explorer, and *that branch* in Source Control
   rather than the main checkout's;
2. **its subproject's directory**, when it is filed in one and that directory
   actually contains the session. A lane may point somewhere else entirely — the
   directory is editorial, and a lane that pins a branch can be redirected — so
   one that does not contain the session is skipped rather than trusted;
3. **the directory its project claims**, falling back to the working directory
   itself when no project claims it.

Every rung *contains* the session's working directory, and that is not tidiness:
a window fences what it may launch and what it may show to the folders it
opened, so a window opened on a directory that did not contain the session would
have no row for it and could not resume it.

**It will not open a second window on a directory some window already has.** If
this window already covers it, the row is revealed here and the status bar says
so; if another live window covers it, that window is raised and the row revealed
there. Axel asked for a new window and that is the ordinary outcome — but two
windows on one directory is two roosts for one piece of work, which is the shape
the 84-detached-sessions incident was made of.

**The session keeps running where it is.** Opening its workspace moves nothing:
the conversation keeps its tab and its process in the window it started in, and
the new window draws its row like any other. Resuming it *there* works once it
has been closed here — while it is still running, a resume is refused, because
`claude --resume` reuses the session id and two processes appending to one
transcript is exactly what that refusal exists to prevent.

### Why tmux is required

Parking a session means hiding it because you switched to another project. There
are two ways Flock can do that, and which one you get depends only on whether
`tmux` is on your `PATH`.

| | **With tmux** | **Without** |
| --- | --- | --- |
| Switching away | the client detaches, the process keeps running | the terminal is closed |
| Coming back | reattach, live state intact | `--resume` from the transcript |
| A session mid-turn | detaches and keeps working while hidden | never closed, so it stays on screen instead |
| What it costs you | nothing | whatever the session was in the middle of |

This is why tmux is listed as required rather than recommended. The fallback is
real and fully wired, and it will not close a busy session rather than interrupt
one. But it cannot hide a working session either, so a busy tab from another
project just stays where it is, and coming back replays a transcript instead of
picking up a live process. Neither is what the feature is for.

```sh
brew install tmux          # macOS
sudo apt install tmux      # Debian / Ubuntu
sudo dnf install tmux      # Fedora
sudo pacman -S tmux        # Arch
```

`lineage.tmux` defaults to `auto`, and the binary is looked up on every launch.
Installing tmux takes effect on the next session you start. No reload, nothing to
switch on. Check it with `tmux -V`.

Sessions run under a private server, `tmux -L lineage`, with a generated config
that keeps it out of sight: no status bar, no prefix key. That is a separate
socket from your own tmux, so your sessions, keybindings and config are never
touched and `tmux ls` will not list Flock's. Sessions you started outside Flock
are never wrapped either way.

Windows always uses the fallback. `findTmuxBinary` returns null there no matter
what. Set `lineage.tmux` to `off` to force the fallback anywhere else.

Flock says this once, in a notice you can dismiss, if it finds you without tmux
while workspaces are on. It never asks twice.

## Using Flock alongside the Claude Code extension

Flock does not need to be the only way you run Claude. The session list comes
from `claude agents --json`, which is **machine-wide**, so Flock can see a
conversation whoever started it.

**Whether a foreign session gets a row is now yours to decide.**
`lineage.showForeignSessions` is **off** by default: the tree holds what you
told Flock about — sessions launched here, bound to one of its terminals, or
added by hand — and a `claude` running in some other terminal neither draws a
row nor rings the bell. The two doors in are **Add Existing Session…** on a
project's right-click (its folders' sessions, live and finished, plus a
paste-an-id box) and **Import Previous Sessions…** (everything on the machine,
all at once or picked one by one, in the gear menu and on the empty view).
Turn the setting on and every foreign session is back in the tree the way
Flock originally worked — the table below then applies to all three columns
with no adding required.

There are three setups, and the difference between them is one thing: whether
Flock owns the process.

| | **Flock-launched** | **Claude Code extension** | **`claude` in a terminal** |
| --- | --- | --- | --- |
| A row in the tree, in its project | yes | once added, or with `showForeignSessions` | once added, or with `showForeignSessions` |
| Age, token count, status dot | yes | yes | yes |
| Fork tree — who forked from whom | exact | inferred | inferred |
| Notifications: dot, bell, toast | yes | yes | yes |
| Filed under its project, worktrees included | yes | yes | yes |
| Rename the row, mute it, archive it | yes | yes | yes |
| **Fork Here** — branch off a copy | yes | yes | yes |
| Copy Session ID | yes | yes | yes |
| **Open Workspace for This Session** — a window on its directory | yes | yes | yes |
| Click the row → the session | reveals its tab | reveals the terminal, when it is running in one | reveals that terminal |
| **Close** / **Close with Summary** | yes | no | no |
| **Wrap up** prompt | yes | no | no |
| tmux parking on a workspace switch | yes | no | no |
| Account routing and pinning | yes | no | no |
| **Move to Account...** — switch a conversation's subscription | yes | no | no |
| Flock-named tab | yes | no | no |

**One caveat on the middle column, stated plainly.** Everything Flock knows about
a session it did not start comes from `claude agents --json`, and that list is
written by the Claude CLI itself — one entry per running CLI process, under
`~/.claude/sessions/`. A conversation the extension runs **in a terminal**
(`claudeCode.useTerminal`) is such a process and appears. The extension's native
UI also runs the CLI, and the registry entry carries the entrypoint the extension
sets, so it is expected to appear the same way — but Flock has no way to
*guarantee* that, because whether a given CLI mode registers is the CLI's
decision and an undocumented one. If a conversation does not turn up in the tree,
that is why, and nothing in Flock can fix it. Everything below degrades to "no
row", never to a wrong row.

**Exact versus inferred lineage.** Flock's own launches pre-mint the session id,
so a fork's parent is recorded rather than worked out. For everything else the
edge is read back from the transcript, and from the launching process's command
line where that is readable — good enough that a `/fork` typed into a panel
terminal nests correctly, and honest enough to leave a row at the top level
rather than guess. A wrong edge is worse than no edge.

**Rows Flock does not own say so.** They carry a quiet **elsewhere** after the
age, and the hover spells it out. The verbs that could only lie about such a row
are not in its menu: closing a session Flock cannot signal would write a
timestamp onto a conversation that carries on running, and Wrap needs a terminal
to type into.

**Clicking a row reveals, it never duplicates.** For a session running in an
integrated terminal — `claude` in the bottom panel, or the extension with
`claudeCode.useTerminal` on — Flock identifies that terminal from the process
tree (`Terminal.processId` is the shell; the session's row carries Claude's pid;
Claude is a descendant) and brings the tab forward. That is the whole of the
interaction: nothing is typed into it, nothing is signalled, no transcript is
opened. The match declines whenever it is not certain — two conversations under
one shell after a `/fork`, a terminal inside a terminal — and then you get the
old behaviour, an offer to fork a copy you own. Two Claudes on one transcript is
the outcome all of this exists to avoid.

**Handing conversations to the extension.** Set `lineage.launch.mode` to
`claudeExtension` and the extension's own UI becomes where sessions open, in
both directions:

- **New conversations.** Flock's `+` runs the extension's **New Conversation**
  command instead of opening a terminal — which opens in *your*
  `claudeCode.preferredLocation`, sidebar or editor. Flock then watches for the
  session to appear on the roster and files it under the project and name your
  click implied.
- **Reopening a closed row.** Click a closed session (or **Resume Session…**)
  and Flock hands the reopen to the extension's open-session command — the one
  its own `claude-code://open` deep link runs — so the conversation comes back
  in the extension's UI, not in a terminal. Every guard Flock runs before a
  resume still runs first: tip routing, the second-writer backstop, resume-leaf
  repair.
- **Clicking a live session the extension hosts.** Such a row is *foreign* to
  Flock (no terminal to reveal), and its dead-end dialog grows an **Open in
  Claude Code extension** button that reveals the panel the session is open in
  (the extension keys panels by session id). Offered, not automatic, because a
  foreign row can also be a process in another editor entirely — opening *that*
  in a panel would put a second Claude on its transcript.

The right-hand column of the table above is what you get from then on — the row
and the tree, not the ownership verbs. The setting is only honoured while that
extension is installed; without it Flock opens the session itself and says so
once.

Four things the mode deliberately does not delegate:

- **Fork.** `--fork-session` is a launch-time CLI flag no command the extension
  contributes carries, so there is no way to ask it for a branch of a specific
  conversation. Fork always opens Flock's own terminal, which is also the only
  way it can inherit the parent's history.
- **A launch routed to another account.** Project and default routing resolve
  *before* the handover, and a conversation they send to another provider's
  CLI — or to a Claude account with its own config directory — opens in
  Flock's own terminal instead, with a status-bar note saying so. The
  extension runs on the machine's own login: it cannot start another
  provider's CLI at all, and a session it started for that account would look
  routed in the tree while actually running — and writing its transcript —
  where the account's next resume would never look. A launch routed nowhere,
  or to the default account, is exactly what the extension runs anyway and
  keeps being handed over.
- **A resume pinned to another account.** The same rule on the way back in: a
  conversation whose account pin names its own config directory lives in a
  transcript the extension would not find, so that resume keeps Flock's
  terminal (and its pinned environment).
- **Picking an account by hand.** A delegated launch runs under the delegate's
  own environment, so it cannot be pinned to one of your subscriptions. **New
  Session From…** therefore keeps launching here.

**The terminal panel works the same way it always did.** If you prefer sessions
in the bottom panel rather than as editor tabs, that is not this mode — set
`lineage.terminalLocation` to `panel` and every Flock verb keeps working there:
launches open in the panel, clicking a row reveals its panel terminal, and
workspace switches leave panel terminals alone entirely.

**What Flock never does to somebody else's session.** It does not attach to a
pty it did not create, write to a transcript another process is holding, send
keystrokes to a terminal it does not own, or close one. Terminals Flock does not
own are also left alone by workspace switching.

### Codex, Gemini and other CLIs

Session rows come from the Claude CLI's own registry, so today every observed
session is a Claude session. The other provider ids exist so a **project** can
declare what it runs — that is what picks the logo — and so an account can keep
its own config directory. They are not yet somewhere a session starts: the
launcher execs one binary.

## Close and archive

The tree is a map of your work, and **tab state is not tree membership**: a
session whose tab is closed is still *your session*. It stays in the tree as an
inactive row until you explicitly archive it. That leaves exactly two verbs,
neither of which loses data:

| Verb | The tab | The row |
| --- | --- | --- |
| **Close** | **Closed.** | **Stays** — flips to inactive: dimmed, sorted below live work, forks still nested under it. |
| **Archive** | **Closed first**, if it was still running. | Gone. Forks move up to the nearest visible ancestor, so no lineage is lost. |

The two are deliberately asymmetric in cost. Close is one click and asks
nothing, because it loses nothing you cannot get back by clicking the row
again. Archive stops to ask, because a row you cannot see is a session you will
not remember you have.

**Where a promoted fork lands.** When a row goes away and its forks move up,
they are sorted into their new siblings by the same key the sibling list always
uses — oldest first, with everything that is over (closed, archived, or an
inferred *(gone)* ancestor) below everything that is still running. They do not
inherit the slot the vanished row held. That is the difference between a tree
you can predict and one that appears to reshuffle itself: closing a session in
the middle of a tree must not move a fork that did not change.

**Close ends the tab, not the row — and never asks.** Because a Flock terminal
*is* the `claude` process, closing the tab ends the run; but the row stays right
where it was, so there is nothing to confirm. Click it, or the inline resume
button, and the session picks up from its last saved turn. Closing the tab with
its own × does exactly the same thing. If VS Code itself asks about terminating,
that is its own `terminal.integrated.confirmOnKill` setting.

**A session you never wrote in opens too.** Claude writes a transcript on the
first turn, so a session you created and walked away from has a row and nothing
on disk — there is no conversation to pick up from. Clicking it starts one under
the same row: same id, same directory, same name, same account. A *fork* you
never wrote in comes back as the fork it was, showing the history it branched
from.

**Archive means "this does not belong in the tree".** Flock asks first — one
dialog that says what it keeps, how many sessions it is about to close, and
where the row comes back from — and then offers **Undo** on the toast.

Archiving a session that is still running **closes it first**. It used to
write the row away and leave the process going, which put a live session behind
no row at all — and because every verb's picker skips archived rows, you could
not even close the thing you had just archived. The one case it refuses rather
than forces is a session another window, or another app, is running: it says
which one, and writes nothing.

The durable way back is **Archived Sessions…** on the project's row: a
searchable list of everything you archived in that project, showing the name,
the age and the directory, restoring as many as you tick in one press of Enter.
**Restore Archived Session…** is the same thing for the whole machine — the
door for a session whose directory no project claims, or whose project you
cannot remember. **Archive Stale Sessions…** is the bulk form: oldest-first,
pre-ticked at `lineage.staleAfterHours`, undoable the same way, and with no
second dialog, because the checklist you just filled in was the question.

Nothing here touches a transcript. Any session that ever ran is still resumable
with `claude --resume <id>`, and Undo brings back the row but not the process —
a resume brings the conversation back.

### Closing with a summary

**Close with Summary** used to open an input box and ask *you* to type the
summary — of a conversation you had just been reading, with no help from the one
thing on screen that already knew what it concluded. It now does what you would
do by hand: it compacts the branch and keeps what the compaction said.

**How that works, precisely, because it matters.** Flock cannot ask a model for
a summary. It has no API client, and the only way it can speak to a conversation
that is already running is by typing into its terminal. So it **sends
`/compact`** — a command the Claude CLI interprets — and then **reads back the
summary the CLI wrote** into the transcript. The words are genuinely the model's.
The driving is a keystroke. It is not a scrape of the last exchange, and it is
not something Flock composed.

`lineage.close.summaryMode` picks between four behaviours:

| Value | What happens |
| --- | --- |
| `compact-and-tell-parent` | The default. Sends `/compact`, waits, records the summary on the row, types a short form of it into the **parent** conversation, then closes. |
| `compact-only` | The same, without the parent. |
| `ask-me` | The old input box, kept by name. |
| `off` | Closes with no summary — exactly what **Close** does. |

What the compacting modes cost, stated once:

- **One to three minutes**, behind a progress notification with a **Cancel**
  button. Compactions measured on a real machine ran 96 to 180 seconds.
- **The branch's own context is squashed.** That is only acceptable because the
  branch is being closed in the same breath — so if you cancel, or the
  compaction never answers, you are left with a branch that has been compacted
  and not closed. The dialog says so.
- **Claude only.** The whole mechanism is one property of the Claude CLI. A
  Codex session is offered the plain close, and **Type a Summary…**, by name.
- **The session's tab has to be open in this window.** A closed row, a session
  another VS Code window hosts, a process Flock never launched, and a session
  parked detached by a workspace switch are all refused **before** anything is
  typed, with the same two ways out.
- **If no summary comes back, nothing is closed.** The session is mid-turn;
  closing its tab would abort the compaction and leave the branch neither
  compacted nor summarised.

The summary is recorded on the session and shown in its **hover**, capped — not
on the row. A closed row is its name and its age and nothing else, and a
conclusion sitting beside the age is what used to push the session's own name off
the line. The note the parent receives is capped much harder — it is keystrokes into a live
conversation, and it costs that conversation a turn.

## Naming

Sessions are **named, not prompted**. Every create path opens a name already
selected:

| Where | Suggested name |
| --- | --- |
| New session (folder) | the directory's basename, e.g. `api` |
| New session in a project | the project's name, e.g. `Storefront` |
| Fork | the parent's, plus the next free number: `auth` → `auth 2` → `auth 3` |

Neither `+` asks **where**. The one in the view title starts the session in the
project you are working in, taking the first of these that answers:

1. the project this window's **workspace** is scoped to;
2. the project owning the **folder** this window is open on;
3. the project of the **session** whose terminal is active here;
4. that folder, when no project claims it.

A session that lands in a project is named after the project, exactly as the `+`
on a project row does; one that lands in a bare folder is named after the
directory. Only a window that answers none of the four — no workspace, no folder,
nothing of ours running in it — gets a folder list. To start one somewhere else,
the palette has **Flock: New Claude Session in Folder…**, which always asks and
can browse to a directory no session has ever run in.

The session is **created first and named after**, which is the Explorer's "New
File" gesture: its row appears the instant you click — before the CLI has
registered anywhere — so the name box is on the row rather than floating over
the window, nothing is blocked on a keystroke, and Escape keeps the suggested
name instead of throwing away a session that is already running.

Enter accepts, typing replaces. Numbers are counted against what is currently
taken rather than accumulated, so closing `auth 2` frees that name again instead
of leaving a permanent gap.

**Rename happens on the row**, the way it does in the Explorer: **F2** or
double-click turns the row into a text field. Enter commits, Escape cancels,
clicking away commits.

## The sidebar

### The top bar

Five buttons, left to right — on the **SESSIONS** row, or on the **FLOCK** row
itself if you turn the Accounts section off (see the note below):

| Button | What it does |
| --- | --- |
| **bell** | The notifications list. Fills in when something is unread. |
| **+** | A new session, asking nothing. See [Naming](#naming) for where it lands. |
| **fork** | A branch off the conversation you are looking at — see below, and [Forking and context](forking-and-context.md) for what the branch inherits. |
| **filter** | Show only running sessions, or closed ones too. |
| **gear** | Everything else: projects, hooks, housekeeping, the Accounts section. |

Five and not eight, deliberately. A toolbar the workbench cannot fit collapses
into an overflow `...`, taking the buttons at the end with it — and the gear is at
the end, so a crowded row would hide the very menu that exists to replace that
ellipsis. **New Project…** and the closed-projects list moved into the gear menu
for that reason: they are the two you reach for least.

The **fork** button is handed no row, so it works out which conversation it is
about: the session whose terminal is the active one in this window, else the live
session you prompted most recently, else the only live session there is. If none
of those is a single clear answer — two rows equally stale, or a tree holding
nothing but closed sessions — it asks, with the same list **Fork Session** uses
from the palette. Forking the wrong thread leaves you a branch of a conversation
you were not in, sitting next to the one you meant, so it guesses only where the
evidence is singular. It disappears while the tree is empty.

The **gear** opens a menu holding everything that used to be behind the `...`:
the active-sessions filter, **Show Closed Projects and Hidden Folders…**, **Mark
All Notifications as Read**, **Restore Archived Session…**, **Archive Stale
Sessions…**, **New Project…**, the closed-projects list, the Accounts section
switch, the hooks pair, and **Refresh**. Each toggle is labelled with the
direction it goes — you get *Hide Accounts Section* when the section is showing,
never both — which is why it is built when it opens rather than declared in the
manifest.

> Where the buttons sit, and why it is a choice. VS Code has no menu id for a view
> container's title bar — there is `view/title` and no `viewsContainer/title` — so
> an extension cannot put a button on the FLOCK row directly. What it can do is
> give the container exactly **one** visible view, at which point the workbench
> merges that view's buttons into the container header and draws no separate
> section header.
>
> Flock has two views, Sessions and Accounts, so by default the buttons sit on the
> SESSIONS row just below the name. Turn **Accounts** off
> (`lineage.accounts.section`, or the gear menu) and they move up onto the FLOCK
> row. That is the entire trade, and it is settled in favour of Accounts: a list of
> subscriptions on screen is worth more than one row of height. Nothing about
> accounts stops working either way — usage is still read, new sessions are still
> routed, a session is still pinned to its account for life, and every account verb
> is in the Command Palette under **Flock**.

### How the rows are drawn

`lineage.viewStyle` chooses how the Sessions view is drawn:

- **`inline`** (default) — the extension draws the rows, which is what makes
  renaming in place possible. Right-click menus, theming, the view badge
  and dragging a session onto a project all work as normal.
- **`native`** — the built-in VS Code tree widget. Better keyboard and screen
  reader support, but rename opens a box at the top of the window instead of on
  the row.

Changing it takes effect on the next window reload.

> Why the choice exists at all: VS Code's Explorer renames a file by flagging the
> row editable and having *its own* row renderer put an input box there
> (`explorerService.setEditable` → `renderInputBox`). Both halves are internal to
> the workbench — the extension-facing `TreeItem` has no editable state, and none
> of the API proposals adds one. Owning the row markup is the only way to own the
> rename, so `inline` draws its own rows. `native` is kept because the built-in
> widget's accessibility is better than anything re-implemented in HTML.

## In-session verbs

"Fork this session", typed **to Claude** instead of clicked in the sidebar.
Off until you run **Flock: Install In-Session Verbs…**, which shows the exact
two files it writes before writing them:

- `~/.claude/skills/flock/SKILL.md` — a Claude Code skill, so Claude knows the
  verb exists. Skills are shared into every account profile by symlink, so one
  install covers all of your accounts.
- `~/.lineage/flock-verbs.mjs` — the small CLI the skill tells Claude to run:
  `node ~/.lineage/flock-verbs.mjs fork --count 3`.

The CLI does not fork anything itself. It works out which session it is in —
the `LINEAGE_NODE_ID` stamp Flock launches terminals with, `CLAUDE_SESSION_ID`
where the CLI provides it, or the `lineage-<uuid>` tmux session name — writes a
one-line request into `~/.lineage/requests/`, and waits up to 30 seconds for a
reply, which it prints for Claude to relay: the names of the new branches, or
exactly why nothing was forked.

On the other side, every Flock window watches that directory, and a request
runs **exactly once**: a window claims it with an atomic rename, and the window
whose terminal actually hosts the session gets a head start, so the forks open
beside the conversation they branched from — the same `--fork-session --resume`
launch, the same lineage edge, the same naming (`auth 2`, `auth 3`, `auth 4`)
that clicking **Fork Session** produces. "Do three forks here" is three of
them, titled past each other.

The forks can also be **named in your words**: "one to try the redis cache,
one for the SQL approach" makes Claude pass `--name "redis cache"
--name "SQL approach"` — one per fork, in order — and those become the rows'
titles. A name that would collide with an existing row (or with itself, asked
for twice) gets the same free-counter treatment every generated title gets,
because two rows wearing one name is the ambiguity titles exist to prevent.
Say nothing about names and the numbered defaults apply.

The guardrails, since the requester is a model:

- **Fork is the only verb.** A request may carry a count (capped at 8), one
  name per fork, and an opening prompt (capped at 4000 characters); nothing
  else.
- **A request expires.** One older than two minutes is answered "expired"
  rather than executed — a fork nobody is waiting for must not fire when a
  window finally opens. The CLI withdraws its own request if no window answers
  in 30 seconds.
- **Nothing new is reachable.** The request can only fork sessions the sidebar
  could already fork, in the window you already trusted with them. Any local
  process could write a request file — and any local process could already run
  `claude --fork-session` itself, so the channel adds no capability.
- **The reader has an off switch**, `lineage.verbs.enabled`, separate from the
  files on disk. `rm -rf ~/.claude/skills/flock` is also a complete uninstall,
  exactly like the hooks plugin.

### What Flock can and cannot say back

Worth stating plainly, because it is easy to assume otherwise once you have
watched a session fork itself: **Flock has no session-to-session messaging.**
The request channel above runs **one way** — session → Flock — and carries
exactly one verb. The only text that has ever gone the other way is a fork's
**opening prompt**, handed to the new CLI as an argument once, when it starts.
Branches do not talk to each other, and never have.

The one channel that can put text into a conversation that is **already
running** is Flock typing into its terminal — the same thing the **Wrap Up
Session** prompt does. Three features use it and all three are bounded the same
way:

| Feature | What it sends |
| --- | --- |
| **Wrap Up Session** | The wrap prompt, into the session you ran it on. |
| `lineage.fork.notifyParent` | One sentence into the **parent**, naming the new branch and what it is for. Off by default. |
| `lineage.close.summaryMode` | A short form of a closed branch's compaction summary, into its **parent**. |

And all three reach **only a session whose terminal is bound in this window**. A
conversation that is closed, hosted by another VS Code window, running outside
Flock, or parked detached by a workspace switch cannot be typed into — in every
one of those cases the message is simply not sent, one line goes to the **Flock**
output channel, and **nothing is queued and nothing is retried.** Those are the
ordinary cases, not the exotic ones, which is why the fork note is off by
default. What is typed also **costs that conversation a turn**, and is appended
to whatever you had half-written in its input box.

## Privacy

Nothing leaves your machine unless you turn on `lineage.git.pullRequests`, which
is off by default. Flock reads the local session roster and local transcript
files, and writes only to its own extension storage — plus, if you explicitly opt
in, the hooks plugin directory and `~/.lineage/events.ndjson`, and the
[in-session verbs](#in-session-verbs) files: `~/.claude/skills/flock/`,
`~/.lineage/flock-verbs.mjs` and the transient request/reply files under
`~/.lineage/requests/`.

The complete list of processes Flock ever starts:

| Process | Reads or writes | When |
| --- | --- | --- |
| `claude agents --json` | read | on the roster poll |
| `git worktree list --porcelain` | read | on the roster poll, cached 30 s |
| `git status --porcelain=v2 --branch` | read | on repaint, cached 15 s — `lineage.git.branches` only |
| `git for-each-ref …refs/heads/` | read | when the New Worktree… picker opens — `lineage.git.branches` only |
| `git worktree add` | **writes** | New Worktree…, after a confirmation — `lineage.git.branches` only |
| `git worktree remove` | **writes** | Remove Worktree, after one or two — `lineage.git.branches` only |
| `git remote get-url <remote>` | read | when you click a branch name, or run Open Branch on GitHub |
| `gh pr list …` | read, **network** | only with `lineage.git.pullRequests` on |
| `gh pr create --web` | opens a browser page | Create Pull Request… |
| `claude`, and `tmux -L lineage` around it | — | when you start a session |

Flock never edits `~/.claude/settings.json`, and there is no HTTP client anywhere
in the extension.
