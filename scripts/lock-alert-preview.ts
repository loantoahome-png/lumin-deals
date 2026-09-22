// Offline preview of what app/api/cron/lock-alerts WOULD email, using the cron's own
// rules. Run: npx tsx scripts/lock-alert-preview.ts
//
// Pure read — sends nothing, writes nothing. Exists because this alert was dead for
// months (it required the `locked` flag, which has no importer), so the blast radius
// needs to be checkable without triggering a send.
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { lockDaysLeft } from '../lib/lockStatus'
import { isClosedLoan } from '../lib/loanOutcome'
import { isAlertLo } from '../lib/alertRecipients'

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
const get = (n: string) => env.match(new RegExp(`^${n}=(.+)$`, 'm'))?.[1].trim() ?? ''
const sb = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

// Must mirror the route.
const ESCROW_STATUSES = ['Loan Setup', 'Disclosed', 'Submitted to UW', 'Approved w/ Conditions',
  'Re-Submittal', 'Clear to Close', 'Docs Out', 'Docs Signed']
const WINDOWS = [5, 3, 1, 0]
// Recipients: imported from lib/alertRecipients, the SAME table the cron uses — this
// preview must never be able to disagree with the job it previews.

async function main() {
  const { data, error } = await sb.from('deals')
    .select('id,name,locked,lock_expiration,status,pipeline_group,ghl_status,adverse,loan_officer,lock_alerts_sent')
    .in('status', ESCROW_STATUSES).not('lock_expiration', 'is', null)
  if (error) throw error
  const rows = (data ?? []) as Array<Record<string, unknown>>

  const closed = rows.filter(r => isClosedLoan(r as never))
  const live = rows.filter(r => !isClosedLoan(r as never))
  console.log(`Rows matching the cron query: ${rows.length}`)
  console.log(`  skipped — already dead (adverse / GHL lost): ${closed.length}`)
  console.log(`  live escrows scanned:                        ${live.length}`)
  console.log(`  of those, locked='Yes' (the DEAD flag the cron used to require): ${live.filter(r => String(r.locked ?? '').trim().toLowerCase() === 'yes').length}\n`)

  const dueAll = live.map(r => ({ r, d: lockDaysLeft(r.lock_expiration as string) }))
    .filter(x => x.d != null && WINDOWS.includes(x.d))
  const due      = dueAll.filter(x => isAlertLo(x.r.loan_officer as string))
  const dueOther = dueAll.filter(x => !isAlertLo(x.r.loan_officer as string))

  console.log(`WOULD EMAIL on the next run: ${due.length}`)
  for (const { r, d } of due) {
    const stamps = (r.lock_alerts_sent ?? {}) as Record<string, string>
    const dedup = stamps[`${d}_${r.lock_expiration}`] ? ' (already sent — deduped)' : ''
    console.log(`   ${String(r.name).padEnd(26)} ${String(d).padStart(2)}d  ${r.lock_expiration}  LO=${r.loan_officer}${dedup}`)
  }
  // Shown, not hidden: these loans ARE in a lock window and nobody is being told.
  // That is a deliberate choice (Moe/Matt only), not a gap to rediscover later.
  console.log(`\nIn a lock window but NOT emailed — LO not on the alert list: ${dueOther.length}`)
  for (const { r, d } of dueOther) {
    console.log(`   ${String(r.name).padEnd(26)} ${String(d).padStart(2)}d  ${r.lock_expiration}  LO=${r.loan_officer}`)
  }

  const upcoming = live.map(r => ({ r, d: lockDaysLeft(r.lock_expiration as string) }))
    .filter(x => x.d != null && (x.d as number) > 0 && (x.d as number) <= 14)
    .sort((a, b) => (a.d as number) - (b.d as number))
  console.log(`\nNext 14 days (each alerts when it hits ${WINDOWS.join('/')}):`)
  for (const { r, d } of upcoming) {
    const mark = isAlertLo(r.loan_officer as string) ? '   ' : ' · '   // ' · ' = no email, LO off the list
    console.log(`${mark}${String(d).padStart(2)}d  ${String(r.name).padEnd(26)} LO=${r.loan_officer}`)
  }

  const expired = live.map(r => ({ r, d: lockDaysLeft(r.lock_expiration as string) })).filter(x => (x.d ?? 0) < 0)
  if (expired.length) {
    console.log(`\n⚠️ ${expired.length} live escrow(s) already EXPIRED. WINDOWS stops at 0, so these never alert —`)
    console.log(`   they were never alerted while the cron was dead either. They show on /reports/escrows.`)
    for (const { r, d } of expired) console.log(`   ${String(d).padStart(4)}d  ${String(r.name).padEnd(26)} LO=${r.loan_officer}`)
  }
}
main()
