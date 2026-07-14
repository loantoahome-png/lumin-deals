// Lead triage — the 7-day decision clock + Not Ready check-in resurfacing.
// Pure logic (no I/O) shared by the Hot Leads triage/check-in tabs and the
// triage-tasks cron. Spec: docs/specs/2026-07-14-lead-triage-spec.md
//
// Every OPEN lead in an undecided stage is "on the clock" from its creation
// (date_added_ghl, else created_at). By day 7 the team commits a direction:
// App Intake, Not Ready - Timeframe (with a required check-in date stored in
// next_action_due), or Remove from All Automations. Not Ready - Timeframe
// leads then resurface when their check-in date arrives.

const MS_PER_DAY = 86_400_000

// Stages where no direction has been chosen yet. Everything else counts as
// decided: App Intake and beyond, any Not Ready status, or a lost/abandoned
// GHL opportunity.
export const UNDECIDED_STATUSES = [
  'New Lead', 'Attempted Contact', 'Ghosted', 'Responded', 'Pitching', 'Appointment Booked',
] as const

export const NOT_READY_TIMEFRAME = 'Not Ready - Timeframe'

// The clock: decide by day 7; tasks nudge at day 5; >30d is historical backlog.
export const DECIDE_BY_DAY = 7
export const TASK_AT_DAY = 5
export const BACKLOG_AFTER_DAYS = 30

// Minimal structural view of a deal — works for both full Deal objects on the
// client and the narrow rows the cron selects.
export type TriageDealLike = {
  name?: string | null
  status: string
  ghl_status?: string | null
  date_added_ghl?: string | null
  created_at?: string | null
  next_action_due?: string | null
}

// Open = the GHL opportunity hasn't been closed out. Matches the Hot Leads
// filter: lost/abandoned are decided; null/unknown stays visible.
export function isOpenLead(d: TriageDealLike): boolean {
  const st = (d.ghl_status ?? '').toLowerCase()
  return st !== 'lost' && !st.startsWith('abandon')
}

export function isUndecided(d: TriageDealLike): boolean {
  return isOpenLead(d) && (UNDECIDED_STATUSES as readonly string[]).includes(d.status)
}

// When the lead's 7-day clock started.
export function clockAnchorIso(d: TriageDealLike): string | null {
  return d.date_added_ghl || d.created_at || null
}

// Whole days since the lead came in. Day 0 = came in today. Unknown anchor → 0
// (fails toward "brand new", never toward a false overdue).
export function leadAgeDays(d: TriageDealLike, now: number): number {
  const iso = clockAnchorIso(d)
  if (!iso) return 0
  const t = Date.parse(iso)
  if (isNaN(t)) return 0
  return Math.max(0, Math.floor((now - t) / MS_PER_DAY))
}

// Urgency tier on the decision clock.
//   clock   day 0–4   — on the clock, work it
//   decide  day 5–7   — decision due now
//   overdue day 8–30  — past the deadline, still recent enough to salvage
//   backlog day 31+   — historical pile; bulk-clean, don't task
export type TriageTier = 'clock' | 'decide' | 'overdue' | 'backlog'
export function triageTier(d: TriageDealLike, now: number): TriageTier {
  const age = leadAgeDays(d, now)
  if (age < TASK_AT_DAY) return 'clock'
  if (age <= DECIDE_BY_DAY) return 'decide'
  if (age <= BACKLOG_AFTER_DAYS) return 'overdue'
  return 'backlog'
}

// Check-in tier for an open Not Ready - Timeframe lead. The check-in date
// lives in next_action_due (the sync never writes it, so it's ours to own).
//   none      no date set — needs one
//   overdue   date passed — check in now
//   soon      due within 7 days
//   scheduled further out
export type CheckinTier = 'none' | 'overdue' | 'soon' | 'scheduled'
export function checkinTier(d: TriageDealLike, now: number): CheckinTier {
  if (!d.next_action_due) return 'none'
  const due = Date.parse(d.next_action_due)
  if (isNaN(due)) return 'none'
  if (due < now) return 'overdue'
  if (due <= now + 7 * MS_PER_DAY) return 'soon'
  return 'scheduled'
}

// ── Auto-task eligibility (cron) ─────────────────────────────────────────────
// Decision tasks fire only for leads ENTERING the decide window (age 5–7),
// AND only for leads that came in on/after launch day ("I want to start now" —
// Efrain, 2026-07-14). Everything older — the decide/overdue/backlog pile that
// existed at launch — is handled visually on the Triage tab + bulk cleanup,
// never by tasks; tasking it would bury the LOs in email.
export const DECISION_TASKS_SINCE = Date.parse('2026-07-14T07:00:00Z')   // launch day, midnight PT

export function needsDecisionTask(d: TriageDealLike, now: number): boolean {
  if (!isUndecided(d)) return false
  const iso = clockAnchorIso(d)
  const anchor = iso ? Date.parse(iso) : NaN
  if (isNaN(anchor) || anchor < DECISION_TASKS_SINCE) return false
  const age = leadAgeDays(d, now)
  return age >= TASK_AT_DAY && age < DECIDE_BY_DAY + 1
}

// Check-in tasks fire when the check-in date arrives: due within the last 3
// days (covers missed cron runs) through the next 24h.
export function needsCheckinTask(d: TriageDealLike, now: number): boolean {
  if (!isOpenLead(d) || d.status !== NOT_READY_TIMEFRAME || !d.next_action_due) return false
  const due = Date.parse(d.next_action_due)
  if (isNaN(due)) return false
  return due >= now - 3 * MS_PER_DAY && due <= now + MS_PER_DAY
}

// Task titles double as the dedup key (exact match per deal), so they must be
// deterministic. The check-in title embeds the due date (UTC) so RESCHEDULING
// to a new date yields a new title → a fresh task when that date arrives.
export function decisionTaskTitle(d: TriageDealLike): string {
  return `Triage decision — ${d.name ?? 'lead'}`
}
export function checkinTaskTitle(d: TriageDealLike): string {
  const due = d.next_action_due ? new Date(d.next_action_due) : null
  const stamp = due && !isNaN(due.getTime()) ? ` (due ${due.getUTCMonth() + 1}/${due.getUTCDate()})` : ''
  return `Check in — ${d.name ?? 'lead'}${stamp}`
}

// The day-7 deadline as an ISO timestamp (used as the decision task's due_at).
export function decideByIso(d: TriageDealLike, now: number): string {
  const iso = clockAnchorIso(d)
  const t = iso ? Date.parse(iso) : NaN
  const base = isNaN(t) ? now : t
  return new Date(base + DECIDE_BY_DAY * MS_PER_DAY).toISOString()
}
