// src/viewmodel.ts — the tree's rendering decision, as data.
//
// This is the whole rendering decision for the tree, expressed as a flat list of
// serializable rows, so it can be unit-tested without a workbench AND posted
// straight into a webview. It imports ./types and ./projects and nothing else —
// no vscode, no node — which is what keeps that true.
//
// Why a flat list: the webview renders rows, not a nested DOM. Flattening here
// (honouring the collapsed set) means the client is a dumb painter with no model
// of its own to drift out of sync — every decision about what is visible, in
// what order, at what depth, is made in one testable place.
//
// This module also OWNS the three pure row helpers that used to live in
// tree.ts — formatAge, statusDescriptor, sessionContextValue — because both the
// native tree and the webview must render identically, and two copies of "how a
// row reads" would diverge on the first change. tree.ts re-exports them.

import { STATUS_DOT, contextValueOf } from './types';
import type {
  BranchInfo,
  BranchStatus,
  ContextToken,
  GroupNode,
  ProjectGroupNode,
  ProviderId,
  PullRequest,
  PullRequestChecks,
  PullRequestState,
  BranchDisplay,
  SessionBranchDetail,
  SessionForest,
  SessionNode,
  SubprojectNode,
} from './types';
import { branchIndexForCwd, unbranchedRoots } from './projects';
import type { GroupingResult } from './projects';
import { hostMarker, hostTooltipLine } from './hosts';
import type { SessionHost } from './hosts';

// ------------------------------------------------------------ pure helpers

/** < 90s → 'now'; < 1h → '<m>m'; < 24h → '<h>h'; else '<d>d'.
 *  Negative / NaN / non-finite → '' (an unknown age renders as nothing). */
export function formatAge(deltaMs: number): string {
  if (typeof deltaMs !== 'number' || !Number.isFinite(deltaMs) || deltaMs < 0) {
    return '';
  }
  if (deltaMs < 90_000) return 'now';
  if (deltaMs < 3_600_000) return `${Math.floor(deltaMs / 60_000)}m`;
  if (deltaMs < 86_400_000) return `${Math.floor(deltaMs / 3_600_000)}h`;
  return `${Math.floor(deltaMs / 86_400_000)}d`;
}

/**
 * The grace countdown as a row reads it: `closing in 9m`, then `closing now`.
 *
 * Minute granularity on purpose, not the mm:ss a stopwatch would show: the
 * repaint cadence is the roster poll (~3 s) plus a once-a-minute nudge from
 * the lifecycle timer, and a seconds display that is wrong for most of every
 * minute is worse than a minutes display that is right. Ceiling, not floor —
 * a countdown that says `0m` while the process still runs has already broken
 * its promise, and "closing in 1m" with 20 seconds left errs the way a
 * countdown should: it never claims more time is gone than is.
 *
 * `closing now` past the deadline rather than nothing: a busy session
 * outlives its deadline on purpose (the sweep marks it close-after-turn and
 * waits), and the row must keep saying the process is on its way out for as
 * long as it runs. Not-a-number renders as nothing, same rule as formatAge.
 */
export function formatGraceCountdown(remainingMs: number): string {
  if (typeof remainingMs !== 'number' || !Number.isFinite(remainingMs)) {
    return '';
  }
  if (remainingMs <= 0) return 'closing now';
  return `closing in ${Math.ceil(remainingMs / 60_000)}m`;
}

/** How much of the last exchange an archived ROW carries. The description
 *  shares a line with the age and is elided by the surface at the first
 *  squeeze anyway; 80 characters is enough to recognise a conclusion and
 *  little enough that the age column stays a column. The hover shows the
 *  longer text (bounded at capture — see usage.LAST_EXCHANGE_MAX_CHARS). */
export const SNIPPET_MAX_CHARS = 80;

/**
 * What a level-2 row says it CONCLUDED: the recorded close-with-summary when
 * there is one, else the last conversation text out of the transcript tail.
 * The summary wins because the user wrote it for exactly this line.
 *
 * Whitespace is collapsed because both surfaces render descriptions and hover
 * lines single-line — a newline in a TreeItem.description is a box glyph, not
 * a break. '' when the node has neither, so callers can filter it out of a
 * ` · `-joined description like every other optional part.
 */
export function sessionSnippet(
  node: SessionNode,
  maxChars: number = SNIPPET_MAX_CHARS,
): string {
  const text = (node.summary ?? node.lastExchange ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '' || !Number.isFinite(maxChars) || text.length <= maxChars) {
    return text;
  }
  return text.slice(0, Math.max(maxChars - 1, 1)).trimEnd() + '…';
}

/**
 * A token count as a row reads it: `840`, `12.3k`, `284k`, `1.2M`.
 *
 * One fractional digit below 100 k and none above, because the row has to stay
 * scannable: what matters at 284 k is the leading digits, and `284.3k` is two
 * characters of noise in a column that already sits next to an age. Anything
 * not a finite positive number renders as nothing — an unknown count must cost
 * the row no width at all, which is also what keeps `lineage.showTokens` from
 * putting a ` · ` separator on every row that has no number to show.
 *
 * Lives here rather than in usage.ts (where the counting lives) because this is
 * a RENDERING decision and both surfaces have to make it identically — the same
 * reason formatAge is here.
 */
export function formatTokens(tokens: number | undefined): string {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) {
    return '';
  }
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 100_000) {
    // `12.0k` reads as a spurious precision claim; trim it back to `12k`.
    const text = (tokens / 1000).toFixed(1);
    return `${text.endsWith('.0') ? text.slice(0, -2) : text}k`;
  }
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  const m = (tokens / 1_000_000).toFixed(1);
  return `${m.endsWith('.0') ? m.slice(0, -2) : m}M`;
}

/**
 * A checkout's standing against its upstream, as the one short token a branch
 * row has room for: `↑2`, `↓1`, `↑3 ↓2`.
 *
 * '' when there is nothing to report, which covers BOTH "clean and in sync" and
 * "not read yet" — on a row those two are the same thing, and a row that spent
 * width saying "in sync" would be spending it on the default state of every
 * checkout anybody has. The hover tells them apart (see branchStatusLines),
 * because it is the one place a permanent fact is worth a full sentence.
 *
 * Ahead before behind, because that is the order the phrase is said in and the
 * order the arrows read in.
 *
 * UNCOMMITTED WORK IS NOT IN HERE, and used to be — `*` was the last token of
 * this string. It moved to the far side of the branch NAME (see branchIsDirty),
 * because that is the one thing the mark is about: `feat/x *` says this checkout
 * has changes in it, where a star at the end of `↑3 ↓2 *` reads as a third
 * number about the upstream, which it is not. Every surface places it the same
 * way, the native tree included, so there is still one dialect.
 *
 * Lives here rather than in gitBranches.ts for the same reason formatAge does:
 * this is a RENDERING decision and both surfaces have to make it identically.
 * gitBranches.ts also imports node:child_process, and this module's whole
 * discipline is that it imports ./types and ./projects and nothing else.
 */
export function formatBranchSync(status: BranchStatus | undefined): string {
  if (!status) return '';
  const parts: string[] = [];
  if (Number.isFinite(status.ahead) && status.ahead > 0) {
    parts.push(`↑${status.ahead}`);
  }
  if (Number.isFinite(status.behind) && status.behind > 0) {
    parts.push(`↓${status.behind}`);
  }
  return parts.join(' ');
}

/**
 * Is there work in this checkout that is not committed — the `*` that follows a
 * branch name.
 *
 * Modified tracked files and untracked ones both count, and neither is counted:
 * a number of changed files is a number nobody acts on, where the EXISTENCE of
 * uncommitted work is the whole of what a branch row can usefully warn about,
 * and it is what Remove Worktree asks a second time over.
 *
 * A predicate rather than a string, because it is drawn as its own element next
 * to the name on both surfaces and the one that carries a title ("uncommitted
 * changes") for the pointer.
 */
export function branchIsDirty(status: BranchStatus | undefined): boolean {
  return status !== undefined && (status.dirty === true || status.untracked === true);
}

/**
 * Which mark leads a branch — the name of a glyph, shared by both renderers.
 *
 * GITHUB'S OWN VOCABULARY, deliberately: somebody arriving from a browser tab
 * already reads a green arrow as open and a purple merge as landed, and an
 * extension that invented a fifth convention for the same four states would be
 * asking them to learn one. The names are codicon ids, which is what lets the
 * native tree pass this straight to a ThemeIcon while the webview looks the same
 * string up in its own svg allowlist (ROW_GLYPH_FILES) — one table of names, two
 * ways of painting it.
 *
 *   no request   git-branch                 the mark the line has always had
 *   draft        git-pull-request-draft     grey: not asking anything yet
 *   open         git-pull-request           green
 *   merged       git-merge                  purple: the worktree can go
 *   closed       git-pull-request-closed    dimmed: over, and it did not land
 *
 * A branch with no request keeps `git-branch`, and that is most branches: the
 * feature is off by default, and with it on plenty of checkouts have no request
 * yet. The colour, and only the colour, is what the state changes for a reader
 * scanning the column — see .branch-glyph in webtree.css.
 */
export function branchStateIcon(pr: PullRequest | undefined): string {
  if (!pr) return 'git-branch';
  switch (pr.state) {
    case 'draft':
      return 'git-pull-request-draft';
    case 'merged':
      return 'git-merge';
    case 'closed':
      return 'git-pull-request-closed';
    default:
      return 'git-pull-request';
  }
}

/**
 * The same facts as sentences, for the hover — where "nothing to report" is
 * worth saying out loud and "*" is not enough.
 *
 * Two lines at most: where the branch stands against its upstream, and what is
 * uncommitted. A branch that tracks nothing says so rather than reporting a
 * meaningless zero-zero, and a status that was never read contributes no lines at
 * all, so the hover of an unprobed row is the hover it always had.
 */
export function branchStatusLines(status: BranchStatus | undefined): string[] {
  if (!status) return [];
  const out: string[] = [];
  const ahead = Number.isFinite(status.ahead) ? Math.max(0, status.ahead) : 0;
  const behind = Number.isFinite(status.behind) ? Math.max(0, status.behind) : 0;
  if (status.upstream === '') {
    out.push('no upstream branch');
  } else if (ahead === 0 && behind === 0) {
    out.push(`up to date with ${status.upstream}`);
  } else {
    const moves: string[] = [];
    if (ahead > 0) moves.push(`${ahead} ahead`);
    if (behind > 0) moves.push(`${behind} behind`);
    out.push(`${moves.join(', ')} ${status.upstream}`);
  }
  if (status.dirty && status.untracked) out.push('uncommitted changes and untracked files');
  else if (status.dirty) out.push('uncommitted changes');
  else if (status.untracked) out.push('untracked files');
  return out;
}

/**
 * A pull request as the branch row draws it: `#42`, `#42 ✓`, `#42 ✕`, `#42 •`.
 *
 * The NUMBER first, because it is the thing you say out loud and the thing you
 * search for. The check glyph after it, and only one: a row has no width for
 * "3 of 4 passed", and the useful reduction of a rollup is whether you can stop
 * looking at it. `•` for pending rather than a spinner, because a branch row
 * repaints on a roster tick and an animation there would be a moving part in the
 * corner of somebody's eye all day.
 *
 * The STATE is not in the text. It is a class on the chip (see webtree.css) —
 * open, draft, merged, closed are four colours, and spelling them out would cost
 * the row more width than the branch name has to spare. The hover says the word.
 */
export function formatPullRequestChip(pr: PullRequest): string {
  const mark =
    pr.checks === 'pass'
      ? ' ✓'
      : pr.checks === 'fail'
        ? ' ✕'
        : pr.checks === 'pending'
          ? ' •'
          : '';
  return `#${pr.number}${mark}`;
}

/**
 * The line drawn under a session: which checkout it is running in, and what
 * that checkout needs next.
 *
 * PRE-FORMATTED, like BranchChip.sync and for the same reason — the client is a
 * dumb painter, and a decision made here is a decision the native tree cannot
 * make differently. The two detail levels are the whole of the vocabulary:
 *
 *   standard   ⎇ feat/search-ranking *    ↑4
 *   detailed   ⇡ feat/search-ranking *    ↑4      #128 ✓
 *              ⑃ fix/csv-import                   #124 merged
 *              ⎇ spike/preview-cache *   local
 *
 * The `*` sits against the NAME rather than at the end of the arrows, because it
 * is a fact about this checkout and not a third number about its upstream — see
 * branchIsDirty. The leading mark is `git-branch` until there is a request on the
 * branch, at which point it takes that request's shape and colour — see
 * branchStateIcon. Both are drawn by the client from what this returns; neither
 * is a decision it makes.
 *
 * `standard` is not a reduced `detailed`. It is the vocabulary a git prompt and
 * the SCM view already speak, so the line reads without being learned, and it
 * reaches nothing but the local status cache — which is why it is the default.
 *
 * `detailed` adds exactly two words to it, and both are states the arrows render
 * as BLANK: `local` for a branch that tracks nothing (never pushed, so ahead and
 * behind are meaningless rather than zero), and `merged`, which is the one fact
 * that says a worktree can now be removed. `merged` is a WORD and not the chip's
 * colour, because the point of moving the branch off the session's name is that
 * a row should not need colour to be read.
 *
 * Note what is deliberately absent at both levels: a "can this be merged" mark.
 * GitHub computes `mergeable` asynchronously and answers UNKNOWN on a first
 * read, so the mark would flicker on a row that repaints on a roster tick, and
 * it would need `gh pr view` per BRANCH where the extension does one `gh pr
 * list` per repository. Ready-to-merge is the ABSENCE of tokens: a line that
 * says a branch name and `#128 ✓` and nothing else.
 */
