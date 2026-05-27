import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

// Runs once a day. Walks every Purchase deal with contingency dates set,
// figures out which (if any) contingencies are coming up, and emails the LO
// (cc'd to admin). Dedup'd via the `contingency_alerts_sent` JSONB column so
// the same alert never sends twice for the same date.
export const maxDuration = 60

const MS_PER_DAY = 86_400_000

// Contingency definition: what column holds the date + how many days-out
// trigger an alert. User asked for 3-day / 1-day / day-of (no overdue).
type Contingency = {
  field: string                                        // column name on deals
  label: string                                        // human label in email
  windows: number[]                                    // alert at these days-out
}
const CONTINGENCIES: Contingency[] = [
  { field: 'inspection_contingency_date', label: 'Inspection contingency', windows: [3, 1, 0] },
  { field: 'appraisal_contingency_date',  label: 'Appraisal contingency',  windows: [3, 1, 0] },
  { field: 'loan_contingency_date',       label: 'Loan contingency',       windows: [3, 1, 0] },
  { field: 'close_of_escrow_date',        label: 'Close of escrow',        windows: [3, 1, 0] },
]

// ── LO-name → email lookup ────────────────────────────────────────────────
function getLoEmail(loanOfficer: string | null | undefined): string | null {
  if (!loanOfficer) return null
  const lo = loanOfficer.toLowerCase()
  if (lo.includes('matt'))   return process.env.LO_EMAIL_MATT || null
  if (lo.includes('moe'))    return process.env.LO_EMAIL_MOE  || null
  return null
}

