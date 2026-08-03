// IMPLEMENTED BY: M9 — the inline-rename sidebar.
//
// PURE. Imports ./types and ./projects and NOTHING else — no vscode, no node.
// This is the whole rendering decision for the tree, expressed as a flat list of
// serializable rows, so it can be unit-tested without a workbench AND posted
// straight into a webview.
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
  ContextToken,
  GroupNode,
  ProjectGroupNode,
  ProviderId,
  SessionForest,
  SessionNode,
} from './types';
import { branchIndexForCwd, unbranchedRoots } from './projects';
import type { GroupingResult } from './projects';

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

/** How the status dot is lit: 'running' amber, 'done' red. 'idle' and (since
 *  M19) 'closed' are tones with NO glyph — the row is known-quiet or known-over,
 *  which is worth a word in the hover and worth drawing nothing for, because a
 *  tree where every quiet row still carries a mark teaches the eye to ignore
 *  marks. They stay distinct tones rather than collapsing into one because the
 *  renderers key other things on them (a closed row is dimmed; an idle one is
 *  not) and the hover names them differently.
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
 * M12 makes 'done' mean UNSEEN done, the cmux unread model: once you have
 * looked at a finished session its dot goes back to quiet, and a session that
 * finished a turn while you were elsewhere lights up even if it is merely
 * idle. `unseen === undefined` (tracking off for this session, or an input
 * that predates M12) keeps the pre-M12 reading: waiting = done.
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
 *  M19: only the two LIT tones draw. 'closed' used to get a hollow ring, on the
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
): string {
  const tokens: ContextToken[] = ['session'];
  const live = !node.ghost && !node.archived && node.status !== 'exited';

  // Muted rows offer Unhide where the others offer Hide. Exactly one of the two
  // is always present, so neither menu entry needs a negated `when` clause.
  tokens.push(node.hidden ? 'hidden' : 'shown');
  // The same shape for the notification mute (M19): the row says which half of
  // the pair applies, so the menu shows "Hide Notifications" or "Show
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
  }

  if (node.source === 'minted') tokens.push('ours');
  if (boundHere) tokens.push('bound');
  tokens.push(node.parentId ? 'forked' : 'root');

  return contextValueOf(tokens);
}

export function projectContextValue(el: ProjectGroupNode): string {
  const tokens: ContextToken[] = ['project'];
  if (el.rootIds.length === 0) tokens.push('empty');
  // M26. Two independent facts about where the row sits, each a positive token
  // so a `when` clause never has to negate a viewItem regex: a middle project
  // carries both, a leaf under a root only the first, a root with children only
  // the second, and a lone top-level project neither — which is every project
  // anybody had before nesting existed.
  if (typeof el.parentProjectId === 'string' && el.parentProjectId !== '') {
    tokens.push('subproject');
  }
  if ((el.childProjectIds?.length ?? 0) > 0) tokens.push('parentProject');
  return contextValueOf(tokens);
}

// ------------------------------------------------------------------ rows

export type RowKind =
  | 'project'
  | 'folder'
  | 'session'
  /** M20. ONE branch, on its own row, inside the project's band. */
  | 'branch'
  /** M20. The tail row of a branch block: "Others (12)", which opens a picker
   *  of the branches this project is not currently showing. Its own kind rather
   *  than a branch with a flag, because nothing that applies to a branch —
   *  hiding it, copying its name, starting a session on it — applies to this. */
  | 'branchOthers';

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
  colorIndex: number;
  /** Live sessions filed under this branch. Drawn only when non-zero. */
  count: number;
  /** A session on this branch is finished-and-unlooked-at. The same roll-up the
   *  project row does (M12), one level finer: the project's own dot says only
   *  THAT something is waiting, and the branch row says WHICH branch. */
  attention: boolean;
  /** The repository's main worktree. Drawn no differently, but the hide verb
   *  refuses it — see hideBranch. */
  primary: boolean;
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
   * M26. How many SECTION levels of plain padding stand to the left of this
   * row, before anything it draws itself.
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
   * project — i.e. the pre-M26 layout, unchanged to the pixel.
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
  projectId?: string;
  cwd?: string;
  /** M20, `kind === 'branch'` only: the branch this row IS. Named `chip` rather
   *  than `branch` because `branch` is already taken, on SESSION rows, by the
   *  name of the branch a session is running on — two different things that
   *  would otherwise share a field name on the same type. */
  chip?: BranchChip;
  /** M20, `kind === 'branchOthers'` only: how many branches are folded away
   *  behind this row. Always ≥ 1 — the row is not emitted at zero. */
  othersCount?: number;
  /** M20, session rows only: which branch colour the NAME takes. Set only under
   *  a project with BRANCH_CHIPS_MIN branches or more — see that constant.
   *  Absent means "paint the name the way you always did", which is what every
   *  row in a single-branch or non-git project gets. */
  branchColor?: number;
  /** M20, session rows only: the branch this session's cwd is in. Always set
   *  when it is known, even where `branchColor` is not, because the hover can
   *  afford a fact the row has no width for — a single-branch project still
   *  answers "which branch is this running on" without spending a pixel. */
  branch?: string;
}

