// Which funded loans are carrying less compensation than Arive once reported?
//
//   npx tsx scripts/comp-drift-report.ts              → the review list
//   npx tsx scripts/comp-drift-report.ts 17248386     → one loan's full timeline
//   ARIVE_EXPORT_DIR=/some/dir npx tsx scripts/comp-drift-report.ts
//
// ⚠️ NOT named *-check.ts on purpose. The fixture runner is
// `for f in scripts/*-check.ts; do npx tsx "$f"; done` — this script needs
// .env.local AND the local export archive, so it would fail that sweep on any
// machine without them. It is a REPORT, not a test.
//
// WHY THIS EXISTS
// `deals` keeps no history: one `updated_at`, no prior values. So when a number
// moves after an Arive import there is nothing in the database to compare against
// — on 2026-08-07 answering "why did Matt's comp drop?" took a hand-written diff
// of two CSVs. But every import Efrain has ever run left its export behind in
// ~/Downloads as `DB Import - <ISO>.csv`, which makes that folder a dated archive
// of what Arive believed on each day. This script reads the whole archive and
// asks one question of it: where does a funded loan sit BELOW the highest
// compensation Arive ever reported for it?
//
// ⚠️ A GAP IS NOT A RECEIVABLE. Compensation legitimately goes down — a pricing
// hit, a cure, a lender adjustment, or a re-split into points (which the Non-Del
// credit already adds back elsewhere, so those loans are NOT short). Efrain
// confirmed 2026-08-07 that of the four large gaps then outstanding, THREE were
// genuine reductions and only David Mutschler #17248386 was a split payment
// ($6,000 paid at settlement, $1,500 to follow). This is a REVIEW LIST to check
// against the actual checks — never a number to report as revenue.
//
// ⚠️ And a gap normally CURES ITSELF. Arive catches up: when the rest of a split
// payment posts, its Compensation Amount rises to the full figure and the next
// import writes it. That is exactly why the dashboard does not track a "pending
// comp" of its own — it would double-count the moment Arive caught up.
import { readFileSync, readdirSync, existsSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { parseRowsFromCsv } from '../lib/ariveCsv'
import { totalComp } from '../lib/comp'

const DIR = process.env.ARIVE_EXPORT_DIR ?? `${process.env.HOME}/Downloads`
const FUNDED_STAGES = new Set(['Loan Funded', 'Broker Check Received', 'Loan Finalized'])

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter(l => l.includes('=')).map(l => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]
  }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const money = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? n : null
}
const pad = (s: unknown, n: number) => String(s ?? '').padEnd(n).slice(0, n)
const $ = (n: number) => n.toFixed(2).padStart(10)

type Point = { date: string; comp: number | null; stage: string | null; points: number | null; channel: string | null; amount: number | null; name: string; lo: string | null }

function loadArchive(): Map<string, Point[]> {
  if (!existsSync(DIR)) throw new Error(`export dir not found: ${DIR} (set ARIVE_EXPORT_DIR)`)
  const files = readdirSync(DIR).filter(f => f.startsWith('DB Import') && f.endsWith('.csv')).sort()
  if (files.length === 0) throw new Error(`no "DB Import*.csv" exports in ${DIR}`)
  const hist = new Map<string, Point[]>()
  for (const f of files) {
    // Filename carries the export timestamp: "DB Import - 2026-08-07T15_51_46.109Z.csv"
    const date = f.slice(12, 22)
    for (const r of parseRowsFromCsv(readFileSync(`${DIR}/${f}`, 'utf8')) as Record<string, string | null>[]) {
      const id = String(r['ARIVE Loan Id'] ?? '').trim()
      if (!id) continue
      const p: Point = {
        date, comp: money(r['Compensation Amount']), stage: r['Stage Name'] ?? null,
        points: money(r['Net Discount Points']), channel: r['Channel'] ?? null,
        amount: money(r['Total Loan Amount']), name: r['Primary Borrower'] ?? '',
        lo: r['Primary Loan Officer Name'] ?? null,
      }
      if (!hist.has(id)) hist.set(id, [])
      hist.get(id)!.push(p)
    }
  }
  console.log(`archive: ${files.length} exports, ${files[0].slice(12,22)} → ${files[files.length-1].slice(12,22)}, ${hist.size} loans\n`)
  return hist
}

