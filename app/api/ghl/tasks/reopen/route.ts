import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { GHL_BASE, ghlHeaders, resolveApiKey, getAccounts } from '@/lib/ghl'
import { fetchTasks, buildContactDealMap } from '@/lib/ghlTaskSync'
import { mapGhlTask, type GhlTaskRow } from '@/lib/ghlTasks'

// Un-complete a GoHighLevel task — the undo for a mis-click.
//   POST /api/ghl/tasks/reopen  { taskId: string }
//
// GHL endpoint (probed live on throwaway tasks 2026-08-04):
//   PUT /contacts/{contactId}/tasks/{taskId}/completed  { completed: false } → 200
// The generic task update (PUT /contacts/{cid}/tasks/{id}) also works, with or
// without the other fields, and preserves title + dueDate. This route uses the
// dedicated endpoint because it's the exact inverse of the complete route.
//
// ⚠️ VERIFY WITH THE SINGLE-TASK GET, NOT THE SEARCH INDEX. tasks/search is
// eventually consistent — a just-created task showed up in NEITHER the open nor
// the completed bucket, and a reopened one still read `completed:true` for a
// beat. Trusting the index made a working call look broken on the first probe.
//
// Unlike complete/delete, there is no local row to read: `ghl_tasks` holds OPEN
// tasks only, so a completed task is not in our table. We resolve the contact +
// sub-account by finding the task in GHL's own completed list, which also keeps
// the complete-route rule that the client never picks the id we act on.
//
// Auth: middleware gates every /api route except the explicit public list.

export async function POST(req: NextRequest) {
  let taskId: string
  try {
    const body = await req.json() as { taskId?: string }
    taskId = String(body.taskId ?? '').trim()
    if (!taskId) throw new Error('taskId is required')
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'bad request' }, { status: 400 })
  }

  // Find it among GHL's completed tasks — that's what proves it exists, tells us
  // which sub-account owns it, and gives us the contact both the write and the
  // re-mirror need.
  let found: { raw: Awaited<ReturnType<typeof fetchTasks>>[number]; locationId: string } | null = null
  for (const account of getAccounts()) {
    try {
      const hit = (await fetchTasks(account, true)).find(t => t._id === taskId)
      if (hit) { found = { raw: hit, locationId: hit.locationId || account.locationId }; break }
    } catch (e) {
      console.warn(`[GHL reopen] ${account.label} search failed:`, String(e))
    }
  }
  if (!found) {
    return NextResponse.json({ ok: false, error: 'task not found among completed GHL tasks' }, { status: 404 })
  }
  const contactId = found.raw.contactId
  if (!contactId) {
    // A tombstone — see mapGhlTask. Nothing to reopen; it has no parent.
    return NextResponse.json({ ok: false, error: 'task has no contact — cannot reopen via GHL' }, { status: 400 })
  }
  const apiKey = resolveApiKey(found.locationId)
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: `no GHL key for location ${found.locationId}` }, { status: 400 })
  }

  try {
    const res = await fetch(`${GHL_BASE}/contacts/${contactId}/tasks/${taskId}/completed`, {
      method: 'PUT',
      headers: ghlHeaders(apiKey),
      body: JSON.stringify({ completed: false }),
    })
    if (!res.ok) throw new Error(`GHL ${res.status}: ${(await res.text()).slice(0, 200)}`)

    // Confirm against the single-task GET. A 200 here is not proof on its own —
    // see the ⚠️ above.
    const check = await fetch(`${GHL_BASE}/contacts/${contactId}/tasks/${taskId}`, { headers: ghlHeaders(apiKey) })
    if (check.ok) {
      const body = await check.json() as { task?: { completed?: boolean }; completed?: boolean }
      const stillDone = (body.task?.completed ?? body.completed) === true
      if (stillDone) throw new Error('GHL accepted the call but the task is still completed')
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[GHL reopen] failed:', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 502 })
  }

  // Put it back in the mirror now rather than waiting up to 15 min for the sweep,
  // so the board matches GHL the moment the click lands.
  const supabase = createServiceClient()
  let row: GhlTaskRow | null = null
  try {
    const dealMap = await buildContactDealMap(supabase)
    row = mapGhlTask({ ...found.raw, completed: false }, found.locationId, id => (id && dealMap.get(id)) || null)
    if (row) {
      const nowIso = new Date().toISOString()
      const { error } = await supabase.from('ghl_tasks')
        .upsert({ ...row, last_seen_at: nowIso, updated_at: nowIso }, { onConflict: 'ghl_task_id' })
      if (error) throw new Error(error.message)
    }
  } catch (e) {
    // The reopen itself succeeded — GHL is the record. A failed re-mirror costs
    // one sweep of latency, not correctness, so don't report it as a failure.
    console.warn('[GHL reopen] re-mirror failed (sweep will pick it up):', String(e))
  }

  console.log(`[GHL reopen] task ${taskId} reopened`)
  return NextResponse.json({ ok: true, taskId, task: row })
}
