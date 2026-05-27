import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

// Task email notifications via Brevo.
//   event 'assigned'  → email the assignee: "You've been assigned a new task"
//   event 'completed' → email assignee + assigner: "Task completed"

type TaskPayload = {
  id?: string
  title?: string | null
  description?: string | null
  due_at?: string | null
  assignee?: string | null
  assigned_by?: string | null
  deal_id?: string | null
}

// ── Resolve a person's email from their assignee name ───────────────────────
// Primary: TASK_ASSIGNEE_EMAILS env (JSON: {"Matt Park":"...","Lexi - 3rd party":"..."}).
// Fallback: existing LO / admin env vars for Matt / Moe / Efrain.
function emailForName(name: string | null | undefined): string | null {
  if (!name) return null
  try {
    const map = JSON.parse(process.env.TASK_ASSIGNEE_EMAILS || '{}') as Record<string, string>
    if (map[name]) return map[name]
    // case-insensitive fallback within the JSON map
    const hit = Object.entries(map).find(([k]) => k.toLowerCase() === name.toLowerCase())
    if (hit) return hit[1]
  } catch { /* bad JSON — fall through */ }
  const n = name.toLowerCase()
  if (n.includes('matt') || n.includes('park'))   return process.env.LO_EMAIL_MATT || null
  if (n.includes('moe')  || n.includes('sefati')) return process.env.LO_EMAIL_MOE  || null
  if (n.includes('efrain'))                        return process.env.ADMIN_EMAIL_EFRAIN || null
  if (n.includes('brianne'))                       return process.env.PROCESSOR_EMAIL_BRIANNE || 'brianne.han@luminlending.com'
  return null
}

// All task times are entered/displayed in Pacific. The email renders on the
// server (UTC), so we must pin the timeZone or 9:00 AM PT prints as 4:00 PM.
const TASK_TZ = 'America/Los_Angeles'

// Tasks with a blank time are stored at 23:59 ("all day, no specific time").
function isAllDayTask(iso: string | null | undefined): boolean {
  if (!iso) return false
  const d = new Date(iso)
  if (isNaN(d.getTime())) return false
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TASK_TZ }) === '23:59'
}

function fmtDue(iso: string | null | undefined): string {
  if (!iso) return 'No due date'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return 'No due date'
  if (isAllDayTask(iso)) return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: TASK_TZ }) + ' (all day)'
  return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TASK_TZ })
}

async function sendBrevo(to: { email: string; name?: string }[], subject: string, html: string): Promise<boolean> {
  const apiKey = process.env.BREVO_API_KEY
  if (!apiKey || to.length === 0) return false
  const senderEmail = process.env.BREVO_SENDER_EMAIL || 'loantoahome@gmail.com'
  const senderName  = process.env.BREVO_SENDER_NAME  || 'Lumin Lending Tasks'
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ sender: { name: senderName, email: senderEmail }, to, subject, htmlContent: html }),
    })
    if (!res.ok) { console.error('[Task notify] Brevo error:', res.status, (await res.text()).slice(0, 200)); return false }
    return true
  } catch (e) { console.error('[Task notify] send failed:', e); return false }
}