export function sessionBranchLine(
  name: string,
  status: BranchStatus | undefined,
  pr: PullRequest | undefined,
  detail: SessionBranchDetail,
  /** The worktree this line names. Never drawn — read back by the view when a
   *  click on the line resolves to a verb, exactly as BranchChip.dir is. */
  dir = '',
): SessionBranchLine {
  const sync = formatBranchSync(status);
  // THE REQUEST IS THE DETAILED LEVEL'S, and that includes the shape and colour
  // of the mark. `standard` is the vocabulary a git prompt already speaks and
  // reaches nothing but the local status cache; a green arrow in it would be the
  // second dialect the whole level exists to avoid, drawn from a source the level
  // does not otherwise consult.
  const state = detail === 'detailed' ? pr : undefined;
  // The rest is common to both levels, because none of it is about the request:
  // the star is local, and whether the name is a link is a question about the
  // upstream.
  const common = {
    glyph: branchStateIcon(state),
    ...(state === undefined ? {} : { state: state.state }),
    ...(branchIsDirty(status) ? { dirty: true as const } : {}),
    ...(dir === '' ? {} : { dir }),
    // A LINK ONLY WHERE THERE IS SOMEWHERE TO GO. `upstream` non-empty is the
    // probe saying this branch tracks a remote one, which is the only case where
    // a branch page can exist to open; `''` says it tracks nothing (never
    // pushed) and `undefined` says nobody has looked. Both of those draw plain
    // text, so a name that looks clickable always is.
    ...(typeof status?.upstream === 'string' && status.upstream !== ''
      ? { link: true as const }
      : {}),
  };
  if (detail !== 'detailed') {
    // Absent rather than '' when there is nothing to say, so the line reserves
    // no width for a column it is not using — the rule `sync` follows on a
    // branch row.
    return { name, ...common, ...(sync === '' ? {} : { sync }) };
  }
  // `local` FIRST, because it qualifies everything after it: it is the reason
  // there are no arrows, not another fact alongside them. `upstream === ''` is
  // the probe's way of saying the branch tracks nothing — an unprobed branch has
  // no status at all and gets no word, since "never pushed" and "not looked at
  // yet" are different claims and only one of them is ours to make.
  const detailed =
    status !== undefined && status.upstream === ''
      ? ['local', sync].filter((s) => s !== '').join(' ')
      : sync;
  return {
    name,
    ...common,
    ...(detailed === '' ? {} : { sync: detailed }),
    ...(pr === undefined
      ? {}
      : {
          pr: {
            // A merged request has no checks worth a glyph — they ran, it
            // landed — so the word takes the glyph's place rather than sitting
            // beside it.
            label:
              pr.state === 'merged'
                ? `#${pr.number} merged`
                : formatPullRequestChip(pr),
            state: pr.state,
            checks: pr.checks,
          },
        }),
  };
}

/** The request as sentences, for the hover: the state and the checks in words,
 *  then the title. Two lines, because the title is the part that says what the
 *  branch is FOR and deserves its own. */
export function pullRequestLines(pr: PullRequest | undefined): string[] {
  if (!pr) return [];
  const checks =
    pr.checks === 'pass'
      ? ', checks passing'
      : pr.checks === 'fail'
        ? ', checks failing'
        : pr.checks === 'pending'
          ? ', checks running'
          : '';
  const out = [`pull request #${pr.number} — ${pr.state}${checks}`];
  if (pr.title.trim() !== '') out.push(pr.title.trim());
  return out;
}

/**
 * The words in a row's description, which is only what the dot CANNOT say.
 *
 * Live state (idle / running / done) is the status dot at the right edge —
 * see statusTone() — so 'busy' and 'idle' are deliberately wordless: two rows
 * that differ only in state should differ only in one dot.
 *
 * Being closed is wordless for the same reason: a closed row is dimmed and its
 * logo greyed, which says "this is over" across the whole row rather than in a
 * word competing with the age for the same few pixels. What survives as text is
 * the one distinction dimming cannot draw — an archived session has a
 * transcript and reopens on a click, where a ghost is an inferred ancestor with
 * possibly nothing behind it. 'gone' is what stops a ghost reading as something
 * you could resume.
 *
 * What also stays as text is what a waiting session is waiting FOR, which is a
 * fact and not a state.
 */
export function statusDescriptor(node: SessionNode): string {
  switch (node.status) {
    case 'waiting': {
      const what = node.roster?.waitingFor;
      return what !== undefined && what.trim() !== '' ? what.trim() : '';
    }
    case 'busy':
    case 'idle':
      return '';
    case 'exited':
      return node.ghost ? 'gone' : '';
    default:
      return '';
  }
}

/** How the status dot is lit: 'running' amber, 'done' red. 'idle' and 'closed'
 *  are tones with NO glyph — the row is known-quiet or known-over, which is
 *  worth a word in the hover and worth drawing nothing for, because a tree where
 *  every quiet row still carries a mark teaches the eye to ignore marks. They
 *  stay distinct tones rather than collapsing into one because the renderers key
 *  other things on them (a closed row is dimmed; an idle one is not) and the
 *  hover names them differently.
 *  undefined = no tone at all: a row put away, or one whose state we genuinely
 *  do not know. */
export type StatusTone = 'idle' | 'running' | 'done' | 'closed';

/**
 * The one definition of what the dot means, shared by all three surfaces (the
 * native tree's FileDecoration badge, the inline sidebar's row, the tooltip).
 *
 * 'done' is deliberately the attention state rather than a separate one: a
 * Claude session that has stopped and is waiting on you IS the finished one,
 * and that is the row you want to walk back to. A hidden row is checked first —
 * putting a session away is how you tell it to stop asking for you, so it must
 * not keep a lit dot.
 *
 * 'done' means UNSEEN done — the unread-message model: once you have looked at
 * a finished session its dot goes back to quiet, and a session that finished a
 * turn while you were elsewhere lights up even if it is merely idle.
 * `unseen === undefined` (tracking off for this session, or an input from
 * before unseen tracking existed) keeps the older reading: waiting = done.
 *
 * A finished-for-good row is 'closed' rather than no tone at all, even though
 * neither draws a mark: `closed` is what the renderers dim the row and grey its
 * logo on, and it is what the hover reads back. No tone at all means something
 * else entirely — a row put away, or a state nobody knows.
 */
export function statusTone(node: SessionNode): StatusTone | undefined {
  if (node.hidden) return undefined;
  if (node.ghost || node.archived || node.status === 'exited') return 'closed';
  if (node.attention === 'waiting' || node.status === 'waiting') {
    return node.unseen === false ? 'idle' : 'done';
  }
  if (node.status === 'busy') return 'running';
  if (node.status === 'idle') {
    return node.unseen === true ? 'done' : 'idle';
  }
  return undefined; // 'unknown' — an honest blank beats a guessed dot
}

/** Tone → the character that stands for it, or undefined for a tone that draws
 *  nothing at all.
 *
 *  Exported because the two surfaces have to agree on which tones are VISIBLE
 *  even though only one of them paints a character: the native tree writes this
 *  straight into a FileDecoration badge, while the webview asks only whether
 *  there is anything to draw and then draws its own circle in CSS.
 *
 *  Only the two LIT tones draw. 'closed' used to get a hollow ring, on the
 *  argument that a dead row left bare is indistinguishable from a live quiet
 *  one — but it never was: a closed row is dimmed, its logo greyed, and in the
 *  native tree its label greyed by the decoration's own colour. The ring was a
 *  second mark for something already said, and a column of empty circles down
 *  the side of every finished session is what teaches the eye to stop reading
 *  the column the lit dots live in. */
export function badgeGlyph(tone: StatusTone | undefined): string | undefined {
  return tone === 'running' || tone === 'done' ? STATUS_DOT : undefined;
}

/** The `;a;b;c;` token string both the native `viewItem =~ /;x;/` clauses and
 *  the webview's `data-vscode-context` match on. Delimited on both sides so
 *  /;live;/ can never match ;livewire;. */
export function sessionContextValue(
  node: SessionNode,
  boundHere: boolean,
  host?: SessionHost,
): string {
  const tokens: ContextToken[] = ['session'];
  const live = !node.ghost && !node.archived && node.status !== 'exited';

  // Muted rows offer Unhide where the others offer Hide. Exactly one of the two
  // is always present, so neither menu entry needs a negated `when` clause.
  tokens.push(node.hidden ? 'hidden' : 'shown');
  // The same shape for the notification mute: the row says which half of the
  // pair applies, so the menu shows "Hide Notifications" or "Show
  // Notifications" and never a toggle whose direction you have to guess.
  tokens.push(node.notifyMuted === true ? 'silenced' : 'notified');

  if (node.ghost) tokens.push('ghost');
  else if (node.archived) tokens.push('archived');
  else if (live) tokens.push('live');

  if (node.ghost || node.archived || node.status === 'exited') {
    tokens.push('exited');
  }

  if (live) {
    if (node.status === 'waiting') tokens.push('waiting');
    else if (node.status === 'busy') tokens.push('busy');
    else if (node.status === 'idle') tokens.push('idle');
    // OWNERSHIP, as a complementary pair on live rows only — the same shape as
    // hidden/shown and silenced/notified, and for the same reason: the manifest
    // needs a positive clause to match on, and the verbs that end a session must
    // key off "Flock can actually end this" rather than off "this is running".
    //
    // A closed row gets neither, because it has no host (see hosts.SessionHost)
    // and Close is not offered on one anyway.
    //
    // An ABSENT host means the wiring predates ownership — every unit double,
    // and any caller that builds a context value without a registry — so it
    // reads as 'hosted' and the menus are byte-identical to what they were.
    tokens.push(host === 'foreign' ? 'foreign' : 'hosted');
    // Detached under the grace countdown — a third token BESIDE the live and
    // ownership ones, never instead of them, because a grace row keeps every
    // live verb and gains exactly two: Close Now and Keep Awake. Emitted for
    // an EXPIRED deadline too: the sweep spares a busy session past its
    // deadline on purpose (close-after-turn), and the verbs must not vanish
    // from a row whose process is still running.
    if (node.graceDeadlineAt !== undefined) tokens.push('grace');
  }

  if (node.source === 'minted') tokens.push('ours');
  if (boundHere) tokens.push('bound');
  tokens.push(node.parentId ? 'forked' : 'root');

  return contextValueOf(tokens);
}

/**
 * A project row's context tokens: `project`, plus `empty` when nothing is filed
 * under it.
 *
 * The nesting pair that used to be here — `subproject` on a row filed under
 * another project, `parentProject` on one with children — is gone with record
 * nesting. `subproject` now belongs to a DIRECTORY row and must never appear on
 * a project row as well: the two rows carry the same projectId, so a shared token
 * would put both menus on both rows.
 */
export function projectContextValue(el: ProjectGroupNode): string {
  const tokens: ContextToken[] = ['project'];
  if (el.rootIds.length === 0) tokens.push('empty');
  return contextValueOf(tokens);
}

// ------------------------------------------------------------------ rows

export type RowKind =
  | 'project'
  /** ONE DIRECTORY of a multi-directory project, with the sessions running in
   *  it as its children. See projects.buildSubprojects — a project with one
   *  directory emits none of these, which is every project until somebody adds a
   *  second. */
  | 'subproject'
  | 'folder'
  | 'session'
  /** ONE branch, on its own row, inside the project's band. */
  | 'branch';

/**
 * The threshold at which a project's branches become visible.
 *
 * TWO, not one, and this single constant is the whole of the feature's
 * visual-cost decision — three separate behaviours key off it and they must
 * agree, or the tree contradicts itself:
 *
 *   - the chip row is emitted,
 *   - session names take their branch's colour,
 *   - the project row's `+` is withdrawn, because the chips replace it.
 *
 * At one branch there is nothing to tell apart. An ordinary repository with no
 * worktrees would get a row saying `main` — one row per project, forever, to
 * restate what every session under it already is — and a colour that
 * distinguishes nothing from nothing. Somebody who has never run `git worktree
 * add` sees a tree byte-identical to the one they had before this feature
 * existed, and the moment they add a second checkout the chips appear on their
 * own.
 */
export const BRANCH_CHIPS_MIN = 2;

/**
 * What a branch row draws.
 *
 * Still a projection of BranchInfo rather than the thing itself — the client is
 * a dumb painter and must not be handed the session-id lists it has no use for
 * — but now one per ROW rather than a list per strip. Kept as a named type
 * because both the branch row and the pickers in the command layer read the
 * same fields.
 */
