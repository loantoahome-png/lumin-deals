import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import {
  parseRowsFromCsv, rowToPatch, buildMatchIndex, matchRow, buildPlan, summarizePlan,
  pipelineGroupForStatus,
  type RowPlan,
} from '@/lib/ariveCsv'
import { linkCoborrowerFromImport } from '@/lib/dealContacts'

// CSV imports can touch hundreds of rows + run sequential Supabase writes —
// give the function room (Pro plans honor up to 300s).
export const maxDuration = 300

type ImportRequest = {
  csv: string
  mode: 'preview' | 'fill_blanks' | 'overwrite'
  createUnmatched?: boolean   // create brand-new deals for true no-match rows
  protectedFields?: string[]  // fields the user shielded from overwrite (surgical override)
}

/**
 * Arive CSV importer.
 *
 *   POST /api/import/arive
 *     body: { csv: "raw csv text", mode: 'preview' | 'fill_blanks' | 'overwrite' }
 *
 * 'preview' returns a per-row plan with no writes.
 * 'fill_blanks' (default safe mode) writes only to fields currently empty.
 * 'overwrite' replaces any field Arive has a value for.
 */
export async function POST(req: NextRequest) {
  let body: ImportRequest
  try {
    body = await req.json() as ImportRequest
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 })
  }

  if (!body.csv) return NextResponse.json({ ok: false, error: 'missing_csv' }, { status: 400 })
  const mode = body.mode ?? 'preview'
  if (!['preview','fill_blanks','overwrite'].includes(mode)) {
    return NextResponse.json({ ok: false, error: 'invalid_mode' }, { status: 400 })
  }

  // 1. Parse + normalize CSV rows
  const rawRows = parseRowsFromCsv(body.csv)
  if (rawRows.length === 0) {
    return NextResponse.json({ ok: false, error: 'empty_csv' }, { status: 400 })
  }
  const patches = rawRows.map(rowToPatch)

  // 2. Load all dashboard deals (paginated — Supabase caps single .select() at 1000)
  const supabase = createServiceClient()
  type DealLite = {
    id: string; name: string | null; email: string | null; phone: string | null;
    arive_file_no: string | null
  }
  const allDeals: DealLite[] = []
  const PAGE = 1000
  let offset = 0
  for (;;) {
    const { data, error } = await supabase
      .from('deals')
      .select('id, name, email, phone, arive_file_no')
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1)
    if (error) {
      return NextResponse.json({ ok: false, error: `supabase_list:${error.message}` }, { status: 500 })
    }
    const rows = (data ?? []) as DealLite[]
    allDeals.push(...rows)
    if (rows.length < PAGE) break
    offset += PAGE
  }

  // 3. Build match index
  const ix = buildMatchIndex(allDeals)

  // 4. Run the REAL matcher once per row to find which deals we need full
  //    records for (so we can tell blank-vs-filled). Using matchRow directly
  //    keeps this in lockstep with buildPlan — no duplicated match logic.
  const dealsMap = new Map<string, Record<string, unknown>>()
  const idsToFetch: string[] = []
  for (const patch of patches) {
    const m = matchRow(patch, ix)
    if (m.matched && !idsToFetch.includes(m.dealId)) idsToFetch.push(m.dealId)
  }
  if (idsToFetch.length > 0) {
    const FETCH_BATCH = 100
    for (let i = 0; i < idsToFetch.length; i += FETCH_BATCH) {
      const batch = idsToFetch.slice(i, i + FETCH_BATCH)
      const { data, error } = await supabase.from('deals').select('*').in('id', batch)
      if (error) return NextResponse.json({ ok: false, error: `supabase_fetch:${error.message}` }, { status: 500 })
      for (const d of (data ?? []) as Array<Record<string, unknown>>) {
        dealsMap.set(d.id as string, d)
      }
    }
  }

  // 5. Build per-row plan.
  // PREVIEW builds the RICHEST plan ('overwrite') so the client gets every
  // field's true action (fill vs overwrite) and can render + count per the
  // user's selected display mode WITHOUT re-fetching. Preview writes nothing
  // (it returns below, before the commit loop). Only a fill_blanks COMMIT
  // restricts writes to currently-blank fields.
  const planMode = mode === 'fill_blanks' ? 'fill_blanks' : 'overwrite'
  const plans = buildPlan({ rows: patches, deals: dealsMap, ix, mode: planMode, createUnmatched: body.createUnmatched })
  const summary = summarizePlan(plans)

  // 6. Preview-only: just return the plan
  if (mode === 'preview') {
    return NextResponse.json({ ok: true, mode, summary, plans })
  }

  // 7. Commit: apply each row's changes
  let updated = 0
  let created = 0
  let fieldsWritten = 0
  let coborrowersLinked = 0
  const errors: Array<{ rowIndex: number; borrower: string; error: string }> = []

  // Link a row's co-borrower (find-or-create the contact) without failing the row
  // if it errors (e.g. deal_contacts migration not yet run).
  const applyCoborrower = async (dealId: string, plan: RowPlan) => {
    if (!plan.coborrower) return
    try {
      const res = await linkCoborrowerFromImport(supabase, dealId, plan.coborrower)
      if (res === 'linked') coborrowersLinked++
    } catch (e) {
      errors.push({ rowIndex: plan.rowIndex, borrower: plan.borrower, error: `coborrower_link: ${String(e)}` })
    }
  }

  // Per-field overwrite shields (surgical override). Only affects the update
  // path below — a protected field's existing value is never REPLACED (a
  // blank-fill is still allowed; there's nothing to protect on an empty field).
  const protectedSet = new Set(body.protectedFields ?? [])

  for (const plan of plans) {
    // ── Brand-new deal (no existing match) → INSERT ─────────────────────────
    if (plan.action === 'create_new' && plan.newLoanData) {
      const insertData = { ...plan.newLoanData, borrower_id: crypto.randomUUID() }
      const { data: ins, error } = await supabase.from('deals').insert(insertData).select('id').single()
      if (error) {
        errors.push({ rowIndex: plan.rowIndex, borrower: plan.borrower, error: error.message })
      } else {
        created++
        fieldsWritten += Object.keys(insertData).length
        if (ins?.id) await applyCoborrower(ins.id as string, plan)
      }
      continue
    }

    if (!plan.matched) continue

    // ── New loan for an existing borrower → INSERT a new deal card ──────────
    if (plan.action === 'create_loan' && plan.newLoanData) {
      // If the matched person had no borrower_id yet, mint one and stamp it on
      // BOTH the existing deal and the new loan so they're linked.
      let borrowerId = plan.borrowerId
      if (!borrowerId && plan.dealId) {
        borrowerId = crypto.randomUUID()
        await supabase.from('deals').update({ borrower_id: borrowerId }).eq('id', plan.dealId)
      }
      const insertData = { ...plan.newLoanData, borrower_id: borrowerId ?? crypto.randomUUID() }
      const { data: ins, error } = await supabase.from('deals').insert(insertData).select('id').single()
      if (error) {
        errors.push({ rowIndex: plan.rowIndex, borrower: plan.borrower, error: error.message })
      } else {
        created++
        fieldsWritten += Object.keys(insertData).length
        if (ins?.id) await applyCoborrower(ins.id as string, plan)
      }
      continue
    }

    // ── Update existing loan ────────────────────────────────────────────────
    if (!plan.dealId) continue
    const patch: Record<string, unknown> = {}
    for (const c of plan.changes) {
      if (c.action === 'fill' || c.action === 'overwrite') {
        if (c.action === 'overwrite' && protectedSet.has(c.field)) continue   // shielded field
        patch[c.field] = c.next
      }
    }
    if (Object.keys(patch).length === 0) {
      // No field changes, but a co-borrower may still need linking.
      await applyCoborrower(plan.dealId, plan)
      continue
    }
    // When the import changes `status`, keep `pipeline_group` in lockstep — the
    // Escrows/Funded/Not-Ready tabs filter by pipeline_group, so writing status
    // alone (e.g. Disclosed → Non-Responsive when a loan is adversed in Arive)
    // would leave the deal stranded in its old tab.
    if (typeof patch.status === 'string') {
      patch.pipeline_group = pipelineGroupForStatus(patch.status)
    }
    const { error } = await supabase.from('deals').update(patch).eq('id', plan.dealId)
    if (error) {
      errors.push({ rowIndex: plan.rowIndex, borrower: plan.borrower, error: error.message })
    } else {
      updated++
      fieldsWritten += Object.keys(patch).length
      await applyCoborrower(plan.dealId, plan)
    }
  }

  return NextResponse.json({
    ok: true,
    mode,
    summary,
    updated,
    created,
    fields_written: fieldsWritten,
    coborrowers_linked: coborrowersLinked,
    errors,
    plans,           // include the per-row plan in the response for the UI to render
  })
}

// Convenience GET for sanity-check
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    message: 'POST a JSON body { csv, mode } where mode is preview | fill_blanks | overwrite',
  })
}

// Re-export the type for client TypeScript narrowing
export type { RowPlan }
