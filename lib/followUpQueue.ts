// Follow-Up Cockpit queue model — pure logic (no I/O), fixture-tested by
// scripts/follow-up-check.ts. Spec: docs/specs/2026-07-30-follow-up-cockpit-spec.md
//
// Builds one LO's daily queue from two sources:
//   • GHL-backed deals (the same rows /hot-leads works) — the cockpit surfaces
//     only DUE/URGENT GHL items (replies, brand-new, check-ins due) and leaves
//     the working tabs (Responded/Pitching/App Intake) to /hot-leads.
//   • fub_people rows — the FUB book lifecycle (new, stale nurture, past
//     clients), which has no other home in the dashboard.
//
// A FUB person whose matched_deal_active flag is set is SUPPRESSED here: the
// person has an open GHL deal, so the GHL row drives their follow-up and the
// queue must not double-list them.

import { isOpenLead } from './triage'

const MS_PER_DAY = 86_400_000

// Statuses already worked via the /hot-leads tabs — replies on these are NOT
// re-surfaced by the cockpit (the pitching/intake tabs own them).
export const HOT_WORKING_STATUSES = ['Responded', 'Pitching', 'Appointment Booked', 'App Intake']

// FUB stage buckets (all 17 live stages accounted for — see research doc census).
export const FUB_OPEN_STAGES = [
  'Lead', 'Attempting Contact', 'In Contact', 'Nurture', 'Nurture - Credit',
  'Nurture - Income', 'App Link Sent', 'App Review', 'Pre Approved', 'In Escrow', 'Contact',
]
export const FUB_PAST_STAGES = ['Past Client', 'Closed']
// Unresponsive/Inactive are no longer PULLED at all (Efrain 2026-07-30 — not
// follow-up material); listing them here is defense-in-depth for stale rows.
export const FUB_EXCLUDED_STAGES = ['Trash', 'Referred Out', 'Unresponsive', 'Inactive']

export const REPLY_WINDOW_H = 48       // inbound within this window counts as "reply waiting"
export const NEW_GHL_DAYS = 3          // GHL lead is "new" for 72h
export const NEW_FUB_DAYS = 7          // FUB lead is "new" for 7d
export const STALE_MIN_DAYS = 7        // idle < 7d = actively engaged, not stale

// ── Input shapes (structural — both full Deal objects and narrow rows work) ──

export type QueueDealLike = {
  id: string
  name?: string | null
  status: string
  ghl_status?: string | null
  pipeline_group?: string | null
  loan_officer?: string | null
  created_at?: string | null
  date_added_ghl?: string | null
  next_action_due?: string | null
  next_action?: string | null
  last_inbound_at?: string | null
  last_outbound_at?: string | null
  last_communication_at?: string | null
  last_contacted?: string | null
  last_inbound_message?: string | null
  loan_amount?: number | null
  ghl_contact_id?: string | null
  ghl_location_id?: string | null
}

export type QueueFubLike = {
  fub_id: number
  name?: string | null
  stage?: string | null
  loan_officer?: string | null
  price?: number | null
  deal_price?: number | null
  source?: string | null
  last_activity_at?: string | null
  fub_created_at?: string | null
  next_action_due?: string | null
  next_action?: string | null
  last_touched_at?: string | null
  matched_deal_active?: boolean | null
  missing_since?: string | null
}

// ── Output shape ─────────────────────────────────────────────────────────────

export type QueueItem = {
  key: string                      // 'deal:<uuid>' | 'fub:<id>' — stable React key
  system: 'ghl' | 'fub'
  dealId?: string
  fubId?: number
  ghlContactId?: string | null
  ghlLocationId?: string | null
  name: string
  stage: string
  price: number | null
  idleDays: number | null
  dueAt: string | null
  overdue: boolean
  inboundAt: string | null
  lastMessage: string | null
  note: string | null              // existing next_action note
  reason: string                   // plain-English "why is this here"
}

export type StaleBuckets = { b7_30: QueueItem[]; b31_90: QueueItem[]; b90: QueueItem[] }

export type FollowUpQueue = {
  replyWaiting: QueueItem[]
  newLeads: QueueItem[]
  dueToday: QueueItem[]
  stale: StaleBuckets
  pastClients: StaleBuckets
  counts: {
    replyWaiting: number; newLeads: number; dueToday: number; overdue: number
    stale: number; pastClients: number
  }
}

// ── Small helpers ────────────────────────────────────────────────────────────

const parse = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  return isNaN(t) ? null : t
}

