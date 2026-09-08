import { Hono, type MiddlewareHandler } from 'hono';
import { ulid } from '@sr/schema';
import type { Env, Principal } from './types.js';
import { verifyToken as verifyDeviceToken, isAuthConfigured, AuthNotConfiguredError } from './auth.js';
import {
  API_TOKEN_PREFIX, MAX_FAILED_ATTEMPTS, SESSION_COOKIE, audit, clearFailures, clearedCookie,
  createApiToken, createEmailToken, createSession, hashToken, isLocked, isPlausibleEmail,
  normaliseEmail, rateLimit, readCookie, recordFailure, resolveApiToken, resolveSession,
  revokeAllSessions, revokeSession, sessionCookie, useEmailToken, type UserRow,
} from './accounts.js';
import { hashPassword, validatePassword, verifyPassword } from './password.js';
import { isOperator, resolvePrincipal } from './roles.js';
import { mailConfigured, mailerFor, resetPasswordMessage, verifyEmailMessage } from './mailer.js';

export type AuthCtx = {
  Bindings: Env;
  Variables: { me: Principal; scope: 'read' | 'write'; sessionHash?: string };
};

/**
 * How a request proves who it is.
 *
 * Browsers use an HttpOnly cookie, which script cannot read, so an XSS bug cannot steal a
 * login the way it could steal a token from localStorage. Non-browser clients — MCP,
 * scripts — send `Authorization: Bearer srp_…`, because they cannot hold a cookie.
 *
 * The two are deliberately separate credentials with separate lifecycles: revoking an
 * assistant's token must not sign you out of the browser, and signing out of a browser
 * must not break an assistant you meant to keep.
 */
export type AuthKind = 'cookie' | 'api_token';

export interface Authenticated {
  principal: Principal;
  scope: 'read' | 'write';
  kind: AuthKind;
  sessionHash?: string;
}

export async function authenticate(env: Env, req: Request): Promise<Authenticated | null> {
  const header = req.headers.get('Authorization');
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token.startsWith(API_TOKEN_PREFIX)) {
      const resolved = await resolveApiToken(env, token);
      if (!resolved) return null;
      return {
        principal: { userId: resolved.userId, deviceId: 'api-token' },
        scope: resolved.scope,
        kind: 'api_token',
      };
    }
    return null; // legacy device tokens no longer grant access; see /v1/account/claim
  }

  const cookie = readCookie(req.headers.get('Cookie') ?? undefined, SESSION_COOKIE);
  if (!cookie) return null;
  const session = await resolveSession(env, cookie);
  if (!session) return null;
  return {
    principal: { userId: session.userId, deviceId: 'browser' },
    scope: 'write',
    kind: 'cookie',
    sessionHash: session.tokenHash,
  };
}

/**
 * CSRF: a cookie-authenticated state change must come from our own origin.
 *
 * `SameSite=Strict` already stops a cross-site request from carrying the cookie, so this is
 * the second layer rather than the only one — browsers that mishandle SameSite, and any
 * future relaxation of it, are what this catches. A missing Origin on a state-changing
 * request is rejected rather than trusted; browsers always send it for those.
 *
 * API-token clients are exempt: they have no ambient credential to abuse, which is what
 * CSRF is.
 */
export function csrfOk(req: Request, kind: AuthKind): boolean {
  if (kind === 'api_token') return true;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  const origin = req.headers.get('Origin');
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(req.url).origin;
  } catch {
    return false;
  }
}

/**
 * Whether a request only reads, for the purpose of read-scoped API tokens.
 *
 * The HTTP method is the rule everywhere except `/mcp`, which is JSON-RPC: every call is a
 * POST, including `tools/list` and every one of the five read tools. Judging it by method
 * alone would make a read token useless for MCP — which is precisely what read tokens are
 * for, since handing an assistant a credential that cannot delete your recordings is the
 * entire point of having scopes.
 *
 * This is a deliberate, narrow exception. **Adding a tool to the MCP server that writes
 * anything means this exemption has to be replaced by a per-tool check**, or a read token
 * would silently gain write access.
 */
