# Settings, tiers and the front door — design notes

Written 2026-09-05 from an audit of the 51 contributed settings on `main` at
0.1.10, and revised the same day after review — the decisions log at the end
records what changed and why. Where this conflicts with older comments in the
code, this document wins. Companion to `levels-and-modes.md`.

One rule sits above everything below: **Flock adapts what VS Code provides.**
The Settings editor, QuickPick, information and warning messages, the
walkthrough, `viewsWelcome`, TreeView and the status bar are the components.
Nothing in this plan builds a webview page, adds HTML/CSS/JS of its own, or
takes on a dependency. The one custom surface the repository already has — the
inline tree webview — stays exactly as it is and is not extended for settings.

## 1. What the audit measured

For every key in `contributes.configuration`: where it is read (module and
count), whether any verb or picker writes it, whether a `when` clause depends
on it, whether a test names it, and whether a change takes effect live or
needs a reload. Method: `scripts`-free grep over `src/` and `test/`, plus the
`onDidChangeConfiguration` handler in `extension.ts`.

Three facts fall out before any judgement:

- **Every description exists three times.** In `package.json`, in
  `docs/settings.md` (hand-maintained table of 51 rows), and, for the ones the
  checklist offers, in `media/walkthrough/setup.md`. The walkthrough even
  hard-codes "fifty-one settings and seventeen of them are off". Any change
  to a setting is three edits, and the counts go stale on the first removal.
- **Only two settings need a reload:** `viewStyle` and `explorer.scope`.
  Everything else is live. That is the property any settings surface depends
  on, the built-in editor included.
- **One toggle is paid for in code, not rows:** `viewStyle`. The native tree
  (`tree.ts`, 2048 lines, plus `decorations.ts`, 313) and the inline webview
  each implement every row feature, and the changelog shows the same fix
  landing on "both surfaces" again and again. §6 says what this plan does —
  and does not — decide about that.

## 2. Verdict per setting

Tiers are defined in §3. "Fold" means the key goes away and its meaning
survives inside another key. "Hardcode" means the default becomes the only
behaviour. Reads are per module, from the audit. Rows marked *kept on review*
carried a stronger verdict in the first draft; the decisions log says why each
was softened.

