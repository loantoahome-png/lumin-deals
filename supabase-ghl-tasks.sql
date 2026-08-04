-- GoHighLevel open tasks, mirrored onto the dashboard task board.
-- Spec: docs/specs/2026-08-03-ghl-tasks-two-way-spec.md
--
-- ONLY INCOMPLETE tasks are stored (65 across both locations at build time: 18
-- primary + 47 Matt). Completing a task — here or in GHL — drops it out of the
-- sweep and the row is DELETED, exactly like fub_tasks. There is no completed
-- history: GHL owns that.
--
-- Two-way: the dashboard's checkbox calls PUT /contacts/{contactId}/tasks/{id}
-- /completed on GHL, then deletes the local row so the board updates instantly
-- instead of waiting for the next 15-min sweep.
--
-- Apply via Supabase SQL editor, or the Management API recipe in GOTCHAS.md.

CREATE TABLE IF NOT EXISTS ghl_tasks (
  ghl_task_id      TEXT PRIMARY KEY,          -- GHL task id
  location_id      TEXT NOT NULL,             -- which sub-account owns it (picks the API key)
  contact_id       TEXT,                      -- GHL contact the task hangs on
  deal_id          UUID REFERENCES deals(id) ON DELETE SET NULL,  -- resolved at sync time, may be null
  contact_name     TEXT,                      -- so an unmatched task still names a person
  title            TEXT,                      -- the task text
  assignee         TEXT,                      -- resolveLO()'d GHL user name → board column
  assigned_user_id TEXT,                      -- GHL user id (kept for debugging / future write-back)
  due_at           TIMESTAMPTZ,               -- GHL dueDate (always set in practice)
  status           TEXT,                      -- to_do | in_progress | … (GHL's statusGroup)
  ghl_created_at   TIMESTAMPTZ,
  ghl_updated_at   TIMESTAMPTZ,
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ghl_tasks_assignee_due_idx ON ghl_tasks (assignee, due_at);
CREATE INDEX IF NOT EXISTS ghl_tasks_deal_idx         ON ghl_tasks (deal_id);
CREATE INDEX IF NOT EXISTS ghl_tasks_contact_idx      ON ghl_tasks (contact_id);

-- Same team policy as fub_tasks / fub_people / contacts.
ALTER TABLE ghl_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ghl_tasks_team_rw ON ghl_tasks;
CREATE POLICY ghl_tasks_team_rw ON ghl_tasks
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

SELECT 'ghl_tasks ready' AS status;
