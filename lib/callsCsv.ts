// ── GHL Call Report CSV importer — shared helpers ────────────────────────────
//
// Parses GHL's Reporting → Call report export into `calls` rows.
//
// Why CSV and not an API sync: GHL exposes no location-level call endpoint
// (/calls, /reporting/calls, /phone-system/calls, /voice-ai/call-logs all 404,
// verified 2026-08-10). Per-conversation TYPE_CALL messages exist but carry no
// Disposition — the LO's hand-tagged outcome — so the CSV is strictly richer.
//
// Tolerant by design: headers are matched BY NAME (GHL reorders/adds columns
// between releases), unknown columns are ignored, and a row without a usable
// phone number is skipped rather than failing the import.

import { parseCsv } from './ariveCsv'
import { normPhone } from './dealMatcher'

export type AccountLabel = 'moe' | 'matt'

export type CallRow = {
  call_ts: string              // UTC ISO
  contact_phone: string        // last 10 digits
  contact_name: string | null
  direction: string | null
  call_status: string | null
  disposition: string | null
  duration_sec: number
  dialer_number_name: string | null
  dialer_number_phone: string | null
  first_time: boolean | null
  account_label: AccountLabel
  source_file: string | null
}

// ── Timezone ────────────────────────────────────────────────────────────────
// The export emits the sub-account's LOCAL wall-clock time with no offset
// ("2026-08-10 15:29:07"). Irvine → America/Los_Angeles.
//
// DO NOT hardcode -7. That is correct for PDT and wrong for PST, so a January
// export would land every call an hour off. The offset is derived from the
// instant itself via Intl, which is DST-correct year-round.
const PT_ZONE = 'America/Los_Angeles'

const PT_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: PT_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
})

/** Offset (ms) that America/Los_Angeles is BEHIND UTC at a given instant.
 *  PDT → 7h, PST → 8h. Derived by formatting the instant in the zone and
 *  diffing against the same wall-clock read as UTC. */
function ptOffsetMsAt(instantMs: number): number {
  const parts = PT_FMT.formatToParts(new Date(instantMs))
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value)
  // Intl renders midnight as hour 24 in some ICU versions; normalize to 0.
  const hour = get('hour') % 24
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'))
  return instantMs - asUtc
}

/**
 * Convert a "YYYY-MM-DD HH:mm:ss" PT wall-clock string to a UTC ISO string.
 *
 * Two-pass: guess the instant by reading the wall clock as UTC, measure the
 * zone offset AT that guess, correct, then re-measure once. The second pass is
 * what makes DST-boundary timestamps land correctly — the offset that applies
 * depends on the instant, which depends on the offset.
 *
 * Ambiguous times (the repeated hour on fall-back day) resolve to the FIRST
 * occurrence, i.e. still-daylight-time. Nonexistent times (the skipped hour on
 * spring-forward day) roll forward. Neither can be resolved from the CSV alone;
 * both affect at most one hour per year.
 */
export function ptToUtc(local: string): string {
  const m = local.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (!m) throw new Error(`unparseable call timestamp: ${local}`)
  const [, Y, Mo, D, H, Mi, S] = m
  const wallAsUtc = Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +(S ?? 0))

  let instant = wallAsUtc + ptOffsetMsAt(wallAsUtc)
  instant = wallAsUtc + ptOffsetMsAt(instant)
  return new Date(instant).toISOString()
}

/**
 * Split a stored UTC instant back into PT calendar parts.
 *
 * Every "when did we call" question — which day, which hour, which weekday — has to
 * be asked in the office's own timezone. Bucketing the stored UTC hour instead puts
 * a 3pm call in the 10pm bucket and makes "best time to call" 7-8h wrong.
 *
 * weekday: 0 = Sunday … 6 = Saturday.
 */
export function ptParts(utcIso: string): { day: string; hour: number; weekday: number } {
  const parts = PT_FMT.formatToParts(new Date(utcIso))
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00'
  const day = `${get('year')}-${get('month')}-${get('day')}`
  const hour = Number(get('hour')) % 24
  // Weekday from the PT calendar date, read at noon UTC-of-that-date so no
  // offset can tip it into the neighbouring day.
  const [Y, M, D] = day.split('-').map(Number)
  const weekday = new Date(Date.UTC(Y, M - 1, D, 12)).getUTCDay()
  return { day, hour, weekday }
}

