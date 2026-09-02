-- =============================================
-- Lumin Lending — Arive Import Log
-- Run this entire file in the Supabase SQL Editor.
-- =============================================
--
-- `deals` keeps no history (one updated_at, no prior values), so "what did that
-- import change?" was unanswerable after the fact — the 2026-09-02 import wrote
-- 576 fields across 309 deals and only the tiles survived. This log records, per
-- commit, EVERY field the importer actually wrote: deal, field, old → new, and
-- whether it was a blank-fill, an overwrite, or part of a newly created loan.
--
-- Written by app/api/import/arive/route.ts (via lib/importLog.ts) at the end of a
-- commit. Read by app/api/import/arive/history and the /import/arive/history page.
-- Preview never writes here.

CREATE TABLE IF NOT EXISTS import_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL DEFAULT 'arive',        -- which importer ('arive' today)
  filename TEXT,                               -- the uploaded CSV's name (e.g. "DB Import - 2026-09-02T20_45_40.818Z.csv")
  mode TEXT NOT NULL,                          -- 'fill_blanks' | 'overwrite'
  protected_fields TEXT[] NOT NULL DEFAULT '{}',-- fields shielded from overwrite for this run
  rows_total INT NOT NULL DEFAULT 0,           -- CSV rows
  matched INT NOT NULL DEFAULT 0,
  unmatched INT NOT NULL DEFAULT 0,
  updated INT NOT NULL DEFAULT 0,              -- deals updated
  created INT NOT NULL DEFAULT 0,              -- deals inserted (new loans)
  fields_written INT NOT NULL DEFAULT 0,       -- total fields written (incl. derived pipeline_group)
  fill_count INT NOT NULL DEFAULT 0,           -- blank → value
  overwrite_count INT NOT NULL DEFAULT 0,      -- value → different value
  create_count INT NOT NULL DEFAULT 0,         -- fields on newly inserted deals
  error_count INT NOT NULL DEFAULT 0,
  summary JSONB                                -- the preview summary as the importer saw it
);

CREATE TABLE IF NOT EXISTS import_changes (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES import_runs(id) ON DELETE CASCADE,
  deal_id UUID,                                -- deals.id (null only if the insert failed to return one)
  borrower TEXT,
  arive_file_no TEXT,
  field TEXT NOT NULL,                         -- deals column name
  old_value TEXT,                              -- stringified prior value (null = was blank)
  new_value TEXT,                              -- stringified written value
  action TEXT NOT NULL                         -- 'fill' | 'overwrite' | 'create'
);

-- One run's changes, grouped by deal.
CREATE INDEX IF NOT EXISTS import_changes_run_idx ON import_changes(run_id, deal_id);
-- "What has every import ever done to this deal?" — the deal-page question.
CREATE INDEX IF NOT EXISTS import_changes_deal_idx ON import_changes(deal_id, id);
-- Recent runs first.
CREATE INDEX IF NOT EXISTS import_runs_created_idx ON import_runs(created_at DESC);

-- RLS ON with NO policies — server-only via the service-role client (same rule as
-- stage_events). The browser never reads these tables directly.
ALTER TABLE import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_changes ENABLE ROW LEVEL SECURITY;
