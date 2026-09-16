// Live read-out of the /deals "By Lender" view — what the sections actually
// render, straight from the DB.
// Run: npx tsx scripts/lender-view-report.ts
//
// Why it exists: /deals renders EMPTY under the local auth-bypass dev server
// because `deals` RLS rejects anon reads (see the deals-rls note), so the
// browser cannot verify the grouping. This can. Pure read — writes nothing.
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { groupDealsByLender, NO_LENDER_KEY } from '../lib/lenderGroup'
import type { Deal } from '../lib/types'

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''
const sb = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
})

async function main() {
  const { data, error } = await sb
    .from('deals')
    .select('id, name, investor, status, loan_amount, loan_officer')
    .eq('pipeline_group', 'Loans in Process')
  if (error) throw error

  const deals = (data ?? []) as unknown as Deal[]
  const groups = groupDealsByLender(deals)
  const money = (n: number) => `$${Math.round(n).toLocaleString()}`

  console.log(`Active escrows: ${deals.length} · lender groups: ${groups.length}\n`)
  for (const g of groups) {
    const also = g.variants.filter(v => v !== g.label)
    console.log(
      `${g.label}${g.key === NO_LENDER_KEY ? '' : ''} — ${g.deals.length} loan(s) · ${money(g.volume)}` +
      (also.length ? `   [also filed as: ${also.join(', ')}]` : '')
    )
    for (const d of g.deals) {
      console.log(`    ${(d.name ?? '—').padEnd(26)} ${String(d.status).padEnd(24)} ${money(d.loan_amount || 0).padStart(12)}  ${d.loan_officer ?? '—'}`)
    }
    console.log()
  }

  // Sanity: every deal lands in exactly one group, and blanks sort last.
  const placed = groups.reduce((n, g) => n + g.deals.length, 0)
  console.log(placed === deals.length ? `✓ all ${placed} deals placed` : `✗ placed ${placed} of ${deals.length}`)
  const noneIdx = groups.findIndex(g => g.key === NO_LENDER_KEY)
  console.log(noneIdx === -1 ? '· no blank-lender group' : noneIdx === groups.length - 1 ? '✓ blank group sorts last' : '✗ blank group is not last')
}

main().catch(e => { console.error(e); process.exit(1) })
