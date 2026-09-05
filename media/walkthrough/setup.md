## Turn on the parts that are off

Flock ships dozens of settings, and a good many of them are off. They are not
all off for the same reason, and that is the thing worth knowing:

- **Two are off because turning them on writes files in your home directory.**
  Instant updates and the in-session verbs are both genuinely worth having, and
  neither could switch itself on without asking you first.
- **Four are off because they *are* the clean slate** — the quiet first launch
  the previous step described. Nothing recommends changing those.
- **The branch rows are off because they cost rows** in a sidebar 250px wide.
  Whether that is a good trade depends on your repositories, so you get asked
  rather than told.
- **The rest are taste**, and they stay in the settings UI where they belong —
  except one question worth asking out loud: **where sessions open**. One
  pinned tab at a time, a tab per session beside your files, the official
  Claude Code extension's own UI, or the bottom terminal panel. The checklist
  asks; it never pre-answers.

**Recommended Setup** offers you the first group, asks about the third, asks
where sessions open and what a window *is*, and never touches the second.

### What it can turn on

| | What it does | What it writes |
|---|---|---|
| **Instant updates** | The tree is a three-second poll without them. With them Claude writes each event as it happens and the tree redraws immediately. | A plugin directory under `~/.claude/skills`. Never `~/.claude/settings.json`. |
| **In-session verbs** | "Fork this session" typed *to Claude* runs the same fork the sidebar button runs, with the same lineage edge. | A skill file and a small CLI. Both `rm -rf`-uninstallable. |
| **Your first project** | A name and a directory. Sessions group under it, it gets a workspace, it can pin an account. | Nothing on disk. |
| **Your history** | The bulk import door, if this machine has sessions with no row yet. | A row per session you tick. |
| **Branch rows** *(offered, not recommended)* | A row per checkout, with the worktree verbs. | `lineage.git.branches` alone — never the pull-request chips, which are the one thing in Flock that reaches the network. |
| **What a window is** *(asked, never assumed)* | A three-way picker: one folder per project — a window *is* the folder you opened; Flock only — the window is the sidebar, and you open a window when you want files; or auto-switch — one window that follows whichever project you are working in. The default is the first, and the default was never your answer. | `lineage.mode` — and only after you choose one in the picker. Auto-switch also retires the legacy `lineage.workspaces.enabled` key on your machine. |
| **Where sessions open** *(asked, never assumed)* | A four-way picker — pinned single tab, editor tabs, the Claude Code extension, or the bottom panel — with your current answer marked. | `lineage.terminalLocation`, `lineage.soloSession`, `lineage.launch.mode` — and only after you choose an option in the picker. |

Every line says what it writes before you tick it, and the two that write files
name every path in a dialog of their own before anything is created. The
receipt afterwards tells you how to undo each thing you accepted.

Run it any time from the command palette — **Flock: Recommended Setup** — or
from the gear at the top of the sidebar.
