// Fixture check for lib/leadReport.ts — pure logic, no DB.
// Run: npx tsc lib/leadReport.ts scripts/lead-report-check.ts --outDir /tmp/lrc \
//        --module nodenext --moduleResolution nodenext --skipLibCheck && node /tmp/lrc/scripts/lead-report-check.js
import {
  isPurchased, isResponded, isCold, isCustomerOptout, isTeamRemoved, isOptoutStatus, isFunded, matchesLO, matchesPurpose,
  segment, groupBy, sourceKey, stateKey, purchasedBook, leadBook, rrBand, type LeadRow,
} from '../lib/leadReport'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++ } else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}
const row = (p: Partial<LeadRow>): LeadRow => ({
  loan_officer: null, pipeline_group: 'Leads', status: 'New Lead', source: 'FRU', state: 'CA',
  lead_price: 0, compensation_amount: null, loan_purpose: 'Refinance', last_inbound_at: null, ...p,
})

// ── Purchased vs warm ──────────────────────────────────────────────
eq('FRU is purchased', isPurchased(row({ source: 'FRU' })), true)
eq('lendgo case-insensitive', isPurchased(row({ source: 'lendgo' })), true)
eq('Self Source not purchased', isPurchased(row({ source: 'Self Source' })), false)
eq('Return Client not purchased', isPurchased(row({ source: 'Return Client' })), false)
eq('Arive not purchased', isPurchased(row({ source: 'Arive' })), false)
eq('null source not purchased', isPurchased(row({ source: null })), false)

// ── Responded (Ghosted counts!) ────────────────────────────────────
eq('Ghosted = responded', isResponded(row({ status: 'Ghosted' })), true)
eq('Ghosted not cold', isCold(row({ status: 'Ghosted' })), false)
eq('New Lead = cold', isCold(row({ status: 'New Lead' })), true)
eq('Attempted Contact = cold', isCold(row({ status: 'Attempted Contact' })), true)
eq('Non-Responsive = cold', isCold(row({ status: 'Non-Responsive' })), true)
eq('New Lead not responded', isResponded(row({ status: 'New Lead' })), false)
eq('Pitching = responded', isResponded(row({ status: 'Pitching' })), true)
eq('Lost to Competitor = responded', isResponded(row({ status: 'Lost to Competitor' })), true)
// ── Opt-out split (2026-07-16) — customer signal vs team disposition ───────
// "Remove from All Automations" is a BUTTON WE PRESS (the /hot-leads triage UI),
// not something the borrower did. It was 61% of the old merged bucket and rising
// with triage adoption, making lead quality look like it was collapsing.
eq('STOP = customer optout', isCustomerOptout(row({ status: 'STOP' })), true)
eq('DND-SMS = customer optout', isCustomerOptout(row({ status: 'DND - SMS' })), true)
eq('Remove from All Automations is NOT a customer optout',
   isCustomerOptout(row({ status: 'Remove from All Automations' })), false)
eq('Remove from All Automations IS team-removed',
   isTeamRemoved(row({ status: 'Remove from All Automations' })), true)
eq('STOP is NOT team-removed', isTeamRemoved(row({ status: 'STOP' })), false)

// THE REGRESSION GUARD: the bare-status UNION must stay broad. isRespondedStatus is
// "not cold AND not optout", and Remove-from-All-Automations is not cold — so if it
// ever drops out of the UNION it silently becomes "Responded" at the STATUS level
// (the stage webhook keys off this) — ~295 deals — and flips to_responded.
eq('union still covers team-removed', isOptoutStatus('Remove from All Automations'), true)
eq('union still covers STOP', isOptoutStatus('STOP'), true)
// Row-level split-by-contact (2026-07-17): a team-removed lead counts as responded
// ONLY if it actually has inbound contact; otherwise it's a no-response lead.
eq('team-removed WITHOUT inbound = not responded',
   isResponded(row({ status: 'Remove from All Automations', last_inbound_at: null })), false)
eq('team-removed WITHOUT inbound = cold (no response)',
   isCold(row({ status: 'Remove from All Automations', last_inbound_at: null })), true)
eq('team-removed WITH inbound = responded',
   isResponded(row({ status: 'Remove from All Automations', last_inbound_at: '2026-06-01T00:00:00Z' })), true)
eq('team-removed WITH inbound = NOT cold',
   isCold(row({ status: 'Remove from All Automations', last_inbound_at: '2026-06-01T00:00:00Z' })), false)
eq('customer optout not responded', isResponded(row({ status: 'DND - SMS' })), false)

// ── Funded ─────────────────────────────────────────────────────────
eq('Funded group = funded', isFunded(row({ pipeline_group: 'Funded', status: 'Loan Funded' })), true)
eq('Broker Check = funded', isFunded(row({ pipeline_group: 'Leads', status: 'Broker Check Received' })), true)
eq('Pitching not funded', isFunded(row({ status: 'Pitching' })), false)

