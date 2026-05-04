import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

// GHL sends lead data via POST webhook from a Workflow action
// Configure in GHL: Automation → Workflow → Add Action → Webhook
// URL: https://your-app.vercel.app/api/webhooks/ghl
// Method: POST, Format: JSON

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    console.log('[GHL Webhook] Received:', JSON.stringify(body, null, 2))

    // GHL webhook payload field names (vary slightly by trigger type)
    // Common fields: contact_id, full_name, first_name, last_name, email, phone, source
    const ghlContactId = body.contact_id || body.id || body.contactId
    const firstName = body.first_name || body.firstName || ''
    const lastName = body.last_name || body.lastName || ''
    const fullName = body.full_name || body.name || body.contact_name || `${firstName} ${lastName}`.trim() || 'New Lead'
    const email = body.email || null
    const phone = body.phone || body.phone_number || null
    const source = body.source || 'GHL'

    // If we have a contact ID, check for duplicate
    const supabase = createServiceClient()

    if (ghlContactId) {
      const { data: existing } = await supabase
        .from('deals')
        .select('id, name')
        .eq('ghl_contact_id', ghlContactId)
        .single()

      if (existing) {
        // Update last_contacted timestamp instead of creating a duplicate
        await supabase
          .from('deals')
          .update({ last_contacted: new Date().toISOString().split('T')[0] })
          .eq('id', existing.id)

        console.log('[GHL Webhook] Updated existing deal:', existing.id)
        return NextResponse.json({ success: true, action: 'updated', dealId: existing.id })
      }
    }

    // Create new deal
    const newDeal = {
      name: fullName,
      first_name: firstName || null,
      last_name: lastName || null,
      email,
      phone,
      status: 'Client',
      pipeline_group: 'LEADS',
      source,
      ghl_contact_id: ghlContactId || null,
      last_contacted: new Date().toISOString().split('T')[0],
    }

    const { data, error } = await supabase
      .from('deals')
      .insert(newDeal)
      .select()
      .single()

    if (error) {
      console.error('[GHL Webhook] Insert error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    console.log('[GHL Webhook] Created new deal:', data.id)
    return NextResponse.json({ success: true, action: 'created', dealId: data.id })

  } catch (err) {
    console.error('[GHL Webhook] Error:', err)
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
}

// Health check
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    message: 'GHL webhook endpoint is live',
    timestamp: new Date().toISOString(),
  })
}
