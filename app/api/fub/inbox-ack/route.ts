import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import {
  FUB_INBOX_ACKS_KEY, parseFubInboxAcks, pruneAcks, type FubInboxAcks,
} from '@/lib/fubInboxAcks'
import { INBOX_LOOKBACK_DAYS } from '@/lib/followUpBoss'

// Check a FollowUpBoss row off the reply inbox.
//
//   POST   { fubId, lastInboundAt }  → acknowledged; comes back only on a NEWER message
//   DELETE ?fubId=123                → undo
//
// Runs server-side with the service role on purpose: it must work for people
// who are NOT in fub_people (the sweep stores Past Client + Closed + task
// holders only), which is exactly the set of rows that had no buttons at all.
//
// Auth: middleware gates every /api route except the explicit public list.

export const dynamic = 'force-dynamic'

async function readAcks(sb: ReturnType<typeof createServiceClient>): Promise<FubInboxAcks> {
  const { data } = await sb.from('sync_state').select('value').eq('key', FUB_INBOX_ACKS_KEY).maybeSingle()
  const value = (data as { value?: unknown } | null)?.value
  const out: FubInboxAcks = {}
  for (const [id, at] of parseFubInboxAcks(value)) out[String(id)] = new Date(at).toISOString()
  return out
}

async function writeAcks(sb: ReturnType<typeof createServiceClient>, acks: FubInboxAcks) {
  const cutoff = Date.now() - INBOX_LOOKBACK_DAYS * 86_400_000
  const { error } = await sb.from('sync_state').upsert(
    { key: FUB_INBOX_ACKS_KEY, value: pruneAcks(acks, cutoff), updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  )
  if (error) throw new Error(error.message)
}

export async function POST(req: NextRequest) {
  let fubId: number, lastInboundAt: string
  try {
    const body = await req.json() as { fubId?: number | string; lastInboundAt?: string }
    fubId = Number(body.fubId)
    if (!Number.isFinite(fubId)) throw new Error('fubId must be a number')
    lastInboundAt = String(body.lastInboundAt ?? '')
    if (isNaN(Date.parse(lastInboundAt))) throw new Error('lastInboundAt must be an ISO timestamp')
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'bad request' }, { status: 400 })
  }

  const sb = createServiceClient()
  try {
    const acks = await readAcks(sb)
    // Never move an ack BACKWARD — a stale client replaying an older timestamp
    // must not un-acknowledge a newer message someone already cleared.
    const existing = acks[String(fubId)]
    if (!existing || Date.parse(existing) < Date.parse(lastInboundAt)) {
      acks[String(fubId)] = new Date(lastInboundAt).toISOString()
      await writeAcks(sb, acks)
    }
    return NextResponse.json({ ok: true, fubId, ackedAt: acks[String(fubId)] })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[FUB inbox-ack] failed:', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const fubId = Number(req.nextUrl.searchParams.get('fubId'))
  if (!Number.isFinite(fubId)) {
    return NextResponse.json({ ok: false, error: 'fubId must be a number' }, { status: 400 })
  }
  const sb = createServiceClient()
  try {
    const acks = await readAcks(sb)
    delete acks[String(fubId)]
    await writeAcks(sb, acks)
    return NextResponse.json({ ok: true, fubId })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[FUB inbox-ack] delete failed:', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
