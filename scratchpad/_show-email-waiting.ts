import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
const env = readFileSync('/Users/efrainramirez/lumin-deals/.env.local', 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''
const sb = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })
async function main() {
  const { data } = await sb.from('sync_state').select('value').eq('key', 'fub_email_waiting').maybeSingle()
  const v = ((data as { value?: unknown } | null)?.value ?? []) as Record<string, string | number | null>[]
  console.log('email candidates stored:', v.length)
  const byUser = new Map<string, number>()
  for (const r of v) byUser.set(String(r.assignedUserId), (byUser.get(String(r.assignedUserId)) ?? 0) + 1)
  console.log('by assignedUserId:', JSON.stringify([...byUser.entries()]))
  for (const r of v.slice(0, 15)) {
    console.log(' ', String(r.receivedAt).slice(0, 16), String(r.name).padEnd(26), 'user', r.assignedUserId, '| lastResponse', r.lastResponseAt ? String(r.lastResponseAt).slice(0, 16) : 'never')
  }
}
main().catch(e => { console.error(e); process.exit(1) })
