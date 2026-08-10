import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { roleFromUser, canAccess, PROCESSOR_HOME } from '@/lib/roles'

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Local-only auth bypass, so nobody has to hand-edit (and then remember to
  // revert) the auth check below just to look at a page in a local browser.
  //
  // Double-gated, and NEITHER gate can be opened in production:
  //   - `next build` / `next start` / Vercel all set NODE_ENV=production, so the
  //     first condition is false on the deployed app no matter what env vars are
  //     configured in the Vercel dashboard.
  //   - the flag lives in `.env.local`, which `.gitignore`'s `.env*` keeps out of
  //     git entirely — it is never part of a deploy.
  // Set `LOCAL_AUTH_BYPASS=1` in `.env.local` to enable it under `next dev`.
  if (process.env.NODE_ENV === 'development' && process.env.LOCAL_AUTH_BYPASS === '1') {
    return NextResponse.next()
  }

  // Allow login page, static assets, and GHL webhook through without auth.
  // The reset paths must be public too: /auth/confirm is where the emailed token_hash
  // becomes a session (there isn't one yet), and /reset-password renders its own
  // "link expired" state instead of bouncing to /login. Reaching /reset-password
  // without a session can't change anything — updateUser requires one.
  const isPublic =
    pathname.startsWith('/login') ||
    pathname.startsWith('/forgot-password') ||
    pathname.startsWith('/reset-password') ||
    pathname.startsWith('/auth/confirm') ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api/webhooks') ||
    pathname.startsWith('/api/cron') ||
    pathname.startsWith('/api/log-error') ||
    pathname === '/favicon.ico'

  if (isPublic) return NextResponse.next()

  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    const loginUrl = request.nextUrl.clone()
    loginUrl.pathname = '/login'
    loginUrl.searchParams.set('next', pathname)
    return NextResponse.redirect(loginUrl)
  }

  // ── Role gate ──────────────────────────────────────────────────────────────
  // A `processor` account (Hanh) is confined to her desk, the files on it, and
  // the task board. Everything else — Lead ROI, Funded, Reports, Import, the
  // dashboard — redirects to /processing. An account with no `role` in
  // app_metadata is an admin, so every existing login is unaffected.
  //
  // This is a ROUTING gate, not row-level security: `deals` RLS is unchanged,
  // so a restricted account still holds an anon key that could query other rows
  // directly. That is the same trust boundary every other teammate operates
  // under. Real RLS per role is a separate piece of work.
  //
  // API routes are deliberately NOT gated here — /processing and the deal pages
  // need them, and the write paths they expose are the same ones the UI already
  // gives her. Gating them per-role would break her own page.
  const role = roleFromUser(user)
  if (role !== 'admin' && !pathname.startsWith('/api/') && !canAccess(role, pathname)) {
    const homeUrl = request.nextUrl.clone()
    homeUrl.pathname = PROCESSOR_HOME
    homeUrl.search = ''
    return NextResponse.redirect(homeUrl)
  }

  return response
}

// `/api/sync-status` is intentionally excluded from the matcher — it's polled by
// the LastSyncBadge and returns only a sync timestamp (no auth-gated data), so it
// skips middleware entirely to avoid paying the per-request auth (`getUser`) cost
// on a frequent poll. Edge/middleware is ~52% of this project's Fluid Active CPU.
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api/sync-status|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
