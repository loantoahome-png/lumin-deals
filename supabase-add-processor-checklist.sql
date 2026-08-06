-- =============================================
-- Run this in the Supabase SQL Editor BEFORE deploying the checklist feature.
--
-- ⚠️ MIGRATION BEFORE DEPLOY (see GOTCHAS.md). The checklist page reads and
--    writes `deals.processor_checklist`; shipping the code first means every
--    save silently fails against a column that isn't there.
--
-- Adds the per-deal Processor Checklist. JSONB array, same pattern as
-- `communications` / `next_action_log` / `reo_properties`.
--
-- Shape of each element (see lib/processorChecklist.ts — that file is the
-- source of truth for the item list; this column only stores STATE):
--   { id: string, done_at: string|null, done_by: string|null, note: string|null }
--
-- NULL = never opened. An empty array is a real "seeded but nothing done yet",
-- so the two are deliberately distinguishable.
-- =============================================

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS processor_checklist JSONB;

COMMENT ON COLUMN deals.processor_checklist IS
  'Per-deal processor checklist state. Item definitions live in lib/processorChecklist.ts; this stores only {id, done_at, done_by, note}. NULL = never opened.';