export interface BranchChip {
  /**
   * The branch's name, WHOLE.
   *
   * Truncation is the stylesheet's job now, and cuts from the end like every
   * other label in the tree. An earlier version cut from the FRONT here, on the
   * argument that `feat/a-hawaiian-locale` and `feat/a-swedish-locale` are told
   * apart by their tails — true, but it was a fix for a layout that no longer
   * exists. Those names had four characters each in a horizontal strip; stacked,
   * a branch row gets the whole sidebar, and at that width the head is both
   * readable and the half you scan for. A leading `…` on every row was solving a
   * problem the new layout had already solved, at the cost of making every
   * branch look like it had lost its name.
   */
  name: string;
  /** The same string. Kept as a separate field because the verbs, the hover and
   *  the row key all read `full` explicitly, and collapsing the two would make
   *  every one of those call sites silently depend on `name` never being
   *  abbreviated again. */
  full: string;
  /** The worktree directory. Round-trips back as the argument to the verb the
   *  row runs, so a click can start a session in the right checkout. */
  dir: string;
  /** Which entry of the branch palette this row takes, in COLOUR mode.
   *
   *  Absent in inline mode, and absent is the whole of how the client knows: a
   *  chip with no colour draws a git-branch mark where the swatch went and takes
   *  the theme's own foreground for its name. Inline mode says the branch in
   *  words on every session that needs it, so a palette on top of that is a
   *  second answer to a question already answered — and the one the reader has
   *  to learn before it says anything. */
  colorIndex?: number;
  /** Which mark stands where the colour swatch would, in INLINE mode — a name
   *  from the glyph allowlist, chosen by branchStateIcon. In colour mode the
   *  swatch is the colour key and this is not drawn, because a row cannot be
   *  both a key and a state at once. */
  glyph: string;
  /** The request's state, when there is one: the class the mark and the `#42`
   *  chip both colour from. See SessionBranchLine.state, which is the same
   *  field for the same reason. */
  state?: PullRequestState;
  /** Uncommitted work in this checkout — the `*` that follows the name, placed
   *  the same way it is on a session's branch line. */
  dirty?: true;
  /** Live sessions filed under this branch. Drawn only when non-zero. */
  count: number;
  /** A session on this branch is finished-and-unlooked-at. The same roll-up the
   *  project row does, one level finer: the project's own dot says only THAT
   *  something is waiting, and the branch row says WHICH branch. */
  attention: boolean;
  /** The repository's main worktree. Drawn no differently, but the hide verb
   *  refuses it — see hideBranch. */
  primary: boolean;
  /**
   * Where this checkout stands, PRE-FORMATTED: `↑2 ↓1` — see
   * formatBranchSync. A string rather than the BranchStatus it came from,
   * because the client is a dumb painter: handing it three numbers and a flag
   * would put the decision of how they read into the one place that cannot be
   * unit-tested, and the native tree would then have to make the same decision
   * again and eventually differently.
   *
   * Absent (not '') when there is nothing to say, so a row with no status
   * reserves no width at all — the same rule `actions` and `marks` follow.
   */
  sync?: string;
  /**
   * The pull request on this branch, reduced to what a chip draws.
   *
   * `label` is pre-formatted for the same reason `sync` is; `state` and `checks`
   * travel as words because they are CLASS NAMES on the far side — the client
   * picks a colour from them, which is a lookup and not a formatting decision, and
   * a colour is the only thing this chip has left to say the state with.
   *
   * Absent unless `lineage.git.pullRequests` is on AND there is a request on this
   * branch, which for everybody who has not turned it on is always.
   */
  pr?: {
    label: string;
    state: PullRequestState;
    checks: PullRequestChecks;
  };
}

/**
 * The second line under a session row — see sessionBranchLine, which is the only
 * thing that builds one.
 *
 * Shaped like the half of BranchChip a branch row draws, and deliberately not
 * reusing that type: a chip is a whole row's click target with a colour index, a
 * session count and a hide verb, where this is a handful of tokens under a
 * session's name. Sharing the type would have every reader of a chip asking
 * which of its fields mean anything here.
 */
export interface SessionBranchLine {
  /** The branch this session's checkout is on. Never elided here — the client
   *  middle-elides it in CSS, so the full name stays in the DOM for a copy and
   *  the width decision belongs to the surface that knows the width. */
  name: string;
  /** Which mark leads the line — a name from the glyph allowlist, chosen by
   *  branchStateIcon. `git-branch` until there is a request on the branch. */
  glyph: string;
  /** The request's state, when there is one: the CLASS the mark and the chip
   *  both take their colour from. Absent means the mark stays the theme's own
   *  icon colour, which is what a branch with no request has always drawn. */
  state?: PullRequestState;
  /** Uncommitted work in this checkout — the `*` that follows the name. `true`
   *  or absent, never `false`: an absent field costs no width, which is the rule
   *  every optional token on this line follows. */
  dirty?: true;
  /** Where the checkout stands: `↑4 ↓3`, and `local …` at the detailed level.
   *  Absent — not '' — when there is nothing to report. */
  sync?: string;
  /** The branch exists on a remote, so its name is a LINK to the branch's page
   *  there. Decided from the upstream and not from the name: a branch nobody has
   *  pushed has no page, and a name that looks clickable has to be. */
  link?: true;
  /** The worktree directory this line names. NEVER DRAWN. It is here for the
   *  same reason BranchChip.dir is: a click on the line names a row, and the
   *  extension reads the directory out of the model it posted rather than
   *  letting the page name a path. */
  dir?: string;
  /** The pull request, at the DETAILED level only. `state` and `checks` travel
   *  as words for the same reason they do on a chip: they are class names on the
   *  far side, and the client picks a colour from them rather than a phrase. */
  pr?: {
    label: string;
    state: PullRequestState;
    checks: PullRequestChecks;
  };
}

/** What glyph leads the row. `provider` resolves to a brand svg in the webview
 *  (the client is handed a provider→uri map); `codicon` is a font glyph, used
 *  where claiming a provider would be a made-up fact (ghosts) or where the
 *  glyph has to be recolourable (a muted row). */
export type RowIcon =
  | { type: 'provider'; provider: ProviderId }
  | { type: 'codicon'; id: string; tone?: 'muted' | 'brand' };

/** A hover button on the right-hand side of a row. `icon` names a file in the
 *  action-icon map the client is handed (drawn as a CSS mask, so it takes the
 *  theme's icon colour); `id` is the ALLOWLISTED action name the client sends
 *  back, never a command id — the webview must not be able to name a command
 *  the extension did not offer it. */
export interface RowAction {
  id: string;
  icon: string;
  title: string;
}

/** A small non-interactive glyph drawn immediately right of the row's LABEL —
 *  a fact about the session rather than something you can do to it, which is
 *  what separates it from a RowAction (those sit at the far right, appear on
 *  hover, and are buttons). `icon` names a file in the same glyph map the
 *  actions draw from, so a mark the extension does not ship simply does not
 *  render. */
export interface RowMark {
  icon: string;
  title: string;
}

export interface ViewRow {
  /** Stable across rebuilds — the client keys its DOM and its selection on it. */
  key: string;
  kind: RowKind;
  depth: number;
  label: string;
  description: string;
  expandable: boolean;
  expanded: boolean;
  icon: RowIcon;
  /** The status dot's character, drawn hard against the right edge of the row.
   *  Absent on a row whose tone has no glyph (idle, closed) and on a row with no
   *  tone at all (put away, state unknown). */
  badge?: string;
  badgeKind?: StatusTone;
  /** Hidden (put away): greyed. The word 'hidden' is also in `description`. */
  muted: boolean;
  /** This session is over: dimmed, its logo greyed. Its own field and never
   *  inferred from `badgeKind`, because the two disagree in both directions —
   *  a hidden-and-archived row has no tone at all yet is closed, and a ghost
   *  carries the closed ring yet must NOT be dimmed as one, since there was
   *  never a session there to finish. */
  closed: boolean;
  /** Hover buttons, rendered right of the description. Absent (not empty) on a
   *  row with none, because the client only reserves the column's width for
   *  rows that actually have one — session-row geometry, which the status
   *  dot's right-edge alignment depends on, must stay exactly as it is. */
  actions?: RowAction[];
  /** Glyphs drawn right of the label. Absent (not empty) on a row with none, so
   *  a row that has nothing to mark costs no width at all. */
  marks?: RowMark[];
  /**
   * The lineage rails standing to the LEFT of this row — one entry per ancestor
   * column, outermost first — and the whole of what the client needs to draw
   * the tree's spine. `rails[k]` is true when the rail in column k carries on
   * BELOW this row, false when this row is the last thing hanging off it and
   * the rail stops at this row's elbow.
   *
   * `rails.length` is the row's depth WITHIN ITS OWN ROOT SESSION'S subtree,
   * which is deliberately NOT `depth`: a project or folder row is a section
   * header, not a node in anyone's lineage, so the sessions under it start
   * fresh spines rather than hanging off the header. Both kinds of header, and
   * every root session, therefore carry `[]`. The client indents the row by the
   * difference (`depth - rails.length` levels of plain padding) and draws the
   * gutter for the rest, which keeps every row's glyph column exactly where it
   * has always been.
   *
   * Read as a pair with the last entry's other meaning: `rails[rails.length-1]`
   * is false exactly when this row is its parent's last visible child.
   */
  rails: boolean[];
  /**
   * How many SECTION levels of plain padding stand to the left of this row,
   * before anything it draws itself.
   *
   * Deliberately not `depth`, and deliberately not derivable from it. `depth` is
   * the outline level — what aria-level reports and what ArrowLeft walks — and a
   * forked session three deep in a lineage has depth 3 while sitting at exactly
   * the same x as its root, because the gutter draws that nesting instead. This
   * is the other kind of nesting: the project a row is filed under. A row under
   * a subproject two levels down gets 2 here whether it is a project row, a
   * branch row, a root session or a fork of a fork.
   *
   * Absent means 0, which is every row in a tree where nobody has nested a
   * project — i.e. the older, unnested layout, unchanged to the pixel.
   */
  indent?: number;
  /** This row's own rail carries on downwards, into the children drawn beneath
   *  it. True only for an expanded session with children — a project header is
   *  expandable but spawns no rail, see `rails`. */
  descends: boolean;
  /** F2 / double-click starts an inline edit on this row. */
  canRename: boolean;
  canDrag: boolean;
  /** Becomes the row's data-vscode-context, so native menus and the existing
   *  command argument extractors both work unchanged. */
  context: Record<string, string | boolean>;
  tooltip: string;
  sessionId?: string;
  /** Which project this row belongs to. Every project, subproject and branch row
   *  carries it; a SESSION row carries it only when it drew a branch line, where
   *  it is what the line's links resolve through. */
  projectId?: string;
  cwd?: string;
  /** `kind === 'branch'` only: the branch this row IS. Named `chip` rather than
   *  `branch` because `branch` is already taken, on SESSION rows, by the name of
   *  the branch a session is running on — two different things that would
   *  otherwise share a field name on the same type. */
  chip?: BranchChip;
  /** Session rows only: which branch colour the NAME takes. Set only in COLOUR
   *  mode (`lineage.git.branchDisplay: color`), and only under a project with
   *  BRANCH_CHIPS_MIN branches or more — see that constant. Absent means "paint
   *  the name the way you always did", which is what every row in a single-branch
   *  or non-git project gets, and what every row gets in inline mode.
   *
   *  MUTUALLY EXCLUSIVE with `branchLine`, and that exclusion is the whole of
   *  what the two modes are: a colour says "these two are on the same thing" in
   *  no width at all and never says WHICH thing; a line says which, and costs a
   *  row's height. Both marks at once is one too many — the tint is the one that
   *  competes with the status dot the tree is actually read for. */
  branchColor?: number;
  /**
   * Session rows only: the branch, said on a SECOND LINE under this row.
   *
   * Present only under `branchDisplay: inline`, and only on the rows where
   * it says something new — a session whose checkout differs from the one above
   * it in its spine, in a project with more than one checkout. A fork made in
   * its parent's worktree gets none: repeating a branch name down a spine is
   * noise, and the spine is already drawn.
   *
   * A row carrying this is TWO LINES TALL. It is the only field in this model
   * that changes a row's height, which is why the setting behind it is off by
   * default and why `.row` can no longer assume `--row-height`.
   */
  branchLine?: SessionBranchLine;
  /** Session rows only: the branch this session's cwd is in. Always set when it
   *  is known, even where `branchColor` is not, because the hover can afford a
   *  fact the row has no width for — a single-branch project still answers
   *  "which branch is this running on" without spending a pixel. */
  branch?: string;
}

