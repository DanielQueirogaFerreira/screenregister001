-- The catalogue. Mirrors FrameRecord in packages/schema so the local IndexedDB store and
-- the cloud store hold the same shape, and syncing is a transfer rather than a translation.

CREATE TABLE IF NOT EXISTS devices (
  device_id   TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  session_id     TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  device_id      TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  capture_fps    INTEGER NOT NULL,
  sensitivity    INTEGER NOT NULL,
  screen_w       INTEGER NOT NULL,
  screen_h       INTEGER NOT NULL,
  frames_stored  INTEGER NOT NULL DEFAULT 0,
  frames_skipped INTEGER NOT NULL DEFAULT 0,
  bytes_stored   INTEGER NOT NULL DEFAULT 0,
  label          TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_started ON sessions(user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS frames (
  frame_id      TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  captured_at   TEXT NOT NULL,
  offset_ms     INTEGER NOT NULL,
  seq           INTEGER NOT NULL,
  hold_ms       INTEGER,
  change_score  REAL NOT NULL,
  changed_tiles TEXT NOT NULL,          -- JSON array of tile indices
  reason        TEXT NOT NULL,
  width         INTEGER NOT NULL,
  height        INTEGER NOT NULL,
  bytes         INTEGER NOT NULL,
  format        TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  storage_key   TEXT NOT NULL,
  -- Reserved for the enrichment phase; unused today.
  ocr_text      TEXT,
  caption       TEXT,
  enrich_status TEXT NOT NULL DEFAULT 'pending',
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

-- Serves the two access patterns that matter: play back a session in order, and answer
-- "what was on screen between these times" for a user across sessions.
CREATE INDEX IF NOT EXISTS idx_frames_session_seq ON frames(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_frames_user_time ON frames(user_id, captured_at);
-- Drives the nightly retention sweep.
CREATE INDEX IF NOT EXISTS idx_frames_captured ON frames(captured_at);
