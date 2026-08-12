# Research — replacing the manual call CSV with `GET /conversations/messages/export`

**Date:** 2026-08-12
**Question:** Efrain: *"automate the call import with that export endpoint."*
**Outcome:** Built and shipped. This doc records what was measured, because several
findings contradict `supabase-calls.sql`'s header and one of them would have
silently corrupted every dial metric on /calls.

## Sources

All figures below are from **live probes against both sub-accounts with the existing
Private Integration tokens**, plus the real `calls` table. Nothing here is from docs
or memory.

- `GET /conversations/messages/export` (Version `2021-04-15`), 4 probe scripts,
  2026-08-11/12.
- Comparison window **2026-08-04 → 2026-08-09**, chosen because it is fully covered
  by the existing CSV import (713 stored rows).
- OpenAPI: `github.com/GoHighLevel/highlevel-api-docs/apps/conversations.json`.

## What the endpoint is

Location-wide, cursor-paged feed of all non-email messages. Supports
`channel=Call`, `startDate`/`endDate`, `limit` (100), and `sortBy` — ⚠️ `sortBy`
accepts only `createdAt`/`updatedAt`; `dateAdded` returns **422**.

Row shape (call): `id, direction, status, type, locationId, contactId,
conversationId, dateAdded, dateUpdated, userId, source, from, to, messageType,
meta.call{duration,status}`.

**This does not contradict the 2026-08-10 finding that GHL has no call API.**
`/calls`, `/reporting/calls`, `/phone-system/calls`, `/voice-ai/call-logs` still
404. This is the *messages* feed, and its `TYPE_CALL` rows happen to carry
everything /calls computes.

## Findings

### 1. TYPE_CALL is 1:1 with the CSV — exactly

| | count |
|---|---|
| Stored CSV rows in the window | **713** |
| API `TYPE_CALL` rows in the window | **713** (240 Moe + 473 Matt) |

### 2. ⚠️ `TYPE_CAMPAIGN_VOICEMAIL` is NOT in the CSV — the trap

`channel=Call` returns ringless voicemail drops alongside real dials: **615** of
them in the same 5 days (310 Moe + 305 Matt). They are absent from the Call report
CSV. Importing them would have inflated dial counts ~45% and wrecked dials/lead —
a metric Efrain reads per LO. **Only `TYPE_CALL` is a dial.**

### 3. `meta.call.duration` is SECONDS

On all **393** calls where both sources report a non-zero duration, the values are
identical — db/api ratio **1.000 at p10, p50 and p90**. Not milliseconds.

### 4. `from`/`to` + `direction` are reliable — zero misses

Across 712 paired rows: dialer matched the CSV's `dialer_number_phone` **710/710**
(0 misses), direction matched **712/712**. Contact is `to` on outbound, `from` on
inbound.

**Consequence:** `account_label` no longer needs hand-tagging at upload. The CSV
couldn't derive it (Brianne's number appears in both exports); the API can, because
we query per location.

### 5. Timestamps: API has ms, CSV truncates to the second

No exact matches; median gap **639ms**. Truncating the API instant to the second
makes it collide with its CSV twin on the existing
`(call_ts, contact_phone, dialer_number_phone)` unique index — **so no migration
was needed**. ⚠️ But truncation lands ±1s from the CSV's second on **113 of 711**
rows (16%), which is why backfilling over the CSV period would duplicate calls.

### 6. ⚠️ UNRESOLVED: the two sources disagree on 27% of individual calls

| | count |
|---|---|
| Both report a duration, values identical | 393 |
| API > 0, CSV says 0 | 105 |
| API says 0, CSV > 0 | 84 |
| Both 0 | 130 |

189 of 712 (27%) disagree on whether the call connected **at all**, in both
directions — including a CSV row of 4,839s the API calls 0. Tested and **rejected**
the obvious explanation (Brianne dialing into both sub-accounts producing
cross-account mispairs): in this window no call appears under both labels, there
are no duplicate API rows, and same-account-only pairing reproduces the identical
split. **Which source is correct is not determinable from our side.** It is
therefore asserted nowhere, and the sweep never rewrites a CSV row.

### 7. …but the aggregates are unaffected

Like-for-like outbound:

| cohort | n | connect | median | mean |
|---|---|---|---|---|
| CSV outbound Aug 1–10 | 948 | **69%** | 7s | 52s |
| API outbound Aug 11–12 | 98 | **69%** | 6s | 46s |

The per-call disagreement does not move the rollups. (A short median is not an API
artifact — the CSV shows the same for recent weeks; the all-time CSV median of 32s
reflects older calling patterns.)

## What was built

- `lib/callsApi.ts` — fetch + the pure `mapApiCall` mapper (TYPE_CALL filter,
  second-truncation, direction-aware from/to, seconds duration, Randy excluded).
- `lib/callsSync.ts` — forward-only sweep, per-account watermark, name resolution
  from `deals`, chunked idempotent upsert.
- `app/api/sync/calls/route.ts` — manual trigger with `?dry=1` / `?since=`.
- Cron: 30-min throttle inside `/api/cron/ghl-sync` (`calls_sync_last`).
- `scripts/calls-api-check.ts` — 38 fixtures; `calls-live-check` 24 → 26.

**No schema change.** `source_file = 'ghl-api'` marks provenance and makes the
import precisely reversible.

## Verified after shipping

- First real run imported **113 dials** from Aug 11–12 that no CSV had captured.
- Replaying the same window: **0 inserted, 117 duplicates** — idempotent.
- Names resolved on 108/113 rows.
- `calls-live-check` **26/26 green** (was 18/24 before this work, on stale
  frozen-count baselines).

## Open / deliberately not done

- **The 27% divergence** — needs Efrain's judgement, or a GHL support answer, on
  which source is authoritative. Recommendation: keep uploading the CSV in parallel
  for a couple of weeks if the per-call outcome ever matters; the aggregates say it
  doesn't.
- **Disposition is gone on API rows.** It is CSV-only (the LO's hand-tag). Verified
  that nothing computes a metric from it — `isConnected()` uses `duration_sec > 0`.
  The manual importer still works if it is ever wanted.
- **No backfill mode.** See finding 5 and 6.
- **Randy is still excluded** from /calls by Efrain's standing decision;
  `callAccountLabel('extra')` returns null and is fixture-locked.
