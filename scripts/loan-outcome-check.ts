// Fixture check for lib/loanOutcome.ts — the Loan History open/closed split.
// Run: npx tsx scripts/loan-outcome-check.ts   (pure, no DB)
//
// Locks the three real shapes found in the live table on 2026-08-28:
//   • 113 deals carry an Arive adverse date, and 30 of them still read a LIVE
//     stage (Disclosed / Submitted to UW / Approved w/ Conditions) — so status
//     alone must never decide the bucket.
//   • Robert Petrilak's three closed loans are ghl_status='lost' with NO adverse
//     date — the case that motivated the feature. They must land in `closed`.
//   • Funded always wins: a stale `lost` on a funded row must not hide volume.
//   • Not Ready is NOT death: those leads are parked and get resurfaced.
import { isAdverse, isClosedLoan, closedReason, splitByOutcome, type OutcomeDealLike } from '../lib/loanOutcome'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}
const d = (p: Partial<OutcomeDealLike>): OutcomeDealLike =>
  ({ status: 'New Lead', pipeline_group: 'Leads', ghl_status: 'open', adverse: null, ...p })

// ── adverse detection ──────────────────────────────────────────────────────
eq('adverse date set', isAdverse(d({ adverse: '2026-05-18' })), true)
eq('adverse null', isAdverse(d({ adverse: null })), false)
eq('adverse blank string', isAdverse(d({ adverse: '   ' })), false)

// ── adverse loans that still read a live stage (30 real rows) ──────────────
eq('adverse + Submitted to UW → closed',
  isClosedLoan(d({ status: 'Submitted to UW', pipeline_group: 'Not Ready', adverse: '2026-05-18' })), true)
eq('adverse + Approved w/ Conditions → closed',
  isClosedLoan(d({ status: 'Approved w/ Conditions', pipeline_group: 'Not Ready', adverse: '2026-07-21' })), true)
eq('adverse reason wins over lost',
  closedReason(d({ pipeline_group: 'Not Ready', ghl_status: 'lost', adverse: '2026-05-12' })), 'Adverse Action')

// ── the Petrilak case: lost, never adverse ────────────────────────────────
const petrilak = [
  d({ status: 'Not Ready - Timeframe', pipeline_group: 'Not Ready', ghl_status: 'lost' }),
  d({ status: 'App Intake',            pipeline_group: 'Leads',     ghl_status: 'lost' }),
  d({ status: 'Not Ready - Timeframe', pipeline_group: 'Not Ready', ghl_status: 'lost' }),
]
eq('all 3 Petrilak loans closed', petrilak.map(isClosedLoan), [true, true, true])
eq('lost + Leads group still closed', closedReason(petrilak[1]), 'Lost')

// ── funded always wins ────────────────────────────────────────────────────
eq('funded + stale lost → open',
  isClosedLoan(d({ status: 'Loan Funded', pipeline_group: 'Funded', ghl_status: 'lost' })), false)
eq('funded + adverse date → open',
  isClosedLoan(d({ status: 'Loan Funded', pipeline_group: 'Funded', adverse: '2026-05-01' })), false)
eq('funded reason is null', closedReason(d({ status: 'Loan Funded', pipeline_group: 'Funded' })), null)

// ── live loans stay open ──────────────────────────────────────────────────
eq('open escrow stays open',
  isClosedLoan(d({ status: 'Clear to Close', pipeline_group: 'Loans in Process', ghl_status: 'open' })), false)
eq('open lead stays open', isClosedLoan(d({ status: 'New Lead', pipeline_group: 'Leads' })), false)
eq('won + open is active (won-status rule)',
  isClosedLoan(d({ status: 'Docs Signed', pipeline_group: 'Loans in Process', ghl_status: 'won' })), false)
eq('null ghl_status stays open', isClosedLoan(d({ ghl_status: null })), false)

// ── other closed reasons ──────────────────────────────────────────────────
eq('abandoned', closedReason(d({ ghl_status: 'abandoned' })), 'Abandoned')

// ── Not Ready is NOT a death signal (Efrain, 2026-08-28) ───────────────────
// These leads are parked, not dead — lib/triage.ts resurfaces Not Ready - Timeframe
// on its check-in date. Bucketing them as closed would hide live follow-up work.
eq('Not Ready - Timeframe, still open in GHL → OPEN',
  isClosedLoan(d({ status: 'Not Ready - Timeframe', pipeline_group: 'Not Ready', ghl_status: 'open' })), false)
eq('Non-Responsive, still open in GHL → OPEN',
  isClosedLoan(d({ status: 'Non-Responsive', pipeline_group: 'Not Ready', ghl_status: 'open' })), false)
eq('Old Deals parked, still open in GHL → OPEN',
  isClosedLoan(d({ status: 'Non-Responsive', pipeline_group: 'Old Deals', ghl_status: 'open' })), false)
eq('Not Ready + lost → closed (the lost is what kills it, not the group)',
  closedReason(d({ status: 'Not Ready - Timeframe', pipeline_group: 'Not Ready', ghl_status: 'lost' })), 'Lost')

// ── split preserves order ─────────────────────────────────────────────────
const mixed = [
  d({ status: 'Loan Funded', pipeline_group: 'Funded' }),
  d({ status: 'Disclosed', pipeline_group: 'Not Ready', adverse: '2026-03-02' }),
  d({ status: 'Clear to Close', pipeline_group: 'Loans in Process' }),
  d({ status: 'App Intake', pipeline_group: 'Leads', ghl_status: 'lost' }),
]
const s = splitByOutcome(mixed)
eq('split open count', s.open.length, 2)
eq('split closed count', s.closed.length, 2)
eq('split open order', s.open.map(x => x.status), ['Loan Funded', 'Clear to Close'])
eq('split closed order', s.closed.map(x => x.status), ['Disclosed', 'App Intake'])

console.log(`\nloan-outcome-check: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