export function daysBetween(earlierIso: string | null | undefined, now: number): number | null {
  const t = parse(earlierIso)
  return t == null ? null : Math.max(0, Math.floor((now - t) / MS_PER_DAY))
}

/** End of "today" (local server/browser time) — due dates on/before this are due. */
export function endOfToday(now: number): number {
  const d = new Date(now)
  d.setHours(23, 59, 59, 999)
  return d.getTime()
}
function startOfToday(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const fmtMoney = (n: number | null | undefined): string | null => {
  if (n == null || !(n > 0)) return null
  return n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`
}

const fmtAgo = (iso: string | null | undefined, now: number): string => {
  const t = parse(iso)
  if (t == null) return 'just now'
  const h = Math.floor((now - t) / 3_600_000)
  if (h < 1) return 'just now'
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** FUB idle anchor: latest of FUB activity and our own logged touch. */
export function fubIdleDays(f: QueueFubLike, now: number): number | null {
  const a = parse(f.last_activity_at)
  const b = parse(f.last_touched_at)
  const c = parse(f.fub_created_at)
  const latest = Math.max(a ?? -Infinity, b ?? -Infinity, c ?? -Infinity)
  if (latest === -Infinity) return null
  return Math.max(0, Math.floor((now - latest) / MS_PER_DAY))
}

// ── Item builders ────────────────────────────────────────────────────────────

function dealItem(d: QueueDealLike, reason: string, now: number): QueueItem {
  const due = parse(d.next_action_due)
  return {
    key: `deal:${d.id}`,
    system: 'ghl',
    dealId: d.id,
    ghlContactId: d.ghl_contact_id ?? null,
    ghlLocationId: d.ghl_location_id ?? null,
    name: d.name || 'Unnamed lead',
    stage: d.status,
    price: d.loan_amount ?? null,
    idleDays: daysBetween(d.last_outbound_at || d.last_inbound_at || d.created_at, now),
    dueAt: d.next_action_due ?? null,
    overdue: due != null && due < startOfToday(now),
    inboundAt: d.last_inbound_at ?? null,
    lastMessage: d.last_inbound_message ?? null,
    note: d.next_action ?? null,
    reason,
  }
}

function fubItem(f: QueueFubLike, reason: string, now: number): QueueItem {
  const due = parse(f.next_action_due)
  return {
    key: `fub:${f.fub_id}`,
    system: 'fub',
    fubId: f.fub_id,
    name: f.name || 'Unnamed contact',
    stage: f.stage || '—',
    price: f.deal_price ?? f.price ?? null,
    idleDays: fubIdleDays(f, now),
    dueAt: f.next_action_due ?? null,
    overdue: due != null && due < startOfToday(now),
    inboundAt: null,
    lastMessage: null,
    note: f.next_action ?? null,
    reason,
  }
}

// ── Predicates ───────────────────────────────────────────────────────────────

const loMatch = (lo: string | null | undefined, target: string) => lo === target

/** Unanswered inbound within the reply window, on a status /hot-leads isn't already working. */
export function isReplyWaiting(d: QueueDealLike, now: number): boolean {
  if (!isOpenLead(d)) return false
  if (HOT_WORKING_STATUSES.includes(d.status)) return false
  const inbound = parse(d.last_inbound_at)
  if (inbound == null || now - inbound > REPLY_WINDOW_H * 3_600_000) return false
  const outbound = parse(d.last_outbound_at)
  return outbound == null || outbound < inbound
}

export function isNewGhlLead(d: QueueDealLike, now: number): boolean {
  if (!isOpenLead(d) || d.pipeline_group !== 'Leads') return false
  const anchor = parse(d.date_added_ghl || d.created_at)
  return anchor != null && now - anchor <= NEW_GHL_DAYS * MS_PER_DAY
}

/** FUB row is visible to the cockpit at all (not deleted, not owned by an active GHL deal). */
export function fubVisible(f: QueueFubLike): boolean {
  return f.missing_since == null && !f.matched_deal_active
    && !FUB_EXCLUDED_STAGES.includes(f.stage ?? '')
}

const hasFutureSnooze = (f: QueueFubLike, now: number): boolean => {
  const due = parse(f.next_action_due)
  return due != null && due > endOfToday(now)
}

// ── Sorters ──────────────────────────────────────────────────────────────────

const byInboundDesc = (a: QueueItem, b: QueueItem) => (parse(b.inboundAt) ?? 0) - (parse(a.inboundAt) ?? 0)
const byDueAsc = (a: QueueItem, b: QueueItem) => (parse(a.dueAt) ?? Infinity) - (parse(b.dueAt) ?? Infinity)
const byPriceThenIdle = (a: QueueItem, b: QueueItem) =>
  (b.price ?? 0) - (a.price ?? 0) || (b.idleDays ?? 0) - (a.idleDays ?? 0)

function bucketize(items: { item: QueueItem; idle: number }[]): StaleBuckets {
  const b: StaleBuckets = { b7_30: [], b31_90: [], b90: [] }
  for (const { item, idle } of items) {
    if (idle <= 30) b.b7_30.push(item)
    else if (idle <= 90) b.b31_90.push(item)
    else b.b90.push(item)
  }
  b.b7_30.sort(byPriceThenIdle); b.b31_90.sort(byPriceThenIdle); b.b90.sort(byPriceThenIdle)
  return b
}

// ── The builder ──────────────────────────────────────────────────────────────

export function buildFollowUpQueue(opts: {
  deals: QueueDealLike[]
  fub: QueueFubLike[]
  lo: string                 // 'Moe Sefati' | 'Matt Park'
  now?: number
}): FollowUpQueue {
  const now = opts.now ?? Date.now()
  const eod = endOfToday(now)
  const deals = opts.deals.filter(d => loMatch(d.loan_officer, opts.lo))
  const fub = opts.fub.filter(f => loMatch(f.loan_officer, opts.lo) && fubVisible(f))

  // 1 — Reply waiting (GHL only; FUB has no message stream in v1)
  const replyWaiting = deals
    .filter(d => isReplyWaiting(d, now))
    .map(d => dealItem(d, `replied ${fmtAgo(d.last_inbound_at, now)}`, now))
    .sort(byInboundDesc)
  const replyKeys = new Set(replyWaiting.map(i => i.key))

  // 2 — New leads (both systems), excluding anything already in reply-waiting
  const newGhl = deals
    .filter(d => isNewGhlLead(d, now))
    .map(d => dealItem(d, `new lead · ${fmtAgo(d.date_added_ghl || d.created_at, now)}`, now))
  const newFub = fub
    .filter(f => ['Lead', 'Attempting Contact'].includes(f.stage ?? '')
      && (daysBetween(f.fub_created_at, now) ?? Infinity) <= NEW_FUB_DAYS)
    .map(f => fubItem(f, `new in FUB · ${fmtAgo(f.fub_created_at, now)}`, now))
  const newLeads = [...newGhl, ...newFub]
    .filter(i => !replyKeys.has(i.key))
    .sort((a, b) => (b.idleDays ?? 0) - (a.idleDays ?? 0)) // oldest new lead first — closest to going cold
  const newKeys = new Set(newLeads.map(i => i.key))

  // 3 — Due today (both systems' next_action_due; overdue floats up)
  const dueGhl = deals
    .filter(d => isOpenLead(d) && parse(d.next_action_due) != null && parse(d.next_action_due)! <= eod)
    .map(d => {
      const overdueDays = daysBetween(d.next_action_due, now) ?? 0
      const overdue = parse(d.next_action_due)! < startOfToday(now)
      return dealItem(d, overdue ? `check-in overdue ${overdueDays}d` : 'check-in due today', now)
    })
  const dueFub = fub
    .filter(f => parse(f.next_action_due) != null && parse(f.next_action_due)! <= eod)
    .map(f => {
      const overdueDays = daysBetween(f.next_action_due, now) ?? 0
      const overdue = parse(f.next_action_due)! < startOfToday(now)
      return fubItem(f, overdue ? `follow-up overdue ${overdueDays}d` : 'follow-up due today', now)
    })
  const dueToday = [...dueGhl, ...dueFub]
    .filter(i => !replyKeys.has(i.key) && !newKeys.has(i.key))
    .sort(byDueAsc)

  // 4/5/6 — the FUB book: stale nurture, past clients, cold (never rows already queued above)
  const queuedFub = new Set([...replyKeys, ...newKeys, ...dueToday.map(i => i.key)])
  const staleRows: { item: QueueItem; idle: number }[] = []
  const pastRows: { item: QueueItem; idle: number }[] = []
  for (const f of fub) {
    const key = `fub:${f.fub_id}`
    if (queuedFub.has(key) || hasFutureSnooze(f, now)) continue
    const stage = f.stage ?? ''
    const idle = fubIdleDays(f, now)
    if (idle == null || idle < STALE_MIN_DAYS) continue   // actively engaged
    const money = fmtMoney(f.deal_price ?? f.price)
    const bits = [`idle ${idle}d`, stage, ...(money ? [money] : [])]
    const entry = { item: fubItem(f, bits.join(' · '), now), idle }
    if (FUB_PAST_STAGES.includes(stage)) pastRows.push(entry)
    else if (FUB_OPEN_STAGES.includes(stage)) staleRows.push(entry)
  }
  const stale = bucketize(staleRows)
  const pastClients = bucketize(pastRows)

  return {
    replyWaiting, newLeads, dueToday, stale, pastClients,
    counts: {
      replyWaiting: replyWaiting.length,
      newLeads: newLeads.length,
      dueToday: dueToday.length,
      overdue: dueToday.filter(i => i.overdue).length,
      stale: staleRows.length,
      pastClients: pastRows.length,
    },
  }
}

// ── FUB tasks ────────────────────────────────────────────────────────────────
// The LO's own FollowUpBoss reminders (fub_tasks), surfaced alongside the queue
// so the cockpit shows the work they already scheduled in FUB, not just what we
// inferred. Efrain 2026-07-30: "show the FUB tasks due within the next 7 days"
// + a button through to the lead in FUB.
//
// Dates are compared as LOCAL YYYY-MM-DD strings, never as parsed instants:
// FUB's dueDate is date-only, and Date.parse('2026-07-30') is UTC midnight,
// which reads as "yesterday" for anyone west of Greenwich (i.e. all of PT).

export const TASK_WINDOW_DAYS = 7

export type QueueTaskLike = {
  fub_task_id: number
  person_id?: number | null
  loan_officer?: string | null
  name?: string | null
  type?: string | null
  due_date?: string | null
  due_date_time?: string | null
}

export type TaskItem = {
  key: string                  // 'task:<id>'
  taskId: number
  personId: number | null
  personName: string           // resolved from fub_people, else 'FUB contact #id'
  personStage: string | null
  title: string                // the task text
  type: string
  dueDate: string | null
  dueLabel: string             // 'overdue 12d' | 'due today' | 'Sat Aug 1'
  overdueDays: number          // 0 unless overdue
}

export type TaskQueue = {
  overdue: TaskItem[]
  today: TaskItem[]
  next7: TaskItem[]
  counts: { overdue: number; today: number; next7: number }
}

/** Local YYYY-MM-DD, `offsetDays` from now. */
export function localYmd(now: number, offsetDays = 0): string {
  const d = new Date(now)
  d.setDate(d.getDate() + offsetDays)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Whole days between two YMD strings (b - a). */
export function ymdDiffDays(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / MS_PER_DAY)
}

function weekdayLabel(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

export function buildTaskQueue(opts: {
  tasks: QueueTaskLike[]
  people: QueueFubLike[]        // for name/stage resolution
  lo: string
  now?: number
  windowDays?: number
}): TaskQueue {
  const now = opts.now ?? Date.now()
  const today = localYmd(now)
  const horizon = localYmd(now, opts.windowDays ?? TASK_WINDOW_DAYS)
  const byId = new Map(opts.people.map(p => [p.fub_id, p]))

  const toItem = (t: QueueTaskLike): TaskItem => {
    const person = t.person_id != null ? byId.get(t.person_id) : undefined
    const due = t.due_date ? t.due_date.slice(0, 10) : null
    const overdueDays = due && due < today ? ymdDiffDays(due, today) : 0
    return {
      key: `task:${t.fub_task_id}`,
      taskId: t.fub_task_id,
      personId: t.person_id ?? null,
      personName: person?.name || (t.person_id != null ? `FUB contact #${t.person_id}` : 'No contact'),
      personStage: person?.stage ?? null,
      title: (t.name || 'Follow up').trim(),
      type: t.type || 'Follow Up',
      dueDate: due,
      dueLabel: !due ? 'no due date'
        : overdueDays > 0 ? `overdue ${overdueDays}d`
        : due === today ? 'due today'
        : weekdayLabel(due),
      overdueDays,
    }
  }

  const mine = opts.tasks.filter(t => t.loan_officer === opts.lo && t.due_date)
  const overdue: TaskItem[] = [], todayList: TaskItem[] = [], next7: TaskItem[] = []
  for (const t of mine) {
    const due = t.due_date!.slice(0, 10)
    if (due < today) overdue.push(toItem(t))
    else if (due === today) todayList.push(toItem(t))
    else if (due <= horizon) next7.push(toItem(t))
  }
  // Overdue: most-recently-due first — a task 2 days late is far more actionable
  // than one from last October (Matt has 583, oldest 2025-10-27).
  overdue.sort((a, b) => a.overdueDays - b.overdueDays)
  const byDueAscThenName = (a: TaskItem, b: TaskItem) =>
    (a.dueDate ?? '').localeCompare(b.dueDate ?? '') || a.personName.localeCompare(b.personName)
  todayList.sort(byDueAscThenName)
  next7.sort(byDueAscThenName)

  return {
    overdue, today: todayList, next7,
    counts: { overdue: overdue.length, today: todayList.length, next7: next7.length },
  }
}

