// FollowUpBoss (FUB) API client + person→row mapping for the follow-up cockpit.
// Research: docs/research/2026-07-30-followupboss-api.md
//
// Account topology (verified live 2026-07-30): ONE shared FUB account (1376431815)
// where Moe and Matt are agent-level users. Each agent key sees only people
// assigned to that user or shared with them — and the two books OVERLAP (Matt's
// key sees dozens of Moe's people). So:
//   • sweep with BOTH keys, dedupe by fub_id,
//   • ownership = assignedUserId (72 Moe / 13 Matt / 35 Randy), NEVER "which key
//     fetched the row".
//
// API facts the code below depends on (all verified against live probes + docs):
//   • HTTP Basic auth, key as username, blank password.
//   • Pagination: limit max 100, keyset cursor via _metadata.nextLink (offset
//     pagination is rejected for deep pages — always follow nextLink).
//   • Rate limit: global 125 req / sliding 10s for unregistered systems; 429
//     carries Retry-After seconds and must be honored.
//   • ⚠️ Undocumented query params are SILENTLY WRONG (updatedAfter=… returned
//     total:0, not an error). Only documented params are used here.

import { normEmail, normPhone } from './dealMatcher'
import { resolveLO } from './loanOfficer'

const FUB_BASE = 'https://api.followupboss.com/v1'

// FUB userId → dashboard LO name. assignedTo (display name) is the fallback via
// resolveLO so a rename in FUB degrades gracefully instead of orphaning rows.
export const FUB_USER_TO_LO: Record<number, string> = {
  72: 'Moe Sefati',
  13: 'Matt Park',
  35: 'Randy Mathis',
}

export type FubKeyLabel = 'moe' | 'matt'

export type FubEmail = { value?: string; type?: string; isPrimary?: number | boolean; status?: string }
export type FubPhone = { value?: string; type?: string; isPrimary?: number | boolean; status?: string }
export type FubAddress = { type?: string; street?: string; city?: string; state?: string; code?: string }

// The subset of the FUB person payload we read (fields=allFields returns more).
export type FubPersonRaw = {
  id: number
  name?: string | null
  firstName?: string | null
  lastName?: string | null
  stage?: string | null
  source?: string | null
  assignedUserId?: number | null
  assignedTo?: string | null
  emails?: FubEmail[] | null
  phones?: FubPhone[] | null
  addresses?: FubAddress[] | null
  tags?: string[] | null
  price?: number | null
  dealName?: string | null
  dealStage?: string | null
  dealStatus?: string | null
  dealPrice?: number | null
  dealCloseDate?: string | null
  created?: string | null
  updated?: string | null
  lastActivity?: string | null
} & Record<string, unknown>   // custom* fields ride along

// One row of the fub_people table (sync-owned columns only — the cockpit-state
// columns next_action_due/next_action/last_touched_at/last_touch_note are UI-owned
// and deliberately NOT part of this type, so the sync CANNOT write them).
export type FubPersonRow = {
  fub_id: number
  name: string | null
  first_name: string | null
  last_name: string | null
  stage: string | null
  source: string | null
  assigned_user_id: number | null
  assigned_to: string | null
  loan_officer: string | null
  primary_email: string | null
  primary_phone: string | null
  emails: FubEmail[] | null
  phones: FubPhone[] | null
  tags: string[] | null
  price: number | null
  deal_name: string | null
  deal_stage: string | null
  deal_status: string | null
  deal_price: number | null
  deal_close_date: string | null
  address_city: string | null
  address_state: string | null
  custom_fields: Record<string, unknown> | null
  fub_created_at: string | null
  fub_updated_at: string | null
  last_activity_at: string | null
  seen_by_keys: FubKeyLabel[]
}

// ── Fetching ─────────────────────────────────────────────────────────────────

const PAGE_LIMIT = 100
const PACE_MS = 150            // ~7 req/s — far inside 125/10s even with two sweeps
const MAX_PAGES = 120          // hard stop ≈ 12k people per key (Matt is ~4.2k today)

