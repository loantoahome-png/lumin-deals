'use client'

import { useEffect, useState } from 'react'
import { Activity } from 'lucide-react'

/**
 * Tiny chip that shows when the GHL sync cron last ran, color-coded by age:
 *   green   — under 5 min ago (healthy)
 *   amber   — 5–30 min       (within normal window — could be off-hours)
 *   red     — over 30 min    (cron likely stalled)
 *
 * Reads from the `sync_state` table the cron writes to on each successful run.
 * Refreshes every 30 seconds.
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

    load()
    const refresh = setInterval(load, 30_000)         // re-fetch every 30s
    const recount = setInterval(() => forceTick(t => t + 1), 30_000) // re-render the "X min ago" label
    return () => { cancelled = true; clearInterval(refresh); clearInterval(recount) }
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
  // Color by recency
  const color =
    min < 5  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' :
    min < 30 ? 'bg-amber-500/15  text-amber-300  border-amber-500/30'    :
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
