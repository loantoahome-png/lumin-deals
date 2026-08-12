// ── Call-report rollups — Effort + Economics ────────────────────────────────
//
// Pure functions over imported `calls` rows and `deals`. Nothing here is stored;
// every metric is recomputed at read time so a changed definition corrects the
// full history instead of leaving a stale rollup behind.
//
// Scope (fixed by the spec, deliberately narrow):
//   * purchased leads only  — lead_price > 0
//   * Moe + Matt only       — DEFAULT_LOS; Randy is excluded by decision
//   * leads whose lead-in date falls INSIDE the imported call window (see below)

import { DEFAULT_LOS, resolveLO } from './loanOfficer'
import { normPhone } from './dealMatcher'
import { ptParts, type CallRow } from './callsCsv'

export const ACCOUNT_TO_LO: Record<string, string> = {
  moe: 'Moe Sefati',
  matt: 'Matt Park',
}

/**
 * THE connect rule. A call counts as a real conversation only if it has talk time.
 *
 * NEVER use call_status === 'Answered'. In the live export 724 rows are
 * simultaneously call_status 'Answered' AND disposition 'No Answer / Voicemail':
 * "Answered" means the carrier connected the leg, not that a human picked up.
 * Trusting it inflates the connect rate by roughly 20 points.
 */
export const isConnected = (c: Pick<CallRow, 'duration_sec'>): boolean => c.duration_sec > 0

export type DealLite = {
  id: string
  name: string | null
  phone: string | null
  loan_officer: string | null
  source: string | null
  lead_price: number | null
  funded_date: string | null
  date_added_ghl: string | null
}

export type LeadRef = { id: string; name: string | null; leadPrice: number; lo: string }

export type EffortRow = {
  lo: string
  covered: boolean          // false → render "no data", NEVER 0%
  leads: number
  spend: number
  dialed: number
  connected: number
  dials: number
  talkSec: number
  medianTtfdHours: number | null
  neverDialed: LeadRef[]
  neverDialedSpend: number
  dialedNeverConnected: LeadRef[]
  dialedNeverConnectedSpend: number
}

export type DialerRow = { lo: string; dialer: string; calls: number; talkSec: number }

export type EconomicsRow = {
  source: string
  leads: number
  spend: number
  connectedLeads: number
  dials: number
  dialsPerLead: number
  costPerConnect: number | null
  funded: number
}

// ── Coverage ────────────────────────────────────────────────────────────────

/** Which LOs actually have imported call data. An LO missing from this set has
 *  NO evidence either way — its metrics must render "no data", never 0%. That
 *  distinction is the whole reason account_label is stored. */
export function coveredLos(calls: Pick<CallRow, 'account_label'>[]): Set<string> {
  const out = new Set<string>()
  for (const c of calls) {
    const lo = ACCOUNT_TO_LO[c.account_label]
    if (lo) out.add(lo)
  }
  return out
}

/**
 * The date range the imported calls actually cover.
 *
 * Leads are filtered to this window before any percentage is computed. Without
 * it, a lead that came in months before the earliest export reads as
 * "never dialed" purely because we hold no calls for that period — the same
 * false-zero artifact that made an LO with no export look like 0% dialed.
 */
export function coverageWindow(calls: Pick<CallRow, 'call_ts'>[]): { start: string; end: string } | null {
  if (calls.length === 0) return null
  let min = calls[0].call_ts, max = calls[0].call_ts
  for (const c of calls) {
    if (c.call_ts < min) min = c.call_ts
    if (c.call_ts > max) max = c.call_ts
  }
  return { start: min, end: max }
}

// ── Per-contact call index ──────────────────────────────────────────────────

export type ContactCalls = {
  calls: number
  connected: number
  talkSec: number
  firstMs: number
  byDialer: Map<string, { calls: number; talkSec: number }>
}

export function buildCallIndex(calls: CallRow[]): Map<string, ContactCalls> {
  const ix = new Map<string, ContactCalls>()
  for (const c of calls) {
    let e = ix.get(c.contact_phone)
    if (!e) {
      e = { calls: 0, connected: 0, talkSec: 0, firstMs: Infinity, byDialer: new Map() }
      ix.set(c.contact_phone, e)
    }
    e.calls++
    e.talkSec += c.duration_sec
    if (isConnected(c)) e.connected++
    const ms = Date.parse(c.call_ts)
    if (Number.isFinite(ms) && ms < e.firstMs) e.firstMs = ms

    const d = c.dialer_number_name ?? 'Unknown'
    const de = e.byDialer.get(d) ?? { calls: 0, talkSec: 0 }
    de.calls++; de.talkSec += c.duration_sec
    e.byDialer.set(d, de)
  }
  return ix
}

// ── Deal scoping ────────────────────────────────────────────────────────────

