import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { GHL_BASE, getAccounts, ghlHeaders } from '@/lib/ghl'

// Refreshes "last communication" data for active leads by querying GHL's
// Conversations API. For each contact we capture:
//   • last_communication_at   — most recent message date (any channel/direction)
//   • last_communication_type — channel of that last message (Text / Call / Email…)
//   • comm_unread_count        — messages from the client nobody has opened yet
//                                (the "client is waiting on us" signal)
//   • last_inbound_at          — last message FROM the borrower (inbound)
//   • last_outbound_at         — last message FROM us (outbound)
//
// Scoped to the hot stages by default so it stays light enough to run on every
// sync. Requires these columns (run once):
//   ALTER TABLE deals
//     ADD COLUMN IF NOT EXISTS last_communication_at timestamptz,
//     ADD COLUMN IF NOT EXISTS last_communication_type text,
//     ADD COLUMN IF NOT EXISTS comm_unread_count int,
//     ADD COLUMN IF NOT EXISTS last_inbound_at timestamptz,
//     ADD COLUMN IF NOT EXISTS last_outbound_at timestamptz;
export const maxDuration = 120

const DEFAULT_STATUSES = ['Responded', 'Pitching', 'App Intake']
const CONCURRENCY = 5

// Map GHL message/conversation types to a short human label.
function channelLabel(type: string | null | undefined): string | null {
  if (!type) return null
  const t = String(type).toUpperCase()
  if (t.includes('SMS') || t.includes('TEXT'))           return 'Text'
  if (t.includes('CALL') || t.includes('PHONE') || t.includes('VOICE') || t.includes('NO_SHOW')) return 'Call'
  if (t.includes('EMAIL'))                                return 'Email'
  if (t.includes('FB') || t.includes('FACEBOOK'))         return 'Facebook'
  if (t.includes('IG') || t.includes('INSTAGRAM'))        return 'Instagram'
  if (t.includes('GMB') || t.includes('WHATSAPP'))        return 'Chat'
  return null
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type Conversation = {
  id?: string
  lastMessageDate?: number | string
  lastMessageType?: string
  type?: string
  unreadCount?: number
}

async function fetchConversations(locationId: string, contactId: string, apiKey: string): Promise<Conversation[] | null> {
  const url = `${GHL_BASE}/conversations/search?locationId=${locationId}&contactId=${contactId}`
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: ghlHeaders(apiKey) })
    if (res.status === 429 || res.status >= 500) { await sleep(600 * (attempt + 1)); continue }
    if (!res.ok) return null
    const j = await res.json() as { conversations?: Conversation[] }
    return j.conversations ?? []
  }
  return null
}

// ── Message direction ───────────────────────────────────────────────────────
// The conversation *summary* doesn't say who sent the last message, so we read
// the recent messages (which carry a `direction`: inbound = borrower, outbound
// = us) and take the newest of each. The messages endpoint needs Version
// 2021-04-15 (different from the rest of the v2 API).
type GHLMessage = { direction?: string; dateAdded?: string | number }
type DirTs = { inboundMs: number; outboundMs: number }

async function fetchMessageDirections(conversationId: string, apiKey: string): Promise<DirTs> {
  // limit=100 (not 20): a lead who replied once and then got many outbound
  // follow-ups would otherwise have their inbound pushed out of the window,
  // leaving last_inbound_at null even though they DID reply.
  const url = `${GHL_BASE}/conversations/${conversationId}/messages?limit=100`
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Version: '2021-04-15',
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0',
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers })
    if (res.status === 429 || res.status >= 500) { await sleep(500 * (attempt + 1)); continue }
    if (!res.ok) return { inboundMs: 0, outboundMs: 0 }
    const j = await res.json() as { messages?: { messages?: GHLMessage[] } | GHLMessage[] }
    const list: GHLMessage[] = Array.isArray(j.messages) ? j.messages : (j.messages?.messages ?? [])
    let inboundMs = 0, outboundMs = 0
    for (const m of list) {
      const ms = m.dateAdded ? Date.parse(String(m.dateAdded)) : 0
      if (!ms) continue
      const dir = String(m.direction ?? '').toLowerCase()
      if (dir === 'inbound')       inboundMs  = Math.max(inboundMs, ms)
      else if (dir === 'outbound') outboundMs = Math.max(outboundMs, ms)
    }
    return { inboundMs, outboundMs }
  }
  return { inboundMs: 0, outboundMs: 0 }
}

type CommData = { last_communication_at: string | null; last_communication_type: string | null; comm_unread_count: number }

