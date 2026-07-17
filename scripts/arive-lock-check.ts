// Fixture check for lib/ariveCsv.ts buildPlan's funded-lock rule — pure, no DB.
// Run: npx tsx scripts/arive-lock-check.ts
//
// Regression guard for the 2026-07-17 "phantom fills" report: re-importing an
// already-applied Arive CSV still showed "WILL FILL BLANKS 69". Every one was
// `lock_expiration` on a FUNDED loan (39 Broker Check Received / 19 Loan
// Finalized / 11 Loan Funded, 0 non-funded). The DB trigger
// `clear_lock_expiration_on_funded` (supabase-clear-lock-on-funded.sql) nulls
// that column BEFORE any insert/update lands on a funded status — proven live:
// writing 2026-08-10 to a Loan Funded deal read back null. So the planner
// proposed a write the DB always swallowed → the preview could never reach 0
// and "fields written" was inflated by the same count.
//
// The planner now mirrors the trigger. These fixtures keep the two in lockstep.
import { buildPlan, buildMatchIndex, FUNDED } from '../lib/ariveCsv'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}

const DEAL_ID = '11111111-1111-1111-1111-111111111111'
const FILE_NO = '17066402'

// Build the plan for one CSV row against one existing deal.
function planFor(dealOverrides: Record<string, unknown>, patchOverrides: Record<string, unknown>) {
  const deal = { id: DEAL_ID, name: 'Jennifer Watkins', email: 'jw@example.com', phone: '9495550100', arive_file_no: FILE_NO, ...dealOverrides }
  const ix = buildMatchIndex([deal as never])
  const rows = [{ arive_file_no: FILE_NO, __borrower_name: 'Jennifer Watkins', ...patchOverrides }]
  const deals = new Map<string, Record<string, unknown>>([[DEAL_ID, deal]])
  return buildPlan({ rows: rows as never, deals, ix, mode: 'overwrite' })[0]
}
const lockChanges = (p: ReturnType<typeof planFor>) => p.changes.filter(c => c.field === 'lock_expiration')

// ── The reported bug: funded deal, blank lock, Arive has a date ───────────────
for (const status of [...FUNDED]) {
  eq(`funded (${status}) → lock_expiration NOT proposed`,
    lockChanges(planFor({ status, lock_expiration: null }, { lock_expiration: '2026-08-10' })).length,
    0)
}

// A stale lock date on a funded deal must not be proposed either — the trigger
// nulls it regardless, so an "overwrite" there is equally phantom.
eq('funded w/ stale lock value → no overwrite proposed',
  lockChanges(planFor({ status: 'Loan Funded', lock_expiration: '2026-01-01' }, { lock_expiration: '2026-08-10' })).length,
  0)

// ── The rule must NOT overreach: in-process loans still get their lock ────────
eq('in-process (Docs Out), blank lock → still FILLS',
  lockChanges(planFor({ status: 'Docs Out', lock_expiration: null }, { lock_expiration: '2026-08-10' }))
    .map(c => c.action),
  ['fill'])

eq('in-process (Clear to Close), differing lock → still OVERWRITES',
  lockChanges(planFor({ status: 'Clear to Close', lock_expiration: '2026-01-01' }, { lock_expiration: '2026-08-10' }))
    .map(c => c.action),
  ['overwrite'])

eq('lead stage, blank lock → still FILLS',
  lockChanges(planFor({ status: 'Arive Lead', lock_expiration: null }, { lock_expiration: '2026-08-10' }))
    .map(c => c.action),
  ['fill'])

// ── Effective status: the trigger fires on NEW.status ────────────────────────
// This import itself funds the loan, so the same write clears the lock.
eq('import FUNDS the loan (in-process → Loan Funded) → lock not proposed',
  lockChanges(planFor({ status: 'Docs Signed', lock_expiration: null }, { status: 'Loan Funded', lock_expiration: '2026-08-10' })).length,
  0)

// Inverse: a funded deal being moved BACK to in-process can hold a lock again.
eq('import un-funds the loan (Loan Funded → Re-Submittal) → lock IS proposed',
  lockChanges(planFor({ status: 'Loan Funded', lock_expiration: null }, { status: 'Re-Submittal', lock_expiration: '2026-08-10' }))
    .map(c => c.action),
  ['fill'])

// ── Other fields on a funded deal are untouched by this rule ─────────────────
eq('funded deal still fills OTHER blank fields',
  planFor({ status: 'Loan Funded', loan_amount: null }, { loan_amount: 500000, lock_expiration: '2026-08-10' })
    .changes.filter(c => c.field === 'loan_amount').map(c => c.action),
  ['fill'])

console.log(`\n${fail === 0 ? '✅' : '❌'} arive-lock-check: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