export interface ViewModelInput {
  forest: SessionForest;
  grouping: GroupingResult;
  /** Row keys the user has explicitly collapsed. Default is expanded. */
  collapsed: ReadonlySet<string>;
  providerFor(sessionId: string): ProviderId;
  isBoundHere(sessionId: string): boolean;
  /** The webview's own view id, needed in the row context so `when` clauses can
   *  scope to this view (`webviewId == '<id>'`). */
  viewId: string;
  now: number;
  /** M18. `lineage.showTokens`. Read here rather than inside the row builder so
   *  the setting is one input to a pure function and the tests can drive both
   *  states without touching a workspace configuration. */
  showTokens?: boolean;
  /** M26. `lineage.groupSessionsByBranch`: hang a project's sessions off the
   *  branch row for the worktree they run in. Absent = off, which is the
   *  setting's default and the layout every existing test describes. */
  groupByBranch?: boolean;
}

export const sessionRowKey = (id: string): string => `session:${id}`;
export const projectRowKey = (id: string): string => `project:${id}`;
export const folderRowKey = (key: string): string => `folder:${key}`;
/** One row per branch, so the key has to name the branch too. The name is
 *  user-controlled and may contain anything a ref can, `:` included — which is
 *  why the project id comes FIRST and the split is on the first two colons
 *  only (see branchRowParts). */
export const branchRowKey = (projectId: string, branch: string): string =>
  `branch:${projectId}:${branch}`;
export const othersRowKey = (projectId: string): string =>
  `others:${projectId}`;

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
 * first session. That is what `branchesCollapsed` and the default-hidden policy
 * (defaultBranchVisibility) are for — the block is meant to be curated down to
 * the few branches you are actually working on, not to list the repository.
 *
 * By DEFAULT it is still NOT a level of the tree. A branch row is a sibling of
 * the sessions, not their parent: the tree's subject is fork lineage, and
 * nesting sessions under branches cuts every lineage that crosses a worktree
 * into pieces. It carries no rails and no status dot, and sits inside the
 * project's own band.
 *
 * M26 makes that a CHOICE. Under `lineage.groupSessionsByBranch` the row
 * becomes the container the flat layout refuses to make it: expandable, with
 * the sessions running in that worktree as its children. Off by default,
 * because it is the right answer only for the way of working it is named after
 * — one agent per worktree, several worktrees at once — and the wrong one for
 * a single checkout with a handful of forks in it, where it would put every row
 * in the project one level deeper for no information at all.
 */