| Setting | Default | Reads | Verdict | Why |
| --- | --- | --- | --- | --- |
| `pollIntervalMs` | 3000 | extension | **Remove, hardcode 3000** — *done, step D* | Tuning knob nobody should turn; hooks make the poll a fallback anyway. |
| `claudeBinary` | `""` | extension | Advanced | The escape hatch for a PATH the extension host did not inherit. Named in the empty view. Keep. |
| `codexBinary` | `""` | extension | Advanced | Same, for Codex. Keep. |
| `tmux` | `auto` | tmux, extension, recommend, state, agentVerbs | Preferences (Sessions), Status line | The detach tier's off switch. The Status verb shows installed / missing beside it. |
| `exitToShell` | true | extension | Preferences (Sessions) | Taste, live, cheap. Keep. |
| `terminalLocation` | `editor` | extension, recommend | Onboarding picker + Preferences | Written by the surface picker. **Keep all three values** (*kept on review*): `newWindow` joins the picker as a fifth option in step E, so the picker can mark it current instead of the value being dropped for what the picker could not say. |
| `soloSession` | false | extension, commands, recommend | Onboarding picker + Preferences | Written by the surface picker. Keep. |
| `chat.autoCloseMinutes` | 1440 | extension | Advanced | Timing knob. Keep in json. |
| `session.closeAfterMinutes` | 4320 | extension | Preferences (Housekeeping) | Visible behaviour a person may want off. Keep. |
| `session.detachGraceMinutes` | 10 | extension | Advanced | Timing knob. |
| `session.reloadGraceSeconds` | 45 | extension | Advanced | Description already says "keep this low". |
| `fork.notifyParent` | false | extension | Preferences (Forking) | Taste with a real cost. Keep. |
| `close.summaryMode` | `compact-and-tell-parent` | extension | Preferences (Closing) | **Keep all four values** (*kept on review*). `ask-me` is not a leftover: it is the fallback every refusal in `closeWithCompaction` hands to — no transcript, no compaction, a timeout — so the value a person can choose is the behaviour they would get anyway, named honestly. |
| `launch.mode` | `flock` | extension, recommend | Onboarding picker + Preferences | Written by the surface picker. Keep. |
| `sessionSwitching` | `flock` | extension, one `when` | Advanced | Only matters with the Claude Code extension installed. Fold into `launch.mode` later if it never grows a third value. |
| `groupByFolder` | true | extension, tree, webtree | **Fold** — *done, step D* | Together with `onlyProjectSessions` this is one question: what to do with sessions no project claims. One enum `unclaimedSessions: grouped \| flat \| hidden`. |
| `onlyProjectSessions` | false | extension, tree, webtree | **Fold** (see above) — *done, step D* | Same question, third answer. `projects.resolveUnclaimed` folds the three reads; the renderers still take the two booleans. |
| `showForeignSessions` | false | extension | Preferences (Clean slate) | The policy the docs are built around. Keep and explain. |
| `onlyActiveSessions` | false | extension, webtree | Gear + title bar; stays a setting | **Keep as a setting** (*kept on review*). It is written at Global scope, mirrored into a context key, and the code already honours a flip made in `settings.json`. Moving it to `globalState` would take one key out of Settings Sync and gain nothing. |
| `showGhosts` | true | extension | **Hardcode true** — *done, step D* | Ghost ancestors are what make the tree honest. No test, no verb, one read. |
| `showArchived` | false | extension | Advanced | The "everything on disk" mode. Import is the front door; this stays as the back one. |
| `showPhantomRows` | false | extension | Advanced (diagnostic) | Debugging aid. Label it so. |
| `staleAfterHours` | 48 | extension | **Hardcode 48** — *done, step D* | Only pre-ticks checkboxes in a dialog that lets you untick them. |
| `busyStaleMinutes` | 5 | extension | Advanced | Workaround for a CLI status bug. Hardcode once the CLI fixes it. |
| `hooks.enabled` | false | extension | Gear (install / remove) | The reader gate the install flips. Could become `globalState`; low value either way. |
| `verbs.enabled` | false | extension | Gear (install / remove) | Same shape as hooks. |
| `notifications.enabled` | true | extension | Preferences (Attention) | Keep. |
| `notifications.popup` | false | extension | Preferences (Attention) | Keep. |
| `mode` | `folder` | extension, recommend, daemon, transcript | Gear picker + Preferences | The window model. Keep; the picker is the honest spelling, the editor's dropdown gets `enumItemLabels` so it reads the same. |
| `workspaces.enabled` | true | extension, recommend | **Remove from the manifest** — *not in step D; see the decisions log* | Already carries `markdownDeprecationMessage` pointing at `#lineage.mode#` (since 68fe8d3); the first draft's claim that it did not was wrong, so VS Code already draws it struck through. Stop contributing it in step D; keep the read in `resolveMode` so an old `false` still folds `project` down to `root`. Verify first that `get()` still returns a value for an unregistered key. |
| `workspaces.resumeSessions` | true | extension, workspaces | Advanced | Niche. |
| `workspaces.autoSwitch` | true | extension | **Fold into `mode`** — *done, step D* | `project` with auto-switch off is what `root` already is, minus a status-bar item. Two spellings of one model. |
| `explorer.followProject` | true | extension | Advanced (Auto-switch only) | The conversion is a verb anyway. |
| `explorer.scope` | `directory` | extension, explorer | Advanced (Auto-switch only) | Needs a reload; belongs with the other reload-bound keys. |
| `accounts.enabled` | true | extension, accountsView | **Fold into `accounts.section`** — *done, step D* | Both must be on to draw one view. The gear toggles the section; nothing toggles this. |
| `accounts.section` | true | extension | Gear + Preferences (Accounts) | Keep; it is the one the gear flips. |
| `shells.section` | true | `when` only | Gear + Preferences | The gear pair Accounts already has, added in step A. Before it, nothing but json flipped it. |
| `accounts.offerSwitchAtLimit` | false | extension | Preferences (Accounts) | Keep. |
| `viewStyle` | `inline` | extension | Advanced | The most expensive toggle in the codebase, and it stays: under the native-components rule the native tree is the component to keep, so this plan retires nothing (§6). |
| `runningBadge` | false | extension | Advanced | Cheap, taste. |
| `showTokens` | false | extension, tree, webtree | Preferences (Rows) | Keep. |
| `groupSessionsByBranch` | false | extension, tree, webtree | Advanced | Requires branch rows, ignored with subprojects. |
| `branchColors` | `[]` | extension, webtree | Advanced | Only in colour mode. |
| `git.pullRequests` | false | extension, two `when` | Preferences (Worktrees), with the network warning | Keep; carries VS Code's `usesOnlineServices` tag. |
| `git.branches` | false | extension, recommend, 52 `when` | Gear bundle + Preferences (Worktrees) | Keep. |
| `git.branchDisplay` | `inline` | extension | Gear + Preferences | Keep. |
| `git.sessionBranchDetail` | `standard` | extension | Advanced | **Keep as a setting** (*kept on review*). The first draft folded it into `git.pullRequests`; the 0.1.9 round chose the minimal session line on purpose, and `detailed` is the opt-in for whoever wants the chip on the row. |
| `git.worktreePath` | `../${repo}-${branch}` | extension | Advanced | Keep. |
| `git.newSessionInWorktree` | true | extension | Preferences (Worktrees) | Keep. |
| `git.branchPrefix` | `""` | extension | Preferences (Worktrees) | Common personalisation; worth a visible row. |
| `preview.directoryModel` | false | extension | Advanced (preview) | Carries VS Code's `preview` tag. Promote or delete by 0.2. |

