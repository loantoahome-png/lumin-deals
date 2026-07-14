@AGENTS.md

---

# Project Overview — Lumin Deals Dashboard

## What It Is
An internal mortgage pipeline management dashboard for **Lumin Lending** (two LOs: Moe Sefati and Matt Park). It syncs from GoHighLevel (GHL), stores data in Supabase, and adds deal tracking, team tooling, and automated alerts on top. GHL drives stage/contact/messaging; **Arive (the LOS) is the source of truth for the loan AMOUNT** (and funded $).

## Loan amount source — GHL opportunity value (SHIPPED 2026-06-26)
The dashboard AMOUNT = the **GHL opportunity value** (`monetaryValue` — the figure shown ON the opp card in
GHL) for every **in-process** loan; NOT the unreliable GHL stored "Loan Amount" custom field. **Funded**
(`pipeline_group === 'Funded'`) is the ONLY Arive-authoritative line. Efrain's rule: opp value always for
in-process, Arive for funded.

**Shipped 2026-06-26:** both sync guard sites dropped the Arive lock (upsert `fundedOwnsAmount =
existingIsFunded`; maintenance reconcile dropped the `!d.arive_file_no` condition). The **webhook** now also
writes `loan_amount` from the opp `monetaryValue` in real time (presence-gated, non-funded only — fed by the
GHL "LD stage" workflow's `monetaryValue → {{opportunity.lead_value}}` custom field). Full provenance in the
`loan-amount-provenance` memory + `~/.claude/handoffs/lumin-deals.md`. NOTE: visible on the next "Sync GHL";
the opp value may not always equal the loan amount (GHL data quality — watch the in-process volume).

## Recent Changes (2026-06-30)
- **Lender List** (`/lenders`) — editable directory of ~82 approved lenders. `lib/lenders.ts` (from
  `scripts/parse_lenders.py`) is the SEED; live team list in `sync_state 'lenders_list'` via `app/api/lenders`
  (like /api/tools). ✏️/Add/Delete via `LenderEditModal`. Don't re-propose live Google-Sheet pull.
- **Cron GHL sync hardened** — `app/api/cron/ghl-sync` returns instantly + runs the sync in `after()`. Root cause
  of stale-dashboard/lost-not-reflecting bugs was **cron-job.org's 30s request-timeout** killing heavy runs (it's
  the trigger; not a Vercel cron). cron-job.org pass/fail is no longer meaningful — use LastSyncBadge/logs.
- **Next-step LOG** on the escrow card — `next_action` is now a timestamped history (`next_action_log` jsonb).
  `components/NextStepLog.tsx`: prominent current step + **+**-opens-a-popup. `next_action` mirrors the latest
  entry. **Migration `next_action_log` RUN.** Dashboard "Next Steps" shows latest + "· Xago".