export interface ViewModelInput {
  forest: SessionForest;
  grouping: GroupingResult;
  /** Row keys the user has explicitly collapsed. Default is expanded. */
  collapsed: ReadonlySet<string>;
  /* There was an `opened` set here, the complement of `collapsed`, and exactly
   * one row kind ever used it: the branch fold, whose default was shut. That row
   * is gone — the whole block is what defaults shut now, per project and per
   * mode — so a second set with the opposite sense would be a field no row
   * reads. What the block remembers is `branchesShown` on the project
   * record, which outlives a window where this never did. */
  providerFor(sessionId: string): ProviderId;
  isBoundHere(sessionId: string): boolean;
  /** The webview's own view id, needed in the row context so `when` clauses can
   *  scope to this view (`webviewId == '<id>'`). */
  viewId: string;
  now: number;
  /** `lineage.showTokens`. Read here rather than inside the row builder so the
   *  setting is one input to a pure function and the tests can drive both states
   *  without touching a workspace configuration. */
  showTokens?: boolean;
  /** `lineage.groupSessionsByBranch`: hang a project's sessions off the branch
   *  row for the worktree they run in. Absent = off, which is the setting's
   *  default and the layout every existing test describes. */
  groupByBranch?: boolean;
  /**
   * `lineage.git.branches` — draw the branch BLOCK: a row per branch, the fold,
   * and "Others".
   *
   * The renderer's half of a gate whose other half is GroupingInput.sessionBranch.
   * That one decides whether the branch list gets BUILT, and it now says yes for
   * either of two settings; this one decides whether the list gets DRAWN, and it
   * still answers only to the block's own switch. Without the split, turning the
   * session line on would have silently added a row per branch to every project.
   *
   * Absent reads as ON — every caller that filled `branches` at all, before the
   * session line existed, meant them to be drawn, and that is every existing
   * test.
   */
  branchBlock?: boolean;
  /**
   * `lineage.git.branchDisplay` — HOW a session says which worktree it is in.
   * Two answers, and they are alternatives rather than levels:
   *
   *   color    the session's NAME is tinted from a per-branch palette, and the
   *            project's branch block is the key to it — one coloured row per
   *            checkout, open by default because a legend nobody can see is not
   *            one. No second line. What the arrows would have said lives in the
   *            hover, which is where this mode puts everything it cannot draw.
   *   inline   the branch is said in WORDS on a line under the session, and the
   *            name goes back to the theme's own colour. The block is not a
   *            legend here — nothing needs decoding — so it is shut until asked
   *            for, and it becomes the place you go to act on a branch.
   *
   * Absent reads as `inline`, matching DEFAULT_BRANCH_DISPLAY: this setting is
   * only ever read once somebody has turned the branch feature on, so there is no
   * existing tree to keep identical — the question is which mode a person meets
   * it in, and that is the one that says which branch in words.
   */
  branchDisplay?: BranchDisplay;
  /** `lineage.git.sessionBranchDetail` — how much the inline line says. Absent
   *  reads as 'standard'. Moot in colour mode, which has no line. */
  sessionBranchDetail?: SessionBranchDetail;
  /** `lineage.git.newSessionInWorktree` — whether the `+` on a project or
   *  subproject row cuts a worktree first. Absent reads as off, which is the
   *  setting's default and the button every existing test describes. Read here
   *  only to TITLE the button; what it does is decided in commands.ts, off the
   *  same setting. */
  newSessionInWorktree?: boolean;
  /** Who is running each session (src/hosts.ts). Drives the ownership token
   *  pair, the `elsewhere` marker and one hover line. Optional so an older
   *  wiring (and every unit double) renders exactly the rows it did before
   *  ownership existed: absent reads as 'hosted' everywhere. */
  hostOf?(sessionId: string): SessionHost;
  /**
   * The LABEL of the account a session is running on, or undefined for one on
   * the machine's default login.
   *
   * A hover line and nothing more, deliberately. Which subscription a
   * conversation is spending is a real fact about it — it decides what happens
   * when that account runs out, and it is the thing you need to know before
   * moving the conversation somewhere else — but it is not what a row is FOR,
   * and every account name in the description column would cost width that the
   * name, the age and the branch are already competing for. So it goes where
   * the ownership sentence and the absolute timestamps go.
   *
   * Optional, like every lookup here: absent means the hover reads exactly as
   * it did before accounts could be switched, which is every unit double.
   */
  accountLabelOf?(sessionId: string): string | undefined;
  /** Ahead/behind and dirt for one checkout, from the cache in
   *  src/gitBranches.ts. Synchronous by contract — this is called inside a
   *  paint. Absent, or returning undefined, means the branch rows carry no
   *  numbers, which is exactly how they looked before this existed. */
  branchStatusOf?(dir: string): BranchStatus | undefined;
  /** The pull request on `branch`, from the `gh` cache in src/pullRequests.ts.
   *  Synchronous by contract like the lookup above. `repoDir` is the project's
   *  MAIN worktree, so one repository is asked once however many checkouts it has.
   *  Absent, or returning undefined, means no chip — which is the default state of
   *  this feature and the way every existing test describes a branch row. */
  pullRequestFor?(repoDir: string, branch: string): PullRequest | undefined;
  /**
   * `lineage.preview.directoryModel` — the branch block belongs to a DIRECTORY
   * row rather than to the project.
   *
   * The renderer's half of the switch whose other half is
   * GroupingInput.directoryModel: that one decides which node carries the
   * branches, this one decides how they are drawn. Both read the same setting, and
   * the layout only changes when they agree — a grouping that filled
   * `SubprojectNode.branches` while the renderer ignored it would draw the tree it
   * always drew, which is the safe direction for a preview to fail in.
   *
   * Absent reads as OFF, matching the setting's default.
   */
  directoryModel?: boolean;
}

export const sessionRowKey = (id: string): string => `session:${id}`;
export const projectRowKey = (id: string): string => `project:${id}`;
export const folderRowKey = (key: string): string => `folder:${key}`;
/**
 * The directory a branch row hangs under, folded into its key — or '' for the
 * project-level block.
 *
 * Needed because a project can span two REPOSITORIES, and both of them almost
 * certainly have a branch called `main`. Two rows with one key is two rows that
 * share a collapse state, a context menu target and an identity in the
 * workbench's node map, so the second one would open and close the first. Absent
 * for the single-directory case so every existing key — and every collapse state
 * a user already has on disk — is byte-identical to the one before this existed.
 */
const branchScopeSuffix = (subprojectId?: string): string =>
  subprojectId === undefined || subprojectId === '' ? '' : `:${subprojectId}`;
/** One row per SUBPROJECT of a project, so the key names both.
 *
 *  Keyed on the subproject's `id` rather than on its directory, because two named
 *  lanes may name the SAME directory (see SubprojectRecord) and one key between
 *  them would make one row's click open and close the other. An implicit row's id
 *  is `dir:<dirKey>`, which can contain `:` on Windows — hence the project id
 *  first and a split on the first two colons only, the same rule branchRowKey
 *  follows. */
export const subprojectRowKey = (
  projectId: string,
  subprojectId: string,
): string => `subproject:${projectId}:${subprojectId}`;
/** One row per branch, so the key has to name the branch too. The name is
 *  user-controlled and may contain anything a ref can, `:` included — which is
 *  why the project id comes FIRST and the split is on the first two colons
 *  only (see branchRowParts).
 *
 *  `subprojectId` scopes it to one row of the project and is appended LAST, after
 *  the branch, so an unscoped key is byte-identical to the one this function
 *  produced before the argument existed — a user's collapsed rows survive the
 *  upgrade. See branchScopeSuffix for why the scope is needed at all. */
export const branchRowKey = (
  projectId: string,
  branch: string,
  subprojectId?: string,
): string => `branch:${projectId}:${branch}${branchScopeSuffix(subprojectId)}`;
/* The branch block had a tail row once — "Others (12)" / "Branches (183)" — and
 * it is gone. It was a fold inside a fold: the whole block is now hidden until
 * **Show Branches** is picked off the project's own menu, and a second door
 * one row further down, standing for rows you had already asked to see, was the
 * part of the layout nobody could read. What it stood for did not go anywhere —
 * **Choose Branches to Show…** on the same menu promotes any branch in the
 * repository onto the list, which is the curation decision the row was really
 * offering. */

/**
 * ONE BRANCH, one row.
 *
 * This replaced a single horizontal strip of chips, and the strip lost to a
 * fact about real repositories: branch names are long. `feat/discussion-points-
 * hawaiian-locale` and `feat/discussion-points-swedish-locale` side by side in
 * a sidebar leave room for about four characters each, so the strip spent its
 * width on ellipses and the colour did all the work. Stacked, each branch gets
 * the sidebar's whole width, which is the only place the width was ever going
 * to come from.
 *
 * The cost is real and is why the fold exists: N branches is N rows before the
 * first session. That is what `branchesShown` and the default-hidden policy
 * (defaultBranchVisibility) are for — the block is meant to be curated down to
 * the few branches you are actually working on, not to list the repository.
 *
 * By DEFAULT it is still NOT a level of the tree. A branch row is a sibling of
 * the sessions, not their parent: the tree's subject is fork lineage, and
 * nesting sessions under branches cuts every lineage that crosses a worktree
 * into pieces. It carries no rails and no status dot, and sits inside the
 * project's own band.
 *
 * `lineage.groupSessionsByBranch` makes that a CHOICE. Under it the row becomes
 * the container the flat layout refuses to make it: expandable, with the
 * sessions running in that worktree as its children. Off by default, because it
 * is the right answer only for the way of working it is named after — one agent
 * per worktree, several worktrees at once — and the wrong one for a single
 * checkout with a handful of forks in it, where it would put every row in the
 * project one level deeper for no information at all.
 */
/**
 * The context tokens on a branch row, in one place because BOTH renderers build
 * this string and a `when` clause that matched one and not the other would be a
 * menu entry that appears in one sidebar style only.
 *
 * `primary` and `pullRequest` are both SECOND tokens, never alone: every clause
 * that wants any branch row keeps matching `/;branch;/`, and the two that want a
 * subset single it out positively. The manifest never negates a viewItem regex
 * except where it already did (Hide Branch on the primary), so a fact a verb needs
 * has to be a token that is present rather than one that is absent.
 */
export function branchTokens(
  primary: boolean,
  hasPullRequest: boolean,
  /** The branch has a worktree. Defaults to TRUE so every existing caller — and
   *  every branch row that exists at all with the preview off — carries the token
   *  it always effectively had: a branch row could only come from a checkout
   *  then. See the token's own note in types.ts. */
  hasCheckout = true,
): ContextToken[] {
  const tokens: ContextToken[] = ['branch'];
  if (primary) tokens.push('primary');
  if (hasPullRequest) tokens.push('pullRequest');
  if (hasCheckout) tokens.push('checkout');
  return tokens;
}

/**
 * How long ago the branch was committed to, in the two or three characters a row
 * has room for: `2h`, `6d`, `3w`, `8mo`, `2y`.
 *
 * The fold's only content besides the name, and what turns a wall of a hundred
 * and eighty branches into something you can read down: the ones you might care
 * about are at the top, and this says how far down "today" stops. Formatted here
 * rather than by git's own `%(committerdate:relative)` for the reason every other
 * formatting decision lives in this file — the native tree and the inline sidebar
 * must not word the same fact differently — and because git's version is prose
 * ("2 days ago") where a row has room for a token.
 *
 * '' when there is nothing to say: no date was read, or the date is in the
 * future, which a clock skew between two machines sharing a repository can
 * produce and which no wording of "in -3 days" improves.
 */
export function formatBranchAge(
  committedAt: number | undefined,
  now: number,
): string {
  if (typeof committedAt !== 'number' || !Number.isFinite(committedAt)) return '';
  if (committedAt <= 0) return '';
  const seconds = Math.floor(now / 1000) - Math.floor(committedAt);
  if (seconds < 0) return '';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 9) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

function branchRow(
  el: ProjectGroupNode,
  chip: BranchChip,
  viewId: string,
  place: {
    depth: number;
    indent: number;
    expandable: boolean;
    expanded: boolean;
    /** The subproject row this block belongs to, for the row key — absent for the
     *  project-level block. See branchScopeSuffix. */
    subprojectId?: string;
    /** Pre-formatted age (see formatBranchAge), for a branch with no checkout.
     *  Passed in rather than computed here because `now` belongs to the caller. */
    age?: string;
  },
  /** The checkout's standing, for the HOVER. The chip already carries the
   *  one-token form the row draws (`chip.sync`); this is the same facts as
   *  sentences, which is a thing only the tooltip has room for. Passed rather
   *  than put on the chip so the client is never handed text it cannot use. */
  status: BranchStatus | undefined,
  /** The pull request, for the hover and for the context token. Same argument as
   *  `status`: the chip carries the four characters the row draws, and the title —
   *  which is the part worth reading — belongs in the tooltip. */
  pr: PullRequest | undefined,
): ViewRow {
  const what = chip.count
    ? `${chip.count} session${chip.count === 1 ? '' : 's'}`
    : 'no sessions yet';
  // A branch that exists only as a ref. Under the directory model most of a
  // repository's branches are these, and everything a row can offer changes:
  // there is nowhere to start a session, so the click and the `+` both go, and
  // the age takes the description column instead of a session count.
  const checkout = chip.dir !== '';
  const age = place.age ?? '';
  const row: ViewRow = {
    key: branchRowKey(el.projectId, chip.full, place.subprojectId),
    kind: 'branch',
    // Level with the sessions it sits above rather than with the header above
    // it, so the block reads as part of the project rather than as a heading.
    // Under branch grouping the sessions move one level DOWN instead, and this
    // row keeps the level they used to have.
    depth: place.depth,
    indent: place.indent,
    // The SHORT label — the client draws `label` and nothing else, and the full
    // name travels on the chip for the hover and the verbs.
    label: chip.name,
    // Grouped, the count is the only thing a COLLAPSED branch says about what
    // is inside it, which is the whole point of being able to collapse it.
    // Flat, it is noise: the sessions are already on screen underneath, in this
    // branch's colour, so the number restates them in the column the eye scans
    // for what they cannot say (see the note in media/webtree.js).
    // A branch with no checkout says its AGE instead — the one fact that makes a
    // long fold readable, and the one thing a ref can say for itself.
    description: !checkout
      ? age
      : place.expandable && chip.count > 0
        ? String(chip.count)
        : '',
    expandable: place.expandable,
    expanded: place.expandable && place.expanded,
    icon: { type: 'codicon', id: 'none' },
    // Dimmed when there is no checkout behind it: the row is a fact about the
    // repository rather than a place anything is happening, and it sits in a fold
    // full of them.
    muted: !checkout,
    closed: false,
    canRename: false,
    canDrag: false,
    rails: [],
    descends: false,
    context: {
      webviewSection: 'branch',
      webviewId: viewId,
      // Exactly the shape branchArgOf() reads, so every branch verb accepts
      // this object verbatim from a context menu or from a click.
      type: 'branch',
      projectId: el.projectId,
      dir: chip.dir,
      branch: chip.full,
      viewItem: contextValueOf(
        branchTokens(chip.primary, pr !== undefined, checkout),
      ),
      preventDefaultContextMenuItems: true,
    },
    tooltip: [
      chip.full,
      checkout
        ? `${what}${chip.attention ? ', finished work waiting' : ''}`
        : 'no checkout — this branch is a ref and nothing on disk',
      // Between the session count and the path, because it is a fact about the
      // BRANCH and the path below it is a fact about the disk. Contributes
      // nothing when the status was never read, so the hover of an unprobed row
      // is the hover it always had.
      ...branchStatusLines(status),
      // After the branch's own standing and before the path, because a pull
      // request is a fact about the branch. Contributes nothing at all with
      // `lineage.git.pullRequests` off, which is the default.
      ...pullRequestLines(pr),
      // The age, for a ref with no directory to name instead. Both would be
      // redundant: a checkout's age is one `git log` away and its path is the
      // thing you actually want to copy.
      checkout ? chip.dir : age === '' ? '' : `last commit ${age} ago`,
      checkout
        ? place.expandable
          ? 'Click to show its sessions · + starts a new one here'
          : 'Click to start a session here'
        : '+ checks it out and starts a session there',
    ]
      .filter((line) => line !== '')
      .join('\n'),
    projectId: el.projectId,
    cwd: chip.dir,
    chip,
  };
  // EVERY branch row carries the `+`, including a branch with no checkout.
  //
  // It used to be withheld there, and the argument was that a `+` on a ref would
  // have to invent a directory — `git worktree add`, a verb that writes. That
  // argument survives; what changed is where it points. Somebody looking at a
  // branch row wants a session on that branch, and whether a checkout for it
  // happens to exist yet is Flock's problem rather than a reason to make them
  // find a different verb: the `+` runs the worktree flow first and starts the
  // session in what it made. The confirmation quoting the exact `git worktree
  // add` is still there — see newSessionInBranch — so nothing writes without
  // being shown first. The button is now the one place a branch row can be
  // ACTED on, which is why it no longer waits for the row to be expandable
  // either: ungrouped, clicking a checkout row already starts a session, but a
  // ref has nothing a plain click could mean.
  row.actions = [
    {
      id: 'newSessionInBranch',
      icon: 'add',
      title: checkout
        ? `New session on ${chip.full}`
        : `New worktree and session on ${chip.full}`,
    },
  ];
  return row;
}

