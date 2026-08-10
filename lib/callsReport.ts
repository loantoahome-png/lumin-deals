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
import type { CallRow } from './callsCsv'

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
