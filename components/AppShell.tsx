'use client'

import { usePathname } from 'next/navigation'
import Sidebar from './Sidebar'

// Pages reachable without a session render bare — no sidebar, no sync controls,
// no Sign Out. Must stay in step with the `isPublic` allowlist in middleware.ts.
const CHROMELESS_PATHS = new Set(['/login', '/forgot-password', '/reset-password'])

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  if (CHROMELESS_PATHS.has(pathname)) {
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
