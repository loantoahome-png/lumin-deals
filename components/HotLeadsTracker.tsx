'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Deal, LOAN_OFFICERS, PIPELINE_STATUSES } from '@/lib/types'
import { formatCurrency, dndLabel } from '@/lib/utils'
import { ghlContactUrl } from '@/lib/ghlLinks'
import {
  ExternalLink, Calendar, Clock, Flame, Search, MoreHorizontal,
  LayoutGrid, List as ListIcon, ArrowDownLeft, ArrowUpRight,
} from 'lucide-react'

const MS_PER_DAY = 86_400_000

// Status → pipeline_group lookup for bulk stage moves. Funded statuses iterate
// last so they win the group assignment for the three shared statuses.
const STATUS_TO_GROUP: Record<string, string> = (() => {
  const m: Record<string, string> = {}
  for (const [group, statuses] of Object.entries(PIPELINE_STATUSES)) {
    for (const s of statuses) m[s] = group
  }
  return m
})()

// The two "hot" stages this workspace watches. Each gets its own badge color
// (matching STATUS_COLORS) and its own set of forward quick-actions.
const HOT_STATUSES = ['Pitching', 'App Intake'] as const
type HotStatus = (typeof HOT_STATUSES)[number]

const STAGE_BADGE: Record<HotStatus, string> = {
  'Pitching':   'bg-violet-100 text-violet-700 border border-violet-200',
  'App Intake': 'bg-cyan-100 text-cyan-700 border border-cyan-200',
}

// ── Age buckets (visual only — never written to the DB) ─────────────────────
// Cards group by how long they've sat in the current stage. stage_changed_at is
// auto-updated by a Postgres trigger when status flips; we fall back to created_at.
type Bucket = {
  key: string
  label: string
  emoji: string
  maxDaysExclusive: number
  accent: string
  header: string
  hint: string
}
// Leads the borrower has never replied to — usually brand-new, not stale. Their
// own column so they don't get lumped in with cold (replied-then-went-quiet) leads.
const NO_REPLY_BUCKET: Bucket = {
  key: 'noreply', label: 'No reply yet', emoji: '🔵', maxDaysExclusive: 0,
  accent: 'bg-blue-500', header: 'bg-blue-50 border-blue-200',
  hint: "New — lead hasn't replied yet; make first contact",
}
// Time-based buckets, applied only to leads that HAVE replied at least once.
const TIME_BUCKETS: Bucket[] = [
  { key: 'fresh',   label: 'Fresh',   emoji: '🟢', maxDaysExclusive: 2,        accent: 'bg-emerald-500', header: 'bg-emerald-50 border-emerald-200', hint: 'Borrower replied recently — keep momentum' },
  { key: 'warm',    label: 'Warm',    emoji: '🟡', maxDaysExclusive: 4,        accent: 'bg-amber-500',   header: 'bg-amber-50 border-amber-200',     hint: "Borrower quiet a couple days — reach out" },
  { key: 'cooling', label: 'Cooling', emoji: '🟠', maxDaysExclusive: 8,        accent: 'bg-orange-500',  header: 'bg-orange-50 border-orange-200',   hint: 'No reply in 4+ days — at risk, call today' },
  { key: 'stale',   label: 'Stale',   emoji: '🔴', maxDaysExclusive: Infinity, accent: 'bg-red-500',     header: 'bg-red-50 border-red-200',         hint: 'Replied before, silent 8+ days — slipping away' },
]
const BUCKETS: Bucket[] = [NO_REPLY_BUCKET, ...TIME_BUCKETS]

