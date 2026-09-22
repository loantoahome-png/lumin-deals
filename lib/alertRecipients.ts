// Who receives LO-addressed alert emails.
//
// MOE AND MATT ONLY (Efrain, 2026-09-22). Randy and Daniel were receiving rate-lock
// alerts and do not want them.
//
// ⚠️ This is an ALLOWLIST, and it must stay one. LO names are NOT stable across
// systems — Daniel is "Danny Granger" in GHL but "Daniel McGrail-Granger" in Arive
// (see the reporting-role note) — and `deals.loan_officer` is whatever the sync
// resolved. A denylist would silently resume emailing an excluded LO the moment a
// name changed, and would mail every LO added in future by default. An allowlist
// fails closed: the worst case is a missed alert, visible in the run summary as
// `skipped_not_alert_lo`, rather than an unwanted email nobody asked for.
//
// ONE table drives BOTH eligibility and address, so they can never disagree: an LO
// who matches here but has no env var set surfaces as `missing_lo_email`, which is a
// real config gap, as distinct from a deliberate exclusion.
//
// It lives in lib/ so the cron and scripts/lock-alert-preview.ts share one definition.
// The preview used to re-declare the cron's rules and drifted from them; a preview
// that can disagree with the job it previews is worse than no preview.
export const ALERT_LOS: Array<{ match: (lo: string) => boolean; envVar: string }> = [
  { match: lo => lo.includes('matt') || lo.includes('park'),   envVar: 'LO_EMAIL_MATT' },
  { match: lo => lo.includes('moe')  || lo.includes('sefati'), envVar: 'LO_EMAIL_MOE'  },
]

/** Does this LO receive alert emails at all? */
export function isAlertLo(loanOfficer: string | null | undefined): boolean {
  const lo = (loanOfficer ?? '').trim().toLowerCase()
  return lo.length > 0 && ALERT_LOS.some(e => e.match(lo))
}

/** The LO's alert address, or null when they are off the list or have no env var. */
export function alertLoEmail(loanOfficer: string | null | undefined): string | null {
  const lo = (loanOfficer ?? '').trim().toLowerCase()
  if (!lo) return null
  const hit = ALERT_LOS.find(e => e.match(lo))
  return hit ? (process.env[hit.envVar] || null) : null
}
