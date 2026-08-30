# Changelog

All notable changes to Flock are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.8] — 2026-08-30

### Added

- **Continue on Another CLI…** — a conversation carries on in a different
  provider's session. NOT a resume, and the UI never calls it one: a Codex home
  holds no Claude transcript, so there is nothing there to resume. What it does
  is brief a new session on the other CLI to read the transcript — a readable
  file on this disk — and carry on from it, with a real lineage edge back to
  where it came from. `switchRefusal` was right to refuse the move and wrong
  only in what the refusal had been rounded up to: "cannot resume" is not
  "cannot continue". Move to Account… still owns every same-CLI move; the two
  verbs never overlap, and each is drawn only on the roster it can act on.

- **Queue Session for Dispatch…** and **Dispatch Queue…** — an intent to start
  a session, held until an account can actually take it. When every account's
  five-hour window is spent, the answer used to be a refusal with a good reason
  and nowhere for "run this when something frees up" to live; you set an alarm,
  or you forgot. The `resetsAt` already sitting in every usage snapshot names
  the exact moment that changes, and now something reads it. A settled entry is
  the queue's tombstone — no merge, reload or sweep can turn one back into a
  pending launch, because a resurrected entry is a double launch.

- **Remove Worktree decides the branch's fate, out loud.** A ref the `+`
  minted whose every commit is on the main branch earns a second button —
  **Remove and Delete Branch**, both commands quoted. Everything else keeps
  the ref and the dialog says why. The delete is `git branch -d`, never `-D`:
  git re-checks merged-ness at the moment of deletion, so a stale probe can
  cost a refused button, never commits. Which refs Flock minted is recorded in
  state (schema v8, additive) — refs minted by other tools are never offered.
- **Deleting the last session in a minted worktree offers the cleanup.** One
  non-modal toast after the Undo window: Clean Up… routes into Remove
  Worktree, same dialogs, no shortcut. Delete only — a closed session still
  needs its directory to resume.
- **A shared checkout says so in the row's hover.** Two or more root sessions
  in one checkout is the state where somebody's `git checkout` changes the
  branch under everybody standing there, so the hover names the directory, the
  count and the way out (New Worktree… gives each its own). Deliberately no
  mark on the row itself: how many sessions you started in one directory is a
  choice you made, not news the sidebar has to break, and a permanent token
  would spend width on every row of every shared checkout to say it.
- **`lineage.git.branchPrefix`** — what minted branch names start with
  (`axel/` → `axel/flock-3`, the Claude Squad convention). Blank by default.

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

- **A session says when its work has fanned out.** A workflow, a Task,
  sub-agents of any kind: while one is running, the row carries a small
  **run-all** mark beside its name. The dot could never say this — from outside
  a session, nine agents working under it and one thinking about a typo are the
  same word, `busy`, and so the same amber dot.
  It costs nothing to know. The sidebar already reads a bounded tail of every
  live session's transcript on every tick, and already inspects `isSidechain`
  twice in that same loop for the opposite reason (a sub-agent's words are not
  the conversation's); this is one more assignment inside it. The freshness
  rule compares two timestamps read out of the *same file* rather than against
  the wall clock, so a machine whose clock disagrees with its transcripts
  cannot invent a fan-out or hide one.
  It is a **mark, not a fifth dot colour**, and that is the whole design
  decision: the dot column's value is that it holds four meanings a reader has
  learnt, and a fifth would be paid for by all four. It claims only that the
  work fanned out — not how many agents, or which kind, because a transcript
  tail interleaves every sidechain into one stream and a count would be a guess
  presented as a number. It goes out with the turn that raised it. The native
  tree draws no mark and says the same thing in the hover.
- **Close Selected Sessions**, the plural of Close Session — the third command
  pair on this shape, after Archive and Open. Unlike Archive it asks nothing,
  which is the singular verb's rule kept rather than an exception made: closing
  leaves every row where it is, one click from resuming at its last saved turn,
  so five closes are five clicks from undone for exactly the reason one is one.
  Sessions running somewhere Flock cannot reach are counted and named in one
  line instead of raising the singular verb's dialog once per row.
- **Open Selected Sessions**, the plural of Open Session Here. Select several
  closed rows — shift-click, ctrl-click — and open all of them in one gesture,
  in the order you selected them. It is a separate command from the singular
  one, with `when` clauses that are complements of `lineage.multiSelect`, the
  same shape Archive Selected Sessions already uses: a contributed command has
  one title, so the singular entry on one of five highlighted rows would open
  one row and read as though it had opened five.
  Unlike the singular, **it asks first**, because the cost is the thing that
  scales: each session it opens is a `claude` process and a terminal tab of its
  own, several hundred megabytes apiece, and "I meant the two at the bottom" is
  one gesture away from eleven selected rows. The rows it *cannot* open are
  sorted out before anything launches and named in one sentence rather than in
  a stack of modal warnings — a session that is still running (reopening it
  would put a second `claude` on a transcript the first is writing) and a ghost
  ancestor (no transcript to reopen at all) are counted separately, because
  they leave you different things to do. A running session this window already
  has a tab for is simply revealed, which is what "open it" honestly means for
  a row that is already open.
  It refuses outright while `lineage.soloSession` is on, and says why: solo
  mode parks every other session tab each time one opens, so opening five would
  open five and leave you the last one.

### Changed

- **The gear menu says which window model you are on.** Choose Window Model…
  has been in **Settings and Housekeeping…** under *Setup* since the models
  landed, but it described the three choices rather than naming the one in
  force — so the entry read like a list of things you could read about, and the
  question people actually arrive with ("which am I in?") needed the picker
  opened to answer. It now reads *Currently “Auto-switch” — change it*. The
  wording comes from `windowModelChoices`, the same function the picker itself
  uses, so the sentence and the “(current)” mark one click later cannot
  disagree — and the legacy `workspaces.enabled` pair is folded by the same
  `resolveMode` every gate runs, which a direct read of `lineage.mode` would
  have got wrong for anyone still carrying it.

- **The `+` cuts a worktree per root session, and it is the default.** One
  session, one checkout: the branch is minted from the session's name
  (`flock 3` → `flock-3`, behind the new `lineage.git.branchPrefix` when set),
  `git worktree add -b` runs with no dialog — it creates a directory and a
  fresh ref and touches nothing that exists — and the status bar names both.
  No two sessions can switch branches under each other again. Turn
  `lineage.git.newSessionInWorktree` off for the old in-place `+`; forks stay
  in their root's checkout either way, and a project with no repository falls
  back to a plain session. Works without `lineage.git.branches`.

- **The branch chips now wear Source Control's own branch colours.** They used
  to be a pick of the theme's `charts.*`, which was the right instinct — the
  theme author's own set of mutually distinguishable hues — aimed at the wrong
  set. VS Code already has branch colours: the five the built-in Source Control
  Graph paints its lanes and ref labels with (`scmGraph.foreground1`–`5`). A
  branch is one thing, and it should not be one colour in the Flock sidebar and
  a different one in the SCM view eight pixels to its left. Because these are
  theme colour *ids* rather than values, a theme that restyles the graph now
  restyles these chips with it, for free.
  The palette is five entries rather than six for the same reason — a sixth
  would be a colour the SCM view never shows — and each entry falls back to the
  nearest hue of the `charts.*` set it replaced, so an editor without the graph
  degrades to the old look rather than to six identical greys. They are still
  softened toward the editor foreground, and that is the one place the two
  views are meant to differ: the graph paints on an empty canvas, while these
  sit in a column beside the status dots. `lineage.branchColors` still
  overrides any slot, raw.
- **The running-session count is no longer drawn on the activity-bar icon.**
  It is now `lineage.runningBadge`, off by default. The count is real and the
  argument for it stands — "no running process without a visible row" is only
  an invariant you can trust if the processes are counted somewhere — but a
  number that changes every few seconds on the icon you navigate by is motion
  in the corner of your eye with nothing to do about it, and the tree already
  says everything the number does, in rows you can click. Nothing was removed:
  the count, its predicate and its tests are all still there, one setting away.

- **The Shells view now lists the commands Claude runs, not the terminals it
  runs in.** The section was always meant to answer "what is executing right
  now"; what it actually listed was one row per terminal *this window* had
  bound — which is one row per session, carrying a pid and a tmux name, and
  told you nothing the tree had not already said. The unit was wrong. A
  terminal is the pty Flock launches claude *into*, and it is not the thing
  that is invisible. What is invisible is the `npm test` the model decided to
  run inside it eleven seconds ago and has not come back from.
  So the rows are now **`Bash` calls**: one per command a session runs, with
  the ones executing right now pinned to the top and a clock on each that ticks
  in seconds. A failed run shows its exit code; a refused one says it never
  ran, kept apart from a failure for the same reason a 403 is not a 500 —
  reading a denial as a crash sends you debugging a script that was never
  started. **Backgrounded jobs stay on the list until they actually finish**,
  which is the single easiest thing in a Claude session to lose track of, and
  **Open Output** on their menu opens the file the CLI is writing their stdout
  to — so you can watch one without interrupting the session to ask about it.
  **Copy Command** takes the command verbatim, not the truncated form the row
  shows.
  The scope grew with the rewrite. The old view could only ever show its own
  window's terminals, because a `vscode.Terminal` does not cross the
  extension-host boundary; the facts now come off the transcripts on disk, so a
  command running in a session **another window** launched is a row here like
  any other, and so is one in a session Flock never launched at all. The
  section's badge counts what is running, which is what makes a long script
  noticeable while the section is collapsed — its shipped state.
  Nothing was added to what has to be installed. There is no hook, no plugin
  and no `ps` walk: the CLI writes a `tool_use` record while the command it
  describes is still running, so an unanswered one *is* a command executing
  right now. That was measured rather than assumed — sampling a transcript from
  inside a twenty-second command, the record appeared about three seconds in and
  then sat unanswered for the remaining fifteen. Those three seconds are the
  honest limit: with the roster tick on top, a command has to last about five
  seconds to be caught mid-flight, and anything quicker simply appears on the
  list already finished. That is the half that does not matter — a command too
  quick to catch is one nobody needed to watch. Reads are incremental (a stat
  plus the bytes appended since the last look, never a re-read from the top),
  and the one-second clock only runs while something is live and the section is
  on screen.
  The pid and tmux facts the old rows carried are on the session row's hover in
  the tree, which is where a fact about a session belongs.

### Fixed

- **The handoff verb would never have appeared.** Its menu gate read
  `lineage.manyAccounts`, a context key 0.1.7 renamed to
  `lineage.canSwitchAccount` when it fixed the same class of bug on Move to
  Account… — and renamed precisely because the old name had stopped matching
  what it counted. Pointing handoff at the surviving key would have been the
  worse repair of the two: that key asks whether two accounts run the SAME cli,
  and a handoff is the case where they do not, so the entry would have been
  hidden on exactly the roster it exists for — one Claude login plus one Codex
  login, which is what Flock seeds by default. It now has a gate of its own,
  `lineage.canHandOff`, built from `handoffRefusal`'s own tests so the menu and
  the picker behind it cannot drift the way the switch entry's pair did. The
  entry is drawn on both the native tree and the inline sidebar, which is the
  view most installs actually use.

- **A respawned pane could read as "exited to a shell" forever.** The stamp
  `/exit` leaves behind is a PANE option, so it outlives the process it
  described — and Move to Account… restarts a conversation's process in place.
  A move onto a wrap that had ever exited left the stamp standing, and the
  resume verb, which believes that answer, would then kill and relaunch a
  session that was running perfectly well. Clearing it is now part of the
  respawn's own command list rather than the caller's job, so it is covered by
  the test that pins the order of those commands.

- **Resume no longer risks handing you a shell and calling it a conversation.**
  Groundwork for the above, and a correctness fix in its own right: the detach
  tier's "is this session still live" probe asked only whether a tmux session
  existed under the wrap's name, which a pane sitting at a shell prompt answers
  just as well as a running CLI. The probe now reads what is *in* the pane, so an
  exited wrap is treated as gone — **Resume** takes the ordinary `--resume` path
  with every guard on it, and a fresh launch ends a stale wrap rather than
  attaching to it and never starting the CLI at all.

- **You could not paste a name into a rename box.** Right-clicking the box to
  reach Paste destroyed it: the row underneath handles `contextmenu` by taking
  the keyboard back — so that a menu never acts on rows the tree does not
  visibly own — and that blurred the input, blur *commits* the edit (Explorer
  parity), and committing re-renders the row. The box was gone before the menu
  it was opening could appear. A right-click inside the box is no longer a
  right-click on the row; the box declares its own `data-vscode-context` so the
  workbench offers Cut/Copy/Paste instead of the row's verbs (every row sets
  `preventDefaultContextMenuItems`, which is right for a row and exactly wrong
  for a text input inside one); and opening a menu no longer counts as clicking
  away, since the workbench draws it outside the webview's iframe and the blur
  it causes would otherwise still commit.
