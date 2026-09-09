'use client'

import { useCallback, useState, type ReactNode } from 'react'
import { LOAN_OFFICERS } from '@/lib/types'
import { resolveLO, DEFAULT_LOS } from '@/lib/loanOfficer'

// DEFAULT_LOS now lives in lib/loanOfficer (server-safe, so the triage cron can
// gate on the same Moe+Matt scope the UI defaults to). Re-exported here so the
// existing `import { DEFAULT_LOS } from '@/components/LoFilter'` call sites keep working.
export { DEFAULT_LOS }

// Loan-officer checkbox swatches — the single source of truth for LO colors across
// the whole app (dashboard, deals, lead-roi, lead-cohorts, hot-leads, …).
export const LO_COLORS: Record<string, string> = {
  'Matt Park': '#10b981',
  'Moe Sefati': '#f59e0b',
  'Randy Mathis': '#8b5cf6',
  'Daniel McGrail-Granger': '#0ea5e9',
}

// Tint classes for a SELECTED chip — the light step of each LO's color above, so a
// checked officer reads as "their" color without a checkbox.
export const LO_TINT: Record<string, string> = {
  'Matt Park':              'border-emerald-200 bg-emerald-50 text-emerald-700',
  'Moe Sefati':             'border-amber-200 bg-amber-50 text-amber-700',
  'Randy Mathis':           'border-violet-200 bg-violet-50 text-violet-700',
  'Daniel McGrail-Granger': 'border-sky-200 bg-sky-50 text-sky-700',
}

/** Multi-select LO filter state, seeded to the Moe + Matt default view. */
export function useLoFilter(initial: string[] = [...DEFAULT_LOS]) {
  const [selectedLOs, setSelectedLOs] = useState<string[]>(initial)
  const toggleLO = useCallback(
    (name: string) => setSelectedLOs(prev => (prev.includes(name) ? prev.filter(x => x !== name) : [...prev, name])),
    [],
  )
  const allLOsSelected = selectedLOs.length === LOAN_OFFICERS.length
  return { selectedLOs, setSelectedLOs, toggleLO, allLOsSelected }
}

/** Does a deal's loan_officer fall within the current selection? Matches the dashboard's
 *  semantics: all-selected = everyone; otherwise normalize via resolveLO and test membership. */
export function loSelected(loanOfficer: string | null | undefined, selectedLOs: string[]): boolean {
  if (selectedLOs.length === LOAN_OFFICERS.length) return true
  const lo = resolveLO(loanOfficer)
  return lo != null && selectedLOs.includes(lo)
}

/** The shared LO filter control — multi-select dot chips; a selected chip fills with
 *  that officer's tint.
 *  Pass `label` to show a heading (e.g. the dashboard's "Loan Officers"); omit it when
 *  the page supplies its own row label. */
export function LoFilter({
  selected,
  onToggle,
  label,
  className = '',
}: {
  selected: string[]
  onToggle: (name: string) => void
  label?: ReactNode
  className?: string
}) {
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      {label != null && (
        <span className="mr-1 text-[10.5px] font-semibold uppercase tracking-wider text-slate-400">
          {label}
        </span>
      )}
      {LOAN_OFFICERS.map(lo => {
        const active = selected.includes(lo)
        const color = LO_COLORS[lo] || '#3b82f6'
        return (
          <button
            key={lo}
            type="button"
            onClick={() => onToggle(lo)}
            aria-pressed={active}
            title={active ? `Hide ${lo}` : `Show ${lo}`}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition ${
              active
                ? (LO_TINT[lo] || 'border-slate-300 bg-white text-slate-700')
                : 'border-transparent bg-transparent text-slate-400 hover:bg-slate-100 hover:text-slate-600'
            }`}
          >
            <span
              className={`h-2 w-2 shrink-0 rounded-full transition ${active ? '' : 'opacity-35'}`}
              style={{ backgroundColor: color }}
            />
            {lo}
          </button>
        )
      })}
    </div>
  )
}
