// Fixture check for lib/processorChecklist.ts — pure logic, no DB.
// Run: npx tsx scripts/processor-checklist-check.ts
//
// The thing that can actually hurt here is DATA LOSS: a processor ticks 20
// items, someone edits the template, and the ticks vanish. Most of these
// fixtures exist to pin that down.
import {
  CHECKLIST_TEMPLATE, CHECKLIST_PHASES,
  mergeChecklist, toState, checklistProgress, toggleItem, setNote,
  phasesPresent, currentPhase, applicableTemplate,
  type ChecklistDef, type ChecklistState,
} from '../lib/processorChecklist'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++ } else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}

const NOW = '2026-08-05T17:00:00.000Z'
const ME = 'brianne@example.com'

const TPL: ChecklistDef[] = [
  { id: 'a', label: 'Alpha', phase: 'Setup' },
  { id: 'b', label: 'Bravo', phase: 'Setup' },
  { id: 'c', label: 'Charlie', phase: 'Closing' },
]

// ── The template itself ─────────────────────────────────────────────────────
const ids = CHECKLIST_TEMPLATE.map(d => d.id)
eq('template: ids are unique (a dupe would join two rows to one state)',
  ids.length, new Set(ids).size)
eq('template: no blank ids', ids.filter(i => !i || !i.trim()).length, 0)
eq('template: no blank labels', CHECKLIST_TEMPLATE.filter(d => !d.label.trim()).length, 0)
eq('template: every phase is a declared phase',
  CHECKLIST_TEMPLATE.filter(d => !(CHECKLIST_PHASES as readonly string[]).includes(d.phase)).length, 0)
eq('template: no id collides with the reserved "Retired" phase name',
  CHECKLIST_TEMPLATE.filter(d => d.phase === 'Retired').length, 0)

// ── mergeChecklist: the seed case ───────────────────────────────────────────
const fresh = mergeChecklist(null, TPL)
eq('merge: null state seeds the whole template', fresh.length, 3)
eq('merge: seeded items start undone', fresh.every(r => r.done_at === null && r.done_by === null), true)
eq('merge: empty array behaves like null', mergeChecklist([], TPL).length, 3)
eq('merge: template order is preserved', fresh.map(r => r.id), ['a', 'b', 'c'])

// ── mergeChecklist: state survives ──────────────────────────────────────────
const saved: ChecklistState[] = [{ id: 'b', done_at: NOW, done_by: ME, note: 'called twice' }]
const merged = mergeChecklist(saved, TPL)
eq('merge: saved tick is applied to the right row', merged.find(r => r.id === 'b')?.done_at, NOW)
eq('merge: saved stamp survives', merged.find(r => r.id === 'b')?.done_by, ME)
eq('merge: saved note survives', merged.find(r => r.id === 'b')?.note, 'called twice')
eq('merge: untouched rows stay blank', merged.find(r => r.id === 'a')?.done_at, null)
eq('merge: label always comes from the template, never from stored state',
  merged.find(r => r.id === 'b')?.label, 'Bravo')

// ── mergeChecklist: template drift (the data-loss cases) ────────────────────
const renamed: ChecklistDef[] = [{ id: 'b', label: 'Bravo RENAMED', phase: 'Setup' }]
eq('drift: renaming a LABEL keeps the tick (id is the join key)',
  mergeChecklist(saved, renamed).find(r => r.id === 'b')?.done_at, NOW)
eq('drift: renamed label renders the new text',
  mergeChecklist(saved, renamed)[0].label, 'Bravo RENAMED')

const withoutB: ChecklistDef[] = [{ id: 'a', label: 'Alpha', phase: 'Setup' }]
const orphaned = mergeChecklist(saved, withoutB)
eq('drift: a DONE item removed from the template is retained, not erased', orphaned.length, 2)
eq('drift: the retained row is flagged retired', orphaned[1].retired, true)
eq('drift: retired rows land in the Retired phase', orphaned[1].phase, 'Retired')
eq('drift: retired row keeps its stamp', orphaned[1].done_by, ME)

const untouched: ChecklistState[] = [{ id: 'zz', done_at: null, done_by: null, note: null }]
eq('drift: an UNtouched removed item is dropped silently (no clutter)',
  mergeChecklist(untouched, withoutB).length, 1)
