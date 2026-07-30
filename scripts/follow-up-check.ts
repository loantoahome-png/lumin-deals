// Fixture suite for the Follow-Up Cockpit: lib/followUpBoss.ts (mapping/merge/diff)
// + lib/followUpQueue.ts (queue building). Run: npx tsx scripts/follow-up-check.ts
//
// Times are relative to a fixed NOW so assertions are deterministic. Day-boundary
// fixtures (due today / overdue) stay ≥ 2h inside the local day on either side,
// so the suite passes in any timezone the runner uses.

import {
  mapFubPerson, mergeSweeps, diffSweep, shouldStoreFubPerson,
  type FubPersonRaw, type ExistingFubRow,
} from '../lib/followUpBoss'
import {
  buildFollowUpQueue, fubIdleDays, snoozeIso, isReplyWaiting,
  type QueueDealLike, type QueueFubLike,
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
  { fub_id: 101, fub_updated_at: row.fub_updated_at, last_activity_at: row.last_activity_at, stage: 'Nurture', assigned_user_id: 72, missing_since: null },  // unchanged
  { fub_id: 500, fub_updated_at: null, last_activity_at: null, stage: 'Lead', assigned_user_id: 72, missing_since: null },                                    // stage same? swept has null stage → changed? swept 500 stage=null vs 'Lead' → changed
  { fub_id: 700, fub_updated_at: null, last_activity_at: null, stage: 'Lead', assigned_user_id: 13, missing_since: null },                                    // gone from sweep
  { fub_id: 800, fub_updated_at: null, last_activity_at: null, stage: 'Lead', assigned_user_id: 13, missing_since: iso(5 * D) },                              // already flagged missing
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
  [{ fub_id: 101, fub_updated_at: pgFormat(row.fub_updated_at), last_activity_at: pgFormat(row.last_activity_at), stage: row.stage, assigned_user_id: 72, missing_since: null }],
)
eq('diff: pg timestamp format is not a change', [fmtDrift.toInsert.length, fmtDrift.toUpdate.length], [0, 0])

