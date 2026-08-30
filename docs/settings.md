# Settings

All 48 settings, as contributed. The keys keep the `lineage.` prefix — Flock
was named Lineage before 0.1.0, and renaming settings keys would silently
discard everyone's existing configuration.

**You do not have to read this table to set Flock up.** Seventeen of these ship
off, and only some of them are off because the default is right —
`lineage.hooks.enabled` and `lineage.verbs.enabled` are off because turning them
on writes files in your home directory, which is not something an extension may
do unasked. **Flock: Recommended Setup** in the command palette is the checklist
that offers those, asks about the branch rows, leaves the clean slate alone, and
says what each one does before you tick it — see
[The recommended setup](reference.md#the-recommended-setup).

One of them, `lineage.git.pullRequests`, is the only setting in Flock that makes
anything leave your machine. It is off by default and its row below says exactly
what turning it on runs.

Four of them are one feature: `git.branches`, `git.sessionBranchDetail`,
`git.pullRequests` and `preview.directoryModel`.
**Flock: Show Branches and Worktrees** in the command palette writes all four,
and **Flock: Hide Branches and Worktrees** writes the defaults in this table
back — see
[Turning it all on at once](reference.md#turning-it-all-on-at-once).

| Setting | Default | What it does |
| --- | --- | --- |
| `lineage.viewStyle` | `"inline"` | How the Sessions view is drawn. `inline` renames on the row like the Explorer; `native` uses the built-in tree widget (better accessibility, rename opens at the top of the window). Reload to apply. |
| `lineage.pollIntervalMs` | `3000` | How often to poll `claude agents --json`, in milliseconds. |
| `lineage.claudeBinary` | `""` | Full path to the `claude` CLI. Empty searches `PATH`. |
| `lineage.codexBinary` | `""` | Full path to the `codex` CLI, used by sessions on a Codex / OpenAI account. Empty searches `PATH`, then the usual install roots (`~/.codex/bin`, the active nvm node version, `~/.local/bin`, Homebrew). Worth setting explicitly if you use a node version manager: `codex` is installed per node version, and VS Code often does not inherit the PATH that selects one — which is what makes a Codex row's **Sign in** appear to do nothing. |
| `lineage.terminalLocation` | `"editor"` | Where a session opens: `editor` tab, terminal `panel`, or `newWindow`. |
| `lineage.soloSession` | `false` | Quality-of-life: keep at most **one** session tab open. Opening or focusing a session parks the others — tmux-wrapped ones detach and keep running hidden, bare ones close and `--resume` from the tree (busy/waiting bare ones are spared) — and the kept tab is pinned. Workspace switches restore only the session you were last using. |
| `lineage.chat.autoCloseMinutes` | `30` | A project chat's tab closes on its own after this many minutes without use. The conversation is kept — **Chat History…** on the project's row reopens it — so this tidies the tab, never the words. A chat that is busy or waiting is never touched, and neither is the tab you are looking at. `0` turns it off. |
| `lineage.session.closeAfterMinutes` | `30` | Any session's tab closes on its own after this many minutes without real activity (measured on the transcript, not file timestamps). The conversation is kept — its row stays in the tree as an archived session, one click from resuming — so this tidies the process, never the words. A busy or waiting session is marked *close after this turn* instead and closes once idle; the active tab and any session pinned with **Keep Awake** are never touched. `0` turns it off. |
| `lineage.session.detachGraceMinutes` | `10` | When a workspace switch (or solo mode) closes a tmux-wrapped session's tab, the process keeps running detached for this many minutes so switching back reattaches instantly. Its row stays in the tree and its hover says how long is left. At the deadline an idle session is closed — the row stays and a click resumes it; a busy one closes after its turn ends. At most 8 sessions run detached at once; overflow closes the oldest idle one first. `0` disables the grace — the process is ended by the next sweep within a minute. |
| `lineage.session.reloadGraceSeconds` | `45` | How many seconds a session may keep running after the window that owned it closed. A measurement, not a reprieve: VS Code reports a window **reload** and a window **close** identically, so the only way to tell them apart is to wait — a reload comes back and reattaches, a close never does. At the deadline the session settles to a closed row you can resume, because a folder no window has open should have nothing running in it. Keep this low; raise it only if reloads here are slow enough to lose sessions. `0` ends sessions the moment the window goes, which also means every reload loses them. |
| `lineage.fork.notifyParent` | `false` | After a fork, type **one sentence into the parent conversation** naming the new branch and, when you gave the fork an opening prompt, what it is for. **This is new construction, not an existing mechanism being switched on** — Flock has no session-to-session messaging; the in-session verbs channel runs one way, session → Flock, and the only text that ever went the other way is a fork's opening prompt, delivered once at birth. The note rides the one channel that reaches a conversation already running — the same one the wrap prompt uses — which **types into the terminal**: it costs the parent a real turn, and it is appended to whatever you had half-typed in that input box. **It works only while the parent's tab is open in this window.** A parent that is closed, hosted by another window, running outside Flock, or parked by a workspace switch cannot be typed into, and in all four cases nothing is queued and nothing is retried — one line in the **Flock** output channel and that is all. Those are the ordinary cases. Never sent when Claude itself asked for the fork: the verbs CLI already reports the new branches into that same turn. A branch renamed on its row in the inline sidebar is announced under its **generated** name, because the note goes out while the rename editor is still open. |
| `lineage.close.summaryMode` | `"compact-and-tell-parent"` | What **Close with Summary** does. **How the summary is made, precisely:** Flock cannot ask a model for a summary — it has no API client and speaks to a running conversation only by typing into its terminal — so the compacting modes **send `/compact`**, a command the Claude CLI interprets, and then **read back the summary the CLI wrote** into the transcript. The words are genuinely the model's; the driving is a keystroke. It is not a scrape of the last exchange. What that costs: **one to three minutes** behind a progress notification with a Cancel button; the branch's own context is **squashed**, which is only acceptable because it is being closed in the same breath; **Claude only** (a Codex session is offered the plain close by name); and the session's **tab must be open in this window** — a closed row, another window's session, a foreign process and a parked wrap are all refused before anything is typed. If no summary comes back, **nothing is closed**: the session is mid-turn, and cutting it off would lose the compaction too. `compact-and-tell-parent` (the default) also types a short form into the **parent**, with the same reach and the same silence on failure as `lineage.fork.notifyParent`. `compact-only` records it and tells nobody. `ask-me` is the old input box, kept by name. `off` closes with no summary at all. [Details →](reference.md#closing-with-a-summary) |
| `lineage.launch.mode` | `"flock"` | Who opens a conversation. `flock` opens it here, in a terminal Flock owns. `claudeExtension` hands it to the official Claude Code extension: new conversations run its **New Conversation** command (opening in your preferred location — sidebar or editor) and are adopted onto a row once the CLI reports it; clicking a closed row reopens the conversation in the extension's UI; clicking a live one it hosts reveals or offers its panel — at the cost of tmux parking, the two Close verbs, account pinning, the wrap prompt and Flock-named tabs. Requires that extension; without it Flock falls back to opening the session itself and says so once. Fork is never delegated, and a conversation routed or pinned to another provider's CLI or to an account with its own config directory stays in Flock's terminal — the extension, on the machine's own login, could not host it. [Details →](reference.md#using-flock-alongside-the-claude-code-extension) |
| `lineage.sessionSwitching` | `"flock"` | Where you switch between conversations. `flock` makes the tree the switcher: the row of whatever conversation is in front stays **selected**, so the sidebar always already says where you are, and `alt+left` while the Claude Code extension has focus puts the **keyboard** on that row — so the up and down arrows move you between sessions from there. That binding exists because of the back arrow at the top of Claude Code's panel, which leaves your conversation for an agent list that knows nothing about forks, projects or worktrees and is very easy to hit by accident. Flock cannot intercept that arrow — it is a route change inside another extension's webview and produces no tab, title, command or context key on the outside — so what it does instead is make sure the tree never lost your place, and give the same gesture somewhere better to go. `claude` turns both halves off and leaves the agent list alone. |
| `lineage.tmux` | `"auto"` | Run Flock-launched sessions inside a private tmux server (`tmux -L lineage`). This upgrades workspace parking from close-and-resume to detach-and-reattach: switching away hides a session's tab while the conversation **keeps running** — busy ones too — and switching back reattaches it instantly. Requires tmux on `PATH`; without it, and always on Windows, Flock falls back to close-and-resume. Sessions started outside Flock are never wrapped either way. |
| `lineage.groupByFolder` | `true` | Group sessions no project claims by their working directory. |
| `lineage.onlyProjectSessions` | `false` | Show only sessions belonging to one of your projects. The roster is machine-wide, so this is the fastest way to stop seeing every directory anyone ever ran `claude` in. Ignored while you have no projects. |
| `lineage.showForeignSessions` | `false` | Show live sessions Flock does not own — `claude` running in some other terminal, another editor, a script. Off (the default), the tree holds only what you told Flock about: sessions launched here, bound to one of its terminals, or added with **Add Existing Session…** / **Import Previous Sessions…** — and a session with no row can never light the bell or write itself into your tree. Turn it on to watch everything on the machine, the way Flock used to; finished turns then stamp those sessions into the tree as they always did. |
| `lineage.onlyActiveSessions` | `false` | Show only sessions that are still running. Closed rows are filtered, not archived or removed, and a live fork of a closed session keeps its place. The **Show Only Active Sessions** toggle in the view title writes this. |
| `lineage.showGhosts` | `true` | Show exited ancestor sessions that live sessions were forked from. |
| `lineage.showArchived` | `false` | Show **all** closed sessions found in `~/.claude/projects`, even ones this tree never knew. Off by default: your own sessions already stay in the tree after their tab closes, as dimmed resumable rows, until you archive them — so this only adds foreign history on top. **This is not the archive:** sessions you archived are behind **Archived Sessions…** on the project's row. |
| `lineage.showPhantomRows` | `false` | Show roster rows that are not sessions — entries whose process exited but that `claude agents --json` never reaped, and `claude bg-spare` warm-spares. These cannot be focused, forked or resumed, and a stuck spare will pin the attention badge indefinitely. For debugging the roster. |
| `lineage.busyStaleMinutes` | `5` | How long a session may hold the CLI's `busy` status with an untouched transcript before Flock stops drawing the amber dot and shows it as idle. `claude agents --json` sometimes freezes a status at `busy` after the turn actually ended; a genuinely working session writes its transcript within seconds. Raise it if a long single tool call briefly flips to idle. |
| `lineage.staleAfterHours` | `48` | Age at which **Archive Stale Sessions…** pre-ticks a session. Never removes anything on its own — it only decides which checkboxes start ticked. |
| `lineage.showTokens` | `false` | Put a session's token count left of its age — the context its last turn ran with (prompt + cache + output), the same number `/context` reports. Off by default: it is a second number on every row. |
| `lineage.groupSessionsByBranch` | `false` | Requires `lineage.git.branches`. Nest a project's sessions under the git branch they are running on. A project with subproject rows ignores this — a session cannot be filed under a directory and a branch at once, and the directories win. Otherwise: nest a project's sessions under the git branch they are running on. Each branch row becomes a container you can fold shut, with a `+` that starts a session in that worktree; a session no shown branch accounts for stays directly under the project. Only applies to a project with two or more worktrees. Off by default — it is the right shape for one-agent-per-worktree and the wrong one for a single checkout with a few forks in it. |
| `lineage.branchColors` | `[]` | Requires `lineage.git.branches` **and** `lineage.git.branchDisplay: color`; `inline` tints nothing. Colours for the branch rows, in order; index 0 is the first branch under a project (usually `main`). Each entry is a hex colour (`#7aa2f7`) or a theme colour id (`charts.blue`). A short list fills the rest from the built-in muted palette. |
| `lineage.git.branches` | `false` | **The branch block's master switch.** On, each of a project's git checkouts gets a row of its own: the branch name, where the checkout stands against its upstream (`↑2 ↓1`, with `*` against the branch name for uncommitted work), a `+` that starts a session in that worktree (cutting one first if the branch has no checkout), **New Worktree…** / **Remove Worktree** and **Choose Branches to Show…** — plus the pull-request chip if `lineage.git.pullRequests` is on as well. Off by default, and not because it is unfinished: a repository with six checkouts is six rows before the first session, and a sidebar is 250px wide. Everything below that mentions branches or worktrees does nothing while this is off, including the menu entries and the palette verbs. What it does **not** gate is which project a session belongs to — a session in a linked checkout is filed under the project that owns the repository either way, because turning a view option off must never move your sessions. |
| `lineage.git.branchDisplay` | `"inline"` | Requires `lineage.git.branches`. **How a session says which worktree it is running in** — two ways of answering one question, both complete. `color` tints the session's name from a per-branch palette and makes the project's branch rows the key to it: no width at all, and it answers *are these two on the same thing* down a whole column at a glance; what it cannot say is *which* thing, so `↑4 ↓3`, the `*` and the pull request live in the hover. `inline`, the default, writes the branch under the session instead — `⇡ feat/search-ranking * ↑4 #128 ✓`, the way a git prompt says it — and puts the name back to the theme's own colour. It answers *which*, and carries the state tokens on the row, where the mark on the left is the pull request's in GitHub's own colours (green open, purple merged, grey draft, dimmed closed) and the branch name and the `#42` are **links** to the branch and the request on GitHub. It costs **height**: twelve sessions become twenty-four rows' worth. In both modes the branch rows are **shut until you ask for them** — a project's or a directory's right-click, or the git-branch button on the project row. A line is drawn only where it says something new: on a session whose worktree differs from the one above it, in a project with more than one checkout — a fork made in its parent's worktree gets none. |
| `lineage.git.sessionBranchDetail` | `"standard"` | Requires `lineage.git.branches` and `lineage.git.branchDisplay: inline` — colour mode has no line, so this does nothing there. How much the line under a session says. `standard` is the vocabulary git prompts and the SCM view already use — `↑4 ↓3 *` and nothing else — so it reads without anybody learning it, and it touches nothing but local files. `detailed` adds the pull-request chip and the two states arrows render as blank: `local` for a branch that tracks nothing, and the word `merged`, which is the signal that the worktree can be removed. The chip half needs `lineage.git.pullRequests` on as well, since that is what fills the cache it reads. |
| `lineage.git.worktreePath` | `"../${repo}-${branch}"` | Requires `lineage.git.branches`. Where **New Worktree…** puts a new checkout. `${repo}` is the repository directory's name, `${branch}` the branch name with anything a path cannot carry replaced by `-`. A relative pattern resolves against the repository's **main** worktree, so the default puts `feat/x` of `~/code/app` at `~/code/app-feat-x`; an absolute path is used as written, and a leading `~/` expands. Must contain `${branch}`, or every branch would resolve to the same directory. Flock always shows the exact `git worktree add` command before running it. |
| `lineage.git.newSessionInWorktree` | `false` | Requires `lineage.git.branches`. Make the **`+` on a project or subproject row** cut a new worktree first and start the session there, instead of starting it in the directory as it is. One agent per checkout is why most people turn the branch feature on, and with this off that costs a right-click every time. It changes the button's **default and nothing else**: both verbs — **New Session** and **New Worktree…**, which adds the checkout and starts a session in it — are on the row's right-click whichever way this points, and the `+`'s tooltip says which one it is about to run. The worktree half still confirms and still quotes the exact `git worktree add`. |
| `lineage.git.pullRequests` | `false` | **The one thing in Flock that reaches the network**, and it needs `lineage.git.branches` on as well — the chip it draws lives on a branch row. On, Flock runs `gh pr list --state all --limit 100 --json number,title,state,isDraft,headRefName,url,statusCheckRollup` in each project's repository and puts the pull request on each branch row as a chip — number, state, check rollup — with **Open Pull Request in Browser** on the row's menu and **Create Pull Request…** (`gh pr create --web`, which opens the page for *you* to submit). It shells out to the [`gh` CLI](https://cli.github.com) you installed and authenticated: no HTTP request from the extension, no bundled API client, no token ever seen or stored. Polled only while the Sessions view is visible, at most once every five minutes per repository, and cached. Missing `gh`, no `gh auth login`, or no GitHub remote all render the rows exactly as this being off does, with one line in the **Flock** output channel and no dialog. |
| `lineage.preview.directoryModel` | `false` | **PREVIEW.** Requires `lineage.git.branches`. Hang the branch rows off a **directory** instead of off the project, and list **every local branch** of that directory's repository rather than only the checked-out ones. A subproject row names one directory and a directory is exactly one repository or none, so that row is what a branch belongs under — a project spanning three repositories stops showing three branches called `main` with nothing to tell them apart. A project with one directory keeps its branches on the project row, because that row *is* its directory. Outside the fold: the directory's own checkout, and any branch with a session running on it. Everything else — a worktree with nothing running in it included — goes into one **Branches (N)** row, newest commit first, with each branch's age beside it, **shut by default**: that is what makes listing a 180-branch repository cost one row. A branch with no checkout has nowhere to run, so it has no `+` and no session verbs — its menu offers **New Worktree…** instead. Draws in the inline sidebar (`lineage.viewStyle: inline`, the default); with `native` the tree keeps the rows it has today. [Details →](reference.md#the-directory-model-preview) |
| `lineage.notifications.enabled` | `true` | Track finished sessions: red dot until looked at, project-row roll-up, and the bell. Off restores the plain waiting-only dot. Overridable per session from each row's context menu. |
| `lineage.notifications.popup` | `false` | Also show a toast with a **Focus** button when a session finishes while you are elsewhere. Off by default — with many parallel sessions the bell and dots carry the same information without the interruption. |
| `lineage.mode` | `"folder"` | What a window **is** — three answers. `folder` (**One folder per project**, the default): the window is the folder you opened, the sidebar shows the sessions under it, and another project's work routes to that project's own window. `root` (**Root**, i.e. Flock only): the window is Flock's — nothing fenced, nothing scoped, the whole machine in one sidebar, and you open a window on a session when you want its files. `project` (**Auto-switch**): one window spans many projects and switches between them as your attention moves. Navigation never changes a session's lifecycle in any of the three. **Flock: Choose Window Model…** picks one with what it costs written beside it. [The three window models →](#the-three-window-models) |
| `lineage.workspaces.enabled` | `true` | **Deprecated** — superseded by `lineage.mode`, still honoured, and read in exactly one place. While this is `false` and the mode is `project`, the window resolves to the **Root** (Flock only) model, which is what that pair has always actually meant. Set `lineage.mode` to the model you want — or run **Flock: Choose Window Model…**, which writes both — and this key can go. [The three window models →](#the-three-window-models) |
| `lineage.workspaces.resumeSessions` | `true` | Resume a project's parked sessions when switching to its workspace, up to 8 per switch. Parking closes a session's terminal on switch-away, so with this off nothing is parked at all. |
| `lineage.workspaces.autoSwitch` | `true` | Focus follows project: working in a session that belongs to another project switches the window to that project's workspace by itself. |
| `lineage.explorer.followProject` | `true` | An **Auto-switch** dial, not a window model of its own: while `lineage.mode` is `project`, the Explorer follows the **session** you are working in — the file tree roots itself at that session's subproject directory, inside the git worktree the session is actually checked out in. Requires running **Flock: Follow the Session I Am In** once per window, which converts it to a Flock workspace (one reload). Turning it off leaves you in Auto-switch with the tree where you put it: tabs still switch, the status line still says where you are, and Source Control still follows the session's checkout. |
| `lineage.explorer.scope` | `"directory"` | The other **Auto-switch** dial. How much of the project the Explorer shows. `directory` keeps the file tree to the one directory you are working in — which one that is follows the session you have focused, so the tree moves with you; the **Project** view lists the rest, and clicking one sends the tree there. `project` shows every connected directory as its own collapsible root, which is what Flock did before this setting existed — and, because a scope that expands every directory into a root has nothing left to narrow, it is also the setting under which the tree stops following you and only a switch reshapes it. Source Control follows the session's checkout either way. Applies only while `lineage.explorer.followProject` is on, and takes effect on the next focus change — no reload. |
| `lineage.accounts.enabled` | `true` | The accounts feature's off switch. Off hides the list only — routing, pinning and the account verbs all keep working from the palette. Whether the list is *drawn* is `lineage.accounts.section` below; both have to be on. |
| `lineage.accounts.section` | `true` | Draw **Accounts** as a second section of the Flock sidebar. On by default — the accounts are worth a row of their own. The only reason to turn it off is the top bar: VS Code merges a view's buttons into the container header — the row reading **FLOCK** — only while that container shows exactly one section, so while Accounts is drawn the bell, New Project, `+`, fork and the gear sit on the **SESSIONS** row just below the name instead. Turning this off moves them up one row and costs you the section. Nothing about accounts stops working while it is off: usage is still read, new sessions are still routed, a session is still pinned to its account for life, and every account verb is in the palette under **Flock**. The switch is in the gear menu either way. |
| `lineage.shells.section` | `true` | Draw **Shells** as a section of the Flock sidebar: one row per command your sessions actually run — every `Bash` call Claude makes, with the ones executing right now pinned to the top and a live clock on each. Failed runs show their exit code, refused ones say they never ran, and a backgrounded job stays on the list until it finishes, with **Open Output** on its menu for the file the CLI is writing its stdout to. Ships collapsed, and the section's badge counts what is running — so a script still going is visible without opening it. **Every live session on this machine**, not only this window's: the facts come from the transcripts on disk, so a command running in a session another window launched is a row here like any other. Clicking a row focuses the conversation that started it. Like **Accounts**, drawing a second section moves Flock's top-bar buttons down onto the **SESSIONS** row. |
| `lineage.accounts.offerSwitchAtLimit` | `false` | Offer to **move a running conversation to another account** when the account it is on uses up its five-hour window. Flock already reads every account's meters, so it knows the moment one fills — which is the moment somebody with a second subscription wants the conversation they were in the middle of moved. On, a session hosted by this window whose account has just run out gets one notification naming the account with the most room, and a button that opens the ordinary **Move to Account...** flow with that account already chosen; the confirmation still appears, because what the move costs is the same however you reached it. Off by default: the offer proposes an interruption, and that is only welcome to somebody who decided in advance they would rather be asked. Nothing is lost with it off — the verb is in a session row's menu whenever that conversation is a Claude one and the roster holds a second account it could run on, and it is always in the palette. Both halves of that gate are needed and only one of them used to be checked: the menu counted accounts that could *host* a session, which since the launcher learned to run `codex` includes a Codex login, so a machine with one Claude account and one Codex account drew the verb on every row and opened an empty picker. One offer per five-hour window per session, so a meter that re-reads on a timer cannot become a repeating prompt. |
| `lineage.hooks.enabled` | `false` | Read the hook event stream for instant updates. **Install Instant-Update Hooks…** turns this on for you; set it to `false` to stop reading without uninstalling the plugin. |
| `lineage.verbs.enabled` | `false` | Read fork requests written by Claude sessions, so "fork this session" typed *to Claude* runs the same fork the sidebar button runs. **Install In-Session Verbs…** turns this on for you; set it to `false` to stop reading requests without uninstalling the skill. [Details →](reference.md#in-session-verbs) |

## The three window models

`lineage.mode` answers one question — **what is a VS Code window, as far as
Flock is concerned?** — and there are three answers. They are a ladder, from the
window that holds one thing to the window that follows you, and each one is
genuinely better than the other two at something and worse at something else.
None of them is a beginner setting somebody graduates out of.

|  | **One folder per project** `folder` *(default)* | **Root (Flock only)** `root` | **Auto-switch** `project` |
|---|---|---|---|
| What a window is | the folder you opened | Flock's own window; no folder | one window, whichever project you are in |
| What the sidebar shows | sessions under that folder, grouped by the projects that claim them | everything on the machine — nothing is scoping it | everything, with the active project's workspace restored |
| Starting work elsewhere | routed to that project's window, opening one if none has it | you open a window on it — **Open Workspace for This Session** is on every session row | the window goes there |
| The Explorer | the folder you opened, untouched by Flock | untouched by Flock | follows the session you are in, after a one-time conversion (`lineage.explorer.followProject`) |
| Source Control | the folder's repository | nothing, until you open a window | the **checkout** the session you are in is running in — the linked worktree, with its own branch, not the main one — once the window has been converted |
| Workspace status-bar item | never | never | yes, and it says where you are |
| Switching inside the window | refused, with directions | available when you ask for it — never by itself | by itself, and by the verb |
| What it needs | nothing | nothing | tmux, so what you switch away from keeps running; one reload to convert the window |
| **What it costs** | a window per project, and alt-tab is your switcher | a window per piece of work you actually want files for, and a sidebar with nothing narrowing it | a window that rearranges itself, and the hardest of the three to keep straight |

**One folder per project** is native VS Code, and it is the default because it is
the only one of the three that is right for a window whose folder Flock did not
choose. A window is the folder you opened, the way every other extension already
assumes; the tree fences itself to sessions under that folder, and a session
belonging to somewhere else is not hidden from you — it routes to its own window,
which is the one place it can actually be worked on. Nothing rearranges itself,
so nothing surprises you. It is also the only model that needs no tmux, which
makes it the cheapest to run and the least convenient to live in: two projects
means two windows, and alt-tab is your switcher.

**Root** — Flock only — is the window with no folder at all. The sidebar is the product:
every session on the machine, in one tree, with nothing narrowing it — and when
you want a piece of work's *files*, you open a window on that piece of work.
In-window switching is still here and still works, so nothing is taken away from
somebody who wants it; what this model does not do is switch **by itself**, or
put a workspace button in your status bar. That difference is the whole of what
separates it from Auto-switch. It costs you the window you open per piece of
work, and a sidebar you have to read rather than scan.

Opening that window is a right-click: **Open Workspace for This Session**, on
every session row in both sidebars, opens a window on the conversation's own
worktree — or its subproject's directory, or the directory its project claims —
and raises the window that already covers it rather than opening a second one.
The verb is not gated on the model; it is simply the move this one is built
around. [How it chooses →](reference.md#going-to-a-sessions-workspace)

**Auto-switch** is the convenient one, and Axel's own. One window spans every
project: work in a session belonging to somewhere else and the window goes there
— its saved tabs, its Explorer roots, its branch — without your asking. It is the
most convenient of the three and the hardest to keep straight, because the window
in front of you is a thing that moves. It wants **tmux** (see `lineage.tmux`), so
the sessions you switch away from keep running detached instead of being closed
and resumed, and it wants one run of **Flock: Follow the Session I Am In** per
window — a conversion that costs a reload — before the file tree follows too.

What it follows, once converted, is the **session** and not the project. Focus a
conversation and the Explorer roots itself at that session's subproject
directory, translated into the git worktree the session is actually running in —
so a session in `~/mono-feat-x/api/src`, in a linked worktree of the monorepo you
split into `api` and `web`, gets a file tree rooted at `~/mono-feat-x/api` rather
than at `~/mono/api` (a tree you are not editing) or at `~/mono-feat-x` (the
whole monorepo). Source Control gets the same answer one level up: the checkout,
`~/mono-feat-x`, with its own branch and its own changes. Moving between two
lanes of one project is not a switch and never was — it is most of the day for
one-agent-per-worktree work, and it is exactly what this follows.

What it costs, beyond the reload: a permanently visible anchor row at the top of
the Explorer (an empty directory Flock owns, which is what keeps a folder splice
from restarting the extension host — expanding it shows nothing, and it carries
the active project's name as a caption); a window that is never the answer to
"which window has `~/foo` open", because its roots change every few minutes and a
stale claim would send other windows' work to a roost that has moved; and, on a
subproject whose repository root sits *above* the directory being shown, a
dependence on VS Code's `git.openRepositoryInParentFolders`. Flock asks the git
extension to open that repository directly, which is the documented way past the
prompt; if your editor's git build declines, setting
`git.openRepositoryInParentFolders` to `"always"` is the remedy, and it is yours
to set rather than Flock's — it changes behaviour for every repository you open.
[The experiment that settles it →](reference.md#does-source-control-really-follow)

### If you had the old settings

`lineage.mode` used to have two values, with `lineage.workspaces.enabled`
shadowing it, so the third model existed as a corner of a truth table nobody
could name. It is now a value, and the old pair folds into it once, on read.
**Nothing on your machine was rewritten** — the fold is a rule, not an edit, and
Flock does not write to a `settings.json` you did not ask it to write to.

| `lineage.mode` | `lineage.workspaces.enabled` | you are now in |
|---|---|---|
| unset | anything | **One folder per project** |
| `"folder"` | anything | **One folder per project** |
| `"project"` | unset or `true` | **Auto-switch** |
| `"project"` | `false` | **Root (Flock only)** |
| `"root"` | anything | **Root (Flock only)** |
| anything else | anything | **One folder per project** |

The one row worth pausing on is `("project", false)`. That pair *already* gave a
window with no auto-switch, no status-bar button and no fence — Flock only in
everything but name — so calling it that moves nobody. The only visible
difference is that the `$(layers)` button in the Explorer's **Project** view
title, which is persistent chrome, belongs to Auto-switch now: in the Flock-only
model it would have been a second, quieter copy of the status-bar button that
model is defined by not having. The verb itself is still on the project row, in
the palette, and on any keybinding you gave it.

If you want the auto-switching window, set `lineage.mode` to `project` **and**
delete `lineage.workspaces.enabled` — or just run **Flock: Choose Window
Model…**, which writes both for you. That picker is the only thing in Flock that
ever writes that key, and it writes it because you asked.
