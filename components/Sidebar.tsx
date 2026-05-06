'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard,
  Kanban,
  Table2,
  PlusCircle,
  Building2,
  Brain,
  ClipboardList,
} from 'lucide-react'
import GlobalSearch from './GlobalSearch'

const navItems = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/pipeline', label: 'Pipeline', icon: Kanban },
  { href: '/deals', label: 'Active Files', icon: Table2 },
  { href: '/deals/new', label: 'Add Deal', icon: PlusCircle },
  { href: '/underwriting', label: 'AI Underwriter', icon: Brain },
  { href: '/tasks', label: 'Tasks', icon: ClipboardList },
]

export default function Sidebar() {
  const pathname = usePathname()

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
      <div className="px-6 py-4 border-t border-slate-700">
        <p className="text-slate-500 text-xs">Lumin Lending © 2026</p>
      </div>
    </div>
  )
}