// ── LO matching ────────────────────────────────────────────────────
eq('Matt Park matches Matt', matchesLO(row({ loan_officer: 'Matt Park' }), 'Matt'), true)
eq('Moe Sefati matches Moe', matchesLO(row({ loan_officer: 'Moe Sefati' }), 'Moe'), true)
eq('Matt Park not Moe', matchesLO(row({ loan_officer: 'Matt Park' }), 'Moe'), false)
eq('All matches anyone', matchesLO(row({ loan_officer: 'Matt Park' }), 'All'), true)
eq('Randy Mathis matches Randy', matchesLO(row({ loan_officer: 'Randy Mathis' }), 'Randy'), true)
eq('Randy Mathis not Moe', matchesLO(row({ loan_officer: 'Randy Mathis' }), 'Moe'), false)
eq('Moe Sefati not Randy', matchesLO(row({ loan_officer: 'Moe Sefati' }), 'Randy'), false)

// ── Purpose matching ───────────────────────────────────────────────
eq('purpose All matches anything', matchesPurpose(row({ loan_purpose: null }), 'All'), true)
eq('Purchase matches', matchesPurpose(row({ loan_purpose: 'Purchase' }), 'Purchase'), true)
eq('Refinance matches case-insensitive', matchesPurpose(row({ loan_purpose: 'refinance' }), 'Refinance'), true)
eq('HELOC grouped into Refinance', matchesPurpose(row({ loan_purpose: 'HELOC' }), 'Refinance'), true)
eq('Purchase is not Refinance', matchesPurpose(row({ loan_purpose: 'Purchase' }), 'Refinance'), false)
eq('null purpose excluded from Purchase', matchesPurpose(row({ loan_purpose: null }), 'Purchase'), false)

// ── Keys ───────────────────────────────────────────────────────────
eq('stateKey upper/trim', stateKey(row({ state: ' ca ' })), 'CA')
eq('stateKey null', stateKey(row({ state: null })), '(no state)')
eq('sourceKey passthrough', sourceKey(row({ source: 'LeadPoint' })), 'LeadPoint')

// ── Segment math ───────────────────────────────────────────────────
// 4 leads: 1 funded(responded), 1 ghosted(responded), 1 new lead(cold), 1 STOP(optout)
const seg = segment([
  row({ status: 'Loan Funded', pipeline_group: 'Funded', lead_price: 100, compensation_amount: 5000 }),
  row({ status: 'Ghosted', lead_price: 50 }),
  row({ status: 'New Lead', lead_price: 30 }),
  row({ status: 'STOP', lead_price: 20 }),
])
eq('seg n', seg.n, 4)
eq('seg responded', seg.responded, 2)
eq('seg cold', seg.cold, 1)
eq('seg optout', seg.optout, 1)
eq('seg funded', seg.funded, 1)
eq('seg rr', seg.rr, 50)
eq('seg spend', seg.spend, 200)
eq('seg revenue', seg.revenue, 5000)
eq('seg roi', seg.roi, 25)                 // 5000 comp ÷ 200 spend = 25×
eq('empty seg roi null', segment([]).roi, null)

// ── Segment partition after team-removed split-by-contact (2026-07-17) ─────
// {responded, cold, customer-optout} partition the set (sum to n). teamRemoved is
// now an OVERLAY: each team-removed lead folds into responded (had inbound) or cold
// (never did), so it must NOT be added to the partition sum or it double-counts.
const segSplit = segment([
  row({ status: 'Pitching' }),                                                             // responded
  row({ status: 'New Lead' }),                                                             // cold
  row({ status: 'STOP' }),                                                                 // customer optout
  row({ status: 'Remove from All Automations', last_inbound_at: null }),                   // team-removed, no reply → cold
  row({ status: 'Remove from All Automations', last_inbound_at: '2026-06-01T00:00:00Z' }), // team-removed, replied → responded
])
eq('split: n', segSplit.n, 5)
eq('split: responded = Pitching + team-removed-with-inbound', segSplit.responded, 2)
eq('split: cold = New Lead + team-removed-no-inbound', segSplit.cold, 2)
eq('split: optout = customer only (STOP)', segSplit.optout, 1)
eq('split: teamRemoved overlay counts both team-removed', segSplit.teamRemoved, 2)
eq('split: {responded,cold,optout} partition n (teamRemoved is overlay)',
   segSplit.responded + segSplit.cold + segSplit.optout, segSplit.n)
