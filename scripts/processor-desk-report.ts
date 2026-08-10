// Live report for the Processing Desk — runs the page's EXACT scope rule and
// counters (lib/processorDesk.ts) against the real `deals` table and prints what
// /processing will render.
//
// Run: npx tsx scripts/processor-desk-report.ts [processor name]
//      npx tsx scripts/processor-desk-report.ts "Susan Lim"
//
// ⚠️ Deliberately NOT named *-check.ts — the fixture runner globs that pattern
//    and every check in this repo must run offline. This one needs the DB.
//
// Why it exists: /processing renders EMPTY under the local auth-bypass dev
// server, because `deals` RLS rejects anon reads (see the deals-rls note). The
// browser therefore cannot verify the data path — this can.

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import {
  deskDeals, deskKpis, openTasksByDeal, sortDesk, pastSla, daysUntil, daysSince,
  processorOf, ESCROW_PIPELINE, DEFAULT_PROCESSOR,
} from '../lib/processorDesk'
import type { Deal, DealTask } from '../lib/types'

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''

const sb = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
})

const target = process.argv[2] || DEFAULT_PROCESSOR

async function main() {
  const [{ data: dealRows, error: dErr }, { data: taskRows, error: tErr }] = await Promise.all([
    sb.from('deals').select('*').eq('pipeline_group', ESCROW_PIPELINE).limit(2000),
    sb.from('deal_tasks').select('*').limit(5000),
  ])
  if (dErr) { console.error('deals query failed:', dErr); process.exit(1) }
  if (tErr) { console.error('deal_tasks query failed:', tErr); process.exit(1) }

  const deals = (dealRows ?? []) as Deal[]
  const tasks = (taskRows ?? []) as DealTask[]

  console.log(`\nAll active escrows (${ESCROW_PIPELINE}): ${deals.length}`)
  const byProcessor = new Map<string, number>()
  for (const d of deals) {
    const p = processorOf(d) ?? '(unassigned)'
    byProcessor.set(p, (byProcessor.get(p) ?? 0) + 1)
  }
  console.log('\nDesks:')
  for (const [p, n] of [...byProcessor.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${p}${p === target ? '   ← this run' : ''}`)
  }

  const mine = sortDesk(deskDeals(deals, target))
  const byDeal = openTasksByDeal(tasks)
  const kpis = deskKpis(mine, byDeal)

  console.log(`\n── ${target}'s desk ──────────────────────────────────────────`)
  console.log(`  Active files ${kpis.files} · Open tasks ${kpis.openTasks} · Overdue tasks ${kpis.overdueTasks}`)
  console.log(`  No open task ${kpis.noTask} · Lock ≤7d ${kpis.lockSoon} · Past stage SLA ${kpis.overSla}`)

  console.log(`\n  Files, in the order the page lists them:`)
  for (const d of mine) {
    const ts = byDeal.get(d.id) ?? []
    const lock = daysUntil(d.lock_expiration)
    const inStage = daysSince(d.stage_changed_at) ?? daysSince(d.created_at)
    const flags = [
      ts.length ? `${ts.length} task${ts.length === 1 ? '' : 's'}` : 'NO TASK',
      lock != null && lock <= 7 ? (lock < 0 ? `lock expired ${-lock}d` : `lock ${lock}d`) : null,
      pastSla(d) ? `${inStage}d in stage (past SLA)` : null,
      d.waiting_on && d.waiting_on !== 'No one' ? `waiting on ${d.waiting_on}` : null,
    ].filter(Boolean).join(' · ')
    console.log(`   • ${(d.name ?? '(no name)').padEnd(24)} ${(d.status ?? '').padEnd(24)} ${(d.loan_officer ?? '—').padEnd(14)} ${flags}`)
  }

  // Same-name files on one desk are legitimate (one borrower, several loans) but
  // are also exactly what a duplicate shell looks like — worth an eyeball, not an
  // error. See the opp-name-vs-arive-loan-id rule: the NAME is not the key.
  const seen = new Map<string, Deal[]>()
  for (const d of mine) {
    const k = (d.name ?? '').toLowerCase().trim()
    seen.set(k, [...(seen.get(k) ?? []), d])
  }
  const dupes = [...seen.entries()].filter(([, v]) => v.length > 1)
  if (dupes.length) {
    console.log(`\n  ⚠️  Same-name files on this desk — separate loans, or duplicate shells?`)
    for (const [name, rows] of dupes) {
      console.log(`   • ${name} ×${rows.length}`)
      for (const r of rows) {
        console.log(`       arive_loan_id=${(r as unknown as Record<string, unknown>).arive_loan_id ?? '—'}  arive_file_no=${r.arive_file_no ?? '—'}  opp=${r.ghl_opportunity_id ?? '—'}  ${r.status}  ${r.loan_amount ?? '—'}`)
      }
    }
    console.log(`      → the NAME is never the key. Compare arive_loan_id / ghl_opportunity_id before merging anything.`)
  }

  console.log()
}

main()
