import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { GHL_BASE, ghlHeaders, resolveApiKey } from '@/lib/ghl'

// Complete a GoHighLevel task from the dashboard board (the two-way half of the
// GHL task mirror).
//   POST /api/ghl/tasks/complete  { taskId: string }
//
// The API key comes from the STORED row's location_id — Efrain's and Matt's
// sub-accounts have separate keys, and one cannot write the other's task. We
// read our own row rather than trusting the client, which also stops a caller
// from completing an arbitrary GHL task id that we never mirrored.
//
// GHL endpoint (verified live on a throwaway task 2026-08-03):
//   PUT /contacts/{contactId}/tasks/{taskId}/completed  { completed: true } → 200
//
// On success the row is DELETED locally — ghl_tasks holds OPEN tasks only, so
// deleting now keeps the board honest instead of waiting for the 15-min sweep.
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

  const supabase = createServiceClient()
  const { data: task, error } = await supabase
    .from('ghl_tasks')
    .select('ghl_task_id, location_id, contact_id, title, assignee')
    .eq('ghl_task_id', taskId)
    .maybeSingle()
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  if (!task) return NextResponse.json({ ok: false, error: 'task not found' }, { status: 404 })

  const row = task as { location_id: string; contact_id: string | null; title: string | null; assignee: string | null }
  if (!row.contact_id) {
    return NextResponse.json({ ok: false, error: 'task has no contact — cannot complete via GHL' }, { status: 400 })
  }
  const apiKey = resolveApiKey(row.location_id)
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: `no GHL key for location ${row.location_id}` }, { status: 400 })
  }

  try {
    const res = await fetch(`${GHL_BASE}/contacts/${row.contact_id}/tasks/${taskId}/completed`, {
      method: 'PUT',
      headers: ghlHeaders(apiKey),
      body: JSON.stringify({ completed: true }),
    })
    if (!res.ok) throw new Error(`GHL ${res.status}: ${(await res.text()).slice(0, 200)}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[GHL complete] failed:', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 502 })
  }

  const { error: delErr } = await supabase.from('ghl_tasks').delete().eq('ghl_task_id', taskId)
  if (delErr) console.warn('[GHL complete] local delete failed (sweep will clear it):', delErr.message)

  console.log(`[GHL complete] task ${taskId} (${row.assignee ?? 'unassigned'}) marked done`)
  return NextResponse.json({ ok: true, taskId })
}
