-- The three-way outcome of reading a frame, and the queue that follows from it.
--
-- enrich_status has existed since 0001 with a default of 'pending' and nothing ever set
-- it. It becomes the state machine now:
--
--   pending        nothing has looked at this frame yet
--   text           text was read; the transcript and the secret scan ran on real input
--   no_text        the reader ran cleanly and found nothing to read — finished
--   inconclusive   the reader could not say; stored, marked, and owed a second look
--   analysed       the server's second layer has since examined it
--
-- The distinction that matters is no_text versus inconclusive. Both come back as zero
-- usable words, and treating them alike would file the least examined frame on the system
-- as the safest one on it. An inconclusive frame is stored WITHOUT text-secret masking,
-- because there was no text to scan — so every consumer has to be able to see that, which
-- is why this is a column and not a log line.

-- Why the reader reached that verdict, in its own words. Kept for the frame inspector and
-- for arguing with a threshold later.
ALTER TABLE frames ADD COLUMN scan_reason TEXT;

-- Mean confidence of the read, 0..1. The number the verdict turned on.
ALTER TABLE frames ADD COLUMN ocr_confidence REAL;

-- How long the read took, in milliseconds. Feeds the cost panel, and makes a machine that
-- is quietly struggling visible before somebody notices the recorder falling behind.
ALTER TABLE frames ADD COLUMN ocr_ms INTEGER;

-- Frames owed a second look, oldest first. Partial index: the queue is the small minority
-- of rows, and indexing the rest would cost storage to describe work that does not exist.
CREATE INDEX IF NOT EXISTS idx_frames_enrich_queue
  ON frames(enrich_status, captured_at)
  WHERE enrich_status IN ('pending', 'inconclusive');