export function isReadOnly(method: string, pathname: string): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return true;
  return pathname === '/mcp';
}

export const requireAuth: MiddlewareHandler<AuthCtx> = async (c, next) => {
  if (!isAuthConfigured(c.env)) throw new AuthNotConfiguredError();

  const auth = await authenticate(c.env, c.req.raw);
  if (!auth) return c.json({ error: 'unauthorized' }, 401);
  if (!csrfOk(c.req.raw, auth.kind)) {
    return c.json({ error: 'csrf_check_failed', detail: 'Missing or foreign Origin header.' }, 403);
  }
  if (auth.scope === 'read' && !isReadOnly(c.req.method, new URL(c.req.url).pathname)) {
    return c.json({ error: 'insufficient_scope', detail: 'This token is read-only.' }, 403);
  }
  c.set('me', auth.principal);
  c.set('scope', auth.scope);
  if (auth.sessionHash) c.set('sessionHash', auth.sessionHash);
  await next();
  return undefined;
};

const isSecure = (c: { req: { url: string } }): boolean => new URL(c.req.url).protocol === 'https:';

/**
 * Same answer whether or not the account exists.
 *
 * Signup and password-reset both otherwise leak which addresses are registered, which for
 * a service holding screen recordings is a meaningful disclosure on its own — knowing
 * someone uses it is knowledge worth having.
 */
const NEUTRAL_RESET = {
  ok: true,
  message: 'If that address has an account, a reset link is on its way.',
};

const app = new Hono<AuthCtx>();

// --- signup ------------------------------------------------------------------------

