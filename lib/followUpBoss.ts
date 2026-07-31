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
  /** When THEY last contacted us / when WE last contacted them (see below). */
  last_inbound_at: string | null
  last_outbound_at: string | null
  seen_by_keys: FubKeyLabel[]
}

// Directional contact timestamps. FUB exposes these per channel on the person
// payload (verified live 2026-07-30: 89–98% coverage across Past Client/Closed).
//
// ⚠️ OUTBOUND is PERSONAL channels only. lastSentBatchEmail /
// lastSentActionPlanEmail / lastDeliveredMarketingCampaign are deliberately
// excluded — 74 of Moe's past clients have ONLY a bulk send, and counting a
// marketing blast as "we contacted them" would hide exactly the people who
// have never actually been reached out to.
const INBOUND_FIELDS = ['lastReceivedEmail', 'lastReceivedText', 'lastIncomingCall', 'lastReceivedInboxAppMessage']
const OUTBOUND_FIELDS = ['lastSentEmail', 'lastSentText', 'lastOutgoingCall', 'lastSentInboxAppMessage']

function newestOf(p: FubPersonRaw, fields: string[]): string | null {
  const ts = fields
    .map(f => { const v = p[f]; return typeof v === 'string' ? Date.parse(v) : NaN })
    .filter(t => !isNaN(t))
  return ts.length ? new Date(Math.max(...ts)).toISOString() : null
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
    last_inbound_at: newestOf(p, INBOUND_FIELDS),
    last_outbound_at: newestOf(p, OUTBOUND_FIELDS),
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

/** Create a task in FUB. Verified 2026-07-30 end-to-end: `POST /v1/tasks` with
 *  {personId, name, type, dueDate, assignedUserId} returns the created task.
 *  dueDate is date-only (YYYY-MM-DD) — FUB's own task model has no time. */
export async function createFubTask(apiKey: string, t: {
  personId: number
  name: string
  type?: string
  dueDate?: string | null
  assignedUserId: number
}): Promise<FubTaskRaw> {
  const res = await fetch(`${FUB_BASE}/tasks`, {
    method: 'POST',
    headers: { ...fubHeaders(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personId: t.personId,
      name: t.name,
      type: t.type ?? 'Follow Up',
      assignedUserId: t.assignedUserId,
      ...(t.dueDate ? { dueDate: t.dueDate } : {}),
    }),
  })
  const body = await res.json().catch(() => null) as FubTaskRaw | null
  if (!res.ok || !body?.id) {
    throw new Error(`FUB ${res.status} creating task: ${JSON.stringify(body ?? {}).slice(0, 160)}`)
  }
  return body
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

// NARROWED 2026-07-30 (Efrain: "i do not want stale leads from FUB, what I do
// want are the leads in the Closed and past client stage"). FUB's people pull is
// now ONLY the past-client book — the working pipeline lives in GHL, and the
// stale-nurture pile it used to carry is gone.
export const SYNC_KEEP_STAGES = ['Past Client', 'Closed']

// An OPEN TASK overrides the stage/idle rules: the LO explicitly scheduled a
// follow-up on that person, so they belong in the cockpit whatever their stage
// says (55 of Matt's task people were being filtered out before this).
export function shouldStoreFubPerson(row: FubPersonRow, _now?: number, taskPersonIds?: Set<number>): boolean {
  if (row.assigned_user_id == null || !SYNC_LO_USER_IDS.includes(row.assigned_user_id)) return false
  // An open FUB task still overrides the stage rule — otherwise the tasks
  // section would render "FUB contact #12345" instead of the person's name.
  if (taskPersonIds?.has(row.fub_id)) return true
  return !!row.stage && SYNC_KEEP_STAGES.includes(row.stage)
}

// ── Unanswered inbound texts ("who messaged and nobody answered") ────────────
//
// FUB's real unread inbox is NOT reachable with agent keys (verified live
// 2026-07-30, probes in scratchpad/_probe-fub-unread*.ts):
//   • GET /v1/threads, /v1/conversations, /v1/notifications → 403 "You do not
//     have access to this API endpoint" (owner-only).
//   • GET /v1/me exposes `unreadConversationCount` — one integer, no drill-down.
//   • ⚠️ the per-message `read` flag is WORTHLESS as an unread signal: it was
//     false on 300/300 inbound messages (including weeks-old, certainly-read
//     ones) and true on 300/300 outbound. It's a delivery receipt, not the inbox.
//
// What DOES work: /v1/textMessages accepts `toNumber` / `fromNumber`, and the
// LO's own FUB calling number is on /v1/me. Paging both directions and comparing
// the newest inbound against the newest outbound per person reconstructs
// "waiting on you" — the same semantic the GHL half of the section uses.
//
// Not covered: FUB email (/v1/emails also demands a personId/threadId) and
// inbound calls (/v1/calls IS listable account-wide with isIncoming, if we ever
// want to fold missed calls in).

/** The slice of a /v1/textMessages row we read. */
export type FubTextMessage = {
  id: number
  personId: number
  name?: string | null
  created: string
  sent?: string | null
  isIncoming: boolean
  archived?: boolean
  message?: string | null
  userId?: number | null
  userName?: string | null
}

/** The slice of a /v1/calls row we read. */
export type FubCall = {
  id: number
  personId: number
  name?: string | null
  created: string
  startedAt?: string | null
  isIncoming: boolean
  duration?: number | null
  /** Incoming calls carry exactly two values (verified live): null = someone
   *  picked up, 'No Answer' = missed. */
  outcome?: string | null
  note?: string | null
  userId?: number | null
}

/** ⚠️ Duration is NOT the missed-call signal. 13 of 100 of Moe's incoming
 *  'No Answer' calls had a duration > 0 (up to 278s of voicemail), so a
 *  duration test would silently call an eighth of the missed calls "answered".
 *  `outcome` is the signal; incoming outcomes are only null or 'No Answer'. */
export function isMissedInboundCall(c: FubCall): boolean {
  return c.isIncoming && String(c.outcome ?? '').trim().toLowerCase() === 'no answer'
}

// ── Email ───────────────────────────────────────────────────────────────────
//
// ⚠️ There is NO account-wide inbound-email feed for an agent key. `/v1/emails`
// demands `id list, inboxThreadId, personId or personId and threadId`, and
// `/v1/events` carries only lead-source events (Registration / Seller Inquiry /
// Viewed Page — no email types). So email cannot be pulled the way texts and
// calls are.
//
// What DOES exist: the PERSON payload carries per-channel timestamps, including
// `lastReceivedEmail`. The hourly sweep already fetches every person with
// `fields=allFields`, so discovery costs nothing extra — it just has to happen
// on the sync rather than on the live request. The live route then verifies the
// (small) candidate list per person, so an email answered since the last sweep
// doesn't linger for an hour.

export type FubEmailRow = {
  id: number
  created: string
  date?: string | null
  /** Direction. Verified live: incoming emails carry 'Received', ours 'Sent'
   *  (there is no isIncoming field on this endpoint). */
  status?: string | null
  userId?: number | null
}

export const isReceivedEmail = (e: FubEmailRow) => String(e.status ?? '').trim().toLowerCase() === 'received'

/** A person whose newest personal contact is an email FROM them. */
export type FubEmailWaiting = {
  fubId: number
  name: string
  assignedUserId: number | null
  receivedAt: string
  lastResponseAt: string | null
}

/** Pure: email-waiting candidates from a people sweep.
 *
 * Responses are PERSONAL channels only — the same rule `last_outbound_at` uses.
 * Counting `lastSentBatchEmail` / `lastSentActionPlanEmail` /
 * `lastDeliveredMarketingCampaign` would let a marketing blast mark a real
 * inbound email "answered", which is the exact failure mode that rule exists
 * to prevent. */
export function emailWaitingFromPeople(people: FubPersonRaw[], cutoffMs: number): FubEmailWaiting[] {
  const seen = new Set<number>()
  const out: FubEmailWaiting[] = []
  for (const p of people) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    const recvIso = typeof p.lastReceivedEmail === 'string' ? p.lastReceivedEmail : null
    const recv = recvIso ? Date.parse(recvIso) : NaN
    if (isNaN(recv) || recv < cutoffMs) continue
    const respIso = newestOf(p, OUTBOUND_FIELDS)
    const resp = respIso ? Date.parse(respIso) : NaN
    if (!isNaN(resp) && resp >= recv) continue
    out.push({
      fubId: p.id,
      name: (p.name ?? '').trim() || `FUB contact #${p.id}`,
      assignedUserId: typeof p.assignedUserId === 'number' ? p.assignedUserId : null,
      receivedAt: new Date(recv).toISOString(),
      lastResponseAt: isNaN(resp) ? null : new Date(resp).toISOString(),
    })
  }
  return out.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
}

/** One person whose last inbound is unanswered — nobody has replied to them. */
export type FubUnanswered = {
  fubId: number
  name: string
  /** What they last reached out with — drives the row's wording. */
  channel: 'text' | 'call' | 'email'
  lastInboundAt: string
  lastOutboundAt: string | null
  preview: string | null
  assignedUserId: number | null
}

// ⚠️ Page to a TIME cutoff, never to a fixed page count.
//
// A fixed 3 pages each way shipped first and was wrong: outbound volume is much
// higher than inbound (drips, mass sends), so equal page counts cover UNEQUAL
// time. Measured live on Moe: 300 inbound reached 62 days back, 300 outbound
// only 52. Every reply older than that 52-day horizon was invisible, so anyone
// whose inbound landed in the 52–62 day gap looked unanswered forever — Tami
// Boteilho was flagged "texted 59d ago, nobody answered" when Moe had in fact
// replied 98 SECONDS later. Both directions must span the same window.
export const INBOX_LOOKBACK_DAYS = 90
const MAX_INBOX_PAGES = 14              // ≈1,400 msgs/direction; live 90d ≈ 7 pages
const MAX_VERIFY_LOOKUPS = 25           // per-person fallback when the cap bites

/** Digits-only US number ('(949) 868-9588' → '9498689588'), or null. */
export function normalizeFubNumber(raw: unknown): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '')
  const trimmed = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  return trimmed.length === 10 ? trimmed : null
}

