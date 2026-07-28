// Fixture check for the incremental-sync cursor decision (2026-07-28).
//
// Run: npx tsx scripts/sync-cursor-check.ts
//
// Guards the bug where a missed opportunity was missed FOREVER. GHL's opportunity
// search index lags the live record, so an opportunity can slip past the 10-minute
// overlap window once — and because its `updatedAt` never moves again, every later
// run filtered it out. Maintenance runs fetch the complete list but only for the
// PRUNE, so they didn't rescue it either. Eleven of Randy's leads sat unseen for
// four days (one at Appointment Booked, most priced) until a manual ?full=1.
import { shouldProcessOpportunity } from '../lib/syncCursor'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}

const CURSOR = Date.parse('2026-07-28T12:00:00Z')
const NEWER  = '2026-07-28T13:00:00Z'
const OLDER  = '2026-07-24T01:02:00Z'   // the shape of the leads that went missing
const known  = (...ids: string[]) => new Set(ids)

// ── Ordinary cursor behaviour (unchanged) ────────────────────────────────────
eq('changed since the cursor → process',
  shouldProcessOpportunity(NEWER, CURSOR, 'opp1', null), { process: true, rescued: false })
eq('exactly at the cursor → process (boundary is inclusive)',
  shouldProcessOpportunity('2026-07-28T12:00:00Z', CURSOR, 'opp1', null), { process: true, rescued: false })
eq('older than the cursor, no rescue set → skip (old behaviour preserved)',
  shouldProcessOpportunity(OLDER, CURSOR, 'opp1', null), { process: false, rescued: false })

// A missing or unusable timestamp must never cause a silent skip.
eq('no timestamp → process',
  shouldProcessOpportunity(null, CURSOR, 'opp1', null), { process: true, rescued: false })
eq('empty timestamp → process',
  shouldProcessOpportunity('', CURSOR, 'opp1', null), { process: true, rescued: false })
eq('unparseable timestamp → process, never NaN-skipped',
  shouldProcessOpportunity('not-a-date', CURSOR, 'opp1', null), { process: true, rescued: false })

// ── THE FIX: rescue opportunities that were never ingested ───────────────────
eq('THE REGRESSION: old timestamp + no deal for it → RESCUED',
  shouldProcessOpportunity(OLDER, CURSOR, 'ghost', known('other')), { process: true, rescued: true })
eq('old timestamp + we already have the deal → still skipped (no extra work)',
  shouldProcessOpportunity(OLDER, CURSOR, 'known1', known('known1')), { process: false, rescued: false })
eq('newer than cursor is NOT counted as a rescue',
  shouldProcessOpportunity(NEWER, CURSOR, 'ghost', known('other')), { process: true, rescued: false })

// Rescue must not fire on a plain incremental ping (knownOppIds is null there),
// or the sync would re-ingest the whole book on every 15-minute tick.
eq('null knownOppIds → no rescue attempted',
  shouldProcessOpportunity(OLDER, CURSOR, 'ghost', null), { process: false, rescued: false })
eq('empty knownOppIds set → still rescues (set is present, id simply unknown)',
  shouldProcessOpportunity(OLDER, CURSOR, 'ghost', known()), { process: true, rescued: true })

// Degenerate ids must not be treated as "unknown" and rescued on every pass.
eq('missing opportunity id → no rescue',
  shouldProcessOpportunity(OLDER, CURSOR, null, known('a')), { process: false, rescued: false })
eq('blank opportunity id → no rescue',
  shouldProcessOpportunity(OLDER, CURSOR, '   ', known('a')), { process: false, rescued: false })

console.log(`\n${fail === 0 ? '✅' : '❌'} sync-cursor-check: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
