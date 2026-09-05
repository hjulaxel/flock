# Settings

Every setting, as contributed. The keys keep the `lineage.` prefix — Flock
was named Lineage before 0.1.0, and renaming settings keys would silently
discard everyone's existing configuration.

The place to change them is VS Code's own Settings editor: **Flock: Open
Settings** (also **Flock Settings…** at the top of the gear menu) opens it
filtered to Flock, where the settings sit in ten categories — Sessions,
Attention, Forking and closing, Worktrees and branches, Accounts and sections,
Window, What the tree shows, Housekeeping, CLI, Hooks and verbs — with the
advanced rows last in each. **Flock: Open Advanced Settings** narrows it to those
rows alone (`@tag:advanced`: paths, timings, diagnostics, previews). Every
dropdown reads in words rather than values, the way the gear's pickers do.
**Flock: Status…** answers the questions this page is usually opened for — is
tmux installed and on, are the hooks and verbs in, which CLIs were found, which
window model this is, where sessions open — and picking a row runs the verb that
changes it.

**You do not have to read these tables to set Flock up.** A good many of these
ship off, and only some of them are off because the default is right —
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
and **Flock: Hide Branches and Worktrees** writes the defaults below back —
see
[Turning it all on at once](reference.md#turning-it-all-on-at-once).

## Every setting, by category

The block between the markers is generated from `package.json` by
`npm run docs:settings` — a setting is described in the manifest and nowhere
else, so change the words there and rerun the script rather than editing here.

<!-- generated:settings:start -->

Flock contributes **45 settings**. **16** of them are switches that ship off, and **19** are tagged *advanced* — paths, timings, diagnostics and previews, the rows `@tag:advanced` finds in the Settings editor. Advanced rows are marked below and sit last in their category.

### Sessions

| Setting | Default | What it does |
| --- | --- | --- |
| `lineage.tmux` | `"auto"` | Run Flock-launched Claude sessions inside a private tmux server (`tmux -L lineage`). This upgrades workspace parking from close-and-resume to detach-and-reattach: switching away hides a session's tab while the conversation KEEPS RUNNING — busy ones too — and switching back reattaches it instantly, live state intact. Requires tmux on PATH; without it (and always on Windows) Flock falls back to close-and-resume. Sessions started outside Flock are never wrapped either way. Values: `auto` — Use tmux when installed; `off` — Never use tmux. |
| `lineage.exitToShell` | `true` | When you `/exit` a session Flock launched, leave a shell prompt in the tab instead of closing it — same tab, same directory — so you can start straight back up with `claude --resume`. Exiting that shell closes the tab as usual. Requires `lineage.tmux` and tmux on PATH: a bare session IS its terminal process, so there is nothing left to put a shell into. The setting is written into Flock's tmux conf, which tmux reads when its server starts, so a change applies to sessions started after every current one has ended. |
| `lineage.terminalLocation` | `"editor"` | Where a Claude session's terminal opens. Values: `editor` — Editor tab; `panel` — Terminal panel; `newWindow` — Own window. |
| `lineage.soloSession` | `false` | Keep at most **one** Claude session tab open in this window. Opening or focusing a session parks every other session tab: a tmux-wrapped one is DETACHED (the tab vanishes, the conversation keeps running, hidden), a bare one is closed and comes back with `--resume` when you click its row — a busy or waiting bare session is spared and keeps its tab. The open session's tab is pinned, so it sits at the left of its group and survives *Close Others*. Workspace switches restore only the session you were last using instead of the whole set. Off by default: this parks tabs you laid out yourself, which is a strong opinion — turn it on if many open sessions are eating memory or making switches slow. |
| `lineage.launch.mode` | `"flock"` | Who opens a conversation. `flock` opens it here, in a terminal Flock owns. `claudeExtension` hands it to the official Claude Code extension: a **new** conversation runs its **New Conversation** command (opening in your `claudeCode.preferredLocation` — sidebar or editor) and is adopted onto a tree row once `claude agents --json` reports it; clicking a closed row **reopens the conversation in the extension's UI** instead of a terminal, and clicking a live one it hosts reveals or offers to open its panel. In `claudeExtension` mode Flock does not own the process, so these stop working for sessions started that way: **tmux parking** (a workspace switch closes the session instead of hiding it), **Close** and **Close with Summary**, **account pinning** (the launch runs under the extension's own login), the **wrap prompt**, and **Flock-named tabs**. Per-account **routing** is honoured by falling back instead: a conversation routed to another provider's CLI, or to a Claude account with its own config directory, opens in Flock's own terminal — the extension, on the machine's default login, could not host it — and the status bar says so. The tree row, the fork edge, the age, the status dot, the bell, project membership, branch colours, **Fork** and **Copy Session ID** all keep working. **Fork is never delegated.** `--fork-session` is a launch-time CLI flag no command the extension contributes carries, so a fork always opens Flock's own terminal — which is also the only way it can inherit the parent's history. A conversation **pinned to an account** with its own config directory also keeps Flock's terminal on resume: the extension runs on the machine's own login and would not find that transcript. Picking an account by hand (**New Session From…**) overrides the mode the same way. Values: `flock` — Flock's own terminal; `claudeExtension` — Claude Code extension. |
| `lineage.sessionSwitching` | `"flock"` | Advanced — Where you switch between conversations. `flock` makes the tree the switcher. The row of whatever conversation is in front stays **selected**, so the sidebar always already says where you are — and `alt+left`, while the Claude Code extension has focus, puts the **keyboard** on that row, so the up and down arrows move you between sessions from there. That binding exists because of the back arrow at the top of the Claude Code extension's panel, which leaves your conversation for an agent list that knows nothing about forks, projects or worktrees, and is very easy to hit by accident. **Flock cannot intercept that arrow**: it is a route change inside another extension's webview and produces no tab, title, command or context key on the outside. What it can do is make sure the tree never lost your place, and give the same gesture somewhere better to go. `claude` turns both halves off and leaves the agent list alone. Values: `flock` — Flock's tree; `claude` — Claude Code's agent list. |

