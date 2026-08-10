# Spec — Processor Desk (Hanh's Active Escrows) + role-gated logins

**Date:** 2026-08-10
**Mode:** Build
**Requested by:** Efrain — "a new page for Hanh, Brianne, and me to look at all the active
escrows Hanh is assigned to; Hanh can create tasks and assign them to me or Brianne. Also
add logins for Hanh Nguyen."

---

## 1. Grounding (verified, not assumed)

Probe: `scratchpad/_probe-processor-assignment.ts` against prod Supabase, 2026-08-10.

| Fact | Value |
|---|---|
| Active escrows (`pipeline_group = 'Loans in Process'`) | **25** |
| …with `processor_status = 'Hanh Nguyen'` | **9** |
| …`Self Processing` | 5 · `Jessica Ching` 1 · **blank 10** |
| Legacy `processor` column | agrees with `processor_status` on all 10 non-blank rows |
| Hanh's 9 by LO | Moe Sefati ×8, Matt Park ×1 (zero Randy) |

So `processor_status` is real, current, and already the right key. Susan Lim has **0**
active files.

⚠️ Hanh's 9 rows include **Katherine Sison ×3** and **Jeffrey Stewart ×2**, all in active
stages. Per `[[opp-name-vs-arive-loan-id]]` same-name rows are *usually* separate loans —
but three simultaneous "Approved w/ Conditions" Sisons smells like duplicate shells.
**Open item, tracked separately — not a blocker for this page.** The page renders whatever
`deals` holds; if they're dups they get merged through `/duplicates`, and the page follows.

Existing pieces this reuses rather than rebuilds:

- `PROCESSORS` — `lib/types.ts:322`, already contains `'Hanh Nguyen'`
- Active Escrows — `app/deals/page.tsx`, locked to `Loans in Process`, filtered by **LO**
- `EscrowTracker` — `components/EscrowTracker.tsx`, the operational card
- Processor Checklist — `lib/processorChecklist.ts` + `app/deals/[id]/checklist/page.tsx`
- Tasks — `deal_tasks` table, `components/DealTasks.tsx`, `/tasks` board
  (`BOARD_COLUMNS = Efrain / Brianne / Moe / Matt`), Brevo notify via
  `app/api/tasks/notify/route.ts`
- Auth — Supabase email+password, `middleware.ts`. **No role system exists today: any
  login sees the whole app, including `/lead-roi` comp and lead spend.**

## 2. Decisions (Efrain, 2026-08-10)

1. **Access:** Hanh reaches her page + deal pages only. Everything else blocked.
2. **Assignment key:** `processor_status = 'Hanh Nguyen'`, scoped to `Loans in Process`.
3. **Tasks:** live on the deal *and* on the `/tasks` board — one row in `deal_tasks`,
   two surfaces.
4. **Write access:** full edit on her escrows.

## 3. Scope

### 3.1 Role gate (new)

Roles carried in Supabase auth **`app_metadata`** — not `user_metadata`, which the client
can rewrite via `updateUser` and would let a restricted account promote itself.

```jsonc
// Raw App Meta Data on the auth user
{ "role": "processor", "display_name": "Hanh Nguyen" }
```

- `role` absent or `"admin"` → today's behavior, full app. Efrain, Brianne, Moe, Matt
  need **no change** — absence of the key is the admin default, so nothing breaks for
  existing logins.
- `role: "processor"` → allowed routes only.

New `lib/roles.ts` — single source of truth, imported by middleware, the sidebar, and the
page:

- `PROCESSOR_ALLOWED` route prefixes: `/processing`, `/deals/` (detail + checklist),
  `/tasks`, `/api/`, plus the existing public set.
  Note `/deals/` **with the trailing slash** — the desk replaces `/deals` (the LO-filtered
  index) for a processor, but `/deals/<id>` is the file she works.
- `/` and any blocked route → redirect to `/processing`.
- `roleFromUser(user)` → `'admin' | 'processor'`; `displayName(user)` → the board name.

Middleware already calls `supabase.auth.getUser()`, so the gate costs no extra round trip.
`app_metadata` rides along on the returned user.

