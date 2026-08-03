<p align="center">
  <img src="media/icon.png" width="88" height="88" alt="">
</p>

<h1 align="center">Canopy for Claude Code</h1>

<p align="center">
  See every Claude Code session you're running as one live tree —<br>
  who forked from whom, who's working, and who's waiting on you.
</p>

---

When you run one coding agent, a terminal tab is enough. When you run six, the
hard part stops being the code and starts being the bookkeeping: which of these
is still thinking, which one finished twenty minutes ago and has been waiting
since, which three came from the same conversation, and which worktree each of
them is standing in.

Canopy puts all of it in the sidebar as a single live tree. Fork ancestry is
drawn, not guessed. A finished session gets an unread mark that clears when you
look at it. Sessions group under projects you define, colour-coded by git
branch. And it is read-only where it counts — no daemon, no network, and nothing
written to your repository.

<!-- TODO(launch): screenshot of the sidebar — a project with three or four
     sessions, one amber, one red, branch chips visible. This is the single
     highest-impact asset on the marketplace page. -->

## What it does

- **A tree of sessions, not a list.** See which session was forked from which —
  the branch points every other tool throws away. Native in-session `/fork`s
  count too: they write no transcript marker at all, and are recovered from the
  CLI daemon's own dispatch log and nested under their parent.

- **Attention routing, unread-style.** One mark at the right edge of the row,
  and only two things ever draw it: **amber** is working, **red** is finished
  and not yet looked at. Everything else draws nothing, because a column of
  marks nobody needs is a column the eye learns to skip. Look at a finished
  session and its dot goes quiet; the dot also rolls up to the project row, and
  the view badge counts exactly the red dots on screen.

- **A bell over the tree.** The latest finished sessions, unseen first, each
  with its project and age. Click one to jump there and mark it read, dismiss a
  single entry, or mark all read at once. Plus a per-session mute that puts a
  struck-through bell on the row.

- **Ages you can trust.** The time on a row is how long since *you* last
  prompted that session — read from the transcript, not the file's modification
  time — so a session churning away unattended does not sit there reporting
  "now".

- **Branches, when there are branches.** Running one agent per `git worktree` is
  how parallel work actually gets done, and grouping by directory throws away
  the only fact that mattered: that five checkouts are one repository. Canopy
  reads `git worktree list`, files every checkout of a project's repo under that
  project wherever it sits on disk, and gives each branch a colour-coded row.
  Click a branch to start a session in that worktree. Turn on
  `lineage.groupSessionsByBranch` and each branch becomes a container instead:
  its sessions hang under it and the whole branch folds shut.

- **Several accounts, one window.** A row per subscription you can launch on —
  work plan, personal plan, an API key — each showing how much of its five-hour
  and weekly windows is gone. Every account keeps its own config directory, so
  you sign in **once per account, ever**. New sessions are routed automatically,
  and a session is then pinned to its account for life.

- **Project workspaces.** Scope a window to one project. Switching saves the tab
  layout you leave and restores the target's. With tmux installed, other
  projects' sessions keep running while hidden and reattach instantly; without
  it they close and resume from transcript. Unsaved editors are never touched.

- **Orchestration verbs.** New, fork, **fork and compact** (branch a long
  conversation and let the *branch* squash its history — the parent keeps
  everything), rename in place, close with an optional summary, and drag to
  re-parent.

- **Chats, as many as you have questions.** The chat button on a project row
  opens a scratch conversation about that project — every directory it owns on
  `--add-dir`, no row in the tree, nothing to name. Every click opens a **new**
  one, so a question that occurs to you mid-answer never interrupts the answer.
  Right-click the project → **View Chat History…** for the list of every chat
  it has had, newest first, labelled with what you opened it with. Pick one to
  come back to it.

- **Projects inside projects.** A monorepo is not one project and neither is it
  six: file `api`, `web` and `infra` under `app` and the sidebar reads like an
  Explorer, to whatever depth you want. Each subproject keeps its own
  directories, provider and account. Drag a project row onto another to file it
  there, or onto empty space to bring it back out. Membership never moves with
  it — a session belongs to whichever project's directory is the longest match
  for where it is running, exactly as before.

- **Open and close projects.** A project you are not working on this month
  doesn't have to be deleted to get out of the way: **Close Project** takes its
  row and its sessions' rows out of the tree and changes nothing else — no
  process is signalled, nothing is deleted, whatever was running is still
  running. The `$(folder-opened)` button at the top of the view lists every
  closed project, with how many sessions each still has, and puts one back.

- **Nothing is lost.** Closing a tab does not remove its row — it dims and stays
  one click from resuming. Only **Delete** removes a row, and that is undoable.
  No transcript is ever touched.

## Requirements

- The `claude` CLI on your `PATH`, or `lineage.claudeBinary` set to its full path.
- VS Code 1.94 or newer. Also runs in Cursor, Windsurf and VSCodium — Canopy
  uses no proposed APIs.
- A trusted workspace. Restricted Mode blocks terminal creation, which Canopy
  needs.

## Documentation

- **[Settings](docs/settings.md)** — all 24, with defaults.
- **[Reference](docs/reference.md)** — how it works, projects, notifications,
  workspaces, close vs delete, naming, and the sidebar rendering modes.

## Privacy

Nothing leaves your machine. Canopy makes no network requests. It reads the
local session roster and local transcript files, and writes only to its own
extension storage — plus, if you explicitly opt in, the hooks plugin directory
and `~/.lineage/events.ndjson`.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit, source and tests
npm test            # vitest run
npm run compile     # esbuild bundle -> dist/extension.js
npm run watch       # rebuild on change
```

Press **F5** to open an Extension Development Host with Canopy loaded. There are
no runtime dependencies — the extension is Node builtins plus the `vscode` API,
bundled into a single file by esbuild. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the rest.

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
