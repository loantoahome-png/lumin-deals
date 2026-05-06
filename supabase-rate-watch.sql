-- =============================================
-- Run this in Supabase SQL Editor
-- Rate Watch columns for 10yr Treasury alerts
-- =============================================

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS rate_watch_active     BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS rate_at_close_10yr    NUMERIC,
  ADD COLUMN IF NOT EXISTS rate_watch_notes      TEXT,
  ADD COLUMN IF NOT EXISTS rate_watch_alerted_at TIMESTAMPTZ;

-- Fast lookup of active watches
CREATE INDEX IF NOT EXISTS deals_rate_watch_active_idx
  ON deals (rate_watch_active)
  WHERE rate_watch_active = TRUE;
