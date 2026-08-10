// Fixture check for lib/callsCsv.ts + lib/callsReport.ts — pure logic, no DB, no network.
// Run: npx tsx scripts/calls-check.ts
import { ptToUtc, parseDuration, parseCallsCsv, dedupeKey, dedupeRows, type CallRow } from '../lib/callsCsv'
import {
  isConnected, coveredLos, coverageWindow, effortRollup, economicsRollup, dialerBreakdown,
  type DealLite,
} from '../lib/callsReport'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++ } else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}

// ── parseDuration ───────────────────────────────────────────────────────────
eq('duration mm:ss', parseDuration('00:49'), 49)
eq('duration hh:mm:ss', parseDuration('01:02:03'), 3723)
eq('duration dash', parseDuration('-'), 0)
eq('duration empty', parseDuration(''), 0)
eq('duration null', parseDuration(null), 0)
eq('duration long call', parseDuration('12:34'), 754)

// ── ptToUtc — THE DST REGRESSION GUARD ──────────────────────────────────────
// August is PDT (UTC-7). A fixed-offset implementation passes this one.
eq('PDT August', ptToUtc('2026-08-10 15:29:07'), '2026-08-10T22:29:07.000Z')
// January is PST (UTC-8). A hardcoded -7 FAILS here — that is the point of this test.
eq('PST January', ptToUtc('2026-01-15 09:00:00'), '2026-01-15T17:00:00.000Z')
// Around the 2026 spring-forward (Mar 8) and fall-back (Nov 1) boundaries.
eq('PST just before spring forward', ptToUtc('2026-03-08 01:30:00'), '2026-03-08T09:30:00.000Z')
// 03:30 on spring-forward day is already PDT (UTC-7) → 10:30 UTC. The 1-hour gap
// vs. the 01:30 case above (PST, UTC-8 → 09:30) is the DST shift itself.
eq('PDT just after spring forward', ptToUtc('2026-03-08 03:30:00'), '2026-03-08T10:30:00.000Z')
eq('PST after fall back', ptToUtc('2026-11-01 03:00:00'), '2026-11-01T11:00:00.000Z')
// Sanity: a PT wall clock must never round-trip to an EARLIER UTC instant.
eq('utc is ahead of pt', Date.parse(ptToUtc('2026-06-01 12:00:00')) > Date.parse('2026-06-01T12:00:00Z'), true)

// ── connect rule ────────────────────────────────────────────────────────────
// The trap: GHL marks 724 real rows 'Answered' AND 'No Answer / Voicemail'.
// "Answered" is a carrier connect, not a human pickup. Only talk time counts.
eq('answered+voicemail with no duration is NOT connected',
  isConnected({ duration_sec: 0 }), false)
eq('any talk time IS connected', isConnected({ duration_sec: 1 }), true)

// ── parseCallsCsv ───────────────────────────────────────────────────────────
const CSV = [
  'Date & time,Contact name,Contact phone,Marketing campaign,Number name,Number phone,Source type,Direction,Call status,Disposition,First time,Keyword,Referrer,Campaign,Duration,Device type,Qualified lead,Landing page,From,To',
  '2026-08-10 15:29:07,Michelle Mccall,+16026992686,-,Brianne\'s Number,+19497495677,-,outbound,Answered,No Answer / Voicemail,No,-,-,-,00:49,-,No,-,+19497495677,+16026992686',
  '2026-08-10 15:28:39,Michelle Mccall,+16026992686,-,Brianne\'s Number,+19497495677,-,outbound,Answered,-,No,-,-,-,-,-,No,-,+19497495677,+16026992686',
  '2026-08-09 10:00:00,Jane Doe,+13105550123,-,Matthew\'s number,+19495550000,-,inbound,Answered,-,Yes,-,-,-,02:00,-,No,-,+13105550123,+19495550000',
  // no phone → skipped
  '2026-08-09 11:00:00,Ghost Row,-,-,Brianne\'s Number,+19497495677,-,outbound,Failed,-,No,-,-,-,-,-,No,-,-,-',
].join('\n')

const parsed = parseCallsCsv(CSV, 'moe', 'test.csv')
eq('parsed row count (phoneless row skipped)', parsed.length, 3)
eq('ts converted to UTC', parsed[0].call_ts, '2026-08-10T22:29:07.000Z')
eq('phone normalized to 10 digits', parsed[0].contact_phone, '6026992686')
eq('dialer phone normalized', parsed[0].dialer_number_phone, '9497495677')
eq('disposition preserved', parsed[0].disposition, 'No Answer / Voicemail')
eq('blank disposition is null', parsed[1].disposition, null)
eq('duration parsed', parsed[0].duration_sec, 49)
eq('missing duration is 0', parsed[1].duration_sec, 0)
eq('first_time yes', parsed[2].first_time, true)
eq('first_time no', parsed[0].first_time, false)
eq('direction lowercased', parsed[2].direction, 'inbound')
eq('account label stamped', parsed[0].account_label, 'moe')

// The row that IS the trap: 'Answered' + voicemail + real talk time.
// call_status must be retained verbatim but must not drive the connect count.
eq('call_status retained verbatim', parsed[0].call_status, 'Answered')

