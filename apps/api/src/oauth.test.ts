import { describe, expect, it } from 'vitest';
import { redirectAllowed, registrableUri } from './oauth.js';

/**
 * These two functions are the whole security boundary of the authorisation endpoint.
 *
 * An authorisation server that can be talked into redirecting somewhere it should not has
 * handed over the account: the code goes to the attacker, the attacker exchanges it, and
 * every frame is readable. So the tests here are almost all about refusing things.
 */

describe('where a code may be sent', () => {
  const registered = ['https://gemini.google.com/callback', 'http://localhost:8976/cb'];

  it('accepts exactly what was registered', () => {
    expect(redirectAllowed(registered, 'https://gemini.google.com/callback')).toBe(true);
  });

  it('refuses a different path on the same host', () => {
    // Prefix matching is the classic mistake, and this is what it costs: any open redirect
    // or user-content path on the client's domain becomes a way to steal the code.
    expect(redirectAllowed(registered, 'https://gemini.google.com/callback/evil')).toBe(false);
    expect(redirectAllowed(registered, 'https://gemini.google.com/')).toBe(false);
  });

  it('refuses a lookalike host', () => {
    expect(redirectAllowed(registered, 'https://gemini.google.com.evil.test/callback')).toBe(false);
    expect(redirectAllowed(registered, 'https://evil.test/callback')).toBe(false);
  });

  it('refuses an added query or fragment', () => {
    expect(redirectAllowed(registered, 'https://gemini.google.com/callback?x=1')).toBe(false);
    expect(redirectAllowed(registered, 'https://gemini.google.com/callback#x')).toBe(false);
  });

  it('lets a desktop client use whichever loopback port it got', () => {
    // The one place an exact match cannot be required: a local client binds an ephemeral
    // port and cannot register it in advance. Host and path still have to match.
    expect(redirectAllowed(registered, 'http://localhost:54321/cb')).toBe(true);
    expect(redirectAllowed(registered, 'http://127.0.0.1:9999/cb')).toBe(true);
  });

  it('does not let the loopback exception widen to another path or host', () => {
    expect(redirectAllowed(registered, 'http://localhost:54321/other')).toBe(false);
    expect(redirectAllowed(registered, 'http://evil.test:54321/cb')).toBe(false);
    // and not to plain http on a real host, which is the exception's whole point
    expect(redirectAllowed(['http://localhost:1/cb'], 'http://example.com:1/cb')).toBe(false);
  });

  it('refuses nonsense rather than throwing', () => {
    expect(redirectAllowed(registered, 'not a url')).toBe(false);
    expect(redirectAllowed(registered, '')).toBe(false);
    expect(redirectAllowed([], 'https://gemini.google.com/callback')).toBe(false);
  });

  it('refuses javascript: and data: even if one somehow got registered', () => {
    // Registration refuses these, so reaching here means a bad row arrived another way —
    // a migration, a future code path, a hand-edited database. That is precisely when the
    // second check pays for itself: honouring a registered `javascript:` URI would run
    // script as whoever followed the link.
    expect(redirectAllowed(['javascript:alert(1)'], 'javascript:alert(1)')).toBe(false);
    expect(redirectAllowed(['data:text/html,x'], 'data:text/html,x')).toBe(false);
    expect(registrableUri('javascript:alert(1)')).toBe(false);
    expect(registrableUri('data:text/html,x')).toBe(false);
  });
});

describe('what may be registered', () => {
  it('takes https anywhere', () => {
    expect(registrableUri('https://chat.openai.com/aip/callback')).toBe(true);
  });

  it('takes http only on loopback', () => {
    expect(registrableUri('http://localhost:1410/cb')).toBe(true);
    expect(registrableUri('http://127.0.0.1:1410/cb')).toBe(true);
    // Plain http to a real host would send the code across the network in the clear.
    expect(registrableUri('http://example.com/cb')).toBe(false);
  });

  it('refuses anything that is not a URL', () => {
    expect(registrableUri('')).toBe(false);
    expect(registrableUri('example.com/cb')).toBe(false);
  });
});

