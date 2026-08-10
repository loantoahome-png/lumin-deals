// One-time backfill for `date_added_ghl` — the "when did this lead come in" date.
//
// WHY: the field was insert-only in the GHL sync, so it froze whatever contact was
// attached when the row was first created. Larisa Fuchs held 2026-06-02 while GHL's
// contact said 2026-05-01, inventing a month of her cycle on a loan that funded 06-02.
//
// THE RULE — earliest wins, never later. Re-stamping from the live contact alone is
// unsafe: GHL contacts get re-created/merged and dateAdded moves FORWARD (Gustavo
// Magana's live contact reads 2026-06-01 on a loan that funded 2026-03-20). Keeping
// the earliest of {stored, live} fixes the stale-late rows and can never push a
// lead-in date forward into nonsense. Mirrors the sync's update path.
//
// Run: npx tsx scripts/lead-in-backfill.ts            (DRY RUN — writes nothing)
//      npx tsx scripts/lead-in-backfill.ts --apply    (writes)
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

const env = readFileSync('/Users/efrainramirez/lumin-deals/.env.local', 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''
const sb = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
})

const APPLY = process.argv.includes('--apply')

const ACCOUNTS = [
  { label: 'primary', key: get('GHL_API_KEY') },
  { label: 'matt', key: get('GHL_API_KEY_MATT') },
  { label: 'extra', key: get('GHL_API_KEY_2') },
].filter(a => a.key)

const H = (key: string) => ({ Authorization: `Bearer ${key}`, Version: '2021-07-28', Accept: 'application/json' })

async function ghl(path: string): Promise<Record<string, any> | null> {
  for (const a of ACCOUNTS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(`https://services.leadconnectorhq.com${path}`, { headers: H(a.key) })
      if (r.ok) return await r.json() as Record<string, any>
      if (r.status === 429) { await new Promise(s => setTimeout(s, 1000 * (attempt + 1))); continue }
      break   // 401/404 on this account → try the next one
    }
  }
  return null
}

type Row = {
  id: string; name: string | null; source: string | null; lead_price: number | null
  ghl_contact_id: string | null; ghl_opportunity_id: string | null
  date_added_ghl: string | null; funded_date: string | null
}

async function allRows(): Promise<Row[]> {
  // ⚠️ A bare select caps at 1000 rows — paginate.
  const out: Row[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('deals')
      .select('id,name,source,lead_price,ghl_contact_id,ghl_opportunity_id,date_added_ghl,funded_date')
      .order('id')
      .range(from, from + PAGE - 1)
    if (error) { console.error(error); process.exit(1) }
    out.push(...((data ?? []) as Row[]))
    if (!data || data.length < PAGE) break
  }
  return out
}

async function main() {
  const rows = (await allRows()).filter(r => r.ghl_contact_id || r.ghl_opportunity_id)
  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} · ${rows.length} rows with a GHL link\n`)

  const contactCache = new Map<string, string | null>()   // contactId → dateAdded
  const fixes: { row: Row; live: string; next: string; movedDays: number }[] = []
  let unchanged = 0, unreachable = 0

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (i && i % 200 === 0) console.log(`  …${i}/${rows.length} (${fixes.length} to fix)`)

    // Prefer the contact we already store; fall back to asking the opportunity.
    let cid = r.ghl_contact_id
    if (!cid && r.ghl_opportunity_id) {
      const b = await ghl(`/opportunities/${r.ghl_opportunity_id}`)
      cid = ((b?.opportunity ?? b) as Record<string, any> | null)?.contactId ?? null
    }
    if (!cid) { unreachable++; continue }

    if (!contactCache.has(cid)) {
      const b = await ghl(`/contacts/${cid}`)
      contactCache.set(cid, (b?.contact?.dateAdded as string | undefined) ?? null)
    }
    const live = contactCache.get(cid)
    if (!live) { unreachable++; continue }

    const liveMs = Date.parse(live)
    const heldMs = r.date_added_ghl ? Date.parse(r.date_added_ghl) : NaN
    if (isNaN(liveMs) || (!isNaN(heldMs) && liveMs >= heldMs)) { unchanged++; continue }

    fixes.push({
      row: r, live, next: live,
      movedDays: isNaN(heldMs) ? -1 : Math.round((heldMs - liveMs) / 86_400_000),
    })
  }

  console.log(`\n${'═'.repeat(76)}`)
  console.log(`would change ${fixes.length} · already earliest ${unchanged} · no live contact ${unreachable}`)
  const gained = fixes.filter(f => !f.row.date_added_ghl)
  const moved = fixes.filter(f => f.row.date_added_ghl)
  console.log(`   ${gained.length} currently BLANK → gain a date`)
  console.log(`   ${moved.length} currently TOO LATE → move earlier`)
  if (moved.length) {
    const ds = moved.map(f => f.movedDays).sort((a, b) => a - b)
    console.log(`   moved earlier by: min ${ds[0]}d · median ${ds[Math.floor(ds.length / 2)]}d · max ${ds[ds.length - 1]}d`)
  }

  // Month attribution is what actually moves on the reports — show it.
  const shift = new Map<string, number>()
  for (const f of moved) {
    const from = String(f.row.date_added_ghl).slice(0, 7), to = f.next.slice(0, 7)
    if (from !== to) shift.set(`${from} → ${to}`, (shift.get(`${from} → ${to}`) ?? 0) + 1)
  }
  if (shift.size) {
    console.log(`\n   lead-in MONTH changes (this is what moves cohort/spend attribution):`)
    for (const [k, n] of [...shift].sort()) console.log(`     ${k}   ${n} lead(s)`)
  }

  console.log(`\n   funded loans affected:`)
  for (const f of moved.filter(x => x.row.funded_date).sort((a, b) => b.movedDays - a.movedDays)) {
    console.log(`     ${String(f.row.name).padEnd(24)} ${String(f.row.source ?? '—').padEnd(14)} ${String(f.row.date_added_ghl).slice(0, 10)} → ${f.next.slice(0, 10)}  (funded ${f.row.funded_date})`)
  }

  if (!APPLY) { console.log(`\nDry run — nothing written. Re-run with --apply.`); return }

  let ok = 0, failed = 0
  const C = 20
  for (let i = 0; i < fixes.length; i += C) {
    const chunk = fixes.slice(i, i + C)
    const errs = await Promise.all(chunk.map(f =>
      sb.from('deals').update({ date_added_ghl: f.next }).eq('id', f.row.id).select('id')
        .then(r => (r.error ? r.error.message : (r.data?.length ? null : 'no rows updated')))))
    for (const e of errs) { if (e) { failed++; console.error('  update failed:', e) } else ok++ }
  }
  console.log(`\nwrote ${ok} · failed ${failed}`)
}
main()
