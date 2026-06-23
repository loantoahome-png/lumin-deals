import type { SupabaseClient } from '@supabase/supabase-js'
import { normEmail, normPhone } from './dealMatcher'

// ─────────────────────────────────────────────────────────────────────────────
// Cross-source identity resolver (Contacts Phase 1).
//
// The dashboard's only "this is one person" key is `borrower_id`, assigned once
// at insert and then frozen. Loans created before a linking signal exists (a
// second GHL sub-account, or an Arive row imported before its GHL opp) end up
// with separate borrower_ids that never heal — surfacing as false duplicates.
//
// This module recomputes a canonical borrower_id per person by union-finding
// deals that share a STRONG, NON-WEAK identifier. It never matches on name.
// `resolveIdentities` is pure (no I/O) so it can be unit-tested on fixtures
// before it ever touches the database.
// ─────────────────────────────────────────────────────────────────────────────

// ── Weak-value blocklist ─────────────────────────────────────────────────────
// A value shared by unrelated people (a brokerage catch-all email, a placeholder
// phone) must NEVER create a match edge — otherwise one junk value chains
// strangers into a single "person". Seeded near-empty per spec and grown
// reactively from the dry-run report if a bad merge ever surfaces.
export const WEAK_EMAILS = new Set<string>() // exact normalized emails to ignore as a key
export const WEAK_PHONES = new Set<string>() // exact 10-digit phones to ignore as a key
const ROLE_EMAIL_RE = /^(?:info|admin|noreply|no-reply|support|office|sales)@/

/** A normalized email that should NOT be used to link two records (or is empty). */
export function isWeakEmail(email: string | null | undefined): boolean {
  const e = normEmail(email)
  if (!e) return true
  if (ROLE_EMAIL_RE.test(e)) return true
  return WEAK_EMAILS.has(e)
}

/** A normalized phone that should NOT be used to link two records (or is empty). */
export function isWeakPhone(phone: string | null | undefined): boolean {
  const p = normPhone(phone)
  if (!p) return true
  if (/^(\d)\1{9}$/.test(p)) return true // all-same-digit (0000000000, 1111111111, …)
  return WEAK_PHONES.has(p)
}

export type ResolverDeal = {
  id: string
  created_at: string
  borrower_id: string | null
  ghl_contact_id: string | null
  email: string | null
  phone: string | null
  // Optional — only needed to build contact rollups (computeContactRows). The pure
  // resolver matching ignores them, so fixtures can omit them.
  updated_at?: string | null
  name?: string | null
  loan_amount?: number | null
  compensation_amount?: number | null
  pipeline_group?: string | null
}

export type ComponentReport = {
  canonical: string
  size: number
  priorBorrowerIds: string[]
}

export type ResolverResult = {
  rewrites: { id: string; from: string | null; to: string }[]
  componentsChanged: number
  dealsRewritten: number
  /** Largest component that the resolver would actually MERGE (drives the safety cap).
   *  Pre-existing groups that are already canonical do not count — they are no-ops. */
  largestComponentSize: number
  components: ComponentReport[] // only components that change
}

/**
 * Union-find deals into people via shared NON-WEAK identifiers
 * (ghl_contact_id ∪ email ∪ phone). Returns EVERY component, including
 * single-deal people. Pure and deterministic — no database access.
 */
export function buildComponents(deals: ResolverDeal[]): ResolverDeal[][] {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)!
    let cur = x
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!
      parent.set(cur, root)
      cur = next
    }
    return root
  }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  for (const d of deals) parent.set(d.id, d.id)

  // Each strong key links every deal that carries it to the first one seen.
  const keyOwner = new Map<string, string>()
  const linkKey = (key: string, dealId: string) => {
    const owner = keyOwner.get(key)
    if (owner === undefined) keyOwner.set(key, dealId)
    else union(owner, dealId)
  }
  for (const d of deals) {
    if (d.ghl_contact_id) linkKey('cid:' + d.ghl_contact_id, d.id)
    if (!isWeakEmail(d.email)) linkKey('email:' + normEmail(d.email), d.id)
    if (!isWeakPhone(d.phone)) linkKey('phone:' + normPhone(d.phone), d.id)
    // Also link by the already-assigned borrower_id. This keeps a KEYLESS deal
    // (e.g. an Arive-only row with no email/phone/contact-id, matched in by name at
    // import) attached to its person, and never merges two distinct borrower_ids —
    // so a component can't resolve two ways and clobber a contact row.
    if (d.borrower_id) linkKey('bid:' + d.borrower_id, d.id)
  }

  const comps = new Map<string, ResolverDeal[]>()
  for (const d of deals) {
    const root = find(d.id)
    const arr = comps.get(root)
    if (arr) arr.push(d)
    else comps.set(root, [d])
  }
  return [...comps.values()]
}

/** Canonical borrower_id for a component: earliest-created member that has one,
 *  tie-break = lexicographically smallest borrower_id. Null if none has one. */
