// Live read-out of the /reports/escrows rate-lock figures, straight from the DB.
// Run: npx tsx scripts/escrow-lock-report.ts
//
// Why it exists: /reports/escrows renders EMPTY under the local auth-bypass dev server
// because `deals` RLS rejects anon reads (see the deals-rls note), so the browser cannot
// verify the KPI band. This can. Pure read — writes nothing.
//
// It runs the SAME lib/lockStatus rule the page runs, so a disagreement between this and
// the page is a rendering bug, not a rule bug.
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { lockStatus, lockCounts, ESCROW_PIPELINE } from '../lib/lockStatus'
import { LOAN_OFFICERS } from '../lib/types'
import type { Deal } from '../lib/types'

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''
const sb = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
})

async function main() {
  const rows: Deal[] = []
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from('deals')
      .select('id,name,locked,lock_expiration,pipeline_group,status,ghl_status,loan_officer,loan_amount')
      .range(f, f + 999)
    if (error) throw error
    rows.push(...((data ?? []) as unknown as Deal[]))
    if (!data || data.length < 1000) break
  }
  const esc = rows.filter(d => d.pipeline_group === ESCROW_PIPELINE)

  console.log(`Active escrows: ${esc.length}`)
  console.log(`  carry locked = 'Yes' (the DEAD flag): ${esc.filter(d => (d.locked || '').trim().toLowerCase() === 'yes').length}`)
  console.log(`  carry a real Arive lock_expiration:   ${esc.filter(d => d.lock_expiration).length}\n`)

  const all = lockCounts(esc)
  console.log(`KPI band, all LOs — Locked ${all.locked}/${all.total} · Lock ≤7d ${all.expiring} · Needs lock ${all.needsLock}`)
  console.log(`  (expired ${all.expired} + never locked ${all.unlocked} = ${all.needsLock} with no live protection)\n`)

  for (const lo of LOAN_OFFICERS) {
    const mine = esc.filter(d => (d.loan_officer || '') === lo)
    if (!mine.length) continue
    const c = lockCounts(mine)
    console.log(`  ${lo.padEnd(24)} Locked ${c.locked}/${c.total} · ≤7d ${c.expiring} · needs lock ${c.needsLock}`)
  }

  const risk = esc.map(d => ({ d, s: lockStatus(d) })).filter(x => x.s.needsLock)
    .sort((a, b) => (a.s.days ?? 1e9) - (b.s.days ?? 1e9))
  if (risk.length) {
    console.log(`\nNo live rate protection (${risk.length}):`)
    for (const { d, s } of risk) {
      console.log(`  ${(d.name || '').padEnd(26)} ${s.state.padEnd(9)} ${s.label}`)
    }
  }
}
main()
