import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { notifyTaskEmail } from '@/app/api/tasks/notify/route'

// 45-minute 2nd-call-back rule:
//   When a lead is ~45 min old AND still sitting in "New Lead" or "Attempted
//   Contact", auto-create a task for Brianne to do a 2nd call-back. If the lead
//   has already advanced past those stages, no task is created.
//
// Dedup: each deal gets the task at most once, tracked via deals.second_callback_at.
// Requires (run once):
//   ALTER TABLE deals ADD COLUMN IF NOT EXISTS second_callback_at timestamptz;
export const maxDuration = 60

const TRIGGER_STAGES = ['New Lead', 'Attempted Contact']
const MIN_AGE_MIN = 45
const MAX_AGE_MIN = 360   // safety cap — never backfill leads older than 6h

type Row = {
  id: string
  name: string | null
  created_at: string
  date_added_ghl: string | null
  loan_officer: string | null
  deal_id?: string
}

export async function runSecondCallbackCheck(): Promise<{ scanned: number; created: number; errors: number }> {
  const supabase = createServiceClient()
  const now = Date.now()
  const sixHoursAgoIso = new Date(now - MAX_AGE_MIN * 60_000).toISOString()

  // Candidates: still in a trigger stage, not yet handled, row created within 6h.
  const { data } = await supabase
    .from('deals')
    .select('id,name,created_at,date_added_ghl,loan_officer')
    .in('status', TRIGGER_STAGES)
    .is('second_callback_at', null)
    .gte('created_at', sixHoursAgoIso)

  const rows = (data ?? []) as Row[]
  let created = 0, errors = 0

  for (const d of rows) {
    // Use the GHL creation time when available, else the DB row time.
    const eff = d.date_added_ghl ? Date.parse(d.date_added_ghl) : Date.parse(d.created_at)
    if (isNaN(eff)) continue
    const ageMin = (now - eff) / 60_000
    if (ageMin < MIN_AGE_MIN || ageMin > MAX_AGE_MIN) continue

    // Create the task for Brianne
    const { error: taskErr } = await supabase.from('deal_tasks').insert({
      deal_id: d.id,
      title: `2nd call-back — ${d.name ?? 'lead'}`,
      description: 'Auto-created: lead is still in New Lead / Attempted Contact ~45 min after coming in. Give them a 2nd call-back.',
      assignee: 'Brianne Han',
      assigned_by: 'Auto (45-min rule)',
      priority: 'high',
      due_at: new Date().toISOString(),
      completed_at: null,
    })
    if (taskErr) { console.error('[2nd callback] task insert failed:', taskErr.message); errors++; continue }

    // Mark the deal so we never create a duplicate.
    await supabase.from('deals').update({ second_callback_at: new Date().toISOString() }).eq('id', d.id)
    created++

    // Best-effort: email Brianne the "new task assigned" alert. Called
    // in-process (not over HTTP) so the auth middleware never blocks it.
    try {
      await notifyTaskEmail('assigned', {
        title: `2nd call-back — ${d.name ?? 'lead'}`,
        description: 'Lead still in New Lead / Attempted Contact ~45 min after coming in. Give them a 2nd call-back.',
        due_at: new Date().toISOString(),
        assignee: 'Brianne Han',
        assigned_by: 'Auto (45-min rule)',
        deal_id: d.id,
      })
    } catch { /* non-fatal */ }
  }

  return { scanned: rows.length, created, errors }
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const result = await runSecondCallbackCheck()
    console.log(`[2nd callback] scanned ${result.scanned}, created ${result.created}, errors ${result.errors}`)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    console.error('[2nd callback] failed:', err)
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
