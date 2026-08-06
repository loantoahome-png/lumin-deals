import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { GHL_BASE, ghlHeaders, resolveApiKey } from '@/lib/ghl'
import { isTaskGoneResponse } from '@/lib/ghlTasks'

// Delete a GoHighLevel task from the dashboard.
//   POST /api/ghl/tasks/delete  { taskId: string }
//
// Same key-selection rule as the complete route: the sub-account comes from OUR
// stored row, never the client.
//
// GHL: DELETE /locations/{locationId}/tasks/{taskId} → 200 {"succeded":true}
// (their typo, not ours).
//
// ⚠️ The LOCATION-scoped endpoint is used deliberately, not the contact-scoped
//    one. It works whether or not the task still has a contact, and it was
//    verified against a contact-bearing task too — so there is one path here,
//    not two. The old code deleted via /contacts/{contactId}/tasks/{taskId}
//    and, when `contact_id` was null, gave up: it dropped the mirror row and
//    returned ok. That silently abandoned a LIVE task in GHL every time it
//    fired, which is how 12 orphaned tasks accumulated in Efrain's task list
//    unnoticed. A contact-less search row is NOT a deleted tombstone — the row
//    carries `"deleted": false`. See GOTCHAS.md 2026-08-05.
//
// ⚠️ Deleting does NOT immediately evict the task from GHL's search index, and
//    the index is eventually consistent. `mapGhlTask` drops contact-less rows,
//    and this route deletes the mirror row too so the board updates at once.

export async function POST(req: NextRequest) {
  let taskId: string
  try {
    const body = await req.json() as { taskId?: string }
    taskId = String(body.taskId ?? '').trim()
    if (!taskId) throw new Error('taskId is required')
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'bad request' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { data: task, error } = await supabase
    .from('ghl_tasks')
    .select('ghl_task_id, location_id, contact_id, title, assignee')
    .eq('ghl_task_id', taskId)
    .maybeSingle()
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  if (!task) return NextResponse.json({ ok: false, error: 'task not found' }, { status: 404 })

  const row = task as { location_id: string; contact_id: string | null; title: string | null; assignee: string | null }
  const apiKey = resolveApiKey(row.location_id)
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: `no GHL key for location ${row.location_id}` }, { status: 400 })
  }

  let alreadyGone = false
  try {
    const res = await fetch(`${GHL_BASE}/locations/${row.location_id}/tasks/${taskId}`, {
      method: 'DELETE',
      headers: ghlHeaders(apiKey),
    })
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200)
      // A second delete (double-click, retry) is a no-op, not an error — GHL
      // says 400 "task id is invalid" once the task is already gone.
      if (!isTaskGoneResponse(res.status, body)) throw new Error(`GHL ${res.status}: ${body}`)
      alreadyGone = true
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[GHL delete] failed:', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 502 })
  }

  const { error: delErr } = await supabase.from('ghl_tasks').delete().eq('ghl_task_id', taskId)
  if (delErr) console.warn('[GHL delete] local delete failed (sweep will clear it):', delErr.message)

  console.log(`[GHL delete] task ${taskId} (${row.assignee ?? 'unassigned'})${alreadyGone ? ' was already gone' : ' deleted'}`)
  return NextResponse.json({ ok: true, taskId, ...(alreadyGone ? { note: 'was already gone in GHL' } : {}) })
}
