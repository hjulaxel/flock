## Turn on the parts that are off

Flock ships dozens of settings, and a good many of them are off. They are not
all off for the same reason, and that is the thing worth knowing:

- **Two are off because turning them on writes files in your home directory.**
  Instant updates and the in-session verbs are both genuinely worth having, and
  neither could switch itself on without asking you first. (Instant updates
  come in a Claude half and a Codex half behind the one switch; the Codex half
  is offered only where there is a Codex to hook.)
- **Some are off because they *are* the clean slate** — the quiet first launch
  the previous step described. Nothing recommends changing those.
- **The branch rows are off because they cost rows** in a sidebar 250px wide.
  Whether that is a good trade depends on your repositories, so you get asked
  rather than told.
- **The rest are taste**, and they stay in the settings UI where they belong.

**Recommended Setup** asks four things, all pre-ticked — five on a machine with
Codex, whose hooks get a line of their own — and you can say yes to all of them
without understanding Flock yet.

### What it asks

| | What it does | What it writes |
|---|---|---|
| **Instant updates** | The tree is a three-second poll without them. With them Claude writes each event as it happens and the tree redraws immediately. | A plugin directory under `~/.claude/skills`. Never `~/.claude/settings.json`. |
| **Instant updates for Codex** *(offered when Codex is on the machine)* | The same, for Codex sessions: the amber dot while it works, the green dot the moment a turn ends, a waiting mark when Codex asks permission. | One entry per event **merged into** `~/.codex/hooks.json` — every other entry in it kept — and stripped back out on removal. Codex runs them only after you trust them once, with `/hooks` in a Codex session. |
| **In-session verbs** | "Fork this session" typed *to Claude* runs the same fork the sidebar button runs, with the same lineage edge. | A skill file and a small CLI. Both `rm -rf`-uninstallable. |
| **Your first project** | A name and a directory. Sessions group under it, it gets a workspace, it can pin an account. | Nothing on disk. |
| **Your history** | The bulk import door, if this machine has sessions with no row yet. | A row per session you tick. |

Two more lines appear only when they apply: **turn tmux back on**, if tmux is
installed but switched off; and **branch rows** *(offered, not recommended)*, if
one of your repositories has more than one checkout — that one writes
`lineage.git.branches` alone, never the pull-request chips, which are the one
thing in Flock that reaches the network.

Every line says what it writes before you tick it, and the two that write files
name every path in a dialog of their own before anything is created. The
receipt afterwards tells you how to undo each thing you accepted.

### Two questions it does not ask

**What a window is** — one folder per project, Flock only, or auto-switch — and
**where sessions open** — one pinned tab, editor tabs, the terminal panel, a
window of their own, or the Claude Code extension — are taste, and nobody can
answer them before they have lived with the default. Both live in the gear at
the top of the sidebar, as **Choose Window Model…** and **Choose Where Sessions
Open…**, each naming your current answer. Flock offers each one once, at the
moment it becomes real: the first time a session from another project has to
open in its own window, and the first time you have two session tabs open.

Run the checklist any time from the command palette — **Flock: Recommended
Setup** — or from the gear.
