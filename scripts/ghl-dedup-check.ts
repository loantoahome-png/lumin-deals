// Fixture check for resolveExistingLoan (lib/dealMatcher) — the GHL-sync dedup match.
// Run: npx tsc lib/dealMatcher.ts scripts/ghl-dedup-check.ts --outDir /tmp/gdc \
//        --module nodenext --moduleResolution nodenext --skipLibCheck && node /tmp/gdc/scripts/ghl-dedup-check.js
//
// Guards the 2026-07 duplicate-card fix: a GHL opportunity deleted + recreated gets a
// NEW id, and the sync must re-point the existing card (matched by Arive loan #) rather
// than insert a twin.
import { resolveExistingLoan } from '../lib/dealMatcher'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++ } else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}

type Card = { id: string }
const byOpp   = new Map<string, Card>([['oppLIVE', { id: 'cardA' }]])
const byArive = new Map<string, Card>([['16113910', { id: 'cardEXISTING' }]])
const idOf = (r: Card | null) => (r ? r.id : null)

// Opportunity id is present → matches by opp (primary key, unchanged behaviour).
eq('match by opportunity id', idOf(resolveExistingLoan('oppLIVE', '16113910', byOpp, byArive)), 'cardA')

// Recreated opp: NEW opp id (not in byOpp) but SAME loan # → falls back to arive#,
// so the existing card is re-pointed instead of a duplicate being inserted.
eq('recreated opp → arive# fallback', idOf(resolveExistingLoan('oppNEW', '16113910', byOpp, byArive)), 'cardEXISTING')

// Genuinely new loan: neither opp nor arive# known → null → caller inserts a new card.
eq('brand-new loan → no match', resolveExistingLoan('oppNEW', '99999999', byOpp, byArive), null)

// No Arive # on the opp and no opp match → null (no fallback possible; prior behaviour).
eq('null arive# → no fallback', resolveExistingLoan('oppNEW', null, byOpp, byArive), null)

// Opportunity id must WIN even if the arive# points at a different card — opp id is
// the authoritative per-loan key; arive# is only the fallback.
const byAriveOther = new Map<string, Card>([['16113910', { id: 'cardOTHER' }]])
eq('opp id wins over arive#', idOf(resolveExistingLoan('oppLIVE', '16113910', byOpp, byAriveOther)), 'cardA')

console.log(`ghl-dedup-check: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
