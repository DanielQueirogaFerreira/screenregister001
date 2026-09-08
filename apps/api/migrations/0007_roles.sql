-- Operator access.
--
-- The role is NOT stored here, deliberately, and this migration adds no column for it.
-- It is derived on every request from the ADMIN_EMAILS Worker variable, because the thing
-- an admin can do — see and delete every account's recordings — is the most dangerous
-- capability in the system, and a role in a table is one SQL injection or one careless
-- UPDATE away from being granted to the wrong person. A Worker variable cannot be changed
-- by anything the application does to itself; it takes access to the Cloudflare account.
--
-- What this migration adds is the record of what operators actually did.

CREATE TABLE IF NOT EXISTS admin_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  actor_id     TEXT NOT NULL,          -- the admin's user_id
  actor_email  TEXT NOT NULL,
  action       TEXT NOT NULL,          -- 'view_users' | 'delete_session' | 'request_stop' | ...
  subject_id   TEXT,                   -- the user or session acted upon
  detail       TEXT,
  ip           TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_events_at ON admin_events(at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_events_actor ON admin_events(actor_id, at DESC);
