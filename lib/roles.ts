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

export type Role = 'admin' | 'processor' | 'reporting'

/** Every non-admin role, i.e. every value that actually restricts something.
 *  `roleFromUser` only returns one of these when app_metadata says so. */
const RESTRICTED_ROLES = ['processor', 'reporting'] as const

/** Minimal shape of a Supabase auth user — avoids importing @supabase/supabase-js
 *  into middleware's module graph just for a type. */
type UserLike = {
  email?: string | null
  app_metadata?: Record<string, unknown> | null
  user_metadata?: Record<string, unknown> | null
} | null | undefined

/** The role for a signed-in user. Absent/unknown → 'admin' (see note above).
 *  An UNRECOGNISED role string also falls through to admin, deliberately: a typo
 *  in app_metadata must not silently lock someone out of a dashboard they own.
 *  Restriction is only ever granted by an exact, known role name. */
export function roleFromUser(user: UserLike): Role {
  const raw = user?.app_metadata?.['role']
  return (RESTRICTED_ROLES as readonly string[]).includes(raw as string) ? (raw as Role) : 'admin'
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
  '/worklist',
  '/deals/',
  '/tasks',
]

// ── What a reporting-only LO may reach ──────────────────────────────────────
// Daniel McGrail-Granger (2026-08-25): an LO who gets the numbers and nothing
// else. Efrain's decision was "the reporting sections, nothing else" — he sees
// the WHOLE team's figures on them, same as an admin does, so there is no per-LO
// data lock here.
//
// ⚠️ `/lead-cohorts` was in this list and was REMOVED 2026-08-25 (Efrain: "I
// dont need the lead cohort section for Dan"). Keep it out unless someone also
// runs the stage-events backfill for his GHL location: his sub-account is not on
// the real-time stage webhook, so that page would report his response rates as
// a flat 0.0%. That is WRONG data, not missing data — worse than no page. What's excluded is everything that
// isn't reporting: the pipeline, contacts, deals, tools, and every import.
//
// ⚠️ `/reports/escrows` is DENIED below and that is load-bearing. Matching is
//    prefix-based, so allowing `/reports` would otherwise hand him the escrow
//    report — which is operational, not analytical, and wasn't in scope.
const REPORTING_ALLOWED = [
  '/reports',
  '/monthly-reports',
  '/lead-roi',
]

const REPORTING_DENIED = [
  '/reports/escrows',
]

// Carve-outs that the prefixes above would otherwise let through. `/deals/new`
// matches `/deals/` but is deal CREATION — a file appears on a processor's desk
// because someone assigned it, never because she made one.
const PROCESSOR_DENIED = [
  '/deals/new',
]

/** Where a restricted user lands when they hit anything else, including `/`. */
export const PROCESSOR_HOME = '/processing'
export const REPORTING_HOME = '/reports'

/** The landing page for a role. Admins keep the real dashboard at `/`. */
export function homeFor(role: Role): string {
  return role === 'processor' ? PROCESSOR_HOME : role === 'reporting' ? REPORTING_HOME : '/'
}

const ACCESS: Record<Exclude<Role, 'admin'>, { allowed: string[]; denied: string[] }> = {
  processor: { allowed: PROCESSOR_ALLOWED, denied: PROCESSOR_DENIED },
  reporting: { allowed: REPORTING_ALLOWED, denied: REPORTING_DENIED },
}

/** Prefix match on a path SEGMENT boundary — `/reports` covers `/reports/foo`
 *  but never `/reports-secret`. The processor list's `/deals/` entry keeps its
 *  trailing slash and still works: `/deals/` + `/` never appears, and the
 *  startsWith arm below matches `/deals/<id>` directly. */
function matches(list: string[], pathname: string): boolean {
  return list.some(p =>
    p.endsWith('/')
      ? pathname.startsWith(p)
      : pathname === p || pathname.startsWith(p + '/'),
  )
}

export function canAccess(role: Role, pathname: string): boolean {
  if (role === 'admin') return true
  const { allowed, denied } = ACCESS[role]
  if (matches(denied, pathname)) return false
  return matches(allowed, pathname)
}

/**
 * Nav visibility, keyed by the sidebar's `href`. Kept separate from
 * `canAccess` because the sidebar links to `/deals` (the index, blocked) while
 * `/deals/<id>` (a file, allowed) is only ever reached from /processing.
 */
export function canSeeNavItem(role: Role, href: string): boolean {
  if (role === 'admin') return true
  if (role === 'reporting') return REPORTING_ALLOWED.includes(href)
  return href === PROCESSOR_HOME || href === '/worklist' || href === '/tasks'
}

// ── The task board, as a processor sees it ─────────────────────────────────
// Efrain 2026-08-10, after signing in as Hanh: "only show her tasks, and tasks
// for Brianne and I, do not show the bulletin."
//
// The people a processor hands work to. Moe, Matt, Randy and the
// "Unassigned & other" catch-all are all off her board — their tasks are not
// hers to see or work.
const PROCESSOR_TASK_PEERS = ['Efrain Ramirez', 'Brianne Han']

/**
 * Ordered board columns for a role. A processor gets herself first, then the
 * two people she hands off to. `myName` is the signed-in user's display_name;
 * if it's missing we fall back to peers only rather than inventing a column.
 */
export function taskColumnsFor(role: Role, myName: string | null, adminColumns: readonly string[]): string[] {
  if (role === 'admin') return [...adminColumns]
  // A reporting-only LO has no task board at all — /tasks isn't in his
  // allow-list. Returning [] rather than falling through to the processor's
  // columns means that even if a task surface is ever embedded in a page he CAN
  // reach, it renders empty instead of leaking the team's work items.
  if (role === 'reporting') return []
  return myName ? [myName, ...PROCESSOR_TASK_PEERS] : [...PROCESSOR_TASK_PEERS]
}

/**
 * Is this task visible to `role`? Used to scope the WHOLE list, not just the
 * columns — the filter-chip counts, the search, and especially the Completed
 * view all read from it, and Completed renders full task titles. Filtering only
 * at the column level would leave Moe's and Matt's task text on her screen.
 */
export function canSeeTask(role: Role, myName: string | null, assignee: string | null | undefined): boolean {
  if (role === 'admin') return true
  const visible = taskColumnsFor(role, myName, [])
  return !!assignee && visible.includes(assignee)
}

/** The Bulletin board is team-wide chatter — not part of a processor's desk, and
 *  not part of a reporting-only LO's world either. Admins only. */
export function canSeeBulletin(role: Role): boolean {
  return role === 'admin'
}
