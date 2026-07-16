// Fixture check for the 2026-07-16 dashboard stage_events logging fix.
//
// Run: npx tsx scripts/push-stage-log-check.ts
//
// Guards the rules in app/api/deals/[id]/push-stage/route.ts:
//   1. opportunityId prefers the ghl_opportunity_id COLUMN over raw_ghl_data.id
//      (the column is what /lead-roi's firstOptout map is keyed by)
//   2. oppStatus='lost' must NOT log — that's a won/lost flip that leaves the
//      stage alone, so logging would invent a move that never happened
//   3. a duplicate within the 2-min window must NOT log twice
//
// Context: dashboard-origin moves were invisible to stage_events because the
// client writes deals.status BEFORE the GHL echo arrives, so the webhook's
// echo-guard suppressed them. /lead-roi opt-out timing sat at 5.7% coverage.
// See docs/diagnoses/2026-07-16-optout-timing-gap.md

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}

// ── Mirrors of the route's decision logic ────────────────────────────────────
function resolveOppId(deal: { ghl_opportunity_id?: string | null; raw_ghl_data?: Record<string, unknown> | null }) {
  const raw = deal.raw_ghl_data ?? {}
  return (deal.ghl_opportunity_id ?? null) ?? (raw.id as string | undefined) ?? null
}
function shouldLog(oppStatus: string | undefined, dupeFound: boolean) {
  if (oppStatus === 'lost') return false
  return !dupeFound
}

const OPP = '4jHxP2JJCpRXom8s7No0'

// ── 1. opportunity id resolution ─────────────────────────────────────────────
eq('column wins over the raw blob',
  resolveOppId({ ghl_opportunity_id: OPP, raw_ghl_data: { id: 'STALE_BLOB_ID' } }), OPP)

eq('falls back to raw_ghl_data.id when the column is null',
  resolveOppId({ ghl_opportunity_id: null, raw_ghl_data: { id: OPP } }), OPP)

eq('null when neither is present (push no-ops, nothing to key on)',
  resolveOppId({ ghl_opportunity_id: null, raw_ghl_data: null }), null)

// THE REGRESSION this fix depends on: /lead-roi keys firstOptout by
// ghl_opportunity_id. Logging the blob's id instead would silently fail to join.
eq('blob id is NOT used when the column exists (join key must match /lead-roi)',
  resolveOppId({ ghl_opportunity_id: OPP, raw_ghl_data: { id: 'other' } }) === 'other', false)

// ── 2. the mark-lost guard ───────────────────────────────────────────────────
eq('oppStatus=lost → do NOT log (stage did not move)', shouldLog('lost', false), false)
eq('oppStatus=open → log',                             shouldLog('open', false), true)
eq('oppStatus undefined → log (plain stage change)',   shouldLog(undefined, false), true)

// ── 3. dedup ─────────────────────────────────────────────────────────────────
eq('duplicate inside the 2-min window → do NOT log', shouldLog(undefined, true), false)
eq('no duplicate → log',                             shouldLog(undefined, false), true)
eq('lost + duplicate → still no log',                shouldLog('lost', true), false)

console.log(`\n${fail === 0 ? '✅' : '❌'} push-stage-log-check: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
