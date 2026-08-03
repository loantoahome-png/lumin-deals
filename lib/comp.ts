// Total compensation on a loan — Arive comp PLUS the Non-Del price credit.
//
// WHY THIS EXISTS
// Arive's exported "Compensation Amount" is only the ORIGINATOR COMPENSATION
// line of the Rate Lock screen. A Non-Delegated loan's lock also carries a
// Final Price rebate, and that money is ours as well — Efrain, 2026-08-03:
// "when a loan is considered Non-Del, we add both of these numbers and that is
// the total comp."
//
// The Final Price DOLLAR figure is not exported by Arive; the percentage is,
// as "Net Discount Points". Dollars = points% × total loan amount. Verified on
// Edward Fadel (Arive 16541057, funded 2026-05-13, Matt Park):
//
//   Arive funded export      compensation_amount 8212.35 · comp pct 0.75
//   Rate Lock screen         Originator Compensation 0.750%  $8,212.35
//                            Final Price             1.210%  $13,249.26
//   1.21% × $1,094,980    =  $13,249.258  → $13,249.26   ✓ exact
//
// So the dashboard was reporting $8,212.35 on a loan that actually earned
// $21,461.61 — the missing piece was LARGER than the piece we recorded.
//
// SCOPE — the credit is added on Non-Del loans ONLY. Arive exports net discount
// points on broker loans too, but on those the rebate is already inside the
// lender-paid compensation figure; adding it again would double-count 76 of the
// 86 live funded loans. `broker_corr` is the channel tag (Arive "Channel"), and
// every live funded deal carries one (verified 2026-08-03: 76 Broker, 10
// Non-Del, and the only untagged funded rows are parked Old Deals).
//
// SIGN — the stored value is used exactly as given: a positive 1.21 means a
// 1.21% credit TO US. If a future Arive export writes rebates as negative
// points, fix it at the import mapping, not here, and re-check Fadel reads
// +1.21 before trusting a backfill.
// (Deal is intentionally not imported — CompFields is structural so narrow selects fit.)

/**
 * The fields the comp math needs. Optional on purpose: the resolver and the refi
 * radar select narrow column sets and mark these `?`, and they must still be
 * able to call totalComp — a missing field means "not recorded", handled below.
 */
export type CompFields = {
  compensation_amount?: number | null
  loan_amount?: number | null
  broker_corr?: string | null
  net_discount_points?: number | null
}

/** Arive writes the channel as "Non-Del"; tolerate "Non Del" / "NonDel" / casing drift. */
export function isNonDel(d: Pick<CompFields, 'broker_corr'>): boolean {
  return /non[\s-]?del/i.test(d.broker_corr ?? '')
}

/**
 * The Non-Del price credit in dollars — net discount points applied to the loan
 * amount. Zero on broker loans, and zero when either input is missing (missing
 * means "not recorded yet", never "no credit").
 */
export function discountCredit(d: CompFields): number {
  if (!isNonDel(d)) return 0
  const pts = d.net_discount_points
  const amt = d.loan_amount
  if (pts == null || amt == null) return 0
  const v = (pts / 100) * amt
  return isFinite(v) ? v : 0
}

/** What the loan actually earned: Arive compensation + the Non-Del price credit. */
export function totalComp(d: CompFields): number {
  return (d.compensation_amount ?? 0) + discountCredit(d)
}

/** True when this loan's total is more than its Arive comp line — drives the UI breakdown. */
export function hasDiscountCredit(d: CompFields): boolean {
  return discountCredit(d) !== 0
}
