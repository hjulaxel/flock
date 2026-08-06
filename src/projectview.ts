// src/projectview.ts — the project header, inside the Explorer.
//
// A view contributed into the BUILT-IN explorer container (the same door the
// npm extension uses for NPM SCRIPTS), so the Explorer reads top to bottom as:
//
//     PROJECT      <- this file: which project, and which directories it is
//     <folders>       the real folder tree, one collapsible root per directory
//     OUTLINE      <- untouched; follows the active editor
//     TIMELINE     <- untouched; follows the active editor
//
// It exists because the anchor row cannot do this job. src/explorer.ts has to
// keep workspace folder[0] fixed forever (mutating it restarts the extension
// host), and a folder's label can only be changed by removing and re-adding it
// — so the one row we are already paying for is precisely the one row that can
// never say the active project's name.
//
// Rows are FLAT and there are never many: a project header plus one row per
// connected directory. No lazy loading, no expansion state, nothing to keep in
// sync — the whole view is recomputed from the active project on every change,
// which for a handful of rows is cheaper than deciding what changed.
//
// Contributed under a `when` clause on `lineage.explorerFollow`, so a window
// that never opted in is not given a view it cannot use.

import * as vscode from 'vscode';

import { COMMANDS, PROJECT_VIEW_ID } from './types';
import type { DisposableLike, ProjectRecord } from './types';
import { baseName, normalizeDir, pathKey, projectDirs } from './projects';
import type { ExplorerScope } from './explorer';
import { log, logError } from './log';

// -------------------------------------------------------------------- rows

export type ProjectViewRow =
  /** The active project itself. */
  | { kind: 'project'; project: ProjectRecord }
  /** One of its directories.
   *
   *  `main` is the project's rootDir. `current` is "the folder tree below is
   *  rooted here", which under `'project'` scope is true of every row and under
   *  `'directory'` scope of exactly one — it decides what CLICKING does, since a
   *  directory that is not down there cannot be revealed. `showing` is whether
   *  to SAY so, which is only worth doing when it distinguishes this row from
   *  the others: never under `'project'` scope, and not for a project with a
   *  single directory, where it would label the only row it could mean. */
  | {
      kind: 'dir';
      path: string;
      label: string;
      main: boolean;
      current: boolean;
      showing: boolean;
    }
  /** Anchored, but no project is active — the Explorer shows nothing of ours. */
  | { kind: 'none' }
  /** Not a Flock workspace: the feature has never been set up here. */
  | { kind: 'setup' };

export interface ProjectViewDeps {
  /** The project this window is currently scoped to, if any. */
  activeProject(): ProjectRecord | undefined;
  /** Is this window a Flock workspace (ExplorerSync.anchored())? */
  anchored(): boolean;
  /** How many sessions the tree is currently rendering under this project.
   *  Optional: without it the header simply omits the count. */
  sessionCount?(projectId: string): number;
  /** How much of the project the Explorer below is showing. Optional: absent
   *  means `'project'`, under which every directory row is a root down there. */
  scope?(): ExplorerScope;
  /** The directory the folder tree is rooted at under `'directory'` scope.
   *  Optional; absent falls back to the project's main directory. */
  currentDir?(): string | undefined;
  /** Fires whenever the model behind the rows moved — the same signal the
   *  sidebar repaints on. */
  onDidChangeData(listener: () => void): DisposableLike;
}

/**
 * Rows for a given state. Pure and exported so the shape can be asserted
 * without a workbench: which rows appear, in which order, is the whole
 * behaviour of this view.
 */
export function projectRows(
  project: ProjectRecord | undefined,
  anchored: boolean,
  opts: { scope?: ExplorerScope; currentDir?: string } = {},
): ProjectViewRow[] {
  if (!anchored) return [{ kind: 'setup' }];
  if (!project) return [{ kind: 'none' }];
  const dirs = projectDirs(project);
  // Under `'project'` scope every directory is down there as its own root, so
  // every row is current and marking one would be a lie. Under `'directory'`
  // scope exactly one is — resolved the same way `narrowToCurrent` resolves it,
  // and falling back to the same directory, so the mark and the tree cannot
  // disagree.
  const narrowed = (opts.scope ?? 'project') === 'directory';
  const wanted = pathKey(normalizeDir(opts.currentDir ?? ''));
  const found = wanted === '' ? -1 : dirs.findIndex((d) => pathKey(d) === wanted);
  const currentIndex = found < 0 ? 0 : found;
  return [
    { kind: 'project', project },
    ...dirs.map((path, i) => ({
      kind: 'dir' as const,
      path,
      // The main row is labelled by its DIRECTORY here, not by the project:
      // the project's name is already the row directly above it, and the
      // question this row answers is "where does it live".
      label: baseName(path) || path,
      main: i === 0,
      current: narrowed ? i === currentIndex : true,
      showing: narrowed && dirs.length > 1 && i === currentIndex,
    })),
  ];
}

// ---------------------------------------------------------------- provider

