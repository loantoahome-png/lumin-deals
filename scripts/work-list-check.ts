// Fixture check for lib/workList.ts + the ChecklistState additions.
// Pure, no DB. Run: npx tsx scripts/work-list-check.ts

import {
  buildWorkItems, groupByAction, groupsForState, workState, workCounts,
  sortByWait, recentlyCompleted, worklistTemplate, daysSince,
} from '../lib/workList'
import {
  mergeChecklist, toState, requestItem, clearRequest, addCustomRow,
  removeCustomRow, toggleItem, isRequested, isCustomId, CUSTOM_PHASE,
  type ChecklistState,
} from '../lib/processorChecklist'
import type { Deal } from '../lib/types'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++ } else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}

const NOW = new Date('2026-08-10T12:00:00Z').getTime()
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString()

const deal = (id: string, name: string, p: Partial<Deal> = {}): Deal => ({
  id, name, status: 'Submitted to UW', pipeline_group: 'Loans in Process',
  loan_officer: 'Moe Sefati', loan_purpose: 'Refinance', processor_checklist: null,
  ...p,
} as Deal)

// ── The worklist subset is a SUBSET ────────────────────────────────────────
// The whole point of the flag: 26 steps × 9 loans is unusable.
const wl = worklistTemplate()
eq('worklist steps are fewer than the full template', wl.length < 26, true)
eq('worklist includes payoff', wl.some(d => d.id === 'ord-payoff'), true)
eq('worklist includes title ordered', wl.some(d => d.id === 'ord-title'), true)
eq('worklist EXCLUDES a non-chase step (1003 reviewed)', wl.some(d => d.id === 'setup-1003'), false)
eq('worklist EXCLUDES Funded', wl.some(d => d.id === 'close-funded'), false)

// ── State round-trips through toState ──────────────────────────────────────
// ⚠️ The regression that would silently eat every requested stamp.
{
  let rows = mergeChecklist(null, undefined, 'Refinance')
  rows = requestItem(rows, 'ord-payoff', 'fax 916-464-2477', 'Brianne Han', daysAgo(4))
  const saved = toState(rows)
  const payoff = saved.find(s => s.id === 'ord-payoff')!
  eq('requested_from survives toState', payoff.requested_from, 'fax 916-464-2477')
  eq('requested_by survives toState', payoff.requested_by, 'Brianne Han')
  eq('requested_at survives toState', payoff.requested_at, daysAgo(4))
  // and back in again
  const reloaded = mergeChecklist(saved, undefined, 'Refinance')
  eq('survives a full save/reload cycle',
    reloaded.find(r => r.id === 'ord-payoff')?.requested_from, 'fax 916-464-2477')

  // An untouched item must NOT gain empty requested keys — that would bloat the
  // column on every save for all 26 rows on every loan.
  const untouched = saved.find(s => s.id === 'ord-title')!
  eq('untouched item has no requested keys', 'requested_at' in untouched, false)
}

// ── Done keeps the requested stamp (turnaround record) ─────────────────────
{
  let rows = mergeChecklist(null, undefined, 'Refinance')
  rows = requestItem(rows, 'ord-hoi', 'nadia.hall@trucordia.com', 'Brianne Han', daysAgo(4))
  rows = toggleItem(rows, 'ord-hoi', 'Hanh Nguyen', daysAgo(0))
  const r = rows.find(x => x.id === 'ord-hoi')!
  eq('done keeps requested_at', r.requested_at, daysAgo(4))
  eq('done keeps requested_from', r.requested_from, 'nadia.hall@trucordia.com')
  eq('done stamps its own person', r.done_by, 'Hanh Nguyen')
  eq('a done item is not "requested"', isRequested(r), false)
  // untick returns it to waiting, not to untouched
  const un = toggleItem(rows, 'ord-hoi', null, daysAgo(0)).find(x => x.id === 'ord-hoi')!
  eq('untick returns to waiting', isRequested(un), true)
}

eq('clearRequest wipes all three', (() => {
  let rows = mergeChecklist(null, undefined, 'Refinance')
  rows = requestItem(rows, 'ord-title', 'Alamo', 'Bri', daysAgo(1))
  rows = clearRequest(rows, 'ord-title')
  const r = rows.find(x => x.id === 'ord-title')!
  return [r.requested_at, r.requested_by, r.requested_from]
})(), [null, null, null])

eq('blank requested_from collapses to null', (() => {
  const rows = requestItem(mergeChecklist(null, undefined, 'Refinance'), 'ord-title', '   ', 'Bri', daysAgo(1))
  return rows.find(x => x.id === 'ord-title')!.requested_from
})(), null)

// ── Custom rows survive; template rows can't be deleted ────────────────────
{
  let rows = mergeChecklist(null, undefined, 'Refinance')
  rows = addCustomRow(rows, 'Order supps', 'abc123')
  const saved = toState(rows)
  const custom = saved.find(s => isCustomId(s.id))!
  eq('custom row persists its label', custom.label, 'Order supps')

  // ⚠️ The bug this guards: mergeChecklist drops untouched non-template items.
  //    A brand-new custom row is by definition untouched.
  const reloaded = mergeChecklist(saved, undefined, 'Refinance')
  eq('UNTOUCHED custom row survives a reload', reloaded.some(r => r.label === 'Order supps'), true)
  eq('custom row is not marked retired', reloaded.find(r => r.label === 'Order supps')?.retired, undefined)
  eq('custom row gets the custom phase', reloaded.find(r => r.label === 'Order supps')?.phase, CUSTOM_PHASE)

  eq('blank label adds nothing', addCustomRow(rows, '   ', 'x').length, rows.length)
  eq('removeCustomRow removes it', removeCustomRow(rows, custom.id).some(r => r.id === custom.id), false)
  eq('removeCustomRow refuses a template id', removeCustomRow(rows, 'ord-title').some(r => r.id === 'ord-title'), true)
}

