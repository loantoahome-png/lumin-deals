// Fixture check for lib/importRevenue.ts — the per-LO net revenue delta of an
// Arive import. Pure, no DB.
//   npx tsx scripts/import-revenue-check.ts
//
// The anchor is the real 2026-08-07 import: Efrain imported Arive, Matt's Lead
// ROI revenue dropped, and the cause was one loan Arive had re-priced. This suite
// locks that the panel would have said so — and that it reports the ADD the
// default scope hides, which is why the import read as a loss in the first place.
import { importRevenueImpact, UNASSIGNED_LO, NO_SOURCE } from '../lib/importRevenue'
import type { FieldChange, RowPlan, DealRevenueSnapshot } from '../lib/ariveCsv'
import { OLD_DEALS_GROUP } from '../lib/types'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++ } else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}
function approx(label: string, got: number, want: number, eps = 0.005) {
  if (Math.abs(got - want) < eps) { pass++ } else { fail++; console.error(`✗ ${label}\n   got:  ${got}\n   want: ~${want}`) }
}

// ── Builders ────────────────────────────────────────────────────────────────
const snap = (p: Partial<DealRevenueSnapshot> = {}): DealRevenueSnapshot => ({
  loan_officer: 'Matt Park', source: 'Lending Tree',
  status: 'Loan Funded', pipeline_group: 'Funded',
  compensation_amount: null, loan_amount: null, broker_corr: null, net_discount_points: null,
  ...p,
})
const chg = (field: string, current: unknown, next: unknown, action: FieldChange['action'] = 'overwrite'): FieldChange =>
  ({ field, current, next, action })
const plan = (p: Partial<RowPlan> = {}): RowPlan => ({
  rowIndex: 0, borrower: 'Test Borrower', arive_file_no: '1', matched: true,
  changes: [], action: 'update', ...p,
})

// The two predicates the UI actually passes in (mirrors fieldWrites on the page).
const OVERWRITE = (c: FieldChange) => c.action === 'fill' || c.action === 'overwrite'
const FILL_ONLY = (c: FieldChange) => c.action === 'fill'
const shielded = (fields: string[]) => (c: FieldChange) =>
  c.action === 'fill' || (c.action === 'overwrite' && !fields.includes(c.field))

// ── 1. THE ANCHOR: David Mutschler, Arive 17248386 ──────────────────────────
// Broker channel, $300,000, Lending Tree. Arive's export moved Compensation
// Amount 7500 → 6000 and Net Discount Points 2.99 → 2.49 in the same file.
// The points move must NOT register: the Non-Del credit is gated to Non-Del, so
// the whole delta is the comp line. This is the number Efrain saw drop.
const mutschler = plan({
  borrower: 'David Mutschler', arive_file_no: '17248386', dealId: 'd1', funded: true,
  snapshot: snap({ compensation_amount: 7500, loan_amount: 300000, broker_corr: 'Broker', net_discount_points: 2.99 }),
  changes: [
    chg('compensation_amount', 7500, 6000),
    chg('net_discount_points', 2.99, 2.49),
    chg('status', 'Broker Check Received', 'Loan Finalized'),
  ],
})
{
  const r = importRevenueImpact([mutschler], OVERWRITE)
  approx('Mutschler: net delta is exactly the comp line', r.delta, -1500)
  approx('Mutschler: Lending Tree is an agg lead, so the default scope sees it', r.aggDelta, -1500)
  eq('Mutschler: one loan moved', r.movedLoans, 1)
  eq('Mutschler: attributed to Matt', r.byLo.map(b => b.loanOfficer), ['Matt Park'])
  approx('Mutschler: before', r.byLo[0].before, 7500)
  approx('Mutschler: after', r.byLo[0].after, 6000)
  eq('Mutschler: reads as a reprice, not a new funding', r.byLo[0].loans[0].kind, 'reprice')
  eq('Mutschler: stays funded across both funded statuses', r.byLo[0].loans.length, 1)
}
{
  // Fill-blanks mode writes nothing here (every field already has a value), so
  // the money must not move. This is the guarantee that makes the panel safe to
  // read BEFORE choosing a mode.
  const r = importRevenueImpact([mutschler], FILL_ONLY)
  approx('Mutschler: fill-blanks mode moves no money', r.delta, 0)
  eq('Mutschler: fill-blanks reports no movers', r.movedLoans, 0)
  eq('Mutschler: fill-blanks lists no LOs', r.byLo.length, 0)
}
{
  // Shielding the comp field must zero the impact — the panel has to track the
  // user's shields, or it reports a loss they already prevented.
  const r = importRevenueImpact([mutschler], shielded(['compensation_amount']))
  approx('Mutschler: shielding compensation_amount cancels the drop', r.delta, 0)
}

