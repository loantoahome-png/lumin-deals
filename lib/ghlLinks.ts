// ── Shared GHL UI links ─────────────────────────────────────────────────────
// Resolves which sub-account (location) a contact lives in, then builds the
// canonical "View Contact" URL. Used anywhere we want to jump to GHL from
// the dashboard (deal page header, card headers, etc.).

const GHL_BASE = process.env.NEXT_PUBLIC_GHL_BASE_URL || 'https://app.luminlending.com'

export function ghlContactUrl(deal: {
  ghl_contact_id?: string | null
  ghl_location_id?: string | null
  loan_officer?: string | null
}): string | null {
  if (!deal.ghl_contact_id) return null

  // Preference order:
  //   1. stored ghl_location_id (best signal — set during sync)
  //   2. derive from loan_officer name (Matt/Park → Matt's, Moe/Sefati → Moe's)
  //   3. fall back to the default location env var
  let locId = deal.ghl_location_id ?? null
  if (!locId) {
    const lo = (deal.loan_officer ?? '').toLowerCase()
    if (lo.includes('matt') || lo.includes('park')) {
      locId = process.env.NEXT_PUBLIC_GHL_LOCATION_ID_MATT ?? null
    } else if (lo.includes('moe') || lo.includes('sefati')) {
      locId = process.env.NEXT_PUBLIC_GHL_LOCATION_ID ?? null
    }
  }
  if (!locId) locId = process.env.NEXT_PUBLIC_GHL_LOCATION_ID ?? null
  if (!locId) return null

  return `${GHL_BASE}/v2/location/${locId}/contacts/detail/${deal.ghl_contact_id}`
}
