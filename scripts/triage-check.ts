// Fixture check for lib/triage.ts — pure logic, no DB.
// Run: npx tsx scripts/triage-check.ts
import {
  isOpenLead, isUndecided, onTriageClock, leadAgeDays, triageTier, checkinTier,
  needsDecisionTask, needsCheckinTask, decisionTaskTitle, checkinTaskTitle,
  decideByIso, clockAnchorIso, NOT_READY_TIMEFRAME,
  type TriageDealLike,
} from '../lib/triage'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++ } else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}

// Fixed "now" so day math is deterministic: 2026-07-14 18:00 UTC.
const NOW = Date.parse('2026-07-14T18:00:00Z')
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString()

const lead = (p: Partial<TriageDealLike>): TriageDealLike => ({
  name: 'Test Lead', status: 'New Lead', ghl_status: 'open',
  date_added_ghl: daysAgo(1), created_at: daysAgo(1), next_action_due: null,
  ...p,
})

// ── Open / undecided ──────────────────────────────────────────────────────────
eq('open: ghl_status open', isOpenLead(lead({})), true)
eq('open: null ghl_status stays visible', isOpenLead(lead({ ghl_status: null })), true)
eq('open: lost excluded', isOpenLead(lead({ ghl_status: 'lost' })), false)
eq('open: abandoned excluded', isOpenLead(lead({ ghl_status: 'Abandoned' })), false)
eq('undecided: New Lead', isUndecided(lead({})), true)
eq('undecided: Ghosted counts', isUndecided(lead({ status: 'Ghosted' })), true)
eq('undecided: App Intake is decided', isUndecided(lead({ status: 'App Intake' })), false)
eq('undecided: NRT is decided', isUndecided(lead({ status: NOT_READY_TIMEFRAME })), false)
eq('undecided: lost lead is decided', isUndecided(lead({ ghl_status: 'lost' })), false)

// ── Clock anchor + age ───────────────────────────────────────────────────────
eq('anchor: prefers date_added_ghl', clockAnchorIso(lead({ date_added_ghl: daysAgo(9), created_at: daysAgo(2) })), daysAgo(9))
eq('anchor: falls back to created_at', clockAnchorIso(lead({ date_added_ghl: null, created_at: daysAgo(3) })), daysAgo(3))
eq('age: 1 day', leadAgeDays(lead({}), NOW), 1)
eq('age: missing anchor → 0 (fails toward new)', leadAgeDays(lead({ date_added_ghl: null, created_at: null }), NOW), 0)
eq('age: future anchor clamps to 0', leadAgeDays(lead({ date_added_ghl: daysAgo(-2) }), NOW), 0)

// ── Tier boundaries (the bug-prone part) ─────────────────────────────────────
eq('tier: day 0 = clock', triageTier(lead({ date_added_ghl: daysAgo(0) }), NOW), 'clock')
eq('tier: day 4 = clock', triageTier(lead({ date_added_ghl: daysAgo(4) }), NOW), 'clock')
eq('tier: day 5 = decide', triageTier(lead({ date_added_ghl: daysAgo(5) }), NOW), 'decide')
eq('tier: day 7 = decide (last day)', triageTier(lead({ date_added_ghl: daysAgo(7) }), NOW), 'decide')
eq('tier: day 8 = overdue', triageTier(lead({ date_added_ghl: daysAgo(8) }), NOW), 'overdue')
eq('tier: day 30 = overdue', triageTier(lead({ date_added_ghl: daysAgo(30) }), NOW), 'overdue')
eq('tier: day 31 = backlog', triageTier(lead({ date_added_ghl: daysAgo(31) }), NOW), 'backlog')

// ── Check-in tiers ───────────────────────────────────────────────────────────
const nrt = (p: Partial<TriageDealLike>) => lead({ status: NOT_READY_TIMEFRAME, ...p })
eq('checkin: no date = none', checkinTier(nrt({}), NOW), 'none')
eq('checkin: past date = overdue', checkinTier(nrt({ next_action_due: daysAgo(1) }), NOW), 'overdue')
eq('checkin: in 3 days = soon', checkinTier(nrt({ next_action_due: daysAgo(-3) }), NOW), 'soon')
eq('checkin: in 7 days = soon (boundary)', checkinTier(nrt({ next_action_due: daysAgo(-7) }), NOW), 'soon')
eq('checkin: in 8 days = scheduled', checkinTier(nrt({ next_action_due: daysAgo(-8) }), NOW), 'scheduled')
eq('checkin: bad date = none', checkinTier(nrt({ next_action_due: 'garbage' }), NOW), 'none')

