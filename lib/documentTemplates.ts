/**
 * Document checklist templates keyed by loan type.
 *
 * getDocumentTemplate() derives a needs-list from a deal's loan type by
 * layering: universal docs → purchase/refi docs → program-specific docs
 * (VA, DSCR/investment, Non-QM, self-employed). The result is a fresh
 * DealDocument[] with every item set to status 'needed'.
 */
import type { DealDocument } from './types'

type DocSeed = { name: string; category: string }

// ── Universal — every residential loan ──────────────────────────────────────
const UNIVERSAL: DocSeed[] = [
  { name: "Driver's License / Photo ID",        category: 'Identity' },
  { name: 'Social Security card',               category: 'Identity' },
  { name: 'Last 2 paystubs',                    category: 'Income' },
  { name: 'Last 2 years W-2s',                  category: 'Income' },
  { name: 'Last 2 months bank statements',      category: 'Assets' },
  { name: 'Homeowners insurance declaration',   category: 'Property' },
  { name: 'Credit authorization (signed)',      category: 'Credit' },
]

// ── Purchase ────────────────────────────────────────────────────────────────
const PURCHASE: DocSeed[] = [
  { name: 'Fully executed purchase contract',   category: 'Property' },
  { name: 'Earnest money deposit proof',        category: 'Assets' },
  { name: 'Gift letter + donor proof (if used)',category: 'Assets' },
  { name: 'Realtor / agent contact info',       category: 'Other' },
]

// ── Refinance ───────────────────────────────────────────────────────────────
const REFI: DocSeed[] = [
  { name: 'Current mortgage statement',         category: 'Property' },
  { name: 'Note / Deed of Trust',               category: 'Property' },
  { name: 'Most recent property tax bill',      category: 'Property' },
  { name: 'Current homeowners insurance policy',category: 'Property' },
]

// ── Streamline / IRRRL — reduced doc set ────────────────────────────────────
const STREAMLINE: DocSeed[] = [
  { name: 'Current mortgage statement',         category: 'Property' },
  { name: 'Mortgage payment history (12 mo)',   category: 'Credit' },
  { name: 'Current homeowners insurance policy',category: 'Property' },
]

// ── VA-specific ─────────────────────────────────────────────────────────────
const VA: DocSeed[] = [
  { name: 'Certificate of Eligibility (COE)',   category: 'Identity' },
  { name: 'DD-214 / Statement of Service',      category: 'Identity' },
]

// ── Self-employed / Non-QM ──────────────────────────────────────────────────
const SELF_EMPLOYED: DocSeed[] = [
  { name: 'Last 2 years personal tax returns',  category: 'Income' },
  { name: 'Last 2 years business tax returns',  category: 'Income' },
  { name: 'YTD profit & loss statement',        category: 'Income' },
  { name: 'Business license / formation docs',  category: 'Income' },
  { name: 'Last 2 months business bank statements', category: 'Assets' },
]

// ── DSCR / Investment ───────────────────────────────────────────────────────
const DSCR: DocSeed[] = [
  { name: 'Lease agreement(s)',                 category: 'Income' },
  { name: 'Rent roll',                          category: 'Income' },
  { name: 'Schedule of Real Estate Owned',      category: 'Property' },
  { name: 'Entity docs (if vesting in LLC)',    category: 'Identity' },
]

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function seedToDoc(seed: DocSeed): DealDocument {
  return {
    id: uid(),
    name: seed.name,
    category: seed.category,
    status: 'needed',
    note: null,
    updated_at: new Date().toISOString(),
  }
}

/**
 * Build a document checklist for a given loan type. Returns a fresh array;
 * de-dupes by name so layered templates don't repeat (e.g. insurance).
 */
export function getDocumentTemplate(loanType: string | null | undefined): DealDocument[] {
  const t = (loanType || '').toLowerCase()

  const seeds: DocSeed[] = [...UNIVERSAL]

  const isStreamline = t.includes('streamline') || t.includes('irrrl')
  const isRefi = t.includes('refi') || t.includes('r/t') || t.includes('c/o') || isStreamline
  const isPurchase = t.includes('purchase')

  if (isStreamline) {
    seeds.push(...STREAMLINE)
  } else if (isRefi) {
    seeds.push(...REFI)
  } else if (isPurchase) {
    seeds.push(...PURCHASE)
  } else {
    // Unknown loan type — assume purchase (most common) so the LO has a starting point
    seeds.push(...PURCHASE)
  }

  if (t.includes('va')) seeds.push(...VA)
  if (t.includes('non-qm') || t.includes('hard money')) seeds.push(...SELF_EMPLOYED)
  if (t.includes('dscr')) seeds.push(...DSCR)

  // De-dupe by name (keep first occurrence)
  const seen = new Set<string>()
  const deduped = seeds.filter(s => {
    const key = s.name.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return deduped.map(seedToDoc)
}

/** A blank custom document the user can fill in. */
export function blankDocument(): DealDocument {
  return {
    id: uid(),
    name: '',
    category: 'Other',
    status: 'needed',
    note: null,
    updated_at: new Date().toISOString(),
  }
}
