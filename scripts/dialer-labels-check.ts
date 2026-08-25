// READ-ONLY probe: what does GHL call each dialing number, and does it agree with
// the labels `calls` learned from the CSV era?
//
// Run: npx tsx scripts/dialer-labels-check.ts
// Writes nothing. Use before trusting GHL titles as the label source.
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { GHL_BASE, ghlHeaders, getAccounts } from '../lib/ghl'
import { normPhone } from '../lib/dealMatcher'

const env = readFileSync(`${process.cwd()}/.env.local`, 'utf8')
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
})

type GhlNumber = { value?: string; title?: string }

async function main() {
  // What GHL says
  const ghl = new Map<string, { title: string; acct: string }>()
  for (const acct of getAccounts()) {
    const url = `${GHL_BASE}/phone-system/numbers?locationId=${acct.locationId}`
    const res = await fetch(url, { headers: ghlHeaders(acct.apiKey) })
    if (!res.ok) {
      console.log(`${acct.label}: HTTP ${res.status} — ${(await res.text()).slice(0, 160)}`)
      continue
    }
    const data = await res.json() as { phoneNumbers?: GhlNumber[] }
    const nums = data.phoneNumbers ?? []
    console.log(`\n── ${acct.label} (${nums.length} numbers) ──`)
    for (const n of nums) {
      const p = normPhone(n.value ?? '')
      console.log(`  ${(n.value ?? '?').padEnd(14)} ${p ?? '(unparseable)'}  "${n.title ?? '(no title)'}"`)
      if (p) ghl.set(p, { title: n.title || '(no title)', acct: acct.label })
    }
  }

  // What the DB learned
  const learned = new Map<string, Map<string, number>>()
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('calls')
      .select('dialer_number_phone, dialer_number_name')
      .not('dialer_number_name', 'is', null).not('dialer_number_phone', 'is', null)
      .range(from, from + 999)
    if (error) throw new Error(error.message)
    for (const r of data as { dialer_number_phone: string; dialer_number_name: string }[]) {
      if (!learned.has(r.dialer_number_phone)) learned.set(r.dialer_number_phone, new Map())
      const m = learned.get(r.dialer_number_phone)!
      m.set(r.dialer_number_name, (m.get(r.dialer_number_name) ?? 0) + 1)
    }
    if (!data || data.length < 1000) break
  }

  console.log('\n── stored label vs GHL title ──')
  let agree = 0, differ = 0, missing = 0
  for (const [phone, names] of learned) {
    const best = [...names.entries()].sort((a, b) => b[1] - a[1])[0][0]
    const g = ghl.get(phone)
    if (!g) { missing++; console.log(`  ${phone}  "${best}"  → NOT IN GHL's list`) }
    else if (g.title === best) { agree++; console.log(`  ${phone}  "${best}"  ✓ same`) }
    else { differ++; console.log(`  ${phone}  stored "${best}"  →  GHL "${g.title}"  ⚠ DIFFERS`) }
  }
  const unseen = [...ghl.keys()].filter(p => !learned.has(p))
  console.log(`\nagree ${agree} · differ ${differ} · stored-but-not-in-GHL ${missing}`)
  console.log(`in GHL but never dialed: ${unseen.length}${unseen.length ? ' — ' + unseen.map(p => `${p} "${ghl.get(p)!.title}"`).join(', ') : ''}`)
}
main()
