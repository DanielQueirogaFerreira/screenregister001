import type { Env } from './types.js';
import { isAuthConfigured } from './auth.js';
import { mailConfigured } from './mailer.js';
import { TOTAL_ITERATIONS, hashPassword } from './password.js';
import { ROADMAP, roadmapProgress } from './roadmap.js';

/**
 * Service probes, run from inside the Worker.
 *
 * The point of measuring from here rather than from an outside monitor: the question worth
 * answering is "could the Worker reach R2 when a user tried to record", and only the
 * Worker can answer that. An external prober measures its own path to the edge, which is
 * a different question and stays green through exactly the failures that matter.
 *
 * Every probe does real work — a write and a read, not a ping — because a binding that
 * resolves but cannot serve is the failure mode that actually happens.
 */

export type ServiceStatus = 'up' | 'degraded' | 'down';

export interface ProbeResult {
  service: string;
  status: ServiceStatus;
  latencyMs: number | null;
  detail: string | null;
}

/** Above this, a working dependency is still a bad user experience. */
const SLOW_MS = 1500;

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value?: T; error?: unknown }> {
  const started = Date.now();
  try {
    return { ms: Date.now() - started, value: await fn() };
  } catch (error) {
    return { ms: Date.now() - started, error };
  }
}

const message = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 300);

async function probeD1(env: Env): Promise<ProbeResult> {
  // A read against a real table, not `SELECT 1`: the failure this catches is a missing
  // migration, which an expression-only query would sail straight past.
  const { ms, error } = await timed(() =>
    env.DB.prepare('SELECT COUNT(*) AS n FROM frames').first<{ n: number }>(),
  );
  if (error) {
    return { service: 'd1', status: 'down', latencyMs: ms, detail: message(error) };
  }
  return {
    service: 'd1',
    status: ms > SLOW_MS ? 'degraded' : 'up',
    latencyMs: ms,
    detail: ms > SLOW_MS ? `slow: ${ms}ms` : null,
  };
}

async function probeR2(env: Env): Promise<ProbeResult> {
  // Write, read back, delete. A put that succeeds while the object is unreadable is a real
  // failure mode, and only the round trip catches it.
  const key = `_healthcheck/${crypto.randomUUID()}`;
  const payload = crypto.getRandomValues(new Uint8Array(32));

  const { ms, error, value } = await timed(async () => {
    await env.FRAMES.put(key, payload);
    const back = await env.FRAMES.get(key);
    const bytes = back ? new Uint8Array(await back.arrayBuffer()) : null;
    await env.FRAMES.delete(key);
    return bytes;
  });

  if (error) return { service: 'r2', status: 'down', latencyMs: ms, detail: message(error) };
  if (!value || value.length !== payload.length || !value.every((b, i) => b === payload[i])) {
    return { service: 'r2', status: 'down', latencyMs: ms, detail: 'object read back did not match what was written' };
  }
  return {
    service: 'r2',
    status: ms > SLOW_MS ? 'degraded' : 'up',
    latencyMs: ms,
    detail: ms > SLOW_MS ? `slow: ${ms}ms` : null,
  };
}

/**
 * Configuration assertions rather than I/O, so they carry no latency.
 *
 * `auth` down means every authenticated route is returning 503 — the outage this project
 * spent days inside. `email` is reported as degraded, not down, because the product works
 * without it; only self-service password recovery does not.
 */
function probeAuth(env: Env): ProbeResult {
  const ok = isAuthConfigured(env);
  return {
    service: 'auth',
    status: ok ? 'up' : 'down',
    latencyMs: null,
    detail: ok ? null : 'signing key missing or too short; authenticated routes return 503',
  };
}

function probeEmail(env: Env): ProbeResult {
  const ok = mailConfigured(env);
  return {
    service: 'email',
    status: ok ? 'up' : 'degraded',
    latencyMs: null,
    detail: ok ? null : 'no provider configured; verification and reset links are not delivered',
  };
}

/**
 * Can this Worker actually hash a password?
 *
 * Every other check here can pass while signup returns 500, because nothing else spends
 * the key-derivation cost — which is exactly how a broken signup reached production. The
 * runtime is the only authority on whether the configured work factor is permitted, so
 * ask it, and put the answer where the dashboard can show it.
 */
async function probeKdf(): Promise<ProbeResult> {
  const { ms, error } = await timed(() => hashPassword('probe-not-a-real-password'));
  if (error) {
    return {
      service: 'kdf',
      status: 'down',
      latencyMs: ms,
      // The runtime's own words. Not sensitive: it describes a platform capability, and
      // no password, salt or digest is involved.
      detail: `password hashing failed at ${TOTAL_ITERATIONS} iterations: ${message(error)}`,
    };
  }
  return {
    service: 'kdf',
    status: ms > SLOW_MS ? 'degraded' : 'up',
    latencyMs: ms,
    detail: ms > SLOW_MS ? `slow: ${ms}ms for ${TOTAL_ITERATIONS} iterations` : null,
  };
}

