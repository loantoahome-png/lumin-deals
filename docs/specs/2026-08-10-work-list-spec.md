# Spec — Work List (`/worklist`)

**Date:** 2026-08-10 · **Mode:** Build
**Replaces:** the "Tasklist for Bri and Efrain" Google Doc.

---

## 1. What the doc actually is

Efrain shared the live doc. Reading it structurally, it is four things:

1. **A pinned SOP block** — "Training Notes for Ordering Title" (include Crystal
   and Robin at Alamo; add notes + initials; CC Efrain; send 1003 + LE). Standing
   reference, not work. Red text = emphasis.
2. **Open work grouped by ACTION, not by loan** — `Payoff → Ciarmoli, Rugley`,
   `Order supps → Rugley`. This is the app's checklist **transposed**: the app
   shows one loan × 26 steps; the doc shows one step × N loans.
3. **A dated "Requested" log** — `Ciarmoli - payoff request faxed to
   916-464-2477 - Bri`. Borrower, action, **where it went**, **who sent it**,
   **when**. This is the chase list, and it is the thing the app cannot express
   today: `processor_checklist` is binary done/not-done.
4. **A dated "Completed" log.**

Most of the doc's categories already exist as checklist steps
(`lib/processorChecklist.ts`):

| Doc | Template id |
|---|---|
| Appraisal in for | `ord-appraisal-in` |
| Title In | `ord-title-in` |
| Final HOI | `ord-hoi` *(is "final" a distinct thing from the binder? — open Q)* |
| Title Order | `ord-title` |
| Payoff | `ord-payoff` |
| Order supps · Catch up tracking · Final · Comp | **no equivalent — open Q** |

## 2. Decisions (Efrain, 2026-08-10)

1. **Rows: auto from the checklist, plus free rows.** No double entry for
   anything standard; an escape hatch for everything else.
2. **Requested is a real state** capturing who / where / when / initials.
   open → requested → done.
3. **Scope: Hanh's files only** (`processor_status = 'Hanh Nguyen'` ∧
   `pipeline_group = 'Loans in Process'`) — same scope as the Processing Desk.
4. **Training notes pinned at the top, editable by all three.**

Visible to **all users** (Efrain's words) — it is not processor-only.

## 3. Why not every step × every loan

26 steps × 9 loans = 234 rows, most meaningless ("Funded" on a loan at
Disclosed). That is the opposite of "super simple", which is the whole ask.

**Only steps flagged `worklist: true` in the template appear.** Those are the
*chase* steps — the ones where you order something from a third party and then
wait on it, which is exactly the set that needs the `requested` state. The other
20 steps stay on the per-loan checklist where they already work.

Seed set: `ord-appraisal`, `ord-appraisal-in`, `ord-title`, `ord-title-in`,
`ord-hoi`, `ord-voe`, `ord-payoff`. Adding one later is a one-word code edit.

## 4. Data

**No migration.** `deals.processor_checklist` is JSONB; `ChecklistState` gains
optional fields, and a row written before today simply lacks them.

```ts
type ChecklistState = {
  id: string
  done_at: string | null
  done_by: string | null
  note: string | null
  requested_at?: string | null      // NEW
  requested_by?: string | null      // NEW — stamped from the signed-in user
  requested_from?: string | null    // NEW — "nadia.hall@trucordia.com", "fax 916-464-2477"
  label?: string                    // NEW — custom rows only (id starts `custom-`)
}
```

⚠️ `mergeChecklist` currently **drops** saved items absent from the template
unless they're touched. Custom rows (`custom-*`) must be kept unconditionally,
or a free row vanishes the moment it's created.

⚠️ Ticking done does **not** clear the requested stamp — "requested 8/6,
received 8/10" is the useful record, and clearing it would erase the turnaround
time.

Pinned notes: `sync_state` key `worklist_notes`, service-role route, same
pattern as `/api/tools` and `/api/lenders`. Stored as sanitized HTML (the notes
use colour for emphasis), read through the existing DOMPurify path.

## 5. Page

- **Pinned notes** at the top, edit-in-place, shared.
- **Filter:** Needs doing (open, not requested) · Waiting on (requested, aged) ·
  All. Default: Needs doing.
- **Grouped by action.** Each group lists borrower names — `Payoff · Ciarmoli ·
  Rugley` — reproducing the doc's shape.
- **Per row:** Request (captures where it went, stamps who + when) · Done · a
  free-text detail line.
- **Waiting** shows age in days, oldest first. This is what the doc can't do.
- **Recently completed**, dated, collapsible — the doc's "Completed 8/6".

## 6. Acceptance

1. An action group lists exactly the loans on Hanh's desk where that step is
   not done.
2. Marking requested stamps date + signed-in user and asks where it went; the
   row moves to Waiting with an age.
3. Ticking done keeps the requested stamp.
4. A free row survives a reload and does not count toward checklist progress.
5. The per-loan checklist page shows the same state — one source of truth.
6. Notes persist for all three users.
7. `tsc` unchanged at 7 pre-existing; `next build` ✓; all suites exit 0.

## 7. Open questions for Efrain

Four doc categories have no template equivalent and are not guessable — asked,
not assumed:

- **Order supps** — supplemental tax bills?
- **Catch up tracking** — the tracking sheet, or something in Arive?
- **Final** — final CD? final inspection? (two blank sub-items in the doc)
- **Comp** — compensation. Whose, and what's the action?
- **Final HOI** vs the existing "Homeowners insurance received" — one step or two?

Until answered these are creatable as free rows, then promoted to real template
steps (with a `worklist` flag) once defined.
