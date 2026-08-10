// ── Processor desk — the scope rule and its counters ────────────────────────
// Pure, no DB, no React. Extracted from app/processing/page.tsx so the rule that
// decides "is this file on Hanh's desk?" can be asserted against real rows by
// scripts/processor-desk-check.ts — the page itself renders empty under the
// local auth-bypass server (`deals` RLS rejects anon reads), so the UI is not a
// place this logic can be verified.

import type { Deal, DealTask } from './types'
import { STAGE_SLA_DAYS } from './types'

export const ESCROW_PIPELINE = 'Loans in Process'
export const DEFAULT_PROCESSOR = 'Hanh Nguyen'

const MS_PER_DAY = 86_400_000

/**
 * The processor a deal belongs to.
 *
 * `processor_status` is the assignment of record — it's what the escrow card,
 * the Pipeline column and the deal page all write. The legacy `processor`
 * column is a FALLBACK only: the two agree on every populated row today, but a
 * blank `processor_status` alongside a populated `processor` would otherwise
 * drop the file off every desk silently.
 */
export function processorOf(d: Pick<Deal, 'processor_status' | 'processor'>): string | null {
  return d.processor_status?.trim() || d.processor?.trim() || null
}

/** Is this file on `processor`'s desk right now? Both conditions, ANDed. */
export function isOnDesk(d: Deal, processor: string): boolean {
  return d.pipeline_group === ESCROW_PIPELINE && processorOf(d) === processor
}

export function deskDeals(deals: Deal[], processor: string): Deal[] {
  return deals.filter(d => isOnDesk(d, processor))
}

export function daysUntil(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return isNaN(t) ? null : Math.floor((t - now) / MS_PER_DAY)
}

export function daysSince(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return isNaN(t) ? null : Math.floor((now - t) / MS_PER_DAY)
}

/** Has this file sat in its current stage longer than the stage allows? */
export function pastSla(d: Deal, now = Date.now()): boolean {
  const sla = STAGE_SLA_DAYS[d.status]
  if (sla == null) return false
  const inStage = daysSince(d.stage_changed_at, now) ?? daysSince(d.created_at, now)
  return inStage != null && inStage > sla
}

/** Open (not completed) deal_tasks indexed by deal id. */
export function openTasksByDeal(tasks: DealTask[]): Map<string, DealTask[]> {
  const m = new Map<string, DealTask[]>()
  for (const t of tasks) {
    if (t.completed_at || !t.deal_id) continue
    const arr = m.get(t.deal_id) ?? []
    arr.push(t)
    m.set(t.deal_id, arr)
  }
  return m
}

export type DeskKpis = {
  files: number
  openTasks: number
  overdueTasks: number
  /** Files with nothing queued on them at all — the ones that quietly stall. */
  noTask: number
  lockSoon: number
  overSla: number
}

export function deskKpis(mine: Deal[], byDeal: Map<string, DealTask[]>, now = Date.now()): DeskKpis {
  let openTasks = 0, overdueTasks = 0, noTask = 0, lockSoon = 0, overSla = 0
  for (const d of mine) {
    const ts = byDeal.get(d.id) ?? []
    openTasks += ts.length
    overdueTasks += ts.filter(t => t.due_at && new Date(t.due_at).getTime() < now).length
    if (ts.length === 0) noTask++
    const lock = daysUntil(d.lock_expiration, now)
    if (lock != null && lock <= 7) lockSoon++
    if (pastSla(d, now)) overSla++
  }
  return { files: mine.length, openTasks, overdueTasks, noTask, lockSoon, overSla }
}

/** Most urgent first: overdue next-action, then soonest lock, then longest in stage. */
export function sortDesk(list: Deal[], now = Date.now()): Deal[] {
  return [...list].sort((a, b) => {
    const aOver = a.next_action_due && new Date(a.next_action_due).getTime() < now ? 0 : 1
    const bOver = b.next_action_due && new Date(b.next_action_due).getTime() < now ? 0 : 1
    if (aOver !== bOver) return aOver - bOver
    const aLock = daysUntil(a.lock_expiration, now) ?? 9999
    const bLock = daysUntil(b.lock_expiration, now) ?? 9999
    if (aLock !== bLock) return aLock - bLock
    return (daysSince(b.stage_changed_at, now) ?? 0) - (daysSince(a.stage_changed_at, now) ?? 0)
  })
}
