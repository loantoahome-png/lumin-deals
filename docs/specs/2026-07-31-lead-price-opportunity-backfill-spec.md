# Spec — `lead_price` should come from the OPPORTUNITY, not the contact

**Date:** 2026-07-31
**Status:** scoped, not started
**Origin:** Efrain compared Matt's "Agg leads" spend on `/lead-roi` ($26,407) against a GHL
opportunity export. The totals reconciled to the cent, but the reconciliation surfaced this.
**Shape:** Fix mode. Sibling of the 2026-07-23 opportunity-field sourcing fix (`409229d`
lineage) — `lead_price` was left out of that pass.

---

## 1. The bug, with evidence

`app/api/sync/ghl/route.ts:1009` reads the price off the **contact**:

```ts
lead_price: parseAmount(getCustomField(customFields, 'lead_price', 'Lead Price')),
```

`customFields` there is the contact's. But a contact holds **one** lead price while each
opportunity holds **its own** — and per the standing domain rule, every opportunity with a
price is a real, separate charge ([[lead-price-per-opportunity]]).

Verified live 2026-07-31 — Lawrence Turner, six purchased opportunities in Matt's location:

| Source | GHL opportunity `Lead Price` | What we store |
|---|---|---|
| MRC | 34 | 34 |
| FRU | 31 | 34 |
| LMB | 38 | 34 |
| Lendgo | 23 | 34 |
| FRU | 29 | 34 |
| LeadPoint | 21 | 34 |
| **Total** | **$176** | **$204** |

GHL's contact-level field for him is a single `34` — exactly what we stored on all six. The
opportunity values match his CSV export line-for-line.

**The field exists at opportunity level in both sub-accounts**, same name, different ids:

| Location | id | name | fieldKey | type |
|---|---|---|---|---|
| Moe | `nz9z1I64Y5Brm7vwDQo6` | `Lead Price` | `opportunity.lead_price` | MONETORY |
| Matt | `vKWY7xx1FUyzmSOoGF2R` | `Lead Price` | `opportunity.lead_price` | MONETORY |

Ids differ per location, so **nothing may hardcode an id**. `oppCustomField()` already matches
on normalized name/fieldKey, which is why the July 23 overlay works across locations — this
rides the same mechanism.

## 2. ⚠️ A backfill alone gets silently reverted

`lead_price` is in the sync's `maybeSet` list (`route.ts:1068`), so **every 15-minute pass
re-stamps it from the contact field**. Backfilling first would look fixed for at most 15
minutes and then quietly undo itself — the same trap that ate the Arive loan-amount
corrections ([[loan-amount-provenance]]).

**Order is mandatory: sync fix first, verified in prod, then backfill.**

## 3. Scope

| # | Work | File | Size |
|---|---|---|---|
| 1 | Add `num('lead_price', 'Lead Price')` to `mapOpportunityFields` | `lib/ghlOpportunityFields.ts` | XS |
| 2 | Confirm the overlay reaches `lead_price` — it already applies opp-over-contact for the July 23 columns; `lead_price` just needs to be in the overlaid set, not re-read from the contact | `app/api/sync/ghl/route.ts` | S |
| 3 | Dry-run backfill script: read every priced deal's opportunity, diff stored vs opportunity value, **write nothing**; report per-vendor and per-LO deltas | `scripts/lead-price-backfill.ts --dry-run` | M |
| 4 | Apply mode, after Efrain reads the dry-run | same script | S |
| 5 | Fixture: overlay prefers the opportunity value, falls back to contact when the opp has none | `scripts/*-check.ts` | S |

**Population** (measured 2026-07-31): **2,457 priced deals, $80,022.40** total —
Moe 1,007 / Matt 891 / Randy 559. **Every one has a `ghl_opportunity_id`**, so the backfill
can reach 100% of them; nothing is stranded.

Fetch strategy: reuse the sync's paginated `/opportunities/search` rather than 2,457 single
GETs. ⚠️ Numeric custom fields come back under `fieldValueNumber` on the search path and
`fieldValue` on a single GET — `rawValue()` already reads every variant, so use it rather
than indexing a key directly ([[opportunity-field-sourcing]]).

## 4. How wrong is it, in total?

Unknown until the dry-run, and **deliberately not estimated here.** What is measured:

- 57 contacts have 2+ priced opportunities; **54 of them carry an identical price on every
  one** — 122 deals, $3,891.50.
- ⚠️ **Identical prices are NOT proof of the bug.** Repeat buys from one vendor bill at that
  vendor's going rate, so identical is the *normal* case ([[lead-price-per-opportunity]]). This
  54/122 figure is a **suspicion set, not a wrong-set**. Only a per-opportunity diff settles it.
- Single-opportunity contacts are also in scope: their contact value is *probably* the same as
  their one opportunity's, but Matt's export already showed one-off disagreements
  (Margaret Vandal: export $24, stored $23), so the dry-run covers all 2,457, not just the 122.
- For orientation only: across Matt's agg book the 20 disagreements netted **+$0.70** — the
  headline totals barely move. **The damage is in the per-vendor split**, which is exactly what
  `/lead-roi` exists to show (LeadPoint billed $21 recorded as $34).

## 5. Decisions needed before writing code

1. **Opportunity with no `Lead Price` set — keep the contact value or null it?**
   Recommend **keep** (overlay semantics, same as July 23): an unset opportunity field means
   "no data", not "free lead". Never silently zero out spend.
2. **Is the opportunity value authoritative in every case, including funded loans?**
   Loan amount has a funded-only Arive guard; lead price has no Arive involvement — it's a
   vendor charge — so the recommendation is a plain opp-preferred overlay with no
   funded-status special case. Needs Efrain's confirmation since it's money.
3. **`/report-import` also writes `lead_price` from CSV** (`app/report-import/page.tsx:298`).
   Recommend leaving it alone; flag it if the sync should stop overwriting an imported price.

## 6. Blast radius when it lands

Everything reading `lead_price`: `/lead-roi` (spend, ROI, cost-per-funded, per-vendor tables,
`/lead-roi/report`), `/lead-cohorts` (`isPriced` gate — a price that becomes null would drop a
lead out of the cohort entirely), `/contacts` + `/contacts/[id]` (leadCost), `/radar`,
`app/api/stage-events/backfill` (`gt('lead_price', 0)` filter).

## 7. Risk

This is **money data**. Mitigations: dry-run report before any write; the backfill records the
prior value per deal so it's reversible; ship behind the sync fix so nothing thrashes; and
per [[dont-invent-meaning-on-real-data]], the dry-run gets read by Efrain — who sees the
invoices — before anything is applied. No interpretation of the numbers gets made here.