/** Purchased + in-scope LO + inside the imported call window. */
export function scopedDeals(deals: DealLite[], window: { start: string; end: string } | null): DealLite[] {
  const startDay = window?.start.slice(0, 10)
  const endDay = window?.end.slice(0, 10)
  return deals.filter(d => {
    if (!(Number(d.lead_price) > 0)) return false
    const lo = resolveLO(d.loan_officer)
    if (!lo || !DEFAULT_LOS.includes(lo)) return false
    if (!startDay || !endDay) return false
    const day = d.date_added_ghl?.slice(0, 10)
    return !!day && day >= startDay && day <= endDay
  })
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

// ── Effort ──────────────────────────────────────────────────────────────────

export function effortRollup(calls: CallRow[], deals: DealLite[]): EffortRow[] {
  const ix = buildCallIndex(calls)
  const covered = coveredLos(calls)
  const win = coverageWindow(calls)
  const scoped = scopedDeals(deals, win)

  const acc = new Map<string, {
    leads: number; spend: number; dialed: number; connected: number; dials: number
    talkSec: number; ttfd: number[]; never: LeadRef[]; noConn: LeadRef[]
  }>()
  for (const lo of DEFAULT_LOS) {
    acc.set(lo, { leads: 0, spend: 0, dialed: 0, connected: 0, dials: 0, talkSec: 0, ttfd: [], never: [], noConn: [] })
  }

  for (const d of scoped) {
    const lo = resolveLO(d.loan_officer)
    if (!lo) continue
    const e = acc.get(lo)
    if (!e) continue

    const price = Number(d.lead_price) || 0
    const ref: LeadRef = { id: d.id, name: d.name, leadPrice: price, lo }
    e.leads++; e.spend += price

    const c = ix.get(normPhone(d.phone) ?? '')
    if (!c) { e.never.push(ref); continue }

    e.dialed++; e.dials += c.calls; e.talkSec += c.talkSec
    if (c.connected > 0) e.connected++
    else e.noConn.push(ref)

    const leadInMs = d.date_added_ghl ? Date.parse(d.date_added_ghl) : NaN
    if (Number.isFinite(leadInMs) && Number.isFinite(c.firstMs)) {
      e.ttfd.push((c.firstMs - leadInMs) / 3_600_000)
    }
  }

  return DEFAULT_LOS.map(lo => {
    const e = acc.get(lo)!
    return {
      lo,
      covered: covered.has(lo),
      leads: e.leads,
      spend: e.spend,
      dialed: e.dialed,
      connected: e.connected,
      dials: e.dials,
      talkSec: e.talkSec,
      medianTtfdHours: median(e.ttfd),
      neverDialed: e.never.sort((a, b) => b.leadPrice - a.leadPrice),
      neverDialedSpend: e.never.reduce((s, r) => s + r.leadPrice, 0),
      dialedNeverConnected: e.noConn.sort((a, b) => b.leadPrice - a.leadPrice),
      dialedNeverConnectedSpend: e.noConn.reduce((s, r) => s + r.leadPrice, 0),
    }
  })
}

/** Who actually placed the calls, per LO's book of leads. Answers "is the ISA
 *  doing the dialing or the LO?" — which the lead-owner rollup alone can't. */
export function dialerBreakdown(calls: CallRow[], deals: DealLite[]): DialerRow[] {
  const ix = buildCallIndex(calls)
  const scoped = scopedDeals(deals, coverageWindow(calls))
  const acc = new Map<string, DialerRow>()

  for (const d of scoped) {
    const lo = resolveLO(d.loan_officer)
    if (!lo) continue
    const c = ix.get(normPhone(d.phone) ?? '')
    if (!c) continue
    for (const [dialer, v] of c.byDialer) {
      const k = `${lo}|${dialer}`
      const row = acc.get(k) ?? { lo, dialer, calls: 0, talkSec: 0 }
      row.calls += v.calls; row.talkSec += v.talkSec
      acc.set(k, row)
    }
  }
  return [...acc.values()].sort((a, b) => (a.lo === b.lo ? b.calls - a.calls : a.lo.localeCompare(b.lo)))
}

// ── Activity buckets ────────────────────────────────────────────────────────
//
// Pre-aggregated per PT CALENDAR DAY so the page can sum any date range — today,
// this week, a custom span — instantly on the client without a refetch.
//
// ⚠️ Everything here is bucketed in America/Los_Angeles, never in stored UTC.
// A 3pm call is stored as 22:00Z; bucketing the raw UTC hour would file it under
// 10pm and shift "best time to call" by the whole offset.
//
// ⚠️ Deliberately NO distinct-contact counts. A distinct count cannot be summed
// across daily buckets (the same lead called Monday and Tuesday would count
// twice), and a silently-wrong "leads touched" is worse than no metric.

export type DayBucket = {
  day: string          // PT calendar date, YYYY-MM-DD
  weekday: number      // 0 = Sunday
  calls: number
  connects: number
  talkSec: number
  outbound: number
  inbound: number
  /** Who dialed. Buckets are keyed per day PER DIALER so the whole Activity tab
   *  can be filtered to one person client-side, with no refetch — the property
   *  that makes every date preset recompute instantly. Unfiltered views sum
   *  across dialers, so a day now has one row per active dialer, not one row. */
  dialer: string
}

export type HourBucket = { day: string; hour: number; dialer: string; calls: number; connects: number }
export type DialerDayBucket = { day: string; dialer: string; account: string; calls: number; connects: number; talkSec: number }

export type ActivityBuckets = {
  daily: DayBucket[]
  hourly: HourBucket[]            // OUTBOUND only — see below
  dialerDaily: DialerDayBucket[]
}

export function activityBuckets(calls: CallRow[]): ActivityBuckets {
  const daily = new Map<string, DayBucket>()
  const hourly = new Map<string, HourBucket>()
  const dialerDaily = new Map<string, DialerDayBucket>()

  for (const c of calls) {
    const { day, hour, weekday } = ptParts(c.call_ts)
    const connected = isConnected(c) ? 1 : 0
    const dialer = c.dialer_number_name ?? 'Unknown'

    const dayKey = `${day}|${dialer}`
    const d = daily.get(dayKey) ?? { day, weekday, dialer, calls: 0, connects: 0, talkSec: 0, outbound: 0, inbound: 0 }
    d.calls++; d.connects += connected; d.talkSec += c.duration_sec
    if (c.direction === 'inbound') d.inbound++; else d.outbound++
    daily.set(dayKey, d)

    // "Best time to call" is a question about OUTBOUND dialing. Inbound calls
    // connect by definition and would wash out the signal entirely.
    if (c.direction !== 'inbound') {
      const hk = `${day}|${hour}|${dialer}`
      const h = hourly.get(hk) ?? { day, hour, dialer, calls: 0, connects: 0 }
      h.calls++; h.connects += connected
      hourly.set(hk, h)
    }

    // Carries the ACCOUNT too: the same person dials from a different number in
    // each sub-account (Brianne …5677 in Moe's, …8630 in Matt's, both labelled
    // "Brianne's Number"), so the label alone merges them. Keeping the account
    // lets a filtered view show her per-account split — the question this page
    // exists to answer.
    const dk = `${day}|${dialer}|${c.account_label}`
    const dd = dialerDaily.get(dk) ?? { day, dialer, account: c.account_label, calls: 0, connects: 0, talkSec: 0 }
    dd.calls++; dd.connects += connected; dd.talkSec += c.duration_sec
    dialerDaily.set(dk, dd)
  }

  return {
    daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)),
    hourly: [...hourly.values()].sort((a, b) => a.day.localeCompare(b.day) || a.hour - b.hour),
    dialerDaily: [...dialerDaily.values()].sort((a, b) => a.day.localeCompare(b.day)),
  }
}

