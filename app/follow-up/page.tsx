'use client'

// Follow-Up index — Efrain's manager glance + the door to each LO's cockpit.
// Spec: docs/specs/2026-07-30-follow-up-cockpit-spec.md

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { fetchAllDeals } from '@/lib/fetchAllDeals'
import { LO_COLORS } from '@/components/LoFilter'
import { DEFAULT_LOS } from '@/lib/loanOfficer'
import { buildFollowUpQueue, type QueueDealLike, type QueueFubLike } from '@/lib/followUpQueue'
import { PhoneCall, ArrowRight } from 'lucide-react'

const SLUG: Record<string, string> = { 'Moe Sefati': 'moe', 'Matt Park': 'matt' }

const DEAL_COLS = 'id,name,status,ghl_status,pipeline_group,loan_officer,created_at,date_added_ghl,next_action_due,last_inbound_at,last_outbound_at,loan_amount'
const FUB_COLS = 'fub_id,stage,loan_officer,price,deal_price,last_activity_at,fub_created_at,next_action_due,last_touched_at,matched_deal_active,missing_since'

export default function FollowUpIndex() {
  const [deals, setDeals] = useState<QueueDealLike[]>([])
  const [fub, setFub] = useState<QueueFubLike[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    (async () => {
      const [d, f] = await Promise.all([
        fetchAllDeals(q => q.in('loan_officer', DEFAULT_LOS), DEAL_COLS),
        (async () => {
          const all: QueueFubLike[] = []
          for (let offset = 0; ; offset += 1000) {
            const { data, error } = await supabase.from('fub_people').select(FUB_COLS)
              .in('loan_officer', DEFAULT_LOS).is('missing_since', null).range(offset, offset + 999)
            if (error) { console.error('[follow-up] fub fetch failed:', error.message); break }
            all.push(...((data as unknown as QueueFubLike[]) ?? []))
            if (!data || data.length < 1000) break
          }
          return all
        })(),
      ])
      setDeals(d as unknown as QueueDealLike[])
      setFub(f)
      setLoading(false)
    })()
  }, [])

  const queues = useMemo(() => DEFAULT_LOS.map(lo => ({ lo, q: buildFollowUpQueue({ deals, fub, lo }) })), [deals, fub])

  return (
    <div className="p-8 max-w-4xl">
      <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2 mb-1">
        <PhoneCall className="w-5 h-5 text-blue-600" /> Follow-Up Cockpits
      </h1>
      <p className="text-sm text-slate-500 mb-6">One page per LO — today&apos;s queue across GHL and FollowUpBoss.</p>
      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <div className="grid sm:grid-cols-2 gap-4">
          {queues.map(({ lo, q }) => {
            const color = LO_COLORS[lo] ?? '#64748b'
            const urgent = q.counts.replyWaiting + q.counts.overdue
            return (
              <Link key={lo} href={`/follow-up/${SLUG[lo]}`}
                className="block bg-white border border-slate-200 rounded-xl p-5 hover:shadow-md hover:border-slate-300 transition-all">
                <div className="flex items-center gap-2 mb-3">
                  <span className="w-3 h-3 rounded-full" style={{ background: color }} />
                  <span className="font-bold text-slate-900">{lo}</span>
                  {urgent > 0 && (
                    <span className="text-[10px] font-bold text-red-700 bg-red-50 border border-red-200 rounded-full px-2 py-0.5">
                      {urgent} urgent
                    </span>
                  )}
                  <ArrowRight className="w-4 h-4 text-slate-300 ml-auto" />
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-600">
                  <div className="flex justify-between"><dt>Reply waiting</dt><dd className="font-bold text-red-700">{q.counts.replyWaiting}</dd></div>
                  <div className="flex justify-between"><dt>New leads</dt><dd className="font-bold text-emerald-700">{q.counts.newLeads}</dd></div>
                  <div className="flex justify-between"><dt>Due today</dt><dd className="font-bold text-amber-700">{q.counts.dueToday}</dd></div>
                  <div className="flex justify-between"><dt>Past clients</dt><dd className="font-bold text-violet-700">{q.counts.pastClients}</dd></div>
                </dl>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
