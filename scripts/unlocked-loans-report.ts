// Live report for the Dashboard's "Loans without a rate lock" card — runs the
// card's EXACT rule (lib/lockStatus.ts) against the real `deals` table and
// prints what `/` will render.
//
// Run: npx tsx scripts/unlocked-loans-report.ts
//
// ⚠️ Deliberately NOT named *-check.ts — the fixture runner globs that pattern
//    and every check in this repo must run offline. This one needs the DB.
//
// Why it exists: `deals` RLS rejects anon reads, so the local auth-bypass dev
// server renders the dashboard empty — the browser cannot verify this data path.
// This can.

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { unlockedEscrows, lockCounts, lockStatus, ESCROW_PIPELINE } from '../lib/lockStatus'
import type { Deal } from '../lib/types'

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''

const sb = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
})

// Same 8 stages, same order, as the dashboard's ESCROW_STAGES.
const ESCROW_STAGES = [
  'Loan Setup', 'Disclosed', 'Submitted to UW', 'Approved w/ Conditions',
  'Re-Submittal', 'Clear to Close', 'Docs Out', 'Docs Signed',
]
const stageDepth = (s: string | null) => ESCROW_STAGES.indexOf(s || '') + 1

async function main() {
  // supabase-js caps a bare select at 1 000 rows — paginate, the table is >5 000.
  const rows: Deal[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from('deals')
      .select('id,name,status,pipeline_group,loan_officer,loan_amount,locked,lock_expiration,investor')
      .order('id')
      .range(from, from + 999)
    if (error) { console.error('deals query failed:', error); process.exit(1) }
    rows.push(...((data ?? []) as Deal[]))
    if (!data || data.length < 1000) break
  }

  const c = lockCounts(rows)
  console.log(`\n${ESCROW_PIPELINE}: ${c.total}`)
  console.log(`  locked        ${c.locked}  (of which expiring ≤7d: ${c.expiring}, flagged with no expiry: ${c.noExpiry})`)
  console.log(`  NO live lock  ${c.needsLock}  (expired ${c.expired} · never locked ${c.unlocked})`)

  const flagYes = rows.filter(d => d.pipeline_group === ESCROW_PIPELINE && (d.locked || '').trim().toLowerCase() === 'yes')
  console.log(`\n  sanity — escrows with the hand-set locked='Yes' flag: ${flagYes.length}`)
  console.log(`  (gating on that flag instead of the date would list ${c.total - flagYes.length} of ${c.total} as unlocked)`)

  const funded = rows.filter(d => d.pipeline_group === 'Funded')
  console.log(`  sanity — funded rows: ${funded.length}, with a lock_expiration: ${funded.filter(d => d.lock_expiration).length} (trigger nulls them; excluded by scope)`)

  const esc = rows.filter(d => d.pipeline_group === ESCROW_PIPELINE)
  console.log(`  sanity — escrows with a lender (\`investor\`) set: ${esc.filter(d => d.investor).length} of ${esc.length}`)

  console.log('\nThe card, in render order:')
  for (const d of unlockedEscrows(rows, stageDepth)) {
    const amt = d.loan_amount ? `$${d.loan_amount.toLocaleString()}` : '—'
    console.log(`  ${d.lock.state === 'expired' ? '🔴' : '🟠'} ${(d.name || '?').padEnd(24)} ${(d.status || '').padEnd(23)} ${(d.loan_officer || 'No LO').padEnd(22)} ${(d.investor || '— no lender —').padEnd(20)} ${amt.padStart(10)}   ${d.lock.label}`)
  }

  const expiringSoon = rows
    .filter(d => d.pipeline_group === ESCROW_PIPELINE && lockStatus(d).state === 'expiring')
    .sort((a, b) => (a.lock_expiration || '').localeCompare(b.lock_expiration || ''))
  if (expiringSoon.length) {
    console.log('\nNot on the card, but expiring within 7 days:')
    for (const d of expiringSoon) console.log(`  ${(d.name || '?').padEnd(24)} ${lockStatus(d).label} (${d.lock_expiration})`)
  }
  console.log()
}
main()
