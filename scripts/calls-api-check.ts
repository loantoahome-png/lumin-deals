// Fixture check for lib/callsApi.ts — the API call ingest that replaces the
// manual CSV upload. Every assertion here encodes something measured live on
// 2026-08-11 against both sub-accounts (see the header of lib/callsApi.ts):
//   1. ONLY TYPE_CALL is a dial. TYPE_CAMPAIGN_VOICEMAIL is absent from the CSV
//      and would inflate dial counts ~45%.
//   2. meta.call.duration is SECONDS, not milliseconds.
//   3. from/to swap by direction to give contact vs dialer.
//   4. The timestamp is truncated to the second so the existing dedupe index can
//      recognise an API row as its own CSV twin.
//   5. Randy ('extra') is NOT importable — Efrain excluded him from /calls.
//
// Run: npx tsx scripts/calls-api-check.ts
import { mapApiCall, truncToSecond, callAccountLabel, CALL_SOURCE_FILE, type ApiCallMessage } from '../lib/callsApi'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}

// A real outbound dial, shaped exactly like the live payload.
const OUTBOUND: ApiCallMessage = {
  id: 'msg_1', direction: 'outbound', status: 'completed', messageType: 'TYPE_CALL',
  dateAdded: '2026-08-08T20:36:06.567Z', userId: 'u1', contactId: 'c1',
  from: '+19495554999', to: '+17145555617', meta: { call: { duration: 2391, status: 'completed' } },
}

// ── 1. Only TYPE_CALL is a dial ───────────────────────────────────────────────

eq('TYPE_CALL maps', mapApiCall(OUTBOUND, 'moe') !== null, true)
// ⚠️ The rule that protects every dial-count metric on /calls.
eq('TYPE_CAMPAIGN_VOICEMAIL rejected',
  mapApiCall({ ...OUTBOUND, messageType: 'TYPE_CAMPAIGN_VOICEMAIL' }, 'moe'), null)
eq('TYPE_SMS rejected', mapApiCall({ ...OUTBOUND, messageType: 'TYPE_SMS' }, 'moe'), null)
eq('missing messageType rejected', mapApiCall({ ...OUTBOUND, messageType: undefined }, 'moe'), null)

// ── 2. Duration is seconds, taken verbatim ────────────────────────────────────

eq('duration passes through as SECONDS', mapApiCall(OUTBOUND, 'moe')?.duration_sec, 2391)
eq('missing meta → 0 (reads as not-connected, like a CSV "-")',
  mapApiCall({ ...OUTBOUND, meta: null }, 'moe')?.duration_sec, 0)
eq('missing meta.call → 0', mapApiCall({ ...OUTBOUND, meta: {} }, 'moe')?.duration_sec, 0)
eq('negative duration clamped to 0',
  mapApiCall({ ...OUTBOUND, meta: { call: { duration: -5 } } }, 'moe')?.duration_sec, 0)
eq('fractional duration rounds',
  mapApiCall({ ...OUTBOUND, meta: { call: { duration: 12.6 } } }, 'moe')?.duration_sec, 13)

// ── 3. from/to swap by direction ──────────────────────────────────────────────

const out = mapApiCall(OUTBOUND, 'moe')!
eq('outbound: contact is `to`', out.contact_phone, '7145555617')
eq('outbound: dialer is `from`', out.dialer_number_phone, '9495554999')
const inb = mapApiCall({ ...OUTBOUND, direction: 'inbound' }, 'moe')!
eq('inbound: contact is `from`', inb.contact_phone, '9495554999')
eq('inbound: dialer is `to`', inb.dialer_number_phone, '7145555617')
eq('inbound direction recorded', inb.direction, 'inbound')
// An unexpected direction must not DROP the dial — a lost call is worse than a
// mislabelled one, and only inbound/outbound occur in the live data.
eq('unknown direction treated as outbound',
  mapApiCall({ ...OUTBOUND, direction: 'weird' }, 'moe')?.direction, 'outbound')
eq('no contact phone → rejected (no join key to deals)',
  mapApiCall({ ...OUTBOUND, to: undefined }, 'moe'), null)

// ── 4. Second-truncation (what makes the dedupe index work) ───────────────────

eq('ms truncated, not rounded', truncToSecond('2026-08-08T20:36:06.567Z'), '2026-08-08T20:36:06.000Z')
eq('exact second unchanged', truncToSecond('2026-08-08T20:36:06.000Z'), '2026-08-08T20:36:06.000Z')
eq('999ms still truncates down', truncToSecond('2026-08-08T20:36:06.999Z'), '2026-08-08T20:36:06.000Z')
eq('garbage timestamp → null', truncToSecond('not-a-date'), null)
eq('mapped row carries the truncated ts', out.call_ts, '2026-08-08T20:36:06.000Z')
eq('unparseable dateAdded → row rejected',
  mapApiCall({ ...OUTBOUND, dateAdded: 'nope' }, 'moe'), null)
eq('missing dateAdded → row rejected',
  mapApiCall({ ...OUTBOUND, dateAdded: undefined }, 'moe'), null)

// ── 5. Account vocabulary ─────────────────────────────────────────────────────

eq('primary → moe', callAccountLabel('primary'), 'moe')
eq('matt → matt', callAccountLabel('matt'), 'matt')
// ⚠️ Randy is excluded from /calls by Efrain's explicit decision. Importing his
// calls would silently change every rollup on the page.
eq('extra (Randy) → null, never imported', callAccountLabel('extra'), null)
eq('unknown label → null', callAccountLabel('someone-else'), null)

// ── 6. Provenance + the fields the API genuinely lacks ────────────────────────

eq('source_file marks API provenance', out.source_file, CALL_SOURCE_FILE)
eq('account_label is derived from the queried location', out.account_label, 'moe')
// Disposition is the LO's hand-tag and exists ONLY in the CSV. Nothing computes
// a metric from it, so API rows carry null rather than a guess.
eq('disposition is null (CSV-only field)', out.disposition, null)
eq('first_time is null (CSV-only field)', out.first_time, null)
eq('dialer_number_name is null (export carries numbers, not labels)', out.dialer_number_name, null)
// ⚠️ Retained for audit but NEVER the connect signal — 'completed' includes
// voicemail, exactly like the CSV's 'Answered'. isConnected() uses duration.
eq('call_status keeps the raw GHL outcome', out.call_status, 'completed')
eq('call_status falls back to meta.call.status',
  mapApiCall({ ...OUTBOUND, status: undefined }, 'moe')?.call_status, 'completed')
eq('no-answer status preserved',
  mapApiCall({ ...OUTBOUND, status: 'no-answer', meta: { call: { duration: 0 } } }, 'moe')?.call_status, 'no-answer')

// ── 7. Name resolution ────────────────────────────────────────────────────────

const named = mapApiCall(OUTBOUND, 'moe', p => p === '7145555617' ? 'Damon Hunnicutt' : null)
eq('contact_name resolved from deals', named?.contact_name, 'Damon Hunnicutt')
eq('unresolved name → null', mapApiCall(OUTBOUND, 'moe', () => null)?.contact_name, null)
eq('no resolver → null', out.contact_name, null)

console.log(`\n${fail === 0 ? '✅' : '❌'} calls-api-check: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
