-- =============================================
-- Lumin Deals — Contacts (Phase 2)
-- One row per PERSON. id = the canonical borrower_id produced by the identity
-- resolver (Phase 1), so deals.borrower_id is ALREADY the foreign key — no change
-- to the deals table. Maintained automatically by the identity-resolution pass
-- (every 30 min via the maintenance cron, and on /api/resolve-identities apply).
-- Run this whole file once in the Supabase SQL Editor.
-- =============================================

CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY,                 -- = canonical deals.borrower_id

  -- Identity (best current values across the person's loans)
  display_name TEXT,
  email TEXT,
  phone TEXT,
  ghl_contact_ids TEXT[] DEFAULT '{}', -- every per-sub-account GHL contact id for this person

  -- Rollups across all of the person's loans
  loan_count          INTEGER NOT NULL DEFAULT 0,
  funded_count        INTEGER NOT NULL DEFAULT 0,
  total_funded_volume NUMERIC NOT NULL DEFAULT 0,   -- Σ loan_amount on funded loans
  total_comp          NUMERIC NOT NULL DEFAULT 0,   -- Σ compensation_amount on funded loans
  first_loan_at       TIMESTAMPTZ,
  last_loan_at        TIMESTAMPTZ,

  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Access: the dashboard PAGES read with the logged-in user's session (the
-- `authenticated` role), so that role needs a read/write policy or it sees zero rows
-- (the resolver writes via `service_role`, which bypasses RLS). Mirror how the app
-- reaches the other tables — team members are all trusted.
GRANT SELECT, INSERT, UPDATE, DELETE ON contacts TO authenticated;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contacts_team_rw ON contacts;
CREATE POLICY contacts_team_rw ON contacts
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- Helpful for the contacts list ordering / search.
CREATE INDEX IF NOT EXISTS contacts_last_loan_at_idx ON contacts (last_loan_at DESC);
CREATE INDEX IF NOT EXISTS contacts_display_name_idx ON contacts (display_name);
