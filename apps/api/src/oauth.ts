import { Hono } from 'hono';
import type { Env } from './types.js';
import {
  SESSION_COOKIE, createApiToken, hashToken, newToken, rateLimit, readCookie, resolveSession,
} from './accounts.js';

/**
 * An OAuth 2.1 authorisation server, so an assistant that does not run on this machine can
 * be given read access to a screen history.
 *
 * This exists because a pasted bearer token is not an option for the hosted assistants.
 * Gemini Spark speaks OAuth and only OAuth: it fetches the metadata below, registers itself
 * dynamically, and runs a browser consent flow. claude.ai's connector UI is built the same
 * way. A client running on your own machine can be handed a header; one running in
 * somebody else's data centre cannot, and that is the case this is for.
 *
 * Three properties are worth stating because they are what make open registration safe:
 *
 * 1. **Registering a client grants nothing.** Anyone can register — the MCP specification
 *    intends that — but a client_id on its own cannot reach a single frame. Every token
 *    still requires a signed-in human to approve a consent screen.
 * 2. **Every token this issues is read-only**, regardless of what is asked for. The MCP
 *    surface is reads, and an authorisation server that could mint write access to a screen
 *    archive on behalf of a web app is not a trade worth having.
 * 3. **Tokens land in `api_tokens`.** An OAuth grant appears in Settings beside the tokens
 *    made by hand, with the same last-used column and the same revoke button.
 */

/** Codes live one minute. They are exchanged immediately or not at all. */
const CODE_TTL_MS = 60_000;
/** Tokens live 90 days, matching the default the token form offers. */
const TOKEN_TTL_DAYS = 90;

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** base64url of a SHA-256 digest, which is what `S256` means. */
async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Is this a redirect target we are willing to send a code to?
 *
 * Exact string match against what the client registered, and nothing cleverer. A prefix or
 * origin match is how open redirects happen, and an open redirect on an authorisation
 * endpoint hands the code — and therefore the account — to whoever crafted the URL.
 *
 * `http://localhost` and `http://127.0.0.1` are allowed at any port when registered,
 * because a desktop client's loopback port is not knowable in advance. Everything else
 * must be https.
 */
export function redirectAllowed(registered: string[], candidate: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  // Scheme first, and before the exact-match shortcut. Registration already refuses
  // anything but https and loopback http, so this can only fire if a bad row reached the
  // table some other way — a migration, a future code path, a hand-edited database. That
  // is exactly when a second check earns its place: honouring a registered
  // `javascript:` URI would run script as whoever followed the link.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (registered.includes(candidate)) return true;
  if (url.protocol !== 'http:') return false;
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return false;
  // A loopback URI matches a registered loopback URI with the same path, any port.
  return registered.some((r) => {
    try {
      const reg = new URL(r);
      return (reg.hostname === 'localhost' || reg.hostname === '127.0.0.1')
        && reg.pathname === url.pathname;
    } catch {
      return false;
    }
  });
}

/** A redirect URI is acceptable to register at all. */
export function registrableUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  // Loopback over http is the one exception every OAuth client for a desktop app needs.
  return url.protocol === 'http:'
    && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

export const oauth = new Hono<{ Bindings: Env }>();

/**
 * Where the resource server says its authorisation server lives (RFC 9728).
 *
 * A client that gets a 401 from /mcp reads the WWW-Authenticate header, comes here, and
 * learns where to go. This is what makes "paste the URL and press next" work at all.
 */
oauth.get('/.well-known/oauth-protected-resource', (c) => {
  const origin = new URL(c.req.url).origin;
  return json({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: ['read'],
    bearer_methods_supported: ['header'],
  });
});

// Some clients probe the path-suffixed form before the bare one.
oauth.get('/.well-known/oauth-protected-resource/mcp', (c) =>
  oauth.fetch(new Request(new URL('/.well-known/oauth-protected-resource', c.req.url)), c.env));

/**
 * Authorisation server metadata (RFC 8414).
 *
 * Deliberately plain. A documented failure of Gemini's registration is that it chokes when
 * a server advertises non-standard extension fields here, so this carries exactly the
 * registered fields and not one more.
 */
