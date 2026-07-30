// Why is Tami Boteilho listed as unanswered when Moe replied with an emoji?
// Checks (a) the date range each 3-page feed actually covers, (b) Tami's own
// message thread as FUB reports it.
import { readFileSync } from 'fs'

const env = readFileSync('/Users/efrainramirez/lumin-deals/.env.local', 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''
const BASE = 'https://api.followupboss.com/v1'
const KEY = get('FUB_API_KEY_MOE')

async function j(path: string) {
  const res = await fetch(BASE + path, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${KEY}:`).toString('base64'), Accept: 'application/json', 'X-System': 'LuminDeals' },
  })
  const t = await res.text()
  try { return { status: res.status, body: JSON.parse(t) as Record<string, unknown> } } catch { return { status: res.status, body: {} as Record<string, unknown> } }
}

type TM = { id: number; personId: number; name?: string; created: string; sent?: string; isIncoming: boolean; archived?: boolean; message?: string; userId?: number }

async function page(q: string, pages: number): Promise<TM[]> {
  const out: TM[] = []
  let path = `/textMessages?${q}&limit=100&sort=-created`
  for (let i = 0; i < pages && path; i++) {
    const r = await j(path)
    if (r.status !== 200) { console.log('  ERR', r.status, JSON.stringify(r.body).slice(0, 200)); break }
    out.push(...((r.body.textmessages as TM[]) ?? []))
    const next = (r.body._metadata as Record<string, unknown>)?.nextLink as string | undefined
    path = next ? next.replace(BASE, '') : ''
    await new Promise(res => setTimeout(res, 180))
  }
  return out
}

const span = (msgs: TM[]) => {
  const ts = msgs.map(m => Date.parse(m.sent || m.created)).filter(t => !isNaN(t))
  if (!ts.length) return 'empty'
  const oldest = Math.min(...ts), newest = Math.max(...ts)
  const days = (Date.now() - oldest) / 86_400_000
  return `${msgs.length} msgs · newest ${new Date(newest).toISOString().slice(0, 10)} · oldest ${new Date(oldest).toISOString().slice(0, 10)} (${days.toFixed(1)}d back)`
}

async function main() {
  const me = (await j('/me')).body
  const num = String(me.callingPhoneNumber ?? '').replace(/\D/g, '')
  console.log(`Moe number ${num}\n`)

  for (const pages of [3, 10]) {
    console.log(`--- ${pages} pages each way`)
    console.log('  inbound (toNumber)   :', span(await page(`toNumber=${num}`, pages)))
    console.log('  outbound (fromNumber):', span(await page(`fromNumber=${num}`, pages)))
  }

  // Find Tami and read HER thread directly.
  const search = await j('/people?limit=5&name=' + encodeURIComponent('Tami Boteilho'))
  const people = (search.body.people as Record<string, unknown>[]) ?? []
  console.log(`\nTami lookup -> ${search.status}, ${people.length} match(es)`)
  for (const p of people) {
    const id = p.id as number
    console.log(`  person ${id} ${p.name} assigned=${p.assignedUserId} stage=${p.stage}`)
    const tm = await j(`/textMessages?personId=${id}&limit=20&sort=-created`)
    const msgs = (tm.body.textmessages as TM[]) ?? []
    console.log(`  last ${msgs.length} texts:`)
    for (const m of msgs.slice(0, 10)) {
      console.log(`    ${m.sent || m.created} ${m.isIncoming ? 'IN ' : 'OUT'} archived=${m.archived} user=${m.userId} body=${JSON.stringify((m.message ?? '').slice(0, 60))}`)
    }
  }
}
main().catch(e => { console.error(e); process.exit(1) })
