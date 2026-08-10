// ── Work List ───────────────────────────────────────────────────────────────
// The processor checklist, TRANSPOSED.
//
// The per-loan checklist answers "where is this file at". The Google Doc it
// replaced (Tasklist for Bri and Efrain) answered the opposite question: "what
// do I have to order today, and on which files" —
//
//     Payoff
//       a. Ciarmoli
//       b. Rugley
//
// Same data, rotated. This file does the rotation and nothing else: pure, no
// I/O, no React, fixture-tested in scripts/work-list-check.ts.

import type { Deal } from './types'
import {
  CHECKLIST_TEMPLATE, mergeChecklist, isCustomId, CUSTOM_PHASE,
  type ChecklistDef, type ChecklistRow, type ChecklistState,
} from './processorChecklist'

const MS_PER_DAY = 86_400_000

/** One loan's position on one action. */
export type WorkItem = {
  dealId: string
  dealName: string
  loanOfficer: string | null
  stage: string
  /** The checklist item id — the join key back into `processor_checklist`. */
  itemId: string
  label: string
  done_at: string | null
  done_by: string | null
  note: string | null
  requested_at?: string | null
  requested_by?: string | null
  requested_from?: string | null
  /** Whole days since it was requested; null when it hasn't been. */
  waitingDays: number | null
}

export type WorkGroup = {
  itemId: string
  label: string
  items: WorkItem[]
}

export type WorkState = 'todo' | 'waiting' | 'done'

export function workState(i: Pick<WorkItem, 'done_at' | 'requested_at'>): WorkState {
  if (i.done_at) return 'done'
  if (i.requested_at) return 'waiting'
  return 'todo'
}

export function daysSince(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return isNaN(t) ? null : Math.floor((now - t) / MS_PER_DAY)
}

/** The template steps that appear on this page — the chase steps only. */
export function worklistTemplate(template: ChecklistDef[] = CHECKLIST_TEMPLATE): ChecklistDef[] {
  return template.filter(d => d.worklist)
}

/**
 * Every (loan × worklist step) pair, plus every custom row anyone has added.
 *
 * ⚠️ Custom rows are ALWAYS included regardless of the `worklist` flag — they
 *    exist precisely because someone needed an action the template doesn't have,
 *    so filtering them out would make the escape hatch useless.
 *
 * ⚠️ Runs each deal through `mergeChecklist` rather than reading the raw JSONB,
 *    so loan-purpose gating is honoured — a purchase must not show up under
 *    "Payoff ordered" (a refinance-only step) just because the column is empty.
 */
export function buildWorkItems(deals: Deal[], now = Date.now()): WorkItem[] {
  const out: WorkItem[] = []
  const worklistIds = new Set(worklistTemplate().map(d => d.id))

  for (const deal of deals) {
    const rows: ChecklistRow[] = mergeChecklist(
      deal.processor_checklist as ChecklistState[] | null,
      undefined,
      deal.loan_purpose,
    )
    for (const r of rows) {
      if (r.retired) continue
      if (!worklistIds.has(r.id) && !isCustomId(r.id)) continue
      out.push({
        dealId: deal.id,
        dealName: deal.name,
        loanOfficer: deal.loan_officer,
        stage: deal.status,
        itemId: r.id,
        label: r.label,
        done_at: r.done_at,
        done_by: r.done_by,
        note: r.note,
        requested_at: r.requested_at ?? null,
        requested_by: r.requested_by ?? null,
        requested_from: r.requested_from ?? null,
        waitingDays: r.done_at ? null : daysSince(r.requested_at, now),
      })
    }
  }
  return out
}

/**
 * Group items by action, in template order, custom actions last.
 *
 * Custom rows group by LABEL, not by id: two people adding "Order supps" on two
 * different loans produce two different ids, and showing them as two identical
 * one-item groups would defeat the whole point of grouping by action. The
 * comparison is case- and whitespace-insensitive; the first spelling wins as the
 * display label.
 */
export function groupByAction(items: WorkItem[]): WorkGroup[] {
  const order = new Map(worklistTemplate().map((d, i) => [d.id, i]))
  const groups = new Map<string, WorkGroup>()

  for (const it of items) {
    const key = isCustomId(it.itemId) ? `custom:${it.label.trim().toLowerCase()}` : it.itemId
    const g = groups.get(key)
    if (g) g.items.push(it)
    else groups.set(key, { itemId: key, label: it.label, items: [it] })
  }

  return [...groups.values()].sort((a, b) => {
    const ai = order.has(a.itemId) ? order.get(a.itemId)! : Number.MAX_SAFE_INTEGER
    const bi = order.has(b.itemId) ? order.get(b.itemId)! : Number.MAX_SAFE_INTEGER
    if (ai !== bi) return ai - bi
    return a.label.localeCompare(b.label)   // custom groups, alphabetical
  })
}

/** Filter to one state, then re-group. Empty groups drop out entirely. */
export function groupsForState(items: WorkItem[], state: WorkState | 'open'): WorkGroup[] {
  const want = (i: WorkItem) => {
    const s = workState(i)
    // 'open' = anything not finished: what's left to do AND what we're chasing.
    return state === 'open' ? s !== 'done' : s === state
  }
  return groupByAction(items.filter(want))
    .map(g => g)
    .filter(g => g.items.length > 0)
}

export type WorkCounts = { todo: number; waiting: number; done: number; overdueWaits: number }

/** Header counts. `overdueWaits` = requested and still not in after `staleDays`. */
export function workCounts(items: WorkItem[], staleDays = 3): WorkCounts {
  let todo = 0, waiting = 0, done = 0, overdueWaits = 0
  for (const i of items) {
    switch (workState(i)) {
      case 'done': done++; break
      case 'waiting':
        waiting++
        if ((i.waitingDays ?? 0) >= staleDays) overdueWaits++
        break
      default: todo++
    }
  }
  return { todo, waiting, done, overdueWaits }
}

/** The chase list: longest wait first. */
export function sortByWait(items: WorkItem[]): WorkItem[] {
  return [...items].sort((a, b) => (b.waitingDays ?? -1) - (a.waitingDays ?? -1))
}

/** Recently completed, newest first — the doc's dated "Completed" log. */
export function recentlyCompleted(items: WorkItem[], withinDays = 14, now = Date.now()): WorkItem[] {
  return items
    .filter(i => i.done_at && (daysSince(i.done_at, now) ?? 999) <= withinDays)
    .sort((a, b) => new Date(b.done_at!).getTime() - new Date(a.done_at!).getTime())
}

export { CUSTOM_PHASE }
