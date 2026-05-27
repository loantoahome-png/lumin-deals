import { NextRequest, NextResponse } from 'next/server'
import { GHL_BASE, resolveApiKey } from '@/lib/ghl'

// Returns the full message history for a contact's GHL conversation, so the
// deal page can render the thread inline (texts, calls, emails).
export const dynamic = 'force-dynamic'

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Version: '2021-04-15',
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0',
  }
}

function channelLabel(type: string | null | undefined): string {
  if (!type) return 'Message'
  const t = String(type).toUpperCase()
  if (t.includes('SMS') || t.includes('TEXT')) return 'Text'
  if (t.includes('CALL') || t.includes('PHONE') || t.includes('VOICE') || t.includes('NO_SHOW')) return 'Call'
  if (t.includes('EMAIL')) return 'Email'
  if (t.includes('FB') || t.includes('FACEBOOK')) return 'Facebook'
  if (t.includes('IG') || t.includes('INSTAGRAM')) return 'Instagram'
  if (t.includes('WHATSAPP')) return 'WhatsApp'
  return 'Message'
}

type GhlMessage = {
  id?: string
  direction?: string
  body?: string
  messageType?: string
  type?: string
  status?: string
  dateAdded?: string
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const contactId = url.searchParams.get('contactId')
  const locationId = url.searchParams.get('locationId')
  if (!contactId || !locationId) return NextResponse.json({ ok: false, error: 'missing_contactId_or_locationId' }, { status: 400 })

  const apiKey = resolveApiKey(locationId)
  if (!apiKey) return NextResponse.json({ ok: false, error: `no_api_key_for_location:${locationId}` }, { status: 200 })

  try {
    // Resolve the conversation for this contact.
    const sres = await fetch(`${GHL_BASE}/conversations/search?locationId=${locationId}&contactId=${contactId}`, { headers: headers(apiKey) })
    if (!sres.ok) return NextResponse.json({ ok: false, error: `search_${sres.status}` }, { status: 200 })
    const sj = await sres.json() as { conversations?: Array<{ id?: string }> }
    const conversationId = sj.conversations?.[0]?.id
    if (!conversationId) return NextResponse.json({ ok: true, conversationId: null, messages: [] })

    const mres = await fetch(`${GHL_BASE}/conversations/${conversationId}/messages`, { headers: headers(apiKey) })
    if (!mres.ok) return NextResponse.json({ ok: false, error: `messages_${mres.status}` }, { status: 200 })
    const mj = await mres.json() as { messages?: { messages?: GhlMessage[] } | GhlMessage[] }
    const raw = Array.isArray(mj.messages) ? mj.messages : (mj.messages?.messages ?? [])

    const messages = raw
      .map(m => ({
        id: m.id ?? null,
        direction: m.direction === 'inbound' ? 'inbound' : 'outbound',
        body: (m.body ?? '').trim(),
        channel: channelLabel(m.messageType ?? m.type),
        status: m.status ?? null,
        at: m.dateAdded ?? null,
      }))
      .sort((a, b) => Date.parse(a.at ?? '') - Date.parse(b.at ?? ''))

    return NextResponse.json({ ok: true, conversationId, messages })
  } catch (err) {
    console.error('[Thread] failed:', err)
    return NextResponse.json({ ok: false, error: String(err) }, { status: 200 })
  }
}
