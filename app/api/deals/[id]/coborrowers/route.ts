import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import {
  listCoborrowers, linkCoborrower, unlinkCoborrower, promoteToPrimary, findOrCreateContact,
  type BorrowerIdentity,
} from '@/lib/dealContacts'

/**
 * Co-borrower management for a deal.
 *
 *   GET    /api/deals/{id}/coborrowers                         → { ok, coborrowers }
 *   POST   { action: 'link', contactId }                       → link existing contact
 *   POST   { action: 'link', newContact: {name,email,phone} }  → create + link
 *   POST   { action: 'promote', contactId }                    → make co-borrower the primary
 *   DELETE { contactId }                                       → unlink
 *
 * Always returns the refreshed co-borrower list so the UI can re-render.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!id) return NextResponse.json({ ok: false, error: 'missing_id' }, { status: 400 })
  const sb = createServiceClient()
  try {
    return NextResponse.json({ ok: true, coborrowers: await listCoborrowers(sb, id) })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}

type PostBody = {
  action?: 'link' | 'promote'
  contactId?: string
  newContact?: { name?: string | null; email?: string | null; phone?: string | null }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  let body: PostBody = {}
  try { body = await req.json() } catch { /* 400 below */ }
  if (!id || !body.action) {
    return NextResponse.json({ ok: false, error: 'missing_id_or_action' }, { status: 400 })
  }
  const sb = createServiceClient()
  try {
    let promoted: BorrowerIdentity | null = null
    if (body.action === 'promote') {
      if (!body.contactId) return NextResponse.json({ ok: false, error: 'missing_contactId' }, { status: 400 })
      promoted = await promoteToPrimary(sb, id, body.contactId)
    } else if (body.action === 'link') {
      let contactId = body.contactId
      if (!contactId && body.newContact) contactId = await findOrCreateContact(sb, body.newContact)
      if (!contactId) return NextResponse.json({ ok: false, error: 'missing_contact' }, { status: 400 })
      await linkCoborrower(sb, id, contactId)
    } else {
      return NextResponse.json({ ok: false, error: 'unknown_action' }, { status: 400 })
    }
    // `deal` carries the stamped borrower identity so the UI can update the hero in place.
    return NextResponse.json({ ok: true, coborrowers: await listCoborrowers(sb, id), deal: promoted ?? undefined })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  let body: { contactId?: string } = {}
  try { body = await req.json() } catch { /* 400 below */ }
  if (!id || !body.contactId) {
    return NextResponse.json({ ok: false, error: 'missing_id_or_contactId' }, { status: 400 })
  }
  const sb = createServiceClient()
  try {
    await unlinkCoborrower(sb, id, body.contactId)
    return NextResponse.json({ ok: true, coborrowers: await listCoborrowers(sb, id) })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
