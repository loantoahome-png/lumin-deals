// What the new escrow card will render: lock status + open task count per active
// escrow. The board renders empty under the local auth-bypass (deals RLS rejects
// anon), so this is where the data path gets verified.
// Run: npx tsx scratchpad/_probe-escrow-card.ts
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import type { Deal, DealTask } from '../lib/types'

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''
const sb = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

const MS = 86_400_000
const startOfDay = (d: Date) => { d.setHours(0,0,0,0); return d }
const parseLocalDate = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim())
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(s)
}
const lockDaysLeft = (iso: string | null) => {
  if (!iso) return null
  const exp = parseLocalDate(iso)
  if (isNaN(exp.getTime())) return null
  return Math.round((startOfDay(exp).getTime() - startOfDay(new Date()).getTime()) / MS)
}
const fmt = (iso: string) => parseLocalDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
function lockLabel(d: Deal) {
  const flagged = (d.locked || '').trim().toLowerCase() === 'yes'
  if (!d.lock_expiration) return flagged ? 'Locked · no expiry' : 'Not locked'
  const n = lockDaysLeft(d.lock_expiration)
  const e = fmt(d.lock_expiration)
  if (n == null) return `Locked · ${e}`
  if (n < 0) return `Expired ${e} · ${-n}d ago`
  if (n === 0) return `Expires today · ${e}`
  return `${e} · ${n}d left`
}

async function main() {
  const { data: deals } = await sb.from('deals').select('*').eq('pipeline_group', 'Loans in Process')
  const { data: ours } = await sb.from('deal_tasks').select('*').is('completed_at', null)
  const { data: ghl } = await sb.from('ghl_tasks').select('*')

  const rows = (deals as Deal[]) || []
  const byDeal = new Map<string, { title: string; due: string | null; who: string | null; src: string }[]>()
  for (const t of ((ours as DealTask[]) || [])) {
    if (!t.deal_id) continue
    byDeal.set(t.deal_id, [...(byDeal.get(t.deal_id) ?? []), { title: t.title, due: t.due_at, who: t.assignee, src: 'ours' }])
  }
  for (const g of ((ghl as { deal_id: string | null; title: string; due_at: string | null; assignee: string | null }[]) || [])) {
    if (!g.deal_id) continue
    byDeal.set(g.deal_id, [...(byDeal.get(g.deal_id) ?? []), { title: g.title, due: g.due_at, who: g.assignee, src: 'GHL' }])
  }

  console.log(`active escrows: ${rows.length} · open deal_tasks: ${(ours||[]).length} · mirrored ghl_tasks: ${(ghl||[]).length}\n`)
  let withTasks = 0, locked = 0, alerting = 0
  for (const d of rows.sort((a, b) => a.name.localeCompare(b.name))) {
    const ts = byDeal.get(d.id) ?? []
    if (ts.length) withTasks++
    const lbl = lockLabel(d)
    if (lbl !== 'Not locked') locked++
    const n = lockDaysLeft(d.lock_expiration)
    const alert = lbl !== 'Not locked' && (n == null || n <= 7)
    if (alert) alerting++
    console.log(`${d.name.padEnd(26)} ${d.status.padEnd(24)} lock: ${lbl.padEnd(24)} tasks: ${ts.length}${alert ? '  ⚠ lock alert' : ''}`)
    for (const t of ts.slice(0, 3)) console.log(`    · [${t.src}] ${t.title.slice(0, 48)} — due ${t.due ?? 'none'} — ${t.who ?? 'unassigned'}`)
  }
  console.log(`\nfiles with >=1 open task: ${withTasks}/${rows.length} · locked: ${locked} · lock alerts (<=7d/expired/no expiry): ${alerting}`)

}
main()
