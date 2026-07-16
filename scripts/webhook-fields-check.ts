// Fixture check for lib/webhookPayload.ts — the 2026-07-16 webhook enrichment:
//   1. resolveWebhookEventType reads customData.event (reply workflows send
//      event=inbound_message NESTED, which used to make the message branch dead)
//   2. channelLabel maps GHL's numeric enum (1=Call 2=SMS 3=Email) + text names
//   3. messageSnippet collapses noisy email bodies into a bounded snippet
//   4. sanitizeRawBody strips SSN-class keys before raw_ghl_data persistence
//   5. cleanGhlId rejects unresolved "{{…}}" merge tags and junk
//
// Run: npx tsx scripts/webhook-fields-check.ts
// Payload ground truth: docs/research/2026-07-16-ghl-webhook-payload-audit.md
import {
  resolveWebhookEventType, channelLabel, messageSnippet, sanitizeRawBody, cleanGhlId,
} from '../lib/webhookPayload'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}

// ── 1. Event type via customData ──────────────────────────────────────────────

// The real "Customer Replied" shape: no top-level type/event, marker nested.
eq('reply workflow → inbound_message from customData',
  resolveWebhookEventType({ contact_id: 'ibR03XmjLjFYFWt5moDT', first_name: 'Amy',
    customData: { event: 'inbound_message', channel: '2', contactId: 'ibR03XmjLjFYFWt5moDT' },
    message: { body: 'Okay thank you', type: 2 } }),
  'inbound_message')

// The real stage-workflow shape: customData present but carries NO event key —
// must still fall through to ContactCreate (the stage-applying contact path).
eq('stage workflow (customData w/o event) → ContactCreate',
  resolveWebhookEventType({ contact_id: 'psgsm6qnjTVU4q5MmQvf', pipleline_stage: 'Ghosted',
    customData: { contactId: 'psgsm6qnjTVU4q5MmQvf', pipelineName: '1) Leads' } }),
  'ContactCreate')

// Native app events keep top-level priority.
eq('top-level type outranks customData', resolveWebhookEventType({ type: 'OutboundMessage', customData: { event: 'inbound_message' } }), 'OutboundMessage')
eq('note payload → NoteCreate', resolveWebhookEventType({ note: 'called, LM' }), 'NoteCreate')
eq('bare contact payload → ContactCreate', resolveWebhookEventType({ id: 'x', first_name: 'A' }), 'ContactCreate')

// ── 2. Channel labels ─────────────────────────────────────────────────────────

// Numeric enum, verified against the 17 stored reply bodies (2026-07-16).
eq('channel 1 → Call',  channelLabel('1'), 'Call')
eq('channel 2 → Text',  channelLabel('2'), 'Text')
eq('channel 3 → Email', channelLabel('3'), 'Email')
// Text names (native events) unchanged.
eq('SMS → Text',   channelLabel('SMS'), 'Text')
eq('CALL → Call',  channelLabel('TYPE_CALL'), 'Call')
eq('Email → Email', channelLabel('Email'), 'Email')
eq('null → Text default', channelLabel(null), 'Text')
eq('unknown → Text default', channelLabel('carrier-pigeon'), 'Text')

// ── 3. Message snippet ────────────────────────────────────────────────────────

eq('SMS body passes through', messageSnippet({ message: { body: 'Call me back when you can Im done with meetings', type: 2 } }),
  'Call me back when you can Im done with meetings')

// Real email junk: U+034F invisible padding + newlines collapse to one line.
eq('email padding + whitespace collapsed',
  messageSnippet({ message: { body: 'Its Time to Move Forward! ͏  ͏  ͏ \n ͏  ͏ rates today', type: 3 } }),
  'Its Time to Move Forward! rates today')

eq('long body truncates to 400 with ellipsis', (() => {
  const s = messageSnippet({ message: { body: 'x'.repeat(900) } })
  return s !== null && s.length === 400 && s.endsWith('…')
})(), true)

eq('call payload (no body) → null', messageSnippet({ message: { type: 1 } }), null)
eq('empty body → null', messageSnippet({ message: { body: '' } }), null)
eq('whitespace-only body → null', messageSnippet({ message: { body: ' ͏  ͏ \n ' } }), null)
eq('no message object → null', messageSnippet({ contact_id: 'abc' }), null)

// ── 4. Raw-body sanitizing ────────────────────────────────────────────────────

const dirty = {
  contact_id: 'abc123', 'Loan Amount': 357500,
  'Social Security Number': '570152207',
  contact: { firstName: 'Tammy', ssn: '570152207' },
  customData: { contactId: 'abc123', 'SSN Last 4': '2207' },
}
const clean = sanitizeRawBody(dirty)
eq('top-level SSN key stripped', 'Social Security Number' in clean, false)
eq('nested contact.ssn stripped', 'ssn' in (clean.contact as Record<string, unknown>), false)
eq('customData "SSN Last 4" stripped', 'SSN Last 4' in (clean.customData as Record<string, unknown>), false)
eq('non-sensitive fields survive', (clean as Record<string, unknown>)['Loan Amount'], 357500)
eq('nested non-sensitive fields survive', (clean.contact as Record<string, unknown>).firstName, 'Tammy')
eq('input object not mutated', 'Social Security Number' in dirty, true)
// "mission"/"Assn" style ssn-substring false positives must NOT be stripped.
eq('ssn-substring words survive',
  sanitizeRawBody({ mission: 'a', lesson: 'b', 'Assn Fee': 'c' }),
  { mission: 'a', lesson: 'b', 'Assn Fee': 'c' })

// ── 5. cleanGhlId ─────────────────────────────────────────────────────────────

eq('real GHL id accepted', cleanGhlId('rUw6Sjaw4KCHuPa6IZj9'), 'rUw6Sjaw4KCHuPa6IZj9')
eq('merge tag rejected', cleanGhlId('{{contact.id}}'), null)
eq('serialized object rejected', cleanGhlId('{"ids":[]}'), null)
eq('too-short junk rejected', cleanGhlId('abc'), null)
eq('null → null', cleanGhlId(null), null)

console.log(`\n${fail === 0 ? '✅' : '❌'} webhook-fields-check: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
