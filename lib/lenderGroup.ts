/**
 * Lender grouping — canonical lender identity for `deals.investor`.
 *
 * WHY THIS EXISTS
 * `deals.investor` is free text that arrives from two mouths (the Arive CSV
 * import and GHL), so the same lender shows up under several spellings. Audited
 * live 2026-09-16 across every deal: 60 distinct values, and the four biggest
 * lenders are each split 3-5 ways —
 *   Rocket   → 'ROCKET' (125) · 'Rocket' (26) · 'Rocket Pro TPO' (23) · 'Rocket - CORE' (14)
 *   Figure   → 'Figure Lending' (78) · 'Figure' (43) · 'Figure - CORE' (27) · 'Figure Lending LLC' (17) · 'FIGURE' (4)
 *   PennyMac → 'PENNYMAC' (6) · 'PennyMac TPO' (3) · 'PennyMac' (1)
 *   EPM      → 'Equity Prime Mortgage LLC' (9) · 'EPM' (6)
 * Grouping on the raw string would print one lender as four groups, so the
 * By-Lender view groups on a normalized KEY instead.
 *
 * ⚠️ This NEVER writes. The stored `investor` value is left exactly as it is —
 * this is a display-time grouping only. Cleaning the source data is a separate
 * (and still open) job.
 *
 * HOW A KEY IS BUILT
 *   1. lowercase, punctuation → spaces, collapse whitespace
 *   2. drop a leading "the"
 *   3. repeatedly drop trailing noise words (llc, inc, mortgage, lending,
 *      financial, funding, capital, tpo, core, …) — never down to nothing
 *   4. look the result up in ALIAS_KEYS for the cases step 3 cannot reach
 *      (single-token smash-ups like 'KINDLENDING', and abbreviations like
 *      'TLS' or 'EPM')
 *
 * Step 3 is what merges 'Change' with 'Change Mortgage' and 'Figure' with
 * 'Figure Lending LLC'. It is deliberately aggressive about corporate/channel
 * suffixes and blind to everything else, so two genuinely different lenders
 * whose names differ ONLY by a suffix word (a hypothetical 'Point' vs 'Point
 * Mortgage') would collide. None do today; add an alias if one ever does.
 *
 * DELIBERATELY NOT MERGED: 'Finance of America Mortgage' and 'Finance of
 * America Reverse' — forward and reverse are different divisions with different
 * products, and lumping them would hide which one a loan is with.
 */

import type { Deal } from './types'

/** Trailing words that carry no identity — corporate form, channel, or generic. */
const NOISE = new Set([
  'llc', 'llp', 'lp', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'ltd',
  'plc', 'na', 'national', 'association',
  'tpo', 'core', 'corr', 'pro', 'wholesale',
  'mortgage', 'mtg', 'lending', 'loans', 'financial', 'finance', 'funding',
  'capital', 'services', 'group', 'holdings',
])

/**
 * Raw → canonical key, for pairs the suffix-stripper can't join on its own:
 * a name smashed into one token, or an abbreviation.
 */
const ALIAS_KEYS: Record<string, string> = {
  epm: 'equity prime',
  kindlending: 'kind',
  forwardlending: 'forward',
  valchris: 'val chris',
  'val chris investments': 'val chris',
  tls: 'loan store',
  nftydoor: 'nfty',
  'nfty leadbank': 'nfty',
  flyhomes: 'fly homes',
}

/**
 * Display name per key. Anything missing here falls back to the most common raw
 * spelling in the data being grouped, so a brand-new lender still reads right.
 */
