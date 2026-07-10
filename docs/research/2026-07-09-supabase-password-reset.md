# Research — Supabase password reset with @supabase/ssr (Next.js App Router)

**Date fetched:** 2026-07-09
**What:** How to build a working forgot-password / reset-password flow for lumin-deals.

## Sources

- https://supabase.com/docs/guides/auth/passwords — fetched 2026-07-09
- https://supabase.com/docs/guides/auth/sessions/pkce-flow — fetched 2026-07-09
- `node_modules/@supabase/auth-js/dist/module/lib/types.d.ts` — installed SDK types (authoritative)
- Installed versions: `@supabase/ssr@0.10.3`, `@supabase/supabase-js@2.105.3`, `next@16.2.4`

## Key findings

### 1. `code` + `exchangeCodeForSession` is the WRONG path for this app

PKCE stores a **code verifier in browser local storage** when the flow is initiated.
Per the PKCE doc: *"the code exchange must be initiated on the same browser and device
where the flow was started."*

This breaks the exact case we hit: Efrain clicked **"Send password recovery" from the
Supabase dashboard**. That is server-initiated — no verifier was ever written to any
browser — so `exchangeCodeForSession` can never succeed for a dashboard-sent link.

### 2. `token_hash` + `verifyOtp` is the correct path — no verifier required

Installed SDK types confirm the shape:

```ts
export interface VerifyTokenHashParams {
    token_hash: string;
    type: EmailOtpType;
}
export type EmailOtpType = 'signup' | 'invite' | 'magiclink' | 'recovery' | 'email_change' | 'email' | (string & {});
```

No `email`, no verifier. Works cross-browser and for dashboard-sent links.
Called as `supabase.auth.verifyOtp({ token_hash, type })`; on success the server client
writes session cookies, and `updateUser({ password })` then works.

### 3. The email template must be changed

Default recovery template uses `{{ .ConfirmationURL }}`, which routes through Supabase's
`/auth/v1/verify` and hands back a `code`. To get a `token_hash` the template must be:

```
{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password
```

(Quoted from the passwords doc.) This is a **dashboard change**, not a code change.

### 4. Site URL is currently `http://localhost:3000`

That is why the recovery email 404s with ERR_CONNECTION_REFUSED. `{{ .SiteURL }}` in the
template above resolves from this setting, so it must be fixed regardless of flow choice.

## Gotchas

- **Cookie writing in a route handler:** must construct the `NextResponse.redirect(...)`
  first, then let `setAll` write onto it. The read-only pattern in
  `app/api/underwriting/route.ts` (`setAll: () => {}`) will silently drop the session.
- **Open redirect:** the `next` query param is attacker-controlled. Must validate it is a
  same-origin relative path (starts with `/`, not `//`).
- **Middleware:** `/auth/confirm`, `/reset-password`, `/forgot-password` must be added to
  `isPublic` or middleware bounces them to `/login` before the token is ever read.
- **`/reset-password` stays public on purpose.** `updateUser` requires a valid session, so
  an unauthenticated visitor can't change anything — they just see "link expired."

## Open questions

- Supabase min-password-length setting is unknown (default 6). Client enforces 10; the
  server remains the real authority.
