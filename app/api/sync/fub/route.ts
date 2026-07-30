import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import {
  fetchAllFubPeople, fetchOpenFubTasks, mapFubTask, dedupeTasks, mergeSweeps, diffSweep, shouldStoreFubPerson,
  type ExistingFubRow, type FubPersonRow, type FubKeyLabel, type FubTaskRow,
} from '@/lib/followUpBoss'
import { isOpenLead } from '@/lib/triage'

// FollowUpBoss → fub_people sweep. Spec: docs/specs/2026-07-30-follow-up-cockpit-spec.md
//
// Polling integration (FUB webhooks are account-owner-only — verified 2026-07-30).
// Full sweep of both agent keys (~63 requests, well inside FUB's 125 req/10s),
// merged + deduped by fub_id, diffed against the table so unchanged rows cost
// nothing. Triggered by the ghl-sync cron piggyback (55-min gate) and by the
// cockpit's "Sync now" button (?force=1).
//
// ⚠️ This sync NEVER writes the cockpit-state columns (next_action_due,
// next_action, last_touched_at, last_touch_note) — those belong to the UI, the
// same way the GHL sync never writes deals.next_action_due.

export const maxDuration = 300

const FUB_SYNC_KEY = 'fub_sync_last'
const MIN_INTERVAL_MS = 55 * 60 * 1000   // cron pings every 15 min; FUB runs ~hourly
const INSERT_CHUNK = 500
const UPDATE_CONCURRENCY = 10
const MISSING_CHUNK = 200

export type FubSyncResult = {
  ok: boolean
  skipped?: 'interval' | 'no_keys'
  people?: number
  inserted?: number
  updated?: number
  matchOnly?: number
  missingFlagged?: number
  matchedActive?: number
  tasks?: number
  tasksRemoved?: number
  duration_ms?: number
  errors: string[]
}

type MinimalDeal = {
  id: string
  email: string | null
  phone: string | null
  status: string
  ghl_status: string | null
  pipeline_group: string | null
}

// Deals a FUB person can be "actively driven by": open opportunity in the two
// working groups. Old Deals / Funded / Not Ready still MATCH (identity link)
// but don't suppress the FUB row — a funded past client should absolutely show
// in the past-client farming section.
function isActiveDeal(d: MinimalDeal): boolean {
  return isOpenLead(d) && (d.pipeline_group === 'Leads' || d.pipeline_group === 'Loans in Process')
}

async function fetchExistingRows(supabase: ReturnType<typeof createServiceClient>) {
  const all: (ExistingFubRow & { matched_deal_id: string | null; matched_deal_active: boolean })[] = []
  const PAGE = 1000
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from('fub_people')
      .select('fub_id, fub_updated_at, last_activity_at, last_inbound_at, last_outbound_at, stage, assigned_user_id, missing_since, matched_deal_id, matched_deal_active')
      .range(offset, offset + PAGE - 1)
    if (error) throw new Error(`fub_people read: ${error.message}`)
    all.push(...(data ?? []) as typeof all)
    if (!data || data.length < PAGE) break
  }
  return all
}

async function fetchDealsForMatching(supabase: ReturnType<typeof createServiceClient>): Promise<MinimalDeal[]> {
  const all: MinimalDeal[] = []
  const PAGE = 1000
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from('deals')
      .select('id, email, phone, status, ghl_status, pipeline_group')
      .range(offset, offset + PAGE - 1)
    if (error) throw new Error(`deals read: ${error.message}`)
    all.push(...(data ?? []) as MinimalDeal[])
    if (!data || data.length < PAGE) break
  }
  return all
}