function fubHeaders(apiKey: string) {
  return {
    Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
    Accept: 'application/json',
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function fubGet(url: string, apiKey: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: fubHeaders(apiKey) })
    if (res.status === 429) {
      // Docs: honor Retry-After even when X-RateLimit-Remaining says otherwise.
      const retryAfter = Number(res.headers.get('retry-after') ?? '5')
      await sleep(Math.min(Math.max(retryAfter, 1), 30) * 1000)
      continue
    }
    if (!res.ok) throw new Error(`FUB ${res.status} on ${url.replace(/limit=\d+/, 'limit=…')}`)
    return await res.json() as Record<string, unknown>
  }
  throw new Error('FUB rate-limited 3x in a row — aborting sweep')
}

/** Full sweep of one agent key's visible people (keyset pagination). */
export async function fetchAllFubPeople(apiKey: string, label: FubKeyLabel): Promise<FubPersonRaw[]> {
  const all: FubPersonRaw[] = []
  let url = `${FUB_BASE}/people?limit=${PAGE_LIMIT}&fields=allFields`
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await fubGet(url, apiKey)
    const people = (data.people as FubPersonRaw[] | undefined) ?? []
    all.push(...people)
    const meta = data._metadata as { nextLink?: string; total?: number } | undefined
    if (!meta?.nextLink || people.length === 0) break
    url = meta.nextLink
    await sleep(PACE_MS)
  }
  console.log(`[FUB] sweep '${label}': ${all.length} people`)
  return all
}

// ── Mapping ──────────────────────────────────────────────────────────────────

function primaryOf<T extends { value?: string; isPrimary?: number | boolean }>(arr: T[] | null | undefined): string | null {
  if (!arr?.length) return null
  const prim = arr.find(e => e.isPrimary === 1 || e.isPrimary === true)
  return (prim ?? arr[0])?.value ?? null
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null
  const t = Date.parse(v)
  return isNaN(t) ? null : new Date(t).toISOString()
}

/** Map one FUB person payload to a fub_people row (sync-owned columns). */
export function mapFubPerson(p: FubPersonRaw, seenBy: FubKeyLabel[]): FubPersonRow {
  const custom: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(p)) {
    if (k.startsWith('custom') && v != null && v !== '') custom[k] = v
  }
  const addr = p.addresses?.[0]
  const lo = (p.assignedUserId != null && FUB_USER_TO_LO[p.assignedUserId])
    || resolveLO(p.assignedTo)
    || null
  return {
    fub_id: p.id,
    name: p.name ?? null,
    first_name: p.firstName ?? null,
    last_name: p.lastName ?? null,
    stage: p.stage ?? null,
    source: p.source ?? null,
    assigned_user_id: p.assignedUserId ?? null,
    assigned_to: p.assignedTo ?? null,
    loan_officer: lo,
    primary_email: normEmail(primaryOf(p.emails)),
    primary_phone: normPhone(primaryOf(p.phones)),
    emails: p.emails ?? null,
    phones: p.phones ?? null,
    tags: p.tags ?? null,
    price: p.price ?? null,
    deal_name: p.dealName ?? null,
    deal_stage: p.dealStage ?? null,
    deal_status: p.dealStatus ?? null,
    deal_price: p.dealPrice ?? null,
    deal_close_date: p.dealCloseDate ? String(p.dealCloseDate).slice(0, 10) : null,
    address_city: addr?.city ?? null,
    address_state: addr?.state ?? null,
    custom_fields: Object.keys(custom).length ? custom : null,
    fub_created_at: isoOrNull(p.created),
    fub_updated_at: isoOrNull(p.updated),
    last_activity_at: isoOrNull(p.lastActivity),
    seen_by_keys: seenBy,
  }
}

/** Merge the two key sweeps into one row set, deduped by fub_id (books overlap). */
export function mergeSweeps(moe: FubPersonRaw[], matt: FubPersonRaw[]): FubPersonRow[] {
  const byId = new Map<number, { raw: FubPersonRaw; seen: FubKeyLabel[] }>()
  for (const p of moe) byId.set(p.id, { raw: p, seen: ['moe'] })
  for (const p of matt) {
    const hit = byId.get(p.id)
    if (hit) hit.seen.push('matt')     // same person, both books — keep one row
    else byId.set(p.id, { raw: p, seen: ['matt'] })
  }
  return [...byId.values()].map(({ raw, seen }) => mapFubPerson(raw, seen))
}

