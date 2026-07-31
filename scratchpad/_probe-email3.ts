import { readFileSync } from 'fs'
const env = readFileSync('/Users/efrainramirez/lumin-deals/.env.local', 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''
const BASE = 'https://api.followupboss.com/v1'
async function j(key: string, path: string) {
  const r = await fetch(BASE + path, { headers: { Authorization: 'Basic ' + Buffer.from(`${key}:`).toString('base64'), Accept: 'application/json' } })
  try { return { status: r.status, body: JSON.parse(await r.text()) as Record<string, unknown> } } catch { return { status: r.status, body: {} as Record<string, unknown> } }
}
async function main() {
  const key = get('FUB_API_KEY_MOE')
  // sweep a few pages of people, find ones whose lastReceivedEmail is the NEWEST signal
  const statuses = new Map<string, number>()
  let checked = 0, sawReceived = 0
  let url = '/people?limit=100&fields=id,name,lastReceivedEmail,lastSentEmail'
  const cands: {id:number;name:string;recv:string}[] = []
  for (let i = 0; i < 5; i++) {
    const p = await j(key, url)
    const list = (p.body.people as Record<string, unknown>[]) ?? []
    for (const x of list) if (typeof x.lastReceivedEmail === 'string') cands.push({id:x.id as number,name:String(x.name),recv:x.lastReceivedEmail as string})
    const nl = (p.body._metadata as Record<string,unknown>)?.nextLink as string|undefined
    if (!nl) break
    url = nl.replace(BASE,'')
    await new Promise(r=>setTimeout(r,180))
  }
  console.log('candidates with lastReceivedEmail:', cands.length)
  for (const c of cands.slice(0, 10)) {
    const r = await j(key, `/emails?personId=${c.id}&limit=25&sort=-created`)
    const arr = (r.body.emails as Record<string, unknown>[]) ?? []
    for (const e of arr) statuses.set(String(e.status), (statuses.get(String(e.status)) ?? 0) + 1)
    const recvRows = arr.filter(e => String(e.status).toLowerCase() !== 'sent')
    checked++
    if (recvRows.length) {
      sawReceived++
      const e = recvRows[0]
      console.log(`  ${c.name}: ${arr.length} emails, ${recvRows.length} non-Sent. sample status=${JSON.stringify(e.status)} created=${e.created} addresses=${JSON.stringify(e.addresses).slice(0,180)}`)
    }
    await new Promise(r=>setTimeout(r,220))
  }
  console.log('\nstatus vocabulary across those:', JSON.stringify([...statuses.entries()]))
  console.log(`people checked=${checked}, with any non-Sent email=${sawReceived}`)
}
main().catch(e => { console.error(e); process.exit(1) })
