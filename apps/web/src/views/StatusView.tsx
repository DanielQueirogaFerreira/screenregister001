import { useCallback, useEffect, useState } from 'react';
import { ThemeToggle } from '../lib/sections.js';
import { bytes, perFrame } from '../lib/format.js';
import { EvolutionCard } from './EvolutionView.js';

type ServiceStatus = 'up' | 'degraded' | 'down';

interface ServiceRow {
  service: string;
  status: ServiceStatus;
  latency_ms: number | null;
  detail: string | null;
  checked_at: string | null;
  uptime_24h: number | null;
  uptime_7d: number | null;
}

/** One bucket per service per hour, aggregated by the Worker in SQL. */
interface HistoryRow {
  hour: string;        // 'YYYY-MM-DDTHH', the UTC hour the bucket covers
  service: string;
  status: ServiceStatus;
}

interface HealthFacts {
  ok: boolean;
  schema: 'ready' | 'missing' | 'error' | 'over_quota';
  retention_days: number;
  auth_configured: boolean;
  cors_localhost: boolean;
  email_configured: boolean;
  hint?: string;
  auth_hint?: string;
}

interface DeployRow {
  at: string;
  commit_sha: string;
  commit_message: string | null;
  actor: string | null;
  run_url: string | null;
  status: string;
  version_id: string | null;
}

interface Phase {
  id: number;
  title: string;
  status: 'done' | 'in_progress' | 'planned';
  summary: string;
  items: { text: string; done: boolean }[];
}

interface StatusPayload {
  generated_at: string;
  overall: ServiceStatus;
  freshness: { last_check: string | null; stale: boolean; interval_minutes: number };
  health: HealthFacts;
  services: ServiceRow[];
  history: HistoryRow[];
  deploys: DeployRow[];
  storage: { sessions: number; frames: number; bytes: number };
  roadmap: Phase[];
  progress: { done: number; total: number; phase: Phase | null };
}

/**
 * Status is never encoded by colour alone.
 *
 * The palette's tightest adjacent pair is up↔degraded, which separates by ΔE 8.2 under
 * protanopia — over the threshold, but not by enough to carry meaning unaided. Every
 * status therefore ships a glyph and a word as well, which is also what makes the page
 * legible in a screenshot, in forced-colours mode, and read aloud.
 */
const LOOK: Record<ServiceStatus, { label: string; glyph: string; token: string }> = {
  up: { label: 'Operational', glyph: '●', token: 'var(--good)' },
  degraded: { label: 'Degraded', glyph: '▲', token: 'var(--warn)' },
  down: { label: 'Down', glyph: '✕', token: 'var(--bad)' },
};

const TITLES: Record<string, string> = {
  d1: 'D1 — timeline & metadata',
  r2: 'R2 — frame images',
  auth: 'Authentication',
  kdf: 'Password hashing',
  email: 'Transactional email',
};

const DESCRIPTIONS: Record<string, string> = {
  d1: 'Read against a real table, so a missing migration shows up as a failure rather than passing.',
  r2: 'Writes an object, reads it back, compares the bytes, deletes it. A put that succeeds while the object is unreadable still counts as down.',
  auth: 'Whether the Worker holds a usable signing key. When this is down, every authenticated route returns 503.',
  kdf: 'Runs a real password hash at the configured work factor. Everything else here can pass while signup still fails, because nothing else spends this cost. It reports no duration: a Worker\u2019s clock only advances on I/O, and this is pure computation.',
  email: 'Whether a mail provider is configured. Degraded rather than down: recording works, self-service password recovery does not.',
};

const HOURS = 24;

/**
 * One cell per hour, over the last 24.
 *
 * The Worker sends one row per service per hour, already reduced to the worst status seen
 * in that hour — worst-of rather than an average, because a fifteen-minute outage that
 * averages to 95% looks like a good hour, and it was not one. Hours with no probe stay
 * neutral instead of being drawn as healthy: absence of evidence is not uptime.
 */
function hourKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 13);
}

function buckets(history: HistoryRow[], service: string): (ServiceStatus | null)[] {
  const seen = new Map<string, ServiceStatus>();
  for (const row of history) {
    if (row.service === service) seen.set(row.hour, row.status);
  }
  const now = Date.now();
  return Array.from({ length: HOURS }, (_, i) =>
    seen.get(hourKey(now - (HOURS - 1 - i) * 3_600_000)) ?? null,
  );
}

