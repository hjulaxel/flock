// src/surfaces.ts — visual surfaces: browser tabs, markdown preview, project
// open, and our own HTML in a webview.
//
// Browser rules (measured, not guessed):
//   * `simpleBrowser.show` exists in BOTH VS Code and Cursor, and on VS Code
//     1.109+ it silently forwards to the Integrated Browser (a real Chromium
//     WebContentsView, so X-Frame-Options / frame-ancestors do not apply).
//     It is the always-available path.
//   * `workbench.action.browser.*` is ABSENT from Cursor 3.12.30 — never a
//     hard dependency. We probe `commands.getCommands(true)` and only prefer
//     `workbench.action.browser.open` when it is actually registered, because
//     its `reuseUrlFilter` glob turns "open" into an idempotent operation
//     (matching tab navigates instead of duplicating).
//   * Last resort: the system browser via `env.openExternal`.
//
// Webview rules: our own HTML only, served through `asWebviewUri` — no local
// server. A webview that must reach a local port uses plain fetch to
// 127.0.0.1 with `connect-src` in the CSP and SSE for streaming; WebSocket is
// never remapped and breaks under Remote, so ws:/wss: origins are rejected.
//
// Never `workspace.updateWorkspaceFolders` (it terminates and restarts the
// extension host on the single-folder -> multi-root transition) and never
// `vscode.openFolder` as a window-raising trick (that is windows.ts's job).

import * as vscode from 'vscode';

import { log, logError } from './log';

const BROWSER_OPEN_COMMAND = 'workbench.action.browser.open';
const SIMPLE_BROWSER_COMMAND = 'simpleBrowser.show';
const MARKDOWN_PREVIEW_COMMAND = 'markdown.showPreview';
const OPEN_FOLDER_COMMAND = 'vscode.openFolder';

// ---------------------------------------------------------------- browser

export interface OpenBrowserOptions {
  /** Open beside the active editor instead of in it. Integrated Browser only. */
  openToSide?: boolean;
  /** Glob matched against already-open browser tabs; a hit navigates that tab
   *  instead of opening a duplicate. Integrated Browser only.
   *  Defaults to the exact url, i.e. re-opening the same page is idempotent. */
  reuseUrlFilter?: string;
}

/** Cached capability probe. Command registration is static per product, so a
 *  single probe per extension host is enough. */
let integratedBrowserProbe: Promise<boolean> | null = null;

async function hasIntegratedBrowser(): Promise<boolean> {
  if (integratedBrowserProbe === null) {
    integratedBrowserProbe = (async (): Promise<boolean> => {
      try {
        const all = await vscode.commands.getCommands(true);
        return Array.isArray(all) && all.includes(BROWSER_OPEN_COMMAND);
      } catch (err) {
        logError('surfaces.probeCommands', err);
        return false;
      }
    })();
  }
  return integratedBrowserProbe;
}

/** Parse loosely: accept a bare host ("example.com") by assuming https. */
function parseHttpUrl(raw: string): vscode.Uri | null {
  const attempts = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)
    ? [raw]
    : [`https://${raw}`];
  for (const candidate of attempts) {
    try {
      return vscode.Uri.parse(candidate, true);
    } catch {
      // fall through
    }
  }
  return null;
}

/**
 * Open a URL in an editor tab. Never rejects; degrades
 * Integrated Browser -> Simple Browser -> system browser -> warning toast.
 */