const msgMs = (m: FubTextMessage) => Date.parse(m.sent || m.created)
const callMs = (c: FubCall) => Date.parse(c.startedAt || c.created)

/** Page newest-first until the oldest row is at/older than `untilMs`.
 *  `reached` is false when the page cap stopped us first — the caller must not
 *  trust "no reply" for anything older than `oldestMs` in that case. */
async function fetchFeedUntil<T extends { created: string }>(
  apiKey: string, endpoint: 'textMessages' | 'calls', collectionKeys: string[],
  query: string, untilMs: number, at: (row: T) => number,
): Promise<{ rows: T[]; oldestMs: number; reached: boolean }> {
  const all: T[] = []
  let url = `${FUB_BASE}/${endpoint}?${query}&limit=${PAGE_LIMIT}&sort=-created`
  let oldestMs = Infinity
  for (let page = 0; page < MAX_INBOX_PAGES; page++) {
    const data = await fubGet(url, apiKey)
    // ⚠️ collection keys are lower-cased by FUB ('textmessages', 'calls').
    let rows: T[] = []
    for (const k of collectionKeys) {
      const v = data[k] as T[] | undefined
      if (Array.isArray(v)) { rows = v; break }
    }
    all.push(...rows)
    for (const r of rows) {
      const t = at(r)
      if (!isNaN(t) && t < oldestMs) oldestMs = t
    }
    const meta = data._metadata as { nextLink?: string } | undefined
    if (!meta?.nextLink || rows.length === 0) return { rows: all, oldestMs, reached: true }
    if (oldestMs <= untilMs) return { rows: all, oldestMs, reached: true }
    url = meta.nextLink
    await sleep(PACE_MS)
  }
  return { rows: all, oldestMs, reached: false }
}

