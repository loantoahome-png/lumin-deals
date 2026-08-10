import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { parseCallsCsv, dedupeRows, dedupeKey, type AccountLabel, type CallRow } from '@/lib/callsCsv'
import { normPhone } from '@/lib/dealMatcher'

// Imports run a few thousand rows through chunked upserts.
export const maxDuration = 300

type FileInput = { name?: string; csv: string; account: AccountLabel }
type ImportRequest = { files: FileInput[]; mode: 'preview' | 'apply' }

/**
 * GHL Call Report CSV importer.
 *
 *   POST /api/import/calls
 *     body: { files: [{ name, csv, account: 'moe' | 'matt' }], mode: 'preview' | 'apply' }
 *
 * 'preview' writes nothing — it reports what WOULD land, including how many rows
 * are already present (so a re-import visibly shows 0 new).
 * 'apply' upserts on the (call_ts, contact_phone, dialer_number_phone) unique
 * index with ignoreDuplicates, making re-imports idempotent.
 *
 * `account` cannot be derived from the file: "Brianne's Number" places calls in
 * BOTH sub-account exports, so the dialing number identifies neither the account
 * nor the lead owner. The user tags each file at upload.
 */
export async function POST(req: NextRequest) {
  let body: ImportRequest
  try {
    body = await req.json() as ImportRequest
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 })
  }

  const mode = body.mode ?? 'preview'
  if (!['preview', 'apply'].includes(mode)) {
    return NextResponse.json({ ok: false, error: 'invalid_mode' }, { status: 400 })
  }
  if (!Array.isArray(body.files) || body.files.length === 0) {
    return NextResponse.json({ ok: false, error: 'missing_files' }, { status: 400 })
  }
  for (const f of body.files) {
    if (!f?.csv) return NextResponse.json({ ok: false, error: 'missing_csv' }, { status: 400 })
    if (f.account !== 'moe' && f.account !== 'matt') {
      return NextResponse.json({ ok: false, error: 'invalid_account_tag' }, { status: 400 })
    }
  }

  // 1. Parse every file
  const perFile: Array<{ name: string; account: AccountLabel; rows: number }> = []
  let all: CallRow[] = []
  for (const f of body.files) {
    let rows: CallRow[]
    try {
      rows = parseCallsCsv(f.csv, f.account, f.name ?? null)
    } catch (e) {
      return NextResponse.json({ ok: false, error: `parse_failed:${String(e)}` }, { status: 400 })
    }
    perFile.push({ name: f.name ?? '(unnamed)', account: f.account, rows: rows.length })
    all = all.concat(rows)
  }
  if (all.length === 0) {
    return NextResponse.json({ ok: false, error: 'no_parseable_rows' }, { status: 400 })
  }

  // Collapse in-payload duplicates the same way the unique index will, so the
  // preview count matches what actually lands.
  const { rows: rowsToWrite, collapsed } = dedupeRows(all)

  const supabase = createServiceClient()

  // 2. Which of these are already stored? Bounded by the payload's own date range.
  let minTs = rowsToWrite[0].call_ts, maxTs = rowsToWrite[0].call_ts
  for (const r of rowsToWrite) {
    if (r.call_ts < minTs) minTs = r.call_ts
    if (r.call_ts > maxTs) maxTs = r.call_ts
  }
  const existing = new Set<string>()
  {
    const PAGE = 1000
    let offset = 0
    for (;;) {
      const { data, error } = await supabase
        .from('calls')
        .select('call_ts, contact_phone, dialer_number_phone')
        .gte('call_ts', minTs)
        .lte('call_ts', maxTs)
        .order('call_ts', { ascending: true })
        .range(offset, offset + PAGE - 1)
      if (error) {
        return NextResponse.json({ ok: false, error: `supabase_existing:${error.message}` }, { status: 500 })
      }
      const page = data ?? []
      for (const r of page) {
        existing.add(dedupeKey({
          call_ts: new Date(r.call_ts as string).toISOString(),
          contact_phone: r.contact_phone as string,
          dialer_number_phone: r.dialer_number_phone as string | null,
        }))
      }
      if (page.length < PAGE) break
      offset += PAGE
    }
  }
  const fresh = rowsToWrite.filter(r => !existing.has(dedupeKey(r)))

  // 3. How many join to a deal? (reporting only — unmatched rows are still stored)
  const phones = new Set<string>()
  {
    const PAGE = 1000
    let offset = 0
    for (;;) {
      const { data, error } = await supabase
        .from('deals')
        .select('phone')
        .order('id', { ascending: true })
        .range(offset, offset + PAGE - 1)
      if (error) {
        return NextResponse.json({ ok: false, error: `supabase_deals:${error.message}` }, { status: 500 })
      }
      const page = data ?? []
      for (const d of page) {
        const p = normPhone(d.phone as string | null)
        if (p) phones.add(p)
      }
      if (page.length < PAGE) break
      offset += PAGE
    }
  }
  const matched = rowsToWrite.filter(r => phones.has(r.contact_phone)).length

  const summary = {
    files: perFile,
    parsed: all.length,
    duplicates_in_payload: collapsed,
    already_stored: rowsToWrite.length - fresh.length,
    new_rows: fresh.length,
    matched_to_deal: matched,
    unmatched: rowsToWrite.length - matched,
    range: { start: minTs, end: maxTs },
  }

  if (mode === 'preview') {
    return NextResponse.json({ ok: true, mode, summary })
  }

  // 4. Apply — chunked upsert, idempotent on the unique index
  let inserted = 0
  const errors: string[] = []
  const CHUNK = 500
  for (let i = 0; i < rowsToWrite.length; i += CHUNK) {
    const chunk = rowsToWrite.slice(i, i + CHUNK)
    const { error } = await supabase
      .from('calls')
      .upsert(chunk, { onConflict: 'call_ts,contact_phone,dialer_number_phone', ignoreDuplicates: true })
    if (error) errors.push(`chunk_${i}:${error.message}`)
    else inserted += chunk.length
  }

  return NextResponse.json({ ok: errors.length === 0, mode, summary, rows_sent: inserted, errors })
}

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    message: "POST { files: [{ name, csv, account: 'moe'|'matt' }], mode: 'preview'|'apply' }",
  })
}