export async function openBrowser(
  url: string,
  opts?: OpenBrowserOptions,
): Promise<void> {
  const raw = typeof url === 'string' ? url.trim() : '';
  if (raw.length === 0) {
    log('surfaces.openBrowser: empty url ignored');
    return;
  }

  const uri = parseHttpUrl(raw);
  if (uri === null) {
    log('surfaces.openBrowser: unparseable url', raw);
    void vscode.window.showWarningMessage(`Flock: not a valid URL — ${raw}`);
    return;
  }

  const scheme = uri.scheme.toLowerCase();
  const target = uri.toString();

  // Browser panes only render http(s); anything else belongs to the OS.
  if (scheme !== 'http' && scheme !== 'https') {
    await openExternally(uri);
    return;
  }

  if (await hasIntegratedBrowser()) {
    try {
      await vscode.commands.executeCommand(BROWSER_OPEN_COMMAND, {
        url: target,
        openToSide: opts?.openToSide ?? false,
        reuseUrlFilter: opts?.reuseUrlFilter ?? target,
      });
      return;
    } catch (err) {
      // Present but unhappy (signature drift) — fall through to the portable
      // command rather than giving up.
      logError('surfaces.browser.open', err);
    }
  }

  try {
    await vscode.commands.executeCommand(SIMPLE_BROWSER_COMMAND, target);
    return;
  } catch (err) {
    logError('surfaces.simpleBrowser.show', err);
  }

  if (await openExternally(uri)) return;
  void vscode.window.showWarningMessage(
    `Flock could not open ${target} in a browser pane.`,
  );
}

async function openExternally(uri: vscode.Uri): Promise<boolean> {
  try {
    return await vscode.env.openExternal(uri);
  } catch (err) {
    logError('surfaces.openExternal', err);
    return false;
  }
}

// --------------------------------------------------------------- markdown

/**
 * The editor's own markdown preview: rendered markdown in a tab, reloading
 * live as the file changes, for free. Falls back to a plain text editor.
 */
export async function openMarkdownPreview(fsPath: string): Promise<void> {
  const p = typeof fsPath === 'string' ? fsPath.trim() : '';
  if (p.length === 0) {
    log('surfaces.openMarkdownPreview: empty path ignored');
    return;
  }
  const uri = vscode.Uri.file(p);

  try {
    await vscode.commands.executeCommand(MARKDOWN_PREVIEW_COMMAND, uri);
    return;
  } catch (err) {
    logError('surfaces.markdown.showPreview', err);
  }

  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
  } catch (err) {
    logError('surfaces.openMarkdownPreview.fallback', err);
    void vscode.window.showWarningMessage(`Flock could not open ${p}.`);
  }
}

// ---------------------------------------------------------------- project

function normalizePath(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  return trimmed.length > 0 ? trimmed : p;
}

function samePath(a: string, b: string): boolean {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  return na === nb || na.toLowerCase() === nb.toLowerCase();
}

/**
 * Open a folder as a project. Window-per-project is the model: the default
 * (and the only path any Flock command uses) is `forceNewWindow: true`.
 *
 * `newWindow: false` reuses the current window — that is a normal
 * File > Open Folder, which VS Code implements by restarting the extension
 * host; it is offered but never used for focus. Multi-root mutation via
 * `workspace.updateWorkspaceFolders` is never used at all.
 */
export async function openProject(
  fsPath: string,
  newWindow?: boolean,
): Promise<void> {
  const p = typeof fsPath === 'string' ? fsPath.trim() : '';
  if (p.length === 0) {
    log('surfaces.openProject: empty path ignored');
    return;
  }
  const uri = vscode.Uri.file(p);
  const forceNewWindow = newWindow ?? true;

  // Roster cwds can outlive the directory; a stale path would otherwise open
  // an empty window.
  try {
    await vscode.workspace.fs.stat(uri);
  } catch (err) {
    logError('surfaces.openProject.stat', err);
    void vscode.window.showWarningMessage(
      `Flock: folder no longer exists — ${p}`,
    );
    return;
  }

  if (!forceNewWindow) {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const only = folders.length === 1 ? folders[0] : undefined;
    if (only && samePath(only.uri.fsPath, p)) {
      // Already the folder of this window: re-opening would pointlessly
      // restart the extension host.
      log('surfaces.openProject: folder already open in this window', p);
      return;
    }
  }

  try {
    await vscode.commands.executeCommand(OPEN_FOLDER_COMMAND, uri, {
      forceNewWindow,
    });
  } catch (err) {
    logError('surfaces.openProject', err);
    void vscode.window.showErrorMessage(`Flock could not open ${p}.`);
  }
}