export class ProjectViewProvider
  implements vscode.TreeDataProvider<ProjectViewRow>
{
  private readonly deps: ProjectViewDeps;
  private readonly emitter = new vscode.EventEmitter<
    ProjectViewRow | undefined
  >();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(deps: ProjectViewDeps) {
    this.deps = deps;
  }

  refresh(): void {
    try {
      this.emitter.fire(undefined);
    } catch (err) {
      logError('projectview.refresh', err);
    }
  }

  /** Flat by construction — `getChildren(row)` is always empty. */
  getChildren(element?: ProjectViewRow): ProjectViewRow[] {
    if (element) return [];
    let project: ProjectRecord | undefined;
    let anchored = false;
    let scope: ExplorerScope | undefined;
    let currentDir: string | undefined;
    try {
      project = this.deps.activeProject();
      anchored = this.deps.anchored();
      scope = this.deps.scope?.();
      currentDir = this.deps.currentDir?.();
    } catch (err) {
      logError('projectview.getChildren', err);
    }
    return projectRows(project, anchored, { scope, currentDir });
  }

  getTreeItem(row: ProjectViewRow): vscode.TreeItem {
    switch (row.kind) {
      case 'project':
        return this.projectItem(row.project);
      case 'dir':
        return this.dirItem(row);
      case 'none':
        return this.actionItem(
          'No active project',
          'Choose one…',
          'layers',
          COMMANDS.switchWorkspace,
          'Pick the project this window is scoped to. The Explorer below ' +
            'will show its directories.',
        );
      case 'setup':
      default:
        return this.actionItem(
          'Explorer is not following a project',
          'Set up…',
          'gear',
          COMMANDS.followInExplorer,
          'This window is a plain folder, so the Explorer cannot be ' +
            'repointed without reloading it. Setting up converts the window ' +
            'to a Flock workspace once; after that, switching projects ' +
            'swaps the file tree instantly.',
        );
    }
  }

  private projectItem(project: ProjectRecord): vscode.TreeItem {
    const item = new vscode.TreeItem(
      project.name,
      vscode.TreeItemCollapsibleState.None,
    );
    // Unbranded, for the reason tree.ts's projectItem gives: a project is a
    // container, not a session, so it carries no LLM logo.
    item.iconPath = new vscode.ThemeIcon('root-folder');
    item.contextValue = 'lineageActiveProject';
    const count = this.safeSessionCount(project.id);
    item.description =
      count === undefined
        ? undefined
        : `${count} session${count === 1 ? '' : 's'}`;
    item.tooltip = 'Active project — click to switch.';
    item.command = {
      command: COMMANDS.switchWorkspace,
      title: 'Switch Workspace',
    };
    return item;
  }

  private dirItem(row: {
    path: string;
    label: string;
    main: boolean;
    current: boolean;
    showing: boolean;
  }): vscode.TreeItem {
    const item = new vscode.TreeItem(
      row.label,
      vscode.TreeItemCollapsibleState.None,
    );
    item.iconPath = new vscode.ThemeIcon(
      row.current ? 'folder-active' : 'folder',
    );
    // Empty string rather than undefined would paint an empty description
    // slot; the old code passed undefined for "no description" and so does this.
    const description = [row.main ? 'main' : '', row.showing ? 'showing' : '']
      .filter((s) => s !== '')
      .join(' · ');
    item.description = description === '' ? undefined : description;
    item.tooltip = row.path;
    item.contextValue = row.main ? 'lineageProjectDir;main' : 'lineageProjectDir';
    // TWO DIFFERENT CLICKS, because the row means two different things. When
    // this directory is already a root down there, the useful move is to select
    // it — `revealInExplorer`, which is what the row has always done. When it is
    // NOT (the other directories, under `'directory'` scope), revealing it would
    // do nothing at all: the path is not in the tree. So the click re-roots the
    // tree instead, which is the only way to reach that directory without
    // starting a session in it first.
    try {
      item.command = row.current
        ? {
            command: 'revealInExplorer',
            title: 'Reveal in Explorer',
            arguments: [vscode.Uri.file(row.path)],
          }
        : {
            command: COMMANDS.showDirectoryInExplorer,
            title: 'Show This Directory in the Explorer',
            arguments: [row.path],
          };
    } catch (err) {
      logError('projectview.dirCommand', err);
    }
    return item;
  }

  private actionItem(
    label: string,
    description: string,
    icon: string,
    command: string,
    tooltip: string,
  ): vscode.TreeItem {
    const item = new vscode.TreeItem(
      label,
      vscode.TreeItemCollapsibleState.None,
    );
    item.iconPath = new vscode.ThemeIcon(icon);
    item.description = description;
    item.tooltip = tooltip;
    item.command = { command, title: label };
    return item;
  }

  private safeSessionCount(projectId: string): number | undefined {
    const fn = this.deps.sessionCount;
    if (!fn) return undefined;
    try {
      const n = fn.call(this.deps, projectId);
      return typeof n === 'number' && n >= 0 ? n : undefined;
    } catch (err) {
      logError('projectview.sessionCount', err);
      return undefined;
    }
  }

  dispose(): void {
    try {
      this.emitter.dispose();
    } catch (err) {
      logError('projectview.dispose', err);
    }
  }
}

// ----------------------------------------------------------- registration

export interface ProjectViewController extends DisposableLike {
  refresh(): void;
}

/** createTreeView(PROJECT_VIEW_ID) + repaint wiring. The view itself is
 *  declared in package.json under `contributes.views.explorer`. */
export function registerProjectView(
  deps: ProjectViewDeps,
): ProjectViewController {
  const provider = new ProjectViewProvider(deps);
  const view = vscode.window.createTreeView<ProjectViewRow>(PROJECT_VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: false,
    canSelectMany: false,
  });

  let dataSub: DisposableLike | undefined;
  try {
    dataSub = deps.onDidChangeData(() => provider.refresh());
  } catch (err) {
    logError('projectview.onDidChangeData', err);
  }

  log('projectview: registered in the Explorer container');

  return {
    refresh(): void {
      provider.refresh();
    },
    dispose(): void {
      try {
        dataSub?.dispose();
      } catch (err) {
        logError('projectview.dispose.sub', err);
      }
      try {
        view.dispose();
      } catch (err) {
        logError('projectview.dispose.view', err);
      }
      provider.dispose();
    },
  };
}
