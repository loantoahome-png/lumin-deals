// Fixture check for lib/ariveCsv.ts matching — pure logic, no DB.
// Run: npx tsc lib/ariveCsv.ts scripts/arive-match-check.ts --outDir /tmp/amc \
//        --module nodenext --moduleResolution nodenext --skipLibCheck && node /tmp/amc/scripts/arive-match-check.js
//
// Regression guard for the 2026-06-29 duplicate-card incident: an Arive import
// created blank SHELL cards for loans that already had cards, because (older)
// name matching missed real-world name variants and the LOS name "Arive" leaked
// into `source`. Both are fixed now — these cases lock that in so it can't regress.
import { buildMatchIndex, matchRow, isRealLeadSource, parseRowsFromCsv, rowToPatch, buildPlan, summarizePlan } from '../lib/ariveCsv'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++ } else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}
type M = ReturnType<typeof matchRow>
// Access via `as` (not union-narrowing) so this stays clean even when compiled
// without strictNullChecks, e.g. the bare `tsc` run command documented above.
const viaOf    = (r: M) => ((r as { via?: string }).via ?? '')
const reasonOf = (r: M) => ((r as { reason?: string }).reason ?? '')

// Existing cards as they looked on 6/29 — real card present, but arive_file_no
// NOT yet set, so a match MUST succeed on name alone (the exact failure window).
const ix = buildMatchIndex([
  { id: 'chris', name: 'Christopher Lokers',        email: null, phone: null, arive_file_no: null },
  { id: 'esme',  name: 'Esmeraldo N. Gorecho, III', email: null, phone: null, arive_file_no: null },
  { id: 'gus',   name: 'Gustavo Magana',            email: null, phone: null, arive_file_no: null },
])
const m = (name: string, af?: string) => matchRow({ __borrower_name: name, arive_file_no: af } as never, ix)

// ── Real 6/29 variants that MUST match an existing card (not spawn a shell) ──
eq('middle-name variant matches',      m('Christopher Dustan Lokers', '16245944').matched, true)
eq('  ...via first+last',        viaOf(m('Christopher Dustan Lokers', '16245944')), 'name_firstlast')
eq('suffix+comma+middle matches',      m('Esmeraldo Norman Gorecho III', '16072217').matched, true)
eq('  ...via first+last',        viaOf(m('Esmeraldo Norman Gorecho III', '16072217')), 'name_firstlast')
eq('exact name still matches',   viaOf(m('Gustavo Magana', '16123664')), 'name')

// ── arive_file_no is authoritative once it's set (post-backfill) ──
const ixAf = buildMatchIndex([{ id: 'x', name: 'Someone Else', email: null, phone: null, arive_file_no: '999' }])
eq('arive_file_no beats name', viaOf(matchRow({ __borrower_name: 'Totally Different', arive_file_no: '999' } as never, ixAf)), 'arive_file_no')

// ── A true stranger is no_match (so createUnmatched makes ONE new card, not a dup of an existing person) ──
eq('stranger = no match',        m('Jane Nobody', '444').matched, false)
eq('  ...reason no_match', reasonOf(m('Jane Nobody', '444')), 'no_match')

// ── Ambiguous (2 people share first+last) must NOT be a false match ──
const ixAmb = buildMatchIndex([
  { id: 'a', name: 'John Smith', email: null, phone: null, arive_file_no: null },
  { id: 'b', name: 'John Smith', email: null, phone: null, arive_file_no: null },
])
eq('ambiguous name not matched', matchRow({ __borrower_name: 'John A Smith' } as never, ixAmb).matched, false)

// ── The LOS name must never become a lead source (the shells carried source="Arive") ──
eq('Arive rejected as source',   isRealLeadSource('Arive'), false)
eq('los rejected as source',     isRealLeadSource('LOS'),   false)
eq('real source accepted',       isRealLeadSource('Lending Tree'), true)

// ── The 2026-08-03 funded template: padded headers + a hand-totalled footer ────
// Efrain's export shipped " Compensation Amount " and " ysp comp " with literal
// padding, and ended with totals rows that have money but no borrower.
const CSV = [
  'Primary Borrower,ARIVE Loan Id,Total Loan Amount, Compensation Amount ,Channel,Net Discount Points, ysp comp ,Loan Funded',
  'Edward James Fadel,16541057,1094980," $8,212.35 ",Non-Del,1.21," $13,249.26 ",5/1/26',
  'Thomas Joe Lathouwers,16537339,447300," $8,946.00 ",Broker,0,,5/14/26',
  ',,," $17,158.35 ",,," $13,249.26 ",',
].join('\n')
const parsed = parseRowsFromCsv(CSV).map(r => rowToPatch(r))
eq('padded header still reads comp', parsed[0].compensation_amount, 8212.35)
eq('padded header, 2-digit date',    parsed[0].funded_date, '2026-05-01')
eq('points read on Non-Del',         parsed[0].net_discount_points, 1.21)
eq('channel read',                   parsed[0].broker_corr, 'Non-Del')
eq('broker row keeps its comp',      parsed[1].compensation_amount, 8946)

