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
import { baseName, projectDirs } from './projects';
import { log, logError } from './log';

// -------------------------------------------------------------------- rows

export type ProjectViewRow =
  /** The active project itself. */
  | { kind: 'project'; project: ProjectRecord }
  /** One of its directories. `main` is the project's rootDir. */
  | { kind: 'dir'; path: string; label: string; main: boolean }
  /** Anchored, but no project is active — the Explorer shows nothing of ours. */
  | { kind: 'none' }
  /** Not a Canopy workspace: the feature has never been set up here. */
  | { kind: 'setup' };

export interface ProjectViewDeps {
  /** The project this window is currently scoped to, if any. */
  activeProject(): ProjectRecord | undefined;
  /** Is this window a Canopy workspace (ExplorerSync.anchored())? */
  anchored(): boolean;
  /** How many sessions the tree is currently rendering under this project.
   *  Optional: without it the header simply omits the count. */
  sessionCount?(projectId: string): number;
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
): ProjectViewRow[] {
  if (!anchored) return [{ kind: 'setup' }];
  if (!project) return [{ kind: 'none' }];
  const dirs = projectDirs(project);
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
    try {
      project = this.deps.activeProject();
      anchored = this.deps.anchored();
    } catch (err) {
      logError('projectview.getChildren', err);
    }
    return projectRows(project, anchored);
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
            'to a Canopy workspace once; after that, switching projects ' +
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
  }): vscode.TreeItem {
    const item = new vscode.TreeItem(
      row.label,
      vscode.TreeItemCollapsibleState.None,
    );
    item.iconPath = new vscode.ThemeIcon(row.main ? 'folder-active' : 'folder');
    item.description = row.main ? 'main' : undefined;
    item.tooltip = row.path;
    item.contextValue = row.main ? 'lineageProjectDir;main' : 'lineageProjectDir';
    // Selects this directory's root down in the folder tree. The rows up here
    // name the project's directories; the tree below is where you open them.
    try {
      item.command = {
        command: 'revealInExplorer',
        title: 'Reveal in Explorer',
        arguments: [vscode.Uri.file(row.path)],
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
