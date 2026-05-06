import type { Metadata } from 'next'
import './globals.css'
import Sidebar from '@/components/Sidebar'

export const metadata: Metadata = {
  title: 'Lumin Lending — Deals',
  description: 'Mortgage pipeline management for Lumin Lending',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full flex overflow-hidden bg-slate-100">
        <Sidebar />
        <main className="flex-1 overflow-auto h-full">
          {children}
        </main>
      </body>
    </html>
  )
}
