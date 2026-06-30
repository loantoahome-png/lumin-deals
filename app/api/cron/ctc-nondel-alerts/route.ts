import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

// Funding-coordination alert for NON-DELEGATED loans.
//
// When a loan reaches the "Clear to Close" stage AND its channel (broker_corr)
// is "Non-Del", a Non-Del loan funds through the lender's funding desk — so the
// LO + admin need to reach out to the funding team to coordinate. This cron
// emails the loan officer (To) and Efrain (Cc) once, with the loan info and a
// clear "contact the funding team" call to action.
//
// Sends ONCE per loan, deduped via the `ctc_nondel_alerted_at` timestamp column.
// REQUIRES that column — run the migration first, or the cron fails safe (no
// emails) and reports `migration_needed`:
//   ALTER TABLE deals ADD COLUMN IF NOT EXISTS ctc_nondel_alerted_at timestamptz;
//
// Public route (middleware allows /api/cron) but gated on CRON_SECRET. Register
// it in cron-job.org at your preferred cadence (every 15 min recommended for a
// near-real-time alert; the dedup makes frequent runs safe). Add `?dryRun=1` to
// preview matches + recipients without sending or writing the dedup stamp.
export const maxDuration = 60

const CTC = 'Clear to Close'
const NON_DEL = 'Non-Del'

// ── LO-name → email lookup (same env vars as the other alert crons) ─────────
function getLoEmail(loanOfficer: string | null | undefined): string | null {
  if (!loanOfficer) return null
  const lo = loanOfficer.toLowerCase()
  if (lo.includes('matt')) return process.env.LO_EMAIL_MATT || null
  if (lo.includes('moe'))  return process.env.LO_EMAIL_MOE  || null
  return null
}

const money = (v: unknown) => (v != null && v !== '' ? '$' + Number(v).toLocaleString() : '—')

function buildSubject(deal: Record<string, unknown>): string {
  return `💰 Clear to Close (Non-Del) — coordinate funding for ${deal.name as string}`
}

