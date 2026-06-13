-- Stamp funded_date when a loan first crosses into a funded status via ANY path.
-- Only the Arive import sets funded_date today; loans funded via GHL (sync/webhook)
-- or a manual/kanban status change get none, so they can't be placed in a funding
-- month (they fall to "All time" only on the Lead Spend report). This gives them a
-- provisional funded date the moment they fund; the Arive import later overwrites it
-- with the true close date (Arive stays authoritative).
--
-- TRANSITION-GUARDED: fires only when a row crosses FROM a non-funded status INTO a
-- funded one (or is inserted directly funded) AND has no funded_date yet. So it never
-- stamps a date onto the existing funded rows that are missing one (their real funding
-- month is unknown — leave them null rather than fake "today").
--
-- Run once in the Supabase SQL editor.

CREATE OR REPLACE FUNCTION set_funded_date_on_funding()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IN ('Loan Funded', 'Broker Check Received', 'Loan Finalized')
     AND NEW.funded_date IS NULL
     AND (
       TG_OP = 'INSERT'
       OR OLD.status IS NULL
       OR OLD.status NOT IN ('Loan Funded', 'Broker Check Received', 'Loan Finalized')
     )
  THEN
    NEW.funded_date := CURRENT_DATE;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_funded_date_on_funding ON deals;
CREATE TRIGGER trg_set_funded_date_on_funding
  BEFORE INSERT OR UPDATE ON deals
  FOR EACH ROW
  EXECUTE FUNCTION set_funded_date_on_funding();
