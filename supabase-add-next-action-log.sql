-- Next-step log (2026-06-29).
-- Timestamped history of a deal's "Next Step" entries (newest first), stored as a
-- JSONB array like `communications` / `documents`. `next_action` still holds the
-- latest entry's text so existing filters/sorts are unaffected. The GHL sync does
-- NOT touch this column.
--
-- Run in the Supabase SQL editor BEFORE deploying (the escrow card writes it).
alter table public.deals
  add column if not exists next_action_log jsonb;
