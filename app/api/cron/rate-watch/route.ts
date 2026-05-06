import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

const BASIS_POINT_DROP = 0.10 // alert when 10yr drops 10+ bps BELOW the close rate

// ── LO email map — set these in Vercel env vars ───────────────────────────────
function getLoEmail(loanOfficer: string | null): string | null {
  if (!loanOfficer) return null
  const lo = loanOfficer.toLowerCase()
  if (lo.includes('matt'))          return process.env.LO_EMAIL_MATT || null
  if (lo.includes('moe'))           return process.env.LO_EMAIL_MOE  || null
  return null
}

// ── Fetch current 10yr yield from FRED ───────────────────────────────────────
async function getCurrentYield(): Promise<number | null> {
  try {
    const res = await fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10', {
      cache: 'no-store',
    })
    const text = await res.text()
    const lines = text.trim().split('\n').slice(1)
    const valid = lines.filter(l => {
      const [, v] = l.split(',')
      return v && v.trim() !== '.' && !isNaN(parseFloat(v))
    })
    const last = valid[valid.length - 1]
    return last ? parseFloat(last.split(',')[1]) : null
  } catch {
    return null
  }
}

// ── Send Resend email to the LO on the deal ───────────────────────────────────
async function sendResendAlert(
  deal: Record<string, unknown>,
  currentYield: number,
  closeYield: number,
  loEmail: string
) {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) return

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://lumin-deals.vercel.app'
  const diff   = (currentYield - closeYield).toFixed(2)
  const diffAbs = Math.abs(currentYield - closeYield).toFixed(2)
  const direction = currentYield < closeYield ? 'below' : 'above'

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:540px;margin:0 auto;background:#f8fafc">
      <div style="background:linear-gradient(135deg,#1e3a8a,#2563eb);padding:28px 32px;border-radius:12px 12px 0 0">
        <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700">🔔 Rate Watch Alert</h1>
        <p style="color:#bfdbfe;margin:6px 0 0;font-size:14px">Lumin Lending — ${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})}</p>
      </div>
      <div style="background:#fff;padding:28px 32px;border:1px solid #e2e8f0;border-top:none">

        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px 20px;margin-bottom:24px">
          <p style="margin:0;font-size:15px;color:#15803d;font-weight:600">
            10-yr Treasury has dropped <strong>${diffAbs}%</strong> (${Math.round(parseFloat(diffAbs)*100)} bps) below the client's close rate
          </p>
          <p style="margin:6px 0 0;font-size:13px;color:#166534">
            Current: <strong>${currentYield}%</strong> &nbsp;·&nbsp; Close rate: <strong>${closeYield}%</strong> &nbsp;·&nbsp; Drop: ${diffAbs}%
          </p>
        </div>

        <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
          <tr style="background:#f8fafc"><td style="padding:10px 14px;font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #f1f5f9">Client</td>
              <td style="padding:10px 14px;font-size:14px;font-weight:700;color:#0f172a;border-bottom:1px solid #f1f5f9">${deal.name}</td></tr>
          <tr><td style="padding:10px 14px;font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #f1f5f9">Loan Type</td>
              <td style="padding:10px 14px;font-size:14px;color:#334155;border-bottom:1px solid #f1f5f9">${deal.loan_type || '—'}</td></tr>
          <tr style="background:#f8fafc"><td style="padding:10px 14px;font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #f1f5f9">Loan Amount</td>
              <td style="padding:10px 14px;font-size:14px;color:#334155;border-bottom:1px solid #f1f5f9">${deal.loan_amount ? '$' + Number(deal.loan_amount).toLocaleString() : '—'}</td></tr>
          <tr><td style="padding:10px 14px;font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #f1f5f9">Property</td>
              <td style="padding:10px 14px;font-size:14px;color:#334155;border-bottom:1px solid #f1f5f9">${deal.property_address || '—'}</td></tr>
          ${deal.rate_watch_notes ? `
          <tr style="background:#f8fafc"><td style="padding:10px 14px;font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Notes</td>
              <td style="padding:10px 14px;font-size:14px;font-style:italic;color:#475569">${deal.rate_watch_notes}</td></tr>` : ''}
        </table>

        <a href="${appUrl}/deals/${deal.id}"
           style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px;letter-spacing:.2px">
          View Deal &amp; Take Action →
        </a>

        <p style="margin:20px 0 0;font-size:11px;color:#94a3b8;line-height:1.6">
          This alert fires when the 10-yr yield drops 10+ basis points below the client's close rate (${closeYield}%).<br/>
          Alert threshold: ${(closeYield - 0.10).toFixed(2)}% or lower.<br/>
          It will not repeat until the yield recovers above ${(closeYield - 0.10).toFixed(2)}% and drops again.<br/>
          Lumin Lending Deal Dashboard
        </p>
      </div>
    </div>`

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Lumin Lending Alerts <onboarding@resend.dev>',
      to: [loEmail],
      subject: `🔔 Rate Alert — ${deal.name} — 10yr at ${currentYield}% (${diffAbs}% from close rate)`,
      html,
    }),
  }).catch(e => console.error('[RateWatch] Resend error:', e.message))
}

// ── ntfy.sh push notification (backup / instant phone alert) ─────────────────
async function sendPushAlert(
  deal: Record<string, unknown>,
  currentYield: number,
  closeYield: number
) {
  const topic = process.env.NTFY_TOPIC || 'lumin-lending-rates-8x4k2'
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://lumin-deals.vercel.app'
  const diffBps = Math.round(Math.abs(currentYield - closeYield) * 100)

  await fetch(`https://ntfy.sh/${topic}`, {
    method: 'POST',
    headers: {
      Title: `🔔 Rate Alert — ${deal.name}`,
      Priority: 'high',
      Tags: 'bell,chart_with_downwards_trend',
      Click: `${appUrl}/deals/${deal.id}`,
      'Content-Type': 'text/plain',
    },
    body: `10yr at ${currentYield}% — ${diffBps} bps from close rate of ${closeYield}%\n${deal.loan_type || ''} · ${deal.loan_amount ? '$' + Number(deal.loan_amount).toLocaleString() : ''}`,
  }).catch(e => console.error('[RateWatch] ntfy error:', e.message))
}