const fetchTextsUntil = (apiKey: string, query: string, untilMs: number) =>
  fetchFeedUntil<FubTextMessage>(apiKey, 'textMessages', ['textmessages', 'textMessages'], query, untilMs, msgMs)

const fetchCallsUntil = (apiKey: string, query: string, untilMs: number) =>
  fetchFeedUntil<FubCall>(apiKey, 'calls', ['calls'], query, untilMs, callMs)

/** This key's own FUB calling number, digits only. */
export async function fetchFubCallingNumber(apiKey: string): Promise<string | null> {
  const me = await fubGet(`${FUB_BASE}/me`, apiKey)
  return normalizeFubNumber(me.callingPhoneNumber ?? me.outboundNumber)
}

/** FUB redacts message bodies on some plans — it returns the literal string
 *  "* Body is hidden for privacy reasons *" (same treatment as recordingUrl).
 *  Rendering that in the inbox is worse than showing no preview at all. */
export function messagePreview(raw: string | null | undefined): string | null {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return null
  if (/^\*.*hidden for privacy reasons.*\*$/i.test(text)) return null
  return text.slice(0, 140)
}

// ── The unanswered model, across BOTH channels ──────────────────────────────
//
// Normalised to "touches" so texts and calls compare on one timeline:
//   INBOUND   = inbound texts  +  MISSED inbound calls
//   RESPONSES = outbound texts +  outbound calls  +  ANSWERED inbound calls
//
// An answered inbound call belongs on the RESPONSE side: they rang, someone
// picked up, the conversation happened — the ball is not in our court. And
// counting outbound calls means phoning someone back clears their unanswered
// text, which the text-only version got wrong.

