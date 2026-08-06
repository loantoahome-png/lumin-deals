// ── Processor Checklist ─────────────────────────────────────────────────────
// A per-file "what's been done / where are we" list for loans in processing.
//
// ⚠️ DEFINITIONS live here in code; only STATE lives in the database.
//    `deals.processor_checklist` stores `{ id, done_at, done_by, note }[]` and
//    nothing else. That split means renaming a label, reordering the list, or
//    regrouping a phase is a pure code edit with NO data migration — the id is
//    the only thing that ties the two together.
//
// ⚠️ NEVER change an `id` once it has shipped. The id is the join key to saved
//    state; changing it silently orphans every tick and note already recorded
//    against it. Changing a `label` is always safe.
//
// This checklist is deliberately independent of `DealDocument` in lib/types.ts.
// That type tracks BORROWER DOCUMENT COLLECTION (Identity / Income / Assets);
// this tracks PROCESS STEPS. They answer different questions. (As of this
// writing DealDocument is declared but consumed nowhere.)

export type ChecklistDef = {
  id: string          // stable slug — see the warning above
  label: string
  phase: string
  hint?: string       // optional one-liner shown under the label
  // Restrict this step to one loan purpose. The list is otherwise ONE template
  // for every in-process loan — this is a per-item exception, not a second
  // template. ⚠️ An unset `loan_purpose` still SHOWS the item: silently
  // dropping a step a processor needed is worse than one extra line to ignore.
  only?: 'Purchase' | 'Refinance'
}

/** What actually persists to `deals.processor_checklist`. */
export type ChecklistState = {
  id: string
  done_at: string | null   // ISO timestamp
  done_by: string | null   // who ticked it
  note: string | null
}

/** A definition joined to its saved state — what the UI renders. */
export type ChecklistRow = ChecklistDef & ChecklistState & { retired?: boolean }

// ── Phase order ─────────────────────────────────────────────────────────────
// Mirrors the real PIPELINE_STATUSES['Loans in Process'] progression in
// lib/types.ts, but finer-grained: the point of a checklist is knowing what has
// been done WITHIN a stage, which a status alone can't tell you.
export const CHECKLIST_PHASES = [
  'Setup',
  'Disclosures',
  'Third-Party Orders',
  'Underwriting',
  'Closing',
] as const

// ── The template ────────────────────────────────────────────────────────────
// ⚠️ DRAFT. This is the one place to edit the checklist — add, delete, reorder
//    and rename freely. Everything else in the feature reads from this array.
export const CHECKLIST_TEMPLATE: ChecklistDef[] = [
  // ── Setup ──
  { id: 'setup-file-review',      phase: 'Setup',       label: 'File reviewed for completeness' },
  { id: 'setup-1003',             phase: 'Setup',       label: '1003 reviewed & verified' },
  { id: 'setup-credit',           phase: 'Setup',       label: 'Credit pulled / re-issued' },
  { id: 'setup-aus',              phase: 'Setup',       label: 'AUS run', hint: 'DU / LP findings in file' },
  { id: 'setup-doc-request',      phase: 'Setup',       label: 'Initial doc request sent to borrower' },

  // ── Disclosures ──
  { id: 'disc-sent',              phase: 'Disclosures', label: 'Initial disclosures sent' },
  { id: 'disc-signed',            phase: 'Disclosures', label: 'Disclosures signed by borrower' },
  { id: 'disc-intent',            phase: 'Disclosures', label: 'Intent to proceed received' },

  // ── Third-Party Orders ──
  { id: 'ord-appraisal',          phase: 'Third-Party Orders', label: 'Appraisal ordered' },
  { id: 'ord-appraisal-in',       phase: 'Third-Party Orders', label: 'Appraisal received' },
  { id: 'ord-title',              phase: 'Third-Party Orders', label: 'Title ordered' },
  { id: 'ord-title-in',           phase: 'Third-Party Orders', label: 'Prelim title received' },
  { id: 'ord-hoi',                phase: 'Third-Party Orders', label: 'Homeowners insurance received' },
  { id: 'ord-voe',                phase: 'Third-Party Orders', label: 'VOE completed' },
  { id: 'ord-payoff',             phase: 'Third-Party Orders', label: 'Payoff ordered', only: 'Refinance' },

  // ── Underwriting ──
  { id: 'uw-submitted',           phase: 'Underwriting', label: 'Submitted to UW' },
  { id: 'uw-approved',            phase: 'Underwriting', label: 'Approval received' },
  { id: 'uw-conditions-in',       phase: 'Underwriting', label: 'Conditions collected from borrower' },
  { id: 'uw-conditions-sent',     phase: 'Underwriting', label: 'Conditions submitted back to UW' },
  { id: 'uw-clear',               phase: 'Underwriting', label: 'Clear to Close' },

  // ── Closing ──
  { id: 'close-cd-sent',          phase: 'Closing',     label: 'CD sent' },
  { id: 'close-cd-timing',        phase: 'Closing',     label: 'CD timing satisfied' },
  { id: 'close-docs-out',         phase: 'Closing',     label: 'Docs out to title / escrow' },
  { id: 'close-signing',          phase: 'Closing',     label: 'Signing scheduled' },
  { id: 'close-docs-signed',      phase: 'Closing',     label: 'Docs signed' },
  { id: 'close-funded',           phase: 'Closing',     label: 'Funded' },
]