- **The notifications list would not close when you clicked away from it.** It
  was opened with `ignoreFocusOut`, so Escape was the only way out. That flag
  earns its keep on a picker holding *work* — something typed, a set of rows
  ticked, a step with more steps behind it — where a stray click costs you the
  lot. The bell holds nothing: it is a list of what finished, and re-opening it
  is one click on the same bell. Removed there and from four more pure
  browse-and-pick menus (Chats, Closed Projects, Put Away, Switch Workspace);
  deliberately kept everywhere something typed or ticked would be lost.
- **The badge said eight when four sessions were running.** Both sidebars — the
  native tree and the inline webview — are registered at once, and only their
  `when` clauses decide which one the workbench draws. But a `view.badge` write
  does not care whether its view is on screen, and the workbench *sums* every
  badge in a container onto the one icon and joins their tooltips with a comma,
  so the hover read "4 sessions running, 4 sessions running". Each view now
  says which surface it is and is answered only when it is the one
  `lineage.viewStyle` is currently drawing. (With `lineage.runningBadge` off by
  default, the ordinary way to see this fixed is to turn the badge back on.)
- **The purple compaction ring could stick for ten minutes, hiding the row's
  real state behind it.** Every signal that a compaction had *finished* names
  the successor generation's id, while the `PreCompact` that started it named
  the generation before — so they only meet over the chain index, which is
  rebuilt on the poll while the hooks arrive the instant the CLI writes them. A
  hook that beat its own chain fact found no open ring; and if the turn then
  carried on — which is exactly what auto-compact does, firing mid-turn and
  handing straight back to the model — the roster never produced a busy→quiet
  edge to try again with. The ring stood, outranking the amber the row should
  have been drawing, until it went stale ten minutes later.
  There is now a completion signal that cannot lose that race: **a generation
  that has acquired a successor has finished compacting**, because minting the
  successor is what a compaction *does*. No hook, no roster edge — just the
  chain, read on the rebuild that has already built it, which closes the window
  to one poll interval. (`SessionStart source: 'compact'` is no longer treated
  as a finish at all: it is the most exact statement that a compaction ended,
  but at that instant the roster still reports the compaction's own `busy`, so
  it could not answer the second question — whether anything is behind it.)
- **A compaction left a purple dot that was still standing when the next turn
  ended.** "Compacted, and nothing behind it" is what the filled dot means, and
  it is false the moment a turn is running behind it — which is the ordinary
  shape of auto-compact. The dot rested mid-turn survived the rest of that turn
  and up to an hour past it, so at the one moment the row genuinely had
  "finished, and waiting on you" to say in red, it said "compacted" in purple
  instead. A compaction that ends while the conversation is still working now
  rests no dot at all. The `/compact` you type at an idle session — the case
  the purple dot exists for — is unchanged.
- **A compaction was announced as a finished turn.** The end of one tripped the
  same busy→quiet detector a real turn does, so Flock toasted *"X finished its
  turn"* about a conversation nobody had asked anything of, and left the row
  marked unseen-done — which is the red attention dot, hidden under the purple
  while that lasted and surfacing when it expired. A session lighting up for
  attention an hour after a compaction it did on its own. The detector now
  recognises its own compaction and stays quiet.
- **Some projects carried a notification dot with nothing lit underneath it.**
  The dot that rolls up onto a project row was asking a different question from
  the dots on the rows below it: it spelled out its own version of "unseen-done"
  by hand, and the hand-written copy disagreed with `statusTone` in three
  directions at once. A session that was **over** — archived, exited, or an
  inferred ancestor — draws no dot of its own but can still carry `unseen` from
  the turn it finished before it ended, so a project lit red above a subtree in
  which every row was closed and grey, and no click could clear it because there
  was no lit row to open. A session that had gone **busy** again rolled red up
  over its own amber. And a **waiting** session with unseen tracking off lit its
  own dot while its project stayed dark. Both surfaces — the inline sidebar and
  the native tree, which each had their own copy — now ask `statusTone`, the
  same function the row's own dot is drawn from, so a parent can no longer
  contradict its child.

## [0.1.7] — 2026-08-30

### Added

- **Close with Summary now compacts the branch and keeps what the compaction
  said — and can pass a short form of it up to the parent.** What it used to do
  was open an input box and ask *you* to type the summary: of a conversation you
  had just been reading, with no help from the one thing on screen that already
  knew what it had concluded. What it does now is what you would do by hand.
  Say precisely what that means, because the distinction is the whole point.
  Flock cannot ask a model for a summary — it has no API client, and the only
  way it can speak to a conversation that is already running is by typing into
  its terminal. So it **sends `/compact`**, which the Claude CLI interprets as a
  command (the same property Fork and Compact has always rested on), and then
  **reads back the summary the CLI wrote** into the transcript. The words are
  genuinely the model's; the driving is a keystroke. It is not a scrape of the
  last exchange, and nothing calls it something Flock generated.
  It costs what it costs, and every cost is refused loudly rather than absorbed
  quietly. A compaction takes one to three minutes, so there is a progress
  notification with a Cancel button. It squashes the branch's own context, which
  is only acceptable because the branch is being closed in the same breath — so
  if the compaction never answers, **nothing is closed at all**, and the dialog
  says that the branch has been compacted either way. It is Claude-only, and a
  Codex session is offered the plain close and the old input box by name. It
  needs the session's tab open in this window, and a closed row, another
  window's session, a foreign process or a session parked by a workspace switch
  is refused *before* a keystroke is spent — and, since the row already knows
  which of those it is, the menu entry is no longer drawn on a row where the
  answer could only ever be that refusal. `lineage.close.summaryMode` chooses
  between `compact-and-tell-parent` (the new default), `compact-only`, `ask-me`
  — the old box, kept by name so anyone who preferred it can find it — and
  `off`.
