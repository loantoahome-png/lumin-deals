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
  // ⚠️ TOMBSTONE. Deleting a task in GHL does NOT remove it from the task search
  // index — the row comes back with `deleted:false`, `completed:false`, its
  // contactId STRIPPED and contactDetails nulled. Mirroring that produces a row
  // nobody can act on: complete and delete both address /contacts/{id}/tasks/…,
  // so with no contact it is stuck on the board forever (hit 2026-08-04).
  // A real GHL task always hangs on a contact, so "no contactId" == not a task.
  if (!raw.contactId) return null
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
 * A completed GHL task. These are NEVER mirrored — `ghl_tasks` holds open rows
 * only and a completion deletes the row — so the "Completed" view asks GHL live
 * (GET /api/ghl/tasks/completed) instead of reading our table.
 *
 * ⚠️ `completed_at` is GHL's `dateUpdated`, which is LAST MODIFIED, not a real
 * completion timestamp. For a task that was completed and never touched again
 * they're the same instant; for one edited afterwards the stamp is the edit.
 * GHL exposes no completedAt field on the search row, so this is the best
 * available signal — the UI labels it "last updated" rather than claiming more.
 */
export type GhlCompletedTaskRow = GhlTaskRow & { completed_at: string | null }

/**
 * GHL search row → a COMPLETED task row. The mirror's `mapGhlTask` rejects
 * anything completed, so this is its inverse: it requires `completed`, and
 * rejects the same tombstones (a row that lost its contact is not a task —
 * see the ⚠️ above `mapGhlTask`).
 */
export function mapCompletedGhlTask(
  raw: GhlTaskSearchRow,
  locationId: string,
  dealIdFor: (contactId: string | null | undefined) => string | null,
): GhlCompletedTaskRow | null {
  if (!raw?._id) return null
  if (!raw.completed || raw.deleted) return null
  if (!raw.contactId) return null
  // Every field but the completed/deleted gate maps identically to an open
  // task, so borrow the mirror's mapper rather than keeping a second copy in
  // sync — pass it a row it will accept, then re-stamp what differs.
  const base = mapGhlTask({ ...raw, completed: false }, locationId, dealIdFor)
  if (!base) return null
  return { ...base, completed_at: raw.dateUpdated ?? null }
}

/**
 * `ghl_tasks` row → a board task. Only OPEN tasks are stored, so completed_at
 * is always null — which also keeps mirrored rows out of "Clear completed"
 * (that only ever touches deal_tasks). Completed GHL rows come from
 * `toCompletedBoardTask` below, never from the table.
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

/**
 * A completed GHL task → a board row. Same shape as an open mirrored row, but
 * carrying `completed_at` so the existing Completed chip, the strikethrough and
 * the completed-desc sort all work untouched.
 *
 * These rows are not in `ghl_tasks`, so the complete and delete routes — which
 * look the row up by id before calling GHL — would 404 on them, and `/tasks`
 * omits delete. The toggle DOES work: it reopens via `reopenGhlTask`, which
 * resolves the contact from GHL's own completed list instead of our table.
 */
export function toCompletedBoardTask(row: GhlCompletedTaskRow): BoardTask {
  return { ...toBoardTask(row), completed_at: row.completed_at }
}

export function isGhlTask(t: BoardTask): boolean {
  return t.source === 'ghl' || t.id.startsWith(GHL_TASK_PREFIX)
}

/**
 * Fetch recently completed GHL tasks. Live per call — there is no local copy.
 * Returns board rows newest-first, or an error message.
 */
export async function fetchCompletedGhlTasks(
  days = 90,
): Promise<{ tasks: BoardTask[]; error: string | null }> {
  try {
    const res = await fetch(`/api/ghl/tasks/completed?days=${days}`)
    const json = await res.json().catch(() => null) as
      { ok?: boolean; tasks?: GhlCompletedTaskRow[]; error?: string } | null
    if (!res.ok || !json?.ok) return { tasks: [], error: json?.error ?? `HTTP ${res.status}` }
    return { tasks: (json.tasks ?? []).map(toCompletedBoardTask), error: null }
  } catch (e) {
    return { tasks: [], error: e instanceof Error ? e.message : String(e) }
  }
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

/**
 * Delete a mirrored task in GHL, then drop the mirror row. Returns null on
 * success, an error message otherwise. Same shape as completeGhlTask so both
 * live in one place and the three surfaces can't drift.
 */
export async function deleteGhlTask(taskId: string): Promise<string | null> {
  try {
    const res = await fetch('/api/ghl/tasks/delete', {
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

/**
 * Un-complete a GHL task — the undo for a mis-click. Returns the re-mirrored
 * `ghl_tasks` row so the caller can move it from its completed list back onto
 * the open board without refetching, or an error message.
 *
 * `task` can be null when the write succeeded but the re-mirror didn't; the row
 * still returns to the board on the next 15-min sweep.
 */
export async function reopenGhlTask(
  taskId: string,
): Promise<{ task: GhlTaskRow | null; error: string | null }> {
  try {
    const res = await fetch('/api/ghl/tasks/reopen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId }),
    })
    const json = await res.json().catch(() => null) as
      { ok?: boolean; task?: GhlTaskRow | null; error?: string } | null
    if (!res.ok || !json?.ok) return { task: null, error: json?.error ?? `HTTP ${res.status}` }
    return { task: json.task ?? null, error: null }
  } catch (e) {
    return { task: null, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Board order: soonest first, undated last. The column floats undated to the
 *  top of its own Overdue & today bucket — see AssigneeColumn. */
export function byDueAsc(a: BoardTask, b: BoardTask): number {
  const da = a.due_at ? new Date(a.due_at).getTime() : Infinity
  const db = b.due_at ? new Date(b.due_at).getTime() : Infinity
  return da - db
}
