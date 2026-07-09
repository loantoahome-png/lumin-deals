// Report Import — multi-file merge engine (pure, no I/O).
//
// Powers /report-import. The user uploads one or more exports; we auto-detect
// each file's KIND by its header signature and join them into a single
// LeadRow[]-compatible list that lib/leadReport.ts can segment/groupBy.
//
// The canonical two-file combo (verified by hand 2026-07-09):
//   • GHL "Opportunities" export  → the SPEND base: every agg lead with its
//     Lead Price, source, clean stage, and an "Arive Loan ID" join key.
//   • Arive "Funded Agg" export   → the OUTCOME authority: Compensation + the
//     real loan Stage Name for each funded / in-process loan. (GHL's own
//     compensation write-back is incomplete, so Arive wins on comp + stage.)
// Joined on Arive Loan ID (exact), with a borrower-name fallback for rows that
// have no Arive id (e.g. a funded loan whose opportunity sits in another pipeline).
//
// Comp is split so leadReport.segment() stays correct: segment() sums comp over
// PRICED rows only, so we put realized comp on FUNDED rows (compensation_amount)
// and carry in-process expected comp separately (expected_comp) for the projection.

import { cleanSource } from './utils'
import type { LeadRow } from './leadReport'

export type ReportKind = 'ghl-opportunities' | 'arive-funded' | 'ghl-contacts' | 'generic'

export const KIND_LABEL: Record<ReportKind, string> = {
  'ghl-opportunities': 'GHL Opportunities',
  'arive-funded': 'Arive Funded / In-Process',
  'ghl-contacts': 'GHL Contacts',
  'generic': 'Unrecognized CSV',
}

export type ParsedFile = { name: string; headers: string[]; rows: Record<string, string>[] }

/** A merged lead — a LeadRow (so leadReport can segment it) plus join provenance. */
export type MergedLead = LeadRow & {
  borrower: string | null
  arive_loan_id: string | null
  reached_arive: boolean
  expected_comp: number | null   // comp for an in-process (reached Arive, not yet funded) loan
}

export type MergeMeta = {
  files: { name: string; kind: ReportKind; rows: number }[]
  totalLeads: number
  reachedArive: number
  funded: number
  inProcess: number
  matchedOutcomes: number   // outcome rows joined onto a base lead
  appendedOutcomes: number  // outcome rows with no base lead (added on their own)
  unpricedFunded: string[]  // funded borrowers with NO lead price (excluded from ROI) — a warning
  spend: number
  realizedRevenue: number
  expectedRevenue: number
  warnings: string[]
}
export type MergeResult = { leads: MergedLead[]; meta: MergeMeta }

const FUNDED_STAGES = new Set(['Loan Funded', 'Broker Check Received', 'Loan Finalized'])

// ── header + value helpers ─────────────────────────────────────────────────────
const hnorm = (s: string) => s.toLowerCase().replace(/[\s_]+/g, '')
function findHeader(headers: string[], ...cands: string[]): string | null {
  const map = new Map(headers.map(h => [hnorm(h), h]))
  for (const c of cands) { const h = map.get(hnorm(c)); if (h) return h }
  return null
}
function hasAll(headers: string[], ...need: string[]): boolean {
  const set = new Set(headers.map(hnorm))
  return need.every(n => set.has(hnorm(n)))
}
const money = (v: string | undefined | null): number | null => {
  if (v == null) return null
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''))
  return isNaN(n) ? null : n
}
const idKey = (v: string | null | undefined): string => String(v ?? '').trim()
const nameKey = (full: string | null | undefined): string => {
  const t = String(full ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  return t.length ? `${t[0]}|${t[t.length - 1]}` : ''
}
// GHL Contacts "Opportunities" is a composite: "open N) <Group> <Stage>". Extract the trailing stage.
const cleanComposite = (s: string): string => {
  const m = String(s ?? '').match(/^\s*\w+\s+\d+\)\s+(?:Leads|Not Ready|Loans in Process|Funded)\s+(.*)$/)
  return m ? m[1].trim() : String(s ?? '').trim()
}

// ── kind detection ──────────────────────────────────────────────────────────
export function detectKind(headers: string[]): ReportKind {
  if (hasAll(headers, 'ARIVE Loan Id', 'Compensation Amount', 'Stage Name', 'Primary Borrower')) return 'arive-funded'
  if (hasAll(headers, 'Arive Loan ID', 'stage') && (hasAll(headers, 'Opportunity name') || hasAll(headers, 'Lead Price'))) return 'ghl-opportunities'
  if (hasAll(headers, 'Opportunities', 'Lead Price') && hasAll(headers, 'Contact Id')) return 'ghl-contacts'
  return 'generic'
}

// ── extraction ────────────────────────────────────────────────────────────────
type Outcome = { ariveId: string; name: string; source: string | null; stage: string; comp: number | null; purpose: string | null; state: string | null }
type BaseLead = { source: string | null; stage: string; leadPrice: number | null; ariveId: string; name: string; state: string | null; purpose: string | null; lo: string | null }

