import { readFileSync } from 'fs'
const env = readFileSync('/Users/efrainramirez/lumin-deals/.env.local', 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''
const BASE = 'https://api.followupboss.com/v1'
type Call = { id: number; personId: number; name?: string; created: string; startedAt?: string; isIncoming: boolean; duration?: number; outcome?: string | null; userId?: number }
async function j(key: string, path: string) {
  const r = await fetch(BASE + path, { headers: { Authorization: 'Basic ' + Buffer.from(`${key}:`).toString('base64'), Accept: 'application/json' } })
  const t = await r.text()
  try { return { status: r.status, body: JSON.parse(t) as Record<string, unknown> } } catch { return { status: r.status, body: {} as Record<string, unknown> } }
}
const total = (b: Record<string, unknown>) => (b._metadata as Record<string, unknown>)?.total
async function main() {
  const key = get('FUB_API_KEY_MOE')
  const me = (await j(key, '/me')).body
  const num = String(me.callingPhoneNumber ?? '').replace(/\D/g, '')
  for (const f of [`fromNumber=${num}`, `toNumber=${num}`, `personId=62339`]) {
    const r = await j(key, `/calls?${f}&limit=100&sort=-created`)
    const l = (r.body.calls as Call[]) ?? []
    const ts = l.map(c => Date.parse(c.startedAt || c.created)).filter(t => !isNaN(t))
    console.log(`/calls?${f.padEnd(20)} -> ${r.status} total=${total(r.body)} n=${l.length} in=${l.filter(c => c.isIncoming).length} out=${l.filter(c => !c.isIncoming).length} oldest=${ts.length ? new Date(Math.min(...ts)).toISOString().slice(0,10) : '-'}`)
    await new Promise(res => setTimeout(res, 200))
  }
  // Does an incoming call ever have duration>0 AND outcome 'No Answer'? And null outcome with duration 0?
  const r = await j(key, `/calls?toNumber=${num}&limit=100&sort=-created`)
  const l = ((r.body.calls as Call[]) ?? []).filter(c => c.isIncoming)
  const noAnsWithDur = l.filter(c => String(c.outcome) === 'No Answer' && (c.duration ?? 0) > 0)
  const nullOutcomeZero = l.filter(c => c.outcome == null && (c.duration ?? 0) === 0)
  console.log(`incoming n=${l.length}: 'No Answer' w/ duration>0 = ${noAnsWithDur.length} (max ${Math.max(0, ...noAnsWithDur.map(c => c.duration ?? 0))}s); null-outcome w/ duration 0 = ${nullOutcomeZero.length}`)
  console.log('distinct incoming outcomes:', JSON.stringify([...new Set(l.map(c => String(c.outcome)))]))
}
main().catch(e => { console.error(e); process.exit(1) })