- **A fork can tell its parent that it happened**, behind
  `lineage.fork.notifyParent`, off by default. One sentence typed into the
  parent conversation naming the new branch and, when the fork was given an
  opening prompt, what it is for.
  This is **new construction, not an existing mechanism being switched on**, and
  it would be dishonest to imply otherwise. Flock has no session-to-session
  messaging and never has had: the in-session verbs channel runs one way,
  session → Flock, and carries exactly one verb; the only text that has ever
  gone the other way is a fork's opening prompt, delivered once when the branch
  starts. Branches do not talk to each other. What this rides is the single
  channel that can reach a conversation already running — Flock typing into its
  terminal, the same thing the wrap prompt does — and that channel reaches
  **only a session bound in this window**. A parent that is closed, hosted by
  another VS Code window, running outside Flock, or parked detached by a switch
  cannot be typed into, and in all four cases the note is simply not sent:
  nothing is queued, nothing is retried, one line goes to the output channel.
  Those are the ordinary cases, which is why the setting is off by default and
  why the description says all of this rather than promising delivery. It is
  never sent when Claude itself asked for the fork — the verbs CLI already
  reports the new branches into that same turn, and a second copy would land
  keystrokes in the middle of it. `docs/reference.md` gains a section stating
  the whole boundary in one place.

- **The auto-switch window now follows the SESSION — its subproject's directory
  in the Explorer, its git worktree in Source Control.** This is the model's
  whole promise and only half of it was true. The Explorer followed the active
  PROJECT, and it asked for the directory the wrong way round: the project's
  claim on a session is the directory the project *reaches* it through, which
  for a session inside a linked worktree is the worktree root. So a conversation
  running in `~/mono-feat-x/api/src` rooted the file tree at `~/mono-feat-x` —
  the whole monorepo — while the sidebar, asking its own question through
  `canonicalCheckoutPath`, filed the very same session under the `api` lane. Two
  rules for one question is this design's own definition of a bug, and the fix
  is a third place both can read from: `src/follow.ts` decides once, purely, and
  the Explorer, Source Control, the switch, the reload heal and the Project
  view's directory mark all take that one answer. The tree now roots at
  `~/mono-feat-x/api`: the lane you named, translated into the checkout you are
  actually typing in. Every rung of the ladder must *contain* the session, which
  is what makes falling down it safe — a candidate that does not hold the
  session is describing somewhere else, and a file tree rooted there is a tree
  you are not editing.
  Source Control is genuinely new. It rides the same folder splice — VS Code's
  built-in git extension opens a repository for every workspace folder that
  appears — so the mechanism that already moved the file tree moves the SCM view
  with it, and a linked worktree arrives as its own repository on its own
  branch. `src/sourceControl.ts` is the belt to those braces: one guarded
  `openRepository` call for the case a directory sits below its repository root,
  written to be a silent no-op whenever the splice already did the job, and to
  degrade to "no following, everything else unchanged" when the git API is
  missing, disabled or older than expected. What that second path is for has not
  been proven by a controlled run from outside a workbench, and
  `docs/reference.md` says so plainly, gives the one-minute experiment that
  settles it against this repository's own `.claude/worktrees/`, and names the
  remedy (`git.openRepositoryInParentFolders: "always"`) as the user's to set
  rather than Flock's to write.
  Two states deliberately stay silent. No conversation in front — you clicked
  into a file, the window just opened — moves nothing, because a file tree that
  blanks itself in that moment is the worst thing this feature could do. And a
  cold git probe leaves Source Control alone rather than pointing it at a guess;
  the probe lands a moment later and the view repaints, the same trade the
  branch chips already make.
  No new setting and no new window model. An earlier draft proposed a fourth
  `lineage.mode` value for "follows the session", and it was rejected for the
  reason the three-model consolidation exists: two values both meaning "the
  window follows something" is exactly the truth table that work removed.
  Following the session is not a different model from auto-switch — it is what
  auto-switch *means* once it is done properly. The two verbs are renamed to say
  so (**Flock: Follow the Session I Am In**, **Flock: Stop Following — Reopen as
  a Plain Window**), keeping their command ids, because a user's keybinding on
  `lineage.followInExplorer` must not break over a change of wording. And the
  convert verb now refuses in the two models that would not follow, pointing at
  **Flock: Choose Window Model…** rather than writing the model itself — a
  reload and a permanent anchor row in exchange for nothing is not a thing to
  let somebody buy by accident, and `lineage.mode` keeps its single writer.

- **What a window is, is now one setting with three answers you can name.**
  The three ways people actually work — one folder per project, Flock only, and
  the window that follows you — were two values of `lineage.mode` and a corner of
  a truth table.
  `mode: project` with the older `lineage.workspaces.enabled: false` already
  produced a window with no auto-switch, no status-bar button and no scope
  fence: Flock-only in everything but a name, reachable only by somebody who
  knew to combine two keys and could work out what the combination did. A level
  you have to compute is a level nobody chooses. `lineage.mode` now takes
  `folder` | `root` | `project`, labelled **One folder per project** / **Root
  (Flock only)** / **Auto-switch** in the settings dropdown, and the old pair
  folds into the second value once, on read. The middle value is spelled the way
  Axel says it out loud — *"if we are in the root mode, so to say, then we open
  it"* — rather than `flock`, which was this round's first guess and which he
  overruled.
  `docs/settings.md` lays the three side by side with a row for **what each one
  costs**, because each is genuinely better than the other two at something: one
  folder per project needs nothing and costs a window per project; Flock only
  costs you the window you open per piece of work and a sidebar with nothing
  narrowing it; auto-switch is the most convenient and the hardest to keep
  straight, and it wants tmux and one reload before the file tree follows too.
  The default stays `folder` — it is the only one of the three that is right for
  a window whose folder Flock did not choose, and a default may not require a
  reload to take effect.
- **Flock: Choose Window Model… — a three-way choice you can find.** The models
  were only ever reachable through a dropdown among forty-odd settings rows,
  whose values read `folder` / `root` / `project` rather than in words anybody
  uses. There is now a picker: the three by their labels, each with what it
  costs written beside it, the cursor already on the model this window is
  actually in. It is in the gear menu and the command palette, and it is a step
  of **Recommended Setup** — always offered, like *Choose where sessions open*
  and for the same reason, since a choice has no "already done" and the default
  being an answer is not the same as the person having been asked. Choosing
  **Auto-switch** also writes `lineage.workspaces.enabled: true`, which is the
  only way that deprecated key ever gets untangled on a real machine — and it
  happens because somebody asked, which is the only way this extension writes to
  a settings file at all.

- **The window says where you are, not just which project it was switched
  to.** One status-bar line, read off the conversation in FRONT rather than off
  the last switch: `Magma Score › ingest` with the branch when the branch is
  worth naming. It updates on FOCUS, which is the point — moving between two
  lanes of one project is not a switch (the auto-switch correctly returns early,
  the project did not change) and until now no surface noticed the most common
  move of the day. The Explorer's **Project** view renders the same decision as
  a row of its own, untruncated, so the two cannot disagree: one answer
  (`src/whereami.ts`), two surfaces.
  It knows when the window and the keyboard disagree. Focus a conversation
  belonging to another project — auto-switching off, or its project closed — and
  the line carries both names (`App → API`) and the click goes straight to the
  one you are actually in, instead of opening a picker to re-answer a question
  the line already answered. A CLOSED project is never offered: putting one away
  removes its rows everywhere, and the status bar must not become the one place
  it reappears.
  The branch appears when it is not the branch you would assume: a linked
  worktree, a detached HEAD, a lane's pinned branch, or simply a name that is
  not `main`/`master`/`trunk`/`develop`. A repository's own checkout sitting on
  a feature branch is what a repository looks like while somebody works in it,
  and that is the fact the line exists to carry; `main` on a checkout that has
  never left `main` is a segment that spends the space and says nothing.
  **It belongs to the window that rearranges itself, and to no other.** An
  earlier draft of this feature also drew the item outside auto-switch whenever
  the line had a lane or a non-trunk branch to report, with a click that jumped
  to the session's row. That was cut before it shipped. A window that IS its
  folder has no workspace to name; the lane and the branch are worth saying, but
  the Explorer's **Project** view already says them untruncated, and one fact
  rendered twice is one rendering too many to keep honest; and the condition was
  true for most real sessions — any lane, any linked worktree, any branch that is
  not a trunk name — so what it produced in practice was chrome that appeared and
  disappeared as you moved between branches, in the two models whose whole promise
  is that nothing moves unless you move it. `modes.projectSwitchingOn` is now the
  item's single gate, which is what the manifest, `docs/settings.md` and the
  design document have all said all along.
- **Switch to a project from its own row.** `Switch Workspace` joins the project
  row's context menu in both trees, in project mode only. The switcher was
  reachable from the status bar and the palette, and not from the row you were
  already looking at.
- **Open Workspace for This Session — go to a session's files from its row.**
  There was no way to open a window on one conversation's directory. The only
  "open it elsewhere" verbs started from a project row or a branch row, so the
  answer to "I want *that* session's files and *that* session's Source Control"
  was to work out which directory it was in and open it yourself. It is now a
  right-click on any session row, live or closed, in both sidebars.
  It resolves the directory in three rungs and the order is the point: the
  session's own **worktree** first, because for anybody running one agent per
  worktree that is the only answer that gets both the files and the branch right;
  then its **subproject's** directory, when that directory actually contains the
  session (a subproject's directory is editorial and may point somewhere else
  entirely, so one that does not is skipped rather than trusted); then the
  directory its **project** claims, falling back to the session's own. Every rung
  contains the session's working directory, and that is load-bearing rather than
  tidy: a window fences both what it may launch and what it may draw a row for to
  the folders it opened, so a window opened on a directory that did not contain
  the session would have neither a row for it nor the ability to resume it.
  It opens a new window — except when one already covers the directory, this one
  included, in which case that window is raised and the row revealed there. Axel
  asked for a new window and that is the ordinary outcome; two windows on one
  directory is two roosts for one piece of work, which is the shape the
  84-detached-sessions incident was made of. The session itself does not move: it
  keeps its tab and its process where it is, and a resume in the new window works
  once it has been closed here.
