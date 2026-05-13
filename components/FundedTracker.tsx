'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import {
  DndContext, useSensors, useSensor, PointerSensor,
  useDraggable, useDroppable, type DragEndEvent,
} from '@dnd-kit/core'
import { Deal, STATUS_COLORS } from '@/lib/types'
import { formatCurrency } from '@/lib/utils'
import {
  CheckCircle2, ExternalLink, GripVertical, Calendar,
  DollarSign, Briefcase, Search,
} from 'lucide-react'

// ── Funded pipeline stages (in order) ────────────────────────────────────────
const FUNDED_STAGES = [
  'Loan Funded',
  'Broker Check Received',
  'Loan Finalized',
] as const

// Subtle accent stripe per stage — moving through the funded lifecycle
const STAGE_ACCENT: Record<string, string> = {
  'Loan Funded':            'bg-emerald-500',
  'Broker Check Received':  'bg-green-600',
  'Loan Finalized':         'bg-teal-700',
}

function fmtMoneyShort(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`
  return `$${n}`
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

type Props = {
  deals: Deal[]
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>
}

export default function FundedTracker({ deals, onUpdate }: Props) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    if (!search.trim()) return deals
    const q = search.toLowerCase().trim()
    return deals.filter(d => {
      const hay = [d.name, d.loan_officer, d.property_address, d.investor, d.email]
        .filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    })
  }, [deals, search])

  // Group + sort within each stage (most-recently funded first)
  const byStage: Record<string, Deal[]> = {}
  for (const stage of FUNDED_STAGES) byStage[stage] = []
  const otherDeals: Deal[] = []
  for (const d of filtered) {
    if (byStage[d.status]) byStage[d.status].push(d)
    else otherDeals.push(d)
  }
  for (const stage of FUNDED_STAGES) {
    byStage[stage].sort((a, b) => {
      const av = new Date(a.funded_date || a.created_at).getTime()
      const bv = new Date(b.funded_date || b.created_at).getTime()
      return bv - av
    })
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over) return
    const dealId = String(active.id)
    const newStatus = String(over.id)
    const deal = deals.find(d => d.id === dealId)
    if (!deal || deal.status === newStatus) return
    if (!FUNDED_STAGES.includes(newStatus as typeof FUNDED_STAGES[number])) return
    onUpdate(dealId, { status: newStatus })
  }

  if (filtered.length === 0 && deals.length === 0) {
    return (
      <div className="p-4">
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
          <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-2" />
          <p className="text-sm font-semibold text-slate-800">No funded deals yet</p>
          <p className="text-xs text-slate-500 mt-1">Deals will show up here once they hit Loan Funded.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 space-y-4">
      {/* Search */}
      <div className="flex items-center gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search funded deals…"
            className="pl-9 pr-3 py-1.5 border border-slate-200 rounded-lg text-sm w-72 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        {search.trim() && filtered.length === 0 && (
          <span className="text-xs text-slate-500">No matches for &ldquo;{search}&rdquo;</span>
        )}
      </div>

      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <div className="overflow-x-auto pb-2 -mx-4 px-4">
          <div className="flex gap-3 min-w-max">
            {FUNDED_STAGES.map(stage => {
              const stageDeals = byStage[stage]
              const totalVolume = stageDeals.reduce((s, d) => s + (d.loan_amount || 0), 0)
              return (
                <FundedColumn
                  key={stage}
                  stage={stage}
                  deals={stageDeals}
                  totalVolume={totalVolume}
                  accentClass={STAGE_ACCENT[stage] || 'bg-slate-300'}
                  onUpdate={onUpdate}
                />
              )
            })}
            {otherDeals.length > 0 && (
              <FundedColumn
                stage="Other"
                deals={otherDeals}
                totalVolume={otherDeals.reduce((s, d) => s + (d.loan_amount || 0), 0)}
                accentClass="bg-slate-400"
                onUpdate={onUpdate}
                isOtherColumn
              />
            )}
          </div>
        </div>
      </DndContext>
    </div>
  )
}

function FundedColumn({ stage, deals, totalVolume, accentClass, onUpdate, isOtherColumn }: {
  stage: string
  deals: Deal[]
  totalVolume: number
  accentClass: string
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>
  isOtherColumn?: boolean
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage, disabled: isOtherColumn })

  return (
    <div className="w-[340px] shrink-0 flex flex-col">
      <div className="bg-white rounded-t-xl border border-slate-200 border-b-0 overflow-hidden">
        <div className={`h-1 ${accentClass}`} />
        <div className="px-4 py-2.5 flex items-center justify-between">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-800 truncate">{stage}</h3>
            {totalVolume > 0 && (
              <p className="text-[11px] text-slate-500 mt-0.5 tabular-nums">{fmtMoneyShort(totalVolume)} volume</p>
            )}
          </div>
          <span className="text-[11px] font-semibold text-slate-600 bg-slate-100 rounded-full px-2 py-0.5 tabular-nums shrink-0">
            {deals.length}
          </span>
        </div>
      </div>

      <div
        ref={setNodeRef}
        className={`border border-t-0 rounded-b-xl p-2 space-y-2 flex-1 min-h-[200px] transition-colors ${
          isOver
            ? 'bg-emerald-50 border-emerald-300 ring-2 ring-emerald-200'
            : 'bg-slate-50/60 border-slate-200'
        }`}
      >
        {deals.length === 0 ? (
          <div className={`text-center text-[11px] italic py-6 ${isOver ? 'text-emerald-700 font-medium' : 'text-slate-400'}`}>
            {isOver ? `Drop to move to ${stage}` : 'No deals'}
          </div>
        ) : (
          deals.map(d => <DraggableFundedCard key={d.id} deal={d} onUpdate={onUpdate} />)
        )}
      </div>
    </div>
  )
}

function DraggableFundedCard({ deal, onUpdate }: {
  deal: Deal
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: deal.id })
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 50 as const }
    : undefined
  return (
    <div ref={setNodeRef} style={style} className={isDragging ? 'opacity-40' : ''}>
      <FundedCard deal={deal} onUpdate={onUpdate} dragHandleProps={{ ...attributes, ...listeners }} />
    </div>
  )
}

function FundedCard({ deal, dragHandleProps }: {
  deal: Deal
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>
  dragHandleProps?: React.HTMLAttributes<HTMLDivElement> & Record<string, unknown>
}) {
  const statusClass = STATUS_COLORS[deal.status] || 'bg-gray-100 text-gray-600'

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden hover:shadow-md transition-shadow">
      {/* Drag handle / header */}
      <div
        {...dragHandleProps}
        className={`px-4 py-2.5 bg-slate-200 border-b border-slate-300 flex items-center justify-between gap-2 ${dragHandleProps ? 'cursor-grab active:cursor-grabbing select-none' : ''}`}
        title={dragHandleProps ? 'Drag to move to another stage' : undefined}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          {dragHandleProps && <GripVertical className="w-3.5 h-3.5 text-slate-500 shrink-0" />}
          <Link
            href={`/deals/${deal.id}`}
            onPointerDown={e => e.stopPropagation()}
            className="font-semibold text-sm text-slate-900 hover:text-blue-700 truncate flex items-center gap-1 group"
          >
            {deal.name}
            <ExternalLink className="w-3 h-3 text-slate-300 group-hover:text-blue-500 opacity-0 group-hover:opacity-100 transition" />
          </Link>
        </div>
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded shrink-0 ${statusClass}`}>
          {deal.status}
        </span>
      </div>

      {/* Body */}
      <div className="p-4 space-y-3">
        {/* Quick stats row */}
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div>
            <p className="text-slate-400 uppercase tracking-wider font-medium text-[9px]">LO</p>
            <p className="text-slate-800 font-medium truncate">{deal.loan_officer || '—'}</p>
          </div>
          <div>
            <p className="text-slate-400 uppercase tracking-wider font-medium text-[9px]">Loan Amount</p>
            <p className="text-slate-800 font-semibold tabular-nums">
              {deal.loan_amount ? formatCurrency(deal.loan_amount) : '—'}
            </p>
          </div>
        </div>

        {/* Property */}
        {deal.property_address && (
          <div className="text-xs text-slate-600 truncate">
            <span className="text-slate-400">📍 </span>{deal.property_address}
          </div>
        )}

        {/* Key dates */}
        <div className="border-t border-slate-100 pt-2 grid grid-cols-2 gap-2 text-[11px]">
          <div className="flex items-center gap-1 text-slate-600">
            <DollarSign className="w-3 h-3 text-emerald-500 shrink-0" />
            <span className="text-slate-400">Funded:</span>
            <span className="font-medium">{fmtDate(deal.funded_date)}</span>
          </div>
          <div className="flex items-center gap-1 text-slate-600">
            <Calendar className="w-3 h-3 text-green-600 shrink-0" />
            <span className="text-slate-400">Paid:</span>
            <span className="font-medium">{fmtDate(deal.paid_date)}</span>
          </div>
        </div>

        {/* Investor + loan type */}
        {(deal.investor || deal.loan_type) && (
          <div className="flex items-center gap-1.5 text-[11px] text-slate-500 pt-1">
            <Briefcase className="w-3 h-3 text-slate-400" />
            {deal.loan_type && <span className="font-medium text-slate-700">{deal.loan_type}</span>}
            {deal.loan_type && deal.investor && <span className="text-slate-300">·</span>}
            {deal.investor && <span>{deal.investor}</span>}
          </div>
        )}
      </div>
    </div>
  )
}
