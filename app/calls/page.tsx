'use client'

/**
 * Call Report — imported from GHL's Reporting → Call report CSV export.
 *
 *   • Effort    — are the leads we paid for actually being worked? Per LO:
 *                 % dialed, % connected, dials/lead, talk time, speed to first
 *                 dial, plus the two lists that cost money: never-dialed and
 *                 dialed-but-never-connected. Also splits DIALER from lead owner
 *                 ("Brianne's Number" places calls in both sub-accounts).
 *   • Economics — cost per connected conversation by lead source. This is CONTACT
 *                 economics, NOT ROI: there is no revenue on this page. Net
 *                 revenue is totalComp() × the 85% LO split and lives on /lead-roi.
 *
 * The connect signal is talk time, never GHL's "Answered" status — 724 rows in
 * the real export are 'Answered' AND dispositioned 'No Answer / Voicemail'.
 *
 * All aggregation lives in lib/callsReport.ts (pure, fixture-tested by
 * scripts/calls-check.ts) and is computed server-side by /api/calls.
 */

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  PhoneCall, AlertTriangle, RefreshCw, Clock, DollarSign, PhoneOff, ChevronDown, ChevronRight, Info,
} from 'lucide-react'
import { LO_COLORS } from '@/components/LoFilter'
import type { EffortRow, DialerRow, EconomicsRow } from '@/lib/callsReport'

type ApiResponse = {
  ok: boolean
  error?: string
  totalCalls: number
  window: { start: string; end: string } | null
  dataThrough: string | null
  covered: string[]
  effort: EffortRow[]
  dialers: DialerRow[]
  economics: EconomicsRow[]
}

const money = (n: number) => `$${Math.round(n).toLocaleString()}`
const pct = (num: number, den: number) => (den ? `${Math.round((num / den) * 100)}%` : '—')
const hours = (sec: number) => `${(sec / 3600).toFixed(1)}h`
const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

/** Median time-to-first-dial, rendered in whichever unit reads naturally. */
function fmtTtfd(h: number | null): string {
  if (h == null) return '—'
  if (h < 1) return `${Math.round(h * 60)} min`
  if (h < 48) return `${h.toFixed(1)} h`
  return `${(h / 24).toFixed(1)} d`
}

