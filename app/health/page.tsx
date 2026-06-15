'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { fetchAllDeals } from '@/lib/fetchAllDeals'
import { Deal } from '@/lib/types'
import Link from 'next/link'
import {
  AlertCircle, CheckCircle2, RefreshCw, Database, ExternalLink,
  ArrowRight, Loader2,
} from 'lucide-react'

// Fields we care about for completeness scoring (in priority order).
//   critical   — counts toward the per-deal completeness score
//   escrowOnly — only relevant once a deal is in process (Loans in Process).
//                These are evaluated ONLY against escrow deals, so raw leads
//                (which legitimately don't have a loan type / rate / lock yet)
//                don't get flagged as "missing".
const TRACKED_FIELDS: Array<{ key: keyof Deal; label: string; critical?: boolean; escrowOnly?: boolean }> = [
  { key: 'name',             label: 'Name',             critical: true },
  { key: 'loan_officer',     label: 'Loan Officer',     critical: true },
  { key: 'loan_amount',      label: 'Loan Amount',      critical: true },
  { key: 'loan_type',        label: 'Loan Type',        critical: true, escrowOnly: true },
  { key: 'email',            label: 'Email' },
  { key: 'phone',            label: 'Phone' },
  { key: 'property_address', label: 'Property Address' },
  { key: 'credit_score',     label: 'Credit Score',     escrowOnly: true },
  { key: 'estimated_value',  label: 'Property Value',   escrowOnly: true },
  { key: 'rate',             label: 'Rate',             escrowOnly: true },
  { key: 'investor',         label: 'Investor',         escrowOnly: true },
  { key: 'occupancy',        label: 'Occupancy' },
  { key: 'loan_purpose',     label: 'Loan Purpose' },
  { key: 'lock_expiration',  label: 'Lock Exp',         escrowOnly: true },
  { key: 'source',           label: 'Source' },
  { key: 'arive_file_no',    label: 'Arive File #',     escrowOnly: true },
]

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (typeof v === 'string' && v.trim() === '')
}

// Which critical fields apply to a given deal — escrow-only criticals don't
// count for leads (they're not expected to have a loan type / rate yet).
function applicableCriticalFields(deal: Deal) {
  return TRACKED_FIELDS.filter(f =>
    f.critical && (!f.escrowOnly || deal.pipeline_group === 'Loans in Process')
  )
}

