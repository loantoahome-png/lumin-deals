import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { GHL_BASE, ghlHeaders, resolveApiKey } from '@/lib/ghl'
import { normalizeDueDate, sameDueDate } from '@/lib/ghlTasks'

// Move a mirrored GoHighLevel task's DUE DATE.
//   POST /api/ghl/tasks/reschedule  { taskId, dueDate }
//
// This is the action behind "push it out a few days" — the right move on a task
// that isn't done, where completing it would be a lie and would drop the row off
// the board entirely (the mirror keeps open tasks only).
//
// GHL endpoint (same partial-body update the reassign route uses, probed live
// 2026-08-05): PUT /contacts/{contactId}/tasks/{taskId}  { dueDate } → 200,
// leaving title, description and owner untouched.
//
// ⚠️ A GHL task CANNOT be undated — POST without a date is a 422 and an empty
// PUT value is the `{title:''}` trap (200, field blanked). `normalizeDueDate`
// refuses empty/unparseable input here rather than letting GHL interpret it.
//
// ⚠️ Verify with the single-task GET, never tasks/search — that index is
// eventually consistent and reports the PREVIOUS state for a beat, which is
// exactly how a working reopen was once misread as a no-op (see GOTCHAS).
//
// The mirror row is updated in place so the card re-buckets immediately
// (Overdue & today → Due this week) instead of waiting out the 15-min sweep.
//
// Auth: middleware gates every /api route except the explicit public list.

type Row = { ghl_task_id: string; location_id: string; contact_id: string | null; title: string | null; due_at: string | null }

export async function POST(req: NextRequest) {
  let taskId: string, dueDate: string
  try {
    const body = await req.json() as { taskId?: string; dueDate?: string }
    taskId = String(body.taskId ?? '').trim()
    const normalized = normalizeDueDate(body.dueDate)
    if (!taskId) throw new Error('taskId is required')
    // Refuse before calling GHL: it would either 422 or silently blank the date.
    if (!normalized) throw new Error('a valid due date is required — GHL tasks cannot be undated')
    dueDate = normalized
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'bad request' }, { status: 400 })
  }

  // Read OUR row rather than trusting the client — same rule as complete,
  // delete and reassign. It also stops a caller rescheduling a GHL task we
  // never mirrored (a completed row isn't in `ghl_tasks`, so it 404s here).
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('ghl_tasks')
    .select('ghl_task_id, location_id, contact_id, title, due_at')
    .eq('ghl_task_id', taskId)
    .maybeSingle()
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })

  const row = data as Row | null
  if (!row) return NextResponse.json({ ok: false, error: 'task not found' }, { status: 404 })
  if (!row.contact_id) {
    return NextResponse.json({ ok: false, error: 'task has no contact — cannot reschedule via GHL' }, { status: 400 })
  }
  const apiKey = resolveApiKey(row.location_id)
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: `no GHL key for location ${row.location_id}` }, { status: 400 })
  }

  let stored = dueDate
  try {
    const res = await fetch(`${GHL_BASE}/contacts/${row.contact_id}/tasks/${taskId}`, {
      method: 'PUT',
      headers: ghlHeaders(apiKey),
      body: JSON.stringify({ dueDate }),
    })
    if (!res.ok) throw new Error(`GHL ${res.status}: ${(await res.text()).slice(0, 200)}`)

    // Confirm against the single-task GET — a 200 alone is not proof.
    const check = await fetch(`${GHL_BASE}/contacts/${row.contact_id}/tasks/${taskId}`, { headers: ghlHeaders(apiKey) })
    if (check.ok) {
      const body = await check.json() as { task?: { dueDate?: string | null }; dueDate?: string | null }
      const now = normalizeDueDate(body.task?.dueDate ?? body.dueDate)
      // Only a date GHL actually returned can contradict us; a response that
      // carries no date at all is uninformative, not a failure.
      if (now && !sameDueDate(now, dueDate)) {
        throw new Error('GHL accepted the call but the task still has its old due date')
      }
      if (now) stored = now      // GHL's own normalisation wins in the mirror
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[GHL reschedule] failed:', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 502 })
  }

  const { error: updErr } = await supabase.from('ghl_tasks')
    .update({ due_at: stored, updated_at: new Date().toISOString() })
    .eq('ghl_task_id', taskId)
  if (updErr) console.warn('[GHL reschedule] mirror update failed (sweep will fix it):', updErr.message)

  console.log(`[GHL reschedule] task ${taskId} "${row.title}" ${row.due_at ?? 'undated'} → ${stored}`)
  return NextResponse.json({ ok: true, taskId, due_at: stored })
}
