# Plan — Add Daniel McGrail-Granger as a 4th LO + a reporting-only role

**Date:** 2026-08-25 · **Mode:** Build · **Spec:** the Q&A in-session (2026-08-25), recorded below.

## Decisions taken (Efrain, 2026-08-25)

| Question | Answer |
|---|---|
| Whose numbers does Daniel see? | **The whole team's, same as Efrain.** No per-report LO lock. |
| Which pages? | **Core four:** `/reports`, `/monthly-reports`, `/lead-roi`, `/lead-cohorts`. NOT `/reports/escrows`, `/calls`, `/report-import`. |
| How hard must the restriction hold? | **Routing gate is acceptable** — same trust boundary as Hanh/Brianne/Moe/Matt. Not RLS. Documented as such. |
| ROI math | **Unchanged** — same 85% `LO_SPLIT`, he buys leads (`lead_price` on his opportunities). |

Following the **Randy precedent** unless told otherwise: Daniel is view-only.
He is NOT on the hot-leads triage clock, the follow-up queue, the 2nd-callback
auto-task, or the call report. `DEFAULT_LOS` stays `['Matt Park', 'Moe Sefati']`.

## Blocked on Efrain (code ships inert until these exist — that is safe, and is
## exactly what happened on the first Randy attempt)

- `GHL_API_KEY_3` (pit-… token) + `GHL_LOCATION_ID_3` + `NEXT_PUBLIC_GHL_LOCATION_ID_3`
- `LO_EMAIL_DANIEL` + the Supabase login email
- Confirmed name spelling as it appears in GHL and in the Arive CSV
- His Arive CSV export

## Tasks

### 1. Fourth GHL account slot
- `app/api/sync/ghl/route.ts` — `getAccounts()` gains a `daniel` slot behind
  `GHL_API_KEY_3 && GHL_LOCATION_ID_3`; `loFromAccount` (~L900) maps it to the
  canonical name.
- Verify: `getAccounts()` returns 3 accounts with no `_3` env, 4 with it.

### 2. LO identity sweep (the misattribution risk)
- `lib/loanOfficer.ts` — `LO_MAP` gains `daniel` / `mcgrail` / `granger` keys.
  No existing key is a substring of "daniel mcgrail-granger" (checked), so no
  false match. `DEFAULT_LOS` unchanged.
- `lib/types.ts` — `LOAN_OFFICERS` + `TASK_ASSIGNEES`.
- `components/LoFilter.tsx` — `LO_COLORS` (sky `#0ea5e9`; distinct from
  emerald/amber/violet).
- `lib/leadReport.ts` + `lib/cohortReport.ts` — **the two `matchesLO` copies.**
  Replace the nested ternary (whose else-branch silently falls back to another
  LO) with a `Record<Exclude<LO,'All'>, RegExp>`. Adding a 5th LO to the union
  then becomes a **compile error** until its pattern exists — this is the
  permanent fix for the trap that bit the Randy add.
- `app/reports/page.tsx` — `LO_COLORS` + the `loScorecard` list.
- `app/lead-roi/page.tsx`, `app/monthly-reports/page.tsx` — `LO_ACCENT` chips.
- `app/pipeline/page.tsx`, `app/underwriting/page.tsx`, `app/contacts/[id]/page.tsx`,
  `app/api/ghl/unread/route.ts` — LO dropdown, team card, sub-account label, inbox label.

### 3. Keep him out of the Moe+Matt-only workflows
- `app/api/cron/second-callback/route.ts` — generalize `isRandysLead` to cover
  both out-of-scope LOs (name OR GHL location), so Brianne is never auto-tasked
  on Daniel's leads.
- `app/api/cron/lock-alerts/route.ts` — route his lock alerts to `LO_EMAIL_DANIEL`
  rather than silently to nobody.
- `lib/callsApi.ts` — `callAccountLabel` already returns null for any unknown
  label, so Daniel is excluded from `/calls` by default. Comment only.

### 4. The `reporting` role
- `lib/roles.ts` — `Role` gains `'reporting'`. Allow-list = the core four.
  `/reports/escrows` must be explicitly DENIED: `canAccess` is a prefix match, so
  allowing `/reports` would otherwise let the escrow report through.
  `homeFor(role)` replaces the bare `PROCESSOR_HOME` redirect in middleware.
  Bulletin off, task board off.
  **⚠️ `roleFromUser` keeps its "no role key = admin" default — untouched.**
- `middleware.ts` — redirect to `homeFor(role)`.
- `components/Sidebar.tsx` — driven by `canSeeNavItem`, should need no change; verify.
- `scripts/set-user-role.ts` — accept `reporting`.

### 5. Verification
- `scripts/roles-check.ts` — fixtures: reporting reaches the four; is BLOCKED from
  `/reports/escrows`, `/deals`, `/contacts`, `/report-import`, `/import/arive`, `/`;
  cannot see the bulletin or any task; and the escalation attempt via
  `user_metadata` still fails.
- `scripts/lead-report-check.ts` + `scripts/cohort-report-check.ts` — Daniel
  matches Daniel, and does NOT match Moe/Matt/Randy (both directions).
- `npx tsc --noEmit` + `npm run build`.

### 6. Docs
- `docs/runbooks/add-a-user.md` — the reporting-role path + the env checklist.
