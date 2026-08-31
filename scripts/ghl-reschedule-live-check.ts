// LIVE end-to-end check for POST /api/ghl/tasks/reschedule (2026-08-31).
// Run: npx tsx scripts/ghl-reschedule-live-check.ts
//
// Proves the claim the route rests on: PUT /contacts/{cid}/tasks/{id} with a
// PARTIAL body of just { dueDate } moves the date and leaves TITLE and OWNER
// alone. Runs against a throwaway task it creates and then deletes, so no real
// task on anyone's board is ever touched.
//
// ⚠️ Verification reads the single-task GET, never tasks/search — that index is
// eventually consistent and reports the PREVIOUS state for a beat (GOTCHAS).
// ⚠️ A delete is proven by re-reading the task, not by the DELETE's own 200:
// GHL answers a deleted task with 400 "The task id is invalid.", not 404.
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { GHL_BASE, ghlHeaders } from '../lib/ghl'
import { fetchLocationUsers } from '../lib/ghlUsers'
import { normalizeDueDate, sameDueDate, isTaskGoneResponse } from '../lib/ghlTasks'

const env = readFileSync(`${process.cwd()}/.env.local`, 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''
const sb = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
})
const LOC = get('GHL_LOCATION_ID')
const KEY = get('GHL_API_KEY')

let pass = 0, fail = 0
const check = (label: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.error(`✗ ${label}${detail ? `\n   ${detail}` : ''}`) }
}

const getTask = async (cid: string, tid: string) => {
  const res = await fetch(`${GHL_BASE}/contacts/${cid}/tasks/${tid}`, { headers: ghlHeaders(KEY) })
  const text = await res.text()
  let body: { task?: Record<string, unknown> } & Record<string, unknown> = {}
  try { body = JSON.parse(text) } catch { /* non-JSON error body */ }
  return { status: res.status, text, task: (body.task ?? body) as Record<string, unknown> }
}

async function main() {
  if (!LOC || !KEY) throw new Error('GHL_LOCATION_ID / GHL_API_KEY missing from .env.local')

  // A real contact in the primary location — borrowed from an existing mirrored
  // task so we know it's a live contact this key can write to.
  const { data, error } = await sb.from('ghl_tasks')
    .select('contact_id, contact_name').eq('location_id', LOC).not('contact_id', 'is', null).limit(1)
  if (error) throw new Error(error.message)
  const contactId = (data?.[0] as { contact_id: string } | undefined)?.contact_id
  if (!contactId) throw new Error('no mirrored task in the primary location to borrow a contact from')

  // Assign to Efrain so a stray notification, if any, lands on his own desk.
  const users = await fetchLocationUsers(LOC, KEY)
  const me = users.find(u => u.board === 'Efrain Ramirez') ?? users[0]
  console.log(`contact ${contactId} · assignee ${me.raw} (${me.id})\n`)

  const ORIGINAL = normalizeDueDate('2027-03-04T17:00:00Z')!
  const MOVED = normalizeDueDate('2027-03-07T23:59:00Z')!
  const TITLE = 'ZZ TEST reschedule — safe to delete'

  const created = await fetch(`${GHL_BASE}/contacts/${contactId}/tasks`, {
    method: 'POST',
    headers: ghlHeaders(KEY),
    body: JSON.stringify({ title: TITLE, dueDate: ORIGINAL, completed: false, assignedTo: me.id }),
  })
  if (!created.ok) throw new Error(`create ${created.status}: ${(await created.text()).slice(0, 200)}`)
  const taskId = ((await created.json()) as { task: { id: string } }).task.id
  console.log(`created throwaway task ${taskId}`)

  try {
    const before = await getTask(contactId, taskId)
    check('seed: the task reads back with the date we set',
      sameDueDate(normalizeDueDate(before.task.dueDate as string), ORIGINAL),
      `got ${String(before.task.dueDate)}`)

    // ── the route's write, verbatim ──────────────────────────────────────────
    const put = await fetch(`${GHL_BASE}/contacts/${contactId}/tasks/${taskId}`, {
      method: 'PUT', headers: ghlHeaders(KEY), body: JSON.stringify({ dueDate: MOVED }),
    })
    check('PUT { dueDate } alone is accepted', put.ok, `HTTP ${put.status}`)

    const after = await getTask(contactId, taskId)
    const now = normalizeDueDate(after.task.dueDate as string)
    check('⚠️ the single-task GET confirms the NEW date (not the 200 alone)',
      sameDueDate(now, MOVED), `got ${String(after.task.dueDate)}, wanted ${MOVED}`)
    check('the date actually moved off the old one', !sameDueDate(now, ORIGINAL))

    // The whole reason this can be a date-only action rather than a full edit form.
    check('⚠️ the partial body left the TITLE untouched',
      after.task.title === TITLE, `got ${JSON.stringify(after.task.title)}`)
    check('⚠️ the partial body left the OWNER untouched',
      after.task.assignedTo === me.id, `got ${JSON.stringify(after.task.assignedTo)}`)
    check('the partial body left it OPEN (a reschedule is not a completion)',
      after.task.completed === false, `got ${JSON.stringify(after.task.completed)}`)
  } finally {
    const del = await fetch(`${GHL_BASE}/contacts/${contactId}/tasks/${taskId}`, {
      method: 'DELETE', headers: ghlHeaders(KEY),
    })
    const gone = await getTask(contactId, taskId)
    check('cleanup: the throwaway task is gone from the SOURCE, not just DELETE-200',
      isTaskGoneResponse(gone.status, gone.text), `DELETE ${del.status}, re-read ${gone.status} ${gone.text.slice(0, 120)}`)
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ghl-reschedule-live-check: ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
