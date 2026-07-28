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
import { parseSourcePins, applySourcePin } from '../lib/sourcePins'

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

// Generic precedence only — the FIRST real candidate wins, whatever it is.
// Which field occupies which slot is the sync's business, pinned in section 3.
eq('first real candidate wins over later real ones',
  resolveLeadSource('Lendgo', 'Arive', 'FRU'), 'Lendgo')

eq('every candidate rejected → null (caller keeps existing value / defaults)',
  resolveLeadSource('Arive', 'Unknown', null, ''), null)

eq('no candidates → null', resolveLeadSource(), null)

// ── 3. The sync's candidate ORDER (2026-07-28: opportunity first) ────────────
// Mirrors app/api/sync/ghl/route.ts. resolveLeadSource is generic, so this is
// where the ORDER itself is pinned — change the route, change these.
const syncChain = (
  oppSource: string | null,
  contactLeadSourceCF: string | null,
  contactSource: string | null,
  embeddedContactSource: string | null = null,
) => resolveLeadSource(oppSource, contactLeadSourceCF, contactSource, embeddedContactSource)

// THE POLICY (Efrain): an opportunity is one purchased lead and one spend event,
// so credit the vendor on the OPPORTUNITY. A person resold by two aggregators
// keeps only the last-written contact "Lead Source", which mis-credited 7 of
// Moe's Lending Tree leads that were really bought from FRU / LeadPoint / LMB.
eq('opportunity vendor beats the contact custom field',
  syncChain('FRU', 'Lending Tree', 'Lending Tree'), 'FRU')
eq('opportunity vendor beats the contact native source',
  syncChain('LeadPoint', null, 'Lending Tree'), 'LeadPoint')

// What makes that order safe: Arive stamps the LOS name onto the OPPORTUNITY too
// (185 of 200 rows in the 7/28 audit), and a rejected candidate must fall through
// rather than win the chain and be nulled afterward.
eq('opp "Arive" falls through to the contact custom field',
  syncChain('Arive', 'Lendgo', 'Arive'), 'Lendgo')
eq('opp blank falls through to the contact custom field',
  syncChain(null, 'OwnUp', 'Advertisements'), 'OwnUp')
eq('opp and CF both unusable → contact native source',
  syncChain('Arive', null, 'Advertisements'), 'Advertisements')
eq('only the embedded contact has a vendor',
  syncChain('Arive', null, null, 'LMB'), 'LMB')
eq('nothing usable anywhere → null (caller keeps existing value)',
  syncChain('Arive', 'Unknown', null, ''), null)

// ── 4. Manual source pins ────────────────────────────────────────────────────
// A pin is the one thing that overrules GHL. It exists because the sync rewrites
// `source` on every pass, so a human correction cannot otherwise survive: two
// leads Efrain PAID for had their opportunity re-created off a later touchpoint,
// leaving no GHL field naming the aggregator that billed him.
const PINS = parseSourcePins([
  { opportunity_id: 'oppA', source: 'Lendgo', reason: 'billed by Lendgo' },
  { opportunity_id: 'oppB', source: 'LMB' },
])

eq('pin overrules the opportunity vendor',
  applySourcePin(PINS, 'oppA', 'Discovery Call'), 'Lendgo')
eq('pin applies even when resolution found nothing',
  applySourcePin(PINS, 'oppB', null), 'LMB')
eq('unpinned opportunity keeps the resolved vendor',
  applySourcePin(PINS, 'oppC', 'FRU'), 'FRU')
eq('unpinned + unresolved stays null',
  applySourcePin(PINS, 'oppC', null), null)
eq('missing opportunity id → resolved value, no throw',
  applySourcePin(PINS, null, 'FRU'), 'FRU')
eq('blank opportunity id → resolved value',
  applySourcePin(PINS, '   ', 'FRU'), 'FRU')
eq('no pins configured → always the resolved value',
  applySourcePin(new Map(), 'oppA', 'Discovery Call'), 'Discovery Call')

// A malformed pins row must never take the sync down — it just applies no pins.
eq('junk pin payload → empty map',        parseSourcePins('not-an-array').size, 0)
eq('null payload → empty map',            parseSourcePins(null).size, 0)
eq('pin without a source is dropped',     parseSourcePins([{ opportunity_id: 'x' }]).size, 0)
eq('pin without an opportunity is dropped', parseSourcePins([{ source: 'LMB' }]).size, 0)
eq('valid pins survive alongside junk',
  parseSourcePins([null, 'x', { opportunity_id: 'ok', source: 'FRU' }]).get('ok'), 'FRU')

console.log(`\n${fail === 0 ? '✅' : '❌'} lead-source-check: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
