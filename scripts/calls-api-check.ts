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
import { resolveDialerName, type DialerLabels } from '../lib/callsSync'

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

// ⚠️ REGRESSION GUARD — a null dialer defeats calls_dedupe_uniq, because Postgres
// treats NULL as DISTINCT in a unique index. Two real calls stored twice on
// 2026-08-12 exactly this way (GHL returned them before populating from/to), which
// double-counted Brianne. Empty string collides properly; null never can.
eq('missing dialer number → "" and NEVER null (else dedupe silently fails)',
  mapApiCall({ ...OUTBOUND, from: undefined }, 'moe')?.dialer_number_phone, '')
eq('missing dialer number still keeps the call',
  mapApiCall({ ...OUTBOUND, from: undefined }, 'moe') !== null, true)
eq('blank dialer number → "" not null',
  mapApiCall({ ...OUTBOUND, from: '' }, 'moe')?.dialer_number_phone, '')

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
// ⚠️ The per-dialer rollup groups on dialer_number_name and defaults to 'Unknown',
// so an unresolved label silently removes the call from every per-dialer question
// ("how many calls has Brianne made in each account"). The export carries only the
// NUMBER, so the label is resolved from it via labels already in the table.
eq('dialer_number_name resolved from the dialing number',
  mapApiCall(OUTBOUND, 'moe', undefined, p => p === '9495554999' ? "Mohammad's number" : null)?.dialer_number_name,
  "Mohammad's number")
eq('unknown dialing number → null (lands in Unknown, surfaced by unlabelledDialers)',
  mapApiCall(OUTBOUND, 'moe', undefined, () => null)?.dialer_number_name, null)
eq('no dialer resolver → null', out.dialer_number_name, null)
// Brianne dials from a DIFFERENT number per sub-account — that is the only reason
// her per-account split is answerable at all. The resolver must key on the number,
// never on the person, or the two accounts collapse into one bucket.
eq('inbound resolves the dialer from `to`, not `from`',
  mapApiCall({ ...OUTBOUND, direction: 'inbound' }, 'moe', undefined,
    p => p === '7145555617' ? "Brianne's Number" : null)?.dialer_number_name,
  "Brianne's Number")
// ⚠️ Retained for audit but NEVER the connect signal — 'completed' includes
// voicemail, exactly like the CSV's 'Answered'. isConnected() uses duration.
eq('call_status keeps the raw GHL outcome', out.call_status, 'completed')
eq('call_status falls back to meta.call.status',
  mapApiCall({ ...OUTBOUND, status: undefined }, 'moe')?.call_status, 'completed')
eq('no-answer status preserved',
  mapApiCall({ ...OUTBOUND, status: 'no-answer', meta: { call: { duration: 0 } } }, 'moe')?.call_status, 'no-answer')

// ── 7. Name resolution ────────────────────────────────────────────────────────

// ── 7. Dialer naming: GHL for ownership, the stored rows for spelling ────────
//
// Regression cover for 2026-08-21, when Brianne rotated her line in BOTH
// sub-accounts. The learned map can only name numbers it has already seen, and
// the export payload carries the number without its title — so 334 of her calls
// filed themselves under 'Unknown' on the page whose whole job is her dial
// volume. GHL knows the name because that is where a number is provisioned.

// The state the live system was in on 2026-08-25.
const LABELS: DialerLabels = {
  byPhone: new Map([
    ['9497495677', "Brianne's Number"],   // retired line, still thousands of calls
    ['9492703350', "Matthew's number"],
  ]),
  canonical: new Map([
    ["brianne's number", "Brianne's Number"],
    ["matthew's number", "Matthew's number"],
  ]),
}
// GHL's own titles — note the lower-case 'n', verified live 2026-08-25.
const TITLES = new Map([
  ['9497732190', "Brianne's number"],
  ['9497389920', "Brianne's number"],
  ['9492703350', "Matthew's number"],
])

// The whole point: a number nobody has ever seen still gets named.
eq('a NEW number is named from GHL',
  resolveDialerName('9497732190', TITLES, LABELS), "Brianne's Number")

// ⚠️ The trap that would have re-created the bug. The page groups on the exact
// string, so shipping GHL's spelling verbatim would have split Brianne into
// "Brianne's Number" (5,849 historical calls) and "Brianne's number" (everything
// new) — two people on a page that exists to count one.
eq("GHL's spelling is folded onto the spelling already in the table",
  resolveDialerName('9497389920', TITLES, LABELS), "Brianne's Number")
