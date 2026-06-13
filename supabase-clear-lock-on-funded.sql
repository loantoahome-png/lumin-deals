-- Clear a deal's rate-lock expiration once it reaches a funded status.
-- A rate lock only matters while a loan is in process; once it funds the
-- lock_expiration date is stale and shouldn't linger in the UI. Enforced at the
-- DB layer so it applies no matter which path moves the loan to funded:
-- Arive import, GHL sync/webhook, manual edit on the deal page, or kanban drag.
--
-- Funded set = Loan Funded / Broker Check Received / Loan Finalized (matches the
-- app's FUNDED_STATUSES). We gate on STATUS, not pipeline_group, for the same
-- reason the lock-alerts cron does: status is the authoritative funded signal.
--
-- Run once in the Supabase SQL editor.

-- 1. Trigger function: null out lock_expiration whenever the row lands on a
--    funded status. Idempotent — nulling an already-null value is a no-op, so a
--    funded row can never re-acquire a lock date (e.g. a stray manual entry is
--    wiped on save).
CREATE OR REPLACE FUNCTION clear_lock_expiration_on_funded()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IN ('Loan Funded', 'Broker Check Received', 'Loan Finalized')
     AND NEW.lock_expiration IS NOT NULL THEN
    NEW.lock_expiration := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. Fire it before every insert/update so it catches both transitions into a
--    funded status AND inserts that land directly on one (Arive can import an
--    already-funded loan).
DROP TRIGGER IF EXISTS trg_clear_lock_expiration_on_funded ON deals;
CREATE TRIGGER trg_clear_lock_expiration_on_funded
  BEFORE INSERT OR UPDATE ON deals
  FOR EACH ROW
  EXECUTE FUNCTION clear_lock_expiration_on_funded();

-- 3. One-time backfill for loans that already funded carrying a stale lock date.
--    (Safe to re-run; the trigger keeps it clean afterward.)
UPDATE deals
  SET lock_expiration = NULL
  WHERE status IN ('Loan Funded', 'Broker Check Received', 'Loan Finalized')
    AND lock_expiration IS NOT NULL;
