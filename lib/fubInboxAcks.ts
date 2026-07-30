// "Handled" acknowledgments for the FollowUpBoss half of the reply inbox.
//
// Efrain 2026-07-30: "Sometimes a reply from a client doesn't need a reply from
// us, can we check it off from the list without having a sync or anything
// bringing it back. Only thing to bring it back would be a new response."
//
// So this is NOT a snooze (no date) and NOT "Touched" (which claims we reached
// out). It is an acknowledgment of one specific message: I've seen it, nothing
// is owed. The row returns only when a message NEWER than the acked one lands —
// exactly the contract `comm_read_acks` already provides on the GHL side.
//
// Stored in `sync_state` under `fub_inbox_acks`, the same team-shared key/value
// pattern as tools_list / lenders_list / source_pins. Two reasons that beats a
// column on fub_people:
//   • the sweep only stores Past Client + Closed + task-holders, so a texter who
//     isn't in fub_people has NO row to write — those are precisely the rows
//     Efrain found with no buttons at all (Joey Kiamco, Eutah Modegoren, Rose
//     Luttrell). An ack keyed on fub_id alone works for anyone.
//   • no migration to run before it works.

export const FUB_INBOX_ACKS_KEY = 'fub_inbox_acks'

/** fub_id → the ISO timestamp of the message that was acknowledged. */
export type FubInboxAcks = Record<string, string>

/** Parse the stored blob. Junk must never break the inbox — a malformed value
 *  just means nothing is acked, which fails toward showing work, not hiding it. */
export function parseFubInboxAcks(value: unknown): Map<number, number> {
  const map = new Map<number, number>()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return map
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const id = Number(k)
    if (!Number.isFinite(id)) continue
    const at = typeof v === 'string' ? Date.parse(v) : NaN
    if (!isNaN(at)) map.set(id, at)
  }
  return map
}

/** Is this person's latest inbound already acknowledged?
 *  A NEWER message beats the ack and the row comes back. */
export function isAcked(acks: Map<number, number>, fubId: number, lastInboundIso: string): boolean {
  const acked = acks.get(fubId)
  if (acked == null) return false
  const inbound = Date.parse(lastInboundIso)
  if (isNaN(inbound)) return false
  return acked >= inbound
}

/** Drop acks older than the inbox lookback — those rows can no longer surface,
 *  so keeping their acks just grows the blob forever. */
export function pruneAcks(acks: FubInboxAcks, olderThanMs: number): FubInboxAcks {
  const out: FubInboxAcks = {}
  for (const [k, v] of Object.entries(acks)) {
    const at = Date.parse(v)
    if (!isNaN(at) && at >= olderThanMs) out[k] = v
  }
  return out
}
