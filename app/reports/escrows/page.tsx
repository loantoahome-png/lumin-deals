'use client'

/**
 * Active Escrows Report — a print-friendly, per-LO snapshot of the Loans-in-Process
 * pipeline. Same data + active-escrow filter as /deals (pipeline_group =
 * 'Loans in Process', excluding lost/abandoned), grouped by stage.
 *
 * Each deal shows: stage, the current next step,
 * rate-lock status + expiration (countdown, color-coded), the assigned processor,
 * and the loan details. LO toggle = "two reports" (Moe / Matt) off one page; the
 * Print button isolates #escrow-report so Cmd/Ctrl+P → Save as PDF gives a clean doc.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { fetchAllDeals } from '@/lib/fetchAllDeals'
import { Deal, LOAN_OFFICERS, STATUS_COLORS, PIPELINE_STATUSES } from '@/lib/types'
import { formatCurrency, formatDate } from '@/lib/utils'
import { Printer, RefreshCw, ArrowLeft, Lock, AlertTriangle, UserCog, Flag, Ban } from 'lucide-react'
import { LoFilter, useLoFilter, loSelected, DEFAULT_LOS } from '@/components/LoFilter'

const MS_PER_DAY = 86_400_000
const daysUntil = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return isNaN(t) ? null : Math.floor((t - Date.now()) / MS_PER_DAY)
}

// Trim float noise for display (LTV like 66.4864… → 66.5; rates keep their eighths).
const round = (v: number, n: number) => Math.round(v * 10 ** n) / 10 ** n

const STAGE_ORDER = PIPELINE_STATUSES['Loans in Process']

type Tone = 'gray' | 'green' | 'amber' | 'red'
const TONE: Record<Tone, string> = {
  gray: 'bg-slate-100 text-slate-500',
  green: 'bg-emerald-100 text-emerald-700',
  amber: 'bg-amber-100 text-amber-700',
  red: 'bg-red-100 text-red-700',
}

// Rate-lock summary for one deal.
function lockInfo(deal: Deal): { locked: boolean; label: string; tone: Tone; expiring: boolean; expired: boolean } {
  const isLocked = (deal.locked || '').trim().toLowerCase() === 'yes'
  if (!isLocked) return { locked: false, label: 'Not locked', tone: 'gray', expiring: false, expired: false }
  if (!deal.lock_expiration) return { locked: true, label: 'Locked · no expiry set', tone: 'amber', expiring: false, expired: false }
  const d = daysUntil(deal.lock_expiration)
  const exp = formatDate(deal.lock_expiration)
  if (d == null) return { locked: true, label: `Locked · ${exp}`, tone: 'green', expiring: false, expired: false }
  if (d < 0) return { locked: true, label: `Lock EXPIRED ${exp}`, tone: 'red', expiring: false, expired: true }
  if (d <= 7) return { locked: true, label: `Locked · expires ${exp} (${d}d)`, tone: 'amber', expiring: true, expired: false }
  return { locked: true, label: `Locked · expires ${exp} (${d}d)`, tone: 'green', expiring: false, expired: false }
}

// Current next step + when it was entered. Prefer the latest next_action_log entry
// (it carries the `at` timestamp); fall back to the legacy next_action field (no timestamp).
function nextStepEntry(deal: Deal): { text: string; at: string | null } | null {
  const top = deal.next_action_log?.[0]
  if (top?.text?.trim()) return { text: top.text.trim(), at: top.at || null }
  const legacy = deal.next_action?.trim()
  return legacy ? { text: legacy, at: null } : null
}

// "Jun 30, 9:12 AM" — when a next step was logged.
const fmtEntered = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

function ReportInner() {
  const searchParams = useSearchParams()
  // Deep-link support: /reports/escrows?lo=<name> (used by the deals page) seeds the
  // selection to just that LO; otherwise the Moe + Matt default view applies.
  const initialLOs = (() => {
    const q = searchParams.get('lo')
    if (q && LOAN_OFFICERS.includes(q as typeof LOAN_OFFICERS[number])) return [q]
    return [...DEFAULT_LOS]
  })()

  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const { selectedLOs, toggleLO, allLOsSelected } = useLoFilter(initialLOs)

  const load = useCallback(async () => {
    setLoading(true)
    const all = await fetchAllDeals(q => q.order('created_at', { ascending: false }))
    setDeals(all)
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  // Active escrows only — mirrors the /deals page filter.
  const active = useMemo(() => deals.filter(d => {
    const ghlSt = (d.ghl_status ?? '').toLowerCase()
    if (ghlSt === 'lost' || ghlSt.startsWith('abandon')) return false
    return d.pipeline_group === 'Loans in Process'
  }), [deals])

  const forLO = useMemo(
    () => (allLOsSelected ? active : active.filter(d => loSelected(d.loan_officer, selectedLOs))),
    [active, selectedLOs, allLOsSelected],
  )

  // Group by stage, in canonical pipeline order (unknown stages appended).
  const groups = useMemo(() => {
    const byStage = new Map<string, Deal[]>()
    for (const d of forLO) {
      const arr = byStage.get(d.status) ?? []
      arr.push(d)
      byStage.set(d.status, arr)
    }
    const ordered = [
      ...STAGE_ORDER.filter(s => byStage.has(s)),
      ...[...byStage.keys()].filter(s => !STAGE_ORDER.includes(s)),
    ]
    return ordered.map(stage => ({ stage, deals: byStage.get(stage)! }))
  }, [forLO])

  const kpis = useMemo(() => {
    let locked = 0, expiring = 0
    for (const d of forLO) {
      const li = lockInfo(d)
      if (li.locked) locked++
      if (li.expiring) expiring++
    }
    const volume = forLO.reduce((s, d) => s + (d.loan_amount || 0), 0)
    return { count: forLO.length, volume, locked, expiring }
  }, [forLO])

  // Loans whose rate lock expires within the next 7 days (soonest first).
  const expiringDeals = useMemo(
    () => forLO.filter(d => lockInfo(d).expiring)
      .sort((a, b) => (a.lock_expiration || '').localeCompare(b.lock_expiration || '')),
    [forLO],
  )

  const generatedAt = new Date().toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })

  return (
    <div className="flex flex-col h-full bg-slate-50">
      <style>{`
        @media print {
          @page { margin: 0.5in; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; background: #fff; }
          body * { visibility: hidden; }
          #escrow-report, #escrow-report * { visibility: visible; }
          #escrow-report { position: absolute; left: 0; top: 0; width: 100%; padding: 0 !important; }
          .no-print { display: none !important; }
          .deal-row { break-inside: avoid; }
          .stage-head { break-after: avoid; }
        }
      `}</style>

      {/* ── Controls (not printed) ──────────────────────────────────────────── */}
      <div className="no-print px-6 py-3 bg-white border-b border-slate-200 shrink-0 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Link href="/deals" className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
            <ArrowLeft className="w-4 h-4" /> Active Escrows
          </Link>
          <span className="w-px h-5 bg-slate-200" />
          <LoFilter selected={selectedLOs} onToggle={toggleLO} />
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} title="Refresh" className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={() => window.print()}
            className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700"
          >
            <Printer className="w-4 h-4" /> Print / Save as PDF
          </button>
        </div>
      </div>

      {/* ── Report body (printed) ───────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
          </div>
        ) : (
          <div id="escrow-report" className="max-w-5xl mx-auto px-6 py-6">
            {/* Title */}
            <div className="flex items-end justify-between border-b-2 border-slate-800 pb-3 mb-5">
              <div>
                <h1 className="text-2xl font-bold text-slate-900">Active Escrows Report</h1>
                <p className="text-sm text-slate-500 mt-0.5">
                  {allLOsSelected ? 'All Loan Officers' : selectedLOs.join(', ')} · {kpis.count} loan{kpis.count !== 1 ? 's' : ''} · {formatCurrency(kpis.volume)} volume
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm font-bold text-slate-800">Lumin Lending</p>
                <p className="text-xs text-slate-400">Generated {generatedAt}</p>
              </div>
            </div>

            {/* KPI band */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-6">
              <Kpi label="Loans" value={String(kpis.count)} />
              <Kpi label="Volume" value={formatCurrency(kpis.volume)} />
              <Kpi label="Locked" value={`${kpis.locked}/${kpis.count}`} tone={kpis.locked ? 'green' : 'gray'} />
              <Kpi label="Lock ≤7d" value={String(kpis.expiring)} tone={kpis.expiring ? 'amber' : 'gray'} />
            </div>

            {/* Locks expiring within the next 7 days — top callout (only when any apply) */}
            {expiringDeals.length > 0 && (
              <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 break-inside-avoid">
                <div className="flex items-center gap-2 mb-2">
                  <Lock className="w-4 h-4 text-amber-600" />
                  <h2 className="text-sm font-bold uppercase tracking-wide text-amber-700">Locks expiring within the next 7 days</h2>
                  <span className="text-xs font-semibold text-amber-600">{expiringDeals.length}</span>
                </div>
                <div className="divide-y divide-amber-100">
                  {expiringDeals.map(d => {
                    const dleft = daysUntil(d.lock_expiration)
                    return (
                      <div key={d.id} className="flex items-center justify-between py-1.5 text-sm">
                        <span className="font-semibold text-slate-800">{d.name}</span>
                        <span className="text-slate-700">
                          {formatDate(d.lock_expiration)}
                          {dleft != null && <span className="text-amber-600 font-medium ml-2">{dleft === 0 ? 'today' : `${dleft}d`}</span>}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {groups.length === 0 ? (
              <p className="text-sm text-slate-400 py-12 text-center">No active escrows for {allLOsSelected ? 'any LO' : selectedLOs.join(', ')}.</p>
            ) : (
              groups.map(g => {
                const stageVol = g.deals.reduce((s, d) => s + (d.loan_amount || 0), 0)
                const badge = STATUS_COLORS[g.stage] || 'bg-slate-100 text-slate-600'
                return (
                  <section key={g.stage} className="mb-6">
                    <div className={`stage-head flex items-center justify-between px-4 py-2.5 rounded-md mb-2 ${badge}`}>
                      <span className="text-lg font-extrabold uppercase tracking-wider">{g.stage}</span>
                      <span className="text-sm font-semibold opacity-75">{g.deals.length} · {formatCurrency(stageVol)}</span>
                    </div>
                    <div className="space-y-2">
                      {g.deals.map(d => <DealRow key={d.id} deal={d} />)}
                    </div>
                  </section>
                )
              })
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Kpi({ label, value, tone = 'gray' }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="bg-white rounded-lg border border-slate-200 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">{label}</p>
      <p className={`text-base font-bold mt-0.5 ${tone === 'gray' ? 'text-slate-800' : tone === 'green' ? 'text-emerald-600' : tone === 'amber' ? 'text-amber-600' : 'text-red-600'}`}>
        {value}
      </p>
    </div>
  )
}

function DealRow({ deal }: { deal: Deal }) {
  const li = lockInfo(deal)
  const step = nextStepEntry(deal)
  const processor = deal.processor_status || deal.processor || null
  const blocked = deal.waiting_on && deal.waiting_on !== 'No one' ? deal.waiting_on : null
  const priority = deal.escrow_priority && deal.escrow_priority !== 'normal' ? deal.escrow_priority : null

  return (
    <div className="deal-row bg-white rounded-lg border-2 border-slate-300 px-4 py-3">
      {/* Row 1: name + amount + lock */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-bold text-slate-900 leading-tight">{deal.name}</p>
          {deal.property_address && (
            <p className="text-xs text-slate-400 truncate">
              {deal.property_address}{deal.city ? `, ${deal.city}` : ''}{deal.state ? `, ${deal.state}` : ''}
            </p>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className="font-bold text-slate-900">
            {deal.broker_corr && <span className="font-medium text-slate-500">{deal.broker_corr} - </span>}
            {deal.loan_amount ? formatCurrency(deal.loan_amount) : '—'}
          </p>
          <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-1.5 py-0.5 rounded mt-0.5 ${TONE[li.tone]}`}>
            <Lock className="w-3 h-3" /> {li.label}
          </span>
        </div>
      </div>

      {/* Row 2: loan detail chips */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-xs text-slate-600">
        {deal.loan_type && <Chip>{deal.loan_type}</Chip>}
        {deal.loan_purpose && <Chip>{deal.loan_purpose}{deal.refinance_type ? ` · ${deal.refinance_type}` : ''}</Chip>}
        {deal.rate != null && <Detail label="Rate">{round(deal.rate, 3)}%</Detail>}
        {deal.ltv != null && <Detail label="LTV">{round(deal.ltv, 1)}%</Detail>}
        {deal.credit_score != null && <Detail label="FICO">{deal.credit_score}</Detail>}
        {deal.investor && <Detail label="Lender">{deal.investor}</Detail>}
      </div>

      {/* Row 3: ops — processor, priority, blocker */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-xs">
        <span className="inline-flex items-center gap-1 text-slate-500">
          <UserCog className="w-3 h-3" />
          <span><span className="text-slate-400">Processor:</span> <span className="font-semibold text-slate-700">{processor || '—'}</span>{deal.processor_handoff ? ' · handed off' : ''}</span>
        </span>
        {priority && (
          <span className={`inline-flex items-center gap-1 font-semibold ${priority === 'high' ? 'text-red-600' : 'text-slate-500'}`}>
            <Flag className="w-3 h-3" /> {priority} priority
          </span>
        )}
        {blocked && (
          <span className="inline-flex items-center gap-1 text-amber-700 font-semibold">
            <Ban className="w-3 h-3" /> waiting on {blocked}
          </span>
        )}
      </div>

      {/* Row 4: next step — boxed + tinted so it doesn't blend into the card */}
      {step ? (
        <div className="mt-2.5 rounded-md border border-orange-200 bg-orange-50 px-3 py-2">
          <div className="flex items-start gap-2 text-xs">
            <div className="min-w-0">
              <span className="text-[10px] font-bold uppercase tracking-wider text-orange-700 mr-1.5">Next Step</span>
              <span className="text-slate-900 font-semibold">{step.text}</span>
              {(step.at || deal.next_action_due || deal.next_action_assignee) && (
                <div className="text-slate-500 mt-0.5">
                  {step.at && <span>Entered {fmtEntered(step.at)}</span>}
                  {deal.next_action_due && <span>{step.at ? ' · ' : ''}due {formatDate(deal.next_action_due)}</span>}
                  {deal.next_action_assignee && <span> · {deal.next_action_assignee}</span>}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-2.5 pt-2 border-t border-slate-100 text-xs text-slate-400 italic flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-slate-300" /> No next step logged
        </div>
      )}
    </div>
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-medium">{children}</span>
}
function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="text-slate-500">
      <span className="text-slate-400">{label}:</span> <span className="font-semibold text-slate-700">{children}</span>
    </span>
  )
}

export default function EscrowReportPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    }>
      <ReportInner />
    </Suspense>
  )
}
