-- Which clock the recording machine was keeping.
--
-- Frames already carry tz_offset_minutes, and an offset is enough to render a local time.
-- It is not enough to answer "which machine made this, and is its clock configured
-- correctly" — UTC-4 is Eastern in summer and Atlantic all year, and an offset alone
-- cannot tell a laptop that moved from one that did not.
--
-- The IANA name can, and it belongs on the session rather than the frame: it is one fact
-- per recording, not one per frame, and at tens of thousands of frames an hour a
-- twenty-byte string repeated on every row is storage spent to say the same thing again.
-- The per-frame offset stays where it is, because that genuinely can change mid-session
-- when a recording runs across a daylight saving boundary.
--
-- Nullable: sessions recorded before this, and browsers that decline to report a zone.
ALTER TABLE sessions ADD COLUMN tz_name TEXT;
ALTER TABLE sessions ADD COLUMN tz_offset_minutes INTEGER;
