// Manual lead-source pins.
//
// The sync owns `deals.source` — it is in the update field list, so it is rewritten
// on every pass. That is correct almost always (it is how the book self-heals), but
// it means a human correction cannot survive: set a source by hand and the next run
// puts GHL's answer back within 15 minutes, silently.
//
// A pin is the exception. It says: for THIS opportunity, we know better than GHL.
// The case that forced it (2026-07-28): after attribution moved to the vendor on the
// opportunity, two leads Efrain had actually PAID for landed on a non-vendor
// opportunity source — the opportunity was re-created off a later touchpoint (a
// discovery call, a Meta form) after the lead was bought, so GHL's opportunity no
// longer names the aggregator that billed him. The spend is real; the attribution is
// not, and no GHL field carries the truth.
//
// Stored in `sync_state` under `source_pins` (key/value jsonb) — the same team-shared
// pattern as tools_list / lenders_list, so this needs no schema change and every
// environment sees one list.
//
// Keyed by GHL opportunity id, not deal id: the opportunity is the thing being
// attributed, and the id survives a deal row being rebuilt.

export const SOURCE_PINS_KEY = 'source_pins'

export type SourcePin = {
  opportunity_id: string
  source: string
  /** Why this overrides GHL. Required in practice — a pin with no rationale is
   *  indistinguishable from a mistake once whoever set it has forgotten. */
  reason?: string
  pinned_at?: string
}

/** Parse the stored value into opportunity_id → source. Tolerates junk: a malformed
 *  pins row must never take the sync down, it just means no pins are applied. */
export function parseSourcePins(value: unknown): Map<string, string> {
  const map = new Map<string, string>()
  if (!Array.isArray(value)) return map
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const id = typeof r.opportunity_id === 'string' ? r.opportunity_id.trim() : ''
    const source = typeof r.source === 'string' ? r.source.trim() : ''
    if (id && source) map.set(id, source)
  }
  return map
}

/** The source to write for an opportunity: the pin if there is one, else whatever
 *  the normal GHL resolution produced. */
export function applySourcePin(
  pins: Map<string, string>,
  opportunityId: string | null | undefined,
  resolved: string | null,
): string | null {
  const id = (opportunityId ?? '').trim()
  if (id && pins.has(id)) return pins.get(id)!
  return resolved
}