export default function HealthPage() {
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState<'monday' | 'ghl' | null>(null)
  const [syncResult, setSyncResult] = useState<string | null>(null)
  const [expandedField, setExpandedField] = useState<string | null>(null)
  const [activeOnly, setActiveOnly] = useState(true)

  async function fetchDeals() {
    setLoading(true)
    const all = await fetchAllDeals(q => q.order('created_at', { ascending: false }))
    setDeals(all)
    setLoading(false)
  }
  useEffect(() => { fetchDeals() }, [])

  async function runSync(source: 'monday' | 'ghl') {
    setSyncing(source)
    setSyncResult(null)
    try {
      const url = source === 'monday' ? '/api/sync/monday' : '/api/sync/ghl'
      const opts = source === 'monday'
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'fill_blanks' }) }
        : { method: 'POST' }
      const res = await fetch(url, opts)
      const data = await res.json()
      if (data.success) {
        const msg = source === 'monday'
          ? `Monday: updated ${data.updated} · created ${data.created} · filled ${data.fields_filled} fields`
          : `GHL: ${data.synced} written (${data.created} new, ${data.updated} updated)` +
            (typeof data.skipped === 'number' ? `, ${data.skipped} unchanged` : '') +
            (typeof data.duration_ms === 'number' ? ` · ${(data.duration_ms / 1000).toFixed(1)}s` : '')
        setSyncResult(msg)
        await fetchDeals()
      } else {
        setSyncResult(`Error: ${data.error || 'unknown'}`)
      }
    } catch (e) {
      setSyncResult(`Error: ${String(e)}`)
    } finally {
      setSyncing(null)
    }
  }

  // Filter to active deals if toggled (excludes Funded + Not Ready since those are historical)
  const scopedDeals = activeOnly
    ? deals.filter(d => ['Leads', 'Loans in Process'].includes(d.pipeline_group))
    : deals

  // In-process (escrow) deals — the pool against which escrowOnly fields are scored.
  const escrowDeals = scopedDeals.filter(d => d.pipeline_group === 'Loans in Process')

  // Per-field completeness stats. Escrow-only fields use the escrow pool as the
  // denominator so leads (which don't have a loan type / rate / lock yet) aren't
  // counted as gaps.
  const fieldStats = TRACKED_FIELDS.map(({ key, label, critical, escrowOnly }) => {
    const pool = escrowOnly ? escrowDeals : scopedDeals
    const total = pool.length
    const filled = pool.filter(d => !isBlank(d[key])).length
    const missing = total - filled
    const pct = total > 0 ? (filled / total) * 100 : 0
    const missingDeals = pool.filter(d => isBlank(d[key])).slice(0, 50)
    return { key: String(key), label, critical: !!critical, escrowOnly: !!escrowOnly, total, filled, missing, pct, missingDeals }
  })

  // Per-deal completeness score. A critical field only counts against a deal if
  // it applies to that deal's stage (escrowOnly criticals are ignored for leads).
  const dealsByCompleteness = scopedDeals.map(d => {
    const applicable = applicableCriticalFields(d)
    const filled = applicable.filter(f => !isBlank(d[f.key])).length
    const pct = applicable.length > 0 ? (filled / applicable.length) * 100 : 100
    return { deal: d, filledCriticals: filled, totalCriticals: applicable.length, pct }
  }).sort((a, b) => a.pct - b.pct)

  const incompleteCount = dealsByCompleteness.filter(d => d.pct < 100).length
  const overallFieldsFilled = fieldStats.reduce((s, f) => s + f.filled, 0)
  const overallFieldsTotal = fieldStats.reduce((s, f) => s + f.total, 0)
  const overallPct = overallFieldsTotal > 0 ? (overallFieldsFilled / overallFieldsTotal) * 100 : 0

  // ── Funded ⇄ Arive reconciliation ──────────────────────────────────────────
  // A real (current-company) closing reconciles to an Arive loan file. A funded
  // deal with no arive_file_no is either a LEGACY old-company loan (real, predates
  // Arive — funded in 2025 or earlier) or an UNCONFIRMED funding: a GHL opportunity
  // dragged to "Loan Funded" that never actually closed (e.g. the borrower couldn't
  // qualify), or the GHL half of a loan whose Arive row is a separate record. We
  // split them so the real problems aren't buried under the ~40 legacy loans.
  const fundedNoArive = deals.filter(d => d.pipeline_group === 'Funded' && isBlank(d.arive_file_no))
  const isLegacyFunded = (d: Deal) => {
    const fd = d.funded_date
    return !!(fd && /^\d{4}/.test(fd) && parseInt(fd.slice(0, 4), 10) <= 2025)
  }
  const fundedNeedsReview = fundedNoArive
    .filter(d => !isLegacyFunded(d))
    .sort((a, b) => (b.loan_amount ?? 0) - (a.loan_amount ?? 0))
  const legacyFundedCount = fundedNoArive.length - fundedNeedsReview.length

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full p-12">
        <Loader2 className="w-6 h-6 text-blue-600 animate-spin" />
      </div>
    )
  }

  return (
    <div className="p-6 space-y-5 max-w-7xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Data Health</h1>
          <p className="text-slate-500 text-sm mt-0.5">
            Find missing fields, sync from sources, and clean up your pipeline data.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => runSync('ghl')}
            disabled={!!syncing}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50"
          >
            {syncing === 'ghl' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Sync GHL
          </button>
          <button
            onClick={() => runSync('monday')}
            disabled={!!syncing}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {syncing === 'monday' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Database className="w-3.5 h-3.5" />}
            Sync from Monday
          </button>
        </div>
      </div>

      {syncResult && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-2.5 text-sm text-blue-900">
          {syncResult}
        </div>
      )}

      {/* Scope toggle */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-500">Scope:</span>
        <div className="flex bg-slate-100 rounded-lg p-1 gap-0.5">
          <button
            onClick={() => setActiveOnly(true)}
            className={`px-3 py-1 text-xs font-medium rounded-md transition ${activeOnly ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}
          >
            Active deals ({deals.filter(d => ['Leads', 'Loans in Process'].includes(d.pipeline_group)).length})
          </button>
          <button
            onClick={() => setActiveOnly(false)}
            className={`px-3 py-1 text-xs font-medium rounded-md transition ${!activeOnly ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}
          >
            All deals ({deals.length})
          </button>
        </div>
      </div>

      {/* Top-line scorecard */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium uppercase text-slate-500 tracking-wide">Overall Completeness</p>
          <div className="flex items-end gap-2 mt-2">
            <span className="text-3xl font-bold text-slate-900">{overallPct.toFixed(0)}%</span>
            <span className="text-sm text-slate-500 mb-1">{overallFieldsFilled} / {overallFieldsTotal} fields</span>
          </div>
          <div className="mt-3 h-2 bg-slate-100 rounded-full overflow-hidden">
            <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${overallPct}%` }} />
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium uppercase text-slate-500 tracking-wide">Deals With Gaps</p>
          <div className="flex items-end gap-2 mt-2">
            <span className="text-3xl font-bold text-amber-600">{incompleteCount}</span>
            <span className="text-sm text-slate-500 mb-1">of {scopedDeals.length}</span>
          </div>
          <p className="text-xs text-slate-400 mt-2">Missing one or more critical fields</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium uppercase text-slate-500 tracking-wide">Fully Complete</p>
          <div className="flex items-end gap-2 mt-2">
            <span className="text-3xl font-bold text-emerald-600">
              {scopedDeals.length - incompleteCount}
            </span>
            <span className="text-sm text-slate-500 mb-1">deals</span>
          </div>
          <p className="text-xs text-slate-400 mt-2">All critical fields populated</p>
        </div>
      </div>

      {/* Per-field breakdown */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-200 bg-slate-50">
          <h2 className="font-semibold text-slate-800 text-sm">Field-by-field completeness</h2>
          <p className="text-xs text-slate-500 mt-0.5">Click any row to see which deals are missing that field.</p>
        </div>
        <div className="divide-y divide-slate-100">
          {fieldStats.map(f => {
            const isOpen = expandedField === f.key
            const isCritical = f.critical
            return (
              <div key={f.key}>
                <button
                  onClick={() => setExpandedField(isOpen ? null : f.key)}
                  className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-slate-50 transition"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-slate-800">{f.label}</span>
                      {isCritical && (
                        <span className="text-[10px] font-semibold text-red-600 bg-red-50 px-1.5 py-0.5 rounded">
                          REQUIRED
                        </span>
                      )}
                      {f.escrowOnly && (
                        <span
                          className="text-[10px] font-semibold text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded"
                          title="Only evaluated for deals in the Loans in Process pipeline — leads aren't expected to have this yet"
                        >
                          ESCROWS ONLY
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-1.5">
                      <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden max-w-md">
                        <div
                          className={`h-full transition-all ${
                            f.pct >= 90 ? 'bg-emerald-500' :
                            f.pct >= 60 ? 'bg-amber-500' : 'bg-red-500'
                          }`}
                          style={{ width: `${f.pct}%` }}
                        />
                      </div>
                      <span className="text-xs text-slate-500 tabular-nums">
                        {f.filled}/{f.total} ({f.pct.toFixed(0)}%)
                      </span>
                    </div>
                  </div>
                  {f.missing > 0 ? (
                    <div className="flex items-center gap-1.5 text-xs font-medium text-amber-600">
                      <AlertCircle className="w-3.5 h-3.5" />
                      {f.missing} missing
                      <ArrowRight className={`w-3.5 h-3.5 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-600">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Complete
                    </div>
                  )}
                </button>
                {isOpen && f.missingDeals.length > 0 && (
                  <div className="bg-slate-50 px-5 py-3 border-t border-slate-100">
                    <p className="text-xs text-slate-500 mb-2">
                      Showing first {f.missingDeals.length} of {f.missing} deal{f.missing !== 1 ? 's' : ''} missing <strong>{f.label}</strong>:
                    </p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
                      {f.missingDeals.map(d => (
                        <Link
                          key={d.id}
                          href={`/deals/${d.id}`}
                          className="flex items-center justify-between text-xs px-3 py-1.5 bg-white border border-slate-200 rounded hover:border-blue-400 hover:bg-blue-50 transition"
                        >
                          <span className="font-medium text-slate-800 truncate">{d.name}</span>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className="text-slate-400">{d.status}</span>
                            <ExternalLink className="w-3 h-3 text-slate-400" />
                          </div>
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Funded ⇄ Arive reconciliation */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between gap-4">
          <div>
            <h2 className="font-semibold text-slate-800 text-sm">Funded loans not reconciled to Arive</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              A real current-company closing has an Arive file #. These funded deals don&apos;t — review each:
              confirm &amp; import it from Arive, or it never actually funded (move it out of &ldquo;Loan Funded&rdquo; in GHL).
            </p>
          </div>
          <div className="text-right shrink-0">
            <div className={`text-lg font-bold ${fundedNeedsReview.length ? 'text-amber-600' : 'text-emerald-600'}`}>{fundedNeedsReview.length}</div>
            <div className="text-[10px] text-slate-400 uppercase tracking-wide">need review</div>
          </div>
        </div>
        <div className="divide-y divide-slate-100 max-h-[500px] overflow-y-auto">
          {fundedNeedsReview.map(d => (
            <Link key={d.id} href={`/deals/${d.id}`} className="flex items-center gap-4 px-5 py-3 hover:bg-slate-50 transition">
              <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-900 truncate">{d.name}</span>
                  <span className="text-xs text-slate-400 shrink-0">· {d.status}</span>
                  {d.loan_officer && <span className="text-xs text-slate-400 shrink-0">· {d.loan_officer}</span>}
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  {d.source || 'no source'} · {d.funded_date || 'no funded date'} · no Arive&nbsp;#
                </div>
              </div>
              <div className="text-sm font-semibold text-slate-700 tabular-nums shrink-0">
                {d.loan_amount ? '$' + Number(d.loan_amount).toLocaleString() : '$0'}
              </div>
              <ExternalLink className="w-4 h-4 text-slate-400 shrink-0" />
            </Link>
          ))}
          {fundedNeedsReview.length === 0 && (
            <div className="px-5 py-12 text-center">
              <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-2" />
              <p className="text-sm font-semibold text-slate-800">Every current funded loan reconciles to Arive!</p>
            </div>
          )}
        </div>
        {legacyFundedCount > 0 && (
          <div className="px-5 py-2.5 border-t border-slate-200 bg-slate-50/60 text-xs text-slate-500">
            + {legacyFundedCount} legacy funded loan{legacyFundedCount === 1 ? '' : 's'} (funded 2025 / pre-Arive, old company) hidden — real closings with no Arive data, intentionally not flagged.
          </div>
        )}
      </div>

      {/* Worst-offender deals (lowest completeness scores first) */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-200 bg-slate-50">
          <h2 className="font-semibold text-slate-800 text-sm">Deals with the most gaps</h2>
          <p className="text-xs text-slate-500 mt-0.5">Sorted by completeness — fix the top of this list first.</p>
        </div>
        <div className="divide-y divide-slate-100 max-h-[600px] overflow-y-auto">
          {dealsByCompleteness.filter(d => d.pct < 100).slice(0, 50).map(({ deal, filledCriticals, totalCriticals, pct }) => {
            const missingFields = applicableCriticalFields(deal)
              .filter(f => isBlank(deal[f.key]))
              .map(f => f.label)
            return (
              <Link
                key={deal.id}
                href={`/deals/${deal.id}`}
                className="flex items-center gap-4 px-5 py-3 hover:bg-slate-50 transition"
              >
                <div className="w-12 shrink-0 text-center">
                  <div className={`text-sm font-bold ${pct < 50 ? 'text-red-600' : pct < 80 ? 'text-amber-600' : 'text-emerald-600'}`}>
                    {pct.toFixed(0)}%
                  </div>
                  <div className="text-[10px] text-slate-400">{filledCriticals}/{totalCriticals}</div>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-900 truncate">{deal.name}</span>
                    <span className="text-xs text-slate-400 shrink-0">· {deal.status}</span>
                    {deal.loan_officer && <span className="text-xs text-slate-400 shrink-0">· {deal.loan_officer}</span>}
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {missingFields.map(f => (
                      <span key={f} className="text-[10px] font-medium bg-red-50 text-red-700 px-1.5 py-0.5 rounded">
                        {f}
                      </span>
                    ))}
                  </div>
                </div>
                <ExternalLink className="w-4 h-4 text-slate-400 shrink-0" />
              </Link>
            )
          })}
          {incompleteCount === 0 && (
            <div className="px-5 py-12 text-center">
              <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-2" />
              <p className="text-sm font-semibold text-slate-800">Everything looks complete!</p>
              <p className="text-xs text-slate-500 mt-1">All critical fields are populated for active deals.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
