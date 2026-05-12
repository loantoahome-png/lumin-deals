import type { SupabaseClient } from '@supabase/supabase-js'

/** Normalize a phone string to its last 10 digits, or null if invalid. */
export function normPhone(s: string | null | undefined): string | null {
  if (!s) return null
  const digits = String(s).replace(/\D/g, '')
  return digits.length >= 10 ? digits.slice(-10) : null
}

/** Normalize an email for matching (lowercase + trim). */
export function normEmail(s: string | null | undefined): string | null {
  if (!s) return null
  const t = String(s).toLowerCase().trim()
  return t || null
}

/**
 * Find an existing dashboard deal that matches an incoming contact, falling back
 * through identifiers in order of confidence:
 *   1. ghl_contact_id (highest signal — exact GHL contact match)
 *   2. email (case-insensitive)
 *   3. phone (normalized to last 10 digits)
 *
 * This handles the case where GHL gives the same person multiple contact IDs
 * over time (deletes + re-adds, merges, manual data entry) — we'll catch the
 * duplicate via email/phone and update the existing dashboard record instead
 * of creating a new one.
 */
export async function findExistingDeal(
  supabase: SupabaseClient,
  { ghlContactId, email, phone }: {
    ghlContactId?: string | null
    email?: string | null
    phone?: string | null
  },
): Promise<{ id: string; matchedBy: 'ghl_contact_id' | 'email' | 'phone' } | null> {
  // 1. By GHL contact ID
  if (ghlContactId) {
    const { data } = await supabase
      .from('deals')
      .select('id')
      .eq('ghl_contact_id', ghlContactId)
      .maybeSingle()
    if (data) return { id: data.id as string, matchedBy: 'ghl_contact_id' }
  }
  // 2. By email
  const e = normEmail(email)
  if (e) {
    const { data } = await supabase
      .from('deals')
      .select('id')
      .ilike('email', e)
      .limit(1)
      .maybeSingle()
    if (data) return { id: data.id as string, matchedBy: 'email' }
  }
  // 3. By phone (full table scan — webhook is per-request so this is fine for one call)
  const p = normPhone(phone)
  if (p) {
    const { data } = await supabase
      .from('deals')
      .select('id, phone')
      .not('phone', 'is', null)
      .limit(5000)
    const match = (data as Array<{ id: string; phone: string | null }> | null)?.find(
      d => normPhone(d.phone) === p,
    )
    if (match) return { id: match.id, matchedBy: 'phone' }
  }
  return null
}
