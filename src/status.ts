// src/status.ts — what this machine has and what this window is on, as rows.
//
// "Flock: Status…" answers the questions people open a settings page to ask:
// is tmux installed and on, are the hooks and the verbs in, which `claude` and
// `codex` were found and where, which window model this window is in, where
// sessions open. Each row is a fact, and picking it runs the verb that changes
// the fact — the install, the picker, the setting.
//
// PURE, in `recommendedPlan`'s shape: the facts are decided here from a
// RecommendedWorld the checklist already assembles plus the two binary probes
// every launch already makes, and commands.ts draws the QuickPick and runs the
// action. NO NEW PROBE. A status line that had to go and look for itself would
// be a second answer to a question the checklist already answers, and the two
// would disagree the first time either changed.
//
// The two settings queries live here too, so the verb that opens the editor and
// the test that holds the query to the manifest read the same string.

import type { RecommendedSetting } from './recommend';
import { surfaceChoices, windowModelChoices } from './recommend';
import { tmuxInstallHint } from './tmux';
import { COMMANDS, CONFIG_KEYS, CONFIG_SECTION, EXTENSION_ID } from './types';
import type { RecommendedWorld } from './types';

/** The Settings editor filtered to Flock — what "Flock Settings…" opens. The
 *  editor draws the manifest's categories as a table of contents under it. */
export const SETTINGS_QUERY = `@ext:${EXTENSION_ID}`;
/** The same, narrowed to the rows the manifest tags `advanced` — tier D of the
 *  settings design: paths, timings, diagnostics, previews, reload-bound keys. */
export const ADVANCED_SETTINGS_QUERY = `${SETTINGS_QUERY} @tag:advanced`;

/** The two CLI probes every launch makes, handed over rather than re-run. */
export interface CliBinaries {
  /** `findClaudeBinary(lineage.claudeBinary)`. */
  readonly claude: string | null;
  /** `findCodexBinary(lineage.codexBinary)`. */
  readonly codex: string | null;
  /** Whether `lineage.codexBinary` is set at all — with no Codex account, the
   *  one other reason the codex row is worth a line. */
  readonly codexConfigured: boolean;
}

export interface StatusInput {
  readonly world: RecommendedWorld;
  /** Absent — a wiring without the probes — draws no CLI rows at all, rather
   *  than two rows reading "not found" about a machine nobody looked at. */
  readonly cli?: CliBinaries;
  /** Any account on the Codex provider. Read off the accounts manager the
   *  window already has; never a probe. */
  readonly hasCodexAccount: boolean;
}

/** What picking a row does. Every arm names an EXISTING flow — a contributed
 *  command, the editor at one key, the settings write the checklist's `tmux`
 *  step makes — so this module can never grow a verb of its own that the
 *  palette does not have. */
export type StatusAction =
  | { readonly kind: 'command'; readonly command: string }
  | { readonly kind: 'openSetting'; readonly key: string }
  | { readonly kind: 'tmuxInstall'; readonly hint: string | undefined }
  | {
      readonly kind: 'writeSettings';
      readonly settings: readonly RecommendedSetting[];
      /** The status-bar line said once the write lands. */
      readonly receipt: string;
    };

export type StatusFactId =
  | 'tmux'
  | 'hooks'
  | 'verbs'
  | 'claude'
  | 'codex'
  | 'windowModel'
  | 'surface';

export interface StatusFact {
  readonly id: StatusFactId;
  /** Codicon name, without the `$()`. */
  readonly icon: string;
  /** The row: what is being reported on. */
  readonly label: string;
  /** The fact, in words — "installed at /opt/homebrew/bin/tmux, on". */
  readonly value: string;
  /** What picking the row does, readable BEFORE it is picked: a row that acts
   *  without saying so is a row people learn not to touch. */
  readonly next: string;
  readonly action: StatusAction;
}

const fullKey = (key: string): string => `${CONFIG_SECTION}.${key}`;

/**
 * The rows, in the order a person new to the machine would ask them: the
 * detach tier first, then the two installs, then the binaries, then the two
 * taste questions.
 *
 * Every row has an action, and a row whose fact is already the good one still
 * has one — the setting behind it, or the picker that could change it — so the
 * list never contains a line that does nothing when picked.
 */
