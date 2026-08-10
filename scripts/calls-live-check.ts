// LIVE acceptance check for the call-report import — reads the real DB.
// Run: npx tsx scripts/calls-live-check.ts
//
// Asserts the acceptance criteria from docs/specs/2026-08-10-call-report-import-spec.md.
// These figures were measured directly from the two source exports before the feature
// was built, so the page either reproduces the analysis or it is wrong.
//
// Writes nothing.
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import type { CallRow } from '../lib/callsCsv'
import {
  effortRollup, economicsRollup, coverageWindow, coveredLos, scopedDeals,
  type DealLite,
} from '../lib/callsReport'
import { normPhone } from '../lib/dealMatcher'

const env = readFileSync(`${process.cwd()}/.env.local`, 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''
const sb = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
})

let pass = 0, fail = 0
function check(label: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.error(`✗ ${label}${detail ? `\n   ${detail}` : ''}`) }
}
function near(label: string, got: number, want: number, tol: number) {
  check(label, Math.abs(got - want) <= tol, `got ${got}, want ~${want} (±${tol})`)
}

async function pageAll<T>(table: string, cols: string, order: string): Promise<T[]> {
  const out: T[] = []
  const PAGE = 1000
  let offset = 0
  for (;;) {
    const { data, error } = await sb.from(table).select(cols).order(order, { ascending: true }).range(offset, offset + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    const page = (data ?? []) as unknown as T[]
    out.push(...page)
    if (page.length < PAGE) break
    offset += PAGE
  }
  return out
}

const rawCalls = await pageAll<CallRow>('calls', 'call_ts, contact_phone, contact_name, direction, call_status, disposition, duration_sec, dialer_number_name, dialer_number_phone, first_time, account_label, source_file', 'call_ts')
const calls: CallRow[] = rawCalls.map(c => ({ ...c, call_ts: new Date(c.call_ts).toISOString() }))
const deals = await pageAll<DealLite>('deals', 'id, name, phone, loan_officer, source, lead_price, funded_date, date_added_ghl', 'id')

console.log(`\nloaded ${calls.length} calls, ${deals.length} deals\n`)

// ── Import integrity ────────────────────────────────────────────────────────
check('7,348 calls stored', calls.length === 7348, `got ${calls.length}`)

const keys = new Set(calls.map(c => `${c.call_ts}|${c.contact_phone}|${c.dialer_number_phone ?? ''}`))
check('no duplicate rows (import is idempotent)', keys.size === calls.length,
  `${calls.length - keys.size} duplicate key(s)`)

check('both accounts imported', [...coveredLos(calls)].sort().join(',') === 'Matt Park,Moe Sefati',
  `covered = ${[...coveredLos(calls)].join(', ')}`)

// ── The connect rule ────────────────────────────────────────────────────────
const answeredButVoicemail = calls.filter(c =>
  c.call_status === 'Answered' && c.disposition === 'No Answer / Voicemail')
const miscounted = answeredButVoicemail.filter(c => c.duration_sec === 0)
check('Answered+voicemail rows exist in the data (the trap is real)',
  answeredButVoicemail.length > 500, `found ${answeredButVoicemail.length}`)
check('…and the zero-duration ones are NOT counted as connected',
  miscounted.every(c => c.duration_sec === 0), 'connect rule is duration-based')

// ── Timezone ────────────────────────────────────────────────────────────────
// The tell for a skipped PT→UTC conversion: dials landing before their own lead-in date.
const byPhone = new Map<string, DealLite>()
for (const d of deals) {
  const p = normPhone(d.phone)
  if (p && !byPhone.has(p)) byPhone.set(p, d)
}
let earlyDials = 0
for (const c of calls) {
  const d = byPhone.get(c.contact_phone)
  if (!d?.date_added_ghl) continue
  const gapH = (Date.parse(c.call_ts) - Date.parse(d.date_added_ghl)) / 3_600_000
  if (gapH < -1) earlyDials++
}
check('no dial lands >1h before its lead-in date (PT→UTC applied)', earlyDials === 0,
  `${earlyDials} call(s) precede their lead's date_added_ghl`)

// ── Effort ──────────────────────────────────────────────────────────────────
const effort = effortRollup(calls, deals)
const moe = effort.find(r => r.lo === 'Moe Sefati')!
const matt = effort.find(r => r.lo === 'Matt Park')!

check('Moe 717 purchased leads in window', moe.leads === 717, `got ${moe.leads}`)
near('Moe 93% dialed', (100 * moe.dialed) / moe.leads, 93, 1)
near('Moe 87% connected', (100 * moe.connected) / moe.leads, 87, 1)
near('Moe 4.2 dials/lead', moe.dials / moe.leads, 4.2, 0.15)
near('Moe $2,079 never-dialed', moe.neverDialedSpend, 2079, 5)

check('Matt 626 purchased leads in window', matt.leads === 626, `got ${matt.leads}`)
near('Matt 96% dialed', (100 * matt.dialed) / matt.leads, 96, 1)
near('Matt 89% connected', (100 * matt.connected) / matt.leads, 89, 1)
near('Matt 4.9 dials/lead', matt.dials / matt.leads, 4.9, 0.15)
near('Matt $762 never-dialed', matt.neverDialedSpend, 762, 5)

// Median time to first dial ≈ 24 min across both covered LOs.
const allTtfd = [moe.medianTtfdHours, matt.medianTtfdHours].filter((x): x is number => x != null)
check('median time-to-first-dial is under an hour for both LOs',
  allTtfd.length === 2 && allTtfd.every(h => h > 0 && h < 1),
  `got ${allTtfd.map(h => `${(h * 60).toFixed(0)}min`).join(', ')}`)

// ── Randy must be absent ────────────────────────────────────────────────────
check('Randy Mathis absent from effort rows', !effort.some(r => r.lo === 'Randy Mathis'))
const win = coverageWindow(calls)
const scoped = scopedDeals(deals, win)
check('no Randy lead in scope', !scoped.some(d => (d.loan_officer ?? '').includes('Randy')))

// ── Economics ───────────────────────────────────────────────────────────────
const econ = economicsRollup(calls, deals)
const want: Array<[string, number]> = [
  ['LMB', 38], ['OwnUp', 80], ['Lending Tree', 47], ['Lendgo', 26], ['FRU', 32],
]
for (const [source, cpc] of want) {
  const row = econ.find(r => r.source === source)
  if (!row) { fail++; console.error(`✗ ${source} missing from economics`); continue }
  near(`${source} $${cpc}/connect`, row.costPerConnect ?? -1, cpc, 2)
}

console.log(`\ncalls-live-check: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
