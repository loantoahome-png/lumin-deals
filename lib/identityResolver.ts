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
 * Group deals into people and compute the canonical borrower_id for each.
 * Pure and deterministic — no database access.
 */
export function resolveIdentities(deals: ResolverDeal[]): ResolverResult {
  // ── Union-Find over deal ids ──
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)!
    // path compression
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
  }

  // ── Collect components ──
  const comps = new Map<string, ResolverDeal[]>()
  for (const d of deals) {
    const root = find(d.id)
    const arr = comps.get(root)
    if (arr) arr.push(d)
    else comps.set(root, [d])
  }

  const rewrites: ResolverResult['rewrites'] = []
  const components: ComponentReport[] = []
  let largestComponentSize = 0

  for (const members of comps.values()) {
    // Canonical = borrower_id of the earliest-created member that has one;
    // deterministic tie-break = lexicographically smallest borrower_id.
    const withBid = members.filter(m => m.borrower_id)
    if (withBid.length === 0) continue // no borrower_id anywhere (shouldn't happen) → skip
    withBid.sort((a, b) => {
      const t = a.created_at.localeCompare(b.created_at)
      return t !== 0 ? t : (a.borrower_id as string).localeCompare(b.borrower_id as string)
    })
    const canonical = withBid[0].borrower_id as string

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
      .select('id, created_at, borrower_id, ghl_contact_id, email, phone')
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

  // 5. Apply. Nothing to do?
  if (result.rewrites.length === 0) return { ...base, applied: true }

  // 5a. Reversible backup FIRST (durable in `sync_state`; works on Vercel's read-only FS).
  const backupKey = `identity_resolve_backup_${new Date().toISOString()}`
  const { error: backupErr } = await supabase
    .from('sync_state')
    .upsert({ key: backupKey, value: result.rewrites })
  if (backupErr) {
    throw new Error(`[identityResolver] backup write failed — aborting before any mutation: ${backupErr.message}`)
  }

  // 5b. Batched borrower_id rewrites (bounded concurrency).
  const CHUNK = 50
  let written = 0
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

  return { ...base, applied: true, dealsRewritten: written, backupKey }
}