// resurrect: a row flagged missing that reappears in the sweep → update
const resurrect = diffSweep(
  [mapFubPerson({ id: 800, stage: 'Lead', assignedUserId: 13 }, ['matt'])],
  [{ fub_id: 800, fub_updated_at: null, last_activity_at: null, stage: 'Lead', assigned_user_id: 13, missing_since: iso(5 * D) }],
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
eq('queue: reply reason mentions recency', q.replyWaiting[0].reason, 'replied 3h ago')
eq('queue: new leads = GHL new + FUB new', q.newLeads.map(i => i.key).sort(), ['deal:d-new', 'fub:1'])
eq('queue: due today = due + overdue + fub overdue', q.dueToday.map(i => i.key).sort(), ['deal:d-due', 'deal:d-overdue', 'fub:12'])
eq('queue: overdue sorts before later due', q.dueToday[0].key, 'deal:d-overdue')
eq('queue: overdue flag set', q.dueToday[0].overdue, true)
eq('queue: due-today flag not overdue', q.dueToday.find(i => i.key === 'deal:d-due')?.overdue, false)
eq('queue: counts.overdue', q.counts.overdue, 2)
eq('queue: stale 7–30 bucket', q.stale.b7_30.map(i => i.key), ['fub:2'])
eq('queue: stale 31–90 bucket', q.stale.b31_90.map(i => i.key), ['fub:3'])
eq('queue: stale 90+ bucket', q.stale.b90.map(i => i.key), ['fub:4'])
eq('queue: past clients bucketed', q.pastClients.b90.map(i => i.key), ['fub:6'])
eq('queue: unresponsive fully suppressed', JSON.stringify(q).includes('"fub:7"'), false)
eq('queue: engaged (<7d idle) not stale', JSON.stringify(q.stale).includes('fub:5'), false)
eq('queue: matched-active suppressed', JSON.stringify(q).includes('"fub:9"'), false)
eq('queue: missing suppressed', JSON.stringify(q).includes('"fub:10"'), false)
eq('queue: trash suppressed', JSON.stringify(q).includes('"fub:8"'), false)
eq('queue: snoozed-future out of stale', JSON.stringify(q.stale).includes('fub:11'), false)
eq('queue: far-future check-in not due', JSON.stringify(q.dueToday).includes('d-future'), false)
eq('queue: lost lead excluded', JSON.stringify(q).includes('d-lost'), false)
eq('queue: LO scoping — no Matt rows', JSON.stringify(q).includes('d-matt') || JSON.stringify(q).includes('"fub:13"'), false)
eq('queue: stale reason format', q.stale.b7_30[0].reason, 'idle 10d · Pre Approved · $510k')

// Matt's queue sees only his rows
const qm = buildFollowUpQueue({ deals, fub, lo: 'Matt Park', now: NOW })
eq('queue: Matt gets his reply-waiting', qm.replyWaiting.map(i => i.key), ['deal:d-matt'])
eq('queue: Matt gets his FUB stale', qm.stale.b31_90.map(i => i.key), ['fub:13'])

// ── shouldStoreFubPerson (the sync pull filter — Efrain 2026-07-30) ──────────

const storable = (over: Partial<Parameters<typeof shouldStoreFubPerson>[0]>) =>
  shouldStoreFubPerson({
    ...mapFubPerson({ id: 1, stage: 'Nurture', assignedUserId: 72, lastActivity: iso(200 * D) }, ['moe']),
    ...over,
  }, NOW)

eq('pull: nurture person assigned to Moe stored', storable({}), true)
eq('pull: Matt (13) stored', storable({ assigned_user_id: 13 }), true)
eq('pull: other agent (999) dropped', storable({ assigned_user_id: 999 }), false)
eq('pull: unassigned dropped', storable({ assigned_user_id: null }), false)
eq('pull: Unresponsive dropped', storable({ stage: 'Unresponsive' }), false)
eq('pull: Inactive dropped', storable({ stage: 'Inactive' }), false)
eq('pull: Trash dropped', storable({ stage: 'Trash' }), false)
eq('pull: null stage dropped', storable({ stage: null }), false)
eq('pull: raw Lead active 30d ago stored', storable({ stage: 'Lead', last_activity_at: iso(30 * D) }), true)
eq('pull: raw Lead idle 200d dropped', storable({ stage: 'Lead', last_activity_at: iso(200 * D) }), false)
eq('pull: raw Lead no activity but CREATED 10d ago stored', storable({ stage: 'Lead', last_activity_at: null, fub_created_at: iso(10 * D) }), true)
eq('pull: Attempting Contact idle 91d dropped', storable({ stage: 'Attempting Contact', last_activity_at: iso(91 * D), fub_created_at: iso(300 * D) }), false)
eq('pull: deep-idle Nurture STILL stored (only raw stages age out)', storable({ stage: 'Nurture', last_activity_at: iso(400 * D) }), true)
eq('pull: Past Client stored regardless of idle', storable({ stage: 'Past Client', last_activity_at: iso(400 * D) }), true)

// ── helpers ──────────────────────────────────────────────────────────────────

eq('idle: max of activity vs touch', fubIdleDays(fubRow({ last_activity_at: iso(40 * D), last_touched_at: iso(5 * D) }), NOW), 5)
eq('idle: created-only fallback', fubIdleDays({ fub_id: 1, fub_created_at: iso(12 * D) }, NOW), 12)
eq('idle: nothing known → null', fubIdleDays({ fub_id: 1 }, NOW), null)
eq('replyWaiting: no inbound → false', isReplyWaiting(deal({ id: 'x' }), NOW), false)

const snooze = new Date(snoozeIso(7, NOW))
eq('snooze: lands 7 days out at 9am local', [snooze.getHours(), Math.round((snooze.getTime() - NOW) / D)], [9, 7])

console.log(`\n${fail === 0 ? '✅' : '❌'} follow-up-check: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