function buildHtml(deal: Record<string, unknown>, loName: string): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://lumin-deals.vercel.app'
  const dealUrl = `${appUrl}/deals/${deal.id}`
  const firstName = loName !== '—' ? loName.split(' ')[0] : 'team'

  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;background:#f8fafc">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-radius:12px 12px 0 0;overflow:hidden">
        <tr><td bgcolor="#065f46" style="background-color:#065f46;padding:24px 28px">
          <h1 style="color:#ffffff;margin:0;font-size:20px;font-weight:700">💰 Clear to Close — Non-Del Funding</h1>
          <p style="color:#a7f3d0;margin:6px 0 0;font-size:13px">Lumin Lending — ${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric',timeZone:'America/Los_Angeles'})}</p>
        </td></tr>
      </table>
      <div style="background:#fff;padding:24px 28px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px">

        <p style="margin:0 0 16px;font-size:14px;color:#334155">
          Hi ${firstName}, <strong>${deal.name}</strong> just reached <strong>Clear to Close</strong> and it's a
          <strong>Non-Del</strong> loan.
        </p>

        <div style="background:#ecfdf5;border:1px solid #6ee7b7;border-radius:10px;padding:14px 18px;margin-bottom:10px">
          <p style="margin:0;font-size:15px;font-weight:700;color:#065f46">Action needed: contact the funding team</p>
          <p style="margin:4px 0 0;font-size:13px;color:#065f46;opacity:.9">Reach out to the lender's funding desk to coordinate funding on this loan.</p>
        </div>

        <table style="width:100%;border-collapse:collapse;margin:18px 0">
          <tr style="background:#f8fafc">
            <td style="padding:8px 12px;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #f1f5f9;width:120px">Channel</td>
            <td style="padding:8px 12px;font-size:13px;color:#334155;border-bottom:1px solid #f1f5f9;font-weight:600">${deal.broker_corr || '—'}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #f1f5f9">Loan Amount</td>
            <td style="padding:8px 12px;font-size:13px;color:#334155;border-bottom:1px solid #f1f5f9">${money(deal.loan_amount)}</td>
          </tr>
          <tr style="background:#f8fafc">
            <td style="padding:8px 12px;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #f1f5f9">Lender</td>
            <td style="padding:8px 12px;font-size:13px;color:#334155;border-bottom:1px solid #f1f5f9">${deal.investor || '—'}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #f1f5f9">Rate</td>
            <td style="padding:8px 12px;font-size:13px;color:#334155;border-bottom:1px solid #f1f5f9">${deal.rate != null && deal.rate !== '' ? Number(deal.rate) + '%' : '—'}</td>
          </tr>
          <tr style="background:#f8fafc">
            <td style="padding:8px 12px;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #f1f5f9">Property</td>
            <td style="padding:8px 12px;font-size:13px;color:#334155;border-bottom:1px solid #f1f5f9">${deal.property_address || '—'}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #f1f5f9">Loan Officer</td>
            <td style="padding:8px 12px;font-size:13px;color:#334155;border-bottom:1px solid #f1f5f9">${loName}</td>
          </tr>
          <tr style="background:#f8fafc">
            <td style="padding:8px 12px;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Stage</td>
            <td style="padding:8px 12px;font-size:13px;color:#334155;font-weight:600">${deal.status || '—'}</td>
          </tr>
        </table>

        <a href="${dealUrl}"
           style="display:inline-block;background:#059669;color:#fff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:600;font-size:14px">
          Open deal in dashboard →
        </a>

        <p style="margin:18px 0 0;font-size:11px;color:#94a3b8;line-height:1.6">
          You're receiving this because a Non-Del loan you're on reached Clear to Close.<br/>
          This alert fires once per loan. Lumin Lending Deal Dashboard
        </p>
      </div>
    </div>`
}

type SendResult = { ok: boolean; status?: number; body?: string; error?: string }

async function sendAlert(deal: Record<string, unknown>, to: { email: string; name?: string }[], cc: { email: string }[], loName: string): Promise<SendResult> {
  const apiKey = process.env.BREVO_API_KEY
  if (!apiKey) {
    console.warn('[CTC Non-Del] BREVO_API_KEY not set — skipping send')
    return { ok: false, error: 'no_brevo_api_key' }
  }
  const senderEmail = process.env.BREVO_SENDER_EMAIL || 'loantoahome@gmail.com'
  const senderName  = process.env.BREVO_SENDER_NAME  || 'Lumin Lending Alerts'

  const body = {
    sender: { name: senderName, email: senderEmail },
    to,
    cc: cc.length ? cc : undefined,
    subject:     buildSubject(deal),
    htmlContent: buildHtml(deal, loName),
  }
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'accept': 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const respBody = await res.text()
    if (!res.ok) {
      console.error('[CTC Non-Del] Brevo error:', res.status, respBody.slice(0, 300))
      return { ok: false, status: res.status, body: respBody.slice(0, 400) }
    }
    return { ok: true, status: res.status, body: respBody.slice(0, 200) }
  } catch (e) {
    console.error('[CTC Non-Del] send failed:', e)
    return { ok: false, error: String(e) }
  }
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1'
  const startedAt = new Date().toISOString()
  const supabase = createServiceClient()
  const adminEmail = process.env.ADMIN_EMAIL_EFRAIN || null

  // Explicitly select the dedup column so a missing migration fails SAFE (the
  // query errors → we bail without sending, rather than spamming every run).
  const { data: deals, error } = await supabase
    .from('deals')
    .select('id, name, loan_officer, broker_corr, status, investor, rate, loan_amount, property_address, ctc_nondel_alerted_at')
    .eq('status', CTC)
    .eq('broker_corr', NON_DEL)

  if (error) {
    const migrationNeeded = /ctc_nondel_alerted_at|column .* does not exist/i.test(error.message)
    console.error('[CTC Non-Del] fetch failed:', error.message)
    return NextResponse.json(
      { ok: false, error: migrationNeeded ? 'migration_needed' : error.message,
        hint: migrationNeeded ? 'Run: ALTER TABLE deals ADD COLUMN IF NOT EXISTS ctc_nondel_alerted_at timestamptz;' : undefined },
      { status: migrationNeeded ? 200 : 500 },
    )
  }

  type DealRow = Record<string, unknown> & { id: string; loan_officer: string | null; ctc_nondel_alerted_at: string | null }
  let scanned = 0, emailsSent = 0, alreadyAlerted = 0
  const wouldSend: { name: string; to: string[]; cc: string[] }[] = []
  const noRecipient: string[] = []
  let lastError: Record<string, unknown> | null = null

  for (const d of (deals ?? []) as DealRow[]) {
    scanned++
    if (d.ctc_nondel_alerted_at) { alreadyAlerted++; continue }

    const loName = d.loan_officer ?? '—'
    const loEmail = getLoEmail(d.loan_officer)
    // Always alert Efrain; the LO too when we have their email. If neither, skip.
    const to: { email: string; name?: string }[] = []
    const cc: { email: string }[] = []
    if (loEmail) { to.push({ email: loEmail, name: loName }); if (adminEmail) cc.push({ email: adminEmail }) }
    else if (adminEmail) { to.push({ email: adminEmail }) }
    if (to.length === 0) { noRecipient.push(`${d.name as string} (LO: ${loName})`); continue }

    if (dryRun) {
      wouldSend.push({ name: d.name as string, to: to.map(t => t.email), cc: cc.map(c => c.email) })
      continue
    }

    const result = await sendAlert(d, to, cc, loName)
    if (result.ok) {
      emailsSent++
      const { error: upErr } = await supabase.from('deals').update({ ctc_nondel_alerted_at: new Date().toISOString() }).eq('id', d.id)
      if (upErr) console.warn('[CTC Non-Del] dedup write failed:', upErr.message)
    } else {
      lastError = { dealName: d.name, ...result }
    }
  }

  console.log(`[CTC Non-Del] ${startedAt} — scanned ${scanned} CTC/Non-Del, alreadyAlerted ${alreadyAlerted}, emailed ${emailsSent}, dryRun=${dryRun}`)
  return NextResponse.json({
    ok: true, dryRun, startedAt, finishedAt: new Date().toISOString(),
    scanned, already_alerted: alreadyAlerted, emails_sent: emailsSent,
    would_send: dryRun ? wouldSend : undefined,
    no_recipient: noRecipient.length ? noRecipient : undefined,
    last_send_error: lastError,
  })
}
