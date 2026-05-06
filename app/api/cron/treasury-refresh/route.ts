import { NextRequest, NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'

// Runs Mon–Fri at 8 AM PST (16:00 UTC) via vercel.json cron schedule.
// Busts the cached FRED fetch so the next dashboard load gets fresh data.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Invalidate the tagged FRED fetch — next call to /api/treasury hits FRED fresh
  revalidateTag('treasury-data')

  console.log('[TreasuryRefresh] Cache busted at', new Date().toISOString())
  return NextResponse.json({ ok: true, refreshedAt: new Date().toISOString() })
}
