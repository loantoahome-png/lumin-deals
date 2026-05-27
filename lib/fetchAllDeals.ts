import { supabase } from './supabase'
import type { Deal } from './types'

// PostgREST caps a single .select() at 1000 rows. Any page that loads the full
// deal set for analysis/display must paginate or it silently truncates.
// This helper walks pages until exhausted. Use it instead of a bare
// supabase.from('deals').select('*').
//
// `refine` lets callers add filters/ordering (.eq, .not, .order, etc.) — but
// NOT .range, since this helper owns pagination.

// Loose type for the query builder — Supabase's generics are painful to thread
// through here, and this is an internal helper.
/* eslint-disable @typescript-eslint/no-explicit-any */
type DealQuery = any

export async function fetchAllDeals(
  refine?: (q: DealQuery) => DealQuery,
  columns: string = '*',
): Promise<Deal[]> {
  const all: Deal[] = []
  const PAGE = 1000
  let offset = 0
  for (;;) {
    let q: DealQuery = supabase.from('deals').select(columns)
    if (refine) q = refine(q)
    const { data, error } = await q.range(offset, offset + PAGE - 1)
    if (error) {
      console.error('[fetchAllDeals] page failed:', error.message)
      break
    }
    const rows = (data as Deal[]) ?? []
    all.push(...rows)
    if (rows.length < PAGE) break
    offset += PAGE
  }
  return all
}
