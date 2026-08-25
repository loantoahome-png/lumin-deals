// Repair stored calls that have no dialing number. Two distinct causes, two
// different repairs — both verified live 2026-08-25.
//
// A · NAME-IN-THE-NUMBER-FIELD. GHL rejects an invalid destination before
//   assigning an outbound line, and puts the dialing user's DISPLAY NAME in
//   `from` (status 'failed', error 'VOICE_CALL_INVALID_PHONE_NUMBER'). GHL still
//   reports the row that way today, so there is no number to recover — only the
//   name. ⚠️ `dialer_number_phone` stays '' for these: it is one third of
//   calls_dedupe_uniq, and inventing a number would re-key a stored row.
//
// B · SETTLE-WINDOW GHOST. The row was read before GHL had populated `from`/`to`
//   (the 2026-08-12 incident; SETTLE_MS reduced but has NOT eliminated it — two
//   of these are from 08-19). GHL now returns the call complete, so the real
//   number and its label are both recoverable. Re-keying is safe because the
//   sweep is forward-only and will never re-read these seconds, but every write
//   is still guarded against a row already holding the target key — landing on
//   one would be the 2026-08-12 double-count in reverse.
//
// Run: npx tsx scripts/blank-dialer-backfill.ts [--dry]
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

const env = readFileSync(`${process.cwd()}/.env.local`, 'utf8')
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}

const DAY = 24 * 60 * 60 * 1000
/** ⚠️ Epoch, not the ISO text: Postgres renders call_ts as '…+00:00' while the
 *  mapper produces '…000Z'. Keying on the string matches nothing. */
const tsKey = (ts: string) => String(new Date(ts).getTime())

type Repair = { kind: 'name' | 'restore'; name: string; phone?: string }

async function main() {
  const dry = process.argv.includes('--dry')
  const { getAccounts } = await import('../lib/ghl')
  const { fetchCallMessages, mapApiCall, callAccountLabel, fetchNumberLabels } = await import('../lib/callsApi')
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } })

  // The label each number already dials under, so a restored row joins the
  // bucket its siblings are in instead of starting a new spelling.
  const learned = new Map<string, string>()
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('calls')
      .select('dialer_number_phone, dialer_number_name')
      .not('dialer_number_name', 'is', null).neq('dialer_number_phone', '')
      .range(from, from + 999)
    if (error) throw new Error(error.message)
    for (const r of data as { dialer_number_phone: string; dialer_number_name: string }[]) {
      if (!learned.has(r.dialer_number_phone)) learned.set(r.dialer_number_phone, r.dialer_number_name)
    }
    if (!data || data.length < 1000) break
  }

  const { data, error } = await sb.from('calls')
    .select('id, call_ts, contact_phone, account_label')
    .eq('dialer_number_phone', '').is('dialer_number_name', null)
    .order('call_ts')
  if (error) throw new Error(error.message)
  const targets = data as { id: string; call_ts: string; contact_phone: string; account_label: string }[]
  console.log(`${targets.length} stored rows with no dialing number and no name`)
  if (!targets.length) return

  const found = new Map<string, Repair>()
  for (const acct of getAccounts()) {
    const label = callAccountLabel(acct.label)
    if (!label) continue
    const mine = targets.filter(t => t.account_label === label)
    if (!mine.length) continue
    const ghlTitles = await fetchNumberLabels(acct)
    // A day at a time: a multi-week window 500s on GHL's side.
    for (const day of [...new Set(mine.map(t => t.call_ts.slice(0, 10)))].sort()) {
      const since = new Date(`${day}T00:00:00.000Z`)
      let messages
      try {
        ({ messages } = await fetchCallMessages(acct, {
          since: since.toISOString(), until: new Date(since.getTime() + DAY).toISOString(),
        }))
      } catch (e) {
        console.log(`  ${label} ${day}: FETCH FAILED — ${e instanceof Error ? e.message : String(e)}`)
        continue
      }
      for (const m of messages) {
        const row = mapApiCall(m, label, undefined,
          (p, hint) => (p ? ghlTitles.get(p) ?? learned.get(p) ?? null : hint ?? null))
        if (!row || !row.dialer_number_name) continue
        found.set(`${label}|${tsKey(row.call_ts)}|${row.contact_phone}`, row.dialer_number_phone
          ? { kind: 'restore', name: row.dialer_number_name, phone: row.dialer_number_phone }
          : { kind: 'name', name: row.dialer_number_name })
      }
      console.log(`  ${label} ${day}: ${messages.length} messages scanned`)
    }
  }

  let named = 0, restored = 0, skipped = 0
  const unmatched: string[] = []
  for (const t of targets) {
    const hit = found.get(`${t.account_label}|${tsKey(t.call_ts)}|${t.contact_phone}`)
    if (!hit) { unmatched.push(`${t.account_label} ${t.call_ts} → ${t.contact_phone}`); continue }

    if (hit.kind === 'name') {
      if (dry) { console.log(`DRY name    id=${t.id} ${t.call_ts} → "${hit.name}"`); named++; continue }
      const { error: e } = await sb.from('calls').update({ dialer_number_name: hit.name }).eq('id', t.id)
      if (e) throw new Error(`update ${t.id}: ${e.message}`)
      named++
    } else {
      const { data: clash } = await sb.from('calls').select('id')
        .eq('call_ts', t.call_ts).eq('contact_phone', t.contact_phone)
        .eq('dialer_number_phone', hit.phone!).neq('id', t.id)
      if (clash && clash.length) {
        console.log(`SKIP        id=${t.id} ${t.call_ts} — key already held by ${clash[0].id}`)
        skipped++
        continue
      }
      if (dry) { console.log(`DRY restore id=${t.id} ${t.call_ts} → ${hit.phone} "${hit.name}"`); restored++; continue }
      const { error: e } = await sb.from('calls')
        .update({ dialer_number_phone: hit.phone, dialer_number_name: hit.name }).eq('id', t.id)
      if (e) throw new Error(`update ${t.id}: ${e.message}`)
      restored++
    }
  }
  console.log(`\nnamed ${named} · number restored ${restored} · skipped ${skipped} · unmatched ${unmatched.length}`
    + (dry ? '   (dry run, nothing written)' : ''))
  for (const u of unmatched) console.log(`   unmatched: ${u}`)
}
main()
