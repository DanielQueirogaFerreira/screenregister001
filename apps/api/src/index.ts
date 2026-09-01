import { Hono, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import type { Env, Principal } from './types.js';
import { bearer, issueToken, verifyToken } from './auth.js';
import { handleMcp } from './mcp.js';
import { buildScenes, listFrames, resolveWindow } from './queries.js';
import { OPENAPI } from './openapi.js';

type Ctx = { Bindings: Env; Variables: { me: Principal } };

const app = new Hono<Ctx>();

app.use('*', cors({
  origin: (o) => o,               // the client is served from a different origin
  allowHeaders: ['Authorization', 'Content-Type'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  maxAge: 86400,
}));

/**
 * Liveness plus the two things a fresh deploy most often lacks.
 *
 * The Worker deploys happily without a D1 schema or an AUTH_SECRET, and then fails at
 * request time with errors that point nowhere near the cause — "no such table: frames"
 * says nothing about migrations never having been run. Reporting both here turns a
 * confusing outage into one curl.
 *
 * `auth_configured` is deliberately public: when it is false the Worker is signing with a
 * key published in this repository, so anyone can already forge a token. Hiding that would
 * protect nobody and would let the misconfiguration go unnoticed.
 */
app.get('/v1/health', async (c) => {
  let schema: 'ready' | 'missing' | 'error' = 'ready';
  try {
    await c.env.DB.prepare('SELECT 1 FROM frames LIMIT 1').all();
  } catch (err) {
    schema = /no such table/i.test(String(err)) ? 'missing' : 'error';
  }
  const authConfigured = Boolean(c.env.AUTH_SECRET);

  return c.json({
    ok: schema === 'ready' && authConfigured,
    service: 'screenregister-api',
    schema,
    auth_configured: authConfigured,
    ...(schema === 'missing' && {
      hint: 'Run the D1 migrations: wrangler d1 migrations apply screenregister --remote',
    }),
    ...(!authConfigured && {
      auth_hint: 'AUTH_SECRET is not set; the Worker is using a public development key. ' +
        'Set it: wrangler secret put AUTH_SECRET',
    }),
  });
});

/** Machine-readable description of this API, for clients that do not speak MCP. */
app.get('/v1/openapi.json', (c) => c.json(OPENAPI(new URL(c.req.url).origin)));

/**
 * Register a device and get a token. The client supplies the ids it already generated
 * locally; the server's contribution is the signature that makes them unforgeable.
 */
app.post('/v1/devices', async (c) => {
  const { user_id, device_id } = await c.req.json<{ user_id?: string; device_id?: string }>();
  if (!user_id || !device_id) return c.json({ error: 'user_id and device_id are required' }, 400);

  await c.env.DB.prepare(
    `INSERT INTO devices (device_id, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  ).bind(device_id, user_id, new Date().toISOString(), new Date().toISOString()).run();

  return c.json({ token: await issueToken(c.env, { userId: user_id, deviceId: device_id }) });
});

const authGuard: MiddlewareHandler<Ctx> = async (c, next) => {
  const token = bearer(c.req.header('Authorization'));
  const me = token ? await verifyToken(c.env, token) : null;
  if (!me) return c.json({ error: 'unauthorized' }, 401);
  c.set('me', me);
  await next();
  return undefined;
};

// Everything below is scoped to the token holder. Every query filters on `me.userId`;
// there is no code path that reads another user's rows.
app.use('/v1/sessions/*', authGuard);
app.use('/v1/sessions', authGuard);
app.use('/v1/frames/*', authGuard);
app.use('/v1/frames', authGuard);
app.use('/v1/usage', authGuard);
app.use('/v1/timeline', authGuard);
app.use('/v1/scenes', authGuard);
app.use('/mcp', authGuard);

/**
 * MCP endpoint. Same device token as the REST API — an MCP client that can send an
 * Authorization header is all that is required.
 */
app.all('/mcp', (c) => handleMcp(c.req.raw, c.env, c.get('me')));


/** Upsert, so the client can call it before every batch without tracking whether it exists. */
app.put('/v1/sessions/:id', async (c) => {
  const me = c.get('me');
  const s = await c.req.json<Record<string, unknown>>();
  await c.env.DB.prepare(
    `INSERT INTO sessions (session_id, user_id, device_id, started_at, ended_at, capture_fps,
       sensitivity, screen_w, screen_h, frames_stored, frames_skipped, bytes_stored, label)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(session_id) DO UPDATE SET
       ended_at = excluded.ended_at, frames_stored = excluded.frames_stored,
       frames_skipped = excluded.frames_skipped, bytes_stored = excluded.bytes_stored,
       label = excluded.label`,
  ).bind(
    c.req.param('id'), me.userId, String(s.device_id ?? ''), String(s.started_at ?? ''),
    s.ended_at ?? null, Number(s.capture_fps ?? 0), Number(s.sensitivity ?? 0),
    Number(s.screen_w ?? 0), Number(s.screen_h ?? 0), Number(s.frames_stored ?? 0),
    Number(s.frames_skipped ?? 0), Number(s.bytes_stored ?? 0), s.label ?? null,
  ).run();
  return c.json({ ok: true });
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
  const owner = await c.env.DB.prepare(
    `SELECT user_id FROM sessions WHERE session_id = ?`,
  ).bind(sessionId).first<{ user_id: string }>();
  if (!owner) return c.json({ error: 'unknown session' }, 404);
  if (owner.user_id !== me.userId) return c.json({ error: 'forbidden' }, 403);

  const key = `f/${me.userId}/${sessionId}/${frameId}.webp`;
  const thumbKey = `t/${me.userId}/${sessionId}/${frameId}.webp`;
  await Promise.all([
    c.env.FRAMES.put(key, full.stream(), { httpMetadata: { contentType: 'image/webp' } }),
    c.env.FRAMES.put(thumbKey, thumb.stream(), { httpMetadata: { contentType: 'image/webp' } }),
  ]);

  await c.env.DB.prepare(
    `INSERT INTO frames (frame_id, session_id, user_id, captured_at, offset_ms, seq, hold_ms,
       change_score, changed_tiles, reason, width, height, bytes, format, sha256, storage_key,
       ocr_text, caption, enrich_status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,'pending')
     ON CONFLICT(frame_id) DO UPDATE SET hold_ms = excluded.hold_ms`,
  ).bind(
    frameId, sessionId, me.userId, String(m.captured_at ?? ''), Number(m.offset_ms ?? 0),
    Number(m.seq ?? 0), m.hold_ms === null || m.hold_ms === undefined ? null : Number(m.hold_ms),
    Number(m.change_score ?? 0), JSON.stringify(m.changed_tiles ?? []), String(m.reason ?? 'first'),
    Number(m.width ?? 0), Number(m.height ?? 0), Number(m.bytes ?? 0),
    String(m.format ?? 'image/webp'), String(m.sha256 ?? ''), key,
  ).run();

  return c.json({ ok: true, frame_id: frameId, storage_key: key });
});

app.patch('/v1/frames/:id', async (c) => {
  const { hold_ms } = await c.req.json<{ hold_ms?: number }>();
  await c.env.DB.prepare(
    `UPDATE frames SET hold_ms = ? WHERE frame_id = ? AND user_id = ?`,
  ).bind(hold_ms ?? null, c.req.param('id'), c.get('me').userId).run();
  return c.json({ ok: true });
});

app.get('/v1/sessions/:id/frames', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM frames WHERE session_id = ? AND user_id = ? ORDER BY seq ASC`,
  ).bind(c.req.param('id'), c.get('me').userId).all();
  return c.json({
    frames: results.map((r) => ({ ...r, changed_tiles: JSON.parse(String(r.changed_tiles)) })),
  });
});

app.get('/v1/frames/:id/image', async (c) => {
  const me = c.get('me');
  const row = await c.env.DB.prepare(
    `SELECT storage_key FROM frames WHERE frame_id = ? AND user_id = ?`,
  ).bind(c.req.param('id'), me.userId).first<{ storage_key: string }>();
  if (!row) return c.json({ error: 'not found' }, 404);

  const key = c.req.query('variant') === 'thumb' ? row.storage_key.replace(/^f\//, 't/') : row.storage_key;
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

app.get('/v1/usage', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS frames, COALESCE(SUM(bytes),0) AS bytes,
            COUNT(DISTINCT session_id) AS sessions, MIN(captured_at) AS oldest
     FROM frames WHERE user_id = ?`,
  ).bind(c.get('me').userId).first();
  return c.json(row ?? {});
});

/** A multipart file part is any entry that is not a plain string. */
function filePart(v: unknown): Blob | null {
  return v !== null && v !== undefined && typeof v !== 'string' ? (v as Blob) : null;
}

async function deleteObjects(env: Env, keys: string[]): Promise<void> {
  const all = keys.flatMap((k) => [k, k.replace(/^f\//, 't/')]);
  // R2 caps a bulk delete at 1000 keys per call.
  for (let i = 0; i < all.length; i += 1000) await env.FRAMES.delete(all.slice(i, i + 1000));
}

/**
 * Retention sweep. The blobs and the catalogue rows are deleted in the same pass so the
 * two never drift apart — an R2 lifecycle rule would expire objects on its own schedule
 * and leave rows pointing at nothing.
 */
async function prune(env: Env): Promise<number> {
  const days = Number(env.RETENTION_DAYS || '7');
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  let total = 0;

  for (;;) {
    const { results } = await env.DB.prepare(
      `SELECT frame_id, storage_key FROM frames WHERE captured_at < ? LIMIT 500`,
    ).bind(cutoff).all<{ frame_id: string; storage_key: string }>();
    if (results.length === 0) break;

    await deleteObjects(env, results.map((r) => r.storage_key));
    await env.DB.prepare(
      `DELETE FROM frames WHERE frame_id IN (${results.map(() => '?').join(',')})`,
    ).bind(...results.map((r) => r.frame_id)).run();
    total += results.length;
  }

  await env.DB.prepare(
    `DELETE FROM sessions WHERE session_id NOT IN (SELECT DISTINCT session_id FROM frames)`,
  ).run();
  return total;
}

export default {
  fetch: app.fetch,
  async scheduled(_evt: ScheduledController, env: Env): Promise<void> {
    const n = await prune(env);
    console.log(`retention sweep removed ${n} frames`);
  },
};

export { prune };
