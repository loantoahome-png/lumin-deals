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
  // 'Lumen Lending' is a misspelling of the house name (Efrain, 2026-09-16).
  lumen: 'lumin',
}

/**
 * Display name per key. Anything missing here falls back to the most common raw
 * spelling in the data being grouped, so a brand-new lender still reads right.
 *
 * ⚠️ INVARIANT: where a lender also appears in CANONICAL_NAMES below, the label
 * here must MATCH the stored canonical name — otherwise every card in that
 * section reads "also filed as <the name it is actually stored under>".
 * scripts/lender-group-check.ts enforces this.
 */
const LENDER_LABELS: Record<string, string> = {
  rocket: 'Rocket',
  figure: 'Figure Lending',
  'equity prime': 'Equity Prime Mortgage',
  kind: 'Kind Lending',
  forward: 'Forward Lending',
  'val chris': 'Val Chris Investments',
  'loan store': 'The Loan Store',
  nfty: 'NFTY (LeadBank)',
  'fly homes': 'Fly Homes',
  homexpress: 'HomeXpress Mortgage',
  pennymac: 'PennyMac',
  newrez: 'NewRez',
  change: 'Change Mortgage',
  mega: 'Mega Capital Funding',
  carrington: 'Carrington Mortgage Services',
  aven: 'Aven Financial',
  longbridge: 'Longbridge Financial',
  amwest: 'Amwest Funding',
  deephaven: 'Deephaven Mortgage',
  flagstar: 'Flagstar Bank',
  swmc: 'SWMC',
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
  lumin: 'Lumin Lending',
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

// ── Canonical STORED name ───────────────────────────────────────────────────
/**
 * The one spelling a known lender is written as — used both by the one-time
 * cleanup (scripts/lender-name-cleanup.ts) and by every import path, so the
 * table doesn't re-drift the next time Arive or GHL hands us a "ROCKET".
 *
 * ⚠️ This is EXACT-MATCH on the trimmed value, case-insensitive — NOT the fuzzy
 * `lenderKey()` normalizer above. A write path must never rename something it
 * merely guessed at, so anything not listed here is stored exactly as it
 * arrived. `lenderKey()` can afford to be clever because it only affects how
 * cards are stacked on a screen; this map changes the data.
 *
 * ⚠️ DELIBERATELY ABSENT — Randy's ' - CORE' and ' Pro TPO' values ('Rocket -
 * CORE', 'Figure - CORE', 'Kind - CORE', 'NewRez - CORE', 'SWMC - CORE',
 * 'The Loan Store - CORE', 'NFTYDOOR - CORE', 'Rocket Pro TPO', 'PennyMac TPO').
 * Checked live 2026-09-16: all 71 of them are in Randy's GHL sub-account
 * (arZ4QDCzS0Vkj0ZvLZdv), all created 2026-07, none carries an Arive file, and
 * `broker_corr` is null on every one — so the suffix is his own labelling, not
 * the Broker/Non-Del channel. Efrain's call (2026-09-16): leave them alone until
 * someone says what CORE means. They still merge into one section on screen via
 * lenderKey(); only the stored value is left untouched.
 *
 * Also deliberately absent: 'REMN', 'SPMC', 'FUND', 'TLS'-style acronyms with no
 * confirmed expansion beyond the explicit pairs below.
 */
export const CANONICAL_NAMES: Record<string, string> = {
  // Shouting / casing only
  'rocket': 'Rocket',
  'freedom': 'Freedom',
  'oaktree': 'Oaktree',
  'pennymac': 'PennyMac',
  'newrez': 'NewRez',
  'newrez llc': 'NewRez',
  // Legal suffix dropped
  'figure lending llc': 'Figure Lending',
  'aven financial, inc': 'Aven Financial',
  'carrington mortgage services, llc': 'Carrington Mortgage Services',
  'deephaven mortgage, llc': 'Deephaven Mortgage',
  'longbridge financial, llc': 'Longbridge Financial',
  'amwest funding corporation': 'Amwest Funding',
  'flagstar bank, national association': 'Flagstar Bank',
  'mega capital funding, inc': 'Mega Capital Funding',
  'the loan store, inc.': 'The Loan Store',
  'equity prime mortgage llc': 'Equity Prime Mortgage',
  'kind lending, llc': 'Kind Lending',
  // Bare / partial names folded into the full one
  'figure': 'Figure Lending',
  'change': 'Change Mortgage',
  'homexpress': 'HomeXpress Mortgage',
  // Smash-ups and abbreviations
  'kindlending': 'Kind Lending',
  'forwardlending': 'Forward Lending',
  'epm': 'Equity Prime Mortgage',
  'tls': 'The Loan Store',
  'mega': 'Mega Capital Funding',
  'valchris': 'Val Chris Investments',
  'val chris investments': 'Val Chris Investments',
  // Typo of the house name, confirmed by Efrain 2026-09-16.
  'lumen lending': 'Lumin Lending',
}

/**
 * The spelling to STORE for a raw lender value. Known lender → its canonical
 * name; anything else → the raw value, trimmed, unchanged. Null/blank stays null.
 */
export function canonicalLenderName(raw: string | null | undefined): string | null {
  const trimmed = String(raw ?? '').trim().replace(/\s+/g, ' ')
  if (!trimmed) return null
  return CANONICAL_NAMES[trimmed.toLowerCase()] ?? trimmed
}
