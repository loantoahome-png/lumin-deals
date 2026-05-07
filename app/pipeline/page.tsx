'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  DndContext, DragEndEvent, DragOverlay, DragStartEvent,
  PointerSensor, useSensor, useSensors, closestCorners,
} from '@dnd-kit/core'
import { useDroppable, useDraggable } from '@dnd-kit/core'
import { supabase } from '@/lib/supabase'
import { Deal, PIPELINE_STAGE_MAP, LOAN_STATUSES, STATUS_COLORS } from '@/lib/types'
import { formatCurrency } from '@/lib/utils'
import Link from 'next/link'
import { RefreshCw, Lock, Clock, AlertTriangle, ChevronDown, X, EyeOff, LayoutGrid, List, Bookmark, Trash2 } from 'lucide-react'

// ── Constants ─────────────────────────────────────────────────────────────────

const STAGE_ORDER = ['Leads', 'Escrows', 'Funded']

const STAGE_COLORS = {
  Leads:   { header: 'bg-slate-50 border-slate-300',     dot: 'bg-slate-400',   col: 'bg-slate-50/50' },
  Escrows: { header: 'bg-amber-50 border-amber-300',     dot: 'bg-amber-500',   col: 'bg-amber-50/30' },
  Funded:  { header: 'bg-emerald-50 border-emerald-300', dot: 'bg-emerald-500', col: 'bg-emerald-50/30' },
} as Record<string, { header: string; dot: string; col: string }>

const STAGE_DEFAULT_STATUS: Record<string, string> = {
  Leads:   'New Lead',
  Escrows: 'Loan Setup',
  Funded:  'Loan Funded',
}
const STAGE_DEFAULT_GROUP: Record<string, string> = {
  Leads:   'Leads',
  Escrows: 'Loans in Process',
  Funded:  'Funded',
}

// ── Escrow sub-sections (ordering + labels within the Escrows column) ─────────
const ESCROW_SUBGROUPS: { label: string; dot: string; statuses: Set<string> }[] = [
  { label: 'Processing',   dot: 'bg-blue-400',    statuses: new Set(['Loan Setup', 'Disclosed', 'Submitted to UW']) },
  { label: 'Underwriting', dot: 'bg-amber-500',   statuses: new Set(['Approved w/ Conditions', 'Re-Submittal']) },
  { label: 'Closing',      dot: 'bg-orange-500',  statuses: new Set(['Clear to Close', 'Docs Out', 'Docs Signed']) },
  { label: 'Funding',      dot: 'bg-emerald-500', statuses: new Set(['Loan Funded', 'Broker Check Received', 'Loan Finalized']) },
]
function escrowSubIndex(status: string): number {
  for (let i = 0; i < ESCROW_SUBGROUPS.length; i++) {
    if (ESCROW_SUBGROUPS[i].statuses.has(status)) return i
  }
  return 99
}

// ── Column ← pipeline_group mapping (with legacy fallback) ───────────────────
function getColumnForDeal(deal: Deal): string | null {
  const g = deal.pipeline_group
  // New values
  if (g === 'Leads') return 'Leads'
  if (g === 'Loans in Process') return 'Escrows'
  if (g === 'Funded') return 'Funded'
  // Legacy values (backwards compatibility with old DB records)
  if (g === 'LEADS') return 'Leads'
  if (g === 'Active Escrows' || g === 'Signing Scheduled') return 'Escrows'
  if (g === 'Closed') return 'Funded'
  return null // Not Ready, Lost, Nurture, etc. → hidden
}

// ── Source badge ──────────────────────────────────────────────────────────────
const SOURCE_STYLES: Record<string, string> = {
  'Self Source':  'bg-emerald-100 text-emerald-700',
  'Referral':     'bg-violet-100 text-violet-700',
  'Past Client':  'bg-amber-100 text-amber-700',
  'Open House':   'bg-sky-100 text-sky-700',
  'Agent Partner':'bg-rose-100 text-rose-700',
}

