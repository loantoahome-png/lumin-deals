// Round 2: what CAN an agent key see about unread / recent inbound messages?
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
  try { return { status: res.status, body: JSON.parse(t) as Record<string, unknown> } } catch { return { status: res.status, body: { raw: t.slice(0, 300) } } }
}

async function main() {
  for (const [label, key] of KEYS) {
    if (!key) continue
    const me = await j(key, '/me')
    const b = me.body as Record<string, unknown>
    console.log(`\n[${label}] /me -> ${me.status}  unreadConversationCount=${JSON.stringify(b.unreadConversationCount)} userId=${JSON.stringify(b.id)} name=${JSON.stringify(b.name)}`)

    // events feed — does it carry inbound messages, and is there a read flag?
    const ev = await j(key, '/events?limit=3&sort=-created')
    const list = (ev.body.events as Record<string, unknown>[]) ?? []
    console.log(`[${label}] /events -> ${ev.status} total=${JSON.stringify((ev.body._metadata as Record<string, unknown>)?.total)}`)
    if (list[0]) console.log(`      keys=[${Object.keys(list[0]).join(',')}]`)
    for (const e of list) console.log(`      ${JSON.stringify({ type: e.type, created: e.created, source: e.source, personId: (e.person as Record<string, unknown>)?.id })}`)

    // textMessages for ONE known person — does the payload carry a read flag?
    const ppl = await j(key, '/people?limit=1&sort=-updated')
    const p = ((ppl.body.people as Record<string, unknown>[]) ?? [])[0]
    if (p) {
      const tm = await j(key, `/textMessages?personId=${p.id}&limit=3&sort=-created`)
      const msgs = (tm.body.textmessages as Record<string, unknown>[]) ?? (tm.body.textMessages as Record<string, unknown>[]) ?? []
      console.log(`[${label}] /textMessages?personId=${p.id} -> ${tm.status} top=[${Object.keys(tm.body).join(',')}] n=${msgs.length}`)
      if (msgs[0]) {
        console.log(`      keys=[${Object.keys(msgs[0]).join(',')}]`)
        console.log(`      sample=${JSON.stringify({ ...msgs[0], message: '<redacted>' }).slice(0, 500)}`)
      }
      console.log(`[${label}] person keys include unread? ${Object.keys(p).filter(k => /unread|read|thread|inbox/i.test(k)).join(',') || 'none'}`)
    }
  }
}
main().catch(e => { console.error(e); process.exit(1) })
