import { useCallback, useEffect, useState } from 'react';

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

interface HistoryRow {
  at: string;
  service: string;
  status: ServiceStatus;
  latency_ms: number | null;
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
  services: ServiceRow[];
  history: HistoryRow[];
  deploys: DeployRow[];
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
  kdf: 'Runs a real password hash at the configured work factor. Everything else here can pass while signup still fails, because nothing else spends this cost.',
  email: 'Whether a mail provider is configured. Degraded rather than down: recording works, self-service password recovery does not.',
};

const HOURS = 24;

/**
 * One cell per hour, coloured by the worst status seen in that hour.
 *
 * Worst-of rather than an average, because a fifteen-minute outage that averages to 95%
 * looks like a good hour, and it was not one. Hours with no probe stay neutral instead of
 * being drawn as healthy — absence of evidence is not uptime.
 */
function buckets(history: HistoryRow[], service: string): (ServiceStatus | null)[] {
  const now = Date.now();
  const out: (ServiceStatus | null)[] = Array.from({ length: HOURS }, () => null);
  const rank: Record<ServiceStatus, number> = { up: 0, degraded: 1, down: 2 };

  for (const row of history) {
    if (row.service !== service) continue;
    const age = now - Date.parse(row.at);
    const index = HOURS - 1 - Math.floor(age / 3_600_000);
    if (index < 0 || index >= HOURS) continue;
    const current = out[index] ?? null;
    if (current === null || rank[row.status] > rank[current]) out[index] = row.status;
  }
  return out;
}

const pct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(2)}%`);

/**
 * A sub-millisecond query is not "0 ms"; that reads as missing data. Config assertions do
 * no I/O at all and get an em dash, which is a different statement from "instant".
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

  const load = useCallback(async () => {
    try {
      const res = await fetch('/v1/status');
      if (!res.ok) throw new Error(`status endpoint returned ${res.status}`);
      setData((await res.json()) as StatusPayload);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  if (error && !data) {
    return (
      <div className="app">
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>The status page cannot reach the service</h3>
          <div className="banner bad">{error}</div>
          <div className="hint">
            This page is served by the same Worker it reports on, so if it loaded at all the
            Worker is running — the failure is in the status query itself.
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
          <a href="/" className="linkish">Open the recorder</a>
        </nav>
      </header>

      <div className="panel status-hero">
        <div className="status-hero-mark" style={{ color: look.token }} aria-hidden="true">
          {look.glyph}
        </div>
        <div>
          <h2 style={{ margin: 0 }}>{headline}</h2>
          <div className="hint">
            Checked {ago(data.generated_at)} · probes run inside the Worker, against the same
            D1 and R2 bindings that serve recordings. Refreshes every 30 seconds.
          </div>
        </div>
      </div>

      <div className="grid status-grid">
        {data.services.map((row) => (
          <ServiceCard key={row.service} row={row} history={data.history} />
        ))}
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

      <Roadmap roadmap={data.roadmap} progress={data.progress} />
    </div>
  );
}
