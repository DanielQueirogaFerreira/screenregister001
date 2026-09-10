import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import type { Env, Principal } from './types.js';
import { AuthNotConfiguredError, isAuthConfigured } from './auth.js';
import { authRoutes, requireAuth } from './auth-routes.js';
import { healthFacts, isLocalhostOrigin, localhostAllowed } from './health.js';
import {
  isPlausibleEmail, normaliseEmail, pruneAuthTables, revokeAllSessions,
} from './accounts.js';
import { hashPassword, validatePassword, verifyPassword } from './password.js';
import { buildStatus, pruneStatusTables, recordProbes, runProbes } from './status.js';
import { handleMcp } from './mcp.js';
import { buildScenes, listFrames, resolveWindow } from './queries.js';
import { StampError, decodeStamp, ulid } from '@sr/schema';
import { HEARTBEAT_INTERVAL_MS, LIVE_WINDOW_MS, adminAudit, liveCutoff } from './admin.js';
import {
  type Permissions, type Principal as Operator, type Role,
  can, clampPermissions, isOperator, mayActOn, maySetRole, readPermissions, resolvePrincipal,
} from './roles.js';
import { OPENAPI } from './openapi.js';
import { FRAME_BATCH, deleteFramesWhere, deleteObjects, variantKeys } from './frames.js';

type Ctx = { Bindings: Env; Variables: { me: Principal; scope: 'read' | 'write'; sessionHash?: string } };

const app = new Hono<Ctx>();

/**
 * The Worker serves the client, so real traffic is same-origin and needs no CORS at all.
 * An earlier version reflected every requesting origin, which handed any website a working
 * cross-origin channel to the API — a bearer token was still required, so it was not
 * exploitable alone, but the surface had no reason to exist.
 *
 * The localhost exception exists only for running a dev client on one port against an API
 * on another, and it is off unless ALLOW_LOCALHOST_ORIGINS is "true". A developer machine
 * runs many unrelated local services; a deployed Worker should not accept cross-origin
 * calls from whatever else happens to be listening.
 */
