'use client'

import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { Deal } from '@/lib/types'
import Link from 'next/link'
import {
  Loader2, Mail, Phone, User, GitMerge, AlertTriangle,
  CheckCircle2, ExternalLink, ChevronDown, ChevronUp, Sparkles,
} from 'lucide-react'
import { formatCurrency } from '@/lib/utils'

type MatchType = 'email' | 'phone' | 'name' | 'ghl_contact_id'

type DuplicateGroup = {
  key: string
  matchType: MatchType
  matchValue: string
  deals: Deal[]
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

// ── Detect duplicate groups ─────────────────────────────────────────────────
function detectDuplicates(deals: Deal[]): DuplicateGroup[] {
  const byEmail   = new Map<string, Deal[]>()
  const byPhone   = new Map<string, Deal[]>()
  const byName    = new Map<string, Deal[]>()
  const byGhlId   = new Map<string, Deal[]>()

  for (const d of deals) {
    const e = normEmail(d.email)
    if (e) (byEmail.get(e) ?? byEmail.set(e, []).get(e)!).push(d)
    const p = normPhone(d.phone)
    if (p) (byPhone.get(p) ?? byPhone.set(p, []).get(p)!).push(d)
    const n = normName(d.name)
    if (n) (byName.get(n) ?? byName.set(n, []).get(n)!).push(d)
    if (d.ghl_contact_id) (byGhlId.get(d.ghl_contact_id) ?? byGhlId.set(d.ghl_contact_id, []).get(d.ghl_contact_id)!).push(d)
  }

  // Build groups, deduping deals across detection methods (so a group of 3 isn't reported 3x)
  const seenGroupSignatures = new Set<string>()
  const groups: DuplicateGroup[] = []

  function addGroup(matchType: MatchType, matchValue: string, deals: Deal[]) {
    if (deals.length < 2) return
    const ids = deals.map(d => d.id).sort().join('|')
    if (seenGroupSignatures.has(ids)) return
    seenGroupSignatures.add(ids)
    groups.push({ key: `${matchType}:${matchValue}`, matchType, matchValue, deals })
  }

  for (const [v, ds] of byGhlId) addGroup('ghl_contact_id', v, ds)
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
  ghl_contact_id:  { label: 'Same GHL contact ID',  icon: <Sparkles className="w-3.5 h-3.5" /> },
}

export default function DuplicatesPage() {
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [merging, setMerging] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [primaryOverrides, setPrimaryOverrides] = useState<Record<string, string>>({}) // groupKey → dealId
  const [filterType, setFilterType] = useState<'all' | MatchType>('all')
  const [bulkMerging, setBulkMerging] = useState(false)
  const [resultMsg, setResultMsg] = useState<string | null>(null)

  async function fetchDeals() {
    setLoading(true)
    const { data } = await supabase.from('deals').select('*').order('updated_at', { ascending: false })
    setDeals((data as Deal[]) || [])
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
    setMerging(group.key)
    try {
      const res = await fetch('/api/deals/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ primaryId: primary.id, secondaryIds: secondaries.map(d => d.id) }),
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

  async function bulkAutoMerge() {
    if (!confirm(`Auto-merge all ${groups.length} duplicate groups? This will delete ${wouldRemove} deals (the lower-scoring duplicates) and merge their data into the primary deals. This cannot be undone.`)) {
      return
    }
    setBulkMerging(true)
    let success = 0, failed = 0
    for (const group of groups) {
      const primary = pickBestPrimary(group.deals)
      const secondaries = group.deals.filter(d => d.id !== primary.id)
      try {
        const res = await fetch('/api/deals/merge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ primaryId: primary.id, secondaryIds: secondaries.map(d => d.id) }),
        })
        const data = await res.json()
        if (data.success) success++; else failed++
      } catch { failed++ }
    }
    setResultMsg(`Bulk merge complete: ${success} succeeded, ${failed} failed`)
    setBulkMerging(false)
    await fetchDeals()
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
          <h1 className="text-2xl font-bold text-slate-900">Duplicate Contacts</h1>
          <p className="text-slate-500 text-sm mt-0.5">
            Find and merge contacts that exist multiple times across your sources.
          </p>
        </div>
        {groups.length > 0 && (
          <button
            onClick={bulkAutoMerge}
            disabled={bulkMerging}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
            title="Merges every group automatically by picking the most-complete deal as primary"
          >
            {bulkMerging ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            Auto-merge all ({groups.length})
          </button>
        )}
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
          {(['all','email','phone','name','ghl_contact_id'] as const).map(t => {
            const count = t === 'all' ? groups.length : groups.filter(g => g.matchType === t).length
            return (
              <button
                key={t}
                onClick={() => setFilterType(t)}
                className={`px-3 py-1 text-xs font-medium rounded-md transition ${filterType === t ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}
              >
                {t === 'all' ? 'All' : t === 'ghl_contact_id' ? 'GHL ID' : t.charAt(0).toUpperCase() + t.slice(1)} ({count})
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

                {/* Expanded comparison */}
                {isExpanded && (
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
                                />
                                <Link href={`/deals/${d.id}`} className="text-slate-900 normal-case font-semibold hover:text-blue-700 truncate">{d.name}</Link>
                              </div>
                              {d.id === primary.id && <span className="text-[10px] font-bold text-emerald-700">PRIMARY</span>}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {(['status','pipeline_group','loan_officer','loan_type','loan_amount','property_address','credit_score','rate','investor','email','phone','lock_expiration','signing_date','funded_date','source','arive_file_no'] as Array<keyof Deal>).map(field => {
                          const values = group.deals.map(d => d[field])
                          const allSame = values.every(v => String(v ?? '') === String(values[0] ?? ''))
                          return (
                            <tr key={String(field)} className={allSame ? '' : 'bg-amber-50/40'}>
                              <td className="px-4 py-1.5 text-xs font-medium text-slate-500 capitalize sticky left-0 bg-inherit">{String(field).replace(/_/g, ' ')}</td>
                              {group.deals.map(d => {
                                const v = d[field]
                                const display = v === null || v === undefined || v === '' ? '—' :
                                  typeof v === 'number' && (field === 'loan_amount' || field === 'estimated_value') ? formatCurrency(v) :
                                  String(v)
                                return (
                                  <td key={d.id} className={`px-4 py-1.5 text-xs ${d.id === primary.id ? 'bg-emerald-50/60 text-slate-900 font-medium' : 'text-slate-700'} ${v === null || v === undefined || v === '' ? 'text-slate-300' : ''}`}>
                                    {display}
                                  </td>
                                )
                              })}
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
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
