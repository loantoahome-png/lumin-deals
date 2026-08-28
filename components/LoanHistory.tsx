'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { Deal, STATUS_COLORS } from '@/lib/types'
import { splitByOutcome, closedReason, isAdverse } from '@/lib/loanOutcome'
import { formatCurrency, formatDate } from '@/lib/utils'
import { History, ExternalLink, DollarSign, Calendar, Loader2, ChevronRight, ChevronDown, Ban } from 'lucide-react'

type Props = {
  currentDealId: string
  borrowerId?: string | null
  email?: string | null
  phone?: string | null
  firstName?: string | null
  lastName?: string | null
  name?: string | null
}

function normPhone(s: string | null | undefined): string | null {
  if (!s) return null
  const digits = s.replace(/\D/g, '')
  return digits.length >= 10 ? digits.slice(-10) : null
}

/** One loan row. `muted` dims the closed section so the live loans read first. */
function LoanRow({ d, muted }: { d: Deal; muted?: boolean }) {
  const statusClass = STATUS_COLORS[d.status] || 'bg-gray-100 text-gray-600'
  const reason = muted ? closedReason(d) : null
  // An adverse row shows the actual Adverse Action date — that's the fact the
  // stage badge is hiding (a declined loan keeps whatever stage it died at).
  const dateLabel = d.funded_date
    ? `Funded ${formatDate(d.funded_date)}`
    : isAdverse(d)
      ? `Adverse ${formatDate(d.adverse as string)}`
      : `Added ${formatDate(d.created_at)}`
  return (
    <Link
      href={`/deals/${d.id}`}
      className={`flex items-center gap-4 px-5 py-3 hover:bg-blue-50/40 transition group ${muted ? 'opacity-70 hover:opacity-100' : ''}`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-semibold text-slate-900 group-hover:text-blue-700 truncate">
            {d.name}
          </span>
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${statusClass}`}>
            {d.status}
          </span>
          {reason && (
            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
              reason === 'Adverse Action' ? 'bg-red-100 text-red-700' : 'bg-slate-200 text-slate-600'
            }`}>
              {reason}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-500">
          {d.loan_type && <span>{d.loan_type}</span>}
          {d.property_address && <span className="truncate max-w-[280px]">· {d.property_address}</span>}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="flex items-center gap-1 text-sm font-semibold text-slate-800 justify-end">
          <DollarSign className="w-3 h-3 text-slate-400" />
          {d.loan_amount ? formatCurrency(d.loan_amount).replace('$', '') : '—'}
        </div>
        <div className="flex items-center gap-1 text-[11px] text-slate-400 justify-end mt-0.5">
          <Calendar className="w-2.5 h-2.5" />
          {dateLabel}
        </div>
      </div>
      <ExternalLink className="w-3.5 h-3.5 text-slate-300 group-hover:text-blue-500 shrink-0" />
    </Link>
  )
}

/**
 * Shows other loans for the same person, split into two sections: loans still
 * alive (active or funded) and loans that closed out — an Arive adverse action,
 * or lost/abandoned in GHL. Not Ready leads stay in the live section: they're
 * parked, not dead. The split rule lives in lib/loanOutcome.ts.
 *
 * Primary link is borrower_id (the firm grouping from the multi-loan model);
 * falls back to email/phone/name for any deal that doesn't have a borrower_id yet.
 */
