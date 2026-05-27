import { NextRequest, NextResponse } from 'next/server'
import { GHL_BASE, resolveApiKey } from '@/lib/ghl'
import { createServiceClient } from '@/lib/supabase'
import { isChannelBlocked } from '@/lib/utils'

// Send an outbound message (SMS by default, optionally Email) through GHL's
// Conversations API, so the team can reply straight from the dashboard.
//
// Requires the GHL Private Integration to have the "Conversations / Messages"
// write scope enabled (same place you enabled opportunities.write). If it's
// missing, GHL returns 401/403 and we surface a clear `needsScope` flag.
export async function POST(req: NextRequest) {
  let body: { contactId?: string; locationId?: string; message?: string; channel?: string; subject?: string; fromNumber?: string }
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 }) }

  const { contactId, locationId, message, channel, subject, fromNumber } = body
  if (!contactId || !locationId || !message || !message.trim()) {
    return NextResponse.json({ ok: false, error: 'missing_contactId_locationId_or_message' }, { status: 400 })
  }

  const apiKey = resolveApiKey(locationId)
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: `no_api_key_for_location:${locationId}` }, { status: 200 })
  }

  const type = channel === 'Email' ? 'Email' : 'SMS'

  // ── Compliance guardrail ────────────────────────────────────────────────
  // Never send on a channel the contact has opted out of (Do Not Contact).
  // This enforces it server-side so it holds even if the UI is bypassed.
  // Fails open only on a lookup error (rare) — the UI already blocks too.
  try {
    const supabase = createServiceClient()
    const { data: deal } = await supabase
      .from('deals')
      .select('dnd, dnd_settings')
      .eq('ghl_contact_id', contactId)
      .limit(1)
      .maybeSingle()
    if (deal && isChannelBlocked(deal, type)) {
      return NextResponse.json({ ok: false, blocked: true, error: `This contact is marked Do Not Contact for ${type}. Message not sent.` }, { status: 200 })
    }
  } catch (e) {
    console.warn('[Send message] DND check failed — allowing send:', e)
  }

  const payload: Record<string, unknown> = { type, contactId }
  if (type === 'Email') {
    payload.html = message
    payload.subject = subject || 'Message from Lumin Lending'
  } else {
    payload.message = message
    // Pin the sending number when the UI specifies one, so it's never ambiguous.
    if (fromNumber) payload.fromNumber = fromNumber
  }

  try {
    const res = await fetch(`${GHL_BASE}/conversations/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Version: '2021-04-15',         // conversations messaging API version
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
      body: JSON.stringify(payload),
    })
    const text = await res.text()
    if (!res.ok) {
      const needsScope = res.status === 401 || res.status === 403
      console.error(`[Send message] GHL ${res.status}:`, text.slice(0, 300))
      return NextResponse.json({ ok: false, status: res.status, needsScope, error: text.slice(0, 300) }, { status: 200 })
    }
    let data: { conversationId?: string; messageId?: string; messageIds?: string[] } = {}
    try { data = JSON.parse(text) } catch { /* non-json ok */ }
    return NextResponse.json({ ok: true, conversationId: data.conversationId ?? null, messageId: data.messageId ?? null })
  } catch (err) {
    console.error('[Send message] failed:', err)
    return NextResponse.json({ ok: false, error: String(err) }, { status: 200 })
  }
}
