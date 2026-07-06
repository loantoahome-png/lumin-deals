// Fixture check for lib/ariveCsv.ts matching — pure logic, no DB.
// Run: npx tsc lib/ariveCsv.ts scripts/arive-match-check.ts --outDir /tmp/amc \
//        --module nodenext --moduleResolution nodenext --skipLibCheck && node /tmp/amc/scripts/arive-match-check.js
//
// Regression guard for the 2026-06-29 duplicate-card incident: an Arive import
// created blank SHELL cards for loans that already had cards, because (older)
// name matching missed real-world name variants and the LOS name "Arive" leaked
// into `source`. Both are fixed now — these cases lock that in so it can't regress.
import { buildMatchIndex, matchRow, isRealLeadSource } from '../lib/ariveCsv'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++ } else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}
type M = ReturnType<typeof matchRow>
// Access via `as` (not union-narrowing) so this stays clean even when compiled
// without strictNullChecks, e.g. the bare `tsc` run command documented above.
const viaOf    = (r: M) => ((r as { via?: string }).via ?? '')
const reasonOf = (r: M) => ((r as { reason?: string }).reason ?? '')

// Existing cards as they looked on 6/29 — real card present, but arive_file_no
// NOT yet set, so a match MUST succeed on name alone (the exact failure window).
const ix = buildMatchIndex([
  { id: 'chris', name: 'Christopher Lokers',        email: null, phone: null, arive_file_no: null },
  { id: 'esme',  name: 'Esmeraldo N. Gorecho, III', email: null, phone: null, arive_file_no: null },
  { id: 'gus',   name: 'Gustavo Magana',            email: null, phone: null, arive_file_no: null },
])
const m = (name: string, af?: string) => matchRow({ __borrower_name: name, arive_file_no: af } as never, ix)

// ── Real 6/29 variants that MUST match an existing card (not spawn a shell) ──
eq('middle-name variant matches',      m('Christopher Dustan Lokers', '16245944').matched, true)
eq('  ...via first+last',        viaOf(m('Christopher Dustan Lokers', '16245944')), 'name_firstlast')
eq('suffix+comma+middle matches',      m('Esmeraldo Norman Gorecho III', '16072217').matched, true)
eq('  ...via first+last',        viaOf(m('Esmeraldo Norman Gorecho III', '16072217')), 'name_firstlast')
eq('exact name still matches',   viaOf(m('Gustavo Magana', '16123664')), 'name')

// ── arive_file_no is authoritative once it's set (post-backfill) ──
const ixAf = buildMatchIndex([{ id: 'x', name: 'Someone Else', email: null, phone: null, arive_file_no: '999' }])
eq('arive_file_no beats name', viaOf(matchRow({ __borrower_name: 'Totally Different', arive_file_no: '999' } as never, ixAf)), 'arive_file_no')

// ── A true stranger is no_match (so createUnmatched makes ONE new card, not a dup of an existing person) ──
eq('stranger = no match',        m('Jane Nobody', '444').matched, false)
eq('  ...reason no_match', reasonOf(m('Jane Nobody', '444')), 'no_match')

// ── Ambiguous (2 people share first+last) must NOT be a false match ──
const ixAmb = buildMatchIndex([
  { id: 'a', name: 'John Smith', email: null, phone: null, arive_file_no: null },
  { id: 'b', name: 'John Smith', email: null, phone: null, arive_file_no: null },
])
eq('ambiguous name not matched', matchRow({ __borrower_name: 'John A Smith' } as never, ixAmb).matched, false)

// ── The LOS name must never become a lead source (the shells carried source="Arive") ──
eq('Arive rejected as source',   isRealLeadSource('Arive'), false)
eq('los rejected as source',     isRealLeadSource('LOS'),   false)
eq('real source accepted',       isRealLeadSource('Lending Tree'), true)

console.log(`arive-match-check: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
