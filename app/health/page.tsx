'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { Deal } from '@/lib/types'
import Link from 'next/link'
import {
  AlertCircle, CheckCircle2, RefreshCw, Database, ExternalLink,
  ArrowRight, Loader2, Trash2, ChevronDown, ChevronUp,
} from 'lucide-react'

// Fields we care about for completeness scoring (in priority order)
const TRACKED_FIELDS: Array<{ key: keyof Deal; label: string; critical?: boolean }> = [
  { key: 'name',             label: 'Name',             critical: true },
  { key: 'loan_officer',     label: 'Loan Officer',     critical: true },
  { key: 'loan_amount',      label: 'Loan Amount',      critical: true },
  { key: 'loan_type',        label: 'Loan Type',        critical: true },
  { key: 'email',            label: 'Email' },
  { key: 'phone',            label: 'Phone' },
  { key: 'property_address', label: 'Property Address' },
  { key: 'credit_score',     label: 'Credit Score' },
  { key: 'estimated_value',  label: 'Property Value' },
  { key: 'rate',             label: 'Rate' },
  { key: 'investor',         label: 'Investor' },
  { key: 'occupancy',        label: 'Occupancy' },
  { key: 'loan_purpose',     label: 'Loan Purpose' },
  { key: 'lock_expiration',  label: 'Lock Exp' },
  { key: 'source',           label: 'Source' },
  { key: 'arive_file_no',    label: 'Arive File #' },
]

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (typeof v === 'string' && v.trim() === '')
}

