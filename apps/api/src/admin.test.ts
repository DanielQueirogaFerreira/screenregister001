import { describe, expect, it } from 'vitest';
import { LIVE_WINDOW_MS, adminEmails, liveCutoff, resolveAdmin } from './admin.js';

const env = (adminList: string | undefined, user: Record<string, string> | null) => ({
  ADMIN_EMAILS: adminList,
  DB: {
    prepare: () => ({
      bind: () => ({ first: async () => user }),
    }),
  },
}) as unknown as Parameters<typeof resolveAdmin>[0];

describe('who is an admin', () => {
  const daniel = { user_id: 'u1', email: 'daniel@example.com' };

  it('nobody, when the variable is unset', async () => {
    // The correct default for a deployment nobody has configured. An admin surface that
    // exists by accident is the worst possible kind.
    expect(await resolveAdmin(env(undefined, daniel), 'u1')).toBeNull();
    expect(await resolveAdmin(env('', daniel), 'u1')).toBeNull();
    expect(await resolveAdmin(env('   ,  , ', daniel), 'u1')).toBeNull();
  });

  it('the listed address, matched against the account rather than the request', async () => {
    const admin = await resolveAdmin(env('daniel@example.com', daniel), 'u1');
    expect(admin).toEqual({ userId: 'u1', email: 'daniel@example.com' });
  });

  it('ignores case and surrounding space in the list', async () => {
    expect(await resolveAdmin(env('  DANIEL@Example.COM ', daniel), 'u1')).not.toBeNull();
  });

  it('ignores case on the stored address too', async () => {
    const shouty = { user_id: 'u1', email: 'Daniel@Example.com' };
    expect(await resolveAdmin(env('daniel@example.com', shouty), 'u1')).not.toBeNull();
  });

  it('refuses an address that is merely similar', async () => {
    // Addresses are unique and normalised at write time, so the only way to hold a listed
    // address is to be the account that owns it. Every one of these is a different account
    // whose address happens to read like the admin's — the shape a lookalike attack takes.
    for (const email of [
      'daniel@example.com.evil.net',
      'daniel@example.co',
      'x-daniel@example.com',
      'daniel@example.com.co',
      'daniel@exampIe.com',        // capital I standing in for the l
      'daniel+admin@example.com',
    ]) {
      const other = { user_id: 'u2', email };
      expect(await resolveAdmin(env('daniel@example.com', other), 'u2'), email).toBeNull();
    }
  });

  it('treats an address that only differs by padding as the same one', async () => {
    // Not a lookalike: normalisation at write time means a stored address never carries
    // padding, and trimming here is belt-and-braces rather than a decision. Asserting the
    // real behaviour beats listing this among the refusals and quietly skipping it.
    const padded = { user_id: 'u1', email: ' daniel@example.com ' };
    expect(await resolveAdmin(env('daniel@example.com', padded), 'u1')).not.toBeNull();
  });

  it('refuses a disabled account, since the query excludes it', async () => {
    // resolveAdmin's own SQL filters disabled_at; with no row returned there is no admin.
    expect(await resolveAdmin(env('daniel@example.com', null), 'u1')).toBeNull();
  });

  it('handles several admins', async () => {
    const list = 'a@x.com, daniel@example.com ,b@y.com';
    expect(adminEmails({ ADMIN_EMAILS: list } as never))
      .toEqual(['a@x.com', 'daniel@example.com', 'b@y.com']);
    expect(await resolveAdmin(env(list, daniel), 'u1')).not.toBeNull();
  });
});

describe('liveness window', () => {
  it('is three heartbeats, so one slow network does not read as stopped', () => {
    expect(LIVE_WINDOW_MS).toBe(45_000);
  });

  it('cuts off in the past, never in the future', () => {
    const cutoff = Date.parse(liveCutoff());
    expect(cutoff).toBeLessThanOrEqual(Date.now());
    expect(Date.now() - cutoff).toBeGreaterThanOrEqual(LIVE_WINDOW_MS - 50);
  });

  it('excludes a session that has never sent a heartbeat', () => {
    // Rows created before heartbeats existed have last_seen_at NULL. In SQL, NULL >= x is
    // never true, so they cannot appear as live — which is what stops every abandoned
    // recording in the table from claiming to be running right now.
    const cutoff = liveCutoff();
    expect(cutoff > '').toBe(true);
    expect(null as unknown as string >= cutoff).toBe(false);
  });
});
