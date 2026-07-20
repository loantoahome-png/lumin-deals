'use client'

import { useCallback, useState, type ReactNode } from 'react'
import { Check, Filter } from 'lucide-react'
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

/** The shared LO filter control — multi-select checkboxes with colored checks.
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
        <span className="mr-0.5 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
          <Filter className="h-3.5 w-3.5" /> {label}
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
            className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${
              active
                ? 'border-slate-300 bg-white text-slate-700 shadow-sm'
                : 'border-slate-200 bg-slate-50 text-slate-400 hover:bg-white hover:text-slate-600'
            }`}
          >
            <span
              className={`flex h-4 w-4 items-center justify-center rounded border transition ${active ? 'border-transparent' : 'border-slate-300 bg-white'}`}
              style={active ? { backgroundColor: color } : undefined}
            >
              {active && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
            </span>
            {lo}
          </button>
        )
      })}
    </div>
  )
}
