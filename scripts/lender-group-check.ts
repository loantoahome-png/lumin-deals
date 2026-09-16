// Fixture check for lib/lenderGroup.ts — pure, no DB.
// Run: npx tsx scripts/lender-group-check.ts
//
// Every raw string below is a REAL `deals.investor` value, pulled live
// 2026-09-16 (all 60 distinct values across every deal). The By-Lender view on
// /deals groups on lenderKey(), so a regression here silently splits one lender
// into four columns — or worse, merges two lenders that aren't the same shop.
import { lenderKey, groupDealsByLender, canonicalLenderName, lenderLabel, CANONICAL_NAMES, NO_LENDER_KEY } from '../lib/lenderGroup'
import type { Deal } from '../lib/types'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}

// ── Families that MUST collapse to one key ─────────────────────────────────
const FAMILIES: Record<string, string[]> = {
  rocket: ['ROCKET', 'Rocket', 'Rocket - CORE', 'Rocket Pro TPO'],
  figure: ['Figure', 'FIGURE', 'Figure - CORE', 'Figure Lending', 'Figure Lending LLC'],
  change: ['Change', 'Change Mortgage'],
  'equity prime': ['EPM', 'Equity Prime Mortgage LLC'],
  homexpress: ['HomeXpress', 'HOMEXPRESS', 'HomeXpress Mortgage'],
  kind: ['Kind - CORE', 'KIND LENDING, LLC', 'KINDLENDING'],
  newrez: ['NEWREZ', 'NewRez - CORE', 'NEWREZ LLC'],
  pennymac: ['PennyMac', 'PENNYMAC', 'PennyMac TPO'],
  forward: ['Forward Lending', 'FORWARDLENDING'],
  'val chris': ['VAL CHRIS INVESTMENTS', 'ValChris'],
  'loan store': ['The Loan Store - CORE', 'The Loan Store, Inc.', 'TLS'],
  mega: ['MEGA', 'Mega Capital Funding, Inc'],
  nfty: ['NFTY (LeadBank)', 'NFTYDOOR - CORE'],
}
for (const [key, raws] of Object.entries(FAMILIES)) {
  eq(`family "${key}" — ${raws.length} spellings collapse`, raws.map(lenderKey), raws.map(() => key))
}

// ── Singles: key is stable and doesn't get stripped to mush ────────────────
const SINGLES: [string, string][] = [
  ['Splitero', 'splitero'],
  ['SPMC', 'spmc'],
  ['Spring EQ', 'spring eq'],
  ['Point', 'point'],
  ['Aven Financial, Inc', 'aven'],
  ['Fly Homes', 'fly homes'],
  ['Cake Mortgage', 'cake'],
  ['Button Finance', 'button'],
  ['Symmetry Lending', 'symmetry'],
  ['Lumen Lending', 'lumen'],
  ['American Heritage Lending', 'american heritage'],
  ['Amwest Funding Corporation', 'amwest'],
  ['Carrington Mortgage Services, LLC', 'carrington'],
  ['Deephaven Mortgage, LLC', 'deephaven'],
  ['Flagstar Bank, National Association', 'flagstar bank'],
  ['Longbridge Financial, LLC', 'longbridge'],
  ['Fidelity Solutions Private Money', 'fidelity solutions private money'],
  ['SWMC - CORE', 'swmc'],
  ['FREEDOM', 'freedom'],
  ['OAKTREE', 'oaktree'],
  ['REMN', 'remn'],
  ['FUND', 'fund'],
]
for (const [raw, key] of SINGLES) eq(`single ${JSON.stringify(raw)}`, lenderKey(raw), key)

// ── Must NOT merge — forward vs reverse are different divisions ─────────────
eq('Finance of America forward ≠ reverse', [
  lenderKey('Finance of America Mortgage'),
  lenderKey('Finance of America Reverse'),
], ['finance of america', 'finance of america reverse'])

// ── Blank / missing lender ─────────────────────────────────────────────────
eq('blank lender values', [lenderKey(null), lenderKey(''), lenderKey('   ')], [NO_LENDER_KEY, NO_LENDER_KEY, NO_LENDER_KEY])

// A name made only of noise words must not strip to nothing.
eq('all-noise name survives', lenderKey('Mortgage'), 'mortgage')

// ── Grouping: label, volume sort, blanks last ──────────────────────────────
const deal = (investor: string | null, loan_amount: number): Deal =>
  ({ id: `${investor}-${loan_amount}`, investor, loan_amount } as unknown as Deal)

