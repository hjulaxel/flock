# Changelog

All notable changes to Flock are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] — 2026-08-06

### Upgrading from 0.1.1

Nothing you have is lost, and there is nothing to run. Four things move on their
own, and this is the list of them.

- **Branch rows are off.** 0.1.1 drew a row per checkout whenever a project had
  more than one; they are now behind `lineage.git.branches`, which is **off**.
  If you run one agent per worktree and want them back, turn it on — the rows,
  the colours, the worktree verbs and the fold all return. **No session moves
  either way:** worktree membership is not part of the switch, so an agent in a
  linked checkout stays filed under the project that owns the repository whether
  the rows are drawn or not.

- **The Explorer shows one directory instead of every directory.** A project
  with three connected directories used to put three roots in the file tree; it
  now roots on the one you are working in and follows your attention.
  `lineage.explorer.scope: "project"` is the old shape, exactly.

- **Projects nested inside projects are folded, once, on first launch.** Each
  child's directories join its top-level ancestor, and the child record becomes
  a tombstone. Your sessions come back under the same directory's row, because
  membership has always been derived from the working directory. What does not
  survive is what a subproject only had because it was a whole project: its
  name, its provider, its account override and whether it was closed — so a
  closed subproject's directory rejoins an open parent and its sessions come
  back into the tree. The **Flock** output channel names every one it folded.

- **Two commands are gone**, with the model they served: **Move Project…** and
  **Add Directory to Project…**. Adding a directory is **Add Subproject** now.

Upgrading is safe with windows open. VS Code swaps the extension on disk while
older windows keep running, so for a while two builds share one `state.json`:
the older one stamps the schema version back down and this build migrates it
again on the next read. Every step is idempotent for that reason, and an older
build preserves keys it does not recognise rather than dropping them.

### Added

- **Flock works with the Claude you already run.** The session list has always
  been machine-wide, so `claude` typed into the bottom panel — or a conversation
  the official Claude Code extension started — was already in the tree with its
  age, its dot and its place in the fork tree. What was missing was honesty about
  the rest: the row looked like any other and offered verbs that could not
  possibly work on it.

  A row Flock does not own now says **elsewhere** after its age, explains itself
  in the hover, and no longer offers **Close** or **Close with Summary** —
  closing a session Flock cannot signal only ever wrote a timestamp onto a
  conversation that carried on running. **Wrap up** now names the host instead of
  reporting a missing terminal.

- **Clicking such a row reveals the terminal it is already in.** Flock
  identifies it from the process tree, not from the tab's title (Claude rewrites
  that while it runs) and not from the working directory (a shell that has `cd`'d
  is the normal case). Revealing is the only thing done to a terminal Flock does
  not own: nothing is typed, nothing is signalled, no transcript is touched. When
  the evidence is ambiguous — two conversations under one shell after a `/fork`,
  a terminal inside a terminal — it declines and you get the old offer to fork a
  copy instead. Two Claudes on one transcript is the outcome the whole feature is
  arranged to avoid.

