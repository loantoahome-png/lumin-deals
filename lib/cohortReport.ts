// Lead Cohort Responsiveness — pure aggregation logic (no I/O).
//
// Powers /lead-cohorts. Compares two lead cohorts (defined by CREATED DATE =
// date_added_ghl) and asks: "are the leads we got this week less responsive than
// a prior week?" — normalized by lead maturity so the comparison is fair.
//
// Timing ("did a lead respond within N days of its own created date") comes from
// the forward-only stage_events log (see supabase-stage-events.sql), passed in as
// a firstResponded map. The log only has events from the day it went live, so a
// lead that crossed into a responded stage BEFORE that has NO timestamp. We keep
// three states distinct and NEVER count a missing event as a non-response:
//
//   1. Responded WITH a logged crossing  → has firstResponded ts → used in windows
//   2. Responded but NO logged crossing  → counts in as-of-today totals, but is
//      EXCLUDED from window numerator/denominator (timing "unknown")
//   3. Not responded                     → non-responder
//
// "Responded" reuses isRespondedStatus from leadReport (single source of truth:
// Ghosted counts; New Lead / Attempted Contact / Non-Responsive and the opt-outs
// don't). Kept as pure functions so scripts/cohort-report-check.ts can fixture it.

import { isRespondedStatus, isOptoutStatus, type LO } from './leadReport'
import type { Deal } from './types'

export const WINDOWS = [7, 14] as const

// Only the fields the report needs — keeps the page's select() slim.
export type CohortLead = Pick<Deal,
  'id' | 'ghl_opportunity_id' | 'loan_officer' | 'pipeline_group' |
  'status' | 'source' | 'state' | 'loan_purpose' | 'date_added_ghl' | 'lead_price' | 'dnd' | 'dnd_settings'>

/** ghl_opportunity_id → ISO timestamp of the EARLIEST logged crossing into a
 *  responded stage. Built by /api/stage-events/first-responded. */
export type FirstRespondedMap = Map<string, string>

export type CohortInput = { label: string; start: string; end: string } // start/end = 'YYYY-MM-DD'

// ── Conversion ────────────────────────────────────────────────────────────────
// "Conversion" = the lead became a real application/loan: it reached "Arive Lead"
// (entered the LOS) or any later stage, i.e. it's in Loans in Process / Funded, or
// sits at one of the application-funnel Leads stages. Change this set to move the
// conversion bar (it's the one [CONFIRM: key stage] item that had no obvious answer).
export const CONVERSION_LEAD_STATUSES = new Set(['Arive Lead', 'App Intake', 'Qualification', 'Pre-Approved'])
export const CONVERTED_GROUPS = new Set(['Loans in Process', 'Funded'])
export const isConverted = (d: CohortLead): boolean =>
  CONVERTED_GROUPS.has(d.pipeline_group ?? '') || CONVERSION_LEAD_STATUSES.has(d.status ?? '')

// ── Small helpers ───────────────────────────────────────────────────────────────
const DAY_MS = 86_400_000
const pct = (num: number, den: number): number => (den > 0 ? (100 * num) / den : 0)

/** Days between `created` and `now` (age of the lead). null if unparseable. */
function ageDays(now: Date, created: string | null): number | null {
  if (!created) return null
  const t = Date.parse(created)
  return isNaN(t) ? null : (now.getTime() - t) / DAY_MS
}
/** Days from a lead's created date to its first responded crossing. null if either missing. */
function respDeltaDays(created: string | null, firstTs: string | null): number | null {
  if (!created || !firstTs) return null
  const c = Date.parse(created), f = Date.parse(firstTs)
  if (isNaN(c) || isNaN(f)) return null
  return (f - c) / DAY_MS
}
function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
}

// ── Filtering ────────────────────────────────────────────────────────────────
/** Aggregator (purchased) leads ALWAYS carry a lead price. This report tracks ONLY
 *  priced leads — organic/warm leads with no lead price are excluded entirely.
 *  (Filtering on lead_price rather than source also dodges the source-drift bug where
 *  a purchased lead's source gets overwritten to "Arive"/null once it enters the LOS.) */
export const isPriced = (d: CohortLead): boolean => (d.lead_price ?? 0) > 0

/** DND on ANY channel — treats a lead as opted-out if it's in a pipeline opt-out stage
 *  (STOP / DND-SMS / Remove from All Automations), has GHL's master `dnd` flag, OR has
 *  any per-channel `dnd_settings` marked active (Email, Call, SMS, FB, WhatsApp, …).
 *  EXCLUDES SMS entries that are Twilio CARRIER errors ("TWILIO_ERROR_CODE: …") — those
 *  are undeliverable/landline numbers, not a lead's opt-out choice. */
export const isDnd = (d: CohortLead): boolean =>
  isOptoutStatus(d.status) || d.dnd === true || hasChannelDnd(d.dnd_settings)

