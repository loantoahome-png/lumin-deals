// Fixture check for lib/roles.ts — the access gate. Pure, no DB.
// Run: npx tsx scripts/roles-check.ts
//
// This file exists because the gate is the only thing standing between a
// processor login and the comp / lead-spend pages. Two properties matter more
// than the rest and are asserted first:
//
//   1. An account with NO role is an ADMIN. Efrain, Brianne, Moe and Matt all
//      have empty app_metadata — if that ever defaulted to 'processor' the whole
//      team would be locked out of their own dashboard.
//   2. The role is read from app_metadata ONLY. `supabase.auth.updateUser()`
//      writes user_metadata, so a restricted account must not be able to
//      promote itself by setting {role:'admin'} there.

import { roleFromUser, displayName, canAccess, canSeeNavItem, PROCESSOR_HOME } from '../lib/roles'

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++ } else { fail++; console.error(`✗ ${label}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`) }
}

const admin = { email: 'efrain@loantoahome.com', app_metadata: {}, user_metadata: {} }
const brianne = { email: 'brianne.han@luminlending.com', app_metadata: {}, user_metadata: {} }
const hanh = {
  email: 'hanh@luminlending.com',
  app_metadata: { role: 'processor', display_name: 'Hanh Nguyen' },
  user_metadata: {},
}

// ── 1. No role = admin (every existing login keeps working) ─────────────────
eq('empty app_metadata → admin', roleFromUser(admin), 'admin')
eq('brianne → admin', roleFromUser(brianne), 'admin')
eq('null user → admin', roleFromUser(null), 'admin')
eq('undefined user → admin', roleFromUser(undefined), 'admin')
eq('missing app_metadata → admin', roleFromUser({ email: 'x@y.com' }), 'admin')
eq('unknown role string → admin', roleFromUser({ app_metadata: { role: 'wizard' } }), 'admin')

// ── 2. Privilege escalation via user_metadata is impossible ─────────────────
// The attack: a processor opens the console and calls
//   supabase.auth.updateUser({ data: { role: 'admin' } })
// which lands in user_metadata. The gate must ignore it entirely.
eq(
  'user_metadata.role=admin does NOT promote a processor',
  roleFromUser({ ...hanh, user_metadata: { role: 'admin' } }),
  'processor',
)
eq(
  'user_metadata.role alone does not grant admin… (already admin by default)',
  roleFromUser({ email: 'x@y.com', user_metadata: { role: 'admin' } }),
  'admin',
)
// The inverse also holds: app_metadata is the only thing that can restrict.
eq('app_metadata wins over user_metadata', roleFromUser({ app_metadata: { role: 'processor' }, user_metadata: { role: 'admin' } }), 'processor')

// ── 3. Recognized roles ────────────────────────────────────────────────────
eq('hanh → processor', roleFromUser(hanh), 'processor')

// ── 4. Display name ────────────────────────────────────────────────────────
eq('display_name wins', displayName(hanh), 'Hanh Nguyen')
eq('falls back to email local-part, titled', displayName(brianne), 'Brianne Han')
eq('dot/underscore/dash all split', displayName({ email: 'mary_jane-smith@x.com' }), 'Mary Jane Smith')
eq('no email → null', displayName({ app_metadata: {} }), null)
eq('blank display_name falls through to email', displayName({ email: 'moe@x.com', app_metadata: { display_name: '   ' } }), 'Moe')

// ── 5. Route access — admin reaches everything ─────────────────────────────
for (const p of ['/', '/lead-roi', '/funded', '/reports', '/import/arive', '/processing', '/deals', '/health']) {
  eq(`admin can reach ${p}`, canAccess('admin', p), true)
}

// ── 6. Route access — a processor is confined to her desk ──────────────────
eq('processor: /processing', canAccess('processor', '/processing'), true)
eq('processor: /tasks', canAccess('processor', '/tasks'), true)
eq('processor: a specific file', canAccess('processor', '/deals/abc-123'), true)
eq('processor: that file’s checklist', canAccess('processor', '/deals/abc-123/checklist'), true)

// The money pages — the reason this gate exists at all.
for (const p of ['/', '/lead-roi', '/lead-roi/report', '/funded', '/reports', '/reports/escrows',
                 '/report-import', '/import/arive', '/lead-cohorts', '/health', '/duplicates',
                 '/old-deals', '/pipeline', '/contacts', '/hot-leads', '/follow-up', '/radar']) {
  eq(`processor BLOCKED from ${p}`, canAccess('processor', p), false)
}

// ⚠️ The trailing-slash rule. `/deals` is the LO-filtered index of EVERY escrow
// on the board; `/deals/<id>` is one file she's working. The first must be
// blocked and the second allowed — a prefix of '/deals' without the slash would
// silently let the whole index through.
eq('processor BLOCKED from the /deals index', canAccess('processor', '/deals'), false)
eq('processor allowed a file under /deals/', canAccess('processor', '/deals/xyz'), true)
// Deal CREATION is denied even though it sits under the allowed /deals/ prefix —
// a file reaches her desk by assignment, never by her creating one.
eq('processor BLOCKED from /deals/new', canAccess('processor', '/deals/new'), false)
eq('admin still reaches /deals/new', canAccess('admin', '/deals/new'), true)
// …and the deny-list must not swallow a real deal whose id merely starts the
// same way. '/deals/newton-file-9' is a FILE, not the create page.
eq('deny-list does not over-match an id', canAccess('processor', '/deals/newton-file-9'), true)

// ── 7. Nav visibility mirrors access ───────────────────────────────────────
eq('nav: processor sees Processing', canSeeNavItem('processor', PROCESSOR_HOME), true)
eq('nav: processor sees Tasks', canSeeNavItem('processor', '/tasks'), true)
eq('nav: processor does NOT see Active Escrows', canSeeNavItem('processor', '/deals'), false)
eq('nav: processor does NOT see Lead ROI', canSeeNavItem('processor', '/lead-roi'), false)
eq('nav: processor does NOT see Dashboard', canSeeNavItem('processor', '/'), false)
eq('nav: admin sees Lead ROI', canSeeNavItem('admin', '/lead-roi'), true)

console.log(`\n${fail === 0 ? '✓' : '✗'} roles-check: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
