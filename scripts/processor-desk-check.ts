// Fixture check for lib/processorDesk.ts — the Processing Desk scope rule.
// Pure, no DB. Run: npx tsx scripts/processor-desk-check.ts
//
// The rule under test is two conditions ANDed:
//     pipeline_group = 'Loans in Process'  AND  processor_status = <processor>
// Get either half wrong and the desk either hides a live file or shows a funded
// one, so both halves are asserted independently.
//
// For the same rule run against the REAL table, see
// scripts/processor-desk-report.ts (deliberately not named *-check.ts — the
// fixture runner globs that pattern and this repo's checks must stay offline).

import {
  processorOf, isOnDesk, deskDeals, deskKpis, openTasksByDeal, sortDesk,
  pastSla, daysUntil, daysSince, ESCROW_PIPELINE, DEFAULT_PROCESSOR,
} from '../lib/processorDesk'
import type { Deal, DealTask } from '../lib/types'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++ } else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}

const NOW = new Date('2026-08-10T12:00:00Z').getTime()
const daysOut = (n: number) => new Date(NOW + n * 86_400_000).toISOString()

// Minimal Deal factory — only the fields the desk reads.
const deal = (p: Partial<Deal>): Deal => ({
  id: 'd1', name: 'Test', status: 'Submitted to UW', pipeline_group: ESCROW_PIPELINE,
  loan_officer: 'Moe Sefati', processor: null, processor_status: DEFAULT_PROCESSOR,
  lock_expiration: null, stage_changed_at: null, created_at: daysOut(-1),
  next_action_due: null, ...p,
} as Deal)

const task = (p: Partial<DealTask>): DealTask => ({
  id: 't1', deal_id: 'd1', title: 'x', description: null, due_at: null,
  assignee: 'Brianne Han', assigned_by: DEFAULT_PROCESSOR, priority: 'normal',
  completed_at: null, created_at: daysOut(-1), ...p,
})

// ── processorOf: status wins, legacy column is the fallback ────────────────
eq('processor_status wins', processorOf({ processor_status: 'Hanh Nguyen', processor: 'Susan Lim' }), 'Hanh Nguyen')
eq('falls back to legacy processor', processorOf({ processor_status: null, processor: 'Hanh Nguyen' }), 'Hanh Nguyen')
eq('blank status falls through', processorOf({ processor_status: '   ', processor: 'Susan Lim' }), 'Susan Lim')
eq('both blank → null', processorOf({ processor_status: null, processor: null }), null)
eq('whitespace is trimmed', processorOf({ processor_status: ' Hanh Nguyen ', processor: null }), 'Hanh Nguyen')

// ── isOnDesk: BOTH halves required ────────────────────────────────────────
eq('in process + assigned → on desk', isOnDesk(deal({}), 'Hanh Nguyen'), true)
eq('assigned but FUNDED → off desk', isOnDesk(deal({ pipeline_group: 'Funded' }), 'Hanh Nguyen'), false)
eq('assigned but a LEAD → off desk', isOnDesk(deal({ pipeline_group: 'Leads' }), 'Hanh Nguyen'), false)
eq('in process but someone else → off desk', isOnDesk(deal({ processor_status: 'Susan Lim' }), 'Hanh Nguyen'), false)
eq('in process, unassigned → off desk', isOnDesk(deal({ processor_status: null }), 'Hanh Nguyen'), false)
// Self Processing is a real PROCESSORS value, not a synonym for unassigned —
// it must land on its own desk and never leak onto a person's.
eq('Self Processing is its own desk', isOnDesk(deal({ processor_status: 'Self Processing' }), 'Self Processing'), true)
eq('Self Processing does not leak to Hanh', isOnDesk(deal({ processor_status: 'Self Processing' }), 'Hanh Nguyen'), false)
// Exact match — no fuzzy name resolution here, unlike resolveLO for LOs.
eq('no fuzzy matching on first name', isOnDesk(deal({ processor_status: 'Hanh' }), 'Hanh Nguyen'), false)

