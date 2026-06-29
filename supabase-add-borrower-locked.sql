-- Borrower-identity override (2026-06-29).
-- When TRUE, the GHL sync stops overwriting this deal's name/first_name/last_name/
-- email/phone. Set by "promote to primary" in the co-borrower manager, so a manually
-- chosen borrower (e.g. a co-borrower promoted to primary) is no longer reverted to
-- the GHL contact on the opportunity every 3-minute sync.
--
-- Run this in the Supabase SQL editor BEFORE deploying the code that selects it.
alter table public.deals
  add column if not exists borrower_locked boolean not null default false;
