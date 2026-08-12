// Fixture check for lib/callsCsv.ts + lib/callsReport.ts — pure logic, no DB, no network.
// Run: npx tsx scripts/calls-check.ts
import { ptToUtc, parseDuration, parseCallsCsv, dedupeKey, dedupeRows, type CallRow } from '../lib/callsCsv'
import {
  isConnected, coveredLos, coverageWindow, effortRollup, economicsRollup, dialerBreakdown,
  activityBuckets, activityInRange, byHourOfDay, dialersInRange, accountsForDialer, dialerNamesInRange,
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

// ── activity buckets ────────────────────────────────────────────────────────
const buckets = activityBuckets(parsed)

// ⚠️ THE TIMEZONE TRAP: the 15:29 PT call is STORED as 22:29Z. If bucketing used
// the raw UTC hour it would file under 22 and land on the wrong day near midnight.
eq('call bucketed to its PT day, not the UTC day', buckets.daily.map(d => d.day), ['2026-08-09', '2026-08-10'])
eq('hour bucketed in PT (15:29 PT, stored 22:29Z)',
  buckets.hourly.filter(h => h.day === '2026-08-10').map(h => h.hour), [15])
eq('weekday from PT date', buckets.daily.find(d => d.day === '2026-08-10')?.weekday, 1) // Mon

// A UTC-evening call belongs to the PREVIOUS PT day — the case a naive slice(0,10) breaks.
const lateCsv = [
  'Date & time,Contact name,Contact phone,Number name,Number phone,Direction,Call status,Disposition,First time,Duration',
  '2026-08-10 18:30:00,Late Call,+13105551234,Brianne\'s Number,+19497495677,outbound,Answered,-,No,01:00',
].join('\n')
const late = parseCallsCsv(lateCsv, 'moe')
eq('6:30pm PT stored as next-day UTC', late[0].call_ts, '2026-08-11T01:30:00.000Z')
eq('…but still buckets to Aug 10 in PT', activityBuckets(late).daily[0].day, '2026-08-10')
eq('…at hour 18, not 1', activityBuckets(late).hourly[0].hour, 18)

// Inbound is excluded from the hour analysis (it connects by definition).
eq('inbound excluded from hourly', buckets.hourly.every(h => h.day !== '2026-08-09'), true)
eq('inbound still counted in daily', buckets.daily.find(d => d.day === '2026-08-09')?.inbound, 1)

const range = activityInRange(buckets.daily, '2026-08-09', '2026-08-10')
eq('range totals: calls', range.calls, 3)
eq('range totals: connects (duration>0 only)', range.connects, 2)
eq('range totals: talk seconds', range.talkSec, 49 + 120)
eq('avg conversation divides by CONNECTS, not all calls', range.avgTalkSec, (49 + 120) / 2)
eq('outbound/inbound split', [range.outbound, range.inbound], [2, 1])

const oneDay = activityInRange(buckets.daily, '2026-08-10', '2026-08-10')
eq('single-day range excludes other days', oneDay.calls, 2)
eq('range outside the data is empty', activityInRange(buckets.daily, '2026-01-01', '2026-01-31').calls, 0)

const hours = byHourOfDay(buckets.hourly, '2026-08-09', '2026-08-10')
eq('hour 15 rate = 1 of 2 dials', [hours[15].calls, hours[15].connects], [2, 1])
eq('empty hour has zero rate, not NaN', hours[3].rate, 0)

const dialerRows = dialersInRange(buckets.dialerDaily, '2026-08-09', '2026-08-10')
eq('dialer rollup in range', dialerRows.map(d => [d.dialer, d.calls, d.connects]),
  [["Brianne's Number", 2, 1], ["Matthew's number", 1, 1]])

// ── per-person filter (the page's main job: how much is Brianne calling) ─────
// Buckets are keyed per day PER DIALER so the whole Activity tab filters
// client-side with no refetch.

const brianne = activityInRange(buckets.daily, '2026-08-09', '2026-08-10', "Brianne's Number")
eq('filtered to one dialer: calls', brianne.calls, 2)
eq('filtered to one dialer: connects', brianne.connects, 1)
// Brianne's two fixture calls are both outbound; the only inbound one is Matthew's.
eq('filtered to one dialer: outbound/inbound split', [brianne.outbound, brianne.inbound], [2, 0])
const matthew = activityInRange(buckets.daily, '2026-08-09', '2026-08-10', "Matthew's number")
eq('a different dialer sees only their own', matthew.calls, 1)
eq('the inbound call belongs to the other dialer', [matthew.outbound, matthew.inbound], [0, 1])
eq('the filters partition the unfiltered total', brianne.calls + matthew.calls, range.calls)
eq('null dialer = everyone (same as omitting it)',
  activityInRange(buckets.daily, '2026-08-09', '2026-08-10', null).calls, range.calls)
eq('unknown name filters to nothing, it does NOT fall back to everyone',
  activityInRange(buckets.daily, '2026-08-09', '2026-08-10', 'Nobody').calls, 0)

// ⚠️ REGRESSION GUARD. `daily` now holds one row per day PER DIALER, so counting
// ROWS would count a day once per active dialer and deflate "calls / active day".
// Aug 10 has two dialers; it is still ONE active day.
eq('active days counts DISTINCT days, not bucket rows', range.activeDays, 2)
eq('…and a single-dialer view sees only the days they dialed', matthew.activeDays, 1)

// The hour chart filters too, or "best hour to dial" would describe the team
// while every number above it describes one person.
const brianneHours = byHourOfDay(buckets.hourly, '2026-08-09', '2026-08-10', "Brianne's Number")
eq('hour chart respects the dialer filter', brianneHours[15].calls, 2)
eq('unfiltered hour 15 is entirely hers', hours[15].calls, brianneHours[15].calls)
// Matthew's only call is INBOUND, and inbound is excluded from the hour analysis
// (it connects by definition). So filtering to him yields an empty hour chart —
// correct, and the reason "no data" must never render as 0%.
eq('a dialer with only inbound calls has no hour data',
  byHourOfDay(buckets.hourly, '2026-08-09', '2026-08-10', "Matthew's number").every(h => h.calls === 0), true)

// Per-ACCOUNT split for one person. Only meaningful because the same person
// dials from a different number in each sub-account, both carrying one label.
const brianneAccounts = accountsForDialer(buckets.dialerDaily, '2026-08-09', '2026-08-10', "Brianne's Number")
eq('per-account split for one dialer', brianneAccounts.map(a => [a.account, a.calls]), [['moe', 2]])
eq('per-account split of someone with no calls is empty',
  accountsForDialer(buckets.dialerDaily, '2026-08-09', '2026-08-10', 'Nobody'), [])
eq('account split sums to the dialer total',
  brianneAccounts.reduce((s, a) => s + a.calls, 0), brianne.calls)
eq('filter options list every dialer in range, busiest first',
  dialerNamesInRange(buckets.dialerDaily, '2026-08-09', '2026-08-10'),
  ["Brianne's Number", "Matthew's number"])

// Empty input must not throw or divide by zero.
eq('empty calls → no window', coverageWindow([]), null)
eq('empty calls → all LOs uncovered', effortRollup([], DEALS).every(r => !r.covered), true)
eq('empty calls → zero leads (no window to scope by)', effortRollup([], DEALS).every(r => r.leads === 0), true)

console.log(`\ncalls-check: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
