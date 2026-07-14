'use client'

import { usePathname } from 'next/navigation'
import Sidebar from './Sidebar'

// Pages that render bare — no sidebar, no sync controls, no Sign Out. The auth
// pages must stay in step with the `isPublic` allowlist in middleware.ts; the
// report route is still session-gated, it's just chromeless for print/PDF.
const CHROMELESS_PATHS = new Set(['/login', '/forgot-password', '/reset-password', '/lead-roi/report'])

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
