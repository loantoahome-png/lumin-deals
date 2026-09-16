// One-time cleanup of `deals.investor` — collapse the duplicate spellings of a
// lender onto one canonical name (lib/lenderGroup.ts → canonicalLenderName).
//
//   npx tsx scripts/lender-name-cleanup.ts            # DRY RUN — prints the plan, writes nothing
//   npx tsx scripts/lender-name-cleanup.ts --apply    # backs up, then writes
//
// Why: `investor` is free text written by the Arive CSV import, the GHL sync and
// the webhook, so one lender arrives under several spellings (live audit
// 2026-09-16: 60 distinct values, Rocket split 4 ways across 188 deals, Figure
// split 5 ways). The By-Lender view already merges them for display; this makes
// the stored data agree.
//
// ⚠️ Randy's ' - CORE' / ' Pro TPO' values are left ALONE on purpose — see the
// note on CANONICAL_NAMES in lib/lenderGroup.ts.
//
// --apply writes a backup of every row it is about to change to
// `_lender-cleanup-backup-<iso>.json` at the repo root. To undo: feed that file
// back with --revert.
import { readFileSync, writeFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { canonicalLenderName } from '../lib/lenderGroup'

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''
const sb = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
})

const APPLY = process.argv.includes('--apply')
const REVERT_FILE = process.argv.find(a => a.startsWith('--revert='))?.split('=')[1]

type Row = { id: string; investor: string | null }

/** PostgREST caps a bare select at 1000 rows — page or the cleanup silently skips deals. */
async function allDeals(): Promise<Row[]> {
  const out: Row[] = []
  const PAGE = 1000
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await sb.from('deals').select('id, investor').range(offset, offset + PAGE - 1)
    if (error) throw error
    const rows = (data ?? []) as Row[]
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

/** Writes one value across many ids, in chunks so the URL can't blow up. */
async function writeValue(value: string | null, ids: string[]) {
  const CHUNK = 200
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK)
    const { error } = await sb.from('deals').update({ investor: value }).in('id', slice)
    if (error) throw error
  }
}

async function main() {
  if (REVERT_FILE) {
    const backup = JSON.parse(readFileSync(REVERT_FILE, 'utf8')) as Row[]
    console.log(`Reverting ${backup.length} rows from ${REVERT_FILE}…`)
    const byValue = new Map<string, string[]>()
    for (const r of backup) {
      const k = r.investor ?? ''
      byValue.set(k, [...(byValue.get(k) ?? []), r.id])
    }
    for (const [value, ids] of byValue) await writeValue(value || null, ids)
    console.log(`✓ reverted ${backup.length} rows`)
    return
  }

  const deals = await allDeals()
  console.log(`Scanned ${deals.length} deals.\n`)

  // What changes, grouped by rename.
  const changes = new Map<string, { to: string; ids: string[] }>()
  const before = new Set<string>()
  const after = new Set<string>()
  for (const d of deals) {
    const raw = (d.investor ?? '').trim()
    if (raw) before.add(raw)
    const next = canonicalLenderName(d.investor)
    if (next) after.add(next)
    // Whitespace-only tidying counts as a change too (' Spring  EQ ' → 'Spring EQ').
    if ((d.investor ?? null) === (next ?? null)) continue
    const key = `${d.investor ?? '(null)'} → ${next ?? '(null)'}`
    const c = changes.get(key) ?? { to: next ?? '', ids: [] }
    c.ids.push(d.id)
    changes.set(key, c)
  }

  const rowCount = [...changes.values()].reduce((n, c) => n + c.ids.length, 0)
  const ordered = [...changes].sort((a, b) => b[1].ids.length - a[1].ids.length)
  console.log(`${ordered.length} rename(s), ${rowCount} row(s):\n`)
  for (const [label, c] of ordered) console.log(`  ${String(c.ids.length).padStart(4)}  ${label}`)
  console.log(`\nDistinct values: ${before.size} → ${after.size}`)

  // Anything left alone that a human might expect to be cleaned — say it out loud.
  const untouched = [...before].filter(v => / - CORE$/i.test(v) || /\bTPO$/i.test(v)).sort()
  if (untouched.length) {
    console.log(`\nLeft untouched on purpose (Randy's CORE/TPO labels): ${untouched.join(', ')}`)
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to write.')
    return
  }
  if (rowCount === 0) {
    console.log('\nNothing to do.')
    return
  }

  // Back up BEFORE touching anything: the exact pre-change value of every row.
  const touchedIds = new Set(ordered.flatMap(([, c]) => c.ids))
  const backup = deals.filter(d => touchedIds.has(d.id)).map(d => ({ id: d.id, investor: d.investor }))
  const path = new URL(`../_lender-cleanup-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, import.meta.url)
  writeFileSync(path, JSON.stringify(backup, null, 2))
  console.log(`\nBacked up ${backup.length} rows → ${path.pathname.split('/').pop()}`)

  for (const [label, c] of ordered) {
    await writeValue(c.to || null, c.ids)
    console.log(`  ✓ ${c.ids.length.toString().padStart(4)}  ${label}`)
  }

  // Verify against the DB, not against our own plan.
  const post = await allDeals()
  const postValues = new Set(post.map(d => (d.investor ?? '').trim()).filter(Boolean))
  const stillDirty = [...postValues].filter(v => canonicalLenderName(v) !== v)
  console.log(`\nRe-read ${post.length} deals — distinct values now ${postValues.size}.`)
  console.log(stillDirty.length === 0 ? '✓ every stored value is canonical' : `✗ still non-canonical: ${stillDirty.join(', ')}`)
}

main().catch(e => { console.error(e); process.exit(1) })
