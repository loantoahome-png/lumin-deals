import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

// "Mark as read" — a dashboard-side acknowledgment. GHL's API has no working
// mark-read endpoint, so we record that the team has acknowledged this
// conversation up to its latest message. The Unread inbox and the "client
// waiting" flag both respect this ack until a NEWER message arrives.
//
// Requires (run once):
//   create table if not exists comm_read_acks (
//     conversation_id text primary key, contact_id text, location_id text,
//     acked_message_at timestamptz, acked_at timestamptz default now());
export async function POST(req: NextRequest) {
  let body: { conversationId?: string; contactId?: string; locationId?: string; lastMessageAt?: string }
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 }) }

  const { conversationId, contactId, locationId, lastMessageAt } = body
  if (!conversationId) return NextResponse.json({ ok: false, error: 'missing_conversationId' }, { status: 400 })

  const supabase = createServiceClient()
  try {
    // Record the acknowledgment (up to the latest message we've seen).
    const { error: ackErr } = await supabase.from('comm_read_acks').upsert({
      conversation_id: conversationId,
      contact_id: contactId ?? null,
      location_id: locationId ?? null,
      acked_message_at: lastMessageAt ?? new Date().toISOString(),
      acked_at: new Date().toISOString(),
    }, { onConflict: 'conversation_id' })
    if (ackErr) return NextResponse.json({ ok: false, error: ackErr.message }, { status: 200 })

    // Clear the "client waiting" flag on the lead(s) for this contact.
    if (contactId) {
      await supabase.from('deals').update({ comm_unread_count: 0 }).eq('ghl_contact_id', contactId)
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[mark-read] failed:', err)
    return NextResponse.json({ ok: false, error: String(err) }, { status: 200 })
  }
}
