// Fixture suite for the Follow-Up Cockpit: lib/followUpBoss.ts (mapping/merge/diff)
// + lib/followUpQueue.ts (queue building). Run: npx tsx scripts/follow-up-check.ts
//
// Times are relative to a fixed NOW so assertions are deterministic. Day-boundary
// fixtures (due today / overdue) stay ≥ 2h inside the local day on either side,
// so the suite passes in any timezone the runner uses.

import {
  mapFubPerson, mapFubTask, dedupeTasks, mergeSweeps, diffSweep, shouldStoreFubPerson,
  type FubPersonRaw, type ExistingFubRow,
} from '../lib/followUpBoss'
import {
  buildFollowUpQueue, buildTaskQueue, buildLeadSections, lastActivityMs,
  fubIdleDays, snoozeIso, isReplyWaiting, localYmd, ymdDiffDays,
  type QueueDealLike, type QueueFubLike, type QueueTaskLike,
} from '../lib/followUpQueue'

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
  // inbound but status already worked in /hot-leads
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

eq('queue: reply-waiting exactly the unanswered one', q.replyWaiting.map(i => i.key), ['deal:d-reply'])
eq('queue: Not Ready pipeline never counts as reply-waiting',
  [isReplyWaiting(deal({ id: 'x', pipeline_group: 'Not Ready', status: 'Remove from All Automations', last_inbound_at: iso(1 * H) }), NOW),
   isReplyWaiting(deal({ id: 'y', pipeline_group: 'Not Ready', status: 'Not Ready - Timeframe', last_inbound_at: iso(1 * H) }), NOW)],
  [false, false])
eq('queue: Not Ready replies absent from the whole queue',
  JSON.stringify(q).includes('d-notready'), false)
eq('queue: reply reason mentions recency', q.replyWaiting[0].reason, 'replied 3h ago')
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
    task({ fub_task_id: 17, due_date: null }),                                         // undated → excluded
    task({ fub_task_id: 18, due_date: T_TODAY, loan_officer: 'Matt Park' }),           // Matt's
    task({ fub_task_id: 19, due_date: ymdOff(2), person_id: 999 }),                    // person not stored
  ],
})

eq('tasks: overdue captured', tq.overdue.map(t => t.taskId), [10, 11])
eq('tasks: overdue sorted most-recent-first', tq.overdue.map(t => t.overdueDays), [1, 45])
eq('tasks: due today', tq.today.map(t => t.taskId), [12])
eq('tasks: next 7 days incl. day-7 edge', tq.next7.map(t => t.taskId).sort((a, b) => a - b), [13, 14, 19])
eq('tasks: day 8 excluded', tq.next7.some(t => t.taskId === 15), false)
eq('tasks: undated excluded', JSON.stringify(tq).includes('"taskId":17'), false)
eq('tasks: other LO excluded', JSON.stringify(tq).includes('"taskId":18'), false)
eq('tasks: counts', tq.counts, { overdue: 2, today: 1, next7: 3 })
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

eq('idle: contact dates beat a stale lastActivity',
  fubIdleDays({ fub_id: 1, last_activity_at: iso(300 * D), last_outbound_at: iso(12 * D) }, NOW), 12)

// ── helpers ──────────────────────────────────────────────────────────────────

eq('idle: max of activity vs touch', fubIdleDays(fubRow({ last_activity_at: iso(40 * D), last_touched_at: iso(5 * D) }), NOW), 5)
eq('idle: created-only fallback', fubIdleDays({ fub_id: 1, fub_created_at: iso(12 * D) }, NOW), 12)
eq('idle: nothing known → null', fubIdleDays({ fub_id: 1 }, NOW), null)
eq('replyWaiting: no inbound → false', isReplyWaiting(deal({ id: 'x' }), NOW), false)

const snooze = new Date(snoozeIso(7, NOW))
eq('snooze: lands 7 days out at 9am local', [snooze.getHours(), Math.round((snooze.getTime() - NOW) / D)], [9, 7])

console.log(`\n${fail === 0 ? '✅' : '❌'} follow-up-check: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
