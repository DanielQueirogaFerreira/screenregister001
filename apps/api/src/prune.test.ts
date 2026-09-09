import { describe, expect, it } from 'vitest';
import { prune } from './index.js';

/**
 * The retention sweep, and the limit that made it destroy images without clearing their
 * rows.
 *
 * D1 refuses a query carrying more than 100 bound parameters. The sweep selected 500
 * frames and then bound one parameter per frame to delete them, so the delete threw every
 * time — after the R2 objects for those 500 had already gone. The result was 500 frames of
 * images destroyed and 500 rows left pointing at nothing, per attempt, silently, because
 * the sweep runs on a cron and its exception went nowhere.
 *
 * It survived review because it never ran on a non-empty set: retention is seven days and
 * the deployment was younger than that, so every nightly sweep had zero rows to delete.
 * The first time it was asked to do real work was a purge.
 */
function fakeDb(frames: { frame_id: string; storage_key: string }[]) {
  const deleteBinds: unknown[][] = [];
  return {
    deleteBinds,
    remaining: () => frames.length,
    prepare(sql: string) {
      const self = {
        _binds: [] as unknown[],
        bind(...binds: unknown[]) {
          // D1's real limit, enforced here so the test fails the way production did.
          if (binds.length > 100) {
            throw new Error('too many SQL variables at offset 229: SQLITE_ERROR');
          }
          self._binds = binds;
          return self;
        },
        async all() {
          const m = /LIMIT (\d+)/.exec(sql);
          return { results: frames.slice(0, Number(m?.[1] ?? 0)) };
        },
        async run() {
          if (/DELETE FROM frames/.test(sql)) {
            deleteBinds.push(self._binds);
            const gone = new Set(self._binds.map(String));
            frames = frames.filter((f) => !gone.has(f.frame_id));
          }
          return { meta: { changes: 1 } };
        },
      };
      return self;
    },
  };
}

function fakeBucket() {
  const deleted: string[] = [];
  return { deleted, async delete(keys: string[] | string) { deleted.push(...[keys].flat()); } };
}

const many = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    frame_id: `f${i}`,
    storage_key: `f/u/s/f${i}.webp`,
  }));

describe('retention sweep', () => {
  it('never binds more parameters than D1 will accept', async () => {
    const db = fakeDb(many(450));
    const FRAMES = fakeBucket();
    const removed = await prune({ DB: db, FRAMES, RETENTION_DAYS: '0' } as never);

    expect(removed).toBe(450);
    expect(db.remaining()).toBe(0);
    for (const binds of db.deleteBinds) expect(binds.length).toBeLessThanOrEqual(100);
  });

  it('deletes all three variants of every frame it removes', async () => {
    const db = fakeDb(many(5));
    const FRAMES = fakeBucket();
    await prune({ DB: db, FRAMES, RETENTION_DAYS: '0' } as never);

    // Stored image, thumbnail, and the optional untouched original — asked for
    // unconditionally, because deleting a key that is not there costs nothing and
    // forgetting one leaves it in R2 after the retention window has closed.
    expect(FRAMES.deleted).toHaveLength(15);
    expect(FRAMES.deleted).toContain('f/u/s/f0.webp');
    expect(FRAMES.deleted).toContain('t/u/s/f0.webp');
    expect(FRAMES.deleted).toContain('o/u/s/f0.webp');
  });

  it('stops after the batches it was given, leaving the rest for the next run', async () => {
    // Purge mode passes a bound so one invocation cannot run past the platform's limit and
    // lose the work it has done. What it does not finish, the next cron picks up.
    const db = fakeDb(many(450));
    const FRAMES = fakeBucket();
    const removed = await prune({ DB: db, FRAMES, RETENTION_DAYS: '0' } as never, 2);

    expect(removed).toBe(180);
    expect(db.remaining()).toBe(270);
  });

  it('deletes the object before the row, so a failure never orphans an image', async () => {
    // The order matters and only in one direction. A row deleted first leaves an object
    // in R2 that nothing names any more, so nothing will ever delete it. An object deleted
    // first leaves a row a retry can clear.
    const order: string[] = [];
    const db = fakeDb(many(3));
    const inner = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      const st = inner(sql);
      const run = st.run.bind(st);
      st.run = async () => { order.push('row'); return run(); };
      return st;
    };
    const FRAMES = {
      deleted: [] as string[],
      async delete(keys: string[] | string) { order.push('object'); this.deleted.push(...[keys].flat()); },
    };
    await prune({ DB: db, FRAMES, RETENTION_DAYS: '0' } as never);

    expect(order.indexOf('object')).toBeLessThan(order.indexOf('row'));
  });
});
