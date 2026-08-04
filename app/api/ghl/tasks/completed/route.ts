import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { getAccounts } from '@/lib/ghl'
import { fetchTasks, buildContactDealMap } from '@/lib/ghlTaskSync'
import { mapCompletedGhlTask, type GhlCompletedTaskRow } from '@/lib/ghlTasks'

// Recently completed GoHighLevel tasks.
//   GET /api/ghl/tasks/completed?days=90
//
// ⚠️ This is LIVE, not a table read. `ghl_tasks` mirrors OPEN tasks only —
// completing one deletes the local row (that's the whole design), so a completed
// task exists nowhere on our side. GHL is the only record, which is exactly why
// a mis-click was previously unrecoverable: nothing on the dashboard could show
// you what you just checked off.
//
// Cost: one keyset-paged search per configured location (24 completed tasks
// total at build time, so a single page each), plus the contact→deal map. Only
// called when the Completed chip is opened, and cached in page state after that.
//
// Auth: middleware gates every /api route except the explicit public list.
export const dynamic = 'force-dynamic'

const DEFAULT_DAYS = 90
const MAX_ROWS = 200

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('days')
  const parsed = raw == null ? DEFAULT_DAYS : Number(raw)
  // days=0 (or a garbage value) means "no cutoff" — the window is a convenience,
  // never a silent truncation of something the caller asked for.
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  const cutoff = days > 0 ? Date.now() - days * 86_400_000 : null

  const accounts = getAccounts()
  if (accounts.length === 0) {
    return NextResponse.json({ ok: true, tasks: [], errors: ['no GHL accounts configured'] })
  }

  const supabase = createServiceClient()
  const errors: string[] = []

  let dealMap: Map<string, string>
  try {
    dealMap = await buildContactDealMap(supabase)
  } catch (e) {
    // A missing deal map costs the deal link, not the row — still worth showing.
    errors.push(`deal map: ${String(e)}`)
    dealMap = new Map()
  }
  const dealIdFor = (contactId: string | null | undefined) =>
    (contactId && dealMap.get(contactId)) || null

  const rows: GhlCompletedTaskRow[] = []
  for (const account of accounts) {
    try {
      const raw = await fetchTasks(account, true)
      for (const r of raw) {
        const row = mapCompletedGhlTask(r, account.locationId, dealIdFor)
        if (!row) continue
        if (cutoff && row.completed_at && new Date(row.completed_at).getTime() < cutoff) continue
        rows.push(row)
      }
    } catch (e) {
      // One location failing must not blank the other's history — report it.
      errors.push(`${account.label}: ${String(e)}`)
    }
  }

  rows.sort((a, b) =>
    new Date(b.completed_at ?? 0).getTime() - new Date(a.completed_at ?? 0).getTime())

  const truncated = rows.length > MAX_ROWS
  if (truncated) errors.push(`showing the ${MAX_ROWS} most recent of ${rows.length}`)

  return NextResponse.json({
    ok: true,
    days,
    total: rows.length,
    truncated,
    tasks: rows.slice(0, MAX_ROWS),
    errors,
  })
}