/** Summed activity over a PT day range (inclusive both ends), optionally for one
 *  dialer. `dialer` undefined/null = everyone. */
export function activityInRange(daily: DayBucket[], start: string, end: string, dialer?: string | null) {
  let calls = 0, connects = 0, talkSec = 0, outbound = 0, inbound = 0
  // ⚠️ Buckets are per day PER DIALER, so counting rows would count a day once
  // per active dialer and silently deflate "calls / active day" by ~4x. Count
  // DISTINCT days.
  const activeDays = new Set<string>()
  for (const d of daily) {
    if (d.day < start || d.day > end) continue
    if (dialer && d.dialer !== dialer) continue
    activeDays.add(d.day)
    calls += d.calls; connects += d.connects; talkSec += d.talkSec
    outbound += d.outbound; inbound += d.inbound
  }
  const days = activeDays.size
  return {
    calls, connects, talkSec, outbound, inbound, activeDays: days,
    connectRate: calls ? connects / calls : 0,
    // Average length of a call that actually CONNECTED. Dividing by all calls
    // would blend in voicemails and understate every real conversation.
    avgTalkSec: connects ? talkSec / connects : 0,
    callsPerActiveDay: days ? calls / days : 0,
  }
}

/** Connect rate by PT hour of day, over a range, optionally for one dialer.
 *  Outbound only. */
export function byHourOfDay(hourly: HourBucket[], start: string, end: string, dialer?: string | null) {
  const out = Array.from({ length: 24 }, (_, hour) => ({ hour, calls: 0, connects: 0, rate: 0 }))
  for (const h of hourly) {
    if (h.day < start || h.day > end) continue
    if (dialer && h.dialer !== dialer) continue
    out[h.hour].calls += h.calls
    out[h.hour].connects += h.connects
  }
  for (const o of out) o.rate = o.calls ? o.connects / o.calls : 0
  return out
}

