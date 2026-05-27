'use client'

import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { fetchAllDeals } from '@/lib/fetchAllDeals'
import { Deal } from '@/lib/types'
import Link from 'next/link'
import {
  Loader2, Mail, Phone, User, GitMerge, AlertTriangle,
  CheckCircle2, ExternalLink, ChevronDown, ChevronUp,
} from 'lucide-react'
import { formatCurrency } from '@/lib/utils'

type MatchType = 'email' | 'phone' | 'name'

type DuplicateGroup = {
  key: string
  matchType: MatchType
  matchValue: string
  deals: Deal[]
}

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (typeof v === 'string' && v.trim() === '')
}

// ── Normalization helpers ────────────────────────────────────────────────────
function normEmail(s: string | null | undefined): string | null {
  if (!s) return null
  const t = s.toLowerCase().trim()
  return t || null
}
function normPhone(s: string | null | undefined): string | null {
  if (!s) return null
  const digits = s.replace(/\D/g, '')
  if (digits.length < 10) return null
  return digits.slice(-10) // last 10 digits handles +1 prefix
}
function normName(s: string | null | undefined): string | null {
  if (!s) return null
  const t = s.toLowerCase().trim().replace(/\s+/g, ' ')
  return t.length >= 3 ? t : null
}

// A group is a LEGIT multi-loan (NOT a duplicate) when every deal is its own
// distinct GHL opportunity — i.e. separate loans/leads for the same person.
// We only surface a group for review when that's NOT the case (e.g. a deal
// without an opportunity id, or two rows sharing one — a true cross-source /
// app duplicate).
function isLegitMultiLoan(deals: Deal[]): boolean {
  const opps = deals.map(d => d.ghl_opportunity_id).filter(Boolean) as string[]
  return opps.length === deals.length && new Set(opps).size === opps.length
}

// ── Detect duplicate groups ─────────────────────────────────────────────────
// NOTE: we deliberately do NOT group by ghl_contact_id anymore — with the
// multi-loan model, one contact legitimately has many opportunities/deals.
// Grouping by contact would flag every repeat lead / second loan as a "dup".
function detectDuplicates(deals: Deal[]): DuplicateGroup[] {
  const byEmail   = new Map<string, Deal[]>()
  const byPhone   = new Map<string, Deal[]>()
  const byName    = new Map<string, Deal[]>()

  for (const d of deals) {
    const e = normEmail(d.email)
    if (e) (byEmail.get(e) ?? byEmail.set(e, []).get(e)!).push(d)
    const p = normPhone(d.phone)
    if (p) (byPhone.get(p) ?? byPhone.set(p, []).get(p)!).push(d)
    const n = normName(d.name)
    if (n) (byName.get(n) ?? byName.set(n, []).get(n)!).push(d)
  }

  // Build groups, deduping deals across detection methods (so a group of 3 isn't reported 3x)
  const seenGroupSignatures = new Set<string>()
  const groups: DuplicateGroup[] = []

  function addGroup(matchType: MatchType, matchValue: string, deals: Deal[]) {
    if (deals.length < 2) return
    // Skip legit multi-loan groups (each deal is its own distinct opportunity)
    if (isLegitMultiLoan(deals)) return
    const ids = deals.map(d => d.id).sort().join('|')
    if (seenGroupSignatures.has(ids)) return
    seenGroupSignatures.add(ids)
    groups.push({ key: `${matchType}:${matchValue}`, matchType, matchValue, deals })
  }

  for (const [v, ds] of byEmail) addGroup('email', v, ds)
  for (const [v, ds] of byPhone) addGroup('phone', v, ds)
  for (const [v, ds] of byName)  addGroup('name', v, ds)

  // Sort: largest groups first, then most-recent
  return groups.sort((a, b) =>
    b.deals.length - a.deals.length ||
    new Date(b.deals[0].updated_at).getTime() - new Date(a.deals[0].updated_at).getTime()
  )
}

// ── Choose the "best" deal as primary in a group ─────────────────────────────
const SCORE_FIELDS: (keyof Deal)[] = [
  'loan_officer','loan_type','loan_amount','property_address',
  'credit_score','rate','investor','occupancy',
  'email','phone','lock_expiration','signing_date',
]
function completenessScore(d: Deal): number {
  let n = 0
  for (const f of SCORE_FIELDS) {
    const v = d[f]
    if (v !== null && v !== undefined && v !== '') n++
  }
  return n
}
function pickBestPrimary(deals: Deal[]): Deal {
  return [...deals].sort((a, b) => {
    const sa = completenessScore(a)
    const sb = completenessScore(b)
    if (sa !== sb) return sb - sa
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  })[0]
}

