# Lead ROI — unified Lead Performance + Lead Spend page

**Date:** 2026-07-13 · **Status:** approved (Efrain, this session) · **Mode:** Build

## Goal

Replace `/lead-performance` and `/lead-spend` with one page, `/lead-roi`, that answers the
whole question — what did leads cost, how did they respond, and what did they earn — with
**one set of metric definitions**. Design approved via mockup
(claude.ai artifact `lead-roi-report-mockup`, 2026-07-13).

## Key decision (Efrain): per-LO only, never combined

The page filters by **one LO at a time** (Matt Park | Moe Sefati | Randy Mathis tabs, like
Lead Spend today). There is **no "All LOs" aggregate view** — "I do not think we will ever
need to see that stats combined." Tabs render from `LOAN_OFFICERS`, matching via
`resolveLO` (canonical), so a future 4th LO appears automatically — no per-page matcher
copies (the Randy-gotcha class of bug).

## Reconciled definitions (supersede both pages)

- **Responded** — engaged ≥ once; Ghosted counts. Cold = New Lead / Attempted Contact /
  Non-Responsive. Opt-out (STOP / DND-SMS / Remove from All Automations) is its own bucket.
- **Funded** — `isFunded` from lib/leadReport (Funded group OR the 3 funded statuses) —
  everywhere, including pipeline tallies (Lead Spend used group-only).
- **Dates** — funded loans anchor on `funded_date` strictly; everything else on
  `date_added_ghl`; date-less rows appear only under "All time" (Lead Spend's rules, kept).
- **Spend** — Σ per-lead `lead_price` **plus** flat monthly retainer (`lead_source_costs`)
  × months in range. (Retainers were previously excluded from ROI — under-costed sources.)
- **Revenue** — Σ Arive `compensation_amount` on **funded** loans only (all funded in
  scope, priced or not). Supersedes the priced-cohort restriction: with blended spend on
  one side, excluding unpriced funded comp understates the other. Coverage caveat stays in
  the methodology block.
- **ROI** — revenue ÷ spend as a **multiple** (1.62× = $1.62 back per $1). Replaces Lead
  Spend's percent (same fact minus one). Net profit = revenue − spend stays in dollars.
- **Scope** — Purchased (vendor sources, the default) / All sources. Replaces Lead Spend's
  "paid only" toggle.

## Page sections (all obey the same filter bar)

Filter bar: LO tabs (single-select) · date range presets + custom · Scope · Purpose ·
Stage (group or status) · Source multi-select.

1. KPI band — leads, responded %, no-response %, opt-out %, active escrows, funded (+fund %,
   volume); money row: spend, revenue, net profit, ROI ×, cost/funded (+avg comp).
2. **Lead lifecycle funnel (new)** — leads → responded → became a loan (active+funded) → funded.
3. **Spend vs revenue by month (new)** — grouped bars + per-month ROI chips (no dual axis).
4. Per-source table — superset: leads, resp %, opt-out, open, active, lost, funded, fund %,
   volume, spend, revenue, net, ROI. Expandable drill-down keeps the retainer editor,
   per-deal source reassign, and bulk reassign.
5. Per-state table (from Lead Performance).
6. Funded-share donut (from Lead Spend).
7. Projection — "if all active loans fund" (from Lead Spend).
8. Funded loans list (from Lead Spend).
9. Methodology block (the reconciled definitions).

## Report generation

`/lead-roi/report?lo=…&range=…` — a print-styled ROUTE (no `window.open`/`document.write`
popup): shareable URL, no popup blockers, automatable. One-click Print / Save as PDF.
Layout per the approved mockup. CSV export stays on the main page.

## Preserved from the old pages (nothing dropped)

Response funnel, opt-out bucket, state table, purpose filter, Purchased/All scope
(Lead Performance) · pipeline columns, funded volume + avg, date ranges, stage filter,
source filter, retainer cost editor, recategorize (single + bulk), projection, funded list,
donut, CSV, visual report (Lead Spend). Old URLs 301-redirect to `/lead-roi`.

## Out of scope (logged for later)

Median first-response per source (stage_events join — /lead-cohorts has the data),
trailing-90d ROI badges, break-even $/lead per source, weighted projection.
