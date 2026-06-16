# Plan: Cross-Source Identity Resolver (Contacts Phase 1)

**Date:** 2026-06-16
**Mode:** Build
**Source:** docs/specs/2026-06-16-identity-resolver-spec.md
**Status:** APPROVED

## Context the executor needs (no spec reading required)

- Project: Next.js 16 App Router + Supabase via `@supabase/supabase-js`.
- Admin DB client: `import { createServiceClient } from '@/lib/supabase'` (service-role; server only).
- Normalizers ALREADY EXIST and are exported: `import { normEmail, normPhone } from '@/lib/dealMatcher'`
  (`normPhone` = digits-only last 10; `normEmail` = lowercase+trim). Do NOT reimplement them.
- Pagination pattern (PostgREST caps 1000/page): see the prune loop in
  `app/api/sync/ghl/route.ts` (`PRUNE_PAGE = 1000`, `.range(off, off+PAGE-1)`).
- Batched-write pattern: see `amountFixes` in `app/api/sync/ghl/route.ts:1228-1236`
  (chunks + `Promise.all`).
- Cron auth pattern: `app/api/cron/ghl-sync/route.ts:95-98` (`Authorization: Bearer <CRON_SECRET>`).
- **Backup location decision (APPROVED 2026-06-16):** durable backup goes to the `sync_state`
  table (key `identity_resolve_backup_<ISO>`, value = the rewrite list), because the apply path
  runs automatically from the Vercel cron where the filesystem is read-only. A local file is an
  optional extra when `!process.env.VERCEL`.
- **Run cadence (APPROVED 2026-06-16):** auto-apply, throttled to **every 30 minutes** on its own
  timer (NOT tied to the 15-min maintenance cadence). Use the existing `isDue` / `markRan` throttle
  pattern already in `app/api/cron/ghl-sync/route.ts` (same mechanism as the conversations refresh).
- `deals` columns used: `id, created_at, borrower_id, ghl_contact_id, email, phone`.

## Tasks

### Task 1: Pure resolver core + blocklist
**Files:** `lib/identityResolver.ts` (new)
**Do:**
1. `import { normEmail, normPhone } from '@/lib/dealMatcher'`.
2. Export blocklist predicates (start near-empty per spec):
   - `isWeakEmail(email: string | null): boolean` — true if `normEmail` is null OR matches
     `/^(info|admin|noreply|no-reply|support|office|sales)@/` OR is in `WEAK_EMAILS` (exported
     `Set<string>`, initially empty).
   - `isWeakPhone(phone: string | null): boolean` — true if `normPhone` is null OR the 10-digit
     value matches `/^(\d)\1{9}$/` (all-same-digit) OR is in `WEAK_PHONES` (exported `Set<string>`,
     initially empty).
   - `ghl_contact_id` is NEVER weak.
3. Define `export type ResolverDeal = { id: string; created_at: string; borrower_id: string | null;
   ghl_contact_id: string | null; email: string | null; phone: string | null }`.
4. Implement `export function resolveIdentities(deals: ResolverDeal[]): ResolverResult`:
   - Union-Find (by deal id). For each deal, derive non-weak keys: `cid:<ghl_contact_id>`,
     `email:<normEmail>` (skip if `isWeakEmail`), `phone:<normPhone>` (skip if `isWeakPhone`).
     Union deals sharing any key (map key→representative deal id).
   - Per component: `canonical` = `borrower_id` of the member with the earliest `created_at` that
     has a non-null `borrower_id`; tie-break = lexicographically smallest `borrower_id`. Members
     with a null/different `borrower_id` are rewritten to `canonical`.
   - Return `ResolverResult = { rewrites: {id,from,to}[]; componentsChanged: number;
     dealsRewritten: number; largestComponentSize: number; components: {canonical:string;
     size:number; priorBorrowerIds:string[]}[] }`. Only include components whose members are not
     all already `canonical` in `componentsChanged`.
   - PURE: no DB, no I/O, deterministic. Never match on name.
**Test:** `node --input-type=module` harness (or `scripts/resolver-fixture-check.mjs`) with fixtures,
asserting: (a) Marian's 3 rows (same email, contact-ids `hygNEpIZsaE9YCM4GzzY`×2 + `N0cIvxObM0salQtxyGAi`)
→ 1 component, canonical = oldest `created_at`'s borrower_id; (b) two deals sharing ONLY
`info@brokerage.com` → 2 components; (c) two deals sharing ONLY `0000000000` → 2 components;
(d) feeding already-canonical data → `dealsRewritten === 0`.
**Skills:** lint-and-validate, testing-gateway
**Commit:** "Add pure identity-resolver core (guarded-transitive union-find + blocklist)"
**Status:** [x]

### Task 2: I/O orchestration pass
**Depends on:** Task 1
**Files:** `lib/identityResolver.ts`
**Do:**
1. `export async function runIdentityResolutionPass(supabase, opts: { apply?: boolean;
   override?: boolean }): Promise<PassSummary>`.
2. Page ALL deals (`select id, created_at, borrower_id, ghl_contact_id, email, phone`, 1000/page).
3. `const result = resolveIdentities(deals)`.
4. Safety cap: if `!opts.override && (result.largestComponentSize > 20 || result.dealsRewritten > 200)`
   → return `{ aborted: true, reason, ...report }` and write NOTHING. (Cap = 20; see spec.)
