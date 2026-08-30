// test/sourceControl.test.ts — the belt to the splice's braces.
//
// The primary mechanism for making Source Control follow a session is the
// FOLDER SPLICE `src/explorer.ts` already performs: the built-in git extension
// opens a repository for every workspace folder that appears. What is tested
// here is the second path — one guarded `openRepository` call for the case a
// spliced folder sits below a repository root — and above all that it is a
// SILENT NO-OP whenever the splice already did the job. A belt that tightens
// when the braces are holding is a bug.
//
// The refusal this second path exists for has not been verified by a controlled
// run (see the module header and docs/reference.md, which carries the manual
// experiment). That is exactly why the code is this small and why these tests
// are about degrading rather than about succeeding: whichever way the
// experiment lands, nothing here does damage.

import { describe, expect, it } from 'vitest';

import { SourceControlSync, planRepoOpen } from '../src/sourceControl';
import type { GitHost } from '../src/sourceControl';

/** A host double that opens what it is asked for and remembers the asking. */
function host(
  initial: string[] = [],
  over: Partial<GitHost> = {},
): GitHost & { opened: string[]; current: string[] } {
  const state = {
    opened: [] as string[],
    current: [...initial],
    repositories: (): readonly string[] => [...state.current],
    open: async (dir: string): Promise<boolean> => {
      state.opened.push(dir);
      state.current.push(dir);
      return true;
    },
  };
  return Object.assign(state, over);
}

describe('planRepoOpen', () => {
  it('is nothing when the repository is already open — the splice case', () => {
    expect(planRepoOpen(['/m/mono-feat-x'], '/m/mono-feat-x')).toBe('');
  });

  it('compares paths the way every other path rule here does', () => {
    // The git extension reports `rootUri.fsPath` in git's own spelling, and a
    // case difference is not a different repository on either platform this
    // ships on.
    expect(planRepoOpen(['/M/Mono-Feat-X/'], '/m/mono-feat-x')).toBe('');
  });

  it('is nothing for an empty target', () => {
    // A cold worktree probe and a directory outside git both arrive as '', and
    // neither may clear or churn Source Control.
    expect(planRepoOpen(['/m/mono'], '')).toBe('');
    expect(planRepoOpen(['/m/mono'], undefined)).toBe('');
  });

  it('does NOT treat a containing repository as the one that is showing', () => {
    // An open repository at ~/mono-feat-x does not mean the lane below it is
    // showing — it means the monorepo is showing, which is a different SCM
    // view. Widening this to containment would make the feature no-op in
    // exactly the case it was written for.
    expect(planRepoOpen(['/m/mono-feat-x'], '/m/mono-feat-x/api')).toBe(
      '/m/mono-feat-x/api',
    );
  });

  it('asks for the repository when nothing has it', () => {
    expect(planRepoOpen([], '/m/mono-feat-x')).toBe('/m/mono-feat-x');
    expect(planRepoOpen(['/other'], '/m/mono-feat-x')).toBe('/m/mono-feat-x');
  });
});

describe('SourceControlSync', () => {
  it('does nothing at all when the splice already produced the repository', () => {
    const h = host(['/m/mono-feat-x']);
    return new SourceControlSync(h)
      .follow('/m/mono-feat-x')
      .then((outcome) => {
        expect(outcome).toBe('already-open');
        expect(h.opened).toEqual([]);
      });
  });

  it('opens an unopened repository exactly once', async () => {
    const h = host([]);
    const sync = new SourceControlSync(h);
    expect(await sync.follow('/m/mono-feat-x')).toBe('opened');
    expect(await sync.follow('/m/mono-feat-x')).toBe('already-open');
    expect(h.opened).toEqual(['/m/mono-feat-x']);
  });

  it('serialises, so two follows in flight do not both open the same thing', async () => {
    const h = host([]);
    const sync = new SourceControlSync(h);
    const [a, b] = await Promise.all([
      sync.follow('/m/mono-feat-x'),
      sync.follow('/m/mono-feat-x'),
    ]);
    expect([a, b]).toEqual(['opened', 'already-open']);
    expect(h.opened).toEqual(['/m/mono-feat-x']);
  });

  it('says nothing for an empty target and never touches the host', async () => {
    const h = host(['/m/mono']);
    const sync = new SourceControlSync(h);
    expect(await sync.follow('')).toBe('nothing');
    expect(await sync.follow(undefined)).toBe('nothing');
    expect(h.opened).toEqual([]);
  });

  it('is a no-op with no git host at all', async () => {
    // A missing extension, a disabled `git.enabled`, an API version that
    // moved: all of them arrive here as null, and all of them mean the splice
    // half of the feature is on its own — which is the ordinary case anyway.
    expect(await new SourceControlSync(null).follow('/m/mono')).toBe('refused');
  });

  it('never throws, whatever the git API does, and recovers afterwards', async () => {
    let broken = true;
    const h = host([], {
      repositories: () => {
        if (broken) throw new Error('git model not found');
        return [];
      },
      open: async () => {
        throw new Error('rejected');
      },
    });
    const sync = new SourceControlSync(h);
    expect(await sync.follow('/m/mono')).toBe('refused');
    broken = false;
    // Listing works again; the open still rejects. Still `refused`, still no
    // throw — a follow is a courtesy on top of a splice that already happened
    // and may never take a window down.
    expect(await sync.follow('/m/mono')).toBe('refused');
  });

  it('reports a declined open as refused rather than pretending', async () => {
    // `openRepository` resolving null is the git extension saying no — which
    // is what a user on an editor whose build predates the skip-the-parent-
    // check behaviour will see, and the remedy is theirs
    // (`git.openRepositoryInParentFolders: "always"`), not ours to write.
    const h = host([], { open: async () => false });
    expect(await new SourceControlSync(h).follow('/m/mono')).toBe('refused');
  });
});
