// ── GHL users, per sub-account ───────────────────────────────────────────────
// ⚠️ GHL users are PER-LOCATION. Matt exists only in his own sub-account, and
// there as "Matthew Park" — resolveLO folds that onto the board's "Matt Park".
// Randy is a user in NEITHER configured location, so anything addressed to him
// has to fail loudly with the real list rather than silently do nothing.
//
// Shared by the create and reassign routes so the two can't drift on how a
// board name becomes a GHL user id.

import { GHL_BASE, ghlHeaders } from './ghl'
import { resolveLO } from './loanOfficer'

export type GhlUser = {
  id: string
  /** GHL's own spelling, e.g. "Matthew Park". */
  raw: string
  /** The board column this user maps to, e.g. "Matt Park". */
  board: string
}

/** Every user in one sub-account, with the board name each maps to. */
export async function fetchLocationUsers(locationId: string, apiKey: string): Promise<GhlUser[]> {
  const res = await fetch(`${GHL_BASE}/users/?locationId=${locationId}`, { headers: ghlHeaders(apiKey) })
  if (!res.ok) throw new Error(`users ${res.status}: ${(await res.text()).slice(0, 160)}`)
  const users = ((await res.json()) as {
    users?: { id: string; name?: string; firstName?: string; lastName?: string }[]
  }).users ?? []
  return users
    .map(u => {
      const raw = (u.name ?? `${u.firstName ?? ''} ${u.lastName ?? ''}`).trim()
      return { id: u.id, raw, board: resolveLO(raw) ?? raw }
    })
    .filter(u => u.raw !== '')
}

/**
 * GHL user id for a board assignee within THIS location. `available` is the
 * raw list, so a caller can tell the user who they COULD have picked instead of
 * just refusing.
 */
export async function findUserId(
  locationId: string,
  apiKey: string,
  assignee: string,
): Promise<{ id?: string; available: string[] }> {
  const users = await fetchLocationUsers(locationId, apiKey)
  const hit = users.find(u => u.board === assignee || u.raw === assignee)
  return { id: hit?.id, available: users.map(u => u.raw) }
}
