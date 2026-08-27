// Set a user's password, or mint a password-recovery link, via the Supabase
// admin API (service-role key). Sibling of scripts/set-user-role.ts.
//
//   npx tsx scripts/set-user-password.ts <email>                 # read-only: show the account
//   npx tsx scripts/set-user-password.ts <email> --link          # mint a recovery link (PREFERRED)
//   npx tsx scripts/set-user-password.ts <email> '<password>'    # set it directly
//
// ⚠️ PREFER --link. It hands you a one-time URL you can pass to the person, who
//    then chooses their own password on /reset-password. Nobody types or
//    transmits a real password, and it does NOT depend on SMTP being configured
//    on the project — which the emailed "Forgot password" flow does.
//
// ⚠️ Direct-set caveat, stated because it is easy to assume otherwise:
//    changing the password does NOT revoke sessions the user already has.
//    supabase-js exposes `auth.admin.signOut(jwt)`, which needs THAT USER'S
//    access token — something a service-role script does not have. So a person
//    who is already signed in stays signed in on that device until their session
//    expires. If you are changing a password because it leaked, the account must
//    be handled in the Supabase dashboard, not here.
//
// Not named *-check.ts — the fixture runner globs that and every check must run
// offline; this one needs .env.local and hits the network.

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''

const SUPABASE_URL = get('NEXT_PUBLIC_SUPABASE_URL')
const sb = createClient(SUPABASE_URL, get('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
})

// Where a recovery link should land. Mirrors app/forgot-password/page.tsx so the
// minted link goes through the same /auth/confirm → /reset-password path the
// emailed flow uses. Override with SITE_URL for a preview deployment.
const SITE = get('SITE_URL') || 'https://lumin-deals.vercel.app'
const REDIRECT = `${SITE}/auth/confirm?next=/reset-password`

// Supabase's own default floor is 6. We ask for more because these accounts
// reach comp and lead-spend data.
const MIN_LEN = 12

const [email, arg] = process.argv.slice(2)

if (!email) {
  console.error(`usage:
  npx tsx scripts/set-user-password.ts <email>              # show account, change nothing
  npx tsx scripts/set-user-password.ts <email> --link       # mint a recovery link (preferred)
  npx tsx scripts/set-user-password.ts <email> '<password>' # set directly`)
  process.exit(1)
}

async function findUser(target: string) {
  // listUsers is paginated. Same approach as set-user-role.ts — page rather than
  // assume the whole team fits on page 1.
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw error
    const hit = data.users.find(u => u.email?.toLowerCase() === target.toLowerCase())
    if (hit) return hit
    if (data.users.length < 200) return null
  }
  return null
}

async function main() {
  const user = await findUser(email)
  if (!user) {
    console.error(`\nNo auth user with email ${email}.`)
    console.error('Create it in Supabase → Authentication → Users first (see docs/runbooks/add-a-user.md).')
    process.exit(1)
  }

  const meta = (user.app_metadata ?? {}) as Record<string, unknown>
  const role = meta.role === 'processor' ? 'processor (restricted — Processing Desk only)'
    : meta.role === 'reporting' ? 'reporting (restricted — report pages only)'
    : 'admin (full access)'

  console.log(`\nUser ${user.email}`)
  console.log(`  uid          ${user.id}`)
  console.log(`  confirmed    ${user.email_confirmed_at ? 'yes' : 'NO — they cannot sign in until confirmed'}`)
  console.log(`  role         ${role}`)
  console.log(`  last sign-in ${user.last_sign_in_at ?? 'never'}`)

  if (!arg) {
    console.log('\n(read-only — pass --link or a password to change it)\n')
    return
  }

  // ── Recovery link ─────────────────────────────────────────────────────────
  if (arg === '--link') {
    const { data, error } = await sb.auth.admin.generateLink({
      type: 'recovery',
      email: user.email!,
      options: { redirectTo: REDIRECT },
    })
    if (error) { console.error('\ngenerateLink failed:', error.message); process.exit(1) }
    const link = (data?.properties as { action_link?: string } | undefined)?.action_link
    if (!link) { console.error('\nNo action_link came back — nothing to hand over.'); process.exit(1) }
    console.log('\n✓ one-time recovery link (send this to them):\n')
    console.log(link)
    console.log('\n  → lands on /reset-password, where THEY choose the password.')
    console.log('  → single use, and it expires (Supabase default: 1 hour).')
    console.log('  → treat it like a password: anyone holding it can take the account.\n')
    return
  }

  // ── Direct set ────────────────────────────────────────────────────────────
  if (arg.length < MIN_LEN) {
    console.error(`\nRefusing: password is ${arg.length} chars, minimum ${MIN_LEN}.`)
    console.error('These accounts reach comp and lead-spend data. Use --link instead.')
    process.exit(1)
  }

  const { error } = await sb.auth.admin.updateUserById(user.id, { password: arg })
  if (error) { console.error('\nupdate failed:', error.message); process.exit(1) }

  // Never echo the value back, not even partially.
  console.log(`\n✓ password updated for ${user.email} (${arg.length} chars)`)
  console.log('\n⚠️  This does NOT sign out devices where they are already logged in —')
  console.log('    an existing session stays valid until it expires. If you are')
  console.log('    rotating a LEAKED password, handle the account in the Supabase')
  console.log('    dashboard instead; this script cannot revoke sessions.\n')
}

main()
