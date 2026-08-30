# Levels & Modes — implementation spec

Authoritative design from the 2026-08-22/23 sessions with Axel. Where this
conflicts with older comments in the code, THIS document wins.

## Read this first — two triples, and only one of them is "levels"

This document describes two unrelated three-valued things, and the 2026-08-28
review found three people about to write three different notes about it. So it
is settled here, once, and the rest of the document and the whole UI obey it.

**The session lifecycle** is the triple this document calls **levels 1 / 2 / 3**
— running, ended-but-on-the-tree, and off-the-tree. "Level" is an internal word
for the state machine; the words a person sees are **Open**, **Closed** and
**Archived**, and those are the only ones that may appear in a menu title, a
modal, a status message or the README. Level 3 took the name *Archived* in this
review because Axel is right that deleting and closing are different acts, and
because `archive.ts` — which indexes the transcripts of levels 2 AND 3 alike —
was never about level 3 in the first place. Its comments now say *the transcript
index* so the collision stops biting. The `deleted` field on `EditorialRecord`
keeps its name deliberately: it is on real users' disks with migration rules in
`state.sanitizeRecord` behind it, and a churn-only rename buys a word nobody
outside this repository ever reads.

**The window models** are a different triple entirely, and they are NOT levels.
They are the values of `lineage.mode` — `folder` / `root` / `project`, labelled
**One folder per project** / **Root (Flock only)** / **Auto-switch** — and they answer
"what is this window for", not "what state is this conversation in". They are
never called "level N" in anything a user reads; Axel numbered them out loud when
he described them, and that numbering is deliberately not carried into the
product, because a person who has learned that level 3 means Archived would read
"level 3 window" as a window that had been put away.

The two triples are orthogonal: every window model shows Open, Closed and
Archived sessions, and every lifecycle state exists in every window model.

## Background — why this exists

Incident: 84 detached tmux sessions (the `parked` state written by
workspaces.ts) accumulated over 4 days. Each claude process held ~390 MB and
spawned ~8 MCP-server children (`uv run … ai-builder`, npm mcp-server) —
~670 processes, 32.6 GB of demand on a 24 GB machine, swap at 42 GB, load 119.
Root cause: the workspace switch PARKS sessions — an invisible, unbounded,
RUNNING state with no tree row, no cap, and no reaper. (`MAX_AUTO_RESUME = 8`
caps restore, so most parked sessions paid full memory cost for a re-attach
the cap forbade.)

Two principles, adopted as invariants:

1. **The transcript is the session; the process is a warm cache over it.**
   (resumeLeaf.ts makes `--resume` faithful; archive.ts indexes transcripts
   in ~0.9 ms each.)
2. **No running process without a visible row, and navigation never mutates
   lifecycle.** Invisible states rot; visible states self-regulate.

   *Amended after the first build shipped* — see "The strict fence" below. The
   invariant is scoped to the window that OWNS the work: no running process
   without a row **in the window whose folder it is in**. A window is not
   required to report other folders' processes, because the folder-mode rules
   below make it impossible for another folder to have any while no window has
   it open. Reachability, not reporting, is what keeps the invariant.

### The strict fence (supersedes the machine-wide appendix)

Folder mode shows **only the folder you opened**. An out-of-scope session gets
no row at all — running or not, no "Running elsewhere" appendix. To work on
another project you open its folder in its own window.

The reasoning, in order:

1. A row you cannot act on is not visibility. Folder mode has no verb that
   reaches another folder, so a foreign row could only ever be a refusal.
2. So the state must be made **unreachable rather than reported**. Three
   things do that together:
   - the **launch fence** — `extension.ts`'s `launchSession` dep refuses any
     `cwd` outside the window's folders. Every create and resume path funnels
     through it, so this is a property of the extension, not of however many
     verbs remembered to ask;
   - **window close ends the folder's sessions** (see the reload grace);
   - the **activation reconcile** kills any `-L lineage` session no live window
     covers, which is the only backstop a force-quit leaves.
