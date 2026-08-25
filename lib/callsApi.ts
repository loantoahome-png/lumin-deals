// ── GHL call ingest via the API — automates the manual CSV upload ────────────
//
// WHY THIS EXISTS (and why the header comment in supabase-calls.sql is now only
// half true): GHL still exposes no *call* endpoint — /calls, /reporting/calls,
// /phone-system/calls and /voice-ai/call-logs all 404 against a Private
// Integration token, exactly as recorded on 2026-08-10. But
// `GET /conversations/messages/export` IS a working location-wide, cursor-paged
// message feed, and its TYPE_CALL rows carry everything /calls actually computes.
// Probed live 2026-08-11 against BOTH sub-accounts with the existing keys.
//
// GROUND TRUTH from that probe (window 2026-08-04 → 08-09; 713 stored CSV rows):
//  * API TYPE_CALL count for the window was **713** — an exact 1:1 with the CSV.
//  * ⚠️ TYPE_CAMPAIGN_VOICEMAIL is NOT in the CSV (615 in those same 5 days).
//    Ringless drops are not dials; importing them would inflate dial counts ~45%
//    and wreck dials/lead. ONLY TYPE_CALL is a dial. This is the single most
//    important rule in this file.
//  * `meta.call.duration` is in SECONDS: across all 393 calls where both sources
//    report a non-zero duration the values are identical (db/api ratio 1.000 at
//    p10, p50 AND p90). It is NOT milliseconds.
//  * `from`/`to` + `direction` identify dialer vs contact with ZERO misses in
//    712 rows — so unlike the CSV, `account_label` no longer has to be hand-tagged
//    at upload: it is the location we queried.
//  * `dateAdded` carries milliseconds; the CSV truncates to the second. We
//    truncate too — that is what lets the EXISTING
//    (call_ts, contact_phone, dialer_number_phone) unique index recognise an API
//    row as its own CSV twin instead of inserting a duplicate. No migration needed.
//  * status vocabulary: completed | no-answer | busy | voicemail | failed.
//
// ⚠️⚠️ KNOWN, UNRESOLVED DIVERGENCE — deliberately not papered over.
// On 189 of 712 paired calls (27%) the CSV and the API disagree about whether the
// call connected AT ALL, in BOTH directions: 105 where the API reports a duration
// and the CSV says 0, and 84 the other way (including a CSV row of 4,839s that the
// API calls 0). Where both report a duration they agree exactly. Which source is
// correct is NOT determinable from our side, so it is not asserted anywhere.
// Consequence: `isConnected()` (duration_sec > 0) can read differently for an
// API-sourced row than the CSV would have produced for the same call.
// That is why this sweep is FORWARD-ONLY and never rewrites an existing row —
// imported history stays byte-for-byte as it was, and the cutover is visible in
// `source_file`. Do not "fix" this by backfilling over the CSV period.

import { normPhone } from './dealMatcher'
import type { CallRow, AccountLabel } from './callsCsv'
import { GHL_BASE, ghlHeaders, type GHLAccount } from './ghl'

/** Marks a row as API-sourced. Distinguishable from CSV rows, which carry the
 *  uploaded file's name. Also the seam if the divergence above ever needs auditing. */
export const CALL_SOURCE_FILE = 'ghl-api'

/** Conversations endpoints use a different API version than the rest of GHL
 *  (2021-07-28 answers here too, but 2021-04-15 is what the rest of the
 *  conversations code sends — keep them consistent). */
const CONV_VERSION = '2021-04-15'

/** Only a real dialed call. See the TYPE_CAMPAIGN_VOICEMAIL warning above. */
const DIALED_CALL_TYPE = 'TYPE_CALL'

export type ApiCallMessage = {
  id?: string
  direction?: string
  status?: string
  messageType?: string
  dateAdded?: string
  from?: string
  to?: string
  userId?: string
  contactId?: string
  meta?: { call?: { duration?: number; status?: string } } | null
}

/** GHL account label → the `calls.account_label` vocabulary.
 *  ⚠️ Anything that isn't 'primary' or 'matt' maps to null ON PURPOSE — that is
 *  'extra' (Randy) and 'daniel', both excluded from the call report by explicit
 *  decision, and `AccountLabel` has no slot for either. Silently importing their
 *  calls would change every rollup on /calls. A new GHL account therefore stays
 *  out of /calls until someone adds it here deliberately. */
