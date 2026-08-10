# Spec: Call Report CSV Import + /calls Page

**Date:** 2026-08-10
**Status:** APPROVED
**Approach:** A — raw `calls` table, metrics computed at query time

## Problem

GHL's Reporting → Call report shows dialing activity but cannot join it to anything
we care about: lead source, lead price, or funded outcome. It also can't answer the
question that matters most — *are the leads we paid for actually being worked?*

Verified this session (live probes, not memory): **GHL exposes no location-level call
API.** `/calls`, `/reporting/calls`, `/phone-system/calls`, `/voice-ai/call-logs` all
404. Call records exist only per-conversation via `/conversations/{id}/messages`
(TYPE_CALL), and that payload carries duration + status but **no Disposition** — the
LO's hand-tagged outcome. The CSV export is therefore the richer and only practical
ingest path.

Join feasibility is proven: the two exports (Moe + Matt, 7,348 calls, May 4 – Aug 10)
match `deals.phone` on **92.1% of phones / 93.4% of calls**, with zero overlapping
rows between files.

## Solution

A CSV importer plus a two-tab `/calls` page, scoped to purchased leads for Moe Sefati
and Matt Park.

### Ingest

Drop-zone importer following the existing Arive CSV import pattern (`lib/ariveCsv.ts`
+ preview-before-apply). User tags each file at upload as `moe` or `matt` — the file's
originating sub-account. Tagging is manual because it cannot be derived: **Brianne's
Number appears in both exports** (2,427 calls in Moe's, 2,056 in Matt's), so the
dialing number does not identify the account.

### Schema — `calls`

One row per call. Nothing derived is persisted.

| Column | Type | Note |
|---|---|---|
| `id` | uuid pk | |
| `call_ts` | timestamptz | **converted PT→UTC at import**, not at read |
| `contact_phone` | text | normalized to 10 digits; join key to `deals.phone` |
| `contact_name` | text | as exported |
| `direction` | text | `inbound` / `outbound` |
| `call_status` | text | raw CSV value — retained, but NOT the connect signal |
| `disposition` | text null | LO hand-tag; ~78% blank |
| `duration_sec` | int | 0 when CSV shows `-` |
| `dialer_number_name` | text | e.g. "Brianne's Number" |
| `dialer_number_phone` | text | |
| `first_time` | bool | |
| `account_label` | text | `moe` \| `matt` — set at upload |
| `source_file` | text | provenance |
| `imported_at` | timestamptz | provenance |

**Unique key:** `(call_ts, contact_phone, dialer_number_phone)` — makes re-import
idempotent. Accepted cost: exactly one pair of identical rows exists in Moe's 3,507
(3,506 unique), so a strict key collapses one real call. Chosen deliberately over
risking double-counting on re-import.

**Lead owner is not stored.** It is derived from the `deals` join at read time, so it
can never drift from `deals`. Dialer identity IS stored (it exists only in the CSV).

### Metric definitions

- **`connected` = `duration_sec > 0`.** Never `call_status = 'Answered'`. 724 rows are
  simultaneously `Answered` and dispositioned `No Answer / Voicemail` — "Answered" is a
  carrier-level connect, not a human pickup. This single definition determines whether
  every number on the page is honest.
- **`dialed`** = lead has ≥1 call.
- **`dials/lead`** = calls ÷ leads.
- **`$/connect`** = Σ lead_price ÷ count(leads with ≥1 connected call).
- **time to first dial** = `min(call_ts) − date_added_ghl`. Softest metric on the page:
  `date_added_ghl` is insert-only and known to freeze (see the Larisa Fuchs case). Sound
  on current data — median 24 min, and zero dials precede their lead-in date once the
  timezone is correct — but flagged in the UI as approximate.

### Pages

**`/calls` — Effort tab.** Per LO: leads, % dialed, % connected, dials/lead, talk hours,
median time-to-first-dial. Plus a dialer breakdown (Brianne / Mohammad / Matthew) and
two clickable lists with dollars attached: never-dialed, and dialed-but-never-connected.

**`/calls` — Economics tab.** Per source: leads, spend, % connected, dials/lead,
$/connect, funded count. Explicitly labeled **contact economics, not ROI** — no revenue
appears on this page; `/lead-roi` owns revenue with the 85% LO split and `totalComp()`.

**Header** shows `data through <max(call_ts)>` and warns when the newest import is more
than 7 days old, so stale numbers are never mistaken for live ones.

## Acceptance Criteria

- [ ] Importing both exports yields 7,348 stored calls
- [ ] Re-importing the same two files adds **0** new rows (idempotent)
- [ ] The 724 `Answered` + `No Answer / Voicemail` rows are counted as **not connected**
- [ ] No stored `call_ts` precedes its matched deal's `date_added_ghl` by more than 1 hour (timezone assertion)
- [ ] Effort tab reproduces: Moe — 717 leads, 93% dialed, 87% connected, 4.2 dials/lead, $2,079 never-dialed
- [ ] Effort tab reproduces: Matt — 626 leads, 96% dialed, 89% connected, 4.9 dials/lead, $762 never-dialed
- [ ] Median time to first dial renders 24 minutes
- [ ] Economics tab reproduces: LMB $38/connect · OwnUp $80 · Lending Tree $47 · Lendgo $26 · FRU $32
- [ ] Randy Mathis appears nowhere in the UI or the queries
- [ ] An LO with no imported CSV renders "no data", never `0%`
- [ ] `scripts/calls-check.ts` fixture-tests the parser (duration formats, PT→UTC, connect rule) with no network
- [ ] `tsc` + `next build` clean

## Out of Scope

- Randy Mathis — excluded by decision, 662 leads / $22,503 not represented
- GHL conversations API sync (nightly or on-demand) — CSV-only ingest
- Call recordings — the recording endpoint 422'd and every report row shows "No recording"
- The attribution columns (Source type, Keyword, Marketing campaign, Device type, Referrer, Campaign, Landing page, Qualified lead) — 100% empty in both exports
- Non-purchased leads (`lead_price` is null or 0)
- The 486 unmatched calls (7.9%) — no deal to attribute them to
- Revenue and ROI — belongs to `/lead-roi`
- Per-deal call counts on the deal page or Hot Leads — revisit if a rollup is later justified

## Open Questions

None.
