import type { Env } from './types.js';
import { isAuthConfigured } from './auth.js';
import { mailConfigured } from './mailer.js';
import { type HealthFacts, healthFacts } from './health.js';
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

export async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value?: T; error?: unknown }> {
  const started = Date.now();
  try {
    // The await must complete before the clock is read. Written as
    // `{ ms: Date.now() - started, value: await fn() }` the properties evaluate in source
    // order, so `ms` was computed before `fn` had even been called — which is why every
    // probe in production has recorded a latency of exactly 0 and the dashboard has been
    // reporting "<1 ms" for a 600,000-iteration key derivation.
    const value = await fn();
    return { ms: Date.now() - started, value };
  } catch (error) {
    return { ms: Date.now() - started, error };
  }
}

const message = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 300);

async function probeD1(env: Env): Promise<ProbeResult> {
  /**
   * A read against a real table and a real column, not `SELECT 1` — the failure worth
   * catching is a missing migration, which an expression-only query sails straight past.
   *
   * But LIMIT 1, not COUNT(*). Counting reads every row in the table to answer a question
   * the probe never asked: it wants to know the table is there and answering, and one row
   * proves that exactly as well as twelve thousand do. Running every five minutes against
   * a growing table, the count was reading about 3.6 million rows a day and charging the
   * account for all of them, which is most of D1's free daily allowance spent on a health
   * check. It is what took the deploy down.
   */
  const { ms, error } = await timed(() =>
    env.DB.prepare('SELECT frame_id FROM frames LIMIT 1').first<{ frame_id: string }>(),
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
  if (ms > SLOW_MS) {
    return {
      service: 'kdf',
      status: 'degraded',
      latencyMs: ms,
      detail: `slow: ${ms}ms for ${TOTAL_ITERATIONS} iterations`,
    };
  }
  return {
    service: 'kdf',
    status: 'up',
    /**
     * Zero here means "not measured", not "instant".
     *
     * With the timing bug fixed, D1 and R2 report real numbers — 140ms and 820ms in the
     * first production pass. This one still reads exactly 0, and that is the platform:
     * Workers advances Date.now() only when the runtime performs I/O, as a timing-attack
     * mitigation, and key derivation is pure computation. There is no clock inside a
     * Worker that can see it.
     *
     * Reporting 0 would render as "<1 ms" for six chained 100,000-iteration rounds, which
     * is the opposite of true. A null renders as an em dash and says nothing it cannot
     * support.
     */
    latencyMs: ms > 0 ? ms : null,
    detail: ms > 0 ? null
      : `completed ${TOTAL_ITERATIONS} iterations; duration is not measurable from inside ` +
        'a Worker, whose clock only advances on I/O',
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
  /** Whether the recorded probes are recent enough to be describing the present. */
  freshness: { last_check: string | null; stale: boolean; interval_minutes: number };
  health: HealthFacts;
  services: {
    service: string;
    status: ServiceStatus;
    latency_ms: number | null;
    detail: string | null;
    checked_at: string | null;
    uptime_24h: number | null;
    uptime_7d: number | null;
  }[];
  /** One entry per service per hour, worst status seen. Aggregated in SQL, not shipped raw. */
  history: { hour: string; service: string; status: ServiceStatus }[];
  deploys: {
    at: string; commit_sha: string; commit_message: string | null;
    actor: string | null; run_url: string | null; status: string; version_id: string | null;
  }[];
  roadmap: typeof ROADMAP;
  progress: ReturnType<typeof roadmapProgress>;
}

const WORST: Record<ServiceStatus, number> = { up: 0, degraded: 1, down: 2 };
const RANK_TO_STATUS: ServiceStatus[] = ['up', 'degraded', 'down'];

/** The cron interval. Older than a couple of cycles and the prober itself has stopped. */
const PROBE_INTERVAL_MINUTES = 5;
const STALE_AFTER_MS = PROBE_INTERVAL_MINUTES * 60_000 * 2.5;

/**
 * Everything the status page renders, in one request — from the recorded probe rows.
 *
 * This used to run the full probe suite live on every request, which was wrong in a way
 * that took production to prove. Serving one page meant a 600,000-iteration key
 * derivation, an R2 write-read-delete round trip and four D1 queries, and it measured out
 * at 0.7–1.6 seconds per request with occasional outright failures. The page refreshes
 * itself every thirty seconds, is unauthenticated, and is uncacheable in practice because
 * every client wants current data — so the endpoint was an open invitation to spend the
 * Worker's entire CPU budget on someone else's refresh loop.
 *
 * The cron already probes every five minutes and writes the result down. That is the
 * prober. This is a reader, and a reader must be cheap. What is lost is up to five minutes
 * of resolution, which the page now states outright rather than implying a liveness it
 * was paying far too much for.
 */
export async function buildStatus(env: Env): Promise<StatusPayload> {
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();

  const [latest, uptime, history, deploys, health] = await Promise.all([
    // The newest row per service. The (service, at DESC) index makes the correlated
    // MAX(at) a lookup rather than a scan.
    env.DB.prepare(
      `SELECT c.service, c.status, c.latency_ms, c.detail, c.at
         FROM service_checks c
        WHERE c.at = (SELECT MAX(at) FROM service_checks WHERE service = c.service)`,
    ).all<{
      service: string; status: ServiceStatus; latency_ms: number | null;
      detail: string | null; at: string;
    }>().catch(() => ({ results: [] })),

    env.DB.prepare(
      // Conditional aggregation rather than the FILTER clause: AVG skips NULLs, so this
      // computes both windows in one pass and works on any SQLite build D1 might run.
      `SELECT service,
              AVG(CASE WHEN at >= ? THEN (CASE WHEN status = 'up' THEN 1.0 ELSE 0.0 END) END) AS d1_up,
              AVG(CASE WHEN status = 'up' THEN 1.0 ELSE 0.0 END) AS d7_up
       FROM service_checks WHERE at >= ? GROUP BY service`,
    ).bind(dayAgo, weekAgo).all<{
      service: string; d1_up: number | null; d7_up: number | null;
    }>().catch(() => ({ results: [] })),

    // Bucketed in SQL. The page draws one cell per service per hour, so shipping the
    // ~1,440 raw rows a day of probing produces meant sending 15 KB for 120 cells' worth
    // of information and bucketing it again on the client. Worst-of per hour, because an
    // outage that averages away is still an outage.
    env.DB.prepare(
      `SELECT substr(at, 1, 13) AS hour, service,
              MAX(CASE status WHEN 'down' THEN 2 WHEN 'degraded' THEN 1 ELSE 0 END) AS worst
       FROM service_checks WHERE at >= ? GROUP BY hour, service ORDER BY hour ASC`,
    ).bind(dayAgo).all<{ hour: string; service: string; worst: number }>()
      .catch(() => ({ results: [] })),

    env.DB.prepare(
      `SELECT at, commit_sha, commit_message, actor, run_url, status, version_id
       FROM deploy_events ORDER BY at DESC LIMIT 20`,
    ).all<StatusPayload['deploys'][number]>().catch(() => ({ results: [] })),

    // Cheap: one indexed D1 read plus two string checks. No key derivation.
    healthFacts(env),
  ]);

  const uptimeBy = new Map(uptime.results.map((r) => [r.service, r]));
  const lastCheck = latest.results.reduce<string | null>(
    (newest, r) => (newest === null || r.at > newest ? r.at : newest), null,
  );
  const stale = lastCheck === null || Date.now() - Date.parse(lastCheck) > STALE_AFTER_MS;

  const services = latest.results
    .map((r) => {
      const agg = uptimeBy.get(r.service);
      return {
        service: r.service,
        status: r.status,
        latency_ms: r.latency_ms,
        detail: r.detail || null,
        checked_at: r.at,
        uptime_24h: agg?.d1_up ?? null,
        uptime_7d: agg?.d7_up ?? null,
      };
    })
    .sort((a, b) => SERVICE_ORDER.indexOf(a.service) - SERVICE_ORDER.indexOf(b.service));

  return {
    generated_at: new Date().toISOString(),
    // Stale rows describe the past, and reporting the past as the present is the one thing
    // a status page must never do. If the prober has stopped, that is itself the outage.
    overall: stale
      ? 'degraded'
      : services.reduce<ServiceStatus>(
          (worst, r) => (WORST[r.status] > WORST[worst] ? r.status : worst), 'up',
        ),
    freshness: { last_check: lastCheck, stale, interval_minutes: PROBE_INTERVAL_MINUTES },
    health,
    services,
    history: history.results.map((r) => ({
      hour: r.hour,
      service: r.service,
      status: RANK_TO_STATUS[r.worst] ?? 'up',
    })),
    deploys: deploys.results,
    roadmap: ROADMAP,
    progress: roadmapProgress(),
  };
}

/** Render order, so the cards do not reshuffle when a row is missing. */
const SERVICE_ORDER = ['d1', 'r2', 'auth', 'kdf', 'email'];

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