function hasChannelDnd(settings: Record<string, unknown> | null | undefined): boolean {
  if (!settings || typeof settings !== 'object') return false
  for (const [channel, v] of Object.entries(settings)) {
    if (v === true) return true
    if (!v || typeof v !== 'object') continue
    const rec = v as { status?: unknown; message?: unknown }
    const status = String(rec.status ?? '').toLowerCase()
    if (status !== 'active' && status !== 'permanent') continue
    // Skip SMS carrier/delivery errors (undeliverable numbers) — not opt-outs.
    const carrierError = channel.toUpperCase() === 'SMS' && /TWILIO/i.test(String(rec.message ?? ''))
    if (!carrierError) return true
  }
  return false
}

/** LO filter (cohort-local — CohortLead lacks the money fields leadReport.matchesLO needs). */
export function matchesLO(d: CohortLead, lo: LO): boolean {
  if (lo === 'All') return true
  const l = (d.loan_officer ?? '').toLowerCase()
  return lo === 'Matt' ? l.includes('matt') : l.includes('moe')
}

/** Keep leads whose created date (date_added_ghl) falls in [start, end], inclusive.
 *  Compares the UTC date portion; ISO date strings sort chronologically, so a plain
 *  lexicographic compare is correct and timezone-deterministic at day granularity. */
export function filterCohort(rows: CohortLead[], start: string, end: string): CohortLead[] {
  return rows.filter(r => {
    const c = r.date_added_ghl
    if (!c) return false // no created date → can't belong to a date cohort
    const day = c.slice(0, 10)
    return day >= start && day <= end
  })
}

// ── Category keys for breakdowns ────────────────────────────────────────────────
export const sourceKey  = (d: CohortLead): string => (d.source ?? '').trim() || '(no source)'
export const stateKey   = (d: CohortLead): string => { const t = (d.state ?? '').trim(); return t ? t.toUpperCase().slice(0, 2) : '(no state)' }
export const purposeKey = (d: CohortLead): string => (d.loan_purpose ?? '').trim() || '(untagged)'

// ── Per-window stat ─────────────────────────────────────────────────────────────
export type WindowStat = {
  days: number
  responded: number    // cohort leads whose FIRST response landed within `days` of their created date
  total: number        // cohort size — the SAME denominator for every window, so 7-day and 14-day
                       // measure the SAME leads. The curve is cumulative: 14-day ⊇ 7-day, always ≥.
  rate: number | null  // responded / total; null only when the cohort is empty
  maturedShare: number // % of the cohort that has actually reached `days` of age — how settled this
                       // number is (below ~100% it's a climbing floor: young leads can still respond)
}

export type CohortSegment = {
  total: number
  // As-of-today (non-normalized; uses current stage, no timestamp needed)
  respondedNow: number
  respondedNowPct: number
  // Three states (as-of-today view; state #3 folds in the rare "crossed then left")
  respondedTimed: number    // state 1: responded now AND has a logged crossing
  respondedUntimed: number  // state 2: responded now, NO logged crossing (pre-log)
  notResponded: number      // state 3: not currently responded
  timingCoverage: number | null  // respondedTimed / respondedNow (percent); null if no responders
  // Time to first response — responders WITH a logged timestamp only (hours)
  ttrMedianH: number | null
  ttrAvgH: number | null
  // Conversion (reached the key stage)
  converted: number
  convertedPct: number
  // Opted out / DND on any channel — see isDnd (opt-out stages + master dnd flag +
  // per-channel dnd_settings; excludes SMS carrier errors). Status is the reliable
  // floor; the dnd flag/settings add email/call/etc. opt-outs where GHL has them.
  optedOut: number
  optedOutPct: number
  // Maturation windows (one per WINDOWS entry)
  windows: WindowStat[]
  // Current pipeline stage distribution
  stageDist: { status: string; n: number }[]
}

