import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

/**
 * DELETE /api/deals/{id} — permanently remove a single loan/deal.
 *
 * Hard delete (matches the merge route). `deal_contacts` rows cascade away via
 * the FK. Note: if the deal still exists in GHL, a future full sync can
 * re-insert it (sync treats an unknown ghl_opportunity_id as new) — so this is
 * meant for clearing duplicates / bad rows, not for hiding live GHL loans.
 */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!id) return NextResponse.json({ ok: false, error: 'missing_id' }, { status: 400 })
  try {
    const sb = createServiceClient()
    const { error } = await sb.from('deals').delete().eq('id', id)
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, id })
  } catch (e) {
    console.error('[deals/delete] error:', e)
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