function extractOutcomes(f: ParsedFile): Outcome[] {
  const H = (...c: string[]) => findHeader(f.headers, ...c)
  const hId = H('ARIVE Loan Id'), hName = H('Primary Borrower'), hSrc = H('Lead Source'),
    hStage = H('Stage Name'), hComp = H('Compensation Amount'), hPurp = H('Loan Purpose'), hState = H('Subject State')
  return f.rows.map(r => ({
    ariveId: idKey(hId ? r[hId] : ''),
    name: (hName ? r[hName] : '') || '',
    source: hSrc ? r[hSrc] ?? null : null,
    stage: (hStage ? r[hStage] : '')?.trim() || '',
    comp: money(hComp ? r[hComp] : null),
    purpose: hPurp ? r[hPurp] ?? null : null,
    state: hState ? r[hState] ?? null : null,
  }))
}
function extractOpportunities(f: ParsedFile): BaseLead[] {
  const H = (...c: string[]) => findHeader(f.headers, ...c)
  const hSrc = H('source'), hStage = H('stage'), hLoanStage = H('Loan Stage Name'), hPrice = H('Lead Price'),
    hId = H('Arive Loan ID'), hName = H('Contact Name'), hState = H('Subject Property State', 'Primary Borrower State'),
    hPurp = H('Loan Purpose'), hLo = H('assigned')
  return f.rows.map(r => {
    const ariveId = idKey(hId ? r[hId] : '')
    // Prefer the Arive loan stage when this opp reached Arive; else the GHL pipeline stage.
    const loanStage = (hLoanStage ? r[hLoanStage] : '')?.trim()
    const stage = (ariveId && loanStage) ? loanStage : ((hStage ? r[hStage] : '')?.trim() || '')
    return {
      source: hSrc ? r[hSrc] ?? null : null, stage, leadPrice: money(hPrice ? r[hPrice] : null),
      ariveId, name: (hName ? r[hName] : '') || '', state: hState ? r[hState] ?? null : null,
      purpose: hPurp ? r[hPurp] ?? null : null, lo: hLo ? r[hLo] ?? null : null,
    }
  })
}
function extractContacts(f: ParsedFile): BaseLead[] {
  const H = (...c: string[]) => findHeader(f.headers, ...c)
  const hSrc = H('Lead Source'), hOpp = H('Opportunities'), hPrice = H('Lead Price'),
    hFirst = H('First Name'), hLast = H('Last Name'), hState = H('Mailing State'), hPurp = H('Loan Purpose')
  return f.rows.map(r => ({
    source: hSrc ? r[hSrc] ?? null : null,
    stage: cleanComposite((hOpp ? r[hOpp] : '') || ''),
    leadPrice: money(hPrice ? r[hPrice] : null),
    ariveId: '', name: `${(hFirst ? r[hFirst] : '') || ''} ${(hLast ? r[hLast] : '') || ''}`.trim(),
    state: hState ? r[hState] ?? null : null, purpose: hPurp ? r[hPurp] ?? null : null, lo: null, comp: null,
  }))
}

