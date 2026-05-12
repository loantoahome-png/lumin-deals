import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

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
