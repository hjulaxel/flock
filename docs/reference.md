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

**Worktrees are read, never written.** The one git command Flock ever runs is
`git worktree list --porcelain`, once per project directory, cached for 30
seconds. It creates no worktrees, switches no branches, and writes nothing to
your repository. A directory that is not a repository, a machine with no `git`
on `PATH`, and a probe that times out all produce the same result — no branch
chips — and the tree renders as it did before the feature existed.

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

The **bell** at the top of the sidebar lists the latest finished sessions —
unseen above a divider, then history — each with its project and how long ago it
finished. Clicking an entry focuses the session and marks it read; *Mark all as
read* is one entry further down, and a command of its own.

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
project this window is open on — the folder you have open, or, if it sits inside
a project, that project's main directory. It falls back to a folder list only
when the window makes no such claim. To start one somewhere else, the palette
has **Flock: New Claude Session in Folder…**, which always asks and can browse
to a directory no session has ever run in.

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

Nothing leaves your machine. Flock makes no network requests. It reads the
local session roster and local transcript files, and writes only to its own
extension storage — plus, if you explicitly opt in, the hooks plugin directory
and `~/.lineage/events.ndjson`.
