// Fixtures for lib/ghlTasks.ts — the pure half of the GHL task mirror.
// Run: npx tsx scripts/ghl-tasks-check.ts
//
// Payload shapes are copied from a real POST /locations/{id}/tasks/search
// response captured 2026-08-03, not invented.

import {
  mapGhlTask, toBoardTask, isGhlTask, taskAssignee, taskContactName,
  mapCompletedGhlTask, toCompletedBoardTask, isTaskGoneResponse,
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
// ⚠️ This used to assert `description === null` "because search rows carry no
// body". That premise was false — see the body block below.
eq('board: no body set → no description', board.description, null)
eq('board: tagged as a GHL row', isGhlTask(board), true)
eq('board: a plain deal_task is not', isGhlTask({
  id: 'e7a1', deal_id: null, title: 'x', description: null, due_at: null, assignee: null,
  assigned_by: null, priority: null, completed_at: null, created_at: '2026-01-01T00:00:00Z',
}), false)

// ── completed tasks (the live "recently completed" view) ─────────────────────
// The mirror stores open tasks only, so these never come from ghl_tasks — they
// are read straight from GHL. mapCompletedGhlTask is the exact inverse of
// mapGhlTask on the completed flag, and identical on every other gate.
const doneRaw = raw({ completed: true, dateUpdated: '2026-08-04T18:41:29.000Z' })
const done = mapCompletedGhlTask(doneRaw, LOC, dealFor)!
eq('completed: an OPEN task is not completed history', mapCompletedGhlTask(raw(), LOC, dealFor), null)
eq('completed: a completed task maps', done.ghl_task_id, 'VXI5uNatt07U0rmIbS8u')
// ⚠️ dateUpdated is LAST MODIFIED, not a completion stamp — GHL exposes no
// completedAt on the search row. The UI labels it as such rather than claiming more.
eq('completed: completed_at comes from dateUpdated', done.completed_at, '2026-08-04T18:41:29.000Z')
eq('completed: deal still resolves from the contact', done.deal_id, 'deal-1')
eq('completed: assignee still folds to the board name',
  mapCompletedGhlTask(raw({ completed: true, assignedToUserDetails: { id: 'u', firstName: 'Matthew', lastName: 'Park' } }), LOC, dealFor)!.assignee,
  'Matt Park')
eq('completed: deleted rows are still rejected', mapCompletedGhlTask(raw({ completed: true, deleted: true }), LOC, dealFor), null)
eq('completed: a TOMBSTONE (no contactId) is still rejected',
  mapCompletedGhlTask(raw({ completed: true, contactId: null }), LOC, dealFor), null)
eq('completed: missing id → null', mapCompletedGhlTask(raw({ completed: true, _id: '' }), LOC, dealFor), null)
eq('completed: no dateUpdated → null stamp, not a crash',
  mapCompletedGhlTask(raw({ completed: true, dateUpdated: null }), LOC, dealFor)!.completed_at, null)

const doneBoard = toCompletedBoardTask(done)
eq('completed board: carries completed_at (drives the chip + strikethrough)',
  doneBoard.completed_at, '2026-08-04T18:41:29.000Z')
eq('completed board: id is namespaced like any GHL row',
  doneBoard.id, GHL_TASK_PREFIX + 'VXI5uNatt07U0rmIbS8u')
eq('completed board: still tagged as a GHL row', isGhlTask(doneBoard), true)
// ⚠️ These ids are what makes "Clear completed" dangerous: it deletes by
// deal_tasks.id (a uuid). A `ghl:` id in that list fails the cast and aborts the
// whole delete — /tasks reads dealTasks there, never the merged board.
eq('completed board: id is NOT a uuid, so it must never reach a deal_tasks delete',
  /^[0-9a-f-]{36}$/.test(doneBoard.id), false)
eq('completed board: keeps the contact + location needed to link back to GHL',
  [doneBoard.ghl_contact_id, doneBoard.ghl_location_id], ['oz9XkKwbXSdK8nFe50hD', LOC])

// ── reopen (un-complete) ─────────────────────────────────────────────────────
// The reopen route re-mirrors the task by handing the SAME completed search row
// back to mapGhlTask with the flag flipped, so the row that lands in ghl_tasks
// must be identical to the one the open sweep would have produced.
const reopened = mapGhlTask({ ...doneRaw, completed: false }, LOC, dealFor)!
eq('reopen: re-mirrors to a normal open row', [reopened.ghl_task_id, reopened.contact_id, reopened.deal_id],
  ['VXI5uNatt07U0rmIbS8u', 'oz9XkKwbXSdK8nFe50hD', 'deal-1'])
// Identical to the open sweep's row EXCEPT ghl_updated_at, which correctly
// carries GHL's newer dateUpdated (the completion bumped it).
const omitStamp = (r: object | null) => { const { ghl_updated_at: _, ...rest } = r as Record<string, unknown>; return rest }
eq('reopen: otherwise identical to what the open sweep would store',
  omitStamp(reopened), omitStamp(mapGhlTask(raw(), LOC, dealFor)))
eq('reopen: keeps GHL\'s newer updated stamp', reopened.ghl_updated_at, '2026-08-04T18:41:29.000Z')
// A tombstone has no contact, so there is nothing to address the write to — the
// route rejects it before calling GHL, and the mapper agrees.
eq('reopen: a tombstone still cannot be re-mirrored',
  mapGhlTask({ ...doneRaw, completed: false, contactId: null }, LOC, dealFor), null)

// ── task descriptions (`body`) ───────────────────────────────────────────────
// The mirror shipped without descriptions because the search row was believed to
// carry none. Re-probed live 2026-08-05 across BOTH locations: 105 rows, `body`
// non-empty on 10, HTML on 8, only <p> tags, 18-200 chars. The shapes below are
// copied from that response, not invented.
eq('body: stored RAW so the table mirrors GHL',
  mapGhlTask(raw({ body: '<p>Call after 5pm</p>' }), LOC, dealFor)!.body, '<p>Call after 5pm</p>')
eq('body: absent → null, never an empty string', mapGhlTask(raw(), LOC, dealFor)!.body, null)
eq('body: whitespace-only is null, not a blank description line',
  mapGhlTask(raw({ body: '   ' }), LOC, dealFor)!.body, null)

const withBody = (b: string) => toBoardTask({ ...mapGhlTask(raw({ body: b }), LOC, dealFor)!, created_at: null })
eq('body: the board gets plain text, not markup',
  withBody('<p>Call after 5pm</p>').description, 'Call after 5pm')
eq('body: multiple paragraphs become newlines (whitespace-pre-wrap renders them)',
  withBody('<p>Called, no answer</p><p>Try mobile</p>').description, 'Called, no answer\nTry mobile')
eq('body: <br> is a line break too', withBody('a<br>b').description, 'a\nb')
eq('body: plain text (2 of 10 live rows) passes through untouched',
  withBody('needs updated paystubs').description, 'needs updated paystubs')
eq('body: entities are decoded', withBody('<p>Docs &amp; conditions</p>').description, 'Docs & conditions')
eq('body: &nbsp; becomes a real space', withBody('<p>a&nbsp;b</p>').description, 'a b')
eq('body: numeric entities decode', withBody('<p>fee &#39;as is&#39;</p>').description, "fee 'as is'")
eq('body: list items keep their shape',
  withBody('<ul><li>W2s</li><li>Bank stmts</li></ul>').description, '• W2s\n• Bank stmts')
eq('body: runs of blank lines collapse', withBody('<p>a</p><p></p><p></p><p>b</p>').description, 'a\n\nb')
// ⚠️ THE ORDER PROPERTY. Tags are stripped BEFORE entities are decoded. Decode
// first and this input becomes real `<script>` syntax after the strip pass has
// already run — the escaped text must survive as literal, visible characters.
eq('body: an escaped tag stays literal text and is never re-formed into markup',
  withBody('<p>use &lt;script&gt; carefully</p>').description, 'use <script> carefully')
eq('body: a real script tag is stripped entirely',
  withBody('<p>ok</p><script>alert(1)</script>').description, 'ok')
eq('body: an empty body yields null, not "" (falsy check in the row render)',
  withBody('<p></p>').description, null)
eq('body: completed rows carry their description too',
  toCompletedBoardTask(mapCompletedGhlTask(
    { ...doneRaw, body: '<p>Left voicemail</p>' }, LOC, dealFor)!).description, 'Left voicemail')

// ── isTaskGoneResponse — "did the delete land?" ─────────────────────────────
// ⚠️ GHL answers a DELETED task with 400 "The task id is invalid.", not 404.
// Real bodies, captured 2026-08-05 while clearing the orphaned ZZ TEST tasks.
const INVALID = '{"message":"The task id is invalid.","error":"Bad Request","statusCode":400}'

eq('gone: 404 is gone', isTaskGoneResponse(404, ''), true)
eq('⚠️ gone: 400 "task id is invalid" is ALSO gone (a working delete, not a failure)',
  isTaskGoneResponse(400, INVALID), true)
eq('gone: matching is case-insensitive', isTaskGoneResponse(400, 'The Task Id Is Invalid.'), true)
eq('gone: 200 (task still readable) is NOT gone',
  isTaskGoneResponse(200, '{"task":{"id":"abc","title":"Follow up"}}'), false)
eq('gone: a DIFFERENT 400 is not gone — never swallow a real bad request',
  isTaskGoneResponse(400, '{"message":["isLocation should not be empty"],"statusCode":400}'), false)
eq('gone: 401 is not gone (bad key must surface, not read as success)',
  isTaskGoneResponse(401, '{"message":"Invalid JWT"}'), false)
eq('gone: 403 is not gone', isTaskGoneResponse(403, 'forbidden'), false)
eq('gone: 500 is not gone — a flaky upstream must not look like a delete',
  isTaskGoneResponse(500, 'internal error'), false)
eq('gone: empty 400 body is not gone', isTaskGoneResponse(400, ''), false)

console.log(`\n${fail === 0 ? '✅' : '❌'} ghl-tasks-check: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