const asMetadata = (origin: string) => ({
  issuer: origin,
  authorization_endpoint: `${origin}/oauth/authorize`,
  token_endpoint: `${origin}/oauth/token`,
  registration_endpoint: `${origin}/oauth/register`,
  scopes_supported: ['read'],
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code'],
  token_endpoint_auth_methods_supported: ['none'],
  code_challenge_methods_supported: ['S256'],
});

oauth.get('/.well-known/oauth-authorization-server', (c) =>
  json(asMetadata(new URL(c.req.url).origin)));

/**
 * The same document under the resource path, because RFC 8414 §3.1 says a client may
 * insert the resource's path between the well-known segment and the rest.
 *
 * The protected-resource document already had this twin. This one did not, and the
 * asymmetry is the kind that costs an afternoon: a client that probes
 * `/.well-known/oauth-authorization-server/mcp` first and treats 404 as "no authorisation
 * server here" never reaches the bare path to find out otherwise.
 */
oauth.get('/.well-known/oauth-authorization-server/mcp', (c) =>
  json(asMetadata(new URL(c.req.url).origin)));

/**
 * Dynamic client registration (RFC 7591).
 *
 * Open, because that is what lets a hosted assistant connect without anybody creating
 * credentials by hand — and harmless, because a client_id is not access. Rate limited by
 * address so the table cannot be filled by a script.
 */
oauth.post('/oauth/register', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const limit = await rateLimit(c.env, `oauth-register:${ip}`, 20, 60 * 60_000);
  if (!limit.allowed) {
    return json({ error: 'too_many_requests' }, 429);
  }

  const body = await c.req.json().catch(() => null) as {
    client_name?: unknown; redirect_uris?: unknown;
  } | null;
  const uris = Array.isArray(body?.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === 'string')
    : [];
  if (uris.length === 0) {
    return json({
      error: 'invalid_redirect_uri',
      error_description: 'At least one redirect_uri is required.',
    }, 400);
  }
  if (!uris.every(registrableUri)) {
    return json({
      error: 'invalid_redirect_uri',
      error_description: 'Redirect URIs must be https, or http on localhost.',
    }, 400);
  }

  const clientId = `sroc_${newToken(16)}`;
  const name = typeof body?.client_name === 'string' && body.client_name.trim()
    ? body.client_name.trim().slice(0, 80)
    : 'An assistant';
  const now = new Date();
  await c.env.DB.prepare(
    `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at)
     VALUES (?,?,?,?)`,
  ).bind(clientId, name, JSON.stringify(uris), now.toISOString()).run();

  // No client_secret. This is a public client using PKCE, which is what OAuth 2.1 wants
  // and what every one of these assistants is: a secret shipped to a client that cannot
  // keep one is decoration.
  return json({
    client_id: clientId,
    // RFC 7591 §3.2.1 makes this optional, and some clients treat a registration response
    // without it as malformed. It costs one field to not be the server that fails there.
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    client_name: name,
    redirect_uris: uris,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }, 201);
});

interface ClientRow { client_id: string; client_name: string; redirect_uris: string; disabled_at: string | null }

const loadClient = (env: Env, id: string) =>
  env.DB.prepare(
    `SELECT client_id, client_name, redirect_uris, disabled_at FROM oauth_clients WHERE client_id = ?`,
  ).bind(id).first<ClientRow>();

/**
 * The consent screen.
 *
 * Rendered as plain HTML by the Worker rather than handed to the single-page app, for one
 * reason: this page must be impossible to reach in a state where it does not know who is
 * signed in. A client-side route would render, then ask, then discover — and a consent
 * screen that appears before it knows whose data it is consenting to is worse than none.
 */