app.use('*', cors({
  origin: (origin, c) => {
    if (!origin) return undefined;                       // same-origin or non-browser
    if (origin === new URL(c.req.url).origin) return origin;
    if (localhostAllowed(c.env) && isLocalhostOrigin(origin)) return origin;
    return undefined;                                    // everything else is denied
  },
  allowHeaders: ['Authorization', 'Content-Type'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  maxAge: 86400,
}));

/**
 * A Worker running without a signing key is misconfigured, not broken, and 503 says so.
 * Without this the failure surfaces as an unhandled exception and a 500 with no clue.
 */
app.onError((err, c) => {
  if (err instanceof AuthNotConfiguredError) {
    return c.json({ error: 'server_not_configured', detail: err.message }, 503);
  }

  /**
   * D1 refusing every query because the account is over its daily allowance is not an
   * internal error, and reporting it as one cost hours.
   *
   * Signing in surfaced "Request failed (500)", which says the server is broken. It was
   * not: the database was declining to answer, intermittently, so the same request
   * returned a correct 401 one moment and a 500 the next. That is a dependency being
   * unavailable — 503 — and the message is a platform-capability fact rather than
   * anything internal. It names no table, no query and no data.
   */
  const text = err instanceof Error ? err.message : String(err);
  if (/daily row (read|write) limit|code: 7500|exceeded .* limit/i.test(text)) {
    return c.json({
      error: 'database_over_quota',
      detail: 'The database has exceeded its daily limit, so it is refusing queries. '
        + 'This clears at midnight UTC, or immediately on a paid D1 plan.',
    }, 503);
  }
  // A body that will not parse is the caller's mistake, not the server's. Hono raises a
  // SyntaxError out of c.req.json(); left unhandled it becomes a 500 and looks like an
  // outage in the logs.
  if (err instanceof SyntaxError) {
    return c.json({ error: 'invalid_json', detail: err.message }, 400);
  }
  console.error('unhandled error', err);
  return c.json({ error: 'internal_error' }, 500);
});

/**
 * Health, for machines. A person gets sent to the dashboard instead.
 *
 * This URL has become the thing people paste into a browser when they want to know whether
 * ScreenRegister is up, and a wall of JSON is a poor answer to that question — /status
 * shows the same facts with history around them. So a browser navigation redirects there,
 * while anything that asked for JSON (the deploy gate, the client's startup check, the
 * smoke test, any uptime monitor) keeps getting exactly the body it always got.
 *
 * Two signals, either of which means a browser is navigating here:
 *
 *   Sec-Fetch-Mode: navigate   sent on a typed URL or a followed link, never on fetch/XHR
 *   Accept: text/html          what a navigation asks for, and what fetch never sends
 *
 * The first is the precise one, and the first version relied on it alone — which failed in
 * production while passing everywhere else, because the header does not reach the Worker
 * across Cloudflare's edge. The second is what a browser actually negotiates for, and it is
 * equally safe for the callers that must keep getting JSON: curl, the deploy gate, the
 * client's own startup check and any uptime monitor all send `Accept: * / *`, which does not
 * match. A wildcard is not an HTML request, so it is matched literally rather than by
 * substring.
 */
function wantsHtml(c: { req: { header(name: string): string | undefined } }): boolean {
  if (c.req.header('sec-fetch-mode') === 'navigate') return true;
  return (c.req.header('accept') ?? '')
    .split(',')
    .some((part) => part.trim().toLowerCase().startsWith('text/html'));
}

app.get('/v1/health', async (c) => {
  if (wantsHtml(c)) return c.redirect('/status', 302);
  return c.json(await healthFacts(c.env));
});

/** Machine-readable description of this API, for clients that do not speak MCP. */
app.get('/v1/openapi.json', (c) => c.json(OPENAPI(new URL(c.req.url).origin)));

/**
 * Device registration is deliberately absent.
 *
 * Anonymous device tokens used to be the whole identity model. They were unforgeable but
 * unrevocable, and anyone holding one could read the screen recordings it covered forever.
 * Accounts replace them. An existing token is still honoured for exactly one thing —
 * proving ownership of pre-account recordings at POST /v1/account/claim — and grants
 * nothing else.
 */

// Auth routes carry their own guards, so they mount before the blanket one below.
app.route('/', authRoutes);

// Everything below is scoped to the signed-in account. Every query filters on `me.userId`;
// there is no code path that reads another user's rows.
app.use('/v1/sessions/*', requireAuth);
app.use('/v1/sessions', requireAuth);
app.use('/v1/frames/*', requireAuth);
app.use('/v1/frames', requireAuth);
app.use('/v1/usage', requireAuth);
app.use('/v1/usage/history', requireAuth);
app.use('/v1/data', requireAuth);
app.use('/v1/timeline', requireAuth);
app.use('/v1/scenes', requireAuth);
app.use('/v1/admin/*', requireAuth);
app.use('/v1/status', requireAuth);

/**
 * Operator routes.
 *
 * Every one of these resolves the admin from ADMIN_EMAILS on the way in — there is no
 * middleware that sets a flag once and no role on the request context, because a
 * capability this large should be re-established at the point of use rather than carried
 * around. An unauthorised caller gets 404 rather than 403: whether this deployment has an
 * admin surface at all is not something a signed-in stranger needs confirmed.
 *
 * There is deliberately no route here that returns frame images. See admin.ts.
 */
function adminOnly(
  handler: (c: Context<Ctx>, admin: Operator) => Promise<Response>,
  /** A capability the route needs beyond simply being an operator. */
  needs?: keyof Permissions,
) {
  return async (c: Context<Ctx>): Promise<Response> => {
    // Checked here rather than assumed from the middleware. These routes were registered
    // above their own `app.use` guard once, so requireAuth never ran and `me` was
    // undefined — which threw, and produced a 500 instead of a refusal. It failed closed,
    // by accident. Access control that depends on a TypeError is not access control, and
    // it must not depend on the order of two lines in this file either.
    const me = c.get('me') as { userId?: string } | undefined;
    if (!me?.userId) return c.json({ error: 'unauthorized' }, 401);

    const admin = await resolvePrincipal(c.env, me.userId);
    if (!admin || !isOperator(admin)) return c.json({ error: 'not_found' }, 404);
    // Being an operator opens the view; a permission is what lets you act. Refused as 403
    // rather than 404, because unlike the surface itself this is not a secret from someone
    // who can already see it — telling them which flag they lack is the useful answer.
    if (needs && !can(admin, needs)) {
      return c.json({ error: 'forbidden', detail: `This account lacks ${needs}.` }, 403);
    }
    return handler(c, admin);
  };
}

/** Totals, plus everything recording right now across every account. */
app.get('/v1/admin/overview', adminOnly(async (c, admin) => {
  const [totals, live, recent] = await Promise.all([
    /**
     * Totals from `sessions`, not from `frames`.
     *
     * Every row here used to be a full scan of the frames table — three of them per
     * request — on a page that refreshes itself every half minute. At twelve thousand
     * frames that is a hundred and fifty thousand rows a minute, and D1 charges for rows
     * read: leaving this page open for half an hour exhausted the account's entire daily
     * allowance and took the next deploy's migration down with it.
     *
     * Each session already carries its own frame count and byte total, kept current by
     * the heartbeat and settled exactly when the session closes. There are a handful of
     * session rows against tens of thousands of frames, and the answer is the same one.
     */
    c.env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM users WHERE disabled_at IS NULL AND deleted_at IS NULL)
                AS users,
              (SELECT COUNT(*) FROM sessions) AS sessions,
              (SELECT COALESCE(SUM(frames_stored), 0) FROM sessions) AS frames,
              (SELECT COALESCE(SUM(bytes_stored), 0) FROM sessions) AS bytes`,
    ).first<Record<string, number>>(),

    c.env.DB.prepare(
      `SELECT s.session_id, s.user_id, u.email, s.device_id, s.started_at, s.last_seen_at,
              s.frames_stored, s.bytes_stored, s.screen_w, s.screen_h, s.stop_requested_at
         FROM sessions s JOIN users u ON u.user_id = s.user_id
        WHERE s.ended_at IS NULL AND s.last_seen_at >= ?
        ORDER BY s.started_at ASC`,
    ).bind(liveCutoff()).all(),

    c.env.DB.prepare(
      `SELECT s.session_id, s.user_id, u.email, s.device_id, s.started_at, s.ended_at,
              s.frames_stored, s.bytes_stored
         FROM sessions s JOIN users u ON u.user_id = s.user_id
        ORDER BY s.started_at DESC LIMIT 50`,
    ).all(),
  ]);

  // Reading every account's recording list is itself worth a log line.
  await adminAudit(c.env, c.req.raw, admin, 'view_overview');

  return c.json({
    totals,
    live: live.results.map((r) => ({ ...r, stop_requested: Boolean(r.stop_requested_at) })),
    recent: recent.results,
    live_window_ms: LIVE_WINDOW_MS,
  });
}));

/**
 * Everything the status dashboard renders: recorded probe history, uptime, health facts,
 * deployment log and roadmap.
 *
 * Operators only, by decision. It was public, and the argument for that was that the moment
 * a status page matters most is when authentication is the thing that is broken — a page
 * you must sign in to read cannot report that signing in is down. That trade has been made
 * knowingly: the page names deployments, commit messages, service latencies and the shape
 * of the platform's dependencies, and none of that has to be readable by everyone.
 *
 * What preserves the failure case is that /v1/health stays public and unauthenticated. It
 * needs no signing key to answer and reports schema, auth and mail configuration, so when
 * authentication itself is broken there is still something that will say so — and the
 * deploy gate, which cannot hold a session, keeps working.
 *
 * Reads only. The five-minute cron is what probes; see the note on buildStatus for why
 * probing per request was a mistake this endpoint had to be caught making.
 */
app.get('/v1/status', adminOnly(async (c) => {
  const payload = await buildStatus(c.env);
  // Half the probe interval. Nothing this endpoint reports can change in between, so a
  // client refreshing every thirty seconds costs one D1 read per cache miss instead of a
  // full probe pass. must-revalidate keeps a stale copy from being served after an outage.
  // Private now that it is behind an account: a shared cache must never hand one
  // operator's view to the next person through the same edge.
  c.header('Cache-Control', 'private, max-age=150, must-revalidate');
  return c.json(payload);
}));

/** Every account, with its role, its permissions, and what it is actually using. */
app.get('/v1/admin/users', adminOnly(async (c, admin) => {
  const { results } = await c.env.DB.prepare(
    `SELECT u.user_id, u.email, u.created_at, u.email_verified_at, u.disabled_at,
            u.deleted_at, u.locked_until, u.role,
            u.can_manage_users, u.can_grant_admin, u.can_view_frames, u.can_delete_recordings,
            COUNT(DISTINCT s.session_id) AS sessions,
            COALESCE(SUM(s.frames_stored), 0) AS frames,
            COALESCE(SUM(s.bytes_stored), 0) AS bytes,
            MAX(s.started_at) AS last_recording
       FROM users u LEFT JOIN sessions s ON s.user_id = u.user_id
      GROUP BY u.user_id ORDER BY u.created_at DESC LIMIT 500`,
  ).all<Record<string, unknown>>();
  await adminAudit(c.env, c.req.raw, admin, 'view_users');
  return c.json({
    users: results.map((r) => ({
      ...r,
      role: (r.role as string) ?? 'user',
      permissions: {
        can_manage_users: Boolean(r.can_manage_users),
        can_grant_admin: Boolean(r.can_grant_admin),
        can_view_frames: Boolean(r.can_view_frames),
        can_delete_recordings: Boolean(r.can_delete_recordings),
      },
    })),
    // So the interface can grey out what this operator would be refused, rather than
    // offering it and reporting a 403 after the fact.
    me: { user_id: admin.userId, role: admin.role, permissions: admin.permissions },
  });
}));

/** The account being acted on, and whether this operator may. */
async function loadTarget(
  env: Env, id: string,
): Promise<{ user_id: string; email: string; role: Role; deleted_at: string | null } | null> {
  const row = await env.DB.prepare(
    `SELECT user_id, email, role, deleted_at FROM users WHERE user_id = ?`,
  ).bind(id).first<{ user_id: string; email: string; role: string | null; deleted_at: string | null }>();
  return row ? { ...row, role: (row.role ?? 'user') as Role } : null;
}

/**
 * Create an account.
 *
 * The password is set here and shown once, because there is no mail provider configured and
 * an invitation nobody can deliver is not an invitation. It is returned in the response and
 * never stored in readable form — the same PBKDF2 path every signup takes.
 */
app.post('/v1/admin/users', adminOnly(async (c, admin) => {
  const body = await c.req.json<{ email?: string; password?: string; role?: Role }>()
    .catch(() => ({} as { email?: string; password?: string; role?: Role }));

  const email = normaliseEmail(String(body.email ?? ''));
  if (!isPlausibleEmail(email)) return c.json({ error: 'invalid_email' }, 400);

  const role: Role = body.role === 'admin' ? 'admin' : 'user';
  if (role === 'admin' && !can(admin, 'can_grant_admin')) {
    return c.json({ error: 'forbidden', detail: 'This account cannot grant operator access.' }, 403);
  }

  const password = String(body.password ?? '');
  const problems = validatePassword(password, email);
  if (problems.length) return c.json({ error: 'weak_password', problems }, 400);

  const existing = await c.env.DB.prepare(`SELECT user_id FROM users WHERE email = ?`)
    .bind(email).first();
  if (existing) return c.json({ error: 'email_taken' }, 409);

  const now = new Date().toISOString();
  const userId = ulid();
  await c.env.DB.prepare(
    `INSERT INTO users (user_id, email, password_hash, created_at, updated_at, role)
     VALUES (?,?,?,?,?,?)`,
  ).bind(userId, email, await hashPassword(password), now, now, role).run();

  await adminAudit(c.env, c.req.raw, admin, 'create_user', userId, `${email} as ${role}`);
  return c.json({ ok: true, user_id: userId, email, role });
}, 'can_manage_users'));

/**
 * Change an account's role, permissions, or whether it can sign in.
 *
 * Every one of those decisions lives in roles.ts and is tested there. This route's job is
 * to ask, not to decide — a permission check written inline in a handler is a permission
 * check that exists in one place and is forgotten in the next.
 */
app.patch('/v1/admin/users/:id', adminOnly(async (c, admin) => {
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'not_found' }, 404);

  const target = await loadTarget(c.env, id);
  if (!target || target.deleted_at) return c.json({ error: 'not_found' }, 404);

  const body = await c.req.json<{
    role?: Role; permissions?: unknown; disabled?: boolean;
  }>().catch(() => ({} as { role?: Role; permissions?: unknown; disabled?: boolean }));

  const gate = body.role !== undefined
    ? maySetRole(admin, target, body.role)
    : mayActOn(admin, target);
  if (!gate.ok) return c.json({ error: 'forbidden', detail: gate.reason }, 403);

  const nextRole: Role = body.role ?? target.role;
  // Clamped, so an operator can never mint one stronger than itself. A demotion to plain
  // user drops every flag with it, rather than leaving them set and dormant against a
  // later promotion.
  const perms = nextRole === 'user'
    ? readPermissions({})
    : clampPermissions(admin, readPermissions(body.permissions));

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE users
        SET role = ?, can_manage_users = ?, can_grant_admin = ?, can_view_frames = ?,
            can_delete_recordings = ?,
            disabled_at = CASE WHEN ? THEN COALESCE(disabled_at, ?) ELSE NULL END,
            updated_at = ?
      WHERE user_id = ?`,
  ).bind(
    nextRole,
    perms.can_manage_users ? 1 : 0, perms.can_grant_admin ? 1 : 0,
    perms.can_view_frames ? 1 : 0, perms.can_delete_recordings ? 1 : 0,
    body.disabled === undefined ? null : (body.disabled ? 1 : 0), now,
    now, id,
  ).run();

  // A disabled account keeps no way in. Leaving live cookies behind would mean "disabled"
  // took effect only when someone next signed in, which is not what the word means.
  if (body.disabled) await revokeAllSessions(c.env, id);

  await adminAudit(c.env, c.req.raw, admin, 'update_user', id,
    `${target.email}: role ${target.role}\u2192${nextRole}`
    + (body.disabled === undefined ? '' : `, ${body.disabled ? 'disabled' : 'enabled'}`));
  return c.json({ ok: true, role: nextRole, permissions: perms });
}, 'can_manage_users'));

/**
 * Remove an account, keeping or destroying its recordings.
 *
 * The row is kept and marked deleted rather than dropped. Frames carry a user_id, and
 * recordings can outlive the account that made them — deleting the row outright would
 * leave them owned by an identifier with no name behind it, which in an audit is worse
 * than useless. What ends is the ability to sign in: the password hash is destroyed and
 * every session revoked.
 *
 * `recordings=delete` purges everything they recorded. Removing only part of it is the
 * per-session Delete in the sessions table, which is the right shape for a choice made one
 * recording at a time.
 */
app.delete('/v1/admin/users/:id', adminOnly(async (c, admin) => {
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'not_found' }, 404);

  const target = await loadTarget(c.env, id);
  if (!target) return c.json({ error: 'not_found' }, 404);

  const gate = mayActOn(admin, target);
  if (!gate.ok) return c.json({ error: 'forbidden', detail: gate.reason }, 403);

  const dropRecordings = c.req.query('recordings') === 'delete';
  if (dropRecordings && !can(admin, 'can_delete_recordings')) {
    return c.json({
      error: 'forbidden',
      detail: 'This account cannot delete recordings. Remove the account and keep them, '
        + 'or ask someone who can.',
    }, 403);
  }

  let removed = 0;
  if (dropRecordings) {
    removed = await deleteFramesWhere(c.env, 'user_id = ?', [id]);
    await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id).run();
  }

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE users
        SET deleted_at = ?, deleted_by = ?, disabled_at = COALESCE(disabled_at, ?),
            password_hash = '', role = 'user',
            can_manage_users = 0, can_grant_admin = 0, can_view_frames = 0,
            can_delete_recordings = 0, updated_at = ?
      WHERE user_id = ?`,
  ).bind(now, admin.userId, now, now, id).run();
  await revokeAllSessions(c.env, id);

  await adminAudit(c.env, c.req.raw, admin, 'delete_user', id,
    `${target.email}, recordings ${dropRecordings ? `deleted (${removed} frames)` : 'kept'}`);
  return c.json({ ok: true, recordings: dropRecordings ? 'deleted' : 'kept', frames: removed });
}, 'can_manage_users'));

/**
 * Hand the master role to another account.
 *
 * Master-only, and it demotes the holder in the same breath as it promotes the successor.
 * That ordering is not a style choice: the database holds a unique index over the master
 * role, so promoting first would simply fail — which is the correct failure, and the reason
 * the constraint is there rather than in a comment asking everyone to be careful.
 *
 * It costs the current holder everything, so it asks for the password. The audit line names
 * both accounts, and it is the last thing this account will be able to do that the new
 * master cannot undo.
 */
app.post('/v1/admin/transfer-master', adminOnly(async (c, admin) => {
  if (admin.role !== 'master') {
    return c.json({ error: 'forbidden', detail: 'Only the master account can transfer the role.' }, 403);
  }

  const body = await c.req.json<{ user_id?: string; password?: string }>()
    .catch(() => ({} as { user_id?: string; password?: string }));
  const targetId = String(body.user_id ?? '');

  const me = await c.env.DB.prepare(`SELECT password_hash FROM users WHERE user_id = ?`)
    .bind(admin.userId).first<{ password_hash: string }>();
  if (!me || !await verifyPassword(String(body.password ?? ''), me.password_hash)) {
    await adminAudit(c.env, c.req.raw, admin, 'transfer_master_refused', targetId,
      'wrong password');
    return c.json({ error: 'invalid_credentials' }, 401);
  }

  const target = await loadTarget(c.env, targetId);
  if (!target || target.deleted_at) return c.json({ error: 'not_found' }, 404);
  if (target.user_id === admin.userId) {
    return c.json({ error: 'invalid_target', detail: 'That is already the master account.' }, 400);
  }

  // Demote then promote, in one batch. The unique index makes the reverse order impossible
  // rather than merely unwise, and the batch means there is no instant with two masters or
  // none.
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE users SET role = 'admin', can_manage_users = 1, can_grant_admin = 1,
              can_view_frames = 1, can_delete_recordings = 1, updated_at = ?
        WHERE user_id = ?`,
    ).bind(now, admin.userId),
    c.env.DB.prepare(`UPDATE users SET role = 'master', updated_at = ? WHERE user_id = ?`)
      .bind(now, targetId),
  ]);

  await adminAudit(c.env, c.req.raw, admin, 'transfer_master', targetId,
    `from ${admin.email} to ${target.email}`);
  return c.json({
    ok: true,
    note: `${target.email} is now the master account. This account is an operator with `
      + 'every permission, and can no longer act on the master.',
  });
}));

