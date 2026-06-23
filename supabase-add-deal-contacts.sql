-- =============================================
-- Run this in the Supabase SQL Editor.
-- Co-borrower support: links additional people (role='co') to a loan.
-- The PRIMARY borrower stays `deals.borrower_id` (unchanged); this table only
-- carries co-borrowers. `contacts.id` is the canonical borrower_id (Phase 1).
-- =============================================

CREATE TABLE IF NOT EXISTS deal_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id     uuid NOT NULL REFERENCES deals(id)    ON DELETE CASCADE,
  contact_id  uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'co',   -- 'co' (v1); 'primary' reserved for future
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deal_id, contact_id)
);

CREATE INDEX IF NOT EXISTS deal_contacts_deal_idx    ON deal_contacts(deal_id);
CREATE INDEX IF NOT EXISTS deal_contacts_contact_idx ON deal_contacts(contact_id);

-- Access: the dashboard pages read with the logged-in user's session (authenticated
-- role); the importer/API write via service_role (bypasses RLS). Mirror `contacts`.
GRANT SELECT, INSERT, UPDATE, DELETE ON deal_contacts TO authenticated;
ALTER TABLE deal_contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deal_contacts_team_rw ON deal_contacts;
CREATE POLICY deal_contacts_team_rw ON deal_contacts
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
