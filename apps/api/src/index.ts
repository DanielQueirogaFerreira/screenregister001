import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, Principal } from './types.js';
import { AuthNotConfiguredError, isAuthConfigured } from './auth.js';
import { authRoutes, requireAuth } from './auth-routes.js';
import { healthFacts, isLocalhostOrigin, localhostAllowed } from './health.js';
import { pruneAuthTables } from './accounts.js';
import { buildStatus, pruneStatusTables, recordProbes, runProbes } from './status.js';
import { handleMcp } from './mcp.js';
import { buildScenes, listFrames, resolveWindow } from './queries.js';
import { StampError, decodeStamp } from '@sr/schema';
import { OPENAPI } from './openapi.js';

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

/**
 * Everything the status dashboard renders: recorded probe history, uptime, health facts,
 * deployment log and roadmap.
 *
 * Public, like /v1/health, and for the same reason: the moment it is most needed is when
 * authentication is the thing that is broken. It exposes no recordings, no counts of them,
 * and no account data — only whether the platform's own dependencies are answering.
 *
 * Reads only. The five-minute cron is what probes; see the note on buildStatus for why
 * probing per request was a mistake this endpoint had to be caught making.
 */
app.get('/v1/status', async (c) => {
  const payload = await buildStatus(c.env);
  // Half the probe interval. Nothing this endpoint reports can change in between, so a
  // client refreshing every thirty seconds costs one D1 read per cache miss instead of a
  // full probe pass. must-revalidate keeps a stale copy from being served after an outage.
  c.header('Cache-Control', 'public, max-age=150, must-revalidate');
  return c.json(payload);
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
app.use('/v1/data', requireAuth);
app.use('/v1/timeline', requireAuth);
app.use('/v1/scenes', requireAuth);
app.use('/mcp', requireAuth);

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
 * Erase everything belonging to the caller: objects, frame rows, session rows.
 *
 * With the browser holding nothing durable, this is the only way a user can delete their
 * own history, so it is a first-class route rather than a client-side loop over sessions —
 * a loop would leave a partial deletion behind if it were interrupted halfway.
 */
app.delete('/v1/data', async (c) => {
  const userId = c.get('me').userId;
  let frames = 0;

  for (;;) {
    const { results } = await c.env.DB.prepare(
      `SELECT frame_id, storage_key FROM frames WHERE user_id = ? LIMIT 500`,
    ).bind(userId).all<{ frame_id: string; storage_key: string }>();
    if (results.length === 0) break;

    await deleteObjects(c.env, results.map((r) => r.storage_key));
    await c.env.DB.prepare(
      `DELETE FROM frames WHERE frame_id IN (${results.map(() => '?').join(',')})`,
    ).bind(...results.map((r) => r.frame_id)).run();
    frames += results.length;
  }

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
       storage_key, stamp, redacted, redacted_regions, original_key,
       ocr_text, caption, enrich_status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,'pending')
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
  const row = await c.env.DB.prepare(
    `SELECT storage_key, original_key, redacted FROM frames WHERE frame_id = ? AND user_id = ?`,
  ).bind(c.req.param('id'), me.userId)
    .first<{ storage_key: string; original_key: string | null; redacted: number }>();
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

app.get('/v1/usage', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS frames, COALESCE(SUM(bytes),0) AS bytes,
            COUNT(DISTINCT session_id) AS sessions, MIN(captured_at) AS oldest
     FROM frames WHERE user_id = ?`,
  ).bind(c.get('me').userId).first();
  return c.json(row ?? {});
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

/**
 * Delete every object belonging to a frame, from its stored-image key alone.
 *
 * All three variants are derived here rather than read from the row, so a caller cannot
 * forget one. That matters most for the original: it is optional, so nothing would
 * complain if it were left behind — it would simply sit in R2 after its frame was deleted
 * and after the retention window had closed on it, which is the one thing a seven-day
 * promise cannot survive. Deleting a key that does not exist is a no-op, so asking for all
 * three unconditionally is both correct and cheaper than looking up which exist.
 */
export function variantKeys(storageKey: string): string[] {
  return [storageKey, storageKey.replace(/^f\//, 't/'), storageKey.replace(/^f\//, 'o/')];
}

async function deleteObjects(env: Env, keys: string[]): Promise<void> {
  const all = keys.flatMap(variantKeys);
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
  },
};

export { prune };
