// test/windows.test.ts — cross-window focus: the pure functions, plus the
// publish() RPC's timeout and retry-floor behaviour.
//
// registerFocusIntegration talks to the real workbench for registerUriHandler /
// openExternal — those stay untested — but asExternalUri is the one call
// publish() itself bounds, so it is worth reaching.

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscodeMock from 'vscode';

import { registerFocusIntegration, withSessionQuery } from '../src/windows';
import { EXTENSION_ID } from '../src/types';
import type { WindowDeps, WindowRecord } from '../src/types';

const SESSION = '0f0000a1-0000-4000-8000-0000000000a1';
// Derived from EXTENSION_ID rather than spelled out: these handles are the real
// focus URIs, and hardcoding the id here would let the extension be renamed out
// from under the tests without a single failure.
const HANDLE_NO_QUERY = `vscode://${EXTENSION_ID}/focus`;
const HANDLE_WITH_QUERY = `${HANDLE_NO_QUERY}?windowId=abc`;

function queryOf(uri: string): string {
  const i = uri.indexOf('?');
  return i < 0 ? '' : uri.slice(i + 1);
}

function beforeQuery(uri: string): string {
  const i = uri.indexOf('?');
  return i < 0 ? uri : uri.slice(0, i);
}

describe('withSessionQuery', () => {
  it('appends session without clobbering the asExternalUri query', () => {
    const out = withSessionQuery(HANDLE_WITH_QUERY, SESSION);
    expect(queryOf(out)).toBe(`windowId=abc&session=${SESSION}`);
  });

  it('creates the query when the handle has none', () => {
    const out = withSessionQuery(HANDLE_NO_QUERY, SESSION);
    expect(queryOf(out)).toBe(`session=${SESSION}`);
  });

  it('leaves scheme, authority and path untouched', () => {
    expect(beforeQuery(withSessionQuery(HANDLE_WITH_QUERY, SESSION))).toBe(
      HANDLE_NO_QUERY,
    );
    expect(beforeQuery(withSessionQuery(HANDLE_NO_QUERY, SESSION))).toBe(
      HANDLE_NO_QUERY,
    );
  });

  it('preserves every pre-existing parameter', () => {
    const out = withSessionQuery(
      `${HANDLE_NO_QUERY}?windowId=abc&x=1`,
      SESSION,
    );
    expect(queryOf(out)).toBe(`windowId=abc&x=1&session=${SESSION}`);
  });

  it('is idempotent — a stale session param is replaced, not duplicated', () => {
    const once = withSessionQuery(HANDLE_WITH_QUERY, SESSION);
    const twice = withSessionQuery(once, SESSION);
    expect(twice).toBe(once);

    const other = '0f0000a4-0000-4000-8000-0000000000a4';
    expect(queryOf(withSessionQuery(once, other))).toBe(
      `windowId=abc&session=${other}`,
    );
  });

  // REGRESSION. asExternalUri is only interesting under Remote / Codespaces /
  // tunnels, where it hands back a forwarded URL whose query carries
  // percent-escaped tokens — and `openExternal` may route that one to a
  // BROWSER, which will not undo any encoding we add. The handle is opaque to
  // us: every byte of it must survive verbatim.
  const TUNNEL =
    'https://abc123-8080.euw.devtunnels.ms/focus' +
    '?tkn=A%2FB%2Bc%3D&windowId=1';

  it('preserves a percent-encoded tunnel query byte for byte', () => {
    const out = withSessionQuery(TUNNEL, SESSION);
    expect(out).toBe(`${TUNNEL}&session=${SESSION}`);
    expect(queryOf(out)).toContain('tkn=A%2FB%2Bc%3D');
  });

  it('never re-encodes the separators it did not write', () => {
    const out = withSessionQuery(TUNNEL, SESSION);
    // A Uri.parse().with().toString() round trip escapes the SEPARATORS
    // ('=' -> %3D, '&' -> %26), which silently destroys the token for a
    // browser consumer. The token's own %3D (an encoded '=' inside the value)
    // must survive untouched, so assert on structure, not on substrings.
    expect(out.split('&')).toEqual([
      'https://abc123-8080.euw.devtunnels.ms/focus?tkn=A%2FB%2Bc%3D',
      'windowId=1',
      `session=${SESSION}`,
    ]);
    expect(out).not.toContain('%26');
  });

  it('does not double-encode an already-escaped value on repeat calls', () => {
    const once = withSessionQuery(TUNNEL, SESSION);
    expect(withSessionQuery(once, SESSION)).toBe(once);
    expect(once).not.toContain('%25'); // an encoded '%'
  });

  it('keeps a fragment behind the query', () => {
    const out = withSessionQuery(`${HANDLE_WITH_QUERY}#frag`, SESSION);
    expect(out).toBe(
      `${HANDLE_NO_QUERY}?windowId=abc&session=${SESSION}#frag`,
    );
  });

  it('handles a handle that ends in a bare question mark', () => {
    const out = withSessionQuery(`${HANDLE_NO_QUERY}?`, SESSION);
    expect(out).toBe(`${HANDLE_NO_QUERY}?session=${SESSION}`);
  });

  it('returns something usable for a handle it cannot understand', () => {
    expect(withSessionQuery('', SESSION)).toBe(`?session=${SESSION}`);
    expect(withSessionQuery('not a uri', SESSION)).toBe(
      `not a uri?session=${SESSION}`,
    );
  });
});

