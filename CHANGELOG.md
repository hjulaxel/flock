# Changelog

All notable changes to Flock are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`/exit` leaves you at a shell instead of closing the tab —
  `lineage.exitToShell`, on by default.** A session's tab holds exactly one
  process, so exiting used to take the tab with it. That is the wrong ending for
  the commonest reason to exit at all: you wanted to start again — a new MCP
  server to pick up, an edited setting, a fresh context — and instead of a prompt
  to type `claude --resume` at, the tab vanished and you had to go find the row
  again. Now the same tab holds a shell prompt, in the same directory, with the
  conversation still in the scrollback above it. Exiting *that* shell closes the
  tab exactly as `/exit` used to, so nothing becomes harder to get rid of.
  Requires tmux and is inert without it: a session on the fallback tier **is**
  its terminal process, so there is nothing left to put a shell into. The
  behaviour lives in Flock's generated tmux config, which tmux reads when its
  server starts — so a flip applies to sessions started after every current one
  has ended. Reported by [@sidhson](https://github.com/sidhson) in
  [#7](https://github.com/hjulaxel/flock/issues/7).

### Fixed

- **Resume no longer risks handing you a shell and calling it a conversation.**
  Groundwork for the above, and a correctness fix in its own right: the detach
  tier's "is this session still live" probe asked only whether a tmux session
  existed under the wrap's name, which a pane sitting at a shell prompt answers
  just as well as a running CLI. The probe now reads what is *in* the pane, so an
  exited wrap is treated as gone — **Resume** takes the ordinary `--resume` path
  with every guard on it, and a fresh launch ends a stale wrap rather than
  attaching to it and never starting the CLI at all.

## [0.1.6] — 2026-08-18

### Added

- **A recommended setup, that says why — `Flock: Recommended Setup`.**
  Seventeen settings ship off, and the two that matter most are off for a
  reason that has nothing to do with whether you want them: instant updates
  and the in-session verbs write files in your home directory, so neither
  could switch itself on. Nothing ever asked, so nobody had them. This is the
  thing that asks: a checklist with a line per step — what it does, what it
  writes — every worthwhile one pre-ticked, and nothing written until you
  confirm. It can turn tmux back on, make your first project, open the import
  door, install either of the two consent-gated features, and offer the branch
  rows *unticked* (and only when a repository of yours really has two
  checkouts). It never touches the four settings that **are** the clean slate,
  and it never turns on `lineage.git.pullRequests`, the one setting that
  reaches the network. A step you decline does not stop the rest, and the
  receipt says how to undo each thing it set up. On the empty view, in the gear
  menu, in the palette — and offered once, unprompted, on a window with no
  projects and at least two things left to do. What is offered is decided by
  `recommendedPlan` in `src/recommend.ts`, which is pure and tested; no new
  setting was added for any of it.

- **The accounts row says how long the five-hour window has left.** The weekly
  meter always named its rollover day (`wk 41% → Tue`); the five-hour meter —
  the number that actually decides whether to start another session — showed
  only a percentage. It now carries the same arrow with the time left:
  `5h 62% → 1h 20m`, computed at render time, omitted when the provider gave
  no reset or the moment has passed.

- **One session tab at a time, behind `lineage.soloSession` (off by
  default).** The quality-of-life mode for windows drowning in claude tabs:
  opening or focusing a session parks every other session tab through the
  workspace switcher's own two tiers — tmux-wrapped ones detach and keep
  running hidden, bare ones close and `--resume` from the tree, and a busy or
  waiting bare one is spared for the same reason a switch spares it. The kept
  tab is pinned, so it sits at the left of its group and survives *Close
  Others*. Workspace switches restore only the session the layout says was in
  front instead of the whole saved set.

- **`claudeExtension` mode now opens sessions in the extension's UI, not just
  new ones.** The official extension grew a command that takes a session id
  (the one its own `claude-code://open` deep link runs), so clicking a closed
  row reopens the conversation there instead of in a terminal — after every
  guard Flock already ran — and the dead-end dialog on a live row the
  extension hosts offers **Open in Claude Code extension**, which reveals the
  panel it is already open in. Forks, tmux attaches, cold opens and resumes
  pinned to another account's config directory keep Flock's own terminal,
  each for its own stated reason. Bottom-panel people were already served by
  `lineage.terminalLocation: "panel"`; the reference now says so where they
  will look.

- **Claude can name the forks it makes.** "Fork this twice — one to try the
  redis cache, one for the SQL approach" now comes back as two rows called
  **redis cache** and **SQL approach**: the in-session verbs CLI takes a
  repeatable `--name` (one per fork, in order; with names given, `--count`
  may be omitted), and the skill teaches Claude to derive short names from
  the user's own words — and to pass none when the user just wants copies,
  which keeps the numbered defaults. A name that would collide with an
  existing row, or with itself asked for twice, gets the same free-counter
  treatment every generated title gets. Already-installed verbs self-heal to
  the new skill and CLI on the next activation; run `/reload-plugins` in
  open sessions to pick the skill text up.

### Fixed

- **The walkthrough no longer promises the tree Flock stopped drawing.** Its
  first step was still titled *"Your sessions are already here"* and told a new
  user that "anything you have ever run `claude` on shows up in the sidebar on
  its own. Nothing to connect. No configuration." That was true until 0.1.5's
  clean slate made it false, so the first screen of onboarding contradicted the
  empty tree behind it. It is now the clean slate and its two doors, followed by
  a new step for the recommended setup.

- **"Show all sessions" no longer re-expands every fold the filter was
  hiding.** With **Show Only Active Sessions** on, the inline tree pruned the
  collapsed-state keys of rows the filter had merely hidden — a folder whose
  sessions were all closed, a branch row with nothing live under it — so
  turning the filter back off brought those rows back expanded. Hidden is not
  gone: grouping-derived keys now survive the filter round-trip, and session
  keys stay prunable throughout because the forest never forgets a filtered
  node.

- **Forking no longer makes the parent row vanish while the forks turn into
  roots.** Both continuation signals — the daemon roster's view of a launch
  and a transcript head-read — can transiently describe a fresh fork as a
  plain-resume *continuation* of its parent, and folding that claim chained
  the child onto the parent: the collapse then swallowed the parent's row
  into the branch until the roster moved on and the tree healed itself. A
  fork is never a re-key, and the minted edge is written before the child
  process exists — so a continuation claim naming the same (child, parent)
  pair as a persisted fork edge is now dropped at the chain fold, for agent
  forks and clicked ones alike.

## [0.1.5] — 2026-08-14

### Upgrading from 0.1.4

Nothing you have is lost, and there is nothing to run. One thing moves on its
own, and this is it.

- **Sessions Flock did not start are no longer in the tree.** The roster Flock
  reads is machine-wide, and until now the tree drew all of it: a `claude`
  typed into the bottom panel, a conversation the official Claude Code
  extension started, a script's session — each got a row here and rang the
  bell. The noise was the visible half. The other half is that the finish-stamp
  behind the bell writes an editorial record, and a record is tree membership,
  so Flock was quietly **importing** every session anyone ever ran on this
  machine, permanently.

  **Rows you already have are untouched.** Anything with a record keeps its
  place, exactly as before, so nothing you have been working on disappears —
  what stops appearing is what Flock never owned. Three doors bring those back:
  **Add Existing Session…** on a project's right-click for one at a time,
  **Import Previous Sessions…** for everything at once, and
  `lineage.showForeignSessions`, which restores 0.1.4's behaviour wholesale,
  notifications included.

Everything else here is additive or opt-in. No existing default changed, and
all four new settings start off (`lineage.showForeignSessions`,
`lineage.verbs.enabled`, `lineage.accounts.offerSwitchAtLimit`) or empty
(`lineage.codexBinary`) — including the in-session verbs, which write nothing
until you run **Install In-Session Verbs…** and accept the modal that names
both files first.

### Added

- **Add Existing Session… on a project's right-click.** The by-hand door the
  clean slate needs: a picker over the sessions that already ran in the
  project's directories — finished transcripts and live ones running elsewhere
  alike, chain-collapsed to one entry per conversation — plus **Add all N**
  when there are several, and **Enter a Session ID…** for an id pasted from
  anywhere. Adding writes an editorial record and nothing else; where the row
  files stays derived from the session's own directory, and the flow says so
  when that is not the project you clicked (membership is derived, and a row
  landing elsewhere with no sentence about it would read as a lost session).
  An id nothing on this machine backs gets a warning before it gets a row.

- **Import Previous Sessions…** — the bulk door, in the gear menu, the palette
  and on the empty view. Everything this machine knows that has no row —
  pre-Flock transcripts under `~/.claude/projects`, account profiles' projects
  dirs included — offered once, grouped by folder, newest first. **Import all
  N** for somebody arriving with two years of history, or a checkbox per
  session; deleted rows and project chats are never offered (Restore and the
  chat picker own those doors). Imports are batched into one state write, not
  one per session.

- **Ask Claude to fork its own session.** With the new opt-in in-session verbs
  installed (**Flock: Install In-Session Verbs…**), "fork this session" — or
  "do three forks here" — typed to Claude runs the same `forkFlow` the sidebar
  button runs: the same `--fork-session --resume` launch, the same exact
  lineage edge recorded before launch, the same naming (`auth 2`, `auth 3`,
  `auth 4` — each fork titled past the parent *and* its new siblings), opened
  in the window that hosts the conversation.

  One consent modal writes two files, both `rm -rf`-uninstallable and neither
  touching `~/.claude/settings.json`: a Claude Code skill at
  `~/.claude/skills/flock/SKILL.md`, so Claude knows the verb exists, and the
  small CLI it invokes at `~/.lineage/flock-verbs.mjs`. The CLI resolves which
  session it is in (the `LINEAGE_NODE_ID` launch stamp, `CLAUDE_SESSION_ID`,
  or the `lineage-<uuid>` tmux name), drops a one-line request into
  `~/.lineage/requests/`, and prints the reply — branch names, or exactly why
  nothing was forked — for Claude to relay.

  Every open window watches that directory, and a request runs **exactly
  once**: claims go through an atomic rename, and the window whose terminal
  hosts the session gets a head start so the forks open beside their parent.
  A request expires after two minutes rather than firing when a window
  finally opens; the count is capped at 8, an opening prompt at 4000
  characters; fork is the only verb. The reader is gated on
  `lineage.verbs.enabled` (default off; the install command flips it), and
  nothing about the channel reaches the network.

- **Two CLIs: a session can run on Codex.** An account's provider can now be
  **ChatGPT / Codex**, and a session routed to one launches the `codex` CLI
  under that account's own `CODEX_HOME` — its own login, signed into once,
  sitting beside the Claude accounts. The session row is a Flock row like any
  other: age, status dot, attention bell, its place in the fork tree, resume,
  park and restore, a project and a lane.

  Codex mints its own session id, so a launch binds under a provisional one and
  Flock re-keys the row onto the real id as soon as the rollout file naming it
  appears. The match is made on the launch's own facts — same directory after
  `realpath` (so `/tmp` and `/private/tmp` are one place), started at or after
  the spawn less a second of clock skew, inside a one-minute belief window,
  earliest start wins — and never on "the newest file in the store". A launch
  that failed therefore claims nothing, instead of adopting whatever session
  the user started by hand a minute later.

  Three differences worth knowing. Codex has no start-time naming flag, so
  those tabs wear Flock's own title instead of one the CLI agreed to;
  **Fork and Compact** offers a plain fork, there being no compaction command
  to hand it; and a Codex account row carries **no usage meter**. That last one
  is a deliberate absence rather than a gap: five-hour numbers are read from a
  documented Claude surface, Codex keeps its own somewhere else, and inventing
  a reading would put a number on screen where the honest answer is that Flock
  does not know. Auto-routing reads the absence as "nothing sunk yet", which
  loses to any account with an open five-hour window and beats one that is
  full — so a missing meter never makes an account look like the roomiest.

  `lineage.codexBinary` names the executable when `PATH` does not, which is
  more often than it sounds: `codex` installs per node version, and the
  environment VS Code hands an extension is frequently the one from before a
  version manager selected one — the reason a Codex row's **Sign in** could
  appear to do nothing. A `PATH` miss now falls back to `~/.codex/bin`, each
  installed nvm version newest first, `~/.local/bin`, and both Homebrew
  prefixes before giving up.

- **Move a conversation to another account, mid-conversation.** Right-click a
  session → **Move to Account...**, pick from your accounts with their meters
  beside them, and the conversation carries on where it was — on the other
  subscription. It is the answer to the thing that actually happens: you are in
  the middle of something, the five-hour window fills, and the work you were
  doing is on the wrong side of a limit.

  Flock shipped its first version of accounts refusing this verb, and the
  refusal gave a real reason — a conversation's transcript lives inside one
  account's config directory, so resuming it under another account finds
  nothing. The reason was right and the conclusion was not. A transcript
  carries a session id, a working directory, a branch and messages, and
  **nothing that identifies the login that paid for it**. So "which
  subscription is this conversation on" turns out to be a question about which
  directory the file is in, and that is a question with an answer.

  So the move is a move: the transcript is *renamed* into the other account's
  `projects/<slug>/`, taking the session's task list, file history and
  session env with it. Never copied — the archive index resolves a session id
  by scanning the default root first and each account root after it, so a
  second copy would answer with whichever it reached first, which after a move
  is the stale one. Exactly one transcript for a session id exists at any
  moment, and the rename is what guarantees it.

- **On tmux, the tab does not move.** The pane is respawned in place
  (`respawn-pane -k`), so the terminal you are looking at, its position and its
  tab are all exactly where they were — the screen redraws and nothing else
  happens. Twice, because `respawn-pane -k` kills and launches as one operation
  and there is no instant between them to move a file in: once onto a
  placeholder that says what is going on, then onto the resume once the bytes
  have landed. Without tmux the terminal is disposed and relaunched, which
  works and costs you the tab's position; the notification says which happened.

- **The confirmation says what it costs, because it costs something.** The
  conversation is kept — it is replayed from the transcript, which moved with
  it. But the config directory is read once, at exec, so Claude Code restarts:
  a turn in flight is cut off, anything typed and not sent is lost, and the
  **prompt cache does not follow**. Caching is per-account, so the first turn on
  the other account re-reads the whole conversation — slower, and a bigger bite
  out of the window you just switched to.

- **A session row's hover says which account it is on.** Beside the ownership
  line, and absent for a conversation on the machine's default login — a line
  reading "account: default" under every row on a single-account machine is a
  line nobody needs.

- **`lineage.accounts.offerSwitchAtLimit`, off by default.** On, a session this
  window is hosting whose account has just run out of its five-hour window gets
  one notification naming the account with the most room, and a button that
  opens the move with that account already chosen. The confirmation still
  appears — pressing a notification button is not consent to restart a process.
  One offer per window per session, so a meter that re-reads on a timer cannot
  become a repeating prompt. Off by default because the offer proposes an
  interruption, and that is only welcome to somebody who decided in advance
  they would rather be asked.

### Changed

- **Flock stops watching what it doesn't own.** The roster Flock reads is
  machine-wide, and until now the tree drew every session on it — so first
  launch opened onto folder rows full of other terminals' history, and a
  `claude` run in a plain terminal would pop a row here and ring the bell.
  Worse than the noise: the finish-stamp behind the bell writes an editorial
  record, and a record is tree membership, so Flock was quietly **importing**
  every session anyone ever ran on the machine, permanently.

  Now the tree holds what you told Flock about: sessions launched here, bound
  to one of its terminals, or added by hand — and a session with no row cannot
  light the bell, toast, or write itself into your tree, whether the report
  came from the roster poll or the hook stream. A fresh install opens onto an
  empty view with three doors — **New Claude Session**, **New Project…**,
  **Import Previous Sessions…** — instead of onto somebody's history.

  The old behaviour is one switch away: `lineage.showForeignSessions` puts
  every foreign live session back in the tree, notifications included. Rows
  already in your tree are untouched either way — anything with a record keeps
  its place, exactly as before.

- **A pin is no longer for life — but only a person can change it.**
  `EditorialRecord.profileId` is still written once by every launch, resume and
  fork, and the store still refuses a second pin from that path: a launch
  quietly re-billing a conversation is the failure the write-once rule exists
  to prevent. Moving one is a separate verb with a separate store method
  (`moveSessionProfile`), the same split `moveSessionSubproject` already has
  from `setSessionSubproject`. The move is **chain-wide**: `getSessionProfile`
  falls back to the earliest pin any generation of the conversation holds, so
  re-pinning the tip alone would let a `/clear`-era generation drag it back on
  the next resume.

- **A move may not change the CLI.** Two Claude accounts are interchangeable as
  far as a transcript is concerned — an OAuth plan and an API-key profile
  included, since both launch `claude` and write the same layout. A Codex
  account is not: it does not keep conversations in
  `<dir>/projects/<slug>/<id>.jsonl` at all, so there would be nothing to move
  and nothing to resume. The picker only offers accounts the conversation could
  actually run on, so the refusal is a list you never see rather than an error
  you hit.

## [0.1.4] — 2026-08-14

### Added

- **A session says which worktree it is in, and now you pick how.**
  `lineage.git.branchDisplay` has two modes, and they are alternatives rather
  than levels — the branch rows, the worktree verbs and the pull-request lookup
  are identical in both.

  `color` is what shipped: the session's name is tinted from a per-branch
  palette, and the project's branch rows are the key to it. It
  costs no width and answers "are these two on the same thing" down a column at a
  glance. What it cannot say is *which* thing, so `↑4 ↓3 *` and the request stay
  in the hover.

  `inline` is the **default**, since the feature is off until somebody turns it
  on and there is no existing tree to keep identical — meeting it for the first
  time, a branch said in words beats one said in a colour that needs a legend. It
  writes the branch under the session, the way a git prompt says it, and puts the
  name back to the theme's own colour:

  ```
    ▸ ⧉ Ranking: BM25 vs embeddings                12m ago ●
         ⇡ feat/search-ranking *      ↑4      #128 ✓
  ```

  It answers *which*, and carries the tokens where they can be read without
  hovering. It costs height — twelve sessions become twenty-four rows' worth —
  and `lineage.git.sessionBranchDetail` decides how much the line says:
  `standard` is `↑4 ↓3` and nothing else, `detailed` adds the state mark, the
  pull-request chip and the two words the arrows draw as blank, `local` and
  `merged`.

  There is deliberately **no "can this be merged" mark**. Ready-to-merge is the
  absence of tokens; a real one would need `gh pr view` per branch where Flock
  does one `gh pr list` per repository, and GitHub answers `UNKNOWN` on a first
  read, so it would flicker on a row that repaints every roster tick.

- **The mark leading a branch is the pull request's, in GitHub's colours.** A
  green arrow for open, a purple merge for merged, grey ending in a dash for a
  draft, dimmed and crossed for closed — and the `git-branch` mark it has always
  had for the branches with no request, which is most of them. GitHub's
  vocabulary rather than one of our own, because somebody arriving from a browser
  tab already reads it. The native tree draws the same five marks in the same five
  colours on its branch rows, named by the same function, so the two surfaces
  cannot drift.

  It is a `detailed`-level mark: `standard` reaches nothing but the local status
  cache, and a green arrow in it would be drawn from a source that level does not
  otherwise consult.

- **The branch name and the `#42` are links.** The name opens that branch's page
  on the remote it tracks, the number opens the request. The name is a link only
  where the branch HAS an upstream — work nobody has pushed has no page, and a
  name that looks clickable has to be. On a branch row only the number links;
  there the name *is* the row and clicking it already starts a session.

  The branch link needs no `gh` and is not behind `lineage.git.pullRequests`: the
  url is built from `git remote get-url` and the branch's own upstream, both reads
  of the local repository, and the only thing that leaves the machine is the
  browser your click hands the url to. It follows the UPSTREAM rather than the
  local name, so a branch checked out as `fix` and pushed as `axel/fix` opens the
  page that exists. Both verbs are on the right-click as well — **Open Branch on
  GitHub** is new — which is where the keyboard reaches them.

- **The `+` is back on every project and every subproject row**, and
  `lineage.git.newSessionInWorktree` decides what it means: start a session in
  that directory, or cut a new worktree first and start it there. The button used
  to be withdrawn wherever branch or directory rows were on screen, because it
  had to guess a directory silently. It states its answer now — in its own
  tooltip, on every row — and a guess you can read is not a guess. Both verbs are
  on the right-click either way, so the setting picks a default and never limits
  what is reachable.

- **A branch with no checkout has a `+` too.** It runs the worktree flow for that
  branch and starts the session in what it made, through the same confirmation
  quoting the exact `git worktree add`. That row used to refuse the button and
  send you to a different verb, which was the right rule pointed the wrong way:
  wanting a session on a branch is not the same as wanting to think about whether
  a directory for it exists yet.

- **One command turns the whole branch and worktree feature on.** **Flock: Show
  Branches and Worktrees** in the command palette writes five settings at once —
  the rows, the detail level, the pull-request chips and the two previews — and
  **Flock: Hide Branches and Worktrees** writes the shipped defaults back, so the
  pair is an exact inverse rather than a one-way door. The display mode is
  deliberately not among them: it is a preference, and putting it back on the way
  out would discard a choice rather than restore a default. Turning it on says
  what it turned on, in a message rather than a status-bar flash, since two of
  the five are things Flock otherwise never does unasked —
  `lineage.git.pullRequests` reaches the network through `gh` and
  `lineage.preview.demoProject` puts fabricated rows in the tree.

### Changed

- **The branch block is shut until you ask for it**, in both modes and on every
  project: a repository with six checkouts is no longer six rows before its first
  session. **Show Branches** / **Hide Branches** on a project's or a directory's
  right-click is the ask, remembered per project, and the button on the project
  row is now marked with a **git-branch glyph rather than a chevron** — the row
  already has a chevron, which says "this opens" where the mark has to say what
  opens. The one exception is `lineage.groupSessionsByBranch`, where the branch
  rows are what the sessions hang off.

  Three things had to change for that to hold, and the last is why it kept not
  holding. `computeGrouping` normalised the record to `=== true`, folding *never
  asked* and *explicitly opened* into one value. The fold was read through the
  project-level branch list, which is **empty by design** for a split project
  under `lineage.preview.directoryModel` — so exactly the projects the feature
  is for were the ones it did not reach. And the record itself was
  `branchesCollapsed`, whose `false` the old always-drawn block had already
  written on everybody: read as "explicitly opened", it put the rows straight
  back. It is **`branchesShown`** now — a positive record that only **Show
  Branches** writes, so every old value simply stops answering, which is the
  truth: nobody had asked. Existing settings are untouched; the stale key is
  ignored.

- **The branch rows take no colour in inline mode.** The swatch and the tinted
  name were drawn whatever the mode, so a tree that said every branch in words
  also handed you a palette to learn. Inline rows carry a git-branch mark in the
  swatch's column instead — what kind of row this is, rather than which group it
  belongs to — and the name takes the theme's own foreground.

- **The "Others (12)" / "Branches (183)" fold row is gone.** A fold inside a fold
  was one door too many, and it was the row nobody could read: an italic header
  and a number, standing for rows that had never been asked for. The count moved
  to the hover of the row the block hangs off, and **Choose Branches to Show…**
  on the same menu is what the row opened — the curation decision it was really
  offering, at the cost of a modal instead of a hundred and eighty rows.

- **The `*` for uncommitted work moved to the branch name.** It used to be the
  last token of `↑3 ↓2 *`, where it read as a third number about the upstream —
  which it is not: the arrows say where this checkout stands against the branch it
  tracks, and the star says what is sitting in it uncommitted. `feat/x *` states
  that, and it is the one Remove Worktree asks a second time over. Every surface
  places it the same way; in the native tree it leads the description, which is
  drawn immediately after the label.

- **A session's hover says what its branch line shows in shorthand.** Where the
  checkout stands, in words, and the request's state, checks and title — the same
  two sentences the native tree's branch rows have always hovered with. The line
  is four glyphs and a number; a mark that means something has to be spelled out
  somewhere, and a row has one tooltip.

- The branch line under a session is **shorter and tighter**: sixteen pixels
  against a row's twenty-two, lifted two, one size down. Equal heights made the
  two lines read as two rows; closing the gap to its session and opening one to
  the next is what makes a pair read as one thing.

### Fixed

- The inline rename's validation message was hung off a row at a **fixed**
  offset, so on a two-line row it would have landed on top of the branch line.
  It now hangs off the row's own height, which is the same pixel on every
  one-line row.
- The spine's rails are drawn against the gutter, which sits in a row's first
  line — so a session with a branch line under it would have left a gap in the
  lineage, and a column of forks would have read as a dashed line. The verticals
  that continue past a row now cross the second line; the elbow and the node,
  which belong to the first, are unchanged.

## [0.1.3] — 2026-08-06

### Added

- **Flock offers the branch rows back, once, to the people who had them.** 0.1.1
  gave every checkout of a repository its own row. 0.1.2 parked all of it behind
  `lineage.git.branches`, off — which is the right call for a sidebar 250px wide,
  and the wrong thing to have happen to you with no explanation. Nobody reads a
  changelog to find out why something they were using stopped appearing; they
  assume it broke.

  So an upgrade says it once, with **Show branch rows** and **Keep them off**,
  and never raises it again whichever you pick. Dismissing it outright asks once
  more next time, which is the rule the tmux notice already follows.

  **It is deliberately hard to trigger**, because a notice that fires for
  everybody is a notice about nothing. Every one of these has to hold: the rows
  are off, `state.json` claimed a schema version written by a build in which
  they still drew, and at least one of your repositories has **more than one
  checkout**. That last test is the load-bearing one — a single-checkout
  repository drew no branch rows in 0.1.1 either, so nothing about the upgrade
  changed what its owner sees. A fresh install and anybody already on 0.1.2 are
  silent for the same reason: neither ever had the rows.

  Telling an upgrade from a fresh install needs evidence that survives for
  exactly one read, since the first write stamps `state.json` forward and after
  that nothing on disk remembers which build wrote it. The store now captures
  what the file claimed before the migration ladder runs, and holds it for the
  window's life. A file with no version at all is a 0.1.0 install, not a new
  one; a file it could not read is neither, and stays quiet.

  Thirty seconds after startup, staggered well behind the tmux notice so two
  warnings never stack — an upgrade onto a machine without tmux is exactly when
  they would collide. The `git worktree list` probes only run once the cheap
  tests have already passed.

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

  **A new lane is born empty.** It adopts nothing: the sessions already running in
  that folder stay on the folder's own row, which keeps drawing — labelled by its
  basename — for as long as it is holding something, and disappears the moment it
  is not. A name you have just invented cannot describe work that predates it, and
  half of what is in that folder is the other lane's; sweeping it all into lane
  number one would be wrong about half the time and unpickable afterwards. So the
  folder row is a remainder, not a permanent leftover bucket: file the last session
  into a lane and it is gone, start one by hand in that folder tomorrow and it comes
  back to hold it.

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
  carries nothing and sits on the row for the directory it runs in. A stamp naming a
  lane you later removed reads as no stamp at all.

  Removing a **directory** from a project now removes the lanes named in it too, and
  the dialog says so first — a lane whose folder the project no longer covers could
  never hold a session again.

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
