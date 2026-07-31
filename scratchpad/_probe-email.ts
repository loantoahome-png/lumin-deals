// Is there ANY account-wide inbound-email signal in FUB for an agent key?
// Checks: /v1/events type vocabulary, and the per-channel email timestamps on
// the person payload (which the hourly sweep already fetches for free).
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
const total = (b: Record<string, unknown>) => (b._metadata as Record<string, unknown>)?.total

async function main() {
  const key = get('FUB_API_KEY_MOE')

  // 1 — events: any email-shaped type?
  const ev = await j(key, '/events?limit=100&sort=-created')
  const evs = (ev.body.events as Record<string, unknown>[]) ?? []
  const types = new Map<string, number>()
  for (const e of evs) types.set(String(e.type), (types.get(String(e.type)) ?? 0) + 1)
  console.log('events type vocabulary:', JSON.stringify([...types.entries()]))

  // 2 — a narrow /people sweep: how big is one page and what email fields exist?
  const narrow = await j(key, '/people?limit=100&fields=id,name,assignedUserId,lastReceivedEmail,lastSentEmail,lastReceivedText,lastSentText,lastIncomingCall,lastOutgoingCall,lastSentBatchEmail,lastSentActionPlanEmail,lastDeliveredMarketingCampaign')
  const people = (narrow.body.people as Record<string, unknown>[]) ?? []
  console.log(`\n/people narrow -> ${narrow.status} total=${total(narrow.body)} n=${people.length}`)
  console.log('  keys actually returned:', JSON.stringify(Object.keys(people[0] ?? {})))
  console.log('  approx page bytes:', JSON.stringify(people).length)

  // Coverage + how many look like an unanswered EMAIL specifically.
  const has = (p: Record<string, unknown>, f: string) => typeof p[f] === 'string' && p[f]
  const ms = (p: Record<string, unknown>, f: string) => { const v = p[f]; return typeof v === 'string' ? Date.parse(v) : NaN }
  let withRecv = 0, emailWaiting = 0
  const samples: string[] = []
  for (const p of people) {
    if (has(p, 'lastReceivedEmail')) withRecv++
    const recv = ms(p, 'lastReceivedEmail')
    if (isNaN(recv)) continue
    // personal responses only — bulk sends deliberately excluded, same rule the
    // mapper already uses for last_outbound_at
    const resp = ['lastSentEmail', 'lastSentText', 'lastOutgoingCall']
      .map(f => ms(p, f)).filter(t => !isNaN(t))
    const newestResp = resp.length ? Math.max(...resp) : 0
    if (recv > newestResp) {
      emailWaiting++
      if (samples.length < 8) samples.push(`${p.name} recv=${String(p.lastReceivedEmail).slice(0,10)} sentEmail=${String(p.lastSentEmail ?? '-').slice(0,10)} sentText=${String(p.lastSentText ?? '-').slice(0,10)} user=${p.assignedUserId}`)
    }
  }
  console.log(`  in this page of ${people.length}: ${withRecv} have lastReceivedEmail, ${emailWaiting} look like an UNANSWERED email`)
  for (const s of samples) console.log('    ' + s)

  // 3 — is there a bulk email endpoint after all?
  for (const p of ['/emails?limit=2', '/emails?isIncoming=true&limit=2', '/inboxThreads?limit=2']) {
    const r = await j(key, p)
    console.log(`${p} -> ${r.status} ${JSON.stringify(r.body).slice(0, 140)}`)
    await new Promise(res => setTimeout(res, 200))
  }
}
main().catch(e => { console.error(e); process.exit(1) })
