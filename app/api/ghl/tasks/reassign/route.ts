import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { GHL_BASE, ghlHeaders, resolveApiKey } from '@/lib/ghl'
import { fetchLocationUsers, findUserId } from '@/lib/ghlUsers'

// Reassign a mirrored GoHighLevel task to a different person.
//   GET  /api/ghl/tasks/reassign?taskId=…   → who this task CAN be assigned to
//   POST /api/ghl/tasks/reassign  { taskId, assignee }
//
// GHL endpoint (probed live on throwaway tasks 2026-08-04):
//   PUT /contacts/{contactId}/tasks/{taskId}  { assignedTo }  → 200
// The update takes a PARTIAL body — sending only assignedTo leaves title, due
// date and description untouched, which is why this can be a reassign-only
// action rather than a full edit form.
//
// ⚠️ Verify with the single-task GET, never the 200 or tasks/search — that
// index is eventually consistent and will report the old owner for a beat
// (see GOTCHAS).
//
// ⚠️ GHL users are PER-LOCATION, so the options come from the task's OWN
// sub-account. Randy is a user in neither configured location; asking for him
// fails with the real list rather than silently doing nothing.
//
// The mirror row is updated in place so the card moves columns immediately
// instead of waiting out the 15-min sweep.
//
// Auth: middleware gates every /api route except the explicit public list.

type Row = { ghl_task_id: string; location_id: string; contact_id: string | null; title: string | null; assignee: string | null }

async function loadTask(taskId: string) {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('ghl_tasks')
    .select('ghl_task_id, location_id, contact_id, title, assignee')
    .eq('ghl_task_id', taskId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return { supabase, row: (data as Row | null) }
}

/** The board names this task could be handed to, i.e. real users in ITS location. */
export async function GET(req: NextRequest) {
  const taskId = (req.nextUrl.searchParams.get('taskId') ?? '').trim()
  if (!taskId) return NextResponse.json({ ok: false, error: 'taskId is required' }, { status: 400 })

  try {
    const { row } = await loadTask(taskId)
    if (!row) return NextResponse.json({ ok: false, error: 'task not found' }, { status: 404 })
    const apiKey = resolveApiKey(row.location_id)
    if (!apiKey) return NextResponse.json({ ok: false, error: `no GHL key for location ${row.location_id}` }, { status: 400 })

    const users = await fetchLocationUsers(row.location_id, apiKey)
    // Board names, de-duped and sorted — the picker shows these verbatim.
    const assignees = [...new Set(users.map(u => u.board))].sort()
    return NextResponse.json({ ok: true, assignees, current: row.assignee })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[GHL reassign] options failed:', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 502 })
  }
}

export async function POST(req: NextRequest) {
  let taskId: string, assignee: string
  try {
    const body = await req.json() as { taskId?: string; assignee?: string }
    taskId = String(body.taskId ?? '').trim()
    assignee = String(body.assignee ?? '').trim()
    if (!taskId || !assignee) throw new Error('taskId and assignee are both required')
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'bad request' }, { status: 400 })
  }

  let supabase: ReturnType<typeof createServiceClient>, row: Row | null
  try {
    ({ supabase, row } = await loadTask(taskId))
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
  // Read OUR row rather than trusting the client, same as complete/delete —
  // it also stops a caller reassigning a GHL task we never mirrored.
  if (!row) return NextResponse.json({ ok: false, error: 'task not found' }, { status: 404 })
  if (!row.contact_id) {
    return NextResponse.json({ ok: false, error: 'task has no contact — cannot reassign via GHL' }, { status: 400 })
  }
  const apiKey = resolveApiKey(row.location_id)
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: `no GHL key for location ${row.location_id}` }, { status: 400 })
  }

  let assignedTo: string
  try {
    const { id, available } = await findUserId(row.location_id, apiKey, assignee)
    if (!id) {
      return NextResponse.json({
        ok: false,
        error: `${assignee} isn't a user in that GHL sub-account (it has: ${available.join(', ')})`,
      }, { status: 400 })
    }
    assignedTo = id
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }

  try {
    const res = await fetch(`${GHL_BASE}/contacts/${row.contact_id}/tasks/${taskId}`, {
      method: 'PUT',
      headers: ghlHeaders(apiKey),
      body: JSON.stringify({ assignedTo }),
    })
    if (!res.ok) throw new Error(`GHL ${res.status}: ${(await res.text()).slice(0, 200)}`)

    // Confirm against the single-task GET — a 200 alone is not proof.
    const check = await fetch(`${GHL_BASE}/contacts/${row.contact_id}/tasks/${taskId}`, { headers: ghlHeaders(apiKey) })
    if (check.ok) {
      const body = await check.json() as { task?: { assignedTo?: string }; assignedTo?: string }
      const nowOwner = body.task?.assignedTo ?? body.assignedTo
      if (nowOwner && nowOwner !== assignedTo) {
        throw new Error('GHL accepted the call but the task still belongs to someone else')
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[GHL reassign] failed:', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 502 })
  }

  const { error: updErr } = await supabase.from('ghl_tasks')
    .update({ assignee, assigned_user_id: assignedTo, updated_at: new Date().toISOString() })
    .eq('ghl_task_id', taskId)
  if (updErr) console.warn('[GHL reassign] mirror update failed (sweep will fix it):', updErr.message)

  console.log(`[GHL reassign] task ${taskId} "${row.title}" → ${assignee}`)
  return NextResponse.json({ ok: true, taskId, assignee, assigned_user_id: assignedTo })
}
