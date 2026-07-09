import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { GHL_BASE, getAccounts, ghlHeaders } from '@/lib/ghl'
import { isChannelBlocked, dndLabel } from '@/lib/utils'

// Live "unread messages" inbox across ALL configured GHL accounts and ALL
// stages. GHL's conversations search with `status=unread` returns exactly the
// conversations that have unread (client → us) messages, so this is one cheap
// call per account — no per-deal scanning.
export const dynamic = 'force-dynamic'

// Friendly LO label per account (fallback when the lead isn't in our DB).
const ACCOUNT_LO: Record<string, string> = {
  primary: 'Moe Sefati',
  matt: 'Matt Park',
  extra: 'Randy Mathis',
}

function channelLabel(type: string | null | undefined): string {
  if (!type) return 'Message'
  const t = String(type).toUpperCase()
  if (t.includes('SMS') || t.includes('TEXT')) return 'Text'
  if (t.includes('CALL') || t.includes('PHONE') || t.includes('VOICE')) return 'Call'
  if (t.includes('NO_SHOW')) return 'Call'
  if (t.includes('EMAIL')) return 'Email'
  if (t.includes('FB') || t.includes('FACEBOOK')) return 'Facebook'
  if (t.includes('IG') || t.includes('INSTAGRAM')) return 'Instagram'
  if (t.includes('WHATSAPP')) return 'WhatsApp'
  return 'Message'
}

type Conversation = {
  id?: string
  contactId?: string
  contactName?: string
  fullName?: string
  unreadCount?: number
  lastMessageType?: string
  lastMessageDirection?: string   // 'inbound' (client) | 'outbound' (us)
  type?: string
  lastMessageDate?: number | string
  lastMessageBody?: string
}

type UnreadItem = {
  conversationId: string | null
  contactId: string | null
  locationId: string
  name: string
  unreadCount: number
  channel: string
  lastMessageAt: string | null
  preview: string
  account: string
  lo: string
  dealId: string | null
  dealStatus: string | null
  ghlUrl: string | null
  replyBlocked: boolean        // contact is Do-Not-Contact for SMS — block the reply composer
  dndNote: string | null       // badge label, e.g. "Do Not Contact" / "DND: SMS"
}

const GHL_UI_BASE = process.env.NEXT_PUBLIC_GHL_BASE_URL || 'https://app.luminlending.com'
// Link straight to the lead's profile (contact detail) — it has the full
// conversation/messaging panel to reply from, plus all their info. Falls back
// to the Team Inbox conversation view only if we somehow lack the contactId.
function ghlConversationUrl(locationId: string, conversationId: string | null, contactId: string | null): string | null {
  if (contactId)      return `${GHL_UI_BASE}/v2/location/${locationId}/contacts/detail/${contactId}`
  if (conversationId) return `${GHL_UI_BASE}/v2/location/${locationId}/conversations/conversations/${conversationId}`
  return null
}

export async function GET() {
  try {
    const accounts = getAccounts()
    const raw: Array<{ conv: Conversation; account: string; locationId: string }> = []

    for (const acct of accounts) {
      const url = `${GHL_BASE}/conversations/search?locationId=${acct.locationId}&status=unread&limit=100&sortBy=last_message_date&sort=desc`
      const res = await fetch(url, { headers: ghlHeaders(acct.apiKey) })
      if (!res.ok) {
        console.warn(`[Unread] ${acct.label} returned ${res.status}`)
        continue
      }
      const j = await res.json() as { conversations?: Conversation[] }
      for (const conv of j.conversations ?? []) {
        // GHL keeps a conversation flagged "unread" until someone opens it in
        // the GHL inbox — even after we've replied. So skip any conversation
        // whose LAST message was outbound (we answered last): the client isn't
        // waiting on us, so it doesn't belong in the "needs reply" inbox.
        const lastWasOutbound = String(conv.lastMessageDirection ?? '').toLowerCase() === 'outbound'
        if ((conv.unreadCount ?? 0) > 0 && !lastWasOutbound) {
          raw.push({ conv, account: acct.label, locationId: acct.locationId })
        }
      }
    }

    // Enrich with the matching deal (link, status, real LO) when we have it.
    const contactIds = Array.from(new Set(raw.map(r => r.conv.contactId).filter(Boolean))) as string[]
    type DealLite = { id: string; status: string | null; loan_officer: string | null; name: string | null; dnd: boolean | null; dnd_settings: Record<string, unknown> | null }
    const dealByContact = new Map<string, DealLite>()
    if (contactIds.length > 0) {
      const supabase = createServiceClient()
      const { data } = await supabase
        .from('deals')
        .select('id,status,loan_officer,name,ghl_contact_id,dnd,dnd_settings')
        .in('ghl_contact_id', contactIds)
      for (const d of (data ?? []) as Array<DealLite & { ghl_contact_id: string }>) {
        // Keep the first match per contact (a contact may have multiple loans)
        if (!dealByContact.has(d.ghl_contact_id)) {
          dealByContact.set(d.ghl_contact_id, { id: d.id, status: d.status, loan_officer: d.loan_officer, name: d.name, dnd: d.dnd, dnd_settings: d.dnd_settings })
        }
      }
    }

    const items: UnreadItem[] = raw.map(({ conv, account, locationId }) => {
      const deal = conv.contactId ? dealByContact.get(conv.contactId) : undefined
      const rawDate = conv.lastMessageDate
      const ms = typeof rawDate === 'number' ? rawDate : (rawDate ? Date.parse(String(rawDate)) : 0)
      return {
        conversationId: conv.id ?? null,
        contactId: conv.contactId ?? null,
        locationId,
        name: deal?.name || conv.contactName || conv.fullName || 'Unknown',
        unreadCount: conv.unreadCount ?? 0,
        channel: channelLabel(conv.lastMessageType ?? conv.type),
        lastMessageAt: ms > 0 ? new Date(ms).toISOString() : null,
        preview: (conv.lastMessageBody ?? '').slice(0, 140),
        account,
        lo: deal?.loan_officer || ACCOUNT_LO[account] || account,
        dealId: deal?.id ?? null,
        dealStatus: deal?.status ?? null,
        ghlUrl: ghlConversationUrl(locationId, conv.id ?? null, conv.contactId ?? null),
        replyBlocked: isChannelBlocked(deal, 'SMS'),
        dndNote: dndLabel(deal),
      }
    })

    // Hide conversations the team has marked read on the dashboard — unless a
    // newer message has arrived since the acknowledgment.
    let visible = items
    const convIds = items.map(i => i.conversationId).filter(Boolean) as string[]
    if (convIds.length > 0) {
      const supabase = createServiceClient()
      const { data: acks } = await supabase
        .from('comm_read_acks')
        .select('conversation_id, acked_message_at')
        .in('conversation_id', convIds)
      const ackMap = new Map<string, number>()
      for (const a of (acks ?? []) as Array<{ conversation_id: string; acked_message_at: string | null }>) {
        ackMap.set(a.conversation_id, a.acked_message_at ? Date.parse(a.acked_message_at) : 0)
      }
      visible = items.filter(i => {
        if (!i.conversationId) return true
        const ackAt = ackMap.get(i.conversationId)
        if (ackAt === undefined) return true                 // never acked → show
        const msgAt = i.lastMessageAt ? Date.parse(i.lastMessageAt) : 0
        return msgAt > ackAt                                  // newer message since ack → show again
      })
    }

    visible.sort((a, b) => (b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0) - (a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0))

    return NextResponse.json({ ok: true, count: visible.length, items: visible })
  } catch (err) {
    console.error('[Unread] failed:', err)
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