5. If not `apply` (dry run) → return `{ dryRun: true, ...report }` (counts + up to 20 sample
   components with `from→to` and prior ids; NO full email/phone in the payload beyond what's needed).
6. If `apply`:
   a. Write backup to `sync_state`: `upsert({ key: 'identity_resolve_backup_<ISO>', value:
      result.rewrites })` BEFORE any deal write.
   b. Batch-update `borrower_id` for each rewrite (chunks of ~50, `Promise.all`, mirror
      `amountFixes`). Return `{ applied: true, dealsRewritten, backupKey }`.
7. Never `console.log` full emails/phones — counts and ids only.
**Test:** import and call with a stub supabase (or run via the Task 3 endpoint dry-run) — confirm a
dry run returns a report and performs zero writes.
**Skills:** lint-and-validate, sanitize-pii
**Commit:** "Add identity-resolution I/O pass (paginate, safety cap, sync_state backup, batched writes)"
**Status:** [x]

### Task 3: POST /api/resolve-identities endpoint  [P]
**Depends on:** Task 2
**Files:** `app/api/resolve-identities/route.ts` (new)
**Do:**
1. `export async function POST(req: Request)`. If `process.env.CRON_SECRET` is set, require
   `Authorization: Bearer <CRON_SECRET>` (mirror `app/api/cron/ghl-sync/route.ts:95-98`); else allow.
2. Parse `dryRun` (DEFAULT true — apply only when `dryRun===false`/`apply===true`) and `override`
   from query or JSON body.
3. `const supabase = createServiceClient()`; `return NextResponse.json(await
   runIdentityResolutionPass(supabase, { apply: !dryRun, override }))`.
4. Also `export async function GET()` returning a one-line usage hint (no writes).
**Test:** `curl -X POST 'http://localhost:3000/api/resolve-identities'` (dry run) → JSON report;
re-query `select count(distinct borrower_id)` before/after to confirm unchanged.
**Skills:** lint-and-validate, security-auditor (verify the auth gate blocks unauthenticated mutation)
**Commit:** "Add /api/resolve-identities endpoint (dry-run default, apply, safety override)"
**Status:** [x]

### Task 4: Hook resolver into the maintenance cron  [P]
**Depends on:** Task 2
**Files:** `app/api/cron/ghl-sync/route.ts`
**Do:**
1. Near the other throttle constants in `app/api/cron/ghl-sync/route.ts`, add
   `const IDENTITY_RESOLVE_KEY = 'identity_resolve_last'` and
   `const IDENTITY_RESOLVE_INTERVAL_MS = 30 * 60 * 1000` (30 minutes — its OWN timer, independent
   of `MAINTENANCE_INTERVAL_MS`).
2. After `const result = await runGhlSync({ full, maintenance })` (~line 117), add a NON-FATAL block
   mirroring the conversations-refresh wrap (~line 128-136), gated by its own 30-min throttle:
   `if (full || await isDue(supabase, IDENTITY_RESOLVE_KEY, IDENTITY_RESOLVE_INTERVAL_MS)) { try {
   const idr = await runIdentityResolutionPass(supabase, { apply: true }); await markRan(supabase,
   IDENTITY_RESOLVE_KEY); console.log('[Cron] identity resolve:', idr.dealsRewritten ?? 'aborted') }
   catch (e) { console.error('[Cron] identity resolve failed (non-fatal):', e) } }`.
3. Import `runIdentityResolutionPass` from `@/lib/identityResolver`. Reuse the existing `supabase`
   (already `createServiceClient()` at line 106). Do NOT make an HTTP self-call. `?full=1` bypasses
   the throttle so it can be forced on demand.
**Test:** `curl 'http://localhost:3000/api/cron/ghl-sync?full=1'` (forces a run) → log shows a
rewrite count; immediate second `?full=1` call → `0`. Without `?full=1`, it runs at most every 30 min.
**Skills:** lint-and-validate
**Commit:** "Run identity resolver on maintenance sync (non-fatal)"
**Status:** [x]

### Task 5: Verify against live data + first apply
**Depends on:** Task 3
**Files:** none (verification only)
**Do:**
1. Dry run: `POST /api/resolve-identities` → review `componentsChanged`, `largestComponentSize`,
   sample merges. Confirm `largestComponentSize <= 20` (else investigate before applying).
2. Apply: `POST /api/resolve-identities?dryRun=false`.
3. Run the acceptance queries against Supabase and record results in `VERIFICATION-LOG.md`.
**Test (acceptance criteria from the spec):**
- Marian Cooper's 3 deals (arive `16057126` / `16051877` / `17017052`) share ONE `borrower_id`
  = the oldest.
- `0` deals where one `ghl_contact_id` maps to >1 `borrower_id` (was 31).
- Immediate second apply rewrites `0` deals (idempotent).
- A constructed pair sharing only `info@…`/`0000000000` is NOT merged (covered by Task 1 fixtures;
  spot-check live if such values exist).
- Marian's group no longer appears on `/duplicates`.
**Skills:** lint-and-validate
**Commit:** (no code) — log results to VERIFICATION-LOG.md
**Status:** [x]

## Parallelism summary
- Task 1 → Task 2 (same file, sequential).
- Task 3 [P] and Task 4 [P] both depend only on Task 2 and are independent of each other.
- Task 5 depends on Task 3.

## Out of scope (Phase 1)
contacts table, `deals.contact_id` FK, contact-centric UI, refi-radar/LTV/referral features,
un-merge/split logic, fuzzy/name matching. (Phases 2-4.)
