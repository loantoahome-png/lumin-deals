// Fixture check for lead-source resolution (2026-07-28).
//
// Run: npx tsx scripts/lead-source-check.ts
//
// Guards the bug that re-stamped the LOS name "Arive" onto 199 deals: the 15-min
// sync declared its OWN cleanSource() that rejected only junk values, never
// "Arive". The call site read `cleanSource(...)` either way, so the missing guard
// was invisible while the sync overwrote real vendors on every pass.
//
// Two properties are locked here:
//   1. ONE canonical cleanSource — "Arive" out, junk out, real vendors through.
//   2. Candidates are cleaned INDIVIDUALLY. Coalescing first (`a ?? b`) and
//      cleaning the winner lets a present-but-rejected "Arive" shadow a real
//      vendor further down the chain — Garry Swatzel's FRU sat on the opportunity
//      the whole time, hidden behind the contact's "Arive".
// See docs/diagnoses/2026-07-28-arive-source-restamp-diagnosis.md
import { cleanSource, resolveLeadSource } from '../lib/utils'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++; console.log(`✓ ${label}`) }
  else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}

// ── 1. cleanSource: the canonical filter ──────────────────────────────────────

eq('real vendor passes through',            cleanSource('FRU'), 'FRU')
eq('vendor with spacing is trimmed',        cleanSource('  LMB  '), 'LMB')
eq('THE REGRESSION: "Arive" rejected',      cleanSource('Arive'), null)
eq('"arive" case-insensitive',              cleanSource('arive'), null)
eq('"ARIVE" case-insensitive',              cleanSource('ARIVE'), null)
eq('"Arive" with spacing rejected',         cleanSource(' Arive '), null)
eq('"Unknown" bucket rejected',             cleanSource('Unknown'), null)
eq('junk reconciliation value rejected',    cleanSource('loan-audit-reconciliation:9f2c-aa10'), null)
eq('junk is case-insensitive',              cleanSource('LOAN-AUDIT-RECONCILIATION:x'), null)
eq('empty → null',                          cleanSource(''), null)
eq('whitespace → null',                     cleanSource('   '), null)
eq('null → null',                           cleanSource(null), null)
eq('undefined → null',                      cleanSource(undefined), null)

// A vendor whose name merely CONTAINS a filtered word must survive — the filters
// are exact-match (or anchored), not substring.
eq('vendor containing "arive" survives',    cleanSource('Arivemark Media'), 'Arivemark Media')

// ── 2. resolveLeadSource: clean each candidate, first real one wins ───────────

eq('first candidate wins when real',
  resolveLeadSource('LMB', 'FRU'), 'LMB')

// THE REGRESSION, exactly as it hit Garry Swatzel (Arive #17063141): the contact
// carries the LOS name, the opportunity carries the real vendor. Pre-fix the
// `??` chain picked "Arive" (truthy), cleaned it to null, and the sync wrote
// nothing — leaving the stale "Arive" frozen on the deal.
eq('THE REGRESSION: "Arive" falls through to the real vendor behind it',
  resolveLeadSource(null, 'Arive', 'FRU'), 'FRU')

eq('junk also falls through to the vendor behind it',
  resolveLeadSource('loan-audit-reconciliation:abc', 'OwnUp'), 'OwnUp')

eq('custom field beats contact + opportunity',
  resolveLeadSource('Lendgo', 'Arive', 'FRU'), 'Lendgo')

eq('every candidate rejected → null (caller keeps existing value / defaults)',
  resolveLeadSource('Arive', 'Unknown', null, ''), null)

eq('no candidates → null', resolveLeadSource(), null)

// Mirrors the sync's real call shape: CF → contact → opp → embedded contact.
eq('sync chain: only the embedded contact has a vendor',
  resolveLeadSource(null, 'Arive', null, 'LMB'), 'LMB')

console.log(`\n${fail === 0 ? '✅' : '❌'} lead-source-check: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
