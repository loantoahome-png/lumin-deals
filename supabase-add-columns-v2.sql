-- =============================================
-- Run this in Supabase SQL Editor
-- Adds all new GHL custom field columns
-- =============================================

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS loan_purpose       TEXT,
  ADD COLUMN IF NOT EXISTS property_type      TEXT,
  ADD COLUMN IF NOT EXISTS credit_rating      TEXT,
  ADD COLUMN IF NOT EXISTS current_balance    NUMERIC,
  ADD COLUMN IF NOT EXISTS ltv                NUMERIC,
  ADD COLUMN IF NOT EXISTS cash_out           NUMERIC,
  ADD COLUMN IF NOT EXISTS down_payment       NUMERIC,
  ADD COLUMN IF NOT EXISTS is_military        TEXT,
  ADD COLUMN IF NOT EXISTS current_va_loan    TEXT,
  ADD COLUMN IF NOT EXISTS property_found     TEXT,
  ADD COLUMN IF NOT EXISTS loan_timeframe     TEXT,
  ADD COLUMN IF NOT EXISTS has_accepted_offer TEXT;