/**
 * Ask any account's running capture to stop.
 *
 * The gentler of the two operator powers, and the one worth reaching for first: it ends a
 * runaway recording without destroying what it has already stored.
 */
app.post('/v1/admin/sessions/:id/request-stop', adminOnly(async (c, admin) => {
  const id = c.req.param('id');
  const res = await c.env.DB.prepare(
    `UPDATE sessions SET stop_requested_at = ? WHERE session_id = ? AND ended_at IS NULL`,
  ).bind(new Date().toISOString(), id).run();
  await adminAudit(c.env, c.req.raw, admin, 'request_stop', id,
    res.meta.changes ? 'stop requested' : 'session was not recording');
  if (!res.meta.changes) return c.json({ error: 'not_recording' }, 404);
  return c.json({ ok: true, note: 'The recording device stops on its next heartbeat.' });
}));

/**
 * Close any account's open session.
 *
 * The counterpart to Ask to stop, for when that went unanswered. A stop request needs the
 * recording browser to still be running to collect it; when that browser is gone, nothing
 * collects it and the row stays open. The sweep closes these within minutes on its own —
 * this is the way to not wait.
 */
app.post('/v1/admin/sessions/:id/finish', adminOnly(async (c, admin) => {
  // adminOnly hands back a Context with no path generic, so the parameter is not inferred
  // as present. Checked rather than asserted: an empty id would close nothing and report
  // success, which is a worse answer than a refusal.
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'not_found' }, 404);

  const row = await c.env.DB.prepare(
    `SELECT ended_at, last_seen_at FROM sessions WHERE session_id = ?`,
  ).bind(id).first<{ ended_at: string | null; last_seen_at: string | null }>();
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.ended_at) return c.json({ ok: true, already_finished: true, ended_at: row.ended_at });
  if (row.last_seen_at && row.last_seen_at >= liveCutoff()) {
    return c.json({
      error: 'still_recording',
      detail: 'This capture is still reporting in. Ask it to stop; it closes itself.',
    }, 409);
  }

  const closed = await closeSession(c.env, id);
  await adminAudit(c.env, c.req.raw, admin, 'finish_session', id,
    `closed at ${closed.ended_at ?? 'its start'}, ${closed.frames} frame(s)`);
  return c.json({ ok: true, ...closed });
}));

