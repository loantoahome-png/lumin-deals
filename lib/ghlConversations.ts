// GHL conversation-history reader — used to BACKFILL "first responded" timing.
//
// The forward-only stage_events log can't answer "when did a lead created weeks
// ago first respond?". But GHL retains the full message/call thread per contact,
// so the EARLIEST INBOUND communication (borrower texted back, called in, replied
// to an email/DM) is a historical, reconstructable first-response timestamp.
//
// Endpoints (verified against app/api/ghl/thread + app/api/sync/conversations):
//   GET /conversations/search?locationId=&contactId=  → the contact's conversation
//   GET /conversations/{id}/messages?limit=100        → messages (Version 2021-04-15)
//     each message: { direction: 'inbound'|'outbound', dateAdded, messageType/type }
//
// CAVEAT (surfaced to Efrain): this captures INBOUND contact reliably (incl. inbound
// calls). A lead who only ever ANSWERED an outbound LO call is logged 'outbound' and
// is NOT counted here — that refinement needs GHL's call-status fields, which the
// backfill route sample-logs so we can verify before trusting them.

import { GHL_BASE } from './ghl'
import { normalizeEventTs } from './stageEvents'

export type ConvMessage = {
  id?: string
  direction?: string
  dateAdded?: string | number
  messageType?: string
  type?: string
  status?: string
  meta?: Record<string, unknown>
}

// Messages endpoint needs a different Version header than the rest of the v2 API.
function msgHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Version: '2021-04-15',
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0',
  }
}

const channelOf = (m: ConvMessage): string => {
  const t = String(m.messageType ?? m.type ?? '').toUpperCase()
  if (t.includes('CALL') || t.includes('VOICE') || t.includes('PHONE')) return 'Call'
  if (t.includes('EMAIL')) return 'Email'
  if (t.includes('SMS') || t.includes('TEXT')) return 'Text'
  if (t.includes('FB') || t.includes('FACEBOOK')) return 'Facebook'
  if (t.includes('IG') || t.includes('INSTAGRAM')) return 'Instagram'
  if (t.includes('WHATSAPP')) return 'WhatsApp'
  return 'Message'
}

/** PURE: earliest INBOUND message timestamp (ISO) in a message list, or null.
 *  Handles ISO strings and epoch (s/ms). Testable without any network. */
export function earliestInboundAt(messages: ConvMessage[]): { at: string; channel: string } | null {
  let bestMs: number | null = null
  let bestChannel = ''
  for (const m of messages) {
    if (m.direction !== 'inbound') continue
    const iso = normalizeEventTs(m.dateAdded)
    if (!iso) continue
    const ms = Date.parse(iso)
    if (bestMs == null || ms < bestMs) { bestMs = ms; bestChannel = channelOf(m) }
  }
  return bestMs == null ? null : { at: new Date(bestMs).toISOString(), channel: bestChannel }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function getJson(url: string, apiKey: string): Promise<unknown | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: msgHeaders(apiKey) })
    if (res.status === 429 || res.status >= 500) { await sleep(500 * (attempt + 1)); continue }
    if (!res.ok) return null
    return res.json()
  }
  return null
}

export type FirstInbound = { at: string; channel: string } | null

/** Fetch a contact's GHL conversation and return the earliest inbound timestamp.
 *  Pages backward (newest-first API) collecting inbound, so long threads still
 *  yield the true first inbound. Inbound-only by decision (2026-07-08): answered
 *  outbound calls aren't credited because GHL logs them identically to voicemails. */
export async function fetchFirstInbound(
  locationId: string,
  contactId: string,
  apiKey: string,
  opts: { maxPages?: number } = {},
): Promise<FirstInbound> {
  const maxPages = opts.maxPages ?? 15

  const search = await getJson(`${GHL_BASE}/conversations/search?locationId=${locationId}&contactId=${contactId}`, apiKey) as
    { conversations?: Array<{ id?: string }> } | null
  const conversationId = search?.conversations?.[0]?.id
  if (!conversationId) return null

  let earliest: { at: string; channel: string } | null = null
  let lastId: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const url = `${GHL_BASE}/conversations/${conversationId}/messages?limit=100${lastId ? `&lastMessageId=${lastId}` : ''}`
    const j = await getJson(url, apiKey) as { messages?: { messages?: ConvMessage[] } | ConvMessage[] } | null
    if (!j) break
    const list: ConvMessage[] = Array.isArray(j.messages) ? j.messages : (j.messages?.messages ?? [])
    if (!list.length) break

    const e = earliestInboundAt(list)
    if (e && (!earliest || Date.parse(e.at) < Date.parse(earliest.at))) earliest = e

    if (list.length < 100) break                 // reached the start of the thread
    lastId = list[list.length - 1]?.id           // oldest on this page → older cursor
    if (!lastId) break
  }
  return earliest
}