Net effect: 51 keys became **45** in step D — `pollIntervalMs`, `showGhosts`
and `staleAfterHours` hardcoded; `workspaces.autoSwitch` folded into `mode`
and `accounts.enabled` into `accounts.section`; `groupByFolder` and
`onlyProjectSessions` folded into one `unclaimedSessions`. `workspaces.enabled`
is still contributed, struck through, so the count is 45 rather than the 44
the first draft promised — the decisions log says why. No enum value goes:
`terminalLocation: newWindow` and `close.summaryMode: ask-me` both stay, for
the reasons in their rows. Nothing in this plan removes `viewStyle`.

Every retired key the source still reads is listed in `LEGACY_KEYS`
(src/types.ts), kept apart from `CONFIG_KEYS` so the manifest cross-check and
the table-driven setter can tell "read but never written" from "contributed".

Rule for removals: a removed key that a user still has in `settings.json`
must keep doing what it did, or do nothing. Never write to a user's settings
on activation or on a timer to migrate — this codebase has held that line and
should keep holding it. Settings are written only as the direct result of a
gesture: a picker choice, a gear verb, a checklist confirmation.
`workspaces.enabled` is the test case: stop contributing it, keep reading it.

## 3. The tiers — which surface owns which option

Today there are five surfaces, not three: the VS Code settings editor and
`settings.json`; palette verbs; the gear QuickPick (a mix of toggles and
housekeeping); Recommended Setup with its two pickers and Choose Window
Model; and the title-bar buttons, context menus, welcome text and walkthrough.
Plus one more that is not a setting at all: per-project and per-session
choices in `state.json` (account pin, routing, mute, keep awake, hidden
folders, closed projects).

Five tiers, each with a rule that decides membership:

**A. Asked once.** A question whose default was never the person's answer,
or an action that writes files in their home directory. Surface: the
walkthrough and Recommended Setup. Members: hooks, verbs, first project,
import. The two taste questions (window model, where sessions open) move
out of the first run — see §5.

**B. Flipped while working.** State a person changes several times a day,
whose current value must be readable in the label. Surface: the gear menu
and the same commands in the palette; the title bar for the one filter.
Members: active-sessions filter, branch rows on/off (the bundle), branch
display inline/colour, Accounts section, Shells section, mute per session,
window model picker, surface picker, install/remove hooks and verbs. Rule:
every member is a command, and the gear label says which way it goes.

