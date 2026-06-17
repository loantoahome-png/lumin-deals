# Verification Log — Lumin Deals

### [2026-06-16] File: app/api/sync/ghl/route.ts
**Status:** VERIFIED
**Issue:** Funded volume was not LOS-authoritative. The GHL sync update path
(`maybeSet('loan_amount')`) overwrote a funded deal's Arive-imported `loan_amount`
with GHL's opportunity `monetaryValue` whenever the opp changed. The reconcile
block already guarded funded deals (`pipeline_group !== 'Funded'`), but the main
update path did not — an inconsistency.
**Changes:** Carried `pipeline_group` into the `byOppId` dedup index (`DealKey`,
`DedupRow`, both `.select()`s, `ingestDedupRow`). Added a guard in the update-path
`maybeSet` so `loan_amount` is skipped when the existing deal is Funded — Arive is
authoritative for closed loans. Guard is scoped to Funded only.
**Test Method:** Simulated OLD vs NEW update-path logic against the two live drift
cases + a non-funded control, using each deal's stored `raw_ghl_data.monetaryValue`.
**Result:**
- Craig English — GHL monetaryValue `0`; OLD clobbered to `0`, NEW preserves `67,812.74`.
- Lorelei David — GHL `110,956`; OLD clobbered, NEW preserves Arive `116,492.70`.
- Non-funded control — still accepts GHL value `250,000` (guard correctly scoped).
- `npx tsc --noEmit`: changed file type-clean (only pre-existing errors remain).

### [2026-06-16] File: app/funded/page.tsx
**Status:** VERIFIED
**Issue:** Funded page showed volume but not revenue. The Arive broker comp lives in
`compensation_amount` (set on 49 of 150 funded deals); the dead `revenue` column is
null for all funded deals.
**Changes:** Added `totalComp` (Σ `compensation_amount`) and render it next to funded
volume in the header, only when > 0.
**Test Method:** Confirmed `fetchAllDeals` defaults to `select('*')` so comp is
returned; `Deal` type carries `compensation_amount`; tsc clean.
**Result:** Header now reads "{n} deals · {volume} funded volume · {comp} comp".
LOS-authoritative revenue, consistent with lead-spend (which already sums comp).

