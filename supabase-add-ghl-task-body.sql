-- GHL task descriptions on the board.
--
-- The mirror shipped without descriptions on the stated grounds that "the search
-- row has NO body/description — only the single-task GET does", which would have
-- cost one extra GET per task per sweep. That claim was WRONG: it was generalised
-- from a sample of tasks that simply had none set.
--
-- Verified live 2026-08-05 across BOTH configured locations — 105 search rows
-- (27+14 primary, 49+15 matt): `body` is in the payload, non-empty on 10 of them,
-- HTML on 8 (only <p>), 18-200 chars. So the description is already in the sweep's
-- existing response and costs nothing extra to keep.
--
-- Stored RAW, exactly as GHL returns it. The HTML → plain text conversion is a
-- presentation concern and lives in toBoardTask(), so this column stays a faithful
-- mirror of the source.
--
-- ⚠️ APPLY THIS BEFORE DEPLOYING THE CODE. syncGhlTasks upserts the whole mapped
-- row (`{ ...r, last_seen_at, updated_at }`); with `body` in the object but not in
-- the table, PostgREST rejects the upsert, the location is skipped un-pruned, and
-- no new GHL task reaches the board until this lands.
--
-- Apply via Supabase SQL editor, or the Management API recipe in GOTCHAS.md.

ALTER TABLE ghl_tasks ADD COLUMN IF NOT EXISTS body TEXT;

COMMENT ON COLUMN ghl_tasks.body IS
  'GHL task description, raw from the tasks/search row (usually <p>-wrapped HTML). Converted to plain text for the board in toBoardTask().';

SELECT 'ghl_tasks.body ready' AS status;