/** Connect rate by weekday, over a range, optionally for one dialer. Outbound only. */
export function byWeekday(daily: DayBucket[], hourly: HourBucket[], start: string, end: string, dialer?: string | null) {
  // Several rows share a day (one per dialer) — they carry the same weekday, so
  // later writes are identical and the map stays correct.
  const dayToWeekday = new Map(daily.map(d => [d.day, d.weekday]))
  const out = Array.from({ length: 7 }, (_, weekday) => ({ weekday, calls: 0, connects: 0, rate: 0 }))
  for (const h of hourly) {
    if (h.day < start || h.day > end) continue
    if (dialer && h.dialer !== dialer) continue
    const w = dayToWeekday.get(h.day)
    if (w == null) continue
    out[w].calls += h.calls
    out[w].connects += h.connects
  }
  for (const o of out) o.rate = o.calls ? o.connects / o.calls : 0
  return out
}

/** Per-dialer totals over a range. Merges a person's two sub-account numbers,
 *  which both carry the same label. */
export function dialersInRange(dialerDaily: DialerDayBucket[], start: string, end: string) {
  const acc = new Map<string, { dialer: string; calls: number; connects: number; talkSec: number }>()
  for (const d of dialerDaily) {
    if (d.day < start || d.day > end) continue
    const e = acc.get(d.dialer) ?? { dialer: d.dialer, calls: 0, connects: 0, talkSec: 0 }
    e.calls += d.calls; e.connects += d.connects; e.talkSec += d.talkSec
    acc.set(d.dialer, e)
  }
  return [...acc.values()]
    .map(e => ({ ...e, connectRate: e.calls ? e.connects / e.calls : 0, avgTalkSec: e.connects ? e.talkSec / e.connects : 0 }))
    .sort((a, b) => b.calls - a.calls)
}

/** One dialer's totals split BY SUB-ACCOUNT over a range — "how many calls did
 *  Brianne make in each account", the question this page exists for. Only
 *  meaningful because a person dials from a different number per account. */
export function accountsForDialer(dialerDaily: DialerDayBucket[], start: string, end: string, dialer: string) {
  const acc = new Map<string, { account: string; calls: number; connects: number; talkSec: number }>()
  for (const d of dialerDaily) {
    if (d.day < start || d.day > end) continue
    if (d.dialer !== dialer) continue
    const e = acc.get(d.account) ?? { account: d.account, calls: 0, connects: 0, talkSec: 0 }
    e.calls += d.calls; e.connects += d.connects; e.talkSec += d.talkSec
    acc.set(d.account, e)
  }
  return [...acc.values()]
    .map(e => ({ ...e, connectRate: e.calls ? e.connects / e.calls : 0, avgTalkSec: e.connects ? e.talkSec / e.connects : 0 }))
    .sort((a, b) => b.calls - a.calls)
}

/** Distinct dialer names present in a range, busiest first — the filter's options. */
export function dialerNamesInRange(dialerDaily: DialerDayBucket[], start: string, end: string): string[] {
  return dialersInRange(dialerDaily, start, end).map(d => d.dialer)
}

// ── Economics ───────────────────────────────────────────────────────────────
//
// CONTACT economics, not ROI. There is no revenue here on purpose: net revenue
// is totalComp() × the 85% LO split and belongs to /lead-roi. A source can look
// expensive per connected conversation and still be the most profitable one.

export function economicsRollup(calls: CallRow[], deals: DealLite[]): EconomicsRow[] {
  const ix = buildCallIndex(calls)
  const scoped = scopedDeals(deals, coverageWindow(calls))
  const acc = new Map<string, EconomicsRow>()

  for (const d of scoped) {
    const source = d.source?.trim() || 'Unknown'
    const row = acc.get(source) ?? {
      source, leads: 0, spend: 0, connectedLeads: 0, dials: 0, dialsPerLead: 0, costPerConnect: null, funded: 0,
    }
    row.leads++
    row.spend += Number(d.lead_price) || 0
    if (d.funded_date) row.funded++
    const c = ix.get(normPhone(d.phone) ?? '')
    if (c) {
      row.dials += c.calls
      if (c.connected > 0) row.connectedLeads++
    }
    acc.set(source, row)
  }

  return [...acc.values()]
    .map(r => ({
      ...r,
      dialsPerLead: r.leads ? r.dials / r.leads : 0,
      costPerConnect: r.connectedLeads ? r.spend / r.connectedLeads : null,
    }))
    .sort((a, b) => b.spend - a.spend)
}