export function cohortSegment(
  rows: CohortLead[],
  firstResp: FirstRespondedMap,
  now: Date,
  windowDays: readonly number[] = WINDOWS,
): CohortSegment {
  const total = rows.length
  let respondedNow = 0, respondedTimed = 0, respondedUntimed = 0, converted = 0, optedOut = 0
  const ttr: number[] = []                       // hours, responders with a ts
  const stageCount = new Map<string, number>()
  const winResponded = windowDays.map(() => 0)
  const winMatured = windowDays.map(() => 0)

  for (const r of rows) {
    const status = r.status ?? ''
    const respNow = isRespondedStatus(status)
    const oppId = r.ghl_opportunity_id
    const firstTs = oppId ? firstResp.get(oppId) ?? null : null
    const hasTs = !!firstTs

    // As-of-today + state classification
    if (respNow) {
      respondedNow++
      if (hasTs) respondedTimed++
      else respondedUntimed++
    }
    if (isConverted(r)) converted++
    if (isDnd(r)) optedOut++

    // Stage distribution
    stageCount.set(status || '(no stage)', (stageCount.get(status || '(no stage)') ?? 0) + 1)

    // Time-to-first-response (any lead with a logged crossing responded at firstTs)
    if (hasTs) {
      const d = respDeltaDays(r.date_added_ghl, firstTs)
      if (d != null) ttr.push(Math.max(0, d) * 24)
    }

    // Windows — SAME denominator (the whole cohort) for every N, so 7-day and 14-day
    // measure the SAME leads. The response curve is cumulative: a lead counted within
    // 7 days is also within 14. Maturity (age ≥ N) is tracked separately as an
    // informational "how settled is this" share, NOT a filter on the denominator.
    const age = ageDays(now, r.date_added_ghl)
    const respDelta = hasTs ? respDeltaDays(r.date_added_ghl, firstTs) : null
    for (let j = 0; j < windowDays.length; j++) {
      const N = windowDays[j]
      if (age != null && age >= N) winMatured[j]++
      if (respDelta != null && respDelta <= N) winResponded[j]++
    }
  }

  const windows: WindowStat[] = windowDays.map((N, j) => ({
    days: N,
    responded: winResponded[j],
    total,
    rate: total > 0 ? pct(winResponded[j], total) : null,
    maturedShare: pct(winMatured[j], total),
  }))

  return {
    total,
    respondedNow,
    respondedNowPct: pct(respondedNow, total),
    respondedTimed,
    respondedUntimed,
    notResponded: total - respondedNow,
    timingCoverage: respondedNow > 0 ? pct(respondedTimed, respondedNow) : null,
    ttrMedianH: median(ttr),
    ttrAvgH: mean(ttr),
    converted,
    convertedPct: pct(converted, total),
    optedOut,
    optedOutPct: pct(optedOut, total),
    windows,
    stageDist: [...stageCount.entries()].map(([status, n]) => ({ status, n })).sort((a, b) => b.n - a.n),
  }
}

// ── Breakdowns ──────────────────────────────────────────────────────────────
export type BreakdownRow = { key: string; seg: CohortSegment }
export function cohortBreakdown(
  rows: CohortLead[],
  firstResp: FirstRespondedMap,
  now: Date,
  keyFn: (d: CohortLead) => string,
  windowDays: readonly number[] = WINDOWS,
): BreakdownRow[] {
  const groups = new Map<string, CohortLead[]>()
  for (const r of rows) {
    const k = keyFn(r)
    const arr = groups.get(k)
    if (arr) arr.push(r)
    else groups.set(k, [r])
  }
  return [...groups.entries()]
    .map(([key, rs]) => ({ key, seg: cohortSegment(rs, firstResp, now, windowDays) }))
    .sort((a, b) => b.seg.total - a.seg.total)
}

// ── Cohort assembly ─────────────────────────────────────────────────────────
export type CohortResult = {
  input: CohortInput
  seg: CohortSegment
  bySource: BreakdownRow[]
  byState: BreakdownRow[]
  byPurpose: BreakdownRow[]
}
export function analyzeCohort(
  all: CohortLead[],
  firstResp: FirstRespondedMap,
  now: Date,
  input: CohortInput,
  lo: LO,
  windowDays: readonly number[] = WINDOWS,
): CohortResult {
  // Priced-only: this is an aggregator-lead report. Exclude anything with no lead price.
  const rows = filterCohort(all, input.start, input.end).filter(r => isPriced(r) && matchesLO(r, lo))
  return {
    input,
    seg: cohortSegment(rows, firstResp, now, windowDays),
    bySource: cohortBreakdown(rows, firstResp, now, sourceKey, windowDays),
    byState: cohortBreakdown(rows, firstResp, now, stateKey, windowDays),
    byPurpose: cohortBreakdown(rows, firstResp, now, purposeKey, windowDays),
  }
}

// ── Deltas (B relative to A) ──────────────────────────────────────────────────
// Test framing: A = prior week, B = this week. Positive respondedNow/window delta
// = B more responsive (good); negative ttr delta = B faster (good). The UI decides
// arrow color from each metric's "higher is better" sense.
export type CohortDelta = {
  total: number
  respondedNowPct: number
  convertedPct: number
  optedOutPct: number
  timingCoverage: number | null
  ttrMedianH: number | null
  windows: { days: number; rate: number | null }[] // null when either cohort can't compare
}
export function cohortDelta(a: CohortSegment, b: CohortSegment): CohortDelta {
  return {
    total: b.total - a.total,
    respondedNowPct: b.respondedNowPct - a.respondedNowPct,
    convertedPct: b.convertedPct - a.convertedPct,
    optedOutPct: b.optedOutPct - a.optedOutPct,
    timingCoverage: a.timingCoverage == null || b.timingCoverage == null ? null : b.timingCoverage - a.timingCoverage,
    ttrMedianH: a.ttrMedianH == null || b.ttrMedianH == null ? null : b.ttrMedianH - a.ttrMedianH,
    windows: a.windows.map((wa, i) => {
      const wb = b.windows[i]
      return { days: wa.days, rate: wa.rate == null || wb?.rate == null ? null : wb.rate - wa.rate }
    }),
  }
}
