'use client'

/**
 * In-app Notifications Center.
 *
 * Computes signals client-side from deals + deal_tasks — no new tables:
 *   • Lock expiring within 7 days (or expired)
 *   • Escrow deal past its stage SLA
 *   • Tasks overdue / due today
 *
 * "Seen" + "dismissed" state lives in localStorage (no auth identity to key
 * off server-side). Each notification has a stable id so dismiss/seen persist
 * across reloads; resolved conditions simply stop being generated.
 */

import { useEffect, useState, useCallback, useRef } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { Deal, STAGE_SLA_DAYS } from '@/lib/types'
import {
  Bell, Lock, Hourglass, CheckSquare, X, Clock,
} from 'lucide-react'

const MS_PER_DAY = 86_400_000
const DISMISSED_KEY = 'lumin_notifs_dismissed'
const SEEN_KEY = 'lumin_notifs_seen'

type NotifType = 'lock' | 'sla' | 'task'
type Notif = {
  id: string
  type: NotifType
  title: string
  detail: string
  href: string
  severity: 'red' | 'amber'
  // sortable urgency — lower = more urgent
  rank: number
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (isNaN(t)) return null
  return Math.floor((Date.now() - t) / MS_PER_DAY)
}
function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (isNaN(t)) return null
  return Math.floor((t - Date.now()) / MS_PER_DAY)
}

function loadSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key)
    if (raw) return new Set(JSON.parse(raw) as string[])
  } catch {}
  return new Set()
}
function saveSet(key: string, set: Set<string>) {
  try { localStorage.setItem(key, JSON.stringify(Array.from(set))) } catch {}
}

// ── Signal computation ──────────────────────────────────────────────────────
type TaskRow = {
  id: string; title: string; due_at: string | null; completed_at: string | null
  deal_id: string | null; assignee: string | null
}

function computeNotifs(deals: Deal[], tasks: TaskRow[]): Notif[] {
  const out: Notif[] = []

  // 1. Lock expiring — locked deals with ≤7 days left (or already expired)
  for (const d of deals) {
    if (d.locked !== 'Yes' || !d.lock_expiration) continue
    const left = daysUntil(d.lock_expiration)
    if (left === null || left > 7) continue
    out.push({
      id: `lock-${d.id}`,
      type: 'lock',
      title: left <= 0 ? `Lock EXPIRED — ${d.name}` : `Lock expires in ${left}d — ${d.name}`,
      detail: left <= 0
        ? `Rate lock expired ${Math.abs(left)}d ago. Needs extension or re-lock.`
        : `${d.status} · lock expires ${new Date(d.lock_expiration).toLocaleDateString()}`,
      href: `/deals/${d.id}`,
      severity: left <= 2 ? 'red' : 'amber',
      rank: left, // most-expired first
    })
  }

  // 2. SLA breach — escrow deals sitting in a stage longer than its SLA
  for (const d of deals) {
    if (d.pipeline_group !== 'Loans in Process') continue
    const sla = STAGE_SLA_DAYS[d.status]
    if (!sla) continue
    const inStage = daysSince(d.stage_changed_at) ?? daysSince(d.created_at)
    if (inStage === null || inStage <= sla) continue
    const over = inStage - sla
    out.push({
      id: `sla-${d.id}-${d.status}`,
      type: 'sla',
      title: `Past SLA — ${d.name}`,
      detail: `${d.status}: ${inStage}d in stage (SLA ${sla}d, +${over}d over)`,
      href: `/deals/${d.id}`,
      severity: over >= sla ? 'red' : 'amber', // double the SLA = red
      rank: 100 - over, // most-over first
    })
  }

  // 3. Tasks overdue / due today
  const now = Date.now()
  const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999)
  for (const t of tasks) {
    if (t.completed_at || !t.due_at) continue
    const due = new Date(t.due_at).getTime()
    if (isNaN(due)) continue
    const overdue = due < now
    const dueToday = !overdue && due <= endOfToday.getTime()
    if (!overdue && !dueToday) continue
    const assignee = t.assignee ? ` · ${t.assignee}` : ''
    out.push({
      id: `task-${t.id}`,
      type: 'task',
      title: overdue ? `Overdue task — ${t.title}` : `Task due today — ${t.title}`,
      detail: overdue
        ? `Was due ${new Date(t.due_at).toLocaleDateString()}${assignee}`
        : `Due ${new Date(t.due_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}${assignee}`,
      href: t.deal_id ? `/deals/${t.deal_id}` : '/tasks',
      severity: overdue ? 'red' : 'amber',
      rank: overdue ? -50 + (due - now) / MS_PER_DAY : 50,
    })
  }

  return out.sort((a, b) => a.rank - b.rank)
}

const TYPE_ICON: Record<NotifType, React.ReactNode> = {
  lock: <Lock className="w-4 h-4" />,
  sla:  <Hourglass className="w-4 h-4" />,
  task: <CheckSquare className="w-4 h-4" />,
}

