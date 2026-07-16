// Fixture check for the two 2026-07-16 "open in GHL" link fixes:
//   1. extractFields must never put an OPPORTUNITY id in ghl_contact_id
//   2. ghlContactUrl must not render a link for a known-bad (opp) contact id
//
// Run: npx tsx scripts/ghl-link-check.ts
//
// Guards the bug where a flat opportunity webhook payload's `id` (the opp id) beat
// the correct `contact_id` sitting beside it, 404'ing the GHL button until the
// 15-min sync's reconciliation repaired the row.
// See docs/diagnoses/2026-07-16-ghl-link-opp-id-diagnosis.md
import { ghlContactUrl } from '../lib/ghlLinks'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}

// ── Mirror of the webhook's contact-id resolution ─────────────────────────────
// extractFields isn't exported (it's route-local), so we replicate the exact
// COMPOSITION under test — the building blocks (pick/isOpportunityPayload/
// getCustomData/cleanGhlId) are the real ones from lib/webhookPayload.ts. If
// you change the ordering in app/api/webhooks/ghl/route.ts, change it here —
// these fixtures are the regression net for that ordering.
import { pick, isOpportunityPayload, getCustomData, cleanGhlId } from '../lib/webhookPayload'

function resolveContactId(body: Record<string, unknown>): string | null {
  const nestedContact = body.contact as Record<string, unknown> | undefined
  const customData = getCustomData(body)
  return (
    (nestedContact ? pick(nestedContact, 'id', 'contact_id', 'contactId') : null) ||
    pick(body, 'contact_id', 'contactId') ||
    cleanGhlId(customData ? pick(customData, 'contactId', 'contact_id') : null) ||
    (isOpportunityPayload(body) ? null : pick(body, 'id'))
  )
}

const OPP = '4jHxP2JJCpRXom8s7No0'   // Lars Rosene's real opportunity id
const CON = '6zsx1K9Og2afEjB06Iee'   // Lars Rosene's real contact id

// ── 1. extractFields contact-id resolution ────────────────────────────────────

// THE REGRESSION: flat opportunity payload. `id` is the opp id, `contact_id` is
// the real contact. Pre-fix this returned OPP and 404'd the link.
eq('flat opp payload → contact_id wins over body.id',
  resolveContactId({ id: OPP, contact_id: CON, opportunity_name: 'Lars Rosene', pipeline_stage: 'Attempted Contact' }),
  CON)

// camelCase variant of the same shape.
eq('flat opp payload (camelCase contactId)',
  resolveContactId({ id: OPP, contactId: CON, opportunityName: 'Lars Rosene', pipelineStageId: 'abc123' }),
  CON)

// Opportunity payload with a nested contact object (the API/opp-object shape).
eq('opp payload w/ nested contact → nested contact.id',
  resolveContactId({ id: OPP, contact: { id: CON }, contactId: CON, pipelineStageId: 'abc123' }),
  CON)

// Opportunity payload with NO contact id anywhere → null, so the caller's
// `|| undefined` leaves the stored (correct) value untouched. Never OPP.
eq('opp payload w/ no contact id → null (not the opp id)',
  resolveContactId({ id: OPP, opportunity_name: 'Lars Rosene', pipelineStageId: 'abc123' }),
  null)

// Contact payload: bare `id` IS the contact id — must still work.
eq('contact payload → bare id is the contact id',
  resolveContactId({ id: CON, firstName: 'Lars', email: 'lrosene@gmail.com' }),
  CON)

// Contact payload with a nested contact object.
eq('contact payload w/ nested contact object',
  resolveContactId({ contact: { id: CON, firstName: 'Lars' } }),
  CON)

// ── customData step (2026-07-16 webhook-payload audit) ────────────────────────
// The stage workflows map contactId into customData explicitly (99% fill). When
// the standard keys are absent on an opp payload, customData must win over
// returning null — and MUST NOT lose to the bare opp `id`.
eq('opp payload w/ only customData.contactId → customData wins',
  resolveContactId({ id: OPP, opportunity_name: 'Lars Rosene', pipleline_stage: 'Ghosted',
    customData: { contactId: CON, pipelineName: '1) Leads' } }),
  CON)

// An unresolved merge tag ("{{contact.id}}") or other junk must be rejected by
// cleanGhlId — never written to an id column, and never beating the null-safety.
eq('customData junk merge tag → rejected, resolves null (not the opp id)',
  resolveContactId({ id: OPP, opportunity_name: 'Lars Rosene',
    customData: { contactId: '{{contact.id}}' } }),
  null)

// Explicit top-level contact_id still outranks customData (standard data first).
eq('top-level contact_id outranks customData.contactId',
  resolveContactId({ id: OPP, contact_id: CON, opportunity_name: 'Lars',
    customData: { contactId: 'zzzWrongCustomDataId1' } }),
  CON)

// ── 2. ghlContactUrl known-bad-id guard ───────────────────────────────────────
const LOC = '84fCsPjMP7RHe8P6JEe0'  // Matt's sub-account

eq('good contact id → link renders',
  ghlContactUrl({ ghl_contact_id: CON, ghl_opportunity_id: OPP, ghl_location_id: LOC }),
  `https://app.luminlending.com/v2/location/${LOC}/contacts/detail/${CON}`)

eq('contact id === opp id → NO link (the 404 case)',
  ghlContactUrl({ ghl_contact_id: OPP, ghl_opportunity_id: OPP, ghl_location_id: LOC }),
  null)

eq('no contact id → no link',
  ghlContactUrl({ ghl_contact_id: null, ghl_opportunity_id: OPP, ghl_location_id: LOC }),
  null)

// Callers with a narrow select (no ghl_opportunity_id) must still get a link —
// the guard is skipped, not tripped.
eq('opp id absent → guard skipped, link still renders',
  ghlContactUrl({ ghl_contact_id: CON, ghl_location_id: LOC }),
  `https://app.luminlending.com/v2/location/${LOC}/contacts/detail/${CON}`)

console.log(`\n${fail === 0 ? '✅' : '❌'} ghl-link-check: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
