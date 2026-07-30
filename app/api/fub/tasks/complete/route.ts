import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { completeFubTask } from '@/lib/followUpBoss'

// Complete a FollowUpBoss task from the dashboard.
// POST /api/fub/tasks/complete  { taskId: number }
//
// The FUB key is chosen from the task's OWN assigned_user_id (72=Moe, 13=Matt):
// tasks are per-key in FUB, so Moe's key cannot write Matt's task. We read the
// stored row rather than trusting the client, which also stops a caller from
// completing an arbitrary id that isn't in our table.
//
// Auth: middleware gates every /api route except the explicit public list, so
// this is already behind the dashboard login.
//
// On success the row is DELETED locally — fub_tasks holds open tasks only, and
// deleting now keeps the page honest instead of waiting for the hourly sweep.

export async function POST(req: NextRequest) {
  let taskId: number
  try {
    const body = await req.json() as { taskId?: number | string }
    taskId = Number(body.taskId)
    if (!Number.isFinite(taskId)) throw new Error('taskId must be a number')
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'bad request' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { data: task, error } = await supabase
    .from('fub_tasks')
    .select('fub_task_id, assigned_user_id, loan_officer, name')
    .eq('fub_task_id', taskId)
    .maybeSingle()
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  if (!task) return NextResponse.json({ ok: false, error: 'task not found' }, { status: 404 })

  const assigned = (task as { assigned_user_id: number | null }).assigned_user_id
  const apiKey = assigned === 72 ? process.env.FUB_API_KEY_MOE
    : assigned === 13 ? process.env.FUB_API_KEY_MATT
    : null
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: `no FUB key for assigned user ${assigned}` }, { status: 400 })
  }

  try {
    await completeFubTask(apiKey, taskId)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[FUB complete] failed:', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 502 })
  }

  const { error: delErr } = await supabase.from('fub_tasks').delete().eq('fub_task_id', taskId)
  if (delErr) console.warn('[FUB complete] local delete failed (sweep will clear it):', delErr.message)

  console.log(`[FUB complete] task ${taskId} (${(task as { loan_officer: string | null }).loan_officer}) marked done`)
  return NextResponse.json({ ok: true, taskId })
}
