'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { Deal, STATUS_COLORS } from '@/lib/types'
import { formatCurrency, formatDate, formatPercent } from '@/lib/utils'
import Link from 'next/link'
import { use } from 'react'
import { ArrowLeft, Edit, Phone, Mail, MapPin, ExternalLink } from 'lucide-react'

export default function DealDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [deal, setDeal] = useState<Deal | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchDeal() {
      const { data } = await supabase.from('deals').select('*').eq('id', id).single()
      setDeal(data)
      setLoading(false)
    }
    fetchDeal()
  }, [id])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    )
  }

  if (!deal) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-slate-500 text-lg">Deal not found</p>
          <Link href="/deals" className="text-blue-600 hover:underline text-sm mt-2 block">← Back to deals</Link>
        </div>
      </div>
    )
  }

  const statusClass = STATUS_COLORS[deal.status] || 'bg-gray-100 text-gray-600'

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <Link href="/deals" className="flex items-center gap-1 text-slate-500 hover:text-slate-700 text-sm mb-2 transition-colors">
            <ArrowLeft className="w-3.5 h-3.5" /> All Deals
          </Link>
          <h1 className="text-2xl font-bold text-slate-900">{deal.name}</h1>
          <div className="flex items-center gap-2 mt-2">
            <span className={`text-sm px-2.5 py-1 rounded-lg font-medium ${statusClass}`}>{deal.status}</span>
            <span className="text-sm text-slate-500 bg-slate-100 px-2.5 py-1 rounded-lg">{deal.pipeline_group}</span>
          </div>
        </div>
        <Link
          href={`/deals/${deal.id}/edit`}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          <Edit className="w-4 h-4" /> Edit Deal
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left column */}
        <div className="lg:col-span-2 space-y-4">

          {/* Loan Details */}
          <InfoCard title="Loan Details">
            <div className="grid grid-cols-2 gap-4">
              <InfoRow label="Loan Type" value={deal.loan_type} />
              <InfoRow label="Loan Amount" value={formatCurrency(deal.loan_amount)} />
              <InfoRow label="Estimated Value" value={formatCurrency(deal.estimated_value)} />
              <InfoRow label="Revenue" value={formatCurrency(deal.revenue)} highlight="green" />
              <InfoRow label="Rate" value={formatPercent(deal.rate)} />
              <InfoRow label="Investor" value={deal.investor} />
              <InfoRow label="Occupancy" value={deal.occupancy} />
              <InfoRow label="Broker / Corr" value={deal.broker_corr} />
            </div>
          </InfoCard>

          {/* Lock & Appraisal */}
          <InfoCard title="Lock & Appraisal">
            <div className="grid grid-cols-2 gap-4">
              <InfoRow label="Locked" value={deal.locked} />
              <InfoRow label="Lock Expiration" value={formatDate(deal.lock_expiration)} />
              <InfoRow label="Appraisal Status" value={deal.appraisal_status} />
            </div>
          </InfoCard>

          {/* Notes */}
          {(deal.lo_notes || deal.client_notes) && (
            <InfoCard title="Notes">
              {deal.lo_notes && (
                <div className="mb-3">
                  <p className="text-xs font-medium text-slate-400 mb-1">LO Notes</p>
                  <p className="text-sm text-slate-700 bg-slate-50 rounded-lg p-3">{deal.lo_notes}</p>
                </div>
              )}
              {deal.client_notes && (
                <div>
                  <p className="text-xs font-medium text-slate-400 mb-1">Client Notes</p>
                  <p className="text-sm text-slate-700 bg-slate-50 rounded-lg p-3">{deal.client_notes}</p>
                </div>
              )}
            </InfoCard>
          )}
        </div>

        {/* Right column */}
        <div className="space-y-4">
          {/* Borrower */}
          <InfoCard title="Borrower">
            {deal.email && (
              <a href={`mailto:${deal.email}`} className="flex items-center gap-2 text-sm text-blue-600 hover:underline mb-2">
                <Mail className="w-3.5 h-3.5" /> {deal.email}
              </a>
            )}
            {deal.phone && (
              <a href={`tel:${deal.phone}`} className="flex items-center gap-2 text-sm text-blue-600 hover:underline mb-2">
                <Phone className="w-3.5 h-3.5" /> {deal.phone}
              </a>
            )}
            {deal.property_address && (
              <div className="flex items-start gap-2 text-sm text-slate-600 mt-1">
                <MapPin className="w-3.5 h-3.5 mt-0.5 shrink-0 text-slate-400" />
                <span>{deal.property_address}</span>
              </div>
            )}
            {!deal.email && !deal.phone && !deal.property_address && (
              <p className="text-slate-400 text-sm">No contact info</p>
            )}
          </InfoCard>

          {/* Team */}
          <InfoCard title="Team">
            <InfoRow label="Loan Officer" value={deal.loan_officer} />
            <InfoRow label="Processor" value={deal.processor_status} />
            <InfoRow label="Source" value={deal.source} />
          </InfoCard>

          {/* File Numbers */}
          {(deal.arive_file_no || deal.investor_file_no) && (
            <InfoCard title="File Numbers">
              <InfoRow label="Arive File #" value={deal.arive_file_no} />
              <InfoRow label="Investor File #" value={deal.investor_file_no} />
            </InfoCard>
          )}

          {/* Key Dates */}
          <InfoCard title="Key Dates">
            <InfoRow label="Signing Date" value={formatDate(deal.signing_date)} />
            <InfoRow label="Funded Date" value={formatDate(deal.funded_date)} />
            <InfoRow label="Paid Date" value={formatDate(deal.paid_date)} />
            <InfoRow label="Last Contacted" value={formatDate(deal.last_contacted)} />
            <InfoRow label="Added" value={formatDate(deal.created_at)} />
          </InfoCard>

          {/* Document Link */}
          {deal.document_upload_link && (
            <InfoCard title="Documents">
              <a
                href={deal.document_upload_link}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm text-blue-600 hover:underline"
              >
                <ExternalLink className="w-3.5 h-3.5" /> Upload Documents
              </a>
            </InfoCard>
          )}
        </div>
      </div>
    </div>
  )
}

function InfoCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100 bg-slate-50">
        <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </div>
  )
}

function InfoRow({ label, value, highlight }: { label: string; value: string | null | undefined; highlight?: 'green' }) {
  return (
    <div className="flex flex-col gap-0.5 mb-3 last:mb-0">
      <span className="text-xs text-slate-400 font-medium">{label}</span>
      <span className={`text-sm font-medium ${highlight === 'green' ? 'text-emerald-700' : 'text-slate-800'}`}>
        {value || '—'}
      </span>
    </div>
  )
}
