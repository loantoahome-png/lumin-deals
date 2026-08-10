// Set (or clear) a user's role + display name in Supabase auth `app_metadata`.
//
//   npx tsx scripts/set-user-role.ts <email> processor "Hanh Nguyen"
//   npx tsx scripts/set-user-role.ts <email> admin              # clears the restriction
//   npx tsx scripts/set-user-role.ts <email>                    # read-only: show current
//
// ⚠️ Why this script exists instead of a dashboard step: newer Supabase dashboards
//    removed the editable "Raw App Meta Data" box. The Raw JSON tab displays
//    app_metadata but won't let you write it. `app_metadata` is writable only with
//    the service-role key — which is the whole point: it's the one metadata bucket
//    a signed-in browser can't touch, so it's the only safe place for a role.
//    (`user_metadata` IS browser-writable via supabase.auth.updateUser — putting a
//    role there would let a restricted account promote itself.)
//
// ⚠️ Roles do not take effect until the user's session refreshes. If they're
//    already signed in, they must sign out and back in.
//
// Not named *-check.ts — the fixture runner globs that and this needs .env.local.

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''

const sb = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
})

const [email, roleArg, displayArg] = process.argv.slice(2)

if (!email) {
  console.error('usage: npx tsx scripts/set-user-role.ts <email> [processor|admin] ["Display Name"]')
  process.exit(1)
}
if (roleArg && roleArg !== 'processor' && roleArg !== 'admin') {
  console.error(`unknown role "${roleArg}" — expected "processor" or "admin"`)
  process.exit(1)
}

async function findUser(target: string) {
  // listUsers is paginated; this project has a handful of users, but page anyway
  // rather than assume everyone fits on page 1.
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
    console.error(`No auth user with email ${email}. Create it in Supabase → Authentication → Users first.`)
    process.exit(1)
  }

  const before = (user.app_metadata ?? {}) as Record<string, unknown>
  console.log(`\nUser ${user.email}`)
  console.log(`  uid          ${user.id}`)
  console.log(`  confirmed    ${user.email_confirmed_at ? 'yes' : 'NO — they cannot sign in until confirmed'}`)
  console.log(`  app_metadata ${JSON.stringify(before)}`)
  console.log(`  → effective role: ${before.role === 'processor' ? 'processor (restricted)' : 'admin (full access)'}`)

  if (!roleArg) {
    console.log('\n(read-only — pass a role to change it)\n')
    return
  }

  // Merge, never replace: app_metadata also carries `provider`/`providers`,
  // which Supabase uses for sign-in. Clobbering those breaks the login.
  const next: Record<string, unknown> = { ...before }
  if (roleArg === 'admin') {
    delete next.role          // absence of the key IS admin — see lib/roles.ts
  } else {
    next.role = 'processor'
  }
  if (displayArg) next.display_name = displayArg

  const { data, error } = await sb.auth.admin.updateUserById(user.id, { app_metadata: next })
  if (error) { console.error('\nupdate failed:', error); process.exit(1) }

  const after = (data.user.app_metadata ?? {}) as Record<string, unknown>
  console.log(`\n✓ updated`)
  console.log(`  app_metadata ${JSON.stringify(after)}`)
  console.log(`  → effective role: ${after.role === 'processor' ? 'processor (restricted)' : 'admin (full access)'}`)
  if (after.display_name) console.log(`  → desk pinned to: ${after.display_name}`)
  console.log(`\n⚠️  If they're already signed in, they must sign out and back in — the`)
  console.log(`    old session still carries the previous role until it refreshes.\n`)
}

main()