const groups = groupDealsByLender([
  deal('Figure Lending', 100_000),
  deal('FIGURE', 50_000),
  deal(null, 900_000),          // biggest volume, but must still sort LAST
  deal('Change Mortgage', 400_000),
  deal('Change', 300_000),
  deal('Splitero', 200_000),
])
eq('group order — volume desc, blanks last', groups.map(g => g.key), ['change', 'splitero', 'figure', NO_LENDER_KEY])
eq('group volumes', groups.map(g => g.volume), [700_000, 200_000, 150_000, 900_000])
eq('curated label wins', groups.find(g => g.key === 'figure')?.label, 'Figure Lending')
eq('variants listed, most common first', groups.find(g => g.key === 'change')?.variants, ['Change Mortgage', 'Change'])
eq('blank group label', groups[3].label, 'No lender on file')

// Uncurated key falls back to the most common raw spelling, preferring mixed case.
const fallback = groupDealsByLender([deal('ACME CAPITAL', 1), deal('Acme Capital', 1)])
eq('fallback label prefers mixed case on a tie', fallback[0].label, 'Acme Capital')

// ── canonicalLenderName() — what gets WRITTEN back to deals.investor ───────
// Exact-match only. A write path must never rename something it merely guessed.
const RENAMES: [string, string][] = [
  ['ROCKET', 'Rocket'],
  ['FREEDOM', 'Freedom'],
  ['OAKTREE', 'Oaktree'],
  ['PENNYMAC', 'PennyMac'],
  ['NEWREZ', 'NewRez'],
  ['NEWREZ LLC', 'NewRez'],
  ['Figure', 'Figure Lending'],
  ['FIGURE', 'Figure Lending'],
  ['Figure Lending LLC', 'Figure Lending'],
  ['Change', 'Change Mortgage'],
  ['HomeXpress', 'HomeXpress Mortgage'],
  ['HOMEXPRESS', 'HomeXpress Mortgage'],
  ['EPM', 'Equity Prime Mortgage'],
  ['Equity Prime Mortgage LLC', 'Equity Prime Mortgage'],
  ['KINDLENDING', 'Kind Lending'],
  ['KIND LENDING, LLC', 'Kind Lending'],
  ['FORWARDLENDING', 'Forward Lending'],
  ['TLS', 'The Loan Store'],
  ['The Loan Store, Inc.', 'The Loan Store'],
  ['MEGA', 'Mega Capital Funding'],
  ['Mega Capital Funding, Inc', 'Mega Capital Funding'],
  ['ValChris', 'Val Chris Investments'],
  ['VAL CHRIS INVESTMENTS', 'Val Chris Investments'],
  ['Aven Financial, Inc', 'Aven Financial'],
  ['Carrington Mortgage Services, LLC', 'Carrington Mortgage Services'],
  ['Deephaven Mortgage, LLC', 'Deephaven Mortgage'],
  ['Longbridge Financial, LLC', 'Longbridge Financial'],
  ['Amwest Funding Corporation', 'Amwest Funding'],
  ['Flagstar Bank, National Association', 'Flagstar Bank'],
]
for (const [raw, want] of RENAMES) eq(`canonical ${JSON.stringify(raw)}`, canonicalLenderName(raw), want)

// ⚠️ Randy's CORE / TPO values must survive the cleanup EXACTLY as they are —
// Efrain's call 2026-09-16, pending someone saying what CORE means.
const UNTOUCHED = [
  'Rocket - CORE', 'Figure - CORE', 'Kind - CORE', 'NewRez - CORE', 'SWMC - CORE',
  'The Loan Store - CORE', 'NFTYDOOR - CORE', 'Rocket Pro TPO', 'PennyMac TPO',
]
for (const raw of UNTOUCHED) eq(`untouched ${JSON.stringify(raw)}`, canonicalLenderName(raw), raw)

// Unknown lenders pass through unchanged (only whitespace is tidied).
eq('unknown lender passes through', canonicalLenderName('Some New Lender, LLC'), 'Some New Lender, LLC')
eq('whitespace tidied', canonicalLenderName('  Spring   EQ  '), 'Spring EQ')
eq('blank → null', [canonicalLenderName(null), canonicalLenderName('   ')], [null, null])
eq('canonical names are idempotent', RENAMES.map(([, want]) => canonicalLenderName(want)), RENAMES.map(([, want]) => want))

// ── The two maps must agree ────────────────────────────────────────────────
// A section's heading is the display label; the cards under it are stored under
// the canonical name. If those differ, every merged section reads "also filed as
// <its own name>" — which is how this was caught after the 2026-09-16 cleanup.
const disagreements = Object.values(CANONICAL_NAMES)
  .filter((stored, i, arr) => arr.indexOf(stored) === i)
  .map(stored => ({ stored, label: lenderLabel(lenderKey(stored), new Map([[stored, 1]])) }))
  .filter(({ stored, label }) => stored !== label)
eq('every canonical name equals its display label', disagreements, [])

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