// --- the flow itself, against the real router ------------------------------------------

import { oauth } from './oauth.js';
import { hashToken } from './accounts.js';
import type { Env } from './types.js';

/**
 * A D1 stand-in that understands the handful of statements this module issues.
 *
 * Keyed on a fragment of the SQL rather than parsed, which is enough to pin the behaviour
 * that matters — registration, the PKCE check, and single use of a code — without
 * pretending to be a database.
 */
function fakeEnv() {
  const clients = new Map<string, Record<string, unknown>>();
  const codes = new Map<string, Record<string, unknown>>();
  const tokens: Record<string, unknown>[] = [];
  const sessions = new Map<string, { user_id: string; expires_at: string; revoked_at: null }>();

  const env = {
    DB: {
      prepare(sql: string) {
        const stmt = {
          args: [] as unknown[],
          bind(...a: unknown[]) { stmt.args = a; return stmt; },
          async first<T>(): Promise<T | null> {
            if (sql.includes('FROM oauth_clients')) return (clients.get(String(stmt.args[0])) ?? null) as T;
            if (sql.includes('FROM oauth_codes')) return (codes.get(String(stmt.args[0])) ?? null) as T;
            if (sql.includes('FROM auth_sessions')) return (sessions.get(String(stmt.args[0])) ?? null) as T;
            if (sql.includes('FROM users')) return { email: 'daniel@example.test' } as T;
            return null as T;
          },
          async run() {
            if (sql.includes('INSERT INTO oauth_clients')) {
              clients.set(String(stmt.args[0]), {
                client_id: stmt.args[0], client_name: stmt.args[1],
                redirect_uris: stmt.args[2], disabled_at: null,
              });
            } else if (sql.includes('INSERT INTO oauth_codes')) {
              codes.set(String(stmt.args[0]), {
                code_hash: stmt.args[0], client_id: stmt.args[1], user_id: stmt.args[2],
                redirect_uri: stmt.args[3], code_challenge: stmt.args[4],
                scope: stmt.args[5], expires_at: stmt.args[6], used_at: null,
              });
            } else if (sql.includes('UPDATE oauth_codes SET used_at')) {
              const row = codes.get(String(stmt.args[1]));
              if (row) row.used_at = stmt.args[0];
            } else if (sql.includes('INSERT INTO api_tokens')) {
              tokens.push({ token_hash: stmt.args[0], user_id: stmt.args[1], scope: stmt.args[3] });
            }
            return { success: true };
          },
          async all() { return { results: [] }; },
        };
        return stmt;
      },
    },
  } as unknown as Env;

  return { env, clients, codes, tokens, sessions };
}

const call = (env: Env, path: string, init?: RequestInit) =>
  oauth.fetch(new Request(`https://sr.test${path}`, init), env);

