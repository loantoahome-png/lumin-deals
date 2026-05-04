-- =============================================
-- Run this in Supabase SQL Editor to add new columns
-- =============================================

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS city TEXT,
  ADD COLUMN IF NOT EXISTS state TEXT,
  ADD COLUMN IF NOT EXISTS zip TEXT,
  ADD COLUMN IF NOT EXISTS credit_score NUMERIC,
  ADD COLUMN IF NOT EXISTS ghl_tags TEXT,
  ADD COLUMN IF NOT EXISTS ghl_assigned_user TEXT,
  ADD COLUMN IF NOT EXISTS date_added_ghl TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS raw_ghl_data JSONB;

-- Index for fast JSONB queries on raw GHL data
CREATE INDEX IF NOT EXISTS deals_raw_ghl_data_idx ON deals USING GIN (raw_ghl_data);