export type FubTouch = {
  personId: number
  at: number                       // epoch ms
  name?: string | null
  channel: 'text' | 'call' | 'email'
  preview?: string | null
  userId?: number | null
}

export const textTouch = (m: FubTextMessage): FubTouch => ({
  personId: m.personId, at: msgMs(m), name: m.name, channel: 'text',
  preview: messagePreview(m.message), userId: m.userId ?? null,
})

export const callTouch = (c: FubCall): FubTouch => ({
  personId: c.personId, at: callMs(c), name: c.name, channel: 'call',
  // A call has no body; the LO's own note is the only useful context.
  preview: messagePreview(c.note), userId: c.userId ?? null,
})

/** Email candidates come from the cached people sweep, not a message feed —
 *  both sides of the comparison are already resolved on the person record. */
export const emailTouches = (w: FubEmailWaiting): { inbound: FubTouch; response: FubTouch | null } => ({
  inbound: {
    personId: w.fubId, at: Date.parse(w.receivedAt), name: w.name, channel: 'email',
    preview: null, userId: w.assignedUserId,
  },
  response: w.lastResponseAt
    ? { personId: w.fubId, at: Date.parse(w.lastResponseAt), name: w.name, channel: 'email', preview: null, userId: w.assignedUserId }
    : null,
})

/** Pure: newest inbound touch per person with no response at/after it. */
export function unansweredFromTouches(inbound: FubTouch[], responses: FubTouch[]): FubUnanswered[] {
  const newest = (list: FubTouch[]) => {
    const by = new Map<number, FubTouch>()
    for (const t of list) {
      if (isNaN(t.at)) continue
      const cur = by.get(t.personId)
      if (!cur || t.at > cur.at) by.set(t.personId, t)
    }
    return by
  }
  const lastIn = newest(inbound)
  const lastResp = newest(responses)

  const out: FubUnanswered[] = []
  for (const [personId, t] of lastIn) {
    const reply = lastResp.get(personId)
    if (reply && reply.at >= t.at) continue
    out.push({
      fubId: personId,
      name: t.name?.trim() || `FUB contact #${personId}`,
      channel: t.channel,
      lastInboundAt: new Date(t.at).toISOString(),
      lastOutboundAt: reply ? new Date(reply.at).toISOString() : null,
      preview: t.preview ?? null,
      assignedUserId: t.userId ?? null,
    })
  }
  return out.sort((a, b) => Date.parse(b.lastInboundAt) - Date.parse(a.lastInboundAt))
}

