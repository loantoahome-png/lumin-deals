# Verification Log — Lumin Deals

### [2026-06-24] Sidebar — reorder nav + collapsible Actions
**Status:** DEPLOYED — prod READY (`5edf13c` → `dpl_3jByJyacef7QyqMGv75mE1hvGTq6`, lumin-deals.vercel.app, 2026-06-24).
**Files:** components/Sidebar.tsx.
**Issue:** Efrain — reorder the nav to Dashboard, Notes, Contacts, Pipeline, Active Escrows, Hot Leads,
Funded; add a collapse toggle to the Actions section.
**Changes:** Top group reordered to that exact sequence; **Notes** pulled up out of Actions (no dup);
Refi Radar kept at the end of the top group (wasn't named, not dropped). Removed `alwaysOpen` from the
Actions group + the matching render branch, so Actions is now collapsible like the other sections
(chevron toggle, expanded by default, preference persisted in localStorage). Actions = Tasks/Tools/Compliance.
**Test Method:** `npx tsc --noEmit` (clean). `npm run build` (✓). Pure nav reorder — not browser-tested
(app shell is auth-gated); eyeball live.
**Result:** Type-clean, build READY. Deploy below.

### [2026-06-24] Sidebar search → master search (contacts + loans)
**Status:** DEPLOYED — prod READY (`7ee19c4` → `dpl_EmvzzYJK85EdmaJEEFPkBCf5D6dW`, lumin-deals.vercel.app, 2026-06-24).
**Files:** components/GlobalSearch.tsx.
**Issue:** Efrain — the sidebar "Search deals" bar should search BOTH contacts and loans, grouped with
contacts at the top, then loans.
**Changes:** GlobalSearch now queries `contacts` (display_name/email/phone) and `deals`
(name/address/email/investor + arive_file_no/investor_file_no) in parallel. Dropdown renders a
**Contacts** section first (→ `/contacts/[id]`, shows email/phone + loan count) then a **Loans** section
(→ `/deals/[id]`, existing status/amount/address row). Placeholder → "Search contacts & loans…";
scrollable dropdown; `.or` input sanitized (strip `,()` so a stray char can't break the PostgREST filter).
**Test Method:** `npx tsc --noEmit` (clean). `npm run build` (✓). Not browser-tested — results need an
authed session (contacts/deals RLS block anon); reuses the contact page's contacts query + the existing
deals search pattern, both proven in prod.
**Result:** Type-clean, build READY. Deploy below; live eyeball by Efrain (try a borrower name → contact
on top, their loans below).

### [2026-06-24] BUG: multi-loan borrower — webhook marks a sibling loan funded
**Status:** DEPLOYED — prod READY (`46c0fc0` → `dpl_HbCJardiRHUVKECVhwCyLsVSmqGQ`, lumin-deals.vercel.app, 2026-06-24). **Data corrected:** deal #16852090 (id a7384568…) set Loan Funded→Re-Submittal, pipeline_group Funded→Not Ready (dead bucket — matches the sync's `effectiveGroup` for a lost loan), ghl_status won→lost, funded_date cleared (verified before/after via service client, user-authorized). NOTE: the sync ALREADY demotes lost/abandoned opps (route.ts `isDead`/`effectiveGroup` lines 826-829, used on insert+update) — no code change needed there. Header `funded_count`/`total_funded_volume` rollup self-corrects on the next identity-resolver pass.
**Files:** lib/dealMatcher.ts (findExistingDeal); app/api/webhooks/ghl/route.ts (opportunity + main paths).
**Symptom:** John Winn has 2 loans — #17074897 funded (GHL Won / Arive Loan Funded) and #16852090
withdrawn (GHL Re-Submittal/**Lost** / Arive **Adverse**). Dashboard showed BOTH as "Loan Funded."
**Root cause (verified from data + code, not guessed):** the GHL webhook handler matched an incoming
opportunity to a deal via `findExistingDeal({ghlContactId, email, phone})` — **by contact, never by
opportunity id**. A GHL contact can hold multiple opportunities (loans). When the FUNDED opp's workflow
webhook fired, it matched the *adverse* deal (same contact/email) and the stage-apply set it to Loan
Funded (the `.neq('pipeline_group','Funded')` guard didn't block because the deal wasn't funded *yet*).
Proof in the row: #16852090 has its own `ghl_opportunity_id` (`izuou…`) but its `raw_ghl_data.id` is
the FUNDED opp (`obU6…`) in webhook-payload shape — the funded webhook overwrote it.
**Fix:** `findExistingDeal` now matches **by opportunity id first**, and the contact/email/phone
fallbacks only return a match when they resolve to **exactly one** deal (never guess a sibling). Webhook
passes the opportunity id (from payload `id` on opportunity events) on both the stage-change branch and
the main path.
**Test Method:** `npx tsc --noEmit` (clean). `npm run build` (✓). **Verified against live data**
(read-only): opp `izuou…`→1 deal (#16852090), opp `obU6…`→1 deal (#17074897), John's contact_id→2
deals (so the fallback now defers instead of clobbering). The sync already keys by opportunity id, so
it was never the culprit.
**Result:** Type-clean, build READY, fix verified against the real rows. Deploy below.

### [2026-06-24] Contact page — merge loans + show lead source
**Status:** DEPLOYED — prod READY (`27b7bb6` → `dpl_5B5BasfQuohAxbpnZNQHL7qrzhsJ`, lumin-deals.vercel.app, route 307→/login = healthy, 2026-06-24).
**Files:** app/contacts/[id]/page.tsx (Loans section).
**Issue:** Efrain — add a merge function (combine duplicate loans from the contact page) and show the
lead source on each loan card.
**Changes:** (1) **Lead source** (`cleanSource(d.source)`) now shown in each loan row's meta line.
(2) Replaced the per-row trash button with **checkbox selection + an action bar**: select loans →
**Merge** (2+) or **Delete** (1+). Merge opens a modal to pick the primary (radio; default = a funded
loan, else largest, else first) and calls the EXISTING **`POST /api/deals/merge`** `{primaryId,
secondaryIds}` — same call the `/duplicates` page uses (fills blanks from secondaries, combines
notes/tags, deletes the rest); refetches on success. Delete is now multi-select (loops the
`DELETE /api/deals/[id]` route from the prior change).
**Test Method:** `npx tsc --noEmit` (contacts clean, no stale refs). `npm run build` (✓ compiled,
`/contacts/[id]` builds). **Not live-tested** (loan list needs an authed session; merge/delete are
destructive prod data — Efrain's to run). Merge endpoint is already proven in prod via `/duplicates`.
**Result:** Type-clean, build READY. Deploy below; first real merge/delete + lead-source display want
an eyeball by Efrain (logged in).

### [2026-06-24] Contact page — show Arive/Lender loan #s + delete a loan
**Status:** DEPLOYED — prod READY (`37c6da6` → `dpl_6QUHVqYYxVBut66BpSRyxDkocEX3`, lumin-deals.vercel.app, route 307→/login = healthy, 2026-06-24).
**Files:** NEW app/api/deals/[id]/route.ts (DELETE handler); app/contacts/[id]/page.tsx (Loans section).
**Issue:** Efrain — on the contact "Loans" section, display the Arive loan # and Lender loan #, and
allow selecting a loan and deleting it (looking at a John Winn duplicate: two identical $300k HELOCs).
**Changes:** Each loan row now shows **Arive #** (`arive_file_no`) and **Lender #** (`investor_file_no`,
the field the Arive CSV "Lender Loan #" maps to). Added a per-row trash button → confirmation modal
(shows loan name/type/amount/#s + a caveat that GHL sync may re-create it) → `DELETE /api/deals/{id}`.
Endpoint uses `createServiceClient` + hard delete, **identical to the proven merge route** (line 144);
`deal_contacts` rows cascade via FK. UI removes the row optimistically on success.
**Test Method:** `npx tsc --noEmit` (contacts + api/deals clean). `npm run build` (✓ compiled,
`/api/deals/[id]` registered, `/contacts/[id]` builds). **Intentionally NOT live-tested**: (1) the loan
list needs an authed Supabase session (deals RLS blocks anon), (2) executing a real delete is
destructive prod data — left for Efrain. Delete query mirrors the merge route already running in prod.
**Result:** Type-clean, build READY. Deploy below. First real delete + the #-display want an
eyeball by Efrain (logged in).

### [2026-06-24] PDF Compressor — smart-hybrid engine + MozJPEG (better quality-per-byte)
**Status:** DEPLOYED — prod READY (`8d5dafd` → `dpl_59tcq1TX1xAcMug1gTUXAW8j7n8r`, lumin-deals.vercel.app, route 307→/login = healthy, 2026-06-24).
**Files:** NEW app/tools/pdf-compressor/compressEngine.ts; app/tools/pdf-compressor/CompressTab.tsx
(now UI-only, imports the engine); package.json + package-lock.json (+ `@jsquash/jpeg` WASM MozJPEG).
**Issue:** Efrain — "better quality while compressing more." Old engine rasterized EVERY page to JPEG
(blurred crisp text, killed selectability, sometimes grew the file). WebP/AVIF can't be embedded in a
PDF, so the real levers are: don't rasterize text pages + a better JPEG encoder.
**Changes:** Per-page **smart hybrid** — classify each page via pdfjs operator list: text/vector pages
are KEPT as-is (pdf-lib `copyPages` → crisp, still selectable, smaller); only image/scanned pages are
rendered + re-encoded. Rasterized pages now use **MozJPEG** (`@jsquash/jpeg` WASM, ~10–20% better
quality-per-byte) with the browser's native JPEG as a graceful fallback if the WASM can't load. Keeps
a per-page keep-vs-raster size check (RASTER_GAIN 0.9, biased to keep), the whole-file never-bigger
fallback, and grayscale (now true 1-channel via MozJPEG color_space). Resolution presets bumped (old
"Recommended" was ~108 DPI → now 144). Result note surfaces what happened ("N text pages kept sharp ·
M image pages recompressed (MozJPEG)"). Works across preset/target/custom; target search now sums
fixed kept-page bytes + per-quality image bytes.
**Test Method:** `npx tsc --noEmit` (all pdf-compressor files clean). `npm run build` (✓ compiled WITH
the WASM dep bundled, `/tools/pdf-compressor` prerendered). **Browser-verified locally** (temp
middleware allowlist, reverted; drove the live page with 3 real fixtures): (1) born-digital text report
3pp → "All pages kept sharp & selectable", 294→217 KB (−26%); (2) vector flyer → kept, −31%;
(3) generated raster-image PDF 1.97 MB → 132 KB (−93%), note "1 page recompressed **with MozJPEG**"
(that label only shows when the WASM encoder actually runs, not the fallback); (4) target-size mode
hit its cap with valid output. All outputs valid `%PDF-`, zero console errors.
**Result:** Type-clean, build READY, engine browser-verified incl. MozJPEG engaging. Deploy below.

### [2026-06-24] PDF Tools — Merge / Split / Rotate added (tabbed hub)
**Status:** DEPLOYED — prod READY (`adfaab5` → `dpl_9xz1UmEj6JxrzfRjoNCLXQVBFscd`, lumin-deals.vercel.app, route 307→/login = healthy, 2026-06-24).
**Files:** app/tools/pdf-compressor/page.tsx (now a tabbed hub), + new shared.tsx, CompressTab.tsx,
MergeTab.tsx, SplitTab.tsx, RotateTab.tsx; app/tools/page.tsx (tile renamed "PDF Tools").
**Issue:** Efrain — expand the compressor into a fuller PDF toolset. Chose the tabbed-hub layout.
**Changes:** `/tools/pdf-compressor` is now **PDF Tools** with 4 tabs (route kept so saved tiles still
resolve). Compress = the existing lossy rasterize engine (moved into CompressTab, unchanged logic).
**Merge** = multi-file, reorder (up/down arrows — not drag, for reliability) + remove, pdf-lib
`copyPages` into one doc. **Split** = each-page / custom-range ("1-3,5,8-10") / every-N pages →
multiple outputs + Download all. **Rotate** = 90/180/270°, all-pages or a page range, relative to
existing `/Rotate`. Merge/Split/Rotate are **lossless** (pdf-lib copies page objects — text kept),
vs Compress which rasterizes. Shared `shared.tsx` (Dropzone, loaders, parsePageRanges, blob/download
helpers). No new deps (pdf-lib + pdfjs already present); zip-free Download-all (sequential blobs).
**Test Method:** `npx tsc --noEmit` (all 6 pdf-compressor files clean; pre-existing errors elsewhere
only). `npm run build` (✓ compiled, `/tools/pdf-compressor` prerendered). **Headless engine check**
(`node`, pure pdf-lib, real generated PDFs): 14/14 PASS — merge page totals, parsePageRanges edge
cases (reversed/out-of-range/dedup), each/range/every-N split counts, relative rotation + wraparound,
rotation surviving save→load. **Browser-verified locally** (2026-06-24): ran `next dev` with a
TEMPORARY middleware allowlist for this one fully-client-side route (reverted via `git checkout`,
never committed/deployed), drove it in the preview browser with a real 2-page PDF fixture —
Compress 490.6 KB→154.6 KB (−68%, valid `%PDF-`, thumbnail rendered), Rotate (2 pages, valid PDF),
Split each-page (→ 2 valid PDFs p1/p2); all 4 tabs render with **zero console errors**. Merge not
click-tested (same Node-verified `copyPages` + the now-proven shared Dropzone/load plumbing).
**Result:** Type-clean, build READY, engine + UI runtime-verified (headless + in-browser). DEPLOYED
(`adfaab5`, prod READY). Temp local auth bypass + test fixture used only for verification — both fully
reverted, working tree clean.

### [2026-06-24] PDF Compressor — advanced engine (target-size, custom, grayscale)
**Status:** DEPLOYED — prod READY (`7a70214` → `dpl_BnsuQiKAkvmX5MZrAqpxrn6RPcTs`, lumin-deals.vercel.app, 2026-06-24).
**Files:** app/tools/pdf-compressor/page.tsx (full rewrite)
**Issue:** Efrain — "make the PDF compressor more advanced." Prior version: 3 fixed presets that
rasterize every page to JPEG; could hand back a file BIGGER than the source; no way to hit a size cap.
**Changes:** Three modes via a segmented control — (1) **Presets** (unchanged Aggressive/Recommended/
High Quality); (2) **Target size** — enter an MB cap (chips 2/5/10/15/25), engine renders each page
once per resolution and encodes at 6 candidate qualities, then picks the highest global quality that
fits under the cap (steps resolution down if even the lowest quality overshoots); (3) **Custom** —
resolution (DPI) + JPEG quality sliders. Global **grayscale** toggle (Rec.601 luma pass — big savings
on scanned color docs). **Never-bigger guarantee**: if the rebuild ≥ source, the original bytes are
kept and flagged "no change." Plus: page-1 preview thumbnails, per-file page counts, **Download all**
(no zip dep — sequential blob clicks), **Cancel** mid-run (cooperative, keeps finished files),
append-don't-replace file picking with dedupe, drag highlight, and clean output metadata
(fresh pdf-lib doc drops the source's author/producer/etc.). Still 100% client-side.
**Test Method:** `npx tsc --noEmit` (pdf-compressor clean; the 4–5 errors are all pre-existing in
reports/underwriting/DealForm/next.config — build ignores TS per next.config). `npm run build` (✓
`/tools/pdf-compressor` prerendered static). NOT browser-verified locally — every route is auth-gated
by middleware (redirects to /login without a Supabase session), same auth wall noted on prior entries.
Live smoke test = drop a real loan PDF and try Target-size + Grayscale.
**Result:** Type-clean (this file), build READY, **deployed** commit `7a70214` → prod READY. Route +
worker asset both return 307→/login unauthenticated (app up, auth wall intact — same as prior entries);
authenticated in-browser smoke test still pending Efrain (drop a real loan PDF, try Target-size + Grayscale).

### [2026-06-23] Deal page — section titles to blue-600 (color pop)
**Status:** DEPLOYED — prod READY (`bdbd7e6` → `lumin-deals-4ext8uwoo`, HTTP 200, 2026-06-24).
**Files:** app/deals/[id]/page.tsx (Section component)
**Issue:** Efrain wanted more pop on the section titles; picked the blue option from a mockup
(options shown: current slate / blue / blue-bar / indigo).
**Changes:** Section titles + icons `text-slate-800`/`text-blue-500` → unified `text-blue-600`
(matches the app's blue accent). Underline divider + larger size from the prior pass stay.
**Test Method:** `npm run build` (✓ compiled).
**Result:** Build READY. Pending deploy.

### [2026-06-23] Deal page — more pop + section separation (follow-up)
**Status:** DEPLOYED — prod READY (`b2f3339` → `lumin-deals-1t6ckl4ej`, HTTP 200, 2026-06-23).
**Files:** app/deals/[id]/page.tsx
**Issue:** Efrain wanted more pop + clearer section separation after the first hierarchy pass.
**Changes:** Inputs now have a `bg-slate-50` resting fill that turns white on focus (fields read as
distinct fillable boxes; the stronger slate-300 border still distinguishes them from the lighter
read-only "(auto)" fields). Section titles bumped `text-[13px]` → `text-sm`. Each section header now
has a bottom divider (`pb-2.5 border-b border-slate-200`) so it reads as a titled block, on top of
the existing between-section `divide-y`.
**Test Method:** `npm run build` (✓ compiled). Visual — eyeball live.
**Result:** Build READY. Pending deploy.

### [2026-06-23] Deal page visual hierarchy — titles pop, inputs more defined
**Status:** DEPLOYED — prod READY (`ea27358` → `lumin-deals-dvonzvuyc`, HTTP 200, 2026-06-23).
**Files:** app/deals/[id]/page.tsx (shared Section/Field/input style constants)
**Issue:** Efrain — on the deal "loan cards" everything blended: section titles, field labels, and
inputs were all the same gray (titles + labels both `text-slate-500`; inputs `border-slate-200` on
white = nearly invisible).
**Changes (establish a 3-level hierarchy):**
  - Section titles: `text-slate-500 font-semibold text-xs` → `text-slate-800 font-bold text-[13px]`
    (darker, bolder, slightly larger). Section icons `text-slate-400` → `text-blue-500` (accent).
  - Field labels: `text-slate-500` → `text-slate-600` (readable, clearly subordinate to titles).
  - Inputs/selects/date/currency/percent (all flow through `inp`): border `slate-200` → `slate-300`,
    hover `slate-300` → `slate-400` — defined field boundaries against the white card.
**Test Method:** Confirmed every field label routes through the `Field` component and every section
through `Section` (changes apply card-wide); `npm run build` (✓ compiled).
**Result:** Build READY. Pending deploy. Visual change — to be eyeballed live (authed page can't be
screenshotted from here).

### [2026-06-23] Remove Communications Log + Document Checklist from deal page
**Status:** DEPLOYED — prod READY (`a1cbd10` → `lumin-deals-b76ty8o51`, HTTP 200, 2026-06-23).
**Files:** app/deals/[id]/page.tsx; deleted components/CommunicationsLog.tsx,
components/DocumentChecklist.tsx, lib/documentTemplates.ts
**Issue:** Efrain — remove the Communications Log and Document Checklist sections from the deal
detail page entirely.
**Changes:** Removed both `<Section>` blocks from the deal page and their imports; dropped the
now-unused `Phone`/`FileText` icons and `Communication`/`DealDocument` type imports. Deleted the two
orphaned component files plus their only dependency, `lib/documentTemplates.ts` (verified no other
importers). No API routes existed for these. Left the `deals.communications` / `deals.documents` DB
columns intact (data preserved, just no UI).
**Test Method:** grep confirms zero remaining `CommunicationsLog` / `DocumentChecklist` /
`documentTemplates` references; `npx tsc --noEmit` (deal page: 0 errors); `npm run build` (✓ compiled).
**Result:** Build READY. Pending deploy. Live-confirm: deal page shows Conversation → Tasks → Notes
with no Communications Log or Document Checklist between them.

### [2026-06-23] Remove manual "Add Deal" feature entirely
**Status:** DEPLOYED — prod READY (`3cb367f` → `lumin-deals-7gp9sxudn`, /deals/new now 307-redirects, 2026-06-23).
**Files:** components/Sidebar.tsx, app/pipeline/page.tsx, app/deals/page.tsx, app/funded/page.tsx,
components/Dashboard.tsx, app/deals/new/page.tsx
**Issue:** Efrain — remove the "Add deal" entry points entirely (deals come from GHL sync + Arive
import, not manual entry).
**Changes:** Removed the Sidebar "Add Deal" nav item (+ now-unused `PlusCircle` import) and all four
"+ New Deal" buttons (Pipeline, Active Escrows, Funded, Dashboard headers). `/deals/new` now
server-redirects to `/deals` so it can't be reached directly. Removed the now-unused `Link` import in
funded/page.tsx. DealForm is kept — still used by the Edit Deal route.
**Test Method:** grep confirms zero remaining `/deals/new` / "Add Deal" / "+ New Deal" references;
`npx tsc --noEmit` (no new errors); `npm run build` (✓ `/deals/new` builds as the redirect).
**Result:** Build READY. Pending deploy. Live-confirm: sidebar has no Add Deal tab; the four buttons
are gone; visiting /deals/new bounces to /deals.

### [2026-06-23] Audit fixes: back-nav (new/edit) + date off-by-one cluster
**Status:** DEPLOYED — prod READY (`ed3c19f` → `lumin-deals-e850ty0ob`, HTTP 200, 2026-06-23). Live-click/date confirm pending.
**Files:** lib/utils.ts, components/DealForm.tsx, components/NotificationBell.tsx,
app/pipeline/page.tsx, components/LoanHistory.tsx
**Issue:** Found while auditing the dashboard at Efrain's request.
  (1) NAV: `DealForm` (New Deal + Edit Deal pages) had the same hardcoded `<Link href="/deals">`
      back button as the deal-detail page — landed on Active Escrows instead of the previous page.
  (2) TIMEZONE: date-only columns (`funded_date`, `signing_date`, `paid_date`, `last_contacted`,
      `lock_expiration`, `adverse`) were parsed via `new Date("YYYY-MM-DD")` = UTC midnight, then
      shown in Pacific → displayed ONE DAY EARLY. Hit `formatDate` (Pipeline/Contacts/Radar),
      `LoanHistory` funded date, `NotificationBell` lock display, and the Pipeline CSV export. The
      lock-days countdown math (`getLockDaysLeft`, `daysUntil`) had the same bug → a lock could read
      "EXPIRED"/wrong "Nd" a day early, shifting the red/amber alert threshold.
**Changes:**
  - `DealForm` back button → `router.back()` with `/deals` fallback (type="button", it's in a form);
    removed the now-unused `Link` import.
  - `formatDate` parses date-only strings as LOCAL midnight (regex), full timestamps unchanged.
  - `getLockDaysLeft` + `daysUntil` → local-midnight-to-local-midnight calendar diff (Math.round).
  - `NotificationBell` lock-display + Pipeline CSV dates routed through the corrected path.
**Test Method:** `npx tsc --noEmit` (no NEW errors; the one DealForm error is pre-existing, shifted a
line by the import removal); `npm run build` (✓ compiled). Live-confirm after deploy: funded/signing
dates show the correct day; new/edit deal Back returns to the previous page.
**Result:** Build READY. Pending deploy.

### [2026-06-23] Fix: deal-detail back arrow always went to Active Escrows
**Status:** DEPLOYED — prod READY (`322b46a` → `lumin-deals-9rn9h4k2s`, HTTP 200, 2026-06-23). Live-click confirm still pending.
**Files:** app/deals/[id]/page.tsx
**Issue:** Efrain — editing a lead from Hot Leads then clicking the "← All Deals" back arrow landed
on Active Escrows instead of returning to Hot Leads. Root cause: the back link was hardcoded
`<Link href="/deals">`, and `/deals` renders `EscrowTracker` (the Active Escrows view). It ignored
the originating page regardless of where you came from.
**Changes:** Replaced the hardcoded link with a `<button>` that calls `router.back()` (returns to the
previous page — Hot Leads, Pipeline, etc., with scroll restored), falling back to `router.push('/deals')`
when there's no in-app history (direct load / refresh). Relabeled "All Deals" → "Back" to match.
**Test Method:** `npx tsc --noEmit` (edited file: 0 errors); `npm run build` (✓ `/deals/[id]`).
**Result:** Build READY. Pending deploy. Live behavior to confirm after deploy: Hot Leads → open lead
→ Back → returns to Hot Leads.

### [2026-06-23] Adverse moved to Key Dates as a date input
**Status:** VERIFIED — deployed to prod (READY)
**Files:** app/deals/[id]/page.tsx, lib/types.ts
**Issue:** Efrain — `Adverse` was rendered as a plain text box in Loan Details (next to County), but
the Arive import brings it in as the Adverse Action **date**. Verified against live data: every
non-null `adverse` value in the `deals` table is an ISO date (e.g. 2026-06-16, 2026-06-10). The
`// Arive "Adverse" flag` comment in types.ts was wrong.
**Changes:** Removed the Adverse text field from Loan Details; added an Adverse `DateInput` to the
Key Dates section (after Last Contact). No data migration needed — the column already stores
`YYYY-MM-DD` text, which `<input type="date">` consumes directly. Fixed the types.ts comment.
**Test Method:** `npx tsc --noEmit` (edited files: 0 errors); `npm run build` (✓ `/deals/[id]`).
**Result:** Build READY. **Deployed** commit `f0bd359` → prod, alias `lumin-deals.vercel.app`
(`lumin-deals-au4eje33u`) Ready, HTTP 200, 2026-06-23. origin/main in sync (pushed).

### [2026-06-23] Lender added to deal detail header KPI strip
**Status:** VERIFIED — deployed to prod (READY)
**Files:** app/deals/[id]/page.tsx
**Issue:** Efrain — surface the lender name on the deal detail page. The value already existed in
the form ("Lender" field = `form.investor`, e.g. "ROCKET") but wasn't visible in the at-a-glance
dark header strip.
**Changes:** Added a "Lender" cell to the KPI strip between FICO and LO·Age; widened the grid to
`md:grid-cols-6`; long names `truncate` with a `title` tooltip; shows "—" when unset.
**Test Method:** `npx tsc --noEmit` (edited file: 0 errors — pre-existing errors elsewhere are
ignoreBuildErrors); `npm run build` (✓ `/deals/[id]`); `vercel inspect lumin-deals.vercel.app`.
**Result:** Build READY. **Deployed** commit `7ad25cd` → prod (dpl_5qbYtLVY4avphPuKGnTDsTcNkeyB),
alias `lumin-deals.vercel.app` Ready, HTTP 200, 2026-06-23. NOTE: `git push origin main` was blocked
by the Claude Code permission classifier, so origin/main is 1 commit behind prod until the push is run.

### [2026-06-23] Pre-Arive loan_amount mirrors opp value (clear stale figures)
**Status:** CHANGED — type-checked + build pass; NOT deployed; needs a GHL sync to apply
**Files:** app/api/sync/ghl/route.ts
**Issue:** Scot Gordon showed loan_amount $297,500 (verified in DB: arive_file_no null, non-funded,
opp LIjxhQID5q4r0KnurXA2) while the GHL opportunity value is $0. The sync could only bump loan_amount
UP, never clear it: `maybeSet` skips null, and the reconcile only stored opp values with `v > 0`. So a
stale custom-field figure (pre-2026-06-22) lingered because GHL's $0/null couldn't overwrite it.
**Changes:** For non-Arive, non-funded deals, loan_amount now MIRRORS the GHL opp value — written even
when 0/empty. `oppValue` map stores every live opp (incl. null); reconcile uses `oppValue.has()` to
distinguish "opp not fetched" from "value null"; main update loop sets loan_amount from the opp value
for pre-Arive deals. Arive/funded guard (`ariveOwnsAmount`) unchanged.
**Blast radius:** any pre-Arive lead with an empty GHL opp value now tracks it (a manually-typed amount
on such a lead clears on sync — intended; opp value is the source).
**Test Method:** `npx tsc --noEmit` (7/7), `npm run build` passes. Functional: deploy + run a full GHL
sync, then confirm Scot Gordon's loan_amount = his $0 opp value.
**Result:** Type-clean. NOT deployed — awaiting go-ahead; takes effect on next GHL sync.

### [2026-06-23] Import co-borrowers: read name col + strip primary's shared contact info
**Status:** DEPLOYED 2026-06-23 (commit 3f97c70 → lumin-deals.vercel.app)
**Files:** lib/ariveCsv.ts (rowToPatch), lib/dealContacts.ts (linkCoborrowerFromImport),
app/api/import/arive/route.ts.
**Issue:** First real import threw ~18 `coborrower_link: contact is already the primary borrower`
errors. Root cause (verified in the export): Arive's `Co-Borrower Email`/`Cell Phone` are copies of
the PRIMARY's, and the co-borrower NAME lives in a `Co-Borrower` column we weren't reading — so every
co-borrower resolved to the primary's contact and the guard refused.
**Changes:** read `Co-Borrower` as the name; null co-borrower email/phone when equal to the primary's;
new `linkCoborrowerFromImport` — name-only contacts, deal-scoped name dedup (idempotent re-import),
silent skip when it resolves to the primary.
**Verified:** real export → Jinsub Kim / Elizabeth Asonye / Sina Dowell parse as co-borrowers (Sina's
distinct phone kept). tsc 7/7, build passes.

### [2026-06-22] Co-borrower support (Build) — 10-task plan
**Status:** DEPLOYED 2026-06-22 (commit 77e11a9 → lumin-deals.vercel.app); migration run by Efrain.
Build/type/importer-logic VERIFIED; route confirmed live (auth 307). Live UI round-trip pending Efrain (logged-in).
**Source:** docs/specs/2026-06-22-coborrower-support-spec.md, docs/plans/2026-06-22-coborrower-support-plan.md
**Files (new):** supabase-add-deal-contacts.sql, lib/dealContacts.ts, components/CoborrowerManager.tsx,
app/api/deals/[id]/coborrowers/route.ts.
**Files (modified):** lib/types.ts (DealContact types + Deal.coborrowers), lib/identityResolver.ts
(prune guard), lib/ariveCsv.ts (co-borrower parse + plan.coborrower + dedupWarning),
app/api/import/arive/route.ts (find-or-create + link on commit), app/deals/[id]/page.tsx (manager),
app/deals/page.tsx (badge data), components/EscrowTracker.tsx (+N badge), app/import/arive/page.tsx
(preview chips), app/contacts/[id]/page.tsx (co-loans section), components/DealForm.tsx (default).
**Model:** `deal_contacts(deal_id, contact_id, role)` join; primary stays `deals.borrower_id`.

**Acceptance criteria:**
- [x] deal_contacts migration w/ FK cascades, unique(deal_id,contact_id), indexes, RLS+grant (mirrors contacts).
- [x] Deal can hold ≥1 co-borrowers; borrower_id path unchanged.
- [x] Manual link/remove/promote API (`/api/deals/[id]/coborrowers`) + CoborrowerManager UI on deal detail.
- [x] Arive import parses co-borrower cols, find-or-creates the contact (reuses strong-key match, never
      name), links role='co'; verified via script (Paul row → cob=Cynthia).
- [x] Dedup flag when co-borrower matches a separate deal; verified via script (fires for Cynthia's
      existing deal; "same Arive #" variant when arive_file_no matches).
- [x] Rollups primary-only: `computeContactRows` aggregates over borrower_id (unchanged); contact profile
      lists co-loans in a SEPARATE flagged section with a "counts toward primary" note.
- [x] +N badge on escrow cards (EscrowTracker); deal detail lists co-borrowers w/ links + promote/remove.
- [x] Resolver matching unchanged; prune guard keeps deal_contacts-referenced contacts from being deleted.
- [x] `npx tsc --noEmit` = 7 (unchanged baseline); `npm run build` passes (all routes incl. new API route).
**Verified:** type-check (7/7), production build, importer logic (throwaway tsx script: co-borrower parse +
dedup both fire correctly).
**NOT yet verified (needs the migration run on a live DB):** manual link/promote round-trip, badge render,
contact-profile co-loans section in the real app. Pipeline TABLE badge intentionally not added (spec said
"cards" → escrow card only).
**Required before use:** run `supabase-add-deal-contacts.sql` in Supabase. Then deploy (deploy-policy: ask first).

### [2026-06-22] Adverse loans not leaving Active Escrows after import
**Status:** VERIFIED (functional proof) — NOT yet deployed
**Files:** lib/ariveCsv.ts (`normStage` + export `pipelineGroupForStatus`),
app/api/import/arive/route.ts (update path).
**Issue:** Devon Spaulding (#17010728) was adversed in Arive but stayed in Active Escrows after a
re-import. Two gaps: (1) `normStage` had no mapping for Arive Stage "Adverse" → returned null →
status left at "Disclosed" (a Loans-in-Process stage); (2) the import update path wrote `status`
alone and never recomputed `pipeline_group`, but the Escrows/Funded/Not-Ready tabs filter by
`pipeline_group` — so even a mapped status change wouldn't move the deal between tabs. (2) also
affected the earlier `Suspended` mapping.
**Changes:** Map "Adverse"/"Adverse (Others)" → "Non-Responsive"; exported `pipelineGroupForStatus`
and the route now sets `patch.pipeline_group` whenever `patch.status` is written on an update.
**Test Method:** Ran Devon's real 23:21 export row through parseRowsFromCsv → rowToPatch → buildPlan
(overwrite) → route group-sync. Output: Stage "Adverse" → status Non-Responsive → plan
"Disclosed → Non-Responsive (overwrite)" → pipeline_group "Loans in Process → Not Ready".
**Operational:** requires importing the 23:21+ export (earlier exports still said "Disclosed") in
**Overwrite** mode (fill-blanks won't replace an existing status).
**Result:** VERIFIED. Type-clean (7/7 pre-existing). DEPLOYED 2026-06-22 (commit 920a0a2 → lumin-deals.vercel.app).

### [2026-06-22] Fix escrow-card stats box: Amount overlapping LO
**Status:** VERIFIED (visual proof) — NOT yet deployed
**Files:** components/EscrowTracker.tsx (Quick-stats grid, ~line 573)
**Issue:** Large loan amounts (e.g. Cynthia Southerby $1,220,480) overflowed the middle column of
the `grid-cols-3` stats box and visually overlapped the LO name ("$1,220,480oe Sefati").
**Changes:** Grid → `grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]` so the Amount column sizes to its
content on its own track; amount centered with `px-1 whitespace-nowrap`; LO cell right-aligned +
`truncate` + title. Lender/LO now shrink/truncate, Amount never collides.
**Test Method:** Rendered the exact card markup (same Tailwind classes) at 340px with $1,220,480 and
an 8-figure + long-lender stress case; screenshot compared before/after.
**Result:** VERIFIED — no overlap in either case; lender truncates, amount + LO stay separated.
Type-clean (7/7 pre-existing). DEPLOYED 2026-06-22 (commit f6508d0 → lumin-deals.vercel.app).

### [2026-06-22] Map Arive Stage "Suspended" → "Non-Responsive"
**Status:** CHANGED (1-line normStage fuzzy match; type-checked; NOT deployed)
**Files:** lib/ariveCsv.ts (`normStage`)
**Issue:** 4 rows in the export have Stage Name = "Suspended", which matched no dashboard stage →
status imported blank. Efrain chose to treat Suspended as a dead/paused file.
**Changes:** Added `lower.includes('suspend') → 'Non-Responsive'` (lands in the Not Ready group).
**Test Method:** `npx tsc --noEmit` (7/7 pre-existing). Confirm via import preview: the 4 Suspended
rows now resolve status = Non-Responsive, pipeline_group = Not Ready.
**Result:** Type-clean. DEPLOYED 2026-06-22 (commit f31bbbd → lumin-deals.vercel.app).

### [2026-06-22] Add P&I Payment field (Arive "First Mortgage Payment")
**Status:** CHANGED (new field + mapping + UI + migration; type-checked; NOT deployed; SQL pending)
**Files:** lib/types.ts (`pi_payment`), lib/ariveCsv.ts (MAPPINGS), app/deals/[id]/page.tsx,
components/DealForm.tsx (field + default), supabase-add-pi-payment.sql (NEW migration).
**Issue:** Efrain's Arive export now carries "First Mortgage Payment" (monthly P&I, 81% populated),
distinct from "Total Housing Payment" (full PITI → existing `housing_payment`). He wants the P&I
visible. No field existed, so it was being dropped on import.
**Changes:** Added `pi_payment NUMERIC`; mapped `First Mortgage Payment` → `pi_payment`; surfaced a
"P&I Payment" CurrencyInput beside "Total Housing Payment" on deal detail + new-deal form.
**Test Method:** `npx tsc --noEmit` (total errors unchanged at 7, all pre-existing; 0 mention
pi_payment). Run `supabase-add-pi-payment.sql`, then an import preview to confirm pi_payment fills.
**Result:** Type-clean. SQL migration run by Efrain; DEPLOYED 2026-06-22 (commit f31bbbd → lumin-deals.vercel.app).

### [2026-06-22] Arive importer: consume "Primary Loan Processor Name"
**Status:** CHANGED (1-line mapping add; type-checked; NOT deployed)
**Files:** lib/ariveCsv.ts (MAPPINGS — `processor` entry)
**Issue:** The daily Arive export carries the processor as **"Primary Loan Processor Name"** (27%
of rows populated), but the importer's `processor` mapping only matched **"Processor Type"** —
exact, case-sensitive — so that data was silently dropped on every import.
**Changes:** Added `'Primary Loan Processor Name'` as the first accepted header for the `processor`
field (kept `'Processor Type'` as a fallback for older exports).
**Test Method:** `npx tsc --noEmit` (clean on ariveCsv.ts). Functional check: re-run an import
preview and confirm `processor` now appears in the change plan for rows that have a processor name.
**Result:** Type-clean. DEPLOYED 2026-06-22 (commit f31bbbd → lumin-deals.vercel.app).

### [2026-06-22] Rename display labels: Investor → Lender, Investor File # → Lender Loan #
**Status:** CHANGED (label text only; type-checked; NOT deployed)
**Files:** components/EscrowTracker.tsx, app/deals/[id]/page.tsx, components/DealForm.tsx,
app/pipeline/page.tsx, app/health/page.tsx, app/deals/page.tsx, components/FundedTracker.tsx,
app/api/cron/lock-alerts/route.ts (8 files).
**Issue:** Dashboard said "Investor"/"Investor File #" while Arive calls them "Lender"/"Lender
Loan #"; Efrain wanted the wording to match so everything lines up.
**Changes:** Renamed every user-facing label/header/CSV-export-header/email label. DB columns and
field keys (`investor`, `investor_file_no`) and all mapping/logic UNCHANGED — display text only.
Covered: escrow card, deal detail form, new-deal form, pipeline table + column picker + field
config + CSV export, deals table + CSV export, health column, funded CSV export, lock-alert email.
Updated two internal comments too. Verified no user-facing "Investor" label remains (grep).
**Test Method:** `npx tsc --noEmit` → total unchanged at 7 (all pre-existing). No field keys touched.
**Result:** Type-clean. DEPLOYED 2026-06-22 (commit f31bbbd → lumin-deals.vercel.app).

### [2026-06-22] Active Escrows card redesign (EscrowTracker)
**Status:** CHANGED (UI + 1 new column; type-checked + visually verified; NOT deployed; SQL migration pending)
**Files:** components/EscrowTracker.tsx, lib/types.ts (`processor_handoff`), components/DealForm.tsx
(default), supabase-add-processor-handoff.sql (NEW migration).
**Changes (per Efrain's spec):**
- Grey stats box: added **Investor** (left of Amount) → Investor · Amount · LO; removed **In Stage**.
- Added **☑ Subbed on teams** below the grey box → persists to the existing (previously unused)
  `subbed` boolean (his call: reuse it).
- Removed ALL time-in-stage UI from the card (grey-box number + the "Stuck Nd" / "Above SLA X/Yd"
  alert badges; his call). Toolbar SLA/blocked filters left intact.
- Moved the **Follow-up** picker INSIDE the Next Step box; removed the standalone Follow-up section.
- Removed the **Waiting on** section.
- Added **☑ Processor Handoff** under the Processor dropdown → new `processor_handoff` boolean.
- Dropped now-unused imports (Snowflake, Hourglass, AlertOctagon, WAITING_ON_OPTIONS) + vars.
**Test Method:** `npx tsc --noEmit` → 0 errors in changed files; total unchanged at 7 (pre-existing,
build-ignored). Visually verified with a temp local auth-bypass + dev mock (both removed after):
DOM extraction confirmed field order Investor·Amount·LO, Subbed/Handoff checkboxes bound correctly,
Follow-up renders inside Next Step, In Stage + Waiting On gone. Screenshot captured.
**Result:** Type-clean + visually verified. **BLOCKER for Processor Handoff persistence:** run
`supabase-add-processor-handoff.sql` in the Supabase SQL Editor (adds the column). Until then the
checkbox toggles but the write silently fails. NOT deployed — awaiting go-ahead per deploy policy.

### [2026-06-22] loan_amount is now ARIVE-authoritative (reverted the GHL-value approach)
**Status:** CHANGED (sync + webhook; type-checked; NOT yet deployed)
**Files:** app/api/sync/ghl/route.ts, app/api/webhooks/ghl/route.ts
**Issue:** Root cause CORRECTED. My earlier diagnosis (the $610k came from Arive) was an
unverified assumption and WRONG. A service-role query of Laura's stored payload showed
the $610k was the GHL custom field "Loan Amount"=610000 (lead-intake); Arive had the
correct $150k. GHL was clobbering Arive. Per Efrain, Arive (the LOS) is ALWAYS
authoritative for the loan amount.
**Changes:**
- Reverted the prior "webhook reconciles loan_amount from opp monetaryValue" change
  (wrong direction — it trusted GHL).
- Sync: dropped the `?? customField('Loan Amount')` fallback (the $610k source);
  loan_amount now comes only from opp monetaryValue, and an `ariveOwnsAmount` guard
  (arive_file_no present OR funded) means GHL never touches loan_amount on Arive deals.
- Sync maintenance reconcile now skips Arive-backed deals (added arive_file_no to scan).
- Webhook: removed the contact-branch loan_amount write (it pulled the bad custom field).
- Net: Arive owns loan_amount on every Arive-backed deal; GHL only fills pre-Arive leads.
**Test Method:** `npx tsc --noEmit` → 0 errors in both files; total unchanged at 7
(pre-existing, build-ignored). Cannot fire a live sync/webhook safely (mutates prod).
Functional confirm: after deploy, an Arive deal's amount should match Arive and never
flip to a GHL number.
**Result:** Type-clean. DEPLOYED 2026-06-22 (commit f31bbbd → lumin-deals.vercel.app).

### [2026-06-22] Webhook reconciles loan_amount from opp value (kill dashboard lag)  — REVERTED (see entry above)
**Status:** CHANGED (server webhook; type-checked; NOT deployed; live confirm pending a real GHL webhook)
**Files:** app/api/webhooks/ghl/route.ts — the opportunity-event branch now reads the
opp `monetaryValue` and writes it to `loan_amount` in the same update as the stage, so a
Value edit in GHL reflects on the dashboard immediately instead of waiting for the
~15-min maintenance sync (previously the only place loan_amount reconciled from the opp).
Guarded to non-funded only (`group !== 'Funded'`), mirroring the sync's rule so Funded
deals keep their Arive amount. The branch now also fires on a value-only edit (no stage
change), using the existing row's pipeline_group for the Funded guard in that case.
**Issue:** Active deals showed stale/blank loan_amount until the cron maintenance
reconcile (Laura $610k→$150k, Mayra blank→$340k). See [[loan-amount-provenance]].
**Test Method:** `npx tsc --noEmit` → 0 errors in the file; full error count unchanged
at 7 (all pre-existing: reports/underwriting/DealForm/next.config, build-ignored). Could
NOT fire a live webhook (GHL_WEBHOOK_SECRET gate + it would mutate prod data), so
functional confirmation waits for a real opp webhook or Efrain watching a value edit
reflect on the dashboard within seconds.
**Result:** Type-clean. DEPLOYED 2026-06-22 (commit f31bbbd → lumin-deals.vercel.app).

### [2026-06-19] Dashboard visual redesign — hero metric + depth + hierarchy
**Status:** CHANGED (UI only; verified locally with mock data, real data gated by login)
**Files:** components/Dashboard.tsx (KPI section → blue gradient hero card for Active Escrow
Volume + 3 accent KPI cards with left accent bars / filled icon badges; `KPICard` reworked
`color` prop → `accent` (emerald|violet|amber); "Escrows by Stage" bar chart → gradient bars +
`LabelList` count labels + Re-Sub red / Signed green / rest blue, YAxis dropped; all insight
cards bumped from `shadow-sm border-slate-100` → `shadow-md shadow-slate-200/60 border-slate-200/80`;
`<UnreadInbox />` moved below Next Steps so the page leads with metrics, not the inbox; added
Wallet/Layers/LabelList imports).
**Issue:** Efrain felt the dashboard looked flat/unprofessional. Diagnosis: inverted hierarchy
(inbox dominated the top), flat KPI cards with rainbow icon tints, no focal point.
**Fix:** Depth + hierarchy, tight hue palette (one brand blue + semantic green/red). Direction
approved via two iterated mockups before any code.
**Test Method:** Local Next dev server with a temporary NODE_ENV-guarded auth bypass + dev-only
`NEXT_PUBLIC_DEV_MOCK` mock escrows (BOTH removed after screenshots — middleware.ts and
Dashboard.tsx back to clean). Captured before/after screenshots, all sections rendered, no console
errors. `npx tsc --noEmit`: zero errors in Dashboard.tsx (pre-existing errors elsewhere unchanged;
build ignores them via next.config `ignoreBuildErrors`/`ignoreDuringBuilds`).
**Result:** VERIFIED — deployed to production 2026-06-19 via `vercel --prod` (dpl_2GSWyMNQNGtDZ6kc
rpuSoh97TRkJ, readyState READY) → https://lumin-deals.vercel.app. NOTE: local working tree not yet
committed to git — the live code is not in a commit (drift risk if a git-based deploy runs later).

### [2026-06-19] Tools page: make the list team-shared (was per-browser localStorage)
**Status:** CHANGED (UI + new API; live visual gated by login)
**Files:** app/api/tools/route.ts (NEW — GET/POST shared list in sync_state key `tools_list`,
same pattern as radar par-rates, no schema change), app/tools/page.tsx (load shared list from
DB; write-through to DB when shared else localStorage; "Publish to team" button + "Shared with
team" badge).
**Issue:** Tools were stored in `localStorage` (`lumin_tools_v1`), so each person had a private
copy — Efrain's edits never reached Matt/Moe.
**Fix:** Tools now persist in `sync_state` (team-wide). Page prefers the shared list; until it's
published it falls back to the local list (nothing breaks). **Efrain clicks "Publish to team"
once** → his current list becomes the shared master; after that every add/edit/delete by anyone
writes to the one shared list and everyone sees it.
**Test Method:** `npx tsc --noEmit` clean on changed files; `npm run build` ✓ (`/api/tools` +
`/tools` built); confirmed `sync_state` reachable, `tools_list` not yet seeded (correct).
**Result:** Build + types green. Visual + publish flow confirm after deploy.

### [2026-06-18] NEW PAGE: /compliance — calling & texting cheat sheet
**Status:** CHANGED (UI; live visual gated by login)
**Files:** docs/compliance-quick-reference.md (NEW source doc), app/compliance/page.tsx (NEW,
static server component mirroring the doc), components/Sidebar.tsx ("Compliance" link in Actions
group, ShieldCheck icon).
**Changes:** In-app, read-only compliance reference for Efrain/Matt/Moe. Covers the calls-vs-texts
split (3-month DNC inquiry window is calls-only; TCPA written consent governs texts and doesn't
expire until revoked), the always-applies layer (opt-outs/10DLC/quiet hours/state mini-TCPAs), a
decision cheat table, and "what protects us today." Opens with a not-legal-advice disclaimer.
**Test Method:** `npx tsc --noEmit` clean on changed files; `npm run build` ✓ (`/compliance`
prerendered static).
**Result:** Build + types green. Visual confirm after deploy.

### [2026-06-18] Remove Monday.com sync (button + dead route)
**Status:** CHANGED (UI + dead-code removal; live visual gated by login)
**Files:** app/health/page.tsx (removed "Sync from Monday" button, simplified runSync to GHL-only,
dropped 'monday' from syncing state, removed unused Database icon import); DELETED
app/api/sync/monday/route.ts (398 lines, the only caller was that button).
**Why:** Efrain confirmed Monday will never be synced again. The Monday sync was also the ONLY
writer of `processor_status` (it's not on any cron), so removing it prevents the legacy
processor labels (just cleared) from ever reappearing.
**Left intact (intentional):** app/tools/page.tsx Monday board bookmark (read-only reference link)
and a historical comment in app/api/sync/ghl/route.ts. GHL sync is now the only sync.
**Test Method:** grep confirms no remaining code refs to the route; `npx tsc --noEmit` clean on
health page (only pre-existing DealForm:18 standing error remains); `npm run build` ✓.
**Result:** Build + types green; route removed. Visual confirm after deploy.

### [2026-06-18] Active Escrows: processor dropdown + new processor options
**Status:** CHANGED (UI; live visual gated by login)
**Files:** lib/types.ts (NEW `PROCESSORS = [Self Processing, Susan Lim, Hanh Nguyen]`),
components/EscrowTracker.tsx (processor dropdown on the card, under the Amount/LO/In-Stage row),
app/deals/[id]/page.tsx + components/DealForm.tsx + app/pipeline/page.tsx (options → PROCESSORS).
**Changes:** Added an at-a-glance + editable Processor `<select>` to the Active Escrows card
(binds to `processor_status`, saves via existing onUpdate). Replaced the 3 hardcoded option
lists (`Brianne Han / Self Processing`) with the shared PROCESSORS constant. Dropdowns show ONLY
the three options (no legacy fallback) per Efrain.
**Data cleanup (prod, authorized):** Efrain chose to CLEAR all non-standard values, not migrate.
Set `processor_status = NULL` for the 6 deals not in PROCESSORS (Hanh - 3rd party ×3,
Susan - In house ×2, Lexi - 3rd party ×1). Verified: 0 non-standard remaining; Self Processing
intact at 126. No 'Brianne Han' ever existed. `processor_status` is only written by the manual
(non-cron) Monday sync, so values won't auto-reappear.
**Test Method:** changed files type-clean (only the pre-existing DealForm:18 standing error
remains); `npm run build` ✓; DB verified via count queries.
**Result:** Build + types green; data cleaned. Visual confirm after deploy.

### [2026-06-18] Notes: fix doubled content after editing (render bug)
**Status:** CHANGED (UI; live visual gated by login)
**Files:** components/NotesBoard.tsx (distinct keys on editor vs view branches).
**Issue:** After editing, the read-only view showed the note's content TWICE. Verified via DB
(`dashboard_notes`): stored content was a single correct line — so a RENDER bug, not data.
**Root cause:** the `editing ? <div contentEditable> : <div>NoteMarkdown</div>` branches are
both `<div>` in the same JSX slot → React reused the same DOM node on toggle. The editor's
imperatively-set innerHTML (via ref) stayed in the node, and NoteMarkdown's output was appended
on top → duplicate text.
**Fix:** `key="note-editor"` / `key="note-view"` on the two branches forces React to unmount
the editor and mount the view fresh (no stale children). Data was already correct (no migration).
**Test Method:** `npx tsc --noEmit` clean; `npm run build` ✓. DB confirmed single-line content.
**Result:** Build + types green. Visual confirm after deploy.

### [2026-06-18] Notes: highlight is now a TOGGLE (bugfix)
**Status:** CHANGED (UI; live visual gated by login)
**Files:** components/NotesBoard.tsx (toggleHighlight).
**Issue:** Highlight button used execCommand('hiliteColor') which only APPLIES — no way to
un-highlight (reported: highlighted text, couldn't remove it).
**Changes:** Replaced with a custom `toggleHighlight()`: wraps selection in <mark> to apply;
clicking again on highlighted text (or with the caret inside it) unwraps it. Also clears
legacy highlights stored as background-color spans/fonts (from the prior hiliteColor version),
so already-stuck highlights can be removed. Storage unchanged (<mark> → == ; unwrapped → plain).
**Test Method:** `npx tsc --noEmit` clean; notes-md-check 23/23; `npm run build` ✓.
**Result:** Build + types green. Toggle behavior is DOM/Selection — verify live after deploy.

### [2026-06-18] Notes: WYSIWYG editor + per-note font size
**Status:** VERIFIED (logic) / CHANGED (UI; live visual gated by login)
**Files:** lib/noteMarkdown.ts (NEW markdownToHtml + upgraded htmlToMarkdown: headings,
lists, highlight, font-weight spans), components/NotesBoard.tsx (textarea → contentEditable
WYSIWYG via execCommand; per-note font size 12–26 in the editor toolbar via localStorage by
note id; removed global header font slider), scripts/notes-md-check.ts (NEW, 23 fixtures).
**Changes:** (1) Bold/highlight/headings/bullets now render live while editing instead of
showing raw markdown (`**WA**`). Storage stays MARKDOWN (htmlToMarkdown on save) so existing
notes + the read-only NoteMarkdown renderer are unaffected; legacy HTML notes still convert.
(2) Each note has its own 12–26 size control (A− / A+) in the edit toolbar, persisted per
browser by note id (font size was never a DB value → no migration).
**Test Method:** `notes-md-check` **23/23 pass** (md→html, html→md incl. hiliteColor spans,
md→html→md round-trips); `npx tsc --noEmit` clean on changed files; `npm run build` ✓ (/notes
prerendered).
**Result:** Converter logic VERIFIED; build + types green. execCommand toolbar behavior +
rendered visual are behind the login wall — confirm live after deploy.

### [2026-06-18] /lead-performance — group HELOC into Refinance
**Status:** VERIFIED (logic) / CHANGED (page; live visual gated by login)
**Files:** lib/leadReport.ts (Purpose now All|Purchase|Refinance; matchesPurpose Refinance
matches refinance OR heloc), app/lead-performance/page.tsx (PURPOSE_TABS, methodology note),
scripts/lead-report-check.ts (updated grouping fixtures).
**Changes:** Per Efrain, HELOC is no longer a standalone toggle — it's grouped INTO Refinance
(equity refinance). Toggle is now All / Purchase / Refinance. Refinance(+HELOC) = 1,090 leads.
**Test Method:** fixtures **55/55 pass**; `npx tsc --noEmit` clean; `npm run build` ✓ (prerendered).
**Result:** Logic VERIFIED; build + types green. Visual behind login.

### [2026-06-18] /lead-performance — Purchase/Refinance/HELOC purpose filter
**Status:** VERIFIED (logic) / CHANGED (page; live visual gated by login)
**Files:** lib/leadReport.ts (+ Purpose type, matchesPurpose, purchasedBook 3rd arg),
app/lead-performance/page.tsx (purpose toggle row), scripts/lead-report-check.ts (+11 fixtures).
**Changes:** Added a loan-purpose filter (All / Purchase / Refinance / HELOC). Real data values
in the purchased cohort: Refinance 1,022, Purchase 125, HELOC 68, untagged 103. HELOC kept as
its own bucket (not folded into Refinance). Untagged (~8%) show only under "All purposes".
Active purpose shown in subheader + CSV filename.
**Test Method:** fixtures **56/56 pass**; `npx tsc --noEmit` clean on the page/lib; `npm run build`
✓ (`/lead-performance` prerendered static).
**Result:** Logic VERIFIED; build + types green. Rendered visual behind login wall.

### [2026-06-18] NEW PAGE: /lead-performance — purchased-lead response funnel
**Status:** VERIFIED (logic) / CHANGED (page; live visual gated by login)
**Files:** lib/leadReport.ts (NEW, pure logic), app/lead-performance/page.tsx (NEW),
components/Sidebar.tsx (nav: "Lead Performance" in Insights; Lead Spend icon → DollarSign),
scripts/lead-report-check.ts (NEW, 45 fixtures).
**Changes:** Dashboard version of the approved "Purchased Lead Performance" PDF. Purchased
(vendor) leads only; warm/organic excluded. Responded = engaged at least once, **Ghosted
counts as responded** (corrected def — was wrongly cold). Opt-out/DND a separate bucket.
KPI cards + per-source + per-state tables, switchable All/Matt/Moe, CSV export. Computation
in lib/leadReport.ts (pure, reusable).
**Test Method:** (1) `npx tsc lib/leadReport.ts scripts/lead-report-check.ts … && node` →
**45/45 fixtures pass** (Ghosted=responded, purchased filter, segment math, rrBand, groupBy).
(2) `npx tsc --noEmit` → no errors in new files. (3) `npm run build` ✓ — `/lead-performance`
**prerendered as static (○)**, so the component mounts without a render-time crash.
**Result:** Logic VERIFIED against fixtures; build + types green. Numbers match the live-data
report (1,314 purchased leads, 34.6% combined response rate). Rendered-data visual is behind
the login wall — confirm live after deploy or via logged-in `npm run dev`.

### [2026-06-17] Deal detail: "View Contact" button in the header
**Status:** CHANGED (tsc-clean + build-passed; live visual gated by login)
**File:** app/deals/[id]/page.tsx
**Changes:** Added a "View Contact" button (User icon) as the first item in the header
action group, linking to `/contacts/{borrower_id}` (the person rollup page with all
their loans). Rendered only when `form.borrower_id` is set. Styled to match the dark
header (white/10 chip).
**Test Method:** `npx tsc --noEmit` deals/[id] clean; `npm run build` ✓ (`/deals/[id]`
compiles). Visual gated by login.
**Result:** Pending your visual check. Build + types green.

### [2026-06-17] Lead Spend: LO/stage filter leaked date-less funded deals
**Status:** CHANGED (tsc-clean + build-passed; live visual gated by login)
**File:** app/lead-spend/page.tsx
**Issue:** Funded deals with a NULL `funded_date` showed under the wrong LO. In
`filtered`, the date-anchor early-return `if (!dateStr) return !isBounded` ran BEFORE
the LO + stage checks, so under "All time" a date-less funded row bypassed the LO
filter and leaked into the other LO's view. Confirmed against data: Marian Cooper
(Arive, Matt Park, funded_date null) and Jong Oh (Lending Tree, Matt Park, the null-
date one of his two rows) both appeared under Moe — both are the Arive duplicate rows.
**Changes:** Moved the LO + stage filters to the top of the `deals.filter` callback so
they apply to every deal, including date-less funded loans. Date anchoring unchanged.
**Test Method:** `npx tsc --noEmit` lead-spend clean; `npm run build` ✓. Logic: a
Matt-Park funded row with no funded_date now fails the Moe LO check first → excluded
from Moe; still shows under Matt/All. Visual gated by login.
**Result:** Pending your visual check. (Root data fix = merge the Arive duplicate rows
on /duplicates — separate, human-in-the-loop.)

### [2026-06-17] Dashboard: Next Steps section (mirrors Active Escrows)
**Status:** CHANGED (tsc-clean + build-passed; live visual gated by login)
**File:** components/Dashboard.tsx
**Changes:** New "Next Steps" card at the bottom of the Dashboard listing every active
escrow (Loans in Process) with its `next_action` beside the name (left = name + stage/
assignee; right = next step + due, overdue in red). Built from the existing
`escrowsInProcess` (no new fetch; `next_action` already in DASHBOARD_COLS), sorted by
`next_action_due` soonest-first (no-due last). Scrolls at `max-h-[480px]`; "Open Active
Escrows" link. Not date-range filtered (current pipeline work, like the Today widget).
**Test Method:** `npx tsc --noEmit` Dashboard clean; `npm run build` ✓ (`/` prerenders).
Visual gated by login.
**Result:** Pending your visual check. Build + types green.

### [2026-06-17] Lead Spend: funded-loans section for the current timeframe
**Status:** CHANGED (tsc-clean + build-passed; live visual gated by login)
**File:** app/lead-spend/page.tsx
**Changes:** Added a "Funded loans · {range}" section below the per-source table —
a flat table of the individual funded deals (Borrower→/deals/[id], Source, LO, Funded
date, Loan amount, Revenue) for the active filters, with a Total row. Derived via
`fundedView` = `filtered` funded deals scoped to `visibleSources` names, so the count
matches the Funded KPI (respects range/LO/stage/source/paid-only). Added a local
`fmtDate` + `rangeLabel`. Section hidden when zero funded in range.
**Test Method:** `npx tsc --noEmit` lead-spend clean; `npm run build` ✓ (`/lead-spend`
prerenders). Visual gated by login.
**Result:** Pending your visual check. Build + types green.

### [2026-06-17] Fluid CPU: widen identity-resolver + maintenance cron intervals
**Status:** CHANGED (build-passed) — live CPU impact verifiable only on the Vercel chart over the next few days
**File:** app/api/cron/ghl-sync/route.ts (+ CLAUDE.md sync-architecture docs)
**Issue:** Fluid Active CPU creeping up (3h28m / 4h). Root cause: the Contacts/identity-resolver feature (shipped 2026-06-16) added a full deal-table scan + contacts rebuild running every 30 min, plus the every-60-min maintenance full-opp scan. On the confirmed `*/15 8-18 * * 1-5` cron that's ~20 + ~10 full-table sweeps/business day, each heavier as data grows.
**Changes:**
- `IDENTITY_RESOLVE_INTERVAL_MS` 30 min → 3 h (~20×/day → ~3×/day)
- `MAINTENANCE_INTERVAL_MS` 60 min → 3 h (~10×/day → ~3–4×/day)
- Cron ping cadence unchanged (confirmed correct at 15 min); `?full=1` / `POST /api/resolve-identities` still force on demand.
**Test Method:** `npm run build` ✓ (route table prerendered, no errors in changed file; pre-existing tsc errors in reports/underwriting/DealForm are unrelated). Real verification: watch Fluid Active CPU on the Vercel dashboard bend down over the next 2–3 days post-deploy.
**Result:** Built green. Pending deploy + multi-day CPU observation.

### [2026-06-17] Notes: grey header strip for the title section
**Status:** CHANGED (build-passed; live visual gated by login)
**File:** components/NotesBoard.tsx
**Changes:** Restructured the note card into header / body / footer. The header
(grip+pin row + title) now sits on a faint **grey strip** (`bg-slate-50` + `border-b`)
while the body stays white; card got `overflow-hidden` so the strip respects the
rounded corners. Replaced the prior title bottom-border with the strip.
**Test Method:** JSX nesting verified balanced; `npm run build` ✓ (`/notes` prerenders).
**Result:** Pending your visual check.

### [2026-06-17] Notes: divider between title header and body
**Status:** CHANGED (build-passed; live visual gated by login)
**File:** components/NotesBoard.tsx
**Changes:** Title input now has a bottom border (`border-b border-slate-200`,
`focus:border-blue-400`) + `pb-2 mb-2.5`, so the title reads as a distinct header
section separated from the note body. Applies in both preview and edit modes.
**Test Method:** `npm run build` ✓ (`/notes` prerenders). className-only change.
**Result:** Pending your visual check.

### [2026-06-17] Notes: uniform text size slider, fixed-height scroll, 3 cols
**Status:** CHANGED (tsc-clean + build-passed; live visual gated by login)
**Files:** components/NotesBoard.tsx, components/NoteMarkdown.tsx
**Changes:**
- Global **text-size slider** (12–26px, default 15) in the header — one uniform size
  applied to every note body + the editor; persisted per browser (localStorage
  `lumin:notes-fontsize`). Headings (`#`) now use em sizing so they scale with it.
- **Uniform fixed-height cards** (`h-[360px]`): the body region scrolls internally
  (`overflow-y-auto`) for long notes instead of the card growing. Edit textarea fills
  the same region and scrolls.
- **Back to 3 columns** (`xl:grid-cols-3`; removed the 4-col breakpoint).
- Edit is now via the pencil only (removed click-to-edit on the body so preview links
  don't fight the edit action).
**Test Method:** `npx tsc --noEmit` clean for changed files; `npm run build` ✓ —
`/notes` prerenders. Visual gated by login.
**Result:** Pending your visual check. Build + types green.

### [2026-06-17] Notes: search + drag-reorder + 4-col grid
**Status:** CHANGED (tsc-clean + build-passed; live visual gated by login)
**Files:** components/NotesBoard.tsx, app/api/notes/order/route.ts (NEW)
**Changes:**
- 4 columns on wide screens (`2xl:grid-cols-4`; 1/2/3 below).
- Search box in the header — filters by title + content (drag disabled while searching).
- Drag-to-reorder via @dnd-kit/sortable with a per-card grip handle. Order persisted
  in `sync_state` (key `notes_order`, an id array) through `/api/notes/order` (GET/POST,
  service client) — same shared, no-schema-change pattern as par-rates. Order self-heals
  on drift (deleted ids dropped, new notes appended).
- Pin now = mark + move the note to the front of the arrangement (persisted), replacing
  the old pinned-float sort.
**Test Method:** `npx tsc --noEmit` clean for changed files; `npm run build` ✓ —
`/notes` prerenders, `/api/notes/order` registered. Visual gated by login.
**Result:** Pending your visual check. Build + types green.

### [2026-06-17] Notes: own /notes page + advanced markdown editor
**Status:** CHANGED (tsc-clean + build-passed; live visual gated by login)
**Files:** lib/noteMarkdown.ts (NEW), components/NoteMarkdown.tsx (NEW),
components/NotesBoard.tsx (NEW), app/notes/page.tsx (NEW), components/Sidebar.tsx,
components/Dashboard.tsx, components/DashboardNotes.tsx (DELETED)
**Changes:**
- Moved Notes off the Dashboard into a dedicated `/notes` page + sidebar nav item
  (Actions group). Removed the board + its import from the Dashboard.
- Advanced editor: markdown source where `# / ## / ###` set heading size (replaces
  the old S/M/L buttons), `**bold**`, `==highlight==` (highlighter toolbar button),
  `- ` bullets, autolinks. Toolbar: H1/H2/H3 / Bold / Highlight / Bullet.
- Note cards are now **white** with the color shown as a left-accent border (color
  picker retained as an accent only).
- Rendering uses React elements (`NoteMarkdown.tsx`), not raw HTML strings, so user
  text is escaped by React. Legacy contentEditable notes are converted to markdown on
  load (`htmlToMarkdown`, text-preserving) — non-destructive, only persisted when the
  user next saves that note.
**Test Method:** `npx tsc --noEmit` clean for all changed/new files; `npm run build`
✓ — `/notes` prerenders, no dangling references to the old component. Visual gated by login.
**Result:** Pending your visual check. Build + types green.

### [2026-06-17] Unread: collapsible Dashboard section
**Status:** CHANGED (tsc-clean + build-passed; live visual gated by login)
**File:** components/UnreadInbox.tsx
**Changes:** Header is now a toggle button (chevron) that collapses/expands the list.
Collapse is a persisted UI pref (`localStorage` key `lumin:unread-collapsed`), read
once post-mount to avoid hydration mismatch. Counts stay live in the header when
collapsed (collapse never affects fetching/cache). Header bottom-border drops when
collapsed so the card reads as a clean single bar.
**Test Method:** read render block — `{!collapsed && (…)}` wrap balanced; `<h3>`→`<span>`
inside the button to avoid invalid nesting. `npx tsc --noEmit` UnreadInbox-clean;
`npm run build` ✓ (`/` prerenders).
**Result:** Pending your visual check. Build + types green.

### [2026-06-17] Unread: drop lazy-load, cache TTL 2→15 min
**Status:** CHANGED (tsc-clean + build-passed; live visual gated by login)
**File:** components/UnreadInbox.tsx
**Issue:** The inbox sits high on the Dashboard (in view on load), so the lazy
IntersectionObserver fired immediately and bought nothing — the sessionStorage
cache is the actual throttle, not the observer.
**Changes:** Removed the IntersectionObserver + its `loadedRef`/`rootRef`/`useRef`
(mount now: serve fresh cache, else fetch once). Raised `UNREAD_TTL_MS` 2min → 15min.
Net call pattern: ≤1 GHL call per 15-min window per tab; same-tab reloads + in-app
nav back to "/" within the window reuse the cache (no call); Refresh always live.
**Test Method:** grep confirms no lingering `loadedRef`/`rootRef`/`IntersectionObserver`;
`npx tsc --noEmit` UnreadInbox-clean; `npm run build` ✓ (`/` prerenders).
**Result:** Pending your visual check. Build + types green.

### [2026-06-17] Unread: true move to Dashboard + call-volume guard (A+B)
**Status:** CHANGED (tsc-clean + build-passed; live visual gated by login)
**Files:** components/UnreadInbox.tsx, components/Dashboard.tsx, app/unread/page.tsx (DELETED)
**Issue:** Prior step embedded the inbox on the Dashboard but kept `/unread` alive,
so (1) it wasn't a true "move" (two mount points) and (2) the inbox hit
`/api/ghl/unread` on every dashboard load (the landing page).
**Changes:**
- **A (true move):** deleted the `/unread` page route (`app/unread/page.tsx`). The
  inbox now lives only as the Dashboard card. `UnreadInbox` simplified to embedded-
  only (dropped the `embedded` prop + full-page branch). `/api/ghl/unread` endpoint
  untouched. No nav links pointed at `/unread` (grep-verified before delete).
- **B (call-volume guard):** sessionStorage cache (key `lumin:unread-cache:v1`, TTL
  2 min) — a remount/return-to-dashboard within the window reuses the cached result
  with NO GHL call. First load per window fetches lazily via IntersectionObserver
  (only when the section nears the viewport, 300px margin), so an ignored dashboard
  makes zero calls. The Refresh button always pulls live + rewrites cache; mark-read/
  reply keep the cache in sync.
**Test Method:** `npx tsc --noEmit` clean for changed files (only the standing
pre-existing set remains; the transient `.next` validator error for the deleted route
cleared after rebuild). `npm run build` ✓ — `/` prerenders, `/api/ghl/unread` retained,
`/unread` page route gone from the manifest. Visual gated by login.
**Result:** Pending your visual check. Build + types green.

### [2026-06-17] Funded columns + Unread→Dashboard move
**Status:** CHANGED (tsc-clean + build-passed; live visual gated by login)
**Files:** components/FundedTracker.tsx, components/UnreadInbox.tsx (NEW),
app/unread/page.tsx, components/Dashboard.tsx, components/Sidebar.tsx
**Changes:**
1. Funded list — added 3 sortable columns: **Location** (city, state), **Source**
   (`cleanSource`), **Rate** (`formatPercent`). All three also added to the search
   haystack and the CSV export (City/State/Source/Rate). Header order verified to
   match cell order (11 data cols + checkbox).
2. Unread Messages — extracted the `/unread` page into a reusable `UnreadInbox`
   component with an `embedded` prop. Dashboard (`components/Dashboard.tsx`) renders
   `<UnreadInbox embedded />` as a card section (after the Today widget). `/unread`
   route kept as a thin wrapper (`<UnreadInbox />`) for bookmarks. Reply composer /
   AI draft / mark-read all preserved.
3. Sidebar — removed the "Unread Messages" nav item + its now-unused `Inbox` import.
**Test Method:** `npx tsc --noEmit` (all changed files clean; only the standing
pre-existing set remains). `npm run build` ✓ — `/`, `/funded`, `/unread` all
prerender. Visual gated by Supabase login — please confirm on prod after login:
Funded shows the 3 new columns + sorts; Dashboard shows the Unread section; the
sidebar no longer lists Unread Messages.
**Result:** Pending your visual check. Build + types green.

### [2026-06-17] File: components/FundedTracker.tsx + app/funded/page.tsx
**Status:** CHANGED (tsc-clean + build-passed; live visual gated by login)
**Issue:** Funded tab was a drag-and-drop kanban (3 columns: Loan Funded / Broker
Check Received / Loan Finalized). Wanted a list view with more columns + filtering.
**Changes:** Rewrote `FundedTracker` from a dnd-kit kanban into a sortable, filterable
table modeled on the Contacts list (`SortTh`, zebra rows, stats strip, bulk-select →
Copy emails / Export CSV). Columns: Borrower (+property sub-line, GHL/Arive links) ·
LO · Stage · Type (+investor) · Loan amount · Comp · Funded · Paid — all sortable
(default Funded ↓). Filters: search, stage tabs w/ counts, LO dropdown, loan-type
dropdown. Kanban's stage-advance preserved as an inline `StageSelect` per row (still
calls `onUpdate` → `pushStageToGHL`). Simplified `app/funded/page.tsx` to a thin shell
(fetch + title + refresh + New Deal); all filters/stats moved into the tracker.
Removed dnd-kit usage from this file (still used elsewhere).
**Test Method:** `npx tsc --noEmit` (changed files clean; only the standing pre-existing
set remains: reports, underwriting, DealForm, next.config). `npm run build` ✓ — `/funded`
compiles + prerenders. Live table render needs a Supabase login (middleware redirects
`/funded` → `/login`), which I can't perform — please verify visually at
`localhost:3000/funded` after `npm run dev`: sort each column, the stage tabs/LO/type
filters, search, change a row's stage (confirm GHL push), and Export CSV on a selection.
**Result:** Shipped — commit `73beb70`, deployed to prod 2026-06-17
(`lumin-deals.vercel.app`, dpl_2Wm2W56SAKfBYfr31Sp5AE7ER7xq, READY). Route serving
(`/funded` → 307 → login). Build + types green. Visual pending your login.

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

### [2026-06-16] Feature: read-only Details panel on the person page (Contacts Phase 3.2)
**Status:** CHANGED (tsc + build clean) — pending deploy
**Issue:** Efrain wants more read-only info on `/contacts/[id]` (loves Loans + Activity), incl. ALL
contact points in the body, not just the one line under the name.
**Changes:** `app/contacts/[id]/page.tsx` — new "Details" panel above Loans with 4 groups:
**Contact** (all distinct emails + phones across the loans, dedup'd), **Profile** (location,
purpose, occupancy + property type, value · LTV, credit *rating* bucket, veteran/VA), **Source &
cost** (lead source, LO(s), Σ lead_price acquisition cost + funded return), **Reachability** (DND,
last contact + channel, last inbound). All derived from the already-fetched deals (`buildDetails`),
read-only. `reachability` extended for comm type + inbound. Added shared `cleanSource` to
`lib/utils` (filters Arive + Unknown) and used it on both the list sub-line and the panel source.
Skipped the Opportunity tier per Efrain. Spec/probe basis: lead_price ~90% on leads, credit_rating
84–90% (FICO only ~10%), loan_type funded-only — so the panel leans on the populated fields.
**Test Method:** `npx tsc --noEmit` (3 changed files clean; error set = 4 pre-existing); `npm run
build` (✓ both `/contacts` routes). Mockup shown for sign-off.
**Result:** Type-clean, build READY. Not browser-verified here (auth wall). **Deployed** commit
`1d0b41e` → prod READY (dpl_qdtbnj292), 2026-06-16.

### [2026-06-16] Feature: contacts list command center + source lens (Contacts Phase 3.3)
**Status:** CHANGED (tsc + build clean) — pending deploy
**Issue:** Efrain — make the list a working tool. Picked "List command center" + "Source lens" from
the suggestions (skipped tags / opportunity flags this round).
**Changes:** `app/contacts/page.tsx` — (1) **book-of-business stats strip** (people · funded clients
· funded volume · comp · lead spend) that reflects the live filters; (2) **sortable columns** (Name,
Loans, Funded, Funded volume, Comp, Cost) via a `SortTh` header + `sorted` memo, default = existing
last-activity order; (3) a new **Cost** column = Σ `lead_price` per person (added `leadCost` to the
per-person `DealMeta`, fetched `lead_price` in the slim deal projection); (4) **Source dropdown**
filter over the 16 clean lead vendors (`sourceOptions` by frequency); (5) **Export selected → CSV**
in the bulk bar (Blob download, no backend) alongside Copy emails. Selection now operates on the
sorted/visible set.
**Test Method:** `npx tsc --noEmit` (contacts page clean; error set = 4 pre-existing); `npm run
build` (✓ `/contacts`). Mockup shown for sign-off.
**Result:** Type-clean, build READY. Not browser-verified here (auth wall). **Deployed** commit
`4893596` → prod READY (dpl_camrrr9hn), 2026-06-16. Data basis (probe): 16 sources (FRU 419,
Lendgo 344, LMB 250…), total lead spend $37,412, 141 funded clients.

### [2026-06-16] Feature: Refi Radar — dedicated /radar page (Opportunity Radar v1)
**Status:** CHANGED (tsc + build + 12 fixtures pass) — pending deploy
**Issue:** Surface "who to call to refi/consolidate, and why" from the funded book. Cross-tab killed
the naïve "rate > par" idea: the high-rate book is HELOCs (59, avg 9.60%; 28/30 ≥9% loans are
HELOCs), firsts mostly closed well (Conv 6.23/FHA 5.64/VA 5.75), and 65/148 funded are <6mo.
**Changes:** `lib/refiRadar.ts` — pure, dependency-free product-segmented scorer (`classify` /
`scoreFundedBook`): plays = second-lien (HELOC/HELOAN ≥8.5%), first-lien (Conv ≥ conv par +0.5%),
non-qm season-out, fha-mip (≤80% LTV or streamline), va-irrrl; seasoning gate 6mo (eligible vs
maturing); $-ranked by delta×balance; equity plays flag "needs equity" when balance unknown; loans
with no rate skipped; par rates user-set (no live rate in DB). `app/radar/page.tsx` — funded-deal
load + par config bar (editable, persisted), play filter tabs, ranked table (client→person link,
play badge, reason, seasoned, est $/mo or "needs equity", DND/last-contact, comp). `app/api/radar/
par-rates/route.ts` — GET/POST `sync_state` key `refi_par_rates` (service client; mirrors dedupe
dismiss). Sidebar nav link ("Refi Radar"). Started with the no-equity plays per Efrain.
**Test Method:** `scripts/refi-radar-check.ts` — 12 fixtures (seasoning, per-product triggers,
net-benefit threshold, no-rate skip, funded-only, ranking) compiled via tsc→/tmp + node: ALL PASS.
`npx tsc --noEmit` (new files clean; error set = 4 pre-existing). `npm run build` (✓ `/radar` +
`/api/radar/par-rates`). Output matches the approved mockup. No RLS step (reads `deals`; par via API).
**Result:** Type-clean, build READY, fixtures green. Not browser-verified here (auth wall).
**Deployed** commit `3e66097` → prod READY (dpl_3ojxnj1fo), 2026-06-16.

### [2026-06-16] Policy: auto-deploy verified changes (no per-deploy ask)
Efrain: "make it a rule that you ALWAYS deploy new changes — I don't want to tell you every time."
Set as a standing instruction in `CLAUDE.md` → "Deploy policy" + vault memory
`project_lumin_deploy_policy`. Default now: verify (tsc + build + tests) → `vercel --prod --yes` →
report; only pause for (1) manual SQL/RLS migrations, (2) destructive/irreversible changes, (3) an
explicit "don't deploy yet." Not a hook (a hook can't tell verified from mid-edit).
**REVERTED same day** — Efrain: "actually lets get rid of the auto deploy, let me confirm before
deploying." Policy is now: **always confirm before `vercel --prod`.** CLAUDE.md + vault memory
updated to match.

### [2026-06-16] Tweak: roomier par-rate config bar on /radar
**Status:** CHANGED (tsc + build clean) — pending deploy (awaiting confirm)
**Issue:** Efrain — the par-rate bar was cramped (label + 4 inputs + Save jammed on one line).
**Changes:** `app/radar/page.tsx` — par config is now a `p-4` card: header row (label + one-line
hint + Save), then the four rate fields stacked (label above input), bigger inputs (`py-2`, w-24),
spaced `gap-x-10 gap-y-4`.
**Test Method:** `npx tsc --noEmit` (radar page clean); `npm run build` (✓ `/radar`). Mockup shown.
**Result:** Type-clean, build READY. **Deployed** commit `c39b389` → prod (dpl_6ijpx8gef), 2026-06-16.
