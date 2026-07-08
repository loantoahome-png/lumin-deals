-- =============================================
-- Lumin Lending — Stage-Change Event Log
-- Run this entire file in the Supabase SQL Editor.
-- =============================================
--
-- Forward-only append log of GHL opportunity stage changes. Powers the
-- Lead Cohort Responsiveness report's "first became responded" timing.
--
-- IMPORTANT: this log only holds events from the moment it goes live. A lead
-- that crossed into a responded stage BEFORE the first row here has NO event
-- and its window timing is "unknown" (never a non-response). The report keeps
-- that distinction (see lib/cohortReport.ts) and surfaces a timing-coverage %.
--
-- Written by app/api/webhooks/ghl/route.ts (via lib/stageEvents.ts) on every
-- real stage move. Read by app/api/stage-events/first-responded (service role).

CREATE TABLE IF NOT EXISTS stage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Join keys
  opportunity_id TEXT,          -- GHL opportunity (loan) id → joins deals.ghl_opportunity_id
  contact_id     TEXT,          -- GHL contact id
  deal_id        UUID,          -- our deals.id at log time (convenience; nullable)

  -- Transition (GHL stage ids when the payload carries them)
  from_stage_id  TEXT,
  to_stage_id    TEXT,

  -- Transition resolved into OUR vocabulary (lib/webhooks GHL_STAGE_MAP)
  from_status       TEXT,       -- status before the move (null if unknown)
  to_status         TEXT NOT NULL,
  to_pipeline_group TEXT,       -- Leads | Loans in Process | Funded | Not Ready

  -- Precomputed so "first responded" is a cheap indexed query. Set at write
  -- time with the SAME definition the report uses (isRespondedStatus, single
  -- source of truth in lib/leadReport.ts). Ghosted counts as responded.
  to_responded   BOOLEAN NOT NULL DEFAULT false,

  -- Context
  pipeline_id    TEXT,
  loan_officer   TEXT,          -- resolved LO (Matt / Moe) at event time
  assigned_to    TEXT,          -- raw GHL assignedTo (id or name)

  -- When the change happened (payload timestamp if present, else insert time)
  event_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- When WE logged it
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- All events for one opportunity, chronological.
CREATE INDEX IF NOT EXISTS stage_events_opp_idx ON stage_events(opportunity_id, event_at);
-- "First time each opp became responded" — the report's hot path.
CREATE INDEX IF NOT EXISTS stage_events_responded_idx
  ON stage_events(opportunity_id, event_at) WHERE to_responded;
-- Recent-activity scans.
CREATE INDEX IF NOT EXISTS stage_events_event_at_idx ON stage_events(event_at DESC);

-- Internal app, all users are trusted team members — mirror the deals table.
-- (Reads/writes go through the service-role client anyway, which bypasses RLS.)
ALTER TABLE stage_events DISABLE ROW LEVEL SECURITY;
