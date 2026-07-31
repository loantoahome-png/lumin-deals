import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { fetchFubUnanswered, type FubUnanswered } from '@/lib/followUpBoss'
import {
  FUB_INBOX_ACKS_KEY, parseFubInboxAcks, isAcked,
  FUB_EMAIL_WAITING_KEY, parseEmailWaiting,
} from '@/lib/fubInboxAcks'

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

// userId scopes the EMAIL candidates. Texts and calls are attributed by the
// LO's own phone number, but an email has no number to key on — so email falls
// back to the account's ownership rule, assignedUserId (72 Moe / 13 Matt).
const KEY_BY_SLUG: Record<string, { env: string; label: 'moe' | 'matt'; userId: number }> = {
  moe:  { env: 'FUB_API_KEY_MOE',  label: 'moe',  userId: 72 },
  matt: { env: 'FUB_API_KEY_MATT', label: 'matt', userId: 13 },
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
  /** Cockpit-state columns. "Touched" after their last message clears the row;
   *  a future next_action_due snoozes it. Both are UI-owned — the FUB sweep
   *  never writes them, so they survive every sweep. */
  lastTouchedAt: string | null
  nextActionDue: string | null
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

  // Email candidates come from the hourly sweep (no account-wide email feed
  // exists); fetchFubUnanswered re-verifies each one per person before listing.
  const sbRead = createServiceClient()
  const { data: ewRow } = await sbRead.from('sync_state').select('value').eq('key', FUB_EMAIL_WAITING_KEY).maybeSingle()
  const emailCandidates = parseEmailWaiting((ewRow as { value?: unknown } | null)?.value)
    .filter(w => w.assignedUserId === cfg.userId)

  let unanswered: FubUnanswered[]
  try {
    unanswered = await fetchFubUnanswered(apiKey, cfg.label, { emailCandidates })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[FUB unanswered] failed:', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 502 })
  }

  // Drop anything already checked off. The ack stores the message it cleared, so
  // a NEWER inbound beats it and the row returns — the only thing that brings it
  // back (Efrain: "Only thing to bring it back would be a new response").
  // Filtered here rather than in the UI so the count is honest and a reload,
  // another device and the next sync all agree.
  {
    const sb = createServiceClient()
    const { data } = await sb.from('sync_state').select('value').eq('key', FUB_INBOX_ACKS_KEY).maybeSingle()
    const acks = parseFubInboxAcks((data as { value?: unknown } | null)?.value)
    if (acks.size > 0) {
      const before = unanswered.length
      unanswered = unanswered.filter(u => !isAcked(acks, u.fubId, u.lastInboundAt))
      const dropped = before - unanswered.length
      if (dropped > 0) console.log(`[FUB unanswered] ${cfg.label}: ${dropped} row(s) already checked off`)
    }
  }

  // Enrich from fub_people — stage for the row chip, matched_deal_active so the
  // page can suppress people the GHL side already lists.
  const items: FubUnansweredItem[] = unanswered.map(u => ({
    ...u, stage: null, matchedDealActive: false, stored: false,
    lastTouchedAt: null, nextActionDue: null,
  }))
  if (items.length > 0) {
    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('fub_people')
      .select('fub_id, name, stage, matched_deal_active, last_touched_at, next_action_due')
      .in('fub_id', items.map(i => i.fubId))
    if (error) {
      console.warn('[FUB unanswered] enrichment skipped:', error.message)
    } else {
      const byId = new Map((data ?? []).map(r => [
        (r as { fub_id: number }).fub_id,
        r as {
          name: string | null; stage: string | null; matched_deal_active: boolean | null
          last_touched_at: string | null; next_action_due: string | null
        },
      ]))
      for (const i of items) {
        const row = byId.get(i.fubId)
        if (!row) continue
        i.stored = true
        i.stage = row.stage
        i.matchedDealActive = !!row.matched_deal_active
        i.lastTouchedAt = row.last_touched_at
        i.nextActionDue = row.next_action_due
        if (row.name) i.name = row.name
      }
    }
  }

  return NextResponse.json({ ok: true, count: items.length, items })
}