3. The appendix group survives, renamed **"Still running"**, for what it was
   always actually for: work **inside** this window's scope that the user's own
   filter (hidden folder, closed project, `onlyProjectSessions`) would hide.
   That is a view *preference* and may not hide a live process. The scope fence
   is a *boundary* and may. Every member of the group has working verbs.
4. The running **badge is window-scoped** for the same reason — a count with no
   rows behind it is the same defect pointing the other way.

Two leaks this closed, both found by running the first build:

- `routeForeign` was wired to the **resume** path only, so the whole
  new-session family (project, directory, branch, worktree, subproject) could
  launch into another folder from a folder-mode window. Observed: a BASALT
  session running inside a `lineage-sessions` window with no row for it. Fixed
  by moving the fence to `launchSession`. `routeForeign` stays — it is how a
  cross-folder notification takes you to the right window.
- `lineage.soloSession` called `workspaceManager.parkOthers`, the switcher's
  own park, and so stamped `stowedBySwitch` in a mode with no switch to redeem
  it. Solo now passes `{ stow: mode === 'project' }`.

## The three levels

| Level | User-facing word | Process | UI | Meaning |
|---|---|---|---|---|
| 1 | **Open** | running | shown (tab and/or live tree row) | active work |
| 2 | **Closed** | none | shown, as exactly one closed tree row | "might return later"; click = resume |
| 3 | **Archived** | none | no row (`deleted: true`) | the row is off the tree; the transcript remains; **Archived Sessions…** on the project row and **Restore Archived Session…** bring it back |

The state RUNNING + NOT SHOWN (`parked`) becomes **unrepresentable**. Level 2
already exists as closed rows (archive.ts → viewmodel.ts's `archived` context
token → tree.ts click-to-resume; the token is internal and predates the
vocabulary note above, which is why the row it draws is a *Closed* one). Level 3
already exists (`deleted` on EditorialRecord). Level 1's auto-close and the
removal of `parked` are the new work.

Transitions:
- **timer** (the only automatic 1→2): idle for `lineage.session.closeAfterMinutes`
  (default 4320 — three days; 0 disables) → close to level 2.
- **user verbs**: 2→1 resume; 1→2 close now; 2→3 archive (which performs the
  1→2 close itself when the session is still running, so no verb ever writes
  level 3 over a live process); 3→2 restore.
- **navigation (switch, window close, project change): never changes level.**