**Stated limitation:** this is a *routing* gate, not row-level security. `deals` RLS is
unchanged, so a processor login still holds an anon key that could read other rows
directly. That is the same trust boundary Brianne, Moe and Matt already operate under —
tightening it is real RLS work and is explicitly **out of scope here**. Flagged to Efrain.

### 3.2 `/processing` — the Processor Desk (new page)

One route, visible to everyone; it is Hanh's home and a window for Efrain and Brianne.

- **Data:** `deals` where `pipeline_group = 'Loans in Process'` **and**
  `processor_status = <processor>`.
- **Processor selector:** defaults to `Hanh Nguyen`. Admins may switch to any name in
  `PROCESSORS`; a `processor` role is pinned to their own `display_name` and the control
  renders as a static label. Built off the `PROCESSORS` array so Susan/Jessica work the
  day they get files — no code change.
- **Body:** reuse `EscrowTracker` so the card, the inline edits and the field set cannot
  drift from `/deals`. Full edit per decision 4.
- **Per-card additions:** checklist progress (via `checklistProgress`), and a **task
  strip** — open tasks for that deal with assignee + due, plus a `+` that opens the task
  composer pre-bound to the deal.
- **Header:** count, files with an overdue task, files with no open task at all, and a
  lock-expiration warning (`lock_expiration` is already tracked).

### 3.3 Task creation

- Add `'Hanh Nguyen'` to `TASK_ASSIGNEES` (`lib/types.ts:185`) so Efrain and Brianne can
  assign **back** to her.
- Add `'Hanh Nguyen'` to `BOARD_COLUMNS` (`app/tasks/page.tsx:43`). The 2×2 grid becomes
  a 5-column layout; the existing `OTHER_COLUMN` catch-all stays so nothing hides.
- `assigned_by` is stamped from the signed-in user's `display_name` (resolved through the
  same `lib/roles.ts` helper the checklist page's `done_by` pattern uses), instead of
  today's blank/manual value.
- Email: add Hanh to `emailForName` in `app/api/tasks/notify/route.ts` via
  `PROCESSOR_EMAIL_HANH`, with the same `n.includes('hanh')` fallback shape as Brianne.
  **Needs Hanh's work email from Efrain.**

### 3.4 Sidebar

`components/Sidebar.tsx` filters its groups through `PROCESSOR_ALLOWED`. A processor sees
Processing, the deal she's on, and Tasks — the Insights / Data groups (Lead ROI, Funded,
Reports, Import) never render. Admins see the full nav plus a new **Processing** entry
under Pipeline.

## 4. Migration

**None.** Every column this needs (`processor_status`, `pipeline_group`,
`processor_checklist`, `deal_tasks`) already exists. The only external change is the
Supabase auth user and its `app_metadata` — done in the dashboard, not in SQL.

## 5. Acceptance criteria

1. `/processing` lists exactly the 9 files where `processor_status = 'Hanh Nguyen'` and
   `pipeline_group = 'Loans in Process'` — verified against the probe count.
2. Hanh's login: `/processing` renders; `/lead-roi`, `/funded`, `/reports`,
   `/import/arive`, `/lead-cohorts`, `/health` each redirect to `/processing`; `/` also
   redirects there; those items are absent from her sidebar.
3. Efrain's and Brianne's logins are byte-for-byte unchanged — full nav, every route.
4. A task Hanh creates on an escrow, assigned to Brianne, appears in Brianne's column on
   `/tasks` and on the deal's task list, with `assigned_by = 'Hanh Nguyen'`.
5. `TASK_ASSIGNEES` offers Hanh, so Efrain can assign to her from `/tasks`.
6. Hanh can edit a field on one of her escrows and it persists.
7. A `processor`-role account cannot self-promote: `supabase.auth.updateUser` writes
   `user_metadata`, which the gate does not read.
8. `npx tsc --noEmit` shows the same 7 pre-existing errors, no new ones;
   `next build` passes; all fixture checks exit 0.

## 6. Out of scope

- Row-level security on `deals` for processor accounts (see 3.1 limitation).
- The Katherine Sison / Jeffrey Stewart duplicate question.
- Giving Susan Lim or Jessica Ching logins — the page supports them, the accounts don't
  exist and weren't asked for.
- Any change to how `processor_status` gets populated (Arive/GHL sync untouched).
