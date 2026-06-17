'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { useParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { Contact, Deal, STATUS_COLORS } from '@/lib/types'
import { formatCurrency, formatDate, titleCase, dndLabel, dndSummary, cleanSource } from '@/lib/utils'
import { ghlContactUrl } from '@/lib/ghlLinks'
import { ariveUrl } from '@/lib/ariveLinks'
import Link from 'next/link'
import { ArrowLeft, ExternalLink, Ban, Clock } from 'lucide-react'

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
    const label = locId && locId === MATT ? 'GHL · Matt' : locId && locId === MOE ? 'GHL · Moe' : 'GHL'
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
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    setLoading(true)
    const [{ data: c }, { data: d }] = await Promise.all([
      supabase.from('contacts').select('*').eq('id', id).maybeSingle(),
      supabase.from('deals').select('*').eq('borrower_id', id).order('created_at', { ascending: false }),
    ])
    setContact((c as Contact) ?? null)
    setDeals((d as Deal[]) ?? [])
    setLoading(false)
  }, [id])

  useEffect(() => { fetchData() }, [fetchData])

  const subLinks = useMemo(() => subAccountLinks(deals), [deals])
  const reach = useMemo(() => reachability(deals), [deals])
  const details = useMemo(() => buildDetails(deals), [deals])
  const timeline = useMemo(() => buildTimeline(deals), [deals])

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
            <h2 className="text-sm font-semibold text-slate-700 mb-2">Loans ({deals.length})</h2>
            {deals.length === 0 ? (
              <p className="text-sm text-slate-400">No loans on this person.</p>
            ) : (
              <div className="rounded-xl border border-slate-200 overflow-hidden bg-white">
                {deals.map(d => {
                  const ghl = ghlContactUrl(d)
                  const arive = ariveUrl(d.arive_file_no)
                  return (
                    <div key={d.id} className="flex items-start gap-4 px-4 py-3 border-b border-slate-100 last:border-b-0 hover:bg-slate-50">
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
                        </div>
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
    </div>
  )
}
