// Fixtures for lib/reportMerge.ts — run: npx tsx scripts/report-merge-check.ts
import { detectKind, mergeReports, type ParsedFile } from '../lib/reportMerge'
import { segment, groupBy, sourceKey } from '../lib/leadReport'

let pass = 0, fail = 0
const ok = (cond: boolean, msg: string) => { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg) } }
const near = (a: number, b: number, msg: string) => ok(Math.abs(a - b) < 0.01, `${msg} (got ${a}, want ${b})`)

const file = (name: string, headers: string[], rows: Record<string, string>[]): ParsedFile => ({ name, headers, rows })

// ── detectKind ──────────────────────────────────────────────────────────────
ok(detectKind(['Primary Borrower', 'ARIVE Loan Id', 'Stage Name', 'Compensation Amount', 'Lead Source']) === 'arive-funded', 'detect arive-funded')
ok(detectKind(['Opportunity name', 'Contact Name', 'stage', 'source', 'Lead Price', 'Arive Loan ID', 'assigned']) === 'ghl-opportunities', 'detect ghl-opportunities')
ok(detectKind(['Contact Id', 'First Name', 'Last Name', 'Opportunities', 'Lead Source', 'Lead Price']) === 'ghl-contacts', 'detect ghl-contacts')
ok(detectKind(['name', 'email', 'random']) === 'generic', 'detect generic')
ok(detectKind(['ARIVE LOAN ID', 'stage', 'lead price', 'opportunity name']) === 'ghl-opportunities', 'detect is case/space-insensitive')

// ── fixtures ────────────────────────────────────────────────────────────────
const OPP_H = ['Opportunity name', 'Contact Name', 'stage', 'source', 'Lead Price', 'Arive Loan ID', 'Loan Stage Name', 'assigned', 'Loan Purpose', 'Subject Property State']
const opp = file('opps.csv', OPP_H, [
  // funded, reached Arive, GHL source drifted to "Arive"
  { 'Opportunity name': 'A', 'Contact Name': 'Al Funded', stage: 'App Intake', source: 'Arive', 'Lead Price': '30', 'Arive Loan ID': '111', 'Loan Stage Name': 'Loan Funded', assigned: 'Randy', 'Loan Purpose': 'Refinance', 'Subject Property State': 'CA' },
  // in-process, reached Arive
  { 'Opportunity name': 'B', 'Contact Name': 'Bea Process', stage: 'App Intake', source: 'LMB', 'Lead Price': '40', 'Arive Loan ID': '222', 'Loan Stage Name': 'Approved w/ Conditions', assigned: 'Randy', 'Loan Purpose': 'Refinance', 'Subject Property State': 'TX' },
  // plain responded lead, never reached Arive
  { 'Opportunity name': 'C', 'Contact Name': 'Cy Lead', stage: 'Responded', source: 'Lendgo', 'Lead Price': '25', 'Arive Loan ID': '', 'Loan Stage Name': '', assigned: 'Randy', 'Loan Purpose': 'Refinance', 'Subject Property State': 'CA' },
  // cold lead
  { 'Opportunity name': 'D', 'Contact Name': 'Di Cold', stage: 'Attempted Contact', source: 'FRU', 'Lead Price': '20', 'Arive Loan ID': '', 'Loan Stage Name': '', assigned: 'Randy', 'Loan Purpose': 'Purchase', 'Subject Property State': 'AZ' },
])
const ARIVE_H = ['Primary Borrower', 'ARIVE Loan Id', 'Lead Source', 'Stage Name', 'Compensation Amount', 'Loan Purpose', 'Subject State']
const arive = file('arive.csv', ARIVE_H, [
  { 'Primary Borrower': 'Al Funded', 'ARIVE Loan Id': '111', 'Lead Source': 'LMB', 'Stage Name': 'Loan Funded', 'Compensation Amount': '5000', 'Loan Purpose': 'Refinance', 'Subject State': 'California' },
  { 'Primary Borrower': 'Bea Process', 'ARIVE Loan Id': '222', 'Lead Source': 'LMB', 'Stage Name': 'Approved w/ Conditions', 'Compensation Amount': '3000', 'Loan Purpose': 'Refinance', 'Subject State': 'Texas' },
  // funded loan NOT in the opportunities export (Bryan-like)
  { 'Primary Borrower': 'Ed Extra', 'ARIVE Loan Id': '333', 'Lead Source': 'FRU', 'Stage Name': 'Loan Funded', 'Compensation Amount': '4000', 'Loan Purpose': 'Refinance', 'Subject State': 'Colorado' },
])
const CONTACT_H = ['Contact Id', 'First Name', 'Last Name', 'Opportunities', 'Lead Source', 'Lead Price', 'Mailing State', 'Loan Purpose']
const contacts = file('contacts.csv', CONTACT_H, [
  { 'Contact Id': 'x1', 'First Name': 'Ed', 'Last Name': 'Extra', Opportunities: 'won 4) Funded Loan Funded', 'Lead Source': 'FRU', 'Lead Price': '35', 'Mailing State': 'CO', 'Loan Purpose': 'Refinance' },
  // duplicate of Bea (already in opps by Arive id) — must NOT double-count
  { 'Contact Id': 'x2', 'First Name': 'Bea', 'Last Name': 'Process', Opportunities: 'open 1) Leads App Intake', 'Lead Source': 'LMB', 'Lead Price': '40', 'Mailing State': 'TX', 'Loan Purpose': 'Refinance' },
])

