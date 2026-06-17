# Plan: Rich Person View (Contacts Phase 3)

**Spec:** `docs/specs/2026-06-16-rich-person-view-spec.md`
**Scope:** one file — `app/contacts/[id]/page.tsx`. No DB, no resolver, no new deps.

## Tasks

### T1 — Derivation helpers (in-file, pure)
- `subAccountLinks(deals)` → distinct `{ url, label }` by `ghl_location_id|ghl_contact_id`, using
  `ghlContactUrl(deal)`; label from `loan_officer` ("Matt"/"Moe") else "GHL".
- `reachability(deals)` → `{ dndText, lastContacted }`. `dndText` from the first loan with a
  `dndSummary`, via `dndLabel`. `lastContacted` = max non-null `last_contacted`.
- `buildTimeline(deals)` → flat, date-desc `TimelineEvent[]` from each deal's `date_added_ghl`
  (`||created_at`), `stage_changed_at` (+`status`), `signing_date`, `funded_date`.
- **Verify:** logic only; covered by the page rendering + tsc.

### T2 — Header: reachability + jump bar
- Title-case name (`titleCase`). Add a row under identity: DND badge (red, `Ban` icon) when
  `dndText`; "Last contacted {formatDate}" when present; one GHL `<a>` per `subAccountLinks`
  (`ExternalLink` icon, opens new tab). Keep the 4 stats; add first/last activity line.
- **Verify:** a 2-sub-account person shows 2 links; a DND person shows the badge.

### T3 — Activity timeline section
- Render `buildTimeline` newest-first: date · event label · loan name (link to `/deals/[id]`) ·
  amount. Icon per kind (funded=emerald, signed=blue, stage=slate, added=slate).
- **Verify:** multi-loan person interleaves; single-loan person shows its few milestones.

### T4 — Enriched loans list
- Replace the bare table. Per loan: name+type/purpose, status badge (`STATUS_COLORS`),
  property (address, state), amount, rate, funded date, and link cell → `/deals/[id]`, GHL
  (`ghlContactUrl`), Arive (`ariveUrl` when `arive_file_no`).
- **Verify:** matches the deal's real fields; links resolve.

### T5 — Typecheck + verification log
- `npx tsc --noEmit` → confirm the file adds no NEW errors (pre-existing: `reports`,
  `underwriting`, `DealForm`, `next.config`).
- Append a CHANGED entry to `VERIFICATION-LOG.md`.

## Risks / Notes
- Keep the existing light contacts aesthetic (white surfaces, slate, blue) — do NOT adopt the deal
  page's dark hero; consistency with the contacts list matters.
- `communications` is empty — do not wire `CommunicationsLog` here.
- Browser verify is gated by the auth wall (known); rely on tsc + a visual check by Efrain on the
  live page after deploy.
