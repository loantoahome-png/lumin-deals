import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { fetchFubUnanswered, type FubUnanswered } from '@/lib/followUpBoss'

// Live "they texted, nobody answered" list for one LO's FollowUpBoss inbox.
// GET /api/fub/unanswered?lo=moe|matt
//
// FUB's real unread inbox is owner-only (/v1/threads → 403 with agent keys) and
// the per-message `read` flag is meaningless — see the block comment above
// fetchFubUnanswered in lib/followUpBoss.ts. This reconstructs the same answer
// from the LO's own inbound/outbound text feeds.
//
// Live, not synced: it's ~7 upstream requests, and a reply inbox that lags an
// hour is worse than useless. The stage/name enrichment comes from fub_people
// when we have the person; unknown people still surface (a brand-new texter is
// exactly who you don't want silently dropped).
//
// Auth: middleware gates every /api route except the explicit public list.

export const dynamic = 'force-dynamic'

const KEY_BY_SLUG: Record<string, { env: string; label: 'moe' | 'matt' }> = {
  moe:  { env: 'FUB_API_KEY_MOE',  label: 'moe' },
  matt: { env: 'FUB_API_KEY_MATT', label: 'matt' },
}

export type FubUnansweredItem = FubUnanswered & {
  stage: string | null
  /** true when this person already has an active GHL deal — the GHL row owns
   *  them, so the UI can avoid listing the same human twice. */
  matchedDealActive: boolean
  /** false when the person isn't in fub_people (the sweep stores Past Client +
   *  Closed + task-holders only). Snooze/Touched write to that table, so the UI
   *  must not offer those buttons on a row that has no row to write. */
  stored: boolean
}

export async function GET(req: NextRequest) {
  const slug = (req.nextUrl.searchParams.get('lo') ?? '').toLowerCase()
  const cfg = KEY_BY_SLUG[slug]
  if (!cfg) {
    return NextResponse.json({ ok: false, error: `lo must be one of: ${Object.keys(KEY_BY_SLUG).join(', ')}` }, { status: 400 })
  }
  const apiKey = process.env[cfg.env]
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: `${cfg.env} is not configured` }, { status: 400 })
  }

  let unanswered: FubUnanswered[]
  try {
    unanswered = await fetchFubUnanswered(apiKey, cfg.label)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[FUB unanswered] failed:', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 502 })
  }

  // Enrich from fub_people — stage for the row chip, matched_deal_active so the
  // page can suppress people the GHL side already lists.
  const items: FubUnansweredItem[] = unanswered.map(u => ({ ...u, stage: null, matchedDealActive: false, stored: false }))
  if (items.length > 0) {
    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('fub_people')
      .select('fub_id, name, stage, matched_deal_active')
      .in('fub_id', items.map(i => i.fubId))
    if (error) {
      console.warn('[FUB unanswered] enrichment skipped:', error.message)
    } else {
      const byId = new Map((data ?? []).map(r => [
        (r as { fub_id: number }).fub_id,
        r as { name: string | null; stage: string | null; matched_deal_active: boolean | null },
      ]))
      for (const i of items) {
        const row = byId.get(i.fubId)
        if (!row) continue
        i.stored = true
        i.stage = row.stage
        i.matchedDealActive = !!row.matched_deal_active
        if (row.name) i.name = row.name
      }
    }
  }

  return NextResponse.json({ ok: true, count: items.length, items })
}
