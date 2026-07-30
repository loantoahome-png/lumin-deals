'use client'

// Per-LO Follow-Up Cockpit — "who do I contact today, in what order, and why?"
// Spec: docs/specs/2026-07-30-follow-up-cockpit-spec.md
//
// Merges GHL-backed deals (due/urgent only — /hot-leads owns the working tabs)
// with the FUB book (new / stale nurture / past clients — no other home in the
// dashboard). Bookmarkable per LO: /follow-up/moe, /follow-up/matt.
//
// Write paths from this page (client-side, authenticated):
//   • GHL rows  → deals.next_action_due / next_action (SNOOZE — same field the
//     Check-ins tab reads, so a snooze here IS a check-in there).
//   • FUB rows  → fub_people cockpit-state columns (snooze + touched). The FUB
//     sync never writes these, so they survive every sweep.
// stage_events is server-only by design — no client inserts here.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { fetchAllDeals } from '@/lib/fetchAllDeals'
import { ghlContactUrl } from '@/lib/ghlLinks'
import { LO_COLORS } from '@/components/LoFilter'
import TriageDateModal from '@/components/TriageDateModal'
import {
  buildFollowUpQueue, buildTaskQueue, snoozeIso, SNOOZE_PRESETS, TASK_WINDOW_DAYS,
  type FollowUpQueue, type TaskQueue, type QueueDealLike, type QueueFubLike, type QueueTaskLike,
  type QueueItem, type StaleBuckets, type TaskItem,
} from '@/lib/followUpQueue'
import { Flame, RefreshCw, CheckCircle2, Clock, ChevronDown, ExternalLink, PhoneCall, ListTodo } from 'lucide-react'

const LO_SLUGS: Record<string, string> = { moe: 'Moe Sefati', matt: 'Matt Park' }

const FU_DEAL_COLUMNS = [
  'id', 'name', 'status', 'ghl_status', 'pipeline_group', 'loan_officer',
  'created_at', 'date_added_ghl', 'next_action_due', 'next_action',
  'last_inbound_at', 'last_outbound_at', 'last_inbound_message', 'loan_amount',
  'ghl_contact_id', 'ghl_opportunity_id', 'ghl_location_id',
].join(',')

const FUB_COLUMNS = [
  'fub_id', 'name', 'stage', 'loan_officer', 'price', 'deal_price', 'source',
  'last_activity_at', 'fub_created_at', 'next_action_due', 'next_action',
  'last_touched_at', 'matched_deal_active', 'missing_since',
].join(',')

const TASK_COLUMNS = 'fub_task_id,person_id,loan_officer,name,type,due_date,due_date_time'

async function fetchFubTasks(lo: string): Promise<QueueTaskLike[]> {
  const { data, error } = await supabase
    .from('fub_tasks').select(TASK_COLUMNS).eq('loan_officer', lo)
    .order('due_date', { ascending: true }).limit(1000)
  if (error) { console.error('[follow-up] task fetch failed:', error.message); return [] }
  return (data as unknown as QueueTaskLike[]) ?? []
}

async function fetchFubRows(lo: string): Promise<QueueFubLike[]> {
  const all: QueueFubLike[] = []
  const PAGE = 1000
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from('fub_people')
      .select(FUB_COLUMNS)
      .eq('loan_officer', lo)
      .is('missing_since', null)
      .range(offset, offset + PAGE - 1)
    if (error) { console.error('[follow-up] fub fetch failed:', error.message); break }
    const rows = (data as unknown as QueueFubLike[]) ?? []
    all.push(...rows)
    if (rows.length < PAGE) break
  }
  return all
}

// Account subdomain verified from the team's own FUB session (nova.followupboss.com).
const fubUrl = (fubId: number) => `https://nova.followupboss.com/2/people/view/${fubId}`

