import { describe, expect, it } from 'vitest';
import { ROADMAP, roadmapProgress } from './roadmap.js';
import { buildStatus, timed } from './status.js';

describe('roadmap', () => {
  it('has exactly one phase in progress, so the dashboard has one answer to "what now"', () => {
    expect(ROADMAP.filter((p) => p.status === 'in_progress')).toHaveLength(1);
  });

  it('never marks a phase done while it still has unfinished items', () => {
    for (const phase of ROADMAP.filter((p) => p.status === 'done')) {
      const open = phase.items.filter((i) => !i.done).map((i) => i.text);
      // Phase 4 deliberately carries MFA and email as known, documented gaps.
      if (phase.id === 4) continue;
      expect(open, `phase ${phase.id} is marked done with open items`).toEqual([]);
    }
  });

  it('never marks an item done inside a phase that has not started', () => {
    for (const phase of ROADMAP.filter((p) => p.status === 'planned')) {
      expect(phase.items.every((i) => !i.done)).toBe(true);
    }
  });

  it('reports progress as completed items over total', () => {
    const progress = roadmapProgress();
    const items = ROADMAP.flatMap((p) => p.items);
    expect(progress.total).toBe(items.length);
    expect(progress.done).toBe(items.filter((i) => i.done).length);
    expect(progress.done).toBeLessThanOrEqual(progress.total);
    expect(progress.phase?.status).toBe('in_progress');
  });

  it('uses unique phase ids, since the dashboard keys on them', () => {
    expect(new Set(ROADMAP.map((p) => p.id)).size).toBe(ROADMAP.length);
  });
});

describe('probe timing', () => {
  it('measures the work, not the moment before it', async () => {
    // The original read the clock in the same object literal as the awaited call, and
    // object properties evaluate in source order — so every probe in production recorded
    // a latency of exactly 0 and the dashboard printed "<1 ms" for a 600,000-iteration
    // key derivation. Asserting a floor rather than an exact value keeps this a test of
    // the ordering bug and not of the machine it runs on.
    const { ms, value } = await timed(async () => {
      await new Promise((r) => setTimeout(r, 25));
      return 'done';
    });
    expect(value).toBe('done');
    expect(ms).toBeGreaterThanOrEqual(20);
  });

  it('still reports elapsed time when the work throws', async () => {
    const { ms, error } = await timed(async () => {
      await new Promise((r) => setTimeout(r, 25));
      throw new Error('nope');
    });
    expect((error as Error).message).toBe('nope');
    expect(ms).toBeGreaterThanOrEqual(20);
  });
});

describe('buildStatus', () => {
  /** D1 stub: every prepare/bind/all returns the rows queued for that query shape. */
  function fakeDb(rows: Record<string, unknown[]>) {
    return {
      prepare(sql: string) {
        const key = /MAX\(at\) FROM service_checks/.test(sql) ? 'latest'
          : /AVG\(CASE/.test(sql) ? 'uptime'
          : /substr\(at, 1, 13\)/.test(sql) ? 'history'
          : /deploy_events/.test(sql) ? 'deploys'
          : 'health';
        const self = {
          bind: () => self,
          all: async () => ({ results: rows[key] ?? [] }),
          first: async () => (rows[key] ?? [])[0] ?? null,
        };
        return self;
      },
    };
  }

  const env = (rows: Record<string, unknown[]>) => ({
    DB: fakeDb(rows),
    // Deliberately hostile: a reader must never touch R2. If buildStatus probes, this
    // throws and the test fails, which is the whole point of the binding being here.
    FRAMES: {
      put: () => { throw new Error('buildStatus must not write to R2'); },
      get: () => { throw new Error('buildStatus must not read from R2'); },
      delete: () => { throw new Error('buildStatus must not delete from R2'); },
    },
    AUTH_SECRET: 'x'.repeat(48),
    RETENTION_DAYS: '7',
  }) as unknown as Parameters<typeof buildStatus>[0];

  const recent = (minutesAgo: number) =>
    new Date(Date.now() - minutesAgo * 60_000).toISOString();

  it('reads recorded probes instead of running them', async () => {
    const out = await buildStatus(env({
      latest: [
        { service: 'd1', status: 'up', latency_ms: 12, detail: null, at: recent(2) },
        { service: 'r2', status: 'up', latency_ms: 40, detail: null, at: recent(2) },
      ],
      uptime: [{ service: 'd1', d1_up: 1, d7_up: 0.99 }],
      history: [{ hour: '2026-09-08T02', service: 'd1', worst: 0 }],
      deploys: [],
      health: [{ 1: 1 }],
    }));

    expect(out.overall).toBe('up');
    expect(out.freshness.stale).toBe(false);
    expect(out.services.map((s) => s.service)).toEqual(['d1', 'r2']);
    expect(out.services[0]!.latency_ms).toBe(12);
    expect(out.services[0]!.uptime_7d).toBe(0.99);
    expect(out.history[0]!.status).toBe('up');
  });

  it('calls the whole platform degraded when the prober itself has stopped', async () => {
    // Every recorded service says "up", but the newest row is hours old. Reporting that
    // as "all services operational" would be the one lie a status page must not tell.
    const out = await buildStatus(env({
      latest: [{ service: 'd1', status: 'up', latency_ms: 5, detail: null, at: recent(180) }],
      uptime: [], history: [], deploys: [], health: [{ 1: 1 }],
    }));
    expect(out.freshness.stale).toBe(true);
    expect(out.overall).toBe('degraded');
  });

  it('maps the bucketed rank back to a status', async () => {
    const out = await buildStatus(env({
      latest: [{ service: 'r2', status: 'up', latency_ms: 9, detail: null, at: recent(1) }],
      uptime: [],
      history: [
        { hour: '2026-09-08T00', service: 'r2', worst: 2 },
        { hour: '2026-09-08T01', service: 'r2', worst: 1 },
      ],
      deploys: [], health: [{ 1: 1 }],
    }));
    expect(out.history.map((h) => h.status)).toEqual(['down', 'degraded']);
  });

  it('has no probe rows at all without claiming everything is fine', async () => {
    const out = await buildStatus(env({
      latest: [], uptime: [], history: [], deploys: [], health: [{ 1: 1 }],
    }));
    expect(out.freshness.last_check).toBeNull();
    expect(out.freshness.stale).toBe(true);
    expect(out.overall).toBe('degraded');
    expect(out.services).toEqual([]);
  });
});