const LENDER_LABELS: Record<string, string> = {
  rocket: 'Rocket',
  figure: 'Figure Lending',
  'equity prime': 'Equity Prime Mortgage (EPM)',
  kind: 'Kind Lending',
  forward: 'Forward Lending',
  'val chris': 'Val Chris Investments',
  'loan store': 'The Loan Store',
  nfty: 'NFTY Door (LeadBank)',
  'fly homes': 'Fly Homes',
  homexpress: 'HomeXpress Mortgage',
  pennymac: 'PennyMac',
  newrez: 'NewRez',
  change: 'Change Mortgage',
  mega: 'Mega Capital Funding',
  carrington: 'Carrington Mortgage Services',
  aven: 'Aven',
  longbridge: 'Longbridge Financial',
  amwest: 'Amwest Funding',
  deephaven: 'Deephaven Mortgage',
  flagstar: 'Flagstar Bank',
  swmc: 'SWMC (Sun West)',
  spmc: 'SPMC',
  'spring eq': 'Spring EQ',
  splitero: 'Splitero',
  point: 'Point',
  remn: 'REMN',
  freedom: 'Freedom',
  oaktree: 'Oaktree',
  cake: 'Cake Mortgage',
  button: 'Button Finance',
  symmetry: 'Symmetry Lending',
  lumen: 'Lumen Lending',
  'american heritage': 'American Heritage Lending',
}

/** Sentinel key for deals with no lender on file. Always sorts last. */
export const NO_LENDER_KEY = '__none__'
export const NO_LENDER_LABEL = 'No lender on file'

/** Canonical grouping key for one raw `investor` value. '' → NO_LENDER_KEY. */
export function lenderKey(raw: string | null | undefined): string {
  const cleaned = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
  if (!cleaned) return NO_LENDER_KEY

  let words = cleaned.split(' ')
  if (words.length > 1 && words[0] === 'the') words = words.slice(1)
  while (words.length > 1 && NOISE.has(words[words.length - 1])) words.pop()

  const key = words.join(' ')
  return ALIAS_KEYS[key] ?? key
}

/**
 * Display name for a key, given the raw spellings that landed in it. Prefers the
 * curated label; otherwise the most common raw value, breaking ties toward the
 * one that isn't shouting in all-caps (so 'HomeXpress' wins over 'HOMEXPRESS').
 */
export function lenderLabel(key: string, rawCounts: Map<string, number>): string {
  if (key === NO_LENDER_KEY) return NO_LENDER_LABEL
  const curated = LENDER_LABELS[key]
  if (curated) return curated
  let best = ''
  let bestCount = -1
  for (const [raw, count] of rawCounts) {
    if (count > bestCount) { best = raw; bestCount = count; continue }
    if (count === bestCount && best === best.toUpperCase() && raw !== raw.toUpperCase()) best = raw
  }
  return best || key
}

export type LenderGroup = {
  key: string
  label: string
  deals: Deal[]
  /** Sum of loan_amount across the group. */
  volume: number
  /** Every raw `investor` spelling that folded into this group, most common first. */
  variants: string[]
}

/**
 * Group deals by canonical lender, biggest loan volume first, "No lender on
 * file" pinned last. Deal order inside a group is whatever order came in (the
 * board hands over an already-sorted list).
 */
export function groupDealsByLender(deals: Deal[]): LenderGroup[] {
  const buckets = new Map<string, { deals: Deal[]; volume: number; raws: Map<string, number> }>()
  for (const d of deals) {
    const key = lenderKey(d.investor)
    let b = buckets.get(key)
    if (!b) { b = { deals: [], volume: 0, raws: new Map() }; buckets.set(key, b) }
    b.deals.push(d)
    b.volume += d.loan_amount || 0
    const raw = String(d.investor ?? '').trim()
    if (raw) b.raws.set(raw, (b.raws.get(raw) ?? 0) + 1)
  }

  const groups: LenderGroup[] = []
  for (const [key, b] of buckets) {
    groups.push({
      key,
      label: lenderLabel(key, b.raws),
      deals: b.deals,
      volume: b.volume,
      variants: [...b.raws].sort((a, z) => z[1] - a[1]).map(([raw]) => raw),
    })
  }

  groups.sort((a, z) => {
    if (a.key === NO_LENDER_KEY) return 1
    if (z.key === NO_LENDER_KEY) return -1
    if (z.volume !== a.volume) return z.volume - a.volume
    return z.deals.length - a.deals.length || a.label.localeCompare(z.label)
  })
  return groups
}