export function callAccountLabel(ghlLabel: string): AccountLabel | null {
  if (ghlLabel === 'primary') return 'moe'
  if (ghlLabel === 'matt') return 'matt'
  return null
}

/** Truncate an ISO instant to whole seconds, matching the CSV's precision so the
 *  dedupe index can pair the two representations of one call. */
export function truncToSecond(iso: string): string | null {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return null
  return new Date(Math.floor(t / 1000) * 1000).toISOString()
}

/**
 * Map one export message to a `calls` row, or null if it isn't an ingestable dial.
 *
 * `nameFor` resolves a contact name from our own `deals` table — the API gives a
 * contactId, not a name, and leaving contact_name null would blank the Activity
 * tab for every new call. Unresolvable → null, same as a CSV row with no name.
 */
export function mapApiCall(
  m: ApiCallMessage,
  accountLabel: AccountLabel,
  nameFor?: (phone: string) => string | null,
  dialerNameFor?: (phone: string, nameHint?: string | null) => string | null,
): CallRow | null {
  if (m.messageType !== DIALED_CALL_TYPE) return null
  if (!m.dateAdded) return null
  const call_ts = truncToSecond(m.dateAdded)
  if (!call_ts) return null

  const dir = String(m.direction ?? '').toLowerCase()
  // Anything that isn't explicitly inbound is treated as outbound, matching the
  // observed data (only 'inbound'/'outbound' occur) without dropping rows on an
  // unexpected value — a dropped dial is worse than a mislabelled one.
  const isInbound = dir === 'inbound'
  const contact_phone = normPhone(isInbound ? m.from : m.to)
  if (!contact_phone) return null              // no join key → useless to the report
  // ⚠️ NEVER null. `calls_dedupe_uniq` is (call_ts, contact_phone,
  // dialer_number_phone) and Postgres treats NULL as DISTINCT in a unique index —
  // so a null here silently defeats dedupe and the row can insert forever.
  // Observed for real on 2026-08-12: GHL returned two calls before it had
  // populated `from`/`to`, they stored with a null dialer, a later fetch returned
  // them complete, and both landed a SECOND time — double-counting Brianne and
  // inventing an "Unknown" dialer on the page whose whole purpose is her volume.
  // '' collides properly. (No CSV row has a null dialer, so nothing pre-existing
  // changes key.) The settle window in callsSync stops the incomplete read itself.
  const dialerRaw = String((isInbound ? m.to : m.from) ?? '').trim()
  const dialer_number_phone = normPhone(dialerRaw) ?? ''

  // ⚠️ When GHL rejects the destination outright it never assigns an outbound
  // LINE, and drops the dialing USER'S DISPLAY NAME into the number field
  // instead — verified 2026-08-25 on 10 rows, every one
  // `status: 'failed'`, `error: 'VOICE_CALL_INVALID_PHONE_NUMBER'`,
  // `from: 'Moe Sefati'`. normPhone can't parse a person, so the row stored with
  // an empty dialer and fell into the per-dialer 'Unknown' bucket.
  //
  // The name is still the truth about who dialed, so it is passed through as a
  // label hint. `dialer_number_phone` deliberately stays '' — it is one third of
  // `calls_dedupe_uniq`, and inventing a number here would change the key of
  // rows already stored and re-insert every one of them.
  const dialerNameHint = dialer_number_phone ? null : (dialerRaw || null)

  // Duration lives under meta.call. Absent (e.g. campaign rows) → 0, which reads
  // as "not connected" via isConnected() — the same meaning a CSV '-' carries.
  const duration_sec = Math.max(0, Math.round(Number(m.meta?.call?.duration ?? 0)) || 0)

  return {
    call_ts,
    contact_phone,
    contact_name: nameFor?.(contact_phone) ?? null,
    direction: isInbound ? 'inbound' : 'outbound',
    // Raw GHL outcome, retained for audit exactly like the CSV's own status
    // column. ⚠️ NOT the connect signal — 'completed' is a carrier-level connect
    // and includes voicemail, the same trap as the CSV's 'Answered'.
    call_status: m.status ?? m.meta?.call?.status ?? null,
    // The API has no Disposition — that field is the LO's hand-tag, which exists
    // only in the CSV export. Nothing computes a metric from it (verified), so
    // API rows simply carry null.
    disposition: null,
    duration_sec,
    // ⚠️ LOAD-BEARING. The export carries the dialing NUMBER but not its GHL
    // label, and lib/callsReport.ts groups the per-dialer breakdown on
    // `dialer_number_name`, defaulting to 'Unknown'. Leaving this null silently
    // dumps every automated call into "Unknown" and breaks questions like "how
    // many calls has Brianne made in each account". The name is therefore
    // resolved from the number, using the mapping the CSV rows already establish
    // (resolves 131/131 of the first live batch).
    dialer_number_name: dialerNameFor?.(dialer_number_phone, dialerNameHint) ?? null,
    dialer_number_phone,
    first_time: null,           // CSV-only column; not derivable from a message row
    account_label: accountLabel,
    source_file: CALL_SOURCE_FILE,
  }
}

