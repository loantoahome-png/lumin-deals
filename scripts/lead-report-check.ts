// Fixture check for lib/leadReport.ts — pure logic, no DB.
// Run: npx tsc lib/leadReport.ts scripts/lead-report-check.ts --outDir /tmp/lrc \
//        --module nodenext --moduleResolution nodenext --skipLibCheck && node /tmp/lrc/scripts/lead-report-check.js
import {
  isPurchased, isResponded, isCold, isOptout, isFunded, matchesLO,
  segment, groupBy, sourceKey, stateKey, purchasedBook, rrBand, type LeadRow,
} from '../lib/leadReport'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++ } else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}
const row = (p: Partial<LeadRow>): LeadRow => ({
  loan_officer: null, pipeline_group: 'Leads', status: 'New Lead', source: 'FRU', state: 'CA', lead_price: 0, ...p,
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
eq('STOP = optout', isOptout(row({ status: 'STOP' })), true)
eq('DND-SMS = optout', isOptout(row({ status: 'DND - SMS' })), true)
eq('optout not responded', isResponded(row({ status: 'DND - SMS' })), false)

// ── Funded ─────────────────────────────────────────────────────────
eq('Funded group = funded', isFunded(row({ pipeline_group: 'Funded', status: 'Loan Funded' })), true)
eq('Broker Check = funded', isFunded(row({ pipeline_group: 'Leads', status: 'Broker Check Received' })), true)
eq('Pitching not funded', isFunded(row({ status: 'Pitching' })), false)

// ── LO matching ────────────────────────────────────────────────────
eq('Matt Park matches Matt', matchesLO(row({ loan_officer: 'Matt Park' }), 'Matt'), true)
eq('Moe Sefati matches Moe', matchesLO(row({ loan_officer: 'Moe Sefati' }), 'Moe'), true)
eq('Matt Park not Moe', matchesLO(row({ loan_officer: 'Matt Park' }), 'Moe'), false)
eq('All matches anyone', matchesLO(row({ loan_officer: 'Matt Park' }), 'All'), true)

// ── Keys ───────────────────────────────────────────────────────────
eq('stateKey upper/trim', stateKey(row({ state: ' ca ' })), 'CA')
eq('stateKey null', stateKey(row({ state: null })), '(no state)')
eq('sourceKey passthrough', sourceKey(row({ source: 'LeadPoint' })), 'LeadPoint')

// ── Segment math ───────────────────────────────────────────────────
// 4 leads: 1 funded(responded), 1 ghosted(responded), 1 new lead(cold), 1 STOP(optout)
const seg = segment([
  row({ status: 'Loan Funded', pipeline_group: 'Funded', lead_price: 100 }),
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
eq('seg cost/funded', seg.cpf, 200)
eq('empty seg cpf null', segment([]).cpf, null)
eq('empty seg rr 0', segment([]).rr, 0)

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
const grp = groupBy(purchasedBook(mixed, 'All'), sourceKey)
eq('groupBy sorted desc by n, FRU first', grp[0].key, 'FRU')
eq('groupBy FRU n', grp.find(g => g.key === 'FRU')!.n, 2)

console.log(`\nlead-report-check: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