### Attention

| Setting | Default | What it does |
| --- | --- | --- |
| `lineage.notifications.enabled` | `true` | Track finished sessions: a session that completes a turn while you are elsewhere gets a green dot (also on its project row) until you look at it, and appears under the bell in the sidebar title. Turn off to go back to the plain waiting-only dot. Per-session override: right-click a session → Mute / Unmute Notifications. |
| `lineage.notifications.popup` | `false` | Also show a toast with a Focus button when a session finishes a turn while you are not looking at it. Off by default — with many parallel sessions the bell and the dots carry the same information without the interruptions. |
| `lineage.showTokens` | `false` | Show how many tokens a session is carrying, left of the time-since-active. The number is the context the last assistant turn ran with (prompt + cache + output), read from the transcript — so it matches what `/context` reports and grows as the conversation does. Off by default: it is a second number on every row. |
| `lineage.runningBadge` | `false` | Advanced — Show the number of **running** sessions as a badge on the Flock icon in the activity bar. Off by default. The count is real and worth being able to see — "no running process without a visible row" is only an invariant you can trust if the processes are counted somewhere — but it changes every few seconds, and a number moving in the corner of your eye with nothing to do about it is not the same as information. The tree already says everything it does, in rows you can click. |

### Forking and closing

| Setting | Default | What it does |
| --- | --- | --- |
| `lineage.fork.notifyParent` | `false` | After a fork, type **one sentence into the parent conversation** saying that a branch was made, what it is called and — when you gave the fork an opening prompt — what it is for. **This is new, not something being switched on.** Flock has no session-to-session messaging and never has had: the in-session verbs channel runs one way, session → Flock, and the only text that has ever gone the other way is a fork's opening prompt, delivered once when the branch starts. This note rides the one channel that can reach a conversation already running — the same one the **Wrap Up Session** prompt uses — which **types into the terminal**. It costs the parent a real turn, and if you have half a message typed in that input box the note is appended to it and sent with it. **It only works while the parent's tab is open in this window.** A parent that is closed, hosted by another VS Code window, running outside Flock, or parked detached by a workspace switch cannot be typed into, and in all four cases **nothing is queued and nothing is retried** — the note simply does not happen, with one line in the **Flock** output channel. Those are the ordinary cases, not the exotic ones. The tree already shows you the fork either way. Not sent when **Claude itself** asked for the fork ("fork this session", the in-session verb): the verbs CLI already reports the new branches into that same turn, and a second copy typed into the terminal would both duplicate it and land keystrokes mid-turn. A branch renamed on its row in the inline sidebar is announced under its **generated** name — the note goes out while the rename editor is still open. |
| `lineage.close.summaryMode` | `"compact-and-tell-parent"` | What **Close with Summary** does. **How the summary is produced, precisely.** Flock cannot ask a model for a summary: it has no API client, and it can only speak to a running conversation by typing into its terminal. So the two compacting modes **send `/compact`** — a command the Claude CLI interprets — and then **read back the summary the CLI wrote** into the transcript. The words are genuinely the model's; the driving is a keystroke. It is not a scrape of the last exchange, and it is not something Flock wrote. **What that costs.** A compaction takes roughly **one to three minutes**, during which a progress notification with a **Cancel** button is shown. It **squashes the branch's own context** — acceptable only because the branch is being closed in the same breath, so if you cancel or it times out, you are left with a compacted branch. It is **Claude only**: a Codex session is offered the plain close by name instead. It needs the session's **tab open in this window**; a closed row, a session another window hosts, a foreign process and a session parked by a workspace switch are all refused **before** anything is typed. And if no summary comes back, **nothing is closed** — the session is mid-turn and cutting it off would lose the compaction too. `compact-and-tell-parent` (the default) also types a short form of the summary into the **parent** conversation, over the same channel and with the same limits as `lineage.fork.notifyParent`: only while the parent's tab is open here, nothing queued otherwise. `ask-me` is the behaviour this replaced, kept by name so it can be chosen deliberately. It is also what every refusal above falls back to when you pick **Type a Summary…**. Values: `compact-and-tell-parent` — Compact and tell the parent; `compact-only` — Compact only; `ask-me` — Ask me to type it; `off` — No summary. |

