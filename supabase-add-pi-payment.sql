-- =============================================
-- Run this in the Supabase SQL Editor.
-- Adds the monthly Principal & Interest payment, imported from the Arive
-- export column "First Mortgage Payment". Distinct from `housing_payment`
-- (Arive "Total Housing Payment" = full PITI). Surfaced on the deal-detail
-- panel and the new-deal form next to Total Housing Payment.
-- =============================================

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS pi_payment NUMERIC;