// ── The transpose ──────────────────────────────────────────────────────────
{
  // Reproduces the real doc: Payoff → Ciarmoli, Rugley.
  const ciarmoli = deal('d1', 'Rocky Ciarmoli', {
    processor_checklist: [{ id: 'ord-title', done_at: daysAgo(2), done_by: 'Bri', note: null }] as ChecklistState[],
  })
  const rugley = deal('d2', 'Michael Rugley', {
    processor_checklist: [
      { id: 'ord-hoi', done_at: null, done_by: null, note: null,
        requested_at: daysAgo(4), requested_by: 'Brianne Han', requested_from: 'nadia.hall@trucordia.com' },
    ] as ChecklistState[],
  })
  const items = buildWorkItems([ciarmoli, rugley], NOW)

  const payoff = groupByAction(items).find(g => g.itemId === 'ord-payoff')!
  eq('Payoff group lists both loans', payoff.items.map(i => i.dealName), ['Rocky Ciarmoli', 'Michael Rugley'])

  const titleDone = items.find(i => i.dealId === 'd1' && i.itemId === 'ord-title')!
  eq('a ticked step reads done', workState(titleDone), 'done')

  const hoi = items.find(i => i.dealId === 'd2' && i.itemId === 'ord-hoi')!
  eq('a requested step reads waiting', workState(hoi), 'waiting')
  eq('waiting days computed', hoi.waitingDays, 4)
  eq('waiting carries where it went', hoi.requested_from, 'nadia.hall@trucordia.com')

  // 'open' spans todo AND waiting — what's left, either way.
  const openGroups = groupsForState(items, 'open')
  eq('title group excludes the done loan', openGroups.find(g => g.itemId === 'ord-title')?.items.map(i => i.dealName), ['Michael Rugley'])
  eq('empty groups drop out', groupsForState(items, 'waiting').map(g => g.itemId), ['ord-hoi'])

  const c = workCounts(items, 3)
  eq('counts: one done', c.done, 1)
  eq('counts: one waiting', c.waiting, 1)
  eq('a 4-day wait is stale at threshold 3', c.overdueWaits, 1)
  eq('…but not at threshold 5', workCounts(items, 5).overdueWaits, 0)
}

// ── Loan purpose still gates ───────────────────────────────────────────────
// ⚠️ A purchase must never appear under "Payoff ordered".
{
  const purchase = deal('d3', 'Mary Green', { loan_purpose: 'Purchase' })
  const items = buildWorkItems([purchase], NOW)
  eq('purchase has no payoff row', items.some(i => i.itemId === 'ord-payoff'), false)
  eq('purchase still has title rows', items.some(i => i.itemId === 'ord-title'), true)
  // Unknown purpose shows everything rather than silently dropping a step.
  const unknown = deal('d4', 'Unknown Purpose', { loan_purpose: null })
  eq('unknown purpose keeps payoff', buildWorkItems([unknown], NOW).some(i => i.itemId === 'ord-payoff'), true)
}

// ── Custom rows group by LABEL across loans ────────────────────────────────
// Two people adding "Order supps" on two loans make two ids; one group.
{
  const a = deal('d5', 'Loan A', {
    processor_checklist: [{ id: 'custom-aaa', label: 'Order supps', done_at: null, done_by: null, note: null }] as ChecklistState[],
  })
  const b = deal('d6', 'Loan B', {
    processor_checklist: [{ id: 'custom-bbb', label: '  order supps  ', done_at: null, done_by: null, note: null }] as ChecklistState[],
  })
  const groups = groupByAction(buildWorkItems([a, b], NOW))
  const supps = groups.filter(g => g.label.toLowerCase().trim() === 'order supps')
  eq('differently-cased custom rows form ONE group', supps.length, 1)
  eq('…containing both loans', supps[0].items.length, 2)
  eq('custom groups sort after template ones', groups[groups.length - 1].label.trim(), 'Order supps')
}

// ── Chase list + completed log ─────────────────────────────────────────────
{
  const items = [
    { dealName: 'A', waitingDays: 1 }, { dealName: 'B', waitingDays: 9 }, { dealName: 'C', waitingDays: null },
  ] as ReturnType<typeof buildWorkItems>
  eq('longest wait first', sortByWait(items).map(i => i.dealName), ['B', 'A', 'C'])
}
{
  const items = [
    { dealName: 'old', done_at: daysAgo(30) }, { dealName: 'recent', done_at: daysAgo(2) },
    { dealName: 'newest', done_at: daysAgo(1) }, { dealName: 'open', done_at: null },
  ] as ReturnType<typeof buildWorkItems>
  eq('recent completions, newest first, windowed',
    recentlyCompleted(items, 14, NOW).map(i => i.dealName), ['newest', 'recent'])
}

eq('daysSince handles junk', daysSince('nope', NOW), null)
eq('daysSince handles null', daysSince(null, NOW), null)

console.log(`\n${fail === 0 ? '✓' : '✗'} work-list-check: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