### [2026-06-16] Data fix: Mario Nieto $432k phantom funded row
**Status:** VERIFIED
**Issue:** Deal `ea2bba9e` (Mario Nieto, $432k, "Loan Funded", no arive#, no funded_date)
was a phantom. Live GHL (contact 9yRiiinpoO4w4fhaUCvU) has 4 opps: 3× Mario all **lost**
($305,250 / $305,250 / $210,000) + Olga Alvarez $119,106.98 **won**. The row's opp
`lXFc5JNrYZ6upSTuNOdG` was DELETED in GHL; the funded-deal prune guard flags-not-deletes
funded rows, so the orphan persisted. Real closing ($119,106.98 under Olga) is already a
separate funded row (`56bb46ba`, arive 16651764).
**Changes:** Demoted to pipeline_group='Not Ready', status='Not Qualified - Income'
(documented reason: couldn't qualify; funded under wife Olga). Row backed up to
`_mario-nieto-phantom-backup-*.json`. Next maintenance sync prunes the orphan (opp gone).
**Result:** Funded 150→149; /health need-review 2→1 (only Stephen Coon remains).

### [2026-06-16] Feature: Cross-Source Identity Resolver (Contacts Phase 1)
**Status:** VERIFIED
**Issue:** Frozen-at-insert borrower_id split ~40 people across multiple ids → false duplicates
on /duplicates (e.g. Marian Cooper's 3 loans, Rene Gonzalez).
**Changes:** New `lib/identityResolver.ts` (pure guarded-transitive union-find over
ghl_contact_id ∪ email ∪ phone, weak-value blocklist, never name; oldest borrower_id wins) +
`runIdentityResolutionPass` (paginate, safety cap 20 / 200, sync_state backup, batched writes);
`POST /api/resolve-identities` (dry-run default); 30-min auto-heal hook in the maintenance cron.
**Test Method:** 9 fixture assertions (npx tsc compile + node) + live dry-run review + live apply
+ acceptance queries.
**Result:**
- Fixtures: Marian collapses (oldest wins), role-email & junk-phone strangers NOT merged,
  transitivity works, idempotent — ALL PASS.
- Live dry-run: 40 components, 55 rewrites, largest=8 (Rene Gonzalez, manually confirmed one
  real person — identical email/phone/contact-id across 8 loans). No abort.
- Live apply: 55 borrower_ids rewritten; backup = sync_state key
  identity_resolve_backup_2026-06-16T23:29:11.673Z.
- Post-apply: Marian's 3 deals → 1 borrower_id; same-contact-id splits 31 → 0; idempotent
  re-run rewrites 0.

### [2026-06-16] Feature: Contacts table + person view (Phase 2)
**Status:** VERIFIED (data + logic + build) — live visual is user-confirmable
**Changes:** `contacts` table (id = canonical borrower_id; supabase-contacts.sql, installed by
Efrain). Resolver extended: `buildComponents` (now also links by borrower_id so keyless Arive rows
join their person), `computeContactRows`, and `runIdentityResolutionPass` upserts/prunes contacts
on every apply. `/contacts` list + `/contacts/[id]` person page; Sidebar nav link.
**Test Method:** 20 fixtures (incl. keyless-row + contact rollups) via tsc+node; live populate +
acceptance queries; prod build (compiles all routes).
**Result:**
- Fixtures: ALL PASS (20).
- Live populate: 1454 contacts == 1454 distinct borrower_id; 0 orphans.
- Marian Cooper = ONE contact, loan_count 4, funded 3, $941,700 volume, both GHL contact ids,
  name+email populated (fixed the keyless-row clobber that first showed loan_count 1).
- Top contacts sane (Rene Gonzalez 8 loans).
- Deployed (commit 4e5422c) — prod build READY → /contacts routes compile.
**Not verified here:** live browser render (preview tool grabbed a different project + app is
auth-gated) — visual confirm is on the live site.

### [2026-06-16] Feature: Rich person view (Contacts Phase 3)
**Status:** CHANGED (build + tsc clean) — live visual is user-confirmable
**Issue:** `/contacts/[id]` was thin — a 4-stat header + bare loan table. Couldn't see a person's
history, jump to them in the right GHL sub-account, or tell if they were contactable.
**Changes:** Enriched `app/contacts/[id]/page.tsx` only (no DB / resolver change). Added: (1)
reachability + jump bar — DND badge via `dndSummary`/`dndLabel`, last-contacted, and one GHL link
per distinct sub-account via `ghlContactUrl`; (2) milestone activity timeline (added / stage move /
signed / funded), newest first, interleaved across the person's loans; (3) enriched loans list with
status badge, property, rate, type/purpose, amount + per-loan `/deals/[id]` / GHL / Arive links;
(4) title-cased name + first-seen/last-activity. Spec+plan in `docs/`.
**Data grounding (live probe 2026-06-16):** ghl_contact_id 94% (exactly 2 sub-accounts),
dnd/dnd_settings ~72% (237 hard-DND), stage_changed_at 84%, date_added_ghl 94% — all support the
features. `communications` JSONB = 0% → NO message timeline built (milestone-only, by design).
67 people have >1 loan (timeline interleave matters for them).
**Test Method:** `npx tsc --noEmit` (changed file + its libs type-clean; error set unchanged =
the 4 pre-existing files only); `npm run build` (compiles `ƒ /contacts/[id]` — build succeeds).
**Result:** Type-clean, build READY. Not browser-verified here (auth wall, same as Phase 2) —
visual confirm is on the live logged-in `/contacts/[id]` page (e.g. open Marian Cooper or Rene
Gonzalez). **Deployed** commit `f34057d` → prod READY (`lumin-deals.vercel.app`), 2026-06-16.

### [2026-06-16] Fix: person-view GHL link mislabeled by loan_officer
**Status:** CHANGED (tsc clean) — pending redeploy
**Issue:** On `/contacts/[id]`, Marian Cooper showed GHL jump-links "GHL · Matt, GHL · Matt,
GHL · Moe" — but two of those were the SAME GHL contact (hygNEpIZsaE9YCM4GzzY) in Moe's
sub-account; one was mislabeled "Matt". Root cause: `subAccountLinks` derived the LABEL from the
free-text `loan_officer` and DEDUPED on the raw `ghl_location_id` (null on one of the two deals).
A GHL opp sitting in Moe's location but stamped `loan_officer="Matt Park"` (deal 28bdd70e)
therefore got a "Matt" label on a link that actually opens Moe's sub-account, and didn't collapse
with the same contact's other row.
**Changes:** `subAccountLinks` now parses the resolved location id out of the URL `ghlContactUrl`
returns, dedupes on `resolvedLocation:contact_id`, and labels from the location id vs the
`NEXT_PUBLIC_GHL_LOCATION_ID*` env (never from loan_officer). Marian now correctly shows 2 links —
GHL · Moe (one contact) + GHL · Matt (the other).
**Test Method:** `npx tsc --noEmit` (error set unchanged = 4 pre-existing files); reasoned against
live data (location map: 84fC…=Matt, PKEB…=Moe).
**Result:** Type-clean. **Deployed** commit `b7a49d0` → prod READY (dpl_HUtocKiXEi4yYh5PfqsAyGfHGY5e), 2026-06-16.

### [2026-06-16] DIAGNOSIS (not a code fix): GHL↔Arive duplicate rows share an arive_file_no
**Finding:** Efrain spotted two "$280,000" rows on Marian = the SAME loan. Confirmed: both carry
`arive_file_no=16057126`. One row (4b479d31) is the Arive import (Moe, funded 2026-03-30, comp
$4,701, subject 6923 Standish Dr); the other (28bdd70e) is the GHL opportunity for that loan (in
Moe's GHL location, no funded_date, mailing addr 6121 41st Ave) onto which the durable join stamped
arive# 16057126. They don't merge because the dedup key is `loan_officer + loan_amount` and the LOs
differ (28bdd70e is wrongly stamped "Matt Park"; it's Moe's loan on every other signal).
**Scope (live probe):** 6 distinct `arive_file_no` values appear on >1 deal row (same loan
duplicated); only Marian's is split-LO. NOTE anomaly: arive 16893761 sits on TWO DIFFERENT people
(Cynthia $1.22M / Paul Southerby $122k) — likely a bad arive# fill or co-borrower, separate issue.
**Recommended fix (not yet built):** add a `arive_file_no`-shared duplicate detector to
`/duplicates` (dead-certain signal now that the join populates it on GHL rows) for one-click human
merge; correct Marian's wrong LO (Matt→Moe — affects comp credit, confirm first).

### [2026-06-16] Feature: "Same Arive file #" duplicate detector (the systemic cure)
**Status:** CHANGED (tsc + build clean) — pending deploy
**Issue:** GHL↔Arive duplicate rows that share an `arive_file_no` slipped past `/duplicates`. The
amount detector keys on `loan_officer + loan_amount` (misses LO/amount drift); email/phone/name are
skipped when the rows share a `borrower_id` — which the resolver gives Marian's twin rows, so they
were hidden. See `docs/diagnoses/2026-06-16-ghl-arive-duplicate-arive-file.md`.
**Changes:** `app/duplicates/page.tsx` only. New `'arive'` MatchType + `byArive` detector keyed on
trimmed `arive_file_no`; run FIRST so the authoritative label wins. In `addGroup`, arive matches
BYPASS `sharesBorrowerId` + `isLegitMultiLoan` (those guards are what hid the dups); other detectors
unchanged. Added match label "Same Arive file #" (Hash icon), an Arive filter tab, header copy.
Reuses the existing `/api/deals/merge` + dismiss flow — no API/schema change.
**Test Method:** `npx tsc --noEmit` (duplicates page clean; error set = the 4 pre-existing files
only); `npm run build` (✓ Compiled; `/duplicates` builds). Detector output set pre-confirmed by live
probe: exactly 6 arive_file_no values sit on >1 deal row (Marian, Rene Gonzalez, Henry Cardoza,
Jeffrey Kilgrow, Jong Oh + the Southerby anomaly).
**Result:** Type-clean, build READY. Merge picks the Arive row as primary (funded_date +
arive_file_no are completeness-score fields) → merging Marian's pair also corrects the LO to Moe.
Not browser-verified here (auth wall). **Deployed** commit `7893579` → prod READY
(dpl_HUtocKiXEi4yYh5PfqsAyGfHGY5e), 2026-06-16. Live check: `/duplicates` → Arive tab (6 groups).

### [2026-06-16] Feature: FUB-style contacts list (Contacts Phase 3.1)
**Status:** CHANGED (tsc + build clean) — pending deploy
**Issue:** `/contacts` was a dense, undifferentiated table — no per-person visual anchor, no
lifecycle signal, no bulk actions. Efrain wants each lead "divided" (Follow Up Boss reference).
**Changes:** `app/contacts/page.tsx` only. Each row now: colored initials **avatar** + two-line
name/source, a **lifecycle Stage pill** (In Process > Past Client > Lead > Not Ready), a **select
checkbox** (+ header select-all) with a selection bar (**Copy emails** to clipboard), and
**lifecycle filter tabs** with counts; kept search + money columns. Source + lifecycle are derived
client-side from a slim parallel deals fetch (`borrower_id, pipeline_group, source, created_at`) —
NO schema/resolver change (promote into the resolver later if the per-load fetch is heavy). Spec:
`docs/specs/2026-06-16-contacts-list-fub-style-spec.md`.
**Test Method:** `npx tsc --noEmit` (contacts page clean; error set = 4 pre-existing files);
`npm run build` (✓ Compiled; `/contacts` builds). Design shown to Efrain as a mockup for approval.
**Result:** Type-clean, build READY. Not browser-verified here (auth wall). **Deployed** commit
`675425a` → prod READY (dpl_5r769wdHSeujDTpUs8iMDaV66msj), 2026-06-16. Design approved by Efrain
from the mockup.

### [2026-06-16] Tweak: zebra striping on the contacts list
**Status:** CHANGED (tsc + build clean) — pending deploy
**Issue:** Efrain — rows blend together; hard to see where one lead ends and the next begins.
**Changes:** `app/contacts/page.tsx` — alternating row backgrounds (even `bg-white` / odd
`bg-slate-50`); selected rows stay `bg-blue-50`, hover `bg-slate-100`.
**Test Method:** `npx tsc --noEmit` (contacts page clean); `npm run build` (✓ `/contacts`). Mockup
shown for contrast sign-off.
**Result:** Type-clean, build READY. **Deployed** commit `7f28915` → prod READY
(dpl_5ow97jiix), 2026-06-16.
