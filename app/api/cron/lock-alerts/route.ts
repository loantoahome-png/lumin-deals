import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { lockDaysLeft } from '@/lib/lockStatus'
import { isClosedLoan } from '@/lib/loanOutcome'

// Runs once a day. Walks every IN-ESCROW loan (an active, pre-funding status —
// see ESCROW_STATUSES) that carries a `lock_expiration`, figures out which are
// approaching expiration, and emails the LO (cc'd to admin). A blown lock costs
// real money, so this is the highest-value alert.
//
// ⚠️ TWO bugs fixed 2026-09-21 — this alert was effectively dead for months.
//
// 1. It required `locked = 'Yes'`. That column has NO importer (see lib/lockStatus)
//    and is dead: of the 32 active escrows measured 2026-09-21, **zero** carry 'Yes'
//    while 28 carry a real Arive `lock_expiration`. So the loop `continue`d on
//    everything and the alert fired for nobody — the only deal ever emailed was one
//    hand-flagged row back in July. `lock_expiration` is the evidence of a lock;
//    the flag is not read at all any more.
//
// 2. Gating on STATUS alone lets DEAD loans through. A declined loan keeps the
//    stage it died at (lib/loanOutcome), so of the 50 rows this query returns,
//    **22 are `Not Ready` with `ghl_status = 'lost'` and an Arive adverse date** —
//    Robert Rapolas, Gumaro Trevino, Katherine Sison and 19 more. Fixing bug 1
//    alone would have started emailing four LOs about loans that are already dead.
//    `isClosedLoan` is the guard; it is the same rule the rest of the app uses.
//
// Dedup'd via the `lock_alerts_sent` JSONB column so the same alert never sends
// twice for the same date+window. The cron still works if that column does not
// yet exist — it just won't dedup until you run:
//   ALTER TABLE deals ADD COLUMN IF NOT EXISTS lock_alerts_sent jsonb;
export const maxDuration = 60

// Alert at these days-out from the lock expiration (heads-up + day-of). No
// overdue spam — once expired we stop (the LO will have been told 3 times).
const WINDOWS = [5, 3, 1, 0]

// Only TRUE in-escrow (active, pre-funding) statuses get lock alerts. A rate
// lock only matters while the loan is still being worked. We gate on STATUS,
// not pipeline_group, because the funded statuses (Loan Funded / Broker Check
// Received / Loan Finalized) are also nested under "Loans in Process" — so a
// just-funded deal could slip past a group filter and wrongly get alerted.
// Excluding funded here means no alerts for funded loans, leads, or not-ready.
const ESCROW_STATUSES = [
  'Loan Setup', 'Disclosed', 'Submitted to UW', 'Approved w/ Conditions',
  'Re-Submittal', 'Clear to Close', 'Docs Out', 'Docs Signed',
]

// ── Who gets lock alerts ──────────────────────────────────────────────────
// MOE AND MATT ONLY (Efrain, 2026-09-22). Randy and Daniel were receiving these
// and do not want them; their entries were removed from this table, which is the
// single place that decides both eligibility and address.
//
// ⚠️ This is an ALLOWLIST, and it must stay one. LO names are NOT stable across
// systems — Daniel is "Danny Granger" in GHL but "Daniel McGrail-Granger" in Arive
// (see the reporting-role note), and `loan_officer` is whatever the sync resolved.
// A denylist would silently resume emailing an excluded LO the moment a name
// changed, and would mail every LO added in future by default. An allowlist fails
// closed: the worst case is a missed alert, visible in the run summary as
// `skipped_not_alert_lo`, rather than an unwanted email nobody asked for.
//
// One table, so eligibility and address can never disagree — an LO who matches
// here but has no env var set shows up under `missing_lo_email`, which is a real
// config gap, as distinct from a deliberate exclusion.
const ALERT_LOS: Array<{ match: (lo: string) => boolean; envVar: string }> = [
  { match: lo => lo.includes('matt') || lo.includes('park'),   envVar: 'LO_EMAIL_MATT' },
  { match: lo => lo.includes('moe')  || lo.includes('sefati'), envVar: 'LO_EMAIL_MOE'  },
]

/** Does this LO receive lock alerts at all? */
function isAlertLo(loanOfficer: string | null | undefined): boolean {
  const lo = (loanOfficer ?? '').trim().toLowerCase()
  return lo.length > 0 && ALERT_LOS.some(e => e.match(lo))
}

// ── LO-name → email lookup ────────────────────────────────────────────────
function getLoEmail(loanOfficer: string | null | undefined): string | null {
  const lo = (loanOfficer ?? '').trim().toLowerCase()
  if (!lo) return null
  const hit = ALERT_LOS.find(e => e.match(lo))
  return hit ? (process.env[hit.envVar] || null) : null
}