/** base64url SHA-256, the same thing the server computes from the verifier. */
async function challengeFor(verifier: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(d)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('discovery, which is how a hosted assistant finds its way in', () => {
  it('advertises only standard metadata fields', async () => {
    // Gemini's registration is documented to fail when a server advertises non-standard
    // extension fields here, so the absence of extras is a requirement, not an aesthetic.
    const { env } = fakeEnv();
    const meta = await (await call(env, '/.well-known/oauth-authorization-server')).json() as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual([
      'authorization_endpoint', 'code_challenge_methods_supported', 'grant_types_supported',
      'issuer', 'registration_endpoint', 'response_types_supported', 'scopes_supported',
      'token_endpoint', 'token_endpoint_auth_methods_supported',
    ]);
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
    expect(meta.issuer).toBe('https://sr.test');
  });

  it('serves the authorisation metadata under the resource path too', async () => {
    /**
     * RFC 8414 §3.1 lets a client insert the resource's path between the well-known
     * segment and the rest, and some do — they probe the suffixed form FIRST.
     *
     * The protected-resource document already had this twin; this one did not, and the
     * asymmetry is invisible from the working path. A client that reads 404 here as "no
     * authorisation server" never tries the bare path to find out otherwise, and the
     * failure surfaces to the user as an unexplained "could not connect".
     */
    const { env } = fakeEnv();
    const bare = await (await call(env, '/.well-known/oauth-authorization-server')).json();
    const suffixed = await (await call(env, '/.well-known/oauth-authorization-server/mcp')).json();
    expect(suffixed).toEqual(bare);
  });

  it('points the resource at its authorisation server', async () => {
    const { env } = fakeEnv();
    const doc = await (await call(env, '/.well-known/oauth-protected-resource')).json() as Record<string, unknown>;
    expect(doc.resource).toBe('https://sr.test/mcp');
    expect(doc.authorization_servers).toEqual(['https://sr.test']);
  });
});

describe('registration', () => {
  const register = (env: Env, body: unknown) =>
    call(env, '/oauth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

  it('issues a public client with no secret', async () => {
    const { env } = fakeEnv();
    const res = await register(env, { client_name: 'Gemini', redirect_uris: ['https://g.test/cb'] });
    expect(res.status).toBe(201);
    const client = await res.json() as Record<string, unknown>;
    expect(client.client_id).toMatch(/^sroc_/);
    expect(client.token_endpoint_auth_method).toBe('none');
    // A secret shipped to a client that cannot keep one is decoration, and offering one
    // invites a client to rely on it.
    expect('client_secret' in client).toBe(false);
  });

  it('dates the registration, because some clients require it', async () => {
    // RFC 7591 §3.2.1 makes client_id_issued_at optional and some clients treat its
    // absence as a malformed response. One field is cheaper than being that server.
    const { env } = fakeEnv();
    const res = await register(env, { client_name: 'Gemini', redirect_uris: ['https://g.test/cb'] });
    const client = await res.json() as Record<string, unknown>;
    expect(typeof client.client_id_issued_at).toBe('number');
    // Seconds since the epoch, not milliseconds — a client reading this as a date would
    // otherwise place the registration in the year 56000.
    expect(client.client_id_issued_at).toBeGreaterThan(1_700_000_000);
    expect(client.client_id_issued_at).toBeLessThan(4_000_000_000);
  });

  it('refuses a redirect it would never honour anyway', async () => {
    const { env } = fakeEnv();
    expect((await register(env, { redirect_uris: ['http://evil.test/cb'] })).status).toBe(400);
    expect((await register(env, { redirect_uris: [] })).status).toBe(400);
    expect((await register(env, {})).status).toBe(400);
  });
});

async function registeredClient() {
  const box = fakeEnv();
  const res = await call(box.env, '/oauth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Gemini', redirect_uris: ['https://g.test/cb'] }),
  });
  const { client_id } = await res.json() as { client_id: string };
  return { ...box, clientId: client_id };
}

