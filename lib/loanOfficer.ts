// Canonical loan-officer normalization — the SINGLE source of truth, used by the GHL
// sync, the GHL webhook, and the Arive importer, so no surface can drift the value.
//
// The dashboard's LO dropdowns build their <option>s from LOAN_OFFICERS (lib/types.ts)
// = ['Matt Park', 'Moe Sefati'], so loan_officer MUST normalize to those exact strings
// or the <select> renders blank — the bug that hid "Matt Park" data behind a "Matt"
// option. Unknown names pass through unchanged so we never lose a real assignment.
const LO_MAP: Record<string, string> = {
  // Moe variants
  'moe sefati': 'Moe Sefati', 'sefati': 'Moe Sefati', 'moe': 'Moe Sefati',
  // Matt variants
  'matthew park': 'Matt Park', 'matthew': 'Matt Park', 'matt park': 'Matt Park',
  'matt': 'Matt Park', 'park': 'Matt Park',
  // Randy variants
  'randy mathis': 'Randy Mathis', 'randy': 'Randy Mathis', 'mathis': 'Randy Mathis',
  // Daniel variants. The surname is hyphenated and gets typed a dozen ways, so
  // match on either half independently as well as the first name. Checked
  // against every key above: none of them is a substring of
  // "daniel mcgrail-granger", so adding these can't steal another LO's leads.
  // ⚠️ He is spelled DIFFERENTLY in the two systems: Arive says
  // "Daniel McGrail-Granger" (the canonical board name), GHL says "Danny
  // Granger". Both resolve here via 'granger'. 'danny' is listed separately so a
  // bare first name still lands. Bare 'dan' is deliberately NOT a key — it is a
  // substring of Jordan/Brandan/Daniela and would hijack a real name.
  //
  // ⚠️ KNOWN false positive: 'daniel' also matches "Daniela" / "Danielle",
  // because matching is plain `includes`, not a word boundary. Accepted: this
  // field only ever holds LOAN OFFICER names and there is no Daniela/Danielle
  // on the team. If one is ever hired, drop the bare 'daniel' key — 'granger',
  // 'mcgrail' and 'danny' already cover every spelling seen in GHL and Arive.
  'daniel mcgrail-granger': 'Daniel McGrail-Granger',
  'mcgrail': 'Daniel McGrail-Granger', 'granger': 'Daniel McGrail-Granger',
  'daniel': 'Daniel McGrail-Granger', 'danny': 'Daniel McGrail-Granger',
}

export function resolveLO(name: string | null | undefined): string | null {
  if (!name) return null
  const trimmed = name.trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()
  for (const [key, value] of Object.entries(LO_MAP)) {
    if (lower.includes(key)) return value
  }
  // No match — return the raw name so we don't lose the assignment
  return trimmed
}

// The default working set for the daily views AND the Hot Leads / triage /
// follow-up workflow: Moe + Matt only. Randy AND Daniel each run their own GHL
// sub-account with its own follow-up, so their leads are opt-in for VIEWING
// (their LoFilter pills) but are NEVER put on the triage clock or auto-tasked. (Efrain 2026-07-14: "default
// views = only Moe and Matt"; reaffirmed 2026-07-20: "hot leads / triage /
// follow-ups is only for Moe and Matt.") Server-safe so the triage cron can gate
// on the exact same rule the UI filters by. LoFilter re-exports this.
export const DEFAULT_LOS: string[] = ['Matt Park', 'Moe Sefati']

// Is this lead owned by an in-scope LO (Moe or Matt)? Randy, Daniel, unknown
// names, and unassigned (null) leads are all out of scope — matching the Hot Leads default
// filter (loSelected against DEFAULT_LOS), so a task is only ever created for a
// lead that also shows up in the default triage queue.
export function inDefaultLoScope(loanOfficer: string | null | undefined): boolean {
  const lo = resolveLO(loanOfficer)
  return lo != null && DEFAULT_LOS.includes(lo)
}
