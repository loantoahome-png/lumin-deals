# Runbook — Real-time "Opportunity Lost" → dashboard webhook

**Goal:** when an opportunity is marked **Lost** (or Abandoned) in GHL, POST it to the dashboard
webhook so the deal demotes to **Not Ready in seconds** — instead of waiting up to ~3 h for the
maintenance full-opp scan (the 15-min incremental sync misses status-only flips; see GOTCHAS).

**Prereq (code):** already deployed. `app/api/webhooks/ghl/route.ts` has a block that, on any payload
with `status` = lost/abandoned, matches the deal (opportunity-id first) and sets
`pipeline_group='Not Ready'` + `ghl_status`, guarding Funded. It just needs GHL to send the event.

**Endpoint:** `https://lumin-deals.vercel.app/api/webhooks/ghl` — requires the shared secret as
`?secret=<GHL_WEBHOOK_SECRET>` (query param) OR an `x-webhook-secret` header. Same secret the
existing `LD stage` / `Connect CRM - stage changes` workflows already use.

---

## Step 0 — Grab the webhook URL (with secret) to reuse
Do NOT retype the secret — copy the URL from a workflow that already posts to us:
1. GHL → **Automation → Workflows** → open **`Connect CRM - stage changes`** (or `LD stage`).
2. Click its **Webhook / Custom Webhook** action.
3. Copy the full **URL** field — it looks like
   `https://lumin-deals.vercel.app/api/webhooks/ghl?secret=XXXXXXXX`. Keep it; back out without saving.
   *(Alternative: Vercel → project → Settings → Environment Variables → `GHL_WEBHOOK_SECRET`.)*

## Step 1 — New workflow
Automation → Workflows → **+ Create Workflow → Start from scratch**.
Name: **`LD — Opportunity Lost → Webhook`**.

## Step 2 — Trigger
1. **Add New Trigger** → **"Opportunity Status Changed"**.
2. Add filter: **Status → is → Lost**. (To also cover abandoned, add **Abandoned** as a second
   value if allowed, or add a second identical trigger for Abandoned.)
3. Leave pipeline unfiltered (covers all pipelines). Save.

## Step 3 — Webhook action
1. **+** → **Actions → Webhook** (a.k.a. Custom Webhook / "POST").
2. **Method:** POST.
3. **URL:** paste the URL from Step 0 (the one with `?secret=...`).
4. **Payload:** send GHL's **standard** opportunity payload (it includes `status`, `id`,
   `contactId`, `pipelineStageId` — exactly what the webhook reads). If the builder forces a
   **custom** body, map at minimum: opportunity **Status → key `status`**, opportunity **Id → key
   `id`**, **Contact Id → key `contactId`**.
5. Save.

## Step 4 — Publish
Toggle the workflow **Publish / On** (top-right). Enable **Allow Re-Entry** so the same opp can
trigger again on later changes.

## Step 5 — Replicate per sub-account
Workflows are per-location. Loans get marked lost in each LO's sub-account, so repeat Steps 1–4 in:
- **Moe (primary)** `PKEBK2NXDuug25VABQ61`
- **Matt** `84fCsPjMP7RHe8P6JEe0`
- **Randy** `arZ4QDCzS0Vkj0ZvLZdv`
Build + test in ONE first (Moe's), confirm it works, then clone to the other two.

## Step 6 — Live verification (Claude does this)
Mark one test opportunity **Lost** and ping Claude. Claude watches the webhook logs + the deal's DB
state and confirms it demotes to Not Ready in seconds. This catches any secret/payload mismatch
immediately (e.g. a 401 = wrong/missing secret; no demotion = payload didn't carry `status`).

---

### If you'd rather extend an existing workflow (faster, but check first)
If `Connect CRM - stage changes` contains **only** a webhook action (no other side-effects like
stage moves / notifications), you can just add **"Opportunity Status Changed" (Status = Lost)** as a
second trigger on it and skip Steps 1/3 — it already has the right URL+secret+payload. Only do this
if that workflow is webhook-only; otherwise the new dedicated workflow above is safer.