export async function runFubSync(opts: { force?: boolean } = {}): Promise<FubSyncResult> {
  const t0 = Date.now()
  const errors: string[] = []
  const keys: { label: FubKeyLabel; key: string }[] = []
  if (process.env.FUB_API_KEY_MOE) keys.push({ label: 'moe', key: process.env.FUB_API_KEY_MOE })
  if (process.env.FUB_API_KEY_MATT) keys.push({ label: 'matt', key: process.env.FUB_API_KEY_MATT })
  if (keys.length === 0) return { ok: false, skipped: 'no_keys', errors: ['FUB_API_KEY_MOE / FUB_API_KEY_MATT not set'] }

  const supabase = createServiceClient()

  if (!opts.force) {
    const { data } = await supabase.from('sync_state').select('value').eq('key', FUB_SYNC_KEY).maybeSingle()
    const lastAt = (data?.value as { last_at?: string } | null)?.last_at
    if (lastAt && Date.now() - Date.parse(lastAt) < MIN_INTERVAL_MS) {
      return { ok: true, skipped: 'interval', errors: [] }
    }
  }

  // ── Sweep both keys. A failed sweep aborts the whole run BEFORE any diff —
  // a partial sweep must never mass-flag the other book as missing.
  const sweeps: Partial<Record<FubKeyLabel, Awaited<ReturnType<typeof fetchAllFubPeople>>>> = {}
  const sweptTasks: FubTaskRow[] = []
  for (const { label, key } of keys) {
    sweeps[label] = await fetchAllFubPeople(key, label)   // throws on failure → caught by POST/cron caller
    // Tasks are per-key in FUB, so each key contributes only its own LO's tasks.
    sweptTasks.push(...(await fetchOpenFubTasks(key, label)).map(mapFubTask))
  }
  const taskRows = dedupeTasks(sweptTasks)
  // People with an open task are follow-up-worthy by definition — they bypass
  // the stage/idle rules below.
  const taskPersonIds = new Set(taskRows.map(t => t.person_id).filter((id): id is number => id != null))
  // Pull filter: only follow-up-worthy people are stored (see shouldStoreFubPerson).
  // Rows already in the table that stop qualifying fall out via the normal
  // missing_since flow — the queue never shows flagged rows.
  const raw = mergeSweeps(sweeps.moe ?? [], sweeps.matt ?? [])
  const merged = raw.filter(r => shouldStoreFubPerson(r, Date.now(), taskPersonIds))
  if (merged.length < 100) {
    return { ok: false, errors: [`sweep suspiciously small (${merged.length} of ${raw.length} kept) — aborting before diff`] }
  }
  console.log(`[FUB sync] pull filter: ${merged.length} of ${raw.length} visible people qualify`)

  // ── Cross-match against deals by normalized email/phone (identity link).
  const deals = await fetchDealsForMatching(supabase)
  const byEmail = new Map<string, MinimalDeal>()
  const byPhone = new Map<string, MinimalDeal>()
  for (const d of deals) {
    // Active deals win the slot so suppression is computed off the strongest match.
    if (d.email) {
      const k = d.email.toLowerCase().trim()
      const cur = byEmail.get(k)
      if (!cur || (!isActiveDeal(cur) && isActiveDeal(d))) byEmail.set(k, d)
    }
    if (d.phone) {
      const k = String(d.phone).replace(/\D/g, '').slice(-10)
      if (k.length === 10) {
        const cur = byPhone.get(k)
        if (!cur || (!isActiveDeal(cur) && isActiveDeal(d))) byPhone.set(k, d)
      }
    }
  }
  const matchOf = (r: FubPersonRow): { id: string | null; active: boolean } => {
    const hit = (r.primary_email && byEmail.get(r.primary_email)) || (r.primary_phone && byPhone.get(r.primary_phone)) || null
    return hit ? { id: hit.id, active: isActiveDeal(hit) } : { id: null, active: false }
  }

  // ── Diff and write.
  const existing = await fetchExistingRows(supabase)
  const diff = diffSweep(merged, existing)
  const existingById = new Map(existing.map(r => [r.fub_id, r]))
  const nowIso = new Date().toISOString()

  const withMatch = (r: FubPersonRow) => {
    const m = matchOf(r)
    return { ...r, matched_deal_id: m.id, matched_deal_active: m.active, missing_since: null, last_seen_at: nowIso, updated_at: nowIso }
  }

  let inserted = 0, updated = 0, matchOnly = 0
  for (let i = 0; i < diff.toInsert.length; i += INSERT_CHUNK) {
    const slice = diff.toInsert.slice(i, i + INSERT_CHUNK).map(withMatch)
    const { error } = await supabase.from('fub_people').insert(slice)
    if (error) errors.push(`insert: ${error.message}`)
    else inserted += slice.length
  }

  const updates = diff.toUpdate.map(withMatch)
  for (let i = 0; i < updates.length; i += UPDATE_CONCURRENCY) {
    await Promise.all(updates.slice(i, i + UPDATE_CONCURRENCY).map(async row => {
      const { fub_id, ...fields } = row
      const { error } = await supabase.from('fub_people').update(fields).eq('fub_id', fub_id)
      if (error) errors.push(`update ${fub_id}: ${error.message}`)
      else updated++
    }))
  }

  // Rows untouched by the diff whose deal-match changed (e.g. their GHL deal
  // just closed → they should reappear in the FUB queue). Update ONLY the match columns.
  const updatedIds = new Set([...diff.toInsert, ...diff.toUpdate].map(r => r.fub_id))
  const matchFixes = merged.filter(r => {
    if (updatedIds.has(r.fub_id)) return false
    const ex = existingById.get(r.fub_id)
    if (!ex) return false
    const m = matchOf(r)
    return ex.matched_deal_id !== m.id || ex.matched_deal_active !== m.active
  })
  for (let i = 0; i < matchFixes.length; i += UPDATE_CONCURRENCY) {
    await Promise.all(matchFixes.slice(i, i + UPDATE_CONCURRENCY).map(async r => {
      const m = matchOf(r)
      const { error } = await supabase.from('fub_people')
        .update({ matched_deal_id: m.id, matched_deal_active: m.active, updated_at: nowIso })
        .eq('fub_id', r.fub_id)
      if (error) errors.push(`match-fix ${r.fub_id}: ${error.message}`)
      else matchOnly++
    }))
  }

  let missingFlagged = 0
  for (let i = 0; i < diff.missingIds.length; i += MISSING_CHUNK) {
    const slice = diff.missingIds.slice(i, i + MISSING_CHUNK)
    const { error } = await supabase.from('fub_people')
      .update({ missing_since: nowIso, updated_at: nowIso })
      .in('fub_id', slice)
    if (error) errors.push(`missing-flag: ${error.message}`)
    else missingFlagged += slice.length
  }

  // ── Open tasks: full replace. Only INCOMPLETE tasks are swept, so a task that
  // vanished was completed or deleted — either way it leaves the follow-up list.
  let tasksRemoved = 0
  {
    const { error } = await supabase.from('fub_tasks').upsert(
      taskRows.map(t => ({ ...t, last_seen_at: nowIso, updated_at: nowIso })),
      { onConflict: 'fub_task_id' },
    )
    if (error) errors.push(`tasks upsert: ${error.message}`)
    else {
      const { data: stale, error: e2 } = await supabase
        .from('fub_tasks').select('fub_task_id').lt('last_seen_at', nowIso)
      if (e2) errors.push(`tasks stale read: ${e2.message}`)
      else if (stale?.length) {
        const ids = (stale as { fub_task_id: number }[]).map(r => r.fub_task_id)
        for (let i = 0; i < ids.length; i += MISSING_CHUNK) {
          const { error: e3 } = await supabase.from('fub_tasks').delete().in('fub_task_id', ids.slice(i, i + MISSING_CHUNK))
          if (e3) errors.push(`tasks delete: ${e3.message}`)
          else tasksRemoved += Math.min(MISSING_CHUNK, ids.length - i)
        }
      }
    }
  }

  await supabase.from('sync_state').upsert({
    key: FUB_SYNC_KEY,
    value: { last_at: nowIso, people: merged.length, tasks: taskRows.length },
    updated_at: nowIso,
  })

  const matchedActive = merged.filter(r => matchOf(r).active).length
  const result: FubSyncResult = {
    ok: errors.length === 0,
    people: merged.length,
    inserted, updated, matchOnly, missingFlagged, matchedActive,
    tasks: taskRows.length, tasksRemoved,
    duration_ms: Date.now() - t0,
    errors,
  }
  console.log('[FUB sync]', JSON.stringify(result))
  return result
}

/** Last-sweep info for the cockpit header (sync_state has no client policies). */
export async function GET() {
  const supabase = createServiceClient()
  const { data } = await supabase.from('sync_state').select('value').eq('key', FUB_SYNC_KEY).maybeSingle()
  const v = (data?.value as { last_at?: string; people?: number } | null) ?? null
  return NextResponse.json({ last_at: v?.last_at ?? null, people: v?.people ?? null })
}

export async function POST(req: NextRequest) {
  const force = new URL(req.url).searchParams.get('force') === '1'
  try {
    const result = await runFubSync({ force })
    return NextResponse.json(result, { status: result.ok || result.skipped ? 200 : 500 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[FUB sync] failed:', msg)
    return NextResponse.json({ ok: false, errors: [msg] }, { status: 500 })
  }
}