app.post('/v1/auth/signup', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const limit = await rateLimit(c.env, `signup:${ip}`, 5, 60 * 60_000);
  if (!limit.allowed) {
    await audit(c.env, c.req.raw, 'rate_limited', {}, 'signup');
    return c.json({ error: 'rate_limited', retry_after_sec: limit.retryAfterSec }, 429);
  }

  const body = await c.req.json<{ email?: string; password?: string }>();
  const email = normaliseEmail(String(body.email ?? ''));
  const password = String(body.password ?? '');

  if (!isPlausibleEmail(email)) return c.json({ error: 'invalid_email' }, 400);
  const problems = validatePassword(password, email);
  if (problems.length) return c.json({ error: 'weak_password', problems }, 400);

  const existing = await c.env.DB.prepare(`SELECT user_id FROM users WHERE email = ?`)
    .bind(email).first<{ user_id: string }>();
  if (existing) {
    // Same shape and status as success. Telling the caller "already registered" here would
    // turn signup into an account-existence oracle.
    await audit(c.env, c.req.raw, 'signup', { email }, 'duplicate address');
    return c.json({ ok: true, verification_required: true, email_configured: mailConfigured(c.env) });
  }

  const userId = ulid();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO users (user_id, email, password_hash, created_at, updated_at)
     VALUES (?,?,?,?,?)`,
  ).bind(userId, email, await hashPassword(password), now, now).run();

  const token = await createEmailToken(c.env, userId, 'verify_email');
  const link = `${new URL(c.req.url).origin}/verify?token=${token}`;
  const result = await mailerFor(c.env).send(verifyEmailMessage(email, link), link);

  await audit(c.env, c.req.raw, 'signup', { userId, email });

  const session = await createSession(c.env, c.req.raw, userId);
  c.header('Set-Cookie', sessionCookie(session.token, isSecure(c)));
  return c.json({
    ok: true,
    user: { user_id: userId, email, email_verified: false },
    email_configured: result.delivered,
    // Only present when no provider is configured, so a developer can finish the flow.
    verify_link: result.delivered ? undefined : link,
  });
});

// --- login -------------------------------------------------------------------------

app.post('/v1/auth/login', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const body = await c.req.json<{ email?: string; password?: string }>();
  const email = normaliseEmail(String(body.email ?? ''));
  const password = String(body.password ?? '');

  // Two buckets: per-address stops a targeted guess even from a botnet, per-IP stops one
  // host spraying many addresses. Either alone leaves an obvious hole.
  const byIp = await rateLimit(c.env, `login-ip:${ip}`, 20, 15 * 60_000);
  const byEmail = await rateLimit(c.env, `login-email:${email}`, 10, 15 * 60_000);
  if (!byIp.allowed || !byEmail.allowed) {
    await audit(c.env, c.req.raw, 'rate_limited', { email }, 'login');
    return c.json({
      error: 'rate_limited',
      retry_after_sec: Math.max(byIp.retryAfterSec, byEmail.retryAfterSec),
    }, 429);
  }

  const user = await c.env.DB.prepare(`SELECT * FROM users WHERE email = ?`)
    .bind(email).first<UserRow>();

  if (!user || user.disabled_at) {
    // Still spend the KDF time, so a missing account is not detectably faster than a wrong
    // password. Without this, response timing enumerates the user table.
    await hashPassword(password);
    await audit(c.env, c.req.raw, 'login_fail', { email }, 'no such account');
    return c.json({ error: 'invalid_credentials' }, 401);
  }

  if (isLocked(user)) {
    await audit(c.env, c.req.raw, 'login_locked', { userId: user.user_id, email });
    return c.json({
      error: 'account_locked',
      detail: 'Too many failed attempts. Try again shortly, or reset your password.',
    }, 429);
  }

  const { valid, needsRehash } = await verifyPassword(password, user.password_hash);
  if (!valid) {
    const locked = await recordFailure(c.env, user);
    await audit(c.env, c.req.raw, 'login_fail', { userId: user.user_id, email },
      locked ? `locked after ${MAX_FAILED_ATTEMPTS} attempts` : undefined);
    return c.json({ error: 'invalid_credentials' }, 401);
  }

  // Raising the work factor should not require anyone to reset their password.
  if (needsRehash) {
    await c.env.DB.prepare(`UPDATE users SET password_hash = ?, updated_at = ? WHERE user_id = ?`)
      .bind(await hashPassword(password), new Date().toISOString(), user.user_id).run();
  }
  await clearFailures(c.env, user.user_id);

  const session = await createSession(c.env, c.req.raw, user.user_id);
  await audit(c.env, c.req.raw, 'login_ok', { userId: user.user_id, email });
  c.header('Set-Cookie', sessionCookie(session.token, isSecure(c)));
  return c.json({
    ok: true,
    user: { user_id: user.user_id, email: user.email, email_verified: Boolean(user.email_verified_at) },
  });
});

// --- session -----------------------------------------------------------------------

app.post('/v1/auth/logout', requireAuth, async (c) => {
  const hash = c.get('sessionHash');
  if (hash) await revokeSession(c.env, hash);
  await audit(c.env, c.req.raw, 'logout', { userId: c.get('me').userId });
  c.header('Set-Cookie', clearedCookie(isSecure(c)));
  return c.json({ ok: true });
});

app.get('/v1/auth/me', requireAuth, async (c) => {
  const user = await c.env.DB.prepare(
    `SELECT user_id, email, email_verified_at, created_at FROM users WHERE user_id = ?`,
  ).bind(c.get('me').userId).first<{
    user_id: string; email: string; email_verified_at: string | null; created_at: string;
  }>();
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  // The client uses this only to decide what to draw; every operator route re-establishes
  // it independently, so a client that lies to itself about it gains nothing but an empty
  // page. The permissions come along so the interface can hide controls that would be
  // refused, rather than offering them and reporting a 403.
  const op = await resolvePrincipal(c.env, user.user_id);
  return c.json({
    is_admin: op !== null && isOperator(op),
    role: op?.role ?? 'user',
    permissions: op?.permissions ?? null,
    user: {
      user_id: user.user_id,
      email: user.email,
      email_verified: Boolean(user.email_verified_at),
      created_at: user.created_at,
    },
    scope: c.get('scope'),
    email_configured: mailConfigured(c.env),
  });
});

// --- email verification ------------------------------------------------------------

app.post('/v1/auth/verify', async (c) => {
  const { token } = await c.req.json<{ token?: string }>();
  if (!token) return c.json({ error: 'missing_token' }, 400);

  const userId = await useEmailToken(c.env, token, 'verify_email');
  if (!userId) return c.json({ error: 'invalid_or_expired_token' }, 400);

  await c.env.DB.prepare(`UPDATE users SET email_verified_at = ?, updated_at = ? WHERE user_id = ?`)
    .bind(new Date().toISOString(), new Date().toISOString(), userId).run();
  await audit(c.env, c.req.raw, 'email_verified', { userId });
  return c.json({ ok: true });
});

app.post('/v1/auth/verify/resend', requireAuth, async (c) => {
  const userId = c.get('me').userId;
  const limit = await rateLimit(c.env, `verify:${userId}`, 3, 60 * 60_000);
  if (!limit.allowed) return c.json({ error: 'rate_limited', retry_after_sec: limit.retryAfterSec }, 429);

  const user = await c.env.DB.prepare(`SELECT email, email_verified_at FROM users WHERE user_id = ?`)
    .bind(userId).first<{ email: string; email_verified_at: string | null }>();
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  if (user.email_verified_at) return c.json({ ok: true, already_verified: true });

  const token = await createEmailToken(c.env, userId, 'verify_email');
  const link = `${new URL(c.req.url).origin}/verify?token=${token}`;
  const result = await mailerFor(c.env).send(verifyEmailMessage(user.email, link), link);
  return c.json({ ok: true, email_configured: result.delivered, verify_link: result.delivered ? undefined : link });
});

// --- password reset ----------------------------------------------------------------

app.post('/v1/auth/reset/request', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const limit = await rateLimit(c.env, `reset:${ip}`, 5, 60 * 60_000);
  if (!limit.allowed) return c.json({ error: 'rate_limited', retry_after_sec: limit.retryAfterSec }, 429);

  const { email: raw } = await c.req.json<{ email?: string }>();
  const email = normaliseEmail(String(raw ?? ''));
  const user = await c.env.DB.prepare(`SELECT user_id FROM users WHERE email = ?`)
    .bind(email).first<{ user_id: string }>();

  await audit(c.env, c.req.raw, 'reset_requested', { userId: user?.user_id ?? null, email });
  if (!user) return c.json(NEUTRAL_RESET);

  const token = await createEmailToken(c.env, user.user_id, 'reset_password');
  const link = `${new URL(c.req.url).origin}/reset?token=${token}`;
  const result = await mailerFor(c.env).send(resetPasswordMessage(email, link), link);
  return c.json({
    ...NEUTRAL_RESET,
    email_configured: result.delivered,
    reset_link: result.delivered ? undefined : link,
  });
});

app.post('/v1/auth/reset/confirm', async (c) => {
  const { token, password } = await c.req.json<{ token?: string; password?: string }>();
  if (!token || !password) return c.json({ error: 'missing_fields' }, 400);

  const problems = validatePassword(password);
  if (problems.length) return c.json({ error: 'weak_password', problems }, 400);

  const userId = await useEmailToken(c.env, token, 'reset_password');
  if (!userId) return c.json({ error: 'invalid_or_expired_token' }, 400);

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE users SET password_hash = ?, updated_at = ?, failed_attempts = 0, locked_until = NULL
     WHERE user_id = ?`,
  ).bind(await hashPassword(password), now, userId).run();

  // Whoever forced the reset may already hold a session. Ending all of them is the point
  // of a reset, not a side effect of it.
  const revoked = await revokeAllSessions(c.env, userId);
  await audit(c.env, c.req.raw, 'reset_completed', { userId }, `${revoked} session(s) revoked`);
  return c.json({ ok: true, sessions_revoked: revoked });
});

