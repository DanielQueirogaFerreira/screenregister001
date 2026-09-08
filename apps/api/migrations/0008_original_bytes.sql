-- What the second copy actually costs.
--
-- `frames.bytes` is the size of the stored image, and the usage figure sums it. When an
-- untouched capture is kept alongside — which has been the default since burn-in shipped —
-- R2 holds roughly twice that and nothing counted it. So the number a person reads when
-- deciding whether their storage is under control has been about half the truth, which is
-- the worst way for a storage figure to be wrong.
--
-- Recorded separately rather than folded into `bytes` so the split stays visible: the
-- question "how much is the second copy costing me" has an answer, and turning it off has
-- a measurable effect rather than an asserted one.

ALTER TABLE frames ADD COLUMN original_bytes INTEGER NOT NULL DEFAULT 0;

-- Rows written before this column existed cannot be measured retroactively — the object is
-- in R2 but its size was never recorded, and reading every one of them to find out would
-- cost more than the answer is worth. They keep 0, and the frames written from now on are
-- counted honestly. The usage panel says so rather than quietly presenting a mixed total
-- as though it were complete.
