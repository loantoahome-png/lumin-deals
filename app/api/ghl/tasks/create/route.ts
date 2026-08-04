import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { GHL_BASE, ghlHeaders, resolveApiKey } from '@/lib/ghl'
import { resolveLO } from '@/lib/loanOfficer'

// Create a task IN GoHighLevel from the dashboard.
//   POST /api/ghl/tasks/create  { dealId, title, dueDate, assignee, body? }
//
// The task hangs on the deal's GHL CONTACT (GHL has no concept of a task on an
// opportunity), and the sub-account is the deal's own location — Efrain's and
// Matt's have separate keys and separate user lists.
//
// ⚠️ GHL REQUIRES dueDate: posting without one returns 422 "dueDate should not
// be empty". Unlike deal_tasks, a GHL task cannot be undated — the form makes
// the date required rather than letting the user discover that as an error.
//
// On success the mirror row is inserted right away so the board shows it
// without waiting for the next 15-min sweep.

type Body = { dealId?: string; title?: string; dueDate?: string; assignee?: string; body?: string }

/** GHL user whose name matches the board assignee, within THIS location. */
async function findUserId(locationId: string, apiKey: string, assignee: string): Promise<{ id?: string; available: string[] }> {
  const res = await fetch(`${GHL_BASE}/users/?locationId=${locationId}`, { headers: ghlHeaders(apiKey) })
  if (!res.ok) throw new Error(`users ${res.status}: ${(await res.text()).slice(0, 160)}`)
  const users = ((await res.json()) as { users?: { id: string; name?: string; firstName?: string; lastName?: string }[] }).users ?? []
  const named = users.map(u => ({
    id: u.id,
    raw: (u.name ?? `${u.firstName ?? ''} ${u.lastName ?? ''}`).trim(),
  }))
  // resolveLO folds GHL's "Matthew Park" onto the board's "Matt Park".
  const hit = named.find(u => resolveLO(u.raw) === assignee || u.raw === assignee)
  return { id: hit?.id, available: named.map(u => u.raw) }
}

export async function POST(req: NextRequest) {
  let b: Body
  try {
    b = await req.json() as Body
  } catch {
    return NextResponse.json({ ok: false, error: 'bad request' }, { status: 400 })
  }
  const title = (b.title ?? '').trim()
  const dueDate = (b.dueDate ?? '').trim()
  const assignee = (b.assignee ?? '').trim()
  if (!b.dealId || !title || !dueDate || !assignee) {
    return NextResponse.json({ ok: false, error: 'dealId, title, dueDate and assignee are all required' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { data: deal, error } = await supabase
    .from('deals').select('id, name, ghl_contact_id, ghl_location_id')
    .eq('id', b.dealId).maybeSingle()
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  if (!deal) return NextResponse.json({ ok: false, error: 'deal not found' }, { status: 404 })

  const d = deal as { id: string; name: string | null; ghl_contact_id: string | null; ghl_location_id: string | null }
  if (!d.ghl_contact_id) {
    return NextResponse.json({ ok: false, error: 'that deal has no GHL contact to hang a task on' }, { status: 400 })
  }
  const locationId = d.ghl_location_id
  const apiKey = locationId ? resolveApiKey(locationId) : null
  if (!locationId || !apiKey) {
    return NextResponse.json({ ok: false, error: `no GHL key for location ${locationId ?? 'unknown'}` }, { status: 400 })
  }

  let assignedTo: string
  try {
    const { id, available } = await findUserId(locationId, apiKey, assignee)
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

  let created: { id: string; dueDate?: string | null }
  try {
    const res = await fetch(`${GHL_BASE}/contacts/${d.ghl_contact_id}/tasks`, {
      method: 'POST',
      headers: ghlHeaders(apiKey),
      body: JSON.stringify({
        title,
        ...(b.body?.trim() ? { body: b.body.trim() } : {}),
        dueDate,
        completed: false,
        assignedTo,
      }),
    })
    if (!res.ok) throw new Error(`GHL ${res.status}: ${(await res.text()).slice(0, 240)}`)
    created = ((await res.json()) as { task: { id: string; dueDate?: string | null } }).task
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[GHL create task] failed:', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 502 })
  }

  // Mirror it immediately. contact_name is our deal name for now; the next
  // sweep replaces it with GHL's own contactDetails.
  const nowIso = new Date().toISOString()
  const row = {
    ghl_task_id: created.id,
    location_id: locationId,
    contact_id: d.ghl_contact_id,
    deal_id: d.id,
    contact_name: d.name,
    title,
    assignee,
    assigned_user_id: assignedTo,
    due_at: created.dueDate ?? dueDate,
    status: 'to_do',
    ghl_created_at: nowIso,
    ghl_updated_at: nowIso,
    last_seen_at: nowIso,
    updated_at: nowIso,
  }
  const { error: insErr } = await supabase.from('ghl_tasks').upsert(row, { onConflict: 'ghl_task_id' })
  if (insErr) console.warn('[GHL create task] mirror insert failed (sweep will pick it up):', insErr.message)

  console.log(`[GHL create task] ${created.id} for ${assignee} on ${d.name}`)
  return NextResponse.json({ ok: true, task: row })
}