- **`lineage.launch.mode`.** Set it to `claudeExtension` and Flock's `+` hands new
  conversations to the official extension's **New Conversation** command, then
  files the session onto a tree row under the project and name your click
  implied. The setting's description lists exactly what stops working in that
  mode; the [reference](docs/reference.md#using-flock-alongside-the-claude-code-extension)
  has the full per-setup table. Only offered while that extension is installed.

- **A new section in the reference**, "Using Flock alongside the Claude Code
  extension", saying per setup — Flock-launched, official extension, hand-run
  terminal — which benefits you get and which you do not, and where the limit of
  what Flock can promise actually sits.

- **A fork button on the top bar, and it knows which conversation you mean.** The
  sidebar could fork from a row and from the palette's picker, and from nowhere
  else. Forking is one of the two things the top bar is for, so it has a button —
  and because a fork button that opens a list of every session on the machine is
  not one, it resolves its own target: the session whose terminal is active in
  this window, else the live session you prompted most recently, else the only
  live one there is. Anything less clear than that asks, with the same list **Fork
  Session** always used. It is also the first fork this extension has had that you
  can reach from the keyboard.

- **A gear instead of the three dots**, holding what the overflow `...` used to:
  the filter, the housekeeping verbs, **New Project…**, the closed-projects list,
  the hooks pair and the Accounts switch. Each toggle is labelled with the
  direction it goes — *Hide Accounts Section* while the section is showing, never
  both at once — which a contributed menu cannot do, so the menu is built when it
  opens.

  The row is five buttons for it: bell, New Project, `+`, fork, gear. A toolbar
  the workbench cannot fit collapses into an `...` and takes the last buttons with
  it, and the gear is last — a crowded row would have hidden the very menu that
  replaced the ellipsis. The **closed-sessions filter** and the closed-projects
  list are in the menu rather than on the row because they are the two you reach
  for least.

- **`lineage.accounts.section`** decides whether Accounts is drawn as a second
  section of the sidebar. It is **on**, which is where it was. The setting exists
  because VS Code merges a view's buttons into the container header — the row
  reading **FLOCK** — only while that container shows exactly one section: turn
  Accounts off and the five buttons move up onto that row. That trade is offered,
  not taken, and the switch is in the gear menu.

- **Branch rows say where each checkout stands.** `↑2 ↓1` against the upstream,
  and `*` when there is work in the worktree that no commit holds yet. From one
  cheap read — `git status --porcelain=v2 --branch`, once per worktree, cached for
  15 seconds — on the same discipline the worktree list already used: the read side
  is synchronous from cache, the refresh happens in the background, and nothing
  about it can make the sidebar wait. It runs with `GIT_OPTIONAL_LOCKS=0`, because
  `git status` otherwise rewrites the index to save the stat cache it refreshed,
  and a probe nobody asked for must not write to your repository. A clean,
  in-sync or not-yet-read checkout says nothing at all, so a single-checkout
  repository looks exactly as it did. The hover says it in words — "2 ahead, 1
  behind origin/feat/x", or "no upstream branch", which is a different thing from
  being up to date.

- **New Worktree…** picks one of the repository's local branches or takes a name
  that does not exist yet, creates the checkout, and starts a session in it. The
  path comes from `lineage.git.worktreePath`, which defaults to a sibling of the
  main worktree (`../<repo>-<branch>`); the exact `git worktree add` command,
  path and all, is in the confirmation. It is on a branch row, on a **project**
  row and in the command palette — a repository with one checkout has no branch
  rows, and that is precisely when you want this.

- **Remove Worktree**, with the refusals spelled out. Never the main worktree.
  A second confirmation before `--force`, which is what deletes uncommitted
  changes and untracked files — `git worktree remove` refuses those on its own, so
  the second dialog is about exactly that and says so. A warning when a running
  Flock session has its working directory in there. The branch itself always
  survives, so a worktree you remove can be added back.

- **Open Worktree in New Window**, plus **Reveal Worktree in Finder** and **Copy
  Worktree Path**, which existed on a row and are now in the command palette too.
  All of them fall back to a picker when they are invoked without a row.

- **Pull requests on branch rows** — number, state and check rollup as a small
  chip, with **Open Pull Request in Browser**, and **Create Pull Request…** which
  runs `gh pr create --web` and leaves the submitting to you. Behind
  `lineage.git.pullRequests`, **off by default**, because it is the one thing in
  Flock that reaches the network.

  It reaches it through the `gh` CLI you installed and authenticated, never as an
  HTTP request from the extension and never with a bundled API client: Flock does
  not see, store or refresh a token, and `gh` decides which host it talks to. It
  is polled only while the Sessions view is visible, at most once every five
  minutes per repository, anchored on the main worktree so a project with six
  checkouts makes one call rather than six. Missing `gh`, no `gh auth login`, no
  GitHub remote and a branch with no request all produce the same thing: the row
  as it looks with the setting off, one line in the **Flock** output channel, and
  no dialog.

- **Two subprojects can live in the same folder.** `~/magma-cs-mcp` is one
  directory, and "the server rewrite" and "the CS tooling" are two bodies of work in
  it. Until now a subproject *was* a directory, so that arrangement could not be
  expressed at all: one folder meant one row.

  A subproject is now a **lane** — a name and a directory — and several may name the
  same directory. **Add Subproject** asks which directory it works in (the
  project's own, or **Another directory…** for one it does not cover yet) and then
  asks for a name. **Rename Subproject** is new; **Remove Subproject** removes the
  *name*, leaving the directory, everything running in it, and every session's row
  exactly where they were.

  Projects that have never made a lane are **byte-identical**. A directory with no
  lane in it still draws the row it always drew, labelled by its basename, and a
  single-directory project still draws no rows at all — so nothing about an existing
  tree moves.

  **Which lane a session is in is the first thing Flock has ever stored about a
  session.** Everything else — its project, its directory, its branch — is derived
  from its working directory on every render, which is why renaming or re-pointing a
  project never rewrites session state. Two lanes in one folder have identical
  working directories, so there is nothing to derive from: the lane is stamped at
  launch from the `+` you clicked, and never re-decided. A fork carries its parent's
  lane, a `/clear` carries the conversation's, and a session Flock did not start
  carries nothing and lands in the first lane of the directory it runs in. A stamp
  naming a lane you later removed reads as no stamp at all.

  A lane is a record of its own rather than a list on the project, and that is
  load-bearing: `projects` merges newest-wins per record, so two windows each adding
  a lane a second apart would have lost one of them. One record per lane means one
  writer per lane. State schema **v7** — purely additive, no migration to run.

- **Branches belong to a directory now — behind `lineage.preview.directoryModel`.**
  A project's directories are its subprojects, and a directory is exactly one git
  repository or none. So the directory is the row a branch belongs *under*: a
  project spanning three repositories used to show three branches called `main`
  with nothing to say which was which, and now each one sits under the directory it
  came from. A project with a single directory keeps its branches on the project
  row, because that row *is* its directory.

  Once a branch row is anchored on a repository rather than on a union of them,
  listing the repository becomes affordable — so the block now shows **every local
  branch**, not only the checked-out ones. Outside the fold: the directory's **own
  checkout**, and any branch with a **session running on it**. Everything else goes
  into one **Branches (N)** row, newest commit first with each branch's age beside
  it, **shut by default**. That is the whole trick: a hundred and eighty branches
  cost one row until you ask for them.

  A worktree with nothing running in it is now *in* the fold. That is the
  deliberate change from the old policy, which promoted every checkout: a worktree
  you are not using this week is a directory on disk, not work in flight. **Hide
  Branch** and **Show Branches…** still override the policy both ways.

  A branch with no checkout has nowhere for a session to run, so it has no `+` and
  no session verbs — a hollow swatch, its age, and **New Worktree…** on the menu,
  which is the verb that gives it somewhere to live. Two or more promoted branches
  nest their sessions underneath them; one promoted branch draws its sessions
  directly under the directory, because nesting costs every row a level and one
  branch has nothing to tell apart.

  Needs `lineage.git.branches` as well, and draws in the **inline** sidebar (the
  default). With `lineage.viewStyle: native` the tree keeps the rows it has today —
  directories and their sessions, no branch block.

- **`lineage.preview.demoProject`** puts a fabricated project in the tree —
  *Flock (demo)*, with three directories, two repositories and a branch in every
  state a row can draw — for judging the layout without owning a repository shaped
  the right way. Nothing on it is real: no directory behind it exists, every verb
  refuses it, and it has **no sessions**, because a session row is drawn from the
  real roster and a made-up one would draw nothing at all. Turning the setting off
  removes it completely.

### Changed

- **`+` starts a session in the project you are working in.** It used to read the
  window's open folder and nothing else, so a window scoped to a Flock project
  **workspace** — the feature whose whole purpose is to say which project you are
  in — got a folder picker whenever the workspace was not also open on a folder;
  and a window open inside project A while scoped to project B silently started
  the session in A. It now takes the first of: the scoped workspace, the project
  owning the open folder, the project of the active session, that folder. Only a
  window that answers none of the four still asks. A session landing in a project
  is named after the project, the way the `+` on a project row already named it.

- **A project has no catch-all row.** Once it has two directories, every session it
  claims belongs to exactly one of them — the main directory is directory number
  one, not a bucket for the ones that fit nowhere else.

  It used to be a bucket, and the thing that landed in it was ordinary: a session
  in a linked git **worktree**. A project is given every checkout of every
  repository its directories sit in — that is why an agent in `app-feat-x` files
  under `app` without anybody registering the path — but the directory rows only
  compared the directories themselves, so every worktree session piled onto the
  main row.

  Now a directory claims a session the same way a project does: the directory plus
  the worktrees of the repository at it. And a worktree path is read as the **main
  checkout** would spell it, which is the spelling your directory list was written
  against — so a session in `~/app-feat/api` belongs to **api**, because that is
  what it is working on, rather than to whichever row happens to own the
  repository. The fallback is now unreachable through the product; it stays in the
  code as a bug-catcher, because a stale cache must never be a way to lose a
  running agent.

- **The documented promise now matches the code, exactly.** The README's Privacy
  section, `CONTRIBUTING.md`'s read-only bullet and `docs/reference.md` used to say
  "Flock makes no network requests" and "the only git call is `git worktree list
  --porcelain`". Both were true and neither is any more, so all three now list
  every process Flock starts, which of them write, and which one setting can make
  something leave your machine.

### Fixed

- **Clicking a session in another project now takes you to that session.** It
  switched to the right workspace and then landed you on one of that project's
  *other* tabs; clicking the same row a second time worked. Restoring a layout
  reveals a terminal per session it brings home, and revealing a terminal takes
  the front of its editor group whatever the "don't take focus" flag says — so
  the tab you ended on was whichever session came home last. A switch now decides
  where the keyboard goes, once, after everything has settled: the session that
  triggered it, else the tab the layout was left on. Layouts remember that tab
  even when it was a session, which they previously only did for files, so the
  status-bar switcher lands deliberately too.

  Two smaller things fell out of the same path. A session whose terminal is
  already open here is no longer relaunched by a restore — the click that
  triggers the switch resumes the session itself, and losing that race put a
  second client on one conversation and orphaned the first tab. And
  `docs/reference.md` described switching as it worked before tmux, moving
  terminals into the panel; it now describes parking.

- **The Explorer shows the directory you are in, not every directory the project
  has.** A project with three connected directories put three collapsible roots
  in the file tree, which is what a multi-root workspace is for — but it is not
  what working feels like. You are in one of them at a time, and the other two
  were a permanent invitation to lose your place.

  The tree is now rooted at a single directory, the way a plain folder window
  is, and which one follows your attention: focus a session and the Explorer
  re-roots to the directory that session runs in. No verb, no click. The
  **Project** view above the tree still lists every connected directory, marks
  the one being shown, and clicking another sends the tree there — which is how
  you reach a directory you have no session in yet.

  The old shape is `lineage.explorer.scope: "project"`. Both are the same
  in-place folder splice as before: no reload, and no session is lost either
  way.

- **Dragging a session no longer moves it in the tree.** A drag onto another
  session re-parented it and a drag onto a folder row detached it to a root, so
  one careless gesture could pull a fork out of the lineage it branched from, or
  file an unrelated conversation inside one. A tree whose whole claim is "this
  branched from that" cannot have edges in it that no transcript backs — and
  nothing on screen distinguished the edge you drew from the ones Claude
  recorded.

  Ancestry is now left entirely to what records it: the edge minted at fork time
  and inference from the transcripts. A drag says one thing — file this
  top-level session under that project — which is an address, derived from a
  directory, editable from the project's own verbs, and true or false
  independently of any transcript. Rows drawn inside a tree do not pick up at
  all, in either view style; the drop highlight appears only over a project (or
  one of its subproject rows), and a drop onto a session says why nothing moved.

  Existing hand-made edges in `state.json` are untouched and still resolve —
  nothing is rewritten, and no lineage you already have changes shape.

- **A project's right-click menu is seven things and a Settings entry.** It had
  fourteen: nine you reach for constantly and five you touch about once per project
  per year, in one flat list with no way to tell which was which.

  The row now holds **New Session**, **New Chat**, **Old Chats…** — **Add
  Subproject**, **Rename Project**, **Close Project**, **Delete Project** — and
  **Settings**. What moved into Settings is the half that describes what a project
  *is* rather than what you do to it: which directory is the main one, which one to
  remove, the provider, the AI account, **New Session From…**, **Switch
  Workspace…** and **Open in New Window**. Four of those are delegated to the
  commands that already own them, so each keeps its own picker, its own refusal and
  its own message rather than having a second copy of them.

- **A subproject is a directory now.** It was a whole project record filed under
  another project — with its own name to invent, its own provider, its own AI
  account, its own saved workspace layout and its own settings menu, all decided
  for something whose entire job was sorting rows. It was most of the reason the
  menu above had grown to fourteen entries.

  A project is scoped to **one** directory, which is every project anybody has
  made: no subproject rows, sessions directly underneath, byte-identical to the
  tree before this existed. **Add Subproject** opens a folder dialog inside the
  project and adds what you pick — and from the second directory on, each one gets
  a row of its own holding the sessions running in it. Escape adds nothing.

  Which row a session lands in is the same longest-match rule project membership
  has always used, so a session in `~/app/api/handlers` is under `api` and one in
  `~/app/lib` is under the main directory. A session no directory accounts for —
  one running in a linked git worktree, say — goes to the main directory rather
  than disappearing: adding a directory must never be a way to lose a row.

  There is nothing else to configure. The label is the directory's name (with its
  parent prepended when a monorepo makes two of them `src`), the verbs are **New
  Session** and **Remove Subproject**, and removing one removes a **row** — the
  directory stays on disk, nothing running in it stops, and its sessions go back to
  wherever they sat before the project covered it. The main directory is refused:
  that is the project's own address, and Delete Project is the verb for it.

  **Move Project…** and dragging a project row onto another project row are gone
  with the model they served. **Add Directory to Project…** is gone too — adding a
  directory *is* adding a subproject, and two menu entries doing one thing was the
  other half of the problem.

  **On first launch, every nested project you already have is folded into its
  top-level ancestor's directory list** and the child record is removed. Your
  sessions come back under the same directory's row, because membership was always
  derived from the cwd and nothing about them is touched. What does not survive is
  what only existed because a subproject was a whole project: its name, its
  provider, its account override and whether it was closed. The **Flock** output
  channel names each one it folded.

- **New Project is back on the top bar**, second from the left, and it is one
  folder dialog now. Picking a folder makes the project — the quick pick behind it
  ("Create Project" / "Add Another Directory…", looping until you committed) was a
  confirmation step whose only job was letting you add directories you had not
  asked for. The second directory is a thing you discover later, and by then it has
  its own verb on the project.

  The row stays at five buttons — bell, New Project, `+`, fork, gear — because the
  workbench collapses a toolbar it cannot fit into an `…` and the gear is last. The
  **closed-sessions filter** left the row to make room: it was already in the gear
  menu, labelled with the direction it goes, where New Project had no home but the
  menu.

- **The branch block is parked behind `lineage.git.branches`, which is off.** A row
  per checkout, the worktree verbs, the per-branch colours, the fold, the
  **Others (N)** picker and the pull-request chip: all of it, one setting, and no
  menu entry or palette verb for any of it while the setting is off.

  This is a decision about the sidebar, not about the code. A repository with six
  checkouts is six rows before the first session, and a sidebar is 250px wide.
  Nothing is unfinished and nothing is deleted — the rules are covered by the same
  tests they always were, `git worktree add` and `git worktree remove` still confirm
  and still quote the exact command, and turning the setting on brings all of it
  back including its menus.

  **Worktree membership is not part of the switch.** A session started in a linked
  checkout is still filed under the project that owns the repository, rows or no
  rows: turning a view option off must never move somebody's sessions.

- **A new subproject no longer swallows its parent's sessions.** The directory
  dialog opens inside the parent, so accepting it without navigating anywhere
  chose the parent's OWN directory — and since membership is containment, the new
  subproject then claimed everything the parent did. Two projects on one directory
  have no defined owner for the sessions in it at all: the tie breaks on project
  name, so the sessions go to whichever sorts first and the other row displays
  nothing while still claiming all of it.

  Creating a project on a directory another project already lists is now refused,
  by name, with the two ways forward — a subdirectory, or adding the directory to
  the project that has it. **Add Directory to Project…** refuses the same thing for
  the same reason. Dropping a session onto a project row is untouched: that one is
  a move, and it already takes the directory off its previous owner and says so.

  Nesting itself is unchanged, because the refusal is on the exact path only. A
  subproject on `app/api` still takes the sessions under `app/api` off `app` —
  that is the whole feature.

- **Resume no longer risks a second writer on a transcript Flock cannot see.** A
  row reads as closed whenever the roster does not carry it, which is also what a
  session running under a config directory no configured account names looks
  like. A transcript written to *after* the moment Flock recorded the session
  closed now asks before resuming, rather than starting a second Claude on it.
  The ordinary close-then-reopen is unaffected.

- **A session you created and never wrote in can be opened again.** Claude writes
  its transcript on the first turn, so a session started before you were pulled
  into something else had a row, a name, an id and a directory — and nothing on
  disk. Clicking it answered "No transcript on disk for this session — there is
  nothing to reopen", which left a row on screen that could not be opened by any
  verb in the product. The one thing a row must never do.

  It now opens by *starting*: same id (free, precisely because no transcript
  claims it), same directory, same name, same account. A **fork** that never took
  a turn comes back as the fork it was — replaying the ancestor whose history it
  was displaying — rather than as a blank conversation, so the branch is not
  spent on an empty session. Ghost rows are still refused: an inferred ancestor
  was never a session anybody here created, and starting one under its id would
  mint the history the tree is only guessing at.

  A workspace switch dropped the same sessions. It parked them on the way out and
  silently skipped them on the way back, leaving a record still flagged `parked`
  that the switch could never restore again; those now come home too.

- **An account whose access token aged out no longer reads as "sign-in
  expired".** OAuth access tokens last hours, and the CLI renews them from the
  refresh token beside them the next time it runs — so a lapsed expiry is the
  ordinary state of an account nobody has used since lunch, not a logout. Flock
  read the expiry, said the sign-in had expired, and sent people to `/login` to
  repair an account that was never broken. The same went for a 401 from the usage
  endpoint.

  Both now check whether a refresh token is on file. With one, the row says
  `usage n/a` — the meter is what is missing, and it comes back on the next look
  with no backoff to sit out, as soon as the CLI has refreshed. Without one the
  sign-in really is over, and the row says so exactly as before.

- **`src/tree.ts` was not a text file.** A template literal held a literal NUL
  byte where the six-character escape sequence for one was meant, which made
  `file(1)` classify the source as binary data — and BSD `grep` silently skips
  those. Every search over the repository had been quietly missing that file,
  including the ones you would run to work out why. The emitted string is unchanged
  (a NUL separator either way); only the source spelling is. `hasControlChar` in
  `src/commands.ts` exists so that the one place needing a control-character check
  does not reintroduce the escape.

### Known issues

- **Workspaces can claim each other's sessions, and this release does not fix it.**
  A switch decides which sessions belong to the project it is switching to by
  asking whether their directory sits inside one of the project's directories. The
  sidebar asks a different question — which project's directory is the *longest*
  match — and the two disagree whenever one project's directory contains another's,
  which nesting made routine.

  When they disagree, both projects' saved layouts can name the same session, so
  switching between them brings the same tabs back under either one. The fix is
  known (membership in a switch should be `matchProject`'s answer, the same one the
  tree renders) and deliberately not in this release. Until then: if your projects
  nest, leave workspace mode or turn `lineage.workspaces.enabled` off. It is called
  out in the README and beside the setting.

## [0.1.1] — unreleased

### Added

- **Flock now tells you that it needs tmux.** Without tmux, switching projects
  closes the other project's sessions instead of hiding them, and anything a
  session was in the middle of is lost. Nothing in the product said so, because
  nothing looks broken when it happens — parking still works, it just works the
  worse way. You now get one notice, which you can dismiss, when workspaces are
  on and tmux is missing. If you have tmux but switched it off by hand, it
  offers to turn it back on instead.

  It stays quiet where it would be noise: on Windows, which has no tmux tier at
  all; with workspaces off, which is the only feature tmux serves; and when tmux
  is both missing and switched off, because two things to fix in one notice is a
  worse message than none. It asks once per install, never on a timer.

### Changed

- **tmux is now listed as required, not optional.** The README and
  `docs/reference.md` say how to install it on each platform, what the two
  parking paths actually differ on, and why the private `tmux -L lineage` server
  cannot disturb your own tmux.

### Fixed

- Typos and broken markdown in the README, including an unclosed bold marker
  that swallowed a bullet's heading.

### Notes

- The three fixes previously listed here shipped in 0.1.0 and have been moved
  under it. They were written before that release and the heading was never
  updated.

## [0.1.0] — 2026-08-03

First public release.

### Fixed

- **Sessions running in the private tmux server are reachable again after the
  editor restarts.** A record only names the wrap a workspace switch PARKED it
  into, but the launch wraps every session it starts — so one that was
  launched, bound to a tab and never parked had a live wrap nothing recorded.
  Invisible while the tab existed, because the bound-tab tier answered first;
  the moment the window went away those rows fell all the way through to
  "running in another app or terminal", offering to fork a copy of a process
  sitting in Flock's own server. On a restart here that was 21 of 40 live
  wraps. The wrap name is derived from the session id, so the detach tier now
  derives and probes it when no name was recorded. The probe is ground truth,
  which keeps it safe next to a kill-tier park: that writes `tmux: null`
  deliberately, and a killed wrap does not answer. A recorded name still wins,
  because a re-key while parked leaves the wrap under the id it was launched
  with and only the record remembers which that was.
- **Forking a branch you have not typed in yet no longer refuses with "session
  has no transcript yet".** `--fork-session --resume` renders the inherited
  history the moment the terminal opens, but claude writes the transcript lazily,
  so a branch that has taken no turn shows a full conversation on screen and has
  no file under its own id. Fork and Fork and Compact now replay that branch's
  own parent instead — its history is the same bytes — while the new branch
  still lands **under the row you clicked**, and is named after it. Which
  transcript is replayed is forced by what exists on disk; where the branch
  hangs is not, and an unstarted branch is displaying its ancestor's history
  verbatim, so both candidate edges describe the same content and the tie breaks
  on what the click meant. Recorded edges only, so the substitution is never
  inferred; walks up a run of unstarted branches, bounded and cycle-guarded;
  still refuses a session with no transcript anywhere above it, which is the
  case the message was written for.
- **A fork no longer inherits its parent's last turn only up to the first tool
  call.** claude picks the message a `--resume` / `--fork-session` walks back
  from out of the transcript's `last-prompt` records; those are written mid-turn,
  next to `ai-title` / `mode` / `permission-mode`, and are not corrected when the
  turn ends. A parent whose final turn made a tool call therefore recorded a leaf
  pointing at the first tool result, and everything the assistant said after it
  was unreachable — the sibling-recovery pass pulled back the other blocks of
  that same message, so the loss read as "I only get the first part of the last
  message" rather than as a missing turn. Fork, resume and workspace restore now
  append a corrective `last-prompt` record naming the transcript's actual tip
  first. Append-only, skipped whenever it would not strictly increase what the
  launch sees, and never applied to a `/clear`-ed or actively-written transcript.
  Measured on the machine this was found on: 23 of 282 transcripts carried a
  stale leaf. Verified against claude 2.1.220 by forking an affected session and
  diffing the child transcript against its parent, before and after.


### Added

- **A tree of sessions**, with fork ancestry drawn rather than guessed.
  In-session `/fork`s — which write no transcript marker — are recovered from
  the CLI daemon's dispatch log and nested under their parent.
- **Attention routing.** Amber for working, red for finished-and-unseen,
  nothing for everything else. Rolls up to the project row and onto the view
  badge, and clears when you look.
- **A notification bell** listing recently finished sessions, with per-session
  mute and an optional toast.
- **Git worktree branches.** Every checkout of a project's repository files
  under that project wherever it lives on disk, as colour-coded branch rows.
  Click a branch to start a session in that worktree. Read-only: the only git
  command is `git worktree list --porcelain`.
- **Multiple accounts.** One row per subscription, each with its own config
  directory and its five-hour and weekly window usage. New sessions are routed
  automatically; a session is then pinned to its account for life.
- **Project workspaces** that scope a window to one project, saving and
  restoring tab layouts, with tmux-backed parking that keeps hidden sessions
  running.
- **Orchestration verbs**: new, fork, fork-and-compact, ask-in-a-fork, rename in
  place, close with a summary, delete with undo, and drag to re-parent.
- **Optional instant-update hooks**, installed as a self-contained plugin that
  never edits `~/.claude/settings.json`.

### Notes

- The project was named **Lineage** during development. Configuration keys,
  command ids and the workspace filename keep the `lineage.` prefix: renaming
  them would silently discard existing settings and break keybindings.
