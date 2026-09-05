// test/settingsEditor.test.ts — the built-in Settings editor IS Flock's
// settings page, and the manifest is what makes it read like one.
//
// There is no page of Flock's own. `contributes.configuration` is an array of
// categories, one per group of design/settings-tiers.md, and the editor draws
// them as a table of contents under Extensions › Flock; every row carries an
// `order` so a category reads top to bottom the way the design lists it. None
// of that is checked by anything at runtime — a category without a title, a
// row without an order, a key contributed twice all render, just wrong — so
// this suite holds the manifest to the shape the editor is being asked to draw.

import { describe, expect, it } from 'vitest';

import { windowModelChoices } from '../src/recommend';
import { contributedSettings, settingsCategories } from './manifest';

/** The categories, in the order the editor should list them. Pinned as a
 *  list rather than counted: a category renamed or moved is a change to the
 *  page a reader has learned, and should show up in review by name. */
const CATEGORY_TITLES = [
  'Sessions',
  'Attention',
  'Forking and closing',
  'Worktrees and branches',
  'Accounts and sections',
  'Window',
  'What the tree shows',
  'Housekeeping',
  'CLI',
  'Hooks and verbs',
];

describe('the settings editor: categories', () => {
  it('contributes the categories as an array, titled and in a fixed order', () => {
    const categories = settingsCategories();
    expect(Array.isArray(categories)).toBe(true);
    expect(categories.map((c) => c.title)).toEqual(CATEGORY_TITLES);
    // `order` is what the editor sorts by; the array order alone is not
    // honoured across categories, so a missing or repeated value would let
    // Housekeeping float above Sessions.
    const orders = categories.map((c) => c.order);
    expect(orders).toEqual(categories.map((_, at) => at + 1));
  });

  it('contributes every setting exactly once, and every one under the lineage. prefix', () => {
    const seen = new Map<string, string>();
    for (const category of settingsCategories()) {
      for (const key of Object.keys(category.properties)) {
        expect(key.startsWith('lineage.'), key).toBe(true);
        expect(seen.has(key), `${key} in both ${seen.get(key)} and ${category.title}`).toBe(
          false,
        );
        seen.set(key, category.title);
      }
      // An empty category is a heading over nothing.
      expect(Object.keys(category.properties).length, category.title).toBeGreaterThan(0);
    }
    expect(Object.keys(contributedSettings()).length).toBe(seen.size);
  });

  it('gives every row an order that runs 1..n inside its category', () => {
    for (const category of settingsCategories()) {
      const orders = Object.values(category.properties).map((p) => p.order);
      expect(orders, category.title).toEqual(orders.map((_, at) => at + 1));
    }
  });

  // The placements that decide what a reader meets first. Not the whole
  // table — that is the manifest's to carry — but the rows whose category is
  // the argument of the design: tmux is the Sessions question, the window
  // model is what a window IS, the binaries are a CLI matter, and the two
  // reader gates the installs flip belong together.
  it('puts the load-bearing rows in the categories the design names', () => {
    const categoryOf = new Map<string, string>();
    for (const category of settingsCategories()) {
      for (const key of Object.keys(category.properties)) {
        categoryOf.set(key, category.title);
      }
    }
    expect(categoryOf.get('lineage.tmux')).toBe('Sessions');
    expect(categoryOf.get('lineage.terminalLocation')).toBe('Sessions');
    expect(categoryOf.get('lineage.notifications.enabled')).toBe('Attention');
    expect(categoryOf.get('lineage.close.summaryMode')).toBe('Forking and closing');
    expect(categoryOf.get('lineage.git.branches')).toBe('Worktrees and branches');
    expect(categoryOf.get('lineage.accounts.section')).toBe('Accounts and sections');
    expect(categoryOf.get('lineage.shells.section')).toBe('Accounts and sections');
    expect(categoryOf.get('lineage.mode')).toBe('Window');
    expect(categoryOf.get('lineage.showForeignSessions')).toBe('What the tree shows');
    expect(categoryOf.get('lineage.session.closeAfterMinutes')).toBe('Housekeeping');
    expect(categoryOf.get('lineage.claudeBinary')).toBe('CLI');
    expect(categoryOf.get('lineage.hooks.enabled')).toBe('Hooks and verbs');
    expect(categoryOf.get('lineage.verbs.enabled')).toBe('Hooks and verbs');
  });

  // The deprecation marker step A verified is a per-property field, and a
  // move between categories is exactly the edit that drops one.
  it('keeps the deprecation marker on the superseded window key through the move', () => {
    const legacy = contributedSettings()['lineage.workspaces.enabled'];
    expect(legacy).toBeDefined();
    expect(legacy?.markdownDeprecationMessage).toContain('#lineage.mode#');
  });
});