/** Texts-only convenience wrapper (kept for the message-level fixtures).
 *  An archived thread was deliberately cleared — it isn't waiting on anyone. */
export function unansweredFromMessages(
  inbound: FubTextMessage[],
  outbound: FubTextMessage[],
): FubUnanswered[] {
  return unansweredFromTouches(
    inbound.filter(m => m.isIncoming && !m.archived).map(textTouch),
    outbound.filter(m => !m.isIncoming).map(textTouch),
  )
}

/** Pure: does this person's own thread carry an outbound at/after `inboundIso`?
 *  The authoritative check — used to clear candidates the paged feeds can't
 *  vouch for, so a deep-history reply can never masquerade as "no answer". */
export function threadShowsReply(thread: FubTextMessage[], inboundIso: string, calls: FubCall[] = []): boolean {
  const at = Date.parse(inboundIso)
  if (isNaN(at)) return false
  if (thread.some(m => !m.isIncoming && msgMs(m) >= at)) return true
  // Same response rule as the main model: an outbound call, or an inbound one
  // that was actually picked up, both mean the conversation happened.
  return calls.some(c => (!c.isIncoming || !isMissedInboundCall(c)) && callMs(c) >= at)
}

/** Pure: does this person's email thread carry a 'Sent' at/after `inboundIso`? */
export function emailsShowReply(emails: FubEmailRow[], inboundIso: string): boolean {
  const at = Date.parse(inboundIso)
  if (isNaN(at)) return false
  return emails.some(e => {
    if (isReceivedEmail(e)) return false
    const t = Date.parse(e.date || e.created)
    return !isNaN(t) && t >= at
  })
}

/** Live "waiting on you" list for one agent key. Attribution is by the LO's own
 *  calling number, not by assignee: a text sent to Matt's number is Matt's
 *  conversation to answer even if the person is assigned to someone else. */
