'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  LayoutDashboard,
  Kanban,
  Table2,
  Building2,
  Wrench,
  ClipboardList,
  Activity,
  GitMerge,
  DollarSign,
  BarChart3,
  Target,
  Users,
  Radar,
  FileUp,
  LogOut,
  RefreshCw,
  ChevronDown,
  ShieldCheck,
} from 'lucide-react'
import GlobalSearch from './GlobalSearch'
import NotificationBell from './NotificationBell'
import LastSyncBadge from './LastSyncBadge'
import { supabase } from '@/lib/supabase'

const navGroups = [
  {
    key: 'pipeline',
    label: 'Pipeline',
    noHeader: true,
    items: [
      { href: '/', label: 'Dashboard', icon: LayoutDashboard },
      { href: '/tasks', label: 'Bulletin/Tasks', icon: ClipboardList },
      { href: '/contacts', label: 'Contacts', icon: Users },
      { href: '/pipeline', label: 'Pipeline', icon: Kanban },
      { href: '/deals', label: 'Active Escrows', icon: Table2 },
      { href: '/hot-leads', label: 'Hot Leads', icon: Target },
      { href: '/funded', label: 'Funded', icon: DollarSign },
      { href: '/radar', label: 'Refi Radar', icon: Radar },
    ],
  },
  {
    key: 'insights',
    label: 'Insights',
    items: [
      { href: '/reports', label: 'Reports', icon: BarChart3 },
      { href: '/lead-performance', label: 'Lead Performance', icon: Target },
      { href: '/lead-spend', label: 'Lead Spend', icon: DollarSign },
    ],
  },
  {
    key: 'actions',
    label: 'Actions',
    items: [
      { href: '/tools', label: 'Tools', icon: Wrench },
      { href: '/compliance', label: 'Compliance', icon: ShieldCheck },
    ],
  },
  {
    key: 'data',
    label: 'Data',
    items: [
      { href: '/import/arive', label: 'Import Arive', icon: FileUp },
      { href: '/health', label: 'Data Health', icon: Activity },
      { href: '/duplicates', label: 'Duplicates', icon: GitMerge },
    ],
  },
]

// Groups collapsed by default (rarely used day-to-day).
const DEFAULT_COLLAPSED: Record<string, boolean> = { data: true }

export default function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const [syncing, setSyncing] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(DEFAULT_COLLAPSED)

  // Restore the user's collapse preferences across sessions.
  useEffect(() => {
    try {
      const raw = localStorage.getItem('sidebarCollapsed')
      if (raw) setCollapsed(JSON.parse(raw))
    } catch { /* ignore */ }
  }, [])

  function toggleGroup(key: string) {
    setCollapsed(prev => {
      const next = { ...prev, [key]: !prev[key] }
      try { localStorage.setItem('sidebarCollapsed', JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }

  async function handleSync() {
    if (syncing) return
    setSyncing(true)
    try {
      await fetch('/api/sync/ghl', { method: 'POST' })
      router.refresh()   // re-pull data + update the LastSyncBadge
    } catch (e) {
      console.error('Manual GHL sync failed:', e)
    } finally {
      setSyncing(false)
    }
  }

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <div className="w-60 bg-slate-900 flex flex-col shrink-0">
      {/* Logo */}
      <div className="px-6 py-5 border-b border-slate-700">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-blue-500 rounded-lg flex items-center justify-center">
            <Building2 className="w-5 h-5 text-white" />
          </div>
          <div>
            <p className="text-white font-bold text-sm leading-tight">Lumin Lending</p>
            <p className="text-slate-400 text-xs">Deal Pipeline</p>
          </div>
        </div>
      </div>

      {/* Global Search */}
      <div className="pt-4">
        <GlobalSearch />
      </div>

      {/* Notifications */}
      <div className="pt-2">
        <NotificationBell />
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-2 space-y-2 overflow-y-auto">
        {navGroups.map(group => {
          const noHeader = 'noHeader' in group && group.noHeader
          const hasActive = group.items.some(it => pathname === it.href)
          // Always show the group that contains the current page, even if collapsed.
          const open = noHeader || !collapsed[group.key] || hasActive
          return (
            <div key={group.key}>
              {!noHeader && (
                <button
                  onClick={() => toggleGroup(group.key)}
                  className="flex items-center justify-between w-full px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-300 transition-colors"
                >
                  <span>{group.label}</span>
                  <ChevronDown className={`w-3 h-3 transition-transform ${open ? '' : '-rotate-90'}`} />
                </button>
              )}
              {open && (
                <div className="mt-0.5 space-y-0.5">
                  {group.items.map(({ href, label, icon: Icon }) => {
                    const active = pathname === href
                    return (
                      <Link
                        key={href}
                        href={href}
                        className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                          active
                            ? 'bg-blue-600 text-white'
                            : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                        }`}
                      >
                        <Icon className="w-4 h-4 shrink-0" />
                        {label}
                      </Link>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </nav>

      {/* Footer */}
      <div className="px-3 py-3 border-t border-slate-700 space-y-2">
        {/* GHL sync health indicator — color tells you if cron is firing */}
        <div className="px-1">
          <LastSyncBadge />
        </div>
        <button
          onClick={handleSync}
          disabled={syncing}
          className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          <RefreshCw className={`w-4 h-4 shrink-0 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Syncing…' : 'Sync GHL'}
        </button>
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
        >
          <LogOut className="w-4 h-4 shrink-0" />
          Sign Out
        </button>
        <p className="text-slate-600 text-xs px-3">Lumin Lending © 2026</p>
      </div>
    </div>
  )
}
