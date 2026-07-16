import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

// AUDIT: run every LIVE GHL pipeline stage name through resolveGHLStage() and
// report which fall through (null) or resolve to the WRONG status via the
// fragile partial-match loop.
//
//   npx tsx scripts/stage-map-audit.ts
//
// WHY THIS EXISTS: if someone RENAMES a stage in the GHL UI, resolveGHLStage()
// starts returning null for it, the payload silently falls through to the CONTACT
// CREATE/UPDATE branch, and that stage move stops being applied in real time —
// no error, no log, it just quietly waits for the sync. This script is the canary.
// Re-run it after any GHL pipeline/stage edit.
//
// Baseline (2026-07-16): all 30 mortgage stages across "1) Leads", "2) Loans in
// Process" and "3) Not Ready" resolve via EXACT match in both Moe's and Matt's
// locations — zero mis-maps, partial-match never fires. The ONLY fall-throughs are
// the 6 "My Credit Guy Pipeline" stages (third-party credit repair) — those are
// NOT mortgage stages and must NOT be added to the map.
//
// GHL_STAGE_MAP + resolveGHLStage are route-local and DUPLICATED in the sync +
// webhook (verified byte-identical 2026-07-16 — if you edit one, edit both). We
// parse the webhook's copy straight from source so this audit can't drift from
// the code under test.

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }),
)

// ── Parse GHL_STAGE_MAP out of the webhook route (source of truth) ────────────
const src = readFileSync('app/api/webhooks/ghl/route.ts', 'utf8')
const mapBody = src.slice(src.indexOf('const GHL_STAGE_MAP'))
const GHL_STAGE_MAP: Record<string, { status: string; pipeline_group: string }> = {}
for (const line of mapBody.split('\n')) {
  const m = line.match(/^\s*'([^']+)':\s*\{\s*status:\s*'([^']+)',\s*pipeline_group:\s*'([^']+)'/)
  if (m) GHL_STAGE_MAP[m[1]] = { status: m[2], pipeline_group: m[3] }
  if (line.trim() === '}' && Object.keys(GHL_STAGE_MAP).length) break
}
const FUNDED_STATUSES = new Set(['Loan Funded', 'Broker Check Received', 'Loan Finalized'])
const applyFundedRule = (r: { status: string; pipeline_group: string }) =>
  FUNDED_STATUSES.has(r.status) ? { ...r, pipeline_group: 'Funded' } : r

// Faithful replica of resolveGHLStage, instrumented to report WHICH step matched.
function resolveGHLStage(stageName: string | null, pipelineName?: string | null) {
  if (!stageName) return { via: 'no-name', result: null as any }
  const lower = stageName.toLowerCase().trim()
  if (GHL_STAGE_MAP[lower]) return { via: 'exact', result: applyFundedRule(GHL_STAGE_MAP[lower]) }
  for (const [key, val] of Object.entries(GHL_STAGE_MAP)) {
    if (lower.includes(key) || key.includes(lower)) return { via: `partial('${key}')`, result: applyFundedRule(val) }
  }
  if (pipelineName) {
    const pl = pipelineName.toLowerCase()
    if (pl.includes('loan') || pl.includes('process')) return { via: 'pipeline-fallback', result: { status: 'Loan Setup', pipeline_group: 'Loans in Process' } }
    if (pl.includes('not ready')) return { via: 'pipeline-fallback', result: { status: 'Non-Responsive', pipeline_group: 'Not Ready' } }
    if (pl.includes('funded')) return { via: 'pipeline-fallback', result: { status: 'Loan Funded', pipeline_group: 'Funded' } }
  }
  return { via: 'NULL', result: null as any }
}

const LOCS: Array<[string, string, string]> = [
  ['Moe',   env.GHL_LOCATION_ID,      env.GHL_API_KEY],
  ['Matt',  env.GHL_LOCATION_ID_MATT, env.GHL_API_KEY_MATT],
  ['Randy', env.GHL_LOCATION_ID_2,    env.GHL_API_KEY_2],
]

async function main() {
  console.log(`Parsed GHL_STAGE_MAP: ${Object.keys(GHL_STAGE_MAP).length} keys\n`)
  const problems: string[] = []
  const seenStages = new Set<string>()

  for (const [label, locId, key] of LOCS) {
    if (!locId || !key) { console.log(`--- ${label}: SKIPPED (no locationId/apiKey in .env.local — prod-only)\n`); continue }
    const res = await fetch(`https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${locId}`, {
      headers: { Authorization: `Bearer ${key}`, Version: '2021-07-28', Accept: 'application/json' },
    })
    if (res.status !== 200) { console.log(`--- ${label}: HTTP ${res.status}\n`); continue }
    const data = await res.json() as { pipelines?: Array<{ id: string; name: string; stages: Array<{ id: string; name: string }> }> }

    console.log(`━━━ ${label} (${locId}) — ${data.pipelines?.length ?? 0} pipelines ━━━`)
    for (const p of data.pipelines ?? []) {
      console.log(`\n  PIPELINE "${p.name}"  (${p.stages?.length ?? 0} stages)`)
      for (const s of p.stages ?? []) {
        seenStages.add(s.name)
        const { via, result } = resolveGHLStage(s.name, p.name)
        const ok = result && result.status.toLowerCase() === s.name.toLowerCase().trim()
        let flag = '  ✓'
        if (!result) { flag = '  ❌ FALLS THROUGH'; problems.push(`[${label}/${p.name}] "${s.name}" → NULL (falls through to CONTACT branch)`) }
        else if (!ok) { flag = '  ⚠️  MIS-MAPS'; problems.push(`[${label}/${p.name}] "${s.name}" → "${result.status}" via ${via} (WRONG)`) }
        console.log(`${flag}  "${s.name}"  →  ${result ? `${result.status} / ${result.pipeline_group}` : 'null'}   [${via}]`)
      }
    }
    console.log()
  }

  console.log('\n════════ PROBLEMS ════════')
  if (!problems.length) console.log('(none — every live stage name resolves to itself)')
  for (const p of problems) console.log('  ' + p)

  // Which mapped statuses have NEVER appeared in stage_events? (candidate fall-throughs)
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const seenTo = new Set<string>()
  for (let off = 0; ; off += 1000) {
    const { data } = await sb.from('stage_events').select('to_status').range(off, off + 999)
    if (!data?.length) break
    data.forEach(r => seenTo.add(r.to_status))
    if (data.length < 1000) break
  }
  console.log('\n════════ stage_events to_status coverage ════════')
  console.log('statuses ever logged by a webhook:', [...seenTo].sort().join(', ') || '(none)')
  const never = [...new Set(Object.values(GHL_STAGE_MAP).map(v => v.status))].filter(s => !seenTo.has(s)).sort()
  console.log('\nmapped statuses NEVER logged (candidates for always-falling-through):')
  console.log('  ' + (never.join(', ') || '(none)'))
}
main()
