// src/decorations.ts — the FileDecorationProvider on the `lineage-session:`
// scheme.
//
// The badge is the ONLY thing an extension can put at the right edge of a tree
// row (the workbench pins `.monaco-icon-label::after` there; a
// TreeItem.description always renders flush against the label), so this is
// where the status dot has to live. Decorations are gated by the user's
// explorer.decorations.badges / .colors settings; what survives them is the
// age in the description, the tooltip, and the count on the view.

import * as vscode from 'vscode';
import {
  CLOSED_COLOR_ID,
  DONE_COLOR_ID,
  RUNNING_COLOR_ID,
  SESSION_URI_SCHEME,
  STATUS_DOT,
} from './types';
import type { DecorationDeps, DisposableLike, SessionForest } from './types';
import { log, logError } from './log';
// The dot's meaning is defined once, in the pure row model, so the native
// badge, the inline sidebar's row and the tooltip cannot disagree about what
// amber means.
import { statusTone } from './viewmodel';

/** VS Code validates decoration badges grapheme-wise and DROPS (with an
 *  "INVALID decoration" log) anything longer — it never throws. We do the same
 *  check up front so a bad badge degrades to a colour/tooltip-only decoration
 *  instead of silently losing the whole decoration in the renderer. */
const MAX_BADGE_GRAPHEMES = 2;

const EMPTY_FOREST: SessionForest = {
  nodes: new Map(),
  roots: [],
  visibleRoots: [],
  edges: [],
  attentionCount: 0,
  generatedAt: 0,
};

/** Uri.from({scheme: SESSION_URI_SCHEME, path: '/' + sessionId}).
 *  A custom scheme (never `file:`) so the item does not inherit file-icon-theme
 *  behaviour from the workbench. */
export function sessionUri(sessionId: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SESSION_URI_SCHEME, path: '/' + sessionId });
}

/** Scheme for project rows, so the unseen-done dot can bubble up to the
 *  project the way an unread count rolls up from a row to the group it sits
 *  in. Distinct from the session scheme on purpose — a project id is not a
 *  session id, and the provider must never confuse the two. */
export const PROJECT_URI_SCHEME = 'lineage-project';

export function projectUri(projectId: string): vscode.Uri {
  return vscode.Uri.from({ scheme: PROJECT_URI_SCHEME, path: '/' + projectId });
}

// ---------------------------------------------------------------- graphemes

interface GraphemeSegmenter {
  segment(input: string): Iterable<unknown>;
}
type SegmenterCtor = new (
  locales?: string | string[],
  options?: { granularity?: 'grapheme' | 'word' | 'sentence' },
) => GraphemeSegmenter;

/** Count user-perceived characters, not UTF-16 units. Falls back to code
 *  points where Intl.Segmenter is unavailable (still never over-counts a
 *  plain ASCII badge). */
export function graphemeCount(s: string): number {
  const ctor = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
  if (typeof ctor === 'function') {
    try {
      const seg = new ctor(undefined, { granularity: 'grapheme' });
      return Array.from(seg.segment(s)).length;
    } catch {
      // fall through to the code-point count
    }
  }
  return Array.from(s).length;
}

function makeDecoration(
  badge: string | undefined,
  tooltip: string | undefined,
  color: vscode.ThemeColor | undefined,
): vscode.FileDecoration | undefined {
  let effective = badge;
  if (effective !== undefined && graphemeCount(effective) > MAX_BADGE_GRAPHEMES) {
    log(
      'INVALID decoration: badge',
      JSON.stringify(effective),
      `exceeds ${MAX_BADGE_GRAPHEMES} graphemes — dropped`,
    );
    effective = undefined;
  }
  if (effective === undefined && color === undefined && tooltip === undefined) {
    return undefined;
  }
  const decoration = new vscode.FileDecoration(effective, tooltip, color);
  decoration.propagate = false;
  return decoration;
}

// ----------------------------------------------------------------- provider

/**
 * Badge table: ONE mark at the right edge, three lit tones and one deliberate
 * blank.
 *   hidden (muted)        → colour-only ThemeColor('disabledForeground'), FIRST
 *   done (waiting on you) → '●' + ThemeColor(lineage.done)    + `waiting: …`
 *   running (busy)        → '●' + ThemeColor(lineage.running) + 'running'
 *   closed / ghost        → colour-only ThemeColor(lineage.closed) + 'closed'/'gone'
 *   idle                  → NOTHING — no badge, no colour, no decoration
 * `propagate: false` always — a session is not a directory.
 *
 * Idle draws nothing because "no mark" is the strongest way to say "nothing to
 * report", and a tree where every quiet row still carries a dot teaches the eye
 * to skip dots. It used to draw an uncoloured '●', which competed with the two
 * lit ones for exactly no information.
 *
 * The colour lands on the row's label as well as on the mark: the workbench
 * gives a decoration one colour for both. That is the deal for a coloured dot,
 * and it is how the Explorer shows a modified file — and here it is also what
 * greys a closed row's label, which is the closest the native tree can get to
 * the inline sidebar's strikethrough.
 */
