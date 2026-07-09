'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { useParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { Contact, Deal, STATUS_COLORS } from '@/lib/types'
import { classifyReturning } from '@/lib/repeatReferral'
import { formatCurrency, formatDate, titleCase, dndLabel, dndSummary, cleanSource } from '@/lib/utils'
import { ghlContactUrl } from '@/lib/ghlLinks'
import { ariveUrl } from '@/lib/ariveLinks'
import Link from 'next/link'
import { ArrowLeft, ExternalLink, Ban, Clock, Trash2, Loader2, AlertTriangle, Layers } from 'lucide-react'

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className="font-semibold text-slate-800 tabular-nums">{value}</div>
    </div>
  )
}

// ── Person-level derivations (pure) ──────────────────────────────────────────
// All read straight off the person's loans — no schema or resolver change.

type SubLink = { url: string; label: string }

/** One GHL "view contact" link per distinct sub-account the person lives in.
 *  A person can exist in BOTH Moe's and Matt's GHL with different contact ids —
 *  that cross-account jump is the whole reason the dashboard owns the person. */
function subAccountLinks(deals: Deal[]): SubLink[] {
  const MATT = process.env.NEXT_PUBLIC_GHL_LOCATION_ID_MATT
  const MOE = process.env.NEXT_PUBLIC_GHL_LOCATION_ID
  const RANDY = process.env.NEXT_PUBLIC_GHL_LOCATION_ID_2
  const seen = new Map<string, SubLink>()
  for (const d of deals) {
    if (!d.ghl_contact_id) continue
    const url = ghlContactUrl(d)
    if (!url) continue
    // Label + dedup by the ACTUAL sub-account the link opens (parsed from the URL
    // ghlContactUrl resolved), NOT by loan_officer — that free-text field can
    // disagree with the real GHL location (an opp can sit in Moe's sub-account yet
    // be stamped LO "Matt Park"), which would mislabel the link and split one
    // contact into two rows.
    const locId = url.match(/\/location\/([^/]+)\//)?.[1] ?? ''
    const key = `${locId}:${d.ghl_contact_id}`
    if (seen.has(key)) continue
    const label = locId && locId === MATT ? 'GHL · Matt' : locId && locId === MOE ? 'GHL · Moe' : locId && locId === RANDY ? 'GHL · Randy' : 'GHL'
    seen.set(key, { url, label })
  }
  return [...seen.values()]
}

/** DND / engagement rolled up across the person's loans. If ANY loan blocks a
 *  channel, surface it — safer to over-warn than to text someone who opted out. */
function reachability(deals: Deal[]): {
  dndText: string | null; lastContacted: string | null; lastCommType: string | null; lastInbound: string | null
} {
  const blocked = deals.find(d => dndSummary(d))
  const maxOf = (f: (d: Deal) => string | null | undefined): string | null =>
    deals.map(f).filter((v): v is string => !!v).sort().pop() ?? null
  const lastComm = [...deals].filter(d => d.last_communication_at)
    .sort((a, b) => (b.last_communication_at ?? '').localeCompare(a.last_communication_at ?? ''))[0]
  return {
    dndText: blocked ? dndLabel(blocked) : null,
    lastContacted: maxOf(d => d.last_contacted),
    lastCommType: lastComm?.last_communication_type ?? null,
    lastInbound: maxOf(d => d.last_inbound_at),
  }
}

// Read-only person profile rolled up from the loans — for the Details panel.
type Details = {
  emails: string[]; phones: string[]
  city: string | null; state: string | null
  purpose: string | null; occupancy: string | null; propertyType: string | null
  value: number | null; ltv: number | null; creditRating: string | null; veteran: boolean
  source: string | null; loanOfficers: string[]; leadCost: number; leadCount: number
}
function buildDetails(deals: Deal[]): Details {
  const byRecency = [...deals].sort((a, b) => (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at))
  const pickStr = (f: (d: Deal) => string | null | undefined): string | null => {
    for (const d of byRecency) { const v = (f(d) ?? '').toString().trim(); if (v) return v }
    return null
  }
  const pickNum = (f: (d: Deal) => number | null | undefined): number | null => {
    for (const d of byRecency) { const v = f(d); if (typeof v === 'number' && v > 0) return v }
    return null
  }
  // All distinct contact points across the person's loans (dedup phones by last-10 digits).
  const emails = new Map<string, string>()
  for (const d of deals) { const e = (d.email ?? '').trim().toLowerCase(); if (e) emails.set(e, e) }
  const phones = new Map<string, string>()
  for (const d of deals) {
    const raw = (d.phone ?? '').trim(); if (!raw) continue
    const key = raw.replace(/\D/g, '').slice(-10) || raw
    if (!phones.has(key)) phones.set(key, raw)
  }
  return {
    emails: [...emails.values()],
    phones: [...phones.values()],
    city: pickStr(d => d.city),
    state: pickStr(d => d.state),
    purpose: pickStr(d => d.loan_purpose),
    occupancy: pickStr(d => d.occupancy),
    propertyType: pickStr(d => d.property_type),
    value: pickNum(d => d.estimated_value),
    ltv: pickNum(d => d.ltv),
    creditRating: pickStr(d => d.credit_rating),
    veteran: deals.some(d => (d.is_military ?? '').toString().toLowerCase() === 'yes'),
    source: (() => { for (const d of byRecency) { const s = cleanSource(d.source); if (s) return s } return null })(),
    loanOfficers: [...new Set(deals.map(d => (d.loan_officer ?? '').trim()).filter(Boolean))],
    leadCost: deals.reduce((s, d) => s + (d.lead_price ?? 0), 0),
    leadCount: deals.filter(d => (d.lead_price ?? 0) > 0).length,
  }
}

// One label/value line in the Details panel; renders nothing when the value is empty.
function DRow({ label, children }: { label: string; children: React.ReactNode }) {
  if (children === null || children === undefined || children === false) return null
  return (
    <div>
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className="text-sm text-slate-800 break-words">{children}</div>
    </div>
  )
}
function DGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-2">{title}</div>
      <div className="flex flex-col gap-2.5">{children}</div>
    </div>
  )
}