// ── Date helpers ──────────────────────────────────────────────────────────
function todayLocalDate(): string {
  const d = new Date(); d.setHours(0, 0, 0, 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ── Email rendering ───────────────────────────────────────────────────────
function windowLabel(daysOut: number): string {
  if (daysOut === 0) return 'expires today'
  if (daysOut === 1) return 'expires tomorrow'
  return `expires in ${daysOut} days`
}
function urgencyColor(daysOut: number): { bg: string; border: string; text: string } {
  if (daysOut === 0) return { bg: '#fef2f2', border: '#fca5a5', text: '#991b1b' }       // red — today
  if (daysOut === 1) return { bg: '#fff7ed', border: '#fdba74', text: '#9a3412' }       // orange — tomorrow
  return                    { bg: '#fefce8', border: '#fde047', text: '#854d0e' }       // amber — heads-up
}

function buildSubject(deal: Record<string, unknown>, daysOut: number): string {
  const urgency = daysOut === 0 ? '🚨' : daysOut === 1 ? '⏰' : '🔒'
  return `${urgency} Rate lock ${windowLabel(daysOut)} — ${deal.name as string}`
}

function buildHtml(deal: Record<string, unknown>, daysOut: number, dateStr: string, loName: string): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://lumin-deals.vercel.app'
  const dealUrl = `${appUrl}/deals/${deal.id}`
  const c = urgencyColor(daysOut)
  const niceDate = new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;background:#f8fafc">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-radius:12px 12px 0 0;overflow:hidden">
        <tr><td bgcolor="#1e3a8a" style="background-color:#1e3a8a;padding:24px 28px">
          <h1 style="color:#ffffff;margin:0;font-size:20px;font-weight:700">🔒 Rate Lock Expiration Alert</h1>
          <p style="color:#bfdbfe;margin:6px 0 0;font-size:13px">Lumin Lending — ${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric',timeZone:'America/Los_Angeles'})}</p>
        </td></tr>
      </table>
      <div style="background:#fff;padding:24px 28px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px">

        <p style="margin:0 0 16px;font-size:14px;color:#334155">
          Hi ${loName.split(' ')[0]}, the rate lock on <strong>${deal.name}</strong> needs your attention:
        </p>

        <div style="background:${c.bg};border:1px solid ${c.border};border-radius:10px;padding:14px 18px;margin-bottom:10px">
          <p style="margin:0;font-size:15px;font-weight:700;color:${c.text}">Rate lock ${windowLabel(daysOut)}</p>
          <p style="margin:4px 0 0;font-size:13px;color:${c.text};opacity:.85">Lock expires ${niceDate}</p>
        </div>

        <table style="width:100%;border-collapse:collapse;margin:18px 0">
          <tr style="background:#f8fafc">
            <td style="padding:8px 12px;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #f1f5f9;width:120px">Lender</td>
            <td style="padding:8px 12px;font-size:13px;color:#334155;border-bottom:1px solid #f1f5f9">${deal.investor || '—'}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #f1f5f9">Rate</td>
            <td style="padding:8px 12px;font-size:13px;color:#334155;border-bottom:1px solid #f1f5f9">${deal.rate ? Number(deal.rate) + '%' : '—'}</td>
          </tr>
          <tr style="background:#f8fafc">
            <td style="padding:8px 12px;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #f1f5f9">Loan Amount</td>
            <td style="padding:8px 12px;font-size:13px;color:#334155;border-bottom:1px solid #f1f5f9">${deal.loan_amount ? '$' + Number(deal.loan_amount).toLocaleString() : '—'}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #f1f5f9">Property</td>
            <td style="padding:8px 12px;font-size:13px;color:#334155;border-bottom:1px solid #f1f5f9">${deal.property_address || '—'}</td>
          </tr>
          <tr style="background:#f8fafc">
            <td style="padding:8px 12px;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Status</td>
            <td style="padding:8px 12px;font-size:13px;color:#334155">${deal.status || '—'}</td>
          </tr>
        </table>

        <a href="${dealUrl}"
           style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:600;font-size:14px">
          Open deal in dashboard →
        </a>

        <p style="margin:18px 0 0;font-size:11px;color:#94a3b8;line-height:1.6">
          You're receiving this because you're the loan officer on this active loan.<br/>
          Lock alerts fire at 5 days, 3 days, 1 day, and day-of expiration.<br/>
          Lumin Lending Deal Dashboard
        </p>
      </div>
    </div>`
}

type SendResult = { ok: boolean; status?: number; body?: string; error?: string }

async function sendAlert(
  deal: Record<string, unknown>,
  daysOut: number,
  dateStr: string,
  loEmail: string,
  loName: string,
): Promise<SendResult> {
  const apiKey = process.env.BREVO_API_KEY
  if (!apiKey) {
    console.warn('[Lock Alerts] BREVO_API_KEY not set — skipping send')
    return { ok: false, error: 'no_brevo_api_key' }
  }

  const senderEmail = process.env.BREVO_SENDER_EMAIL || 'loantoahome@gmail.com'
  const senderName  = process.env.BREVO_SENDER_NAME  || 'Lumin Lending Alerts'
  const adminEmail  = process.env.ADMIN_EMAIL_EFRAIN || null

  const body = {
    sender: { name: senderName, email: senderEmail },
    to:     [{ email: loEmail, name: loName }],
    cc:     adminEmail ? [{ email: adminEmail }] : undefined,
    subject:     buildSubject(deal, daysOut),
    htmlContent: buildHtml(deal, daysOut, dateStr, loName),
  }

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'accept': 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const respBody = await res.text()
    if (!res.ok) {
      console.error('[Lock Alerts] Brevo error:', res.status, respBody.slice(0, 300))
      return { ok: false, status: res.status, body: respBody.slice(0, 400) }
    }
    return { ok: true, status: res.status, body: respBody.slice(0, 200) }
  } catch (e) {
    console.error('[Lock Alerts] send failed:', e)
    return { ok: false, error: String(e) }
  }
}

// ── Cron entrypoint ───────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ?dry=1 — resolve exactly who WOULD be emailed and return it, sending nothing and
  // writing no dedup stamps. This alert mails four LOs and was dead for months; there
  // has to be a way to confirm the blast radius before a real run.
  const dryRun = req.nextUrl.searchParams.get('dry') === '1'

  const startedAt = new Date().toISOString()
  const todayStr  = todayLocalDate()
  const supabase  = createServiceClient()

  // In-escrow loans only — gate on the active escrow STATUSES (never funded /
  // leads / not-ready). A lock only matters while the loan is still in process.
  type DealRow = Record<string, unknown> & {
    id: string
    locked: string | null
    lock_expiration: string | null
    lock_alerts_sent: Record<string, string> | null
  }
  const { data: deals, error } = await supabase
    .from('deals')
    .select('*')
    .in('status', ESCROW_STATUSES)
    .not('lock_expiration', 'is', null)
  if (error) {
    console.error('[Lock Alerts] fetch failed:', error.message)
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }

  let scanned = 0
  let emailsSent = 0
  let alertsTriggered = 0
  let skippedClosed = 0
  let skippedNotAlertLo = 0
  const noLoEmail: string[] = []
  const wouldSend: Array<{ deal: string; lo: string; to: string; daysOut: number; expires: string }> = []
  let lastSendResult: { dealName: string; ok: boolean; status?: number; body?: string; error?: string } | null = null

  for (const d of (deals ?? []) as DealRow[]) {
    // A `lock_expiration` IS the lock — the `locked` Yes/No flag is dead and is
    // deliberately not consulted. See the note at the top of this file.
    const dateStr = d.lock_expiration
    if (!dateStr) continue
    // Never alert on a loan that is already dead. A declined loan keeps the stage it
    // died at, so the status filter above does NOT exclude it (22 of 50 rows).
    if (isClosedLoan(d as unknown as Parameters<typeof isClosedLoan>[0])) { skippedClosed++; continue }
    scanned++

    // Lock alerts go to Moe and Matt only — see ALERT_LOS. Counted separately from
    // `missing_lo_email` so a deliberate exclusion never looks like a missing env var.
    if (!isAlertLo(d.loan_officer as string | null)) { skippedNotAlertLo++; continue }

    const daysOut = lockDaysLeft(dateStr)
    if (daysOut == null || !WINDOWS.includes(daysOut)) continue

    const sentStamps = (d.lock_alerts_sent ?? {}) as Record<string, string>
    const dedupKey = `${daysOut}_${dateStr}`
    if (sentStamps[dedupKey]) continue   // already alerted for this date+window

    alertsTriggered++

    const loName  = (d.loan_officer as string | null) ?? '—'
    const loEmail = getLoEmail(d.loan_officer as string | null)
    if (!loEmail) {
      noLoEmail.push(`${d.name as string} (LO: ${loName})`)
      continue
    }

    if (dryRun) {
      wouldSend.push({ deal: d.name as string, lo: loName, to: loEmail, daysOut, expires: dateStr })
      continue
    }

    const result = await sendAlert(d, daysOut, dateStr, loEmail, loName)
    if (result.ok) {
      emailsSent++
      const merged = { ...sentStamps, [dedupKey]: todayStr }
      // Best-effort dedup write — ignore failure if the column isn't there yet.
      const { error: upErr } = await supabase.from('deals').update({ lock_alerts_sent: merged }).eq('id', d.id)
      if (upErr) console.warn('[Lock Alerts] dedup write skipped:', upErr.message)
    } else {
      lastSendResult = { dealName: d.name as string, ...result }
    }
  }
  void lastSendResult

  console.log(
    `[Lock Alerts]${dryRun ? ' DRY RUN —' : ''} ${startedAt} — scanned ${scanned} locked active loans, ` +
    `skipped ${skippedClosed} closed, skipped ${skippedNotAlertLo} not-alert-LO, ` +
    `triggered ${alertsTriggered}, emailed ${emailsSent}, ` +
    `skipped-no-lo-email ${noLoEmail.length}`
  )

  return NextResponse.json({
    ok: true,
    dry_run: dryRun,
    startedAt,
    finishedAt: new Date().toISOString(),
    scanned,
    skipped_closed_loans: skippedClosed,
    skipped_not_alert_lo: skippedNotAlertLo,
    alert_los: ALERT_LOS.map(e => e.envVar),
    alerts_triggered: alertsTriggered,
    emails_sent: emailsSent,
    would_send: dryRun ? wouldSend : undefined,
    missing_lo_email: noLoEmail,
    last_send_error: lastSendResult,
  })
}