Level-1 protections (generalize chatAutoClose.ts's rules, they are correct):
- never the active tab;
- never a BUSY or WAITING session — instead mark it *close-after-this-turn*
  (a queue, not a state; the sweep closes it once idle);
- a per-session **keep-awake pin** exempts a session from the timer entirely
  (for long autonomous runs). A pinned session is still level 1 with a
  visible row.
- Idleness source: the NEWER of the last real transcript record timestamp and
  the last user TOUCH (`EditorialRecord.touchedAt` — the row clicked, the tab
  focused, the terminal revealed), with roster status on top as the busy gate.
  NOT file mtime (files get touched by hooks/last-prompt writes without new
  content; measured on this machine).
  The touch half was added because the record half alone answers the wrong
  question: it measures what the CONVERSATION did, and a session you open,
  read and leave open is one you are using without the model saying a word.
  Folded by `idleClose.lastEngagementMs`; written coalesced
  (`idleClose.TOUCH_COALESCE_MS`, 60 s), because every tab switch is a touch
  and a touch is a locked read-merge-write of state.json.
  What this deliberately does NOT change: the age the tree shows on a row is
  still "when this last got an answer". Two clocks, two readers — only one of
  them closes anything.

### Detach grace — the one sanctioned transient

Closing a tab (including during a project-mode switch) MAY leave the process
alive-but-detached for `lineage.session.detachGraceMinutes` (default 10) so
re-attach is instant. Constraints that make this safe:
- the session MUST keep its tree row, with its grace verbs (Close Now / Keep
  Awake) and its place in the running-count badge, and the row's HOVER MUST say
  the deal and how long is left ("detached: tab closed, process kept for instant
  re-attach — closing in 9m, closes at …");
- the grace pool is capped (default 8); overflow closes oldest-idle first;
- at expiry, if idle → kill to level 2; if busy → close-after-turn.
This is the ONLY detached-running state, and it always renders.

The first constraint used to read "the tree row MUST show it distinctly, with a
countdown (e.g. 'closing in 9:41')". The countdown TEXT came off the row in the
2026-08-28 review, on Axel's judgement: shown the hover, he said *"oh wait, now
I actually see there is a hover state here, 'closing', yeah that's good then,
that's enough then."* What the constraint is really buying is the impossibility
of a running process with nothing on screen, and the ROW is what buys that — the
countdown was the price the spec happened to name, and the user is the authority
on that price. The cost is stated rather than hidden: a detached-running row is
now visually indistinguishable from a live idle one, and the hover is the only
place the difference is written.

### Reload grace — window close, and why it is not instant

`lineage.session.reloadGraceSeconds` (default 45, capped at 60). A closed
window's sessions **end**, at level 2: with the strict fence no other window
would show them, so surviving the window would mean running where nothing can
see them.

It is a short grace and not an immediate kill because **VS Code reports a
window RELOAD and a window CLOSE with the same terminal exit reason** and gives
the extension no way to distinguish them. A reload comes back and reattaches
within a second (the reattach clears the deadline); a close never does. The
grace *is* that measurement — not a park, not a reprieve. Hence seconds rather
than the detach grace's minutes.

Pinned sessions are **not** exempt any more. The pin means "the idle sweep must
not close me while I work", which is a promise about a window that exists; it
cannot mean "outlive every window", because there would be no row anywhere to
act on the survivor from.

## Mechanics

- **idleClose.ts** — new pure module generalizing chatAutoClose.ts (same
  shape: pure decision function; extension.ts wiring reads the world and
  acts). The 60 s sweep timer in extension.ts already exists; widen it.
- **Kill must reap the process TREE.** Each session spawns ~8 MCP children.
  Killing the claude pid orphans `uv` wrappers to PID 1. After killTmuxSession
  (tmux.ts) or terminal dispose, verify descendants exited; kill survivors by
  pid (walk the tree BEFORE killing the parent). NEVER kill by name pattern —
  other live sessions run identical server binaries.
- **Repair-on-close**: run the resumeLeaf.ts repair at the 1→2 transition
  (in addition to the existing on-resume-click path). Every level-2 row is
  then provably resumable at rest.
- **Migration** — STATE_SCHEMA_VERSION 7 → 8. On first load: every record
  with `parked: true` → kill its tmux session if alive (reaping children),
  clear `parked` + tmux name, flip the row to archived (closed timestamp).
  Existing users climb out of the hole by updating.
- **Reconcile on every activation**: compare `tmux -L lineage list-sessions`
  against state. Alive sessions no window claims and no grace covers → kill
  to level 2. Records naming dead tmux sessions → clear the name. (state.json
  on this machine claimed 157 tmux-named records; 78 processes existed.)
- **Tree**: two visual states — live / closed — plus a running-count badge on
  the view title. A detached-running row is deliberately NOT a third: it looks
  like a live idle row and says what it is in its hover (see the detach-grace
  note above for the trade). A CLOSED row is exactly ONE ROW: its name, its age,
  and nothing else — no branch sub-line, no branch name in the native
  description, whatever `lineage.git.branchDisplay` says. Its children still
  nest under it as normal; "one row" is about the row's own height, not about
  hiding a subtree. `EditorialRecord.summary` and the last-exchange snippet
  (archive.ts's bounded head/tail scan) are TOOLTIP ONLY: level 2 still answers
  "what did that branch conclude?" without resuming, but it answers it on hover,
  because a conclusion sitting beside the age is what pushed the session's own
  name off the row. The goal the whole rule serves is that leaving **Show Closed
  Sessions Too** on permanently has to be comfortable.
- **Naming a closed row**: a session nobody titled used to render as a bare hex
  short id — 198 of the 278 transcripts on Axel's machine, 71.2%. The chain now
  falls through the CLI's own generated `ai-title` record (shown as an ordinary
  name; it is a real title of that conversation) and then the conversation's
  opening prompt in typographic quotes (a quotation, never a title — and refused
  as a terminal-tab name), leaving 6.8% on the short id.

## The three window models

Setting `lineage.mode`: `"folder" | "root" | "project"`, default `"folder"`.
The user-facing labels are **One folder per project** / **Flock only** /
**Auto-switch**, in that order; the values are never shown to a person and never
called "level N", because "level" belongs to the session lifecycle above.
(Naming: Axel said "workflow mode" once and "project mode" twice; the canonical
identifier stays **project** — keep "workflow" out of identifiers. The label
changed to *Auto-switch* and the value deliberately did not: the string is in
users' settings.json, in the manifest's when-clauses, in the docs and in a
shipped VSIX, and its meaning never changed — only its neighbours did. `root`
was chosen over Axel's own word *root* because "root" is already three things
here — a workspace root, a repository root, the Flock anchor — and the value has
to answer the one question it is asked: whose window is this.)

**The third model was always here, spelled as a pair.** `mode: project` with the
older `lineage.workspaces.enabled: false` produced a window with no auto-switch,
no status-bar button and no scope fence — which is Flock-only exactly — but you
had to compute it from two keys to know that. `modes.resolveMode` folds that pair
once, on read, so the truth table becomes a value. Nobody is moved and nobody's
`settings.json` is rewritten; the deprecated key is retired only by the user's
own hand, through **Flock: Choose Window Model…**.

### One folder per project (`folder`) — native VS Code

- Window = the folder you opened. **No in-window project switching**: the switch
  verb refuses (with directions) and the workspace status-bar item is never
  drawn; workspaces.ts save/clear/restore never runs. The verb's own refusal is
  the gate, not `projectSwitchingOn` — see the note under Auto-switch.
- Tree scope: sessions whose cwd is under the opened folder, **grouped by
  owning project** — a directory may belong to SEVERAL projects (see mapping
  below), so one group per claiming project, plus an ungrouped remainder.
  Everything else gets **no row** (see "The strict fence").
- You cannot start or resume another folder's session here. The launch fence
  refuses it; the pickers that end in a launch don't offer it
  (`modes.launchableProjects`). No option that says no when clicked.
- **Cross-folder notifications still cross** — waiting, permission-blocked,
  finished. Following one routes to that project's WINDOW via windows.ts's
  published focus handle; if no window has it, offer
  `vscode.openFolder(…, { forceNewWindow: true })`. That is `routeForeign`, and
  it is the one sanctioned way another folder's work reaches you: it comes to
  you when it wants something, rather than sitting in your tree. Never switch
  in place.
- **Open Workspace for This Session** is the same journey started deliberately
  rather than by a notification: the row-level verb described under Flock only
  is available here too, and it is what "go to that project" means in this model
  when you are looking at a session rather than at a project row.
- Flock never touches file tabs in folder mode. Session tabs are governed by
  levels only.
- The Explorer follow is refused here outright, including the reload heal.
  `workspaceManager.activeProjectId()` lives in `context.workspaceState`, so a
  window that was once auto-switching still carries a project id after being set
  to folder mode; under `directory` scope a re-splice replaces the folder tail
  with ONE root, and this model's fence IS the live folder list — so a background
  re-splice would drag the fence and rows would vanish with nothing on screen to
  explain it.

### Root, i.e. Flock only (`root`) — the window is the sidebar

- No folder, nothing fenced, nothing scoped: the tree holds everything on the
  machine, which is what "we just have the root, where we only see Flock" means.
  You go to a piece of work by opening a window on it.
- **The switch verb stays.** In-window switching is available at both models
  that are not `folder`; what this one does not do is switch BY ITSELF, or
  advertise that it could. That distinction — not the verb — is the whole
  difference between this and Auto-switch, and it is why the status-bar item is
  gone here: `projectSwitchingOn` is the item's ONE gate, so it is drawn for the
  window that rearranges itself and for no other. (An unreleased version also
  drew it in folder mode whenever the line had a lane or a non-trunk branch to
  report. That was cut before shipping: the fact is worth saying, the Explorer's
  Project view already says it untruncated, and the condition was true for most
  real sessions — so what it produced was chrome that came and went as you moved
  between branches, in the models whose promise is that nothing moves unless you
  move it.)
- **Go to the workspace, per SESSION.** `lineage.openSessionWorkspace` — *Open
  Workspace for This Session* — on every live and closed row in both surfaces.
  It is `routeForeign`'s window offer made into a verb you can reach on purpose,
  one level down: the target is the session's worktree, else its lane's
  directory when that contains the session, else the directory its project
  claims. Every rung contains the session's cwd, because the new window's launch
  fence and grouping fence are both containment tests — a target that does not
  would open a window with no row for the session and no way to resume it. It
  raises a window that already covers the directory (this one included) rather
  than opening a second: two windows on one directory is two roosts for one
  piece of work. The verb is not gated on the model — the other two models want
  it too — but this is the model built around it.
- Solo mode still stamps `stowedBySwitch` here, because this model still has a
  switch that can redeem it. Only `folder` has none.

### Auto-switch (`project`) — the deep switch

- For users who live in ONE window spanning many projects/subprojects.
- **The one gate `modes.projectSwitchingOn` actually owns**: does this window
  rearrange itself without being asked? Two call sites — the focus-follows
  auto-switch and the workspace status-bar item. An earlier version of this
  document, and the comment in modes.ts that came from it, claimed the gate also
  hid "the switch verbs" and every workspaces.ts path. It never did; those are
  gated on the mode being `folder`. That overstatement is what made
  `workspaces.enabled` look like a master switch it never was.
- The switch stays transactional but must get DEEPER: switching to a
  (sub)project brings (a) its saved session/file tabs (existing restore path,
  MAX_AUTO_RESUME stays as the throttle), (b) its git context — reveal the
  branch/worktree tied to the subproject (revive the worktrees.ts machinery
  currently parked behind `lineage.git.branches`), (c) an explorer reveal of
  the subproject's folder.
- ~~HARD CONSTRAINT: never call `workspace.updateWorkspaceFolders`~~ — **this
  was wrong, and the code is the authority here rather than this document.**
  The API restarts the extension host in exactly two documented cases: when the
  FIRST workspace folder is added, removed or changed, and when an empty or
  single-folder workspace becomes multi-folder. Neither is a property of
  splicing as such, and `src/explorer.ts` is built entirely around avoiding
  both: the window runs a real multi-root workspace whose folder[0] is an empty
  anchor directory Flock owns and never touches, so the second case is gone at
  the first frame and the first is gone by construction — `planSplice` cannot
  express a splice below index 1, and `syncFolders` refuses outright if folder[0]
  has stopped being the anchor. That is what shipped, it is what makes the
  Explorer follow at all, and it is now also what makes SOURCE CONTROL follow:
  the built-in git extension opens a repository for every workspace folder that
  appears, so the splice moves both surfaces at once. The cost is one
  permanently visible root row, which is why it points at an empty directory.
  The constraint that IS real, and that the anchor exists to keep, is the one
  underneath: never splice at index 0. Read `src/explorer.ts`'s header for the
  argument in full.
- The switch NEVER parks: foreign sessions follow levels (the detach grace,
  then level 2 — the grace is a deadline, not a countdown on the row; see the
  detach-grace note above). Delete the park path from workspaces.ts CLEAR.

### Where am I — the mirror (built)

Project mode's promise is that the window follows you. The tabs, the Explorer's
folder tree and the sidebar's selection all move; none of them SAID so, and the
status bar named the project of the last SWITCH — the one fact still true after
everything else had moved on.

`src/whereami.ts` (pure) decides one answer from the conversation in FRONT
(switcher.frontSession), and two surfaces render it: the status-bar line and a
row in the Explorer's Project view. One decision, two renderings — a second
derivation is a second chance to disagree.

- It updates on FOCUS, not on switching. A move between two lanes of one project
  is not a switch (the auto-switch returns early, correctly — the project did not
  change), and it is most of the day for one-lane-per-worktree work.
- It reports a DISAGREEMENT rather than hiding it: window set up for A, keyboard
  in B, both names, and the click goes to B. A CLOSED project is skipped — putting
  one away removes its rows everywhere, and this must not become the one place it
  reappears.
- The branch appears only when it is not the one you would assume: a linked
  worktree, a detached HEAD, a lane's pin, or a name that is not a trunk name
  (`main`/`master`/`trunk`/`develop`/`default`). The main checkout of a repository
  sitting on a feature branch IS the interesting case; `main` on a checkout that
  has never left `main` is a segment that says nothing.
- An UNPLACED conversation (a directory no project claims) gets the project name
  and nothing else. Naming that directory's branch under this project's heading is
  a sentence nobody can act on — found by running the decision over real state.
- THE OTHER TWO MODELS get the half that applies: no workspace to name, so the
  line appears only when it carries a lane or a branch (`beyondTheFolder`), and
  its click jumps to the row rather than offering a switch that would refuse.
  Both, and for two different reasons — one folder per project has no in-window
  switching at all, and Flock-only has the verb but nothing that fires it, so a
  persistent button advertising one would be the very thing that model is
  defined by not having.

One ownership rule, everywhere. `matchProjects`' worktree reach (`extraDirs`) is
what makes a session in `~/app-feat-x` belong to the project at `~/app`. For a
while only `computeGrouping` passed it, so the sidebar filed such a session under
its project while every other question about it was asked without reach and
answered `null` — focus-follows did not follow into a worktree, the Explorer did
not re-root, the glyph fell back, the unseen dot stayed dark. `projects.projectReach`
is now the one resolver; membership is one rule or it is a bug.

### Directory ↔ project mapping (many-to-many)

One directory may be covered by several projects (e.g. worked on as a
subproject of two different projects). Projects gain explicit, NON-exclusive
directory claims; matchProject-derived membership maps a session to ALL
claiming projects for grouping. For single-project actions (where a new
session files), prefer the ACTIVE project in project mode; in folder mode,
most-recently-used claimant, asking only on genuine ambiguity. Extend the
existing `subprojects` state as needed.

## Non-goals / forbidden

- No SIGSTOP tier — it saves CPU, not memory, and memory is the constraint.
- No transcript deletion anywhere. Level 3 is view-level only.
- No hidden background processes — every running process has a row.
- Only the `-L lineage` socket; the user's own tmux is never touched.
- Do not add a heavyweight "hibernate/snapshot" system — level 2 IS the
  transcript.

## Verification bar

- Unit tests (vitest): idleClose decisions (active/busy/pinned exemptions,
  close-after-turn), migration sanitize (parked → archived), reconcile
  decision table, multi-project grouping, mode-gating of commands, grace-pool
  eviction order.
- `npm run typecheck` clean; `npm test` passes.
- The repo's idiom is rich narrative comments explaining WHY (see tmux.ts,
  resumeLeaf.ts headers) — match it. Pure decision modules stay vscode-free.
