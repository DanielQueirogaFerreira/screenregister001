import type { Env, Principal } from './types.js';

/**
 * Device tokens for the anonymous phase.
 *
 * The client already mints a user_id and device_id locally, but those are guessable and
 * would let anyone read anyone else's frames by naming their id. So the server signs the
 * pair and requires the signature back on every request: possession of the token, not
 * knowledge of the id, is what grants access.
 *
 * This is deliberately not an account system — it is the smallest thing that makes the
 * ids unforgeable. Real auth replaces `issue`/`verify` in the accounts phase without the
 * rest of the API changing.
 */

const enc = new TextEncoder();

function devSecret(env: Env): string {
  if (env.AUTH_SECRET) return env.AUTH_SECRET;
  // Local `wrangler dev` has no secret bound. Fail closed in production instead of
  // silently accepting a well-known key.
  return 'dev-only-insecure-secret';
}

async function sign(env: Env, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(devSecret(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function issueToken(env: Env, p: Principal): Promise<string> {
  const payload = `${p.userId}:${p.deviceId}`;
  return `${btoa(payload).replace(/=+$/, '')}.${await sign(env, payload)}`;
}

export async function verifyToken(env: Env, token: string): Promise<Principal | null> {
  const [b64, sig] = token.split('.');
  if (!b64 || !sig) return null;
  let payload: string;
  try {
    payload = atob(b64);
  } catch {
    return null;
  }
  const expected = await sign(env, payload);
  // Constant-time compare: a fast-exit comparison leaks the signature byte by byte.
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;

  const [userId, deviceId] = payload.split(':');
  return userId && deviceId ? { userId, deviceId } : null;
}

export function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1] ?? null;
}