// ── Tasks ────────────────────────────────────────────────────────────────────
// The LO's own FUB follow-up reminders. Tasks are strictly PER KEY (Moe's key
// returns only Moe's 277, Matt's only his 698 — verified 2026-07-30), so no
// dedupe and loan_officer is unambiguous.
//
// ⚠️ Filter params must be the DOCUMENTED ones: `isCompleted`, `due`
// (today|overdue|upcoming), `dueStart`/`dueEnd`. An earlier probe using
// `status=`/`dueDateFrom=` was silently ignored and returned the unfiltered
// 6,949 — which is what made tasks look unfilterable. They are not.

export type FubTaskRaw = {
  id: number
  personId?: number | null
  assignedUserId?: number | null
  AssignedTo?: string | null
  name?: string | null
  type?: string | null
  dueDate?: string | null          // 'YYYY-MM-DD'
  dueDateTime?: string | null      // set only when the task has a time
  isCompleted?: number | boolean | null
  created?: string | null
  updated?: string | null
}

export type FubTaskRow = {
  fub_task_id: number
  person_id: number | null
  assigned_user_id: number | null
  loan_officer: string | null
  name: string | null
  type: string | null
  due_date: string | null
  due_date_time: string | null
  fub_created_at: string | null
  fub_updated_at: string | null
}

/** Sweep this key's INCOMPLETE tasks (975 across both LOs — ~10 requests).
 *
 * ⚠️ NO `sort=` here. Sorting by a non-unique column (dueDate) drops FUB off
 * keyset pagination onto offsets, and the pages then drift — the first run
 * re-served rows and Postgres rejected the batch with "ON CONFLICT DO UPDATE
 * command cannot affect row a second time". Default id-descending order is
 * keyset-stable; the display sort happens locally anyway. */
export async function fetchOpenFubTasks(apiKey: string, label: FubKeyLabel): Promise<FubTaskRaw[]> {
  const all: FubTaskRaw[] = []
  let url = `${FUB_BASE}/tasks?limit=${PAGE_LIMIT}&isCompleted=false`
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await fubGet(url, apiKey)
    const tasks = (data.tasks as FubTaskRaw[] | undefined) ?? []
    all.push(...tasks)
    const meta = data._metadata as { nextLink?: string } | undefined
    if (!meta?.nextLink || tasks.length === 0) break
    url = meta.nextLink
    await sleep(PACE_MS)
  }
  console.log(`[FUB] tasks '${label}': ${all.length} open`)
  return all
}

/** Mark a task complete in FUB. Verified 2026-07-30 against a live task:
 *  `PUT /v1/tasks/:id` with `{isCompleted: true}` → 200 + the updated task.
 *  (FUB returns isCompleted as 0/1, not a boolean.) Runs in the global
 *  125 req/10s bucket, so single clicks need no pacing. */
