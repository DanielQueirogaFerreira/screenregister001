import { describe, expect, it } from 'vitest';
import { app } from './index.js';

/**
 * These dispatch real requests through the whole app rather than calling handlers directly.
 *
 * What prompted them: the operator routes were registered above their own
 * `app.use('/v1/admin/*', requireAuth)` line. Hono runs middleware registered before the
 * matched handler, so the guard never ran, `c.get('me')` was undefined, and reading
 * `.userId` off it threw — a 500 where a refusal belonged. It failed closed by accident,
 * which is not the same as being closed.
 *
 * An honest note about what these do and do not prove. Removing the guard again does NOT
 * make them fail, and they were checked against that. The protection is `adminOnly`
 * establishing the caller itself instead of trusting middleware to have run, which makes
 * the registration order stop mattering for correctness — so no black-box test can tell
 * the two arrangements apart, and one claiming to would be lying.
 *
 * What they do pin down is the outcome that was wrong: these routes refuse an
 * unauthenticated caller and never answer by throwing. That holds however the file is
 * later rearranged, which is the property actually worth keeping.
 *
 * The other half — that a signed-in ordinary account gets 404 rather than data — needs a
 * real session and lives in the production smoke test. That is where this bug surfaced.
 */

const env = () => ({
  ADMIN_EMAILS: undefined,
  AUTH_SECRET: 'x'.repeat(48),
  DB: {
    prepare: () => ({
      bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 0 } }) }),
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({ meta: { changes: 0 } }),
    }),
  },
  FRAMES: {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
  },
}) as never;

const ADMIN_ROUTES: [string, string][] = [
  ['GET', '/v1/admin/overview'],
  ['GET', '/v1/admin/users'],
  ['GET', '/v1/admin/events'],
  ['POST', '/v1/admin/sessions/abc/request-stop'],
  ['DELETE', '/v1/admin/sessions/abc'],
];

describe('operator routes', () => {
  it('refuse an unauthenticated caller, and never with a 500', async () => {
    for (const [method, path] of ADMIN_ROUTES) {
      const res = await app.request(path, { method }, env());
      expect([401, 403], `${method} ${path} -> ${res.status}`).toContain(res.status);
      // A 500 means something threw where a refusal belonged — the shape the ordering bug
      // took. Whatever the cause, an access check that answers by crashing is a bug.
      expect(res.status, `${method} ${path} threw instead of refusing`).not.toBe(500);
    }
  });

  it('refuse identically, so a new route cannot answer differently by accident', async () => {
    // Checked against the mutation: dropping adminOnly from one route does not fail this,
    // because an unauthenticated caller is stopped by requireAuth either way. What proves
    // the adminOnly gate is a request from a real signed-in NON-admin, and that lives in
    // the production smoke test — which is where this bug was actually caught, as a 500
    // instead of a 404. These tests cover the half that can be reached without a session.
    const statuses = await Promise.all(
      ADMIN_ROUTES.map(async ([method, path]) =>
        (await app.request(path, { method }, env())).status),
    );
    expect(new Set(statuses).size, `mixed responses: ${statuses.join(', ')}`).toBe(1);
    expect(statuses[0]).toBe(401);
  });

  it('leave the public routes public', async () => {
    // The guard must not have crept wider than intended: the status page and health are
    // reachable precisely when authentication is the thing that is broken.
    for (const path of ['/v1/health', '/v1/status']) {
      const res = await app.request(path, {}, env());
      expect(res.status, path).toBe(200);
    }
  });

  it('answer an unknown API path with JSON rather than the app shell', async () => {
    const res = await app.request('/v1/nonsense', {}, {
      ...(env() as object), ASSETS: { fetch: async () => new Response('shell') },
    } as never);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});
