# Proposal — Worktree sessions: one session, one checkout

**Status: implemented in 0.1.8, 2026-08-30, with one exception — §5.1's
`shared ×N` token was built, then withdrawn: first to a hover, then removed
entirely in 0.1.9. See the note at the end of that section for why.**
Written after the research pass on how the field (Claude Squad, workmux, dmux,
both cmuxes) binds sessions to branches. STATUS.md was at M26 when this was
written; this proposed M27–M29.

---

## 1. The problem, precisely

When several Flock sessions run in the same directory and someone runs
`git checkout` there, every one of those sessions "switches branch" at once —
because they were never on branches, they were in a directory, and a directory
has exactly one HEAD. The branch line under a session (`branchDisplay:
inline`) reports the checkout honestly; the surprise is that the checkout is
shared.

No tool fixes this in place. Every tool surveyed prevents it instead, with the
same invariant:

> **One session = one worktree = one branch, decided when the session starts.**

Flock already has every mechanism this needs — `git worktree add/remove` verbs,
branch rows, per-worktree status, tmux persistence, and even the setting that
makes `+` cut a worktree first (`lineage.git.newSessionInWorktree`). What is
missing is (a) that workflow being the promoted default, (b) any memory of
*which branches Flock created*, and (c) an honest end-of-life story for the
branch when the work is done. That is what M27–M29 add.

## 2. What the research settled

