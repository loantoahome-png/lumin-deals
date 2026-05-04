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

// ── Send email alert via Resend ───────────────────────────────────────────────
async function sendEmailAlert(
  deal: Record<string, unknown>,
  currentYield: number,
  targetYield: number
) {
  const apiKey   = process.env.RESEND_API_KEY
  const toEmail  = process.env.ALERT_EMAIL
  const appUrl   = process.env.NEXT_PUBLIC_APP_URL || 'https://lumin-deals.vercel.app'
  if (!apiKey || !toEmail) {
    console.log('[RateWatch] No RESEND_API_KEY or ALERT_EMAIL — skipping email')
    return
  }

  const html = `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto">
      <div style="background:#1e40af;padding:20px 24px;border-radius:10px 10px 0 0">
        <h1 style="color:#fff;margin:0;font-size:20px">🔔 Rate Watch Alert</h1>
        <p style="color:#bfdbfe;margin:4px 0 0">Lumin Lending — Automated Alert</p>
      </div>
      <div style="background:#f8fafc;padding:24px;border:1px solid #e2e8f0;border-top:none">
        <p style="color:#334155;font-size:16px;margin:0 0 16px">
          The <strong>10-Year Treasury yield</strong> has dropped to
          <strong style="color:#16a34a">${currentYield}%</strong>,
          hitting the target of <strong>${targetYield}%</strong> for this client:
        </p>
        <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:20px">
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="color:#64748b;font-size:13px;padding:4px 0">Client</td>
                <td style="font-weight:600;font-size:14px">${deal.name}</td></tr>
            <tr><td style="color:#64748b;font-size:13px;padding:4px 0">Loan Type</td>
                <td style="font-size:14px">${deal.loan_type || '—'}</td></tr>
            <tr><td style="color:#64748b;font-size:13px;padding:4px 0">Loan Amount</td>
                <td style="font-size:14px">${deal.loan_amount ? `$${Number(deal.loan_amount).toLocaleString()}` : '—'}</td></tr>
            <tr><td style="color:#64748b;font-size:13px;padding:4px 0">Property</td>
                <td style="font-size:14px">${deal.property_address || '—'}</td></tr>
            <tr><td style="color:#64748b;font-size:13px;padding:4px 0">Loan Officer</td>
                <td style="font-size:14px">${deal.loan_officer || '—'}</td></tr>
            <tr><td style="color:#64748b;font-size:13px;padding:4px 0">Notes</td>
                <td style="font-size:14px;font-style:italic">${deal.rate_watch_notes || '—'}</td></tr>
          </table>
        </div>
        <a href="${appUrl}/deals/${deal.id}"
           style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;
                  padding:10px 20px;border-radius:8px;font-weight:600;font-size:14px">
          View Deal →
        </a>
        <p style="color:#94a3b8;font-size:12px;margin-top:20px">
          This alert will not repeat until the yield rises back above ${targetYield}% and drops again.<br/>
          Lumin Lending Deal Dashboard · ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
        </p>
      </div>
    </div>
  `

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Lumin Lending <onboarding@resend.dev>',
      to: [toEmail],
      subject: `🔔 Rate Alert — ${deal.name} — 10yr at ${currentYield}%`,
      html,
    }),
  })
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
      await sendEmailAlert(deal, currentYield, target)

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
