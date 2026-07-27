// IMPLEMENTED BY: F (M4)
// Cross-window focus. SPEC.md §4-F1 / plan §6.
//
// There is EXACTLY ONE supported mechanism for raising another window:
// every window computes `env.asExternalUri(<uriScheme>://<EXTENSION_ID>/focus)`
// at activation and publishes the resulting OPAQUE string into the shared
// state file. `env.openExternal(handle)` from any window routes to the owning
// window, fires its UriHandler, and force-raises the app (FocusMode.Force ->
// app.focus({steal:true}) on macOS).
//
// The alternatives were measured and all fail:
//   * `vscode.openFolder` on an already-open folder raises the window but with
//     FocusMode.Transfer (on macOS may not bring the app forward), and when the
//     folder is NOT open it restarts the extension host.
//   * `workbench.action.focusWindow` targets only our own window.
//   * `switchWindow` is a user-facing QuickPick.
// And `workspace.updateWorkspaceFolders` explicitly terminates and restarts the
// extension host on the single-folder -> multi-root transition, so it is never
// called anywhere in this extension. Window-per-project is the model.

import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import * as process from 'node:process';

import {
  EXTENSION_ID,
  isSessionId,
  type DisposableLike,
  type WindowDeps,
  type WindowRecord,
} from './types';
import { log, logError } from './log';

/** Path segment our UriHandler answers on. */
const FOCUS_PATH = '/focus';
/** Query key carrying the session to reveal once the window is up. */
const SESSION_PARAM = 'session';

/**
 * Append session=<id> to a focus handle's query WITHOUT clobbering the query
 * `asExternalUri` put there (it carries the owning window's internal
 * windowId, and under Remote/tunnel hosts a forwarded-port token as well).
 * Pure; never throws — a handle we cannot splice is returned unchanged so the
 * caller still attempts the raise.
 *
 * Deliberately a TEXTUAL splice, not the `Uri.parse(...).with(...).toString()`
 * round trip §4-F1's pseudocode sketches. The handle is OPAQUE (§4-F1 also
 * forbids parsing meaning out of it) and its encoding is not ours to
 * normalize: `Uri.parse` percent-DECODES the query and `Uri.toString()`
 * re-encodes it through a table that escapes the sub-delimiters — `&` → `%26`,
 * `=` → `%3D` (verified against the encode table shipped in VS Code's own
 * extension-host bundle). A tunnel handle
 * (`https://<id>.devtunnels.ms/…?tkn=…`) that `openExternal` hands to a
 * BROWSER would then arrive with its separators escaped and its token
 * unreadable, and decoding first also makes a `%26` inside a value look like a
 * pair separator to the split below. Splicing preserves every original byte
 * and adds exactly one encoded pair.
 *
 * Idempotent: a pre-existing `session=` pair is replaced rather than appended
 * to, because the receiving side reads the FIRST occurrence.
 */
export function withSessionQuery(handleUri: string, sessionId: string): string {
  try {
    const hash = handleUri.indexOf('#');
    const base = hash < 0 ? handleUri : handleUri.slice(0, hash);
    const fragment = hash < 0 ? '' : handleUri.slice(hash);
    const mark = base.indexOf('?');
    const head = mark < 0 ? base : base.slice(0, mark);
    const query = mark < 0 ? '' : base.slice(mark + 1);
    const kept = query
      .split('&')
      .filter((p) => p.length > 0 && !/^session=/i.test(p));
    kept.push(`${SESSION_PARAM}=${encodeURIComponent(sessionId)}`);
    return `${head}?${kept.join('&')}${fragment}`;
  } catch (err) {
    logError('windows.withSessionQuery', err);
    return handleUri;
  }
}

export interface FocusIntegration extends DisposableLike {
  readonly windowId: string;
  focusWindow(rec: WindowRecord, sessionId?: string): Promise<boolean>;
}

class FocusIntegrationImpl implements FocusIntegration {
  readonly windowId: string;

  private readonly deps: WindowDeps;
  private readonly disposables: DisposableLike[] = [];
  private disposed = false;
  /** The "Allow ... to open this URI?" explainer is shown at most once. */
  private permissionHintShown = false;

  constructor(windowId: string, deps: WindowDeps) {
    this.windowId = windowId;
    this.deps = deps;
  }

