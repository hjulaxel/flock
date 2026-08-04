# Changelog

All notable changes to Flock are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

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

### Fixed

- **Resume no longer risks a second writer on a transcript Flock cannot see.** A
  row reads as closed whenever the roster does not carry it, which is also what a
  session running under a config directory no configured account names looks
  like. A transcript written to *after* the moment Flock recorded the session
  closed now asks before resuming, rather than starting a second Claude on it.
  The ordinary close-then-reopen is unaffected.

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
