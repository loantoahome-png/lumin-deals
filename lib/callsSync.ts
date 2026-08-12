// ── The call sweep: GHL messages/export → `calls` ────────────────────────────
//
// Replaces the manual "download the Call report CSV and upload it" loop.
// Field-level ground truth and the ⚠️ CSV-vs-API duration divergence are
// documented at the top of lib/callsApi.ts — read that before changing this.
//
// FORWARD-ONLY BY DESIGN. Each account resumes from its own newest stored call
// and never revisits the CSV-imported period. Two reasons:
//   1. The API and the CSV disagree on duration>0 for ~27% of calls, so
//      re-importing history would silently rewrite what the connect rate means
//      for months of past data.
//   2. The API's second-truncated timestamp lands ±1s from the CSV's on ~16% of
//      rows, so those would slip past the (call_ts, contact_phone,
//      dialer_number_phone) unique index and DUPLICATE the call.
// API rows are idempotent against each other (same message → same truncated
// second → the index absorbs it), which is what makes re-runs and the overlap
// safe. Do not add a backfill mode without solving both problems above.

import type { SupabaseClient } from '@supabase/supabase-js'
import { getAccounts } from './ghl'
import { normPhone } from './dealMatcher'
import type { CallRow, AccountLabel } from './callsCsv'
import { fetchCallMessages, mapApiCall, callAccountLabel } from './callsApi'

/** Cold start (an account with nothing stored) pulls this far back, so a first
 *  run can't try to page GHL's entire history. */
const COLD_START_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000

/** PostgREST payload guard — the CSV importer chunks at this size too. */
const CHUNK = 500

/**
 * Don't ingest a call until it has had time to settle in GHL.
 *
 * ⚠️ Observed 2026-08-12: the export returned two just-finished calls with `from`
 * and `to` EMPTY, so they stored with no dialing number; a later fetch returned
 * the same calls complete, and — because the dedupe index couldn't match a null
 * dialer — they inserted a SECOND time. That double-counted Brianne and put a
 * phantom "Unknown" dialer on a page whose entire purpose is her call volume.
 * A short lag means the first read of a call is already the complete one.
 * Cheap: the sweep runs every 30 min, so nothing is ever missed by waiting 5.
 */
const SETTLE_MS = 5 * 60 * 1000

export type CallSyncAccountResult = {
  account: AccountLabel
  since: string
  fetched: number        // raw messages returned (all channels=Call types)
  dials: number          // after the TYPE_CALL filter — campaign voicemails dropped
  inserted: number       // rows the unique index actually accepted
  duplicates: number     // mapped rows already present (expected on overlap)
  truncated: boolean     // hit the page cap — window incomplete, said out loud
  /** Rows whose dialing number matched no known label. These land in the
   *  per-dialer view's 'Unknown' bucket, so a non-zero count is the signal that a
   *  NEW number started dialing and needs one labelled row to teach the map. */
  unlabelledDialers: number
  error?: string
}

export type CallSyncResult = {
  ok: boolean
  accounts: CallSyncAccountResult[]
  skipped: string[]      // configured GHL accounts with no `calls` vocabulary (Randy)
  dryRun: boolean
}

/** Newest stored call for an account, or null when it has none. */
async function watermark(supabase: SupabaseClient, account: AccountLabel): Promise<string | null> {
  const { data, error } = await supabase
    .from('calls').select('call_ts')
    .eq('account_label', account)
    .order('call_ts', { ascending: false })
    .limit(1)
  if (error) throw new Error(`watermark ${account}: ${error.message}`)
  return (data?.[0]?.call_ts as string | undefined) ?? null
}

/**
 * phone → contact name, from our own `deals`. The export carries a contactId but
 * no name, and a null name blanks the Activity tab for every new call.
 * Paged because a bare select caps at 1000 rows. Only called when there is
 * something to insert — an idle sweep must not scan the deal table.
 */
async function buildNameMap(supabase: SupabaseClient): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('deals').select('name, phone')
      .not('phone', 'is', null)
      .range(from, from + 999)
    if (error) throw new Error(`name map: ${error.message}`)
    for (const d of (data ?? []) as { name: string | null; phone: string | null }[]) {
      const p = normPhone(d.phone)
      if (p && d.name && !map.has(p)) map.set(p, d.name)
    }
    if (!data || data.length < 1000) break
  }
  return map
}

/**
 * dialing number → its human label ("Brianne's Number"), learned from the rows we
 * already hold.
 *
 * ⚠️ Not cosmetic. `effortRollup`/`dialerRollup` group on `dialer_number_name` and
 * default to 'Unknown', so an unlabelled row disappears from every per-dialer
 * question — including "how many calls did Brianne make in each account", which is
 * only answerable at all because she dials from a DIFFERENT number per sub-account
 * (…5677 in Moe's, …8630 in Matt's).
 *
 * Learned rather than hardcoded so a new number picks itself up from the first
 * labelled row. Most-frequent label wins per number: the same person can appear
 * under two spellings ("Efrain's Number" vs "Efrain") and the majority is the one
 * the existing charts already group under.
 */
