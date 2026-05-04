'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  DndContext, DragEndEvent, DragOverlay, DragStartEvent,
  PointerSensor, useSensor, useSensors, closestCorners,
} from '@dnd-kit/core'
import { useDroppable } from '@dnd-kit/core'
import { useDraggable } from '@dnd-kit/core'
import { supabase } from '@/lib/supabase'
import { Deal, PIPELINE_STAGE_MAP, LOAN_STATUSES, STATUS_COLORS } from '@/lib/types'
import { formatCurrency } from '@/lib/utils'
import Link from 'next/link'
import { RefreshCw, Lock, Clock, AlertTriangle, ChevronDown, X } from 'lucide-react'

// ── Constants ────────────────────────────────────────────────────────────────

const STAGE_ORDER = ['Leads', 'Registered', 'Underwriting', 'Closing', 'Funded']

const STAGE_COLORS = {
  Leads:        { header: 'bg-slate-50 border-slate-300',   dot: 'bg-slate-400',   col: 'bg-slate-50/50' },
  Registered:   { header: 'bg-blue-50 border-blue-300',     dot: 'bg-blue-500',    col: 'bg-blue-50/30' },
  Underwriting: { header: 'bg-amber-50 border-amber-300',   dot: 'bg-amber-500',   col: 'bg-amber-50/30' },
  Closing:      { header: 'bg-orange-50 border-orange-300', dot: 'bg-orange-500',  col: 'bg-orange-50/30' },
  Funded:       { header: 'bg-emerald-50 border-emerald-300', dot: 'bg-emerald-500', col: 'bg-emerald-50/30' },
} as Record<string, { header: string; dot: string; col: string }>

// Default status when dropping into each stage
const STAGE_DEFAULT_STATUS: Record<string, string> = {
  Leads:        'Client',
  Registered:   'Loan Registered',
  Underwriting: 'Underwriting',
  Closing:      'Signing Scheduled',
  Funded:       'Comp Requested',
}

const STAGE_DEFAULT_GROUP: Record<string, string> = {
  Leads:        'LEADS',
  Registered:   'Active Escrows',
  Underwriting: 'Active Escrows',
  Closing:      'Signing Scheduled',
  Funded:       'Closed',
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getDealAge(deal: Deal): number {
  const date = new Date(deal.updated_at || deal.created_at)
  return Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24))
}

