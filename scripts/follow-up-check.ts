// Fixture suite for the Follow-Up Cockpit: lib/followUpBoss.ts (mapping/merge/diff)
// + lib/followUpQueue.ts (queue building). Run: npx tsx scripts/follow-up-check.ts
//
// Times are relative to a fixed NOW so assertions are deterministic. Day-boundary
// fixtures (due today / overdue) stay ≥ 2h inside the local day on either side,
// so the suite passes in any timezone the runner uses.

import {
  mapFubPerson, mapFubTask, dedupeTasks, mergeSweeps, diffSweep, shouldStoreFubPerson,
  unansweredFromMessages, unansweredFromTouches, normalizeFubNumber, messagePreview, threadShowsReply,
  isMissedInboundCall, textTouch, callTouch,
  type FubPersonRaw, type ExistingFubRow, type FubTextMessage, type FubCall,
  emailWaitingFromPeople, emailsShowReply, isReceivedEmail,
} from '../lib/followUpBoss'
import {
  buildFollowUpQueue, buildTaskQueue, buildLeadSections, buildReplyInbox, lastActivityMs,
  fubIdleDays, snoozeIso, isReplyWaiting, localYmd, ymdDiffDays,
  type QueueDealLike, type QueueFubLike, type QueueTaskLike,
  type LiveUnreadLike, type FubUnansweredLike,
} from '../lib/followUpQueue'
import { parseFubInboxAcks, isAcked, pruneAcks, parseEmailWaiting } from '../lib/fubInboxAcks'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++; console.log(`✓ ${label}`) }
  else {
    fail++
    console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`)
  }
}

const NOW = Date.parse('2026-07-30T18:00:00Z')
const H = 3_600_000, D = 86_400_000
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

// ── mapFubPerson ─────────────────────────────────────────────────────────────

const rawMoe: FubPersonRaw = {
  id: 101, name: 'Ana Alvarez', firstName: 'Ana', lastName: 'Alvarez',
  stage: 'Nurture', source: 'WAM', assignedUserId: 72, assignedTo: 'Moe Sefati',
  emails: [{ value: 'ANA@Example.com ', isPrimary: 1 }, { value: 'other@x.com' }],
  phones: [{ value: '+1 (949) 555-1234', isPrimary: 1 }],
  addresses: [{ city: 'Irvine', state: 'CA' }],
  tags: ['MOE - 2026 Q3 - Follow up'], price: 650000,
  dealName: null, dealStage: null, dealStatus: null, dealPrice: null,
  dealCloseDate: '2024-03-15T00:00:00Z',
  created: iso(400 * D), updated: iso(2 * D), lastActivity: iso(10 * D),
  customHomebotLikelyToMoveScoreRange: 'High', customEmpty: '', customNull: null,
}
const row = mapFubPerson(rawMoe, ['moe'])
eq('map: LO from assignedUserId 72', row.loan_officer, 'Moe Sefati')
eq('map: primary email normalized', row.primary_email, 'ana@example.com')
eq('map: primary phone normalized (digits, last 10)', row.primary_phone, '9495551234')
eq('map: custom fields keep non-empty only', row.custom_fields, { customHomebotLikelyToMoveScoreRange: 'High' })
eq('map: deal_close_date truncated to date', row.deal_close_date, '2024-03-15')
eq('map: address city/state', [row.address_city, row.address_state], ['Irvine', 'CA'])

// userId wins over a conflicting display name; unknown userId falls back to resolveLO(name)
eq('map: userId 13 beats display name', mapFubPerson({ id: 1, assignedUserId: 13, assignedTo: 'Moe Sefati' }, ['matt']).loan_officer, 'Matt Park')
eq('map: unknown userId falls back to name', mapFubPerson({ id: 2, assignedUserId: 999, assignedTo: 'randy mathis' }, ['moe']).loan_officer, 'Randy Mathis')
eq('map: unassigned → null LO', mapFubPerson({ id: 3 }, ['moe']).loan_officer, null)

// ── mergeSweeps ──────────────────────────────────────────────────────────────

const overlap: FubPersonRaw = { id: 500, assignedUserId: 72, assignedTo: 'Moe Sefati' }
const merged = mergeSweeps([rawMoe, overlap], [overlap, { id: 600, assignedUserId: 13 }])
eq('merge: dedupes by fub_id', merged.length, 3)
eq('merge: overlap row seen by both keys', merged.find(r => r.fub_id === 500)?.seen_by_keys, ['moe', 'matt'])
eq('merge: matt-only row seen by matt', merged.find(r => r.fub_id === 600)?.seen_by_keys, ['matt'])

// ── diffSweep ────────────────────────────────────────────────────────────────

const sweptRows = merged
const existing: ExistingFubRow[] = [
  { fub_id: 101, fub_updated_at: row.fub_updated_at, last_activity_at: row.last_activity_at, last_inbound_at: null, last_outbound_at: null, stage: 'Nurture', assigned_user_id: 72, missing_since: null },  // unchanged
  { fub_id: 500, fub_updated_at: null, last_activity_at: null, last_inbound_at: null, last_outbound_at: null, stage: 'Lead', assigned_user_id: 72, missing_since: null },                                    // stage same? swept has null stage → changed? swept 500 stage=null vs 'Lead' → changed
  { fub_id: 700, fub_updated_at: null, last_activity_at: null, last_inbound_at: null, last_outbound_at: null, stage: 'Lead', assigned_user_id: 13, missing_since: null },                                    // gone from sweep
  { fub_id: 800, fub_updated_at: null, last_activity_at: null, last_inbound_at: null, last_outbound_at: null, stage: 'Lead', assigned_user_id: 13, missing_since: iso(5 * D) },                              // already flagged missing
]
const diff = diffSweep(sweptRows, existing)
eq('diff: new row inserted', diff.toInsert.map(r => r.fub_id), [600])
eq('diff: changed row updated', diff.toUpdate.map(r => r.fub_id), [500])
eq('diff: unchanged row untouched', diff.toUpdate.some(r => r.fub_id === 101) || diff.toInsert.some(r => r.fub_id === 101), false)
eq('diff: vanished id flagged once', diff.missingIds, [700])

// Timestamp FORMAT drift must not count as a change: PostgREST hands back
// '+00:00' offsets while the mapper emits '.000Z' (the 5,212-row live bug).
const pgFormat = (isoZ: string | null) => isoZ ? isoZ.replace(/\.\d{3}Z$/, '+00:00') : null
const fmtDrift = diffSweep(
  [row],
  [{ fub_id: 101, fub_updated_at: pgFormat(row.fub_updated_at), last_activity_at: pgFormat(row.last_activity_at), last_inbound_at: null, last_outbound_at: null, stage: row.stage, assigned_user_id: 72, missing_since: null }],
)
eq('diff: pg timestamp format is not a change', [fmtDrift.toInsert.length, fmtDrift.toUpdate.length], [0, 0])

// resurrect: a row flagged missing that reappears in the sweep → update
const resurrect = diffSweep(
  [mapFubPerson({ id: 800, stage: 'Lead', assignedUserId: 13 }, ['matt'])],
  [{ fub_id: 800, fub_updated_at: null, last_activity_at: null, last_inbound_at: null, last_outbound_at: null, stage: 'Lead', assigned_user_id: 13, missing_since: iso(5 * D) }],
)
eq('diff: resurrected row is updated', resurrect.toUpdate.map(r => r.fub_id), [800])

// ── queue: fixtures ──────────────────────────────────────────────────────────

const deal = (over: Partial<QueueDealLike>): QueueDealLike => ({
  id: over.id ?? 'd-' + Math.abs(JSON.stringify(over).split('').reduce((a, c) => a * 31 + c.charCodeAt(0) | 0, 7)),
  status: 'New Lead', ghl_status: 'open', pipeline_group: 'Leads',
  loan_officer: 'Moe Sefati', created_at: iso(30 * D), ...over,
})
const fubRow = (over: Partial<QueueFubLike>): QueueFubLike => ({
  fub_id: over.fub_id ?? 9000, stage: 'Nurture', loan_officer: 'Moe Sefati',
  fub_created_at: iso(200 * D), last_activity_at: iso(40 * D),
  matched_deal_active: false, missing_since: null, ...over,
})

const deals: QueueDealLike[] = [
  // reply waiting: inbound 3h ago, no outbound since
  deal({ id: 'd-reply', name: 'Reply Rita', last_inbound_at: iso(3 * H), last_outbound_at: iso(9 * H), last_inbound_message: 'yes call me' }),
  // answered: outbound AFTER inbound → not waiting
  deal({ id: 'd-answered', last_inbound_at: iso(5 * H), last_outbound_at: iso(1 * H) }),
  // inbound on a "hot working" status — MUST still count as reply-waiting
  // (the old HOT_WORKING_STATUSES exclusion zeroed the section for both LOs)
  deal({ id: 'd-hot', status: 'Pitching', last_inbound_at: iso(2 * H) }),
  // stale inbound (3 days) → not waiting
  deal({ id: 'd-oldmsg', last_inbound_at: iso(3 * D) }),
  // parked in Not Ready — replies here are NOT the cockpit's job (Efrain 2026-07-30)
  deal({ id: 'd-notready', status: 'Remove from All Automations', pipeline_group: 'Not Ready', last_inbound_at: iso(2 * H) }),
  deal({ id: 'd-notready-tf', status: 'Not Ready - Timeframe', pipeline_group: 'Not Ready', last_inbound_at: iso(2 * H) }),
  // new lead 26h old
  deal({ id: 'd-new', name: 'New Nick', date_added_ghl: iso(26 * H), loan_amount: 420000 }),
  // check-in due 2h from now (same local day) — Not Ready lead
  deal({ id: 'd-due', status: 'Not Ready - Timeframe', pipeline_group: 'Not Ready', next_action_due: new Date(NOW + 2 * H).toISOString(), next_action: 'Check in: rate shopper' }),
  // check-in overdue 2 days
  deal({ id: 'd-overdue', status: 'Not Ready - Timeframe', pipeline_group: 'Not Ready', next_action_due: iso(2 * D) }),
  // check-in far future → nowhere
  deal({ id: 'd-future', status: 'Not Ready - Timeframe', pipeline_group: 'Not Ready', next_action_due: new Date(NOW + 30 * D).toISOString() }),
  // lost lead with inbound → excluded entirely
  deal({ id: 'd-lost', ghl_status: 'lost', last_inbound_at: iso(1 * H) }),
  // Matt's — must not appear in Moe's queue
  deal({ id: 'd-matt', loan_officer: 'Matt Park', last_inbound_at: iso(1 * H) }),
]

const fub: QueueFubLike[] = [
  fubRow({ fub_id: 1, name: 'Fresh Fub', stage: 'Lead', fub_created_at: iso(2 * D), last_activity_at: iso(1 * D) }),        // new FUB lead
  fubRow({ fub_id: 2, stage: 'Pre Approved', last_activity_at: iso(10 * D), price: 510000 }),                                // stale 7–30
  fubRow({ fub_id: 3, stage: 'Nurture', last_activity_at: iso(45 * D) }),                                                    // stale 31–90
  fubRow({ fub_id: 4, stage: 'In Contact', last_activity_at: iso(200 * D), deal_price: 800000 }),                            // stale 90+
  fubRow({ fub_id: 5, stage: 'Nurture', last_activity_at: iso(3 * D) }),                                                     // engaged → skipped
  fubRow({ fub_id: 6, stage: 'Past Client', last_activity_at: iso(120 * D), deal_price: 610000 }),                           // past client 90+
  fubRow({ fub_id: 7, stage: 'Unresponsive', last_activity_at: iso(60 * D) }),                                               // cold
  fubRow({ fub_id: 8, stage: 'Trash', last_activity_at: iso(60 * D) }),                                                      // excluded stage
  fubRow({ fub_id: 9, stage: 'Nurture', last_activity_at: iso(60 * D), matched_deal_active: true }),                         // suppressed: active GHL deal
  fubRow({ fub_id: 10, stage: 'Nurture', last_activity_at: iso(60 * D), missing_since: iso(1 * D) }),                        // gone from FUB
  fubRow({ fub_id: 11, stage: 'Nurture', last_activity_at: iso(60 * D), next_action_due: new Date(NOW + 10 * D).toISOString() }), // snoozed out
  fubRow({ fub_id: 12, stage: 'Nurture', last_activity_at: iso(60 * D), next_action_due: iso(1 * D) }),                      // FUB follow-up overdue
  fubRow({ fub_id: 13, stage: 'Nurture', loan_officer: 'Matt Park', last_activity_at: iso(60 * D) }),                        // Matt's
]

const q = buildFollowUpQueue({ deals, fub, lo: 'Moe Sefati', now: NOW })

eq('queue: reply-waiting = every unanswered inbound, newest first', q.replyWaiting.map(i => i.key), ['deal:d-hot', 'deal:d-reply'])
// Regression guard for the 2026-07-30 bug: Responded / Pitching / Appointment
// Booked / App Intake are the statuses a lead is IN when they reply. Excluding
// them made the section render 0 rows for both LOs.
eq('queue: hot-working statuses still count as reply-waiting',
  ['Responded', 'Pitching', 'Appointment Booked', 'App Intake'].map(status =>
    isReplyWaiting(deal({ id: 's', status, last_inbound_at: iso(2 * H) }), NOW)),
  [true, true, true, true])
eq('queue: Not Ready pipeline never counts as reply-waiting',
  [isReplyWaiting(deal({ id: 'x', pipeline_group: 'Not Ready', status: 'Remove from All Automations', last_inbound_at: iso(1 * H) }), NOW),
   isReplyWaiting(deal({ id: 'y', pipeline_group: 'Not Ready', status: 'Not Ready - Timeframe', last_inbound_at: iso(1 * H) }), NOW)],
  [false, false])
eq('queue: Not Ready replies absent from the whole queue',
  JSON.stringify(q).includes('d-notready'), false)
eq('queue: reply reason mentions recency', q.replyWaiting[1].reason, 'replied 3h ago')
eq('queue: new leads = GHL new + FUB new', q.newLeads.map(i => i.key).sort(), ['deal:d-new', 'fub:1'])
eq('queue: due today = due + overdue + fub overdue', q.dueToday.map(i => i.key).sort(), ['deal:d-due', 'deal:d-overdue', 'fub:12'])
eq('queue: overdue sorts before later due', q.dueToday[0].key, 'deal:d-overdue')
eq('queue: overdue flag set', q.dueToday[0].overdue, true)
eq('queue: due-today flag not overdue', q.dueToday.find(i => i.key === 'deal:d-due')?.overdue, false)
eq('queue: counts.overdue', q.counts.overdue, 2)
// FUB now contributes ONLY Past Client + Closed (Efrain 2026-07-30) — the open
// pipeline stages are no longer pulled, so they must not surface anywhere.
eq('queue: past clients bucketed by idle', q.pastClients.b90.map(i => i.key), ['fub:6'])
eq('queue: open-pipeline FUB stages no longer surface',
  ['fub:2', 'fub:3', 'fub:4', 'fub:5'].map(k => JSON.stringify(q).includes(`"${k}"`)), [false, false, false, false])
eq('queue: unresponsive fully suppressed', JSON.stringify(q).includes('"fub:7"'), false)
eq('queue: matched-active suppressed', JSON.stringify(q).includes('"fub:9"'), false)
eq('queue: missing suppressed', JSON.stringify(q).includes('"fub:10"'), false)
eq('queue: trash suppressed', JSON.stringify(q).includes('"fub:8"'), false)
eq('queue: snoozed-future stays out of the book', JSON.stringify(q).includes('"fub:11"'), false)
eq('queue: far-future check-in not due', JSON.stringify(q.dueToday).includes('d-future'), false)
eq('queue: lost lead excluded', JSON.stringify(q).includes('d-lost'), false)
eq('queue: LO scoping — no Matt rows', JSON.stringify(q).includes('d-matt') || JSON.stringify(q).includes('"fub:13"'), false)
eq('queue: past-client chip shows stage + value', q.pastClients.b90[0].reason, 'Past Client · $610k')

// Matt's queue sees only his rows
const qm = buildFollowUpQueue({ deals, fub, lo: 'Matt Park', now: NOW })
eq('queue: Matt gets his reply-waiting', qm.replyWaiting.map(i => i.key), ['deal:d-matt'])
eq('queue: Matt sees only his FUB people', JSON.stringify(qm).includes('"fub:6"'), false)

// ── GHL leads in play: Pitching + App Intake, split by last activity ────────

const leadDeals: QueueDealLike[] = [
  deal({ id: 'p-fresh', status: 'Pitching', last_communication_at: iso(1 * D), last_outbound_at: iso(1 * D) }),
  deal({ id: 'p-6d', status: 'Pitching', last_communication_at: iso(6 * D), last_outbound_at: iso(6 * D) }),
  deal({ id: 'p-8d', status: 'Pitching', last_communication_at: iso(8 * D), last_outbound_at: iso(8 * D) }),
  deal({ id: 'a-today', status: 'App Intake', last_communication_at: iso(2 * H), last_outbound_at: iso(2 * H) }),
  deal({ id: 'a-40d', status: 'App Intake', last_communication_at: iso(40 * D), last_outbound_at: iso(40 * D) }),
  deal({ id: 'a-none', status: 'App Intake' }),                                            // no activity at all
  // newest signal wins the bucket: stale outbound but a fresh inbound reply
  deal({ id: 'p-inbound', status: 'Pitching', last_outbound_at: iso(30 * D), last_inbound_at: iso(2 * D), last_communication_at: iso(30 * D) }),
  deal({ id: 'p-lost', status: 'Pitching', ghl_status: 'lost', last_communication_at: iso(1 * D) }),
  deal({ id: 'p-matt', status: 'Pitching', loan_officer: 'Matt Park', last_communication_at: iso(1 * D) }),
  deal({ id: 'x-other', status: 'New Lead', last_communication_at: iso(1 * D) }),           // wrong status
]
const ls = buildLeadSections({ deals: leadDeals, lo: 'Moe Sefati', now: NOW })

eq('leads: recent = activity within 7d, freshest first', ls.recent.map(i => i.key), ['deal:a-today', 'deal:p-fresh', 'deal:p-inbound', 'deal:p-6d'])
eq('leads: older = quiet >7d, quietest first', ls.older.map(i => i.key), ['deal:a-none', 'deal:a-40d', 'deal:p-8d'])
eq('leads: never-touched lands in older', ls.older[0].key, 'deal:a-none')
eq('leads: no-activity reason', ls.older[0].reason, 'no activity recorded')
eq('leads: fresh inbound beats stale outbound for bucketing', ls.recent.some(i => i.key === 'deal:p-inbound'), true)
eq('leads: inbound reply is flagged in the reason', ls.recent.find(i => i.key === 'deal:p-inbound')?.reason, '2d ago · they replied last')
eq('leads: today reads "today"', ls.recent[0].reason, 'today')
eq('leads: lost excluded', JSON.stringify(ls).includes('p-lost'), false)
eq('leads: other LO excluded', JSON.stringify(ls).includes('p-matt'), false)
eq('leads: other statuses excluded', JSON.stringify(ls).includes('x-other'), false)
eq('leads: counts', ls.counts, { recent: 4, older: 3, pitching: 4, appIntake: 3 })
eq('leads: 7-day boundary is inclusive of day 6, exclusive past day 7',
  [ls.recent.some(i => i.key === 'deal:p-6d'), ls.older.some(i => i.key === 'deal:p-8d')], [true, true])
eq('lastActivityMs: coalesces to the newest touch',
  lastActivityMs({ id: 'x', status: 'Pitching', last_outbound_at: iso(30 * D), last_inbound_at: iso(2 * D) }), NOW - 2 * D)
eq('lastActivityMs: null when nothing recorded', lastActivityMs({ id: 'x', status: 'Pitching' }), null)

// ── FUB tasks (Efrain 2026-07-30: "tasks due within the next 7 days") ───────
// Dates are LOCAL YMD strings so these assertions hold in any timezone.

const T_TODAY = localYmd(NOW)
const ymdOff = (n: number) => localYmd(NOW, n)

const task = (over: Partial<QueueTaskLike>): QueueTaskLike => ({
  fub_task_id: over.fub_task_id ?? 1, person_id: 1, loan_officer: 'Moe Sefati',
  name: 'App yet?', type: 'Follow Up', due_date: T_TODAY, ...over,
})

const taskPeople: QueueFubLike[] = [
  fubRow({ fub_id: 1, name: 'Ana Alvarez', stage: 'Nurture' }),
  fubRow({ fub_id: 2, name: 'Bob Baker', stage: 'Pre Approved' }),
]

const tq = buildTaskQueue({
  lo: 'Moe Sefati', people: taskPeople, now: NOW,
  tasks: [
    task({ fub_task_id: 10, due_date: ymdOff(-1) }),                                   // overdue 1d
    task({ fub_task_id: 11, due_date: ymdOff(-45), person_id: 2 }),                    // overdue 45d
    task({ fub_task_id: 12, due_date: T_TODAY, name: 'Call about rate' , type: 'Call' }), // today
    task({ fub_task_id: 13, due_date: ymdOff(3) }),                                    // in window
    task({ fub_task_id: 14, due_date: ymdOff(7) }),                                    // window edge (inclusive)
    task({ fub_task_id: 15, due_date: ymdOff(8) }),                                    // just past window
    task({ fub_task_id: 16, due_date: ymdOff(180) }),                                  // far future
    task({ fub_task_id: 17, due_date: null }),                                         // undated → Due today, sorted last
    task({ fub_task_id: 18, due_date: T_TODAY, loan_officer: 'Matt Park' }),           // Matt's
    task({ fub_task_id: 19, due_date: ymdOff(2), person_id: 999 }),                    // person not stored
  ],
})

eq('tasks: overdue captured', tq.overdue.map(t => t.taskId), [10, 11])
eq('tasks: overdue sorted most-recent-first', tq.overdue.map(t => t.overdueDays), [1, 45])
eq('tasks: due today, undated last', tq.today.map(t => t.taskId), [12, 17])
eq('tasks: next 7 days incl. day-7 edge', tq.next7.map(t => t.taskId).sort((a, b) => a - b), [13, 14, 19])
eq('tasks: day 8 excluded', tq.next7.some(t => t.taskId === 15), false)
eq('tasks: undated never lands in Overdue', tq.overdue.some(t => t.taskId === 17), false)
eq('tasks: undated label', tq.today[1].dueLabel, 'no due date')
eq('tasks: other LO excluded', JSON.stringify(tq).includes('"taskId":18'), false)
eq('tasks: counts', tq.counts, { overdue: 2, today: 2, next7: 3 })
eq('tasks: person name resolved', tq.today[0].personName, 'Ana Alvarez')
eq('tasks: person stage resolved', tq.today[0].personStage, 'Nurture')
eq('tasks: unknown person falls back to id', tq.next7.find(t => t.taskId === 19)?.personName, 'FUB contact #999')
eq('tasks: due label today', tq.today[0].dueLabel, 'due today')
eq('tasks: due label overdue', tq.overdue[1].dueLabel, 'overdue 45d')
eq('tasks: title carried through', tq.today[0].title, 'Call about rate')
eq('tasks: type carried through', tq.today[0].type, 'Call')
eq('tasks: personId kept for the FUB link', tq.overdue[1].personId, 2)
eq('tasks: Matt sees only his', buildTaskQueue({ lo: 'Matt Park', people: taskPeople, now: NOW, tasks: [task({ fub_task_id: 18, due_date: T_TODAY, loan_officer: 'Matt Park' })] }).today.map(t => t.taskId), [18])

// mapFubTask + dedupe (a re-served page once rejected the whole upsert batch)
const mappedTask = mapFubTask({ id: 7, personId: 4, assignedUserId: 13, AssignedTo: 'Matt Park', name: 'App yet?', type: 'Follow Up', dueDate: '2026-08-01T00:00:00Z', dueDateTime: null, created: iso(5 * D), updated: iso(1 * D) })
eq('mapTask: LO from assignedUserId', mappedTask.loan_officer, 'Matt Park')
eq('mapTask: due_date truncated to YMD', mappedTask.due_date, '2026-08-01')
eq('mapTask: null dueDateTime stays null', mappedTask.due_date_time, null)
eq('dedupeTasks: keeps one row per id, last wins', dedupeTasks([
  { ...mappedTask, name: 'first' }, { ...mappedTask, name: 'second' }, { ...mappedTask, fub_task_id: 8 },
]).map(t => [t.fub_task_id, t.name]), [[7, 'second'], [8, 'App yet?']])

eq('ymdDiffDays: across a month boundary', ymdDiffDays('2026-07-28', '2026-08-03'), 6)
eq('ymdDiffDays: same day', ymdDiffDays('2026-07-30', '2026-07-30'), 0)
eq('localYmd: offset math', ymdDiffDays(localYmd(NOW), localYmd(NOW, 7)), 7)

// ── shouldStoreFubPerson — the sync pull filter ─────────────────────────────
// NARROWED 2026-07-30: FUB contributes ONLY the past-client book (Past Client +
// Closed), plus anyone carrying an open FUB task so task rows can show a name.

const storable = (over: Partial<Parameters<typeof shouldStoreFubPerson>[0]>, taskIds?: number[]) =>
  shouldStoreFubPerson({
    ...mapFubPerson({ id: 55, stage: 'Past Client', assignedUserId: 72, lastActivity: iso(200 * D) }, ['moe']),
    ...over,
  }, NOW, taskIds ? new Set(taskIds) : undefined)

eq('pull: Past Client stored', storable({}), true)
eq('pull: Closed stored', storable({ stage: 'Closed' }), true)
eq('pull: Past Client stored no matter how old', storable({ last_activity_at: iso(900 * D) }), true)
eq('pull: Matt (13) past client stored', storable({ assigned_user_id: 13 }), true)
eq('pull: other agent (999) dropped', storable({ assigned_user_id: 999 }), false)
eq('pull: unassigned dropped', storable({ assigned_user_id: null }), false)
eq('pull: null stage dropped', storable({ stage: null }), false)

// Everything that used to be pulled and no longer is.
for (const stage of ['Lead', 'Attempting Contact', 'In Contact', 'Nurture', 'Nurture - Credit',
                     'App Link Sent', 'App Review', 'Pre Approved', 'In Escrow', 'Contact',
                     'Unresponsive', 'Inactive', 'Trash', 'Referred Out']) {
  eq(`pull: ${stage} no longer pulled`, storable({ stage }), false)
}

// An open task still overrides the stage rule — otherwise its row loses the name.
eq('pull: open task rescues a non-past-client', storable({ stage: 'Nurture' }, [55]), true)
eq('pull: open task rescues an Inactive person', storable({ stage: 'Inactive' }, [55]), true)
eq('pull: a task cannot rescue another agent\'s person', storable({ stage: 'Nurture', assigned_user_id: 999 }, [55]), false)
eq('pull: task ids for OTHER people do not rescue', storable({ stage: 'Nurture' }, [999]), false)

// Directional contact dates come off FUB's per-channel timestamps; outbound
// deliberately ignores bulk/marketing sends.
const commRow = mapFubPerson({
  id: 77, stage: 'Past Client', assignedUserId: 72,
  lastReceivedText: iso(10 * D), lastIncomingCall: iso(3 * D), lastReceivedEmail: null,
  lastSentEmail: iso(20 * D), lastOutgoingCall: iso(45 * D),
  lastSentBatchEmail: iso(1 * D), lastDeliveredMarketingCampaign: iso(1 * D),
} as FubPersonRaw, ['moe'])
eq('map: inbound = newest received channel', commRow.last_inbound_at, iso(3 * D))
eq('map: outbound = newest PERSONAL sent channel', commRow.last_outbound_at, iso(20 * D))
eq('map: bulk/marketing sends never count as outbound',
  commRow.last_outbound_at !== iso(1 * D), true)
eq('map: no contact at all → nulls',
  [mapFubPerson({ id: 78, stage: 'Closed', assignedUserId: 72 }, ['moe']).last_inbound_at,
   mapFubPerson({ id: 78, stage: 'Closed', assignedUserId: 72 }, ['moe']).last_outbound_at], [null, null])

eq('idle: contact date drives the bucket, not lastActivity',
  fubIdleDays({ fub_id: 1, last_activity_at: iso(300 * D), last_outbound_at: iso(12 * D) }, NOW), 12)

// ── FUB unanswered texts (the FollowUpBoss half of the reply inbox) ─────────
// FUB's real unread inbox is owner-only and the per-message `read` flag is
// meaningless (false on 300/300 inbound, true on 300/300 outbound — verified
// live 2026-07-30), so "waiting on you" is reconstructed from the message feeds.

const txt = (over: Partial<FubTextMessage>): FubTextMessage => ({
  id: over.id ?? 1, personId: over.personId ?? 1, created: over.created ?? iso(1 * H),
  isIncoming: true, archived: false, ...over,
})

const inboundMsgs: FubTextMessage[] = [
  txt({ id: 1, personId: 100, name: 'Waiting Wanda', sent: iso(2 * H), message: '  hey are  you there?\n ' }),
  txt({ id: 2, personId: 100, name: 'Waiting Wanda', sent: iso(30 * H) }),          // older, same person
  txt({ id: 3, personId: 200, name: 'Answered Andy', sent: iso(6 * H) }),
  txt({ id: 4, personId: 300, name: 'Archived Ann', sent: iso(1 * H), archived: true }),
  txt({ id: 5, personId: 400, name: 'Old Otto', sent: iso(20 * D) }),
]
const outboundMsgs: FubTextMessage[] = [
  txt({ id: 6, personId: 200, name: 'Answered Andy', sent: iso(1 * H), isIncoming: false }),   // replied after
  txt({ id: 7, personId: 100, name: 'Waiting Wanda', sent: iso(40 * H), isIncoming: false }),  // replied BEFORE the inbound
]

const unanswered = unansweredFromMessages(inboundMsgs, outboundMsgs)
eq('fub inbox: only people whose last message is inbound', unanswered.map(u => u.fubId), [100, 400])
eq('fub inbox: keeps the newest inbound per person', unanswered[0].lastInboundAt, iso(2 * H))
eq('fub inbox: carries the prior outbound', unanswered[0].lastOutboundAt, iso(40 * H))
eq('fub inbox: preview is whitespace-collapsed', unanswered[0].preview, 'hey are you there?')
eq('fub inbox: FUB\'s redaction placeholder is not a preview',
  [messagePreview('* Body is hidden for privacy reasons *'), messagePreview('  '), messagePreview('real text')],
  [null, null, 'real text'])
eq('fub inbox: archived threads are not waiting', unanswered.some(u => u.fubId === 300), false)
eq('fub inbox: names fall back to the id', unansweredFromMessages([txt({ personId: 7, name: null, sent: iso(1 * H) })], [])[0].name, 'FUB contact #7')
eq('fub inbox: number normalizer',
  [normalizeFubNumber('(949) 868-9588'), normalizeFubNumber('+19515833140'), normalizeFubNumber('123'), normalizeFubNumber(null)],
  ['9498689588', '9515833140', null, null])

// ── Missed inbound calls ────────────────────────────────────────────────────
// ⚠️ `outcome` is the missed signal, NOT duration: 13 of 100 of Moe's incoming
// "No Answer" calls had duration > 0 (up to 278s of voicemail), so a duration
// test would quietly reclassify an eighth of the missed calls as answered.
// Incoming outcomes are only null (picked up) or 'No Answer' (verified live).

const call = (over: Partial<FubCall>): FubCall => ({
  id: over.id ?? 1, personId: over.personId ?? 1, created: over.created ?? iso(1 * H),
  isIncoming: true, ...over,
})

eq('call: outcome "No Answer" is missed regardless of duration',
  [isMissedInboundCall(call({ outcome: 'No Answer', duration: 0 })),
   isMissedInboundCall(call({ outcome: 'No Answer', duration: 278 })),
   isMissedInboundCall(call({ outcome: 'no answer' }))],
  [true, true, true])
eq('call: a picked-up incoming call is NOT missed',
  isMissedInboundCall(call({ outcome: null, duration: 1304 })), false)
eq('call: an OUTBOUND "No Answer" is never an inbound miss',
  isMissedInboundCall(call({ isIncoming: false, outcome: 'No Answer' })), false)

// The two-channel model on one timeline.
const inTouches = [
  ...[txt({ personId: 10, name: 'Texty Tess', sent: iso(2 * H) })].map(textTouch),
  ...[call({ personId: 20, name: 'Missed Mike', startedAt: iso(3 * H), outcome: 'No Answer' })].map(callTouch),
  ...[call({ personId: 30, name: 'Rang Rita', startedAt: iso(4 * H), outcome: 'No Answer' })].map(callTouch),
  ...[txt({ personId: 40, name: 'Called Back Carl', sent: iso(5 * H) })].map(textTouch),
]
const respTouches = [
  // We phoned Carl back after his text → handled, even though we never texted.
  ...[call({ personId: 40, isIncoming: false, startedAt: iso(1 * H) })].map(callTouch),
  // Rita rang again and someone PICKED UP → the conversation happened.
  ...[call({ personId: 30, isIncoming: true, outcome: null, duration: 300, startedAt: iso(1 * H) })].map(callTouch),
]
const twoChannel = unansweredFromTouches(inTouches, respTouches)
eq('two-channel: only the genuinely unanswered remain, newest first',
  twoChannel.map(u => [u.fubId, u.channel]), [[10, 'text'], [20, 'call']])
eq('two-channel: an outbound CALL answers an inbound text', twoChannel.some(u => u.fubId === 40), false)
eq('two-channel: a picked-up inbound call answers an earlier missed one', twoChannel.some(u => u.fubId === 30), false)
eq('two-channel: a missed call carries channel=call', twoChannel.find(u => u.fubId === 20)?.channel, 'call')
eq('two-channel: texts still default to channel=text', twoChannel.find(u => u.fubId === 10)?.channel, 'text')

// The per-person verification must consider calls too, or phoning someone back
// outside the paged window still reads as "ignored".
eq('verify: an outbound CALL after their message proves a reply',
  threadShowsReply([], iso(5 * H), [call({ isIncoming: false, startedAt: iso(1 * H) })]), true)
eq('verify: a picked-up inbound call proves the conversation happened',
  threadShowsReply([], iso(5 * H), [call({ isIncoming: true, outcome: null, startedAt: iso(1 * H) })]), true)
eq('verify: another MISSED call is not a reply',
  threadShowsReply([], iso(5 * H), [call({ isIncoming: true, outcome: 'No Answer', startedAt: iso(1 * H) })]), false)

// ── buildReplyInbox — the three-source merge ─────────────────────────────────

const liveRow = (over: Partial<LiveUnreadLike>): LiveUnreadLike => ({
  conversationId: 'conv1', contactId: 'c1', locationId: 'loc1', name: 'Live Lucy', unreadCount: 1, channel: 'Text',
  lastMessageAt: iso(1 * H), preview: 'call me', lo: 'Moe Sefati',
  dealId: null, dealStatus: null, dealPipelineGroup: 'Leads', ...over,
})
const fubRowUn = (over: Partial<FubUnansweredLike>): FubUnansweredLike => ({
  fubId: 900, name: 'Fub Fran', stage: 'Past Client', lastInboundAt: iso(4 * H),
  lastOutboundAt: null, preview: null, matchedDealActive: false, stored: true, ...over,
})

const inbox = buildReplyInbox({
  deals,
  live: [
    liveRow({ contactId: 'c-live', dealId: 'd-live', dealStatus: 'Docs Signed', dealPipelineGroup: 'Loans in Process', lastMessageAt: iso(30 * (60_000)) }),
    liveRow({ contactId: 'c-parked', dealId: 'd-parked', dealPipelineGroup: 'Not Ready' }),   // parked → excluded
    liveRow({ contactId: 'c-matt', dealId: 'd-mattlive', lo: 'Matt Park' }),                  // other LO
    liveRow({ contactId: 'c-nodeal', dealId: null, name: 'No Deal Ned' }),                    // no deal row of ours
  ],
  fubUnanswered: [
    fubRowUn({}),
    // Has an active GHL deal — still listed: the FUB text is its own thread and
    // GHL has no record of it (regression guard, 2026-07-30).
    fubRowUn({ fubId: 901, name: 'Also In Ghl Al', matchedDealActive: true, lastInboundAt: iso(3 * H) }),
    fubRowUn({ fubId: 902, name: 'Unstored Uma', stored: false, lastInboundAt: iso(5 * H) }),
    fubRowUn({ fubId: 903, name: 'Cold Carl', lastInboundAt: iso(20 * D) }),                  // older drawer
  ],
  lo: 'Moe Sefati',
  now: NOW,
})

eq('inbox: newest first across all three sources',
  inbox.fresh.map(i => i.key),
  ['deal:d-live', 'conv:c-nodeal', 'deal:d-hot', 'deal:d-reply', 'fub:901', 'fub:900', 'fub:902'])
eq('inbox: a Loans-in-Process unread surfaces (stale last_inbound_at cannot hide it)',
  inbox.fresh[0].reason, 'unread text · 30m ago')
eq('inbox: parked (Not Ready) live rows excluded', JSON.stringify(inbox).includes('d-parked'), false)
eq('inbox: other LO excluded', JSON.stringify(inbox).includes('d-mattlive'), false)
eq('inbox: FUB text still listed when the person also has a GHL deal',
  inbox.fresh.some(i => i.key === 'fub:901'), true)
eq('inbox: older-than-7d goes to the drawer', inbox.older.map(i => i.key), ['fub:903'])
// ghl/fub are scoped to the fresh list — the drawer has its own count.
eq('inbox: counts', [inbox.counts.fresh, inbox.counts.older, inbox.counts.total, inbox.counts.ghl, inbox.counts.fub], [7, 1, 8, 4, 3])
eq('inbox: read-only when there is nothing of ours to write',
  [inbox.fresh.find(i => i.key === 'conv:c-nodeal')?.readOnly,
   inbox.fresh.find(i => i.key === 'fub:902')?.readOnly,
   inbox.fresh.find(i => i.key === 'fub:900')?.readOnly],
  [true, true, false])

// A deal present in BOTH the live feed and the synced columns is listed once.
const dedupInbox = buildReplyInbox({
  deals: [deal({ id: 'd-reply', ghl_contact_id: 'c-reply', last_inbound_at: iso(3 * H), last_outbound_at: iso(9 * H) })],
  live: [liveRow({ contactId: 'c-reply', dealId: 'd-reply', lastMessageAt: iso(1 * H) })],
  fubUnanswered: [], lo: 'Moe Sefati', now: NOW,
})
eq('inbox: live + synced same deal listed once, live wins', dedupInbox.fresh.map(i => i.reason), ['unread text · 1h ago'])

// ── Touched / Snooze / Done must actually clear a reply-inbox row ────────────
// The two feeds behind this section are LIVE upstream reads, so a write that
// doesn't feed back into the builder leaves the row sitting there and the
// button reads as broken (Efrain 2026-07-30: "this touched button does not do
// anything"). Each action has a persisted suppression rule.

const ackBase = {
  deals: [
    deal({ id: 'd-snoozed', ghl_contact_id: 'c-sn', last_inbound_at: iso(2 * H), last_outbound_at: iso(9 * H),
      next_action_due: new Date(NOW + 3 * D).toISOString() }),
    deal({ id: 'd-open', ghl_contact_id: 'c-op', last_inbound_at: iso(2 * H), last_outbound_at: iso(9 * H) }),
  ],
  live: [] as LiveUnreadLike[],
  lo: 'Moe Sefati', now: NOW,
}
eq('inbox: a future check-in date snoozes a synced GHL row out',
  buildReplyInbox({ ...ackBase, fubUnanswered: [] }).fresh.map(i => i.key), ['deal:d-open'])
eq('inbox: a future check-in date snoozes a LIVE GHL row out',
  buildReplyInbox({ ...ackBase, fubUnanswered: [],
    live: [liveRow({ contactId: 'c-sn', dealId: 'd-snoozed' }), liveRow({ contactId: 'c-op', dealId: 'd-open' })] })
    .fresh.map(i => i.key), ['deal:d-open'])

const touchCase = (over: Partial<FubUnansweredLike>) => buildReplyInbox({
  deals: [], live: [], lo: 'Moe Sefati', now: NOW,
  fubUnanswered: [fubRowUn({ fubId: 950, lastInboundAt: iso(4 * H), ...over })],
}).fresh.length
eq('inbox: Touched AFTER their message clears the row', touchCase({ lastTouchedAt: iso(1 * H) }), 0)
eq('inbox: Touched BEFORE their message does NOT clear it', touchCase({ lastTouchedAt: iso(9 * H) }), 1)
eq('inbox: a future snooze clears a FUB row', touchCase({ nextActionDue: new Date(NOW + 2 * D).toISOString() }), 0)
eq('inbox: a PAST snooze does not clear a FUB row', touchCase({ nextActionDue: iso(2 * D) }), 1)
eq('inbox: untouched, unsnoozed FUB row stays', touchCase({}), 1)

eq('inbox: session dismissals hide rows and leave the counts consistent',
  (() => {
    const d = buildReplyInbox({ ...ackBase, fubUnanswered: [], dismissed: new Set(['deal:d-open']) })
    return [d.fresh.map(i => i.key), d.counts.total]
  })(), [[], 0])

// The GHL "Done" button writes comm_read_acks, keyed on the CONVERSATION id —
// so the id has to survive onto the item or the button has nothing to write.
eq('inbox: live rows carry the conversation id for the Done ack',
  buildReplyInbox({ deals: [], fubUnanswered: [], lo: 'Moe Sefati', now: NOW,
    live: [liveRow({ conversationId: 'conv-xyz' })] }).fresh[0].conversationId, 'conv-xyz')

// ── Unanswered EMAIL ────────────────────────────────────────────────────────
// FUB has no account-wide inbound-email feed for an agent key (/v1/emails
// demands a person or thread id; /v1/events carries no email types), so email
// is discovered from the person payload's lastReceivedEmail on the hourly
// sweep, then verified per person on the live request.

const person = (over: Record<string, unknown>): FubPersonRaw =>
  ({ id: 1, name: 'Emailer Emma', assignedUserId: 72, ...over }) as FubPersonRaw

const emailCands = emailWaitingFromPeople([
  // waiting: they emailed after our last personal response
  person({ id: 1, lastReceivedEmail: iso(2 * H), lastSentEmail: iso(2 * D) }),
  // answered by EMAIL
  person({ id: 2, lastReceivedEmail: iso(2 * D), lastSentEmail: iso(1 * H) }),
  // answered by TEXT — a response on any personal channel counts
  person({ id: 3, lastReceivedEmail: iso(2 * D), lastSentText: iso(1 * H) }),
  // answered by an outbound CALL
  person({ id: 4, lastReceivedEmail: iso(2 * D), lastOutgoingCall: iso(1 * H) }),
  // ⚠️ only a BULK send since — that must NOT count as answering them
  person({ id: 5, lastReceivedEmail: iso(2 * D), lastSentBatchEmail: iso(1 * H), lastDeliveredMarketingCampaign: iso(1 * H) }),
  // never answered at all
  person({ id: 6, lastReceivedEmail: iso(3 * D) }),
  // outside the lookback window
  person({ id: 7, lastReceivedEmail: iso(200 * D) }),
  // no email traffic at all
  person({ id: 8, lastSentEmail: iso(1 * D) }),
  // duplicate id across the two key sweeps → counted once
  person({ id: 1, lastReceivedEmail: iso(2 * H), lastSentEmail: iso(2 * D) }),
], NOW - 90 * D)

eq('email: newest first', emailCands.map(c => c.fubId), [1, 5, 6])
eq('email: waiting set is exactly {1,5,6}', emailCands.map(c => c.fubId).sort((a, b) => a - b), [1, 5, 6])
eq('email: a bulk send NEVER counts as a response', emailCands.some(c => c.fubId === 5), true)
eq('email: answered by text or call is cleared', emailCands.some(c => c.fubId === 3 || c.fubId === 4), false)
eq('email: outside the lookback window is dropped', emailCands.some(c => c.fubId === 7), false)
eq('email: deduped across the two key sweeps', emailCands.filter(c => c.fubId === 1).length, 1)
eq('email: carries the assigned user for LO scoping', emailCands.find(c => c.fubId === 1)?.assignedUserId, 72)

// Direction on /v1/emails is `status`, NOT an isIncoming flag (verified live:
// the vocabulary is exactly Sent / Received).
const mails = [
  { id: 1, created: iso(1 * H), status: 'Sent' },
  { id: 2, created: iso(3 * H), status: 'Received' },
]
eq('email: a Sent after their Received proves a reply', emailsShowReply(mails, iso(3 * H)), true)
eq('email: only OLDER Sent is not a reply', emailsShowReply(mails, iso(30 * 60_000)), false)
eq('email: a Received is never a reply', emailsShowReply([mails[1]], iso(4 * H)), false)
eq('email: isReceivedEmail reads the status vocabulary',
  [isReceivedEmail({ id: 1, created: '', status: 'Received' }),
   isReceivedEmail({ id: 2, created: '', status: 'Sent' }),
   isReceivedEmail({ id: 3, created: '', status: null })],
  [true, false, false])
eq('email: parseEmailWaiting tolerates junk',
  parseEmailWaiting([{ fubId: 5, name: 'A', receivedAt: iso(1 * D), assignedUserId: 72, lastResponseAt: null },
                     { fubId: 'x' }, null, { fubId: 6, receivedAt: 'nope' }]).map(r => r.fubId), [5])

// ── "Done" acks — check a row off until they message AGAIN ──────────────────
// Efrain 2026-07-30: "Sometimes a reply from a client doesn't need a reply from
// us, can we check it off from the list without having a sync or anything
// bringing it back. Only thing to bring it back would be a new response."

const acks = parseFubInboxAcks({ '100': iso(3 * H), '200': iso(10 * D), 'junk': 'x', '300': 'not-a-date' })
eq('ack: parses only usable entries', [...acks.keys()].sort((a, b) => a - b), [100, 200])
eq('ack: a message at/older than the ack stays cleared',
  [isAcked(acks, 100, iso(3 * H)), isAcked(acks, 100, iso(5 * H))], [true, true])
eq('ack: a NEWER message brings the row back', isAcked(acks, 100, iso(1 * H)), false)
eq('ack: an unacked person is never cleared', isAcked(acks, 999, iso(1 * H)), false)
eq('ack: an unparseable inbound never silently clears', isAcked(acks, 100, 'nope'), false)
eq('ack: a sync re-reporting the SAME message does not resurface it',
  isAcked(acks, 200, iso(10 * D)), true)
eq('ack: prune drops entries past the lookback window',
  Object.keys(pruneAcks({ '1': iso(5 * D), '2': iso(120 * D), '3': 'junk' }, NOW - 90 * D)), ['1'])

// ── threadShowsReply — the per-person verification fallback ─────────────────
// Guards the false-positive that shipped first: paging a fixed number of pages
// gave the outbound feed a SHALLOWER time horizon than the inbound feed (higher
// outbound volume), so a reply older than that horizon was invisible and the
// person looked ignored. Tami Boteilho was flagged "texted 59d ago, unanswered"
// when Moe had replied 98 seconds later.
const tami = [
  txt({ id: 20, personId: 53283, sent: '2026-06-01T19:31:13Z', isIncoming: false }),
  txt({ id: 21, personId: 53283, sent: '2026-06-01T19:29:35Z', isIncoming: true }),
]
eq('verify: an outbound after their message proves a reply', threadShowsReply(tami, '2026-06-01T19:29:35Z'), true)
eq('verify: only OLDER outbound is not a reply', threadShowsReply(tami, '2026-06-02T10:00:00Z'), false)
eq('verify: an inbound-only thread is not a reply',
  threadShowsReply([txt({ personId: 1, sent: '2026-06-01T19:29:35Z' })], '2026-06-01T19:29:35Z'), false)
eq('verify: unparseable timestamp never falsely clears', threadShowsReply(tami, 'not-a-date'), false)

// ── helpers ──────────────────────────────────────────────────────────────────

// Idle = days since a real CONVERSATION. FUB's lastActivity (opens, marketing,
// record edits) must never make a silent contact look recent — it did, putting a
// client last talked to 98 days ago in the "7–30 days" bucket.
eq('idle: newest of inbound/outbound/our touch', fubIdleDays({ fub_id: 1, last_inbound_at: iso(40 * D), last_outbound_at: iso(9 * D), last_touched_at: iso(5 * D) }, NOW), 5)
eq('idle: IGNORES lastActivity entirely', fubIdleDays({ fub_id: 1, last_activity_at: iso(1 * D), last_outbound_at: iso(98 * D) }, NOW), 98)
eq('idle: IGNORES fub_created_at', fubIdleDays({ fub_id: 1, fub_created_at: iso(12 * D) }, NOW), null)
eq('idle: activity-only person counts as never talked', fubIdleDays({ fub_id: 1, last_activity_at: iso(2 * D), fub_created_at: iso(500 * D) }, NOW), null)
eq('idle: nothing known → null', fubIdleDays({ fub_id: 1 }, NOW), null)
eq('replyWaiting: no inbound → false', isReplyWaiting(deal({ id: 'x' }), NOW), false)

const snooze = new Date(snoozeIso(7, NOW))
eq('snooze: lands 7 days out at 9am local', [snooze.getHours(), Math.round((snooze.getTime() - NOW) / D)], [9, 7])

console.log(`\n${fail === 0 ? '✅' : '❌'} follow-up-check: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
