// Manual lead-PRICE pins.
//
// Sibling of lib/sourcePins.ts, same mechanism, different column — and it exists
// for the same reason: `lead_price` is in the sync's maybeSet list, so a manual
// correction is re-stamped within 15 minutes and silently reverts.
//
// WHY a price needs overriding at all. The sync reads lead_price from the CONTACT
// (app/api/sync/ghl/route.ts) and lets the OPPORTUNITY's own "Lead Price" custom
// field overlay it when present (lib/ghlOpportunityFields.ts). That fallback is
// deliberate — Arive-created loan opportunities carry no lead fields, and the
// contact price is then the only record of what the lead cost, so "missing" must
// mean UNKNOWN, never FREE.
//
// But one contact can hold several opportunities, and the contact's single price
// then bleeds onto every one of them. The case that forced this pin (2026-09-21):
// Ellen Kessler shares a GHL contact with Daniel Kessler. Daniel is a real Lendgo
// purchase — vendor_lead_id 16105585, $23, Lendgo's standard price (546 of the 555
// $23 rows in the book are Lendgo). Ellen's opportunity was created four months
// later, is tagged Self Source / "Self Sourced" on both source fields, and is a
// returning borrower we paid nothing to get back. Her opportunity has no Lead Price
// custom field, so the contact's $23 landed on her too: one charge, billed once,
// stamped on two rows — a phantom cost on Self Source and a $23 hole in Lendgo.
//
// A pin says: for THIS opportunity, we know the real cost better than GHL does.
//
// ⚠️ A pin of 0 means FREE AND WE KNOW IT — an explicit, deliberate zero, which is
// exactly the statement the "missing means unknown" fallback cannot make. That is
// the whole point of the pin, so 0 must survive every falsy check below.
//
// ⚠️ This does NOT license deduping spend by contact or vendor_lead_id. Buying the
// same person twice is normal and every priced opportunity is a real separate
// charge. A pin is a per-opportunity fact someone established by hand, one row at a
// time, with a reason attached — not a rule.
//
// Stored in `sync_state` under `lead_price_pins` (key/value jsonb) — the same
// team-shared pattern as source_pins / tools_list / lenders_list, so it needs no
// schema change and every environment sees one list. Kept in its own key rather
// than bolted onto source_pins so editing attribution can never corrupt cost.
//
// Keyed by GHL opportunity id, not deal id: the opportunity is the thing that was
// purchased, and the id survives a deal row being rebuilt.

export const LEAD_PRICE_PINS_KEY = 'lead_price_pins'

export type LeadPricePin = {
  opportunity_id: string
  /** The real cost of THIS opportunity. 0 = free and we know it. */
  lead_price: number
  /** Why this overrides GHL. Required in practice — a pin with no rationale is
   *  indistinguishable from a mistake once whoever set it has forgotten. */
  reason?: string
  pinned_at?: string
}

/** Parse the stored value into opportunity_id → price. Tolerates junk: a malformed
 *  pins row must never take the sync down, it just means no pins are applied. */
export function parseLeadPricePins(value: unknown): Map<string, number> {
  const map = new Map<string, number>()
  if (!Array.isArray(value)) return map
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const id = typeof r.opportunity_id === 'string' ? r.opportunity_id.trim() : ''
    // Number.isFinite, not a truthiness test: 0 is the most important value a pin
    // can carry, and a negative price is junk rather than a refund.
    const price = typeof r.lead_price === 'number' && Number.isFinite(r.lead_price) && r.lead_price >= 0
      ? r.lead_price
      : null
    if (id && price != null) map.set(id, price)
  }
  return map
}

/** The lead_price to write for an opportunity: the pin if there is one, else
 *  whatever the normal GHL resolution produced (opportunity field, else contact).
 *
 *  ⚠️ Must run AFTER mapOpportunityFields has been overlaid onto the deal — that
 *  overlay also writes lead_price, so a pin applied before it would be discarded. */
export function applyLeadPricePin(
  pins: Map<string, number>,
  opportunityId: string | null | undefined,
  resolved: number | null,
): number | null {
  const id = (opportunityId ?? '').trim()
  if (id && pins.has(id)) return pins.get(id)!
  return resolved
}
