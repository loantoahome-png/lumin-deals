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
  // Surface this step on the cross-loan Work List (/worklist).
  //
  // ⚠️ Deliberately a SUBSET. 26 steps × 9 live loans is 234 rows, most of them
  //    meaningless ("Funded" on a loan still at Disclosed) — the opposite of the
  //    "keep it super simple" this page exists for. The flag marks the CHASE
  //    steps: order something from a third party, then wait on it. That is
  //    exactly the set the `requested_*` state is for, and exactly the set the
  //    Google Doc this replaced actually listed.
  worklist?: boolean
}

/** Phase given to custom (free-typed) rows — they belong to no template phase. */
export const CUSTOM_PHASE = 'Added here'

/** What actually persists to `deals.processor_checklist`.
 *
 *  The `requested_*` trio and `label` are OPTIONAL because the column is JSONB
 *  and every row written before 2026-08-10 lacks them — absent simply means
 *  "never requested" / "not a custom row". No migration, no backfill.
 */
export type ChecklistState = {
  id: string
  done_at: string | null   // ISO timestamp
  done_by: string | null   // who ticked it
  note: string | null

  // ── In-flight tracking (added for the Work List) ──────────────────────────
  // The state between "not done" and "done": ordered from a third party, still
  // waiting. Modelled from the Google Doc this replaced, whose most useful line
  // was "Ciarmoli - payoff request faxed to 916-464-2477 - Bri" — where it went,
  // who sent it, when. A binary checklist cannot say that, which is why the doc
  // outlived the checklist.
  requested_at?: string | null     // ISO timestamp
  requested_by?: string | null     // signed-in user's display name
  requested_from?: string | null   // "nadia.hall@trucordia.com", "fax 916-464-2477", "AAA portal"

  // ── Custom rows ───────────────────────────────────────────────────────────
  // Only set on ids beginning `custom-`. The template is the source of truth for
  // every OTHER label; a custom row has to carry its own because there is no
  // definition to join to.
  label?: string
}

/** Custom (non-template) checklist rows carry this id prefix. */
export const CUSTOM_ID_PREFIX = 'custom-'

export function isCustomId(id: string): boolean {
  return id.startsWith(CUSTOM_ID_PREFIX)
}

/** Has this item been ordered but not yet received? */
export function isRequested(s: Pick<ChecklistState, 'done_at' | 'requested_at'>): boolean {
  return !s.done_at && !!s.requested_at
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
  { id: 'ord-appraisal',          phase: 'Third-Party Orders', label: 'Appraisal ordered',              worklist: true },
  { id: 'ord-appraisal-in',       phase: 'Third-Party Orders', label: 'Appraisal received',             worklist: true },
  { id: 'ord-title',              phase: 'Third-Party Orders', label: 'Title ordered',                  worklist: true },
  { id: 'ord-title-in',           phase: 'Third-Party Orders', label: 'Prelim title received',          worklist: true },
  { id: 'ord-hoi',                phase: 'Third-Party Orders', label: 'Homeowners insurance received',  worklist: true },
  { id: 'ord-voe',                phase: 'Third-Party Orders', label: 'VOE completed',                  worklist: true },
  { id: 'ord-payoff',             phase: 'Third-Party Orders', label: 'Payoff ordered', only: 'Refinance', worklist: true },

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

  // ⚠️ Custom rows are kept UNCONDITIONALLY and are never "retired". They have
  //    no template definition to come back from, so the untouched-items rule
  //    that protects template rows would delete a free row the instant it was
  //    created and before anyone ticked it.
  const custom: ChecklistRow[] = (stored ?? [])
    .filter(s => isCustomId(s.id))
    .map(s => ({
      ...s,
      label: s.label ?? 'Untitled',
      phase: CUSTOM_PHASE,
    }))

  const retired: ChecklistRow[] = (stored ?? [])
    .filter(s => !isCustomId(s.id) && !shown.has(s.id) && (s.done_at !== null || (s.note ?? '') !== ''))
    .map(s => ({ ...s, label: labels.get(s.id) ?? s.id, phase: 'Retired', retired: true }))

  return [...rows, ...custom, ...retired]
}

/** Strip rendering fields back down to what the column stores.
 *
 * ⚠️ This function is the ONLY thing that decides what survives a save. It used
 *    to destructure exactly four fields, which meant any new state field was
 *    silently discarded on the next write — a requested stamp would appear to
 *    save and then vanish the next time anyone ticked anything on that loan.
 *    Anything added to ChecklistState must be carried here too.
 *
 * `label` is persisted for custom rows only: template rows get their label from
 * the template, and storing a copy would let the two drift.
 */
export function toState(rows: ChecklistRow[]): ChecklistState[] {
  return rows.map(r => {
    const out: ChecklistState = {
      id: r.id,
      done_at: r.done_at,
      done_by: r.done_by,
      note: r.note,
    }
    if (r.requested_at) {
      out.requested_at = r.requested_at
      out.requested_by = r.requested_by ?? null
      out.requested_from = r.requested_from ?? null
    }
    if (isCustomId(r.id)) out.label = r.label
    return out
  })
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

/** Phases that actually have rows, in template order, custom then retired last. */
export function phasesPresent(rows: ChecklistRow[]): string[] {
  const seen = new Set(rows.map(r => r.phase))
  const ordered = CHECKLIST_PHASES.filter(p => seen.has(p)) as string[]
  if (seen.has(CUSTOM_PHASE)) ordered.push(CUSTOM_PHASE)
  if (seen.has('Retired')) ordered.push('Retired')
  return ordered
}

/**
 * Mark an item as ordered-and-waiting, or clear that back to untouched.
 *
 * ⚠️ Ticking DONE never clears the requested stamp (see toggleItem) — "requested
 *    8/6, received 8/10" is the turnaround record, and wiping it on completion
 *    would throw away the only measure of how slow a vendor is.
 */
export function requestItem(
  rows: ChecklistRow[],
  id: string,
  from: string | null,
  who: string | null,
  now: string,
): ChecklistRow[] {
  const clean = (from ?? '').trim()
  return rows.map(r => (r.id === id
    ? { ...r, requested_at: now, requested_by: who, requested_from: clean === '' ? null : clean }
    : r))
}

export function clearRequest(rows: ChecklistRow[], id: string): ChecklistRow[] {
  return rows.map(r => (r.id === id
    ? { ...r, requested_at: null, requested_by: null, requested_from: null }
    : r))
}

/** Append a free-typed row. `idSeed` must be unique per row (caller supplies it,
 *  so this stays pure and testable — no Date.now()/random in here). */
export function addCustomRow(rows: ChecklistRow[], label: string, idSeed: string): ChecklistRow[] {
  const clean = label.trim()
  if (!clean) return rows
  return [...rows, {
    id: `${CUSTOM_ID_PREFIX}${idSeed}`,
    label: clean,
    phase: CUSTOM_PHASE,
    done_at: null, done_by: null, note: null,
  }]
}

/** Remove a custom row. Template rows are never removable — they'd just come
 *  straight back from the template on the next merge. */
export function removeCustomRow(rows: ChecklistRow[], id: string): ChecklistRow[] {
  if (!isCustomId(id)) return rows
  return rows.filter(r => r.id !== id)
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