/**
 * ONE DIRECTORY of a project, as a row.
 *
 * A container, unlike a branch row: its children are the sessions running in
 * that directory and it expands and collapses like the project above it. That is
 * the difference in purpose — a branch row was an ANNOTATION on a flat list
 * (which is why nesting under it had to be opt-in), where a subproject row exists
 * for no other reason than to hold rows, and one that held nothing would not be
 * worth drawing.
 *
 * It carries no status dot of its own. The project's dot already rolls up
 * everything underneath it (see pushProject), and a second dot one level in would
 * say the same thing twice in the same column — the eye reads a column of dots as
 * a list of things wanting attention, and a container repeating its children's
 * mark is how that column stops meaning anything. Attention still travels: the
 * hover says so, and the sessions themselves are one click away.
 */
/**
 * A subproject row's context tokens.
 *
 * `named` is the one that matters and it is a POSITIVE token, following the rule
 * branchTokens states: the manifest matches on a token being present rather than
 * absent. Rename Subproject and Remove Subproject apply to a lane the user made;
 * neither applies to an implicit row, which is a directory of the project and is
 * governed by the project's own directory verbs.
 *
 * `primary` stays what it was — the row standing for the project's own address,
 * which Remove Subproject refuses — and can only appear on an implicit row.
 */
export function subprojectTokens(node: {
  main: boolean;
  implicit: boolean;
}): ContextToken[] {
  const tokens: ContextToken[] = ['subproject'];
  if (node.main) tokens.push('primary');
  if (!node.implicit) tokens.push('named');
  return tokens;
}

function subprojectRow(
  el: ProjectGroupNode,
  node: SubprojectNode,
  viewId: string,
  place: { depth: number; indent: number; expanded: boolean },
): ViewRow {
  const count = node.rootIds.length;
  const row: ViewRow = {
    key: subprojectRowKey(el.projectId, node.id),
    kind: 'subproject',
    depth: place.depth,
    indent: place.indent,
    label: node.label,
    // The count, and only when the row is shut. Open, the sessions are on screen
    // underneath and the number restates them; shut, it is the only thing the row
    // says about what is inside it — the same rule a collapsed branch row follows.
    description: !place.expanded && count > 0 ? String(count) : '',
    // ALWAYS expandable, even empty, exactly as a project row is: the directory
    // is a real directory whether or not anything is running in it, and a row
    // that lost its toggle when its last session ended would move the rows below
    // it for a reason the user did not cause.
    expandable: true,
    expanded: place.expanded,
    icon: { type: 'codicon', id: 'none' },
    muted: false,
    closed: false,
    // Nothing to rename: the label IS the directory's name. Renaming one would
    // mean a per-directory label on the project record — a name to invent and
    // keep true, which is the cost the directory model exists to avoid.
    canRename: false,
    canDrag: false,
    // A header, not a node in anyone's lineage — see the note in pushProject.
    rails: [],
    descends: false,
    context: {
      webviewSection: 'subproject',
      webviewId: viewId,
      // `type: 'subproject'` plus a dir and the ROW's id, which is what
      // subprojectArgOf() reads. Deliberately NOT `type: 'project'`:
      // projectIdFromArg would accept it and every project verb would then take a
      // subproject row as its target.
      //
      // `id` is what makes a verb able to name ONE of two lanes on the same
      // directory — the dir alone no longer identifies a row.
      type: 'subproject',
      projectId: el.projectId,
      dir: node.dir,
      id: node.id,
      viewItem: contextValueOf(subprojectTokens(node)),
      preventDefaultContextMenuItems: true,
    },
    tooltip: [
      node.dir,
      count === 1 ? '1 session' : `${count} sessions`,
      node.main ? 'the project’s main directory' : '',
      'Click to open and shut · + starts a session here',
    ]
      .filter((line) => line !== '')
      .join('\n'),
    projectId: el.projectId,
    cwd: node.dir,
  };
  // The `+` the project row's own would otherwise have to guess at. A project
  // with two directories cannot start a session without picking one, so the
  // button belongs on the rows that ARE the answer — the same trade the branch
  // block made, for the same reason.
  row.actions = [
    { id: 'newSessionInSubproject', icon: 'add', title: `New session in ${node.label}` },
  ];
  return row;
}

function safeProvider(
  input: ViewModelInput,
  sessionId: string,
): ProviderId | undefined {
  try {
    return input.providerFor(sessionId);
  } catch {
    return undefined;
  }
}

function safeBound(input: ViewModelInput, sessionId: string): boolean {
  try {
    return input.isBoundHere(sessionId) === true;
  } catch {
    return false;
  }
}

/** Undefined for an unwired or throwing dep, which every reader below treats as
 *  "no opinion" — the row then renders as it did before ownership existed. */
function safeHost(
  input: ViewModelInput,
  sessionId: string,
): SessionHost | undefined {
  try {
    return input.hostOf?.(sessionId);
  } catch {
    return undefined;
  }
}

/** Same contract as `safeHost`: an unwired or throwing lookup is "no opinion",
 *  and a row with no opinion about its account hovers exactly as it always
 *  did. */
