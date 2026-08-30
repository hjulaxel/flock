// src/sourceControl.ts — the second half of the auto-switch follow: Source
// Control shows the checkout the session in front is running in.
//
// THE SPLICE IS THE MECHANISM, and this module is the belt to its braces. Read
// that first, because it is the part that has to be true:
//
// The built-in git extension (`vscode.git`) discovers repositories by scanning
// `workspace.workspaceFolders` and by listening on
// `workspace.onDidChangeWorkspaceFolders` — for every folder ADDED it opens a
// repository, and for every folder REMOVED it disposes that folder's repository
// unless a visible editor or a remaining folder still holds it. `src/explorer.ts`
// already splices the session's directory into that list on every follow. So in
// the ordinary case — the spliced root IS the repository root, or IS a linked
// worktree, which git reports as its own toplevel and the extension opens as its
// own repository of `kind: 'worktree'` — Source Control follows the session with
// no code at all, and everything below is a no-op that says `already-open`.
//
// WHY THE SECOND PATH EXISTS ANYWAY. A spliced folder that sits BELOW a
// repository root — `~/mono-feat-x/api` in a monorepo checked out at
// `~/mono-feat-x`, which is exactly the shape Axel described — is believed to be
// refused into VS Code's "a git repository was found in the parent folders"
// prompt at the shipped default `git.openRepositoryInParentFolders: "prompt"`,
// leaving the SCM view empty. `vscode.git`'s own public API is the documented
// way past that: `getExtension('vscode.git').exports.getAPI(1).openRepository(uri)`
// asks the model to open a path as a repository directly.
//
// AND THE HONEST PART: that refusal has NOT been verified by a controlled run
// from here — an Extension Development Host is the only thing that can settle
// it, and it cannot be launched from the environment this was written in. So
// this module is deliberately the smallest thing that can be right either way.
// If the splice already produced the repository, `planRepoOpen` returns '' and
// nothing happens. If it did not, one guarded API call fixes it. If the API is
// missing, older, disabled or throws, the result is `refused` and the window is
// exactly as it was — which is also the state a user on an editor whose git
// build predates the skip-the-parent-check behaviour will get, and for whom the
// documented remedy is their own `git.openRepositoryInParentFolders: "always"`.
// `docs/reference.md` carries the manual experiment that settles it and says
// what each outcome means.
//
// WHAT WAS DELIBERATELY NOT BUILT, because nothing observed justifies it. An
// earlier draft carried a time-boxed re-open: both this and the git extension
// listen on the same folder-change event, listener order is registration order
// and is not guaranteed, so in principle the extension's removal pass could
// dispose a repository opened moments earlier. That race has never been
// observed, and machinery whose only justification is a race nobody has seen is
// machinery that will be maintained forever on a hunch. It is written down here
// instead: if a repository ever visibly appears and then vanishes on a follow,
// that is the shape to look for, and a single re-open inside a short window
// after the splice is the fix.
//
// AND NOTHING IS EVER CLOSED. The only close verb the git extension has writes
// a persistent, user-visible "closed repositories" list, and the folder-removal
// disposal already cleans up what a splice opened. Flock closing repositories on
// somebody's behalf would be an extension quietly editing a list the user
// believes is theirs.
//
// PURE-ISH, in the shape `ExplorerSync` established: the git API arrives through
// `GitHost`, so the part that is actually easy to get wrong — deciding whether
// there is anything to do, and not letting two follows overlap — is unit tested
// without a workbench.

import { normalizeDir, pathKey } from './projects';
import { log, logError } from './log';

/** The slice of `vscode.git`'s exported API this feature uses, as a shape
 *  rather than an import: the git extension does not ship its `git.d.ts` as a
 *  package, so the alternative is vendoring a declaration file that would go
 *  stale silently. Two methods is a small enough surface to state here. */
export interface GitHost {
  /** The repository roots currently open, as filesystem paths. */
  repositories(): readonly string[];
  /** Open `path` as a repository. Resolves false when the host declined —
   *  which is not an error and must not read as one. */
  open(path: string): Promise<boolean>;
}

/** What one `follow` call did. Everything except `opened` left the world
 *  alone; they are distinguished so the log can say WHY nothing happened
 *  rather than leaving a user with an SCM view that silently stopped
 *  following. */
export type FollowOutcome = 'opened' | 'already-open' | 'nothing' | 'refused';

