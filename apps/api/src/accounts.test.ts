import { describe, expect, it } from 'vitest';
import type { Env } from './types.js';
import {
  MAX_FAILED_ATTEMPTS, hashToken, isLocked, isPlausibleEmail, newToken,
  normaliseEmail, rateLimit, readCookie, sessionCookie, clearedCookie, type UserRow,
} from './accounts.js';
import { csrfOk, isReadOnly } from './auth-routes.js';

/**
 * A D1 stand-in backed by a Map. Enough for the rate limiter, which is the one piece of
 * account logic with real state and a boundary worth pinning down.
 */
function fakeDb() {
  const rows = new Map<string, { count: number; window_start: string }>();
  const db = {
    prepare(sql: string) {
      const stmt = {
        args: [] as unknown[],
        bind(...args: unknown[]) { stmt.args = args; return stmt; },
        async first<T>() {
          if (/SELECT count, window_start FROM rate_limits/.test(sql)) {
            return (rows.get(String(stmt.args[0])) ?? null) as T | null;
          }
          return null as T | null;
        },
        async run() {
          if (/INSERT INTO rate_limits/.test(sql)) {
            rows.set(String(stmt.args[0]), { count: 1, window_start: String(stmt.args[1]) });
          } else if (/UPDATE rate_limits SET count/.test(sql)) {
            const key = String(stmt.args[1]);
            const row = rows.get(key);
            if (row) row.count = Number(stmt.args[0]);
          }
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return { env: { DB: db } as unknown as Env, rows };
}

describe('email normalisation', () => {
  it('folds case and whitespace so one address cannot become two accounts', () => {
    expect(normaliseEmail('  Daniel@Example.COM ')).toBe('daniel@example.com');
  });

  it('accepts real addresses and rejects obvious nonsense', () => {
    for (const good of ['a@b.co', 'daniel.queiroga+tag@example.com', 'x_y@sub.domain.org']) {
      expect(isPlausibleEmail(good)).toBe(true);
    }
    for (const bad of ['', 'no-at-sign', 'a@b', 'a@@b.com', 'has space@b.com', `${'x'.repeat(250)}@b.com`]) {
      expect(isPlausibleEmail(bad)).toBe(false);
    }
  });
});

describe('tokens', () => {
  it('are long, random and never repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, () => newToken()));
    expect(seen.size).toBe(200);
    expect([...seen][0]!.length).toBeGreaterThanOrEqual(40);
  });

  it('hash deterministically, so a stored hash can match without storing the token', async () => {
    const token = newToken();
    expect(await hashToken(token)).toBe(await hashToken(token));
    expect(await hashToken(token)).not.toBe(await hashToken(newToken()));
    // A hash, not the value: 64 hex characters and nothing replayable.
    expect(await hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('session cookie', () => {
  it('is HttpOnly and SameSite=Strict, which is what stops XSS and CSRF', () => {
    const cookie = sessionCookie('abc123', true);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/');
  });

  it('omits Secure only when not served over https, so wrangler dev still works', () => {
    expect(sessionCookie('abc', false)).not.toContain('Secure');
  });

  it('clears with an immediate expiry', () => {
    expect(clearedCookie(true)).toContain('Max-Age=0');
  });

  it('reads its own value back out of a crowded Cookie header', () => {
    expect(readCookie('a=1; sr_session=tok3n; b=2', 'sr_session')).toBe('tok3n');
    expect(readCookie('a=1; b=2', 'sr_session')).toBeNull();
    expect(readCookie(undefined, 'sr_session')).toBeNull();
    // Base64url values contain '=' padding in other encodings; do not truncate at the first.
    expect(readCookie('sr_session=a=b=c', 'sr_session')).toBe('a=b=c');
  });
});

describe('CSRF origin check', () => {
  const req = (method: string, origin?: string): Request =>
    new Request('https://app.example.com/v1/frames', {
      method,
      ...(origin ? { headers: { Origin: origin } } : {}),
    });

  it('allows reads without an Origin', () => {
    expect(csrfOk(req('GET'), 'cookie')).toBe(true);
  });

  it('allows a same-origin write', () => {
    expect(csrfOk(req('POST', 'https://app.example.com'), 'cookie')).toBe(true);
  });

  it('blocks a cross-origin write', () => {
    expect(csrfOk(req('POST', 'https://evil.example.net'), 'cookie')).toBe(false);
    // A lookalike host must not pass on a prefix match.
    expect(csrfOk(req('POST', 'https://app.example.com.evil.net'), 'cookie')).toBe(false);
  });

  it('blocks a write with no Origin at all', () => {
    // Browsers always send Origin on state-changing requests; its absence is suspicious,
    // so this fails closed rather than trusting it.
    expect(csrfOk(req('POST'), 'cookie')).toBe(false);
  });

  it('exempts API tokens, which carry no ambient credential to abuse', () => {
    expect(csrfOk(req('POST'), 'api_token')).toBe(true);
    expect(csrfOk(req('POST', 'https://evil.example.net'), 'api_token')).toBe(true);
  });
});

describe('account lockout', () => {
  const user = (over: Partial<UserRow> = {}): UserRow => ({
    user_id: 'u1', email: 'a@b.co', email_verified_at: null, password_hash: 'x',
    created_at: '', updated_at: '', disabled_at: null, failed_attempts: 0,
    locked_until: null, ...over,
  });

  it('is not locked without a lock time', () => {
    expect(isLocked(user())).toBe(false);
  });

  it('is locked while the lock is in the future and free once it passes', () => {
    expect(isLocked(user({ locked_until: new Date(Date.now() + 60_000).toISOString() }))).toBe(true);
    expect(isLocked(user({ locked_until: new Date(Date.now() - 1000).toISOString() }))).toBe(false);
  });

  it('locks well before a password is realistically guessable', () => {
    expect(MAX_FAILED_ATTEMPTS).toBeLessThanOrEqual(10);
  });
});

describe('rate limiting', () => {
  it('allows up to the limit and refuses past it', async () => {
    const { env } = fakeDb();
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await rateLimit(env, 'login:1.2.3.4', 3, 60_000));

    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
    expect(results[2]!.remaining).toBe(0);
    expect(results[3]!.retryAfterSec).toBeGreaterThan(0);
  });

  it('starts a fresh window once the old one has passed', async () => {
    const { env, rows } = fakeDb();
    for (let i = 0; i < 4; i++) await rateLimit(env, 'b', 2, 60_000);
    expect((await rateLimit(env, 'b', 2, 60_000)).allowed).toBe(false);

    // Age the window past its length.
    const row = rows.get('b')!;
    row.window_start = new Date(Date.now() - 120_000).toISOString();

    expect((await rateLimit(env, 'b', 2, 60_000)).allowed).toBe(true);
  });

  it('keeps buckets independent, so one address cannot exhaust another', async () => {
    const { env } = fakeDb();
    for (let i = 0; i < 5; i++) await rateLimit(env, 'login:attacker', 2, 60_000);
    expect((await rateLimit(env, 'login:victim', 2, 60_000)).allowed).toBe(true);
  });
});

describe('read-token scope', () => {
  it('allows reads by method', () => {
    expect(isReadOnly('GET', '/v1/sessions')).toBe(true);
    expect(isReadOnly('HEAD', '/v1/frames/x/image')).toBe(true);
  });

  it('blocks writes by method', () => {
    expect(isReadOnly('POST', '/v1/frames')).toBe(false);
    expect(isReadOnly('DELETE', '/v1/data')).toBe(false);
    expect(isReadOnly('PUT', '/v1/sessions/x')).toBe(false);
    expect(isReadOnly('PATCH', '/v1/frames/x')).toBe(false);
  });

  it('permits POST to /mcp, which is JSON-RPC and read-only today', () => {
    // Judging MCP by method would make a read token useless for the one client that most
    // needs to be read-only. Every tool the server exposes is a read.
    expect(isReadOnly('POST', '/mcp')).toBe(true);
  });

  it('does not extend that exemption to lookalike paths', () => {
    expect(isReadOnly('POST', '/mcp/admin')).toBe(false);
    expect(isReadOnly('POST', '/v1/mcp')).toBe(false);
  });
});
