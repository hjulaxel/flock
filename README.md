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

- **A worktree per session, by default.** Running one agent per `git worktree`
  is how parallel work actually gets done, so the `+` does it for you: every
  root session starts in a fresh checkout on a branch minted from its own name
  (`flock 3` → `flock-3`), and no two sessions can switch branches under each
  other again. `lineage.git.newSessionInWorktree` turns the old in-place `+`
  back on; either way a session in a linked checkout is filed under the project
  that owns the repository, wherever the checkout sits on disk. When the work
  has landed, **Remove Worktree** offers to retire the minted branch with it —
  and only a minted, fully-merged one.

- **Branch rows, if you turn them on.** `lineage.git.branches` — **off** — gives
  each of a project's checkouts a colour-coded row, with **New Worktree…**,
  **Remove Worktree**, where each checkout stands against its upstream (`↑2 ↓1`,
  and `*` for uncommitted work), and, with `lineage.git.pullRequests` on as well,
  a pull-request chip per branch. It is off because it is a lot of rows in a
  sidebar that has to stay readable, not because it is unfinished. See
  [Branches and worktrees are parked](#branches-and-worktrees-are-parked).

- **Use several accounts, on either CLI.** A row per subscription — a work plan,
  a personal plan, a **ChatGPT / Codex** plan, or an API key. Claude plan
  accounts show their current usage; Codex and API-key rows have no meter to
  read. An account also keeps its own config directory, so you only
  need to sign in **once per account**. New sessions are routed automatically,
  and a session is then pinned to its account — until you move it. Run out of
  window mid-conversation? **Move to Account…** carries that conversation over
  to another subscription and picks up where it was; with tmux, without even
  moving the tab. Between accounts on the same CLI: a Claude conversation's
  transcript means nothing to `codex`, so those are never offered.

  A session on a Codex account runs the `codex` CLI under that account's own
  `CODEX_HOME`, and gets the same tree row, age, attention dot, fork and resume
  as a Claude one. Two differences worth knowing: Codex has no start-time naming
  flag, so those tabs wear Flock's own title, and **Fork and Compact** offers a
  plain fork instead — the Codex CLI has no compaction command to hand it. If
  the row cannot find your CLI (common with a node version manager, whose PATH
  VS Code often does not inherit), set `lineage.codexBinary`.

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

- **Ask Claude itself.** With the opt-in in-session verbs installed, "fork this
  session" — or "do three forks here" — typed to Claude runs the same fork the
  sidebar button runs: same lineage edge, opened beside the conversation it
  branched from, and Claude reports back the names of the new branches. Say
  what each fork is *for* — "one to try the redis cache, one for the SQL
  approach" — and those become the rows' names; say nothing and they are
  numbered like any other fork. One consent modal installs a skill and a small
  local CLI; nothing reaches the network.
  [Details →](docs/reference.md#in-session-verbs)

- **Temporary chats.** The chat button on a project row opens a scratch
  conversation about that project. Right-click the project and **Old Chats…** for
  the list of past chats.

- **Subprojects: lanes of work, or directories.** A project is scoped to one
  directory. **Add Subproject** makes a named *lane* in a directory — so
  `~/magma-cs-mcp` can hold "the server rewrite" and "the CS tooling" as two rows,
  which nothing on disk could tell apart — or takes on another directory, which gets
  a row of its own labelled by its basename. **A new lane starts empty**: sessions
  that were already running in that folder stay on the folder's own row, which
  disappears once you have filed the last of them. Worktree sessions are filed under
  the directory that owns the repository, so nothing lands in a project-wide leftover
  row. A project that has never made a lane draws exactly the rows it always did.

- **Open and close projects.** A project you are not working on this month
  doesn't have to be deleted to get out of the way: **Close Project** takes it
  out of the tree and changes nothing else. The `$(folder-opened)` button at the
  top of the view lists every closed project.

- **Nothing is lost.** Closing a tab does not remove its row. It's dimmed and
  stays one click from resuming. Only **Archive** removes a row — it asks
  first, it closes the session before it hides it, it is undoable, and every
  project row has an **Archived Sessions…** list to search and restore from.

- **`/exit` puts you at a shell, not back to nothing.** Exiting a session leaves
  a prompt in the same tab, in the same directory, with the conversation still
  above it — so the exit-and-start-again you actually meant is one
  `claude --resume` away instead of a hunt for the row. Exiting that shell closes
  the tab as before. Needs tmux; `lineage.exitToShell` turns it off.
  [Details →](docs/reference.md#exit-leaves-you-at-a-shell)

- **A recommended setup, that says why.** Seventeen of Flock's settings ship
  off, and they are not off for the same reason: two of them — instant updates
  and the in-session verbs — are off only because turning them on writes files
  in your home directory, four of them *are* the clean slate below, and the rest
  are taste. **Flock: Recommended Setup** is the checklist that tells them apart:
  a line per thing worth turning on, with what it does and what it writes, every
  worthwhile one pre-ticked, and nothing written until you confirm. It offers the
  branch rows without ticking them, never touches the clean slate, and never
  turns on the one setting that reaches the network. It is on the empty view, in
  the gear menu, and in the palette.
  [Details →](docs/reference.md#the-recommended-setup)

- **A clean slate, and two doors in.** Flock starts empty: nothing you ran
  before it, and nothing running in some other terminal, appears — or rings the
  bell — until you say so. Right-click a project for **Add Existing Session…**
  (its folders' previous sessions, live ones running elsewhere, or a pasted
  session id), or run **Import Previous Sessions…** to bring in pre-Flock
  history all at once or one folder at a time. Nothing is imported for you.

- **It still works with the Claude you already run — when you ask it to.** The
  session list is machine-wide, so a `claude` typed into the bottom panel, or a
  conversation started by the official Claude Code extension, is one Add away
  from a full row — age, status dot, its place in the fork tree — and
  `lineage.showForeignSessions` puts every one of them in the tree
  automatically, the way Flock originally behaved. Click such a row and Flock
  reveals the terminal it is already running in rather than opening a second
  copy. Rows Flock does not own say **elsewhere** and are never offered a verb
  that would lie about them.
  [Full table →](docs/reference.md#using-flock-alongside-the-claude-code-extension)

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
sudo zypper install tmux   # openSUSE
sudo apk add tmux          # Alpine
nix-env -iA nixpkgs.tmux   # Nix
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

Windows does not get this natively: sessions there always close and resume.
Open the project through WSL and it does — see [Platforms](#platforms).
[Other platforms →](https://github.com/tmux/tmux/wiki/Installing)

## Platforms

Flock is one universal extension: no native modules, nothing platform-specific
to download. What differs is what the machine underneath can offer it.

| | macOS | Linux | Windows, native | Windows, via WSL |
| --- | --- | --- | --- | --- |
| Sessions, forks, the tree, attention, accounts, worktrees, projects | yes | yes | yes | yes |
| Detach tier: parking, solo mode, Auto-switch, `/exit` to a shell, moving a live conversation between accounts in place | yes | yes | **no** — sessions close and resume from their transcripts | yes |
| Instant-update hooks | yes | yes | yes, via PowerShell | yes |
| In-session verbs — "fork this session", said to Claude | yes | yes | yes, with `node` on `PATH` | yes |
| Fork edges for forks typed at the CLI (`claude --fork-session`) | yes | yes | yes, via PowerShell | yes |
| Reaping a closed session's MCP children; the phantom-row filter | yes | yes | yes, via PowerShell | yes |
| Account usage meters | credentials file, then the keychain | credentials file | credentials file | credentials file |

**Windows.** The full tier is one extension away: open the project through the
[WSL extension](https://code.visualstudio.com/docs/remote/wsl) and Flock runs
inside WSL, where tmux, `ps` and `/bin/sh` all exist and every row above reads
*yes*. Native Windows works and is honest about the one thing it lacks: without tmux
a session cannot be hidden while it runs, so parking closes it and resumes it
from its transcript, and everything built on the detach tier is absent with it.
Where the table says *via PowerShell*, Flock uses the shell every Windows has:
the hooks append through it, and the process table is read through one
`Get-CimInstance Win32_Process` sweep per tick instead of `ps`. Install the CLI
with the [native installer](https://code.claude.com/docs/en/setup), which puts
`claude.exe` on your `PATH`. Flock prefers it over the `.cmd` shim an npm
install leaves: the shim is a batch file, so Flock runs it through `cmd.exe`
and quotes for it, and a prompt naming an environment variable as `%NAME%` is
expanded on the way through — the one thing the shim path cannot carry.

**Linux.** Everything works, and paths compare exactly, the way the filesystem
does — two directories whose names differ only in case are two directories to
Flock too, where macOS and Windows fold them into one. One thing to know: an
editor installed as a **Snap** or a **Flatpak** does not see the `PATH` your
shell has, so a `claude` or `tmux` installed under your home directory is
invisible to it. Set `lineage.claudeBinary` to the full path and install tmux
system-wide. A Flatpak also sandboxes the editor away from host binaries
altogether, so prefer the `.deb`, `.rpm` or tarball build. The tmux notice
names your distribution's own package manager, read from `/etc/os-release`.

**Remote hosts.** Over Remote-SSH, in a Dev Container or a Codespace, Flock runs
on the remote and gets that machine's tier. Install tmux there.

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

One part is **not** parked: the `+` cutting a worktree per root session
(`lineage.git.newSessionInWorktree`) ships on and needs none of the rows —
see the worktrees bullet above.

The feature is four settings by now, so there is one verb for all of them:
**Flock: Show Branches and Worktrees** in the command palette turns on the rows,
the pull-request chips and the directory-model preview in one go, and
**Flock: Hide Branches and Worktrees** puts every one of them back to the value
it ships with. It deliberately leaves `lineage.git.branchDisplay` alone: how the
rows read is a choice you made, and the Hide half only ever restores defaults.

Once it is on, `lineage.git.branchDisplay` picks how a session says which
worktree it is in: `inline` — the default — writes the branch on a line under the
session, and `color` tints the session's name and uses the branch rows as the key
(what shipped). Either way the branch rows themselves stay **shut until you ask
for them**, with **Show Branches** on the project's right-click or the git-branch
button on its row.

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
leave workspace mode (**Settings → Switch Workspace… → Leave Workspace Mode**),
or to run **Flock: Choose Window Model…** and pick a model that does not switch
by itself — *One folder per project* or *Root (Flock only)*. (`lineage.workspaces.enabled`
was the old way to say that second thing. It is deprecated now and folded into
`lineage.mode`, so setting it still works and the picker is the honest spelling.)

This is a known bug with a known fix — membership in a switch should be
`matchProject`'s answer, the same one the tree renders — and it is not fixed in
this release.

## Documentation

- **[Settings](docs/settings.md)** — all 51, with defaults.
- **[Reference](docs/reference.md)** — how it works, projects, subprojects,
  notifications, workspaces, close vs archive, naming, the sidebar rendering
  modes, and what you get alongside the Claude Code extension.
- **[Forking and context](docs/forking-and-context.md)** — what a fork, a
  fork-and-compact, a resume and a self-fork each do to the conversation,
  measured against real transcripts.

## Privacy

Nothing leaves your machine unless you turn on one setting, named below. Flock
reads the local session roster and local transcript files, and writes only to
`~/.lineage/state/` and its own extension storage — plus, if you explicitly opt
in, the hooks plugin directory and `~/.lineage/events.ndjson`, and the
in-session verbs files
(`~/.claude/skills/flock/`, `~/.lineage/flock-verbs.mjs`, `~/.lineage/requests/`).

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

A **branch name in the tree is a link** to that branch on the remote it tracks,
and that is not an exception to the promise above: the url is built from `git
remote get-url` and the branch's own upstream, both reads of the local
repository, and the only thing that leaves your machine is the browser your click
hands the url to.

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