/** Delete any account's session and its images. Irreversible, and logged with its size. */
app.delete('/v1/admin/sessions/:id', adminOnly(async (c, admin) => {
  const id = c.req.param('id');
  const { results } = await c.env.DB.prepare(
    `SELECT storage_key FROM frames WHERE session_id = ?`,
  ).bind(id).all<{ storage_key: string }>();

  await deleteObjects(c.env, results.map((r) => r.storage_key));
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM frames WHERE session_id = ?`).bind(id),
    c.env.DB.prepare(`DELETE FROM sessions WHERE session_id = ?`).bind(id),
  ]);
  await adminAudit(c.env, c.req.raw, admin, 'delete_session', id,
    `${results.length} frame(s) deleted`);
  return c.json({ ok: true, deleted: results.length });
}, 'can_delete_recordings'));

/**
 * One session's frames, for an operator, regardless of who owns it.
 *
 * Separate from the owner's own route rather than a branch inside it: an operator reading
 * someone else's recording is a different act from a person reading their own, and the two
 * should not share a code path where a missing condition silently turns one into the other.
 */
app.get('/v1/admin/sessions/:id/frames', adminOnly(async (c, admin) => {
  const id = c.req.param('id');
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM frames WHERE session_id = ? ORDER BY seq ASC`,
  ).bind(id).all();
  const session = await c.env.DB.prepare(
    `SELECT s.*, u.email FROM sessions s JOIN users u ON u.user_id = s.user_id
      WHERE s.session_id = ?`,
  ).bind(id).first();
  await adminAudit(c.env, c.req.raw, admin, 'view_session', id,
    `${results.length} frame(s), owner ${(session as { email?: string })?.email ?? 'unknown'}`);
  return c.json({ session, frames: results.map(publicFrame) });
}, 'can_view_frames'));

/** What operators have been doing. Visible to operators, which is the point of having it. */
app.get('/v1/admin/events', adminOnly(async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT at, actor_email, action, subject_id, detail, ip
       FROM admin_events ORDER BY at DESC LIMIT 200`,
  ).all();
  return c.json({ events: results });
}));

app.use('/mcp', requireAuth);

/**
 * MCP endpoint. Same device token as the REST API — an MCP client that can send an
 * Authorization header is all that is required.
 */
app.all('/mcp', (c) => handleMcp(c.req.raw, c.env, c.get('me')));


/**
 * Close a session at the moment its recording actually reached, not at now.
 *
 * The end time comes from the last frame plus how long it stayed on screen. Using the
 * current time would claim the recording ran until whoever noticed got round to it — for a
 * laptop closed on Friday and reopened on Monday, a three-day session that never happened.
 *
 * Shared by the three things that close a session someone else's browser did not: the
 * owner's Finish button, an operator's, and the sweep that closes abandoned ones without
 * anybody asking. One description of what closing means, in one place.
 */
async function closeSession(
  env: Env, sessionId: string, userId?: string,
): Promise<{ ended_at: string | null; frames: number }> {
  const scope = userId ? 'AND user_id = ?' : '';
  const binds = userId ? [sessionId, userId] : [sessionId];

  const last = await env.DB.prepare(
    `SELECT captured_at, hold_ms FROM frames WHERE session_id = ? ${scope}
      ORDER BY seq DESC LIMIT 1`,
  ).bind(...binds).first<{ captured_at: string | null; hold_ms: number | null }>();

  const tally = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) + COALESCE(SUM(original_bytes), 0) AS bytes
       FROM frames WHERE session_id = ? ${scope}`,
  ).bind(...binds).first<{ n: number; bytes: number }>();

  const endedAt = last?.captured_at
    ? new Date(Date.parse(last.captured_at) + (last.hold_ms ?? 0)).toISOString()
    // No frames at all: there is no moment the recording reached, so the only honest end
    // is the moment it began. It shows as a zero-length session, which is what it was.
    : null;

  await env.DB.prepare(
    `UPDATE sessions
        SET ended_at = COALESCE(?, started_at),
            frames_stored = ?, bytes_stored = ?, stop_requested_at = NULL
      WHERE session_id = ? ${scope} AND ended_at IS NULL`,
  ).bind(endedAt, tally?.n ?? 0, tally?.bytes ?? 0, ...binds).run();

  return { ended_at: endedAt, frames: tally?.n ?? 0 };
}

/**
 * How long a session may go without a heartbeat before it is treated as abandoned.
 *
 * Far longer than the 45 seconds that decides "recording right now", because these are
 * different questions. Dropping out of the live list should be quick — a stale entry there
 * is a lie about the present. Closing the row is irreversible bookkeeping, and a laptop
 * whose lid was shut for five minutes should come back to the recording it left.
 */
const ABANDONED_AFTER_MS = 10 * 60_000;

/**
 * Close sessions whose browser never did.
 *
 * A session is completed by the browser that made it. When that browser is closed, crashes,
 * loses power, or is asked to stop and never hears the request, the row stays open forever
 * — and "open" is what the library and the operator view then show, indefinitely, for a
 * recording that ended hours ago. Nothing reconciled that, so it needed a person to notice
 * and press a button. It should not.
 */