export async function fetchFubUnanswered(
  apiKey: string, label: FubKeyLabel,
  opts: { now?: number; emailCandidates?: FubEmailWaiting[] } = {},
): Promise<FubUnanswered[]> {
  const now = opts.now ?? Date.now()
  const number = await fetchFubCallingNumber(apiKey)
  if (!number) {
    console.warn(`[FUB] inbox '${label}': no calling number on /me — skipping`)
    return []
  }
  const cutoff = now - INBOX_LOOKBACK_DAYS * 86_400_000

  // ⚠️ On /calls, `toNumber` and `fromNumber` ARE honored but `userId` and
  // `isIncoming` are SILENTLY IGNORED (verified live: totals came back
  // unfiltered at 5,193/9,393 with both directions mixed in). Direction is
  // established by WHICH number filter we use, never by a query param.
  //
  // The four feeds are independent — run them together rather than paying for
  // each round-trip in series.
  const [textsIn, textsOut, callsIn, callsOut] = await Promise.all([
    fetchTextsUntil(apiKey, `toNumber=${number}`, cutoff),
    fetchTextsUntil(apiKey, `fromNumber=${number}`, cutoff),
    fetchCallsUntil(apiKey, `toNumber=${number}`, cutoff),
    fetchCallsUntil(apiKey, `fromNumber=${number}`, cutoff),
  ])

  // Email rides in from the cached people sweep — there is no feed to page.
  const emailPairs = (opts.emailCandidates ?? [])
    .filter(w => Date.parse(w.receivedAt) >= cutoff)
    .map(emailTouches)

  const inbound: FubTouch[] = [
    ...textsIn.rows.filter(m => m.isIncoming && !m.archived && msgMs(m) >= cutoff).map(textTouch),
    ...callsIn.rows.filter(c => isMissedInboundCall(c) && callMs(c) >= cutoff).map(callTouch),
    ...emailPairs.map(e => e.inbound),
  ]
  const responses: FubTouch[] = [
    ...textsOut.rows.filter(m => !m.isIncoming).map(textTouch),
    ...callsOut.rows.filter(c => !c.isIncoming).map(callTouch),
    // They rang, someone picked up — that IS the conversation.
    ...callsIn.rows.filter(c => c.isIncoming && !isMissedInboundCall(c)).map(callTouch),
    // The person record's own newest personal response (covers a reply BY EMAIL,
    // which no feed above can see).
    ...emailPairs.map(e => e.response).filter((t): t is FubTouch => t != null),
  ]

  const items = unansweredFromTouches(inbound, responses)

  // A candidate is only PROVEN unanswered if every response feed covers its
  // inbound moment. The shallowest response horizon governs.
  const horizon = Math.min(textsOut.oldestMs, callsOut.oldestMs, callsIn.oldestMs)
  // Email candidates ALWAYS get verified regardless of the horizon: they come
  // from the hourly sweep, so a reply sent since then is invisible to them.
  const suspect = items.filter(i => i.channel === 'email' || Date.parse(i.lastInboundAt) < horizon)
  const cleared = new Set<number>()
  if (suspect.length > 0) {
    console.warn(`[FUB] inbox '${label}': response horizon ${new Date(horizon).toISOString()} — verifying ${suspect.length} older candidate(s)`)
    for (const s of suspect.slice(0, MAX_VERIFY_LOOKUPS)) {
      try {
        const [tData, cData] = await Promise.all([
          fubGet(`${FUB_BASE}/textMessages?personId=${s.fubId}&limit=${PAGE_LIMIT}&sort=-created`, apiKey),
          fubGet(`${FUB_BASE}/calls?personId=${s.fubId}&limit=${PAGE_LIMIT}&sort=-created`, apiKey),
        ])
        const thread = (tData.textmessages as FubTextMessage[] | undefined) ?? []
        const calls = (cData.calls as FubCall[] | undefined) ?? []
        if (threadShowsReply(thread, s.lastInboundAt, calls)) { cleared.add(s.fubId); continue }
        // Email is the one channel with no bulk feed — check the person's own
        // thread for a 'Sent' at/after their newest 'Received'.
        const eData = await fubGet(`${FUB_BASE}/emails?personId=${s.fubId}&limit=${PAGE_LIMIT}&sort=-created`, apiKey)
        const emails = (eData.emails as FubEmailRow[] | undefined) ?? []
        if (emailsShowReply(emails, s.lastInboundAt)) cleared.add(s.fubId)
      } catch (e) {
        // Can't prove they were answered → leave them listed. A false "waiting"
        // costs a glance; a false "all clear" loses the client.
        console.warn(`[FUB] inbox '${label}': verify failed for ${s.fubId}:`, e instanceof Error ? e.message : e)
      }
      await sleep(PACE_MS)
    }
    if (suspect.length > MAX_VERIFY_LOOKUPS) {
      console.warn(`[FUB] inbox '${label}': ${suspect.length - MAX_VERIFY_LOOKUPS} candidate(s) left UNVERIFIED (lookup cap)`)
    }
  }

  const final = items.filter(i => !cleared.has(i.fubId))
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  console.log(
    `[FUB] inbox '${label}': texts ${textsIn.rows.length}in/${textsOut.rows.length}out, ` +
    `calls ${callsIn.rows.length}in/${callsOut.rows.length}out (horizon ${day(horizon)}) → ` +
    `${final.length} unanswered (${final.filter(i => i.channel === 'call').length} missed calls, ` +
    `${final.filter(i => i.channel === 'email').length} emails), ${cleared.size} cleared on verify`)
  return final
}

// ── Diff against existing table state ────────────────────────────────────────

/** The slice of an existing DB row the differ compares against. */
export type ExistingFubRow = {
  fub_id: number
  fub_updated_at: string | null
  last_activity_at: string | null
  last_inbound_at: string | null
  last_outbound_at: string | null
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
      // Contact dates move without `updated` moving, and they're the whole point
      // of the past-client view — so they're part of change detection.
      !tsEq(ex.last_inbound_at, row.last_inbound_at) ||
      !tsEq(ex.last_outbound_at, row.last_outbound_at) ||
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