// ── Date helpers ──────────────────────────────────────────────────────────
function todayLocalDate(): string {
  const d = new Date(); d.setHours(0, 0, 0, 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function daysFromTodayTo(dateStr: string): number {
  const due = new Date(dateStr + 'T00:00:00')
  const today = new Date(); today.setHours(0, 0, 0, 0)
  return Math.round((due.getTime() - today.getTime()) / MS_PER_DAY)
}

// ── Email rendering ───────────────────────────────────────────────────────
type Trigger = { contingency: string; daysOut: number; date: string }

function windowLabel(daysOut: number): string {
  if (daysOut === 0) return 'today'
  if (daysOut === 1) return 'tomorrow'
  return `in ${daysOut} days`
}
function urgencyColor(daysOut: number): { bg: string; border: string; text: string } {
  if (daysOut === 0) return { bg: '#fef2f2', border: '#fca5a5', text: '#991b1b' }       // red — today
  if (daysOut === 1) return { bg: '#fff7ed', border: '#fdba74', text: '#9a3412' }       // orange — tomorrow
  return                    { bg: '#fefce8', border: '#fde047', text: '#854d0e' }       // amber — heads-up
}

function buildSubject(deal: Record<string, unknown>, triggers: Trigger[]): string {
  if (triggers.length === 1) {
    const t = triggers[0]
    const when = windowLabel(t.daysOut)
    const urgency = t.daysOut === 0 ? '🚨' : t.daysOut === 1 ? '⏰' : '📅'
    return `${urgency} ${t.contingency} ${when} — ${deal.name as string}`
  }
  const soonest = Math.min(...triggers.map(t => t.daysOut))
  const urgency = soonest === 0 ? '🚨' : soonest === 1 ? '⏰' : '📅'
  return `${urgency} ${triggers.length} contingencies coming up — ${deal.name as string}`
}

function buildHtml(deal: Record<string, unknown>, triggers: Trigger[], loName: string): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://lumin-deals.vercel.app'
  const dealUrl = `${appUrl}/deals/${deal.id}`

  // Sort triggers by urgency (today first, then 1-day, then 3-day)
  const sorted = [...triggers].sort((a, b) => a.daysOut - b.daysOut)

  const rows = sorted.map(t => {
    const c = urgencyColor(t.daysOut)
    return `
      <div style="background:${c.bg};border:1px solid ${c.border};border-radius:10px;padding:14px 18px;margin-bottom:10px">
        <p style="margin:0;font-size:15px;font-weight:700;color:${c.text}">${t.contingency} — ${windowLabel(t.daysOut)}</p>
        <p style="margin:4px 0 0;font-size:13px;color:${c.text};opacity:.85">Due ${new Date(t.date + 'T00:00:00').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' })}</p>
      </div>`
  }).join('')

  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;background:#f8fafc">
      <div style="background:linear-gradient(135deg,#1e3a8a,#2563eb);padding:24px 28px;border-radius:12px 12px 0 0">
        <h1 style="color:#fff;margin:0;font-size:20px;font-weight:700">📅 Purchase Contingency Alert</h1>
        <p style="color:#bfdbfe;margin:6px 0 0;font-size:13px">Lumin Lending — ${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})}</p>
      </div>
      <div style="background:#fff;padding:24px 28px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px">

        <p style="margin:0 0 16px;font-size:14px;color:#334155">
          Hi ${loName.split(' ')[0]}, the following contingencies on <strong>${deal.name}</strong> need your attention:
        </p>

        ${rows}

        <table style="width:100%;border-collapse:collapse;margin:18px 0">
          <tr style="background:#f8fafc">
            <td style="padding:8px 12px;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #f1f5f9;width:120px">Loan Type</td>
            <td style="padding:8px 12px;font-size:13px;color:#334155;border-bottom:1px solid #f1f5f9">${deal.loan_type || '—'}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #f1f5f9">Loan Amount</td>
            <td style="padding:8px 12px;font-size:13px;color:#334155;border-bottom:1px solid #f1f5f9">${deal.loan_amount ? '$' + Number(deal.loan_amount).toLocaleString() : '—'}</td>
          </tr>
          <tr style="background:#f8fafc">
            <td style="padding:8px 12px;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #f1f5f9">Property</td>
            <td style="padding:8px 12px;font-size:13px;color:#334155;border-bottom:1px solid #f1f5f9">${deal.property_address || '—'}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Status</td>
            <td style="padding:8px 12px;font-size:13px;color:#334155">${deal.status || '—'}</td>
          </tr>
        </table>

        <a href="${dealUrl}"
           style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:600;font-size:14px">
          Open deal in dashboard →
        </a>

        <p style="margin:18px 0 0;font-size:11px;color:#94a3b8;line-height:1.6">
          You're receiving this because you're the loan officer on this purchase deal.<br/>
          Alerts fire at 3 days, 1 day, and day-of for each contingency.<br/>
          Lumin Lending Deal Dashboard
        </p>
      </div>
    </div>`
}

type SendResult = { ok: boolean; status?: number; body?: string; error?: string }

/**
 * Send a single contingency-alert email via Brevo's transactional API.
 *
 * Brevo's REST API:
 *   POST https://api.brevo.com/v3/smtp/email
 *   header: api-key: <BREVO_API_KEY>
 *   body: { sender, to, cc, subject, htmlContent }
 *
 * We pick the sender from BREVO_SENDER_EMAIL — must be a verified sender in
 * Brevo's dashboard (Settings → Senders, Domains & Dedicated IPs).
 */
async function sendAlert(
  deal: Record<string, unknown>,
  triggers: Trigger[],
  loEmail: string,
  loName: string,
): Promise<SendResult> {
  const apiKey = process.env.BREVO_API_KEY
  if (!apiKey) {
    console.warn('[Contingency Alerts] BREVO_API_KEY not set — skipping send')
    return { ok: false, error: 'no_brevo_api_key' }
  }

  // Verified Brevo sender. Default to our known-verified address; can be overridden.
  const senderEmail = process.env.BREVO_SENDER_EMAIL || 'loantoahome@gmail.com'
  const senderName  = process.env.BREVO_SENDER_NAME  || 'Lumin Lending Alerts'

  const adminEmail = process.env.ADMIN_EMAIL_EFRAIN || null

  const body = {
    sender: { name: senderName, email: senderEmail },
    to:     [{ email: loEmail, name: loName }],
    cc:     adminEmail ? [{ email: adminEmail }] : undefined,
    subject:     buildSubject(deal, triggers),
    htmlContent: buildHtml(deal, triggers, loName),
  }

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'accept': 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const respBody = await res.text()
    if (!res.ok) {
      console.error('[Contingency Alerts] Brevo error:', res.status, respBody.slice(0, 300))
      return { ok: false, status: res.status, body: respBody.slice(0, 400) }
    }
    return { ok: true, status: res.status, body: respBody.slice(0, 200) }
  } catch (e) {
    console.error('[Contingency Alerts] send failed:', e)
    return { ok: false, error: String(e) }
  }
}

// ── Cron entrypoint ───────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  // Vercel cron / external cron both authorize with Bearer <CRON_SECRET>
  const authHeader = req.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startedAt = new Date().toISOString()
  const todayStr  = todayLocalDate()
  const supabase  = createServiceClient()

  // Fetch all Purchase deals that have at least one contingency date set.
  // We do the filtering and the windowing in code — keeps SQL simple.
  type DealRow = Record<string, unknown> & {
    id: string
    contingency_alerts_sent: Record<string, string> | null
  }
  const { data: deals, error } = await supabase
    .from('deals')
    .select('*')
    .eq('loan_purpose', 'Purchase')
  if (error) {
    console.error('[Contingency Alerts] fetch failed:', error.message)
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }

  let scanned = 0
  let emailsSent = 0
  let alertsTriggered = 0
  const noLoEmail: string[] = []
  // Capture the most-recent failure so the response can surface it for debugging
  let lastSendResult: { dealName: string; ok: boolean; status?: number; body?: string; error?: string } | null = null

  for (const d of (deals ?? []) as DealRow[]) {
    scanned++

    // Determine which contingencies are in an alert window today, and which
    // we haven't already alerted on (per the dedup stamp).
    const sentStamps = (d.contingency_alerts_sent ?? {}) as Record<string, string>
    const newStamps: Record<string, string> = {}
    const triggers: Trigger[] = []

    for (const c of CONTINGENCIES) {
      const dateStr = d[c.field] as string | null
      if (!dateStr) continue
      const daysOut = daysFromTodayTo(dateStr)
      if (!c.windows.includes(daysOut)) continue
      const dedupKey = `${c.field}_${daysOut}_${dateStr}`
      if (sentStamps[dedupKey]) continue   // already alerted for this date+window
      triggers.push({ contingency: c.label, daysOut, date: dateStr })
      newStamps[dedupKey] = todayStr
    }

    if (triggers.length === 0) continue
    alertsTriggered++

    const loName  = (d.loan_officer as string | null) ?? '—'
    const loEmail = getLoEmail(d.loan_officer as string | null)
    if (!loEmail) {
      noLoEmail.push(`${d.name as string} (LO: ${loName})`)
      continue
    }

    const result = await sendAlert(d, triggers, loEmail, loName)
    if (result.ok) {
      emailsSent++
      const merged = { ...sentStamps, ...newStamps }
      await supabase.from('deals').update({ contingency_alerts_sent: merged }).eq('id', d.id)
    } else {
      lastSendResult = { dealName: d.name as string, ...result }
    }
  }
  // Eslint hates the lint pattern for variable used only in error path; keep at function scope
  void lastSendResult

  console.log(
    `[Contingency Alerts] ${startedAt} — scanned ${scanned} purchase deals, ` +
    `triggered ${alertsTriggered}, emailed ${emailsSent}, skipped-no-lo-email ${noLoEmail.length}`
  )

  return NextResponse.json({
    ok: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    scanned,
    alerts_triggered: alertsTriggered,
    emails_sent: emailsSent,
    missing_lo_email: noLoEmail,
    last_send_error: lastSendResult,        // null when nothing failed
  })
}
