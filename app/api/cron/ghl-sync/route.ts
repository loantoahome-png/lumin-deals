import { NextRequest, NextResponse, after } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { runGhlSync } from '@/app/api/sync/ghl/route'
import { refreshConversations } from '@/app/api/sync/conversations/route'
import { runSecondCallbackCheck } from '@/app/api/cron/second-callback/route'
import { runTriageTaskCheck } from '@/app/api/cron/triage-tasks/route'
import { runIdentityResolutionPass } from '@/lib/identityResolver'

// Scheduled GHL sync — pinged by an external cron (cron-job.org).
// Reuses the exact same logic as the manual "Sync GHL" button.
// The sync issues hundreds of sequential Supabase writes, so it needs headroom.
export const maxDuration = 300

// ── Overlap guard ─────────────────────────────────────────────────────────────
// A single run can take longer than the cron interval (especially at 1–2 min).
// Without a lock, the next ping would start a SECOND sync on top of the first —
// two runs racing the same writes, double the GHL API load, wasted compute.
// We store a lock in sync_state; a run older than LOCK_TTL_MS is treated as
// crashed/stale and overridden, so a failed run can never wedge the lock forever.
const LOCK_KEY = 'ghl_sync_lock'
const LOCK_TTL_MS = 5 * 60 * 1000   // 5 min — longer than any healthy run

// ── Sub-task throttling ──────────────────────────────────────────────────────
// The cron ping fires every few minutes, but conversations-refresh and the
// 2nd-callback check don't need to run that often. Gate them via sync_state
// so they run on their own cadence regardless of how fast the cron pings.
const CONV_REFRESH_KEY = 'conversations_refresh_last'
const CONV_REFRESH_INTERVAL_MS = 30 * 60 * 1000   // 30 min
const CALLBACK_CHECK_KEY = 'second_callback_last'
const CALLBACK_CHECK_INTERVAL_MS = 5 * 60 * 1000  //  5 min
const TRIAGE_CHECK_KEY = 'triage_tasks_last'
const TRIAGE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000  // 6h — day-granular windows; ~2 runs per business day
const MAINTENANCE_KEY = 'ghl_maintenance_last'
const MAINTENANCE_INTERVAL_MS = 3 * 60 * 60 * 1000    // 3 h — prune/reconcile pass (full-opp scan; Fluid CPU saver, widened 2026-06-17 from 60 min)
const IDENTITY_RESOLVE_KEY = 'identity_resolve_last'
const IDENTITY_RESOLVE_INTERVAL_MS = 3 * 60 * 60 * 1000   // 3 h — collapse split borrower_ids (full deal-table scan; Fluid CPU saver, widened 2026-06-17 from 30 min). Force anytime with ?full=1 or POST /api/resolve-identities

type LockClient = ReturnType<typeof createServiceClient>

/** True if `key` was last marked >= intervalMs ago (or has never run). */
async function isDue(supabase: LockClient, key: string, intervalMs: number): Promise<boolean> {
  try {
    const { data } = await supabase.from('sync_state').select('value').eq('key', key).maybeSingle()
    const lastAt = (data?.value as { last_at?: string } | null)?.last_at
    if (!lastAt) return true
    return Date.now() - Date.parse(lastAt) >= intervalMs
  } catch {
    return true   // fail OPEN — better to run an extra time than to silently stop
  }
}

