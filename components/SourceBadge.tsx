'use client'

// ── The leading GHL / FUB badge on a lead row ───────────────────────────────
// One click rule across every queue page (Efrain, 2026-07-31):
//   • the NAME  → the dashboard profile (/deals/<id>)
//   • the BADGE → the system of record the lead came from
// Extracted from the follow-up cockpit so /hot-leads (triage, check-ins, the
// tracker table and the card header) says the same thing the same way — the
// markup was copy-pasted in five places before this.
//
// Renders a non-link span when there's no URL (e.g. a GHL contact id we know
// is bad — see ghlContactUrl's guard) so the row keeps its shape either way.

const TONE = {
  ghl: { base: 'text-blue-700 bg-blue-50 border-blue-200', hover: 'hover:bg-blue-100', label: 'GHL', system: 'GHL' },
  fub: { base: 'text-violet-700 bg-violet-50 border-violet-200', hover: 'hover:bg-violet-100', label: 'FUB', system: 'FollowUpBoss' },
} as const

export default function SourceBadge({ system, url, name, className = '' }: {
  system: 'ghl' | 'fub'
  url: string | null
  /** Used for the tooltip only — "Open <name> in GHL". */
  name?: string | null
  className?: string
}) {
  const t = TONE[system]
  const cls = `shrink-0 text-[9px] font-bold rounded px-1 py-0.5 border ${t.base} ${className}`
  if (!url) return <span className={cls}>{t.label}</span>
  return (
    <a href={url} target="_blank" rel="noopener noreferrer"
      title={`Open ${name ? `${name} ` : ''}in ${t.system}`}
      className={`${cls} ${t.hover}`}>
      {t.label}
    </a>
  )
}
