// The webview tree, client half.
//
// A DUMB PAINTER. It owns no model: the extension posts a flat, ordered row list
// and this file turns it into DOM. Every decision about what is visible, in what
// order, at what depth is made in src/viewmodel.ts, where it is unit-testable.
// The only state kept here is transient UI state the extension does not care
// about mid-gesture: which row is focused, and the in-flight rename.
//
// Runs under a strict CSP with a nonce; no imports, no globals beyond the
// acquireVsCodeApi handle.

(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  /** @type {HTMLElement} */
  const root = document.getElementById('tree');

  /** Last model posted by the extension. */
  let rows = [];
  /** provider id -> {light, dark} webview uris. */
  let icons = {};
  /** glyph name -> the webview uri of its svg, drawn as a CSS mask. Covers both
   *  the row's hover buttons and the small marks beside a label. */
  let glyphs = {};
  /** `lineage.onlyActiveSessions` is on. Used for one thing only: which
   *  sentence an EMPTY tree says. */
  let filtered = false;
  /** Row key of the focused row, or null. Survives a re-render by key. This is
   *  the CURSOR — where the ring is and what the arrow keys move — and it is
   *  always a member of `selection` while anything is selected. */
  let focusKey = null;
  /**
   * Every selected row key. One entry for an ordinary click; more once a
   * shift-click or ctrl/cmd-click extends it.
   *
   * A Set rather than an array: the range walk and the toggle both ask "is this
   * key in?" far more often than they ask "in what order", and the ORDER that
   * matters (which sessions, top to bottom) is recovered from `rows` at the one
   * moment it is needed — reporting the selection to the extension. Keeping a
   * second ordered copy in sync with the model's own order is the bug this
   * avoids.
   */
  let selection = new Set();
  /** Where a shift-range starts: the last row picked WITHOUT shift. Kept apart
   *  from `focusKey`, which shift-clicking moves — that is the whole difference
   *  between "extend from where I started" and a range that walks away from
   *  under you as you shift-click down a list. */
  let anchorKey = null;
  /** Row key being renamed, or null. */
  let editingKey = null;
  /**
   * The row key a drag started on, or null.
   *
   * `text/plain` carries the dragged SESSION's id, which is what every existing
   * drop path reads — but a project has no session id, and its uuid would be
   * indistinguishable from one if it did. The key names the row and its kind in
   * one string, and the drag never leaves this page, so module state is a
   * truthful place to keep it for the length of the gesture.
   */
  let dragKey = null;
  /** The in-flight rename, `{ key, input, cancel }`, or null while nothing is
   *  being renamed. Set for as long as an input is on screen, so a re-render
   *  does not destroy it. `cancel` is the same teardown the Escape key runs,
   *  exposed on the object so a model update that takes the row away can end
   *  the edit properly instead of orphaning the input. */
  let editing = null;

  const MAX_TITLE_LEN = 80;

  /** Gutter geometry, in px, and the ONE copy of it that is arithmetic rather
   *  than paint. Every one of these has a twin in webtree.css (--indent,
   *  --rail-col, --node-size, --dot-size) and the two must move together: this
   *  file decides WHERE each rail, elbow and node goes, the stylesheet decides
   *  what they look like once they are there.
   *
   *  INDENT is one level of nesting. RAIL_COL is the column the node itself
   *  sits in — the same 16px the workbench gives its twisty, so the provider
   *  logo, the label and everything right of it stay exactly where they have
   *  always been. HALF is the node's column centre inside that column, so
   *  column k's centre is HALF + k * INDENT and a row at rail depth d is
   *  RAIL_COL + d * INDENT wide in the gutter. */
  const INDENT = 12;
  const RAIL_COL = 16;
  const HALF = 8;
  /** How far the elbow stops SHORT of its node's column: at the ring's left
   *  edge for a toggle, at the dot's for a leaf. The line must die at the glyph,
   *  never run under it — a rail crossing the inside of a ⊕ is the one thing
   *  that makes the whole spine read as a scribble.
   *
   *  Each is (size - 1) / 2, not size / 2, and the odd-looking arithmetic is the
   *  same half pixel the stylesheet centres the glyphs with: a rail at x covers
   *  [x, x+1), so its centre is x + 0.5 and an 11px ring centred on it starts at
   *  x - 5. Measured from the column, that is 5, and 2 for the 5px dot. */
  const RING_RADIUS = 5;
  const DOT_RADIUS = 2;

  // ------------------------------------------------------- the device grid
  //
  // A 1px CSS line is only ONE pixel on screen when the page is scaled by a
  // whole number. VS Code's zoom is not: one zoom step is x1.2, so a rail asked
  // to sit at x=12 with a width of 1 is asked to cover device pixels
  // [14.4, 15.6) — and Chromium, which cannot light two fifths of a pixel,
  // paints BOTH 14 and 15 at partial strength. The result is a two-pixel-wide
  // soft grey line where a one-pixel crisp one was drawn, on every rail, every
  // stem and every elbow at once. It is subtle and it is wrong, and it is the
  // whole reason the spine can look heavier than the workbench's own guides.
  //
  // The fix is to stop handing the rasteriser fractions. Both halves are needed:
  // `snapToDevice` puts the line's left edge exactly on a device-pixel
  // boundary, and `--hairline` makes it exactly a whole number of device pixels
  // wide. Neither alone is enough — an integer width still smears if it starts
  // mid-pixel, and an integer start still smears if the width is fractional.
  //
  // On a 1x display and on a Retina one at 100% zoom this changes NOTHING:
  // floor(1)/1 and floor(2)/2 are both 1 CSS px, which is what the stylesheet
  // already says. It only bites at the fractional ratios (1.2, 1.5, 2.4 …) that
  // zooming produces, which is exactly where the smear lives.
  let dpr = window.devicePixelRatio || 1;

  /** `px` moved to the nearest device-pixel boundary. */
  const snapToDevice = (px) => Math.round(px * dpr) / dpr;

  /** One hairline, in CSS px: the largest whole number of device pixels that is
   *  no heavier than the 1px the stylesheet asks for. FLOOR, not round, because
   *  the complaint a fractional ratio produces is always "too thick" — at 1.5x,
   *  rounding up would make our lines heavier than every other line on screen,
   *  where flooring makes them the thinnest crisp line the display can draw. */
  const hairline = () => Math.max(1, Math.floor(dpr)) / dpr;

  /** Publish the hairline to the stylesheet, which is where the rails, the stems
   *  and the elbow's two borders read their width from. A CSSOM write, not a
   *  style attribute — the page's CSP has no nonce to give an inline style. */
  function syncHairline() {
    document.documentElement.style.setProperty('--hairline', hairline() + 'px');
  }

  /** A zoom change alters devicePixelRatio WITHOUT reloading the page, so the
   *  snapped offsets baked into the last render would be snapped to the old
   *  grid. matchMedia is the only event for it: a `resolution` query matching
   *  the current ratio goes false the moment the ratio moves, and the listener
   *  has to be re-armed each time because the next query is a different one. */
  function watchDevicePixelRatio() {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => {
      dpr = window.devicePixelRatio || 1;
      syncHairline();
      render();
      watchDevicePixelRatio();
    };
    // addEventListener is the modern spelling; addListener is kept for a host
    // whose Electron predates it. Once, either way — the query is replaced.
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', onChange, { once: true });
    } else if (typeof query.addListener === 'function') {
      query.addListener(onChange);
    }
  }

  // ---------------------------------------------------------------- helpers

  const rowByKey = (key) => rows.find((r) => r.key === key) || null;
  const indexOfKey = (key) => rows.findIndex((r) => r.key === key);

  /** The rendered element for a row key, or null if it is not on screen. */
  const rowElement = (key) =>
    key === null ? null : root.querySelector('[data-key="' + cssEscape(key) + '"]');

  function post(type, payload) {
    vscode.postMessage(Object.assign({ type }, payload || {}));
  }

  // ------------------------------------------------------------- selection
  //
  // Explorer semantics, and only for SESSION rows. A project or folder row is a
  // section header: there is no verb that takes several of them, and letting one
  // into a range would make "the rows between these two" mean something
  // different depending on which headers the range happened to cross. Clicking a
  // header therefore always collapses the selection to that header alone, which
  // is exactly what the single-row selection has always done.

  const selectable = (row) => !!row && row.kind === 'session';

  /** Which modifier means "add this row to the selection".
   *
   *  Cmd on a Mac and Ctrl everywhere else, and the distinction is not cosmetic:
   *  on macOS a CTRL-click IS a right-click — it fires mousedown with ctrlKey
   *  set and button 0, then a contextmenu event — so reading ctrlKey there would
   *  toggle a row out of the selection at the exact moment the user is
   *  right-clicking it to reach the menu that acts on the selection. */
  const ADDITIVE_IS_META = /Mac|iPhone|iPad|iPod/.test(
    (navigator && (navigator.platform || navigator.userAgent)) || '',
  );
  const additive = (e) => (ADDITIVE_IS_META ? e.metaKey : e.ctrlKey);

  /** The selected SESSIONS, top to bottom, as the extension names them. Derived
   *  from `rows` rather than stored, so the order is always the order on screen
   *  and a stale key cannot outlive the row it belonged to. */
  function selectedSessionIds() {
    const out = [];
    for (const row of rows) {
      if (selection.has(row.key) && row.sessionId) out.push(row.sessionId);
    }
    return out;
  }

  /** Tell the extension what is selected. It needs this for one reason: the
   *  context menu on a row is the workbench's, and the workbench hands the
   *  command the ROW it was opened on and nothing else — so the only way "Delete
   *  Sessions" can mean all four of them is if this side says so first. Also
   *  drives the `lineage.multiSelect` context key, which is what swaps the
   *  singular menu entry for the plural one. */
  function reportSelection() {
    post('selection', { keys: Array.from(selection) });
  }

  /** Replace the selection with one row, which is what an ordinary click does. */
  function selectOnly(key) {
    selection = new Set([key]);
    anchorKey = key;
    focusKey = key;
  }

  /** Every selectable row between two keys inclusive, in display order. Returns
   *  null when either end is missing, which is the caller's cue to fall back to
   *  a plain click rather than guess at a range. */
  function rangeBetween(fromKey, toKey) {
    const a = indexOfKey(fromKey);
    const b = indexOfKey(toKey);
    if (a < 0 || b < 0) return null;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const out = [];
    for (let i = lo; i <= hi; i++) {
      if (selectable(rows[i])) out.push(rows[i].key);
    }
    return out;
  }

  /**
   * Move the selection in response to a click (or an arrow key, which passes no
   * event). Returns true when the gesture was a SELECTION gesture and the
   * caller must not also treat it as an ordinary click — shift-clicking a
   * session to extend a range must never also focus its terminal.
   */
  function applySelectionGesture(row, e) {
    const extend = !!e && e.shiftKey;
    const toggle = !!e && additive(e);

    if (!selectable(row) || (!extend && !toggle)) {
      selectOnly(row.key);
      return false;
    }

    if (extend) {
      // From the ANCHOR, not from the focus: shift-clicking three rows down and
      // then two rows back up has to shrink the range, not leave the first
      // extension behind.
      const range = selectable(rowByKey(anchorKey))
        ? rangeBetween(anchorKey, row.key)
        : null;
      if (range === null || range.length === 0) {
        selectOnly(row.key);
        return false;
      }
      selection = new Set(range);
      focusKey = row.key;
      return true;
    }

    // ctrl / cmd: add or remove this one row, and move the anchor here so a
    // following shift-click ranges from the row just touched.
    if (selection.has(row.key) && selection.size > 1) selection.delete(row.key);
    else selection.add(row.key);
    anchorKey = row.key;
    focusKey = row.key;
    return true;
  }

  /** '' when the name is usable, else why not. Mirrors titleRefusal() in
   *  commands.ts — the extension re-validates, this is just the fast feedback. */
  function refuse(value) {
    const trimmed = value.trim();
    if (trimmed.length === 0) return 'Name cannot be empty.';
    if (trimmed.length > MAX_TITLE_LEN) {
      return 'Name must be ' + MAX_TITLE_LEN + ' characters or fewer (currently ' + trimmed.length + ').';
    }
    return '';
  }

  // ----------------------------------------------------------------- render

  function render() {
    // Never blow away an in-flight rename: the user is typing into it, and a
    // roster tick arriving mid-keystroke must not eat the edit.
    if (editing) {
      syncNonEditingRows();
      return;
    }

    root.textContent = '';

    if (rows.length === 0) {
      root.appendChild(emptyState());
      return;
    }

    // Keep the focus ring somewhere real if the row it was on disappeared.
    if (focusKey !== null && indexOfKey(focusKey) < 0) focusKey = null;
    pruneSelection();

    const frag = document.createDocumentFragment();
    for (const row of rows) frag.appendChild(renderRow(row));
    root.appendChild(frag);
  }

  /**
   * Drop selected keys whose rows are gone, and tell the extension if that
   * changed anything.
   *
   * This is what closes the loop after a delete: the rows vanish from the next
   * model post, the selection empties here, and the extension's copy — which is
   * what "Delete Sessions" acts on — empties with it. Without it the menu would
   * go on offering to delete four sessions that are no longer in the tree, and
   * the multi-select context key would stay set over a single row.
   */
  function pruneSelection() {
    if (selection.size === 0) return;
    let changed = false;
    for (const key of Array.from(selection)) {
      if (indexOfKey(key) < 0) {
        selection.delete(key);
        changed = true;
      }
    }
    if (anchorKey !== null && indexOfKey(anchorKey) < 0) anchorKey = null;
    if (changed) reportSelection();
  }

  /** During a rename, refresh everything EXCEPT the edited row, so status and
   *  ages stay live without touching the input.
   *
   *  Reconciliation is by KEY against the DOM, never by index. The model can
   *  gain or lose rows ABOVE the one being renamed — a fork landing from
   *  another window, a poller tick surfacing a new root, a session deleted from
   *  somewhere else — and a positional walk hands the edited row's slot to some
   *  other row's markup the moment that happens. That replaces the live
   *  <input> with a plain row, and Chromium fires no `blur` when a focused
   *  element is removed: nothing would ever run the rename's teardown, so
   *  `editing` would stay set, render() would keep short-circuiting into here,
   *  and wireRow()'s click handler and the tree's keydown handler would keep
   *  returning early on their `if (editing)` guards. That state is a sidebar
   *  that accepts no clicks, no keys and no new rows, and it survives hiding
   *  the view (retainContextWhenHidden) — only a window reload clears it. It
   *  has to be unreachable, so the two ways in are both closed below.
   *
   *  The editing element is PINNED and every other child is rebuilt around it.
   *  Re-INSERTING it is not an option either, even at the same index: Chromium
   *  drops focus and the selection range of an element that is moved, so the
   *  caret would jump out of the box mid-word. Dropping the neighbours and
   *  re-adding them around a node that never moves is the one order-correct
   *  edit that leaves the caret alone, and it leaves root.children[i] lined up
   *  with rows[i] for every i — the positional parity moveFocus() and
   *  markSelection() assume.
   */
  function syncNonEditingRows() {
    const at = indexOfKey(editingKey);
    const pinned = at < 0 ? null : rowElement(editingKey);
    if (!pinned) {
      // The row being renamed has left the model, so there is nothing left to
      // name. End the edit the way Escape does — which drops the input, clears
      // the state and re-renders from the model — rather than leave a dangling
      // `editing`.
      cancelEdit();
      return;
    }

    for (const el of Array.from(root.children)) {
      if (el !== pinned) el.remove();
    }
    for (let i = 0; i < rows.length; i++) {
      if (i === at) continue;
      const el = renderRow(rows[i]);
      if (i < at) root.insertBefore(el, pinned);
      else root.appendChild(el);
    }
  }

  /** End an in-flight rename without committing it, from outside the editor.
   *  Delegates to the rename's own teardown so there is exactly one path that
   *  clears `editing`/`editingKey`, re-renders and hands the keyboard back. */
  function cancelEdit() {
    if (editing) {
      editing.cancel();
      return;
    }
    // Defensive: `editing` and `editingKey` are set and cleared together, so
    // this is only reachable if that ever stops being true. Clear the half
    // that is left and repaint rather than paint nothing.
    editingKey = null;
    render();
  }

  function emptyState() {
    const box = document.createElement('div');
    box.className = 'empty';
    const p = document.createElement('div');
    // An empty tree has two quite different causes, and the filter is the one
    // the view cannot show you: with nothing on screen there is no row to
    // explain why, and "no sessions yet" would send someone looking for the
    // sessions they know they have.
    p.textContent = filtered
      ? 'No active sessions. Closed ones are hidden — use the filter in the title bar to show them again.'
      : 'No Claude sessions yet. Start one and its forks will appear here as a tree.';
    box.appendChild(p);
    const btn = document.createElement('button');
    btn.textContent = 'New Claude Session';
    btn.addEventListener('click', () => post('command', { command: 'newSession' }));
    box.appendChild(btn);
    return box;
  }

  /** The project nesting a row is filed under, as plain left padding.
   *  Read by webtree.css, which adds it to whatever padding that row kind
   *  already has — so a branch row keeps its own extra offset and a session row
   *  keeps its gutter, both simply shifted right by the same amount. */
  function applyIndent(el, row) {
    const steps = Number(row && row.indent) || 0;
    if (steps > 0) el.style.setProperty('--row-indent', steps * INDENT + 'px');
  }

  /**
   * ONE branch, on its own row inside the project's band.
   *
   * Returned EARLY, before renderRow's ordinary anatomy, because a branch row
   * shares almost none of it — no gutter, no provider logo, no age, no status
   * dot at the right edge. Threading it through the session layout would mean
   * half a dozen `if (row.kind !== 'branch')` guards in a function whose whole
   * job is that one layout.
   *
   * The whole row is the click target (start a session here), which is why it
   * is a <div role="treeitem"> carrying `data-vscode-context` rather than a
   * <button>: it needs the workbench's native context menu, and the verbs on
   * that menu are the reason the row is worth right-clicking at all.
   */
  function renderBranchRow(row) {
    const chip = row.chip || {};
    const el = document.createElement('div');
    el.className = 'row branch' + (chip.count ? '' : ' empty');
    if (row.expandable) el.classList.add('expandable');
    if (chip.attention) el.classList.add('attention');
    if (row.key === focusKey) el.classList.add('selected', 'focused');
    el.setAttribute('data-key', row.key);
    el.setAttribute('role', 'treeitem');
    el.setAttribute('aria-level', String(row.depth + 1));
    el.setAttribute('title', row.tooltip || '');
    if (row.expandable) el.setAttribute('aria-expanded', String(!!row.expanded));
    el.setAttribute('data-vscode-context', JSON.stringify(row.context));
    applyIndent(el, row);
    // One custom property, read by the swatch, the label and the count at three
    // different opacities — and one place for a colour index with no variable
    // behind it to fall back, instead of three.
    el.style.setProperty(
      '--chip-color',
      'var(--lineage-branch-' + (Number(chip.colorIndex) || 0) + ', var(--vscode-foreground))',
    );

    // Under branch grouping the row OPENS, so it needs the one thing every
    // other openable row in this tree has: a twisty. Drawn as a small chevron in
    // its own column ahead of the swatch — not as the session spine's ⊕ ring,
    // which means "a lineage continues here" and would claim the sessions below
    // are forks of the branch.
    if (row.expandable) {
      const twisty = document.createElement('span');
      twisty.className = 'branch-twisty' + (row.expanded ? ' expanded' : '');
      twisty.setAttribute('aria-hidden', 'true');
      twisty.addEventListener('mousedown', (e) => {
        // mousedown, and stopped, exactly as the session twisty does: the row's
        // own click would otherwise toggle it a second time, straight back.
        e.preventDefault();
        e.stopPropagation();
        post('toggle', { key: row.key });
      });
      el.appendChild(twisty);
    }

    // A small filled square in the icon column, where a session's provider logo
    // sits. THIS is what ties the row to the coloured session names below it:
    // the colour needs a solid block of itself somewhere to be read as a key,
    // and tinted text alone at 11px is not one.
    const swatch = document.createElement('span');
    swatch.className = 'branch-swatch';
    swatch.setAttribute('aria-hidden', 'true');
    el.appendChild(swatch);

    const name = document.createElement('span');
    name.className = 'name branch-name';
    name.textContent = row.label;
    el.appendChild(name);

    el.appendChild(Object.assign(document.createElement('span'), { className: 'spacer' }));

    // Where the checkout stands: `↑2 ↓1 *`, already composed by the extension
    // (formatBranchSync) because the native tree has to say the same thing and
    // two formatters would eventually disagree. Absent on a clean, in-sync or
    // never-probed checkout, which is why this reserves no width of its own —
    // the common case is a row that looks exactly as it did before the numbers
    // existed. Left of the count, so the counts stay in one column down the
    // block whatever each row has to report.
    if (chip.sync) {
      const sync = document.createElement('span');
      sync.className = 'branch-sync';
      sync.textContent = chip.sync;
      el.appendChild(sync);
    }

    // The session count, and ONLY where it says something. Grouped, a collapsed
    // branch row has no other content — the number is all it can report about
    // what is inside. Flat, the sessions are already on screen underneath in
    // that branch's colour, so a count restates the rows below it in the column
    // the eye scans for the one thing they cannot say, and the width is better
    // spent on a long ref. `description` is empty in that case and this draws
    // nothing (see branchRow in src/viewmodel.ts).
    if (row.description) {
      const count = document.createElement('span');
      count.className = 'branch-count';
      count.textContent = row.description;
      el.appendChild(count);
    }

    // The `+` that starts a session on this branch, once a click on the row
    // itself means "open me" instead.
    if (row.actions && row.actions.length) el.appendChild(renderActions(row));

    // The same unread mark the sessions and the project header carry, at branch
    // granularity: with the sessions collapsed this is the only thing that says
    // WHICH branch has finished work waiting on you.
    const badge = document.createElement('span');
    badge.className = 'badge' + (chip.attention ? ' done' : ' none');
    badge.textContent = chip.attention ? '●' : '';
    badge.setAttribute('aria-hidden', 'true');
    el.appendChild(badge);

    wireBranchRow(el, row);
    return el;
  }

  /** The "Others (N)" tail row: same band, same indent, one verb. */
  function renderOthersRow(row) {
    const el = document.createElement('div');
    el.className = 'row branch others';
    applyIndent(el, row);
    if (row.key === focusKey) el.classList.add('selected', 'focused');
    el.setAttribute('data-key', row.key);
    el.setAttribute('role', 'treeitem');
    el.setAttribute('aria-level', String(row.depth + 1));
    el.setAttribute('title', row.tooltip || '');
    el.setAttribute('data-vscode-context', JSON.stringify(row.context));

    // No swatch: this row stands for several branches and has no colour of its
    // own. The empty box keeps the label in the same column as the branches
    // above it, which is what makes it read as the tail of that list.
    el.appendChild(
      Object.assign(document.createElement('span'), { className: 'branch-swatch blank' }),
    );

    const name = document.createElement('span');
    name.className = 'name branch-name';
    name.textContent = row.label;
    el.appendChild(name);

    el.appendChild(Object.assign(document.createElement('span'), { className: 'spacer' }));

    const count = document.createElement('span');
    count.className = 'branch-count';
    count.textContent = row.description || '';
    el.appendChild(count);

    el.appendChild(
      Object.assign(document.createElement('span'), { className: 'badge none' }),
    );

    wireBranchRow(el, row);
    return el;
  }

  /** Click and selection for both branch-block rows. They take the focus ring
   *  like any other row (there are verbs on them, so the keyboard has to be
   *  able to reach one) but never join a multi-selection — `selectable` is
   *  session-only, so applySelectionGesture collapses onto them. */
  function wireBranchRow(el, row) {
    el.addEventListener('mousedown', (e) => {
      if (editing) return;
      applySelectionGesture(row, e);
      markSelection();
      reportSelection();
    });
    el.addEventListener('click', (e) => {
      if (editing) return;
      e.preventDefault();
      // An openable branch row is a container: clicking it opens and shuts
      // it, the way clicking a project header does, and the `+` on the row is
      // what starts a session there. Ungrouped it has no children to show and
      // the click keeps its original meaning.
      if (row.expandable) {
        post('toggle', { key: row.key });
        return;
      }
      post(row.kind === 'branchOthers' ? 'branchOthers' : 'branch', {
        key: row.key,
      });
    });
    el.addEventListener('contextmenu', () => {
      // The workbench opens the native menu off `data-vscode-context`, but it
      // hands the command only the row it was opened on — so the selection has
      // to move here, before the menu reads it.
      if (editing) return;
      if (!selection.has(row.key)) {
        selectOnly(row.key);
        markSelection();
        reportSelection();
      }
    });
  }

  function renderRow(row) {
    if (row.kind === 'branch') return renderBranchRow(row);
    if (row.kind === 'branchOthers') return renderOthersRow(row);

    const el = document.createElement('div');
    el.className =
      'row ' + row.kind + (row.muted ? ' muted' : '') + (row.closed ? ' closed' : '');
    // A project row standing inside another project's block. The class
    // carries the whole visual difference (no top rule, a lighter label weight)
    // — see webtree.css — because the row is otherwise exactly a project row and
    // should stay one.
    if (row.kind === 'project' && (Number(row.indent) || 0) > 0) {
      el.classList.add('nested');
    }
    // Two classes, two meanings: `selected` is every row in the selection (the
    // band), `focused` is the one holding the cursor (the ring). On a
    // single-row selection they land together, which is what they always did.
    if (selection.has(row.key)) el.classList.add('selected');
    if (row.key === focusKey) el.classList.add('focused');
    el.setAttribute('data-key', row.key);
    el.setAttribute('role', 'treeitem');
    el.setAttribute('aria-level', String(row.depth + 1));
    el.setAttribute('title', row.tooltip || '');
    if (row.expandable) el.setAttribute('aria-expanded', String(!!row.expanded));
    // This is what gives the row a NATIVE context menu: the workbench overlays
    // these as context keys and forwards the object to the command.
    el.setAttribute('data-vscode-context', JSON.stringify(row.context));

    if (row.canDrag) el.draggable = true;
    // The project a row is filed under, as padding. Everything else about
    // the row's geometry is unchanged — see applyIndent.
    applyIndent(el, row);

    // EVERY row starts at the same 4px (webtree.css's `.row`), and all the
    // indentation that is left lives inside the gutter, which only a session
    // draws. `row.depth` is therefore no longer a paint input — it stays on the
    // row as aria-level and as what ArrowLeft walks — and a session sits at the
    // same x whether it is filed under a project, under a folder, or under
    // nothing at all.
    //
    // A header used to cost its children one level of plain padding, because it
    // had a toggle of its own standing in a glyph column and its rows had to
    // clear it. It has neither now (see renderGutter's caller below): a project
    // reads as a section header — a band, a bold label — the way the Explorer
    // heads a workspace folder, and a band needs no column. Dropping the level
    // gives every session row in the tree 12px back, which in a sidebar is the
    // difference between reading a name and reading half of one.
    //
    // The spine itself belongs to sessions. A project or folder row is a header,
    // not a node in anyone's lineage (viewmodel.ts gives both `rails: []`), so a
    // gutter there would put a lone ⊕ in front of a heading — a control saying
    // "there is a subtree under here" about a thing that is not part of the
    // tree's subject. The row still expands and collapses: clicking a header
    // toggles it (wireRow), and ArrowLeft/ArrowRight work off `aria-expanded`.
    if (row.kind === 'session') {
      el.appendChild(
        renderGutter(row, Array.isArray(row.rails) ? row.rails : []),
      );
    }

    el.appendChild(renderIcon(row));

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = row.label;
    // The branch, said in colour instead of in words. Set on the NAME rather
    // than the row so it tints exactly one thing: a whole row in a chart colour
    // would out-shout the status dot, which is the mark this tree is actually
    // read for. Absent under a single-branch or non-git project (the extension
    // withholds branchColor there — see BRANCH_CHIPS_MIN), so those rows keep
    // the theme's own foreground and nothing about them changes.
    //
    // The stylesheet still gets the last word: `.row.closed .name` and
    // `.row.muted .name` are more specific and keep dimming a finished or
    // put-away row grey, because "this is over" outranks "this is on feat/x".
    if (typeof row.branchColor === 'number') {
      name.style.setProperty(
        '--name-color',
        'var(--lineage-branch-' + row.branchColor + ', inherit)',
      );
      name.classList.add('branch-tinted');
    }
    el.appendChild(name);

    // Facts about the row, drawn right of the name: today just the struck-through
    // bell on a session whose notifications are off. Appended only for rows that
    // carry one, so nothing else moves on the rows that do not.
    if (row.marks && row.marks.length) el.appendChild(renderMarks(row));

    // Spacer FIRST, so the description and the dot both sit hard against the
    // right edge: "last touched 5m ago, still running" reads as one thing, and
    // the dots line up in a column instead of drifting with the label width.
    el.appendChild(Object.assign(document.createElement('span'), { className: 'spacer' }));

    if (row.description) {
      const desc = document.createElement('span');
      desc.className = 'desc';
      desc.textContent = row.description;
      el.appendChild(desc);
    }

    // Appended ONLY for rows that carry actions — today just project rows —
    // so a plain session row's geometry, which the dot column's width
    // arithmetic depends on, never shifts to make room for a button no
    // session row has.
    if (row.actions && row.actions.length) el.appendChild(renderActions(row));

    // Always append the dot's box, lit or not. The stylesheet decides its width
    // per tone — a lit dot holds the column open, an idle, closed or absent one
    // collapses it — so the box has to exist on every row for either decision to
    // apply.
    //
    // The mark is DRAWN, never typed: a '●' sits on the text baseline at
    // whatever size the font hands it, where a box with a 50% radius centres on
    // the ROW and is the same shape on every platform. row.badge (the character
    // the native tree writes into its FileDecoration badge) is deliberately left
    // unpainted here — one shape drawn two ways would drift.
    const badge = document.createElement('span');
    badge.className = 'badge ' + (row.badgeKind || 'none');
    // "black circle" is not a status. The word is in the row's title, which is
    // also the accessible description.
    badge.setAttribute('aria-hidden', 'true');
    el.appendChild(badge);

    wireRow(el, row);
    return el;
  }

  /**
   * The lineage spine: the rails, the elbow and the node that replace what used
   * to be a lone chevron.
   *
   * A row draws four things, and each one is a fact from the model rather than
   * anything inferred from the DOM around it:
   *
   *   rail   a straight vertical in an ANCESTOR's column, for every ancestor
   *          that still has something coming below this row (rails[k]). An
   *          ancestor whose last child has already gone past draws nothing, so
   *          the spine ends where the family does instead of running to the
   *          bottom of the view.
   *   elbow  the corner that hangs this row off its parent's rail: down the
   *          parent's column, then a rounded turn right into this row's node.
   *          Every row at rail depth 1+ has exactly one.
   *   stem   the top of this row's OWN rail, from its node down to the row's
   *          bottom edge, where the first child's elbow picks it up. Only on an
   *          expanded row with children (row.descends).
   *   node   the endpoint. A ⊕/⊖ ring where there is something to open, a small
   *          filled dot where the lineage stops. This is the twisty.
   *
   * Everything is absolutely positioned against the gutter, so a row's spine
   * costs no layout and cannot push the label around: the gutter is one box of
   * a known width and the rest is paint inside it.
   */
  function renderGutter(row, rails) {
    const depth = rails.length;
    const box = document.createElement('span');
    box.className = 'gutter';
    // The spine is a picture of what the indentation already says, and the row
    // carries aria-level and aria-expanded for the parts that are not decorative.
    box.setAttribute('aria-hidden', 'true');
    box.style.width = RAIL_COL + depth * INDENT + 'px';

    // Every `left` below goes through snapToDevice: these four pieces are the
    // hairlines, and a hairline that starts mid-pixel is painted across two of
    // them however thin it is. Widths come from --hairline in the stylesheet.
    for (let k = 0; k < depth; k++) {
      if (!rails[k]) continue;
      const rail = document.createElement('i');
      rail.className = 'rail';
      rail.style.left = snapToDevice(HALF + k * INDENT) + 'px';
      box.appendChild(rail);
    }

    const centre = HALF + depth * INDENT;

    if (depth > 0) {
      const elbow = document.createElement('i');
      elbow.className = 'elbow';
      elbow.style.left = snapToDevice(centre - INDENT) + 'px';
      elbow.style.width =
        INDENT - (row.expandable ? RING_RADIUS : DOT_RADIUS) + 'px';
      box.appendChild(elbow);
    }

    if (row.descends) {
      const stem = document.createElement('i');
      stem.className = 'stem';
      stem.style.left = snapToDevice(centre) + 'px';
      box.appendChild(stem);
    }

    // The node is a full-height 16px hit box with the glyph drawn inside it:
    // an 11px ring is a small target for a gesture people make constantly, and
    // the box costs nothing to widen. Appended LAST so it paints over the stem
    // it sits on top of.
    const node = document.createElement('span');
    node.className =
      'node ' + (row.expandable ? (row.expanded ? 'toggle expanded' : 'toggle') : 'leaf');
    // Snapped too, so the ring and the dot keep the exact relationship to the
    // rail they were drawn with: a glyph rounded one way and a line the other
    // is a circle sitting half a pixel off its own stem.
    node.style.left = snapToDevice(centre - RAIL_COL / 2) + 'px';
    const mark = document.createElement('i');
    mark.className = row.expandable ? 'ring' : 'dot';
    node.appendChild(mark);
    if (row.expandable) {
      node.addEventListener('mousedown', (e) => {
        // mousedown, not click: matches the workbench, and stops the row's own
        // click handler from also focusing the session.
        e.preventDefault();
        e.stopPropagation();
        post('toggle', { key: row.key });
      });
    }
    box.appendChild(node);

    return box;
  }

  function renderIcon(row) {
    const box = document.createElement('span');
    box.className = 'icon';
    const icon = row.icon || {};
    if (icon.type === 'provider') {
      const uri = icons[icon.provider];
      if (uri) {
        const img = document.createElement('img');
        // The extension picks light/dark per the active theme class on <body>.
        // High-contrast-light's <body> carries BOTH 'vscode-high-contrast' and
        // 'vscode-high-contrast-light', so 'vscode-light' alone is not enough
        // to name it — a check on that class only would hand a high-contrast
        // LIGHT background the mark meant for a dark one.
        const cl = document.body.classList;
        const wantLight = cl.contains('vscode-light') || cl.contains('vscode-high-contrast-light');
        img.src = wantLight ? uri.light : uri.dark;
        img.alt = '';
        box.appendChild(img);
        return box;
      }
    }
    const glyph = document.createElement('span');
    glyph.className = 'codicon' + (icon.tone ? ' ' + icon.tone : '');
    // A tiny glyph table: the webview cannot use the codicon font without
    // shipping it, so these stand in for the three codicons the tree needs.
    // A folder gets NOTHING — the box stays for alignment. It used to hold '▸',
    // a triangle one column from the row's own toggle, which read as a second
    // collapsed marker; the Explorer's own default theme draws no folder icon
    // either. A root project ('none') gets nothing for the same reason a
    // folder does — the CSS section-header treatment hides the whole .icon
    // column for both row kinds, so this box never actually paints on screen,
    // but leaving it empty (rather than falling through to '✳') keeps this
    // function honest if that CSS rule is ever removed.
    glyph.textContent =
      icon.id === 'eye-closed' ? '⊘' :
      icon.id === 'circle-slash' ? '⊘' :
      icon.id === 'folder' || icon.id === 'none' ? '' :
      '✳';
    box.appendChild(glyph);
    return box;
  }

  /** Point a box at one of the extension's svgs, to be painted as a CSS mask
   *  over the theme's icon colour (see .action-glyph / .mark in webtree.css).
   *
   *  Set through the CSSOM, never as a style ATTRIBUTE: a `style="..."` string
   *  is an inline style the page's CSP would have to whitelist, and a
   *  per-element nonce is not a thing. Assigning the property directly is not
   *  covered by style-src at all. Both spellings, because the unprefixed
   *  mask-image is not universal in every Electron the extension is expected to
   *  run under. An unknown name simply leaves the box empty — the extension's
   *  glyph map is the allowlist. */
  function paintGlyph(el, name) {
    const uri = glyphs[name];
    if (!uri) return;
    el.style.webkitMaskImage = 'url("' + uri + '")';
    el.style.maskImage = 'url("' + uri + '")';
  }

  /** The row's non-interactive marks — a fact about the session, drawn just
   *  right of its name. Model-driven like everything else here: the extension
   *  decides which rows carry which mark and what it is called. */
  function renderMarks(row) {
    const box = document.createElement('span');
    box.className = 'marks';
    for (const mark of row.marks || []) {
      const glyph = document.createElement('span');
      glyph.className = 'mark';
      paintGlyph(glyph, mark.icon);
      // Not aria-hidden: this is the only place the row says it has been
      // silenced, and a title is what a pointer and a screen reader both read.
      glyph.setAttribute('role', 'img');
      glyph.setAttribute('aria-label', mark.title);
      glyph.title = mark.title;
      box.appendChild(glyph);
    }
    return box;
  }

  /** A row's outboard button strip. Model-driven like everything else here:
   *  the extension decides WHICH rows get WHICH actions and what each one is
   *  titled (src/viewmodel.ts's row.actions), and this just paints whatever
   *  it is handed. */
  function renderActions(row) {
    const box = document.createElement('span');
    box.className = 'actions';
    for (const action of row.actions || []) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'action';
      btn.title = action.title;
      btn.setAttribute('aria-label', action.title);

      const glyph = document.createElement('span');
      glyph.className = 'action-glyph';
      paintGlyph(glyph, action.icon);
      btn.appendChild(glyph);

      // The row underneath is a click target too (it toggles the project open
      // and shut). Without stopPropagation the button's click ALSO collapses
      // the project it was clicked on — the action would appear to work and
      // fold the tree at the same time.
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        post('action', { key: row.key, action: action.id });
      });
      // Only stops propagation — the row's own mousedown moves selection and
      // starts a drag gesture, neither of which should happen because a button
      // was pressed.
      btn.addEventListener('mousedown', (e) => {
        e.stopPropagation();
      });

      box.appendChild(btn);
    }
    return box;
  }

  function wireRow(el, row) {
    // Whether the mousedown that started this click was a selection gesture —
    // shift or ctrl/cmd — and the click must therefore not ALSO open the
    // session. Read on the mousedown rather than the click because that is
    // where the gesture is decided, and stored on the row's closure rather than
    // in module state so two rows cannot race each other.
    let gesture = false;

    el.addEventListener('mousedown', (e) => {
      // Left button only, and on a Mac not a ctrl-click either — that is a
      // right-click, and it arrives here as button 0 with ctrlKey set BEFORE
      // the contextmenu event. A right-click's selection move belongs to the
      // contextmenu handler below, which has one more thing to know than this
      // one does: whether the row is already part of a selection it must leave
      // alone. Running both would collapse that selection here and then find
      // nothing left to preserve there.
      if (e.button !== 0 || (ADDITIVE_IS_META && e.ctrlKey)) return;
      gesture = applySelectionGesture(row, e);
      markSelection();
      reportSelection();
      root.focus();
    });

    el.addEventListener('click', () => {
      if (editing) return;
      // Extending a range must never focus a terminal or resume a closed
      // session. Picking the fourth row of four is a statement about the
      // SELECTION, and opening something is the one thing you cannot undo by
      // clicking again.
      if (gesture) {
        gesture = false;
        return;
      }
      if (row.kind === 'session') post('activate', { key: row.key });
      else post('toggle', { key: row.key });
    });

    el.addEventListener('dblclick', (e) => {
      e.preventDefault();
      // Explorer parity: double-click on the label renames.
      if (row.canRename) beginRename(row.key);
    });

    // Right-click must also move the selection, or the native menu would act on
    // whatever was selected before — EXCEPT on a row that is already part of a
    // multi-selection, where collapsing to it is precisely what the user is
    // trying not to do. Right-clicking one of four selected sessions to reach
    // "Delete Sessions" has to leave all four selected, which is how every file
    // manager behaves.
    el.addEventListener('contextmenu', () => {
      if (!selection.has(row.key)) {
        selectOnly(row.key);
        reportSelection();
      } else {
        focusKey = row.key;
      }
      markSelection();
      // The left-button path takes the keyboard on mousedown; a right-click
      // never reaches that line, and a menu acting on rows the tree does not
      // visibly own is worse than one that does.
      root.focus();
    });

    if (row.canDrag) {
      el.addEventListener('dragstart', (e) => {
        // The session id stays the payload for a session drag — every existing
        // drop path reads it. A project drag has no session id to carry, so the
        // ROW KEY is what identifies the source (see `dragKey`), and it is set
        // for both kinds so the extension never has to guess.
        e.dataTransfer.setData('text/plain', row.sessionId || '');
        e.dataTransfer.effectAllowed = 'move';
        dragKey = row.key;
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => {
        dragKey = null;
        el.classList.remove('dragging');
      });
    }

    // Every row is a drop target: onto a session re-parents, onto a project
    // adopts the directory, onto a folder detaches to a root.
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      // Stopped so the background handler below cannot ALSO see this drop and
      // read it as "onto empty space", which would un-nest a project the user
      // was filing under another one.
      e.stopPropagation();
      el.classList.remove('drop-target');
      const dragged = e.dataTransfer.getData('text/plain');
      const source = dragKey;
      dragKey = null;
      // A project drag carries no session id, so the key is the whole of it.
      if (source && source.indexOf('project:') === 0) {
        if (source === row.key) return;
        post('drop', { sourceKey: source, targetKey: row.key });
        return;
      }
      if (!dragged || dragged === row.sessionId) return;
      post('drop', { sessionId: dragged, sourceKey: source, targetKey: row.key });
    });
  }

  /** Repaint selection without a full re-render — cheap and keeps the DOM. */
  function markSelection() {
    for (const el of Array.from(root.children)) {
      const key = el.getAttribute('data-key');
      el.classList.toggle('selected', key !== null && selection.has(key));
      el.classList.toggle('focused', key === focusKey);
    }
  }

  // ----------------------------------------------------------- inline rename

  function beginRename(key) {
    // Exactly one edit at a time, and the guard is here rather than at the
    // callers because there are four of them (double-click, F2, the workbench
    // keybinding's postMessage, and a create flow naming what it just made) and
    // only this one knows an edit is open. A second input would leave the first
    // one's teardown holding a stale `editing`, which is the one state that
    // wedges the whole view. Re-asking for the row already being renamed just
    // puts the caret back in it; asking for a different row abandons the
    // half-typed name rather than committing something the user never
    // confirmed.
    if (editing) {
      if (editing.key === key) {
        editing.input.focus();
        editing.input.select();
        return;
      }
      cancelEdit();
    }

    const row = rowByKey(key);
    if (!row || !row.canRename) return;
    const el = rowElement(key);
    if (!el) return;

    const name = el.querySelector('.name');
    if (!name) return;

    // Set only once the edit is certain to start: `editingKey` and `editing`
    // are read as a pair, and a key left behind by a rename that bailed out
    // would describe a row nobody is editing.
    //
    // Naming is a one-row verb, so it COLLAPSES the selection onto the row it
    // is about. Otherwise the rest of a multi-selection would sit there
    // highlighted, looking like it was part of the edit, and a Delete pressed
    // straight afterwards would take rows the user thought they had left.
    selectOnly(key);
    reportSelection();
    editingKey = key;

    // One class, and the stylesheet takes everything else on the row out of the
    // input's way: the age, the status dot and the action buttons all belong to
    // a row you are reading, not to a row you are naming, and every one of them
    // that stays visible is width the edit box does not get. Doing it in CSS
    // rather than by hiding elements one at a time here is also what keeps the
    // box the SAME width on every row — a lit row and an idle row differ by the
    // dot column, and an edit box that changes size with the row's status is a
    // box that looks broken.
    el.classList.add('renaming');

    const input = document.createElement('input');
    input.className = 'rename';
    input.type = 'text';
    input.value = row.label;
    input.setAttribute('aria-label', 'New name');
    name.replaceWith(input);

    let validation = null;
    const showRefusal = (message) => {
      input.classList.toggle('invalid', message !== '');
      if (message === '') {
        if (validation) {
          validation.remove();
          validation = null;
        }
        return;
      }
      if (!validation) {
        validation = document.createElement('div');
        validation.className = 'validation';
        el.appendChild(validation);
      }
      validation.textContent = message;
      // The box hangs off the row it belongs to, and #tree is a scroll
      // container: hung below the bottom row it is clipped away entirely, and
      // the user is told nothing at all on the one row where "why won't this
      // name take" is asked as often as on any other. Measure the room that is
      // actually left under the row and flip the box above it when there is
      // none. Measured on every message rather than once, because the message
      // wraps to two lines at some sidebar widths and one at others.
      const room = root.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom;
      validation.classList.toggle('above', validation.offsetHeight > room);
    };

    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      editing = null;
      editingKey = null;
      const value = input.value;
      const refusal = refuse(value);
      // A commit of an invalid name is treated as a cancel rather than an error
      // dialog: the Explorer does the same, and the row is right there to retry.
      if (commit && refusal === '') {
        post('rename', { key: key, name: value.trim() });
      } else {
        // Escape, or a commit the local validation refuses. Nothing is renamed,
        // but the extension armed a "hand the keyboard back here afterwards"
        // target when it opened this editor, and only a message can release it:
        // an edit that ends with silence leaves that target armed for the next
        // rename of the same row, which then steals focus into a terminal.
        post('renameCancelled', {});
      }
      // Re-render from the model either way; the extension's own refresh will
      // follow with the committed label.
      render();
      root.focus();
    };

    input.addEventListener('input', () => showRefusal(refuse(input.value)));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      } else {
        // Arrow keys etc. belong to the input while editing, never to the tree.
        e.stopPropagation();
      }
    });
    // Clicking away commits, which is what the Explorer does.
    input.addEventListener('blur', () => finish(true));

    // `cancel` is finish(false) — the Escape path — so that anything which has
    // to end an edit it did not start (a model update that removes the row)
    // runs exactly the same teardown rather than a second copy of it.
    editing = { key: key, input: input, cancel: () => finish(false) };
    input.focus();
    // Pre-selected, so Enter accepts the current name and typing replaces it.
    input.select();
  }

  /** document.querySelector needs the key escaped; keys contain ':' and '/'. */
  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value);
    }
    return value.replace(/["\\]/g, '\\$&');
  }

  // -------------------------------------------------------- keyboard navigation

  /** Rows the focus ring can land on — every row kind, today. Every row in this
   *  tree has something the ring is good for: a session opens, a header toggles,
   *  a branch row starts a session and carries a context menu.
   *
   *  Kept as a named predicate rather than inlined as `true` because all three
   *  walkers below (moveFocus, Home/End, ArrowLeft's parent hop) route through
   *  it, so a row kind that must NOT take the ring has exactly one place to say
   *  so — and no walker can be updated and another forgotten. */
  function focusable(row) {
    return !!row;
  }

  /** Shift+Arrow: walk the cursor one row and take the range with it, from the
   *  anchor. Falls back to a plain move when there is no session range to be
   *  had — off the end of the list, or a cursor sitting on a header. */
  function extendFocus(delta) {
    const at = indexOfKey(focusKey);
    if (at < 0) {
      moveFocus(delta);
      return;
    }
    let i = at + delta;
    while (i >= 0 && i < rows.length && !selectable(rows[i])) i += delta;
    if (i < 0 || i >= rows.length) return;
    if (anchorKey === null || !selectable(rowByKey(anchorKey))) {
      anchorKey = selectable(rows[at]) ? rows[at].key : rows[i].key;
    }
    const range = rangeBetween(anchorKey, rows[i].key);
    if (range === null || range.length === 0) {
      moveFocus(delta);
      return;
    }
    selection = new Set(range);
    focusKey = rows[i].key;
    markSelection();
    reportSelection();
    const el = root.children[i];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  function moveFocus(delta) {
    if (rows.length === 0) return;
    let i = indexOfKey(focusKey);
    i = i < 0 ? (delta > 0 ? 0 : rows.length - 1) : i + delta;
    // Step OVER any non-focusable row in the direction of travel. A run of them
    // is skipped as one; running off either end stops at the last row that can
    // hold the ring rather than wrapping, which is what the clamp below already
    // did for the ends of the list.
    while (i >= 0 && i < rows.length && !focusable(rows[i])) i += delta;
    if (i < 0 || i > rows.length - 1) {
      // Nothing focusable that way. Leave the ring where it was rather than
      // dropping it onto a strip that cannot hold it.
      const back = indexOfKey(focusKey);
      if (back >= 0) return;
      i = rows.findIndex(focusable);
      if (i < 0) return;
    }
    // An arrow key is an ordinary click without an event: it COLLAPSES the
    // selection onto the row it lands on. Moving only the ring would leave the
    // selection behind on the row you arrowed away from, and the context menu —
    // which acts on the selection, not on the ring — would then act on a row
    // that is no longer highlighted.
    focusRow(rows[i].key);
    const el = root.children[i];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  /** Put the ring AND the selection on one row, and tell the extension. The
   *  keyboard's half of applySelectionGesture's no-event path, factored out
   *  because three key handlers need it and each one forgetting to report is a
   *  context menu that acts on the wrong rows. */
  function focusRow(key) {
    selectOnly(key);
    markSelection();
    reportSelection();
  }

  // Empty space below the last row is where a project goes to stop being
  // a subproject. Guarded on `e.target === root` rather than by not registering
  // it: the listener is on the scroll container, so every row's drop bubbles
  // through here, and the row handlers stop propagation for exactly that
  // reason. This is the belt to their braces.
  root.addEventListener('dragover', (e) => {
    if (!dragKey || dragKey.indexOf('project:') !== 0) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });
  root.addEventListener('drop', (e) => {
    if (e.target !== root) return;
    const source = dragKey;
    dragKey = null;
    if (!source || source.indexOf('project:') !== 0) return;
    e.preventDefault();
    post('drop', { sourceKey: source, targetKey: 'background' });
  });

  root.addEventListener('keydown', (e) => {
    if (editing) return; // the input owns the keyboard

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (e.shiftKey) extendFocus(1);
        else moveFocus(1);
        return;
      case 'ArrowUp':
        e.preventDefault();
        if (e.shiftKey) extendFocus(-1);
        else moveFocus(-1);
        return;
      case 'Delete':
      case 'Backspace': {
        // The selection's own verb, and the only one this client asks for by
        // name. Every other row verb arrives through the workbench's context
        // menu, which cannot be opened onto several rows from the keyboard — so
        // without this key a selection made with shift+arrows would have no way
        // to act on itself.
        //
        // Nothing is confirmed here: the extension deletes and offers one Undo,
        // the same deal a single delete has always had. What IS refused is an
        // empty ask — no sessions selected sends no message at all, rather than
        // a command that opens a picker nobody went looking for.
        e.preventDefault();
        if (selectedSessionIds().length > 0) post('deleteSelection');
        return;
      }
      // Both ends look for the outermost FOCUSABLE row rather than simply the
      // first or last one, so that a row kind excluded from the ring (see
      // `focusable`) is skipped here exactly the way moveFocus skips it, rather
      // than leaving the ring somewhere no verb applies.
      case 'Home': {
        e.preventDefault();
        const first = rows.findIndex(focusable);
        if (first >= 0) focusRow(rows[first].key);
        return;
      }
      case 'End': {
        e.preventDefault();
        for (let i = rows.length - 1; i >= 0; i--) {
          if (focusable(rows[i])) {
            focusRow(rows[i].key);
            break;
          }
        }
        return;
      }
      default:
        break;
    }

    const row = rowByKey(focusKey);
    if (!row) return;

    if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (row.expandable && !row.expanded) post('toggle', { key: row.key });
      else moveFocus(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (row.expandable && row.expanded) post('toggle', { key: row.key });
      else {
        // Jump to the parent: the nearest row above at a shallower depth.
        const i = indexOfKey(row.key);
        for (let j = i - 1; j >= 0; j--) {
          // `focusable` as well as the depth test: a row can sit at a shallower
          // depth without being able to hold the ring, and a depth test alone
          // would stop the walk there and drop the cursor.
          if (rows[j].depth < row.depth && focusable(rows[j])) {
            focusRow(rows[j].key);
            break;
          }
        }
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (row.kind === 'session') post('activate', { key: row.key });
      // Enter does what a click does, on every row kind that has a click:
      // starting a session on the branch under the cursor, or opening the
      // picker behind "Others". Falling through to 'toggle' would send a
      // collapse message for a row that does not expand.
      else if (row.kind === 'branch') {
        // Same split as the click: an openable branch row is a container.
        post(row.expandable ? 'toggle' : 'branch', { key: row.key });
      }
      else if (row.kind === 'branchOthers') post('branchOthers', { key: row.key });
      else post('toggle', { key: row.key });
    } else if (e.key === 'F2') {
      e.preventDefault();
      if (row.canRename) beginRename(row.key);
    }
  });

  /**
   * Install the branch palette onto :root, over the defaults the page was
   * served with.
   *
   * Written through the CSSOM rather than into a <style> block, which is the
   * safe half of a value that ultimately comes from a user setting: setProperty
   * either accepts a valid CSS value or silently ignores it, and there is no
   * string context to break out of. The extension sanitises as well
   * (sanitizeBranchColor), so this is the second of two gates, not the only one.
   *
   * A slot whose value is refused keeps whatever the stylesheet gave it, which
   * is the built-in colour for that index — so a typo in one entry costs that
   * one branch its custom colour and nothing else.
   */
  function applyPalette(palette) {
    const style = document.documentElement.style;
    for (let i = 0; i < palette.length; i++) {
      const value = palette[i];
      if (typeof value !== 'string' || value === '') continue;
      style.setProperty('--lineage-branch-' + i, value);
    }
  }

  // ------------------------------------------------------------- extension → us

  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type === 'model') {
      rows = Array.isArray(msg.rows) ? msg.rows : [];
      filtered = msg.filtered === true;
      if (msg.icons) icons = msg.icons;
      if (msg.glyphs) glyphs = msg.glyphs;
      if (Array.isArray(msg.palette)) applyPalette(msg.palette);
      render();
      return;
    }
    if (msg.type === 'beginRename') {
      // F2 came from the workbench keybinding rather than from inside here.
      const key = msg.key || focusKey;
      if (key) beginRename(key);
      return;
    }
    if (msg.type === 'select') {
      // A reveal from the extension — a session it just created or focused. It
      // COLLAPSES the selection onto that row: the extension is naming one row
      // as the interesting one, and leaving a stale multi-selection behind it
      // would point the context menu at rows the user has moved on from.
      focusRow(msg.key);
      const i = indexOfKey(msg.key);
      const el = i >= 0 ? root.children[i] : null;
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
      return;
    }
  });

  root.tabIndex = 0;
  // Before the first model arrives, so the very first paint is already on the
  // device grid rather than snapping into place one tick later.
  syncHairline();
  watchDevicePixelRatio();
  post('ready');
})();
