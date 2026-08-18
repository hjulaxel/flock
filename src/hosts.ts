// src/hosts.ts — WHO is running a session, and therefore what Flock may
// honestly offer to do about it.
//
// Pure: it imports ./types and nothing else — never vscode, never node — so
// every rule below is a table lookup a test can drive with an object literal.
//
// THE PROBLEM THIS FILE EXISTS TO FIX. `claude agents --json` is machine-wide,
// so the tree has always shown sessions Flock never started: `claude` typed
// into the panel terminal, the official Claude Code extension, another editor,
// another shell. That is the feature — you get the tree, the ages and the
// attention dots for all of them for free. What it is not is a claim of
// OWNERSHIP, and the row used to make no distinction: the same context menu
// offered Close and Close with Summary on a session whose process Flock cannot
// signal, on a pty it cannot touch, in a window that does not have it. Close
// then wrote `closed: <iso>` onto the record, warned in a toast that the
// session was still running, and left a row whose editorial state and whose
// process disagreed. One message in one place (`focusSession`'s "Flock cannot
// adopt a tab from") already said the true thing; nothing else did.
//
// So ownership becomes one function, and every surface asks it: the row's
// context tokens (which verbs the menu shows), the row's marker and hover
// (what the user is told), and the verbs themselves (which refuse, and with
// what sentence).
//
// THE EVIDENCE, and why it is only ever these five facts. Flock cannot ask the
// operating system "does a VS Code terminal own this pid" — there is no such
// API — so ownership is inferred from what Flock itself recorded. Every fact
// below is one Flock wrote down at the time it acted:
//
//   boundHere      this window holds a terminal bound to the session. The one
//                  fact that needs no record at all.
//   boundWindowId  that SOME window's terminal hosted it (state.ts). Set on
//                  every bind, nulled on exit and by window pruning.
//   tmuxName       a workspace switch parked it into the private tmux server,
//                  so the conversation is running detached and is ours.
//   launchedByUs   Flock started it. A live session we launched whose tab we
//                  can no longer see is still ours — another window has it, or
//                  a wrap nothing recorded is holding it (see
//                  commands.detachedTmuxName).
//   live           the roster still reports it. Ownership is not a question a
//                  finished session asks.
//
// CONSERVATIVE BY CONSTRUCTION, in one direction only: a session is called
// FOREIGN only when every one of those facts is absent. Being wrong the other
// way costs a menu entry that refuses; being wrong this way would put a Close
// on a conversation Flock has no business ending, which is the failure this
// module exists to remove.

import type { EditorialRecord, ProviderId } from './types';

/**
 * Who is running a session, as far as Flock can honestly tell.
 *
 * Four values rather than a boolean, because the three "ours" cases want
 * different sentences and different verbs: a tab in this window can be
 * revealed, one in another window can be jumped to, a parked wrap can be
 * reattached, and a foreign process can only be forked.
 */
export type SessionHost =
  /** A terminal in THIS window is bound to it. Every verb applies. */
  | 'here'
  /** Flock's, but not this window's: another Flock window holds the tab, a
   *  workspace switch parked it into the private tmux server, or Flock
   *  launched it and has since lost sight of the tab. Reachable — the focus
   *  verb has a tier for each — and endable through the path that owns it. */
  | 'flock'
  /** Live, and nothing Flock ever recorded says it was Flock's: the official
   *  Claude Code extension, `claude` typed into a terminal, another editor,
   *  another user's shell. Read-only for us. */
  | 'foreign'
  /** Not running. A closed row has no host, and asking which one would only
   *  produce a marker on every archived session in the tree. */
  | 'none';

/** What `hostOf` needs to know, gathered by the caller because the answers come
 *  from three different places (the forest, the terminal registry, the state
 *  store) and this module is not allowed to import any of them. */