oauth.get('/oauth/authorize', async (c) => {
  const url = new URL(c.req.url);
  const p = url.searchParams;
  const clientId = p.get('client_id') ?? '';
  const redirectUri = p.get('redirect_uri') ?? '';
  const state = p.get('state') ?? '';
  const challenge = p.get('code_challenge') ?? '';
  const method = p.get('code_challenge_method') ?? '';

  const client = clientId ? await loadClient(c.env, clientId) : null;
  // Errors about the CLIENT or the REDIRECT are shown here and never redirected: bouncing
  // to an unverified URI is the open redirect this is guarding against.
  if (!client || client.disabled_at) return page('Unknown application', 'This app is not registered here, or its access has been turned off.');
  const registered = JSON.parse(client.redirect_uris) as string[];
  if (!redirectAllowed(registered, redirectUri)) {
    return page('Wrong redirect address', 'This app asked to be sent somewhere it is not registered for. Nothing was shared.');
  }
  // From here errors are the client's fault in a way the client can fix, so they go back
  // to it in the form the spec defines.
  if (p.get('response_type') !== 'code') return bounce(redirectUri, state, 'unsupported_response_type');
  if (method !== 'S256' || !challenge) return bounce(redirectUri, state, 'invalid_request', 'PKCE with S256 is required.');

  const cookie = readCookie(c.req.header('Cookie'), SESSION_COOKIE);
  const session = cookie ? await resolveSession(c.env, cookie) : null;
  if (!session) {
    // Back here after signing in, with every parameter intact.
    const next = encodeURIComponent(url.pathname + url.search);
    return Response.redirect(`${url.origin}/?next=${next}`, 302);
  }

  const email = await c.env.DB.prepare(`SELECT email FROM users WHERE user_id = ?`)
    .bind(session.userId).first<{ email: string }>();

  return page(
    `Connect ${esc(client.client_name)}?`,
    '',
    // Every parameter goes back out, not just the ones read above. A client that sends
    // `resource` (RFC 8707, which the MCP specification asks of clients) must see it
    // survive the consent step; a server that silently drops unknown parameters looks to
    // that client like one that changed its mind about which resource was requested.
    // Nothing here acts on them — this server issues exactly one kind of token.
    `<form method="post" action="/oauth/authorize">
       ${[...p.entries()].map(([k, v]) =>
         `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('\n')}
       <p class="who">Signed in as <b>${esc(email?.email ?? 'this account')}</b></p>
       <p><b>${esc(client.client_name)}</b> is asking to read your screen history &mdash;
         roughly the last seven days, including the screenshots themselves.</p>
       <ul>
         <li>It can <b>read</b>: when you were recording, what the periods contained, and
           the image of any moment it asks for.</li>
         <li>It cannot record, delete, change anything, or create further access.</li>
         <li>You can revoke this at any time in Settings &rsaquo; Account &amp; security.</li>
       </ul>
       <p class="warn">Screen recordings contain whatever was on the screen. Password
         fields and areas you have blacked out are removed before storage; text secrets are
         not. Only connect an app you would show your screen to.</p>
       <div class="row">
         <button type="submit" name="decision" value="allow" class="primary">Allow</button>
         <button type="submit" name="decision" value="deny">Cancel</button>
       </div>
     </form>`,
  );
});

oauth.post('/oauth/authorize', async (c) => {
  const form = await c.req.formData();
  const get = (k: string) => String(form.get(k) ?? '');
  const clientId = get('client_id');
  const redirectUri = get('redirect_uri');
  const state = get('state');

  const client = clientId ? await loadClient(c.env, clientId) : null;
  if (!client || client.disabled_at) return page('Unknown application', 'This app is not registered here.');
  const registered = JSON.parse(client.redirect_uris) as string[];
  if (!redirectAllowed(registered, redirectUri)) {
    return page('Wrong redirect address', 'This app asked to be sent somewhere it is not registered for. Nothing was shared.');
  }

  const cookie = readCookie(c.req.header('Cookie'), SESSION_COOKIE);
  const session = cookie ? await resolveSession(c.env, cookie) : null;
  if (!session) return page('Signed out', 'Your session ended before this could finish. Sign in and try again.');

  if (get('decision') !== 'allow') return bounce(redirectUri, state, 'access_denied');

  const challenge = get('code_challenge');
  if (!challenge || get('code_challenge_method') !== 'S256') {
    return bounce(redirectUri, state, 'invalid_request', 'PKCE with S256 is required.');
  }

  const code = newToken(32);
  await c.env.DB.prepare(
    `INSERT INTO oauth_codes
       (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, expires_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(
    await hashToken(code), clientId, session.userId, redirectUri, challenge, 'read',
    new Date(Date.now() + CODE_TTL_MS).toISOString(),
  ).run();

  const back = new URL(redirectUri);
  back.searchParams.set('code', code);
  if (state) back.searchParams.set('state', state);
  return Response.redirect(back.toString(), 302);
});

/** Code plus verifier, in exchange for a read-only token. */
oauth.post('/oauth/token', async (c) => {
  const form = await c.req.formData().catch(() => null);
  if (!form) return json({ error: 'invalid_request' }, 400);
  const get = (k: string) => String(form.get(k) ?? '');

  if (get('grant_type') !== 'authorization_code') {
    return json({ error: 'unsupported_grant_type' }, 400);
  }
  const code = get('code');
  const verifier = get('code_verifier');
  if (!code || !verifier) return json({ error: 'invalid_request' }, 400);

  const row = await c.env.DB.prepare(
    `SELECT client_id, user_id, redirect_uri, code_challenge, scope, expires_at, used_at
       FROM oauth_codes WHERE code_hash = ?`,
  ).bind(await hashToken(code)).first<{
    client_id: string; user_id: string; redirect_uri: string; code_challenge: string;
    scope: string; expires_at: string; used_at: string | null;
  }>();

  // One shot. A replayed code is not merely refused: the row stays used, so a stolen code
  // is worthless even if it arrives first.
  if (!row || row.used_at || Date.parse(row.expires_at) <= Date.now()) {
    return json({ error: 'invalid_grant' }, 400);
  }
  if (get('client_id') && get('client_id') !== row.client_id) {
    return json({ error: 'invalid_grant' }, 400);
  }
  if (get('redirect_uri') && get('redirect_uri') !== row.redirect_uri) {
    return json({ error: 'invalid_grant' }, 400);
  }
  if (await s256(verifier) !== row.code_challenge) {
    return json({ error: 'invalid_grant', error_description: 'PKCE verification failed.' }, 400);
  }

  await c.env.DB.prepare(`UPDATE oauth_codes SET used_at = ? WHERE code_hash = ?`)
    .bind(new Date().toISOString(), await hashToken(code)).run();

  const client = await loadClient(c.env, row.client_id);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 86_400_000).toISOString();
  const issued = await createApiToken(
    c.env, row.user_id, client?.client_name ?? 'An assistant', 'read', expiresAt,
  );
  await c.env.DB.prepare(`UPDATE api_tokens SET client_id = ? WHERE token_hash = ?`)
    .bind(row.client_id, await hashToken(issued.token)).run();

  return json({
    access_token: issued.token,
    token_type: 'Bearer',
    expires_in: TOKEN_TTL_DAYS * 86_400,
    scope: 'read',
  });
});