export function canonicalBorrowerId(members: ResolverDeal[]): string | null {
  const withBid = members.filter(m => m.borrower_id)
  if (withBid.length === 0) return null
  withBid.sort((a, b) => {
    const t = a.created_at.localeCompare(b.created_at)
    return t !== 0 ? t : (a.borrower_id as string).localeCompare(b.borrower_id as string)
  })
  return withBid[0].borrower_id as string
}

/**
 * Compute the canonical borrower_id per person and the rewrites needed to unify
 * split identities. Pure and deterministic.
 */
export function resolveIdentities(deals: ResolverDeal[]): ResolverResult {
  const rewrites: ResolverResult['rewrites'] = []
  const components: ComponentReport[] = []
  let largestComponentSize = 0

  for (const members of buildComponents(deals)) {
    const canonical = canonicalBorrowerId(members)
    if (!canonical) continue // no borrower_id anywhere (shouldn't happen) → skip

    const changed = members.filter(m => m.borrower_id !== canonical)
    if (changed.length === 0) continue // already unified — nothing to do

    largestComponentSize = Math.max(largestComponentSize, members.length)
    for (const m of changed) rewrites.push({ id: m.id, from: m.borrower_id, to: canonical })
    components.push({
      canonical,
      size: members.length,
      priorBorrowerIds: [...new Set(members.map(m => m.borrower_id).filter(Boolean) as string[])],
    })
  }

  return {
    rewrites,
    componentsChanged: components.length,
    dealsRewritten: rewrites.length,
    largestComponentSize,
    components,
  }
}

// ── Contacts (Phase 2) ───────────────────────────────────────────────────────
// One ContactRow per person, keyed by the canonical borrower_id, with identity +
// rollups derived from that person's loans. Pure; the I/O pass persists them.

export type ContactRow = {
  id: string // = canonical borrower_id
  display_name: string | null
  email: string | null
  phone: string | null
  ghl_contact_ids: string[]
  loan_count: number
  funded_count: number
  total_funded_volume: number
  total_comp: number
  first_loan_at: string | null
  last_loan_at: string | null
}

