-- Accounts and the security layer around them.
--
-- Naming note: `sessions` is already taken by *recording* sessions, so login sessions are
-- `auth_sessions`. Reusing the name would have been a subtle and permanent trap.
--
-- Nothing here stores a credential in a form that is useful if the database leaks:
-- passwords are PBKDF2 digests, and every token (login cookie, email link, API token) is
-- stored as a SHA-256 hash of the value handed to the client. A dump of this database
-- cannot be replayed against the service.

CREATE TABLE IF NOT EXISTS users (
  user_id           TEXT PRIMARY KEY,        -- ULID, and the same user_id frames carry
  email             TEXT NOT NULL,           -- normalised: trimmed and lowercased
  email_verified_at TEXT,
  -- pbkdf2-sha256$<iterations>$<salt-b64>$<digest-b64>. Self-describing so the work
  -- factor can be raised later without invalidating existing passwords.
  password_hash     TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  disabled_at       TEXT,
  -- Lockout state. Counted per account so a distributed guess against one email is
  -- throttled even when every attempt comes from a different address.
  failed_attempts   INTEGER NOT NULL DEFAULT 0,
  locked_until      TEXT
);
-- Case-insensitivity is enforced by normalising before write, and this index makes the
-- uniqueness real rather than a convention.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Login sessions, keyed by the hash of the cookie value. The raw value exists only in the
-- user's browser, so a database dump yields no usable cookies.
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT,
  ip           TEXT,
  user_agent   TEXT,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);
-- Serves "list my sessions" and "revoke everything but this one".
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id, expires_at DESC);

-- Single-use links: email verification and password reset.
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  purpose    TEXT NOT NULL,              -- 'verify_email' | 'reset_password'
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id, purpose);

-- Long-lived bearer tokens for MCP clients and scripts, which cannot hold a cookie.
-- Separate from login sessions so revoking an assistant's access never signs you out, and
-- so a leaked token can be scoped to reading.
CREATE TABLE IF NOT EXISTS api_tokens (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  scope        TEXT NOT NULL DEFAULT 'read',   -- 'read' | 'write'
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  expires_at   TEXT,
  revoked_at   TEXT,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id, created_at DESC);

-- Audit trail. For a service holding screen recordings, "who got into my account and
-- when" has to be answerable after the fact, and it cannot be reconstructed from the
-- recordings themselves.
CREATE TABLE IF NOT EXISTS auth_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  user_id    TEXT,                       -- null when the email matched no account
  email      TEXT,
  event      TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_events_user ON auth_events(user_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_events_at ON auth_events(at);

-- Fixed-window counters for login, signup and reset attempts. In D1 rather than in memory
-- because Workers are stateless and per-isolate counters would reset constantly and
-- differ per colo — which is to say, would not be a rate limit at all.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket       TEXT PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);