async function buildDialerNameMap(supabase: SupabaseClient): Promise<Map<string, string>> {
  const counts = new Map<string, Map<string, number>>()
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('calls').select('dialer_number_phone, dialer_number_name')
      .not('dialer_number_name', 'is', null)
      .not('dialer_number_phone', 'is', null)
      .range(from, from + 999)
    if (error) throw new Error(`dialer map: ${error.message}`)
    for (const r of (data ?? []) as { dialer_number_phone: string; dialer_number_name: string }[]) {
      if (!counts.has(r.dialer_number_phone)) counts.set(r.dialer_number_phone, new Map())
      const m = counts.get(r.dialer_number_phone)!
      m.set(r.dialer_number_name, (m.get(r.dialer_number_name) ?? 0) + 1)
    }
    if (!data || data.length < 1000) break
  }
  const map = new Map<string, string>()
  for (const [phone, names] of counts) {
    const best = [...names.entries()].sort((a, b) => b[1] - a[1])[0]
    if (best) map.set(phone, best[0])
  }
  return map
}

/**
 * Sweep every configured account for calls newer than what we already hold.
 *
 * `dryRun` maps and counts but writes nothing — used by the manual route so a
 * cutover can be inspected before it lands.
 */
export async function runCallsSync(
  supabase: SupabaseClient,
  opts: { dryRun?: boolean; sinceOverride?: string } = {},
): Promise<CallSyncResult> {
  const dryRun = opts.dryRun ?? false
  const results: CallSyncAccountResult[] = []
  const skipped: string[] = []
  let nameMap: Map<string, string> | null = null
  let dialerMap: Map<string, string> | null = null

  for (const acct of getAccounts()) {
    const label = callAccountLabel(acct.label)
    if (!label) { skipped.push(acct.label); continue }   // Randy — excluded by decision

    const res: CallSyncAccountResult = {
      account: label, since: '', fetched: 0, dials: 0, inserted: 0, duplicates: 0,
      truncated: false, unlabelledDialers: 0,
    }
    try {
      const mark = opts.sinceOverride ?? await watermark(supabase, label)
      // +1s: the newest stored call's own second is already covered, and
      // re-examining it is what risks an off-by-one duplicate against a CSV row.
      const since = opts.sinceOverride
        ? opts.sinceOverride
        : mark
          ? new Date(new Date(mark).getTime() + 1000).toISOString()
          : new Date(Date.now() - COLD_START_LOOKBACK_MS).toISOString()
      res.since = since

      // Right edge held back so a call is only ever read once it has settled.
      const until = new Date(Date.now() - SETTLE_MS).toISOString()
      const { messages, truncated } = await fetchCallMessages(acct, { since, until })
      res.fetched = messages.length
      res.truncated = truncated

      const mapped: CallRow[] = []
      for (const m of messages) {
        const row = mapApiCall(m, label,
          p => nameMap?.get(p) ?? null,
          p => dialerMap?.get(p) ?? null)
        if (row) mapped.push(row)
      }
      res.dials = mapped.length

      // Both lookups are only worth a table scan once we know rows exist — an idle
      // sweep must not scan. Re-apply after building so the first batch isn't blank.
      if (mapped.length && !nameMap) {
        nameMap = await buildNameMap(supabase)
        dialerMap = await buildDialerNameMap(supabase)
        for (const r of mapped) {
          r.contact_name = nameMap.get(r.contact_phone) ?? null
          r.dialer_number_name = r.dialer_number_phone ? dialerMap.get(r.dialer_number_phone) ?? null : null
        }
      }
      res.unlabelledDialers = mapped.filter(r => !r.dialer_number_name).length

      if (!dryRun && mapped.length) {
        for (let i = 0; i < mapped.length; i += CHUNK) {
          const chunk = mapped.slice(i, i + CHUNK)
          const { data, error } = await supabase
            .from('calls')
            .upsert(chunk, { onConflict: 'call_ts,contact_phone,dialer_number_phone', ignoreDuplicates: true })
            .select('id')
          if (error) throw new Error(`upsert: ${error.message}`)
          res.inserted += data?.length ?? 0
        }
        res.duplicates = mapped.length - res.inserted
      }
    } catch (e) {
      res.error = e instanceof Error ? e.message : String(e)
    }
    results.push(res)
  }

  return { ok: results.every(r => !r.error), accounts: results, skipped, dryRun }
}
