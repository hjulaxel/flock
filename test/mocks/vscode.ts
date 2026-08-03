// test/mocks/vscode.ts — minimal, class-shaped stand-ins for the `vscode`
// module. vitest.config.ts aliases `vscode` here, so the vscode-facing modules
// can be unit-tested outside the extension host.
//
// Only the surface the tests actually need is modelled, and that is deliberate:
// every suite in test/ resolves `vscode` through this file, so widening it
// changes what dozens of unrelated tests are running against. Adding to it is
// fine; changing what is already here is not a local edit.
//
// Nothing here talks to a real workbench. `window` and `commands` are
// intentionally empty — tests instantiate the provider classes directly and
// never register anything with the host.

// ------------------------------------------------------------------- events

export interface Disposable {
  dispose(): void;
}

export class EventEmitter<T> {
  private listeners: Array<(e: T) => unknown> = [];

  readonly event = (listener: (e: T) => unknown): Disposable => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const i = this.listeners.indexOf(listener);
        if (i >= 0) this.listeners.splice(i, 1);
      },
    };
  };

  fire(value: T): void {
    for (const l of [...this.listeners]) l(value);
  }

  dispose(): void {
    this.listeners = [];
  }
}

// --------------------------------------------------------------------- tree

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  id?: string;
  label?: unknown;
  description?: string | boolean;
  tooltip?: unknown;
  contextValue?: string;
  resourceUri?: unknown;
  iconPath?: unknown;
  command?: unknown;
  collapsibleState?: number;

  constructor(label?: string, collapsibleState?: number) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export class ThemeIcon {
  constructor(readonly id: string, readonly color?: unknown) {}
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class MarkdownString {
  value = '';
  isTrusted = false;

  constructor(value?: string) {
    if (value !== undefined) this.value = value;
  }

  appendMarkdown(s: string): this {
    this.value += s;
    return this;
  }
}

// -------------------------------------------------------------- decorations

export class FileDecoration {
  propagate?: boolean;

  constructor(
    public badge?: string,
    public tooltip?: string,
    public color?: unknown,
  ) {}
}

// ---------------------------------------------------------------------- dnd

export class DataTransferItem {
  constructor(readonly value: unknown) {}

  asString(): Promise<string> {
    return Promise.resolve(
      typeof this.value === 'string' ? this.value : String(this.value),
    );
  }
}

export class DataTransfer {
  private items = new Map<string, DataTransferItem>();

  get(mimeType: string): DataTransferItem | undefined {
    return this.items.get(mimeType);
  }

  set(mimeType: string, value: DataTransferItem): void {
    this.items.set(mimeType, value);
  }

  forEach(
    cb: (item: DataTransferItem, mimeType: string, dt: DataTransfer) => void,
  ): void {
    this.items.forEach((item, mime) => cb(item, mime, this));
  }
}

// ---------------------------------------------------------------------- uri

interface UriParts {
  scheme: string;
  authority: string;
  path: string;
  query: string;
  fragment: string;
}

const URI_RE =
  /^([A-Za-z][A-Za-z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/;

export class Uri implements UriParts {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
  /** true when the uri was built with an explicit `//` authority section. */
  private readonly hasAuthoritySlashes: boolean;

  private constructor(p: UriParts, hasAuthoritySlashes: boolean) {
    this.scheme = p.scheme;
    this.authority = p.authority;
    this.path = p.path;
    this.query = p.query;
    this.fragment = p.fragment;
    this.hasAuthoritySlashes = hasAuthoritySlashes;
  }

  get fsPath(): string {
    return this.path;
  }

  with(change: Partial<UriParts>): Uri {
    return new Uri(
      {
        scheme: change.scheme ?? this.scheme,
        authority: change.authority ?? this.authority,
        path: change.path ?? this.path,
        query: change.query ?? this.query,
        fragment: change.fragment ?? this.fragment,
      },
      this.hasAuthoritySlashes,
    );
  }

  toString(): string {
    const auth =
      this.authority || this.hasAuthoritySlashes ? `//${this.authority}` : '';
    const q = this.query ? `?${this.query}` : '';
    const f = this.fragment ? `#${this.fragment}` : '';
    return `${this.scheme}:${auth}${this.path}${q}${f}`;
  }

  static parse(value: string): Uri {
    const m = URI_RE.exec(value);
    if (!m) {
      return new Uri(
        { scheme: '', authority: '', path: value, query: '', fragment: '' },
        false,
      );
    }
    return new Uri(
      {
        scheme: m[1] ?? '',
        authority: m[2] ?? '',
        path: m[3] ?? '',
        query: m[4] ?? '',
        fragment: m[5] ?? '',
      },
      m[2] !== undefined,
    );
  }

  static file(path: string): Uri {
    const p = path.replace(/\\/g, '/');
    return new Uri(
      {
        scheme: 'file',
        authority: '',
        path: p.startsWith('/') ? p : `/${p}`,
        query: '',
        fragment: '',
      },
      true,
    );
  }

  static from(components: {
    scheme: string;
    authority?: string;
    path?: string;
    query?: string;
    fragment?: string;
  }): Uri {
    return new Uri(
      {
        scheme: components.scheme,
        authority: components.authority ?? '',
        path: components.path ?? '',
        query: components.query ?? '',
        fragment: components.fragment ?? '',
      },
      components.authority !== undefined,
    );
  }
}

// ------------------------------------------------------------- host surface
// Deliberately empty, and useful precisely because it is. The modules that talk
// to the workbench declare the members they need as OPTIONAL and check before
// calling (see `showInformationMessage` in src/hooks.ts), so an empty namespace
// turns every prompt and every registration into a silent no-op — no fake
// workbench required, and no test can register anything real.
//
// A test that DOES need one of these hangs its own stub off the object here for
// its duration and removes it afterwards (test/hooks.test.ts and
// test/windows.test.ts both do), which keeps the stand-in next to the test that
// explains it instead of in a shared mock nothing owns.

export const window = {};
export const commands = {};