eq('split: orate is customer-only (1/5)', segSplit.orate, 20)
eq('split: trate is team-only (2/5)', segSplit.trate, 40)
// Money cohort = priced leads only. A funded loan whose lead price was never
// recorded is excluded from BOTH revenue and spend, so its comp can't inflate ROI.
const segUnpriced = segment([
  row({ status: 'Loan Funded', pipeline_group: 'Funded', lead_price: 100, compensation_amount: 4000 }),
  row({ status: 'Loan Funded', pipeline_group: 'Funded', lead_price: null, compensation_amount: 9999 }),
])
eq('unpriced comp excluded from revenue', segUnpriced.revenue, 4000)
eq('unpriced excluded from spend', segUnpriced.spend, 100)
eq('roi uses priced cohort only', segUnpriced.roi, 40)   // 4000/100, NOT 13999/100
// A zero/undefined-price lead is outside the money cohort → no spend → ROI null.
eq('no-spend roi null', segment([row({ status: 'Loan Funded', pipeline_group: 'Funded', lead_price: 0, compensation_amount: 5000 })]).roi, null)
eq('empty seg rr 0', segment([]).rr, 0)
// Revenue = EARNED comp → funded loans only. Arive pre-fills compensation_amount
// at setup and it lingers on leads that never fund, so a non-funded priced lead
// carrying comp must NOT add revenue (this was overstating revenue ~3×).
const segLingeringComp = segment([
  row({ status: 'Loan Funded', pipeline_group: 'Funded', lead_price: 100, compensation_amount: 5000 }),
  row({ status: 'Non-Responsive', pipeline_group: 'Not Ready', lead_price: 40, compensation_amount: 8000 }), // comp but dead → excluded
  row({ status: 'Approved w/ Conditions', pipeline_group: 'Loans in Process', lead_price: 60, compensation_amount: 3000 }), // in escrow, not funded → excluded
])
eq('revenue counts funded comp only', segLingeringComp.revenue, 5000)
eq('spend still counts all priced leads', segLingeringComp.spend, 200)
eq('roi = funded comp / total spend', segLingeringComp.roi, 5000 / 200)   // 25×, NOT 16000/200=80×
// All-sources scope: warm/referral funded loans carry comp but NO lead price. Their
// comp is real earned revenue, so allFundedRevenue=true must count it; the default
// (purchased) still drops unpriced comp so spend & revenue stay comparable.
const warmFunded = [
  row({ source: 'Return Client', status: 'Loan Funded', pipeline_group: 'Funded', lead_price: null, compensation_amount: 4000 }),
  row({ source: 'FRU', status: 'Loan Funded', pipeline_group: 'Funded', lead_price: 100, compensation_amount: 1000 }),
]
eq('purchased scope excludes unpriced warm comp', segment(warmFunded).revenue, 1000)
eq('all scope includes unpriced warm comp', segment(warmFunded, true).revenue, 5000)
eq('spend is priced-only regardless of scope', segment(warmFunded, true).spend, 100)

// ── rrBand thresholds ──────────────────────────────────────────────
eq('rrBand 28 = good', rrBand(28), 'good')
eq('rrBand 27.9 = mid', rrBand(27.9), 'mid')
eq('rrBand 20 = mid', rrBand(20), 'mid')
eq('rrBand 19.9 = bad', rrBand(19.9), 'bad')

// ── purchasedBook + groupBy ────────────────────────────────────────
const mixed: LeadRow[] = [
  row({ source: 'FRU', loan_officer: 'Matt Park', status: 'Ghosted' }),
  row({ source: 'FRU', loan_officer: 'Moe Sefati', status: 'New Lead' }),
  row({ source: 'Self Source', loan_officer: 'Matt Park', status: 'Loan Funded', pipeline_group: 'Funded' }), // warm → excluded
  row({ source: 'Lendgo', loan_officer: 'Matt Park', status: 'Pitching' }),
]
eq('purchasedBook All excludes warm', purchasedBook(mixed, 'All').length, 3)
eq('purchasedBook Matt', purchasedBook(mixed, 'Matt').length, 2)
// leadBook scope: 'All' keeps warm sources (Self Source), 'Purchased' drops them.
eq('leadBook All-scope includes warm', leadBook(mixed, 'All', 'All', 'All').length, 4)
eq('leadBook Purchased-scope == purchasedBook', leadBook(mixed, 'All', 'All', 'Purchased').length, 3)
eq('leadBook All-scope Matt keeps warm Matt', leadBook(mixed, 'Matt', 'All', 'All').length, 3)

// purpose filter on the cohort
const purp: LeadRow[] = [
  row({ source: 'FRU', status: 'Ghosted', loan_purpose: 'Purchase' }),
  row({ source: 'FRU', status: 'Pitching', loan_purpose: 'Refinance' }),
  row({ source: 'Lendgo', status: 'Pitching', loan_purpose: 'HELOC' }),
  row({ source: 'LMB', status: 'New Lead', loan_purpose: null }),       // untagged → only under All
  row({ source: 'Self Source', status: 'Loan Funded', loan_purpose: 'Purchase' }), // warm → excluded always
]
eq('purpose All keeps all purchased (incl untagged)', purchasedBook(purp, 'All', 'All').length, 4)
eq('purpose Purchase', purchasedBook(purp, 'All', 'Purchase').length, 1)
eq('purpose Refinance includes HELOC', purchasedBook(purp, 'All', 'Refinance').length, 2)
eq('purchasedBook default purpose = All', purchasedBook(purp, 'All').length, 4)
const grp = groupBy(purchasedBook(mixed, 'All'), sourceKey)
eq('groupBy sorted desc by n, FRU first', grp[0].key, 'FRU')
eq('groupBy FRU n', grp.find(g => g.key === 'FRU')!.n, 2)

console.log(`\nlead-report-check: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
