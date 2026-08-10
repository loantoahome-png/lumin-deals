-- =============================================
-- Lumin Lending — GHL Call Report import
-- Run this entire file in the Supabase SQL Editor.
-- =============================================
--
-- One row per call, imported from GHL's Reporting → Call report CSV export.
--
-- WHY CSV AND NOT AN API SYNC (verified live 2026-08-10, not from memory):
-- GHL exposes NO location-level call endpoint. /calls, /reporting/calls,
-- /phone-system/calls and /voice-ai/call-logs all 404 against a Private
-- Integration token. Call records exist only per-conversation via
-- /conversations/{id}/messages (messageType TYPE_CALL), and that payload carries
-- duration + status but NOT `Disposition` — the LO's own hand-tagged outcome
-- ("No Answer / Voicemail", "Not Interested", "Follow Up / Requested Call Back").
-- The CSV is therefore both the richer AND the only practical ingest path.
--
-- WHAT IS DELIBERATELY *NOT* STORED HERE:
--   * loan officer / lead owner — derived at read time by joining contact_phone
--     to deals.phone. Storing it would create a second copy of the truth that
--     silently drifts from `deals` (exactly how date_added_ghl froze). The DIALER
--     is stored, because it exists nowhere else; the OWNER is always derived.
--   * any rollup (dial counts, connect rates, talk time). Metrics are computed at
--     query time in lib/callsReport.ts so a changed definition corrects history.
--
-- THE ONE RULE THAT MATTERS WHEN READING THIS TABLE:
--   connected  ==  duration_sec > 0        -- NEVER call_status = 'Answered'
-- In the real export 724 rows are simultaneously call_status 'Answered' AND
-- disposition 'No Answer / Voicemail'. "Answered" is a carrier-level connect, not
-- a human picking up. Counting it as a conversation inflates connect rate by ~20pts.
--
-- TIMEZONE: call_ts is stored in UTC. The CSV emits the sub-account's LOCAL time
-- (America/Los_Angeles), converted once at import by lib/callsCsv.ts::ptToUtc.
-- Parsing the CSV time as UTC produces dials that land BEFORE their own lead-in
-- date — that is the tell that the conversion was skipped.

CREATE TABLE IF NOT EXISTS calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- When the call happened, in UTC (see TIMEZONE note above).
  call_ts             TIMESTAMPTZ NOT NULL,

  -- Join key → deals.phone (both normalized to the last 10 digits by normPhone).
  contact_phone       TEXT NOT NULL,
  contact_name        TEXT,

  direction           TEXT,          -- 'inbound' | 'outbound'
  call_status         TEXT,          -- raw CSV value. Retained for audit; NOT the connect signal.
  disposition         TEXT,          -- LO hand-tag; ~78% blank in practice
  duration_sec        INTEGER NOT NULL DEFAULT 0,   -- 0 when the CSV shows '-'

  -- WHO PLACED THE CALL. Not the lead owner: "Brianne's Number" appears in BOTH
  -- the Moe and Matt exports (2,427 and 2,056 calls), so the dialing number can
  -- never identify the sub-account or the LO.
  dialer_number_name  TEXT,
  dialer_number_phone TEXT,

  first_time          BOOLEAN,

  -- Which sub-account's export this row came from ('moe' | 'matt'). Tagged by the
  -- user at upload because it is NOT derivable from the file contents. Also drives
  -- the coverage guard: an LO with no imported export renders "no data", never 0%.
  account_label       TEXT NOT NULL,

  source_file         TEXT,
  imported_at         TIMESTAMPTZ DEFAULT NOW()
);

-- Makes re-importing the same export a no-op. Accepted cost: exactly one pair of
-- byte-identical rows exists in Moe's 3,507-row export (3,506 distinct), so this
-- key collapses one genuine call. Chosen deliberately — losing 1 call in 3,507
-- beats double-counting every call on every re-import.
CREATE UNIQUE INDEX IF NOT EXISTS calls_dedupe_uniq
  ON calls(call_ts, contact_phone, dialer_number_phone);

-- Join hot path (calls → deals) and date-range scans.
CREATE INDEX IF NOT EXISTS calls_contact_phone_idx ON calls(contact_phone);
CREATE INDEX IF NOT EXISTS calls_call_ts_idx       ON calls(call_ts DESC);

-- RLS ON with NO policies — same posture as stage_events. This table is touched
-- ONLY by the server via the service-role client (the importer writes it, /api/calls
-- reads it), and service-role bypasses RLS. Enabling RLS therefore blocks anon/public
-- access to the call log (names, phone numbers, talk times) without breaking anything.
-- Do NOT add anon/authenticated policies — server-only by design.
ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
