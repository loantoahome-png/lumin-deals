import { readFileSync, writeFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

// One-time: flatten every `deal_tasks.priority` that isn't 'normal' to 'normal'.
//
//   npx tsx scripts/task-priority-normalize.ts            # DRY RUN — writes nothing
//   npx tsx scripts/task-priority-normalize.ts --apply    # writes
//
// WHY: task priority was removed from the product on 2026-08-18 — no control on
// either task form, no badge on any row, and the 2nd-callback cron (the last
// writer of 'high') now inserts 'normal'. Efrain: "yes normalize those rows too."
// The stored values were already inert; this makes the column say what the app
// says.
//
// Scope is `deal_tasks` only. The GHL mirror (`ghl_tasks`) has no priority
// column at all — lib/ghlTasks.ts stamps `priority: null` on every mirrored row.
//
// --apply writes a full before-image to _task-priority-backup-<ts>.json first
// (id + old priority for every row it touches), the same way the other data
// scripts in here do. Restore = update each id back to its recorded value.

const APPLY = process.argv.includes('--apply')

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

type Row = { id: string; title: string; priority: string | null; completed_at: string | null }

async function main() {
  // Paginate — PostgREST caps a bare select at 1000 rows.
  const all: Row[] = []
  const PAGE = 1000
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await sb
      .from('deal_tasks')
      .select('id,title,priority,completed_at')
      .range(offset, offset + PAGE - 1)
    if (error) { console.error('read failed:', error.message); process.exit(1) }
    const rows = (data as Row[]) ?? []
    all.push(...rows)
    if (rows.length < PAGE) break
  }

  const dist = new Map<string, number>()
  for (const r of all) dist.set(String(r.priority), (dist.get(String(r.priority)) ?? 0) + 1)
  console.log(`deal_tasks: ${all.length} rows · priority ${[...dist].map(([k, v]) => `${k}=${v}`).join(' ')}`)

  const targets = all.filter(r => r.priority !== 'normal')
  const open = targets.filter(r => !r.completed_at)
  console.log(`to normalize: ${targets.length} (${open.length} still open)`)
  for (const r of open) console.log(`  open · ${r.priority} · ${r.title}`)

  if (targets.length === 0) { console.log('nothing to do'); return }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply.')
    return
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `_task-priority-backup-${stamp}.json`
  writeFileSync(backup, JSON.stringify(targets.map(r => ({ id: r.id, priority: r.priority })), null, 2))
  console.log(`\nbefore-image written: ${backup}`)

  // Chunked so one oversized IN() can't fail the whole run.
  let updated = 0
  const CHUNK = 100
  for (let i = 0; i < targets.length; i += CHUNK) {
    const ids = targets.slice(i, i + CHUNK).map(r => r.id)
    const { data, error } = await sb
      .from('deal_tasks')
      .update({ priority: 'normal' })
      .in('id', ids)
      .select('id')                     // ⚠️ without .select() a blocked write returns 0 rows and NO error
    if (error) { console.error('update failed:', error.message); process.exit(1) }
    updated += (data as { id: string }[] | null)?.length ?? 0
  }
  console.log(`updated: ${updated} / ${targets.length}`)

  const { data: after } = await sb.from('deal_tasks').select('priority')
  const post = new Map<string, number>()
  for (const r of ((after as { priority: string | null }[]) ?? [])) {
    post.set(String(r.priority), (post.get(String(r.priority)) ?? 0) + 1)
  }
  console.log('after:', [...post].map(([k, v]) => `${k}=${v}`).join(' '))
}

main()