// ── One loan's timeline ─────────────────────────────────────────────────────
function timeline(hist: Map<string, Point[]>, id: string) {
  const pts = hist.get(id)
  if (!pts) { console.error(`Arive #${id} appears in no archived export.`); process.exit(1) }
  console.log(`${pts[pts.length-1].name} · Arive #${id} · ${pts[pts.length-1].lo ?? '?'}\n`)
  console.log(`${pad('EXPORT',12)}${pad('STAGE',26)}${'COMP'.padStart(10)}${'  %'.padStart(9)}${'POINTS'.padStart(9)}  CHANNEL`)
  let prev: Point | null = null
  for (const p of pts) {
    const pct = p.comp != null && p.amount ? `${(p.comp / p.amount * 100).toFixed(3)}%` : '—'
    const moved = prev && prev.comp != null && p.comp != null && Math.abs(prev.comp - p.comp) >= 0.005
    const arrow = moved ? `   ← ${(p.comp! - prev!.comp!) >= 0 ? '+' : ''}${(p.comp! - prev!.comp!).toFixed(2)}` : ''
    console.log(`${pad(p.date,12)}${pad(p.stage,26)}${p.comp == null ? '—'.padStart(10) : $(p.comp)}${pct.padStart(9)}${String(p.points ?? '—').padStart(9)}  ${p.channel ?? '—'}${arrow}`)
    prev = p
  }
}

// ── The review list ─────────────────────────────────────────────────────────
async function review(hist: Map<string, Point[]>) {
  const peak = new Map<string, { comp: number; date: string }>()
  for (const [id, pts] of hist) {
    for (const p of pts) {
      if (p.comp == null) continue
      const cur = peak.get(id)
      if (!cur || p.comp > cur.comp) peak.set(id, { comp: p.comp, date: p.date })
    }
  }

  let all: Record<string, any>[] = []
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb.from('deals')
      .select('name,loan_officer,pipeline_group,status,loan_amount,compensation_amount,broker_corr,net_discount_points,arive_file_no,source')
      .range(off, off + 999)
    if (error) throw error
    all = all.concat(data ?? [])
    if (!data || data.length < 1000) break
  }
  const funded = all.filter(d => d.pipeline_group === 'Funded' && d.arive_file_no)

  const rows = funded.flatMap(d => {
    const p = peak.get(String(d.arive_file_no))
    if (!p) return []
    const gap = p.comp - (d.compensation_amount ?? 0)
    return gap > 1 ? [{ d, p, gap, credit: totalComp(d as any) - (d.compensation_amount ?? 0) }] : []
  }).sort((a, b) => b.gap - a.gap)

  console.log(`${funded.length} funded loans with an Arive id · ${rows.length} below their peak compensation\n`)
  console.log(`${pad('BORROWER',24)}${pad('ARIVE #',11)}${pad('LO',14)}${pad('SOURCE',15)}${'PEAK'.padStart(10)}  ON      ${'NOW'.padStart(10)}${'GAP'.padStart(11)}`)
  const byLo = new Map<string, number>()
  for (const { d, p, gap, credit } of rows) {
    byLo.set(d.loan_officer, (byLo.get(d.loan_officer) ?? 0) + gap)
    const note = credit > 0.005 ? `  ← +${credit.toFixed(2)} Non-Del credit already added, likely a re-split not a shortfall` : ''
    console.log(`${pad(d.name,24)}${pad('#'+d.arive_file_no,11)}${pad(d.loan_officer,14)}${pad(d.source,15)}${$(p.comp)}  ${p.date}  ${$(d.compensation_amount ?? 0)}${$(gap).padStart(11)}${note}`)
  }
  if (rows.length) {
    console.log(`\n${pad('by LO',24)}`)
    for (const [lo, v] of [...byLo].sort((a, b) => b[1] - a[1])) console.log(`${pad(lo,24)}${$(v)}`)
  }
  console.log(`\n⚠️  A gap is NOT money owed. Comp legitimately drops (pricing hit, cure, or a`)
  console.log(`   re-split into points — those carry the Non-Del note above and are fine).`)
  console.log(`   Check each against the actual check. Where it IS a split payment, Arive`)
  console.log(`   catches up on its own and the next import writes the full figure.`)
  console.log(`\n   Drill into one:  npx tsx scripts/comp-drift-report.ts <arive-id>`)
}

;(async () => {
  const hist = loadArchive()
  const arg = process.argv[2]
  if (arg) timeline(hist, arg.replace(/^#/, ''))
  else await review(hist)
})().catch(e => { console.error(e); process.exit(1) })