function branchRow(
  el: ProjectGroupNode,
  chip: BranchChip,
  viewId: string,
  place: { depth: number; indent: number; expandable: boolean; expanded: boolean },
): ViewRow {
  const what = chip.count
    ? `${chip.count} session${chip.count === 1 ? '' : 's'}`
    : 'no sessions yet';
  const row: ViewRow = {
    key: branchRowKey(el.projectId, chip.full),
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
    description: place.expandable && chip.count > 0 ? String(chip.count) : '',
    expandable: place.expandable,
    expanded: place.expandable && place.expanded,
    icon: { type: 'codicon', id: 'none' },
    muted: false,
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
        chip.primary ? ['branch', 'primary'] : ['branch'],
      ),
      preventDefaultContextMenuItems: true,
    },
    tooltip: [
      chip.full,
      `${what}${chip.attention ? ', finished work waiting' : ''}`,
      chip.dir,
      place.expandable
        ? 'Click to show its sessions · + starts a new one here'
        : 'Click to start a session here',
    ].join('\n'),
    projectId: el.projectId,
    cwd: chip.dir,
    chip,
  };
  // Grouped, a click TOGGLES the row, so the verb it used to run needs a button
  // of its own — the same trade the project header made when the chips took its
  // `+` away, in the other direction. Ungrouped there is no button: the whole
  // row already is one.
  if (place.expandable) {
    row.actions = [
      { id: 'newSessionInBranch', icon: 'add', title: `New session on ${chip.full}` },
    ];
  }
  return row;
}

/**
 * The tail of a branch block: "Others (12)".
 *
 * The door to everything the block is not showing, and the reason the default
 * policy can afford to be aggressive about hiding. Without it, a project with
 * twenty worktrees would either cost twenty rows or silently lose eighteen of
 * them; with it, the block stays the size of the work in flight and the rest is
 * one click away.
 *
 * Deliberately NOT a branch row with a flag. Nothing that applies to a branch
 * applies here — there is no worktree to start a session in, no name to copy,
 * nothing to hide — so it carries its own context token and its own verb.
 */
