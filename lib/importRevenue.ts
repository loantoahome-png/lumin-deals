// What an Arive import does to the MONEY — net revenue delta per loan officer.
//
// WHY THIS EXISTS
// On 2026-08-07 Efrain imported Arive and Matt's Lead ROI revenue dropped. The
// importer was correct: Arive's own export had re-priced one loan (David
// Mutschler, Arive 17248386 — Compensation Amount 7500 → 6000). But finding that
// took a hand-written diff of two CSVs, because the import preview counts FIELDS
// ("312 will overwrite") and says nothing about DOLLARS. A preview that had said
// "Matt −$1,500 · 1 funded loan re-priced" would have answered it in a glance.
// Full story: docs/diagnoses/2026-08-07-matt-comp-drop-diagnosis.md.
//
// DEFINITIONS — these MUST match /lead-roi or the panel lies:
//   • Revenue    = `totalComp` (Arive comp + the Non-Del price credit) on FUNDED
//                  deals only. A comp change on an in-process loan moves nothing
//                  until it funds, so it reads as $0 here — deliberately.
//   • Funded     = `isFunded` (pipeline_group 'Funded' OR a funded status).
//   • Old Deals  = parked out of reporting entirely (fetchAllDeals filters them),
//                  so they contribute $0 on both sides no matter what changes.
//   • Agg leads  = `isPurchased` (source ∈ PURCHASED_SOURCES). This is the DEFAULT
//                  /lead-roi scope and the reason the 8/07 import read as a loss:
//                  the same import ADDED $6,746 of "Others"-sourced revenue that
//                  the default view never shows. Both figures are reported.
//
// Pure — no I/O, no React. Locked by scripts/import-revenue-check.ts.
import { totalComp, type CompFields } from './comp'
import { pipelineGroupForStatus, type FieldChange, type RowPlan } from './ariveCsv'
import { isFunded, isPurchased } from './leadReport'
import { resolveLO } from './loanOfficer'
import { OLD_DEALS_GROUP, type Deal } from './types'

export const UNASSIGNED_LO = '(no loan officer)'
export const NO_SOURCE = '(no source)'

/** Why a loan's revenue moved — drives the badge in the preview. */
export type ImpactKind =
  | 'newly_funded'   // wasn't funded, will be → its whole comp enters revenue
  | 'reprice'        // already funded, a comp input changes → the delta
  | 'left_funded'    // funded today, won't be after → its whole comp leaves
  | 'reassigned'     // the money moves between loan officers

export type LoanImpact = {
  rowIndex: number
  borrower: string
  ariveFileNo: string | null
  dealId: string | null
  loanOfficer: string        // the LO bucket this entry belongs to
  source: string
  agg: boolean               // counts toward the default "Agg leads" scope
  before: number             // revenue this loan contributed to THIS bucket before
  after: number              // …and after
  delta: number
  kind: ImpactKind
  /** Set on a `reassigned` pair: the other LO involved. */
  counterparty?: string
}

export type LoImpact = {
  loanOfficer: string
  before: number
  after: number
  delta: number
  aggBefore: number
  aggAfter: number
  aggDelta: number
  loans: LoanImpact[]        // biggest absolute mover first
}

export type ImportRevenueImpact = {
  /** Net change in total funded revenue across every LO. */
  delta: number
  /** …restricted to purchased/aggregator leads — the default /lead-roi scope. */
  aggDelta: number
  before: number
  after: number
  /** Number of loans whose revenue contribution moved at all. */
  movedLoans: number
  /** Only LOs with a non-zero move, biggest absolute delta first. */
  byLo: LoImpact[]
}

/** A loan's revenue-relevant state at one point in time. */
type State = {
  lo: string
  source: string
  agg: boolean
  funded: boolean
  amount: number       // totalComp if funded, else 0
}

const EPS = 0.005   // sub-half-cent differences are float noise, not money

function loKey(v: string | null | undefined): string {
  return resolveLO(v ?? null) ?? UNASSIGNED_LO
}

