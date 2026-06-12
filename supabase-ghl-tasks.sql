-- GHL → Dashboard task mirror. Run once in the Supabase SQL editor.
-- Adds the columns the mirror needs on deal_tasks and a unique index so the
-- per-task upsert can dedupe by the GHL task id. NULL ghl_task_id (every manual
-- dashboard task) is allowed many times — Postgres treats NULLs as distinct —
-- while non-null GHL ids stay unique, which is exactly what ON CONFLICT needs.

ALTER TABLE deal_tasks
  ADD COLUMN IF NOT EXISTS ghl_task_id    text,
  ADD COLUMN IF NOT EXISTS ghl_contact_id text,
  ADD COLUMN IF NOT EXISTS source         text;   -- 'ghl' = mirrored from GHL; NULL = created on the dashboard

CREATE UNIQUE INDEX IF NOT EXISTS deal_tasks_ghl_task_id_key
  ON deal_tasks (ghl_task_id);