// --------------------------------------- publish()'s bounded asExternalUri
//
// The vscode mock (test/mocks/vscode.ts) exports neither `env` nor `workspace`
// at all — "window and commands are intentionally empty" is true one level
// further up too. Both tests below only ever exercise publish()'s FAILURE paths
// (a handle that never arrives, or never resolves at all), and on both of those
// paths `vscode.workspace.workspaceFolders` is never reached — publish() returns
// before constructing the WindowRecord that reads it — so only `env` needs a
// stand-in. It is added the same way test/hooks.test.ts hangs a stub off
// `vscode.window`: extending the mock's already-exported (empty) namespace
// object at runtime, rather than widening the shared mock.

interface EnvStub {
  uriScheme: string;
  asExternalUri: (uri: unknown) => Thenable<{ toString(): string }>;
}

function stubEnv(asExternalUri: EnvStub['asExternalUri']): void {
  (vscodeMock as unknown as { env: EnvStub }).env = {
    uriScheme: 'vscode',
    asExternalUri,
  };
}

function makeDeps(): WindowDeps & { calls: WindowRecord[] } {
  const calls: WindowRecord[] = [];
  return {
    calls,
    publishWindow: async (rec) => {
      calls.push(rec);
    },
    onFocusRequest: () => undefined,
  };
}

afterEach(() => {
  delete (vscodeMock as unknown as { env?: EnvStub }).env;
  vi.useRealTimers();
});

describe('registerFocusIntegration: publish() bounds the asExternalUri RPC', () => {
  // REGRESSION. activate() awaits registerFocusIntegration(), so an
  // asExternalUri that never answers — a dead tunnel, an unsupported remote
  // target — used to mean NOTHING after it ever ran: no tree, no webview, no
  // commands. This is the fix, isolated from the rest of activate().
  it('a never-settling asExternalUri still lets publish() resolve inside the timeout', async () => {
    vi.useFakeTimers();
    stubEnv(() => new Promise<{ toString(): string }>(() => undefined));
    const deps = makeDeps();

    const done = registerFocusIntegration(deps);
    await vi.advanceTimersByTimeAsync(5_000); // PUBLISH_TIMEOUT_MS
    await done; // must have resolved, not hung forever

    // No handle ever arrived, so nothing was published — the timeout
    // degrades exactly like a host that plainly cannot produce one.
    expect(deps.calls).toHaveLength(0);
  });

  // REGRESSION. lastPublishedAt was only ever set on SUCCESS, so a
  // host that can never produce a handle re-ran the RPC on every
  // refreshPublication() call — on the roster poll's ~3s cadence, forever.
  it('a handle-less host calls asExternalUri at most once per FAILED_PUBLISH_RETRY_MS across many refreshPublication() calls', async () => {
    vi.useFakeTimers();
    let calls = 0;
    stubEnv(() => {
      calls += 1;
      return Promise.reject(new Error('this host cannot produce a handle'));
    });
    const deps = makeDeps();

    const integration = await registerFocusIntegration(deps);
    expect(calls).toBe(1); // the initial publish() inside registerFocusIntegration

    for (let i = 0; i < 5; i++) {
      await integration.refreshPublication();
    }
    expect(calls).toBe(1); // still inside the retry floor — no re-attempt

    await vi.advanceTimersByTimeAsync(10 * 60_000); // FAILED_PUBLISH_RETRY_MS
    await integration.refreshPublication();
    expect(calls).toBe(2);
  });
});

describe('registerFocusIntegration: publish() publishes the REAL folders', () => {
  // The routing regression this guards: a converted explorer-follow window
  // published its Flock anchor as `folder`, which made windowForDir route
  // work under the window's real roots AWAY from it (nothing is "under" an
  // empty anchor). The wiring's realFolders() strips the anchor; publish()
  // must put its first entry in `folder` (old readers) and all of them in
  // `folders` (multi-root routing).
  it('folder = first real folder, folders = all of them', async () => {
    stubEnv(async () => ({ toString: () => HANDLE_WITH_QUERY }));
    const deps = {
      ...makeDeps(),
      realFolders: (): readonly string[] => ['/code/app', '/code/lib'],
    };

    await registerFocusIntegration(deps);

    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0].folder).toBe('/code/app');
    expect(deps.calls[0].folders).toEqual(['/code/app', '/code/lib']);
  });

  it('a window with no real folder publishes neither field', async () => {
    // An empty window, or a converted window whose only folder IS the anchor:
    // it hosts nothing, and publishing an anchor path would invite routing.
    stubEnv(async () => ({ toString: () => HANDLE_WITH_QUERY }));
    const deps = {
      ...makeDeps(),
      realFolders: (): readonly string[] => [],
    };

    await registerFocusIntegration(deps);

    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0].folder).toBeUndefined();
    expect(deps.calls[0].folders).toBeUndefined();
  });
});
