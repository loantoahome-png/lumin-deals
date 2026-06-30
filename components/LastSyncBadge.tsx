'use client'

import { useEffect, useState } from 'react'
import { Activity } from 'lucide-react'

/**
 * Tiny chip that shows when the GHL sync cron last ran, color-coded by age:
 *   green   — under 16 min ago (synced within the current ~15-min cron cycle)
 *   amber   — 16–35 min        (a cycle looks missed — running late)
 *   red     — over 35 min       (2+ cycles missed — cron likely stalled)
 *
 * Reads from the `sync_state` table the cron writes to on each successful run.
 *
 * Polling is matched to the cron cadence to avoid burning Vercel CPU:
 *   • Server fetch every 15 min, paused while the tab is hidden, with an instant
 *     catch-up fetch when the tab regains focus.
 *   • The "X min ago" label re-renders every 60s client-side only (no network),
 *     so it stays smooth and still trips to red on a stall without polling.
 */
export default function LastSyncBadge() {
  const [lastSync, setLastSync] = useState<Date | null>(null)
  const [loaded, setLoaded]     = useState(false)
  const [, forceTick]           = useState(0)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const res = await fetch('/api/sync-status', { cache: 'no-store' })
        const data: { last_synced_at?: string | null } = await res.json()
        if (cancelled) return
        setLastSync(data.last_synced_at ? new Date(data.last_synced_at) : null)
        setLoaded(true)
      } catch {
        if (!cancelled) setLoaded(true)
      }
    }

    // Server fetch — matched to the ~15-min cron cadence, and only while the tab
    // is visible. A backgrounded or forgotten tab stops hitting the server
    // entirely (this is what was quietly burning Vercel CPU on nights/weekends).
    let fetchTimer: ReturnType<typeof setInterval> | null = null
    function startFetching() {
      if (fetchTimer) return
      load()                                       // immediate catch-up
      fetchTimer = setInterval(load, 15 * 60_000)  // every 15 min
    }
    function stopFetching() {
      if (fetchTimer) { clearInterval(fetchTimer); fetchTimer = null }
    }
    function onVisibility() {
      if (document.visibilityState === 'visible') startFetching()
      else stopFetching()
    }

    // Re-render the "X min ago" label every 60s from the timestamp already in
    // memory — purely client-side, no server hit. Keeps the age + stall color
    // current even between the 15-min fetches.
    const recount = setInterval(() => forceTick(t => t + 1), 60_000)

    if (document.visibilityState === 'visible') startFetching()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      stopFetching()
      clearInterval(recount)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  // Don't show anything until the first fetch completes — prevents a flash of "—"
  if (!loaded) return null
  if (!lastSync) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] rounded border bg-slate-700/40 text-slate-400 border-slate-600" title="No sync state yet — run a manual Sync GHL once to seed it">
        <Activity className="w-3 h-3" />
        <span className="font-medium">No syncs yet</span>
      </div>
    )
  }

  const min = Math.floor((Date.now() - lastSync.getTime()) / 60_000)
  // Color by recency, tuned to the ~15-min cron cadence
  const color =
    min < 16 ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' :
    min < 35 ? 'bg-amber-500/15  text-amber-300  border-amber-500/30'    :
               'bg-red-500/15    text-red-300    border-red-500/30'

  let label: string
  if (min === 0)      label = 'Synced just now'
  else if (min === 1) label = 'Synced 1 min ago'
  else if (min < 60)  label = `Synced ${min} min ago`
  else {
    const hr = Math.floor(min / 60)
    const rem = min % 60
    label = rem === 0 ? `Synced ${hr}h ago` : `Synced ${hr}h ${rem}m ago`
  }

  return (
    <div
      className={`flex items-center gap-1.5 px-2 py-1 text-[10px] rounded border ${color}`}
      title={`Last GHL sync: ${lastSync.toLocaleString()}`}
    >
      <Activity className="w-3 h-3" />
      <span className="font-medium">{label}</span>
    </div>
  )
}