export interface HostFacts {
  /** The roster reports this session right now. */
  live: boolean;
  /** A terminal in THIS window is bound to it (TerminalRegistry.isBoundHere). */
  boundHere: boolean;
  /** `EditorialRecord.boundWindowId`, over the whole generation chain.
   *
   *  Its PRESENCE is the fact, never which window it names — deliberately. A
   *  record naming this window with no live binding is an ordinary state (a
   *  reload drops bindings, and `reassociate()` restores them a moment later),
   *  and calling that foreign for one tick would flicker the row's marker and
   *  withhold its Close. So "some window had this" is the whole question, and
   *  every answer to it is 'flock'. */
  boundWindowId?: string | null;
  /** `EditorialRecord.tmux` — the private-server session a park detached it
   *  into. A kill-tier park writes `null` deliberately, which is why an empty
   *  string and null both count as absent. */
  tmuxName?: string | null;
  /** `EditorialRecord.launchedByUs`. */
  launchedByUs?: boolean;
}

function present(v: string | null | undefined): boolean {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Who is running this session. See SessionHost for the four answers and the
 * header for why the evidence is exactly these facts.
 *
 * Order is load-bearing. `boundHere` wins outright: it is direct observation,
 * and a record left over from a previous window must never outrank a terminal
 * we are holding right now. Liveness is checked next because a closed session
 * has no host — its record may still name a window and a wrap, both of which
 * describe a process that has since exited.
 */
export function hostOf(facts: HostFacts | null | undefined): SessionHost {
  if (!facts) return 'none';
  if (facts.boundHere === true) return 'here';
  if (facts.live !== true) return 'none';
  if (present(facts.tmuxName)) return 'flock';
  if (present(facts.boundWindowId)) return 'flock';
  if (facts.launchedByUs === true) return 'flock';
  return 'foreign';
}

/**
 * The same question over a whole generation chain.
 *
 * A conversation that has been resumed or compacted lives under a newer id
 * while its editorial record — including `launchedByUs`, `boundWindowId` and
 * the parked wrap's name — sits on an OLDER one (see generations.ts, which
 * deliberately does not carry those forward). Asking about the tip alone would
 * call every re-keyed session of ours foreign the moment it re-minted.
 *
 * `ids` is the chain, tip first; the first record that carries a fact supplies
 * it. `boundHere` is asked of the ids, not of a record, because the registry is
 * keyed by the id the terminal is bound under, which a re-key moves.
 */
export function hostOfChain(
  ids: readonly string[],
  io: {
    live(id: string): boolean;
    boundHere(id: string): boolean;
    record(id: string): EditorialRecord | undefined;
  },
): SessionHost {
  const chain = (ids ?? []).filter((id) => typeof id === 'string' && id !== '');
  if (chain.length === 0) return 'none';

  const facts: HostFacts = { live: false, boundHere: false };
  for (const id of chain) {
    try {
      if (io.boundHere(id)) facts.boundHere = true;
      if (io.live(id)) facts.live = true;
    } catch {
      // A throwing dependency is not evidence of anything. Leave the fact
      // unset, which can only move the answer toward 'foreign' — the value
      // that offers the fewest verbs.
    }
    let record: EditorialRecord | undefined;
    try {
      record = io.record(id);
    } catch {
      record = undefined;
    }
    if (!record) continue;
    if (facts.boundWindowId === undefined && present(record.boundWindowId)) {
      facts.boundWindowId = record.boundWindowId;
    }
    if (facts.tmuxName === undefined && present(record.tmux)) {
      facts.tmuxName = record.tmux;
    }
    if (record.launchedByUs === true) facts.launchedByUs = true;
  }
  return hostOf(facts);
}

/** Can Flock END this session — close the tab and stop the process — from
 *  anywhere? False for a foreign one, where "close" can only ever write a
 *  timestamp onto a record while the conversation carries on running. */
export function canEndSession(host: SessionHost): boolean {
  return host !== 'foreign';
}

/** The quiet marker a row wears. Only the foreign case gets one: a word on
 *  every row says nothing about any of them, and the three "ours" cases are
 *  the tree's normal state. */
export function hostMarker(host: SessionHost): string | undefined {
  return host === 'foreign' ? 'elsewhere' : undefined;
}

/** The hover line, spelling out what the one-word marker cannot. */
export function hostTooltipLine(host: SessionHost): string | undefined {
  if (host !== 'foreign') return undefined;
  return (
    'running outside Flock — the tree, its age and its dot are read-only here; ' +
    'fork it to get a copy you own'
  );
}

/**
 * The sentence a refusing verb says, naming the host rather than the verb.
 *
 * "Flock cannot close this" tells the user what did not happen; "this session
 * is running outside Flock" tells them why, which is the half they can act on.
 * One wording, shared by the focus dialog, the close refusal and the wrap
 * refusal, so the same fact never goes by three names on three surfaces.
 */
export function hostSentence(
  host: SessionHost,
  opts?: { label?: string; pid?: number },
): string {
  const label = opts?.label;
  const who = label !== undefined && label !== '' ? `"${label}"` : 'This session';
  const pid =
    typeof opts?.pid === 'number' && Number.isInteger(opts.pid) && opts.pid > 0
      ? ` (pid ${opts.pid})`
      : '';
  switch (host) {
    case 'here':
      return `${who} is open in this window.`;
    case 'flock':
      return `${who} is a Flock session running in another window or parked in the background.`;
    case 'foreign':
      return (
        `${who} is running outside Flock${pid} — in a terminal, the Claude Code ` +
        'extension, or another app. Flock did not start it and cannot take over ' +
        'its conversation.'
      );
    default:
      return `${who} is not running.`;
  }
}

// ------------------------------------------------------- launch delegation
//
// The other half of "work with whatever the user already uses": let Flock's own
// new/fork verbs hand the launch to somebody else's extension, and then bind the
// session that turns up on the roster back onto the tree row.
//
// A TABLE rather than an `if` on one extension id, because the shape of the
// question is per-delegate and there will be more than one: the same three
// facts (which extension, which command, what to call it) are what a Codex or
// Gemini extension would need, and adding one is then one entry rather than a
// second code path. Today there is exactly one entry, and saying so in a table
// is cheaper than pretending the abstraction does not exist.

/** `lineage.launch.mode`. `flock` is the default and the only mode that gives
 *  the full verb set; see DELEGATES for what each other mode costs. */
export type LaunchMode = 'flock' | 'claudeExtension';

export const LAUNCH_MODES: readonly LaunchMode[] = ['flock', 'claudeExtension'];

export function isLaunchMode(v: unknown): v is LaunchMode {
  return v === 'flock' || v === 'claudeExtension';
}

/**
 * Another extension Flock can hand a launch to.
 *
 * `newCommand` starts a fresh conversation: the official extension's
 * `claude-vscode.newConversation` takes no arguments and means exactly that,
 * opening in the user's own `claudeCode.preferredLocation` (sidebar or
 * editor) — which is theirs, not ours to override.
 *
 * `openCommand` OPENS AN EXISTING conversation by id. The official extension
 * grew one: `claude-vscode.primaryEditor.open(sessionId?, prompt?)` — the
 * same command its own `claude-code://open?session=` deep link runs. It
 * resumes the named session in the extension's UI, and REVEALS the existing
 * panel instead when that session is already open in one (panels are keyed
 * by session id), which is exactly the click-a-row contract. Deliberately
 * NOT `claude-vscode.editor.open`: called without an explicit view column
 * that one overwrites the user's preferred location as a side effect.
 * Optional in the shape, because a future delegate may not have one — and
 * absent means resumes keep opening Flock's own terminal in that mode.
 *
 * No contributed command accepts a working directory or a parent, which is
 * the whole reason `forkFor` exists as a separate, weaker promise below.
 */
export interface LaunchDelegate {
  mode: LaunchMode;
  /** The extension id, as `vscode.extensions.getExtension` takes it. */
  extensionId: string;
  /** What the setting's description and every refusal call it. */
  label: string;
  /** The command that starts a new conversation, no arguments. */
  newCommand: string;
  /** The command that opens an EXISTING conversation, first argument the
   *  session id. Absent: the delegate cannot, and resumes stay Flock's. */
  openCommand?: string;
  /** Whether the delegate can be asked to FORK a specific session. None can:
   *  `--fork-session` is a launch-time CLI flag no contributed command
   *  carries, so Flock's fork verb keeps launching its own terminal in every
   *  mode — which is also the only way a fork can inherit the parent's
   *  history. Kept as a field so the answer is written down next to the
   *  delegate it is about rather than assumed. */
  canFork: false;
  provider: ProviderId;
}

export const DELEGATES: readonly LaunchDelegate[] = [
  {
    mode: 'claudeExtension',
    // The publisher casing is Anthropic's own (`Anthropic.claude-code`).
    // `extensionsFor` lowercases both sides before comparing, because
    // `getExtension` is documented as case-insensitive and a host that is not
    // must not silently disable the mode.
    extensionId: 'Anthropic.claude-code',
    label: 'Claude Code extension',
    newCommand: 'claude-vscode.newConversation',
    openCommand: 'claude-vscode.primaryEditor.open',
    canFork: false,
    provider: 'claude',
  },
];

export function delegateFor(mode: LaunchMode): LaunchDelegate | undefined {
  return DELEGATES.find((d) => d.mode === mode);
}

/**
 * The mode a launch actually runs in.
 *
 * Degrades to `flock` whenever the named delegate is not installed, and says so
 * through the returned `fellBack` flag rather than by silently doing something
 * else: a user who set the mode and then uninstalled the extension has to be
 * told once, not left with a `+` that opens nothing.
 *
 * `installed` is the host's answer (`vscode.extensions.getExtension(id) !==
 * undefined`), injected so this stays pure and testable.
 */
export function resolveLaunchMode(
  configured: unknown,
  installed: (extensionId: string) => boolean,
): { mode: LaunchMode; delegate?: LaunchDelegate; fellBack: boolean } {
  if (!isLaunchMode(configured) || configured === 'flock') {
    return { mode: 'flock', fellBack: false };
  }
  const delegate = delegateFor(configured);
  if (delegate === undefined) return { mode: 'flock', fellBack: true };
  let present = false;
  try {
    present = installed(delegate.extensionId) === true;
  } catch {
    present = false;
  }
  if (!present) return { mode: 'flock', fellBack: true };
  return { mode: delegate.mode, delegate, fellBack: false };
}

/**
 * What a delegated launch gives up, in the words the setting's description and
 * the fallback toast both use.
 *
 * VERIFIED against the code rather than guessed, because a list like this is
 * exactly the sort of thing that goes stale into a lie:
 *
 *   tmux parking — TerminalRegistry.launch is the only caller of buildTmuxArgs,
 *     so a session Flock did not launch has no wrap; WorkspaceManager reads
 *     `tmuxNameOf` (a binding) to choose detach over kill, and finds nothing.
 *   close, and close with summary — closeFlow disposes a bound terminal; with
 *     none it can only write the record, which is precisely the lie hosts.ts
 *     exists to stop. See canEndSession.
 *   account pinning — the pin is written from LaunchOptions.profileId at launch
 *     (commands.pinLaunch), and the account's environment reaches claude only
 *     through the terminal's env / the wrap's `-e`. A delegated launch carries
 *     the delegate's own environment, so there is nothing to pin and nothing
 *     that would be true if we pinned it.
 *   the wrap prompt — sendTextToSession needs a bound terminal.
 *   tab naming — rename goes through the workbench's active-terminal command on
 *     a terminal we hold.
 *
 * What KEEPS working, and is why the mode is worth having at all: the row, the
 * tree edge (the delegate's session lands on the roster like any other, and the
 * launch is recorded as a minted edge before it happens), the age, the dot, the
 * bell, project membership and branch colours, fork-from-here, and Copy
 * Session ID.
 */
export const DELEGATED_LOSSES: readonly string[] = [
  'tmux parking (a workspace switch closes the session instead of hiding it)',
  'Close and Close with Summary',
  'account pinning and per-account routing',
  'the wrap prompt',
  'Flock-named tabs',
];