// ----------------------------------------------------------------- webview

export interface HtmlPanelOptions {
  /** Tab title. */
  title: string;
  /** Trusted HTML fragment WE generate. Never remote content. */
  body: string;
  /** Webview view type; default 'lineage.html'. */
  viewType?: string;
  viewColumn?: vscode.ViewColumn;
  preserveFocus?: boolean;
  /** Roots `asWebviewUri` may serve assets from (e.g. the extension uri). */
  localResourceRoots?: vscode.Uri[];
  /** Inline CSS, injected under the CSP nonce. */
  style?: string;
  /** Inline JS, injected under the CSP nonce. Scripts stay disabled unless
   *  this is set. */
  script?: string;
  /** Extra `connect-src` origins, e.g. 'http://127.0.0.1:8433'. Use fetch or
   *  SSE only — ws:/wss: entries are dropped because WebSocket is never
   *  remapped and breaks under Remote. Remember the server must also send
   *  Access-Control-Allow-Origin; the webview service worker injects none. */
  connectSrc?: string[];
}

const NONCE_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** 32-char CSP nonce, from Web Crypto when available. */
export function createNonce(): string {
  const bytes = new Uint8Array(32);
  const webCrypto = (
    globalThis as {
      crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array };
    }
  ).crypto;
  if (webCrypto?.getRandomValues) {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let out = '';
  for (const b of bytes) out += NONCE_ALPHABET[b % NONCE_ALPHABET.length];
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Local asset -> webview-safe uri string. The only supported way to reference
 *  our own files from webview HTML; no server, no file:// urls. */
export function assetUri(
  webview: vscode.Webview,
  resource: vscode.Uri,
): string {
  try {
    return webview.asWebviewUri(resource).toString();
  } catch (err) {
    logError('surfaces.assetUri', err);
    return '';
  }
}

/** Full HTML document with a strict, nonce-based CSP. */
export function renderHtmlDocument(
  webview: vscode.Webview,
  opts: HtmlPanelOptions,
): string {
  const nonce = createNonce();
  const cspSource = webview.cspSource;

  const connect = (opts.connectSrc ?? []).filter((origin) => {
    const ok = !/^wss?:/i.test(origin);
    if (!ok) {
      log(
        'surfaces: dropping WebSocket connect-src (never remapped under Remote;',
        'use SSE instead) —',
        origin,
      );
    }
    return ok;
  });

  const directives = [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
    `style-src ${cspSource} 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
  ];
  if (connect.length > 0) {
    directives.push(`connect-src ${connect.join(' ')}`);
  }

  const style = opts.style
    ? `<style nonce="${nonce}">${opts.style}</style>`
    : '';
  const script = opts.script
    ? `<script nonce="${nonce}">${opts.script}</script>`
    : '';

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8">',
    `<meta http-equiv="Content-Security-Policy" content="${directives.join('; ')}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<title>${escapeHtml(opts.title)}</title>`,
    style,
    '</head>',
    `<body>${opts.body}${script}</body>`,
    '</html>',
  ].join('\n');
}

/** Create a WebviewPanel rendering our own HTML. Returns null if the host
 *  refuses (never throws). */
export function openHtmlPanel(
  opts: HtmlPanelOptions,
): vscode.WebviewPanel | null {
  try {
    const panel = vscode.window.createWebviewPanel(
      opts.viewType ?? 'lineage.html',
      opts.title,
      {
        viewColumn: opts.viewColumn ?? vscode.ViewColumn.Beside,
        preserveFocus: opts.preserveFocus ?? false,
      },
      {
        enableScripts: typeof opts.script === 'string' && opts.script.length > 0,
        localResourceRoots: opts.localResourceRoots,
        retainContextWhenHidden: false,
      },
    );
    panel.webview.html = renderHtmlDocument(panel.webview, opts);
    return panel;
  } catch (err) {
    logError('surfaces.openHtmlPanel', err);
    return null;
  }
}
