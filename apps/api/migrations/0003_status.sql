-- Operational history: what the platform's own dependencies were doing, over time.
--
-- This is deliberately in D1 rather than an external monitor. The question the dashboard
-- answers is "was R2 reachable from the Worker at 14:35" — and the only thing that can
-- answer it honestly is the Worker itself, from inside the same runtime and region that
-- serves real traffic. An outside prober would be measuring a different path.

CREATE TABLE IF NOT EXISTS service_checks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  service    TEXT NOT NULL,          -- 'd1' | 'r2' | 'auth' | 'email' | 'retention'
  status     TEXT NOT NULL,          -- 'up' | 'degraded' | 'down'
  latency_ms INTEGER,                -- null when the check is a config assertion, not I/O
  detail     TEXT
);
-- Serves both dashboard queries: the latest state per service, and a window of history.
CREATE INDEX IF NOT EXISTS idx_service_checks_service_at ON service_checks(service, at DESC);
CREATE INDEX IF NOT EXISTS idx_service_checks_at ON service_checks(at);

-- Deployment history, written by CI after each deploy. Kept here rather than read from the
-- GitHub API at render time so the status page still tells you what is running when GitHub
-- is the thing that is down.
CREATE TABLE IF NOT EXISTS deploy_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at             TEXT NOT NULL,
  commit_sha     TEXT NOT NULL,
  commit_message TEXT,
  actor          TEXT,
  run_id         TEXT,
  run_url        TEXT,
  status         TEXT NOT NULL,      -- 'success' | 'failure'
  version_id     TEXT
);
CREATE INDEX IF NOT EXISTS idx_deploy_events_at ON deploy_events(at DESC);
