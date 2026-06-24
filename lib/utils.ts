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
  // Date-only strings ("YYYY-MM-DD") must be parsed as LOCAL time. `new Date("2026-06-16")`
  // parses as UTC midnight, which renders as the *previous day* in negative-offset zones
  // (e.g. Pacific). Build a local Date from the parts; fall through to normal parsing for
  // full timestamps (which are real instants and already correct).
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim())
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(dateStr)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', {
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

// ── Lead source ──────────────────────────────────────────────────────────────
/** A lead source worth displaying, or null. Filters empties, the "Unknown" bucket,
 *  and "Arive" — Arive is the LOS, never a real lead source (see project rules). */
export function cleanSource(s: string | null | undefined): string | null {
  const t = (s ?? '').trim()
  if (!t) return null
  const l = t.toLowerCase()
  if (l === 'unknown' || l === 'arive') return null
  return t
}