async function closeAbandoned(env: Env): Promise<number> {
  const cutoff = new Date(Date.now() - ABANDONED_AFTER_MS).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT session_id FROM sessions
      WHERE ended_at IS NULL
        AND COALESCE(last_seen_at, started_at) < ?
      LIMIT 200`,
  ).bind(cutoff).all<{ session_id: string }>();

  for (const row of results) await closeSession(env, row.session_id);
  if (results.length) console.log(`closed ${results.length} abandoned session(s)`);
  return results.length;
}

/**
 * Close a recording that was never closed.
 *
 * A session is completed by the browser that made it, so one whose browser was closed,
 * crashed or lost power stays open forever — visible in the library as "unfinished", with
 * nothing but Delete to do about it. Deleting is the wrong remedy for a recording that
 * holds real frames: the capture happened, and its frames are worth keeping.
 *
 * The end time is taken from the last frame's own timestamp plus how long it stayed on
 * screen, not from now. Now would claim the recording ran until whenever somebody
 * happened to notice, which for a laptop closed on Friday and reopened on Monday is a
 * three-day session that never existed.
 *
 * Refused while the session is still beating: a live capture is not unfinished, and
 * closing it out from under the browser that owns it would leave that browser uploading
 * into a session the database considers over.
 */
app.post('/v1/sessions/:id/finish', async (c) => {
  const me = c.get('me');
  const id = c.req.param('id');

  const row = await c.env.DB.prepare(
    `SELECT ended_at, last_seen_at FROM sessions WHERE session_id = ? AND user_id = ?`,
  ).bind(id, me.userId).first<{ ended_at: string | null; last_seen_at: string | null }>();
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.ended_at) return c.json({ ok: true, already_finished: true, ended_at: row.ended_at });
  if (row.last_seen_at && row.last_seen_at >= liveCutoff()) {
    return c.json({
      error: 'still_recording',
      detail: 'This capture is still running. Ask it to stop instead; it closes itself.',
    }, 409);
  }

  const closed = await closeSession(c.env, id, me.userId);
  return c.json({ ok: true, ...closed });
});

/** Upsert, so the client can call it before every batch without tracking whether it exists. */
app.put('/v1/sessions/:id', async (c) => {
  const me = c.get('me');
  const s = await c.req.json<Record<string, unknown>>();
  await c.env.DB.prepare(
    `INSERT INTO sessions (session_id, user_id, device_id, started_at, ended_at, capture_fps,
       sensitivity, screen_w, screen_h, frames_stored, frames_skipped, bytes_stored, label,
       tz_name, tz_offset_minutes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(session_id) DO UPDATE SET
       ended_at = excluded.ended_at, frames_stored = excluded.frames_stored,
       frames_skipped = excluded.frames_skipped, bytes_stored = excluded.bytes_stored,
       label = excluded.label`,
  ).bind(
    c.req.param('id'), me.userId, String(s.device_id ?? ''), String(s.started_at ?? ''),
    s.ended_at ?? null, Number(s.capture_fps ?? 0), Number(s.sensitivity ?? 0),
    Number(s.screen_w ?? 0), Number(s.screen_h ?? 0), Number(s.frames_stored ?? 0),
    Number(s.frames_skipped ?? 0), Number(s.bytes_stored ?? 0), s.label ?? null,
    // Set once, on the row's first write, and deliberately absent from the DO UPDATE list:
    // this describes the machine that started the recording, and the heartbeat that keeps
    // frames_stored current has no business rewriting it. Null when the browser would not
    // say, which is a real answer and not a reason to guess.
    s.tz_name === null || s.tz_name === undefined ? null : String(s.tz_name).slice(0, 64),
    s.tz_offset_minutes === null || s.tz_offset_minutes === undefined
      ? null
      : Number(s.tz_offset_minutes),
  ).run();
  return c.json({ ok: true });
});

/**
 * "Still recording." Sent every few seconds by the browser that holds the capture.
 *
 * This is the only thing that can distinguish a recording in progress from one whose
 * browser was closed, crashed, or went to sleep — those are identical in the table
 * otherwise, and stay identical forever. Liveness that decays on its own needs no cleanup
 * process, and a cleanup process that has to be right is a cleanup process that will one
 * day be wrong.
 *
 * The response carries back any stop asked for elsewhere. A remote stop cannot be pushed:
 * nothing outside the recording browser can release its screen-capture stream, so the
 * request is left here and the browser collects it on its next beat.
 */
app.post('/v1/sessions/:id/heartbeat', async (c) => {
  const me = c.get('me');
  const id = c.req.param('id');
  const body = await c.req.json<{ frames_stored?: number; bytes_stored?: number }>()
    .catch(() => ({} as { frames_stored?: number; bytes_stored?: number }));

  // Counts come along for the ride so another device watching this session sees it grow.
  // Scoped to the owner and to an unfinished session: a heartbeat must never resurrect a
  // recording that has already been stopped.
  const res = await c.env.DB.prepare(
    `UPDATE sessions
        SET last_seen_at = ?,
            frames_stored = MAX(frames_stored, ?),
            bytes_stored = MAX(bytes_stored, ?)
      WHERE session_id = ? AND user_id = ? AND ended_at IS NULL`,
  ).bind(
    new Date().toISOString(),
    Number(body.frames_stored ?? 0), Number(body.bytes_stored ?? 0),
    id, me.userId,
  ).run();

  if (!res.meta.changes) return c.json({ ok: false, reason: 'not_recording' }, 404);

  const row = await c.env.DB.prepare(
    `SELECT stop_requested_at FROM sessions WHERE session_id = ? AND user_id = ?`,
  ).bind(id, me.userId).first<{ stop_requested_at: string | null }>();

  return c.json({
    ok: true,
    stop_requested: Boolean(row?.stop_requested_at),
    interval_ms: HEARTBEAT_INTERVAL_MS,
  });
});

/**
 * What this account is recording right now, on any device.
 *
 * The client holds capture entirely in memory, so a second browser signed in as the same
 * person has no other way to learn that the first one is recording — which is what made it
 * report "nothing is being captured" while a capture was plainly running.
 */
app.get('/v1/sessions/live', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT session_id, device_id, started_at, last_seen_at, capture_fps, sensitivity,
            screen_w, screen_h, frames_stored, bytes_stored, label, stop_requested_at
       FROM sessions
      WHERE user_id = ? AND ended_at IS NULL AND last_seen_at >= ?
      ORDER BY started_at ASC`,
  ).bind(c.get('me').userId, liveCutoff()).all();

  return c.json({
    sessions: results.map((r) => ({ ...r, stop_requested: Boolean(r.stop_requested_at) })),
    live_window_ms: LIVE_WINDOW_MS,
  });
});

/** Ask the browser holding this capture to stop it. Collected on its next heartbeat. */
app.post('/v1/sessions/:id/request-stop', async (c) => {
  const me = c.get('me');
  const res = await c.env.DB.prepare(
    `UPDATE sessions SET stop_requested_at = ?
      WHERE session_id = ? AND user_id = ? AND ended_at IS NULL`,
  ).bind(new Date().toISOString(), c.req.param('id'), me.userId).run();
  if (!res.meta.changes) return c.json({ error: 'not_recording' }, 404);
  return c.json({ ok: true, note: 'The recording device stops on its next heartbeat.' });
});

app.get('/v1/sessions', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT 200`,
  ).bind(c.get('me').userId).all();
  return c.json({ sessions: results });
});

app.delete('/v1/sessions/:id', async (c) => {
  const me = c.get('me');
  const id = c.req.param('id');
  const { results } = await c.env.DB.prepare(
    `SELECT storage_key FROM frames WHERE session_id = ? AND user_id = ?`,
  ).bind(id, me.userId).all<{ storage_key: string }>();

  await deleteObjects(c.env, results.map((r) => r.storage_key));
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM frames WHERE session_id = ? AND user_id = ?`).bind(id, me.userId),
    c.env.DB.prepare(`DELETE FROM sessions WHERE session_id = ? AND user_id = ?`).bind(id, me.userId),
  ]);
  return c.json({ ok: true, deleted: results.length });
});

