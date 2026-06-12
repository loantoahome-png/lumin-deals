@AGENTS.md

---

# Project Overview — Lumin Deals Dashboard

## What It Is
An internal mortgage pipeline management dashboard for **Lumin Lending** (two LOs: Moe Sefati and Matt Park). It syncs from GoHighLevel (GHL) as the source of truth, stores data in Supabase, and adds deal tracking, team tooling, and automated alerts on top.

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
Driven by an **external cron on cron-job.org** — schedule should be `*/15 8-18 * * 1-5` (every 15 min, 8 AM–6 PM, Mon–Fri).

Per ping behavior (controlled by intervals in `app/api/cron/ghl-sync/route.ts`):
- **Every ping**: Incremental GHL sync — only fetches opportunities changed since last run
- **Every 30 min** (`CONV_REFRESH_INTERVAL_MS`): Conversations refresh — last message timestamps, unread counts, inbound/outbound direction for active leads
- **Every 60 min** (`MAINTENANCE_INTERVAL_MS`): Full opportunity fetch for orphan pruning, loan amount + contact ID reconciliation
- **Every 5 min** (`CALLBACK_CHECK_INTERVAL_MS`): Auto-creates a task for Brianne when a new lead sits in "New Lead" or "Attempted Contact" for ~45 min
- Overlap guard via `sync_state` table lock (5 min TTL)

Manual sync button in sidebar calls `POST /api/sync/ghl`.

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
- `/reports` — Charts and analytics
- `/lead-spend` — Cost per lead source
- `/deals/new` — Manual deal creation
- `/tasks` — Team task management
- `/tools` — Utilities including PDF compressor
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
