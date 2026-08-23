# Levels & Modes — implementation spec

Authoritative design from the 2026-08-22/23 sessions with Axel. Where this
conflicts with older comments in the code, THIS document wins.

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

## The three levels

| Level | Process | UI | Meaning |
|---|---|---|---|
| 1 | running | shown (tab and/or live tree row) | active work |
| 2 | none | shown (archived tree row) | "might return later"; click = resume |
| 3 | none | no row (`deleted: true`) | removed from view; transcript remains; `restoreSession` brings it back |

The state RUNNING + NOT SHOWN (`parked`) becomes **unrepresentable**. Level 2
already exists as archived rows (archive.ts → viewmodel.ts 'archived' token →
tree.ts click-to-resume). Level 3 already exists (`deleted` on
EditorialRecord). Level 1's auto-close and the removal of `parked` are the new
work.

Transitions:
- **timer** (the only automatic 1→2): idle for `lineage.session.closeAfterMinutes`
  (default 30; 0 disables) → close to level 2.
- **user verbs**: 2→1 resume; 1→2 close now; 2→3 delete; 3→2 restore.
- **navigation (switch, window close, project change): never changes level.**

Level-1 protections (generalize chatAutoClose.ts's rules, they are correct):
- never the active tab;
- never a BUSY or WAITING session — instead mark it *close-after-this-turn*
  (a queue, not a state; the sweep closes it once idle);
- a per-session **keep-awake pin** exempts a session from the timer entirely
  (for long autonomous runs). A pinned session is still level 1 with a
  visible row.
- Idleness source: last real transcript record timestamp / roster status —
  NOT file mtime (files get touched by hooks/last-prompt writes without new
  content; measured on this machine).

### Detach grace — the one sanctioned transient

Closing a tab (including during a project-mode switch) MAY leave the process
alive-but-detached for `lineage.session.detachGraceMinutes` (default 10) so
re-attach is instant. Constraints that make this safe:
- the tree row MUST show it distinctly, with a countdown (e.g. "closing in 9:41");
- the grace pool is capped (default 8); overflow closes oldest-idle first;
- at expiry, if idle → kill to level 2; if busy → close-after-turn.
This is the ONLY detached-running state, and it always renders.

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
- **Tree**: three visual states — live / grace-countdown / archived — plus a
  running-count badge on the view title. Archived rows surface
  `EditorialRecord.summary` (else a last-exchange snippet via archive.ts's
  bounded head/tail scan) as description or tooltip, so level 2 answers
  "what did that branch conclude?" without resuming.

## The two modes

New setting `lineage.mode`: `"folder" | "project"`, default `"folder"`.
(Naming: Axel said "workflow mode" once and "project mode" twice; canonical
name is **project mode** — keep "workflow" out of identifiers.)

### Folder mode — native VS Code

- Window = the folder you opened. **No in-window project switching**: switch
  verbs and the workspace status-bar item are hidden; workspaces.ts
  save/clear/restore never runs.
- Tree scope: sessions whose cwd is under the opened folder, **grouped by
  owning project** — a directory may belong to SEVERAL projects (see mapping
  below), so one group per claiming project, plus an ungrouped remainder.
- A row belonging to another project (or a cross-project notification —
  waiting, permission-blocked, finished) routes to that project's WINDOW via
  windows.ts's published focus handle (built, measured); if no window has it,
  offer `vscode.openFolder(…, { forceNewWindow: true })`. Never switch in
  place.
- Flock never touches file tabs in folder mode. Session tabs are governed by
  levels only.

### Project mode — the deep switch

- For users who live in ONE window spanning many projects/subprojects.
- The switch stays transactional but must get DEEPER: switching to a
  (sub)project brings (a) its saved session/file tabs (existing restore path,
  MAX_AUTO_RESUME stays as the throttle), (b) its git context — reveal the
  branch/worktree tied to the subproject (revive the worktrees.ts machinery
  currently parked behind `lineage.git.branches`), (c) an explorer reveal of
  the subproject's folder.
- HARD CONSTRAINT: never call `workspace.updateWorkspaceFolders` — it
  restarts the extension host (documented in windows.ts). "Showing the
  folder" = explorer reveal + tabs, not workspace-folder mutation.
- The switch NEVER parks: foreign sessions follow levels (grace countdown,
  then level 2). Delete the park path from workspaces.ts CLEAR.

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
