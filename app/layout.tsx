import type { Metadata } from 'next'
import { Public_Sans, Geist_Mono } from 'next/font/google'
import './globals.css'
import AppShell from '@/components/AppShell'

// App-wide type: Public Sans for the UI, Geist Mono only for timestamps and
// metadata (`font-mono`). Self-hosted by next/font at build time; the CSS
// variables are wired into Tailwind's theme in globals.css.
const publicSans = Public_Sans({ subsets: ['latin'], variable: '--font-public-sans', display: 'swap' })
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono', display: 'swap' })

export const metadata: Metadata = {
  title: 'Lumin Lending — Deals',
  description: 'Mortgage pipeline management for Lumin Lending',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`h-full ${publicSans.variable} ${geistMono.variable}`}>
      <body className="h-full flex overflow-hidden bg-[#f4f6fb]">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  )
}
