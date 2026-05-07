import type { Metadata } from 'next'
import './globals.css'
import AppShell from '@/components/AppShell'

export const metadata: Metadata = {
  title: 'Lumin Lending — Deals',
  description: 'Mortgage pipeline management for Lumin Lending',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full flex overflow-hidden bg-slate-100">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  )
}
