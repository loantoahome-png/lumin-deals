-- Webhook enrichment columns (2026-07-16). Run in the Supabase SQL editor.
--
-- Deploy order does NOT matter: the webhook writes these two columns in a
-- separate best-effort update (non-fatal warn until the columns exist), so the
-- code can ship before or after this migration without breaking updates.

ALTER TABLE deals ADD COLUMN IF NOT EXISTS vendor_lead_id text;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS last_inbound_message text;

COMMENT ON COLUMN deals.vendor_lead_id IS
  'The VENDOR''s own lead id (GHL "Lead ID" contact custom field, 92% fill) — Lendgo/FRU refund & dispute reconciliation. Written by the GHL webhook on each matched update.';
COMMENT ON COLUMN deals.last_inbound_message IS
  'Latest inbound message text snippet (<=400 chars), written real-time by the GHL reply webhook (customData.event=inbound_message). Email bodies are noisy (footers/marketing); SMS is the signal. Channel enum: 1=Call 2=SMS 3=Email.';
