import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

// Read-only. Surfaces the "needs review" items the GHL sync persists per location
// (funded loans whose opportunity vanished; loans carrying 2+ live opps). Merged
// across locations for the /duplicates "Needs review" panel.
export const dynamic = 'force-dynamic'

type Orphan = { deal_id: string; name: string | null; arive_file_no: string | null; dead_opp: string | null }
type MultiLive = { arive_file_no: string; opps: { id: string; status: string | null }[] }

export async function GET() {
  try {
    const sb = createServiceClient()
    const { data, error } = await sb.from('sync_state').select('key, value').like('key', 'needs_review_%')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const funded_orphans: Orphan[] = []
    const multi_live_opps: MultiLive[] = []
    let updated_at: string | null = null
    for (const row of data ?? []) {
      const v = (row.value ?? {}) as { updated_at?: string; funded_orphans?: Orphan[]; multi_live_opps?: MultiLive[] }
      if (Array.isArray(v.funded_orphans)) funded_orphans.push(...v.funded_orphans)
      if (Array.isArray(v.multi_live_opps)) multi_live_opps.push(...v.multi_live_opps)
      if (v.updated_at && (!updated_at || v.updated_at > updated_at)) updated_at = v.updated_at
    }
    return NextResponse.json({ updated_at, funded_orphans, multi_live_opps })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
