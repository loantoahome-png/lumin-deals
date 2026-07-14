# Lead Triage System — Implementation Plan

Spec: `docs/specs/2026-07-14-lead-triage-spec.md`. No DB migration. Deploy per auto-deploy policy.

## Tasks

1. **`lib/triage.ts`** (pure logic, no I/O)
   - `UNDECIDED_STATUSES`, `isOpen(deal)`, `leadAgeDays(deal, now)`, `triageTier(deal, now)` →
     `'clock' | 'decide' | 'overdue' | 'backlog'` (0–4 / 5–7 / 8–30 / >30).
   - `checkinTier(deal, now)` → `'none' | 'overdue' | 'soon' | 'scheduled'` (soon = ≤7d).
   - Task-eligibility: `needsDecisionTask(deal, now)` (undecided, open, 5 ≤ age < 8),
     `needsCheckinTask(deal, now)` (open NRT, due ∈ [now−3d, now+24h]), title builders
     `decisionTaskTitle(deal)` / `checkinTaskTitle(deal)`.
   - Verify: `scripts/triage-check.ts` fixtures (~20: tier boundaries at 5/8/31 days, anchor fallback,
     lost/abandoned excluded, checkin windows, title stability).
2. **`components/TriageDateModal.tsx`** — shared required-date modal (presets +1/2/3/6 months, custom date,
   optional note). Returns `{ dueIso, note }`.
3. **`components/TriageQueue.tsx`** — triage tab list: tier sections (backlog collapsed), row layout per spec,
   per-row + bulk dispositions (App Intake / NRT via modal / Remove from Automations / more-menu), select-all
   within section.
4. **`components/CheckinQueue.tsx`** — check-ins tab: Overdue / Due this week / Scheduled / No date sections;
   actions Re-engage / Reschedule / App Intake / Remove from Automations; "Set date" on no-date rows.
5. **`app/hot-leads/page.tsx`** — 4 tabs (Triage · Responded/Pitching · App Intake · Check-ins); second
   `fetchAllDeals` (DEAL_COLUMNS) for the extra statuses; merged state; tab counts + tier metrics in header;
   `handleDisposition` glue (status+group+next_action fields+`pushStageToGHL`); Triage = default tab.
6. **`app/api/cron/triage-tasks/route.ts`** — `runTriageTaskCheck()` per spec (title-dedup via one
   `deal_tasks` query, caps, `notifyTaskEmail` best-effort) + authed GET; call it from
   `app/api/cron/ghl-sync/route.ts` next to `runSecondCallbackCheck` and include counts in the response/log.
7. **Gate + deploy:** `npx tsx scripts/triage-check.ts` green · `npx tsc --noEmit` (0 new vs 7 baseline) ·
   `npm run build` → commit → push → `vercel --prod`.
8. **Docs:** VERIFICATION-LOG entry, CLAUDE.md pages list, memory note, handoff update. Delete
   `scripts/_tmp-triage-census.mts`.

## Verification

- Fixtures for all pure logic (tier boundaries are the bug-prone part).
- Live DOM check via Control Chrome on prod after deploy (tab counts vs census numbers).
- Cron: DO NOT trigger a manual live run blindly — first deploy, then hit the authed GET once and confirm
  creations ≤ caps and titles/dedup correct (creates real tasks + emails for day-5–8 leads only; census says
  this cohort is small).