eq('deskDeals filters the list', deskDeals([
  deal({ id: 'a' }),
  deal({ id: 'b', pipeline_group: 'Funded' }),
  deal({ id: 'c', processor_status: 'Jessica Ching' }),
  deal({ id: 'd', processor_status: null, processor: 'Hanh Nguyen' }),
], 'Hanh Nguyen').map(d => d.id), ['a', 'd'])

// ── Date helpers ──────────────────────────────────────────────────────────
eq('daysUntil future', daysUntil(daysOut(5), NOW), 5)
eq('daysUntil past is negative', daysUntil(daysOut(-3), NOW), -3)
eq('daysUntil null', daysUntil(null, NOW), null)
eq('daysUntil garbage', daysUntil('not-a-date', NOW), null)
eq('daysSince', daysSince(daysOut(-4), NOW), 4)

// ── SLA ───────────────────────────────────────────────────────────────────
// 'Submitted to UW' has a 5-day SLA (lib/types.ts STAGE_SLA_DAYS).
eq('6 days in a 5-day stage is past SLA', pastSla(deal({ stage_changed_at: daysOut(-6) }), NOW), true)
eq('5 days in a 5-day stage is not', pastSla(deal({ stage_changed_at: daysOut(-5) }), NOW), false)
eq('stage with no SLA never trips', pastSla(deal({ status: 'Loan Finalized', stage_changed_at: daysOut(-90) }), NOW), false)
// A row that never got a stage_changed_at falls back to created_at rather than
// silently scoring as fresh.
eq('falls back to created_at', pastSla(deal({ stage_changed_at: null, created_at: daysOut(-9) }), NOW), true)

// ── Task indexing ─────────────────────────────────────────────────────────
const tasks = [
  task({ id: '1', deal_id: 'a' }),
  task({ id: '2', deal_id: 'a', due_at: daysOut(-2) }),          // overdue
  task({ id: '3', deal_id: 'b', completed_at: daysOut(-1) }),    // done — excluded
  task({ id: '4', deal_id: null }),                              // standalone — excluded
]
const idx = openTasksByDeal(tasks)
eq('open tasks grouped by deal', idx.get('a')?.map(t => t.id), ['1', '2'])
eq('completed tasks excluded', idx.get('b'), undefined)
eq('deal-less tasks excluded', [...idx.keys()], ['a'])

// ── KPIs ──────────────────────────────────────────────────────────────────
const mine = [
  deal({ id: 'a', lock_expiration: daysOut(3) }),                       // lock soon
  deal({ id: 'b', stage_changed_at: daysOut(-8) }),                     // past SLA, no task
  deal({ id: 'c', lock_expiration: daysOut(30) }),                      // no task
]
eq('kpis', deskKpis(mine, idx, NOW), {
  files: 3, openTasks: 2, overdueTasks: 1, noTask: 2, lockSoon: 1, overSla: 1,
})
// An already-expired lock still counts as "≤ 7 days" — it's more urgent, not
// less, and must not fall out of the warning.
eq('expired lock counts in lockSoon', deskKpis([deal({ lock_expiration: daysOut(-4) })], new Map(), NOW).lockSoon, 1)

// ── Sort: overdue first, then soonest lock, then longest in stage ──────────
eq('sort order', sortDesk([
  deal({ id: 'fresh' }),
  deal({ id: 'locksoon', lock_expiration: daysOut(2) }),
  deal({ id: 'overdue', next_action_due: daysOut(-1) }),
  deal({ id: 'stale', stage_changed_at: daysOut(-40) }),
], NOW).map(d => d.id), ['overdue', 'locksoon', 'stale', 'fresh'])
eq('sort does not mutate the input', (() => {
  const input = [deal({ id: 'x' }), deal({ id: 'overdue', next_action_due: daysOut(-1) })]
  sortDesk(input, NOW)
  return input.map(d => d.id)
})(), ['x', 'overdue'])

console.log(`\n${fail === 0 ? '✓' : '✗'} processor-desk-check: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