function othersRow(
  el: ProjectGroupNode,
  count: number,
  viewId: string,
  place: { depth: number; indent: number },
): ViewRow {
  return {
    key: othersRowKey(el.projectId),
    kind: 'branchOthers',
    depth: place.depth,
    indent: place.indent,
    label: 'Others',
    // The count is the whole content of this row: it is the difference between
    // "there is more" and "there are twelve more", and the second is what
    // decides whether you go looking.
    description: String(count),
    expandable: false,
    expanded: false,
    icon: { type: 'codicon', id: 'none' },
    muted: true,
    closed: false,
    canRename: false,
    canDrag: false,
    rails: [],
    descends: false,
    context: {
      webviewSection: 'branchOthers',
      webviewId: viewId,
      type: 'project',
      projectId: el.projectId,
      viewItem: contextValueOf(['branchOthers']),
      preventDefaultContextMenuItems: true,
    },
    tooltip: `${count} branch${count === 1 ? '' : 'es'} not shown in ${el.label}\nClick to choose which to show`,
    projectId: el.projectId,
    othersCount: count,
  };
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
  let branchScope: { branches: readonly BranchInfo[]; colored: boolean } | null =
    null;

  // M26. The preorder list, indexed, so a project row can find the children it
  // has to draw underneath itself. Built once per model rather than per row.
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
    //                 tail (M18). This is what the column means. The two below
    //                 it are fallbacks for when it cannot be read, not
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
    const description = [tokens, age, status, node.hidden ? 'hidden' : '']
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

    const contextValue = sessionContextValue(node, safeBound(input, id));

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
      canDrag: !node.ghost,
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
      tooltip: sessionTooltip(node, description, closed),
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
        pushSession(kids[i], depth + 1, [...rails, i < kids.length - 1], indent);
      }
    }
  };

  const pushProject = (el: ProjectGroupNode): void => {
    if (drawnProjects.has(el.projectId)) return;
    drawnProjects.add(el.projectId);
    const key = projectRowKey(el.projectId);
    const branches = el.branches ?? [];
    const active = branches.length >= BRANCH_CHIPS_MIN;
    // M26. Where this project sits in the PROJECT tree, and therefore how far
    // in everything it draws is pushed. `depth` doubles as the outline level:
    // a subproject's row is a child of its parent's row, and its own contents
    // start one level below that.
    const level = Math.max(0, el.depth ?? 0);
    const grouped = active && input.groupByBranch === true;
    const toChip = (b: BranchInfo): BranchChip => ({
      name: b.name,
      full: b.name,
      dir: b.dir,
      colorIndex: b.colorIndex,
      count: b.rootIds.length,
      attention: subtreeHasUnseen(forest, b.rootIds),
      primary: b.primary,
    });
    // The block splits into what is on screen and what "Others" stands for.
    // Both halves are needed even when the block is FOLDED: the fold hides the
    // rows, and the project row still has to say how many there were.
    const chips: BranchChip[] = active
      ? branches.filter((b) => b.shown).map(toChip)
      : [];
    const hiddenCount = active
      ? branches.filter((b) => !b.shown).length
      : 0;
    const folded = active && el.branchesCollapsed === true;
    // Always expandable, even empty: collapsing an empty project would hide the
    // only affordance it has, and an expandable row with nothing under it reads
    // correctly as "nothing running here yet".
    const expanded = !collapsed.has(key);
    // M12: the attention dot BUBBLES UP — a project containing an unseen-done
    // session carries the dot itself, so a collapsed (or merely long) project
    // still shows there is something to come back to. cmux does the same
    // pane → workspace → group roll-up.
    // M26: including everything filed UNDER it. A collapsed parent is the only
    // thing on screen standing for its subprojects, so a finished session three
    // levels down has to light it — otherwise collapsing a project is a way to
    // lose the notification the dot exists to carry.
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
      // M26. A project row DRAGS now: onto another project row it becomes that
      // project's subproject, onto the background it goes back to the top
      // level. The same gesture the Explorer moves a folder with, and the
      // reason nesting does not need a dialog to be usable.
      canDrag: true,
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
      // M16: the chat lives on the PROJECT row and nowhere else — it is a
      // conversation about the project as a whole, so a session row offering
      // one would be offering something that does not exist.
      //
      // `newSession` sits to the RIGHT of it, which is the order they are
      // reached for: the chat is the throwaway question, the `+` is the piece
      // of work. Starting one is the single most common thing anybody does on
      // a project row and it was previously two clicks through a context menu.
      //
      // M20 WITHDRAWS the `+` once the chip row is present. A `+` on the
      // project has to pick a directory for you, and it picks rootDir — which,
      // for somebody running one agent per worktree, is the one checkout they
      // are least likely to have meant. With chips on screen every branch is a
      // click and each one says where it starts; keeping a button whose whole
      // job is a silent guess at the same question, right next to the row that
      // answers it explicitly, is how you get sessions in the wrong worktree.
      // Below the threshold there are no chips and the `+` is still the only
      // one-click way to start anything, so it stays.
      // The FOLD sits leftmost of the three, because it is the only one that
      // acts on the rows below rather than creating something new — and because
      // it must not move when the `+` comes and goes.
      actions: [
        ...(active
          ? [
              {
                id: folded ? 'unfoldBranches' : 'foldBranches',
                icon: folded ? 'chevron-right' : 'chevron-down',
                title: folded
                  ? `Show ${chips.length} branch${chips.length === 1 ? '' : 'es'}`
                  : 'Hide branches',
              },
            ]
          : []),
        // M24: "New chat", because that is what the button now does every
        // time. A label that just said "Chat" described a place you went back
        // to, which is exactly the behaviour that changed — and the old chats
        // are one right-click away under View Chat History.
        { id: 'chat', icon: 'chat', title: `New chat in ${el.label}` },
        ...(active
          ? []
          : [
              {
                id: 'newSession',
                icon: 'add',
                title: `New Session in ${el.label}`,
              },
            ]),
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

    // Sessions of this project that the branch block will NOT account for:
    // everything, in the flat layout; only what is not under a shown branch,
    // in the grouped one.
    //
    // `!folded` matters and is not belt-and-braces: folding the block hides the
    // branch ROWS, so under grouping it would also take their children with it
    // — a fold that quietly removed four running sessions from the tree. Folded,
    // every session comes back to sitting directly under the project, which is
    // exactly what folding the block asks for.
    const loose =
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
    branchScope = { branches, colored: active };
    if (!folded) {
      for (const chip of chips) {
        // Grouped, a branch with nothing in it stays a plain click-to-start
        // row: an expandable row that opens onto nothing is a control that
        // does not work, and starting a session there is exactly what you
        // reach an empty worktree for.
        const expandableChip = grouped && chip.count > 0;
        const chipKey = branchRowKey(el.projectId, chip.full);
        rows.push(
          branchRow(el, chip, input.viewId, {
            depth: level + 1,
            indent: level,
            expandable: expandableChip,
            expanded: !collapsed.has(chipKey),
          }),
        );
        if (!expandableChip || collapsed.has(chipKey)) continue;
        const branch = branches.find((b) => b.name === chip.full);
        for (const id of branch?.rootIds ?? []) {
          pushSession(id, level + 2, [], level + 1);
        }
      }
      // Last, after every branch that IS shown, because it is the tail of the
      // list rather than a peer of it: everything above is on screen, and this
      // is the door to what is not.
      if (hiddenCount > 0) {
        rows.push(
          othersRow(el, hiddenCount, input.viewId, {
            depth: level + 1,
            indent: level,
          }),
        );
      }
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

  // M26. Only the ROOTS are walked from here; each one emits its own subtree
  // (see the tail of pushProject). `grouping.projects` is a preorder list, so
  // filtering it to depth 0 keeps the top-level order exactly as it was.
  for (const project of input.grouping.projects) {
    if ((project.depth ?? 0) === 0) pushProject(project);
  }
  for (const folder of input.grouping.folders) pushFolder(folder);
  for (const id of input.grouping.loose) pushSession(id, 0, [], 0);

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
): string {
  const lines: string[] = [node.label, node.id];
  const tone = statusTone(node);
  // A row that has been put away has no tone by design — that is what putting
  // it away means. It must not also cost the hover the one fact nothing else on
  // a muted row carries: whether the session is over or still running. 'closed'
  // is the only tone word that survives being hidden.
  if (tone !== undefined) lines.push(TONE_WORDS[tone]);
  else if (closed) lines.push(TONE_WORDS.closed);
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
  if (node.cwd) lines.push(node.cwd);
  if (node.summary) lines.push(`summary: ${node.summary}`);
  if (node.hidden) lines.push('hidden: sorted last, not counted in the badge');
  return lines.join('\n');
}

/** True when a session in (or under) `rootIds` is unseen-done (M12). Walks
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

/** Sessions DEMANDING the user that are actually ON SCREEN, for the view
 *  badge. Since M12 this is "rows whose dot is lit for attention": unseen-done
 *  sessions where tracking is on, waiting sessions where it is off — one
 *  definition, shared with statusTone, so the number on the view container
 *  always equals the dots in the tree. Counted over the rendered rows rather
 *  than the raw forest, so a session removed by a hidden folder / hidden
 *  project / onlyProjectSessions never leaves a permanent count with no row
 *  anywhere to open or dismiss. Collapsed rows still count — they are one
 *  click from view, and their ancestor is on screen. */
export function attentionCountOf(
  forest: SessionForest,
  grouping: GroupingResult,
): number {
  const roots = [
    ...grouping.projects.flatMap((p) => p.rootIds),
    ...grouping.folders.flatMap((g) => g.rootIds),
    ...grouping.loose,
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
