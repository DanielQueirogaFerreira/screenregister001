import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ITERATIONS, MIN_PASSWORD_LENGTH, hashPassword, timingSafeEqual, validatePassword,
  verifyPassword,
} from './password.js';

// The real work factor costs ~100ms per hash. These tests exercise the format and the
// decisions, not the KDF's strength, so most of them run at a low count deliberately.
const FAST = 1000;

describe('password hashing', () => {
  it('accepts the right password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse battery staple', FAST);
    expect((await verifyPassword('correct horse battery staple', stored)).valid).toBe(true);
    expect((await verifyPassword('correct horse battery stapl', stored)).valid).toBe(false);
    expect((await verifyPassword('', stored)).valid).toBe(false);
  });

  it('salts, so the same password never produces the same digest twice', async () => {
    const a = await hashPassword('the same password', FAST);
    const b = await hashPassword('the same password', FAST);
    expect(a).not.toEqual(b);
    // Both still verify: the salt travels with the digest.
    expect((await verifyPassword('the same password', a)).valid).toBe(true);
    expect((await verifyPassword('the same password', b)).valid).toBe(true);
  });

  it('records its work factor so it can be raised without a mass reset', async () => {
    const old = await hashPassword('a long enough passphrase', FAST);
    expect(old.startsWith(`pbkdf2-sha256$${FAST}$`)).toBe(true);

    const result = await verifyPassword('a long enough passphrase', old);
    expect(result.valid).toBe(true);
    // Below the current default, so login should transparently rehash it.
    expect(result.needsRehash).toBe(true);
  });

  it('does not ask for a rehash at the current work factor', async () => {
    const stored = `pbkdf2-sha256$${DEFAULT_ITERATIONS}$${btoa('0123456789abcdef')}$${btoa('x'.repeat(32))}`;
    const result = await verifyPassword('anything', stored);
    expect(result.needsRehash).toBe(false);
  });

  it('rejects a malformed or foreign digest instead of throwing', async () => {
    for (const bad of ['', 'nonsense', 'bcrypt$12$abc$def', 'pbkdf2-sha256$abc$x$y', 'a$b$c']) {
      await expect(verifyPassword('pw', bad)).resolves.toEqual({ valid: false, needsRehash: false });
    }
  });
});

describe('timingSafeEqual', () => {
  it('compares by value', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it('does not short-circuit on the first differing byte', () => {
    // A mismatch at the start and one at the end must both be detected; an early return
    // would still be correct here but is what the loop exists to avoid.
    const a = new Uint8Array(64).fill(7);
    const early = new Uint8Array(64).fill(7); early[0] = 9;
    const late = new Uint8Array(64).fill(7); late[63] = 9;
    expect(timingSafeEqual(a, early)).toBe(false);
    expect(timingSafeEqual(a, late)).toBe(false);
  });
});

describe('password policy', () => {
  it('requires length over composition', () => {
    expect(validatePassword('Sh0rt!')).toContain(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
    // No digits, no symbols, no capitals — and fine, because it is long.
    expect(validatePassword('correct horse battery staple')).toEqual([]);
  });

  it('blocks the passwords an attack guesses first', () => {
    expect(validatePassword('password123').length).toBeGreaterThan(0);
    expect(validatePassword('qwertyuiop').length).toBeGreaterThan(0);
    expect(validatePassword('screenregister').length).toBeGreaterThan(0);
  });

  it('rejects a single repeated character', () => {
    expect(validatePassword('aaaaaaaaaaaaaaa')).toContain('A single repeated character is not a password.');
  });

  it('rejects a password containing the email local part', () => {
    expect(validatePassword('danielqueiroga2026', 'danielqueiroga@example.com'))
      .toContain('Password must not contain your email address.');
    // A short local part is not distinctive enough to be worth blocking on.
    expect(validatePassword('abcdefghijkl', 'ab@example.com')).toEqual([]);
  });

  it('caps length, because a KDF over unbounded input is a denial-of-service vector', () => {
    expect(validatePassword('x'.repeat(5000)).length).toBeGreaterThan(0);
  });
});