- **Move to Subproject… — the missing half of named subprojects.** A
  subproject's stamp was written at LAUNCH and nowhere else, so the only way into
  one was to start a session from its `+`: every conversation that predated the
  subproject, every one started from the project's `+`, and every one started in
  a terminal could never be filed in it. Measured on a real store before this
  existed — two live subprojects, 556 session records, not one stamp between
  them. It is now a verb on the session row in both trees, and it offers the
  subprojects of the project **the session is in**, derived from the session's
  own directory rather than from the row that was clicked (a stamp naming
  another project's subproject is one no reader would ever resolve). A session in
  a linked worktree is reached through the repository it belongs to, in one git
  call. "No subproject" is not a delete: the session goes back to being placed by
  its directory, where every session Flock did not start already sits.
- **Compaction has a mark of its own: a purple ring, then a purple dot.** A
  compacting session was wearing two costumes in turn, neither of them its
  own — `claude agents --json` reports it as plainly `busy`, so the row drew
  the amber running dot for work nobody asked for, and when the compaction
  ended and the session went quiet it drew the red attention dot, which means
  "this one wants you". Compaction is neither, and now says so: a **hollow
  purple ring** while it runs, and a **full purple dot** once it is done with
  nothing behind it. The moment anything is behind it — a new prompt, a new
  turn — the ordinary tones resume. The shape is the tree's own ring-to-fill
  grammar (a ring is a node with more to come, a filled dot is where the line
  stops), and the colour is themeable as `lineage.compacting`.
  Detecting the start of a compaction needed a new signal — the roster says
  `busy` and nothing else, and the transcript's `compact_boundary` record is
  not written until it is over — so the hooks plugin gained a sixth event,
  `PreCompact`, which self-heal installs silently. Hooks are still never
  required: with them off the ring simply never appears, and the way *out* of
  the phase has three independent signals so a ring that appeared can always
  come down. The rules are pure and tested (`src/compaction.ts`).
- **A Shells view — the terminals this window is actually running.** A third
  section under Sessions and Accounts, shipped collapsed: one row per bound
  terminal, with the pid running in it, whether it is wrapped in tmux, and how
  old it is. Clicking a row brings that terminal to the front. The tree
  deliberately hides all of this — it collapses a conversation's generations
  onto one row so the machinery underneath stops being your problem — and this
  is where it stops being hidden, for the times when it *is*: a session that
  will not focus, a wrap you want to confirm, an editor that has quietly
  accumulated eleven terminals. **This window only**, said on the view itself:
  a terminal belongs to the window that made it. Turn the section off with
  `lineage.shells.section`.
- **The tree is now the session switcher — `lineage.sessionSwitching`.** The
  back arrow at the top of the Claude Code extension's panel leaves your
  conversation for an agent list that knows nothing about forks, projects or
  worktrees, and is very easy to hit by accident. Flock cannot intercept that
  click — it is a route change inside another extension's webview, with no tab,
  title, command or context key on the outside of it — so instead it makes
  sure the place you land is already right. The row of whatever conversation is
  in front now stays **selected**, so the tree never loses your place; and
  `alt+left`, while Claude Code has focus, puts the **keyboard** on that row so
  the up and down arrows move you between sessions from there (**Flock: Show
  Current Session in the Sidebar** in the palette does the same). Following is
  gated on the tree being visible, so a collapsed sidebar never springs open.
  Set `lineage.sessionSwitching` to `claude` to turn both halves off and keep
  the agent list.
- **Idle chat tabs close themselves — `lineage.chat.autoCloseMinutes`.** A
  project chat is a scratch conversation whose normal ending is abandonment,
  and it has no tree row for solo mode or a workspace switch to tidy behind —
  so finished chats piled up as tabs until each was closed by hand. Now a
  chat's tab closes on its own after 30 minutes without use (set the minutes
  to taste; `0` turns it off). The conversation is kept and reopens from
  **Chat History…**; a chat that is busy or waiting is never touched, and
  neither is the tab you are looking at. The decision is pure and tested
  (`chatAutoCloseVictims`, `src/chatAutoClose.ts`).
- **The recommended setup asks where sessions open.** A new checklist step —
  always offered, because a choice has no "already done" — opens a four-way
  picker: one pinned session tab, editor tabs (the default), the official
  Claude Code extension's own UI, or the bottom terminal panel, with the
  current arrangement marked. Ticking the step writes nothing; the option you
  choose in the picker writes `lineage.terminalLocation`,
  `lineage.soloSession` and `lineage.launch.mode` together (the extension
  option writes the mode alone), and cancelling it writes nothing at all. The
  options and the current-answer rule are pure and tested (`surfaceChoices`,
  `src/recommend.ts`).
- **A genuinely fresh install opens the Get Started walkthrough, once.** The
  first-launch notices are all deliberately hard to trigger, so an install
  where none of them fired greeted its person with an empty sidebar and
  silence. Now a machine whose store holds no projects and no session records
  gets the walkthrough opened for it a moment after activation — one
  guaranteed front door, decided once per install and never re-asked.

- **Every project row has an "Archived Sessions…" list.** Axel: *"there should
  be some way to, in a project, see the archived sessions, search among the
  names, and restore."* Archiving takes a row out of the tree, which until now
  made the archive the one place a session could be without being anywhere you
  could look: the only doors back were the Undo button on the toast — gone the
  moment you dismissed it — and one whole-machine picker that labelled most of
  its rows with an eight-character hex id. The new verb sits on the project's
  own row in both sidebars, lists what that project archived newest-first with
  the name, the age and the directory, searches over all three, and restores as
  many as you tick in one press of Enter. It is deliberately built on the same
  name chain the tree row uses, so a row and its archive entry can never
  disagree about what a session is called, and on the same worktree-aware
  membership rule the sidebar groups by, so a session that ran in a linked
  worktree is filed under the project that owns the repository. Where a record
  carries no working directory of its own — measured on a real store, 32 of 159
  archived records — the transcript's own head supplies one; without that a
  fifth of every project's archive would have been silently missing, and an
  incomplete list looks exactly like an empty one. The four records that have
  no directory anywhere belong to no project and stay behind **Restore Archived
  Session…**, which remains the everything-door.

- **`docs/forking-and-context.md` — what forking actually does to a
  conversation, measured rather than described.** The question it answers was
  asked in these words: *"I want you to explain clearly to me how context is
  used when we are using Flock to fork the sessions."* The short answer turns
  out to be one that the word "fork" actively works against: **a fork
  duplicates the conversation, it never reduces it.** The Claude CLI answers
  `--fork-session --resume <parent> --session-id <child>` by writing the
  parent's whole chain into the *child's* transcript — same message uuids,
  `parentUuid` relinked, the camel `sessionId` rewritten to the child and the
  snake `session_id` left naming the parent — and the child then continues from
  there. One measured pair on this machine: 371 of the parent's 379 message
  records, 7.7 MB of a 13.5 MB child file. So forking is how you stop paying for
  a bad *direction*; it is not how you stop paying for a long conversation, and
  the document says which verb is.
  Everything in it is either a file and line in this repository or a transcript
  it was read out of, and the sections that are reasoned rather than observed
  say so in their own words. It covers the plain fork, what the resume-leaf
  repair is for and how much of the parent's last turn a child therefore
  inherits (of 278 transcripts here, exactly **5** end with a leaf that cannot
  reach the tail, losing one or two records apiece — down from the 23 of 282
  measured when that bug was found, because the CLI now records its leaf *past*
  the end of the turn), fork-and-compact (the full copy still lands on disk;
  what changes is the context, bought with one full-history model call that the
  child pays, 59 to 243 seconds across 76 observed compactions), resuming a
  closed session, and the agent-verbs path where Claude forks itself mid-turn.
  **It also corrects a belief, which is the reason it says so first rather than
  in a footnote: there is no sibling-to-sibling communication in Flock and there
  never has been.** Branches do not talk to each other. What exists is a fork's
  opening prompt, delivered once at birth, and the one-way agent-verbs request
  channel — and, new in this release, the fork note and the close summary, which
  ride Flock typing into a terminal and reach only a session bound in this
  window. Building the parent-notification feature on a mechanism that did not
  exist would have promised delivery it cannot make, so the document draws that
  boundary before it describes what was built inside it.
  The comments in `src/resumeLeaf.ts`, `src/generations.ts`, `src/archive.ts`
  and `src/transcript.ts` are corrected against the same evidence. Two of them
  were quietly wrong in a way worth naming: `generations.ts` verified its
  fork-marker premise on 13 *native* `/fork` transcripts, which are the only
  kind that writes `forkedFrom` at all — **0 of the 153 forks Flock has made on
  this machine carry one**, across claude 2.1.207 to 2.1.248 — and its
  conclusion survives for a reason it had not written down; and
  `resumeLeaf.ts`'s cited measurement was four CLI minor versions stale. The
  selection code it quotes was re-read out of the installed 2.1.250 binary and
  is unchanged.

### Changed

