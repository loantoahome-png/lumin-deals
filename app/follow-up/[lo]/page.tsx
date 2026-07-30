'use client'

// Per-LO Follow-Up Cockpit — "who do I contact today, in what order, and why?"
// Spec: docs/specs/2026-07-30-follow-up-cockpit-spec.md
// Restructured 2026-07-30 (Efrain: "this page looks like a mess … I want there
// to be separate sections") into three panels, each with collapsible groups:
//
//   1. FollowUpBoss tasks  — Overdue / Due today / Next 7 days (+ Done, Open in FUB)
//   2. GHL leads in play   — Pitching + App Intake, split by last activity (≤7d / >7d)
//   3. Dashboard tasks     — this LO's own deal_tasks, mirroring /tasks
//   4. More follow-ups     — collapsed: replies, new leads, check-ins, the FUB book
//
// Write paths from this page (client-side, authenticated):
//   • GHL deals → deals.next_action_due / next_action (SNOOZE — the same field
//     the Hot Leads Check-ins tab reads, so a snooze here IS a check-in there).
//   • FUB people → fub_people cockpit-state columns (snooze + touched); the FUB
//     sync never writes these, so they survive every sweep.
//   • FUB tasks → POST /api/fub/tasks/complete (server holds the API keys).
//   • Dashboard tasks → deal_tasks.completed_at + the SAME notifyTask('completed')
//     email the /tasks page sends, so both surfaces behave identically.
// stage_events is server-only by design — no client inserts here.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { fetchAllDeals } from '@/lib/fetchAllDeals'
import { ghlContactUrl } from '@/lib/ghlLinks'
import { notifyTask } from '@/lib/notifyTask'
import { LO_COLORS } from '@/components/LoFilter'
import TriageDateModal from '@/components/TriageDateModal'
import type { DealTask } from '@/lib/types'
import {
  buildFollowUpQueue, buildTaskQueue, buildLeadSections, snoozeIso, SNOOZE_PRESETS,
  TASK_WINDOW_DAYS, ACTIVITY_SPLIT_DAYS,
  type FollowUpQueue, type TaskQueue, type LeadSections, type QueueDealLike,
  type QueueFubLike, type QueueTaskLike, type QueueItem, type StaleBuckets, type TaskItem,
} from '@/lib/followUpQueue'
import {
  Flame, RefreshCw, CheckCircle2, Circle, Clock, ChevronDown, ExternalLink,
  PhoneCall, ListTodo, Target, ClipboardList, AlertCircle,
} from 'lucide-react'

const LO_SLUGS: Record<string, string> = { moe: 'Moe Sefati', matt: 'Matt Park' }

const FU_DEAL_COLUMNS = [
  'id', 'name', 'status', 'ghl_status', 'pipeline_group', 'loan_officer',
  'created_at', 'date_added_ghl', 'next_action_due', 'next_action',
  'last_inbound_at', 'last_outbound_at', 'last_communication_at', 'last_contacted',
  'last_inbound_message', 'loan_amount',
  'ghl_contact_id', 'ghl_opportunity_id', 'ghl_location_id',
].join(',')

const FUB_COLUMNS = [
  'fub_id', 'name', 'stage', 'loan_officer', 'price', 'deal_price', 'source',
  'last_activity_at', 'fub_created_at', 'next_action_due', 'next_action',
  'last_touched_at', 'matched_deal_active', 'missing_since',
].join(',')

const FUB_TASK_COLUMNS = 'fub_task_id,person_id,loan_officer,name,type,due_date,due_date_time'

async function fetchFubTasks(lo: string): Promise<QueueTaskLike[]> {
  const { data, error } = await supabase
    .from('fub_tasks').select(FUB_TASK_COLUMNS).eq('loan_officer', lo)
    .order('due_date', { ascending: true }).limit(1000)
  if (error) { console.error('[follow-up] FUB task fetch failed:', error.message); return [] }
  return (data as unknown as QueueTaskLike[]) ?? []
}

