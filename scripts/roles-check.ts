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

import {
  roleFromUser, displayName, canAccess, canSeeNavItem, PROCESSOR_HOME,
  REPORTING_HOME, homeFor, taskColumnsFor, canSeeTask, canSeeBulletin,
} from '../lib/roles'

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

const daniel = {
  email: 'daniel@example.com',
  app_metadata: { role: 'reporting', display_name: 'Daniel McGrail-Granger' },
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
eq('processor: /worklist', canAccess('processor', '/worklist'), true)
eq('processor: /tasks', canAccess('processor', '/tasks'), true)
eq('nav: processor sees Work List', canSeeNavItem('processor', '/worklist'), true)
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

// ── 8. The task board, per role ────────────────────────────────────────────
// Efrain 2026-08-10: "only show her tasks, and tasks for Brianne and I, do not
// show the bulletin."
// Mirrors BOARD_COLUMNS in app/tasks/page.tsx. Hanh is deliberately NOT on it —
// she comes back on a processor board from `myName`, never from this list.
const ADMIN_COLUMNS = ['Efrain Ramirez', 'Brianne Han', 'Moe Sefati', 'Matt Park'] as const

eq('admin board is unchanged', taskColumnsFor('admin', 'Efrain Ramirez', ADMIN_COLUMNS), [...ADMIN_COLUMNS])
eq('processor board: her first, then Efrain + Brianne',
  taskColumnsFor('processor', 'Hanh Nguyen', ADMIN_COLUMNS),
  ['Hanh Nguyen', 'Efrain Ramirez', 'Brianne Han'])
// No display_name → don't invent a column named after nobody.
eq('processor with no name gets peers only',
  taskColumnsFor('processor', null, ADMIN_COLUMNS),
  ['Efrain Ramirez', 'Brianne Han'])
// The admin list must not leak in through the third argument.
eq('processor board never includes Moe',
  taskColumnsFor('processor', 'Hanh Nguyen', ADMIN_COLUMNS).includes('Moe Sefati'), false)
eq('processor board never includes Matt',
  taskColumnsFor('processor', 'Hanh Nguyen', ADMIN_COLUMNS).includes('Matt Park'), false)

// canSeeTask scopes the WHOLE list — chip counts, search, and the Completed
// view, which renders full task titles. Column-level filtering alone would
// leave other people's text on her screen.
eq('processor sees her own task', canSeeTask('processor', 'Hanh Nguyen', 'Hanh Nguyen'), true)
eq('processor sees a task she gave Brianne', canSeeTask('processor', 'Hanh Nguyen', 'Brianne Han'), true)
eq('processor sees a task she gave Efrain', canSeeTask('processor', 'Hanh Nguyen', 'Efrain Ramirez'), true)
eq('processor does NOT see Moe’s task', canSeeTask('processor', 'Hanh Nguyen', 'Moe Sefati'), false)
eq('processor does NOT see Matt’s task', canSeeTask('processor', 'Hanh Nguyen', 'Matt Park'), false)
eq('processor does NOT see Randy’s task', canSeeTask('processor', 'Hanh Nguyen', 'Randy Mathis'), false)
// An unassigned task has no column on her board, so it must not be visible —
// otherwise it lands in a catch-all she isn't supposed to have.
eq('processor does NOT see an unassigned task', canSeeTask('processor', 'Hanh Nguyen', null), false)
eq('processor does NOT see a legacy/typo name', canSeeTask('processor', 'Hanh Nguyen', 'Hanh'), false)
eq('admin sees everything, incl. unassigned', canSeeTask('admin', 'Efrain Ramirez', null), true)
eq('admin sees Randy’s task', canSeeTask('admin', 'Efrain Ramirez', 'Randy Mathis'), true)

// ── 9. Bulletin ────────────────────────────────────────────────────────────
eq('admin sees the Bulletin', canSeeBulletin('admin'), true)
eq('processor does NOT see the Bulletin', canSeeBulletin('processor'), false)


// ── 10. The `reporting` role — Daniel McGrail-Granger, 2026-08-25 ──────────
// An LO who gets the numbers and nothing else. He sees the WHOLE team's figures
// on the four pages he can reach (Efrain's explicit decision) — what's asserted
// here is only WHICH pages, never whose data.

eq('reporting role resolves', roleFromUser(daniel), 'reporting')
eq('reporting cannot self-promote via user_metadata',
  roleFromUser({ ...daniel, user_metadata: { role: 'admin' } }), 'reporting')
eq('reporting display name', displayName(daniel), 'Daniel McGrail-Granger')
eq('reporting home', homeFor('reporting'), REPORTING_HOME)
eq('processor home is unchanged', homeFor('processor'), PROCESSOR_HOME)
eq('admin home is the dashboard', homeFor('admin'), '/')

// The four he CAN reach.
for (const path of ['/reports', '/monthly-reports', '/lead-roi']) {
  eq(`reporting reaches ${path}`, canAccess('reporting', path), true)
  eq(`reporting sees ${path} in nav`, canSeeNavItem('reporting', path), true)
}

// ⚠️ The one that would silently leak: /reports/escrows sits UNDER an allowed
// prefix. If the deny-list entry is ever removed this assertion is what catches
// it — the escrow report is operational, not analytical, and wasn't in scope.
eq('reporting BLOCKED from /reports/escrows', canAccess('reporting', '/reports/escrows'), false)
eq('/reports/escrows hidden from nav', canSeeNavItem('reporting', '/reports/escrows'), false)

// Everything else. /import/* and /report-import MUTATE data; /deals, /contacts,
// /pipeline are the book of business; / is the dashboard.
for (const path of [
  '/', '/deals', '/deals/abc', '/deals/new', '/contacts', '/contacts/abc',
  '/pipeline', '/funded', '/hot-leads', '/follow-up', '/radar', '/worklist',
  // Removed from the allow-list 2026-08-25 — without the stage-events backfill it
  // would show his response rates as a flat 0.0%, which is wrong, not empty.
  '/lead-cohorts',
  '/processing', '/tasks', '/notes', '/tools', '/lenders', '/compliance',
  '/calls', '/report-import', '/import/arive', '/import/calls', '/health',
  '/duplicates', '/old-deals', '/underwriting',
]) {
  eq(`reporting BLOCKED from ${path}`, canAccess('reporting', path), false)
}

// A path that merely starts with the same LETTERS is not a child path.
eq('reporting BLOCKED from /reports-secret', canAccess('reporting', '/reports-secret'), false)

// No task board, no bulletin — even if a task surface is ever embedded in a
// page he can reach, it must render empty rather than leak the team's work.
eq('reporting has no task columns', taskColumnsFor('reporting', 'Daniel McGrail-Granger', ADMIN_COLUMNS), [])
eq('reporting sees no task of his own', canSeeTask('reporting', 'Daniel McGrail-Granger', 'Daniel McGrail-Granger'), false)
eq('reporting sees no task of Moe\u2019s', canSeeTask('reporting', 'Daniel McGrail-Granger', 'Moe Sefati'), false)
eq('reporting does NOT see the Bulletin', canSeeBulletin('reporting'), false)

// The processor gate must be completely unaffected by the new role.
eq('processor still reaches her desk', canAccess('processor', '/processing'), true)
eq('processor still reaches a deal file', canAccess('processor', '/deals/abc'), true)
eq('processor still blocked from /deals', canAccess('processor', '/deals'), false)
eq('processor still blocked from /deals/new', canAccess('processor', '/deals/new'), false)
eq('processor still blocked from /reports', canAccess('processor', '/reports'), false)
eq('processor still blocked from /lead-roi', canAccess('processor', '/lead-roi'), false)
eq('admin reaches everything', canAccess('admin', '/report-import'), true)

console.log(`\n${fail === 0 ? '✓' : '✗'} roles-check: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
