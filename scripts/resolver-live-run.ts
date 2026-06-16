import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { runIdentityResolutionPass } from '../lib/identityResolver'

// Live runner for the identity resolver. Usage:
//   node …/resolver-live-run.js dry     → report only, no writes (default)
//   node …/resolver-live-run.js apply   → write borrower_id changes (backup first)
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter(l => l.includes('='))
    .map(l => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]
    }),
)

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

;(async () => {
  const mode = process.argv[2] === 'apply' ? 'apply' : 'dry'
  const r = await runIdentityResolutionPass(sb, { apply: mode === 'apply' })
  console.log(`MODE: ${mode}`)
  console.log(
    JSON.stringify(
      {
        scanned: r.scanned,
        dryRun: r.dryRun,
        applied: r.applied,
        aborted: r.aborted ?? false,
        reason: r.reason,
        componentsChanged: r.componentsChanged,
        dealsRewritten: r.dealsRewritten,
        largestComponentSize: r.largestComponentSize,
        backupKey: r.backupKey,
        sampleTop5: r.sample.slice(0, 5),
      },
      null,
      2,
    ),
  )
})().catch(e => {
  console.error(e)
  process.exit(1)
})