// ── Decision-task eligibility: ONLY the day 5–7 entry window, ONLY leads that
// came in on/after launch day (the "start now" floor, DECISION_TASKS_SINCE).
// Day-window tests run at a post-launch NOW so the floor doesn't mask them.
const NOW_TASKS = Date.parse('2026-07-25T18:00:00Z')
const daysAgoT = (n: number) => new Date(NOW_TASKS - n * 86_400_000).toISOString()
eq('task: day 4 → no', needsDecisionTask(lead({ date_added_ghl: daysAgoT(4) }), NOW_TASKS), false)
eq('task: day 5 → yes', needsDecisionTask(lead({ date_added_ghl: daysAgoT(5) }), NOW_TASKS), true)
eq('task: day 7 → yes', needsDecisionTask(lead({ date_added_ghl: daysAgoT(7) }), NOW_TASKS), true)
eq('task: day 8 → no (overdue pile never tasks)', needsDecisionTask(lead({ date_added_ghl: daysAgoT(8) }), NOW_TASKS), false)
eq('task: day 45 backlog → no', needsDecisionTask(lead({ date_added_ghl: daysAgoT(45) }), NOW_TASKS), false)
eq('task: day 6 but decided → no', needsDecisionTask(lead({ date_added_ghl: daysAgoT(6), status: 'App Intake' }), NOW_TASKS), false)
eq('task: day 6 but lost → no', needsDecisionTask(lead({ date_added_ghl: daysAgoT(6), ghl_status: 'lost' }), NOW_TASKS), false)
// ── The launch floor (TRIAGE_SINCE) gates tab visibility AND tasks ───────────
eq('clock: launch-day lead is on the triage clock',
  onTriageClock(lead({ date_added_ghl: '2026-07-14T15:00:00Z', created_at: '2026-07-14T15:00:00Z' })), true)
eq('clock: pre-launch lead is hidden from triage',
  onTriageClock(lead({ date_added_ghl: '2026-07-13T12:00:00Z', created_at: '2026-07-13T12:00:00Z' })), false)
eq('clock: pre-launch lead is still "undecided" (other views unaffected)',
  isUndecided(lead({ date_added_ghl: '2026-07-13T12:00:00Z' })), true)
eq('clock: missing anchor is hidden (can\'t prove it\'s post-launch)',
  onTriageClock(lead({ date_added_ghl: null, created_at: null })), false)
// The floor itself: a day-5–7 lead from BEFORE launch never tasks.
eq('task: day 6 but pre-launch anchor → no (start-now floor)',
  needsDecisionTask(lead({ date_added_ghl: '2026-07-13T12:00:00Z', created_at: '2026-07-13T12:00:00Z' }), Date.parse('2026-07-19T18:00:00Z')), false)
eq('task: launch-day lead at day 5 → yes',
  needsDecisionTask(lead({ date_added_ghl: '2026-07-14T15:00:00Z', created_at: '2026-07-14T15:00:00Z' }), Date.parse('2026-07-19T16:00:00Z')), true)

// ── Check-in-task eligibility: due within [now−3d, now+24h] ──────────────────
eq('checkin task: due today → yes', needsCheckinTask(nrt({ next_action_due: daysAgo(0) }), NOW), true)
eq('checkin task: due 3d ago → yes (missed-run cover)', needsCheckinTask(nrt({ next_action_due: daysAgo(3) }), NOW), true)
eq('checkin task: due 4d ago → no', needsCheckinTask(nrt({ next_action_due: daysAgo(4) }), NOW), false)
eq('checkin task: due tomorrow → yes', needsCheckinTask(nrt({ next_action_due: daysAgo(-1) }), NOW), true)
eq('checkin task: due in 2d → no', needsCheckinTask(nrt({ next_action_due: daysAgo(-2) }), NOW), false)
eq('checkin task: not NRT → no', needsCheckinTask(lead({ status: 'Pitching', next_action_due: daysAgo(0) }), NOW), false)
eq('checkin task: no date → no', needsCheckinTask(nrt({}), NOW), false)
eq('checkin task: lost → no', needsCheckinTask(nrt({ next_action_due: daysAgo(0), ghl_status: 'lost' }), NOW), false)

// ── Titles (dedup keys — must be deterministic) ──────────────────────────────
eq('title: decision', decisionTaskTitle(lead({ name: 'Maria Lopez' })), 'Triage decision — Maria Lopez')
eq('title: decision null name', decisionTaskTitle(lead({ name: null })), 'Triage decision — lead')
eq('title: checkin embeds UTC due date', checkinTaskTitle(nrt({ name: 'Maria Lopez', next_action_due: '2026-09-14T16:00:00Z' })), 'Check in — Maria Lopez (due 9/14)')
eq('title: checkin without date', checkinTaskTitle(nrt({ name: 'Maria Lopez', next_action_due: null })), 'Check in — Maria Lopez')

// ── decideByIso = anchor + 7 days ────────────────────────────────────────────
eq('decideBy: anchor + 7d', decideByIso(lead({ date_added_ghl: daysAgo(5) }), NOW), daysAgo(-2))

console.log(fail === 0 ? `✓ triage-check: all ${pass} fixtures pass` : `${fail} FAILED / ${pass} passed`)
if (fail > 0) process.exit(1)
