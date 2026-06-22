-- =============================================
-- Run this in the Supabase SQL Editor.
-- Adds the "Processor Handoff" checkbox field used on the Active Escrows card.
-- ("Subbed on teams" reuses the existing `subbed` column — no change needed there.)
-- =============================================

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS processor_handoff BOOLEAN NOT NULL DEFAULT false;
