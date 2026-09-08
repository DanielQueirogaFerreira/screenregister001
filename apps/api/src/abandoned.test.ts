import { describe, expect, it } from 'vitest';
import { ABANDONED_AFTER_MS, closeAbandoned } from './index.js';

/**
 * The sweep that closes recordings whose browser never did.
 *
 * A session is completed by the browser that made it, so one that was closed, crashed, lost
 * power, or was asked to stop and never heard the request stayed open forever — and the
 * library and operator view showed it as open, indefinitely, for a recording that had ended
 * hours before. Nothing reconciled it. These pin the rule that decides what counts.
 */
function fakeDb(open: { session_id: string; last?: { captured_at: string; hold_ms: number } }[]) {
  const updates: { sql: string; binds: unknown[] }[] = [];
  let selectCutoff: string | null = null;

  return {
    updates,
    get cutoff() { return selectCutoff; },
    prepare(sql: string) {
      const self = {
        _binds: [] as unknown[],
        bind(...binds: unknown[]) { self._binds = binds; return self; },
        async all() {
          if (/FROM sessions/.test(sql)) {
            selectCutoff = String(self._binds[0]);
            return { results: open.map((o) => ({ session_id: o.session_id })) };
          }
          return { results: [] };
        },
        async first() {
          if (/ORDER BY seq DESC/.test(sql)) {
            const row = open.find((o) => o.session_id === self._binds[0]);
            return row?.last ?? null;
          }
          if (/COUNT\(\*\) AS n/.test(sql)) return { n: 3, bytes: 900 };
          return null;
        },
        async run() {
          if (/UPDATE sessions/.test(sql)) updates.push({ sql, binds: self._binds });
          return { meta: { changes: 1 } };
        },
      };
      return self;
    },
  };
}

const env = (db: ReturnType<typeof fakeDb>) => ({ DB: db }) as never;

describe('closing abandoned sessions', () => {
  it('waits far longer than the live window before giving up on one', () => {
    // Dropping out of "recording right now" should be quick — a stale entry there is a lie
    // about the present. Closing the row is irreversible bookkeeping, and a laptop whose
    // lid was shut for five minutes should come back to the recording it left.
    expect(ABANDONED_AFTER_MS).toBe(600_000);
    expect(ABANDONED_AFTER_MS).toBeGreaterThan(45_000 * 10);
  });

  it('looks for sessions that stopped reporting before the cutoff', async () => {
    const db = fakeDb([]);
    await closeAbandoned(env(db));
    const cutoff = Date.parse(db.cutoff!);
    expect(Date.now() - cutoff).toBeGreaterThanOrEqual(ABANDONED_AFTER_MS - 500);
    expect(Date.now() - cutoff).toBeLessThan(ABANDONED_AFTER_MS + 5000);
  });

  it('ends a session at its last frame, not at the moment it was noticed', async () => {
    // A laptop closed on Friday and reopened on Monday did not record for three days.
    const captured = '2026-09-08T01:00:00.000Z';
    const db = fakeDb([{ session_id: 's1', last: { captured_at: captured, hold_ms: 4000 } }]);
    await closeAbandoned(env(db));

    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]!.binds[0]).toBe('2026-09-08T01:00:04.000Z');
  });

  it('falls back to the session start when it stored nothing at all', async () => {
    // COALESCE(?, started_at) in the statement: there is no moment the recording reached,
    // so the only honest end is the moment it began, and it shows as zero length.
    const db = fakeDb([{ session_id: 's1' }]);
    await closeAbandoned(env(db));
    expect(db.updates[0]!.binds[0]).toBeNull();
    expect(db.updates[0]!.sql).toContain('COALESCE(?, started_at)');
  });

  it('clears any stop request it was never going to answer', async () => {
    // The row got here because a stop was asked for and nothing collected it. Leaving the
    // request set would make a reused id look like it had one pending.
    const db = fakeDb([{ session_id: 's1' }]);
    await closeAbandoned(env(db));
    expect(db.updates[0]!.sql).toContain('stop_requested_at = NULL');
  });

  it('only ever closes a row that is still open', async () => {
    const db = fakeDb([{ session_id: 's1' }]);
    await closeAbandoned(env(db));
    expect(db.updates[0]!.sql).toContain('ended_at IS NULL');
  });

  it('closes each one it finds, and says how many', async () => {
    const db = fakeDb([{ session_id: 'a' }, { session_id: 'b' }, { session_id: 'c' }]);
    expect(await closeAbandoned(env(db))).toBe(3);
    expect(db.updates).toHaveLength(3);
  });

  it('does nothing, quietly, when there is nothing to close', async () => {
    const db = fakeDb([]);
    expect(await closeAbandoned(env(db))).toBe(0);
    expect(db.updates).toEqual([]);
  });
});
