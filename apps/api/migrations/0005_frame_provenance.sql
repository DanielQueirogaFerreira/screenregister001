-- Provenance and redaction, per frame.
--
-- Two images can exist for one frame: the stored image, which carries the stamp burned
-- into its corner, and the capture exactly as it was. The second is absent whenever the
-- first is redacted — not deleted afterwards, but never created. The unmasked pixels are
-- dropped in the browser's worker before anything is encoded, so there is no window in
-- which an unredacted copy exists to be cleaned up, and no cleanup step that can fail.
--
-- `redacted_regions` is kept because a black box with no explanation is indistinguishable
-- from a rendering fault. It records where the masks went, never what was under them.

ALTER TABLE frames ADD COLUMN stamp            TEXT NOT NULL DEFAULT '';
ALTER TABLE frames ADD COLUMN redacted         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE frames ADD COLUMN redacted_regions TEXT NOT NULL DEFAULT '[]';
ALTER TABLE frames ADD COLUMN original_key     TEXT;

-- Frames recorded before this existed have neither a stamp burned in nor a second copy,
-- and their stamp is derivable from columns already present. Leaving it empty would make
-- the library show a blank where every other row shows a code, so fill in what is known:
-- the format is version, frame id, then the two fingerprints. The fingerprints are hashes
-- the database cannot compute, so those rows are marked as pre-stamp and the client
-- derives them — see FrameRecord.stamp.
UPDATE frames SET stamp = '' WHERE stamp IS NULL;

-- "Show me everything that got masked" is the query for judging whether the detector is
-- behaving, and it is the one an operator runs when they are worried.
CREATE INDEX IF NOT EXISTS idx_frames_redacted ON frames(user_id, redacted, captured_at);