- **Delete is now Archive, and it closes the session before it hides the row.**
  Axel: *"there is a big difference between closing and deleting something…
  we should rename delete session, it should be called something like archive,
  and we should actually be able to restore those archived sessions since they
  are still on disk… it should be more of a hassle than just closing it."*
  Four commands changed their titles — **Archive Session**, **Archive Selected
  Sessions**, **Restore Archived Session…**, **Archive Stale Sessions…** — and
  none of them changed its command id, so a keybinding on `lineage.deleteSession`
  keeps working; the ids are a public contract nobody ever reads, and breaking
  them to chase a word would have been the expensive half of the rename for
  none of the benefit. The user-facing words for the three states are now
  **Open**, **Closed** and **Archived**; the record field is still called
  `deleted`, because the state file is on real users' disks and a third
  migration rule would have had a live blast radius in exchange for a name only
  the source reads.
  Archiving now asks once, in a dialog that says how many sessions it is about
  to close, that the transcript stays and the conversation is still resumable,
  that forks move up to their parent, and that Undo brings back the row but not
  the process. That dialog is new: this verb used to argue, in a comment, that a
  modal would cost more than the mistake does. The argument is retired, and the
  asymmetry is now the point — closing is one click and asks nothing, archiving
  stops to ask, because a row you cannot see is a session you will not remember
  you have. **Archive Stale Sessions…** deliberately keeps its single question:
  the checklist you just filled in *was* the confirmation, and a modal on top of
  it is a second question about the same answer.

