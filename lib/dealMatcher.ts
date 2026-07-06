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
 * Decide which existing deal an incoming GHL opportunity maps to, using the
 * in-memory indexes the 3-min sync builds. Primary key is the opportunity id.
 * FALLBACK to the Arive loan # so a GHL opportunity that was deleted + re-created
 * (new id, SAME loan) RE-POINTS the existing card instead of spawning a duplicate.
 *
 * The Arive loan # is unique per loan — a deterministic per-loan key, as safe to
 * match on as the opportunity id (unlike contact/email/phone, which can land on a
 * sibling loan). This is the fix for the 2026-07 duplicate-"shell" incident: an opp
 * deleted+recreated in GHL got a new id, and the sync — matching on opportunity id
 * ONLY — didn't recognise it as the existing loan, so it inserted a twin card.
 */
export function resolveExistingLoan<T>(
  opportunityId: string,
  ariveLoanId: string | null | undefined,
  byOppId: Map<string, T>,
  byAriveNo: Map<string, T>,
): T | null {
  return byOppId.get(opportunityId)
    ?? (ariveLoanId ? byAriveNo.get(ariveLoanId) ?? null : null)
}

/**
 * Find an existing dashboard deal that matches an incoming GHL event.
 *
 *   0. opportunity_id  — the ONLY identifier that pins the exact loan
 *   1. ghl_contact_id  — only when it resolves to a single deal
 *   2. email           — only when it resolves to a single deal
 *   3. phone           — only when it resolves to a single deal
 *
 * Why opportunity id must win, and why the others must be single-deal-only:
 * one GHL contact can hold several opportunities (a person with multiple loans).
 * Matching an opportunity webhook by contact/email/phone can land on a SIBLING
 * loan and overwrite its stage/status — e.g. a funded loan's "Loan Funded"
 * webhook marking the borrower's *withdrawn* loan as funded. So we match by
 * opportunity id first, and never guess which sibling a contact-level identifier
 * belongs to: if it points at more than one deal, we return no match and let the
 * 3-min sync (which keys by opportunity id) handle it.
 */
export async function findExistingDeal(
  supabase: SupabaseClient,
  { opportunityId, ghlContactId, email, phone }: {
    opportunityId?: string | null
    ghlContactId?: string | null
    email?: string | null
    phone?: string | null
  },
): Promise<{ id: string; matchedBy: 'opportunity_id' | 'ghl_contact_id' | 'email' | 'phone' } | null> {
  // 0. By opportunity ID — exact loan match, wins over everything.
  if (opportunityId) {
    const { data } = await supabase
      .from('deals')
      .select('id')
      .eq('ghl_opportunity_id', opportunityId)
      .maybeSingle()
    if (data) return { id: data.id as string, matchedBy: 'opportunity_id' }
  }
  // 1. By GHL contact ID — accept only if it identifies exactly one deal.
  if (ghlContactId) {
    const { data } = await supabase
      .from('deals')
      .select('id')
      .eq('ghl_contact_id', ghlContactId)
      .limit(2)
    if (data && data.length === 1) return { id: data[0].id as string, matchedBy: 'ghl_contact_id' }
  }
  // 2. By email — single deal only.
  const e = normEmail(email)
  if (e) {
    const { data } = await supabase
      .from('deals')
      .select('id')
      .ilike('email', e)
      .limit(2)
    if (data && data.length === 1) return { id: data[0].id as string, matchedBy: 'email' }
  }
  // 3. By phone (last-10-digit match) — single deal only.
  const p = normPhone(phone)
  if (p) {
    const { data } = await supabase
      .from('deals')
      .select('id, phone')
      .not('phone', 'is', null)
      .limit(5000)
    const matches = ((data as Array<{ id: string; phone: string | null }> | null) ?? [])
      .filter(d => normPhone(d.phone) === p)
    if (matches.length === 1) return { id: matches[0].id, matchedBy: 'phone' }
  }
  return null
}
