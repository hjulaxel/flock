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

**Worktrees are read on a timer, and changed only when you ask.** Two git
commands run by themselves, both reads, both cached:

| Command | When | Cached |
| --- | --- | --- |
| `git worktree list --porcelain` | once per project directory | 30 s |
| `git status --porcelain=v2 --branch` | once per worktree, for the `↑2 ↓1 *` on its row | 15 s |

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

### Making and unmaking worktrees

**New Worktree…** is on a branch row, on a project row (a repository with one
checkout has no branch rows, and that is exactly when you want this) and in the
command palette. It offers the repository's local branches — minus any that
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

### Pull requests

Off by default, behind `lineage.git.pullRequests`, and the only thing in Flock
that reaches the network. Turning it on has Flock run

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

A project is **a name, a main directory, and any number of extra directories**.
Create one from the new-folder icon in the view title (**New Project…**), or
from a folder row's **Make a Project from this Folder…**.

Membership is derived from each session's working directory, never stored on the
session: the project whose directory is the *longest* match wins, so `~/code`
and `~/code/api` can both be projects and each session lands in the right one.
Nothing is written to your session records, so renaming a project, adding a
directory, or deleting it entirely never rewrites session state.

**Configure Project…** (the gear on a project row) covers rename, add/remove
directory, set the main directory, set the provider, hide, and delete. Deleting
a project removes the grouping only — never a directory, session or transcript.

Dragging a session onto a project row adds that session's directory to the
project. Dragging a session onto *another session* re-parents it. Those are two
different gestures on purpose: one is about addresses, one about ancestry.

### Subprojects

A project can be filed **under** another project, to any depth and any breadth
— a monorepo with `api`, `web` and `infra` under it, each with its own
directories, provider and account. Nesting changes where a row is drawn and
nothing else: membership is still the longest-matching-directory rule, so a
session in `~/code/app/api` lands in the `api` subproject and one in
`~/code/app/docs` stays with the parent.

- **New Subproject…** on a project row creates one, with the directory picker
  already opened inside the parent.
- **Move Project…**, or dragging a project row onto another project row, files
  an existing project somewhere else. Dropping it on empty space below the tree
  takes it back to the top level.
- Closing a project closes everything under it, and opening it brings the whole
  thing back. **Deleting** one does not delete its subprojects — they move to
  the top level, because a delete that took four other projects with it would
  be a very different verb.

Two ways a project tree can be wrong are handled rather than prevented: a
subproject whose parent has been deleted is drawn at the top level, and a move
that would close a loop is refused with a reason. Projects nest at most eight
deep.

### Branch grouping

`lineage.groupSessionsByBranch` (off by default) changes what a project's branch
rows *are*. Normally they are a list above the sessions: which worktrees exist,
what colour each one is, click to start a session there. With the setting on,
each branch row becomes a container — its sessions hang underneath it, it folds
shut, and the `+` on the row is what starts a session in that worktree.

It applies to a project with two or more worktrees, which is the same threshold
the branch rows themselves appear at. Anything the branch rows do not account
for — a session on a branch you folded away into **Others**, or in a project
directory outside the repository — keeps its place directly under the project.
It is a layout, never a filter: no setting in Flock hides a session's row.

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

## Workspaces

A **workspace** scopes a window to one project. By default it **follows your
focus**: start working in a session that belongs to another project and the
window switches to that project's workspace by itself — nothing is stopped and
nothing asks a question. Turn that off with `lineage.workspaces.autoSwitch`. You
can always switch explicitly with the `$(layers)` status-bar item, the palette
(**Flock: Switch Workspace…**), or a project row's context menu.

Switching:

1. **saves** the current layout — file tabs with their editor groups and
   pinning, plus your session tabs — under the project you are leaving;
2. **hides** what does not belong to the target. Foreign *session* tabs are
   **stowed**: the terminal moves into the terminal panel and **keeps running**.
   Nothing is stopped, nothing asks to terminate. Unsaved editors are never
   closed, and terminals Flock does not own are never touched;
3. **restores** the target's saved layout: files reopen in their editor groups,
   stowed sessions move back into the editor area, and a session that died while
   out of sight is resumed from its transcript.

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
from `claude agents --json`, which is **machine-wide**, so a conversation shows
up in the tree whoever started it. What changes between setups is not whether
you get a row — you always do — but how much Flock is allowed to *do* with it.

There are three setups, and the difference between them is one thing: whether
Flock owns the process.

| | **Flock-launched** | **Claude Code extension** | **`claude` in a terminal** |
| --- | --- | --- | --- |
| A row in the tree, in its project | yes | yes | yes |
| Age, token count, status dot | yes | yes | yes |
| Fork tree — who forked from whom | exact | inferred | inferred |
| Notifications: dot, bell, toast | yes | yes | yes |
| Branch colour, worktree grouping | yes | yes | yes |
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
  and drag-to-reparent all work as normal.
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

## Privacy

Nothing leaves your machine unless you turn on `lineage.git.pullRequests`, which
is off by default. Flock reads the local session roster and local transcript
files, and writes only to its own extension storage — plus, if you explicitly opt
in, the hooks plugin directory and `~/.lineage/events.ndjson`.

The complete list of processes Flock ever starts:

| Process | Reads or writes | When |
| --- | --- | --- |
| `claude agents --json` | read | on the roster poll |
| `git worktree list --porcelain` | read | on the roster poll, cached 30 s |
| `git status --porcelain=v2 --branch` | read | on repaint, cached 15 s |
| `git for-each-ref …refs/heads/` | read | when the New Worktree… picker opens |
| `git worktree add` | **writes** | New Worktree…, after a confirmation |
| `git worktree remove` | **writes** | Remove Worktree, after one or two |
| `gh pr list …` | read, **network** | only with `lineage.git.pullRequests` on |
| `gh pr create --web` | opens a browser page | Create Pull Request… |
| `claude`, and `tmux -L lineage` around it | — | when you start a session |

Flock never edits `~/.claude/settings.json`, and there is no HTTP client anywhere
in the extension.