/**
 * Page the export endpoint for one location over [since, until).
 *
 * Cursor-paged: each response returns `nextCursor` to pass back. `maxPages` is a
 * runaway guard — when it trips we say so rather than silently returning a
 * partial window (a silent cap reads as "no calls happened").
 */
export async function fetchCallMessages(
  acct: GHLAccount,
  opts: { since: string; until?: string; maxPages?: number },
): Promise<{ messages: ApiCallMessage[]; pages: number; truncated: boolean; total: number | null }> {
  const maxPages = opts.maxPages ?? 40
  const messages: ApiCallMessage[] = []
  let cursor: string | undefined
  let pages = 0
  let total: number | null = null

  for (; pages < maxPages; pages++) {
    const u = new URL(`${GHL_BASE}/conversations/messages/export`)
    u.searchParams.set('locationId', acct.locationId)
    u.searchParams.set('limit', '100')
    // ⚠️ sortBy only accepts createdAt | updatedAt — 'dateAdded' 422s.
    u.searchParams.set('sortBy', 'createdAt')
    u.searchParams.set('sortOrder', 'desc')
    u.searchParams.set('channel', 'Call')
    u.searchParams.set('startDate', opts.since)
    if (opts.until) u.searchParams.set('endDate', opts.until)
    if (cursor) u.searchParams.set('cursor', cursor)

    const res = await fetch(u, {
      headers: { Authorization: `Bearer ${acct.apiKey}`, Version: CONV_VERSION, Accept: 'application/json' },
    })
    if (!res.ok) {
      throw new Error(`messages/export ${acct.label} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    const json = await res.json() as { messages?: ApiCallMessage[]; nextCursor?: string | null; total?: number }
    if (total === null && typeof json.total === 'number') total = json.total
    const batch = json.messages ?? []
    messages.push(...batch)
    if (!json.nextCursor || batch.length === 0) {
      return { messages, pages: pages + 1, truncated: false, total }
    }
    cursor = json.nextCursor
  }
  return { messages, pages, truncated: true, total }
}

/**
 * The GHL-configured name of every dialing number in one sub-account, keyed by
 * normalized phone.
 *
 * ⚠️ THIS IS WHY IT EXISTS. `dialer_number_name` used to be learned only from
 * rows we already held (buildDialerNameMap), and the export payload carries the
 * dialing NUMBER without its title — so once ingest went API-only there was no
 * path for a new number's name to ever enter the system. Brianne rotated her
 * line in both sub-accounts on 2026-08-21 and 334 of her calls silently filed
 * themselves under 'Unknown' on the page whose entire job is her dial volume.
 * Asking GHL is the only self-healing answer: a number is named where it is
 * provisioned.
 *
 * Returns an EMPTY map on any failure rather than throwing — a naming lookup must
 * never be able to fail a sweep. The learned map still covers everything it did
 * before, including RETIRED numbers: verified 2026-08-25 that Brianne's two old
 * lines are already absent from GHL's list while 5,515 of her calls still hang
 * off them, so this is a supplement to that map and never a replacement.
 */
export async function fetchNumberLabels(acct: GHLAccount): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  try {
    const u = new URL(`${GHL_BASE}/phone-system/numbers`)
    u.searchParams.set('locationId', acct.locationId)
    const res = await fetch(u, { headers: ghlHeaders(acct.apiKey) })
    if (!res.ok) return out
    const json = await res.json() as { phoneNumbers?: { value?: string; title?: string }[] }
    for (const n of json.phoneNumbers ?? []) {
      const phone = normPhone(n.value ?? '')
      const title = (n.title ?? '').trim()
      if (phone && title) out.set(phone, title)
    }
  } catch {
    return new Map()
  }
  return out
}
