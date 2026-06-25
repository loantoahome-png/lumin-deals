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
