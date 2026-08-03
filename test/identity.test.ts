// Release tripwire for the extension id. Not a smoke test — this file exists to
// FAIL, loudly, if anyone ever changes the publisher or the extension name.
//
// VS Code derives `globalStorageUri` from `<publisher>.<name>`, so the id is
// also the name of the directory our entire editorial store lives in. Change
// the id and the next launch gets a fresh, empty `state.json`: every project,
// every renamed session, every hidden folder, every saved workspace layout and
// every configured account is still on disk, but under a directory nothing
// reads any more. The sidebar comes back looking factory-new.
//
// That is not hypothetical: it happened three times before the first release —
// once for the extension name, once for the publisher, and once more when
// `canopy` turned out to be taken on the Marketplace and the name became
// `flock`. Each time the state had to be carried across by hand with the editor
// shut down, because `mergeStates` is newest-clock-wins per record
// (`src/state.ts`) and a running window holding the empty state wins on write.
//
// Those were survivable because the population was one machine and the fix was
// `cp -R` between two globalStorage directories. That is the ONLY reason no
// legacy-import shim exists in this codebase. The moment 0.1.0 is published
// that reasoning expires, and the paragraph below is the whole rule.
//
// Before the first release that was survivable — the population was one machine.
// After it is not, because a user whose store is orphaned has no way back from
// inside the product: `lineage.reopenProject` only lists projects with
// `hidden === true`, so an empty store just says "no closed projects".
//
// Why `test/scaffold.test.ts` does not already cover this: it asserts
// `EXTENSION_ID === `${pkg.publisher}.${pkg.name}``. That catches types.ts and
// the manifest DRIFTING APART — the bug that silently broke cross-window focus
// — but it passes happily when both sides are renamed together, which is
// exactly the change that orphans the store. A guard has to restate the literal
// to catch that, which is why this one does.
//
// If this test is failing because you deliberately want a new id: that is a
// migration, not a rename. Ship a one-time legacy import at activation (adopt
// the old directory's state.json when ours has no projects) in the SAME commit,
// then update the literals below.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { EXTENSION_ID, EXTENSION_NAME, PUBLISHER } from '../src/types';

const ROOT = path.join(__dirname, '..');

/** The published identity. Permanent: see the note at the top of this file. */
const FROZEN_PUBLISHER = 'hjulaxel';
const FROZEN_NAME = 'flock';
const FROZEN_ID = `${FROZEN_PUBLISHER}.${FROZEN_NAME}`;

const ORPHANS_STATE =
  'Changing the extension id renames the globalStorage directory and orphans ' +
  'every existing install: projects, session titles, hidden folders, saved ' +
  'workspaces and accounts all disappear. Ship a legacy-import migration in ' +
  'the same commit, or revert this change.';

describe('identity: the extension id is frozen', () => {
  it('pins the publisher', () => {
    expect(PUBLISHER, ORPHANS_STATE).toBe(FROZEN_PUBLISHER);
  });

  it('pins the extension name', () => {
    expect(EXTENSION_NAME, ORPHANS_STATE).toBe(FROZEN_NAME);
  });

  it('pins the composed extension id', () => {
    expect(EXTENSION_ID, ORPHANS_STATE).toBe(FROZEN_ID);
  });

  // The manifest is the side VS Code actually reads. Pinning types.ts alone
  // would let a manifest-only edit through, and the scaffold test would then
  // fail pointing at the drift rather than at the orphaning, which buries the
  // consequence that matters.
  it('pins the manifest that VS Code reads the id from', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
    ) as { publisher: string; name: string };

    expect(pkg.publisher, ORPHANS_STATE).toBe(FROZEN_PUBLISHER);
    expect(pkg.name, ORPHANS_STATE).toBe(FROZEN_NAME);
  });

  // The focus URI is resolved by extension id, so it is the other thing that
  // breaks on a rename — silently, since an unroutable vscode:// URI is simply
  // never delivered. Cheap to assert here alongside the id itself.
  it('composes a focus URI carrying the frozen id', () => {
    expect(`vscode://${EXTENSION_ID}/focus`).toBe('vscode://hjulaxel.flock/focus');
  });
});
