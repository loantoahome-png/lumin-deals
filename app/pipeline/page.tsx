'use client'

import { useEffect, useState, useCallback, useRef, useMemo, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  DndContext, DragEndEvent, DragOverlay, DragStartEvent,
  PointerSensor, useSensor, useSensors, closestCorners,
} from '@dnd-kit/core'
import { useDroppable, useDraggable } from '@dnd-kit/core'
import { supabase } from '@/lib/supabase'
import { fetchAllDeals, DEAL_COLUMNS } from '@/lib/fetchAllDeals'
import { Deal, LOAN_STATUSES, STATUS_COLORS, LOAN_TYPES, OCCUPANCY_TYPES, LOAN_OFFICERS, APPRAISAL_STATUSES, WAITING_ON_OPTIONS, PROCESSORS } from '@/lib/types'
import { LoFilter, useLoFilter, loSelected } from '@/components/LoFilter'
import { resolveLO } from '@/lib/loanOfficer'
import { formatCurrency, formatDate } from '@/lib/utils'
import { pushStageToGHL } from '@/lib/pushStage'
import { ghlContactUrl } from '@/lib/ghlLinks'
import Link from 'next/link'
import { RefreshCw, Lock, Clock, AlertTriangle, ChevronDown, X, LayoutGrid, List, Bookmark, Trash2, ArrowRight, Check, Pencil, Calendar, User, Building2, ChevronLeft, Search, SlidersHorizontal, Filter, DollarSign, Home, Hash, Tag, Briefcase, Phone, Mail, MapPin, AlertOctagon, Flame, Star, Activity, Download, ExternalLink } from 'lucide-react'

// ── Arive deep-linking ──────────────────────────────────────────────────────
// Both LOs share one Arive org, so the loan URL is fully derivable from the file #.
function ariveUrl(fileNo: string | null | undefined): string | null {
  const id = String(fileNo ?? '').trim()
  if (!id) return null
  return `https://luminlending.myarive.com/app/loans/${id}/loan-center`
}

// ── Pipeline config — single source of truth for stages per pipeline ──────────

type PipelineDef = {
  key: string
  group: string   // pipeline_group DB value
  dot: string
  headerBg: string
  headerBorder: string
  stageDot: string
  stageHeader: string
  colBg: string
  stages: readonly string[]
}

const PIPELINE_CONFIG: PipelineDef[] = [
  {
    key: 'Leads',
    group: 'Leads',
    dot: 'bg-slate-400',
    headerBg: 'bg-slate-800',
    headerBorder: 'border-slate-600',
    stageDot: 'bg-slate-300',
    stageHeader: 'bg-slate-50 border-slate-200',
    colBg: 'bg-slate-50/60',
    stages: [
      'New Lead', 'Attempted Contact', 'Ghosted', 'Responded', 'Pitching',
      'Appointment Booked', 'Arive Lead', 'App Intake', 'Qualification', 'Pre-Approved',
    ],
  },
  {
    key: 'Escrows',
    group: 'Loans in Process',
    dot: 'bg-amber-500',
    headerBg: 'bg-amber-600',
    headerBorder: 'border-amber-400',
    stageDot: 'bg-amber-300',
    stageHeader: 'bg-amber-50 border-amber-200',
    colBg: 'bg-amber-50/40',
    stages: [
      'Loan Setup', 'Disclosed', 'Submitted to UW', 'Approved w/ Conditions',
      'Re-Submittal', 'Clear to Close', 'Docs Out', 'Docs Signed',
      'Loan Funded', 'Broker Check Received', 'Loan Finalized',
    ],
  },
  {
    key: 'Not Ready',
    group: 'Not Ready',
    dot: 'bg-rose-400',
    headerBg: 'bg-rose-700',
    headerBorder: 'border-rose-500',
    stageDot: 'bg-rose-300',
    stageHeader: 'bg-rose-50 border-rose-200',
    colBg: 'bg-rose-50/30',
    stages: [
      'Not Qualified - Credit', 'Not Qualified - Income', 'Not Ready - Timeframe',
      'DND - SMS', 'Not Ready - Rate', 'Lost to Competitor', 'Non-Responsive',
      'Remove from All Automations', 'STOP',
    ],
  },
  {
    key: 'Funded',
    group: 'Funded',
    dot: 'bg-emerald-500',
    headerBg: 'bg-emerald-700',
    headerBorder: 'border-emerald-500',
    stageDot: 'bg-emerald-300',
    stageHeader: 'bg-emerald-50 border-emerald-200',
    colBg: 'bg-emerald-50/40',
    stages: ['Loan Funded', 'Broker Check Received', 'Loan Finalized'],
  },
]

// Funded override — these statuses always belong in the Funded pipeline
const FUNDED_STATUSES = new Set(['Loan Funded', 'Broker Check Received', 'Loan Finalized'])
function resolvePipelineGroup(status: string, pipeline: typeof PIPELINE_CONFIG[0]): string {
  return FUNDED_STATUSES.has(status) ? 'Funded' : pipeline.group
}

function getDealPipelineKey(deal: Deal): string | null {
  const g = deal.pipeline_group
  if (g === 'Leads')            return 'Leads'
  if (g === 'Loans in Process') return 'Escrows'
  if (g === 'Not Ready')        return 'Not Ready'
  if (g === 'Funded')           return 'Funded'
  return null
}

// ── Source badge ──────────────────────────────────────────────────────────────
const SOURCE_STYLES: Record<string, string> = {
  'Self Source':   'bg-emerald-100 text-emerald-700',
  'Referral':      'bg-violet-100 text-violet-700',
  'Past Client':   'bg-amber-100 text-amber-700',
  'Open House':    'bg-sky-100 text-sky-700',
  'Agent Partner': 'bg-rose-100 text-rose-700',
}