const pct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(2)}%`);

/**
 * A sub-millisecond query is not "0 ms"; that reads as missing data. An em dash means the
 * probe has no duration to report — a configuration assertion that does no I/O, or work
 * the runtime's clock cannot see — which is a different statement from "instant".
 */
const latency = (ms: number | null): string =>
  ms === null ? '—' : ms < 1 ? '<1 ms' : `${ms} ms`;

const ago = (iso: string): string => {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
};

function ServiceCard({ row, history }: { row: ServiceRow; history: HistoryRow[] }) {
  const look = LOOK[row.status];
  const cells = buckets(history, row.service);

  return (
    <div className="panel status-card">
      <div className="row" style={{ marginBottom: 6 }}>
        <b>{TITLES[row.service] ?? row.service}</b>
        <span className="status-pill" style={{ marginLeft: 'auto', color: look.token }}>
          <span aria-hidden="true">{look.glyph}</span> {look.label}
        </span>
      </div>

      <div className="hint" style={{ marginBottom: 12 }}>
        {row.detail ?? DESCRIPTIONS[row.service] ?? ''}
      </div>

      <div className="status-strip" role="img"
        aria-label={`Hourly status for the last ${HOURS} hours: ${
          cells.filter((c) => c === 'up').length} operational, ${
          cells.filter((c) => c === 'degraded').length} degraded, ${
          cells.filter((c) => c === 'down').length} down, ${
          cells.filter((c) => c === null).length} without data.`}
      >
        {cells.map((cell, i) => (
          <i
            key={i}
            style={{ background: cell ? LOOK[cell].token : 'var(--line)' }}
            title={`${HOURS - 1 - i === 0 ? 'this hour' : `${HOURS - 1 - i}h ago`}: ${
              cell ? LOOK[cell].label : 'no data'}`}
          />
        ))}
      </div>
      <div className="status-strip-axis">
        <span>24h ago</span>
        <span>now</span>
      </div>

      <div className="stats" style={{ marginTop: 12 }}>
        <div className="stat">
          <b>{latency(row.latency_ms)}</b>
          <span>latency now</span>
        </div>
        <div className="stat"><b>{pct(row.uptime_24h)}</b><span>24h uptime</span></div>
        <div className="stat"><b>{pct(row.uptime_7d)}</b><span>7d uptime</span></div>
      </div>
    </div>
  );
}

/**
 * The deployment's own configuration, which is what /v1/health reports.
 *
 * It lives here now because a person pasting /v1/health into a browser was asking a
 * question this page answers better. Each row is a fact that has, at least once, been the
 * whole reason the product was broken while every other signal stayed green.
 */
function Health({ health }: { health: HealthFacts }) {
  const rows: { label: string; ok: boolean | null; value: string; note?: string }[] = [
    {
      label: 'Database schema',
      ok: health.schema === 'ready',
      value: health.schema,
      note: health.hint,
    },
    {
      label: 'Signing key',
      ok: health.auth_configured,
      value: health.auth_configured ? 'configured' : 'missing',
      note: health.auth_hint,
    },
    {
      label: 'Email provider',
      // Not a failure. Recording works without it; only self-service recovery does not.
      ok: health.email_configured ? true : null,
      value: health.email_configured ? 'configured' : 'not configured',
      note: health.email_configured
        ? undefined
        : 'Verification and password-reset links are not delivered.',
    },
    {
      label: 'Retention',
      ok: true,
      value: `${health.retention_days} days`,
      note: 'Enforced by a nightly sweep on the server, not by the browser.',
    },
    {
      label: 'Cross-origin localhost',
      // Enabled in production would be a real finding, so it is not drawn as neutral.
      ok: !health.cors_localhost,
      value: health.cors_localhost ? 'allowed' : 'denied',
    },
  ];

  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <div className="row" style={{ marginBottom: 10 }}>
        <b>Deployment health</b>
        <span style={{ marginLeft: 'auto', color: health.ok ? 'var(--good)' : 'var(--bad)' }}>
          <span aria-hidden="true">{health.ok ? '\u25cf' : '\u2715'}</span>{' '}
          {health.ok ? 'Serving' : 'Not serving'}
        </span>
      </div>
      <div className="health-list">
        {rows.map((r) => (
          <div key={r.label} className="health-row">
            <span
              className="health-mark"
              style={{ color: r.ok === null ? 'var(--warn)' : r.ok ? 'var(--good)' : 'var(--bad)' }}
              aria-hidden="true"
            >
              {r.ok === null ? '\u25b2' : r.ok ? '\u2713' : '\u2715'}
            </span>
            <span className="health-label">{r.label}</span>
            <span className="health-value">{r.value}</span>
            {r.note && <span className="health-note">{r.note}</span>}
          </div>
        ))}
      </div>
      <div className="hint" style={{ marginTop: 10 }}>
        The same facts are available as JSON at <code>/v1/health</code> for uptime monitors
        and the deploy gate.
      </div>
    </div>
  );
}

function Roadmap({ roadmap, progress }: { roadmap: Phase[]; progress: StatusPayload['progress'] }) {
  const fraction = progress.total ? progress.done / progress.total : 0;
  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <div className="row" style={{ marginBottom: 10 }}>
        <b>Construction</b>
        <span style={{ marginLeft: 'auto', color: 'var(--dim)' }}>
          {progress.done} of {progress.total} items · {(fraction * 100).toFixed(0)}%
        </span>
      </div>

      <div className="progress-track" role="img"
        aria-label={`${progress.done} of ${progress.total} roadmap items complete.`}>
        <div className="progress-fill" style={{ width: `${fraction * 100}%` }} />
      </div>

      {progress.phase && (
        <div className="hint" style={{ marginTop: 10 }}>
          Currently building: <b>{progress.phase.title}</b> — {progress.phase.summary}
        </div>
      )}

      <div className="phase-list">
        {roadmap.map((phase) => (
          <div key={phase.id} className={`phase ${phase.status}`}>
            <div className="row">
              <b>{phase.id}. {phase.title}</b>
              <span className={`tag ${phase.status}`} style={{ marginLeft: 'auto' }}>
                {phase.status === 'in_progress' ? 'building' : phase.status}
              </span>
            </div>
            <div className="hint">{phase.summary}</div>
            <ul className="checklist">
              {phase.items.map((item) => (
                <li key={item.text} className={item.done ? 'done' : ''}>
                  <span aria-hidden="true">{item.done ? '✓' : '○'}</span>
                  <span>{item.text}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

export function StatusView() {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  /**
   * Ask, once, whether whoever is looking is an operator — and never let the answer matter.
   *
   * This page exists to work when authentication is broken, so the check is deliberately
   * fire-and-forget: no loading state, no error surface, nothing gating the render. A 401
   * from being signed out and a 500 from a Worker that cannot verify a cookie both land in
   * the same place, which is silence and no button. The button is a convenience; the page
   * reporting the outage is the job.
   */
  useEffect(() => {
    let cancelled = false;
    void fetch('/v1/auth/me', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() as Promise<{ is_admin?: boolean }> : null))
      .then((me) => { if (!cancelled) setIsAdmin(Boolean(me?.is_admin)); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const [denied, setDenied] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/v1/status', { credentials: 'same-origin' });
      // 401 is signed out, 404 is signed in without operator access. Both mean the same
      // thing to a reader — this page is not yours — and neither is an error worth a red
      // banner, so they get their own answer rather than a status code.
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        setDenied(true);
        setError(null);
        return;
      }
      if (!res.ok) throw new Error(`status endpoint returned ${res.status}`);
      setData((await res.json()) as StatusPayload);
      setDenied(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  if (denied) {
    return (
      <div className="app">
        <header>
          <h1>ScreenRegister <span>· status</span></h1>
          <nav><a href="/" className="button-link">&larr; Back to the recorder</a></nav>
        </header>
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>This page is for operators</h3>
          <div className="hint">
            It names deployments, commit messages and service latencies, so it is behind an
            account. Sign in with an operator account to read it.
          </div>
          <div className="hint" style={{ marginTop: 12 }}>
            <b>If the problem is that you cannot sign in</b>, this page cannot help — but{' '}
            <a className="linkish" href="/v1/health">/v1/health</a> can. It is public, needs
            no signing key to answer, and reports whether the schema, the signing key and
            the mail provider are in place. That is deliberately the one thing that keeps
            working when authentication does not.
          </div>
          <div className="row" style={{ marginTop: 14 }}>
            <a className="button-link" href="/">Sign in</a>
            <a className="button-link" href="/v1/health">Open /v1/health</a>
          </div>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="app">
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>The status page cannot reach the service</h3>
          <div className="banner bad">{error}</div>
          <div className="hint">
            This page is served by the same Worker it reports on, so if it loaded at all the
            Worker is running — the failure is in the status query itself. Retrying every
            minute.
          </div>
        </div>
      </div>
    );
  }

  if (!data) return <div className="app"><div className="empty">Checking services…</div></div>;

  const look = LOOK[data.overall];
  const headline = {
    up: 'All services operational',
    degraded: 'Running with a degraded service',
    down: 'A service is down',
  }[data.overall];

  return (
    <div className="app">
      <header>
        <h1>ScreenRegister <span>· status</span></h1>
        <nav>
          {/* Only for operators, and only once the account has confirmed it. Showing this
              to everyone would send most people to a page that answers 404 by design. */}
          {isAdmin && (
            <a href="/admin" className="button-link">Operator view</a>
          )}
          <a href="/evolution" className="button-link">Codebase evolution</a>
          <a href="/database" className="button-link">Database &amp; cost</a>
          <ThemeToggle />
          {/* Styled as a button rather than a link: this is the way back, and on a phone
              a text link tucked in the header is easy to miss entirely. */}
          <a href="/" className="button-link">&larr; Back to the recorder</a>
        </nav>
      </header>

      <div className="panel status-hero">
        <div className="status-hero-mark" style={{ color: look.token }} aria-hidden="true">
          {look.glyph}
        </div>
        <div>
          <h2 style={{ margin: 0 }}>{headline}</h2>
          <div className="hint">
            {data.freshness.last_check
              ? `Last probed ${ago(data.freshness.last_check)}`
              : 'No probe has been recorded yet'}
            {' · '}every {data.freshness.interval_minutes} minutes, from inside the Worker,
            against the same D1 and R2 bindings that serve recordings.
          </div>
        </div>
      </div>

      {data.freshness.stale && (
        <div className="banner warn" style={{ marginTop: 14 }}>
          <b>These readings are out of date.</b> The scheduled probe has not reported in
          over {Math.round(data.freshness.interval_minutes * 2.5)} minutes, so the states
          below describe whenever it last ran rather than right now. The probe stopping is
          itself worth investigating — the cron trigger is the first place to look.
        </div>
      )}

      <div className="grid status-grid">
        {data.services.map((row) => (
          <ServiceCard key={row.service} row={row} history={data.history} />
        ))}
      </div>

      {/*
        Storage, with the ratio beside the totals. An operator looking at this page during
        an incident wants to know whether frames have become expensive, and a total alone
        cannot answer that — 100 frames in 100 MB and 10,000 frames in 100 MB are the same
        total and completely different problems.
      */}
      <div className="panel" style={{ marginTop: 14 }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <b>Storage</b>
          <span style={{ marginLeft: 'auto', color: 'var(--dim)' }}>
            counted from session rows, not by scanning frames
          </span>
        </div>
        <div className="stats">
          <div className="stat"><b>{data.storage.sessions}</b><span>recordings</span></div>
          <div className="stat"><b>{data.storage.frames.toLocaleString()}</b><span>frames</span></div>
          <div className="stat"><b>{bytes(data.storage.bytes)}</b><span>in R2</span></div>
          <div className="stat">
            <b>{perFrame(data.storage.bytes, data.storage.frames)}</b><span>average</span>
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <b>Deployments</b>
          <span style={{ marginLeft: 'auto', color: 'var(--dim)' }}>
            {data.deploys.length ? `last ${data.deploys.length}` : 'none recorded yet'}
          </span>
        </div>
        {data.deploys.length === 0 ? (
          <div className="hint">
            Recorded by CI after each deploy. The first entry appears on the next deployment.
          </div>
        ) : (
          <div className="table-scroll">
          <table>
            <thead>
              <tr><th>When</th><th>Commit</th><th>Change</th><th>By</th><th>Result</th></tr>
            </thead>
            <tbody>
              {data.deploys.map((d) => (
                <tr key={`${d.at}-${d.commit_sha}`}>
                  <td title={d.at}>{ago(d.at)}</td>
                  <td><code>{d.commit_sha.slice(0, 7)}</code></td>
                  <td className="deploy-message">
                    {(d.commit_message ?? '').split('\n')[0] || '—'}
                  </td>
                  <td style={{ color: 'var(--dim)' }}>{d.actor ?? '—'}</td>
                  <td style={{ color: d.status === 'success' ? 'var(--good)' : 'var(--bad)' }}>
                    <span aria-hidden="true">{d.status === 'success' ? '●' : '✕'}</span>{' '}
                    {d.status}
                    {d.run_url && (
                      <> · <a href={d.run_url} className="linkish">log</a></>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      <Health health={data.health} />

      <EvolutionCard />

      <Roadmap roadmap={data.roadmap} progress={data.progress} />
    </div>
  );
}
