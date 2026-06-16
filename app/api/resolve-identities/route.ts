import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { runIdentityResolutionPass } from '@/lib/identityResolver'

// Recompute the canonical borrower_id per person across all deals (Contacts Phase 1).
// DRY RUN by default — it only writes when explicitly asked. Because an apply can
// rewrite borrower_id across the whole table, the endpoint requires the cron secret
// when one is configured (the maintenance cron calls the pass directly, not via HTTP).

export const maxDuration = 300

function truthy(v: string | null): boolean {
  return v === 'true' || v === '1'
}

export async function POST(req: Request) {
  // Auth: protect the mutation when a secret is configured (prod). Skipped locally.
  if (process.env.CRON_SECRET) {
    const auth = req.headers.get('authorization')
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  const url = new URL(req.url)
  // dryRun defaults TRUE — apply only when explicitly turned off (?dryRun=false) or
  // requested (?apply=true). override bypasses the over-merge safety cap.
  const dryRunParam = url.searchParams.get('dryRun')
  const apply = dryRunParam === 'false' || dryRunParam === '0' || truthy(url.searchParams.get('apply'))
  const override = truthy(url.searchParams.get('override'))

  const supabase = createServiceClient()
  const summary = await runIdentityResolutionPass(supabase, { apply, override })
  return NextResponse.json(summary)
}

export async function GET() {
  return NextResponse.json({
    usage:
      'POST /api/resolve-identities — DRY RUN by default (no writes). ' +
      'Add ?apply=true (or ?dryRun=false) to write borrower_id changes; ?override=true to bypass the safety cap.',
  })
}
