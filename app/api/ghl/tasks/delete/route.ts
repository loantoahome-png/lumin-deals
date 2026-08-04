import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { GHL_BASE, ghlHeaders, resolveApiKey } from '@/lib/ghl'

// Delete a GoHighLevel task from the dashboard.
//   POST /api/ghl/tasks/delete  { taskId: string }
//
// Same key-selection rule as the complete route: the sub-account comes from OUR
// stored row, never the client. GHL: DELETE /contacts/{contactId}/tasks/{taskId}
// → {"succeeded":true}.
//
// ⚠️ Deleting in GHL does NOT evict the task from its search index — the row
// keeps coming back from tasks/search with its contactId stripped. mapGhlTask
// drops contact-less rows for exactly that reason; this route also deletes the
// mirror row so the board updates immediately.

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

  // A row with no contact can't be deleted in GHL (there's no URL for it), but
  // it also shouldn't be on the board — drop the mirror so it stops showing.
  if (!row.contact_id) {
    await supabase.from('ghl_tasks').delete().eq('ghl_task_id', taskId)
    return NextResponse.json({ ok: true, taskId, note: 'removed from the board (no GHL contact to delete against)' })
  }

  try {
    const res = await fetch(`${GHL_BASE}/contacts/${row.contact_id}/tasks/${taskId}`, {
      method: 'DELETE',
      headers: ghlHeaders(apiKey),
    })
    if (!res.ok) throw new Error(`GHL ${res.status}: ${(await res.text()).slice(0, 200)}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[GHL delete] failed:', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 502 })
  }

  const { error: delErr } = await supabase.from('ghl_tasks').delete().eq('ghl_task_id', taskId)
  if (delErr) console.warn('[GHL delete] local delete failed (sweep will clear it):', delErr.message)

  console.log(`[GHL delete] task ${taskId} (${row.assignee ?? 'unassigned'}) deleted`)
  return NextResponse.json({ ok: true, taskId })
}