function summarize(convs: Conversation[], ackMap: Map<string, number>): CommData {
  let bestMs = 0
  let bestType: string | null = null
  let unread = 0
  for (const c of convs) {
    const raw = c.lastMessageDate
    const ms = typeof raw === 'number' ? raw : (raw ? Date.parse(String(raw)) : 0)
    // Respect dashboard "mark as read" — don't count unread for a conversation
    // that's been acknowledged and has no newer message since the ack.
    const ackedAt = c.id ? ackMap.get(c.id) : undefined
    const isAcked = ackedAt !== undefined && ms <= ackedAt
    if (!isAcked) unread += Number(c.unreadCount ?? 0) || 0
    if (ms > bestMs) {
      bestMs = ms
      bestType = channelLabel(c.lastMessageType ?? c.type)
    }
  }
  return {
    last_communication_at: bestMs > 0 ? new Date(bestMs).toISOString() : null,
    last_communication_type: bestType,
    comm_unread_count: unread,
  }
}

export type RefreshResult = {
  scanned: number
  updated: number
  no_key: number
  errors: number
  duration_ms: number
}

export async function refreshConversations(opts?: { statuses?: string[] }): Promise<RefreshResult> {
  const started = Date.now()
  const statuses = opts?.statuses ?? DEFAULT_STATUSES
  const supabase = createServiceClient()

  // Build a locationId → apiKey lookup from configured accounts.
  const keyByLocation = new Map<string, string>()
  for (const a of getAccounts()) keyByLocation.set(a.locationId, a.apiKey)

  // Load "mark as read" acks so we don't re-flag conversations the team cleared.
  const ackMap = new Map<string, number>()
  try {
    const { data: acks } = await supabase.from('comm_read_acks').select('conversation_id, acked_message_at')
    for (const a of (acks ?? []) as Array<{ conversation_id: string; acked_message_at: string | null }>) {
      ackMap.set(a.conversation_id, a.acked_message_at ? Date.parse(a.acked_message_at) : 0)
    }
  } catch { /* table may not exist yet — non-fatal */ }

  // Page through the targeted deals.
  type Row = { id: string; ghl_contact_id: string | null; ghl_location_id: string | null }
  const rows: Row[] = []
  let offset = 0
  for (;;) {
    const { data } = await supabase
      .from('deals')
      .select('id,ghl_contact_id,ghl_location_id')
      .in('status', statuses)
      .not('ghl_contact_id', 'is', null)
      .range(offset, offset + 999)
    const page = (data ?? []) as Row[]
    rows.push(...page)
    if (page.length < 1000) break
    offset += 1000
  }

  let updated = 0, noKey = 0, errors = 0
  let i = 0
  async function worker() {
    while (i < rows.length) {
      const d = rows[i++]
      const loc = d.ghl_location_id
      const apiKey = loc ? keyByLocation.get(loc) : undefined
      if (!apiKey || !d.ghl_contact_id) { noKey++; continue }
      const convs = await fetchConversations(loc as string, d.ghl_contact_id, apiKey)
      if (convs == null) { errors++; continue }
      const summary = summarize(convs, ackMap)
      // Resolve who reached out last (borrower vs us) by reading message direction
      // across the contact's conversations (usually just one).
      let inboundMs = 0, outboundMs = 0
      for (const c of convs) {
        if (!c.id) continue
        const dir = await fetchMessageDirections(c.id, apiKey)
        if (dir.inboundMs  > inboundMs)  inboundMs  = dir.inboundMs
        if (dir.outboundMs > outboundMs) outboundMs = dir.outboundMs
      }
      const update = {
        ...summary,
        last_inbound_at:  inboundMs  > 0 ? new Date(inboundMs).toISOString()  : null,
        last_outbound_at: outboundMs > 0 ? new Date(outboundMs).toISOString() : null,
      }
      const { error } = await supabase.from('deals').update(update).eq('id', d.id)
      if (error) { errors++; continue }
      updated++
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  return { scanned: rows.length, updated, no_key: noKey, errors, duration_ms: Date.now() - started }
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const url = new URL(req.url)
  // ?statuses=Pitching,App Intake,Responded — optional override
  const statusesParam = url.searchParams.get('statuses')
  const statuses = statusesParam ? statusesParam.split(',').map(s => s.trim()).filter(Boolean) : undefined
  try {
    const result = await refreshConversations({ statuses })
    console.log(`[Conversations Refresh] scanned ${result.scanned}, updated ${result.updated}, no-key ${result.no_key}, errors ${result.errors}, ${result.duration_ms}ms`)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    console.error('[Conversations Refresh] failed:', err)
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
