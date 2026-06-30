-- Dedup column for the Clear-to-Close + Non-Del funding-coordination alert
-- (app/api/cron/ctc-nondel-alerts). Stores when the one-time alert was sent for
-- a loan, so the cron never re-fires for the same loan on subsequent runs.
--
-- Run this once in the Supabase SQL editor BEFORE registering the cron. Until
-- it's run, the cron fails safe (sends nothing) and reports `migration_needed`.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS ctc_nondel_alerted_at timestamptz;
