// Fixtures for lib/ghlTasks.ts — the pure half of the GHL task mirror.
// Run: npx tsx scripts/ghl-tasks-check.ts
//
// Payload shapes are copied from a real POST /locations/{id}/tasks/search
// response captured 2026-08-03, not invented.

import {
  mapGhlTask, toBoardTask, isGhlTask, taskAssignee, taskContactName,
  GHL_TASK_PREFIX, type GhlTaskSearchRow,
} from '../lib/ghlTasks'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}

const LOC = 'PKEBK2NXDuug25VABQ61'
const raw = (over: Partial<GhlTaskSearchRow> = {}): GhlTaskSearchRow => ({
  _id: 'VXI5uNatt07U0rmIbS8u',
  locationId: LOC,
  deleted: false,
  dateAdded: '2026-06-16T15:22:01.789Z',
  dateUpdated: '2026-06-16T15:22:04.090Z',
  assignedTo: 'SVXQeoFxrP8ZoFd11nyF',
  contactDetails: { firstName: 'john', lastName: 'betterman' },
  assignedToUserDetails: { id: 'SVXQeoFxrP8ZoFd11nyF', firstName: 'Brianne', lastName: 'Han' },
  completed: false,
  dueDate: '2027-06-16T15:00:00.000Z',
  title: 'follow up to see if he is ready',
  status: 'to_do',
  statusGroup: 'to_do',
  contactId: 'oz9XkKwbXSdK8nFe50hD',
  ...over,
})

const dealFor = (id: string | null | undefined) => id === 'oz9XkKwbXSdK8nFe50hD' ? 'deal-1' : null

// ── assignee resolution ──────────────────────────────────────────────────────
// GHL calls him "Matthew Park"; the board column is "Matt Park". Getting this
// wrong doesn't error — it silently dumps 29 tasks into "Unassigned & other".
eq('assignee: Matthew Park folds to the board name',
  taskAssignee(raw({ assignedToUserDetails: { id: 'u', firstName: 'Matthew', lastName: 'Park' } })), 'Matt Park')
eq('assignee: Brianne passes through', taskAssignee(raw()), 'Brianne Han')
eq('assignee: Efrain passes through',
  taskAssignee(raw({ assignedToUserDetails: { id: 'u', firstName: 'Efrain', lastName: 'Ramirez' } })), 'Efrain Ramirez')
eq('assignee: Moe folds', taskAssignee(raw({ assignedToUserDetails: { id: 'u', firstName: 'Moe', lastName: 'Sefati' } })), 'Moe Sefati')
eq('assignee: unassigned → null', taskAssignee(raw({ assignedToUserDetails: null })), null)

// ── contact name ─────────────────────────────────────────────────────────────
eq('contact: lowercase GHL names get title-cased', taskContactName(raw()), 'John Betterman')
eq('contact: missing → null', taskContactName(raw({ contactDetails: null })), null)

// ── mapping ──────────────────────────────────────────────────────────────────
const row = mapGhlTask(raw(), LOC, dealFor)!
eq('map: id', row.ghl_task_id, 'VXI5uNatt07U0rmIbS8u')
eq('map: location', row.location_id, LOC)
eq('map: deal resolved from the contact', row.deal_id, 'deal-1')
eq('map: unmatched contact → null deal', mapGhlTask(raw({ contactId: 'nope' }), LOC, dealFor)!.deal_id, null)
eq('map: due carried through', row.due_at, '2027-06-16T15:00:00.000Z')
eq('map: status from statusGroup', row.status, 'to_do')
eq('map: assigned user id kept', row.assigned_user_id, 'SVXQeoFxrP8ZoFd11nyF')
eq('map: completed rows are NOT mirrored', mapGhlTask(raw({ completed: true }), LOC, dealFor), null)
eq('map: deleted rows are NOT mirrored', mapGhlTask(raw({ deleted: true }), LOC, dealFor), null)
eq('map: missing id → null', mapGhlTask(raw({ _id: '' }), LOC, dealFor), null)
// ⚠️ Deleting a task in GHL leaves it in the task search index with deleted:false,
// completed:false and its contactId STRIPPED. Mirroring that tombstone puts a row on
// the board that can be neither completed nor deleted (both endpoints are addressed
// through /contacts/{id}/tasks/…). Hit for real 2026-08-04.
eq('map: a deleted-task TOMBSTONE (no contactId) is NOT mirrored',
  mapGhlTask(raw({ contactId: null, contactDetails: { firstName: null, lastName: null } }), LOC, dealFor), null)
eq('map: blank title gets a placeholder', mapGhlTask(raw({ title: '   ' }), LOC, dealFor)!.title, 'Untitled GHL task')
eq('map: falls back to the sweep location when the row omits it',
  mapGhlTask(raw({ locationId: null }), LOC, dealFor)!.location_id, LOC)

// ── board adapter ────────────────────────────────────────────────────────────
const board = toBoardTask({ ...row, created_at: '2026-06-16T15:22:01.789Z' })
eq('board: id is namespaced', board.id, GHL_TASK_PREFIX + 'VXI5uNatt07U0rmIbS8u')
eq('board: never looks completed (only open tasks are stored)', board.completed_at, null)
eq('board: assignee drives the column', board.assignee, 'Brianne Han')
eq('board: due maps to due_at', board.due_at, '2027-06-16T15:00:00.000Z')
eq('board: keeps the contact + location needed to write back', [board.ghl_contact_id, board.ghl_location_id],
  ['oz9XkKwbXSdK8nFe50hD', LOC])
eq('board: description stays empty (search rows carry no body)', board.description, null)
eq('board: tagged as a GHL row', isGhlTask(board), true)
eq('board: a plain deal_task is not', isGhlTask({
  id: 'e7a1', deal_id: null, title: 'x', description: null, due_at: null, assignee: null,
  assigned_by: null, priority: null, completed_at: null, created_at: '2026-01-01T00:00:00Z',
}), false)

console.log(`\n${fail === 0 ? '✅' : '❌'} ghl-tasks-check: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
