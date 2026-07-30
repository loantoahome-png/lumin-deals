import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { createFubTask, mapFubTask, FUB_USER_TO_LO } from '@/lib/followUpBoss'

// Create a FollowUpBoss task from the dashboard.
// POST /api/fub/tasks/create  { personId, name, type?, dueDate? }
//
// The task is created against the FUB person's OWN assigned user, using that
// user's key — tasks are per-key in FUB, and a task must belong to the LO who
// owns the person or it won't appear in their FUB list at all.
//
// The person must already exist in fub_people (i.e. be one of the LOs' own,
// post pull-filter), so an arbitrary personId can't be used to write into the
// shared FUB account.
//
// Auth: middleware gates every /api route except the explicit public list.

const ALLOWED_TYPES = ['Follow Up', 'Call', 'Email', 'Text', 'Appointment', 'Showing', 'Closing', 'Thank You']

export async function POST(req: NextRequest) {
  let body: { personId?: number | string; name?: string; type?: string; dueDate?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 })
  }

  const personId = Number(body.personId)
  const name = (body.name ?? '').trim()
  const type = body.type && ALLOWED_TYPES.includes(body.type) ? body.type : 'Follow Up'
  const dueDate = body.dueDate?.slice(0, 10) || null
  if (!Number.isFinite(personId)) return NextResponse.json({ ok: false, error: 'personId required' }, { status: 400 })
  if (!name) return NextResponse.json({ ok: false, error: 'task text required' }, { status: 400 })
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    return NextResponse.json({ ok: false, error: 'dueDate must be YYYY-MM-DD' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { data: person, error } = await supabase
    .from('fub_people')
    .select('fub_id, name, assigned_user_id, loan_officer')
    .eq('fub_id', personId)
    .maybeSingle()
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  if (!person) return NextResponse.json({ ok: false, error: 'person not found' }, { status: 404 })

  const assigned = (person as { assigned_user_id: number | null }).assigned_user_id
  const apiKey = assigned === 72 ? process.env.FUB_API_KEY_MOE
    : assigned === 13 ? process.env.FUB_API_KEY_MATT
    : null
  if (!apiKey || assigned == null) {
    return NextResponse.json({ ok: false, error: `no FUB key for assigned user ${assigned}` }, { status: 400 })
  }

  try {
    const created = await createFubTask(apiKey, { personId, name, type, dueDate, assignedUserId: assigned })
    const row = { ...mapFubTask(created), loan_officer: FUB_USER_TO_LO[assigned] ?? null }
    // Store it now so the page shows it without waiting for the hourly sweep.
    const nowIso = new Date().toISOString()
    const { error: insErr } = await supabase.from('fub_tasks')
      .upsert({ ...row, last_seen_at: nowIso, updated_at: nowIso }, { onConflict: 'fub_task_id' })
    if (insErr) console.warn('[FUB create] local insert failed (sweep will pick it up):', insErr.message)
    console.log(`[FUB create] task ${row.fub_task_id} for ${(person as { name: string | null }).name} (${row.loan_officer})`)
    return NextResponse.json({ ok: true, task: row })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[FUB create] failed:', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 502 })
  }
}
