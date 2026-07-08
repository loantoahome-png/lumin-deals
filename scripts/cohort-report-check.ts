// Fixture check for lib/cohortReport.ts — pure logic, no DB.
// Run: npx tsx scripts/cohort-report-check.ts
//  (fallback) npx tsc lib/cohortReport.ts lib/leadReport.ts scripts/cohort-report-check.ts \
//     --outDir /tmp/crc --module nodenext --moduleResolution nodenext --skipLibCheck \
//     && node /tmp/crc/scripts/cohort-report-check.js
import {
  cohortSegment, cohortBreakdown, cohortDelta, filterCohort, analyzeCohort,
  isConverted, isPriced, isDnd, matchesLO, sourceKey, WINDOWS,
  type CohortLead, type FirstRespondedMap,
} from '../lib/cohortReport'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++; else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}
function close(label: string, got: number | null, want: number, eps = 0.02) {
  const ok = got != null && Math.abs(got - want) < eps
  if (ok) pass++; else { fail++; console.error(`✗ ${label}\n   got:  ${got}\n   want: ~${want}`) }
}
function isNull(label: string, got: unknown) {
  if (got === null) pass++; else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: null`) }
}

const NOW = new Date('2026-07-15T12:00:00Z')
const lead = (p: Partial<CohortLead>): CohortLead => ({
  id: 'x', ghl_opportunity_id: null, loan_officer: 'Moe Sefati', pipeline_group: 'Leads',
  status: 'New Lead', source: 'FRU', state: 'CA', loan_purpose: 'Refinance', date_added_ghl: '2026-07-01T00:00:00Z',
  lead_price: 50, dnd: null, dnd_settings: null, ...p,   // priced by default (aggregator lead)
})

// A controlled cohort (created 07-01 … 07-10). now = 07-15T12:00Z.
//  L1 created 07-01, Responded, o1 first-resp 07-03 (+2d)  → timed
//  L2 created 07-01, Pitching,  o2 first-resp 07-10 (+9d)  → timed, slow
//  L3 created 07-01, New Lead,  no ts                      → non-responder
//  L4 created 07-01, Ghosted,   NO ts (responded pre-log)  → state #2 (untimed)
//  L5 created 07-05, Responded, o5 first-resp 07-06 (+1d)  → timed, young (7 only)
//  L6 created 07-10, New Lead,  no ts                      → too young for any window
const rows: CohortLead[] = [
  lead({ id: 'L1', ghl_opportunity_id: 'o1', status: 'Responded', source: 'FRU', date_added_ghl: '2026-07-01T00:00:00Z' }),
  lead({ id: 'L2', ghl_opportunity_id: 'o2', status: 'Pitching',  source: 'FRU', date_added_ghl: '2026-07-01T00:00:00Z' }),
  lead({ id: 'L3', ghl_opportunity_id: 'o3', status: 'New Lead',  source: 'LMB', date_added_ghl: '2026-07-01T00:00:00Z' }),
  lead({ id: 'L4', ghl_opportunity_id: 'o4', status: 'Ghosted',   source: 'LMB', date_added_ghl: '2026-07-01T00:00:00Z' }),
  lead({ id: 'L5', ghl_opportunity_id: 'o5', status: 'Responded', source: 'FRU', date_added_ghl: '2026-07-05T00:00:00Z' }),
  lead({ id: 'L6', ghl_opportunity_id: 'o6', status: 'New Lead',  source: 'LMB', date_added_ghl: '2026-07-10T00:00:00Z' }),
]
const firstResp: FirstRespondedMap = new Map([
  ['o1', '2026-07-03T00:00:00Z'],
  ['o2', '2026-07-10T00:00:00Z'],
  ['o5', '2026-07-06T00:00:00Z'],
])

const seg = cohortSegment(rows, firstResp, NOW)

// ── As-of-today ──────────────────────────────────────────────────────────────
eq('total', seg.total, 6)
eq('respondedNow (Ghosted counts)', seg.respondedNow, 4)          // L1,L2,L4,L5
close('respondedNowPct', seg.respondedNowPct, 66.67)

// ── Three states ────────────────────────────────────────────────────────────
eq('respondedTimed (state 1)', seg.respondedTimed, 3)             // L1,L2,L5
eq('respondedUntimed (state 2)', seg.respondedUntimed, 1)         // L4 (Ghosted, no ts)
eq('notResponded (state 3)', seg.notResponded, 2)                 // L3,L6
close('timingCoverage', seg.timingCoverage, 75)                   // 3 of 4 responders

// ── Time to first response (hours), timed responders only ───────────────────
close('ttr median (48h)', seg.ttrMedianH, 48)                     // [24,48,216] → 48
close('ttr avg (96h)', seg.ttrAvgH, 96)                           // (24+48+216)/3

// ── 7-day window (fixed cohort denominator) ─────────────────────────────────
const w7 = seg.windows[0]
eq('7d window days', w7.days, 7)
eq('7d responded within', w7.responded, 2)          // L1(+2), L5(+1); L2(+9) is a no
eq('7d denominator = whole cohort', w7.total, 6)
close('7d rate (2/6)', w7.rate, 33.33)
close('7d maturedShare (5 of 6 >=7d old)', w7.maturedShare, 83.33)

// ── 14-day window — SAME denominator, cumulative (superset of 7d) ────────────
const w14 = seg.windows[1]
eq('14d window days', w14.days, 14)
eq('14d responded within (cumulative L1,L2,L5)', w14.responded, 3)  // L1(+2), L2(+9), L5(+1)
eq('14d denominator = whole cohort (SAME as 7d)', w14.total, 6)
close('14d rate (3/6)', w14.rate, 50)
close('14d maturedShare (4 of 6 >=14d old)', w14.maturedShare, 66.67)
// The fix: 7d & 14d measure the SAME leads; the response curve is monotonic.
eq('7d and 14d share ONE denominator', w7.total === w14.total, true)
eq('14d rate >= 7d rate (cumulative — never lower)', (w14.rate ?? 0) >= (w7.rate ?? 0), true)
eq('14d responded >= 7d responded', w14.responded >= w7.responded, true)

// ── State #2 (responded, untimed) is IN the denominator, not the numerator ──
// L4 (Ghosted, no ts): responder as-of-today, kept in the cohort denominator, but its
// unknown response time can't be credited to a within-N window — a floor, never a false no.
eq('state#2 in denominator (total incl L4)', w7.total, 6)
eq('state#2 not in 7d responded', w7.responded, 2)
eq('state#2 shows as respondedUntimed', seg.respondedUntimed, 1)

// ── Young cohort: rate is a real 0% floor (NOT null), flagged by maturedShare ─
const young = cohortSegment(
  [lead({ id: 'Y', ghl_opportunity_id: 'y1', status: 'New Lead', date_added_ghl: '2026-07-14T00:00:00Z' })],
  new Map(), NOW,
)
eq('young 7d rate 0% (fixed denom, not null)', young.windows[0].rate, 0)
eq('young 7d responded 0', young.windows[0].responded, 0)
eq('young 7d total 1', young.windows[0].total, 1)
close('young 7d maturedShare 0 (not 7d old)', young.windows[0].maturedShare, 0)
eq('young total 1', young.total, 1)
isNull('rate null ONLY for empty cohort', cohortSegment([], new Map(), NOW).windows[0].rate)

// ── Conversion ──────────────────────────────────────────────────────────────
eq('Loans in Process = converted', isConverted(lead({ pipeline_group: 'Loans in Process', status: 'Loan Setup' })), true)
eq('Arive Lead = converted', isConverted(lead({ status: 'Arive Lead' })), true)
eq('Pre-Approved = converted', isConverted(lead({ status: 'Pre-Approved' })), true)
eq('Pitching not converted', isConverted(lead({ status: 'Pitching' })), false)
eq('New Lead not converted', isConverted(lead({ status: 'New Lead' })), false)
eq('cohort converted count', seg.converted, 0)                    // none of L1..L6 reached conversion

// ── Breakdown sums back to cohort totals ────────────────────────────────────
const bySrc = cohortBreakdown(rows, firstResp, NOW, sourceKey)
eq('breakdown keys', bySrc.map(b => b.key).sort(), ['FRU', 'LMB'])
eq('breakdown totals sum to cohort', bySrc.reduce((s, b) => s + b.seg.total, 0), seg.total)
eq('breakdown respondedNow sums to cohort', bySrc.reduce((s, b) => s + b.seg.respondedNow, 0), seg.respondedNow)
eq('FRU total', bySrc.find(b => b.key === 'FRU')!.seg.total, 3)   // L1,L2,L5
eq('LMB total', bySrc.find(b => b.key === 'LMB')!.seg.total, 3)   // L3,L4,L6

// ── filterCohort (date bounds + null created) ───────────────────────────────
const dated: CohortLead[] = [
  lead({ id: 'in1', date_added_ghl: '2026-06-22T09:00:00Z' }),
  lead({ id: 'in2', date_added_ghl: '2026-06-26T23:00:00Z' }),
  lead({ id: 'out-early', date_added_ghl: '2026-06-21T23:00:00Z' }),
  lead({ id: 'out-late', date_added_ghl: '2026-06-27T00:30:00Z' }),
  lead({ id: 'no-date', date_added_ghl: null }),
]
eq('filterCohort inclusive bounds', filterCohort(dated, '2026-06-22', '2026-06-26').map(r => r.id).sort(), ['in1', 'in2'])
eq('filterCohort drops null date', filterCohort(dated, '2026-01-01', '2026-12-31').some(r => r.id === 'no-date'), false)

// ── LO filter ───────────────────────────────────────────────────────────────
eq('matchesLO All', matchesLO(lead({ loan_officer: 'Matt Park' }), 'All'), true)
eq('matchesLO Matt', matchesLO(lead({ loan_officer: 'Matt Park' }), 'Matt'), true)
eq('matchesLO Moe excludes Matt', matchesLO(lead({ loan_officer: 'Matt Park' }), 'Moe'), false)

// ── analyzeCohort end-to-end ────────────────────────────────────────────────
const res = analyzeCohort(rows, firstResp, NOW, { label: 'A', start: '2026-07-01', end: '2026-07-10' }, 'All')
eq('analyzeCohort seg total', res.seg.total, 6)
eq('analyzeCohort has source/state/purpose breakdowns',
  [res.bySource.length > 0, res.byState.length > 0, res.byPurpose.length > 0], [true, true, true])
// LO-filtered: only Moe (all fixtures are Moe by default) → same 6; Matt → 0
eq('analyzeCohort Matt filter empties cohort',
  analyzeCohort(rows, firstResp, NOW, { label: 'A', start: '2026-07-01', end: '2026-07-10' }, 'Matt').seg.total, 0)

// ── Priced-only (aggregator leads) ──────────────────────────────────────────
eq('isPriced true for positive price', isPriced(lead({ lead_price: 25 })), true)
eq('isPriced false for null price', isPriced(lead({ lead_price: null })), false)
eq('isPriced false for zero price', isPriced(lead({ lead_price: 0 })), false)
const priceMix: CohortLead[] = [
  lead({ id: 'p1', date_added_ghl: '2026-07-01T00:00:00Z', lead_price: 40, status: 'Ghosted' }),
  lead({ id: 'p2', date_added_ghl: '2026-07-01T00:00:00Z', lead_price: null, status: 'Ghosted' }), // organic → excluded
  lead({ id: 'p3', date_added_ghl: '2026-07-01T00:00:00Z', lead_price: 0, status: 'Pitching' }),   // zero → excluded
]
eq('analyzeCohort keeps only priced leads',
  analyzeCohort(priceMix, new Map(), NOW, { label: 'A', start: '2026-07-01', end: '2026-07-01' }, 'All').seg.total, 1)

// ── DND on any channel (opt-out status + master flag + per-channel settings) ──
eq('isDnd: opt-out status STOP', isDnd(lead({ status: 'STOP' })), true)
eq('isDnd: DND-SMS status', isDnd(lead({ status: 'DND - SMS' })), true)
eq('isDnd: master dnd flag', isDnd(lead({ dnd: true })), true)
eq('isDnd: Email channel active', isDnd(lead({ dnd_settings: { Email: { status: 'active' } } })), true)
eq('isDnd: Call channel active', isDnd(lead({ dnd_settings: { Call: { status: 'active' } } })), true)
eq('isDnd: SMS Twilio carrier error NOT counted', isDnd(lead({ dnd_settings: { SMS: { status: 'active', message: 'TWILIO_ERROR_CODE: 30006' } } })), false)
eq('isDnd: SMS genuine opt-out counted', isDnd(lead({ dnd_settings: { SMS: { status: 'active', message: 'unsubscribed' } } })), true)
eq('isDnd: inactive channel not counted', isDnd(lead({ dnd_settings: { Email: { status: 'inactive' } } })), false)
eq('isDnd: SMS carrier-error BUT Email active → still DND', isDnd(lead({ dnd_settings: { SMS: { status: 'active', message: 'TWILIO_ERROR_CODE: 30003' }, Email: { status: 'active' } } })), true)
eq('isDnd: clean lead not DND', isDnd(lead({ status: 'Responded', dnd: false, dnd_settings: null })), false)
const dndSeg = cohortSegment([
  lead({ status: 'STOP' }),                                                                    // opt-out status
  lead({ status: 'Responded', dnd_settings: { Email: { status: 'active' } } }),                // email DND
  lead({ status: 'Responded', dnd_settings: { SMS: { status: 'active', message: 'TWILIO_ERROR_CODE: 30006' } } }), // carrier → NOT dnd
  lead({ status: 'Responded' }),                                                               // clean
], new Map(), NOW)
eq('segment optedOut counts any-channel DND (excl carrier)', dndSeg.optedOut, 2)
close('segment optedOutPct', dndSeg.optedOutPct, 50)

// ── Deltas (B − A) ──────────────────────────────────────────────────────────
const segA = seg
const segB = cohortSegment(
  [ // smaller, less responsive cohort
    lead({ id: 'B1', ghl_opportunity_id: 'b1', status: 'New Lead', date_added_ghl: '2026-07-01T00:00:00Z' }),
    lead({ id: 'B2', ghl_opportunity_id: 'b2', status: 'Responded', date_added_ghl: '2026-07-01T00:00:00Z' }),
  ],
  new Map([['b2', '2026-07-02T00:00:00Z']]), NOW,
)
const del = cohortDelta(segA, segB)
eq('delta total', del.total, segB.total - segA.total)             // 2 - 6 = -4
close('delta respondedNowPct', del.respondedNowPct, segB.respondedNowPct - segA.respondedNowPct)
eq('delta windows length', del.windows.length, WINDOWS.length)
// A 7d rate = 50, B 7d: eligible B1(non-resp)+B2(timed)=2, responded B2(+1)=1 → 50 → delta 0
close('delta 7d rate', del.windows[0].rate, segB.windows[0].rate! - segA.windows[0].rate!)
// null propagation: if one side's window is null, delta is null
const delEmpty = cohortDelta(cohortSegment([], new Map(), NOW), segA)
isNull('delta null when a cohort is empty', delEmpty.windows[0].rate)

console.log(`\ncohort-report-check: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