function safeAccountLabel(
  input: ViewModelInput,
  sessionId: string,
): string | undefined {
  try {
    const label = input.accountLabelOf?.(sessionId);
    return typeof label === 'string' && label.trim() !== ''
      ? label.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The rendered tree, flattened depth-first in display order.
 *
 * Descends from the GROUPING's roots, never over `forest.nodes` at large: a
 * deleted or pruned-ghost node still carries a populated `visibleChildren`, so
 * a flat pass would let an invisible parent emit rows the tree never shows.
 * Walking down from the visible roots makes them unreachable by construction.
 */
export function buildViewModel(input: ViewModelInput): ViewRow[] {
  const rows: ViewRow[] = [];
  const forest = input.forest;
  const collapsed = input.collapsed;
  /** `lineage.preview.directoryModel`. Read once so no row can disagree with
   *  another about which layout it is in. */
  const dirModel = input.directoryModel === true;

  // `rails` is the ancestor-column state described on ViewRow.rails, threaded
  // down the walk because it is the one fact a row cannot work out from itself:
  // whether a rail two levels up still has something to come is a question about
  // a node this row has never met. Appending one entry per level as we descend
  // is the whole computation — `rails[k]` for a child is "the ancestor at rail
  // depth k+1 has a later sibling", and every entry but the new last one is
  // exactly what the parent was already carrying.
  // The branch context of the project currently being walked, or null under a
  // folder row / a loose root. Threaded through the walk rather than looked up
  // per session because membership is a PROJECT's answer: the same directory
  // can be a worktree of one project and merely a subdirectory of another, and
  // a global lookup would colour a row by whichever it met first.
  let branchScope: {
    branches: readonly BranchInfo[];
    colored: boolean;
    /** The repository's MAIN worktree, for the pull-request lookup — one
     *  directory per repository, so six checkouts ask `gh` once. Empty when the
     *  scope has no branches to anchor on, which the lookup reads as "no
     *  request", the same answer a project without `gh` gets. */
    repoDir: string;
    /** Whose branches these are. Carried so a session's branch LINE can name its
     *  project back to the view — the line's two links resolve through the same
     *  (projectId, dir) pair a branch row's click does, and a session row has no
     *  project of its own to read it off. */
    projectId: string;
  } | null = null;
  /** `lineage.git.branchDisplay`, read once. Two rows depend on it and they must
   *  not disagree: the line goes on exactly when the tint comes off. */
  const inlineMode = input.branchDisplay !== 'color';
  /** `lineage.git.newSessionInWorktree`, read once for the same reason: it is
   *  what every `+` in the tree TITLES itself with, and two rows disagreeing
   *  about what the button does is worse than either answer. */
  const worktreeDefault = input.newSessionInWorktree === true;
  const sessionBranchDetail: SessionBranchDetail =
    input.sessionBranchDetail === 'detailed' ? 'detailed' : 'standard';

  /**
   * The two git lookups, read through a `safe`-less contract: a lookup that
   * throws is a lookup that answered nothing, and a row with no numbers is a
   * valid row.
   *
   * At buildViewModel scope rather than inside pushProject because the branch
   * BLOCK and the line under a SESSION both ask them, and two copies of a
   * try/catch around the same cache is how one of them ends up handling a throw
   * differently from the other.
   */
  const statusFor = (dir: string): BranchStatus | undefined => {
    try {
      return input.branchStatusOf?.(dir);
    } catch {
      return undefined;
    }
  };
  const prFor = (repoDir: string, branch: string): PullRequest | undefined => {
    if (repoDir === '') return undefined;
    try {
      return input.pullRequestFor?.(repoDir, branch);
    } catch {
      return undefined;
    }
  };
  /** The repository's anchor for a set of branches: ONE directory per project,
   *  so a project with six checkouts asks `gh` once for an answer that is the
   *  same from any of them. The main worktree, because git lists it first and
   *  buildBranches keeps it first, which makes it the one stable choice. */
  const repoDirOf = (branches: readonly BranchInfo[]): string =>
    (branches.find((b) => b.primary) ?? branches[0])?.dir ?? '';

  // The preorder list, indexed, so a project row can find the children it has
  // to draw underneath itself. Built once per model rather than per row.
  const projectById = new Map(
    input.grouping.projects.map((p) => [p.projectId, p] as const),
  );
  /** Projects already emitted this pass. `computeGrouping` cannot produce a
   *  cycle (buildProjectTree breaks them), but this function is also handed
   *  hand-built groupings by callers and by tests, and a renderer that can be
   *  made to recurse forever is a renderer that can hang the extension host. */
  const drawnProjects = new Set<string>();

  const pushSession = (
    id: string,
    depth: number,
    rails: boolean[],
    indent: number,
    /** Which branch the row ABOVE this one in the spine is on, as an index into
     *  the current scope — or -1 for a root, which has nothing above it and
     *  therefore always says its branch. Threaded rather than looked up because
     *  it is the same kind of fact `rails` is: a question about a node this row
     *  has never met. */
    parentBranchAt = -1,
  ): void => {
    const node = forest.nodes.get(id);
    if (!node) return;
    const key = sessionRowKey(id);
    const expandable = node.visibleChildren.length > 0;
    const expanded = expandable && !collapsed.has(key);

    // "How long since I last SPOKE to this" is the useful number for every row,
    // live or closed — not "how long has it existed", and not "when did
    // anything last happen in it". The three sources, in the order they are
    // trusted:
    //
    //   lastPromptAt  the last request the user sent, out of the transcript
    //                 tail. This is what the column means. The two below it
    //                 are fallbacks for when it cannot be read, not
    //                 alternatives to it.
    //   lastActiveAt  the transcript's mtime. Moves for every token Claude
    //                 writes, so an unattended agentic run reads as "now" — a
    //                 poor answer, but a real one.
    //   startedAt     a session too new for either sweep to have covered.
    const basis = node.lastPromptAt ?? node.lastActiveAt ?? node.startedAt;
    const age = formatAge(input.now - (basis ?? Number.NaN));
    const status = statusDescriptor(node);
    // Tokens sit LEFT of the age: the age is the thing you scan a column of,
    // so it keeps the position it has always had, hard against the dot.
    const tokens = input.showTokens === true ? formatTokens(node.tokens) : '';
    const host = safeHost(input, id);
    // The grace countdown — the words that make the one detached-running
    // state a VISIBLE state. After the age and the status fact, because those
    // two keep the positions every row gives them; NEWS still beats the
    // standing host marker behind it.
    const grace =
      node.graceDeadlineAt !== undefined
        ? formatGraceCountdown(node.graceDeadlineAt - input.now)
        : '';
    // What the session concluded — the level-2 question, answered on the one
    // kind of row that has no tab to answer it in. Only archived rows spend
    // the width: a live conversation's last line is on screen in its own tab,
    // and a ghost never said anything.
    const snippet = node.archived ? sessionSnippet(node) : '';
    // 'elsewhere' — one quiet word, and only on a row Flock does not own. It
    // goes LAST, after the age and after whatever a waiting session is waiting
    // for, because it is a standing fact about the row rather than news: what
    // you scan the column for is still the age.
    const description = [
      tokens,
      age,
      status,
      grace,
      snippet,
      hostMarker(host ?? 'none') ?? '',
      node.hidden ? 'hidden' : '',
    ]
      .filter((p) => p !== '')
      .join(' · ');

    // A muted row cannot use the brand svg: it has to read as greyed, and a
    // file-backed image is not recolourable. eye-closed also says WHY it is
    // grey. A ghost is inferred, so claiming a provider for it would be a
    // made-up fact.
    let icon: RowIcon;
    if (node.hidden) icon = { type: 'codicon', id: 'eye-closed', tone: 'muted' };
    else if (node.ghost) {
      icon = { type: 'codicon', id: 'circle-slash', tone: 'brand' };
    } else {
      const provider = safeProvider(input, id);
      icon =
        provider === undefined
          ? { type: 'codicon', id: 'sparkle', tone: 'brand' }
          : { type: 'provider', provider };
    }

    const contextValue = sessionContextValue(node, safeBound(input, id), host);

    // One dot, at the right edge. statusTone() withholds a tone from a row that
    // has been put away or has nothing to report; badgeGlyph() then withholds
    // the glyph from 'idle', which is a tone with a word but no mark.
    const tone = statusTone(node);
    const badge = badgeGlyph(tone);
    // Ghosts are excluded on purpose: an inferred ancestor was never a session
    // of yours that ran and stopped, so dimming it as finished would claim a
    // history it does not have. It still gets the 'closed' TONE — see
    // statusTone() — which is what the hover reads back.
    const closed = !node.ghost && (node.archived || node.status === 'exited');

    const row: ViewRow = {
      key,
      kind: 'session',
      depth,
      indent,
      label: node.label,
      description,
      expandable,
      expanded,
      icon,
      muted: node.hidden,
      closed,
      // Ghosts have no transcript and no editorial identity worth naming.
      canRename: !node.ghost,
      // Only a row at the TOP of its group drags. What a drag can change is
      // which project a session is filed under, and a row drawn inside a tree
      // has no filing of its own — it is wherever the session it branched from
      // is. Lineage itself is not draggable at all; see webtree.onDrop for why.
      //
      // `rails` is the question, not `depth` and not `parentId`. `depth` counts
      // the project and directory rows above this one too, so every session
      // under a project would fail it. `rails` is empty for exactly the rows
      // pushed from a group's `rootIds` and non-empty for every row pushed by
      // the child recursion — i.e. it is precisely "is this drawn inside a
      // tree", which is the rule as the user reads it off the screen. It also
      // agrees with `forest.visibleRoots` (the guard the drop side applies)
      // including on a PROMOTED child, whose parent row is not on screen and
      // which is therefore a root in both senses.
      canDrag: !node.ghost && rails.length === 0,
      rails,
      descends: expanded,
      context: {
        webviewSection: 'session',
        webviewId: input.viewId,
        // `id` is what sessionIdFromArg() reads, so every existing per-session
        // verb accepts this object verbatim.
        id,
        viewItem: contextValue,
        lineageMuted: node.hidden,
        preventDefaultContextMenuItems: true,
      },
      tooltip: sessionTooltip(
        node,
        description,
        closed,
        host,
        safeAccountLabel(input, id),
      ),
      sessionId: id,
    };
    // Resolved against the session's OWN cwd, not its parent's: a fork made in
    // a different worktree is a different branch, and inheriting the parent's
    // colour down the spine is exactly the wrong answer for the case the
    // colours exist to show.
    const branchAt =
      branchScope === null
        ? -1
        : branchIndexForCwd(branchScope.branches, node.cwd);
    if (branchAt >= 0 && branchScope !== null) {
      const branch = branchScope.branches[branchAt];
      row.branch = branch.name;
      // The colour is withheld below the threshold; the NAME is not — see
      // ViewRow.branch.
      if (branchScope.colored) row.branchColor = branch.colorIndex;
      row.tooltip += `\nbranch: ${branch.name}`;
      // The second line, on the rows where it says something the row above did
      // not. `parentBranchAt` is the whole of that test: -1 for a root, so every
      // root speaks, and equal for a fork that stayed in its parent's checkout,
      // so it stays quiet. Compared as INDEXES into one scope rather than by
      // name — two directories of a project can be two repositories with a
      // branch called `main` in each, and by name those would read as the same
      // checkout.
      //
      // Suppressed under branch GROUPING, where the branch row this session
      // hangs off already says it, one line up and in bigger type.
      if (
        inlineMode &&
        branchAt !== parentBranchAt &&
        branchScope.branches.length >= BRANCH_CHIPS_MIN &&
        input.groupByBranch !== true
      ) {
        // ONE lookup of each, reused by the line and by the hover below. Not two
        // that happen to agree: `prFor` is a cache read on a render path, and a
        // row that asked twice would double the traffic through it for an answer
        // it already had.
        const status = statusFor(branch.dir);
        const pr =
          sessionBranchDetail === 'detailed'
            ? prFor(branchScope.repoDir, branch.name)
            : undefined;
        row.branchLine = sessionBranchLine(
          branch.name,
          status,
          pr,
          sessionBranchDetail,
          branch.dir,
        );
        // The project the line's links resolve against. Set HERE and only here —
        // on a session row it means "the project whose branch this line names",
        // which is a claim only a row carrying a branch line can make.
        row.projectId = branchScope.projectId;
        // AND THE SAME FACTS IN SENTENCES, which is what a hover is for. The
        // line itself is four glyphs and a number; a green mark and `↑4 *` are
        // exactly the kind of shorthand that has to be spelled out SOMEWHERE,
        // and this is the row's one tooltip. The same two functions the native
        // tree's branch row hovers with, so the words do not differ by surface.
        const lines = [...branchStatusLines(status), ...pullRequestLines(pr)];
        if (lines.length > 0) row.tooltip += `\n${lines.join('\n')}`;
      }
    }
    // A struck-through bell, right of the name. Muting is a decision the user
    // made about ONE session and then has no way to see: the dot it suppresses
    // is, by definition, the thing that would have told them. Without a mark on
    // the row, a session that has gone quiet because it was muted is
    // indistinguishable from one that has gone quiet because nothing happened.
    if (node.notifyMuted === true) {
      row.marks = [{ icon: 'bell-slash', title: 'Notifications hidden' }];
    }
    if (node.cwd !== undefined) row.cwd = node.cwd;
    // The two travel separately: badgeKind is set whenever there is a tone at
    // all, because the client keys the dot column's width on it and 'idle'
    // collapsing that column is the stylesheet's decision, not this one. badge
    // is set only when the tone has a character standing for it.
    if (tone !== undefined) row.badgeKind = tone;
    if (badge !== undefined) row.badge = badge;
    rows.push(row);

    if (expanded) {
      const kids = node.visibleChildren;
      for (let i = 0; i < kids.length; i++) {
        // The appended entry is this row's rail seen from the child: it carries
        // on below the child unless the child is the last one hanging off it.
        // `indent` is passed straight down: a fork is nested by the SPINE, not
        // by padding, and the project it is filed under has not changed.
        //
        // `branchAt` goes down as the child's parentBranchAt — THIS row's
        // checkout, not the one the walk started at, so a fork that moved
        // worktrees says so and a fork under it that moved back says so again.
        pushSession(
          kids[i],
          depth + 1,
          [...rails, i < kids.length - 1],
          indent,
          branchAt,
        );
      }
    }
  };

  const pushProject = (el: ProjectGroupNode): void => {
    if (drawnProjects.has(el.projectId)) return;
    drawnProjects.add(el.projectId);
    const key = projectRowKey(el.projectId);
    const branches = el.branches ?? [];
    // `active` is "this project has enough branches for the block to be worth
    // rows"; `branchBlock` is "the user asked for branch rows at all". They came
    // apart when the session line got its own switch: the grouping now fills
    // `branches` for EITHER switch, so a non-empty list no longer implies that
    // anybody wants it drawn. See ViewModelInput.branchBlock.
    const active = branches.length >= BRANCH_CHIPS_MIN && input.branchBlock !== false;
    // The project's directories, once there is more than one of them. When there
    // are, THEY hold the sessions and the project row holds nothing but them.
    const subprojects = el.subprojects ?? [];
    const split = subprojects.length > 0;
    // Where this project sits in the PROJECT tree, and therefore how far in
    // everything it draws is pushed. `depth` doubles as the outline level: a
    // subproject's row is a child of its parent's row, and its own contents
    // start one level below that.
    const level = Math.max(0, el.depth ?? 0);
    // Branch grouping and a directory split are two answers to "what are this
    // project's sessions filed under", and a row cannot be under both. The
    // DIRECTORY wins: it is the structure the user typed in, where grouping by
    // branch is a view preference — and a session claimed by a branch row and a
    // subproject row at once would be drawn twice.
    const grouped = active && !split && input.groupByBranch === true;
    // See statusFor / prFor / repoDirOf, which every branch-shaped row in this
    // model shares. `prOf` binds the anchor once so the branch rows below — and
    // the directory block nested inside this function — all ask about the same
    // repository, which is the property the anchor exists to have.
    const repoDir = repoDirOf(branches);
    const prOf = (branch: string): PullRequest | undefined =>
      prFor(repoDir, branch);
    const toChip = (b: BranchInfo): BranchChip => {
      const status = statusFor(b.dir);
      const sync = formatBranchSync(status);
      const pr = prFor(repoDir, b.name);
      return {
        name: b.name,
        full: b.name,
        dir: b.dir,
        // Colour mode only — see BranchChip.colorIndex.
        ...(inlineMode ? {} : { colorIndex: b.colorIndex }),
        // The state mark and the star, placed exactly as the line under a
        // session places them: one vocabulary, whichever row you are reading.
        glyph: branchStateIcon(pr),
        ...(pr === undefined ? {} : { state: pr.state }),
        ...(branchIsDirty(status) ? { dirty: true as const } : {}),
        count: b.rootIds.length,
        attention: subtreeHasUnseen(forest, b.rootIds),
        primary: b.primary,
        // Absent rather than '' — see the field's note: a row with nothing to
        // report must cost no width.
        ...(sync === '' ? {} : { sync }),
        ...(pr === undefined
          ? {}
          : {
              pr: {
                label: formatPullRequestChip(pr),
                state: pr.state,
                checks: pr.checks,
              },
            }),
      };
    };
    // The block splits into what is on screen and what "Others" stands for.
    // Both halves are needed even when the block is FOLDED: the fold hides the
    // rows, and the project row still has to say how many there were.
    const chips: BranchChip[] = active
      ? branches.filter((b) => b.shown).map(toChip)
      : [];
    const hiddenCount = active
      ? branches.filter((b) => !b.shown).length
      : 0;
    // SHUT UNTIL ASKED FOR, in both modes and on every project.
    //
    // A project with six checkouts was six rows before its first session, for
    // everybody who turned the feature on, forever. Nothing about a branch row
    // is urgent: which branch a session is on is said on the session's own row,
    // and the block is where you go to ACT on a branch — start a session there,
    // cut or remove a worktree. That is occasional, and occasional things are
    // asked for rather than kept on screen.
    //
    // `branchesShown === true` is the ONLY thing that draws it — a positive
    // record, written by **Show Branches** and remembered per project, so a
    // repository you work this way stays open. Absent and false both read as
    // shut, which is what every project that has never been asked gets.
    //
    // The ONE exception is `lineage.groupSessionsByBranch`: there the branch
    // rows are what the sessions hang off, so hiding them by default would
    // silently undo the setting the user just turned on.
    // THE FOLD IS THE PROJECT'S, NOT THE PROJECT-LEVEL BLOCK'S — and that
    // distinction is a bug fix, not a refinement. `active` is false for a SPLIT
    // project under the directory model, because there the branches live on the
    // directory rows and `el.branches` is empty by design (see computeGrouping).
    // Reading the fold through `active` therefore left every directory block
    // drawing its rows unasked, which is the one thing the fold exists to stop.
    //
    // So `blockFolded` answers only "has this project been asked to show its
    // branches", and each block below applies it to whatever branches it has.
    const blockFolded = grouped ? el.branchesShown === false : el.branchesShown !== true;
    const folded = active && blockFolded;
    // How many branches the fold's own button stands for. The project's list
    // when it has one, its directories' lists summed when the directory model
    // moved them there — the button says "Show 6 branches" either way, and a
    // count that only knew about one of the two shapes would say nothing at all
    // on exactly the projects this feature is for.
    const dirBranchCount = subprojects.reduce(
      (n, node) => n + (node.branches ?? []).length,
      0,
    );
    // Whether there is a BLOCK to fold at all, in either shape. The toggle is
    // drawn off this, so a split project under the directory model gets one too.
    const hasBlock =
      input.branchBlock !== false &&
      (active || (dirModel && dirBranchCount >= BRANCH_CHIPS_MIN));
    const foldCount = active ? chips.length : dirBranchCount;
    // Always expandable, even empty: collapsing an empty project would hide the
    // only affordance it has, and an expandable row with nothing under it reads
    // correctly as "nothing running here yet".
    const expanded = !collapsed.has(key);
    // The attention dot BUBBLES UP — a project containing an unseen-done
    // session carries the dot itself, so a collapsed (or merely long) project
    // still shows there is something to come back to. The same way an unread
    // count rolls up from a row to the group it sits in.
    //
    // And it rolls up everything filed UNDER the project, too. A collapsed
    // parent is the only thing on screen standing for its subprojects, so a
    // finished session three levels down has to light it — otherwise collapsing
    // a project is a way to lose the notification the dot exists to carry.
    const hasUnseen = subtreeHasUnseen(forest, descendantRootIds(projectById, el));
    const row: ViewRow = {
      key,
      kind: 'project',
      depth: level,
      indent: level,
      label: el.label,
      // NOTHING. Not a session count — the rows underneath are the count — and
      // no longer the extra-directory count either. `+1 dir` was true and
      // useless: it restated a fact you set up once and never think about
      // again, in the widest, most-read row in the tree, next to the one place
      // a project has to say something that changes. The directories are still
      // in the hover, which is where a permanent fact belongs.
      description: '',
      expandable: true,
      expanded,
      // A project is a container, not a session — it has no LLM logo to claim,
      // and drawing one over a folder of possibly-mixed providers would just be
      // wrong. 'none' tells the client to render an empty glyph box; the
      // section-header treatment in webtree.css (background band, bold label,
      // hidden icon column) is what says "this is a root" instead. The native
      // tree keeps a real ThemeIcon (tree.ts's projectItem) because it has no
      // equivalent CSS to lean on.
      icon: { type: 'codicon', id: 'none' },
      muted: false,
      // A container is never over: a project outlives every session under it,
      // and an empty one is waiting rather than finished.
      closed: false,
      canRename: true,
      // A project row no longer drags. It used to, onto another project row, to
      // file itself there as a subproject — and there is nothing left for that
      // gesture to mean: a subproject is a directory now, and a project is not a
      // directory you can hand to another project. A draggable row with no legal
      // target is a control that does nothing, so the row stops offering it.
      canDrag: false,
      // A project is a section header, not the top of a lineage: it carries the
      // same toggle the sessions do, but no rail runs from it down to the roots
      // underneath. Those roots are separate lineages that happen to be filed
      // here, and a spine joining them would draw a parent-child relationship
      // that does not exist — the one thing this tree is for.
      rails: [],
      descends: false,
      context: {
        webviewSection: 'project',
        webviewId: input.viewId,
        // What projectIdFromArg() reads.
        type: 'project',
        projectId: el.projectId,
        viewItem: projectContextValue(el),
        preventDefaultContextMenuItems: true,
      },
      tooltip: [el.label, ...el.dirs].join('\n'),
      projectId: el.projectId,
      // The chat lives on the PROJECT row and nowhere else — it is a
      // conversation about the project as a whole, so a session row offering
      // one would be offering something that does not exist.
      //
      // `newSession` sits to the RIGHT of it, which is the order they are
      // reached for: the chat is the throwaway question, the `+` is the piece
      // of work. Starting one is the single most common thing anybody does on
      // a project row.
      //
      // THE `+` IS BACK ON EVERY PROJECT AND EVERY SUBPROJECT, unconditionally.
      // It used to be withdrawn wherever branch rows or directory rows were on
      // screen, because a `+` on the project has to pick a directory and it
      // picks rootDir — a silent guess, next to rows that answer the same
      // question explicitly. What makes it honest again is
      // `lineage.git.newSessionInWorktree`: the button now has a stated meaning
      // in both positions — start here, or cut a worktree and start there — and
      // the title says which, on every row, before it is clicked. A guess you
      // can read is not a guess.
      //
      // The FOLD sits leftmost, before both, because it is the only one that
      // acts on the rows below rather than creating something new.
      //
      // A BRANCH GLYPH, not a chevron. A chevron is the tree's own word for
      // "this row opens", and it is already spoken twice on this row — by the
      // twisty at its left, which opens the project. A third one, pointing the
      // same way and opening something else, says only "more of the same is
      // below"; the git-branch mark says WHAT is below, which is the one thing
      // the button has to answer before it is worth a slot.
      //
      // The same glyph in both positions, deliberately. The state is the block
      // itself — rows on screen or not — and a button that changed shape to
      // report a fact already occupying six rows would be the third mark for it.
      actions: [
        ...(hasBlock
          ? [
              {
                id: blockFolded ? 'unfoldBranches' : 'foldBranches',
                icon: 'git-branch',
                title: blockFolded
                  ? `Show ${foldCount} branch${foldCount === 1 ? '' : 'es'}`
                  : 'Hide branches',
              },
            ]
          : []),
        // "New chat", because that is what the button does every time. A label
        // that just said "Chat" described a place you went back to, which is
        // exactly the behaviour that changed — and the old chats are one
        // right-click away under View Chat History.
        { id: 'chat', icon: 'chat', title: `New chat in ${el.label}` },
        {
          id: 'newSession',
          icon: 'add',
          title: worktreeDefault
            ? `New session in a new worktree of ${el.label}`
            : `New session in ${el.label}`,
        },
      ],
    };
    if (hasUnseen) {
      row.badge = STATUS_DOT;
      row.badgeKind = 'done';
      row.tooltip += '\ncontains a finished session you have not looked at';
    }
    if (hiddenCount > 0) {
      row.tooltip += `\n${hiddenCount} branch${hiddenCount === 1 ? '' : 'es'} not shown`;
    }
    rows.push(row);
    if (!expanded) return;

    /**
     * ONE DIRECTORY'S BRANCH BLOCK: the promoted rows, then the fold, then every
     * branch inside the fold when it is open.
     *
     * The directory model's renderer, and the only one that draws a branch with
     * no checkout. Shared by both places a directory row can be — the project row
     * of a single-directory project, and each subproject row of a split one —
     * because those are the same thing at two indents, and two copies of this
     * would eventually disagree about what a fold contains.
     *
     * Returns the sessions no promoted branch took, for the caller to draw under
     * the directory itself. Nothing is ever dropped: that return value plus the
     * rows pushed here account for every id handed in.
     */
    const pushDirectoryBranches = (opts: {
      branches: readonly BranchInfo[];
      rootIds: readonly string[];
      /** Absent for the project-level block — see branchScopeSuffix. */
      subprojectId?: string;
      depth: number;
      indent: number;
    }): readonly string[] => {
      // The row this block hangs off — the project header, or the directory row
      // — is the last one pushed before any of these. It is what carries the
      // "not shown" count, so it is caught before the block adds rows of its own.
      const foldOwnerAt = rows.length - 1;
      const promoted = opts.branches.filter((b) => b.shown);
      const inFold = opts.branches.filter((b) => !b.shown);
      const scope =
        opts.subprojectId === undefined ? {} : { subprojectId: opts.subprojectId };
      // NESTING HAS TO BUY SOMETHING. It costs every session under this directory
      // a level, so it applies only when there is more than one promoted branch to
      // tell apart — the same threshold, and the same argument, as BRANCH_CHIPS_MIN
      // itself. An ordinary repository with one checkout and four sessions draws
      // them directly under the directory, exactly as a project with no repository
      // does.
      const nest = promoted.length >= BRANCH_CHIPS_MIN;

      for (const branch of promoted) {
        const chip = toChip(branch);
        const chipKey = branchRowKey(el.projectId, chip.full, opts.subprojectId);
        // A branch with nothing in it stays a plain click-to-start row: an
        // expandable row that opens onto nothing is a control that does not work.
        const expandableChip = nest && chip.count > 0;
        rows.push(
          branchRow(
            el,
            chip,
            input.viewId,
            {
              depth: opts.depth,
              indent: opts.indent,
              expandable: expandableChip,
              expanded: !collapsed.has(chipKey),
              ...scope,
              age: formatBranchAge(branch.lastCommitAt, input.now),
            },
            statusFor(chip.dir),
            prOf(chip.full),
          ),
        );
        if (!expandableChip || collapsed.has(chipKey)) continue;
        for (const id of branch.rootIds) {
          pushSession(id, opts.depth + 1, [], opts.indent);
        }
      }

      // NOTHING FOR THE REST OF THE REPOSITORY, and that is the change: the rows
      // behind `inFold` used to sit under a "Branches (183)" fold at the tail of
      // this block. A fold inside a fold — the block itself is now hidden until
      // **Show Branches** is picked off the directory's menu — is one door too
      // many, and it was the row nobody could read: an italic header with a
      // number, three indents deep, standing for rows that were never asked for.
      //
      // The branches did not become unreachable. **Choose Branches to Show…** on
      // the same menu lists every one of them and promotes what you pick onto
      // this block permanently, which is the decision the fold was really
      // offering — and it costs a modal instead of a hundred and eighty rows.
      //
      // What the fold row said that nothing else did is the COUNT, so it moves
      // onto the hover of the row this block belongs to. "There are 178 more"
      // is the fact that sends somebody to the menu; without it the menu is a
      // door with nothing written on it.
      if (inFold.length > 0 && rows.length > 0) {
        const owner = rows[foldOwnerAt];
        if (owner) {
          owner.tooltip +=
            `\n${inFold.length} branch${inFold.length === 1 ? '' : 'es'} not shown`;
        }
      }

      return nest ? unbranchedRoots(opts.rootIds, promoted) : opts.rootIds;
    };

    // Sessions of this project that the branch block will NOT account for:
    // everything, in the flat layout; only what is not under a shown branch,
    // in the grouped one.
    //
    // `!folded` matters and is not belt-and-braces: folding the block hides the
    // branch ROWS, so under grouping it would also take their children with it
    // — a fold that quietly removed four running sessions from the tree. Folded,
    // every session comes back to sitting directly under the project, which is
    // exactly what folding the block asks for.
    let loose: readonly string[] =
      grouped && !folded ? unbranchedRoots(el.rootIds, branches) : el.rootIds;

    // Between the header and the sessions, stacked one per row and wearing the
    // project's own band so the whole thing reads as one box: you read which
    // branches this project has, then the sessions filed under them.
    //
    // Inside the project's collapse (a collapsed project shows nothing about
    // its contents, and its branches are part of its contents) AND inside its
    // own fold, which is the finer control — see the chevron above.
    //
    // The scope covers every branch, SHOWN OR NOT. A session on a hidden branch
    // still gets that branch's colour: hiding is a statement about how many
    // rows the block is worth, never about the sessions underneath, and a
    // session that lost its colour because you tidied the list above it would
    // read as having moved.
    // `colored: active && !inlineMode` is the mutual exclusion, made in the
    // one place both surfaces read — see ViewRow.branchColor.
    branchScope = {
      branches,
      colored: active && !inlineMode,
      repoDir,
      projectId: el.projectId,
    };
    if (!blockFolded && dirModel && !split) {
      // THE PROJECT ROW IS ITS DIRECTORY when there is only one of them, so its
      // branches hang here — one indent in, exactly where the checkouts used to.
      loose = pushDirectoryBranches({
        branches,
        rootIds: el.rootIds,
        depth: level + 1,
        indent: level,
      });
    } else if (!blockFolded) {
      for (const chip of chips) {
        // Grouped, a branch with nothing in it stays a plain click-to-start
        // row: an expandable row that opens onto nothing is a control that
        // does not work, and starting a session there is exactly what you
        // reach an empty worktree for.
        const expandableChip = grouped && chip.count > 0;
        const chipKey = branchRowKey(el.projectId, chip.full);
        rows.push(
          branchRow(
            el,
            chip,
            input.viewId,
            {
              depth: level + 1,
              indent: level,
              expandable: expandableChip,
              expanded: !collapsed.has(chipKey),
            },
            statusFor(chip.dir),
            prOf(chip.full),
          ),
        );
        if (!expandableChip || collapsed.has(chipKey)) continue;
        const branch = branches.find((b) => b.name === chip.full);
        for (const id of branch?.rootIds ?? []) {
          pushSession(id, level + 2, [], level + 1);
        }
      }
      // No tail row for the branches that are NOT shown — see the note in
      // pushDirectoryBranches. The count still reaches the user: it is on the
      // project row's hover, and **Choose Branches to Show…** on its menu is the
      // picker the row used to open.
    }

    // SPLIT BY DIRECTORY. Each of the project's directories, in the order the
    // project lists them (main first), with the sessions running in it as its
    // children — so nothing is `loose` and the project row draws no sessions of
    // its own.
    //
    // Every session the project claimed is in exactly one of these rows
    // (buildSubprojects files a worktree session under the directory that owns the
    // repository, so there is nothing left over), which is what makes this safe to
    // do instead of the flat list rather than as well as it: the split cannot lose
    // a row.
    if (split) {
      for (const node of subprojects) {
        const subKey = subprojectRowKey(el.projectId, node.id);
        const open = !collapsed.has(subKey);
        // `indent: level + 1` on the row AND on its sessions, which mirrors
        // exactly what a project header does with its own: a header and the rows
        // filed under it share an x, and the band plus the bold label are what say
        // which is the heading (see the note in media/webtree.js). One level in
        // from the project is what makes the containment readable.
        rows.push(
          subprojectRow(el, node, input.viewId, {
            depth: level + 1,
            indent: level + 1,
            expanded: open,
          }),
        );
        if (!open) continue;
        // THE DIRECTORY'S OWN REPOSITORY. Its branches, then whatever they did
        // not account for — which is every session when the directory has one
        // branch or none, i.e. in every project that is not being run one agent
        // per worktree.
        const dirBranches = node.branches ?? [];
        let dirLoose: readonly string[] = node.rootIds;
        if (dirModel && dirBranches.length > 0) {
          // Scoped per directory, so a session takes the colour of the branch it
          // is on IN ITS OWN repository — two directories of one project can be
          // two repositories, and a shared scope would colour a session by a
          // branch of the wrong one.
          //
          // Set even while the block is FOLDED, and that is the point: the scope
          // is what the line under a session resolves its branch through, and
          // that line is drawn whether or not the rows above it are.
          branchScope = {
            branches: dirBranches,
            colored: dirBranches.length >= BRANCH_CHIPS_MIN && !inlineMode,
            repoDir: repoDirOf(dirBranches),
            projectId: el.projectId,
          };
          if (blockFolded) {
            for (const id of dirLoose) pushSession(id, level + 2, [], level + 1);
            branchScope = null;
            continue;
          }
          dirLoose = pushDirectoryBranches({
            branches: dirBranches,
            rootIds: node.rootIds,
            subprojectId: node.id,
            depth: level + 2,
            indent: level + 1,
          });
        }
        for (const id of dirLoose) pushSession(id, level + 2, [], level + 1);
        branchScope = null;
      }
      branchScope = null;
      for (const childId of el.childProjectIds ?? []) {
        const child = projectById.get(childId);
        if (child) pushProject(child);
      }
      return;
    }

    // What is left over: every session in the flat layout, and in the grouped
    // one the ones no shown branch claimed — a session on a folded-away branch,
    // or in a directory of the project that is not in the repository at all.
    // They keep their place directly under the project rather than being
    // dropped, because a view OPTION that silently hides rows is a filter
    // wearing a layout's name.
    for (const id of loose) pushSession(id, level + 1, [], level);
    branchScope = null;

    // Then everything filed under this project, each with its own band, its own
    // branches and its own sessions. Depth-first, so a subproject's rows sit
    // between it and the next sibling — which is what makes the indent readable
    // as containment rather than as decoration.
    for (const childId of el.childProjectIds ?? []) {
      const child = projectById.get(childId);
      if (child) pushProject(child);
    }
  };

  const pushFolder = (el: GroupNode): void => {
    const key = folderRowKey(el.key);
    const expanded = !collapsed.has(key);
    rows.push({
      key,
      kind: 'folder',
      depth: 0,
      label: el.label,
      description: el.cwd,
      expandable: true,
      expanded,
      icon: { type: 'codicon', id: 'folder' },
      muted: false,
      closed: false,
      canRename: false,
      canDrag: false,
      // A folder heads a section, not a lineage — see pushProject.
      rails: [],
      descends: false,
      context: {
        webviewSection: 'folder',
        webviewId: input.viewId,
        // What groupCwdFromArg() reads — including cwd '' for "(no directory)".
        type: 'group',
        cwd: el.cwd,
        key: el.key,
        viewItem: contextValueOf(['group']),
        preventDefaultContextMenuItems: true,
      },
      tooltip: el.cwd !== '' ? `${el.label}\n${el.cwd}` : el.label,
      cwd: el.cwd,
    });
    if (!expanded) return;
    for (const id of el.rootIds) pushSession(id, 1, [], 0);
  };

  // Only the ROOTS are walked from here; each one emits its own subtree (see
  // the tail of pushProject). `grouping.projects` is a preorder list, so
  // filtering it to depth 0 keeps the top-level order exactly as it was.
  for (const project of input.grouping.projects) {
    if ((project.depth ?? 0) === 0) pushProject(project);
  }
  for (const folder of input.grouping.folders) pushFolder(folder);
  for (const id of input.grouping.loose) pushSession(id, 0, [], 0);

  // The "Running elsewhere" appendix, LAST and collapsed by default (the host
  // seeds its key into the collapsed set — see webtree.ts): running sessions
  // the fences filtered out keep one row here so the machine-wide badge always
  // has rows to point at. A ledger, not a workspace, hence the tail position.
  const elsewhere = input.grouping.elsewhere;
  if (elsewhere !== null) {
    const key = folderRowKey(elsewhere.key);
    const expanded = !collapsed.has(key);
    rows.push({
      key,
      kind: 'folder',
      depth: 0,
      label: elsewhere.label,
      description: `${elsewhere.rootIds.length}`,
      expandable: true,
      expanded,
      icon: { type: 'codicon', id: 'server-process' },
      muted: false,
      closed: false,
      canRename: false,
      canDrag: false,
      rails: [],
      descends: false,
      context: {
        webviewSection: 'elsewhere',
        webviewId: input.viewId,
        key: elsewhere.key,
        // Its own token, NOT 'group': the folder verbs (hide, open in window)
        // act on a directory this row does not have.
        viewItem: contextValueOf(['elsewhere']),
        preventDefaultContextMenuItems: true,
      },
      tooltip:
        'Running sessions this window’s filters would otherwise hide — ' +
        'other folders’ work, or closed projects’. Each still costs ' +
        'this machine memory; close or route them from here.',
      cwd: '',
    });
    if (expanded) {
      for (const id of elsewhere.rootIds) pushSession(id, 1, [], 0);
    }
  }

  return rows;
}

/** Every session filed under a project OR under anything nested inside it —
 *  the roll-up the attention dot on a collapsed parent is computed over. */
function descendantRootIds(
  byId: ReadonlyMap<string, ProjectGroupNode>,
  el: ProjectGroupNode,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (node: ProjectGroupNode): void => {
    if (seen.has(node.projectId)) return;
    seen.add(node.projectId);
    out.push(...node.rootIds);
    for (const childId of node.childProjectIds ?? []) {
      const child = byId.get(childId);
      if (child) walk(child);
    }
  };
  walk(el);
  return out;
}

/** Tone → the word for it. The mark at the right edge is the only place state
 *  appears on the row, and neither a colour nor a shape is a label: this is what
 *  the hover, and any screen reader, gets to read instead. */
const TONE_WORDS: Record<StatusTone, string> = {
  idle: 'idle',
  running: 'running',
  done: 'finished — waiting on you',
  closed: 'closed',
};

/** `undefined` for anything that is not a finite epoch-ms number, so callers
 *  can push-if-defined without a try/catch at every call site. */
function isoOrUndefined(ms: number | undefined): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
  try {
    return new Date(ms).toISOString();
  } catch {
    return undefined;
  }
}

function sessionTooltip(
  node: SessionNode,
  description: string,
  closed: boolean,
  host?: SessionHost,
  accountLabel?: string,
): string {
  const lines: string[] = [node.label, node.id];
  const tone = statusTone(node);
  // A row that has been put away has no tone by design — that is what putting
  // it away means. It must not also cost the hover the one fact nothing else on
  // a muted row carries: whether the session is over or still running. 'closed'
  // is the only tone word that survives being hidden.
  if (tone !== undefined) lines.push(TONE_WORDS[tone]);
  else if (closed) lines.push(TONE_WORDS.closed);
  // The sentence behind the row's countdown: what "closing in 9m" means, and
  // the absolute deadline the relative words are computed from — the same
  // relative-on-the-row, absolute-in-the-hover deal the age gets below.
  if (node.graceDeadlineAt !== undefined) {
    const deadline = isoOrUndefined(node.graceDeadlineAt);
    lines.push(
      'detached: tab closed, process kept for instant re-attach' +
        (deadline !== undefined ? ` — closes at ${deadline}` : ''),
    );
  }
  if (description !== '') lines.push(description);
  // The age in `description` is relative ("5m"); these are the absolute
  // timestamps it is computed from, spelled out for anyone who wants to know
  // exactly when rather than roughly how long ago. All three are listed, in the
  // order the age falls back through them, so a row whose age looks wrong shows
  // WHICH source it came from rather than leaving that to be guessed.
  const started = isoOrUndefined(node.startedAt);
  if (started !== undefined) lines.push(`started: ${started}`);
  const lastPrompt = isoOrUndefined(node.lastPromptAt);
  if (lastPrompt !== undefined) lines.push(`last prompt: ${lastPrompt}`);
  const lastActive = isoOrUndefined(node.lastActiveAt);
  if (lastActive !== undefined) lines.push(`last active: ${lastActive}`);
  // Always in the hover, whatever `lineage.showTokens` says: the setting is
  // about what the ROW is worth carrying, and a hover costs no width.
  if (typeof node.tokens === 'number' && Number.isFinite(node.tokens)) {
    lines.push(`context: ${node.tokens.toLocaleString('en-US')} tokens`);
  }
  // The one fact the native tree has nowhere else to put it: that surface draws
  // no bell (a TreeItem gets one icon, and it is the provider's), so the hover
  // is where a muted session says so on both surfaces.
  if (node.notifyMuted === true) {
    lines.push('notifications: hidden for this session');
  }
  // The row's marker is one word; this is the sentence behind it. Worth the
  // hover on both surfaces because 'elsewhere' answers "why does this row have
  // fewer verbs than the one above it" only once you know what it means.
  const ownership = hostTooltipLine(host ?? 'none');
  if (ownership !== undefined) lines.push(ownership);
  // Below the ownership sentence and above the directory, because the three
  // read as one group: who is running this, whose subscription it spends, and
  // where. Absent for a conversation on the machine's default login, which is
  // every session on a single-account machine — a line saying "account:
  // default" under every row would be a line nobody ever needs.
  if (accountLabel !== undefined) lines.push(`account: ${accountLabel}`);
  if (node.cwd) lines.push(node.cwd);
  if (node.summary) lines.push(`summary: ${node.summary}`);
  // The fallback conclusion, only where no summary was written: the hover
  // gets the longer text (bounded at capture — usage.LAST_EXCHANGE_MAX_CHARS)
  // where the archived row itself carries at most SNIPPET_MAX_CHARS. The cap
  // here is a formality sessionSnippet needs, not a second budget.
  else if (node.lastExchange !== undefined) {
    const exchange = sessionSnippet(node, 4000);
    if (exchange !== '') lines.push(`last exchange: ${exchange}`);
  }
  if (node.hidden) lines.push('hidden: sorted last, not counted in the badge');
  return lines.join('\n');
}

/** True when a session in (or under) `rootIds` is unseen-done. Walks
 *  visibleChildren, so a row removed from view can never light a dot no click
 *  can clear. */
export function subtreeHasUnseen(
  forest: SessionForest,
  rootIds: readonly string[],
): boolean {
  const seen = new Set<string>();
  const stack = [...rootIds];
  for (;;) {
    const id = stack.pop();
    if (id === undefined) return false;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = forest.nodes.get(id);
    if (!node) continue;
    if (node.unseen === true && !node.hidden) return true;
    stack.push(...node.visibleChildren);
  }
}

/** Sessions DEMANDING the user that are actually ON SCREEN, for the view badge.
 *  This is "rows whose dot is lit for attention": unseen-done sessions where
 *  tracking is on, waiting sessions where it is off — one definition, shared
 *  with statusTone, so the number on the view container always equals the dots
 *  in the tree. Counted over the rendered rows rather than the raw forest, so a
 *  session removed by a hidden folder / hidden project / onlyProjectSessions
 *  never leaves a permanent count with no row anywhere to open or dismiss.
 *  Collapsed rows still count — they are one click from view, and their ancestor
 *  is on screen. */
export function attentionCountOf(
  forest: SessionForest,
  grouping: GroupingResult,
): number {
  const roots = [
    ...grouping.projects.flatMap((p) => p.rootIds),
    ...grouping.folders.flatMap((g) => g.rootIds),
    ...grouping.loose,
    // The "Running elsewhere" appendix renders rows too — a waiting session
    // in it shows its dot, so the count must see it or badge and dots argue.
    ...(grouping.elsewhere?.rootIds ?? []),
  ];
  const seen = new Set<string>();
  const stack = [...roots];
  let count = 0;
  for (;;) {
    const id = stack.pop();
    if (id === undefined) break;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = forest.nodes.get(id);
    if (!node) continue;
    if (statusTone(node) === 'done') count++;
    stack.push(...node.visibleChildren);
  }
  return count;
}

/**
 * RUNNING sessions on this MACHINE — level 1 and the grace countdown together
 * — for the view-container badge.
 *
 * This is the levels invariant as a number: "no running process without a
 * visible row" is only checkable if the count of processes is on the
 * container, and the incident this design answers was 84 detached sessions
 * that no surface anywhere counted. The predicate is exactly
 * sessionContextValue's `live` — not a status filter, because a live row with
 * an UNKNOWN status is still a process this machine is paying for.
 *
 * Counted over the whole FOREST, machine-wide — deliberately NOT the rendered
 * traversal attentionCountOf uses. Attention is a per-window ask ("what on
 * this screen wants me"), but a running process costs the machine the same
 * memory whichever window looks at it, so every window's badge shows the same
 * number and none can under-report. The rows keep up with the count from the
 * other side: a filtered-out RUNNING session renders in the "Running
 * elsewhere" group (GroupingResult.elsewhere) instead of being dropped, so
 * the badge is never a number with nothing on screen to point at. (A HIDDEN —
 * muted — row still counts here and is excluded by attentionCountOf: muting
 * silences the dot, not the process.)
 */
export function runningCountOf(forest: SessionForest): number {
  let count = 0;
  for (const node of forest.nodes.values()) {
    if (!node.ghost && !node.archived && node.status !== 'exited') count++;
  }
  return count;
}

/**
 * Does this root's subtree contain a RUNNING process? The grouping's
 * `hasRunning` lookup (GroupingInput) for both view styles: the pure grouping
 * pass decides which filtered roots are rescued into the "Running elsewhere"
 * group, and liveness is a forest fact it cannot see. Same predicate as
 * runningCountOf, over the VISIBLE children — a running descendant deep in
 * the lineage keeps the whole root's row exactly because dropping the root
 * would drop the descendant with it.
 */
export function subtreeHasRunning(
  forest: SessionForest,
  rootId: string,
): boolean {
  const seen = new Set<string>();
  const stack = [rootId];
  for (;;) {
    const id = stack.pop();
    if (id === undefined) return false;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = forest.nodes.get(id);
    if (!node) continue;
    if (!node.ghost && !node.archived && node.status !== 'exited') return true;
    stack.push(...node.visibleChildren);
  }
}
