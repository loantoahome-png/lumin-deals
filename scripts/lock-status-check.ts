// Fixture check for lib/lockStatus.ts — pure, no DB.
// Run: npx tsx scripts/lock-status-check.ts
//
// Locks the two rules that the live data proved matter (measured 2026-09-16):
//
//  1. `lock_expiration` decides, NOT the `locked` flag. Zero of the 32 active
//     escrows carry `locked = 'Yes'` while 25 carry a real Arive expiry, so any
//     rule that gates on the flag reports all 32 as unlocked.
//  2. Funded loans are never listed. The `clear_lock_expiration_on_funded` DB
//     trigger nulls `lock_expiration` on funding, so all 136 funded rows read
//     "no lock" and would bury the real worklist.
//
// Plus the DATE-column trap: `lock_expiration` must parse as LOCAL midnight, or
// a lock expiring today reads as expired yesterday in Pacific.

import { lockStatus, lockDaysLeft, unlockedEscrows, lockedEscrows, lockCounts, parseLocalDate } from '../lib/lockStatus'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}

// A fixed "today" so the suite never goes red at midnight.
const TODAY = new Date(2026, 8, 16)  // 2026-09-16, local
const d = (locked: string | null, lock_expiration: string | null) => ({ locked, lock_expiration })

// ── state machine ────────────────────────────────────────────────────────────
eq('no date, flag No  → unlocked / needsLock',
  ((s) => [s.state, s.needsLock])(lockStatus(d('No', null), TODAY)), ['unlocked', true])
eq('no date, flag null → unlocked / needsLock',
  ((s) => [s.state, s.needsLock])(lockStatus(d(null, null), TODAY)), ['unlocked', true])
eq('no date, flag Yes → no-expiry, NOT a missing lock',
  ((s) => [s.state, s.needsLock])(lockStatus(d('Yes', null), TODAY)), ['no-expiry', false])
eq('flag Yes is case/space tolerant',
  lockStatus(d('  yes ', null), TODAY).state, 'no-expiry')

eq('past date → expired / needsLock',
  ((s) => [s.state, s.needsLock, s.days])(lockStatus(d('No', '2026-08-29'), TODAY)), ['expired', true, -18])
eq('today → expiring, still protected',
  ((s) => [s.state, s.needsLock, s.days])(lockStatus(d('No', '2026-09-16'), TODAY)), ['expiring', false, 0])
eq('tomorrow → expiring, not needsLock',
  ((s) => [s.state, s.needsLock, s.days])(lockStatus(d('No', '2026-09-17'), TODAY)), ['expiring', false, 1])
eq('7 days out → expiring',  lockStatus(d('No', '2026-09-23'), TODAY).state, 'expiring')
eq('8 days out → locked',    lockStatus(d('No', '2026-09-24'), TODAY).state, 'locked')

// ── rule 1: the dead `locked` flag never overrides a real date ────────────────
eq("locked='No' + live date → LOCKED (the 25-of-32 case)",
  ((s) => [s.state, s.needsLock])(lockStatus(d('No', '2026-12-01'), TODAY)), ['locked', false])
eq("locked='Yes' + past date → still EXPIRED",
  ((s) => [s.state, s.needsLock])(lockStatus(d('Yes', '2026-08-29'), TODAY)), ['expired', true])

// ── the DATE-column trap ─────────────────────────────────────────────────────
eq('date-only string parses as LOCAL midnight, not UTC',
  ((x) => [x.getFullYear(), x.getMonth(), x.getDate(), x.getHours()])(parseLocalDate('2026-09-16')),
  [2026, 8, 16, 0])
eq('a lock expiring today is 0 days out, never -1', lockDaysLeft('2026-09-16', TODAY), 0)
eq('unparseable date is treated as locked, not unlocked',
  ((s) => [s.state, s.needsLock])(lockStatus(d('No', 'not-a-date'), TODAY)), ['locked', false])

// ── rule 2: scope + ordering ─────────────────────────────────────────────────
const STAGE_DEPTH: Record<string, number> = {
  'Loan Setup': 1, 'Disclosed': 2, 'Submitted to UW': 3, 'Approved w/ Conditions': 4,
  'Re-Submittal': 5, 'Clear to Close': 6, 'Docs Out': 7, 'Docs Signed': 8,
}
const depth = (s: string | null) => STAGE_DEPTH[s || ''] ?? 0

const rows = [
  { name: 'Funded Fred',   pipeline_group: 'Funded',           status: 'Loan Funded',   locked: 'No', lock_expiration: null },
  { name: 'Lead Larry',    pipeline_group: 'Leads',            status: 'New Lead',      locked: 'No', lock_expiration: null },
  { name: 'Parked Pam',    pipeline_group: 'Old Deals',        status: 'Disclosed',     locked: 'No', lock_expiration: null },
  { name: 'Setup Sam',     pipeline_group: 'Loans in Process', status: 'Loan Setup',    locked: 'No', lock_expiration: null },
  { name: 'DocsOut Dana',  pipeline_group: 'Loans in Process', status: 'Docs Out',      locked: 'No', lock_expiration: null },
  { name: 'Expired Ed',    pipeline_group: 'Loans in Process', status: 'Submitted to UW', locked: 'No', lock_expiration: '2026-09-11' },
  { name: 'Ancient Alice', pipeline_group: 'Loans in Process', status: 'Disclosed',     locked: 'No', lock_expiration: '2026-08-29' },
  { name: 'Locked Lou',    pipeline_group: 'Loans in Process', status: 'Docs Signed',   locked: 'No', lock_expiration: '2026-12-01' },
]

eq('funded / leads / parked are never listed; expired first (oldest first), then never-locked by stage depth',
  unlockedEscrows(rows, depth, TODAY).map(r => r.name),
  ['Ancient Alice', 'Expired Ed', 'DocsOut Dana', 'Setup Sam'])

eq('counts',
  lockCounts(rows, TODAY),
  { total: 5, locked: 1, expired: 2, unlocked: 2, expiring: 0, noExpiry: 0, needsLock: 4 })

eq('all locked → empty list',
  unlockedEscrows([{ name: 'Locked Lou', pipeline_group: 'Loans in Process', status: 'Docs Signed', locked: 'No', lock_expiration: '2026-12-01' }], depth, TODAY).length,
  0)

// ── the locked list (what the card's toggle shows) ───────────────────────────
eq('locked list: soonest expiry first, no-expiry last, unlocked/expired excluded',
  lockedEscrows([
    ...rows,
    { name: 'NoExpiry Nick', pipeline_group: 'Loans in Process', status: 'Disclosed', locked: 'Yes', lock_expiration: null },
    { name: 'Soon Sophie',   pipeline_group: 'Loans in Process', status: 'Docs Out',  locked: 'No',  lock_expiration: '2026-09-18' },
    { name: 'Funded Fiona',  pipeline_group: 'Funded',           status: 'Loan Funded', locked: 'No', lock_expiration: '2026-10-01' },
  ], TODAY).map(r => [r.name, r.lock.state]),
  [['Soon Sophie', 'expiring'], ['Locked Lou', 'locked'], ['NoExpiry Nick', 'no-expiry']])

eq('a lock expiring TODAY leads the locked list', 
  lockedEscrows([
    { name: 'Later Larry', pipeline_group: 'Loans in Process', status: 'Docs Out', locked: 'No', lock_expiration: '2026-10-05' },
    { name: 'Today Tina',  pipeline_group: 'Loans in Process', status: 'Docs Out', locked: 'No', lock_expiration: '2026-09-16' },
  ], TODAY).map(r => r.name),
  ['Today Tina', 'Later Larry'])

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
