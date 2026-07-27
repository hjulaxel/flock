// test/windows.test.ts — owner F (SPEC.md §9).
// Pure-function coverage only: registerFocusIntegration talks to the real
// workbench (registerUriHandler / asExternalUri / openExternal) and is never
// exercised under vitest.

import { describe, expect, it } from 'vitest';

import { withSessionQuery } from '../src/windows';

const SESSION = '0f0000a1-0000-4000-8000-0000000000a1';
const HANDLE_WITH_QUERY =
  'vscode://creemux.lineage-sessions/focus?windowId=abc';
const HANDLE_NO_QUERY = 'vscode://creemux.lineage-sessions/focus';

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
      'vscode://creemux.lineage-sessions/focus',
    );
    expect(beforeQuery(withSessionQuery(HANDLE_NO_QUERY, SESSION))).toBe(
      'vscode://creemux.lineage-sessions/focus',
    );
  });

  it('preserves every pre-existing parameter', () => {
    const out = withSessionQuery(
      'vscode://creemux.lineage-sessions/focus?windowId=abc&x=1',
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

  // REGRESSION (review finding #3). asExternalUri is only interesting under
  // Remote / Codespaces / tunnels, where it hands back a forwarded URL whose
  // query carries percent-escaped tokens — and `openExternal` may route that
  // one to a BROWSER, which will not undo any encoding we add. The handle is
  // opaque (SPEC §4-F1): every byte of it must survive verbatim.
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
      `vscode://creemux.lineage-sessions/focus?windowId=abc&session=${SESSION}#frag`,
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