type TLKind = 'added' | 'stage' | 'signed' | 'funded'
type TLEvent = { date: string; kind: TLKind; label: string; deal: Deal }

const TL_DOT: Record<TLKind, string> = {
  funded: 'bg-emerald-500',
  signed: 'bg-blue-500',
  stage:  'bg-slate-400',
  added:  'bg-slate-300',
}

/** Milestone timeline across all the person's loans, newest first. Built from date
 *  fields only — the `communications` JSONB is empty in this data, so there is no
 *  message timeline to show. */
function buildTimeline(deals: Deal[]): TLEvent[] {
  const evs: TLEvent[] = []
  for (const d of deals) {
    const added = d.date_added_ghl || d.created_at
    if (added) evs.push({ date: added, kind: 'added', label: 'Lead created', deal: d })
    if (d.stage_changed_at) evs.push({ date: d.stage_changed_at, kind: 'stage', label: `Moved to ${d.status}`, deal: d })
    if (d.signing_date) evs.push({ date: d.signing_date, kind: 'signed', label: 'Docs signed', deal: d })
    if (d.funded_date) evs.push({ date: d.funded_date, kind: 'funded', label: 'Funded', deal: d })
  }
  return evs.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
}

export default function ContactDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params.id
  const [contact, setContact] = useState<Contact | null>(null)
  const [deals, setDeals] = useState<Deal[]>([])
  const [coLoans, setCoLoans] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmMode, setConfirmMode] = useState<'delete' | 'merge' | null>(null)
  const [primaryId, setPrimaryId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    const [{ data: c }, { data: d }] = await Promise.all([
      supabase.from('contacts').select('*').eq('id', id).maybeSingle(),
      supabase.from('deals').select('*').eq('borrower_id', id).order('created_at', { ascending: false }),
    ])
    setContact((c as Contact) ?? null)
    setDeals((d as Deal[]) ?? [])
    // Loans where this person is a CO-borrower (not the primary). Shown separately;
    // these count toward the PRIMARY's $ rollups, not this contact's.
    const { data: links } = await supabase.from('deal_contacts').select('deal_id').eq('contact_id', id).eq('role', 'co')
    const coIds = ((links ?? []) as { deal_id: string }[]).map(l => l.deal_id)
    if (coIds.length) {
      const { data: cd } = await supabase.from('deals').select('*').in('id', coIds).order('created_at', { ascending: false })
      setCoLoans((cd as Deal[]) ?? [])
    } else setCoLoans([])
    setLoading(false)
  }, [id])

  useEffect(() => { fetchData() }, [fetchData])

  const selectedDeals = deals.filter(d => selected.has(d.id))

  function toggleSelect(dealId: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(dealId)) next.delete(dealId)
      else next.add(dealId)
      return next
    })
  }
  function clearSelection() {
    setSelected(new Set())
    setConfirmMode(null)
    setPrimaryId(null)
    setActionError(null)
  }
  function openMerge() {
    // Default primary: a funded loan, else the largest, else the first selected.
    const funded = selectedDeals.find(d => d.funded_date)
    const byAmount = [...selectedDeals].sort((a, b) => (b.loan_amount ?? 0) - (a.loan_amount ?? 0))
    setPrimaryId(funded?.id ?? byAmount[0]?.id ?? selectedDeals[0]?.id ?? null)
    setActionError(null)
    setConfirmMode('merge')
  }
  function openDelete() {
    setActionError(null)
    setConfirmMode('delete')
  }

  async function handleDelete() {
    if (!selectedDeals.length) return
    setBusy(true)
    setActionError(null)
    try {
      for (const dealId of selectedDeals.map(d => d.id)) {
        const res = await fetch(`/api/deals/${dealId}`, { method: 'DELETE' })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
      }
      setDeals(prev => prev.filter(x => !selected.has(x.id)))
      setCoLoans(prev => prev.filter(x => !selected.has(x.id)))
      clearSelection()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleMerge() {
    if (!primaryId || selectedDeals.length < 2) return
    setBusy(true)
    setActionError(null)
    try {
      const secondaryIds = selectedDeals.filter(d => d.id !== primaryId).map(d => d.id)
      const res = await fetch('/api/deals/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ primaryId, secondaryIds }),
      })
      const data = await res.json().catch(() => ({}))
      if (!data.success) throw new Error(data.error || `HTTP ${res.status}`)
      clearSelection()
      await fetchData()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const subLinks = useMemo(() => subAccountLinks(deals), [deals])
  const reach = useMemo(() => reachability(deals), [deals])
  const details = useMemo(() => buildDetails(deals), [deals])
  const timeline = useMemo(() => buildTimeline(deals), [deals])
  const returning = useMemo(() => classifyReturning(deals), [deals])

  if (loading) return <div className="p-6 text-sm text-slate-400">Loading…</div>
  if (!contact) {
    return (
      <div className="p-6">
        <Link href="/contacts" className="flex items-center gap-1 text-blue-600 text-sm w-fit"><ArrowLeft className="w-4 h-4" /> Contacts</Link>
        <p className="mt-4 text-sm text-slate-500">Contact not found.</p>
      </div>
    )
  }

  const name = titleCase(contact.display_name) || contact.display_name || '(no name)'

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="px-6 py-4 bg-white border-b border-slate-200 shrink-0">
        <Link href="/contacts" className="flex items-center gap-1 text-slate-500 hover:text-slate-700 text-sm mb-3 w-fit">
          <ArrowLeft className="w-4 h-4" /> Contacts
        </Link>
        <h1 className="text-xl font-bold text-slate-900">{name}</h1>
        <p className="text-sm text-slate-500 mt-0.5">{[contact.email, contact.phone].filter(Boolean).join(' · ') || '—'}</p>

        {returning && (
          <div className="mt-3 flex items-start gap-2 px-3 py-2 rounded-lg bg-violet-50 border border-violet-200 text-sm text-violet-900 w-fit">
            <span className="font-semibold">Returning client</span>
            <span className="text-violet-700">
              — funded {returning.fundedCount} loan{returning.fundedCount === 1 ? '' : 's'}
              {returning.totalFundedVolume > 0 && <> ({formatCurrency(returning.totalFundedVolume)})</>}
              {returning.lastFundedAt && <>, last {formatDate(returning.lastFundedAt)}</>}
              ; came back {formatDate(returning.newDeal.created_at)}
              {returning.newDeal.status && <> — now in {returning.newDeal.status}</>}
              {!returning.active && <> (not currently active)</>}
            </span>
          </div>
        )}

        {/* Reachability + jump bar */}
        <div className="flex flex-wrap items-center gap-2 mt-3">
          {reach.dndText && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md bg-red-50 text-red-700 border border-red-200">
              <Ban className="w-3 h-3" /> {reach.dndText}
            </span>
          )}
          {reach.lastContacted && (
            <span className="inline-flex items-center gap-1 text-[11px] text-slate-500 px-2 py-1 rounded-md bg-slate-50 border border-slate-200">
              <Clock className="w-3 h-3" /> Last contacted {formatDate(reach.lastContacted)}
            </span>
          )}
          {subLinks.map(l => (
            <a
              key={l.url}
              href={l.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 transition"
            >
              <ExternalLink className="w-3 h-3" /> {l.label}
            </a>
          ))}
        </div>

        {/* Rollups */}
        <div className="flex flex-wrap gap-6 mt-3">
          <Stat label="Loans" value={String(contact.loan_count)} />
          <Stat label="Funded" value={String(contact.funded_count)} />
          <Stat label="Funded volume" value={formatCurrency(contact.total_funded_volume)} />
          <Stat label="Comp" value={formatCurrency(contact.total_comp)} />
        </div>
        {(contact.first_loan_at || contact.last_loan_at) && (
          <p className="text-[11px] text-slate-400 mt-2">
            First seen {formatDate(contact.first_loan_at)} · Last activity {formatDate(contact.last_loan_at)}
          </p>
        )}
      </div>

      {/* ── Body ────────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="max-w-4xl mx-auto space-y-6">

          {/* Details (read-only profile, rolled up from the loans) */}
          {deals.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-slate-700 mb-2">Details</h2>
              <div className="rounded-xl border border-slate-200 bg-white p-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">

                <DGroup title="Contact">
                  {details.emails.length > 0 && (
                    <DRow label={details.emails.length > 1 ? 'Emails' : 'Email'}>
                      <div className="flex flex-col gap-0.5">
                        {details.emails.map(e => (
                          <a key={e} href={`mailto:${e}`} className="text-blue-600 hover:text-blue-700 break-all">{e}</a>
                        ))}
                      </div>
                    </DRow>
                  )}
                  {details.phones.length > 0 && (
                    <DRow label={details.phones.length > 1 ? 'Phones' : 'Phone'}>
                      <div className="flex flex-col gap-0.5">
                        {details.phones.map(p => (
                          <a key={p} href={`tel:${p.replace(/[^\d+]/g, '')}`} className="text-blue-600 hover:text-blue-700">{p}</a>
                        ))}
                      </div>
                    </DRow>
                  )}
                  {details.emails.length === 0 && details.phones.length === 0 && (
                    <span className="text-sm text-slate-400">—</span>
                  )}
                </DGroup>

                <DGroup title="Profile">
                  <DRow label="Location">{[details.city, details.state].filter(Boolean).join(', ') || null}</DRow>
                  <DRow label="Purpose">{details.purpose}</DRow>
                  <DRow label="Occupancy">{[details.occupancy, details.propertyType].filter(Boolean).join(' · ') || null}</DRow>
                  <DRow label="Value · LTV">{details.value ? `${formatCurrency(details.value)}${details.ltv ? ` · ${details.ltv}% LTV` : ''}` : (details.ltv ? `${details.ltv}% LTV` : null)}</DRow>
                  <DRow label="Credit">{details.creditRating}</DRow>
                  {details.veteran && <DRow label="Veteran"><span className="text-emerald-700">Yes · VA-eligible</span></DRow>}
                </DGroup>

                <DGroup title="Source & cost">
                  <DRow label="Lead source">{details.source}</DRow>
                  <DRow label={details.loanOfficers.length > 1 ? 'Loan officers' : 'Loan officer'}>{details.loanOfficers.join(', ') || null}</DRow>
                  <DRow label="Acquisition cost">{details.leadCost > 0 ? `${formatCurrency(details.leadCost)} · ${details.leadCount} ${details.leadCount === 1 ? 'lead' : 'leads'}` : null}</DRow>
                  <DRow label="Return">{contact.total_funded_volume > 0 ? `Funded ${formatCurrency(contact.total_funded_volume)} · comp ${formatCurrency(contact.total_comp)}` : 'No funding yet'}</DRow>
                </DGroup>

                <DGroup title="Reachability">
                  <DRow label="Status">
                    {reach.dndText
                      ? <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-md bg-red-50 text-red-700 border border-red-200"><Ban className="w-3 h-3" /> {reach.dndText}</span>
                      : <span className="text-emerald-700">No DND flags</span>}
                  </DRow>
                  <DRow label="Last contact">{reach.lastContacted ? `${formatDate(reach.lastContacted)}${reach.lastCommType ? ` · ${reach.lastCommType}` : ''}` : null}</DRow>
                  <DRow label="Last heard back">{reach.lastInbound ? formatDate(reach.lastInbound) : null}</DRow>
                </DGroup>

              </div>
            </section>
          )}

          {/* Loans */}
          <section>
            <div className="flex items-center justify-between gap-2 mb-2 min-h-[28px]">
              <h2 className="text-sm font-semibold text-slate-700">Loans ({deals.length})</h2>
              {selected.size > 0 && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-slate-500">{selected.size} selected</span>
                  {selected.size >= 2 && (
                    <button onClick={openMerge} className="inline-flex items-center gap-1 px-2.5 py-1 font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700">
                      <Layers className="w-3.5 h-3.5" /> Merge
                    </button>
                  )}
                  <button onClick={openDelete} className="inline-flex items-center gap-1 px-2.5 py-1 font-medium text-red-600 border border-red-200 rounded-md hover:bg-red-50">
                    <Trash2 className="w-3.5 h-3.5" /> Delete
                  </button>
                  <button onClick={clearSelection} className="text-slate-400 hover:text-slate-700">Clear</button>
                </div>
              )}
            </div>
            {deals.length === 0 ? (
              <p className="text-sm text-slate-400">No loans on this person.</p>
            ) : (
              <div className="rounded-xl border border-slate-200 overflow-hidden bg-white">
                {deals.map(d => {
                  const ghl = ghlContactUrl(d)
                  const arive = ariveUrl(d.arive_file_no)
                  const source = cleanSource(d.source)
                  const isSel = selected.has(d.id)
                  return (
                    <div key={d.id} className={`flex items-start gap-3 px-4 py-3 border-b border-slate-100 last:border-b-0 ${isSel ? 'bg-blue-50/60' : 'hover:bg-slate-50'}`}>
                      <input
                        type="checkbox"
                        checked={isSel}
                        onChange={() => toggleSelect(d.id)}
                        className="mt-1 w-4 h-4 accent-blue-600 shrink-0"
                        title="Select loan"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Link href={`/deals/${d.id}`} className="font-medium text-blue-600 hover:text-blue-700">
                            {titleCase(d.name) || d.name}
                          </Link>
                          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${STATUS_COLORS[d.status] || 'bg-gray-100 text-gray-600'}`}>
                            {d.status}
                          </span>
                          {d.loan_type && (
                            <span className="text-[11px] text-slate-500">
                              {d.loan_type}{d.loan_purpose ? ` · ${d.loan_purpose}` : ''}
                            </span>
                          )}
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-xs text-slate-500 flex-wrap">
                          {d.property_address && (
                            <span className="truncate max-w-[340px]">{d.property_address}{d.state ? `, ${d.state}` : ''}</span>
                          )}
                          {d.rate ? <span>· {d.rate}%</span> : null}
                          {d.funded_date ? <span>· Funded {formatDate(d.funded_date)}</span> : null}
                          {d.loan_officer ? <span>· {d.loan_officer}</span> : null}
                          {source ? <span>· {source}</span> : null}
                        </div>
                        {(d.arive_file_no || d.investor_file_no) && (
                          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-400 flex-wrap">
                            {d.arive_file_no && <span>Arive #{d.arive_file_no}</span>}
                            {d.arive_file_no && d.investor_file_no && <span>·</span>}
                            {d.investor_file_no && <span>Lender #{d.investor_file_no}</span>}
                          </div>
                        )}
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-sm font-semibold text-slate-800 tabular-nums">
                          {d.loan_amount ? formatCurrency(d.loan_amount) : '—'}
                        </div>
                        <div className="mt-1 flex items-center gap-2 justify-end">
                          {ghl && (
                            <a href={ghl} target="_blank" rel="noopener noreferrer" className="text-[11px] text-blue-600 hover:text-blue-700 inline-flex items-center gap-0.5">
                              GHL <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                          {arive && (
                            <a href={arive} target="_blank" rel="noopener noreferrer" className="text-[11px] text-emerald-700 hover:text-emerald-800 inline-flex items-center gap-0.5">
                              Arive <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          {/* Co-borrower loans — this person is a co-borrower, not the primary */}
          {coLoans.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-slate-700 mb-2">Co-borrower on ({coLoans.length})</h2>
              <div className="rounded-xl border border-slate-200 overflow-hidden bg-white">
                {coLoans.map(d => (
                  <div key={d.id} className="flex items-center justify-between gap-4 px-4 py-3 border-b border-slate-100 last:border-b-0 hover:bg-slate-50">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Link href={`/deals/${d.id}`} className="font-medium text-blue-600 hover:text-blue-700">{titleCase(d.name) || d.name}</Link>
                        <span className="text-[10px] font-medium bg-sky-100 text-sky-700 px-1.5 py-0.5 rounded">Co-borrower</span>
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${STATUS_COLORS[d.status] || 'bg-gray-100 text-gray-600'}`}>{d.status}</span>
                      </div>
                      {d.property_address && (
                        <div className="mt-1 text-xs text-slate-500 truncate max-w-[340px]">{d.property_address}{d.state ? `, ${d.state}` : ''}</div>
                      )}
                    </div>
                    <div className="shrink-0 text-sm font-semibold text-slate-800 tabular-nums">{d.loan_amount ? formatCurrency(d.loan_amount) : '—'}</div>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-slate-400 mt-1.5">These loans count toward the primary borrower&apos;s totals, not this person&apos;s.</p>
            </section>
          )}

          {/* Activity timeline */}
          {timeline.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-slate-700 mb-2">Activity</h2>
              <ol className="relative border-l border-slate-200 ml-1.5">
                {timeline.map((e, i) => (
                  <li key={`${e.deal.id}-${e.kind}-${i}`} className="ml-4 pb-4 last:pb-0">
                    <span className={`absolute -left-[5px] mt-1.5 w-2.5 h-2.5 rounded-full ${TL_DOT[e.kind]}`} />
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="text-sm text-slate-700">
                        {e.label}
                        {deals.length > 1 && (
                          <>
                            {' · '}
                            <Link href={`/deals/${e.deal.id}`} className="text-blue-600 hover:text-blue-700">
                              {titleCase(e.deal.name) || e.deal.name}
                            </Link>
                          </>
                        )}
                        {e.kind === 'funded' && e.deal.loan_amount ? (
                          <span className="text-slate-500"> · {formatCurrency(e.deal.loan_amount)}</span>
                        ) : null}
                      </div>
                      <div className="text-xs text-slate-400 whitespace-nowrap tabular-nums">{formatDate(e.date)}</div>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
      </div>

      {/* Delete / Merge confirmation */}
      {confirmMode && selectedDeals.length > 0 && (
        <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4" onClick={() => { if (!busy) { setConfirmMode(null); setActionError(null) } }}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5" onClick={e => e.stopPropagation()}>
            {confirmMode === 'delete' ? (
              <>
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-full bg-red-50 flex items-center justify-center shrink-0">
                    <AlertTriangle className="w-5 h-5 text-red-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-slate-900">Delete {selectedDeals.length === 1 ? 'this loan' : `${selectedDeals.length} loans`}?</h3>
                    <p className="text-sm text-slate-600 mt-0.5">This permanently removes {selectedDeals.length === 1 ? 'it' : 'them'} from the dashboard and can&apos;t be undone.</p>
                  </div>
                </div>
                <div className="mt-3 space-y-1.5 max-h-52 overflow-auto">
                  {selectedDeals.map(d => (
                    <div key={d.id} className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
                      <div className="text-sm font-medium text-slate-800">{titleCase(d.name) || d.name}</div>
                      <div className="text-xs text-slate-500 mt-0.5">{[d.loan_type, d.loan_amount ? formatCurrency(d.loan_amount) : null, d.status].filter(Boolean).join(' · ')}</div>
                      {(d.arive_file_no || d.investor_file_no) && (
                        <div className="text-[11px] text-slate-400 mt-0.5">{[d.arive_file_no ? `Arive #${d.arive_file_no}` : null, d.investor_file_no ? `Lender #${d.investor_file_no}` : null].filter(Boolean).join(' · ')}</div>
                      )}
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-2 mt-3">
                  If a loan still exists in GHL, a future sync may re-create it. Best for clearing duplicates or bad rows.
                </p>
              </>
            ) : (
              <>
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
                    <Layers className="w-5 h-5 text-blue-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-slate-900">Merge {selectedDeals.length} loans?</h3>
                    <p className="text-sm text-slate-600 mt-0.5">Pick the loan to keep. Blank fields fill from the others, notes &amp; tags combine, then the rest are deleted.</p>
                  </div>
                </div>
                <div className="mt-3 space-y-1.5 max-h-60 overflow-auto">
                  {selectedDeals.map(d => {
                    const isPrimary = primaryId === d.id
                    return (
                      <label key={d.id} className={`flex items-start gap-2.5 rounded-lg border p-2.5 cursor-pointer ${isPrimary ? 'border-blue-400 bg-blue-50 ring-1 ring-blue-200' : 'border-slate-200 hover:border-slate-300'}`}>
                        <input type="radio" name="merge-primary" checked={isPrimary} onChange={() => setPrimaryId(d.id)} className="mt-0.5 w-4 h-4 accent-blue-600 shrink-0" />
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-slate-800">
                            {titleCase(d.name) || d.name}
                            {isPrimary && <span className="ml-1.5 text-[10px] font-semibold text-blue-700">KEEP</span>}
                          </div>
                          <div className="text-xs text-slate-500 mt-0.5">{[d.loan_type, d.loan_amount ? formatCurrency(d.loan_amount) : null, d.status, d.funded_date ? `Funded ${formatDate(d.funded_date)}` : null].filter(Boolean).join(' · ')}</div>
                          {(d.arive_file_no || d.investor_file_no) && (
                            <div className="text-[11px] text-slate-400 mt-0.5">{[d.arive_file_no ? `Arive #${d.arive_file_no}` : null, d.investor_file_no ? `Lender #${d.investor_file_no}` : null].filter(Boolean).join(' · ')}</div>
                          )}
                        </div>
                      </label>
                    )
                  })}
                </div>
              </>
            )}
            {actionError && <p className="text-xs text-red-600 mt-2">{actionError}</p>}
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => { setConfirmMode(null); setActionError(null) }} disabled={busy} className="px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 rounded-lg disabled:opacity-50">Cancel</button>
              {confirmMode === 'delete' ? (
                <button onClick={handleDelete} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50">
                  {busy ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Deleting…</> : <><Trash2 className="w-3.5 h-3.5" /> Delete {selectedDeals.length > 1 ? `${selectedDeals.length} loans` : 'loan'}</>}
                </button>
              ) : (
                <button onClick={handleMerge} disabled={busy || !primaryId} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                  {busy ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Merging…</> : <><Layers className="w-3.5 h-3.5" /> Merge into selected</>}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
