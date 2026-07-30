// Can we build "missed inbound call, nobody called back" from /v1/calls?
// Checks: which filters are actually honored (undocumented ones fail SILENTLY
// in FUB), and what distinguishes a missed call from an answered one.
import { readFileSync } from 'fs'

const env = readFileSync('/Users/efrainramirez/lumin-deals/.env.local', 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''
const BASE = 'https://api.followupboss.com/v1'

async function j(key: string, path: string) {
  const r = await fetch(BASE + path, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${key}:`).toString('base64'), Accept: 'application/json', 'X-System': 'LuminDeals' },
  })
  const t = await r.text()
  try { return { status: r.status, body: JSON.parse(t) as Record<string, unknown> } } catch { return { status: r.status, body: { raw: t.slice(0, 200) } as Record<string, unknown> } }
}

type Call = {
  id: number; personId: number; name?: string; created: string; startedAt?: string
  userId?: number; userName?: string; phone?: string; fromNumber?: string; toNumber?: string
  isIncoming: boolean; duration?: number; ringDuration?: number; outcome?: string | null; note?: string | null
}

const meta = (b: Record<string, unknown>) => (b._metadata as Record<string, unknown>)?.total

async function main() {
  for (const label of ['MOE', 'MATT'] as const) {
    const key = get(`FUB_API_KEY_${label}`)
    if (!key) continue
    const me = (await j(key, '/me')).body
    const num = String(me.callingPhoneNumber ?? '').replace(/\D/g, '')
    const userId = me.id as number
    console.log(`\n════ ${label}  number=${num} userId=${userId}`)

    // 1 — which filters are HONORED? (a silently-ignored param returns the
    //     unfiltered total, which is the tell)
    const base = await j(key, '/calls?limit=100&sort=-created')
    console.log(`  /calls                 -> ${base.status} total=${meta(base.body)}`)
    for (const f of [`toNumber=${num}`, `userId=${userId}`, `isIncoming=true`, `phone=${num}`]) {
      const r = await j(key, `/calls?${f}&limit=100&sort=-created`)
      const list = (r.body.calls as Call[]) ?? []
      const inc = list.filter(c => c.isIncoming).length
      const mine = list.filter(c => c.userId === userId).length
      console.log(`  /calls?${f.padEnd(22)} -> ${r.status} total=${meta(r.body)} n=${list.length} incoming=${inc} thisUser=${mine}`)
      await new Promise(res => setTimeout(res, 200))
    }

    // 2 — what does a MISSED inbound call look like vs an answered one?
    const list = ((base.body.calls as Call[]) ?? []).filter(c => c.isIncoming)
    console.log(`\n  incoming in last 100 calls: ${list.length}`)
    const dur = new Map<string, number>()
    for (const c of list) {
      const k = `dur=${c.duration ?? 'null'} ring=${c.ringDuration ?? 'null'} outcome=${JSON.stringify(c.outcome ?? null)}`
      dur.set(k, (dur.get(k) ?? 0) + 1)
    }
    console.log('  shape histogram (incoming):')
    for (const [k, n] of [...dur.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`    ${n}×  ${k}`)
    console.log('  samples:')
    for (const c of list.slice(0, 6)) {
      console.log(`    ${(c.startedAt || c.created)} ${c.name} dur=${c.duration} ring=${c.ringDuration} outcome=${JSON.stringify(c.outcome)} note=${JSON.stringify((c.note ?? '').slice(0, 40))} user=${c.userId}`)
    }
    // outcomes across ALL calls (in + out) for vocabulary
    const all = (base.body.calls as Call[]) ?? []
    const outc = new Map<string, number>()
    for (const c of all) outc.set(`${c.isIncoming ? 'IN ' : 'OUT'} ${String(c.outcome)}`, (outc.get(`${c.isIncoming ? 'IN ' : 'OUT'} ${String(c.outcome)}`) ?? 0) + 1)
    console.log('  outcome vocabulary:', JSON.stringify([...outc.entries()].sort((a, b) => b[1] - a[1])))
  }
}
main().catch(e => { console.error(e); process.exit(1) })