export default function CallsPage() {
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [tab, setTab] = useState<'effort' | 'economics'>('effort')
  const [openList, setOpenList] = useState<string | null>(null)

  const load = async () => {
    setLoading(true); setErr(null)
    try {
      const res = await fetch('/api/calls')
      const j = await res.json() as ApiResponse
      if (!j.ok) throw new Error(j.error || 'load failed')
      setData(j)
    } catch (e) {
      setErr(String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [])

  // Stale-data warning: the page is only as fresh as the last manual export.
  const staleDays = useMemo(() => {
    if (!data?.dataThrough) return null
    return Math.floor((Date.now() - Date.parse(data.dataThrough)) / 86_400_000)
  }, [data?.dataThrough])

  const dialersByLo = useMemo(() => {
    const m = new Map<string, DialerRow[]>()
    for (const d of data?.dialers ?? []) {
      const arr = m.get(d.lo) ?? []
      arr.push(d); m.set(d.lo, arr)
    }
    return m
  }, [data?.dialers])

  if (loading) {
    return (
      <div className="p-8 text-center text-gray-500">
        <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2" />
        Loading call report…
      </div>
    )
  }

  if (err) {
    return (
      <div className="p-8">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-800">
          <div className="font-semibold mb-1">Couldn&apos;t load call data</div>
          <div className="text-sm font-mono">{err}</div>
          <div className="text-sm mt-2">
            If the <code>calls</code> table doesn&apos;t exist yet, run <code>supabase-calls.sql</code> in the
            Supabase SQL editor, then import from{' '}
            <Link href="/import/calls" className="underline">Import Calls</Link>.
          </div>
        </div>
      </div>
    )
  }

  const empty = !data || data.totalCalls === 0

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <PhoneCall className="w-6 h-6 text-blue-600" />
            Call Report
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {empty ? 'No calls imported yet.' : (
              <>
                {data!.totalCalls.toLocaleString()} calls · data through{' '}
                <span className="font-medium text-gray-700">{fmtDate(data!.dataThrough)}</span>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/import/calls" className="px-3 py-2 text-sm rounded-lg border border-gray-300 hover:bg-gray-50">
            Import CSV
          </Link>
          <button onClick={() => void load()} className="px-3 py-2 text-sm rounded-lg border border-gray-300 hover:bg-gray-50 flex items-center gap-1.5">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>
      </div>

      {/* Stale warning — CSV ingest means this page can silently age. */}
      {staleDays != null && staleDays > 7 && (
        <div className="mb-4 flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div>
            Newest call is <strong>{staleDays} days old</strong>. These numbers are stale until you export
            again from GHL and re-import — nothing syncs automatically.
          </div>
        </div>
      )}

      {empty ? (
        <div className="bg-white border border-gray-200 rounded-lg p-10 text-center">
          <PhoneCall className="w-10 h-10 text-gray-300 mx-auto mb-3" />
          <div className="font-medium text-gray-800 mb-1">No call data yet</div>
          <p className="text-sm text-gray-500 mb-4">
            Export Reporting → Call report from each sub-account in GHL, then import the CSVs.
          </p>
          <Link href="/import/calls" className="inline-block px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
            Import call CSVs
          </Link>
        </div>
      ) : (
        <>
          {/* Tabs */}
          <div className="flex gap-1 border-b border-gray-200 mb-5">
            {([['effort', 'Effort'], ['economics', 'Economics']] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
                  tab === k ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'effort' && (
            <div className="space-y-4">
              {data!.effort.map(row => {
                const dialers = dialersByLo.get(row.lo) ?? []
                return (
                  <div key={row.lo} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                    <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background: LO_COLORS[row.lo] ?? '#94a3b8' }} />
                      <span className="font-semibold text-gray-900">{row.lo}</span>
                      {row.covered ? (
                        <span className="text-sm text-gray-500">
                          {row.leads.toLocaleString()} purchased leads · {money(row.spend)}
                        </span>
                      ) : (
                        <span className="text-sm text-gray-400 italic">no call export imported</span>
                      )}
                    </div>

                    {/* An LO with no import has NO evidence either way — never render 0%. */}
                    {!row.covered ? (
                      <div className="px-5 py-6 text-sm text-gray-500 flex items-start gap-2">
                        <Info className="w-4 h-4 mt-0.5 flex-shrink-0 text-gray-400" />
                        <div>
                          No data. Nothing has been imported for {row.lo}, so their dialing activity is
                          unknown — this is <strong>not</strong> zero activity.
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="grid grid-cols-2 md:grid-cols-6 divide-x divide-gray-100">
                          {[
                            ['Dialed', pct(row.dialed, row.leads)],
                            ['Connected', pct(row.connected, row.leads)],
                            ['Dials / lead', row.leads ? (row.dials / row.leads).toFixed(1) : '—'],
                            ['Talk time', hours(row.talkSec)],
                            ['Median to 1st dial', fmtTtfd(row.medianTtfdHours)],
                            ['Total dials', row.dials.toLocaleString()],
                          ].map(([label, val]) => (
                            <div key={label} className="px-4 py-3">
                              <div className="text-xs text-gray-500">{label}</div>
                              <div className="text-lg font-semibold text-gray-900">{val}</div>
                            </div>
                          ))}
                        </div>

                        {/* Money left on the table */}
                        <div className="grid md:grid-cols-2 gap-px bg-gray-100 border-t border-gray-100">
                          {([
                            ['never', 'Never dialed', row.neverDialed, row.neverDialedSpend, PhoneOff],
                            ['noconn', 'Dialed, never connected', row.dialedNeverConnected, row.dialedNeverConnectedSpend, Clock],
                          ] as const).map(([key, label, list, spend, Icon]) => {
                            const id = `${row.lo}:${key}`
                            const open = openList === id
                            return (
                              <div key={key} className="bg-white">
                                <button
                                  onClick={() => setOpenList(open ? null : id)}
                                  className="w-full px-5 py-3 flex items-center justify-between hover:bg-gray-50 text-left"
                                >
                                  <span className="flex items-center gap-2 text-sm text-gray-700">
                                    {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                                    <Icon className="w-4 h-4 text-gray-400" />
                                    {label}
                                  </span>
                                  <span className="text-sm">
                                    <span className="font-semibold text-gray-900">{list.length}</span>
                                    <span className="text-gray-400"> · </span>
                                    <span className="font-semibold text-red-600">{money(spend)}</span>
                                  </span>
                                </button>
                                {open && (
                                  <div className="max-h-72 overflow-y-auto border-t border-gray-100">
                                    {list.length === 0 ? (
                                      <div className="px-5 py-4 text-sm text-gray-400">None — every lead was worked.</div>
                                    ) : list.map(l => (
                                      <Link
                                        key={l.id}
                                        href={`/deals/${l.id}`}
                                        className="flex items-center justify-between px-5 py-2 text-sm hover:bg-blue-50 border-b border-gray-50 last:border-0"
                                      >
                                        <span className="text-gray-800 truncate">{l.name || '(no name)'}</span>
                                        <span className="text-gray-500 ml-3 flex-shrink-0">{money(l.leadPrice)}</span>
                                      </Link>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>

                        {/* Who actually dialed */}
                        {dialers.length > 0 && (
                          <div className="px-5 py-3 border-t border-gray-100">
                            <div className="text-xs text-gray-500 mb-2">Dialed by</div>
                            <div className="flex flex-wrap gap-2">
                              {dialers.map(d => (
                                <span key={d.dialer} className="text-sm bg-gray-50 border border-gray-200 rounded-full px-3 py-1 text-gray-700">
                                  {d.dialer}
                                  <span className="text-gray-400"> · </span>
                                  {d.calls.toLocaleString()} calls
                                  <span className="text-gray-400"> · </span>
                                  {hours(d.talkSec)}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {tab === 'economics' && (
            <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100 flex items-start gap-2 bg-blue-50/50">
                <Info className="w-4 h-4 mt-0.5 flex-shrink-0 text-blue-500" />
                <div className="text-sm text-gray-700">
                  <strong>Contact economics, not ROI.</strong> There&apos;s no revenue on this page — a source
                  can cost more per conversation and still be the most profitable. For revenue, see{' '}
                  <Link href="/lead-roi" className="text-blue-700 underline">Lead ROI</Link>.
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-gray-600">
                    <tr>
                      {['Source', 'Leads', 'Spend', 'Connected', 'Dials / lead', '$ / connect', 'Funded'].map((h, i) => (
                        <th key={h} className={`px-4 py-2 font-medium ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {data!.economics.map(r => (
                      <tr key={r.source} className="hover:bg-gray-50">
                        <td className="px-4 py-2.5 text-gray-900 font-medium">{r.source}</td>
                        <td className="px-4 py-2.5 text-right text-gray-700">{r.leads.toLocaleString()}</td>
                        <td className="px-4 py-2.5 text-right text-gray-700">{money(r.spend)}</td>
                        <td className="px-4 py-2.5 text-right text-gray-700">{pct(r.connectedLeads, r.leads)}</td>
                        <td className="px-4 py-2.5 text-right text-gray-700">{r.dialsPerLead.toFixed(1)}</td>
                        <td className="px-4 py-2.5 text-right font-semibold text-gray-900">
                          {r.costPerConnect == null ? '—' : money(r.costPerConnect)}
                        </td>
                        <td className="px-4 py-2.5 text-right text-gray-700">{r.funded}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-5 py-3 border-t border-gray-100 text-xs text-gray-500 flex items-center gap-1.5">
                <DollarSign className="w-3.5 h-3.5" />
                Connected means real talk time — GHL&apos;s &ldquo;Answered&rdquo; status includes voicemails and is not used.
              </div>
            </div>
          )}

          <p className="mt-6 text-xs text-gray-400">
            Purchased leads only ({data!.covered.join(' + ') || 'none'}), scoped to leads that came in between{' '}
            {fmtDate(data!.window?.start ?? null)} and {fmtDate(data!.window?.end ?? null)} — the range the imported
            calls cover. Speed-to-first-dial is measured against the lead-in date, which is approximate.
          </p>
        </>
      )}
    </div>
  )
}