// ── Pure helpers (no I/O — all fixture-tested in scripts/processor-checklist-check.ts)

function blankState(id: string): ChecklistState {
  return { id, done_at: null, done_by: null, note: null }
}

/**
 * The steps that apply to one loan.
 *
 * An item with no `only` always applies. An item with `only` is hidden ONLY
 * when the loan's purpose is a known, different one — a null/blank/unrecognised
 * `loan_purpose` shows everything, so a mis-tagged refi never quietly loses its
 * payoff step.
 */
export function applicableTemplate(
  template: ChecklistDef[] = CHECKLIST_TEMPLATE,
  loanPurpose?: string | null,
): ChecklistDef[] {
  const purpose = (loanPurpose ?? '').trim()
  if (purpose === '') return template
  return template.filter(d => !d.only || d.only === purpose)
}

/**
 * Join saved state onto the template.
 *
 * Template order wins, so reordering the array reorders the page. Items in the
 * template with no saved state come back blank.
 *
 * ⚠️ Saved items NOT in the applicable template are dropped ONLY if untouched.
 *    One that was ticked (or carries a note) is kept and flagged `retired` so
 *    neither deleting a template line NOR flipping a loan's purpose can erase
 *    recorded work. Retired rows sort last and do NOT count toward progress.
 */
export function mergeChecklist(
  stored: ChecklistState[] | null | undefined,
  template: ChecklistDef[] = CHECKLIST_TEMPLATE,
  loanPurpose?: string | null,
): ChecklistRow[] {
  const saved = new Map((stored ?? []).map(s => [s.id, s]))
  const applicable = applicableTemplate(template, loanPurpose)

  const rows: ChecklistRow[] = applicable.map(def => ({
    ...def,
    ...(saved.get(def.id) ?? blankState(def.id)),
    id: def.id,
  }))

  // Labels for retired rows come from the FULL template when the id is still
  // defined there (e.g. a payoff ticked before the loan was retyped as a
  // purchase) — falling back to the raw id would surface "ord-payoff" as UI.
  const labels = new Map(template.map(d => [d.id, d.label]))
  const shown = new Set(applicable.map(d => d.id))
  const retired: ChecklistRow[] = (stored ?? [])
    .filter(s => !shown.has(s.id) && (s.done_at !== null || (s.note ?? '') !== ''))
    .map(s => ({ ...s, label: labels.get(s.id) ?? s.id, phase: 'Retired', retired: true }))

  return [...rows, ...retired]
}

/** Strip rendering fields back down to what the column stores. */
export function toState(rows: ChecklistRow[]): ChecklistState[] {
  return rows.map(({ id, done_at, done_by, note }) => ({ id, done_at, done_by, note }))
}

/** Done / total, ignoring retired rows. */
export function checklistProgress(rows: ChecklistRow[]): { done: number; total: number; pct: number } {
  const live = rows.filter(r => !r.retired)
  const done = live.filter(r => r.done_at !== null).length
  const total = live.length
  return { done, total, pct: total === 0 ? 0 : Math.round((done / total) * 100) }
}

/**
 * Tick / untick. Unticking clears the stamp entirely — a half-state where
 * `done_by` outlives `done_at` would render as "done by Brianne" on an open
 * item. The note deliberately survives: it's usually why the item got undone.
 */
export function toggleItem(rows: ChecklistRow[], id: string, who: string | null, now: string): ChecklistRow[] {
  return rows.map(r => {
    if (r.id !== id) return r
    return r.done_at
      ? { ...r, done_at: null, done_by: null }
      : { ...r, done_at: now, done_by: who }
  })
}

/** Set (or clear) a note. Empty / whitespace-only collapses to null. */
export function setNote(rows: ChecklistRow[], id: string, note: string): ChecklistRow[] {
  const clean = note.trim()
  return rows.map(r => (r.id === id ? { ...r, note: clean === '' ? null : clean } : r))
}

/** Phases that actually have rows, in template order, retired last. */
export function phasesPresent(rows: ChecklistRow[]): string[] {
  const seen = new Set(rows.map(r => r.phase))
  const ordered = CHECKLIST_PHASES.filter(p => seen.has(p)) as string[]
  if (seen.has('Retired')) ordered.push('Retired')
  return ordered
}

/**
 * The furthest phase with any completed work — the "where are we at" answer.
 * Returns null when nothing has been ticked. Retired rows are ignored.
 */
export function currentPhase(rows: ChecklistRow[]): string | null {
  let latest: string | null = null
  for (const phase of CHECKLIST_PHASES) {
    if (rows.some(r => !r.retired && r.phase === phase && r.done_at !== null)) latest = phase
  }
  return latest
}
