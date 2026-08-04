// ── GHL tasks on the dashboard board ─────────────────────────────────────────
// GoHighLevel keeps its own per-contact tasks (65 open across the two locations
// at build time). They used to live only in GHL, so the board showed half the
// team's real workload. This module is the PURE half of the mirror: the shape
// of GHL's search row, how it maps to a `ghl_tasks` row, and how that row is
// adapted into the DealTask shape the board already renders.
//
// Endpoints (all verified live 2026-08-03, see docs/specs):
//   POST /locations/{locationId}/tasks/search   → 201, location-wide, keyset
//        paged via each row's `searchAfter`; `completed:false` genuinely filters
//        (18 open + 8 done = 26 unfiltered on primary).
//   PUT  /contacts/{contactId}/tasks/{taskId}/completed  { completed: true }
//   The obvious guesses 404: /tasks/search, /contacts/tasks/search, v1 /tasks.
//
// ⚠️ The search row has NO body/description — only the single-task GET does.
// Their titles are full sentences, so v1 shows the title alone rather than
// paying an extra GET per task on every sweep.

import { resolveLO } from './loanOfficer'
import type { DealTask } from './types'

/** Board ids are namespaced so a GHL row can never collide with a deal_tasks uuid. */
export const GHL_TASK_PREFIX = 'ghl:'

export type GhlTaskSearchRow = {
  _id: string
  locationId?: string | null
  title?: string | null
  completed?: boolean
  deleted?: boolean
  dueDate?: string | null
  status?: string | null
  statusGroup?: string | null
  contactId?: string | null
  contactDetails?: { firstName?: string | null; lastName?: string | null } | null
  assignedTo?: string | null
  assignedToUserDetails?: { id?: string | null; firstName?: string | null; lastName?: string | null } | null
  dateAdded?: string | null
  dateUpdated?: string | null
  searchAfter?: unknown[]
}

export type GhlTaskRow = {
  ghl_task_id: string
  location_id: string
  contact_id: string | null
  deal_id: string | null
  contact_name: string | null
  title: string
  assignee: string | null
  assigned_user_id: string | null
  due_at: string | null
  status: string | null
  ghl_created_at: string | null
  ghl_updated_at: string | null
}

/** A board row: a deal_tasks row, or a GHL task wearing the same shape. */
export type BoardTask = DealTask & {
  source?: 'ghl'
  ghl_task_id?: string
  ghl_contact_id?: string | null
  ghl_location_id?: string | null
  contact_name?: string | null
}

function fullName(p?: { firstName?: string | null; lastName?: string | null } | null): string | null {
  if (!p) return null
  const n = `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim()
  return n || null
}

/** GHL user → the exact board-column name. resolveLO already folds
 *  "Matthew Park" → "Matt Park"; Brianne/Efrain pass through untouched. */
export function taskAssignee(raw: GhlTaskSearchRow): string | null {
  return resolveLO(fullName(raw.assignedToUserDetails))
}

/** Contact name, title-cased — GHL stores them lowercase ("john betterman"). */
export function taskContactName(raw: GhlTaskSearchRow): string | null {
  const n = fullName(raw.contactDetails)
  if (!n) return null
  return n.replace(/\b[a-z]/g, c => c.toUpperCase())
}

/**
 * GHL search row → `ghl_tasks` row. Returns null for anything that should not
 * be mirrored (completed, deleted, no id). `dealIdFor` resolves the GHL contact
 * to one of our deals so the row can link through to the deal page.
 */
export function mapGhlTask(
  raw: GhlTaskSearchRow,
  locationId: string,
  dealIdFor: (contactId: string | null | undefined) => string | null,
): GhlTaskRow | null {
  if (!raw?._id) return null
  if (raw.completed || raw.deleted) return null
  return {
    ghl_task_id: raw._id,
    location_id: raw.locationId || locationId,
    contact_id: raw.contactId ?? null,
    deal_id: dealIdFor(raw.contactId),
    contact_name: taskContactName(raw),
    title: (raw.title ?? '').trim() || 'Untitled GHL task',
    assignee: taskAssignee(raw),
    assigned_user_id: raw.assignedToUserDetails?.id ?? raw.assignedTo ?? null,
    due_at: raw.dueDate ?? null,
    status: raw.statusGroup ?? raw.status ?? null,
    ghl_created_at: raw.dateAdded ?? null,
    ghl_updated_at: raw.dateUpdated ?? null,
  }
}

/**
 * `ghl_tasks` row → a board task. Only OPEN tasks are stored, so completed_at
 * is always null — which also keeps them out of the Completed chip and out of
 * "Clear completed" (that only ever touches deal_tasks).
 */
export function toBoardTask(row: GhlTaskRow & { created_at?: string | null }): BoardTask {
  return {
    id: GHL_TASK_PREFIX + row.ghl_task_id,
    deal_id: row.deal_id,
    title: row.title,
    description: null,
    due_at: row.due_at,
    assignee: row.assignee,
    assigned_by: null,
    priority: null,
    completed_at: null,
    created_at: row.created_at ?? row.ghl_created_at ?? new Date(0).toISOString(),
    source: 'ghl',
    ghl_task_id: row.ghl_task_id,
    ghl_contact_id: row.contact_id,
    ghl_location_id: row.location_id,
    contact_name: row.contact_name,
  }
}

export function isGhlTask(t: BoardTask): boolean {
  return t.source === 'ghl' || t.id.startsWith(GHL_TASK_PREFIX)
}

/**
 * Complete a mirrored task: writes back to GHL, then the route drops the mirror
 * row. Returns null on success, an error message otherwise. Shared by /tasks and
 * the Follow-Up cockpit so the two can't drift — each caller just drops the row
 * from its own state.
 */
export async function completeGhlTask(taskId: string): Promise<string | null> {
  try {
    const res = await fetch('/api/ghl/tasks/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId }),
    })
    const json = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null
    if (!res.ok || !json?.ok) return json?.error ?? `HTTP ${res.status}`
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/** Board order: soonest first, undated last. The column floats undated to the
 *  top of its own Overdue & today bucket — see AssigneeColumn. */
export function byDueAsc(a: BoardTask, b: BoardTask): number {
  const da = a.due_at ? new Date(a.due_at).getTime() : Infinity
  const db = b.due_at ? new Date(b.due_at).getTime() : Infinity
  return da - db
}
