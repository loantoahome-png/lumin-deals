// ── Roles & route access ────────────────────────────────────────────────────
// The single source of truth for "who is signed in and what may they reach".
// Imported by middleware.ts (the enforcement point), the Sidebar (what renders)
// and /processing (whose desk you're looking at), so the three can never drift.
//
// ⚠️ Roles live in Supabase auth **app_metadata**, NOT user_metadata.
//    `supabase.auth.updateUser()` lets any signed-in client rewrite its own
//    user_metadata — reading the role from there would let a restricted account
//    promote itself to admin with one console call. app_metadata is writable
//    only by the service-role key / the Supabase dashboard.
//
//    Shape (set on the auth user — see docs/runbooks/add-a-user.md):
//      { "role": "processor", "display_name": "Hanh Nguyen" }
//
// A user with NO role key is an ADMIN. That is deliberate: Efrain, Brianne, Moe
// and Matt already have accounts with empty metadata, and this file must not
// change what they can reach. Restriction is opt-in, per account.

export type Role = 'admin' | 'processor'

/** Minimal shape of a Supabase auth user — avoids importing @supabase/supabase-js
 *  into middleware's module graph just for a type. */
type UserLike = {
  email?: string | null
  app_metadata?: Record<string, unknown> | null
  user_metadata?: Record<string, unknown> | null
} | null | undefined

/** The role for a signed-in user. Absent/unknown → 'admin' (see note above). */
export function roleFromUser(user: UserLike): Role {
  const raw = user?.app_metadata?.['role']
  return raw === 'processor' ? 'processor' : 'admin'
}

/**
 * The person's board name — what gets stamped into `deal_tasks.assigned_by` and
 * matched against `deals.processor_status`. Falls back to the email local-part
 * so an account without `display_name` still shows something human.
 */
export function displayName(user: UserLike): string | null {
  const raw = user?.app_metadata?.['display_name']
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  const email = user?.email
  if (!email) return null
  const local = email.split('@')[0]
  // "brianne.han" → "Brianne Han"
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || null
}

// ── What a processor may reach ──────────────────────────────────────────────
// Prefix match. Note `/deals/` carries a TRAILING SLASH on purpose: a processor
// works individual files (`/deals/<id>`, `/deals/<id>/checklist`) but must not
// get `/deals` itself — that's the LO-filtered index of every escrow on the
// board, which /processing deliberately replaces with her own.
const PROCESSOR_ALLOWED = [
  '/processing',
  '/deals/',
  '/tasks',
]

// Carve-outs that the prefixes above would otherwise let through. `/deals/new`
// matches `/deals/` but is deal CREATION — a file appears on a processor's desk
// because someone assigned it, never because she made one.
const PROCESSOR_DENIED = [
  '/deals/new',
]

/** Where a restricted user lands when they hit anything else, including `/`. */
export const PROCESSOR_HOME = '/processing'

export function canAccess(role: Role, pathname: string): boolean {
  if (role === 'admin') return true
  if (PROCESSOR_DENIED.some(p => pathname === p || pathname.startsWith(p + '/'))) return false
  return PROCESSOR_ALLOWED.some(p => pathname === p || pathname.startsWith(p))
}

/**
 * Nav visibility, keyed by the sidebar's `href`. Kept separate from
 * `canAccess` because the sidebar links to `/deals` (the index, blocked) while
 * `/deals/<id>` (a file, allowed) is only ever reached from /processing.
 */
export function canSeeNavItem(role: Role, href: string): boolean {
  if (role === 'admin') return true
  return href === PROCESSOR_HOME || href === '/tasks'
}
