import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { runCallsSync } from '@/lib/callsSync'

// Paging two locations + a chunked upsert.
export const maxDuration = 120

/**
 * Manual call sweep — the on-demand twin of the cron's throttled pass.
 *
 *   GET /api/sync/calls          run it now (forward from each account's newest call)
 *   GET /api/sync/calls?dry=1    map + count, write NOTHING (inspect a cutover first)
 *   GET /api/sync/calls?since=ISO   override the watermark
 *
 * Auth: middleware already requires a session for /api/sync/* in the browser;
 * a `Bearer $CRON_SECRET` header is also accepted so it can be driven headlessly.
 *
 * ⚠️ `since` is an override, not a backfill switch. Pointing it at the
 * CSV-imported period will duplicate calls (the API's second lands ±1s from the
 * CSV's on ~16% of rows, slipping past the dedupe index) and mixes two sources
 * that disagree on duration for ~27% of calls. See lib/callsApi.ts. Use `dry=1`
 * first, always.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const isCron = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`
  // When CRON_SECRET is set and a bearer token was supplied, it must be the right
  // one — otherwise fall through to the middleware-enforced session.
  if (authHeader && !isCron) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const dryRun = req.nextUrl.searchParams.get('dry') === '1'
  const sinceParam = req.nextUrl.searchParams.get('since') ?? undefined
  if (sinceParam && Number.isNaN(new Date(sinceParam).getTime())) {
    return NextResponse.json({ ok: false, error: 'invalid_since' }, { status: 400 })
  }

  try {
    const supabase = createServiceClient()
    const result = await runCallsSync(supabase, { dryRun, sinceOverride: sinceParam })
    return NextResponse.json(result, { status: result.ok ? 200 : 500 })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