/** Tier D of design/settings-tiers.md §3 — paths, timings, diagnostics,
 *  previews, and anything that needs a reload. Pinned by name: `@tag:advanced`
 *  is the Advanced list, and a key that falls off it silently joins the
 *  Preferences a first-time reader is meant to be able to read without it. */
const ADVANCED = [
  'lineage.claudeBinary',
  'lineage.codexBinary',
  'lineage.pollIntervalMs',
  'lineage.chat.autoCloseMinutes',
  'lineage.session.detachGraceMinutes',
  'lineage.session.reloadGraceSeconds',
  'lineage.sessionSwitching',
  'lineage.showArchived',
  'lineage.showPhantomRows',
  'lineage.busyStaleMinutes',
  'lineage.workspaces.resumeSessions',
  'lineage.explorer.followProject',
  'lineage.explorer.scope',
  'lineage.runningBadge',
  'lineage.groupSessionsByBranch',
  'lineage.branchColors',
  'lineage.git.worktreePath',
  'lineage.git.sessionBranchDetail',
  'lineage.preview.directoryModel',
  'lineage.viewStyle',
];

describe('the settings editor: tags', () => {
  it('tags every tier D key advanced, and nothing else', () => {
    const settings = contributedSettings();
    const tagged = Object.entries(settings)
      .filter(([, p]) => p.tags?.includes('advanced'))
      .map(([key]) => key)
      .sort();
    expect(tagged).toEqual([...ADVANCED].sort());
  });

  // VS Code's own tags where they apply: the editor draws its Preview badge
  // for `preview`, and `usesOnlineServices` is its filter for settings that
  // reach the network — which in Flock is exactly one.
  it("carries VS Code's preview and usesOnlineServices tags on the two rows they describe", () => {
    const settings = contributedSettings();
    expect(settings['lineage.preview.directoryModel']?.tags).toContain('preview');
    const online = Object.entries(settings)
      .filter(([, p]) => p.tags?.includes('usesOnlineServices'))
      .map(([key]) => key);
    expect(online).toEqual(['lineage.git.pullRequests']);
  });

  // Within a category the visible rows come first, so a reader can stop at
  // the first advanced one and have read everything that is a preference.
  it('orders advanced rows after the visible ones inside every category', () => {
    for (const category of settingsCategories()) {
      const rows = Object.values(category.properties);
      const firstAdvanced = rows.findIndex((p) => p.tags?.includes('advanced'));
      if (firstAdvanced === -1) continue;
      for (const row of rows.slice(firstAdvanced)) {
        expect(row.tags, `${category.title}: a visible row below an advanced one`).toContain(
          'advanced',
        );
      }
    }
  });
});

describe('the settings editor: enums say what they mean', () => {
  it('gives every enum a label and a sentence per value', () => {
    let enums = 0;
    for (const [key, p] of Object.entries(contributedSettings())) {
      if (p.enum === undefined) continue;
      enums += 1;
      expect(p.enumItemLabels, `${key} enumItemLabels`).toHaveLength(p.enum.length);
      expect(p.enumDescriptions, `${key} enumDescriptions`).toHaveLength(p.enum.length);
      // A label that is the value again is no label, and two values wearing
      // one label cannot be told apart in the dropdown.
      for (const label of p.enumItemLabels ?? []) {
        expect(label.trim().length, key).toBeGreaterThan(0);
        expect(p.enum, `${key}: label "${label}" is a raw value`).not.toContain(label);
      }
      expect(new Set(p.enumItemLabels).size, key).toBe(p.enum.length);
    }
    // The loop asserting nothing is the failure mode this guards against.
    expect(enums).toBeGreaterThan(0);
  });

  // The window model's dropdown and the gear's picker are two spellings of one
  // question, and the labels are how they are kept from disagreeing: each
  // picker label must be readable in the dropdown's label for the same value.
  it('labels lineage.mode with the words the window-model picker uses', () => {
    const mode = contributedSettings()['lineage.mode'];
    expect(mode?.enum).toBeDefined();
    const labels = new Map(
      (mode?.enum ?? []).map((value, at) => [value, mode?.enumItemLabels?.[at] ?? '']),
    );
    for (const choice of windowModelChoices({ mode: undefined, workspacesEnabled: true })) {
      expect(labels.get(choice.id), choice.id).toContain(choice.label);
    }
  });
});