app.post('/v1/auth/password', requireAuth, async (c) => {
  const userId = c.get('me').userId;
  const { current_password: current, new_password: next } =
    await c.req.json<{ current_password?: string; new_password?: string }>();
  if (!current || !next) return c.json({ error: 'missing_fields' }, 400);

  const user = await c.env.DB.prepare(`SELECT * FROM users WHERE user_id = ?`)
    .bind(userId).first<UserRow>();
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  const { valid } = await verifyPassword(current, user.password_hash);
  if (!valid) {
    await audit(c.env, c.req.raw, 'login_fail', { userId }, 'wrong current password on change');
    return c.json({ error: 'invalid_credentials' }, 401);
  }

  const problems = validatePassword(next, user.email);
  if (problems.length) return c.json({ error: 'weak_password', problems }, 400);

  await c.env.DB.prepare(`UPDATE users SET password_hash = ?, updated_at = ? WHERE user_id = ?`)
    .bind(await hashPassword(next), new Date().toISOString(), userId).run();

  // Keep the session doing the changing; end every other one.
  const revoked = await revokeAllSessions(c.env, userId, c.get('sessionHash'));
  await audit(c.env, c.req.raw, 'password_changed', { userId }, `${revoked} other session(s) revoked`);
  return c.json({ ok: true, other_sessions_revoked: revoked });
});