function SourceBadge({ deal }: { deal: Deal }) {
  const src = deal.source
  if (!src) return null
  const isGHL = !!deal.ghl_contact_id
  const style = isGHL ? 'bg-blue-100 text-blue-700' : (SOURCE_STYLES[src] || 'bg-slate-100 text-slate-600')
  const label = isGHL ? (src === 'GHL' ? 'GHL' : src) : src
  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide ${style}`}>
      {label}
    </span>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getDealAge(deal: Deal): number {
  return Math.floor((Date.now() - new Date(deal.updated_at || deal.created_at).getTime()) / 86400000)
}

function getLockDaysLeft(deal: Deal): number | null {
  if (!deal.lock_expiration || deal.locked !== 'Yes') return null
  // lock_expiration is a date-only string; parse it as LOCAL midnight and compare to local
  // midnight today so the countdown is an accurate calendar diff (not off-by-one in Pacific).
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(deal.lock_expiration.trim())
  const exp = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(deal.lock_expiration)
  if (isNaN(exp.getTime())) return null
  const today = new Date(); today.setHours(0, 0, 0, 0)
  return Math.round((exp.getTime() - today.getTime()) / 86400000)
}

// ── Droppable Stage Column ────────────────────────────────────────────────────
function DroppableColumn({ droppableId, children, isOver }: {
  droppableId: string; children: React.ReactNode; isOver: boolean
}) {
  const { setNodeRef } = useDroppable({ id: droppableId })
  return (
    <div
      ref={setNodeRef}
      className={`flex flex-col gap-2 pt-1 pb-2 min-h-[80px] overflow-y-auto max-h-[calc(100vh-300px)] rounded-b-lg transition-colors ${
        isOver ? 'ring-2 ring-blue-400 ring-inset bg-blue-50/60' : ''
      }`}
    >
      {children}
    </div>
  )
}

// ── Draggable Card ────────────────────────────────────────────────────────────
function DraggableCard({ deal, onStatusChange, isSelected, onToggleSelect, pipelineStages }: {
  deal: Deal
  onStatusChange: (id: string, status: string) => void
  isSelected?: boolean
  onToggleSelect?: (id: string) => void
  pipelineStages?: readonly string[]
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: deal.id })
  return (
    <div ref={setNodeRef} style={{ opacity: isDragging ? 0.35 : 1 }} {...listeners} {...attributes} className="touch-none">
      <DealCard deal={deal} onStatusChange={onStatusChange} isSelected={isSelected} onToggleSelect={onToggleSelect} pipelineStages={pipelineStages} />
    </div>
  )
}

// ── Deal Card ─────────────────────────────────────────────────────────────────
function DealCard({ deal, onStatusChange, ghost = false, isSelected = false, onToggleSelect, pipelineStages }: {
  deal: Deal
  onStatusChange: (id: string, status: string) => void
  ghost?: boolean
  isSelected?: boolean
  onToggleSelect?: (id: string) => void
  pipelineStages?: readonly string[]
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
    .replace('Not Qualified - Credit', 'NQ - Credit')
    .replace('Not Qualified - Income', 'NQ - Income')
    .replace('Not Ready - Timeframe', 'NR - Timeframe')
    .replace('Not Ready - Rate', 'NR - Rate')
    .replace('Remove from All Automations', 'Remove - Autos')
    .replace('Approved w/ Conditions', 'Approved w/ Cond.')
    .replace('Broker Check Received', 'Check Received')

  const statusList = pipelineStages || LOAN_STATUSES

  return (
    <div className={`bg-white rounded-xl border p-3 transition-all group relative ${
      ghost      ? 'shadow-xl rotate-1 scale-105 border-slate-200' :
      isSelected ? 'border-blue-400 shadow-md cursor-grab active:cursor-grabbing' :
                   'border-slate-200 hover:border-blue-300 hover:shadow-md cursor-grab active:cursor-grabbing'
    }`}>
      {/* Lock alerts */}
      {lockDays !== null && lockDays <= 7 && (
        <div className="flex items-center gap-1 text-xs text-red-600 bg-red-50 rounded-lg px-2 py-1 mb-2 font-medium">
          <Lock className="w-3 h-3" />Lock {lockDays <= 0 ? 'EXPIRED' : `${lockDays}d`}!
        </div>
      )}
      {lockDays !== null && lockDays > 7 && lockDays <= 14 && (
        <div className="flex items-center gap-1 text-xs text-amber-600 bg-amber-50 rounded-lg px-2 py-1 mb-2 font-medium">
          <Lock className="w-3 h-3" />Lock {lockDays}d
        </div>
      )}

      {/* Name + status */}
      <div className="flex items-start justify-between gap-1.5 mb-1.5">
        <div className="flex items-start gap-1.5 min-w-0">
          {!ghost && onToggleSelect && (
            <button
              className={`shrink-0 mt-0.5 w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${
                isSelected ? 'bg-blue-600 border-blue-600 opacity-100' : 'border-slate-300 bg-white opacity-0 group-hover:opacity-100 hover:border-blue-400'
              }`}
              onMouseDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); onToggleSelect(deal.id) }}
            >
              {isSelected && <Check className="w-2.5 h-2.5 text-white" />}
            </button>
          )}
          <Link
            href={`/deals/${deal.id}`}
            onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}
            className="font-semibold text-slate-900 text-sm leading-tight hover:text-blue-700 transition-colors"
            title="Open in dashboard"
          >
            {deal.name}
          </Link>
          {(() => {
            const ghlUrl = ghlContactUrl(deal)
            return ghlUrl ? (
              <a
                href={ghlUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                onMouseDown={e => e.stopPropagation()}
                title="Open contact in GoHighLevel"
                className="shrink-0 flex items-center gap-0.5 text-[9px] font-bold text-blue-700 hover:text-blue-900 px-1 py-0.5 rounded bg-blue-100 hover:bg-blue-200 border border-blue-200 transition-colors"
              >
                GHL
              </a>
            ) : null
          })()}
        </div>
        <div className="relative shrink-0">
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); setShowStatusMenu(v => !v) }}
            className={`text-[10px] px-1.5 py-0.5 rounded-md font-medium flex items-center gap-0.5 ${statusClass}`}
          >
            {shortStatus}<ChevronDown className="w-2.5 h-2.5" />
          </button>
          {showStatusMenu && (
            <div className="absolute right-0 top-full mt-1 z-50 flex flex-col bg-white rounded-xl shadow-xl border border-slate-200 py-1 w-52 max-h-64 overflow-y-auto whitespace-normal" onMouseDown={e => e.stopPropagation()}>
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-100 shrink-0">
                <span className="text-xs font-semibold text-slate-500">Change Status</span>
                <button onClick={() => setShowStatusMenu(false)}><X className="w-3 h-3 text-slate-400" /></button>
              </div>
              {statusList.map(s => (
                <button key={s} onClick={() => { onStatusChange(deal.id, s); setShowStatusMenu(false) }}
                  className={`block w-full text-left text-xs px-3 py-1.5 hover:bg-slate-50 transition-colors ${s === deal.status ? 'font-semibold text-blue-600' : 'text-slate-700'}`}>
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mb-1.5"><SourceBadge deal={deal} /></div>

      {(deal.loan_type || deal.loan_amount) && (
        <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
          {deal.loan_type && !deal.loan_type.startsWith('{') && (
            <span className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded font-medium">{deal.loan_type}</span>
          )}
          {deal.loan_amount && <span className="text-xs font-semibold text-slate-700">{formatCurrency(deal.loan_amount)}</span>}
        </div>
      )}

      {(deal.credit_rating || deal.occupancy) && (
        <div className="flex items-center gap-2 text-[10px] text-slate-400 mb-1 flex-wrap">
          {deal.credit_rating && <span>({deal.credit_rating})</span>}
          {deal.occupancy && <span>{deal.occupancy}</span>}
        </div>
      )}

      <div className="text-[10px] text-slate-400 font-medium mb-1">{deal.loan_officer || '—'}</div>

      <div className="flex items-center justify-between mt-1.5 pt-1.5 border-t border-slate-100">
        <div className={`flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-md ${ageBg} ${ageColor}`}>
          <Clock className="w-2.5 h-2.5" />
          {age === 0 ? 'Today' : `${age}d`}
        </div>
        {deal.investor && <span className="text-[10px] text-slate-400 truncate ml-1">{deal.investor}</span>}
        <div className="flex items-center gap-1.5 ml-auto">
          {deal.locked === 'Yes' && lockDays !== null && lockDays > 14 && (
            <span className={`flex items-center gap-0.5 text-[10px] ${lockColor}`}>
              <Lock className="w-2.5 h-2.5" />{lockDays}d
            </span>
          )}
          {ariveUrl(deal.arive_file_no) && (
            <a
              href={ariveUrl(deal.arive_file_no)!}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              onMouseDown={e => e.stopPropagation()}
              title={`Open Arive file ${deal.arive_file_no}`}
              className="flex items-center gap-0.5 text-[10px] font-medium text-emerald-600 hover:text-emerald-700"
            >
              <ExternalLink className="w-2.5 h-2.5" /> Arive
            </a>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Inline cell editing ───────────────────────────────────────────────────────
type InlineCellProps = {
  deal: Deal
  field: string
  value: unknown
  type: 'text' | 'email' | 'tel' | 'number' | 'currency' | 'percent' | 'date' | 'select'
  options?: readonly string[]
  step?: string
  isEditing: boolean
  onStartEdit: () => void
  onSave: (val: unknown) => void
  onCancel: () => void
  onTab?: (shift: boolean) => void
  displayRender?: React.ReactNode
}

function InlineCell({
  field, value, type, options, step,
  isEditing, onStartEdit, onSave, onCancel, onTab,
  displayRender,
}: InlineCellProps) {
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement>(null)
  const [localVal, setLocalVal] = useState('')

  useEffect(() => {
    if (isEditing) {
      setLocalVal(value != null ? String(value) : '')
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus()
          if ('select' in inputRef.current && type !== 'select' && type !== 'date') {
            (inputRef.current as HTMLInputElement).select()
          }
        }
      }, 0)
    }
  }, [isEditing, value, type])

  function commit() {
    let parsed: unknown = localVal
    if (type === 'number' || type === 'currency' || type === 'percent') {
      parsed = localVal === '' ? null : parseFloat(localVal)
    }
    onSave(parsed)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); commit() }
    if (e.key === 'Escape') { e.preventDefault(); onCancel() }
    if (e.key === 'Tab') {
      e.preventDefault()
      commit()
      onTab?.(e.shiftKey)
    }
  }

  const inputCls = 'w-full bg-transparent border-none outline-none text-sm text-slate-800 p-0 m-0'
  const wrapCls  = 'ring-2 ring-blue-400 ring-inset bg-white rounded px-2 py-1 min-w-[80px]'

  if (!isEditing) {
    return (
      <div
        onClick={onStartEdit}
        className="cursor-pointer rounded px-1 -mx-1 hover:bg-slate-100 transition-colors min-h-[22px] flex items-center"
        title={`Click to edit ${field}`}
      >
        {displayRender ?? (
          <span className="text-slate-600 text-sm">
            {value != null && value !== '' ? String(value) : <span className="text-slate-300">—</span>}
          </span>
        )}
      </div>
    )
  }

  if (type === 'select' && options) {
    return (
      <div className={wrapCls}>
        <select
          ref={inputRef as React.RefObject<HTMLSelectElement>}
          value={localVal}
          onChange={e => setLocalVal(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          className={inputCls + ' cursor-pointer'}
        >
          <option value="">—</option>
          {options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
    )
  }

  if (type === 'date') {
    return (
      <div className={wrapCls}>
        <input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          type="date"
          value={localVal}
          onChange={e => setLocalVal(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          className={inputCls}
        />
      </div>
    )
  }

  const htmlType = type === 'currency' || type === 'percent' || type === 'number' ? 'number' : type

  return (
    <div className={wrapCls}>
      <input
        ref={inputRef as React.RefObject<HTMLInputElement>}
        type={htmlType}
        value={localVal}
        step={step}
        onChange={e => setLocalVal(e.target.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        className={inputCls}
      />
    </div>
  )
}

// Tab order for a row
const INLINE_TAB_ORDER: string[] = [
  'name', 'loan_officer', 'loan_type', 'loan_amount', 'rate', 'ltv',
  'credit_score', 'investor', 'email', 'phone', 'property_address',
  'signing_date', 'funded_date', 'arive_file_no', 'processor',
]

// ── List View ─────────────────────────────────────────────────────────────────
const STAGE_DOT: Record<string, string> = {
  Leads: 'bg-slate-400', Escrows: 'bg-amber-500', 'Not Ready': 'bg-rose-400', Funded: 'bg-emerald-500',
}

const COLS_STORAGE_KEY = 'lumin_pipeline_cols'

const ALL_COLS = [
  { key: 'pipeline',         label: 'Pipeline',      defaultOn: true },
  { key: 'status',           label: 'Status',         defaultOn: true },
  { key: 'loan_officer',     label: 'LO',             defaultOn: true },
  { key: 'loan_type',        label: 'Loan Type',      defaultOn: true },
  { key: 'loan_amount',      label: 'Amount',         defaultOn: true },
  { key: 'ltv',              label: 'LTV',            defaultOn: true },
  { key: 'credit_score',     label: 'FICO',           defaultOn: true },
  { key: 'investor',         label: 'Lender',         defaultOn: true },
  { key: 'lock_exp',         label: 'Lock Exp',       defaultOn: true },
  { key: 'age',              label: 'Age',            defaultOn: true },
  { key: 'source',           label: 'Source',         defaultOn: true },
  { key: 'rate',             label: 'Rate',           defaultOn: false },
  { key: 'email',            label: 'Email',          defaultOn: false },
  { key: 'phone',            label: 'Phone',          defaultOn: false },
  { key: 'property_address', label: 'Property',       defaultOn: false },
  { key: 'occupancy',        label: 'Occupancy',      defaultOn: false },
  { key: 'loan_purpose',     label: 'Purpose',        defaultOn: false },
  { key: 'credit_rating',    label: 'Credit Rating',  defaultOn: false },
  { key: 'signing_date',     label: 'Signing Date',   defaultOn: false },
  { key: 'funded_date',      label: 'Funded Date',    defaultOn: false },
  { key: 'arive_file_no',    label: 'Arive #',        defaultOn: false },
  { key: 'processor',        label: 'Processor',      defaultOn: false },
] as const

type ColKey = typeof ALL_COLS[number]['key']

function defaultVisibleCols(): Set<string> {
  return new Set(ALL_COLS.filter(c => c.defaultOn).map(c => c.key))
}

function loadVisibleCols(): Set<string> {
  try {
    const stored = localStorage.getItem(COLS_STORAGE_KEY)
    if (stored) {
      const arr = JSON.parse(stored) as string[]
      if (Array.isArray(arr) && arr.length > 0) return new Set(arr)
    }
  } catch { /* ignore */ }
  return defaultVisibleCols()
}

function ListView({ deals, onStatusChange, onUpdate, selectedIds, onToggleSelect, onSelectAll, onClearAll, visibleCols, onColToggle }: {
  deals: Deal[]
  onStatusChange: (id: string, status: string) => void
  onUpdate: (id: string, field: string, value: unknown) => Promise<void>
  selectedIds: Set<string>
  onToggleSelect: (id: string) => void
  onSelectAll: (ids: string[]) => void
  onClearAll: () => void
  visibleCols: Set<string>
  onColToggle: (key: string) => void
}) {
  const [sortKey, setSortKey] = useState<string>('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const selectAllRef = useRef<HTMLInputElement>(null)
  const [editCell, setEditCell] = useState<{ id: string; field: string } | null>(null)

  function startEdit(id: string, field: string) {
    setEditCell({ id, field })
  }

  function cancelEdit() {
    setEditCell(null)
  }

  async function saveEdit(id: string, field: string, value: unknown) {
    setEditCell(null)
    await onUpdate(id, field, value)
  }

  function tabEdit(id: string, field: string, shift: boolean) {
    const allFields = INLINE_TAB_ORDER.filter(f => {
      // Only tab to visible fields
      if (f === 'name') return true
      const col = ALL_COLS.find(c => c.key === f)
      return col ? visibleCols.has(col.key) : false
    })
    const fieldIdx = allFields.indexOf(field)
    // figure out row
    const rowIdx = sorted.findIndex(d => d.id === id)
    let nextFieldIdx = shift ? fieldIdx - 1 : fieldIdx + 1
    let nextRowIdx = rowIdx
    if (nextFieldIdx < 0) { nextFieldIdx = allFields.length - 1; nextRowIdx = rowIdx - 1 }
    if (nextFieldIdx >= allFields.length) { nextFieldIdx = 0; nextRowIdx = rowIdx + 1 }
    if (nextRowIdx < 0 || nextRowIdx >= sorted.length) { setEditCell(null); return }
    setEditCell({ id: sorted[nextRowIdx].id, field: allFields[nextFieldIdx] })
  }

  const allSelected  = deals.length > 0 && deals.every(d => selectedIds.has(d.id))
  const someSelected = deals.some(d => selectedIds.has(d.id))
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected && !allSelected
  }, [someSelected, allSelected])

  function toggleSort(key: string) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  const sorted = [...deals].sort((a, b) => {
    let av: string | number = '', bv: string | number = ''
    if (sortKey === 'name')        { av = a.name;                     bv = b.name }
    if (sortKey === 'pipeline')    { av = getDealPipelineKey(a) || ''; bv = getDealPipelineKey(b) || '' }
    if (sortKey === 'status')      { av = a.status;                   bv = b.status }
    if (sortKey === 'loan_officer'){ av = a.loan_officer || '';        bv = b.loan_officer || '' }
    if (sortKey === 'loan_amount') { av = a.loan_amount || 0;          bv = b.loan_amount || 0 }
    if (sortKey === 'loan_type')   { av = a.loan_type || '';           bv = b.loan_type || '' }
    if (sortKey === 'age')         { av = getDealAge(a);               bv = getDealAge(b) }
    if (sortKey === 'ltv')         { av = a.ltv || 0;                  bv = b.ltv || 0 }
    if (sortKey === 'credit_score'){ av = a.credit_score || 0;         bv = b.credit_score || 0 }
    if (sortKey === 'investor')    { av = a.investor || '';            bv = b.investor || '' }
    if (sortKey === 'source')      { av = a.source || '';             bv = b.source || '' }
    const cmp = av < bv ? -1 : av > bv ? 1 : 0
    return sortDir === 'asc' ? cmp : -cmp
  })

  // Sortable column header
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

  // Static (non-sortable) column header
  function ThStatic({ label }: { label: string }) {
    return (
      <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wide px-4 py-3 whitespace-nowrap">
        {label}
      </th>
    )
  }

  const col = (key: ColKey) => visibleCols.has(key)
  const colSpan = 2 + ALL_COLS.filter(c => visibleCols.has(c.key)).length

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-x-auto">
        <table className="w-full border-collapse">
          <thead className="bg-slate-50 border-b border-slate-200 sticky top-0 z-10">
            <tr>
              <th className="px-4 py-3 w-10">
                <input ref={selectAllRef} type="checkbox" checked={allSelected}
                  onChange={() => allSelected ? onClearAll() : onSelectAll(sorted.map(d => d.id))}
                  className="w-4 h-4 rounded accent-blue-600 cursor-pointer" />
              </th>
              {/* Name always visible */}
              <Th label="Name" k="name" />
              {col('pipeline')         && <Th label="Pipeline"      k="pipeline" />}
              {col('status')           && <Th label="Status"        k="status" />}
              {col('loan_officer')     && <Th label="LO"            k="loan_officer" />}
              {col('loan_type')        && <Th label="Loan Type"     k="loan_type" />}
              {col('loan_amount')      && <Th label="Amount"        k="loan_amount" />}
              {col('ltv')              && <Th label="LTV"           k="ltv" />}
              {col('credit_score')     && <Th label="FICO"          k="credit_score" />}
              {col('investor')         && <Th label="Lender"        k="investor" />}
              {col('lock_exp')         && <ThStatic label="Lock Exp" />}
              {col('age')              && <Th label="Age"           k="age" />}
              {col('source')           && <Th label="Source"        k="source" />}
              {col('rate')             && <ThStatic label="Rate" />}
              {col('email')            && <ThStatic label="Email" />}
              {col('phone')            && <ThStatic label="Phone" />}
              {col('property_address') && <ThStatic label="Property" />}
              {col('occupancy')        && <ThStatic label="Occupancy" />}
              {col('loan_purpose')     && <ThStatic label="Purpose" />}
              {col('credit_rating')    && <ThStatic label="Credit Rating" />}
              {col('signing_date')     && <ThStatic label="Signing Date" />}
              {col('funded_date')      && <ThStatic label="Funded Date" />}
              {col('arive_file_no')    && <ThStatic label="Arive #" />}
              {col('processor')        && <ThStatic label="Processor" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sorted.map(deal => {
              const pkey     = getDealPipelineKey(deal) || '—'
              const age      = getDealAge(deal)
              const lockDays = getLockDaysLeft(deal)
              const ageColor  = age <= 7 ? 'text-emerald-600' : age <= 14 ? 'text-amber-600' : 'text-red-600'
              const lockColor = lockDays === null ? '' : lockDays <= 7 ? 'text-red-600' : lockDays <= 14 ? 'text-amber-600' : 'text-emerald-600'
              const statusClass = STATUS_COLORS[deal.status] || 'bg-gray-100 text-gray-600'

              function ec(field: string) {
                return editCell?.id === deal.id && editCell.field === field
              }
              function ic(field: string, value: unknown, type: InlineCellProps['type'], opts?: readonly string[], stepVal?: string, display?: React.ReactNode) {
                return (
                  <InlineCell
                    deal={deal} field={field} value={value} type={type}
                    options={opts} step={stepVal}
                    isEditing={ec(field)}
                    onStartEdit={() => startEdit(deal.id, field)}
                    onSave={v => saveEdit(deal.id, field, v)}
                    onCancel={cancelEdit}
                    onTab={(shift) => tabEdit(deal.id, field, shift)}
                    displayRender={display}
                  />
                )
              }

              return (
                <tr key={deal.id} className={`hover:bg-slate-50 transition-colors group ${selectedIds.has(deal.id) ? 'bg-blue-50/60' : ''}`}>
                  <td className="px-4 py-3 w-10">
                    <input type="checkbox" checked={selectedIds.has(deal.id)} onChange={() => onToggleSelect(deal.id)}
                      className="w-4 h-4 rounded accent-blue-600 cursor-pointer" />
                  </td>
                  {/* Name always visible */}
                  <td className="px-4 py-3 font-semibold text-slate-900 whitespace-nowrap min-w-[160px]">
                    {ec('name') ? (
                      <InlineCell
                        deal={deal} field="name" value={deal.name} type="text"
                        isEditing
                        onStartEdit={() => startEdit(deal.id, 'name')}
                        onSave={v => saveEdit(deal.id, 'name', v)}
                        onCancel={cancelEdit}
                        onTab={(shift) => tabEdit(deal.id, 'name', shift)}
                      />
                    ) : (
                      <div className="flex items-center gap-1 group/name">
                        <Link href={`/deals/${deal.id}`} className="hover:text-blue-700 transition-colors">{deal.name}</Link>
                        <button
                          onClick={() => startEdit(deal.id, 'name')}
                          className="opacity-0 group-hover/name:opacity-100 p-0.5 text-slate-400 hover:text-blue-500 transition-all"
                          title="Edit name"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                      </div>
                    )}
                  </td>
                  {col('pipeline') && (
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="flex items-center gap-1.5 text-xs text-slate-600">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${STAGE_DOT[pkey] || 'bg-slate-300'}`} />{pkey}
                      </span>
                    </td>
                  )}
                  {col('status') && (
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="relative inline-block">
                        <button onClick={() => setOpenMenu(openMenu === deal.id ? null : deal.id)}
                          className={`text-xs px-2 py-1 rounded-md font-medium flex items-center gap-0.5 ${statusClass}`}>
                          {deal.status}<ChevronDown className="w-2.5 h-2.5 ml-0.5" />
                        </button>
                        {openMenu === deal.id && (
                          <div className="absolute left-0 top-full mt-1 z-50 flex flex-col bg-white rounded-xl shadow-xl border border-slate-200 py-1 w-56 max-h-64 overflow-y-auto whitespace-normal">
                            <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-100 shrink-0">
                              <span className="text-xs font-semibold text-slate-500">Change Status</span>
                              <button onClick={() => setOpenMenu(null)}><X className="w-3 h-3 text-slate-400" /></button>
                            </div>
                            {LOAN_STATUSES.map(s => (
                              <button key={s} onClick={() => { onStatusChange(deal.id, s); setOpenMenu(null) }}
                                className={`block w-full text-left text-xs px-3 py-1.5 hover:bg-slate-50 transition-colors ${s === deal.status ? 'font-semibold text-blue-600' : 'text-slate-700'}`}>
                                {s}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </td>
                  )}
                  {col('loan_officer') && (
                    <td className="px-4 py-3 whitespace-nowrap min-w-[110px]">
                      {ic('loan_officer', deal.loan_officer, 'select', ['Matt', 'Moe Sefati', 'Randy Mathis'])}
                    </td>
                  )}
                  {col('loan_type') && (
                    <td className="px-4 py-3 whitespace-nowrap min-w-[140px]">
                      {ic('loan_type', deal.loan_type, 'select', LOAN_TYPES,
                        undefined,
                        deal.loan_type
                          ? <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded font-medium">{deal.loan_type}</span>
                          : <span className="text-slate-300">—</span>
                      )}
                    </td>
                  )}
                  {col('loan_amount') && (
                    <td className="px-4 py-3 whitespace-nowrap min-w-[110px]">
                      {ic('loan_amount', deal.loan_amount, 'currency',
                        undefined, undefined,
                        deal.loan_amount
                          ? <span className="text-sm font-semibold text-slate-800">{formatCurrency(deal.loan_amount)}</span>
                          : <span className="text-slate-300">—</span>
                      )}
                    </td>
                  )}
                  {col('ltv') && (
                    <td className="px-4 py-3 whitespace-nowrap min-w-[70px]">
                      {ic('ltv', deal.ltv, 'percent',
                        undefined, '0.01',
                        deal.ltv != null
                          ? <span className="text-sm text-slate-500">{deal.ltv.toFixed(0)}%</span>
                          : <span className="text-slate-300">—</span>
                      )}
                    </td>
                  )}
                  {col('credit_score') && (
                    <td className="px-4 py-3 whitespace-nowrap min-w-[70px]">
                      {ic('credit_score', deal.credit_score, 'number')}
                    </td>
                  )}
                  {col('investor') && (
                    <td className="px-4 py-3 whitespace-nowrap min-w-[100px]">
                      {ic('investor', deal.investor, 'text')}
                    </td>
                  )}
                  {col('lock_exp') && (
                    <td className="px-4 py-3 whitespace-nowrap">
                      {lockDays !== null ? (
                        <span className={`flex items-center gap-1 text-xs font-medium ${lockColor}`}>
                          <Lock className="w-3 h-3" />{lockDays <= 0 ? 'EXPIRED' : `${lockDays}d`}
                        </span>
                      ) : <span className="text-slate-300 text-xs">—</span>}
                    </td>
                  )}
                  {col('age') && (
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={`flex items-center gap-1 text-xs font-medium ${ageColor}`}>
                        <Clock className="w-3 h-3" />{age === 0 ? 'Today' : `${age}d`}
                      </span>
                    </td>
                  )}
                  {col('source') && (
                    <td className="px-4 py-3 whitespace-nowrap"><SourceBadge deal={deal} /></td>
                  )}
                  {col('rate') && (
                    <td className="px-4 py-3 whitespace-nowrap min-w-[80px]">
                      {ic('rate', deal.rate, 'percent',
                        undefined, '0.001',
                        deal.rate != null
                          ? <span className="text-sm text-slate-500">{deal.rate}%</span>
                          : <span className="text-slate-300">—</span>
                      )}
                    </td>
                  )}
                  {col('email') && (
                    <td className="px-4 py-3 whitespace-nowrap min-w-[160px]">
                      {ic('email', deal.email, 'email')}
                    </td>
                  )}
                  {col('phone') && (
                    <td className="px-4 py-3 whitespace-nowrap min-w-[120px]">
                      {ic('phone', deal.phone, 'tel')}
                    </td>
                  )}
                  {col('property_address') && (
                    <td className="px-4 py-3 whitespace-nowrap min-w-[180px] max-w-[220px]">
                      {ic('property_address', deal.property_address, 'text')}
                    </td>
                  )}
                  {col('occupancy') && (
                    <td className="px-4 py-3 whitespace-nowrap min-w-[110px]">
                      {ic('occupancy', deal.occupancy, 'select', OCCUPANCY_TYPES)}
                    </td>
                  )}
                  {col('loan_purpose') && (
                    <td className="px-4 py-3 whitespace-nowrap min-w-[140px]">
                      {ic('loan_purpose', deal.loan_purpose, 'select', ['Purchase', 'Refinance'] as const)}
                    </td>
                  )}
                  {col('credit_rating') && (
                    <td className="px-4 py-3 whitespace-nowrap min-w-[110px]">
                      {ic('credit_rating', deal.credit_rating, 'select', ['Excellent', 'Good', 'Fair', 'Poor'] as const)}
                    </td>
                  )}
                  {col('signing_date') && (
                    <td className="px-4 py-3 whitespace-nowrap min-w-[130px]">
                      {ic('signing_date', deal.signing_date, 'date',
                        undefined, undefined,
                        deal.signing_date
                          ? <span className="text-sm text-slate-500">{formatDate(deal.signing_date)}</span>
                          : <span className="text-slate-300">—</span>
                      )}
                    </td>
                  )}
                  {col('funded_date') && (
                    <td className="px-4 py-3 whitespace-nowrap min-w-[130px]">
                      {ic('funded_date', deal.funded_date, 'date',
                        undefined, undefined,
                        deal.funded_date
                          ? <span className="text-sm text-slate-500">{formatDate(deal.funded_date)}</span>
                          : <span className="text-slate-300">—</span>
                      )}
                    </td>
                  )}
                  {col('arive_file_no') && (
                    <td className="px-4 py-3 whitespace-nowrap min-w-[90px]">
                      {ic('arive_file_no', deal.arive_file_no, 'text', undefined, undefined,
                        deal.arive_file_no ? (
                          <span className="flex items-center gap-1.5 text-sm text-slate-600">
                            {deal.arive_file_no}
                            <a
                              href={ariveUrl(deal.arive_file_no)!}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={e => e.stopPropagation()}
                              title="Open in Arive"
                              className="text-emerald-600 hover:text-emerald-700 shrink-0"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          </span>
                        ) : undefined
                      )}
                    </td>
                  )}
                  {col('processor') && (
                    <td className="px-4 py-3 whitespace-nowrap min-w-[100px]">
                      {ic('processor', deal.processor, 'text')}
                    </td>
                  )}
                </tr>
              )
            })}
            {sorted.length === 0 && (
              <tr><td colSpan={colSpan} className="px-4 py-12 text-center text-slate-400 text-sm">No deals match current filters</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Master Filter type ────────────────────────────────────────────────────────
type MasterFilter = {
  statuses: Set<string>
  loanTypes: Set<string>
  sources: Set<string>
  loanAmountMin: string; loanAmountMax: string
  creditScoreMin: string; creditScoreMax: string
  rateMin: string; rateMax: string
  ltvMin: string; ltvMax: string
  occupancies: Set<string>
  isMilitary: 'any' | 'yes' | 'no'
}

function emptyMasterFilter(): MasterFilter {
  return {
    statuses: new Set(), loanTypes: new Set(), sources: new Set(),
    loanAmountMin: '', loanAmountMax: '',
    creditScoreMin: '', creditScoreMax: '',
    rateMin: '', rateMax: '',
    ltvMin: '', ltvMax: '',
    occupancies: new Set(),
    isMilitary: 'any',
  }
}

// ── Saved view type ───────────────────────────────────────────────────────────
type SavedView = {
  id: string; name: string
  loFilters?: string[]     // multi-select LO selection (current)
  loFilter?: string        // legacy single-select, still read from old saved views
  sourceFilter: string; statusFilter: string
  hideFunded: boolean; layoutView: 'board' | 'list'
  visiblePipelines: string[]
}
const VIEWS_KEY = 'lumin_pipeline_views'

// Older saved views stored one loFilter string ('All' | 'Matt' | 'Moe Sefati' | …);
// map those onto the multi-select array so existing views keep working.
function loFiltersFromView(v: SavedView): string[] {
  if (Array.isArray(v.loFilters)) return v.loFilters
  if (!v.loFilter || v.loFilter === 'All') return [...LOAN_OFFICERS]
  const canon = resolveLO(v.loFilter)
  return canon ? [canon] : [...LOAN_OFFICERS]
}

// ── Main Page ─────────────────────────────────────────────────────────────────
function PipelinePageInner() {
  const searchParams = useSearchParams()
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [textSearch, setTextSearch] = useState(searchParams.get('search') || '')
  const { selectedLOs, setSelectedLOs, toggleLO, allLOsSelected } = useLoFilter()
  const [sourceFilter, setSourceFilter] = useState('All')
  const [statusFilter, setStatusFilter] = useState('All')
  const [hideFunded, setHideFunded] = useState(false)
  const [layoutView, setLayoutView] = useState<'board' | 'list'>('list')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [savedViews, setSavedViews] = useState<SavedView[]>([])
  const [activeViewId, setActiveViewId] = useState<string | null>(null)
  const [showSaveModal, setShowSaveModal] = useState(false)
  const [newViewName, setNewViewName] = useState('')
  // Pipeline visibility
  // Default: show only Leads (Escrows, Not Ready, Funded are hidden until toggled on).
  // Escrows + Funded each have their own dedicated pages, so the Pipeline view is
  // primarily a Leads workspace by default.
  const [visiblePipelines, setVisiblePipelines] = useState<Set<string>>(
    new Set(['Leads'])
  )
  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showBulkMoveMenu, setShowBulkMoveMenu] = useState(false)
  const [bulkWorking, setBulkWorking] = useState(false)
  // Column picker
  const [visibleCols, setVisibleCols] = useState<Set<string>>(defaultVisibleCols)
  const [showColPicker, setShowColPicker] = useState(false)
  const colPickerRef = useRef<HTMLDivElement>(null)
  // Master filter panel
  const [showFilterPanel, setShowFilterPanel] = useState(false)
  const [masterFilter, setMasterFilter] = useState<MasterFilter>(emptyMasterFilter)
  // GHL Sync
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<{ synced: number; created: number; updated: number } | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  // Bulk edit
  const [bulkEditField, setBulkEditField] = useState<string | null>(null)
  const [bulkEditValue, setBulkEditValue] = useState('')
  const bulkEditRef = useRef<HTMLDivElement>(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  const fetchDeals = useCallback(async () => {
    setLoading(true)
    const all = await fetchAllDeals(q => q
      .not('pipeline_group', 'in', '("Lost","Last files at WCL","Lost/Inactive/Does not qualify","Nurture")')
      .order('created_at', { ascending: false }),
      DEAL_COLUMNS,   // skip the raw_ghl_data blob (~52% of payload, unused here)
    )
    setDeals(all)
    setLoading(false)
  }, [])

  useEffect(() => { fetchDeals() }, [fetchDeals])

  useEffect(() => {
    try {
      const stored = localStorage.getItem(VIEWS_KEY)
      if (stored) setSavedViews(JSON.parse(stored))
    } catch { /* ignore */ }
  }, [])

  // Init visible cols from localStorage
  useEffect(() => {
    setVisibleCols(loadVisibleCols())
  }, [])

  // Close col picker on outside click
  useEffect(() => {
    if (!showColPicker) return
    function handler(e: MouseEvent) {
      if (colPickerRef.current && !colPickerRef.current.contains(e.target as Node)) {
        setShowColPicker(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showColPicker])

  const availableSources = ['All', ...Array.from(new Set(deals.map(d => d.source).filter(Boolean) as string[])).sort()]

  // ── Saved view helpers ────────────────────────────────────────────────────
  function saveView() {
    if (!newViewName.trim()) return
    const view: SavedView = {
      id: Date.now().toString(),
      name: newViewName.trim(),
      loFilters: selectedLOs, sourceFilter, statusFilter, hideFunded, layoutView,
      visiblePipelines: Array.from(visiblePipelines),
    }
    const updated = [...savedViews, view]
    setSavedViews(updated)
    localStorage.setItem(VIEWS_KEY, JSON.stringify(updated))
    setNewViewName(''); setShowSaveModal(false); setActiveViewId(view.id)
  }

  function loadView(view: SavedView) {
    setSelectedLOs(loFiltersFromView(view)); setSourceFilter(view.sourceFilter)
    setStatusFilter(view.statusFilter); setHideFunded(view.hideFunded)
    setLayoutView(view.layoutView)
    setVisiblePipelines(new Set(view.visiblePipelines || PIPELINE_CONFIG.map(p => p.key)))
    setActiveViewId(view.id)
  }

  function deleteView(id: string) {
    const updated = savedViews.filter(v => v.id !== id)
    setSavedViews(updated)
    localStorage.setItem(VIEWS_KEY, JSON.stringify(updated))
    if (activeViewId === id) setActiveViewId(null)
  }

  function clearFilters() {
    setSelectedLOs([...LOAN_OFFICERS]); setSourceFilter('All'); setStatusFilter('All')
    setHideFunded(false); setActiveViewId(null)
    // Reset to default visibility: Leads + Escrows only
    setVisiblePipelines(new Set(['Leads', 'Escrows']))
    setMasterFilter(emptyMasterFilter())
  }

  // Column picker helpers
  function handleColToggle(key: string) {
    setVisibleCols(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify(Array.from(next)))
      return next
    })
  }

  function resetColsToDefaults() {
    const def = defaultVisibleCols()
    setVisibleCols(def)
    localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify(Array.from(def)))
  }

  // Master filter active count
  const masterFilterCount =
    masterFilter.statuses.size +
    masterFilter.loanTypes.size +
    masterFilter.sources.size +
    masterFilter.occupancies.size +
    (masterFilter.loanAmountMin || masterFilter.loanAmountMax ? 1 : 0) +
    (masterFilter.creditScoreMin || masterFilter.creditScoreMax ? 1 : 0) +
    (masterFilter.rateMin || masterFilter.rateMax ? 1 : 0) +
    (masterFilter.ltvMin || masterFilter.ltvMax ? 1 : 0) +
    (masterFilter.isMilitary !== 'any' ? 1 : 0)

  // Master filter toggle helpers
  function mfToggleSet(field: 'statuses' | 'loanTypes' | 'sources' | 'occupancies', value: string) {
    setMasterFilter(prev => {
      const next = new Set(prev[field])
      if (next.has(value)) next.delete(value); else next.add(value)
      return { ...prev, [field]: next }
    })
  }

  // Toggle pipeline visibility — keep at least one always visible
  function togglePipeline(key: string) {
    setVisiblePipelines(prev => {
      if (prev.has(key) && prev.size === 1) return prev // can't hide the last one
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
    setSelectedIds(new Set())
    setActiveViewId(null)
  }

  // Default visible set is Leads only — only consider pipelines "filtered" if it differs from that
  const defaultVisible = ['Leads']
  const isDefaultPipelineSet =
    visiblePipelines.size === defaultVisible.length &&
    defaultVisible.every(k => visiblePipelines.has(k))
  const filtersActive = !allLOsSelected || sourceFilter !== 'All' || statusFilter !== 'All' || hideFunded
    || !isDefaultPipelineSet

  // ── Pipeline counts for pills (respects LO/source/status filters) ─────────
  const pipelineCount: Record<string, number> = {}
  PIPELINE_CONFIG.forEach(p => { pipelineCount[p.key] = 0 })
  deals.forEach(d => {
    const key = getDealPipelineKey(d)
    if (!key) return
    if (hideFunded && key === 'Funded') return
    if (!loSelected(d.loan_officer, selectedLOs)) return
    if (sourceFilter !== 'All' && d.source !== sourceFilter) return
    if (statusFilter !== 'All' && d.status !== statusFilter) return
    pipelineCount[key] = (pipelineCount[key] || 0) + 1
  })

  // Active pipelines in display order
  const activePipelines = PIPELINE_CONFIG.filter(p => {
    if (hideFunded && p.key === 'Funded') return false
    return visiblePipelines.has(p.key)
  })

  // All filtered deals
  const filteredDeals = deals.filter(d => {
    const key = getDealPipelineKey(d)
    if (!key || !activePipelines.find(p => p.key === key)) return false
    if (!loSelected(d.loan_officer, selectedLOs)) return false
    if (sourceFilter !== 'All' && d.source !== sourceFilter) return false
    if (statusFilter !== 'All' && d.status !== statusFilter) return false
    if (textSearch) {
      const q = textSearch.toLowerCase()
      const matches =
        d.name?.toLowerCase().includes(q) ||
        d.email?.toLowerCase().includes(q) ||
        d.phone?.toLowerCase().includes(q) ||
        d.property_address?.toLowerCase().includes(q) ||
        d.investor?.toLowerCase().includes(q) ||
        d.arive_file_no?.toLowerCase().includes(q) ||      // Arive Loan ID
        d.investor_file_no?.toLowerCase().includes(q)      // Lender Loan #
      if (!matches) return false
    }
    // Master filter
    const mf = masterFilter
    if (mf.statuses.size > 0 && !mf.statuses.has(d.status)) return false
    if (mf.loanTypes.size > 0 && (!d.loan_type || !mf.loanTypes.has(d.loan_type))) return false
    if (mf.sources.size > 0 && (!d.source || !mf.sources.has(d.source))) return false
    if (mf.occupancies.size > 0 && (!d.occupancy || !mf.occupancies.has(d.occupancy))) return false
    if (mf.loanAmountMin && (d.loan_amount ?? 0) < parseFloat(mf.loanAmountMin)) return false
    if (mf.loanAmountMax && (d.loan_amount ?? 0) > parseFloat(mf.loanAmountMax)) return false
    if (mf.creditScoreMin && (d.credit_score ?? 0) < parseFloat(mf.creditScoreMin)) return false
    if (mf.creditScoreMax && (d.credit_score ?? 0) > parseFloat(mf.creditScoreMax)) return false
    if (mf.rateMin && (d.rate ?? 0) < parseFloat(mf.rateMin)) return false
    if (mf.rateMax && (d.rate ?? 0) > parseFloat(mf.rateMax)) return false
    if (mf.ltvMin && (d.ltv ?? 0) < parseFloat(mf.ltvMin)) return false
    if (mf.ltvMax && (d.ltv ?? 0) > parseFloat(mf.ltvMax)) return false
    if (mf.isMilitary === 'yes' && !d.is_military) return false
    if (mf.isMilitary === 'no' && !!d.is_military) return false
    return true
  })

  const lockAlerts = filteredDeals.filter(d => { const n = getLockDaysLeft(d); return n !== null && n <= 7 }).length
  const staleDeals = filteredDeals.filter(d => getDealAge(d) > 14).length

  // ── GHL Sync ──────────────────────────────────────────────────────────────
  async function handleGHLSync() {
    setSyncing(true); setSyncResult(null); setSyncError(null)
    try {
      const res = await fetch('/api/sync/ghl', { method: 'POST' })
      const data = await res.json() as { success?: boolean; synced?: number; created?: number; updated?: number; error?: string }
      if (!res.ok || !data.success) {
        setSyncError(data.error || 'Sync failed')
      } else {
        setSyncResult({ synced: data.synced ?? 0, created: data.created ?? 0, updated: data.updated ?? 0 })
        await fetchDeals() // refresh board with new data
      }
    } catch (e) {
      setSyncError(String(e))
    } finally {
      setSyncing(false)
    }
  }

  // ── Bulk helpers ──────────────────────────────────────────────────────────
  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  function selectAll(ids: string[]) { setSelectedIds(new Set(ids)) }

  function handleBulkExport() {
    // Export selected deals to CSV — all the columns a loan officer or
    // ops person typically cares about for a stage report.
    const selected = deals.filter(d => selectedIds.has(d.id))
    if (selected.length === 0) return

    const cols: Array<{ header: string; get: (d: Deal) => string | number | null | undefined }> = [
      { header: 'Name',             get: d => d.name },
      { header: 'First Name',       get: d => d.first_name },
      { header: 'Last Name',        get: d => d.last_name },
      { header: 'Email',            get: d => d.email },
      { header: 'Phone',            get: d => d.phone },
      { header: 'Pipeline',         get: d => d.pipeline_group },
      { header: 'Status',           get: d => d.status },
      { header: 'Loan Officer',     get: d => d.loan_officer },
      { header: 'Processor',        get: d => d.processor },
      { header: 'Loan Type',        get: d => d.loan_type },
      { header: 'Loan Purpose',     get: d => d.loan_purpose },
      { header: 'Loan Amount',      get: d => d.loan_amount },
      { header: 'Property Value',   get: d => d.estimated_value },
      { header: 'LTV',              get: d => d.ltv },
      { header: 'Rate',             get: d => d.rate },
      { header: 'Lender',           get: d => d.investor },
      { header: 'FICO',             get: d => d.credit_score },
      { header: 'Credit Rating',    get: d => d.credit_rating },
      { header: 'Occupancy',        get: d => d.occupancy },
      { header: 'Property Address', get: d => d.property_address },
      { header: 'City',             get: d => d.city },
      { header: 'State',            get: d => d.state },
      { header: 'Zip',              get: d => d.zip },
      { header: 'Source',           get: d => d.source },
      { header: 'Lead Source Agg',  get: d => d.lead_source_agg },
      { header: 'Arive File #',     get: d => d.arive_file_no },
      { header: 'Lender Loan #',    get: d => d.investor_file_no },
      { header: 'Lock Expiration',  get: d => d.lock_expiration ? formatDate(d.lock_expiration) : null },
      { header: 'Signing Date',     get: d => d.signing_date ? formatDate(d.signing_date) : null },
      { header: 'Funded Date',      get: d => d.funded_date ? formatDate(d.funded_date) : null },
      { header: 'Last Contacted',   get: d => d.last_contacted ? formatDate(d.last_contacted) : null },
      { header: 'Next Action',      get: d => d.next_action },
      { header: 'Next Action Due',  get: d => d.next_action_due ? new Date(d.next_action_due).toLocaleString() : null },
      { header: 'Next Action Assignee', get: d => d.next_action_assignee },
      { header: 'Waiting On',       get: d => d.waiting_on },
      { header: 'Date Added',       get: d => d.created_at ? new Date(d.created_at).toLocaleDateString() : null },
      { header: 'Date Added GHL',   get: d => d.date_added_ghl ? new Date(d.date_added_ghl).toLocaleDateString() : null },
    ]

    const escape = (v: unknown): string => {
      if (v === null || v === undefined || v === '') return ''
      const s = String(v)
      // RFC 4180: wrap in quotes if contains comma, quote, or newline; double internal quotes
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
      return s
    }

    const rows = [
      cols.map(c => escape(c.header)).join(','),
      ...selected.map(d => cols.map(c => escape(c.get(d))).join(',')),
    ]
    // Prepend BOM so Excel opens UTF-8 correctly
    const csv = '﻿' + rows.join('\r\n')

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const ts = new Date().toISOString().slice(0, 10)
    a.href = url
    a.download = `lumin-pipeline-${ts}-${selected.length}-deals.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  async function handleBulkDelete() {
    if (!window.confirm(`Permanently delete ${selectedIds.size} deal${selectedIds.size > 1 ? 's' : ''}? This cannot be undone.`)) return
    setBulkWorking(true)
    const ids = Array.from(selectedIds)
    await supabase.from('deals').delete().in('id', ids)
    setDeals(prev => prev.filter(d => !selectedIds.has(d.id)))
    setSelectedIds(new Set()); setBulkWorking(false)
  }

  async function handleBulkMove(targetGroup: string, targetStatus: string) {
    setBulkWorking(true)
    const ids = Array.from(selectedIds)
    await supabase.from('deals').update({ pipeline_group: targetGroup, status: targetStatus }).in('id', ids)
    setDeals(prev => prev.map(d => selectedIds.has(d.id)
      ? { ...d, pipeline_group: targetGroup, status: targetStatus, updated_at: new Date().toISOString() }
      : d
    ))
    // Push each affected deal's new stage to GHL, throttled to stay friendly
    // to their rate limits.
    ;(async () => {
      for (const id of ids) {
        await pushStageToGHL(id, targetStatus)
        await new Promise(r => setTimeout(r, 150))
      }
    })()
    setSelectedIds(new Set()); setShowBulkMoveMenu(false); setBulkWorking(false)
  }

  async function handleBulkEditApply() {
    if (!bulkEditField || bulkEditField === 'menu' || bulkEditValue === '') return
    const field = BULK_EDIT_FIELDS.find(f => f.key === bulkEditField)
    if (!field) return

    setBulkWorking(true)
    const ids = Array.from(selectedIds)

    // Coerce the string input to the right shape for the column type
    let value: string | number | null = bulkEditValue
    if (field.type === 'number' || field.type === 'currency' || field.type === 'percent') {
      const n = Number(bulkEditValue)
      value = Number.isNaN(n) ? null : n
    }
    if (field.type === 'datetime-local') {
      // datetime-local gives us local time; convert to ISO
      const d = new Date(bulkEditValue)
      value = isNaN(d.getTime()) ? null : d.toISOString()
    }

    await supabase.from('deals').update({ [bulkEditField]: value }).in('id', ids)
    setDeals(prev => prev.map(d =>
      selectedIds.has(d.id) ? { ...d, [bulkEditField]: value, updated_at: new Date().toISOString() } : d
    ))
    setSelectedIds(new Set()); setBulkEditField(null); setBulkEditValue(''); setBulkEditSearch(''); setBulkWorking(false)
  }

  type BulkField = {
    key: string; label: string; category: string
    type: 'date' | 'datetime-local' | 'select' | 'text' | 'number' | 'currency' | 'percent'
    icon: React.ReactNode
    options?: readonly string[] | string[]
    placeholder?: string
  }
  const BULK_EDIT_FIELDS: BulkField[] = [
    // Workflow
    { key: 'status',               label: 'Status',           category: 'Workflow', type: 'select',         icon: <Tag className="w-3.5 h-3.5 text-violet-500" />,        options: LOAN_STATUSES },
    { key: 'loan_officer',         label: 'Loan Officer',     category: 'Workflow', type: 'select',         icon: <User className="w-3.5 h-3.5 text-violet-500" />,       options: LOAN_OFFICERS },
    { key: 'processor_status',     label: 'Processor',        category: 'Workflow', type: 'select',         icon: <User className="w-3.5 h-3.5 text-cyan-500" />,         options: [...PROCESSORS] },
    { key: 'next_action_assignee', label: 'Assigned To',      category: 'Workflow', type: 'select',         icon: <User className="w-3.5 h-3.5 text-blue-500" />,         options: [...LOAN_OFFICERS, 'Efrain Ramirez', 'Brianne Han'] },
    { key: 'next_action_due',      label: 'Follow-up Date',   category: 'Workflow', type: 'datetime-local', icon: <Clock className="w-3.5 h-3.5 text-orange-500" /> },
    { key: 'escrow_priority',      label: 'Priority',         category: 'Workflow', type: 'select',         icon: <Flame className="w-3.5 h-3.5 text-red-500" />,         options: ['high', 'normal', 'low'] },
    { key: 'waiting_on',           label: 'Waiting On',       category: 'Workflow', type: 'select',         icon: <AlertOctagon className="w-3.5 h-3.5 text-amber-500" />, options: WAITING_ON_OPTIONS },
    // Loan
    { key: 'loan_type',            label: 'Loan Type',        category: 'Loan',     type: 'select',         icon: <DollarSign className="w-3.5 h-3.5 text-emerald-500" />, options: LOAN_TYPES },
    { key: 'loan_purpose',         label: 'Loan Purpose',     category: 'Loan',     type: 'select',         icon: <DollarSign className="w-3.5 h-3.5 text-emerald-500" />, options: ['Purchase', 'Refinance'] },
    { key: 'loan_amount',          label: 'Loan Amount',      category: 'Loan',     type: 'currency',       icon: <DollarSign className="w-3.5 h-3.5 text-emerald-500" /> },
    { key: 'estimated_value',      label: 'Property Value',   category: 'Loan',     type: 'currency',       icon: <DollarSign className="w-3.5 h-3.5 text-emerald-500" /> },
    { key: 'rate',                 label: 'Rate',             category: 'Loan',     type: 'percent',        icon: <Activity className="w-3.5 h-3.5 text-blue-500" /> },
    { key: 'investor',             label: 'Lender',           category: 'Loan',     type: 'text',           icon: <Building2 className="w-3.5 h-3.5 text-amber-500" />,    placeholder: 'e.g. UWM, PennyMac, Rocket' },
    { key: 'broker_corr',          label: 'Broker / Corr.',   category: 'Loan',     type: 'select',         icon: <Briefcase className="w-3.5 h-3.5 text-slate-500" />,    options: ['Broker', 'Correspondent'] },
    { key: 'source',               label: 'Source',           category: 'Loan',     type: 'select',         icon: <Tag className="w-3.5 h-3.5 text-cyan-500" />,           options: ['GHL', 'Self Source', 'Referral', 'Past Client', 'Open House', 'Agent Partner', 'Financial Advisor', 'Builder', 'Online / Social', 'Lendgo', 'FRU', 'Lending Tree'] },
    // Borrower
    { key: 'credit_score',         label: 'Credit Score',     category: 'Borrower', type: 'number',         icon: <Star className="w-3.5 h-3.5 text-emerald-500" /> },
    { key: 'credit_rating',        label: 'Credit Rating',    category: 'Borrower', type: 'select',         icon: <Star className="w-3.5 h-3.5 text-emerald-500" />,      options: ['Excellent', 'Good', 'Fair', 'Poor'] },
    // Property
    { key: 'property_type',        label: 'Property Type',    category: 'Property', type: 'select',         icon: <Home className="w-3.5 h-3.5 text-orange-500" />,        options: ['Single Family', 'Manufactured', 'Condo', 'Townhouse', 'Multi-Family (2-4)', 'Commercial', 'Land'] },
    { key: 'occupancy',            label: 'Occupancy',        category: 'Property', type: 'select',         icon: <Home className="w-3.5 h-3.5 text-orange-500" />,        options: OCCUPANCY_TYPES },
    { key: 'city',                 label: 'City',             category: 'Property', type: 'text',           icon: <MapPin className="w-3.5 h-3.5 text-slate-500" /> },
    { key: 'state',                label: 'State',            category: 'Property', type: 'text',           icon: <MapPin className="w-3.5 h-3.5 text-slate-500" />,       placeholder: '2-letter (e.g. CA)' },
    { key: 'zip',                  label: 'Zip',              category: 'Property', type: 'text',           icon: <MapPin className="w-3.5 h-3.5 text-slate-500" /> },
    // Lock & Appraisal
    { key: 'locked',               label: 'Locked?',          category: 'Lock & Appraisal', type: 'select', icon: <Lock className="w-3.5 h-3.5 text-emerald-500" />,       options: ['No', 'Yes', 'NA'] },
    { key: 'lock_expiration',      label: 'Lock Expiration',  category: 'Lock & Appraisal', type: 'date',   icon: <Lock className="w-3.5 h-3.5 text-emerald-500" /> },
    { key: 'appraisal_status',     label: 'Appraisal Status', category: 'Lock & Appraisal', type: 'select', icon: <Home className="w-3.5 h-3.5 text-slate-500" />,         options: APPRAISAL_STATUSES },
    // File Numbers
    { key: 'arive_file_no',        label: 'Arive File #',     category: 'Files',    type: 'text',           icon: <Hash className="w-3.5 h-3.5 text-slate-500" /> },
    { key: 'investor_file_no',     label: 'Lender Loan #',    category: 'Files',    type: 'text',           icon: <Hash className="w-3.5 h-3.5 text-slate-500" /> },
    // Contact
    { key: 'email',                label: 'Email',            category: 'Contact',  type: 'text',           icon: <Mail className="w-3.5 h-3.5 text-blue-500" /> },
    { key: 'phone',                label: 'Phone',            category: 'Contact',  type: 'text',           icon: <Phone className="w-3.5 h-3.5 text-emerald-500" /> },
    // Dates
    { key: 'signing_date',         label: 'Signing Date',     category: 'Dates',    type: 'date',           icon: <Calendar className="w-3.5 h-3.5 text-blue-500" /> },
    { key: 'funded_date',          label: 'Funded Date',      category: 'Dates',    type: 'date',           icon: <Calendar className="w-3.5 h-3.5 text-emerald-500" /> },
    { key: 'paid_date',            label: 'Paid Date',        category: 'Dates',    type: 'date',           icon: <Calendar className="w-3.5 h-3.5 text-emerald-500" /> },
    { key: 'last_contacted',       label: 'Last Contacted',   category: 'Dates',    type: 'date',           icon: <Calendar className="w-3.5 h-3.5 text-slate-500" /> },
  ]
  const activeBulkField = BULK_EDIT_FIELDS.find(f => f.key === bulkEditField)

  // Search the bulk-edit menu for fast access when there are 30+ fields
  const [bulkEditSearch, setBulkEditSearch] = useState('')
  const filteredBulkFields = useMemo(() => {
    if (!bulkEditSearch.trim()) return BULK_EDIT_FIELDS
    const q = bulkEditSearch.toLowerCase().trim()
    return BULK_EDIT_FIELDS.filter(f =>
      f.label.toLowerCase().includes(q) || f.category.toLowerCase().includes(q),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkEditSearch])

  // Group fields by category for rendering
  const bulkFieldsByCategory = useMemo(() => {
    const groups: Record<string, BulkField[]> = {}
    for (const f of filteredBulkFields) (groups[f.category] ??= []).push(f)
    return groups
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredBulkFields])

  // ── Status + pipeline change ──────────────────────────────────────────────
  async function handleStatusChange(dealId: string, newStatus: string) {
    const deal = deals.find(d => d.id === dealId)
    if (!deal) return
    const currentPipeline = PIPELINE_CONFIG.find(p => p.key === getDealPipelineKey(deal))
    const newPipeline = currentPipeline?.stages.includes(newStatus)
      ? currentPipeline
      : PIPELINE_CONFIG.find(p => p.stages.includes(newStatus))
    if (!newPipeline) return
    const newGroup = resolvePipelineGroup(newStatus, newPipeline)
    setDeals(prev => prev.map(d => d.id === dealId
      ? { ...d, status: newStatus, pipeline_group: newGroup, updated_at: new Date().toISOString() }
      : d
    ))
    await supabase.from('deals').update({ status: newStatus, pipeline_group: newGroup }).eq('id', dealId)
    void pushStageToGHL(dealId, newStatus)
  }

  // ── Inline cell update ────────────────────────────────────────────────────
  async function handleCellUpdate(id: string, field: string, value: unknown) {
    setDeals(prev => prev.map(d =>
      d.id === id ? { ...d, [field]: value, updated_at: new Date().toISOString() } : d
    ))
    await supabase.from('deals').update({ [field]: value }).eq('id', id)
    if (field === 'status' && typeof value === 'string') {
      void pushStageToGHL(id, value)
    }
  }

  function handleDragStart(event: DragStartEvent) { setActiveId(event.active.id as string) }
  function handleDragOver(event: { over: { id: string } | null }) { setOverId(event.over?.id ?? null) }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    setActiveId(null); setOverId(null)
    if (!over) return
    // droppableId format: "PipelineKey:Stage Name"
    const droppableId = over.id as string
    const colonIdx = droppableId.indexOf(':')
    if (colonIdx === -1) return
    const pipelineKey = droppableId.slice(0, colonIdx)
    const stageName   = droppableId.slice(colonIdx + 1)
    const pipeline = PIPELINE_CONFIG.find(p => p.key === pipelineKey)
    if (!pipeline || !pipeline.stages.includes(stageName)) return
    const deal = deals.find(d => d.id === active.id)
    if (!deal) return
    if (getDealPipelineKey(deal) === pipelineKey && deal.status === stageName) return
    const newGroup = resolvePipelineGroup(stageName, pipeline)
    setDeals(prev => prev.map(d => d.id === deal.id
      ? { ...d, status: stageName, pipeline_group: newGroup, updated_at: new Date().toISOString() }
      : d
    ))
    await supabase.from('deals').update({ status: stageName, pipeline_group: newGroup }).eq('id', deal.id)
    void pushStageToGHL(deal.id, stageName)
  }

  const activeDeal = activeId ? deals.find(d => d.id === activeId) : null
  const activeDealPipeline = activeDeal ? PIPELINE_CONFIG.find(p => p.key === getDealPipelineKey(activeDeal)) : null

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
              <div className="flex items-center bg-slate-100 rounded-lg p-0.5 gap-0.5">
                <button onClick={() => setLayoutView('board')} title="Board view"
                  className={`p-1.5 rounded-md transition-colors ${layoutView === 'board' ? 'bg-white text-slate-700 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}>
                  <LayoutGrid className="w-4 h-4" />
                </button>
                <button onClick={() => setLayoutView('list')} title="List view"
                  className={`p-1.5 rounded-md transition-colors ${layoutView === 'list' ? 'bg-white text-slate-700 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}>
                  <List className="w-4 h-4" />
                </button>
              </div>
              <button onClick={fetchDeals} className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
                <RefreshCw className="w-4 h-4" />
              </button>
              {/* GHL Sync button */}
              <button
                onClick={handleGHLSync}
                disabled={syncing}
                title="Sync all leads from GoHighLevel"
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg border text-sm font-medium transition-all ${
                  syncing
                    ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'
                    : syncResult
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
                    : syncError
                    ? 'bg-red-50 text-red-600 border-red-200 hover:bg-red-100'
                    : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50 hover:border-slate-300'
                }`}
              >
                <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
                {syncing
                  ? 'Syncing…'
                  : syncResult
                  ? `Synced ${syncResult.synced} (${syncResult.created} new)`
                  : syncError
                  ? 'Sync failed'
                  : 'Sync GHL'}
              </button>
            </div>
          </div>

          {/* ── Filter bar ───────────────────────────────────────────────────── */}
          <div className="flex items-center gap-2 flex-wrap">

            {/* Pipeline toggle pills */}
            <div className="flex items-center gap-1.5">
              {PIPELINE_CONFIG.map(p => {
                const isOn = visiblePipelines.has(p.key)
                const count = pipelineCount[p.key] ?? 0
                return (
                  <button
                    key={p.key}
                    onClick={() => togglePipeline(p.key)}
                    title={isOn ? `Hide ${p.key}` : `Show ${p.key}`}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium transition-all ${
                      isOn
                        ? 'bg-slate-900 text-white border-slate-900 shadow-sm'
                        : 'bg-white border-slate-200 text-slate-400 hover:text-slate-600 hover:border-slate-300'
                    }`}
                  >
                    <span className={`w-2 h-2 rounded-full ${p.dot}`} />
                    {p.key}
                    <span className={`text-xs font-semibold px-1.5 py-0.5 rounded-full border ${
                      isOn ? 'bg-white/20 text-white border-white/20' : 'bg-slate-100 text-slate-400 border-slate-200'
                    }`}>{count}</span>
                  </button>
                )
              })}
            </div>

            <div className="h-5 w-px bg-slate-200" />

            {/* Text search */}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
              <input
                type="text"
                value={textSearch}
                onChange={e => setTextSearch(e.target.value)}
                placeholder="Search name, email, address, Arive #, Lender #…"
                className="pl-8 pr-7 py-1.5 border border-slate-200 rounded-lg text-sm w-56 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
              />
              {textSearch && (
                <button onClick={() => setTextSearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            <div className="h-5 w-px bg-slate-200" />

            {/* Filters button (master filter — replaces standalone LO/Source/Stage/Hide-Funded controls) */}
            <button
              onClick={() => setShowFilterPanel(v => !v)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm font-medium transition-colors border relative ${
                masterFilterCount > 0
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'text-slate-500 border-slate-200 hover:border-slate-300 hover:text-slate-700'
              }`}
            >
              <Filter className="w-3.5 h-3.5" /> Filters
              {masterFilterCount > 0 && (
                <span className="ml-0.5 bg-white text-blue-600 text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center leading-none">
                  {masterFilterCount}
                </span>
              )}
            </button>

            {/* Column picker — only in list view */}
            {layoutView === 'list' && (
              <div className="relative" ref={colPickerRef}>
                <button
                  onClick={() => setShowColPicker(v => !v)}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm font-medium transition-colors border ${
                    showColPicker
                      ? 'bg-slate-800 text-white border-slate-800'
                      : 'text-slate-500 border-slate-200 hover:border-slate-300 hover:text-slate-700'
                  }`}
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" /> Columns
                </button>
                {showColPicker && (
                  <div className="absolute left-0 top-full mt-1 z-50 bg-white rounded-xl shadow-xl border border-slate-200 py-2 w-52">
                    <div className="px-3 py-1.5 text-xs font-semibold text-slate-400 uppercase tracking-wide border-b border-slate-100 mb-1">
                      Toggle Columns
                    </div>
                    <div className="max-h-72 overflow-y-auto">
                      {ALL_COLS.map(c => (
                        <label key={c.key} className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-slate-50 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={visibleCols.has(c.key)}
                            onChange={() => handleColToggle(c.key)}
                            className="w-3.5 h-3.5 rounded accent-blue-600 cursor-pointer"
                          />
                          <span className="text-sm text-slate-700">{c.label}</span>
                        </label>
                      ))}
                    </div>
                    <div className="border-t border-slate-100 mt-1 pt-1 px-3">
                      <button
                        onClick={resetColsToDefaults}
                        className="text-xs text-blue-600 hover:text-blue-700 hover:underline"
                      >
                        Reset to defaults
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Clear filters */}
            {(filtersActive || masterFilterCount > 0) && (
              <button onClick={clearFilters}
                className="flex items-center gap-1 text-xs font-medium text-slate-400 hover:text-red-500 transition-colors px-2 py-1.5 rounded-lg hover:bg-red-50">
                <X className="w-3.5 h-3.5" /> Clear
              </button>
            )}

            <div className="ml-auto flex items-center gap-2">
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
                    activeViewId === v.id ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300 hover:text-blue-600'
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
                <p className="text-xs text-slate-500 mb-4">Saves filters and visible pipelines.</p>
                <input autoFocus type="text" placeholder={`e.g. "Matt's Active Escrows"`}
                  value={newViewName} onChange={e => setNewViewName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') saveView(); if (e.key === 'Escape') setShowSaveModal(false) }}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4" />
                <div className="text-xs text-slate-400 mb-4 space-y-0.5">
                  {!allLOsSelected && <div>LO: <strong>{selectedLOs.join(', ')}</strong></div>}
                  {sourceFilter !== 'All' && <div>Source: <strong>{sourceFilter}</strong></div>}
                  {statusFilter !== 'All' && <div>Stage: <strong>{statusFilter}</strong></div>}
                  {visiblePipelines.size < 4 && <div>Pipelines: <strong>{Array.from(visiblePipelines).join(', ')}</strong></div>}
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

        {/* ── Board / List ─────────────────────────────────────────────────────── */}
        {loading ? (
          <div className="flex items-center justify-center flex-1">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
          </div>
        ) : layoutView === 'list' ? (
          <ListView
            deals={filteredDeals}
            onStatusChange={handleStatusChange}
            onUpdate={handleCellUpdate}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            onSelectAll={selectAll}
            onClearAll={() => setSelectedIds(new Set())}
            visibleCols={visibleCols}
            onColToggle={handleColToggle}
          />
        ) : (
          /* ── Multi-pipeline stage board ────────────────────────────────────── */
          <div className="flex gap-0 p-4 overflow-x-auto flex-1 items-start select-none">
            {activePipelines.map((pipeline, pIdx) => {
              const pipelineDeals = filteredDeals.filter(d => d.pipeline_group === pipeline.group)
              const pipelineVolume = pipelineDeals.reduce((s, d) => s + (d.loan_amount || 0), 0)

              return (
                <div key={pipeline.key} className={`flex flex-col flex-none ${pIdx > 0 ? 'ml-5 pl-5 border-l-2 border-slate-200' : ''}`}>

                  {/* Pipeline section header */}
                  <div className={`flex items-center gap-2.5 px-4 py-2.5 mb-3 rounded-xl ${pipeline.headerBg} text-white shadow-sm`}>
                    <span className={`w-2.5 h-2.5 rounded-full ${pipeline.stageDot} shrink-0`} />
                    <span className="font-bold text-sm">{pipeline.key}</span>
                    <span className="text-xs opacity-70">{pipelineDeals.length} deal{pipelineDeals.length !== 1 ? 's' : ''}</span>
                    {pipelineVolume > 0 && (
                      <span className="ml-auto text-xs font-semibold opacity-90 whitespace-nowrap">{formatCurrency(pipelineVolume)}</span>
                    )}
                  </div>

                  {/* Stage columns */}
                  <div className="flex gap-3 items-start">
                    {pipeline.stages.map(stage => {
                      const droppableId = `${pipeline.key}:${stage}`
                      const stageDeals = pipelineDeals.filter(d => d.status === stage)
                      const stageVol   = stageDeals.reduce((s, d) => s + (d.loan_amount || 0), 0)
                      const isOver     = overId === droppableId

                      const stageIds = stageDeals.map(d => d.id)
                      const stageAllSelected = stageIds.length > 0 && stageIds.every(id => selectedIds.has(id))
                      const stageSomeSelected = !stageAllSelected && stageIds.some(id => selectedIds.has(id))
                      const toggleStageSelect = () => {
                        setSelectedIds(prev => {
                          const next = new Set(prev)
                          if (stageAllSelected) {
                            stageIds.forEach(id => next.delete(id))
                          } else {
                            stageIds.forEach(id => next.add(id))
                          }
                          return next
                        })
                      }

                      return (
                        <div key={stage} className="flex flex-col w-[210px] flex-none group/col">
                          {/* Stage column header */}
                          <div className={`flex items-center justify-between px-2.5 py-2 rounded-t-lg border-b-2 ${pipeline.stageHeader} mb-1`}>
                            <div className="flex items-center gap-1.5 min-w-0">
                              {/* Select all in this stage — appears on column hover, or always when any selected */}
                              <button
                                onClick={toggleStageSelect}
                                disabled={stageIds.length === 0}
                                title={stageAllSelected ? `Deselect all in ${stage}` : `Select all ${stageIds.length} in ${stage}`}
                                className={`shrink-0 w-3.5 h-3.5 rounded border-2 flex items-center justify-center transition-all ${
                                  stageAllSelected
                                    ? 'bg-blue-600 border-blue-600 opacity-100'
                                    : stageSomeSelected
                                      ? 'bg-blue-200 border-blue-500 opacity-100'
                                      : 'border-slate-400 bg-white opacity-0 group-hover/col:opacity-100 hover:border-blue-500'
                                } disabled:opacity-0 disabled:cursor-default`}
                              >
                                {stageAllSelected && <Check className="w-2.5 h-2.5 text-white" />}
                                {stageSomeSelected && <span className="w-1.5 h-0.5 bg-blue-700 rounded" />}
                              </button>
                              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${pipeline.stageDot}`} />
                              <span className="text-xs font-semibold text-slate-700 truncate" title={stage}>{stage}</span>
                            </div>
                            <div className="flex items-center gap-1 shrink-0 ml-1">
                              <span className="text-[10px] font-bold text-slate-500 bg-white px-1.5 py-0.5 rounded-full border border-slate-200">
                                {stageDeals.length}
                              </span>
                            </div>
                          </div>
                          {stageVol > 0 && (
                            <div className="text-[10px] text-slate-400 font-medium px-2 mb-1">{formatCurrency(stageVol)}</div>
                          )}

                          {/* Drop zone */}
                          <DroppableColumn droppableId={droppableId} isOver={isOver}>
                            {stageDeals.length === 0 ? (
                              <div className={`rounded-lg border-2 border-dashed p-3 text-center transition-colors ${
                                isOver ? 'border-blue-400 bg-blue-50' : 'border-slate-200'
                              }`}>
                                <p className="text-slate-300 text-xs">{isOver ? 'Drop here' : '—'}</p>
                              </div>
                            ) : (
                              stageDeals.map(deal => (
                                <DraggableCard
                                  key={deal.id}
                                  deal={deal}
                                  onStatusChange={handleStatusChange}
                                  isSelected={selectedIds.has(deal.id)}
                                  onToggleSelect={toggleSelect}
                                  pipelineStages={pipeline.stages}
                                />
                              ))
                            )}
                          </DroppableColumn>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <DragOverlay>
        {activeDeal ? (
          <div className="w-[210px] rotate-2 scale-105 opacity-95">
            <DealCard deal={activeDeal} onStatusChange={() => {}} ghost pipelineStages={activeDealPipeline?.stages} />
          </div>
        ) : null}
      </DragOverlay>

      {/* ── Master Filter Panel ─────────────────────────────────────────────── */}
      {showFilterPanel && (
        <div className="fixed inset-0 z-50" onClick={() => setShowFilterPanel(false)}>
          <div className="absolute inset-0 bg-black/30" />
        </div>
      )}
      <div className={`fixed top-0 right-0 h-full w-[380px] z-50 bg-white shadow-2xl border-l border-slate-200 flex flex-col transition-transform duration-300 ${showFilterPanel ? 'translate-x-0' : 'translate-x-full'}`}>
        {/* Panel header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 shrink-0">
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-slate-500" />
            <span className="font-bold text-slate-900">Filters</span>
            {masterFilterCount > 0 && (
              <span className="bg-blue-600 text-white text-xs font-bold rounded-full px-1.5 py-0.5 leading-none">
                {masterFilterCount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {masterFilterCount > 0 && (
              <button
                onClick={() => setMasterFilter(emptyMasterFilter())}
                className="text-xs font-medium text-red-500 hover:text-red-600 px-2 py-1 rounded-lg hover:bg-red-50 transition-colors"
              >
                Clear All
              </button>
            )}
            <button onClick={() => setShowFilterPanel(false)} className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Panel body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">

          {/* Pipeline */}
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Pipeline</p>
            <div className="space-y-1.5">
              {PIPELINE_CONFIG.map(p => (
                <label key={p.key} className="flex items-center gap-2.5 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={visiblePipelines.has(p.key)}
                    onChange={() => togglePipeline(p.key)}
                    className="w-4 h-4 rounded accent-blue-600 cursor-pointer"
                  />
                  <span className={`w-2 h-2 rounded-full shrink-0 ${p.dot}`} />
                  <span className="text-sm text-slate-700 group-hover:text-slate-900">{p.key}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Loan Officer */}
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Loan Officer</p>
            <LoFilter selected={selectedLOs} onToggle={toggleLO} />
          </div>

          {/* Status */}
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Status</p>
            <div className="max-h-52 overflow-y-auto space-y-1 border border-slate-100 rounded-lg p-2">
              {/* Grouped by pipeline */}
              {PIPELINE_CONFIG.map(p => (
                <div key={p.key}>
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide px-1 pt-1 pb-0.5">{p.key}</p>
                  {p.stages.map(s => (
                    <label key={s} className="flex items-center gap-2.5 px-1 py-0.5 cursor-pointer hover:bg-slate-50 rounded group">
                      <input
                        type="checkbox"
                        checked={masterFilter.statuses.has(s)}
                        onChange={() => mfToggleSet('statuses', s)}
                        className="w-3.5 h-3.5 rounded accent-blue-600 cursor-pointer"
                      />
                      <span className="text-xs text-slate-700 group-hover:text-slate-900">{s}</span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </div>

          {/* Loan Type */}
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Loan Type</p>
            <div className="max-h-44 overflow-y-auto space-y-1 border border-slate-100 rounded-lg p-2">
              {LOAN_TYPES.map(lt => (
                <label key={lt} className="flex items-center gap-2.5 px-1 py-0.5 cursor-pointer hover:bg-slate-50 rounded group">
                  <input
                    type="checkbox"
                    checked={masterFilter.loanTypes.has(lt)}
                    onChange={() => mfToggleSet('loanTypes', lt)}
                    className="w-3.5 h-3.5 rounded accent-blue-600 cursor-pointer"
                  />
                  <span className="text-xs text-slate-700 group-hover:text-slate-900">{lt}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Source */}
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Source</p>
            <div className="space-y-1">
              {availableSources.filter(s => s !== 'All').map(src => (
                <label key={src} className="flex items-center gap-2.5 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={masterFilter.sources.has(src)}
                    onChange={() => mfToggleSet('sources', src)}
                    className="w-3.5 h-3.5 rounded accent-blue-600 cursor-pointer"
                  />
                  <span className="text-sm text-slate-700 group-hover:text-slate-900">{src}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Loan Amount */}
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Loan Amount</p>
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <label className="text-[10px] text-slate-400 mb-0.5 block">Min ($)</label>
                <input
                  type="number"
                  value={masterFilter.loanAmountMin}
                  onChange={e => setMasterFilter(p => ({ ...p, loanAmountMin: e.target.value }))}
                  placeholder="0"
                  className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div className="flex-1">
                <label className="text-[10px] text-slate-400 mb-0.5 block">Max ($)</label>
                <input
                  type="number"
                  value={masterFilter.loanAmountMax}
                  onChange={e => setMasterFilter(p => ({ ...p, loanAmountMax: e.target.value }))}
                  placeholder="Any"
                  className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          </div>

          {/* Credit Score */}
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Credit Score (FICO)</p>
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <label className="text-[10px] text-slate-400 mb-0.5 block">Min</label>
                <input
                  type="number"
                  value={masterFilter.creditScoreMin}
                  onChange={e => setMasterFilter(p => ({ ...p, creditScoreMin: e.target.value }))}
                  placeholder="300"
                  className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div className="flex-1">
                <label className="text-[10px] text-slate-400 mb-0.5 block">Max</label>
                <input
                  type="number"
                  value={masterFilter.creditScoreMax}
                  onChange={e => setMasterFilter(p => ({ ...p, creditScoreMax: e.target.value }))}
                  placeholder="850"
                  className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          </div>

          {/* Rate */}
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Rate (%)</p>
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <label className="text-[10px] text-slate-400 mb-0.5 block">Min</label>
                <input
                  type="number"
                  step="0.01"
                  value={masterFilter.rateMin}
                  onChange={e => setMasterFilter(p => ({ ...p, rateMin: e.target.value }))}
                  placeholder="0"
                  className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div className="flex-1">
                <label className="text-[10px] text-slate-400 mb-0.5 block">Max</label>
                <input
                  type="number"
                  step="0.01"
                  value={masterFilter.rateMax}
                  onChange={e => setMasterFilter(p => ({ ...p, rateMax: e.target.value }))}
                  placeholder="Any"
                  className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          </div>

          {/* LTV */}
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">LTV (%)</p>
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <label className="text-[10px] text-slate-400 mb-0.5 block">Min</label>
                <input
                  type="number"
                  value={masterFilter.ltvMin}
                  onChange={e => setMasterFilter(p => ({ ...p, ltvMin: e.target.value }))}
                  placeholder="0"
                  className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div className="flex-1">
                <label className="text-[10px] text-slate-400 mb-0.5 block">Max</label>
                <input
                  type="number"
                  value={masterFilter.ltvMax}
                  onChange={e => setMasterFilter(p => ({ ...p, ltvMax: e.target.value }))}
                  placeholder="100"
                  className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          </div>

          {/* Occupancy */}
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Occupancy</p>
            <div className="space-y-1.5">
              {OCCUPANCY_TYPES.map(occ => (
                <label key={occ} className="flex items-center gap-2.5 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={masterFilter.occupancies.has(occ)}
                    onChange={() => mfToggleSet('occupancies', occ)}
                    className="w-4 h-4 rounded accent-blue-600 cursor-pointer"
                  />
                  <span className="text-sm text-slate-700 group-hover:text-slate-900">{occ}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Is Military */}
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Is Military</p>
            <div className="flex items-center gap-4">
              {(['any', 'yes', 'no'] as const).map(opt => (
                <label key={opt} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="isMilitary"
                    value={opt}
                    checked={masterFilter.isMilitary === opt}
                    onChange={() => setMasterFilter(p => ({ ...p, isMilitary: opt }))}
                    className="accent-blue-600 cursor-pointer"
                  />
                  <span className="text-sm text-slate-700 capitalize">{opt}</span>
                </label>
              ))}
            </div>
          </div>

        </div>

        {/* Panel footer */}
        <div className="shrink-0 px-5 py-4 border-t border-slate-200">
          <button
            onClick={() => setShowFilterPanel(false)}
            className="w-full bg-blue-600 text-white text-sm font-semibold py-2.5 rounded-lg hover:bg-blue-700 transition-colors"
          >
            Apply &amp; Close
          </button>
        </div>
      </div>

      {/* ── Bulk action bar ─────────────────────────────────────────────────── */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-slate-900 text-white px-4 py-2.5 rounded-2xl shadow-2xl border border-slate-700 text-sm">
          <span className="font-semibold text-slate-200">{selectedIds.size} deal{selectedIds.size > 1 ? 's' : ''} selected</span>
          <div className="h-4 w-px bg-slate-600 mx-1" />

          {/* Move to */}
          <div className="relative">
            <button onClick={() => { setShowBulkMoveMenu(v => !v); setBulkEditField(null) }} disabled={bulkWorking}
              className="flex items-center gap-1.5 bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50">
              <ArrowRight className="w-3.5 h-3.5" /> Move to
            </button>
            {showBulkMoveMenu && (
              <div className="absolute bottom-full mb-2 left-0 bg-white rounded-xl shadow-xl border border-slate-200 py-1.5 w-52 text-slate-700 overflow-hidden"
                onMouseLeave={() => setShowBulkMoveMenu(false)}>
                <div className="px-3 py-1.5 text-xs font-semibold text-slate-400 uppercase tracking-wide border-b border-slate-100 mb-1">
                  Move {selectedIds.size} deal{selectedIds.size > 1 ? 's' : ''} to
                </div>
                {[
                  { label: 'Leads',            dot: 'bg-slate-400',   group: 'Leads',            status: 'New Lead' },
                  { label: 'Loans in Process', dot: 'bg-amber-500',   group: 'Loans in Process', status: 'Loan Setup' },
                  { label: 'Not Ready',        dot: 'bg-red-400',     group: 'Not Ready',        status: 'Non-Responsive' },
                  { label: 'Funded',           dot: 'bg-emerald-500', group: 'Funded',           status: 'Loan Funded' },
                ].map(opt => (
                  <button key={opt.group} onClick={() => handleBulkMove(opt.group, opt.status)} disabled={bulkWorking}
                    className="w-full text-left text-sm px-3 py-2 hover:bg-slate-50 transition-colors flex items-center gap-2 disabled:opacity-50">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${opt.dot}`} />{opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Edit Fields */}
          <div className="relative" ref={bulkEditRef}>
            <button onClick={() => { setBulkEditField(v => v ? null : 'menu'); setShowBulkMoveMenu(false) }} disabled={bulkWorking}
              className="flex items-center gap-1.5 bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50">
              <Pencil className="w-3.5 h-3.5" /> Edit Fields
            </button>
            {bulkEditField === 'menu' && (
              <div className="absolute bottom-full mb-2 left-0 bg-white rounded-xl shadow-xl border border-slate-200 w-64 text-slate-700 overflow-hidden">
                <div className="px-3 py-2 text-xs font-semibold text-slate-400 uppercase tracking-wide border-b border-slate-100">
                  Edit {selectedIds.size} deal{selectedIds.size > 1 ? 's' : ''}
                </div>
                <div className="px-2 pt-2">
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                    <input
                      autoFocus
                      value={bulkEditSearch}
                      onChange={e => setBulkEditSearch(e.target.value)}
                      placeholder="Search fields…"
                      className="w-full pl-7 pr-2 py-1.5 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
                <div className="max-h-80 overflow-y-auto py-1">
                  {Object.entries(bulkFieldsByCategory).length === 0 ? (
                    <div className="px-3 py-4 text-center text-xs text-slate-400">No matching fields</div>
                  ) : Object.entries(bulkFieldsByCategory).map(([cat, fields]) => (
                    <div key={cat}>
                      <div className="px-3 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                        {cat}
                      </div>
                      {fields.map(f => (
                        <button key={f.key} onClick={() => { setBulkEditField(f.key); setBulkEditValue('') }}
                          className="w-full text-left text-sm px-3 py-1.5 hover:bg-slate-50 transition-colors flex items-center gap-2.5">
                          {f.icon}<span>{f.label}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {activeBulkField && (
              <div className="absolute bottom-full mb-2 left-0 bg-white rounded-xl shadow-xl border border-slate-200 p-4 w-72 text-slate-700">
                <div className="flex items-center gap-2 mb-1">
                  <button onClick={() => { setBulkEditField('menu'); setBulkEditValue('') }} className="text-slate-400 hover:text-slate-600" title="Back">
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <div className="flex items-center gap-1.5">{activeBulkField.icon}<p className="text-sm font-semibold text-slate-800">{activeBulkField.label}</p></div>
                  <button onClick={() => setBulkEditField(null)} className="ml-auto text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
                </div>
                <p className="text-xs text-slate-400 mb-3 ml-6">Apply to {selectedIds.size} selected deal{selectedIds.size > 1 ? 's' : ''}</p>

                {activeBulkField.type === 'date' && (
                  <input type="date" value={bulkEditValue} onChange={e => setBulkEditValue(e.target.value)}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 mb-3" />
                )}
                {activeBulkField.type === 'datetime-local' && (
                  <input type="datetime-local" value={bulkEditValue} onChange={e => setBulkEditValue(e.target.value)}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 mb-3" />
                )}
                {activeBulkField.type === 'select' && (
                  <select value={bulkEditValue} onChange={e => setBulkEditValue(e.target.value)}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 mb-3">
                    <option value="">Select…</option>
                    {activeBulkField.options?.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                )}
                {activeBulkField.type === 'text' && (
                  <input type="text" value={bulkEditValue} onChange={e => setBulkEditValue(e.target.value)}
                    placeholder={activeBulkField.placeholder}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 mb-3" />
                )}
                {activeBulkField.type === 'number' && (
                  <input type="number" value={bulkEditValue} onChange={e => setBulkEditValue(e.target.value)}
                    placeholder={activeBulkField.placeholder}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 mb-3 tabular-nums" />
                )}
                {activeBulkField.type === 'currency' && (
                  <div className="relative mb-3">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">$</span>
                    <input type="number" value={bulkEditValue} onChange={e => setBulkEditValue(e.target.value)}
                      className="w-full pl-7 pr-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums" />
                  </div>
                )}
                {activeBulkField.type === 'percent' && (
                  <div className="relative mb-3">
                    <input type="number" step="0.001" value={bulkEditValue} onChange={e => setBulkEditValue(e.target.value)}
                      className="w-full pl-3 pr-7 py-2 border border-slate-200 rounded-lg text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 tabular-nums" />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">%</span>
                  </div>
                )}

                <div className="flex gap-2">
                  <button onClick={() => setBulkEditField('menu')}
                    className="flex-1 px-3 py-2 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">Back</button>
                  <button onClick={handleBulkEditApply} disabled={bulkEditValue === '' || bulkWorking}
                    className="flex-1 px-3 py-2 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-40 transition-colors">
                    {bulkWorking ? 'Saving…' : 'Apply'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Export CSV */}
          <button onClick={handleBulkExport} disabled={bulkWorking}
            className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
            title={`Download ${selectedIds.size} deal${selectedIds.size > 1 ? 's' : ''} as CSV`}>
            <Download className="w-3.5 h-3.5" /> Export CSV
          </button>

          {/* Delete */}
          <button onClick={handleBulkDelete} disabled={bulkWorking}
            className="flex items-center gap-1.5 bg-red-600 hover:bg-red-500 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50">
            <Trash2 className="w-3.5 h-3.5" />{bulkWorking ? 'Working…' : 'Delete'}
          </button>

          {/* Clear */}
          <button onClick={() => { setSelectedIds(new Set()); setBulkEditField(null) }}
            className="ml-1 p-1.5 text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg transition-colors" title="Clear selection">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </DndContext>
  )
}

// ── Export wrapped in Suspense (for useSearchParams) ─────────────────────────
export default function PipelinePage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    }>
      <PipelinePageInner />
    </Suspense>
  )
}