// Pull a string timestamp out of the synced GHL opportunity blob.
function rawTs(deal: Deal, key: string): string | null {
  const raw = deal.raw_ghl_data as Record<string, unknown> | null | undefined
  const v = raw?.[key]
  return typeof v === 'string' ? v : null
}
// When the lead last moved stage. DB stage_changed_at is often null on leads,
// so fall back to GHL's lastStageChangeAt / lastStatusChangeAt, then lead age.
function stageSinceIso(deal: Deal): string | null {
  return deal.stage_changed_at || rawTs(deal, 'lastStageChangeAt') || rawTs(deal, 'lastStatusChangeAt')
    || deal.date_added_ghl || deal.created_at || null
}
// Last real communication (text/call/email), refreshed from GHL's Conversations
// API into last_communication_at. Falls back to the GHL opportunity's last-update
// time if comm data hasn't been refreshed for this lead yet.
function lastContactIso(deal: Deal): string | null {
  return deal.last_communication_at || rawTs(deal, 'updatedAt') || stageSinceIso(deal)
}
// Compact "2d 4h" / "5h 12m" / "8m" / "just now" formatter.
function compactAgo(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60), rm = m % 60
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`
  const d = Math.floor(h / 24), rh = h % 24
  return rh ? `${d}d ${rh}h` : `${d}d`
}

export function daysInStage(deal: Deal): number {
  const sinceIso = stageSinceIso(deal)
  if (!sinceIso) return 0
  return Math.max(0, Math.floor((Date.now() - new Date(sinceIso).getTime()) / MS_PER_DAY))
}
// Days since the last real communication (falls back to last GHL activity).
export function daysSinceContact(deal: Deal): number {
  const iso = deal.last_communication_at || lastContactIso(deal)
  if (!iso) return 999
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / MS_PER_DAY))
}
// Staleness (ms since) for a specific direction. Null (never contacted that way)
// → a huge sentinel so "longest since" sorts those to the very top.
const NEVER = Number.MAX_SAFE_INTEGER
function msSinceInbound(deal: Deal): number {
  return deal.last_inbound_at ? Date.now() - Date.parse(deal.last_inbound_at) : NEVER
}
function msSinceOutbound(deal: Deal): number {
  return deal.last_outbound_at ? Date.now() - Date.parse(deal.last_outbound_at) : NEVER
}
const COLD_DAYS = 14

// Sort modes for the Hot Leads list/board.
type SortMode = 'stage' | 'contact' | 'borrower' | 'us'
function compareBySort(a: Deal, b: Deal, mode: SortMode): number {
  switch (mode) {
    case 'borrower': return msSinceInbound(b) - msSinceInbound(a)   // longest since borrower wrote first
    case 'us':       return msSinceOutbound(b) - msSinceOutbound(a) // longest since we reached out first
    case 'contact':  return daysSinceContact(b) - daysSinceContact(a)
    case 'stage':
    default:         return daysInStage(b) - daysInStage(a)
  }
}
function getBucket(deal: Deal): Bucket {
  // No inbound ever → "No reply yet" (likely a new lead, not a stale one).
  if (!deal.last_inbound_at) return NO_REPLY_BUCKET
  // Otherwise bucket by days since the borrower last reached out.
  const d = msSinceInbound(deal) / MS_PER_DAY
  return TIME_BUCKETS.find(b => d < b.maxDaysExclusive)!
}

// ── Quick-advance targets — depend on the lead's CURRENT stage ───────────────
type Advance = { status: string; label: string; title: string; group: string; color: string }
const FORWARD_BY_STATUS: Record<HotStatus, Advance[]> = {
  // From Pitching: push into application, or close out.
  'Pitching': [
    { status: 'App Intake',            label: 'App Intake', title: 'Move to App Intake',           group: 'Leads',     color: 'bg-cyan-100 hover:bg-cyan-200 text-cyan-800 border border-cyan-200' },
    { status: 'Ghosted',               label: 'Ghosted',    title: 'Mark Ghosted',                 group: 'Leads',     color: 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200' },
    { status: 'Not Ready - Timeframe', label: 'Not Ready',  title: 'Move to Not Ready - Timeframe', group: 'Not Ready', color: 'bg-orange-100 hover:bg-orange-200 text-orange-800 border border-orange-200' },
  ],
  // From App Intake: convert into the loan, pre-approve, or close out.
  'App Intake': [
    { status: 'Loan Setup',            label: 'Loan Setup', title: 'Convert → Loan Setup (Loans in Process)', group: 'Loans in Process', color: 'bg-emerald-100 hover:bg-emerald-200 text-emerald-800 border border-emerald-200' },
    { status: 'Pre-Approved',          label: 'Pre-Approved', title: 'Move to Pre-Approved',        group: 'Leads',     color: 'bg-teal-100 hover:bg-teal-200 text-teal-800 border border-teal-200' },
    { status: 'Ghosted',               label: 'Ghosted',    title: 'Mark Ghosted',                 group: 'Leads',     color: 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200' },
  ],
}

type OtherOption = { status: string; label: string; group: string }
type OtherSection = { heading: string; options: OtherOption[] }
const OTHER_SECTIONS: OtherSection[] = [
  {
    heading: 'Forward',
    options: [
      { status: 'Appointment Booked', label: 'Appointment Booked', group: 'Leads' },
      { status: 'Qualification',      label: 'Qualification',      group: 'Leads' },
      { status: 'Pre-Approved',       label: 'Pre-Approved',       group: 'Leads' },
      { status: 'Arive Lead',         label: 'Arive Lead',         group: 'Leads' },
      { status: 'Loan Setup',         label: 'Loan Setup → in process', group: 'Loans in Process' },
    ],
  },
  {
    heading: 'Back to nurture',
    options: [
      { status: 'Pitching',          label: 'Pitching',          group: 'Leads' },
      { status: 'Responded',         label: 'Responded',         group: 'Leads' },
      { status: 'Attempted Contact', label: 'Attempted Contact', group: 'Leads' },
    ],
  },
  {
    heading: 'Not Ready / lost',
    options: [
      { status: 'Not Ready - Rate',       label: 'Not Ready - Rate',       group: 'Not Ready' },
      { status: 'Not Qualified - Credit', label: 'Not Qualified - Credit', group: 'Not Ready' },
      { status: 'Not Qualified - Income', label: 'Not Qualified - Income', group: 'Not Ready' },
      { status: 'DND - SMS',              label: 'DND - SMS',              group: 'Not Ready' },
      { status: 'Lost to Competitor',     label: 'Lost to Competitor',     group: 'Not Ready' },
      { status: 'Non-Responsive',         label: 'Non-Responsive',         group: 'Not Ready' },
      { status: 'STOP',                   label: 'STOP',                   group: 'Not Ready' },
    ],
  },
]

type Props = {
  deals: Deal[]
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>
}

// Purchased lead vendors (we pay per lead). Everything else — Self Source,
// Return Client, referrals, etc. — counts as self-sourced/organic.
const PAID_SOURCES = new Set(['FRU', 'Lendgo', 'LMB', 'LeadPoint', 'OwnUp', 'Lending Tree', 'Advertisements'])
function isPaidLead(d: Deal): boolean {
  return PAID_SOURCES.has((d.source ?? '').trim())
}

export default function HotLeadsTracker({ deals, onUpdate }: Props) {
  const [search, setSearch] = useState('')
  const [stageFilter, setStageFilter] = useState<'all' | HotStatus>('all')
  const [riskFilter, setRiskFilter] = useState<'all' | 'waiting' | 'cold'>('all')
  const [sourceFilter, setSourceFilter] = useState<'all' | 'paid' | 'self'>('all')
  const [sortBy, setSortBy] = useState<SortMode>('contact')
  const [view, setView] = useState<'board' | 'list'>('board')

  const filtered = useMemo(() => {
    let result = deals
    if (stageFilter !== 'all') result = result.filter(d => d.status === stageFilter)
    if (riskFilter === 'waiting') result = result.filter(d => (d.comm_unread_count ?? 0) > 0)
    else if (riskFilter === 'cold') result = result.filter(d => daysSinceContact(d) >= COLD_DAYS)
    if (sourceFilter === 'paid') result = result.filter(d => isPaidLead(d))
    else if (sourceFilter === 'self') result = result.filter(d => !isPaidLead(d))
    if (search.trim()) {
      const q = search.toLowerCase().trim()
      result = result.filter(d => {
        const hay = [d.name, d.loan_officer, d.email, d.phone, d.property_address]
          .filter(Boolean).join(' ').toLowerCase()
        return hay.includes(q)
      })
    }
    return result
  }, [deals, search, stageFilter, riskFilter, sourceFilter])

  // Group by age bucket; within each, sort by the chosen key (most urgent on top).
  const byBucket: Record<string, Deal[]> = {}
  for (const b of BUCKETS) byBucket[b.key] = []
  for (const d of filtered) byBucket[getBucket(d).key].push(d)
  for (const k of Object.keys(byBucket)) {
    byBucket[k].sort((a, b) => compareBySort(a, b, sortBy))
  }

  // Flat, sorted list for the table view (uses the same filters as the board).
  const sortedFlat = useMemo(() => {
    const arr = [...filtered]
    arr.sort((a, b) => compareBySort(a, b, sortBy))
    return arr
  }, [filtered, sortBy])

  const pitchingCount = deals.filter(d => d.status === 'Pitching').length
  const appIntakeCount = deals.filter(d => d.status === 'App Intake').length
  const waitingCount = deals.filter(d => (d.comm_unread_count ?? 0) > 0).length
  const coldCount = deals.filter(d => daysSinceContact(d) >= COLD_DAYS).length
  const paidCount = deals.filter(d => isPaidLead(d)).length
  const selfCount = deals.length - paidCount
  // All leads currently waiting on us (ignores filters — always the true count).
  const waitingLeads = deals.filter(d => (d.comm_unread_count ?? 0) > 0)

  if (deals.length === 0) {
    return (
      <div className="p-4">
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
          <Flame className="w-10 h-10 text-orange-400 mx-auto mb-2" />
          <p className="text-sm font-semibold text-slate-800">No hot leads right now</p>
          <p className="text-xs text-slate-500 mt-1">Leads in Pitching or App Intake will show up here.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 space-y-3">
      {/* Waiting-on-us banner — leads where the client messaged and we haven't replied */}
      {waitingLeads.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-red-800">
              ⏳ {waitingLeads.length} {waitingLeads.length === 1 ? 'lead is' : 'leads are'} waiting on a reply
            </span>
            <div className="flex items-center gap-1.5 flex-wrap">
              {waitingLeads.slice(0, 8).map(d => (
                <Link
                  key={d.id}
                  href={`/deals/${d.id}`}
                  className="text-xs font-semibold text-red-700 bg-white border border-red-200 rounded-full px-2.5 py-0.5 hover:bg-red-100 transition-colors flex items-center gap-1"
                  title={`${d.comm_unread_count} unread · ${d.status}`}
                >
                  {d.name}
                  <span className="text-[10px] font-bold text-red-500 tabular-nums">{d.comm_unread_count}</span>
                </Link>
              ))}
              {waitingLeads.length > 8 && (
                <span className="text-xs text-red-600">+{waitingLeads.length - 8} more</span>
              )}
            </div>
            {riskFilter !== 'waiting' && (
              <button
                onClick={() => setRiskFilter('waiting')}
                className="ml-auto text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg px-3 py-1.5"
              >
                Show only these
              </button>
            )}
          </div>
        </div>
      )}

      {/* Stage + risk filter chips, view toggle, sort toggle, search */}
      <div className="flex items-center gap-2 flex-wrap">
        <FilterChip active={stageFilter === 'all'} onClick={() => setStageFilter('all')}>
          All <span className="opacity-60 tabular-nums">{deals.length}</span>
        </FilterChip>
        <FilterChip active={stageFilter === 'Pitching'} onClick={() => setStageFilter('Pitching')} color="violet">
          Pitching <span className="opacity-70 tabular-nums">{pitchingCount}</span>
        </FilterChip>
        <FilterChip active={stageFilter === 'App Intake'} onClick={() => setStageFilter('App Intake')} color="cyan">
          App Intake <span className="opacity-70 tabular-nums">{appIntakeCount}</span>
        </FilterChip>

        <span className="w-px h-5 bg-slate-200 mx-0.5" />

        <FilterChip active={riskFilter === 'waiting'} onClick={() => setRiskFilter(riskFilter === 'waiting' ? 'all' : 'waiting')} color="red">
          ⏳ Waiting {waitingCount > 0 && <span className="font-bold tabular-nums">{waitingCount}</span>}
        </FilterChip>
        <FilterChip active={riskFilter === 'cold'} onClick={() => setRiskFilter(riskFilter === 'cold' ? 'all' : 'cold')} color="sky">
          ❄ Cold 14d+ {coldCount > 0 && <span className="font-bold tabular-nums">{coldCount}</span>}
        </FilterChip>

        <span className="w-px h-5 bg-slate-200 mx-0.5" />

        <FilterChip active={sourceFilter === 'paid'} onClick={() => setSourceFilter(sourceFilter === 'paid' ? 'all' : 'paid')} color="emerald">
          💲 Paid <span className="opacity-70 tabular-nums">{paidCount}</span>
        </FilterChip>
        <FilterChip active={sourceFilter === 'self'} onClick={() => setSourceFilter(sourceFilter === 'self' ? 'all' : 'self')} color="indigo">
          🌱 Self-Sourced <span className="opacity-70 tabular-nums">{selfCount}</span>
        </FilterChip>

        <div className="ml-auto flex items-center gap-2">
          {/* Board / List view toggle */}
          <div className="flex items-center bg-slate-100 rounded-lg p-0.5">
            <button
              onClick={() => setView('board')}
              className={`flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-md transition-colors ${
                view === 'board' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <LayoutGrid className="w-3.5 h-3.5" /> Board
            </button>
            <button
              onClick={() => setView('list')}
              className={`flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-md transition-colors ${
                view === 'list' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <ListIcon className="w-3.5 h-3.5" /> List
            </button>
          </div>
          <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Sort</label>
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value as SortMode)}
            className="text-sm border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            title="Order cards within each column"
          >
            <option value="stage">Time in stage</option>
            <option value="contact">Longest since any contact</option>
            <option value="borrower">Longest since borrower contact</option>
            <option value="us">Longest since our contact</option>
          </select>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search name, LO, email, phone…"
              className="pl-9 pr-3 py-1.5 border border-slate-200 rounded-lg text-sm w-64 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
      </div>

      {/* Board view — bucket columns */}
      {view === 'board' ? (
        <div className="overflow-x-auto pb-2 -mx-4 px-4">
          <div className="flex gap-3 min-w-max">
            {BUCKETS.map(b => (
              <BucketColumn key={b.key} bucket={b} deals={byBucket[b.key]} onUpdate={onUpdate} />
            ))}
          </div>
        </div>
      ) : (
        <HotLeadList deals={sortedFlat} onUpdate={onUpdate} />
      )}
    </div>
  )
}

// ── List view ───────────────────────────────────────────────────────────────
function HotLeadList({ deals, onUpdate }: {
  deals: Deal[]
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkStatus, setBulkStatus] = useState('')
  const [applying, setApplying] = useState(false)

  const allSelected = deals.length > 0 && deals.every(d => selected.has(d.id))
  const someSelected = deals.some(d => selected.has(d.id))
  const selectedCount = deals.filter(d => selected.has(d.id)).length

  function toggleAll() {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(deals.map(d => d.id)))
  }
  function toggleOne(id: string) {
    setSelected(prev => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id); else n.add(id)
      return n
    })
  }
  async function applyBulk() {
    if (!bulkStatus || selectedCount === 0) return
    const ids = deals.filter(d => selected.has(d.id)).map(d => d.id)
    if (!confirm(`Move ${ids.length} lead${ids.length === 1 ? '' : 's'} to "${bulkStatus}"?`)) return
    setApplying(true)
    const group = STATUS_TO_GROUP[bulkStatus]
    for (const id of ids) {
      await onUpdate(id, group ? { status: bulkStatus, pipeline_group: group } : { status: bulkStatus })
    }
    setApplying(false)
    setSelected(new Set())
    setBulkStatus('')
  }

  if (deals.length === 0) {
    return <p className="text-center text-sm text-slate-400 py-10">No leads match the current filters.</p>
  }
  return (
    <div className="space-y-2">
      {/* Bulk action bar */}
      {selectedCount > 0 && (
        <div className="sticky top-0 z-10 flex items-center gap-3 bg-slate-900 text-white rounded-xl px-4 py-2.5 shadow-lg flex-wrap">
          <span className="text-sm font-semibold tabular-nums">{selectedCount} selected</span>
          <span className="text-slate-400 text-sm">Move to stage:</span>
          <select
            value={bulkStatus}
            onChange={e => setBulkStatus(e.target.value)}
            className="text-sm rounded-lg px-2.5 py-1.5 text-slate-800 bg-white focus:outline-none focus:ring-2 focus:ring-blue-400"
          >
            <option value="">Pick a stage…</option>
            {Object.entries(PIPELINE_STATUSES).map(([group, statuses]) => (
              <optgroup key={group} label={group}>
                {statuses.map(s => <option key={`${group}:${s}`} value={s}>{s}</option>)}
              </optgroup>
            ))}
          </select>
          <button
            onClick={applyBulk}
            disabled={!bulkStatus || applying}
            className="text-sm font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-40 rounded-lg px-3 py-1.5"
          >
            {applying ? 'Applying…' : 'Apply'}
          </button>
          <button onClick={() => setSelected(new Set())} className="ml-auto text-sm text-slate-300 hover:text-white">
            Clear selection
          </button>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
              <th className="px-3 py-2.5 w-8">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={el => { if (el) el.indeterminate = someSelected && !allSelected }}
                  onChange={toggleAll}
                  className="rounded accent-blue-600 cursor-pointer"
                  title="Select all"
                />
              </th>
              <th className="px-3 py-2.5 w-4"></th>
              <th className="px-3 py-2.5">Lead</th>
              <th className="px-3 py-2.5">Stage</th>
              <th className="px-3 py-2.5">LO</th>
              <th className="px-3 py-2.5">Loan type</th>
              <th className="px-3 py-2.5 text-right">Amount</th>
              <th className="px-3 py-2.5 text-right">In stage</th>
              <th className="px-3 py-2.5 text-right" title="Last time the borrower reached out (inbound)">Borrower last</th>
              <th className="px-3 py-2.5 text-right" title="Last time we reached out (outbound)">You last</th>
              <th className="px-3 py-2.5 text-center">Move to →</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {deals.map(d => (
              <HotLeadRow key={d.id} deal={d} onUpdate={onUpdate} selected={selected.has(d.id)} onToggle={() => toggleOne(d.id)} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function HotLeadRow({ deal, onUpdate, selected, onToggle }: {
  deal: Deal
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>
  selected: boolean
  onToggle: () => void
}) {
  const stage = (HOT_STATUSES as readonly string[]).includes(deal.status) ? (deal.status as HotStatus) : 'Pitching'
  const bucket = getBucket(deal)
  const waiting = (deal.comm_unread_count ?? 0) > 0
  const inboundMs  = deal.last_inbound_at  ? Date.parse(deal.last_inbound_at)  : 0
  const outboundMs = deal.last_outbound_at ? Date.parse(deal.last_outbound_at) : 0
  // Borrower reached out more recently than we did → the ball is in our court.
  const borrowerWaiting = inboundMs > 0 && inboundMs > outboundMs
  const ghlUrl = ghlContactUrl(deal)
  const forwardButtons = FORWARD_BY_STATUS[stage]
  const loanTypeLabel = deal.loan_type || deal.loan_purpose || '—'
  function advanceTo(status: string, group?: string) {
    const patch: Record<string, unknown> = { status }
    if (group) patch.pipeline_group = group
    onUpdate(deal.id, patch)
  }
  return (
    <tr className={`transition-colors ${selected ? 'bg-blue-50/70' : 'hover:bg-slate-50/60'}`}>
      <td className="px-3 py-2.5">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="rounded accent-blue-600 cursor-pointer"
        />
      </td>
      <td className="px-3 py-2.5">
        <span className={`block w-2 h-2 rounded-full ${bucket.accent}`} title={bucket.label} />
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <Link href={`/deals/${deal.id}`} className="font-semibold text-slate-900 hover:text-blue-700 truncate">
            {deal.name}
          </Link>
          {ghlUrl && (
            <a href={ghlUrl} target="_blank" rel="noopener noreferrer"
              className="shrink-0 text-[9px] font-bold text-blue-700 hover:text-blue-900 px-1 py-0.5 rounded bg-blue-100 border border-blue-200">
              GHL
            </a>
          )}
          {waiting && (
            <span className="shrink-0 text-[9px] font-bold text-red-700 bg-red-100 border border-red-200 rounded-full px-1.5 py-0.5" title={`${deal.comm_unread_count} unread`}>
              ⏳ {deal.comm_unread_count}
            </span>
          )}
          {dndLabel(deal) && (
            <span className="shrink-0 text-[9px] font-bold text-rose-700 bg-rose-100 border border-rose-300 rounded-full px-1.5 py-0.5" title="Do Not Contact — opted out of one or more channels in GHL">
              🚫 {dndLabel(deal)}
            </span>
          )}
        </div>
      </td>
      <td className="px-3 py-2.5">
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${STAGE_BADGE[stage]}`}>{stage}</span>
      </td>
      <td className="px-3 py-2.5 text-slate-600 truncate max-w-[120px]">{deal.loan_officer || '—'}</td>
      <td className="px-3 py-2.5 text-slate-600">{loanTypeLabel}</td>
      <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{deal.loan_amount ? formatCurrency(deal.loan_amount) : '—'}</td>
      <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{compactAgo(stageSinceIso(deal))}</td>
      {/* Borrower last (inbound) — red when they're the most recent to reach out */}
      <td className={`px-3 py-2.5 text-right tabular-nums whitespace-nowrap ${borrowerWaiting ? 'text-red-600 font-semibold' : 'text-slate-700'}`}>
        {deal.last_inbound_at ? `${compactAgo(deal.last_inbound_at)} ago` : '—'}
      </td>
      {/* You last (outbound) */}
      <td className="px-3 py-2.5 text-right tabular-nums text-slate-700 whitespace-nowrap">
        {deal.last_outbound_at ? `${compactAgo(deal.last_outbound_at)} ago` : '—'}
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center justify-center gap-1">
          {forwardButtons.map(opt => (
            <button
              key={opt.status}
              onClick={() => advanceTo(opt.status, opt.group)}
              className={`text-[10px] font-medium px-1.5 py-1 rounded transition-colors whitespace-nowrap ${opt.color}`}
              title={opt.title}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </td>
    </tr>
  )
}

function FilterChip({ active, onClick, color = 'slate', children }: {
  active: boolean
  onClick: () => void
  color?: 'slate' | 'violet' | 'cyan' | 'red' | 'sky' | 'emerald' | 'indigo'
  children: React.ReactNode
}) {
  const styles: Record<string, string> = {
    slate:   active ? 'bg-slate-900 text-white'   : 'bg-white border border-slate-200 text-slate-700 hover:border-slate-400',
    violet:  active ? 'bg-violet-600 text-white'  : 'bg-white border border-violet-200 text-violet-700 hover:border-violet-400',
    cyan:    active ? 'bg-cyan-600 text-white'    : 'bg-white border border-cyan-200 text-cyan-700 hover:border-cyan-400',
    red:     active ? 'bg-red-600 text-white'     : 'bg-white border border-red-200 text-red-700 hover:border-red-400',
    sky:     active ? 'bg-sky-600 text-white'     : 'bg-white border border-sky-200 text-sky-700 hover:border-sky-400',
    emerald: active ? 'bg-emerald-600 text-white' : 'bg-white border border-emerald-200 text-emerald-700 hover:border-emerald-400',
    indigo:  active ? 'bg-indigo-600 text-white'  : 'bg-white border border-indigo-200 text-indigo-700 hover:border-indigo-400',
  }
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors flex items-center gap-1.5 ${styles[color]}`}
    >
      {children}
    </button>
  )
}

function BucketColumn({ bucket, deals, onUpdate }: {
  bucket: Bucket
  deals: Deal[]
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>
}) {
  const totalVolume = deals.reduce((s, d) => s + (d.loan_amount || 0), 0)
  return (
    <div className="w-[420px] shrink-0 flex flex-col">
      <div className="bg-white rounded-t-xl border border-slate-200 border-b-0 overflow-hidden">
        <div className={`h-1 ${bucket.accent}`} />
        <div className="px-4 py-2.5">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-1.5">
              <span>{bucket.emoji}</span> {bucket.label}
            </h3>
            <span className="text-[11px] font-semibold text-slate-600 bg-slate-100 rounded-full px-2 py-0.5 tabular-nums">
              {deals.length}
            </span>
          </div>
          <p className="text-[10px] text-slate-500 mt-0.5">{bucket.hint}</p>
          {totalVolume > 0 && (
            <p className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
              {formatCurrency(totalVolume)} volume
            </p>
          )}
        </div>
      </div>
      <div className="border border-t-0 rounded-b-xl p-2 space-y-2 flex-1 min-h-[200px] bg-slate-50/60 border-slate-200">
        {deals.length === 0 ? (
          <p className="text-center text-[11px] italic py-6 text-slate-400">No leads here</p>
        ) : (
          deals.map(d => (
            <HotLeadCard key={d.id} deal={d} bucket={bucket} onUpdate={onUpdate} />
          ))
        )}
      </div>
    </div>
  )
}

function HotLeadCard({ deal, bucket, onUpdate }: {
  deal: Deal
  bucket: Bucket
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>
}) {
  const [nextStep, setNextStep]         = useState(deal.next_action || '')
  const [followUpDate, setFollowUpDate] = useState(deal.next_action_due ? deal.next_action_due.slice(0, 10) : '')
  const [followUpTime, setFollowUpTime] = useState(deal.next_action_due ? deal.next_action_due.slice(11, 16) : '')
  const [showMore, setShowMore]         = useState(false)

  // Directional contact timing: when the lead last reached out vs when we did.
  const inMs  = deal.last_inbound_at  ? Date.parse(deal.last_inbound_at)  : 0
  const outMs = deal.last_outbound_at ? Date.parse(deal.last_outbound_at) : 0
  const ballInOurCourt = inMs > 0 && inMs > outMs   // lead messaged more recently than we replied
  const waiting = (deal.comm_unread_count ?? 0) > 0
  const overdue = deal.next_action_due ? new Date(deal.next_action_due) < new Date() : false
  const ghlUrl = ghlContactUrl(deal)
  const stage = (HOT_STATUSES as readonly string[]).includes(deal.status) ? (deal.status as HotStatus) : 'Pitching'
  const forwardButtons = FORWARD_BY_STATUS[stage]
  const loanTypeLabel = deal.loan_type || deal.loan_purpose || '—'

  function commitNextStep() {
    const newVal = nextStep.trim() || null
    if ((deal.next_action || null) !== newVal) onUpdate(deal.id, { next_action: newVal })
  }
  function commitFollowUp(date: string, time: string) {
    if (!date) { onUpdate(deal.id, { next_action_due: null }); return }
    const iso = new Date(`${date}T${time || '09:00'}`).toISOString()
    onUpdate(deal.id, { next_action_due: iso })
  }
  function setQuickPreset(daysAhead: number, hour: number) {
    const d = new Date()
    d.setDate(d.getDate() + daysAhead)
    d.setHours(hour, 0, 0, 0)
    const pad = (n: number) => String(n).padStart(2, '0')
    setFollowUpDate(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
    setFollowUpTime(`${pad(hour)}:00`)
    onUpdate(deal.id, { next_action_due: d.toISOString() })
  }
  function clearFollowUp() {
    setFollowUpDate(''); setFollowUpTime('')
    onUpdate(deal.id, { next_action_due: null })
  }
  function advanceTo(status: string, group?: string) {
    const patch: Record<string, unknown> = { status }
    if (group) patch.pipeline_group = group
    onUpdate(deal.id, patch)
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      {/* Header (tinted to match column) */}
      <div className={`px-4 py-2.5 border-b flex items-center justify-between gap-2 ${bucket.header}`}>
        <div className="flex items-center gap-2 min-w-0">
          <Link
            href={`/deals/${deal.id}`}
            className="font-semibold text-base text-slate-900 hover:text-blue-700 truncate flex items-center gap-1 group"
            title="Open in dashboard"
          >
            {deal.name}
            <ExternalLink className="w-3.5 h-3.5 text-slate-300 group-hover:text-blue-500 opacity-0 group-hover:opacity-100 transition" />
          </Link>
          {ghlUrl && (
            <a
              href={ghlUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Open contact in GoHighLevel"
              className="shrink-0 flex items-center gap-0.5 text-[10px] font-bold text-blue-700 hover:text-blue-900 px-1.5 py-0.5 rounded bg-blue-100 hover:bg-blue-200 border border-blue-200 transition-colors"
            >
              GHL <ExternalLink className="w-2.5 h-2.5" />
            </a>
          )}
        </div>
        <span className={`inline-block shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full ${STAGE_BADGE[stage]}`}>
          {stage}
        </span>
      </div>

      {/* "Client waiting on us" — unanswered inbound messages. Top slip-risk. */}
      {waiting && (
        <div className="px-4 py-1.5 bg-red-50 border-b border-red-100 flex items-center gap-1.5">
          <span className="text-[11px] font-bold text-red-700">⏳ Client waiting on reply</span>
          <span className="text-[10px] font-semibold text-red-600 bg-red-100 rounded-full px-1.5 py-0.5 tabular-nums">
            {deal.comm_unread_count} unread
          </span>
        </div>
      )}

      {/* Timing strip — last contact FROM the lead vs last time WE reached out */}
      <div className="px-4 py-2 grid grid-cols-2 gap-2 border-b border-slate-100 bg-slate-50/40">
        <div className="flex items-center gap-1.5" title={deal.last_inbound_at ? `Lead last reached out ${new Date(deal.last_inbound_at).toLocaleString()}` : 'No inbound from the lead yet'}>
          <ArrowDownLeft className={`w-3.5 h-3.5 shrink-0 ${ballInOurCourt ? 'text-red-500' : 'text-slate-400'}`} />
          <div className="min-w-0">
            <p className="text-slate-400 uppercase tracking-wider text-[9px] font-semibold leading-none mb-0.5">From lead</p>
            <p className={`text-sm font-bold tabular-nums leading-tight ${ballInOurCourt ? 'text-red-600' : 'text-slate-800'}`}>
              {deal.last_inbound_at ? `${compactAgo(deal.last_inbound_at)} ago` : '—'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5" title={deal.last_outbound_at ? `We last reached out ${new Date(deal.last_outbound_at).toLocaleString()}` : 'We haven’t reached out yet'}>
          <ArrowUpRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          <div className="min-w-0">
            <p className="text-slate-400 uppercase tracking-wider text-[9px] font-semibold leading-none mb-0.5">We reached out</p>
            <p className="text-sm font-bold text-slate-800 tabular-nums leading-tight">
              {deal.last_outbound_at ? `${compactAgo(deal.last_outbound_at)} ago` : '—'}
            </p>
          </div>
        </div>
      </div>

      {/* Quick stats — LO · Loan type · Amount */}
      <div className="px-4 py-2.5 grid grid-cols-3 gap-2 text-xs border-b border-slate-100">
        <div className="min-w-0">
          <p className="text-slate-400 uppercase tracking-wider text-[9px] font-semibold leading-none mb-1">LO</p>
          <p className="text-slate-700 font-medium truncate">{deal.loan_officer || '—'}</p>
        </div>
        <div className="min-w-0">
          <p className="text-slate-400 uppercase tracking-wider text-[9px] font-semibold leading-none mb-1">Loan type</p>
          <p className="text-slate-700 font-medium truncate">{loanTypeLabel}</p>
        </div>
        <div>
          <p className="text-slate-400 uppercase tracking-wider text-[9px] font-semibold leading-none mb-1">Amount</p>
          <p className="text-slate-700 font-semibold tabular-nums">{deal.loan_amount ? formatCurrency(deal.loan_amount) : '—'}</p>
        </div>
      </div>

      {/* Next step + follow-up */}
      <div className="px-4 py-2.5 space-y-2.5">
        <div>
          <p className="text-slate-400 uppercase tracking-wider text-[9px] font-semibold mb-0.5 flex items-center gap-1">
            <Flame className="w-3 h-3 text-orange-500" /> Next step
          </p>
          <input
            value={nextStep}
            onChange={e => setNextStep(e.target.value)}
            onBlur={commitNextStep}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            placeholder="e.g. send pricing scenario"
            className="w-full text-sm border border-slate-200 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div>
          <p className="text-slate-400 uppercase tracking-wider text-[9px] font-semibold mb-0.5 flex items-center gap-1">
            <Calendar className="w-3 h-3 text-blue-500" /> Follow-up
          </p>
          <div className="flex items-center gap-1 mb-1.5 flex-wrap">
            <button onClick={() => setQuickPreset(0, 14)} className="text-[10px] px-1.5 py-0.5 bg-slate-100 hover:bg-slate-200 rounded text-slate-700">Today 2p</button>
            <button onClick={() => setQuickPreset(1, 9)}  className="text-[10px] px-1.5 py-0.5 bg-slate-100 hover:bg-slate-200 rounded text-slate-700">Tmrw 9a</button>
            <button onClick={() => setQuickPreset(2, 9)}  className="text-[10px] px-1.5 py-0.5 bg-slate-100 hover:bg-slate-200 rounded text-slate-700">+2 days</button>
            {deal.next_action_due && (
              <button onClick={clearFollowUp} className="text-[10px] px-1.5 py-0.5 bg-red-50 hover:bg-red-100 text-red-700 rounded ml-auto">Clear</button>
            )}
          </div>
          <div className="flex items-center gap-1">
            <input
              type="date"
              value={followUpDate}
              onChange={e => { setFollowUpDate(e.target.value); commitFollowUp(e.target.value, followUpTime) }}
              className="flex-1 text-xs border border-slate-200 rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <input
              type="time"
              value={followUpTime}
              onChange={e => { setFollowUpTime(e.target.value); commitFollowUp(followUpDate, e.target.value) }}
              className="w-24 text-xs border border-slate-200 rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          {deal.next_action_due && (
            <p className={`text-[10px] mt-1 ${overdue ? 'text-red-600 font-semibold' : 'text-slate-500'}`}>
              {overdue && '⚠ '}
              {new Date(deal.next_action_due).toLocaleString('en-US', {
                weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
              })}
            </p>
          )}
        </div>
      </div>

      {/* Quick-advance buttons (stage-aware) */}
      <div className="px-4 py-2.5 border-t border-slate-100 bg-slate-50/50">
        <p className="text-slate-400 uppercase tracking-wider text-[9px] font-semibold mb-1.5">Move to →</p>
        <div className="grid grid-cols-3 gap-1.5">
          {forwardButtons.map(opt => (
            <button
              key={opt.status}
              onClick={() => advanceTo(opt.status, opt.group)}
              className={`text-[11px] font-medium px-2 py-1.5 rounded transition-colors text-center ${opt.color}`}
              title={opt.title}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="relative mt-1">
          <button
            onClick={() => setShowMore(v => !v)}
            className="w-full text-[10px] text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded py-1 flex items-center justify-center gap-1"
          >
            <MoreHorizontal className="w-3 h-3" /> Other options
          </button>
          {showMore && (
            <div
              className="absolute bottom-full mb-1 left-0 right-0 bg-white border border-slate-200 rounded-md shadow-lg overflow-hidden z-10 max-h-72 overflow-y-auto"
              onMouseLeave={() => setShowMore(false)}
            >
              {OTHER_SECTIONS.map((section, i) => (
                <div key={section.heading} className={i > 0 ? 'border-t border-slate-100' : ''}>
                  <p className="text-[9px] font-semibold uppercase tracking-wider text-slate-400 px-3 pt-1.5 pb-0.5">
                    {section.heading}
                  </p>
                  {section.options.map(opt => (
                    <button
                      key={opt.status}
                      onClick={() => { advanceTo(opt.status, opt.group); setShowMore(false) }}
                      className="block w-full text-left text-[11px] px-3 py-1.5 hover:bg-slate-50 text-slate-700"
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export { LOAN_OFFICERS }