- **Full Sync button** in the sidebar (`/api/sync/ghl?full=1`) — use after renaming a GHL contact (incremental
  won't catch contact renames; a full sync re-pulls all contacts). NOTE: a full sync can surface a co-borrower's
  dormant opp as a duplicate card.
- **Removed Past-SLA notifications** from `NotificationBell` (kept lock-expiry + tasks).
- **Borrower override REVERTED** — built `borrower_locked` then removed it; borrower identity is GHL-owned, fix at
  the GHL source (reassign the contact/opp). **`borrower_locked` migration NOT run.**

## Recent Changes (2026-06-26)
- **Loan amount = GHL opp value for in-process loans** (see section above); the **webhook** now writes it in
  real time too.
- **Loan Officer:** `LOAN_OFFICERS` enum is the canonical `'Matt Park'` (was `'Matt'` → blank dropdowns on
  711 deals); `resolveLO` shared in `lib/loanOfficer.ts` (sync + webhook + Arive importer); 94 `Matthew Park`
  rows normalized to `Matt Park`.
- **Notes/Bulletin** (`/tasks`): card grid → vertical list rows + a pop-out modal that opens in VIEW mode with
  an Edit button (`components/NotesBoard.tsx`).
- **Dashboard:** removed the date-range filter (All Time/MTD/QTD/YTD/Custom) — it's a current-escrow snapshot.

## Recent Changes (2026-06-22)
- **`loan_amount` is Arive-authoritative.** GHL no longer writes/overwrites `loan_amount` on any Arive-backed (`arive_file_no`) or funded deal — only fills pre-Arive leads from the opp value. Dropped the unreliable GHL `customField('Loan Amount')` source (it once put $610k on a $150k loan).
- **Dashboard redesign** — hero metric, depth, metrics-first hierarchy.
- **Active Escrows card** (`EscrowTracker.tsx`) — grey box = Lender·Amount·LO; added "Subbed on teams" (`subbed`) + "Processor Handoff" (`processor_handoff`, new col) checkboxes; follow-up moved into Next Step; removed In-Stage + Waiting-On.
- **Labels renamed** Investor→Lender, Investor File #→Lender Loan # (display only; columns unchanged).
- See `~/.claude/handoffs/lumin-deals.md` — next session: which Arive export fields to add for a daily import.

## Tech Stack
- **Framework**: Next.js 16 (App Router, TypeScript)
- **Database**: Supabase (Postgres via PostgREST)
- **Auth**: Supabase Auth
- **Deployment**: Vercel (`lumin-deals.vercel.app`, project: `loantoahome-pngs-projects/lumin-deals`)
- **Email**: Brevo transactional API (env: `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`)
- **Deploy command**: `vercel --prod` from this directory

## GHL Accounts
Two GHL sub-accounts synced in parallel:
- **Primary** (Moe Sefati): `GHL_API_KEY` + `GHL_LOCATION_ID`
- **Matt**: `GHL_API_KEY_MATT` + `GHL_LOCATION_ID_MATT`

## Sync Architecture
Driven by an **external cron on cron-job.org** — schedule is `*/15 8-18 * * 1-5` (every 15 min, 8 AM–6 PM, Mon–Fri). **CONFIRMED set to 15 min as of 2026-06-17** (Efrain verified the cron-job.org setting). This is the authoritative ping cadence — ignore any older code comments suggesting "1–2 min." Do not assume a tighter cadence when reasoning about Fluid CPU.

Per ping behavior (controlled by intervals in `app/api/cron/ghl-sync/route.ts`):
- **Every ping**: Incremental GHL sync — only fetches opportunities changed since last run
- **Every 30 min** (`CONV_REFRESH_INTERVAL_MS`): Conversations refresh — last message timestamps, unread counts, inbound/outbound direction for active leads
- **Every 3 h** (`MAINTENANCE_INTERVAL_MS`): Full opportunity fetch for orphan pruning, loan amount + contact ID reconciliation (widened from 60 min on 2026-06-17 to cut Fluid Active CPU)
- **Every 3 h** (`IDENTITY_RESOLVE_INTERVAL_MS`, widened from 30 min on 2026-06-17 to cut Fluid Active CPU): Identity resolver (`lib/identityResolver.ts`) — collapses split `borrower_id`s into the canonical person (guarded-transitive union-find over `ghl_contact_id ∪ email ∪ phone ∪ borrower_id`, never name) AND maintains the `contacts` table (one row per person, keyed by canonical `borrower_id`). Non-fatal; safety caps (component>20 / >200 rewrites) + reversible `sync_state` backup; `?full=1` forces it. Manual/dry-run: `POST /api/resolve-identities` (dry-run default)
- **Every 5 min** (`CALLBACK_CHECK_INTERVAL_MS`): Auto-creates a task for Brianne when a new lead sits in "New Lead" or "Attempted Contact" for ~45 min
- Overlap guard via `sync_state` table lock (5 min TTL)

Manual sync button in sidebar calls `POST /api/sync/ghl`.

## Contacts / Identity (Phase 1-2, 2026-06-16)
The dashboard owns the **unified person** (`contacts` table) that no upstream system can — GHL has two sub-accounts (a person = a different contact id per account) and Arive has no API. `contacts.id` = the canonical `borrower_id`, so `deals.borrower_id` is already the FK (no deals migration). Built + maintained by the identity resolver above. Pages: `/contacts` (people list) + `/contacts/[id]` (person + their loans). DDL: `supabase-contacts.sql` (needs the RLS policy in that file to be readable by the logged-in app). Long-run roadmap (per-person LTV, referral, lead-spend person-dedup) in vault `architecture-direction` + `docs/specs/2026-06-16-contacts-table-spec.md`.

**Shipped 2026-06-16 (Phase 3 + Radar):** FUB-style `/contacts` list (avatar, source sub-line, lifecycle Stage pill, sortable columns, source filter, book-of-business stats strip, Copy emails / CSV export), rich `/contacts/[id]` (read-only Details panel + milestone timeline + per-sub-account GHL links + reachability), the `/duplicates` "Same Arive file #" detector, and **Refi Radar** `/radar` (product-segmented scorer `lib/refiRadar.ts` + user-set par rates in `sync_state`). Contacts source/lifecycle are derived client-side, not in the resolver. NEXT: `/duplicates` Arive merges, curated tags + a "Refi?" pill on contacts (reuse `refiRadar`), equity capture for the gated radar plays. Full state in `~/.claude/handoffs/lumin-deals.md`.

**Shipped 2026-06-30 (Reports + Channel):** Lender List **BCC email picker** (`components/LenderEmailModal.tsx`); NEW **printable per-LO Active Escrows report** `/reports/escrows` (`app/reports/escrows/page.tsx` — LO toggle, stage groups, rate-lock/next-step/processor/Channel/loan details, top "Locks expiring ≤7d" callout, print-to-PDF; reachable via a Report button + Insights sidebar link); **Channel field** (`broker_corr` = Broker/Non-Del) — Arive "Channel" column mapped in `lib/ariveCsv.ts`, deal-form relabeled "Broker / Non-Del" + "Waiting On" field removed, Channel added to the escrow card (2×2 stats) + report ("{Channel} - {Amount}"). A CTC+Non-Del funding-alert cron was built then removed (Efrain prefers an on-demand button — pending). Fluid-CPU tuning (LastSyncBadge 30s→15min + visibility-gated; middleware skips `/api/sync-status`). Full state in `~/.claude/handoffs/lumin-deals.md`.

## Vercel Built-in Crons (`vercel.json`)
- `contingency-alerts` — daily 3 PM UTC: emails LOs at 3-day, 1-day, day-of for purchase contingency dates. Deduped via `contingency_alerts_sent` JSONB column.
- `lock-alerts` — daily 3 PM UTC: emails LOs at 5, 3, 1, 0 days before rate lock expiration on in-escrow loans. Deduped via `lock_alerts_sent` JSONB column.

## Pages
- `/` — Dashboard: KPI cards, Escrows by Stage chart, Loan Types donut, LO Performance, Needs Attention, Today's Follow-ups, Team Notes. Date filter: All Time / MTD / QTD / YTD / Custom.
- `/pipeline` — Kanban deal board
- `/hot-leads` — Responded / Pitching / App Intake; last contacted time, unread count
- `/unread` — GHL conversations with unread messages
- `/deals` — Active Escrows table
- `/funded` — Closed/funded deals
- `/contacts` — People list (FUB-style: avatar, source, lifecycle stage, sortable, source filter, CSV export, book stats strip) + person detail `/contacts/[id]` (identity, read-only Details panel, loans, activity timeline)
- `/radar` — Refi Radar: product-segmented refinance scoring over the funded book (`lib/refiRadar.ts`); user-set par rates in `sync_state`
- `/reports` — Charts and analytics
- `/lead-roi` — Lead ROI (merged Lead Performance + Lead Spend 2026-07-13): per-LO tabs ONLY (never combined), one metric set (ROI = rev÷spend ×, spend incl. retainers, funded = isFunded), lifecycle funnel, monthly trend, printable report route `/lead-roi/report`. Math in `lib/leadRoi.ts` (fixtures: `scripts/lead-roi-check.ts`). Old URLs 308-redirect.
- `/deals/new` — Manual deal creation
- `/tasks` — **Bulletin/Tasks**: team task management on top + the Notes/Bulletin board below (one page; `/notes` redirects here)
- `/tools` — Utilities incl. the **PDF Tools** hub (compress/merge/split/rotate, 100% in-browser)
- `/import/arive` — Import from Arive LOS
- `/health` — Data quality dashboard
- `/duplicates` — Detect and merge duplicate deals

## Deal Detail Page (`/deals/[id]`)
Sections: File Numbers (Arive + Investor, with Arive deep-link), Loan Details, Property Details, Lock & Appraisal, Borrower Info, Team (LO, Processor, Waiting On). Tabs/panels: Loan History, Real Estate Owned, Communications Log, Conversation Thread (GHL SMS/email), Deal Tasks, Document Checklist. Push-to-GHL button syncs stage changes back to GHL.

## Recently Removed
- 10-year Treasury chart widget (dashboard)
- Rate Watch section (deal detail pages)
- Rate Watch Alerts Banner (dashboard)
- `rate-watch` and `treasury-refresh` Vercel crons

---

# Working rules (do not skip)

## No guessing — verify before you respond
Before stating a cause, fix, or "what changed," gather the facts first. Do the
research, then answer. Specifically:

- **Diagnose from evidence, not hunches.** Read the actual code, query the real
  data (Supabase), check `vercel logs`, the GHL API, or reproduce the issue
  before naming a root cause. If a claim can be checked, check it.
- **Don't assert a fix worked unless it was verified** (tsc passes, build
  passes, data confirmed, logs/response observed). "Should work" is not done.
- **Separate fact from hypothesis.** If something genuinely cannot be verified
  yet, say so explicitly ("I haven't confirmed this — here's how I'll find
  out") instead of presenting a guess as the answer.
- **When a fix doesn't hold, stop and instrument/investigate** (logs, repro,
  data) rather than shipping another guess. One verified fix beats three
  plausible ones.
- **Prefer reading the source of truth** (the code, the DB row, the API
  response, the log line) over inferring from symptoms or memory.

## Deploy policy — AUTO-DEPLOY enabled (Efrain, 2026-06-23)
**Deploy without asking.** After a change is verified (tsc clean + `npm run build` passes + any
fixtures), **commit → push → `vercel --prod` from this directory**, then report the prod URL +
readyState. Do NOT ask "want me to deploy?" for ordinary code/UI changes.
**Still confirm** only for genuinely destructive/irreversible actions (a migration that drops or
rewrites rows, anything outward-facing, anything that spends money) — a normal deploy is reversible
(revert + redeploy). History: auto-deploy was tried 2026-06-16, reverted same day, then re-enabled
2026-06-23 after per-deploy confirmation created friction.
