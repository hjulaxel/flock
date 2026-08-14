# Flock — reference

The depth that does not belong on a marketplace page. For the pitch and the
feature list, see the [README](../README.md); for every setting, see
[settings.md](settings.md).

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

### Turning it all on at once

**Flock: Show Branches and Worktrees** in the command palette writes five
settings at once:

| Setting                          | On       | Default    |
|----------------------------------|----------|------------|
| `lineage.git.branches`           | `true`   | `false`    |
| `lineage.git.sessionBranchDetail`| `detailed` | `standard` |
| `lineage.git.pullRequests`       | `true`   | `false`    |
| `lineage.preview.directoryModel` | `true`   | `false`    |
| `lineage.preview.demoProject`    | `true`   | `false`    |

**Flock: Hide Branches and Worktrees** writes that last column back, so the pair
is an exact inverse — including the detail level, and including a value a
Workspace or Folder setting would otherwise show through. Each setting is still
its own switch for anyone who wants four of the five; this is for trying the
feature out, and for lighting up an Extension Development Host in one keystroke.

`lineage.git.branchDisplay` is deliberately **not** in the table. It is a
preference about how rows read rather than something to switch on, its default is
already the mode you want to meet the feature in, and writing it back on the way
out would throw away a choice you made — where every line above only restores a
default.

Two of the six are worth knowing you turned on, which is why this verb leaves a
message where Flock's other switches flash the status bar: `lineage.git.pullRequests`
is the one setting that reaches the network, and `lineage.preview.demoProject`
adds a project whose rows are fabricated.

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

A right-click gives you seven things — **New Session**, **New Chat**, **Old
Chats…**, **Add Subproject**, **Rename Project**, **Close Project**, **Delete
Project** — and **Settings**, which holds what a project *is* rather than what you
do to it: which directory is the main one, which to remove, the provider, the AI
account, **Switch Workspace…** and **Open in New Window**. Deleting a project
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

`lineage.preview.demoProject` is the other half of the preview: a fabricated
project, *Flock (demo)*, with three directories, two repositories and a branch in
every state a row can draw. Nothing on it is real, none of its directories exist,
and it has **no sessions** — a session row comes from the real roster, so a made-up
one would draw nothing at all. Every verb refuses it, and turning the setting off
removes it completely. It is for judging the shape; the setting above is for
judging it against your own repositories.

## Notifications

The red dot is an **unread marker**. It appears when a session completes a turn
(or asks for input) while you are not looking at it, and clears the moment you
focus that session. Red rather than green because it is the one row asking for
you — green is what everything else on screen uses to mean "nothing to do here".
It rolls up onto the project row, so a collapsed project still shows there is
something to come back to, and the badge on the view is the count of red dots.

The **bell** — leftmost in the view title — lists the latest finished sessions,
unseen above a divider, then history, each with its project and how long ago it
finished. Clicking an entry focuses the session and marks it read; *Mark All
Notifications as Read* is in the gear menu, and a command of its own.

Each row carries an **×** that takes it off the list without going near the
session. That is per *finish*, not per session: the next turn that session
completes puts it straight back. Silencing a session for good is Mute, which is
a different verb on purpose — a one-click × that could permanently hide a
session's notifications would be the most destructive control in the popup.

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

A **workspace** scopes a window to one project. By default it **follows your
focus**: start working in a session that belongs to another project and the
window switches to that project's workspace by itself — nothing is stopped and
nothing asks a question. Turn that off with `lineage.workspaces.autoSwitch`. You
can always switch explicitly with the `$(layers)` status-bar item, the palette
(**Flock: Switch Workspace…**), or a project row's context menu.

Switching:

1. **saves** the current layout — file tabs with their editor groups and
   pinning, plus your session tabs, including which tab had the keyboard —
   under the project you are leaving;
2. **hides** what does not belong to the target. A foreign *session* is
   **parked**: its terminal closes, and with tmux the conversation **keeps
   running** in the private server, hidden. Nothing asks to terminate. Unsaved
   editors are never closed, terminals Flock does not own are never touched, and
   a session mid-turn is left open rather than interrupted;
3. **restores** the target's saved layout: files reopen in their editor groups,
   parked sessions re-attach to the tmux session they were detached from, and one
   that died while out of sight is resumed from its transcript;
4. **lands** on one tab, chosen rather than raced. When the switch happened
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
| Rename the row, mute it, delete it | yes | yes | yes |
| **Fork Here** — branch off a copy | yes | yes | yes |
| Copy Session ID | yes | yes | yes |
| Click the row → the session | reveals its tab | reveals the terminal, when it is running in one | reveals that terminal |
| **Close** / **Close with Summary** | yes | no | no |
| **Wrap up** prompt | yes | no | no |
| tmux parking on a workspace switch | yes | no | no |
| Account routing and pinning | yes | no | no |
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

**Handing new conversations to the extension.** Set `lineage.launch.mode` to
`claudeExtension` and Flock's `+` runs the extension's **New Conversation**
command instead of opening a terminal. Flock then watches for the session to
appear on the roster and files it under the project and name your click implied.
The right-hand column of the table above is what you get from then on — the row
and the tree, not the ownership verbs. The setting is only honoured while that
extension is installed; without it Flock opens the session itself and says so
once.

Two things the mode deliberately does not do:

- **Fork is never delegated.** Nothing the extension contributes accepts a
  session id or a resume target, so there is no way to ask it for a branch of a
  specific conversation. Fork always opens Flock's own terminal, which is also
  the only way it can inherit the parent's history.
- **Picking an account by hand overrides it.** A delegated launch runs under the
  delegate's own environment, so it cannot be pinned to one of your
  subscriptions. **New Session From…** therefore keeps launching here.

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

## Close and delete

The tree is a map of your work, and **tab state is not tree membership**: a
session whose tab is closed is still *your session*. It stays in the tree as an
inactive row until you explicitly delete it. That leaves exactly two verbs,
neither of which loses data:

| Verb | The tab | The row |
| --- | --- | --- |
| **Close** | **Closed.** | **Stays** — flips to inactive: dimmed, sorted below live work, forks still nested under it. |
| **Delete** | Left alone. | Gone. Forks move up to the nearest visible ancestor, so no lineage is lost. |

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

**Delete means "this does not belong in the tree".** It removes the row only,
and the **Undo** button on the toast — or **Restore Deleted Session…** — brings
it back. **Delete Stale Sessions…** is the bulk form: it lists everything
oldest-first, pre-ticks rows older than `lineage.staleAfterHours`, and deletes
what you confirm, undoable the same way.

Nothing here deletes a transcript. Any session that ever ran is still resumable
with `claude --resume <id>`.

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
| **fork** | A branch off the conversation you are looking at — see below. |
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
All Notifications as Read**, **Restore Deleted Session…**, **Delete Stale
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
  renaming in place possible. Right-click menus, theming, the attention badge
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

The guardrails, since the requester is a model:

- **Fork is the only verb.** A request may carry a count (capped at 8) and an
  opening prompt (capped at 4000 characters); nothing else.
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