function SourceBadge({ deal }: { deal: Deal }) {
  const src = deal.source
  if (!src) return null
  const isGHL = !!deal.ghl_contact_id
  const style = isGHL
    ? 'bg-blue-100 text-blue-700'
    : (SOURCE_STYLES[src] || 'bg-slate-100 text-slate-600')
  const label = isGHL ? (src === 'GHL' ? 'GHL' : src) : src
  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide ${style}`}>
      {label}
    </span>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getDealAge(deal: Deal): number {
  const date = new Date(deal.updated_at || deal.created_at)
  return Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24))
}

function getLockDaysLeft(deal: Deal): number | null {
  if (!deal.lock_expiration || deal.locked !== 'Yes') return null
  const exp = new Date(deal.lock_expiration)
  return Math.floor((exp.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
}

// ── Droppable Column ──────────────────────────────────────────────────────────

function DroppableColumn({ stage, children, isOver }: {
  stage: string; children: React.ReactNode; isOver: boolean
}) {
  const { setNodeRef } = useDroppable({ id: stage })
  const c = STAGE_COLORS[stage]
  return (
    <div
      ref={setNodeRef}
      className={`flex flex-col gap-2 pt-2 overflow-y-auto max-h-[calc(100vh-220px)] rounded-b-xl transition-colors ${
        isOver ? 'ring-2 ring-blue-400 ring-inset bg-blue-50/50' : c?.col
      }`}
    >
      {children}
    </div>
  )
}

// ── Draggable Card ────────────────────────────────────────────────────────────

function DraggableCard({ deal, onStatusChange }: {
  deal: Deal; onStatusChange: (id: string, status: string) => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: deal.id })
  return (
    <div ref={setNodeRef} style={{ opacity: isDragging ? 0.35 : 1 }} {...listeners} {...attributes} className="touch-none">
      <DealCard deal={deal} onStatusChange={onStatusChange} />
    </div>
  )
}

// ── Deal Card ─────────────────────────────────────────────────────────────────

function DealCard({ deal, onStatusChange, ghost = false }: {
  deal: Deal; onStatusChange: (id: string, status: string) => void; ghost?: boolean
}) {
  const [showStatusMenu, setShowStatusMenu] = useState(false)
  const age = getDealAge(deal)
  const lockDays = getLockDaysLeft(deal)
  const statusClass = STATUS_COLORS[deal.status] || 'bg-gray-100 text-gray-600'
  const ageColor = age <= 7 ? 'text-emerald-600' : age <= 14 ? 'text-amber-600' : 'text-red-600'
  const ageBg    = age <= 7 ? 'bg-emerald-50'   : age <= 14 ? 'bg-amber-50'    : 'bg-red-50'
  const lockColor = lockDays === null ? '' : lockDays > 14 ? 'text-emerald-600' : lockDays > 7 ? 'text-amber-600' : 'text-red-600'
  const shortStatus = deal.status
    .replace('Signing Done - Waiting for Funding', 'Signing Done')
    .replace('Waiting on Docs from Client for final approval', 'Waiting on Docs')
    .replace('Figure - income verification or less', 'Figure - Income')

  return (
    <div className={`bg-white rounded-xl border border-slate-200 p-3.5 transition-all group relative ${
      ghost ? 'shadow-xl rotate-1 scale-105' : 'hover:border-blue-300 hover:shadow-md cursor-grab active:cursor-grabbing'
    }`}>
      {/* Lock expiry alerts */}
      {lockDays !== null && lockDays <= 7 && (
        <div className="flex items-center gap-1 text-xs text-red-600 bg-red-50 rounded-lg px-2 py-1 mb-2 font-medium">
          <Lock className="w-3 h-3" />Lock expires in {lockDays <= 0 ? 'EXPIRED' : `${lockDays}d`}!
        </div>
      )}
      {lockDays !== null && lockDays > 7 && lockDays <= 14 && (
        <div className="flex items-center gap-1 text-xs text-amber-600 bg-amber-50 rounded-lg px-2 py-1 mb-2 font-medium">
          <Lock className="w-3 h-3" />Lock expires in {lockDays}d
        </div>
      )}

      {/* Name + status */}
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <Link
          href={`/deals/${deal.id}`}
          onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}
          className="font-semibold text-slate-900 text-sm leading-tight hover:text-blue-700 transition-colors"
        >
          {deal.name}
        </Link>
        <div className="relative shrink-0">
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); setShowStatusMenu(v => !v) }}
            className={`text-xs px-1.5 py-0.5 rounded-md font-medium flex items-center gap-0.5 ${statusClass}`}
          >
            {shortStatus}<ChevronDown className="w-2.5 h-2.5" />
          </button>
          {showStatusMenu && (
            <div className="absolute right-0 top-full mt-1 z-50 bg-white rounded-xl shadow-xl border border-slate-200 py-1 w-56 max-h-72 overflow-y-auto" onMouseDown={e => e.stopPropagation()}>
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-100">
                <span className="text-xs font-semibold text-slate-500">Change Status</span>
                <button onClick={() => setShowStatusMenu(false)}><X className="w-3 h-3 text-slate-400" /></button>
              </div>
              {LOAN_STATUSES.map(s => (
                <button key={s} onClick={() => { onStatusChange(deal.id, s); setShowStatusMenu(false) }}
                  className={`w-full text-left text-xs px-3 py-1.5 hover:bg-slate-50 transition-colors ${s === deal.status ? 'font-semibold text-blue-600' : 'text-slate-700'}`}>
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Source badge */}
      <div className="mb-2"><SourceBadge deal={deal} /></div>

      {/* Loan details */}
      {(deal.loan_type || deal.loan_amount) && (
        <div className="flex items-center gap-1.5 mb-2 flex-wrap">
          {deal.loan_type && <span className="text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded font-medium">{deal.loan_type}</span>}
          {deal.loan_amount && <span className="text-xs font-semibold text-slate-700">{formatCurrency(deal.loan_amount)}</span>}
          {deal.ltv && <span className="text-xs text-slate-400">{deal.ltv.toFixed(0)}% LTV</span>}
        </div>
      )}

      {/* Credit + occupancy */}
      {(deal.credit_score || deal.credit_rating || deal.occupancy) && (
        <div className="flex items-center gap-2 text-xs text-slate-500 mb-1.5 flex-wrap">
          {deal.credit_score && <span>FICO: <strong className="text-slate-700">{deal.credit_score}</strong></span>}
          {deal.credit_rating && <span className="text-slate-400">({deal.credit_rating})</span>}
          {deal.occupancy && <span className="text-slate-400">{deal.occupancy}</span>}
        </div>
      )}

      {/* LO */}
      <div className="flex items-center text-xs text-slate-400 mt-2">
        <span className="font-medium">{deal.loan_officer || '—'}</span>
      </div>

      {/* Age + investor */}
      <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-100">
        <div className={`flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded-md ${ageBg} ${ageColor}`}>
          <Clock className="w-2.5 h-2.5" />
          {age === 0 ? 'Today' : `${age}d`}
        </div>
        {deal.investor && <span className="text-xs text-slate-400 truncate ml-2">{deal.investor}</span>}
        {deal.locked === 'Yes' && lockDays !== null && lockDays > 14 && (
          <div className={`flex items-center gap-0.5 text-xs ${lockColor}`}>
            <Lock className="w-2.5 h-2.5" />{lockDays}d
          </div>
        )}
      </div>
    </div>
  )
}

// ── List View ─────────────────────────────────────────────────────────────────

const STAGE_DOT: Record<string, string> = {
  Leads: 'bg-slate-400', Escrows: 'bg-amber-500', Funded: 'bg-emerald-500',
}

function ListView({ deals, onStatusChange }: {
  deals: Deal[]
  onStatusChange: (id: string, status: string) => void
}) {
  const [sortKey, setSortKey]   = useState<string>('name')
  const [sortDir, setSortDir]   = useState<'asc' | 'desc'>('asc')
  const [openMenu, setOpenMenu] = useState<string | null>(null)

  function toggleSort(key: string) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  const sorted = [...deals].sort((a, b) => {
    let av: string | number = '', bv: string | number = ''
    if (sortKey === 'name')        { av = a.name;                     bv = b.name }
    if (sortKey === 'stage')       { av = getColumnForDeal(a) || ''; bv = getColumnForDeal(b) || '' }
    if (sortKey === 'status')      { av = a.status;                   bv = b.status }
    if (sortKey === 'loan_officer'){ av = a.loan_officer || '';        bv = b.loan_officer || '' }
    if (sortKey === 'loan_amount') { av = a.loan_amount || 0;          bv = b.loan_amount || 0 }
    if (sortKey === 'loan_type')   { av = a.loan_type || '';           bv = b.loan_type || '' }
    if (sortKey === 'age')         { av = getDealAge(a);               bv = getDealAge(b) }
    const cmp = av < bv ? -1 : av > bv ? 1 : 0
    return sortDir === 'asc' ? cmp : -cmp
  })

  function Th({ label, k }: { label: string; k: string }) {
    const active = sortKey === k
    return (
      <th
        onClick={() => toggleSort(k)}
        className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3 cursor-pointer select-none whitespace-nowrap hover:text-slate-800 transition-colors"
      >
        <span className="flex items-center gap-1">
          {label}
          <span className={`text-[10px] ${active ? 'text-slate-700' : 'text-slate-300'}`}>
            {active ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}
          </span>
        </span>
      </th>
    )
  }

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
        <table className="w-full border-collapse">
          <thead className="bg-slate-50 border-b border-slate-200 sticky top-0 z-10">
            <tr>
              <Th label="Name" k="name" />
              <Th label="Stage" k="stage" />
              <Th label="Status" k="status" />
              <Th label="LO" k="loan_officer" />
              <Th label="Loan Type" k="loan_type" />
              <Th label="Amount" k="loan_amount" />
              <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3 whitespace-nowrap">LTV</th>
              <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3 whitespace-nowrap">FICO</th>
              <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3 whitespace-nowrap">Investor</th>
              <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3 whitespace-nowrap">Lock Exp</th>
              <Th label="Age" k="age" />
              <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3 whitespace-nowrap">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sorted.map(deal => {
              const stage    = getColumnForDeal(deal) || '—'
              const age      = getDealAge(deal)
              const lockDays = getLockDaysLeft(deal)
              const ageColor = age <= 7 ? 'text-emerald-600' : age <= 14 ? 'text-amber-600' : 'text-red-600'
              const lockColor = lockDays === null ? '' : lockDays <= 7 ? 'text-red-600' : lockDays <= 14 ? 'text-amber-600' : 'text-emerald-600'
              const statusClass = STATUS_COLORS[deal.status] || 'bg-gray-100 text-gray-600'
              const shortStatus = deal.status
                .replace('Signing Done - Waiting for Funding', 'Signing Done')
                .replace('Waiting on Docs from Client for final approval', 'Waiting on Docs')
                .replace('Figure - income verification or less', 'Figure - Income')

              return (
                <tr key={deal.id} className="hover:bg-slate-50 transition-colors group">
                  {/* Name */}
                  <td className="px-4 py-3 font-semibold text-slate-900 whitespace-nowrap">
                    <Link href={`/deals/${deal.id}`} className="hover:text-blue-700 transition-colors">
                      {deal.name}
                    </Link>
                  </td>

                  {/* Stage */}
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span className="flex items-center gap-1.5 text-xs text-slate-600">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${STAGE_DOT[stage] || 'bg-slate-300'}`} />
                      {stage}
                    </span>
                  </td>

                  {/* Status (editable) */}
                  <td className="px-4 py-3 whitespace-nowrap">
                    <div className="relative inline-block">
                      <button
                        onClick={() => setOpenMenu(openMenu === deal.id ? null : deal.id)}
                        className={`text-xs px-2 py-1 rounded-md font-medium flex items-center gap-0.5 ${statusClass}`}
                      >
                        {shortStatus}<ChevronDown className="w-2.5 h-2.5 ml-0.5" />
                      </button>
                      {openMenu === deal.id && (
                        <div className="absolute left-0 top-full mt-1 z-50 bg-white rounded-xl shadow-xl border border-slate-200 py-1 w-56 max-h-64 overflow-y-auto">
                          <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-100">
                            <span className="text-xs font-semibold text-slate-500">Change Status</span>
                            <button onClick={() => setOpenMenu(null)}><X className="w-3 h-3 text-slate-400" /></button>
                          </div>
                          {LOAN_STATUSES.map(s => (
                            <button key={s} onClick={() => { onStatusChange(deal.id, s); setOpenMenu(null) }}
                              className={`w-full text-left text-xs px-3 py-1.5 hover:bg-slate-50 transition-colors ${s === deal.status ? 'font-semibold text-blue-600' : 'text-slate-700'}`}>
                              {s}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </td>

                  {/* LO */}
                  <td className="px-4 py-3 text-sm text-slate-600 whitespace-nowrap">{deal.loan_officer || '—'}</td>

                  {/* Loan Type */}
                  <td className="px-4 py-3 whitespace-nowrap">
                    {deal.loan_type
                      ? <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded font-medium">{deal.loan_type}</span>
                      : <span className="text-slate-300">—</span>}
                  </td>

                  {/* Amount */}
                  <td className="px-4 py-3 text-sm font-semibold text-slate-800 whitespace-nowrap">
                    {deal.loan_amount ? formatCurrency(deal.loan_amount) : <span className="text-slate-300">—</span>}
                  </td>

                  {/* LTV */}
                  <td className="px-4 py-3 text-sm text-slate-500 whitespace-nowrap">
                    {deal.ltv ? `${deal.ltv.toFixed(0)}%` : <span className="text-slate-300">—</span>}
                  </td>

                  {/* FICO */}
                  <td className="px-4 py-3 text-sm text-slate-600 whitespace-nowrap">
                    {deal.credit_score || <span className="text-slate-300">—</span>}
                  </td>

                  {/* Investor */}
                  <td className="px-4 py-3 text-sm text-slate-500 whitespace-nowrap">
                    {deal.investor || <span className="text-slate-300">—</span>}
                  </td>

                  {/* Lock Exp */}
                  <td className="px-4 py-3 whitespace-nowrap">
                    {lockDays !== null ? (
                      <span className={`flex items-center gap-1 text-xs font-medium ${lockColor}`}>
                        <Lock className="w-3 h-3" />
                        {lockDays <= 0 ? 'EXPIRED' : `${lockDays}d`}
                      </span>
                    ) : <span className="text-slate-300 text-xs">—</span>}
                  </td>

                  {/* Age */}
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span className={`flex items-center gap-1 text-xs font-medium ${ageColor}`}>
                      <Clock className="w-3 h-3" />
                      {age === 0 ? 'Today' : `${age}d`}
                    </span>
                  </td>

                  {/* Source */}
                  <td className="px-4 py-3 whitespace-nowrap">
                    <SourceBadge deal={deal} />
                  </td>
                </tr>
              )
            })}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={12} className="px-4 py-12 text-center text-slate-400 text-sm">No deals match current filters</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Saved view type ───────────────────────────────────────────────────────────
type SavedView = {
  id: string
  name: string
  loFilter: string
  sourceFilter: string
  statusFilter: string
  hideFunded: boolean
  layoutView: 'board' | 'list'
}

const VIEWS_KEY = 'lumin_pipeline_views'

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function PipelinePage() {
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [loFilter, setLoFilter] = useState('All')
  const [sourceFilter, setSourceFilter] = useState('All')
  const [statusFilter, setStatusFilter] = useState('All')
  const [hideFunded, setHideFunded] = useState(false)
  const [layoutView, setLayoutView] = useState<'board' | 'list'>('board')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [savedViews, setSavedViews] = useState<SavedView[]>([])
  const [activeViewId, setActiveViewId] = useState<string | null>(null)
  const [showSaveModal, setShowSaveModal] = useState(false)
  const [newViewName, setNewViewName] = useState('')

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  const fetchDeals = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('deals')
      .select('*')
      .not('pipeline_group', 'in', '("Not Ready","Lost","Last files at WCL","Lost/Inactive/Does not qualify","Nurture")')
      .order('created_at', { ascending: false })
    setDeals(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { fetchDeals() }, [fetchDeals])

  // Load saved views from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(VIEWS_KEY)
      if (stored) setSavedViews(JSON.parse(stored))
    } catch { /* ignore */ }
  }, [])

  // Derived: unique sources + statuses from loaded deals
  const availableSources = ['All', ...Array.from(new Set(deals.map(d => d.source).filter(Boolean) as string[])).sort()]
  const availableStatuses = ['All', ...Array.from(new Set(deals.map(d => d.status).filter(Boolean))).sort()]

  // ── Saved view helpers ────────────────────────────────────────────────────
  function saveView() {
    if (!newViewName.trim()) return
    const view: SavedView = {
      id: Date.now().toString(),
      name: newViewName.trim(),
      loFilter, sourceFilter, statusFilter, hideFunded, layoutView,
    }
    const updated = [...savedViews, view]
    setSavedViews(updated)
    localStorage.setItem(VIEWS_KEY, JSON.stringify(updated))
    setNewViewName('')
    setShowSaveModal(false)
    setActiveViewId(view.id)
  }

  function loadView(view: SavedView) {
    setLoFilter(view.loFilter)
    setSourceFilter(view.sourceFilter)
    setStatusFilter(view.statusFilter)
    setHideFunded(view.hideFunded)
    setLayoutView(view.layoutView)
    setActiveViewId(view.id)
  }

  function deleteView(id: string) {
    const updated = savedViews.filter(v => v.id !== id)
    setSavedViews(updated)
    localStorage.setItem(VIEWS_KEY, JSON.stringify(updated))
    if (activeViewId === id) setActiveViewId(null)
  }

  function clearFilters() {
    setLoFilter('All'); setSourceFilter('All'); setStatusFilter('All')
    setHideFunded(false); setActiveViewId(null)
  }

  const filtersActive = loFilter !== 'All' || sourceFilter !== 'All' || statusFilter !== 'All' || hideFunded

  // Determine which stages to show
  const visibleStages = STAGE_ORDER.filter(s => !(hideFunded && s === 'Funded'))

  // Filter deals to visible columns + active filters
  const filteredDeals = deals.filter(d => {
    const col = getColumnForDeal(d)
    if (!col || !visibleStages.includes(col)) return false
    if (loFilter !== 'All' && !d.loan_officer?.includes(loFilter)) return false
    if (sourceFilter !== 'All' && d.source !== sourceFilter) return false
    if (statusFilter !== 'All' && d.status !== statusFilter) return false
    return true
  })

  // Group by column, Escrows sorted by sub-section order
  const stageMap: Record<string, Deal[]> = {}
  visibleStages.forEach(s => { stageMap[s] = [] })
  filteredDeals.forEach(d => {
    const col = getColumnForDeal(d)
    if (col && stageMap[col]) stageMap[col].push(d)
  })
  if (stageMap['Escrows']) {
    stageMap['Escrows'].sort((a, b) => escrowSubIndex(a.status) - escrowSubIndex(b.status))
  }

  const activeDeal = activeId ? deals.find(d => d.id === activeId) : null
  const lockAlerts = filteredDeals.filter(d => { const n = getLockDaysLeft(d); return n !== null && n <= 7 }).length
  const staleDeals = filteredDeals.filter(d => getDealAge(d) > 14).length

  async function handleStatusChange(dealId: string, newStatus: string) {
    // Determine which column the new status belongs to via PIPELINE_STAGE_MAP
    let newGroup = STAGE_DEFAULT_GROUP['Leads']
    for (const [col, statuses] of Object.entries(PIPELINE_STAGE_MAP)) {
      if (statuses.includes(newStatus)) {
        if (col === 'Leads')    newGroup = 'Leads'
        else if (col === 'Escrows')  newGroup = 'Loans in Process'
        else if (col === 'Funded')   newGroup = 'Funded'
        else if (col === 'Not Ready') newGroup = 'Not Ready'
        break
      }
    }
    setDeals(prev => prev.map(d => d.id === dealId ? { ...d, status: newStatus, pipeline_group: newGroup, updated_at: new Date().toISOString() } : d))
    await supabase.from('deals').update({ status: newStatus, pipeline_group: newGroup }).eq('id', dealId)
  }

  function handleDragStart(event: DragStartEvent) { setActiveId(event.active.id as string) }
  function handleDragOver(event: { over: { id: string } | null }) { setOverId(event.over?.id ?? null) }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    setActiveId(null); setOverId(null)
    if (!over) return
    const dealId = active.id as string
    const targetStage = over.id as string
    if (!STAGE_ORDER.includes(targetStage)) return
    const deal = deals.find(d => d.id === dealId)
    if (!deal) return
    const currentStage = getColumnForDeal(deal)
    if (currentStage === targetStage) return
    const newStatus = STAGE_DEFAULT_STATUS[targetStage]
    const newGroup  = STAGE_DEFAULT_GROUP[targetStage]
    setDeals(prev => prev.map(d => d.id === dealId ? { ...d, status: newStatus, pipeline_group: newGroup, updated_at: new Date().toISOString() } : d))
    await supabase.from('deals').update({ status: newStatus, pipeline_group: newGroup }).eq('id', dealId)
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners}
      onDragStart={handleDragStart} onDragOver={handleDragOver as never} onDragEnd={handleDragEnd}>
      <div className="flex flex-col h-full">

        {/* ── Header ─────────────────────────────────────────────────────────── */}
        <div className="px-6 py-4 bg-white border-b border-slate-200 shrink-0">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h1 className="text-xl font-bold text-slate-900">Pipeline Board</h1>
              <div className="flex items-center gap-3 mt-0.5">
                <p className="text-sm text-slate-500">{filteredDeals.length} deals</p>
                {lockAlerts > 0 && (
                  <span className="flex items-center gap-1 text-xs font-medium text-red-600 bg-red-50 px-2 py-0.5 rounded-full">
                    <Lock className="w-3 h-3" /> {lockAlerts} lock{lockAlerts > 1 ? 's' : ''} expiring
                  </span>
                )}
                {staleDeals > 0 && (
                  <span className="flex items-center gap-1 text-xs font-medium text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">
                    <AlertTriangle className="w-3 h-3" /> {staleDeals} stale
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {/* Layout toggle */}
              <div className="flex items-center bg-slate-100 rounded-lg p-0.5 gap-0.5">
                <button
                  onClick={() => setLayoutView('board')}
                  title="Board view"
                  className={`p-1.5 rounded-md transition-colors ${layoutView === 'board' ? 'bg-white text-slate-700 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                >
                  <LayoutGrid className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setLayoutView('list')}
                  title="List view"
                  className={`p-1.5 rounded-md transition-colors ${layoutView === 'list' ? 'bg-white text-slate-700 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                >
                  <List className="w-4 h-4" />
                </button>
              </div>
              <button onClick={fetchDeals} className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
                <RefreshCw className="w-4 h-4" />
              </button>
              <Link href="/deals/new" className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors">
                + New Deal
              </Link>
            </div>
          </div>

          {/* ── Filter bar ───────────────────────────────────────────────────── */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Stage summary pills */}
            <div className="flex items-center gap-1.5">
              {STAGE_ORDER.map(s => {
                const c = STAGE_COLORS[s]
                const count = stageMap[s]?.length ?? 0
                return (
                  <div key={s} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-sm font-medium ${c.header}`}>
                    <span className={`w-2 h-2 rounded-full ${c.dot}`} />
                    {s}
                    <span className="bg-white/70 text-slate-500 text-xs font-semibold px-1.5 py-0.5 rounded-full border border-slate-200/80">{count}</span>
                  </div>
                )
              })}
            </div>

            <div className="h-5 w-px bg-slate-200" />

            {/* LO filter */}
            <select value={loFilter} onChange={e => { setLoFilter(e.target.value); setActiveViewId(null) }}
              className="text-sm border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="All">All LOs</option>
              <option value="Matt">Matt</option>
              <option value="Moe">Moe</option>
            </select>

            {/* Source filter */}
            <select value={sourceFilter} onChange={e => { setSourceFilter(e.target.value); setActiveViewId(null) }}
              className="text-sm border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="All">All Sources</option>
              {availableSources.filter(s => s !== 'All').map(s => <option key={s} value={s}>{s}</option>)}
            </select>

            {/* Status filter */}
            <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setActiveViewId(null) }}
              className="text-sm border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="All">All Stages</option>
              {availableStatuses.filter(s => s !== 'All').map(s => <option key={s} value={s}>{s}</option>)}
            </select>

            {/* Hide funded */}
            <button onClick={() => { setHideFunded(v => !v); setActiveViewId(null) }}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm font-medium transition-colors border ${
                hideFunded ? 'bg-slate-800 text-white border-slate-800' : 'text-slate-500 border-slate-200 hover:border-slate-300 hover:text-slate-700'
              }`}>
              <EyeOff className="w-3.5 h-3.5" /> Hide Funded
            </button>

            {/* Clear filters */}
            {filtersActive && (
              <button onClick={clearFilters}
                className="flex items-center gap-1 text-xs font-medium text-slate-400 hover:text-red-500 transition-colors px-2 py-1.5 rounded-lg hover:bg-red-50">
                <X className="w-3.5 h-3.5" /> Clear
              </button>
            )}

            <div className="ml-auto flex items-center gap-2">
              {/* Save view button */}
              <button onClick={() => { setNewViewName(''); setShowSaveModal(true) }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border border-slate-200 text-slate-600 hover:border-blue-300 hover:text-blue-600 hover:bg-blue-50 transition-colors">
                <Bookmark className="w-3.5 h-3.5" /> Save View
              </button>
            </div>
          </div>

          {/* ── Saved views strip ─────────────────────────────────────────────── */}
          {savedViews.length > 0 && (
            <div className="flex items-center gap-2 mt-2 pt-2 border-t border-slate-100 flex-wrap">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Saved:</span>
              {savedViews.map(v => (
                <div key={v.id}
                  className={`flex items-center gap-1 rounded-full border text-xs font-semibold px-3 py-1 transition-colors ${
                    activeViewId === v.id
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300 hover:text-blue-600'
                  }`}>
                  <button onClick={() => loadView(v)} className="pr-1">{v.name}</button>
                  <button onClick={() => deleteView(v.id)}
                    className={`rounded-full p-0.5 transition-colors ${activeViewId === v.id ? 'hover:bg-blue-500' : 'hover:bg-red-100 hover:text-red-500'}`}>
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* ── Save view modal ───────────────────────────────────────────────── */}
          {showSaveModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={() => setShowSaveModal(false)}>
              <div className="bg-white rounded-xl shadow-xl p-6 w-80" onClick={e => e.stopPropagation()}>
                <h3 className="font-bold text-slate-900 mb-1">Save Current View</h3>
                <p className="text-xs text-slate-500 mb-4">Saves your current filters so you can restore them anytime.</p>
                <input
                  autoFocus
                  type="text"
                  placeholder={`e.g. "Matt's Active Escrows"`}
                  value={newViewName}
                  onChange={e => setNewViewName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') saveView(); if (e.key === 'Escape') setShowSaveModal(false) }}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4"
                />
                <div className="text-xs text-slate-400 mb-4 space-y-0.5">
                  {loFilter !== 'All' && <div>LO: <strong>{loFilter}</strong></div>}
                  {sourceFilter !== 'All' && <div>Source: <strong>{sourceFilter}</strong></div>}
                  {statusFilter !== 'All' && <div>Stage: <strong>{statusFilter}</strong></div>}
                  {hideFunded && <div>Funded hidden</div>}
                  {!filtersActive && <div className="italic">No filters active — saves layout only</div>}
                </div>
                <div className="flex gap-2 justify-end">
                  <button onClick={() => setShowSaveModal(false)} className="px-3 py-1.5 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50">Cancel</button>
                  <button onClick={saveView} disabled={!newViewName.trim()} className="px-4 py-1.5 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-40">Save</button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Board / List ────────────────────────────────────────────────────── */}
        {loading ? (
          <div className="flex items-center justify-center flex-1">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
          </div>
        ) : layoutView === 'list' ? (
          <ListView deals={filteredDeals} onStatusChange={handleStatusChange} />
        ) : (
          <div className="flex gap-4 p-4 overflow-x-auto flex-1 items-start">
            {visibleStages.map(stage => {
              const stageDeals = stageMap[stage] || []
              const c = STAGE_COLORS[stage]
              const isOver = overId === stage

              return (
                <div key={stage} className="flex flex-col shrink-0 w-72">
                  <div className={`flex items-center justify-between px-3 py-2.5 rounded-t-xl border-b-2 ${c.header}`}>
                    <div className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full ${c.dot}`} />
                      <span className="font-semibold text-slate-800 text-sm">{stage}</span>
                      <span className="bg-white text-slate-500 text-xs font-medium px-1.5 py-0.5 rounded-full border border-slate-200">
                        {stageDeals.length}
                      </span>
                    </div>
                    <span className="text-xs font-medium text-slate-500">{stageDeals.length > 0 ? formatCurrency(stageDeals.reduce((s, d) => s + (d.loan_amount || 0), 0)) : ''}</span>
                  </div>

                  <DroppableColumn stage={stage} isOver={isOver}>
                    {stageDeals.length === 0 ? (
                      <div className={`rounded-xl border-2 border-dashed p-4 text-center transition-colors ${
                        isOver ? 'border-blue-400 bg-blue-50' : 'border-slate-200'
                      }`}>
                        <p className="text-slate-400 text-xs">{isOver ? 'Drop here' : 'No deals'}</p>
                      </div>
                    ) : stage === 'Escrows' ? (
                      // Escrows: render with sub-section dividers
                      (() => {
                        const nodes: React.ReactNode[] = []
                        let lastSub = -1
                        stageDeals.forEach(deal => {
                          const sub = escrowSubIndex(deal.status)
                          if (sub !== lastSub && sub < ESCROW_SUBGROUPS.length) {
                            const sg = ESCROW_SUBGROUPS[sub]
                            nodes.push(
                              <div key={`sg-${sub}`} className="flex items-center gap-1.5 px-1 pt-1 pb-0.5">
                                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${sg.dot}`} />
                                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{sg.label}</span>
                                <div className="flex-1 h-px bg-slate-200" />
                              </div>
                            )
                            lastSub = sub
                          }
                          nodes.push(
                            <DraggableCard key={deal.id} deal={deal} onStatusChange={handleStatusChange} />
                          )
                        })
                        return nodes
                      })()
                    ) : (
                      stageDeals.map(deal => (
                        <DraggableCard key={deal.id} deal={deal} onStatusChange={handleStatusChange} />
                      ))
                    )}
                  </DroppableColumn>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <DragOverlay>
        {activeDeal ? (
          <div className="w-72 rotate-2 scale-105 opacity-95">
            <DealCard deal={activeDeal} onStatusChange={() => {}} ghost />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