/**
 * The repository to open, or '' when there is nothing to do.
 *
 * '' for an empty target — a cold worktree probe and a directory outside git
 * both arrive here as '', and neither may clear or churn Source Control — and
 * '' when the desired root is ALREADY open, which is the case the splice
 * produces and therefore the common one. Comparison is by `pathKey`, the same
 * case-folded key every other path comparison in this codebase uses, because
 * the git extension reports `rootUri.fsPath` in git's own spelling and a case
 * difference is not a different repository on either platform this ships on.
 *
 * Containment is deliberately NOT tested here. An open repository at
 * `~/mono-feat-x` does not mean the lane `~/mono-feat-x/api` is showing — it
 * means the monorepo is showing, which is a different SCM view — and this
 * function is asked about a repository ROOT, which `planFollow` has already
 * resolved through `checkoutAt`. Widening it to containment would make the
 * feature silently no-op in exactly the case it was written for.
 */
export function planRepoOpen(
  current: readonly string[],
  desired: string | undefined,
): string {
  const target = normalizeDir(desired);
  if (target === '') return '';
  const key = pathKey(target);
  for (const raw of current ?? []) {
    if (pathKey(normalizeDir(raw)) === key) return '';
  }
  return target;
}

/**
 * Keeps Source Control pointed at the checkout the front conversation is in.
 *
 * Calls are SERIALISED, for the reason `ExplorerSync.sync` serialises: a follow
 * runs on every focus change and on every landed worktree probe, so two of them
 * overlapping is ordinary rather than exotic, and two `openRepository` calls in
 * flight at once would both see the pre-open repository list and both ask for
 * the same open.
 *
 * Never throws and never rejects. A follow is a courtesy on top of a splice
 * that has already happened; nothing about it may take a window down, and a
 * missing or moved git API is a normal state on an editor that is not the one
 * this was written against.
 */
export class SourceControlSync {
  private readonly host: GitHost | null;
  /** Tail of the promise chain every follow appends itself to. */
  private queue: Promise<unknown> = Promise.resolve();
  /** So a host that cannot answer says so once, not once per focus change. */
  private warned = false;

  /** A null host is the honest shape for "this editor has no git extension we
   *  can talk to": the splice half of the feature still works, and every call
   *  here becomes a no-op instead of a wiring branch at the call site. */
  constructor(host: GitHost | null) {
    this.host = host;
  }

  async follow(repo: string | undefined): Promise<FollowOutcome> {
    const run = async (): Promise<FollowOutcome> => {
      try {
        return await this.followOnce(repo);
      } catch (err) {
        logError('sourceControl.follow', err);
        return 'refused';
      }
    };
    // Append and hand back THIS link, so a caller awaits its own follow.
    // `.then(run, run)` rather than `.finally` — a rejected predecessor must
    // not skip the successor or poison the chain.
    const next = this.queue.then(run, run);
    this.queue = next;
    return next;
  }

  private async followOnce(repo: string | undefined): Promise<FollowOutcome> {
    const target = normalizeDir(repo);
    if (target === '') return 'nothing';
    const host = this.host;
    if (!host) return 'refused';

    let open: readonly string[];
    try {
      open = host.repositories();
    } catch (err) {
      // A host that cannot even list is a host that cannot be reasoned about.
      // Refusing here rather than opening blind is what keeps a broken API from
      // asking for the same repository on every focus change forever.
      if (!this.warned) {
        this.warned = true;
        logError('sourceControl.repositories', err);
      }
      return 'refused';
    }

    const wanted = planRepoOpen(open, target);
    // THE COMMON CASE, and the one the splice produces on its own: the folder
    // Flock spliced in was the repository root (or a linked worktree, which git
    // reports as its own toplevel), the git extension opened it from the
    // workspace-folder event, and there is nothing left for this to do.
    if (wanted === '') return 'already-open';

    const ok = await host.open(wanted);
    if (!ok) {
      if (!this.warned) {
        this.warned = true;
        log(
          'sourceControl: the git extension declined to open',
          wanted,
          '— Source Control will show whatever the spliced folder produced. ' +
            'On a folder below a repository root, `git.openRepositoryInParentFolders: "always"` is the remedy.',
        );
      }
      return 'refused';
    }
    this.warned = false;
    log('sourceControl: opened repository', wanted);
    return 'opened';
  }
}
