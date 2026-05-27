import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'

/**
 * Tiny endpoint the LastSyncBadge polls every 30s.
 * Reads from sync_state (service-role, bypasses RLS) and returns the most
 * recent GHL sync timestamp across all locations.
 *
 * GET /api/sync-status
 *   → { last_synced_at: "2026-05-19T23:48:01Z" } or { last_synced_at: null }
 */
export async function GET() {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('sync_state')
    .select('value, updated_at')
    .like('key', 'ghl_sync_last:%')
    .order('updated_at', { ascending: false })
    .limit(1)

  if (error) {
    return NextResponse.json({ last_synced_at: null, error: error.message }, { status: 500 })
  }
  const row = data?.[0] as { value: { last_synced_at?: string } | null; updated_at: string } | undefined
  return NextResponse.json({
    last_synced_at: row?.value?.last_synced_at ?? null,
  })
}
