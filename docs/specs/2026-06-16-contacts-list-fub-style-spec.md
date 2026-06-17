# Spec: FUB-style contacts list (Contacts Phase 3.1)

**Date:** 2026-06-16
**Reference:** Efrain's Follow Up Boss screenshot — avatar + name + source sub-line, a Stage column,
and a selection checkbox per row, with each lead visually separated.
**Scope:** `app/contacts/page.tsx` only. Derive source + lifecycle client-side from a slim deals
fetch — NO schema/resolver change (promote into the resolver later if the per-load fetch is heavy).

## Problem
The list is a dense, undifferentiated table (name + email + counts). Hard to scan, no visual anchor
per person, no lifecycle signal, no bulk actions.

## Solution — restyle each row FUB-style
- **Avatar**: initials in a deterministic colored circle (we have no photos).
- **Two-line primary cell**: name (bold) + sub-line = the person's lead **source** (most-recent
  non-empty), falling back to email when there's no source.
- **Stage pill**: a per-person lifecycle derived from their loans:
  `In Process` (has a Loans-in-Process loan) > `Past Client` (funded_count > 0) > `Lead`
  (has a Leads loan) > `Not Ready`.
- **Bulk select**: a checkbox per row + a header select-all; a selection bar showing the count and
  a real action — **Copy emails** (clipboard) for building an outreach list.
- **Lifecycle filter tabs**: All / In Process / Past Clients / Leads / Not Ready (with counts),
  alongside the existing search.
- Keep the money columns (Loans / Funded / Funded volume / Comp) and the header totals.
- Clearer division: row padding, dividers, hover.

## Data
Fetch contacts (as today) AND a slim deals projection (`borrower_id, pipeline_group, source,
created_at`) in parallel; build a `Map<borrower_id, { groups:Set, source }>`. `funded_count` for the
Past-Client test comes from the contact row (already there).

## Acceptance Criteria
- [ ] Each row shows a colored initials avatar, name, a source (or email) sub-line, and a stage pill.
- [ ] Stage matches the person's loans (a funded person with an active loan reads `In Process`;
      funded with nothing active reads `Past Client`).
- [ ] Selecting rows shows a bar with the count; Copy emails puts the selected emails on the clipboard.
- [ ] Lifecycle tabs filter the list and show correct counts; search still works (name/email/phone).
- [ ] Type-clean (`tsc`) and the route builds.

## Out of Scope
- Promoting source/lifecycle into the `contacts` table/resolver (later, if perf needs it).
- Server-side bulk actions (email/assign/tag) — Copy emails is clipboard-only for now.
- Saved views / sorting beyond the existing last-activity order.
