// ── Co-borrower data-access (deal_contacts join) ────────────────────────────
// The PRIMARY borrower is `deals.borrower_id`. Co-borrowers are `deal_contacts`
// rows with role='co' → contacts. find-or-create reuses the identity resolver's
// strong-key matching (email/phone, never name) so an existing person is reused.
import type { SupabaseClient } from '@supabase/supabase-js'
import { normEmail, normPhone } from './dealMatcher'
import { isWeakEmail, isWeakPhone } from './identityResolver'
import { titleCase } from './utils'
import type { CoborrowerLite } from './types'

/** Identity fields stamped onto a deal when its primary borrower is set manually. */
export type BorrowerIdentity = {
  borrower_id: string
  name: string
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  borrower_locked: true
}

/** Split a display name into title-cased first/last (drops middle tokens). */
function splitName(full: string | null): { first: string | null; last: string | null } {
  const tokens = (full ?? '').trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { first: null, last: null }
  const first = titleCase(tokens[0])
  const last = tokens.length > 1 ? titleCase(tokens[tokens.length - 1]) : null
  return { first, last }
}

/** Co-borrowers (role='co') on a deal, with their contact identity. */
export async function listCoborrowers(sb: SupabaseClient, dealId: string): Promise<CoborrowerLite[]> {
  const { data: links, error } = await sb
    .from('deal_contacts')
    .select('contact_id')
    .eq('deal_id', dealId)
    .eq('role', 'co')
  if (error) throw new Error(`listCoborrowers failed: ${error.message}`)
  const ids = ((links ?? []) as { contact_id: string }[]).map(l => l.contact_id)
  if (ids.length === 0) return []
  const { data: contacts, error: cErr } = await sb
    .from('contacts')
    .select('id, display_name, email, phone')
    .in('id', ids)
  if (cErr) throw new Error(`listCoborrowers contacts failed: ${cErr.message}`)
  return ((contacts ?? []) as { id: string; display_name: string | null; email: string | null; phone: string | null }[])
    .map(c => ({ contact_id: c.id, name: c.display_name, email: c.email, phone: c.phone }))
}

/** Find an existing contact by non-weak email then phone; create one if none. Returns contact id. */
export async function findOrCreateContact(
  sb: SupabaseClient,
  person: { name?: string | null; email?: string | null; phone?: string | null },
): Promise<string> {
  const email = person.email ?? null
  const phone = person.phone ?? null

  // 1. Existing contact by non-weak email (exact, case-insensitive).
  if (!isWeakEmail(email)) {
    const e = normEmail(email)!
    const { data } = await sb.from('contacts').select('id').ilike('email', e).limit(1).maybeSingle()
    if (data) return (data as { id: string }).id
  }
  // 2. Existing contact by non-weak phone (normalize both sides; small table → scan).
  if (!isWeakPhone(phone)) {
    const p = normPhone(phone)!
    const { data } = await sb.from('contacts').select('id, phone').not('phone', 'is', null).limit(5000)
    const match = (data as { id: string; phone: string | null }[] | null)?.find(c => normPhone(c.phone) === p)
    if (match) return match.id
  }
  // 3. Create. id has no DB default → generate; rollups default to 0 server-side.
  const id = crypto.randomUUID()
  const { error } = await sb.from('contacts').insert({
    id,
    display_name: (person.name ?? '').trim() || null,
    email: normEmail(email),
    phone: (phone ?? '').trim() || null,
  })
  if (error) throw new Error(`findOrCreateContact insert failed: ${error.message}`)
  return id
}

/** Link a contact as a co-borrower (idempotent). Refuses to link the deal's own primary. */
export async function linkCoborrower(sb: SupabaseClient, dealId: string, contactId: string): Promise<void> {
  const { data: deal } = await sb.from('deals').select('borrower_id').eq('id', dealId).maybeSingle()
  if ((deal as { borrower_id: string | null } | null)?.borrower_id === contactId) {
    throw new Error('contact is already the primary borrower on this deal')
  }
  const { error } = await sb
    .from('deal_contacts')
    .upsert({ deal_id: dealId, contact_id: contactId, role: 'co' }, { onConflict: 'deal_id,contact_id' })
  if (error) throw new Error(`linkCoborrower failed: ${error.message}`)
}

/**
 * Link a co-borrower discovered during an Arive import. Unlike the manual path,
 * Arive co-borrowers are frequently NAME-ONLY (their email/phone are the primary's
 * and were stripped upstream). Resolution order:
 *   1. Reuse a co-borrower already on THIS deal whose name matches (idempotent re-imports).
 *   2. Strong-key match by email/phone (when present).
 *   3. Create a fresh contact (name-only when that's all we have).
 * Silently SKIPS (no throw) if it resolves to the deal's own primary.
 */