// ── merge ─────────────────────────────────────────────────────────────────────
export function mergeReports(files: ParsedFile[]): MergeResult {
  const kinds = files.map(f => ({ f, kind: detectKind(f.headers) }))
  const warnings: string[] = []

  // 1) Outcomes (Arive authority), indexed by loan id + borrower name.
  const outcomesById = new Map<string, Outcome>()
  const outcomesByName = new Map<string, Outcome>()
  const allOutcomes: Outcome[] = []
  for (const { f, kind } of kinds) if (kind === 'arive-funded') {
    for (const o of extractOutcomes(f)) {
      allOutcomes.push(o)
      if (o.ariveId) outcomesById.set(o.ariveId, o)
      const nk = nameKey(o.name); if (nk) outcomesByName.set(nk, o)
    }
  }

  // 2) Base leads (the spend denominator): opportunities first, then contacts to
  //    fill people the opportunities export doesn't include. Dedupe by Arive id / name.
  const base: BaseLead[] = []
  const seen = new Set<string>()
  const pushBase = (b: BaseLead) => {
    // Dedupe on BOTH keys: the same person can appear in Opportunities (with an
    // Arive id) and Contacts (name only) — checking one key alone double-counts them.
    const ak = b.ariveId ? 'a:' + b.ariveId : null
    const nk = nameKey(b.name) ? 'n:' + nameKey(b.name) : null
    if ((ak && seen.has(ak)) || (nk && seen.has(nk))) return
    if (ak) seen.add(ak); if (nk) seen.add(nk)
    base.push(b)
  }
  for (const { f, kind } of kinds) if (kind === 'ghl-opportunities') extractOpportunities(f).forEach(pushBase)
  for (const { f, kind } of kinds) if (kind === 'ghl-contacts') extractContacts(f).forEach(pushBase)

  const matchOutcome = (b: BaseLead): Outcome | null => {
    if (b.ariveId && outcomesById.has(b.ariveId)) return outcomesById.get(b.ariveId)!
    const nk = nameKey(b.name); if (nk && outcomesByName.has(nk)) return outcomesByName.get(nk)!
    return null
  }
  const usedKey = (o: Outcome) => o.ariveId || nameKey(o.name)

  const leads: MergedLead[] = []
  const used = new Set<string>()
  let matchedOutcomes = 0

  // 3) Every base lead → a merged lead, with Arive comp/stage/source overlaid on a match.
  for (const b of base) {
    const o = matchOutcome(b)
    if (o) { used.add(usedKey(o)); matchedOutcomes++ }
    const reached = !!o || !!b.ariveId
    const status = (o?.stage || b.stage || '').trim()
    const funded = FUNDED_STAGES.has(status)
    // Only trust Arive for compensation — GHL's own comp write-back is unreliable/incomplete.
    // A base lead with no Arive-outcome match contributes no comp (revenue stays honest).
    const rawComp = o ? o.comp : null
    const source = cleanSource(o?.source ?? null) ?? cleanSource(b.source) ?? 'Self Source'
    leads.push({
      loan_officer: b.lo, pipeline_group: funded ? 'Funded' : (reached ? 'Loans in Process' : ''),
      status, source, state: b.state, loan_purpose: o?.purpose ?? b.purpose,
      lead_price: b.leadPrice, compensation_amount: funded ? rawComp : null,
      borrower: b.name || null, arive_loan_id: b.ariveId || o?.ariveId || null,
      reached_arive: reached, expected_comp: reached && !funded ? rawComp : null,
    })
  }

  // 4) Outcomes with no base lead → append. Recover a lead price by borrower name.
  const priceByName = new Map<string, number>()
  for (const b of base) { const nk = nameKey(b.name); if (nk && b.leadPrice != null && !priceByName.has(nk)) priceByName.set(nk, b.leadPrice) }
  let appendedOutcomes = 0
  for (const o of allOutcomes) {
    const k = usedKey(o); if (!k || used.has(k)) continue
    used.add(k); appendedOutcomes++
    const funded = FUNDED_STAGES.has(o.stage)
    const lp = priceByName.get(nameKey(o.name)) ?? null
    leads.push({
      loan_officer: null, pipeline_group: funded ? 'Funded' : 'Loans in Process',
      status: o.stage, source: cleanSource(o.source) ?? 'Self Source', state: o.state, loan_purpose: o.purpose,
      lead_price: lp, compensation_amount: funded ? o.comp : null,
      borrower: o.name || null, arive_loan_id: o.ariveId || null,
      reached_arive: true, expected_comp: funded ? null : o.comp,
    })
  }

  // 5) Meta — spend/revenue mirror leadReport.segment (priced rows only) so numbers agree.
  const priced = leads.filter(l => (l.lead_price ?? 0) > 0)
  const spend = priced.reduce((s, l) => s + (l.lead_price ?? 0), 0)
  const realizedRevenue = priced.reduce((s, l) => s + (l.compensation_amount ?? 0), 0)
  const expectedRevenue = leads.reduce((s, l) => s + (l.expected_comp ?? 0), 0)
  const funded = leads.filter(l => FUNDED_STAGES.has(l.status ?? '')).length
  const inProcess = leads.filter(l => l.reached_arive && !FUNDED_STAGES.has(l.status ?? '')).length
  // Funded loans whose lead price we never found → excluded from ROI (segment is priced-only). Warn.
  const unpricedFunded = leads.filter(l => FUNDED_STAGES.has(l.status ?? '') && (l.lead_price ?? 0) <= 0).map(l => l.borrower || '(unnamed)')

  const kindsPresent = new Set(kinds.map(k => k.kind))
  if (kindsPresent.has('ghl-opportunities') && !kindsPresent.has('arive-funded'))
    warnings.push('No Arive "Funded" export detected — compensation/funded data comes from GHL and is often incomplete. Add the Arive Funded export for accurate revenue.')
  if (kindsPresent.has('arive-funded') && !kindsPresent.has('ghl-opportunities') && !kindsPresent.has('ghl-contacts'))
    warnings.push('No GHL lead export detected — there is no lead-price base, so spend/ROI cannot be computed. Add the GHL Opportunities export.')
  if (unpricedFunded.length)
    warnings.push(`${unpricedFunded.length} funded loan(s) have no matching lead price and are excluded from ROI: ${unpricedFunded.join(', ')}. Add the GHL Contacts export (or include their opportunity) to capture them.`)

  return {
    leads,
    meta: {
      files: kinds.map(k => ({ name: k.f.name, kind: k.kind, rows: k.f.rows.length })),
      totalLeads: leads.length, reachedArive: leads.filter(l => l.reached_arive).length,
      funded, inProcess, matchedOutcomes, appendedOutcomes, unpricedFunded,
      spend, realizedRevenue, expectedRevenue, warnings,
    },
  }
}
