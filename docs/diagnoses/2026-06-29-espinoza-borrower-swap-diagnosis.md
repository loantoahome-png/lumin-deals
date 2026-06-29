# Diagnosis — "Removed Judith, made Jesus sole borrower in Arive, re-imported, nothing changed"

**Date:** 2026-06-29
**Deal:** Espinoza · `f7a22e85-66db-4fd3-ad2e-3111af507706` · Arive #16900148 · GHL opp contact `t2BKSTQpCmfZKtyGs5K4`
**Reported by:** Efrain — changed the borrower in Arive (Judith → Jesus only), imported the Arive CSV, the
dashboard still shows Judith as primary with Jesus as co-borrower.

## Verdict
**Working as coded — the borrower identity is NOT driven by Arive.** Two independent facts make an Arive
re-import (or even a manual edit) unable to swap the primary borrower:

### 1. The Arive importer never writes the borrower's name or `borrower_id`
`lib/ariveCsv.ts` `MAPPINGS` maps `Primary Borrower Email → email` and `…Cell Phone → phone`, but there is
**no mapping for the borrower name**. The name is carried as `__borrower_name`, used **only for matching**, and
every write loop skips `__`-prefixed carrier fields (`field.startsWith('__')`). `borrower_id` is never set on an
update either. Co-borrower handling (`linkCoborrowerFromImport`) only ever **adds** a `deal_contacts role='co'`
row and *skips* anyone who resolves to the existing primary — it never promotes/demotes. So a re-import can, at
most, add a co-borrower; it can never change who the primary is.

### 2. The primary name/email/phone is owned by GHL and re-stamped every 3-minute sync
`app/api/sync/ghl/route.ts` matches the deal by `ghl_opportunity_id`, then on update (line ~946) sets
`name: dealData.name` **unconditionally**, and `maybeSet`s `first_name,last_name,email,phone` whenever the GHL
contact has them (lines ~971–976). `dealData.name` comes from the **GHL contact on the opportunity**
(`fullContact.name`, line ~862). This deal's opportunity is still tied to **Judith's** GHL contact
(`t2BKSTQpCmfZKtyGs5K4`), so every sync re-writes `deals.name = "Judith Espinoza"`. `borrower_id` is the one
identity field deliberately **not** synced (line ~985), so it's preserved.

**Net:** the borrower shown on the dashboard = the GHL contact on the opportunity. Arive doesn't touch it, and any
manual edit to the name field (the hero input, `app/deals/[id]/page.tsx:488`, writes `deals.name`) is reverted
within ~3 minutes by the next GHL sync.

## Evidence (live row, service-role read 2026-06-29)
| field | value |
|---|---|
| `deals.name` / `first`/`last` | Judith Espinoza |
| `deals.borrower_id` | `6fd24e70…` → contact **Judith** (email `instantloanincservices@outlook.com`, phone 310-951-0503) |
| `deal_contacts` | one row → contact `b30ea732` **JESUS RICARDO ESPINOZA**, role `co` (email null, phone 310-702-0878) |
| `deals.email` / `phone` | Judith's email; phone is **Jesus's** (310-702-0878) — mixed |
| `arive_file_no` | 16900148 (so Arive import matched this exact deal — `via: arive_file_no`) |
| `updated_at` | 2026-06-29 (a write *did* land — just not to the borrower) |
| duplicate check | only **1** deal for Arive #16900148 — no phantom "Jesus" deal was created |

Jesus's contact (`b30ea732`) is a **dashboard-only** contact (email null, name-only) — almost certainly minted by
a prior Arive import's co-borrower linker. He does **not** appear to have his own GHL contact.

## Why the existing "promote to primary" button doesn't fully fix it
`CoborrowerManager` ★ → `promoteToPrimary` swaps `borrower_id` and shuffles `deal_contacts`, but does **not**
update `deals.name/first/last/email/phone`. The hero header reads `deals.name` (GHL-owned), so after promoting
Jesus the header would still show Judith — and the sync keeps it that way. So promote is effectively cosmetic for
GHL-synced deals.

## Fix options (need Efrain's call — touches real loan data / GHL)
1. **Source fix (durable):** make Jesus the contact on the **GHL opportunity** (move the opp to a Jesus GHL
   contact, or correct the contact). Then the sync flows Jesus through naturally. Needs a Jesus GHL contact.
2. **Build a borrower override (feature):** when a co-borrower is promoted, also copy their name/email/phone onto
   the deal AND mark those fields "manual" so the GHL sync's `maybeSet`/`name` write respects the lock. This makes
   the existing ★ button actually work for GHL-synced deals.
3. **One-off data patch (NOT durable alone):** set `borrower_id`→Jesus + `name`→Jesus on the row. **Will be
   reverted by the next GHL sync** unless paired with option 1 or 2. Not recommended on its own.

**Recommendation:** option 1 if Jesus should be the GHL contact of record; option 2 if the dashboard should be able
to override borrower identity independent of GHL (likely worth building — co-borrower→primary swaps will recur).