export default function HealthPage() {
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState<'monday' | 'ghl' | null>(null)
  const [syncResult, setSyncResult] = useState<string | null>(null)
  const [expandedField, setExpandedField] = useState<string | null>(null)
  const [activeOnly, setActiveOnly] = useState(true)

  // Monday cleanup state
  type MondayCandidate = { id: string; name: string; status: string; pipeline_group: string; loan_officer: string | null; loan_amount: number | null; source: string | null; created_at: string }
  const [mondayCandidates, setMondayCandidates] = useState<MondayCandidate[]>([])
  const [mondayListLoading, setMondayListLoading] = useState(false)
  const [mondayListOpen, setMondayListOpen] = useState(false)
  const [mondayDeleting, setMondayDeleting] = useState(false)

  async function fetchDeals() {
    setLoading(true)
    const { data } = await supabase.from('deals').select('*').order('created_at', { ascending: false })
    setDeals((data as Deal[]) || [])
    setLoading(false)
  }
  useEffect(() => { fetchDeals() }, [])

  async function loadMondayCandidates() {
    setMondayListLoading(true)
    try {
      const res = await fetch('/api/deals/cleanup-monday')
      const data = await res.json()
      setMondayCandidates(data.deals || [])
    } catch (e) {
      setSyncResult(`Error loading Monday imports: ${String(e)}`)
    } finally {
      setMondayListLoading(false)
    }
  }
  useEffect(() => { loadMondayCandidates() }, [])

  async function deleteMondayImports() {
    if (!confirm(`Delete all ${mondayCandidates.length} Monday-imported deals? Any deals you've manually edited will be lost. After this you can click "Sync from Monday" to re-import fresh.`)) return
    setMondayDeleting(true)
    setSyncResult(null)
    try {
      const res = await fetch('/api/deals/cleanup-monday', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      })
      const data = await res.json()
      if (data.success) {
        setSyncResult(`Deleted ${data.deleted} Monday import${data.deleted !== 1 ? 's' : ''}. Click "Sync from Monday" to re-import.`)
        await fetchDeals()
        await loadMondayCandidates()
      } else {
        setSyncResult(`Error: ${data.error || 'delete failed'}`)
      }
    } catch (e) {
      setSyncResult(`Error: ${String(e)}`)
    } finally {
      setMondayDeleting(false)
    }
  }

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
          : `GHL: synced ${data.synced} (${data.created} new, ${data.updated} updated)`
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

  // Per-field completeness stats
  const fieldStats = TRACKED_FIELDS.map(({ key, label, critical }) => {
    const total = scopedDeals.length
    const filled = scopedDeals.filter(d => !isBlank(d[key])).length
    const missing = total - filled
    const pct = total > 0 ? (filled / total) * 100 : 0
    const missingDeals = scopedDeals.filter(d => isBlank(d[key])).slice(0, 50)
    return { key: String(key), label, critical: !!critical, total, filled, missing, pct, missingDeals }
  })

  // Per-deal completeness score (only critical fields count)
  const criticalKeys = TRACKED_FIELDS.filter(f => f.critical).map(f => f.key)
  const dealsByCompleteness = scopedDeals.map(d => {
    const filled = criticalKeys.filter(k => !isBlank(d[k])).length
    const pct = (filled / criticalKeys.length) * 100
    return { deal: d, filledCriticals: filled, pct }
  }).sort((a, b) => a.pct - b.pct)

  const incompleteCount = dealsByCompleteness.filter(d => d.pct < 100).length
  const overallFieldsFilled = fieldStats.reduce((s, f) => s + f.filled, 0)
  const overallFieldsTotal = fieldStats.reduce((s, f) => s + f.total, 0)
  const overallPct = overallFieldsTotal > 0 ? (overallFieldsFilled / overallFieldsTotal) * 100 : 0

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

      {/* Monday Import Cleanup */}
      {(mondayListLoading || mondayCandidates.length > 0) && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <Database className="w-4 h-4 text-amber-600 shrink-0" />
              <div className="min-w-0">
                <h3 className="font-semibold text-amber-900 text-sm">Monday Imports</h3>
                <p className="text-xs text-amber-700 mt-0.5">
                  {mondayListLoading
                    ? 'Scanning…'
                    : `${mondayCandidates.length} deal${mondayCandidates.length !== 1 ? 's' : ''} were imported from Monday and aren't linked to GHL. Delete to start fresh, then click "Sync from Monday" to re-import.`}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => setMondayListOpen(!mondayListOpen)}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-amber-900 bg-white border border-amber-300 rounded-md hover:bg-amber-100"
              >
                {mondayListOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                {mondayListOpen ? 'Hide list' : `Preview ${mondayCandidates.length}`}
              </button>
              <button
                onClick={deleteMondayImports}
                disabled={mondayDeleting || mondayCandidates.length === 0}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-white bg-red-600 rounded-md hover:bg-red-700 disabled:opacity-50"
              >
                {mondayDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                Delete all {mondayCandidates.length}
              </button>
            </div>
          </div>

          {mondayListOpen && mondayCandidates.length > 0 && (
            <div className="bg-white border-t border-amber-200 max-h-96 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500 uppercase text-[10px] sticky top-0">
                  <tr>
                    <th className="px-4 py-2 text-left">Name</th>
                    <th className="px-4 py-2 text-left">Status</th>
                    <th className="px-4 py-2 text-left">Pipeline</th>
                    <th className="px-4 py-2 text-left">LO</th>
                    <th className="px-4 py-2 text-right">Amount</th>
                    <th className="px-4 py-2 text-left">Source</th>
                    <th className="px-4 py-2 text-left">Created</th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {mondayCandidates.map(d => (
                    <tr key={d.id} className="hover:bg-slate-50">
                      <td className="px-4 py-1.5 font-medium text-slate-900">{d.name}</td>
                      <td className="px-4 py-1.5 text-slate-600">{d.status}</td>
                      <td className="px-4 py-1.5 text-slate-600">{d.pipeline_group}</td>
                      <td className="px-4 py-1.5 text-slate-600">{d.loan_officer || '—'}</td>
                      <td className="px-4 py-1.5 text-slate-700 text-right tabular-nums">
                        {d.loan_amount ? `$${d.loan_amount.toLocaleString()}` : '—'}
                      </td>
                      <td className="px-4 py-1.5 text-slate-500">{d.source || '—'}</td>
                      <td className="px-4 py-1.5 text-slate-400">
                        {new Date(d.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </td>
                      <td className="px-4 py-1.5 text-right">
                        <Link href={`/deals/${d.id}`} className="text-blue-600 hover:underline">View</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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

      {/* Worst-offender deals (lowest completeness scores first) */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-200 bg-slate-50">
          <h2 className="font-semibold text-slate-800 text-sm">Deals with the most gaps</h2>
          <p className="text-xs text-slate-500 mt-0.5">Sorted by completeness — fix the top of this list first.</p>
        </div>
        <div className="divide-y divide-slate-100 max-h-[600px] overflow-y-auto">
          {dealsByCompleteness.filter(d => d.pct < 100).slice(0, 50).map(({ deal, filledCriticals, pct }) => {
            const missingFields = criticalKeys.filter(k => isBlank(deal[k])).map(k =>
              TRACKED_FIELDS.find(f => f.key === k)?.label
            ).filter(Boolean)
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
                  <div className="text-[10px] text-slate-400">{filledCriticals}/{criticalKeys.length}</div>
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
