// Round 3: can we list unread inbound texts account-wide by the LO's own number?
// /v1/textMessages accepts toNumber — the LO's FUB calling number — which gives
// an inbound feed without threads access. Also checks emails via inboxThreadId
// alternatives and the /me phone fields.
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
  try { return { status: res.status, body: JSON.parse(t) as Record<string, unknown> } } catch { return { status: res.status, body: { raw: t.slice(0, 300) } as Record<string, unknown> } }
}

type TM = { id: number; personId: number; name?: string; created: string; sent?: string; isIncoming: boolean; read: boolean; archived: boolean; userId?: number; userName?: string; fromNumber?: string; toNumber?: string; status?: string }

async function main() {
  for (const [label, key] of KEYS) {
    if (!key) continue
    const me = (await j(key, '/me')).body
    const num = String(me.callingPhoneNumber ?? '')
    console.log(`\n===== ${label}: callingPhoneNumber=${num} outboundNumber=${JSON.stringify(me.outboundNumber)} textingEnabled=${JSON.stringify(me.textingEnabled)} unreadConversationCount=${JSON.stringify(me.unreadConversationCount)}`)
    if (!num) { console.log('  no calling number — skip'); continue }

    const digits = num.replace(/\D/g, '').replace(/^1/, '')
    for (const variant of [digits, num]) {
      const r = await j(key, `/textMessages?toNumber=${encodeURIComponent(variant)}&limit=100&sort=-created`)
      const msgs = (r.body.textmessages as TM[]) ?? []
      const total = (r.body._metadata as Record<string, unknown>)?.total
      console.log(`  toNumber=${variant} -> ${r.status} total=${JSON.stringify(total)} returned=${msgs.length}`)
      if (r.status !== 200) { console.log(`    ${JSON.stringify(r.body).slice(0, 200)}`); continue }
      const unread = msgs.filter(m => m.isIncoming && !m.read && !m.archived)
      console.log(`    incoming+unread in last ${msgs.length}: ${unread.length}`)
      for (const m of unread.slice(0, 15)) {
        console.log(`      #${m.id} person=${m.personId} ${m.name} sent=${m.sent ?? m.created} assignedUser=${m.userId}/${m.userName}`)
      }
      break
    }
  }
}
main().catch(e => { console.error(e); process.exit(1) })