export function computeContactRows(deals: ResolverDeal[]): ContactRow[] {
  const rows: ContactRow[] = []
  for (const members of buildComponents(deals)) {
    const id = canonicalBorrowerId(members)
    if (!id) continue

    // Identity = the most-recently-updated member's non-null values.
    const byRecency = [...members].sort((a, b) =>
      (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at),
    )
    const pick = (f: (d: ResolverDeal) => string | null | undefined): string | null => {
      for (const d of byRecency) { const v = f(d); if (v) return v }
      return null
    }
    const funded = members.filter(m => m.pipeline_group === 'Funded')
    const createdAts = members.map(m => m.created_at).filter(Boolean).sort()

    rows.push({
      id,
      display_name: pick(d => d.name),
      email: pick(d => d.email),
      phone: pick(d => d.phone),
      ghl_contact_ids: [...new Set(members.map(m => m.ghl_contact_id).filter(Boolean) as string[])],
      loan_count: members.length,
      funded_count: funded.length,
      total_funded_volume: funded.reduce((s, m) => s + (m.loan_amount ?? 0), 0),
      total_comp: funded.reduce((s, m) => s + (m.compensation_amount ?? 0), 0),
      first_loan_at: createdAts[0] ?? null,
      last_loan_at: createdAts[createdAts.length - 1] ?? null,
    })
  }
  return rows
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O orchestration — load all deals, resolve, optionally apply.
// Shared by the /api/resolve-identities endpoint and the maintenance cron so the
// two can never diverge.
// ─────────────────────────────────────────────────────────────────────────────

// Over-merge guards. The known universe is ~40 components of 2-3 deals (largest real
// person = 8: Rene Gonzalez); a bigger merged component or a mass rewrite signals a
// junk key chaining strangers, so we refuse to write unless explicitly overridden.
// Cap set to 20 for headroom (high-volume investor clients) — the blocklist + exact-
// key matching remain the primary over-merge guard; this is the coarse backstop.
export const SAFETY_MAX_COMPONENT = 20
export const SAFETY_MAX_REWRITES = 200

export type PassSummary = {
  scanned: number
  dryRun: boolean
  applied: boolean
  aborted?: boolean
  reason?: string
  componentsChanged: number
  dealsRewritten: number
  largestComponentSize: number
  sample: ComponentReport[] // up to 20 largest changed components
  backupKey?: string
  contactsUpserted?: number
  contactsDeleted?: number
}

export async function runIdentityResolutionPass(
  supabase: SupabaseClient,
  opts: { apply?: boolean; override?: boolean } = {},
): Promise<PassSummary> {
  const apply = opts.apply === true
  const override = opts.override === true

  // 1. Page every deal (PostgREST caps a select at 1000 rows).
  const deals: ResolverDeal[] = []
  const PAGE = 1000
  let offset = 0
  for (;;) {
    const { data, error } = await supabase
      .from('deals')
      .select('id, created_at, updated_at, borrower_id, ghl_contact_id, email, phone, name, loan_amount, compensation_amount, pipeline_group')
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1)
    if (error) throw new Error(`[identityResolver] deal page ${offset} failed: ${error.message}`)
    const rows = (data ?? []) as ResolverDeal[]
    deals.push(...rows)
    if (rows.length < PAGE) break
    offset += PAGE
  }

  // 2. Resolve (pure).
  const result = resolveIdentities(deals)
  const sample = [...result.components].sort((a, b) => b.size - a.size).slice(0, 20)
  const base: PassSummary = {
    scanned: deals.length,
    dryRun: !apply,
    applied: false,
    componentsChanged: result.componentsChanged,
    dealsRewritten: result.dealsRewritten,
    largestComponentSize: result.largestComponentSize,
    sample,
  }

  // 3. Safety cap — refuse to write on an implausibly large merge unless overridden.
  if (
    !override &&
    (result.largestComponentSize > SAFETY_MAX_COMPONENT || result.dealsRewritten > SAFETY_MAX_REWRITES)
  ) {
    return {
      ...base,
      aborted: true,
      reason:
        `safety cap hit: largestComponent=${result.largestComponentSize} (max ${SAFETY_MAX_COMPONENT}), ` +
        `rewrites=${result.dealsRewritten} (max ${SAFETY_MAX_REWRITES}). Pass override=true to force.`,
    }
  }

  // 4. Dry run → report only, no writes.
  if (!apply) return base

  // 5. Apply borrower_id rewrites (if any) — reversible backup FIRST.
  let written = 0
  let backupKey: string | undefined
  if (result.rewrites.length > 0) {
    backupKey = `identity_resolve_backup_${new Date().toISOString()}`
    const { error: backupErr } = await supabase
      .from('sync_state')
      .upsert({ key: backupKey, value: result.rewrites })
    if (backupErr) {
      throw new Error(`[identityResolver] backup write failed — aborting before any mutation: ${backupErr.message}`)
    }
    const CHUNK = 50
    for (let i = 0; i < result.rewrites.length; i += CHUNK) {
      const chunk = result.rewrites.slice(i, i + CHUNK)
      const errs = await Promise.all(
        chunk.map(w => supabase.from('deals').update({ borrower_id: w.to }).eq('id', w.id).then(r => r.error)),
      )
      for (const e of errs) {
        if (e) console.error(`[identityResolver] borrower_id update failed: ${e.message}`)
        else written++
      }
    }
  }

  // 6. Maintain the contacts table — one row per person, keyed by the canonical
  //    borrower_id. Runs on EVERY apply (new deals need their contact refreshed even
  //    when grouping didn't change). computeContactRows derives the canonical id
  //    itself, so it is correct against the just-written borrower_ids.
  const contactRows = computeContactRows(deals)
  const stamp = new Date().toISOString()
  let contactsUpserted = 0
  const CCHUNK = 100
  for (let i = 0; i < contactRows.length; i += CCHUNK) {
    const chunk = contactRows.slice(i, i + CCHUNK).map(c => ({ ...c, updated_at: stamp }))
    const { error } = await supabase.from('contacts').upsert(chunk)
    if (error) console.error(`[identityResolver] contacts upsert failed: ${error.message}`)
    else contactsUpserted += chunk.length
  }

  // Delete orphan contacts (id no longer a canonical borrower_id). Guarded: never
  // run the delete when we somehow computed zero people (avoids wiping the table).
  let contactsDeleted = 0
  if (contactRows.length > 0) {
    const validIds = new Set(contactRows.map(c => c.id))
    // Keep co-borrower contacts alive even when they have no loan of their OWN —
    // they're linked via deal_contacts (role='co') and computeContactRows (deal-
    // derived) won't include them, so without this they'd be pruned + cascade-
    // delete the link. Guarded: if deal_contacts doesn't exist yet, skip silently.
    const { data: coLinks, error: coErr } = await supabase.from('deal_contacts').select('contact_id')
    if (!coErr) for (const l of (coLinks ?? []) as { contact_id: string }[]) validIds.add(l.contact_id)
    const { data: existing } = await supabase.from('contacts').select('id')
    const orphanIds = ((existing ?? []) as { id: string }[]).map(r => r.id).filter(id => !validIds.has(id))
    for (let i = 0; i < orphanIds.length; i += 100) {
      const chunk = orphanIds.slice(i, i + 100)
      const { error } = await supabase.from('contacts').delete().in('id', chunk)
      if (error) console.error(`[identityResolver] contacts delete failed: ${error.message}`)
      else contactsDeleted += chunk.length
    }
  }

  return { ...base, applied: true, dealsRewritten: written, backupKey, contactsUpserted, contactsDeleted }
}
