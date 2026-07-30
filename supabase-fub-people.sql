-- FollowUpBoss people mirror + follow-up cockpit state.
-- Spec: docs/specs/2026-07-30-follow-up-cockpit-spec.md
-- Research: docs/research/2026-07-30-followupboss-api.md
--
-- Populated by POST /api/sync/fub (full sweep of Moe's + Matt's agent keys,
-- deduped by fub_id; ownership = FUB assignedUserId, NOT which key saw the row).
-- The cockpit-state columns (next_action_due, next_action, last_touched_at,
-- last_touch_note) are written ONLY by the /follow-up UI — the sync must never
-- overwrite them (same discipline as deals.next_action_due, which the GHL sync
-- never writes).
--
-- Apply via Supabase SQL editor, or the Management API recipe in GOTCHAS.md
-- ("Running DDL against prod Supabase without psql/CLI").

CREATE TABLE IF NOT EXISTS fub_people (
  fub_id            BIGINT PRIMARY KEY,          -- FUB person id (account-wide unique)
  name              TEXT,
  first_name        TEXT,
  last_name         TEXT,
  stage             TEXT,                        -- FUB stage name (17 known, e.g. 'Lead', 'Past Client')
  source            TEXT,
  assigned_user_id  BIGINT,                      -- FUB user id: 72=Moe, 13=Matt, 35=Randy
  assigned_to       TEXT,                        -- FUB display name as-is
  loan_officer      TEXT,                        -- resolveLO()-normalized ('Moe Sefati' | 'Matt Park' | …)
  primary_email     TEXT,                        -- normEmail() of primary (matching key)
  primary_phone     TEXT,                        -- normPhone() of primary (matching key)
  emails            JSONB,                       -- full array [{value,type,isPrimary,status}]
  phones            JSONB,
  tags              JSONB,                       -- their quarterly-tag cadence lives here
  price             NUMERIC,
  deal_name         TEXT,                        -- FUB's flattened current-deal fields
  deal_stage        TEXT,
  deal_status       TEXT,
  deal_price        NUMERIC,
  deal_close_date   DATE,
  address_city      TEXT,
  address_state     TEXT,
  custom_fields     JSONB,                       -- customHomebot*, customLPLoanNumber, … (sparse)
  fub_created_at    TIMESTAMPTZ,
  fub_updated_at    TIMESTAMPTZ,
  last_activity_at  TIMESTAMPTZ,                 -- FUB lastActivity — the staleness signal

  -- Cross-system identity: normalized email/phone match against deals.
  matched_deal_id     UUID,
  matched_deal_active BOOLEAN NOT NULL DEFAULT FALSE,  -- matched deal is open (GHL flow owns the person)

  -- Cockpit state — UI-owned, sync NEVER writes these four.
  next_action_due   TIMESTAMPTZ,
  next_action       TEXT,
  last_touched_at   TIMESTAMPTZ,
  last_touch_note   TEXT,

  -- Sweep bookkeeping.
  seen_by_keys      TEXT[] NOT NULL DEFAULT '{}',  -- which agent keys saw it last sweep ('moe','matt')
  missing_since     TIMESTAMPTZ,                   -- set when a sweep no longer sees the id; queue excludes
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fub_people_lo_stage_idx      ON fub_people (loan_officer, stage);
CREATE INDEX IF NOT EXISTS fub_people_last_activity_idx ON fub_people (last_activity_at);
CREATE INDEX IF NOT EXISTS fub_people_next_due_idx      ON fub_people (next_action_due);
CREATE INDEX IF NOT EXISTS fub_people_email_idx         ON fub_people (primary_email);
CREATE INDEX IF NOT EXISTS fub_people_phone_idx         ON fub_people (primary_phone);

-- Same team policy as contacts (supabase-contacts.sql): the dashboard reads and
-- writes cockpit state client-side as an authenticated user; anon gets nothing.
ALTER TABLE fub_people ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fub_people_team_rw ON fub_people;
CREATE POLICY fub_people_team_rw ON fub_people
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

SELECT 'fub_people ready' AS status;