/** This LO's own dashboard tasks (deal_tasks.assignee holds the full name). */
async function fetchDashboardTasks(lo: string): Promise<DealTask[]> {
  const { data, error } = await supabase
    .from('deal_tasks').select('*').eq('assignee', lo)
    .is('completed_at', null)
    .order('due_at', { ascending: true, nullsFirst: false })
  if (error) { console.error('[follow-up] dashboard task fetch failed:', error.message); return [] }
  return (data as DealTask[]) ?? []
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

// Dashboard tasks are grouped the way /tasks buckets them.
const MS_DAY = 86_400_000
function groupDashboardTasks(tasks: DealTask[], now: number) {
  const endToday = new Date(now); endToday.setHours(23, 59, 59, 999)
  const startToday = new Date(now); startToday.setHours(0, 0, 0, 0)
  const overdue: DealTask[] = [], today: DealTask[] = [], upcoming: DealTask[] = [], someday: DealTask[] = []
  for (const t of tasks) {
    if (!t.due_at) { someday.push(t); continue }
    const due = Date.parse(t.due_at)
    if (isNaN(due)) { someday.push(t); continue }
    if (due < startToday.getTime()) overdue.push(t)
    else if (due <= endToday.getTime()) today.push(t)
    else upcoming.push(t)
  }
  return { overdue, today, upcoming, someday }
}

export default function FollowUpCockpit() {
  const params = useParams<{ lo: string }>()
  const slug = (params.lo ?? '').toLowerCase()
  const lo = LO_SLUGS[slug]

  const [deals, setDeals] = useState<QueueDealLike[]>([])
  const [fub, setFub] = useState<QueueFubLike[]>([])
  const [fubTasks, setFubTasks] = useState<QueueTaskLike[]>([])
  const [dashTasks, setDashTasks] = useState<DealTask[]>([])
  const [dealNames, setDealNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [syncedAt, setSyncedAt] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [modalFor, setModalFor] = useState<QueueItem | null>(null)

  const load = useCallback(async () => {
    if (!lo) return
    setLoading(true)
    const [d, f, ft, dt, s] = await Promise.all([
      fetchAllDeals(q => q.eq('loan_officer', lo), FU_DEAL_COLUMNS),
      fetchFubRows(lo),
      fetchFubTasks(lo),
      fetchDashboardTasks(lo),
      // sync_state is server-only (no client RLS policies) — read via the API.
      fetch('/api/sync/fub').then(r => r.ok ? r.json() : null).catch(() => null),
    ])
    const dl = d as unknown as QueueDealLike[]
    setDeals(dl)
    setFub(f)
    setFubTasks(ft)
    setDashTasks(dt)
    setDealNames(Object.fromEntries(dl.map(x => [x.id, x.name ?? 'Deal'])))
    setSyncedAt((s as { last_at?: string } | null)?.last_at ?? null)
    setLoading(false)
  }, [lo])

  useEffect(() => { load() }, [load])

  const queue: FollowUpQueue = useMemo(() => buildFollowUpQueue({ deals, fub, lo: lo ?? '' }), [deals, fub, lo])
  const taskQueue: TaskQueue = useMemo(() => buildTaskQueue({ tasks: fubTasks, people: fub, lo: lo ?? '' }), [fubTasks, fub, lo])
  const leads: LeadSections = useMemo(() => buildLeadSections({ deals, lo: lo ?? '' }), [deals, lo])
  const dash = useMemo(() => groupDashboardTasks(dashTasks, Date.now()), [dashTasks])

  // ── Actions ────────────────────────────────────────────────────────────────

  const mark = (key: string, on: boolean) =>
    setBusy(prev => { const n = new Set(prev); on ? n.add(key) : n.delete(key); return n })

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

  /** FUB people only — log that the LO reached out today. */
  async function markTouched(item: QueueItem) {
    if (item.fubId == null) return
    const nowIso = new Date().toISOString()
    const { error } = await supabase.from('fub_people')
      .update({ last_touched_at: nowIso, next_action_due: null, updated_at: nowIso })
      .eq('fub_id', item.fubId)
    if (error) { console.error('[follow-up] touch failed:', error.message); return }
    setFub(prev => prev.map(f => f.fub_id === item.fubId ? { ...f, last_touched_at: nowIso, next_action_due: null } : f))
  }

  /** Complete a FUB task — the server picks the right API key and writes to FUB. */
  async function completeFubTask(task: TaskItem) {
    mark(task.key, true)
    try {
      const res = await fetch('/api/fub/tasks/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.taskId }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok || !body?.ok) {
        console.error('[follow-up] FUB complete failed:', body)
        alert(`Could not complete that task in FollowUpBoss: ${body?.error ?? res.status}`)
        return
      }
      setFubTasks(prev => prev.filter(t => t.fub_task_id !== task.taskId))
    } finally {
      mark(task.key, false)
    }
  }

  /** Complete a dashboard task — same write + notification as the /tasks page. */
  async function completeDashTask(task: DealTask) {
    const key = `dash:${task.id}`
    mark(key, true)
    try {
      const completedAt = new Date().toISOString()
      const { error } = await supabase.from('deal_tasks').update({ completed_at: completedAt }).eq('id', task.id)
      if (error) { console.error('[follow-up] task complete failed:', error.message); return }
      setDashTasks(prev => prev.filter(t => t.id !== task.id))
      notifyTask('completed', task)
    } finally {
      mark(key, false)
    }
  }

  async function syncNow() {
    setSyncing(true)
    try {
      const res = await fetch('/api/sync/fub?force=1', { method: 'POST' })
      if (!res.ok) console.error('[follow-up] sync failed:', await res.json().catch(() => null))
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
  const fubDue = taskQueue.counts.today + taskQueue.counts.next7
  const dashOpen = dashTasks.length
  const moreCount = c.replyWaiting + c.newLeads + c.dueToday + c.stale + c.pastClients

  return (
    <div className="flex flex-col h-full overflow-y-auto bg-slate-50">
      {/* Header */}
      <div className="px-6 py-4 bg-white border-b border-slate-200 shrink-0 sticky top-0 z-20">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
              <PhoneCall className="w-5 h-5" style={{ color }} />
              Follow-Up — {lo.split(' ')[0]}
              <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: color }} />
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">
              FollowUpBoss tasks, leads in play, and your dashboard tasks · FUB synced {fmtSynced(syncedAt)}
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
        {c.replyWaiting > 0 && (
          <div className="mt-3 flex items-center gap-2 text-xs bg-red-50 border border-red-200 text-red-800 rounded-lg px-3 py-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span className="font-semibold">{c.replyWaiting} lead{c.replyWaiting === 1 ? '' : 's'} replied and {c.replyWaiting === 1 ? 'is' : 'are'} waiting on you</span>
            <span className="text-red-600">— see “More follow-ups” below</span>
          </div>
        )}
      </div>

      {loading ? (
        <div className="p-10 text-slate-500 text-sm">Loading your queue…</div>
      ) : (
        <div className="p-6 space-y-5 max-w-5xl w-full">

          {/* ── 1. FollowUpBoss tasks ─────────────────────────────────────── */}
          <Panel icon={<ListTodo className="w-4 h-4" />} accent="#6366f1"
            title="FollowUpBoss tasks" subtitle="Your own FUB reminders"
            badge={`${fubDue} due within ${TASK_WINDOW_DAYS} days`}>
            <Drawer label="Overdue" count={taskQueue.counts.overdue} tone="danger">
              {taskQueue.overdue.map(t => (
                <FubTaskRow key={t.key} task={t} busy={busy.has(t.key)} onDone={() => completeFubTask(t)} />
              ))}
            </Drawer>
            <Drawer label="Due today" count={taskQueue.counts.today} tone="warn" defaultOpen>
              {taskQueue.today.map(t => (
                <FubTaskRow key={t.key} task={t} busy={busy.has(t.key)} onDone={() => completeFubTask(t)} />
              ))}
            </Drawer>
            <Drawer label={`Next ${TASK_WINDOW_DAYS} days`} count={taskQueue.counts.next7} defaultOpen>
              {taskQueue.next7.map(t => (
                <FubTaskRow key={t.key} task={t} busy={busy.has(t.key)} onDone={() => completeFubTask(t)} />
              ))}
            </Drawer>
          </Panel>

          {/* ── 2. GHL leads in play ──────────────────────────────────────── */}
          <Panel icon={<Target className="w-4 h-4" />} accent="#0ea5e9"
            title="GHL leads — Pitching & App Intake" subtitle="Deals in play, split by last activity"
            badge={`${leads.counts.pitching} pitching · ${leads.counts.appIntake} app intake`}>
            <Drawer label={`Activity in the last ${ACTIVITY_SPLIT_DAYS} days`} count={leads.counts.recent} tone="good" defaultOpen>
              {leads.recent.map(i => <Row key={i.key} item={i} showStage actions={rowActions(i)} />)}
            </Drawer>
            <Drawer label={`No activity in over ${ACTIVITY_SPLIT_DAYS} days`} count={leads.counts.older} tone="warn">
              {leads.older.map(i => <Row key={i.key} item={i} showStage actions={rowActions(i)} />)}
            </Drawer>
          </Panel>

          {/* ── 3. Dashboard tasks ────────────────────────────────────────── */}
          <Panel icon={<ClipboardList className="w-4 h-4" />} accent="#10b981"
            title="Dashboard tasks" subtitle={`Your task list from /tasks`}
            badge={`${dashOpen} open`}
            action={<Link href="/tasks" className="text-xs text-emerald-700 hover:underline">open /tasks →</Link>}>
            <Drawer label="Overdue" count={dash.overdue.length} tone="danger" defaultOpen>
              {dash.overdue.map(t => <DashTaskRow key={t.id} task={t} dealName={t.deal_id ? dealNames[t.deal_id] : null} busy={busy.has(`dash:${t.id}`)} onDone={() => completeDashTask(t)} />)}
            </Drawer>
            <Drawer label="Due today" count={dash.today.length} tone="warn" defaultOpen>
              {dash.today.map(t => <DashTaskRow key={t.id} task={t} dealName={t.deal_id ? dealNames[t.deal_id] : null} busy={busy.has(`dash:${t.id}`)} onDone={() => completeDashTask(t)} />)}
            </Drawer>
            <Drawer label="Upcoming" count={dash.upcoming.length}>
              {dash.upcoming.map(t => <DashTaskRow key={t.id} task={t} dealName={t.deal_id ? dealNames[t.deal_id] : null} busy={busy.has(`dash:${t.id}`)} onDone={() => completeDashTask(t)} />)}
            </Drawer>
            <Drawer label="No due date" count={dash.someday.length}>
              {dash.someday.map(t => <DashTaskRow key={t.id} task={t} dealName={t.deal_id ? dealNames[t.deal_id] : null} busy={busy.has(`dash:${t.id}`)} onDone={() => completeDashTask(t)} />)}
            </Drawer>
          </Panel>

          {/* ── 4. Everything else, one click away ────────────────────────── */}
          <Panel icon={<Clock className="w-4 h-4" />} accent="#a855f7"
            title="More follow-ups" subtitle="Replies, new leads, check-ins, and the FUB book"
            badge={`${moreCount}`} collapsible defaultCollapsed>
            <Drawer label="Replied — waiting on you" count={c.replyWaiting} tone="danger" defaultOpen>
              {queue.replyWaiting.map(i => <Row key={i.key} item={i} showStage actions={rowActions(i)} />)}
            </Drawer>
            <Drawer label="New leads" count={c.newLeads} tone="good">
              {queue.newLeads.map(i => <Row key={i.key} item={i} showStage actions={rowActions(i)} />)}
            </Drawer>
            <Drawer label="Check-ins due" count={c.dueToday} tone="warn">
              {queue.dueToday.map(i => <Row key={i.key} item={i} showStage actions={rowActions(i)} />)}
            </Drawer>
            <BucketDrawer label="FUB nurture going stale" buckets={queue.stale} total={c.stale} renderActions={rowActions} />
            <BucketDrawer label="Past clients & closed" buckets={queue.pastClients} total={c.pastClients} renderActions={rowActions} />
          </Panel>
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
            <div className="absolute right-0 top-7 z-30 bg-white border border-slate-200 rounded-lg shadow-lg py-1 w-28">
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

// ── Section chrome ───────────────────────────────────────────────────────────

function Panel({ icon, accent, title, subtitle, badge, action, children, collapsible, defaultCollapsed }: {
  icon: React.ReactNode; accent: string; title: string; subtitle: string; badge?: string
  action?: React.ReactNode; children: React.ReactNode; collapsible?: boolean; defaultCollapsed?: boolean
}) {
  const [open, setOpen] = useState(!defaultCollapsed)
  return (
    <section className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-100" style={{ borderLeft: `3px solid ${accent}` }}>
        <span style={{ color: accent }}>{icon}</span>
        <h2 className="text-sm font-bold text-slate-900">{title}</h2>
        <span className="text-xs text-slate-400 hidden sm:inline">{subtitle}</span>
        <div className="ml-auto flex items-center gap-3">
          {badge && <span className="text-xs font-semibold text-slate-600">{badge}</span>}
          {action}
          {collapsible && (
            <button onClick={() => setOpen(v => !v)} className="text-slate-400 hover:text-slate-700" aria-label={open ? 'Collapse' : 'Expand'}>
              <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
          )}
        </div>
      </div>
      {open && <div className="divide-y divide-slate-100">{children}</div>}
    </section>
  )
}

const TONES = {
  danger: 'text-red-700',
  warn: 'text-amber-700',
  good: 'text-emerald-700',
  plain: 'text-slate-600',
} as const

/** A collapsible group inside a panel. Renders nothing when empty. */
function Drawer({ label, count, tone = 'plain', defaultOpen, children }: {
  label: string; count: number; tone?: keyof typeof TONES; defaultOpen?: boolean; children: React.ReactNode
}) {
  const [open, setOpen] = useState(!!defaultOpen)
  if (count === 0) {
    return (
      <div className="px-4 py-2 flex items-center gap-2 text-xs text-slate-400">
        <span className="w-4" />
        {label} <span className="ml-auto">0</span>
      </div>
    )
  }
  return (
    <div>
      <button onClick={() => setOpen(v => !v)}
        className="w-full px-4 py-2.5 flex items-center gap-2 hover:bg-slate-50 text-left">
        <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${open ? 'rotate-180' : '-rotate-90'}`} />
        <span className={`text-xs font-semibold ${TONES[tone]}`}>{label}</span>
        <span className="ml-auto text-xs font-bold text-slate-700 bg-slate-100 rounded-full px-2 py-0.5">{count}</span>
      </button>
      {open && <div className="px-4 pb-3 space-y-1.5">{children}</div>}
    </div>
  )
}

/** Stale/past-client buckets as one drawer with labelled sub-lists. */
function BucketDrawer({ label, buckets, total, renderActions }: {
  label: string; buckets: StaleBuckets; total: number; renderActions: (i: QueueItem) => React.ReactNode
}) {
  const groups: { key: keyof StaleBuckets; label: string }[] = [
    { key: 'b7_30', label: '7–30 days idle' },
    { key: 'b31_90', label: '31–90 days idle' },
    { key: 'b90', label: '90+ days idle' },
  ]
  const PREVIEW = 10
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  return (
    <Drawer label={label} count={total}>
      {groups.map(({ key, label: gl }) => {
        const items = buckets[key]
        if (!items.length) return null
        const isOpen = !!expanded[key]
        const shown = isOpen ? items : items.slice(0, PREVIEW)
        return (
          <div key={key} className="pt-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">{gl} · {items.length}</p>
            <div className="space-y-1.5">{shown.map(i => <Row key={i.key} item={i} actions={renderActions(i)} />)}</div>
            {items.length > PREVIEW && (
              <button onClick={() => setExpanded(e => ({ ...e, [key]: !isOpen }))} className="text-xs text-blue-700 hover:underline mt-1">
                {isOpen ? 'Show fewer' : `Show all ${items.length}`}
              </button>
            )}
          </div>
        )
      })}
    </Drawer>
  )
}

// ── Rows ─────────────────────────────────────────────────────────────────────

function FubTaskRow({ task, busy, onDone }: { task: TaskItem; busy: boolean; onDone: () => void }) {
  const link = task.personId != null ? fubUrl(task.personId) : null
  return (
    <div className={`flex items-center gap-2 border rounded-lg px-3 py-2 ${task.overdueDays > 0 ? 'border-red-200 bg-red-50/40' : 'border-slate-200 bg-white'}`}>
      <button onClick={onDone} disabled={busy} title="Mark this task complete in FollowUpBoss"
        className="shrink-0 text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-1 hover:bg-emerald-100 disabled:opacity-40 flex items-center gap-0.5">
        <CheckCircle2 className="w-3 h-3" /> {busy ? '…' : 'Done'}
      </button>
      <span className="shrink-0 text-[10px] text-slate-400" title={task.type}>{TASK_TYPE_ICON[task.type] ?? '•'}</span>
      <span className="font-semibold text-sm text-slate-900 truncate shrink-0 max-w-[10rem]">{task.personName}</span>
      {task.personStage && <span className="shrink-0 text-[10px] text-slate-500 bg-slate-100 rounded px-1.5 py-0.5">{task.personStage}</span>}
      <span className="text-xs text-slate-600 truncate" title={task.title}>{task.title}</span>
      <div className="ml-auto flex items-center gap-2 shrink-0">
        <span className={`text-[11px] font-medium ${task.overdueDays > 0 ? 'text-red-700' : task.dueLabel === 'due today' ? 'text-amber-700' : 'text-slate-500'}`}>
          {task.dueLabel}
        </span>
        {link && (
          <a href={link} target="_blank" rel="noopener noreferrer" title="Open this lead in FollowUpBoss"
            className="text-[10px] font-semibold text-violet-700 bg-violet-50 border border-violet-200 rounded px-1.5 py-1 hover:bg-violet-100 flex items-center gap-0.5">
            Open in FUB <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>
    </div>
  )
}

const PRIORITY_PILL: Record<string, string> = {
  high: 'text-red-700 bg-red-50 border-red-200',
  low: 'text-slate-500 bg-slate-50 border-slate-200',
}

function DashTaskRow({ task, dealName, busy, onDone }: { task: DealTask; dealName: string | null; busy: boolean; onDone: () => void }) {
  const due = task.due_at ? new Date(task.due_at) : null
  const overdue = !!due && due.getTime() < Date.now()
  return (
    <div className={`flex items-center gap-2 border rounded-lg px-3 py-2 ${overdue ? 'border-red-200 bg-red-50/40' : 'border-slate-200 bg-white'}`}>
      <button onClick={onDone} disabled={busy} title="Mark complete"
        className="shrink-0 text-slate-300 hover:text-emerald-600 disabled:opacity-40">
        {busy ? <Circle className="w-4 h-4 animate-pulse" /> : <Circle className="w-4 h-4" />}
      </button>
      <span className="text-sm text-slate-900 truncate">{task.title}</span>
      {task.priority && PRIORITY_PILL[task.priority] && (
        <span className={`shrink-0 text-[9px] font-bold uppercase rounded px-1 py-0.5 border ${PRIORITY_PILL[task.priority]}`}>{task.priority}</span>
      )}
      {task.deal_id && (
        <Link href={`/deals/${task.deal_id}`} className="shrink-0 text-[10px] text-blue-700 hover:underline truncate max-w-[9rem]">
          {dealName ?? 'Deal'}
        </Link>
      )}
      <div className="ml-auto flex items-center gap-2 shrink-0">
        {task.assigned_by && <span className="text-[10px] text-slate-400 hidden md:inline">by {task.assigned_by}</span>}
        <span className={`text-[11px] font-medium ${overdue ? 'text-red-700' : 'text-slate-500'}`}>
          {due ? due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'no date'}
        </span>
      </div>
    </div>
  )
}

function Row({ item, actions, showStage }: { item: QueueItem; actions: React.ReactNode; showStage?: boolean }) {
  const ghlUrl = item.system === 'ghl'
    ? ghlContactUrl({ ghl_contact_id: item.ghlContactId, ghl_location_id: item.ghlLocationId })
    : null
  return (
    <div className={`flex items-center gap-2 border rounded-lg px-3 py-2 ${item.overdue ? 'border-red-200 bg-red-50/40' : 'border-slate-200 bg-white'}`}>
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
      {showStage && <span className="shrink-0 text-[10px] text-slate-500 bg-slate-100 rounded px-1.5 py-0.5">{item.stage}</span>}
      <span className={`text-xs truncate ${item.overdue ? 'text-red-700 font-medium' : 'text-slate-500'}`}>{item.reason}</span>
      {item.lastMessage && (
        <span className="text-xs text-slate-400 italic truncate hidden lg:inline">“{item.lastMessage.slice(0, 50)}”</span>
      )}
      {ghlUrl && (
        <a href={ghlUrl} target="_blank" rel="noopener noreferrer"
          className="shrink-0 text-[9px] font-bold text-blue-700 hover:text-blue-900 px-1 py-0.5 rounded bg-blue-100 border border-blue-200">
          GHL
        </a>
      )}
      <div className="ml-auto flex items-center gap-2">{actions}</div>
    </div>
  )
}