function getLockDaysLeft(deal: Deal): number | null {
  if (!deal.lock_expiration || deal.locked !== 'Yes') return null
  const exp = new Date(deal.lock_expiration)
  return Math.floor((exp.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
}

function getStageForStatus(status: string): string {
  for (const [stage, statuses] of Object.entries(PIPELINE_STAGE_MAP)) {
    if ((statuses as readonly string[]).includes(status)) return stage
  }
  return 'Leads'
}

// ── Droppable Column ─────────────────────────────────────────────────────────

function DroppableColumn({ stage, children, isOver }: {
  stage: string
  children: React.ReactNode
  isOver: boolean
}) {
  const { setNodeRef } = useDroppable({ id: stage })
  const c = STAGE_COLORS[stage]
  return (
    <div
      ref={setNodeRef}
      className={`flex flex-col gap-2 pt-2 overflow-y-auto max-h-[calc(100vh-180px)] rounded-b-xl transition-colors ${
        isOver ? 'ring-2 ring-blue-400 ring-inset bg-blue-50/50' : c?.col
      }`}
    >
      {children}
    </div>
  )
}

// ── Draggable Card ───────────────────────────────────────────────────────────

function DraggableCard({ deal, onStatusChange }: {
  deal: Deal
  onStatusChange: (dealId: string, status: string) => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: deal.id })

  return (
    <div
      ref={setNodeRef}
      style={{ opacity: isDragging ? 0.35 : 1 }}
      {...listeners}
      {...attributes}
      className="touch-none"
    >
      <DealCard deal={deal} onStatusChange={onStatusChange} />
    </div>
  )
}

// ── Deal Card ────────────────────────────────────────────────────────────────

function DealCard({ deal, onStatusChange, ghost = false }: {
  deal: Deal
  onStatusChange: (dealId: string, status: string) => void
  ghost?: boolean
}) {
  const [showStatusMenu, setShowStatusMenu] = useState(false)
  const age = getDealAge(deal)
  const lockDays = getLockDaysLeft(deal)
  const statusClass = STATUS_COLORS[deal.status] || 'bg-gray-100 text-gray-600'

  const ageColor = age <= 7 ? 'text-emerald-600' : age <= 14 ? 'text-amber-600' : 'text-red-600'
  const ageBg    = age <= 7 ? 'bg-emerald-50'   : age <= 14 ? 'bg-amber-50'    : 'bg-red-50'

  const lockColor = lockDays === null ? '' :
    lockDays > 14 ? 'text-emerald-600' :
    lockDays > 7  ? 'text-amber-600' :
    'text-red-600'

  const shortStatus = deal.status
    .replace('Signing Done - Waiting for Funding', 'Signing Done')
    .replace('Waiting on Docs from Client for final approval', 'Waiting on Docs')
    .replace('Figure - income verification or less', 'Figure - Income')

  return (
    <div className={`bg-white rounded-xl border border-slate-200 p-3.5 transition-all group relative ${
      ghost ? 'shadow-xl rotate-1 scale-105' : 'hover:border-blue-300 hover:shadow-md cursor-grab active:cursor-grabbing'
    }`}>

      {/* Lock expiration alert banner */}
      {lockDays !== null && lockDays <= 7 && (
        <div className="flex items-center gap-1 text-xs text-red-600 bg-red-50 rounded-lg px-2 py-1 mb-2 font-medium">
          <Lock className="w-3 h-3" />
          Lock expires in {lockDays <= 0 ? 'EXPIRED' : `${lockDays}d`}!
        </div>
      )}
      {lockDays !== null && lockDays > 7 && lockDays <= 14 && (
        <div className="flex items-center gap-1 text-xs text-amber-600 bg-amber-50 rounded-lg px-2 py-1 mb-2 font-medium">
          <Lock className="w-3 h-3" />
          Lock expires in {lockDays}d
        </div>
      )}

      {/* Name + quick status */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <Link
          href={`/deals/${deal.id}`}
          onClick={e => e.stopPropagation()}
          onMouseDown={e => e.stopPropagation()}
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
            {shortStatus}
            <ChevronDown className="w-2.5 h-2.5" />
          </button>

          {showStatusMenu && (
            <div
              className="absolute right-0 top-full mt-1 z-50 bg-white rounded-xl shadow-xl border border-slate-200 py-1 w-56 max-h-72 overflow-y-auto"
              onMouseDown={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-100">
                <span className="text-xs font-semibold text-slate-500">Change Status</span>
                <button onClick={() => setShowStatusMenu(false)}>
                  <X className="w-3 h-3 text-slate-400" />
                </button>
              </div>
              {LOAN_STATUSES.map(s => (
                <button
                  key={s}
                  onClick={() => { onStatusChange(deal.id, s); setShowStatusMenu(false) }}
                  className={`w-full text-left text-xs px-3 py-1.5 hover:bg-slate-50 transition-colors ${
                    s === deal.status ? 'font-semibold text-blue-600' : 'text-slate-700'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Loan details */}
      {(deal.loan_type || deal.loan_amount) && (
        <div className="flex items-center gap-1.5 mb-2 flex-wrap">
          {deal.loan_type && (
            <span className="text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded font-medium">
              {deal.loan_type}
            </span>
          )}
          {deal.loan_amount && (
            <span className="text-xs font-semibold text-slate-700">
              {formatCurrency(deal.loan_amount)}
            </span>
          )}
        </div>
      )}

      {/* Credit score if available */}
      {deal.credit_score && (
        <div className="text-xs text-slate-500 mb-1.5">
          FICO: <span className="font-semibold text-slate-700">{deal.credit_score}</span>
        </div>
      )}

      {/* Bottom row: LO + revenue */}
      <div className="flex items-center justify-between text-xs text-slate-400 mt-2">
        <span className="font-medium">{deal.loan_officer || '—'}</span>
        {deal.revenue && (
          <span className="font-semibold text-emerald-600">{formatCurrency(deal.revenue)}</span>
        )}
      </div>

      {/* Age + investor row */}
      <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-100">
        <div className={`flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded-md ${ageBg} ${ageColor}`}>
          <Clock className="w-2.5 h-2.5" />
          {age === 0 ? 'Today' : `${age}d`}
        </div>
        {deal.investor && (
          <span className="text-xs text-slate-400 truncate ml-2">{deal.investor}</span>
        )}
        {deal.locked === 'Yes' && lockDays !== null && lockDays > 14 && (
          <div className={`flex items-center gap-0.5 text-xs ${lockColor}`}>
            <Lock className="w-2.5 h-2.5" />
            {lockDays}d
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function PipelinePage() {
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [loFilter, setLoFilter] = useState('All')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  )

  const fetchDeals = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('deals')
      .select('*')
      .not('pipeline_group', 'in', '("Lost","Last files at WCL","Lost/Inactive/Does not qualify")')
      .order('created_at', { ascending: false })
    setDeals(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { fetchDeals() }, [fetchDeals])

  const filteredDeals = loFilter === 'All'
    ? deals
    : deals.filter(d => d.loan_officer?.includes(loFilter))

  // Group by stage
  const stageMap: Record<string, Deal[]> = {}
  STAGE_ORDER.forEach(s => { stageMap[s] = [] })
  filteredDeals.forEach(deal => {
    const stage = getStageForStatus(deal.status)
    if (stageMap[stage]) stageMap[stage].push(deal)
  })

  const activeDeal = activeId ? deals.find(d => d.id === activeId) : null
  const totalRevenue = filteredDeals.reduce((s, d) => s + (d.revenue || 0), 0)

  // Alert counts
  const lockAlerts = filteredDeals.filter(d => {
    const days = getLockDaysLeft(d)
    return days !== null && days <= 7
  }).length

  const staleDeals = filteredDeals.filter(d => getDealAge(d) > 14).length

  // Quick status change (from dropdown on card)
  async function handleStatusChange(dealId: string, newStatus: string) {
    const newStage = getStageForStatus(newStatus)
    const newGroup = STAGE_DEFAULT_GROUP[newStage]

    setDeals(prev => prev.map(d =>
      d.id === dealId
        ? { ...d, status: newStatus, pipeline_group: newGroup, updated_at: new Date().toISOString() }
        : d
    ))

    await supabase.from('deals').update({
      status: newStatus,
      pipeline_group: newGroup,
    }).eq('id', dealId)
  }

  // Drag handlers
  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string)
  }

  function handleDragOver(event: { over: { id: string } | null }) {
    setOverId(event.over?.id ?? null)
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    setActiveId(null)
    setOverId(null)

    if (!over) return
    const dealId = active.id as string
    const targetStage = over.id as string

    if (!STAGE_ORDER.includes(targetStage)) return

    const deal = deals.find(d => d.id === dealId)
    if (!deal) return

    const currentStage = getStageForStatus(deal.status)
    if (currentStage === targetStage) return

    const newStatus = STAGE_DEFAULT_STATUS[targetStage]
    const newGroup  = STAGE_DEFAULT_GROUP[targetStage]

    // Optimistic update
    setDeals(prev => prev.map(d =>
      d.id === dealId
        ? { ...d, status: newStatus, pipeline_group: newGroup, updated_at: new Date().toISOString() }
        : d
    ))

    await supabase.from('deals').update({
      status: newStatus,
      pipeline_group: newGroup,
    }).eq('id', dealId)
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver as never}
      onDragEnd={handleDragEnd}
    >
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="px-6 py-4 bg-white border-b border-slate-200 flex items-center justify-between shrink-0">
          <div>
            <h1 className="text-xl font-bold text-slate-900">Pipeline Board</h1>
            <div className="flex items-center gap-3 mt-0.5">
              <p className="text-sm text-slate-500">
                {filteredDeals.length} deals · {formatCurrency(totalRevenue)}
              </p>
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
          <div className="flex items-center gap-3">
            <select
              value={loFilter}
              onChange={e => setLoFilter(e.target.value)}
              className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="All">All LOs</option>
              <option value="Efrain">Efrain</option>
              <option value="Matt">Matt</option>
              <option value="Moe">Moe</option>
            </select>
            <button onClick={fetchDeals} className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
              <RefreshCw className="w-4 h-4" />
            </button>
            <Link href="/deals/new" className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors">
              + New Deal
            </Link>
          </div>
        </div>

        {/* Board */}
        {loading ? (
          <div className="flex items-center justify-center flex-1">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
          </div>
        ) : (
          <div className="flex gap-4 p-4 overflow-x-auto flex-1 items-start">
            {STAGE_ORDER.map(stage => {
              const stageDeals = stageMap[stage] || []
              const stageRevenue = stageDeals.reduce((s, d) => s + (d.revenue || 0), 0)
              const c = STAGE_COLORS[stage]
              const isOver = overId === stage

              return (
                <div key={stage} className="flex flex-col shrink-0 w-72">
                  {/* Column header */}
                  <div className={`flex items-center justify-between px-3 py-2.5 rounded-t-xl border-b-2 ${c.header}`}>
                    <div className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full ${c.dot}`} />
                      <span className="font-semibold text-slate-800 text-sm">{stage}</span>
                      <span className="bg-white text-slate-500 text-xs font-medium px-1.5 py-0.5 rounded-full border border-slate-200">
                        {stageDeals.length}
                      </span>
                    </div>
                    <span className="text-xs font-medium text-slate-500">{formatCurrency(stageRevenue)}</span>
                  </div>

                  <DroppableColumn stage={stage} isOver={isOver}>
                    {stageDeals.length === 0 ? (
                      <div className={`rounded-xl border-2 border-dashed p-4 text-center transition-colors ${
                        isOver ? 'border-blue-400 bg-blue-50' : 'border-slate-200'
                      }`}>
                        <p className="text-slate-400 text-xs">
                          {isOver ? 'Drop here' : 'No deals'}
                        </p>
                      </div>
                    ) : (
                      stageDeals.map(deal => (
                        <DraggableCard
                          key={deal.id}
                          deal={deal}
                          onStatusChange={handleStatusChange}
                        />
                      ))
                    )}
                  </DroppableColumn>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Drag overlay — ghost card that follows cursor */}
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
