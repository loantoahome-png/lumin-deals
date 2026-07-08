// Fixture check for lib/ghlConversations.ts earliestInboundAt — pure, no network.
// Run: npx tsx scripts/ghl-conversations-check.ts
import { earliestInboundAt, type ConvMessage } from '../lib/ghlConversations'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++; else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}

// Earliest INBOUND wins; outbound ignored.
eq('earliest inbound, ignores outbound + later inbound', earliestInboundAt([
  { direction: 'outbound', dateAdded: '2026-06-01T10:00:00Z', messageType: 'TYPE_SMS' },
  { direction: 'inbound',  dateAdded: '2026-06-03T09:00:00Z', messageType: 'TYPE_SMS' },   // earliest inbound
  { direction: 'inbound',  dateAdded: '2026-06-05T09:00:00Z', messageType: 'TYPE_SMS' },
] as ConvMessage[]), { at: '2026-06-03T09:00:00.000Z', channel: 'Text' })

// Only outbound → null (lead never sent an inbound; e.g. only answered our calls).
eq('all outbound → null', earliestInboundAt([
  { direction: 'outbound', dateAdded: '2026-06-01T10:00:00Z', messageType: 'TYPE_CALL' },
] as ConvMessage[]), null)

// Empty → null.
eq('empty → null', earliestInboundAt([]), null)

// Inbound call is a valid response, channel = Call.
eq('inbound call counts, channel Call', earliestInboundAt([
  { direction: 'inbound', dateAdded: '2026-06-02T08:00:00Z', type: 'TYPE_CALL' },
] as ConvMessage[]), { at: '2026-06-02T08:00:00.000Z', channel: 'Call' })

// Epoch ms + epoch s both parse (GHL sends mixed shapes).
eq('epoch ms parses', earliestInboundAt([
  { direction: 'inbound', dateAdded: 1782000000000, messageType: 'TYPE_EMAIL' },
] as ConvMessage[])?.at, new Date(1782000000000).toISOString())
eq('epoch seconds parses', earliestInboundAt([
  { direction: 'inbound', dateAdded: 1782000000, messageType: 'TYPE_SMS' },
] as ConvMessage[])?.at, new Date(1782000000 * 1000).toISOString())

// Unparseable timestamps skipped.
eq('bad ts skipped → null', earliestInboundAt([
  { direction: 'inbound', dateAdded: 'not-a-date', messageType: 'TYPE_SMS' },
] as ConvMessage[]), null)

// Out-of-order list still yields the true earliest.
eq('unordered picks true earliest', earliestInboundAt([
  { direction: 'inbound', dateAdded: '2026-06-09T00:00:00Z', messageType: 'TYPE_SMS' },
  { direction: 'inbound', dateAdded: '2026-06-04T00:00:00Z', messageType: 'TYPE_SMS' },
  { direction: 'inbound', dateAdded: '2026-06-07T00:00:00Z', messageType: 'TYPE_SMS' },
] as ConvMessage[])?.at, '2026-06-04T00:00:00.000Z')

console.log(`\nghl-conversations-check: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