// ── merge: opportunities + arive (the 2-file combo) ─────────────────────────
{
  const { leads, meta } = mergeReports([opp, arive])
  const seg = segment(leads)
  ok(meta.totalLeads === 5, `2-file total leads = 5 (4 opp + 1 appended Ed) — got ${meta.totalLeads}`)
  ok(meta.funded === 2, `2-file funded = 2 (Al + Ed) — got ${meta.funded}`)
  ok(meta.inProcess === 1, `2-file in-process = 1 (Bea) — got ${meta.inProcess}`)
  ok(meta.matchedOutcomes === 2 && meta.appendedOutcomes === 1, `matched 2 (Al,Bea) + appended 1 (Ed) — got ${meta.matchedOutcomes}/${meta.appendedOutcomes}`)
  near(meta.spend, 115, '2-file spend = 30+40+25+20')                 // Ed has no price
  near(meta.realizedRevenue, 5000, '2-file realized = Al only (Ed unpriced, excluded)')
  near(meta.expectedRevenue, 3000, '2-file expected = Bea in-process comp')
  ok(meta.unpricedFunded.includes('Ed Extra'), 'Ed flagged as unpriced funded (excluded from ROI)')
  near(seg.roi ?? -1, 5000 / 115, '2-file segment ROI = realized rev / spend')
  // source drift fixed: Al shows real vendor LMB, not "Arive"
  ok(leads.find(l => l.borrower === 'Al Funded')?.source === 'LMB', 'source drift healed: Al = LMB not Arive')
  // responsiveness: Di (Attempted Contact) is the only cold; the other 4 responded
  ok(seg.cold === 1, `2-file cold = 1 (Di) — got ${seg.cold}`)
}

// ── merge: all three (contacts fills Ed's price + dedupes Bea) ───────────────
{
  const { leads, meta } = mergeReports([opp, arive, contacts])
  ok(meta.totalLeads === 5, `3-file total leads = 5 (Bea NOT double-counted) — got ${meta.totalLeads}`)
  ok(meta.funded === 2, `3-file funded = 2 — got ${meta.funded}`)
  ok(meta.unpricedFunded.length === 0, 'no unpriced funded once contacts supplies Ed price')
  near(meta.spend, 150, '3-file spend = 115 + Ed 35')
  near(meta.realizedRevenue, 9000, '3-file realized = Al 5000 + Ed 4000')
  const bea = leads.filter(l => l.borrower && l.borrower.toLowerCase().includes('bea'))
  ok(bea.length === 1, `Bea appears exactly once across opp+contacts — got ${bea.length}`)
}

// ── merge: arive only (no lead base) → warn, no spend ───────────────────────
{
  const { meta } = mergeReports([arive])
  near(meta.spend, 0, 'arive-only spend = 0 (no lead base)')
  ok(meta.warnings.some(w => /GHL/.test(w)), 'arive-only warns to add a GHL lead export')
}

// ── merge: opportunities only → warn about missing Arive comp ───────────────
{
  const { meta } = mergeReports([opp])
  ok(meta.warnings.some(w => /Arive/.test(w)), 'opps-only warns to add the Arive Funded export')
  near(meta.realizedRevenue, 0, 'opps-only realized revenue = 0 (no trusted comp source)')
}

// ── by-source grouping still works on merged leads ──────────────────────────
{
  const { leads } = mergeReports([opp, arive, contacts])
  const bySrc = groupBy(leads, sourceKey)
  const lmb = bySrc.find(g => g.key === 'LMB')
  ok(!!lmb && lmb.funded === 1, 'by-source LMB has 1 funded (Al, re-attributed)')
}

console.log(`\n${fail === 0 ? '✅' : '❌'} report-merge-check: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
