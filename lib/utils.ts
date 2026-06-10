import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// 15-minute time options for easy dropdown pickers (value "HH:MM", label "9:00 AM").
export const TIME_OPTIONS: { value: string; label: string }[] = (() => {
  const out: { value: string; label: string }[] = []
  for (let h = 8; h <= 18; h++) {
    for (const m of [0, 15, 30, 45]) {
      const value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
      const hour12 = h % 12 === 0 ? 12 : h % 12
      const ampm = h < 12 ? 'AM' : 'PM'
      const label = `${hour12}:${String(m).padStart(2, '0')} ${ampm}`
      out.push({ value, label })
    }
  }
  return out
})()

export function formatCurrency(value: number | null | undefined): string {
  if (value == null) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value)
}

export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—'
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function formatPercent(value: number | null | undefined): string {
  if (value == null) return '—'
  return `${value}%`
}

/**
 * Title-case a person's name — capitalizes the first letter of every word
 * (and after hyphens, apostrophes, periods). Lowercases everything else first
 * so ALL-CAPS strings get normalized too.
 *
 *   "cathy ruiz"     → "Cathy Ruiz"
 *   "MARY THORNDAL"  → "Mary Thorndal"
 *   "john o'brien"   → "John O'Brien"
 *   "jean-marc"      → "Jean-Marc"
 *
 * Caveat: "mcdonald" → "Mcdonald" (doesn't know about Mac/Mc patterns).
 * Acceptable tradeoff for the typical case.
 */
export function titleCase(s: string | null | undefined): string | null {
  if (!s) return null
  const trimmed = String(s).trim()
  if (!trimmed) return null
  return trimmed
    .toLowerCase()
    .replace(/(^|[\s\-'.,])([a-z])/g, (_m, sep, c) => sep + c.toUpperCase())
}

// ── DND / Do-Not-Contact (GHL compliance) ───────────────────────────────────
// GHL stores a master `dnd` boolean (blocks everything) plus per-channel
// `dnd_settings` like { SMS: { status: 'active' }, Email: { status: 'inactive' } }
// where status 'active' means the Do-Not-Contact block is ON for that channel.
type DndCarrier = { dnd?: boolean | null; dnd_settings?: Record<string, unknown> | null }
export type DndChannel = 'SMS' | 'Email' | 'Call' | 'WhatsApp' | 'GMB' | 'FB'

/** True if the given channel is blocked (opted out / Do Not Contact) for this deal. */
export function isChannelBlocked(deal: DndCarrier | null | undefined, channel: DndChannel): boolean {
  if (!deal) return false
  if (deal.dnd === true) return true   // master DND blocks every channel
  const s = deal.dnd_settings as Record<string, { status?: string }> | null | undefined
  const cs = s?.[channel]
  return !!cs && String(cs.status).toLowerCase() === 'active'
}

/** Compact summary for a badge. Returns null when nothing is blocked. */
export function dndSummary(deal: DndCarrier | null | undefined): { all: boolean; channels: string[] } | null {
  if (!deal) return null
  if (deal.dnd === true) return { all: true, channels: [] }
  const s = deal.dnd_settings as Record<string, { status?: string }> | null | undefined
  if (!s) return null
  const channels = Object.entries(s)
    .filter(([, v]) => String(v?.status).toLowerCase() === 'active')
    .map(([k]) => k)
  return channels.length ? { all: false, channels } : null
}

/** Human label for a DND badge, e.g. "Do Not Contact" or "DND: SMS, Email". */
export function dndLabel(deal: DndCarrier | null | undefined): string | null {
  const s = dndSummary(deal)
  if (!s) return null
  return s.all ? 'Do Not Contact' : `DND: ${s.channels.join(', ')}`
}
