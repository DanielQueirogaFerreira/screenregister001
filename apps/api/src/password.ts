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

const ALGORITHM = 'pbkdf2-sha256-chain';

/**
 * The Workers runtime refuses more than this in a single PBKDF2 call:
 *
 *   Pbkdf2 failed: iteration counts above 100000 are not supported (requested 600000).
 *
 * Discovered in production, not locally — `workerd` under `wrangler dev` does **not**
 * enforce the cap, so a full local end-to-end suite passed while every real signup
 * returned 500. That divergence is the reason `probeKdf` exists in status.ts and why the
 * test below asserts the per-call count rather than only the total.
 */
export const MAX_ITERATIONS_PER_CALL = 100_000;

/**
 * OWASP's floor for PBKDF2-HMAC-SHA256. Above the platform's per-call cap, so it is
 * reached by chaining instead.
 */
export const TOTAL_ITERATIONS = 600_000;

export const ROUNDS = TOTAL_ITERATIONS / MAX_ITERATIONS_PER_CALL;

/**
 * Six chained PBKDF2 calls, each of 100,000 iterations, feeding one output into the next
 * as the input key.
 *
 * The attacker's cost is what a work factor buys, and that is unchanged: recovering the
 * password still requires 600,000 HMAC-SHA256 iterations per guess, because every round
 * must be computed in order. It is not bit-identical to a single 600,000-iteration call —
 * PBKDF2 XORs its internal chain — but it is the same amount of unavoidable serial work,
 * which is the property being bought.
 *
 * Argon2id would be better on every axis and does not exist in this runtime. That remains
 * the honest limitation; chaining recovers the iteration count, not the memory hardness.
 */
async function deriveChained(
  password: string, salt: Uint8Array, perRound: number, rounds: number,
): Promise<ArrayBuffer> {
  let input: BufferSource = enc.encode(password);
  let out: ArrayBuffer = new ArrayBuffer(0);
  for (let i = 0; i < rounds; i++) {
    const key = await crypto.subtle.importKey('raw', input, 'PBKDF2', false, ['deriveBits']);
    out = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as BufferSource, iterations: perRound },
      key,
      KEY_BITS,
    );
    input = out;
  }
  return out;
}

const SALT_BYTES = 16;
const KEY_BITS = 256;

const b64 = (buf: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buf)));

const unb64 = (s: string): Uint8Array =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** `pbkdf2-sha256-chain$<rounds>x<iterationsPerRound>$<salt-b64>$<digest-b64>` */
export async function hashPassword(
  password: string,
  perRound: number = MAX_ITERATIONS_PER_CALL,
  rounds: number = ROUNDS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const digest = await deriveChained(password, salt, perRound, rounds);
  return `${ALGORITHM}$${rounds}x${perRound}$${b64(salt.buffer as ArrayBuffer)}$${b64(digest)}`;
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

  const [roundsRaw, perRoundRaw] = (parts[1] ?? '').split('x');
  const rounds = Number(roundsRaw);
  const perRound = Number(perRoundRaw);
  if (!Number.isInteger(rounds) || rounds < 1 || !Number.isInteger(perRound) || perRound < 1) {
    return { valid: false, needsRehash: false };
  }

  let expected: Uint8Array;
  let salt: Uint8Array;
  try {
    salt = unb64(parts[2]!);
    expected = unb64(parts[3]!);
  } catch {
    return { valid: false, needsRehash: false };
  }

  const actual = new Uint8Array(await deriveChained(password, salt, perRound, rounds));
  return {
    valid: timingSafeEqual(actual, expected),
    needsRehash: rounds * perRound < TOTAL_ITERATIONS,
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