**C. Preferences.** Set once, revisited rarely, needs a sentence, takes
effect live. Surface: the VS Code Settings editor, filtered to Flock and
organised into the categories below (§4). Groups and members:

- Sessions: `tmux`, `exitToShell`, `terminalLocation`, `soloSession`, `launch.mode`
- Attention: `notifications.enabled`, `notifications.popup`, `showTokens`
- Forking and closing: `fork.notifyParent`, `close.summaryMode`
- Worktrees: `git.newSessionInWorktree`, `git.branchPrefix`, `git.branches`, `git.branchDisplay`, `git.pullRequests`
- Accounts: `accounts.section`, `shells.section`, `accounts.offerSwitchAtLimit`
- Clean slate: `showForeignSessions`, `unclaimedSessions`
- Housekeeping: `session.closeAfterMinutes`
- Window: `mode` — a dropdown in the editor, with `enumItemLabels` so the
  three read as the picker names them; the gear's picker stays the surface
  that says what each costs.

**D. Advanced.** Paths, timing, diagnostics, previews, and anything that
needs a reload. Surface: the same editor, one category further down, every
row tagged `advanced` so `@tag:advanced` finds them and the Preferences
categories can be read without them. Members: `claudeBinary`,
`codexBinary`, `chat.autoCloseMinutes`, `session.detachGraceMinutes`,
`session.reloadGraceSeconds`, `sessionSwitching`, `showArchived`,
`showPhantomRows`, `busyStaleMinutes`, `workspaces.resumeSessions`,
`explorer.followProject`, `explorer.scope`, `runningBadge`,
`groupSessionsByBranch`, `branchColors`, `git.sessionBranchDetail`,
`git.worktreePath`, `preview.directoryModel`, `viewStyle`.

**E. Not settings.** Anything about one project or one session. Stays in
`state.json` behind context menus. Never becomes a global key.

Two consequences. The gear stops carrying preference toggles: it keeps the
filter, the branch-rows bundle, the section toggles, the pickers, the
installs and the housekeeping verbs, and gains "Flock Settings…" and
"Status…" at the top. And a key in tier C may not require a reload, which is
why `explorer.scope` and `viewStyle` sit in D.

## 4. The settings surface — the built-in editor, adapted

There is no settings page of Flock's own. The VS Code Settings editor is the
page, and everything below is manifest work that makes it read like one:

**Categories, in tier order.** `contributes.configuration` becomes an array
of configuration objects, one per group in §3, each with a `title` and an
`order`: the tier C groups first, in the order listed, then a single
"Advanced" category. The editor draws them as a table of contents under
*Extensions › Flock*, so the left-hand group list the first draft wanted to
build is the one VS Code already draws.

**Rows, in a chosen order.** Every property carries `order`, so a category
reads top to bottom the way its group is listed here rather than in the
manifest's historical order.

**Tags.** VS Code's own tags where they apply — `usesOnlineServices` on
`git.pullRequests` (it is the one thing in Flock that reaches the network),
`preview` on `preview.directoryModel` — and `advanced` on every tier D row,
so `@ext:hjulaxel.flock @tag:advanced` is the Advanced list and the plain
filter is the Preferences list with the Advanced category at the bottom.

**Enums that say what they mean.** Every enum gets `enumItemLabels` (the
words the pickers use — "One folder per project", "Flock only",
"Auto-switch") and `enumDescriptions` (one sentence per value), so the
dropdown reads the way the gear's picker does and the two cannot disagree.

**Descriptions that link.** `markdownDescription` throughout, with `#lineage.x#`
cross-references where one key depends on another (pull requests under
branch rows, colours under colour mode). The editor cannot grey out a
dependent row; the prose says the dependency and the link takes the reader
to it, and that is the accepted limit.

**Retired keys.** `deprecationMessage` / `markdownDeprecationMessage` on any
key that is superseded but still read (`workspaces.enabled` already has one).
The editor strikes the row through and points at the replacement; Flock
never writes the replacement for the user.

