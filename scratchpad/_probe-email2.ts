import { readFileSync } from 'fs'
const env = readFileSync('/Users/efrainramirez/lumin-deals/.env.local', 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''
const BASE = 'https://api.followupboss.com/v1'
async function j(key: string, path: string) {
  const r = await fetch(BASE + path, { headers: { Authorization: 'Basic ' + Buffer.from(`${key}:`).toString('base64'), Accept: 'application/json' } })
  const t = await r.text()
  try { return { status: r.status, body: JSON.parse(t) as Record<string, unknown> } } catch { return { status: r.status, body: { raw: t.slice(0,200) } as Record<string, unknown> } }
}
async function main() {
  const key = get('FUB_API_KEY_MOE')
  // find a person who has email traffic
  const p = await j(key, '/people?limit=100&fields=id,name,lastReceivedEmail,lastSentEmail')
  const list = ((p.body.people as Record<string, unknown>[]) ?? []).filter(x => typeof x.lastReceivedEmail === 'string')
  console.log('people with lastReceivedEmail in page:', list.length)
  for (const person of list.slice(0, 2)) {
    const r = await j(key, `/emails?personId=${person.id}&limit=5&sort=-created`)
    const key0 = Object.keys(r.body)
    const arr = (r.body.emails as Record<string, unknown>[]) ?? []
    console.log(`\n/emails?personId=${person.id} (${person.name}) -> ${r.status} top=[${key0}] n=${arr.length}`)
    if (arr[0]) console.log('  fields:', JSON.stringify(Object.keys(arr[0])))
    for (const e of arr.slice(0, 4)) {
      console.log(`   ${e.created} incoming=${JSON.stringify(e.isIncoming)} status=${JSON.stringify(e.status)} subj=${JSON.stringify(String(e.subject ?? '').slice(0,40))} userId=${e.userId}`)
    }
    await new Promise(res => setTimeout(res, 250))
  }
}
main().catch(e => { console.error(e); process.exit(1) })