/** An error the client can act on, returned the way the specification says. */
function bounce(redirectUri: string, state: string, error: string, description?: string): Response {
  const back = new URL(redirectUri);
  back.searchParams.set('error', error);
  if (description) back.searchParams.set('error_description', description);
  if (state) back.searchParams.set('state', state);
  return Response.redirect(back.toString(), 302);
}

/** A self-contained page, because the consent screen cannot depend on the app loading. */
function page(title: string, message: string, body = ''): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ScreenRegister</title>
<style>
  :root { color-scheme: dark light; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px;
    background:#0d1014; color:#e6edf5;
    font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { width:min(460px,100%); background:#151a21; border:1px solid #262f3a;
    border-radius:10px; padding:22px; }
  h1 { font-size:18px; margin:0 0 14px; }
  ul { padding-left:18px; } li { margin:4px 0; }
  .who { color:#8a99ad; font-size:13px; }
  .warn { background:#3a2c10; border:1px solid #6b5218; color:#f5d79a;
    padding:10px 12px; border-radius:8px; font-size:13px; }
  .row { display:flex; gap:8px; margin-top:18px; }
  button { font:inherit; padding:9px 16px; border-radius:10px; cursor:pointer;
    background:#1c232c; color:#e6edf5; border:1px solid #262f3a; }
  button.primary { background:#4da3ff; border-color:#4da3ff; color:#04101d; font-weight:600; }
  @media (prefers-color-scheme: light) {
    body { background:#eef1f6; color:#131a23; }
    main { background:#fff; border-color:#d5dde7; }
    .who { color:#56646f; }
    .warn { background:#fdf4e3; border-color:#e6c98a; color:#6b4400; }
    button { background:#f2f5f9; color:#131a23; border-color:#d5dde7; }
    button.primary { background:#0b62c4; border-color:#0b62c4; color:#fff; }
  }
</style></head><body><main>
<h1>${esc(title)}</h1>${message ? `<p>${esc(message)}</p>` : ''}${body}
</main></body></html>`,
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  );
}