// ── Pipeline-group ranking (so a Funded deal beats a Lead one when conflicting) ─
const PIPELINE_RANK: Record<string, number> = {
  'Funded': 4, 'Loans in Process': 3, 'Leads': 2, 'Not Ready': 1,
}

const MATCH_LABELS: Record<MatchType, { label: string; icon: React.ReactNode }> = {
  email:           { label: 'Same email',           icon: <Mail className="w-3.5 h-3.5" /> },
  phone:           { label: 'Same phone',           icon: <Phone className="w-3.5 h-3.5" /> },
  name:            { label: 'Same name',            icon: <User className="w-3.5 h-3.5" /> },
}

export default function DuplicatesPage() {
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [merging, setMerging] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [primaryOverrides, setPrimaryOverrides] = useState<Record<string, string>>({}) // groupKey → dealId
  // Field-level override: per group, per field, which deal's value to use as the merged value
  const [fieldOverrides, setFieldOverrides] = useState<Record<string, Record<string, string>>>({}) // groupKey → field → dealId
  const [filterType, setFilterType] = useState<'all' | MatchType>('all')
  const [resultMsg, setResultMsg] = useState<string | null>(null)

  async function fetchDeals() {
    setLoading(true)
    const all = await fetchAllDeals(q => q.order('updated_at', { ascending: false }))
    setDeals(all)
    setLoading(false)
  }
  useEffect(() => { fetchDeals() }, [])

  const groups = useMemo(() => detectDuplicates(deals), [deals])
  const filteredGroups = filterType === 'all' ? groups : groups.filter(g => g.matchType === filterType)

  const totalDealsInDupes = groups.reduce((s, g) => s + g.deals.length, 0)
  const wouldRemove = groups.reduce((s, g) => s + g.deals.length - 1, 0) // each group keeps 1

  function getPrimaryFor(group: DuplicateGroup): Deal {
    const overrideId = primaryOverrides[group.key]
    if (overrideId) {
      const d = group.deals.find(x => x.id === overrideId)
      if (d) return d
    }
    return pickBestPrimary(group.deals)
  }

  async function mergeOne(group: DuplicateGroup) {
    const primary = getPrimaryFor(group)
    const secondaries = group.deals.filter(d => d.id !== primary.id)
    // Convert per-field overrides (dealId references) into concrete value overrides
    const fOverrides = fieldOverrides[group.key] ?? {}
    const overrides: Record<string, unknown> = {}
    for (const [field, dealId] of Object.entries(fOverrides)) {
      const sourceDeal = group.deals.find(d => d.id === dealId)
      if (sourceDeal) overrides[field] = (sourceDeal as unknown as Record<string, unknown>)[field] ?? null
    }
    setMerging(group.key)
    try {
      const res = await fetch('/api/deals/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          primaryId: primary.id,
          secondaryIds: secondaries.map(d => d.id),
          overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
        }),
      })
      const data = await res.json()
      if (data.success) {
        setResultMsg(`Merged ${data.mergedFromCount} duplicate${data.mergedFromCount !== 1 ? 's' : ''} into ${primary.name}`)
        await fetchDeals()
      } else {
        setResultMsg(`Error: ${data.error || 'merge failed'}`)
      }
    } catch (e) {
      setResultMsg(`Error: ${String(e)}`)
    } finally {
      setMerging(null)
    }
  }

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
          <h1 className="text-2xl font-bold text-slate-900">Possible Duplicate Contacts</h1>
          <p className="text-slate-500 text-sm mt-0.5">
            Same person matched by email / phone / name. <strong>Review each before merging</strong> —
            a borrower&apos;s separate loans are intentionally kept as separate cards and are NOT shown here.
          </p>
        </div>
      </div>

      {resultMsg && (
        <div className={`border rounded-lg px-4 py-2.5 text-sm ${resultMsg.startsWith('Error') ? 'bg-red-50 border-red-200 text-red-900' : 'bg-emerald-50 border-emerald-200 text-emerald-900'}`}>
          {resultMsg}
        </div>
      )}

      {/* Top-line stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Stat label="Duplicate Groups" value={groups.length} color="amber" />
        <Stat label="Affected Deals" value={totalDealsInDupes} color="amber" />
        <Stat label="Would Remove" value={wouldRemove} color="red" hint="If you merged everything" />
        <Stat label="Total Deals" value={deals.length} color="slate" />
      </div>

      {/* Match-type filter */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-500">Match type:</span>
        <div className="flex bg-slate-100 rounded-lg p-1 gap-0.5">
          {(['all','email','phone','name'] as const).map(t => {
            const count = t === 'all' ? groups.length : groups.filter(g => g.matchType === t).length
            return (
              <button
                key={t}
                onClick={() => setFilterType(t)}
                className={`px-3 py-1 text-xs font-medium rounded-md transition ${filterType === t ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}
              >
                {t === 'all' ? 'All' : t.charAt(0).toUpperCase() + t.slice(1)} ({count})
              </button>
            )
          })}
        </div>
      </div>

      {filteredGroups.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
          <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto mb-3" />
          <p className="font-semibold text-slate-800">No duplicates found!</p>
          <p className="text-sm text-slate-500 mt-1">Every contact in your dashboard is unique.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredGroups.map(group => {
            const primary = getPrimaryFor(group)
            const isExpanded = expanded.has(group.key)
            return (
              <div key={group.key} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                {/* Group header */}
                <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex items-center gap-1.5 px-2 py-0.5 bg-amber-100 text-amber-800 rounded text-xs font-semibold">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      {group.deals.length} duplicates
                    </div>
                    <div className="flex items-center gap-1 text-xs text-slate-600 min-w-0">
                      {MATCH_LABELS[group.matchType].icon}
                      <span className="font-medium">{MATCH_LABELS[group.matchType].label}:</span>
                      <span className="truncate font-mono text-slate-800">{group.matchValue}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => setExpanded(prev => {
                        const next = new Set(prev)
                        if (next.has(group.key)) next.delete(group.key); else next.add(group.key)
                        return next
                      })}
                      className="text-xs text-slate-600 hover:text-slate-900 flex items-center gap-1"
                    >
                      {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                      {isExpanded ? 'Collapse' : 'Compare side by side'}
                    </button>
                    <button
                      onClick={() => mergeOne(group)}
                      disabled={merging !== null}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-emerald-600 rounded-md hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {merging === group.key ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GitMerge className="w-3.5 h-3.5" />}
                      Merge into "{primary.name.length > 22 ? primary.name.slice(0, 22) + '…' : primary.name}"
                    </button>
                  </div>
                </div>

                {/* Compact view: list of deals with the primary highlighted */}
                {!isExpanded && (
                  <div className="divide-y divide-slate-100">
                    {group.deals.map(d => {
                      const isPrimary = d.id === primary.id
                      return (
                        <div key={d.id} className="flex items-center gap-3 px-5 py-2.5 text-sm hover:bg-slate-50">
                          <button
                            onClick={() => setPrimaryOverrides(prev => ({ ...prev, [group.key]: d.id }))}
                            className={`shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center ${isPrimary ? 'border-emerald-500 bg-emerald-500' : 'border-slate-300'}`}
                            title={isPrimary ? 'Primary (keep this one)' : 'Make primary'}
                          >
                            {isPrimary && <div className="w-1.5 h-1.5 bg-white rounded-full" />}
                          </button>
                          <div className="flex-1 min-w-0 grid grid-cols-2 md:grid-cols-5 gap-3 items-center">
                            <Link href={`/deals/${d.id}`} className="font-semibold text-slate-900 hover:text-blue-700 truncate">
                              {d.name}
                            </Link>
                            <span className="text-xs text-slate-500 truncate">{d.status} · {d.pipeline_group}</span>
                            <span className="text-xs text-slate-500 truncate">{d.loan_officer || '—'}</span>
                            <span className="text-xs text-slate-700 tabular-nums">{d.loan_amount ? formatCurrency(d.loan_amount) : '—'}</span>
                            <span className="text-xs text-slate-400">
                              {completenessScore(d)}/{SCORE_FIELDS.length} fields
                            </span>
                          </div>
                          {isPrimary && <span className="shrink-0 text-[10px] font-bold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">PRIMARY</span>}
                          <Link href={`/deals/${d.id}`} className="shrink-0 text-slate-400 hover:text-blue-600">
                            <ExternalLink className="w-3.5 h-3.5" />
                          </Link>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Expanded comparison — click any cell to pick that value as the merged result */}
                {isExpanded && (
                  <>
                    <div className="px-5 py-2 bg-blue-50 border-b border-blue-200 text-xs text-blue-900">
                      <strong>Tip:</strong> Each row shows the same field across all duplicates.
                      The cell highlighted in green will be kept after merge. Click any other cell to pick its value instead.
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                          <tr>
                            <th className="text-left px-4 py-2 sticky left-0 bg-slate-50">Field</th>
                            {group.deals.map(d => (
                              <th key={d.id} className={`text-left px-4 py-2 min-w-[160px] ${d.id === primary.id ? 'bg-emerald-50' : ''}`}>
                                <div className="flex items-center gap-2">
                                  <button
                                    onClick={() => setPrimaryOverrides(prev => ({ ...prev, [group.key]: d.id }))}
                                    className={`shrink-0 w-3.5 h-3.5 rounded-full border-2 ${d.id === primary.id ? 'border-emerald-500 bg-emerald-500' : 'border-slate-300'}`}
                                    title={d.id === primary.id ? 'Primary' : 'Make primary'}
                                  />
                                  <Link href={`/deals/${d.id}`} className="text-slate-900 normal-case font-semibold hover:text-blue-700 truncate">{d.name}</Link>
                                </div>
                                {d.id === primary.id && <span className="text-[10px] font-bold text-emerald-700">PRIMARY (default winner)</span>}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {(['status','pipeline_group','loan_officer','loan_type','loan_amount','property_address','credit_score','rate','investor','email','phone','lock_expiration','signing_date','funded_date','source','arive_file_no'] as Array<keyof Deal>).map(field => {
                            const values = group.deals.map(d => d[field])
                            const allSame = values.every(v => String(v ?? '') === String(values[0] ?? ''))

                            // Compute the "winning" deal for this field:
                            // 1. User override wins if set
                            // 2. Else: primary if non-blank
                            // 3. Else: first non-blank secondary
                            const overrideId = fieldOverrides[group.key]?.[String(field)]
                            let winnerId: string | null = null
                            if (overrideId && group.deals.find(d => d.id === overrideId)) {
                              winnerId = overrideId
                            } else if (!isBlank(primary[field])) {
                              winnerId = primary.id
                            } else {
                              const sortedSecs = group.deals.filter(d => d.id !== primary.id)
                                .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
                              const firstNonBlank = sortedSecs.find(d => !isBlank(d[field]))
                              if (firstNonBlank) winnerId = firstNonBlank.id
                            }

                            return (
                              <tr key={String(field)} className={allSame ? '' : 'bg-amber-50/40'}>
                                <td className="px-4 py-1.5 text-xs font-medium text-slate-500 capitalize sticky left-0 bg-inherit">{String(field).replace(/_/g, ' ')}</td>
                                {group.deals.map(d => {
                                  const v = d[field]
                                  const blank = v === null || v === undefined || v === ''
                                  const display = blank ? '—' :
                                    typeof v === 'number' && (field === 'loan_amount' || field === 'estimated_value') ? formatCurrency(v) :
                                    String(v)
                                  const isWinner = d.id === winnerId
                                  const clickable = !blank && !allSame
                                  return (
                                    <td
                                      key={d.id}
                                      onClick={() => {
                                        if (!clickable) return
                                        setFieldOverrides(prev => ({
                                          ...prev,
                                          [group.key]: { ...(prev[group.key] ?? {}), [String(field)]: d.id },
                                        }))
                                      }}
                                      className={`px-4 py-1.5 text-xs transition ${
                                        isWinner
                                          ? 'bg-emerald-100 text-slate-900 font-semibold ring-1 ring-emerald-400 ring-inset'
                                          : blank
                                          ? 'text-slate-300'
                                          : 'text-slate-700'
                                      } ${clickable && !isWinner ? 'cursor-pointer hover:bg-blue-50' : ''}`}
                                      title={clickable && !isWinner ? 'Click to use this value' : undefined}
                                    >
                                      {display}
                                      {isWinner && !blank && <span className="ml-1.5 text-[9px] text-emerald-700">✓ KEEP</span>}
                                    </td>
                                  )
                                })}
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, color, hint }: { label: string; value: number; color: 'amber' | 'red' | 'slate'; hint?: string }) {
  const colors = {
    amber: 'text-amber-600',
    red: 'text-red-600',
    slate: 'text-slate-700',
  }
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5">
      <p className="text-xs font-medium uppercase text-slate-500 tracking-wide">{label}</p>
      <p className={`text-3xl font-bold mt-2 ${colors[color]}`}>{value}</p>
      {hint && <p className="text-xs text-slate-400 mt-1">{hint}</p>}
    </div>
  )
}