  /** Registers our UriHandler. Receiving a URI already force-raises this
   *  window; the handler only routes the optional session reveal. */
  registerHandler(): void {
    try {
      const reg = vscode.window.registerUriHandler({
        handleUri: (uri: vscode.Uri) => {
          this.handleUri(uri);
        },
      });
      this.disposables.push(reg);
    } catch (err) {
      // Only one UriHandler may exist per extension; a duplicate registration
      // (or a host without the API) costs us inbound focus, nothing else.
      logError('windows.registerUriHandler', err);
    }
  }

  /** Computes this window's opaque focus handle and publishes it. Called on
   *  every activate — handles are NEVER cached across sessions. */
  async publish(): Promise<void> {
    let handle: string | null = null;
    try {
      const base = vscode.Uri.parse(
        `${vscode.env.uriScheme}://${EXTENSION_ID}${FOCUS_PATH}`,
      );
      const external = await vscode.env.asExternalUri(base);
      const asString = external.toString();
      handle = asString.length > 0 ? asString : null;
    } catch (err) {
      logError('windows.asExternalUri', err);
    }
    if (handle === null) {
      log(
        'windows: no focus handle available in this host —',
        'cross-window focus will degrade to a message',
      );
      return;
    }

    const rec: WindowRecord = {
      windowId: this.windowId,
      focusHandle: { uri: handle },
      folder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      pid: process.pid,
      publishedAt: new Date().toISOString(),
    };
    try {
      await this.deps.publishWindow(rec);
      log('windows: published focus handle for', this.windowId, handle);
    } catch (err) {
      logError('windows.publishWindow', err);
    }
  }

  async focusWindow(rec: WindowRecord, sessionId?: string): Promise<boolean> {
    const handle = rec?.focusHandle?.uri;
    if (typeof handle !== 'string' || handle.length === 0) {
      log('windows.focusWindow: window record has no focus handle');
      return false;
    }

    const wanted = isSessionId(sessionId) ? sessionId : null;

    // Same window: route straight through. No external round trip, no OS
    // permission prompt, and the app is already frontmost (the user just
    // clicked in it).
    if (rec.windowId === this.windowId) {
      this.routeFocus(wanted);
      return true;
    }

    try {
      const target = wanted ? withSessionQuery(handle, wanted) : handle;
      vscode.window.setStatusBarMessage(
        'Lineage: handing focus to another window…',
        3000,
      );
      const ok = await vscode.env.openExternal(vscode.Uri.parse(target));
      if (!ok) this.hintPermission();
      return ok;
    } catch (err) {
      logError('windows.focusWindow', err);
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const d of this.disposables.splice(0)) {
      try {
        d.dispose();
      } catch (err) {
        logError('windows.dispose', err);
      }
    }
  }

  private handleUri(uri: vscode.Uri): void {
    try {
      const path = (uri.path ?? '').replace(/\/+$/, '').toLowerCase();
      if (path !== '' && path !== FOCUS_PATH) {
        log('windows: ignoring uri with unknown path', uri.path);
        return;
      }
      const raw = new URLSearchParams(uri.query ?? '').get(SESSION_PARAM);
      this.routeFocus(isSessionId(raw) ? raw : null);
    } catch (err) {
      logError('windows.handleUri', err);
      // The window is already raised at this point; just skip the reveal.
      this.routeFocus(null);
    }
  }

  private routeFocus(sessionId: string | null): void {
    try {
      this.deps.onFocusRequest(sessionId);
    } catch (err) {
      logError('windows.onFocusRequest', err);
    }
  }

  private hintPermission(): void {
    if (this.permissionHintShown) return;
    this.permissionHintShown = true;
    void vscode.window.showInformationMessage(
      'Lineage could not hand focus to the window that owns this session. ' +
        'The editor asks "Allow \'Lineage\' to open this URI?" the first ' +
        'time — choose Open to let Lineage raise other windows.',
    );
  }
}

/**
 * Mints a per-activation windowId, registers the UriHandler, computes this
 * window's `asExternalUri` focus handle and publishes it through
 * `deps.publishWindow`.
 *
 * Never rejects: a host that cannot produce a handle still gets a working
 * integration (inbound focus keeps working, outbound degrades to `false`).
 */
export async function registerFocusIntegration(
  deps: WindowDeps,
): Promise<FocusIntegration> {
  const integration = new FocusIntegrationImpl(randomUUID(), deps);
  integration.registerHandler();
  await integration.publish();
  return integration;
}
