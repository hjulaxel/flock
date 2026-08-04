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
user-defined projects, colour-coding by git branch, LLM account management,
temporary chats, and much more.

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

- **Branches, if there are any.** Running one agent per `git worktree` is how
  parallel work actually gets done. Flock reads `git worktree list`, files every
  checkout of a project's repo under that project wherever it sits on disk, and
  gives each branch a colour-coded row. Click a branch to start a session in
  that worktree. Turn on `lineage.groupSessionsByBranch` and each branch becomes
  a container instead.

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
  close, **close with summary**. New and fork are one click on the **FLOCK** row
  and neither asks a question: `+` starts a session in the project you are
  working in, and fork branches off the conversation you are looking at.

- **Temporary chats.** The chat button on a project row opens a scratch
  conversation about that project. Right-click the project and **View Chat
  History** for the list of past chats.

- **Projects inside projects.** For larger projects, subprojects keep track of
  separate concerns. Each keeps its own directories, provider and account.

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

## Documentation

- **[Settings](docs/settings.md)** — all 26, with defaults.
- **[Reference](docs/reference.md)** — how it works, projects, notifications,
  workspaces, close vs delete, naming, the sidebar rendering modes, and what you
  get alongside the Claude Code extension.

## Privacy

Nothing leaves your machine. Flock makes no network requests. It reads the local
session roster and local transcript files, and writes only to its own extension
storage — plus, if you explicitly opt in, the hooks plugin directory and
`~/.lineage/events.ndjson`.

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