// ── dedupe ──────────────────────────────────────────────────────────────────
eq('dedupe key stable across re-parse',
  dedupeKey(parseCallsCsv(CSV, 'moe')[0]), dedupeKey(parsed[0]))
const dupCsv = CSV + '\n' + CSV.split('\n')[1]   // repeat row 1 verbatim
eq('identical rows collapse', dedupeRows(parseCallsCsv(dupCsv, 'moe')).collapsed, 1)
eq('distinct rows survive', dedupeRows(parsed).rows.length, 3)

// ── coverage guard ──────────────────────────────────────────────────────────
eq('covered = moe only', [...coveredLos(parsed)], ['Moe Sefati'])
eq('coverage window', coverageWindow(parsed), {
  start: '2026-08-09T17:00:00.000Z', end: '2026-08-10T22:29:07.000Z',
})

// ── rollups ─────────────────────────────────────────────────────────────────
const DEALS: DealLite[] = [
  // dialed twice, never connected on the 2nd, connected on the 1st (49s)
  { id: 'd1', name: 'Michelle Mccall', phone: '+1 602-699-2686', loan_officer: 'Moe Sefati',
    source: 'LMB', lead_price: 40, funded_date: null, date_added_ghl: '2026-08-10T00:00:00Z' },
  // never dialed
  { id: 'd2', name: 'Never Called', phone: '+13105559999', loan_officer: 'Moe Sefati',
    source: 'LMB', lead_price: 35, funded_date: null, date_added_ghl: '2026-08-10T00:00:00Z' },
  // Matt's lead, dialed + connected, but Matt has NO import → must read "no data"
  { id: 'd3', name: 'Jane Doe', phone: '+13105550123', loan_officer: 'Matt Park',
    source: 'Lendgo', lead_price: 25, funded_date: '2026-08-11', date_added_ghl: '2026-08-09T00:00:00Z' },
  // organic (no lead price) → excluded from every rollup
  { id: 'd4', name: 'Organic Lead', phone: '+16026992686', loan_officer: 'Moe Sefati',
    source: 'Referral', lead_price: null, funded_date: null, date_added_ghl: '2026-08-10T00:00:00Z' },
  // Randy → excluded by scope
  { id: 'd5', name: 'Randy Lead', phone: '+13105550123', loan_officer: 'Randy Mathis',
    source: 'LMB', lead_price: 30, funded_date: null, date_added_ghl: '2026-08-10T00:00:00Z' },
  // outside the imported call window → excluded, so it can't read as "never dialed"
  { id: 'd6', name: 'Old Lead', phone: '+13105558888', loan_officer: 'Moe Sefati',
    source: 'LMB', lead_price: 50, funded_date: null, date_added_ghl: '2026-01-02T00:00:00Z' },
]

const effort = effortRollup(parsed, DEALS)
const moe = effort.find(r => r.lo === 'Moe Sefati')!
const matt = effort.find(r => r.lo === 'Matt Park')!

eq('moe is covered', moe.covered, true)
eq('matt is NOT covered (no import) → renders no-data', matt.covered, false)
eq('moe leads (purchased, in-window only)', moe.leads, 2)
eq('moe spend', moe.spend, 75)
eq('moe dialed', moe.dialed, 1)
eq('moe connected', moe.connected, 1)
eq('moe dials counted', moe.dials, 2)
eq('moe talk seconds', moe.talkSec, 49)
eq('moe never-dialed list', moe.neverDialed.map(r => r.id), ['d2'])
eq('moe never-dialed spend', moe.neverDialedSpend, 35)
eq('randy absent from effort rows', effort.some(r => r.lo === 'Randy Mathis'), false)
eq('out-of-window lead excluded (not counted as never-dialed)',
  moe.neverDialed.some(r => r.id === 'd6'), false)
eq('organic lead excluded', moe.leads + matt.leads, 3)

// TTFD: first call 2026-08-10T22:29:07Z minus lead-in 2026-08-10T00:00:00Z = 22.485h
eq('moe median ttfd is positive', (moe.medianTtfdHours ?? -1) > 0, true)

const econ = economicsRollup(parsed, DEALS)
const lmb = econ.find(r => r.source === 'LMB')!
eq('LMB leads', lmb.leads, 2)
eq('LMB spend', lmb.spend, 75)
eq('LMB connected leads', lmb.connectedLeads, 1)
eq('LMB cost per connect', lmb.costPerConnect, 75)
eq('LMB dials per lead', lmb.dialsPerLead, 1)
eq('no revenue field leaks into economics', 'revenue' in lmb, false)
eq('referral (organic) excluded from economics', econ.some(r => r.source === 'Referral'), false)

const dialers = dialerBreakdown(parsed, DEALS)
eq('dialer attributed to lead owner', dialers.map(d => [d.lo, d.dialer, d.calls]),
  [['Matt Park', "Matthew's number", 1], ['Moe Sefati', "Brianne's Number", 2]])

// Empty input must not throw or divide by zero.
eq('empty calls → no window', coverageWindow([]), null)
eq('empty calls → all LOs uncovered', effortRollup([], DEALS).every(r => !r.covered), true)
eq('empty calls → zero leads (no window to scope by)', effortRollup([], DEALS).every(r => r.leads === 0), true)

console.log(`\ncalls-check: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