// --- sessions and API tokens --------------------------------------------------------

app.get('/v1/auth/sessions', requireAuth, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT token_hash, created_at, last_seen_at, expires_at, ip, user_agent
     FROM auth_sessions
     WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
     ORDER BY last_seen_at DESC LIMIT 50`,
  ).bind(c.get('me').userId, new Date().toISOString()).all<Record<string, string>>();

  const mine = c.get('sessionHash');
  return c.json({
    sessions: results.map((r) => ({
      // The hash identifies the row for revocation without being a usable credential.
      id: r.token_hash,
      current: r.token_hash === mine,
      created_at: r.created_at,
      last_seen_at: r.last_seen_at,
      expires_at: r.expires_at,
      ip: r.ip,
      user_agent: r.user_agent,
    })),
  });
});

app.delete('/v1/auth/sessions/:id', requireAuth, async (c) => {
  const id = c.req.param('id');
  const { meta } = await c.env.DB.prepare(
    `UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND user_id = ?`,
  ).bind(new Date().toISOString(), id, c.get('me').userId).run();
  await audit(c.env, c.req.raw, 'session_revoked', { userId: c.get('me').userId });
  if (id === c.get('sessionHash')) c.header('Set-Cookie', clearedCookie(isSecure(c)));
  return c.json({ ok: true, revoked: meta?.changes ?? 0 });
});

app.get('/v1/auth/tokens', requireAuth, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT token_hash, name, scope, created_at, last_used_at, expires_at
     FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
  ).bind(c.get('me').userId).all<Record<string, string>>();
  return c.json({
    tokens: results.map((r) => ({
      id: r.token_hash, name: r.name, scope: r.scope,
      created_at: r.created_at, last_used_at: r.last_used_at, expires_at: r.expires_at,
    })),
  });
});

app.post('/v1/auth/tokens', requireAuth, async (c) => {
  // An API token is a credential; minting one from another API token would let a leaked
  // read token bootstrap a permanent write token. Only a browser session may create them.
  if (c.get('scope') !== 'write' || c.get('me').deviceId === 'api-token') {
    return c.json({ error: 'forbidden', detail: 'Sign in to create an API token.' }, 403);
  }
  const body = await c.req.json<{ name?: string; scope?: string; expires_in_days?: number }>();
  const name = (body.name ?? '').trim() || 'Unnamed token';
  const scope = body.scope === 'write' ? 'write' : 'read';
  const days = Number(body.expires_in_days ?? 0);
  const expiresAt = days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null;

  const { token, tokenHash } = await createApiToken(c.env, c.get('me').userId, name, scope, expiresAt);
  await audit(c.env, c.req.raw, 'token_created', { userId: c.get('me').userId }, `${name} (${scope})`);
  // Returned exactly once. It is stored only as a hash, so it cannot be shown again.
  return c.json({ ok: true, id: tokenHash, name, scope, expires_at: expiresAt, token });
});

app.delete('/v1/auth/tokens/:id', requireAuth, async (c) => {
  const { meta } = await c.env.DB.prepare(
    `UPDATE api_tokens SET revoked_at = ? WHERE token_hash = ? AND user_id = ?`,
  ).bind(new Date().toISOString(), c.req.param('id'), c.get('me').userId).run();
  await audit(c.env, c.req.raw, 'token_revoked', { userId: c.get('me').userId });
  return c.json({ ok: true, revoked: meta?.changes ?? 0 });
});

app.get('/v1/auth/events', requireAuth, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT at, event, ip, user_agent, detail FROM auth_events
     WHERE user_id = ? ORDER BY at DESC LIMIT 100`,
  ).bind(c.get('me').userId).all();
  return c.json({ events: results });
});

