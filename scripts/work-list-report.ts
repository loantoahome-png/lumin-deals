// Live report for /worklist — runs the page's exact transpose against the real
// `deals` table and prints what the page will render.
//
// Run: npx tsx scripts/work-list-report.ts ["Processor Name"]
//
// ⚠️ NOT named *-check.ts — the fixture runner globs that and every check must
//    run offline. This needs .env.local.
//
// Exists because /worklist renders EMPTY under the local auth-bypass dev server
// (`deals` RLS rejects anon reads), so the browser cannot verify the data path.

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { deskDeals, ESCROW_PIPELINE, DEFAULT_PROCESSOR } from '../lib/processorDesk'
import {
  buildWorkItems, groupsForState, workCounts, sortByWait, recentlyCompleted,
} from '../lib/workList'
import type { Deal } from '../lib/types'

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''

const sb = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
})

const target = process.argv[2] || DEFAULT_PROCESSOR

async function main() {
  const { data, error } = await sb
    .from('deals').select('*').eq('pipeline_group', ESCROW_PIPELINE).limit(2000)
  if (error) { console.error('query failed:', error); process.exit(1) }

  const mine = deskDeals((data ?? []) as Deal[], target)
  const items = buildWorkItems(mine)
  const c = workCounts(items)

  console.log(`\n${target}: ${mine.length} active files · ${items.length} tracked actions`)
  console.log(`  To do ${c.todo} · Waiting ${c.waiting} (${c.overdueWaits} stale) · Done ${c.done}\n`)

  console.log('── TO DO ─────────────────────────────────────────────────────')
  const todo = groupsForState(items, 'todo')
  if (!todo.length) console.log('  (nothing)')
  for (const g of todo) {
    console.log(`  ${g.label}  (${g.items.length})`)
    for (const i of g.items) console.log(`     · ${i.dealName}  [${i.stage}]`)
  }

  console.log('\n── WAITING ON ────────────────────────────────────────────────')
  const waiting = sortByWait(items.filter(i => !i.done_at && i.requested_at))
  if (!waiting.length) console.log('  (nothing)')
  for (const i of waiting) {
    console.log(`  ${i.waitingDays}d · ${i.dealName} · ${i.label} · from ${i.requested_from ?? '—'} · ${i.requested_by ?? '—'}`)
  }

  console.log('\n── RECENTLY COMPLETED (14d) ──────────────────────────────────')
  const done = recentlyCompleted(items)
  if (!done.length) console.log('  (nothing)')
  for (const i of done.slice(0, 30)) {
    console.log(`  ${new Date(i.done_at!).toLocaleDateString()} · ${i.dealName} · ${i.label} · ${i.done_by ?? '—'}`)
  }
  console.log()
}

main()
