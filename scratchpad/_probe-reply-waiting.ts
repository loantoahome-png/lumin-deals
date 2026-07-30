// Read-only: run the REAL isReplyWaiting predicate over every deal, and show
// what each exclusion clause costs, per LO.
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { isReplyWaiting, HOT_WORKING_STATUSES, NOT_READY_GROUP, REPLY_WINDOW_H } from '../lib/followUpQueue'
import { isOpenLead } from '../lib/triage'

const env = readFileSync('/Users/efrainramirez/lumin-deals/.env.local', 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''
const sb = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

type Row = {
  id: string; name: string | null; status: string; ghl_status: string | null
  pipeline_group: string | null; loan_officer: string | null
  last_inbound_at: string | null; last_outbound_at: string | null
  last_communication_at: string | null; comm_unread_count: number | null
}

async function main() {
  const rows: Row[] = []
  for (let o = 0; ; o += 1000) {
    const { data, error } = await sb.from('deals')
      .select('id,name,status,ghl_status,pipeline_group,loan_officer,last_inbound_at,last_outbound_at,last_communication_at,comm_unread_count')
      .range(o, o + 999)
    if (error) throw error
    rows.push(...(data as Row[]))
    if (!data || data.length < 1000) break
  }
  const now = Date.now()
  console.log(`total deals: ${rows.length}`)

  for (const lo of ['Matt Park', 'Moe Sefati']) {
    const mine = rows.filter(r => r.loan_officer === lo)
    const pass = mine.filter(r => isReplyWaiting(r, now))
    // Same predicate WITHOUT the hot-working exclusion
    const noHot = mine.filter(r => {
      if (!isOpenLead(r)) return false
      if (r.pipeline_group === NOT_READY_GROUP) return false
      const inb = r.last_inbound_at ? Date.parse(r.last_inbound_at) : NaN
      if (isNaN(inb) || now - inb > REPLY_WINDOW_H * 3_600_000) return false
      const out = r.last_outbound_at ? Date.parse(r.last_outbound_at) : NaN
      return isNaN(out) || out < inb
    })
    const unread = mine.filter(r => (r.comm_unread_count ?? 0) > 0)
    const unreadOpenNotParked = unread.filter(r => isOpenLead(r) && r.pipeline_group !== NOT_READY_GROUP)
    console.log(`\n===== ${lo}: ${mine.length} deals`)
    console.log(`  isReplyWaiting (shipped)        : ${pass.length}`)
    console.log(`  ...if HOT_WORKING not excluded  : ${noHot.length}`)
    console.log(`  comm_unread_count>0             : ${unread.length} (open & not-parked: ${unreadOpenNotParked.length})`)
    console.log(`  blocked SOLELY by hot-status    : ${noHot.filter(r => !pass.includes(r)).map(r => `${r.name} [${r.status}]`).join(', ') || '—'}`)
    console.log('  --- unread & open & not parked:')
    for (const r of unreadOpenNotParked) {
      const inb = r.last_inbound_at, out = r.last_outbound_at
      const staleInbound = r.last_communication_at && inb && Date.parse(r.last_communication_at) - Date.parse(inb) > 3_600_000
      console.log(`   ${r.name} [${r.status} / ${r.pipeline_group}] in=${inb} out=${out} lastComm=${r.last_communication_at}${staleInbound ? '  <-- last_inbound_at STALE vs last_communication_at' : ''}${HOT_WORKING_STATUSES.includes(r.status) ? '  <-- hot-status excluded' : ''}`)
    }
  }
}
main().catch(e => { console.error(e); process.exit(1) })