**Two verbs.** "Flock Settings…" in the gear and the palette runs
`workbench.action.openSettings` with `@ext:hjulaxel.flock`, which lands on
the categories above. "Flock: Status…" is a native QuickPick, read-only
rows that answer the questions people actually open a settings page for: is
tmux installed and on; are hooks and verbs installed; which `claude` and
`codex` binaries were found and where; which window model this window is
on; how many settings differ from their defaults. Picking a row runs its
fix-it verb — the install, the picker, the settings filter. Recommended
Setup's `done` list already computes most of this.

**One source of truth.** The manifest is it. Titles, descriptions, types,
enums, defaults, order and tags live in `contributes.configuration` and
nowhere else; a small script generates `docs/settings.md` and the
walkthrough's counts from the manifest, so the three copies become one. A
catalog module in `src/` exists only if the manifest's own fields cannot
carry something the Status verb needs (which key each status line fixes);
tier and group are the manifest's `order` and `tags`, not a second table.

**Writes.** None from Flock. The editor writes `settings.json` itself, and
the `onDidChangeConfiguration` handler in `extension.ts` already repaints on
every live key. The rule from §2 holds: Flock writes a setting only on a
gesture, and the editor is the user's own gesture.

Rough size: manifest edits, two commands, one generator script. No new
runtime module of any size, no stylesheet, no page script.

## 5. The front door — what a new user is shown

Today a genuinely fresh install can meet four things in its first minute:
the empty-view welcome (four links), the walkthrough (opens once after 2.5 s
when the store is empty), the Recommended Setup toast (fires when there are
no projects and two or more steps are left, which is the same moment), and
the tmux notice when tmux is missing. The checklist itself has up to eight
steps, two of which are pickers.

Proposed first run, in order of what the person can actually answer:

1. **The walkthrough opens.** It is VS Code's own idiom for a first run and
   the one door the code already guarantees. Its second step launches the
   checklist. **Drop the toast on the launch where the walkthrough opened**;
   it is the same offer twice.
2. **The checklist asks four things, all pre-ticked:** instant updates,
   in-session verbs, first project, import history (only when there is
   history). These are the consent items and the two that put rows on the
   tree. A new user can say yes to all four without understanding Flock.
3. **The two taste questions leave the first run.** Nobody can answer "what
   is a window" before they have lived in one. Ask them at the moment they
   become real: the first time a session belonging to another project is
   opened, offer the window-model picker once; the first time a second
   session tab opens, offer the surface picker once. Both stay reachable from
   the gear and the Status verb forever. Add "Choose Where Sessions
   Open…" as a gear verb beside "Choose Window Model…".
4. **tmux is a status line, not a toast.** Missing tmux is already a note in
   the checklist receipt; the Status verb shows it permanently with the
   install command for the host. Keep the one-time notice only where it is
   contextual: the first workspace switch without tmux.
5. **Windows hides what it cannot do.** The checklist already skips tmux on
   Windows; hooks and verbs need the same guard, and the gear entries a
   `!isWindows` clause. That work — the checklist guard and the gear clause
   alike — belongs to the sibling platform branch, not to this one; nothing
   here adds a `process.platform` check.

Everything else keeps its default. A first-run user configures at most four
things and is asked no question they cannot answer yet.

## 6. Order of work

1. **Manifest hygiene, no behaviour change** (step A). The Shells gear pair
   Accounts already has; confirm `workspaces.enabled` carries its deprecation
   marker (it does). No enum value is dropped. The `!isWindows` guards go to
   the platform branch.
2. **Generated docs.** The script that writes `docs/settings.md` and the
   walkthrough counts from the manifest; delete the hand-kept table.
3. **The removals and folds from §2** (step D), one commit each, with the
   "old key still read" rule tested. 51 keys become 44.
4. **Front-door changes from §5**, and the surface picker's fifth option
   (`terminalLocation: newWindow`, step E).
5. **The editor adaptation and the two verbs from §4**: categories, order,
   tags, enum labels, "Flock Settings…" and "Flock: Status…".