async function markRan(supabase: LockClient, key: string): Promise<void> {
  try {
    await supabase.from('sync_state').upsert({
      key,
      value: { last_at: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    })
  } catch (e) {
    console.warn(`[Cron GHL Sync] markRan(${key}) failed:`, e)
  }
}

/** Try to acquire the lock. Returns true if acquired, false if a fresh run holds it. */
async function acquireLock(supabase: LockClient): Promise<boolean> {
  try {
    const { data } = await supabase.from('sync_state').select('value').eq('key', LOCK_KEY).maybeSingle()
    const lockedAt = (data?.value as { locked_at?: string } | null)?.locked_at
    if (lockedAt && Date.now() - Date.parse(lockedAt) < LOCK_TTL_MS) {
      return false   // a recent run is still in progress
    }
    await supabase.from('sync_state').upsert({
      key: LOCK_KEY,
      value: { locked_at: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    })
    return true
  } catch (e) {
    // If the lock table is unavailable, fail OPEN (run anyway) — better to
    // risk a rare overlap than to silently stop syncing entirely.
    console.warn('[Cron GHL Sync] lock acquire failed (running unguarded):', e)
    return true
  }
}

async function releaseLock(supabase: LockClient): Promise<void> {
  try {
    await supabase.from('sync_state').upsert({
      key: LOCK_KEY,
      value: { locked_at: null },
      updated_at: new Date().toISOString(),
    })
  } catch (e) {
    console.warn('[Cron GHL Sync] lock release failed (will auto-expire):', e)
  }
}

export async function GET(req: NextRequest) {
  // Vercel cron sends `Authorization: Bearer <CRON_SECRET>` automatically
  // when CRON_SECRET is set in the project's env vars.
  const authHeader = req.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startedAt = new Date().toISOString()
  // Optional ?full=1 — escape hatch to force a full sync from the cron URL too
  const url = new URL(req.url)
  const full = url.searchParams.get('full') === '1' || url.searchParams.get('full') === 'true'

  // ── Skip if a previous run is still in progress ──────────────────────────
  const supabase = createServiceClient()
  const gotLock = await acquireLock(supabase)
  if (!gotLock) {
    console.log('[Cron GHL Sync] Skipped — a previous sync is still running.')
    return NextResponse.json({ ok: true, skipped: 'in_progress', startedAt })
  }

  // ── Respond to the pinger IMMEDIATELY, run the sync in the background ──────────
  // cron-job.org (our free trigger) has a hard 30s request timeout, and the heavy
  // maintenance/identity passes can exceed that — so the pinger was marking healthy
  // runs as "failed (timeout)" and cutting them off mid-reconcile (that's why a
  // "Lost" status could linger). Decoupling the HTTP response from the work via
  // after() means the pinger always gets a sub-second 200 and the sync runs to
  // completion (up to maxDuration). SAME trigger + SAME work → no new cron, no added
  // Vercel usage (just the existing run finishing instead of being killed at 30s).
  after(async () => {
    try {
      // Prune/reconcile (all-deals scan) is CPU-heavy and doesn't need to run on
      // every ping — gate it to ~15 min. New-lead create/update still runs each ping.
      const maintenance = full || await isDue(supabase, MAINTENANCE_KEY, MAINTENANCE_INTERVAL_MS)
      const result = await runGhlSync({ full, maintenance })
      if (maintenance) await markRan(supabase, MAINTENANCE_KEY)
      console.log(
        `[Cron GHL Sync] ${startedAt} — ${full ? 'FULL' : 'incremental'}${maintenance ? ' +maint' : ''} — ` +
        `synced ${result.synced} (${result.created} new, ${result.updated} updated, ` +
        `${result.skipped} skipped, ${result.errors.length} errors, ${result.duration_ms}ms)`
      )

      // Identity resolver — recompute the canonical borrower_id across ALL deals so a
      // person's separate loans stop surfacing as duplicates. Non-fatal.
      if (full || await isDue(supabase, IDENTITY_RESOLVE_KEY, IDENTITY_RESOLVE_INTERVAL_MS)) {
        try {
          const idr = await runIdentityResolutionPass(supabase, { apply: true })
          await markRan(supabase, IDENTITY_RESOLVE_KEY)
          console.log(
            `[Cron GHL Sync] identity resolve: ` +
            (idr.aborted ? `ABORTED — ${idr.reason}` : `${idr.dealsRewritten} borrower_id(s) rewritten`)
          )
        } catch (e) {
          console.error('[Cron GHL Sync] identity resolve failed (non-fatal):', e)
        }
      }

      // Refresh "last communication" for hot stages — throttled to every 15 min. Non-fatal.
      if (full || await isDue(supabase, CONV_REFRESH_KEY, CONV_REFRESH_INTERVAL_MS)) {
        try {
          const conversations = await refreshConversations()
          await markRan(supabase, CONV_REFRESH_KEY)
          console.log(`[Cron GHL Sync] conversations refresh:`, JSON.stringify(conversations))
        } catch (e) {
          console.error('[Cron GHL Sync] conversations refresh failed (non-fatal):', e)
        }
      }

      // 45-minute 2nd-call-back rule — throttled to every 5 min. Non-fatal.
      if (full || await isDue(supabase, CALLBACK_CHECK_KEY, CALLBACK_CHECK_INTERVAL_MS)) {
        try {
          const secondCallback = await runSecondCallbackCheck()
          await markRan(supabase, CALLBACK_CHECK_KEY)
          console.log(`[Cron GHL Sync] 2nd-callback check:`, JSON.stringify(secondCallback))
        } catch (e) {
          console.error('[Cron GHL Sync] 2nd-callback check failed (non-fatal):', e)
        }
      }

      // Lead-triage auto-tasks (7-day decisions + check-ins due) — throttled to
      // every 6h. Non-fatal.
      if (full || await isDue(supabase, TRIAGE_CHECK_KEY, TRIAGE_CHECK_INTERVAL_MS)) {
        try {
          const triage = await runTriageTaskCheck()
          await markRan(supabase, TRIAGE_CHECK_KEY)
          console.log(`[Cron GHL Sync] triage-tasks check:`, JSON.stringify(triage))
        } catch (e) {
          console.error('[Cron GHL Sync] triage-tasks check failed (non-fatal):', e)
        }
      }
    } catch (err) {
      console.error('[Cron GHL Sync] background run failed:', err)
    } finally {
      // Always release so the next ping can run immediately (the TTL is just a
      // backstop for a hard crash that skips this finally).
      await releaseLock(supabase)
    }
  })

  // Sub-second 200 → cron-job.org never hits its 30s timeout.
  return NextResponse.json({ ok: true, startedAt, queued: true })
}