// ── 2. Cheyne Inman: newly funded, and INVISIBLE to the default scope ───────
// Non-Del, $204,000, 1.541 points, source "Others". The same 8/07 import funded
// him (+$6,746.28) — but "Others" is not a purchased source, so /lead-roi's
// default Agg-leads view never showed the gain while it did show Mutschler's
// loss. Reporting both totals is the whole point.
const inman = plan({
  rowIndex: 1, borrower: 'Cheyne Inman', arive_file_no: '17175441', dealId: 'd2',
  snapshot: snap({ source: 'Others', status: 'Docs Signed', pipeline_group: 'Loans in Process',
                   compensation_amount: 3602.64, loan_amount: 204000, broker_corr: 'Non-Del', net_discount_points: 1.541 }),
  changes: [chg('status', 'Docs Signed', 'Loan Funded'), chg('funded_date', null, '2026-07-31', 'fill')],
})
{
  const r = importRevenueImpact([inman], OVERWRITE)
  // 3602.64 + 1.541% × 204,000 = 3602.64 + 3143.64
  approx('Inman: newly funded adds comp + the Non-Del price credit', r.delta, 6746.28)
  approx('Inman: but the default Agg-leads scope sees $0 of it', r.aggDelta, 0)
  eq('Inman: kind', r.byLo[0].loans[0].kind, 'newly_funded')
  eq('Inman: not an agg lead', r.byLo[0].loans[0].agg, false)
}
{
  // Together — the actual 8/07 picture for Matt: down on the tab he was looking
  // at, up overall. If this pair ever collapses to one number, the panel has
  // recreated the exact confusion it was built to end.
  const r = importRevenueImpact([mutschler, inman], OVERWRITE)
  approx('8/07 combined: all sources is a GAIN', r.delta, 5246.28)
  approx('8/07 combined: agg leads is a LOSS', r.aggDelta, -1500)
  eq('8/07 combined: both loans reported under Matt', r.byLo[0].loans.length, 2)
  eq('8/07 combined: biggest absolute mover first', r.byLo[0].loans[0].borrower, 'Cheyne Inman')
}

// ── 3. The funded gate: in-process comp changes move nothing ────────────────
{
  const inProcess = plan({
    borrower: 'In Process', dealId: 'd3',
    snapshot: snap({ status: 'Submitted to UW', pipeline_group: 'Loans in Process',
                     compensation_amount: 5000, loan_amount: 400000, broker_corr: 'Broker' }),
    changes: [chg('compensation_amount', 5000, 9000)],
  })
  const r = importRevenueImpact([inProcess], OVERWRITE)
  approx('in-process comp change moves $0 (revenue is funded-only)', r.delta, 0)
  eq('in-process change is not counted as a mover', r.movedLoans, 0)
}

// ── 4. Old Deals stay parked — and contribute $0 either way ─────────────────
// The import route preserves OLD_DEALS_GROUP even when it writes a funded status
// (35 of the 77 parked loans still carry an arive_file_no and would otherwise be
// dragged back into Funded). The money must follow that same rule.
{
  const parked = plan({
    borrower: 'Parked Old Deal', dealId: 'd4',
    snapshot: snap({ status: 'Loan Funded', pipeline_group: OLD_DEALS_GROUP, compensation_amount: 12000 }),
    changes: [chg('compensation_amount', 12000, 20000), chg('status', 'Loan Funded', 'Loan Finalized')],
  })
  const r = importRevenueImpact([parked], OVERWRITE)
  approx('a parked Old Deal contributes $0 no matter what changes', r.delta, 0)
  eq('parked Old Deal is not a mover', r.movedLoans, 0)
}