// ── Cron handler — runs Mon–Fri at 10 AM ET ───────────────────────────────────
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const currentYield = await getCurrentYield()
  if (currentYield === null) {
    console.error('[RateWatch] Could not fetch Treasury yield')
    return NextResponse.json({ error: 'Could not fetch yield' }, { status: 500 })
  }

  const supabase = createServiceClient()
  const { data: watches, error } = await supabase
    .from('deals')
    .select('*')
    .eq('rate_watch_active', true)
    .not('rate_at_close_10yr', 'is', null)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!watches?.length) return NextResponse.json({ message: 'No active rate watches', currentYield })

  const triggered: string[] = []
  const reset: string[] = []

  for (const deal of watches) {
    const closeYield   = Number(deal.rate_at_close_10yr)
    // Only alert when 10yr has dropped 10+ bps BELOW the close yield
    const hasDropped   = currentYield <= closeYield - BASIS_POINT_DROP
    const alreadyFired = !!deal.rate_watch_alerted_at

    if (hasDropped && !alreadyFired) {
      // 🎯 10yr dropped 10+ bps below close rate — send alert!
      triggered.push(`${deal.name} (close: ${closeYield}%, now: ${currentYield}%)`)
      await supabase.from('deals').update({ rate_watch_alerted_at: new Date().toISOString() }).eq('id', deal.id)

      // Email to the LO on the deal
      const loEmail = getLoEmail(deal.loan_officer as string | null)
      if (loEmail) {
        await sendResendAlert(deal, currentYield, closeYield, loEmail)
      }
      // Push notification (always)
      await sendPushAlert(deal, currentYield, closeYield)

    } else if (!hasDropped && alreadyFired) {
      // Yield rose back above threshold — reset so we can alert again if it drops again
      reset.push(deal.name)
      await supabase.from('deals').update({ rate_watch_alerted_at: null }).eq('id', deal.id)
    }
  }

  console.log(`[RateWatch] 10yr=${currentYield}% | watched=${watches.length} | triggered=${triggered.length} | reset=${reset.length}`)
  return NextResponse.json({ currentYield, totalWatches: watches.length, triggered, reset, checkedAt: new Date().toISOString() })
}
