// IMPLEMENTED BY: C
// FileDecorationProvider on the `lineage-session:` scheme — SPEC.md §4-C1.
//
// Imports allowed here: vscode, ./types, ./log.
// Decorations are gated by the user's explorer.decorations.badges / .colors
// settings, so the tree must never DEPEND on them — attention state is always
// ALSO present in the TreeItem.description (tree.ts, statusDescriptor()).

import * as vscode from 'vscode';
import { SESSION_URI_SCHEME, WAITING_COLOR_ID } from './types';
import type { DecorationDeps, DisposableLike, SessionForest } from './types';
import { log, logError } from './log';

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
 * Badge table (§4-C1):
 *   attention waiting   → '!'  + ThemeColor(lineage.waiting) + `waiting: …`
 *   status busy         → '»'  + tooltip 'busy'
 *   ghost / exited      → colour-only ThemeColor('disabledForeground')
 *   otherwise           → undefined
 * `propagate: false` always — a session is not a directory.
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
      if (!uri || uri.scheme !== SESSION_URI_SCHEME) return undefined;
      const path = uri.path ?? '';
      const sessionId = path.startsWith('/') ? path.slice(1) : path;
      if (!sessionId) return undefined;

      const node = this.forest().nodes.get(sessionId);
      if (!node) return undefined;

      if (node.attention === 'waiting') {
        const what = node.roster?.waitingFor ?? 'input';
        return makeDecoration(
          '!',
          `waiting: ${what}`,
          new vscode.ThemeColor(WAITING_COLOR_ID),
        );
      }
      if (node.status === 'busy') {
        return makeDecoration('»', 'busy', undefined);
      }
      if (node.ghost || node.status === 'exited') {
        return makeDecoration(
          undefined,
          'exited',
          new vscode.ThemeColor('disabledForeground'),
        );
      }
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
