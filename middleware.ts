import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

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
