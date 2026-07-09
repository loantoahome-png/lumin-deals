import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'

/**
 * Landing point for Supabase auth email links (password recovery, magic link, invite).
 *
 * The Supabase email template must point here with a token_hash:
 *   {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password
 *
 * token_hash (not `code`) is deliberate: the PKCE `code` flow needs a verifier stored in
 * the same browser that started the flow, so it can never work for a link sent from the
 * Supabase dashboard. verifyOtp({ token_hash, type }) needs no verifier.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const token_hash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null
  const next = searchParams.get('next')

  // `next` is attacker-controlled — only allow same-origin relative paths.
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/reset-password'

  const failure = request.nextUrl.clone()
  failure.pathname = '/login'
  failure.search = ''
  failure.searchParams.set('error', 'link_invalid')

  if (!token_hash || !type) return NextResponse.redirect(failure)

  const success = request.nextUrl.clone()
  success.pathname = safeNext
  success.search = ''

  // The response must exist before verifyOtp runs, so setAll can write session
  // cookies onto it. A no-op setAll would verify the token and silently lose the session.
  const response = NextResponse.redirect(success)

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { error } = await supabase.auth.verifyOtp({ token_hash, type })
  if (error) return NextResponse.redirect(failure)

  return response
}
