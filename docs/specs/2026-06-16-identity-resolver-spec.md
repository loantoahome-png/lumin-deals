# Spec: Cross-Source Identity Resolver (Contacts Phase 1)

**Date:** 2026-06-16
**Status:** APPROVED
**Approach:** Dedicated global resolver pass · guarded-transitive union-find · oldest-id-wins

## Problem

`borrower_id` is the dashboard's only "this is one person" key, but it's assigned **once at
insert** via a best-effort fallback chain (`app/api/sync/ghl/route.ts:992-1003`) and then
**frozen** on update (`route.ts:985` "borrower_id intentionally NOT synced"). When two loans
for the same person are created before a linking signal exists — different GHL sub-accounts,
or an Arive row imported before its GHL opp — they get separate `borrower_id`s that never heal.

Measured across 1,551 deals:
- **40 people** have identities split across multiple `borrower_id`s (104 deals) by email.
- **31** of those share the *same* `ghl_contact_id` yet carry 2 `borrower_id`s — structurally
  impossible if grouping were maintained; proves the frozen-at-insert bug.

This is the root cause of the false-duplicate noise on `/duplicates`. The dedup logic already
tries to recognize one-person-many-loans via `sharesBorrowerId` (all rows share one
`borrower_id`) and `isLegitMultiLoan` (every row has its own GHL opp id). A split identity with
an Arive-only row (no opp id) fails BOTH guards. Example — **Marian Cooper**: 3 loans
(Arive 16057126 / 16051877 / 17017052), 2 `borrower_id`s, one Arive-only row → surfaces as 3
"same email" duplicates despite being one person's separate loans.

## Solution

A deterministic **global identity resolver** that recomputes a canonical `borrower_id` per
person across all sources, run as its own pass (not inside the per-account sync).

### Match keys & normalization
- **Strong keys (exact):** `ghl_contact_id`; normalized email (`trim` + `lowercase`);
  normalized phone (digits-only, last 10). Reuse the existing `normEmail` / `normPhone` helpers.
- **Never match on name** — too many shared/variant names (e.g. "Marian Cooper" vs
  "Marian Elizabeth Cooper"; common names like "Michael Smith"). Excluded, not deferred.
- **Weak-value blocklist** — values shared but not identifying do NOT create a match edge:
  - phones: all-same-digit (`0000000000`, `1111111111`), empty, known office/brokerage numbers
  - emails: role mailboxes (`info@`, `noreply@`, `admin@`), brokerage catch-all domains, placeholders, empty
  - `ghl_contact_id` is always identifying (per-location), so never blocklisted; the same person
    having a different contact-id per sub-account is expected and unifies via email/phone.

### Matching: guarded-transitive union-find
- Build a graph where each deal is a node; connect two deals that share any **non-blocklisted**
  strong key. Connected components = people.
- Transitivity is allowed (A–B via email, B–C via phone ⇒ A=C), but because blocklisted values
  never create an edge, junk/shared values can't chain unrelated people together.

### Canonical id: oldest wins
- For each component, canonical `borrower_id` = the `borrower_id` whose deal has the earliest
  `created_at`. Deterministic tie-break: lexicographically smallest UUID.
- All deals in the component are rewritten to the canonical `borrower_id`.
- Idempotent: once canonical, an id stays canonical across re-runs (adding a 4th loan later does
  not flip it).

### Where it runs: dedicated global pass
- New endpoint `POST /api/resolve-identities`. Scans ALL deals (paginate past PostgREST's 1000
  cap), builds the graph in memory, writes canonical `borrower_id` only where it differs.
- **Modes:** `dryRun=true` (default) returns a report and writes nothing; `apply=true` performs
  writes after the safety check passes.
- **Trigger:** piggyback the existing ~15-min maintenance cadence (invoked after the per-account
  syncs complete) and available for manual invocation. The per-account sync stays unchanged; the
  resolver owns canonical grouping globally.

### Over-merge safety
- **Safety cap:** abort with NO writes if any resulting component would contain more than
  **N=20** deals, or total deals rewritten exceeds **M=200**, unless an explicit `override` flag
  is passed. (Known universe is ~40 components of 2–3 deals; largest real person = 8, Rene
  Gonzalez. Cap set to 20 for headroom — the blocklist + exact-key matching are the primary
  guard; this is the coarse backstop. Mirrors the existing prune's `maxPrune` guard.)
- **Reversible backup:** every `apply` run writes `_identity-resolve-backup-<ts>.json`
  (deal id → prior `borrower_id`) to project root before mutating — matches the session's
  existing `_*-backup-*.json` pattern (already gitignored).
- **Reviewable:** the dry-run report lists components that would change, their sizes, the
  blocklisted values encountered, and any component hitting the cap — so the merge is eyeballed
  before first apply.

### Dedup payoff (no dedup code change)
- `detectDuplicates` is unchanged: once `borrower_id` is canonical per person,
  `sharesBorrowerId` returns true for Marian's group and it's suppressed automatically.

## Acceptance Criteria
- [ ] `POST /api/resolve-identities?dryRun=true` returns a report (components changed, deals
      rewritten, largest component size, blocklisted values used) and writes nothing.
- [ ] After `apply`, Marian Cooper's 3 deals (Arive 16057126 / 16051877 / 17017052) share one
      `borrower_id` = the oldest of her prior ids.
- [ ] After `apply`, **0** deals exist where one `ghl_contact_id` maps to >1 `borrower_id`
      (the 31 contact-id splits collapse).
- [ ] Two distinct people sharing ONLY a blocklisted value (e.g. `info@brokerage.com`,
      `0000000000`) are NOT merged.
- [ ] Re-running `apply` immediately after a successful `apply` rewrites **0** deals (idempotent).
- [ ] The run aborts with no writes if any component would exceed the safety cap (N=20) without
      an `override` flag.
- [ ] Each `apply` writes a reversible backup JSON (deal id → prior `borrower_id`) before mutating.
- [ ] Marian's group and the ~40 split identities no longer appear on `/duplicates` as
      same-email / same-phone duplicates.
- [ ] No name-based matching exists anywhere in the resolver.
- [ ] Canonical id = oldest `borrower_id` by earliest deal `created_at`; deterministic tie-break.

## Out of Scope (Phase 1)
- `contacts` table and `deals.contact_id` FK (Phase 2)
- Contact-centric UI / person detail page (Phase 3)
- Refi radar, per-person LTV, repeat/referral detection, lead-spend person-dedup (Phase 4)
- Splitting / un-merging wrongly-merged borrowers (Phase 1 only merges; a bad merge is corrected
  via the backup-restore path, not an automated un-merge)
- Fuzzy or name-based matching (explicitly excluded)

## Open Questions
_None._ Confirmed by Efrain 2026-06-16: per-client cap **raised to 20 deals** for headroom on
high-volume investor clients (the largest real person today is Rene Gonzalez at 8); **no known
shared junk values** to pre-seed the blocklist — it starts empty and is populated reactively from
the dry-run report if a bad merge ever surfaces. M=200 total-rewrite cap retained as a backstop.
