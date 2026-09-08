-- Device on the frame, not only on the session it belongs to.
--
-- A frame quoted on its own could answer "when" (from its ULID) and "whose" (user_id) but
-- not "on what machine" — that needed a join back to sessions. Since the frame is the unit
-- an assistant reads, and the unit a stamp identifies, the three facts that place a moment
-- belong on the row itself.
--
-- The value is written by the server from the session's own row, never from the request
-- body: a client that could name its own device could attribute a frame to a machine it
-- has never seen.

ALTER TABLE frames ADD COLUMN device_id TEXT NOT NULL DEFAULT '';

-- Existing frames already have exactly one correct answer, through their session.
UPDATE frames
   SET device_id = COALESCE(
         (SELECT s.device_id FROM sessions s WHERE s.session_id = frames.session_id), '')
 WHERE device_id = '';

-- "Everything this machine recorded, in order" — the query a per-device view runs, and one
-- the join could not serve without scanning.
CREATE INDEX IF NOT EXISTS idx_frames_device_time ON frames(device_id, captured_at);
