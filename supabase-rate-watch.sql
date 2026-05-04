-- =============================================
-- Run this in Supabase SQL Editor
-- Adds rate watch columns to deals table
-- =============================================

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS rate_watch_active     BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS rate_watch_target     NUMERIC,
  ADD COLUMN IF NOT EXISTS rate_watch_notes      TEXT,
  ADD COLUMN IF NOT EXISTS rate_watch_alerted_at TIMESTAMPTZ;

-- Index for fast lookup of active watches
CREATE INDEX IF NOT EXISTS deals_rate_watch_active_idx
  ON deals (rate_watch_active)
  WHERE rate_watch_active = TRUE;