export async function runProbes(env: Env): Promise<ProbeResult[]> {
  const [d1, r2, kdf] = await Promise.all([probeD1(env), probeR2(env), probeKdf()]);
  return [d1, r2, probeAuth(env), kdf, probeEmail(env)];
}

/** Record a probe pass. Failing to record must never take the Worker down with it. */
export async function recordProbes(env: Env, results: ProbeResult[]): Promise<void> {
  const at = new Date().toISOString();
  try {
    await env.DB.batch(
      results.map((r) =>
        env.DB.prepare(
          `INSERT INTO service_checks (at, service, status, latency_ms, detail) VALUES (?,?,?,?,?)`,
        ).bind(at, r.service, r.status, r.latencyMs, r.detail),
      ),
    );
  } catch (err) {
    console.error('failed to record service checks', err);
  }
}

export interface StatusPayload {
  generated_at: string;
  overall: ServiceStatus;
  services: {
    service: string;
    status: ServiceStatus;
    latency_ms: number | null;
    detail: string | null;
    checked_at: string | null;
    uptime_24h: number | null;
    uptime_7d: number | null;
  }[];
  history: { at: string; service: string; status: ServiceStatus; latency_ms: number | null }[];
  deploys: {
    at: string; commit_sha: string; commit_message: string | null;
    actor: string | null; run_url: string | null; status: string; version_id: string | null;
  }[];
  roadmap: typeof ROADMAP;
  progress: ReturnType<typeof roadmapProgress>;
}

const WORST: Record<ServiceStatus, number> = { up: 0, degraded: 1, down: 2 };

/**
 * Everything the status page renders, in one request.
 *
 * Probes run live for the "now" column rather than reading the last cron row, so opening
 * the page tells you about this moment and not about up to five minutes ago. History and
 * uptime come from the recorded rows.
 */
export async function buildStatus(env: Env): Promise<StatusPayload> {
  const live = await runProbes(env);
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();

  const [uptime, history, deploys] = await Promise.all([
    env.DB.prepare(
      // Conditional aggregation rather than the FILTER clause: AVG skips NULLs, so this
      // computes both windows in one pass and works on any SQLite build D1 might run.
      `SELECT service,
              AVG(CASE WHEN at >= ? THEN (CASE WHEN status = 'up' THEN 1.0 ELSE 0.0 END) END) AS d1_up,
              AVG(CASE WHEN status = 'up' THEN 1.0 ELSE 0.0 END) AS d7_up,
              MAX(at) AS last_at
       FROM service_checks WHERE at >= ? GROUP BY service`,
    ).bind(dayAgo, weekAgo).all<{
      service: string; d1_up: number | null; d7_up: number | null; last_at: string;
    }>().catch(() => ({ results: [] })),

    env.DB.prepare(
      `SELECT at, service, status, latency_ms FROM service_checks
       WHERE at >= ? ORDER BY at ASC LIMIT 2000`,
    ).bind(dayAgo).all<{ at: string; service: string; status: ServiceStatus; latency_ms: number | null }>()
      .catch(() => ({ results: [] })),

    env.DB.prepare(
      `SELECT at, commit_sha, commit_message, actor, run_url, status, version_id
       FROM deploy_events ORDER BY at DESC LIMIT 20`,
    ).all<StatusPayload['deploys'][number]>().catch(() => ({ results: [] })),
  ]);

  const byService = new Map(uptime.results.map((r) => [r.service, r]));

  return {
    generated_at: new Date().toISOString(),
    overall: live.reduce<ServiceStatus>(
      (worst, r) => (WORST[r.status] > WORST[worst] ? r.status : worst), 'up',
    ),
    services: live.map((r) => {
      const agg = byService.get(r.service);
      return {
        service: r.service,
        status: r.status,
        latency_ms: r.latencyMs,
        detail: r.detail,
        checked_at: agg?.last_at ?? null,
        uptime_24h: agg?.d1_up ?? null,
        uptime_7d: agg?.d7_up ?? null,
      };
    }),
    history: history.results,
    deploys: deploys.results,
    roadmap: ROADMAP,
    progress: roadmapProgress(),
  };
}

/** Keep the operational history bounded; it is diagnostics, not an archive. */
export async function pruneStatusTables(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM service_checks WHERE at < ?`)
      .bind(new Date(Date.now() - 30 * 86_400_000).toISOString()),
    env.DB.prepare(
      `DELETE FROM deploy_events WHERE id NOT IN
         (SELECT id FROM deploy_events ORDER BY at DESC LIMIT 200)`,
    ),
  ]);
}