- **A closed session is one row again — its name and its age, and nothing
  else.** Turning on **Show Closed Sessions Too** used to fill the sidebar with
  the worst rows in the tree. Each archived row carried a scrape of its
  transcript's tail beside the age, and under `lineage.git.branchDisplay:
  inline` it also carried its branch — a name in the native tree's description,
  a whole second LINE in the inline sidebar, so a history of finished work cost
  twice the vertical space of the work you are doing. Axel put it plainly: *"I
  can't see the name of the session when I toggle on show all sessions. I see
  like the last prompt … that's not a nice experience, very bad experience."*
  Three things now come off the row and land in its hover, which already carried
  every one of them at greater length: the last exchange, the close-with-summary
  text, and the branch. A closed row draws no branch line in either surface,
  whatever the setting says, and it is *transparent* to the rule that a branch is
  named only where it says something new — so the first live descendant in the
  same checkout speaks up instead of the whole subtree going quiet about a
  worktree nothing above it ever named. The goal every one of these choices was
  judged against is Axel's: leaving **Show Closed Sessions Too** on permanently
  has to be comfortable.
  The hover now carries the summary **and** the last exchange, where it used to
  read `summary ?? lastExchange` and show whichever came first. That coalescing
  was survivable while the row carried one of them; once both moved to the hover
  it meant recording a summary silently deleted the session's final words from
  the only surface that still had them. They are different facts — what somebody
  decided the branch amounted to, and what the conversation actually last said —
  so they get a line each, summary first, because that one was written for
  exactly this purpose. Axel's rule when the question was put to him: *"as long
  as both are available to the user, that's fine."*

- **The detach-grace countdown moved from the row to the hover.** A tmux-wrapped
  session whose tab a workspace switch closed keeps running detached, and the
  design made that safe by demanding the row say so *with a countdown*. Shown
  the hover, Axel decided the countdown had stopped earning its place on the
  line: *"the automatic closing, it's kind of nice, it shouldn't be displayed in
  the UI in any way … oh wait, now I actually see there is a hover state here,
  'closing', yeah that's good then, that's enough then."* What the constraint
  actually buys is the impossibility of a running process with nothing on
  screen, and the ROW is what buys it — the countdown text was the price the
  spec happened to name. So the row stays, keeps Close Now and Keep Awake, keeps
  its place in the running-count badge, and now says `detached: tab closed,
  process kept for instant re-attach — closing in 9m, closes at …` on hover, in
  one sentence both surfaces share. The cost is real and worth stating: a
  detached-running row now looks exactly like a live idle one, and only the
  hover tells them apart. `design/levels-and-modes.md` has been corrected rather
  than left promising a countdown that is no longer there.

- **A window that follows you stops advertising folders it is only visiting.**
  An auto-switch window publishes its workspace folders to the machine-wide
  window roster so other windows can route work to it — but its roots now change
  every time your attention does, while a `WindowRecord` is republished at most
  once every six hours. That combination makes the window the advertised host
  for whatever directory it happened to be rooted at when it activated, and
  sends other windows' sessions to a roost that moved minutes later: the
  84-detached-sessions incident arriving by a different road. Such a window now
  publishes no folders at all, which is the honest shape for it — it is not the
  window *for* any directory, it is the window that follows you. The consequence
  is intended: it is never `windowForDir`'s answer, so a verb that would route
  there opens a new window instead. Routing only; nothing about scoping changes,
  since the folder-mode fence reads the live folder list and auto-switch is
  unfenced anyway.

- **The Explorer's reload heal is auto-switch only.** It also ran in the
  Flock-only model, on the grounds that that model has no fence for a re-splice
  to drag. But Flock-only is *defined* by nothing rearranging itself without
  being asked, and a file tree that re-roots on its own at every window reload is
  exactly that. Its switch verb still moves the tree when somebody runs it; the
  tree simply stays where they left it in between. The dedicated Explorer
  focus listener went away entirely in the same pass — the follow is now driven
  from the one place where the "where am I" answer is already computed, so the
  status line, the Project view, the file tree and Source Control are four
  renderings of one decision made on one tick, and there is no second
  subscription to keep positioned by hand relative to the auto-switch.

- **`lineage.workspaces.enabled` is deprecated, still honoured, and read in
  exactly one place.** It was never the master switch its own description
  implied: it gated the focus-follows auto-switch and the workspace status-bar
  item, and nothing else — not the switch verb, not the project row's menu, not
  the palette entry, and not one of `workspaces.ts`'s save, clear or restore
  paths, all of which asked the mode instead. That overstatement is exactly what
  made the third window model invisible. It now has one reader, `resolveMode`,
  which folds it together with `lineage.mode` and hands the rest of the extension
  a single value. **Nothing on anybody's disk was rewritten.** The fold is a
  rule, not an edit: an activation that quietly edits a `settings.json` nobody
  asked it to touch is a worse citizen than one that keeps reading an old key,
  and Settings Sync would have carried that edit to machines running builds that
  have never heard of the value `root`.

  The migration moves nobody. Unset or `folder` stays **One folder per
  project**, whatever the old key says. `project` with the key unset or `true`
  stays **Auto-switch**. `project` with the key `false` becomes **Flock only** —
  which is what that pair has always actually meant. One thing does move, and it
  is small: for that last group, the `$(layers)` button in the Explorer's
  **Project** view title is gone. It is persistent chrome, and at the Flock-only
  level it would be a second, quieter copy of the status-bar button that model is
  defined by not having. The verb is still on the project row, in the palette,
  and on any keybinding it was given.
- **The Explorer's Project header stops offering a switch that would refuse.**
  The header row and its "No active project — Choose one…" row both fire
  `Switch Workspace`, and that verb refuses in the one-folder-per-project model.
  The view can be on screen there: it is contributed on whether the Explorer
  follow is set up, which says nothing about the window model, and the active
  project id lives in per-window state that nothing clears when the model
  changes — so a window that once auto-switched kept drawing a clickable header
  whose click was a toast explaining why nothing happened. In that model both
  rows are now captions: they still say which project the window is scoped to,
  and they no longer promise a journey. The fix is to stop making a row look
  clickable rather than to make its refusal friendlier, which is the same
  argument the view's own "you are here" row has always made about itself.
  The Flock-only model keeps both clicks, deliberately: it has the switch verb,
  it simply never fires it for you. A row is silenced only where the verb behind
  it says no.
- **The tmux nudge no longer asks whether the workspace switcher is on.** It
  stayed silent whenever `lineage.workspaces.enabled` was false, on the stated
  grounds that workspace parking was "the only feature the detach tier serves".
  That had not been true for some time: solo mode parks sessions in every window
  model, and the detach grace runs at every level, so a machine with the switcher
  off still detaches sessions and still loses whatever they were in the middle of
  when tmux is missing. The gate is gone. One consequence, said plainly because
  somebody will meet it: a person who had the switcher off can now get the
  once-per-install nudge they were not getting yesterday. It is dismissible, and
  it is the right advice for them.
- **The Explorer stops following in one-folder-per-project windows.** The follow
  listener and the reload heal asked whether the window was anchored and whether
  `lineage.explorer.followProject` was on, and never asked which model the window
  was in. But `workspaceManager.activeProjectId()` lives in `workspaceState`, so
  a window that was once auto-switching still carries a project id after being
  set to folder mode — and under `directory` scope a re-splice replaces the
  folder tail with exactly one root. Folder mode's fence *is* its live folder
  list, so that background re-splice dragged the fence with it and rows the
  person was looking at disappeared, with nothing on screen to explain why. The
  Flock-only model keeps the follow deliberately: it has no fence to drag, and an
  active project id can only exist there because somebody ran the switch verb on
  purpose.

### Removed

- **The Flock demo project is gone, and so is `lineage.preview.demoProject`.**
  It fabricated a project called *Flock (demo)* — three directories, two
  repositories, a branch in every state a row can draw — so the
  directory-and-branch layout could be judged without owning a repository
  shaped the right way. It was fenced off about as carefully as a made-up thing
  can be: every id carried a prefix that `isSessionId` rejects, no directory on
  it existed, it was built from a constant rather than read from the store, it
  was appended downstream of every rule that decides what a session belongs to,
  and one gate in front of every registered command refused any verb that
  touched it. The fence held. It was also beside the point, because the setting
  was not actually off: **Flock: Show Branches and Worktrees** wrote it ON as
  part of the branch bundle, so people who had never heard of the preview found
  a project they had never made sitting in a sidebar full of their own work. A
  fabricated project in a real tree is a bug however well it is contained, and
  the containment was never the thing that was wrong. For looking at the layout,
  `lineage.preview.directoryModel` over your own repositories is what is left —
  and it has the advantage of answering the question people actually ask, which
  is whether the layout is right for *their* monorepo. The branch bundle is now
  four settings rather than five.

  If `"lineage.preview.demoProject": true` is already sitting in your
  `settings.json`, it now does nothing: VS Code keeps keys it does not
  recognise, and Flock no longer reads this one — nor can anything write it
  again, since the settings writer refuses keys the extension does not
  contribute. But **Flock: Hide Branches and Worktrees** no longer clears it
  either, because that verb walks the bundle's own table and the demo has left
  it. So the line will sit there inertly until you delete it by hand. Flock does
  not delete it for you: there is no precedent in this extension for writing to
  somebody's `settings.json` without their own act, and a silent mutation on
  activation would be a larger surprise than a dead key.

### Fixed

- **The onboarding walkthrough had fallen behind the releases it introduces.**
  The walkthrough is the one surface a fresh install is *given*, so a stale
  sentence there is worse than a stale one in the reference — it is read first,
  and read by somebody with nothing to check it against. Four were wrong. The
  attention page taught the dot column as "amber, red, and everything else
  draws nothing", which stopped being true when compaction took a colour of its
  own; it now teaches the purple ring and dot alongside the other two. The same
  page said the number on the sidebar icon counts the red dots, which stopped
  being true when that slot went to the running count. The setup page said
  Flock ships *forty* settings — the sweep that recomputed the manifest to 48
  reached `docs/settings.md` and not this — and it listed what Recommended
  Setup asks without the question the window models added, so the checklist
  asked people to choose what a window is and the page introducing the
  checklist had never mentioned it. The manifest's own step descriptions
  carried the last two of those and are corrected with them.
- **The empty sidebar did not say the tree starts empty on purpose.** The
  clean slate has been the default since 0.1.5 and the native tree's welcome
  has said so since; the inline sidebar — which is the default view, and
  therefore the empty box a fresh install actually meets — said only "No Claude
  sessions here yet", which reads as a bug to anybody who knows they have run
  `claude` on this machine before. It now says the same thing the native
  welcome does, and points at the import button already sitting underneath it.
- **Fork and Compact told the parent that the new branch was "for `/compact`".**
  With the fork note turned on, a branch announces itself to the conversation it
  came from, and it quotes what the branch is *for* — the opening prompt,
  because that is the only thing on a fork a person actually typed about its
  purpose. Fork and Compact's opening prompt is not that: it is `/compact`,
  machinery Flock injects on your behalf, and handing it through presented the
  compaction command to the parent's model as the branch's stated intention.
  Such a fork now gets the same short sentence a plain unnamed fork gets. The
  exclusion is that one string and not "anything beginning with a slash": a real
  fork prompt can open with a path, or with a slash command that genuinely is
  the point of the branch.
- **A long name or summary could be truncated through the middle of an emoji.**
  Both the sentence typed into a parent conversation and the summary written
  onto a closed session's record are capped, and the cut was counted in
  UTF-16 units without checking where it landed — so a name of more than eighty
  units, or a summary of more than a thousand, could end on half a character.
  The visible half was a replacement glyph, typed into somebody's conversation
  and persisted onto the record and the row's hover. The cut now falls on a
  character boundary, one unit short of the budget rather than one character
  into the middle of something.
- **Restoring a session into a project you had closed put it nowhere and said
  nothing.** The archive browser is reachable for a closed project on purpose —
  "where did that session go" needs an answer even when the project is put away
  — but the restore then landed on no surface at all: the tree files the row
  under the closed project and then drops it, the archive it came from no longer
  lists it either, and the only note the flow had spoke about a different filter.
  The verb reported success and the screen showed nothing changing. It now names
  the project that is hiding the row and offers to reopen it, which reopens the
  closed parent as well when it was a parent that put the whole subtree away.
- **A project sharing a directory with another one had an empty archive.** Two
  projects are allowed to list the same directory, and a session there draws a
  row under both — but its *archive* was filed under only one of them, picked by
  an alphabetical tie-break. So one of the two said "Nothing archived" about a
  session whose row it had drawn a moment earlier, and renaming the other
  project silently moved the whole archive across. Both the archive and the chat
  history now list a session under every project that claims its directory, the
  way the rows always have. Nesting is unaffected: a project rooted deeper still
  takes those sessions outright.
- **A fork of a closed row that had no name of its own was named after the
  conversation's opening words — on its terminal tab, and for good.** A closed
  session with no title anywhere now shows its first prompt in quotation marks
  instead of eight hex digits, and the quotes are what say "nobody chose this".
  A terminal tab has no quotes and no row around it, so that string never
  reaches one: the resume path already refused it. Fork did not. Forking such a
  row put `“I want to post this on linkedIn, help me write it” 2` on a tab
  beside your real ones and, worse, wrote it into the new session's record as a
  chosen title — which is where every later tab name and workspace restore reads
  from, so the refusal was defeated permanently rather than for one launch. A
  fork of a row like that is now named after the **checkout it opens in** — `app
  2`, the same name a brand-new session in that directory is offered. Not the
  short id: a bare hex name is precisely what the naming work in this release
  exists to remove, and reintroducing it through the fork verb would have been
  undoing that by another road. The same rule now applies to the two other
  places a fork gets named, the agent-requested fork and the adoption of a
  native `/fork` background job.
- **Closing a session took the branch name out of the native tree altogether.**
  With `lineage.git.branchDisplay` set to `inline`, a live row says which
  checkout it is on and a closed row does not — that is the one-row compaction
  that makes leaving "Show Closed Sessions Too" on all day comfortable, and the
  inline sidebar pays for it by keeping the fact in the row's hover. The native
  tree's hover had never carried a branch line at all, so on that surface the
  compaction removed the only place the branch was ever named and closing a
  session lost the fact. Both hovers now say `branch: …`, on live and closed
  rows alike, next to the working directory — which is not the same answer: a
  worktree directory is usually named after the task, and a plain checkout that
  has changed branches is the same path either way.
- **With sessions grouped by branch, the native tree said the branch name
  twice.** Under `lineage.groupSessionsByBranch` a session hangs off a branch
  row that already names the checkout, one line up and in bigger type, and the
  session's own description repeated it. It is now silent there, for the same
  reason a fork that stayed in its parent's checkout is silent — but only where
  it is genuinely a repetition. A fork living in a *different* worktree nests
  under its parent, so the row above it names the wrong checkout, and that row
  keeps its branch name. (The inline sidebar suppresses the branch on every row
  while grouping is on, including that one, and so loses the fact on the one row
  where it matters; that surface is the one to relax next.)
- **Move to Account was a permanent dead end for any conversation whose id
  existed in two accounts — and Flock was reading the wrong one of the two.**
  Three real conversations on the author's own machine were in this state, so
  none of this is theoretical. The module that moves a transcript between
  accounts states an invariant at the top of the file — exactly one
  `<id>.jsonl` on the machine at a time — and then checked only the single path
  it was about to write, which is a much narrower question. A copy of the id
  filed under a different project slug in the destination account was therefore
  no obstacle at all: the rename landed beside it and one account ended up
  holding two files named after one conversation. Different slugs are not
  exotic — the slug encodes the working directory, so resuming a conversation
  from a git worktree of its own repo produces a second one. The guard now asks
  the whole destination account.
  Once two copies existed, everything downstream picked between them by
  **account order**, which is to say by an accident of how the roster happened
  to sort. On this machine that meant a nine-line stub of hook records beat a
  12 MB conversation, and two archived rows were being drawn from the stub —
  no working directory to show in the archive browser, no opening prompt to
  take a name from, and a resume that would have found none of the
  conversation. Both the transcript resolver and the transcript index now
  prefer the copy that was **written most recently**, and fall back to the
  larger only when the two were written in the same instant. Newest rather than
  biggest on purpose: size is a proxy for "has more conversation in it" and it
  gets the one case that matters backwards, since a transcript the CLI rewrote
  shorter is still the file a resume would continue.
  The refusal also used to arrive **after** the CLI had been killed and
  restarted, so a user spent a turn in flight to be told about a path — and
  then spent another the next time, because nothing about the situation had
  changed. The collision is now found before anything is stopped, and the
  refusal comes with a way out: it names both files with their sizes and dates
  and offers to **set the blocking copy aside**, which renames it to
  `<id>.jsonl.superseded-<stamp>` — a name no reader in Flock selects and one
  `mv` undoes. Nothing is deleted, because when two files claim one id, one of
  them is somebody's conversation and no heuristic in here is good enough to
  bet it on.
- **A move that put a conversation back after a refusal put it back on the
  wrong account.** The account a conversation is pinned to is a claim; the
  directory its transcript is actually in is a fact, and the mover deliberately
  looks past the claim to find the file. The restore path did not: it rebuilt
  the environment from the pin, so a conversation found in one account and
  pinned to another came back up with `CLAUDE_CONFIG_DIR` naming a directory
  that does not contain it, and `claude --resume` found nothing at all. It now
  restores into the directory the transcript was found in, and is byte-for-byte
  the old behaviour whenever the pin was right.
- **A move that moves nothing no longer kills and restarts Claude Code.** Two
  accounts can resolve to the same configuration directory — the default login
  and any provider without a config-directory variable both land on `~/.claude`,
  and the pair this extension seeds on a fresh machine is exactly that shape —
  so "move it there" can be a re-pin with no bytes behind it. The mover already
  knew, and said so one step too late: the process was stopped before the
  question was asked, so a change of label cost the turn in flight that the
  confirmation dialog warns about. That case is now decided before anything is
  stopped, and the dialog says what will actually happen instead of promising a
  cost nothing is going to take. The environments are compared and not just the
  directories, because two accounts can share a directory and still
  authenticate differently, and there the restart is the entire point.

- **Archive and Close missed the running process of a conversation that had
  re-minted its id — the row went away and the `claude` ran on.** This is the
  84-session incident in miniature, and it was live on the machine this was
  found on: three sessions in the private tmux server, unattached, one of them a
  `claude` 31 hours old holding 112 MB, every one of them behind a record that
  said `deleted: true` and still carried the wrap's name. The mechanism is a
  disagreement about *where* a claim lives. Parking a conversation stamps the
  grace deadline and the tmux name on whichever id was parked, and a successor
  generation deliberately does not inherit them — a `--resume` or a compaction
  mints a new id, so the claim stays on an older member of the chain while the
  ROW is the tip. Every close-shaped verb asked the tip's record alone and
  concluded there was nothing detached to end, while the kill itself has always
  searched the whole chain and would have found it. So the verbs now ask the
  wiring the same chain-wide question the kill asks — one probe, used by Archive,
  by the archive dialog, by Close and by Close Now, rather than four readings of
  a record that drift apart. Two copies of one question is what the bug was; a
  fifth reading is how it would come back.

- **The archive dialog and the archive itself now count the same closes.** The
  dialog asked one question about what was about to be ended and the action
  asked another, and they disagreed in both directions: the modal promised to
  close a session the action then declined to touch, and — worse — said nothing
  at all about one it went on to kill. A dialog that undercounts is worse than no
  dialog, because the honest asymmetry between Close and Archive is the only
  thing it exists to say. There is now one pure planner, computed before
  anything is written and handed to the act, so the sentence you are asked to
  agree to is produced by the code that does the work.

- **A running process with no row of its own now gets one, instead of only a
  number.** The container badge counts every live process this machine is paying
  for, which is the levels invariant expressed as a number — the incident this
  design answers was 84 detached sessions that no surface anywhere counted. But
  an archived record whose process the roster still reports has no row at all:
  the badge said 6 with four rows on screen here, and one of the two missing
  sessions had been in that state for four days. The tempting fix is to stop
  counting it, and it is the wrong one — that deletes the only on-screen
  evidence of exactly the leak the two entries above describe. So the rescue is a
  row: a live session the rendered tree never draws joins the collapsed **Still
  running** group at the bottom, in both view styles, where it can be seen and
  closed. Same scope fence as the badge, so the number and the rows agree.

- **Close with Summary no longer re-closes a session something else closed while
  it was compacting.** The compaction takes one to three minutes, and in that
  window the idle sweep, another Flock window, or your own Close Now can end the
  same session. The summary then arrived and the close ran regardless: the
  original close time was overwritten with a stamp up to two minutes later, a
  tab that no longer existed was asked to dispose itself, and a session archived
  during the wait acquired a fresh close stamp on top of its archived record. The
  record is now re-read when the compaction lands, and a session that is already
  over is given the words it earned and nothing else — no second close stamp, no
  disposal, no warning about a session that was not running.

- **"Restore" stopped telling you to turn off a filter to see a row that was
  already on screen.** The note exists for a real case — restoring a closed
  session while **Show Only Active Sessions** is on puts its row back into a tree
  that is not showing closed rows — but it asked only how the filter was set,
  never whether the row it had just restored was one the filter hides. Restoring
  an archived session that is still RUNNING gets its row back immediately, and
  being told to turn off a filter for a row the tree has just scrolled to is
  advice about nothing. It now speaks only for the rows that are genuinely
  hidden.

- **A window opened on part of a project showed no sessions at all — the badge
  counted them and the tree drew nothing.** This is the commonest window there
  is: folder mode is the default, and the folder a window opens on is very often
  a subdirectory of a project (`~/app/api`) or one of its linked worktrees
  rather than the project root. The fence that had just been taught to keep
  other projects' rows out of such a window asked whether the project's
  directory was *inside* the folder the window had open, which is the wrong way
  round — the project's directory **contains** that folder, and a worktree
  checkout beside the repository is not inside it either. So the project row was
  fenced out; and because sessions are filed into buckets belonging to the rows
  that survived, every session in the folder the window was actually looking at
  had nowhere to go and was dropped without being counted anywhere. The sidebar
  was empty while the container badge said one session was running.
  A window opened on part of a project is that project's window: containment now
  counts in either direction, and a project's worktree reach — which is already
  what decides that a session in `~/app-feat-x` belongs to the project at
  `~/app` — is read by the fence out of the same list that files the sessions,
  so the two can no longer disagree. Underneath, the filing loop no longer
  believes it has placed a session when the bucket it aimed at does not exist:
  an unplaceable session is counted and, while it is still running, keeps its
  row under "Still running". That last part is unreachable with the fence
  corrected, and it stays in anyway, because the next fence should fail loudly
  rather than silently.

- **"Move to Account…" was offered where it could not work, and worked where
  it should have refused.** Axel: *"the switch, like 'move session to a new
  account', is also very inconsistent."* It was, in four separate ways, and
  they had one shape in common: the verb was built out of layers that each
  asked a slightly different question, and the answers had stopped lining up.
  The one you actually saw is the menu. The entry was drawn whenever two
  accounts could *host* a session, and `codex` joined that list the day the
  launcher learned to run it — while the picker behind the entry only ever
  accepted accounts on the same CLI. So on the roster Flock seeds by itself,
  one Claude login plus a Codex one, the verb sat on every session row and the
  picker was always empty. The menu now asks the same question the picker
  does, out of the same function, and the row itself says which CLI wrote the
  conversation so a Codex row is not offered a move Flock has never known how
  to make.
  The one you could not see was worse. Moving a wrapped conversation restarts
  it in its tmux pane, and a respawn can only *set* environment variables,
  never remove them — so moving a session back to the default login, whose
  environment names no config directory at all, left the previous account's
  `CLAUDE_CONFIG_DIR` sitting in the pane, and the resumed `claude --resume`
  went looking in the account the transcript had just left. The switch now
  clears what the destination does not set, before the respawn rather than
  after it, because the new process takes its environment at the moment it
  spawns. The same leak had a second door: Flock's private tmux server keeps
  the environment of the first client that forks it, so the first wrapped
  session started on a custom account put that account's config directory into
  the server's global environment and every later session inherited it, with
  no verb used at all. The tmux conf now removes those names globally; a
  session that passes its own still wins. A server already running keeps the
  conf it started with, so that half takes effect when it next exits — which,
  with `exit-empty`, is when its last session goes.
  Two refusals were missing and one was arriving too late. A session running
  under *another Flock window* was allowed straight through: with tmux off, or
  on Windows where the wrap does not exist, nothing was stopped, the transcript
  was renamed under a live CLI, and the result still reported a clean in-place
  move. It is refused now — but only where the refusal is true. "Flock's, but
  not this window's" covers two situations with opposite answers: a
  conversation parked into the private tmux server by a workspace switch can
  be respawned from here perfectly well and still moves, while one whose tab
  another window holds with no wrap around it cannot be stopped from here at
  all, and that is the one that is now named and refused. A Codex conversation started in a
  terminal has no account pin, and the CLI gate read the pin — so it passed,
  and was then told by the transcript check that it "has not taken a turn
  yet", which was the one sentence that gate existed to prevent; the gate now
  reads the conversation. And a conversation whose pin had come apart from its
  file — which the environment leak above actively produced — was stopped and
  restarted *before* being told there was nothing in the account it was pinned
  to. Flock now finds the transcript first, in any account on the machine, so
  a refusal costs nothing and a pin that is merely wrong no longer strands a
  conversation that is sitting one directory over.
  Three smaller things fell out of the same pass. The result now distinguishes
  "it is in a new terminal" from "there is no terminal" and from "we could not
  find the process", instead of reporting the last two as the first and the
  second — a switch that produced no terminal used to send you looking for a
  tab that was not there. A move between two custom accounts seeds the
  destination from the account being left as well as from the machine's own
  configuration, so a folder only the source account had ever trusted does not
  greet the resumed conversation with a trust dialog. And removing an account
  no longer hides the conversations inside it: the tombstone keeps the
  directory, which stays readable, so a session moved onto an account that was
  later deleted still finds its transcript — the removal dialog has been
  promising exactly that.
  One menu-slot fix, because it is the same complaint: **Move to Account…** and
  **Move to Lane** were both contributed at `1_actions@3`, and **Close Now** and
  **Close Session** both at `2_close@1`, which leaves the order two verbs come
  out in to contribution accident. Each has its own slot now, and a test walks
  every row shape a menu can be opened on — session, project, subproject, branch
  and the two headers — to make sure no two entries land in one slot on one row,
  while leaving the seventeen places where different KINDS of row correctly share
  one.

- **Closing or archiving a session in the middle of a tree moved the forks
  under it.** Axel: *"the trees get weird when you do stuff to them — like when
  you close one in the middle, that's pretty weird."* He was right, and it was
  worth finding out precisely what was weird: the pass that decides WHICH rows
  survive is sound — 4000 randomised forests, checked against an independently
  written model, produced no duplicate row, no lost session, no row at the
  wrong depth and no orphan. What was wrong was WHERE the survivors land.
  Promotion — the rule that keeps a live fork on screen when the row above it
  goes away — was a splice: the fork inherited the slot its now-invisible
  parent held, so the position of a running session was decided by the sort key
  of a row nobody can see. Archive a session with a fork under it and the fork
  visibly moved down past a sibling, though nothing about it had changed; with
  **Show Only Active Sessions** on there was not even a row left on screen to
  explain the move. The visible list is now re-keyed with the same comparator
  the sibling list uses, so a promoted fork merges back in among the siblings it
  now genuinely stands with. Nothing structural changed — lineage, edges and
  the parent chain are untouched; this is the picture agreeing with the
  structure rather than a second opinion about it.
  Second half of the same bug: the sibling comparator demoted *archived* rows
  below the live ones but said nothing about **ghosts** — the inferred
  *(gone)* ancestors Flock mints when a fork names a parent it cannot produce a
  row for. A ghost has no roster entry, therefore no start time, therefore fell
  through to the "unknown time sorts last" branch and landed as the last LIVE
  sibling: above every genuinely closed session, which is exactly backwards for
  a row that is by construction the ancestor of something already finished. And
  it was that missing arm which put the ghost of a just-archived session in the
  slot the promoted fork then inherited. Both the comparator and the two
  renderers now ask one shared `sessionIsOver` predicate, so "is this
  conversation over" cannot be answered two ways in one tick.

- **Archiving a session that was still running left the process alive with no
  row anywhere.** The verb only ever ended a session whose row was a grace
  countdown, because that was the case somebody had thought about: a detached
  process whose tab is gone by definition, so its row is its last surface. A
  session with a TAB claims no detached process, so the check said no and the
  flag was written straight over a live `claude` — the row left the tree, the
  process carried on writing its transcript, the container badge went on
  counting it, and because every verb's picker skips archived rows the user
  could not even close the thing they had just archived. Restore was the only
  door back. That is the running-and-shown-nowhere state this whole design
  exists to make unrepresentable, fixed for one shape of row and missed for the
  other. Archive now means close-then-hide: the tab is disposed, or the
  detached process is reaped, and only then does the row go — the same
  before-the-flag order the grace row already had. What it refuses rather than
  forces is every shape of "this window cannot end it": a session another live
  Flock window is running (usually a racing restore, where that window has
  already bound the tab but not yet cleared the grace claim), a `claude` outside
  Flock entirely, and — the third arm, added after the first fix was found to
  leave a hole — a session that is **ours** and live but has neither a tab here
  nor a detached claim to kill through, which is what a conversation Flock
  launched looks like once its tab has gone and it is running somewhere this
  window cannot see. Killing the first two would end a conversation someone is
  looking at; writing the flag over the third orphaned it exactly as the bug
  above did, silently, with the dialog saying nothing. So it names what it is
  skipping, and writes nothing.

- **A closed session that nobody named showed a hex id instead of a name.** The
  archived label chain ended at the eight-character short id, and on a real
  machine it ended there constantly: of the 278 transcripts under
  `~/.claude/projects` here, 198 — 71.2% — rendered as a bare code. Next to that
  code sat the transcript-tail scrape, which is why the row read as its own last
  prompt rather than as a session. The chain now has two more steps, both read
  from the bounded transcript head `src/archive.ts` was already reading. First
  the CLI's own generated title (its `ai-title` record): present in 154 of those
  278 files inside the existing window, shown as an ordinary name because it is
  a genuine title of that conversation and the thing it replaces is a hex id,
  and safe to take first-wins because 144 files re-emit it — up to 138 times —
  and not one ever contradicts itself. Then the conversation's opening prompt, in
  typographic quotes: a QUOTATION, never a title, filtered so that tool results,
  injected preambles, sub-agent turns, compaction continuations and
  `<bash-input>` echoes cannot become a name, and refused outright as a terminal
  tab title, where `“cd ..”` would be worse than the CLI's own `claude ·
  1a2b3c4d`. The fall-through to a hex id drops from 71.2% to 6.8%, and a cold
  scan of all 278 transcripts costs 6 ms more (61 → 67 ms) because the head
  bytes were already being read. The `(mtimeMs, size)` cache is untouched: the
  new facts come from the same bytes as the old ones, and the existing
  live-at-scan rule already forces the one re-read that matters — the first scan
  after a running session stops, which is exactly when its generated title
  becomes readable.

- **Worktree membership is now asked the same way everywhere.** A session running
  in a linked checkout — `~/app-feat-x`, a worktree of the repository at
  `~/app` — belongs to the project rooted at `~/app` without anybody registering
  that path, and for a while only the sidebar's grouping knew it. Every other
  surface asked the same question without worktree reach and got `null`:
  focus-follows-project did not follow you into a worktree, the Explorer did not
  re-root there, the provider glyph fell back to the default beside a row filed
  under a project set to something else, and the project's unseen dot stayed
  dark. All five now go through one resolver (`projects.projectReach`).
- **The Explorer no longer re-roots on the strength of the wrong claimant.**
  Claims are plural and their order is a stable alphabetical tie-break, so a
  directory listed by two projects reported the alphabetical winner — and asking
  for that head meant that working in a shared directory of the project you were
  switched INTO re-rooted the file tree at that project's main folder, because
  the head named the other one and a foreign match reads as "no answer".
- **The Project header's "showing" mark cannot point at a root that is not
  there.** It was recomputed from where the active session is; when the front
  conversation belonged to none of the project's directories the follow listener
  correctly left the tree alone while the recomputed mark moved to the main
  directory on its own. It is now read back off the live folder list.
- **The Project header's session count agrees with the rows beneath it.** It
  counted only the tie-break's winner, so a twice-claimed session drew a row
  under both projects and was counted for one.

- **Opening a chat no longer hijacks the solo pin.** With `lineage.soloSession`
  on, asking a side question about the session you were working in parked that
  very session and pinned the chat in its place — the cheapest object in the
  extension evicting the most important one. A chat is now a normal tab, never
  the solo tab: it opens beside the pinned session, reopening one from **Chat
  History…** does the same, and solo mode's sweep never parks a chat either —
  a chat's tab lifecycle is the auto-close window above, not the pin.
- **A conversation routed to an account the Claude Code extension cannot host
  is no longer handed to it.** In `lineage.launch.mode: claudeExtension`, a
  new session was delegated before routing was consulted — so a project routed
  to a Codex account, or to a Claude account with its own config directory,
  opened in the extension on the machine's default login, silently ignoring
  the routing (and, with a config directory, writing the transcript where that
  account's next resume would never look). Routing now resolves first, and a
  launch the extension cannot host — another provider's CLI, or an account
  with its own environment — opens in Flock's own terminal with a status-bar
  note saying why. A launch routed nowhere, or to the default login, delegates
  exactly as before, and an account picked by hand still overrides the mode
  outright. The rule is pure and tested (`delegateRefusal`, `src/hosts.ts`).
- **Move to Account… is on the session row's right-click in the default view
  too.** The verb was contributed to the native tree's menu only, and the
  default `lineage.viewStyle` is `inline` — so on a default install the row
  menu never offered it and the only way to a move was the Command Palette.
  The inline view now carries the same entry, in the same slot and behind the
  same gate as the native one — which is a narrower gate than it was when this
  line was first written, and the entry above says why.

- **Every project row was drawing two verbs in one slot.** **Add Session to
  Project** and **New Worktree** were both contributed at `0_open@4`, in both
  sidebars, so with the branch rows on the order they came out in was decided by
  which entry happened to be listed first in the manifest rather than by anybody.
  This is the same defect as the Move to Account / Move to Lane collision above
  and it had been shipping for longer; it survived the guard that caught that one
  because the guard modelled SESSION rows only. That was reasonable when it was
  written — a session row was where the bug had been found — and it went stale
  the moment this round started adding verbs to project rows. The guard now walks
  every row shape a context menu can open on: session, project, subproject,
  branch, and the two header rows, each built from the same function the two
  sidebars build them with rather than from a list of tokens someone typed out.
  New Worktree moves to `0_open@5` and **Archived Sessions…** to `0_open@6`,
  which keeps the project menu reading in the order it always did.

- **The two triples had one set of words between them, and now have two.** This
  release renamed the session lifecycle's third state to *Archived* and named the
  three window models at the same time, and three separate pieces of work each
  arrived wanting to write their own note explaining which "three" was which.
  There is now exactly one, at the top of `design/levels-and-modes.md`, and it
  says both halves plainly: the **levels 1 / 2 / 3** that document argues about
  are the session lifecycle, whose user-facing words are **Open**, **Closed** and
  **Archived**; the **window models** are a different triple entirely —
  `folder` / `root` / `project`, labelled *One folder per project* / *Root (Flock only)*
  / *Auto-switch* — and they are never numbered in anything a person reads,
  because somebody who has learned that level 3 means Archived would read "level 3
  window" as a window that had been put away. The documents were then swept
  against it, which turned up four places that had been quietly saying the old
  thing: a level-2 row was still called an *archived row* in the reference and in
  two settings descriptions, where after this release that word means the row is
  gone from the tree; the reference still said a close-with-summary is *recorded
  on the row*, which is exactly the thing that came off the row in this release
  and moved to the hover; the Workspaces chapter still opened by describing
  auto-switch as what a window does *by default*, which stopped being true when
  the default became one folder per project; and the count of settings that ship
  off had gone from seventeen to sixteen with the demo project's removal and back
  to seventeen with `lineage.fork.notifyParent`, without the second half being
  written down. The settings and command counts were recomputed from the manifest
  rather than from each other: **48 settings, 93 commands.**

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
