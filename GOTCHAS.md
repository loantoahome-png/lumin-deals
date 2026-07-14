# GOTCHAS — Lumin Deals

### A GHL opportunity STATUS flip (open→lost/won) is NOT caught by the 15-min incremental sync — only the 3-hourly maintenance pass
**Tried:** Assumed a "lost" flip would demote to Not Ready within ~15 min (next incremental sync).
**Failed because:** the 15-min cron ping runs a pure **incremental** sync (`fetchOpportunitiesSince`, `app/api/sync/ghl/route.ts:495`) that pages GHL opps by `updatedAt` DESC and **early-stops** once it passes the last cursor (`if (ms < sinceMs) break`). A GHL **status change does NOT bump `updatedAt`** — only `lastStatusChangeAt` moves — so the changed opp stays in its old (older) position, below the cursor, and the scan stops before ever reaching it. The `?? lastStatusChangeAt` fallback in the comparison is moot: discovery is by updatedAt order, so it never gets there. **Live-test proof (2026-07-10):** marked Laurie Shore lost at 20:33Z; the 20:45 incremental ran (sync_state stamped; only 3 deals touched) and did NOT demote her — still `Leads/open` 15+ min later. `ghl_maintenance_last` was 18:15, so no full pass ran at 20:45.
**What works:** lost/won demotion happens only on (a) the **~3-hourly maintenance full-opp scan** (`MAINTENANCE_INTERVAL_MS = 3h`, `cron/ghl-sync/route.ts:31` → `fetchAllOpportunities` reads every opp's `status`), (b) a **manual full "Sync GHL"** / `?full=1`, or (c) the **webhook** — but the webhook only helps if GHL is configured to POST status changes to it (today it is NOT). Net real latency for a lost loan to leave Active Escrows: **up to ~3 hours**, not 15 min. Fix = wire the real-time lost webhook (deployed & ready) to a GHL "Opportunity Status Changed → Webhook" workflow.
**Project:** lumin-deals
**Date:** 2026-07-10

### `raw_ghl_data` on deals is SYNC-written, not webhook-written — don't treat captured payloads as proof of real-time webhook delivery
**Tried:** To learn what GHL POSTs to our webhook on a status change, I read `deals.raw_ghl_data` (the webhook stores `raw_ghl_data: body`). Found native GHL opportunity objects with `status:"lost"` and assumed the webhook receives them in real time.
**Failed because:** the **sync also writes `raw_ghl_data: opp`** (`app/api/sync/ghl/route.ts:908`). The tell: 30+ deals all stamped within the same 1-second `updated_at` batch = a sync run, not individual webhook POSTs. So a native-opportunity-shaped `raw_ghl_data` proves what the sync *fetched from GHL's API*, NOT what GHL *pushed to our endpoint*. Whether GHL fires a real-time webhook on opportunity status change is a GHL-side workflow/subscription config, invisible from the DB and the codebase.
**What works:** to check real-time delivery, read Vercel function logs for `/api/webhooks/ghl` (live POSTs), or inspect the GHL Workflow/webhook config directly. To learn payload *shape*, `raw_ghl_data` is fine — just don't infer *delivery* from it.
**Project:** lumin-deals
**Date:** 2026-07-10

### GHL opportunity "lost" arrives as status=lost with the stage as a pipelineStageId UUID (no stage NAME) — name-based resolution silently skips it
**Tried:** The webhook demoted lost opps only inside `if (whStage)`, where `whStage = resolveGHLStage(stageName, ...)` needs a stage NAME. Reasonable, since stage-change events carry names.
**Failed because:** GHL separates opportunity **status** (open|won|lost|abandoned) from **stage**. When the team marks a loan "lost" they LEAVE the stage, and GHL's native opportunity payload carries only `pipelineStageId` (a UUID) — never a `pipelineStageName`. So `resolveGHLStage` got no name, returned null, `whStage` was falsy, and the lost demotion was skipped entirely (fell through to the 15-min sync). Confirmed against 48 real dead payloads: every one had `status` but only a stage UUID. Bonus trap: the stage-change branch's `resolveGHLStage("lost")` *partial-matches* the key "lost to competitor" and would relabel the stage to "Lost to Competitor" — silently rewriting the real last stage.
**What works (2026-07-10):** demote off `status` DIRECTLY, independent of stage — `isDead = status==='lost' || startsWith('abandon')` → set `pipeline_group:'Not Ready'` + `ghl_status`, keep the stage label, guard Funded. Mirrors the sync's isDead rule (`sync/ghl/route.ts:806`), which never had this bug because it reads `opp.status` directly.
**Project:** lumin-deals
**Date:** 2026-07-10

### Supabase auth email links: the PKCE `code` flow CANNOT work for a dashboard-sent link
**Tried:** Building the password reset around `/auth/callback` + `exchangeCodeForSession(code)` — the pattern most
Next.js + Supabase examples show.
**Failed because:** PKCE writes a **code verifier into the originating browser's local storage** when the flow starts.
Supabase's own docs: *"the code exchange must be initiated on the same browser and device where the flow was started."*
A link sent from the **Supabase dashboard** ("Send password recovery" / "Send magic link") is server-initiated — no
verifier exists anywhere — so the exchange can never succeed. Same failure if the user opens the email on their phone
after requesting the reset on their laptop. The `code` path silently half-works: fine when you test it yourself in one
browser, broken for every real user.
**What works:** the `token_hash` + `verifyOtp({token_hash, type})` path. `VerifyTokenHashParams` takes only
`{token_hash, type}` — no email, no verifier — so it is cross-browser and works for dashboard-sent links. Requires
editing the email template to `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password`;
the default `{{ .ConfirmationURL }}` hands back a `code`, not a hash.
**Also:** in the route handler you must build the `NextResponse.redirect(...)` **before** calling `verifyOtp`, so
`setAll` can write session cookies onto it. Copying the read-only client from `app/api/underwriting/route.ts`
(`setAll: () => {}`) verifies the token and then throws the session away — you land on the reset page logged out.
**Project:** lumin-deals
**Date:** 2026-07-09

### A new unauthenticated page renders wrapped in the authed sidebar (AppShell hardcoded `=== '/login'`)
**Tried:** Adding `/forgot-password` and `/reset-password`, adding them to `isPublic` in `middleware.ts`, assuming done.
**Failed because:** `components/AppShell.tsx` decided chrome with `const isLoginPage = pathname === '/login'`. Any other
public page therefore rendered with the full sidebar — nav links, "Sync GHL", and a **Sign Out button** — around a
"Link expired" card, for a visitor with no session. `tsc` and `npm run build` both pass clean; only loading the page
in a browser shows it.
**What works:** `CHROMELESS_PATHS` set in `AppShell.tsx`, kept in step with `isPublic` in `middleware.ts`. Two
allowlists, two files — when you add a public page, edit both.
**Project:** lumin-deals
**Date:** 2026-07-09

### The GHL sync is triggered by cron-job.org (free), which has a hard 30s timeout → heavy runs were cut off
**Tried:** A loan marked "Lost" in GHL stayed on Active Escrows for ~3h. The sync DOES demote lost opps
(`effectiveGroup → 'Not Ready'`), so why didn't it apply?
**Failed because:** the GHL sync is NOT a Vercel cron (vercel.json only has the 2 daily alert crons). It's pinged
by **cron-job.org**, whose request timeout maxes at **30 seconds** (free tier). Light incremental runs finish in
~6s (200 OK), but the periodic heavy runs (maintenance reconcile + identity resolver, which catch status drift
like lost/won) exceed 30s → cron-job.org logs "Failed (timeout)" and cuts the connection, so the heavy reconcile
never completes. Net: status changes that depend on the heavy pass linger until a manual "Sync GHL".
**What works (2026-06-29):** decouple the HTTP response from the work. `app/api/cron/ghl-sync/route.ts` now
acquires the lock, returns a sub-second `{ok:true, queued:true}`, and runs the whole sync + sub-tasks in
**`after()`** (`next/server`, stable in Next 16). cron-job.org always sees a fast 200 (never times out); the sync
runs to completion in the background up to `maxDuration=300`. SAME trigger + SAME work → **no new Vercel cron, no
added usage** (rejected a `*/5` Vercel cron because it adds ~288 metered runs/day). Verified locally: response 68ms,
and the background run completed (`synced 1, 1 updated, 794ms` in the logs). The lock self-heals via its 5-min TTL
if `after()` ever fails, and the manual Sync buttons (`/api/sync/ghl`) are unchanged as a fallback.
**Trade-off:** cron-job.org now reports success even if the background sync errors (its 200 is just the ack) —
sync health is in the server logs + LastSyncBadge, not cron-job.org's pass/fail.
**Project:** lumin-deals
**Date:** 2026-06-29

### Co-borrowers split into separate GHL contacts → duplicate escrow cards for ONE loan (the "Southerby case")
**Tried:** Paul + Cynthia Southerby (one $1.22M loan, Arive #16895210) both showed on Active Escrows. Paul's card
was the worked one (lender/processor/lock/notes) but Arive-created with `ghl_opportunity_id = null`; Cynthia's was
a bare card carrying the real GHL opportunity (`ffkS…`).
**Failed because (two compounding things):** (1) The loan's borrowers each have their OWN GHL contact, and the GHL
*opportunity* was created under the CO-borrower's contact (Cynthia), not the main borrower's (Paul). The dashboard
builds a deal per opportunity and derives identity from the opp's contact → a second card. (2) **A FULL SYNC
surfaced it.** The incremental 15-min sync only processes CHANGED opps, so Cynthia's opp sat in GHL ~18 days with no
dashboard deal; the manual `?full=1` sync (run for an unrelated fix) processed ALL opps and CREATED the card. So
running a full sync can spawn "new" duplicate cards from long-dormant opps — expect it.
**What works:** fix at the GHL source, then consolidate the dashboard. (a) In GHL you CAN reassign an
opportunity's primary contact (contradicting the earlier assumption) — Efrain moved the opp to Paul's contact;
verified via `GET /opportunities/{id}` that `contactId` flipped to Paul and Cynthia's contact had 0 opps. (b) Then
attach the now-correct opp to the WORKED card (`ghl_opportunity_id = ffkS…`), DELETE the bare duplicate, and clean
co-borrowers. Keeping the worked card (vs. merging into the bare one) avoids losing fields the merge route doesn't
carry (it has no `deal_contacts`/`ghl_opportunity_id` handling and a fixed MERGEABLE_FIELDS list). Durable because
the survivor now owns the opp (sync matches it, never recreates) and the co-borrower's contact has no opps.
**Side note found:** a deal can end up with its OWN primary listed as a `role='co'` in `deal_contacts` (inflates
the "+N" co-borrower badge) — `linkCoborrower` guards against it but old data had it; delete the self-link.
**Project:** lumin-deals
**Date:** 2026-06-29

### A GHL contact RENAME doesn't reach the dashboard via the 15-min sync — only a FULL sync re-pulls it
**Tried:** A borrower was renamed in GHL (Espinoza opp: the contact `t2BK…` was changed Judith → Jesus). The
dashboard kept showing "Judith" for days, through many 15-min syncs and manual "Sync GHL" clicks.
**Failed because:** the incremental sync only re-pulls a CONTACT when its OPPORTUNITY changed —
`fetchContactsForOpps(changedOpps)`, and `changedOpps` is filtered by opportunity `updatedAt`. Renaming a contact
doesn't bump the opportunity, so the opp isn't in `changedOpps`, so the new contact name is never fetched. The
manual "Sync GHL" button and the cron are BOTH incremental (no `?full=1`); the 3-h maintenance pass re-pulls all
*opps* but contacts are gated on `isFullSync`, so it doesn't help either. Net: a pure contact rename only
propagates on a real full sync (`isFullSync` → `fetchAllContacts`).
**What works:** force a full sync — `POST /api/sync/ghl?full=1` (or the cron URL `?full=1`). It re-pulls all
contacts and `deals.name` updates from `fullContact.name` (here → "Jesus Espinoza"). Verified 2026-06-29: full
sync = 1670 synced, the deal flipped to Jesus. NOTE: this does NOT touch `borrower_id` (sync never syncs it), so
the linked CONTACT record / "View Contact" can still read the old name until the identity resolver reconciles.
**Self-serve:** the sidebar has a **Full Sync** button (the small link under "Sync GHL") that hits
`?full=1` — use it after renaming a contact in GHL.
**Project:** lumin-deals
**Date:** 2026-06-29

### React reuses a DOM node across two ternary branches of the same type → contentEditable leftover doubles
**Tried:** A modal body rendered `{mode === 'edit' ? <div ref contentEditable/> : <div><NoteMarkdown/></div>}`
with NO `key` on either branch. The editor's content is set imperatively (`ed.innerHTML = markdownToHtml(...)`),
which React doesn't track.
**Failed because:** both branches are a `<div>` at the same position, so React **reuses the same DOM node**
across the toggle instead of unmounting/remounting. When switching edit→view, React rendered `NoteMarkdown`'s
children INTO the reused node while the editor's imperatively-set `innerHTML` was still there → the note
content rendered **twice** (visible doubling after an Edit→Done cycle). Data was never affected — `updated_at`
stayed put because the markdown round-trip is idempotent, so no save fired; purely a DOM-reuse render glitch.
Caught only by browser-verifying with a DOM eval (`Abraham's States` count went 1 → 2 after Edit→Done).
**What works:** give the two branches **distinct `key`s** (`key="note-edit"` / `key="note-view"`) so React
treats them as different elements and fully swaps the node (no leftover innerHTML). The original NoteCard had
`key="note-editor"/"note-view"` for exactly this reason; a rewrite dropped them. Rule: any conditional branch
that imperatively writes innerHTML (contentEditable) MUST have a stable, distinct key vs its sibling branch.
**Project:** lumin-deals
**Date:** 2026-06-25

### GHL webhook must match by opportunity id, not contact
**Tried:** The GHL webhook handler matched an incoming opportunity event to a dashboard deal via
`findExistingDeal({ ghlContactId, email, phone })` — by contact/email/phone.
**Failed because:** one GHL **contact** can hold **multiple opportunities** (a borrower with >1 loan).
With two loans on one contact, the FUNDED loan's "Loan Funded" workflow webhook matched the borrower's
*other* (withdrawn/adverse) loan — same contact/email — and the stage-apply marked it funded. The
`.neq('pipeline_group','Funded')` guard didn't save it because the sibling wasn't funded *yet*.
Symptom: John Winn showed 2 funded loans when one was Adverse/Lost. Tell-tale in the row:
`ghl_opportunity_id` (its own) ≠ `raw_ghl_data.id` (the funded opp), and raw payload was webhook-shaped.
**What works:** `findExistingDeal` matches by **opportunity id first**; contact/email/phone fallbacks
only return a match when they resolve to **exactly one** deal (never guess a sibling). The 15-min sync
was never the culprit — it already keys by opportunity id.
**Also note:** the fix can't self-heal an already-corrupted row (funded-guard blocks the webhook from
demoting it; the sync never clears `funded_date`) — corrupted rows need a manual correction.
**Project:** lumin-deals
**Date:** 2026-06-24

### "Arive" (the LOS) showing as a lead source in reports — one of THREE `source` writers bypassed the guard
**Tried:** After `cleanSource` (sync) + `isRealLeadSource` (Arive CSV) were both added to reject "Arive",
purchased leads STILL showed `source="Arive"` in `/lead-cohorts` + `/lead-performance`. A prior memory said
the overwrite lived in `lib/ariveCsv.ts`, so that's where I'd have looked.
**Failed because:** `ariveCsv.ts` was already guarded. The leak was the **GHL webhook**
(`app/api/webhooks/ghl/route.ts`), the THIRD writer of `deals.source`, writing it RAW —
`maybeSet('source', fields.contactSource)` (:481) and an insert default of `|| 'GHL'` (:264), no `cleanSource`.
Arive stamps its own name into GHL's **native `source` attribute** on sync-back; the webhook fell through to
it. And the sync's update path never overwrites an existing source with null (to protect manual categories),
so once written the bad value **froze** — the sync could never self-heal it.
**What works:** guard EVERY writer identically — wrapped the webhook's source writes in `cleanSource()` too
(nulls "Arive" → `maybeSet` skips → the existing real vendor is preserved). The true vendor was NOT lost: it
lives in the GHL contact **"Lead Source" custom field** (not the native `source`), so a one-time service-role
backfill re-attributed 16/17. Lesson: when guarding a derived column, grep for EVERY writer
(`grep -rn "source:" app/api lib`) before trusting a "the bug is in file X" note — a single unguarded path
silently poisons the whole column.
**Project:** lumin-deals
**Date:** 2026-07-08

### "Stuck" spinner on dashboard/pipeline = slow Supabase reads, not hung code
**Tried:** Suspected a code bug / broken deploy when pages sat on their loading spinner indefinitely
(2026-07-14, ~9:15–9:19am PT). Checked error boundaries, chunk staleness, client-error beacons — all clean.
**Failed because:** Nothing was hung. `performance.getEntriesByType('resource')` in the live tab showed the
pipeline's `deals?select=*` page-1 query took **133 s** (page 2: 66 s) vs the normal ~0.2 s. The window started
right at the 09:15 GHL sync (`last_synced_at` 16:15:09Z) and recovered ~4 min later — DB-side slowness after
the sync's bulk writes. The page finished loading by itself once reads recovered.
**What works:** Diagnose from the tab, not the code: read resource timings via Control Chrome
(status + duration per Supabase call) and compare against `/api/sync-status`. If durations are 100×
normal and recover, it's a DB slow-window, not a bug. Chronic aggravator: /pipeline and /deals use
`fetchAllDeals` with `select=*`, which drags the full `raw_ghl_data` JSON blob for every deal
(Dashboard.tsx already switched to an explicit column list for exactly this reason — its comment says
"never raw_ghl_data"). Narrowing those selects would shrink the blast radius of any future slow window.
**Project:** lumin-deals
**Date:** 2026-07-14

### Bare supabase-js .select() silently caps at 1000 rows — census/analysis scripts undercount
**Tried:** A one-off service-role census script (`.from('deals').select(...).in('status', [...])`) to size the
lead-triage backlog before building; reported 881 undecided leads / 115 Not Ready - Timeframe.
**Failed because:** PostgREST returns at most 1000 rows per request unless you paginate with `.range()`. The
query matched ~1,600+ rows, so the script got an arbitrary 1000-row slice — every per-status count was wrong
(real numbers, verified on the paginated live page: 1,444 undecided, 174 NRT). The lib already knew this —
`fetchAllDeals` exists precisely to walk pages — but ad-hoc scripts bypass it.
**What works:** In any offline script that counts or aggregates deals, either loop `.range(offset, offset+999)`
until short page (copy the fetchAllDeals loop), or use `.select('...', { count: 'exact', head: true })` when only
counts are needed. Treat any round ~1000 total in a script result as a red flag.
**Project:** lumin-deals
**Date:** 2026-07-14