// ── 5. The regression guard: a blocked status never un-funds the money ──────
{
  const blocked = plan({
    borrower: 'Blocked Regression', dealId: 'd5', funded: true, fundedRegressionBlocked: true,
    snapshot: snap({ compensation_amount: 8000, loan_amount: 400000, broker_corr: 'Broker' }),
    changes: [chg('status', 'Loan Funded', 'Non-Responsive', 'blocked')],
  })
  const r = importRevenueImpact([blocked], OVERWRITE)
  approx('a blocked status regression removes $0 of revenue', r.delta, 0)
}
{
  // …but an UNguarded un-funding must be reported loudly, not silently absorbed.
  const unfunding = plan({
    borrower: 'Really Unfunded', dealId: 'd6',
    snapshot: snap({ compensation_amount: 8000, loan_amount: 400000, broker_corr: 'Broker' }),
    changes: [chg('status', 'Loan Funded', 'Non-Responsive')],
  })
  const r = importRevenueImpact([unfunding], OVERWRITE)
  approx('an un-funding removes the whole comp', r.delta, -8000)
  eq('…and is labelled as such', r.byLo[0].loans[0].kind, 'left_funded')
}

// ── 6. Reassignment moves money BETWEEN loan officers ──────────────────────
// loan_officer is an overwritable Arive field (and shieldable, precisely because
// this is consequential). Both tabs move, so both get a signed entry.
{
  const reassigned = plan({
    borrower: 'Reassigned Loan', dealId: 'd7', funded: true,
    snapshot: snap({ loan_officer: 'Moe Sefati', compensation_amount: 10000, loan_amount: 500000, broker_corr: 'Broker' }),
    changes: [chg('loan_officer', 'Moe Sefati', 'Matthew Park')],
  })
  const r = importRevenueImpact([reassigned], OVERWRITE)
  approx('reassignment is net-zero across the firm', r.delta, 0)
  eq('both LOs appear', r.byLo.map(b => b.loanOfficer).sort(), ['Matt Park', 'Moe Sefati'])
  const matt = r.byLo.find(b => b.loanOfficer === 'Matt Park')!
  const moe  = r.byLo.find(b => b.loanOfficer === 'Moe Sefati')!
  approx('Matt gains it', matt.delta, 10000)
  approx('Moe loses it', moe.delta, -10000)
  approx('agg scope tracks the move too (Lending Tree)', matt.aggDelta, 10000)
  eq('Matt sees who it came from', matt.loans[0].counterparty, 'Moe Sefati')
  eq('Moe sees where it went', moe.loans[0].counterparty, 'Matt Park')
  eq('labelled as a reassignment', matt.loans[0].kind, 'reassigned')
  // "Matthew Park" must resolve to the dashboard's canonical "Matt Park" — the
  // Arive export writes the long form, and an unresolved name would open a
  // phantom third LO bucket holding real money.
  eq('Arive\'s "Matthew Park" resolves to the canonical LO', matt.loanOfficer, 'Matt Park')
}

// ── 7. Brand-new funded loans (createUnmatched) ─────────────────────────────
// A create row has no snapshot: its whole comp is new revenue.
{
  const created = plan({
    borrower: 'Brand New Funded', dealId: undefined, matched: false, action: 'create_new',
    snapshot: undefined,
    changes: [
      chg('status', null, 'Loan Funded', 'fill'),
      chg('pipeline_group', null, 'Funded', 'fill'),
      chg('loan_officer', null, 'Matt Park', 'fill'),
      chg('source', null, 'Lendgo', 'fill'),
      chg('compensation_amount', null, 4500, 'fill'),
      chg('loan_amount', null, 225000, 'fill'),
      chg('broker_corr', null, 'Broker', 'fill'),
    ],
  })
  const r = importRevenueImpact([created], OVERWRITE)
  approx('a created funded loan adds its whole comp', r.delta, 4500)
  approx('…and Lendgo puts it in the agg scope', r.aggDelta, 4500)
  eq('kind', r.byLo[0].loans[0].kind, 'newly_funded')
  eq('source carried from the row', r.byLo[0].loans[0].source, 'Lendgo')
}
{
  // An unmatched row that is NOT being created must be ignored entirely.
  const skipped = plan({ borrower: 'Unmatched', matched: false, action: 'update', changes: [] })
  const r = importRevenueImpact([skipped], OVERWRITE)
  eq('an unmatched, uncreated row is ignored', r.movedLoans, 0)
}

