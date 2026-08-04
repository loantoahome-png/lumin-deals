// ── GHL task sweep ───────────────────────────────────────────────────────────
// Pulls every OPEN GHL task per location and mirrors it into `ghl_tasks`, the
// same full-replace shape fub_tasks uses: a task that vanished from the sweep
// was completed or deleted in GHL, and either way it leaves the board.
//
// Runs inside runGhlSync (after the deal sync, so a task created on a brand-new
// contact can still resolve its deal_id on the same pass).

import { createServiceClient } from './supabase'
import { GHL_BASE, getAccounts, ghlHeaders, type GHLAccount } from './ghl'
import { mapGhlTask, type GhlTaskRow, type GhlTaskSearchRow } from './ghlTasks'

const PAGE = 100
const MAX_PAGES = 25          // 2 500 open tasks — far above the real ~65
const DELETE_CHUNK = 100

export type GhlTaskSyncResult = {
  fetched: number
  upserted: number
  removed: number
  per_location: { locationId: string; label: string; open: number; pruned: boolean }[]
  errors: string[]
}

/** One location's open tasks, keyset-paged on each row's `searchAfter`. */
export async function fetchOpenTasks(account: GHLAccount): Promise<GhlTaskSearchRow[]> {
  const out: GhlTaskSearchRow[] = []
  let after: unknown[] | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const body: Record<string, unknown> = { completed: false, limit: PAGE }
    if (after) body.searchAfter = after
    const res = await fetch(`${GHL_BASE}/locations/${account.locationId}/tasks/search`, {
      method: 'POST',
      headers: ghlHeaders(account.apiKey),
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`tasks/search ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const json = await res.json() as { tasks?: GhlTaskSearchRow[] }
    const rows = json.tasks ?? []
    out.push(...rows)
    if (rows.length < PAGE) break
    after = rows[rows.length - 1]?.searchAfter
    if (!after) break               // no cursor → stop rather than loop the same page
  }
  return out
}

/**
 * GHL contact id → one of our deals. A contact can own several deals (see
 * [[multi-loan-opportunity-matching]]), and a task points at the CONTACT, not
 * the loan — so there is no correct answer, only a useful one: the most
 * recently created deal, which is the one being worked.
 */
async function buildContactDealMap(
  supabase: ReturnType<typeof createServiceClient>,
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('deals')
      .select('id, ghl_contact_id, created_at')
      .not('ghl_contact_id', 'is', null)
      .order('created_at', { ascending: false })
      .range(from, from + 999)
    if (error) throw new Error(`deal map: ${error.message}`)
    for (const d of (data ?? []) as { id: string; ghl_contact_id: string }[]) {
      if (!map.has(d.ghl_contact_id)) map.set(d.ghl_contact_id, d.id)   // newest wins
    }
    if (!data || data.length < 1000) break
  }
  return map
}

export async function syncGhlTasks(
  supabase: ReturnType<typeof createServiceClient>,
  accounts: GHLAccount[] = getAccounts(),
): Promise<GhlTaskSyncResult> {
  const result: GhlTaskSyncResult = { fetched: 0, upserted: 0, removed: 0, per_location: [], errors: [] }
  if (accounts.length === 0) return result

  const nowIso = new Date().toISOString()
  let dealMap: Map<string, string>
  try {
    dealMap = await buildContactDealMap(supabase)
  } catch (e) {
    result.errors.push(String(e))
    dealMap = new Map()
  }
  const dealIdFor = (contactId: string | null | undefined) =>
    (contactId && dealMap.get(contactId)) || null

  for (const account of accounts) {
    let raw: GhlTaskSearchRow[]
    try {
      raw = await fetchOpenTasks(account)
    } catch (e) {
      // A location that failed to fetch is NOT pruned — otherwise one bad
      // response wipes that LO's whole task list off the board.
      result.errors.push(`${account.label}: ${String(e)}`)
      result.per_location.push({ locationId: account.locationId, label: account.label, open: 0, pruned: false })
      continue
    }
    result.fetched += raw.length

    const rows = raw
      .map(r => mapGhlTask(r, account.locationId, dealIdFor))
      .filter((r): r is GhlTaskRow => r != null)

    if (rows.length > 0) {
      const { error } = await supabase.from('ghl_tasks').upsert(
        rows.map(r => ({ ...r, last_seen_at: nowIso, updated_at: nowIso })),
        { onConflict: 'ghl_task_id' },
      )
      if (error) {
        result.errors.push(`${account.label} upsert: ${error.message}`)
        result.per_location.push({ locationId: account.locationId, label: account.label, open: rows.length, pruned: false })
        continue
      }
      result.upserted += rows.length
    }

    // Full replace for THIS location only.
    const { data: stale, error: readErr } = await supabase
      .from('ghl_tasks').select('ghl_task_id')
      .eq('location_id', account.locationId)
      .lt('last_seen_at', nowIso)
    if (readErr) {
      result.errors.push(`${account.label} stale read: ${readErr.message}`)
      result.per_location.push({ locationId: account.locationId, label: account.label, open: rows.length, pruned: false })
      continue
    }
    const ids = ((stale ?? []) as { ghl_task_id: string }[]).map(r => r.ghl_task_id)
    for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
      const slice = ids.slice(i, i + DELETE_CHUNK)
      const { error } = await supabase.from('ghl_tasks').delete().in('ghl_task_id', slice)
      if (error) result.errors.push(`${account.label} delete: ${error.message}`)
      else result.removed += slice.length
    }
    result.per_location.push({ locationId: account.locationId, label: account.label, open: rows.length, pruned: true })
  }

  return result
}