/**
 * Erase everything belonging to the caller: objects, frame rows, session rows.
 *
 * With the browser holding nothing durable, this is the only way a user can delete their
 * own history, so it is a first-class route rather than a client-side loop over sessions —
 * a loop would leave a partial deletion behind if it were interrupted halfway.
 */
app.delete('/v1/data', async (c) => {
  const userId = c.get('me').userId;
  const frames = await deleteFramesWhere(c.env, 'user_id = ?', [userId]);

  const { meta } = await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`)
    .bind(userId).run();
  return c.json({ ok: true, frames, sessions: meta?.changes ?? 0 });
});

/**
 * Ingest one frame: metadata plus both encoded variants, as multipart.
 *
 * The bytes go through the Worker rather than via a presigned direct-to-R2 PUT. Cloudflare
 * does not bill Worker bandwidth, and a frame is ~110 KB — far inside the request limit —
 * so presigning would buy nothing and cost a set of S3 credentials to manage.
 */
app.post('/v1/frames', async (c) => {
  const me = c.get('me');
  const form = await c.req.formData();
  const metaRaw = form.get('meta');
  const full = filePart(form.get('full'));
  const thumb = filePart(form.get('thumb'));

  if (typeof metaRaw !== 'string' || !full || !thumb) {
    return c.json({ error: 'expected multipart fields: meta (JSON), full (file), thumb (file)' }, 400);
  }
  const m = JSON.parse(metaRaw) as Record<string, unknown>;
  const frameId = String(m.frame_id ?? '');
  const sessionId = String(m.session_id ?? '');
  if (!frameId || !sessionId) return c.json({ error: 'frame_id and session_id are required' }, 400);

  // The session must already exist AND belong to the caller. Without this check a valid
  // token could attach frames to someone else's session.
  // The device comes from this row too. Taking it from the request body would let a
  // client attribute a frame to a machine it has never seen, and the whole value of a
  // per-frame device is that it cannot be claimed.
  const owner = await c.env.DB.prepare(
    `SELECT user_id, device_id FROM sessions WHERE session_id = ?`,
  ).bind(sessionId).first<{ user_id: string; device_id: string }>();
  if (!owner) return c.json({ error: 'unknown session' }, 404);
  if (owner.user_id !== me.userId) return c.json({ error: 'forbidden' }, 403);

  const key = `f/${me.userId}/${sessionId}/${frameId}.webp`;
  const thumbKey = `t/${me.userId}/${sessionId}/${frameId}.webp`;
  // Optional by design. A redacted frame has no original, because the browser never
  // encoded one — its absence here is the evidence that the masking happened upstream.
  const original = filePart(form.get('original'));
  const originalKey = original ? `o/${me.userId}/${sessionId}/${frameId}.webp` : null;

  await Promise.all([
    c.env.FRAMES.put(key, full.stream(), { httpMetadata: { contentType: 'image/webp' } }),
    c.env.FRAMES.put(thumbKey, thumb.stream(), { httpMetadata: { contentType: 'image/webp' } }),
    ...(original && originalKey
      ? [c.env.FRAMES.put(originalKey, original.stream(), {
          httpMetadata: { contentType: 'image/webp' },
        })]
      : []),
  ]);

  const redacted = m.redacted === true;
  // A client claiming both "redacted" and an original is either confused or malicious;
  // either way the safe reading is that the frame is sensitive. Drop what it sent.
  if (redacted && originalKey) {
    await c.env.FRAMES.delete(originalKey).catch(() => undefined);
  }

  await c.env.DB.prepare(
    `INSERT INTO frames (frame_id, session_id, user_id, device_id, captured_at, offset_ms, seq,
       hold_ms, change_score, changed_tiles, reason, width, height, bytes, format, sha256,
       storage_key, stamp, redacted, redacted_regions, original_key, original_bytes,
       tz_offset_minutes, ocr_text, caption, enrich_status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,'pending')
     ON CONFLICT(frame_id) DO UPDATE SET hold_ms = COALESCE(excluded.hold_ms, frames.hold_ms)`,
  ).bind(
    frameId, sessionId, me.userId, owner.device_id,
    String(m.captured_at ?? ''), Number(m.offset_ms ?? 0),
    Number(m.seq ?? 0), m.hold_ms === null || m.hold_ms === undefined ? null : Number(m.hold_ms),
    Number(m.change_score ?? 0), JSON.stringify(m.changed_tiles ?? []), String(m.reason ?? 'first'),
    Number(m.width ?? 0), Number(m.height ?? 0), Number(m.bytes ?? 0),
    String(m.format ?? 'image/webp'), String(m.sha256 ?? ''), key,
    String(m.stamp ?? ''), redacted ? 1 : 0,
    JSON.stringify(Array.isArray(m.redacted_regions) ? m.redacted_regions : []),
    redacted ? null : originalKey,
    // Measured here rather than taken from the client: the server is holding the bytes,
    // so it can weigh them, and a storage figure built from what the client claimed would
    // be worth nothing.
    redacted || !original ? 0 : original.size,
    // Taken from the client, unlike the device: an offset is a property of the machine
    // that did the capturing and the server has no way to observe it. A client that lies
    // about it mislabels only its own frames. Null rather than 0 when absent — 0 would
    // assert the recorder was on UTC, which is a claim, not a missing value.
    m.tz_offset_minutes === null || m.tz_offset_minutes === undefined
      ? null
      : Number(m.tz_offset_minutes),
  ).run();

  return c.json({
    ok: true, frame_id: frameId, storage_key: key, redacted, original: !redacted && !!originalKey,
  });
});

/**
 * Resolve a frame stamp to the frame it names.
 *
 * The stamp carries the capture time in the clear and the device and account only as
 * fingerprints, so this is the other half of the design: the code proves *when* on its own,
 * and this endpoint — behind the account that owns the frame — supplies everything else.
 *
 * Scoped to the caller like every other frame route. A stamp is not a capability: holding
 * one gets you a decoded timestamp and nothing more unless the frame is already yours.
 * That is why the two failure modes are deliberately the same response — "no frame here"
 * covers both a stamp that names nothing and a stamp that names someone else's recording,
 * so this cannot be used to test whether a given moment exists in another account.
 */
app.get('/v1/frames/stamp/:code', async (c) => {
  let parts;
  try {
    parts = decodeStamp(c.req.param('code'));
  } catch (err) {
    if (err instanceof StampError) return c.json({ error: 'bad_stamp', detail: err.message }, 400);
    throw err;
  }

  // The stamp carries the whole frame id, so this is a primary-key hit scoped to the
  // caller — no range scan, and nothing to disambiguate.
  const row = await c.env.DB.prepare(
    `SELECT * FROM frames WHERE frame_id = ? AND user_id = ?`,
  ).bind(parts.handle, c.get('me').userId).first<Record<string, unknown>>();

  if (!row) {
    return c.json({
      error: 'not_found',
      detail: 'No frame of yours carries this stamp. It may belong to another account, or ' +
        'the frame may have passed the retention window.',
      decoded: { captured_at: new Date(parts.capturedAtMs).toISOString(), handle: parts.handle },
    }, 404);
  }

  const session = await c.env.DB.prepare(
    `SELECT session_id, device_id, started_at, ended_at, screen_w, screen_h, label
       FROM sessions WHERE session_id = ? AND user_id = ?`,
  ).bind(row.session_id, c.get('me').userId).first<Record<string, unknown>>();

  return c.json({
    stamp: {
      handle: parts.handle,
      captured_at: new Date(parts.capturedAtMs).toISOString(),
      device_fingerprint: parts.device,
      account_fingerprint: parts.account,
    },
    frame: publicFrame(row),
    session,
  });
});

app.patch('/v1/frames/:id', async (c) => {
  const { hold_ms } = await c.req.json<{ hold_ms?: number }>();
  await c.env.DB.prepare(
    `UPDATE frames SET hold_ms = ? WHERE frame_id = ? AND user_id = ?`,
  ).bind(hold_ms ?? null, c.req.param('id'), c.get('me').userId).run();
  return c.json({ ok: true });
});

/**
 * A frames row as the API presents it.
 *
 * D1 has no boolean and no array, so three columns need converting on the way out, and two
 * need removing: the object keys are where bytes happen to live, and a caller that had
 * them might reasonably conclude it should fetch them directly. What a caller needs is
 * whether an untouched capture exists, which is `has_original`.
 */
export function publicFrame(row: Record<string, unknown>): Record<string, unknown> {
  const { storage_key: _s, original_key, ...rest } = row;
  return {
    ...rest,
    changed_tiles: JSON.parse(String(row.changed_tiles ?? '[]')) as number[],
    redacted_regions: JSON.parse(String(row.redacted_regions ?? '[]')) as unknown[],
    redacted: Boolean(row.redacted),
    has_original: Boolean(original_key),
  };
}

app.get('/v1/sessions/:id/frames', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM frames WHERE session_id = ? AND user_id = ? ORDER BY seq ASC`,
  ).bind(c.req.param('id'), c.get('me').userId).all();
  return c.json({ frames: results.map(publicFrame) });
});