const TASK_TYPE_ICON: Record<string, string> = {
  'Follow Up': '↩', Call: '📞', Text: '💬', Email: '✉', Appointment: '📅', Showing: '🏠', Closing: '🔑', 'Thank You': '🙏',
}

const fmtSynced = (iso: string | null): string => {
  if (!iso) return 'never'
  const mins = Math.floor((Date.now() - Date.parse(iso)) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`
}

export default function FollowUpCockpit() {
  const params = useParams<{ lo: string }>()
  const slug = (params.lo ?? '').toLowerCase()
  const lo = LO_SLUGS[slug]

  const [deals, setDeals] = useState<QueueDealLike[]>([])
  const [fub, setFub] = useState<QueueFubLike[]>([])
  const [tasks, setTasks] = useState<QueueTaskLike[]>([])
  const [loading, setLoading] = useState(true)
  const [syncedAt, setSyncedAt] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  // Snooze UI state: which row's preset menu is open / which row is picking a custom date.
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [modalFor, setModalFor] = useState<QueueItem | null>(null)

  const load = useCallback(async () => {
    if (!lo) return
    setLoading(true)
    const [d, f, t, s] = await Promise.all([
      fetchAllDeals(q => q.eq('loan_officer', lo), FU_DEAL_COLUMNS),
      fetchFubRows(lo),
      fetchFubTasks(lo),
      // sync_state is server-only (no client RLS policies) — read via the API.
      fetch('/api/sync/fub').then(r => r.ok ? r.json() : null).catch(() => null),
    ])
    setDeals(d as unknown as QueueDealLike[])
    setFub(f)
    setTasks(t)
    setSyncedAt((s as { last_at?: string } | null)?.last_at ?? null)
    setLoading(false)
  }, [lo])

  useEffect(() => { load() }, [load])

  const queue: FollowUpQueue = useMemo(
    () => buildFollowUpQueue({ deals, fub, lo: lo ?? '' }),
    [deals, fub, lo],
  )
  const taskQueue: TaskQueue = useMemo(
    () => buildTaskQueue({ tasks, people: fub, lo: lo ?? '' }),
    [tasks, fub, lo],
  )

  // ── Actions ────────────────────────────────────────────────────────────────

  async function snooze(item: QueueItem, dueIso: string, note?: string) {
    setMenuFor(null); setModalFor(null)
    if (item.system === 'ghl' && item.dealId) {
      const patch: Record<string, unknown> = { next_action_due: dueIso }
      if (note) patch.next_action = `Check in: ${note}`
      const { error } = await supabase.from('deals').update(patch).eq('id', item.dealId)
      if (error) { console.error('[follow-up] deal snooze failed:', error.message); return }
      setDeals(prev => prev.map(d => d.id === item.dealId ? { ...d, next_action_due: dueIso, ...(note ? { next_action: `Check in: ${note}` } : {}) } : d))
    } else if (item.fubId != null) {
      const patch: Record<string, unknown> = { next_action_due: dueIso, updated_at: new Date().toISOString() }
      if (note) patch.next_action = note
      const { error } = await supabase.from('fub_people').update(patch).eq('fub_id', item.fubId)
      if (error) { console.error('[follow-up] fub snooze failed:', error.message); return }
      setFub(prev => prev.map(f => f.fub_id === item.fubId ? { ...f, next_action_due: dueIso, ...(note ? { next_action: note } : {}) } : f))
    }
  }

  /** FUB only — log that the LO reached out today; row leaves today's queue. */
  async function markTouched(item: QueueItem) {
    if (item.fubId == null) return
    const nowIso = new Date().toISOString()
    const { error } = await supabase.from('fub_people')
      .update({ last_touched_at: nowIso, next_action_due: null, updated_at: nowIso })
      .eq('fub_id', item.fubId)
    if (error) { console.error('[follow-up] touch failed:', error.message); return }
    setFub(prev => prev.map(f => f.fub_id === item.fubId ? { ...f, last_touched_at: nowIso, next_action_due: null } : f))
  }

  async function syncNow() {
    setSyncing(true)
    try {
      const res = await fetch('/api/sync/fub?force=1', { method: 'POST' })
      const body = await res.json().catch(() => null)
      if (!res.ok) console.error('[follow-up] sync failed:', body)
      await load()
    } finally {
      setSyncing(false)
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (!lo) {
    return (
      <div className="p-8">
        <p className="text-slate-600">Unknown page. Pick a cockpit:</p>
        <div className="flex gap-3 mt-3">
          <Link href="/follow-up/moe" className="text-blue-700 underline">Moe</Link>
          <Link href="/follow-up/matt" className="text-blue-700 underline">Matt</Link>
        </div>
      </div>
    )
  }

  const color = LO_COLORS[lo] ?? '#64748b'
  const c = queue.counts

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="px-6 py-4 bg-white border-b border-slate-200 shrink-0 sticky top-0 z-10">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
              <PhoneCall className="w-5 h-5" style={{ color }} />
              Follow-Up — {lo.split(' ')[0]}
              <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: color }} />
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">
              Today&apos;s queue across GHL + FollowUpBoss · FUB synced {fmtSynced(syncedAt)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link href={`/follow-up/${slug === 'moe' ? 'matt' : 'moe'}`} className="text-xs text-slate-500 hover:text-slate-800 px-2 py-1.5">
              switch to {slug === 'moe' ? 'Matt' : 'Moe'}
            </Link>
            <Link href="/hot-leads" className="text-xs font-medium text-orange-700 bg-orange-50 border border-orange-200 rounded-lg px-3 py-1.5 hover:bg-orange-100 flex items-center gap-1">
              <Flame className="w-3.5 h-3.5" /> Hot Leads
            </Link>
            <button onClick={syncNow} disabled={syncing}
              className="text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg px-3 py-1.5 hover:bg-slate-50 flex items-center gap-1 disabled:opacity-50">
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} /> Sync FUB
            </button>
          </div>
        </div>
        {/* Counts strip */}
        <div className="flex gap-2 mt-3 flex-wrap text-xs">
          <CountChip label="Reply waiting" n={c.replyWaiting} cls="bg-red-50 text-red-700 border-red-200" />
          <CountChip label="New" n={c.newLeads} cls="bg-emerald-50 text-emerald-700 border-emerald-200" />
          <CountChip label={`Due today${c.overdue ? ` (${c.overdue} overdue)` : ''}`} n={c.dueToday} cls="bg-amber-50 text-amber-800 border-amber-200" />
          <CountChip label="FUB tasks (7d)" n={taskQueue.counts.today + taskQueue.counts.next7} cls="bg-indigo-50 text-indigo-700 border-indigo-200" />
          <CountChip label="Stale nurture" n={c.stale} cls="bg-sky-50 text-sky-700 border-sky-200" />
          <CountChip label="Past clients" n={c.pastClients} cls="bg-violet-50 text-violet-700 border-violet-200" />
        </div>
      </div>

      {loading ? (
        <div className="p-10 text-slate-500 text-sm">Loading the queue…</div>
      ) : (
        <div className="p-6 space-y-6 max-w-5xl">
          <Section title="🔥 Reply waiting" subtitle="They messaged — nobody has answered yet" items={queue.replyWaiting}
            empty="Inbox zero. No unanswered replies." renderActions={rowActions} />
          <Section title="⏱ New leads" subtitle="Fresh arrivals — speed to lead wins these" items={queue.newLeads}
            empty="No new leads right now." renderActions={rowActions} />
          <Section title="📅 Due today" subtitle="Check-ins and follow-ups you promised" items={queue.dueToday}
            empty="Nothing due. Get ahead with the stale list below." renderActions={rowActions} />
          <TaskSection queue={taskQueue} />
          <BucketSection title="🕳 Stale nurture (FUB)" subtitle="Open pipeline going quiet — highest value first"
            buckets={queue.stale} renderActions={rowActions} />
          <BucketSection title="💤 Past clients & closed (FUB)" subtitle="The farming pool — refis, referrals, anniversaries"
            buckets={queue.pastClients} renderActions={rowActions} />
        </div>
      )}

      {modalFor && (
        <TriageDateModal
          title={`Snooze — next follow-up for ${modalFor.name}`}
          leadNames={[modalFor.name]}
          confirmLabel="Set follow-up"
          onConfirm={({ dueIso, note }) => snooze(modalFor, dueIso, note)}
          onClose={() => setModalFor(null)}
        />
      )}
    </div>
  )

  // Row action cluster: snooze menu (+custom), touched (FUB), deep links.
  function rowActions(item: QueueItem) {
    const open = menuFor === item.key
    return (
      <div className="flex items-center gap-1 shrink-0">
        {item.system === 'fub' && (
          <button onClick={() => markTouched(item)} title="Mark touched today — clears it from the queue"
            className="text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-1 hover:bg-emerald-100 flex items-center gap-0.5">
            <CheckCircle2 className="w-3 h-3" /> Touched
          </button>
        )}
        <div className="relative">
          <button onClick={() => setMenuFor(open ? null : item.key)}
            className="text-[10px] font-semibold text-slate-600 bg-slate-50 border border-slate-200 rounded px-1.5 py-1 hover:bg-slate-100 flex items-center gap-0.5">
            <Clock className="w-3 h-3" /> Snooze <ChevronDown className="w-2.5 h-2.5" />
          </button>
          {open && (
            <div className="absolute right-0 top-7 z-20 bg-white border border-slate-200 rounded-lg shadow-lg py-1 w-28">
              {SNOOZE_PRESETS.map(p => (
                <button key={p.days} onClick={() => snooze(item, snoozeIso(p.days))}
                  className="block w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50">
                  {p.label}
                </button>
              ))}
              <button onClick={() => { setMenuFor(null); setModalFor(item) }}
                className="block w-full text-left px-3 py-1.5 text-xs text-blue-700 hover:bg-blue-50 border-t border-slate-100">
                Pick date…
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }
}

// ── FUB tasks ───────────────────────────────────────────────────────────────
// The LO's own FollowUpBoss reminders: due today, the next 7 days, and the
// overdue backlog (Matt's is 583 deep, so it's capped with a show-all).
const TASK_PREVIEW = 10

function TaskSection({ queue }: { queue: TaskQueue }) {
  const [showAllOverdue, setShowAllOverdue] = useState(false)
  const inWindow = queue.counts.today + queue.counts.next7
  const overdueShown = showAllOverdue ? queue.overdue : queue.overdue.slice(0, TASK_PREVIEW)
  return (
    <section>
      <div className="flex items-baseline gap-2 mb-2">
        <h2 className="text-sm font-bold text-slate-800 flex items-center gap-1.5">
          <ListTodo className="w-4 h-4 text-indigo-600" /> FollowUpBoss tasks
        </h2>
        <span className="text-xs text-slate-400">Your own FUB reminders — next {TASK_WINDOW_DAYS} days</span>
        <span className="text-xs font-semibold text-slate-500 ml-auto">{inWindow}</span>
      </div>

      {queue.overdue.length > 0 && (
        <div className="mb-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-red-500 mb-1">
            Overdue · {queue.overdue.length} <span className="normal-case font-normal text-slate-400">(most recent first)</span>
          </p>
          <div className="space-y-1.5">{overdueShown.map(t => <TaskRow key={t.key} task={t} />)}</div>
          {queue.overdue.length > TASK_PREVIEW && (
            <button onClick={() => setShowAllOverdue(v => !v)} className="text-xs text-blue-700 hover:underline mt-1">
              {showAllOverdue ? 'Show fewer' : `Show all ${queue.overdue.length} overdue`}
            </button>
          )}
        </div>
      )}

      {queue.today.length > 0 && (
        <div className="mb-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-600 mb-1">Due today · {queue.today.length}</p>
          <div className="space-y-1.5">{queue.today.map(t => <TaskRow key={t.key} task={t} />)}</div>
        </div>
      )}

      {queue.next7.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">Next {TASK_WINDOW_DAYS} days · {queue.next7.length}</p>
          <div className="space-y-1.5">{queue.next7.map(t => <TaskRow key={t.key} task={t} />)}</div>
        </div>
      )}

      {inWindow === 0 && queue.overdue.length === 0 && (
        <p className="text-xs text-slate-400 border border-dashed border-slate-200 rounded-lg px-3 py-2.5">
          No FollowUpBoss tasks due in the next {TASK_WINDOW_DAYS} days.
        </p>
      )}
    </section>
  )
}

function TaskRow({ task }: { task: TaskItem }) {
  const link = task.personId != null ? fubUrl(task.personId) : null
  return (
    <div className={`flex items-center gap-2 bg-white border rounded-lg px-3 py-2 ${task.overdueDays > 0 ? 'border-red-200 bg-red-50/40' : 'border-slate-200'}`}>
      <span className="shrink-0 text-[9px] font-bold rounded px-1 py-0.5 border text-indigo-700 bg-indigo-50 border-indigo-200"
        title={task.type}>
        {TASK_TYPE_ICON[task.type] ?? '•'} FUB
      </span>
      <span className="font-semibold text-sm text-slate-900 truncate shrink-0 max-w-[11rem]">{task.personName}</span>
      {task.personStage && <span className="shrink-0 text-[10px] text-slate-500 bg-slate-100 rounded px-1.5 py-0.5">{task.personStage}</span>}
      <span className="text-xs text-slate-600 truncate" title={task.title}>{task.title}</span>
      <div className="ml-auto flex items-center gap-2 shrink-0">
        <span className={`text-[11px] font-medium ${task.overdueDays > 0 ? 'text-red-700' : task.dueLabel === 'due today' ? 'text-amber-700' : 'text-slate-500'}`}>
          {task.dueLabel}
        </span>
        {link && (
          <a href={link} target="_blank" rel="noopener noreferrer"
            title="Open this lead in FollowUpBoss"
            className="text-[10px] font-semibold text-violet-700 bg-violet-50 border border-violet-200 rounded px-1.5 py-1 hover:bg-violet-100 flex items-center gap-0.5">
            Open in FUB <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>
    </div>
  )
}

function CountChip({ label, n, cls }: { label: string; n: number; cls: string }) {
  return (
    <span className={`px-2 py-1 rounded-full border font-medium ${cls}`}>
      {label}: <span className="font-bold">{n}</span>
    </span>
  )
}

function Section({ title, subtitle, items, empty, renderActions }: {
  title: string; subtitle: string; items: QueueItem[]; empty: string
  renderActions: (i: QueueItem) => React.ReactNode
}) {
  return (
    <section>
      <div className="flex items-baseline gap-2 mb-2">
        <h2 className="text-sm font-bold text-slate-800">{title}</h2>
        <span className="text-xs text-slate-400">{subtitle}</span>
        <span className="text-xs font-semibold text-slate-500 ml-auto">{items.length}</span>
      </div>
      {items.length === 0
        ? <p className="text-xs text-slate-400 border border-dashed border-slate-200 rounded-lg px-3 py-2.5">{empty}</p>
        : <div className="space-y-1.5">{items.map(i => <Row key={i.key} item={i} actions={renderActions(i)} />)}</div>}
    </section>
  )
}

const BUCKET_LABELS: { key: keyof StaleBuckets; label: string }[] = [
  { key: 'b7_30', label: '7–30 days idle' },
  { key: 'b31_90', label: '31–90 days idle' },
  { key: 'b90', label: '90+ days idle' },
]
const BUCKET_PREVIEW = 12

function BucketSection({ title, subtitle, buckets, renderActions }: {
  title: string; subtitle: string; buckets: StaleBuckets
  renderActions: (i: QueueItem) => React.ReactNode
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const total = buckets.b7_30.length + buckets.b31_90.length + buckets.b90.length
  return (
    <section>
      <div className="flex items-baseline gap-2 mb-2">
        <h2 className="text-sm font-bold text-slate-800">{title}</h2>
        <span className="text-xs text-slate-400">{subtitle}</span>
        <span className="text-xs font-semibold text-slate-500 ml-auto">{total}</span>
      </div>
      {total === 0 && <p className="text-xs text-slate-400 border border-dashed border-slate-200 rounded-lg px-3 py-2.5">Nothing here — the book is being worked.</p>}
      <div className="space-y-3">
        {BUCKET_LABELS.map(({ key, label }) => {
          const items = buckets[key]
          if (items.length === 0) return null
          const isOpen = !!expanded[key]
          const shown = isOpen ? items : items.slice(0, BUCKET_PREVIEW)
          return (
            <div key={key}>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">{label} · {items.length}</p>
              <div className="space-y-1.5">{shown.map(i => <Row key={i.key} item={i} actions={renderActions(i)} />)}</div>
              {items.length > BUCKET_PREVIEW && (
                <button onClick={() => setExpanded(e => ({ ...e, [key]: !isOpen }))}
                  className="text-xs text-blue-700 hover:underline mt-1">
                  {isOpen ? 'Show fewer' : `Show all ${items.length}`}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function Row({ item, actions }: { item: QueueItem; actions: React.ReactNode }) {
  const ghlUrl = item.system === 'ghl'
    ? ghlContactUrl({ ghl_contact_id: item.ghlContactId, ghl_location_id: item.ghlLocationId })
    : null
  return (
    <div className={`flex items-center gap-2 bg-white border rounded-lg px-3 py-2 ${item.overdue ? 'border-red-200 bg-red-50/40' : 'border-slate-200'}`}>
      <span className={`shrink-0 text-[9px] font-bold rounded px-1 py-0.5 border ${item.system === 'ghl'
        ? 'text-blue-700 bg-blue-50 border-blue-200' : 'text-violet-700 bg-violet-50 border-violet-200'}`}>
        {item.system === 'ghl' ? 'GHL' : 'FUB'}
      </span>
      {item.system === 'ghl' && item.dealId ? (
        <Link href={`/deals/${item.dealId}`} className="font-semibold text-sm text-slate-900 hover:text-blue-700 truncate">
          {item.name}
        </Link>
      ) : (
        <a href={fubUrl(item.fubId!)} target="_blank" rel="noopener noreferrer"
          className="font-semibold text-sm text-slate-900 hover:text-violet-700 truncate flex items-center gap-1">
          {item.name} <ExternalLink className="w-3 h-3 text-slate-300" />
        </a>
      )}
      <span className="shrink-0 text-[10px] text-slate-500 bg-slate-100 rounded px-1.5 py-0.5">{item.stage}</span>
      <span className={`text-xs truncate ${item.overdue ? 'text-red-700 font-medium' : 'text-slate-500'}`}>{item.reason}</span>
      {item.lastMessage && (
        <span className="text-xs text-slate-400 italic truncate hidden md:inline">“{item.lastMessage.slice(0, 60)}”</span>
      )}
      {ghlUrl && (
        <a href={ghlUrl} target="_blank" rel="noopener noreferrer"
          className="shrink-0 text-[9px] font-bold text-blue-700 hover:text-blue-900 px-1 py-0.5 rounded bg-blue-100 border border-blue-200">
          GHL
        </a>
      )}
      <div className="ml-auto flex items-center gap-2">
        {actions}
      </div>
    </div>
  )
}