// Header uses a SOLID background color (set via both the `bgcolor` attribute and
// inline `background-color`) — many email clients silently drop CSS
// `linear-gradient`, which previously left white text on a white background.
function shell(headerColor: string, subText: string, heading: string, body: string): string {
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;background:#f8fafc">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-radius:12px 12px 0 0;overflow:hidden">
        <tr>
          <td bgcolor="${headerColor}" style="background-color:${headerColor};padding:22px 26px">
            <h1 style="color:#ffffff;margin:0;font-size:19px;font-weight:700;line-height:1.3">${heading}</h1>
            <p style="color:#dbeafe;margin:6px 0 0;font-size:12px">${subText} — ${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',timeZone:TASK_TZ})}</p>
          </td>
        </tr>
      </table>
      <div style="background:#fff;padding:22px 26px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px">
        ${body}
        <p style="margin:18px 0 0;font-size:11px;color:#94a3b8">Lumin Lending Deal Dashboard</p>
      </div>
    </div>`
}

// Prominent deadline callout — only rendered when a due date is set.
function deadlineCallout(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const when = isAllDayTask(iso)
    ? d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: TASK_TZ }) + ' · All day'
    : d.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TASK_TZ })
  // Days until due (relative to today, date-only) — computed in Pacific so the
  // "due tomorrow"/"overdue" label matches the dashboard, not the UTC server.
  const pacificDay = (date: Date) => {
    const [m, day, y] = date.toLocaleDateString('en-US', { timeZone: TASK_TZ }).split('/')
    return Date.UTC(Number(y), Number(m) - 1, Number(day))
  }
  const days = Math.round((pacificDay(d) - pacificDay(new Date())) / 86_400_000)
  const rel = days < 0 ? `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`
            : days === 0 ? 'Due today'
            : days === 1 ? 'Due tomorrow'
            : `Due in ${days} days`
  const accent = days < 0 ? '#dc2626' : days <= 1 ? '#d97706' : '#2563eb'
  const bg     = days < 0 ? '#fef2f2' : days <= 1 ? '#fffbeb' : '#eff6ff'
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px">
      <tr>
        <td style="background-color:${bg};border-left:4px solid ${accent};border-radius:6px;padding:12px 16px">
          <p style="margin:0;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:${accent};font-weight:700">⏰ Deadline</p>
          <p style="margin:4px 0 0;font-size:15px;color:#0f172a;font-weight:700">${when}</p>
          <p style="margin:2px 0 0;font-size:12px;color:${accent};font-weight:600">${rel}</p>
        </td>
      </tr>
    </table>`
}

// Core notification logic — callable both from the HTTP route (browser) and
// directly in-process from server jobs (the 45-min cron), so server callers
// don't get bounced by the auth middleware that guards /api/tasks/*.
export async function notifyTaskEmail(
  event: 'assigned' | 'completed',
  task: TaskPayload,
): Promise<{ ok: boolean; sent?: boolean; reason?: string; recipients?: number; error?: string }> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://lumin-deals.vercel.app'
  const link = task.deal_id ? `${appUrl}/deals/${task.deal_id}` : `${appUrl}/tasks`

  // Optionally enrich with the deal/borrower name for context
  let dealName: string | null = null
  if (task.deal_id) {
    try {
      const supabase = createServiceClient()
      const { data } = await supabase.from('deals').select('name').eq('id', task.deal_id).single()
      dealName = (data?.name as string | null) ?? null
    } catch { /* non-fatal */ }
  }

  const titleSafe = (task.title || 'Untitled task').replace(/</g, '&lt;')
  const descRow = task.description ? `<p style="margin:0 0 14px;font-size:13px;color:#475569">${task.description.replace(/</g, '&lt;')}</p>` : ''
  const dealRow = dealName ? `<tr><td style="padding:6px 0;font-size:12px;color:#64748b;width:90px">Deal</td><td style="padding:6px 0;font-size:13px;color:#0f172a;font-weight:600">${dealName}</td></tr>` : ''

  if (event === 'assigned') {
    const to = emailForName(task.assignee)
    if (!to) return { ok: true, sent: false, reason: `no_email_for_assignee:${task.assignee ?? 'none'}` }
    const html = shell('#2563eb', 'Lumin Lending', '📋 New task assigned to you', `
      <p style="margin:0 0 14px;font-size:15px;color:#0f172a;font-weight:700">${titleSafe}</p>
      ${descRow}
      ${deadlineCallout(task.due_at)}
      <table style="width:100%;border-collapse:collapse;margin-bottom:18px">
        ${dealRow}
        <tr><td style="padding:6px 0;font-size:12px;color:#64748b;width:90px">Assigned by</td><td style="padding:6px 0;font-size:13px;color:#334155">${task.assigned_by || '—'}</td></tr>
      </table>
      <a href="${link}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:600;font-size:14px">Open in dashboard →</a>`)
    const sent = await sendBrevo([{ email: to, name: task.assignee ?? undefined }], `📋 New task: ${titleSafe}`, html)
    return { ok: true, sent }
  }

  if (event === 'completed') {
    // Email the assignee AND the assigner (dedup, skip missing emails)
    const recipients = new Map<string, { email: string; name?: string }>()
    const aEmail = emailForName(task.assignee)
    if (aEmail) recipients.set(aEmail, { email: aEmail, name: task.assignee ?? undefined })
    const bEmail = emailForName(task.assigned_by)
    if (bEmail) recipients.set(bEmail, { email: bEmail, name: task.assigned_by ?? undefined })
    if (recipients.size === 0) return { ok: true, sent: false, reason: 'no_recipient_emails' }
    const html = shell('#059669', 'Lumin Lending', '✅ Task completed', `
      <p style="margin:0 0 14px;font-size:15px;color:#0f172a;font-weight:700">${titleSafe}</p>
      ${descRow}
      <table style="width:100%;border-collapse:collapse;margin-bottom:18px">
        ${dealRow}
        <tr><td style="padding:6px 0;font-size:12px;color:#64748b;width:90px">Assignee</td><td style="padding:6px 0;font-size:13px;color:#334155">${task.assignee || '—'}</td></tr>
        <tr><td style="padding:6px 0;font-size:12px;color:#64748b">Due</td><td style="padding:6px 0;font-size:13px;color:#334155">${fmtDue(task.due_at)}</td></tr>
        <tr><td style="padding:6px 0;font-size:12px;color:#64748b">Assigned by</td><td style="padding:6px 0;font-size:13px;color:#334155">${task.assigned_by || '—'}</td></tr>
        <tr><td style="padding:6px 0;font-size:12px;color:#64748b">Completed</td><td style="padding:6px 0;font-size:13px;color:#334155">${new Date().toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:TASK_TZ})}</td></tr>
      </table>
      <a href="${link}" style="display:inline-block;background:#10b981;color:#fff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:600;font-size:14px">View in dashboard →</a>`)
    const sent = await sendBrevo(Array.from(recipients.values()), `✅ Task completed: ${titleSafe}`, html)
    return { ok: true, sent, recipients: recipients.size }
  }

  return { ok: false, error: 'unknown_event' }
}

export async function POST(req: NextRequest) {
  let body: { event?: 'assigned' | 'completed'; task?: TaskPayload }
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 }) }
  const { event, task } = body
  if (!event || !task) return NextResponse.json({ ok: false, error: 'missing_event_or_task' }, { status: 400 })
  const result = await notifyTaskEmail(event, task)
  return NextResponse.json(result, { status: result.ok ? 200 : 400 })
}