### Worktrees and branches

| Setting | Default | What it does |
| --- | --- | --- |
| `lineage.git.newSessionInWorktree` | `true` | The **`+` on a project row** cuts a **new worktree** first and starts the session there — one root session, one checkout, which is what keeps two sessions from ever switching branch under each other. The branch is minted from the session's name (`flock 3` → `flock-3`, with `lineage.git.branchPrefix` in front when set) and recorded as Flock's own, which is what later earns it the delete offer in **Remove Worktree**. No dialog: `git worktree add -b` creates a directory and a fresh ref and touches nothing that exists — the status-bar receipt names both, and a project without a readable repository falls back to a plain session in the directory. Turn it **off** to make `+` start sessions in the project directory as before; **New Worktree…** stays on the right-click either way, and `lineage.git.worktreePath` decides where the checkout goes. Does not need `lineage.git.branches` on. |
| `lineage.git.branchPrefix` | `""` | What minted branch names start with — `axel/` puts every branch the `+` creates under your own namespace, the Claude Squad convention (`axel/flock-3`). Applies only where Flock names a branch itself; names typed into **New Worktree…** are yours and get no prefix. Slashes make hierarchy; anything a ref cannot carry is replaced by `-`. Blank (the default) contributes nothing. |
| `lineage.git.branches` | `false` | Show a project’s **git branches** as rows, with the worktree verbs (*New Worktree*, *Remove Worktree*), the per-branch colours and the pull-request chip. Off by default. The feature works, but it is a lot of rows in a sidebar that has to stay readable — turn it on if you run one agent per worktree. This does not change which project a session belongs to: a session in a linked checkout stays under the project that owns the repository either way. |
| `lineage.git.branchDisplay` | `"inline"` | **How a session says which worktree it is running in.** Two ways of answering one question, both complete — the branch rows, the worktree verbs and the pull-request lookup are the same either way. Needs `lineage.git.branches` on; with that off there is nothing to display. **`inline` is the default.** The branch is written under the session, the way a git prompt or the SCM view says it — `⎇ feat/search-ranking ↑4 *` — and the name keeps the theme's own colour. It answers *which* checkout, and carries the state tokens where they can be read without hovering. It costs **height**: twelve sessions become twenty-four rows' worth. Because nothing needs decoding, the branch rows are **shut by default** here and reached from a project's right-click — see **Show Branches**. `color` is what Flock shipped, and it is denser. The session's name is tinted from a per-branch palette (`lineage.branchColors`) and the project's branch rows are the legend, so they are **open by default**. It costs no width at all and answers *are these two on the same thing* down a whole column at a glance. What it cannot say is *which* thing, and everything a colour cannot carry — `↑4 ↓3 *`, the request — moves into the hover. A line is drawn only where it says something new: on a session whose worktree differs from the one above it, in a project with more than one checkout. A fork made in its parent's worktree gets none. See `lineage.git.sessionBranchDetail` for how much it says. Values: `inline` — Branch under the session; `color` — Colour by branch. |
| `lineage.git.pullRequests` | `false` | **The one thing in Flock that reaches the network.** With this on, Flock runs `gh pr list --state all --limit 100 --json ...` in each project's repository and shows the pull request on each branch row — number, state and check rollup as a small chip, with **Open Pull Request in Browser** on the row's menu. It shells out to the [`gh` CLI](https://cli.github.com) you installed and authenticated: Flock makes no HTTP requests of its own, bundles no API client and never sees a token. Polled only while the Sessions view is visible, at most once every five minutes per repository, and cached. If `gh` is missing, not signed in, or the repository has no GitHub remote, the rows render exactly as they do with this off and one line goes to the **Flock** output channel. Off by default, because everything else in Flock is local. |
| `lineage.git.worktreePath` | `"../${repo}-${branch}"` | Advanced — Where **New Worktree…** puts a new checkout. `${repo}` is the repository directory's name and `${branch}` the branch name with anything a path cannot carry replaced by `-`. A relative pattern is resolved against the repository's main worktree, so the default puts `feat/x` of `~/code/app` at `~/code/app-feat-x`. An absolute path is used as written, and a leading `~/` expands. Must contain `${branch}`, or every branch would resolve to the same directory. Flock always shows the exact `git worktree add` command before running it. |
| `lineage.git.sessionBranchDetail` | `"standard"` | Advanced — How much the line under a session says, in `inline` mode — see `lineage.git.branchDisplay`. Colour mode has no line, so this does nothing there. `standard` is the vocabulary git prompts and the SCM view already use — `↑4 ↓3 *` and nothing else — so it reads without anybody learning it, and it touches nothing but local files. `detailed` adds the **pull request** — the number, one glyph for its checks, and its state in the chip's colour — and nothing else. It needs `lineage.git.pullRequests` on as well, since that is what fills the cache it reads. The arrows are the same arrows at either level: a branch that tracks nothing gets no word for it, because never-pushed is where every branch starts, and the row's hover says `no upstream branch` for the case where you want it in letters. Values: `standard` — Branch and local state; `detailed` — Also the pull request. |
| `lineage.groupSessionsByBranch` | `false` | Advanced — Nest a project's sessions under the git branch they are running on, instead of listing the branches and then the sessions. Each branch row becomes a container you can fold shut, with a `+` that starts a session in that worktree. Only applies to a project with two or more worktrees; a session that no shown branch accounts for stays directly under the project. Off by default. |
| `lineage.branchColors` | `[]` | Advanced — Read only by `lineage.git.branchDisplay`'s `color` mode; `inline` tints nothing. Colours for the branch chips, in order — index 0 is the first branch under a project (usually `main`). Each entry is either a hex colour (`#7aa2f7`) or a VS Code theme colour id (`charts.blue`, `terminal.ansiCyan`). A short list fills the rest from the built-in muted palette; anything that is not one of those two shapes is ignored. Empty = the built-in palette, which is the **Source Control Graph's own branch colours** (`scmGraph.foreground1`–5), softened toward the editor foreground so the chips do not out-shout the status dots — so a branch reads as the same colour here and in the SCM view, and a theme that restyles the graph restyles these too. |
| `lineage.preview.directoryModel` | `false` | Advanced — PREVIEW. Hang the branch rows off a **directory** instead of off the project, and list **every local branch** of that directory’s repository rather than only the checked-out ones. A project’s directories are its subprojects, and a directory is exactly one git repository (or none) — so the directory is the row a branch belongs under. A project spanning three repositories no longer shows three branches called `main` with no way to tell which is which. Outside the fold: the directory’s **own checkout**, and any branch with a **session running on it**. Everything else — including a worktree with nothing running in it — goes in one **Branches (N)** row, newest commit first, **shut by default**. That is what makes listing a 180-branch repository cost one row. Needs `lineage.git.branches`. Draws in the inline sidebar (`lineage.viewStyle`: `inline`, the default); the native tree keeps the rows it has today. |

### Accounts and sections

| Setting | Default | What it does |
| --- | --- | --- |
| `lineage.accounts.section` | `true` | Draw **Accounts** as a second section of the Flock sidebar, where each AI subscription you can launch sessions on gets a row: which plan it is, how much of its five-hour and weekly windows is gone, and which one new sessions use by default. On by default: the accounts are worth a row of their own. The only reason to turn it off is the top bar. VS Code merges a view's buttons into the container header — the row that reads **FLOCK** — only while that container shows exactly one section, so while Accounts is drawn the bell, New Project, `+`, fork and the gear sit on the **SESSIONS** row just below it instead. Off moves them up one row, and costs you the Accounts section. Nothing about accounts stops working while it is off. Usage is still read, new sessions are still routed, a session is still pinned to its account for life, and every account verb — **Add Account…**, **Sign In**, **Set Default Account**, **Set Project Account…** — is in the Command Palette under **Flock**. The switch is also in the gear menu at the top of the sidebar. |
| `lineage.shells.section` | `true` | Draw **Shells** as a section of the Flock sidebar: one row per command your sessions actually run — every `Bash` call Claude makes, with the ones executing right now pinned to the top and a live clock on each. Failed runs show their exit code, refused ones say they never ran, and a backgrounded job stays on the list until it finishes, with **Open Output** on its menu for the file the CLI is writing its stdout to. It ships collapsed, and the section's badge counts what is running — so a script that is still going is visible without opening it. **Every live session on this machine**, not only this window's: the facts come from the transcripts on disk, so a command running in a session another window launched is a row here like any other. Clicking a row focuses the conversation that started it. Like **Accounts**, drawing a second section moves Flock's top-bar buttons down onto the **SESSIONS** row; see `lineage.accounts.section`. The switch is also in the gear menu at the top of the sidebar. |
| `lineage.accounts.offerSwitchAtLimit` | `false` | Offer to **move a running conversation to another account** when the account it is on uses up its five-hour window. Flock already reads every account's meters, so it knows the moment one fills — and that is the moment somebody with a second subscription wants the conversation they were in the middle of moved. When this is on, a session hosted by this window whose account has just run out gets one notification naming the account with the most room, and a button that starts the ordinary **Move to Account...** flow with that account already chosen. The confirmation still appears: what the move costs — Claude Code restarts, the turn in flight is cut off, and the prompt cache does not follow — is the same however the flow was reached. **Off by default.** The offer proposes an interruption, so it is only welcome to somebody who decided in advance that they would rather be asked. With it off nothing is lost: the verb is in every session row's context menu whenever you have two accounts a session could run on, and in the Command Palette under **Flock**. One offer per five-hour window, per session, so a meter that re-reads on a timer cannot turn into a repeating prompt. The window resetting starts a fresh one. |

### Window

| Setting | Default | What it does |
| --- | --- | --- |
| `lineage.mode` | `"folder"` | What a window **is** — three answers, from the window that holds one thing to the window that follows you. **One folder per project** (`folder`, the default): the window is the folder you opened, the tree scopes itself to sessions under it, and working on another project means going to that project's own window. **Root**, i.e. Flock only (`root`): the window is Flock's — nothing fenced, nothing scoped, nothing rearranging itself, and you open a window on a session when you want its files. **Auto-switch** (`project`): one window spans many projects and switches between them as your attention moves. Navigation never changes a session's lifecycle in any of the three: a closed tab keeps its row under a detach grace (the hover says how long is left), then archives to a click-to-resume row. Run **Flock: Choose Window Model…** to pick one with what it costs written beside it — the picker is also the only thing that clears the deprecated `lineage.workspaces.enabled` below. Values: `folder` — One folder per project; `root` — Root (Flock only); `project` — Auto-switch. |
| `lineage.workspaces.enabled` (deprecated) | `true` | Show the workspace switcher in the status bar. A workspace scopes this window to one project: switching saves the current tab layout under the project you leave, hides what does not belong to the target, and restores the target's saved layout. Foreign session tabs close under a detach grace: with tmux installed (see `lineage.tmux`) the conversation keeps running detached for `lineage.session.detachGraceMinutes` — its row stays in the tree, its hover says how long is left, click to reattach — and archives to a click-to-resume row after that; without tmux the terminal closes and the conversation resumes from its transcript, in which case busy sessions are never closed. Unsaved editors and terminals Flock does not own are never touched. The terminal panel is never used. Deprecated: Superseded by `lineage.mode`, and still honoured: while this is `false` and the mode is `project`, this window resolves to the **Root** (Flock only) model — which is what that pair has always actually meant. Set `lineage.mode` to the model you want, or run **Flock: Choose Window Model…**, which writes both; then this key can go. |
| `lineage.workspaces.resumeSessions` | `true` | Advanced — When switching to a project workspace, resume its parked sessions from their transcripts (up to 8 per switch). Parking closes a session's terminal when you switch away, so with this OFF nothing is parked at all — foreign session tabs stay open instead. |
| `lineage.explorer.followProject` | `true` | Advanced — The Explorer follows the session you are working in: the file tree roots itself at that session's subproject directory, inside the git worktree the session is actually checked out in. Auto-switch only — the other two window models never move the tree. Requires running "Flock: Follow the Session I Am In" once per window, which converts it to a Flock workspace (one reload, then following is instant and no terminal is lost). Turning it off leaves you in the auto-switch model with the file tree where you put it: tabs still switch, the status-bar line still says where you are, and Source Control still follows the session's checkout — none of which reroots a tree you asked to be left alone. |
| `lineage.explorer.scope` | `"directory"` | Advanced — How much of the active project the Explorer shows. `directory` keeps the file tree to the one directory you are in, the way a plain folder window does; `project` shows every connected directory as its own root. Only applies when `lineage.explorer.followProject` is on, and only in the **Auto-switch** window model (`lineage.mode`). Following the session is a `directory` behaviour by construction — under `project` the folder tree stops moving on its own and only a switch reshapes it, while Source Control goes on following the session's checkout either way. Takes effect on the next focus change — no reload. Values: `directory` — The directory you are in; `project` — Every project directory. |

### What the tree shows

| Setting | Default | What it does |
| --- | --- | --- |
| `lineage.showForeignSessions` | `false` | Show live sessions Flock does not own — `claude` running in some other terminal, another editor, a script. Off (the default), the tree holds only what you told Flock about: sessions launched here, bound to one of its terminals, or added with **Add Existing Session…** / **Import Previous Sessions…** — and a session with no row can never light the bell or write itself into your tree. Turn it on to watch everything on the machine, the way Flock used to; finished turns then stamp those sessions into the tree as they always did. |
| `lineage.unclaimedSessions` | `"grouped"` | What to do with sessions **no project claims**. `grouped` (the default) files them under a row for their working directory; `flat` lists them one by one beside the project rows; `hidden` shows only sessions that belong to one of your projects — the roster is machine-wide, so this is the fastest way to stop seeing every directory anyone ever ran claude in. `hidden` is ignored while you have no projects, or the tree would be empty, and it never hides a running session: that files into the collapsed **Still running** group instead, because a view preference must not hide a process this window owns. Replaces `lineage.groupByFolder` and `lineage.onlyProjectSessions`, which are still honoured when they are all you have set. Values: `grouped` — Grouped by folder; `flat` — Flat; `hidden` — Hidden. |
| `lineage.onlyActiveSessions` | `false` | Show only sessions that are still running. Closed, exited and inferred-ancestor rows are filtered out of the tree — nothing is archived or removed, and a live session forked from a closed one keeps its place. This is the "Show Only Active Sessions" toggle in the view title. |
| `lineage.showArchived` | `false` | Advanced — Show ALL closed sessions found in ~/.claude/projects, even ones this tree never knew. Off by default: your own sessions already stay in the tree after their tab closes (as dimmed, resumable inactive rows, until you archive them) — this switch only adds foreign history on top. This is NOT the archive: sessions you archived are behind "Archived Sessions..." on the project's row. |
| `lineage.showPhantomRows` | `false` | Advanced — Show roster rows that are not sessions: entries whose process has exited but that `claude agents --json` never reaped, and `claude bg-spare` daemon warm-spares (pre-forked processes waiting to be claimed, which report an inherited name and a frozen status). Off by default — these cannot be focused, forked or resumed, and a stuck spare will pin the attention badge on the view indefinitely. Turn on to debug the roster. |
| `lineage.viewStyle` | `"inline"` | Advanced — How the Sessions view is drawn. `inline` renames on the row like the Explorer; `native` uses the built-in tree widget. Takes effect on the next window reload. Values: `inline` — Inline (rename on the row); `native` — Native tree. |

### Housekeeping

| Setting | Default | What it does |
| --- | --- | --- |
| `lineage.session.closeAfterMinutes` | `4320` | A session's tab closes on its own after this many minutes without use — **4320 is three days**. *Use* is the newer of two things: the last real turn in the transcript (never file timestamps), and the last time **you clicked on the session** — its row, its tab, its terminal. Clicking is the plainer signal of the two, and it is the one the age shown on the row does not report: that age is still "when this last got an answer", which is the question you are asking when you read the tree, not the question that decides what closes. The conversation is kept — its row stays in the tree as an archived session, and one click resumes it — so this tidies the process, never the words. A busy or waiting session is marked *close after this turn* instead and closes once idle; the tab you are looking at and any session pinned with **Keep Awake** are never touched. `0` turns it off. |
| `lineage.chat.autoCloseMinutes` | `1440` | Advanced — A project chat's tab closes on its own after this many minutes without use — **1440 is one day**. *Use* means either half of it: the chat said something, or you clicked on it. The conversation is kept — **Chat History…** on the project's row reopens it — so this tidies the tab, never the words. A chat that is busy or waiting is never touched, and neither is the tab you are looking at. `0` turns it off. |
| `lineage.session.detachGraceMinutes` | `10` | Advanced — When a workspace switch (or solo mode) closes a tmux-wrapped session's tab, the process keeps running detached for this many minutes so switching back reattaches instantly. Its row stays in the tree and its hover says how long is left. At the deadline an idle session is closed to an archived row; a busy one closes after its turn ends. At most 8 sessions run detached at once; overflow closes the oldest idle one first. `0` disables the grace — the tab still closes instantly, and the process is ended by the next sweep within a minute. |
| `lineage.session.reloadGraceSeconds` | `45` | Advanced — How many seconds a session may keep running after the window that owned it closed. This is a measurement, not a reprieve: VS Code reports a window **reload** and a window **close** identically, so the only way to tell them apart is to wait — a reload comes back and reattaches, a close never does. At the deadline the session settles to an archived row you can resume, because a folder no window has open should have nothing running in it. Keep this low; raise it only if reloads on this machine are slow enough to lose sessions. `0` ends sessions the moment the window goes, which also means every reload loses them. |
| `lineage.busyStaleMinutes` | `5` | Advanced — How long a session may keep the CLI's "busy" status with an untouched transcript before Flock stops drawing the running (amber) dot and shows it as idle. `claude agents --json` sometimes freezes a session's status at `busy` after its turn actually ended (most often an interactive session you finished with); a genuinely working session writes its transcript within seconds, so silence this long means it is done. Raise it if a long single tool call briefly flips to idle; turn on "Show Phantom Rows" to see the raw, uncorrected status. |

### CLI

| Setting | Default | What it does |
| --- | --- | --- |
| `lineage.claudeBinary` | `""` | Advanced — Full path to the claude CLI. Empty = search PATH. |
| `lineage.codexBinary` | `""` | Advanced — Full path to the codex CLI, used by sessions on a Codex / OpenAI account. Empty = search PATH, then the usual install roots (~/.codex/bin, the active nvm node version, ~/.local/bin, Homebrew). Worth setting explicitly if you use a node version manager, since VS Code often does not inherit its PATH. |

### Hooks and verbs

| Setting | Default | What it does |
| --- | --- | --- |
| `lineage.hooks.enabled` | `false` | Read the Claude Code hook event stream for instant updates. "Install Instant-Update Hooks…" sets this for you — installing the plugin only makes Claude write the events, this is the switch that makes Flock read them. The plugin lives in a skills directory and never edits ~/.claude/settings.json. |
| `lineage.verbs.enabled` | `false` | Read fork requests written by Claude sessions, so "fork this session" typed to Claude runs the same fork the sidebar button runs. "Install In-Session Verbs…" sets this for you — installing the skill only lets Claude write a request into ~/.lineage/requests, this is the switch that makes Flock windows act on one. Nothing leaves your machine. |

<!-- generated:settings:end -->

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
could name — and `lineage.workspaces.autoSwitch: false` spelled the same
corner a second way, as auto-switch with the auto taken out. The model is now
a value, and both old keys fold into it once, on read. **Nothing on your machine
was rewritten** — the fold is a rule, not an edit, and Flock does not write to
a `settings.json` you did not ask it to write to. `lineage.workspaces.enabled`
is still listed, struck through, so the editor can point at its replacement;
`lineage.workspaces.autoSwitch` is no longer listed at all, and is honoured
just the same.

| `lineage.mode` | `lineage.workspaces.enabled` | `lineage.workspaces.autoSwitch` | you are now in |
|---|---|---|---|
| unset | anything | anything | **One folder per project** |
| `"folder"` | anything | anything | **One folder per project** |
| `"project"` | unset or `true` | unset or `true` | **Auto-switch** |
| `"project"` | `false` | anything | **Root (Flock only)** |
| `"project"` | anything | `false` | **Root (Flock only)** |
| `"root"` | anything | anything | **Root (Flock only)** |
| anything else | anything | anything | **One folder per project** |

The rows worth pausing on are the two `"project"` rows that end in **Root**.
`("project", enabled: false)` *already* gave a window with no auto-switch, no
status-bar button and no fence — Flock only in everything but name — so calling
it that moves nobody. `("project", autoSwitch: false)` gave the same window plus
a status-bar item, which is the one thing the Root model is defined by not
having: the `$(layers)` item, like the button in the Explorer's **Project** view
title, belongs to Auto-switch now, since in the Flock-only model it would have
been a second, quieter copy of the switch that model never fires for you. The
verb itself is still on the project row, in the palette, and on any keybinding
you gave it.

If you want the auto-switching window, set `lineage.mode` to `project` **and**
delete both old keys — or just run **Flock: Choose Window Model…**, which does
all three for you: it writes the mode, writes `lineage.workspaces.enabled` back
to `true`, and removes `lineage.workspaces.autoSwitch`. That picker is the only
thing in Flock that ever touches either key, and it does so because you asked.
