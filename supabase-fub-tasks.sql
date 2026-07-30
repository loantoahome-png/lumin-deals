-- FollowUpBoss open tasks (the LO's own follow-up reminders, created in FUB).
-- Spec: docs/specs/2026-07-30-follow-up-cockpit-spec.md (tasks addendum 2026-07-30)
--
-- ONLY INCOMPLETE tasks are stored (975 across both LOs at build time). A task
-- that gets completed in FUB simply drops out of the sweep and is DELETED here —
-- there is no missing_since bookkeeping, because "gone from the sweep" means
-- "done or deleted", and either way it is off the follow-up list.
--
-- Tasks are strictly per-key in FUB (Moe's key returns only Moe's tasks), so
-- loan_officer is unambiguous and no dedupe is needed.
--
-- Apply via Supabase SQL editor, or the Management API recipe in GOTCHAS.md.

CREATE TABLE IF NOT EXISTS fub_tasks (
  fub_task_id      BIGINT PRIMARY KEY,       -- FUB task id
  person_id        BIGINT,                   -- FUB person id → fub_people.fub_id
  assigned_user_id BIGINT,                   -- 72=Moe, 13=Matt
  loan_officer     TEXT,                     -- resolved LO name
  name             TEXT,                     -- the task text — often a real note
  type             TEXT,                     -- Follow Up | Call | Text | Email | Appointment | …
  due_date         DATE,                      -- FUB's date-only due date (compared as YMD)
  due_date_time    TIMESTAMPTZ,               -- set only when the task has a time
  fub_created_at   TIMESTAMPTZ,
  fub_updated_at   TIMESTAMPTZ,
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fub_tasks_lo_due_idx  ON fub_tasks (loan_officer, due_date);
CREATE INDEX IF NOT EXISTS fub_tasks_person_idx  ON fub_tasks (person_id);

-- Same team policy as fub_people / contacts.
ALTER TABLE fub_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fub_tasks_team_rw ON fub_tasks;
CREATE POLICY fub_tasks_team_rw ON fub_tasks
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

SELECT 'fub_tasks ready' AS status;