describe('the consent screen', () => {
  const authorizeUrl = (clientId: string, challenge: string, over: Record<string, string> = {}) => {
    const p = new URLSearchParams({
      client_id: clientId, redirect_uri: 'https://g.test/cb', response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', ...over,
    });
    return `/oauth/authorize?${p}`;
  };

  it('sends a signed-out visitor to sign in, keeping every parameter', async () => {
    const { env, clientId } = await registeredClient();
    const res = await call(env, authorizeUrl(clientId, await challengeFor('v'.repeat(43))));
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get('location')!);
    expect(to.pathname).toBe('/');
    // Without this the visitor signs in, lands on the recorder, and the app that sent them
    // waits forever — the flow does not fail, it silently never finishes.
    expect(decodeURIComponent(to.searchParams.get('next')!)).toContain('code_challenge=');
  });

  it('carries an unknown parameter through to the form it will post back', async () => {
    /**
     * `resource` (RFC 8707) is what the MCP specification asks clients to send, and this
     * server acts on none of it — it issues exactly one kind of token. Acting on it is not
     * the requirement; RETURNING it is. A consent step that silently drops a parameter
     * looks to the client like a server that changed its mind about what was requested.
     */
    const box = await registeredClient();
    box.sessions.set(
      await hashToken('session-cookie-value'),
      { user_id: 'u1', expires_at: new Date(Date.now() + 86_400_000).toISOString(), revoked_at: null },
    );
    const res = await call(
      box.env,
      authorizeUrl(box.clientId, await challengeFor('v'.repeat(43)), {
        resource: 'https://sr.test/mcp',
      }),
      { headers: { cookie: 'sr_session=session-cookie-value' } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="resource"');
    expect(html).toContain('https://sr.test/mcp');
  });

  it('will not redirect anywhere the client did not register', async () => {
    const { env, clientId } = await registeredClient();
    const res = await call(env, authorizeUrl(
      clientId, await challengeFor('v'.repeat(43)), { redirect_uri: 'https://evil.test/cb' },
    ));
    // Shown here, never bounced: bouncing to an unverified URI is the open redirect.
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Nothing was shared');
  });

  it('refuses a flow without PKCE rather than downgrading it', async () => {
    const { env, clientId } = await registeredClient();
    const res = await call(env, authorizeUrl(clientId, '', { code_challenge_method: 'plain' }));
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
  });
});

describe('the token exchange', () => {
  async function grantedCode() {
    const box = await registeredClient();
    box.sessions.set(
      // resolveSession hashes the cookie before looking it up, so the key is the hash.
      await hashToken('session-cookie-value'),
      { user_id: 'u1', expires_at: new Date(Date.now() + 86_400_000).toISOString(), revoked_at: null },
    );

    const verifier = 'v'.repeat(43);
    const res = await call(box.env, '/oauth/authorize', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: 'sr_session=session-cookie-value',
      },
      body: new URLSearchParams({
        client_id: box.clientId, redirect_uri: 'https://g.test/cb', response_type: 'code',
        code_challenge: await challengeFor(verifier), code_challenge_method: 'S256',
        state: 'xyz', decision: 'allow',
      }),
    });
    const to = new URL(res.headers.get('location')!);
    return { ...box, verifier, code: to.searchParams.get('code')!, state: to.searchParams.get('state') };
  }

  const exchange = (env: Env, fields: Record<string, string>) =>
    call(env, '/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', ...fields }),
    });

  it('returns the state it was given, so the client can match the request', async () => {
    const { code, state } = await grantedCode();
    expect(state).toBe('xyz');
    expect(code).toBeTruthy();
  });

  it('trades a code and its verifier for a read-only token', async () => {
    const { env, code, verifier, tokens } = await grantedCode();
    const res = await exchange(env, { code, code_verifier: verifier });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(String(body.access_token)).toMatch(/^srp_/);
    expect(body.scope).toBe('read');
    // Read-only regardless of what was asked for: an authorisation server that could mint
    // write access to a screen archive on behalf of a web app is not a trade worth having.
    expect(tokens[0]!.scope).toBe('read');
  });

  it('refuses the wrong verifier, which is the whole point of PKCE', async () => {
    const { env, code } = await grantedCode();
    const res = await exchange(env, { code, code_verifier: 'w'.repeat(43) });
    expect(res.status).toBe(400);
    expect((await res.json() as Record<string, unknown>).error).toBe('invalid_grant');
  });

  it('spends a code once', async () => {
    // A code that can be replayed is a code worth stealing.
    const { env, code, verifier } = await grantedCode();
    expect((await exchange(env, { code, code_verifier: verifier })).status).toBe(200);
    expect((await exchange(env, { code, code_verifier: verifier })).status).toBe(400);
  });

  it('refuses a code redirected somewhere else than it was issued for', async () => {
    const { env, code, verifier } = await grantedCode();
    const res = await exchange(env, { code, code_verifier: verifier, redirect_uri: 'https://evil.test/cb' });
    expect(res.status).toBe(400);
  });

  it('refuses an unknown code without saying whether it ever existed', async () => {
    const { env, verifier } = await grantedCode();
    const res = await exchange(env, { code: 'nope', code_verifier: verifier });
    expect(res.status).toBe(400);
    expect((await res.json() as Record<string, unknown>).error).toBe('invalid_grant');
  });
});