const notedOnly: ChecklistState[] = [{ id: 'zz', done_at: null, done_by: null, note: 'ordered 8/1' }]
eq('drift: a removed item with only a NOTE is still retained',
  mergeChecklist(notedOnly, withoutB).length, 2)

eq('merge: unknown saved id that IS in the template is not duplicated',
  mergeChecklist([...saved, ...saved], TPL).length, 3)

// ── loan-purpose gating (the refi-only payoff step) ─────────────────────────
const PURPOSE_TPL: ChecklistDef[] = [
  { id: 'a', label: 'Alpha', phase: 'Setup' },
  { id: 'payoff', label: 'Payoff ordered', phase: 'Setup', only: 'Refinance' },
]

eq('purpose: refi sees the refi-only step',
  applicableTemplate(PURPOSE_TPL, 'Refinance').map(d => d.id), ['a', 'payoff'])
eq('purpose: purchase does NOT see it',
  applicableTemplate(PURPOSE_TPL, 'Purchase').map(d => d.id), ['a'])
eq('⚠️ purpose: NULL purpose shows everything (never silently drop a step)',
  applicableTemplate(PURPOSE_TPL, null).map(d => d.id), ['a', 'payoff'])
eq('⚠️ purpose: blank purpose shows everything',
  applicableTemplate(PURPOSE_TPL, '   ').map(d => d.id), ['a', 'payoff'])
eq('⚠️ purpose: unrecognised purpose shows everything, not nothing',
  applicableTemplate(PURPOSE_TPL, 'Construction').map(d => d.id), ['a'])
eq('purpose: omitted arg shows everything',
  applicableTemplate(PURPOSE_TPL).map(d => d.id), ['a', 'payoff'])
eq('purpose: unrestricted items are never filtered',
  applicableTemplate(TPL, 'Purchase').length, 3)

eq('purpose: merge hides the step on a purchase',
  mergeChecklist(null, PURPOSE_TPL, 'Purchase').map(r => r.id), ['a'])
eq('purpose: merge shows it on a refi',
  mergeChecklist(null, PURPOSE_TPL, 'Refinance').map(r => r.id), ['a', 'payoff'])
eq('purpose: hidden step is excluded from progress total',
  checklistProgress(mergeChecklist(null, PURPOSE_TPL, 'Purchase')).total, 1)

// The one that actually loses data if it's wrong: ticked as a refi, then the
// loan gets retyped as a purchase.
const paidOff: ChecklistState[] = [{ id: 'payoff', done_at: NOW, done_by: ME, note: 'ordered 8/1' }]
const flipped = mergeChecklist(paidOff, PURPOSE_TPL, 'Purchase')
eq('⚠️ purpose flip: a TICKED refi-only step is retained, not erased', flipped.length, 2)
eq('purpose flip: retained row is flagged retired', flipped[1].retired, true)
eq('purpose flip: its stamp survives', flipped[1].done_by, ME)
eq('purpose flip: its note survives', flipped[1].note, 'ordered 8/1')
eq('purpose flip: retained row shows its real LABEL, not the raw id',
  flipped[1].label, 'Payoff ordered')
eq('purpose flip: retained row does not inflate progress',
  checklistProgress(flipped), { done: 0, total: 1, pct: 0 })
eq('purpose flip: untouched refi-only step just disappears on a purchase',
  mergeChecklist([{ id: 'payoff', done_at: null, done_by: null, note: null }], PURPOSE_TPL, 'Purchase').length, 1)
eq('⚠️ purpose flip: saving a purchase does NOT drop the retained refi state',
  toState(flipped).map(s => s.id), ['a', 'payoff'])
eq('purpose flip: flipping back to refi restores it as a normal row',
  mergeChecklist(toState(flipped), PURPOSE_TPL, 'Refinance').find(r => r.id === 'payoff')?.retired, undefined)

// The real template ships exactly one gated item.
eq('real template: ord-payoff is the only refi-gated step',
  CHECKLIST_TEMPLATE.filter(d => d.only).map(d => d.id), ['ord-payoff'])
eq('real template: purchase drops exactly one step',
  CHECKLIST_TEMPLATE.length - applicableTemplate(CHECKLIST_TEMPLATE, 'Purchase').length, 1)
eq('real template: refi keeps them all',
  applicableTemplate(CHECKLIST_TEMPLATE, 'Refinance').length, CHECKLIST_TEMPLATE.length)

