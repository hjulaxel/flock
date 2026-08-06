<p align="center">
  <img src="media/icon.png" width="88" height="88" alt="">
</p>

<h1 align="center">Flock for Claude Code</h1>

<p align="center">
  See every Claude Code session you're running as one live tree, a flock.
</p>

---

Hello, and welcome to Flock.

The aim of this project is a better environment for AI-related workflow. When
you're running many agents, the hard part stops being the code — the work
becomes the bookkeeping.

Flock puts all of it in the sidebar as a tree, to keep track of everything. From
there, sessions fork and branch out. Around that sits a variety of nice-to-have
features: notifications for finished sessions, sessions grouped under
user-defined projects and their directories, LLM account management, temporary
chats, and much more.

<!-- TODO(launch): screenshot of the sidebar — a project with three or four
     sessions, one amber, one red, branch chips visible. This is the single
     highest-impact asset on the marketplace page. -->

## What it does

- **A tree of sessions, not a list.** See which session was forked from which.
  Use the UI or native in-session `/fork`.

- **Attention routing.** A dot at the right edge of the row: **amber** means
  working, **red** means finished. It's that easy.

- **A notifications bell.** The latest finished sessions, unseen first, each with
  its project and age. Click one to jump there. Dismiss a single entry, or mark
  all read at once. Plus a per-session mute that puts the bell to rest.

- **Session age.** The time on a row is how long since you last prompted that
  session.

- **Worktrees keep their sessions.** Running one agent per `git worktree` is how
  parallel work actually gets done. A session started in a linked checkout of a
  project's repository is filed under that project wherever the checkout sits on
  disk, with nothing to configure.