Three rules recur across Claude Squad, workmux, dmux and craigsc/cmux, and the
manaflow-cmux proposal (#3414) converges on the same ones:

1. **Pin at birth.** Isolation is decided at session start (cut worktree →
   launch inside it). Nobody migrates a running session; they make sharing
   impossible instead.
2. **The worktree is disposable; the branch is the work.** Claude Squad's
   pause deletes the directory and keeps the ref. Deleting the *ref* is the
   only destructive act.
3. **You only delete what you minted.** Claude Squad deletes a branch on kill
   *only if it created it* (`isExistingBranch` check); workmux/cmux delete only
   *after merge*. Nobody deletes a pre-existing branch, ever.

One convergent detail worth stealing: Claude Squad prefixes minted branches
with `{username}/`.

One detail worth *not* stealing: manaflow-cmux's proposal escrows abandoned
work to `cmux/abandoned/{ts}` before deleting. That escrow exists because
their cleanup is automatic. Flock's never is (see §6), and an unmerged minted
branch is simply *kept* — git already keeps the work; no shadow namespace
needed.

## 3. The invariant, in Flock's terms

A session's branch is the branch of its checkout — that stays true, and stays
derived (no per-session branch field; the cwd already answers). What changes is
that Flock stops treating a shared checkout as the normal place for a session
to start, and starts remembering which branches it minted so it can offer to
retire them.

Three things are **not** proposed, deliberately:

- **No migration.** A running session is never moved to another directory.
- **No blocking.** Flock never intercepts `git checkout` in a shared checkout —
  it is a read-only extension outside its two confirmed verbs. It *says* what
  is shared instead (§5.1).
- **No automatic deletion.** Every removal stays behind a user verb and a
  modal that quotes the exact command. Timers and polls still never write.

---

## 4. Backend

### M27 — a session gets its own floor

**4.1 The Show bundle flips the `+`.** Add
`{ key: gitNewSessionInWorktree, on: true, off: false }` to
`BRANCH_FEATURE_SWITCHES` (types.ts). **Flock: Show Branches and Worktrees**
then makes the project-row `+` cut a worktree first and start the session
there; **Hide** puts it back. The setting's own default stays `false` — the
palette verb is the opt-in, exactly as it is for the other five switches. The
ON receipt message gains a clause: "the `+` on a project row now creates a
worktree per session — right-click for a plain New Session."

*Rationale:* one-agent-per-checkout is why anyone turns the branch block on
(docs/settings.md says so already); making them find a second setting is a tax
on the main use.

**4.2 Branch prefix.** New setting `lineage.git.branchPrefix`, default `""`.
When the New-branch input opens (in `pickBranchForNewWorktree`), prefill the
box with the prefix. The Show bundle does not write this one — a name is a
preference, not a mode. Suggested personal value: `axel/`.

**4.3 Naming stays the user's.** No AI-generated branch names (dmux does this;
it is a different product's bet). The input box with a prefix and live
validation (`branchNameProblem`) is already the right amount of ceremony.

### M28 — retire the desk, and sometimes the work's name

**4.4 Provenance: the minted-branch record.** The one new piece of state.
Written once, in `newWorktreeFlow`, after a successful add **with
`create: true`** — never for a branch that already existed:

```ts
/** state.ts, persisted like editorial records, shared across windows. */
interface MintedBranchRecord {
  repo: string;      // pathKey(main worktree dir)
  branch: string;
  mintedAt: string;  // ISO
}
```

Read by exactly one consumer: the removal flow. Records whose branch no longer
exists in `for-each-ref` are pruned when that flow consults them (no timer).
A branch minted by another tool, or before this ships, simply has no record —
and therefore never gets a delete offer, which is the safe direction.

**4.5 The merged probe.** One new read, run only inside the removal verb
(a `warm`, never on the poll path), in worktrees.ts beside
`readLocalBranches`:

```
git rev-list --count <main>..<branch>     # 0 = merged; N = commits not on main
```

One spawn answers both the boolean and the sentence ("3 commits on it are not
on main"). Failure or timeout ⇒ `undefined` ⇒ no delete offer — a missing
probe can only make the verb more conservative, same contract as
`planWorktreeRemoval`'s missing status.

**4.6 Branch fate, as a pure decision.** New function in worktrees.ts, beside
`planWorktreeRemoval` and tested the same way:

```ts
interface BranchFate {
  offerDelete: boolean;   // show the second button at all
  sentence: string;       // what the dialog says about the branch
}
function planBranchFate(input: {
  minted: boolean;              // a MintedBranchRecord exists
  aheadOfMain: number | undefined;  // 4.5's answer; undefined = probe failed
  primary: boolean;
}): BranchFate
```

| minted | aheadOfMain | offer | sentence |
|---|---|---|---|
| no | — | no | `The branch "X" itself is kept — only the checkout goes away.` (today's text) |
| yes | `> 0` | no | `Flock created this branch, but 3 commits on it are not on main — the branch is kept.` |
| yes | `undefined` | no | today's text |
| yes | `0` | **yes** | `Flock created this branch and everything on it is on main.` |

**4.7 The removal dialog grows one button.** `removeWorktreeFlow` shows both
commands and, when `offerDelete`, both choices:

```
Remove the worktree for "axel/fix-login"?

git -C /Users/axelh/code/flock worktree remove -- …/flock-axel-fix-login
git -C /Users/axelh/code/flock branch -d axel/fix-login

Flock created this branch and everything on it is on main.

[Remove and Delete Branch]   [Remove Worktree Only]
```

Ordering: worktree first, then `branch -d` (git refuses to delete a
checked-out branch). **Always `-d`, never `-D`** — lowercase `-d` is git's own
gate on unmerged work, so even a wrong probe cannot destroy commits; if git
refuses, Flock shows git's words, the same contract as every other failure.
The dirty-checkout second confirmation is unchanged and still precedes any of
this.

**4.8 The delete-verb offer (the reverse direction).** When the user
**Delete**s a session (the one put-away verb) whose cwd sits in a minted,
non-primary worktree that now has no live sessions left, one non-modal toast:

```
"axel/fix-login" has no sessions left. Clean up its worktree?
[Clean Up…]  [Not Now]
```

**Clean Up…** routes into `removeWorktreeFlow` — same plan, same dialogs, no
shortcut. Fired only from the delete verb, never from close: a *closed*
session is still one click from resuming, and resuming needs its directory.
No timer, no poll, and "Not Now" costs nothing — the offer reappears only on
the next delete that empties a minted worktree.

### M29 — parked, on purpose

**4.9 Land Branch…** — the workmux `merge` verb: merge into main → remove
worktree → delete branch, one flow, three commands quoted, one confirmation
per destructive step. Parked because M28's pieces compose into it later and
because a *merge* is the first verb here that rewrites main — it deserves its
own proposal (fast-forward only? merge commit? what about a PR-based flow
where landing happens on GitHub and local cleanup is all that is left — which
the purple merged chip already detects?).

**4.10 Bootstrap hooks** — workmux copies `.env`, symlinks `node_modules`,
runs installs on worktree create; the first complaint after worktree-per-
session becomes the default will be "my dev server doesn't start there".
Parked: it is a per-project config surface and an arbitrary-command execution
surface, and it should not ride along on a lifecycle milestone.

---

## 5. Visual

### 5.1 The shared-checkout token (M27)

The one new mark, and the visible diagnosis of today's confusion. In
`branchDisplay: inline`, a session whose worktree hosts **two or more live
root sessions** appends a token to its branch line; `BranchInfo.rootIds`
already knows the answer, so this is a pure viewmodel change, no new probes:

```
FLOCK                                        ⊕ ⑂ ⚙
  ▾ flock                                    ⟳ +
      flock 3                                  ●
        ⇡ axel/top-bar * ↑2  #131 ✓
      flock 5
        ⇡ axel/fix-login ↑1
      flock 2                                  ●
        ⇡ main · shared ×2
      flock 4
        ⇡ main · shared ×2
```

Hover, both display modes (in `color` mode this is the only surface):

> 2 sessions share the checkout at ~/code/flock. A `git checkout` there
> changes the branch under all of them. New Worktree… gives each its own.

**WITHDRAWN. This section is the one part of the proposal that shipped and was
then taken back out** — the token in 0.1.8, the hover with it in 0.1.9. Both
were true and neither was news: how many sessions you start in one directory is
a choice you made, so the token spent width on every row of that checkout, and
the hover sentence spent the reader's attention, to report a decision back to
the person who took it. The rest of §5 stands. What the milestone was actually
for — a session getting its own checkout, and Remove Worktree counting who is
standing in one before it removes anything — is untouched, and both still
count `BranchInfo.rootIds` to do it.

The token draws only at ×2 and above — one session in the main worktree is the
normal quiet case and gets nothing.

### 5.2 The `+` tooltip (exists, reworded)

The tooltip already switches with `newSessionInWorktree`; with the bundle
flipping it, the wording carries the model: **"New Worktree… — a session in
its own checkout"** vs **"New Session — in the project directory"**.

### 5.3 The dialogs (M28)

Three variants of one dialog, differing only in the last line and the buttons
— mocked in full in §4.7. The minted-but-unmerged case:

```
Remove the worktree for "axel/spike-parser"?

git -C /Users/axelh/code/flock worktree remove -- …/flock-axel-spike-parser

Flock created this branch, but 3 commits on it are not on main — the
branch is kept.

[Remove Worktree]
```

And the not-minted case is today's dialog, byte for byte.

### 5.4 The cleanup toast (M28)

Non-modal, bottom-right, mocked in §4.8. It never stacks: at most one, for the
worktree the delete just emptied.

### 5.5 What deliberately does not change

No new tree rows (the sidebar is 250px wide and e5a0ead just took rows *out*),
no new colours, no badge on the project row. The branch rows, chips and purple
merged mark already carry the rest of the story — the purple chip's hover
("merged — this worktree can go") becomes literally actionable via Remove
Worktree's new button, which is the pay-off of reference.md's existing wording.

---

## 6. What is deliberately not built

- **No automatic anything.** No cleanup on a timer, no delete on session exit,
  no "stale worktree" sweeper. The write side stays two commands behind two
  verbs (worktrees.ts's opening comment is unchanged and still true) — plus
  `branch -d`, behind the same verb.
- **No `-D`, ever.** Flock never force-deletes a ref. The strongest thing it
  can do is ask git nicely, with the user watching the exact command.
- **No escrow namespace.** Unmerged minted branches are kept, not snapshotted
  to `flock/abandoned/…` — escrow compensates for auto-delete, which Flock
  does not do.
- **No per-session branch field.** Membership stays derived from cwd; the only
  new state is the minted-branch record, which is about the *repository*, not
  the session — modeled on how `subprojectId` was the only honest stamp for
  lanes.

## 7. Tests (same style as the 1193 that exist)

- `planBranchFate`: the full table in §4.6, plus `primary: true` refusing
  everything.
- Minted records: written only on `create: true`; pruned when the ref is gone;
  foreign-state tolerance (unknown fields survive a round-trip).
- `rev-list --count` parse: `0`, `N`, garbage, empty ⇒ `undefined`.
- Argv: `branch -d` (never `-D`), order worktree-remove-then-branch-delete,
  `--` placement.
- Toast trigger: fires on delete only (not close), only when live-session
  count in that worktree hits zero, only for minted non-primary worktrees.
- Shared token: drawn at ×2, absent at ×1, counts *live root* sessions only.

## 8. Open decisions (for Axel)

1. **How hard to promote the workflow?** This proposal flips the `+` via the
   Show bundle only. The stronger option — default `newSessionInWorktree:
   true` whenever `git.branches` is on — changes what a click does for
   existing users; the bundle route only changes it for people running the
   opt-in verb from now on. I recommend the bundle route.
2. **Prefix default.** `""` (proposed) or `"${username}/"` (Claude Squad's
   default)? The latter is friendlier for teams, but it writes a name nobody
   chose.
3. **Cleanup offer on close too?** Proposed: delete only. Close keeps the row
   resumable, and a resume needs its directory.
4. **Is M29 (Land Branch…) wanted soon?** If daily use lands work via GitHub
   PRs, the purple-chip + Remove-Worktree pair may be the whole story and M29
   can stay parked indefinitely.
