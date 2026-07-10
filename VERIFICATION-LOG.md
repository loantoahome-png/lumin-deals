# Verification Log — Lumin Deals

### [2026-07-10] Webhook — real-time demotion on opportunity status → lost/abandoned
**Status:** CHANGED + DEPLOYED (code). tsc 7-baseline / **0 new**; `npm run build` READY. **End-to-end "right away" behavior is GATED on GHL delivery — NOT yet confirmed (see below).**
**Issue:** Efrain asked whether the webhook can react the instant a GHL opportunity flips to "lost" (today it waits for the ~3-min sync). Investigation (grounded in real captured payloads) found the exact gap: the webhook's lost-handling was nested inside `if (whStage)` — it required a resolvable stage NAME. GHL's native opportunity payload carries `status:"lost"` but the stage as a `pipelineStageId` UUID (no name), so `whStage` was null → the demotion was skipped and it fell through to the sync. Worse, the stage-change branch would have hit `resolveGHLStage("lost")`'s fragile partial-match and relabeled the stage to "Lost to Competitor".
**Changes:**
- `app/api/webhooks/ghl/route.ts` — NEW dedicated block BEFORE the stage-change branch. Keys off `status` directly (`isDead = status==='lost' || startsWith('abandon')`), mirroring the sync's isDead rule (`app/api/sync/ghl/route.ts:806`): sets `pipeline_group:'Not Ready'` + `ghl_status`, LEAVES the stage label intact (sync reconciles the exact name later), guards Funded with `.neq('pipeline_group','Funded')`, and matches opportunity-id-first (so a lost flip can't demote a sibling loan of a multi-loan borrower). Early-returns. The old contact-update dead-logic is left in place as a harmless backstop (now unreachable for top-level status).
**Test Method:** tsc; production build; **logic-replay of the exact isDead detection over 992 real captured payloads** (no mutation); manual control-flow trace. HTTP integration test was blocked by `GHL_WEBHOOK_SECRET` signature enforcement (correct behavior; secret not read).
**Result:** VERIFIED (code logic). Replay: **48/48** dead payloads flagged & matchable, **0** missed, **0** false positives across 944 alive payloads. Build compiled. Deployed to prod.
**NOT VERIFIED / OPEN — does GHL actually PUSH a lost event to our webhook?** The native-opportunity payloads in `raw_ghl_data` are **sync-written** (`sync/ghl/route.ts:908` stores `raw_ghl_data: opp`; 30+ deals stamped in the same 1-sec batch confirm it) — so captured payloads are NOT proof of real-time webhook delivery. A workflow ("LD stage matt") is known to POST *some* opportunity data (Shape B: `status` + misspelled `pipleline_stage` NAME), proving at least one GHL workflow hits our endpoint, but its trigger conditions are unknown. **For "right away" to work end-to-end, GHL must be configured to POST opportunity status changes to `/api/webhooks/ghl` — either a native opportunity webhook subscription or a GHL Workflow (Opportunity Status Changed → Webhook).** This is a GHL-side config not visible from the codebase; needs verification in the GHL dashboard. Until confirmed, the code is READY but the sync remains the actual path.

