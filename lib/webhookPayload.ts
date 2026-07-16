// Pure helpers for the GHL webhook payload (app/api/webhooks/ghl/route.ts).
//
// They live in a lib because Next.js route files may only export route handlers —
// which is why extractFields' contact-id ordering is MIRRORED in
// scripts/ghl-link-check.ts, while everything here is imported directly by both
// the route and scripts/webhook-fields-check.ts.
//
// Payload ground truth (146 stored webhook bodies, field fill rates, the
// customData nesting, GHL's numeric channel enum):
// docs/research/2026-07-16-ghl-webhook-payload-audit.md

/** Pick from an object — handles strings AND numbers (GHL sends many numeric top-level fields). */
export function pick(body: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const val = body[key]
    if (val !== null && val !== undefined && val !== '') {
      if (typeof val === 'string' && val.trim()) return val.trim()
      if (typeof val === 'number' && !isNaN(val)) return String(val)
    }
  }
  return null
}

// Does this payload describe an OPPORTUNITY (rather than a bare contact)?
// Matters because GHL's `id` is polymorphic: contact id on a contact payload,
// opportunity id on an opportunity payload.
export function isOpportunityPayload(body: Record<string, unknown>): boolean {
  return !!(
    pick(body, 'opportunity_name', 'opportunityName') ||
    pick(body, 'pipleline_stage', 'pipeline_stage', 'pipelineStageName', 'pipelineStageId', 'pipelineStage')
  )
}

/** The workflow's "Custom Data" block. GHL nests the UI-configured merge fields
 *  under `customData` — NOT top-level, and NOT `customFields` (those are the
 *  contact's custom fields). */
export function getCustomData(body: Record<string, unknown>): Record<string, unknown> | null {
  const cd = body.customData
  return cd && typeof cd === 'object' && !Array.isArray(cd) ? (cd as Record<string, unknown>) : null
}

/** GHL ids are ~20-char alphanumerics. Rejects unresolved merge tags
 *  ("{{contact.id}}"), serialized objects, and other junk a workflow
 *  custom-data field can emit — never write junk into an id column. */
export function cleanGhlId(val: string | null | undefined): string | null {
  if (!val) return null
  const t = val.trim()
  return /^[A-Za-z0-9_-]{10,40}$/.test(t) ? t : null
}

/** Event type for a webhook body. Workflow webhooks carry no top-level
 *  type/event — the reply workflows send `event=inbound_message` inside
 *  customData, which is what makes the real-time message branch reachable. */
export function resolveWebhookEventType(body: Record<string, unknown>): string {
  const cd = getCustomData(body)
  return (
    pick(body, 'type', 'event', 'eventType', 'messageType') ||
    (cd ? pick(cd, 'event', 'type', 'eventType') : null) ||
    (body.note ? 'NoteCreate' : null) ||
    (body.pipelineStageId || body.pipelineStageName ? 'OpportunityStageChange' : null) ||
    'ContactCreate'
  )
}

/** Channel → dashboard label. Handles text names (native events) AND GHL's
 *  numeric enum (workflow webhooks' customData.channel / message.type).
 *  Numeric mapping verified against the 17 stored reply bodies (2026-07-16):
 *  1 = calls (message has no body), 2 = SMS-style texts, 3 = email-style bodies. */
export function channelLabel(type: string | null | undefined): string {
  if (!type) return 'Text'
  const t = String(type).toUpperCase().trim()
  if (t === '1') return 'Call'
  if (t === '2') return 'Text'
  if (t === '3') return 'Email'
  if (t.includes('SMS') || t.includes('TEXT')) return 'Text'
  if (t.includes('CALL') || t.includes('PHONE') || t.includes('VOICE') || t.includes('NO_SHOW')) return 'Call'
  if (t.includes('EMAIL')) return 'Email'
  // Exact token for the 2-letter forms — a bare .includes('IG') would map any
  // word containing "ig" (DIGITAL, PIGEON…) to Instagram. Same for FB.
  if (t === 'FB' || t.includes('FACEBOOK')) return 'Facebook'
  if (t === 'IG' || t.includes('INSTAGRAM')) return 'Instagram'
  if (t.includes('WHATSAPP')) return 'WhatsApp'
  return 'Text'
}

/** The inbound message text as a compact one-line snippet for
 *  deals.last_inbound_message, or null. Emails arrive with huge
 *  invisible-char padding (U+034F), footers and signatures — collapse
 *  whitespace and truncate; SMS bodies pass through untouched. */
export function messageSnippet(body: Record<string, unknown>, max = 400): string | null {
  const msg = body.message
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null
  const raw = (msg as Record<string, unknown>).body
  if (typeof raw !== 'string') return null
  const text = raw.replace(/͏/g, '').replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

// Keys we refuse to persist into deals.raw_ghl_data. GHL retains the source
// data, so nothing is lost — an SSN just has no business in the reporting DB.
const SENSITIVE_KEY = /social\s*security|(^|[\s_-])ssn([\s_-]|$)/i

/** Shallow-strip sensitive keys (SSN et al) from a webhook body before it is
 *  persisted. Covers top level + nested `contact` + `customData`. Returns a
 *  copy; the input is never mutated. */
export function sanitizeRawBody(body: Record<string, unknown>): Record<string, unknown> {
  const strip = (obj: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(obj).filter(([k]) => !SENSITIVE_KEY.test(k)))
  const out = strip(body)
  for (const nk of ['contact', 'customData']) {
    const nested = out[nk]
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      out[nk] = strip(nested as Record<string, unknown>)
    }
  }
  return out
}