export class SessionDecorationProvider implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri[] | undefined>();

  readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri[] | undefined> =
    this.emitter.event;

  private readonly deps: DecorationDeps;
  private lastForest: SessionForest = EMPTY_FOREST;

  constructor(deps: DecorationDeps) {
    this.deps = deps;
  }

  private forest(): SessionForest {
    try {
      const f = this.deps.getForest();
      if (f && f.nodes) {
        this.lastForest = f;
        return f;
      }
    } catch (err) {
      logError('decorations.getForest', err);
    }
    return this.lastForest;
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    try {
      if (!uri) return undefined;

      // Project rows carry the dot when a session under them is unseen-done.
      // Colour + dot, exactly like the session row it bubbles up from.
      if (uri.scheme === PROJECT_URI_SCHEME) {
        const path = uri.path ?? '';
        const projectId = path.startsWith('/') ? path.slice(1) : path;
        if (!projectId) return undefined;
        let unseen: ReadonlySet<string> | undefined;
        try {
          unseen = this.deps.projectsWithUnseen?.();
        } catch (err) {
          logError('decorations.projectsWithUnseen', err);
        }
        if (!unseen?.has(projectId)) return undefined;
        return makeDecoration(
          STATUS_DOT,
          'contains a finished session you have not looked at',
          new vscode.ThemeColor(DONE_COLOR_ID),
        );
      }

      if (uri.scheme !== SESSION_URI_SCHEME) return undefined;
      const path = uri.path ?? '';
      const sessionId = path.startsWith('/') ? path.slice(1) : path;
      if (!sessionId) return undefined;

      const node = this.forest().nodes.get(sessionId);
      if (!node) return undefined;

      // Checked FIRST, ahead of the dot: a muted row must not carry a lit one,
      // or hide would fail at the one thing the user asked it to do.
      // Colour-only, so the row reads as greyed out and nothing shouts.
      if (node.hidden) {
        return makeDecoration(
          undefined,
          'hidden',
          new vscode.ThemeColor('disabledForeground'),
        );
      }

      const tone = statusTone(node);
      if (tone === 'done') {
        // An unseen-done idle session finished a turn rather than blocking on
        // a dialog; say which it is.
        const tooltip =
          node.status === 'waiting'
            ? `waiting: ${node.roster?.waitingFor ?? 'input'}`
            : 'done — not looked at yet';
        return makeDecoration(
          STATUS_DOT,
          tooltip,
          new vscode.ThemeColor(DONE_COLOR_ID),
        );
      }
      if (tone === 'running') {
        return makeDecoration(
          STATUS_DOT,
          'running',
          new vscode.ThemeColor(RUNNING_COLOR_ID),
        );
      }
      if (tone === 'closed') {
        // COLOUR ONLY, exactly like `hidden` above: the grey label is what
        // says "this is over", and it says it across the whole row instead of in
        // one 8px circle. The hollow ring that used to sit here was a second
        // mark for the same fact, and a column of empty circles beside every
        // finished session is what trains the eye past the column the two lit
        // dots live in. The two ways of being over stay distinguishable in the
        // hover, which is the only place the native tree has left to put them —
        // an archived session has a transcript and reopens, a ghost is an
        // inferred ancestor with possibly nothing behind it.
        return makeDecoration(
          undefined,
          node.ghost ? 'gone' : 'closed',
          new vscode.ThemeColor(CLOSED_COLOR_ID),
        );
      }
      // 'idle' and 'unknown' fall through with no decoration at all: quiet is
      // the absence of a mark, not a mark of its own.
      return undefined;
    } catch (err) {
      logError('decorations.provideFileDecoration', err);
      return undefined;
    }
  }

  /** Fire onDidChangeFileDecorations(undefined) — full refresh. Cheap: the
   *  workbench only re-asks for rows it is actually rendering. */
  refresh(): void {
    try {
      this.emitter.fire(undefined);
    } catch (err) {
      logError('decorations.refresh', err);
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** Constructs the provider, subscribes deps.onDidChangeData → refresh(),
 *  registers it with the window, and returns a disposable covering all three. */
export function registerDecorations(deps: DecorationDeps): DisposableLike {
  const provider = new SessionDecorationProvider(deps);

  let dataSub: DisposableLike | undefined;
  try {
    dataSub = deps.onDidChangeData(() => provider.refresh());
  } catch (err) {
    logError('decorations.onDidChangeData', err);
  }

  let registration: vscode.Disposable | undefined;
  try {
    registration = vscode.window.registerFileDecorationProvider(provider);
  } catch (err) {
    // A missing/blocked decoration provider must never break the tree.
    logError('decorations.register', err);
  }

  return {
    dispose(): void {
      try {
        dataSub?.dispose();
      } catch (err) {
        logError('decorations.dispose.sub', err);
      }
      try {
        registration?.dispose();
      } catch (err) {
        logError('decorations.dispose.registration', err);
      }
      provider.dispose();
    },
  };
}