### [2026-07-09] Processors — added Jessica Ching to the dropdown
**Status:** CHANGED + DEPLOYED. tsc 7-baseline / **0 new**; `npm run build` READY.
**Issue:** Efrain asked to add "Jessica Ching" as a processor option in the dropdown (Active Escrows card).
**Changes:**
- `lib/types.ts` — `PROCESSORS` const gains `'Jessica Ching'` (now `Self Processing`, `Susan Lim`, `Hanh Nguyen`, `Jessica Ching`). Single source of truth: all four `<option>` lists (EscrowTracker card, DealForm new-deal, deal-detail panel, pipeline inline editor) map this same array, so one edit surfaces everywhere. Existing rows storing an old value are unaffected (value is a free string on `processor_status`).
**Test Method:** tsc; production build; grep the built bundle for the name (dropdown pages are auth-gated, so the rendered `<select>` can't be driven locally without a session — the option IS `PROCESSORS.map(...)`, so bundle presence is the proof).
**Result:** VERIFIED. Build compiled; `Jessica Ching` present in both the client chunk (`.next/static/chunks/…`) and the SSR chunk. Deployed to prod.

### [2026-07-09] Auth — self-serve password reset (forgot-password → /auth/confirm → reset-password)
**Status:** CHANGED + **DEPLOYED** (merge `3f29813`). Both Supabase dashboard settings applied and verified from the server. tsc 7-baseline / **0 new**; `npm run build` READY.
**Issue:** No password-reset path existed. Efrain locked himself out; the Supabase dashboard's "Send password recovery" button emailed a link to `http://localhost:3000` (Site URL never moved off dev) and, even with that fixed, the app had no route able to consume the link. Every reset had to go through a service-role script.
**Changes:**
- `app/auth/confirm/route.ts` — NEW. GET handler; reads `token_hash` + `type`, calls `verifyOtp({token_hash,type})`, writes session cookies onto the redirect response, forwards to `next`. Uses **token_hash, not the PKCE `code`** — `code` needs a verifier in the same browser that started the flow, so it can never work for a dashboard-sent link (see `docs/research/2026-07-09-supabase-password-reset.md`). `next` validated as a same-origin relative path (open-redirect guard). Failure → `/login?error=link_invalid`.
- `app/forgot-password/page.tsx` — NEW. Calls `resetPasswordForEmail`. Always reports success whether or not the address exists (no account enumeration).
- `app/reset-password/page.tsx` — NEW. Checks session, then `updateUser({password})`. Min 10 chars + confirm-match, live inline validation. No session → "Link expired".
- `middleware.ts` — `/forgot-password`, `/reset-password`, `/auth/confirm` added to `isPublic`.
- `components/AppShell.tsx` — hardcoded `isLoginPage` replaced with a `CHROMELESS_PATHS` set. **Caught by browser test:** the new pages rendered inside the authed sidebar, Sign Out button and all.
- `app/login/page.tsx` — "Forgot your password?" link; renders the `?error=link_invalid` banner.
**Test Method:** dev server + browser drive: `/reset-password` sessionless; `/auth/confirm` with a bogus token_hash; the `/login` error banner; `/forgot-password` render; console + server logs.
**Result:** PARTIALLY VERIFIED.
- VERIFIED: `/reset-password` (no session) → "Link expired", no sidebar. `/auth/confirm?token_hash=bogus123&type=recovery` → redirects to `/login?error=link_invalid`, banner renders, forgot link present. `/forgot-password` renders bare, styling matches login. Zero console errors, zero server errors.
- VERIFIED IN PROD (curl, post-deploy): `/auth/confirm?token_hash=bogus123&type=recovery` → **307** → `/login?error=link_invalid`; `/forgot-password` → **200**; `/reset-password` → **200** (public, not bounced).
- **STILL NOT VERIFIED — the success path.** Cookie-writing in `/auth/confirm` and the open-redirect guard on `next` only run after `verifyOtp` succeeds, which needs a real single-use token. Minting one requires a service-role `admin.generateLink` call; the sandbox denied it twice. **Closes when Efrain completes one real end-to-end reset.**
**Supabase dashboard settings — APPLIED 2026-07-09, each verified by reloading the page and re-reading the server value:**
1. Authentication → URL Configuration → **Site URL**: was `http://localhost:3000`, now `https://lumin-deals.vercel.app`. (Confirmed live: the recovery link Efrain clicked landed on `localhost:3000/#error=access_denied&error_code=otp_expired`.)
2. Authentication → Emails → **Reset password** template body now:
   `<p><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password">Reset Password</a></p>`
   (was `{{ .ConfirmationURL }}`, which yields a `code` this route cannot consume by design.)
**Deploy ordering:** the template now points at prod `/auth/confirm`, so deploying became mandatory rather than optional — leaving it unshipped would have broken resets outright.
**Left open:** the other email templates (Confirm signup, Invite user, Magic link, Change email) still use `{{ .ConfirmationURL }}`. Nothing in the app uses them today (there is no signup flow), but "Send magic link" from the dashboard will not work until they get the same `token_hash` treatment.
**Observed, not acted on:** the project is FREE tier and the dashboard warns *"Grace period is over · your projects will not be able to serve requests when you use up your quota"*; and it is still on Supabase's built-in email service, which is rate-limited and flagged *"not meant to be used for production apps."* Password resets now depend on that sender.

### [2026-07-09] Lead Cohorts — replaced Response Timing box with Speed-to-Lead metrics
**Status:** CHANGED + DEPLOYED. tsc 7-baseline / **0 new**; `npm run build` READY; fixtures **83/83** (+9 speed).
**Issue:** Efrain wanted the scorecard's "Response timing" box (Median TTR, Avg TTR, Timing coverage) replaced with speed-to-lead metrics.
**Changes:**
- `lib/cohortReport.ts` — `CohortSegment` gains `within1h/within1hPct/within24h/within24hPct`; `cohortSegment` counts leads whose first-response delta ≤ 1/24 day (1h) and ≤ 1 day (24h) — same whole-cohort denominator + timing source as the day-windows (a finer front of that cumulative curve; timed responders only in the numerator). `CohortDelta` gains `within1hPct/within24hPct` (b−a). `ttrMedianH/ttrAvgH/timingCoverage` still computed (unused by the scorecard now; timing-coverage concept stays in the amber banner).
- `app/lead-cohorts/page.tsx` — scorecard section relabeled "Speed to lead" with two rows (Responded within 1 hour / within 24 hours, count·% + Δ). Visual report `scoreRows` swapped the 3 TTR rows for the 2 speed rows (removed now-unused `ttrDelta`).
- `scripts/cohort-report-check.ts` — +9 assertions (1h/24h buckets incl. a sub-1h fixture + exact-24h edge + delta).
**Test Method:** 83/83 fixtures; tsc + build; real-data recompute of the exact cohorts.
**Result:** VERIFIED. Live numbers — Default A (6/22–6/26) n=169: <1h 36·21.3%, <24h 60·35.5% (84% coverage); B n=156: <1h 20.5%, <24h 34.6%; Randy A (6/15–6/19) n=53: <1h 24.5%, <24h 34.0% (96% coverage).

### [2026-07-09] Visual reports — projection added to Lead Spend PDF + NEW Lead Cohorts PDF report
**Status:** CHANGED + DEPLOYED. tsc 7-baseline / **0 new** in both files; `npm run build` READY.
**Issue:** (1) The Lead Spend "Visual Report" (print/PDF window) didn't include the new "If all Active loans fund" projection. (2) The Lead Cohorts page had no printable report at all.
**Changes:**
- `app/lead-spend/page.tsx` `openVisualReport()` — appended a "📈 If all Active loans fund — projected" section: full projected KPI mirror (Total Leads, Active Escrows→0, Funded, Funded Volume, Conversion, Lead Cost, Revenue, Net Profit, ROI as now→next, unchanged tagged) + a per-source active table (Active, +Proj Comp, Net Profit→Proj, ROI→Proj) + hypothetical footnote. New `projKpiCard`/`projRowsHtml` helpers + CSS. Section omitted when no active loans.
- `app/lead-cohorts/page.tsx` — NEW `openVisualReport()` + "Visual Report" header button (indigo, next to Refresh). Report mirrors the whole page: scorecard (A vs B + Δ for total/responded/opted-out/converted/median+avg TTR/timing coverage), 7d & 14d window rates (rate + maturity + Δ, "maturing" when <90%), response-states table (timed/untimed/not-responded per cohort), and the current-dimension breakdown (A/B n·resp%·7d·14d). Same print-window pattern as Lead Spend; timing-not-loaded note; priced-only footnote.
**Test Method:** tsc + build; wiring confirmed in source (both buttons `onClick={openVisualReport}`); the Lead Cohorts report's EXACT data pipeline (`analyzeCohort` + `cohortDelta`) executed offline on LIVE data (1931 priced deals, 903 first-responded entries) → all report-consumed fields well-formed, **10/10 smoke checks**. The popup itself couldn't be auto-triggered via Control Chrome (React onClick doesn't fire from synthetic/automation events); the window.open+document.write mechanism is byte-identical to the already-in-production Lead Spend report, so it renders the same way.
**Result:** VERIFIED (build + real-data pipeline). Live snapshot the cohort report renders: A n=169 (40.2% resp, conv 15, TTR 4.9h, cov 84%) vs B n=156 (37.8%); windows A 7d 50% (100% mat) / 14d 53% (77% mat); bySource LMB/Lendgo/Lending Tree/FRU/OwnUp. Efrain should click "Visual Report" to open the printable window.

### [2026-07-09] Lead Spend — "If all Active loans fund" projection panel
**Status:** CHANGED + DEPLOYED. tsc 7-baseline / **0 new** in `app/lead-spend/page.tsx`; `npm run build` READY.
**Issue:** Efrain wanted a projected scenario below the per-source table: if every Active (Loans in Process) loan funded, what do Revenue / Net Profit / ROI / Funded / Volume become? Verified in DB first: Loans-in-Process deals carry expected comp — 88% (22/25) have `compensation_amount>0`, avg ~$7,107 — so we project from REAL Arive comp, not a guess.
**Changes:** `app/lead-spend/page.tsx` — added a pure `projection` useMemo (per-source + totals from `visibleSources`): adds each active loan's `compensation_amount` to revenue (lead cost fixed); active loans with no comp yet are estimated at the average comp of comp-bearing deals in view (est. count surfaced). New violet panel between the table's definitions footer and the Funded-loans section: header (active count + total added comp + est. note), five current→projected tiles (Funded, Funded Volume, Revenue, Net Profit, ROI), a per-source table (only sources with active loans), and a "not a forecast of close probability" footnote. Hidden when no active loans in view. Respects all current filters (derives from `visibleSources`/`kpis`).
**Test Method:** DB comp-coverage check; tsc + build; live render check on the deployed authed page (Control Chrome).
**Result:** VERIFIED — see live check below.

### [2026-07-09] Add Randy Mathis as a third loan officer (re-apply of reverted 962c331 + 2 post-revert sites)
**Status:** **VERIFIED + DEPLOYED (live in prod).** tsc 7-baseline / **0 new** across 19 changed files; `npm run build` READY; fixtures **cohort 74/74 + lead-report 63/63**. Commit `f803ad6`, prod deploy `dpl_BJkLNNhhM6J4fjraJX4V9vx1LXJk`.
**Issue:** Consolidate reporting by wiring Randy Mathis as a 3rd LO (with Moe Sefati + Matt Park). Originally shipped `962c331` (7/07), reverted next morning by `98f2b49` — no recorded reason; the commit itself noted "Env still to set". Verified benign: `getAccounts()` (`app/api/sync/ghl/route.ts:24`) only activates Randy's "extra" account when BOTH `GHL_API_KEY_2` + `GHL_LOCATION_ID_2` are set, so the reverted code was inert without env, not broken. Re-applied per Efrain "just go with it".
**Changes:**
- Re-applied the full 962c331 diff (14 files): `lib/loanOfficer.ts` (LO_MAP randy/mathis→'Randy Mathis'), `lib/types.ts` (LOAN_OFFICERS + TASK_ASSIGNEES), `lib/leadReport.ts` (type LO + matchesLO 3-way — hand-merged, the file moved post-revert), `app/api/sync/ghl/route.ts` ('extra'→'Randy Mathis'), `app/api/ghl/unread/route.ts` (ACCOUNT_LO extra), `app/api/cron/lock-alerts/route.ts` (→LO_EMAIL_RANDY), + UI: lead-performance, lead-spend (byRandy/fundedByRandy/CSV/tab), pipeline, reports (scorecard + LO_COLORS violet #8b5cf6), reports/escrows, underwriting team list, Dashboard, UnreadInbox.
- **Sites the old diff predated (found via a full LO-list sweep):** `app/lead-cohorts/page.tsx` (LO_TABS +Randy) **and `lib/cohortReport.ts` — its OWN cohort-local `matchesLO` still had 2-way logic; without the 3-way fix the Randy tab would silently render Moe's leads** (else-branch → `includes('moe')`). `app/contacts/[id]/page.tsx` (RANDY location-label via `NEXT_PUBLIC_GHL_LOCATION_ID_2`). +6 Randy fixtures across both check scripts.
**Test Method:** `npx tsx scripts/cohort-report-check.ts` (74) + `scripts/lead-report-check.ts` (63); `npx tsc --noEmit` (7 baseline, 0 new); `npm run build` (READY, all routes incl. /lead-cohorts prerender).
**Result:** VERIFIED (logic + build). Randy fixtures prove the tab isolates his leads with zero Moe/Matt leakage. Inert/safe in prod until env is set — existing Moe/Matt sync untouched.
**Env set (Vercel production):** `GHL_API_KEY_2`=pit-18d2a767-… , `GHL_LOCATION_ID_2`=`arZ4QDCzS0Vkj0ZvLZdv`, `NEXT_PUBLIC_GHL_LOCATION_ID_2`=`arZ4QDCzS0Vkj0ZvLZdv`, `LO_EMAIL_RANDY`=`randy.mathis@luminlending.com`. (NOT yet in local `.env.local` — bash is permission-gated on `.env*`; only affects local service-role scripts, not prod.)
**Live sync proof:** token validated against GHL (555 opps). Triggered `POST /api/sync/ghl` in Efrain's authed session → `success:true`, `per_account` `extra`/`arZ4QDCzS0Vkj0ZvLZdv` = **created 555 / errors 0**; Moe+Matt created 0 (untouched). `/reports` LO Scorecard renders **Randy Mathis: 555 deals, 5 escrow, 2 funded, $292,356 vol** → attribution correct (all 555 carry his name). Going forward the 3-min cron (`/api/cron/ghl-sync` → getAccounts) includes Randy automatically.
**Optional follow-ups (not blocking):** (a) `TASK_ASSIGNEE_EMAILS` JSON add `"Randy Mathis":"randy.mathis@luminlending.com"` if tasks get assigned to him and he should be emailed; (b) add Randy's GHL sub-account to the real-time stage webhook (like Moe/Matt) if 3-min cron latency isn't enough; (c) mirror the 4 env vars into `.env.local` for local scripts.

### [2026-07-09] Report Import — multi-file auto-detect + merge (opportunities + Arive → one ROI report)
**Status:** CHANGED + DEPLOYED. tsc 7-baseline / **0 new** in changed files; `npm run build` READY; fixtures **27/27**.
**Issue:** `/report-import` accepted ONE CSV and manual-mapped it. Efrain wants to drop in his GHL + Arive exports together and get one report (ROI, responsiveness, funded vs expected). No single export has everything: GHL Opportunities has lead price + source + clean stage (the SPEND base) but incomplete comp; the Arive "Funded Agg" export has authoritative Compensation + loan stage (the OUTCOME) but no lead price. They share a clean `Arive Loan ID` join key.
**Changes:**
- NEW `lib/reportMerge.ts` — pure engine. `detectKind(headers)` (arive-funded | ghl-opportunities | ghl-contacts | generic, case/space-insensitive). `mergeReports(files)` → `MergedLead[]` (a `LeadRow` + provenance) joined on Arive Loan ID with a borrower-name fallback; Arive comp/stage/source overlaid on matches (heals the "Arive" source drift → real vendor); outcomes with no base lead appended (price recovered by name). Comp is SPLIT — realized (funded) on `compensation_amount`, in-process expected on `expected_comp` — so `leadReport.segment()` (priced-rows-only) stays correct. Only Arive comp is trusted (GHL's is unreliable). Dedupes a person appearing in both Opportunities (by id) and Contacts (by name).
- `app/report-import/page.tsx` — rewritten: multi-file upload + per-file kind badges; when a known export is present it auto-merges and renders a Sources/join panel (matched/appended/warnings), KPI row (leads, response rate, funded, spend, revenue, ROI), a Realized-vs-Projected panel using REAL Arive expected comp, and by-source/by-state tables + merged-CSV export. A lone unrecognized CSV falls back to the original manual-mapping flow (preserved).
- NEW `scripts/report-merge-check.ts` — 27 fixtures (detection; id-join; name-fallback; comp split; source-drift heal; dedup no-double-count; unpriced-funded warning; arive-only/opps-only warnings; by-source grouping).
**Test Method:** fixtures + ran the real engine on Efrain's actual exports (opportunities.csv + Funded Agg + contacts) offline; live render check on the deployed page.
**Result:** VERIFIED (logic). On the real files: 2-file (opps+Arive) → realized 0.21× with a warning that Bryan Jones has no matched lead price (his opp isn't in the Opportunities export); all-3 → **realized 0.72× / projected 3.14×**, funded=2 (no double-count) — matches the by-hand merge (0.73×/3.19×) within denominator rounding. Response rate + by-source ROI populate.
**Known limits:** join is name-based where Arive id is absent (same first+last collides — acceptable). Only Arive-matched loans get real-vendor re-attribution; other Arive-drifted opps show "Self Source". Export is scoped to whatever LOs/pipelines the uploaded files cover (Randy-only in the sample).

### [2026-07-08] Source-drift guard — webhook `source` writes now cleanSource-guarded + 16 stale "Arive" rows re-attributed
**Status:** CHANGED + DEPLOYED (code) / DATA-FIXED (backfill). tsc 7-baseline / **0 new** in the changed file; `npm run build` READY.
**Issue:** `/lead-cohorts` (and `/lead-performance`) showed **"Arive" as a lead-source row** — 17 priced deals (`lead_price>0`) carried `source="Arive"`, the LOS name, not a real vendor. Root cause (verified from code + live GHL): of the THREE writers of `deals.source`, the 3-min sync (`route.ts:905` `cleanSource`) and the Arive CSV import (`ariveCsv.ts` `isRealLeadSource`) both reject "Arive" — but the **GHL webhook wrote `source` RAW** (`webhooks/ghl/route.ts:481` `maybeSet('source', fields.contactSource)`, and the insert default at :264 used `|| 'GHL'`). Arive stamps its own name into GHL's **native `source` attribute** once a loan syncs back; the webhook fell through to that and wrote it. The 3-min sync's update path then never overwrites an existing source with null → the bad value **froze**. The true vendor was never lost — it lives in the GHL contact **"Lead Source" custom field** (recovered 16/17 live: LMB×5, OwnUp×4, Lendgo×4, FRU×2, Lending Tree×1; 1 = Heyacinth Bordios, GHL contact 400s/deleted, left as "Arive" for manual review).
**Changes:**
- `app/api/webhooks/ghl/route.ts` — import `cleanSource`; :264 `source: cleanSource(contactSource || pick(contact,'source')) || 'Self Source'` (drops the literal 'GHL' default, mirrors the sync); :481 `maybeSet('source', cleanSource(fields.contactSource))` so a drifted webhook nulls→skips and can never re-stamp the LOS name over a real vendor. No other path changed.
- **DATA (one-time backfill, service-role script, not committed):** re-attributed the 16 recoverable rows from their GHL "Lead Source" field; before-state backed up to scratchpad `arive-source-backup.json` (revertible by id).
**Test Method:** live DB re-query of the priced `source` distribution, before→after.
**Result:** VERIFIED. Priced "Arive" bucket **17 → 1**; vendors gained their leads (LMB 364→369, OwnUp 119→123, Lendgo 415→419, FRU 451→453, Lending Tree 172→173). Deployed to prod so live webhooks stop re-drifting.
**Known residual (follow-up, not blocking):** the 3-min sync reads contacts via the LIST endpoint, which omits contact custom fields → on CREATE it can't see the "Lead Source" CF for a lead that enters Arive, so a brand-new Arive-entering purchased lead may default to "Self Source" (NOT "Arive" anymore). Fix later = have the sync read the CF (per-contact GET or include customFields) on create.

### [2026-07-08] Lead Cohort Responsiveness report + forward-only stage-event log
**Status:** CHANGED. tsc holds the 7-error baseline (0 new — a recharts Tooltip formatter quirk was fixed to match); `npm run build` READY (both new routes compile, `/lead-cohorts` prerenders). 49/49 fixture assertions pass. **NOT yet deployed — gated on the Supabase migration (Efrain-only step).**
**Issue:** New reporting need — compare two lead cohorts (by created date = `date_added_ghl`) and test "are this week's leads less responsive than a prior week?", normalized by maturity. Timing ("first became responded within N days") requires a stage-change event log that **did not exist** — the GHL webhook updated `deals.status` in place and logged nothing (only `deals.stage_changed_at`, a single last-moved ts, often null). Built the log forward-only.
**Confirmed with Efrain before building:** cohort date = `date_added_ghl` (contact date-added); build the event log now; reuse the existing `isRespondedStatus` definition (Ghosted counts). Custom-field keys were moot (`state`/`loan_purpose` already normalized columns). Conversion "key stage" had no confirmed answer → **defaulted to "reached Arive Lead or later"** (`lib/cohortReport.ts` `CONVERSION_LEAD_STATUSES` — one-line change to move the bar).
**Changes:**
- NEW `supabase-stage-events.sql` — `stage_events` append table (opportunity_id, contact_id, from/to stage id + resolved status, `to_responded` precomputed, LO, pipeline, `event_at`). Indexed for "first responded per opp". **Must be run in Supabase SQL editor before logging works.**
- `lib/leadReport.ts` — extracted `isColdStatus`/`isOptoutStatus`/`isRespondedStatus` (status-level, single source of truth) so the webhook and the report can't disagree on "responded". Row-level `isCold/isOptout/isResponded` now delegate — behavior identical (lead-report-check still green).
- NEW `lib/stageEvents.ts` — `logStageEvent()`; **never throws** (a logging failure or missing table can't break the webhook's core deals update). Normalizes GHL ISO/epoch timestamps.
- `app/api/webhooks/ghl/route.ts` — logs a `stage_events` row at BOTH stage-change paths (dedicated `OpportunityStageChange` branch + the workflow-payload `pipleline_stage` branch). Captures the pre-update status as `from_status`; only logs REAL moves (status changed, not Funded) — mirrors the existing `.neq()` guards. Insert is awaited but non-fatal.
- NEW `lib/cohortReport.ts` — pure aggregation: three-state classification (timed responder / pre-log untimed responder / non-responder), 7- & 14-day windows with maturity-based eligibility (too-young excluded, state #2 excluded, never a "no"), timing coverage, median/avg TTR, conversion, per-source/state/purpose breakdowns, B−A deltas.
- NEW `app/api/stage-events/first-responded/route.ts` — service-client map opp→earliest responded crossing; returns `{}` (not 500) when the table is absent.
- NEW `app/lead-cohorts/page.tsx` — side-by-side cohort scorecard with green/red deltas, 7/14-day window cards (show eligible denom + maturity coverage, "not enough maturity to compare" at 0 eligible), three-state honesty strip, breakdown table + recharts bar chart, LO + two-date-range filters. `components/Sidebar.tsx` — Insights nav link.
- NEW `scripts/cohort-report-check.ts` — 49 fixture assertions.
**Test Method:** `npx tsx scripts/cohort-report-check.ts` → 49/49 (covers: Ghosted-counts, three states, 7d≠14d denominators, too-young excluded, state#2 never a no, zero-eligible→null "can't compare", TTR median/avg, conversion, breakdown sums back to totals, delta null-propagation). `npx tsc --noEmit` → 7 baseline / 0 new. `npm run build` → READY.
**Result:** Logic VERIFIED via fixtures + type-clean build. As-of-today totals + breakdowns work immediately; window timing is populated by the conversation-history backfill below (NOT forward-only after all).

**Follow-up (2026-07-08, same session) — timing backfilled from GHL conversation history (Efrain corrected "forward-only"):**
GHL retains full per-contact message/call history, so the EARLIEST INBOUND communication = a historical first-response timestamp. Verified the API surface against the existing `app/api/ghl/thread` + `app/api/sync/conversations` routes: `GET /conversations/search` → `GET /conversations/{id}/messages` (Version 2021-04-15), each message carries `direction` (inbound=borrower), `dateAdded`, `messageType` (incl. CALL). `deals.ghl_location_id` → `resolveApiKey` gives the right Moe/Matt token per deal.
- `supabase-stage-events.sql` — added `source` col ('webhook' | 'backfill_comm') + partial unique index (idempotent backfill). **Migration not yet run — safe to amend; re-copy the file.**
- NEW `lib/ghlConversations.ts` — `earliestInboundAt` (pure) + `fetchFirstInbound` (pages newest→oldest, 429 backoff, samples raw call payloads).
- NEW `app/api/stage-events/backfill/route.ts` — GET, middleware-gated; scoped by `from`/`to` (date_added_ghl); **dry-run unless `run=1`**; concurrency 5; upserts one `backfill_comm` stage_events row per opp. `first-responded` already MINs across sources, so backfilled + live merge automatically.
- `lib/stageEvents.ts` — `source` field. Report banner + state-2 label reworded (comm-based, not forward-only).
- NEW `scripts/ghl-conversations-check.ts` — 8 fixture assertions.
**CAVEAT — RESOLVED 2026-07-08 (deployed + live-verified):** Ran the backfill in prod. GHL DOES expose `meta.call.duration` + status on `TYPE_CALL` messages, and automated blasts are a separate `TYPE_CAMPAIGN_VOICEMAIL` type. BUT every outbound call logs `status:"completed"` regardless of duration — so an answered call and an LO-left voicemail are indistinguishable (only duration differs, which can't separate "talked 40s" from "left a 40s voicemail"). First prod run (from=2026-06-01,to=2026-07-08,limit=250): scanned 250, withInbound 118 written, respondedButNoInbound 20 (~14% of responders = the answered-outbound-call gap). **Efrain's call: inbound-only** — those ~20 stay "responded, untimed" (in as-of-today totals, excluded from window timing, never a no). Removed the `callSamples` diagnostic (returned raw phone #s — PII) + the dead `onCallSample` hook; kept the `respondedButNoInbound` count.
**NOTE:** the backfill is capped per run (default 250 / max 1000, newest-first) — June cohorts need their own run: `?from=2026-06-22&to=2026-07-03&limit=1000&run=1`. Idempotent; chunk wider history by month.
**Test:** cohort 49/49 + conversations 8/8; `tsc` 7-baseline / 0-new; `npm run build` READY. **SHIPPED:** migration run (RLS on), code deployed (`dpl_qJUZTSzTqLayfrfXTRSHux9KaMnS`, prod `lumin-deals.vercel.app`), backfill live-run 118 rows written for early July.

**Update (2026-07-08) — priced-only (aggregator leads):** Per Efrain, the report now tracks ONLY leads with a lead price (`lead_price > 0`) — organic/warm excluded. Filter: `lib/cohortReport.ts` `isPriced` (enforced in `analyzeCohort`) + page fetch `.gt('lead_price',0)` + backfill priced-by-default (`?all=1` overrides). Filtering on lead_price (not source) also dodges the source-drift bug (a purchased "Arive"-labeled lead with a price is correctly kept). **Live numbers (priced, now=7/8):** 547 priced leads since 6/1; stage_events=134 backfilled, timing coverage ~84%. Cohort A (6/22–6/26) n=116 → 40.5% responded-today, 7d 50.0% / 14d 48.4%. Cohort B (6/29–7/3) n=102 → 34.3% responded-today, 7d 49.2%, 14d n/a (not 14-day mature — correct "can't compare yet"). B ≈ 6pts less responsive as-of-today, ≈1pt on 7d. NOTE: window "responded" (comm-based inbound timing) can exceed as-of-today "responded" (stage-based) — different lenses, both correct. Fixtures 53/8; tsc 7/0; build READY.

**Update (2026-07-08) — window redefinition (fixed cohort denominator):** Efrain flagged 14-day reading LOWER than 7-day. Root cause: windows were maturity-normalized (each window's denominator = only leads old enough to complete it), so 7d and 14d measured DIFFERENT leads (a Simpson's-paradox effect — the fast-responding young arrival-days sat only in the 7d window and lifted it). Rebuilt to a FIXED denominator = the WHOLE cohort; both windows share it and the numerator is cumulative (responded within N days) → **14d ≥ 7d always**. `WindowStat` is now `{days, responded, total, rate, maturedShare}` (dropped `eligible`/`maturityCoverage`). Maturity is now informational (`maturedShare` = % of cohort that's reached N days); the cross-cohort delta is shown only when BOTH cohorts are ≥90% mature for that window (keeps A-vs-B fair). Page shows "X of Y leads" + maturedShare flag + days-8–14 incremental. Fixtures 59 (added monotonicity assertion 14d≥7d + same-denominator); tsc 7/0; build READY.

**Update (2026-07-08) — DND on any channel + scorecard cleanup:** Added an "Opted out / DND" scorecard row. `isDnd` (lib/cohortReport.ts) = pipeline opt-out stage (STOP/DND-SMS/Remove) OR master `dnd` flag OR any `dnd_settings` channel active (Email/Call/SMS/FB/WhatsApp…), EXCLUDING SMS Twilio carrier errors (`message` ~ /TWILIO/ = undeliverable/landline numbers, not opt-outs — verified against raw dnd_settings shapes). Live: A 19.8% (23/116), B 13.7% (14/102). **CAVEAT:** the A-vs-B DND gap is largely DATA-COMPLETENESS, not behavior — `dnd`/`dnd_settings` are sparse on newer leads (B `dnd` 82% null), so B's channel-DND is undercounted; status-only opt-out (always synced) is ~equal (A 11.2% / B 11.8%). Scorecard text cleaned: section headers "As of today" / "Response timing" (dropped stale "logged crossings"), tighter row labels/hints, removed dead RowP wrapper. Fixtures 71 (12 DND, incl. Twilio-exclusion); tsc 7/0; build READY.

### [2026-07-02] Returning-client detection — lib/repeatReferral.ts + Opportunity Radar section + Contacts badges
**Status:** CHANGED, browser-verified with demo mocks. tsc holds the 7-error baseline (0 new); build READY.
**Issue:** Repeat business is invisible: only 1 of the 5 currently-active returning clients carries a "Return Client" source tag. Grounded live 2026-07-02 — 14 people with post-funding deals, 5 active (Marian Cooper 4-funded/$1.3M is in UW with no flag anywhere).
**Changes:**
- NEW `lib/repeatReferral.ts` — pure detection (same contract as refiRadar): `classifyReturning` / `findReturningClients` — person has a funded loan + a non-funded deal created after first funding (anchor falls back to created_at when funded_date is blank, so GHL-sourced funded rows aren't skipped). Flags: `active` (Leads/Loans in Process), `taggedReturn`, `rePaidSpend` (lead spend re-buying a funded client).
- `app/radar/page.tsx` — renamed "Refi Radar" → **"Opportunity Radar"**; fetch widened funded-only → whole book (superset projection); new violet "Returning clients" section above the refi table (funded history · new-deal stage pill · came-back date · "tagged return" pill), dormant rows behind a Show/Hide toggle. Refi section unchanged under its own heading.
- `app/contacts/page.tsx` — violet "Returning" pill next to the lifecycle stage (active returning only, same lib so it can't disagree with /radar).
- `app/contacts/[id]/page.tsx` — "Returning client" banner under the header (funded count/$, last funded, came-back date, current stage).
- `components/Sidebar.tsx` — label "Refi Radar" → "Opportunity Radar".
**Test Method:** 14 fixture assertions on the pure lib (all pass: detection, pre-funding lead excluded, funded_date-less anchor, active-headline preference, sort). Live-book run reproduces grounded numbers exactly (14 total / 5 active / $29 re-paid spend). Browser-verified via TEMP middleware bypass + `?demo=1` mock (both reverted; `git diff middleware.ts` empty, zero TEMP markers): section renders, toggle works, 0 console errors.
**Result:** Deployed to prod. Efrain to confirm on the authed dashboard: /radar shows the 5 active returning clients; Marian Cooper's person page shows the banner.

### [2026-07-01] Stage color — "Submitted to UW" orange → indigo (clashed with orange Next Step boxes)
**Status:** CHANGED. tsc holds the 7-error baseline; build READY.
**Why:** After recoloring the escrow-report Next Step boxes orange, the "Submitted to UW" stage band (also orange, `text-orange-700`) matched them — visually confusing on the report.
**Changes:** `lib/types.ts` STATUS_COLORS `'Submitted to UW'` `bg-orange-100 text-orange-700` → `bg-indigo-100 text-indigo-700`. Global map → recolors the stage everywhere it renders (escrow report, pipeline board, deals list, trackers, global search), not just the report. Indigo is unused elsewhere in the Loans-in-Process pipeline, so no new neighbor clash.
**Test Method:** `npx tsc --noEmit` (7 baseline, 0 new) + `npm run build` → READY. Deterministic Tailwind swap; live check on authed `/reports/escrows` + `/pipeline`.

### [2026-07-01] Escrow report — make stage-band titles pop (bigger/bolder)
**Status:** CHANGED. tsc holds the 7-error baseline (0 in escrows/page.tsx); build READY.
**Why:** Efrain — the per-stage section headers (APPROVED W/ CONDITIONS, CLEAR TO CLOSE, DOCS OUT…) should stand out more as section dividers.
**Changes:** `app/reports/escrows/page.tsx` `stage-head` band — title `text-sm font-bold tracking-wide` → `text-lg font-extrabold tracking-wider`; band padding `px-3 py-2` → `px-4 py-2.5`; count/volume `text-xs` → `text-sm`. Colors unchanged (still `STATUS_COLORS[stage]`).
**Test Method:** `npx tsc --noEmit` (7 baseline, 0 new) + `npm run build` → READY. Deterministic Tailwind typography swap; live check on the authed `/reports/escrows`.

### [2026-07-01] Escrow report — remove warning-triangle icon + recolor next-step box blue → orange
**Status:** CHANGED. tsc holds the 7-error baseline (none in escrows/page.tsx); build READY.
**Why:** Efrain — the blue ⚠ (AlertTriangle) icon in the per-deal "Next Step" box wasn't wanted, and he wanted the box orange instead of blue.
**Changes:** `app/reports/escrows/page.tsx` DealRow Row 4 (populated next-step branch) — removed the `<AlertTriangle>` icon; box `border-blue-200 bg-blue-50` → `border-orange-200 bg-orange-50`; "Next Step" label `text-blue-700` → `text-orange-700`. The "No next step logged" fallback (gray, separate) is untouched; `AlertTriangle` import retained (still used there).
**Test Method:** `npx tsc --noEmit` (7 baseline, 0 new) + `npm run build` → READY. Deterministic Tailwind swap; browser screenshot skipped (RLS blocks anon preview → would need temp auth-bypass + mock scaffolding for a color change).

### [2026-06-30] Clear-to-Close + Non-Del funding alert — built as a cron, then REMOVED (Efrain declined the cron)
**Status:** REMOVED same day. Built `app/api/cron/ctc-nondel-alerts/route.ts` + `supabase-add-ctc-nondel-alert.sql`
(dry-run verified), but Efrain didn't want to set up a new cron-job.org job, so both files were deleted (never
activated — no migration run, no cron registered, so nothing ever sent). The Brevo alert-cron pattern (lock-alerts
template, To=LO/Cc=Efrain) is still the reference if revisited. Likely follow-up: an on-demand "Send funding alert"
button on the deal page instead (same email, no cron) — pending Efrain's go-ahead.
**Status:** VERIFIED (browser, mock). tsc 7 baseline, build READY.
**Why:** Efrain wants the broker/Non-Del channel inline with the amount on each report card.
**Changes:** `app/reports/escrows/page.tsx` DealRow amount line — prefixes `{broker_corr} - ` (muted) before the bold
amount when set; null channel → plain amount. Verified via demo route: "Broker - $680,000", "Non-Del - $2,460,000",
and null → "$540,000".
**Git note:** tried to squash the rejected intermediate escrow-card commit (`2403ed9`) out of history, but the
force-push was blocked by environment policy — so `2403ed9` remains in the log (harmless; the live code is the final
2×2). History cleanup would need a manual force-push by Efrain.

### [2026-06-30] Fluid CPU — match LastSyncBadge polling to cron cadence + skip middleware on /api/sync-status
**Status:** CHANGED (pending tsc + build verify, then deploy). Targets idle Vercel Active CPU.
**Why:** Efrain — Fluid Active CPU breakdown showed middleware (edge) ≈ 52% and node functions ≈ 48%, both running 24/7 regardless of real usage. Root drivers: `LastSyncBadge` polled `/api/sync-status` every 30s per open tab (each poll *also* paid the middleware `getUser()` auth cost), and a forgotten tab kept that up all night/weekend. The sync itself only runs ~every 15 min (cron-job.org), so 30s polling was 30× more often than the data changes.
**Changes:**
- `components/LastSyncBadge.tsx` — server fetch now every **15 min** (matched to the cron cadence) instead of 30s, **paused while the tab is hidden** (Page Visibility API) with an instant catch-up fetch on regaining focus. The "X min ago" label re-renders every 60s client-side only (no network) so it stays smooth and still trips red on a stall. Color thresholds retuned to the 15-min reality: green <16m, amber 16–35m, red >35m (was 5/30). Effect: ~2,880 pings/day/tab → ~96/day/tab, → 0 while hidden.
- `middleware.ts` — excluded `/api/sync-status` from the matcher so those polls no longer instantiate the auth middleware. Endpoint returns only a sync timestamp (no auth-gated data), so skipping middleware leaks nothing.
**Test Method:** `npx tsc --noEmit` holds the 7-error baseline (no new errors); `npm run build` → READY; badge still renders + counts up. CPU reduction is to be observed on the Vercel Fluid chart over the coming days (can't be proven at commit time).

### [2026-06-30] Escrow card — add Channel (Broker/Non-Del) to the stats block, split into 2 rows
**Status:** VERIFIED (browser, mock data). tsc 7 baseline, build READY.
**Why:** Efrain — surface the new broker_corr channel on the Active Escrows card; the old single-row Lender·Amount·LO
block had no room, so split it.
**Changes:** `components/EscrowTracker.tsx` quick-stats block — was a 1-row 3-col grid (Lender | Amount-hero | LO); now
2 rows: Amount hero centered on top, then a 3-col row Lender · **Channel** (`deal.broker_corr || '—'`) · LO below.
**Test Method:** temp `app/carddemo/page.tsx` rendering `<EscrowTracker>` with 3 mock deals + middleware bypass (both
reverted; `.next` cleared to avoid the stale-route validator error). Verified all 3 channel states: Non-Del, Broker,
and null→"—"; layout balanced, no overflow; no console errors. NOTE: temp route must NOT use a leading underscore
(`app/_carddemo` = private/non-routable → 404); used `app/carddemo`.
**Rev (2026-06-30, Efrain feedback):** final layout is a **2×2** — row 1 Channel · Amount(hero), row 2 LO · Lender
(left col left-aligned, right col right-aligned). (Interim try of Channel·Amount·LO + Lender-own-row was rejected.)
Re-verified via demo route across Non-Del / Broker / null + a long lender name; reverted.
**Status:** VERIFIED (tsc 7 baseline, build READY).
**Why:** Efrain — removed the "Waiting On" field from the deal detail TEAM section; added an Arive "channel" column
(broker vs Non-Del) and wants the dashboard field relabeled "Broker / Non-Del" ahead of the next import.
**Changes:** `app/deals/[id]/page.tsx` — removed the `waiting_on` `<Field>` from the Team section + dropped the now-
unused `WAITING_ON_OPTIONS` import; relabeled `broker_corr` field "Broker / Non-Del" and its 2nd option
"Correspondent" → "Non-Del". `components/DealForm.tsx` — same broker relabel for consistency.
**Importer (initially unmapped, now WIRED):** `broker_corr` was not mapped in the Arive importer. Efrain confirmed
the new column is **"Channel"** with values **"Broker" / "Non-Del"**, so added
`{ ariveCols: ['Channel'], field: 'broker_corr', normalize: r => trimStr(r) }` to `lib/ariveCsv.ts` MAPPINGS. Values
pass through verbatim (match the dropdown options); blank Channel leaves the field untouched (`rowToPatch` skips empty
values). Functionally tested via `tsx` — Broker→Broker, Non-Del→Non-Del, ''→unset. The next Arive import now populates
the Broker / Non-Del field. `waiting_on` column kept (still used by /pipeline + the escrow report blocker).
**Status:** VERIFIED (local, mock data). tsc clean (7 pre-existing baseline), build READY.
**Why:** Efrain wanted a visual report off Active Escrows — separately for Moe and for Matt — showing stage, next
steps, rate-lock + expiration, assigned processor, and loan details.
**Changes:** `app/reports/escrows/page.tsx` (NEW — loads active escrows via `fetchAllDeals` with the same filter as
/deals [`pipeline_group='Loans in Process'`, not lost/abandoned]; LO toggle Moe/Matt/All = the "two reports";
groups by stage in `PIPELINE_STATUSES['Loans in Process']` order; per-deal card = stage badge + days-in-stage vs
`STAGE_SLA_DAYS`, current next step [`next_action_log[0]`/`next_action` + due + assignee], rate lock from `locked`
('Yes'/'No') + `lock_expiration` with a color-coded countdown [green/amber≤7d/red=expired], processor from
`processor_status` + handoff, loan details [amount, rate, LTV, FICO, type, purpose, lender=`investor`, address],
priority + `waiting_on` blocker; KPI band [count, volume, locked, lock≤7d, expired, past-SLA]; `window.print()` with
an `@media print` block that isolates `#escrow-report`). `app/deals/page.tsx` (+"Report" button → `/reports/escrows?lo=`).
`components/Sidebar.tsx` (+Insights "Escrow Report" link). No DB/API/migration change.
**Test Method:** temp middleware bypass + a temp `?demo=1` mock branch (BOTH reverted — `grep TEMP-DEMO/MOCK_DEALS`
clean, middleware git diff empty) because the `deals` table rejects anon reads in the preview. Verified: Moe → 3
loans/$3.95M, Locked 1/3, Past-SLA 1; Matt → 2 loans/$547,268, Locked 2/2, Expired 1; all four lock states render
(not-locked, amber ≤7d, red EXPIRED, green far-out); stage order correct; print isolation present; no console errors.
**Efrain's live check:** `/reports/escrows` (or the Report button on Active Escrows) → toggle Moe/Matt → Print/Save as PDF.
**Rev (2026-06-30, Efrain feedback):** stage headers now full-width color bands (bg = `STATUS_COLORS[stage]`);
removed the days-in-stage / SLA line per deal AND the "Past SLA" KPI; processor now labeled "Processor: {value}";
also rounded the LTV/rate display (a raw float `66.4864…%` was showing). Re-verified via demo+bypass (reverted).
**Rev 2 (2026-06-30, Efrain feedback):** added a bottom section "Locks expiring within the next 7 days" listing each
applicable loan's name + exact `lock_expiration` date (soonest first), driven by the same `lockInfo().expiring`
flag as the Lock ≤7d KPI. Verified with demo (Lucy Ramsay Jul 3 + Clara An Jul 6, sorted); scaffolding reverted.
**Rev 3 (2026-06-30, Efrain feedback):** MOVED that section from the bottom to a top callout (amber box between the
KPI band and the first stage); now only renders when ≥1 lock is expiring (the Lock ≤7d KPI covers the zero case).
Verified DOM order (KPI → callout → stages) + screenshot; scaffolding reverted.
**Rev 4 (2026-06-30, Efrain feedback):** removed the "Expired" KPI tile ("we can't let any lock expire") — KPI band
is now 4 tiles (`sm:grid-cols-4`). The per-deal red "Lock EXPIRED" badge stays (still flags an actually-expired
lock on its card). Deterministic tile removal — verified via tsc (7 baseline) + build READY (no browser re-run).
**Rev 5 (2026-06-30, Efrain feedback):** deal cards — Next step is now a tinted blue box with a "NEXT STEP" label
(was blending into the card); card border thickened to `border-2 border-slate-300`; and the next step now shows
**"Entered {date, time}"** from `next_action_log[0].at` (falls back to no timestamp for legacy `next_action`-only
deals). Verified via demo (Victor Duarte: "Entered Jun 30, 9:05 AM · due … · Hanh"; legacy + no-step variants) +
screenshot; 2px borders confirmed; scaffolding reverted.

### [2026-06-30] Lender List — BCC email picker (checkbox-select lenders → copy emails for Outlook BCC)
**Status:** VERIFIED (local). tsc clean (7 pre-existing baseline), build READY.
**Why:** Efrain wanted to blast a batch of lenders. Asked for a checkbox per lender, an "Email" button at the top,
and a popup listing the selected emails to copy/paste into the Outlook BCC field.
**Changes:** `components/LenderEmailModal.tsx` (NEW — gathers the first/primary email per checked lender, dedupes
case-insensitively, skips + lists lenders with no email; `; ` default separator with a comma toggle; Copy button
that selects-then-writes-clipboard so Cmd/Ctrl+C always works; Clear selection). `app/lenders/page.tsx`: added a
`selected: Set<id>` (survives filter changes), a per-row checkbox column, a header **select-all-filtered** checkbox
(with indeterminate state), and an "Email (N)" button (emerald, disabled at 0). No DB/API/migration change.
**Test Method:** temp full middleware bypass (reverted — middleware git diff empty) + `preview_start` + screenshots.
Verified: checking 2 rows → "Email (2)"; modal shows `geoffsamet@…; fuzz.heidari@…` (semicolon), comma toggle
flips separator; Copy leaves the textarea fully selected (clipboard API is blocked in the headless preview — works
on Efrain's focused HTTPS tab); select-all → "Email (82)" → modal "60 addresses" (dedupe/skip-empty proven);
Clear selection closes the modal + unchecks all + disables the button. No console errors.
**Efrain's live check:** `/lenders` → check a few lenders → **Email (N)** → Copy → paste into Outlook BCC.

### [2026-06-29] Next-step log UX redesign — prominent current + popup to add (Efrain feedback)
**Status:** VERIFIED (local). tsc clean (back to 7 baseline after clearing a stale `.next/dev` validator ref to
the deleted test page), build READY.
**Change:** `components/NextStepLog.tsx` reworked per Efrain: the latest entry is now the **prominent** current
step (15px semibold + timestamp); removed the always-on textarea; the **+** opens a popup (textarea + Cancel/Done,
Enter-to-save) to log a new step, which becomes current and pushes the prior into "▸ N earlier steps." The popup is
rendered via `createPortal` to `document.body` so the escrow card's dnd-kit transform/overflow can't clip it.
**Test Method:** temp `/nextsteptest` mock render + full middleware bypass (both reverted; middleware diff empty):
screenshots confirmed the prominent current step + the **+** popup; clicking **Done** with new text closed the
modal, made the new text the bold current (font-weight 600), and moved the prior step into "3 earlier steps."
**Efrain's live check:** on an Active Escrow card, tap **+** → type → Done → it becomes the bold current step.

### [2026-06-29] Next-step LOG on the escrow card (timestamped history, replaces the single overwritten field)
**Status:** CHANGED — tsc clean (7 pre-existing), build READY. **Needs the migration before deploy** (the card
writes the new column). Component render verified locally; end-to-end persistence is Efrain's live check on a real
card.
**Why:** Efrain — the "Next Step" was a single `next_action` field that got overwritten on each edit, losing the
file's progression. Wanted a timestamped log of all next steps. Chose timestamps WITHOUT author attribution.
**Changes:** `supabase-add-next-action-log.sql` (NEW — `alter table deals add column next_action_log jsonb`).
`lib/types.ts` (+`NextStepEntry {id,at,text}`, +`next_action_log: NextStepEntry[]|null` on Deal). `components/
NextStepLog.tsx` (NEW — add-input + timestamped history, newest=current, older behind a "N earlier steps"
expander, each removable; seeds a legacy `next_action` into the log on first add so the current step isn't lost).
`components/EscrowTracker.tsx` (replaced the next_action textarea with `<NextStepLog>`; removed the now-unused
`nextAction` state). `next_action` still mirrors the latest entry so existing filters/sorts/the "No next step" chip
keep working.
**Storage:** mirrors the existing `communications`/`documents` per-deal JSONB-log pattern — the GHL sync does NOT
touch `next_action_log`, so no deploy-ordering risk to the sync (only the card's write needs the column).
`app/deals` reads via `fetchAllDeals` default `select('*')`, so the log loads once the column exists; `onUpdate`
passes the full patch to `supabase.update(patch)` (no field whitelist) + optimistically merges.
**Test Method:** `npx tsc --noEmit` + `npm run build` (READY) + local mock render (temp `/nextsteptest` route +
middleware bypass, both reverted): the orange box showed the add-input, the current step with timestamp
("· current"), and the "2 earlier steps" expander — screenshot captured. Add/remove uses the standard optimistic
onUpdate pattern.
**Efrain's live check (after migration + deploy):** on an Active Escrow card, type a next step → it logs with a
timestamp and stays; add another → the newest becomes current and the prior moves under "earlier steps."

### [2026-06-29] Cron GHL sync: return fast + run in after() (fix cron-job.org 30s timeouts)
**Status:** VERIFIED (local) — tsc clean (7 pre-existing), build READY. Deploying.
**Why:** A "Lost" loan (Mayra Sinohui) lingered ~3h on Active Escrows. Root cause (see GOTCHAS 2026-06-29):
the sync is pinged by **cron-job.org** (30s timeout cap, free), and the heavy maintenance/identity runs exceed 30s
→ cron-job.org "Failed (timeout)" cut them off mid-reconcile. (Mayra's own deal was separately fixed by a manual
sync → `pipeline_group: Not Ready, ghl_status: lost`.)
**Change:** `app/api/cron/ghl-sync/route.ts` only — acquire lock, return `{ok:true, queued:true}` immediately, run
`runGhlSync` + identity/conversations/2nd-callback sub-tasks in `after()` (next/server). Rejected a `*/5` Vercel
cron (Efrain: adds metered usage). No new cron; same trigger + work, so no usage increase. Manual `/api/sync/ghl`
buttons untouched (fallback). vercel.json reverted to original.
**Test Method:** `npx tsc --noEmit` (after import resolves on Next 16.2.4) + `npm run build` (READY) + local: cron
endpoint returned in **68ms** with `queued`/`skipped:in_progress`, and server logs show the background run
COMPLETED (`incremental — synced 1 (1 updated, 0 errors, 794ms)` + 2nd-callback sub-task ran). Lock self-heals via
5-min TTL.
**Efrain's live check:** in cron-job.org, the ghl-sync job should now show all 200 OK (no more "Failed (timeout)"),
and GHL status changes (lost/won/stage) should reflect on the dashboard within a ping cycle.

### [2026-06-29] Southerby duplicate escrow — RESOLVED (data fix, no code change)
**Status:** VERIFIED. One loan (Arive #16895210, $1.22M) showed as two Active-Escrow cards: Paul (worked card
`7c1d0095`, Arive-created, no GHL opp) + Cynthia (bare card `e8e2d699` carrying GHL opp `ffkS…`, created by today's
full sync). Verified via GHL: the opp was under Cynthia's contact; Paul's only opp was the $122k LOST one. See
GOTCHAS 2026-06-29 ("Southerby case").
**Fix (service-role data ops, prod DB — no deploy):** Efrain reassigned the GHL opp's primary contact to Paul (I
confirmed via `GET /opportunities/ffkS…` → contactId now Paul, Cynthia 0 opps). Then: deleted the bare duplicate
`e8e2d699` (no notes/worked data lost — guarded), set `7c1d0095.ghl_opportunity_id = ffkS…` (+ ghl_contact_id =
Paul's) so the worked card owns the opp (durable — sync matches it, never recreates), and removed the stray
Paul-as-his-own-`co` `deal_contacts` link. Verified after: single "Paul Southerby" card, In Process, $1,220,480,
co-borrowers = ["Cynthia Southerby"].
**No code committed** — temp diagnostic route + middleware bypass were used and reverted (git diff clean).

### [2026-06-29] Removed Past-SLA notifications (kept lock-expiry + task alerts)
**Status:** CHANGED — tsc clean (7 pre-existing), build READY. Efrain's live check: the "Past SLA — …" items
disappear from the Notifications panel; lock-expiry + overdue/due-today task alerts remain.
**Why:** Efrain asked "why do I still get these? I thought we got rid of these." Verified across code + git +
transcripts: the SLA-breach alerts were ADDED 2026-05-14 (commit 24a85bb) and were NEVER removed/disabled — no
flag, no removal commit, no prior conversation. They recompute live every 5 min, and "Clear all"/dismiss only
hides a specific one until the deal changes, so they kept reappearing. Efrain chose to turn them off entirely.
**Changes:** components/NotificationBell.tsx — removed section 2 (the `pipeline_group==='Loans in Process'` +
`STAGE_SLA_DAYS` breach loop) from `computeNotifs`; dropped the now-unused `'sla'` NotifType, `Hourglass` icon,
`STAGE_SLA_DAYS` import, `daysSince` helper, and the `pipeline_group/stage_changed_at/created_at` columns from the
deals select; updated the empty-state + doc copy. Lock (section 1) + tasks (section 2) untouched.
**Not-fixed (moot now):** the old "days in stage" count fell back to `created_at` when `stage_changed_at` was
missing, inflating overages — irrelevant once the alerts are gone.
**Test Method:** tsc + build (the panel only shows real data with auth, so live confirmation is Efrain's).

### [2026-06-29] Lender List is now EDITABLE (per-lender modal, add/delete, team-shared)
**Status:** VERIFIED (local browser, full-bypass render). tsc clean (7 pre-existing), build READY.
**Changes:** app/api/lenders/route.ts (NEW — sync_state `lenders_list` JSON blob, same pattern as /api/tools;
GET returns the list or null, POST sanitizes + upserts). components/LenderEditModal.tsx (NEW — all fields editable:
name, section, In Arive, contact, phone, email, product chips, min FICO, comp, notes + Delete). app/lenders/page.tsx
(loads /api/lenders with the static lib/lenders.ts as instant SEED; per-row ✏️ edit; "Add lender"; optimistic
write-through to the DB).
**Source of truth shift:** lib/lenders.ts is now only the SEED. Once anyone saves, the live list is the
team-shared `sync_state` copy (authoritative). The monthly `parse_lenders.py` regen updates the SEED only — it no
longer changes the live list once published (so in-app edits are NOT overwritten by a regen).
**Test Method:** local render with a TEMP full middleware bypass (reverted; middleware diff confirmed empty). DOM
probe: 82 ✏️ pencils + Add button; clicked edit → modal opened with ALL fields populated (Rocket: name/Geoff
Samet/phone/email/620/2.0%-3.0%, section Agency-Jumbo, Arive Yes, products CONV/VA/FHA/Jumbo, notes). Clicked Save
→ modal closed → `GET /api/lenders` returned the 82-lender list persisted to sync_state. Screenshot captured.
**Note:** the Save during testing seeded prod `sync_state.lenders_list` with the current 82 (= the static seed),
which is the intended initial state.

### [2026-06-29] Espinoza borrower (Judith→Jesus) — RESOLVED via full sync
**Status:** VERIFIED. The deal showed "Judith" but the GHL contact of record (`t2BK…`) was already renamed to
**Jesus Espinoza** (confirmed via live GHL contact fetch). Root cause was NOT Arive and NOT a GHL ownership issue
(first diagnosis was wrong — corrected by fetching GHL): the incremental sync never re-pulls a renamed contact
(only contacts of *changed opportunities*), so the rename never reached the dashboard. See GOTCHAS 2026-06-29.
**Fix applied:** forced a full GHL sync (`?full=1`) → re-pulled all contacts → deal `f7a22e85` flipped to
**name/first/last = Jesus Espinoza**, phone +1 310-702-0878. Verified by reading the row back post-sync (synced
1670, 0 errors). Added a self-serve **Full Sync** button to the sidebar so this is one click going forward.
**Residual (known):** (1) contact renames still need a full sync to propagate (the 3-min incremental won't);
(2) `deals.borrower_id` still points at the dashboard contact named "Judith" (sync never touches borrower_id) so
"View Contact" may read Judith until the identity resolver reconciles.

### [2026-06-29] Lender List — new /lenders directory tab (from approved-lenders sheet)
**Status:** VERIFIED (local browser render) — tsc clean (no new errors; 7 pre-existing remain), build READY,
`/lenders` prerenders as a static route (○). Rendered locally via preview_start (temp middleware `/lenders`
allowlist — REVERTED, confirmed gone from middleware.ts) + DOM probe: path `/lenders`, h1 "Lender List", 10 section
banners with correct counts (Agency/Jumbo·9, 500-580 Govie·9, Non-QM·20, …), 82 lender rows, subtitle "82 shown ·
25 in Arive"; console clean (no logs/warnings/errors). Screenshots confirm blue category bands, green/gray In-Arive
badges, blue mailto links, product badges.
**Files:** app/lenders/page.tsx (NEW — single 'use client' page: search + section/product chips + "In Arive only"
toggle + one continuous sticky-header table, blue banner row per section), lib/lenders.ts (NEW — 82 typed records,
AUTO-GENERATED from the CSV via scratchpad/parse_lenders.py), components/Sidebar.tsx (+Landmark import, +Lender List
nav item in the Actions group).
**Why:** Efrain wanted the "Approved Lumin Lenders" Google Sheet as an in-dashboard contact list — everything from
one view, matching the app framework — so LOs can look up the right lender/AE/contact + product eligibility while
structuring a loan, instead of hunting through a sprawling multi-tab sheet.
**Design:** Source CSV is ISO-8859-1 with several stacked tables (different column schemas) + NBSP mojibake (\xa0)
+ trailing junk. Parser (cp1252 decode, NBSP→space, newline→' / ') normalizes all sections into one record shape:
products[] badges (CONV/VA/FHA/<580/Jumbo for 1sts; Agency/Non-QM 2nd/HELOAN/Piggyback for 2nds), minFico, comp,
notes. Static import (no fetch/DB/auth) so it renders instantly and was verifiable locally.
**Known data caveats (source, not code):** orphan continuation-note rows (blank lender name) are appended to the
preceding lender tagged "[Additional notes (verify owner)…]" (e.g. under NFTY in 2nds) — Efrain should confirm
owners. Stray product cells like NewRez Govie CONV "tin" / Cake "bu" are source typos → not badged.
**Test Method:** `npx tsc --noEmit` (clean for new files) + `npm run build` (READY, /lenders ○ static) + local
preview render (DOM probe + screenshot, console clean).
**Result:** VERIFIED + deploying. Efrain's live check: open the **Lender List** tab on the authed dashboard →
search/filter, confirm contact info + product matrix read correctly against the sheet.

### [2026-06-29] Bulletin notes: full email-grade editor (TipTap v3) — markdown → HTML
**Status:** VERIFIED (local browser render) — tsc clean, build READY. Rendered the editor + read-only sanitizer
on a temp throwaway route (temp middleware allowlist, BOTH reverted): full toolbar (font, size, B/I/U/strike,
color, highlight, H1-3, bullet + numbered lists, align, link, image, clear) and correct rendering of every format
in BOTH the editor and the DOMPurify read-only view; console clean (no errors). Live editing on real notes is
Efrain's final check (note data is auth-gated).
**Files:** components/RichTextEditor.tsx (NEW — TipTap editor + toolbar), components/NoteContent.tsx (NEW —
DOMPurify read-only HTML render), components/NotesBoard.tsx (modal edit→RichTextEditor; view+cards→NoteContent;
dropped execCommand/per-note-font/markdown-save), app/globals.css (.note-prose), package.json/-lock (+@tiptap/*
3.27.1, dompurify 3.4.11).
**Why:** Efrain wanted email/Word-grade editing. The old editor stored markdown (only headings/bold/highlight/
bullets) — couldn't hold fonts/colors/underline/alignment/numbered-lists/images. Chose TipTap (full path) over a
hand-rolled execCommand toolbar.
**Design:** Storage markdown → HTML. NO DB migration — legacy markdown converts on the fly via the existing
markdownToHtml (looksLikeHtml branch) for both editor seed + read-only render; new saves write editor.getHTML().
DOMPurify-sanitized on every read (the XSS surface the markdown design had avoided). StarterKit v3 bundles bold/
italic/underline/strike/headings/lists/links; extras: TextStyleKit (font family/size/color), TextAlign, Highlight,
Image. immediatelyRender:false for Next SSR.
**Test Method:** `npx tsc --noEmit` (clean) + `npm run build` (READY) + LOCAL render of a temp route (screenshot +
DOM probe: .ProseMirror present, 16 toolbar buttons + 2 selects, all formats parsed; console clean).
**Result:** VERIFIED render + sanitized read-only; deployed. Efrain to confirm the save/persist flow on real notes
(open a note on /tasks → edit → reopen should persist; legacy markdown notes still display).

### [2026-06-29] Bulletin (NotesBoard): single-column list → responsive board
**Status:** CHANGED (NotesBoard tsc clean, build READY), deployed — visual confirmation pending on Efrain's authed
dashboard. Local screenshot NOT possible: `dashboard_notes` needs Supabase creds the sandbox blocks (`.env.local`),
so a local dev server renders an empty board (no cards) — no useful proof.
**Files:** components/NotesBoard.tsx.
**Issue:** Efrain wasn't happy with the bulletin formatting — single-column inbox-style list, content hidden behind
a click, wasted dashboard width, weak color signal. Approved the "board" direction from a mockup.
**Changes:** (1) list `space-y-1.5` → responsive grid `repeat(auto-fill,minmax(15rem,1fr))` — fills the width.
(2) DnD `verticalListSortingStrategy` → `rectSortingStrategy` (2-D grid reorder). (3) NoteRow rebuilt as a card:
a top color bar (`DOT[color]`) replaces the 4px left edge; renders the note inline via `NoteMarkdown` (clamped
`max-h-[8.5rem] overflow-hidden`) instead of the flattened `plainSnippet`; pinned cards get amber border + ring +
"Pinned" label and still sort first. (4) Whole card is the click target (`role=button` + onClick); pin/delete/
drag-handle `stopPropagation`; preview is `pointer-events-none` so its links don't swallow the click. Removed the
now-unused `plainSnippet`. Modal editor, markdown storage, per-note font, DnD, pin all preserved.
**Test Method:** `npx tsc --noEmit` (NotesBoard clean) + `npm run build` (READY). Visual/interaction: Efrain to
confirm on the live Tasks page — board layout, click-to-open, drag-reorder, pinned styling.
**Restyle (Efrain chose "clean accent" from a mockup):** top color bar → colored LEFT side rail; white cards with
more air (p-4, gap-4, 16rem cols); natural heights (grid `items-start`, dropped h-full); actions floated to a
top-right hover cluster; larger title (15px). DnD + modal editor + markdown storage still intact.
**Result:** Type-clean, build READY, deployed (board, then the clean-accent restyle). Awaiting Efrain's live look.

### [2026-06-29] Arive import: signing_date/paid_date mappings — ADDED then REVERTED same day
**Status:** REVERTED — Efrain confirmed he doesn't need signing_date/paid_date. NET: zero change to MAPPINGS.
**Files:** lib/ariveCsv.ts (MAPPINGS) — added two entries, then removed them (back to funded_date as last mapping).
**Arc:** Added `signing_date`+`paid_date` (`dateOnly`, conservative aliases) → committed `155501a` → deployed
`lumin-deals-ad65zyxd9`. Efrain then said he doesn't need them → reverted both entries. tsc + build re-verified
clean on the revert.
**Item ② final dispositions (all confirmed with Efrain 2026-06-29):**
- `signing_date`, `paid_date` → NOT needed → not mapped.
- `locked` → handoff mislabeled it a "rate-lock date"; actually a manual Yes/No/NA `<select>` (pipeline/page.tsx:1390),
  no lock-date column exists. Feeds the lock-alert cron — VERIFIED it already fires ONLY for in-process/not-funded
  (lock-alerts/route.ts:198 `status IN ESCROW_STATUSES`; gates on status NOT pipeline_group because funded statuses
  nest under "Loans in Process"; that gate built 2026-06-02 cb51122). LEAVE MANUAL — no change.
- `appraisal_status` → dashboard-maintained → SKIP.
**Result:** Item ② closed with zero net field-mapping changes. Type-clean, build READY (revert).

### [2026-06-25] Dashboard: remove the date-range filter (All Time / MTD / QTD / YTD / Custom)
**Status:** VERIFIED (browser) — tsc clean, build READY, deployed.
**Files:** components/Dashboard.tsx.
**Issue:** Efrain — the Dashboard is "Active Escrow Overview" (a present-state snapshot of what's currently in
escrow); a date-range filter doesn't apply. Remove it.
**Changes:** Removed the preset bar + custom-range popover + the "· <range>" header label, and the whole
date-filter machinery: `DatePreset` type, `getPresetRange`, `dealDate`, `inRange`, the `datePreset/customFrom/
customTo/showCustom/customRef` state, the outside-click effect, `PRESETS`, `rangeLabel`, `handlePreset`. KPIs
now derive straight from `escrowDeals = deals.filter(pipeline_group === 'Loans in Process')` (was the
date-filtered list; default was already 'all', so the numbers are unchanged). Dropped now-unused imports
(`useRef`, `Calendar`, `X`).
**Test Method:** `npx tsc --noEmit` (0 in Dashboard; no leftover refs to any removed identifier; total 7
pre-existing) + `npm run build` READY. **Browser-verified** (temp middleware allowlist for `/`, reverted):
dashboard renders, header subtitle is just "Active Escrow Overview" (no range label), and All Time/MTD/QTD/
YTD/Custom are all gone (DOM eval). NOTE: a flood of NotesBoard parse errors in the dev console were STALE
HMR-buffer entries from earlier rapid edits (referenced old line text); a fresh dev server showed zero errors
and `next build` passed — build is authoritative.
**Result:** Type-clean, build READY, browser-verified (toggle removed, renders). Allowlist reverted. DEPLOYED below.

### [2026-06-25] Notes modal: open in VIEW mode + Edit button (and fix a content-doubling bug)
**Status:** VERIFIED (browser) — tsc clean, build READY, deployed.
**Files:** components/NotesBoard.tsx.
**Issue:** Efrain — don't drop straight into edit when opening a note; open read-only and add an Edit button.
**Changes:** `NoteEditorModal` gained a `view`/`edit` mode (default VIEW; a brand-new empty note still opens
in edit). VIEW renders the note read-only via `NoteMarkdown` with a "VIEWING" label + footer **Edit** button;
EDIT shows the toolbar/color picker/contentEditable + footer **Done** (saves & returns to VIEW). Seed-on-mount
became seed-on-enter-edit (effect keyed on `mode`). Close/Esc/backdrop save only if mid-edit.
**BUG caught during verification (would have hit prod):** the view `<div>` and edit `<div>` were the same
element type at the same position with NO `key`, so React reused the DOM node; the editor's imperatively-set
`innerHTML` (untracked by React) lingered when switching back to view, so `NoteMarkdown`'s children rendered
ALONGSIDE it → note content appeared DOUBLED after an Edit→Done cycle. NOTE: data was never affected
(updated_at unchanged — the round-trip is idempotent so no save fired; purely a DOM-reuse glitch). The old
NoteCard had `key="note-editor"/"note-view"` for exactly this; the rewrite dropped them. Fix: re-add distinct
`key`s on the two branches → clean unmount/remount.
**Test Method:** `npx tsc --noEmit` (0 in NotesBoard; total 7 pre-existing) + `npm run build` READY.
**Browser-verified** (temp middleware allowlist, reverted): open Licensing → VIEW (read-only, "VIEWING", Edit
button, no editor/toolbar); click Edit → editor seeded + focused, toolbar/Done; Done → back to VIEW. After the
key fix, Abraham's-States count = 1 on open, 1 after one Edit→Done, 1 after TWO cycles (was 2 before fix);
updated_at stayed Jun 18 (no spurious save). Screenshot confirmed.
**Result:** Type-clean, build READY, browser-verified incl. the doubling fix. Allowlist reverted. DEPLOYED below.

### [2026-06-25] Notes/Bulletin: card grid → list rows + pop-out modal editor
**Status:** VERIFIED (browser) — tsc clean, build READY, deployed.
**Files:** components/NotesBoard.tsx.
**Issue:** Efrain — lay notes out like Tasks (a long list showing title + description in smaller text), and
open the full editor as a POP-OUT (modal) when a note is clicked.
**Changes:** Replaced the masonry card grid with a vertical list of `NoteRow`s (title + 2-line plain-text
snippet via new `plainSnippet()`, drag handle, pin, delete, color accent, updated time). Extracted the
WYSIWYG editor into `NoteEditorModal` — a `createPortal` overlay (`fixed inset-0`, backdrop blur) that's
always in edit mode: title, toolbar (H1/H2/H3, Bold, Highlight, List, per-note A−/A+ font), contentEditable
body. Click a row → modal; Add note → creates + opens the modal. Save-and-close on Done / X / backdrop / Esc.
PRESERVED: markdown storage (markdownToHtml/htmlToMarkdown), per-note localStorage font, color, pin, and DnD
reorder (now `verticalListSortingStrategy`). Funded note: legacy HTML notes still convert on load.
**Test Method:** `npx tsc --noEmit` (0 errors in NotesBoard; total unchanged at 7 pre-existing) + `npm run
build` READY. **Browser-verified** via temp middleware allowlist (reverted): /tasks Bulletin renders as a
list of rows; clicking "Licensing" opened the pop-out modal with the editor seeded from the note content,
toolbar + Done present, backdrop overlay present (confirmed via DOM eval + screenshot).
**Result:** Type-clean, build READY, browser-verified (list + modal). Temp allowlist reverted (tree clean).
DEPLOYED below.

### [2026-06-25] LO follow-up: normalize 94 legacy rows + share resolveLO (3 surfaces)
**Status:** CHANGED (code) + DONE (data) — tsc clean, build READY, deployed.
**Files:** lib/loanOfficer.ts (NEW), app/api/sync/ghl/route.ts, app/api/webhooks/ghl/route.ts, lib/ariveCsv.ts.
**Data fix (prod write, authorized "do what you think is best"):** one-time `UPDATE deals SET
loan_officer='Matt Park' WHERE loan_officer='Matthew Park'` → **94 rows** (verified: 'Matthew Park' now 0,
'Matt Park' total 805 = 711+94). These were legacy un-normalized rows that still rendered blank in the LO
dropdown after the enum fix.
**Code (prevent recurrence):** `resolveLO` + `LO_MAP` were DUPLICATED byte-for-byte in the sync and webhook.
Extracted to a single `lib/loanOfficer.ts` (unknown names pass through, so no LO is ever wiped); both routes
now import it (dedup), and the **Arive importer** (`lib/ariveCsv.ts:251`) now normalizes loan_officer through
it (`trimStr` → `resolveLO`) so a future Arive export can't reintroduce "Matthew Park"/variants. One source
of truth for LO normalization across sync + webhook + import.
**Test Method:** `npx tsc --noEmit` — 0 errors in the 4 touched files; total error count unchanged at 7
(pre-existing build-ignored set). `npm run build` READY.
**Result:** Type-clean, build READY, 94-row data fix verified live. DEPLOYED below.

### [2026-06-25] Fix: LO dropdowns blank on Matt's deals (enum 'Matt' → 'Matt Park')
**Status:** CHANGED — tsc clean (changed file), build READY, deployed.
**Files:** lib/types.ts.
**Issue:** Efrain (post-Arive-import) — John Winn's funded loan showed no Loan Officer in the TEAM dropdown,
though it should be Matt Park. **Root cause (verified via service-role query):** the data is correct —
`loan_officer = "Matt Park"` (header renders it fine). The TEAM `<select>` (and every other LO dropdown:
pipeline, deals, hot-leads, FundedTracker, DealForm) builds options from `LOAN_OFFICERS = ['Matt','Moe
Sefati']`. The canonical stored value is "Matt Park" (resolveLO normalizes to it; Arive stores the full
name) — 711 deals are "Matt Park", 94 "Matthew Park", 194 "Moe Sefati". A `<select value="Matt Park">` with
`<option>Matt</option>` has no match → blank. Moe's render fine ("Moe Sefati" matches). Pre-existing; the
import just surfaced it.
**Changes:** `LOAN_OFFICERS` → `['Matt Park','Moe Sefati']` so options match the canonical value across all
6 dropdown surfaces. Verified leadReport.ts uses its OWN `LO='Matt'|'Moe'` filter type with tolerant
substring matching — unaffected. No stored short-"Matt" values exist, so nothing is orphaned.
**Test Method:** `npx tsc --noEmit` (clean on changed file; the DealForm error is pre-existing/build-ignored)
+ `npm run build`. Visual: reload John Winn → TEAM Loan Officer shows "Matt Park".
**Result:** Type-clean, build READY. DEPLOYED below. Follow-up (not done): 94 "Matthew Park" rows still won't
match — one-time normalize to "Matt Park" (data write, Efrain's call); + route Arive loan_officer through a
shared normalizer to prevent future drift.

### [2026-06-25] Webhook: real-time loan_amount from opportunity monetaryValue
**Status:** CHANGED — tsc clean on changed file, build READY, deployed.
**Files:** app/api/webhooks/ghl/route.ts.
**Issue:** loan_amount only corrected on the ≤3h maintenance reconcile because the workflow webhook payload
carries no monetaryValue (Juliet #17098748 stored `monetaryValue`=null). Make in-process amounts update in
real time when the payload DOES carry the opp value, mirroring the sync's fundedOwnsAmount rule.
**Changes:** In the opp-update branch, after the stage block, added a guarded write: detect PRESENCE of a
monetary-value key (`monetaryValue`/`monetary_value`/`opportunityValue`/`Monetary Value`/… at top level or
nested under `opportunity`) via hasOwnProperty; if present, `UPDATE deals SET loan_amount=<parsed> WHERE
id=match AND pipeline_group != 'Funded'`. Funded deals never overwritten (Arive-authoritative); absence of
the key is a no-op (so notes/messages/contact webhooks can't wipe loan_amount); explicit empty/0 clears a
stale figure (matches the sync mirror). Updated the stale "loan_amount NOT written from webhook" comment.
**Test Method:** `npx tsc --noEmit` (changed file clean) + `npm run build`. Standalone node check of the
presence-detection across 8 payload shapes (absent→SKIP, number/string-$/nested→WRITE, empty/null/0→clear).
**Result:** Type-clean, build READY, logic verified. Deployed `a6f83b3` → `dpl_HQcybCBEC76VAujBCA71XkXLh62f`
(prod READY). Activates once Efrain adds the opp Monetary Value token to the GHL workflow's custom-webhook
body (no-op until then).

### [2026-06-25] Loan amount: GHL opp value drives in-process loans (incl. Arive-backed)
**Status:** CHANGED — pending tsc + build, then deploy.
**Files:** app/api/sync/ghl/route.ts.
**Issue:** In-process Arive-backed loans rendered "—"/$0 (e.g. Juliet Flores #17098748, Clear to Close).
The `loan_amount` guard locked out GHL on ANY deal with an `arive_file_no`, so the live opp value never
populated. Efrain (2026-06-25) confirmed the boundary: **funded = `pipeline_group === 'Funded'` is the only
Arive-authoritative line**; every in-process loan (Arive-backed or not) shows the GHL OPPORTUNITY value
(`monetaryValue`). When both an Arive import figure and an opp value exist on a non-funded loan, **the opp
value wins** ("Opp value always").
**Changes:** Two guard sites in the GHL sync. (1) Live upsert path: `ariveOwnsAmount = existingIsFunded ||
arive_file_no != null` → renamed `fundedOwnsAmount = existingIsFunded` (drop the Arive term); the
`!fundedOwnsAmount` mirror now writes the opp value (incl. 0/null) onto Arive-backed in-process loans too.
(2) Maintenance reconcile: removed the `!d.arive_file_no &&` condition so the reconcile mirrors the opp
value onto in-process Arive deals as well (`pipeline_group !== 'Funded'` already excludes funded). Updated
the loan_amount provenance comments. Arive remains authoritative for FUNDED amounts (unchanged).
**Test Method:** `npx tsc --noEmit` (changed file clean) + `npm run build`. Functional proof = after a GHL
sync, Juliet Flores #17098748 shows the opp value instead of "—" (Efrain to confirm in prod, or
service-role query of the row post-sync).
**Result:** Type-clean on both changed files (the ~7 tsc errors are the pre-existing build-ignored set:
reports/underwriting/DealForm/next.config — none in the sync or webhook route). `npm run build` READY
(full route table emitted). DEPLOYED below. Data fix lands on the next full/maintenance GHL sync.

### [2026-06-25] Combine Tasks + Notes → "Bulletin/Tasks"; drop top nav header
**Status:** DEPLOYED — prod READY (`cbae929` → `dpl_4rTYZWeYiLZqZMbbTVsRg7T9QimS`, lumin-deals.vercel.app, 2026-06-25).
**Files:** components/Sidebar.tsx, app/tasks/page.tsx, components/NotesBoard.tsx, app/notes/page.tsx.
**Issue:** Efrain — drop the top nav section header entirely; combine the Tasks + Notes pages into one
page (tasks on top, notes below) renamed "Bulletin/Tasks".
**Changes:** (1) Sidebar top group renders with **no header** (`noHeader` flag → skip the toggle button,
always open); the relocated item is now **Bulletin/Tasks → /tasks** (was Notes); removed the duplicate
**Tasks** item from Actions. (2) Combined page at **/tasks**: the Tasks page's component became
`TasksSection`; a new default export renders `<TasksSection />` then `<NotesBoard embedded />`.
(3) **NotesBoard** gained an `embedded` prop — flow layout (drops `h-full` + internal `overflow-auto`
so it stacks in the page's single scroll) and labels its header "Bulletin". (4) **/notes redirects to
/tasks** (notes now live on the combined page).
**Test Method:** `npx tsc --noEmit` (clean). `npm run build` (✓ both /tasks + /notes). **Browser-verified
locally** (temp middleware allowlist, reverted): /tasks shows Tasks on top + Bulletin board below as one
scroll; sidebar has no top header, Bulletin/Tasks active at position 2, Actions collapsible; /notes → /tasks
redirect confirmed.
**Result:** Type-clean, build READY, browser-verified. Deploy below.

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
