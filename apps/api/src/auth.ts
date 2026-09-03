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

/** Refuse to mint or accept tokens rather than fall back to a guessable key. */
export class AuthNotConfiguredError extends Error {
  constructor() {
    super(
      'AUTH_SECRET is not configured. Set it before serving traffic: ' +
        'wrangler secret put AUTH_SECRET (production), or put it in apps/api/.dev.vars (local).',
    );
    this.name = 'AuthNotConfiguredError';
  }
}

/** Below this a brute-force search over the key space stops being fanciful. */
const MIN_SECRET_LENGTH = 16;

/**
 * There is deliberately no fallback key.
 *
 * An earlier version returned a hard-coded development secret when AUTH_SECRET was
 * missing, so a deploy that forgot the secret came up signing tokens with a value
 * published in this repository — anyone could mint a token for any user id, and nothing
 * about the running service looked wrong. A missing key is a configuration failure, and
 * the only safe response is to stop, loudly.
 */
export function isAuthConfigured(env: Env): boolean {
  return Boolean(env.AUTH_SECRET && env.AUTH_SECRET.length >= MIN_SECRET_LENGTH);
}

function signingKey(env: Env): string {
  if (!isAuthConfigured(env)) throw new AuthNotConfiguredError();
  return env.AUTH_SECRET!;
}

async function sign(env: Env, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(signingKey(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
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
