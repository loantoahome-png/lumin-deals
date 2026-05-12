'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  LayoutDashboard,
  Kanban,
  Table2,
  PlusCircle,
  Building2,
  Wrench,
  ClipboardList,
  Activity,
  GitMerge,
  LogOut,
} from 'lucide-react'
import GlobalSearch from './GlobalSearch'
import { supabase } from '@/lib/supabase'

const navItems = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/pipeline', label: 'Pipeline', icon: Kanban },
  { href: '/deals', label: 'Active Escrows', icon: Table2 },
  { href: '/deals/new', label: 'Add Deal', icon: PlusCircle },
  { href: '/tools', label: 'Tools', icon: Wrench },
  { href: '/tasks', label: 'Tasks', icon: ClipboardList },
  { href: '/health', label: 'Data Health', icon: Activity },
  { href: '/duplicates', label: 'Duplicates', icon: GitMerge },
]

export default function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()

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

      {/* Nav */}
      <nav className="flex-1 px-3 py-2 space-y-1">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = pathname === href
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
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
      </nav>

      {/* Footer */}
      <div className="px-3 py-3 border-t border-slate-700 space-y-1">
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
