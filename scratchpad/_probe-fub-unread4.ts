// Round 4: is the toNumber/fromNumber feed trustworthy, and is `read` usable?
// Builds the "unanswered inbound" set per LO from message history alone.
import { readFileSync } from 'fs'

const env = readFileSync('/Users/efrainramirez/lumin-deals/.env.local', 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''
const KEYS: [string, string][] = [['moe', get('FUB_API_KEY_MOE')], ['matt', get('FUB_API_KEY_MATT')]]
const BASE = 'https://api.followupboss.com/v1'

async function j(key: string, path: string) {
  const res = await fetch(BASE + path, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${key}:`).toString('base64'), Accept: 'application/json', 'X-System': 'LuminDeals' },
  })
  const t = await res.text()
  try { return { status: res.status, body: JSON.parse(t) as Record<string, unknown> } } catch { return { status: res.status, body: {} as Record<string, unknown> } }
}

type TM = { id: number; personId: number; name?: string; created: string; sent?: string; isIncoming: boolean; read: boolean; archived: boolean; userId?: number; userName?: string; status?: string }

async function page(key: string, q: string, pages = 3): Promise<TM[]> {
  const out: TM[] = []
  let path = `/textMessages?${q}&limit=100&sort=-created`
  for (let i = 0; i < pages && path; i++) {
    const r = await j(key, path)
    if (r.status !== 200) break
    out.push(...((r.body.textmessages as TM[]) ?? []))
    const next = (r.body._metadata as Record<string, unknown>)?.nextLink as string | undefined
    path = next ? next.replace(BASE, '') : ''
    await new Promise(res => setTimeout(res, 200))
  }
  return out
}

async function main() {
  for (const [label, key] of KEYS) {
    if (!key) continue
    const me = (await j(key, '/me')).body
    const digits = String(me.callingPhoneNumber ?? '').replace(/\D/g, '')
    const inbound = await page(key, `toNumber=${digits}`)
    const outbound = await page(key, `fromNumber=${digits}`)
    console.log(`\n===== ${label} (${digits})`)
    console.log(`  toNumber feed:   n=${inbound.length}  isIncoming true/false = ${inbound.filter(m => m.isIncoming).length}/${inbound.filter(m => !m.isIncoming).length}  read=true: ${inbound.filter(m => m.read).length}`)
    console.log(`  fromNumber feed: n=${outbound.length}  isIncoming true/false = ${outbound.filter(m => m.isIncoming).length}/${outbound.filter(m => !m.isIncoming).length}  read=true: ${outbound.filter(m => m.read).length}`)

    const ts = (m: TM) => Date.parse(m.sent ?? m.created)
    const lastIn = new Map<number, TM>(), lastOut = new Map<number, TM>()
    for (const m of inbound) if (!lastIn.has(m.personId) || ts(m) > ts(lastIn.get(m.personId)!)) lastIn.set(m.personId, m)
    for (const m of outbound) if (!lastOut.has(m.personId) || ts(m) > ts(lastOut.get(m.personId)!)) lastOut.set(m.personId, m)
    const waiting = [...lastIn.values()]
      .filter(m => { const o = lastOut.get(m.personId); return !o || ts(o) < ts(m) })
      .sort((a, b) => ts(b) - ts(a))
    console.log(`  people in inbound window: ${lastIn.size} · unanswered (last inbound > last outbound): ${waiting.length}`)
    for (const m of waiting.slice(0, 12)) {
      const hrs = Math.round((Date.now() - ts(m)) / 3600_000)
      console.log(`     ${m.name} (person ${m.personId}) ${hrs}h ago · assigned ${m.userName}`)
    }
  }
}
main().catch(e => { console.error(e); process.exit(1) })
