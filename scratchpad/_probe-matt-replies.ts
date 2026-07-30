// Read-only probe: why is Matt's "Replied — waiting on you" empty while GHL
// shows unread inbound? Checks the 5 unread names + the predicate inputs.
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

const env = readFileSync('/Users/efrainramirez/lumin-deals/.env.local', 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''
const sb = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const NAMES = ['Scot Gordon', 'Shante Barnes', 'Leo Scholz', 'Richard Lewis', 'Yvonne Schell']
const COLS = 'id,name,status,ghl_status,pipeline_group,loan_officer,last_inbound_at,last_outbound_at,last_communication_at,comm_unread_count,ghl_contact_id,ghl_location_id'

async function main() {
  for (const n of NAMES) {
    const { data, error } = await sb.from('deals').select(COLS).ilike('name', `%${n}%`)
    if (error) throw error
    console.log(`\n=== ${n} — ${data?.length ?? 0} row(s)`)
    for (const d of data ?? []) console.log(JSON.stringify(d))
  }

  // How fresh is last_inbound_at across Matt's open deals?
  const { data: matt } = await sb.from('deals')
    .select('name,status,pipeline_group,last_inbound_at,last_outbound_at,comm_unread_count')
    .eq('loan_officer', 'Matt Park')
    .not('last_inbound_at', 'is', null)
    .order('last_inbound_at', { ascending: false })
    .limit(15)
  console.log('\n=== Matt: 15 most recent last_inbound_at')
  for (const d of matt ?? []) console.log(JSON.stringify(d))

  // Any comm_unread_count > 0 for Matt?
  const { data: unread } = await sb.from('deals')
    .select('name,status,pipeline_group,comm_unread_count,last_inbound_at,last_outbound_at')
    .eq('loan_officer', 'Matt Park').gt('comm_unread_count', 0).limit(30)
  console.log(`\n=== Matt deals with comm_unread_count>0: ${unread?.length ?? 0}`)
  for (const d of unread ?? []) console.log(JSON.stringify(d))
}
main().catch(e => { console.error(e); process.exit(1) })