export async function linkCoborrowerFromImport(
  sb: SupabaseClient,
  dealId: string,
  person: { name?: string | null; email?: string | null; phone?: string | null },
): Promise<'linked' | 'skipped'> {
  const name = (person.name ?? '').trim()
  const email = person.email ?? null
  const phone = person.phone ?? null
  if (!name && !email && !phone) return 'skipped'

  const { data: deal } = await sb.from('deals').select('borrower_id').eq('id', dealId).maybeSingle()
  const primaryId = (deal as { borrower_id: string | null } | null)?.borrower_id ?? null

  const normName = (s: string | null) => (s ?? '').toLowerCase().replace(/[^a-z]/g, '')
  let contactId: string | null = null

  // 1. Reuse an existing co-borrower on this deal by name (idempotency).
  if (name) {
    const { data: links } = await sb.from('deal_contacts').select('contact_id').eq('deal_id', dealId).eq('role', 'co')
    const ids = ((links ?? []) as { contact_id: string }[]).map(l => l.contact_id)
    if (ids.length) {
      const { data: cs } = await sb.from('contacts').select('id, display_name').in('id', ids)
      const hit = ((cs ?? []) as { id: string; display_name: string | null }[])
        .find(c => normName(c.display_name) === normName(name))
      if (hit) contactId = hit.id
    }
  }
  // 2. Strong-key match (email/phone) / 3. create.
  if (!contactId) {
    if (email || phone) {
      contactId = await findOrCreateContact(sb, person)
    } else {
      const id = crypto.randomUUID()
      const { error } = await sb.from('contacts').insert({ id, display_name: name || null, email: null, phone: null })
      if (error) throw new Error(`coborrower contact insert failed: ${error.message}`)
      contactId = id
    }
  }
  if (!contactId || contactId === primaryId) return 'skipped' // the co-borrower IS the primary — skip quietly
  await linkCoborrower(sb, dealId, contactId)
  return 'linked'
}

/** Remove a co-borrower link. */
export async function unlinkCoborrower(sb: SupabaseClient, dealId: string, contactId: string): Promise<void> {
  const { error } = await sb.from('deal_contacts').delete().eq('deal_id', dealId).eq('contact_id', contactId)
  if (error) throw new Error(`unlinkCoborrower failed: ${error.message}`)
}

/**
 * Promote a co-borrower to primary: point borrower_id at them, STAMP their identity
 * (name/first/last/email/phone) onto the deal, and set `borrower_locked` so the GHL
 * sync stops reverting the borrower to the GHL contact on the opportunity. The old
 * primary is demoted to a co-borrower. Returns the identity written (for the UI).
 *
 * Why stamp + lock: the deal's display borrower comes from `deals.name/email/phone`,
 * which the GHL sync overwrites every run from the opp's GHL contact. Changing only
 * `borrower_id` would leave the old name showing and get re-synced. See the
 * 2026-06-29 Espinoza diagnosis.
 */
export async function promoteToPrimary(
  sb: SupabaseClient, dealId: string, contactId: string,
): Promise<BorrowerIdentity | null> {
  const { data: deal } = await sb.from('deals').select('borrower_id').eq('id', dealId).maybeSingle()
  const oldPrimary = (deal as { borrower_id: string | null } | null)?.borrower_id ?? null
  if (oldPrimary === contactId) return null // already primary — no-op

  // Pull the promoted contact's identity to stamp onto the deal.
  const { data: c } = await sb.from('contacts')
    .select('display_name, email, phone').eq('id', contactId).maybeSingle()
  const contact = (c as { display_name: string | null; email: string | null; phone: string | null } | null)
  const { first, last } = splitName(contact?.display_name ?? null)
  const identity: BorrowerIdentity = {
    borrower_id: contactId,
    name: titleCase(contact?.display_name ?? null) || (contact?.display_name ?? '').trim() || 'Unknown',
    first_name: first,
    last_name: last,
    email: contact?.email ?? null,
    phone: contact?.phone ?? null,
    borrower_locked: true,
  }

  const { error: upErr } = await sb.from('deals').update(identity).eq('id', dealId)
  if (upErr) throw new Error(`promoteToPrimary set borrower failed: ${upErr.message}`)
  // The new primary is no longer a co-borrower.
  await sb.from('deal_contacts').delete().eq('deal_id', dealId).eq('contact_id', contactId)
  // Old primary becomes a co-borrower (if there was one).
  if (oldPrimary && oldPrimary !== contactId) {
    const { error } = await sb
      .from('deal_contacts')
      .upsert({ deal_id: dealId, contact_id: oldPrimary, role: 'co' }, { onConflict: 'deal_id,contact_id' })
    if (error) throw new Error(`promoteToPrimary demote old primary failed: ${error.message}`)
  }
  return identity
}
