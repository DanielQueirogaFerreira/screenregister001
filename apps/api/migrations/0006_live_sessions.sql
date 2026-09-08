-- Which recordings are actually happening right now.
--
-- A session row is written when capture starts and completed when it stops, so
-- `ended_at IS NULL` was the only available answer to "is this recording?" — and it is a
-- bad one. It cannot tell a capture that is running from one whose browser was closed,
-- crashed or put to sleep, and those look identical forever. That ambiguity is exactly why
-- the library had zero-frame rows nobody could explain.
--
-- A heartbeat resolves it. The recording browser touches its session every few seconds;
-- live means "seen recently", which decays correctly on its own when a browser goes away
-- and needs no cleanup process to be right.
--
-- This is also what lets a second browser, signed in as the same person, see a recording
-- that is running on the first. The client holds capture in memory, so nothing but the
-- server can carry that fact between two devices.

ALTER TABLE sessions ADD COLUMN last_seen_at TEXT;

-- A stop asked for from somewhere else. The recording browser reads this on its next
-- heartbeat and stops itself, which is the only way that can work: nothing outside that
-- browser can reach into it and release the screen-capture stream.
ALTER TABLE sessions ADD COLUMN stop_requested_at TEXT;

-- Existing open rows have never sent a heartbeat, so they must not appear as live. NULL
-- already sorts that way in the query, and this makes the intent explicit for anyone
-- reading the table.
UPDATE sessions SET last_seen_at = NULL WHERE ended_at IS NULL;

-- "What is recording right now", for this user and for an operator across all of them.
CREATE INDEX IF NOT EXISTS idx_sessions_live ON sessions(ended_at, last_seen_at DESC);