export default function LoanHistory({ currentDealId, borrowerId, email, phone, firstName, lastName, name }: Props) {
  const [related, setRelated] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [showClosed, setShowClosed] = useState(false)

  useEffect(() => {
    async function fetchRelated() {
      setLoading(true)
      const map = new Map<string, Deal>()

      // 1. Primary: same borrower_id (the firm link)
      if (borrowerId) {
        const { data } = await supabase
          .from('deals').select('*')
          .eq('borrower_id', borrowerId)
          .neq('id', currentDealId)
        for (const d of (data as Deal[] || [])) map.set(d.id, d)
      }

      // 2. Fallback: email / name / phone (catches deals not yet stamped with borrower_id)
      const matchEmail = email?.trim().toLowerCase() || null
      const normalizedPhone = normPhone(phone)
      const composedName = [firstName, lastName].filter(Boolean).join(' ').trim().toLowerCase()
        || (name?.trim().toLowerCase() ?? '')

      const ors: string[] = []
      if (matchEmail) ors.push(`email.eq.${matchEmail}`)
      if (composedName.length >= 4) ors.push(`name.ilike.${composedName}`)
      if (ors.length > 0) {
        const { data } = await supabase.from('deals').select('*').or(ors.join(',')).neq('id', currentDealId)
        for (const d of (data as Deal[] || [])) map.set(d.id, d)
      }
      if (normalizedPhone) {
        const { data } = await supabase
          .from('deals').select('*')
          .not('phone', 'is', null)
          .neq('id', currentDealId)
          .limit(2000)
        for (const d of (data as Deal[] || []).filter(d => normPhone(d.phone) === normalizedPhone)) map.set(d.id, d)
      }

      const all = Array.from(map.values())
      all.sort((a, b) => {
        const av = a.funded_date || a.created_at
        const bv = b.funded_date || b.created_at
        return new Date(bv).getTime() - new Date(av).getTime()
      })
      setRelated(all)
      setLoading(false)
    }
    fetchRelated()
  }, [currentDealId, borrowerId, email, phone, firstName, lastName, name])

  const { open, closed } = useMemo(() => splitByOutcome(related), [related])
  const adverseCount = useMemo(() => closed.filter(isAdverse).length, [closed])

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <div className="flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
          <span className="text-sm text-slate-400">Loading loan history…</span>
        </div>
      </div>
    )
  }

  if (related.length === 0) return null // hide entirely when there's nothing to show

  // Stats — counted over the LIVE loans only, so a closed-out file never inflates them.
  const fundedCount = open.filter(d => d.pipeline_group === 'Funded').length
  const inProcessCount = open.filter(d => d.pipeline_group === 'Loans in Process').length
  const totalFundedVolume = open
    .filter(d => d.pipeline_group === 'Funded')
    .reduce((s, d) => s + (d.loan_amount || 0), 0)

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between bg-slate-50">
        <div className="flex items-center gap-2">
          <History className="w-4 h-4 text-blue-600" />
          <h3 className="font-semibold text-slate-800 text-sm">Loan History</h3>
          <span className="text-xs text-slate-500">
            {related.length} other loan{related.length !== 1 ? 's' : ''} for this contact
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs">
          {totalFundedVolume > 0 && (
            <span className="text-emerald-700 font-semibold">
              {fundedCount} funded · {formatCurrency(totalFundedVolume)} total volume
            </span>
          )}
          {inProcessCount > 0 && (
            <span className="text-blue-700 font-medium">{inProcessCount} active</span>
          )}
          {closed.length > 0 && (
            <span className="text-slate-500 font-medium">{closed.length} closed</span>
          )}
        </div>
      </div>

      {/* ── Active & Funded ── */}
      {open.length > 0 && (
        <div className="divide-y divide-slate-100">
          {open.map(d => <LoanRow key={d.id} d={d} />)}
        </div>
      )}
      {open.length === 0 && (
        <div className="px-5 py-3 text-xs text-slate-400 italic">
          No active or funded loans for this contact.
        </div>
      )}

      {/* ── Adverse & Lost (collapsed by default) ── */}
      {closed.length > 0 && (
        <div className="border-t border-slate-200">
          <button
            type="button"
            onClick={() => setShowClosed(v => !v)}
            className="w-full flex items-center gap-2 px-5 py-2.5 bg-slate-50 hover:bg-slate-100 transition text-left"
          >
            {showClosed
              ? <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              : <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
            <Ban className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <span className="text-xs font-semibold text-slate-600">Adverse &amp; Lost</span>
            <span className="text-xs text-slate-400">
              {closed.length} loan{closed.length !== 1 ? 's' : ''}
              {adverseCount > 0 && ` · ${adverseCount} adverse action`}
            </span>
          </button>
          {showClosed && (
            <div className="divide-y divide-slate-100 bg-slate-50/40">
              {closed.map(d => <LoanRow key={d.id} d={d} muted />)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