export async function completeFubTask(apiKey: string, taskId: number): Promise<void> {
  const res = await fetch(`${FUB_BASE}/tasks/${taskId}`, {
    method: 'PUT',
    headers: { ...fubHeaders(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({ isCompleted: true }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`FUB ${res.status} completing task ${taskId}: ${body.slice(0, 160)}`)
  }
}

/** Last-write-wins dedupe by task id — a paginated sweep can still re-serve a
 *  row if tasks are created mid-sweep, and one duplicate rejects the whole batch. */
export function dedupeTasks(rows: FubTaskRow[]): FubTaskRow[] {
  const byId = new Map<number, FubTaskRow>()
  for (const r of rows) byId.set(r.fub_task_id, r)
  return [...byId.values()]
}

export function mapFubTask(t: FubTaskRaw): FubTaskRow {
  const lo = (t.assignedUserId != null && FUB_USER_TO_LO[t.assignedUserId])
    || resolveLO(t.AssignedTo)
    || null
  return {
    fub_task_id: t.id,
    person_id: t.personId ?? null,
    assigned_user_id: t.assignedUserId ?? null,
    loan_officer: lo,
    name: t.name ?? null,
    type: t.type ?? null,
    due_date: t.dueDate ? String(t.dueDate).slice(0, 10) : null,
    due_date_time: isoOrNull(t.dueDateTime),
    fub_created_at: isoOrNull(t.created),
    fub_updated_at: isoOrNull(t.updated),
  }
}

// ── Pull filter — what deserves to be STORED at all ──────────────────────────
// Efrain 2026-07-30: "I do not want all contacts to be pulled since a lot of
// contacts will not be necessary to follow up on." The sweep therefore keeps
// only follow-up-worthy people; everything else never enters fub_people:
//   • must be ASSIGNED to a cockpit LO (Moe 72 / Matt 13) — pond/unassigned/
//     other agents' people never render anyway (993 dead rows at decision time),
//   • junk + dead-by-definition stages are dropped entirely,
//   • raw lead stages (never-worked purchased leads) qualify only with activity
//     in the last 90 days — of ~1,800 raw leads only 37 passed that bar.

export const SYNC_LO_USER_IDS = [72, 13]              // Moe, Matt (Randy=35 would join here)
export const SYNC_EXCLUDED_STAGES = ['Trash', 'Referred Out', 'Unresponsive', 'Inactive']
export const RAW_LEAD_STAGES = ['Lead', 'Attempting Contact']
export const RAW_LEAD_MAX_IDLE_DAYS = 90

// An OPEN TASK overrides the stage/idle rules: the LO explicitly scheduled a
// follow-up on that person, so they belong in the cockpit whatever their stage
// says (55 of Matt's task people were being filtered out before this).
export function shouldStoreFubPerson(row: FubPersonRow, now?: number, taskPersonIds?: Set<number>): boolean {
  if (row.assigned_user_id == null || !SYNC_LO_USER_IDS.includes(row.assigned_user_id)) return false
  if (taskPersonIds?.has(row.fub_id)) return true
  if (!row.stage || SYNC_EXCLUDED_STAGES.includes(row.stage)) return false
  if (RAW_LEAD_STAGES.includes(row.stage)) {
    const ts = [row.last_activity_at, row.fub_created_at]
      .map(v => (v ? Date.parse(v) : NaN))
      .filter(t => !isNaN(t))
    if (ts.length === 0) return false
    if ((now ?? Date.now()) - Math.max(...ts) > RAW_LEAD_MAX_IDLE_DAYS * 86_400_000) return false
  }
  return true
}

// ── Diff against existing table state ────────────────────────────────────────

/** The slice of an existing DB row the differ compares against. */
export type ExistingFubRow = {
  fub_id: number
  fub_updated_at: string | null
  last_activity_at: string | null
  stage: string | null
  assigned_user_id: number | null
  missing_since: string | null
}

export type SweepDiff = {
  toInsert: FubPersonRow[]
  toUpdate: FubPersonRow[]     // changed rows (incl. resurrected ones)
  missingIds: number[]         // in DB, absent from sweep, not already flagged
}

// Timestamp equality across FORMATS: PostgREST returns timestamptz as
// '2026-07-30T18:04:51+00:00' while the mapper emits '….000Z'. A raw string
// compare called every row "changed" on an unchanged sweep (caught live
// 2026-07-30: re-run updated 5,212/5,212). Compare epoch ms instead.
const tsEq = (a: string | null, b: string | null): boolean => {
  const ta = a == null ? null : Date.parse(a)
  const tb = b == null ? null : Date.parse(b)
  const na = ta == null || isNaN(ta) ? null : ta
  const nb = tb == null || isNaN(tb) ? null : tb
  return na === nb
}

/** Pure diff: what to insert, what to update, what went missing. */
export function diffSweep(swept: FubPersonRow[], existing: ExistingFubRow[]): SweepDiff {
  const existingById = new Map(existing.map(r => [r.fub_id, r]))
  const sweptIds = new Set(swept.map(r => r.fub_id))
  const toInsert: FubPersonRow[] = []
  const toUpdate: FubPersonRow[] = []
  for (const row of swept) {
    const ex = existingById.get(row.fub_id)
    if (!ex) { toInsert.push(row); continue }
    const changed =
      !tsEq(ex.fub_updated_at, row.fub_updated_at) ||
      !tsEq(ex.last_activity_at, row.last_activity_at) ||
      ex.stage !== row.stage ||
      ex.assigned_user_id !== row.assigned_user_id ||
      ex.missing_since != null            // was flagged missing, is visible again
    if (changed) toUpdate.push(row)
  }
  const missingIds = existing
    .filter(r => !sweptIds.has(r.fub_id) && r.missing_since == null)
    .map(r => r.fub_id)
  return { toInsert, toUpdate, missingIds }
}
