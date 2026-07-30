// Read-only probe: does the FUB API expose "unread messages"?
// Hits candidate endpoints with both agent keys and dumps status + field keys.
// No PII printed beyond first names already visible in the app.
import { readFileSync } from 'fs'

const env = readFileSync('/Users/efrainramirez/lumin-deals/.env.local', 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''
const KEYS: [string, string][] = [['moe', get('FUB_API_KEY_MOE')], ['matt', get('FUB_API_KEY_MATT')]]
const BASE = 'https://api.followupboss.com/v1'

const PATHS = [
  '/threads?limit=3',
  '/threads?limit=3&unread=true',
  '/textMessages?limit=3',
  '/calls?limit=2',
  '/emails?limit=2',
  '/me',
  '/identity',
  '/inbox?limit=3',
  '/conversations?limit=3',
  '/notifications?limit=3',
]

async function hit(label: string, key: string, path: string) {
  const res = await fetch(BASE + path, {
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${key}:`).toString('base64'),
      Accept: 'application/json',
      'X-System': 'LuminDeals',
    },
  })
  const text = await res.text()
  let parsed: unknown = null
  try { parsed = JSON.parse(text) } catch { /* non-json */ }
  const obj = parsed as Record<string, unknown> | null
  let detail = ''
  if (obj) {
    const topKeys = Object.keys(obj)
    const listKey = topKeys.find(k => Array.isArray(obj[k]))
    const list = listKey ? (obj[listKey] as Record<string, unknown>[]) : []
    detail = `top=[${topKeys.join(',')}] total=${JSON.stringify((obj._metadata as Record<string, unknown>)?.total ?? obj.total ?? '?')}`
    if (list.length) detail += `\n      itemKeys=[${Object.keys(list[0]).join(',')}]`
    if (list.length) detail += `\n      sample=${JSON.stringify(list[0]).slice(0, 700)}`
    if (!list.length && topKeys.length < 12) detail += `\n      body=${text.slice(0, 300)}`
  } else {
    detail = text.slice(0, 200)
  }
  console.log(`\n[${label}] ${path} -> ${res.status}\n      ${detail}`)
}

async function main() {
  for (const [label, key] of KEYS) {
    if (!key) { console.log(`[${label}] NO KEY`); continue }
    for (const p of PATHS) {
      try { await hit(label, key, p) } catch (e) { console.log(`[${label}] ${p} threw ${(e as Error).message}`) }
      await new Promise(r => setTimeout(r, 250))
    }
    break // one key is enough for capability discovery
  }
}
main().catch(e => { console.error(e); process.exit(1) })