/**
 * The frame's pixels, in one of three forms.
 *
 *   full      the stored image: the stamp burned in, and the masks if there were any
 *   thumb     a small copy of that same image, masks included
 *   original  the capture untouched — present only when nothing was masked
 *
 * `original` on a redacted frame is a 404 rather than a fallback to `full`. Silently
 * serving the redacted image under the name "original" would teach a caller that the
 * original still exists somewhere, and the entire point is that it does not.
 */
app.get('/v1/frames/:id/image', async (c) => {
  const me = c.get('me');
  const frameId = c.req.param('id');

  let row = await c.env.DB.prepare(
    `SELECT storage_key, original_key, redacted, user_id
       FROM frames WHERE frame_id = ? AND user_id = ?`,
  ).bind(frameId, me.userId)
    .first<{ storage_key: string; original_key: string | null; redacted: number; user_id: string }>();

  /**
   * An operator may look at a frame that is not theirs.
   *
   * This is the sharpest edge in the system and it is here on an explicit instruction,
   * having first been built without it. Three things hold it in place.
   *
   * It is only reached after the owner lookup misses, so an operator viewing their own
   * recordings takes the ordinary path and logs nothing — the log stays a record of
   * looking at *other people's* screens, which is the only thing worth reviewing.
   *
   * Every such view is written to admin_events before the bytes are served, not after. A
   * log written after the response can be lost to a crash mid-stream; one written before
   * cannot be, and the cost of logging a view that then fails to deliver is nothing.
   *
   * And a redacted frame is redacted for an operator too. There is no unmasked copy to
   * serve — it was never encoded — so this grants no ability to see what the privacy layer
   * removed. That is a property of how the frame was stored, not a check anyone can skip.
   */
  if (!row) {
    const admin = await resolvePrincipal(c.env, me.userId);
    // Being an operator is not enough. Looking at someone else's screen is its own
    // permission, off by default, and separately logged every time it is used.
    if (admin && can(admin, 'can_view_frames')) {
      row = await c.env.DB.prepare(
        `SELECT storage_key, original_key, redacted, user_id FROM frames WHERE frame_id = ?`,
      ).bind(frameId)
        .first<{ storage_key: string; original_key: string | null; redacted: number; user_id: string }>();
      if (row) {
        await adminAudit(
          c.env, c.req.raw, admin, 'view_frame', frameId,
          `owner ${row.user_id}, variant ${c.req.query('variant') ?? 'full'}`,
        );
      }
    }
  }

  if (!row) return c.json({ error: 'not found' }, 404);

  const variant = c.req.query('variant');
  let key: string;
  if (variant === 'thumb') {
    key = row.storage_key.replace(/^f\//, 't/');
  } else if (variant === 'original') {
    if (!row.original_key) {
      return c.json({
        error: 'no_original',
        detail: row.redacted
          ? 'This frame was redacted, so no unmasked copy was ever created.'
          : 'No separate original was stored for this frame; the stored image is the capture.',
      }, 404);
    }
    key = row.original_key;
  } else {
    key = row.storage_key;
  }

  const obj = await c.env.FRAMES.get(key);
  if (!obj) return c.json({ error: 'object missing' }, 404);

  return new Response(obj.body, {
    headers: {
      'Content-Type': 'image/webp',
      'Cache-Control': 'private, max-age=3600',
      ETag: obj.httpEtag,
    },
  });
});

/**
 * The MCP tools' queries, mirrored as plain REST for clients without MCP support.
 * Both surfaces run the same code in queries.ts so they cannot drift apart.
 */
app.get('/v1/timeline', async (c) => {
  const qs = c.req.query();
  const w = resolveWindow({
    last_hours: qs.last_hours ? Number(qs.last_hours) : undefined,
    from: qs.from, to: qs.to,
  });
  const frames = await listFrames(c.env, c.get('me').userId, w, {
    minChange: qs.min_change ? Number(qs.min_change) : undefined,
    reason: qs.reason,
    limit: qs.limit ? Number(qs.limit) : 100,
  });
  return c.json({ window: w, count: frames.length, frames });
});

app.get('/v1/scenes', async (c) => {
  const qs = c.req.query();
  const w = resolveWindow({
    last_hours: qs.last_hours ? Number(qs.last_hours) : undefined,
    from: qs.from, to: qs.to,
  });
  const frames = await listFrames(c.env, c.get('me').userId, w, { limit: 5000 });
  const { scenes, hidden } = buildScenes(frames, qs.min_scene_ms ? Number(qs.min_scene_ms) : 5000);
  return c.json({ window: w, count: scenes.length, hidden, scenes });
});

/**
 * What this account is actually storing.
 *
 * `bytes` used to be the whole answer and was only ever the stored image; the untouched
 * capture kept beside it was invisible. The total is now what R2 really holds, with the
 * split kept so the cost of the second copy is a number rather than an assertion.
 *
 * `unmeasured` counts frames written before that size was recorded. Their objects exist
 * and are not in the total, and saying so is better than presenting a figure that quietly
 * understates by an unknown amount.
 */
app.get('/v1/usage', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS frames,
            COALESCE(SUM(bytes),0) AS bytes,
            COALESCE(SUM(original_bytes),0) AS original_bytes,
            SUM(CASE WHEN original_key IS NOT NULL AND original_bytes = 0 THEN 1 ELSE 0 END)
              AS unmeasured,
            COUNT(DISTINCT session_id) AS sessions,
            MIN(captured_at) AS oldest
     FROM frames WHERE user_id = ?`,
  ).bind(c.get('me').userId).first<Record<string, number | string | null>>();

  const stored = Number(row?.bytes ?? 0);
  const originals = Number(row?.original_bytes ?? 0);
  return c.json({ ...row, bytes: stored + originals, stored_bytes: stored, original_bytes: originals });
});

/**
 * Everything needed to price the account's storage, and to watch it move.
 *
 * Separate from /v1/usage because it costs more to answer: the daily series groups over
 * every one of the account's frame rows, and D1 bills on rows read. /v1/usage is polled by
 * the recorder while it records; this is opened by a person looking at a dashboard, which
 * is a different frequency and deserves a different query.
 *
 * The averages are measured rather than assumed. A cost projection built on a guessed
 * frame size is a guess wearing a dollar sign.
 */
app.get('/v1/usage/history', async (c) => {
  const userId = c.get('me').userId;
  const days = Math.min(90, Math.max(1, Number(c.req.query('days') ?? 30)));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const [totals, series] = await Promise.all([
    c.env.DB.prepare(
      `SELECT COUNT(*) AS frames,
              COALESCE(SUM(bytes),0) AS stored_bytes,
              COALESCE(SUM(original_bytes),0) AS original_bytes,
              COALESCE(AVG(bytes),0) AS avg_frame_bytes,
              COALESCE(MIN(bytes),0) AS min_frame_bytes,
              COALESCE(MAX(bytes),0) AS max_frame_bytes,
              COUNT(DISTINCT session_id) AS sessions,
              MIN(captured_at) AS oldest,
              MAX(captured_at) AS newest
       FROM frames WHERE user_id = ?`,
    ).bind(userId).first<Record<string, number | string | null>>(),
    c.env.DB.prepare(
      `SELECT substr(captured_at, 1, 10) AS day,
              COUNT(*) AS frames,
              COALESCE(SUM(bytes),0) AS bytes
       FROM frames
       WHERE user_id = ? AND captured_at >= ?
       GROUP BY day ORDER BY day`,
    ).bind(userId, since).all<{ day: string; frames: number; bytes: number }>(),
  ]);

  return c.json({
    generated_at: new Date().toISOString(),
    retention_days: Number(c.env.RETENTION_DAYS ?? 7),
    totals: {
      ...totals,
      bytes: Number(totals?.stored_bytes ?? 0) + Number(totals?.original_bytes ?? 0),
    },
    daily: series.results,
  });
});

/**
 * Anything not matched above is a client-side route, so serve the app shell.
 *
 * `not_found_handling = "single-page-application"` alone does not do this. Cloudflare
 * applies it only when there is no Worker, or when the Worker defers back through the
 * assets binding — and this Worker answers first, so every unmatched path was reaching
 * Hono and 404ing. That silently broke /status and the /verify and /reset links the
 * account emails send.
 *
 * API paths keep their JSON 404: a client calling /v1/nonsense wants an error it can
 * parse, not a page.
 */
app.notFound((c) => {
  const { pathname } = new URL(c.req.url);
  if (pathname.startsWith('/v1/') || pathname === '/mcp') {
    return c.json({ error: 'not_found' }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

/** Must match the nightly entry in wrangler.toml's `crons`. */
const RETENTION_CRON = '0 3 * * *';

/** A multipart file part is any entry that is not a plain string. */
function filePart(v: unknown): Blob | null {
  return v !== null && v !== undefined && typeof v !== 'string' ? (v as Blob) : null;
}

async function prune(env: Env, maxBatches = Number.POSITIVE_INFINITY): Promise<number> {
  const days = Number(env.RETENTION_DAYS || '7');
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  let total = await deleteFramesWhere(env, 'captured_at < ?', [cutoff], maxBatches);

  /**
   * Frames whose account no longer exists.
   *
   * `DELETE /v1/account` deletes what it can inside the request and then removes the
   * account regardless, because ending access is the urgent half and clearing tens of
   * thousands of objects is not something one request can promise. This is the other half,
   * and it is what makes "delete my account" mean the images are gone rather than merely
   * unreachable. It is also the backstop for any future path that removes a user and
   * forgets the recordings, which is exactly the mistake being fixed here.
   *
   * It runs here, on the nightly sweep, and must not be moved to the five-minute cron.
   * `user_id NOT IN (SELECT user_id FROM users)` walks idx_frames_user_time, so it reads
   * in proportion to the whole frames table however few orphans it finds — and D1 charges
   * for rows read. A full-table read on a five-minute timer is precisely what exhausted
   * the daily allowance and took logins down; once a day the same query is nothing.
   *
   * The cost of that placement is honest and worth stating: a deleted account's leftover
   * images can persist until the next 03:00, not merely until the next tick. Only an
   * account too large to clear inside its own delete request has any, which is why the
   * in-request bound is set high enough that a normal account never reaches this at all.
   */
  // Sharing the caller's budget rather than ignoring it. `maxBatches` exists to keep one
  // invocation inside the platform's limits, and a second unbounded pass behind a bounded
  // one would quietly undo that — a purge with tens of thousands of orphans would run as
  // long as if no bound had been given at all.
  const spent = Math.ceil(total / FRAME_BATCH);
  const left = maxBatches === Number.POSITIVE_INFINITY
    ? Number.POSITIVE_INFINITY
    : Math.max(0, maxBatches - spent);
  total += await deleteFramesWhere(env, 'user_id NOT IN (SELECT user_id FROM users)', [], left);

  /**
   * Sessions with nothing left in them.
   *
   * `ended_at IS NOT NULL` is not tidiness. Without it this deletes a recording that
   * started seconds ago and has not uploaded its first frame yet — the sweep runs at
   * 03:00, a session begun at 02:59:59 is empty at that moment, and the recorder's next
   * frame upload would 404 against a session the server had quietly removed underneath
   * it. Only a closed session can be judged by whether it has frames.
   */
  await env.DB.prepare(
    `DELETE FROM sessions
      WHERE ended_at IS NOT NULL
        AND session_id NOT IN (SELECT DISTINCT session_id FROM frames)`,
  ).run();
  return total;
}

export default {
  fetch: app.fetch,
  /**
   * Two schedules on one handler, told apart by the cron expression.
   *
   * The probe runs every five minutes because a status page whose history has hour-wide
   * gaps cannot answer "was it down when I was recording". The sweep runs nightly because
   * deleting a day of expired frames is expensive and needs to happen exactly once.
   */
  async scheduled(evt: ScheduledController, env: Env): Promise<void> {
    if (evt.cron === RETENTION_CRON) {
      const n = await prune(env);
      await pruneAuthTables(env);
      await pruneStatusTables(env);
      console.log(`retention sweep removed ${n} frames; auth and status tables pruned`);
      return;
    }
    await recordProbes(env, await runProbes(env));
    // Cheap, indexed, and almost always a no-op. Running it beside the probe rather than
    // in the nightly sweep means an abandoned recording reads as finished within minutes
    // instead of the next morning.
    await closeAbandoned(env).catch((err) => console.error('abandoned sweep failed', err));

    // RETENTION_DAYS=0 is not a retention policy, it is an order to keep nothing, and an
    // operator who has just given that order should not have to wait until 03:00 to see it
    // carried out. So purge mode runs the same sweep on the five-minute schedule, reusing
    // `prune` because it removes the object and its catalogue row together — the one
    // property a purge must not lose.
    //
    // Last, and caught. Everything above it is the status page's only source of evidence,
    // and putting a bulk delete of tens of thousands of objects in front of the probe
    // means that if the delete throws or runs out of time, the probe never runs either and
    // the operator watching a purge sees a status page that has simply stopped — which is
    // exactly what happened the first time this shipped.
    //
    // Bounded per invocation for the same reason: it takes as many batches as it can
    // afford and leaves the rest to the next tick five minutes later. It converges, and
    // putting RETENTION_DAYS back above zero ends it.
    //
    // A deployment left at zero also deletes frames captured while it is set, within five
    // minutes. That is the honest reading of "keep nothing", and it is why the switch is a
    // var that takes Cloudflare account access to change rather than a setting in the app.
    if (Number(env.RETENTION_DAYS || '7') <= 0) {
      await prune(env, 40)
        .then((n) => console.log(`purge mode (RETENTION_DAYS=0) removed ${n} frames`))
        .catch((err) => console.error('purge sweep failed', err));
    }
  },
};

export { prune, closeAbandoned, ABANDONED_AFTER_MS };
export { variantKeys, deleteFramesWhere };

/**
 * The Hono app itself, for tests that need to dispatch a real request through the whole
 * middleware chain. Route guards are a property of registration order, and order is not
 * something a unit test of a handler in isolation can see.
 */
export { app };