// ── toState: only the four persisted fields go to the DB ────────────────────
eq('toState: strips label/phase/hint, keeps state',
  toState(mergeChecklist(saved, TPL)),
  [
    { id: 'a', done_at: null, done_by: null, note: null },
    { id: 'b', done_at: NOW, done_by: ME, note: 'called twice' },
    { id: 'c', done_at: null, done_by: null, note: null },
  ])
eq('toState → mergeChecklist is a round trip',
  toState(mergeChecklist(toState(mergeChecklist(saved, TPL)), TPL)),
  toState(mergeChecklist(saved, TPL)))

// ── toggleItem ──────────────────────────────────────────────────────────────
const ticked = toggleItem(fresh, 'a', ME, NOW)
eq('toggle: sets the timestamp', ticked.find(r => r.id === 'a')?.done_at, NOW)
eq('toggle: stamps who', ticked.find(r => r.id === 'a')?.done_by, ME)
eq('toggle: leaves siblings alone', ticked.find(r => r.id === 'b')?.done_at, null)

const unticked = toggleItem(ticked, 'a', ME, NOW)
eq('toggle: unticking clears done_at', unticked.find(r => r.id === 'a')?.done_at, null)
eq('toggle: unticking ALSO clears done_by (no "done by X" on an open item)',
  unticked.find(r => r.id === 'a')?.done_by, null)

const withNote = setNote(ticked, 'a', 'value came in low')
eq('toggle: unticking PRESERVES the note (usually why it was undone)',
  toggleItem(withNote, 'a', ME, NOW).find(r => r.id === 'a')?.note, 'value came in low')

eq('toggle: a null user still ticks (auth not loaded yet)',
  toggleItem(fresh, 'a', null, NOW).find(r => r.id === 'a')?.done_at, NOW)
eq('toggle: unknown id is a no-op, not a throw', toggleItem(fresh, 'nope', ME, NOW).length, 3)

// ── setNote ─────────────────────────────────────────────────────────────────
eq('note: set', setNote(fresh, 'a', 'ordered').find(r => r.id === 'a')?.note, 'ordered')
eq('note: trimmed', setNote(fresh, 'a', '  ordered  ').find(r => r.id === 'a')?.note, 'ordered')
eq('note: empty collapses to null', setNote(fresh, 'a', '').find(r => r.id === 'a')?.note, null)
eq('note: whitespace-only collapses to null',
  setNote(fresh, 'a', '   \n ').find(r => r.id === 'a')?.note, null)
eq('note: clearing a note does not clear the tick',
  setNote(ticked, 'a', '').find(r => r.id === 'a')?.done_at, NOW)

// ── progress ────────────────────────────────────────────────────────────────
eq('progress: nothing done', checklistProgress(fresh), { done: 0, total: 3, pct: 0 })
eq('progress: one done', checklistProgress(ticked), { done: 1, total: 3, pct: 33 })
eq('progress: all done',
  checklistProgress(fresh.map(r => ({ ...r, done_at: NOW }))), { done: 3, total: 3, pct: 100 })
eq('progress: empty list does not divide by zero',
  checklistProgress([]), { done: 0, total: 0, pct: 0 })
eq('progress: RETIRED rows are excluded from both done and total',
  checklistProgress(orphaned), { done: 0, total: 1, pct: 0 })

// ── phases ──────────────────────────────────────────────────────────────────
eq('phases: only phases with rows, in template order', phasesPresent(fresh), ['Setup', 'Closing'])
eq('phases: Retired always sorts last', phasesPresent(orphaned), ['Setup', 'Retired'])
eq('phases: real template exposes every declared phase',
  phasesPresent(mergeChecklist(null)), [...CHECKLIST_PHASES])

// ── currentPhase — the "where are we at" answer ─────────────────────────────
eq('currentPhase: nothing ticked → null', currentPhase(fresh), null)
eq('currentPhase: one Setup item ticked → Setup', currentPhase(ticked), 'Setup')
eq('currentPhase: reports the FURTHEST phase, not the most recent tick',
  currentPhase(toggleItem(toggleItem(fresh, 'c', ME, NOW), 'a', ME, NOW)), 'Closing')
eq('currentPhase: ignores retired rows', currentPhase(orphaned), null)

console.log(fail === 0
  ? `✓ processor-checklist-check: all ${pass} fixtures pass`
  : `${fail} FAILED / ${pass} passed`)
if (fail > 0) process.exit(1)