eq('folding is case-insensitive both ways',
  resolveDialerName('9492703350', TITLES, LABELS), "Matthew's number")

// A RETIRED number leaves GHL's list while its calls stay on the page forever,
// so the learned map is a permanent fallback, never a legacy path.
eq('a number GHL no longer knows falls back to the learned label',
  resolveDialerName('9497495677', TITLES, LABELS), "Brianne's Number")

// An unreachable GHL must degrade to exactly the behaviour that shipped before.
eq('no GHL titles → learned map only',
  resolveDialerName('9492703350', null, LABELS), "Matthew's number")
eq('no GHL titles and an unknown number → null',
  resolveDialerName('9497732190', null, LABELS), null)

// A genuinely new NAME (not just a new number) has nothing to fold onto and is
// taken as GHL writes it.
eq('an unrecognised name is used as GHL spells it',
  resolveDialerName('5551230000', new Map([['5551230000', 'Hanh']]), LABELS), 'Hanh')

// The blank-dialer settle-window rows must not acquire a name.
eq('a blank dialing number stays unnamed',
  resolveDialerName('', TITLES, LABELS), null)


// ── 8. GHL sends a PERSON where the number belongs ──────────────────────────
//
// Verified live 2026-08-25: 10 rows in one sub-account, every one
// status 'failed' / error 'VOICE_CALL_INVALID_PHONE_NUMBER', all to the same
// bad contact number. GHL rejects the destination before assigning an outbound
// line, so it puts the dialing USER'S NAME in `from`. These are real attempts
// by a real person and belong to them, not to 'Unknown'.
const NAME_IN_NUMBER: ApiCallMessage = {
  id: 'hUE8X1g8GqOUm94UFfpK', direction: 'outbound', status: 'failed',
  messageType: 'TYPE_CALL', dateAdded: '2026-08-24T20:22:20.784Z',
  userId: 'SVXQeoFxrP8ZoFd11nyF', contactId: 'X14rfxfxpOzyAcEnORDm',
  from: 'Moe Sefati', to: '+18612106747',
}
const nameRow = mapApiCall(NAME_IN_NUMBER, 'moe', undefined,
  (p, hint) => resolveDialerName(p, TITLES, LABELS, hint))

eq('a person in the number field still names the dialer',
  nameRow?.dialer_number_name, 'Moe Sefati')
// ⚠️⚠️ THE NON-NEGOTIABLE. dialer_number_phone is one third of
// calls_dedupe_uniq. Deriving a number from the name would change the key of
// every one of these rows already stored and insert them all a second time —
// the 2026-08-12 double-count, on purpose this time.
eq('the dialing number stays EMPTY so the dedupe key is unchanged',
  nameRow?.dialer_number_phone, '')
eq('the contact is still read from `to`', nameRow?.contact_phone, '8612106747')
eq('a failed call is still a dial with 0 duration', nameRow?.duration_sec, 0)
eq('the raw failure status is retained for audit', nameRow?.call_status, 'failed')

// If the person's name already exists as a label, it folds — same rule as a title.
eq('a name hint folds onto the spelling already in the table',
  resolveDialerName('', null, {
    byPhone: new Map(),
    canonical: new Map([['moe sefati', 'Moe Sefati']]),
  }, 'MOE SEFATI'), 'Moe Sefati')

// A person is NOT merged into the line they usually dial from: a display name is
// no evidence of which line GHL would have picked, and guessing one would move
// calls between dialers on the page.
eq('a person is not folded into a line label',
  resolveDialerName('', null, LABELS, 'Moe Sefati'), 'Moe Sefati')

// Genuinely empty (the 2026-08-12 settle-window shape: from AND to blank) must
// still resolve to nothing — there is no one to credit.
eq('a truly empty dialer field stays unnamed',
  resolveDialerName('', TITLES, LABELS, null), null)
eq('whitespace is not a name', resolveDialerName('', TITLES, LABELS, '   '), null)


const named = mapApiCall(OUTBOUND, 'moe', p => p === '7145555617' ? 'Damon Hunnicutt' : null)
eq('contact_name resolved from deals', named?.contact_name, 'Damon Hunnicutt')
eq('unresolved name → null', mapApiCall(OUTBOUND, 'moe', () => null)?.contact_name, null)
eq('no resolver → null', out.contact_name, null)

console.log(`\n${fail === 0 ? '✅' : '❌'} calls-api-check: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