- **Branch rows, if you turn them on.** `lineage.git.branches` — **off** — gives
  each of a project's checkouts a colour-coded row, with **New Worktree…**,
  **Remove Worktree**, where each checkout stands against its upstream (`↑2 ↓1`,
  and `*` for uncommitted work), and, with `lineage.git.pullRequests` on as well,
  a pull-request chip per branch. It is off because it is a lot of rows in a
  sidebar that has to stay readable, not because it is unfinished. See
  [Branches and worktrees are parked](#branches-and-worktrees-are-parked).

- **Use several accounts.** A row per subscription, whether it's a work plan, a
  personal plan, or an API key. Each account shows its current usage. An account
  also keeps its own config directory, so you only need to sign in **once per
  account**. New sessions are routed automatically, and a session is then pinned
  to its account.

- **Project workspaces.** Scope a window to one project. Switching saves the tab
  layout you leave and restores the target's. With tmux installed, other
  projects' sessions keep running while hidden and reattach instantly; without
  it they close and resume from transcript. Unsaved editors are never touched.

- **Orchestration verbs.** New, fork, **fork and compact**, rename in place,
  close, **close with summary**. New Project, new session and fork are one click
  at the top of the sidebar, and the last two ask no question: `+` starts a
  session in the project you are working in, and fork branches off the
  conversation you are looking at. A gear beside them holds the housekeeping and
  the closed-sessions filter.

- **Temporary chats.** The chat button on a project row opens a scratch
  conversation about that project. Right-click the project and **Old Chats…** for
  the list of past chats.

- **Subprojects: lanes of work, or directories.** A project is scoped to one
  directory. **Add Subproject** makes a named *lane* in a directory — so
  `~/magma-cs-mcp` can hold "the server rewrite" and "the CS tooling" as two rows,
  which nothing on disk could tell apart — or takes on another directory, which gets
  a row of its own labelled by its basename. Worktree sessions are filed under the
  directory that owns the repository, so nothing lands in a project-wide leftover
  row. A project that has never made a lane draws exactly the rows it always did.

- **Open and close projects.** A project you are not working on this month
  doesn't have to be deleted to get out of the way: **Close Project** takes it
  out of the tree and changes nothing else. The `$(folder-opened)` button at the
  top of the view lists every closed project.

- **Nothing is lost.** Closing a tab does not remove its row. It's dimmed and
  stays one click from resuming. Only **Delete** removes a row, and that is also
  undoable.

- **It works with the Claude you already run.** The session list is
  machine-wide, so `claude` typed into the bottom panel, or a conversation
  started by the official Claude Code extension, is in the tree too — with its
  age, its status dot and its place in the fork tree. Click one and Flock reveals
  the terminal it is already running in rather than opening a second copy. Rows
  Flock does not own say **elsewhere** and are never offered a verb that would
  lie about them. [Full table →](docs/reference.md#using-flock-alongside-the-claude-code-extension)

## Requirements

- **tmux.** See below. Install it before you start.
- The `claude` CLI on your `PATH`, or `lineage.claudeBinary` set to its full path.
- VS Code 1.94 or newer. Also runs in Cursor, Windsurf and VSCodium. Flock uses
  no proposed APIs.
- A trusted workspace. Restricted Mode blocks terminal creation, which Flock
  needs.

## Install tmux

You need tmux. Flock runs your sessions inside it, and that is what lets a
session keep working while you look at something else.

```sh
brew install tmux          # macOS
sudo apt install tmux      # Debian / Ubuntu
sudo dnf install tmux      # Fedora
sudo pacman -S tmux        # Arch
```

Check it worked with `tmux -V`. That is all you have to do. Flock looks for tmux
on your `PATH` every time it starts a session, so there is no reload and no
setting to turn on.

Flock uses its own private server, `tmux -L lineage`. You will never see it. No
status bar, no prefix key, and your own tmux sessions and config are left alone.
`tmux ls` will not even list Flock's.

Skip it and Flock still runs, but switching projects closes the other project's
sessions instead of hiding them. They come back when you switch back, resumed
from their transcripts. Anything a session was in the middle of is gone.

Windows does not get this, sorry. Sessions there always close and resume.
[Other platforms →](https://github.com/tmux/tmux/wiki/Installing)

## Known limits

### Branches and worktrees are parked

The branch block — a row per checkout, the worktree verbs, the per-branch
colours, the pull-request chip — is off behind `lineage.git.branches`, and it is
off because of the sidebar rather than because of the code. A repository with six
checkouts is six rows before the first session, and a sidebar is 250px wide.

Nothing about it is unfinished: it reads real worktrees, `git worktree add` and
`git worktree remove` still confirm and still show the command first, and the
rules are covered by the same tests they always were. Turn the setting on to get
all of it back, including its menus.

If you were running 0.1.1 and had these rows, Flock offers them back once on the
first launch after the upgrade, rather than letting them vanish on you. It only
asks when a repository of yours actually has more than one checkout, and it never
asks twice.

Worktree MEMBERSHIP is not part of the switch. A session started in a linked
checkout is filed under the project that owns the repository whether the rows are
drawn or not — turning a view option off must never move somebody's sessions.

**There is a preview of the answer to the row-count problem.**
`lineage.preview.directoryModel` hangs the branch rows off a **directory** rather
than off the project and lists **every** local branch of that directory's
repository — with only the directory's own checkout and the branches something is
running on outside a **Branches (N)** fold that is shut by default. A repository
with a hundred and eighty branches then costs one row, which is what makes showing
all of them possible at all. It needs `lineage.git.branches` too, draws in the
inline sidebar, and is off by default while the promotion policy earns its keep.
[Details →](docs/reference.md#the-directory-model-preview)

### Workspaces claim each other's sessions

A workspace switch decides which sessions belong to the project it is switching
to by asking whether their directory sits inside one of the project's
directories. The sidebar asks a different question — which project's directory is
the *longest* match — and the two disagree whenever one project's directory
contains another's.

When they disagree, both projects' saved layouts can name the same session, so
switching between them brings the same tabs back under either one. If your
projects do not nest, you will not see it. If they do, the workaround today is to
leave workspace mode (**Settings → Switch Workspace… → Leave Workspace Mode**) or
to turn `lineage.workspaces.enabled` off.

This is a known bug with a known fix — membership in a switch should be
`matchProject`'s answer, the same one the tree renders — and it is not fixed in
this release.

## Documentation

- **[Settings](docs/settings.md)** — all 32, with defaults.
- **[Reference](docs/reference.md)** — how it works, projects, subprojects,
  notifications, workspaces, close vs delete, naming, the sidebar rendering
  modes, and what you get alongside the Claude Code extension.

## Privacy

Nothing leaves your machine unless you turn on one setting, named below. Flock
reads the local session roster and local transcript files, and writes only to its
own extension storage — plus, if you explicitly opt in, the hooks plugin
directory and `~/.lineage/events.ndjson`.

**Your repositories are read on a timer and changed only when you ask.** By
itself Flock runs `git worktree list --porcelain` and `git status
--porcelain=v2 --branch`, both reads, both cached. **New Worktree…** and **Remove
Worktree** run `git worktree add` and `git worktree remove` — after a
confirmation that shows you the exact command, and a second one before anything
uncommitted is deleted.

**`lineage.git.pullRequests` is the one thing in Flock that reaches the network,
and it is off by default.** With it on, Flock shells out to the
[`gh` CLI](https://cli.github.com) that you installed and signed in yourself:
`gh pr list` while the Sessions view is visible, at most once every five minutes
per repository, and `gh pr create --web` when you ask for it. Flock makes no HTTP
requests of its own, bundles no API client, and never sees or stores a token. If
`gh` is missing, not signed in, or the repository has no GitHub remote, the rows
render exactly as they do with the setting off — one line in the **Flock** output
channel, no dialog.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit, source and tests
npm test            # vitest run
npm run compile     # esbuild bundle -> dist/extension.js
npm run watch       # rebuild on change
```

Press **F5** to open an Extension Development Host with Flock loaded. There are
no runtime dependencies — the extension is Node builtins plus the `vscode` API,
bundled into a single file by esbuild. See [CONTRIBUTING.md](CONTRIBUTING.md)
for the rest.

## Credits

Provider logos under `media/providers/` are the official brand marks, with paths
taken from [Simple Icons](https://simpleicons.org) (icon data released under
CC0 1.0). The marks themselves remain the trademarks of their respective owners.

## License

MIT. See [LICENSE](LICENSE).

---

> **Not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI or
> Google.** "Claude" and "Claude Code" are trademarks of Anthropic, PBC;
> "OpenAI" and "Codex" of OpenAI, L.L.C.; "Gemini" of Google LLC. Their names
> and logos appear here only to identify which tool a session runs — nominative
> use — and each remains the property of its owner. This is an independent,
> community-built tool.