There is no step that retires the native tree. The first draft had one —
"webview accessibility pass, then delete `tree.ts` and `decorations.ts`" —
and it pointed the wrong way: under the native-components rule the native
TreeView is the component VS Code provides, and the inline webview is the
custom one. `viewStyle` therefore stays, both renderers stay, and the
question of the inline view's future — keep, freeze, or fold it back into
the native tree — is Axel's to decide, on its own evidence, outside this
plan.

## Decisions log

**2026-09-05** — revised after review of the first draft.

- `close.summaryMode: ask-me` **kept**. It is the honest fallback for every
  refusal in `closeWithCompaction`; a value that names the behaviour you get
  anyway is not dead.
- `terminalLocation: newWindow` **kept**, and the surface picker gains it as
  a fifth option (step E) instead of the value being dropped for what the
  picker could not mark current.
- `onlyActiveSessions` **stays a setting**. Written at Global scope, mirrored
  to a context key, flippable from `settings.json`; moving it to state would
  lose Settings Sync for one key.
- `git.sessionBranchDetail` **kept as Advanced** rather than folded into
  `git.pullRequests`; the 0.1.9 round argued for the minimal session line on
  purpose. Net after step D: 51 keys become 44, not 41.
- **§4 is the built-in Settings editor, not a webview.** Categories, `order`,
  `tags` (VS Code's `preview` and `usesOnlineServices` where they apply,
  `advanced` for tier D), `enumItemLabels` and `enumDescriptions` for every
  enum, a gear verb "Flock Settings…" that opens the editor filtered to
  `@ext:hjulaxel.flock`, and the Status section as a native QuickPick verb
  "Flock: Status…". The HTML wireframe is gone.
- **Step 6 (retire the native tree) is removed.** The native TreeView is the
  component to keep under the native-components rule; the inline webview is
  the custom one. The inline view's future is left to Axel.
- **§5 item 5** (hiding hooks and verbs on Windows in the checklist, the
  `!isWindows` gear clause) belongs to the sibling platform branch.
- **`workspaces.enabled` already carries `markdownDeprecationMessage`** (since
  68fe8d3, pointing at `#lineage.mode#`). The first draft's audit row was
  wrong; step A verified rather than re-added it. The removal from the
  manifest still happens in step D.
- Settings are written only on a user gesture — never on activation, never
  on a timer. Restated here because every later step depends on it.
- **§6 step 2 landed as `scripts/settings-doc.mjs`** (step C), which renders
  `contributes.configuration` into `docs/settings.md` between two markers,
  with `npm run docs:check` as a test and a release gate. The walkthrough's
  and README's counts were made numberless rather than generated: a count a
  script rewrites is still a number the prose asks a reader to trust, and the
  one place the numbers now live is the generated summary line.
- **Step D landed at 45 keys, not 44.** The three hardcodes and the three
  folds are in, one commit each, and every retired key keeps working from
  `settings.json`: `accounts.enabled: false` still keeps the Accounts list
  from being registered (and the gear's section verbs clear it),
  `workspaces.autoSwitch: false` still resolves a `project` window to `root`
  (and the window-model picker deletes it when Auto-switch is chosen), and the
  two grouping booleans still read as `flat` / `hidden` while the new key is
  unset. `workspaces.enabled` was NOT removed from the manifest in this step:
  the step's brief left it out, its deprecation marker is the one row in the
  editor that points a reader at `lineage.mode`, and the picker still writes
  it back to `true` — removing it would have made that write throw. Whether
  it goes in a later step, or stays as the struck-through pointer, is open.
- **A when-clause cannot honour a retired boolean.** The Accounts view's
  `when` is `config.lineage.accounts.section` alone, because the when-clause
  language cannot tell an unset key from `false` — `config.x != false`
  compiles to "x is truthy", which would hide the view for everyone who never
  wrote the old key. So a user carrying `accounts.enabled: false` keeps the
  list unregistered but still sees the section's collapsed header until they
  hide it from the gear; the log says so on activation. Folding a key that a
  when-clause read is the one case where "keeps working" is only partly
  reachable, and it is recorded here so the next fold checks for it first.