// ── Duration ────────────────────────────────────────────────────────────────
/** "00:49" → 49, "01:02:03" → 3723, "-" / "" → 0. */
export function parseDuration(s: string | null | undefined): number {
  const t = (s ?? '').trim()
  if (!t || t === '-') return 0
  const parts = t.split(':').map(n => Number(n))
  if (parts.some(n => !Number.isFinite(n))) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 1) return parts[0]
  return 0
}

// ── Parse ───────────────────────────────────────────────────────────────────
const blank = (v: string | undefined): string | null => {
  const t = (v ?? '').trim()
  return !t || t === '-' ? null : t
}

/** Idempotency key — must mirror the calls_dedupe_uniq index exactly. */
export function dedupeKey(r: Pick<CallRow, 'call_ts' | 'contact_phone' | 'dialer_number_phone'>): string {
  return `${r.call_ts}|${r.contact_phone}|${r.dialer_number_phone ?? ''}`
}

/**
 * Parse a call-report export into `calls` rows.
 *
 * `accountLabel` is supplied by the user at upload and CANNOT be derived from the
 * file: "Brianne's Number" places calls in BOTH the Moe and Matt exports, so the
 * dialing number identifies neither the sub-account nor the lead owner.
 */
export function parseCallsCsv(text: string, accountLabel: AccountLabel, sourceFile: string | null = null): CallRow[] {
  const { header, rows } = parseCsv(text)
  if (header.length === 0) return []

  // Match headers by name, case/whitespace-insensitive.
  const idx = new Map<string, number>()
  header.forEach((h, i) => idx.set(h.trim().toLowerCase(), i))
  const col = (name: string): number => idx.get(name.toLowerCase()) ?? -1

  const iTs    = col('Date & time')
  const iName  = col('Contact name')
  const iPhone = col('Contact phone')
  const iDir   = col('Direction')
  const iStat  = col('Call status')
  const iDisp  = col('Disposition')
  const iDur   = col('Duration')
  const iNumN  = col('Number name')
  const iNumP  = col('Number phone')
  const iFirst = col('First time')

  if (iTs < 0 || iPhone < 0) {
    throw new Error('not a GHL call report export (missing "Date & time" or "Contact phone")')
  }

  const at = (r: string[], i: number): string | undefined => (i >= 0 ? r[i] : undefined)
  const out: CallRow[] = []

  for (const r of rows) {
    const phone = normPhone(at(r, iPhone))
    const rawTs = (at(r, iTs) ?? '').trim()
    // A row with no usable phone can never be joined to a deal, and a row with no
    // timestamp can't be deduped. Skip rather than fail the whole import.
    if (!phone || !rawTs) continue

    let call_ts: string
    try {
      call_ts = ptToUtc(rawTs)
    } catch {
      continue
    }

    const firstRaw = blank(at(r, iFirst))
    out.push({
      call_ts,
      contact_phone: phone,
      contact_name: blank(at(r, iName)),
      direction: blank(at(r, iDir))?.toLowerCase() ?? null,
      call_status: blank(at(r, iStat)),
      disposition: blank(at(r, iDisp)),
      duration_sec: parseDuration(at(r, iDur)),
      dialer_number_name: blank(at(r, iNumN)),
      dialer_number_phone: normPhone(at(r, iNumP)),
      first_time: firstRaw == null ? null : firstRaw.toLowerCase() === 'yes',
      account_label: accountLabel,
      source_file: sourceFile,
    })
  }

  return out
}

/** Collapse rows sharing a dedupe key, keeping the first. Mirrors what the unique
 *  index does server-side so preview counts match what actually lands. */
export function dedupeRows(rows: CallRow[]): { rows: CallRow[]; collapsed: number } {
  const seen = new Map<string, CallRow>()
  let collapsed = 0
  for (const r of rows) {
    const k = dedupeKey(r)
    if (seen.has(k)) { collapsed++; continue }
    seen.set(k, r)
  }
  return { rows: [...seen.values()], collapsed }
}
