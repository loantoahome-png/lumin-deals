// Arive import log — the per-field record of what a commit actually wrote.
//
// `deals` has no history, so before this the only trace of an import was the
// tile counts (and a change-log CSV nobody downloaded). See supabase-import-log.sql.
// Everything here is best-effort: a logging failure must never fail the import
// that already happened, so errors are reported to the console and swallowed.

import type { SupabaseClient } from '@supabase/supabase-js'

export type ImportChangeAction = 'fill' | 'overwrite' | 'create'

export type ImportChangeInput = {
  deal_id: string | null
  borrower: string | null
  arive_file_no: string | null
  field: string
  old_value: unknown
  new_value: unknown
  action: ImportChangeAction
}

export type ImportRunInput = {
  source: 'arive'
  filename: string | null
  mode: string
  protected_fields: string[]
  rows_total: number
  matched: number
  unmatched: number
  updated: number
  created: number
  fields_written: number
  error_count: number
  summary: unknown
}

export type ImportRunRow = ImportRunInput & {
  id: string
  created_at: string
  fill_count: number
  overwrite_count: number
  create_count: number
}

export type ImportChangeRow = {
  id: number
  run_id: string
  deal_id: string | null
  borrower: string | null
  arive_file_no: string | null
  field: string
  old_value: string | null
  new_value: string | null
  action: ImportChangeAction
}

/** Stringify a stored/written value for the log. null/undefined/'' → null (blank). */
export function valueText(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try { return JSON.stringify(v) } catch { return String(v) }
}

const CHUNK = 500

/** Persist one committed import: the run header + every field written. Returns the run id, or null if logging failed. */
export async function recordImportRun(
  supabase: SupabaseClient,
  run: ImportRunInput,
  changes: ImportChangeInput[],
): Promise<string | null> {
  try {
    const counts = { fill: 0, overwrite: 0, create: 0 }
    for (const c of changes) counts[c.action]++
    const { data, error } = await supabase
      .from('import_runs')
      .insert({
        ...run,
        fill_count: counts.fill,
        overwrite_count: counts.overwrite,
        create_count: counts.create,
      })
      .select('id')
      .single()
    if (error || !data?.id) {
      console.error('[import_log] run insert failed (non-fatal):', error?.message)
      return null
    }
    const runId = data.id as string
    for (let i = 0; i < changes.length; i += CHUNK) {
      const rows = changes.slice(i, i + CHUNK).map(c => ({
        run_id: runId,
        deal_id: c.deal_id,
        borrower: c.borrower,
        arive_file_no: c.arive_file_no,
        field: c.field,
        old_value: valueText(c.old_value),
        new_value: valueText(c.new_value),
        action: c.action,
      }))
      const { error: e } = await supabase.from('import_changes').insert(rows)
      if (e) console.error(`[import_log] change chunk ${i / CHUNK} failed (non-fatal):`, e.message)
    }
    return runId
  } catch (err) {
    console.error('[import_log] logging threw (non-fatal):', err)
    return null
  }
}