// ── 8. The Non-Del gate on the AFTER side ──────────────────────────────────
// Flipping a funded loan's channel to Non-Del switches its price credit on. This
// is the largest single-field money swing the importer can produce, so it must
// show up rather than hide inside "1 field overwritten".
{
  const channelFlip = plan({
    borrower: 'Channel Flip', dealId: 'd8', funded: true,
    snapshot: snap({ compensation_amount: 8212.35, loan_amount: 1094980, broker_corr: 'Broker', net_discount_points: 1.21 }),
    changes: [chg('broker_corr', 'Broker', 'Non-Del')],
  })
  const r = importRevenueImpact([channelFlip], OVERWRITE)
  approx('Broker → Non-Del turns on the Final Price credit', r.delta, 13249.26)
}
{
  // …and the reverse must turn it back off.
  const channelUnflip = plan({
    borrower: 'Channel Unflip', dealId: 'd9', funded: true,
    snapshot: snap({ compensation_amount: 8212.35, loan_amount: 1094980, broker_corr: 'Non-Del', net_discount_points: 1.21 }),
    changes: [chg('broker_corr', 'Non-Del', 'Broker')],
  })
  const r = importRevenueImpact([channelUnflip], OVERWRITE)
  approx('Non-Del → Broker turns it off', r.delta, -13249.26)
}

// ── 9. Attribution edges ───────────────────────────────────────────────────
{
  const noLo = plan({
    borrower: 'No LO', dealId: 'd10', funded: true,
    snapshot: snap({ loan_officer: null, source: null, compensation_amount: 3000, loan_amount: 150000, broker_corr: 'Broker' }),
    changes: [chg('compensation_amount', 3000, 4000)],
  })
  const r = importRevenueImpact([noLo], OVERWRITE)
  eq('an unassigned loan is bucketed, never dropped', r.byLo[0].loanOfficer, UNASSIGNED_LO)
  eq('…with a readable source label', r.byLo[0].loans[0].source, NO_SOURCE)
  approx('…and its money still counts in the total', r.delta, 1000)
  approx('…but not in the agg scope', r.aggDelta, 0)
}
{
  // Float noise must not manufacture a mover: 0.1 + 0.2 style residue on a
  // recomputed credit would otherwise list a loan as "changed by $0".
  const noise = plan({
    borrower: 'Float Noise', dealId: 'd11', funded: true,
    snapshot: snap({ compensation_amount: 1000.001, loan_amount: 100000, broker_corr: 'Broker' }),
    changes: [chg('compensation_amount', 1000.001, 1000.002)],
  })
  const r = importRevenueImpact([noise], OVERWRITE)
  eq('sub-cent noise is not a mover', r.movedLoans, 0)
}
{
  // A numeric column can come back from Postgres as a string; the delta must
  // still be arithmetic, not string concatenation.
  const stringy = plan({
    borrower: 'Stringy Numbers', dealId: 'd12', funded: true,
    snapshot: snap({ compensation_amount: 5000, loan_amount: 250000, broker_corr: 'Broker' }),
    changes: [chg('compensation_amount', '5000', '6000')],
  })
  const r = importRevenueImpact([stringy], OVERWRITE)
  approx('string-typed money values still subtract', r.delta, 1000)
}

// ── 10. Totals reconcile ───────────────────────────────────────────────────
{
  const r = importRevenueImpact([mutschler, inman], OVERWRITE)
  approx('delta == after − before', r.delta, r.after - r.before)
  approx('per-LO deltas sum to the total', r.byLo.reduce((s, b) => s + b.delta, 0), r.delta)
  approx('per-loan deltas sum to their LO', r.byLo[0].loans.reduce((s, l) => s + l.delta, 0), r.byLo[0].delta)
}

console.log(`\n${fail === 0 ? '✓' : '✗'} import-revenue-check — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
