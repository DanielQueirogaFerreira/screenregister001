import type { Env } from './types.js';
import { isAuthConfigured } from './auth.js';
import { mailConfigured } from './mailer.js';

/**
 * The facts /v1/health reports, in one place.
 *
 * They are computed here rather than inline in the route because the status dashboard
 * shows the same facts, and two copies of "is this deployment configured correctly" drift
 * — which is worse than not showing them at all, since the dashboard is where someone
 * looks when they already suspect something is wrong.
 */

export interface HealthFacts {
  ok: boolean;
  service: 'screenregister-api';
  schema: 'ready' | 'missing' | 'error';
  retention_days: number;
  auth_configured: boolean;
  cors_localhost: boolean;
  email_configured: boolean;
  hint?: string;
  auth_hint?: string;
}

const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/** Opt-in, and only an exact "true" counts — an unset or malformed value stays off. */
export const localhostAllowed = (env: Env): boolean =>
  (env.ALLOW_LOCALHOST_ORIGINS ?? '').trim().toLowerCase() === 'true';

export const isLocalhostOrigin = (origin: string): boolean => LOCALHOST_ORIGIN.test(origin);

/**
 * Liveness plus the two things a fresh deploy most often lacks.
 *
 * The Worker deploys happily without a D1 schema or an AUTH_SECRET, and then fails at
 * request time with errors that point nowhere near the cause — "no such table: frames"
 * says nothing about migrations never having been run.
 *
 * `auth_configured` reports only whether the Worker will serve authenticated traffic at
 * all. It deliberately does not distinguish "no key" from "key too weak": this is served
 * unauthenticated, and telling an anonymous caller that the signing key exists but is
 * brute-forceable is precisely the hint not to publish.
 */
export async function healthFacts(env: Env): Promise<HealthFacts> {
  let schema: HealthFacts['schema'] = 'ready';
  try {
    await env.DB.prepare('SELECT 1 FROM frames LIMIT 1').all();
  } catch (err) {
    schema = /no such table/i.test(String(err)) ? 'missing' : 'error';
  }
  const authConfigured = isAuthConfigured(env);

  return {
    ok: schema === 'ready' && authConfigured,
    service: 'screenregister-api',
    schema,
    // The policy the nightly sweep enforces. Not a secret, and the client must not print
    // a retention promise it invented locally.
    retention_days: Number(env.RETENTION_DAYS || '7'),
    auth_configured: authConfigured,
    cors_localhost: localhostAllowed(env),
    // Whether self-service verification and password reset can actually deliver. Not a
    // secret, and a signup flow that silently cannot email is worth surfacing.
    email_configured: mailConfigured(env),
    ...(schema === 'missing' && {
      hint: 'Run the D1 migrations: wrangler d1 migrations apply screenregister001 --remote',
    }),
    ...(!authConfigured && {
      auth_hint: 'AUTH_SECRET is missing or too short, so the Worker refuses to issue or ' +
        'accept tokens and every authenticated route returns 503. Set it: ' +
        'wrangler secret put AUTH_SECRET',
    }),
  };
}
