/**
 * Password hashing on Workers.
 *
 * bcrypt, scrypt and Argon2 are not available in the Workers runtime and pulling in a WASM
 * build would add a dependency to the most security-critical path in the system. WebCrypto
 * offers PBKDF2-HMAC-SHA256, which is a weaker KDF per unit of CPU than Argon2id — it is
 * cheap to accelerate on a GPU — but it is a real, standard, constant-work KDF, and using
 * the platform primitive beats hand-rolling around one.
 *
 * The honest mitigation for PBKDF2's weakness is a high iteration count and a password
 * policy that keeps the plaintext out of a cracking dictionary in the first place. Both
 * are here. If Argon2id becomes available, `ALGORITHM` and the stored prefix are what let
 * a migration happen without logging anyone out or invalidating stored digests.
 */

const enc = new TextEncoder();

const ALGORITHM = 'pbkdf2-sha256';

/**
 * OWASP's floor for PBKDF2-HMAC-SHA256 is 600,000, and that is what this uses.
 *
 * Measured at ~108ms per hash on Node's WebCrypto; the Workers runtime is the same V8 and
 * BoringSSL, so expect the same order. Cloudflare's published CPU limits are **10ms per
 * request on Workers Free** and **30 seconds by default on Workers Paid**. So this cost is
 * comfortable on paid and impossible on free: a login on the free plan would die with
 * Error 1102, "Worker exceeded resource limits". Accounts therefore require the paid plan,
 * which is documented rather than worked around — lowering the work factor to fit 10ms
 * would mean roughly 50,000 iterations, an order of magnitude under the floor, and a
 * password database that is meaningfully cheaper to crack.
 *
 * The cost is paid only on signup, login and password change. No read path hashes anything.
 */
export const DEFAULT_ITERATIONS = 600_000;

const SALT_BYTES = 16;
const KEY_BITS = 256;

const b64 = (buf: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buf)));

const unb64 = (s: string): Uint8Array =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as BufferSource, iterations },
    key,
    KEY_BITS,
  );
}

/** `pbkdf2-sha256$<iterations>$<salt-b64>$<digest-b64>` */
export async function hashPassword(
  password: string,
  iterations: number = DEFAULT_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const digest = await derive(password, salt, iterations);
  return `${ALGORITHM}$${iterations}$${b64(salt.buffer as ArrayBuffer)}$${b64(digest)}`;
}

export interface VerifyResult {
  valid: boolean;
  /** True when the stored digest used a lower work factor than we now require. */
  needsRehash: boolean;
}

/**
 * Constant-time in the part that matters: the comparison. The work before it is fixed by
 * the stored iteration count, so a wrong password costs the same as a right one.
 */
export async function verifyPassword(password: string, stored: string): Promise<VerifyResult> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== ALGORITHM) return { valid: false, needsRehash: false };

  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) return { valid: false, needsRehash: false };

  let expected: Uint8Array;
  let salt: Uint8Array;
  try {
    salt = unb64(parts[2]!);
    expected = unb64(parts[3]!);
  } catch {
    return { valid: false, needsRehash: false };
  }

  const actual = new Uint8Array(await derive(password, salt, iterations));
  return {
    valid: timingSafeEqual(actual, expected),
    needsRehash: iterations < DEFAULT_ITERATIONS,
  };
}

/** Length is not secret; the bytes are. Compare every byte regardless of early mismatch. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * The weakest 12 characters still beat the strongest 8, so length carries most of the
 * policy. Composition rules are deliberately absent: they push people toward `Passw0rd!`
 * and buy less than the extra characters do.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200; // a KDF is a denial-of-service vector without a cap

/** Blocked outright: these are the first guesses any real attack makes. */
const COMMON = new Set([
  'password', 'password1', 'password123', 'passw0rd', '123456', '1234567890',
  '12345678', '123456789', 'qwerty', 'qwertyuiop', 'letmein', 'welcome',
  'admin', 'administrator', 'iloveyou', 'monkey', 'dragon', 'sunshine',
  'princess', 'football', 'baseball', 'trustno1', 'abc123', 'abcd1234',
  'changeme', 'secret', 'default', 'screenregister', 'screenregister1',
]);

export function validatePassword(password: string, email?: string): string[] {
  const errors: string[] = [];
  if (password.length < MIN_PASSWORD_LENGTH) {
    errors.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    errors.push(`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
  }
  const normalised = password.trim().toLowerCase();
  if (COMMON.has(normalised) || COMMON.has(normalised.replace(/[^a-z]/g, ''))) {
    errors.push('That password is among the most commonly guessed. Choose another.');
  }
  if (/^(.)\1+$/.test(password)) {
    errors.push('A single repeated character is not a password.');
  }
  if (email) {
    const local = email.split('@')[0]?.toLowerCase() ?? '';
    if (local.length >= 3 && normalised.includes(local)) {
      errors.push('Password must not contain your email address.');
    }
  }
  return errors;
}
