// Backfill deals.loan_purpose from a GHL contacts CSV export.
//
//   npx tsx scripts/loan-purpose-backfill.ts <export.csv>        → dry run
//   npx tsx scripts/loan-purpose-backfill.ts <export.csv> apply  → writes
//
// Why this exists: the sync's purpose normalizer returned null for anything that
// wasn't "purchase" or "refi", so every HELOC it saw was DISCARDED. The webhook
// writes loan_purpose raw, so a HELOC survived only where a webhook happened to
// touch the deal — 49 of Moe's 77 Lending Tree leads kept it while the 26 the
// sync alone had seen went untagged. normalizeLoanPurpose now preserves HELOC,
// but that only fixes deals the sync revisits WITH custom fields attached
// (the per-contact GET path); a dormant lead can wait indefinitely. This fills
// them in from an export, which is authoritative for the contact-level field.
//
// Only ever FILLS BLANKS — an existing purpose is never overwritten, so a value
// a human or the webhook set cannot be clobbered by a stale export.
//
// The CSV needs a "Contact Id" column and a "Loan Purpose" column; it is matched
// to deals on ghl_contact_id, so one contact with several opportunities fills
// every one of that person's loans.
import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync } from 'fs'
import { normalizeLoanPurpose } from '../lib/utils'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter(l => l.includes('='))
    .map(l => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]
    }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

/** Minimal RFC-4180 reader — handles quoted fields containing commas. */
function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = []
  let row: string[] = [], cell = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else if (c !== '\r') cell += c
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  const header = (rows.shift() ?? []).map(h => h.replace(/^﻿/, '').trim())
  return rows
    .filter(r => r.some(c => c.trim()))
    .map(r => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])))
}

;(async () => {
  const csvPath = process.argv[2]
  const apply = process.argv[3] === 'apply'
  if (!csvPath) { console.error('usage: loan-purpose-backfill.ts <export.csv> [apply]'); process.exit(1) }

  const csv = parseCsv(readFileSync(csvPath, 'utf8'))
  const wanted = new Map<string, string>()   // contactId → normalized purpose
  for (const r of csv) {
    const id = r['Contact Id']
    const purpose = normalizeLoanPurpose(r['Loan Purpose'])
    if (id && purpose) wanted.set(id, purpose)
  }
  console.log(`CSV rows: ${csv.length} · contacts with a usable purpose: ${wanted.size}`)

  const deals: Array<Record<string, unknown>> = []
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb
      .from('deals')
      .select('id, name, ghl_contact_id, loan_purpose')
      .order('id', { ascending: true })
      .range(off, off + 999)
    if (error) throw new Error(error.message)
    const batch = (data ?? []) as Array<Record<string, unknown>>
    deals.push(...batch)
    if (batch.length < 1000) break
  }

  const plan = deals
    .filter(d => {
      const cid = (d.ghl_contact_id as string | null) ?? ''
      const blank = !((d.loan_purpose as string | null) ?? '').trim()
      return blank && wanted.has(cid)      // FILL BLANKS ONLY
    })
    .map(d => ({ id: d.id as string, name: d.name as string, next: wanted.get(d.ghl_contact_id as string)! }))

  const already = deals.filter(d => {
    const cid = (d.ghl_contact_id as string | null) ?? ''
    return wanted.has(cid) && ((d.loan_purpose as string | null) ?? '').trim()
  }).length

  console.log(`MODE: ${apply ? 'APPLY' : 'DRY RUN (no writes)'}`)
  console.log(`deals matched to those contacts: ${plan.length + already}`)
  console.log(`  already have a purpose (left alone): ${already}`)
  console.log(`  blank → will fill: ${plan.length}`)
  const byValue: Record<string, number> = {}
  for (const p of plan) byValue[p.next] = (byValue[p.next] ?? 0) + 1
  for (const [k, v] of Object.entries(byValue)) console.log(`     ${String(v).padStart(4)}  ${k}`)

  if (!apply) { console.log('\nDry run — nothing written. Re-run with `apply` to commit.'); return }
  if (!plan.length) { console.log('\nNothing to fill.'); return }

  const dir = process.env.BACKFILL_BACKUP_DIR ?? '/tmp'
  const backup = `${dir}/loan-purpose-backfill-${process.env.BACKFILL_STAMP ?? 'run'}.json`
  writeFileSync(backup, JSON.stringify(plan, null, 2))
  console.log(`\nplan backed up → ${backup}`)

  let ok = 0
  const failures: Array<{ id: string; error: string }> = []
  for (const p of plan) {
    const { error } = await sb.from('deals').update({ loan_purpose: p.next }).eq('id', p.id)
    if (error) failures.push({ id: p.id, error: error.message })
    else ok++
  }
  console.log(`\nfilled ${ok}/${plan.length}`)
  if (failures.length) {
    console.error(`${failures.length} failed:`)
    for (const f of failures.slice(0, 20)) console.error(`  ${f.id}: ${f.error}`)
    process.exit(1)
  }
})()