function coerceNum(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}
function coerceStr(v: unknown): string | null {
  if (v == null) return null
  const t = String(v).trim()
  return t || null
}

/**
 * Net revenue impact of a planned import.
 *
 * @param plans     the preview plans, exactly as the API returned them
 * @param willWrite the SAME predicate the UI uses to decide whether a field
 *                  change is applied (mode + per-field shields). Passing the
 *                  caller's predicate rather than re-deriving it here is what
 *                  keeps the dollar figure in lockstep with the field counts —
 *                  a second copy of that rule is how the two would drift apart.
 */
export function importRevenueImpact(
  plans: RowPlan[],
  willWrite: (c: FieldChange) => boolean,
): ImportRevenueImpact {
  const buckets = new Map<string, LoImpact>()
  const bucket = (lo: string): LoImpact => {
    let b = buckets.get(lo)
    if (!b) { b = { loanOfficer: lo, before: 0, after: 0, delta: 0, aggBefore: 0, aggAfter: 0, aggDelta: 0, loans: [] }; buckets.set(lo, b) }
    return b
  }

  let movedLoans = 0

  for (const plan of plans) {
    // Unmatched rows that aren't being created touch nothing.
    if (!plan.matched && plan.action !== 'create_new') continue

    // The fields this import will actually write to this row.
    const written = new Map<string, unknown>()
    for (const c of plan.changes) if (willWrite(c)) written.set(c.field, c.next)

    const snap = plan.snapshot
    const isCreate = plan.action === 'create_new' || plan.action === 'create_loan'

    // ── BEFORE ────────────────────────────────────────────────────────────────
    // A create row is a loan that does not exist yet: it contributes $0.
    const beforeDeal = {
      status: snap?.status ?? null,
      pipeline_group: snap?.pipeline_group ?? null,
      source: snap?.source ?? null,
    }
    const parked = beforeDeal.pipeline_group === OLD_DEALS_GROUP
    const beforeComp: CompFields = {
      compensation_amount: snap?.compensation_amount ?? null,
      loan_amount:         snap?.loan_amount ?? null,
      broker_corr:         snap?.broker_corr ?? null,
      net_discount_points: snap?.net_discount_points ?? null,
    }
    const beforeFunded = !isCreate && !parked && snap != null && isFunded(beforeDeal as Deal)
    const before: State = {
      lo:     loKey(snap?.loan_officer),
      source: snap?.source ?? NO_SOURCE,
      agg:    isPurchased(beforeDeal as Deal),
      funded: beforeFunded,
      amount: beforeFunded ? totalComp(beforeComp) : 0,
    }

    // ── AFTER ─────────────────────────────────────────────────────────────────
    // Each field = what the import writes, else what's there now.
    const val = <T,>(field: string, current: T, coerce: (v: unknown) => T): T =>
      written.has(field) ? coerce(written.get(field)) : current

    const statusAfter = val('status', beforeDeal.status, coerceStr)
    // `pipeline_group` is derived from status at commit time (see the import
    // route) — EXCEPT on a parked Old Deal, whose parking survives the import.
    // Create rows carry an explicit pipeline_group in their change list.
    const groupAfter = parked
      ? OLD_DEALS_GROUP
      : written.has('pipeline_group') ? coerceStr(written.get('pipeline_group'))
      : written.has('status')         ? pipelineGroupForStatus(String(statusAfter ?? ''))
      : beforeDeal.pipeline_group
    // The importer never writes `source` on an update (it maps Arive's Lead
    // Source to `lead_source_agg`, not to the reporting column), so on an update
    // row this is always the deal's existing source. A create row may set it.
    const sourceAfter = val('source', beforeDeal.source, coerceStr)

    const afterDeal = { status: statusAfter, pipeline_group: groupAfter, source: sourceAfter }
    const afterComp: CompFields = {
      compensation_amount: val('compensation_amount', beforeComp.compensation_amount ?? null, coerceNum),
      loan_amount:         val('loan_amount',         beforeComp.loan_amount ?? null,         coerceNum),
      broker_corr:         val('broker_corr',         beforeComp.broker_corr ?? null,         coerceStr),
      net_discount_points: val('net_discount_points', beforeComp.net_discount_points ?? null, coerceNum),
    }
    const afterFunded = groupAfter !== OLD_DEALS_GROUP && isFunded(afterDeal as Deal)
    const after: State = {
      lo:     loKey(val('loan_officer', snap?.loan_officer ?? null, coerceStr)),
      source: sourceAfter ?? NO_SOURCE,
      agg:    isPurchased(afterDeal as Deal),
      funded: afterFunded,
      amount: afterFunded ? totalComp(afterComp) : 0,
    }

    const base = {
      rowIndex: plan.rowIndex,
      borrower: plan.borrower,
      ariveFileNo: plan.arive_file_no,
      dealId: plan.dealId ?? null,
    }

    // A reassignment only needs splitting when there is money to move OUT of the
    // old bucket. A create row has no prior LO (and no prior dollars), and a
    // not-yet-funded loan contributes $0 — both belong wholly to the LO they end
    // on, not to a phantom transfer from "(no loan officer)".
    const isReassignment = before.lo !== after.lo && Math.abs(before.amount) >= EPS

    if (!isReassignment) {
      const delta = after.amount - before.amount
      if (Math.abs(delta) < EPS) continue
      movedLoans++
      const b = bucket(after.lo)
      b.before += before.amount; b.after += after.amount; b.delta += delta
      if (after.agg || before.agg) {
        b.aggBefore += before.agg ? before.amount : 0
        b.aggAfter  += after.agg  ? after.amount  : 0
        b.aggDelta  += (after.agg ? after.amount : 0) - (before.agg ? before.amount : 0)
      }
      b.loans.push({
        ...base, loanOfficer: after.lo, source: after.source, agg: after.agg,
        before: before.amount, after: after.amount, delta,
        kind: !before.funded && after.funded ? 'newly_funded'
            : before.funded && !after.funded ? 'left_funded'
            : 'reprice',
      })
      continue
    }

    // ── Reassigned: the money LEAVES one LO and ARRIVES at another ────────────
    // Both sides are real movements on their own /lead-roi tab, so each gets its
    // own signed entry. (loan_officer is an overwritable Arive field — and one of
    // the shieldable ones, precisely because this is consequential.)
    if (Math.abs(before.amount) < EPS && Math.abs(after.amount) < EPS) continue
    movedLoans++
    if (Math.abs(before.amount) >= EPS) {
      const out = bucket(before.lo)
      out.before += before.amount; out.delta -= before.amount
      if (before.agg) { out.aggBefore += before.amount; out.aggDelta -= before.amount }
      out.loans.push({
        ...base, loanOfficer: before.lo, source: before.source, agg: before.agg,
        before: before.amount, after: 0, delta: -before.amount,
        kind: 'reassigned', counterparty: after.lo,
      })
    }
    if (Math.abs(after.amount) >= EPS) {
      const inn = bucket(after.lo)
      inn.after += after.amount; inn.delta += after.amount
      if (after.agg) { inn.aggAfter += after.amount; inn.aggDelta += after.amount }
      inn.loans.push({
        ...base, loanOfficer: after.lo, source: after.source, agg: after.agg,
        before: 0, after: after.amount, delta: after.amount,
        kind: 'reassigned', counterparty: before.lo,
      })
    }
  }

  const byLo = [...buckets.values()]
    .filter(b => Math.abs(b.delta) >= EPS || Math.abs(b.aggDelta) >= EPS)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  for (const b of byLo) b.loans.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))

  return {
    delta:      byLo.reduce((s, b) => s + b.delta, 0),
    aggDelta:   byLo.reduce((s, b) => s + b.aggDelta, 0),
    before:     byLo.reduce((s, b) => s + b.before, 0),
    after:      byLo.reduce((s, b) => s + b.after, 0),
    movedLoans,
    byLo,
  }
}