// The footer row must never become a deal — with createUnmatched on it would
// otherwise be a new "Unknown" card holding the month's whole compensation.
const emptyIx = buildMatchIndex([])
const plans = buildPlan({ rows: parsed as never, deals: new Map(), ix: emptyIx, mode: 'overwrite', createUnmatched: true })
eq('totals row dropped from the plan', plans.length, 2)
eq('no plan is named Unknown', plans.some(p => /unknown/i.test(p.borrower)), false)
eq('real rows still planned', plans.map(p => p.borrower), ['Edward James Fadel', 'Thomas Joe Lathouwers'])

// ── GHL-owned fields (2026-09-02): status + loan_amount are skipped until funded ──
// The 20:48 overwrite import pushed Arive's status/amount onto ~300 lead/in-process
// deals; the 21:30 maintenance sync wrote GHL's values back; the next preview showed
// the same 334 "overwrites". These lock the rule: not funded → skip both (fill AND
// overwrite); funded, or funded BY this row → Arive writes as before.
{
  const ixG = buildMatchIndex([
    { id: 'lead',    name: 'Lead Person',    email: null, phone: null, arive_file_no: 'L1' },
    { id: 'blank',   name: 'Blank Amount',   email: null, phone: null, arive_file_no: 'L2' },
    { id: 'funding', name: 'Funding Now',    email: null, phone: null, arive_file_no: 'L3' },
    { id: 'funded',  name: 'Already Funded', email: null, phone: null, arive_file_no: 'L4' },
  ])
  const dealsG = new Map<string, Record<string, unknown>>([
    ['lead',    { status: 'Not Ready - Timeframe', pipeline_group: 'Not Ready', loan_amount: 0, rate: 6.5 }],
    ['blank',   { status: 'App Intake', pipeline_group: 'Leads', loan_amount: null }],
    ['funding', { status: 'Clear to Close', pipeline_group: 'Loans in Process', loan_amount: 400000 }],
    ['funded',  { status: 'Loan Funded', pipeline_group: 'Funded', loan_amount: 301090 }],
  ])
  const rowsG = [
    { __borrower_name: 'Lead Person',    arive_file_no: 'L1', status: 'App Intake',  loan_amount: 25000,  rate: 6.875 },
    { __borrower_name: 'Blank Amount',   arive_file_no: 'L2', status: 'App Intake',  loan_amount: 90000 },
    { __borrower_name: 'Funding Now',    arive_file_no: 'L3', status: 'Loan Funded', loan_amount: 398500 },
    { __borrower_name: 'Already Funded', arive_file_no: 'L4', status: 'Loan Funded', loan_amount: 210000 },
  ]
  const plansG = buildPlan({ rows: rowsG as never, deals: dealsG, ix: ixG, mode: 'overwrite' })
  const act = (i: number, f: string) => plansG[i].changes.find(c => c.field === f)?.action
  eq('lead: status differs but GHL-owned',          act(0, 'status'),      'ghl_owned')
  eq('lead: loan_amount differs but GHL-owned',     act(0, 'loan_amount'), 'ghl_owned')
  eq('lead: other fields still overwrite',          act(0, 'rate'),        'overwrite')
  eq('lead: a blank loan_amount is not even filled', act(1, 'loan_amount'), 'ghl_owned')
  eq('row that FUNDS the loan writes status',       act(2, 'status'),      'overwrite')
  eq('row that FUNDS the loan writes loan_amount',  act(2, 'loan_amount'), 'overwrite')
  eq('already-funded deal: Arive owns loan_amount', act(3, 'loan_amount'), 'overwrite')
  eq('already-funded deal: same status is unchanged', act(3, 'status'),    'unchanged')
  const sumG = summarizePlan(plansG)
  eq('summary counts GHL-owned separately', [sumG.fields_ghl_owned, sumG.fields_to_overwrite], [3, 4])
}

console.log(`arive-match-check: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
