// Does an ANON-key update on fub_people succeed, fail, or silently match 0 rows?
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
const env = readFileSync('/Users/efrainramirez/lumin-deals/.env.local', 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''
const anon = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('NEXT_PUBLIC_SUPABASE_ANON_KEY'), { auth: { persistSession: false } })

async function main() {
  const r1 = await anon.from('fub_people').select('fub_id,name').eq('fub_id', 53556)
  console.log('anon SELECT  ->', r1.error ? 'ERR ' + r1.error.message : `${r1.data?.length} row(s)`)
  const r2 = await anon.from('fub_people').update({ last_touched_at: new Date().toISOString() }).eq('fub_id', 53556).select()
  console.log('anon UPDATE  ->', r2.error ? 'ERR ' + r2.error.message : `${r2.data?.length} row(s) returned`)
  const r3 = await anon.from('deals').update({ next_action_due: null }).eq('id', '00000000-0000-0000-0000-000000000000').select()
  console.log('anon deals UPDATE (no-match) ->', r3.error ? 'ERR ' + r3.error.message : `${r3.data?.length} row(s)`)
}
main().catch(e => { console.error(e); process.exit(1) })