export default function NotificationBell() {
  const [notifs, setNotifs] = useState<Notif[]>([])
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [seen, setSeen] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    const [{ data: deals }, { data: tasks }] = await Promise.all([
      supabase.from('deals').select('id, name, status, pipeline_group, locked, lock_expiration, stage_changed_at, created_at'),
      supabase.from('deal_tasks').select('id, title, due_at, completed_at, deal_id, assignee'),
    ])
    const computed = computeNotifs((deals as Deal[]) || [], (tasks as TaskRow[]) || [])
    setNotifs(computed)

    // Prune dismissed/seen sets so they don't grow unbounded — keep only ids
    // that still correspond to a live notification.
    const liveIds = new Set(computed.map(n => n.id))
    setDismissed(prev => {
      const next = new Set(Array.from(prev).filter(id => liveIds.has(id)))
      saveSet(DISMISSED_KEY, next)
      return next
    })
    setSeen(prev => {
      const next = new Set(Array.from(prev).filter(id => liveIds.has(id)))
      saveSet(SEEN_KEY, next)
      return next
    })
  }, [])

  // Hydrate from localStorage, then fetch
  useEffect(() => {
    setDismissed(loadSet(DISMISSED_KEY))
    setSeen(loadSet(SEEN_KEY))
    setHydrated(true)
    refresh()
    // Re-check every 5 minutes + whenever the tab regains focus
    const interval = setInterval(refresh, 5 * 60 * 1000)
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => { clearInterval(interval); window.removeEventListener('focus', onFocus) }
  }, [refresh])

  // Close panel on outside click / Escape
  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onClick); document.removeEventListener('keydown', onKey) }
  }, [open])

  const visible = notifs.filter(n => !dismissed.has(n.id))
  const unreadCount = visible.filter(n => !seen.has(n.id)).length

  function openPanel() {
    setOpen(true)
    // Mark everything currently visible as seen
    setSeen(prev => {
      const next = new Set(prev)
      visible.forEach(n => next.add(n.id))
      saveSet(SEEN_KEY, next)
      return next
    })
  }

  function dismiss(id: string) {
    setDismissed(prev => {
      const next = new Set(prev)
      next.add(id)
      saveSet(DISMISSED_KEY, next)
      return next
    })
  }
  function dismissAll() {
    setDismissed(prev => {
      const next = new Set(prev)
      visible.forEach(n => next.add(n.id))
      saveSet(DISMISSED_KEY, next)
      return next
    })
  }

  const redCount = visible.filter(n => n.severity === 'red').length

  return (
    <div className="px-3">
      {/* Trigger — styled like a nav item */}
      <button
        onClick={() => open ? setOpen(false) : openPanel()}
        className={`flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
          open ? 'bg-slate-800 text-white' : 'text-slate-400 hover:bg-slate-800 hover:text-white'
        }`}
      >
        <span className="relative shrink-0">
          <Bell className="w-4 h-4" />
          {hydrated && unreadCount > 0 && (
            <span className="absolute -top-1.5 -right-1.5 min-w-[15px] h-[15px] px-0.5 flex items-center justify-center text-[9px] font-bold text-white bg-red-500 rounded-full">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </span>
        Notifications
        {hydrated && visible.length > 0 && (
          <span className="ml-auto text-[10px] text-slate-500">{visible.length}</span>
        )}
      </button>

      {/* Slide-over panel — sits just right of the 15rem sidebar */}
      {open && (
        <>
          <div className="fixed inset-0 bg-black/20 z-40" />
          <div
            ref={panelRef}
            className="fixed top-0 left-60 h-full w-[380px] bg-white shadow-2xl border-r border-slate-200 z-50 flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 shrink-0">
              <div className="flex items-center gap-2">
                <Bell className="w-4 h-4 text-slate-500" />
                <span className="font-bold text-slate-900">Notifications</span>
                {visible.length > 0 && (
                  <span className="text-xs font-semibold text-white bg-slate-700 px-1.5 py-0.5 rounded-full">
                    {visible.length}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {visible.length > 0 && (
                  <button onClick={dismissAll} className="text-xs text-slate-400 hover:text-slate-700">
                    Clear all
                  </button>
                )}
                <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-700">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Summary strip */}
            {visible.length > 0 && (
              <div className="px-5 py-2.5 bg-slate-50 border-b border-slate-100 text-xs text-slate-500 shrink-0">
                {redCount > 0 && <span className="text-red-600 font-semibold">{redCount} urgent</span>}
                {redCount > 0 && visible.length - redCount > 0 && <span> · </span>}
                {visible.length - redCount > 0 && <span>{visible.length - redCount} need attention</span>}
              </div>
            )}

            {/* List */}
            <div className="flex-1 overflow-y-auto">
              {visible.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center px-8">
                  <div className="w-12 h-12 rounded-full bg-emerald-50 flex items-center justify-center mb-3">
                    <CheckSquare className="w-6 h-6 text-emerald-500" />
                  </div>
                  <p className="text-sm font-medium text-slate-700">All clear</p>
                  <p className="text-xs text-slate-400 mt-1">
                    No expiring locks, SLA breaches, or overdue tasks right now.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {visible.map(n => (
                    <div key={n.id} className="group flex items-start gap-3 px-4 py-3 hover:bg-slate-50 transition">
                      <span className={`shrink-0 mt-0.5 w-7 h-7 rounded-lg flex items-center justify-center ${
                        n.severity === 'red' ? 'bg-red-100 text-red-600' : 'bg-amber-100 text-amber-600'
                      }`}>
                        {TYPE_ICON[n.type]}
                      </span>
                      <Link
                        href={n.href}
                        onClick={() => setOpen(false)}
                        className="flex-1 min-w-0"
                      >
                        <p className="text-sm font-medium text-slate-800 leading-snug">{n.title}</p>
                        <p className="text-xs text-slate-500 mt-0.5 flex items-center gap-1">
                          <Clock className="w-3 h-3 shrink-0" /> {n.detail}
                        </p>
                      </Link>
                      <button
                        onClick={() => dismiss(n.id)}
                        className="shrink-0 p-1 text-slate-300 hover:text-slate-600 opacity-0 group-hover:opacity-100 transition"
                        title="Dismiss"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-5 py-3 border-t border-slate-200 shrink-0">
              <p className="text-[11px] text-slate-400">
                Auto-refreshes every 5 min. Dismissing hides a notification until the condition changes.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
