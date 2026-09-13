-- OAuth 2.1 authorisation server, so hosted assistants can connect.
--
-- Gemini Spark and claude.ai will not take a pasted bearer token: they discover
-- /.well-known/oauth-authorization-server, register themselves dynamically, and run a
-- browser consent flow. That is the only way in for a client that does not run on the
-- user's machine, which is exactly the case this exists for.
--
-- Access tokens are NOT a new table. They are rows in api_tokens with a client_id, so an
-- OAuth grant shows up in the same list, with the same "last used" column, and is revoked
-- by the same button as a hand-made token. One place to see who can read your screen
-- history is worth more than a tidy schema.

-- Clients that registered themselves. Registration is open, as the MCP spec intends:
-- holding a client_id grants nothing on its own, because every token still requires a
-- signed-in human to approve a consent screen.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,
  client_name   TEXT NOT NULL,
  -- JSON array. Matched EXACTLY at authorise time; a prefix match here is an open
  -- redirect, which in an OAuth server is the whole ballgame.
  redirect_uris TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  -- Set when a person disables an app rather than revoking one of its tokens.
  disabled_at   TEXT
);

-- Authorisation codes. Single use, short lived, and bound to the client, the redirect and
-- the PKCE challenge that asked for them.
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  -- S256 only. `plain` is in the spec and is worthless: it protects nothing an
  -- interceptor of the code could not also read.
  code_challenge TEXT NOT NULL,
  scope          TEXT NOT NULL DEFAULT 'read',
  expires_at     TEXT NOT NULL,
  used_at        TEXT,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_expiry ON oauth_codes(expires_at);

-- Which app a token belongs to. NULL for tokens a person made by hand in Settings.
ALTER TABLE api_tokens ADD COLUMN client_id TEXT;
