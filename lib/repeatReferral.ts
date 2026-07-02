// ─────────────────────────────────────────────────────────────────────────────
// Repeat & referral detection — person-level, off the identity graph.
//
// Pure and dependency-free (same contract as refiRadar: unit-testable on
// fixtures, shared by the /radar section, the contacts-list badge, and the
// person-page banner so the three surfaces can never disagree).
//
// Grounded in the live book (2026-07-02): source tagging barely exists — 9
// "Return Client" + 6 "Referral - …" deals across 1,852 — so returning business
// is detected from the resolved person (borrower_id), not from tags: a person
// with a funded loan who has a NEWER non-funded deal came back, whatever the
// source field says. 14 such people live, 5 with an active deal right now.
// ─────────────────────────────────────────────────────────────────────────────

// Minimal structural shape — pages pass Deal rows, fixtures pass plain objects.
export type RepeatDeal = {
  id: string
  borrower_id: string | null
  name: string | null
  pipeline_group: string | null
  status?: string | null
  created_at: string
  funded_date?: string | null
  source?: string | null
  loan_amount?: number | null
  lead_price?: number | null
}

/** Pipeline groups that mean the new deal is being worked right now. */
const ACTIVE_GROUPS = new Set(['Leads', 'Loans in Process'])

const RETURN_TAG_RE = /return|referr/i

export type ReturningClient = {
  borrowerId: string
  name: string | null
  fundedCount: number
  totalFundedVolume: number
  lastFundedAt: string | null
  /** The most recent post-funded deal (an active one wins over a dormant one). */
  newDeal: {
    id: string
    created_at: string
    pipeline_group: string | null
    status: string | null
    source: string | null
    loan_amount: number | null
  }
  /** New deal sits in Leads / Loans in Process → call-now material. */
  active: boolean
  /** Source already says Return Client / Referral — detection just confirms it. */
  taggedReturn: boolean
  /** Lead spend paid on post-funded deals — money spent re-buying a client you
   *  already funded (the person-level lead-spend-dedup signal). */
  rePaidSpend: number
}

/** Classify one person's loans, or null if they aren't a returning client. Pure.
 *  "Returning" = has a funded loan AND a non-funded deal created after the first
 *  funding. The funded anchor falls back to created_at when funded_date is blank
 *  (GHL-sourced funded rows lack it), so those people aren't silently skipped. */
export function classifyReturning(personDeals: RepeatDeal[]): ReturningClient | null {
  const funded = personDeals.filter(d => d.pipeline_group === 'Funded')
  if (funded.length === 0) return null

  const fundedAnchor = funded
    .map(d => d.funded_date || d.created_at)
    .filter(Boolean)
    .sort()[0]
  if (!fundedAnchor) return null

  const post = personDeals.filter(d => d.pipeline_group !== 'Funded' && d.created_at > fundedAnchor)
  if (post.length === 0) return null

  // Prefer an active deal as the headline; newest first within each bucket.
  const byRecency = [...post].sort((a, b) => b.created_at.localeCompare(a.created_at))
  const headline = byRecency.find(d => ACTIVE_GROUPS.has(d.pipeline_group ?? '')) ?? byRecency[0]

  const borrowerId = personDeals.find(d => d.borrower_id)?.borrower_id
  if (!borrowerId) return null

  const fundedDates = funded.map(d => d.funded_date).filter(Boolean).sort() as string[]
  const nameSource = [...personDeals].sort((a, b) => b.created_at.localeCompare(a.created_at))

  return {
    borrowerId,
    name: nameSource.map(d => d.name).find(Boolean) ?? null,
    fundedCount: funded.length,
    totalFundedVolume: funded.reduce((s, d) => s + (d.loan_amount ?? 0), 0),
    lastFundedAt: fundedDates[fundedDates.length - 1] ?? null,
    newDeal: {
      id: headline.id,
      created_at: headline.created_at,
      pipeline_group: headline.pipeline_group ?? null,
      status: headline.status ?? null,
      source: headline.source ?? null,
      loan_amount: headline.loan_amount ?? null,
    },
    active: post.some(d => ACTIVE_GROUPS.has(d.pipeline_group ?? '')),
    taggedReturn: post.some(d => RETURN_TAG_RE.test(d.source ?? '')),
    rePaidSpend: post.reduce((s, d) => s + (d.lead_price ?? 0), 0),
  }
}

/** Scan the whole book. Active people first, then by the new deal's recency. */
export function findReturningClients(deals: RepeatDeal[]): ReturningClient[] {
  const byPerson = new Map<string, RepeatDeal[]>()
  for (const d of deals) {
    if (!d.borrower_id) continue
    const arr = byPerson.get(d.borrower_id)
    if (arr) arr.push(d)
    else byPerson.set(d.borrower_id, [d])
  }
  const out: ReturningClient[] = []
  for (const [, personDeals] of byPerson) {
    const r = classifyReturning(personDeals)
    if (r) out.push(r)
  }
  return out.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1
    return b.newDeal.created_at.localeCompare(a.newDeal.created_at)
  })
}
