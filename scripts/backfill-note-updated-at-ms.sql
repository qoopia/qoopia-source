-- PREPARED ARTIFACT ONLY. Do not run without the approved backup + GO in
-- docs/operations/note-updated-at-ms-backfill.md.
--
-- Historical second-precision timestamps cannot recover subsecond ordering.
-- Equal updated_at values therefore remain equal after this repair.

BEGIN IMMEDIATE;

UPDATE notes
   SET updated_at_ms =
       CAST(strftime('%s', updated_at) AS INTEGER) * 1000
       + COALESCE(CAST(substr(strftime('%f', updated_at), 4, 3) AS INTEGER), 0)
 WHERE updated_at_ms = 0
   AND strftime('%s', updated_at) IS NOT NULL;

COMMIT;
