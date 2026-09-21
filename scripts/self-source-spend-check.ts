// One-off: which Self Source deal(s) carry a lead_price? Pure read.
// Run: npx tsx scripts/self-source-spend-check.ts
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''
const sb = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
})

async function main() {
  const { data, error } = await sb
    .from('deals')
    .select('id,name,source,loan_officer,state,status,lead_price,date_added_ghl,created_at,ghl_opportunity_id')
    .ilike('source', '%self%')
    .gt('lead_price', 0)
  if (error) throw error
  console.log(`Self-source rows with lead_price > 0: ${data?.length ?? 0}`)
  for (const d of data ?? []) console.log(JSON.stringify(d))

  // Also: every distinct source label containing "self", with counts + total price.
  const { data: all, error: e2 } = await sb
    .from('deals')
    .select('source,lead_price')
    .ilike('source', '%self%')
  if (e2) throw e2
  const agg = new Map<string, { n: number; spend: number }>()
  for (const r of all ?? []) {
    const k = r.source ?? '(null)'
    const a = agg.get(k) ?? { n: 0, spend: 0 }
    a.n++; a.spend += Number(r.lead_price ?? 0)
    agg.set(k, a)
  }
  console.log('\nBy label:')
  for (const [k, v] of agg) console.log(`  ${k}: ${v.n} leads · $${v.spend}`)
}
main()