// --- claiming anonymous history ------------------------------------------------------

/**
 * Move recordings made before accounts existed into the account now signed in.
 *
 * Proof of ownership is the device token itself: it is HMAC-signed by this Worker and the
 * browser that made the recordings is the only place it exists. Verifying the signature is
 * the same check that used to authorise reading those frames, so this grants nothing that
 * holder could not already do — it just moves the rows somewhere revocable.
 */
app.post('/v1/account/claim', requireAuth, async (c) => {
  const { device_token: deviceToken } = await c.req.json<{ device_token?: string }>();
  if (!deviceToken) return c.json({ error: 'missing_device_token' }, 400);

  const legacy = await verifyDeviceToken(c.env, deviceToken);
  if (!legacy) return c.json({ error: 'invalid_device_token' }, 400);

  const userId = c.get('me').userId;
  if (legacy.userId === userId) return c.json({ ok: true, sessions: 0, frames: 0 });

  // Refuse to move rows that already belong to a real account.
  const owned = await c.env.DB.prepare(`SELECT user_id FROM users WHERE user_id = ?`)
    .bind(legacy.userId).first<{ user_id: string }>();
  if (owned) return c.json({ error: 'already_claimed' }, 409);

  const frames = await c.env.DB.prepare(
    `UPDATE frames SET user_id = ? WHERE user_id = ?`,
  ).bind(userId, legacy.userId).run();
  const sessions = await c.env.DB.prepare(
    `UPDATE sessions SET user_id = ? WHERE user_id = ?`,
  ).bind(userId, legacy.userId).run();
  await c.env.DB.prepare(`UPDATE devices SET user_id = ? WHERE user_id = ?`)
    .bind(userId, legacy.userId).run();

  const moved = { frames: frames.meta?.changes ?? 0, sessions: sessions.meta?.changes ?? 0 };
  await audit(c.env, c.req.raw, 'history_claimed', { userId },
    `${moved.frames} frames, ${moved.sessions} sessions from ${legacy.userId}`);
  return c.json({ ok: true, ...moved });
});

/** Erase the account itself. Frames and objects are removed by the caller first. */
app.delete('/v1/account', requireAuth, async (c) => {
  const userId = c.get('me').userId;
  await audit(c.env, c.req.raw, 'account_deleted', { userId });
  // ON DELETE CASCADE clears sessions, tokens and links with it.
  await c.env.DB.prepare(`DELETE FROM users WHERE user_id = ?`).bind(userId).run();
  c.header('Set-Cookie', clearedCookie(isSecure(c)));
  return c.json({ ok: true });
});

export const authRoutes = app;
export { hashToken };