export function statusFacts(input: StatusInput): StatusFact[] {
  const { world, cli } = input;
  const facts: StatusFact[] = [];

  // ---- tmux -----------------------------------------------------------------
  //
  // Three worlds, the same three `recommendedPlan` distinguishes: not installed
  // (a package manager's job, so the pick can only say how), installed but
  // switched off by hand (one settings write — the exact write the checklist's
  // `tmux` step makes), and on.
  if (world.tmuxBinary === null) {
    const hint = tmuxInstallHint(world.platform);
    facts.push({
      id: 'tmux',
      icon: 'terminal-tmux',
      label: 'tmux',
      value: 'not installed',
      next: hint === undefined ? 'How to install it' : `Install it: ${hint}`,
      action: { kind: 'tmuxInstall', hint },
    });
  } else if (world.tmuxMode === 'off') {
    facts.push({
      id: 'tmux',
      icon: 'terminal-tmux',
      label: 'tmux',
      value: `installed at ${world.tmuxBinary}, off by setting`,
      next: 'Turn it back on — sets lineage.tmux to auto',
      action: {
        kind: 'writeSettings',
        settings: [{ key: CONFIG_KEYS.tmux, value: 'auto' }],
        receipt: 'Flock: tmux is back on — sessions started from now on are wrapped',
      },
    });
  } else {
    facts.push({
      id: 'tmux',
      icon: 'terminal-tmux',
      label: 'tmux',
      value: `installed at ${world.tmuxBinary}, on`,
      next: 'Open the setting',
      action: { kind: 'openSetting', key: fullKey(CONFIG_KEYS.tmux) },
    });
  }

  // ---- the two installs -----------------------------------------------------
  facts.push(
    world.hooksInstalled
      ? {
          id: 'hooks',
          icon: 'plug',
          label: 'Instant-update hooks',
          value: 'installed',
          next: 'Remove them — the tree goes back to a three-second poll',
          action: { kind: 'command', command: COMMANDS.removeHooks },
        }
      : {
          id: 'hooks',
          icon: 'plug',
          label: 'Instant-update hooks',
          value: 'not installed',
          next: 'Install them — the tree redraws as each event happens',
          action: { kind: 'command', command: COMMANDS.installHooks },
        },
  );
  // A wiring without the verbs manager has nothing to install and nothing to
  // report — the same silence `recommendedPlan` keeps for it.
  if (world.verbsAvailable) {
    facts.push(
      world.verbsInstalled
        ? {
            id: 'verbs',
            icon: 'git-branch',
            label: 'In-session verbs',
            value: 'installed',
            next: 'Remove them — "fork this session" said to Claude stops working',
            action: { kind: 'command', command: COMMANDS.removeAgentVerbs },
          }
        : {
            id: 'verbs',
            icon: 'git-branch',
            label: 'In-session verbs',
            value: 'not installed',
            next: 'Install them — "fork this session" said to Claude forks here',
            action: { kind: 'command', command: COMMANDS.installAgentVerbs },
          },
    );
  }

  // ---- the binaries ---------------------------------------------------------
  //
  // Picking either opens the editor AT the key: the fix for a binary the
  // extension host did not inherit is the path setting, and nothing else.
  if (cli !== undefined) {
    const claudeKey = fullKey(CONFIG_KEYS.claudeBinary);
    facts.push({
      id: 'claude',
      icon: 'terminal',
      label: 'claude CLI',
      value: cli.claude === null ? `not found — set ${claudeKey}` : `found at ${cli.claude}`,
      next: `Open ${claudeKey}`,
      action: { kind: 'openSetting', key: claudeKey },
    });
    // Only for somebody the codex binary can matter to: a Codex account, or a
    // path already set. Everybody else would read "not found" about a CLI they
    // never asked for.
    if (input.hasCodexAccount || cli.codexConfigured) {
      const codexKey = fullKey(CONFIG_KEYS.codexBinary);
      facts.push({
        id: 'codex',
        icon: 'terminal',
        label: 'codex CLI',
        value: cli.codex === null ? `not found — set ${codexKey}` : `found at ${cli.codex}`,
        next: `Open ${codexKey}`,
        action: { kind: 'openSetting', key: codexKey },
      });
    }
  }

  // ---- the two taste questions ----------------------------------------------
  //
  // Both read through the same functions their pickers use, so the value here
  // and the "(current)" mark one click later cannot disagree. Exactly one
  // window model is always current; the surface has a fifth place the picker
  // does not offer yet (`terminalLocation: newWindow`), which is named rather
  // than left blank.
  const model = windowModelChoices(world).find((c) => c.current);
  facts.push({
    id: 'windowModel',
    icon: 'window',
    label: 'Window model',
    value: model?.label ?? 'unknown',
    next: 'Choose Window Model…',
    action: { kind: 'command', command: COMMANDS.chooseWindowModel },
  });

  const surface = surfaceChoices(world).find((c) => c.current);
  facts.push({
    id: 'surface',
    icon: 'layout',
    label: 'Where sessions open',
    value:
      surface?.label ??
      (world.terminalLocation === 'newWindow'
        ? 'Own window per session'
        : 'not one of the picker’s four'),
    next: 'Choose Where Sessions Open…',
    action: { kind: 'command', command: COMMANDS.chooseSurface },
  });

  return facts;
}
