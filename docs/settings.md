# Settings

All 24 settings, as contributed. The keys keep the `lineage.` prefix — Canopy
was named Lineage before 0.1.0, and renaming settings keys would silently
discard everyone's existing configuration.

| Setting | Default | What it does |
| --- | --- | --- |
| `lineage.viewStyle` | `"inline"` | How the Sessions view is drawn. `inline` renames on the row like the Explorer; `native` uses the built-in tree widget (better accessibility, rename opens at the top of the window). Reload to apply. |
| `lineage.pollIntervalMs` | `3000` | How often to poll `claude agents --json`, in milliseconds. |
| `lineage.claudeBinary` | `""` | Full path to the `claude` CLI. Empty searches `PATH`. |
| `lineage.terminalLocation` | `"editor"` | Where a session opens: `editor` tab, terminal `panel`, or `newWindow`. |
| `lineage.tmux` | `"auto"` | Run Canopy-launched sessions inside a private tmux server (`tmux -L lineage`). This upgrades workspace parking from close-and-resume to detach-and-reattach: switching away hides a session's tab while the conversation **keeps running** — busy ones too — and switching back reattaches it instantly. Requires tmux on `PATH`; without it, and always on Windows, Canopy falls back to close-and-resume. Sessions started outside Canopy are never wrapped either way. |
| `lineage.groupByFolder` | `true` | Group sessions no project claims by their working directory. |
| `lineage.onlyProjectSessions` | `false` | Show only sessions belonging to one of your projects. The roster is machine-wide, so this is the fastest way to stop seeing every directory anyone ever ran `claude` in. Ignored while you have no projects. |
| `lineage.onlyActiveSessions` | `false` | Show only sessions that are still running. Closed rows are filtered, not deleted, and a live fork of a closed session keeps its place. The **Show Only Active Sessions** toggle in the view title writes this. |
| `lineage.showGhosts` | `true` | Show exited ancestor sessions that live sessions were forked from. |
| `lineage.showArchived` | `false` | Show **all** closed sessions found in `~/.claude/projects`, even ones this tree never knew. Off by default: your own sessions already stay in the tree after their tab closes, so this only adds foreign history on top. |
| `lineage.showPhantomRows` | `false` | Show roster rows that are not sessions — entries whose process exited but that `claude agents --json` never reaped, and `claude bg-spare` warm-spares. These cannot be focused, forked or resumed, and a stuck spare will pin the attention badge indefinitely. For debugging the roster. |
| `lineage.busyStaleMinutes` | `5` | How long a session may hold the CLI's `busy` status with an untouched transcript before Canopy stops drawing the amber dot and shows it as idle. `claude agents --json` sometimes freezes a status at `busy` after the turn actually ended; a genuinely working session writes its transcript within seconds. Raise it if a long single tool call briefly flips to idle. |
| `lineage.staleAfterHours` | `48` | Age at which **Delete Stale Sessions…** pre-ticks a session. Never removes anything on its own — it only decides which checkboxes start ticked. |
| `lineage.showTokens` | `false` | Put a session's token count left of its age — the context its last turn ran with (prompt + cache + output), the same number `/context` reports. Off by default: it is a second number on every row. |
| `lineage.groupSessionsByBranch` | `false` | Nest a project's sessions under the git branch they are running on. Each branch row becomes a container you can fold shut, with a `+` that starts a session in that worktree; a session no shown branch accounts for stays directly under the project. Only applies to a project with two or more worktrees. Off by default — it is the right shape for one-agent-per-worktree and the wrong one for a single checkout with a few forks in it. |
| `lineage.branchColors` | `[]` | Colours for the branch chips, in order; index 0 is the first branch under a project (usually `main`). Each entry is a hex colour (`#7aa2f7`) or a theme colour id (`charts.blue`). A short list fills the rest from the built-in muted palette. |
| `lineage.notifications.enabled` | `true` | Track finished sessions: red dot until looked at, project-row roll-up, and the bell. Off restores the plain waiting-only dot. Overridable per session from each row's context menu. |
| `lineage.notifications.popup` | `false` | Also show a toast with a **Focus** button when a session finishes while you are elsewhere. Off by default — with many parallel sessions the bell and dots carry the same information without the interruption. |
| `lineage.workspaces.enabled` | `true` | Show the workspace switcher in the status bar. |
| `lineage.workspaces.resumeSessions` | `true` | Resume a project's parked sessions when switching to its workspace, up to 8 per switch. Parking closes a session's terminal on switch-away, so with this off nothing is parked at all. |
| `lineage.workspaces.autoSwitch` | `true` | Focus follows project: working in a session that belongs to another project switches the window to that project's workspace by itself. |
| `lineage.explorer.followProject` | `true` | The Explorer follows the active project, swapping the built-in file tree to that project's directories. Requires running **Canopy: Follow the Active Project in the Explorer** once per window, which converts it to a Canopy workspace (one reload). |
| `lineage.accounts.enabled` | `true` | Show the **Accounts** view. Off hides the list only — routing, pinning and the account verbs all keep working from the palette. |
| `lineage.hooks.enabled` | `false` | Read the hook event stream for instant updates. **Install Instant-Update Hooks…** turns this on for you; set it to `false` to stop reading without uninstalling the plugin. |
