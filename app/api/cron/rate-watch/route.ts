import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

// ── Fetch current 10yr yield ──────────────────────────────────────────────────
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

// ── Send push notification via ntfy.sh (free, no account needed) ─────────────
// Also sends email via Resend if configured
async function sendAlert(
  deal: Record<string, unknown>,
  currentYield: number,
  targetYield: number
) {
  const appUrl   = process.env.NEXT_PUBLIC_APP_URL || 'https://lumin-deals.vercel.app'
  const ntfyTopic = process.env.NTFY_TOPIC || 'lumin-deals-ratealerts'

  const title   = `🔔 Rate Alert — ${deal.name}`
  const message = `10yr Treasury at ${currentYield}% — hit your ${targetYield}% target.\n${deal.loan_type || ''} · ${deal.loan_amount ? '$' + Number(deal.loan_amount).toLocaleString() : ''}`

  // 1️⃣ ntfy.sh push notification (always — free, instant, works on phone/browser)
  await fetch(`https://ntfy.sh/${ntfyTopic}`, {
    method: 'POST',
    headers: {
      Title: title,
      Priority: 'high',
      Tags: 'bell,chart_with_downwards_trend',
      Click: `${appUrl}/deals/${deal.id}`,
      'Content-Type': 'text/plain',
    },
    body: message,
  }).catch(e => console.error('[RateWatch] ntfy error:', e.message))

  // 2️⃣ Email via Resend (optional — only if RESEND_API_KEY + ALERT_EMAIL are set)
  const resendKey = process.env.RESEND_API_KEY
  const toEmail   = process.env.ALERT_EMAIL
  if (resendKey && toEmail) {
    const html = `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto">
        <div style="background:#1e40af;padding:20px 24px;border-radius:10px 10px 0 0">
          <h1 style="color:#fff;margin:0;font-size:20px">🔔 Rate Watch Alert</h1>
          <p style="color:#bfdbfe;margin:4px 0 0">Lumin Lending — Automated Alert</p>
        </div>
        <div style="background:#f8fafc;padding:24px;border:1px solid #e2e8f0;border-top:none">
          <p style="color:#334155;font-size:16px;margin:0 0 16px">
            The <strong>10-Year Treasury yield</strong> dropped to
            <strong style="color:#16a34a">${currentYield}%</strong>,
            hitting the target of <strong>${targetYield}%</strong> for:
          </p>
          <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:20px">
            <p><strong>${deal.name}</strong></p>
            <p style="color:#64748b;font-size:13px;margin:4px 0">
              ${deal.loan_type || '—'} · ${deal.loan_amount ? '$' + Number(deal.loan_amount).toLocaleString() : '—'} · ${deal.property_address || '—'}
            </p>
            ${deal.rate_watch_notes ? `<p style="font-style:italic;color:#475569;font-size:13px;margin-top:8px">"${deal.rate_watch_notes}"</p>` : ''}
          </div>
          <a href="${appUrl}/deals/${deal.id}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:600;font-size:14px">View Deal →</a>
        </div>
      </div>`
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Lumin Lending <onboarding@resend.dev>', to: [toEmail], subject: title, html }),
    }).catch(e => console.error('[RateWatch] Resend error:', e.message))
  }
}

// ── Cron handler ──────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  // Protect with CRON_SECRET (Vercel sets this automatically for cron routes)
  const authHeader = req.headers.get('authorization')
  if (
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const currentYield = await getCurrentYield()
  if (currentYield === null) {
    console.error('[RateWatch] Could not fetch current Treasury yield')
    return NextResponse.json({ error: 'Could not fetch yield' }, { status: 500 })
  }

  const supabase = createServiceClient()

  // Fetch all deals with rate watch active
  const { data: watches, error } = await supabase
    .from('deals')
    .select('*')
    .eq('rate_watch_active', true)
    .not('rate_watch_target', 'is', null)

  if (error) {
    console.error('[RateWatch] DB error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!watches || watches.length === 0) {
    return NextResponse.json({ message: 'No active rate watches', currentYield })
  }

  const triggered: string[] = []
  const reset: string[] = []

  for (const deal of watches) {
    const target       = Number(deal.rate_watch_target)
    const alreadyFired = !!deal.rate_watch_alerted_at

    if (currentYield <= target && !alreadyFired) {
      // 🎯 Yield hit target — send alert!
      triggered.push(`${deal.name} (target: ${target}%)`)
      await supabase
        .from('deals')
        .update({ rate_watch_alerted_at: new Date().toISOString() })
        .eq('id', deal.id)
      await sendAlert(deal, currentYield, target)

    } else if (currentYield > target && alreadyFired) {
      // Yield recovered above target — reset so we can alert again next time
      reset.push(deal.name)
      await supabase
        .from('deals')
        .update({ rate_watch_alerted_at: null })
        .eq('id', deal.id)
    }
  }

  console.log(`[RateWatch] 10yr=${currentYield}% | watched=${watches.length} | triggered=${triggered.length} | reset=${reset.length}`)

  return NextResponse.json({
    currentYield,
    totalWatches: watches.length,
    triggered,
    reset,
    checkedAt: new Date().toISOString(),
  })
}