// ── GHL leads in play (Pitching + App Intake) ────────────────────────────────
// Efrain 2026-07-30: a section for the GHL leads in Pitching and App Intake,
// split by last activity — worked in the last 7 days vs gone quiet longer than
// that. These are the deals actually in motion; /hot-leads has the same stages
// in a team-wide tracker, this is the LO's personal working list.
//
// "Last activity" coalesces every touch timestamp the sync maintains. On live
// data `last_communication_at` and `last_outbound_at` are populated on 143/143
// open rows, so no lead lands in an "unknown" hole.

export const IN_PLAY_STATUSES = ['Pitching', 'App Intake'] as const
export const ACTIVITY_SPLIT_DAYS = 7

export type LeadSections = {
  recent: QueueItem[]        // activity within the last 7 days
  older: QueueItem[]         // quiet for more than 7 days (incl. never-touched)
  counts: { recent: number; older: number; pitching: number; appIntake: number }
}

export function lastActivityMs(d: QueueDealLike): number | null {
  const ts = [d.last_communication_at, d.last_inbound_at, d.last_outbound_at, d.last_contacted]
    .map(v => (v ? Date.parse(v) : NaN))
    .filter(t => !isNaN(t))
  return ts.length ? Math.max(...ts) : null
}

export function buildLeadSections(opts: { deals: QueueDealLike[]; lo: string; now?: number }): LeadSections {
  const now = opts.now ?? Date.now()
  const cutoff = now - ACTIVITY_SPLIT_DAYS * MS_PER_DAY
  const mine = opts.deals.filter(d =>
    d.loan_officer === opts.lo &&
    isOpenLead(d) &&
    (IN_PLAY_STATUSES as readonly string[]).includes(d.status))

  // Carry the coalesced activity timestamp alongside each item so the sort uses
  // the SAME signal that chose the bucket (QueueItem.idleDays looks at a
  // narrower set of columns and would order rows inconsistently).
  const recentRows: { item: QueueItem; act: number }[] = []
  const olderRows: { item: QueueItem; act: number | null }[] = []
  for (const d of mine) {
    const act = lastActivityMs(d)
    const days = act == null ? null : Math.max(0, Math.floor((now - act) / MS_PER_DAY))
    const inbound = d.last_inbound_at && d.last_outbound_at
      ? Date.parse(d.last_inbound_at) > Date.parse(d.last_outbound_at)
      : !!d.last_inbound_at
    const reason = act == null
      ? 'no activity recorded'
      : `${days === 0 ? 'today' : `${days}d ago`}${inbound ? ' · they replied last' : ''}`
    const item = { ...dealItem(d, reason, now), idleDays: days }
    if (act != null && act >= cutoff) recentRows.push({ item, act })
    else olderRows.push({ item, act })
  }
  // Recent: freshest first. Older: quietest first — those are the ones slipping.
  recentRows.sort((a, b) => b.act - a.act)
  olderRows.sort((a, b) => (a.act ?? -Infinity) - (b.act ?? -Infinity))
  const recent = recentRows.map(r => r.item)
  const older = olderRows.map(r => r.item)

  return {
    recent, older,
    counts: {
      recent: recent.length,
      older: older.length,
      pitching: mine.filter(d => d.status === 'Pitching').length,
      appIntake: mine.filter(d => d.status === 'App Intake').length,
    },
  }
}

// ── Snooze presets (shared by the UI) ────────────────────────────────────────

export const SNOOZE_PRESETS: { label: string; days: number }[] = [
  { label: '1 day', days: 1 },
  { label: '3 days', days: 3 },
  { label: '1 week', days: 7 },
  { label: '2 weeks', days: 14 },
  { label: '1 month', days: 30 },
]

export function snoozeIso(days: number, now?: number): string {
  const d = new Date((now ?? Date.now()) + days * MS_PER_DAY)
  d.setHours(9, 0, 0, 0)   // due at 9am local on the target day
  return d.toISOString()
}
