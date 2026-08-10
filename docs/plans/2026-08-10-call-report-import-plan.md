# Plan: Call Report CSV Import + /calls Page

**Date:** 2026-08-10
**Mode:** Build
**Source:** docs/specs/2026-08-10-call-report-import-spec.md
**Status:** APPROVED

## Tasks

### Task 1: Create the `calls` table schema [P]
**Files:** `supabase-calls.sql`
**Do:**
1. Follow the header-comment convention of `supabase-stage-events.sql`: explain that this
   table is CSV-only ingest (GHL exposes no call API — verified 404s), and that lead owner
   is deliberately NOT stored (derived from the `deals` join at read time so it can't drift).
2. `CREATE TABLE IF NOT EXISTS calls` with: `id` uuid pk default gen_random_uuid(),
   `call_ts` timestamptz not null, `contact_phone` text not null, `contact_name` text,
   `direction` text, `call_status` text, `disposition` text, `duration_sec` int not null default 0,
   `dialer_number_name` text, `dialer_number_phone` text, `first_time` boolean,
   `account_label` text not null, `source_file` text, `imported_at` timestamptz default now().
3. `CREATE UNIQUE INDEX calls_dedupe_idx ON calls (call_ts, contact_phone, dialer_number_phone)`.
4. Indexes on `contact_phone` and `call_ts`.
5. RLS mirroring the `deals` table: enable RLS, authenticated read, service-role write.
**Test:** Runs clean in the Supabase SQL editor; `select count(*) from calls` = 0; an anon-key
select is rejected by RLS.
**Skills:** lint-and-validate
**Commit:** "Add calls table for GHL call-report CSV import"
**Status:** [ ]

### Task 2: CSV parser [P]
**Files:** `lib/callsCsv.ts`
**Do:**
1. `import { parseCsv } from './ariveCsv'` and `import { normPhone } from './dealMatcher'` — do
   NOT write a new CSV tokenizer.
2. `export function ptToUtc(local: string): string` — converts `"2026-08-10 15:29:07"` (account-local
   America/Los_Angeles) to a UTC ISO string. Compute the zone offset via `Intl.DateTimeFormat`
   with `timeZone: 'America/Los_Angeles'` and a two-pass correction. **Do NOT hardcode -7** —
   that is right for PDT and wrong for PST, and would shift every winter import by an hour.
   Ambiguous fall-back hour resolves to the first (DST) occurrence.
3. `export function parseDuration(s: string): number` — `"mm:ss"`, `"hh:mm:ss"`, `"-"`/empty → 0.
4. `export type CallRow` matching the table columns.
5. `export function parseCallsCsv(text: string, accountLabel: 'moe' | 'matt', sourceFile: string): CallRow[]`
   — maps CSV headers by name (not index), skips rows whose `normPhone(Contact phone)` is null.
6. `export function dedupeKey(r: CallRow): string` → `` `${r.call_ts}|${r.contact_phone}|${r.dialer_number_phone}` ``.
**Test:** `scripts/calls-check.ts` (Task 4)
**Skills:** lint-and-validate
**Commit:** "Add call-report CSV parser with PT to UTC conversion"
**Status:** [ ]

### Task 3: Effort + economics rollups
**Depends on:** Task 2
**Files:** `lib/callsReport.ts`
**Do:**
1. `export const isConnected = (c: CallRow) => c.duration_sec > 0` with a load-bearing comment:
   NEVER use `call_status === 'Answered'` — 724 rows in the real export are simultaneously
   `Answered` and dispositioned `No Answer / Voicemail` (carrier connect, not human pickup).
2. `export function coveredLos(calls): Set<string>` — maps imported `account_label`s to LO names
   (`moe` → 'Moe Sefati', `matt` → 'Matt Park'). An LO absent here returns `null` metrics so the
   UI renders "no data" and NEVER `0%`.
3. `export function effortRollup(calls, deals)` → per LO: leads, dialed, connected, dials,
   talkSec, medianTtfdHours, `neverDialed[]`, `dialedNeverConnected[]` (each with lead_price summed).
4. `export function dialerBreakdown(calls, deals)` → per LO, per `dialer_number_name`: calls, talkSec.
5. `export function economicsRollup(calls, deals)` → per source: leads, spend, connectedLeads,
   dialsPerLead, costPerConnect, funded.
6. All rollups filter deals to `lead_price > 0` and `DEFAULT_LOS` (from `lib/loanOfficer`).
   Join on `normPhone(deal.phone) === call.contact_phone`.
**Test:** `scripts/calls-check.ts` (Task 4)
**Skills:** lint-and-validate
**Commit:** "Add calls effort and economics rollups"
**Status:** [ ]

### Task 4: Fixture checks
**Depends on:** Task 2, Task 3
**Files:** `scripts/calls-check.ts`
**Do:** Follow the `scripts/lead-roi-check.ts` pass/fail harness. Pure, no network. Cover:
1. `parseDuration` for `"00:49"`, `"01:02:03"`, `"-"`, `""`.
2. `ptToUtc` for an August date (PDT, −7) AND a January date (PST, −8) — this is the DST regression guard.
3. A row with `call_status: 'Answered'` + `disposition: 'No Answer / Voicemail'` + `duration: '-'`
   counts as NOT connected.
4. `coveredLos` with only `moe` imported → Matt's metrics are `null`, not `0`.
5. `dedupeKey` is stable across re-parse of identical input.
**Test:** `npx tsx scripts/calls-check.ts` → all pass, exit 0
**Skills:** lint-and-validate
**Commit:** "Add fixture checks for calls parser and rollups"
**Status:** [ ]

### Task 5: Import API route
**Depends on:** Task 1, Task 2
**Files:** `app/api/import/calls/route.ts`
**Do:** Follow `app/api/import/arive/route.ts` (service-role client, preview-then-apply).
1. `POST` with `mode: 'preview'` → parse, return total rows, new vs. already-present (by dedupe key),
   matched vs. unmatched against `deals.phone`, and the date range covered.
2. `POST` with `mode: 'apply'` → upsert with `onConflict: 'call_ts,contact_phone,dialer_number_phone'`
   and `ignoreDuplicates: true`, chunked at 500 rows.
3. Paginate any `deals` read — a bare select caps at 1000 rows.
**Test:** Preview both real CSVs → 7,348 rows; apply → 7,348 inserted; re-apply → 0 new.
**Skills:** lint-and-validate, security-auditor
**Commit:** "Add calls CSV import API with preview and idempotent apply"
**Status:** [ ]

### Task 6: Import UI
**Depends on:** Task 5
**Files:** `app/import/calls/page.tsx`
**Do:** Model on `app/import/arive/page.tsx`.
1. Multi-file drop zone; each file needs an account tag (Moe / Matt) chosen before apply —
   it cannot be derived, because Brianne's Number appears in BOTH exports.
2. Show the preview summary, then an Apply button.
**Test:** Upload both CSVs locally via the dev-bypass launch config; preview counts match Task 5.
**Skills:** lint-and-validate
**Commit:** "Add /import/calls upload UI"
**Status:** [ ]

### Task 7: /calls page
**Depends on:** Task 1, Task 3
**Files:** `app/calls/page.tsx`, `components/Sidebar.tsx`
**Do:**
1. Two tabs — Effort (per LO, dialer breakdown, never-dialed and dialed-never-connected lists
   with dollars) and Economics (per source: leads, spend, connect %, dials/lead, $/connect, funded).
2. Header shows `data through <max(call_ts)>`; warn when the newest call is >7 days old.
3. Label the Economics tab "contact economics, not ROI" and link to `/lead-roi` for revenue.
4. Use `LoFilter`, restricted to covered LOs.
5. Add a Sidebar entry next to the other reporting pages.
**Test:** Page renders both tabs with the imported data; numbers match Task 8's assertions.
**Skills:** lint-and-validate, ui-ux-pro-max
**Commit:** "Add /calls Effort and Economics tabs"
**Status:** [ ]

### Task 8: Live acceptance check
**Depends on:** Task 5, Task 7
**Files:** `scripts/calls-live-check.ts`
**Do:** Service-role script asserting the spec's acceptance criteria against the real DB:
7,348 rows; re-import adds 0; Moe 717 leads / 93% dialed / 87% connected / $2,079 never-dialed;
Matt 626 / 96% / 89% / $762; median time-to-first-dial 24 min; LMB $38, OwnUp $80,
Lending Tree $47, Lendgo $26, FRU $32 per connect; no `call_ts` >1h before its deal's
`date_added_ghl`; zero rows attributed to Randy Mathis.
**Test:** `npx tsx scripts/calls-live-check.ts` → all assertions pass
**Skills:** lint-and-validate
**Commit:** "Add live acceptance check for calls import"
**Status:** [ ]

### Task 9: Verify and deploy
**Depends on:** Tasks 1-8
**Files:** `VERIFICATION-LOG.md`
**Do:**
1. `npx tsc --noEmit`
2. `npm run build`
3. Append a CHANGED entry to `VERIFICATION-LOG.md`.
4. Commit, push, `vercel --prod` per the standing auto-deploy policy.
**Test:** tsc + build clean; production URL serves `/calls`.
**Skills:** lint-and-validate
**Commit:** "Ship /calls call-report import and reporting"
**Status:** [ ]
