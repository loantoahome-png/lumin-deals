'use client'

import { usePathname } from 'next/navigation'
import Sidebar from './Sidebar'

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const isLoginPage = pathname === '/login'

  if (isLoginPage) {
    return <>{children}</>
  }

  return (
    <>
      <Sidebar />
      <main className="flex-1 overflow-auto h-full">
        {children}
      </main>
    </>
  )
}
